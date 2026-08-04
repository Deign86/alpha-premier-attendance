import { describe, expect, it } from 'vitest';
import type { AttendanceListItem, LanAttendanceEvent, LanAttendanceSnapshotResponse } from './api-contracts.js';

const row: AttendanceListItem = {
  attendanceId: 'a1', attendanceDate: '2026-07-31', userId: 'u1', fullName: 'Ada', department: null,
  timeIn: '2026-07-31T08:00:00+08:00', timeOut: null, status: 'WORKING',
};

describe('LAN contracts', () => {
  it('models a snapshot with the shared attendance row shape', () => {
    const snapshot: LanAttendanceSnapshotResponse = { success: true, serverInstanceId: 's1', snapshotVersion: 1, date: row.attendanceDate, attendance: [row], fetchedAt: row.timeIn };
    expect(snapshot.attendance[0]).toEqual(row);
  });

  it('models typed attendance and stale events', () => {
    const events: LanAttendanceEvent[] = [
      { type: 'attendance-updated', eventId: 's1:1', serverInstanceId: 's1', sequence: 1, occurredAt: row.timeIn, requestId: 'r1', attendanceDate: row.attendanceDate, attendanceId: row.attendanceId, cause: 'TIME_IN', mutation: 'upsert', attendance: row },
      { type: 'stale-data', eventId: 's1:2', serverInstanceId: 's1', sequence: 2, occurredAt: row.timeIn, reason: 'event-gap', shouldRefetch: true },
    ];
    expect(events).toHaveLength(2);
  });
});
