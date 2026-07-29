import { loadConfig } from './config.js';
import { GoogleSheetsAdapter } from './sheets.js';

const config = loadConfig();
if (config.sheetsMode !== 'google') {
  console.log('SHEETS_MODE is memory; no Google Sheets connection to validate.');
} else {
  const adapter = new GoogleSheetsAdapter({ spreadsheetId: config.googleSheetsId!, clientEmail: config.googleServiceAccountEmail!, privateKey: config.googlePrivateKey! });
  await adapter.healthCheck();
  console.log('Google Sheets connection OK.');
}
