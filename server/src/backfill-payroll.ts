import { loadConfig } from './config.js';
import { GoogleSheetsAdapter } from './sheets.js';

const execute = process.argv.includes('--execute');
const config = loadConfig();
if (config.sheetsMode !== 'google' || !config.googleSheetsId || !config.googleServiceAccountEmail || !config.googlePrivateKey) throw new Error('Payroll backfill requires Google Sheets mode');
const sheets = new GoogleSheetsAdapter({ spreadsheetId: config.googleSheetsId, clientEmail: config.googleServiceAccountEmail, privateKey: config.googlePrivateKey });
await sheets.healthCheck();
console.log(execute ? 'Backfill prerequisites validated. Run the approved attendance reconciliation job before writing historical payroll.' : 'Dry run: validated payroll tabs. No historical payroll was written.');
