import { createApp } from '../server/dist/app.js';
import { loadConfig } from '../server/dist/config.js';
import { GoogleSheetsAdapter, InMemorySheetsService } from '../server/dist/sheets.js';

const config = loadConfig();
const sheets = config.sheetsMode === 'google'
  ? new GoogleSheetsAdapter({
      spreadsheetId: config.googleSheetsId,
      clientEmail: config.googleServiceAccountEmail,
      privateKey: config.googlePrivateKey,
    })
  : new InMemorySheetsService();

const app = createApp({ sheets, config, logger: false });

export default function handler(req, res) {
  return app(req, res);
}
