use crate::state::AppState;
use chrono::{DateTime, Utc};
use chrono_tz::Asia::Manila;
use sqlx::Row;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(serde::Deserialize)]
struct ServiceAccount {
    client_email: String,
    private_key: String,
    token_uri: Option<String>,
}

impl std::fmt::Debug for ServiceAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServiceAccount")
            .field("client_email", &self.client_email)
            .field("private_key", &"[redacted]")
            .field("token_uri", &self.token_uri)
            .finish()
    }
}

#[derive(Debug, serde::Serialize)]
struct JwtClaims<'a> {
    iss: &'a str,
    scope: &'a str,
    aud: &'a str,
    iat: i64,
    exp: i64,
}

/// Reserved for schema-version negotiation with the Google Sheets endpoint;
/// kept so the version intent is documented in one place.
#[allow(dead_code)]
pub const SHEETS_SCHEMA_VERSION: i64 = 2;
const SHEETS_SCHEMA_MISMATCH_ERROR: &str = "Google Sheets schema mismatch";
const SHEETS_ROW_ID_MISSING_ERROR: &str = "Google Sheets row identity is missing";
const SHEETS_ROW_ID_AMBIGUOUS_ERROR: &str = "Google Sheets row identity is ambiguous";
const SHEETS_INVALID_PAYLOAD_ERROR: &str = "Google Sheets sync payload is invalid";
const SHEETS_REQUEST_FAILED_ERROR: &str = "Google Sheets sync failed";
const PROCESSING_LEASE_TIMEOUT_MINUTES: i64 = 5;
const SYNC_BATCH_SIZE: i64 = 50;

/// Google API error codes surfaced to the sync queue. They intentionally
/// contain no credentials, paths, or response bodies.
pub const GOOGLE_NOT_FOUND: &str = "GOOGLE_NOT_FOUND";
pub const GOOGLE_PERMISSION_DENIED: &str = "GOOGLE_PERMISSION_DENIED";
pub const GOOGLE_AUTH_FAILED: &str = "GOOGLE_AUTH_FAILED";
pub const GOOGLE_RATE_LIMITED: &str = "GOOGLE_RATE_LIMITED";
pub const GOOGLE_REQUEST_FAILED: &str = "GOOGLE_REQUEST_FAILED";
const GOOGLE_DRIVE_FOLDER_MIME: &str = "application/vnd.google-apps.folder";
const GOOGLE_SCOPES: &str =
    "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive";

/// Total HTTP timeout for every Google API call. The 30s sync tick must never
/// stall on a hung connection: a timed-out call surfaces as `Err` and flows
/// into the existing warn + RETRY/backoff path instead of freezing the queue.
const SHEETS_HTTP_TIMEOUT_SECS: u64 = 25;

/// Single configured HTTP client for all Google API calls. Never use
/// `reqwest::Client::new()` here: the default client has no timeouts.
pub(crate) fn sheets_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(SHEETS_HTTP_TIMEOUT_SECS))
        .build()
        .expect("reqwest client with timeout builds")
}

/// Persisted in `data_dir/google-sheets-state.json`. Only generated resource
/// IDs live here; never service-account keys or tokens.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct GoogleSheetsState {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub drive_folder_id: Option<String>,
    #[serde(default)]
    pub spreadsheet_id: Option<String>,
}

/// Resolved provisioning target used by the sync queue worker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoogleSheetsTarget {
    pub spreadsheet_id: String,
    pub drive_folder_id: Option<String>,
}

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
    ColumnSpec {
        header,
        kind,
        source,
    }
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
    spec(
        "incentivesAllowancePHP",
        CellKind::Money,
        "incentivesAllowance",
    ),
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

/// Sheets column letters for a 0-based index: 0→A … 25→Z, 26→AA, 27→AB.
/// The read ranges below must stay correct past column Z (PayrollCutoffs
/// already spans 18 managed columns).
fn column_letter(mut col: usize) -> String {
    let mut out = Vec::new();
    loop {
        out.push((b'A' + (col % 26) as u8) as char);
        if col < 26 {
            break;
        }
        col = col / 26 - 1;
    }
    out.iter().rev().collect()
}

/// Last managed column letter for a tab (headers define the width).
fn managed_last_column(table_name: &str) -> String {
    column_letter(sheet_headers(table_name).len().saturating_sub(1))
}

/// Header-only read. Bounded to one row so tab growth can never slow it.
fn header_read_range(table_name: &str) -> String {
    format!("{}!A1:{}1", table_name, managed_last_column(table_name))
}

/// Single-column read anchored at sheet row 1 (key cell of row 1 first).
/// Indices into the returned array therefore equal sheet row numbers minus
/// one, and the existing skip(1) matchers keep working unchanged. The Sheets
/// API only trims *trailing* empty rows/columns, so interior positions —
/// including leading blanks — are preserved and the mapping stays exact.
fn key_column_read_range(table_name: &str, col_0based: usize) -> String {
    let letter = column_letter(col_0based);
    format!("{table_name}!{letter}1:{letter}")
}

/// Full-width fetch of exactly one sheet row, for merge-before-write.
fn single_row_read_range(table_name: &str, row_1based: usize) -> String {
    format!(
        "{}!A{}:{}{}",
        table_name,
        row_1based,
        managed_last_column(table_name),
        row_1based
    )
}

/// True when the key column holds any value below the header cell (index 0).
/// Every pipeline-written row fills column A first, so an empty key column
/// means the tab holds no data rows at all.
fn key_column_has_data(key_rows: &[serde_json::Value]) -> bool {
    key_rows.iter().skip(1).any(|row| {
        row.as_array().is_some_and(|cells| {
            cells
                .iter()
                .any(|cell| !(cell.is_null() || cell.as_str() == Some("")))
        })
    })
}

/// Outcome of reconciling a tab's actual header row against the pipeline
/// contract (`sheet_headers`). `Rewrite` fires only for legacy (e.g.
/// Node-era snake_case) headers on tabs with zero data rows — rewriting
/// row 1 then loses nothing. Tabs with data under foreign headers keep
/// failing loudly so no column is ever silently reinterpreted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HeaderRepair {
    Proceed(HeaderDecision),
    Rewrite,
    Mismatch,
}

fn header_repair_action(
    decision: Result<HeaderDecision, &'static str>,
    key_has_data: bool,
) -> HeaderRepair {
    match decision {
        Ok(outcome) => HeaderRepair::Proceed(outcome),
        Err(SHEETS_SCHEMA_MISMATCH_ERROR) if !key_has_data => HeaderRepair::Rewrite,
        Err(_) => HeaderRepair::Mismatch,
    }
}

/// Prefix a pipeline stage onto a Google API error for queue/log diagnosis
/// (`append read: GOOGLE_PERMISSION_DENIED`). Carries the call site plus the
/// upstream status code only — never bodies, keys, or filesystem paths.
fn stage_err(stage: &str, err: String) -> String {
    format!("{stage}: {err}")
}

/// GET a JSON body with stage context. Transport failures stay generic;
/// HTTP statuses keep their distinct codes via `google_status_error`.
async fn google_stage_json(
    stage: &'static str,
    request: Result<reqwest::Response, reqwest::Error>,
) -> Result<serde_json::Value, String> {
    let response =
        request.map_err(|_| stage_err(stage, SHEETS_REQUEST_FAILED_ERROR.to_string()))?;
    let status = response.status();
    if !status.is_success() {
        return Err(stage_err(stage, google_status_error(status).to_string()));
    }
    response
        .json()
        .await
        .map_err(|_| stage_err(stage, SHEETS_REQUEST_FAILED_ERROR.to_string()))
}

/// PUT/POST/batchUpdate with stage context; response body is discarded.
async fn google_stage_status(
    stage: &'static str,
    request: Result<reqwest::Response, reqwest::Error>,
) -> Result<(), String> {
    let response =
        request.map_err(|_| stage_err(stage, SHEETS_REQUEST_FAILED_ERROR.to_string()))?;
    let status = response.status();
    if !status.is_success() {
        return Err(stage_err(stage, google_status_error(status).to_string()));
    }
    Ok(())
}

/// Write (or rewrite) the canonical header row. Shared by the blank-tab
/// path and the empty-tab legacy-header repair path.
async fn put_header_row(
    client: &reqwest::Client,
    token: &str,
    spreadsheet_id: &str,
    table_name: &str,
) -> Result<(), String> {
    let header_body = serde_json::json!({ "values": [sheet_headers(table_name)] });
    google_stage_status(
        "header write",
        client
            .put(format!(
                "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{}!A1?valueInputOption=RAW",
                urlencoding::encode(table_name)
            ))
            .bearer_auth(token)
            .json(&header_body)
            .send()
            .await,
    )
    .await
}

/// Batch range for trimming trailing blank rows. Sheets refuses to delete
/// every non-frozen row, so at least one row below the header always
/// remains (header-only tabs keep exactly one blank data row).
fn trailing_delete_range(
    last_data_row_0based: i64,
    frozen_rows: i64,
    row_count: i64,
) -> Option<(i64, i64)> {
    let start = (last_data_row_0based + 1).max(frozen_rows + 1);
    (start < row_count).then_some((start, row_count))
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
            timestamp
                .with_timezone(&Manila)
                .format("%Y-%m-%d")
                .to_string(),
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
            timestamp
                .with_timezone(&Manila)
                .format("%H:%M:%S")
                .to_string(),
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
fn format_payload_value(
    kind: CellKind,
    source: &str,
    value: &serde_json::Value,
) -> serde_json::Value {
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
                let direct = payload
                    .get(spec.source)
                    .or_else(|| payload.get(spec.header));
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

pub(crate) async fn google_access_token(path: &str) -> Result<String, String> {
    let raw = tokio::fs::read_to_string(path)
        .await
        .map_err(|_| "service account read failed".to_string())?;
    let account: ServiceAccount =
        serde_json::from_str(&raw).map_err(|_| "service account JSON invalid".to_string())?;
    let now = chrono::Utc::now().timestamp();
    let claims = JwtClaims {
        iss: &account.client_email,
        scope: GOOGLE_SCOPES,
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
    let response: serde_json::Value = sheets_client()
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

fn google_status_error(status: reqwest::StatusCode) -> &'static str {
    match status.as_u16() {
        401 => GOOGLE_AUTH_FAILED,
        403 => GOOGLE_PERMISSION_DENIED,
        404 => GOOGLE_NOT_FOUND,
        429 => GOOGLE_RATE_LIMITED,
        _ => GOOGLE_REQUEST_FAILED,
    }
}

async fn google_json_response(response: reqwest::Response) -> Result<serde_json::Value, String> {
    let status = response.status();
    if !status.is_success() {
        return Err(google_status_error(status).to_string());
    }
    response
        .json()
        .await
        .map_err(|_| GOOGLE_REQUEST_FAILED.to_string())
}

fn drive_folder_url(folder_id: &str) -> String {
    format!(
        "https://www.googleapis.com/drive/v3/files/{folder_id}?fields=id,mimeType&supportsAllDrives=true"
    )
}

fn drive_create_folder_url() -> &'static str {
    "https://www.googleapis.com/drive/v3/files?fields=id&supportsAllDrives=true"
}

fn drive_parents_url(file_id: &str) -> String {
    format!(
        "https://www.googleapis.com/drive/v3/files/{file_id}?fields=parents&supportsAllDrives=true"
    )
}

/// `addParents` adds the folder without removing any existing parent; the
/// spreadsheet remains visible everywhere it already lives.
fn drive_add_parent_url(file_id: &str, folder_id: &str) -> String {
    format!(
        "https://www.googleapis.com/drive/v3/files/{file_id}?addParents={folder_id}&fields=id,parents&supportsAllDrives=true"
    )
}

fn sheets_spreadsheet_url(spreadsheet_id: &str) -> String {
    format!("https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}?fields=spreadsheetId")
}

fn sheets_create_spreadsheet_url() -> &'static str {
    "https://sheets.googleapis.com/v4/spreadsheets?fields=spreadsheetId"
}

fn google_state_file(state: &AppState) -> PathBuf {
    state.data_dir.join("google-sheets-state.json")
}

fn read_google_state(file: &Path) -> Result<GoogleSheetsState, String> {
    let raw = match std::fs::read_to_string(file) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(GoogleSheetsState::default());
        }
        Err(error) => return Err(format!("Google Sheets state file is not readable: {error}")),
    };
    serde_json::from_str(&raw).map_err(|_| "Google Sheets state file is not valid JSON".to_string())
}

fn write_google_state(file: &Path, state: &GoogleSheetsState) -> Result<(), String> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("create Google Sheets state directory: {error}"))?;
    }
    let name = file
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("google-sheets-state.json");
    let temp = file.with_file_name(format!("{name}.{}.tmp", uuid::Uuid::new_v4()));
    let json = serde_json::to_string_pretty(state)
        .map_err(|error| format!("serialize Google Sheets state: {error}"))?;
    std::fs::write(&temp, format!("{json}\n"))
        .map_err(|error| format!("write Google Sheets state: {error}"))?;
    std::fs::rename(&temp, file).map_err(|error| format!("replace Google Sheets state: {error}"))
}

async fn drive_folder_exists(
    client: &reqwest::Client,
    token: &str,
    folder_id: &str,
) -> Result<bool, String> {
    let response = client
        .get(drive_folder_url(folder_id))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| GOOGLE_REQUEST_FAILED.to_string())?;
    if response.status().as_u16() == 404 {
        return Ok(false);
    }
    let json = google_json_response(response).await?;
    Ok(json.get("mimeType").and_then(|value| value.as_str()) == Some(GOOGLE_DRIVE_FOLDER_MIME))
}

async fn drive_create_folder(
    client: &reqwest::Client,
    token: &str,
    name: &str,
) -> Result<String, String> {
    let response = client
        .post(drive_create_folder_url())
        .bearer_auth(token)
        .json(&serde_json::json!({
            "name": name,
            "mimeType": GOOGLE_DRIVE_FOLDER_MIME
        }))
        .send()
        .await
        .map_err(|_| GOOGLE_REQUEST_FAILED.to_string())?;
    let json = google_json_response(response).await?;
    json.get("id")
        .and_then(|value| value.as_str())
        .map(str::to_owned)
        .ok_or_else(|| GOOGLE_REQUEST_FAILED.to_string())
}

async fn drive_parents(
    client: &reqwest::Client,
    token: &str,
    file_id: &str,
) -> Result<Vec<String>, String> {
    let response = client
        .get(drive_parents_url(file_id))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| GOOGLE_REQUEST_FAILED.to_string())?;
    if response.status().as_u16() == 404 {
        return Ok(Vec::new());
    }
    let json = google_json_response(response).await?;
    Ok(json
        .get("parents")
        .and_then(|value| value.as_array())
        .map(|parents| {
            parents
                .iter()
                .filter_map(|value| value.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default())
}

/// Adds `folder_id` as a parent of `file_id` using `addParents`, which keeps
/// every existing parent intact (it never moves the file out of another
/// folder).
async fn drive_add_parent(
    client: &reqwest::Client,
    token: &str,
    file_id: &str,
    folder_id: &str,
) -> Result<(), String> {
    let response = client
        .patch(drive_add_parent_url(file_id, folder_id))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| GOOGLE_REQUEST_FAILED.to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(google_status_error(status).to_string());
    }
    Ok(())
}

async fn sheets_spreadsheet_exists(
    client: &reqwest::Client,
    token: &str,
    spreadsheet_id: &str,
) -> Result<bool, String> {
    let response = client
        .get(sheets_spreadsheet_url(spreadsheet_id))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| GOOGLE_REQUEST_FAILED.to_string())?;
    if response.status().as_u16() == 404 {
        return Ok(false);
    }
    google_json_response(response).await.map(|_| true)
}

async fn sheets_create_spreadsheet(
    client: &reqwest::Client,
    token: &str,
    title: &str,
) -> Result<String, String> {
    let response = client
        .post(sheets_create_spreadsheet_url())
        .bearer_auth(token)
        .json(&serde_json::json!({ "properties": { "title": title } }))
        .send()
        .await
        .map_err(|_| GOOGLE_REQUEST_FAILED.to_string())?;
    let json = google_json_response(response).await?;
    json.get("spreadsheetId")
        .and_then(|value| value.as_str())
        .map(str::to_owned)
        .ok_or_else(|| GOOGLE_REQUEST_FAILED.to_string())
}

async fn ensure_spreadsheet_in_folder(
    client: &reqwest::Client,
    token: &str,
    spreadsheet_id: &str,
    folder_id: &str,
) -> Result<(), String> {
    let parents = drive_parents(client, token, spreadsheet_id).await?;
    if !parents.iter().any(|parent| parent == folder_id) {
        drive_add_parent(client, token, spreadsheet_id, folder_id).await?;
    }
    Ok(())
}

/// Writes the managed header row when the tab's first row is blank. The
/// header values are the canonical `MANAGED_TABLES` camelCase labels used by
/// the rest of the sync pipeline.
async fn ensure_tab_header(
    client: &reqwest::Client,
    token: &str,
    spreadsheet_id: &str,
    table_name: &str,
) -> Result<(), String> {
    let read_range = format!("{table_name}!A1:Z1");
    let response = client
        .get(format!(
            "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{}",
            urlencoding::encode(&read_range)
        ))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| GOOGLE_REQUEST_FAILED.to_string())?;
    let existing = google_json_response(response).await?;
    let rows = existing
        .get("values")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let first_row_empty = rows.first().map_or(true, sheet_row_is_empty);
    if !first_row_empty {
        return Ok(());
    }
    let header_body = serde_json::json!({ "values": [sheet_headers(table_name)] });
    let response = client
        .put(format!(
            "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{}!A1?valueInputOption=RAW",
            urlencoding::encode(table_name)
        ))
        .bearer_auth(token)
        .json(&header_body)
        .send()
        .await
        .map_err(|_| GOOGLE_REQUEST_FAILED.to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(google_status_error(status).to_string());
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FolderResolution {
    UseConfigured,
    UsePersisted,
    Create,
    NotAccessible,
    None,
}

/// Pure decision logic for Drive folder resolution. The async resolver below
/// performs the existence probes and then dispatches on this result so the
/// stale-configured-folder replacement behavior can be unit tested.
fn resolve_folder_decision(
    configured: Option<&str>,
    persisted: Option<&str>,
    configured_exists: bool,
    persisted_exists: bool,
    create_if_missing: bool,
) -> FolderResolution {
    match configured {
        Some(configured_id) => {
            if configured_exists {
                return FolderResolution::UseConfigured;
            }
            if persisted.is_some_and(|id| id != configured_id) && persisted_exists {
                return FolderResolution::UsePersisted;
            }
            if create_if_missing {
                FolderResolution::Create
            } else {
                FolderResolution::NotAccessible
            }
        }
        None => {
            if persisted.is_some() && persisted_exists {
                FolderResolution::UsePersisted
            } else if create_if_missing {
                FolderResolution::Create
            } else {
                FolderResolution::None
            }
        }
    }
}

/// Whether Google provisioning has anything to resolve: an explicit/config
/// source, a create flag, or a previously persisted generated ID. This is
/// checked after the persisted state file is read so valid persisted IDs are
/// still reused when `google_create_folder_if_missing` is later disabled.
fn has_google_provisioning_source(
    explicit_spreadsheet: bool,
    configured_folder: bool,
    create_if_missing: bool,
    persisted: &GoogleSheetsState,
) -> bool {
    explicit_spreadsheet
        || configured_folder
        || create_if_missing
        || persisted
            .spreadsheet_id
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        || persisted
            .drive_folder_id
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
}

async fn resolve_drive_folder(
    client: &reqwest::Client,
    token: &str,
    state: &AppState,
    persisted: &mut GoogleSheetsState,
    file: &Path,
) -> Result<Option<String>, String> {
    let configured = state
        .lan
        .google_drive_folder_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let configured_exists = match configured {
        Some(folder_id) => drive_folder_exists(client, token, folder_id).await?,
        None => false,
    };

    let persisted_id = persisted
        .drive_folder_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    // Avoid a duplicate existence probe when the persisted ID is the same as
    // the configured ID; the configured probe already answered it.
    let persisted_exists = match persisted_id {
        Some(folder_id) if Some(folder_id) != configured => {
            drive_folder_exists(client, token, folder_id).await?
        }
        _ => false,
    };

    let decision = resolve_folder_decision(
        configured,
        persisted_id,
        configured_exists,
        persisted_exists,
        state.lan.google_create_folder_if_missing,
    );

    match decision {
        FolderResolution::UseConfigured => Ok(configured.map(str::to_owned)),
        FolderResolution::UsePersisted => Ok(persisted_id.map(str::to_owned)),
        FolderResolution::Create => {
            let created =
                drive_create_folder(client, token, state.lan.google_drive_folder_name.trim())
                    .await?;
            persisted.drive_folder_id = Some(created.clone());
            write_google_state(file, persisted)?;
            Ok(Some(created))
        }
        FolderResolution::NotAccessible => Err("GOOGLE_DRIVE_FOLDER_NOT_ACCESSIBLE".to_string()),
        FolderResolution::None => {
            persisted.drive_folder_id = None;
            Ok(None)
        }
    }
}

/// Resolves (and when permitted creates) the Drive folder + Sheets spreadsheet
/// used as the export target, then reconciles every managed tab's header,
/// freeze, and formatting. Returns `None` when Google export is not configured.
///
/// Explicit `google_spreadsheet_id` always wins and is never silently replaced:
/// a missing configured spreadsheet is an error rather than a trigger to
/// auto-create a new one.
pub async fn provision_google_sheets(
    state: &AppState,
) -> Result<Option<GoogleSheetsTarget>, String> {
    let Some(path) = state.lan.google_service_account_json_path.as_deref() else {
        return Ok(None);
    };

    let file = google_state_file(state);
    let mut persisted = read_google_state(&file)?;

    let has_explicit_spreadsheet = state
        .lan
        .google_spreadsheet_id
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());
    let has_folder = state
        .lan
        .google_drive_folder_id
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());
    if !has_google_provisioning_source(
        has_explicit_spreadsheet,
        has_folder,
        state.lan.google_create_folder_if_missing,
        &persisted,
    ) {
        return Ok(None);
    }

    let token = google_access_token(path).await?;
    let client = sheets_client();
    let folder_id = resolve_drive_folder(&client, &token, state, &mut persisted, &file).await?;

    let explicit_spreadsheet = state
        .lan
        .google_spreadsheet_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let mut spreadsheet_id = explicit_spreadsheet
        .clone()
        .or_else(|| persisted.spreadsheet_id.clone());

    if let Some(id) = spreadsheet_id.as_deref() {
        if sheets_spreadsheet_exists(&client, &token, id).await? {
            // Reuse the existing spreadsheet.
        } else if explicit_spreadsheet.is_some() {
            return Err("GOOGLE_CONFIGURED_SPREADSHEET_NOT_ACCESSIBLE".to_string());
        } else {
            spreadsheet_id = None;
            persisted.spreadsheet_id = None;
            write_google_state(&file, &persisted)?;
        }
    }

    if spreadsheet_id.is_none() {
        if folder_id.is_none() {
            return Err("GOOGLE_DRIVE_FOLDER_REQUIRED".to_string());
        }
        let created =
            sheets_create_spreadsheet(&client, &token, state.lan.google_spreadsheet_title.trim())
                .await?;
        persisted.spreadsheet_id = Some(created.clone());
        write_google_state(&file, &persisted)?;
        spreadsheet_id = Some(created);
    }

    let spreadsheet_id = spreadsheet_id.ok_or_else(|| GOOGLE_REQUEST_FAILED.to_string())?;
    if let Some(folder) = folder_id.as_deref() {
        ensure_spreadsheet_in_folder(&client, &token, &spreadsheet_id, folder).await?;
        persisted.drive_folder_id = Some(folder.to_string());
    }

    for table_name in MANAGED_TABLES {
        ensure_tab_exists(&client, &token, &spreadsheet_id, table_name)
            .await
            .map_err(|e| stage_err("reconcile tab", e))?;
        ensure_tab_header(&client, &token, &spreadsheet_id, table_name)
            .await
            .map_err(|e| stage_err("reconcile header", e))?;
        google_format_sheet_with_token(&client, &token, &spreadsheet_id, table_name)
            .await
            .map_err(|e| stage_err("reconcile format", e))?;
    }

    write_google_state(&file, &persisted)?;
    Ok(Some(GoogleSheetsTarget {
        spreadsheet_id,
        drive_folder_id: folder_id,
    }))
}

/// In-process provisioning cache: provisioning runs once per app session, then
/// the sync worker reuses the resolved spreadsheet/folder IDs.
async fn ensure_provisioned(state: &AppState) -> Result<Option<GoogleSheetsTarget>, String> {
    if let Some(target) = state.google_sheets_target.read().await.clone() {
        return Ok(Some(target));
    }
    let target = provision_google_sheets(state).await?;
    if target.is_some() {
        *state.google_sheets_target.write().await = target.clone();
    }
    Ok(target)
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
                let id = sheet.get("sheetId").and_then(|value| value.as_i64());
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
    let client = sheets_client();
    // Bounded reads: the header row plus the key column (row-anchored at
    // sheet row 1, so `find_existing_row_index` keeps working unchanged).
    // A full-tab fetch here would grow with every synced row; the key
    // column alone locates the row, and the full row is fetched only when
    // a merge-before-write is actually needed.
    let header_doc: serde_json::Value = google_stage_json(
        "append header read",
        client
            .get(format!(
                "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{}",
                urlencoding::encode(&header_read_range(table_name))
            ))
            .bearer_auth(&token)
            .send()
            .await,
    )
    .await?;
    let header_rows = header_doc
        .get("values")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let key_rows: Vec<serde_json::Value> = google_stage_json(
        "append key read",
        client
            .get(format!(
                "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{}",
                urlencoding::encode(&key_column_read_range(table_name, 0))
            ))
            .bearer_auth(&token)
            .send()
            .await,
    )
    .await?
    .get("values")
    .and_then(|value| value.as_array())
    .cloned()
    .unwrap_or_default();
    let headers = sheet_headers(table_name);
    let decision = header_repair_action(
        header_decision(
            &serde_json::json!({ "values": header_rows }),
            headers,
        ),
        key_column_has_data(&key_rows),
    );
    let decision = match decision {
        HeaderRepair::Proceed(outcome) => outcome,
        HeaderRepair::Rewrite => {
            put_header_row(&client, &token, spreadsheet_id, table_name).await?;
            HeaderDecision::Match
        }
        HeaderRepair::Mismatch => {
            return Err(stage_err(
                "append header",
                SHEETS_SCHEMA_MISMATCH_ERROR.to_string(),
            ))
        }
    };
    if decision == HeaderDecision::Initialize {
        put_header_row(&client, &token, spreadsheet_id, table_name).await?;
    }
    let row_index = find_existing_row_index(&key_rows, row_id).map_err(str::to_owned)?;
    let existing_cells: Option<Vec<serde_json::Value>> = match row_index {
        Some(index) => {
            let row_number = index + 1;
            let fetched: serde_json::Value = google_stage_json(
                "append row read",
                client
                    .get(format!(
                        "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{}",
                        urlencoding::encode(&single_row_read_range(
                            table_name,
                            row_number
                        ))
                    ))
                    .bearer_auth(&token)
                    .send()
                    .await,
            )
            .await?;
            fetched
                .get("values")
                .and_then(|value| value.as_array())
                .and_then(|rows| rows.first())
                .and_then(|row| row.as_array())
                .cloned()
        }
        None => None,
    };
    let row = serde_json::json!({"values":[project_row_values(table_name, row_id, payload, existing_cells.as_ref())]});

    if let Some(row_index) = row_index {
        let row_number = row_index + 1;
        let range = format!(
            "{}!A{}:{}{}",
            table_name,
            row_number,
            managed_last_column(table_name),
            row_number
        );
        google_stage_status("append row write", client.put(format!("https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{}?valueInputOption=RAW", urlencoding::encode(&range))).bearer_auth(token).json(&row).send().await).await
    } else {
        let range = format!("{}!A1", table_name);
        google_stage_status("append row insert", client.post(format!("https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS", urlencoding::encode(&range))).bearer_auth(token).json(&row).send().await).await
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
    let client = sheets_client();
    // Bounded reads (see `google_append_row`): header row plus the key
    // column only. Full rows are fetched solely to disambiguate duplicate
    // key matches, and then only across the matched span.
    let header_doc: serde_json::Value = google_stage_json(
        "delete header read",
        client
            .get(format!(
                "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{}",
                urlencoding::encode(&header_read_range(table_name))
            ))
            .bearer_auth(&token)
            .send()
            .await,
    )
    .await?;
    let header_rows = header_doc
        .get("values")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let key_col = key_column_index(table_name);
    let key_rows: Vec<serde_json::Value> = google_stage_json(
        "delete key read",
        client
            .get(format!(
                "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{}",
                urlencoding::encode(&key_column_read_range(table_name, key_col))
            ))
            .bearer_auth(&token)
            .send()
            .await,
    )
    .await?
    .get("values")
    .and_then(|value| value.as_array())
    .cloned()
    .unwrap_or_default();
    let headers = sheet_headers(table_name);
    let decision = match header_repair_action(
        header_decision(
            &serde_json::json!({ "values": header_rows }),
            headers,
        ),
        key_column_has_data(&key_rows),
    ) {
        HeaderRepair::Proceed(outcome) => outcome,
        HeaderRepair::Rewrite => {
            put_header_row(&client, &token, spreadsheet_id, table_name).await?;
            HeaderDecision::Match
        }
        HeaderRepair::Mismatch => {
            return Err(stage_err(
                "delete header",
                SHEETS_SCHEMA_MISMATCH_ERROR.to_string(),
            ))
        }
    };
    if decision == HeaderDecision::Initialize {
        put_header_row(&client, &token, spreadsheet_id, table_name).await?;
        return Ok(false);
    }
    // Key-column positions map 1:1 to sheet rows (range starts at row 1).
    let mut matches: Vec<usize> = key_rows
        .iter()
        .enumerate()
        .skip(1)
        .filter_map(|(index, row)| {
            row.as_array()
                .and_then(|cells| cells.first())
                .filter(|cell| cell_matches_row_id(cell, row_id))
                .map(|_| index + 1)
        })
        .collect();
    if matches.is_empty() {
        return Ok(false);
    }
    if matches.len() > 1 {
        // Disambiguate with full rows, fetched once from row 1 across the
        // matched span (values[0] is sheet row 1, so `find_rows_to_delete`
        // indices stay sheet-row aligned exactly as with full-tab reads).
        let hi = matches[matches.len() - 1];
        let span: Vec<serde_json::Value> = google_stage_json(
            "delete span read",
            client
                .get(format!(
                    "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{}",
                    urlencoding::encode(&format!(
                        "{}!A1:{}{}",
                        table_name,
                        managed_last_column(table_name),
                        hi
                    ))
                ))
                .bearer_auth(&token)
                .send()
                .await,
        )
        .await?
        .get("values")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
        matches = find_rows_to_delete(table_name, &span, row_id, payload)
            .map_err(|e| stage_err("delete match", e.to_owned()))?;
    }
    if matches.is_empty() {
        return Ok(false);
    }
    if matches.len() > 1 {
        return Err(stage_err(
            "delete match",
            SHEETS_ROW_ID_AMBIGUOUS_ERROR.to_string(),
        ));
    }
    let sheet_id = sheet_id_for_tab(&client, &token, spreadsheet_id, table_name)
        .await
        .map_err(|e| stage_err("delete tab id", e))?;
    let row_index = matches[0];
    google_stage_status(
        "delete rows",
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
            .await,
    )
    .await?;
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
    let client = sheets_client();
    google_format_sheet_with_token(&client, &token, spreadsheet_id, table_name).await
}

async fn google_format_sheet_with_token(
    client: &reqwest::Client,
    token: &str,
    spreadsheet_id: &str,
    table_name: &str,
) -> Result<(), String> {
    let headers = sheet_headers(table_name);
    let col_count = headers.len();

    let metadata: serde_json::Value = google_stage_json(
        "format metadata",
        client
            .get(format!(
                "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}?fields=sheets(sheetId,properties(sheetId,title,gridProperties(rowCount,frozenRowCount)),bandedRanges(bandedRangeId))"
            ))
            .bearer_auth(token)
            .send()
            .await,
    )
    .await?;
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
    // Frozen rows can never be deleted; the API rejects a deleteDimension
    // that would remove every non-frozen row, which is exactly what a
    // header-only tab produced before (400 on every pass, starving the
    // whole queue). Always leave at least one row below the data.
    let frozen_rows: i64 = sheet
        .get("properties")
        .and_then(|properties| properties.get("gridProperties"))
        .and_then(|grid| grid.get("frozenRowCount"))
        .and_then(|value| value.as_i64())
        .unwrap_or(1);

    let read_range = format!("{}!A:Z", table_name);
    let existing: serde_json::Value = google_stage_json(
        "format values",
        client
            .get(format!(
                "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{}",
                urlencoding::encode(&read_range)
            ))
            .bearer_auth(token)
            .send()
            .await,
    )
    .await?;
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
    if let Some((delete_start, delete_end)) =
        trailing_delete_range(last_data_row, frozen_rows, row_count)
    {
        requests.push(serde_json::json!({
            "deleteDimension": {
                "range": {
                    "sheetId": sheet_id,
                    "dimension": "ROWS",
                    "startIndex": delete_start,
                    "endIndex": delete_end
                }
            }
        }));
    }
    for chunk in requests.chunks(50) {
        google_stage_status(
            "format batch",
            client
                .post(format!(
                    "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}:batchUpdate"
                ))
                .bearer_auth(token)
                .json(&serde_json::json!({ "requests": chunk }))
                .send()
                .await,
        )
        .await?;
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
    let Some(target) = ensure_provisioned(state).await? else {
        return Err("GOOGLE_SHEETS_NOT_CONFIGURED".into());
    };
    let spreadsheet = target.spreadsheet_id;
    let path = state
        .lan
        .google_service_account_json_path
        .as_deref()
        .ok_or_else(|| "GOOGLE_SHEETS_NOT_CONFIGURED".to_string())?;
    let client = sheets_client();
    let token = google_access_token(path).await?;
    let mut cleared = 0usize;
    let mut queued = 0usize;
    for table_name in MANAGED_TABLES {
        ensure_tab_exists(&client, &token, &spreadsheet, table_name).await?;
        // T10 staging: load restorable payloads BEFORE wiping anything — a
        // load failure aborts before the remote clear, never after it.
        let rows = load_table_payloads(&state.db, table_name).await?;
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

/// Downgrades an ops-sheet provisioning failure to "not provisioned" so the
/// pass continues to the DTR section (which fetches its own token and never
/// touches the ops sheet). Ops rows then fail individually with clear codes
/// and backoff instead of freezing DTR behind one `?`.
fn downgrade_provision(
    result: Result<Option<GoogleSheetsTarget>, String>,
) -> Option<GoogleSheetsTarget> {
    match result {
        Ok(target) => target,
        Err(error) => {
            log::warn!("ops sheets provisioning unavailable, DTR continues: {error}");
            None
        }
    }
}

/// Whether a sync pass should proceed to row dispatch. DTR runs even when
/// the ops sheet failed to provision: only "everything absent" means off.
fn should_dispatch(endpoint_none: bool, ops_ready: bool, dtr_ready: bool) -> bool {
    !(endpoint_none && !ops_ready && !dtr_ready)
}

/// Bounded SQLite-first queue worker. The configured exporter endpoint is intentionally
/// optional; when absent rows remain pending instead of being discarded.
pub async fn run_once(state: &AppState, endpoint: Option<&str>) -> Result<u64, String> {
    let now_at = Utc::now();
    recover_stale_processing_leases(state, now_at).await?;
    let google_target = if endpoint.is_none() {
        downgrade_provision(ensure_provisioned(state).await)
    } else {
        None
    };
    // Intern-DTR auto-push targets its own human spreadsheet and runs
    // even when the ops sheet is unprovisioned (or ops mirror via LAN
    // endpoint). The resolver hard-wires the production sheet by default;
    // only an explicitly blank `ALPHA_PREMIER_DTR_SHEET_ID` switches off.
    let dtr_sheet = crate::config::dtr_spreadsheet_id_resolved(&state.lan);
    log::debug!(
        "sync tick: endpoint_none={} ops_target={} dtr={}",
        endpoint.is_none(),
        google_target.is_some(),
        dtr_sheet.as_deref().unwrap_or("<none>")
    );
    if !should_dispatch(endpoint.is_none(), google_target.is_some(), dtr_sheet.is_some()) {
        return Ok(0);
    }
    // New-intern recheck: interns whose DTR tab did not exist yet are
    // tracked in `dtr_pending`; re-search titles and backfill history once
    // the owner creates the tab. Log-only — must never break the loop.
    // One token fetch per run at most, and only when pending rows exist.
    if let (Some(path), Some(sheet)) = (
        state.lan.google_service_account_json_path.as_deref(),
        dtr_sheet.as_deref(),
    ) {
        let pending_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM dtr_pending")
                .fetch_one(&state.db)
                .await
                .unwrap_or(0);
        if pending_count > 0 {
            match google_access_token(path).await {
                Ok(token) => {
                    let client = sheets_client();
                    if let Err(error) =
                        crate::services::dtr_sync::process_dtr_pending(state, &client, &token, sheet)
                            .await
                    {
                        eprintln!("[sheets] dtr pending recheck failed: {error}");
                    }
                }
                Err(error) => {
                    eprintln!("[sheets] dtr pending recheck skipped: {error}");
                }
            }
        }
    }

    let now = now_at.to_rfc3339();
    let rows = sqlx::query("SELECT id, table_name, row_id, operation, payload_json, attempts FROM sync_queue WHERE status IN ('PENDING','RETRY') AND next_attempt_at <= ? ORDER BY id LIMIT ?")
        .bind(&now).bind(SYNC_BATCH_SIZE).fetch_all(&state.db).await.map_err(|e| e.to_string())?;
    log::debug!("sync tick: rows_due={}", rows.len());
    if rows.is_empty() {
        return Ok(0);
    }

    let google_mode = endpoint.is_none();
    let google_path = state.lan.google_service_account_json_path.as_deref();
    let spreadsheet_id = google_target
        .as_ref()
        .map(|target| target.spreadsheet_id.as_str());

    if google_mode {
        if let (Some(path), Some(spreadsheet)) = (google_path, spreadsheet_id) {
            let client = sheets_client();
            // A failed pre-check must not abort the pass (same starvation
            // class as provisioning): rows fail individually with backoff.
            match google_access_token(path).await {
                Ok(token) => {
                    let mut tables: Vec<String> = Vec::new();
                    for row in &rows {
                        let table: String = row.get("table_name");
                        if !tables.contains(&table) {
                            tables.push(table);
                        }
                    }
                    for table in tables {
                        // InternDtr rows target the human DTR spreadsheet, handled
                        // below — never create/format tabs for it in the ops sheet.
                        if table == crate::services::dtr_sync::DTR_TABLE_NAME {
                            continue;
                        }
                        ensure_tab_exists(&client, &token, spreadsheet, &table).await?;
                    }
                }
                Err(error) => log::warn!("ops tab pre-check skipped, rows fail individually: {error}"),
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
            if table_name == crate::services::dtr_sync::DTR_TABLE_NAME {
                if is_delete {
                    // The human DTR sheet is operator-owned: rows are only
                    // ever upserted, never deleted.
                    Ok(false)
                } else {
                    match (google_path, dtr_sheet.as_deref()) {
                        (Some(path), Some(sheet)) => {
                            let client = sheets_client();
                            match google_access_token(path).await {
                                Ok(token) => {
                                    crate::services::dtr_sync::push_dtr_row(
                                        state, &client, &token, sheet, payload,
                                    )
                                    .await
                                    .map(|_| false)
                                }
                                Err(error) => Err(error),
                            }
                        }
                        _ => Err("DTR sync is not configured".to_string()),
                    }
                }
            } else if let Some(url) = endpoint {
                sheets_client()
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
                let is_schema_mismatch = error.contains(SHEETS_SCHEMA_MISMATCH_ERROR);
                let next = Utc::now()
                    + Duration::from_secs(2_u64.saturating_pow((attempts as u32).min(5)));
                let status = if attempts + 1 >= 5 { "DEAD" } else { "RETRY" };
                // Store the actual error text (call-site stage + upstream
                // status) instead of collapsing everything to generic: the
                // code field keeps the stable GOOGLE_SYNC_FAILED contract.
                let last_error = error;
                sqlx::query("UPDATE sync_queue SET attempts=attempts+1, status=?, last_error=?, last_error_code='GOOGLE_SYNC_FAILED', locked_at=NULL, next_attempt_at=?, updated_at=? WHERE id=? AND status='PROCESSING'").bind(status).bind(last_error).bind(next.to_rfc3339()).bind(&now).bind(id).execute(&state.db).await.map_err(|e| e.to_string())?;
                schema_mismatch |= is_schema_mismatch;
            }
        }
    }
    if google_mode && !touched.is_empty() {
        if let (Some(path), Some(spreadsheet)) = (google_path, spreadsheet_id) {
            for table in touched {
                if table == crate::services::dtr_sync::DTR_TABLE_NAME {
                    continue;
                }
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
            format_payload_value(
                CellKind::Date,
                "attendanceDate",
                &json!("2026-08-01T00:00:00+08:00")
            ),
            json!("2026-08-01")
        );
        assert_eq!(
            format_payload_value(
                CellKind::Time,
                "timeIn",
                &json!("2026-08-01T08:30:00+08:00")
            ),
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
            json!([
                "g-1",
                "user-a",
                "2026-08-03",
                "att-1",
                "2026-08-03T08:00:00Z"
            ]),
            json!([
                "g-2",
                "user-a",
                "2026-08-10",
                "att-2",
                "2026-08-10T08:00:00Z"
            ]),
        ];
        let matches =
            find_rows_to_delete("InternGrace", &rows, "user-a", &json!({"userId":"user-a"}))
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
        let rows = vec![
            json!(sheet_headers("Users")),
            json!(["u-1", "RFID-1", "Ada"]),
        ];
        let matches =
            find_rows_to_delete("Users", &rows, "u-missing", &json!({"userId":"u-missing"}))
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

    #[test]
    fn provisioning_source_includes_persisted_ids_when_create_flag_is_off() {
        assert!(!has_google_provisioning_source(
            false,
            false,
            false,
            &GoogleSheetsState::default()
        ));

        let persisted_folder = GoogleSheetsState {
            drive_folder_id: Some("folder-persisted".into()),
            ..GoogleSheetsState::default()
        };
        assert!(has_google_provisioning_source(
            false,
            false,
            false,
            &persisted_folder
        ));

        let persisted_sheet = GoogleSheetsState {
            spreadsheet_id: Some("sheet-persisted".into()),
            ..GoogleSheetsState::default()
        };
        assert!(has_google_provisioning_source(
            false,
            false,
            false,
            &persisted_sheet
        ));

        assert!(has_google_provisioning_source(
            false,
            false,
            true,
            &GoogleSheetsState::default()
        ));
        assert!(has_google_provisioning_source(
            true,
            false,
            false,
            &GoogleSheetsState::default()
        ));
        assert!(has_google_provisioning_source(
            false,
            true,
            false,
            &GoogleSheetsState::default()
        ));
    }

    #[test]
    fn folder_resolution_prefers_persisted_replacement_for_stale_config() {
        assert_eq!(
            resolve_folder_decision(
                Some("configured-stale"),
                Some("replacement"),
                false,
                true,
                true,
            ),
            FolderResolution::UsePersisted
        );
        assert_eq!(
            resolve_folder_decision(Some("configured-stale"), None, false, false, true),
            FolderResolution::Create
        );
        assert_eq!(
            resolve_folder_decision(
                Some("configured-stale"),
                Some("replacement"),
                false,
                false,
                false,
            ),
            FolderResolution::NotAccessible
        );
        assert_eq!(
            resolve_folder_decision(Some("configured"), Some("replacement"), true, true, false,),
            FolderResolution::UseConfigured
        );
        // A persisted ID equal to the stale configured ID is not a replacement;
        // with creation enabled a fresh folder is created instead.
        assert_eq!(
            resolve_folder_decision(Some("same-id"), Some("same-id"), false, false, true),
            FolderResolution::Create
        );
    }

    #[test]
    fn folder_resolution_without_config_reuses_or_creates_persisted_folder() {
        assert_eq!(
            resolve_folder_decision(None, Some("persisted"), false, true, false),
            FolderResolution::UsePersisted
        );
        assert_eq!(
            resolve_folder_decision(None, Some("stale"), false, false, true),
            FolderResolution::Create
        );
        assert_eq!(
            resolve_folder_decision(None, None, false, false, false),
            FolderResolution::None
        );
    }

    #[test]
    fn google_state_roundtrip_preserves_persisted_ids() {
        let dir = std::env::temp_dir().join(format!("alpha-gsheets-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("google-sheets-state.json");
        let state = GoogleSheetsState {
            version: 1,
            drive_folder_id: Some("folder-123".into()),
            spreadsheet_id: Some("sheet-456".into()),
        };
        write_google_state(&file, &state).unwrap();
        let persisted = read_google_state(&file).unwrap();
        assert_eq!(persisted.drive_folder_id.as_deref(), Some("folder-123"));
        assert_eq!(persisted.spreadsheet_id.as_deref(), Some("sheet-456"));

        let missing = dir.join("missing.json");
        let default = read_google_state(&missing).unwrap();
        assert_eq!(default.drive_folder_id, None);
        assert_eq!(default.spreadsheet_id, None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sheets_client_carries_explicit_timeout() {
        // The sync tick is 30s: no Google call may hang past 25s total.
        assert_eq!(SHEETS_HTTP_TIMEOUT_SECS, 25);
        // Builder must succeed; Debug must show the configured timeout.
        let debug = format!("{:?}", sheets_client());
        assert!(
            debug.contains("25s"),
            "client must carry a 25s timeout, debug was: {debug}"
        );
    }

    #[test]
    fn downgrade_provision_neutralizes_errors_but_keeps_targets() {
        let target = GoogleSheetsTarget {
            spreadsheet_id: "sheet-1".into(),
            drive_folder_id: None,
        };
        assert_eq!(
            downgrade_provision(Ok(Some(target.clone()))),
            Some(target)
        );
        assert_eq!(downgrade_provision(Ok(None)), None);
        // A provisioning blow-up becomes "not provisioned" (warned) so the
        // DTR section still runs instead of aborting the whole pass.
        assert_eq!(
            downgrade_provision(Err("GOOGLE_REQUEST_FAILED".to_string())),
            None
        );
    }

    #[test]
    fn should_dispatch_runs_dtr_without_ops() {
        // LAN-endpoint mode always dispatches (rows POST to the endpoint).
        assert!(should_dispatch(false, false, false));
        assert!(should_dispatch(false, true, false));
        assert!(should_dispatch(false, false, true));
        // Google mode with nothing configured: off (feature disabled).
        assert!(!should_dispatch(true, false, false));
        // Google mode with only DTR configured: dispatch (the decoupling).
        assert!(should_dispatch(true, false, true));
        assert!(should_dispatch(true, true, false));
        assert!(should_dispatch(true, true, true));
    }

    #[test]
    fn column_letter_covers_single_and_multi_letter_columns() {
        assert_eq!(column_letter(0), "A");
        assert_eq!(column_letter(9), "J");
        assert_eq!(column_letter(25), "Z");
        assert_eq!(column_letter(26), "AA");
        assert_eq!(column_letter(27), "AB");
        assert_eq!(column_letter(51), "AZ");
        assert_eq!(column_letter(52), "BA");
        assert_eq!(column_letter(701), "ZZ");
        assert_eq!(column_letter(702), "AAA");
        assert_eq!(managed_last_column("Users"), "J");
        assert_eq!(managed_last_column("PayrollCutoffs"), "R");
    }

    #[test]
    fn bounded_read_ranges_stay_row_anchored() {
        assert_eq!(header_read_range("Attendance"), "Attendance!A1:M1");
        // Key column includes row 1 so matcher indices equal sheet rows.
        assert_eq!(key_column_read_range("Attendance", 0), "Attendance!A1:A");
        assert_eq!(key_column_read_range("InternGrace", 1), "InternGrace!B1:B");
        assert_eq!(
            single_row_read_range("Attendance", 107),
            "Attendance!A107:M107"
        );
        // Single-column fixtures map index-for-index to sheet rows;
        // leading blanks are preserved, only trailing empties trim.
        let key_rows = vec![
            json!(["attendanceId"]),
            json!(["u-1"]),
            json!([]),
            json!(["u-3"]),
        ];
        assert_eq!(find_existing_row_index(&key_rows, "u-3").unwrap(), Some(3));
        assert_eq!(find_existing_row_index(&key_rows, "missing").unwrap(), None);
        // The header cell itself never matches.
        assert_eq!(
            find_existing_row_index(&key_rows, "attendanceId").unwrap(),
            None
        );
    }

    #[test]
    fn key_column_data_gate_detects_data_rows() {
        assert!(!key_column_has_data(&[]));
        assert!(!key_column_has_data(&[json!(["userId"])]));
        assert!(!key_column_has_data(&[json!(["userId"]), json!([])]));
        assert!(key_column_has_data(&[json!(["userId"]), json!(["u-1"])]));
    }

    #[test]
    fn header_repair_rewrites_only_empty_legacy_tabs() {
        let headers = sheet_headers("Users");
        let matching = header_decision(&json!({ "values": [headers] }), headers);
        assert_eq!(
            header_repair_action(matching, false),
            HeaderRepair::Proceed(HeaderDecision::Match)
        );
        let blank = header_decision(&json!({ "values": [] }), headers);
        assert_eq!(
            header_repair_action(blank, false),
            HeaderRepair::Proceed(HeaderDecision::Initialize)
        );
        // Legacy snake_case header, zero data rows: safe to rewrite.
        let legacy = header_decision(
            &json!({ "values": [["user_id", "rfid_uid", "full_name", "department", "status", "created_at", "employee_type", "daily_rate", "photo_url", "payroll_profile_id"]] }),
            headers,
        );
        assert_eq!(header_repair_action(legacy, false), HeaderRepair::Rewrite);
        // Same legacy header WITH data rows: never reinterpret columns.
        assert_eq!(
            header_repair_action(
                header_decision(
                    &json!({ "values": [["user_id"], ["u-1"]] }),
                    headers,
                ),
                true,
            ),
            HeaderRepair::Mismatch
        );
    }

    #[test]
    fn trailing_delete_never_removes_all_non_frozen_rows() {
        // Header-only tab (the live 400): keep exactly one blank data row.
        assert_eq!(trailing_delete_range(0, 1, 1000), Some((2, 1000)));
        // Full tab: nothing to trim.
        assert_eq!(trailing_delete_range(999, 1, 1000), None);
        // No trailing blanks: nothing to trim.
        assert_eq!(trailing_delete_range(5, 1, 6), None);
        // Unfrozen sheet: still leaves a single row standing.
        assert_eq!(trailing_delete_range(0, 0, 1000), Some((1, 1000)));
        // Deeper freeze: deletion starts below it.
        assert_eq!(trailing_delete_range(3, 2, 100), Some((4, 100)));
    }

    #[test]
    fn stage_errors_carry_call_site_without_secrets() {
        let err = stage_err("append read", SHEETS_REQUEST_FAILED_ERROR.to_string());
        assert_eq!(err, "append read: Google Sheets sync failed");
        // The schema-mismatch contract survives prefixing (run_once keys
        // off substring match).
        let mismatch = stage_err("delete header", SHEETS_SCHEMA_MISMATCH_ERROR.to_string());
        assert!(mismatch.contains(SHEETS_SCHEMA_MISMATCH_ERROR));
        assert!(mismatch.starts_with("delete header: "));
    }
}
