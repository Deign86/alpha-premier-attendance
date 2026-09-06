import { describe, expect, it } from 'vitest';
import { InMemorySheetsService } from '../src/sheets.js';

/**
 * Pins the InMemorySheetsService lookup contract after the O(n) scans were
 * replaced by bucketed key indexes: identical results, identical duplicate
 * errors, and indexes that stay in sync across upserts and deletes.
 */
describe('InMemorySheetsService indexes', () => {
  it('still reports duplicate RFID UIDs seeded before the lookup', async () => {
    const sheets = new InMemorySheetsService([
      { userId: 'u1', fullName: 'Ada Lovelace', rfidUid: 'AABBCC11', department: 'Eng', active: true },
      { userId: 'u2', fullName: 'Alan Turing', rfidUid: 'aa-bb-cc-11', department: 'Eng', active: true },
    ]);
    await expect(sheets.findUserByUid('AABBCC11')).rejects.toThrow('Duplicate RFID UID in Users sheet');
  });

  it('rekeys the uid index when upsertUser changes a card', async () => {
    const sheets = new InMemorySheetsService([
      { userId: 'u1', fullName: 'Ada Lovelace', rfidUid: 'AABBCC11', department: 'Eng', active: true },
    ]);
    await sheets.upsertUser({ userId: 'u1', fullName: 'Ada Lovelace', rfidUid: 'DDEEFF22', department: 'Eng', active: true });
    expect(await sheets.findUserByUid('AABBCC11')).toBeNull();
    expect((await sheets.findUserByUid('DDEEFF22'))?.userId).toBe('u1');
  });

  it('rejects a card already held by another user even in non-normalized form', async () => {
    const sheets = new InMemorySheetsService([
      { userId: 'u1', fullName: 'Ada Lovelace', rfidUid: 'AABBCC11', department: 'Eng', active: true },
    ]);
    await expect(
      sheets.upsertUser({ userId: 'u2', fullName: 'Alan Turing', rfidUid: 'aa-bb-cc-11', department: 'Eng', active: true }),
    ).rejects.toThrow('Duplicate RFID UID in Users sheet');
  });

  it('drops index entries on delete so ids and uids are reusable', async () => {
    const sheets = new InMemorySheetsService([
      { userId: 'u1', fullName: 'Ada Lovelace', rfidUid: 'AABBCC11', department: 'Eng', active: true },
    ]);
    await sheets.deleteUser('u1');
    expect(await sheets.findUserById('u1')).toBeNull();
    expect(await sheets.findUserByUid('AABBCC11')).toBeNull();
    await sheets.upsertUser({ userId: 'u1', fullName: 'Ada Lovelace', rfidUid: 'AABBCC11', department: 'Eng', active: true });
    expect((await sheets.findUserById('u1'))?.fullName).toBe('Ada Lovelace');
  });

  it('keeps attendance find/create/delete consistent through the indexes', async () => {
    const sheets = new InMemorySheetsService([
      { userId: 'u1', fullName: 'Ada Lovelace', rfidUid: 'AABBCC11', department: 'Eng', active: true },
    ]);
    const row = {
      attendanceId: 'att1', attendanceDate: '2026-07-28', userId: 'u1', rfidUid: 'AABBCC11',
      fullName: 'Ada Lovelace', department: 'Eng', timeIn: '2026-07-28T08:00:00+08:00',
      timeOut: null, status: 'WORKING' as const, source: 'RFID' as const, notes: '',
    };
    await sheets.createAttendance(row);
    expect((await sheets.findAttendance('u1', '2026-07-28'))?.attendanceId).toBe('att1');
    await sheets.deleteAttendance('att1', '2026-07-28');
    expect(await sheets.findAttendance('u1', '2026-07-28')).toBeNull();
  });
});
