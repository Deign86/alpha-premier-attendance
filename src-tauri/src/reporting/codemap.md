# src-tauri/src/reporting/

## Responsibility
- Provides Rust report data models, SQLite row loaders, formatting helpers, safe filenames, and XLSX/PDF generation for attendance and payroll exports.

## Design
- `mod.rs` is publicly exposed by the crate root; export functions accept explicit rows, office configuration, and output paths rather than owning Tauri state.
- Monetary values remain integer centavos in payroll domain types; `format_php` and workbook writers convert for display, while timestamps render in Asia/Manila.
- Filename components are normalized for Windows-invalid characters, reserved names, and length; document generation uses `rust_xlsxwriter` and `printpdf`.

## Flow
- Export command in `lib.rs` loads attendance via `load_attendance_rows(db, date)` or payroll records via payroll loaders, then calls the appropriate generator with `OfficeConfig` and managed export path.
- Attendance row loading computes paid hours through `services::lunch_break`; timestamps become Manila time before the XLSX writer adds metadata, headers, and rows.
- Payroll export is intern-only: `load_payroll_sheet_rows` feeds `generate_payroll_sheet_pdf`, and `load_intern_payslips` feeds `write_intern_payslip_images`; the retired employee payroll workbook, register PDF, and employee payslip PDF generators no longer exist.

## Integration
- Callers are Tauri export commands in `lib.rs`; persistence is read through the shared SQLx SQLite pool and office identity comes from `config::OfficeConfig`.
- Output files live in the app's exports directory and are opened/downloaded by the WebView through Tauri file handling; tests exercise formatting and actual document output.
- The embedded phoenix logo is compiled from `assets/logo_phoenix.png`, so PDF generation does not rely on runtime resource lookup.
