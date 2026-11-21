use super::*;
use crate::commands::test_support::*;
use crate::commands::attendance::attendance_rows_json;
use crate::services::attendance::ensure_payroll;
use crate::commands::session::setup_unlock_impl;
use crate::services::users::upsert_user_record;


/// MAJOR-1 of the round 2 review: a cutoff stored before v0.2.56 has late
/// lines without `payableTimeIn`. Reading it fills the key with the hour
/// the day was paid from; the expected values are what the old client
/// derived from the same stored line (21b9891 App.tsx:7426-7431).
#[tokio::test]
async fn a_cutoff_stored_before_the_payable_key_is_read_with_the_clamped_time_in() {
    let (state, temp, _token) = admin_test_state("stored-cutoff").await;
    let stored = include_str!("../fixtures/stored_cutoff_breakdown_2026_08.json");
    insert_cutoff_row(&state.db, "PAY-OLD", "FINALIZED").await;
    sqlx::query("UPDATE payroll_cutoffs SET calculation_breakdown=? WHERE payroll_id='PAY-OLD'")
        .bind(stored)
        .execute(&state.db)
        .await
        .unwrap();
    let row = sqlx::query(CUTOFF_LIST_SQL).fetch_one(&state.db).await.unwrap();
    let chips = |employee_type: Option<&str>| -> Vec<Option<String>> {
        let json = payroll_cutoff_json(&row, employee_type);
        let breakdown: serde_json::Value =
            serde_json::from_str(json["calculationBreakdown"].as_str().unwrap()).unwrap();
        breakdown["deductions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|line| line["payableTimeIn"].as_str().map(str::to_string))
            .collect()
    };
    let chip = |label: &str| Some(label.to_string());
    assert_eq!(
        chips(Some("INTERN")),
        vec![
            chip("10:00 AM"), // 2026-08-04 late 09:20
            None,             // 2026-08-05 weekly grace 08:10
            chip("9:00 AM"),  // 2026-08-06 late 08:16
            None,             // 2026-08-07 late 08:10, grace already used: paid from the scan
            None,             // 2026-08-10 late 09:15: not past the quarter hour
            None,             // 2026-08-11 undertime line of a late day
            chip("11:00 AM"), // 2026-08-11 its late line, 10:45
            None,             // 2026-08-12 late line with no amount
        ]
    );
    // A person the register does not list is shown as an intern, as before.
    assert_eq!(chips(None), chips(Some("INTERN")));
    // The old client showed the chip on intern rows only.
    assert!(chips(Some("EMPLOYEE")).iter().all(Option::is_none));
    // The stored column is not rewritten.
    let kept: String = sqlx::query_scalar("SELECT calculation_breakdown FROM payroll_cutoffs WHERE payroll_id='PAY-OLD'")
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(kept, stored);
    state.db.close().await;
    let _ = std::fs::remove_dir_all(temp);
}

#[tokio::test]
async fn reconciles_attendance_and_recomputes_cutoff_without_migrations() {
    let temp = std::env::temp_dir().join(format!("alpha-cutoff-reconcile-{}", uuid::Uuid::new_v4()));
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

    // 1. Create an intern user
    upsert_user_record(
        &state.db,
        "INT_TEST_1",
        "RFID-INT-1",
        "Test Intern",
        Some("IT"),
        "ACTIVE",
        "INTERN",
        Some("MALE"),
        Some(0),
        Some("INTERN_STANDARD"),
        None,
        "EMPLOYEE",
        "2026-08-01T00:00:00Z",
    )
    .await
    .unwrap();

    // 2. Insert attendance record: 8:00 AM to 12:30 PM (4.5 hours worked)
    sqlx::query(
        "INSERT INTO attendance (attendance_id, attendance_date, user_id, rfid_uid, full_name, department, time_in, time_out, status, source, created_at, updated_at) \
         VALUES ('ATT-TEST-1', '2026-08-01', 'INT_TEST_1', 'RFID-INT-1', 'Test Intern', 'IT', '2026-08-01T08:00:00+08:00', '2026-08-01T12:30:00+08:00', 'COMPLETED', 'KIOSK', '2026-08-01T08:00:00+08:00', '2026-08-01T12:30:00+08:00')"
    )
    .execute(&state.db)
    .await
    .unwrap();

    // 3. Simulate pre-existing stale payroll record calculated under previous ceiling logic (50 pesos, is_half_day = 0)
    sqlx::query(
        "INSERT INTO payroll (payroll_id, attendance_id, user_id, full_name, employee_type, attendance_date, actual_time_in, actual_time_out, computed_time_in, computed_time_out, grace_used, late_hours, late_deduction_centavos, base_pay_centavos, daily_pay_centavos, is_half_day, half_day_deduction_centavos, created_at, updated_at) \
         VALUES ('PAY-STALE-1', 'ATT-TEST-1', 'INT_TEST_1', 'Test Intern', 'INTERN', '2026-08-01', '2026-08-01T08:00:00+08:00', '2026-08-01T12:30:00+08:00', '2026-08-01T08:00:00+08:00', '2026-08-01T12:30:00+08:00', 0, 0, 0, 8000, 5000, 0, 3000, '2026-08-01T12:30:00+08:00', '2026-08-01T12:30:00+08:00')"
    )
    .execute(&state.db)
    .await
    .unwrap();

    // 4. Generate a one-day cutoff for this fixture so unrelated weekdays
    // do not add absences to the expected half-day net pay.
    let gen_result = payroll_generate_cutoff_impl(
        &state,
        &admin(&state, &token).await,
        "2026-08-01".to_string(),
        "2026-08-01".to_string(),
        "August 1, 2026".to_string(),
        serde_json::json!({ "standardWorkingDays": 1.0 }),
    )
    .await
    .unwrap();

    assert_eq!(gen_result["success"], true);
    assert_eq!(gen_result["generated"], 1);

    // 5. Verify the payroll table row was recomputed: daily_pay_centavos is now 4000 (40 pesos), is_half_day is 1
    let updated_payroll = sqlx::query(
        "SELECT daily_pay_centavos, is_half_day, half_day_deduction_centavos FROM payroll WHERE attendance_id = 'ATT-TEST-1'"
    )
    .fetch_one(&state.db)
    .await
    .unwrap();

    let daily_pay: i64 = updated_payroll.get("daily_pay_centavos");
    let is_half_day: i64 = updated_payroll.get("is_half_day");
    let half_day_ded: i64 = updated_payroll.get("half_day_deduction_centavos");
    assert_eq!(daily_pay, 4000, "Daily pay must recompute to 40 pesos (4 hours)");
    assert_eq!(is_half_day, 1, "Must be classified as half day");
    assert_eq!(half_day_ded, 4000, "Half day deduction must be 40 pesos");

    // 6. Verify the generated cutoff record reflects 40 pesos net pay
    let cutoff_row = sqlx::query(
        "SELECT actual_working_days, half_day_count, basic_pay_centavos, half_day_deduction_centavos, net_pay_centavos FROM payroll_cutoffs WHERE employee_id = 'INT_TEST_1'"
    )
    .fetch_one(&state.db)
    .await
    .unwrap();

    let cutoff_half_days: f64 = cutoff_row.get("half_day_count");
    let cutoff_net: i64 = cutoff_row.get("net_pay_centavos");
    assert_eq!(cutoff_half_days, 1.0, "Cutoff must have half_day_count = 1.0");
    assert_eq!(cutoff_net, 4000, "Cutoff net pay must be 40 pesos (4000 centavos)");

    // 7. B1: a LATE_TIMEOUT clock-out (>= 18:00) must still be reconciled
    // into payroll. The engines cap it to 17:00 (cap_late_timeout_out), so
    // the day is a full capped shift rather than a silently unpaid absence.
    sqlx::query(
        "INSERT INTO attendance (attendance_id, attendance_date, user_id, rfid_uid, full_name, department, time_in, time_out, status, source, created_at, updated_at) \
         VALUES ('ATT-TEST-LATE', '2026-08-03', 'INT_TEST_1', 'RFID-INT-1', 'Test Intern', 'IT', '2026-08-03T08:00:00+08:00', '2026-08-03T18:05:00+08:00', 'LATE_TIMEOUT', 'KIOSK', '2026-08-03T18:05:00+08:00', '2026-08-03T18:05:00+08:00')"
    )
    .execute(&state.db)
    .await
    .unwrap();

    reconcile_attendance_payroll_range(
        &state,
        "2026-08-01",
        "2026-08-15",
        &std::collections::HashSet::new(),
    )
        .await
        .unwrap();

    let late_payroll = sqlx::query(
        "SELECT computed_time_out, late_hours, daily_pay_centavos, is_half_day, half_day_deduction_centavos FROM payroll WHERE attendance_id = 'ATT-TEST-LATE'",
    )
    .fetch_optional(&state.db)
    .await
    .unwrap();
    let late_payroll = late_payroll.expect("reconcile must not drop a LATE_TIMEOUT day");
    assert_eq!(
        late_payroll.get::<String, _>("computed_time_out"),
        "2026-08-03T17:00:00+08:00",
        "A LATE_TIMEOUT clock-out caps to the 17:00 office close"
    );
    assert_eq!(late_payroll.get::<i64, _>("late_hours"), 0);
    assert_eq!(
        late_payroll.get::<i64, _>("daily_pay_centavos"),
        8000,
        "The capped day pays the intern's full 8h (PHP 80)"
    );
    assert_eq!(late_payroll.get::<i64, _>("is_half_day"), 0);
    assert_eq!(late_payroll.get::<i64, _>("half_day_deduction_centavos"), 0);

    state.db.close().await;
    let _ = std::fs::remove_dir_all(&temp);
}

#[tokio::test]
async fn graced_undertime_day_lands_in_deductions_not_earnings() {
    let temp = std::env::temp_dir().join(format!("alpha-undertime-{}", uuid::Uuid::new_v4()));
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
        &state.db, "INT_UT", "RFID-UT", "Under Time", Some("IT"), "ACTIVE", "INTERN",
        Some("MALE"), Some(0), Some("INTERN_STANDARD"), None, "EMPLOYEE", "2026-08-01T00:00:00Z",
    )
    .await
    .unwrap();
    // Nov 16-30, 2026 has 11 weekdays. Mon the 16th: 08:01-15:00 (weekly
    // grace, two undertime hours). Tue the 17th: 08:05, grace already used.
    for day in [16, 17, 18, 19, 20, 23, 24, 25, 26, 27, 30] {
        let (time_in, time_out) = match day {
            16 => ("08:01:00", "15:00:00"),
            17 => ("08:05:00", "17:00:00"),
            _ => ("08:00:00", "17:00:00"),
        };
        let date = format!("2026-11-{day}");
        sqlx::query(
            "INSERT INTO attendance (attendance_id, attendance_date, user_id, rfid_uid, full_name, department, time_in, time_out, status, source, created_at, updated_at) \
             VALUES (?, ?, 'INT_UT', 'RFID-UT', 'Under Time', 'IT', ?, ?, 'COMPLETED', 'KIOSK', ?, ?)",
        )
        .bind(format!("ATT-UT-{day}"))
        .bind(&date)
        .bind(format!("{date}T{time_in}+08:00"))
        .bind(format!("{date}T{time_out}+08:00"))
        .bind(&date)
        .bind(&date)
        .execute(&state.db)
        .await
        .unwrap();
    }
    payroll_generate_cutoff_impl(
        &state,
        &admin(&state, &token).await,
        "2026-11-16".into(),
        "2026-11-30".into(),
        "November 16-30, 2026".into(),
        serde_json::json!({}),
    )
    .await
    .unwrap();

    let day = |attendance_id: &'static str| {
        let db = state.db.clone();
        async move {
            let row = sqlx::query(
                "SELECT grace_used, late_deduction_centavos, half_day_deduction_centavos, daily_pay_centavos, policy_version \
                 FROM payroll WHERE attendance_id=?",
            )
            .bind(attendance_id)
            .fetch_one(&db)
            .await
            .unwrap();
            (
                row.get::<Option<i64>, _>(0),
                row.get::<i64, _>(1),
                row.get::<i64, _>(2),
                row.get::<i64, _>(3),
                row.get::<String, _>(4),
            )
        }
    };
    assert_eq!(day("ATT-UT-16").await, (Some(1), 0, 2_000, 6_000, "V3_WEEKLY_GRACE".to_string()));
    assert_eq!(day("ATT-UT-17").await, (Some(0), 1_000, 0, 7_000, "V3_WEEKLY_GRACE".to_string()));
    let claims: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM intern_grace WHERE user_id='INT_UT' AND week_start='2026-11-16'")
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(claims, 1, "one weekly grace claim");

    let cutoff = sqlx::query(
        "SELECT basic_pay_centavos, gross_compensation_centavos, late_deduction_centavos, half_day_deduction_centavos, net_pay_centavos FROM payroll_cutoffs",
    )
    .fetch_one(&state.db)
    .await
    .unwrap();
    // Earnings stay the full cutoff rate; undertime only reduces net through deductions.
    assert_eq!(
        (0..5).map(|i| cutoff.get::<i64, _>(i)).collect::<Vec<_>>(),
        [88_000, 88_000, 1_000, 2_000, 85_000]
    );
    // The Breakdown names the graced day; the attendance list shows the same decision.
    let breakdown: String = sqlx::query_scalar("SELECT calculation_breakdown FROM payroll_cutoffs")
        .fetch_one(&state.db)
        .await
        .unwrap();
    let breakdown: serde_json::Value = serde_json::from_str(&breakdown).unwrap();
    let lines = breakdown["deductions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| (item["date"].as_str().unwrap(), item["category"].as_str().unwrap(), item["amount"].as_f64().unwrap()))
        .collect::<Vec<_>>();
    assert_eq!(
        lines,
        [
            ("2026-11-16", "GRACE", 0.0),
            ("2026-11-16", "UNDERTIME", 20.0),
            ("2026-11-17", "LATE", 10.0),
        ]
    );
    // From 2026-11-20 there is no grace: an open 08:10 arrival on Dec 1 is late with that week's claim unused.
    sqlx::query(
        "INSERT INTO attendance (attendance_id, attendance_date, user_id, rfid_uid, full_name, department, time_in, status, source, created_at, updated_at) \
         VALUES ('ATT-UT-OPEN', '2026-12-01', 'INT_UT', 'RFID-UT', 'Under Time', 'IT', '2026-12-01T08:10:00+08:00', 'WORKING', 'KIOSK', '2026-12-01', '2026-12-01')",
    )
    .execute(&state.db)
    .await
    .unwrap();
    let mut statuses = Vec::new();
    for date in ["2026-11-16", "2026-11-17", "2026-11-18", "2026-12-01"] {
        let rows = attendance_rows_json(&state.db, date).await.unwrap();
        statuses.push((rows[0]["arrivalStatus"].as_str().unwrap().to_string(), rows[0]["minutesLate"].as_i64().unwrap()));
    }
    assert_eq!(
        statuses,
        [
            ("GRACE_PERIOD".to_string(), 0),
            ("LATE".to_string(), 5),
            ("ON_TIME".to_string(), 0),
            ("LATE".to_string(), 10),
        ]
    );

    let slips = crate::reporting::load_intern_payslips(&state.db, "2026-11-16", "2026-11-30")
        .await
        .unwrap();
    let slip = &slips[0];
    assert_eq!(slip.total_earnings_centavos, 88_000);
    assert_eq!(slip.adjustment_centavos, 0);
    assert_eq!((slip.late_centavos, slip.halfday_centavos, slip.undertime_centavos), (1_000, 0, 2_000));
    assert_eq!(slip.total_deductions_centavos, 3_000);
    assert_eq!(slip.net_pay_centavos, 85_000);

    state.db.close().await;
    let _ = std::fs::remove_dir_all(&temp);
}

/// MOCK FIRST CUTOFF (Dec 1-15, 2026; 11 weekdays; V4_NO_GRACE rules).
/// Eight interns with different time-in/time-out patterns; every expected
/// figure below is worked out by hand from docs/payroll-policy.md, in pesos
/// x 100. Weeks: Nov 30-Dec 6, Dec 7-13, Dec 14-20.
#[tokio::test]
async fn mock_first_cutoff_with_varied_days_matches_hand_computed_pay() {
    let temp = std::env::temp_dir().join(format!("alpha-mock-cutoff-{}", uuid::Uuid::new_v4()));
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

    const WORKDAYS: [u32; 11] = [1, 2, 3, 4, 7, 8, 9, 10, 11, 14, 15];
    const FULL: (&str, &str) = ("08:00:00", "17:00:00");
    struct Intern {
        id: &'static str,
        /// (day, time in, time out); a workday not listed is a full 08:00-17:00 day.
        days: &'static [(u32, &'static str, &'static str)],
        absent: &'static [u32],
        /// Expected cutoff centavos: late, half-day + undertime, absence, net.
        expected: (i64, i64, i64, i64),
    }
    let interns = [
        // A: perfect attendance.
        Intern { id: "A", days: &[], absent: &[], expected: (0, 0, 0, 88_000) },
        // B: five arrivals from 08:01 to 08:15:01 are one late hour each (no weekly grace);
        //    Dec 15 08:00:59 is on time.
        Intern {
            id: "B",
            days: &[
                (1, "08:10:00", "17:00:00"), (2, "08:10:00", "17:00:00"),
                (7, "08:15:00", "17:00:00"), (8, "08:15:01", "17:00:00"),
                (14, "08:01:00", "17:00:00"), (15, "08:00:59", "17:00:00"),
            ],
            absent: &[],
            expected: (5_000, 0, 0, 83_000),
        },
        // C: early time-outs. Dec 1 out 15:00 = 2h; Dec 2 out 16:59 = 1h; Dec 3 08:01-15:30
        //    and Dec 4 08:05-15:30 = 1 late hour + 2h each (owed 09:00-17:00). Staying to 17:30,
        //    18:30 (capped) or arriving 07:30 changes nothing.
        Intern {
            id: "C",
            days: &[
                (1, "08:00:00", "15:00:00"), (2, "08:00:00", "16:59:00"),
                (3, "08:01:00", "15:30:00"), (4, "08:05:00", "15:30:00"),
                (7, "08:00:00", "17:30:00"), (8, "08:00:00", "18:30:00"), (9, "07:30:00", "17:00:00"),
            ],
            absent: &[],
            expected: (2_000, 7_000, 0, 79_000),
        },
        // D: half-days and absences. Dec 1 morning half (40); Dec 2 13:00 afternoon half (40);
        //    Dec 7 12:00 sharp (40); Dec 8 09:01 = 2 late hours; Dec 9 11:59 = 4 late hours;
        //    Dec 10 08:20-12:30 = 1 late hour + 4 short hours; Dec 3-4 absent.
        Intern {
            id: "D",
            days: &[
                (1, "08:00:00", "12:00:00"), (2, "13:00:00", "17:00:00"),
                (7, "12:00:00", "17:00:00"), (8, "09:01:00", "17:00:00"),
                (9, "11:59:00", "17:00:00"), (10, "08:20:00", "12:30:00"),
            ],
            absent: &[3, 4],
            expected: (7_000, 16_000, 16_000, 49_000),
        },
        // E: Mon Nov 30 08:05 (previous cutoff) claims nothing, so Tue Dec 1 08:05 and
        //    Dec 7 08:14 are one late hour each.
        Intern {
            id: "E",
            days: &[(1, "08:05:00", "17:00:00"), (7, "08:14:00", "17:00:00")],
            absent: &[],
            expected: (2_000, 0, 0, 86_000),
        },
        // F: Dec 7 08:05 and Dec 9 08:07 late. (Corrected further down.)
        Intern {
            id: "F",
            days: &[(7, "08:05:00", "17:00:00"), (9, "08:07:00", "17:00:00")],
            absent: &[],
            expected: (2_000, 0, 0, 86_000),
        },
        // G: two near-empty days and nine absences: nothing left, never negative.
        //    Dec 1 16:30-16:45 = 8 short hours; Dec 2 08:01-08:30 = 1 late hour + 7 short hours.
        Intern {
            id: "G",
            days: &[(1, "16:30:00", "16:45:00"), (2, "08:01:00", "08:30:00")],
            absent: &[3, 4, 7, 8, 9, 10, 11, 14, 15],
            expected: (1_000, 15_000, 72_000, 0),
        },
        // H: second-level boundaries. Dec 1 08:00:59 on time; Dec 2 08:01:00 = 1 late hour;
        //    Dec 3 08:14:59-16:00 = 1 late hour + 1h; Dec 4 08:59:59 = 1 late hour;
        //    Dec 7 09:00:00 = 1 late hour; Dec 8 09:00:01 = 2 late hours.
        Intern {
            id: "H",
            days: &[
                (1, "08:00:59", "17:00:00"), (2, "08:01:00", "17:00:00"),
                (3, "08:14:59", "16:00:00"), (4, "08:59:59", "17:00:00"),
                (7, "09:00:00", "17:00:00"), (8, "09:00:01", "17:00:00"),
            ],
            absent: &[],
            expected: (6_000, 1_000, 0, 81_000),
        },
    ];

    for intern in &interns {
        let user_id = format!("INT_{}", intern.id);
        upsert_user_record(
            &state.db, &user_id, &format!("RFID-{}", intern.id), &format!("Mock {}", intern.id), Some("IT"),
            "ACTIVE", "INTERN", Some("MALE"), Some(0), Some("INTERN_STANDARD"), None, "EMPLOYEE", "2026-08-01T00:00:00Z",
        )
        .await
        .unwrap();
        for day in WORKDAYS.iter().copied().filter(|day| !intern.absent.contains(day)) {
            let (time_in, time_out) = intern.days.iter().find(|d| d.0 == day).map_or(FULL, |d| (d.1, d.2));
            let date = format!("2026-12-{day:02}");
            sqlx::query(
                "INSERT INTO attendance (attendance_id, attendance_date, user_id, rfid_uid, full_name, department, time_in, time_out, status, source, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, 'IT', ?, ?, 'COMPLETED', 'KIOSK', ?, ?)",
            )
            .bind(format!("ATT-{}-{day}", intern.id))
            .bind(&date)
            .bind(&user_id)
            .bind(format!("RFID-{}", intern.id))
            .bind(format!("Mock {}", intern.id))
            .bind(format!("{date}T{time_in}+08:00"))
            .bind(format!("{date}T{time_out}+08:00"))
            .bind(&date)
            .bind(&date)
            .execute(&state.db)
            .await
            .unwrap();
        }
    }
    // E's Monday of the straddling week, priced when it happened (previous cutoff).
    sqlx::query(
        "INSERT INTO attendance (attendance_id, attendance_date, user_id, rfid_uid, full_name, department, time_in, time_out, status, source, created_at, updated_at) \
         VALUES ('ATT-E-NOV30', '2026-11-30', 'INT_E', 'RFID-E', 'Mock E', 'IT', '2026-11-30T08:05:00+08:00', '2026-11-30T17:00:00+08:00', 'COMPLETED', 'KIOSK', '2026-11-30', '2026-11-30')",
    )
    .execute(&state.db)
    .await
    .unwrap();
    ensure_payroll(&state, "ATT-E-NOV30", "INT_E", "Mock E".into(), "2026-11-30", "2026-11-30T08:05:00+08:00", "2026-11-30T17:00:00+08:00")
        .await
        .unwrap();

    let generate = || async {
        payroll_generate_cutoff_impl(
            &state,
            &admin(&state, &token).await,
            "2026-12-01".into(),
            "2026-12-15".into(),
            "December 1-15, 2026".into(),
            serde_json::json!({}),
        )
        .await
    };
    let cutoff_rows = || async {
        sqlx::query(
            "SELECT employee_id, late_deduction_centavos, half_day_deduction_centavos, absence_deduction_centavos, \
             net_pay_centavos, gross_compensation_centavos, calculation_breakdown FROM payroll_cutoffs ORDER BY employee_id",
        )
        .fetch_all(&state.db)
        .await
        .unwrap()
    };
    let figures = |rows: &[sqlx::sqlite::SqliteRow]| {
        rows.iter()
            .map(|row| (row.get::<String, _>(0), (row.get::<i64, _>(1), row.get::<i64, _>(2), row.get::<i64, _>(3), row.get::<i64, _>(4))))
            .collect::<Vec<_>>()
    };

    assert_eq!(generate().await.unwrap()["generated"], 8);
    let rows = cutoff_rows().await;
    let expected = interns.iter().map(|intern| (format!("INT_{}", intern.id), intern.expected)).collect::<Vec<_>>();
    assert_eq!(figures(&rows), expected, "(late, half-day + undertime, absence, net) per intern");

    let slips = crate::reporting::load_intern_payslips(&state.db, "2026-12-01", "2026-12-15").await.unwrap();
    for (row, intern) in rows.iter().zip(&interns) {
        let user_id = format!("INT_{}", intern.id);
        let (late, short, absence, net) = intern.expected;
        // Earnings are never touched: the full cutoff rate, 11 x 80.
        assert_eq!(row.get::<i64, _>("gross_compensation_centavos"), 88_000, "{user_id} gross");
        // The Breakdown lines add up to the deductions exactly, with no balancing line.
        let breakdown: serde_json::Value = serde_json::from_str(&row.get::<String, _>("calculation_breakdown")).unwrap();
        let lines = breakdown["deductions"].as_array().unwrap();
        assert!(lines.iter().all(|line| line["category"] != "RECONCILIATION"), "{user_id} has a balancing line");
        let line_total: i64 = lines.iter().map(|line| (line["amount"].as_f64().unwrap() * 100.0).round() as i64).sum();
        assert_eq!(line_total, late + short + absence, "{user_id} breakdown total");
        let grace_lines = lines.iter().filter(|line| line["category"] == "GRACE").count() as i64;
        // Payslip: earnings whole, no adjustment on either side, totals consistent.
        let slip = slips.iter().find(|slip| slip.employee_id == user_id).unwrap();
        assert_eq!((slip.total_earnings_centavos, slip.adjustment_centavos, slip.deduction_adjustment_centavos), (88_000, 0, 0), "{user_id} payslip earnings");
        assert_eq!(slip.late_centavos + slip.halfday_centavos + slip.undertime_centavos + slip.absent_centavos, slip.total_deductions_centavos, "{user_id} payslip deductions");
        assert_eq!((slip.total_deductions_centavos, slip.net_pay_centavos), ((late + short + absence).min(88_000), net), "{user_id} payslip totals");
        // No grace claim and no Grace line under V4.
        let claims: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM intern_grace WHERE user_id = ?").bind(&user_id).fetch_one(&state.db).await.unwrap();
        assert_eq!((claims, grace_lines), (0, 0), "{user_id} grace claims and Grace lines");
        // Every day's pay is within 0..=80 and equals 80 less its deductions.
        let bad_days: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM payroll WHERE user_id = ? AND (daily_pay_centavos < 0 OR daily_pay_centavos > 8000 \
             OR daily_pay_centavos != 8000 - late_deduction_centavos - half_day_deduction_centavos OR policy_version != 'V4_NO_GRACE')",
        )
        .bind(&user_id)
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(bad_days, 0, "{user_id} has an inconsistent day");
    }

    // The attendance list agrees with the pay for the boundary seconds (intern H).
    let mut statuses = Vec::new();
    for day in [1, 2, 3, 4, 7, 8] {
        let rows = attendance_rows_json(&state.db, &format!("2026-12-{day:02}")).await.unwrap();
        let row = rows.iter().find(|row| row["userId"] == "INT_H").unwrap();
        statuses.push((row["arrivalStatus"].as_str().unwrap().to_string(), row["minutesLate"].as_i64().unwrap()));
    }
    assert_eq!(
        statuses,
        [("ON_TIME", 0), ("LATE", 1), ("LATE", 15), ("LATE", 60), ("LATE", 60), ("LATE", 61)]
            .map(|(status, minutes)| (status.to_string(), minutes))
    );

    // Generating again changes nothing: same figures, same grace claims.
    let claims_before: Vec<(String, String)> = sqlx::query_as("SELECT user_id, attendance_id FROM intern_grace ORDER BY 1, 2").fetch_all(&state.db).await.unwrap();
    sqlx::query("DELETE FROM payroll_cutoffs").execute(&state.db).await.unwrap();
    generate().await.unwrap();
    assert_eq!(figures(&cutoff_rows().await), expected, "regenerating changed the payroll");
    let claims_after: Vec<(String, String)> = sqlx::query_as("SELECT user_id, attendance_id FROM intern_grace ORDER BY 1, 2").fetch_all(&state.db).await.unwrap();
    assert_eq!(claims_after, claims_before, "regenerating moved a grace claim");

    // Correction: F's Dec 7 arrival is fixed to 08:00. Dec 9 08:07 stays late (no claim
    // to pass on); nobody else's pay moves.
    sqlx::query("UPDATE attendance SET time_in = '2026-12-07T08:00:00+08:00' WHERE attendance_id = 'ATT-F-7'").execute(&state.db).await.unwrap();
    sqlx::query("DELETE FROM payroll_cutoffs").execute(&state.db).await.unwrap();
    generate().await.unwrap();
    let corrected = figures(&cutoff_rows().await);
    for ((user_id, got), (_, before)) in corrected.iter().zip(&expected) {
        let want = if user_id == "INT_F" { (1_000, 0, 0, 87_000) } else { *before };
        assert_eq!(*got, want, "{user_id} after F's correction");
    }
    let f_claims: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM intern_grace WHERE user_id = 'INT_F'").fetch_one(&state.db).await.unwrap();
    assert_eq!(f_claims, 0);

    // Out of order: intern I forgot to time out on Mon Dec 7 (08:05), so Tue Dec 8 (08:06)
    // was priced first. The admin then completes Monday. Both days are one late hour
    // whichever is priced first, and stay that way.
    upsert_user_record(
        &state.db, "INT_I", "RFID-I", "Mock I", Some("IT"), "ACTIVE", "INTERN", Some("MALE"), Some(0),
        Some("INTERN_STANDARD"), None, "EMPLOYEE", "2026-08-01T00:00:00Z",
    )
    .await
    .unwrap();
    for (day, time_in, time_out, status) in [(7, "08:05:00", None, "MISSED"), (8, "08:06:00", Some("17:00:00"), "COMPLETED")] {
        let date = format!("2026-12-{day:02}");
        sqlx::query(
            "INSERT INTO attendance (attendance_id, attendance_date, user_id, rfid_uid, full_name, department, time_in, time_out, status, source, created_at, updated_at) \
             VALUES (?, ?, 'INT_I', 'RFID-I', 'Mock I', 'IT', ?, ?, ?, 'KIOSK', ?, ?)",
        )
        .bind(format!("ATT-I-{day}"))
        .bind(&date)
        .bind(format!("{date}T{time_in}+08:00"))
        .bind(time_out.map(|out| format!("{date}T{out}+08:00")))
        .bind(status)
        .bind(&date)
        .bind(&date)
        .execute(&state.db)
        .await
        .unwrap();
    }
    ensure_payroll(&state, "ATT-I-8", "INT_I", "Mock I".into(), "2026-12-08", "2026-12-08T08:06:00+08:00", "2026-12-08T17:00:00+08:00")
        .await
        .unwrap();
    sqlx::query("UPDATE attendance SET time_out = '2026-12-07T17:00:00+08:00', status = 'COMPLETED' WHERE attendance_id = 'ATT-I-7'").execute(&state.db).await.unwrap();
    for round in 0..2 {
        sqlx::query("DELETE FROM payroll_cutoffs").execute(&state.db).await.unwrap();
        generate().await.unwrap();
        let days: Vec<(String, i64, i64)> = sqlx::query_as(
            "SELECT attendance_id, grace_used, late_deduction_centavos FROM payroll WHERE user_id = 'INT_I' ORDER BY attendance_date",
        )
        .fetch_all(&state.db)
        .await
        .unwrap();
        assert_eq!(days, [("ATT-I-7".to_string(), 0, 1_000), ("ATT-I-8".to_string(), 0, 1_000)], "round {round}");
        // 2 days worked, 9 absent: 880 - 720 absent - 20 late.
        let net: i64 = sqlx::query_scalar("SELECT net_pay_centavos FROM payroll_cutoffs WHERE employee_id = 'INT_I'").fetch_one(&state.db).await.unwrap();
        assert_eq!(net, 14_000, "round {round}");
    }

    state.db.close().await;
    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn cutoff_dates_require_real_calendar_days() {
    // P7: shape checks alone accepted Feb-30 and month 99.
    assert!(valid_cutoff_date("2026-08-01"));
    assert!(valid_cutoff_date("2026-8-1")); // unpadded but a real day
    assert!(!valid_cutoff_date("2026-02-30"));
    assert!(!valid_cutoff_date("2026-13-01"));
    assert!(!valid_cutoff_date("2026-99-99"));
    assert!(!valid_cutoff_date(""));
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
async fn finalize_refuses_overlapping_finalized_cutoff() {
    // Double pay: Aug 1-15 is FINALIZED; a custom Aug 1-31 draft for the
    // same intern re-counts those frozen days and must never finalize.
    let temp = std::env::temp_dir().join(format!("alpha-cutoff-overlap-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp).unwrap();
    let mut lan = LanConfig::default();
    lan.admin_code = Some("1234".to_string());
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
    let token = setup_unlock_impl(&state, "1234".to_string()).await.unwrap()["token"]
        .as_str()
        .unwrap()
        .to_string();
    insert_cutoff_row(&state.db, "PAY-FIN", "FINALIZED").await;
    insert_cutoff_row(&state.db, "PAY-OVERLAP", "DRAFT").await;
    insert_cutoff_row(&state.db, "PAY-NEXT", "DRAFT").await;
    sqlx::query("UPDATE payroll_cutoffs SET cutoff_end='2026-08-31' WHERE payroll_id='PAY-OVERLAP'")
        .execute(&state.db)
        .await
        .unwrap();
    sqlx::query("UPDATE payroll_cutoffs SET cutoff_start='2026-08-16', cutoff_end='2026-08-31' WHERE payroll_id='PAY-NEXT'")
        .execute(&state.db)
        .await
        .unwrap();

    let refused = payroll_finalize_cutoff_impl(&state, &admin(&state, &token).await, "PAY-OVERLAP").await;
    assert_eq!(refused.unwrap_err(), "PAYROLL_PERIOD_ALREADY_FINALIZED");
    let status: String = sqlx::query_scalar("SELECT status FROM payroll_cutoffs WHERE payroll_id='PAY-OVERLAP'")
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(status, "DRAFT");
    let snapshots: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM payroll_snapshots WHERE payroll_id='PAY-OVERLAP'")
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(snapshots, 0);

    let adjacent = payroll_finalize_cutoff_impl(&state, &admin(&state, &token).await, "PAY-NEXT").await.unwrap();
    assert_eq!(adjacent["status"], "FINALIZED");

    state.db.close().await;
    let _ = std::fs::remove_dir_all(&temp);
}

#[tokio::test]
async fn cutoff_delete_never_leaves_a_finalized_cutoff_without_its_snapshot() {
    let temp = std::env::temp_dir().join(format!("alpha-cutoff-del-atomic-{}", uuid::Uuid::new_v4()));
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
    insert_cutoff_row(&state.db, "PAY-FIN", "FINALIZED").await;
    sqlx::query("INSERT INTO payroll_snapshots (snapshot_id,payroll_id,revision,status,snapshot_json,snapshot_sha256,created_at) VALUES ('snap-1','PAY-FIN',1,'FINALIZED','{}','x','2026-08-16T00:00:00Z')")
        .execute(&state.db)
        .await
        .unwrap();
    sqlx::query("CREATE TRIGGER block_cutoff_delete BEFORE DELETE ON payroll_cutoffs BEGIN SELECT RAISE(ABORT, 'forced cutoff delete failure'); END")
        .execute(&state.db)
        .await
        .unwrap();
    assert!(delete_cutoff_record(&state, "PAY-FIN".to_string()).await.is_err());
    let snapshots: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM payroll_snapshots WHERE payroll_id='PAY-FIN'")
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(snapshots, 1, "approved-pay snapshot kept while its cutoff stays");
    state.db.close().await;
    let _ = std::fs::remove_dir_all(&temp);
}

#[tokio::test]
async fn finalized_cutoff_can_be_deleted() {
    // Finalized and draft cutoffs can both be deleted with confirmation.
    let temp = std::env::temp_dir().join(format!("alpha-cutoff-delete-{}", uuid::Uuid::new_v4()));
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
    insert_cutoff_row(&state.db, "PAY-FIN", "FINALIZED").await;
    insert_cutoff_row(&state.db, "PAY-DRAFT", "DRAFT").await;
    delete_cutoff_record(&state, "PAY-FIN".to_string())
        .await
        .expect("finalized deletes");
    delete_cutoff_record(&state, "PAY-DRAFT".to_string())
        .await
        .expect("draft deletes");
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM payroll_cutoffs")
        .fetch_one(&state.db)
        .await
        .expect("count");
    assert_eq!(remaining, 0);
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

    // Submitted rate/allowances are ignored; the fixed PHP 80/day rate is
    // enforced for interns, and the late shortfall is charged through
    // late-hours amount is separate from the shortfall amount.
    let mut input = serde_json::json!({
        "employeeId": "INT-1", "dailyRate": 500.0, "lateUnits": 3.0,
        "incentivesAllowance": 100.0, "specialHolidayDays": 1.0,
    });
    apply_intern_rules(&db, &mut input)
        .await
        .expect("intern rules applied");

    assert_eq!(input["dailyRate"], 80.0);
    assert_eq!(input["lateUnits"], 3.0);
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
    apply_intern_rules(&db, &mut employee_input)
        .await
        .expect("employee rules pass through");
    assert_eq!(employee_input["dailyRate"], 500.0);
    assert_eq!(employee_input.get("lateDeduction"), None);
}

#[tokio::test]
async fn intern_late_deduction_uses_fixed_hourly_rate() {
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
        .bind("INT-LATE-0")
        .bind("Late Intern")
        .bind(8_000_i64)
        .bind("INTERN")
        .execute(&db)
        .await
        .expect("intern row");

    let mut input = serde_json::json!({
        "employeeId": "INT-LATE-0",
        "lateUnits": 99.0,
        "lateDeduction": 999.0,
    });
    apply_intern_rules(&db, &mut input)
        .await
        .expect("intern rules applied");

    assert_eq!(input["lateUnits"], 99.0);
    assert_eq!(input["lateDeduction"], 990.0);
}

#[test]
fn updated_cutoff_breakdown_contains_deductions_and_half_day_centavos() {
    let parsed = cutoff_input(&serde_json::json!({
        "employeeId": "EMP-BREAKDOWN",
        "employeeName": "Breakdown Employee",
        "employeeType": "EMPLOYEE",
        "cutoffStart": "2026-08-01",
        "cutoffEnd": "2026-08-15",
        "dailyRate": 500.0,
        "standardWorkingDays": 11.0,
        "actualWorkingDays": 11.0,
        "halfDayCount": 1.0,
        "halfDayFraction": 0.5,
        "halfDayDeduction": 250.0,
    }));
    let result = crate::services::cutoff_payroll::calculate(&parsed).expect("cutoff calculation");
    let breakdown = &transparent_cutoff_breakdown(&parsed, &result, 0.0, Vec::new());

    assert!(breakdown["deductions"].is_array());
    assert_eq!(breakdown["halfDayCentavos"], 25_000);
}

#[test]
fn update_preserves_prior_deduction_rows() {
    let items = preserved_deduction_items(Some(
        r#"{"deductions":[{"category":"UNDERTIME","amount":40}]}"#.into(),
    ));
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["category"], "UNDERTIME");
}

#[test]
fn update_handles_missing_or_invalid_breakdown() {
    assert!(preserved_deduction_items(None).is_empty());
    assert!(preserved_deduction_items(Some("not json".into())).is_empty());
    assert!(preserved_deduction_items(Some(r#"{"deductions":{}}"#.into())).is_empty());
}

#[tokio::test]
async fn intern_editor_json_flows_through_one_discriminator_to_floored_gross() {
    // N1: the editor payload carries no `employeeType`; the single source is
    // `apply_intern_rules` keyed off the users row. The engine must see INTERN
    // and floor gross separately from net, matching the TS engine parity case
    // (grossCompensation 880 / netPay 0) instead of net-as-gross.
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
    let mut input = serde_json::json!({
        "employeeId": "INT-1", "employeeName": "Maria Santos",
        "cutoffStart": "2026-09-01", "cutoffEnd": "2026-09-15",
        "standardWorkingDays": 11.0, "actualWorkingDays": 1.0, "lateUnits": 20.0,
    });
    assert_eq!(input.get("employeeType"), None);
    apply_intern_rules(&db, &mut input)
        .await
        .expect("intern rules applied");
    // One derivation, stored where the engine reads it.
    assert_eq!(input["employeeType"], "INTERN");
    let parsed = cutoff_input(&input);
    // basic = 80/day x (1 actual + 10 absent) = 880; late=200 and absence=800
    // are separate deductions, while gross stays 880 (not net).
    let result = crate::services::cutoff_payroll::calculate(&parsed).expect("engine");
    assert_eq!(result.gross_compensation, 88_000);
    assert_eq!(result.late_deduction, 20_000);
    assert_eq!(result.net_pay, 0);
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
        half_day_deduction: None,
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
        half_day_deduction: None,
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
