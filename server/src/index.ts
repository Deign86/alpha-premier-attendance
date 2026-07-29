import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { GoogleSheetsAdapter, InMemorySheetsService, type GoogleSheetsService } from './sheets.js';
import path from 'node:path';
import fs from 'node:fs';

export function createServiceFromEnv(config = loadConfig()): GoogleSheetsService {
  if (config.sheetsMode === 'google') {
    return new GoogleSheetsAdapter({
      spreadsheetId: config.googleSheetsId!,
      clientEmail: config.googleServiceAccountEmail!,
      privateKey: config.googlePrivateKey!,
    });
  }
  return new InMemorySheetsService();
}

if (process.env.NODE_ENV !== 'test') {
  try {
    const config = loadConfig();
    const rootDist = path.resolve(process.cwd(), 'client', 'dist');
    const workspaceDist = path.resolve(process.cwd(), '..', 'client', 'dist');
    const staticDir = fs.existsSync(rootDist) ? rootDist : workspaceDist;
    const app = createApp({ sheets: createServiceFromEnv(config), config, staticDir });
    app.listen(config.port, () => {
      console.log(`RFID attendance API listening on http://localhost:${config.port}`);
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
