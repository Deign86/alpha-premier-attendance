use crate::state::AppState;
use chrono::Utc;
use sqlx::Row;
use std::time::Duration;

#[derive(Debug, serde::Deserialize)]
struct ServiceAccount { client_email: String, private_key: String, token_uri: Option<String> }

#[derive(Debug, serde::Serialize)]
struct JwtClaims<'a> { iss: &'a str, scope: &'a str, aud: &'a str, iat: i64, exp: i64 }

async fn google_access_token(path: &str) -> Result<String, String> {
    let raw = tokio::fs::read_to_string(path).await.map_err(|e| format!("service account read failed: {e}"))?;
    let account: ServiceAccount = serde_json::from_str(&raw).map_err(|e| format!("service account JSON invalid: {e}"))?;
    let now = chrono::Utc::now().timestamp();
    let claims = JwtClaims { iss: &account.client_email, scope: "https://www.googleapis.com/auth/spreadsheets", aud: account.token_uri.as_deref().unwrap_or("https://oauth2.googleapis.com/token"), iat: now, exp: now + 3600 };
    let header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256);
    let key = jsonwebtoken::EncodingKey::from_rsa_pem(account.private_key.as_bytes()).map_err(|e| format!("service account key invalid: {e}"))?;
    let assertion = jsonwebtoken::encode(&header, &claims, &key).map_err(|e| format!("JWT signing failed: {e}"))?;
    let response: serde_json::Value = reqwest::Client::new().post(claims.aud).form(&[("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"), ("assertion", assertion.as_str())]).send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
    response.get("access_token").and_then(|v| v.as_str()).map(str::to_owned).ok_or_else(|| "Google token response did not contain access_token".into())
}

async fn google_append_row(path: &str, spreadsheet_id: &str, table_name: &str, payload: &serde_json::Value) -> Result<(), String> {
    let token = google_access_token(path).await?;
    let row = serde_json::json!({"values":[[payload.get("attendanceId").and_then(|v|v.as_str()).unwrap_or_default(), payload.get("attendanceDate").and_then(|v|v.as_str()).unwrap_or_default(), payload.get("userId").and_then(|v|v.as_str()).unwrap_or_default(), payload.get("action").and_then(|v|v.as_str()).unwrap_or_default(), payload.get("timeIn").cloned().unwrap_or(serde_json::Value::Null), payload.get("timeOut").cloned().unwrap_or(serde_json::Value::Null)]]});
    let client = reqwest::Client::new();
    let read_range = format!("{}!A:Z", table_name);
    let existing: serde_json::Value = client.get(format!("https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{}", urlencoding::encode(&read_range))).bearer_auth(&token).send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
    let row_id = payload.get("attendanceId").and_then(|v| v.as_str()).unwrap_or_default();
    let row_number = existing.get("values").and_then(|v| v.as_array()).and_then(|rows| rows.iter().enumerate().skip(1).find_map(|(index, value)| value.as_array().and_then(|cells| cells.first()).and_then(|cell| cell.as_str()).filter(|cell| *cell == row_id).map(|_| index + 1)));
    if let Some(row_number) = row_number {
        let range = format!("{}!A{}:F{}", table_name, row_number, row_number);
        client.put(format!("https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{}?valueInputOption=RAW", urlencoding::encode(&range))).bearer_auth(token).json(&row).send().await.map_err(|e| e.to_string())?.error_for_status().map(|_| ()).map_err(|e| e.to_string())
    } else {
        let range = format!("{}!A1", table_name);
        client.post(format!("https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS", urlencoding::encode(&range))).bearer_auth(token).json(&row).send().await.map_err(|e| e.to_string())?.error_for_status().map(|_| ()).map_err(|e| e.to_string())
    }
}

/// Bounded SQLite-first queue worker. The configured exporter endpoint is intentionally
/// optional; when absent rows remain pending instead of being discarded.
pub async fn run_once(state: &AppState, endpoint: Option<&str>) -> Result<u64, String> {
    if endpoint.is_none() && (state.lan.google_service_account_json_path.is_none() || state.lan.google_spreadsheet_id.is_none()) { return Ok(0); }
    let now = Utc::now().to_rfc3339();
    let rows = sqlx::query("SELECT id, table_name, row_id, operation, payload_json, attempts FROM sync_queue WHERE status IN ('PENDING','RETRY') AND next_attempt_at <= ? ORDER BY id LIMIT 50")
        .bind(&now).fetch_all(&state.db).await.map_err(|e| e.to_string())?;
    let mut completed = 0;
    for row in rows {
        let id: i64 = row.get("id");
        let attempts: i64 = row.get("attempts");
        let payload: serde_json::Value = serde_json::from_str(&row.get::<String,_>("payload_json")).unwrap_or_default();
        let success = if let Some(url) = endpoint {
            reqwest::Client::new().post(url).json(&serde_json::json!({"table":row.get::<String,_>("table_name"),"rowId":row.get::<String,_>("row_id"),"operation":row.get::<String,_>("operation"),"payload":payload})).send().await.map(|response| response.status().is_success()).unwrap_or(false)
        } else if let (Some(path), Some(spreadsheet)) = (state.lan.google_service_account_json_path.as_deref(), state.lan.google_spreadsheet_id.as_deref()) {
            google_append_row(path, spreadsheet, &row.get::<String,_>("table_name"), &payload).await.is_ok()
        } else { false };
        if success {
            sqlx::query("UPDATE sync_queue SET status='SYNCED', updated_at=? WHERE id=?").bind(&now).bind(id).execute(&state.db).await.map_err(|e| e.to_string())?;
            completed += 1;
        } else {
            let next = Utc::now() + Duration::from_secs(2_u64.saturating_pow((attempts as u32).min(5)));
            let status = if attempts + 1 >= 5 { "DEAD" } else { "RETRY" };
            sqlx::query("UPDATE sync_queue SET attempts=attempts+1, status=?, last_error=?, next_attempt_at=?, updated_at=? WHERE id=?").bind(status).bind("sync attempt failed").bind(next.to_rfc3339()).bind(&now).bind(id).execute(&state.db).await.map_err(|e| e.to_string())?;
        }
    }
    Ok(completed)
}
