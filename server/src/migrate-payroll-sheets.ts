import { loadConfig } from './config.js';
import { GoogleSheetsAdapter } from './sheets.js';

const execute = process.argv.includes('--execute');
const config = loadConfig();
if (config.sheetsMode !== 'google' || !config.googleSheetsId || !config.googleServiceAccountEmail || !config.googlePrivateKey) throw new Error('Payroll migration requires Google Sheets mode');
const sheets = new GoogleSheetsAdapter({ spreadsheetId: config.googleSheetsId, clientEmail: config.googleServiceAccountEmail, privateKey: config.googlePrivateKey });
await sheets.healthCheck();
console.log(execute ? 'Validated payroll prerequisites. Create the exact InternGrace and Payroll tabs and append Users headers before enabling payroll.' : 'Dry run: validated Google Sheets access. No spreadsheet data was changed.');
