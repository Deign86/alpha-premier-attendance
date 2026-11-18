use chrono_tz::Asia::Manila;
use crate::state::AppState;
use sqlx::Row;
use std::time::Instant;
use crate::services::attendance::{attendance_arrival, attendance_changed, ensure_payroll_tx, AttendanceChange, DtrLine, DtrPerson, LanNotice, WindowEvent};
use super::users::resolve_user_photo_url;
use tauri::State;

#[tauri::command]
pub(crate) fn get_health(state: State<'_, AppState>) -> serde_json::Value {
    serde_json::json!({"success":true,"service":"rfid-attendance-api","timestamp":chrono::Utc::now(),"timezone":"Asia/Manila","sqlite":"connected","lanEnabled":state.lan.enabled,"lan":{"bindAddress":state.lan.bind_address.map(|v|v.to_string()),"port":state.lan.port,"connectedSseClients":state.connected_sse_clients.load(std::sync::atomic::Ordering::Relaxed)},"googleSheetsExport":if state.lan.sheets_sync_endpoint.is_some() || state.lan.google_spreadsheet_id.is_some() || state.lan.google_drive_folder_id.is_some() || state.lan.google_create_folder_if_missing { "configured" } else { "disabled" }})
}

#[tauri::command]
pub(crate) fn get_config(state: State<'_, AppState>) -> serde_json::Value {
    serde_json::json!({"success":true,"timezone":"Asia/Manila","rfidAutoSubmitDelayMs":150,"resultResetDelayMs":4000,"enableAdmin":true,"enableCardSetup":true,"lanEnabled":state.lan.enabled,"updater":{"enabled":state.updater.enabled,"autoCheck":state.updater.auto_check,"checkIntervalHours":state.updater.check_interval_hours},"scanner":{"mode":"keyboard","paused":state.scanner.paused(),"expectedLength":state.scanner.config.expected_length,"characterSet":if matches!(state.scanner.config.character_set, crate::config::ScannerCharacterSet::Hex) { "hex" } else { "decimal" }},"office":{"companyName":state.office.company_name,"officeLabel":state.office.office_label,"officeAddressLine1":state.office.office_address_line_1,"officeBuilding":state.office.office_building,"officeDistrict":state.office.office_district,"officeCity":state.office.office_city,"officeRegion":state.office.office_region,"officeCountry":state.office.office_country,"officePostalCode":state.office.office_postal_code,"officeDisplayShort":state.office.display_short(),"officeDisplayFull":state.office.display_full()}})
}

#[tauri::command]
pub(crate) fn notify_scan_success(app: tauri::AppHandle, full_name: String) -> Result<(), String> {
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
/// Live scanner lifecycle status (state, message, mode) for the kiosk status
/// pill and admin diagnostics.
pub(crate) fn scanner_status(state: State<'_, AppState>) -> crate::services::scanner::ScannerStatus {
    state.scanner.status()
}

#[tauri::command]
/// Pause/resume the native scanner listener while the operator types (admin,
/// setup, manual entry) so keystrokes are never misread as card scans.
pub(crate) fn scanner_pause(state: State<'_, AppState>, paused: bool) {
    state.scanner.set_paused(paused);
}

#[tauri::command]
pub(crate) async fn scan_rfid(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    scan_rfid_impl(Some(&app), &state, request).await
}

/// Shortest time between a time-in and the tap that times the person out
/// (owner decision D4, 2026-11-06): anything sooner is a double tap.
pub(crate) const MIN_SECS_FROM_TIME_IN_TO_TIME_OUT: i64 = 60;

pub(crate) async fn scan_rfid_impl(
    app: Option<&tauri::AppHandle>,
    state: &AppState,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    scan_rfid_at(app, state, request, chrono::Utc::now()).await
}

pub(crate) async fn scan_rfid_at(
    app: Option<&tauri::AppHandle>,
    state: &AppState,
    request: serde_json::Value,
    now: chrono::DateTime<chrono::Utc>,
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
    crate::services::audit::log(
        &state.db,
        crate::services::audit::Entry::new("SCAN_RECEIVED", &received_at, &format!("Scan request received from {source}"), &request_id).card(if uid.is_empty() { None } else { Some(uid.as_str()) }),
    )
    .await;
    let valid_uid = source == "MANUAL_TEST"
        || (uid.len() >= 4 && uid.len() <= 64 && uid.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let valid_source = matches!(source, "RFID" | "MANUAL_TEST" | "ADMIN_ASSISTED_SCAN");
    if uid.is_empty() || !valid_uid || !valid_source {
        return Ok(
            serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"INVALID_SCAN_INPUT","message":"rfidUid and source are required."}}),
        );
    }
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
        crate::services::audit::log(
            &state.db,
            crate::services::audit::Entry::new("SCAN_SUCCESS", &received_at, "ADMIN_ASSIST card presented", &request_id).card(Some(&uid)).user(Some(&user.get::<String, _>("user_id"))),
        )
        .await;
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
        let mut debounce = state.scan_debounce.lock().await;
        let now = Instant::now();
        if let Some(entry) = debounce.get(&cooldown_key) {
            if entry.fast.elapsed().as_millis() < 500 {
                return Ok(
                    serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"DUPLICATE_SCAN","message":"This card was scanned too recently."}}),
                );
            }
            if entry
                .slow
                .is_some_and(|last| last.elapsed().as_secs() < 10)
            {
                return Ok(
                    serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"DUPLICATE_SCAN","message":"This card was scanned too recently.","retryAfterSeconds":10}}),
                );
            }
        }
        let prev_slow = debounce.get(&cooldown_key).and_then(|entry| entry.slow);
        debounce.insert(
            cooldown_key.clone(),
            crate::state::ScanDebounce { fast: now, slow: prev_slow },
        );
        if debounce.len() > 4096 {
            debounce.retain(|_, entry| entry.fast.elapsed().as_secs() < 10);
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
    // Each branch writes on its own transaction and hands it back: the sync
    // queue rows below commit with the attendance change (O4).
    let (attendance_id, action, time_in, time_out, attendance_status, tx, pending) = match existing {
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            let Ok(mut tx) = state.db.begin().await else {
                return Ok(
                    serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"INTERNAL_SERVER_ERROR","message":"Unable to save attendance."}}),
                );
            };
            // A double tap that raced the first tap's commit finds the day
            // already started: answer as a repeat tap, not "Unable to save" (S5).
            let result = sqlx::query("INSERT INTO attendance (attendance_id, attendance_date, user_id, rfid_uid, full_name, department, time_in, time_out, status, source, notes, recorded_by, recorded_reason, recorded_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'WORKING', ?, '', ?, ?, ?, ?, ?) ON CONFLICT(user_id, attendance_date) DO NOTHING")
                .bind(&id).bind(&date).bind(&user_id).bind(&effective_uid).bind(effective_user.get::<String,_>("full_name")).bind(effective_user.get::<Option<String>,_>("department")).bind(&timestamp).bind(effective_source).bind(&recorded_by).bind(&recorded_reason).bind(&recorded_at).bind(&timestamp).bind(&timestamp).execute(&mut *tx).await;
            match result.map(|done| done.rows_affected()) {
                Ok(1) => {}
                Ok(_) => {
                    return Ok(
                        serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"DUPLICATE_SCAN","message":"This card was scanned too recently."}}),
                    );
                }
                Err(_) => {
                    return Ok(
                        serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"INTERNAL_SERVER_ERROR","message":"Unable to save attendance."}}),
                    );
                }
            }
            (id, "TIME_IN", Some(timestamp.clone()), None, "WORKING", tx, Vec::new())
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
            // Measured from the stored time-in, so it also holds across a
            // restart (the in-memory debounce only covers 10 s).
            let secs_since_in = tin
                .as_deref()
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                .map(|time_in| (now - time_in.with_timezone(&chrono::Utc)).num_seconds());
            if secs_since_in.is_some_and(|secs| secs < MIN_SECS_FROM_TIME_IN_TO_TIME_OUT) {
                return Ok(
                    serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"DUPLICATE_SCAN","message":"Already timed in. Tap again after a minute to time out."}}),
                );
            }
            // The office does not allow overtime: a time-out after office
            // hours is saved as LATE_TIMEOUT (pending manual correction),
            // never as a normal COMPLETED shift.
            let late = crate::services::office_hours::is_late_timeout(&timestamp);
            let new_status = if late { "LATE_TIMEOUT" } else { "COMPLETED" };
            // Time-out + payroll commit together: a payroll failure rolls the
            // time-out back so the card can simply be scanned again.
            let mut tx = match state.db.begin().await {
                Ok(tx) => tx,
                Err(_) => {
                    return Ok(
                        serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"INTERNAL_SERVER_ERROR","message":"Unable to save attendance."}}),
                    );
                }
            };
            let result = sqlx::query("UPDATE attendance SET time_out = ?, status = ?, source = ?, recorded_by = COALESCE(?, recorded_by), recorded_reason = COALESCE(?, recorded_reason), recorded_at = COALESCE(?, recorded_at), revision = revision + 1, updated_at = ? WHERE attendance_id = ? AND revision = ? AND time_out IS NULL")
                .bind(&timestamp).bind(new_status).bind(effective_source).bind(&recorded_by).bind(&recorded_reason).bind(&recorded_at).bind(&timestamp).bind(&id).bind(row.get::<i64,_>("revision")).execute(&mut *tx).await;
            if result.map(|r| r.rows_affected()).unwrap_or(0) != 1 {
                return Ok(
                    serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"ATTENDANCE_DATA_CONFLICT","message":"Attendance changed before the scan was saved."}}),
                );
            }
            // LATE_TIMEOUT still pays: the engines cap the clock-out to 17:00
            // (cap_late_timeout_out) before any math, so the day is a full capped shift.
            // Payroll runs in a savepoint: a late time-out the engine cannot
            // price (time-in after 17:00 caps the time-out below it) is still
            // recorded, with no payroll, for the admin correction (owner
            // decision D3, 2026-11-06). Before, every tap failed and the day
            // stayed WORKING for good.
            let Ok(mut payroll) = sqlx::Connection::begin(&mut *tx).await else {
                return Ok(
                    serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"INTERNAL_SERVER_ERROR","message":"Unable to save attendance."}}),
                );
            };
            let pending = match ensure_payroll_tx(
                &mut payroll,
                &id,
                &user_id,
                effective_user.get::<String, _>("full_name"),
                &date,
                tin.as_deref().unwrap_or_default(),
                &timestamp,
            )
            .await
            {
                Ok(pending) => {
                    if payroll.commit().await.is_err() {
                        return Ok(
                            serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"INTERNAL_SERVER_ERROR","message":"Unable to save attendance."}}),
                        );
                    }
                    pending
                }
                Err(error) if new_status == "LATE_TIMEOUT" => {
                    let _ = payroll.rollback().await;
                    log::warn!("late time-out {id} recorded without payroll, pending correction: {error}");
                    Vec::new()
                }
                Err(error) => {
                    return Ok(
                        serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"PAYROLL_GENERATION_FAILED","message":error}}),
                    );
                }
            };
            (id, "TIME_OUT", tin, Some(timestamp.clone()), new_status, tx, pending)
        }
    };
    let audit_msg = if is_admin_card {
        format!("{} recorded (Assisted by {})", action, recorded_by.as_deref().unwrap_or("Admin"))
    } else {
        format!("{} recorded", action)
    };
    let full_name = effective_user.get::<String, _>("full_name");
    // Intern-DTR auto-push: same success path covers TIME_IN and TIME_OUT.
    // Enqueue-only (the 30s sync loop does the network); a DTR failure can
    // never fail the scan. Skipped for non-interns; queued even while upload
    // is switched off, which only pauses dispatch (owner decision D5).
    let mirrored = effective_source == "RFID" || effective_source == "ADMIN_ASSISTED_SCAN";
    let time_in_shown = serde_json::json!(&time_in);
    let time_out_shown = serde_json::json!(&time_out);
    let committed = attendance_changed(state, tx, AttendanceChange {
        attendance_id: &attendance_id,
        date: &date,
        pending,
        sheet_operation: "UPSERT",
        sheet_row: serde_json::json!({
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
        }),
        person: mirrored.then(|| DtrPerson { user_id: user_id.clone(), full_name: full_name.clone(), employee_type: effective_user.get("employee_type") }),
        dtr: DtrLine::Write { time_in: time_in_shown.as_str(), time_out: time_out_shown.as_str() },
        // A scan has never re-queued the later days of the week; the three admin paths do.
        requeue_later_week: false,
        follow: Vec::new(),
        tap: Some(cooldown_key),
        lan: LanNotice {
            cause: action,
            mutation: "upsert",
            from_scan: Some((request_id.clone(), now, crate::lan_server::LanAttendanceRow {
                attendance_id: attendance_id.clone(),
                attendance_date: date.clone(),
                user_id: user_id.clone(),
                full_name: full_name.clone(),
                department: effective_user.get::<Option<String>, _>("department"),
                time_in: time_in.clone(),
                time_out: time_out.clone(),
                status: attendance_status.to_string(),
            })),
        },
        window_event: Some(WindowEvent {
            app,
            user_id: &user_id,
            action,
            time_in: time_in_shown.clone(),
            time_out: time_out_shown.clone(),
            status: attendance_status,
            own_sequence: false,
        }),
        audit: Some(crate::services::audit::Entry::new("SCAN_SUCCESS", &timestamp, &audit_msg, &request_id).card(Some(&uid)).user(Some(&user_id))),
    })
    .await;
    if committed.is_err() {
        return Ok(
            serde_json::json!({"success":false,"requestId":request_id,"error":{"code":"INTERNAL_SERVER_ERROR","message":"Unable to save attendance."}}),
        );
    }
    let photo_url = resolve_user_photo_url(&state.data_dir, &user_id, effective_user.get::<Option<String>,_>("photo_url"));
    let shown = attendance_arrival(&state.db, &user_id, &attendance_id, &date, serde_json::json!(&time_in).as_str()).await;
    let mut answer = serde_json::json!({
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
        });
    shown.insert_into(&mut answer["attendance"]);
    Ok(answer)
}

#[tauri::command]
pub(crate) fn autostart_status(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn autostart_set(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    // Opt-out marker I/O stays log-only: a resolve failure skips the marker
    // while the registry mutation still runs through the shared helper.
    let config_dir = match crate::paths::resolve(&app) {
        Ok(paths) => Some(paths.config_dir),
        Err(e) => {
            log::warn!("Could not resolve config dir for autostart marker: {e}");
            None
        }
    };
    crate::lifecycle::set_autostart_enabled(&app, config_dir.as_deref(), enabled)?;
    log::info!(
        "{}",
        if enabled {
            "Enabled autostart via in-app settings"
        } else {
            "Disabled autostart via in-app settings"
        }
    );
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::*;
    use crate::commands::attendance::admin_update_attendance_impl;
    use crate::commands::payroll::payroll_generate_cutoff_impl;
    use crate::services::users::upsert_user_record;
    

    #[tokio::test]
    async fn dtr_upload_off_keeps_queuing_and_resumes_with_current_data() {
        let _env_guard = crate::config::dtr_env_test_guard();
        let saved_env = std::env::var(crate::config::ENV_DTR_SHEET_ID).ok();
        std::env::remove_var(crate::config::ENV_DTR_SHEET_ID);
        let temp = std::env::temp_dir().join(format!("alpha-dtr-off-queue-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        let mut lan = LanConfig::default();
        lan.google_dtr_spreadsheet_id = Some("sheet-test".to_string());
        let state = AppState::new(
            temp.clone(),
            temp.join("attendance.db"),
            temp.join("exports"),
            false,
            lan,
            OfficeConfig::default(),
            crate::config::ScannerConfig::default(),
            crate::config::TtsConfig::default(),
            crate::config::UpdaterConfig::default(),
        )
        .await
        .unwrap();
        let token = "test-admin-token".to_string();
        *state.admin_session.lock().await = Some(crate::state::AdminSession {
            token: token.clone(),
            expires_at: std::time::Instant::now() + std::time::Duration::from_secs(3600),
        });
        upsert_user_record(
            &state.db, "INT_OFF", "C0FFEE09", "Paused Intern", Some("IT"), "ACTIVE", "INTERN",
            Some("MALE"), None, Some("BEA_STANDARD"), None, "EMPLOYEE", "2026-08-01T00:00:00Z",
        )
        .await
        .unwrap();
        crate::services::dtr_sync::set_dtr_sync_enabled(&state.db, false).await.unwrap();

        // Owner decision D5: punches made while upload is off are still queued.
        let tap = serde_json::json!({"rfidUid": "C0FFEE09", "source": "RFID"});
        let res = scan_rfid_at(None, &state, tap, manila("2026-11-05T08:00:00+08:00")).await.unwrap();
        assert_eq!(res["success"], true, "{res}");
        let aid = res["attendance"]["attendanceId"].as_str().unwrap().to_string();
        let queued = |aid: String| {
            let db = state.db.clone();
            async move {
                sqlx::query("SELECT status, payload_json FROM sync_queue WHERE table_name='InternDtr' AND row_id=? AND operation='UPSERT'")
                    .bind(aid)
                    .fetch_optional(&db)
                    .await
                    .unwrap()
            }
        };
        assert!(queued(aid.clone()).await.is_some(), "time-in queued while upload is off");

        // A correction while off replaces the queued payload, so resuming
        // pushes the current day, not the one frozen at pause time.
        admin_update_attendance_impl(&state, &token, &aid, &serde_json::json!({"timeOut": "2026-11-05T17:00:00+08:00"})).await.unwrap();
        let row = queued(aid.clone()).await.unwrap();
        let payload: serde_json::Value = serde_json::from_str(&row.get::<String, _>("payload_json")).unwrap();
        assert_eq!(payload["timeOut"], "2026-11-05T17:00:00+08:00");

        // Dispatch stays paused: the row is left waiting, never dropped.
        let _ = crate::services::sheets_sync::run_once(&state, Some("http://127.0.0.1:9/__dtr_off")).await;
        assert_eq!(queued(aid).await.unwrap().get::<String, _>("status"), "PENDING");

        match saved_env {
            Some(value) => std::env::set_var(crate::config::ENV_DTR_SHEET_ID, value),
            None => std::env::remove_var(crate::config::ENV_DTR_SHEET_ID),
        }
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[tokio::test]
    async fn queue_rows_commit_with_the_attendance_write() {
        // O4: an attendance change and its sync row commit together. The
        // probe makes the transaction fail after the queue row is written
        // (a deferred FK checked only at COMMIT), standing in for the app
        // dying before the commit: neither may survive alone.
        let _env_guard = crate::config::dtr_env_test_guard();
        let (state, temp, _token) = admin_test_state("outbox").await;
        add_intern(&state, "INT_O", "C0FFEE10").await;
        sqlx::query("CREATE TABLE outbox_probe (id INTEGER PRIMARY KEY, ref TEXT REFERENCES users(user_id) DEFERRABLE INITIALLY DEFERRED)")
            .execute(&state.db).await.unwrap();
        sqlx::query("CREATE TRIGGER outbox_probe_fail AFTER INSERT ON sync_queue WHEN NEW.table_name='Attendance' BEGIN INSERT INTO outbox_probe(ref) VALUES ('no-such-user'); END")
            .execute(&state.db).await.unwrap();
        let tap = serde_json::json!({"rfidUid": "C0FFEE10", "source": "RFID"});
        let _ = scan_rfid_at(None, &state, tap, manila("2026-11-05T08:00:00+08:00")).await.unwrap();
        let attendance: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attendance WHERE user_id='INT_O'")
            .fetch_one(&state.db).await.unwrap();
        let queued: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_queue WHERE table_name='Attendance'")
            .fetch_one(&state.db).await.unwrap();
        assert_eq!(attendance, queued, "attendance and its sync row commit together (attendance={attendance}, queued={queued})");
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[tokio::test]
    async fn cutoff_generate_is_all_or_nothing_and_deletes_replaced_drafts_on_the_sheet() {
        let _env_guard = crate::config::dtr_env_test_guard();
        let (state, temp, token) = admin_test_state("generate-atomic").await;
        for (user, card) in [("INT_A", "C0FFEE11"), ("INT_B", "C0FFEE12")] {
            add_intern(&state, user, card).await;
            for at in ["2026-08-03T08:00:00+08:00", "2026-08-03T17:00:00+08:00"] {
                state.scan_debounce.lock().await.clear();
                let res = scan_rfid_at(None, &state, serde_json::json!({"rfidUid": card, "source": "RFID"}), manila(at)).await.unwrap();
                assert_eq!(res["success"], true, "{res}");
            }
        }
        let generate = || payroll_generate_cutoff_impl(&state, token.clone(), "2026-08-01".into(), "2026-08-15".into(), "Aug 1-15, 2026".into(), serde_json::json!({}));
        let drafts = || {
            let db = state.db.clone();
            async move {
                sqlx::query_scalar::<_, String>("SELECT payroll_id FROM payroll_cutoffs WHERE status='DRAFT' ORDER BY employee_id")
                    .fetch_all(&db).await.unwrap()
            }
        };
        generate().await.unwrap();
        let first = drafts().await;
        assert_eq!(first.len(), 2);

        // Regenerating replaces both drafts: the old ids are deleted on the sheet too.
        generate().await.unwrap();
        let second = drafts().await;
        assert_eq!(second.len(), 2);
        for old_id in &first {
            let queued: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_queue WHERE table_name='PayrollCutoffs' AND operation='DELETE' AND row_id=?")
                .bind(old_id).fetch_one(&state.db).await.unwrap();
            assert_eq!(queued, 1, "replaced draft {old_id} must be deleted on the sheet");
        }

        // A failure part-way keeps the previous drafts instead of half a set.
        sqlx::query("CREATE TRIGGER block_b BEFORE INSERT ON payroll_cutoffs WHEN NEW.employee_id='INT_B' BEGIN SELECT RAISE(ABORT, 'forced'); END")
            .execute(&state.db).await.unwrap();
        assert!(generate().await.is_err());
        assert_eq!(drafts().await, second);
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[tokio::test]
    async fn double_tap_racing_the_first_commit_is_a_repeat_tap() {
        // S5 (narrowed): the other tap's time-in commits between this tap's
        // lookup and its insert (simulated by a trigger inserting it first).
        let (state, temp, _token) = admin_test_state("double-tap").await;
        add_intern(&state, "INT_T", "C0FFEE15").await;
        sqlx::query("CREATE TRIGGER other_tap_first BEFORE INSERT ON attendance WHEN NEW.attendance_id <> 'att-other' BEGIN INSERT INTO attendance (attendance_id,attendance_date,user_id,rfid_uid,full_name,department,time_in,time_out,status,source,created_at,updated_at) VALUES ('att-other',NEW.attendance_date,NEW.user_id,NEW.rfid_uid,NEW.full_name,NEW.department,NEW.time_in,NULL,'WORKING','RFID',NEW.created_at,NEW.updated_at); END")
            .execute(&state.db).await.unwrap();
        let tap = serde_json::json!({"rfidUid": "C0FFEE15", "source": "RFID"});
        let res = scan_rfid_at(None, &state, tap, manila("2026-11-05T08:00:01+08:00")).await.unwrap();
        assert_eq!(res["error"]["code"], "DUPLICATE_SCAN", "{res}");
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[tokio::test]
    async fn scan_needs_a_minute_between_time_in_and_time_out() {
        let _env_guard = crate::config::dtr_env_test_guard();
        let (state, temp) = scan_test_state("C0FFEE01", "2026-11-05T09:00:00+08:00").await;
        let tap = serde_json::json!({"rfidUid": "C0FFEE01", "source": "RFID"});
        // A second tap 30 s after time-in is a double tap, not a time-out.
        let early = scan_rfid_at(None, &state, tap.clone(), manila("2026-11-05T09:00:30+08:00")).await.unwrap();
        assert_eq!(early["success"], false);
        assert_eq!(early["error"]["code"], "DUPLICATE_SCAN");
        let status: String = sqlx::query_scalar("SELECT status FROM attendance WHERE attendance_id='att-scan'")
            .fetch_one(&state.db).await.unwrap();
        assert_eq!(status, "WORKING");
        // Past the minute (the in-memory 10 s debounce is a separate guard).
        state.scan_debounce.lock().await.clear();
        let later = scan_rfid_at(None, &state, tap, manila("2026-11-05T09:01:01+08:00")).await.unwrap();
        assert_eq!(later["success"], true, "{later}");
        assert_eq!(later["action"], "TIME_OUT");
        let payroll: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM payroll WHERE attendance_id='att-scan'")
            .fetch_one(&state.db).await.unwrap();
        assert_eq!(payroll, 1, "a normal time-out still writes payroll");
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[tokio::test]
    async fn scan_records_unpriceable_time_out_as_late_without_payroll() {
        let _env_guard = crate::config::dtr_env_test_guard();
        // Time-in after 17:00: the 18:00+ time-out caps to 17:00, before the
        // time-in, so the engine cannot price the day.
        let (state, temp) = scan_test_state("C0FFEE02", "2026-11-05T17:30:00+08:00").await;
        let tap = serde_json::json!({"rfidUid": "C0FFEE02", "source": "RFID"});
        let res = scan_rfid_at(None, &state, tap, manila("2026-11-05T18:05:00+08:00")).await.unwrap();
        assert_eq!(res["success"], true, "{res}");
        assert_eq!(res["action"], "TIME_OUT");
        let row = sqlx::query("SELECT time_out, status FROM attendance WHERE attendance_id='att-scan'")
            .fetch_one(&state.db).await.unwrap();
        assert_eq!(row.get::<String, _>("status"), "LATE_TIMEOUT");
        assert!(row.get::<Option<String>, _>("time_out").is_some());
        let payroll: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM payroll WHERE attendance_id='att-scan'")
            .fetch_one(&state.db).await.unwrap();
        assert_eq!(payroll, 0, "pay is left to the admin correction");
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[tokio::test]
    async fn test_manual_test_dtr_guard() {
        let _env_guard = crate::config::dtr_env_test_guard();
        let temp = std::env::temp_dir().join(format!("alpha-manual-test-guard-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        let state = AppState::new(
            temp.clone(),
            temp.join("attendance.db"),
            temp.join("exports"),
            false,
            LanConfig::default(),
            OfficeConfig::default(),
            crate::config::ScannerConfig::default(),
            crate::config::TtsConfig::default(),
            crate::config::UpdaterConfig::default(),
        )
        .await
        .unwrap();

        upsert_user_record(
            &state.db, "INT_TEST_GUARD", "CARD_GUARD_01", "Guard Intern", Some("IT"),
            "ACTIVE", "INTERN", Some("MALE"), None, Some("BEA_STANDARD"),
            None, "EMPLOYEE", "2026-08-01T00:00:00Z",
        )
        .await
        .unwrap();

        let scan_input = serde_json::json!({
            "rfidUid": "CARD_GUARD_01",
            "source": "MANUAL_TEST"
        });
        let res = scan_rfid_impl(None, &state, scan_input).await.unwrap();
        assert_eq!(res["success"], true);

        let intern_dtr_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_queue WHERE table_name='InternDtr'")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(intern_dtr_count, 0, "MANUAL_TEST scans must never enqueue InternDtr");

        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[tokio::test]
    async fn intern_rfid_time_in_persists_intern_dtr_queue_row() {
        let _env_guard = crate::config::dtr_env_test_guard();
        let previous_sheet_id = std::env::var(crate::config::ENV_DTR_SHEET_ID).ok();
        let previous_enabled =
            std::env::var(crate::services::dtr_sync::ENV_DTR_SYNC_ENABLED).ok();
        std::env::set_var(crate::config::ENV_DTR_SHEET_ID, "test-dtr-sheet");
        std::env::set_var(crate::services::dtr_sync::ENV_DTR_SYNC_ENABLED, "1");
        let temp = std::env::temp_dir().join(format!("alpha-rfid-dtr-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        let state = AppState::new(
            temp.clone(),
            temp.join("attendance.db"),
            temp.join("exports"),
            false,
            LanConfig::default(),
            OfficeConfig::default(),
            crate::config::ScannerConfig::default(),
            crate::config::TtsConfig::default(),
            crate::config::UpdaterConfig::default(),
        )
        .await
        .unwrap();
        upsert_user_record(
            &state.db,
            "INT_RFID_DTR",
            "C0FFEE1234",
            "RFID DTR Intern",
            Some("QA"),
            "ACTIVE",
            "INTERN",
            Some("FEMALE"),
            None,
            Some("INTERN_STANDARD"),
            None,
            "EMPLOYEE",
            "2026-10-03T00:00:00Z",
        )
        .await
        .unwrap();

        let result = scan_rfid_impl(
            None,
            &state,
            serde_json::json!({"rfidUid":"C0FFEE1234", "source":"RFID"}),
        )
        .await
        .unwrap();
        assert_eq!(result["success"], true);
        assert_eq!(result["action"], "TIME_IN");
        let attendance_id = result["attendance"]["attendanceId"]
            .as_str()
            .expect("attendance id")
            .to_string();
        let queued = sqlx::query("SELECT operation, payload_json FROM sync_queue WHERE table_name='InternDtr' AND row_id=?")
            .bind(&attendance_id)
            .fetch_one(&state.db)
            .await
            .expect("intern DTR queue row");
        let payload: serde_json::Value =
            serde_json::from_str(&queued.get::<String, _>("payload_json")).unwrap();
        assert_eq!(queued.get::<String, _>("operation"), "UPSERT");
        assert_eq!(payload["userId"], "INT_RFID_DTR");
        assert_eq!(payload["fullName"], "RFID DTR Intern");
        assert_eq!(payload["timeIn"], result["attendance"]["timeIn"]);
        assert_eq!(payload["timeOut"], serde_json::Value::Null);

        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
        match previous_sheet_id {
            Some(value) => std::env::set_var(crate::config::ENV_DTR_SHEET_ID, value),
            None => std::env::remove_var(crate::config::ENV_DTR_SHEET_ID),
        }
        match previous_enabled {
            Some(value) => {
                std::env::set_var(crate::services::dtr_sync::ENV_DTR_SYNC_ENABLED, value)
            }
            None => std::env::remove_var(crate::services::dtr_sync::ENV_DTR_SYNC_ENABLED),
        }
    }

    #[tokio::test]
    async fn assisted_intern_time_in_persists_intern_dtr_queue_row() {
        let _env_guard = crate::config::dtr_env_test_guard();
        let previous_sheet_id = std::env::var(crate::config::ENV_DTR_SHEET_ID).ok();
        let previous_enabled =
            std::env::var(crate::services::dtr_sync::ENV_DTR_SYNC_ENABLED).ok();
        std::env::set_var(crate::config::ENV_DTR_SHEET_ID, "test-dtr-sheet");
        std::env::set_var(crate::services::dtr_sync::ENV_DTR_SYNC_ENABLED, "1");
        let temp = std::env::temp_dir().join(format!("alpha-assisted-dtr-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        let state = AppState::new(
            temp.clone(),
            temp.join("attendance.db"),
            temp.join("exports"),
            false,
            LanConfig::default(),
            OfficeConfig::default(),
            crate::config::ScannerConfig::default(),
            crate::config::TtsConfig::default(),
            crate::config::UpdaterConfig::default(),
        )
        .await
        .unwrap();
        upsert_user_record(
            &state.db,
            "ADMIN_ASSIST_DTR",
            "ADDE1234",
            "Desk Admin",
            Some("QA"),
            "ACTIVE",
            "EMPLOYEE",
            Some("MALE"),
            None,
            None,
            None,
            "ADMIN_ASSIST",
            "2026-10-03T00:00:00Z",
        )
        .await
        .unwrap();
        upsert_user_record(
            &state.db,
            "INT_ASSIST_DTR",
            "C0FFEE1235",
            "Assisted DTR Intern",
            Some("QA"),
            "ACTIVE",
            "INTERN",
            Some("FEMALE"),
            None,
            Some("INTERN_STANDARD"),
            None,
            "EMPLOYEE",
            "2026-10-03T00:00:00Z",
        )
        .await
        .unwrap();

        let result = scan_rfid_impl(
            None,
            &state,
            serde_json::json!({
                "rfidUid":"ADDE1234",
                "targetUserId":"INT_ASSIST_DTR",
                "reason":"Reader unavailable"
            }),
        )
        .await
        .unwrap();
        assert_eq!(result["success"], true);
        assert_eq!(result["action"], "TIME_IN");
        assert_eq!(result["attendance"]["source"], "ADMIN_ASSISTED_SCAN");
        let attendance_id = result["attendance"]["attendanceId"]
            .as_str()
            .expect("attendance id")
            .to_string();
        let queued = sqlx::query("SELECT operation, payload_json FROM sync_queue WHERE table_name='InternDtr' AND row_id=?")
            .bind(&attendance_id)
            .fetch_one(&state.db)
            .await
            .expect("intern DTR queue row");
        let payload: serde_json::Value =
            serde_json::from_str(&queued.get::<String, _>("payload_json")).unwrap();
        assert_eq!(queued.get::<String, _>("operation"), "UPSERT");
        assert_eq!(payload["userId"], "INT_ASSIST_DTR");
        assert_eq!(payload["fullName"], "Assisted DTR Intern");
        assert_eq!(payload["timeIn"], result["attendance"]["timeIn"]);
        assert_eq!(payload["timeOut"], serde_json::Value::Null);

        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
        match previous_sheet_id {
            Some(value) => std::env::set_var(crate::config::ENV_DTR_SHEET_ID, value),
            None => std::env::remove_var(crate::config::ENV_DTR_SHEET_ID),
        }
        match previous_enabled {
            Some(value) => {
                std::env::set_var(crate::services::dtr_sync::ENV_DTR_SYNC_ENABLED, value)
            }
            None => std::env::remove_var(crate::services::dtr_sync::ENV_DTR_SYNC_ENABLED),
        }
    }
}
