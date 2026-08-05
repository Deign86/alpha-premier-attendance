mod config;
mod database;
mod error;
mod lan_net;
mod lan_server;
mod paths;
pub mod reporting;
mod services;
mod state;

use chrono::Datelike;
use chrono_tz::Asia::Manila;
use sha2::{Digest, Sha256};
use sqlx::{sqlite::SqliteRow, Row};
use state::{AdminSession, AppState};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::Instant,
};
use tauri::{Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use crate::services::intern_payroll::{INTERN_DAILY_RATE_PHP, INTERN_LATE_DEDUCTION_PER_HOUR_PHP, INTERN_PAYROLL_PROFILE_ID};

#[tauri::command]
fn print_payroll(window: tauri::WebviewWindow) -> Result<(), String> {
    window.print().map_err(|error| error.to_string())
}

#[tauri::command]
fn get_health(state: State<'_, AppState>) -> serde_json::Value {
    serde_json::json!({"success":true,"service":"rfid-attendance-api","timestamp":chrono::Utc::now(),"timezone":"Asia/Manila","sqlite":"connected","lanEnabled":state.lan.enabled,"lan":{"bindAddress":state.lan.bind_address.map(|v|v.to_string()),"port":state.lan.port,"connectedSseClients":state.connected_sse_clients.load(std::sync::atomic::Ordering::Relaxed)},"googleSheetsExport":if state.lan.sheets_sync_endpoint.is_some() || state.lan.google_spreadsheet_id.is_some() { "configured" } else { "disabled" }})
}

#[tauri::command]
fn get_config(state: State<'_, AppState>) -> serde_json::Value {
    serde_json::json!({"success":true,"timezone":"Asia/Manila","rfidAutoSubmitDelayMs":150,"resultResetDelayMs":4000,"enableAdmin":true,"enableCardSetup":true,"lanEnabled":state.lan.enabled,"scanner":{"mode":crate::services::scanner::mode_label(state.scanner.config.mode),"paused":state.scanner.paused()},"office":{"companyName":state.office.company_name,"officeLabel":state.office.office_label,"officeAddressLine1":state.office.office_address_line_1,"officeBuilding":state.office.office_building,"officeDistrict":state.office.office_district,"officeCity":state.office.office_city,"officeRegion":state.office.office_region,"officeCountry":state.office.office_country,"officePostalCode":state.office.office_postal_code,"officeDisplayShort":state.office.display_short(),"officeDisplayFull":state.office.display_full()}})
}

#[tauri::command]
/// Live scanner lifecycle status (state, message, mode) for the kiosk status
/// pill and admin diagnostics.
fn scanner_status(state: State<'_, AppState>) -> crate::services::scanner::ScannerStatus {
    state.scanner.status()
}

#[tauri::command]
/// Pause/resume the native scanner listener while the operator types (admin,
/// setup, manual entry) so keystrokes are never misread as card scans.
fn scanner_pause(state: State<'_, AppState>, paused: bool) {
    state.scanner.set_paused(paused);
}

#[tauri::command]
async fn get_attendance(
    state: State<'_, AppState>,
    date: Option<String>,
) -> Result<serde_json::Value, String> {
    let selected = date.unwrap_or_else(|| {
        chrono::Utc::now()
            .with_timezone(&Manila)
            .date_naive()
            .to_string()
    });
    let rows = sqlx::query("SELECT attendance_id,attendance_date,user_id,full_name,department,time_in,time_out,status FROM attendance WHERE attendance_date=? ORDER BY time_in,full_name").bind(&selected).fetch_all(&state.db).await.map_err(|e| e.to_string())?;
    Ok(
        serde_json::json!({"success":true,"date":selected,"attendance":rows.into_iter().map(|r| serde_json::json!({"attendanceId":r.get::<String,_>("attendance_id"),"attendanceDate":r.get::<String,_>("attendance_date"),"userId":r.get::<String,_>("user_id"),"fullName":r.get::<String,_>("full_name"),"department":r.get::<Option<String>,_>("department"),"timeIn":r.get::<Option<String>,_>("time_in"),"timeOut":r.get::<Option<String>,_>("time_out"),"status":r.get::<String,_>("status")})).collect::<Vec<_>>(),"fetchedAt":chrono::Utc::now()}),
    )
}

#[tauri::command]
async fn admin_users(
    state: State<'_, AppState>,
    token: String,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let rows = sqlx::query("SELECT user_id, rfid_uid, full_name, department, status, employee_type, gender, daily_rate_centavos, payroll_profile_id, photo_url FROM users ORDER BY full_name")
        .fetch_all(&state.db).await.map_err(|e| e.to_string())?;
    let users = rows.into_iter().map(|row| serde_json::json!({"userId":row.get::<String,_>("user_id"),"rfidUid":row.get::<String,_>("rfid_uid"),"fullName":row.get::<String,_>("full_name"),"department":row.get::<Option<String>,_>("department"),"status":row.get::<String,_>("status"),"employeeType":row.get::<String,_>("employee_type"),"gender":row.get::<Option<String>,_>("gender"),"dailyRate":row.get::<Option<i64>,_>("daily_rate_centavos").map(|v| v as f64 / 100.0),"payrollProfileId":row.get::<Option<String>,_>("payroll_profile_id"),"photoUrl":row.get::<Option<String>,_>("photo_url")})).collect::<Vec<_>>();
    Ok(serde_json::json!({"success":true,"users":users}))
}

#[tauri::command]
async fn admin_list_users(
    state: State<'_, AppState>,
    token: String,
) -> Result<serde_json::Value, String> {
    admin_users(state, token).await
}

#[tauri::command]
async fn admin_upsert_user(
    state: State<'_, AppState>,
    token: String,
    user: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let user_id = user
        .get("userId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let rfid_uid = user
        .get("rfidUid")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_uppercase();
    let full_name = user
        .get("fullName")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let status = user
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("ACTIVE");
    let employee_type = user
        .get("employeeType")
        .and_then(|v| v.as_str())
        .unwrap_or("INTERN");
    let gender = user.get("gender").and_then(|v| v.as_str());
    if user_id.is_empty()
        || rfid_uid.is_empty()
        || full_name.is_empty()
        || !matches!(status, "ACTIVE" | "INACTIVE")
        || !matches!(employee_type, "INTERN" | "EMPLOYEE")
        || gender.is_some_and(|g| !matches!(g, "MALE" | "FEMALE"))
    {
        return Err("ADMIN_VALIDATION_ERROR".into());
    }
    let now = chrono::Utc::now().to_rfc3339();
    let result = sqlx::query("INSERT INTO users (user_id, rfid_uid, full_name, department, status, created_at, employee_type, daily_rate_centavos, payroll_profile_id, photo_url, gender, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET rfid_uid=excluded.rfid_uid, full_name=excluded.full_name, department=excluded.department, status=excluded.status, employee_type=excluded.employee_type, gender=COALESCE(excluded.gender, users.gender), daily_rate_centavos=excluded.daily_rate_centavos, payroll_profile_id=excluded.payroll_profile_id, photo_url=excluded.photo_url, revision=users.revision+1, updated_at=excluded.updated_at")
        .bind(user_id).bind(&rfid_uid).bind(full_name).bind(user.get("department").and_then(|v| v.as_str())).bind(status).bind(&now).bind(employee_type).bind(gender).bind(user.get("dailyRate").and_then(|v| v.as_i64()).map(|v| v * 100)).bind(user.get("payrollProfileId").and_then(|v| v.as_str())).bind(user.get("photoUrl").and_then(|v| v.as_str())).bind(&now).execute(&state.db).await.map_err(|e| if e.to_string().contains("UNIQUE") { "USER_CONFLICT".into() } else { e.to_string() })?;
    let _ = sqlx::query("INSERT INTO audit_logs (log_id, timestamp, event_type, user_id, message, request_id) VALUES (?, ?, 'ADMIN_USER_UPSERT', ?, ?, ?)").bind(uuid::Uuid::new_v4().to_string()).bind(&now).bind(user_id).bind("User profile saved by administrator").bind(format!("admin-{}", uuid::Uuid::new_v4())).execute(&state.db).await;
    enqueue_sync(&state, "Users", user_id, "UPSERT", &user).await;
    Ok(serde_json::json!({"success":true,"created":result.rows_affected()==1,"userId":user_id}))
}

#[tauri::command]
async fn admin_create_user(
    state: State<'_, AppState>,
    token: String,
    user: serde_json::Value,
) -> Result<serde_json::Value, String> {
    admin_upsert_user(state, token, user).await
}

#[tauri::command]
async fn admin_update_user(
    state: State<'_, AppState>,
    token: String,
    user: serde_json::Value,
) -> Result<serde_json::Value, String> {
    admin_upsert_user(state, token, user).await
}

#[tauri::command]
async fn admin_delete_user(
    state: State<'_, AppState>,
    token: String,
    user_id: String,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let result = sqlx::query("DELETE FROM users WHERE user_id = ?")
        .bind(&user_id)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    if result.rows_affected() != 1 {
        return Err("USER_NOT_FOUND".into());
    }
    enqueue_sync(
        &state,
        "Users",
        &user_id,
        "DELETE",
        &serde_json::json!({"userId":user_id}),
    )
    .await;
    Ok(serde_json::json!({"success":true,"userId":user_id}))
}

#[tauri::command]
async fn admin_attendance(
    state: State<'_, AppState>,
    token: String,
    date: String,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    if !date.as_bytes().iter().enumerate().all(|(i, b)| {
        if [4, 7].contains(&i) {
            *b == b'-'
        } else {
            b.is_ascii_digit()
        }
    }) || date.len() != 10
    {
        return Err("INVALID_DATE".into());
    }
    let rows = sqlx::query("SELECT attendance_id, attendance_date, user_id, full_name, department, time_in, time_out, status FROM attendance WHERE attendance_date = ? ORDER BY time_in, full_name").bind(&date).fetch_all(&state.db).await.map_err(|e| e.to_string())?;
    let attendance = rows.into_iter().map(|row| serde_json::json!({"attendanceId":row.get::<String,_>("attendance_id"),"attendanceDate":row.get::<String,_>("attendance_date"),"userId":row.get::<String,_>("user_id"),"fullName":row.get::<String,_>("full_name"),"department":row.get::<Option<String>,_>("department"),"timeIn":row.get::<Option<String>,_>("time_in"),"timeOut":row.get::<Option<String>,_>("time_out"),"status":row.get::<String,_>("status")})).collect::<Vec<_>>();
    Ok(
        serde_json::json!({"success":true,"date":date,"attendance":attendance,"fetchedAt":chrono::Utc::now()}),
    )
}

#[tauri::command]
async fn admin_list_attendance(
    state: State<'_, AppState>,
    token: String,
    date: String,
) -> Result<serde_json::Value, String> {
    admin_attendance(state, token, date).await
}

#[tauri::command]
async fn admin_update_attendance(
    state: State<'_, AppState>,
    token: String,
    attendance_id: String,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let row = sqlx::query(
        "SELECT attendance_date,time_in,time_out,revision FROM attendance WHERE attendance_id=?",
    )
    .bind(&attendance_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "ATTENDANCE_NOT_FOUND".to_string())?;
    let date = payload
        .get("attendanceDate")
        .and_then(|v| v.as_str())
        .unwrap_or(row.get("attendance_date"));
    let time_in = payload.get("timeIn").and_then(|v| v.as_str());
    let time_out = payload.get("timeOut").and_then(|v| v.as_str());
    if chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err()
        || time_in.is_some_and(|value| chrono::DateTime::parse_from_rfc3339(value).is_err())
        || time_out.is_some_and(|value| chrono::DateTime::parse_from_rfc3339(value).is_err())
    {
        return Err("ADMIN_VALIDATION_ERROR".into());
    }
    let current_in: Option<String> = row.get("time_in");
    let current_out: Option<String> = row.get("time_out");
    let expected_in = payload
        .get("expectedTimeIn")
        .and_then(|v| v.as_str())
        .or(current_in.as_deref());
    let expected_out = payload
        .get("expectedTimeOut")
        .and_then(|v| v.as_str())
        .or(current_out.as_deref());
    // The office does not allow overtime: an admin-saved time-out after
    // office hours stays flagged LATE_TIMEOUT instead of COMPLETED until the
    // official time is re-entered.
    let late = time_out.is_some_and(|value| crate::services::office_hours::is_late_timeout(value));
    let status = if time_in.is_some() && time_out.is_some() {
        if late {
            "LATE_TIMEOUT"
        } else {
            "COMPLETED"
        }
    } else if time_in.is_some() {
        "WORKING"
    } else {
        "MISSED"
    };
    let now = chrono::Utc::now().to_rfc3339();
    let updated = sqlx::query("UPDATE attendance SET attendance_date=?,time_in=?,time_out=?,status=?,revision=revision+1,updated_at=? WHERE attendance_id=? AND time_in IS ? AND time_out IS ? AND revision=?")
        .bind(date).bind(time_in).bind(time_out).bind(status).bind(&now).bind(&attendance_id).bind(expected_in).bind(expected_out).bind(row.get::<i64,_>("revision")).execute(&state.db).await.map_err(|e|e.to_string())?;
    if updated.rows_affected() != 1 {
        return Err("ATTENDANCE_CONFLICT".into());
    }
    // Capture cascaded rows before the hard delete so their Sheets rows are removed too.
    let payroll_ids: Vec<String> = sqlx::query("SELECT payroll_id FROM payroll WHERE attendance_id=?")
        .bind(&attendance_id)
        .fetch_all(&state.db)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|row| row.get::<String, _>("payroll_id"))
        .collect();
    let grace_rows: Vec<(String, String)> = sqlx::query("SELECT grace_id, user_id FROM intern_grace WHERE attendance_id=?")
        .bind(&attendance_id)
        .fetch_all(&state.db)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|row| (row.get::<String, _>("grace_id"), row.get::<String, _>("user_id")))
        .collect();
    let _ = sqlx::query("DELETE FROM payroll WHERE attendance_id=?")
        .bind(&attendance_id)
        .execute(&state.db)
        .await;
    let _ = sqlx::query("DELETE FROM intern_grace WHERE attendance_id=?")
        .bind(&attendance_id)
        .execute(&state.db)
        .await;
    for payroll_id in payroll_ids {
        enqueue_sync(
            &state,
            "Payroll",
            &payroll_id,
            "DELETE",
            &serde_json::json!({"payrollId":payroll_id,"attendanceId":attendance_id}),
        )
        .await;
    }
    for (grace_id, user_id) in grace_rows {
        enqueue_sync(
            &state,
            "InternGrace",
            &user_id,
            "DELETE",
            &serde_json::json!({"userId":user_id,"attendanceId":attendance_id,"graceId":grace_id}),
        )
        .await;
    }
    if status == "COMPLETED" {
        if let (Some(actual_in), Some(actual_out)) = (time_in, time_out) {
            if let Some(user_row) = sqlx::query("SELECT user_id,full_name,employee_type,daily_rate_centavos FROM users WHERE user_id=(SELECT user_id FROM attendance WHERE attendance_id=? LIMIT 1)").bind(&attendance_id).fetch_optional(&state.db).await.map_err(|e| e.to_string())? {
                ensure_payroll(&state, &attendance_id, user_row.get("user_id"), user_row.get("full_name"), user_row.get("employee_type"), user_row.get("daily_rate_centavos"), date, actual_in, actual_out).await?;
            }
        }
    }
    enqueue_sync(&state, "Attendance", &attendance_id, "UPSERT", &serde_json::json!({"attendanceId":attendance_id,"attendanceDate":date,"timeIn":time_in,"timeOut":time_out,"status":status})).await;
    let _ = sqlx::query("INSERT INTO audit_logs (log_id,timestamp,event_type,message,request_id) VALUES (?,?, 'ADMIN_ATTENDANCE_UPDATED',?,?)").bind(uuid::Uuid::new_v4().to_string()).bind(&now).bind(format!("Attendance {attendance_id} corrected")).bind(format!("admin-{}",uuid::Uuid::new_v4())).execute(&state.db).await;
    Ok(
        serde_json::json!({"success":true,"attendanceId":attendance_id,"attendanceDate":date,"timeIn":time_in,"timeOut":time_out,"status":status}),
    )
}

#[tauri::command]
async fn admin_delete_attendance(
    state: State<'_, AppState>,
    token: String,
    attendance_id: String,
    date: String,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    // Capture cascaded rows before the hard delete so their Sheets rows are removed too.
    let payroll_ids: Vec<String> = sqlx::query("SELECT payroll_id FROM payroll WHERE attendance_id=?")
        .bind(&attendance_id)
        .fetch_all(&state.db)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|row| row.get::<String, _>("payroll_id"))
        .collect();
    let grace_rows: Vec<(String, String)> = sqlx::query("SELECT grace_id, user_id FROM intern_grace WHERE attendance_id=?")
        .bind(&attendance_id)
        .fetch_all(&state.db)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|row| (row.get::<String, _>("grace_id"), row.get::<String, _>("user_id")))
        .collect();
    let result = sqlx::query("DELETE FROM attendance WHERE attendance_id=? AND attendance_date=?")
        .bind(&attendance_id)
        .bind(&date)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    if result.rows_affected() != 1 {
        return Err("ATTENDANCE_NOT_FOUND".into());
    }
    let _ = sqlx::query("DELETE FROM payroll WHERE attendance_id=?")
        .bind(&attendance_id)
        .execute(&state.db)
        .await;
    let _ = sqlx::query("DELETE FROM intern_grace WHERE attendance_id=?")
        .bind(&attendance_id)
        .execute(&state.db)
        .await;
    enqueue_sync(
        &state,
        "Attendance",
        &attendance_id,
        "DELETE",
        &serde_json::json!({"attendanceId":attendance_id,"attendanceDate":date}),
    )
    .await;
    for payroll_id in payroll_ids {
        enqueue_sync(
            &state,
            "Payroll",
            &payroll_id,
            "DELETE",
            &serde_json::json!({"payrollId":payroll_id,"attendanceId":attendance_id}),
        )
        .await;
    }
    for (grace_id, user_id) in grace_rows {
        enqueue_sync(
            &state,
            "InternGrace",
            &user_id,
            "DELETE",
            &serde_json::json!({"userId":user_id,"attendanceId":attendance_id,"graceId":grace_id}),
        )
        .await;
    }
    Ok(serde_json::json!({"success":true,"attendanceId":attendance_id}))
}

#[tauri::command]
fn payroll_calculate_cutoff(input: serde_json::Value) -> Result<serde_json::Value, String> {
    let value = |name: &str| input.get(name).and_then(|v| v.as_f64()).unwrap_or(0.0);
    let result = crate::services::cutoff_payroll::calculate(
        &crate::services::cutoff_payroll::CutoffInput {
            employee_id: input
                .get("employeeId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .into(),
            employee_name: input
                .get("employeeName")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .into(),
            cutoff_start: input
                .get("cutoffStart")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .into(),
            cutoff_end: input
                .get("cutoffEnd")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .into(),
            daily_rate: value("dailyRate"),
            standard_working_days: value("standardWorkingDays"),
            actual_working_days: value("actualWorkingDays"),
            special_holiday_days: value("specialHolidayDays"),
            special_holiday_multiplier: value("specialHolidayMultiplier"),
            regular_holiday_days: value("regularHolidayDays"),
            regular_holiday_multiplier: value("regularHolidayMultiplier"),
            incentives_allowance: value("incentivesAllowance"),
            special_allowance: value("specialAllowance"),
            late_deduction: value("lateDeduction"),
            half_day_count: value("halfDayCount"),
            half_day_fraction: value("halfDayFraction"),
            absent_days: value("absentDays"),
            overtime_hours: value("overtimeHours"),
            overtime_rate: value("overtimeRate"),
            manual_adjustment: value("manualAdjustment"),
            adjustment_reason: input
                .get("adjustmentReason")
                .and_then(|v| v.as_str())
                .map(str::to_owned),
            approved_working_day_overage: input
                .get("approvedWorkingDayOverage")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        },
    )?;
    Ok(
        serde_json::json!({"success":true,"result":{"basicPayCentavos":result.basic_pay,"totalCompensationCentavos":result.total_compensation,"totalAllowanceCentavos":result.total_allowance,"lateDeductionCentavos":result.late_deduction,"halfDayDeductionCentavos":result.half_day_deduction,"absenceDeductionCentavos":result.absence_deduction,"overtimePayCentavos":result.overtime_pay,"grossCompensationCentavos":result.gross_compensation,"netPayCentavos":result.net_pay}}),
    )
}

#[tauri::command]
async fn payroll_list_profiles(
    state: State<'_, AppState>,
    token: String,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let rows = sqlx::query("SELECT profile_id,label,payroll_frequency,standard_working_days_per_cutoff,incentives_allowance_centavos,special_allowance_centavos,special_holiday_multiplier,regular_holiday_multiplier,half_day_fraction,overtime_rate_centavos FROM payroll_profiles ORDER BY profile_id").fetch_all(&state.db).await.map_err(|e| e.to_string())?;
    Ok(
        serde_json::json!({"success":true,"profiles":rows.into_iter().map(|r| serde_json::json!({"profileId":r.get::<String,_>("profile_id"),"label":r.get::<String,_>("label"),"payrollFrequency":r.get::<String,_>("payroll_frequency"),"standardWorkingDaysPerCutoff":r.get::<f64,_>("standard_working_days_per_cutoff"),"incentivesAllowance":r.get::<i64,_>("incentives_allowance_centavos") as f64 / 100.0,"specialAllowance":r.get::<i64,_>("special_allowance_centavos") as f64 / 100.0,"specialHolidayMultiplier":r.get::<f64,_>("special_holiday_multiplier"),"regularHolidayMultiplier":r.get::<f64,_>("regular_holiday_multiplier"),"halfDayFraction":r.get::<f64,_>("half_day_fraction"),"overtimeRate":r.get::<i64,_>("overtime_rate_centavos") as f64 / 100.0})).collect::<Vec<_>>() }),
    )
}

#[tauri::command]
async fn payroll_upsert_profile(
    state: State<'_, AppState>,
    token: String,
    profile: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let id = profile
        .get("profileId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let label = profile
        .get("label")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if id.is_empty() || label.is_empty() {
        return Err("ADMIN_VALIDATION_ERROR".into());
    }
    let incentives_allowance = profile
        .get("incentivesAllowance")
        .and_then(|v| v.as_f64())
        .map(php_to_centavos)
        .unwrap_or(0);
    let special_allowance = profile
        .get("specialAllowance")
        .and_then(|v| v.as_f64())
        .map(php_to_centavos)
        .unwrap_or(0);
    let overtime_rate = profile
        .get("overtimeRate")
        .and_then(|v| v.as_f64())
        .map(php_to_centavos)
        .unwrap_or(0);
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO payroll_profiles (profile_id,label,payroll_frequency,standard_working_days_per_cutoff,incentives_allowance_centavos,special_allowance_centavos,special_holiday_multiplier,regular_holiday_multiplier,half_day_fraction,overtime_rate_centavos,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET label=excluded.label,standard_working_days_per_cutoff=excluded.standard_working_days_per_cutoff,incentives_allowance_centavos=excluded.incentives_allowance_centavos,special_allowance_centavos=excluded.special_allowance_centavos,special_holiday_multiplier=excluded.special_holiday_multiplier,regular_holiday_multiplier=excluded.regular_holiday_multiplier,half_day_fraction=excluded.half_day_fraction,overtime_rate_centavos=excluded.overtime_rate_centavos,revision=payroll_profiles.revision+1,updated_at=excluded.updated_at")
        .bind(id).bind(label).bind("SEMI_MONTHLY").bind(profile.get("standardWorkingDaysPerCutoff").and_then(|v| v.as_f64()).unwrap_or(11.0)).bind(incentives_allowance).bind(special_allowance).bind(profile.get("specialHolidayMultiplier").and_then(|v| v.as_f64()).unwrap_or(0.3)).bind(profile.get("regularHolidayMultiplier").and_then(|v| v.as_f64()).unwrap_or(1.0)).bind(profile.get("halfDayFraction").and_then(|v| v.as_f64()).unwrap_or(0.5)).bind(overtime_rate).bind(&now).bind(&now).execute(&state.db).await.map_err(|e| e.to_string())?;
    enqueue_sync(&state, "PayrollProfiles", id, "UPSERT", &profile).await;
    Ok(serde_json::json!({"success":true,"profileId":id}))
}

#[tauri::command]
async fn payroll_list_cutoffs(
    state: State<'_, AppState>,
    token: String,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let rows = sqlx::query("SELECT payroll_id,employee_id,employee_name,payroll_profile_id,payroll_cutoff_label,cutoff_start,cutoff_end,daily_rate_centavos,standard_working_days,actual_working_days,basic_pay_centavos,special_holiday_days,special_holiday_multiplier,special_holiday_pay_centavos,regular_holiday_days,regular_holiday_multiplier,regular_holiday_pay_centavos,incentives_allowance_centavos,special_allowance_centavos,total_compensation_centavos,total_allowance_centavos,late_units,late_deduction_centavos,half_day_count,half_day_deduction_centavos,absent_days,absence_deduction_centavos,overtime_hours,overtime_rate_centavos,overtime_pay_centavos,manual_adjustment_centavos,adjustment_reason,gross_compensation_centavos,net_pay_centavos,signature_placeholder,calculation_breakdown,approved_working_day_overage,status,finalized_at,revision FROM payroll_cutoffs ORDER BY cutoff_start DESC").fetch_all(&state.db).await.map_err(|e| e.to_string())?;
    // Payroll cutoff rows do not store an employee type; derive intern vs
    // employee classification from the Users register so the printable
    // worksheet can apply the intern layout and labels.
    let employee_types: HashMap<String, String> = sqlx::query("SELECT user_id, employee_type FROM users")
        .fetch_all(&state.db)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|row| (row.get::<String, _>("user_id"), row.get::<String, _>("employee_type")))
        .collect();
    Ok(serde_json::json!({"success":true,"payroll":rows.iter().map(|row| payroll_cutoff_json(row, employee_types.get(&row.get::<String,_>("employee_id")).map(String::as_str))).collect::<Vec<_>>() }))
}

fn payroll_cutoff_json(row: &SqliteRow, employee_type: Option<&str>) -> serde_json::Value {
    // Built as an explicit map so the value never depends on the json! macro
    // recursion budget (the record is large and frequently extended).
    let mut map = serde_json::Map::new();
    let mut insert = |key: &str, value: serde_json::Value| { map.insert(key.into(), value); };
    insert("payrollId", serde_json::json!(row.get::<String, _>("payroll_id")));
    insert("employeeId", serde_json::json!(row.get::<String, _>("employee_id")));
    insert("employeeName", serde_json::json!(row.get::<String, _>("employee_name")));
    insert("employeeType", serde_json::json!(if employee_type == Some("EMPLOYEE") { "EMPLOYEE" } else { "INTERN" }));
    insert("payrollProfileId", serde_json::json!(row.get::<String, _>("payroll_profile_id")));
    insert("payrollCutoffLabel", serde_json::json!(row.get::<String, _>("payroll_cutoff_label")));
    insert("cutoffStart", serde_json::json!(row.get::<String, _>("cutoff_start")));
    insert("cutoffEnd", serde_json::json!(row.get::<String, _>("cutoff_end")));
    insert("payrollFrequency", serde_json::json!("SEMI_MONTHLY"));
    insert("dailyRate", serde_json::json!(row.get::<i64, _>("daily_rate_centavos") as f64 / 100.0));
    insert("standardWorkingDays", serde_json::json!(row.get::<f64, _>("standard_working_days")));
    insert("actualWorkingDays", serde_json::json!(row.get::<f64, _>("actual_working_days")));
    insert("basicPay", serde_json::json!(row.get::<i64, _>("basic_pay_centavos") as f64 / 100.0));
    insert("specialHolidayDays", serde_json::json!(row.get::<f64, _>("special_holiday_days")));
    insert("specialHolidayMultiplier", serde_json::json!(row.get::<f64, _>("special_holiday_multiplier")));
    insert("specialHolidayPay", serde_json::json!(row.get::<i64, _>("special_holiday_pay_centavos") as f64 / 100.0));
    insert("regularHolidayDays", serde_json::json!(row.get::<f64, _>("regular_holiday_days")));
    insert("regularHolidayMultiplier", serde_json::json!(row.get::<f64, _>("regular_holiday_multiplier")));
    insert("regularHolidayPay", serde_json::json!(row.get::<i64, _>("regular_holiday_pay_centavos") as f64 / 100.0));
    insert("incentivesAllowance", serde_json::json!(row.get::<i64, _>("incentives_allowance_centavos") as f64 / 100.0));
    insert("specialAllowance", serde_json::json!(row.get::<i64, _>("special_allowance_centavos") as f64 / 100.0));
    insert("totalCompensation", serde_json::json!(row.get::<i64, _>("total_compensation_centavos") as f64 / 100.0));
    insert("totalAllowance", serde_json::json!(row.get::<i64, _>("total_allowance_centavos") as f64 / 100.0));
    insert("lateUnits", serde_json::json!(row.get::<f64, _>("late_units")));
    insert("lateDeduction", serde_json::json!(row.get::<i64, _>("late_deduction_centavos") as f64 / 100.0));
    insert("halfDayCount", serde_json::json!(row.get::<f64, _>("half_day_count")));
    insert("halfDayDeduction", serde_json::json!(row.get::<i64, _>("half_day_deduction_centavos") as f64 / 100.0));
    insert("absentDays", serde_json::json!(row.get::<f64, _>("absent_days")));
    insert("absenceDeduction", serde_json::json!(row.get::<i64, _>("absence_deduction_centavos") as f64 / 100.0));
    insert("overtimeHours", serde_json::json!(row.get::<f64, _>("overtime_hours")));
    insert("overtimeRate", serde_json::json!(row.get::<i64, _>("overtime_rate_centavos") as f64 / 100.0));
    insert("overtimePay", serde_json::json!(row.get::<i64, _>("overtime_pay_centavos") as f64 / 100.0));
    insert("manualAdjustment", serde_json::json!(row.get::<i64, _>("manual_adjustment_centavos") as f64 / 100.0));
    insert("adjustmentReason", serde_json::json!(row.get::<Option<String>, _>("adjustment_reason")));
    insert("grossCompensation", serde_json::json!(row.get::<i64, _>("gross_compensation_centavos") as f64 / 100.0));
    insert("netPay", serde_json::json!(row.get::<i64, _>("net_pay_centavos") as f64 / 100.0));
    insert("signaturePlaceholder", serde_json::json!(row.get::<String, _>("signature_placeholder")));
    insert("calculationBreakdown", serde_json::json!(row.get::<String, _>("calculation_breakdown")));
    insert("approvedWorkingDayOverage", serde_json::json!(row.get::<i64, _>("approved_working_day_overage") != 0));
    insert("status", serde_json::json!(row.get::<String, _>("status")));
    insert("finalizedAt", serde_json::json!(row.get::<Option<String>, _>("finalized_at")));
    insert("revision", serde_json::json!(row.get::<i64, _>("revision")));
    serde_json::Value::Object(map)
}

#[tauri::command]
async fn payroll_create_cutoff(
    state: State<'_, AppState>,
    token: String,
    input: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let mut input = enrich_cutoff_input(&state.db, &input).await?;
    apply_intern_rules(&state.db, &mut input).await?;
    let parsed = cutoff_input(&input);
    let result = crate::services::cutoff_payroll::calculate(&parsed)?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let is_intern = input.get("payrollProfileId").and_then(|v| v.as_str()) == Some(INTERN_PAYROLL_PROFILE_ID);
    // Intern payroll floors at zero for a cutoff (mirrors the daily rule).
    let gross = if is_intern { result.gross_compensation.max(0) } else { result.gross_compensation };
    let net = if is_intern { result.net_pay.max(0) } else { result.net_pay };
    // Total late hours are fillable for employees (rate-based deduction) and
    // computed from late units for interns; persist the units on the record.
    let late_units = input
        .get("lateUnits")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0)
        .max(0.0);
    let profile = input
        .get("payrollProfileId")
        .and_then(|v| v.as_str())
        .unwrap_or("BEA_STANDARD");
    let label = input
        .get("payrollCutoffLabel")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let breakdown = serde_json::json!({"basicPayCentavos":result.basic_pay,"totalCompensationCentavos":result.total_compensation,"totalAllowanceCentavos":result.total_allowance,"lateDeductionCentavos":result.late_deduction,"halfDayDeductionCentavos":result.half_day_deduction,"absenceDeductionCentavos":result.absence_deduction,"overtimePayCentavos":result.overtime_pay,"grossCompensationCentavos":result.gross_compensation});
    let insert_query = format!("INSERT INTO payroll_cutoffs (payroll_id,employee_id,employee_name,payroll_profile_id,payroll_cutoff_label,cutoff_start,cutoff_end,payroll_frequency,daily_rate_centavos,standard_working_days,actual_working_days,basic_pay_centavos,special_holiday_days,special_holiday_multiplier,special_holiday_pay_centavos,regular_holiday_days,regular_holiday_multiplier,regular_holiday_pay_centavos,incentives_allowance_centavos,special_allowance_centavos,total_compensation_centavos,total_allowance_centavos,late_units,late_deduction_centavos,half_day_count,half_day_deduction_centavos,absent_days,absence_deduction_centavos,overtime_hours,overtime_rate_centavos,overtime_pay_centavos,manual_adjustment_centavos,adjustment_reason,gross_compensation_centavos,net_pay_centavos,signature_placeholder,calculation_breakdown,approved_working_day_overage,status,created_at,updated_at) VALUES ({})", std::iter::repeat("?").take(41).collect::<Vec<_>>().join(","));
    sqlx::query(&insert_query)
        .bind(&id)
        .bind(&parsed.employee_id)
        .bind(&parsed.employee_name)
        .bind(profile)
        .bind(label)
        .bind(&parsed.cutoff_start)
        .bind(&parsed.cutoff_end)
        .bind("SEMI_MONTHLY")
        .bind((parsed.daily_rate * 100.0).round() as i64)
        .bind(parsed.standard_working_days)
        .bind(parsed.actual_working_days)
        .bind(result.basic_pay)
        .bind(parsed.special_holiday_days)
        .bind(parsed.special_holiday_multiplier)
        .bind((result.total_compensation - result.basic_pay).max(0))
        .bind(parsed.regular_holiday_days)
        .bind(parsed.regular_holiday_multiplier)
        .bind(0_i64)
        .bind(php_to_centavos(parsed.incentives_allowance))
        .bind(php_to_centavos(parsed.special_allowance))
        .bind(result.total_compensation)
        .bind(result.total_allowance)
        .bind(late_units)
        .bind(result.late_deduction)
        .bind(parsed.half_day_count)
        .bind(result.half_day_deduction)
        .bind(parsed.absent_days)
        .bind(result.absence_deduction)
        .bind(parsed.overtime_hours)
        .bind(php_to_centavos(parsed.overtime_rate))
        .bind(result.overtime_pay)
        .bind((parsed.manual_adjustment * 100.0).round() as i64)
        .bind(parsed.adjustment_reason.clone())
        .bind(gross)
        .bind(net)
        .bind("")
        .bind(breakdown.to_string())
        .bind(if parsed.approved_working_day_overage {
            1
        } else {
            0
        })
        .bind("DRAFT")
        .bind(&now)
        .bind(&now)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    enqueue_sync(&state, "PayrollCutoffs", &id, "UPSERT", &input).await;
    Ok(serde_json::json!({"success":true,"payrollId":id,"netPay":net as f64 / 100.0}))
}

#[tauri::command]
async fn payroll_update_cutoff(
    state: State<'_, AppState>,
    token: String,
    input: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let id = input
        .get("payrollId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "PAYROLL_NOT_FOUND".to_string())?;
    let mut input = enrich_cutoff_input(&state.db, &input).await?;
    apply_intern_rules(&state.db, &mut input).await?;
    let parsed = cutoff_input(&input);
    let result = crate::services::cutoff_payroll::calculate(&parsed)?;
    let now = chrono::Utc::now().to_rfc3339();
    let is_intern = input.get("payrollProfileId").and_then(|v| v.as_str()) == Some(INTERN_PAYROLL_PROFILE_ID);
    let gross = if is_intern { result.gross_compensation.max(0) } else { result.gross_compensation };
    let net = if is_intern { result.net_pay.max(0) } else { result.net_pay };
    let late_units = input
        .get("lateUnits")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0)
        .max(0.0);
    let updated = sqlx::query("UPDATE payroll_cutoffs SET employee_id=?,employee_name=?,payroll_profile_id=?,payroll_cutoff_label=?,cutoff_start=?,cutoff_end=?,daily_rate_centavos=?,standard_working_days=?,actual_working_days=?,basic_pay_centavos=?,incentives_allowance_centavos=?,special_allowance_centavos=?,total_compensation_centavos=?,total_allowance_centavos=?,late_units=?,late_deduction_centavos=?,half_day_deduction_centavos=?,absence_deduction_centavos=?,overtime_pay_centavos=?,manual_adjustment_centavos=?,adjustment_reason=?,gross_compensation_centavos=?,net_pay_centavos=?,calculation_breakdown=?,revision=revision+1,updated_at=? WHERE payroll_id=? AND status != 'FINALIZED'")
        .bind(&parsed.employee_id).bind(&parsed.employee_name).bind(input.get("payrollProfileId").and_then(|v| v.as_str()).unwrap_or("BEA_STANDARD")).bind(input.get("payrollCutoffLabel").and_then(|v| v.as_str()).unwrap_or(""))
        .bind(&parsed.cutoff_start).bind(&parsed.cutoff_end).bind((parsed.daily_rate * 100.0).round() as i64).bind(parsed.standard_working_days).bind(parsed.actual_working_days).bind(result.basic_pay).bind(php_to_centavos(parsed.incentives_allowance)).bind(php_to_centavos(parsed.special_allowance)).bind(result.total_compensation).bind(result.total_allowance).bind(late_units).bind(result.late_deduction).bind(result.half_day_deduction).bind(result.absence_deduction).bind(result.overtime_pay).bind((parsed.manual_adjustment * 100.0).round() as i64).bind(parsed.adjustment_reason).bind(gross).bind(net).bind(serde_json::to_string(&serde_json::json!({"basicPayCentavos":result.basic_pay,"netPayCentavos":net})).unwrap_or_default()).bind(&now).bind(id).execute(&state.db).await.map_err(|e| e.to_string())?;
    if updated.rows_affected() != 1 {
        return Err("PAYROLL_NOT_FOUND_OR_FINALIZED".into());
    }
    enqueue_sync(&state, "PayrollCutoffs", id, "UPSERT", &input).await;
    Ok(serde_json::json!({"success":true,"payrollId":id,"netPay":net as f64 / 100.0}))
}

#[tauri::command]
async fn payroll_finalize_cutoff(
    state: State<'_, AppState>,
    token: String,
    payroll_id: String,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let now = chrono::Utc::now().to_rfc3339();
    let result = sqlx::query("UPDATE payroll_cutoffs SET status='FINALIZED', finalized_at=?, revision=revision+1, updated_at=? WHERE payroll_id=? AND status='DRAFT'").bind(&now).bind(&now).bind(&payroll_id).execute(&state.db).await.map_err(|e| e.to_string())?;
    if result.rows_affected() == 0 {
        return Err("PAYROLL_NOT_FOUND_OR_FINALIZED".into());
    }
    let snapshot = sqlx::query("SELECT payroll_id,employee_id,employee_name,payroll_profile_id,payroll_cutoff_label,cutoff_start,cutoff_end,basic_pay_centavos,total_allowance_centavos,incentives_allowance_centavos,late_deduction_centavos,manual_adjustment_centavos,gross_compensation_centavos,net_pay_centavos,status,revision FROM payroll_cutoffs WHERE payroll_id=?").bind(&payroll_id).fetch_one(&state.db).await.map_err(|e| e.to_string())?;
    let snapshot_json = serde_json::json!({"payrollId":snapshot.get::<String,_>("payroll_id"),"employeeId":snapshot.get::<String,_>("employee_id"),"employeeName":snapshot.get::<String,_>("employee_name"),"profile":snapshot.get::<String,_>("payroll_profile_id"),"cutoffLabel":snapshot.get::<String,_>("payroll_cutoff_label"),"cutoffStart":snapshot.get::<String,_>("cutoff_start"),"cutoffEnd":snapshot.get::<String,_>("cutoff_end"),"basicPayCentavos":snapshot.get::<i64,_>("basic_pay_centavos"),"allowancesCentavos":snapshot.get::<i64,_>("total_allowance_centavos"),"incentivesCentavos":snapshot.get::<i64,_>("incentives_allowance_centavos"),"lateDeductionCentavos":snapshot.get::<i64,_>("late_deduction_centavos"),"manualAdjustmentCentavos":snapshot.get::<i64,_>("manual_adjustment_centavos"),"grossCentavos":snapshot.get::<i64,_>("gross_compensation_centavos"),"netCentavos":snapshot.get::<i64,_>("net_pay_centavos"),"status":"FINALIZED"});
    let snapshot_text = snapshot_json.to_string();
    let snapshot_hash = format!("{:x}", Sha256::digest(snapshot_text.as_bytes()));
    sqlx::query("INSERT INTO payroll_snapshots (snapshot_id,payroll_id,revision,status,snapshot_json,snapshot_sha256,created_at) VALUES (?,?,?,?,?,?,?)").bind(uuid::Uuid::new_v4().to_string()).bind(&payroll_id).bind(snapshot.get::<i64,_>("revision")).bind("FINALIZED").bind(snapshot_text).bind(snapshot_hash).bind(&now).execute(&state.db).await.map_err(|e| e.to_string())?;
    enqueue_sync(
        &state,
        "PayrollCutoffs",
        &payroll_id,
        "UPSERT",
        &serde_json::json!({"payrollId":payroll_id,"status":"FINALIZED","finalizedAt":now}),
    )
    .await;
    Ok(
        serde_json::json!({"success":true,"payrollId":payroll_id,"status":"FINALIZED","finalizedAt":now}),
    )
}

#[tauri::command]
async fn payroll_export_csv(state: State<'_, AppState>, token: String) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let rows = sqlx::query("SELECT payroll_id,employee_id,employee_name,payroll_cutoff_label,cutoff_start,cutoff_end,gross_compensation_centavos,net_pay_centavos,status FROM payroll_cutoffs ORDER BY cutoff_start,employee_name").fetch_all(&state.db).await.map_err(|e| e.to_string())?;
    let mut output = String::new();
    output.push_str(&format!("\"Company\",\"{}\"\n", state.office.company_name.replace('"', "\"\"")));
    output.push_str(&format!("\"Office\",\"{}\"\n", state.office.display_full().replace('"', "\"\"")));
    output.push_str("PAYROLL_ID,EMPLOYEE_ID,EMPLOYEE_NAME,CUTOFF_LABEL,CUTOFF_START,CUTOFF_END,GROSS_PAY_PHP,NET_PAY_PHP,STATUS\n");
    for row in rows {
        let name = row.get::<String, _>("employee_name").replace('"', "\"\"");
        let label = row
            .get::<String, _>("payroll_cutoff_label")
            .replace('"', "\"\"");
        output.push_str(&format!(
            "{},{},\"{}\",\"{}\",{},{},{:.2},{:.2},{}\n",
            row.get::<String, _>("payroll_id"),
            row.get::<String, _>("employee_id"),
            name,
            label,
            row.get::<String, _>("cutoff_start"),
            row.get::<String, _>("cutoff_end"),
            row.get::<i64, _>("gross_compensation_centavos") as f64 / 100.0,
            row.get::<i64, _>("net_pay_centavos") as f64 / 100.0,
            row.get::<String, _>("status")
        ));
    }
    let date = chrono::Utc::now().with_timezone(&Manila).format("%Y-%m-%d").to_string();
    let file_name = format!("payroll-{date}.csv");
    let output_path = state.exports_dir.join(&file_name);
    std::fs::create_dir_all(&state.exports_dir).map_err(|e| e.to_string())?;
    std::fs::write(&output_path, &output).map_err(|e| {
        log::error!("payroll CSV write to {} failed: {e}", output_path.display());
        "EXPORT_WRITE_FAILED".to_string()
    })?;
    let _ = sqlx::query("INSERT INTO audit_logs (log_id,timestamp,event_type,message,request_id) VALUES (?,?, 'EXPORT_GENERATED', ?, ?)").bind(uuid::Uuid::new_v4().to_string()).bind(chrono::Utc::now().to_rfc3339()).bind("Payroll CSV generated").bind(format!("export-{}", uuid::Uuid::new_v4())).execute(&state.db).await;
    Ok(generated_file_metadata(
        &state,
        &file_name,
        &output_path,
        "csv",
        format!("Payroll CSV generated: {file_name}."),
    ))
}

async fn enrich_cutoff_input(
    db: &sqlx::SqlitePool,
    input: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let employee_id = input
        .get("employeeId")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim();
    let needs_name = input
        .get("employeeName")
        .and_then(|value| value.as_str())
        .is_none_or(|value| value.trim().is_empty());
    let needs_rate = input
        .get("dailyRate")
        .and_then(|value| value.as_f64())
        .is_none_or(|value| value <= 0.0);
    if employee_id.is_empty() || (!needs_name && !needs_rate) {
        return Ok(input.clone());
    }
    let employee = sqlx::query(
        "SELECT full_name, daily_rate_centavos FROM users WHERE user_id = ?",
    )
    .bind(employee_id)
    .fetch_optional(db)
    .await
    .map_err(|error| error.to_string())?;
    let Some(employee) = employee else {
        return Ok(input.clone());
    };
    let mut enriched = input.clone();
    let Some(object) = enriched.as_object_mut() else {
        return Ok(input.clone());
    };
    if needs_name {
        object.insert(
            "employeeName".into(),
            serde_json::Value::String(employee.get("full_name")),
        );
    }
    if needs_rate {
        if let Some(daily_rate_centavos) = employee.get::<Option<i64>, _>("daily_rate_centavos") {
            object.insert(
                "dailyRate".into(),
                serde_json::json!(daily_rate_centavos as f64 / 100.0),
            );
        }
    }
    Ok(enriched)
}

/// Enforces the fixed intern payroll policy on a cutoff input before the
/// generic cutoff calculator runs: PHP 80.00/day, PHP 10.00/hour late
/// deduction, and no holiday premium, allowances, half-days, absences, or
/// overtime. Employees pass through untouched.
async fn apply_intern_rules(
    db: &sqlx::SqlitePool,
    input: &mut serde_json::Value,
) -> Result<(), String> {
    let employee_id = input
        .get("employeeId")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim();
    if employee_id.is_empty() {
        return Ok(());
    }
    let employee_type: Option<String> = sqlx::query("SELECT employee_type FROM users WHERE user_id = ?")
        .bind(employee_id)
        .fetch_optional(db)
        .await
        .map_err(|error| error.to_string())?
        .map(|row| row.get("employee_type"));
    if employee_type.as_deref() != Some("INTERN") {
        return Ok(());
    }
    let late_units = input
        .get("lateUnits")
        .and_then(|value| value.as_f64())
        .unwrap_or(0.0)
        .max(0.0);
    let Some(object) = input.as_object_mut() else {
        return Err("ADMIN_VALIDATION_ERROR".into());
    };
    // Fixed intern rate; any submitted rate is ignored for interns.
    object.insert("dailyRate".into(), serde_json::json!(INTERN_DAILY_RATE_PHP as f64));
    object.insert("payrollProfileId".into(), serde_json::json!(INTERN_PAYROLL_PROFILE_ID));
    object.insert("lateUnits".into(), serde_json::json!(late_units));
    // Late deduction is PHP 10.00 per hour, computed from total late hours.
    object.insert(
        "lateDeduction".into(),
        serde_json::json!(late_units * INTERN_LATE_DEDUCTION_PER_HOUR_PHP as f64),
    );
    for field in [
        "incentivesAllowance",
        "specialAllowance",
        "specialHolidayDays",
        "regularHolidayDays",
        "halfDayCount",
        "absentDays",
        "overtimeHours",
        "overtimeRate",
    ] {
        object.insert(field.into(), serde_json::json!(0.0));
    }
    Ok(())
}

fn cutoff_input(value: &serde_json::Value) -> crate::services::cutoff_payroll::CutoffInput {
    let n = |name: &str| value.get(name).and_then(|v| v.as_f64()).unwrap_or(0.0);
    crate::services::cutoff_payroll::CutoffInput {
        employee_id: value
            .get("employeeId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .into(),
        employee_name: value
            .get("employeeName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .into(),
        cutoff_start: value
            .get("cutoffStart")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .into(),
        cutoff_end: value
            .get("cutoffEnd")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .into(),
        daily_rate: n("dailyRate"),
        standard_working_days: n("standardWorkingDays"),
        actual_working_days: n("actualWorkingDays"),
        special_holiday_days: n("specialHolidayDays"),
        special_holiday_multiplier: n("specialHolidayMultiplier"),
        regular_holiday_days: n("regularHolidayDays"),
        regular_holiday_multiplier: n("regularHolidayMultiplier"),
        incentives_allowance: n("incentivesAllowance"),
        special_allowance: n("specialAllowance"),
        late_deduction: n("lateDeduction"),
        half_day_count: n("halfDayCount"),
        half_day_fraction: n("halfDayFraction"),
        absent_days: n("absentDays"),
        overtime_hours: n("overtimeHours"),
        overtime_rate: n("overtimeRate"),
        manual_adjustment: n("manualAdjustment"),
        adjustment_reason: value
            .get("adjustmentReason")
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        approved_working_day_overage: value
            .get("approvedWorkingDayOverage")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    }
}

fn php_to_centavos(value: f64) -> i64 {
    (value * 100.0).round() as i64
}

/// Structured file metadata returned by every file-generating action so the UI
/// can offer Open / Show in folder / Open folder actions.
fn generated_file_metadata(
    state: &AppState,
    file_name: &str,
    file_path: &Path,
    file_kind: &str,
    message: String,
) -> serde_json::Value {
    serde_json::json!({
        "success": true,
        "filePath": file_path.to_string_lossy(),
        "directoryPath": state.exports_dir.to_string_lossy(),
        "fileName": file_name,
        "fileKind": file_kind,
        "isPortableMode": state.is_portable,
        "message": message,
    })
}

/// Canonicalize a candidate path and require it to live inside the exports
/// directory. Rejects traversal and arbitrary paths outside the export root.
fn canonical_exports_path(state: &AppState, candidate: &Path) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(&state.exports_dir)
        .map_err(|_| "EXPORT_DIR_UNAVAILABLE".to_string())?;
    let canonical =
        std::fs::canonicalize(candidate).map_err(|_| "FILE_NOT_FOUND".to_string())?;
    if !canonical.starts_with(&root) {
        return Err("PATH_OUTSIDE_EXPORTS".into());
    }
    Ok(canonical)
}

/// Canonicalize a directory path inside the application data root.
fn canonical_data_path(state: &AppState, candidate: &Path) -> Result<PathBuf, String> {
    let root =
        std::fs::canonicalize(&state.data_dir).map_err(|_| "DATA_DIR_UNAVAILABLE".to_string())?;
    let canonical =
        std::fs::canonicalize(candidate).map_err(|_| "DIRECTORY_NOT_FOUND".to_string())?;
    if !canonical.starts_with(&root) {
        return Err("PATH_OUTSIDE_DATA".into());
    }
    Ok(canonical)
}

#[tauri::command]
async fn open_generated_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    token: String,
    file_path: String,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let path = canonical_exports_path(&state, Path::new(&file_path))?;
    if !path.is_file() {
        return Err("FILE_NOT_FOUND".into());
    }
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| {
            log::error!("open file {} failed: {error}", path.display());
            "OPEN_FAILED".to_string()
        })?;
    Ok(serde_json::json!({"success":true,"message":"File opened."}))
}

#[tauri::command]
async fn reveal_generated_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    token: String,
    file_path: String,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let path = canonical_exports_path(&state, Path::new(&file_path))?;
    if !path.is_file() {
        return Err("FILE_NOT_FOUND".into());
    }
    match app.opener().reveal_item_in_dir(&path) {
        Ok(()) => Ok(serde_json::json!({"success":true,"message":"File revealed in folder."})),
        Err(reveal_error) => {
            log::warn!(
                "reveal file {} failed: {reveal_error}; falling back to opening the folder",
                path.display()
            );
            let directory = path.parent().ok_or_else(|| "PATH_ERROR".to_string())?;
            app.opener()
                .open_path(directory.to_string_lossy().into_owned(), None::<&str>)
                .map_err(|open_error| {
                    log::error!(
                        "fallback folder open {} failed: {open_error}",
                        directory.display()
                    );
                    "REVEAL_FAILED".to_string()
                })?;
            Ok(serde_json::json!({"success":true,"message":"Opened the containing folder."}))
        }
    }
}

#[tauri::command]
async fn open_generated_directory(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    token: String,
    directory_path: String,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let path = canonical_data_path(&state, Path::new(&directory_path))?;
    if !path.is_dir() {
        return Err("DIRECTORY_NOT_FOUND".into());
    }
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| {
            log::error!("open directory {} failed: {error}", path.display());
            "OPEN_FAILED".to_string()
        })?;
    Ok(serde_json::json!({"success":true,"message":"Folder opened."}))
}

#[tauri::command]
/// Status of the local SQLite database for the Data & backup admin panel:
/// live file path, mode, pending restore, and existing backups.
async fn db_info(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let backups = crate::database::list_backups(&state.data_dir).await?;
    let marker = crate::database::restore_request_path(&state.data_dir);
    let restore_pending = marker.is_file();
    let restore_source = if restore_pending {
        std::fs::read_to_string(&marker).ok().map(|text| text.trim().to_string())
    } else {
        None
    };
    let last_backup_at = backups
        .first()
        .and_then(|(path, _)| std::fs::metadata(path).ok())
        .and_then(|metadata| metadata.modified().ok())
        .map(|time| {
            let dt: chrono::DateTime<chrono::Utc> = time.into();
            dt.to_rfc3339()
        });
    let backup_items: Vec<serde_json::Value> = backups
        .iter()
        .map(|(path, size)| {
            let modified = std::fs::metadata(path)
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .map(|time| {
                    let dt: chrono::DateTime<chrono::Utc> = time.into();
                    dt.to_rfc3339()
                });
            serde_json::json!({
                "fileName": path.file_name().and_then(|name| name.to_str()).unwrap_or(""),
                "filePath": path.to_string_lossy(),
                "sizeBytes": size,
                "modifiedAt": modified,
            })
        })
        .collect();
    Ok(serde_json::json!({
        "success": true,
        "dbPath": state.db_path.to_string_lossy(),
        "dataDir": state.data_dir.to_string_lossy(),
        "backupDir": state.backups_dir.to_string_lossy(),
        "isPortableMode": state.is_portable,
        "restorePending": restore_pending,
        "restoreSourcePath": restore_source,
        "backups": backup_items,
        "lastBackupAt": last_backup_at,
    }))
}

#[tauri::command]
/// Create a consistent timestamped backup of the SQLite database into
/// `data_dir/backups` (keeps the newest 10). Safe while the app is running.
async fn db_backup(
    state: State<'_, AppState>,
    token: String,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let file_path = crate::database::create_backup(&state.db, &state.data_dir).await?;
    let file_name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("attendance.db")
        .to_string();
    Ok(serde_json::json!({
        "success": true,
        "filePath": file_path.to_string_lossy(),
        "directoryPath": state.backups_dir.to_string_lossy(),
        "fileName": file_name,
        "fileKind": "backup",
        "isPortableMode": state.is_portable,
        "message": "Backup created.",
    }))
}

#[tauri::command]
/// Schedule a database restore: validate the source file, write the
/// `restore.request` marker, then exit the app. The next launch restores the
/// database from the marker before opening it (see
/// `database::process_restore_request`).
async fn db_restore_request(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    token: String,
    source_path: String,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let source = std::path::PathBuf::from(source_path.trim());
    if source.as_os_str().is_empty() {
        return Err("RESTORE_SOURCE_REQUIRED".into());
    }
    if !source.is_file() {
        return Err("RESTORE_SOURCE_NOT_FOUND".into());
    }
    crate::database::validate_database_file(&source)
        .await
        .map_err(|error| format!("RESTORE_SOURCE_INVALID: {error}"))?;
    let marker = crate::database::restore_request_path(&state.data_dir);
    std::fs::write(&marker, source.to_string_lossy().into_owned())
        .map_err(|error| format!("cannot write restore request: {error}"))?;
    // Drop any stale failure marker from a previous attempt.
    let _ = std::fs::remove_file(crate::database::restore_failed_path(&state.data_dir));
    // Exit cleanly; the response is delivered before the delayed exit. The
    // next launch restores before opening the database.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        app.exit(0);
    });
    Ok(serde_json::json!({
        "success": true,
        "message": "Restore scheduled. The app will close and restore on the next launch."
    }))
}

#[tauri::command]
/// Open the backups folder in the OS file explorer.
async fn db_open_backups_dir(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    token: String,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let dir = state.backups_dir.clone();
    std::fs::create_dir_all(&dir).map_err(|error| format!("cannot create backup folder: {error}"))?;
    app.opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| {
            log::error!("open backups dir failed: {error}");
            "OPEN_FAILED".to_string()
        })?;
    Ok(serde_json::json!({"success": true, "message": "Backup folder opened."}))
}

#[tauri::command]
/// Read-only status of the LAN attendance viewer for the Live Attendance panel.
async fn lan_status(state: State<'_, AppState>) -> Result<crate::lan_server::LanStatusResponse, String> {
    Ok(crate::lan_server::build_lan_status(state.inner()).await)
}

#[tauri::command]
/// Start (or verify) the LAN attendance viewer from the Live Attendance panel.
/// The viewer binds to the office LAN IP so devices on the same Wi-Fi/LAN can
/// open it; it stays strictly read-only and never exposes admin or payroll.
async fn lan_start(state: State<'_, AppState>) -> Result<crate::lan_server::LanStatusResponse, String> {
    let lan = state.lan.clone();
    if !lan.enabled && !lan.allow_runtime_start {
        return Ok(crate::lan_server::build_lan_status(state.inner()).await);
    }
    if state.lan_runtime.phase().await != crate::state::LanPhase::Running {
        let _ = state.lan_runtime.start(state.inner()).await;
    }
    Ok(crate::lan_server::build_lan_status(state.inner()).await)
}

#[tauri::command]
/// Stop the LAN attendance viewer. Attendance recording on the front-desk
/// laptop is unaffected; only the LAN viewer goes offline.
async fn lan_stop(state: State<'_, AppState>) -> Result<crate::lan_server::LanStatusResponse, String> {
    state.lan_runtime.stop().await;
    Ok(crate::lan_server::build_lan_status(state.inner()).await)
}

#[tauri::command]
/// Open the viewer URL in the system default browser (Windows-first office use).
async fn open_viewer_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if url.is_empty() || (!url.starts_with("http://") && !url.starts_with("https://")) {
        return Err("Invalid viewer URL".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|error| {
        log::error!("open viewer URL failed: {error}");
        "OPEN_FAILED".to_string()
    })
}

#[tauri::command]
async fn setup_unlock(
    state: State<'_, AppState>,
    pin: String,
) -> Result<serde_json::Value, String> {
    let configured = state
        .lan
        .admin_pin
        .as_deref()
        .ok_or_else(|| "ADMIN_DISABLED".to_string())?;
    if configured != pin {
        return Err("INVALID_ADMIN_PIN".into());
    }
    let token = uuid::Uuid::new_v4().to_string();
    let expires = std::time::Instant::now()
        + std::time::Duration::from_secs(state.lan.admin_session_minutes * 60);
    *state.admin_session.lock().await = Some(AdminSession {
        token: token.clone(),
        expires_at: expires,
    });
    Ok(
        serde_json::json!({"success":true,"token":token,"expiresAt":chrono::Utc::now() + chrono::Duration::minutes(state.lan.admin_session_minutes as i64)}),
    )
}

#[tauri::command]
async fn setup_lock(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    *state.admin_session.lock().await = None;
    Ok(serde_json::json!({"success":true}))
}

#[tauri::command]
async fn setup_lookup_card(
    state: State<'_, AppState>,
    token: String,
    rfid_uid: String,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("SETUP_AUTH_REQUIRED".into());
    }
    let uid = rfid_uid.trim().to_ascii_uppercase();
    let row = sqlx::query("SELECT user_id,rfid_uid,full_name,department,status,employee_type,gender,daily_rate_centavos,payroll_profile_id,photo_url FROM users WHERE rfid_uid=?").bind(&uid).fetch_optional(&state.db).await.map_err(|e| e.to_string())?;
    Ok(
        serde_json::json!({"success":true,"rfidUid":uid,"user":row.map(|r| serde_json::json!({"userId":r.get::<String,_>("user_id"),"rfidUid":r.get::<String,_>("rfid_uid"),"fullName":r.get::<String,_>("full_name"),"department":r.get::<Option<String>,_>("department"),"status":r.get::<String,_>("status"),"employeeType":r.get::<String,_>("employee_type"),"gender":r.get::<Option<String>,_>("gender"),"dailyRate":r.get::<Option<i64>,_>("daily_rate_centavos").map(|v|v as f64/100.0),"payrollProfileId":r.get::<Option<String>,_>("payroll_profile_id"),"photoUrl":r.get::<Option<String>,_>("photo_url")}))}),
    )
}

#[tauri::command]
async fn setup_upsert_user(
    state: State<'_, AppState>,
    token: String,
    user: serde_json::Value,
) -> Result<serde_json::Value, String> {
    admin_upsert_user(state, token, user).await
}

#[tauri::command]
async fn admin_unlock(
    state: State<'_, AppState>,
    pin: String,
) -> Result<serde_json::Value, String> {
    setup_unlock(state, pin).await
}

#[tauri::command]
async fn admin_get_session(
    state: State<'_, AppState>,
    token: String,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_SESSION_EXPIRED".into());
    }
    Ok(serde_json::json!({"success":true}))
}

#[tauri::command]
async fn admin_lock(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    setup_lock(state).await
}

#[tauri::command]
async fn admin_get_sync_status(
    state: State<'_, AppState>,
    token: String,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let pending: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sync_queue WHERE status IN ('PENDING','RETRY','PROCESSING')",
    )
    .fetch_one(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    let dead: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_queue WHERE status='DEAD'")
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);
    Ok(serde_json::json!({"success":true,"pending":pending,"deadLetter":dead}))
}

#[tauri::command]
async fn admin_retry_sync_item(
    state: State<'_, AppState>,
    token: String,
    id: i64,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let now = chrono::Utc::now().to_rfc3339();
    let updated = sqlx::query("UPDATE sync_queue SET status='PENDING', attempts=0, last_error=NULL, last_error_code=NULL, locked_at=NULL, next_attempt_at=?, updated_at=? WHERE id=?").bind(&now).bind(&now).bind(id).execute(&state.db).await.map_err(|e| e.to_string())?;
    if updated.rows_affected() != 1 {
        return Err("SYNC_ITEM_NOT_FOUND".into());
    }
    Ok(serde_json::json!({"success":true,"id":id}))
}

#[tauri::command]
async fn admin_sync_now(
    state: State<'_, AppState>,
    token: String,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let processed =
        crate::services::sheets_sync::run_once(&state, state.lan.sheets_sync_endpoint.as_deref())
            .await?;
    Ok(serde_json::json!({"success":true,"processed":processed}))
}

/// Dev/test utility (hidden admin action): wipes every managed Google Sheets
/// tab and re-enqueues the current SQLite state for a from-scratch re-export.
/// Gated behind the admin session and an explicit confirmation flag.
#[tauri::command]
async fn admin_sheets_nuke_resync(
    state: State<'_, AppState>,
    token: String,
    confirm: bool,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    if !confirm {
        return Err("RESYNC_CONFIRMATION_REQUIRED".into());
    }
    let result = crate::services::sheets_sync::nuke_and_resync(&state).await?;
    let _ = sqlx::query("INSERT INTO audit_logs (log_id,timestamp,event_type,message,request_id) VALUES (?,?,?,?,?)")
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(chrono::Utc::now().to_rfc3339())
        .bind("SHEETS_RESYNC")
        .bind("Google Sheets wiped and re-exported from SQLite by administrator")
        .bind(format!("admin-{}", uuid::Uuid::new_v4()))
        .execute(&state.db)
        .await;
    Ok(result)
}

#[tauri::command]
async fn export_attendance_xlsx(
    state: State<'_, AppState>,
    token: String,
    date: String,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d").map_err(|_| "INVALID_DATE".to_string())?;
    let rows = crate::reporting::load_attendance_rows(&state.db, &date)
        .await
        .map_err(|e| e.to_string())?;
    let job_id = uuid::Uuid::new_v4().to_string();
    let artifact_id = uuid::Uuid::new_v4().to_string();
    let file_name = crate::reporting::attendance_artifact_filename(&date, &job_id[..8]);
    let output_path = state.exports_dir.join(&file_name);
    let relative_path = std::path::PathBuf::from("exports").join(&file_name);
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO export_jobs (job_id,kind,scope_json,format,status,requested_at,app_version,row_count,progress_total) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(&job_id).bind("ATTENDANCE_XLSX").bind(serde_json::json!({"date":date}).to_string()).bind("XLSX").bind("RUNNING").bind(&now).bind(env!("CARGO_PKG_VERSION")).bind(rows.len() as i64).bind(rows.len() as i64)
        .execute(&state.db).await.map_err(|e| e.to_string())?;
    if let Err(error) = (|| {
        std::fs::create_dir_all(output_path.parent().ok_or("EXPORT_PATH_ERROR")?)
            .map_err(|e| e.to_string())?;
        crate::reporting::generate_attendance_workbook(&rows, &date, &state.office, &output_path)
            .map_err(|e| e.to_string())
    })() {
        let _ = sqlx::query("UPDATE export_jobs SET status='FAILED',completed_at=?,error_code='ARTIFACT_GENERATION_FAILED',error_message=? WHERE job_id=?").bind(chrono::Utc::now().to_rfc3339()).bind(&error).bind(&job_id).execute(&state.db).await;
        return Err(error);
    }
    let bytes = std::fs::read(&output_path).map_err(|e| e.to_string())?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let completed = chrono::Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO generated_artifacts (artifact_id,job_id,document_id,kind,format,file_name,managed_relative_path,sha256,size_bytes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .bind(&artifact_id).bind(&job_id).bind(&job_id).bind("ATTENDANCE_XLSX").bind("XLSX").bind(&file_name).bind(relative_path.to_string_lossy().replace('\\', "/")).bind(&hash).bind(bytes.len() as i64).bind(&completed)
        .execute(&state.db).await.map_err(|e| e.to_string())?;
    sqlx::query("UPDATE export_jobs SET status='SUCCEEDED',completed_at=?,progress_current=progress_total WHERE job_id=?").bind(&completed).bind(&job_id).execute(&state.db).await.map_err(|e| e.to_string())?;
    let _ = sqlx::query("INSERT INTO audit_logs (log_id,timestamp,event_type,message,request_id) VALUES (?,?, 'EXPORT_GENERATED', ?, ?)").bind(uuid::Uuid::new_v4().to_string()).bind(&completed).bind(format!("Attendance XLSX generated for {date}")).bind(format!("export-{job_id}")).execute(&state.db).await;
    let metadata = generated_file_metadata(
        &state,
        &file_name,
        &output_path,
        "xlsx",
        format!("Attendance workbook generated for {date}."),
    );
    let mut response = metadata.as_object().cloned().unwrap_or_default();
    response.insert("jobId".into(), serde_json::json!(job_id));
    response.insert("artifactId".into(), serde_json::json!(artifact_id));
    response.insert("sizeBytes".into(), serde_json::json!(bytes.len()));
    response.insert("sha256".into(), serde_json::json!(hash));
    response.insert("rowCount".into(), serde_json::json!(rows.len()));
    Ok(serde_json::Value::Object(response))
}

#[tauri::command]
async fn export_payroll_xlsx(
    state: State<'_, AppState>,
    token: String,
    cutoff: Option<String>,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let rows = crate::reporting::load_payroll_rows(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    let filtered = cutoff
        .as_deref()
        .map(|value| {
            rows.iter()
                .filter(|row| {
                    row.cutoff_label == value
                        || row.cutoff_start == value
                        || row.cutoff_end == value
                })
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or(rows);
    let job_id = uuid::Uuid::new_v4().to_string();
    let artifact_id = uuid::Uuid::new_v4().to_string();
    let scope = cutoff.clone().unwrap_or_else(|| "all-cutoffs".to_string());
    let file_name = crate::reporting::payroll_artifact_filename(&scope, &job_id[..8]);
    let output_path = state.exports_dir.join(&file_name);
    let relative_path = std::path::PathBuf::from("exports").join(&file_name);
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO export_jobs (job_id,kind,scope_json,format,status,requested_at,app_version,row_count,progress_total) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(&job_id).bind("PAYROLL_XLSX").bind(serde_json::json!({"cutoff":cutoff}).to_string()).bind("XLSX").bind("RUNNING").bind(&now).bind(env!("CARGO_PKG_VERSION")).bind(filtered.len() as i64).bind(filtered.len() as i64).execute(&state.db).await.map_err(|e| e.to_string())?;
    if let Err(error) = (|| {
        std::fs::create_dir_all(output_path.parent().ok_or("EXPORT_PATH_ERROR")?)
            .map_err(|e| e.to_string())?;
        crate::reporting::generate_payroll_workbook(&filtered, &scope, &state.office, &output_path)
            .map_err(|e| e.to_string())
    })() {
        let _ = sqlx::query("UPDATE export_jobs SET status='FAILED',completed_at=?,error_code='ARTIFACT_GENERATION_FAILED',error_message=? WHERE job_id=?").bind(chrono::Utc::now().to_rfc3339()).bind(&error).bind(&job_id).execute(&state.db).await;
        return Err(error);
    }
    let bytes = std::fs::read(&output_path).map_err(|e| e.to_string())?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let completed = chrono::Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO generated_artifacts (artifact_id,job_id,document_id,kind,format,file_name,managed_relative_path,sha256,size_bytes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(&artifact_id).bind(&job_id).bind(&job_id).bind("PAYROLL_XLSX").bind("XLSX").bind(&file_name).bind(relative_path.to_string_lossy().replace('\\', "/")).bind(&hash).bind(bytes.len() as i64).bind(&completed).execute(&state.db).await.map_err(|e| e.to_string())?;
    sqlx::query("UPDATE export_jobs SET status='SUCCEEDED',completed_at=?,progress_current=progress_total WHERE job_id=?").bind(&completed).bind(&job_id).execute(&state.db).await.map_err(|e| e.to_string())?;
    let metadata = generated_file_metadata(
        &state,
        &file_name,
        &output_path,
        "xlsx",
        format!("Payroll workbook generated for {scope}."),
    );
    let mut response = metadata.as_object().cloned().unwrap_or_default();
    response.insert("jobId".into(), serde_json::json!(job_id));
    response.insert("artifactId".into(), serde_json::json!(artifact_id));
    response.insert("sizeBytes".into(), serde_json::json!(bytes.len()));
    response.insert("sha256".into(), serde_json::json!(hash));
    response.insert("rowCount".into(), serde_json::json!(filtered.len()));
    Ok(serde_json::Value::Object(response))
}

#[tauri::command]
async fn generate_payroll_payslip_pdf(
    state: State<'_, AppState>,
    token: String,
    payroll_id: String,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let row = sqlx::query("SELECT payroll_id,employee_id,employee_name,payroll_profile_id,payroll_cutoff_label,cutoff_start,cutoff_end,basic_pay_centavos,total_allowance_centavos,incentives_allowance_centavos,late_deduction_centavos,manual_adjustment_centavos,gross_compensation_centavos,net_pay_centavos,status FROM payroll_cutoffs WHERE payroll_id=?").bind(&payroll_id).fetch_optional(&state.db).await.map_err(|e| e.to_string())?.ok_or_else(|| "PAYROLL_NOT_FOUND".to_string())?;
    let payroll = crate::reporting::PayrollExportRow {
        payroll_id: row.get("payroll_id"),
        employee_id: row.get("employee_id"),
        employee_name: row.get("employee_name"),
        profile: row.get("payroll_profile_id"),
        cutoff_label: row.get("payroll_cutoff_label"),
        cutoff_start: row.get("cutoff_start"),
        cutoff_end: row.get("cutoff_end"),
        basic_pay_centavos: row.get("basic_pay_centavos"),
        allowances_centavos: row.get("total_allowance_centavos"),
        incentives_centavos: row.get("incentives_allowance_centavos"),
        late_deduction_centavos: row.get("late_deduction_centavos"),
        other_adjustments_centavos: row.get("manual_adjustment_centavos"),
        gross_centavos: row.get("gross_compensation_centavos"),
        net_centavos: row.get("net_pay_centavos"),
        status: row.get("status"),
    };
    let job_id = uuid::Uuid::new_v4().to_string();
    let artifact_id = uuid::Uuid::new_v4().to_string();
    let file_name = crate::reporting::payroll_pdf_filename(
        &payroll.payroll_id,
        &payroll.cutoff_label,
        &job_id[..8],
    );
    let relative_path = std::path::PathBuf::from("exports").join(&file_name);
    let output_path = state.exports_dir.join(&file_name);
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO export_jobs (job_id,kind,scope_json,format,status,requested_at,app_version,row_count,progress_total) VALUES (?,?,?,?,?,?,?,?,?)").bind(&job_id).bind("PAYSLIP_PDF").bind(serde_json::json!({"payrollId":payroll_id}).to_string()).bind("PDF").bind("RUNNING").bind(&now).bind(env!("CARGO_PKG_VERSION")).bind(1_i64).bind(1_i64).execute(&state.db).await.map_err(|e| e.to_string())?;
    if let Err(error) = (|| {
        std::fs::create_dir_all(output_path.parent().ok_or("EXPORT_PATH_ERROR")?)
            .map_err(|e| e.to_string())?;
        crate::reporting::generate_payroll_pdf(&payroll, &state.office, &output_path)
    })() {
        let _ = sqlx::query("UPDATE export_jobs SET status='FAILED',completed_at=?,error_code='ARTIFACT_GENERATION_FAILED',error_message=? WHERE job_id=?").bind(chrono::Utc::now().to_rfc3339()).bind(&error).bind(&job_id).execute(&state.db).await;
        return Err(error);
    }
    let bytes = std::fs::read(&output_path).map_err(|e| e.to_string())?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let completed = chrono::Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO generated_artifacts (artifact_id,job_id,document_id,kind,format,file_name,managed_relative_path,sha256,size_bytes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(&artifact_id).bind(&job_id).bind(&payroll.payroll_id).bind("PAYSLIP_PDF").bind("PDF").bind(&file_name).bind(relative_path.to_string_lossy().replace('\\', "/")).bind(&hash).bind(bytes.len() as i64).bind(&completed).execute(&state.db).await.map_err(|e| e.to_string())?;
    sqlx::query("UPDATE export_jobs SET status='SUCCEEDED',completed_at=?,progress_current=progress_total WHERE job_id=?").bind(&completed).bind(&job_id).execute(&state.db).await.map_err(|e| e.to_string())?;
    let metadata = generated_file_metadata(
        &state,
        &file_name,
        &output_path,
        "pdf",
        format!("Payslip PDF generated for {}.", payroll.employee_name),
    );
    let mut response = metadata.as_object().cloned().unwrap_or_default();
    response.insert("jobId".into(), serde_json::json!(job_id));
    response.insert("artifactId".into(), serde_json::json!(artifact_id));
    response.insert("sizeBytes".into(), serde_json::json!(bytes.len()));
    response.insert("sha256".into(), serde_json::json!(hash));
    response.insert("status".into(), serde_json::json!(payroll.status));
    Ok(serde_json::Value::Object(response))
}

#[tauri::command]
async fn generate_payroll_register_pdf(
    state: State<'_, AppState>,
    token: String,
    cutoff: Option<String>,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let rows = crate::reporting::load_payroll_rows(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    let filtered = cutoff
        .as_deref()
        .map(|value| {
            rows.iter()
                .filter(|row| {
                    row.cutoff_label == value
                        || row.cutoff_start == value
                        || row.cutoff_end == value
                })
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or(rows);
    let scope = cutoff.unwrap_or_else(|| "all-cutoffs".into());
    let job_id = uuid::Uuid::new_v4().to_string();
    let artifact_id = uuid::Uuid::new_v4().to_string();
    let file_name = crate::reporting::payroll_register_pdf_filename(&scope, &job_id[..8]);
    let output = state.exports_dir.join(&file_name);
    let relative = std::path::PathBuf::from("exports").join(&file_name);
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO export_jobs (job_id,kind,scope_json,format,status,requested_at,app_version,row_count,progress_total) VALUES (?,?,?,?,?,?,?,?,?)").bind(&job_id).bind("PAYROLL_REGISTER_PDF").bind(serde_json::json!({"cutoff":scope}).to_string()).bind("PDF").bind("RUNNING").bind(&now).bind(env!("CARGO_PKG_VERSION")).bind(filtered.len() as i64).bind(filtered.len() as i64).execute(&state.db).await.map_err(|e| e.to_string())?;
    if let Err(error) = (|| {
        std::fs::create_dir_all(output.parent().ok_or("EXPORT_PATH_ERROR")?)
            .map_err(|e| e.to_string())?;
        crate::reporting::generate_payroll_register_pdf(&filtered, &scope, &state.office, &output)
    })() {
        let _ = sqlx::query("UPDATE export_jobs SET status='FAILED',completed_at=?,error_code='ARTIFACT_GENERATION_FAILED',error_message=? WHERE job_id=?").bind(chrono::Utc::now().to_rfc3339()).bind(&error).bind(&job_id).execute(&state.db).await;
        return Err(error);
    }
    let bytes = std::fs::read(&output).map_err(|e| e.to_string())?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let completed = chrono::Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO generated_artifacts (artifact_id,job_id,document_id,kind,format,file_name,managed_relative_path,sha256,size_bytes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(&artifact_id).bind(&job_id).bind(&job_id).bind("PAYROLL_REGISTER_PDF").bind("PDF").bind(&file_name).bind(relative.to_string_lossy().replace('\\', "/")).bind(&hash).bind(bytes.len() as i64).bind(&completed).execute(&state.db).await.map_err(|e| e.to_string())?;
    sqlx::query("UPDATE export_jobs SET status='SUCCEEDED',completed_at=?,progress_current=progress_total WHERE job_id=?").bind(&completed).bind(&job_id).execute(&state.db).await.map_err(|e| e.to_string())?;
    let metadata = generated_file_metadata(
        &state,
        &file_name,
        &output,
        "pdf",
        format!("Payroll register PDF generated for {scope}."),
    );
    let mut response = metadata.as_object().cloned().unwrap_or_default();
    response.insert("jobId".into(), serde_json::json!(job_id));
    response.insert("artifactId".into(), serde_json::json!(artifact_id));
    response.insert("sizeBytes".into(), serde_json::json!(bytes.len()));
    response.insert("sha256".into(), serde_json::json!(hash));
    response.insert("rowCount".into(), serde_json::json!(filtered.len()));
    Ok(serde_json::Value::Object(response))
}

#[tauri::command]
async fn open_generated_artifact(
    state: State<'_, AppState>,
    token: String,
    artifact_id: String,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let relative: String = sqlx::query_scalar("SELECT managed_relative_path FROM generated_artifacts WHERE artifact_id=? AND state='AVAILABLE'").bind(&artifact_id).fetch_optional(&state.db).await.map_err(|e| e.to_string())?.ok_or_else(|| "ARTIFACT_NOT_FOUND".to_string())?;
    let root =
        std::fs::canonicalize(&state.data_dir).map_err(|_| "ARTIFACT_PATH_ERROR".to_string())?;
    let path = root.join(&relative);
    let canonical = std::fs::canonicalize(&path).map_err(|_| "ARTIFACT_NOT_FOUND".to_string())?;
    if !canonical.starts_with(&root) {
        return Err("ARTIFACT_PATH_ERROR".into());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg("/select,")
            .arg(&canonical)
            .spawn()
            .map_err(|_| "ARTIFACT_OPEN_FAILED".to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = canonical;
    }
    Ok(serde_json::json!({"success":true,"artifactId":artifact_id}))
}

async fn admin_authorized(state: &AppState, token: &str) -> bool {
    let mut session = state.admin_session.lock().await;
    if let Some(value) = session.as_ref() {
        if value.token == token && value.expires_at > std::time::Instant::now() {
            return true;
        }
    }
    *session = None;
    false
}

async fn enqueue_sync(
    state: &AppState,
    table_name: &str,
    row_id: &str,
    operation: &str,
    payload: &serde_json::Value,
) {
    let now = chrono::Utc::now().to_rfc3339();
    let idempotency_key = format!("{table_name}:{row_id}:{operation}");
    let _ = sqlx::query("INSERT INTO sync_queue (table_name,row_id,operation,payload_json,attempts,next_attempt_at,created_at,updated_at,idempotency_key) VALUES (?,?,?,?,0,?,?,?,?) ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json,status='PENDING',next_attempt_at=excluded.next_attempt_at,updated_at=excluded.updated_at,last_error=NULL,last_error_code=NULL")
        .bind(table_name).bind(row_id).bind(operation).bind(payload.to_string()).bind(&now).bind(&now).bind(&now).bind(&idempotency_key).execute(&state.db).await;
}

#[tauri::command]
async fn scan_rfid(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let uid = request
        .get("rfidUid")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_uppercase();
    let source = request
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or("RFID");
    let received_at = chrono::Utc::now().to_rfc3339();
    let _ = sqlx::query("INSERT INTO audit_logs (log_id,timestamp,event_type,rfid_uid,message,request_id) VALUES (?,?, 'SCAN_RECEIVED', ?, ?, ?)").bind(uuid::Uuid::new_v4().to_string()).bind(&received_at).bind(if uid.is_empty() { None } else { Some(uid.as_str()) }).bind(format!("Scan request received from {source}")).bind(&request_id).execute(&state.db).await;
    let valid_uid = source == "MANUAL_TEST"
        || (uid.len() >= 4 && uid.len() <= 64 && uid.bytes().all(|byte| byte.is_ascii_hexdigit()));
    if uid.is_empty() || !valid_uid || !matches!(source, "RFID" | "MANUAL_TEST") {
        return Ok(
            serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"INVALID_SCAN_INPUT","message":"rfidUid and source are required."}}),
        );
    }
    let now = chrono::Utc::now();
    {
        let mut guard = state.scan_guard.lock().await;
        if guard
            .get(&uid)
            .is_some_and(|last| last.elapsed().as_millis() < 500)
        {
            return Ok(
                serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"DUPLICATE_SCAN","message":"This card was scanned too recently."}}),
            );
        }
        guard.insert(uid.clone(), Instant::now());
    }
    {
        let cooldown = state.physical_cooldown.lock().await;
        if cooldown
            .get(&uid)
            .is_some_and(|last| last.elapsed().as_secs() < 10)
        {
            return Ok(
                serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"DUPLICATE_SCAN","message":"This card was scanned too recently.","retryAfterSeconds":10}}),
            );
        }
    }
    let user = match sqlx::query("SELECT user_id, full_name, department, employee_type, daily_rate_centavos, photo_url, status, gender FROM users WHERE rfid_uid = ?")
        .bind(&uid).fetch_optional(&state.db).await {
        Ok(Some(row)) => row,
        Ok(None) => return Ok(serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"UNKNOWN_RFID_CARD","message":"This RFID card is not registered."}})),
        Err(_) => return Ok(serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"INTERNAL_SERVER_ERROR","message":"Attendance data is unavailable."}})),
    };
    let status: String = user.get("status");
    if status != "ACTIVE" {
        return Ok(
            serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"INACTIVE_USER","message":"This user is inactive."}}),
        );
    }
    let user_id: String = user.get("user_id");
    let date = now.with_timezone(&Manila).date_naive().to_string();
    let timestamp = now.with_timezone(&Manila).to_rfc3339();
    let existing = sqlx::query("SELECT attendance_id, time_in, time_out, status, revision FROM attendance WHERE user_id = ? AND attendance_date = ?")
        .bind(&user_id).bind(&date).fetch_optional(&state.db).await.ok().flatten();
    let (attendance_id, action, time_in, time_out, attendance_status) = match existing {
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            let result = sqlx::query("INSERT INTO attendance (attendance_id, attendance_date, user_id, rfid_uid, full_name, department, time_in, time_out, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'WORKING', ?, ?, ?)")
                .bind(&id).bind(&date).bind(&user_id).bind(&uid).bind(user.get::<String,_>("full_name")).bind(user.get::<Option<String>,_>("department")).bind(&timestamp).bind(source).bind(&timestamp).bind(&timestamp).execute(&state.db).await;
            if result.is_err() {
                return Ok(
                    serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"INTERNAL_SERVER_ERROR","message":"Unable to save attendance."}}),
                );
            }
            (id, "TIME_IN", Some(timestamp.clone()), None, "WORKING")
        }
        Some(row) => {
            let id: String = row.get("attendance_id");
            let tin: Option<String> = row.get("time_in");
            let tout: Option<String> = row.get("time_out");
            if tout.is_some() {
                let existing_status: String = row.get("status");
                let message = if existing_status == "LATE_TIMEOUT" {
                    "Attendance timed out after office hours and is pending manual correction."
                } else {
                    "Attendance is already complete for today."
                };
                return Ok(
                    serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"ATTENDANCE_ALREADY_COMPLETED","message":message}}),
                );
            }
            if tin.is_none() {
                return Ok(
                    serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"ATTENDANCE_DATA_CONFLICT","message":"Attendance data is inconsistent."}}),
                );
            }
            // The office does not allow overtime: a time-out after office
            // hours is saved as LATE_TIMEOUT (pending manual correction),
            // never as a normal COMPLETED shift.
            let late = crate::services::office_hours::is_late_timeout(&timestamp);
            let new_status = if late { "LATE_TIMEOUT" } else { "COMPLETED" };
            let result = sqlx::query("UPDATE attendance SET time_out = ?, status = ?, revision = revision + 1, updated_at = ? WHERE attendance_id = ? AND revision = ? AND time_out IS NULL")
                .bind(&timestamp).bind(new_status).bind(&timestamp).bind(&id).bind(row.get::<i64,_>("revision")).execute(&state.db).await;
            if result.map(|r| r.rows_affected()).unwrap_or(0) != 1 {
                return Ok(
                    serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"ATTENDANCE_DATA_CONFLICT","message":"Attendance changed before the scan was saved."}}),
                );
            }
            (id, "TIME_OUT", tin, Some(timestamp.clone()), new_status)
        }
    };
    let seq = state.next_sequence();
    state
        .physical_cooldown
        .lock()
        .await
        .insert(uid.clone(), Instant::now());
    if action == "TIME_OUT" && attendance_status == "COMPLETED" {
        if let (Some(actual_in), Some(actual_out)) = (time_in.as_deref(), time_out.as_deref()) {
            let employee_type: String = user.get("employee_type");
            let daily_rate: Option<i64> = user.get("daily_rate_centavos");
            if let Err(error) = ensure_payroll(
                &state,
                &attendance_id,
                &user_id,
                user.get::<String, _>("full_name"),
                &employee_type,
                daily_rate,
                &date,
                actual_in,
                actual_out,
            )
            .await
            {
                return Ok(
                    serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"PAYROLL_GENERATION_FAILED","message":error}}),
                );
            }
        }
    }
    let _ = state
        .bus
        .sender
        .send(crate::lan_server::LanAttendanceEvent::AttendanceUpdated {
            event_id: format!("{}:{}", state.server_instance_id, seq),
            server_instance_id: state.server_instance_id.to_string(),
            sequence: seq,
            occurred_at: now,
            request_id: request_id.clone(),
            attendance_date: date.clone(),
            attendance_id: attendance_id.clone(),
            cause: action.to_string(),
            mutation: "upsert".into(),
            attendance: Some(crate::lan_server::LanAttendanceRow {
                attendance_id: attendance_id.clone(),
                attendance_date: date.clone(),
                user_id: user_id.clone(),
                full_name: user.get::<String, _>("full_name"),
                department: user.get::<Option<String>, _>("department"),
                time_in: time_in.clone(),
                time_out: time_out.clone(),
                status: attendance_status.to_string(),
            }),
        });
    let _ = app.emit("attendance-updated", serde_json::json!({"attendanceId":attendance_id.clone(),"attendanceDate":date.clone(),"action":action,"sequence":seq}));
    let _ = sqlx::query("INSERT INTO audit_logs (log_id, timestamp, event_type, rfid_uid, user_id, message, request_id) VALUES (?, ?, 'SCAN_SUCCESS', ?, ?, ?, ?)").bind(uuid::Uuid::new_v4().to_string()).bind(&timestamp).bind(&uid).bind(&user_id).bind(format!("{} recorded", action)).bind(&request_id).execute(&state.db).await;
    let payload = serde_json::json!({"attendanceId":attendance_id,"attendanceDate":date,"userId":user_id,"action":action,"timeIn":time_in,"timeOut":time_out});
    enqueue_sync(
        &state,
        "Attendance",
        payload
            .get("attendanceId")
            .and_then(|v| v.as_str())
            .unwrap_or_default(),
        "UPSERT",
        &payload,
    )
    .await;
    Ok(
        serde_json::json!({"success":true,"requestId":request_id,"action":action,"message":if action == "TIME_IN" { "Time In recorded successfully." } else { "Time Out recorded successfully." },"attendance":{"attendanceId":attendance_id,"attendanceDate":date,"timeIn":time_in,"timeOut":time_out,"status":attendance_status},"user":{"userId":user_id,"fullName":user.get::<String,_>("full_name"),"department":user.get::<Option<String>,_>("department"),"employeeType":user.get::<String,_>("employee_type"),"gender":user.get::<Option<String>,_>("gender"),"photoUrl":user.get::<Option<String>,_>("photo_url")}}),
    )
}

async fn ensure_payroll(
    state: &AppState,
    attendance_id: &str,
    user_id: &str,
    full_name: String,
    employee_type: &str,
    daily_rate: Option<i64>,
    date: &str,
    actual_in: &str,
    actual_out: &str,
) -> Result<(), String> {
    if sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM payroll WHERE attendance_id=?")
        .bind(attendance_id)
        .fetch_one(&state.db)
        .await
        .map_err(|e| e.to_string())?
        > 0
    {
        return Ok(());
    }
    let (computed_in, computed_out, grace_used, late_hours, deduction, base_pay, daily_pay) =
        if employee_type == "EMPLOYEE" {
            let result = crate::services::employee_payroll::calculate(
                actual_in,
                actual_out,
                daily_rate.unwrap_or(0),
            )?;
            (
                result.computed_time_in,
                result.computed_time_out,
                None,
                result.late_hours,
                result.late_deduction_centavos,
                result.base_pay_centavos,
                result.daily_pay_centavos,
            )
        } else {
            let date_value =
                chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|e| e.to_string())?;
            let week_start = date_value
                - chrono::Duration::days(date_value.weekday().num_days_from_monday() as i64);
            let grace_available = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM intern_grace WHERE user_id=? AND week_start=?",
            )
            .bind(user_id)
            .bind(week_start.to_string())
            .fetch_one(&state.db)
            .await
            .map_err(|e| e.to_string())?
                == 0;
            let result = crate::services::intern_payroll::calculate(
                date,
                actual_in,
                actual_out,
                grace_available,
            )?;
            if result.grace_used {
                let grace_id = uuid::Uuid::new_v4().to_string();
                let used_at = chrono::Utc::now().to_rfc3339();
                sqlx::query("INSERT OR IGNORE INTO intern_grace (grace_id,user_id,week_start,attendance_id,used_at) VALUES (?,?,?,?,?)").bind(&grace_id).bind(user_id).bind(week_start.to_string()).bind(attendance_id).bind(&used_at).execute(&state.db).await.map_err(|e| e.to_string())?;
                enqueue_sync(state, "InternGrace", &grace_id, "UPSERT", &serde_json::json!({"graceId":grace_id,"userId":user_id,"weekStart":week_start.to_string(),"attendanceId":attendance_id,"usedAt":used_at})).await;
            }
            (
                result.computed_time_in,
                result.computed_time_out,
                Some(result.grace_used),
                result.late_hours,
                result.late_deduction_centavos,
                result.base_pay_centavos,
                result.daily_pay_centavos,
            )
        };
    let now = chrono::Utc::now().to_rfc3339();
    let payroll_id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT OR IGNORE INTO payroll (payroll_id,attendance_id,user_id,full_name,employee_type,attendance_date,actual_time_in,actual_time_out,computed_time_in,computed_time_out,grace_used,late_hours,late_deduction_centavos,base_pay_centavos,daily_pay_centavos,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(&payroll_id).bind(attendance_id).bind(user_id).bind(&full_name).bind(employee_type).bind(date).bind(actual_in).bind(actual_out).bind(&computed_in).bind(&computed_out).bind(grace_used.map(|v| if v {1} else {0})).bind(late_hours).bind(deduction).bind(base_pay).bind(daily_pay).bind(&now).bind(&now).execute(&state.db).await.map_err(|e| e.to_string())?;
    enqueue_sync(state, "Payroll", &payroll_id, "UPSERT", &serde_json::json!({"payrollId":payroll_id,"attendanceId":attendance_id,"userId":user_id,"employeeType":employee_type,"attendanceDate":date,"actualTimeIn":actual_in,"actualTimeOut":actual_out,"computedTimeIn":computed_in,"computedTimeOut":computed_out,"lateHours":late_hours,"lateDeductionCentavos":deduction,"dailyPayCentavos":daily_pay})).await;
    Ok(())
}

#[tauri::command]
async fn upload_photo(
    state: State<'_, AppState>,
    token: String,
    user_id: String,
    base64_data: String,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("SETUP_AUTH_REQUIRED".into());
    }
    if user_id.is_empty()
        || user_id.len() > 128
        || !user_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("INVALID_USER_ID".into());
    }
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(
            base64_data
                .split_once(',')
                .map(|(_, value)| value)
                .unwrap_or(&base64_data),
        )
        .map_err(|_| "INVALID_IMAGE".to_string())?;
    if bytes.len() > MAX_PHOTO_BYTES {
        return Err("IMAGE_TOO_LARGE".into());
    }
    let image = image::load_from_memory(&bytes).map_err(|_| "INVALID_IMAGE_FORMAT".to_string())?;
    if !photo_is_within_limits(image.width(), image.height(), bytes.len()) {
        return Err("IMAGE_DIMENSIONS_EXCEEDED".into());
    }
    let photos = state.data_dir.join("photos");
    std::fs::create_dir_all(&photos).map_err(|e| e.to_string())?;
    let path = photos.join(format!("{user_id}.webp"));
    image
        .save_with_format(&path, image::ImageFormat::WebP)
        .map_err(|e| e.to_string())?;
    let asset_path = path.to_string_lossy().replace('\\', "/");
    Ok(serde_json::json!({"success":true,"photoUrl":format!("asset://localhost/{asset_path}")}))
}

const MAX_PHOTO_BYTES: usize = 500 * 1024;

fn photo_is_within_limits(width: u32, height: u32, bytes: usize) -> bool {
    width <= 4096 && height <= 4096 && bytes <= MAX_PHOTO_BYTES
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_log::Builder::default().build());

    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_mcp_bridge::init());

    builder
        .setup(|app| {
            let paths = crate::paths::resolve(app.handle())
                .expect("resolve application paths");
            std::fs::create_dir_all(&paths.config_dir).expect("create application config directory");
            let (lan, office, scanner_config, database_config) = config::load_config(&paths.config_dir).expect("valid config.toml");
            let db_path = crate::paths::resolve_db_path(&paths.config_dir, &paths.data_dir, &database_config);
            // Apply any pending database restore (admin flow marker or
            // ALPHA_PREMIER_RESTORE_FROM) before the database is opened, so
            // the live file is never touched by two processes. A failed
            // restore never blocks startup: the app keeps its current DB and
            // records the problem in `restore.failed`.
            match tauri::async_runtime::block_on(crate::database::process_restore_request(
                &paths.data_dir,
                &db_path,
            )) {
                crate::database::RestoreOutcome::None => {}
                crate::database::RestoreOutcome::Restored { source } => {
                    log::info!("startup restore applied from {}", source.display());
                }
                crate::database::RestoreOutcome::SkippedMissingSource { source } => {
                    log::warn!(
                        "startup restore skipped: source {} was missing",
                        source.display()
                    );
                }
                crate::database::RestoreOutcome::Failed { source, error } => {
                    log::error!(
                        "startup restore failed (source {}): {}; keeping current database",
                        source.display(),
                        error
                    );
                }
            }
            let state = tauri::async_runtime::block_on(AppState::new(
                paths.data_dir.clone(),
                db_path,
                paths.exports_dir.clone(),
                paths.is_portable,
                lan,
                office,
                scanner_config,
            ))
            .expect("SQLite initialization");
            if state.lan.enabled {
                let runtime = state.lan_runtime.clone();
                let server_state = state.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = runtime.start(&server_state).await;
                });
            }
            let sync_state = state.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    let endpoint = sync_state.lan.sheets_sync_endpoint.as_deref();
                    let _ = crate::services::sheets_sync::run_once(&sync_state, endpoint).await;
                    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                }
            });
            // Native scanner pipeline: global keyboard-wedge hook (default) or
            // raw HID reader, normalized into `rfid-scan` events. The webview
            // never needs a focused input for card taps.
            let scanner_handle = state.scanner.clone();
            app.manage(state);
            // Best-effort automatic database backup on clean exit. The backup
            // uses SQLite's online engine, so it is consistent even while the
            // app has been recording scans, and a failed backup never blocks
            // closing the app.
            if let Some(window) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { .. } = event {
                        let handle = handle.clone();
                        if let Some(state) = handle.try_state::<AppState>() {
                            let data_dir = state.data_dir.clone();
                            let db = state.db.clone();
                            let _ = tauri::async_runtime::block_on(async move {
                                match crate::database::create_backup(&db, &data_dir).await {
                                    Ok(path) => log::info!(
                                        "automatic backup on exit saved to {}",
                                        path.display()
                                    ),
                                    Err(error) => log::warn!(
                                        "automatic backup on exit skipped: {error}"
                                    ),
                                }
                            });
                        }
                    }
                });
            }
            crate::services::scanner::start(app.handle().clone(), scanner_handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_health,
            get_config,
            get_attendance,
            scan_rfid,
            scanner_status,
            scanner_pause,
            print_payroll,
            upload_photo,
            admin_users,
            admin_list_users,
            admin_upsert_user,
            admin_create_user,
            admin_update_user,
            admin_delete_user,
            admin_attendance,
            admin_list_attendance,
            admin_update_attendance,
            admin_delete_attendance,
            payroll_calculate_cutoff,
            payroll_list_profiles,
            payroll_upsert_profile,
            payroll_list_cutoffs,
            payroll_create_cutoff,
            payroll_update_cutoff,
            payroll_finalize_cutoff,
            payroll_export_csv,
            export_attendance_xlsx,
            export_payroll_xlsx,
            generate_payroll_payslip_pdf,
            generate_payroll_register_pdf,
            open_generated_file,
            reveal_generated_file,
            open_generated_directory,
            open_generated_artifact,
            db_info,
            db_backup,
            db_restore_request,
            db_open_backups_dir,
            setup_unlock,
            setup_lock,
            setup_lookup_card,
            setup_upsert_user,
            admin_unlock,
            admin_get_session,
            admin_lock,
            admin_get_sync_status,
            admin_retry_sync_item,
            admin_sync_now,
            admin_sheets_nuke_resync,
            lan_status,
            lan_start,
            lan_stop,
            open_viewer_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running Alpha Premier Attendance");
}

#[cfg(test)]
mod tests {
    use super::{canonical_exports_path, enrich_cutoff_input, generated_file_metadata, php_to_centavos, photo_is_within_limits};
    use crate::config::{LanConfig, OfficeConfig};
    use crate::state::AppState;
    use sqlx::sqlite::SqlitePoolOptions;

    #[tokio::test]
    async fn enriches_cutoff_input_from_the_selected_employee() {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory database");
        sqlx::query("CREATE TABLE users (user_id TEXT PRIMARY KEY, full_name TEXT NOT NULL, daily_rate_centavos INTEGER)")
            .execute(&db)
            .await
            .expect("users table");
        sqlx::query("INSERT INTO users (user_id, full_name, daily_rate_centavos) VALUES (?, ?, ?)")
            .bind("EMP-1")
            .bind("Ada Lovelace")
            .bind(50_000_i64)
            .execute(&db)
            .await
            .expect("employee row");

        let input = serde_json::json!({"employeeId":"EMP-1","cutoffStart":"2026-08-01","cutoffEnd":"2026-08-15"});
        let enriched = enrich_cutoff_input(&db, &input).await.expect("enriched input");

        assert_eq!(enriched["employeeName"], "Ada Lovelace");
        assert_eq!(enriched["dailyRate"], 500.0);
    }

    #[tokio::test]
    async fn applies_fixed_intern_rules_to_intern_cutoff_input() {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory database");
        sqlx::query("CREATE TABLE users (user_id TEXT PRIMARY KEY, full_name TEXT NOT NULL, daily_rate_centavos INTEGER, employee_type TEXT NOT NULL)")
            .execute(&db)
            .await
            .expect("users table");
        sqlx::query("INSERT INTO users (user_id, full_name, daily_rate_centavos, employee_type) VALUES (?, ?, ?, ?)")
            .bind("INT-1")
            .bind("Maria Santos")
            .bind(0_i64)
            .bind("INTERN")
            .execute(&db)
            .await
            .expect("intern row");

        // Submitted rate/allowances are ignored; the fixed PHP 80/day and
        // PHP 10/hour late deduction rules are enforced for interns.
        let mut input = serde_json::json!({
            "employeeId": "INT-1", "dailyRate": 500.0, "lateUnits": 3.0,
            "incentivesAllowance": 100.0, "specialHolidayDays": 1.0,
        });
        super::apply_intern_rules(&db, &mut input).await.expect("intern rules applied");

        assert_eq!(input["dailyRate"], 80.0);
        assert_eq!(input["lateDeduction"], 30.0);
        assert_eq!(input["payrollProfileId"], "INTERN_STANDARD");
        assert_eq!(input["incentivesAllowance"], 0.0);
        assert_eq!(input["specialHolidayDays"], 0.0);

        // Employees keep their own values untouched.
        sqlx::query("INSERT INTO users (user_id, full_name, daily_rate_centavos, employee_type) VALUES (?, ?, ?, ?)")
            .bind("EMP-1")
            .bind("Ada Lovelace")
            .bind(50_000_i64)
            .bind("EMPLOYEE")
            .execute(&db)
            .await
            .expect("employee row");
        let mut employee_input = serde_json::json!({"employeeId": "EMP-1", "dailyRate": 500.0, "lateUnits": 1.0});
        super::apply_intern_rules(&db, &mut employee_input).await.expect("employee rules pass through");
        assert_eq!(employee_input["dailyRate"], 500.0);
        assert_eq!(employee_input.get("lateDeduction"), None);
    }

    #[test]
    fn accepts_large_id_photo_dimensions_and_file_size() {
        assert!(!photo_is_within_limits(1993, 3137, 3_277_122));
    }

    #[test]
    fn accepts_photos_at_or_below_500_kib() {
        assert!(photo_is_within_limits(512, 512, 500 * 1024));
        assert!(!photo_is_within_limits(512, 512, 500 * 1024 + 1));
    }

    #[test]
    fn php_to_centavos_preserves_fractional_pesos() {
        assert_eq!(php_to_centavos(123.45), 12_345);
        assert_eq!(php_to_centavos(0.01), 1);
    }

    #[test]
    fn php_to_centavos_rounds_fractional_centavos() {
        assert_eq!(php_to_centavos(12.344), 1_234);
        assert_eq!(php_to_centavos(12.345), 1_235);
        assert_eq!(php_to_centavos(12.346), 1_235);
    }

    #[test]
    fn generated_file_metadata_is_structured_and_absolute() {
        let temp = std::env::temp_dir().join(format!("alpha-meta-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(temp.join("exports")).unwrap();
        let data_dir = temp.clone();
        let exports_dir = temp.join("exports");
        let state = tauri::async_runtime::block_on(AppState::new(
            data_dir.clone(),
            data_dir.join("attendance.db"),
            exports_dir.clone(),
            true,
            LanConfig::default(),
            OfficeConfig::default(),
            crate::config::ScannerConfig::default(),
        ))
        .unwrap();
        let file_path = exports_dir.join("payroll-2026-08-04.csv");
        let metadata = generated_file_metadata(
            &state,
            "payroll-2026-08-04.csv",
            &file_path,
            "csv",
            "Payroll CSV generated.".into(),
        );
        assert_eq!(metadata["success"], true);
        assert_eq!(metadata["fileKind"], "csv");
        assert_eq!(metadata["isPortableMode"], true);
        assert_eq!(metadata["fileName"], "payroll-2026-08-04.csv");
        assert_eq!(metadata["directoryPath"], exports_dir.to_string_lossy().as_ref());
        assert_eq!(metadata["filePath"], file_path.to_string_lossy().as_ref());
        assert!(metadata["message"].as_str().unwrap().contains("Payroll CSV generated"));
        tauri::async_runtime::block_on(state.db.close());
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[tokio::test]
    async fn export_path_validation_rejects_paths_outside_the_exports_root() {
        let temp = std::env::temp_dir().join(format!("alpha-paths-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(temp.join("exports")).unwrap();
        let data_dir = temp.clone();
        let exports_dir = temp.join("exports");
        let state = AppState::new(
            data_dir.clone(),
            data_dir.join("attendance.db"),
            exports_dir.clone(),
            false,
            LanConfig::default(),
            OfficeConfig::default(),
            crate::config::ScannerConfig::default(),
        )
        .await
        .unwrap();
        let inside = exports_dir.join("sample.csv");
        std::fs::write(&inside, "a,b\n").unwrap();
        assert!(canonical_exports_path(&state, &inside).is_ok());
        let outside = data_dir.join("outside.txt");
        std::fs::write(&outside, "secret").unwrap();
        assert!(canonical_exports_path(&state, &outside).is_err());
        assert!(canonical_exports_path(&state, &exports_dir.join("missing.csv")).is_err());
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }
}
