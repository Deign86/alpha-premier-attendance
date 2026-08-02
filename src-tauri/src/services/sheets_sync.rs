use crate::state::AppState;
use chrono::{DateTime, Utc};
use sqlx::Row;
use std::time::Duration;

#[derive(Debug, serde::Deserialize)]
struct ServiceAccount {
    client_email: String,
    private_key: String,
    token_uri: Option<String>,
}

#[derive(Debug, serde::Serialize)]
struct JwtClaims<'a> {
    iss: &'a str,
    scope: &'a str,
    aud: &'a str,
    iat: i64,
    exp: i64,
}

pub const SHEETS_SCHEMA_VERSION: i64 = 2;
const SHEETS_SCHEMA_MISMATCH_ERROR: &str = "Google Sheets schema mismatch";
const SHEETS_ROW_ID_MISSING_ERROR: &str = "Google Sheets row identity is missing";
const SHEETS_ROW_ID_AMBIGUOUS_ERROR: &str = "Google Sheets row identity is ambiguous";
const SHEETS_INVALID_PAYLOAD_ERROR: &str = "Google Sheets sync payload is invalid";
const SHEETS_REQUEST_FAILED_ERROR: &str = "Google Sheets sync failed";
const PROCESSING_LEASE_TIMEOUT_MINUTES: i64 = 5;
const SYNC_BATCH_SIZE: i64 = 50;

pub fn sheet_headers(table_name: &str) -> &'static [&'static str] {
    match table_name {
        "Users" => &[
            "userId",
            "rfidUid",
            "fullName",
            "department",
            "status",
            "employeeType",
            "dailyRatePHP",
            "payrollProfileId",
            "revision",
            "updatedAt",
        ],
        "Attendance" => &[
            "attendanceId",
            "attendanceDate",
            "userId",
            "rfidUid",
            "fullName",
            "department",
            "timeIn",
            "timeOut",
            "status",
            "source",
            "notes",
            "revision",
            "updatedAt",
        ],
        "AuditLogs" => &[
            "logId",
            "timestamp",
            "eventType",
            "rfidUid",
            "userId",
            "message",
            "requestId",
        ],
        "InternGrace" => &["graceId", "userId", "weekStart", "attendanceId", "usedAt"],
        "Payroll" => &[
            "payrollId",
            "attendanceId",
            "userId",
            "fullName",
            "employeeType",
            "attendanceDate",
            "actualTimeIn",
            "actualTimeOut",
            "computedTimeIn",
            "computedTimeOut",
            "graceUsed",
            "lateHours",
            "lateDeductionPHP",
            "basePayPHP",
            "dailyPayPHP",
            "notes",
            "revision",
            "updatedAt",
        ],
        "PayrollProfiles" => &[
            "profileId",
            "label",
            "payrollFrequency",
            "standardWorkingDaysPerCutoff",
            "incentivesAllowancePHP",
            "specialAllowancePHP",
            "revision",
            "updatedAt",
        ],
        "PayrollCutoffs" => &[
            "payrollId",
            "employeeId",
            "employeeName",
            "payrollProfileId",
            "payrollCutoffLabel",
            "cutoffStart",
            "cutoffEnd",
            "basicPayPHP",
            "allowancesPHP",
            "incentivesPHP",
            "lateDeductionsPHP",
            "manualAdjustmentPHP",
            "grossPayPHP",
            "netPayPHP",
            "status",
            "revision",
            "finalizedAt",
            "updatedAt",
        ],
        _ => &["rowId", "operation", "payloadJson"],
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HeaderDecision {
    Initialize,
    Match,
}

fn sheet_row_is_empty(row: &serde_json::Value) -> bool {
    row.as_array().is_some_and(|cells| {
        cells
            .iter()
            .all(|cell| cell.is_null() || cell.as_str() == Some(""))
    })
}

fn header_decision(
    existing: &serde_json::Value,
    expected: &[&str],
) -> Result<HeaderDecision, &'static str> {
    let Some(values) = existing.get("values") else {
        return Ok(HeaderDecision::Initialize);
    };
    let Some(rows) = values.as_array() else {
        return Err(SHEETS_SCHEMA_MISMATCH_ERROR);
    };
    let Some(header) = rows.first() else {
        return Ok(HeaderDecision::Initialize);
    };
    let Some(cells) = header.as_array() else {
        return Err(SHEETS_SCHEMA_MISMATCH_ERROR);
    };

    if cells
        .iter()
        .all(|cell| cell.is_null() || cell.as_str() == Some(""))
    {
        return if rows.iter().all(sheet_row_is_empty) {
            Ok(HeaderDecision::Initialize)
        } else {
            Err(SHEETS_SCHEMA_MISMATCH_ERROR)
        };
    }

    if cells.len() == expected.len()
        && cells
            .iter()
            .zip(expected)
            .all(|(cell, header)| cell.as_str() == Some(*header))
    {
        Ok(HeaderDecision::Match)
    } else {
        Err(SHEETS_SCHEMA_MISMATCH_ERROR)
    }
}

fn sheet_cell_value(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Null => serde_json::Value::String(String::new()),
        serde_json::Value::String(_)
        | serde_json::Value::Number(_)
        | serde_json::Value::Bool(_) => value.clone(),
        _ => serde_json::Value::String(value.to_string()),
    }
}

fn project_row_values(
    headers: &[&str],
    row_id: &str,
    payload: &serde_json::Value,
    existing: Option<&Vec<serde_json::Value>>,
) -> Vec<serde_json::Value> {
    headers
        .iter()
        .enumerate()
        .map(|(index, header)| {
            if index == 0 {
                serde_json::Value::String(row_id.to_owned())
            } else if let Some(value) = payload.get(*header) {
                sheet_cell_value(value)
            } else {
                existing
                    .and_then(|cells| cells.get(index))
                    .map(sheet_cell_value)
                    .unwrap_or_else(|| serde_json::Value::String(String::new()))
            }
        })
        .collect()
}

fn cell_matches_row_id(cell: &serde_json::Value, row_id: &str) -> bool {
    match cell {
        serde_json::Value::String(value) => value == row_id,
        serde_json::Value::Number(value) => value.to_string() == row_id,
        serde_json::Value::Bool(value) => value.to_string() == row_id,
        _ => false,
    }
}

fn find_existing_row_index(
    rows: &[serde_json::Value],
    row_id: &str,
) -> Result<Option<usize>, &'static str> {
    let mut matches = rows.iter().enumerate().skip(1).filter_map(|(index, row)| {
        row.as_array()
            .and_then(|cells| cells.first())
            .filter(|cell| cell_matches_row_id(cell, row_id))
            .map(|_| index)
    });
    let first = matches.next();

    if matches.next().is_some() {
        Err(SHEETS_ROW_ID_AMBIGUOUS_ERROR)
    } else {
        Ok(first)
    }
}

fn processing_lease_is_stale(locked_at: Option<&str>, now: &DateTime<Utc>) -> bool {
    locked_at
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| {
            value.with_timezone(&Utc)
                < *now - chrono::Duration::minutes(PROCESSING_LEASE_TIMEOUT_MINUTES)
        })
        .unwrap_or(false)
}

async fn recover_stale_processing_leases(
    state: &AppState,
    now: DateTime<Utc>,
) -> Result<(), String> {
    let leases = sqlx::query(
        "SELECT id, locked_at FROM sync_queue WHERE status='PROCESSING' ORDER BY id LIMIT ?",
    )
    .bind(SYNC_BATCH_SIZE)
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    let now_text = now.to_rfc3339();

    for lease in leases {
        let locked_at: Option<String> = lease.get("locked_at");
        if !processing_lease_is_stale(locked_at.as_deref(), &now) {
            continue;
        }

        let id: i64 = lease.get("id");
        sqlx::query(
            "UPDATE sync_queue SET status='RETRY', locked_at=NULL, next_attempt_at=?, updated_at=? WHERE id=? AND status='PROCESSING' AND locked_at=?",
        )
        .bind(&now_text)
        .bind(&now_text)
        .bind(id)
        .bind(locked_at.as_deref())
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

async fn google_access_token(path: &str) -> Result<String, String> {
    let raw = tokio::fs::read_to_string(path)
        .await
        .map_err(|_| "service account read failed".to_string())?;
    let account: ServiceAccount =
        serde_json::from_str(&raw).map_err(|_| "service account JSON invalid".to_string())?;
    let now = chrono::Utc::now().timestamp();
    let claims = JwtClaims {
        iss: &account.client_email,
        scope: "https://www.googleapis.com/auth/spreadsheets",
        aud: account
            .token_uri
            .as_deref()
            .unwrap_or("https://oauth2.googleapis.com/token"),
        iat: now,
        exp: now + 3600,
    };
    let header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256);
    let key = jsonwebtoken::EncodingKey::from_rsa_pem(account.private_key.as_bytes())
        .map_err(|_| "service account key invalid".to_string())?;
    let assertion = jsonwebtoken::encode(&header, &claims, &key)
        .map_err(|_| "JWT signing failed".to_string())?;
    let response: serde_json::Value = reqwest::Client::new()
        .post(claims.aud)
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
            ("assertion", assertion.as_str()),
        ])
        .send()
        .await
        .map_err(|_| "Google access token request failed".to_string())?
        .error_for_status()
        .map_err(|_| "Google access token request failed".to_string())?
        .json()
        .await
        .map_err(|_| "Google access token response invalid".to_string())?;
    response
        .get("access_token")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .ok_or_else(|| "Google token response did not contain access_token".into())
}

async fn google_append_row(
    path: &str,
    spreadsheet_id: &str,
    table_name: &str,
    row_id: &str,
    payload: &serde_json::Value,
) -> Result<(), String> {
    if row_id.trim().is_empty() {
        return Err(SHEETS_ROW_ID_MISSING_ERROR.to_string());
    }

    let token = google_access_token(path).await?;
    let client = reqwest::Client::new();
    let read_range = format!("{}!A:Z", table_name);
    let existing: serde_json::Value = client
        .get(format!(
            "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{}",
            urlencoding::encode(&read_range)
        ))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|_| SHEETS_REQUEST_FAILED_ERROR.to_string())?
        .error_for_status()
        .map_err(|_| SHEETS_REQUEST_FAILED_ERROR.to_string())?
        .json()
        .await
        .map_err(|_| SHEETS_REQUEST_FAILED_ERROR.to_string())?;
    let headers = sheet_headers(table_name);
    let decision = header_decision(&existing, headers).map_err(str::to_owned)?;
    let rows = existing.get("values").and_then(|value| value.as_array());
    if decision == HeaderDecision::Initialize {
        let header_body = serde_json::json!({"values":[headers]});
        client.put(format!("https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{}!A1?valueInputOption=RAW", urlencoding::encode(table_name))).bearer_auth(&token).json(&header_body).send().await.map_err(|_| SHEETS_REQUEST_FAILED_ERROR.to_string())?.error_for_status().map_err(|_| SHEETS_REQUEST_FAILED_ERROR.to_string())?;
    }
    let row_index = rows
        .map(|rows| find_existing_row_index(rows, row_id))
        .transpose()?
        .flatten();
    let existing_cells = row_index
        .and_then(|index| rows.and_then(|rows| rows.get(index)))
        .and_then(|row| row.as_array());
    let row = serde_json::json!({"values":[project_row_values(headers, row_id, payload, existing_cells)]});

    if let Some(row_index) = row_index {
        let row_number = row_index + 1;
        let end_column = (b'A' + sheet_headers(table_name).len().saturating_sub(1) as u8) as char;
        let range = format!(
            "{}!A{}:{}{}",
            table_name, row_number, end_column, row_number
        );
        client.put(format!("https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{}?valueInputOption=RAW", urlencoding::encode(&range))).bearer_auth(token).json(&row).send().await.map_err(|_| SHEETS_REQUEST_FAILED_ERROR.to_string())?.error_for_status().map(|_| ()).map_err(|_| SHEETS_REQUEST_FAILED_ERROR.to_string())
    } else {
        let range = format!("{}!A1", table_name);
        client.post(format!("https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS", urlencoding::encode(&range))).bearer_auth(token).json(&row).send().await.map_err(|_| SHEETS_REQUEST_FAILED_ERROR.to_string())?.error_for_status().map(|_| ()).map_err(|_| SHEETS_REQUEST_FAILED_ERROR.to_string())
    }
}

/// Bounded SQLite-first queue worker. The configured exporter endpoint is intentionally
/// optional; when absent rows remain pending instead of being discarded.
pub async fn run_once(state: &AppState, endpoint: Option<&str>) -> Result<u64, String> {
    let now_at = Utc::now();
    recover_stale_processing_leases(state, now_at).await?;
    if endpoint.is_none()
        && (state.lan.google_service_account_json_path.is_none()
            || state.lan.google_spreadsheet_id.is_none())
    {
        return Ok(0);
    }

    let now = now_at.to_rfc3339();
    let rows = sqlx::query("SELECT id, table_name, row_id, operation, payload_json, attempts FROM sync_queue WHERE status IN ('PENDING','RETRY') AND next_attempt_at <= ? ORDER BY id LIMIT ?")
        .bind(&now).bind(SYNC_BATCH_SIZE).fetch_all(&state.db).await.map_err(|e| e.to_string())?;
    let mut completed = 0;
    let mut schema_mismatch = false;
    for row in rows {
        let id: i64 = row.get("id");
        let claimed = sqlx::query("UPDATE sync_queue SET status='PROCESSING',locked_at=?,updated_at=? WHERE id=? AND status IN ('PENDING','RETRY')").bind(&now).bind(&now).bind(id).execute(&state.db).await.map_err(|e| e.to_string())?;
        if claimed.rows_affected() != 1 {
            continue;
        }
        let attempts: i64 = row.get("attempts");
        let table_name: String = row.get("table_name");
        let row_id: String = row.get("row_id");
        let operation: String = row.get("operation");
        let payload_json: String = row.get("payload_json");
        let payload = serde_json::from_str::<serde_json::Value>(&payload_json)
            .ok()
            .filter(serde_json::Value::is_object);
        let result = if row_id.trim().is_empty() {
            Err(SHEETS_ROW_ID_MISSING_ERROR.to_string())
        } else if let Some(payload) = payload {
            if let Some(url) = endpoint {
                reqwest::Client::new()
                    .post(url)
                    .json(&serde_json::json!({"table":table_name,"rowId":row_id,"operation":operation,"payload":payload}))
                    .send()
                    .await
                    .map_err(|_| SHEETS_REQUEST_FAILED_ERROR.to_string())
                    .and_then(|response| {
                        response
                            .error_for_status()
                            .map(|_| ())
                            .map_err(|_| SHEETS_REQUEST_FAILED_ERROR.to_string())
                    })
            } else if let (Some(path), Some(spreadsheet)) = (
                state.lan.google_service_account_json_path.as_deref(),
                state.lan.google_spreadsheet_id.as_deref(),
            ) {
                google_append_row(path, spreadsheet, &table_name, &row_id, &payload).await
            } else {
                Err(SHEETS_REQUEST_FAILED_ERROR.to_string())
            }
        } else {
            Err(SHEETS_INVALID_PAYLOAD_ERROR.to_string())
        };
        match result {
            Ok(()) => {
                sqlx::query("UPDATE sync_queue SET status='SYNCED', locked_at=NULL, updated_at=? WHERE id=? AND status='PROCESSING'").bind(&now).bind(id).execute(&state.db).await.map_err(|e| e.to_string())?;
                completed += 1;
            }
            Err(error) => {
                let is_schema_mismatch = error == SHEETS_SCHEMA_MISMATCH_ERROR;
                let next = Utc::now()
                    + Duration::from_secs(2_u64.saturating_pow((attempts as u32).min(5)));
                let status = if attempts + 1 >= 5 { "DEAD" } else { "RETRY" };
                let last_error = if is_schema_mismatch {
                    SHEETS_SCHEMA_MISMATCH_ERROR
                } else {
                    "Google Sheets sync failed; retry scheduled"
                };
                sqlx::query("UPDATE sync_queue SET attempts=attempts+1, status=?, last_error=?, last_error_code='GOOGLE_SYNC_FAILED', locked_at=NULL, next_attempt_at=?, updated_at=? WHERE id=? AND status='PROCESSING'").bind(status).bind(last_error).bind(next.to_rfc3339()).bind(&now).bind(id).execute(&state.db).await.map_err(|e| e.to_string())?;
                schema_mismatch |= is_schema_mismatch;
            }
        }
    }
    if schema_mismatch {
        Err(SHEETS_SCHEMA_MISMATCH_ERROR.to_string())
    } else {
        Ok(completed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration as ChronoDuration;
    use serde_json::json;

    #[test]
    fn managed_tabs_have_stable_versioned_headers() {
        assert_eq!(sheet_headers("Attendance")[0], "attendanceId");
        assert_eq!(sheet_headers("PayrollCutoffs")[14], "status");
        assert_eq!(SHEETS_SCHEMA_VERSION, 2);
    }

    #[test]
    fn queued_row_id_is_the_authoritative_identity() {
        let headers = sheet_headers("Users");
        let existing = vec![
            json!(headers),
            json!(["queue-user-id", "RFID-001", "Existing name"]),
        ];
        let row_index = find_existing_row_index(&existing, "queue-user-id")
            .unwrap()
            .expect("persisted queue ID should locate the existing row");
        let cells = existing[row_index].as_array().unwrap();

        let values = project_row_values(
            headers,
            "queue-user-id",
            &json!({"userId":"payload-user-id", "fullName":"Updated name"}),
            Some(cells),
        );

        assert_eq!(values[0], json!("queue-user-id"));
        assert_eq!(values[2], json!("Updated name"));
    }

    #[test]
    fn scalar_payload_values_keep_their_json_types() {
        let values = project_row_values(
            sheet_headers("Users"),
            "user-1",
            &json!({
                "fullName":"Ada",
                "status":true,
                "dailyRatePHP":123.45,
                "department":null
            }),
            None,
        );

        assert_eq!(values[2], json!("Ada"));
        assert_eq!(values[3], json!(""));
        assert_eq!(values[4], json!(true));
        assert_eq!(values[6], json!(123.45));
    }

    #[test]
    fn missing_payload_fields_preserve_existing_cells() {
        let existing = json!([
            "user-1",
            "RFID-001",
            "Existing name",
            "Operations",
            true,
            "REGULAR",
            500.0
        ]);
        let values = project_row_values(
            sheet_headers("Users"),
            "user-1",
            &json!({"fullName":"Updated name"}),
            existing.as_array(),
        );

        assert_eq!(values[1], json!("RFID-001"));
        assert_eq!(values[2], json!("Updated name"));
        assert_eq!(values[3], json!("Operations"));
        assert_eq!(values[4], json!(true));
        assert_eq!(values[6], json!(500.0));
    }

    #[test]
    fn nonempty_mismatched_header_fails_closed() {
        let existing = json!({"values":[["wrongId", "fullName"]]});

        assert_eq!(
            header_decision(&existing, sheet_headers("Users")),
            Err(SHEETS_SCHEMA_MISMATCH_ERROR)
        );
    }

    #[test]
    fn empty_tab_initializes_the_expected_header() {
        let existing = json!({"values":[]});

        assert_eq!(
            header_decision(&existing, sheet_headers("Users")),
            Ok(HeaderDecision::Initialize)
        );
    }

    #[test]
    fn data_below_a_blank_first_row_fails_closed() {
        let existing = json!({"values":[[], ["unexpected data"]]});

        assert_eq!(
            header_decision(&existing, sheet_headers("Users")),
            Err(SHEETS_SCHEMA_MISMATCH_ERROR)
        );
    }

    #[test]
    fn stale_processing_leases_are_recovered_but_active_leases_are_not() {
        let now = Utc::now();
        let stale = (now - ChronoDuration::minutes(5) - ChronoDuration::seconds(1)).to_rfc3339();
        let active = (now - ChronoDuration::minutes(4)).to_rfc3339();

        assert!(processing_lease_is_stale(Some(&stale), &now));
        assert!(!processing_lease_is_stale(Some(&active), &now));
        assert!(!processing_lease_is_stale(None, &now));
    }
}
