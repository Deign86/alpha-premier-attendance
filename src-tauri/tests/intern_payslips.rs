// Runnable proof (on Windows) of the intern payslip backend: the payslip
// numbers derived from the payroll-sheet row, last-name-first naming and
// ordering, readable Windows-safe file names, and the PNG writer. The lib unit
// tests cannot execute in this environment (the lib test binary fails to load
// native deps), so this harness includes the reporting module directly,
// mirroring payroll_sheet_undertime.rs to avoid Tauri/WebView2 in the test
// process.
// include!d app sources: items only the app (not this harness) uses are expected to be unused here.
#[allow(dead_code)]
mod config {
    #[derive(Debug, Clone)]
    pub struct OfficeConfig {
        pub company_name: String,
        pub tax_identification_number: Option<String>,
    }

    impl Default for OfficeConfig {
        fn default() -> Self {
            Self {
                company_name: "Alpha Premier Group of Companies OPC.".into(),
                tax_identification_number: Some("010-871-213-0000".into()),
            }
        }
    }

    impl OfficeConfig {
        pub fn display_full(&self) -> String {
            "Unit 3104C, Tektite East Tower, Ortigas Center, Pasig, Metro Manila".into()
        }
    }
}

// include!d app sources: items only the app (not this harness) uses are expected to be unused here.
#[allow(dead_code)]
mod services {
    pub mod payroll {
        include!("../src/services/payroll.rs");
    }

    pub mod lunch_break {
        include!("../src/services/lunch_break.rs");
    }
}

// include!d app sources: items only the app (not this harness) uses are expected to be unused here.
#[allow(dead_code)]
mod reporting {
    include!("../src/reporting/mod.rs");
}

use reporting::{
    load_intern_payslips, load_payroll_sheet_rows, payroll_row_order_key,
    payslip_display_file_stem, surname_first_name, surname_sort_key, write_intern_payslip_images,
    InternPayslip, InternPayslipImage,
};

const START: &str = "2026-09-16";
const END: &str = "2026-09-30";

async fn migrated_db() -> sqlx::SqlitePool {
    let db = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("in-memory database");
    sqlx::migrate!("./db/migrations")
        .run(&db)
        .await
        .expect("migrations");
    db
}

async fn insert_user(db: &sqlx::SqlitePool, user_id: &str, employee_type: &str, department: &str) {
    sqlx::query(
        "INSERT INTO users (user_id, rfid_uid, full_name, department, status, created_at, \
         employee_type, updated_at) \
         VALUES (?1, ?1, ?1, ?2, 'ACTIVE', '2026-01-01T00:00:00Z', ?3, '2026-01-01T00:00:00Z')",
    )
    .bind(user_id)
    .bind(department)
    .bind(employee_type)
    .execute(db)
    .await
    .expect("user row");
}

/// One payroll_cutoffs row; unspecified amounts default to a clean 11-day cutoff.
struct Cutoff<'a> {
    employee_id: &'a str,
    name: &'a str,
    cutoff_start: &'a str,
    cutoff_end: &'a str,
    standard_days: f64,
    actual_days: f64,
    daily: i64,
    late: i64,
    half_day_count: f64,
    half_day_deduction: i64,
    absent_days: f64,
    absence: i64,
    manual_adjustment: i64,
    net: i64,
}

fn cutoff<'a>(employee_id: &'a str, name: &'a str) -> Cutoff<'a> {
    Cutoff {
        employee_id,
        name,
        cutoff_start: START,
        cutoff_end: END,
        standard_days: 11.0,
        actual_days: 11.0,
        daily: 8_000,
        late: 0,
        half_day_count: 0.0,
        half_day_deduction: 0,
        absent_days: 0.0,
        absence: 0,
        manual_adjustment: 0,
        net: 88_000,
    }
}

async fn insert_cutoff(db: &sqlx::SqlitePool, row: &Cutoff<'_>) {
    sqlx::query(
        "INSERT INTO payroll_cutoffs (payroll_id, employee_id, employee_name, payroll_profile_id, \
         payroll_cutoff_label, cutoff_start, cutoff_end, payroll_frequency, daily_rate_centavos, \
         standard_working_days, actual_working_days, basic_pay_centavos, special_holiday_days, \
         special_holiday_multiplier, special_holiday_pay_centavos, regular_holiday_days, \
         regular_holiday_multiplier, regular_holiday_pay_centavos, incentives_allowance_centavos, \
         special_allowance_centavos, total_compensation_centavos, total_allowance_centavos, \
         late_units, late_deduction_centavos, half_day_count, half_day_deduction_centavos, \
         absent_days, absence_deduction_centavos, overtime_hours, overtime_rate_centavos, \
         overtime_pay_centavos, manual_adjustment_centavos, gross_compensation_centavos, \
         net_pay_centavos, calculation_breakdown, approved_working_day_overage, status, \
         created_at, updated_at) \
         VALUES (?1, ?2, ?3, 'INTERN', 'Sep 16-30, 2026', ?4, ?5, 'SEMI_MONTHLY', ?6, ?7, ?8, \
         ?9, 0, 1.0, 0, 0, 1.0, 0, 0, 0, ?10, 0, 0, ?11, ?12, ?13, ?14, ?15, 0, 0, 0, ?16, ?17, \
         ?18, '{}', 0, 'FINALIZED', '2026-09-30T00:00:00Z', '2026-09-30T00:00:00Z')",
    )
    .bind(format!("P-{}-{}", row.employee_id, row.cutoff_start))
    .bind(row.employee_id)
    .bind(row.name)
    .bind(row.cutoff_start)
    .bind(row.cutoff_end)
    .bind(row.daily)
    .bind(row.standard_days)
    .bind(row.actual_days)
    .bind((row.daily as f64 * row.actual_days).round() as i64)
    .bind((row.daily as f64 * row.standard_days).round() as i64)
    .bind(row.late)
    .bind(row.half_day_count)
    .bind(row.half_day_deduction)
    .bind(row.absent_days)
    .bind(row.absence)
    .bind(row.manual_adjustment)
    .bind(row.net)
    .bind(row.net)
    .execute(db)
    .await
    .expect("cutoff row");
}

async fn payslips(db: &sqlx::SqlitePool) -> Vec<InternPayslip> {
    load_intern_payslips(db, START, END)
        .await
        .expect("payslips")
}

#[tokio::test]
async fn reference_payslip_matches_the_hr_template() {
    let db = migrated_db().await;
    insert_user(&db, "INT-1", "INTERN", "IT").await;
    let mut row = cutoff("INT-1", "John Patrick Rubio");
    row.actual_days = 10.0;
    row.absent_days = 1.0;
    row.absence = 8_000;
    row.net = 80_000;
    insert_cutoff(&db, &row).await;

    assert_eq!(
        payslips(&db).await,
        vec![InternPayslip {
            employee_id: "INT-1".into(),
            employee_name: "RUBIO, JOHN PATRICK".into(),
            department: "IT".into(),
            designation: "INTERN".into(),
            tin: String::new(),
            bank_name: "CASH".into(),
            account_number: "0000".into(),
            standard_working_days: 11.0,
            actual_working_days: 10.0,
            daily_rate_centavos: 8_000,
            basic_centavos: 80_000,
            gross_salary_centavos: 88_000,
            adjustment_centavos: 0,
            total_earnings_centavos: 88_000,
            absent_centavos: 8_000,
            late_centavos: 0,
            halfday_centavos: 0,
            undertime_centavos: 0,
            total_deductions_centavos: 8_000,
            net_pay_centavos: 80_000,
        }]
    );
}

#[tokio::test]
async fn stored_net_that_differs_is_balanced_by_the_adjustment() {
    let db = migrated_db().await;
    insert_user(&db, "INT-1", "INTERN", "IT").await;
    insert_user(&db, "INT-2", "INTERN", "IT").await;
    // Manual +PHP 50 on top of a one-day absence.
    let mut adjusted = cutoff("INT-1", "Ana Adjusted");
    adjusted.actual_days = 10.0;
    adjusted.absent_days = 1.0;
    adjusted.absence = 8_000;
    adjusted.manual_adjustment = 5_000;
    adjusted.net = 85_000;
    insert_cutoff(&db, &adjusted).await;
    // Deductions exceed the cutoff rate, so the stored net is floored at zero.
    let mut floored = cutoff("INT-2", "Zoe Floored");
    floored.actual_days = 0.0;
    floored.absent_days = 11.0;
    floored.absence = 88_000;
    floored.late = 5_000;
    floored.net = 0;
    insert_cutoff(&db, &floored).await;

    let slips = payslips(&db).await;
    assert_eq!(slips.len(), 2);
    assert_eq!(slips[0].employee_id, "INT-1");
    assert_eq!(slips[0].adjustment_centavos, 5_000);
    assert_eq!(slips[0].total_earnings_centavos, 93_000);
    assert_eq!(slips[0].net_pay_centavos, 85_000);
    assert_eq!(slips[1].employee_id, "INT-2");
    assert_eq!(slips[1].adjustment_centavos, 5_000);
    assert_eq!(slips[1].total_deductions_centavos, 93_000);
    assert_eq!(slips[1].net_pay_centavos, 0);
    for slip in &slips {
        assert_eq!(
            slip.total_earnings_centavos - slip.total_deductions_centavos,
            slip.net_pay_centavos
        );
    }
}

#[tokio::test]
async fn late_halfday_and_undertime_come_straight_from_the_sheet_row() {
    let db = migrated_db().await;
    insert_user(&db, "INT-1", "INTERN", "IT").await;
    let mut row = cutoff("INT-1", "Maria Santos");
    row.late = 1_000;
    // Stored half-day deduction = 2 half-days (PHP 80) + PHP 100 undertime.
    row.half_day_count = 2.0;
    row.half_day_deduction = 18_000;
    row.net = 69_000;
    insert_cutoff(&db, &row).await;

    let sheet = load_payroll_sheet_rows(&db, START, END, "INTERN")
        .await
        .expect("sheet rows");
    let slips = payslips(&db).await;
    assert_eq!(slips.len(), 1);
    let slip = &slips[0];
    assert_eq!(slip.late_centavos, sheet[0].late_deduction_centavos);
    assert_eq!(slip.halfday_centavos, sheet[0].half_day_deduction_centavos);
    assert_eq!(
        slip.undertime_centavos,
        sheet[0].undertime_deduction_centavos
    );
    assert_eq!(
        (
            slip.late_centavos,
            slip.halfday_centavos,
            slip.undertime_centavos
        ),
        (1_000, 8_000, 10_000)
    );
    assert_eq!(slip.absent_centavos, 0);
    assert_eq!(slip.total_deductions_centavos, 19_000);
    assert_eq!(slip.basic_centavos, 88_000);
    assert_eq!(slip.adjustment_centavos, 0);
    assert_eq!(slip.total_earnings_centavos, 88_000);
    assert_eq!(slip.net_pay_centavos, 69_000);
}

#[tokio::test]
async fn employee_rows_and_other_cutoffs_are_excluded() {
    let db = migrated_db().await;
    insert_user(&db, "INT-1", "INTERN", "IT").await;
    insert_user(&db, "EMP-1", "EMPLOYEE", "HR").await;
    insert_cutoff(&db, &cutoff("INT-1", "Maria Santos")).await;
    insert_cutoff(&db, &cutoff("EMP-1", "Ada Lovelace")).await;
    let mut earlier = cutoff("INT-1", "Maria Santos");
    earlier.cutoff_start = "2026-09-01";
    earlier.cutoff_end = "2026-09-15";
    insert_cutoff(&db, &earlier).await;

    let slips = payslips(&db).await;
    assert_eq!(slips.len(), 1);
    assert_eq!(slips[0].employee_id, "INT-1");
}

#[tokio::test]
async fn identity_and_bank_details_prefer_the_cutoff_then_the_user_then_defaults() {
    let db = migrated_db().await;
    insert_user(&db, "INT-A", "INTERN", "Marketing").await;
    insert_user(&db, "INT-B", "INTERN", "IT").await;
    sqlx::query(
        "UPDATE users SET tin = '111-222', designation = 'Marketing Intern', bank_name = 'BPI', \
         account_number = '1234' WHERE user_id = 'INT-A'",
    )
    .execute(&db)
    .await
    .expect("user details");
    insert_cutoff(&db, &cutoff("INT-A", "Ana Alpha")).await;
    insert_cutoff(&db, &cutoff("INT-B", "Ben Bravo")).await;
    // INT-A: blank cutoff fields fall through to the user. INT-B: the cutoff wins.
    sqlx::query("UPDATE payroll_cutoffs SET bank_name = '', account_number = '' WHERE employee_id = 'INT-A'")
        .execute(&db)
        .await
        .expect("blank cutoff bank");
    sqlx::query(
        "UPDATE payroll_cutoffs SET department = 'Ops', designation = 'Lead', tin = '999-888', \
         bank_name = 'BDO', account_number = '9988' WHERE employee_id = 'INT-B'",
    )
    .execute(&db)
    .await
    .expect("cutoff details");

    let slips = payslips(&db).await;
    let a = &slips[0];
    assert_eq!(a.employee_id, "INT-A");
    assert_eq!(
        (
            a.department.as_str(),
            a.designation.as_str(),
            a.tin.as_str()
        ),
        ("Marketing", "Marketing Intern", "111-222")
    );
    assert_eq!(
        (a.bank_name.as_str(), a.account_number.as_str()),
        ("BPI", "1234")
    );
    let b = &slips[1];
    assert_eq!(b.employee_id, "INT-B");
    assert_eq!(
        (
            b.department.as_str(),
            b.designation.as_str(),
            b.tin.as_str()
        ),
        ("Ops", "Lead", "999-888")
    );
    assert_eq!(
        (b.bank_name.as_str(), b.account_number.as_str()),
        ("BDO", "9988")
    );
}

#[tokio::test]
async fn payslips_serialize_with_the_camel_case_contract_keys() {
    let db = migrated_db().await;
    insert_user(&db, "INT-1", "INTERN", "IT").await;
    insert_cutoff(&db, &cutoff("INT-1", "Maria Santos")).await;
    let value = serde_json::to_value(&payslips(&db).await[0]).expect("payslip json");
    let mut keys = value
        .as_object()
        .expect("payslip object")
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    keys.sort();
    let mut expected = [
        "employeeId",
        "employeeName",
        "department",
        "designation",
        "tin",
        "bankName",
        "accountNumber",
        "standardWorkingDays",
        "actualWorkingDays",
        "dailyRateCentavos",
        "basicCentavos",
        "grossSalaryCentavos",
        "adjustmentCentavos",
        "totalEarningsCentavos",
        "absentCentavos",
        "lateCentavos",
        "halfdayCentavos",
        "undertimeCentavos",
        "totalDeductionsCentavos",
        "netPayCentavos",
    ]
    .map(String::from);
    expected.sort();
    assert_eq!(keys, expected);
    assert_eq!(value["netPayCentavos"], 88_000);
}

#[test]
fn surname_first_name_formats_stored_first_name_first_names() {
    for (stored, expected) in [
        ("John Patrick Rubio", "RUBIO, JOHN PATRICK"),
        ("Deign Grey O. Lazaro", "LAZARO, DEIGN GREY O."),
        ("Karla Ines De Vera", "DE VERA, KARLA INES"),
        ("Ma. Clarisse Zamora", "ZAMORA, MA. CLARISSE"),
        ("Ar-jay Fernandez", "FERNANDEZ, AR-JAY"),
        ("Alyssa Joy E. Villanueva", "VILLANUEVA, ALYSSA JOY E."),
        ("Juan Dela Cruz Jr.", "DELA CRUZ, JUAN JR."),
        ("Maria de los Santos", "DE LOS SANTOS, MARIA"),
        ("Madonna", "MADONNA"),
        ("Rubio, John", "RUBIO, JOHN"),
        ("  Ana   Maria   Reyes  ", "REYES, ANA MARIA"),
        ("Pedro Penduko III", "PENDUKO, PEDRO III"),
        ("Jose Rizal Sr", "RIZAL, JOSE SR"),
        ("Dela Cruz, Juan Jr.", "DELA CRUZ, JUAN JR."),
        ("Joaquin Ñoño", "ÑOÑO, JOAQUIN"),
        ("Madonna Jr.", "MADONNA JR."),
        ("", ""),
    ] {
        assert_eq!(
            surname_first_name(stored),
            expected,
            "stored name {stored:?}"
        );
    }
    // Already formatted names are left alone.
    assert_eq!(
        surname_first_name("DELA CRUZ, JUAN JR."),
        "DELA CRUZ, JUAN JR."
    );
    // "Rubio," has no given names, so it is just the surname.
    assert_eq!(surname_first_name("Rubio,"), "RUBIO");
}

#[test]
fn surname_sort_key_orders_last_name_first_then_given_then_id() {
    assert_eq!(
        surname_sort_key("Karla Ines De Vera"),
        ("de vera".to_string(), "karla ines".to_string())
    );
    // The suffix is not part of the key; display and stored forms agree.
    assert_eq!(
        surname_sort_key("Juan Dela Cruz Jr."),
        surname_sort_key("DELA CRUZ, JUAN JR.")
    );
    let mut rows = [
        ("Zed Rubio", "INT-9"),
        ("John Patrick Rubio", "INT-3"),
        ("Allan Alcantara", "INT-5"),
        ("Karla Ines De Vera", "INT-4"),
        ("Allan Alcantara", "INT-2"),
        ("Ar-jay Fernandez", "INT-6"),
    ];
    rows.sort_by_cached_key(|(name, id)| payroll_row_order_key(START, name, id));
    assert_eq!(
        rows.map(|(_, id)| id),
        ["INT-2", "INT-5", "INT-4", "INT-6", "INT-3", "INT-9"]
    );
    // Newest cutoff first, then names within a cutoff.
    let mut cutoffs = [
        ("2026-09-01", "Zed Rubio"),
        ("2026-09-16", "Zed Rubio"),
        ("2026-09-16", "Allan Alcantara"),
        ("2026-09-01", "Allan Alcantara"),
    ];
    cutoffs.sort_by_cached_key(|(start, name)| payroll_row_order_key(start, name, "INT-1"));
    assert_eq!(
        cutoffs,
        [
            ("2026-09-16", "Allan Alcantara"),
            ("2026-09-16", "Zed Rubio"),
            ("2026-09-01", "Allan Alcantara"),
            ("2026-09-01", "Zed Rubio"),
        ]
    );
}

#[tokio::test]
async fn sheet_rows_and_payslips_are_last_name_alphabetical() {
    let db = migrated_db().await;
    for id in ["INT-1", "INT-2", "INT-3"] {
        insert_user(&db, id, "INTERN", "IT").await;
    }
    // Inserted out of order on purpose (and first-name-first, as stored).
    insert_cutoff(&db, &cutoff("INT-1", "John Patrick Rubio")).await;
    insert_cutoff(&db, &cutoff("INT-2", "Allan Alcantara")).await;
    insert_cutoff(&db, &cutoff("INT-3", "Karla Ines De Vera")).await;

    let sheet = load_payroll_sheet_rows(&db, START, END, "INTERN")
        .await
        .expect("sheet rows");
    assert_eq!(
        sheet
            .iter()
            .map(|row| row.employee_name.as_str())
            .collect::<Vec<_>>(),
        [
            "ALCANTARA, ALLAN",
            "DE VERA, KARLA INES",
            "RUBIO, JOHN PATRICK"
        ]
    );
    assert_eq!(
        payslips(&db)
            .await
            .iter()
            .map(|slip| slip.employee_name.as_str())
            .collect::<Vec<_>>(),
        [
            "ALCANTARA, ALLAN",
            "DE VERA, KARLA INES",
            "RUBIO, JOHN PATRICK"
        ]
    );
}

#[test]
fn display_file_stem_is_readable_and_windows_safe() {
    assert_eq!(
        payslip_display_file_stem("RUBIO, JOHN PATRICK"),
        "RUBIO, JOHN PATRICK"
    );
    assert_eq!(
        payslip_display_file_stem("DE LA CRUZ, MA. ÑOÑA (JR.)"),
        "DE LA CRUZ, MA. ÑOÑA (JR.)"
    );
    assert_eq!(
        payslip_display_file_stem("O'BRIEN-SMITH, ANA"),
        "O'BRIEN-SMITH, ANA"
    );
    assert_eq!(
        payslip_display_file_stem("A<B>C:D\"E/F\\G|H?I*J"),
        "ABCDEFGHIJ"
    );
    assert_eq!(
        payslip_display_file_stem("  RUBIO,\t JOHN \n  PATRICK  "),
        "RUBIO, JOHN PATRICK"
    );
    assert_eq!(payslip_display_file_stem("A : B"), "A B");
    assert_eq!(payslip_display_file_stem("RUBIO, JOHN..."), "RUBIO, JOHN");
    assert_eq!(payslip_display_file_stem("RUBIO, JOHN . ."), "RUBIO, JOHN");
    assert_eq!(payslip_display_file_stem("A\u{0007}B"), "AB");
    assert_eq!(payslip_display_file_stem("con"), "con-file");
    assert_eq!(payslip_display_file_stem("NUL."), "NUL-file");
    assert_eq!(payslip_display_file_stem("Com1"), "Com1-file");
    assert_eq!(payslip_display_file_stem("LPT9"), "LPT9-file");
    assert_eq!(payslip_display_file_stem("COM0"), "COM0");
    assert_eq!(payslip_display_file_stem("CONSOLE"), "CONSOLE");
    assert_eq!(payslip_display_file_stem(""), "payslip");
    assert_eq!(payslip_display_file_stem(" <>:\"/\\|?* "), "payslip");
    assert_eq!(payslip_display_file_stem("..."), "payslip");
    let long = payslip_display_file_stem(&"Ñ".repeat(300));
    assert_eq!(long.chars().count(), 120);
    // Capping must not leave a trailing space or dot behind.
    let spaced = format!("{} B", "A".repeat(119));
    assert_eq!(payslip_display_file_stem(&spaced), "A".repeat(119));
}

fn tiny_png_base64() -> String {
    use base64::Engine;
    let mut bytes = Vec::new();
    image::RgbaImage::new(1, 1)
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .expect("encode png");
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn image_for(employee_id: &str, name: &str, png_base64: &str) -> InternPayslipImage {
    InternPayslipImage {
        employee_id: employee_id.into(),
        employee_name: name.into(),
        png_base64: png_base64.into(),
    }
}

fn temp_payslip_dir() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("intern-payslips-{}", uuid::Uuid::new_v4()))
}

#[test]
fn writes_one_png_per_intern_with_collision_safe_names() {
    let dir = temp_payslip_dir();
    let png = tiny_png_base64();
    let names = write_intern_payslip_images(
        &dir,
        &[
            image_for("INT-1", "RUBIO, JOHN PATRICK", &png),
            image_for("INT-2", "Maria Santos", &png),
            image_for("INT-3", "rubio, john patrick", &png),
            image_for("INT-3", "RUBIO, JOHN PATRICK", &png),
            image_for("INT-4", "con", &png),
        ],
    )
    .expect("images written");
    assert_eq!(
        names,
        [
            "RUBIO, JOHN PATRICK.png",
            "Maria Santos.png",
            "rubio, john patrick (INT-3).png",
            "RUBIO, JOHN PATRICK (INT-3) (2).png",
            "con-file.png",
        ]
    );
    for name in &names {
        let bytes = std::fs::read(dir.join(name)).expect("written file");
        assert!(bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]));
    }
    assert_eq!(std::fs::read_dir(&dir).expect("dir").count(), names.len());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn rejects_bad_batches_without_writing_anything() {
    use base64::Engine;
    let png = tiny_png_base64();
    let dir = temp_payslip_dir();

    let not_png = base64::engine::general_purpose::STANDARD.encode(b"definitely not a png");
    assert_eq!(
        write_intern_payslip_images(
            &dir,
            &[
                image_for("INT-1", "Good One", &png),
                image_for("INT-2", "Bad One", &not_png)
            ],
        ),
        Err("INVALID_PAYSLIP_IMAGE".to_string())
    );
    assert_eq!(
        write_intern_payslip_images(
            &dir,
            &[image_for("INT-1", "Bad Base64", "***not base64***")]
        ),
        Err("INVALID_PAYSLIP_IMAGE".to_string())
    );
    assert_eq!(
        write_intern_payslip_images(&dir, &[]),
        Err("NO_PAYSLIP_IMAGES".to_string())
    );
    let many = vec![image_for("INT-1", "Many", &png); 1001];
    assert_eq!(
        write_intern_payslip_images(&dir, &many),
        Err("TOO_MANY_PAYSLIP_IMAGES".to_string())
    );
    let mut oversized = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    oversized.resize(15 * 1024 * 1024 + 1, 0);
    let oversized = base64::engine::general_purpose::STANDARD.encode(oversized);
    assert_eq!(
        write_intern_payslip_images(&dir, &[image_for("INT-1", "Huge", &oversized)]),
        Err("PAYSLIP_IMAGE_TOO_LARGE".to_string())
    );
    assert!(!dir.exists(), "a rejected batch must not create the folder");
}
