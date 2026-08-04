import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { InMemorySheetsService } from '../src/sheets.js';

describe('HTTP API', () => {
  it('serves safe config and accepts a scan', async () => {
    const app = createApp({
      sheets: new InMemorySheetsService([{ userId: 'u1', fullName: 'Ada', rfidUid: 'AABB', department: null, active: true }]),
      config: {
        timezone: 'Asia/Manila',
        rfidAutoSubmitDelayMs: 500,
        enableScanSounds: true,
        resultResetDelayMs: 3000,
        scanCooldownMs: 10,
        rateLimitWindowMs: 60000,
        rateLimitMax: 100,
        port: 3001,
        corsOrigin: '*',
      },
    });
    const config = await request(app).get('/api/config').expect(200);
    expect(config.body.timezone).toBe('Asia/Manila');
    expect(config.body.office).toMatchObject({
      companyName: 'Alpha Premier',
      officeAddressLine1: 'Unit 3104C',
      officeBuilding: 'Tektite East Tower',
      officeCity: 'Pasig',
      officeRegion: 'Metro Manila',
      officeDisplayShort: 'Tektite East Tower, Ortigas Center, Pasig',
      officeDisplayFull: 'Unit 3104C, Tektite East Tower, Ortigas Center, Pasig, Metro Manila',
    });
    const scan = await request(app).post('/api/scan').send({ rfidUid: 'aa:bb', source: 'RFID' }).expect(200);
    expect(scan.body.success).toBe(true);
    expect(scan.body.action).toBe('TIME_IN');
  });

  it('returns typed validation errors', async () => {
    const app = createApp({ sheets: new InMemorySheetsService(), config: { timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 500, enableScanSounds: true, resultResetDelayMs: 3000, scanCooldownMs: 10, rateLimitWindowMs: 60000, rateLimitMax: 100, port: 3001, corsOrigin: '*' } });
    const response = await request(app).post('/api/scan').send({ rfidUid: '', source: 'RFID' }).expect(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('INVALID_SCAN_INPUT');
    expect(response.body.requestId).toBeTypeOf('string');
  });
});
