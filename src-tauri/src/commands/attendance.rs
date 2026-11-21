use chrono_tz::Asia::Manila;
use crate::state::AppState;
use sqlx::Row;
use super::session::Admin;
use crate::services::attendance::{arrival_fields, attendance_arrival, attendance_changed, day_in_finalized_cutoff, ensure_payroll_tx, manila_week_start, AttendanceChange, GRACE_AVAILABLE_SQL, IS_INTERN_SQL, DtrLine, DtrPerson, Follow, LanNotice, WindowEvent};
use crate::services::sync_queue::PendingSync;
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
    Admin::check(&state, &token).await?;
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
    let rows = sqlx::query(&format!(
        "SELECT a.attendance_id, a.attendance_date, a.user_id, a.full_name, a.department, a.time_in, a.time_out, a.status, a.source, a.recorded_by, a.recorded_reason, a.recorded_at, \
         {GRACE_AVAILABLE_SQL} AS grace_available, {IS_INTERN_SQL} AS is_intern \
         FROM attendance a WHERE a.attendance_date = ? ORDER BY a.time_in, a.full_name"
    ))
    .bind(manila_week_start(date))
    .bind(date)
    .fetch_all(db)
    .await
    .map_err(|e| e.to_string())?;
    let attendance = rows.into_iter().map(|row| {
        let shown = arrival_fields(date, row.get::<Option<String>, _>("time_in").as_deref(), row.get::<bool, _>("grace_available"), row.get::<bool, _>("is_intern"));
        let mut listed = serde_json::json!({
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
        });
        shown.insert_into(&mut listed);
        listed
    }).collect::<Vec<_>>();
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
    let admin = Admin::check(&state, &token).await?;
    admin_update_attendance_impl(&state, &admin, &attendance_id, &payload).await
}

pub(crate) async fn admin_update_attendance_impl(
    state: &AppState,
    _admin: &Admin,
    attendance_id: &str,
    payload: &serde_json::Value,
) -> Result<serde_json::Value, String> {
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
    // The intern DTR sheet mirrors the correction: the idempotent re-push
    // rewrites the same tab row (half-day/working/full tiers + paint), so
    // corrections converge with no duplicates. Lookup failure skips silently;
    // admin ops never fail because of DTR.
    let person = match sqlx::query("SELECT user_id, full_name, employee_type FROM users WHERE user_id=(SELECT user_id FROM attendance WHERE attendance_id=? LIMIT 1)").bind(attendance_id).fetch_optional(&mut *tx).await {
        Ok(Some(user_row)) => Some(DtrPerson {
            user_id: user_row.get("user_id"),
            full_name: user_row.get("full_name"),
            employee_type: user_row.get("employee_type"),
        }),
        _ => None,
    };
    // The day moved to another date: the UPSERT only writes the new
    // date, so clear the old date's cells and replan the old week (S6).
    // Its own row id keeps it from superseding the day's UPSERT.
    let mut follow = Vec::new();
    if let Some(person) = &person {
        if date != current_date
            && person.employee_type.to_uppercase() == "INTERN"
            && crate::config::dtr_spreadsheet_id_resolved(&state.lan).is_some()
        {
            follow.push(Follow::Queue {
                table: crate::services::dtr_sync::DTR_TABLE_NAME,
                row_id: format!("{attendance_id}@{current_date}"),
                operation: "DELETE",
                payload: serde_json::json!({"userId": person.user_id, "fullName": person.full_name, "attendanceDate": current_date}),
            });
            follow.push(Follow::LaterWeek { date: current_date });
        }
    }
    let audit_message = format!("Attendance {attendance_id} corrected");
    let audit_request = crate::services::audit::admin_request_id();
    attendance_changed(state, tx, AttendanceChange {
        attendance_id,
        date,
        pending,
        sheet_operation: "UPSERT",
        sheet_row: serde_json::json!({"attendanceId":attendance_id,"attendanceDate":date,"timeIn":time_in,"timeOut":time_out,"status":status}),
        dtr: if person.is_some() { DtrLine::Write { time_in, time_out } } else { DtrLine::None },
        requeue_later_week: person.is_some(),
        person,
        follow,
        tap: None,
        lan: LanNotice { cause: "ADMIN_CORRECTION", mutation: "upsert", from_scan: None },
        window_event: None,
        audit: Some(crate::services::audit::Entry::new("ADMIN_ATTENDANCE_UPDATED", &now, &audit_message, &audit_request)),
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(
        serde_json::json!({"success":true,"attendanceId":attendance_id,"attendanceDate":date,"timeIn":time_in,"timeOut":time_out,"status":status}),
    )
}

pub(crate) async fn admin_create_backdated_attendance_impl(
    app: Option<&tauri::AppHandle>,
    state: &AppState,
    _admin: &Admin,
    payload: &serde_json::Value,
) -> Result<serde_json::Value, String> {
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
    let audit_message = format!("Backdated attendance created for {}: {}", attendance_date, reason);
    let audit_request = crate::services::audit::admin_request_id();
    attendance_changed(state, tx, AttendanceChange {
        attendance_id: &attendance_id,
        date: attendance_date,
        pending,
        sheet_operation: "UPSERT",
        sheet_row: serde_json::json!({
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
        }),
        // Interns only, when configured. Same fire-and-forget contract as the scan path.
        person: Some(DtrPerson { user_id: user_id.to_string(), full_name: full_name.clone(), employee_type: user.get("employee_type") }),
        dtr: DtrLine::Write { time_in: Some(time_in), time_out },
        requeue_later_week: true,
        follow: Vec::new(),
        tap: None,
        lan: LanNotice { cause: "BACKDATED_ATTENDANCE", mutation: "upsert", from_scan: None },
        window_event: Some(WindowEvent {
            app,
            user_id,
            action: "BACKDATED_ATTENDANCE",
            time_in: serde_json::json!(time_in),
            time_out: serde_json::json!(time_out),
            status: &status,
            own_sequence: true,
        }),
        audit: Some(crate::services::audit::Entry::new("ADMIN_ATTENDANCE_CREATED", &now_ts, &audit_message, &audit_request).user(Some(user_id))),
    })
    .await
    .map_err(|e| e.to_string())?;

    let shown = attendance_arrival(&state.db, user_id, &attendance_id, attendance_date, Some(time_in)).await;
    let mut answer = serde_json::json!({
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
    });
    shown.insert_into(&mut answer["attendance"]);
    Ok(answer)
}

#[tauri::command]
pub(crate) async fn admin_create_backdated_attendance(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    token: String,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let admin = Admin::check(&state, &token).await?;
    admin_create_backdated_attendance_impl(Some(&app), &state, &admin, &payload).await
}

#[tauri::command]
pub(crate) async fn admin_delete_attendance(
    state: State<'_, AppState>,
    token: String,
    attendance_id: String,
    date: String,
) -> Result<serde_json::Value, String> {
    let admin = Admin::check(&state, &token).await?;
    admin_delete_attendance_impl(&state, &admin, &attendance_id, &date).await
}

pub(crate) async fn admin_delete_attendance_impl(
    state: &AppState,
    _admin: &Admin,
    attendance_id: &str,
    date: &str,
) -> Result<serde_json::Value, String> {
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
    // The payroll and grace rows of the day go with it.
    let mut follow: Vec<Follow> = payroll_ids
        .into_iter()
        .map(|payroll_id| Follow::Queue {
            table: "Payroll",
            payload: serde_json::json!({"payrollId":payroll_id,"attendanceId":attendance_id}),
            row_id: payroll_id,
            operation: "DELETE",
        })
        .collect();
    follow.extend(grace_rows.into_iter().map(|(grace_id, user_id)| Follow::Queue {
        table: "InternGrace",
        payload: serde_json::json!({"userId":user_id,"attendanceId":attendance_id,"graceId":grace_id}),
        row_id: user_id,
        operation: "DELETE",
    }));
    // Intern-DTR auto-clear for the deleted day (values emptied, row kept).
    // Missing tab/row downstream is a silent no-op; failures never fail admin.
    let person = dtr_owner.map(|(user_id, full_name, employee_type)| DtrPerson { user_id, full_name, employee_type });
    attendance_changed(state, tx, AttendanceChange {
        attendance_id,
        date,
        pending: Vec::new(),
        sheet_operation: "DELETE",
        sheet_row: serde_json::json!({"attendanceId":attendance_id,"attendanceDate":date}),
        dtr: if person.is_some() { DtrLine::Clear } else { DtrLine::None },
        requeue_later_week: person.is_some(),
        person,
        follow,
        tap: None,
        lan: LanNotice { cause: "ADMIN_DELETE", mutation: "delete", from_scan: None },
        window_event: None,
        audit: None,
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({"success":true,"attendanceId":attendance_id}))
}

#[cfg(test)]
mod tests;
