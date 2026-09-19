# Payroll & Export Generation

Calculates semi-monthly cutoff attendance, overtime, deductions, and generates official Philippine Peso payroll workbooks and printable PDF payslips with native file viewing and folder reveal actions.

## Sub-features

- `PAYROLL-CUTOFF`: Automatic 1st-15th and 16th-End-of-Month cutoff grouping (plain calendar split; Mon–Fri workday count).
- `PAYROLL-RULES`: Strict calculation separation for Regular Employees (hourly rate, lunch deduction, overtime) and Interns (fixed daily allowance, hourly late deduction).
- `PAYROLL-PDF`: Generates payslips (`printpdf`) with company header, address metadata, and phoenix brand-mark image (no QR/barcode).
- `PAYROLL-XLSX`: Full payroll register spreadsheet generation via `rust_xlsxwriter`.
- `PAYROLL-FILES`: Desktop native "Open File" and "Reveal in Folder" capabilities via Tauri Opener plugin (confined to the exports dir).

## How to get to it (user POV)

- Navigate to the Admin workspace (requires PIN unlock `293906`).
- Select the "Payroll" tab.
- Choose a payroll cutoff period from the cutoff selector dropdown (or pick custom dates).
- Click "Generate from attendance", then "Generate Employee Payroll PDF" or "Generate Intern Payroll PDF".

## Driving it with Tauri MCP

> IPC route (live-proved): `tauri_ipc_execute_command` drops command args.
> Drive backend commands via `tauri_webview_execute_js` wrapping
> `window.__TAURI__.core.invoke('<command>', { camelCaseArgs })` with arg keys
> exactly as in `client/src/tauri-api.ts`.

Preconditions:
- App is running on Tauri MCP bridge port 9223.
- An authenticated session token is available from `setup_unlock`.

- **Calculate Cutoff Summary**: `payroll_generate_cutoff` with
  `{ "token", "cutoffStart": "2026-08-01", "cutoffEnd": "2026-08-15",
  "payrollCutoffLabel": "August 1-15, 2026", "customization": {} }`.
  *Observable result*: Returns `{ "success": true, "generated": N }`; display
  amounts on the wire are PHP floats (centavos is storage-only).

- **Generate Payroll PDFs (primary UI path)**: `generate_payroll_pdf` with
  `{ "token", "cutoffStart", "cutoffEnd", "payrollCutoffLabel",
  "workerType": "EMPLOYEE" | "INTERN" }` — this is what the Payroll tab
  buttons call. Files land as
  `payroll_YYYY-MM-DD_HH-MM-SS_employee|intern.pdf`, registered in
  `payroll_pdfs`.

- **Export Payroll XLSX**: `export_payroll_xlsx` with
  `{ "token", "cutoff": "<exact stored cutoff label>" }` (`cutoff` is
  optional; omitted = all cutoffs; it matches label OR start OR end, so a
  combined `start_end` key matches nothing).
  *Observable result*: Returns full metadata + `jobId, artifactId, sizeBytes,
  sha256, rowCount`; file is `AlphaPremier_Payroll_{scope}_{job8}.xlsx`.

- **Generate Official PDF Register**: `generate_payroll_register_pdf`
  (same `cutoff` semantics) → `AlphaPremier_Payroll_Register_{scope}_{job8}.pdf`.

- **Capture Visual Evidence** (`tauri_webview_screenshot`):
  ```
  tool: tauri_webview_screenshot, args: { "name": "payroll_register_preview" }
  ```
  *Observable result*: Screenshot captured of the payroll register calculation table.

## Gotchas

- Money is stored as `*_centavos` integers in SQLite/Rust; display/wire amounts are PHP floats. Don't assert centavos on the wire.
- Generated files always land inside `data_dir/exports/` (portable: `Data\exports\` next to the exe). Open/Reveal reject paths outside it; saves never leave it.

