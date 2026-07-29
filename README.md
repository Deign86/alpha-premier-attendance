# RFID Time In / Time Out

Small Windows-friendly RFID attendance kiosk backed by Google Sheets. The reader is used as a USB HID keyboard wedge: it types a UID into the focused browser field, and the Node.js API records one Time In and one Time Out per person per Manila calendar day.

## Quick start

```powershell
npm install
Copy-Item server/.env.example server/.env
npm run validate:sheets
npm run dev
```

Open `http://localhost:5173` during development. The backend listens on port `3001` and the Vite development server proxies `/api` requests to it. Production builds serve the client from Express:

```powershell
npm run build
npm run start -w server
```

Then open `http://localhost:3001`.

The service account must have Editor access to the spreadsheet, whose tabs and headers must match the schema in [docs/google-sheets-setup.md](docs/google-sheets-setup.md). Never commit `server/.env` or service-account credentials.

## Documentation

- [plan.md](plan.md): full implementation plan, contracts, rules, phases, and acceptance criteria.
- [docs/hardware-verification.md](docs/hardware-verification.md): reader and UID acceptance checklist.
- [docs/google-sheets-setup.md](docs/google-sheets-setup.md): Google Cloud and spreadsheet setup.
- [docs/deployment.md](docs/deployment.md): Windows local and private-LAN operation.

The USB reader must remain connected to the computer running the kiosk browser. RFID UIDs identify cards; they are not strong authentication credentials.
