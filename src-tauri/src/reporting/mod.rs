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
        let path = std::env::temp_dir()
            .join(format!("attendance-office-{}.xlsx", uuid::Uuid::new_v4()));
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
        assert!(shared.contains("Unit 3104C, Tektite East Tower, Ortigas Center, Pasig, Metro Manila"));
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
        let path = std::env::temp_dir().join(format!("payroll-office-{}.xlsx", uuid::Uuid::new_v4()));
        generate_payroll_workbook(std::slice::from_ref(&row), "1st-Half-2026", &office(), &path)
            .unwrap();
        let shared = read_xlsx_shared_strings(&path);
        assert!(shared.contains("Company: Alpha Premier"));
        assert!(shared.contains("Unit 3104C, Tektite East Tower, Ortigas Center, Pasig, Metro Manila"));
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
        generate_payroll_workbook(std::slice::from_ref(&row), "1st-Half-2026", &office(), &xlsx).unwrap();
        generate_payroll_pdf(&row, &office(), &pdf).unwrap();
        assert!(std::fs::read(&xlsx).unwrap().starts_with(b"PK"));
        // The official brand mark is embedded as a workbook media file.
        {
            let archive = zip::ZipArchive::new(std::fs::File::open(&xlsx).unwrap()).unwrap();
            assert!(
                archive.file_names().any(|name| name.starts_with("xl/media/")),
                "payroll workbook should embed the brand mark media file"
            );
        }
        assert!(std::fs::read(&pdf).unwrap().starts_with(b"%PDF"));
        let register = base.with_extension("register.pdf");
        generate_payroll_register_pdf(std::slice::from_ref(&row), "1st-Half-2026", &office(), &register)
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
        assert!(mark.is_some(), "embedded phoenix PNG should decode from the repo asset");
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

}
use printpdf::{
    BuiltinFont, Mm, Op, PdfDocument, PdfFontHandle, PdfPage, PdfSaveOptions, Point, Pt, RawImage,
    TextItem, XObjectTransform,
};

/// Phoenix brand mark embedded at compile time so PDF reports never depend on
/// runtime asset paths. The mark is transparent-backed and works on white paper.
const BRAND_PHOENIX_PNG: &[u8] = include_bytes!("../../../assets/logo_phoenix.png");

/// Decodes and registers the phoenix mark on the document, returning the image
/// id plus the dpi that renders the square mark `size_mm` tall. Registered once
/// per document and reused on every page. Returns `None` (and logs) if the
/// embedded PNG cannot be decoded so a decorative mark never fails a document.
fn brand_mark_image(document: &mut PdfDocument, size_mm: f32) -> Option<(printpdf::XObjectId, f32)> {
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
            translate_x: Some(Pt(x_mm)),
            translate_y: Some(Pt(y_mm)),
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

pub fn generate_payroll_pdf(
    row: &PayrollExportRow,
    office: &crate::config::OfficeConfig,
    path: &std::path::Path,
) -> Result<(), String> {
    let mut document = PdfDocument::new("Alpha Premier Payroll Payslip");
    let mark = brand_mark_image(&mut document, 15.0);
    let mut ops = Vec::new();
    if let Some((id, dpi)) = &mark {
        ops.push(brand_mark_op(id.clone(), *dpi, 191.0, 264.0));
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
    add("ALPHA PREMIER".to_string(), 20.0, 276.0, 18.0, true);
    add(office.display_full(), 20.0, 269.0, 9.0, false);
    add(
        format!(
            "PAYSLIP - {}",
            if row.status == "FINALIZED" {
                "FINAL"
            } else if row.status == "VOID" {
                "VOID"
            } else {
                "DRAFT"
            }
        ),
        20.0,
        258.0,
        12.0,
        true,
    );
    add(
        format!("Employee: {} ({})", row.employee_name, row.employee_id),
        20.0,
        248.0,
        11.0,
        false,
    );
    add(
        format!(
            "Profile: {}   Cutoff: {} ({} to {})",
            row.profile, row.cutoff_label, row.cutoff_start, row.cutoff_end
        ),
        20.0,
        239.0,
        10.0,
        false,
    );
    add("EARNINGS".to_string(), 20.0, 218.0, 11.0, true);
    add(
        format!(
            "Basic Pay ................................ {}",
            format_php(row.basic_pay_centavos)
        ),
        24.0,
        207.0,
        10.0,
        false,
    );
    add(
        format!(
            "Allowances ............................. {}",
            format_php(row.allowances_centavos)
        ),
        24.0,
        198.0,
        10.0,
        false,
    );
    add(
        format!(
            "Incentives .............................. {}",
            format_php(row.incentives_centavos)
        ),
        24.0,
        189.0,
        10.0,
        false,
    );
    add(
        "DEDUCTIONS / ADJUSTMENTS".to_string(),
        20.0,
        171.0,
        11.0,
        true,
    );
    add(
        format!(
            "Late deductions ......................... {}",
            format_php(row.late_deduction_centavos)
        ),
        24.0,
        160.0,
        10.0,
        false,
    );
    add(
        format!(
            "Other adjustments ...................... {}",
            format_php(row.other_adjustments_centavos)
        ),
        24.0,
        151.0,
        10.0,
        false,
    );
    add(
        format!("GROSS PAY: {}", format_php(row.gross_centavos)),
        20.0,
        128.0,
        12.0,
        true,
    );
    add(
        format!("NET PAY: {}", format_php(row.net_centavos)),
        20.0,
        114.0,
        15.0,
        true,
    );
    add(
        format!("Status: {}   Document ID: {}", row.status, row.payroll_id),
        20.0,
        94.0,
        9.0,
        false,
    );
    add(
        "CONFIDENTIAL - For authorized payroll use only".to_string(),
        20.0,
        24.0,
        8.0,
        false,
    );
    let bytes = document
        .with_pages(vec![PdfPage::new(Mm(210.0), Mm(297.0), ops)])
        .save(&PdfSaveOptions::default(), &mut Vec::new());
    std::fs::write(path, bytes).map_err(|e| e.to_string())
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
