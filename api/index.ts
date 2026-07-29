import { createApp } from '../server/src/app.js';
import { loadConfig } from '../server/src/config.js';
import { GoogleSheetsAdapter, InMemorySheetsService, type GoogleSheetsService } from '../server/src/sheets.js';

const config = loadConfig();
const sheets: GoogleSheetsService = config.sheetsMode === 'google'
  ? new GoogleSheetsAdapter({
      spreadsheetId: config.googleSheetsId!,
      clientEmail: config.googleServiceAccountEmail!,
      privateKey: config.googlePrivateKey!,
    })
  : new InMemorySheetsService();

const app = createApp({ sheets, config, logger: false });

export default app;
