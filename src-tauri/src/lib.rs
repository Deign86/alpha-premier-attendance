mod config;
mod database;
mod error;
mod lan_net;
mod lan_server;
mod lifecycle;
mod paths;
pub mod reporting;
mod services;
mod state;
mod tts;

use crate::services::intern_payroll::{
    INTERN_DAILY_RATE_PHP, INTERN_LATE_DEDUCTION_PER_HOUR_PHP, INTERN_PAYROLL_PROFILE_ID,
};
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

#[tauri::command]
fn get_health(state: State<'_, AppState>) -> serde_json::Value {
    serde_json::json!({"success":true,"service":"rfid-attendance-api","timestamp":chrono::Utc::now(),"timezone":"Asia/Manila","sqlite":"connected","lanEnabled":state.lan.enabled,"lan":{"bindAddress":state.lan.bind_address.map(|v|v.to_string()),"port":state.lan.port,"connectedSseClients":state.connected_sse_clients.load(std::sync::atomic::Ordering::Relaxed)},"googleSheetsExport":if state.lan.sheets_sync_endpoint.is_some() || state.lan.google_spreadsheet_id.is_some() || state.lan.google_drive_folder_id.is_some() || state.lan.google_create_folder_if_missing { "configured" } else { "disabled" }})
}

#[tauri::command]
fn get_config(state: State<'_, AppState>) -> serde_json::Value {
    serde_json::json!({"success":true,"timezone":"Asia/Manila","rfidAutoSubmitDelayMs":150,"resultResetDelayMs":4000,"enableAdmin":true,"enableCardSetup":true,"lanEnabled":state.lan.enabled,"updater":{"enabled":state.updater.enabled,"autoCheck":state.updater.auto_check,"checkIntervalHours":state.updater.check_interval_hours},"scanner":{"mode":"keyboard","paused":state.scanner.paused(),"expectedLength":state.scanner.config.expected_length,"characterSet":if matches!(state.scanner.config.character_set, crate::config::ScannerCharacterSet::Hex) { "hex" } else { "decimal" }},"office":{"companyName":state.office.company_name,"officeLabel":state.office.office_label,"officeAddressLine1":state.office.office_address_line_1,"officeBuilding":state.office.office_building,"officeDistrict":state.office.office_district,"officeCity":state.office.office_city,"officeRegion":state.office.office_region,"officeCountry":state.office.office_country,"officePostalCode":state.office.office_postal_code,"officeDisplayShort":state.office.display_short(),"officeDisplayFull":state.office.display_full()}})
}

#[tauri::command]
fn notify_scan_success(app: tauri::AppHandle, full_name: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    let name = full_name.trim().chars().take(60).collect::<String>();
    if name.is_empty() {
        return Ok(());
    }
    app.notification()
        .builder()
        .title("Attendance recorded")
        .body(format!("Time in/out recorded for {name}"))
        .show()
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn tts_speak(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    text: String,
    options: Option<crate::tts::TtsSpeakOptions>,
) -> Result<crate::tts::TtsSpeakResult, String> {
    state.tts.speak(&text, options, &app).await
}

#[tauri::command]
async fn tts_stop(state: State<'_, AppState>) -> Result<(), String> {
    state.tts.stop().await;
    Ok(())
}

#[tauri::command]
async fn tts_status(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<crate::tts::TtsStatusResponse, String> {
    Ok(state.tts.status(&app).await)
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
    let rows = sqlx::query("SELECT attendance_id,attendance_date,user_id,full_name,department,time_in,time_out,status,source,recorded_by,recorded_reason,recorded_at FROM attendance WHERE attendance_date=? ORDER BY time_in,full_name").bind(&selected).fetch_all(&state.db).await.map_err(|e| e.to_string())?;
    Ok(
        serde_json::json!({"success":true,"date":selected,"attendance":rows.into_iter().map(|r| serde_json::json!({
            "attendanceId": r.get::<String,_>("attendance_id"),
            "attendanceDate": r.get::<String,_>("attendance_date"),
            "userId": r.get::<String,_>("user_id"),
            "fullName": r.get::<String,_>("full_name"),
            "department": r.get::<Option<String>,_>("department"),
            "timeIn": r.get::<Option<String>,_>("time_in"),
            "timeOut": r.get::<Option<String>,_>("time_out"),
            "status": r.get::<String,_>("status"),
            "source": r.get::<Option<String>,_>("source"),
            "recordedBy": r.get::<Option<String>,_>("recorded_by"),
            "recordedReason": r.get::<Option<String>,_>("recorded_reason"),
            "recordedAt": r.get::<Option<String>,_>("recorded_at"),
        })).collect::<Vec<_>>(),"fetchedAt":chrono::Utc::now()}),
    )
}

fn resolve_user_photo_url(
    data_dir: &std::path::Path,
    user_id: &str,
    stored_url: Option<String>,
) -> Option<String> {
    let local_photo = data_dir.join("photos").join(format!("{user_id}.webp"));
    if local_photo.is_file() {
        let normalized = local_photo.to_string_lossy().replace('\\', "/");
        Some(format!("asset://localhost/{normalized}"))
    } else {
        stored_url
    }
}

#[tauri::command]
async fn admin_users(
    state: State<'_, AppState>,
    token: String,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let rows = sqlx::query("SELECT user_id, rfid_uid, full_name, department, status, employee_type, gender, daily_rate_centavos, payroll_profile_id, photo_url, card_type FROM users ORDER BY full_name")
        .fetch_all(&state.db).await.map_err(|e| e.to_string())?;
    let users = rows.into_iter().map(|row| {
        let user_id = row.get::<String,_>("user_id");
        let photo_url = resolve_user_photo_url(&state.data_dir, &user_id, row.get::<Option<String>,_>("photo_url"));
        serde_json::json!({
            "userId": user_id,
            "rfidUid": row.get::<String,_>("rfid_uid"),
            "fullName": row.get::<String,_>("full_name"),
            "department": row.get::<Option<String>,_>("department"),
            "status": row.get::<String,_>("status"),
            "employeeType": row.get::<String,_>("employee_type"),
            "gender": row.get::<Option<String>,_>("gender"),
            "dailyRate": row.get::<Option<i64>,_>("daily_rate_centavos").map(|v| v as f64 / 100.0),
            "payrollProfileId": row.get::<Option<String>,_>("payroll_profile_id"),
            "photoUrl": photo_url,
            "cardType": row.get::<Option<String>,_>("card_type").unwrap_or_else(|| "EMPLOYEE".into())
        })
    }).collect::<Vec<_>>();
    Ok(serde_json::json!({"success":true,"users":users}))
}

#[tauri::command]
async fn admin_list_users(
    state: State<'_, AppState>,
    token: String,
) -> Result<serde_json::Value, String> {
    admin_users(state, token).await
}

/// Normalize a gender payload before it hits the `gender IN ('MALE','FEMALE')`
/// CHECK constraint: trim + uppercase (`"male"` → `"MALE"`) and treat
/// empty/whitespace as unset so the editor's "Not set" option clears the
/// field instead of writing a value the database rejects.
fn normalize_gender(value: Option<&str>) -> Option<String> {
    value
        .map(|g| g.trim().to_ascii_uppercase())
        .filter(|g| !g.is_empty())
}

async fn upsert_user_record(
    db: &sqlx::SqlitePool,
    user_id: &str,
    rfid_uid: &str,
    full_name: &str,
    department: Option<&str>,
    status: &str,
    employee_type: &str,
    gender: Option<&str>,
    daily_rate_centavos: Option<i64>,
    payroll_profile_id: Option<&str>,
    photo_url: Option<&str>,
    card_type: &str,
    now: &str,
) -> Result<u64, sqlx::Error> {
    let result = sqlx::query("INSERT INTO users (user_id, rfid_uid, full_name, department, status, created_at, employee_type, daily_rate_centavos, payroll_profile_id, photo_url, gender, card_type, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET rfid_uid=excluded.rfid_uid, full_name=excluded.full_name, department=excluded.department, status=excluded.status, employee_type=excluded.employee_type, gender=COALESCE(excluded.gender, users.gender), daily_rate_centavos=excluded.daily_rate_centavos, payroll_profile_id=excluded.payroll_profile_id, photo_url=excluded.photo_url, card_type=excluded.card_type, revision=users.revision+1, updated_at=excluded.updated_at")
        .bind(user_id).bind(rfid_uid).bind(full_name).bind(department).bind(status).bind(now).bind(employee_type)
        .bind(daily_rate_centavos).bind(payroll_profile_id).bind(photo_url).bind(gender).bind(card_type).bind(now)
        .execute(db).await?;
    Ok(result.rows_affected())
}

fn normalize_name(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let mut result = String::with_capacity(trimmed.len());
    let mut prev_char: Option<char> = None;
    let mut prev_is_space = false;
    for c in trimmed.chars() {
        if c.is_whitespace() {
            if !prev_is_space {
                result.push(' ');
                prev_is_space = true;
                prev_char = Some(' ');
            }
            continue;
        }
        prev_is_space = false;
        let should_capitalize = match prev_char {
            None => true,
            Some(p) => {
                p.is_whitespace() || p == '-' || p == '\'' || p == '’' || p == '.' || p == '/'
            }
        };
        if should_capitalize {
            for upper in c.to_uppercase() {
                result.push(upper);
            }
        } else {
            for lower in c.to_lowercase() {
                result.push(lower);
            }
        }
        prev_char = Some(c);
    }
    result
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
    let card_type = user
        .get("cardType")
        .and_then(|v| v.as_str())
        .unwrap_or("EMPLOYEE");
    let is_assist = card_type == "ADMIN_ASSIST";

    let rfid_uid = user
        .get("rfidUid")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_uppercase();

    let user_id = {
        let raw = user
            .get("userId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_uppercase();
        if raw.is_empty() && is_assist && !rfid_uid.is_empty() {
            format!("ADMIN_CARD_{rfid_uid}")
        } else {
            raw
        }
    };

    let full_name = {
        let raw = normalize_name(
            user.get("fullName")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
        );
        if raw.is_empty() && is_assist {
            let label = user.get("label").and_then(|v| v.as_str()).unwrap_or("").trim();
            if label.is_empty() {
                "Admin Assist Card".to_string()
            } else {
                normalize_name(label)
            }
        } else {
            raw
        }
    };

    let status = user
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("ACTIVE");

    let employee_type = if is_assist {
        "EMPLOYEE"
    } else {
        user.get("employeeType")
            .and_then(|v| v.as_str())
            .unwrap_or("INTERN")
    };

    let department = if is_assist {
        Some(user.get("department").and_then(|v| v.as_str()).unwrap_or("Admin"))
    } else {
        user.get("department").and_then(|v| v.as_str())
    };

    let gender = if is_assist {
        None
    } else {
        normalize_gender(user.get("gender").and_then(|v| v.as_str()))
    };

    if user_id.is_empty()
        || rfid_uid.is_empty()
        || full_name.is_empty()
        || !matches!(status, "ACTIVE" | "INACTIVE")
        || !matches!(employee_type, "INTERN" | "EMPLOYEE")
        || !matches!(card_type, "EMPLOYEE" | "ADMIN_ASSIST")
        || gender
            .as_deref()
            .is_some_and(|g| !matches!(g, "MALE" | "FEMALE"))
    {
        return Err("ADMIN_VALIDATION_ERROR".into());
    }

    let existing_uid_owner: Option<String> = sqlx::query_scalar("SELECT user_id FROM users WHERE rfid_uid = ?")
        .bind(&rfid_uid)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(owner) = existing_uid_owner {
        if owner != user_id {
            return Err("USER_CONFLICT".into());
        }
    }

    let daily_rate = if is_assist {
        None
    } else {
        user.get("dailyRate")
            .and_then(|v| v.as_i64())
            .map(|v| v * 100)
    };

    let now = chrono::Utc::now().to_rfc3339();
    let result = upsert_user_record(
        &state.db,
        &user_id,
        &rfid_uid,
        &full_name,
        department,
        status,
        employee_type,
        gender.as_deref(),
        daily_rate,
        if is_assist { None } else { user.get("payrollProfileId").and_then(|v| v.as_str()) },
        if is_assist { None } else { user.get("photoUrl").and_then(|v| v.as_str()) },
        card_type,
        &now,
    )
    .await
    .map_err(|e| {
        if e.to_string().contains("UNIQUE") {
            "USER_CONFLICT".into()
        } else {
            e.to_string()
        }
    })?;
    let _ = sqlx::query("INSERT INTO audit_logs (log_id, timestamp, event_type, user_id, message, request_id) VALUES (?, ?, 'ADMIN_USER_UPSERT', ?, ?, ?)").bind(uuid::Uuid::new_v4().to_string()).bind(&now).bind(&user_id).bind("User profile saved by administrator").bind(format!("admin-{}", uuid::Uuid::new_v4())).execute(&state.db).await;
    enqueue_sync(&state, "Users", &user_id, "UPSERT", &user).await;
    Ok(serde_json::json!({"success":true,"created":result == 1,"userId":&user_id}))
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

async fn delete_user_and_cascade(state: &AppState, user_id: &str) -> Result<(), String> {
    let user_exists = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users WHERE user_id = ?")
        .bind(user_id)
        .fetch_one(&state.db)
        .await
        .map_err(|e| e.to_string())?
        > 0;
    if !user_exists {
        return Err("USER_NOT_FOUND".into());
    }

    // 1. Capture cutoff payroll records to delete & sync
    let cutoff_rows = sqlx::query(
        "SELECT payroll_id, employee_id, employee_name, payroll_cutoff_label, cutoff_start, cutoff_end FROM payroll_cutoffs WHERE employee_id = ?"
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    // 2. Capture daily attendance payroll IDs to delete & sync
    let daily_payroll_ids: Vec<String> = sqlx::query(
        "SELECT payroll_id FROM payroll WHERE user_id = ?"
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?
    .into_iter()
    .map(|r| r.get::<String, _>("payroll_id"))
    .collect();

    // 3. Capture attendance records to delete & sync
    let attendance_rows: Vec<(String, String)> = sqlx::query(
        "SELECT attendance_id, attendance_date FROM attendance WHERE user_id = ?"
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?
    .into_iter()
    .map(|r| (r.get::<String, _>("attendance_id"), r.get::<String, _>("attendance_date")))
    .collect();

    // 4. Capture intern grace IDs to delete & sync
    let grace_ids: Vec<String> = sqlx::query(
        "SELECT grace_id FROM intern_grace WHERE user_id = ?"
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?
    .into_iter()
    .map(|r| r.get::<String, _>("grace_id"))
    .collect();

    // Execute deletions in database
    let _ = sqlx::query(
        "DELETE FROM payroll_snapshots WHERE payroll_id IN (SELECT payroll_id FROM payroll_cutoffs WHERE employee_id = ?)"
    )
    .bind(user_id)
    .execute(&state.db)
    .await;

    let _ = sqlx::query("DELETE FROM payroll_cutoffs WHERE employee_id = ?")
        .bind(user_id)
        .execute(&state.db)
        .await;

    let _ = sqlx::query("DELETE FROM payroll WHERE user_id = ?")
        .bind(user_id)
        .execute(&state.db)
        .await;

    let _ = sqlx::query("DELETE FROM intern_grace WHERE user_id = ?")
        .bind(user_id)
        .execute(&state.db)
        .await;

    let _ = sqlx::query("DELETE FROM attendance WHERE user_id = ?")
        .bind(user_id)
        .execute(&state.db)
        .await;

    let result = sqlx::query("DELETE FROM users WHERE user_id = ?")
        .bind(user_id)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;

    if result.rows_affected() != 1 {
        return Err("USER_NOT_FOUND".into());
    }

    // Enqueue sync deletions
    enqueue_sync(
        state,
        "Users",
        user_id,
        "DELETE",
        &serde_json::json!({"userId": user_id}),
    )
    .await;

    for row in cutoff_rows {
        let pid: String = row.get("payroll_id");
        enqueue_sync(
            state,
            "PayrollCutoffs",
            &pid,
            "DELETE",
            &serde_json::json!({
                "payrollId": pid,
                "employeeId": row.get::<String, _>("employee_id"),
                "employeeName": row.get::<String, _>("employee_name"),
                "payrollCutoffLabel": row.get::<String, _>("payroll_cutoff_label"),
                "cutoffStart": row.get::<String, _>("cutoff_start"),
                "cutoffEnd": row.get::<String, _>("cutoff_end")
            }),
        )
        .await;
    }

    for pid in daily_payroll_ids {
        enqueue_sync(
            state,
            "Payroll",
            &pid,
            "DELETE",
            &serde_json::json!({"payrollId": pid, "userId": user_id}),
        )
        .await;
    }

    for (aid, adate) in attendance_rows {
        enqueue_sync(
            state,
            "Attendance",
            &aid,
            "DELETE",
            &serde_json::json!({"attendanceId": aid, "attendanceDate": adate}),
        )
        .await;
    }

    for gid in grace_ids {
        enqueue_sync(
            state,
            "InternGrace",
            user_id,
            "DELETE",
            &serde_json::json!({"userId": user_id, "graceId": gid}),
        )
        .await;
    }

    let now = chrono::Utc::now().to_rfc3339();
    let _ = sqlx::query(
        "INSERT INTO audit_logs (log_id, timestamp, event_type, user_id, message, request_id) VALUES (?, ?, 'ADMIN_USER_DELETED', ?, ?, ?)"
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(&now)
    .bind(user_id)
    .bind(format!("User {user_id} and associated attendance/payroll deleted by administrator"))
    .bind(format!("admin-{}", uuid::Uuid::new_v4()))
    .execute(&state.db)
    .await;

    Ok(())
}

/// BUG-DB-02: translate raw SQLite FK violations into a user-friendly error
/// instead of leaking the opaque constraint message to the admin panel.
fn friendly_delete_user_error(error: String) -> String {
    if error.contains("FOREIGN KEY") {
        "USER_HAS_RECORDS: Cannot delete user because historical attendance or bathroom records depend on this account. Deactivate the user instead.".to_string()
    } else {
        error
    }
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
    delete_user_and_cascade(state.inner(), &user_id)
        .await
        .map_err(friendly_delete_user_error)?;
    Ok(serde_json::json!({"success": true, "userId": user_id}))
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
    let rows = sqlx::query("SELECT attendance_id, attendance_date, user_id, full_name, department, time_in, time_out, status, source, recorded_by, recorded_reason, recorded_at FROM attendance WHERE attendance_date = ? ORDER BY time_in, full_name").bind(&date).fetch_all(&state.db).await.map_err(|e| e.to_string())?;
    let attendance = rows.into_iter().map(|row| serde_json::json!({
        "attendanceId": row.get::<String,_>("attendance_id"),
        "attendanceDate": row.get::<String,_>("attendance_date"),
        "userId": row.get::<String,_>("user_id"),
        "fullName": row.get::<String,_>("full_name"),
        "department": row.get::<Option<String>,_>("department"),
        "timeIn": row.get::<Option<String>,_>("time_in"),
        "timeOut": row.get::<Option<String>,_>("time_out"),
        "status": row.get::<String,_>("status"),
        "source": row.get::<Option<String>,_>("source"),
        "recordedBy": row.get::<Option<String>,_>("recorded_by"),
        "recordedReason": row.get::<Option<String>,_>("recorded_reason"),
        "recordedAt": row.get::<Option<String>,_>("recorded_at"),
    })).collect::<Vec<_>>();
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
async fn bathroom_get_status(
    state: State<'_, AppState>,
    _token: Option<String>,
    date: Option<String>,
) -> Result<serde_json::Value, String> {
    let target_date = date.unwrap_or_else(|| {
        chrono::Utc::now()
            .with_timezone(&Manila)
            .date_naive()
            .format("%Y-%m-%d")
            .to_string()
    });

    let active_rows = sqlx::query(
        "SELECT log_id, user_id, full_name, department, gender_key, time_out FROM bathroom_log WHERE status = 'OUT'",
    )
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    let mut male_active: Option<serde_json::Value> = None;
    let mut female_active: Option<serde_json::Value> = None;

    for row in active_rows {
        let gender: String = row.get("gender_key");
        let item = serde_json::json!({
            "logId": row.get::<String, _>("log_id"),
            "userId": row.get::<String, _>("user_id"),
            "fullName": row.get::<String, _>("full_name"),
            "department": row.get::<Option<String>, _>("department"),
            "genderKey": gender,
            "timeOut": row.get::<String, _>("time_out"),
        });
        if gender == "MALE" {
            male_active = Some(item);
        } else if gender == "FEMALE" {
            female_active = Some(item);
        }
    }

    let log_rows = sqlx::query(
        "SELECT log_id, log_date, user_id, full_name, department, gender_key, time_out, time_in, duration_seconds, status, notes, created_at, updated_at FROM bathroom_log WHERE log_date = ? ORDER BY time_out DESC",
    )
    .bind(&target_date)
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    let mut male_logs = Vec::new();
    let mut female_logs = Vec::new();

    for row in log_rows {
        let gender: String = row.get("gender_key");
        let item = serde_json::json!({
            "logId": row.get::<String, _>("log_id"),
            "logDate": row.get::<String, _>("log_date"),
            "userId": row.get::<String, _>("user_id"),
            "fullName": row.get::<String, _>("full_name"),
            "department": row.get::<Option<String>, _>("department"),
            "genderKey": gender,
            "timeOut": row.get::<String, _>("time_out"),
            "timeIn": row.get::<Option<String>, _>("time_in"),
            "durationSeconds": row.get::<Option<i64>, _>("duration_seconds"),
            "status": row.get::<String, _>("status"),
            "notes": row.get::<String, _>("notes"),
            "createdAt": row.get::<String, _>("created_at"),
            "updatedAt": row.get::<String, _>("updated_at"),
        });
        if gender == "MALE" {
            male_logs.push(item);
        } else if gender == "FEMALE" {
            female_logs.push(item);
        }
    }

    Ok(serde_json::json!({
        "success": true,
        "date": target_date,
        "maleActive": male_active,
        "femaleActive": female_active,
        "maleLogs": male_logs,
        "femaleLogs": female_logs,
        "fetchedAt": chrono::Utc::now().to_rfc3339()
    }))
}

#[tauri::command]
async fn bathroom_time_out(
    state: State<'_, AppState>,
    token: String,
    user_id: String,
    gender_key: String,
    notes: Option<String>,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let normalized_gender = gender_key.trim().to_uppercase();
    if normalized_gender != "MALE" && normalized_gender != "FEMALE" {
        return Err("INVALID_GENDER_KEY: Gender key must be MALE or FEMALE".into());
    }

    let user_row = sqlx::query(
        "SELECT user_id, full_name, department, status, card_type FROM users WHERE user_id = ?",
    )
    .bind(&user_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "USER_NOT_FOUND: Employee record not found".to_string())?;

    let user_status: String = user_row.get("status");
    if user_status != "ACTIVE" {
        return Err("INACTIVE_USER: Cannot checkout key for an inactive user".into());
    }

    let card_type: String = user_row.get("card_type");
    if card_type == "ADMIN_ASSIST" {
        return Err("INVALID_USER: Cannot checkout key for an Admin card".into());
    }

    let full_name: String = user_row.get("full_name");
    let department: Option<String> = user_row.get("department");

    let existing_active = sqlx::query(
        "SELECT full_name FROM bathroom_log WHERE gender_key = ? AND status = 'OUT' LIMIT 1",
    )
    .bind(&normalized_gender)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    if let Some(active) = existing_active {
        let holder: String = active.get("full_name");
        return Err(format!(
            "BATHROOM_KEY_ALREADY_CHECKED_OUT: The {normalized_gender} bathroom key is currently checked out by {holder}."
        ));
    }

    let log_id = uuid::Uuid::new_v4().to_string();
    let now_manila = chrono::Utc::now().with_timezone(&Manila);
    let log_date = now_manila.date_naive().format("%Y-%m-%d").to_string();
    let time_out = now_manila.to_rfc3339();
    let now_utc = chrono::Utc::now().to_rfc3339();
    let effective_notes = notes.unwrap_or_default();

    sqlx::query(
        "INSERT INTO bathroom_log (log_id, log_date, user_id, full_name, department, gender_key, time_out, time_in, duration_seconds, status, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'OUT', ?, ?, ?)",
    )
    .bind(&log_id)
    .bind(&log_date)
    .bind(&user_id)
    .bind(&full_name)
    .bind(&department)
    .bind(&normalized_gender)
    .bind(&time_out)
    .bind(&effective_notes)
    .bind(&now_utc)
    .bind(&now_utc)
    .execute(&state.db)
    .await
    .map_err(|e| format!("Failed to record time-out: {e}"))?;

    Ok(serde_json::json!({
        "success": true,
        "entry": {
            "logId": log_id,
            "logDate": log_date,
            "userId": user_id,
            "fullName": full_name,
            "department": department,
            "genderKey": normalized_gender,
            "timeOut": time_out,
            "timeIn": null,
            "durationSeconds": null,
            "status": "OUT",
            "notes": effective_notes,
            "createdAt": now_utc,
            "updatedAt": now_utc
        }
    }))
}

#[tauri::command]
async fn bathroom_time_in(
    state: State<'_, AppState>,
    token: String,
    log_id: String,
    notes: Option<String>,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }

    let existing = sqlx::query(
        "SELECT log_id, log_date, user_id, full_name, department, gender_key, time_out, status, notes FROM bathroom_log WHERE log_id = ?",
    )
    .bind(&log_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "BATHROOM_LOG_NOT_FOUND: Bathroom log entry not found".to_string())?;

    let current_status: String = existing.get("status");
    if current_status != "OUT" {
        return Err("BATHROOM_KEY_ALREADY_RETURNED: This bathroom key has already been returned".into());
    }

    let time_out_str: String = existing.get("time_out");
    let now_manila = chrono::Utc::now().with_timezone(&Manila);
    let time_in = now_manila.to_rfc3339();
    let now_utc = chrono::Utc::now().to_rfc3339();

    let duration_seconds = chrono::DateTime::parse_from_rfc3339(&time_out_str)
        .map(|parsed_out| (now_manila - parsed_out.with_timezone(&Manila)).num_seconds().max(0))
        .unwrap_or(0);

    let updated_notes = match notes {
        Some(n) if !n.trim().is_empty() => n.trim().to_string(),
        _ => existing.get::<String, _>("notes"),
    };

    sqlx::query(
        "UPDATE bathroom_log SET time_in = ?, duration_seconds = ?, status = 'RETURNED', notes = ?, updated_at = ? WHERE log_id = ?",
    )
    .bind(&time_in)
    .bind(duration_seconds)
    .bind(&updated_notes)
    .bind(&now_utc)
    .bind(&log_id)
    .execute(&state.db)
    .await
    .map_err(|e| format!("Failed to record time-in: {e}"))?;

    let user_id: String = existing.get("user_id");
    let full_name: String = existing.get("full_name");
    let department: Option<String> = existing.get("department");
    let gender_key: String = existing.get("gender_key");
    let log_date: String = existing.get("log_date");

    Ok(serde_json::json!({
        "success": true,
        "entry": {
            "logId": log_id,
            "logDate": log_date,
            "userId": user_id,
            "fullName": full_name,
            "department": department,
            "genderKey": gender_key,
            "timeOut": time_out_str,
            "timeIn": time_in,
            "durationSeconds": duration_seconds,
            "status": "RETURNED",
            "notes": updated_notes,
            "createdAt": now_utc,
            "updatedAt": now_utc
        }
    }))
}

async fn process_bathroom_scan(
    state: &AppState,
    rfid_uid: &str,
) -> Result<serde_json::Value, String> {
    let normalized_uid = rfid_uid.trim().to_ascii_uppercase();
    if normalized_uid.is_empty() {
        return Ok(serde_json::json!({
            "success": false,
            "error": {
                "code": "INVALID_RFID_UID",
                "message": "Invalid RFID UID scanned"
            }
        }));
    }

    let user_row = sqlx::query(
        "SELECT user_id, full_name, department, status, gender, card_type, photo_url FROM users WHERE rfid_uid = ?",
    )
    .bind(&normalized_uid)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    let user_row = match user_row {
        Some(row) => row,
        None => {
            return Ok(serde_json::json!({
                "success": false,
                "error": {
                    "code": "USER_NOT_FOUND",
                    "message": "Card not registered. Please enroll in Admin Setup."
                }
            }));
        }
    };

    let user_status: String = user_row.get("status");
    if user_status != "ACTIVE" {
        return Ok(serde_json::json!({
            "success": false,
            "error": {
                "code": "USER_INACTIVE",
                "message": "Employee record is inactive."
            }
        }));
    }

    let card_type: Option<String> = user_row.get("card_type");
    if card_type.as_deref() == Some("ADMIN_ASSIST") {
        return Ok(serde_json::json!({
            "success": false,
            "error": {
                "code": "ADMIN_CARD_NOT_ALLOWED",
                "message": "Admin Assist cards cannot checkout bathroom keys."
            }
        }));
    }

    let user_id: String = user_row.get("user_id");
    let full_name: String = user_row.get("full_name");
    let department: Option<String> = user_row.get("department");
    let photo_url: Option<String> = user_row.get("photo_url");
    let gender_raw: Option<String> = user_row.get("gender");

    let gender_key = match gender_raw.as_deref() {
        Some("FEMALE") => "FEMALE",
        _ => "MALE",
    };

    let active_row = sqlx::query(
        "SELECT log_id, user_id, full_name, time_out FROM bathroom_log WHERE gender_key = ? AND status = 'OUT'",
    )
    .bind(gender_key)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    let now_manila = chrono::Utc::now().with_timezone(&Manila);
    let now_iso = now_manila.to_rfc3339();
    let today_str = now_manila.date_naive().format("%Y-%m-%d").to_string();

    if let Some(active) = active_row {
        let active_user_id: String = active.get("user_id");
        let active_log_id: String = active.get("log_id");
        let active_full_name: String = active.get("full_name");
        let active_time_out_str: String = active.get("time_out");

        if active_user_id == user_id {
            // RETURNING KEY (Time In)
            let out_dt = chrono::DateTime::parse_from_rfc3339(&active_time_out_str)
                .map(|dt| dt.with_timezone(&Manila))
                .unwrap_or(now_manila);
            let duration_seconds = (now_manila - out_dt).num_seconds().max(0);

            sqlx::query(
                "UPDATE bathroom_log SET time_in = ?, duration_seconds = ?, status = 'RETURNED', updated_at = ? WHERE log_id = ?",
            )
            .bind(&now_iso)
            .bind(duration_seconds)
            .bind(&now_iso)
            .bind(&active_log_id)
            .execute(&state.db)
            .await
            .map_err(|e| e.to_string())?;

            return Ok(serde_json::json!({
                "success": true,
                "action": "RETURN",
                "genderKey": gender_key,
                "user": {
                    "userId": user_id,
                    "fullName": full_name,
                    "department": department,
                    "photoUrl": photo_url,
                    "gender": gender_key
                },
                "timeOut": active_time_out_str,
                "timeIn": now_iso,
                "durationSeconds": duration_seconds,
                "message": format!("{} Key Returned by {}", if gender_key == "MALE" { "Male" } else { "Female" }, full_name),
                "timestamp": now_iso
            }));
        } else {
            // CONFLICT: Key is with someone else
            return Ok(serde_json::json!({
                "success": false,
                "error": {
                    "code": "BATHROOM_KEY_IN_USE",
                    "message": format!("The {} bathroom key is currently in use by {}.", if gender_key == "MALE" { "male" } else { "female" }, active_full_name)
                },
                "genderKey": gender_key,
                "activeHolder": {
                    "logId": active_log_id,
                    "userId": active_user_id,
                    "fullName": active_full_name,
                    "genderKey": gender_key,
                    "timeOut": active_time_out_str
                }
            }));
        }
    }

    // CHECKOUT KEY (Time Out)
    let log_id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO bathroom_log (log_id, log_date, user_id, full_name, department, gender_key, time_out, status, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'OUT', '', ?, ?)",
    )
    .bind(&log_id)
    .bind(&today_str)
    .bind(&user_id)
    .bind(&full_name)
    .bind(&department)
    .bind(gender_key)
    .bind(&now_iso)
    .bind(&now_iso)
    .bind(&now_iso)
    .execute(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "success": true,
        "action": "CHECKOUT",
        "genderKey": gender_key,
        "user": {
            "userId": user_id,
            "fullName": full_name,
            "department": department,
            "photoUrl": photo_url,
            "gender": gender_key
        },
        "timeOut": now_iso,
        "timeIn": null,
        "durationSeconds": null,
        "message": format!("{} Key Checked Out to {}", if gender_key == "MALE" { "Male" } else { "Female" }, full_name),
        "timestamp": now_iso
    }))
}

#[tauri::command]
async fn bathroom_scan_rfid(
    state: State<'_, AppState>,
    rfid_uid: String,
) -> Result<serde_json::Value, String> {
    process_bathroom_scan(&state, &rfid_uid).await
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
    let payroll_ids: Vec<String> =
        sqlx::query("SELECT payroll_id FROM payroll WHERE attendance_id=?")
            .bind(&attendance_id)
            .fetch_all(&state.db)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|row| row.get::<String, _>("payroll_id"))
            .collect();
    let grace_rows: Vec<(String, String)> =
        sqlx::query("SELECT grace_id, user_id FROM intern_grace WHERE attendance_id=?")
            .bind(&attendance_id)
            .fetch_all(&state.db)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|row| {
                (
                    row.get::<String, _>("grace_id"),
                    row.get::<String, _>("user_id"),
                )
            })
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

async fn admin_create_backdated_attendance_impl(
    app: Option<&tauri::AppHandle>,
    state: &AppState,
    token: &str,
    payload: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(state, token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let user_id = payload
        .get("userId")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "ADMIN_VALIDATION_ERROR".to_string())?;
    let attendance_date = payload
        .get("attendanceDate")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "ADMIN_VALIDATION_ERROR".to_string())?;
    let time_in = payload
        .get("timeIn")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "ADMIN_VALIDATION_ERROR".to_string())?;
    let time_out = payload
        .get("timeOut")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    let reason = payload
        .get("reason")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "ADMIN_VALIDATION_ERROR".to_string())?;

    let parsed_date = chrono::NaiveDate::parse_from_str(attendance_date, "%Y-%m-%d")
        .map_err(|_| "ADMIN_VALIDATION_ERROR".to_string())?;
    let now_manila = chrono::Utc::now().with_timezone(&Manila);
    if parsed_date >= now_manila.date_naive() {
        return Err("ADMIN_VALIDATION_ERROR".into());
    }

    if chrono::DateTime::parse_from_rfc3339(time_in).is_err()
        || time_out.is_some_and(|to| chrono::DateTime::parse_from_rfc3339(to).is_err())
    {
        return Err("ADMIN_VALIDATION_ERROR".into());
    }
    if let Some(to) = time_out {
        let t_in = chrono::DateTime::parse_from_rfc3339(time_in).unwrap();
        let t_out = chrono::DateTime::parse_from_rfc3339(to).unwrap();
        if t_out < t_in {
            return Err("ADMIN_VALIDATION_ERROR".into());
        }
    }

    let user = match sqlx::query(
        "SELECT user_id, full_name, department, employee_type, daily_rate_centavos, photo_url, status, gender, card_type, rfid_uid FROM users WHERE user_id = ?"
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| e.to_string())? {
        Some(u) => u,
        None => return Err("USER_NOT_FOUND".into()),
    };
    if user.get::<String, _>("status") != "ACTIVE" {
        return Err("INACTIVE_USER".into());
    }
    if user.try_get::<String, _>("card_type").unwrap_or_default() == "ADMIN_ASSIST" {
        return Err("ADMIN_CARD_REQUIRES_SELECTION".into());
    }

    let existing = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM attendance WHERE user_id = ? AND attendance_date = ?"
    )
    .bind(user_id)
    .bind(attendance_date)
    .fetch_one(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    if existing > 0 {
        return Err("ATTENDANCE_ALREADY_EXISTS_FOR_DATE".into());
    }

    let finalized_cutoff = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM payroll_cutoffs WHERE employee_id = ? AND status = 'FINALIZED' AND ? >= cutoff_start AND ? <= cutoff_end"
    )
    .bind(user_id)
    .bind(attendance_date)
    .bind(attendance_date)
    .fetch_one(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    if finalized_cutoff > 0 {
        return Err("BACKDATE_LIMIT_EXCEEDED".into());
    }

    let late = time_out.is_some_and(|to| crate::services::office_hours::is_late_timeout(to));
    let status = if time_out.is_some() {
        if late { "LATE_TIMEOUT" } else { "COMPLETED" }
    } else {
        "WORKING"
    };

    let attendance_id = uuid::Uuid::new_v4().to_string();
    let now_ts = now_manila.to_rfc3339();
    let rfid_uid: String = user.get("rfid_uid");
    let full_name: String = user.get("full_name");
    let department: Option<String> = user.get("department");

    sqlx::query(
        "INSERT INTO attendance (attendance_id, attendance_date, user_id, rfid_uid, full_name, department, time_in, time_out, status, source, notes, recorded_by, recorded_reason, recorded_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ADMIN_BACKDATED_ENTRY', '', 'Admin', ?, ?, ?, ?)"
    )
    .bind(&attendance_id)
    .bind(attendance_date)
    .bind(user_id)
    .bind(&rfid_uid)
    .bind(&full_name)
    .bind(&department)
    .bind(time_in)
    .bind(time_out)
    .bind(status)
    .bind(reason)
    .bind(&now_ts)
    .bind(&now_ts)
    .bind(&now_ts)
    .execute(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    if status == "COMPLETED" {
        if let Some(actual_out) = time_out {
            let employee_type: String = user.get("employee_type");
            let daily_rate: Option<i64> = user.get("daily_rate_centavos");
            let _ = ensure_payroll(
                state,
                &attendance_id,
                user_id,
                full_name.clone(),
                &employee_type,
                daily_rate,
                attendance_date,
                time_in,
                actual_out,
            ).await;
        }
    }

    let seq = state.next_sequence();
    let event_payload = serde_json::json!({
        "attendanceId": attendance_id.clone(),
        "attendanceDate": attendance_date,
        "userId": user_id,
        "action": "BACKDATED_ATTENDANCE",
        "timeIn": time_in,
        "timeOut": time_out,
        "status": status,
        "sequence": seq
    });
    if let Some(app_handle) = app {
        let _ = app_handle.emit("attendance-updated", &event_payload);
        let _ = app_handle.emit("attendance-changed", &event_payload);
    }
    let _ = sqlx::query(
        "INSERT INTO audit_logs (log_id, timestamp, event_type, user_id, message, request_id) VALUES (?, ?, 'ADMIN_ATTENDANCE_CREATED', ?, ?, ?)"
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(&now_ts)
    .bind(user_id)
    .bind(format!("Backdated attendance created for {}: {}", attendance_date, reason))
    .bind(format!("admin-{}", uuid::Uuid::new_v4()))
    .execute(&state.db)
    .await;

    let sync_payload = serde_json::json!({
        "attendanceId": attendance_id,
        "attendanceDate": attendance_date,
        "userId": user_id,
        "timeIn": time_in,
        "timeOut": time_out,
        "status": status,
        "source": "ADMIN_BACKDATED_ENTRY",
        "recordedBy": "Admin",
        "recordedReason": reason,
        "recordedAt": now_ts,
    });
    enqueue_sync(state, "Attendance", &attendance_id, "UPSERT", &sync_payload).await;

    Ok(serde_json::json!({
        "success": true,
        "attendance": {
            "attendanceId": attendance_id,
            "attendanceDate": attendance_date,
            "userId": user_id,
            "fullName": full_name,
            "department": department,
            "timeIn": time_in,
            "timeOut": time_out,
            "status": status,
            "source": "ADMIN_BACKDATED_ENTRY",
            "recordedBy": "Admin",
            "recordedReason": reason,
            "recordedAt": now_ts,
        }
    }))
}

#[tauri::command]
async fn admin_create_backdated_attendance(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    token: String,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    admin_create_backdated_attendance_impl(Some(&app), &state, &token, &payload).await
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
    let payroll_ids: Vec<String> =
        sqlx::query("SELECT payroll_id FROM payroll WHERE attendance_id=?")
            .bind(&attendance_id)
            .fetch_all(&state.db)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|row| row.get::<String, _>("payroll_id"))
            .collect();
    let grace_rows: Vec<(String, String)> =
        sqlx::query("SELECT grace_id, user_id FROM intern_grace WHERE attendance_id=?")
            .bind(&attendance_id)
            .fetch_all(&state.db)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|row| {
                (
                    row.get::<String, _>("grace_id"),
                    row.get::<String, _>("user_id"),
                )
            })
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
    let parsed = cutoff_input(&input);
    let result = crate::services::cutoff_payroll::calculate(&parsed)?;
    Ok(serde_json::json!({
        "success": true,
        "result": {
            "basicPayCentavos": result.basic_pay,
            "hraCentavos": result.hra,
            "incentivesAllowanceCentavos": result.incentives_allowance,
            "specialAllowanceCentavos": result.special_allowance,
            "specialHolidayPayCentavos": result.special_holiday_pay,
            "regularHolidayPayCentavos": result.regular_holiday_pay,
            "totalCompensationCentavos": result.total_compensation,
            "totalAllowanceCentavos": result.total_allowance,
            "lateDeductionCentavos": result.late_deduction,
            "halfDayDeductionCentavos": result.half_day_deduction,
            "absenceDeductionCentavos": result.absence_deduction,
            "overtimePayCentavos": result.overtime_pay,
            "sssCentavos": result.sss_employee_share,
            "phicCentavos": result.phic_employee_share,
            "hdmfCentavos": result.hdmf_employee_share,
            "salaryAdvanceCentavos": result.salary_advance,
            "totalDeductionsCentavos": result.total_deductions,
            "grossCompensationCentavos": result.gross_compensation,
            "netPayCentavos": result.net_pay
        }
    }))
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
    let rows = sqlx::query(
        "SELECT pc.payroll_id, pc.employee_id, pc.employee_name, pc.payroll_profile_id, pc.payroll_cutoff_label, \
         pc.cutoff_start, pc.cutoff_end, pc.daily_rate_centavos, pc.standard_working_days, pc.actual_working_days, \
         pc.basic_pay_centavos, pc.special_holiday_days, pc.special_holiday_multiplier, pc.special_holiday_pay_centavos, \
         pc.regular_holiday_days, pc.regular_holiday_multiplier, pc.regular_holiday_pay_centavos, \
         pc.incentives_allowance_centavos, pc.special_allowance_centavos, pc.total_compensation_centavos, \
         pc.total_allowance_centavos, pc.late_units, pc.late_deduction_centavos, pc.half_day_count, \
         pc.half_day_deduction_centavos, pc.absent_days, pc.absence_deduction_centavos, pc.overtime_hours, \
         pc.overtime_rate_centavos, pc.overtime_pay_centavos, pc.manual_adjustment_centavos, pc.adjustment_reason, \
         pc.gross_compensation_centavos, pc.net_pay_centavos, pc.signature_placeholder, pc.calculation_breakdown, \
         pc.approved_working_day_overage, pc.status, pc.finalized_at, pc.revision, \
         pc.hra_centavos, pc.sss_centavos, pc.phic_centavos, pc.hdmf_centavos, pc.salary_advance_centavos, \
         COALESCE(NULLIF(pc.tin, ''), u.tin, '') AS tin, \
         COALESCE(NULLIF(pc.bank_name, ''), u.bank_name, 'CASH') AS bank_name, \
         COALESCE(NULLIF(pc.account_number, ''), u.account_number, '0000') AS account_number, \
         COALESCE(NULLIF(pc.department, ''), u.department, '') AS department, \
         COALESCE(NULLIF(pc.designation, ''), u.designation, u.employee_type, 'EMPLOYEE') AS designation \
         FROM payroll_cutoffs pc LEFT JOIN users u ON u.user_id = pc.employee_id \
         ORDER BY pc.cutoff_start DESC, pc.employee_name",
    )
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    // Payroll cutoff rows do not store an employee type; derive intern vs
    // employee classification from the Users register so the printable
    // worksheet can apply the intern layout and labels.
    let employee_types: HashMap<String, String> =
        sqlx::query("SELECT user_id, employee_type FROM users")
            .fetch_all(&state.db)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|row| {
                (
                    row.get::<String, _>("user_id"),
                    row.get::<String, _>("employee_type"),
                )
            })
            .collect();
    Ok(
        serde_json::json!({"success":true,"payroll":rows.iter().map(|row| payroll_cutoff_json(row, employee_types.get(&row.get::<String,_>("employee_id")).map(String::as_str))).collect::<Vec<_>>() }),
    )
}

fn payroll_cutoff_json(row: &SqliteRow, employee_type: Option<&str>) -> serde_json::Value {
    // Built as an explicit map so the value never depends on the json! macro
    // recursion budget (the record is large and frequently extended).
    let mut map = serde_json::Map::new();
    let mut insert = |key: &str, value: serde_json::Value| {
        map.insert(key.into(), value);
    };
    insert(
        "payrollId",
        serde_json::json!(row.get::<String, _>("payroll_id")),
    );
    insert(
        "employeeId",
        serde_json::json!(row.get::<String, _>("employee_id")),
    );
    insert(
        "employeeName",
        serde_json::json!(row.get::<String, _>("employee_name")),
    );
    insert(
        "employeeType",
        serde_json::json!(if employee_type == Some("EMPLOYEE") {
            "EMPLOYEE"
        } else {
            "INTERN"
        }),
    );
    insert(
        "payrollProfileId",
        serde_json::json!(row.get::<String, _>("payroll_profile_id")),
    );
    insert(
        "payrollCutoffLabel",
        serde_json::json!(row.get::<String, _>("payroll_cutoff_label")),
    );
    insert(
        "cutoffStart",
        serde_json::json!(row.get::<String, _>("cutoff_start")),
    );
    insert(
        "cutoffEnd",
        serde_json::json!(row.get::<String, _>("cutoff_end")),
    );
    insert("payrollFrequency", serde_json::json!("SEMI_MONTHLY"));
    insert(
        "dailyRate",
        serde_json::json!(row.get::<i64, _>("daily_rate_centavos") as f64 / 100.0),
    );
    insert(
        "standardWorkingDays",
        serde_json::json!(row.get::<f64, _>("standard_working_days")),
    );
    insert(
        "actualWorkingDays",
        serde_json::json!(row.get::<f64, _>("actual_working_days")),
    );
    insert(
        "basicPay",
        serde_json::json!(row.get::<i64, _>("basic_pay_centavos") as f64 / 100.0),
    );
    insert(
        "specialHolidayDays",
        serde_json::json!(row.get::<f64, _>("special_holiday_days")),
    );
    insert(
        "specialHolidayMultiplier",
        serde_json::json!(row.get::<f64, _>("special_holiday_multiplier")),
    );
    insert(
        "specialHolidayPay",
        serde_json::json!(row.get::<i64, _>("special_holiday_pay_centavos") as f64 / 100.0),
    );
    insert(
        "regularHolidayDays",
        serde_json::json!(row.get::<f64, _>("regular_holiday_days")),
    );
    insert(
        "regularHolidayMultiplier",
        serde_json::json!(row.get::<f64, _>("regular_holiday_multiplier")),
    );
    insert(
        "regularHolidayPay",
        serde_json::json!(row.get::<i64, _>("regular_holiday_pay_centavos") as f64 / 100.0),
    );
    let hra = row.get::<i64, _>("hra_centavos") as f64 / 100.0;
    let incentives = row.get::<i64, _>("incentives_allowance_centavos") as f64 / 100.0;
    let special_allowance = row.get::<i64, _>("special_allowance_centavos") as f64 / 100.0;
    let late_ded = row.get::<i64, _>("late_deduction_centavos") as f64 / 100.0;
    let half_ded = row.get::<i64, _>("half_day_deduction_centavos") as f64 / 100.0;
    let abs_ded = row.get::<i64, _>("absence_deduction_centavos") as f64 / 100.0;
    let sss = row.get::<i64, _>("sss_centavos") as f64 / 100.0;
    let phic = row.get::<i64, _>("phic_centavos") as f64 / 100.0;
    let hdmf = row.get::<i64, _>("hdmf_centavos") as f64 / 100.0;
    let salary_advance = row.get::<i64, _>("salary_advance_centavos") as f64 / 100.0;
    let total_deductions = late_ded + half_ded + abs_ded + sss + phic + hdmf + salary_advance;

    insert("hra", serde_json::json!(hra));
    insert("incentivesAllowance", serde_json::json!(incentives));
    insert("specialAllowance", serde_json::json!(special_allowance));
    insert(
        "totalCompensation",
        serde_json::json!(row.get::<i64, _>("total_compensation_centavos") as f64 / 100.0),
    );
    insert(
        "totalAllowance",
        serde_json::json!(row.get::<i64, _>("total_allowance_centavos") as f64 / 100.0),
    );
    insert(
        "lateUnits",
        serde_json::json!(row.get::<f64, _>("late_units")),
    );
    insert("lateDeduction", serde_json::json!(late_ded));
    insert(
        "halfDayCount",
        serde_json::json!(row.get::<f64, _>("half_day_count")),
    );
    insert("halfDayDeduction", serde_json::json!(half_ded));
    insert(
        "absentDays",
        serde_json::json!(row.get::<f64, _>("absent_days")),
    );
    insert("absenceDeduction", serde_json::json!(abs_ded));
    insert(
        "overtimeHours",
        serde_json::json!(row.get::<f64, _>("overtime_hours")),
    );
    insert(
        "overtimeRate",
        serde_json::json!(row.get::<i64, _>("overtime_rate_centavos") as f64 / 100.0),
    );
    insert(
        "overtimePay",
        serde_json::json!(row.get::<i64, _>("overtime_pay_centavos") as f64 / 100.0),
    );
    insert("sss", serde_json::json!(sss));
    insert("phic", serde_json::json!(phic));
    insert("hdmf", serde_json::json!(hdmf));
    insert("salaryAdvance", serde_json::json!(salary_advance));
    insert("totalDeductions", serde_json::json!(total_deductions));
    insert(
        "tin",
        serde_json::json!(row.get::<String, _>("tin")),
    );
    insert(
        "bankName",
        serde_json::json!(row.get::<String, _>("bank_name")),
    );
    insert(
        "accountNumber",
        serde_json::json!(row.get::<String, _>("account_number")),
    );
    insert(
        "department",
        serde_json::json!(row.get::<String, _>("department")),
    );
    insert(
        "designation",
        serde_json::json!(row.get::<String, _>("designation")),
    );
    insert(
        "manualAdjustment",
        serde_json::json!(row.get::<i64, _>("manual_adjustment_centavos") as f64 / 100.0),
    );
    insert(
        "adjustmentReason",
        serde_json::json!(row.get::<Option<String>, _>("adjustment_reason")),
    );
    insert(
        "grossCompensation",
        serde_json::json!(row.get::<i64, _>("gross_compensation_centavos") as f64 / 100.0),
    );
    insert(
        "netPay",
        serde_json::json!(row.get::<i64, _>("net_pay_centavos") as f64 / 100.0),
    );
    insert(
        "calculationBreakdown",
        serde_json::json!(row.get::<String, _>("calculation_breakdown")),
    );
    insert(
        "approvedWorkingDayOverage",
        serde_json::json!(row.get::<i64, _>("approved_working_day_overage") != 0),
    );
    insert("status", serde_json::json!(row.get::<String, _>("status")));
    insert(
        "finalizedAt",
        serde_json::json!(row.get::<Option<String>, _>("finalized_at")),
    );
    insert("revision", serde_json::json!(row.get::<i64, _>("revision")));
    serde_json::Value::Object(map)
}

#[tauri::command]
async fn payroll_intern_report(
    state: State<'_, AppState>,
    token: String,
    cutoff_start: String,
    cutoff_end: String,
    payroll_cutoff_label: String,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    chrono::NaiveDate::parse_from_str(&cutoff_start, "%Y-%m-%d")
        .map_err(|_| "INVALID_CUTOFF_DATES".to_string())?;
    chrono::NaiveDate::parse_from_str(&cutoff_end, "%Y-%m-%d")
        .map_err(|_| "INVALID_CUTOFF_DATES".to_string())?;
    if cutoff_end < cutoff_start {
        return Err("INVALID_CUTOFF_DATES".into());
    }
    let rows = sqlx::query(
        "SELECT u.user_id, u.full_name, \
         COALESCE(COUNT(p.payroll_id), 0) AS actual_days, \
         COALESCE(SUM(CASE WHEN p.is_half_day = 1 OR (p.actual_time_in IS NOT NULL AND p.actual_time_out IS NOT NULL AND (strftime('%s', p.actual_time_out) - strftime('%s', p.actual_time_in)) <= 18000) THEN 1 ELSE 0 END), 0) AS half_day_count, \
         COALESCE(SUM(p.base_pay_centavos), 0) AS basic_pay, \
         COALESCE(SUM(p.late_hours), 0) AS late_units, \
         COALESCE(SUM(p.late_deduction_centavos), 0) AS late_deduction \
         FROM users u \
         LEFT JOIN payroll p ON p.user_id = u.user_id AND p.attendance_date >= ? AND p.attendance_date <= ? \
         WHERE u.employee_type = 'INTERN' \
         GROUP BY u.user_id, u.full_name \
         ORDER BY u.full_name",
    )
    .bind(&cutoff_start)
    .bind(&cutoff_end)
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    let payroll = rows
        .into_iter()
        .map(|row| {
            let actual_days = row.get::<i64, _>("actual_days") as f64;
            let half_day_count = row.get::<i64, _>("half_day_count") as f64;
            let standard_days = 11.0;
            let absent_days = (standard_days - actual_days).max(0.0);
            let daily_rate = 80.0;
            let total_comp = standard_days * daily_rate;
            let absence_deduction = absent_days * daily_rate;
            let half_day_deduction = half_day_count * (daily_rate * 0.5);
            let late_units = row.get::<i64, _>("late_units") as f64;
            let late_deduction = row.get::<i64, _>("late_deduction") as f64 / 100.0;
            let total_deductions = late_deduction + half_day_deduction + absence_deduction;
            let gross = (total_comp - total_deductions).max(0.0);
            let user_id = row.get::<String, _>("user_id");
            serde_json::json!({
                "payrollId": format!("INTERN-{}-{}-{}", user_id, cutoff_start, cutoff_end),
                "employeeId": user_id,
                "employeeName": row.get::<String, _>("full_name"),
                "employeeType": "INTERN",
                "payrollProfileId": "INTERN_STANDARD",
                "payrollCutoffLabel": payroll_cutoff_label,
                "cutoffStart": cutoff_start,
                "cutoffEnd": cutoff_end,
                "payrollFrequency": "SEMI_MONTHLY",
                "dailyRate": daily_rate,
                "standardWorkingDays": standard_days,
                "actualWorkingDays": actual_days,
                "basicPay": total_comp,
                "specialHolidayDays": 0,
                "specialHolidayMultiplier": 0,
                "specialHolidayPay": 0,
                "regularHolidayDays": 0,
                "regularHolidayMultiplier": 0,
                "regularHolidayPay": 0,
                "incentivesAllowance": 0,
                "specialAllowance": 0,
                "totalCompensation": total_comp,
                "totalAllowance": 0,
                "lateUnits": late_units,
                "lateDeduction": late_deduction,
                "halfDayCount": half_day_count,
                "halfDayDeduction": half_day_deduction,
                "absentDays": absent_days,
                "absenceDeduction": absence_deduction,
                "overtimeHours": 0,
                "overtimeRate": 0,
                "overtimePay": 0,
                "manualAdjustment": 0,
                "adjustmentReason": null,
                "grossCompensation": gross,
                "netPay": gross,
                "calculationBreakdown": "attendance report",
                "approvedWorkingDayOverage": true,
                "status": "REPORT",
                "finalizedAt": null,
                "revision": 1
            })
        })
        .collect::<Vec<_>>();
    Ok(serde_json::json!({"success":true,"payroll":payroll}))
}

fn count_workdays(start_str: &str, end_str: &str) -> f64 {
    if let (Ok(start), Ok(end)) = (
        chrono::NaiveDate::parse_from_str(start_str, "%Y-%m-%d"),
        chrono::NaiveDate::parse_from_str(end_str, "%Y-%m-%d"),
    ) {
        if end >= start {
            use chrono::Datelike;
            let mut current = start;
            let mut workdays = 0.0;
            while current <= end {
                if current.weekday().number_from_monday() <= 5 {
                    workdays += 1.0;
                }
                current += chrono::Duration::days(1);
            }
            return workdays;
        }
    }
    11.0
}

/// Build the printable payroll register from completed attendance payroll rows.
/// Drafts are replaceable so a later time-out is reflected on regeneration;
/// finalized payroll remains an immutable approved record.
#[tauri::command]
async fn payroll_generate_cutoff(
    state: State<'_, AppState>,
    token: String,
    cutoff_start: String,
    cutoff_end: String,
    payroll_cutoff_label: String,
    customization: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    chrono::NaiveDate::parse_from_str(&cutoff_start, "%Y-%m-%d")
        .map_err(|_| "INVALID_CUTOFF_DATES".to_string())?;
    chrono::NaiveDate::parse_from_str(&cutoff_end, "%Y-%m-%d")
        .map_err(|_| "INVALID_CUTOFF_DATES".to_string())?;
    if cutoff_end < cutoff_start {
        return Err("INVALID_CUTOFF_DATES".into());
    }

    // A draft is a live view of attendance. Remove the prior generated draft
    // before rebuilding it, while preserving approved cutoff records.
    if let Some(selected_id) = customization.get("employeeId").and_then(|v| v.as_str()) {
        sqlx::query("DELETE FROM payroll_cutoffs WHERE employee_id=? AND cutoff_start=? AND cutoff_end=? AND status='DRAFT'")
            .bind(selected_id).bind(&cutoff_start).bind(&cutoff_end).execute(&state.db).await.map_err(|e| e.to_string())?;
    } else {
        sqlx::query(
            "DELETE FROM payroll_cutoffs WHERE cutoff_start=? AND cutoff_end=? AND status='DRAFT'",
        )
        .bind(&cutoff_start)
        .bind(&cutoff_end)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    }

    let rows = sqlx::query(
        "SELECT p.user_id, MAX(p.full_name) AS full_name, MAX(p.employee_type) AS employee_type, \
         COALESCE(MAX(u.daily_rate_centavos), MAX(p.base_pay_centavos), 0) AS daily_rate_centavos, \
         COUNT(*) AS actual_days, \
         SUM(CASE WHEN p.is_half_day = 1 OR (p.actual_time_in IS NOT NULL AND p.actual_time_out IS NOT NULL AND (strftime('%s', p.actual_time_out) - strftime('%s', p.actual_time_in)) <= 18000) THEN 1 ELSE 0 END) AS half_day_count, \
         SUM(p.late_hours) AS late_units, \
         SUM(p.late_deduction_centavos) AS late_deduction_centavos, \
         u.payroll_profile_id \
         FROM payroll p JOIN users u ON u.user_id=p.user_id \
         WHERE p.attendance_date >= ? AND p.attendance_date <= ? \
         GROUP BY p.user_id, u.payroll_profile_id \
         ORDER BY full_name"
    ).bind(&cutoff_start).bind(&cutoff_end).fetch_all(&state.db).await.map_err(|e| e.to_string())?;

    let now = chrono::Utc::now().to_rfc3339();
    let mut generated = 0usize;
    for row in rows {
        let employee_id: String = row.get("user_id");
        if let Some(selected_id) = customization.get("employeeId").and_then(|v| v.as_str()) {
            if selected_id != employee_id {
                continue;
            }
        }
        let employee_name: String = row.get("full_name");
        let employee_type: String = row.get("employee_type");
        let is_intern = employee_type != "EMPLOYEE";
        let finalized_exists = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM payroll_cutoffs WHERE employee_id=? AND cutoff_start=? AND cutoff_end=? AND status='FINALIZED'")
            .bind(&employee_id).bind(&cutoff_start).bind(&cutoff_end).fetch_one(&state.db).await.map_err(|e| e.to_string())? > 0;
        if finalized_exists {
            continue;
        }
        let profile_id = if is_intern {
            INTERN_PAYROLL_PROFILE_ID.to_string()
        } else {
            customization
                .get("payrollProfileId")
                .and_then(|v| v.as_str())
                .map(String::from)
                .or_else(|| row.get::<Option<String>, _>("payroll_profile_id"))
                .unwrap_or_else(|| "BEA_STANDARD".into())
        };
        let profile = sqlx::query("SELECT standard_working_days_per_cutoff,incentives_allowance_centavos,special_allowance_centavos,special_holiday_multiplier,regular_holiday_multiplier,half_day_fraction,overtime_rate_centavos FROM payroll_profiles WHERE profile_id=?")
            .bind(&profile_id).fetch_optional(&state.db).await.map_err(|e| e.to_string())?;
        let custom_number = |name: &str| customization.get(name).and_then(|v| v.as_f64());
        let calculated_workdays = count_workdays(&cutoff_start, &cutoff_end);
        let standard_days = custom_number("standardWorkingDays").unwrap_or(calculated_workdays);
        let daily_rate_centavos = if is_intern {
            INTERN_DAILY_RATE_PHP * 100
        } else {
            row.get::<i64, _>("daily_rate_centavos")
        };
        let actual_days = row.get::<i64, _>("actual_days") as f64;
        let late_units = row.get::<i64, _>("late_units") as f64;
        let late_deduction_centavos = if is_intern {
            row.get::<i64, _>("late_deduction_centavos")
        } else {
            0
        };
        let incentives_centavos = if is_intern {
            0
        } else {
            custom_number("incentivesAllowance")
                .map(|v| (v * 100.0).round() as i64)
                .or_else(|| {
                    profile
                        .as_ref()
                        .map(|p| p.get::<i64, _>("incentives_allowance_centavos"))
                })
                .unwrap_or(0)
        };
        let special_allowance_centavos = if is_intern {
            0
        } else {
            custom_number("specialAllowance")
                .map(|v| (v * 100.0).round() as i64)
                .or_else(|| {
                    profile
                        .as_ref()
                        .map(|p| p.get::<i64, _>("special_allowance_centavos"))
                })
                .unwrap_or(0)
        };
        let special_multiplier = if is_intern {
            0.0
        } else {
            custom_number("specialHolidayMultiplier")
                .or_else(|| {
                    profile
                        .as_ref()
                        .map(|p| p.get::<f64, _>("special_holiday_multiplier"))
                })
                .unwrap_or(0.3)
        };
        let regular_multiplier = if is_intern {
            0.0
        } else {
            custom_number("regularHolidayMultiplier")
                .or_else(|| {
                    profile
                        .as_ref()
                        .map(|p| p.get::<f64, _>("regular_holiday_multiplier"))
                })
                .unwrap_or(1.0)
        };
        let half_day_fraction = profile
            .as_ref()
            .map(|p| p.get::<f64, _>("half_day_fraction"))
            .unwrap_or(0.5);
        let overtime_rate_centavos = if is_intern {
            0
        } else {
            custom_number("overtimeRate")
                .map(|v| (v * 100.0).round() as i64)
                .or_else(|| {
                    profile
                        .as_ref()
                        .map(|p| p.get::<i64, _>("overtime_rate_centavos"))
                })
                .unwrap_or(0)
        };
        let special_holiday_days = if is_intern {
            0.0
        } else {
            custom_number("specialHolidayDays").unwrap_or(0.0)
        };
        let regular_holiday_days = if is_intern {
            0.0
        } else {
            custom_number("regularHolidayDays").unwrap_or(0.0)
        };
        let half_day_count = custom_number("halfDayCount")
            .unwrap_or(row.get::<i64, _>("half_day_count") as f64);
        let overtime_hours = if is_intern {
            0.0
        } else {
            custom_number("overtimeHours").unwrap_or(0.0)
        };
        let late_rate = custom_number("lateDeductionRate").unwrap_or(0.0);
        let late_deduction = if is_intern {
            late_deduction_centavos as f64 / 100.0
        } else {
            late_units * late_rate
        };
        let absent_days = custom_number("absentDays").unwrap_or_else(|| (standard_days - actual_days).max(0.0));
        let manual_adjustment = custom_number("manualAdjustment").unwrap_or(0.0);
        let input = crate::services::cutoff_payroll::CutoffInput {
            employee_id: employee_id.clone(),
            employee_name: employee_name.clone(),
            cutoff_start: cutoff_start.clone(),
            cutoff_end: cutoff_end.clone(),
            daily_rate: daily_rate_centavos as f64 / 100.0,
            standard_working_days: standard_days,
            actual_working_days: actual_days,
            basic_pay: None,
            special_holiday_days,
            special_holiday_multiplier: special_multiplier,
            special_holiday_pay: None,
            regular_holiday_days,
            regular_holiday_multiplier: regular_multiplier,
            regular_holiday_pay: None,
            hra: 0.0,
            incentives_allowance: incentives_centavos as f64 / 100.0,
            special_allowance: special_allowance_centavos as f64 / 100.0,
            late_deduction,
            half_day_count,
            half_day_fraction,
            absent_days,
            absence_deduction: None,
            overtime_hours,
            overtime_rate: overtime_rate_centavos as f64 / 100.0,
            overtime_pay: None,
            sss_employee_share: 0.0,
            phic_employee_share: 0.0,
            hdmf_employee_share: 0.0,
            salary_advance: 0.0,
            manual_adjustment,
            adjustment_reason: customization
                .get("adjustmentReason")
                .and_then(|v| v.as_str())
                .map(String::from),
            approved_working_day_overage: true,
        };
        let calculated = crate::services::cutoff_payroll::calculate(&input)?;
        let gross_amount = if is_intern {
            calculated.net_pay.max(0)
        } else {
            calculated.gross_compensation
        };
        let net_amount = if is_intern {
            calculated.net_pay.max(0)
        } else {
            calculated.net_pay
        };
        let payroll_id = uuid::Uuid::new_v4().to_string();
        let query = format!("INSERT INTO payroll_cutoffs (payroll_id,employee_id,employee_name,payroll_profile_id,payroll_cutoff_label,cutoff_start,cutoff_end,payroll_frequency,daily_rate_centavos,standard_working_days,actual_working_days,basic_pay_centavos,special_holiday_days,special_holiday_multiplier,special_holiday_pay_centavos,regular_holiday_days,regular_holiday_multiplier,regular_holiday_pay_centavos,incentives_allowance_centavos,special_allowance_centavos,total_compensation_centavos,total_allowance_centavos,late_units,late_deduction_centavos,half_day_count,half_day_deduction_centavos,absent_days,absence_deduction_centavos,overtime_hours,overtime_rate_centavos,overtime_pay_centavos,manual_adjustment_centavos,adjustment_reason,gross_compensation_centavos,net_pay_centavos,signature_placeholder,calculation_breakdown,approved_working_day_overage,status,hra_centavos,sss_centavos,phic_centavos,hdmf_centavos,salary_advance_centavos,created_at,updated_at) VALUES ({})", std::iter::repeat("?").take(46).collect::<Vec<_>>().join(","));
        sqlx::query(&query)
            .bind(&payroll_id).bind(&employee_id).bind(&employee_name).bind(&profile_id).bind(&payroll_cutoff_label).bind(&cutoff_start).bind(&cutoff_end).bind("SEMI_MONTHLY")
            .bind(daily_rate_centavos).bind(standard_days).bind(actual_days).bind(calculated.basic_pay).bind(special_holiday_days).bind(special_multiplier).bind(calculated.special_holiday_pay).bind(regular_holiday_days).bind(regular_multiplier).bind(calculated.regular_holiday_pay)
            .bind(calculated.incentives_allowance).bind(calculated.special_allowance).bind(calculated.total_compensation).bind(calculated.total_allowance).bind(late_units).bind(calculated.late_deduction)
            .bind(half_day_count).bind(calculated.half_day_deduction).bind(absent_days).bind(calculated.absence_deduction).bind(overtime_hours).bind(overtime_rate_centavos).bind(calculated.overtime_pay)
            .bind(php_to_centavos(manual_adjustment)).bind(input.adjustment_reason.clone()).bind(gross_amount).bind(net_amount).bind("")
            .bind(serde_json::json!({"source":"attendance","actualWorkingDays":actual_days,"lateUnits":late_units}).to_string()).bind(1_i64).bind("DRAFT")
            .bind(calculated.hra).bind(calculated.sss_employee_share).bind(calculated.phic_employee_share).bind(calculated.hdmf_employee_share).bind(calculated.salary_advance)
            .bind(&now).bind(&now)
            .execute(&state.db).await.map_err(|e| e.to_string())?;
        enqueue_sync(&state, "PayrollCutoffs", &payroll_id, "UPSERT", &serde_json::json!({"payrollId":payroll_id,"employeeId":employee_id,"payrollCutoffLabel":payroll_cutoff_label,"cutoffStart":cutoff_start,"cutoffEnd":cutoff_end,"basicPay":calculated.basic_pay as f64 / 100.0,"lateDeduction":calculated.late_deduction as f64 / 100.0,"grossCompensation":gross_amount as f64 / 100.0,"netPay":net_amount as f64 / 100.0})).await;
        generated += 1;
    }
    Ok(serde_json::json!({"success":true,"generated":generated}))
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
    let is_intern =
        input.get("payrollProfileId").and_then(|v| v.as_str()) == Some(INTERN_PAYROLL_PROFILE_ID);
    // Intern payroll floors at zero for a cutoff (mirrors the daily rule).
    let gross = if is_intern {
        result.net_pay.max(0)
    } else {
        result.gross_compensation
    };
    let net = if is_intern {
        result.net_pay.max(0)
    } else {
        result.net_pay
    };
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
    let breakdown = serde_json::json!({"basicPayCentavos":result.basic_pay,"totalCompensationCentavos":result.total_compensation,"totalAllowanceCentavos":result.total_allowance,"lateDeductionCentavos":result.late_deduction,"halfDayDeductionCentavos":result.half_day_deduction,"absenceDeductionCentavos":result.absence_deduction,"overtimePayCentavos":result.overtime_pay,"grossCompensationCentavos":gross});
    let insert_query = format!("INSERT INTO payroll_cutoffs (payroll_id,employee_id,employee_name,payroll_profile_id,payroll_cutoff_label,cutoff_start,cutoff_end,payroll_frequency,daily_rate_centavos,standard_working_days,actual_working_days,basic_pay_centavos,special_holiday_days,special_holiday_multiplier,special_holiday_pay_centavos,regular_holiday_days,regular_holiday_multiplier,regular_holiday_pay_centavos,incentives_allowance_centavos,special_allowance_centavos,total_compensation_centavos,total_allowance_centavos,late_units,late_deduction_centavos,half_day_count,half_day_deduction_centavos,absent_days,absence_deduction_centavos,overtime_hours,overtime_rate_centavos,overtime_pay_centavos,manual_adjustment_centavos,adjustment_reason,gross_compensation_centavos,net_pay_centavos,signature_placeholder,calculation_breakdown,approved_working_day_overage,status,hra_centavos,sss_centavos,phic_centavos,hdmf_centavos,salary_advance_centavos,created_at,updated_at) VALUES ({})", std::iter::repeat("?").take(46).collect::<Vec<_>>().join(","));
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
        .bind(result.special_holiday_pay)
        .bind(parsed.regular_holiday_days)
        .bind(parsed.regular_holiday_multiplier)
        .bind(result.regular_holiday_pay)
        .bind(result.incentives_allowance)
        .bind(result.special_allowance)
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
        .bind(result.hra)
        .bind(result.sss_employee_share)
        .bind(result.phic_employee_share)
        .bind(result.hdmf_employee_share)
        .bind(result.salary_advance)
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
    let is_intern =
        input.get("payrollProfileId").and_then(|v| v.as_str()) == Some(INTERN_PAYROLL_PROFILE_ID);
    let gross = if is_intern {
        result.net_pay.max(0)
    } else {
        result.gross_compensation
    };
    let net = if is_intern {
        result.net_pay.max(0)
    } else {
        result.net_pay
    };
    let late_units = input
        .get("lateUnits")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0)
        .max(0.0);
    let updated = sqlx::query("UPDATE payroll_cutoffs SET employee_id=?,employee_name=?,payroll_profile_id=?,payroll_cutoff_label=?,cutoff_start=?,cutoff_end=?,daily_rate_centavos=?,standard_working_days=?,actual_working_days=?,basic_pay_centavos=?,special_holiday_days=?,special_holiday_multiplier=?,special_holiday_pay_centavos=?,regular_holiday_days=?,regular_holiday_multiplier=?,regular_holiday_pay_centavos=?,incentives_allowance_centavos=?,special_allowance_centavos=?,total_compensation_centavos=?,total_allowance_centavos=?,late_units=?,late_deduction_centavos=?,half_day_count=?,half_day_deduction_centavos=?,absent_days=?,absence_deduction_centavos=?,overtime_hours=?,overtime_rate_centavos=?,overtime_pay_centavos=?,manual_adjustment_centavos=?,adjustment_reason=?,gross_compensation_centavos=?,net_pay_centavos=?,hra_centavos=?,sss_centavos=?,phic_centavos=?,hdmf_centavos=?,salary_advance_centavos=?,calculation_breakdown=?,revision=revision+1,updated_at=? WHERE payroll_id=? AND status != 'FINALIZED'")
        .bind(&parsed.employee_id).bind(&parsed.employee_name).bind(input.get("payrollProfileId").and_then(|v| v.as_str()).unwrap_or("BEA_STANDARD")).bind(input.get("payrollCutoffLabel").and_then(|v| v.as_str()).unwrap_or(""))
        .bind(&parsed.cutoff_start).bind(&parsed.cutoff_end).bind((parsed.daily_rate * 100.0).round() as i64).bind(parsed.standard_working_days).bind(parsed.actual_working_days).bind(result.basic_pay)
        .bind(parsed.special_holiday_days).bind(parsed.special_holiday_multiplier).bind(result.special_holiday_pay)
        .bind(parsed.regular_holiday_days).bind(parsed.regular_holiday_multiplier).bind(result.regular_holiday_pay)
        .bind(result.incentives_allowance).bind(result.special_allowance).bind(result.total_compensation).bind(result.total_allowance).bind(late_units).bind(result.late_deduction)
        .bind(parsed.half_day_count).bind(result.half_day_deduction).bind(parsed.absent_days).bind(result.absence_deduction).bind(parsed.overtime_hours).bind(php_to_centavos(parsed.overtime_rate)).bind(result.overtime_pay)
        .bind((parsed.manual_adjustment * 100.0).round() as i64).bind(parsed.adjustment_reason).bind(gross).bind(net)
        .bind(result.hra).bind(result.sss_employee_share).bind(result.phic_employee_share).bind(result.hdmf_employee_share).bind(result.salary_advance)
        .bind(serde_json::to_string(&serde_json::json!({
            "basicPayCentavos": result.basic_pay,
            "hraCentavos": result.hra,
            "incentivesCentavos": result.incentives_allowance,
            "specialAllowanceCentavos": result.special_allowance,
            "specialHolidayCentavos": result.special_holiday_pay,
            "regularHolidayCentavos": result.regular_holiday_pay,
            "overtimeCentavos": result.overtime_pay,
            "grossCentavos": gross,
            "sssCentavos": result.sss_employee_share,
            "phicCentavos": result.phic_employee_share,
            "hdmfCentavos": result.hdmf_employee_share,
            "salaryAdvanceCentavos": result.salary_advance,
            "lateCentavos": result.late_deduction,
            "absenceCentavos": result.absence_deduction,
            "totalDeductionsCentavos": result.total_deductions,
            "netPayCentavos": net
        })).unwrap_or_default()).bind(&now).bind(id).execute(&state.db).await.map_err(|e| e.to_string())?;
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
async fn payroll_delete_cutoff(
    state: State<'_, AppState>,
    token: String,
    payroll_id: String,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let row = sqlx::query("SELECT status,employee_id,employee_name,payroll_cutoff_label,cutoff_start,cutoff_end FROM payroll_cutoffs WHERE payroll_id=?")
        .bind(&payroll_id).fetch_optional(&state.db).await.map_err(|e| e.to_string())?
        .ok_or_else(|| "PAYROLL_NOT_FOUND".to_string())?;
    sqlx::query("DELETE FROM payroll_cutoffs WHERE payroll_id=?")
        .bind(&payroll_id)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    let _ = sqlx::query("DELETE FROM payroll_snapshots WHERE payroll_id=?")
        .bind(&payroll_id)
        .execute(&state.db)
        .await;
    enqueue_sync(
        &state,
        "PayrollCutoffs",
        &payroll_id,
        "DELETE",
        &serde_json::json!({
            "payrollId": payroll_id,
            "employeeId": row.get::<String, _>("employee_id"),
            "employeeName": row.get::<String, _>("employee_name"),
            "payrollCutoffLabel": row.get::<String, _>("payroll_cutoff_label"),
            "cutoffStart": row.get::<String, _>("cutoff_start"),
            "cutoffEnd": row.get::<String, _>("cutoff_end")
        }),
    )
    .await;
    Ok(serde_json::json!({"success":true,"payrollId":payroll_id}))
}

#[tauri::command]
async fn payroll_export_csv(
    state: State<'_, AppState>,
    token: String,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let rows = sqlx::query("SELECT payroll_id,employee_id,employee_name,payroll_cutoff_label,cutoff_start,cutoff_end,basic_pay_centavos,hra_centavos,incentives_allowance_centavos,special_allowance_centavos,regular_holiday_pay_centavos,special_holiday_pay_centavos,overtime_pay_centavos,gross_compensation_centavos,sss_centavos,phic_centavos,hdmf_centavos,salary_advance_centavos,absence_deduction_centavos,late_deduction_centavos,half_day_deduction_centavos,net_pay_centavos,status FROM payroll_cutoffs ORDER BY cutoff_start,employee_name").fetch_all(&state.db).await.map_err(|e| e.to_string())?;
    let mut output = String::new();
    output.push_str(&format!(
        "\"Company\",\"{}\"\n",
        state.office.company_name.replace('"', "\"\"")
    ));
    output.push_str(&format!(
        "\"Office\",\"{}\"\n",
        state.office.display_full().replace('"', "\"\"")
    ));
    output.push_str("PAYROLL_ID,EMPLOYEE_ID,EMPLOYEE_NAME,CUTOFF_LABEL,CUTOFF_START,CUTOFF_END,BASIC_PAY_PHP,HRA_PHP,INCENTIVES_PHP,SPECIAL_ALLOWANCE_PHP,REGULAR_HOLIDAY_PHP,SPECIAL_HOLIDAY_PHP,OVERTIME_PHP,GROSS_PAY_PHP,SSS_PHP,PHIC_PHP,HDMF_PHP,SALARY_ADVANCE_PHP,ABSENT_DEDUCTION_PHP,LATE_DEDUCTION_PHP,TOTAL_DEDUCTIONS_PHP,NET_PAY_PHP,STATUS\n");
    for row in rows {
        let name = row.get::<String, _>("employee_name").replace('"', "\"\"");
        let label = row
            .get::<String, _>("payroll_cutoff_label")
            .replace('"', "\"\"");
        let sss = row.get::<i64, _>("sss_centavos") as f64 / 100.0;
        let phic = row.get::<i64, _>("phic_centavos") as f64 / 100.0;
        let hdmf = row.get::<i64, _>("hdmf_centavos") as f64 / 100.0;
        let adv = row.get::<i64, _>("salary_advance_centavos") as f64 / 100.0;
        let abs = row.get::<i64, _>("absence_deduction_centavos") as f64 / 100.0;
        let late = (row.get::<i64, _>("late_deduction_centavos") + row.get::<i64, _>("half_day_deduction_centavos")) as f64 / 100.0;
        let total_ded = sss + phic + hdmf + adv + abs + late;
        output.push_str(&format!(
            "{},{},\"{}\",\"{}\",{},{},{:.2},{:.2},{:.2},{:.2},{:.2},{:.2},{:.2},{:.2},{:.2},{:.2},{:.2},{:.2},{:.2},{:.2},{:.2},{:.2},{}\n",
            row.get::<String, _>("payroll_id"),
            row.get::<String, _>("employee_id"),
            name,
            label,
            row.get::<String, _>("cutoff_start"),
            row.get::<String, _>("cutoff_end"),
            row.get::<i64, _>("basic_pay_centavos") as f64 / 100.0,
            row.get::<i64, _>("hra_centavos") as f64 / 100.0,
            row.get::<i64, _>("incentives_allowance_centavos") as f64 / 100.0,
            row.get::<i64, _>("special_allowance_centavos") as f64 / 100.0,
            row.get::<i64, _>("regular_holiday_pay_centavos") as f64 / 100.0,
            row.get::<i64, _>("special_holiday_pay_centavos") as f64 / 100.0,
            row.get::<i64, _>("overtime_pay_centavos") as f64 / 100.0,
            row.get::<i64, _>("gross_compensation_centavos") as f64 / 100.0,
            sss,
            phic,
            hdmf,
            adv,
            abs,
            late,
            total_ded,
            row.get::<i64, _>("net_pay_centavos") as f64 / 100.0,
            row.get::<String, _>("status")
        ));
    }
    let date = chrono::Utc::now()
        .with_timezone(&Manila)
        .format("%Y-%m-%d")
        .to_string();
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
    let employee =
        sqlx::query("SELECT full_name, daily_rate_centavos FROM users WHERE user_id = ?")
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
/// deduction, and no holiday premium, allowances, or overtime. Absences are
/// derived from standard less actual working days; half-days remain inputtable.
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
    let employee_type: Option<String> =
        sqlx::query("SELECT employee_type FROM users WHERE user_id = ?")
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
    object.insert(
        "dailyRate".into(),
        serde_json::json!(INTERN_DAILY_RATE_PHP as f64),
    );
    object.insert(
        "payrollProfileId".into(),
        serde_json::json!(INTERN_PAYROLL_PROFILE_ID),
    );
    object.insert("lateUnits".into(), serde_json::json!(late_units));
    // Late deduction is PHP 10.00 per hour, computed from total late hours.
    object.insert(
        "lateDeduction".into(),
        serde_json::json!(late_units * INTERN_LATE_DEDUCTION_PER_HOUR_PHP as f64),
    );
    for field in [
        "hra",
        "incentivesAllowance",
        "specialAllowance",
        "specialHolidayDays",
        "specialHolidayPay",
        "regularHolidayDays",
        "regularHolidayPay",
        "overtimeHours",
        "overtimeRate",
        "overtimePay",
        "sss",
        "sssEmployeeShare",
        "phic",
        "phicEmployeeShare",
        "hdmf",
        "hdmfEmployeeShare",
        "salaryAdvance",
    ] {
        object.insert(field.into(), serde_json::json!(0.0));
    }
    object.remove("basicPay");
    object.remove("specialHolidayPay");
    object.remove("regularHolidayPay");
    object.remove("overtimePay");
    object.remove("absenceDeduction");
    let standard_working_days = object
        .get("standardWorkingDays")
        .and_then(|v| v.as_f64())
        .unwrap_or(11.0);
    let actual_working_days = object
        .get("actualWorkingDays")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let absent_days = (standard_working_days - actual_working_days).max(0.0);
    let half_day_count = object
        .get("halfDayCount")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    object.insert("standardWorkingDays".into(), serde_json::json!(standard_working_days));
    object.insert("absentDays".into(), serde_json::json!(absent_days));
    object.insert("halfDayCount".into(), serde_json::json!(half_day_count));
    object.insert("halfDayFraction".into(), serde_json::json!(0.5));
    Ok(())
}

fn cutoff_input(value: &serde_json::Value) -> crate::services::cutoff_payroll::CutoffInput {
    let n = |name: &str| value.get(name).and_then(|v| v.as_f64()).unwrap_or(0.0);
    let opt_n = |name: &str| value.get(name).and_then(|v| v.as_f64());
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
        basic_pay: opt_n("basicPay"),
        special_holiday_days: n("specialHolidayDays"),
        special_holiday_multiplier: n("specialHolidayMultiplier"),
        special_holiday_pay: opt_n("specialHolidayPay"),
        regular_holiday_days: n("regularHolidayDays"),
        regular_holiday_multiplier: n("regularHolidayMultiplier"),
        regular_holiday_pay: opt_n("regularHolidayPay"),
        hra: opt_n("hra").unwrap_or(0.0),
        incentives_allowance: n("incentivesAllowance"),
        special_allowance: n("specialAllowance"),
        late_deduction: n("lateDeduction"),
        half_day_count: n("halfDayCount"),
        half_day_fraction: n("halfDayFraction"),
        absent_days: n("absentDays"),
        absence_deduction: opt_n("absenceDeduction"),
        overtime_hours: n("overtimeHours"),
        overtime_rate: n("overtimeRate"),
        overtime_pay: opt_n("overtimePay"),
        sss_employee_share: opt_n("sss").or_else(|| opt_n("sssEmployeeShare")).unwrap_or(0.0),
        phic_employee_share: opt_n("phic").or_else(|| opt_n("phicEmployeeShare")).unwrap_or(0.0),
        hdmf_employee_share: opt_n("hdmf").or_else(|| opt_n("hdmfEmployeeShare")).unwrap_or(0.0),
        salary_advance: opt_n("salaryAdvance").unwrap_or(0.0),
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
    let canonical = std::fs::canonicalize(candidate).map_err(|_| "FILE_NOT_FOUND".to_string())?;
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
        std::fs::read_to_string(&marker)
            .ok()
            .map(|text| text.trim().to_string())
    } else {
        None
    };
    // BUG-DB-01: surface a failed scheduled restore (restore.failed marker)
    // so the admin panel can warn the operator instead of staying silent.
    let restore_failed_marker = crate::database::restore_failed_path(&state.data_dir);
    let restore_failed = if restore_failed_marker.is_file() {
        std::fs::read_to_string(&restore_failed_marker)
            .ok()
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty())
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
        "restoreFailed": restore_failed,
        "backups": backup_items,
        "lastBackupAt": last_backup_at,
    }))
}

#[tauri::command]
/// Create a consistent timestamped backup of the SQLite database into
/// `data_dir/backups` (keeps the newest 10). Safe while the app is running.
async fn db_backup(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    token: String,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let config_dir = crate::paths::resolve(&app)?.config_dir;
    let file_path = crate::database::create_portable_backup(
        &state.db,
        &state.data_dir,
        &config_dir,
        &state.db_path,
    )
    .await?;
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
    let format = crate::database::detect_backup_format(&source)
        .map_err(|error| format!("RESTORE_SOURCE_INVALID: {error}"))?;
    let validation = match format {
        crate::database::BackupFormat::PortableArchive => {
            crate::database::validate_portable_backup(&source)
        }
        crate::database::BackupFormat::SqliteDatabase => {
            crate::database::validate_database_file(&source).await
        }
    };
    validation.map_err(|error| format!("RESTORE_SOURCE_INVALID: {error}"))?;
    let marker = crate::database::restore_request_path(&state.data_dir);
    std::fs::write(&marker, source.to_string_lossy().into_owned())
        .map_err(|error| format!("cannot write restore request: {error}"))?;
    // Drop any stale failure marker from a previous attempt.
    let _ = std::fs::remove_file(crate::database::restore_failed_path(&state.data_dir));
    // Restart cleanly so the next launch restores before opening the database.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        app.restart();
    });
    Ok(serde_json::json!({
        "success": true,
        "message": "Restore scheduled. The application is restarting to apply the backup."
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
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("cannot create backup folder: {error}"))?;
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
async fn lan_status(
    state: State<'_, AppState>,
) -> Result<crate::lan_server::LanStatusResponse, String> {
    Ok(crate::lan_server::build_lan_status(state.inner()).await)
}

#[tauri::command]
/// Start (or verify) the LAN attendance viewer from the Live Attendance panel.
/// The viewer binds to the office LAN IP so devices on the same Wi-Fi/LAN can
/// open it; it stays strictly read-only and never exposes admin or payroll.
async fn lan_start(
    state: State<'_, AppState>,
) -> Result<crate::lan_server::LanStatusResponse, String> {
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
async fn lan_stop(
    state: State<'_, AppState>,
) -> Result<crate::lan_server::LanStatusResponse, String> {
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

async fn setup_unlock_impl(
    state: &AppState,
    pin: String,
) -> Result<serde_json::Value, String> {
    let configured = state
        .lan
        .admin_pin
        .as_deref()
        .ok_or_else(|| "ADMIN_DISABLED".to_string())?;
    let pin_trimmed = pin.trim();
    let is_pin_match = configured == pin_trimmed;
    let mut is_admin_card_match = false;
    if !is_pin_match {
        let uid = pin_trimmed.to_ascii_uppercase();
        let row = sqlx::query(
            "SELECT user_id FROM users WHERE (rfid_uid = ? OR user_id = ?) AND status = 'ACTIVE' AND card_type = 'ADMIN_ASSIST'",
        )
        .bind(&uid)
        .bind(pin_trimmed)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| e.to_string())?;
        is_admin_card_match = row.is_some();
    }
    if !is_pin_match && !is_admin_card_match {
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
async fn setup_unlock(
    state: State<'_, AppState>,
    pin: String,
) -> Result<serde_json::Value, String> {
    setup_unlock_impl(&state, pin).await
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
    let user_val = row.map(|r| {
        let user_id = r.get::<String,_>("user_id");
        let photo_url = resolve_user_photo_url(&state.data_dir, &user_id, r.get::<Option<String>,_>("photo_url"));
        serde_json::json!({
            "userId": user_id,
            "rfidUid": r.get::<String,_>("rfid_uid"),
            "fullName": r.get::<String,_>("full_name"),
            "department": r.get::<Option<String>,_>("department"),
            "status": r.get::<String,_>("status"),
            "employeeType": r.get::<String,_>("employee_type"),
            "gender": r.get::<Option<String>,_>("gender"),
            "dailyRate": r.get::<Option<i64>,_>("daily_rate_centavos").map(|v| v as f64 / 100.0),
            "payrollProfileId": r.get::<Option<String>,_>("payroll_profile_id"),
            "photoUrl": photo_url
        })
    });
    Ok(serde_json::json!({"success":true,"rfidUid":uid,"user":user_val}))
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

/// A payroll sheet PDF is self-registered in the `payroll_pdfs` table (the
/// Payroll tab history source) rather than `export_jobs`/`generated_artifacts`
/// because `export_jobs.kind` is CHECK-constrained to the workbook/payslip
/// kinds and has no sheet-PDF kind; rebuilding that table for one new kind is
/// not worth the migration risk. The file still lands in `exports_dir` so the
/// existing Open PDF / Show in folder commands work unchanged.
#[tauri::command]
async fn generate_payroll_pdf(
    state: State<'_, AppState>,
    token: String,
    cutoff_start: String,
    cutoff_end: String,
    payroll_cutoff_label: String,
    worker_type: String,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    if !valid_cutoff_date(&cutoff_start) || !valid_cutoff_date(&cutoff_end) {
        return Err("INVALID_CUTOFF_PERIOD".into());
    }
    if cutoff_end < cutoff_start {
        return Err("INVALID_CUTOFF_PERIOD".into());
    }
    let worker_upper = match worker_type.as_str() {
        "EMPLOYEE" => "EMPLOYEE",
        "INTERN" => "INTERN",
        _ => return Err("INVALID_WORKER_TYPE".into()),
    };
    let worker_lower = if worker_upper == "EMPLOYEE" {
        "employee"
    } else {
        "intern"
    };
    let label = if payroll_cutoff_label.trim().is_empty() {
        format!("{cutoff_start} to {cutoff_end}")
    } else {
        payroll_cutoff_label.trim().to_string()
    };
    let manila_now = chrono::Utc::now().with_timezone(&Manila);
    let file_name = format!(
        "payroll_{}_{}.pdf",
        manila_now.format("%Y-%m-%d_%H-%M-%S"),
        worker_lower
    );
    let relative_path = std::path::PathBuf::from("exports").join(&file_name);
    let output_path = state.exports_dir.join(&file_name);
    let generated_at = manila_now.to_rfc3339();

    let (employee_count, total_amount_centavos) = if worker_upper == "EMPLOYEE" {
        let emp_rows =
            crate::reporting::load_employee_payslip_rows(&state.db, &cutoff_start, &cutoff_end)
                .await
                .map_err(|e| e.to_string())?;
        if emp_rows.is_empty() {
            return Err(format!(
                "NO_PAYROLL_RECORDS: No employee payroll records for {label}. Create and save an employee payroll for this cutoff first."
            ));
        }
        if let Err(error) = (|| {
            std::fs::create_dir_all(output_path.parent().ok_or("EXPORT_PATH_ERROR")?)
                .map_err(|e| e.to_string())?;
            crate::reporting::generate_employee_payslip_document(
                &emp_rows,
                &label,
                &state.office,
                &output_path,
            )
        })() {
            log::error!("employee payroll payslip PDF generation failed: {error}");
            return Err(error);
        }
        let total: i64 = emp_rows.iter().map(|r| r.gross_compensation_centavos).sum();
        (emp_rows.len() as i64, total)
    } else {
        let rows = crate::reporting::load_payroll_sheet_rows(
            &state.db,
            &cutoff_start,
            &cutoff_end,
            worker_upper,
        )
        .await
        .map_err(|e| e.to_string())?;
        if rows.is_empty() {
            return Err(format!(
                "NO_PAYROLL_RECORDS: No intern payroll records for {label}. Create and save an intern payroll for this cutoff first."
            ));
        }
        if let Err(error) = (|| {
            std::fs::create_dir_all(output_path.parent().ok_or("EXPORT_PATH_ERROR")?)
                .map_err(|e| e.to_string())?;
            crate::reporting::generate_payroll_sheet_pdf(
                &rows,
                &label,
                worker_upper,
                &state.office,
                &output_path,
            )
        })() {
            log::error!("payroll sheet PDF generation failed: {error}");
            return Err(error);
        }
        let total: i64 = rows.iter().map(|r| r.gross_compensation_centavos).sum();
        (rows.len() as i64, total)
    };

    let bytes = std::fs::read(&output_path).map_err(|e| e.to_string())?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let payroll_pdf_id = file_name.trim_end_matches(".pdf").to_string();
    sqlx::query(
        "INSERT INTO payroll_pdfs (payroll_pdf_id,file_name,managed_relative_path,cutoff_start,cutoff_end,payroll_cutoff_label,worker_type,employee_count,total_amount_centavos,sha256,size_bytes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(&payroll_pdf_id)
    .bind(&file_name)
    .bind(relative_path.to_string_lossy().replace('\\', "/"))
    .bind(&cutoff_start)
    .bind(&cutoff_end)
    .bind(&label)
    .bind(worker_upper)
    .bind(employee_count)
    .bind(total_amount_centavos)
    .bind(&hash)
    .bind(bytes.len() as i64)
    .bind(&generated_at)
    .execute(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    let message = format!("Payroll PDF generated for {label} ({worker_lower}).");
    let metadata = generated_file_metadata(&state, &file_name, &output_path, "pdf", message);
    let mut response = metadata.as_object().cloned().unwrap_or_default();
    response.insert(
        "pdf".into(),
        serde_json::json!({
            "payrollPdfId": payroll_pdf_id,
            "fileName": file_name,
            "filePath": output_path.to_string_lossy(),
            "directoryPath": state.exports_dir.to_string_lossy(),
            "cutoffStart": cutoff_start,
            "cutoffEnd": cutoff_end,
            "payrollCutoffLabel": label,
            "workerType": worker_lower,
            "generatedAt": generated_at,
            "employeeCount": employee_count,
            "totalAmount": total_amount_centavos as f64 / 100.0,
            "sizeBytes": bytes.len(),
        }),
    );
    response.insert("sizeBytes".into(), serde_json::json!(bytes.len()));
    response.insert("sha256".into(), serde_json::json!(hash));
    Ok(serde_json::Value::Object(response))
}

#[tauri::command]
async fn list_payroll_pdfs(
    state: State<'_, AppState>,
    token: String,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let rows = sqlx::query(
        "SELECT payroll_pdf_id,file_name,managed_relative_path,cutoff_start,cutoff_end,payroll_cutoff_label,worker_type,employee_count,total_amount_centavos,sha256,size_bytes,created_at FROM payroll_pdfs ORDER BY created_at DESC",
    )
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    let payroll_pdfs = rows
        .into_iter()
        .map(|row| {
            let relative: String = row.get("managed_relative_path");
            let file_name: String = row.get("file_name");
            serde_json::json!({
                "payrollPdfId": row.get::<String, _>("payroll_pdf_id"),
                "fileName": file_name,
                "filePath": state.data_dir.join(relative).to_string_lossy(),
                "directoryPath": state.exports_dir.to_string_lossy(),
                "cutoffStart": row.get::<String, _>("cutoff_start"),
                "cutoffEnd": row.get::<String, _>("cutoff_end"),
                "payrollCutoffLabel": row.get::<String, _>("payroll_cutoff_label"),
                "workerType": if row.get::<String, _>("worker_type") == "EMPLOYEE" { "employee" } else { "intern" },
                "generatedAt": row.get::<String, _>("created_at"),
                "employeeCount": row.get::<i64, _>("employee_count"),
                "totalAmount": row.get::<i64, _>("total_amount_centavos") as f64 / 100.0,
                "sizeBytes": row.get::<i64, _>("size_bytes"),
            })
        })
        .collect::<Vec<_>>();
    Ok(serde_json::json!({"success": true, "payrollPdfs": payroll_pdfs}))
}

fn valid_cutoff_date(value: &str) -> bool {
    value.len() == 10
        && value.as_bytes().iter().enumerate().all(|(index, byte)| {
            if index == 4 || index == 7 {
                *byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        })
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
    let target_user_id = request
        .get("targetUserId")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let assist_reason = request
        .get("reason")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Forgot RFID card".to_string());
    let received_at = chrono::Utc::now().to_rfc3339();
    let _ = sqlx::query("INSERT INTO audit_logs (log_id,timestamp,event_type,rfid_uid,message,request_id) VALUES (?,?, 'SCAN_RECEIVED', ?, ?, ?)").bind(uuid::Uuid::new_v4().to_string()).bind(&received_at).bind(if uid.is_empty() { None } else { Some(uid.as_str()) }).bind(format!("Scan request received from {source}")).bind(&request_id).execute(&state.db).await;
    let valid_uid = source == "MANUAL_TEST"
        || (uid.len() >= 4 && uid.len() <= 64 && uid.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let valid_source = matches!(source, "RFID" | "MANUAL_TEST" | "ADMIN_ASSISTED_SCAN");
    if uid.is_empty() || !valid_uid || !valid_source {
        return Ok(
            serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"INVALID_SCAN_INPUT","message":"rfidUid and source are required."}}),
        );
    }
    let now = chrono::Utc::now();
    let user = match sqlx::query("SELECT user_id, full_name, department, employee_type, daily_rate_centavos, photo_url, status, gender, card_type, rfid_uid FROM users WHERE rfid_uid = ?")
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
    let card_type: String = user.try_get("card_type").unwrap_or_else(|_| "EMPLOYEE".to_string());
    let is_admin_card = card_type == "ADMIN_ASSIST";

    if is_admin_card && target_user_id.is_none() {
        let employees = sqlx::query("SELECT user_id, full_name, department, photo_url FROM users WHERE status = 'ACTIVE' AND card_type != 'ADMIN_ASSIST' ORDER BY full_name ASC")
            .fetch_all(&state.db).await.unwrap_or_default();
        let active_employees: Vec<serde_json::Value> = employees.into_iter().map(|e| {
            let uid_val: String = e.get("user_id");
            let photo_url = resolve_user_photo_url(&state.data_dir, &uid_val, e.get::<Option<String>,_>("photo_url"));
            serde_json::json!({
                "userId": uid_val,
                "fullName": e.get::<String, _>("full_name"),
                "department": e.get::<Option<String>, _>("department"),
                "photoUrl": photo_url,
            })
        }).collect();
        let _ = sqlx::query("INSERT INTO audit_logs (log_id, timestamp, event_type, rfid_uid, user_id, message, request_id) VALUES (?, ?, 'SCAN_SUCCESS', ?, ?, 'ADMIN_ASSIST card presented', ?)")
            .bind(uuid::Uuid::new_v4().to_string()).bind(&received_at).bind(&uid).bind(user.get::<String,_>("user_id")).bind(&request_id).execute(&state.db).await;
        return Ok(serde_json::json!({
            "success": true,
            "requestId": request_id,
            "action": "ADMIN_ASSIST",
            "message": "Admin assist card accepted. Select an employee to record attendance.",
            "adminCard": {
                "rfidUid": uid,
                "label": user.get::<String, _>("full_name"),
            },
            "activeEmployees": active_employees,
        }));
    }

    let (effective_user, effective_source, recorded_by, recorded_reason, recorded_at) = if is_admin_card {
        let target_id = target_user_id.as_ref().unwrap();
        if target_id == &user.get::<String, _>("user_id") {
            return Ok(serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"ADMIN_CARD_REQUIRES_SELECTION","message":"Admin RFID cards cannot record attendance for themselves."}}));
        }
        let target = match sqlx::query("SELECT user_id, full_name, department, employee_type, daily_rate_centavos, photo_url, status, gender, card_type, rfid_uid FROM users WHERE user_id = ?")
            .bind(target_id).fetch_optional(&state.db).await {
            Ok(Some(row)) => row,
            Ok(None) => return Ok(serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"UNKNOWN_RFID_CARD","message":"Selected employee not found."}})),
            Err(_) => return Ok(serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"INTERNAL_SERVER_ERROR","message":"Attendance data is unavailable."}})),
        };
        if target.try_get::<String, _>("card_type").unwrap_or_default() == "ADMIN_ASSIST" {
            return Ok(serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"ADMIN_CARD_REQUIRES_SELECTION","message":"Cannot record attendance for another admin card."}}));
        }
        if target.get::<String, _>("status") != "ACTIVE" {
            return Ok(serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"INACTIVE_USER","message":"This employee is inactive."}}));
        }
        let rec_by = user.get::<String, _>("full_name");
        let rec_reason = assist_reason.clone();
        let now_ts = now.with_timezone(&Manila).to_rfc3339();
        (target, "ADMIN_ASSISTED_SCAN", Some(rec_by), Some(rec_reason), Some(now_ts))
    } else {
        if target_user_id.is_some() && target_user_id.as_deref() != Some(user.get::<&str, _>("user_id")) {
            return Ok(serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"INVALID_SCAN_INPUT","message":"Only Admin RFID cards can record attendance for other employees."}}));
        }
        (user, source, None, None, None)
    };

    let cooldown_key = if is_admin_card {
        effective_user.get::<String, _>("rfid_uid")
    } else {
        uid.clone()
    };
    {
        let mut guard = state.scan_guard.lock().await;
        if guard
            .get(&cooldown_key)
            .is_some_and(|last| last.elapsed().as_millis() < 500)
        {
            return Ok(
                serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"DUPLICATE_SCAN","message":"This card was scanned too recently."}}),
            );
        }
        guard.insert(cooldown_key.clone(), Instant::now());
    }
    {
        let cooldown = state.physical_cooldown.lock().await;
        if cooldown
            .get(&cooldown_key)
            .is_some_and(|last| last.elapsed().as_secs() < 10)
        {
            return Ok(
                serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"DUPLICATE_SCAN","message":"This card was scanned too recently.","retryAfterSeconds":10}}),
            );
        }
    }

    let user_id: String = effective_user.get("user_id");
    let effective_uid: String = effective_user.get("rfid_uid");
    let date = now.with_timezone(&Manila).date_naive().to_string();
    let timestamp = now.with_timezone(&Manila).to_rfc3339();
    let existing = sqlx::query("SELECT attendance_id, time_in, time_out, status, revision FROM attendance WHERE user_id = ? AND attendance_date = ?")
        .bind(&user_id).bind(&date).fetch_optional(&state.db).await.ok().flatten();
    let is_first_arrival_today = if existing.is_none() {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM attendance WHERE attendance_date = ? AND time_in IS NOT NULL")
            .bind(&date).fetch_one(&state.db).await.unwrap_or(1) == 0
    } else {
        false
    };
    let (attendance_id, action, time_in, time_out, attendance_status) = match existing {
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            let result = sqlx::query("INSERT INTO attendance (attendance_id, attendance_date, user_id, rfid_uid, full_name, department, time_in, time_out, status, source, notes, recorded_by, recorded_reason, recorded_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'WORKING', ?, '', ?, ?, ?, ?, ?)")
                .bind(&id).bind(&date).bind(&user_id).bind(&effective_uid).bind(effective_user.get::<String,_>("full_name")).bind(effective_user.get::<Option<String>,_>("department")).bind(&timestamp).bind(effective_source).bind(&recorded_by).bind(&recorded_reason).bind(&recorded_at).bind(&timestamp).bind(&timestamp).execute(&state.db).await;
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
            let result = sqlx::query("UPDATE attendance SET time_out = ?, status = ?, source = ?, recorded_by = COALESCE(?, recorded_by), recorded_reason = COALESCE(?, recorded_reason), recorded_at = COALESCE(?, recorded_at), revision = revision + 1, updated_at = ? WHERE attendance_id = ? AND revision = ? AND time_out IS NULL")
                .bind(&timestamp).bind(new_status).bind(effective_source).bind(&recorded_by).bind(&recorded_reason).bind(&recorded_at).bind(&timestamp).bind(&id).bind(row.get::<i64,_>("revision")).execute(&state.db).await;
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
        .insert(cooldown_key, Instant::now());
    if action == "TIME_OUT" && attendance_status == "COMPLETED" {
        if let (Some(actual_in), Some(actual_out)) = (time_in.as_deref(), time_out.as_deref()) {
            let employee_type: String = effective_user.get("employee_type");
            let daily_rate: Option<i64> = effective_user.get("daily_rate_centavos");
            if let Err(error) = ensure_payroll(
                &state,
                &attendance_id,
                &user_id,
                effective_user.get::<String, _>("full_name"),
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
                full_name: effective_user.get::<String, _>("full_name"),
                department: effective_user.get::<Option<String>, _>("department"),
                time_in: time_in.clone(),
                time_out: time_out.clone(),
                status: attendance_status.to_string(),
            }),
        });
    let event_payload = serde_json::json!({
        "attendanceId": attendance_id.clone(),
        "attendanceDate": date.clone(),
        "userId": user_id.clone(),
        "action": action,
        "timeIn": time_in,
        "timeOut": time_out,
        "status": attendance_status,
        "sequence": seq
    });
    let _ = app.emit("attendance-updated", &event_payload);
    let _ = app.emit("attendance-changed", &event_payload);
    let audit_msg = if is_admin_card {
        format!("{} recorded (Assisted by {})", action, recorded_by.as_deref().unwrap_or("Admin"))
    } else {
        format!("{} recorded", action)
    };
    let _ = sqlx::query("INSERT INTO audit_logs (log_id, timestamp, event_type, rfid_uid, user_id, message, request_id) VALUES (?, ?, 'SCAN_SUCCESS', ?, ?, ?, ?)").bind(uuid::Uuid::new_v4().to_string()).bind(&timestamp).bind(&uid).bind(&user_id).bind(audit_msg).bind(&request_id).execute(&state.db).await;
    let payload = serde_json::json!({
        "attendanceId": attendance_id,
        "attendanceDate": date,
        "userId": user_id,
        "action": action,
        "timeIn": time_in,
        "timeOut": time_out,
        "source": effective_source,
        "recordedBy": recorded_by,
        "recordedReason": recorded_reason,
        "recordedAt": recorded_at,
    });
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
    let photo_url = resolve_user_photo_url(&state.data_dir, &user_id, effective_user.get::<Option<String>,_>("photo_url"));
    Ok(
        serde_json::json!({
            "success": true,
            "requestId": request_id,
            "action": action,
            "message": if action == "TIME_IN" { "Time In recorded successfully." } else { "Time Out recorded successfully." },
            "attendance": {
                "attendanceId": attendance_id,
                "attendanceDate": date,
                "timeIn": time_in,
                "timeOut": time_out,
                "status": attendance_status,
                "isFirstArrivalToday": if action == "TIME_IN" { Some(is_first_arrival_today) } else { None },
                "source": effective_source,
                "recordedBy": recorded_by,
                "recordedReason": recorded_reason,
                "recordedAt": recorded_at,
            },
            "user": {
                "userId": user_id,
                "fullName": effective_user.get::<String,_>("full_name"),
                "department": effective_user.get::<Option<String>,_>("department"),
                "employeeType": effective_user.get::<String,_>("employee_type"),
                "gender": effective_user.get::<Option<String>,_>("gender"),
                "photoUrl": photo_url
            }
        }),
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
    let (computed_in, computed_out, grace_used, late_hours, deduction, is_half_day, half_day_deduction, base_pay, daily_pay) =
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
                result.is_half_day,
                result.half_day_deduction_centavos,
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
                result.is_half_day,
                result.half_day_deduction_centavos,
                result.base_pay_centavos,
                result.daily_pay_centavos,
            )
        };
    let now = chrono::Utc::now().to_rfc3339();
    let payroll_id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT OR IGNORE INTO payroll (payroll_id,attendance_id,user_id,full_name,employee_type,attendance_date,actual_time_in,actual_time_out,computed_time_in,computed_time_out,grace_used,late_hours,late_deduction_centavos,base_pay_centavos,daily_pay_centavos,is_half_day,half_day_deduction_centavos,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(&payroll_id).bind(attendance_id).bind(user_id).bind(&full_name).bind(employee_type).bind(date).bind(actual_in).bind(actual_out).bind(&computed_in).bind(&computed_out).bind(grace_used.map(|v| if v {1} else {0})).bind(late_hours).bind(deduction).bind(base_pay).bind(daily_pay).bind(if is_half_day { 1 } else { 0 }).bind(half_day_deduction).bind(&now).bind(&now).execute(&state.db).await.map_err(|e| e.to_string())?;
    enqueue_sync(state, "Payroll", &payroll_id, "UPSERT", &serde_json::json!({"payrollId":payroll_id,"attendanceId":attendance_id,"userId":user_id,"employeeType":employee_type,"attendanceDate":date,"actualTimeIn":actual_in,"actualTimeOut":actual_out,"computedTimeIn":computed_in,"computedTimeOut":computed_out,"lateHours":late_hours,"lateDeductionCentavos":deduction,"isHalfDay":is_half_day,"halfDayDeductionCentavos":half_day_deduction,"dailyPayCentavos":daily_pay})).await;
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

#[tauri::command]
fn autostart_status(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn autostart_set(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    let autolaunch = app.autolaunch();
    if enabled {
        autolaunch.enable().map_err(|e| e.to_string())?;
        log::info!("Enabled autostart via in-app settings");
    } else {
        autolaunch.disable().map_err(|e| e.to_string())?;
        log::info!("Disabled autostart via in-app settings");
    }
    autolaunch.is_enabled().map_err(|e| e.to_string())
}

pub fn run() {
    std::panic::set_hook(Box::new(|info| {
        log::error!("CRITICAL PANIC: {:?}", info);
        eprintln!("CRITICAL PANIC: {:?}", info);
    }));

    log::info!("Starting Alpha Premier Attendance application...");

    let single_instance_listener = match lifecycle::check_single_instance() {
        lifecycle::SingleInstanceStatus::Primary(listener) => listener,
        lifecycle::SingleInstanceStatus::SecondaryExited => {
            log::info!("Secondary instance detected and signaled; exiting gracefully.");
            return;
        }
    };

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ));

    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_mcp_bridge::init());

    builder
        .setup(|app| {
            log::info!("Tauri app setup starting...");
            lifecycle::start_single_instance_listener(app.handle().clone(), single_instance_listener);
            lifecycle::install_tray(app).expect("install system tray");
            log::info!("System tray installed successfully");
            let paths = crate::paths::resolve(app.handle()).expect("resolve application paths");
            log::info!("Application paths resolved: config={:?}, data={:?}", paths.config_dir, paths.data_dir);
            std::fs::create_dir_all(&paths.config_dir)
                .expect("create application config directory");
            let (lan, office, scanner_config, database_config, tts_config, updater_config) =
                config::load_config(&paths.config_dir).expect("valid config.toml");
            let db_path =
                crate::paths::resolve_db_path(&paths.config_dir, &paths.data_dir, &database_config);
            // Apply any pending database restore (admin flow marker or
            // ALPHA_PREMIER_RESTORE_FROM) before the database is opened, so
            // the live file is never touched by two processes. A failed
            // restore never blocks startup: the app keeps its current DB and
            // records the problem in `restore.failed`.
            let restore_outcome = tauri::async_runtime::block_on(crate::database::process_restore_request(
                &paths.data_dir,
                &paths.config_dir,
                &db_path,
            ));
            let (lan, office, scanner_config, _database_config, tts_config, updater_config, db_path) =
                match restore_outcome {
                    crate::database::RestoreOutcome::Restored { source } => {
                        log::info!("startup restore applied from {}", source.display());
                        let (lan, office, scanner_config, database_config, tts_config, updater_config) =
                            config::load_config(&paths.config_dir)
                                .expect("valid config.toml after restore");
                        let db_path = crate::paths::resolve_db_path(
                            &paths.config_dir,
                            &paths.data_dir,
                            &database_config,
                        );
                        (lan, office, scanner_config, database_config, tts_config, updater_config, db_path)
                    }
                    crate::database::RestoreOutcome::None => {
                        (lan, office, scanner_config, database_config, tts_config, updater_config, db_path)
                    }
                    crate::database::RestoreOutcome::SkippedMissingSource { source } => {
                        log::warn!(
                            "startup restore skipped: source {} was missing",
                            source.display()
                        );
                        (lan, office, scanner_config, database_config, tts_config, updater_config, db_path)
                    }
                    crate::database::RestoreOutcome::Failed { source, error } => {
                        log::error!(
                            "startup restore failed (source {}): {}; keeping current database",
                            source.display(),
                            error
                        );
                        (lan, office, scanner_config, database_config, tts_config, updater_config, db_path)
                    }
                };
            let state = match tauri::async_runtime::block_on(AppState::new(
                paths.data_dir.clone(),
                db_path,
                paths.exports_dir.clone(),
                paths.is_portable,
                lan,
                office,
                scanner_config,
                tts_config,
                updater_config,
            )) {
                Ok(s) => s,
                Err(err) => {
                    log::error!("SQLite/AppState initialization failed: {err:?}");
                    panic!("SQLite/AppState initialization failed: {err:?}");
                }
            };
            log::info!("AppState initialized successfully");
            if state.lan.enabled {
                let runtime = state.lan_runtime.clone();
                let server_state = state.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = runtime.start(&server_state).await;
                });
            }
            let sync_state = state.clone();
            tauri::async_runtime::spawn(async move {
                // Initial 5-second grace period on cold boot prevents network contention
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
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
            let webview_windows = app.webview_windows();
            log::info!("Registered webview windows at setup: {:?}", webview_windows.keys().collect::<Vec<_>>());
            if let Some(window) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                let config_dir = paths.config_dir.clone();
                let window_for_events = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        if !lifecycle::should_hide_on_close(
                            lifecycle::CloseBehavior::HideToTray,
                            true,
                        ) {
                            return;
                        }
                        api.prevent_close();
                        let _ = window_for_events.hide();
                        let handle = handle.clone();
                        if let Some(state) = handle.try_state::<AppState>() {
                            let data_dir = state.data_dir.clone();
                            let db_path = state.db_path.clone();
                            let db = state.db.clone();
                            let config_dir = config_dir.clone();
                            let _ = tauri::async_runtime::block_on(async move {
                                match crate::database::create_portable_backup(
                                    &db,
                                    &data_dir,
                                    &config_dir,
                                    &db_path,
                                )
                                .await
                                {
                                    Ok(path) => log::info!(
                                        "automatic backup on exit saved to {}",
                                        path.display()
                                    ),
                                    Err(error) => {
                                        log::warn!("automatic backup on exit skipped: {error}")
                                    }
                                }
                            });
                        }
                    }
                });
            }
            crate::services::scanner::start(app.handle().clone(), scanner_handle);
            log::info!("Tauri app setup completed successfully");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_health,
            get_config,
            get_attendance,
            scan_rfid,
            scanner_status,
            scanner_pause,
            notify_scan_success,
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
            admin_create_backdated_attendance,
            admin_delete_attendance,
            payroll_calculate_cutoff,
            payroll_list_profiles,
            payroll_upsert_profile,
            payroll_list_cutoffs,
            payroll_intern_report,
            payroll_generate_cutoff,
            payroll_create_cutoff,
            payroll_update_cutoff,
            payroll_finalize_cutoff,
            payroll_delete_cutoff,
            payroll_export_csv,
            export_attendance_xlsx,
            export_payroll_xlsx,
            generate_payroll_payslip_pdf,
            generate_payroll_register_pdf,
            generate_payroll_pdf,
            list_payroll_pdfs,
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
            open_viewer_url,
            tts_speak,
            tts_stop,
            tts_status,
            autostart_status,
            autostart_set,
            bathroom_get_status,
            bathroom_time_out,
            bathroom_time_in,
            bathroom_scan_rfid
        ])
        .run(tauri::generate_context!())
        .expect("error while running Alpha Premier Attendance");
}

#[cfg(test)]
mod tests {
    use super::{
        canonical_exports_path, enrich_cutoff_input, generated_file_metadata, normalize_gender,
        photo_is_within_limits, php_to_centavos, upsert_user_record,
    };
    use crate::config::{LanConfig, OfficeConfig};
    use crate::state::AppState;
    use sqlx::{sqlite::SqlitePoolOptions, Row};

    #[test]
    fn gender_normalization_can_never_violate_the_check_constraint() {
        // NULL / absent stays unset.
        assert_eq!(normalize_gender(None), None);
        // "Not set" (empty / whitespace) clears the field instead of writing
        // an empty string the `CHECK (gender IN ('MALE','FEMALE'))` rejects.
        assert_eq!(normalize_gender(Some("")), None);
        assert_eq!(normalize_gender(Some("   ")), None);
        // Casing and padding are normalized to the stored uppercase form.
        assert_eq!(normalize_gender(Some("male")), Some("MALE".to_string()));
        assert_eq!(
            normalize_gender(Some(" Female ")),
            Some("FEMALE".to_string())
        );
        // Already-canonical values pass through untouched.
        assert_eq!(normalize_gender(Some("MALE")), Some("MALE".to_string()));
    }

    #[tokio::test]
    async fn user_upsert_keeps_gender_and_photo_in_their_declared_columns() {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory database");
        sqlx::query("CREATE TABLE users (user_id TEXT PRIMARY KEY, rfid_uid TEXT NOT NULL UNIQUE, full_name TEXT NOT NULL, department TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, employee_type TEXT NOT NULL, daily_rate_centavos INTEGER, payroll_profile_id TEXT, photo_url TEXT, gender TEXT CHECK (gender IN ('MALE', 'FEMALE')), card_type TEXT NOT NULL DEFAULT 'EMPLOYEE' CHECK (card_type IN ('EMPLOYEE', 'ADMIN_ASSIST')), revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL)")
            .execute(&db).await.expect("users table");
        upsert_user_record(
            &db,
            "u-1",
            "A1B2C3",
            "Ada Lovelace",
            None,
            "ACTIVE",
            "EMPLOYEE",
            Some("FEMALE"),
            Some(50_000),
            Some("BEA_STANDARD"),
            Some("https://example.com/ada.webp"),
            "EMPLOYEE",
            "2026-08-05T00:00:00Z",
        )
        .await
        .expect("valid gender and photo must save");
        let row = sqlx::query("SELECT gender, photo_url, daily_rate_centavos, payroll_profile_id FROM users WHERE user_id = 'u-1'").fetch_one(&db).await.expect("saved user");
        assert_eq!(
            row.get::<Option<String>, _>("gender").as_deref(),
            Some("FEMALE")
        );
        assert_eq!(
            row.get::<Option<String>, _>("photo_url").as_deref(),
            Some("https://example.com/ada.webp")
        );
        assert_eq!(
            row.get::<Option<i64>, _>("daily_rate_centavos"),
            Some(50_000)
        );
        assert_eq!(
            row.get::<Option<String>, _>("payroll_profile_id")
                .as_deref(),
            Some("BEA_STANDARD")
        );
    }

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
        let enriched = enrich_cutoff_input(&db, &input)
            .await
            .expect("enriched input");

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
        super::apply_intern_rules(&db, &mut input)
            .await
            .expect("intern rules applied");

        assert_eq!(input["dailyRate"], 80.0);
        assert_eq!(input["lateDeduction"], 30.0);
        assert_eq!(input["payrollProfileId"], "INTERN_STANDARD");
        assert_eq!(input["incentivesAllowance"], 0.0);
        assert_eq!(input["specialHolidayDays"], 0.0);
        assert_eq!(input["absentDays"], 11.0);
        assert_eq!(input["halfDayCount"], 0.0);

        // Employees keep their own values untouched.
        sqlx::query("INSERT INTO users (user_id, full_name, daily_rate_centavos, employee_type) VALUES (?, ?, ?, ?)")
            .bind("EMP-1")
            .bind("Ada Lovelace")
            .bind(50_000_i64)
            .bind("EMPLOYEE")
            .execute(&db)
            .await
            .expect("employee row");
        let mut employee_input =
            serde_json::json!({"employeeId": "EMP-1", "dailyRate": 500.0, "lateUnits": 1.0});
        super::apply_intern_rules(&db, &mut employee_input)
            .await
            .expect("employee rules pass through");
        assert_eq!(employee_input["dailyRate"], 500.0);
        assert_eq!(employee_input.get("lateDeduction"), None);
    }

    #[test]
    fn calculates_single_day_attendance_cutoff_for_employee_and_intern() {
        let employee_input = crate::services::cutoff_payroll::CutoffInput {
            employee_id: "EMP-1".into(),
            employee_name: "John Doe".into(),
            cutoff_start: "2026-08-18".into(),
            cutoff_end: "2026-08-18".into(),
            daily_rate: 500.0,
            standard_working_days: 11.0,
            actual_working_days: 1.0,
            basic_pay: None,
            special_holiday_days: 0.0,
            special_holiday_multiplier: 0.3,
            special_holiday_pay: None,
            regular_holiday_days: 0.0,
            regular_holiday_multiplier: 1.0,
            regular_holiday_pay: None,
            hra: 0.0,
            incentives_allowance: 0.0,
            special_allowance: 0.0,
            late_deduction: 0.0,
            half_day_count: 0.0,
            half_day_fraction: 0.5,
            absent_days: 0.0,
            absence_deduction: None,
            overtime_hours: 0.0,
            overtime_rate: 0.0,
            overtime_pay: None,
            sss_employee_share: 0.0,
            phic_employee_share: 0.0,
            hdmf_employee_share: 0.0,
            salary_advance: 0.0,
            manual_adjustment: 0.0,
            adjustment_reason: None,
            approved_working_day_overage: true,
        };
        let emp_calc = crate::services::cutoff_payroll::calculate(&employee_input).unwrap();
        assert_eq!(emp_calc.basic_pay, 50_000);
        assert_eq!(emp_calc.net_pay, 50_000);

        let intern_input = crate::services::cutoff_payroll::CutoffInput {
            employee_id: "INT-1".into(),
            employee_name: "Deign Grey O. Lazaro".into(),
            cutoff_start: "2026-08-18".into(),
            cutoff_end: "2026-08-18".into(),
            daily_rate: 80.0,
            standard_working_days: 11.0,
            actual_working_days: 1.0,
            basic_pay: None,
            special_holiday_days: 0.0,
            special_holiday_multiplier: 0.0,
            special_holiday_pay: None,
            regular_holiday_days: 0.0,
            regular_holiday_multiplier: 0.0,
            regular_holiday_pay: None,
            hra: 0.0,
            incentives_allowance: 0.0,
            special_allowance: 0.0,
            late_deduction: 0.0,
            half_day_count: 0.0,
            half_day_fraction: 0.5,
            absent_days: 0.0,
            absence_deduction: None,
            overtime_hours: 0.0,
            overtime_rate: 0.0,
            overtime_pay: None,
            sss_employee_share: 0.0,
            phic_employee_share: 0.0,
            hdmf_employee_share: 0.0,
            salary_advance: 0.0,
            manual_adjustment: 0.0,
            adjustment_reason: None,
            approved_working_day_overage: true,
        };
        let intern_calc = crate::services::cutoff_payroll::calculate(&intern_input).unwrap();
        assert_eq!(intern_calc.basic_pay, 8_000);
        assert_eq!(intern_calc.net_pay, 8_000);
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
            crate::config::TtsConfig::default(),
            crate::config::UpdaterConfig::default(),
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
        assert_eq!(
            metadata["directoryPath"],
            exports_dir.to_string_lossy().as_ref()
        );
        assert_eq!(metadata["filePath"], file_path.to_string_lossy().as_ref());
        assert!(metadata["message"]
            .as_str()
            .unwrap()
            .contains("Payroll CSV generated"));
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
            crate::config::TtsConfig::default(),
            crate::config::UpdaterConfig::default(),
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

    #[tokio::test]
    async fn user_deletion_cascades_to_payroll_and_attendance() {
        let temp = std::env::temp_dir().join(format!("alpha-user-del-{}", uuid::Uuid::new_v4()));
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
            crate::config::TtsConfig::default(),
            crate::config::UpdaterConfig::default(),
        )
        .await
        .unwrap();

        // Create user
        super::upsert_user_record(
            &state.db,
            "EMP-DEL-TEST",
            "AABB1122",
            "Test Delete Employee",
            Some("Engineering"),
            "ACTIVE",
            "EMPLOYEE",
            Some("MALE"),
            Some(50_000),
            Some("BEA_STANDARD"),
            None,
            "EMPLOYEE",
            "2026-08-01T00:00:00Z",
        )
        .await
        .unwrap();

        // Create cutoff payroll row
        sqlx::query(
            "INSERT INTO payroll_cutoffs (payroll_id, employee_id, employee_name, payroll_profile_id, payroll_cutoff_label, cutoff_start, cutoff_end, payroll_frequency, daily_rate_centavos, standard_working_days, actual_working_days, basic_pay_centavos, special_holiday_days, special_holiday_multiplier, special_holiday_pay_centavos, regular_holiday_days, regular_holiday_multiplier, regular_holiday_pay_centavos, incentives_allowance_centavos, special_allowance_centavos, total_compensation_centavos, total_allowance_centavos, late_units, late_deduction_centavos, half_day_count, half_day_deduction_centavos, absent_days, absence_deduction_centavos, overtime_hours, overtime_rate_centavos, overtime_pay_centavos, manual_adjustment_centavos, adjustment_reason, gross_compensation_centavos, net_pay_centavos, signature_placeholder, calculation_breakdown, approved_working_day_overage, status, hra_centavos, sss_centavos, phic_centavos, hdmf_centavos, salary_advance_centavos, created_at, updated_at) VALUES ('P-DEL-1', 'EMP-DEL-TEST', 'Test Delete Employee', 'BEA_STANDARD', '2026-08-01 to 2026-08-15', '2026-08-01', '2026-08-15', 'SEMI_MONTHLY', 50000, 11, 11, 550000, 0, 0.3, 0, 0, 1.0, 0, 0, 0, 550000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, 550000, 550000, '', '{}', 1, 'FINALIZED', 0, 0, 0, 0, 0, '2026-08-15T00:00:00Z', '2026-08-15T00:00:00Z')"
        )
        .execute(&state.db)
        .await
        .unwrap();

        // Verify cutoff exists
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM payroll_cutoffs WHERE payroll_id = 'P-DEL-1'")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(count, 1);

        // Delete user and cascade
        super::delete_user_and_cascade(&state, "EMP-DEL-TEST").await.unwrap();

        // Verify user and cutoffs are gone
        let user_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE user_id = 'EMP-DEL-TEST'")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(user_count, 0);

        let cutoff_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM payroll_cutoffs WHERE employee_id = 'EMP-DEL-TEST'")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(cutoff_count, 0);

        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn foreign_key_delete_error_is_translated() {
        // BUG-DB-02: SQLite FK violations surface a friendly message.
        let translated = super::friendly_delete_user_error(
            "database error: FOREIGN KEY constraint failed".into(),
        );
        assert!(translated.starts_with("USER_HAS_RECORDS:"));
        assert!(translated.contains("Deactivate the user instead"));
        // Other errors pass through unchanged.
        assert_eq!(
            super::friendly_delete_user_error("USER_NOT_FOUND".into()),
            "USER_NOT_FOUND"
        );
    }

    #[test]
    fn test_normalize_name() {
        assert_eq!(super::normalize_name("   john   doe   "), "John Doe");
        assert_eq!(super::normalize_name("MARY-ANNE"), "Mary-Anne");
        assert_eq!(super::normalize_name("o'connor"), "O'Connor");
        assert_eq!(super::normalize_name("o’neill"), "O’Neill");
        assert_eq!(super::normalize_name("ma. teresa"), "Ma. Teresa");
        assert_eq!(super::normalize_name(""), "");
    }

    #[tokio::test]
    async fn test_admin_unlock_by_pin_or_admin_rfid() {
        let temp = std::env::temp_dir().join(format!("alpha-admin-unlock-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(temp.join("exports")).unwrap();
        let data_dir = temp.clone();
        let exports_dir = temp.join("exports");
        let mut lan = LanConfig::default();
        lan.admin_pin = Some("2468".to_string());
        lan.admin_session_minutes = 15;
        let state = AppState::new(
            data_dir.clone(),
            data_dir.join("attendance.db"),
            exports_dir.clone(),
            false,
            lan,
            OfficeConfig::default(),
            crate::config::ScannerConfig::default(),
            crate::config::TtsConfig::default(),
            crate::config::UpdaterConfig::default(),
        )
        .await
        .unwrap();

        // Insert an admin assist card and a regular employee card
        super::upsert_user_record(
            &state.db,
            "ADMIN_CARD_ADDE23",
            "ADDE23",
            "Front Desk Admin",
            Some("Admin"),
            "ACTIVE",
            "EMPLOYEE",
            None,
            None,
            None,
            None,
            "ADMIN_ASSIST",
            "2026-08-27T00:00:00Z",
        )
        .await
        .unwrap();

        super::upsert_user_record(
            &state.db,
            "EMP_REGULAR",
            "EEFF00",
            "Regular Employee",
            Some("Engineering"),
            "ACTIVE",
            "EMPLOYEE",
            Some("MALE"),
            Some(50_000),
            Some("BEA_STANDARD"),
            None,
            "EMPLOYEE",
            "2026-08-27T00:00:00Z",
        )
        .await
        .unwrap();

        // 1. PIN unlock works
        let res_pin = super::setup_unlock_impl(&state, "2468".to_string()).await;
        assert!(res_pin.is_ok(), "Configured PIN should unlock admin session");

        // 2. Admin RFID unlock works
        let res_rfid = super::setup_unlock_impl(&state, "ADDE23".to_string()).await;
        assert!(res_rfid.is_ok(), "Admin RFID card should unlock admin session");

        // 3. Regular employee RFID is rejected
        let res_emp = super::setup_unlock_impl(&state, "EEFF00".to_string()).await;
        assert_eq!(res_emp.unwrap_err(), "INVALID_ADMIN_PIN");

        // 4. Unknown string is rejected
        let res_wrong = super::setup_unlock_impl(&state, "WRONG_PASS".to_string()).await;
        assert_eq!(res_wrong.unwrap_err(), "INVALID_ADMIN_PIN");

        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[tokio::test]
    async fn bathroom_key_log_enforces_single_active_key_and_time_in() {
        let temp = std::env::temp_dir().join(format!("alpha-bathroom-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        let db_path = temp.join("attendance.db");
        let exports_path = temp.join("exports");
        let state = AppState::new(
            temp.clone(),
            db_path,
            exports_path,
            false,
            LanConfig::default(),
            OfficeConfig::default(),
            crate::config::ScannerConfig::default(),
            crate::config::TtsConfig::default(),
            crate::config::UpdaterConfig::default(),
        )
        .await
        .unwrap();

        super::upsert_user_record(
            &state.db,
            "EMP_01",
            "CARD_01",
            "John Doe",
            Some("IT"),
            "ACTIVE",
            "EMPLOYEE",
            Some("MALE"),
            Some(50_000),
            Some("BEA_STANDARD"),
            None,
            "EMPLOYEE",
            "2026-08-27T00:00:00Z",
        )
        .await
        .unwrap();

        super::upsert_user_record(
            &state.db,
            "EMP_02",
            "CARD_02",
            "Jane Smith",
            Some("HR"),
            "ACTIVE",
            "EMPLOYEE",
            Some("FEMALE"),
            Some(50_000),
            Some("BEA_STANDARD"),
            None,
            "EMPLOYEE",
            "2026-08-27T00:00:00Z",
        )
        .await
        .unwrap();

        // 1. Check out Male key
        let log_id = uuid::Uuid::new_v4().to_string();
        let now_manila = chrono::Utc::now().with_timezone(&chrono_tz::Asia::Manila);
        let log_date = now_manila.date_naive().format("%Y-%m-%d").to_string();
        let time_out = now_manila.to_rfc3339();
        let now_utc = chrono::Utc::now().to_rfc3339();

        sqlx::query(
            "INSERT INTO bathroom_log (log_id, log_date, user_id, full_name, department, gender_key, time_out, time_in, duration_seconds, status, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'MALE', ?, NULL, NULL, 'OUT', '', ?, ?)",
        )
        .bind(&log_id)
        .bind(&log_date)
        .bind("EMP_01")
        .bind("John Doe")
        .bind("IT")
        .bind(&time_out)
        .bind(&now_utc)
        .bind(&now_utc)
        .execute(&state.db)
        .await
        .unwrap();

        // 2. Second checkout of Male key must fail database unique constraint
        let log_id2 = uuid::Uuid::new_v4().to_string();
        let second_checkout = sqlx::query(
            "INSERT INTO bathroom_log (log_id, log_date, user_id, full_name, department, gender_key, time_out, time_in, duration_seconds, status, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'MALE', ?, NULL, NULL, 'OUT', '', ?, ?)",
        )
        .bind(&log_id2)
        .bind(&log_date)
        .bind("EMP_02")
        .bind("Jane Smith")
        .bind("HR")
        .bind(&time_out)
        .bind(&now_utc)
        .bind(&now_utc)
        .execute(&state.db)
        .await;

        assert!(second_checkout.is_err(), "Concurrent checkout of same gender key must violate unique constraint");

        // 3. Female key checkout can proceed concurrently
        let female_log_id = uuid::Uuid::new_v4().to_string();
        let female_checkout = sqlx::query(
            "INSERT INTO bathroom_log (log_id, log_date, user_id, full_name, department, gender_key, time_out, time_in, duration_seconds, status, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'FEMALE', ?, NULL, NULL, 'OUT', '', ?, ?)",
        )
        .bind(&female_log_id)
        .bind(&log_date)
        .bind("EMP_02")
        .bind("Jane Smith")
        .bind("HR")
        .bind(&time_out)
        .bind(&now_utc)
        .bind(&now_utc)
        .execute(&state.db)
        .await;

        assert!(female_checkout.is_ok(), "Female key checkout must succeed independently of Male key");

        // 4. Return Male key
        let time_in = chrono::Utc::now().with_timezone(&chrono_tz::Asia::Manila).to_rfc3339();
        sqlx::query(
            "UPDATE bathroom_log SET time_in = ?, duration_seconds = 120, status = 'RETURNED', updated_at = ? WHERE log_id = ?",
        )
        .bind(&time_in)
        .bind(&now_utc)
        .bind(&log_id)
        .execute(&state.db)
        .await
        .unwrap();

        // 5. Now Male key can be checked out again
        let third_checkout = sqlx::query(
            "INSERT INTO bathroom_log (log_id, log_date, user_id, full_name, department, gender_key, time_out, time_in, duration_seconds, status, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'MALE', ?, NULL, NULL, 'OUT', '', ?, ?)",
        )
        .bind(&log_id2)
        .bind(&log_date)
        .bind("EMP_01")
        .bind("John Doe")
        .bind("IT")
        .bind(&time_out)
        .bind(&now_utc)
        .bind(&now_utc)
        .execute(&state.db)
        .await;

        assert!(third_checkout.is_ok(), "Male key can be checked out again once returned");

        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[tokio::test]
    async fn bathroom_rfid_scan_checkout_return_and_conflict() {
        let temp = std::env::temp_dir().join(format!("alpha-bathroom-scan-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        let db_path = temp.join("attendance.db");
        let exports_path = temp.join("exports");
        let state = AppState::new(
            temp.clone(),
            db_path,
            exports_path,
            false,
            LanConfig::default(),
            OfficeConfig::default(),
            crate::config::ScannerConfig::default(),
            crate::config::TtsConfig::default(),
            crate::config::UpdaterConfig::default(),
        )
        .await
        .unwrap();

        // Insert two test users: MALE (John) and MALE (Bob)
        super::upsert_user_record(
            &state.db,
            "EMP_01",
            "A1B2C3D4",
            "John Doe",
            Some("Engineering"),
            "ACTIVE",
            "EMPLOYEE",
            Some("MALE"),
            Some(50_000),
            Some("BEA_STANDARD"),
            None,
            "EMPLOYEE",
            "2026-08-27T00:00:00Z",
        )
        .await
        .unwrap();

        super::upsert_user_record(
            &state.db,
            "EMP_02",
            "E5F6A7B8",
            "Bob Smith",
            Some("Marketing"),
            "ACTIVE",
            "EMPLOYEE",
            Some("MALE"),
            Some(50_000),
            Some("BEA_STANDARD"),
            None,
            "EMPLOYEE",
            "2026-08-27T00:00:00Z",
        )
        .await
        .unwrap();

        // 1. First scan by John Doe: CHECKOUT Male Key
        let res1 = super::process_bathroom_scan(&state, "A1B2C3D4").await.unwrap();
        assert_eq!(res1["success"], true);
        assert_eq!(res1["action"], "CHECKOUT");
        assert_eq!(res1["genderKey"], "MALE");
        assert_eq!(res1["user"]["fullName"], "John Doe");

        // 2. Second scan by Bob Smith (different user, same gender): CONFLICT
        let res2 = super::process_bathroom_scan(&state, "E5F6A7B8").await.unwrap();
        assert_eq!(res2["success"], false);
        assert_eq!(res2["error"]["code"], "BATHROOM_KEY_IN_USE");
        assert_eq!(res2["activeHolder"]["fullName"], "John Doe");

        // 3. Third scan by John Doe: RETURN Male Key
        let res3 = super::process_bathroom_scan(&state, "A1B2C3D4").await.unwrap();
        assert_eq!(res3["success"], true);
        assert_eq!(res3["action"], "RETURN");
        assert_eq!(res3["genderKey"], "MALE");
        assert_eq!(res3["user"]["fullName"], "John Doe");

        // 4. Fourth scan by Bob Smith: Now CHECKOUT succeeds for Bob
        let res4 = super::process_bathroom_scan(&state, "E5F6A7B8").await.unwrap();
        assert_eq!(res4["success"], true);
        assert_eq!(res4["action"], "CHECKOUT");
        assert_eq!(res4["user"]["fullName"], "Bob Smith");

        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[tokio::test]
    async fn test_admin_create_backdated_attendance() {
        let temp = std::env::temp_dir().join(format!("alpha-backdate-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        let db_path = temp.join("attendance.db");
        let exports_path = temp.join("exports");
        let mut lan = LanConfig::default();
        lan.admin_pin = Some("1234".to_string());
        lan.admin_session_minutes = 30;
        let state = AppState::new(
            temp.clone(),
            db_path,
            exports_path,
            false,
            lan,
            OfficeConfig::default(),
            crate::config::ScannerConfig::default(),
            crate::config::TtsConfig::default(),
            crate::config::UpdaterConfig::default(),
        )
        .await
        .unwrap();

        // Unlock admin
        let unlock_res = super::setup_unlock_impl(&state, "1234".to_string()).await.unwrap();
        let token = unlock_res["token"].as_str().unwrap().to_string();

        super::upsert_user_record(
            &state.db,
            "EMP_01",
            "CARD_01",
            "Alice Cooper",
            Some("IT"),
            "ACTIVE",
            "EMPLOYEE",
            Some("FEMALE"),
            Some(50_000),
            Some("BEA_STANDARD"),
            None,
            "EMPLOYEE",
            "2026-08-01T00:00:00Z",
        )
        .await
        .unwrap();

        // 1. Success creating past backdated entry
        let payload = serde_json::json!({
            "userId": "EMP_01",
            "attendanceDate": "2026-08-15",
            "timeIn": "2026-08-15T08:00:00+08:00",
            "timeOut": "2026-08-15T17:00:00+08:00",
            "reason": "Missed scan physical log verified"
        });
        let res = super::admin_create_backdated_attendance_impl(None, &state, &token, &payload).await.unwrap();
        assert_eq!(res["success"], true);
        assert_eq!(res["attendance"]["attendanceDate"], "2026-08-15");
        assert_eq!(res["attendance"]["userId"], "EMP_01");
        assert_eq!(res["attendance"]["source"], "ADMIN_BACKDATED_ENTRY");
        assert_eq!(res["attendance"]["status"], "COMPLETED");

        // 2. Reject duplicate date
        let dup_err = super::admin_create_backdated_attendance_impl(None, &state, &token, &payload).await.unwrap_err();
        assert_eq!(dup_err, "ATTENDANCE_ALREADY_EXISTS_FOR_DATE");

        // 3. Reject future or today date
        let future_payload = serde_json::json!({
            "userId": "EMP_01",
            "attendanceDate": "2099-01-01",
            "timeIn": "2099-01-01T08:00:00+08:00",
            "reason": "Future date"
        });
        let future_err = super::admin_create_backdated_attendance_impl(None, &state, &token, &future_payload).await.unwrap_err();
        assert_eq!(future_err, "ADMIN_VALIDATION_ERROR");

        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }
}
