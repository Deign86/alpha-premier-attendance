// Keep focused payroll tests runnable without loading the app's Tauri/WebView2
// native dependencies into the Windows test process.
mod services {
    pub mod payroll {
        include!("../src/services/payroll.rs");
    }

    pub mod lunch_break {
        include!("../src/services/lunch_break.rs");
    }

    pub mod intern_payroll {
        include!("../src/services/intern_payroll.rs");
    }

    pub mod cutoff_payroll {
        include!("../src/services/cutoff_payroll.rs");
    }
}

#[tokio::test]
async fn september_cutoff_seed_persists_backend_calculations_to_sqlite() {
    use services::{cutoff_payroll::{calculate, CutoffInput}, intern_payroll};
    use sqlx::{sqlite::SqlitePoolOptions, Row};

    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::query("CREATE TABLE attendance (employee_id TEXT, attendance_date TEXT, time_in TEXT, time_out TEXT, daily_pay INTEGER)")
        .execute(&pool).await.unwrap();
    sqlx::query("CREATE TABLE payroll_cutoffs (employee_id TEXT PRIMARY KEY, basic_pay INTEGER, regular_holiday_pay INTEGER, late_deduction INTEGER, half_day_deduction INTEGER, absence_deduction INTEGER, gross_compensation INTEGER, total_deductions INTEGER, net_pay INTEGER)")
        .execute(&pool).await.unwrap();

    let intern_shifts = [
        ("2026-09-01", "08:00:00", "17:00:00"),
        ("2026-09-02", "09:00:00", "17:00:00"), // late
        ("2026-09-03", "08:00:00", "17:00:00"),
        ("2026-09-04", "08:00:00", "12:00:00"), // half-day
        ("2026-09-07", "08:00:00", "17:00:00"),
        ("2026-09-08", "08:00:00", "17:00:00"),
        ("2026-09-09", "08:00:00", "17:00:00"),
        ("2026-09-10", "08:00:00", "17:00:00"),
        ("2026-09-11", "08:00:00", "17:00:00"),
        ("2026-09-14", "08:00:00", "17:00:00"),
    ];
    let mut intern_late = 0_i64;
    let mut intern_half_day = 0_i64;
    for (date, time_in, time_out) in intern_shifts {
        let daily = intern_payroll::calculate(
            date, &format!("{date}T{time_in}+08:00"), &format!("{date}T{time_out}+08:00"), false,
        ).unwrap();
        intern_late += daily.late_deduction_centavos;
        intern_half_day += daily.half_day_deduction_centavos;
        sqlx::query("INSERT INTO attendance VALUES (?, ?, ?, ?, ?)")
            .bind("INT-SEP").bind(date).bind(time_in).bind(time_out).bind(daily.daily_pay_centavos)
            .execute(&pool).await.unwrap();
    }
    let intern_cutoff = calculate(&CutoffInput {
        employee_id: "INT-SEP".into(), employee_name: "September Intern".into(), employee_type: "INTERN".into(),
        cutoff_start: "2026-09-01".into(), cutoff_end: "2026-09-15".into(), daily_rate: 80.0,
        standard_working_days: 11.0, actual_working_days: 10.0, basic_pay: None,
        special_holiday_days: 0.0, special_holiday_multiplier: 0.0, special_holiday_pay: None,
        regular_holiday_days: 0.0, regular_holiday_multiplier: 0.0, regular_holiday_pay: None,
        hra: 0.0, incentives_allowance: 0.0, special_allowance: 0.0, late_deduction: intern_late as f64 / 100.0,
        half_day_count: 1.0, half_day_fraction: 0.5, half_day_deduction: Some(intern_half_day as f64 / 100.0),
        absent_days: 1.0, absence_deduction: None, overtime_hours: 0.0, overtime_rate: 0.0, overtime_pay: None,
        sss_employee_share: 0.0, phic_employee_share: 0.0, hdmf_employee_share: 0.0, salary_advance: 1_000.0,
        manual_adjustment: 0.0, adjustment_reason: None, approved_working_day_overage: false,
    }).unwrap();
    sqlx::query("INSERT INTO payroll_cutoffs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind("INT-SEP").bind(intern_cutoff.basic_pay).bind(intern_cutoff.regular_holiday_pay)
        .bind(intern_cutoff.late_deduction).bind(intern_cutoff.half_day_deduction)
        .bind(intern_cutoff.absence_deduction).bind(intern_cutoff.gross_compensation)
        .bind(intern_cutoff.total_deductions).bind(intern_cutoff.net_pay)
        .execute(&pool).await.unwrap();

    let intern_row = sqlx::query("SELECT * FROM payroll_cutoffs WHERE employee_id='INT-SEP'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(intern_row.get::<i64, _>("late_deduction"), 1_000);
    assert_eq!(intern_row.get::<i64, _>("half_day_deduction"), 4_000);
    assert_eq!(intern_row.get::<i64, _>("absence_deduction"), 8_000);
    assert_eq!(intern_row.get::<i64, _>("total_deductions"), 113_000);
    assert_eq!(intern_row.get::<i64, _>("net_pay"), 0); // intern floor at zero
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM attendance WHERE attendance_date BETWEEN '2026-09-01' AND '2026-09-15'").fetch_one(&pool).await.unwrap(), 10);
}

#[test]
fn named_0815_to_1500_edge_and_boundary_cases_match_daily_rule() {
    use services::intern_payroll::calculate;

    struct EdgeCase {
        date: &'static str,
        time_in: &'static str,
        time_out: &'static str,
        grace_available: bool,
        expected_grace_used: bool,
        expected_late_hours: i64,
        expected_late_centavos: i64,
        expected_undertime_centavos: i64,
        expected_net_centavos: i64,
    }

    // Sep 1–6 is the Manila Mon-week starting Aug 31: row 2 exhausts row 1's grace.
    // The remaining rows cover the seconds boundary and next-week Monday reset.
    let cases = [
        EdgeCase { date: "2026-09-01", time_in: "08:15:00", time_out: "15:00:00", grace_available: true, expected_grace_used: true, expected_late_hours: 0, expected_late_centavos: 0, expected_undertime_centavos: 2_000, expected_net_centavos: 6_000 },
        EdgeCase { date: "2026-09-02", time_in: "08:15:00", time_out: "15:00:00", grace_available: false, expected_grace_used: false, expected_late_hours: 1, expected_late_centavos: 1_000, expected_undertime_centavos: 2_000, expected_net_centavos: 5_000 },
        EdgeCase { date: "2026-09-03", time_in: "08:15:01", time_out: "15:00:00", grace_available: true, expected_grace_used: false, expected_late_hours: 1, expected_late_centavos: 1_000, expected_undertime_centavos: 2_000, expected_net_centavos: 5_000 },
        EdgeCase { date: "2026-09-04", time_in: "08:16:00", time_out: "17:00:00", grace_available: false, expected_grace_used: false, expected_late_hours: 1, expected_late_centavos: 1_000, expected_undertime_centavos: 0, expected_net_centavos: 7_000 },
        EdgeCase { date: "2026-09-07", time_in: "08:00:01", time_out: "17:00:00", grace_available: true, expected_grace_used: false, expected_late_hours: 0, expected_late_centavos: 0, expected_undertime_centavos: 0, expected_net_centavos: 8_000 },
    ];

    for case in cases {
        let result = calculate(
            case.date,
            &format!("{}T{}+08:00", case.date, case.time_in),
            &format!("{}T{}+08:00", case.date, case.time_out),
            case.grace_available,
        )
        .unwrap();

        assert_eq!(result.grace_used, case.expected_grace_used, "{} {}", case.date, case.time_in);
        assert_eq!(result.base_pay_centavos, 8_000, "{} {}", case.date, case.time_in);
        assert_eq!(result.late_hours, case.expected_late_hours, "{} {}", case.date, case.time_in);
        assert_eq!(result.late_deduction_centavos, case.expected_late_centavos, "{} {}", case.date, case.time_in);
        assert_eq!(result.half_day_deduction_centavos, case.expected_undertime_centavos, "{} {}", case.date, case.time_in);
        assert_eq!(
            result.daily_pay_centavos,
            case.expected_net_centavos,
            "{} {}",
            case.date,
            case.time_in
        );
        assert_eq!(
            result.daily_pay_centavos,
            8_000 - result.late_deduction_centavos - result.half_day_deduction_centavos,
            "late and undertime must not double-charge {} {}",
            case.date,
            case.time_in
        );
    }
}

#[test]
fn hourly_quarter_clamp_cases_keep_actual_scans_until_strictly_after_15_minutes() {
    use services::intern_payroll::calculate;

    for (time_in, grace, effective_in, late_hours) in [
        ("09:03:00", false, "09:03:00", 1),
        ("09:15:00", false, "09:15:00", 1),
        ("09:15:00.001", false, "10:00:00", 2),
        ("09:16:00", false, "10:00:00", 2),
        ("10:16:00", false, "11:00:00", 3),
        ("08:16:00", false, "09:00:00", 1),
        ("08:15:00", true, "08:15:00", 0),
    ] {
        let result = calculate(
            "2026-09-01",
            &format!("2026-09-01T{time_in}+08:00"),
            "2026-09-01T17:00:00+08:00",
            grace,
        )
        .unwrap();
        assert!(result.computed_time_in.ends_with(&format!("T{effective_in}+08:00")), "{time_in}");
        assert_eq!(result.late_hours, late_hours, "{time_in}");
        assert_eq!(result.late_deduction_centavos, late_hours * 1_000, "{time_in}");
        if grace {
            assert!(result.grace_used);
        }
    }
}

#[test]
fn september_intern_time_seed_matches_fixed_nine_clamp_and_cutoff_cases() {
    use services::{cutoff_payroll::{calculate as calculate_cutoff, CutoffInput}, intern_payroll::calculate};

    struct Seed {
        date: &'static str,
        time_in: &'static str,
        time_out: &'static str,
        expected_daily_pay: i64,
        expected_grace_used: bool,
        expected_computed_in: &'static str,
    }

    let seeds = [
        Seed { date: "2026-09-01", time_in: "08:00:00", time_out: "17:00:00", expected_daily_pay: 8_000, expected_grace_used: false, expected_computed_in: "08:00:00" },
        Seed { date: "2026-09-02", time_in: "09:30:00", time_out: "17:00:00", expected_daily_pay: 6_000, expected_grace_used: false, expected_computed_in: "10:00:00" },
        Seed { date: "2026-09-03", time_in: "09:30:00", time_out: "17:00:00", expected_daily_pay: 6_000, expected_grace_used: false, expected_computed_in: "10:00:00" },
        Seed { date: "2026-09-04", time_in: "08:00:00", time_out: "16:00:00", expected_daily_pay: 7_000, expected_grace_used: false, expected_computed_in: "08:00:00" },
        Seed { date: "2026-09-07", time_in: "08:08:00", time_out: "17:00:00", expected_daily_pay: 8_000, expected_grace_used: true, expected_computed_in: "08:08:00" },
        Seed { date: "2026-09-08", time_in: "08:08:00", time_out: "17:00:00", expected_daily_pay: 7_000, expected_grace_used: false, expected_computed_in: "08:08:00" },
    ];

    let mut grace_available = true;
    let mut daily_pay_total = 0_i64;
    let mut late_total = 0_i64;
    let mut undertime_total = 0_i64;
    for seed in seeds {
        if seed.date == "2026-09-07" {
            grace_available = true; // Monday starts the next weekly grace window.
        }
        let result = calculate(
            seed.date,
            &format!("{}T{}+08:00", seed.date, seed.time_in),
            &format!("{}T{}+08:00", seed.date, seed.time_out),
            grace_available,
        )
        .unwrap();

        assert_eq!(result.daily_pay_centavos, seed.expected_daily_pay, "{} {}-{}", seed.date, seed.time_in, seed.time_out);
        assert_eq!(result.grace_used, seed.expected_grace_used, "{} {}", seed.date, seed.time_in);
        assert!(result.computed_time_in.contains(seed.expected_computed_in), "{} {} converted to {}", seed.date, seed.time_in, result.computed_time_in);
        assert_eq!(result.base_pay_centavos, 8_000, "{}", seed.date);

        if result.grace_used {
            grace_available = false;
        }
        daily_pay_total += result.daily_pay_centavos;
        late_total += result.late_deduction_centavos;
        undertime_total += result.half_day_deduction_centavos;
        eprintln!(
            "{} {}-{} -> PHP {:.2}, grace={}, computed_in={}, late=PHP {:.2}, undertime=PHP {:.2}",
            seed.date,
            seed.time_in,
            seed.time_out,
            result.daily_pay_centavos as f64 / 100.0,
            result.grace_used,
            result.computed_time_in,
            result.late_deduction_centavos as f64 / 100.0,
            result.half_day_deduction_centavos as f64 / 100.0,
        );
    }

    assert_eq!(daily_pay_total, 42_000);
    assert_eq!(late_total, 5_000);
    assert_eq!(undertime_total, 1_000);

    let cutoff = calculate_cutoff(&CutoffInput {
        employee_id: "INT-SEP-SEED".into(),
        employee_name: "September Intern Seed".into(),
        employee_type: "INTERN".into(),
        cutoff_start: "2026-09-01".into(),
        cutoff_end: "2026-09-15".into(),
        daily_rate: 80.0,
        standard_working_days: 11.0,
        actual_working_days: 6.0,
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
        late_deduction: late_total as f64 / 100.0,
        half_day_count: 0.0,
        half_day_fraction: 0.5,
        half_day_deduction: Some(undertime_total as f64 / 100.0),
        absent_days: 5.0,
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
        approved_working_day_overage: false,
    })
    .unwrap();
    assert_eq!(cutoff.basic_pay, 88_000);
    assert_eq!(cutoff.absence_deduction, 40_000);
    assert_eq!(cutoff.late_deduction, late_total);
    assert_eq!(cutoff.half_day_deduction, undertime_total);
    assert_eq!(cutoff.total_deductions, 46_000);
    assert_eq!(cutoff.net_pay, 42_000);
}

#[test]
fn september_intern_edge_attendance_matches_weekly_grace_and_cutoff_totals() {
    use services::intern_payroll::calculate;

    struct AttendanceCase {
        employee_id: &'static str,
        date: &'static str,
        time_in: &'static str,
        time_out: &'static str,
        grace_available: bool,
        expected_grace_used: bool,
        expected_late_hours: i64,
        expected_late_centavos: i64,
        expected_undertime_centavos: i64,
    }

    let cases = [
        AttendanceCase { employee_id: "APG-2026-116", date: "2026-09-01", time_in: "08:00:00", time_out: "17:00:00", grace_available: true, expected_grace_used: false, expected_late_hours: 0, expected_late_centavos: 0, expected_undertime_centavos: 0 },
        AttendanceCase { employee_id: "APG-2026-117", date: "2026-09-01", time_in: "08:00:01", time_out: "17:00:00", grace_available: true, expected_grace_used: false, expected_late_hours: 0, expected_late_centavos: 0, expected_undertime_centavos: 0 },
        AttendanceCase { employee_id: "APG-2026-116", date: "2026-09-02", time_in: "08:08:00", time_out: "17:00:00", grace_available: true, expected_grace_used: true, expected_late_hours: 0, expected_late_centavos: 0, expected_undertime_centavos: 0 },
        AttendanceCase { employee_id: "APG-2026-116", date: "2026-09-03", time_in: "08:08:00", time_out: "17:00:00", grace_available: false, expected_grace_used: false, expected_late_hours: 1, expected_late_centavos: 1_000, expected_undertime_centavos: 0 },
        AttendanceCase { employee_id: "APG-2026-117", date: "2026-09-03", time_in: "08:15:00", time_out: "17:00:00", grace_available: true, expected_grace_used: true, expected_late_hours: 0, expected_late_centavos: 0, expected_undertime_centavos: 0 },
        AttendanceCase { employee_id: "APG-2026-118", date: "2026-09-04", time_in: "08:15:01", time_out: "17:00:00", grace_available: true, expected_grace_used: false, expected_late_hours: 1, expected_late_centavos: 1_000, expected_undertime_centavos: 0 },
        AttendanceCase { employee_id: "APG-2026-119", date: "2026-09-04", time_in: "08:16:00", time_out: "17:00:00", grace_available: false, expected_grace_used: false, expected_late_hours: 1, expected_late_centavos: 1_000, expected_undertime_centavos: 0 },
        AttendanceCase { employee_id: "APG-2026-117", date: "2026-09-08", time_in: "08:30:00", time_out: "17:00:00", grace_available: false, expected_grace_used: false, expected_late_hours: 1, expected_late_centavos: 1_000, expected_undertime_centavos: 0 },
        AttendanceCase { employee_id: "APG-2026-118", date: "2026-09-09", time_in: "09:00:01", time_out: "17:00:00", grace_available: false, expected_grace_used: false, expected_late_hours: 1, expected_late_centavos: 1_000, expected_undertime_centavos: 1_000 },
        AttendanceCase { employee_id: "APG-2026-119", date: "2026-09-10", time_in: "08:00:00", time_out: "16:00:00", grace_available: false, expected_grace_used: false, expected_late_hours: 0, expected_late_centavos: 0, expected_undertime_centavos: 1_000 },
        AttendanceCase { employee_id: "APG-2026-116", date: "2026-09-11", time_in: "08:00:00", time_out: "15:00:00", grace_available: false, expected_grace_used: false, expected_late_hours: 0, expected_late_centavos: 0, expected_undertime_centavos: 2_000 },
        AttendanceCase { employee_id: "APG-2026-117", date: "2026-09-11", time_in: "08:30:00", time_out: "16:00:00", grace_available: false, expected_grace_used: false, expected_late_hours: 1, expected_late_centavos: 1_000, expected_undertime_centavos: 1_000 },
        AttendanceCase { employee_id: "APG-2026-118", date: "2026-09-11", time_in: "09:00:01", time_out: "15:00:00", grace_available: false, expected_grace_used: false, expected_late_hours: 1, expected_late_centavos: 1_000, expected_undertime_centavos: 3_000 },
        AttendanceCase { employee_id: "APG-2026-116", date: "2026-09-07", time_in: "08:08:00", time_out: "17:00:00", grace_available: true, expected_grace_used: true, expected_late_hours: 0, expected_late_centavos: 0, expected_undertime_centavos: 0 },
        AttendanceCase { employee_id: "APG-2026-116", date: "2026-09-08", time_in: "08:08:00", time_out: "17:00:00", grace_available: false, expected_grace_used: false, expected_late_hours: 1, expected_late_centavos: 1_000, expected_undertime_centavos: 0 },
        AttendanceCase { employee_id: "APG-2026-116", date: "2026-09-14", time_in: "08:08:00", time_out: "17:00:00", grace_available: true, expected_grace_used: true, expected_late_hours: 0, expected_late_centavos: 0, expected_undertime_centavos: 0 },
        AttendanceCase { employee_id: "APG-2026-116", date: "2026-09-15", time_in: "08:08:00", time_out: "17:00:00", grace_available: false, expected_grace_used: false, expected_late_hours: 1, expected_late_centavos: 1_000, expected_undertime_centavos: 0 },
    ];

    let employee_ids = [
        "APG-2026-116",
        "APG-2026-117",
        "APG-2026-118",
        "APG-2026-119",
    ];
    let mut employee_totals = [(0_i64, 0_i64, 0_i64); 4];
    for case in cases {
        let result = calculate(
            case.date,
            &format!("{}T{}+08:00", case.date, case.time_in),
            &format!("{}T{}+08:00", case.date, case.time_out),
            case.grace_available,
        )
        .unwrap();
        assert_eq!(result.grace_used, case.expected_grace_used, "{} {}", case.employee_id, case.date);
        assert_eq!(result.late_hours, case.expected_late_hours, "{} {}", case.employee_id, case.date);
        assert_eq!(result.late_deduction_centavos, case.expected_late_centavos, "{} {}", case.employee_id, case.date);
        assert_eq!(result.half_day_deduction_centavos, case.expected_undertime_centavos, "{} {}", case.employee_id, case.date);
        assert_eq!(result.base_pay_centavos, 8_000, "{} {}", case.employee_id, case.date);
        assert_eq!(
            result.daily_pay_centavos,
            8_000 - case.expected_late_centavos - case.expected_undertime_centavos,
            "{} {}",
            case.employee_id,
            case.date
        );
        let employee_index = employee_ids.iter().position(|id| *id == case.employee_id).unwrap();
        employee_totals[employee_index].0 += result.late_deduction_centavos;
        employee_totals[employee_index].1 += result.half_day_deduction_centavos;
        employee_totals[employee_index].2 += 1;
    }

    let late_total: i64 = employee_totals.iter().map(|totals| totals.0).sum();
    let undertime_total: i64 = employee_totals.iter().map(|totals| totals.1).sum();
    assert_eq!(late_total, 9_000);
    assert_eq!(undertime_total, 8_000);

    let mut cutoff_net_total = 0_i64;
    for (index, employee_id) in employee_ids.iter().enumerate() {
        let (late, undertime, attendance_days) = employee_totals[index];
        let cutoff = services::cutoff_payroll::calculate(&services::cutoff_payroll::CutoffInput {
            employee_id: (*employee_id).into(),
            employee_name: "Intern edge set".into(),
            employee_type: "INTERN".into(),
            cutoff_start: "2026-09-01".into(),
            cutoff_end: "2026-09-15".into(),
            daily_rate: 80.0,
            standard_working_days: 17.0,
            actual_working_days: attendance_days as f64,
            basic_pay: Some(attendance_days as f64 * 80.0),
            special_holiday_days: 0.0,
            special_holiday_multiplier: 1.0,
            special_holiday_pay: None,
            regular_holiday_days: 0.0,
            regular_holiday_multiplier: 1.0,
            regular_holiday_pay: None,
            hra: 0.0,
            incentives_allowance: 0.0,
            special_allowance: 0.0,
            late_deduction: late as f64 / 100.0,
            half_day_count: 0.0,
            half_day_fraction: 0.5,
            half_day_deduction: Some(undertime as f64 / 100.0),
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
            approved_working_day_overage: false,
        })
        .unwrap();
        assert_eq!(cutoff.late_deduction, late, "{employee_id}");
        assert_eq!(cutoff.half_day_deduction, undertime, "{employee_id}");
        assert_eq!(cutoff.total_deductions, late + undertime, "{employee_id}");
        assert_eq!(cutoff.net_pay, attendance_days * 8_000 - late - undertime, "{employee_id}");
        cutoff_net_total += cutoff.net_pay;
    }
    assert_eq!(cutoff_net_total, 119_000);
}

#[test]
fn cutoff_payroll_matches_shared_versioned_contract_fixtures() {
    use services::cutoff_payroll::{calculate, CutoffInput};
    use serde_json::Value;

    let fixture: Value = serde_json::from_str(include_str!("../../shared/payroll-fixtures.json"))
        .expect("valid shared payroll fixtures");
    assert_eq!(fixture["version"], 1);

    for scenario in fixture["cases"].as_array().expect("fixture cases") {
        let name = scenario["name"].as_str().expect("case name");
        let mut merged = fixture["baseInput"].as_object().expect("base input").clone();
        for (key, value) in scenario["input"].as_object().expect("case input") {
            merged.insert(key.clone(), value.clone());
        }
        let input = Value::Object(merged);
        let number = |key: &str| input[key].as_f64().unwrap_or(0.0);
        let optional_number = |key: &str| input[key].as_f64();
        let string = |key: &str| input[key].as_str().expect("string input").to_owned();
        let optional_string = |key: &str| input[key].as_str().map(str::to_owned);
        let cutoff = CutoffInput {
            employee_id: string("employeeId"),
            employee_name: string("employeeName"),
            employee_type: string("employeeType"),
            cutoff_start: string("cutoffStart"),
            cutoff_end: string("cutoffEnd"),
            daily_rate: number("dailyRate"),
            standard_working_days: number("standardWorkingDays"),
            actual_working_days: number("actualWorkingDays"),
            basic_pay: optional_number("basicPay"),
            special_holiday_days: number("specialHolidayDays"),
            special_holiday_multiplier: number("specialHolidayMultiplier"),
            special_holiday_pay: optional_number("specialHolidayPay"),
            regular_holiday_days: number("regularHolidayDays"),
            regular_holiday_multiplier: number("regularHolidayMultiplier"),
            regular_holiday_pay: optional_number("regularHolidayPay"),
            hra: number("hra"),
            incentives_allowance: number("incentivesAllowance"),
            special_allowance: number("specialAllowance"),
            late_deduction: number("lateDeduction"),
            half_day_count: number("halfDayCount"),
            half_day_fraction: number("halfDayFraction"),
            half_day_deduction: optional_number("halfDayDeduction"),
            absent_days: number("absentDays"),
            absence_deduction: optional_number("absenceDeduction"),
            overtime_hours: number("overtimeHours"),
            overtime_rate: number("overtimeRate"),
            overtime_pay: optional_number("overtimePay"),
            sss_employee_share: number("sss"),
            phic_employee_share: number("phic"),
            hdmf_employee_share: number("hdmf"),
            salary_advance: number("salaryAdvance"),
            manual_adjustment: number("manualAdjustment"),
            adjustment_reason: optional_string("adjustmentReason"),
            approved_working_day_overage: input["approvedWorkingDayOverage"].as_bool().expect("approval flag"),
        };

        let result = calculate(&cutoff);
        if let Some(error) = scenario["error"].as_str() {
            assert!(result.as_ref().err().is_some_and(|message| message.contains(error)), "{name}: {result:?}");
            continue;
        }
        let result = result.unwrap_or_else(|error| panic!("{name}: {error}"));
        for (key, expected) in scenario["expected"].as_object().expect("expected output") {
            let expected_centavos = (expected.as_f64().expect("expected number") * 100.0).round() as i64;
            let actual = match key.as_str() {
                "basicPay" => result.basic_pay,
                "specialHolidayPay" => result.special_holiday_pay,
                "regularHolidayPay" => result.regular_holiday_pay,
                "totalAllowance" => result.total_allowance,
                "halfDayDeduction" => result.half_day_deduction,
                "manualAdjustment" => result.gross_compensation
                    - result.basic_pay
                    - result.special_holiday_pay
                    - result.regular_holiday_pay
                    - result.total_allowance
                    - result.overtime_pay,
                "grossCompensation" => result.gross_compensation,
                "netPay" => result.net_pay,
                key => panic!("unsupported expected output {key}"),
            };
            assert_eq!(actual, expected_centavos, "{name}: {key}");
        }
    }
}
