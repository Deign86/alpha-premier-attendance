//! Saving and deleting a user: the one place the rules for a person's row live,
//! for an administrator's save and for the ID register's.

use crate::state::AppState;
use crate::{enqueue_sync_on, publish_attendance_change};
use chrono_tz::Asia::Manila;
use sqlx::Row;

/// Voice auto-clone gate: roster members (active interns/employees) get a name
/// clip; assist cards, inactive users, and unknown types never enqueue.
fn should_enqueue_voice_job(card_type: &str, employee_type: &str, status: &str) -> bool {
    card_type != "ADMIN_ASSIST"
        && employee_type.eq_ignore_ascii_case("INTERN")
        && status.eq_ignore_ascii_case("ACTIVE")
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

pub(crate) async fn upsert_user_record<'c, E>(
    db: E,
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
) -> Result<u64, sqlx::Error>
where
    E: sqlx::Executor<'c, Database = sqlx::Sqlite>,
{
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

/// Who is saving a user. An administrator's save creates or changes; the ID
/// register only ever adds a person the kiosk does not have yet.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum SaveOrigin {
    Administrator,
    IdRegister,
}

pub(crate) async fn save_user(
    state: &AppState,
    user: serde_json::Value,
    origin: SaveOrigin,
) -> Result<serde_json::Value, String> {
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

    if !is_assist
        && user.get("employeeType").and_then(|v| v.as_str()).is_some_and(|value| value != "INTERN")
    {
        return Err("ADMIN_VALIDATION_ERROR".into());
    }
    let employee_type = "INTERN";

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

    let daily_rate = None;

    let photo_cleared = match user.get("photoUrl") {
        Some(serde_json::Value::Null) => true,
        Some(serde_json::Value::String(s)) => s.trim().is_empty(),
        _ => false,
    };
    if photo_cleared {
        let local_photo = state.data_dir.join("photos").join(format!("{user_id}.webp"));
        if local_photo.exists() {
            let _ = std::fs::remove_file(&local_photo);
        }
    }

    let photo_url_arg = if is_assist || photo_cleared {
        None
    } else {
        user.get("photoUrl")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
    };

    let now = chrono::Utc::now().to_rfc3339();
    let mut tx = state.db.begin().await.map_err(|e| e.to_string())?;
    // A deactivated person can no longer scan (O7): today's open day could
    // never be timed out and a held bathroom key would block everyone of
    // that gender. Time them out or return the key first.
    if status.eq_ignore_ascii_case("INACTIVE") {
        let today = chrono::Utc::now().with_timezone(&chrono_tz::Asia::Manila).date_naive().to_string();
        let open_today: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attendance WHERE user_id = ? AND attendance_date = ? AND time_in IS NOT NULL AND time_out IS NULL")
            .bind(&user_id).bind(&today).fetch_one(&mut *tx).await.map_err(|e| e.to_string())?;
        if open_today > 0 {
            return Err("USER_HAS_OPEN_DAY".into());
        }
        let holds_key: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bathroom_log WHERE user_id = ? AND time_in IS NULL")
            .bind(&user_id).fetch_one(&mut *tx).await.map_err(|e| e.to_string())?;
        if holds_key > 0 {
            return Err("USER_HOLDS_BATHROOM_KEY".into());
        }
    }
    // Checked inside the save's own transaction, so a person an administrator
    // registers at the same moment keeps the card they were just given.
    if origin == SaveOrigin::IdRegister {
        let already: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE user_id = ?")
            .bind(&user_id).fetch_one(&mut *tx).await.map_err(|e| e.to_string())?;
        if already > 0 {
            return Ok(serde_json::json!({"success":true,"created":false,"userId":&user_id}));
        }
    }
    let result = upsert_user_record(
        &mut *tx,
        &user_id,
        &rfid_uid,
        &full_name,
        department,
        status,
        employee_type,
        gender.as_deref(),
        daily_rate,
        None,
        photo_url_arg,
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
    // The Users sync row commits with the save (O4).
    enqueue_sync_on(state, &mut tx, "Users", &user_id, "UPSERT", &user).await;
    tx.commit().await.map_err(|e| e.to_string())?;
    let (audit_event, audit_message, audit_prefix) = match origin {
        SaveOrigin::Administrator => ("ADMIN_USER_UPSERT", "User profile saved by administrator", "admin"),
        SaveOrigin::IdRegister => ("ID_REGISTER_PULL", "New intern added from the ID register, waiting for a card", "id-register"),
    };
    let _ = sqlx::query("INSERT INTO audit_logs (log_id, timestamp, event_type, user_id, message, request_id) VALUES (?, ?, ?, ?, ?, ?)").bind(uuid::Uuid::new_v4().to_string()).bind(&now).bind(audit_event).bind(&user_id).bind(audit_message).bind(format!("{audit_prefix}-{}", uuid::Uuid::new_v4())).execute(&state.db).await;
    // Voice auto-clone: queue a Ma'am Bea name-clip pull for roster members.
    // Fire-and-forget — the worker fills the clip later; Piper covers playback meanwhile.
    // A person the bundle already voices (pre-generated before registering) keeps that clip.
    let bundled = crate::services::voice_pull::BUNDLED_NAME_MANIFEST
        .get()
        .is_some_and(|manifest| crate::services::voice_pull::bundled_clip_covers(manifest, &user_id, &full_name));
    if should_enqueue_voice_job(card_type, employee_type, status) && !bundled {
        crate::services::voice_pull::enqueue_voice_job(&state.db, &user_id, &full_name, &now).await;
    }
    if !is_assist && employee_type.to_uppercase() == "INTERN" && status.to_uppercase() == "ACTIVE" {
        let _ = sqlx::query(
            "INSERT INTO dtr_pending (user_id, full_name, first_seen, last_checked, attempts) VALUES (?, ?, ?, NULL, 0) ON CONFLICT(user_id) DO UPDATE SET full_name = excluded.full_name",
        )
        .bind(&user_id)
        .bind(&full_name)
        .bind(&now)
        .execute(&state.db)
        .await;
    }
    Ok(serde_json::json!({"success":true,"created":result == 1,"userId":&user_id}))
}

pub(crate) async fn delete_user_and_cascade(state: &AppState, user_id: &str) -> Result<(), String> {
    let user_exists = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users WHERE user_id = ?")
        .bind(user_id)
        .fetch_one(&state.db)
        .await
        .map_err(|e| e.to_string())?
        > 0;
    if !user_exists {
        return Err("USER_NOT_FOUND".into());
    }
    // One transaction: a failure part-way (or a scan racing the cascade)
    // used to leave attendance, payroll and cutoffs deleted while the user
    // stayed, with no Sheets deletes queued. Now it is all or nothing.
    let mut tx = state.db.begin().await.map_err(|e| e.to_string())?;

    // 1. Capture cutoff payroll records to delete & sync
    let cutoff_rows = sqlx::query(
        "SELECT payroll_id, employee_id, employee_name, payroll_cutoff_label, cutoff_start, cutoff_end FROM payroll_cutoffs WHERE employee_id = ? AND status <> 'FINALIZED'"
    )
    .bind(user_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

    // 2. Capture daily attendance payroll IDs to delete & sync
    let daily_payroll_ids: Vec<String> = sqlx::query(
        "SELECT payroll_id FROM payroll WHERE user_id = ?"
    )
    .bind(user_id)
    .fetch_all(&mut *tx)
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
    .fetch_all(&mut *tx)
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
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| e.to_string())?
    .into_iter()
    .map(|r| r.get::<String, _>("grace_id"))
    .collect();

    // Execute deletions in database
    sqlx::query(
        "DELETE FROM payroll_snapshots WHERE payroll_id IN (SELECT payroll_id FROM payroll_cutoffs WHERE employee_id = ? AND status <> 'FINALIZED')"
    )
    .bind(user_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

    // Approved pay outlives the person (owner decision D2, 2026-11-06):
    // FINALIZED cutoffs and their snapshots stay; only drafts go.
    sqlx::query("DELETE FROM payroll_cutoffs WHERE employee_id = ? AND status <> 'FINALIZED'")
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("DELETE FROM payroll WHERE user_id = ?")
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("DELETE FROM intern_grace WHERE user_id = ?")
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("DELETE FROM attendance WHERE user_id = ?")
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("DELETE FROM bathroom_log WHERE user_id = ?")
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("DELETE FROM dtr_pending WHERE user_id = ?")
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("DELETE FROM dtr_recon_discrepancies WHERE user_id = ?")
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    let result = sqlx::query("DELETE FROM users WHERE user_id = ?")
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    if result.rows_affected() != 1 {
        return Err("USER_NOT_FOUND".into());
    }
    // Queue the Sheets deletions with the delete itself (O4).
    enqueue_sync_on(
        state,
        &mut tx,
        "Users",
        user_id,
        "DELETE",
        &serde_json::json!({"userId": user_id}),
    )
    .await;

    for row in cutoff_rows {
        let pid: String = row.get("payroll_id");
        enqueue_sync_on(
            state,
            &mut tx,
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
        enqueue_sync_on(
            state,
            &mut tx,
            "Payroll",
            &pid,
            "DELETE",
            &serde_json::json!({"payrollId": pid, "userId": user_id}),
        )
        .await;
    }

    let had_attendance = !attendance_rows.is_empty();
    for (aid, adate) in attendance_rows {
        enqueue_sync_on(
            state,
            &mut tx,
            "Attendance",
            &aid,
            "DELETE",
            &serde_json::json!({"attendanceId": aid, "attendanceDate": adate}),
        )
        .await;
    }

    for gid in grace_ids {
        enqueue_sync_on(
            state,
            &mut tx,
            "InternGrace",
            user_id,
            "DELETE",
            &serde_json::json!({"userId": user_id, "graceId": gid}),
        )
        .await;
    }

    tx.commit().await.map_err(|e| e.to_string())?;
    if had_attendance {
        let today = chrono::Utc::now().with_timezone(&Manila).date_naive().to_string();
        publish_attendance_change(state, "", &today, "USER_DELETED", "refetch");
    }

    let photo_path = state.data_dir.join("photos").join(format!("{user_id}.webp"));
    if photo_path.exists() {
        let _ = std::fs::remove_file(&photo_path);
    }

    // Voice auto-clone cleanup: drop any queued/done job and the worker clip
    // so a deleted user leaves no stale audio behind.
    let _ = sqlx::query("DELETE FROM voice_jobs WHERE person_id = ?")
        .bind(user_id)
        .execute(&state.db)
        .await;
    let clip_path = crate::services::voice_pull::clip_path(&state.data_dir, user_id);
    if clip_path.is_file() {
        let _ = std::fs::remove_file(&clip_path);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voice_jobs_enqueue_only_for_active_roster_members() {
        assert!(should_enqueue_voice_job("EMPLOYEE", "INTERN", "ACTIVE"));
        assert!(!should_enqueue_voice_job("EMPLOYEE", "EMPLOYEE", "active"));
        assert!(!should_enqueue_voice_job("ADMIN_ASSIST", "INTERN", "ACTIVE"));
        assert!(!should_enqueue_voice_job("EMPLOYEE", "INTERN", "INACTIVE"));
        assert!(!should_enqueue_voice_job("EMPLOYEE", "VISITOR", "ACTIVE"));
    }

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

    #[test]
    fn test_normalize_name() {
        assert_eq!(normalize_name("   john   doe   "), "John Doe");
        assert_eq!(normalize_name("MARY-ANNE"), "Mary-Anne");
        assert_eq!(normalize_name("o'connor"), "O'Connor");
        assert_eq!(normalize_name("o’neill"), "O’Neill");
        assert_eq!(normalize_name("ma. teresa"), "Ma. Teresa");
        assert_eq!(normalize_name(""), "");
    }
}
