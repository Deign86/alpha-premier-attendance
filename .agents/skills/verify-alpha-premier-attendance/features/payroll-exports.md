# Payroll & Export Generation

Calculates semi-monthly cutoff attendance, overtime, deductions, and generates official Philippine Peso payroll workbooks and printable PDF payslips.

## Sub-features

- **Semi-Monthly Cutoffs**: Automatic 1st-15th and 16th-End-of-Month cutoff grouping with Asia/Manila boundary calculation.
- **Worker Payroll Rules**: Separate calculations for Regular Employees (hourly rate, lunch deduction, overtime) and Interns (fixed daily allowance, hourly late deduction).
- **Official PDF Generation**: Generates compliant payslips (`printpdf`) with company header, address metadata, and QR/barcode identifiers.
- **Excel (.xlsx) Export**: Full payroll register spreadsheet generation via `rust_xlsxwriter`.
- **Desktop File Actions**: Native "Open File" and "Reveal in Folder" capabilities via Tauri Opener plugin.

## How to get to it (user POV)

1. Navigate to the Admin workspace (requires PIN unlock).
2. Select the "Payroll" tab.
3. Choose a payroll cutoff period from the cutoff selector dropdown.
4. Click "Generate Payroll Register" or "Generate Payslip PDFs".

## Driving it with Tauri MCP

1. **Calculate Cutoff via IPC**:
   - Request cutoff preview calculation:
     ```json
     {
       "ServerName": "tauri",
       "ToolName": "ipc_execute_command",
       "Arguments": {
         "command": "payroll_generate_cutoff",
         "payload": {
           "token": "<token>",
           "cutoffStart": "2026-08-01",
           "cutoffEnd": "2026-08-15",
           "payrollCutoffLabel": "August 1-15, 2026",
           "customization": {}
         }
       }
     }
     ```
2. **Export Payroll XLSX**:
   - Invoke `export_payroll_xlsx`:
     ```json
     {
       "ServerName": "tauri",
       "ToolName": "ipc_execute_command",
       "Arguments": {
         "command": "export_payroll_xlsx",
         "payload": { "token": "<token>", "cutoff": "2026-08-01_2026-08-15" }
       }
     }
     ```
3. **Generate Official PDF Register**:
   - Invoke `generate_payroll_register_pdf`:
     ```json
     {
       "ServerName": "tauri",
       "ToolName": "ipc_execute_command",
       "Arguments": {
         "command": "generate_payroll_register_pdf",
         "payload": { "token": "<token>", "cutoff": "2026-08-01_2026-08-15" }
       }
     }
     ```
4. **Capture Evidence**:
   - Confirm exported files exist on disk at the returned `filePath`.
   - Take a screenshot of the Payroll workspace preview:
     ```json
     {
       "ServerName": "tauri",
       "ToolName": "webview_screenshot",
       "Arguments": { "name": "payroll_preview_table" }
     }
     ```

## Gotchas

- All currency amounts are computed in centavos internally to avoid floating-point rounding errors before rendering in PHP format.
- Generated export files are saved inside `$APPLOCALDATA/exports/` or the configured portable directory. Attempting to save outside this directory is rejected by path validation.
