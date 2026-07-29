import { describe, expect, it } from 'vitest';
import { AttendanceService } from '../src/attendance.js';
import { InMemorySheetsService } from '../src/sheets.js';

const config = {
  timezone: 'Asia/Manila',
  scanCooldownMs: 1000,
};

describe('AttendanceService', () => {
  it('times in then times out an active user', async () => {
    const sheets = new InMemorySheetsService([
      { userId: 'u1', fullName: 'Ada Lovelace', rfidUid: 'AABBCC11', department: 'Engineering', active: true },
    ]);
    const service = new AttendanceService(sheets, config, () => new Date('2026-07-28T01:00:00.000Z'));
    const inResult = await service.scan({ rfidUid: 'aa-bb-cc-11', source: 'RFID' }, 'r1');
    expect(inResult.success).toBe(true);
    if (inResult.success) expect(inResult.action).toBe('TIME_IN');
    service.setNowProvider(() => new Date('2026-07-28T02:00:00.000Z'));
    const outResult = await service.scan({ rfidUid: 'AABBCC11', source: 'RFID' }, 'r2');
    expect(outResult.success).toBe(true);
    if (outResult.success) {
      expect(outResult.action).toBe('TIME_OUT');
      expect(outResult.attendance.status).toBe('COMPLETED');
    }
  });

  it('returns duplicate during cooldown', async () => {
    const sheets = new InMemorySheetsService([
      { userId: 'u1', fullName: 'Ada', rfidUid: 'AABB', department: null, active: true },
    ]);
    const service = new AttendanceService(sheets, config);
    await service.scan({ rfidUid: 'aabb', source: 'RFID' }, 'r1');
    const result = await service.scan({ rfidUid: 'AABB', source: 'RFID' }, 'r2');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('DUPLICATE_SCAN');
  });
});
