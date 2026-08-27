import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { SetupService } from '../src/setup.js';
import { InMemorySheetsService } from '../src/sheets.js';

const setupConfig = { enableCardSetup: true, setupAdminPin: '2468', setupSessionMinutes: 1 };
const appConfig = {
  timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 150, resultResetDelayMs: 4000,
  scanCooldownMs: 10000, rateLimitWindowMs: 60000, rateLimitMax: 100, port: 3001, corsOrigin: '*',
  sheetsMode: 'memory' as const, ...setupConfig,
};

describe('card setup service', () => {
  it('uses a constant-time PIN check and expires setup tokens', async () => {
    let now = new Date('2026-07-29T00:00:00Z');
    const service = new SetupService(new InMemorySheetsService(), setupConfig, () => now);
    await expect(service.unlock('wrong')).rejects.toThrow('invalid');
    const token = (await service.unlock('2468')).setupToken;
    now = new Date('2026-07-29T00:02:00Z');
    await expect(service.lookupCard(token, 'AABB')).rejects.toThrow('expired');
    await expect(service.lookupCard('invalid', 'AABB')).rejects.toThrow('invalid');
  });

  it('looks up unknown cards and upserts a new user without attendance writes', async () => {
    const sheets = new InMemorySheetsService();
    const service = new SetupService(sheets, setupConfig);
    const token = (await service.unlock('2468')).setupToken;
    await expect(service.lookupCard(token, 'AABB')).resolves.toMatchObject({ rfidUid: 'AABB', user: null });
    await expect(service.upsertUser(token, { userId: 'u1', fullName: 'Ada', rfidUid: 'AA-BB', department: 'Engineering', status: 'ACTIVE' })).resolves.toMatchObject({ created: true, user: { userId: 'U1', rfidUid: 'AABB' } });
    await expect(service.lookupCard(token, 'AABB')).resolves.toMatchObject({ rfidUid: 'AABB', user: { userId: 'U1' } });
    expect(await sheets.findAttendance('U1', '2026-07-29')).toBeNull();
  });

  it('rejects duplicate card assignment', async () => {
    const sheets = new InMemorySheetsService([{ userId: 'u1', fullName: 'Ada', rfidUid: 'AABB', department: null, active: true }]);
    const service = new SetupService(sheets, setupConfig);
    const token = (await service.unlock('2468')).setupToken;
    await expect(service.upsertUser(token, { userId: 'u2', fullName: 'Bob', rfidUid: 'AABB', status: 'ACTIVE' })).rejects.toMatchObject({ code: 'USER_CONFLICT' });
  });

  it('normalizes and capitalizes user full name during setup upsert', async () => {
    const sheets = new InMemorySheetsService();
    const service = new SetupService(sheets, setupConfig);
    const token = (await service.unlock('2468')).setupToken;
    const result = await service.upsertUser(token, {
      userId: 'u-norm-1',
      fullName: '  john   doe  ',
      rfidUid: 'CCDD',
      status: 'ACTIVE',
    });
    expect(result.user.fullName).toBe('John Doe');
    expect(result.user.userId).toBe('U-NORM-1');
  });

  it('registers an Admin RFID card without requiring an employee name', async () => {
    const sheets = new InMemorySheetsService();
    const service = new SetupService(sheets, setupConfig);
    const token = (await service.unlock('2468')).setupToken;
    const result = await service.upsertUser(token, {
      rfidUid: 'AD-DE-23',
      cardType: 'ADMIN_ASSIST',
      label: 'Front desk admin card #1',
      status: 'ACTIVE',
    });
    expect(result.user.cardType).toBe('ADMIN_ASSIST');
    expect(result.user.rfidUid).toBe('ADDE23');
    expect(result.user.fullName).toBe('Front Desk Admin Card #1');
    expect(result.user.userId).toBe('ADMIN_CARD_ADDE23');
  });

  it('allows unlocking setup alternatively using a registered Admin RFID card', async () => {
    const sheets = new InMemorySheetsService([
      { userId: 'ADMIN_CARD_ADDE23', fullName: 'Front Desk Admin Card #1', rfidUid: 'ADDE23', department: 'Admin', active: true, cardType: 'ADMIN_ASSIST' },
      { userId: 'EMP1', fullName: 'Regular Employee', rfidUid: 'EEFF00', department: 'Engineering', active: true, cardType: 'EMPLOYEE' },
    ]);
    const service = new SetupService(sheets, setupConfig);
    // Unlocking with registered ADMIN_ASSIST card RFID UID succeeds
    const unlockResult = await service.unlock('ADDE23');
    expect(unlockResult.setupToken).toBeDefined();

    // Regular employee RFID is rejected for setup unlock
    await expect(service.unlock('EEFF00')).rejects.toThrow('invalid');
  });
});

describe('card setup HTTP API', () => {
  it('protects unlock, lookup and upsert endpoints and supports Admin RFID unlock', async () => {
    const sheets = new InMemorySheetsService([
      { userId: 'ADMIN_CARD_ADDE23', fullName: 'Front Desk Admin Card #1', rfidUid: 'ADDE23', department: 'Admin', active: true, cardType: 'ADMIN_ASSIST' },
    ]);
    const app = createApp({ sheets, config: appConfig, logger: false });
    await request(app).get('/api/setup/card/AABB').expect(401);
    
    // Unlock with Admin RFID
    const rfidUnlock = await request(app).post('/api/setup/unlock').send({ rfidUid: 'ADDE23' }).expect(200);
    expect(rfidUnlock.body.setupToken).toBeDefined();

    // Unlock with PIN also works
    const unlock = await request(app).post('/api/setup/unlock').send({ pin: '2468' }).expect(200);
    const token = unlock.body.setupToken as string;
    const lookup = await request(app).get('/api/setup/card/AABB').set('Authorization', `Bearer ${token}`).expect(200);
    expect(lookup.body.user).toBeNull();
    await request(app).post('/api/setup/users').set('x-setup-token', token).send({ userId: 'u1', fullName: 'Ada', rfidUid: 'AABB', status: 'ACTIVE' }).expect(200);
    await request(app).post('/api/attendance/scan').send({ rfidUid: 'AABB', source: 'RFID' }).expect(200);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
    expect((await sheets.findAttendance('U1', today))?.userId).toBe('U1');
  });
});
