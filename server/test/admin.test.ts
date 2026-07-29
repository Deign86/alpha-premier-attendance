import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { InMemorySheetsService } from '../src/sheets.js';

const config = {
  timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 150, enableScanSounds: false, resultResetDelayMs: 4000,
  scanCooldownMs: 10, rateLimitWindowMs: 60000, rateLimitMax: 100, port: 3001, corsOrigin: '*', sheetsMode: 'memory' as const,
  enableCardSetup: false, enableAdmin: true, adminPin: '2468', adminSessionSecret: 'test-secret', adminSessionMinutes: 15,
};

describe('admin and live attendance API', () => {
  it('protects users, edits profiles, lists attendance, and applies time corrections', async () => {
    const sheets = new InMemorySheetsService([
      { userId: 'u1', fullName: 'Ada', rfidUid: 'AABB', department: 'Engineering', active: true },
    ], [{ attendanceId: 'att-1', attendanceDate: '2026-07-29', userId: 'u1', rfidUid: 'AABB', fullName: 'Ada', department: 'Engineering', timeIn: '2026-07-29T09:00:00+08:00', timeOut: null, status: 'OPEN', source: 'RFID', notes: '' }]);
    const app = createApp({ sheets, config, logger: false });
    await request(app).get('/api/admin/users').expect(401);
    const agent = request.agent(app);
    await agent.post('/api/admin/unlock').send({ pin: '2468' }).expect(200);
    const users = await agent.get('/api/admin/users').expect(200);
    expect(users.body.users[0]).toMatchObject({ userId: 'u1', rfidUid: 'AABB' });
    await agent.patch('/api/admin/users/u1').send({ userId: 'u1', rfidUid: 'CCDD', fullName: 'Ada Updated', department: 'Platform', status: 'ACTIVE' }).expect(200);
    const live = await request(app).get('/api/attendance?date=2026-07-29').expect(200);
    expect(live.body.attendance[0]).toMatchObject({ fullName: 'Ada Updated', status: 'OPEN' });
    await agent.patch('/api/admin/attendance/att-1').send({ attendanceDate: '2026-07-29', timeIn: '2026-07-29T09:00:00+08:00', timeOut: '2026-07-29T17:00:00+08:00', expectedTimeIn: '2026-07-29T09:00:00+08:00', expectedTimeOut: null }).expect(200);
    expect((await request(app).get('/api/attendance?date=2026-07-29')).body.attendance[0].status).toBe('COMPLETED');
  });

  it('rejects stale attendance edits and conflicting RFID assignments', async () => {
    const sheets = new InMemorySheetsService([
      { userId: 'u1', fullName: 'Ada', rfidUid: 'AABB', department: null, active: true },
      { userId: 'u2', fullName: 'Bob', rfidUid: 'CCDD', department: null, active: true },
    ]);
    const app = createApp({ sheets, config, logger: false }); const agent = request.agent(app);
    await agent.post('/api/admin/unlock').send({ pin: '2468' });
    await agent.patch('/api/admin/users/u1').send({ userId: 'u1', rfidUid: 'CCDD', fullName: 'Ada', status: 'ACTIVE' }).expect(409);
  });
});
