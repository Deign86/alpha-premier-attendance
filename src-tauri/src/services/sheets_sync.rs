use crate::state::AppState;
use chrono::{DateTime, Utc};
use chrono_tz::Asia::Manila;
use sqlx::Row;
use std::collections::HashSet;
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

/// Every tab that is managed (written, deleted, formatted) by the exporter.
/// Tab names must exactly match the CSV/export names.
pub const MANAGED_TABLES: [&str; 7] = [
    "Users",
    "Attendance",
    "AuditLogs",
    "InternGrace",
    "Payroll",
    "PayrollProfiles",
    "PayrollCutoffs",
];

/// How a cell must be normalized before it is written to Sheets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CellKind {
    /// Free-form text; written as-is.
    Text,
    /// `YYYY-MM-DD` plain text (never Google's auto date).
    Date,
    /// `HH:MM:SS` plain text.
    Time,
    /// Full timestamp; written as-is (RFC3339).
    Timestamp,
    /// PHP amount as a plain number with two decimal places. Payload keys
    /// ending in `Centavos` are stored centavos and divided by 100 here.
    Money,
    /// `TRUE` / `FALSE` strings (never `1`/`0`).
    Boolean,
    /// Plain number.
    PlainNumber,
}

struct ColumnSpec {
    header: &'static str,
    kind: CellKind,
    /// Payload key that feeds this column; falls back to `header` when absent.
    source: &'static str,
}

const fn spec(header: &'static str, kind: CellKind, source: &'static str) -> ColumnSpec {
    ColumnSpec { header, kind, source }
}

const USERS_SPECS: [ColumnSpec; 10] = [
    spec("userId", CellKind::Text, "userId"),
    spec("rfidUid", CellKind::Text, "rfidUid"),
    spec("fullName", CellKind::Text, "fullName"),
    spec("department", CellKind::Text, "department"),
    spec("status", CellKind::Text, "status"),
    spec("employeeType", CellKind::Text, "employeeType"),
    spec("dailyRatePHP", CellKind::Money, "dailyRate"),
    spec("payrollProfileId", CellKind::Text, "payrollProfileId"),
    spec("revision", CellKind::PlainNumber, "revision"),
    spec("updatedAt", CellKind::Timestamp, "updatedAt"),
];
const ATTENDANCE_SPECS: [ColumnSpec; 13] = [
    spec("attendanceId", CellKind::Text, "attendanceId"),
    spec("attendanceDate", CellKind::Date, "attendanceDate"),
    spec("userId", CellKind::Text, "userId"),
    spec("rfidUid", CellKind::Text, "rfidUid"),
    spec("fullName", CellKind::Text, "fullName"),
    spec("department", CellKind::Text, "department"),
    spec("timeIn", CellKind::Time, "timeIn"),
    spec("timeOut", CellKind::Time, "timeOut"),
    spec("status", CellKind::Text, "status"),
    spec("source", CellKind::Text, "source"),
    spec("notes", CellKind::Text, "notes"),
    spec("revision", CellKind::PlainNumber, "revision"),
    spec("updatedAt", CellKind::Timestamp, "updatedAt"),
];
const AUDIT_LOGS_SPECS: [ColumnSpec; 7] = [
    spec("logId", CellKind::Text, "logId"),
    spec("timestamp", CellKind::Timestamp, "timestamp"),
    spec("eventType", CellKind::Text, "eventType"),
    spec("rfidUid", CellKind::Text, "rfidUid"),
    spec("userId", CellKind::Text, "userId"),
    spec("message", CellKind::Text, "message"),
    spec("requestId", CellKind::Text, "requestId"),
];
const INTERN_GRACE_SPECS: [ColumnSpec; 5] = [
    spec("graceId", CellKind::Text, "graceId"),
    spec("userId", CellKind::Text, "userId"),
    spec("weekStart", CellKind::Date, "weekStart"),
    spec("attendanceId", CellKind::Text, "attendanceId"),
    spec("usedAt", CellKind::Timestamp, "usedAt"),
];
const PAYROLL_SPECS: [ColumnSpec; 18] = [
    spec("payrollId", CellKind::Text, "payrollId"),
    spec("attendanceId", CellKind::Text, "attendanceId"),
    spec("userId", CellKind::Text, "userId"),
    spec("fullName", CellKind::Text, "fullName"),
    spec("employeeType", CellKind::Text, "employeeType"),
    spec("attendanceDate", CellKind::Date, "attendanceDate"),
    spec("actualTimeIn", CellKind::Time, "actualTimeIn"),
    spec("actualTimeOut", CellKind::Time, "actualTimeOut"),
    spec("computedTimeIn", CellKind::Time, "computedTimeIn"),
    spec("computedTimeOut", CellKind::Time, "computedTimeOut"),
    spec("graceUsed", CellKind::Boolean, "graceUsed"),
    spec("lateHours", CellKind::PlainNumber, "lateHours"),
    spec("lateDeductionPHP", CellKind::Money, "lateDeductionCentavos"),
    spec("basePayPHP", CellKind::Money, "basePayCentavos"),
    spec("dailyPayPHP", CellKind::Money, "dailyPayCentavos"),
    spec("notes", CellKind::Text, "notes"),
    spec("revision", CellKind::PlainNumber, "revision"),
    spec("updatedAt", CellKind::Timestamp, "updatedAt"),
];
const PAYROLL_PROFILES_SPECS: [ColumnSpec; 8] = [
    spec("profileId", CellKind::Text, "profileId"),
    spec("label", CellKind::Text, "label"),
    spec("payrollFrequency", CellKind::Text, "payrollFrequency"),
    spec(
        "standardWorkingDaysPerCutoff",
        CellKind::PlainNumber,
        "standardWorkingDaysPerCutoff",
    ),
    spec("incentivesAllowancePHP", CellKind::Money, "incentivesAllowance"),
    spec("specialAllowancePHP", CellKind::Money, "specialAllowance"),
    spec("revision", CellKind::PlainNumber, "revision"),
    spec("updatedAt", CellKind::Timestamp, "updatedAt"),
];
const PAYROLL_CUTOFFS_SPECS: [ColumnSpec; 18] = [
    spec("payrollId", CellKind::Text, "payrollId"),
    spec("employeeId", CellKind::Text, "employeeId"),
    spec("employeeName", CellKind::Text, "employeeName"),
    spec("payrollProfileId", CellKind::Text, "payrollProfileId"),
    spec("payrollCutoffLabel", CellKind::Text, "payrollCutoffLabel"),
    spec("cutoffStart", CellKind::Date, "cutoffStart"),
    spec("cutoffEnd", CellKind::Date, "cutoffEnd"),
    spec("basicPayPHP", CellKind::Money, "basicPay"),
    spec("allowancesPHP", CellKind::Money, "totalAllowance"),
    spec("incentivesPHP", CellKind::Money, "incentivesAllowance"),
    spec("lateDeductionsPHP", CellKind::Money, "lateDeduction"),
    spec("manualAdjustmentPHP", CellKind::Money, "manualAdjustment"),
    spec("grossPayPHP", CellKind::Money, "grossCompensation"),
    spec("netPayPHP", CellKind::Money, "netPay"),
    spec("status", CellKind::Text, "status"),
    spec("revision", CellKind::PlainNumber, "revision"),
    spec("finalizedAt", CellKind::Timestamp, "finalizedAt"),
    spec("updatedAt", CellKind::Timestamp, "updatedAt"),
];
const FALLBACK_SPECS: [ColumnSpec; 3] = [
    spec("rowId", CellKind::Text, "rowId"),
    spec("operation", CellKind::Text, "operation"),
    spec("payloadJson", CellKind::Text, "payloadJson"),
];

fn column_specs(table_name: &str) -> &'static [ColumnSpec] {
    match table_name {
        "Users" => &USERS_SPECS,
        "Attendance" => &ATTENDANCE_SPECS,
        "AuditLogs" => &AUDIT_LOGS_SPECS,
        "InternGrace" => &INTERN_GRACE_SPECS,
        "Payroll" => &PAYROLL_SPECS,
        "PayrollProfiles" => &PAYROLL_PROFILES_SPECS,
        "PayrollCutoffs" => &PAYROLL_CUTOFFS_SPECS,
        _ => &FALLBACK_SPECS,
    }
}

/// Index of the column that identifies a row for delete propagation.
/// Everything except `InternGrace` keys on its first (ID) column; `InternGrace`
/// keys on `userId` per the tab contract (disambiguated by `attendanceId`).
fn key_column_index(table_name: &str) -> usize {
    match table_name {
        "InternGrace" => 1,
        _ => 0,
    }
}

fn header_position(headers: &[&str], name: &str) -> Option<usize> {
    headers.iter().position(|header| *header == name)
}

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

fn number_value(value: f64) -> serde_json::Value {
    serde_json::Number::from_f64(value)
        .map(serde_json::Value::Number)
        .unwrap_or_else(|| serde_json::Value::String(String::new()))
}

fn format_date_value(value: &serde_json::Value) -> serde_json::Value {
    let Some(raw) = value.as_str() else {
        return sheet_cell_value(value);
    };
    if let Ok(date) = chrono::NaiveDate::parse_from_str(raw, "%Y-%m-%d") {
        return serde_json::Value::String(date.to_string());
    }
    if let Ok(timestamp) = DateTime::parse_from_rfc3339(raw) {
        return serde_json::Value::String(
            timestamp.with_timezone(&Manila).format("%Y-%m-%d").to_string(),
        );
    }
    serde_json::Value::String(raw.to_owned())
}

fn format_time_value(value: &serde_json::Value) -> serde_json::Value {
    let Some(raw) = value.as_str() else {
        return sheet_cell_value(value);
    };
    let bytes = raw.as_bytes();
    if raw.len() == 8
        && bytes[2] == b':'
        && bytes[5] == b':'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 2 || index == 5 || byte.is_ascii_digit())
    {
        return serde_json::Value::String(raw.to_owned());
    }
    if let Ok(timestamp) = DateTime::parse_from_rfc3339(raw) {
        return serde_json::Value::String(
            timestamp.with_timezone(&Manila).format("%H:%M:%S").to_string(),
        );
    }
    serde_json::Value::String(raw.to_owned())
}

fn format_boolean_value(value: &serde_json::Value) -> serde_json::Value {
    let boolean = match value {
        serde_json::Value::Bool(flag) => Some(*flag),
        serde_json::Value::Number(number) => number.as_i64().map(|value| value != 0),
        serde_json::Value::String(text) => match text.to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" => Some(true),
            "false" | "0" | "no" => Some(false),
            _ => None,
        },
        _ => None,
    };
    match boolean {
        Some(true) => serde_json::Value::String("TRUE".to_string()),
        Some(false) => serde_json::Value::String("FALSE".to_string()),
        None => sheet_cell_value(value),
    }
}

/// Normalizes a payload value for a column. `source` is the payload key, which
/// determines whether a money value is stored in centavos.
fn format_payload_value(kind: CellKind, source: &str, value: &serde_json::Value) -> serde_json::Value {
    match kind {
        CellKind::Text | CellKind::Timestamp => sheet_cell_value(value),
        CellKind::Date => format_date_value(value),
        CellKind::Time => format_time_value(value),
        CellKind::Money => {
            let raw = value
                .as_f64()
                .or_else(|| value.as_str().and_then(|text| text.parse::<f64>().ok()))
                .unwrap_or(0.0);
            let pesos = if source.ends_with("Centavos") {
                raw / 100.0
            } else {
                raw
            };
            number_value(pesos)
        }
        CellKind::Boolean => format_boolean_value(value),
        CellKind::PlainNumber => value
            .as_f64()
            .map(number_value)
            .unwrap_or_else(|| sheet_cell_value(value)),
    }
}

/// Normalizes a value already stored in the sheet (already in display units,
/// so money values are never re-divided).
fn format_existing_value(kind: CellKind, value: &serde_json::Value) -> serde_json::Value {
    match kind {
        CellKind::Money => value
            .as_f64()
            .map(number_value)
            .unwrap_or_else(|| sheet_cell_value(value)),
        _ => format_payload_value(kind, "", value),
    }
}

fn project_row_values(
    table_name: &str,
    row_id: &str,
    payload: &serde_json::Value,
    existing: Option<&Vec<serde_json::Value>>,
) -> Vec<serde_json::Value> {
    column_specs(table_name)
        .iter()
        .enumerate()
        .map(|(index, spec)| {
            if index == 0 {
                serde_json::Value::String(row_id.to_owned())
            } else {
                let direct = payload.get(spec.source).or_else(|| payload.get(spec.header));
                match direct {
                    Some(value) => format_payload_value(spec.kind, spec.source, value),
                    None => existing
                        .and_then(|cells| cells.get(index))
                        .map(|value| format_existing_value(spec.kind, value))
                        .unwrap_or_else(|| serde_json::Value::String(String::new())),
                }
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

fn value_to_match_string(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) => Some(text.clone()),
        serde_json::Value::Number(number) => Some(number.to_string()),
        serde_json::Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
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

/// Finds every sheet row (1-based value index) whose key column matches
/// `row_id`, disambiguating multiple hits with payload fields that map to
/// columns (e.g. `InternGrace` uses `userId` + `attendanceId` + `graceId`).
fn find_rows_to_delete(
    table_name: &str,
    rows: &[serde_json::Value],
    row_id: &str,
    payload: &serde_json::Value,
) -> Result<Vec<usize>, &'static str> {
    let headers = sheet_headers(table_name);
    let key_index = key_column_index(table_name);
    let mut matches: Vec<usize> = rows
        .iter()
        .enumerate()
        .skip(1)
        .filter_map(|(index, row)| {
            row.as_array()
                .and_then(|cells| cells.get(key_index))
                .filter(|cell| cell_matches_row_id(cell, row_id))
                .map(|_| index)
        })
        .collect();
    if matches.len() > 1 {
        if let Some(object) = payload.as_object() {
            for (field, value) in object {
                let Some(expected) = value_to_match_string(value) else {
                    continue;
                };
                let Some(column) = header_position(headers, field) else {
                    continue;
                };
                matches.retain(|&index| {
                    rows[index]
                        .as_array()
                        .and_then(|cells| cells.get(column))
                        .is_some_and(|cell| cell_matches_row_id(cell, &expected))
                });
                if matches.len() <= 1 {
                    break;
                }
            }
        }
    }
    Ok(matches)
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

fn color_rgb(hex: u32) -> serde_json::Value {
    serde_json::json!({
        "red": ((hex >> 16) & 0xFF) as f64 / 255.0,
        "green": ((hex >> 8) & 0xFF) as f64 / 255.0,
        "blue": (hex & 0xFF) as f64 / 255.0,
    })
}

/// Creates the tab (with the exact managed name and header row) if it is
/// missing from the spreadsheet. No-op when the tab already exists.
async fn ensure_tab_exists(
    client: &reqwest::Client,
    token: &str,
    spreadsheet_id: &str,
    table_name: &str,
) -> Result<(), String> {
    let metadata: serde_json::Value = client
        .get(format!(
            "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}?fields=sheets.properties.title"
        ))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| SHEETS_REQUEST_FAILED_ERROR.to_string())?
        .error_for_status()
        .map_err(|_| SHEETS_REQUEST_FAILED_ERROR.to_string())?
        .json()
        .await
        .map_err(|_| SHEETS_REQUEST_FAILED_ERROR.to_string())?;
    let exists = metadata
        .get("sheets")
        .and_then(|value| value.as_array())
        .is_some_and(|sheets| {
            sheets.iter().any(|sheet| {
                sheet
                    .get("properties")
                    .and_then(|properties| properties.get("title"))
                    .and_then(|title| title.as_str())
                    == Some(table_name)
            })
        });
    if exists {
        return Ok(());
    }
    client
        .post(format!(
            "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}:batchUpdate"
        ))
        .bearer_auth(token)
        .json(&serde_json::json!({
            "requests": [{ "addSheet": { "properties": { "title": table_name } } }]
        }))
        .send()
        .await
        .map_err(|_| SHEETS_REQUEST_FAILED_ERROR.to_string())?
        .error_for_status()
        .map_err(|_| SHEETS_REQUEST_FAILED_ERROR.to_string())?;
    let header_body = serde_json::json!({ "values": [sheet_headers(table_name)] });
    client
        .put(format!(
            "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{}!A1?valueInputOption=RAW",
            urlencoding::encode(table_name)
        ))
        .bearer_auth(token)
        .json(&header_body)
        .send()
        .await
        .map_err(|_| SHEETS_REQUEST_FAILED_ERROR.to_string())?
        .error_for_status()
        .map(|_| ())
        .map_err(|_| SHEETS_REQUEST_FAILED_ERROR.to_string())
}

async fn sheet_id_for_tab(
    client: &reqwest::Client,
    token: &str,
    spreadsheet_id: &str,
    table_name: &str,
) -> Result<i64, String> {
    let metadata: serde_json::Value = client
        .get(format!(
            "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}?fields=sheets(sheetId,properties(sheetId,title))"
        ))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| SHEETS_REQUEST_FAILED_ERROR.to_string())?
        .error_for_status()
        .map_err(|_| SHEETS_REQUEST_FAILED_ERROR.to_string())?
        .json()
        .await
        .map_err(|_| SHEETS_REQUEST_FAILED_ERROR.to_string())?;
    metadata
        .get("sheets")
        .and_then(|value| value.as_array())
        .and_then(|sheets| {
            sheets.iter().find_map(|sheet| {
                let title = sheet
                    .get("properties")
                    .and_then(|properties| properties.get("title"))
                    .and_then(|title| title.as_str());
                let id = sheet
                    .get("sheetId")
                    .and_then(|value| value.as_i64());
                match (title, id) {
                    (Some(title), Some(id)) if title == table_name => Some(id),
                    _ => None,
                }
            })
        })
        .ok_or_else(|| SHEETS_REQUEST_FAILED_ERROR.to_string())
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
    let row = serde_json::json!({"values":[project_row_values(table_name, row_id, payload, existing_cells)]});

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

/// Deletes the row identified by `row_id` (matched by cell value in the key
/// column, never by position). Returns `true` when a row was actually removed
/// and `false` when the row was already absent (no-op success).
async fn google_delete_row(
    path: &str,
    spreadsheet_id: &str,
    table_name: &str,
    row_id: &str,
    payload: &serde_json::Value,
) -> Result<bool, String> {
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
    let rows = existing
        .get("values")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    if decision == HeaderDecision::Initialize {
        let header_body = serde_json::json!({"values":[headers]});
        client.put(format!("https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{}!A1?valueInputOption=RAW", urlencoding::encode(table_name))).bearer_auth(&token).json(&header_body).send().await.map_err(|_| SHEETS_REQUEST_FAILED_ERROR.to_string())?.error_for_status().map_err(|_| SHEETS_REQUEST_FAILED_ERROR.to_string())?;
        return Ok(false);
    }
    let matches = find_rows_to_delete(table_name, &rows, row_id, payload).map_err(str::to_owned)?;
    if matches.is_empty() {
        return Ok(false);
    }
    if matches.len() > 1 {
        return Err(SHEETS_ROW_ID_AMBIGUOUS_ERROR.to_string());
    }
    let sheet_id = sheet_id_for_tab(&client, &token, spreadsheet_id, table_name).await?;
    let row_index = matches[0];
    client
        .post(format!(
            "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}:batchUpdate"
        ))
        .bearer_auth(&token)
        .json(&serde_json::json!({
            "requests": [{
                "deleteDimension": {
                    "range": {
                        "sheetId": sheet_id,
                        "dimension": "ROWS",
                        "startIndex": row_index,
                        "endIndex": row_index + 1
                    }
                }
            }]
        }))
        .send()
        .await
        .map_err(|_| SHEETS_REQUEST_FAILED_ERROR.to_string())?
        .error_for_status()
        .map(|_| ())
        .map_err(|_| SHEETS_REQUEST_FAILED_ERROR.to_string())?;
    Ok(true)
}

/// Applies and maintains the formatting standard on a tab:
/// frozen bold header on brand `#1a4e3f`, alternating white / `#f2f2f2` data
/// bands, `0.00` money cells, plain-text date/time cells, auto-sized columns
/// and trailing blank rows removed.
async fn google_format_sheet(
    path: &str,
    spreadsheet_id: &str,
    table_name: &str,
) -> Result<(), String> {
    let token = google_access_token(path).await?;
    let client = reqwest::Client::new();
    let headers = sheet_headers(table_name);
    let col_count = headers.len();

    let metadata: serde_json::Value = client
        .get(format!(
            "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}?fields=sheets(sheetId,properties(sheetId,title,gridProperties(rowCount)),bandedRanges(bandedRangeId))"
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
    let sheets = metadata
        .get("sheets")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let Some(sheet) = sheets.iter().find(|sheet| {
        sheet
            .get("properties")
            .and_then(|properties| properties.get("title"))
            .and_then(|title| title.as_str())
            == Some(table_name)
    }) else {
        return Err(SHEETS_REQUEST_FAILED_ERROR.to_string());
    };
    let sheet_id: i64 = sheet
        .get("properties")
        .and_then(|properties| properties.get("sheetId"))
        .and_then(|value| value.as_i64())
        .unwrap_or(-1);
    let row_count: i64 = sheet
        .get("properties")
        .and_then(|properties| properties.get("gridProperties"))
        .and_then(|grid| grid.get("rowCount"))
        .and_then(|value| value.as_i64())
        .unwrap_or(1000);

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
    let rows = existing
        .get("values")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let mut last_data_row: i64 = 0;
    for (index, row) in rows.iter().enumerate() {
        let has_value = row.as_array().is_some_and(|cells| {
            cells
                .iter()
                .any(|cell| !(cell.is_null() || cell.as_str() == Some("")))
        });
        if has_value {
            last_data_row = index as i64;
        }
    }

    let mut requests: Vec<serde_json::Value> = Vec::new();
    requests.push(serde_json::json!({
        "updateSheetProperties": {
            "properties": { "sheetId": sheet_id, "gridProperties": { "frozenRowCount": 1 } },
            "fields": "gridProperties.frozenRowCount"
        }
    }));
    requests.push(serde_json::json!({
        "repeatCell": {
            "range": {
                "sheetId": sheet_id,
                "startRowIndex": 0,
                "endRowIndex": 1,
                "startColumnIndex": 0,
                "endColumnIndex": col_count
            },
            "cell": {
                "userEnteredFormat": {
                    "backgroundColor": color_rgb(0x1a4e3f),
                    "textFormat": {
                        "foregroundColor": serde_json::json!({"red":1.0,"green":1.0,"blue":1.0}),
                        "bold": true
                    }
                }
            },
            "fields": "userEnteredFormat.backgroundColor,userEnteredFormat.textFormat"
        }
    }));
    if let Some(bandings) = sheet.get("bandedRanges").and_then(|value| value.as_array()) {
        for banding in bandings {
            if let Some(banded_range_id) = banding.get("bandedRangeId").and_then(|v| v.as_i64()) {
                requests.push(serde_json::json!({
                    "deleteBanding": { "bandedRangeId": banded_range_id }
                }));
            }
        }
    }
    if last_data_row >= 1 {
        requests.push(serde_json::json!({
            "addBanding": {
                "bandedRange": {
                    "range": {
                        "sheetId": sheet_id,
                        "startRowIndex": 1,
                        "endRowIndex": last_data_row + 1,
                        "startColumnIndex": 0,
                        "endColumnIndex": col_count
                    },
                    "rowProperties": {
                        "firstBandColor": serde_json::json!({"red":1.0,"green":1.0,"blue":1.0}),
                        "secondBandColor": color_rgb(0xf2f2f2)
                    },
                    "headerRowPosition": -1
                }
            }
        }));
        for (index, spec) in column_specs(table_name).iter().enumerate() {
            let number_format = match spec.kind {
                CellKind::Money => Some(serde_json::json!({"type":"NUMBER","pattern":"0.00"})),
                CellKind::Date | CellKind::Time => {
                    Some(serde_json::json!({"type":"TEXT","pattern":"@"}))
                }
                _ => None,
            };
            if let Some(number_format) = number_format {
                requests.push(serde_json::json!({
                    "repeatCell": {
                        "range": {
                            "sheetId": sheet_id,
                            "startRowIndex": 1,
                            "endRowIndex": last_data_row + 1,
                            "startColumnIndex": index,
                            "endColumnIndex": index + 1
                        },
                        "cell": { "userEnteredFormat": { "numberFormat": number_format } },
                        "fields": "userEnteredFormat.numberFormat"
                    }
                }));
            }
        }
    }
    requests.push(serde_json::json!({
        "autoResizeDimensions": {
            "dimensions": {
                "sheetId": sheet_id,
                "dimension": "COLUMNS",
                "startIndex": 0,
                "endIndex": col_count
            }
        }
    }));
    if row_count > last_data_row + 1 {
        requests.push(serde_json::json!({
            "deleteDimension": {
                "range": {
                    "sheetId": sheet_id,
                    "dimension": "ROWS",
                    "startIndex": last_data_row + 1,
                    "endIndex": row_count
                }
            }
        }));
    }
    for chunk in requests.chunks(50) {
        client
            .post(format!(
                "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}:batchUpdate"
            ))
            .bearer_auth(&token)
            .json(&serde_json::json!({ "requests": chunk }))
            .send()
            .await
            .map_err(|_| SHEETS_REQUEST_FAILED_ERROR.to_string())?
            .error_for_status()
            .map(|_| ())
            .map_err(|_| SHEETS_REQUEST_FAILED_ERROR.to_string())?;
    }
    Ok(())
}

/// Reads the current SQLite state for one managed table into `(row_id, payload)`
/// pairs shaped exactly like the live upsert payloads.
async fn load_table_payloads(
    db: &sqlx::SqlitePool,
    table_name: &str,
) -> Result<Vec<(String, serde_json::Value)>, String> {
    let cents = |value: i64| -> f64 { value as f64 / 100.0 };
    let rows: Vec<(String, serde_json::Value)> = match table_name {
        "Users" => sqlx::query("SELECT user_id, rfid_uid, full_name, department, status, employee_type, daily_rate_centavos, payroll_profile_id, revision, updated_at FROM users")
            .fetch_all(db).await.map_err(|e| e.to_string())?
            .into_iter().map(|row| {
                let id: String = row.get("user_id");
                let payload = serde_json::json!({
                    "userId": id,
                    "rfidUid": row.get::<String,_>("rfid_uid"),
                    "fullName": row.get::<String,_>("full_name"),
                    "department": row.get::<Option<String>,_>("department"),
                    "status": row.get::<String,_>("status"),
                    "employeeType": row.get::<String,_>("employee_type"),
                    "dailyRate": row.get::<Option<i64>,_>("daily_rate_centavos").map(cents),
                    "payrollProfileId": row.get::<Option<String>,_>("payroll_profile_id"),
                    "revision": row.get::<i64,_>("revision"),
                    "updatedAt": row.get::<String,_>("updated_at"),
                });
                (id, payload)
            }).collect(),
        "Attendance" => sqlx::query("SELECT attendance_id, attendance_date, user_id, rfid_uid, full_name, department, time_in, time_out, status, source, notes, revision, updated_at FROM attendance")
            .fetch_all(db).await.map_err(|e| e.to_string())?
            .into_iter().map(|row| {
                let id: String = row.get("attendance_id");
                let payload = serde_json::json!({
                    "attendanceId": id,
                    "attendanceDate": row.get::<String,_>("attendance_date"),
                    "userId": row.get::<String,_>("user_id"),
                    "rfidUid": row.get::<String,_>("rfid_uid"),
                    "fullName": row.get::<String,_>("full_name"),
                    "department": row.get::<Option<String>,_>("department"),
                    "timeIn": row.get::<Option<String>,_>("time_in"),
                    "timeOut": row.get::<Option<String>,_>("time_out"),
                    "status": row.get::<String,_>("status"),
                    "source": row.get::<String,_>("source"),
                    "notes": row.get::<String,_>("notes"),
                    "revision": row.get::<i64,_>("revision"),
                    "updatedAt": row.get::<String,_>("updated_at"),
                });
                (id, payload)
            }).collect(),
        "AuditLogs" => sqlx::query("SELECT log_id, timestamp, event_type, rfid_uid, user_id, message, request_id FROM audit_logs")
            .fetch_all(db).await.map_err(|e| e.to_string())?
            .into_iter().map(|row| {
                let id: String = row.get("log_id");
                let payload = serde_json::json!({
                    "logId": id,
                    "timestamp": row.get::<String,_>("timestamp"),
                    "eventType": row.get::<String,_>("event_type"),
                    "rfidUid": row.get::<Option<String>,_>("rfid_uid"),
                    "userId": row.get::<Option<String>,_>("user_id"),
                    "message": row.get::<String,_>("message"),
                    "requestId": row.get::<String,_>("request_id"),
                });
                (id, payload)
            }).collect(),
        "InternGrace" => sqlx::query("SELECT grace_id, user_id, week_start, attendance_id, used_at FROM intern_grace")
            .fetch_all(db).await.map_err(|e| e.to_string())?
            .into_iter().map(|row| {
                let id: String = row.get("grace_id");
                let payload = serde_json::json!({
                    "graceId": id,
                    "userId": row.get::<String,_>("user_id"),
                    "weekStart": row.get::<String,_>("week_start"),
                    "attendanceId": row.get::<String,_>("attendance_id"),
                    "usedAt": row.get::<String,_>("used_at"),
                });
                (id, payload)
            }).collect(),
        "Payroll" => sqlx::query("SELECT payroll_id, attendance_id, user_id, full_name, employee_type, attendance_date, actual_time_in, actual_time_out, computed_time_in, computed_time_out, grace_used, late_hours, late_deduction_centavos, base_pay_centavos, daily_pay_centavos, notes, revision, updated_at FROM payroll")
            .fetch_all(db).await.map_err(|e| e.to_string())?
            .into_iter().map(|row| {
                let id: String = row.get("payroll_id");
                let payload = serde_json::json!({
                    "payrollId": id,
                    "attendanceId": row.get::<String,_>("attendance_id"),
                    "userId": row.get::<String,_>("user_id"),
                    "fullName": row.get::<String,_>("full_name"),
                    "employeeType": row.get::<String,_>("employee_type"),
                    "attendanceDate": row.get::<String,_>("attendance_date"),
                    "actualTimeIn": row.get::<String,_>("actual_time_in"),
                    "actualTimeOut": row.get::<String,_>("actual_time_out"),
                    "computedTimeIn": row.get::<String,_>("computed_time_in"),
                    "computedTimeOut": row.get::<String,_>("computed_time_out"),
                    "graceUsed": row.get::<Option<i64>,_>("grace_used").map(|v| v != 0),
                    "lateHours": row.get::<i64,_>("late_hours"),
                    "lateDeductionCentavos": row.get::<i64,_>("late_deduction_centavos"),
                    "basePayCentavos": row.get::<i64,_>("base_pay_centavos"),
                    "dailyPayCentavos": row.get::<i64,_>("daily_pay_centavos"),
                    "notes": row.get::<String,_>("notes"),
                    "revision": row.get::<i64,_>("revision"),
                    "updatedAt": row.get::<String,_>("updated_at"),
                });
                (id, payload)
            }).collect(),
        "PayrollProfiles" => sqlx::query("SELECT profile_id, label, payroll_frequency, standard_working_days_per_cutoff, incentives_allowance_centavos, special_allowance_centavos, special_holiday_multiplier, regular_holiday_multiplier, half_day_fraction, overtime_rate_centavos, revision, updated_at FROM payroll_profiles")
            .fetch_all(db).await.map_err(|e| e.to_string())?
            .into_iter().map(|row| {
                let id: String = row.get("profile_id");
                let payload = serde_json::json!({
                    "profileId": id,
                    "label": row.get::<String,_>("label"),
                    "payrollFrequency": row.get::<String,_>("payroll_frequency"),
                    "standardWorkingDaysPerCutoff": row.get::<f64,_>("standard_working_days_per_cutoff"),
                    "incentivesAllowance": row.get::<i64,_>("incentives_allowance_centavos") as f64 / 100.0,
                    "specialAllowance": row.get::<i64,_>("special_allowance_centavos") as f64 / 100.0,
                    "specialHolidayMultiplier": row.get::<f64,_>("special_holiday_multiplier"),
                    "regularHolidayMultiplier": row.get::<f64,_>("regular_holiday_multiplier"),
                    "halfDayFraction": row.get::<f64,_>("half_day_fraction"),
                    "overtimeRate": row.get::<i64,_>("overtime_rate_centavos") as f64 / 100.0,
                    "revision": row.get::<i64,_>("revision"),
                    "updatedAt": row.get::<String,_>("updated_at"),
                });
                (id, payload)
            }).collect(),
        "PayrollCutoffs" => sqlx::query("SELECT payroll_id, employee_id, employee_name, payroll_profile_id, payroll_cutoff_label, cutoff_start, cutoff_end, basic_pay_centavos, total_allowance_centavos, incentives_allowance_centavos, late_deduction_centavos, manual_adjustment_centavos, gross_compensation_centavos, net_pay_centavos, status, revision, finalized_at, updated_at FROM payroll_cutoffs")
            .fetch_all(db).await.map_err(|e| e.to_string())?
            .into_iter().map(|row| {
                let id: String = row.get("payroll_id");
                let payload = serde_json::json!({
                    "payrollId": id,
                    "employeeId": row.get::<String,_>("employee_id"),
                    "employeeName": row.get::<String,_>("employee_name"),
                    "payrollProfileId": row.get::<String,_>("payroll_profile_id"),
                    "payrollCutoffLabel": row.get::<String,_>("payroll_cutoff_label"),
                    "cutoffStart": row.get::<String,_>("cutoff_start"),
                    "cutoffEnd": row.get::<String,_>("cutoff_end"),
                    "basicPay": cents(row.get::<i64,_>("basic_pay_centavos")),
                    "totalAllowance": cents(row.get::<i64,_>("total_allowance_centavos")),
                    "incentivesAllowance": cents(row.get::<i64,_>("incentives_allowance_centavos")),
                    "lateDeduction": cents(row.get::<i64,_>("late_deduction_centavos")),
                    "manualAdjustment": cents(row.get::<i64,_>("manual_adjustment_centavos")),
                    "grossCompensation": cents(row.get::<i64,_>("gross_compensation_centavos")),
                    "netPay": cents(row.get::<i64,_>("net_pay_centavos")),
                    "status": row.get::<String,_>("status"),
                    "revision": row.get::<i64,_>("revision"),
                    "finalizedAt": row.get::<Option<String>,_>("finalized_at"),
                    "updatedAt": row.get::<String,_>("updated_at"),
                });
                (id, payload)
            }).collect(),
        _ => return Err(SHEETS_INVALID_PAYLOAD_ERROR.to_string()),
    };
    Ok(rows)
}

/// Dev/test utility: clears every data row from every managed tab (keeping the
/// header), drops stale queued operations, then re-enqueues the current SQLite
/// state as fresh upserts so the queue drains the spreadsheet back into sync.
pub async fn nuke_and_resync(state: &AppState) -> Result<serde_json::Value, String> {
    let (Some(path), Some(spreadsheet)) = (
        state.lan.google_service_account_json_path.as_deref(),
        state.lan.google_spreadsheet_id.as_deref(),
    ) else {
        return Err("GOOGLE_SHEETS_NOT_CONFIGURED".into());
    };
    let client = reqwest::Client::new();
    let token = google_access_token(path).await?;
    let mut cleared = 0usize;
    let mut queued = 0usize;
    for table_name in MANAGED_TABLES {
        ensure_tab_exists(&client, &token, spreadsheet, table_name).await?;
        let clear_range = format!("{}!A2:Z", table_name);
        client
            .post(format!(
                "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet}/values/{}:clear",
                urlencoding::encode(&clear_range)
            ))
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|_| SHEETS_REQUEST_FAILED_ERROR.to_string())?
            .error_for_status()
            .map(|_| ())
            .map_err(|_| SHEETS_REQUEST_FAILED_ERROR.to_string())?;
        cleared += 1;

        sqlx::query("DELETE FROM sync_queue WHERE table_name=?")
            .bind(table_name)
            .execute(&state.db)
            .await
            .map_err(|e| e.to_string())?;
        let rows = load_table_payloads(&state.db, table_name).await?;
        let now = chrono::Utc::now().to_rfc3339();
        for (row_id, payload) in rows {
            let idempotency_key = format!("{table_name}:{row_id}:UPSERT");
            let _ = sqlx::query("INSERT INTO sync_queue (table_name,row_id,operation,payload_json,attempts,next_attempt_at,created_at,updated_at,idempotency_key) VALUES (?,?,?,?,0,?,?,?,?) ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json,status='PENDING',next_attempt_at=excluded.next_attempt_at,updated_at=excluded.updated_at,last_error=NULL,last_error_code=NULL")
                .bind(table_name).bind(&row_id).bind("UPSERT").bind(payload.to_string()).bind(&now).bind(&now).bind(&now).bind(&idempotency_key).execute(&state.db).await.map_err(|e| e.to_string())?;
            queued += 1;
        }
    }
    Ok(serde_json::json!({"success":true,"tablesCleared":cleared,"rowsQueued":queued}))
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
    if rows.is_empty() {
        return Ok(0);
    }

    let google_mode = endpoint.is_none();
    let google_path = state.lan.google_service_account_json_path.as_deref();
    let spreadsheet_id = state.lan.google_spreadsheet_id.as_deref();

    if google_mode {
        if let (Some(path), Some(spreadsheet)) = (google_path, spreadsheet_id) {
            let client = reqwest::Client::new();
            let token = google_access_token(path).await?;
            let mut tables: Vec<String> = Vec::new();
            for row in &rows {
                let table: String = row.get("table_name");
                if !tables.contains(&table) {
                    tables.push(table);
                }
            }
            for table in tables {
                ensure_tab_exists(&client, &token, spreadsheet, &table).await?;
            }
        }
    }

    let mut completed = 0;
    let mut schema_mismatch = false;
    let mut touched: HashSet<String> = HashSet::new();
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
        let is_delete = operation == "DELETE";
        let result: Result<bool, String> = if row_id.trim().is_empty() {
            Err(SHEETS_ROW_ID_MISSING_ERROR.to_string())
        } else if let Some(payload) = payload.as_ref() {
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
                            .map(|_| false)
                            .map_err(|_| SHEETS_REQUEST_FAILED_ERROR.to_string())
                    })
            } else if let (Some(path), Some(spreadsheet)) = (google_path, spreadsheet_id) {
                if is_delete {
                    google_delete_row(path, spreadsheet, &table_name, &row_id, payload).await
                } else {
                    google_append_row(path, spreadsheet, &table_name, &row_id, payload)
                        .await
                        .map(|_| false)
                }
            } else {
                Err(SHEETS_REQUEST_FAILED_ERROR.to_string())
            }
        } else {
            Err(SHEETS_INVALID_PAYLOAD_ERROR.to_string())
        };
        match result {
            Ok(found) => {
                sqlx::query("UPDATE sync_queue SET status='SYNCED', locked_at=NULL, updated_at=? WHERE id=? AND status='PROCESSING'").bind(&now).bind(id).execute(&state.db).await.map_err(|e| e.to_string())?;
                completed += 1;
                if is_delete {
                    let deleted_message = if found {
                        format!("Deleted {table_name} row {row_id} from Google Sheets")
                    } else {
                        format!("Deleted {table_name} row {row_id} from Google Sheets (row already absent)")
                    };
                    let _ = sqlx::query("INSERT INTO audit_logs (log_id, timestamp, event_type, user_id, message, request_id) VALUES (?,?,?,?,?,?)")
                        .bind(uuid::Uuid::new_v4().to_string())
                        .bind(chrono::Utc::now().to_rfc3339())
                        .bind("SHEETS_DELETE_PROPAGATED")
                        .bind(payload.as_ref().and_then(|p| p.get("userId")).and_then(|v| v.as_str()))
                        .bind(&deleted_message)
                        .bind(format!("sync-{id}"))
                        .execute(&state.db).await;
                }
                touched.insert(table_name);
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
    if google_mode && !touched.is_empty() {
        if let (Some(path), Some(spreadsheet)) = (google_path, spreadsheet_id) {
            for table in touched {
                if let Err(error) = google_format_sheet(path, spreadsheet, &table).await {
                    eprintln!("[sheets] formatting failed for {table}: {error}");
                }
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
    fn column_specs_are_parallel_to_headers() {
        for table in MANAGED_TABLES {
            assert_eq!(
                column_specs(table).len(),
                sheet_headers(table).len(),
                "spec/header mismatch for {table}"
            );
            for (index, spec) in column_specs(table).iter().enumerate() {
                assert_eq!(spec.header, sheet_headers(table)[index]);
            }
        }
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
            "Users",
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
            "Users",
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
            "Users",
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
    fn normalizes_dates_times_money_and_booleans() {
        assert_eq!(
            format_payload_value(CellKind::Date, "attendanceDate", &json!("2026-08-01T00:00:00+08:00")),
            json!("2026-08-01")
        );
        assert_eq!(
            format_payload_value(CellKind::Time, "timeIn", &json!("2026-08-01T08:30:00+08:00")),
            json!("08:30:00")
        );
        assert_eq!(
            format_payload_value(CellKind::Time, "timeIn", &json!("08:30:00")),
            json!("08:30:00")
        );
        assert_eq!(
            format_payload_value(CellKind::Money, "lateDeductionCentavos", &json!(12345)),
            json!(123.45)
        );
        assert_eq!(
            format_payload_value(CellKind::Money, "dailyRate", &json!(500.0)),
            json!(500.0)
        );
        assert_eq!(
            format_payload_value(CellKind::Boolean, "approvedWorkingDayOverage", &json!(true)),
            json!("TRUE")
        );
        assert_eq!(
            format_payload_value(CellKind::Boolean, "graceUsed", &json!(0)),
            json!("FALSE")
        );
        assert_eq!(
            format_payload_value(CellKind::Boolean, "graceUsed", &json!("1")),
            json!("TRUE")
        );
    }

    #[test]
    fn money_centavos_are_converted_but_preserved_cells_are_not_reconverted() {
        assert_eq!(
            format_payload_value(CellKind::Money, "basePayCentavos", &json!(50_000)),
            json!(500.0)
        );
        assert_eq!(
            format_existing_value(CellKind::Money, &json!(500.0)),
            json!(500.0)
        );
    }

    #[test]
    fn delete_lookup_matches_key_column_and_disambiguates() {
        let rows = vec![
            json!(sheet_headers("InternGrace")),
            json!(["g-1", "user-a", "2026-08-03", "att-1", "2026-08-03T08:00:00Z"]),
            json!(["g-2", "user-a", "2026-08-10", "att-2", "2026-08-10T08:00:00Z"]),
        ];
        let matches = find_rows_to_delete("InternGrace", &rows, "user-a", &json!({"userId":"user-a"}))
            .unwrap();
        assert_eq!(matches, vec![1, 2]);
        let matches = find_rows_to_delete(
            "InternGrace",
            &rows,
            "user-a",
            &json!({"userId":"user-a","attendanceId":"att-2","graceId":"g-2"}),
        )
        .unwrap();
        assert_eq!(matches, vec![2]);
    }

    #[test]
    fn delete_lookup_returns_empty_for_missing_rows() {
        let rows = vec![json!(sheet_headers("Users")), json!(["u-1", "RFID-1", "Ada"])];
        let matches = find_rows_to_delete("Users", &rows, "u-missing", &json!({"userId":"u-missing"}))
            .unwrap();
        assert!(matches.is_empty());
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
