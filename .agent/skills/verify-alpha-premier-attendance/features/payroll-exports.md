# Payroll & Export Generation

Calculates semi-monthly cutoff attendance, overtime, deductions, and generates official Philippine Peso payroll workbooks and printable PDF payslips with native file viewing and folder reveal actions.

## Sub-features

- `PAYROLL-CUTOFF`: Automatic 1st-15th and 16th-End-of-Month cutoff grouping with Asia/Manila boundary calculation.
- `PAYROLL-RULES`: Strict calculation separation for Regular Employees (hourly rate, lunch deduction, overtime) and Interns (fixed daily allowance, hourly late deduction).
- `PAYROLL-PDF`: Generates compliant payslips (`printpdf`) with company header, address metadata, and QR/barcode identifiers.
- `PAYROLL-XLSX`: Full payroll register spreadsheet generation via `rust_xlsxwriter`.
- `PAYROLL-FILES`: Desktop native "Open File" and "Reveal in Folder" capabilities via Tauri Opener plugin.

## How to get to it (user POV)

- Navigate to the Admin workspace (requires PIN unlock `1234`).
- Select the "Payroll" tab.
- Choose a payroll cutoff period from the cutoff selector dropdown (or pick custom dates).
- Click "Generate Payroll Register" (Excel) or "Generate Payslip PDFs".

## Driving it with Tauri MCP

Preconditions:
- App is running on Tauri MCP bridge port 9223.
- An authenticated session token is available from `setup_unlock`.

- **Calculate Cutoff Summary**: Request preview calculation.
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
  *Observable result*: Returns calculated payroll records with basic pay, allowances, deductions, and net pay in centavos.

- **Export Payroll XLSX**:
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
  *Observable result*: Returns `{ "success": true, "filePath": "...", "fileName": "payroll-2026-08-01_2026-08-15.xlsx" }`.

- **Generate Official PDF Register & Payslips**:
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
  *Observable result*: Generates valid PDF document in the exports directory.

- **Capture Visual Evidence**:
  ```json
  {
    "ServerName": "tauri",
    "ToolName": "webview_screenshot",
    "Arguments": { "name": "payroll_register_preview" }
  }
  ```
  *Observable result*: Screenshot captured of the payroll register calculation table.

## Gotchas

- All currency amounts are computed in centavos internally to avoid floating-point rounding errors before rendering in PHP format.
- Generated export files are saved inside `$APPLOCALDATA/exports/` or the configured portable directory. Attempting to save outside this directory is rejected by path validation.

