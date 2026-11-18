use chrono::Datelike;
use chrono_tz::Asia::Manila;
use crate::state::AppState;
use sqlx::Row;
use super::session::admin_authorized;
use super::sync::enqueue_sync_on;
use tauri::Emitter;
use tauri::State;

#[tauri::command]
pub(crate) async fn get_attendance(
    state: State<'_, AppState>,
    date: Option<String>,
) -> Result<serde_json::Value, String> {
    let selected = date.unwrap_or_else(|| {
        chrono::Utc::now()
            .with_timezone(&Manila)
            .date_naive()
            .to_string()
    });
    let attendance = attendance_rows_json(&state.db, &selected).await?;
    Ok(serde_json::json!({"success":true,"date":selected,"attendance":attendance,"fetchedAt":chrono::Utc::now()}))
}

#[tauri::command]
pub(crate) async fn admin_attendance(
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
    let attendance = attendance_rows_json(&state.db, &date).await?;
    Ok(
        serde_json::json!({"success":true,"date":date,"attendance":attendance,"fetchedAt":chrono::Utc::now()}),
    )
}

/// One day's attendance rows for the admin list. Arrival status is the payroll
/// engine's: a priced day uses its stored grace decision, an open day the
/// weekly claim it could still take.
pub(crate) async fn attendance_rows_json(
    db: &sqlx::SqlitePool,
    date: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let rows = sqlx::query(
        "SELECT a.attendance_id, a.attendance_date, a.user_id, a.full_name, a.department, a.time_in, a.time_out, a.status, a.source, a.recorded_by, a.recorded_reason, a.recorded_at, \
         COALESCE(p.grace_used = 1, NOT EXISTS (SELECT 1 FROM intern_grace g WHERE g.user_id = a.user_id AND g.week_start = ? AND g.attendance_id != a.attendance_id)) AS grace_available \
         FROM attendance a LEFT JOIN payroll p ON p.attendance_id = a.attendance_id \
         WHERE a.attendance_date = ? ORDER BY a.time_in, a.full_name",
    )
    .bind(manila_week_start(date))
    .bind(date)
    .fetch_all(db)
    .await
    .map_err(|e| e.to_string())?;
    let attendance = rows.into_iter().map(|row| {
        let shown = arrival_fields(date, row.get::<Option<String>, _>("time_in").as_deref(), row.get::<bool, _>("grace_available"));
        serde_json::json!({
        "arrivalStatus": shown.status,
        "minutesLate": shown.minutes_late,
        "graceUsed": shown.grace_used,
        "payableTimeIn": shown.payable_time_in,
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
    })}).collect::<Vec<_>>();
    Ok(attendance)
}

#[tauri::command]
pub(crate) async fn admin_list_attendance(
    state: State<'_, AppState>,
    token: String,
    date: String,
) -> Result<serde_json::Value, String> {
    admin_attendance(state, token, date).await
}

#[tauri::command]
pub(crate) async fn admin_update_attendance(
    state: State<'_, AppState>,
    token: String,
    attendance_id: String,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    admin_update_attendance_impl(&state, &token, &attendance_id, &payload).await
}

/// A day inside one of the person's FINALIZED cutoffs is approved pay: no
/// admin create, edit or delete may change it (owner decision D2,
/// 2026-11-06). Kiosk scans are not blocked.
pub(crate) async fn day_in_finalized_cutoff<'c, E>(executor: E, user_id: &str, date: &str) -> Result<bool, String>
where
    E: sqlx::Executor<'c, Database = sqlx::Sqlite>,
{
    sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM payroll_cutoffs WHERE employee_id = ? AND status = 'FINALIZED' AND ? >= cutoff_start AND ? <= cutoff_end",
    )
    .bind(user_id)
    .bind(date)
    .bind(date)
    .fetch_one(executor)
    .await
    .map(|count| count > 0)
    .map_err(|e| e.to_string())
}

pub(crate) async fn admin_update_attendance_impl(
    state: &AppState,
    token: &str,
    attendance_id: &str,
    payload: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(state, token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let row = sqlx::query(
        "SELECT user_id,attendance_date,time_in,time_out,status,revision FROM attendance WHERE attendance_id=?",
    )
    .bind(&attendance_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "ATTENDANCE_NOT_FOUND".to_string())?;
    let current_date: &str = row.get("attendance_date");
    let current_in: Option<String> = row.get("time_in");
    let current_out: Option<String> = row.get("time_out");
    // P0 partial-update COALESCE: an ABSENT payload field keeps the stored
    // value (live data-loss 2026-09-05: timeOut-only payload wiped time_in
    // when bare Options were bound into the UPDATE). An EXPLICIT null
    // clears the field, so admins can remove an inaccurate tap-out from
    // corrections; the cleared row re-pushes to the intern DTR as WORKING.
    let date: &str = payload
        .get("attendanceDate")
        .and_then(|v| v.as_str())
        .unwrap_or(current_date);
    let time_in: Option<&str> = match payload.get("timeIn") {
        None => current_in.as_deref(),
        Some(serde_json::Value::Null) => None,
        Some(v) => v.as_str().or(current_in.as_deref()),
    };
    let time_out: Option<&str> = match payload.get("timeOut") {
        None => current_out.as_deref(),
        Some(serde_json::Value::Null) => None,
        Some(v) => v.as_str().or(current_out.as_deref()),
    };
    if chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err()
        || time_in.is_some_and(|value| chrono::DateTime::parse_from_rfc3339(value).is_err())
        || time_out.is_some_and(|value| chrono::DateTime::parse_from_rfc3339(value).is_err())
    {
        return Err("ADMIN_VALIDATION_ERROR".into());
    }
    // Same absent/null split as the values: an explicit null expectation
    // means "it was empty when I loaded it" and must conflict once a scan
    // has filled it, never fall back to the fresh stored value.
    let expected_in: Option<&str> = match payload.get("expectedTimeIn") {
        None => current_in.as_deref(),
        Some(serde_json::Value::Null) => None,
        Some(v) => v.as_str().or(current_in.as_deref()),
    };
    let expected_out: Option<&str> = match payload.get("expectedTimeOut") {
        None => current_out.as_deref(),
        Some(serde_json::Value::Null) => None,
        Some(v) => v.as_str().or(current_out.as_deref()),
    };
    // No-op guard: resolved values identical and no conflicting expectation
    // => return current state without bumping revision or re-enqueueing.
    if date == current_date
        && time_in == current_in.as_deref()
        && time_out == current_out.as_deref()
        && expected_in == current_in.as_deref()
        && expected_out == current_out.as_deref()
    {
        let current_status: String = row.get("status");
        return Ok(
            serde_json::json!({"success":true,"attendanceId":attendance_id,"attendanceDate":date,"timeIn":time_in,"timeOut":time_out,"status":current_status}),
        );
    }
    // A correction keeps a time-in (owner decision D7): without one the day
    // turned MISSED and the scan refused the person for the rest of it. To
    // remove a day, delete the record.
    if time_in.is_none() {
        return Err("ATTENDANCE_TIME_IN_REQUIRED".into());
    }
    // The office does not allow overtime: an admin-saved time-out after
    // office hours stays flagged LATE_TIMEOUT instead of COMPLETED until the
    // official time is re-entered.
    let late = time_out.is_some_and(|value| crate::services::office_hours::is_late_timeout(value));
    let status = match (time_out.is_some(), late) {
        (true, true) => "LATE_TIMEOUT",
        (true, false) => "COMPLETED",
        (false, _) => "WORKING",
    };
    let now = chrono::Utc::now().to_rfc3339();
    // One transaction: attendance update + payroll/grace rebuild commit together.
    // Sync/audit side effects run only after commit.
    let mut tx = state.db.begin().await.map_err(|e| e.to_string())?;
    // Neither the day it is on nor the day it moves to may be approved pay.
    let owner: &str = row.get("user_id");
    if day_in_finalized_cutoff(&mut *tx, owner, current_date).await?
        || day_in_finalized_cutoff(&mut *tx, owner, date).await?
    {
        return Err("ATTENDANCE_IN_FINALIZED_CUTOFF".into());
    }
    let updated = sqlx::query("UPDATE attendance SET attendance_date=?,time_in=?,time_out=?,status=?,revision=revision+1,updated_at=? WHERE attendance_id=? AND time_in IS ? AND time_out IS ? AND revision=?")
        .bind(date).bind(time_in).bind(time_out).bind(status).bind(&now).bind(attendance_id).bind(expected_in).bind(expected_out).bind(row.get::<i64,_>("revision")).execute(&mut *tx).await.map_err(|e|e.to_string())?;
    if updated.rows_affected() != 1 {
        return Err("ATTENDANCE_CONFLICT".into());
    }
    // Capture cascaded rows before the hard delete so their Sheets rows are removed too.
    let payroll_ids: Vec<String> =
        sqlx::query("SELECT payroll_id FROM payroll WHERE attendance_id=?")
            .bind(&attendance_id)
            .fetch_all(&mut *tx)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|row| row.get::<String, _>("payroll_id"))
            .collect();
    let grace_rows: Vec<(String, String)> =
        sqlx::query("SELECT grace_id, user_id FROM intern_grace WHERE attendance_id=?")
            .bind(&attendance_id)
            .fetch_all(&mut *tx)
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
    sqlx::query("DELETE FROM payroll WHERE attendance_id=?")
        .bind(&attendance_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM intern_grace WHERE attendance_id=?")
        .bind(&attendance_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    let mut pending: Vec<PendingSync> = Vec::new();
    for payroll_id in payroll_ids {
        let payload = serde_json::json!({"payrollId":payroll_id,"attendanceId":attendance_id});
        pending.push(("Payroll", payroll_id, "DELETE", payload));
    }
    for (grace_id, user_id) in grace_rows {
        let payload = serde_json::json!({"userId":user_id,"attendanceId":attendance_id,"graceId":grace_id});
        pending.push(("InternGrace", user_id, "DELETE", payload));
    }
    // LATE_TIMEOUT still pays: the engines cap the clock-out to 17:00
    // (cap_late_timeout_out) before any math, so the day is a full capped shift.
    if status == "COMPLETED" || status == "LATE_TIMEOUT" {
        if let (Some(actual_in), Some(actual_out)) = (time_in, time_out) {
            if let Some(user_row) = sqlx::query("SELECT user_id,full_name FROM users WHERE user_id=(SELECT user_id FROM attendance WHERE attendance_id=? LIMIT 1)").bind(&attendance_id).fetch_optional(&mut *tx).await.map_err(|e| e.to_string())? {
                pending.extend(ensure_payroll_tx(&mut tx, &attendance_id, user_row.get("user_id"), user_row.get("full_name"), date, actual_in, actual_out).await?);
            }
        }
    }
    // Queue rows commit with the correction (O4).
    flush_pending_sync(state, &mut tx, pending).await;
    enqueue_sync_on(state, &mut tx, "Attendance", attendance_id, "UPSERT", &serde_json::json!({"attendanceId":attendance_id,"attendanceDate":date,"timeIn":time_in,"timeOut":time_out,"status":status})).await;
    // Mirror the correction to the intern DTR sheet: the idempotent re-push
    // rewrites the same tab row (half-day/working/full tiers + paint), so
    // corrections converge with no duplicates. Lookup failure skips silently;
    // admin ops never fail because of DTR.
    if let Ok(Some(user_row)) = sqlx::query("SELECT user_id, full_name, employee_type FROM users WHERE user_id=(SELECT user_id FROM attendance WHERE attendance_id=? LIMIT 1)").bind(attendance_id).fetch_optional(&mut *tx).await {
        let owner: String = user_row.get("user_id");
        let full_name: String = user_row.get("full_name");
        let employee_type: String = user_row.get("employee_type");
        enqueue_intern_dtr(state, &mut tx, attendance_id, &owner, &full_name, &employee_type, date, time_in, time_out).await;
        enqueue_later_weekly_intern_dtr(state, &mut tx, &owner, &full_name, &employee_type, date).await;
        // The day moved to another date: the UPSERT only writes the new
        // date, so clear the old date's cells and replan the old week (S6).
        // Its own row id keeps it from superseding the day's UPSERT.
        if date != current_date
            && employee_type.to_uppercase() == "INTERN"
            && crate::config::dtr_spreadsheet_id_resolved(&state.lan).is_some()
        {
            enqueue_sync_on(
                state,
                &mut tx,
                crate::services::dtr_sync::DTR_TABLE_NAME,
                &format!("{attendance_id}@{current_date}"),
                "DELETE",
                &serde_json::json!({"userId": owner, "fullName": full_name, "attendanceDate": current_date}),
            )
            .await;
            enqueue_later_weekly_intern_dtr(state, &mut tx, &owner, &full_name, &employee_type, current_date).await;
        }
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    publish_attendance_change(state, attendance_id, date, "ADMIN_CORRECTION", "upsert");
    let _ = sqlx::query("INSERT INTO audit_logs (log_id,timestamp,event_type,message,request_id) VALUES (?,?, 'ADMIN_ATTENDANCE_UPDATED',?,?)").bind(uuid::Uuid::new_v4().to_string()).bind(&now).bind(format!("Attendance {attendance_id} corrected")).bind(format!("admin-{}",uuid::Uuid::new_v4())).execute(&state.db).await;
    Ok(
        serde_json::json!({"success":true,"attendanceId":attendance_id,"attendanceDate":date,"timeIn":time_in,"timeOut":time_out,"status":status}),
    )
}

pub(crate) async fn admin_create_backdated_attendance_impl(
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

    if day_in_finalized_cutoff(&state.db, user_id, attendance_date).await? {
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

    // Attendance insert + payroll commit together; sync side effects run after commit.
    let mut tx = state.db.begin().await.map_err(|e| e.to_string())?;
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
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

    // LATE_TIMEOUT still pays: the engines cap the clock-out to 17:00
    // (cap_late_timeout_out) before any math, so the day is a full capped shift.
    let mut pending: Vec<PendingSync> = Vec::new();
    if status == "COMPLETED" || status == "LATE_TIMEOUT" {
        if let Some(actual_out) = time_out {
            pending = ensure_payroll_tx(
                &mut tx,
                &attendance_id,
                user_id,
                full_name.clone(),
                attendance_date,
                time_in,
                actual_out,
            )
            .await?;
        }
    }
    // Queue rows commit with the entry (O4).
    flush_pending_sync(state, &mut tx, pending).await;
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
    enqueue_sync_on(state, &mut tx, "Attendance", &attendance_id, "UPSERT", &sync_payload).await;
    // Mirror the entry to the intern DTR sheet (interns only, when
    // configured). Same fire-and-forget contract as the scan path.
    let employee_type: String = user.get("employee_type");
    enqueue_intern_dtr(state, &mut tx, &attendance_id, user_id, &full_name, &employee_type, attendance_date, Some(time_in), time_out).await;
    enqueue_later_weekly_intern_dtr(state, &mut tx, user_id, &full_name, &employee_type, attendance_date).await;
    tx.commit().await.map_err(|e| e.to_string())?;
    publish_attendance_change(state, &attendance_id, attendance_date, "BACKDATED_ATTENDANCE", "upsert");

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

    let shown = attendance_arrival(&state.db, user_id, &attendance_id, attendance_date, Some(time_in)).await;
    Ok(serde_json::json!({
        "success": true,
        "attendance": {
            "attendanceId": attendance_id,
            "attendanceDate": attendance_date,
            "userId": user_id,
            "fullName": full_name,
            "department": department,
            "arrivalStatus": shown.status,
            "minutesLate": shown.minutes_late,
            "graceUsed": shown.grace_used,
            "payableTimeIn": shown.payable_time_in,
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
pub(crate) async fn admin_create_backdated_attendance(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    token: String,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    admin_create_backdated_attendance_impl(Some(&app), &state, &token, &payload).await
}

#[tauri::command]
pub(crate) async fn admin_delete_attendance(
    state: State<'_, AppState>,
    token: String,
    attendance_id: String,
    date: String,
) -> Result<serde_json::Value, String> {
    admin_delete_attendance_impl(&state, &token, &attendance_id, &date).await
}

pub(crate) async fn admin_delete_attendance_impl(
    state: &AppState,
    token: &str,
    attendance_id: &str,
    date: &str,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(state, token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    // Capture cascaded rows before the hard delete so their Sheets rows are removed too.
    // NOTE: deletions clear the date's B:E cells on the intern DTR sheet
    // (values only — rows are never removed, so the template grid
    // survives); only the ops-mirror rows below are deleted outright.
    // Reads happen inside the delete's transaction: a time-out committing
    // between a read and the delete used to lose its payroll row without a
    // Sheets DELETE being queued for it.
    let mut tx = state.db.begin().await.map_err(|e| e.to_string())?;
    let dtr_owner: Option<(String, String, String)> = sqlx::query_as(
        "SELECT attendance.user_id, attendance.full_name, users.employee_type FROM attendance JOIN users ON users.user_id = attendance.user_id WHERE attendance.attendance_id=?",
    )
    .bind(attendance_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    let payroll_ids: Vec<String> =
        sqlx::query("SELECT payroll_id FROM payroll WHERE attendance_id=?")
            .bind(attendance_id)
            .fetch_all(&mut *tx)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|row| row.get::<String, _>("payroll_id"))
            .collect();
    let grace_rows: Vec<(String, String)> =
        sqlx::query("SELECT grace_id, user_id FROM intern_grace WHERE attendance_id=?")
            .bind(attendance_id)
            .fetch_all(&mut *tx)
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
    let owner: Option<String> = sqlx::query_scalar("SELECT user_id FROM attendance WHERE attendance_id=?")
        .bind(attendance_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(owner) = owner {
        if day_in_finalized_cutoff(&mut *tx, &owner, date).await? {
            return Err("ATTENDANCE_IN_FINALIZED_CUTOFF".into());
        }
    }
    let result = sqlx::query("DELETE FROM attendance WHERE attendance_id=? AND attendance_date=?")
        .bind(attendance_id)
        .bind(date)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    if result.rows_affected() != 1 {
        return Err("ATTENDANCE_NOT_FOUND".into());
    }
    sqlx::query("DELETE FROM payroll WHERE attendance_id=?")
        .bind(attendance_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM intern_grace WHERE attendance_id=?")
        .bind(attendance_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    // Queue rows commit with the delete (O4).
    enqueue_sync_on(
        state,
        &mut tx,
        "Attendance",
        attendance_id,
        "DELETE",
        &serde_json::json!({"attendanceId":attendance_id,"attendanceDate":date}),
    )
    .await;
    // Intern-DTR auto-clear for the deleted day (values emptied, row kept).
    // Missing tab/row downstream is a silent no-op; failures never fail admin.
    if let Some((dtr_user_id, dtr_full_name, employee_type)) = dtr_owner {
        enqueue_sync_on(
            state,
            &mut tx,
            crate::services::dtr_sync::DTR_TABLE_NAME,
            attendance_id,
            "DELETE",
            &serde_json::json!({"userId": dtr_user_id, "fullName": dtr_full_name, "attendanceDate": date}),
        )
        .await;
        enqueue_later_weekly_intern_dtr(state, &mut tx, &dtr_user_id, &dtr_full_name, &employee_type, date).await;
    }
    for payroll_id in payroll_ids {
        enqueue_sync_on(
            state,
            &mut tx,
            "Payroll",
            &payroll_id,
            "DELETE",
            &serde_json::json!({"payrollId":payroll_id,"attendanceId":attendance_id}),
        )
        .await;
    }
    for (grace_id, user_id) in grace_rows {
        enqueue_sync_on(
            state,
            &mut tx,
            "InternGrace",
            &user_id,
            "DELETE",
            &serde_json::json!({"userId":user_id,"attendanceId":attendance_id,"graceId":grace_id}),
        )
        .await;
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    publish_attendance_change(state, attendance_id, date, "ADMIN_DELETE", "delete");
    Ok(serde_json::json!({"success":true,"attendanceId":attendance_id}))
}

/// Tell open LAN viewers that an attendance day changed; they refetch.
/// Only scans used to publish, so admin changes reached viewers only on a
/// manual refresh (O11).
pub(crate) fn publish_attendance_change(state: &AppState, attendance_id: &str, attendance_date: &str, cause: &str, mutation: &str) {
    let seq = state.next_sequence();
    let _ = state
        .bus
        .sender
        .send(crate::lan_server::LanAttendanceEvent::AttendanceUpdated {
            event_id: format!("{}:{}", state.server_instance_id, seq),
            server_instance_id: state.server_instance_id.to_string(),
            sequence: seq,
            occurred_at: chrono::Utc::now(),
            request_id: format!("admin-{}", uuid::Uuid::new_v4()),
            attendance_date: attendance_date.to_string(),
            attendance_id: attendance_id.to_string(),
            cause: cause.to_string(),
            mutation: mutation.to_string(),
            attendance: None,
        });
}

/// Mirror an attendance mutation to the intern DTR sheet (enqueue-only).
/// Same contract as the scan path: interns-only, configured-only,
/// fire-and-forget — a DTR failure can never fail the caller. Corrections
/// converge through the existing idempotent re-push; deletes clear the
/// date's cells via a separate InternDtr DELETE row (rows are never
/// removed from the sheet).
pub(crate) async fn enqueue_intern_dtr(
    state: &AppState,
    conn: &mut sqlx::SqliteConnection,
    attendance_id: &str,
    user_id: &str,
    full_name: &str,
    employee_type: &str,
    date: &str,
    time_in: Option<&str>,
    time_out: Option<&str>,
) {
    // Queued even while upload is switched off (owner decision D5): the
    // sync tick leaves InternDtr rows waiting until it is switched back on.
    if employee_type.to_uppercase() != "INTERN"
        || crate::config::dtr_spreadsheet_id_resolved(&state.lan).is_none()
    {
        return;
    }
    enqueue_sync_on(
        state,
        conn,
        crate::services::dtr_sync::DTR_TABLE_NAME,
        attendance_id,
        "UPSERT",
        &serde_json::json!({
            "userId": user_id,
            "fullName": full_name,
            "attendanceDate": date,
            "timeIn": time_in,
            "timeOut": time_out,
        }),
    )
    .await;
}

pub(crate) async fn enqueue_later_weekly_intern_dtr(
    state: &AppState,
    conn: &mut sqlx::SqliteConnection,
    user_id: &str,
    full_name: &str,
    employee_type: &str,
    changed_date: &str,
) {
    let Ok(rows) = crate::services::dtr_sync::later_attendance_in_manila_week(
        &mut *conn,
        user_id,
        changed_date,
    )
    .await
    else {
        return;
    };
    for (attendance_id, date, time_in, time_out) in rows {
        enqueue_intern_dtr(
            state,
            &mut *conn,
            &attendance_id,
            user_id,
            full_name,
            employee_type,
            &date,
            time_in.as_deref(),
            time_out.as_deref(),
        )
        .await;
    }
}

/// Sync rows (table, row id, operation, payload) produced inside a transaction;
/// flush them with `flush_pending_sync` on that same transaction before it
/// commits, so they commit together (O4).
pub(crate) type PendingSync = (&'static str, String, &'static str, serde_json::Value);

pub(crate) async fn flush_pending_sync(
    state: &AppState,
    conn: &mut sqlx::SqliteConnection,
    pending: Vec<PendingSync>,
) {
    for (table, row_id, operation, payload) in pending {
        enqueue_sync_on(state, &mut *conn, table, &row_id, operation, &payload).await;
    }
}

/// Monday (`YYYY-MM-DD`) of the Manila week of `date`: the key of a weekly
/// grace claim. An unreadable date maps to itself, which matches no claim.
pub(crate) fn manila_week_start(date: &str) -> String {
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map(|day| (day - chrono::Duration::days(day.weekday().num_days_from_monday() as i64)).to_string())
        .unwrap_or_else(|_| date.to_string())
}

/// What every attendance row says about its arrival. The payroll engine decides all four; the screens only show them.
pub(crate) struct ArrivalFields {
    pub(crate) status: Option<&'static str>,
    pub(crate) minutes_late: Option<i64>,
    /// The arrival took the week's grace claim. `None` for a row without a readable time-in.
    pub(crate) grace_used: Option<bool>,
    /// The time-in the day is paid from: the scan itself, or the next full hour when the day's policy clamps it.
    pub(crate) payable_time_in: Option<String>,
}

pub(crate) fn arrival_fields(date: &str, time_in: Option<&str>, grace_available: bool) -> ArrivalFields {
    let arrival = time_in.and_then(|stamp| crate::services::intern_payroll::arrival(date, stamp, grace_available));
    ArrivalFields {
        status: arrival.map(|a| a.status.as_str()),
        minutes_late: arrival.map(|a| a.minutes_late),
        grace_used: arrival.map(|a| a.status == crate::services::intern_payroll::ArrivalStatus::GracePeriod),
        payable_time_in: time_in.and_then(|stamp| crate::services::intern_payroll::payable_time_in(date, stamp, grace_available)),
    }
}

/// Arrival fields of one attendance row, as the payroll engine decides them
/// (same rule as `attendance_rows_json`).
pub(crate) async fn attendance_arrival(
    db: &sqlx::SqlitePool,
    user_id: &str,
    attendance_id: &str,
    date: &str,
    time_in: Option<&str>,
) -> ArrivalFields {
    let grace_available: Option<bool> = sqlx::query_scalar(
        "SELECT COALESCE((SELECT grace_used = 1 FROM payroll WHERE attendance_id = ?), \
         NOT EXISTS (SELECT 1 FROM intern_grace WHERE user_id = ? AND week_start = ? AND attendance_id != ?))",
    )
    .bind(attendance_id)
    .bind(user_id)
    .bind(manila_week_start(date))
    .bind(attendance_id)
    .fetch_one(db)
    .await
    .ok();
    match grace_available {
        Some(grace_available) => arrival_fields(date, time_in, grace_available),
        None => arrival_fields(date, None, false),
    }
}

/// Atomic wrapper: grace claim + payroll upsert commit together or not at all.
pub(crate) async fn ensure_payroll(
    state: &AppState,
    attendance_id: &str,
    user_id: &str,
    full_name: String,
    date: &str,
    actual_in: &str,
    actual_out: &str,
) -> Result<(), String> {
    let mut tx = state.db.begin().await.map_err(|e| e.to_string())?;
    let pending = ensure_payroll_tx(&mut tx, attendance_id, user_id, full_name, date, actual_in, actual_out).await?;
    flush_pending_sync(state, &mut tx, pending).await;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Runs entirely on the caller's connection/transaction (never touches the pool).
pub(crate) async fn ensure_payroll_tx(
    conn: &mut sqlx::SqliteConnection,
    attendance_id: &str,
    user_id: &str,
    full_name: String,
    date: &str,
    actual_in: &str,
    actual_out: &str,
) -> Result<Vec<PendingSync>, String> {
    let mut pending: Vec<PendingSync> = Vec::new();
    let (computed_in, computed_out, grace_used, late_hours, deduction, is_half_day, half_day_deduction, base_pay, daily_pay) = {
        let date_value =
            chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|e| e.to_string())?;
        let week_start = date_value
            - chrono::Duration::days(date_value.weekday().num_days_from_monday() as i64);
        let no_grace_cutover = crate::services::intern_payroll::policy_for_date(date).rules().weekly_grace_window_minutes.is_none();
        // Post-cutover skips grace-claim INSERT/DELETE, preserving pre-cutover history.
        let grace_available = if no_grace_cutover {
            false
        } else {
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM intern_grace WHERE user_id=? AND week_start=? AND attendance_id != ?",
            )
            .bind(user_id)
            .bind(week_start.to_string())
            .bind(attendance_id)
            .fetch_one(&mut *conn)
            .await
            .map_err(|e| e.to_string())?
                == 0
        };
        let mut result = crate::services::intern_payroll::calculate(
            date,
            actual_in,
            actual_out,
            grace_available,
        )?;
        if result.grace_used && !no_grace_cutover {
            let grace_id = uuid::Uuid::new_v4().to_string();
            let used_at = chrono::Utc::now().to_rfc3339();
            let inserted = sqlx::query("INSERT OR IGNORE INTO intern_grace (grace_id,user_id,week_start,attendance_id,used_at) VALUES (?,?,?,?,?)").bind(&grace_id).bind(user_id).bind(week_start.to_string()).bind(attendance_id).bind(&used_at).execute(&mut *conn).await.map_err(|e| e.to_string())?.rows_affected() == 1;
            if inserted {
                pending.push(("InternGrace", grace_id.clone(), "UPSERT", serde_json::json!({"graceId":grace_id,"userId":user_id,"weekStart":week_start.to_string(),"attendanceId":attendance_id,"usedAt":used_at})));
            } else {
                let own_claim: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM intern_grace WHERE user_id=? AND week_start=? AND attendance_id=?",
                )
                .bind(user_id)
                .bind(week_start.to_string())
                .bind(attendance_id)
                .fetch_one(&mut *conn)
                .await
                .map_err(|e| e.to_string())?;
                if own_claim == 0 {
                    result = crate::services::intern_payroll::calculate(
                date,
                actual_in,
                actual_out,
                        false,
                    )?;
                }
            }
        } else if !no_grace_cutover {
            sqlx::query("DELETE FROM intern_grace WHERE attendance_id=?")
                .bind(attendance_id)
                .execute(&mut *conn)
                .await
                .map_err(|e| e.to_string())?;
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
    sqlx::query(
        "INSERT INTO payroll (payroll_id,attendance_id,user_id,full_name,employee_type,attendance_date,actual_time_in,actual_time_out,computed_time_in,computed_time_out,grace_used,late_hours,late_deduction_centavos,base_pay_centavos,daily_pay_centavos,is_half_day,half_day_deduction_centavos,created_at,updated_at,policy_version) \
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) \
         ON CONFLICT(attendance_id) DO UPDATE SET \
           user_id=excluded.user_id, \
           full_name=excluded.full_name, \
           employee_type=excluded.employee_type, \
           attendance_date=excluded.attendance_date, \
           actual_time_in=excluded.actual_time_in, \
           actual_time_out=excluded.actual_time_out, \
           computed_time_in=excluded.computed_time_in, \
           computed_time_out=excluded.computed_time_out, \
           grace_used=excluded.grace_used, \
           late_hours=excluded.late_hours, \
           late_deduction_centavos=excluded.late_deduction_centavos, \
           base_pay_centavos=excluded.base_pay_centavos, \
           daily_pay_centavos=excluded.daily_pay_centavos, \
           is_half_day=excluded.is_half_day, \
           half_day_deduction_centavos=excluded.half_day_deduction_centavos, \
           updated_at=excluded.updated_at, \
           policy_version=excluded.policy_version",
    )
    .bind(&payroll_id).bind(attendance_id).bind(user_id).bind(&full_name).bind("INTERN").bind(date).bind(actual_in).bind(actual_out).bind(&computed_in).bind(&computed_out).bind(grace_used.map(|v| if v {1} else {0})).bind(late_hours).bind(deduction).bind(base_pay).bind(daily_pay).bind(if is_half_day { 1 } else { 0 }).bind(half_day_deduction).bind(&now).bind(&now).bind(crate::services::intern_payroll::policy_for_date(date).as_str())
    .execute(&mut *conn).await.map_err(|e| e.to_string())?;

    let effective_payroll_id: String = sqlx::query_scalar(
        "SELECT payroll_id FROM payroll WHERE attendance_id=?"
    )
    .bind(attendance_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;

    pending.push(("Payroll", effective_payroll_id.clone(), "UPSERT", serde_json::json!({"payrollId":effective_payroll_id,"attendanceId":attendance_id,"userId":user_id,"employeeType":"INTERN","attendanceDate":date,"actualTimeIn":actual_in,"actualTimeOut":actual_out,"computedTimeIn":computed_in,"computedTimeOut":computed_out,"lateHours":late_hours,"lateDeductionCentavos":deduction,"isHalfDay":is_half_day,"halfDayDeductionCentavos":half_day_deduction,"dailyPayCentavos":daily_pay})));
    Ok(pending)
}

pub(crate) async fn reconcile_attendance_payroll_range(
    state: &AppState,
    start_date: &str,
    end_date: &str,
    excluded_employee_ids: &std::collections::HashSet<String>,
) -> Result<Vec<String>, String> {
    let rows = sqlx::query(
        "SELECT a.attendance_id, a.attendance_date, a.user_id, a.full_name, \
         COALESCE(u.employee_type, 'INTERN') AS employee_type, \
         u.daily_rate_centavos, a.time_in, a.time_out \
         FROM attendance a \
         LEFT JOIN users u ON u.user_id = a.user_id \
         WHERE a.attendance_date >= ? AND a.attendance_date <= ? \
           AND a.status IN ('COMPLETED', 'LATE_TIMEOUT') \
           AND a.time_in IS NOT NULL \
           AND a.time_out IS NOT NULL \
         ORDER BY a.attendance_date ASC, a.time_in ASC",
    )
    .bind(start_date)
    .bind(end_date)
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    // Days inside any finalized cutoff are frozen, even when this range only overlaps it.
    let frozen: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT employee_id, cutoff_start, cutoff_end FROM payroll_cutoffs 
         WHERE status='FINALIZED' AND cutoff_end >= ? AND cutoff_start <= ?",
    )
    .bind(start_date)
    .bind(end_date)
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    // One unpayable row must not block everyone else; report it instead.
    let mut warnings: Vec<String> = Vec::new();

    for row in rows {
        let attendance_id: String = row.get("attendance_id");
        let user_id: String = row.get("user_id");
        if excluded_employee_ids.contains(&user_id) {
            continue;
        }
        let full_name: String = row.get("full_name");
        let date: String = row.get("attendance_date");
        if frozen
            .iter()
            .any(|(id, from, to)| *id == user_id && from.as_str() <= date.as_str() && date.as_str() <= to.as_str())
        {
            continue;
        }
        let actual_in: String = row.get("time_in");
        let actual_out: String = row.get("time_out");

        if let Err(error) = ensure_payroll(
            state,
            &attendance_id,
            &user_id,
            full_name.clone(),
            &date,
            &actual_in,
            &actual_out,
        )
        .await
        {
            log::warn!("payroll skipped for {full_name} on {date}: {error}");
            warnings.push(format!("{full_name} {date}: {error}"));
        }
    }

    let _ = sqlx::query(
        "DELETE FROM payroll \
         WHERE attendance_date >= ? AND attendance_date <= ? \
           AND user_id NOT IN (SELECT employee_id FROM payroll_cutoffs WHERE cutoff_start=? AND cutoff_end=? AND status='FINALIZED') \
           AND attendance_id NOT IN ( \
             SELECT attendance_id FROM attendance \
             WHERE attendance_date >= ? AND attendance_date <= ? \
               AND status IN ('COMPLETED', 'LATE_TIMEOUT') \
               AND time_in IS NOT NULL \
               AND time_out IS NOT NULL \
           )",
    )
    .bind(start_date)
    .bind(end_date)
    .bind(start_date)
    .bind(end_date)
    .bind(start_date)
    .bind(end_date)
    .execute(&state.db)
    .await;

    Ok(warnings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::*;
    use crate::commands::session::setup_unlock_impl;
    use crate::services::users::delete_user_and_cascade;
    use crate::services::users::upsert_user_record;
    

    /// The boundary pin: `shared/arrival-fixtures.json` holds rows as this crate answers them, and the client has a
    /// test that shows the same `expected` objects. A change to a field name or to the rule fails here or there.
    #[test]
    fn arrival_fields_match_the_fixture_the_client_renders() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!("../../../shared/arrival-fixtures.json")).unwrap();
        let rows = fixture["rows"].as_array().unwrap();
        assert!(rows.len() >= 8);
        for row in rows {
            let input = &row["input"];
            let shown = arrival_fields(
                input["attendanceDate"].as_str().unwrap(),
                input["timeIn"].as_str(),
                input["graceAvailable"].as_bool().unwrap(),
            );
            let answered = serde_json::json!({
                "arrivalStatus": shown.status,
                "minutesLate": shown.minutes_late,
                "graceUsed": shown.grace_used,
                "payableTimeIn": shown.payable_time_in,
            });
            assert_eq!(answered, row["expected"], "{}", row["name"]);
        }
    }

    #[tokio::test]
    async fn finalized_cutoff_freezes_its_days_and_outlives_the_user() {
        let temp = std::env::temp_dir().join(format!("alpha-cutoff-freeze-{}", uuid::Uuid::new_v4()));
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
        let token = "test-admin-token".to_string();
        *state.admin_session.lock().await = Some(crate::state::AdminSession {
            token: token.clone(),
            expires_at: std::time::Instant::now() + std::time::Duration::from_secs(3600),
        });
        upsert_user_record(
            &state.db, "EMP-1", "RFID-FREEZE", "Ada Lovelace", Some("QA"), "ACTIVE", "INTERN",
            Some("FEMALE"), None, Some("BEA_STANDARD"), None, "EMPLOYEE", "2026-08-01T00:00:00Z",
        )
        .await
        .unwrap();
        // Aug 1-15 is approved pay; Aug 20 is not.
        insert_cutoff_row(&state.db, "PAY-FIN", "FINALIZED").await;
        insert_cutoff_row(&state.db, "PAY-DRAFT", "DRAFT").await;
        sqlx::query("UPDATE payroll_cutoffs SET cutoff_start='2026-08-16', cutoff_end='2026-08-31' WHERE payroll_id='PAY-DRAFT'")
            .execute(&state.db).await.unwrap();
        sqlx::query("INSERT INTO payroll_snapshots (snapshot_id,payroll_id,revision,status,snapshot_json,snapshot_sha256,created_at) VALUES ('snap-1','PAY-FIN',1,'FINALIZED','{}','x','2026-08-16T00:00:00Z')")
            .execute(&state.db).await.unwrap();
        for (aid, date) in [("att-in", "2026-08-05"), ("att-out", "2026-08-20")] {
            sqlx::query("INSERT INTO attendance (attendance_id,attendance_date,user_id,rfid_uid,full_name,department,time_in,time_out,status,source,created_at,updated_at) VALUES (?,?,'EMP-1','RFID-FREEZE','Ada Lovelace','QA',?,?,'COMPLETED','RFID','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z')")
                .bind(aid).bind(date)
                .bind(format!("{date}T08:00:00+08:00")).bind(format!("{date}T17:00:00+08:00"))
                .execute(&state.db).await.unwrap();
        }

        let edit = admin_update_attendance_impl(&state, &token, "att-in", &serde_json::json!({"timeOut": "2026-08-05T16:00:00+08:00"})).await;
        assert_eq!(edit.unwrap_err(), "ATTENDANCE_IN_FINALIZED_CUTOFF");
        let move_in = admin_update_attendance_impl(&state, &token, "att-out", &serde_json::json!({"attendanceDate": "2026-08-06"})).await;
        assert_eq!(move_in.unwrap_err(), "ATTENDANCE_IN_FINALIZED_CUTOFF", "moving a day into approved pay");
        let delete = admin_delete_attendance_impl(&state, &token, "att-in", "2026-08-05").await;
        assert_eq!(delete.unwrap_err(), "ATTENDANCE_IN_FINALIZED_CUTOFF");
        let frozen = sqlx::query("SELECT time_out, attendance_date FROM attendance WHERE attendance_id='att-in'")
            .fetch_one(&state.db).await.unwrap();
        assert_eq!(frozen.get::<Option<String>, _>("time_out").as_deref(), Some("2026-08-05T17:00:00+08:00"));
        // Days outside approved pay still correct normally.
        let open = admin_update_attendance_impl(&state, &token, "att-out", &serde_json::json!({"timeOut": "2026-08-20T16:30:00+08:00"})).await.unwrap();
        assert_eq!(open["success"], true);

        // Deleting the person keeps the approved cutoff and its snapshot.
        delete_user_and_cascade(&state, "EMP-1").await.unwrap();
        let count = |sql: &'static str| {
            let db = state.db.clone();
            async move { sqlx::query_scalar::<_, i64>(sql).fetch_one(&db).await.unwrap() }
        };
        assert_eq!(count("SELECT COUNT(*) FROM payroll_cutoffs WHERE payroll_id='PAY-FIN'").await, 1);
        assert_eq!(count("SELECT COUNT(*) FROM payroll_snapshots WHERE payroll_id='PAY-FIN'").await, 1);
        assert_eq!(count("SELECT COUNT(*) FROM payroll_cutoffs WHERE payroll_id='PAY-DRAFT'").await, 0);
        assert_eq!(count("SELECT COUNT(*) FROM users WHERE user_id='EMP-1'").await, 0);
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
        let unlock_res = setup_unlock_impl(&state, "1234".to_string()).await.unwrap();
        let token = unlock_res["token"].as_str().unwrap().to_string();

        upsert_user_record(
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
        let res = admin_create_backdated_attendance_impl(None, &state, &token, &payload).await.unwrap();
        assert_eq!(res["success"], true);
        assert_eq!(res["attendance"]["attendanceDate"], "2026-08-15");
        assert_eq!(res["attendance"]["userId"], "EMP_01");
        assert_eq!(res["attendance"]["source"], "ADMIN_BACKDATED_ENTRY");
        assert_eq!(res["attendance"]["status"], "COMPLETED");

        // 2. Reject duplicate date
        let dup_err = admin_create_backdated_attendance_impl(None, &state, &token, &payload).await.unwrap_err();
        assert_eq!(dup_err, "ATTENDANCE_ALREADY_EXISTS_FOR_DATE");

        // 3. Reject future or today date
        let future_payload = serde_json::json!({
            "userId": "EMP_01",
            "attendanceDate": "2099-01-01",
            "timeIn": "2099-01-01T08:00:00+08:00",
            "reason": "Future date"
        });
        let future_err = admin_create_backdated_attendance_impl(None, &state, &token, &future_payload).await.unwrap_err();
        assert_eq!(future_err, "ADMIN_VALIDATION_ERROR");

        // 4. B1: a backdated LATE_TIMEOUT entry (clock-out >= 18:00) must still
        // produce a payroll row, capped to the 17:00 office close, instead of
        // silently dropping the day. Same date as EMP_01 above, different user,
        // so the date-validation path is identical to the proven-success case.
        upsert_user_record(
            &state.db,
            "EMP_02",
            "CARD_02",
            "Bob Dylan",
            Some("IT"),
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
        let late_payload = serde_json::json!({
            "userId": "EMP_02",
            "attendanceDate": "2026-08-15",
            "timeIn": "2026-08-15T08:00:00+08:00",
            "timeOut": "2026-08-15T18:05:00+08:00",
            "reason": "Late clock-out verified against physical log"
        });
        let late_res = admin_create_backdated_attendance_impl(None, &state, &token, &late_payload)
            .await
            .unwrap();
        assert_eq!(
            late_res["attendance"]["status"], "LATE_TIMEOUT",
            "18:05 clock-out must stay flagged for audit"
        );
        let late_payroll = sqlx::query(
            "SELECT computed_time_out, daily_pay_centavos FROM payroll WHERE attendance_id = ?",
        )
        .bind(late_res["attendance"]["attendanceId"].as_str().unwrap())
        .fetch_optional(&state.db)
        .await
        .unwrap();
        let late_payroll = late_payroll.expect("a LATE_TIMEOUT day must not be dropped from payroll");
        assert_eq!(
            late_payroll.get::<String, _>("computed_time_out"),
            "2026-08-15T17:00:00+08:00",
            "A LATE_TIMEOUT clock-out caps to the 17:00 office close"
        );
        assert_eq!(
            late_payroll.get::<i64, _>("daily_pay_centavos"),
            8_000,
            "The capped day pays the intern's full PHP 80 daily rate"
        );

        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[tokio::test]
    async fn admin_update_keeps_a_time_in() {
        // Owner decision D7: a correction that leaves no time-in made the day
        // MISSED, and the scan then refused the person for the rest of it.
        let temp = std::env::temp_dir().join(format!("alpha-keep-time-in-{}", uuid::Uuid::new_v4()));
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
        let token = "test-admin-token".to_string();
        *state.admin_session.lock().await = Some(crate::state::AdminSession {
            token: token.clone(),
            expires_at: std::time::Instant::now() + std::time::Duration::from_secs(3600),
        });
        upsert_user_record(
            &state.db, "INT_KEEP", "C0FFEE0A", "Keep Intern", Some("IT"), "ACTIVE", "INTERN",
            Some("MALE"), None, Some("BEA_STANDARD"), None, "EMPLOYEE", "2026-08-01T00:00:00Z",
        )
        .await
        .unwrap();
        sqlx::query("INSERT INTO attendance (attendance_id,attendance_date,user_id,rfid_uid,full_name,department,time_in,time_out,status,source,created_at,updated_at) VALUES ('att-keep','2026-08-12','INT_KEEP','C0FFEE0A','Keep Intern','IT','2026-08-12T08:00:00+08:00','2026-08-12T17:00:00+08:00','COMPLETED','RFID','2026-08-12T00:00:00Z','2026-08-12T00:00:00Z')")
            .execute(&state.db).await.unwrap();
        for payload in [
            serde_json::json!({"timeIn": serde_json::Value::Null}),
            serde_json::json!({"timeIn": serde_json::Value::Null, "timeOut": serde_json::Value::Null}),
        ] {
            let err = admin_update_attendance_impl(&state, &token, "att-keep", &payload).await.unwrap_err();
            assert_eq!(err, "ATTENDANCE_TIME_IN_REQUIRED", "{payload}");
        }
        let row = sqlx::query("SELECT time_in, status FROM attendance WHERE attendance_id='att-keep'")
            .fetch_one(&state.db).await.unwrap();
        assert_eq!(row.get::<Option<String>, _>("time_in").as_deref(), Some("2026-08-12T08:00:00+08:00"));
        assert_eq!(row.get::<String, _>("status"), "COMPLETED");
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[tokio::test]
    async fn admin_update_partial_payload_coalesces() {
        // Serialize DTR env access; a parallel blank-env test would otherwise
        // switch the resolver off mid-test and drop the InternDtr enqueue.
        let _env_guard = crate::config::dtr_env_test_guard();
        let saved_env = std::env::var(crate::config::ENV_DTR_SHEET_ID).ok();
        std::env::remove_var(crate::config::ENV_DTR_SHEET_ID);
        // P0 live data-loss 2026-09-05: a timeOut-only correction payload
        // wiped time_in to NULL and flipped COMPLETED to MISSED. Absent
        // (or explicit-null) fields must keep stored values.
        let temp = std::env::temp_dir().join(format!("alpha-admin-coalesce-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        let mut lan = LanConfig::default();
        lan.admin_pin = Some("1234".to_string());
        lan.admin_session_minutes = 30;
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
        let unlock_res = setup_unlock_impl(&state, "1234".to_string()).await.unwrap();
        let token = unlock_res["token"].as_str().unwrap().to_string();
        upsert_user_record(
            &state.db, "INT_P0", "CARD_INT_P0", "Coalesce Intern", Some("QA"),
            "ACTIVE", "INTERN", Some("MALE"), None, Some("BEA_STANDARD"),
            None, "EMPLOYEE", "2026-08-01T00:00:00Z",
        )
        .await
        .unwrap();
        // Row A: COMPLETED day. Row B: WORKING day (time-out open).
        for (aid, tin, tout, status) in [
            ("aid-a", "2026-08-11T08:00:00+08:00", Some("2026-08-11T17:00:00+08:00"), "COMPLETED"),
            ("aid-b", "2026-08-12T08:05:00+08:00", None, "WORKING"),
        ] {
            let date = &tin[..10];
            sqlx::query("INSERT INTO attendance (attendance_id,attendance_date,user_id,rfid_uid,full_name,department,time_in,time_out,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
                .bind(aid).bind(date).bind("INT_P0").bind("CARD_INT_P0").bind("Coalesce Intern").bind("QA")
                .bind(tin).bind(tout).bind(status).bind("RFID").bind("2026-08-11T00:00:00Z").bind("2026-08-11T00:00:00Z")
                .execute(&state.db).await.unwrap();
        }
        // 1. Live repro: timeOut-only payload keeps time_in, stays COMPLETED.
        let r1 = admin_update_attendance_impl(&state, &token, "aid-a", &serde_json::json!({"timeOut": "2026-08-11T17:05:00+08:00"})).await.unwrap();
        assert_eq!(r1["success"], true);
        assert_eq!(r1["timeIn"], "2026-08-11T08:00:00+08:00");
        assert_eq!(r1["timeOut"], "2026-08-11T17:05:00+08:00");
        assert_eq!(r1["status"], "COMPLETED");
        let row = sqlx::query("SELECT attendance_date,time_in,time_out,status,revision FROM attendance WHERE attendance_id='aid-a'")
            .fetch_one(&state.db).await.unwrap();
        assert_eq!(row.get::<Option<String>, _>("time_in").as_deref(), Some("2026-08-11T08:00:00+08:00"));
        assert_eq!(row.get::<String, _>("status"), "COMPLETED");
        // 2. timeIn-only on the WORKING row keeps the open time-out.
        let r2 = admin_update_attendance_impl(&state, &token, "aid-b", &serde_json::json!({"timeIn": "2026-08-12T08:06:00+08:00"})).await.unwrap();
        assert_eq!(r2["status"], "WORKING");
        assert!(r2["timeOut"].is_null());
        // 3. Explicit JSON null clears the field (admins can remove an
        // inaccurate tap-out); status drops back to WORKING and the DTR
        // re-push carries the cleared row.
        let r3 = admin_update_attendance_impl(&state, &token, "aid-a", &serde_json::json!({"timeOut": serde_json::Value::Null, "timeIn": "2026-08-11T08:01:00+08:00"})).await.unwrap();
        assert!(r3["timeOut"].is_null());
        assert_eq!(r3["timeIn"], "2026-08-11T08:01:00+08:00");
        assert_eq!(r3["status"], "WORKING");
        let cleared = sqlx::query("SELECT time_in,time_out,status FROM attendance WHERE attendance_id='aid-a'")
            .fetch_one(&state.db).await.unwrap();
        assert!(cleared.get::<Option<String>, _>("time_out").is_none());
        assert_eq!(cleared.get::<String, _>("status"), "WORKING");
        let dtr_payload: Option<String> = sqlx::query_scalar("SELECT payload_json FROM sync_queue WHERE table_name='InternDtr' AND row_id='aid-a' AND operation='UPSERT'")
            .fetch_optional(&state.db).await.unwrap();
        let dtr_payload: serde_json::Value = serde_json::from_str(&dtr_payload.expect("correction must re-push InternDtr")).unwrap();
        assert!(dtr_payload["timeOut"].is_null());
        assert_eq!(dtr_payload["timeIn"], "2026-08-11T08:01:00+08:00");
        // Restore the completed day for the no-op / conflict steps below.
        let restore = admin_update_attendance_impl(&state, &token, "aid-a", &serde_json::json!({"timeOut": "2026-08-11T17:05:00+08:00"})).await.unwrap();
        assert_eq!(restore["status"], "COMPLETED");
        // 4. No-op full payload: revision untouched, no extra queue churn.
        let rev_before: i64 = sqlx::query_scalar("SELECT revision FROM attendance WHERE attendance_id='aid-a'").fetch_one(&state.db).await.unwrap();
        let q_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_queue WHERE row_id='aid-a'").fetch_one(&state.db).await.unwrap();
        let r4 = admin_update_attendance_impl(&state, &token, "aid-a", &serde_json::json!({"attendanceDate": "2026-08-11", "timeIn": "2026-08-11T08:01:00+08:00", "timeOut": "2026-08-11T17:05:00+08:00"})).await.unwrap();
        assert_eq!(r4["success"], true);
        let rev_after: i64 = sqlx::query_scalar("SELECT revision FROM attendance WHERE attendance_id='aid-a'").fetch_one(&state.db).await.unwrap();
        let q_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_queue WHERE row_id='aid-a'").fetch_one(&state.db).await.unwrap();
        assert_eq!(rev_before, rev_after);
        assert_eq!(q_before, q_after);
        // 5. Invalid time still rejected; conflicting expectation still conflicts.
        let bad = admin_update_attendance_impl(&state, &token, "aid-a", &serde_json::json!({"timeIn": "not-a-time"})).await.unwrap_err();
        assert_eq!(bad, "ADMIN_VALIDATION_ERROR");
        let conflict = admin_update_attendance_impl(&state, &token, "aid-a", &serde_json::json!({"timeIn": "2026-08-11T08:01:00+08:00", "expectedTimeIn": "2026-08-11T00:00:00+08:00"})).await.unwrap_err();
        assert_eq!(conflict, "ATTENDANCE_CONFLICT");
        // Row survived all of the above with real times intact.
        let final_row = sqlx::query("SELECT attendance_date,time_in,time_out,status,revision FROM attendance WHERE attendance_id='aid-a'")
            .fetch_one(&state.db).await.unwrap();
        assert!(final_row.get::<Option<String>, _>("time_in").as_deref().is_some());
        // 6. Stale save: the admin loaded aid-b while WORKING (time-out empty),
        // then the intern's tap-out committed time-out + payroll. Saving the
        // stale draft sends timeOut:null with expectedTimeOut:null; that
        // expectation no longer holds, so it must conflict instead of wiping
        // the fresh time-out and deleting the day's payroll.
        let tapped = admin_update_attendance_impl(&state, &token, "aid-b", &serde_json::json!({"timeOut": "2026-08-12T17:00:00+08:00"})).await.unwrap();
        assert_eq!(tapped["status"], "COMPLETED");
        let stale = admin_update_attendance_impl(&state, &token, "aid-b", &serde_json::json!({
            "attendanceDate": "2026-08-12",
            "timeIn": "2026-08-12T08:07:00+08:00",
            "timeOut": serde_json::Value::Null,
            "expectedTimeIn": "2026-08-12T08:06:00+08:00",
            "expectedTimeOut": serde_json::Value::Null,
        })).await.unwrap_err();
        assert_eq!(stale, "ATTENDANCE_CONFLICT");
        let kept = sqlx::query("SELECT time_out,status FROM attendance WHERE attendance_id='aid-b'")
            .fetch_one(&state.db).await.unwrap();
        assert_eq!(kept.get::<Option<String>, _>("time_out").as_deref(), Some("2026-08-12T17:00:00+08:00"));
        assert_eq!(kept.get::<String, _>("status"), "COMPLETED");
        let payroll_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM payroll WHERE attendance_id='aid-b'")
            .fetch_one(&state.db).await.unwrap();
        assert_eq!(payroll_rows, 1);
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
        match saved_env {
            Some(v) => std::env::set_var(crate::config::ENV_DTR_SHEET_ID, v),
            None => std::env::remove_var(crate::config::ENV_DTR_SHEET_ID),
        }
    }

    #[tokio::test]
    async fn admin_update_rolls_back_attendance_when_payroll_write_fails() {
        let _env_guard = crate::config::dtr_env_test_guard();
        let temp = std::env::temp_dir().join(format!("alpha-admin-rollback-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        let mut lan = LanConfig::default();
        lan.admin_pin = Some("1234".to_string());
        lan.admin_session_minutes = 30;
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
        let unlock_res = setup_unlock_impl(&state, "1234".to_string()).await.unwrap();
        let token = unlock_res["token"].as_str().unwrap().to_string();
        upsert_user_record(
            &state.db, "INT_RB", "CARD_INT_RB", "Rollback Intern", Some("QA"),
            "ACTIVE", "INTERN", Some("MALE"), None, Some("BEA_STANDARD"),
            None, "EMPLOYEE", "2026-08-01T00:00:00Z",
        )
        .await
        .unwrap();
        // Late open day (pre grace cut-over): completing it claims a grace row
        // first, then writes payroll. The trigger makes the payroll write fail.
        sqlx::query("INSERT INTO attendance (attendance_id,attendance_date,user_id,rfid_uid,full_name,department,time_in,time_out,status,source,created_at,updated_at) VALUES ('aid-rb','2026-08-12','INT_RB','CARD_INT_RB','Rollback Intern','QA','2026-08-12T08:10:00+08:00',NULL,'WORKING','RFID','2026-08-12T00:00:00Z','2026-08-12T00:00:00Z')")
            .execute(&state.db).await.unwrap();
        let rev_before: i64 = sqlx::query_scalar("SELECT revision FROM attendance WHERE attendance_id='aid-rb'").fetch_one(&state.db).await.unwrap();
        sqlx::query("CREATE TRIGGER fail_payroll_insert BEFORE INSERT ON payroll BEGIN SELECT RAISE(ABORT, 'forced payroll failure'); END")
            .execute(&state.db).await.unwrap();
        let err = admin_update_attendance_impl(&state, &token, "aid-rb", &serde_json::json!({"timeOut": "2026-08-12T17:00:00+08:00"})).await.unwrap_err();
        assert!(err.contains("forced payroll failure"), "unexpected error: {err}");
        let row = sqlx::query("SELECT time_out,status,revision FROM attendance WHERE attendance_id='aid-rb'")
            .fetch_one(&state.db).await.unwrap();
        assert!(row.get::<Option<String>, _>("time_out").is_none());
        assert_eq!(row.get::<String, _>("status"), "WORKING");
        assert_eq!(row.get::<i64, _>("revision"), rev_before);
        let grace: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM intern_grace WHERE attendance_id='aid-rb'").fetch_one(&state.db).await.unwrap();
        assert_eq!(grace, 0);
        let queued: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_queue WHERE row_id='aid-rb'").fetch_one(&state.db).await.unwrap();
        assert_eq!(queued, 0);
        let audited: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_logs WHERE event_type='ADMIN_ATTENDANCE_UPDATED'").fetch_one(&state.db).await.unwrap();
        assert_eq!(audited, 0);
        // The same edit succeeds once the failure is removed.
        sqlx::query("DROP TRIGGER fail_payroll_insert").execute(&state.db).await.unwrap();
        let ok = admin_update_attendance_impl(&state, &token, "aid-rb", &serde_json::json!({"timeOut": "2026-08-12T17:00:00+08:00"})).await.unwrap();
        assert_eq!(ok["status"], "COMPLETED");
        let payroll: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM payroll WHERE attendance_id='aid-rb'").fetch_one(&state.db).await.unwrap();
        assert_eq!(payroll, 1);
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[tokio::test]
    async fn admin_corrections_mirror_intern_dtr() {
        // Serialize DTR env access; a parallel blank-env test would otherwise
        // switch the resolver off mid-test and drop the InternDtr enqueue.
        let _env_guard = crate::config::dtr_env_test_guard();
        let saved_env = std::env::var(crate::config::ENV_DTR_SHEET_ID).ok();
        std::env::remove_var(crate::config::ENV_DTR_SHEET_ID);
        let temp = std::env::temp_dir().join(format!("alpha-admin-dtr-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        let db_path = temp.join("attendance.db");
        let exports_path = temp.join("exports");
        let mut lan = LanConfig::default();
        lan.admin_pin = Some("1234".to_string());
        lan.admin_session_minutes = 30;
        lan.google_dtr_spreadsheet_id = Some("sheet-test".to_string());
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
        let unlock_res = setup_unlock_impl(&state, "1234".to_string()).await.unwrap();
        let token = unlock_res["token"].as_str().unwrap().to_string();

        for (uid, card, name, etype, rate) in [
            ("INT_01", "CARD_INT_01", "Test Intern", "INTERN", None),
            ("EMP_02", "CARD_EMP_02", "Test Employee", "EMPLOYEE", Some(50_000)),
        ] {
            upsert_user_record(
                &state.db, uid, card, name, Some("QA"), "ACTIVE", etype,
                Some("MALE"), rate, Some("BEA_STANDARD"), None, "EMPLOYEE",
                "2026-08-01T00:00:00Z",
            )
            .await
            .unwrap();
        }

        // 1. Intern backdate → InternDtr UPSERT queued with exact times.
        let payload = serde_json::json!({
            "userId": "INT_01",
            "attendanceDate": "2026-08-11",
            "timeIn": "2026-08-11T08:00:00+08:00",
            "timeOut": "2026-08-11T17:00:00+08:00",
            "reason": "Missed scan physical log verified"
        });
        let res = admin_create_backdated_attendance_impl(None, &state, &token, &payload).await.unwrap();
        let aid = res["attendance"]["attendanceId"].as_str().unwrap().to_string();
        let row: Option<String> = sqlx::query_scalar("SELECT payload_json FROM sync_queue WHERE table_name='InternDtr' AND row_id=?")
            .bind(&aid).fetch_optional(&state.db).await.unwrap();
        assert!(row.is_some(), "intern backdate must enqueue InternDtr");
        let queued: serde_json::Value = serde_json::from_str(&row.unwrap()).unwrap();
        assert_eq!(queued["userId"], "INT_01");
        assert_eq!(queued["timeIn"], "2026-08-11T08:00:00+08:00");
        assert_eq!(queued["timeOut"], "2026-08-11T17:00:00+08:00");

        // 2. Employee backdate → no InternDtr row (interns-only guard).
        let emp_payload = serde_json::json!({
            "userId": "EMP_02",
            "attendanceDate": "2026-08-12",
            "timeIn": "2026-08-12T08:00:00+08:00",
            "timeOut": "2026-08-12T17:00:00+08:00",
            "reason": "Missed scan physical log verified"
        });
        let emp_res = admin_create_backdated_attendance_impl(None, &state, &token, &emp_payload).await.unwrap();
        let emp_aid = emp_res["attendance"]["attendanceId"].as_str().unwrap().to_string();
        let emp_row: Option<String> = sqlx::query_scalar("SELECT payload_json FROM sync_queue WHERE table_name='InternDtr' AND row_id=?")
            .bind(&emp_aid).fetch_optional(&state.db).await.unwrap();
        assert!(emp_row.is_none(), "employee backdate must not enqueue InternDtr");

        // 3. Admin corrects the intern time-in → payload rewritten (converges),
        // still exactly one InternDtr row (idempotent upsert, no duplicates).
        let upd = serde_json::json!({
            "attendanceDate": "2026-08-11",
            "timeIn": "2026-08-11T07:30:00+08:00",
            "timeOut": "2026-08-11T17:00:00+08:00",
            "expectedTimeIn": "2026-08-11T08:00:00+08:00",
            "expectedTimeOut": "2026-08-11T17:00:00+08:00"
        });
        let ures = admin_update_attendance_impl(&state, &token, &aid, &upd).await.unwrap();
        assert_eq!(ures["success"], true);
        let row2: String = sqlx::query_scalar("SELECT payload_json FROM sync_queue WHERE table_name='InternDtr' AND row_id=?")
            .bind(&aid).fetch_one(&state.db).await.unwrap();
        let queued2: serde_json::Value = serde_json::from_str(&row2).unwrap();
        assert_eq!(queued2["timeIn"], "2026-08-11T07:30:00+08:00");
        // The corrected row renders differently, so the push rewrites it.
        let before = crate::services::dtr_sync::build_dtr_row(Some("2026-08-11T08:00:00+08:00"), Some("2026-08-11T17:00:00+08:00"), "2026-08-11").unwrap();
        let after = crate::services::dtr_sync::build_dtr_row(Some("2026-08-11T07:30:00+08:00"), Some("2026-08-11T17:00:00+08:00"), "2026-08-11").unwrap();
        assert_ne!(before[0], after[0]);
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_queue WHERE table_name='InternDtr' AND row_id=?")
            .bind(&aid).fetch_one(&state.db).await.unwrap();
        assert_eq!(n, 1);

        // 4. Delete → an InternDtr DELETE row (same attendance id, separate
        // idempotency key per operation) so the sheet date clears; the ops
        // Attendance DELETE is still enqueued too.
        admin_delete_attendance_impl(&state, &token, &aid, "2026-08-11").await.unwrap();
        let del_row: Option<String> = sqlx::query_scalar("SELECT payload_json FROM sync_queue WHERE table_name='InternDtr' AND row_id=? AND operation='DELETE'")
            .bind(&aid).fetch_optional(&state.db).await.unwrap();
        assert!(del_row.is_some(), "delete must enqueue InternDtr DELETE");
        let del_payload: serde_json::Value = serde_json::from_str(&del_row.unwrap()).unwrap();
        assert_eq!(del_payload["userId"], "INT_01");
        assert_eq!(del_payload["attendanceDate"], "2026-08-11");
        let del_op: Option<String> = sqlx::query_scalar("SELECT operation FROM sync_queue WHERE table_name='Attendance' AND row_id=? AND operation='DELETE'")
            .bind(&aid).fetch_optional(&state.db).await.unwrap();
        assert_eq!(del_op.as_deref(), Some("DELETE"));

        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
        match saved_env {
            Some(v) => std::env::set_var(crate::config::ENV_DTR_SHEET_ID, v),
            None => std::env::remove_var(crate::config::ENV_DTR_SHEET_ID),
        }
    }

    #[tokio::test]
    async fn admin_backdate_skips_dtr_when_explicitly_disabled() {
        // Serialize DTR env access; restored below.
        let _env_guard = crate::config::dtr_env_test_guard();
        // DTR is hard-wired on by default, so the off path needs the
        // explicit blank-env switch.
        let saved = std::env::var(crate::config::ENV_DTR_SHEET_ID).ok();
        std::env::set_var(crate::config::ENV_DTR_SHEET_ID, "");
        let temp = std::env::temp_dir().join(format!("alpha-admin-dtr-off-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        let mut lan = LanConfig::default();
        lan.admin_pin = Some("1234".to_string());
        lan.admin_session_minutes = 30;
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
        let unlock_res = setup_unlock_impl(&state, "1234".to_string()).await.unwrap();
        let token = unlock_res["token"].as_str().unwrap().to_string();
        upsert_user_record(
            &state.db, "INT_09", "CARD_INT_09", "Quiet Intern", Some("QA"),
            "ACTIVE", "INTERN", Some("MALE"), None, Some("BEA_STANDARD"),
            None, "EMPLOYEE", "2026-08-01T00:00:00Z",
        )
        .await
        .unwrap();
        let payload = serde_json::json!({
            "userId": "INT_09",
            "attendanceDate": "2026-08-11",
            "timeIn": "2026-08-11T08:00:00+08:00",
            "timeOut": "2026-08-11T17:00:00+08:00",
            "reason": "Missed scan physical log verified"
        });
        let res = admin_create_backdated_attendance_impl(None, &state, &token, &payload).await.unwrap();
        let aid = res["attendance"]["attendanceId"].as_str().unwrap().to_string();
        let row: Option<String> = sqlx::query_scalar("SELECT payload_json FROM sync_queue WHERE table_name='InternDtr' AND row_id=?")
            .bind(&aid).fetch_optional(&state.db).await.unwrap();
        assert!(row.is_none(), "explicitly disabled DTR must not enqueue InternDtr");
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
        match saved {
            Some(v) => std::env::set_var(crate::config::ENV_DTR_SHEET_ID, v),
            None => std::env::remove_var(crate::config::ENV_DTR_SHEET_ID),
        }
    }

    #[tokio::test]
    async fn admin_changes_reach_lan_viewers() {
        // O11: only scans published to the LAN bus, so open viewers missed
        // admin corrections, deletes and backdated days until a refresh.
        let (state, temp, token) = admin_test_state("lan-admin").await;
        add_intern(&state, "INT_L", "C0FFEE16").await;
        sqlx::query("INSERT INTO attendance (attendance_id,attendance_date,user_id,rfid_uid,full_name,department,time_in,time_out,status,source,created_at,updated_at) VALUES ('att-l','2026-08-12','INT_L','C0FFEE16','INT_L','IT','2026-08-12T08:00:00+08:00',NULL,'WORKING','RFID','2026-08-12T00:00:00Z','2026-08-12T00:00:00Z')")
            .execute(&state.db).await.unwrap();
        let mut viewer = state.bus.sender.subscribe();
        let mut next_event = || match viewer.try_recv() {
            Ok(crate::lan_server::LanAttendanceEvent::AttendanceUpdated { attendance_id, mutation, .. }) => Some((attendance_id, mutation)),
            Err(_) => None,
        };
        admin_update_attendance_impl(&state, &token, "att-l", &serde_json::json!({"timeOut": "2026-08-12T17:00:00+08:00"})).await.unwrap();
        assert_eq!(next_event(), Some(("att-l".to_string(), "upsert".to_string())));
        admin_delete_attendance_impl(&state, &token, "att-l", "2026-08-12").await.unwrap();
        assert_eq!(next_event(), Some(("att-l".to_string(), "delete".to_string())));
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[tokio::test]
    async fn moving_a_day_clears_the_old_date_on_the_dtr_sheet() {
        // S6 (confirmed): the UPSERT only writes the new date, so the old
        // date's cells stayed filled.
        let _env_guard = crate::config::dtr_env_test_guard();
        let saved_env = std::env::var(crate::config::ENV_DTR_SHEET_ID).ok();
        std::env::remove_var(crate::config::ENV_DTR_SHEET_ID);
        let (mut state, temp, token) = admin_test_state("move-day").await;
        state.lan.google_dtr_spreadsheet_id = Some("sheet-test".to_string());
        add_intern(&state, "INT_M", "C0FFEE14").await;
        sqlx::query("INSERT INTO attendance (attendance_id,attendance_date,user_id,rfid_uid,full_name,department,time_in,time_out,status,source,created_at,updated_at) VALUES ('att-m','2026-08-12','INT_M','C0FFEE14','INT_M','IT','2026-08-12T08:00:00+08:00','2026-08-12T17:00:00+08:00','COMPLETED','RFID','2026-08-12T00:00:00Z','2026-08-12T00:00:00Z')")
            .execute(&state.db).await.unwrap();
        admin_update_attendance_impl(&state, &token, "att-m", &serde_json::json!({
            "attendanceDate": "2026-08-13",
            "timeIn": "2026-08-13T08:00:00+08:00",
            "timeOut": "2026-08-13T17:00:00+08:00",
        })).await.unwrap();
        let clear: Option<String> = sqlx::query_scalar("SELECT payload_json FROM sync_queue WHERE table_name='InternDtr' AND operation='DELETE' AND status='PENDING'")
            .fetch_optional(&state.db).await.unwrap();
        let clear: serde_json::Value = serde_json::from_str(&clear.expect("old date is cleared on the DTR sheet")).unwrap();
        assert_eq!(clear["attendanceDate"], "2026-08-12");
        let upsert: String = sqlx::query_scalar("SELECT status FROM sync_queue WHERE table_name='InternDtr' AND row_id='att-m' AND operation='UPSERT'")
            .fetch_one(&state.db).await.unwrap();
        assert_eq!(upsert, "PENDING", "the clear must not supersede the new date's push");
        match saved_env {
            Some(value) => std::env::set_var(crate::config::ENV_DTR_SHEET_ID, value),
            None => std::env::remove_var(crate::config::ENV_DTR_SHEET_ID),
        }
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }
}
