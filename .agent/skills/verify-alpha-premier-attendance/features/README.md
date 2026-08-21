# Alpha Premier Attendance — Feature Verification Map

This directory contains the feature-by-feature verification specifications for Alpha Premier Attendance. Each feature file details how to drive the real application via Tauri MCP and what observable evidence proves the behavior works.

## Feature Index

| Feature File | Surface / Area | Description |
|---|---|---|
| [`rfid-kiosk.md`](rfid-kiosk.md) | Main Kiosk UI | RFID card scanning, manual UID entry fallback, attendance clock in / clock out, visual and voice feedback |
| [`admin-roster.md`](admin-roster.md) | Admin Workspace | Secure PIN unlock, employee & intern roster CRUD, photo upload, RFID UID assignment |
| [`card-setup.md`](card-setup.md) | Card Setup Modal | Unknown card fast-enrollment flow, operator PIN protection, direct employee binding |
| [`payroll-exports.md`](payroll-exports.md) | Payroll Workspace | Semi-monthly cutoff calculations, official PDF payslip and register generation, XLSX export, file reveal |
| [`settings-lan-tts.md`](settings-lan-tts.md) | Settings & Diagnostics | Voice selection (Windows SAPI / Piper ONNX), pitch/rate controls, LAN server toggle & sync |
