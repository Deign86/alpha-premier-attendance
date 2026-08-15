import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { GoogleSheetsAdapter, InMemorySheetsService, type GoogleSheetsService } from './sheets.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

function lanIpv4Addresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flatMap((items) => items ?? [])
    .filter((item) => item.family === 'IPv4' && !item.internal)
    .map((item) => item.address)
    .filter((address) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address));
}

export async function createServiceFromEnv(config = loadConfig()): Promise<GoogleSheetsService> {
  if (config.sheetsMode === 'google') {
    const adapter = new GoogleSheetsAdapter({
      spreadsheetId: config.googleSheetsId,
      clientEmail: config.googleServiceAccountEmail,
      privateKey: config.googlePrivateKey,
      driveFolderId: config.googleDriveFolderId,
      driveFolderName: config.googleDriveFolderName,
      createFolderIfMissing: config.googleCreateFolderIfMissing,
      stateFile: config.googleSheetsStateFile,
    });
    await adapter.ensureSpreadsheet();
    return adapter;
  }
  return new InMemorySheetsService();
}

if (process.env.NODE_ENV !== 'test') {
  void (async () => {
    try {
      const config = loadConfig();
      const rootDist = path.resolve(process.cwd(), 'client', 'dist');
      const workspaceDist = path.resolve(process.cwd(), '..', 'client', 'dist');
      const staticDir = fs.existsSync(rootDist) ? rootDist : workspaceDist;
      const sheets = await createServiceFromEnv(config);
      const app = createApp({ sheets, config, staticDir });
      const host = config.host || '0.0.0.0';
      app.listen(config.port, host, () => {
        const urls = lanIpv4Addresses().map((address) => `http://${address}:${config.port}`);
        console.log(`RFID attendance API listening on ${host}:${config.port}`);
        console.log(`Local URL: http://localhost:${config.port}`);
        console.log(`LAN URL(s): ${urls.length ? urls.join(', ') : 'none detected'}`);
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  })();
}
