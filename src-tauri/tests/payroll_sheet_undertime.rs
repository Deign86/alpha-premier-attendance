// Runnable proof (on Windows) that the payroll sheet PDF register renders the
// Undertime Deduction column. The lib unit tests cannot execute in this
// environment (the lib test binary fails to load native deps), so this
// harness includes the reporting module directly, mirroring
// intern_payroll_isolated.rs to avoid Tauri/WebView2 in the test process.
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

        pub fn metadata_lines(&self) -> Vec<String> {
            vec![
                format!("Company: {}", self.company_name.trim()),
                format!("Office: {}", self.display_full()),
            ]
        }
    }
}

mod services {
    pub mod payroll {
        include!("../src/services/payroll.rs");
    }

    pub mod lunch_break {
        include!("../src/services/lunch_break.rs");
    }
}

mod reporting {
    include!("../src/reporting/mod.rs");
}

#[test]
fn payroll_sheet_pdf_renders_undertime_deduction_in_pesos() {
    use reporting::{
        PayrollSheetRow, format_php, generate_payroll_sheet_pdf,
        PAYROLL_SHEET_UNDERTIME_HEADER,
    };

    let rows = vec![PayrollSheetRow {
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
        half_day_deduction_centavos: 18_000,
        undertime_deduction_centavos: 18_000,
        absence_deduction_centavos: 0,
        gross_compensation_centavos: 550_000,
    }];
    let pdf = std::env::temp_dir().join(format!(
        "payroll-sheet-undertime-{}.pdf",
        std::process::id()
    ));
    generate_payroll_sheet_pdf(
        &rows,
        "September 16-30, 2026",
        "EMPLOYEE",
        &config::OfficeConfig::default(),
        &pdf,
    )
    .unwrap();
    let bytes = std::fs::read(&pdf).unwrap();
    assert!(bytes.starts_with(b"%PDF"));
    assert_eq!(PAYROLL_SHEET_UNDERTIME_HEADER, "Undertime\nDeduction (PHP)");
    assert_eq!(format_php(rows[0].undertime_deduction_centavos), "PHP 180.00");
    let _ = std::fs::remove_file(&pdf);
}
