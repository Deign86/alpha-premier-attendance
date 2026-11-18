//! Test fixtures shared by the command modules' tests.

use crate::services::users::upsert_user_record;

pub(crate) use crate::config::{LanConfig, OfficeConfig};

pub(crate) use crate::state::AppState;

pub(crate) use sqlx::sqlite::SqlitePoolOptions;

pub(crate) async fn insert_cutoff_row(db: &sqlx::SqlitePool, payroll_id: &str, status: &str) {
    sqlx::query("INSERT INTO payroll_cutoffs (payroll_id, employee_id, employee_name, payroll_profile_id, payroll_cutoff_label, cutoff_start, cutoff_end, payroll_frequency, daily_rate_centavos, standard_working_days, actual_working_days, basic_pay_centavos, special_holiday_days, special_holiday_multiplier, special_holiday_pay_centavos, regular_holiday_days, regular_holiday_multiplier, regular_holiday_pay_centavos, incentives_allowance_centavos, special_allowance_centavos, total_compensation_centavos, total_allowance_centavos, late_units, late_deduction_centavos, half_day_count, half_day_deduction_centavos, absent_days, absence_deduction_centavos, overtime_hours, overtime_rate_centavos, overtime_pay_centavos, gross_compensation_centavos, net_pay_centavos, calculation_breakdown, approved_working_day_overage, status, created_at, updated_at) VALUES (?, 'EMP-1', 'Ada Lovelace', 'BEA_STANDARD', 'Aug 1-15, 2026', '2026-08-01', '2026-08-15', 'SEMI_MONTHLY', 50000, 11, 11, 550000, 0, 1, 0, 0, 1, 0, 0, 0, 550000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 550000, 550000, '{}', 0, ?, '2026-08-16T00:00:00Z', '2026-08-16T00:00:00Z')")
        .bind(payroll_id)
        .bind(status)
        .execute(db)
        .await
        .expect("cutoff row");
}

pub(crate) async fn scan_test_state(card: &str, time_in: &str) -> (AppState, std::path::PathBuf) {
    let temp = std::env::temp_dir().join(format!("alpha-scan-rules-{}", uuid::Uuid::new_v4()));
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
        &state.db, "INT_SCAN", card, "Scan Intern", Some("IT"), "ACTIVE", "INTERN",
        Some("FEMALE"), None, Some("BEA_STANDARD"), None, "EMPLOYEE", "2026-08-01T00:00:00Z",
    )
    .await
    .unwrap();
    sqlx::query("INSERT INTO attendance (attendance_id,attendance_date,user_id,rfid_uid,full_name,department,time_in,time_out,status,source,created_at,updated_at) VALUES ('att-scan',?,'INT_SCAN',?,'Scan Intern','IT',?,NULL,'WORKING','RFID',?,?)")
        .bind(&time_in[..10]).bind(card).bind(time_in).bind(time_in).bind(time_in)
        .execute(&state.db)
        .await
        .unwrap();
    (state, temp)
}

pub(crate) fn manila(at: &str) -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339(at).unwrap().with_timezone(&chrono::Utc)
}

pub(crate) async fn admin_test_state(tag: &str) -> (AppState, std::path::PathBuf, String) {
    let temp = std::env::temp_dir().join(format!("alpha-{tag}-{}", uuid::Uuid::new_v4()));
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
    (state, temp, token)
}

pub(crate) async fn add_intern(state: &AppState, user_id: &str, card: &str) {
    upsert_user_record(
        &state.db, user_id, card, user_id, Some("IT"), "ACTIVE", "INTERN",
        Some("MALE"), None, Some("BEA_STANDARD"), None, "EMPLOYEE", "2026-08-01T00:00:00Z",
    )
    .await
    .unwrap();
}

/// The proof a command gets from `Admin::check`, for a test that calls the function behind the command.
pub(crate) async fn admin(state: &AppState, token: &str) -> crate::commands::session::Admin {
    crate::commands::session::Admin::check(state, token).await.expect("the test's admin session")
}
