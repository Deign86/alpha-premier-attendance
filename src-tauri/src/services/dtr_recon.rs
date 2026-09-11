//! Friday DTR Reconciliation service & scheduler.
//!
//! Reconciles attendance records in SQLite against the human INTERN DTR Google Sheets
//! for the open payroll cutoff. Default mode is report-only (dry-run).
//!
//! Schedule:
//! - Friday >= 12:00 PM (Asia/Manila).
//! - Once-per-week run marker persisted in `dtr_recon_state` key `last_recon_week` (format `YYYY-Www`).
//! - Catch-up: if Friday 12:00 Manila passed or boot occurs and `last_recon_week` has not run for
//!   the current week, run during office hours (Mon-Fri 08:00-18:00 Manila).
//!
//! Open cutoff scoping:
//! - Look up `SELECT MAX(cutoff_end) FROM payroll_cutoffs WHERE status = 'FINALIZED'`.
//! - If none, use semi-monthly cutoff start (1st of month if day <= 15, else 16th).
//! - Cutoff end is today.

use crate::services::dtr_sync::{
    build_dtr_row, classify_record_row, execute_format_ops, fetch_tab_meta, parse_sheet_date,
    plan_row_format, resolve_user_tab, DtrCellColor, DtrFormatOp,
};
use crate::services::sheets_sync::{google_access_token, sheets_client};
use crate::state::AppState;
use chrono::{Datelike, NaiveDate, Timelike, Weekday};
use chrono_tz::Asia::Manila;
use sqlx::Row;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

static BOOT_CHECKED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ReconAction {
    InSync,
    Corrected,
    Reported,
    Cleared,
    Failed,
    Unresolvable,
}

impl ReconAction {
    pub fn as_str(&self) -> &'static str {
        match self {
            ReconAction::InSync => "IN_SYNC",
            ReconAction::Corrected => "CORRECTED",
            ReconAction::Reported => "REPORTED",
            ReconAction::Cleared => "CLEARED",
            ReconAction::Failed => "FAILED",
            ReconAction::Unresolvable => "UNRESOLVABLE",
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ReconDiscrepancy {
    pub user_id: String,
    pub full_name: String,
    pub attendance_date: String,
    pub sheet_b: Option<String>,
    pub sheet_c: Option<String>,
    pub sheet_d: Option<String>,
    pub sheet_e: Option<String>,
    pub db_time_in: Option<String>,
    pub db_time_out: Option<String>,
    pub action_taken: ReconAction,
    pub error_message: Option<String>,
}

#[derive(Debug, Default)]
pub struct InternReconResult {
    pub discrepancies: Vec<ReconDiscrepancy>,
    pub writes: Vec<(usize, [String; 4])>,
    pub format_ops: Vec<DtrFormatOp>,
}

/// Format current Manila datetime into ISO week string `YYYY-Www` (e.g. `2026-W37`).
pub fn format_recon_week(dt: &chrono::DateTime<chrono_tz::Tz>) -> String {
    dt.format("%G-W%V").to_string()
}

/// Check if datetime falls into Manila office hours: Mon-Fri 08:00-18:00.
pub fn is_manila_office_hours(dt: &chrono::DateTime<chrono_tz::Tz>) -> bool {
    let weekday = dt.weekday();
    let is_workday = matches!(
        weekday,
        Weekday::Mon | Weekday::Tue | Weekday::Wed | Weekday::Thu | Weekday::Fri
    );
    let hour = dt.hour();
    is_workday && (8..18).contains(&hour)
}

/// Check if datetime is Friday >= 12:00 PM Manila.
pub fn is_friday_after_noon(dt: &chrono::DateTime<chrono_tz::Tz>) -> bool {
    dt.weekday() == Weekday::Fri && dt.hour() >= 12
}

/// Determine whether scheduled reconciliation should run.
pub fn should_run_recon_scheduled(
    now_manila: &chrono::DateTime<chrono_tz::Tz>,
    last_recon_week: Option<&str>,
    is_boot: bool,
) -> bool {
    if !is_manila_office_hours(now_manila) {
        return false;
    }
    let current_week = format_recon_week(now_manila);
    if last_recon_week == Some(current_week.as_str()) {
        return false;
    }
    is_friday_after_noon(now_manila) || is_boot
}

/// Calculate the open cutoff horizon:
/// - If finalized cutoffs exist, start is day after max finalized cutoff_end.
/// - If none, semi-monthly cutoff start (1st if day <= 15, else 16th).
/// - End is today.
pub fn determine_open_cutoff(
    max_finalized_end: Option<&str>,
    today: NaiveDate,
) -> Result<(NaiveDate, NaiveDate), String> {
    let cutoff_start = if let Some(end_str) = max_finalized_end.filter(|s| !s.trim().is_empty()) {
        let max_end = NaiveDate::parse_from_str(end_str.trim(), "%Y-%m-%d")
            .map_err(|e| format!("invalid finalized cutoff_end '{end_str}': {e}"))?;
        max_end.succ_opt().unwrap_or(max_end)
    } else {
        let day = today.day();
        if day <= 15 {
            today
                .with_day(1)
                .ok_or_else(|| "invalid 1st of month".to_string())?
        } else {
            today
                .with_day(16)
                .ok_or_else(|| "invalid 16th of month".to_string())?
        }
    };
    Ok((cutoff_start, today))
}

/// Pure tab reconciliation logic. Compares sheet A:F rows against DB attendance records
/// within the open cutoff range `[cutoff_start, cutoff_end]`.
pub fn reconcile_intern_tab(
    user_id: &str,
    full_name: &str,
    sheet_id: i64,
    rows: &[Vec<String>],
    db_attendance: &HashMap<String, (Option<String>, Option<String>)>,
    cutoff_start: NaiveDate,
    cutoff_end: NaiveDate,
    report_only: bool,
) -> InternReconResult {
    let mut result = InternReconResult::default();
    let mut visited_sheet_dates = HashSet::new();

    for (idx, row) in rows.iter().enumerate() {
        let cell = row.first().map(String::as_str).unwrap_or("");
        let Some(parts) = parse_sheet_date(cell) else {
            continue;
        };
        let Some(date) = NaiveDate::from_ymd_opt(parts.y, parts.m, parts.d) else {
            continue;
        };
        if date < cutoff_start || date > cutoff_end {
            continue;
        }

        let date_str = date.format("%Y-%m-%d").to_string();
        visited_sheet_dates.insert(date_str.clone());

        let sheet_b = row.get(1).cloned().unwrap_or_default();
        let sheet_c = row.get(2).cloned().unwrap_or_default();
        let sheet_d = row.get(3).cloned().unwrap_or_default();
        let sheet_e = row.get(4).cloned().unwrap_or_default();
        let sheet_values = [
            sheet_b.clone(),
            sheet_c.clone(),
            sheet_d.clone(),
            sheet_e.clone(),
        ];

        if let Some((db_in, db_out)) = db_attendance.get(&date_str) {
            match build_dtr_row(db_in.as_deref(), db_out.as_deref(), &date_str) {
                Ok(expected) => {
                    if sheet_values != expected {
                        let action = if report_only {
                            ReconAction::Reported
                        } else {
                            result.writes.push((idx + 1, expected));
                            if let Ok(kind) =
                                classify_record_row(db_in.as_deref(), db_out.as_deref())
                            {
                                result.format_ops.extend(plan_row_format(
                                    sheet_id,
                                    idx + 1,
                                    kind,
                                ));
                            }
                            ReconAction::Corrected
                        };
                        result.discrepancies.push(ReconDiscrepancy {
                            user_id: user_id.to_string(),
                            full_name: full_name.to_string(),
                            attendance_date: date_str,
                            sheet_b: Some(sheet_b),
                            sheet_c: Some(sheet_c),
                            sheet_d: Some(sheet_d),
                            sheet_e: Some(sheet_e),
                            db_time_in: db_in.clone(),
                            db_time_out: db_out.clone(),
                            action_taken: action,
                            error_message: None,
                        });
                    }
                }
                Err(err) => {
                    result.discrepancies.push(ReconDiscrepancy {
                        user_id: user_id.to_string(),
                        full_name: full_name.to_string(),
                        attendance_date: date_str,
                        sheet_b: Some(sheet_b),
                        sheet_c: Some(sheet_c),
                        sheet_d: Some(sheet_d),
                        sheet_e: Some(sheet_e),
                        db_time_in: db_in.clone(),
                        db_time_out: db_out.clone(),
                        action_taken: ReconAction::Failed,
                        error_message: Some(err),
                    });
                }
            }
        } else {
            // No DB record for this date
            let has_values = sheet_values.iter().any(|v| !v.trim().is_empty());
            if has_values {
                let action = if report_only {
                    ReconAction::Reported
                } else {
                    result.writes.push((
                        idx + 1,
                        [
                            String::new(),
                            String::new(),
                            String::new(),
                            String::new(),
                        ],
                    ));
                    result.format_ops.push(DtrFormatOp {
                        sheet_id,
                        start_row_1based: idx + 1,
                        end_row_1based_excl: idx + 2,
                        start_col_0: 1,
                        end_col_0_excl: 5,
                        color: DtrCellColor::White,
                    });
                    ReconAction::Cleared
                };
                result.discrepancies.push(ReconDiscrepancy {
                    user_id: user_id.to_string(),
                    full_name: full_name.to_string(),
                    attendance_date: date_str,
                    sheet_b: Some(sheet_b),
                    sheet_c: Some(sheet_c),
                    sheet_d: Some(sheet_d),
                    sheet_e: Some(sheet_e),
                    db_time_in: None,
                    db_time_out: None,
                    action_taken: action,
                    error_message: None,
                });
            }
        }
    }

    // Check for DB dates missing entirely from sheet rows
    for (db_date, (db_in, db_out)) in db_attendance {
        if let Ok(parsed_db_date) = NaiveDate::parse_from_str(db_date, "%Y-%m-%d") {
            if parsed_db_date >= cutoff_start
                && parsed_db_date <= cutoff_end
                && !visited_sheet_dates.contains(db_date)
            {
                result.discrepancies.push(ReconDiscrepancy {
                    user_id: user_id.to_string(),
                    full_name: full_name.to_string(),
                    attendance_date: db_date.clone(),
                    sheet_b: None,
                    sheet_c: None,
                    sheet_d: None,
                    sheet_e: None,
                    db_time_in: db_in.clone(),
                    db_time_out: db_out.clone(),
                    action_taken: ReconAction::Unresolvable,
                    error_message: Some("Date row not found in DTR sheet".to_string()),
                });
            }
        }
    }

    result
}

fn quote_tab_name(tab: &str) -> String {
    format!("'{}'", tab.replace('\'', "''"))
}

fn rows_from_values(value: &serde_json::Value) -> Vec<Vec<String>> {
    value
        .get("values")
        .and_then(|v| v.as_array())
        .map(|rows| {
            rows.iter()
                .map(|row| {
                    row.as_array()
                        .map(|cells| {
                            cells
                                .iter()
                                .map(|c| {
                                    if let Some(s) = c.as_str() {
                                        s.to_string()
                                    } else if let Some(n) = c.as_f64() {
                                        if n.fract() == 0.0 {
                                            // SAFETY: fract() == 0.0 ensures value is representable as integer.
                                            format!("{}", n as i64)
                                        } else {
                                            n.to_string()
                                        }
                                    } else {
                                        String::new()
                                    }
                                })
                                .collect()
                        })
                        .unwrap_or_default()
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Entry point 1: Periodic or boot check for scheduled reconciliation.
pub async fn check_and_run_scheduled(state: &AppState) -> Result<Option<String>, String> {
    let now_manila = chrono::Utc::now().with_timezone(&Manila);
    let is_boot = !BOOT_CHECKED.swap(true, Ordering::SeqCst);

    let last_recon_week: Option<String> =
        sqlx::query_scalar("SELECT value FROM dtr_recon_state WHERE key = 'last_recon_week'")
            .fetch_optional(&state.db)
            .await
            .map_err(|e| e.to_string())?;

    if should_run_recon_scheduled(&now_manila, last_recon_week.as_deref(), is_boot) {
        log::info!(
            "DTR reconciliation scheduled run triggered (is_boot={is_boot}, week={})",
            format_recon_week(&now_manila)
        );
        let run_id = run_reconciliation(state, true).await?;
        Ok(Some(run_id))
    } else {
        Ok(None)
    }
}

/// Entry point 2: Execute DTR reconciliation.
pub async fn run_reconciliation(state: &AppState, report_only: bool) -> Result<String, String> {
    let run_id = format!("recon-{}", uuid::Uuid::new_v4());
    let started_at = chrono::Utc::now().to_rfc3339();
    let report_only_int = if report_only { 1 } else { 0 };

    sqlx::query(
        "INSERT INTO dtr_recon_runs (run_id, started_at, status, report_only, summary_json) VALUES (?, ?, 'RUNNING', ?, '{}')",
    )
    .bind(&run_id)
    .bind(&started_at)
    .bind(report_only_int)
    .execute(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    let now_manila = chrono::Utc::now().with_timezone(&Manila);
    let today = now_manila.date_naive();
    let current_week = format_recon_week(&now_manila);

    // Open cutoff determination
    let max_finalized_end: Option<String> =
        sqlx::query_scalar("SELECT MAX(cutoff_end) FROM payroll_cutoffs WHERE status = 'FINALIZED'")
            .fetch_one(&state.db)
            .await
            .unwrap_or(None);

    let (cutoff_start, cutoff_end) = match determine_open_cutoff(max_finalized_end.as_deref(), today) {
        Ok(bounds) => bounds,
        Err(err) => {
            record_run_failure(state, &run_id, &err).await?;
            return Err(err);
        }
    };

    let google_path = state.lan.google_service_account_json_path.as_deref();
    let dtr_sheet = crate::config::dtr_spreadsheet_id_resolved(&state.lan);

    let (token, spreadsheet_id) = match (google_path, dtr_sheet.as_deref()) {
        (Some(path), Some(sheet)) => match google_access_token(path).await {
            Ok(tok) => (tok, sheet.to_string()),
            Err(e) => {
                let msg = format!("Google access token failed: {e}");
                record_run_failure(state, &run_id, &msg).await?;
                return Err(msg);
            }
        },
        _ => {
            let msg = "Google Sheets service account or DTR sheet ID is not configured".to_string();
            record_run_failure(state, &run_id, &msg).await?;
            return Err(msg);
        }
    };

    let client = sheets_client();

    // Roster query: active interns
    let interns = sqlx::query("SELECT user_id, full_name FROM users WHERE status = 'ACTIVE' AND employee_type = 'INTERN' ORDER BY full_name")
        .fetch_all(&state.db)
        .await
        .map_err(|e| e.to_string())?;

    let all_users: Vec<(String, String)> = sqlx::query("SELECT user_id, full_name FROM users WHERE status = 'ACTIVE'")
        .fetch_all(&state.db)
        .await
        .map_err(|e| e.to_string())?
        .iter()
        .map(|r| (r.get("user_id"), r.get("full_name")))
        .collect();

    // Single tab meta fetch for spreadsheet
    let meta = match fetch_tab_meta(&client, &token, &spreadsheet_id).await {
        Ok(m) => m,
        Err(e) => {
            let msg = format!("Failed to fetch tab metadata: {e}");
            record_run_failure(state, &run_id, &msg).await?;
            return Err(msg);
        }
    };
    let titles: Vec<String> = meta.iter().map(|m| m.title.clone()).collect();

    let mut all_discrepancies: Vec<ReconDiscrepancy> = Vec::new();
    let start_str = cutoff_start.format("%Y-%m-%d").to_string();
    let end_str = cutoff_end.format("%Y-%m-%d").to_string();

    let total_interns = interns.len();

    for (i, intern) in interns.iter().enumerate() {
        let user_id: String = intern.get("user_id");
        let full_name: String = intern.get("full_name");

        if i > 0 {
            tokio::time::sleep(Duration::from_millis(1000)).await;
        }

        let Some(tab) = resolve_user_tab(&titles, &user_id, &full_name, &all_users) else {
            all_discrepancies.push(ReconDiscrepancy {
                user_id,
                full_name,
                attendance_date: end_str.clone(),
                sheet_b: None,
                sheet_c: None,
                sheet_d: None,
                sheet_e: None,
                db_time_in: None,
                db_time_out: None,
                action_taken: ReconAction::Unresolvable,
                error_message: Some("No matching DTR tab found in spreadsheet".to_string()),
            });
            continue;
        };

        let Some(sheet_id) = meta.iter().find(|m| m.title == tab).map(|m| m.sheet_id) else {
            all_discrepancies.push(ReconDiscrepancy {
                user_id,
                full_name,
                attendance_date: end_str.clone(),
                sheet_b: None,
                sheet_c: None,
                sheet_d: None,
                sheet_e: None,
                db_time_in: None,
                db_time_out: None,
                action_taken: ReconAction::Failed,
                error_message: Some("Tab sheetId missing".to_string()),
            });
            continue;
        };

        // Amortized read: one values.get A:F per intern tab
        let range = urlencoding::encode(&format!("{}!A:F", quote_tab_name(&tab))).into_owned();
        let tab_url = format!("https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{range}");
        let tab_resp = client.get(&tab_url).bearer_auth(&token).send().await;
        let tab_values = match tab_resp {
            Ok(res) if res.status().is_success() => res.json::<serde_json::Value>().await.unwrap_or_default(),
            Ok(res) => {
                log::warn!("Failed to fetch values for tab {tab}: status {}", res.status());
                all_discrepancies.push(ReconDiscrepancy {
                    user_id,
                    full_name,
                    attendance_date: end_str.clone(),
                    sheet_b: None,
                    sheet_c: None,
                    sheet_d: None,
                    sheet_e: None,
                    db_time_in: None,
                    db_time_out: None,
                    action_taken: ReconAction::Failed,
                    error_message: Some(format!("Values fetch error: status {}", res.status())),
                });
                continue;
            }
            Err(e) => {
                log::warn!("Network error fetching values for tab {tab}: {e}");
                all_discrepancies.push(ReconDiscrepancy {
                    user_id,
                    full_name,
                    attendance_date: end_str.clone(),
                    sheet_b: None,
                    sheet_c: None,
                    sheet_d: None,
                    sheet_e: None,
                    db_time_in: None,
                    db_time_out: None,
                    action_taken: ReconAction::Failed,
                    error_message: Some(format!("Network error: {e}")),
                });
                continue;
            }
        };

        let rows = rows_from_values(&tab_values);

        // Fetch DB attendance records in open cutoff
        let att_rows = sqlx::query("SELECT attendance_date, time_in, time_out FROM attendance WHERE user_id = ? AND attendance_date >= ? AND attendance_date <= ?")
            .bind(&user_id)
            .bind(&start_str)
            .bind(&end_str)
            .fetch_all(&state.db)
            .await
            .map_err(|e| e.to_string())?;

        let mut db_attendance: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
        for r in att_rows {
            let ad: String = r.get("attendance_date");
            let tin: Option<String> = r.get("time_in");
            let tout: Option<String> = r.get("time_out");
            db_attendance.insert(ad, (tin, tout));
        }

        let recon_res = reconcile_intern_tab(
            &user_id,
            &full_name,
            sheet_id,
            &rows,
            &db_attendance,
            cutoff_start,
            cutoff_end,
            report_only,
        );

        if !report_only {
            // Apply targeted B:E writes
            for (row_1based, values) in &recon_res.writes {
                let write_range = urlencoding::encode(&format!(
                    "{}!B{}:E{}",
                    quote_tab_name(&tab),
                    row_1based,
                    row_1based
                ))
                .into_owned();
                let body = serde_json::json!({ "values": [[values[0], values[1], values[2], values[3]]] });
                let _ = client
                    .put(format!(
                        "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{write_range}?valueInputOption=USER_ENTERED"
                    ))
                    .bearer_auth(&token)
                    .json(&body)
                    .send()
                    .await;
            }

            // Apply one cosmetic paint batchUpdate per modified tab
            if !recon_res.format_ops.is_empty() {
                let _ = execute_format_ops(&client, &token, &spreadsheet_id, &recon_res.format_ops).await;
            }
        }

        all_discrepancies.extend(recon_res.discrepancies);
    }

    // Record discrepancies in database
    for d in &all_discrepancies {
        sqlx::query(
            "INSERT INTO dtr_recon_discrepancies (run_id, user_id, full_name, attendance_date, sheet_b, sheet_c, sheet_d, sheet_e, db_time_in, db_time_out, action_taken, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&run_id)
        .bind(&d.user_id)
        .bind(&d.full_name)
        .bind(&d.attendance_date)
        .bind(&d.sheet_b)
        .bind(&d.sheet_c)
        .bind(&d.sheet_d)
        .bind(&d.sheet_e)
        .bind(&d.db_time_in)
        .bind(&d.db_time_out)
        .bind(d.action_taken.as_str())
        .bind(&d.error_message)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    }

    let summary = serde_json::json!({
        "cutoffStart": start_str,
        "cutoffEnd": end_str,
        "totalInterns": total_interns,
        "discrepanciesCount": all_discrepancies.len(),
        "correctedCount": all_discrepancies.iter().filter(|d| d.action_taken == ReconAction::Corrected).count(),
        "clearedCount": all_discrepancies.iter().filter(|d| d.action_taken == ReconAction::Cleared).count(),
        "reportedCount": all_discrepancies.iter().filter(|d| d.action_taken == ReconAction::Reported).count(),
        "unresolvableCount": all_discrepancies.iter().filter(|d| d.action_taken == ReconAction::Unresolvable).count(),
        "failedCount": all_discrepancies.iter().filter(|d| d.action_taken == ReconAction::Failed).count(),
    });

    let completed_at = chrono::Utc::now().to_rfc3339();
    sqlx::query("UPDATE dtr_recon_runs SET completed_at = ?, status = 'COMPLETED', summary_json = ? WHERE run_id = ?")
        .bind(&completed_at)
        .bind(summary.to_string())
        .bind(&run_id)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;

    // Update last_recon_week state
    sqlx::query("INSERT INTO dtr_recon_state (key, value, updated_at) VALUES ('last_recon_week', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
        .bind(&current_week)
        .bind(&completed_at)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;

    // Audit log
    let audit_msg = format!(
        "DTR reconciliation completed: {} discrepancies across {} interns (report_only={report_only})",
        all_discrepancies.len(),
        total_interns
    );
    let _ = sqlx::query("INSERT INTO audit_logs (log_id, timestamp, event_type, message, request_id) VALUES (?, ?, 'DTR_RECON_COMPLETED', ?, ?)")
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&completed_at)
        .bind(&audit_msg)
        .bind(&run_id)
        .execute(&state.db)
        .await;

    Ok(run_id)
}

async fn record_run_failure(state: &AppState, run_id: &str, error: &str) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    let summary = serde_json::json!({ "error": error });
    let _ = sqlx::query("UPDATE dtr_recon_runs SET completed_at = ?, status = 'FAILED', summary_json = ? WHERE run_id = ?")
        .bind(&now)
        .bind(summary.to_string())
        .bind(run_id)
        .execute(&state.db)
        .await;

    let _ = sqlx::query("INSERT INTO audit_logs (log_id, timestamp, event_type, message, request_id) VALUES (?, ?, 'DTR_RECON_FAILED', ?, ?)")
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&now)
        .bind(format!("DTR reconciliation failed: {error}"))
        .bind(run_id)
        .execute(&state.db)
        .await;

    Ok(())
}

/// Entry point 3: Retrieve the latest reconciliation report.
pub async fn get_latest_report(state: &AppState) -> Result<Option<serde_json::Value>, String> {
    let run = sqlx::query(
        "SELECT run_id, started_at, completed_at, status, report_only, summary_json FROM dtr_recon_runs ORDER BY started_at DESC LIMIT 1",
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    let Some(run_row) = run else {
        return Ok(None);
    };

    let run_id: String = run_row.get("run_id");
    let started_at: String = run_row.get("started_at");
    let completed_at: Option<String> = run_row.get("completed_at");
    let status: String = run_row.get("status");
    let report_only: i64 = run_row.get("report_only");
    let summary_raw: String = run_row.get("summary_json");
    let summary: serde_json::Value =
        serde_json::from_str(&summary_raw).unwrap_or(serde_json::Value::Object(serde_json::Map::new()));

    let rows = sqlx::query("SELECT id, user_id, full_name, attendance_date, sheet_b, sheet_c, sheet_d, sheet_e, db_time_in, db_time_out, action_taken, error_message FROM dtr_recon_discrepancies WHERE run_id = ? ORDER BY attendance_date, full_name")
        .bind(&run_id)
        .fetch_all(&state.db)
        .await
        .map_err(|e| e.to_string())?;

    let discrepancies: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|r| {
            serde_json::json!({
                "id": r.get::<i64, _>("id"),
                "userId": r.get::<String, _>("user_id"),
                "fullName": r.get::<String, _>("full_name"),
                "attendanceDate": r.get::<String, _>("attendance_date"),
                "sheetB": r.get::<Option<String>, _>("sheet_b"),
                "sheetC": r.get::<Option<String>, _>("sheet_c"),
                "sheetD": r.get::<Option<String>, _>("sheet_d"),
                "sheetE": r.get::<Option<String>, _>("sheet_e"),
                "dbTimeIn": r.get::<Option<String>, _>("db_time_in"),
                "dbTimeOut": r.get::<Option<String>, _>("db_time_out"),
                "actionTaken": r.get::<String, _>("action_taken"),
                "errorMessage": r.get::<Option<String>, _>("error_message"),
            })
        })
        .collect();

    Ok(Some(serde_json::json!({
        "runId": run_id,
        "startedAt": started_at,
        "completedAt": completed_at,
        "status": status,
        "reportOnly": report_only != 0,
        "summary": summary,
        "discrepancies": discrepancies,
    })))
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    pub fn test_scheduling() {
        // Friday 2026-09-11 11:59:59 Manila -> not after noon
        let fri_before_noon = Manila
            .with_ymd_and_hms(2026, 9, 11, 11, 59, 59)
            .single()
            .unwrap();
        assert_eq!(format_recon_week(&fri_before_noon), "2026-W37");
        assert!(is_manila_office_hours(&fri_before_noon));
        assert!(!is_friday_after_noon(&fri_before_noon));
        assert!(!should_run_recon_scheduled(
            &fri_before_noon,
            None,
            false
        ));

        // Friday 2026-09-11 12:00:00 Manila -> triggers!
        let fri_noon = Manila
            .with_ymd_and_hms(2026, 9, 11, 12, 0, 0)
            .single()
            .unwrap();
        assert!(is_manila_office_hours(&fri_noon));
        assert!(is_friday_after_noon(&fri_noon));
        assert!(should_run_recon_scheduled(
            &fri_noon,
            None,
            false
        ));

        // Friday 2026-09-11 13:00:00 Manila -> already ran for 2026-W37 -> skips!
        let fri_1pm = Manila
            .with_ymd_and_hms(2026, 9, 11, 13, 0, 0)
            .single()
            .unwrap();
        assert!(!should_run_recon_scheduled(
            &fri_1pm,
            Some("2026-W37"),
            false
        ));

        // Friday 2026-09-11 18:30:00 Manila -> outside office hours -> skips
        let fri_evening = Manila
            .with_ymd_and_hms(2026, 9, 11, 18, 30, 0)
            .single()
            .unwrap();
        assert!(!is_manila_office_hours(&fri_evening));
        assert!(!should_run_recon_scheduled(
            &fri_evening,
            None,
            false
        ));

        // Boot catch-up: Monday 2026-09-14 09:00:00 Manila during office hours
        let mon_morning = Manila
            .with_ymd_and_hms(2026, 9, 14, 9, 0, 0)
            .single()
            .unwrap();
        assert_eq!(format_recon_week(&mon_morning), "2026-W38");
        assert!(is_manila_office_hours(&mon_morning));
        // Not boot -> false
        assert!(!should_run_recon_scheduled(
            &mon_morning,
            Some("2026-W37"),
            false
        ));
        // Boot -> true
        assert!(should_run_recon_scheduled(
            &mon_morning,
            Some("2026-W37"),
            true
        ));
        // Boot when current week already ran -> false
        assert!(!should_run_recon_scheduled(
            &mon_morning,
            Some("2026-W38"),
            true
        ));
    }

    #[test]
    pub fn test_cutoff_scoping() {
        // Case 1: Finalized cutoff exists up to 2026-08-15, today is 2026-08-20
        let today1 = NaiveDate::from_ymd_opt(2026, 8, 20).unwrap();
        let (start1, end1) = determine_open_cutoff(Some("2026-08-15"), today1).unwrap();
        assert_eq!(start1, NaiveDate::from_ymd_opt(2026, 8, 16).unwrap());
        assert_eq!(end1, today1);

        // Case 2: No finalized cutoff, today is 2026-09-08 (day <= 15) -> 1st of month
        let today2 = NaiveDate::from_ymd_opt(2026, 9, 8).unwrap();
        let (start2, end2) = determine_open_cutoff(None, today2).unwrap();
        assert_eq!(start2, NaiveDate::from_ymd_opt(2026, 9, 1).unwrap());
        assert_eq!(end2, today2);

        // Case 3: No finalized cutoff, today is 2026-09-22 (day > 15) -> 16th of month
        let today3 = NaiveDate::from_ymd_opt(2026, 9, 22).unwrap();
        let (start3, end3) = determine_open_cutoff(None, today3).unwrap();
        assert_eq!(start3, NaiveDate::from_ymd_opt(2026, 9, 16).unwrap());
        assert_eq!(end3, today3);
    }

    #[test]
    pub fn test_report_only_mode() {
        let user_id = "test-u1";
        let full_name = "Deign Lazaro";
        let sheet_id = 12345;
        let cutoff_start = NaiveDate::from_ymd_opt(2026, 9, 1).unwrap();
        let cutoff_end = NaiveDate::from_ymd_opt(2026, 9, 5).unwrap();

        // Sheet has row for 2026-09-02 with old/incorrect values
        let rows = vec![
            vec!["SEPTEMBER".to_string()],
            vec![
                "9/2/2026".to_string(),
                "8:00:00 AM".to_string(),
                "12:00:00 PM".to_string(),
                "1:00:00 PM".to_string(),
                "5:00:00 PM".to_string(),
            ],
        ];

        // DB attendance has updated time_out
        let mut db_attendance = HashMap::new();
        db_attendance.insert(
            "2026-09-02".to_string(),
            (
                Some("2026-09-02T08:00:00+08:00".to_string()),
                Some("2026-09-02T16:00:00+08:00".to_string()), // Half-day!
            ),
        );

        // 1. In report_only = true mode:
        let report_result = reconcile_intern_tab(
            user_id,
            full_name,
            sheet_id,
            &rows,
            &db_attendance,
            cutoff_start,
            cutoff_end,
            true, // report_only
        );
        assert_eq!(report_result.discrepancies.len(), 1);
        assert_eq!(
            report_result.discrepancies[0].action_taken,
            ReconAction::Reported
        );
        assert!(report_result.writes.is_empty());
        assert!(report_result.format_ops.is_empty());

        // 2. In report_only = false mode:
        let execute_result = reconcile_intern_tab(
            user_id,
            full_name,
            sheet_id,
            &rows,
            &db_attendance,
            cutoff_start,
            cutoff_end,
            false, // execute writes
        );
        assert_eq!(execute_result.discrepancies.len(), 1);
        assert_eq!(
            execute_result.discrepancies[0].action_taken,
            ReconAction::Corrected
        );
        assert_eq!(execute_result.writes.len(), 1);
        assert_eq!(execute_result.writes[0].0, 2); // 1-based row 2
        // DTR/PAYROLL DECOUPLING: 08:00-16:00 is payroll half-day, but the
        // recon write carries the actual stamps, never the fixed-lunch form.
        assert_eq!(
            execute_result.writes[0].1,
            ["8:00:00 AM", "", "", "4:00:00 PM"]
        );
        assert!(!execute_result.format_ops.is_empty());
    }

    #[test]
    pub fn test_deleted_row_clearing() {
        let user_id = "test-u2";
        let full_name = "Jane Doe";
        let sheet_id = 999;
        let cutoff_start = NaiveDate::from_ymd_opt(2026, 9, 1).unwrap();
        let cutoff_end = NaiveDate::from_ymd_opt(2026, 9, 5).unwrap();

        // Sheet row has values on 9/3/2026, but attendance was deleted in SQLite
        let rows = vec![
            vec!["SEPTEMBER".to_string()],
            vec![
                "9/3/2026".to_string(),
                "8:00:00 AM".to_string(),
                "12:00:00 PM".to_string(),
                "1:00:00 PM".to_string(),
                "5:00:00 PM".to_string(),
            ],
        ];

        let db_attendance = HashMap::new(); // Empty!

        // Report only -> reported
        let report_res = reconcile_intern_tab(
            user_id,
            full_name,
            sheet_id,
            &rows,
            &db_attendance,
            cutoff_start,
            cutoff_end,
            true,
        );
        assert_eq!(report_res.discrepancies.len(), 1);
        assert_eq!(
            report_res.discrepancies[0].action_taken,
            ReconAction::Reported
        );
        assert!(report_res.writes.is_empty());

        // Auto-correct -> cleared
        let fix_res = reconcile_intern_tab(
            user_id,
            full_name,
            sheet_id,
            &rows,
            &db_attendance,
            cutoff_start,
            cutoff_end,
            false,
        );
        assert_eq!(fix_res.discrepancies.len(), 1);
        assert_eq!(fix_res.discrepancies[0].action_taken, ReconAction::Cleared);
        assert_eq!(fix_res.writes.len(), 1);
        assert_eq!(fix_res.writes[0].0, 2);
        assert_eq!(fix_res.writes[0].1, ["", "", "", ""]);
        assert_eq!(fix_res.format_ops.len(), 1);
        assert_eq!(fix_res.format_ops[0].color, DtrCellColor::White);
    }
}
