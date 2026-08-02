mod config;
mod error;
mod lan_server;
pub mod reporting;
mod services;
mod state;

use chrono::Datelike;
use chrono_tz::Asia::Manila;
use config::LanConfig;
use sha2::{Digest, Sha256};
use sqlx::Row;
use state::{AdminSession, AppState};
use std::{path::PathBuf, time::Instant};
use tauri::{Emitter, Manager, State};

#[tauri::command]
fn get_health(state: State<'_, AppState>) -> serde_json::Value {
    serde_json::json!({"success":true,"service":"rfid-attendance-api","timestamp":chrono::Utc::now(),"timezone":"Asia/Manila","sqlite":"connected","lanEnabled":state.lan.enabled,"lan":{"bindAddress":state.lan.bind_address.map(|v|v.to_string()),"port":state.lan.port,"connectedSseClients":state.connected_sse_clients.load(std::sync::atomic::Ordering::Relaxed)},"googleSheetsExport":if state.lan.sheets_sync_endpoint.is_some() || state.lan.google_spreadsheet_id.is_some() { "configured" } else { "disabled" }})
}

#[tauri::command]
fn get_config(state: State<'_, AppState>) -> serde_json::Value {
    serde_json::json!({"success":true,"timezone":"Asia/Manila","rfidAutoSubmitDelayMs":150,"enableScanSounds":false,"resultResetDelayMs":4000,"enableAdmin":true,"enableCardSetup":true,"lanEnabled":state.lan.enabled})
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
    let rows = sqlx::query("SELECT user_id, rfid_uid, full_name, department, status, employee_type, daily_rate_centavos, payroll_profile_id, photo_url FROM users ORDER BY full_name")
        .fetch_all(&state.db).await.map_err(|e| e.to_string())?;
    let users = rows.into_iter().map(|row| serde_json::json!({"userId":row.get::<String,_>("user_id"),"rfidUid":row.get::<String,_>("rfid_uid"),"fullName":row.get::<String,_>("full_name"),"department":row.get::<Option<String>,_>("department"),"status":row.get::<String,_>("status"),"employeeType":row.get::<String,_>("employee_type"),"dailyRate":row.get::<Option<i64>,_>("daily_rate_centavos").map(|v| v as f64 / 100.0),"payrollProfileId":row.get::<Option<String>,_>("payroll_profile_id"),"photoUrl":row.get::<Option<String>,_>("photo_url")})).collect::<Vec<_>>();
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
    if user_id.is_empty()
        || rfid_uid.is_empty()
        || full_name.is_empty()
        || !matches!(status, "ACTIVE" | "INACTIVE")
        || !matches!(employee_type, "INTERN" | "EMPLOYEE")
    {
        return Err("ADMIN_VALIDATION_ERROR".into());
    }
    let now = chrono::Utc::now().to_rfc3339();
    let result = sqlx::query("INSERT INTO users (user_id, rfid_uid, full_name, department, status, created_at, employee_type, daily_rate_centavos, payroll_profile_id, photo_url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET rfid_uid=excluded.rfid_uid, full_name=excluded.full_name, department=excluded.department, status=excluded.status, employee_type=excluded.employee_type, daily_rate_centavos=excluded.daily_rate_centavos, payroll_profile_id=excluded.payroll_profile_id, photo_url=excluded.photo_url, revision=users.revision+1, updated_at=excluded.updated_at")
        .bind(user_id).bind(&rfid_uid).bind(full_name).bind(user.get("department").and_then(|v| v.as_str())).bind(status).bind(&now).bind(employee_type).bind(user.get("dailyRate").and_then(|v| v.as_i64()).map(|v| v * 100)).bind(user.get("payrollProfileId").and_then(|v| v.as_str())).bind(user.get("photoUrl").and_then(|v| v.as_str())).bind(&now).execute(&state.db).await.map_err(|e| if e.to_string().contains("UNIQUE") { "USER_CONFLICT".into() } else { e.to_string() })?;
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
    let status = if time_in.is_some() && time_out.is_some() {
        "COMPLETED"
    } else if time_in.is_some() {
        "OPEN"
    } else {
        "INCOMPLETE"
    };
    let now = chrono::Utc::now().to_rfc3339();
    let updated = sqlx::query("UPDATE attendance SET attendance_date=?,time_in=?,time_out=?,status=?,revision=revision+1,updated_at=? WHERE attendance_id=? AND time_in IS ? AND time_out IS ? AND revision=?")
        .bind(date).bind(time_in).bind(time_out).bind(status).bind(&now).bind(&attendance_id).bind(expected_in).bind(expected_out).bind(row.get::<i64,_>("revision")).execute(&state.db).await.map_err(|e|e.to_string())?;
    if updated.rows_affected() != 1 {
        return Err("ATTENDANCE_CONFLICT".into());
    }
    let _ = sqlx::query("DELETE FROM payroll WHERE attendance_id=?")
        .bind(&attendance_id)
        .execute(&state.db)
        .await;
    let _ = sqlx::query("DELETE FROM intern_grace WHERE attendance_id=?")
        .bind(&attendance_id)
        .execute(&state.db)
        .await;
    if let (Some(actual_in), Some(actual_out)) = (time_in, time_out) {
        if let Some(user_row) = sqlx::query("SELECT user_id,full_name,employee_type,daily_rate_centavos FROM users WHERE user_id=(SELECT user_id FROM attendance WHERE attendance_id=? LIMIT 1)").bind(&attendance_id).fetch_optional(&state.db).await.map_err(|e| e.to_string())? {
            ensure_payroll(&state, &attendance_id, user_row.get("user_id"), user_row.get("full_name"), user_row.get("employee_type"), user_row.get("daily_rate_centavos"), date, actual_in, actual_out).await?;
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
    let rows = sqlx::query("SELECT payroll_id,employee_id,employee_name,payroll_profile_id,payroll_cutoff_label,cutoff_start,cutoff_end,net_pay_centavos,status,finalized_at,revision FROM payroll_cutoffs ORDER BY cutoff_start DESC").fetch_all(&state.db).await.map_err(|e| e.to_string())?;
    Ok(
        serde_json::json!({"success":true,"payroll":rows.into_iter().map(|r| serde_json::json!({"payrollId":r.get::<String,_>("payroll_id"),"employeeId":r.get::<String,_>("employee_id"),"employeeName":r.get::<String,_>("employee_name"),"payrollProfileId":r.get::<String,_>("payroll_profile_id"),"payrollCutoffLabel":r.get::<String,_>("payroll_cutoff_label"),"cutoffStart":r.get::<String,_>("cutoff_start"),"cutoffEnd":r.get::<String,_>("cutoff_end"),"netPay":r.get::<i64,_>("net_pay_centavos") as f64 / 100.0,"status":r.get::<String,_>("status"),"finalizedAt":r.get::<Option<String>,_>("finalized_at"),"revision":r.get::<i64,_>("revision")})).collect::<Vec<_>>() }),
    )
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
    let parsed = cutoff_input(&input);
    let result = crate::services::cutoff_payroll::calculate(&parsed)?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
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
        .bind(0.0_f64)
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
        .bind(result.gross_compensation)
        .bind(result.net_pay)
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
    Ok(serde_json::json!({"success":true,"payrollId":id,"netPay":result.net_pay as f64 / 100.0}))
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
    let parsed = cutoff_input(&input);
    let result = crate::services::cutoff_payroll::calculate(&parsed)?;
    let now = chrono::Utc::now().to_rfc3339();
    let updated = sqlx::query("UPDATE payroll_cutoffs SET employee_id=?,employee_name=?,payroll_profile_id=?,payroll_cutoff_label=?,cutoff_start=?,cutoff_end=?,daily_rate_centavos=?,standard_working_days=?,actual_working_days=?,basic_pay_centavos=?,incentives_allowance_centavos=?,special_allowance_centavos=?,total_compensation_centavos=?,total_allowance_centavos=?,late_deduction_centavos=?,half_day_deduction_centavos=?,absence_deduction_centavos=?,overtime_pay_centavos=?,manual_adjustment_centavos=?,adjustment_reason=?,gross_compensation_centavos=?,net_pay_centavos=?,calculation_breakdown=?,revision=revision+1,updated_at=? WHERE payroll_id=? AND status != 'FINALIZED'")
        .bind(&parsed.employee_id).bind(&parsed.employee_name).bind(input.get("payrollProfileId").and_then(|v| v.as_str()).unwrap_or("BEA_STANDARD")).bind(input.get("payrollCutoffLabel").and_then(|v| v.as_str()).unwrap_or(""))
        .bind(&parsed.cutoff_start).bind(&parsed.cutoff_end).bind((parsed.daily_rate * 100.0).round() as i64).bind(parsed.standard_working_days).bind(parsed.actual_working_days).bind(result.basic_pay).bind(php_to_centavos(parsed.incentives_allowance)).bind(php_to_centavos(parsed.special_allowance)).bind(result.total_compensation).bind(result.total_allowance).bind(result.late_deduction).bind(result.half_day_deduction).bind(result.absence_deduction).bind(result.overtime_pay).bind((parsed.manual_adjustment * 100.0).round() as i64).bind(parsed.adjustment_reason).bind(result.gross_compensation).bind(result.net_pay).bind(serde_json::to_string(&serde_json::json!({"basicPayCentavos":result.basic_pay,"netPayCentavos":result.net_pay})).unwrap_or_default()).bind(&now).bind(id).execute(&state.db).await.map_err(|e| e.to_string())?;
    if updated.rows_affected() != 1 {
        return Err("PAYROLL_NOT_FOUND_OR_FINALIZED".into());
    }
    enqueue_sync(&state, "PayrollCutoffs", id, "UPSERT", &input).await;
    Ok(serde_json::json!({"success":true,"payrollId":id,"netPay":result.net_pay as f64 / 100.0}))
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
async fn payroll_export_csv(state: State<'_, AppState>, token: String) -> Result<String, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let rows = sqlx::query("SELECT payroll_id,employee_id,employee_name,payroll_cutoff_label,cutoff_start,cutoff_end,gross_compensation_centavos,net_pay_centavos,status FROM payroll_cutoffs ORDER BY cutoff_start,employee_name").fetch_all(&state.db).await.map_err(|e| e.to_string())?;
    let mut output = String::from("payrollId,employeeId,employeeName,cutoffLabel,cutoffStart,cutoffEnd,grossCompensation,netPay,status\n");
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
    Ok(output)
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
    let row = sqlx::query("SELECT user_id,rfid_uid,full_name,department,status,employee_type,daily_rate_centavos,payroll_profile_id,photo_url FROM users WHERE rfid_uid=?").bind(&uid).fetch_optional(&state.db).await.map_err(|e| e.to_string())?;
    Ok(
        serde_json::json!({"success":true,"rfidUid":uid,"user":row.map(|r| serde_json::json!({"userId":r.get::<String,_>("user_id"),"rfidUid":r.get::<String,_>("rfid_uid"),"fullName":r.get::<String,_>("full_name"),"department":r.get::<Option<String>,_>("department"),"status":r.get::<String,_>("status"),"employeeType":r.get::<String,_>("employee_type"),"dailyRate":r.get::<Option<i64>,_>("daily_rate_centavos").map(|v|v as f64/100.0),"payrollProfileId":r.get::<Option<String>,_>("payroll_profile_id"),"photoUrl":r.get::<Option<String>,_>("photo_url")}))}),
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
    let relative_path = std::path::PathBuf::from("exports").join(&file_name);
    let output_path = state.data_dir.join(&relative_path);
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO export_jobs (job_id,kind,scope_json,format,status,requested_at,app_version,row_count,progress_total) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(&job_id).bind("ATTENDANCE_XLSX").bind(serde_json::json!({"date":date}).to_string()).bind("XLSX").bind("RUNNING").bind(&now).bind(env!("CARGO_PKG_VERSION")).bind(rows.len() as i64).bind(rows.len() as i64)
        .execute(&state.db).await.map_err(|e| e.to_string())?;
    if let Err(error) = (|| {
        std::fs::create_dir_all(output_path.parent().ok_or("EXPORT_PATH_ERROR")?)
            .map_err(|e| e.to_string())?;
        crate::reporting::generate_attendance_workbook(&rows, &date, &output_path)
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
    Ok(
        serde_json::json!({"success":true,"jobId":job_id,"artifactId":artifact_id,"fileName":file_name,"sizeBytes":bytes.len(),"sha256":hash,"rowCount":rows.len()}),
    )
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
    let relative_path = std::path::PathBuf::from("exports").join(&file_name);
    let output_path = state.data_dir.join(&relative_path);
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO export_jobs (job_id,kind,scope_json,format,status,requested_at,app_version,row_count,progress_total) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(&job_id).bind("PAYROLL_XLSX").bind(serde_json::json!({"cutoff":cutoff}).to_string()).bind("XLSX").bind("RUNNING").bind(&now).bind(env!("CARGO_PKG_VERSION")).bind(filtered.len() as i64).bind(filtered.len() as i64).execute(&state.db).await.map_err(|e| e.to_string())?;
    if let Err(error) = (|| {
        std::fs::create_dir_all(output_path.parent().ok_or("EXPORT_PATH_ERROR")?)
            .map_err(|e| e.to_string())?;
        crate::reporting::generate_payroll_workbook(&filtered, &scope, &output_path)
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
    Ok(
        serde_json::json!({"success":true,"jobId":job_id,"artifactId":artifact_id,"fileName":file_name,"sizeBytes":bytes.len(),"sha256":hash,"rowCount":filtered.len()}),
    )
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
    let output_path = state.data_dir.join(&relative_path);
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO export_jobs (job_id,kind,scope_json,format,status,requested_at,app_version,row_count,progress_total) VALUES (?,?,?,?,?,?,?,?,?)").bind(&job_id).bind("PAYSLIP_PDF").bind(serde_json::json!({"payrollId":payroll_id}).to_string()).bind("PDF").bind("RUNNING").bind(&now).bind(env!("CARGO_PKG_VERSION")).bind(1_i64).bind(1_i64).execute(&state.db).await.map_err(|e| e.to_string())?;
    if let Err(error) = (|| {
        std::fs::create_dir_all(output_path.parent().ok_or("EXPORT_PATH_ERROR")?)
            .map_err(|e| e.to_string())?;
        crate::reporting::generate_payroll_pdf(&payroll, &output_path)
    })() {
        let _ = sqlx::query("UPDATE export_jobs SET status='FAILED',completed_at=?,error_code='ARTIFACT_GENERATION_FAILED',error_message=? WHERE job_id=?").bind(chrono::Utc::now().to_rfc3339()).bind(&error).bind(&job_id).execute(&state.db).await;
        return Err(error);
    }
    let bytes = std::fs::read(&output_path).map_err(|e| e.to_string())?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let completed = chrono::Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO generated_artifacts (artifact_id,job_id,document_id,kind,format,file_name,managed_relative_path,sha256,size_bytes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(&artifact_id).bind(&job_id).bind(&payroll.payroll_id).bind("PAYSLIP_PDF").bind("PDF").bind(&file_name).bind(relative_path.to_string_lossy().replace('\\', "/")).bind(&hash).bind(bytes.len() as i64).bind(&completed).execute(&state.db).await.map_err(|e| e.to_string())?;
    sqlx::query("UPDATE export_jobs SET status='SUCCEEDED',completed_at=?,progress_current=progress_total WHERE job_id=?").bind(&completed).bind(&job_id).execute(&state.db).await.map_err(|e| e.to_string())?;
    Ok(
        serde_json::json!({"success":true,"jobId":job_id,"artifactId":artifact_id,"fileName":file_name,"sizeBytes":bytes.len(),"sha256":hash,"status":payroll.status}),
    )
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
    let relative = std::path::PathBuf::from("exports").join(&file_name);
    let output = state.data_dir.join(&relative);
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO export_jobs (job_id,kind,scope_json,format,status,requested_at,app_version,row_count,progress_total) VALUES (?,?,?,?,?,?,?,?,?)").bind(&job_id).bind("PAYROLL_REGISTER_PDF").bind(serde_json::json!({"cutoff":scope}).to_string()).bind("PDF").bind("RUNNING").bind(&now).bind(env!("CARGO_PKG_VERSION")).bind(filtered.len() as i64).bind(filtered.len() as i64).execute(&state.db).await.map_err(|e| e.to_string())?;
    if let Err(error) = (|| {
        std::fs::create_dir_all(output.parent().ok_or("EXPORT_PATH_ERROR")?)
            .map_err(|e| e.to_string())?;
        crate::reporting::generate_payroll_register_pdf(&filtered, &scope, &output)
    })() {
        let _ = sqlx::query("UPDATE export_jobs SET status='FAILED',completed_at=?,error_code='ARTIFACT_GENERATION_FAILED',error_message=? WHERE job_id=?").bind(chrono::Utc::now().to_rfc3339()).bind(&error).bind(&job_id).execute(&state.db).await;
        return Err(error);
    }
    let bytes = std::fs::read(&output).map_err(|e| e.to_string())?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let completed = chrono::Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO generated_artifacts (artifact_id,job_id,document_id,kind,format,file_name,managed_relative_path,sha256,size_bytes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(&artifact_id).bind(&job_id).bind(&job_id).bind("PAYROLL_REGISTER_PDF").bind("PDF").bind(&file_name).bind(relative.to_string_lossy().replace('\\', "/")).bind(&hash).bind(bytes.len() as i64).bind(&completed).execute(&state.db).await.map_err(|e| e.to_string())?;
    sqlx::query("UPDATE export_jobs SET status='SUCCEEDED',completed_at=?,progress_current=progress_total WHERE job_id=?").bind(&completed).bind(&job_id).execute(&state.db).await.map_err(|e| e.to_string())?;
    Ok(
        serde_json::json!({"success":true,"jobId":job_id,"artifactId":artifact_id,"fileName":file_name,"sizeBytes":bytes.len(),"sha256":hash,"rowCount":filtered.len()}),
    )
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
    let user = match sqlx::query("SELECT user_id, full_name, department, employee_type, photo_url, status FROM users WHERE rfid_uid = ?")
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
            let result = sqlx::query("INSERT INTO attendance (attendance_id, attendance_date, user_id, rfid_uid, full_name, department, time_in, time_out, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'OPEN', ?, ?, ?)")
                .bind(&id).bind(&date).bind(&user_id).bind(&uid).bind(user.get::<String,_>("full_name")).bind(user.get::<Option<String>,_>("department")).bind(&timestamp).bind(source).bind(&timestamp).bind(&timestamp).execute(&state.db).await;
            if result.is_err() {
                return Ok(
                    serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"INTERNAL_SERVER_ERROR","message":"Unable to save attendance."}}),
                );
            }
            (id, "TIME_IN", Some(timestamp.clone()), None, "OPEN")
        }
        Some(row) => {
            let id: String = row.get("attendance_id");
            let tin: Option<String> = row.get("time_in");
            let tout: Option<String> = row.get("time_out");
            if tout.is_some() {
                return Ok(
                    serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"ATTENDANCE_ALREADY_COMPLETED","message":"Attendance is already complete for today."}}),
                );
            }
            if tin.is_none() {
                return Ok(
                    serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"ATTENDANCE_DATA_CONFLICT","message":"Attendance data is inconsistent."}}),
                );
            }
            let result = sqlx::query("UPDATE attendance SET time_out = ?, status = 'COMPLETED', revision = revision + 1, updated_at = ? WHERE attendance_id = ? AND revision = ? AND time_out IS NULL")
                .bind(&timestamp).bind(&timestamp).bind(&id).bind(row.get::<i64,_>("revision")).execute(&state.db).await;
            if result.map(|r| r.rows_affected()).unwrap_or(0) != 1 {
                return Ok(
                    serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"ATTENDANCE_DATA_CONFLICT","message":"Attendance changed before the scan was saved."}}),
                );
            }
            (id, "TIME_OUT", tin, Some(timestamp.clone()), "COMPLETED")
        }
    };
    let seq = state.next_sequence();
    state
        .physical_cooldown
        .lock()
        .await
        .insert(uid.clone(), Instant::now());
    if action == "TIME_OUT" {
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
        serde_json::json!({"success":true,"requestId":request_id,"action":action,"message":if action == "TIME_IN" { "Time In recorded successfully." } else { "Time Out recorded successfully." },"attendance":{"attendanceId":attendance_id,"attendanceDate":date,"timeIn":time_in,"timeOut":time_out,"status":attendance_status},"user":{"userId":user_id,"fullName":user.get::<String,_>("full_name"),"department":user.get::<Option<String>,_>("department"),"employeeType":user.get::<String,_>("employee_type"),"photoUrl":user.get::<Option<String>,_>("photo_url")}}),
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
    if bytes.len() > 500 * 1024 {
        return Err("IMAGE_TOO_LARGE".into());
    }
    let image = image::load_from_memory(&bytes).map_err(|_| "INVALID_IMAGE_FORMAT".to_string())?;
    if image.width() > 512 || image.height() > 512 {
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_log::Builder::default().build())
        .setup(|app| {
            let data_dir: PathBuf = app
                .path()
                .app_local_data_dir()
                .expect("application data directory");
            let config_dir = app
                .path()
                .app_config_dir()
                .expect("application config directory");
            std::fs::create_dir_all(&config_dir).expect("create application config directory");
            let lan = LanConfig::load(&config_dir).expect("valid config.toml");
            let state = tauri::async_runtime::block_on(AppState::new(data_dir, lan))
                .expect("SQLite initialization");
            if state.lan.enabled {
                let server_state = state.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = lan_server::start(server_state).await;
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
            app.manage(state);
            crate::services::rfid_global::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_health,
            get_config,
            get_attendance,
            scan_rfid,
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
            open_generated_artifact,
            setup_unlock,
            setup_lock,
            setup_lookup_card,
            setup_upsert_user,
            admin_unlock,
            admin_get_session,
            admin_lock,
            admin_get_sync_status,
            admin_retry_sync_item,
            admin_sync_now
        ])
        .run(tauri::generate_context!())
        .expect("error while running Alpha Premier Attendance");
}

#[cfg(test)]
mod tests {
    use super::php_to_centavos;

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
}
