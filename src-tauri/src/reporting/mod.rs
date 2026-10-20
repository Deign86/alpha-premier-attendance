pub fn sanitize_filename_component(value: &str) -> String {
    let mut output = String::new();
    let mut pending_separator = false;
    for ch in value.trim().chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            if pending_separator && !output.is_empty() {
                output.push('-');
            }
            pending_separator = false;
            output.push(ch);
        } else {
            pending_separator = true;
        }
    }
    let mut result = output
        .trim_matches('-')
        .chars()
        .take(40)
        .collect::<String>();
    if result.is_empty() {
        result = "export".to_string();
    }
    if matches!(
        result.to_ascii_uppercase().as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "LPT1"
    ) {
        result.push_str("-file");
    }
    result
}

pub fn format_php(centavos: i64) -> String {
    let negative = centavos < 0;
    let absolute = centavos.unsigned_abs();
    let pesos = absolute / 100;
    let cents = absolute % 100;
    let digits = pesos.to_string();
    let mut grouped = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    if negative {
        format!("-PHP {grouped}.{cents:02}")
    } else {
        format!("PHP {grouped}.{cents:02}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::OfficeConfig;
    use std::path::PathBuf;

    fn office() -> OfficeConfig {
        OfficeConfig::default()
    }

    #[test]
    fn sanitizes_windows_filename_components_without_losing_identity() {
        assert_eq!(
            sanitize_filename_component("  Ana / Santos: 2026?  "),
            "Ana-Santos-2026"
        );
        assert_eq!(sanitize_filename_component("CON"), "CON-file");
        assert_eq!(sanitize_filename_component(""), "export");
    }

    #[test]
    fn formats_centavos_as_php_without_float_rounding() {
        assert_eq!(format_php(123456), "PHP 1,234.56");
        assert_eq!(format_php(-50), "-PHP 0.50");
    }

    #[test]
    fn formats_timestamps_as_manila_hhmmss() {
        assert_eq!(display_timestamp("2026-08-01T08:30:00+08:00"), "08:30:00");
        assert_eq!(display_timestamp("2026-08-01T00:05:00Z"), "08:05:00");
        assert_eq!(display_timestamp("not-a-timestamp"), "not-a-timestamp");
    }

    #[tokio::test]
    async fn intern_sheet_row_includes_late_deduction_in_display_and_net() {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory database");
        sqlx::query("CREATE TABLE users (user_id TEXT PRIMARY KEY, employee_type TEXT NOT NULL)")
            .execute(&db)
            .await
            .expect("users table");
        sqlx::query(
             "CREATE TABLE payroll_cutoffs (payroll_id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, \
              employee_name TEXT NOT NULL, daily_rate_centavos INTEGER NOT NULL, \
              standard_working_days REAL NOT NULL, actual_working_days REAL NOT NULL, \
              basic_pay_centavos INTEGER NOT NULL, total_compensation_centavos INTEGER NOT NULL, \
              late_deduction_centavos INTEGER NOT NULL, half_day_deduction_centavos INTEGER NOT NULL, \
               half_day_count REAL NOT NULL DEFAULT 0, absent_days REAL NOT NULL, absence_deduction_centavos INTEGER NOT NULL, \
               manual_adjustment_centavos INTEGER NOT NULL, gross_compensation_centavos INTEGER NOT NULL, \
               net_pay_centavos INTEGER NOT NULL, \
               cutoff_start TEXT NOT NULL, cutoff_end TEXT NOT NULL)",
        )
        .execute(&db)
        .await
        .expect("payroll_cutoffs table");
        sqlx::query("INSERT INTO users (user_id, employee_type) VALUES ('INT-1', 'INTERN')")
            .execute(&db)
            .await
            .expect("intern user");
        sqlx::query("INSERT INTO users (user_id, employee_type) VALUES ('EMP-1', 'EMPLOYEE')")
            .execute(&db)
            .await
            .expect("employee user");
        for (payroll_id, employee_id, employee_name) in
            [("P-INT", "INT-1", "Maria Santos"), ("P-EMP", "EMP-1", "Ada Lovelace")]
        {
            sqlx::query(
                "INSERT INTO payroll_cutoffs (payroll_id, employee_id, employee_name, \
                 daily_rate_centavos, standard_working_days, actual_working_days, \
                 basic_pay_centavos, total_compensation_centavos, late_deduction_centavos, \
                  half_day_deduction_centavos, absent_days, absence_deduction_centavos, \
                  manual_adjustment_centavos, gross_compensation_centavos, net_pay_centavos, cutoff_start, cutoff_end) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(payroll_id)
            .bind(employee_id)
            .bind(employee_name)
            .bind(8_000_i64)
            .bind(11.0_f64)
            .bind(11.0_f64)
            .bind(88_000_i64)
            .bind(88_000_i64)
            .bind(1_000_i64)
            .bind(0_i64)
            .bind(0.0_f64)
            .bind(0_i64)
            .bind(0_i64)
            .bind(88_000_i64)
            .bind(87_000_i64)
            .bind("2026-08-16")
            .bind("2026-08-31")
            .execute(&db)
            .await
            .expect("cutoff row");
        }
        let intern_rows = load_payroll_sheet_rows(&db, "2026-08-16", "2026-08-31", "INTERN")
            .await
            .expect("intern sheet rows");
        assert_eq!(intern_rows.len(), 1);
        assert_eq!(intern_rows[0].late_deduction_centavos, 1_000);
        assert_eq!(intern_rows[0].gross_compensation_centavos, 87_000);
        // This fixture row carries only a late deduction (half-day is 0).
        assert_eq!(intern_rows[0].undertime_deduction_centavos, 0);
        // Stored half-day deduction combines half-days and undertime: 2 half-days at
        // PHP 80/day = PHP 80, leaving PHP 100 of undertime out of PHP 180.
        sqlx::query(
            "UPDATE payroll_cutoffs SET half_day_count = 2, half_day_deduction_centavos = 18000 \
             WHERE payroll_id = 'P-INT'",
        )
        .execute(&db)
        .await
        .expect("half-day fixture");
        let split_rows = load_payroll_sheet_rows(&db, "2026-08-16", "2026-08-31", "INTERN")
            .await
            .expect("intern sheet rows");
        assert_eq!(split_rows[0].half_day_deduction_centavos, 8_000);
        assert_eq!(split_rows[0].undertime_deduction_centavos, 10_000);
        let employee_rows = load_payroll_sheet_rows(&db, "2026-08-16", "2026-08-31", "EMPLOYEE")
            .await
            .expect("employee sheet rows");
        assert_eq!(employee_rows.len(), 1);
        assert_eq!(employee_rows[0].late_deduction_centavos, 1_000);
        assert_eq!(employee_rows[0].gross_compensation_centavos, 87_000);
        let pdf = std::env::temp_dir().join(format!("payroll-header-{}.pdf", uuid::Uuid::new_v4()));
        generate_payroll_sheet_pdf(&intern_rows, "August 16-31, 2026", "INTERN", &office(), &pdf)
            .expect("payroll sheet pdf");
        let bytes = std::fs::read(&pdf).expect("payroll sheet pdf bytes");
        assert!(bytes.windows(b"Net".len()).any(|window| window == b"Net"));
        let _ = std::fs::remove_file(&pdf);
    }

    #[test]
    fn generates_an_attendance_workbook_with_expected_headers() {
        let path =
            std::env::temp_dir().join(format!("attendance-report-{}.xlsx", uuid::Uuid::new_v4()));
        let rows = vec![AttendanceExportRow {
            employee_id: "E-1".into(),
            employee_name: "Ana Santos".into(),
            department: Some("QA".into()),
            date: "2026-08-01".into(),
            time_in: Some("8:00 AM".into()),
            time_out: Some("5:00 PM".into()),
            total_hours: 8.0,
            status: "COMPLETED".into(),
            source: "RFID".into(),
            notes: String::new(),
            recorded_by: None,
            recorded_reason: None,
            recorded_at: None,
        }];
        generate_attendance_workbook(&rows, "2026-08-01", &office(), &path).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes.starts_with(b"PK"));
        assert!(bytes.len() > 1_000);
        let _ = std::fs::remove_file(PathBuf::from(path));
    }

    #[test]
    fn attendance_workbook_metadata_contains_the_canonical_office_address() {
        let path =
            std::env::temp_dir().join(format!("attendance-office-{}.xlsx", uuid::Uuid::new_v4()));
        let rows = vec![AttendanceExportRow {
            employee_id: "E-1".into(),
            employee_name: "Ana Santos".into(),
            department: None,
            date: "2026-08-01".into(),
            time_in: None,
            time_out: None,
            total_hours: 0.0,
            status: "WORKING".into(),
            source: "RFID".into(),
            notes: String::new(),
            recorded_by: None,
            recorded_reason: None,
            recorded_at: None,
        }];
        generate_attendance_workbook(&rows, "2026-08-01", &office(), &path).unwrap();
        let shared = read_xlsx_shared_strings(&path);
        assert!(shared.contains("Company: Alpha Premier"));
        assert!(
            shared.contains("Unit 3104C, Tektite East Tower, Ortigas Center, Pasig, Metro Manila")
        );
        let _ = std::fs::remove_file(&path);
    }

    fn read_xlsx_shared_strings(path: &std::path::Path) -> String {
        let file = std::fs::File::open(path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut shared = archive.by_name("xl/sharedStrings.xml").unwrap();
        let mut contents = String::new();
        use std::io::Read;
        shared.read_to_string(&mut contents).unwrap();
        contents
    }

    #[test]
    fn builds_managed_artifact_filename_without_employee_pii() {
        assert_eq!(
            attendance_artifact_filename("2026-08-01", "job-123"),
            "AlphaPremier_Attendance_20260801_job-123.xlsx"
        );
    }

    #[test]
    fn brand_mark_decodes_and_registers_on_a_document() {
        let mut document = PdfDocument::new("brand mark test");
        let mark = brand_mark_image(&mut document, 15.0);
        assert!(
            mark.is_some(),
            "embedded phoenix PNG should decode from the repo asset"
        );
        let (id, dpi) = mark.expect("brand mark");
        let op = brand_mark_op(id, dpi, 10.0, 10.0);
        assert!(matches!(op, Op::UseXobject { .. }));
        // The mark is registered in the document resources so saving succeeds.
        let bytes = document
            .with_pages(vec![PdfPage::new(Mm(210.0), Mm(297.0), vec![op])])
            .save(&PdfSaveOptions::default(), &mut Vec::new());
        assert!(bytes.starts_with(b"%PDF"));
    }

    #[test]
    fn generates_payroll_sheet_pdf_with_reference_columns_and_grand_total() {
        let rows = vec![
            PayrollSheetRow {
                employee_id: "E-1".into(),
                employee_name: "Ada Lovelace".into(),
                employee_type: "EMPLOYEE".into(),
                cutoff_rate_centavos: 55_000_00,
                daily_rate_centavos: 500_00,
                actual_working_days: 11.0,
                standard_working_days: 11.0,
                basic_pay_centavos: 550_000,
                total_compensation_centavos: 550_000,
                late_deduction_centavos: 0,
                half_day_deduction_centavos: 0,
                undertime_deduction_centavos: 18_000,
                absence_deduction_centavos: 0,
                gross_compensation_centavos: 550_000,
            },
            PayrollSheetRow {
                employee_id: "INT-1".into(),
                employee_name: "Maria Santos".into(),
                employee_type: "INTERN".into(),
                cutoff_rate_centavos: 8_800_00,
                daily_rate_centavos: 80_00,
                actual_working_days: 1.0,
                standard_working_days: 11.0,
                basic_pay_centavos: 8_800_00,
                total_compensation_centavos: 8_800_00,
                late_deduction_centavos: 0,
                half_day_deduction_centavos: 0,
                undertime_deduction_centavos: 0,
                absence_deduction_centavos: 8_000_00,
                gross_compensation_centavos: 800_00,
            },
            PayrollSheetRow {
                employee_id: "INT-2".into(),
                employee_name: "Alex Cruz".into(),
                employee_type: "INTERN".into(),
                cutoff_rate_centavos: 8_800_00,
                daily_rate_centavos: 80_00,
                actual_working_days: 3.0,
                standard_working_days: 11.0,
                basic_pay_centavos: 8_800_00,
                total_compensation_centavos: 8_800_00,
                late_deduction_centavos: 0,
                half_day_deduction_centavos: 40_00,
                undertime_deduction_centavos: 0,
                absence_deduction_centavos: 64_00_00,
                gross_compensation_centavos: 200_00,
            },
        ];
        let base = std::env::temp_dir().join(format!("payroll-sheet-{}", uuid::Uuid::new_v4()));
        let pdf = base.with_extension("pdf");
        generate_payroll_sheet_pdf(&rows, "August 16-31, 2026", "INTERN", &office(), &pdf)
            .unwrap();
        let bytes = std::fs::read(&pdf).unwrap();
        assert!(bytes.starts_with(b"%PDF"));
        assert!(bytes.windows(b"Undertime".len()).any(|window| window == b"Undertime"));
        assert_eq!(format_php(rows[0].undertime_deduction_centavos), "PHP 180.00");
        let _ = std::fs::remove_file(&pdf);
    }

    #[test]
    fn generates_samples_to_exports_for_preview() {
        let out_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("samples");
        let _ = std::fs::create_dir_all(&out_dir);

        // 1. Intern Payroll Sample
        let intern_rows = vec![
            PayrollSheetRow {
                employee_id: "APG-2026-108".into(),
                employee_name: "Raineer C. Rosado".into(),
                employee_type: "INTERN".into(),
                cutoff_rate_centavos: 3_300_00,
                daily_rate_centavos: 300_00,
                actual_working_days: 11.0,
                standard_working_days: 11.0,
                basic_pay_centavos: 3_300_00,
                total_compensation_centavos: 3_300_00,
                late_deduction_centavos: 0,
                half_day_deduction_centavos: 0,
                undertime_deduction_centavos: 0,
                absence_deduction_centavos: 0,
                gross_compensation_centavos: 3_300_00,
            },
            PayrollSheetRow {
                employee_id: "APG-2026-102".into(),
                employee_name: "Deign Grey O. Lazaro".into(),
                employee_type: "INTERN".into(),
                cutoff_rate_centavos: 3_300_00,
                daily_rate_centavos: 300_00,
                actual_working_days: 11.0,
                standard_working_days: 11.0,
                basic_pay_centavos: 3_300_00,
                total_compensation_centavos: 3_300_00,
                late_deduction_centavos: 0,
                half_day_deduction_centavos: 0,
                undertime_deduction_centavos: 0,
                absence_deduction_centavos: 0,
                gross_compensation_centavos: 3_300_00,
            },
            PayrollSheetRow {
                employee_id: "APG-2026-113".into(),
                employee_name: "Ar-jee Felizarte".into(),
                employee_type: "INTERN".into(),
                cutoff_rate_centavos: 3_300_00,
                daily_rate_centavos: 300_00,
                actual_working_days: 10.5,
                standard_working_days: 11.0,
                basic_pay_centavos: 3_150_00,
                total_compensation_centavos: 3_150_00,
                late_deduction_centavos: 10_00,
                half_day_deduction_centavos: 150_00,
                undertime_deduction_centavos: 0,
                absence_deduction_centavos: 0,
                gross_compensation_centavos: 2_990_00,
            },
            PayrollSheetRow {
                employee_id: "APG-2026-111".into(),
                employee_name: "Ma. Ellaine Zapico".into(),
                employee_type: "INTERN".into(),
                cutoff_rate_centavos: 3_300_00,
                daily_rate_centavos: 300_00,
                actual_working_days: 11.0,
                standard_working_days: 11.0,
                basic_pay_centavos: 3_300_00,
                total_compensation_centavos: 3_300_00,
                late_deduction_centavos: 0,
                half_day_deduction_centavos: 0,
                undertime_deduction_centavos: 0,
                absence_deduction_centavos: 0,
                gross_compensation_centavos: 3_300_00,
            },
            PayrollSheetRow {
                employee_id: "APG-2026-109".into(),
                employee_name: "Elaizah Jane Altiche".into(),
                employee_type: "INTERN".into(),
                cutoff_rate_centavos: 3_300_00,
                daily_rate_centavos: 300_00,
                actual_working_days: 11.0,
                standard_working_days: 11.0,
                basic_pay_centavos: 3_300_00,
                total_compensation_centavos: 3_300_00,
                late_deduction_centavos: 0,
                half_day_deduction_centavos: 0,
                undertime_deduction_centavos: 0,
                absence_deduction_centavos: 0,
                gross_compensation_centavos: 3_300_00,
            },
            PayrollSheetRow {
                employee_id: "APG-2026-110".into(),
                employee_name: "Bianca Marie Antoy".into(),
                employee_type: "INTERN".into(),
                cutoff_rate_centavos: 3_300_00,
                daily_rate_centavos: 300_00,
                actual_working_days: 11.0,
                standard_working_days: 11.0,
                basic_pay_centavos: 3_300_00,
                total_compensation_centavos: 3_300_00,
                late_deduction_centavos: 0,
                half_day_deduction_centavos: 0,
                undertime_deduction_centavos: 0,
                absence_deduction_centavos: 0,
                gross_compensation_centavos: 3_300_00,
            },
            PayrollSheetRow {
                employee_id: "APG-2026-112".into(),
                employee_name: "John Frederick Ruiz".into(),
                employee_type: "INTERN".into(),
                cutoff_rate_centavos: 3_300_00,
                daily_rate_centavos: 300_00,
                actual_working_days: 11.0,
                standard_working_days: 11.0,
                basic_pay_centavos: 3_300_00,
                total_compensation_centavos: 3_300_00,
                late_deduction_centavos: 0,
                half_day_deduction_centavos: 0,
                undertime_deduction_centavos: 0,
                absence_deduction_centavos: 0,
                gross_compensation_centavos: 3_300_00,
            },
            PayrollSheetRow {
                employee_id: "APG-2026-099".into(),
                employee_name: "Jeremy Bugarin".into(),
                employee_type: "INTERN".into(),
                cutoff_rate_centavos: 3_300_00,
                daily_rate_centavos: 300_00,
                actual_working_days: 11.0,
                standard_working_days: 11.0,
                basic_pay_centavos: 3_300_00,
                total_compensation_centavos: 3_300_00,
                late_deduction_centavos: 0,
                half_day_deduction_centavos: 0,
                undertime_deduction_centavos: 0,
                absence_deduction_centavos: 0,
                gross_compensation_centavos: 3_300_00,
            },
            PayrollSheetRow {
                employee_id: "APG-2026-100".into(),
                employee_name: "Kylle Ricio".into(),
                employee_type: "INTERN".into(),
                cutoff_rate_centavos: 3_300_00,
                daily_rate_centavos: 300_00,
                actual_working_days: 11.0,
                standard_working_days: 11.0,
                basic_pay_centavos: 3_300_00,
                total_compensation_centavos: 3_300_00,
                late_deduction_centavos: 0,
                half_day_deduction_centavos: 0,
                undertime_deduction_centavos: 0,
                absence_deduction_centavos: 0,
                gross_compensation_centavos: 3_300_00,
            },
        ];
        let intern_pdf = out_dir.join("sample_intern_payroll.pdf");
        generate_payroll_sheet_pdf(
            &intern_rows,
            "JULY 16-31, 2026",
            "INTERN",
            &office(),
            &intern_pdf,
        )
        .unwrap();
    }

    #[test]
    fn payroll_sheet_paginates_long_registers_onto_multiple_pages() {
        let rows: Vec<PayrollSheetRow> = (0..(SHEET_ROWS_PER_PAGE + 3))
            .map(|index| PayrollSheetRow {
                employee_id: format!("E-{index}"),
                employee_name: format!("Employee {index}"),
                employee_type: "EMPLOYEE".into(),
                cutoff_rate_centavos: 55_000_00,
                daily_rate_centavos: 500_00,
                actual_working_days: 11.0,
                standard_working_days: 11.0,
                basic_pay_centavos: 550_000,
                total_compensation_centavos: 550_000,
                late_deduction_centavos: 0,
                half_day_deduction_centavos: 0,
                undertime_deduction_centavos: 0,
                absence_deduction_centavos: 0,
                gross_compensation_centavos: 550_000,
            })
            .collect();
        let base =
            std::env::temp_dir().join(format!("payroll-sheet-pages-{}", uuid::Uuid::new_v4()));
        let pdf = base.with_extension("pdf");
        generate_payroll_sheet_pdf(&rows, "August 1-15, 2026", "EMPLOYEE", &office(), &pdf)
            .unwrap();
        assert!(std::fs::read(&pdf).unwrap().starts_with(b"%PDF"));
        let _ = std::fs::remove_file(&pdf);
    }

    #[test]
    fn payroll_sheet_cutoff_rate_rounds_daily_rate_times_standard_days() {
        let rows = vec![PayrollSheetRow {
            employee_id: "E-1".into(),
            employee_name: "Ada Lovelace".into(),
            employee_type: "EMPLOYEE".into(),
            cutoff_rate_centavos: (123_45_i64 as f64 * 10.5).round() as i64,
            daily_rate_centavos: 123_45,
            actual_working_days: 10.5,
            standard_working_days: 10.5,
            basic_pay_centavos: 550_000,
            total_compensation_centavos: 550_000,
            late_deduction_centavos: 0,
            half_day_deduction_centavos: 0,
            undertime_deduction_centavos: 0,
            absence_deduction_centavos: 0,
            gross_compensation_centavos: 550_000,
        }];
        assert_eq!(
            rows[0].cutoff_rate_centavos,
            (123_45_i64 as f64 * 10.5).round() as i64
        );
        let base =
            std::env::temp_dir().join(format!("payroll-sheet-rate-{}", uuid::Uuid::new_v4()));
        let pdf = base.with_extension("pdf");
        generate_payroll_sheet_pdf(&rows, "August 1-15, 2026", "EMPLOYEE", &office(), &pdf)
            .unwrap();
        assert!(std::fs::read(&pdf).unwrap().starts_with(b"%PDF"));
        let _ = std::fs::remove_file(&pdf);
    }

    #[test]
    fn format_days_omits_trailing_decimal_for_whole_day_counts() {
        assert_eq!(format_days(11.0), "11");
        assert_eq!(format_days(10.5), "10.5");
        assert_eq!(format_days(0.0), "0");
    }

}
use printpdf::{
    BuiltinFont, Mm, Op, PaintMode, PdfDocument, PdfFontHandle, PdfPage, PdfSaveOptions, Point, Pt,
    RawImage, Rect, TextItem, XObjectTransform,
};

/// Phoenix brand mark embedded at compile time so PDF reports never depend on
/// runtime asset paths. The mark is transparent-backed and works on white paper.
const BRAND_PHOENIX_PNG: &[u8] = include_bytes!("../../../assets/logo_phoenix.png");

pub const PAYROLL_SHEET_UNDERTIME_HEADER: &str = "Undertime\nDeduction (PHP)";

/// Decodes and registers the phoenix mark on the document, returning the image
/// id plus the dpi that renders the square mark `size_mm` tall. Registered once
/// per document and reused on every page. Returns `None` (and logs) if the
/// embedded PNG cannot be decoded so a decorative mark never fails a document.
fn brand_mark_image(
    document: &mut PdfDocument,
    size_mm: f32,
) -> Option<(printpdf::XObjectId, f32)> {
    match RawImage::decode_from_bytes(BRAND_PHOENIX_PNG, &mut Vec::new()) {
        Ok(image) => {
            // PDF maps the image to its natural size at `dpi`; choose the dpi
            // that renders the mark at the requested millimeter size.
            let dpi = image.width as f32 / (size_mm / 25.4);
            let id = document.add_image(&image);
            Some((id, dpi))
        }
        Err(error) => {
            log::warn!("Brand mark skipped for PDF: {error}");
            None
        }
    }
}

/// Builds the `UseXobject` op that paints the registered mark at `(x_mm, y_mm)`
/// (bottom-left origin, PDF space).
fn brand_mark_op(id: printpdf::XObjectId, dpi: f32, x_mm: f32, y_mm: f32) -> Op {
    Op::UseXobject {
        id,
        transform: XObjectTransform {
            translate_x: Some(Pt(x_mm * 72.0 / 25.4)),
            translate_y: Some(Pt(y_mm * 72.0 / 25.4)),
            dpi: Some(dpi),
            ..Default::default()
        },
    }
}
use rust_xlsxwriter::{
    Color, Format, FormatAlign, FormatBorder, Table, TableStyle, Workbook, XlsxError,
};
use sqlx::Row;

#[derive(Debug, Clone, PartialEq)]
pub struct AttendanceExportRow {
    pub employee_id: String,
    pub employee_name: String,
    pub department: Option<String>,
    pub date: String,
    pub time_in: Option<String>,
    pub time_out: Option<String>,
    pub total_hours: f64,
    pub status: String,
    pub source: String,
    pub notes: String,
    pub recorded_by: Option<String>,
    pub recorded_reason: Option<String>,
    pub recorded_at: Option<String>,
}

pub fn attendance_artifact_filename(report_date: &str, job_id: &str) -> String {
    let date = report_date.replace('-', "");
    format!(
        "AlphaPremier_Attendance_{}_{}.xlsx",
        sanitize_filename_component(&date),
        sanitize_filename_component(job_id)
    )
}

pub async fn load_attendance_rows(
    db: &sqlx::SqlitePool,
    report_date: &str,
) -> Result<Vec<AttendanceExportRow>, sqlx::Error> {
    let rows = sqlx::query("SELECT user_id, full_name, department, attendance_date, time_in, time_out, status, source, notes, recorded_by, recorded_reason, recorded_at FROM attendance WHERE attendance_date = ? ORDER BY time_in, full_name, user_id")
        .bind(report_date)
        .fetch_all(db)
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let time_in: Option<String> = row.get("time_in");
            let time_out: Option<String> = row.get("time_out");
            AttendanceExportRow {
                employee_id: row.get("user_id"),
                employee_name: row.get("full_name"),
                department: row.get("department"),
                date: row.get("attendance_date"),
                time_in: time_in.as_deref().map(display_timestamp),
                time_out: time_out.as_deref().map(display_timestamp),
                total_hours: match (time_in.as_deref(), time_out.as_deref()) {
                    (Some(start), Some(end)) => elapsed_hours(start, end),
                    _ => 0.0,
                },
                status: row.get("status"),
                source: row.get("source"),
                notes: row.get("notes"),
                recorded_by: row.get("recorded_by"),
                recorded_reason: row.get("recorded_reason"),
                recorded_at: row.get("recorded_at"),
            }
        })
        .collect())
}

fn display_timestamp(value: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|timestamp| {
            timestamp
                .with_timezone(&chrono_tz::Asia::Manila)
                .format("%H:%M:%S")
                .to_string()
        })
        .unwrap_or_else(|_| value.to_string())
}

fn elapsed_hours(start: &str, end: &str) -> f64 {
    match (
        chrono::DateTime::parse_from_rfc3339(start),
        chrono::DateTime::parse_from_rfc3339(end),
    ) {
        (Ok(start), Ok(end)) => {
            // NOTE (post-0.1.74): the TOTAL_HOURS export column is net of the
            // fixed 12:00–13:00 lunch break, as is payroll `worked_hours` —
            // both derive from lunch_break::paid_work_hours (net, not gross).
            // That alignment aside,
            // reconciliation is a separate product decision — do not "fix" it
            // by changing this function as part of a payroll-test fix.
            crate::services::lunch_break::paid_work_hours(
                start.with_timezone(&chrono_tz::Asia::Manila),
                end.with_timezone(&chrono_tz::Asia::Manila),
            )
        }
        _ => 0.0,
    }
}

pub fn generate_attendance_workbook(
    rows: &[AttendanceExportRow],
    report_date: &str,
    office: &crate::config::OfficeConfig,
    path: &std::path::Path,
) -> Result<(), XlsxError> {
    let mut workbook = Workbook::new();
    let title_format = Format::new()
        .set_bold()
        .set_font_size(16)
        .set_font_color(Color::White)
        .set_background_color(Color::RGB(0x1F4E78))
        .set_align(FormatAlign::Center);
    let metadata_format = Format::new()
        .set_italic()
        .set_font_color(Color::RGB(0x666666));
    let header_format = Format::new()
        .set_bold()
        .set_font_color(Color::White)
        .set_background_color(Color::RGB(0x1A4E3F))
        .set_border(FormatBorder::Thin)
        .set_text_wrap();
    let body_format = Format::new()
        .set_border(FormatBorder::Thin)
        .set_background_color(Color::White);
    let alt_body_format = Format::new()
        .set_border(FormatBorder::Thin)
        .set_background_color(Color::RGB(0xF2F2F2));
    let number_format = Format::new()
        .set_border(FormatBorder::Thin)
        .set_background_color(Color::White)
        .set_num_format("0.00");
    let alt_number_format = Format::new()
        .set_border(FormatBorder::Thin)
        .set_background_color(Color::RGB(0xF2F2F2))
        .set_num_format("0.00");
    let worksheet = workbook.add_worksheet().set_name("Attendance")?;
    let title = format!("Attendance Register - {report_date}");
    worksheet.merge_range(0, 0, 0, 12, &title, &title_format)?;
    worksheet.write_string_with_format(
        1,
        0,
        format!("Company: {}", office.company_name),
        &metadata_format,
    )?;
    worksheet.write_string_with_format(2, 0, office.display_full(), &metadata_format)?;
    worksheet.write_string_with_format(
        3,
        0,
        "Timezone: Asia/Manila | Hours exclude the 12:00-13:00 lunch break | Status: FINAL DATA FROM SQLITE",
        &metadata_format,
    )?;
    let headers = [
        "EMPLOYEE_ID",
        "EMPLOYEE_NAME",
        "DEPARTMENT",
        "DATE",
        "TIME_IN",
        "TIME_OUT",
        "TOTAL_HOURS",
        "STATUS",
        "SOURCE",
        "RECORDED_BY",
        "RECORDED_REASON",
        "RECORDED_AT",
        "NOTES",
    ];
    for (column, header) in headers.iter().enumerate() {
        worksheet.write_string_with_format(5, column as u16, *header, &header_format)?;
    }
    for (index, row) in rows.iter().enumerate() {
        let excel_row = (index + 6) as u32;
        let strings_before = [
            row.employee_id.as_str(),
            row.employee_name.as_str(),
            row.department.as_deref().unwrap_or(""),
            row.date.as_str(),
            row.time_in.as_deref().unwrap_or(""),
            row.time_out.as_deref().unwrap_or(""),
        ];
        let strings_after = [
            row.status.as_str(),
            row.source.as_str(),
            row.recorded_by.as_deref().unwrap_or(""),
            row.recorded_reason.as_deref().unwrap_or(""),
            row.recorded_at.as_deref().unwrap_or(""),
            row.notes.as_str(),
        ];
        let fill = if index % 2 == 1 {
            &alt_body_format
        } else {
            &body_format
        };
        for (column, value) in strings_before.iter().enumerate() {
            worksheet.write_string_with_format(excel_row, column as u16, *value, fill)?;
        }
        let number_fill = if index % 2 == 1 {
            &alt_number_format
        } else {
            &number_format
        };
        worksheet.write_number_with_format(excel_row, 6, row.total_hours, number_fill)?;
        for (offset, value) in strings_after.iter().enumerate() {
            worksheet.write_string_with_format(excel_row, (offset + 7) as u16, *value, fill)?;
        }
    }
    let last_row = (rows.len() + 5) as u32;
    if !rows.is_empty() {
        let table = Table::new().set_style(TableStyle::Medium2);
        worksheet.add_table(5, 0, last_row, 12, &table)?;
    }
    let mut widths = [0usize; 13];
    for (column, header) in headers.iter().enumerate() {
        widths[column] = header.len();
    }
    for row in rows {
        let values = [
            row.employee_id.len(),
            row.employee_name.len(),
            row.department.as_deref().unwrap_or("").len(),
            row.date.len(),
            row.time_in.as_deref().unwrap_or("").len(),
            row.time_out.as_deref().unwrap_or("").len(),
            format!("{:.2}", row.total_hours).len(),
            row.status.len(),
            row.source.len(),
            row.recorded_by.as_deref().unwrap_or("").len(),
            row.recorded_reason.as_deref().unwrap_or("").len(),
            row.recorded_at.as_deref().unwrap_or("").len(),
            row.notes.len(),
        ];
        for (column, length) in values.iter().enumerate() {
            widths[column] = widths[column].max(*length);
        }
    }
    for (column, width) in widths.iter().enumerate() {
        worksheet.set_column_width(column as u16, (*width as f64) + 2.0)?;
    }
    worksheet.set_freeze_panes(6, 0)?;
    worksheet.set_repeat_rows(0, 5)?;
    worksheet.set_landscape();
    worksheet.set_paper_size(9);
    worksheet.set_margins(0.35, 0.35, 0.5, 0.5, 0.3, 0.3);
    worksheet.set_print_area(0, 0, last_row.max(5), 12)?;
    workbook.save(path)
}

/// One row of the consolidated payroll sheet. Mirrors the reference column
/// layout of the printable payroll worksheet (Employee #, Employee Name,
/// Cut Off Rate, Daily Rate, Actual Working Days, Standard Working Days,
/// Basic Rate, Total Compensation, Late 10 /hr, Halfday, Absent, Net
/// Compensation) so the generated PDF matches the on-paper payroll reference.
#[derive(Debug, Clone, PartialEq)]
pub struct PayrollSheetRow {
    pub employee_id: String,
    pub employee_name: String,
    pub employee_type: String,
    /// Daily rate x standard working days (rounded to the nearest centavo).
    pub cutoff_rate_centavos: i64,
    pub daily_rate_centavos: i64,
    pub actual_working_days: f64,
    pub standard_working_days: f64,
    pub basic_pay_centavos: i64,
    pub total_compensation_centavos: i64,
    pub late_deduction_centavos: i64,
    pub half_day_deduction_centavos: i64,
    pub undertime_deduction_centavos: i64,
    pub absence_deduction_centavos: i64,
    /// The sheet's Net Compensation amount (stored net, with a legacy recompute fallback).
    pub gross_compensation_centavos: i64,
}

/// Trailing name suffixes kept after the given names ("Juan Dela Cruz Jr.").
const NAME_SUFFIXES: &[&str] = &["jr", "sr", "ii", "iii", "iv", "v"];
/// Lowercase particles that belong to the surname ("De Guerto", "De Los Santos").
const SURNAME_PARTICLES: &[&str] = &[
    "de", "del", "dela", "della", "delos", "la", "las", "los", "san", "santa", "santo", "sta",
    "sto", "van", "von", "der", "den", "di", "da", "du", "dos", "das",
];

fn name_words(text: &str) -> Vec<&str> {
    text.split(|ch: char| ch == ',' || ch.is_whitespace())
        .filter(|word| !word.is_empty())
        .collect()
}

fn word_in(word: &str, list: &[&str]) -> bool {
    list.contains(&word.trim_end_matches('.').to_lowercase().as_str())
}

/// Index where the trailing suffix words start (always keeps one name word).
fn suffix_start(words: &[&str]) -> usize {
    let mut start = words.len();
    while start > 1 && word_in(words[start - 1], NAME_SUFFIXES) {
        start -= 1;
    }
    start
}

/// Splits a stored first-name-first name ("Juan Dela Cruz Jr.") into
/// (surname, given names, suffix). A name that already has a comma is taken as
/// "SURNAME, GIVEN" and split at the first comma.
fn split_name_parts(full_name: &str) -> (String, String, String) {
    let (before, after) = full_name.split_once(',').unwrap_or((full_name, ""));
    let (before, after) = (name_words(before), name_words(after));
    let (surname, given, suffix) = if !before.is_empty() && !after.is_empty() {
        let mut given = after;
        let suffix = given.split_off(suffix_start(&given));
        (before, given, suffix)
    } else {
        let mut words = [before, after].concat();
        let suffix = words.split_off(suffix_start(&words));
        let mut start = words.len().saturating_sub(1);
        while start > 1 && word_in(words[start - 1], SURNAME_PARTICLES) {
            start -= 1;
        }
        let surname = words.split_off(start);
        (surname, words, suffix)
    };
    (surname.join(" "), given.join(" "), suffix.join(" "))
}

fn join_nonempty(parts: &[&str]) -> String {
    parts
        .iter()
        .copied()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Last-name-first display for payroll output: "John Frederick Ruiz" becomes
/// "RUIZ, JOHN FREDERICK"; a single word is just uppercased.
pub fn surname_first_name(full_name: &str) -> String {
    let (surname, given, suffix) = split_name_parts(full_name);
    let display = if given.is_empty() {
        join_nonempty(&[&surname, &suffix])
    } else {
        format!("{surname}, {}", join_nonempty(&[&given, &suffix]))
    };
    display.to_uppercase()
}

/// (surname, given names), lowercased, for alphabetical last-name ordering.
pub fn surname_sort_key(full_name: &str) -> (String, String) {
    let (surname, given, _) = split_name_parts(full_name);
    (surname.to_lowercase(), given.to_lowercase())
}

/// Payroll row order: newest cutoff first, then last-name alphabetical, then
/// employee id. Sorting with this key keeps the Payroll tab, the Intern
/// Payroll PDF and the payslips in one consistent order.
pub fn payroll_row_order_key(
    cutoff_start: &str,
    full_name: &str,
    employee_id: &str,
) -> (std::cmp::Reverse<String>, (String, String), String) {
    (
        std::cmp::Reverse(cutoff_start.to_string()),
        surname_sort_key(full_name),
        employee_id.to_string(),
    )
}

/// Loads the payroll sheet rows for one cutoff, filtered to `worker_type`
/// ("EMPLOYEE" keeps employees; anything else keeps interns). Payroll cutoff
/// rows do not store an employee type column, so it is derived from the live
/// Users register (defaulting to INTERN when the user is missing). Names come
/// back as "SURNAME, GIVEN NAMES" and rows are ordered last-name alphabetical.
pub async fn load_payroll_sheet_rows(
    db: &sqlx::SqlitePool,
    cutoff_start: &str,
    cutoff_end: &str,
    worker_type: &str,
) -> Result<Vec<PayrollSheetRow>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT pc.employee_id, pc.employee_name, pc.daily_rate_centavos, \
         pc.standard_working_days, pc.actual_working_days, pc.basic_pay_centavos, \
         pc.total_compensation_centavos, pc.late_deduction_centavos, \
         pc.half_day_deduction_centavos, pc.half_day_count, pc.absent_days, pc.absence_deduction_centavos, \
         pc.manual_adjustment_centavos, \
          pc.gross_compensation_centavos, pc.net_pay_centavos, COALESCE(u.employee_type, 'INTERN') AS employee_type \
         FROM payroll_cutoffs pc LEFT JOIN users u ON u.user_id = pc.employee_id \
         WHERE pc.cutoff_start = ? AND pc.cutoff_end = ? \
         ORDER BY pc.employee_name, pc.employee_id",
    )
    .bind(cutoff_start)
    .bind(cutoff_end)
    .fetch_all(db)
    .await?;
    let keep_employee = worker_type == "EMPLOYEE";
    let mut sheet_rows: Vec<PayrollSheetRow> = rows
        .into_iter()
        .filter(|row| {
            let employee_type = row.get::<String, _>("employee_type");
            if keep_employee {
                employee_type == "EMPLOYEE"
            } else {
                employee_type != "EMPLOYEE"
            }
        })
        .map(|row| {
            let daily_rate_centavos = row.get::<i64, _>("daily_rate_centavos");
            let standard_working_days = row.get::<f64, _>("standard_working_days");
            let actual_working_days = row.get::<f64, _>("actual_working_days");
            let cutoff_rate_centavos = (daily_rate_centavos as f64 * standard_working_days).round()
                as i64;
            let late_deduction_centavos = row.get::<i64, _>("late_deduction_centavos");
            let effective_late_deduction = late_deduction_centavos;
            let half_day_deduction_centavos = row.get::<i64, _>("half_day_deduction_centavos");
            // The stored deduction is half-days (half the daily rate each) plus undertime;
            // split it for the two sheet columns.
            let half_day_only_centavos = ((daily_rate_centavos as f64
                * row.get::<f64, _>("half_day_count")
                * 0.5)
                .round() as i64)
                .clamp(0, half_day_deduction_centavos.max(0));
            let undertime_deduction_centavos = half_day_deduction_centavos - half_day_only_centavos;
            let db_absent_days = row.get::<f64, _>("absent_days");
            let db_absence_deduction = row.get::<i64, _>("absence_deduction_centavos");
            let absent_days = if db_absent_days > 0.0 {
                db_absent_days
            } else {
                (standard_working_days - actual_working_days).max(0.0)
            };
            let absence_deduction_centavos = if db_absence_deduction > 0 {
                db_absence_deduction
            } else if absent_days > 0.0 {
                (daily_rate_centavos as f64 * absent_days).round() as i64
            } else {
                0
            };
            // For the sheet presentation, Total Compensation represents the full cutoff rate.
            let total_compensation_centavos = cutoff_rate_centavos;
            let manual_adjustment_centavos = row
                .try_get::<i64, _>("manual_adjustment_centavos")
                .unwrap_or(0);
            let gross_compensation_centavos = (total_compensation_centavos
                + manual_adjustment_centavos
                - effective_late_deduction
                - half_day_deduction_centavos
                - absence_deduction_centavos)
                .max(0);
            // The sheet's Net column equals stored net_pay_centavos; recompute only for older DBs
            // that do not have that column in their payroll_cutoffs table.
            let gross_compensation_centavos = row
                .try_get::<i64, _>("net_pay_centavos")
                .unwrap_or(gross_compensation_centavos);
            PayrollSheetRow {
                employee_id: row.get("employee_id"),
                employee_name: surname_first_name(&row.get::<String, _>("employee_name")),
                employee_type: row.get("employee_type"),
                cutoff_rate_centavos,
                daily_rate_centavos,
                actual_working_days,
                standard_working_days,
                basic_pay_centavos: row.get("basic_pay_centavos"),
                total_compensation_centavos,
                late_deduction_centavos: effective_late_deduction,
                half_day_deduction_centavos: half_day_only_centavos,
                undertime_deduction_centavos,
                absence_deduction_centavos,
                gross_compensation_centavos,
            }
        })
        .collect();
    // Last-name alphabetical regardless of the SQL order above.
    sheet_rows.sort_by_cached_key(|row| {
        payroll_row_order_key(cutoff_start, &row.employee_name, &row.employee_id)
    });
    Ok(sheet_rows)
}

/// One intern payslip, derived from the payroll-sheet row so the payslip and
/// the Intern Payroll PDF always agree. Amounts are centavos.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InternPayslip {
    pub employee_id: String,
    pub employee_name: String,
    pub department: String,
    pub designation: String,
    pub tin: String,
    pub bank_name: String,
    pub account_number: String,
    pub standard_working_days: f64,
    pub actual_working_days: f64,
    pub daily_rate_centavos: i64,
    pub basic_centavos: i64,
    pub gross_salary_centavos: i64,
    pub adjustment_centavos: i64,
    pub total_earnings_centavos: i64,
    pub absent_centavos: i64,
    pub late_centavos: i64,
    pub halfday_centavos: i64,
    pub undertime_centavos: i64,
    pub total_deductions_centavos: i64,
    pub net_pay_centavos: i64,
}

/// Loads one payslip per intern for the cutoff. Every amount comes from
/// `load_payroll_sheet_rows` (same ordering and filtering as the Intern
/// Payroll PDF); only the identity/bank details are read separately.
/// `adjustment_centavos` balances manual adjustments, approved extra days and
/// the zero floor so that `total_earnings - total_deductions == net_pay`.
pub async fn load_intern_payslips(
    db: &sqlx::SqlitePool,
    cutoff_start: &str,
    cutoff_end: &str,
) -> Result<Vec<InternPayslip>, sqlx::Error> {
    let sheet_rows = load_payroll_sheet_rows(db, cutoff_start, cutoff_end, "INTERN").await?;
    let details = sqlx::query(
        "SELECT pc.employee_id, \
         COALESCE(NULLIF(pc.department, ''), u.department, '') AS department, \
         COALESCE(NULLIF(pc.designation, ''), NULLIF(u.designation, ''), 'INTERN') AS designation, \
         COALESCE(NULLIF(pc.tin, ''), u.tin, '') AS tin, \
         COALESCE(NULLIF(pc.bank_name, ''), NULLIF(u.bank_name, ''), 'CASH') AS bank_name, \
         COALESCE(NULLIF(pc.account_number, ''), NULLIF(u.account_number, ''), '0000') AS account_number \
         FROM payroll_cutoffs pc LEFT JOIN users u ON u.user_id = pc.employee_id \
         WHERE pc.cutoff_start = ? AND pc.cutoff_end = ?",
    )
    .bind(cutoff_start)
    .bind(cutoff_end)
    .fetch_all(db)
    .await?
    .into_iter()
    .map(|row| {
        (
            row.get::<String, _>("employee_id"),
            (
                row.get::<String, _>("department"),
                row.get::<String, _>("designation"),
                row.get::<String, _>("tin"),
                row.get::<String, _>("bank_name"),
                row.get::<String, _>("account_number"),
            ),
        )
    })
    .collect::<std::collections::HashMap<_, _>>();

    Ok(sheet_rows
        .into_iter()
        .map(|row| {
            let (department, designation, tin, bank_name, account_number) =
                details.get(&row.employee_id).cloned().unwrap_or_else(|| {
                    (
                        String::new(),
                        "INTERN".into(),
                        String::new(),
                        "CASH".into(),
                        "0000".into(),
                    )
                });
            let basic_centavos =
                (row.daily_rate_centavos as f64 * row.actual_working_days).round() as i64;
            let gross_salary_centavos = row.cutoff_rate_centavos;
            let total_deductions_centavos = row.absence_deduction_centavos
                + row.late_deduction_centavos
                + row.half_day_deduction_centavos
                + row.undertime_deduction_centavos;
            // `gross_compensation_centavos` on the sheet row is the stored net.
            let net_pay_centavos = row.gross_compensation_centavos;
            let adjustment_centavos =
                net_pay_centavos - (gross_salary_centavos - total_deductions_centavos);
            InternPayslip {
                employee_id: row.employee_id,
                employee_name: row.employee_name,
                department,
                designation,
                tin,
                bank_name,
                account_number,
                standard_working_days: row.standard_working_days,
                actual_working_days: row.actual_working_days,
                daily_rate_centavos: row.daily_rate_centavos,
                basic_centavos,
                gross_salary_centavos,
                adjustment_centavos,
                total_earnings_centavos: gross_salary_centavos + adjustment_centavos,
                absent_centavos: row.absence_deduction_centavos,
                late_centavos: row.late_deduction_centavos,
                halfday_centavos: row.half_day_deduction_centavos,
                undertime_centavos: row.undertime_deduction_centavos,
                total_deductions_centavos,
                net_pay_centavos,
            }
        })
        .collect())
}

/// A readable Windows-safe file stem for a payslip image: unlike
/// `sanitize_filename_component` it keeps spaces, commas and non-ASCII letters,
/// so "RUIZ, JOHN FREDERICK" stays as-is.
pub fn payslip_display_file_stem(value: &str) -> String {
    let cleaned = value
        .chars()
        .filter(|ch| {
            !matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
                && (!ch.is_control() || ch.is_whitespace())
        })
        .collect::<String>();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let capped = collapsed.chars().take(120).collect::<String>();
    let mut stem = capped.trim_end_matches(['.', ' ']).to_string();
    if stem.is_empty() {
        stem = "payslip".to_string();
    }
    let upper = stem.to_ascii_uppercase();
    let reserved = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            upper
                .strip_prefix(prefix)
                .is_some_and(|digit| matches!(digit.as_bytes(), [b'1'..=b'9']))
        });
    if reserved {
        stem.push_str("-file");
    }
    stem
}

/// One rendered payslip PNG handed over by the WebView.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InternPayslipImage {
    pub employee_id: String,
    pub employee_name: String,
    pub png_base64: String,
}

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
const MAX_PAYSLIP_IMAGES: usize = 1000;
const MAX_PAYSLIP_IMAGE_BYTES: usize = 15 * 1024 * 1024;

/// Writes one `{intern name}.png` per image into `dir` and returns the file
/// names in input order. Everything is validated before the first byte is
/// written, so a rejected batch leaves no folder behind. Names that collide
/// (case-insensitively) get the employee id, then a counter, appended.
pub fn write_intern_payslip_images(
    dir: &std::path::Path,
    images: &[InternPayslipImage],
) -> Result<Vec<String>, String> {
    use base64::Engine;
    if images.is_empty() {
        return Err("NO_PAYSLIP_IMAGES".into());
    }
    if images.len() > MAX_PAYSLIP_IMAGES {
        return Err("TOO_MANY_PAYSLIP_IMAGES".into());
    }
    let mut taken = std::collections::HashSet::new();
    let mut files = Vec::with_capacity(images.len());
    for image in images {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(image.png_base64.trim())
            .map_err(|_| "INVALID_PAYSLIP_IMAGE".to_string())?;
        if !bytes.starts_with(&PNG_SIGNATURE) {
            return Err("INVALID_PAYSLIP_IMAGE".into());
        }
        if bytes.len() > MAX_PAYSLIP_IMAGE_BYTES {
            return Err("PAYSLIP_IMAGE_TOO_LARGE".into());
        }
        let mut stem = payslip_display_file_stem(&image.employee_name);
        if taken.contains(&stem.to_lowercase()) {
            stem = format!("{stem} ({})", payslip_display_file_stem(&image.employee_id));
        }
        let base = stem.clone();
        let mut counter = 2;
        while taken.contains(&stem.to_lowercase()) {
            stem = format!("{base} ({counter})");
            counter += 1;
        }
        taken.insert(stem.to_lowercase());
        files.push((format!("{stem}.png"), bytes));
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    for (name, bytes) in &files {
        std::fs::write(dir.join(name), bytes).map_err(|e| e.to_string())?;
    }
    Ok(files.into_iter().map(|(name, _)| name).collect())
}

/// Formats a working-day count without a trailing `.0` ("11", "11.5").
fn format_days(value: f64) -> String {
    if value.fract().abs() < f64::EPSILON {
        format!("{}", value as i64)
    } else {
        format!("{value:.1}")
    }
}

/// Estimated width of `text` at `size_pt` in millimeters (Helvetica averages
/// about 0.5em per glyph) — used to center cell text without font measuring.
fn text_width_mm(text: &str, size_pt: f32) -> f32 {
    text.chars().count() as f32 * size_pt * 0.5 * 25.4 / 72.0
}

fn mm_to_pt(mm: f32) -> Pt {
    Pt(mm * 72.0 / 25.4)
}

/// Places a single line of text at a page position (bottom-left origin).
fn sheet_text(ops: &mut Vec<Op>, text: String, x: f32, y: f32, size: f32, bold: bool) {
    ops.extend([
        Op::StartTextSection,
        Op::SetTextCursor {
            pos: Point::new(Mm(x), Mm(y)),
        },
        Op::SetFont {
            font: PdfFontHandle::Builtin(if bold {
                BuiltinFont::HelveticaBold
            } else {
                BuiltinFont::Helvetica
            }),
            size: Pt(size),
        },
        Op::ShowText {
            items: vec![TextItem::Text(text)],
        },
        Op::EndTextSection,
    ]);
}

/// Draws one table cell: optional yellow highlight, black border, and text
/// aligned left (first two reference columns) or centered.
#[allow(clippy::too_many_arguments)]
fn sheet_cell(
    ops: &mut Vec<Op>,
    x_mm: f32,
    y_mm: f32,
    w_mm: f32,
    h_mm: f32,
    text: &str,
    size_pt: f32,
    bold: bool,
    align_left: bool,
    highlight: bool,
) {
    let rect = Rect {
        x: mm_to_pt(x_mm),
        y: mm_to_pt(y_mm),
        width: mm_to_pt(w_mm),
        height: mm_to_pt(h_mm),
        mode: None,
        winding_order: None,
    };
    if highlight {
        // Yellow-highlighted Net Compensation grand total like the reference.
        ops.push(Op::SaveGraphicsState);
        ops.push(Op::SetFillColor {
            col: printpdf::Color::Rgb(printpdf::Rgb::new(0.953, 0.875, 0.247, None)),
        });
        ops.push(Op::DrawRectangle {
            rectangle: Rect {
                mode: Some(PaintMode::Fill),
                ..rect.clone()
            },
        });
        ops.push(Op::RestoreGraphicsState);
    }
    ops.push(Op::SaveGraphicsState);
    ops.push(Op::SetOutlineColor {
        col: printpdf::Color::Rgb(printpdf::Rgb::new(0.0, 0.0, 0.0, None)),
    });
    ops.push(Op::SetOutlineThickness { pt: Pt(0.4) });
    ops.push(Op::DrawRectangle {
        rectangle: Rect {
            mode: Some(PaintMode::Stroke),
            ..rect.clone()
        },
    });
    ops.push(Op::RestoreGraphicsState);

    if !text.is_empty() {
        let lines: Vec<&str> = text.split('\n').collect();
        let line_h_mm = size_pt * 25.4 / 72.0 * 1.15;
        let total_h = lines.len() as f32 * line_h_mm;
        let start_y = y_mm + (h_mm - total_h) / 2.0 + (lines.len() as f32 - 1.0) * line_h_mm + 0.2;

        for (i, line) in lines.iter().enumerate() {
            let text_w = text_width_mm(line, size_pt);
            let tx = if align_left {
                x_mm + 2.0
            } else {
                (x_mm + (w_mm - text_w) / 2.0).max(x_mm + 1.0)
            };
            let ty = start_y - (i as f32 * line_h_mm);
            ops.push(Op::StartTextSection);
            ops.push(Op::SetTextCursor {
                pos: Point::new(Mm(tx), Mm(ty)),
            });
            ops.push(Op::SetFont {
                font: PdfFontHandle::Builtin(if bold {
                    BuiltinFont::HelveticaBold
                } else {
                    BuiltinFont::Helvetica
                }),
                size: Pt(size_pt),
            });
            ops.push(Op::ShowText {
                items: vec![TextItem::Text(line.to_string())],
            });
            ops.push(Op::EndTextSection);
        }
    }
}

/// Column widths of the reference payroll sheet in millimeters (usable width
/// is 297 - 2 * 12 = 273 mm).
const SHEET_COL_WIDTHS_MM: [f32; 13] = [
    24.0, 37.0, 22.0, 20.0, 18.0, 18.0, 23.0, 16.0, 15.0, 20.0, 16.0, 22.0, 22.0,
];
const SHEET_LEFT_MM: f32 = 12.0;
const SHEET_ROW_H_MM: f32 = 7.0;
const SHEET_ROWS_PER_PAGE: usize = 18;

/// Consolidated payroll sheet PDF, A4 landscape, black on white with the same
/// reference column set as the printable worksheet. One sheet per `worker_type`
/// (EMPLOYEE vs INTERN). The document body contains only company identity,
/// cutoff, and payroll values — no timestamps, URLs, or browser artifacts.
pub fn generate_payroll_sheet_pdf(
    rows: &[PayrollSheetRow],
    cutoff_label: &str,
    worker_type: &str,
    office: &crate::config::OfficeConfig,
    path: &std::path::Path,
) -> Result<(), String> {
    let mut document = PdfDocument::new(&format!("Alpha Premier Payroll Sheet {worker_type}"));
    let mark = brand_mark_image(&mut document, 15.0);
    let chunks: Vec<&[PayrollSheetRow]> = if rows.is_empty() {
        vec![&[]]
    } else {
        rows.chunks(SHEET_ROWS_PER_PAGE).collect()
    };
    let mut pages = Vec::new();
    for (chunk_index, chunk) in chunks.iter().enumerate() {
        let mut ops = Vec::new();
        let text_left = if let Some((id, dpi)) = &mark {
            ops.push(brand_mark_op(id.clone(), *dpi, 12.0, 183.0));
            31.0
        } else {
            12.0
        };

        // --- header block: company identity + cutoff on the left, cutoff
        // note legend on the right (mirrors the reference sheet). ---
        sheet_text(
            &mut ops,
            office.company_name.to_uppercase(),
            text_left,
            197.0,
            14.0,
            true,
        );
        let mut header_y = 191.0;
        if let Some(tin) = office.tax_identification_number.as_deref() {
            if !tin.trim().is_empty() {
                sheet_text(
                    &mut ops,
                    format!("TIN# {tin}"),
                    text_left,
                    header_y,
                    8.5,
                    false,
                );
                header_y -= 6.0;
            }
        }
        sheet_text(
            &mut ops,
            cutoff_label.to_uppercase(),
            text_left,
            header_y,
            11.0,
            true,
        );
        sheet_text(&mut ops, "Note: Cut off".into(), 240.0, 197.0, 9.0, true);
        sheet_text(
            &mut ops,
            "1-15th of the month".into(),
            240.0,
            191.0,
            8.0,
            false,
        );
        sheet_text(&mut ops, "16-31st".into(), 240.0, 185.0, 8.0, false);
        // Separator under the header block.
        ops.push(Op::SaveGraphicsState);
        ops.push(Op::SetOutlineColor {
            col: printpdf::Color::Rgb(printpdf::Rgb::new(0.0, 0.0, 0.0, None)),
        });
        ops.push(Op::SetOutlineThickness { pt: Pt(0.6) });
        ops.push(Op::DrawLine {
            line: printpdf::Line {
                points: vec![
                    printpdf::LinePoint {
                        p: Point::new(Mm(12.0), Mm(176.0)),
                        bezier: false,
                    },
                    printpdf::LinePoint {
                        p: Point::new(Mm(285.0), Mm(176.0)),
                        bezier: false,
                    },
                ],
                is_closed: false,
            },
        });
        ops.push(Op::RestoreGraphicsState);

        // --- table header row ---
        const HEADERS: [&str; 13] = [
            "Employee #",
            "Employee Name",
            "Cut Off\nRate",
            "Daily\nRate",
            "Actual\nDays",
            "Standard\nDays",
            "Total\nCompensation",
            "Late 10\n/hr",
            "Halfday",
            PAYROLL_SHEET_UNDERTIME_HEADER,
            "Absent",
            "Net\nCompensation",
            "Signature",
        ];
        let table_top_y = 170.0;
        let header_h = 9.0;
        let mut x = SHEET_LEFT_MM;
        for (index, header) in HEADERS.iter().enumerate() {
            let w = SHEET_COL_WIDTHS_MM[index];
            sheet_cell(
                &mut ops,
                x,
                table_top_y - header_h,
                w,
                header_h,
                header,
                5.5,
                true,
                false,
                false,
            );
            x += w;
        }

        // --- data rows ---
        let mut row_y = table_top_y - header_h - SHEET_ROW_H_MM;
        for row in chunk.iter() {
            let cells: [String; 13] = [
                row.employee_id.clone(),
                row.employee_name.clone(),
                format_php(row.cutoff_rate_centavos),
                format_php(row.daily_rate_centavos),
                format_days(row.actual_working_days),
                format_days(row.standard_working_days),
                format_php(row.total_compensation_centavos),
                format_php(row.late_deduction_centavos),
                format_php(row.half_day_deduction_centavos),
                format_php(row.undertime_deduction_centavos),
                format_php(row.absence_deduction_centavos),
                format_php(row.gross_compensation_centavos),
                String::new(), // Signature blank for physical signing
            ];
            x = SHEET_LEFT_MM;
            for (index, cell) in cells.iter().enumerate() {
                let w = SHEET_COL_WIDTHS_MM[index];
                sheet_cell(
                    &mut ops,
                    x,
                    row_y,
                    w,
                    SHEET_ROW_H_MM,
                    cell,
                    7.0,
                    false,
                    index < 2,
                    false,
                );
                x += w;
            }
            row_y -= SHEET_ROW_H_MM;
        }

        // --- grand total row (last page only), yellow-highlighted gross ---
        if chunk_index == chunks.len() - 1 {
            let total_gross: i64 = rows.iter().map(|row| row.gross_compensation_centavos).sum();
            let total_w: f32 = SHEET_COL_WIDTHS_MM[..11].iter().sum();
            sheet_cell(
                &mut ops,
                SHEET_LEFT_MM,
                row_y,
                total_w,
                SHEET_ROW_H_MM,
                "Grand Total",
                7.0,
                true,
                true,
                false,
            );
            let last_x = SHEET_LEFT_MM + total_w;
            sheet_cell(
                &mut ops,
                last_x,
                row_y,
                SHEET_COL_WIDTHS_MM[11],
                SHEET_ROW_H_MM,
                &format_php(total_gross),
                7.0,
                true,
                false,
                true,
            );
            let sig_x = last_x + SHEET_COL_WIDTHS_MM[11];
            sheet_cell(
                &mut ops,
                sig_x,
                row_y,
                SHEET_COL_WIDTHS_MM[12],
                SHEET_ROW_H_MM,
                "",
                7.0,
                false,
                false,
                false,
            );
        }

        // --- footer ---
        sheet_text(
            &mut ops,
            "CONFIDENTIAL - For authorized payroll use only".into(),
            12.0,
            10.0,
            7.0,
            false,
        );
        pages.push(PdfPage::new(Mm(297.0), Mm(210.0), ops));
    }
    let bytes = document
        .with_pages(pages)
        .save(&PdfSaveOptions::default(), &mut Vec::new());
    std::fs::write(path, bytes).map_err(|e| e.to_string())
}
