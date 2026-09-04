import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

const testRequire = createRequire(import.meta.url);
interface TestNodeSqliteModule {
  DatabaseSync: typeof DatabaseSyncType;
}
// SAFETY: Loading Node.js 22 built-in node:sqlite module via createRequire
const { DatabaseSync } = testRequire('node:sqlite') as TestNodeSqliteModule;
import {
  closeAllVoiceboxDbs,
  detectNamesFromApgbackup,
  findPronunciationsByName,
  getAllVoiceboxPronunciations,
  getPronunciationByEmployeeId,
  getVoiceboxDb,
  listVoiceboxNames,
  resolveDatabasePath,
  splitFullName,
  upsertPronunciation,
} from '../src/voicebox-db.js';
import { createVoiceboxRouter } from '../src/voicebox-routes.js';
import { createApp } from '../src/app.js';
import { InMemorySheetsService } from '../src/sheets.js';

describe('Voicebox Names Backend', () => {
  let tempDir: string;
  let testDbPath: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicebox-test-'));
    testDbPath = path.join(tempDir, 'test-voicebox.db');
  });

  afterAll(() => {
    closeAllVoiceboxDbs();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignored
    }
  });

  describe('splitFullName helper', () => {
    it('splits full names correctly by last word', () => {
      expect(splitFullName('Deign Grey O. Lazaro')).toEqual({
        firstName: 'Deign Grey O.',
        lastName: 'Lazaro',
      });
      expect(splitFullName('Juan Dela Cruz')).toEqual({
        firstName: 'Juan Dela',
        lastName: 'Cruz',
      });
      expect(splitFullName('Cher')).toEqual({
        firstName: 'Cher',
        lastName: '',
      });
      expect(splitFullName('')).toEqual({
        firstName: '',
        lastName: '',
      });
    });
  });

  describe('resolveDatabasePath', () => {
    it('returns custom path when provided', () => {
      expect(resolveDatabasePath('custom/path.db')).toBe('custom/path.db');
    });

    it('respects APGBACKUP_DB_PATH environment variable', () => {
      const orig = process.env.APGBACKUP_DB_PATH;
      process.env.APGBACKUP_DB_PATH = 'env/apgbackup.db';
      try {
        expect(resolveDatabasePath()).toBe('env/apgbackup.db');
      } finally {
        if (orig !== undefined) {
          process.env.APGBACKUP_DB_PATH = orig;
        } else {
          delete process.env.APGBACKUP_DB_PATH;
        }
      }
    });

    it('respects ALPHA_PREMIER_DB_PATH environment variable', () => {
      const origApg = process.env.APGBACKUP_DB_PATH;
      const origAlpha = process.env.ALPHA_PREMIER_DB_PATH;
      delete process.env.APGBACKUP_DB_PATH;
      process.env.ALPHA_PREMIER_DB_PATH = 'env/alpha.db';
      try {
        expect(resolveDatabasePath()).toBe('env/alpha.db');
      } finally {
        if (origApg !== undefined) process.env.APGBACKUP_DB_PATH = origApg;
        if (origAlpha !== undefined) {
          process.env.ALPHA_PREMIER_DB_PATH = origAlpha;
        } else {
          delete process.env.ALPHA_PREMIER_DB_PATH;
        }
      }
    });
  });

  describe('detectNamesFromApgbackup', () => {
    it('detects names from users table and filters admin cards', () => {
      const db = getVoiceboxDb(testDbPath);
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT UNIQUE NOT NULL,
          full_name TEXT NOT NULL,
          display_name TEXT,
          rfid_uid TEXT
        );
        INSERT OR REPLACE INTO users (user_id, full_name, display_name, rfid_uid) VALUES
          ('USR001', 'Deign Grey O. Lazaro', 'Deign Lazaro', 'AA:11'),
          ('USR002', 'Bea Alonzo', 'Bea', 'BB:22'),
          ('ADMIN_CARD_01', 'Admin Card 1', 'Admin', 'CC:33');
      `);

      const detected = detectNamesFromApgbackup(testDbPath);
      expect(detected).toHaveLength(2);

      const deign = detected.find((d) => d.employeeId === 'USR001');
      expect(deign).toBeDefined();
      expect(deign?.fullName).toBe('Deign Grey O. Lazaro');
      expect(deign?.firstName).toBe('Deign Grey O.');
      expect(deign?.lastName).toBe('Lazaro');
      expect(deign?.existingDisplayName).toBe('Deign Lazaro');

      const bea = detected.find((d) => d.employeeId === 'USR002');
      expect(bea).toBeDefined();
      expect(bea?.fullName).toBe('Bea Alonzo');
      expect(bea?.existingDisplayName).toBe('Bea');

      const admin = detected.find((d) => d.employeeId.includes('ADMIN_CARD'));
      expect(admin).toBeUndefined();
    });

    it('detects names from employees table with explicit first and last names', () => {
      const empDbPath = path.join(tempDir, 'employees-test.db');
      const db = new DatabaseSync(empDbPath);
      db.exec(`
        CREATE TABLE employees (
          employee_id TEXT PRIMARY KEY,
          first_name TEXT NOT NULL,
          last_name TEXT NOT NULL
        );
        INSERT INTO employees (employee_id, first_name, last_name) VALUES
          ('EMP101', 'Maria Clara', 'Santos'),
          ('ADMIN_CARD_VIP', 'Admin', 'VIP');
      `);
      db.close();

      const detected = detectNamesFromApgbackup(empDbPath);
      expect(detected).toHaveLength(1);
      expect(detected[0]).toEqual({
        employeeId: 'EMP101',
        fullName: 'Maria Clara Santos',
        firstName: 'Maria Clara',
        lastName: 'Santos',
        existingDisplayName: 'Maria Clara Santos',
      });
      closeAllVoiceboxDbs();
    });
  });

  describe('Pronunciations CRUD in voicebox-db', () => {
    it('creates and updates pronunciation overrides', () => {
      const created = upsertPronunciation(
        'USR002',
        {
          displayName: 'Bea',
          phoneticIpa: '/biː/',
          phoneticSimple: 'BEE',
          languageTag: 'en-PH',
          notes: 'Standard short name',
        },
        testDbPath
      );

      expect(created.employeeId).toBe('USR002');
      expect(created.displayName).toBe('Bea');
      expect(created.phoneticIpa).toBe('/biː/');
      expect(created.phoneticSimple).toBe('BEE');
      expect(created.languageTag).toBe('en-PH');
      expect(created.notes).toBe('Standard short name');

      const fetched = getPronunciationByEmployeeId('USR002', testDbPath);
      expect(fetched).toMatchObject({
        employeeId: 'USR002',
        phoneticIpa: '/biː/',
        phoneticSimple: 'BEE',
      });

      // Update pronunciation
      const updated = upsertPronunciation(
        'USR002',
        {
          phoneticIpa: '/ˈbeɪ.ə/',
        },
        testDbPath
      );
      expect(updated.phoneticIpa).toBe('/ˈbeɪ.ə/');
      expect(updated.displayName).toBe('Bea');
    });

    it('lists voicebox names joined with pronunciations', () => {
      const names = listVoiceboxNames(testDbPath);
      expect(names.length).toBeGreaterThanOrEqual(2);

      const bea = names.find((n) => n.employeeId === 'USR002');
      expect(bea).toBeDefined();
      expect(bea?.hasPronunciation).toBe(true);
      expect(bea?.phoneticIpa).toBe('/ˈbeɪ.ə/');

      const deign = names.find((n) => n.employeeId === 'USR001');
      expect(deign).toBeDefined();
      expect(deign?.hasPronunciation).toBe(false);
    });

    it('finds pronunciations by case-insensitive name matching', () => {
      const matches = findPronunciationsByName('bea', testDbPath);
      expect(matches.length).toBeGreaterThanOrEqual(1);
      expect(matches[0].displayName).toBe('Bea');

      const noMatches = findPronunciationsByName('NonExistentPerson', testDbPath);
      expect(noMatches).toHaveLength(0);
    });

    it('returns all pronunciations via getAllVoiceboxPronunciations', () => {
      const all = getAllVoiceboxPronunciations(testDbPath);
      expect(all.length).toBeGreaterThanOrEqual(2);
      const bea = all.find((p) => p.employeeId === 'USR002');
      expect(bea?.phoneticIpa).toBe('/ˈbeɪ.ə/');
    });
  });

  describe('Voicebox Router HTTP Endpoints', () => {
    let app: express.Express;

    beforeAll(() => {
      app = express();
      app.use(express.json());
      app.use(createVoiceboxRouter({ dbPath: testDbPath }));
    });

    it('GET /api/voicebox-names returns list of detected names and pronunciations', async () => {
      const res = await request(app).get('/api/voicebox-names').expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(2);
      expect(res.body[0]).toHaveProperty('employeeId');
      expect(res.body[0]).toHaveProperty('displayName');
      expect(res.body[0]).toHaveProperty('hasPronunciation');
    });

    it('GET /api/voicebox-names/:employeeId returns single employee details', async () => {
      const res = await request(app).get('/api/voicebox-names/USR002').expect(200);
      expect(res.body.employeeId).toBe('USR002');
      expect(res.body.displayName).toBe('Bea');
      expect(res.body.hasPronunciation).toBe(true);
    });

    it('GET /api/voicebox-names/:employeeId returns 404 for unknown employee', async () => {
      const res = await request(app).get('/api/voicebox-names/UNKNOWN_ID').expect(404);
      expect(res.body).toHaveProperty('error');
    });

    it('POST /api/voicebox-names/:employeeId/pronunciation updates pronunciation record', async () => {
      const res = await request(app)
        .post('/api/voicebox-names/USR001/pronunciation')
        .send({
          displayName: 'Deign',
          phoneticSimple: 'DAYN',
          phoneticIpa: '/deɪn/',
          languageTag: 'en-US',
          notes: 'Software engineer',
        })
        .expect(200);

      expect(res.body.employeeId).toBe('USR001');
      expect(res.body.displayName).toBe('Deign');
      expect(res.body.phoneticIpa).toBe('/deɪn/');
      expect(res.body.phoneticSimple).toBe('DAYN');
    });

    it('GET /api/voicebox/pronunciations returns all pronunciations', async () => {
      const res = await request(app).get('/api/voicebox/pronunciations').expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      const deign = res.body.find((item: { employeeId: string }) => item.employeeId === 'USR001');
      expect(deign).toBeDefined();
      expect(deign.phoneticIpa).toBe('/deɪn/');
    });

    it('GET /api/voicebox/pronunciation?name=Bea returns matching pronunciation item', async () => {
      const res = await request(app).get('/api/voicebox/pronunciation?name=Bea').expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
      expect(res.body[0].displayName).toBe('Bea');
    });

    it('GET /api/voicebox/ssml?name=Bea returns phoneme SSML with stripped slashes', async () => {
      const res = await request(app).get('/api/voicebox/ssml?name=Bea').expect(200);
      expect(res.headers['content-type']).toContain('application/xml');
      // Slashes must be stripped from IPA symbol
      expect(res.text).toBe('<speak><phoneme alphabet="ipa" ph="ˈbeɪ.ə">Bea</phoneme></speak>');
    });

    it('GET /api/voicebox/ssml?name=Unknown fallback returns basic speak tag', async () => {
      const res = await request(app).get('/api/voicebox/ssml?name=UnknownPerson').expect(200);
      expect(res.headers['content-type']).toContain('application/xml');
      expect(res.text).toBe('<speak>UnknownPerson</speak>');
    });

    it('enforces VOICEBOX_KEY authentication when configured in environment', async () => {
      const originalKey = process.env.VOICEBOX_KEY;
      process.env.VOICEBOX_KEY = 'super-secret-voicebox-key';

      try {
        // Without auth -> 401
        await request(app).get('/api/voicebox/pronunciations').expect(401);

        // With wrong header -> 401
        await request(app)
          .get('/api/voicebox/pronunciations')
          .set('x-voicebox-key', 'wrong-key')
          .expect(401);

        // With correct header -> 200
        const headerRes = await request(app)
          .get('/api/voicebox/pronunciations')
          .set('x-voicebox-key', 'super-secret-voicebox-key')
          .expect(200);
        expect(Array.isArray(headerRes.body)).toBe(true);

        // With correct query param -> 200
        const queryRes = await request(app)
          .get('/api/voicebox/pronunciations?voiceboxKey=super-secret-voicebox-key')
          .expect(200);
        expect(Array.isArray(queryRes.body)).toBe(true);
      } finally {
        if (originalKey !== undefined) {
          process.env.VOICEBOX_KEY = originalKey;
        } else {
          delete process.env.VOICEBOX_KEY;
        }
      }
    });
  });

  describe('Integration with createApp', () => {
    it('mounts voicebox routes directly in createApp options', async () => {
      const mainApp = createApp({
        sheets: new InMemorySheetsService(),
        voiceboxDbPath: testDbPath,
        config: {
          timezone: 'Asia/Manila',
          rfidAutoSubmitDelayMs: 500,
          resultResetDelayMs: 3000,
          scanCooldownMs: 10,
          rateLimitWindowMs: 60000,
          rateLimitMax: 100,
          port: 3001,
          corsOrigin: '*',
        },
      });

      const res = await request(mainApp).get('/api/voicebox-names').expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(2);
    });
  });
});
