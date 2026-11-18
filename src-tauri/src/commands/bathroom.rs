use chrono_tz::Asia::Manila;
use crate::state::AppState;
use sqlx::Row;
use super::session::admin_authorized;
use tauri::State;

#[tauri::command]
pub(crate) async fn bathroom_get_status(
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
        "SELECT log_id, user_id, full_name, department, gender_key, time_out FROM bathroom_log WHERE time_in IS NULL",
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
pub(crate) async fn bathroom_time_out(
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
        "SELECT full_name FROM bathroom_log WHERE gender_key = ? AND time_in IS NULL LIMIT 1",
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
    .map_err(|e| {
        // T10: concurrent checkout raced past the SELECT — the partial unique
        // index is the atomic backstop; report conflict, not generic failure.
        let code = e
            .as_database_error()
            .and_then(|db_err| db_err.code())
            .map(|c| c.into_owned())
            .unwrap_or_default();
        if code == "2067" || code == "1555" || e.to_string().contains("UNIQUE constraint failed") {
            format!("BATHROOM_KEY_ALREADY_CHECKED_OUT: The {normalized_gender} bathroom key was just checked out by another session.")
        } else {
            format!("Failed to record time-out: {e}")
        }
    })?;

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
pub(crate) async fn bathroom_time_in(
    state: State<'_, AppState>,
    token: String,
    log_id: String,
    notes: Option<String>,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }

    let existing = sqlx::query(
        "SELECT log_id, log_date, user_id, full_name, department, gender_key, time_out, time_in, status, notes FROM bathroom_log WHERE log_id = ?",
    )
    .bind(&log_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "BATHROOM_LOG_NOT_FOUND: Bathroom log entry not found".to_string())?;

    let current_time_in: Option<String> = existing.get("time_in");
    if current_time_in.is_some() {
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

    let outcome = sqlx::query(
        "UPDATE bathroom_log SET time_in = ?, duration_seconds = ?, status = 'RETURNED', notes = ?, updated_at = ? WHERE log_id = ? AND time_in IS NULL",
    )
    .bind(&time_in)
    .bind(duration_seconds)
    .bind(&updated_notes)
    .bind(&now_utc)
    .bind(&log_id)
    .execute(&state.db)
    .await
    .map_err(|e| format!("Failed to record time-in: {e}"))?;
    // T10: lost-update guard — a concurrent return already flipped this row
    // between the SELECT above and this UPDATE.
    if outcome.rows_affected() != 1 {
        return Err("BATHROOM_KEY_ALREADY_RETURNED: This bathroom key has already been returned".into());
    }

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

pub(crate) async fn bathroom_update_log_impl(
    state: &AppState,
    token: &str,
    log_id: &str,
    request: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(state, token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }

    let existing = sqlx::query(
        "SELECT log_id, log_date, user_id, full_name, department, gender_key, time_out, time_in, duration_seconds, status, notes, created_at, updated_at FROM bathroom_log WHERE log_id = ?",
    )
    .bind(&log_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "BATHROOM_LOG_NOT_FOUND: Bathroom log entry not found".to_string())?;

    let log_date: String = existing.get("log_date");
    let user_id: String = existing.get("user_id");
    let full_name: String = existing.get("full_name");
    let department: Option<String> = existing.get("department");
    let gender_key: String = existing.get("gender_key");
    let current_time_out: String = existing.get("time_out");
    let current_time_in: Option<String> = existing.get("time_in");
    let current_notes: String = existing.get("notes");
    let created_at: String = existing.get("created_at");

    let next_time_out = if let Some(to_val) = request.get("timeOut") {
        if let Some(s) = to_val.as_str() {
            let s_trimmed = s.trim();
            if s_trimmed.is_empty() {
                return Err("Time-out cannot be empty.".into());
            }
            s_trimmed.to_string()
        } else {
            current_time_out
        }
    } else {
        current_time_out
    };

    let parsed_out = chrono::DateTime::parse_from_rfc3339(&next_time_out)
        .map_err(|_| "Time-out must be a valid RFC3339 timestamp.".to_string())?;

    // T4: edited timestamps must belong to the log's own date (Manila);
    // otherwise per-date history silently disagrees with log_date.
    if parsed_out.with_timezone(&Manila).format("%Y-%m-%d").to_string() != log_date {
        return Err("Edited time-out must fall on the log date.".into());
    };

    let next_time_in: Option<String> = if let Some(ti_val) = request.get("timeIn") {
        if ti_val.is_null() {
            None
        } else if let Some(s) = ti_val.as_str() {
            let s_trimmed = s.trim();
            if s_trimmed.is_empty() {
                None
            } else {
                Some(s_trimmed.to_string())
            }
        } else {
            current_time_in
        }
    } else {
        current_time_in
    };

    let next_duration_seconds: Option<i64>;
    let next_status: String;

    if let Some(ref ti_str) = next_time_in {
        let parsed_in = chrono::DateTime::parse_from_rfc3339(ti_str)
            .map_err(|_| "Time-in must be a valid RFC3339 timestamp.".to_string())?;

        if parsed_in < parsed_out {
            return Err("Time-in (return) cannot precede time-out (checkout).".into());
        }

        if parsed_in.with_timezone(&Manila).format("%Y-%m-%d").to_string() != log_date {
            return Err("Edited time-in must fall on the log date.".into());
        }

        let dur = (parsed_in - parsed_out).num_seconds().max(0);
        next_duration_seconds = Some(dur);
        next_status = "RETURNED".to_string();
    } else {
        // If status is going to be OUT, ensure no other active key is currently OUT for this gender
        let conflict = sqlx::query(
            "SELECT full_name FROM bathroom_log WHERE gender_key = ? AND time_in IS NULL AND log_id != ? LIMIT 1",
        )
        .bind(&gender_key)
        .bind(&log_id)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| e.to_string())?;

        if let Some(active) = conflict {
            let holder: String = active.get("full_name");
            return Err(format!(
                "BATHROOM_KEY_ALREADY_CHECKED_OUT: The {gender_key} bathroom key is currently checked out by {holder}."
            ));
        }

        next_duration_seconds = None;
        next_status = "OUT".to_string();
    }

    let next_notes = if let Some(notes_val) = request.get("notes") {
        if let Some(s) = notes_val.as_str() {
            s.trim().to_string()
        } else {
            current_notes
        }
    } else {
        current_notes
    };

    let now_utc = chrono::Utc::now().to_rfc3339();
    // Optimistic check: the row must still be the one the admin edited (the
    // dialog's copy, else the one read above). A key returned meanwhile
    // would otherwise be flipped back to OUT by the stale empty return time.
    let expected_updated_at: String = request
        .get("expectedUpdatedAt")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| existing.get("updated_at"));

    let updated = sqlx::query(
        "UPDATE bathroom_log SET time_out = ?, time_in = ?, duration_seconds = ?, status = ?, notes = ?, updated_at = ? WHERE log_id = ? AND updated_at = ?",
    )
    .bind(&next_time_out)
    .bind(&next_time_in)
    .bind(next_duration_seconds)
    .bind(&next_status)
    .bind(&next_notes)
    .bind(&now_utc)
    .bind(&log_id)
    .bind(&expected_updated_at)
    .execute(&state.db)
    .await
    .map_err(|e| format!("Failed to update bathroom log: {e}"))?;
    if updated.rows_affected() != 1 {
        return Err("BATHROOM_LOG_CONFLICT: This entry changed since it was opened (the key may have just been returned). Close it and try again.".into());
    }

    Ok(serde_json::json!({
        "success": true,
        "entry": {
            "logId": log_id,
            "logDate": log_date,
            "userId": user_id,
            "fullName": full_name,
            "department": department,
            "genderKey": gender_key,
            "timeOut": next_time_out,
            "timeIn": next_time_in,
            "durationSeconds": next_duration_seconds,
            "status": next_status,
            "notes": next_notes,
            "createdAt": created_at,
            "updatedAt": now_utc
        }
    }))
}

#[tauri::command]
pub(crate) async fn bathroom_update_log(
    state: State<'_, AppState>,
    token: String,
    log_id: String,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    bathroom_update_log_impl(&state, &token, &log_id, &request).await
}

pub(crate) async fn process_bathroom_scan(
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

    // A key the tapper already holds wins over the profile gender, so a holder
    // can always return it even if their gender was changed meanwhile.
    let held_key: Option<String> = sqlx::query_scalar(
        "SELECT gender_key FROM bathroom_log WHERE user_id = ? AND time_in IS NULL LIMIT 1",
    )
    .bind(&user_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    let gender_key = match held_key.as_deref().or(gender_raw.as_deref()) {
        Some("FEMALE") => "FEMALE",
        Some("MALE") => "MALE",
        _ => {
            return Ok(serde_json::json!({
                "success": false,
                "error": {
                    "code": "GENDER_NOT_SET",
                    "message": "Gender is not set for this card. Ask an administrator to set it in Users and RFID."
                }
            }));
        }
    };

    let active_row = sqlx::query(
        "SELECT log_id, user_id, full_name, time_out FROM bathroom_log WHERE gender_key = ? AND time_in IS NULL",
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
        // Holder department for the activeHolder payload (App renders it).
        let holder_department: Option<String> = sqlx::query("SELECT department FROM users WHERE user_id = ?")
            .bind(&active_user_id)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| e.to_string())?
            .and_then(|row| row.get("department"));

        if active_user_id == user_id {
            // RETURNING KEY (Time In)
            let out_dt = chrono::DateTime::parse_from_rfc3339(&active_time_out_str)
                .map(|dt| dt.with_timezone(&Manila))
                .unwrap_or(now_manila);
            let duration_seconds = (now_manila - out_dt).num_seconds().max(0);

            let returned = sqlx::query(
                "UPDATE bathroom_log SET time_in = ?, duration_seconds = ?, status = 'RETURNED', updated_at = ? WHERE log_id = ? AND time_in IS NULL",
            )
            .bind(&now_iso)
            .bind(duration_seconds)
            .bind(&now_iso)
            .bind(&active_log_id)
            .execute(&state.db)
            .await
            .map_err(|e| e.to_string())?;
            // T10: a concurrent return flipped this row after the SELECT.
            if returned.rows_affected() != 1 {
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
                        "department": holder_department,
                        "genderKey": gender_key,
                        "timeOut": active_time_out_str
                    }
                }));
            }

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
                    "department": holder_department,
                    "genderKey": gender_key,
                    "timeOut": active_time_out_str
                }
            }));
        }
    }

    // CHECKOUT KEY (Time Out)
    let log_id = uuid::Uuid::new_v4().to_string();
    let inserted = sqlx::query(
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
    .await;
    // T10: concurrent checkout raced past the SELECT — the partial unique
    // index is the atomic backstop; map its violation to a conflict, not a
    // generic failure, and re-read the winner for an accurate message.
    if let Err(e) = inserted {
        let code = e
            .as_database_error()
            .and_then(|db_err| db_err.code())
            .map(|c| c.into_owned())
            .unwrap_or_default();
        if code != "2067" && code != "1555" && !e.to_string().contains("UNIQUE constraint failed") {
            return Err(e.to_string());
        }
        let holder: Option<String> = sqlx::query_scalar("SELECT full_name FROM bathroom_log WHERE gender_key = ? AND time_in IS NULL LIMIT 1")
            .bind(gender_key)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| e.to_string())?
            .flatten();
        return Ok(serde_json::json!({
            "success": false,
            "error": {
                "code": "BATHROOM_KEY_IN_USE",
                "message": format!("The {} bathroom key is currently in use{}.", if gender_key == "MALE" { "male" } else { "female" }, holder.map(|h| format!(" by {h}")).unwrap_or_default())
            },
            "genderKey": gender_key
        }));
    }

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
pub(crate) async fn bathroom_scan_rfid(
    state: State<'_, AppState>,
    rfid_uid: String,
) -> Result<serde_json::Value, String> {
    process_bathroom_scan(&state, &rfid_uid).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::*;
    use crate::services::users::upsert_user_record;
    

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
        upsert_user_record(
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

        upsert_user_record(
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
        let res1 = process_bathroom_scan(&state, "A1B2C3D4").await.unwrap();
        assert_eq!(res1["success"], true);
        assert_eq!(res1["action"], "CHECKOUT");
        assert_eq!(res1["genderKey"], "MALE");
        assert_eq!(res1["user"]["fullName"], "John Doe");

        // 2. Second scan by Bob Smith (different user, same gender): CONFLICT
        let res2 = process_bathroom_scan(&state, "E5F6A7B8").await.unwrap();
        assert_eq!(res2["success"], false);
        assert_eq!(res2["error"]["code"], "BATHROOM_KEY_IN_USE");
        assert_eq!(res2["activeHolder"]["fullName"], "John Doe");

        // 3. Third scan by John Doe: RETURN Male Key
        let res3 = process_bathroom_scan(&state, "A1B2C3D4").await.unwrap();
        assert_eq!(res3["success"], true);
        assert_eq!(res3["action"], "RETURN");
        assert_eq!(res3["genderKey"], "MALE");
        assert_eq!(res3["user"]["fullName"], "John Doe");

        // 4. Fourth scan by Bob Smith: Now CHECKOUT succeeds for Bob
        let res4 = process_bathroom_scan(&state, "E5F6A7B8").await.unwrap();
        assert_eq!(res4["success"], true);
        assert_eq!(res4["action"], "CHECKOUT");
        assert_eq!(res4["user"]["fullName"], "Bob Smith");

        // 5. A card with no gender on file is refused instead of getting the male key.
        upsert_user_record(
            &state.db,
            "EMP_03",
            "C9D8E7F6",
            "Casey Unset",
            Some("Interns"),
            "ACTIVE",
            "INTERN",
            None,
            Some(8_000),
            None,
            None,
            "EMPLOYEE",
            "2026-08-27T00:00:00Z",
        )
        .await
        .unwrap();
        let res5 = process_bathroom_scan(&state, "C9D8E7F6").await.unwrap();
        assert_eq!(res5["success"], false);
        assert_eq!(res5["error"]["code"], "GENDER_NOT_SET");
        let unset_logs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bathroom_log WHERE user_id = 'EMP_03'")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(unset_logs, 0);

        // 6. A holder whose gender was cleared can still return the key they hold.
        sqlx::query("UPDATE users SET gender = NULL WHERE user_id = 'EMP_02'")
            .execute(&state.db)
            .await
            .unwrap();
        let res6 = process_bathroom_scan(&state, "E5F6A7B8").await.unwrap();
        assert_eq!(res6["success"], true);
        assert_eq!(res6["action"], "RETURN");
        assert_eq!(res6["genderKey"], "MALE");

        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[tokio::test]
    async fn bathroom_concurrent_scan_keeps_single_active_key() {
        // T10: two simultaneous taps for the same key must not double-issue it.
        // The loser always lands on IN_USE — either via the SELECT seeing the
        // winner's row, or via the partial unique index on the INSERT race.
        let temp = std::env::temp_dir().join(format!("alpha-bathroom-race-{}", uuid::Uuid::new_v4()));
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
        for (user_id, rfid, name) in [("EMP_01", "A1B2C3D4", "John Doe"), ("EMP_02", "E5F6A7B8", "Bob Smith")] {
            upsert_user_record(
                &state.db,
                user_id,
                rfid,
                name,
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
        }
        let (first, second) = tokio::join!(
            process_bathroom_scan(&state, "A1B2C3D4"),
            process_bathroom_scan(&state, "E5F6A7B8")
        );
        let first = first.unwrap();
        let second = second.unwrap();
        let first_checkout = first["action"].as_str() == Some("CHECKOUT");
        let second_checkout = second["action"].as_str() == Some("CHECKOUT");
        assert!(first_checkout ^ second_checkout, "exactly one checkout wins");
        for outcome in [&first, &second] {
            if outcome["success"].as_bool() == Some(true) {
                assert_eq!(outcome["action"].as_str(), Some("CHECKOUT"));
            } else {
                assert_eq!(outcome["error"]["code"].as_str(), Some("BATHROOM_KEY_IN_USE"));
            }
        }
        let active: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM bathroom_log WHERE gender_key = 'MALE' AND time_in IS NULL")
                .fetch_one(&state.db)
                .await
                .expect("count");
        assert_eq!(active, 1);
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[tokio::test]
    async fn bathroom_edit_rejects_dates_outside_log_date() {
        // T4: edited timestamps must fall on the stored log_date (Manila).
        let temp = std::env::temp_dir().join(format!("alpha-bathroom-date-{}", uuid::Uuid::new_v4()));
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
            &state.db,
            "EMP_01",
            "CARD_01",
            "Ramil C. Roque",
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
        .expect("user row for FK");
        let now_utc = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO bathroom_log (log_id, log_date, user_id, full_name, department, gender_key, time_out, time_in, duration_seconds, status, notes, created_at, updated_at) VALUES ('LOG-1', '2026-08-31', 'EMP_01', 'Ramil C. Roque', 'IT', 'MALE', '2026-08-31T10:00:00+08:00', NULL, NULL, 'OUT', '', ?, ?)",
        )
        .bind(&now_utc)
        .bind(&now_utc)
        .execute(&state.db)
        .await
        .unwrap();
        // Return stamped on the next day must be rejected, not silently stored.
        let bad = serde_json::json!({
            "timeOut": "2026-08-31T10:00:00+08:00",
            "timeIn": "2026-09-01T10:15:00+08:00",
            "notes": ""
        });
        let err = bathroom_update_log_impl(&state, &token, "LOG-1", &bad)
            .await
            .unwrap_err();
        assert!(err.contains("must fall on the log date"));
        // Same-date edit succeeds.
        let good = serde_json::json!({
            "timeOut": "2026-08-31T10:00:00+08:00",
            "timeIn": "2026-08-31T10:15:00+08:00",
            "notes": ""
        });
        let updated = bathroom_update_log_impl(&state, &token, "LOG-1", &good)
            .await
            .expect("same-date edit");
        assert_eq!(updated["entry"]["status"].as_str(), Some("RETURNED"));
        // Stale dialog: opened while the key was OUT (updatedAt = now_utc), the
        // return landed, then Save sent the old empty return time. It must
        // conflict instead of showing the returned key as OUT again.
        let stale = serde_json::json!({
            "timeOut": "2026-08-31T10:00:00+08:00",
            "timeIn": null,
            "notes": "",
            "expectedUpdatedAt": now_utc
        });
        let err = bathroom_update_log_impl(&state, &token, "LOG-1", &stale)
            .await
            .unwrap_err();
        assert!(err.starts_with("BATHROOM_LOG_CONFLICT"), "{err}");
        let status: String = sqlx::query_scalar("SELECT status FROM bathroom_log WHERE log_id='LOG-1'")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(status, "RETURNED");
        // A deliberate re-open from the current row still works.
        let reopen = serde_json::json!({
            "timeOut": "2026-08-31T10:00:00+08:00",
            "timeIn": null,
            "notes": "",
            "expectedUpdatedAt": updated["entry"]["updatedAt"]
        });
        let reopened = bathroom_update_log_impl(&state, &token, "LOG-1", &reopen)
            .await
            .expect("current-row edit");
        assert_eq!(reopened["entry"]["status"].as_str(), Some("OUT"));
    }

    #[tokio::test]
    async fn bathroom_update_log_flow() {
        let temp = std::env::temp_dir().join(format!("alpha-bathroom-update-{}", uuid::Uuid::new_v4()));
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

        let token = "test-admin-token".to_string();
        *state.admin_session.lock().await = Some(crate::state::AdminSession {
            token: token.clone(),
            expires_at: std::time::Instant::now() + std::time::Duration::from_secs(3600),
        });

        upsert_user_record(
            &state.db,
            "EMP_01",
            "CARD_01",
            "Ramil C. Roque",
            Some("IT/ Marketing Associate"),
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

        // 1. Check out Male key
        let log_id = uuid::Uuid::new_v4().to_string();
        let now_utc = chrono::Utc::now().to_rfc3339();

        sqlx::query(
            "INSERT INTO bathroom_log (log_id, log_date, user_id, full_name, department, gender_key, time_out, time_in, duration_seconds, status, notes, created_at, updated_at) VALUES (?, '2026-08-31', 'EMP_01', 'Ramil C. Roque', 'IT/ Marketing Associate', 'MALE', '2026-08-31T10:00:00+08:00', NULL, NULL, 'OUT', '', ?, ?)",
        )
        .bind(&log_id)
        .bind(&now_utc)
        .bind(&now_utc)
        .execute(&state.db)
        .await
        .unwrap();

        // 2. Update log with return time and notes
        let update_req = serde_json::json!({
            "timeOut": "2026-08-31T10:00:00+08:00",
            "timeIn": "2026-08-31T10:15:00+08:00",
            "notes": "Forgot to tap back in"
        });

        let updated = bathroom_update_log_impl(
            &state,
            &token,
            &log_id,
            &update_req,
        )
        .await
        .unwrap();

        assert_eq!(updated["success"], true);
        assert_eq!(updated["entry"]["status"], "RETURNED");
        assert_eq!(updated["entry"]["durationSeconds"], 900);
        assert_eq!(updated["entry"]["notes"], "Forgot to tap back in");
        assert_eq!(updated["entry"]["timeOut"], "2026-08-31T10:00:00+08:00");
        assert_eq!(updated["entry"]["timeIn"], "2026-08-31T10:15:00+08:00");

        // 3. Invalid return time (before checkout) must fail
        let invalid_req = serde_json::json!({
            "timeOut": "2026-08-31T10:15:00+08:00",
            "timeIn": "2026-08-31T10:00:00+08:00",
        });
        let invalid_res = bathroom_update_log_impl(
            &state,
            &token,
            &log_id,
            &invalid_req,
        )
        .await;
        assert!(invalid_res.is_err());

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

        upsert_user_record(
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

        upsert_user_record(
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
}
