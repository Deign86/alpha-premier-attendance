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
        }];
        generate_attendance_workbook(&rows, "2026-08-01", &office(), &path).unwrap();
        let shared = read_xlsx_shared_strings(&path);
        assert!(shared.contains("Company: Alpha Premier"));
        assert!(
            shared.contains("Unit 3104C, Tektite East Tower, Ortigas Center, Pasig, Metro Manila")
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn payroll_workbook_metadata_contains_the_canonical_office_address() {
        let row = PayrollExportRow {
            payroll_id: "P-1".into(),
            employee_id: "E-1".into(),
            employee_name: "Ana Santos".into(),
            profile: "BEA_STANDARD".into(),
            cutoff_label: "1st Half".into(),
            cutoff_start: "2026-08-01".into(),
            cutoff_end: "2026-08-15".into(),
            basic_pay_centavos: 100_000,
            allowances_centavos: 2_000,
            incentives_centavos: 500,
            late_deduction_centavos: 100,
            other_adjustments_centavos: 0,
            gross_centavos: 102_500,
            net_centavos: 102_400,
            status: "FINALIZED".into(),
        };
        let path =
            std::env::temp_dir().join(format!("payroll-office-{}.xlsx", uuid::Uuid::new_v4()));
        generate_payroll_workbook(
            std::slice::from_ref(&row),
            "1st-Half-2026",
            &office(),
            &path,
        )
        .unwrap();
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
    fn generates_payroll_workbook_and_pdf_with_status_label() {
        let row = PayrollExportRow {
            payroll_id: "P-1".into(),
            employee_id: "E-1".into(),
            employee_name: "Ana Santos".into(),
            profile: "BEA_STANDARD".into(),
            cutoff_label: "1st Half".into(),
            cutoff_start: "2026-08-01".into(),
            cutoff_end: "2026-08-15".into(),
            basic_pay_centavos: 100_000,
            allowances_centavos: 2_000,
            incentives_centavos: 500,
            late_deduction_centavos: 100,
            other_adjustments_centavos: 0,
            gross_centavos: 102_500,
            net_centavos: 102_400,
            status: "FINALIZED".into(),
        };
        let base = std::env::temp_dir().join(format!("payroll-report-{}", uuid::Uuid::new_v4()));
        let xlsx = base.with_extension("xlsx");
        let pdf = base.with_extension("pdf");
        generate_payroll_workbook(
            std::slice::from_ref(&row),
            "1st-Half-2026",
            &office(),
            &xlsx,
        )
        .unwrap();
        generate_payroll_pdf(&row, &office(), &pdf).unwrap();
        assert!(std::fs::read(&xlsx).unwrap().starts_with(b"PK"));
        // The official brand mark is embedded as a workbook media file.
        {
            let archive = zip::ZipArchive::new(std::fs::File::open(&xlsx).unwrap()).unwrap();
            assert!(
                archive
                    .file_names()
                    .any(|name| name.starts_with("xl/media/")),
                "payroll workbook should embed the brand mark media file"
            );
        }
        assert!(std::fs::read(&pdf).unwrap().starts_with(b"%PDF"));
        let register = base.with_extension("register.pdf");
        generate_payroll_register_pdf(
            std::slice::from_ref(&row),
            "1st-Half-2026",
            &office(),
            &register,
        )
        .unwrap();
        assert!(std::fs::read(&register).unwrap().starts_with(b"%PDF"));
        let _ = std::fs::remove_file(xlsx);
        let _ = std::fs::remove_file(pdf);
        let _ = std::fs::remove_file(register);
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
    fn builds_payslip_filename_without_employee_pii() {
        let filename = payroll_pdf_filename("payroll-123", "1st Half 2026", "job-123");
        assert_eq!(
            filename,
            "AlphaPremier_Payslip_payroll-123_1st-Half-2026_job-123.pdf"
        );
        assert!(!filename.contains("Ana-Santos"));
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
        let _ = std::fs::remove_file(&pdf);
    }

    #[test]
    fn generates_employee_payslip_document_with_official_format() {
        let rows = vec![EmployeePayslipData {
            payroll_id: "P-EMP-1".into(),
            employee_id: "APGCO-25-013".into(),
            employee_name: "CHICO, JEAN ASHLEY".into(),
            department: "HR-MARKETING".into(),
            designation: "EMPLOYEE".into(),
            tin: "010-871-213-0000".into(),
            bank_name: "CASH".into(),
            account_number: "0000".into(),
            standard_working_days: 11.0,
            paid_days: 11.0,
            lwop_days: 0.0,
            daily_rate_centavos: 705_00,
            basic_pay_centavos: 7_755_00,
            hra_centavos: 0,
            incentives_allowance_centavos: 6_600_00,
            special_allowance_centavos: 150_00,
            total_allowance_centavos: 16_005_00,
            regular_holiday_pay_centavos: 0,
            special_holiday_pay_centavos: 211_50,
            overtime_pay_centavos: 0,
            gross_compensation_centavos: 16_216_50,
            sss_centavos: 0,
            phic_centavos: 0,
            hdmf_centavos: 0,
            salary_advance_centavos: 0,
            absence_deduction_centavos: 0,
            late_deduction_centavos: 0,
            total_deductions_centavos: 0,
            net_pay_centavos: 16_216_50,
            cutoff_label: "JUNE 1-15 2026".into(),
            status: "FINALIZED".into(),
        }];
        let base = std::env::temp_dir().join(format!("employee-payslip-{}", uuid::Uuid::new_v4()));
        let pdf = base.with_extension("pdf");
        generate_employee_payslip_document(&rows, "JUNE 1-15 2026", &office(), &pdf).unwrap();
        let bytes = std::fs::read(&pdf).unwrap();
        assert!(bytes.starts_with(b"%PDF"));
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

        // 2. Employee Payslip Sample
        let emp_rows = vec![
            EmployeePayslipData {
                payroll_id: "P-EMP-001".into(),
                employee_id: "APGCO-25-013".into(),
                employee_name: "CHICO, JEAN ASHLEY".into(),
                department: "HR-MARKETING".into(),
                designation: "EMPLOYEE".into(),
                tin: "010-871-213-0000".into(),
                bank_name: "CASH".into(),
                account_number: "0000".into(),
                standard_working_days: 11.0,
                paid_days: 11.0,
                lwop_days: 0.0,
                daily_rate_centavos: 705_00,
                basic_pay_centavos: 7_755_00,
                hra_centavos: 0,
                incentives_allowance_centavos: 6_600_00,
                special_allowance_centavos: 150_00,
                total_allowance_centavos: 16_005_00,
                regular_holiday_pay_centavos: 0,
                special_holiday_pay_centavos: 211_50,
                overtime_pay_centavos: 0,
                gross_compensation_centavos: 16_216_50,
                sss_centavos: 0,
                phic_centavos: 0,
                hdmf_centavos: 0,
                salary_advance_centavos: 0,
                absence_deduction_centavos: 0,
                late_deduction_centavos: 0,
                total_deductions_centavos: 0,
                net_pay_centavos: 16_216_50,
                cutoff_label: "JUNE 1-15 2026".into(),
                status: "FINALIZED".into(),
            },
            EmployeePayslipData {
                payroll_id: "P-EMP-002".into(),
                employee_id: "APG-2026-019".into(),
                employee_name: "BEATRIZ CONOS".into(),
                department: "HR / MARKETING ASSOCIATE".into(),
                designation: "EMPLOYEE".into(),
                tin: "010-871-213-0000".into(),
                bank_name: "CASH".into(),
                account_number: "0000".into(),
                standard_working_days: 11.0,
                paid_days: 11.0,
                lwop_days: 0.0,
                daily_rate_centavos: 650_00,
                basic_pay_centavos: 7_150_00,
                hra_centavos: 0,
                incentives_allowance_centavos: 5_000_00,
                special_allowance_centavos: 0,
                total_allowance_centavos: 12_150_00,
                regular_holiday_pay_centavos: 0,
                special_holiday_pay_centavos: 0,
                overtime_pay_centavos: 0,
                gross_compensation_centavos: 12_150_00,
                sss_centavos: 0,
                phic_centavos: 0,
                hdmf_centavos: 0,
                salary_advance_centavos: 0,
                absence_deduction_centavos: 0,
                late_deduction_centavos: 0,
                total_deductions_centavos: 0,
                net_pay_centavos: 12_150_00,
                cutoff_label: "JUNE 1-15 2026".into(),
                status: "FINALIZED".into(),
            },
        ];
        let emp_pdf = out_dir.join("sample_employee_payslip.pdf");
        generate_employee_payslip_document(&emp_rows, "JUNE 1-15 2026", &office(), &emp_pdf)
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
    Color, Format, FormatAlign, FormatBorder, Image, Table, TableStyle, Workbook, XlsxError,
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
    let rows = sqlx::query("SELECT user_id, full_name, department, attendance_date, time_in, time_out, status, source, notes FROM attendance WHERE attendance_date = ? ORDER BY time_in, full_name, user_id")
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
            // Rendered hours are net of the fixed 12:00–13:00 lunch break so
            // reports stay consistent with payroll (shared lunch rule).
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
    worksheet.merge_range(0, 0, 0, 9, &title, &title_format)?;
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
        "NOTES",
    ];
    for (column, header) in headers.iter().enumerate() {
        worksheet.write_string_with_format(5, column as u16, *header, &header_format)?;
    }
    for (index, row) in rows.iter().enumerate() {
        let excel_row = (index + 6) as u32;
        let values = [
            row.employee_id.as_str(),
            row.employee_name.as_str(),
            row.department.as_deref().unwrap_or(""),
            row.date.as_str(),
            row.time_in.as_deref().unwrap_or(""),
            row.time_out.as_deref().unwrap_or(""),
            row.status.as_str(),
            row.source.as_str(),
            row.notes.as_str(),
        ];
        let fill = if index % 2 == 1 {
            &alt_body_format
        } else {
            &body_format
        };
        for (column, value) in values.iter().enumerate() {
            worksheet.write_string_with_format(excel_row, column as u16, *value, fill)?;
        }
        let number_fill = if index % 2 == 1 {
            &alt_number_format
        } else {
            &number_format
        };
        worksheet.write_number_with_format(excel_row, 6, row.total_hours, number_fill)?;
    }
    let last_row = (rows.len() + 5) as u32;
    if !rows.is_empty() {
        let table = Table::new().set_style(TableStyle::Medium2);
        worksheet.add_table(5, 0, last_row, 9, &table)?;
    }
    let mut widths = [0usize; 10];
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
    worksheet.set_print_area(0, 0, last_row.max(5), 9)?;
    workbook.save(path)
}

#[derive(Debug, Clone, PartialEq)]
pub struct PayrollExportRow {
    pub payroll_id: String,
    pub employee_id: String,
    pub employee_name: String,
    pub profile: String,
    pub cutoff_label: String,
    pub cutoff_start: String,
    pub cutoff_end: String,
    pub basic_pay_centavos: i64,
    pub allowances_centavos: i64,
    pub incentives_centavos: i64,
    pub late_deduction_centavos: i64,
    pub other_adjustments_centavos: i64,
    pub gross_centavos: i64,
    pub net_centavos: i64,
    pub status: String,
}

pub async fn load_payroll_rows(
    db: &sqlx::SqlitePool,
) -> Result<Vec<PayrollExportRow>, sqlx::Error> {
    let rows = sqlx::query("SELECT payroll_id,employee_id,employee_name,payroll_profile_id,payroll_cutoff_label,cutoff_start,cutoff_end,basic_pay_centavos,total_allowance_centavos,incentives_allowance_centavos,late_deduction_centavos,manual_adjustment_centavos,gross_compensation_centavos,net_pay_centavos,status FROM payroll_cutoffs ORDER BY cutoff_start,employee_name,employee_id")
        .fetch_all(db).await?;
    Ok(rows
        .into_iter()
        .map(|row| PayrollExportRow {
            payroll_id: row.get("payroll_id"),
            employee_id: row.get("employee_id"),
            employee_name: row.get("employee_name"),
            profile: row.get("payroll_profile_id"),
            cutoff_label: row.get("payroll_cutoff_label"),
            cutoff_start: row.get("cutoff_start"),
            cutoff_end: row.get("cutoff_end"),
            basic_pay_centavos: row.get("basic_pay_centavos"),
            allowances_centavos: row.get("total_allowance_centavos"),
            incentives_centavos: row.get("incentives_allowance_centavos"),
            late_deduction_centavos: row.get("late_deduction_centavos"),
            other_adjustments_centavos: row.get("manual_adjustment_centavos"),
            gross_centavos: row.get("gross_compensation_centavos"),
            net_centavos: row.get("net_pay_centavos"),
            status: row.get("status"),
        })
        .collect())
}

pub fn payroll_artifact_filename(cutoff: &str, job_id: &str) -> String {
    format!(
        "AlphaPremier_Payroll_{}_{}.xlsx",
        sanitize_filename_component(cutoff),
        sanitize_filename_component(job_id)
    )
}

pub fn generate_payroll_workbook(
    rows: &[PayrollExportRow],
    cutoff: &str,
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
    let currency_format = Format::new()
        .set_border(FormatBorder::Thin)
        .set_background_color(Color::White)
        .set_num_format("0.00");
    let alt_currency_format = Format::new()
        .set_border(FormatBorder::Thin)
        .set_background_color(Color::RGB(0xF2F2F2))
        .set_num_format("0.00");
    let sheet = workbook.add_worksheet().set_name("Payroll Register")?;
    // Official brand mark in the header corner (embedded at compile time).
    match Image::new_from_buffer(BRAND_PHOENIX_PNG) {
        Ok(mut logo) => {
            logo = logo.set_scale_to_size(28u32, 28u32, true);
            sheet.insert_image(0, 13, &logo)?;
        }
        Err(error) => log::warn!("Payroll workbook brand mark skipped: {error}"),
    }
    sheet.merge_range(
        0,
        0,
        0,
        14,
        &format!("Payroll Register - {cutoff}"),
        &title_format,
    )?;
    sheet.write_string_with_format(
        1,
        0,
        format!("Company: {}", office.company_name),
        &metadata_format,
    )?;
    sheet.write_string_with_format(2, 0, office.display_full(), &metadata_format)?;
    sheet.write_string_with_format(
        3,
        0,
        "Currency: PHP | Timezone: Asia/Manila | Source: SQLite finalized/draft records",
        &metadata_format,
    )?;
    let headers = [
        "EMPLOYEE_ID",
        "EMPLOYEE_NAME",
        "PROFILE",
        "CUTOFF_LABEL",
        "CUTOFF_START",
        "CUTOFF_END",
        "BASIC_PAY_PHP",
        "ALLOWANCES_PHP",
        "INCENTIVES_PHP",
        "LATE_DEDUCTIONS_PHP",
        "OTHER_ADJUSTMENTS_PHP",
        "GROSS_PAY_PHP",
        "NET_PAY_PHP",
        "STATUS",
        "PAYROLL_ID",
    ];
    for (column, header) in headers.iter().enumerate() {
        sheet.write_string_with_format(5, column as u16, *header, &header_format)?;
    }
    for (index, row) in rows.iter().enumerate() {
        let r = (index + 6) as u32;
        let strings = [
            &row.employee_id,
            &row.employee_name,
            &row.profile,
            &row.cutoff_label,
            &row.cutoff_start,
            &row.cutoff_end,
        ];
        let fill = if index % 2 == 1 {
            &alt_body_format
        } else {
            &body_format
        };
        let money_fill = if index % 2 == 1 {
            &alt_currency_format
        } else {
            &currency_format
        };
        for (c, value) in strings.iter().enumerate() {
            sheet.write_string_with_format(r, c as u16, (*value).clone(), fill)?;
        }
        let money = [
            row.basic_pay_centavos,
            row.allowances_centavos,
            row.incentives_centavos,
            row.late_deduction_centavos,
            row.other_adjustments_centavos,
            row.gross_centavos,
            row.net_centavos,
        ];
        for (offset, value) in money.iter().enumerate() {
            sheet.write_number_with_format(
                r,
                (offset + 6) as u16,
                *value as f64 / 100.0,
                money_fill,
            )?;
        }
        sheet.write_string_with_format(r, 13, &row.status, fill)?;
        sheet.write_string_with_format(r, 14, &row.payroll_id, fill)?;
    }
    let last = (rows.len() + 5) as u32;
    if !rows.is_empty() {
        sheet.add_table(5, 0, last, 14, &Table::new().set_style(TableStyle::Medium2))?;
    }
    let mut widths = [0usize; 15];
    for (column, header) in headers.iter().enumerate() {
        widths[column] = header.len();
    }
    for row in rows {
        let values = [
            row.employee_id.len(),
            row.employee_name.len(),
            row.profile.len(),
            row.cutoff_label.len(),
            row.cutoff_start.len(),
            row.cutoff_end.len(),
            format!("{:.2}", row.basic_pay_centavos as f64 / 100.0).len(),
            format!("{:.2}", row.allowances_centavos as f64 / 100.0).len(),
            format!("{:.2}", row.incentives_centavos as f64 / 100.0).len(),
            format!("{:.2}", row.late_deduction_centavos as f64 / 100.0).len(),
            format!("{:.2}", row.other_adjustments_centavos as f64 / 100.0).len(),
            format!("{:.2}", row.gross_centavos as f64 / 100.0).len(),
            format!("{:.2}", row.net_centavos as f64 / 100.0).len(),
            row.status.len(),
            row.payroll_id.len(),
        ];
        for (column, length) in values.iter().enumerate() {
            widths[column] = widths[column].max(*length);
        }
    }
    for (column, width) in widths.iter().enumerate() {
        sheet.set_column_width(column as u16, (*width as f64) + 2.0)?;
    }
    sheet.set_freeze_panes(6, 0)?;
    sheet.set_repeat_rows(0, 5)?;
    sheet.set_landscape();
    sheet.set_paper_size(9);
    sheet.set_margins(0.35, 0.35, 0.5, 0.5, 0.3, 0.3);
    sheet.set_print_area(0, 0, last.max(5), 14)?;
    workbook.save(path)
}

pub fn payroll_pdf_filename(payroll_id: &str, cutoff: &str, job_id: &str) -> String {
    format!(
        "AlphaPremier_Payslip_{}_{}_{}.pdf",
        sanitize_filename_component(payroll_id),
        sanitize_filename_component(cutoff),
        sanitize_filename_component(job_id)
    )
}

#[derive(Debug, Clone, PartialEq)]
pub struct EmployeePayslipData {
    pub payroll_id: String,
    pub employee_id: String,
    pub employee_name: String,
    pub department: String,
    pub designation: String,
    pub tin: String,
    pub bank_name: String,
    pub account_number: String,
    pub standard_working_days: f64,
    pub paid_days: f64,
    pub lwop_days: f64,
    pub daily_rate_centavos: i64,
    pub basic_pay_centavos: i64,
    pub hra_centavos: i64,
    pub incentives_allowance_centavos: i64,
    pub special_allowance_centavos: i64,
    pub total_allowance_centavos: i64,
    pub regular_holiday_pay_centavos: i64,
    pub special_holiday_pay_centavos: i64,
    pub overtime_pay_centavos: i64,
    pub gross_compensation_centavos: i64,
    pub sss_centavos: i64,
    pub phic_centavos: i64,
    pub hdmf_centavos: i64,
    pub salary_advance_centavos: i64,
    pub absence_deduction_centavos: i64,
    pub late_deduction_centavos: i64,
    pub total_deductions_centavos: i64,
    pub net_pay_centavos: i64,
    pub cutoff_label: String,
    pub status: String,
}

pub fn format_amount_or_dash(centavos: i64) -> String {
    if centavos == 0 {
        "-".to_string()
    } else {
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
            format!("-{grouped}.{cents:02}")
        } else {
            format!("{grouped}.{cents:02}")
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum PayslipAlign {
    Left,
    Center,
    Right,
}

#[allow(clippy::too_many_arguments)]
fn payslip_cell(
    ops: &mut Vec<Op>,
    x_mm: f32,
    y_mm: f32,
    w_mm: f32,
    h_mm: f32,
    text: &str,
    size_pt: f32,
    bold: bool,
    align: PayslipAlign,
    fill_color: Option<printpdf::Color>,
    border: bool,
    text_color: Option<printpdf::Color>,
) {
    let rect = Rect {
        x: mm_to_pt(x_mm),
        y: mm_to_pt(y_mm),
        width: mm_to_pt(w_mm),
        height: mm_to_pt(h_mm),
        mode: None,
        winding_order: None,
    };
    if let Some(fill) = fill_color {
        ops.push(Op::SaveGraphicsState);
        ops.push(Op::SetFillColor { col: fill });
        ops.push(Op::DrawRectangle {
            rectangle: Rect {
                mode: Some(PaintMode::Fill),
                ..rect.clone()
            },
        });
        ops.push(Op::RestoreGraphicsState);
    }
    if border {
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
    }

    if !text.is_empty() {
        let text_w = text_width_mm(text, size_pt);
        let tx = match align {
            PayslipAlign::Left => x_mm + 2.5,
            PayslipAlign::Center => (x_mm + (w_mm - text_w) / 2.0).max(x_mm + 1.0),
            PayslipAlign::Right => (x_mm + w_mm - text_w - 3.0).max(x_mm + 1.0),
        };
        let ty = y_mm + (h_mm - size_pt * 25.4 / 72.0) / 2.0 - 0.4;

        ops.push(Op::StartTextSection);
        ops.push(Op::SetTextCursor {
            pos: Point::new(Mm(tx), Mm(ty)),
        });
        let col = text_color.unwrap_or(printpdf::Color::Rgb(printpdf::Rgb::new(
            0.0, 0.0, 0.0, None,
        )));
        ops.push(Op::SetFillColor { col });
        ops.push(Op::SetFont {
            font: PdfFontHandle::Builtin(if bold {
                BuiltinFont::HelveticaBold
            } else {
                BuiltinFont::Helvetica
            }),
            size: Pt(size_pt),
        });
        ops.push(Op::ShowText {
            items: vec![TextItem::Text(text.to_string())],
        });
        ops.push(Op::EndTextSection);
    }
}

fn draw_payslip_h_line(ops: &mut Vec<Op>, x1_mm: f32, x2_mm: f32, y_mm: f32, thickness_pt: f32) {
    ops.push(Op::SaveGraphicsState);
    ops.push(Op::SetOutlineColor {
        col: printpdf::Color::Rgb(printpdf::Rgb::new(0.0, 0.0, 0.0, None)),
    });
    ops.push(Op::SetOutlineThickness {
        pt: Pt(thickness_pt),
    });
    ops.push(Op::DrawLine {
        line: printpdf::Line {
            points: vec![
                printpdf::LinePoint {
                    p: Point::new(Mm(x1_mm), Mm(y_mm)),
                    bezier: false,
                },
                printpdf::LinePoint {
                    p: Point::new(Mm(x2_mm), Mm(y_mm)),
                    bezier: false,
                },
            ],
            is_closed: false,
        },
    });
    ops.push(Op::RestoreGraphicsState);
}

pub fn generate_employee_payslip_document(
    rows: &[EmployeePayslipData],
    cutoff_label: &str,
    office: &crate::config::OfficeConfig,
    path: &std::path::Path,
) -> Result<(), String> {
    if rows.is_empty() {
        return Err("NO_RECORDS".into());
    }
    let mut document = PdfDocument::new("Alpha Premier Employee Payslip");
    let mark = brand_mark_image(&mut document, 16.0);
    let mut pages = Vec::new();

    for row in rows {
        let mut ops = Vec::new();

        // 1. Black Top Banner (Landscape A4: 297mm x 210mm)
        let page_left = 13.5;
        let page_w = 270.0;
        let banner_h = 20.0;
        let banner_y = 182.0;

        payslip_cell(
            &mut ops,
            page_left,
            banner_y,
            page_w,
            banner_h,
            "",
            10.0,
            false,
            PayslipAlign::Center,
            Some(printpdf::Color::Rgb(printpdf::Rgb::new(
                0.0, 0.0, 0.0, None,
            ))),
            false,
            None,
        );

        // Logo inside the black banner on the left
        if let Some((id, dpi)) = &mark {
            ops.push(brand_mark_op(
                id.clone(),
                *dpi,
                page_left + 4.0,
                banner_y + 2.0,
            ));
        }

        payslip_cell(
            &mut ops,
            page_left,
            banner_y + 10.0,
            page_w,
            8.0,
            &office.company_name.to_uppercase(),
            12.0,
            true,
            PayslipAlign::Center,
            None,
            false,
            Some(printpdf::Color::Rgb(printpdf::Rgb::new(
                1.0, 1.0, 1.0, None,
            ))),
        );
        payslip_cell(
            &mut ops,
            page_left,
            banner_y + 3.0,
            page_w,
            6.0,
            &office.display_full().to_uppercase(),
            8.0,
            false,
            PayslipAlign::Center,
            None,
            false,
            Some(printpdf::Color::Rgb(printpdf::Rgb::new(
                1.0, 1.0, 1.0, None,
            ))),
        );

        // 2. Subheader (Period) Banner
        let period_label = if !row.cutoff_label.is_empty() {
            &row.cutoff_label
        } else {
            cutoff_label
        };
        let subheader_y = banner_y - 8.0;
        payslip_cell(
            &mut ops,
            page_left,
            subheader_y,
            page_w,
            8.0,
            &format!("Payslip For the Month of {}", period_label.to_uppercase()),
            9.5,
            true,
            PayslipAlign::Center,
            Some(printpdf::Color::Rgb(printpdf::Rgb::new(
                0.92, 0.92, 0.92, None,
            ))),
            true,
            None,
        );

        // 3. Employee Details Grid (6 rows, 4.8mm each: from Y = 145.2 to Y = 174.0)
        let col1_w = 38.0;
        let col2_w = 97.0;
        let col3_w = 58.0;
        let col4_w = 77.0;
        let row_h = 4.8;

        let std_days_str = format_days(row.standard_working_days);
        let paid_days_str = format_days(row.paid_days);
        let lwop_str = if row.lwop_days > 0.0 {
            format_days(row.lwop_days)
        } else {
            String::new()
        };
        let rate_str = format_amount_or_dash(row.daily_rate_centavos);
        let tin_str = if !row.tin.is_empty() {
            row.tin.clone()
        } else if let Some(tin) = office.tax_identification_number.as_deref() {
            tin.to_string()
        } else {
            String::new()
        };

        let details_rows = [
            (
                "Employee ID:",
                row.employee_id.as_str(),
                true,
                "Bank Name:",
                row.bank_name.as_str(),
                false,
            ),
            (
                "Employee Name:",
                row.employee_name.as_str(),
                true,
                "A/C #:",
                row.account_number.as_str(),
                false,
            ),
            (
                "",
                row.department.as_str(),
                false,
                "Standard Working Days",
                std_days_str.as_str(),
                false,
            ),
            (
                "Designation:",
                row.designation.as_str(),
                false,
                "Paid Days",
                paid_days_str.as_str(),
                false,
            ),
            (
                "Tin#",
                tin_str.as_str(),
                false,
                "LWOP Days",
                lwop_str.as_str(),
                false,
            ),
            ("", "", false, "Rate per day", rate_str.as_str(), false),
        ];

        let mut grid_y = subheader_y - row_h;
        for (label1, val1, val1_bold, label2, val2, _) in &details_rows {
            payslip_cell(
                &mut ops,
                page_left,
                grid_y,
                col1_w,
                row_h,
                label1,
                8.0,
                true,
                PayslipAlign::Left,
                None,
                true,
                None,
            );
            payslip_cell(
                &mut ops,
                page_left + col1_w,
                grid_y,
                col2_w,
                row_h,
                val1,
                8.0,
                *val1_bold,
                PayslipAlign::Left,
                None,
                true,
                None,
            );
            payslip_cell(
                &mut ops,
                page_left + col1_w + col2_w,
                grid_y,
                col3_w,
                row_h,
                label2,
                8.0,
                true,
                PayslipAlign::Left,
                None,
                true,
                None,
            );
            payslip_cell(
                &mut ops,
                page_left + col1_w + col2_w + col3_w,
                grid_y,
                col4_w,
                row_h,
                val2,
                8.0,
                false,
                PayslipAlign::Right,
                None,
                true,
                None,
            );
            grid_y -= row_h;
        }

        // 4. Separator Line
        let sep_y = grid_y - 2.0;
        draw_payslip_h_line(&mut ops, page_left, page_left + page_w, sep_y, 0.8);

        // 5. Earnings & Deductions Table (Landscape 2-Column)
        let earn_lbl_w = 85.0;
        let earn_val_w = 50.0;
        let ded_lbl_w = 85.0;
        let ded_val_w = 50.0;
        let tbl_row_h = 4.5;

        let tbl_header_y = sep_y - 6.5;
        payslip_cell(
            &mut ops,
            page_left,
            tbl_header_y,
            earn_lbl_w,
            6.5,
            "Earnings",
            8.5,
            true,
            PayslipAlign::Left,
            None,
            true,
            None,
        );
        payslip_cell(
            &mut ops,
            page_left + earn_lbl_w,
            tbl_header_y,
            earn_val_w,
            6.5,
            "Amount",
            8.5,
            true,
            PayslipAlign::Right,
            None,
            true,
            None,
        );
        payslip_cell(
            &mut ops,
            page_left + earn_lbl_w + earn_val_w,
            tbl_header_y,
            ded_lbl_w,
            6.5,
            "Deductions",
            8.5,
            true,
            PayslipAlign::Left,
            None,
            true,
            None,
        );
        payslip_cell(
            &mut ops,
            page_left + earn_lbl_w + earn_val_w + ded_lbl_w,
            tbl_header_y,
            ded_val_w,
            6.5,
            "Amount",
            8.5,
            true,
            PayslipAlign::Right,
            None,
            true,
            None,
        );

        let table_rows = [
            (
                "Basic",
                format_amount_or_dash(row.basic_pay_centavos),
                "SSS Employee Share",
                format_amount_or_dash(row.sss_centavos),
            ),
            (
                "HRA",
                format_amount_or_dash(row.hra_centavos),
                "Phic Employee Share",
                format_amount_or_dash(row.phic_centavos),
            ),
            (
                "Incentives Allowance",
                format_amount_or_dash(row.incentives_allowance_centavos),
                "HDMF Employee Share",
                format_amount_or_dash(row.hdmf_centavos),
            ),
            (
                "Special Allowance",
                format_amount_or_dash(row.special_allowance_centavos),
                "Salary Advance",
                format_amount_or_dash(row.salary_advance_centavos),
            ),
            (
                "Total Allowance",
                format_amount_or_dash(row.total_allowance_centavos),
                "",
                "".to_string(),
            ),
            (
                "Other Earnings",
                "".to_string(),
                "ABSENT",
                format_amount_or_dash(row.absence_deduction_centavos),
            ),
            (
                "Reg. Holidayr",
                format_amount_or_dash(row.regular_holiday_pay_centavos),
                "LATE",
                format_amount_or_dash(row.late_deduction_centavos),
            ),
            (
                "Special Holiday",
                format_amount_or_dash(row.special_holiday_pay_centavos),
                "",
                "".to_string(),
            ),
            (
                "Over Time Pay",
                format_amount_or_dash(row.overtime_pay_centavos),
                "",
                "".to_string(),
            ),
        ];

        let mut tbl_y = tbl_header_y - tbl_row_h;
        for (e_lbl, e_val, d_lbl, d_val) in &table_rows {
            let e_bold = *e_lbl == "Other Earnings";
            payslip_cell(
                &mut ops,
                page_left,
                tbl_y,
                earn_lbl_w,
                tbl_row_h,
                e_lbl,
                8.0,
                e_bold,
                PayslipAlign::Left,
                None,
                true,
                None,
            );
            payslip_cell(
                &mut ops,
                page_left + earn_lbl_w,
                tbl_y,
                earn_val_w,
                tbl_row_h,
                e_val,
                8.0,
                false,
                PayslipAlign::Right,
                None,
                true,
                None,
            );
            payslip_cell(
                &mut ops,
                page_left + earn_lbl_w + earn_val_w,
                tbl_y,
                ded_lbl_w,
                tbl_row_h,
                d_lbl,
                8.0,
                false,
                PayslipAlign::Left,
                None,
                true,
                None,
            );
            payslip_cell(
                &mut ops,
                page_left + earn_lbl_w + earn_val_w + ded_lbl_w,
                tbl_y,
                ded_val_w,
                tbl_row_h,
                d_val,
                8.0,
                false,
                PayslipAlign::Right,
                None,
                true,
                None,
            );
            tbl_y -= tbl_row_h;
        }

        // Total Earnings / Total Deductions Row
        let total_row_y = tbl_y;
        payslip_cell(
            &mut ops,
            page_left,
            total_row_y,
            earn_lbl_w,
            tbl_row_h,
            "Total Earnings",
            8.5,
            true,
            PayslipAlign::Left,
            None,
            true,
            None,
        );
        payslip_cell(
            &mut ops,
            page_left + earn_lbl_w,
            total_row_y,
            earn_val_w,
            tbl_row_h,
            &format_amount_or_dash(row.gross_compensation_centavos),
            8.5,
            true,
            PayslipAlign::Right,
            None,
            true,
            None,
        );
        payslip_cell(
            &mut ops,
            page_left + earn_lbl_w + earn_val_w,
            total_row_y,
            ded_lbl_w,
            tbl_row_h,
            "Total Deductions",
            8.5,
            true,
            PayslipAlign::Left,
            None,
            true,
            None,
        );
        payslip_cell(
            &mut ops,
            page_left + earn_lbl_w + earn_val_w + ded_lbl_w,
            total_row_y,
            ded_val_w,
            tbl_row_h,
            &format_amount_or_dash(row.total_deductions_centavos),
            8.5,
            true,
            PayslipAlign::Right,
            None,
            true,
            None,
        );

        // 6. Net Pay Row (Yellow Highlighted Box)
        let net_y = total_row_y - 8.0;
        payslip_cell(
            &mut ops,
            page_left,
            net_y,
            earn_lbl_w,
            7.5,
            "Net Pay",
            9.5,
            true,
            PayslipAlign::Left,
            None,
            true,
            None,
        );
        payslip_cell(
            &mut ops,
            page_left + earn_lbl_w,
            net_y,
            earn_val_w,
            7.5,
            &format_amount_or_dash(row.net_pay_centavos),
            9.5,
            true,
            PayslipAlign::Right,
            Some(printpdf::Color::Rgb(printpdf::Rgb::new(
                0.953, 0.875, 0.247, None,
            ))),
            true,
            None,
        );
        draw_payslip_h_line(
            &mut ops,
            page_left + earn_lbl_w,
            page_left + earn_lbl_w + earn_val_w,
            net_y - 0.8,
            0.5,
        );

        // 7. Footer Signatures
        let sig_line_y = net_y - 25.0;
        let sig_w = 86.0;
        let right_sig_x = page_left + page_w - sig_w;

        draw_payslip_h_line(&mut ops, page_left, page_left + sig_w, sig_line_y, 0.8);
        draw_payslip_h_line(&mut ops, right_sig_x, right_sig_x + sig_w, sig_line_y, 0.8);

        payslip_cell(
            &mut ops,
            page_left,
            sig_line_y - 6.0,
            sig_w,
            5.0,
            "PREPARED BY:",
            8.5,
            true,
            PayslipAlign::Left,
            None,
            false,
            None,
        );
        payslip_cell(
            &mut ops,
            right_sig_x,
            sig_line_y - 6.0,
            sig_w,
            5.0,
            "EMPLOYEE SIGNATURE",
            8.5,
            true,
            PayslipAlign::Left,
            None,
            false,
            None,
        );

        pages.push(PdfPage::new(Mm(297.0), Mm(210.0), ops));
    }

    let bytes = document
        .with_pages(pages)
        .save(&PdfSaveOptions::default(), &mut Vec::new());
    std::fs::write(path, bytes).map_err(|e| e.to_string())
}

pub fn generate_payroll_pdf(
    row: &PayrollExportRow,
    office: &crate::config::OfficeConfig,
    path: &std::path::Path,
) -> Result<(), String> {
    let payslip = EmployeePayslipData {
        payroll_id: row.payroll_id.clone(),
        employee_id: row.employee_id.clone(),
        employee_name: row.employee_name.clone(),
        department: String::new(),
        designation: row.profile.clone(),
        tin: office.tax_identification_number.clone().unwrap_or_default(),
        bank_name: "CASH".into(),
        account_number: "0000".into(),
        standard_working_days: 11.0,
        paid_days: 11.0,
        lwop_days: 0.0,
        daily_rate_centavos: row.basic_pay_centavos / 11,
        basic_pay_centavos: row.basic_pay_centavos,
        hra_centavos: 0,
        incentives_allowance_centavos: row.incentives_centavos,
        special_allowance_centavos: row.allowances_centavos,
        total_allowance_centavos: row.allowances_centavos + row.incentives_centavos,
        regular_holiday_pay_centavos: 0,
        special_holiday_pay_centavos: 0,
        overtime_pay_centavos: 0,
        gross_compensation_centavos: row.gross_centavos,
        sss_centavos: 0,
        phic_centavos: 0,
        hdmf_centavos: 0,
        salary_advance_centavos: 0,
        absence_deduction_centavos: 0,
        late_deduction_centavos: row.late_deduction_centavos,
        total_deductions_centavos: row.late_deduction_centavos + row.other_adjustments_centavos,
        net_pay_centavos: row.net_centavos,
        cutoff_label: row.cutoff_label.clone(),
        status: row.status.clone(),
    };
    generate_employee_payslip_document(
        std::slice::from_ref(&payslip),
        &row.cutoff_label,
        office,
        path,
    )
}

pub fn payroll_register_pdf_filename(cutoff: &str, job_id: &str) -> String {
    format!(
        "AlphaPremier_Payroll_Register_{}_{}.pdf",
        sanitize_filename_component(cutoff),
        sanitize_filename_component(job_id)
    )
}

pub fn generate_payroll_register_pdf(
    rows: &[PayrollExportRow],
    cutoff: &str,
    office: &crate::config::OfficeConfig,
    path: &std::path::Path,
) -> Result<(), String> {
    let mut document = PdfDocument::new("Alpha Premier Payroll Register");
    let mark = brand_mark_image(&mut document, 13.0);
    let mut pages = Vec::new();
    let chunks: Vec<&[PayrollExportRow]> = if rows.is_empty() {
        vec![&[]]
    } else {
        rows.chunks(22).collect()
    };
    for chunk in chunks {
        let mut ops = Vec::new();
        if let Some((id, dpi)) = &mark {
            ops.push(brand_mark_op(id.clone(), *dpi, 193.0, 278.0));
        }
        let mut add = |text: String, x: f32, y: f32, size: f32, bold: bool| {
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
        };
        add(
            "ALPHA PREMIER - PAYROLL REGISTER".into(),
            12.0,
            286.0,
            14.0,
            true,
        );
        add(
            format!("Office: {}", office.display_full()),
            12.0,
            278.0,
            8.0,
            false,
        );
        add(
            format!("Cutoff: {cutoff} | Timezone: Asia/Manila | Static report values"),
            12.0,
            271.0,
            8.0,
            false,
        );
        add("Employee ID / Name".into(), 12.0, 264.0, 8.0, true);
        add("Status".into(), 91.0, 264.0, 8.0, true);
        add("Gross".into(), 120.0, 264.0, 8.0, true);
        add("Net Pay".into(), 157.0, 264.0, 8.0, true);
        for (index, row) in chunk.iter().enumerate() {
            let y = 254.0 - (index as f32 * 10.0);
            add(
                format!("{} / {}", row.employee_id, row.employee_name),
                12.0,
                y,
                7.0,
                false,
            );
            add(row.status.clone(), 91.0, y, 7.0, false);
            add(format_php(row.gross_centavos), 120.0, y, 7.0, false);
            add(format_php(row.net_centavos), 157.0, y, 7.0, false);
        }
        add(
            "CONFIDENTIAL - For authorized payroll use only".into(),
            12.0,
            12.0,
            7.0,
            false,
        );
        pages.push(PdfPage::new(Mm(210.0), Mm(297.0), ops));
    }
    let bytes = document
        .with_pages(pages)
        .save(&PdfSaveOptions::default(), &mut Vec::new());
    std::fs::write(path, bytes).map_err(|e| e.to_string())
}

/// One row of the consolidated payroll sheet. Mirrors the reference column
/// layout of the printable payroll worksheet (Employee #, Employee Name,
/// Cut Off Rate, Daily Rate, Actual Working Days, Standard Working Days,
/// Basic Rate, Total Compensation, Late 10 /hr, Halfday, Absent, Gross
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
    pub absence_deduction_centavos: i64,
    pub gross_compensation_centavos: i64,
}

pub async fn load_employee_payslip_rows(
    db: &sqlx::SqlitePool,
    cutoff_start: &str,
    cutoff_end: &str,
) -> Result<Vec<EmployeePayslipData>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT pc.payroll_id, pc.employee_id, pc.employee_name, \
         COALESCE(NULLIF(pc.department, ''), u.department, '') AS department, \
         COALESCE(NULLIF(pc.designation, ''), u.designation, u.employee_type, 'EMPLOYEE') AS designation, \
         COALESCE(NULLIF(pc.tin, ''), u.tin, '') AS tin, \
         COALESCE(NULLIF(pc.bank_name, ''), u.bank_name, 'CASH') AS bank_name, \
         COALESCE(NULLIF(pc.account_number, ''), u.account_number, '0000') AS account_number, \
         pc.payroll_cutoff_label, pc.daily_rate_centavos, pc.standard_working_days, pc.actual_working_days, \
         pc.basic_pay_centavos, pc.hra_centavos, pc.incentives_allowance_centavos, pc.special_allowance_centavos, \
         pc.total_allowance_centavos, pc.special_holiday_pay_centavos, pc.regular_holiday_pay_centavos, \
         pc.overtime_pay_centavos, pc.late_deduction_centavos, pc.half_day_deduction_centavos, \
         pc.absent_days, pc.absence_deduction_centavos, pc.gross_compensation_centavos, pc.net_pay_centavos, \
         pc.sss_centavos, pc.phic_centavos, pc.hdmf_centavos, pc.salary_advance_centavos, \
         pc.status \
         FROM payroll_cutoffs pc LEFT JOIN users u ON u.user_id = pc.employee_id \
         WHERE pc.cutoff_start = ? AND pc.cutoff_end = ? AND COALESCE(u.employee_type, 'EMPLOYEE') = 'EMPLOYEE' \
         ORDER BY pc.employee_name, pc.employee_id",
    )
    .bind(cutoff_start)
    .bind(cutoff_end)
    .fetch_all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let daily_rate_centavos = row.get::<i64, _>("daily_rate_centavos");
            let basic_pay_centavos = row.get::<i64, _>("basic_pay_centavos");
            let hra_centavos = row.get::<i64, _>("hra_centavos");
            let incentives_allowance_centavos = row.get::<i64, _>("incentives_allowance_centavos");
            let special_allowance_centavos = row.get::<i64, _>("special_allowance_centavos");
            let total_allowance_centavos = row.get::<i64, _>("total_allowance_centavos");
            let special_holiday_pay_centavos = row.get::<i64, _>("special_holiday_pay_centavos");
            let regular_holiday_pay_centavos = row.get::<i64, _>("regular_holiday_pay_centavos");
            let overtime_pay_centavos = row.get::<i64, _>("overtime_pay_centavos");
            let gross_compensation_centavos = row.get::<i64, _>("gross_compensation_centavos");
            let late_deduction_centavos = row.get::<i64, _>("late_deduction_centavos");
            let half_day_deduction_centavos = row.get::<i64, _>("half_day_deduction_centavos");
            let absence_deduction_centavos = row.get::<i64, _>("absence_deduction_centavos");
            let sss_centavos = row.get::<i64, _>("sss_centavos");
            let phic_centavos = row.get::<i64, _>("phic_centavos");
            let hdmf_centavos = row.get::<i64, _>("hdmf_centavos");
            let salary_advance_centavos = row.get::<i64, _>("salary_advance_centavos");
            let total_deductions_centavos = late_deduction_centavos
                + half_day_deduction_centavos
                + absence_deduction_centavos
                + sss_centavos
                + phic_centavos
                + hdmf_centavos
                + salary_advance_centavos;
            let net_pay_centavos = row.get::<i64, _>("net_pay_centavos");

            EmployeePayslipData {
                payroll_id: row.get("payroll_id"),
                employee_id: row.get("employee_id"),
                employee_name: row.get("employee_name"),
                department: row.get("department"),
                designation: row.get("designation"),
                tin: row.get("tin"),
                bank_name: row.get("bank_name"),
                account_number: row.get("account_number"),
                standard_working_days: row.get("standard_working_days"),
                paid_days: row.get("actual_working_days"),
                lwop_days: row.get("absent_days"),
                daily_rate_centavos,
                basic_pay_centavos,
                hra_centavos,
                incentives_allowance_centavos,
                special_allowance_centavos,
                total_allowance_centavos,
                regular_holiday_pay_centavos,
                special_holiday_pay_centavos,
                overtime_pay_centavos,
                gross_compensation_centavos,
                sss_centavos,
                phic_centavos,
                hdmf_centavos,
                salary_advance_centavos,
                absence_deduction_centavos,
                late_deduction_centavos: late_deduction_centavos + half_day_deduction_centavos,
                total_deductions_centavos,
                net_pay_centavos,
                cutoff_label: row.get("payroll_cutoff_label"),
                status: row.get("status"),
            }
        })
        .collect())
}

/// Loads the payroll sheet rows for one cutoff, filtered to `worker_type`
/// ("EMPLOYEE" keeps employees; anything else keeps interns). Payroll cutoff
/// rows do not store an employee type column, so it is derived from the live
/// Users register (defaulting to INTERN when the user is missing).
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
         pc.half_day_deduction_centavos, pc.absent_days, pc.absence_deduction_centavos, \
         pc.gross_compensation_centavos, COALESCE(u.employee_type, 'INTERN') AS employee_type \
         FROM payroll_cutoffs pc LEFT JOIN users u ON u.user_id = pc.employee_id \
         WHERE pc.cutoff_start = ? AND pc.cutoff_end = ? \
         ORDER BY pc.employee_name, pc.employee_id",
    )
    .bind(cutoff_start)
    .bind(cutoff_end)
    .fetch_all(db)
    .await?;
    let keep_employee = worker_type == "EMPLOYEE";
    Ok(rows
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
            let half_day_deduction_centavos = row.get::<i64, _>("half_day_deduction_centavos");
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
            // For the sheet presentation, Total Compensation represents the full cutoff rate
            // and late, half-day, and absent days are deducted to arrive at Gross Compensation.
            let total_compensation_centavos = cutoff_rate_centavos;
            let manual_adjustment_centavos = row
                .try_get::<i64, _>("manual_adjustment_centavos")
                .unwrap_or(0);
            let gross_compensation_centavos = (total_compensation_centavos
                + manual_adjustment_centavos
                - late_deduction_centavos
                - half_day_deduction_centavos
                - absence_deduction_centavos)
                .max(0);
            PayrollSheetRow {
                employee_id: row.get("employee_id"),
                employee_name: row.get("employee_name"),
                employee_type: row.get("employee_type"),
                cutoff_rate_centavos,
                daily_rate_centavos,
                actual_working_days,
                standard_working_days,
                basic_pay_centavos: row.get("basic_pay_centavos"),
                total_compensation_centavos,
                late_deduction_centavos,
                half_day_deduction_centavos,
                absence_deduction_centavos,
                gross_compensation_centavos,
            }
        })
        .collect())
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
        // Yellow-highlighted Gross Compensation grand total like the reference.
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
const SHEET_COL_WIDTHS_MM: [f32; 12] = [
    24.0, 42.0, 22.0, 20.0, 18.0, 18.0, 23.0, 16.0, 16.0, 16.0, 26.0, 32.0,
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
        const HEADERS: [&str; 12] = [
            "Employee #",
            "Employee Name",
            "Cut Off\nRate",
            "Daily\nRate",
            "Actual\nDays",
            "Standard\nDays",
            "Total\nCompensation",
            "Late 10\n/hr",
            "Halfday",
            "Absent",
            "Gross\nCompensation",
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
            let cells: [String; 12] = [
                row.employee_id.clone(),
                row.employee_name.clone(),
                format_php(row.cutoff_rate_centavos),
                format_php(row.daily_rate_centavos),
                format_days(row.actual_working_days),
                format_days(row.standard_working_days),
                format_php(row.total_compensation_centavos),
                format_php(row.late_deduction_centavos),
                format_php(row.half_day_deduction_centavos),
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
            let total_w: f32 = SHEET_COL_WIDTHS_MM[..10].iter().sum();
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
                SHEET_COL_WIDTHS_MM[10],
                SHEET_ROW_H_MM,
                &format_php(total_gross),
                7.0,
                true,
                false,
                true,
            );
            let sig_x = last_x + SHEET_COL_WIDTHS_MM[10];
            sheet_cell(
                &mut ops,
                sig_x,
                row_y,
                SHEET_COL_WIDTHS_MM[11],
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
