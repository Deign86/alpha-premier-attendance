import { describe, expect, it } from 'vitest';
import type { sheets_v4 } from 'googleapis';
import { AttendanceService } from '../src/attendance.js';
import { GoogleSheetsAdapter } from '../src/sheets.js';

/**
 * Regression test for the "long loading on rescan (time-out)" bug.
 *
 * The TIME_OUT scan used to perform 9-13 sequential Google Sheets API
 * round-trips inline (full-sheet reads + redundant reconcile re-reads +
 * header-only fetches). This test instruments the adapter with a fake
 * `sheets_v4.Sheets` API and locks the round-trip budget:
 *   - total API calls <= 10
 *   - at most ONE full-sheet 'Attendance' GET (the initial lookup)
 * The row-targeted optimistic check must be used instead of a second full
 * sheet read, and payroll/grace lookups must run in parallel.
 */

const USERS_HEADERS = ['userid', 'rfiduid', 'fullname', 'department', 'status', 'createdat', 'employeetype', 'dailyrate', 'photourl'];
const ATTENDANCE_HEADERS = ['attendanceid', 'attendancedate', 'userid', 'rfiduid', 'fullname', 'department', 'timein', 'timeout', 'status', 'source', 'notes'];
const PAYROLL_HEADERS = ['payrollid', 'attendanceid', 'userid', 'fullname', 'employeetype', 'attendancedate', 'actualtimein', 'actualtimeout', 'computedtimein', 'computedtimeout', 'graceused', 'latehours', 'latededuction', 'basepay', 'dailypay', 'notes'];
const GRACE_HEADERS = ['graceid', 'userid', 'weekstart', 'attendanceid', 'usedat'];
const AUDIT_HEADERS = ['logid', 'timestamp', 'eventtype', 'rfiduid', 'userid', 'message', 'requestid'];

const config = { timezone: 'Asia/Manila', scanCooldownMs: 1000 };

function fakeSheetsApi() {
  const calls: Array<{ op: 'get' | 'update' | 'append'; range: string }> = [];
  const values = {
    get: async ({ range }: { range: string }) => {
      calls.push({ op: 'get', range });
      return { data: { values: SHEET_DATA[range] ?? [] } };
    },
    update: async ({ range }: { range: string }) => {
      calls.push({ op: 'update', range });
      return { data: {} };
    },
    append: async ({ range }: { range: string }) => {
      calls.push({ op: 'append', range });
      return { data: {} };
    },
  };
  const api = { spreadsheets: { values } };
  return { api: api as unknown as sheets_v4.Sheets, calls };
}

const SHEET_DATA: Record<string, string[][]> = {
  Users: [
    USERS_HEADERS,
    // userId, rfidUid, fullName, department, status, createdAt, employeeType, dailyRate, photoUrl
    ['u1', 'AABBCC11', 'Test User', 'Eng', 'ACTIVE', '2026-01-01T00:00:00+08:00', 'INTERN', '', ''],
  ],
  Attendance: [
    ATTENDANCE_HEADERS,
    // attendanceId, attendanceDate, userId, rfidUid, fullName, department, timeIn, timeOut, status, source, notes
    ['att1', '2026-07-28', 'u1', 'AABBCC11', 'Test User', 'Eng', '2026-07-28T07:50:00+08:00', '', 'OPEN', 'RFID', ''],
  ],
  // Row-targeted optimistic check: single data row at row 2, columns A..K (11 headers).
  'Attendance!A2:K2': [
    ['att1', '2026-07-28', 'u1', 'AABBCC11', 'Test User', 'Eng', '2026-07-28T07:50:00+08:00', '', 'OPEN', 'RFID', ''],
  ],
  Payroll: [PAYROLL_HEADERS],
  InternGrace: [GRACE_HEADERS],
  AuditLogs: [AUDIT_HEADERS],
};

describe('GoogleSheetsAdapter scan round-trips', () => {
  it('completes a TIME_OUT rescan within the round-trip budget', async () => {
    const { api, calls } = fakeSheetsApi();
    const adapter = new GoogleSheetsAdapter({ spreadsheetId: 's1' }, api);
    const service = new AttendanceService(adapter, config, () => new Date('2026-07-28T01:30:00.000Z'));

    const result = await service.scan({ rfidUid: 'AABBCC11', source: 'RFID' }, 'r1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.action).toBe('TIME_OUT');
      expect(result.attendance.status).toBe('COMPLETED');
    }

    // Let fire-and-forget audit writes settle so the count is deterministic.
    await new Promise((resolve) => setTimeout(resolve, 25));

    const fullAttendanceGets = calls.filter((call) => call.op === 'get' && call.range === 'Attendance');
    expect(calls.length).toBeLessThanOrEqual(10);
    expect(fullAttendanceGets.length).toBeLessThanOrEqual(1);
  });
});
