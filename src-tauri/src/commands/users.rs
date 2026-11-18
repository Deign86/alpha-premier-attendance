use crate::services::users::SaveOrigin;
use crate::services::users::delete_user_and_cascade;
use crate::services::users::save_user;
use crate::state::AppState;
use sqlx::Row;
use super::session::admin_authorized;
use tauri::State;

pub(crate) fn resolve_user_photo_url(
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
pub(crate) async fn admin_users(
    state: State<'_, AppState>,
    token: String,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    let rows = sqlx::query("SELECT user_id, rfid_uid, full_name, department, status, employee_type, gender, daily_rate_centavos, payroll_profile_id, photo_url, card_type FROM users WHERE employee_type = 'INTERN' OR card_type = 'ADMIN_ASSIST' ORDER BY full_name")
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
pub(crate) async fn admin_list_users(
    state: State<'_, AppState>,
    token: String,
) -> Result<serde_json::Value, String> {
    admin_users(state, token).await
}

pub(crate) async fn admin_upsert_user_inner(
    state: &AppState,
    user: serde_json::Value,
) -> Result<serde_json::Value, String> {
    save_user(state, user, SaveOrigin::Administrator).await
}

#[tauri::command]
pub(crate) async fn admin_upsert_user(
    state: State<'_, AppState>,
    token: String,
    user: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("ADMIN_AUTH_REQUIRED".into());
    }
    admin_upsert_user_inner(state.inner(), user).await
}

#[tauri::command]
pub(crate) async fn admin_create_user(
    state: State<'_, AppState>,
    token: String,
    user: serde_json::Value,
) -> Result<serde_json::Value, String> {
    admin_upsert_user(state, token, user).await
}

/// BUG-DB-02: translate raw SQLite FK violations into a user-friendly error
/// instead of leaking the opaque constraint message to the admin panel.
pub(crate) fn friendly_delete_user_error(error: String) -> String {
    if error.contains("FOREIGN KEY") {
        "USER_HAS_RECORDS: Cannot delete user because historical attendance or bathroom records depend on this account. Deactivate the user instead.".to_string()
    } else {
        error
    }
}

#[tauri::command]
pub(crate) async fn admin_delete_user(
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
pub(crate) async fn setup_lookup_card(
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
pub(crate) async fn setup_upsert_user(
    state: State<'_, AppState>,
    token: String,
    user: serde_json::Value,
) -> Result<serde_json::Value, String> {
    admin_upsert_user(state, token, user).await
}

pub(crate) async fn upload_photo_inner(
    state: &AppState,
    user_id: &str,
    base64_data: &str,
) -> Result<serde_json::Value, String> {
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
                .unwrap_or(base64_data),
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
    let photo_url = format!("asset://localhost/{asset_path}");
    let now = chrono::Utc::now().to_rfc3339();
    let _ = sqlx::query(
        "UPDATE users SET photo_url = ?, revision = revision + 1, updated_at = ? WHERE user_id = ?",
    )
    .bind(&photo_url)
    .bind(&now)
    .bind(user_id)
    .execute(&state.db)
    .await;
    Ok(serde_json::json!({"success":true,"photoUrl":photo_url}))
}

#[tauri::command]
pub(crate) async fn upload_photo(
    state: State<'_, AppState>,
    token: String,
    user_id: String,
    base64_data: String,
) -> Result<serde_json::Value, String> {
    if !admin_authorized(&state, &token).await {
        return Err("SETUP_AUTH_REQUIRED".into());
    }
    upload_photo_inner(state.inner(), &user_id, &base64_data).await
}

pub(crate) const MAX_PHOTO_BYTES: usize = 500 * 1024;

pub(crate) fn photo_is_within_limits(width: u32, height: u32, bytes: usize) -> bool {
    width <= 4096 && height <= 4096 && bytes <= MAX_PHOTO_BYTES
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::*;
    
    use crate::services::users::upsert_user_record;

    #[test]
    fn accepts_large_id_photo_dimensions_and_file_size() {
        assert!(!photo_is_within_limits(1993, 3137, 3_277_122));
    }

    #[test]
    fn accepts_photos_at_or_below_500_kib() {
        assert!(photo_is_within_limits(512, 512, 500 * 1024));
        assert!(!photo_is_within_limits(512, 512, 500 * 1024 + 1));
    }

    #[tokio::test]
    async fn upload_photo_updates_existing_user_and_clearing_deletes_file() {
        let temp = std::env::temp_dir().join(format!("alpha-photo-test-{}", uuid::Uuid::new_v4()));
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

        let user_id = "EMP-PHOTO-TEST";

        // Create user with no photo
        upsert_user_record(
            &state.db,
            user_id,
            "RFID-PHOTO-1",
            "Photo Test User",
            Some("IT"),
            "ACTIVE",
            "INTERN",
            Some("MALE"),
            None,
            None,
            None,
            "EMPLOYEE",
            "2026-08-01T00:00:00Z",
        )
        .await
        .unwrap();

        // 1x1 transparent PNG base64
        let png_base64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

        // Upload photo for existing user
        let upload_res = upload_photo_inner(&state, user_id, png_base64).await.unwrap();
        assert_eq!(upload_res["success"], true);
        let photo_url = upload_res["photoUrl"].as_str().unwrap();
        assert!(photo_url.starts_with("asset://localhost/"));

        // Verify users table was updated with photo_url and revision incremented
        let (stored_url, revision): (Option<String>, i64) = sqlx::query_as(
            "SELECT photo_url, revision FROM users WHERE user_id = ?"
        )
        .bind(user_id)
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(stored_url.as_deref(), Some(photo_url));
        assert_eq!(revision, 2);

        // Verify file exists on disk
        let disk_photo = state.data_dir.join("photos").join(format!("{user_id}.webp"));
        assert!(disk_photo.exists());

        // Now clear photo via admin_upsert_user_inner with photoUrl: null
        let update_payload = serde_json::json!({
            "userId": user_id,
            "rfidUid": "RFID-PHOTO-1",
            "fullName": "Photo Test User",
            "department": "IT",
            "status": "ACTIVE",
            "employeeType": "INTERN",
            "gender": "MALE",
            "photoUrl": null,
        });
        let upsert_res = admin_upsert_user_inner(&state, update_payload).await.unwrap();
        assert_eq!(upsert_res["success"], true);

        // Verify photo file on disk was removed
        assert!(!disk_photo.exists());

        // Verify resolve_user_photo_url now returns None
        let resolved = resolve_user_photo_url(&state.data_dir, user_id, None);
        assert_eq!(resolved, None);

        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[tokio::test]
    async fn admin_assist_registration_is_not_queued_for_dtr() {
        let temp = std::env::temp_dir().join(format!("alpha-assist-dtr-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(temp.join("exports")).unwrap();
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

        admin_upsert_user_inner(&state, serde_json::json!({ "rfidUid": "ADA001", "cardType": "ADMIN_ASSIST", "status": "ACTIVE" }))
            .await
            .unwrap();
        admin_upsert_user_inner(&state, serde_json::json!({ "userId": "APG-T-1", "rfidUid": "INT001", "fullName": "Test Intern", "status": "ACTIVE" }))
            .await
            .unwrap();

        let pending: Vec<String> = sqlx::query_scalar("SELECT user_id FROM dtr_pending ORDER BY user_id")
            .fetch_all(&state.db)
            .await
            .unwrap();
        assert_eq!(pending, vec!["APG-T-1".to_string()]);

        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn foreign_key_delete_error_is_translated() {
        // BUG-DB-02: SQLite FK violations surface a friendly message.
        let translated = friendly_delete_user_error(
            "database error: FOREIGN KEY constraint failed".into(),
        );
        assert!(translated.starts_with("USER_HAS_RECORDS:"));
        assert!(translated.contains("Deactivate the user instead"));
        // Other errors pass through unchanged.
        assert_eq!(
            friendly_delete_user_error("USER_NOT_FOUND".into()),
            "USER_NOT_FOUND"
        );
    }

    #[tokio::test]
    async fn deactivation_refuses_while_a_day_or_key_is_open() {
        // O7: a deactivated person can no longer scan, so today's open day
        // and a held bathroom key would stay stuck.
        let (state, temp, _token) = admin_test_state("deactivate").await;
        add_intern(&state, "INT_D", "C0FFEE13").await;
        let today = chrono::Utc::now().with_timezone(&chrono_tz::Asia::Manila).date_naive().to_string();
        sqlx::query("INSERT INTO attendance (attendance_id,attendance_date,user_id,rfid_uid,full_name,department,time_in,time_out,status,source,created_at,updated_at) VALUES ('att-d',?,'INT_D','C0FFEE13','INT_D','IT',?,NULL,'WORKING','RFID',?,?)")
            .bind(&today).bind(format!("{today}T08:00:00+08:00")).bind(&today).bind(&today)
            .execute(&state.db).await.unwrap();
        let deactivate = || admin_upsert_user_inner(&state, serde_json::json!({
            "userId": "INT_D", "rfidUid": "C0FFEE13", "fullName": "INT_D", "department": "IT",
            "status": "INACTIVE", "employeeType": "INTERN", "gender": "MALE",
        }));
        assert_eq!(deactivate().await.unwrap_err(), "USER_HAS_OPEN_DAY");
        sqlx::query("UPDATE attendance SET time_out=?, status='COMPLETED' WHERE attendance_id='att-d'")
            .bind(format!("{today}T17:00:00+08:00")).execute(&state.db).await.unwrap();
        sqlx::query("INSERT INTO bathroom_log (log_id, log_date, user_id, full_name, department, gender_key, time_out, time_in, duration_seconds, status, notes, created_at, updated_at) VALUES ('bath-d', ?, 'INT_D', 'INT_D', 'IT', 'MALE', ?, NULL, NULL, 'OUT', '', ?, ?)")
            .bind(&today).bind(format!("{today}T10:00:00+08:00")).bind(&today).bind(&today)
            .execute(&state.db).await.unwrap();
        assert_eq!(deactivate().await.unwrap_err(), "USER_HOLDS_BATHROOM_KEY");
        sqlx::query("UPDATE bathroom_log SET time_in=?, status='RETURNED' WHERE log_id='bath-d'")
            .bind(format!("{today}T10:10:00+08:00")).execute(&state.db).await.unwrap();
        assert_eq!(deactivate().await.unwrap()["success"], true);
        let status: String = sqlx::query_scalar("SELECT status FROM users WHERE user_id='INT_D'")
            .fetch_one(&state.db).await.unwrap();
        assert_eq!(status, "INACTIVE");
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
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
        upsert_user_record(
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
        delete_user_and_cascade(&state, "EMP-DEL-TEST").await.unwrap();

        // Verify user and cutoffs are gone
        let user_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE user_id = 'EMP-DEL-TEST'")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(user_count, 0);

        // D2 (owner decision 2026-11-06): the FINALIZED cutoff is approved
        // pay and stays after the person is deleted.
        let cutoff_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM payroll_cutoffs WHERE employee_id = 'EMP-DEL-TEST'")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(cutoff_count, 1);

        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[tokio::test]
    async fn user_deletion_is_all_or_nothing() {
        // A user delete that fails at its last step must not have already
        // removed the person's attendance and cutoffs.
        let temp = std::env::temp_dir().join(format!("alpha-user-del-atomic-{}", uuid::Uuid::new_v4()));
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
            &state.db, "EMP-1", "RFID-ATOMIC", "Ada Lovelace", Some("QA"), "ACTIVE", "INTERN",
            Some("FEMALE"), None, Some("BEA_STANDARD"), None, "EMPLOYEE", "2026-08-01T00:00:00Z",
        )
        .await
        .unwrap();
        sqlx::query("INSERT INTO attendance (attendance_id,attendance_date,user_id,rfid_uid,full_name,department,time_in,time_out,status,source,created_at,updated_at) VALUES ('att-1','2026-08-03','EMP-1','RFID-ATOMIC','Ada Lovelace','QA','2026-08-03T08:00:00+08:00','2026-08-03T17:00:00+08:00','COMPLETED','RFID','2026-08-03T00:00:00Z','2026-08-03T00:00:00Z')")
            .execute(&state.db)
            .await
            .unwrap();
        insert_cutoff_row(&state.db, "PAY-FIN", "FINALIZED").await;
        // Stand-in for the last step failing (e.g. a bathroom tap's FK row).
        sqlx::query("CREATE TRIGGER block_user_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'forced user delete failure'); END")
            .execute(&state.db)
            .await
            .unwrap();

        assert!(delete_user_and_cascade(&state, "EMP-1").await.is_err());
        let count = |sql: &'static str| {
            let db = state.db.clone();
            async move { sqlx::query_scalar::<_, i64>(sql).fetch_one(&db).await.unwrap() }
        };
        assert_eq!(count("SELECT COUNT(*) FROM users WHERE user_id='EMP-1'").await, 1);
        assert_eq!(count("SELECT COUNT(*) FROM attendance WHERE user_id='EMP-1'").await, 1);
        assert_eq!(count("SELECT COUNT(*) FROM payroll_cutoffs WHERE employee_id='EMP-1'").await, 1);
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[tokio::test]
    async fn user_deletion_cascades_with_bathroom_log_and_pending_records() {
        let temp = std::env::temp_dir().join(format!("alpha-bath-del-{}", uuid::Uuid::new_v4()));
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

        let user_id = "EMP-BATH-TEST";

        // Create user
        upsert_user_record(
            &state.db,
            user_id,
            "RFID-BATH-1",
            "Bathroom Test User",
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

        // Create completed bathroom_log record
        sqlx::query(
            "INSERT INTO bathroom_log (log_id, log_date, user_id, full_name, department, gender_key, time_out, time_in, duration_seconds, status, notes, created_at, updated_at) VALUES ('BATH-DONE-1', '2026-08-31', ?, 'Bathroom Test User', 'Engineering', 'MALE', '2026-08-31T09:00:00+08:00', '2026-08-31T09:10:00+08:00', 600, 'RETURNED', '', '2026-08-31T09:00:00+08:00', '2026-08-31T09:10:00+08:00')"
        )
        .bind(user_id)
        .execute(&state.db)
        .await
        .unwrap();

        // Create active (open) bathroom_log record
        sqlx::query(
            "INSERT INTO bathroom_log (log_id, log_date, user_id, full_name, department, gender_key, time_out, time_in, duration_seconds, status, notes, created_at, updated_at) VALUES ('BATH-ACT-1', '2026-08-31', ?, 'Bathroom Test User', 'Engineering', 'MALE', '2026-08-31T10:00:00+08:00', NULL, NULL, 'OUT', '', '2026-08-31T10:00:00+08:00', '2026-08-31T10:00:00+08:00')"
        )
        .bind(user_id)
        .execute(&state.db)
        .await
        .unwrap();

        // Create dtr_pending record
        sqlx::query(
            "INSERT INTO dtr_pending (user_id, full_name, first_seen, last_checked, attempts) VALUES (?, 'Bathroom Test User', '2026-08-31T00:00:00Z', NULL, 0)"
        )
        .bind(user_id)
        .execute(&state.db)
        .await
        .unwrap();

        // Create dtr_recon_runs and dtr_recon_discrepancies record
        sqlx::query(
            "INSERT INTO dtr_recon_runs (run_id, started_at, status, report_only, summary_json) VALUES ('RUN-1', '2026-08-31T00:00:00Z', 'COMPLETED', 1, '{}')"
        )
        .execute(&state.db)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO dtr_recon_discrepancies (run_id, user_id, full_name, attendance_date, action_taken) VALUES ('RUN-1', ?, 'Bathroom Test User', '2026-08-31', 'REPORTED')"
        )
        .bind(user_id)
        .execute(&state.db)
        .await
        .unwrap();

        // Create dummy photo file on disk
        let photos_dir = state.data_dir.join("photos");
        std::fs::create_dir_all(&photos_dir).unwrap();
        let photo_file = photos_dir.join(format!("{user_id}.webp"));
        std::fs::write(&photo_file, b"fake-webp-bytes").unwrap();
        assert!(photo_file.exists());

        // Verify initial row counts
        let bath_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bathroom_log WHERE user_id = ?")
            .bind(user_id)
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(bath_count, 2);

        // Delete user and cascade (must not fail on foreign key constraint)
        delete_user_and_cascade(&state, user_id).await.unwrap();

        // Verify user and all dependent records are gone
        let user_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE user_id = ?")
            .bind(user_id)
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(user_count, 0);

        let bath_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bathroom_log WHERE user_id = ?")
            .bind(user_id)
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(bath_after, 0);

        let pending_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM dtr_pending WHERE user_id = ?")
            .bind(user_id)
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(pending_after, 0);

        let recon_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM dtr_recon_discrepancies WHERE user_id = ?")
            .bind(user_id)
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(recon_after, 0);

        // Verify local photo file was deleted
        assert!(!photo_file.exists());

        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }
}
