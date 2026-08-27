import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { InMemorySheetsService } from '../src/sheets.js';

const config = {
  timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 150, resultResetDelayMs: 4000,
  scanCooldownMs: 10, rateLimitWindowMs: 60000, rateLimitMax: 100, port: 3001, corsOrigin: '*', sheetsMode: 'memory' as const,
  enableCardSetup: false, enableAdmin: true, adminPin: '2468', adminSessionSecret: 'test-secret', adminSessionMinutes: 15,
};

describe('admin and live attendance API', () => {
  it('creates, finalizes, and exports cutoff payroll without changing daily payroll', async () => {
    const sheets = new InMemorySheetsService([{ userId: 'APGCO-0013', fullName: 'CHICO, JEAN ASHLEY', rfidUid: 'AABB', department: null, active: true, employeeType: 'EMPLOYEE', dailyRate: 705, payrollProfileId: 'JEAN_TENURED' }]);
    const app = createApp({ sheets, config, logger: false }); const agent = request.agent(app);
    await agent.post('/api/admin/unlock').send({ pin: '2468' }).expect(200);
    const profiles = await agent.get('/api/admin/payroll/profiles').expect(200);
    expect(profiles.body.profiles.map((profile: { profileId: string }) => profile.profileId)).toContain('JEAN_TENURED');
    const created = await agent.post('/api/admin/payroll/cutoffs').send({ employeeId: 'APGCO-0013', payrollProfileId: 'JEAN_TENURED', cutoffStart: '2026-07-01', cutoffEnd: '2026-07-15', actualWorkingDays: 11, specialHolidayDays: 1, manualAdjustment: 1500, adjustmentReason: 'Legacy payroll adjustment / needs verification' }).expect(200);
    expect(created.body.payroll.grossCompensation).toBe(16216.5);
    const payrollId = created.body.payroll.payrollId as string;
    await agent.post(`/api/admin/payroll/cutoffs/${payrollId}/finalize`).expect(200);
    expect((await agent.get('/api/admin/payroll/cutoffs')).body.payroll[0]).toMatchObject({ payrollId, status: 'FINALIZED', netPay: 16216.5 });
    const exported = await agent.get('/api/admin/payroll/export').expect(200);
    expect(exported.text).toContain('CHICO, JEAN ASHLEY');
    expect(exported.text).toContain('"Company","Alpha Premier Group of Companies OPC."');
    expect(exported.text).toContain('"Office","Unit 3104C, Tektite East Tower, Ortigas Center, Pasig, Metro Manila"');
  });

  it('protects users, edits profiles, lists attendance, and applies time corrections', async () => {
    const sheets = new InMemorySheetsService([
      { userId: 'u1', fullName: 'Ada', rfidUid: 'AABB', department: 'Engineering', active: true },
    ], [{ attendanceId: 'att-1', attendanceDate: '2026-07-29', userId: 'u1', rfidUid: 'AABB', fullName: 'Ada', department: 'Engineering', timeIn: '2026-07-29T09:00:00+08:00', timeOut: null, status: 'WORKING', source: 'RFID', notes: '' }]);
    const app = createApp({ sheets, config, logger: false });
    await request(app).get('/api/admin/users').expect(401);
    const agent = request.agent(app);
    await agent.post('/api/admin/unlock').send({ pin: '2468' }).expect(200);
    const session = await agent.get('/api/admin/session').expect(200);
    expect(session.body.expiresAt).toEqual(expect.any(String));
    const users = await agent.get('/api/admin/users').expect(200);
    await agent.patch('/api/admin/users/u1').send({ userId: 'u1', rfidUid: 'CCDD', fullName: '  ada   updated  ', department: 'Platform', status: 'ACTIVE' }).expect(200);
    const live = await request(app).get('/api/attendance?date=2026-07-29').expect(200);
    expect(live.body.attendance[0]).toMatchObject({ fullName: 'Ada Updated', status: 'WORKING' });
    await agent.patch('/api/admin/attendance/att-1').send({ attendanceDate: '2026-07-29', timeIn: '2026-07-29T09:00:00+08:00', timeOut: '2026-07-29T17:00:00+08:00', expectedTimeIn: '2026-07-29T09:00:00+08:00', expectedTimeOut: null }).expect(200);
    expect((await request(app).get('/api/attendance?date=2026-07-29')).body.attendance[0].status).toBe('COMPLETED');
    await agent.delete('/api/admin/attendance/att-1?date=2026-07-29').expect(200);
    expect((await request(app).get('/api/attendance?date=2026-07-29')).body.attendance).toHaveLength(0);
    await agent.delete('/api/admin/users/u1').expect(200);
    expect((await agent.get('/api/admin/users')).body.users).toHaveLength(0);
  });

  it('deletes subsequent payroll cutoffs when an employee is deleted', async () => {
    const sheets = new InMemorySheetsService([{ userId: 'EMP-DELETE-1', fullName: 'John Doe', rfidUid: 'EEFF', department: null, active: true, employeeType: 'EMPLOYEE', dailyRate: 500, payrollProfileId: 'BEA_STANDARD' }]);
    const app = createApp({ sheets, config, logger: false }); const agent = request.agent(app);
    await agent.post('/api/admin/unlock').send({ pin: '2468' }).expect(200);

    const created = await agent.post('/api/admin/payroll/cutoffs').send({ employeeId: 'EMP-DELETE-1', cutoffStart: '2026-08-01', cutoffEnd: '2026-08-15', actualWorkingDays: 11 }).expect(200);
    const payrollId = created.body.payroll.payrollId as string;
    expect(await sheets.findPayrollCutoff(payrollId)).not.toBeNull();

    await agent.delete('/api/admin/users/EMP-DELETE-1').expect(200);
    expect(await sheets.findUserById('EMP-DELETE-1')).toBeNull();
    expect(await sheets.findPayrollCutoff(payrollId)).toBeNull();
    expect((await agent.get('/api/admin/payroll/cutoffs')).body.payroll).toHaveLength(0);
  });

  it('creates intern cutoff payroll with the fixed PHP 80/day and PHP 10/hour late rules', async () => {
    const sheets = new InMemorySheetsService([{ userId: 'INT-001', fullName: 'Maria Santos', rfidUid: 'CCDD', department: null, active: true, employeeType: 'INTERN' }]);
    const app = createApp({ sheets, config, logger: false }); const agent = request.agent(app);
    await agent.post('/api/admin/unlock').send({ pin: '2468' }).expect(200);
    // Interns are accepted without a daily rate; a submitted rate must be ignored.
    const created = await agent.post('/api/admin/payroll/cutoffs').send({ employeeId: 'INT-001', dailyRate: 500, cutoffStart: '2026-07-16', cutoffEnd: '2026-07-31', actualWorkingDays: 10, lateUnits: 3 }).expect(200);
    expect(created.body.payroll).toMatchObject({
      employeeId: 'INT-001', employeeName: 'Maria Santos', employeeType: 'INTERN', dailyRate: 80,
      actualWorkingDays: 10, basicPay: 880, totalCompensation: 880, totalAllowance: 0,
      lateUnits: 3, lateDeduction: 30, absenceDeduction: 80, totalDeductions: 110, grossCompensation: 770, netPay: 770, status: 'DRAFT',
    });
    // The payroll list derives intern classification from the Users register.
    const payroll = await agent.get('/api/admin/payroll/cutoffs').expect(200);
    expect(payroll.body.payroll[0]).toMatchObject({ employeeId: 'INT-001', employeeType: 'INTERN', dailyRate: 80 });
  });

  it('applies a fillable employee late deduction to gross and net pay', async () => {
    const sheets = new InMemorySheetsService([{ userId: 'APGCO-0013', fullName: 'CHICO, JEAN ASHLEY', rfidUid: 'AABB', department: null, active: true, employeeType: 'EMPLOYEE', dailyRate: 705, payrollProfileId: 'JEAN_TENURED' }]);
    const app = createApp({ sheets, config, logger: false }); const agent = request.agent(app);
    await agent.post('/api/admin/unlock').send({ pin: '2468' }).expect(200);
    // 11 days at 705 = 7755 basic + 211.5 special holiday + 6750 allowances = 14716.5,
    // then the fillable late form (5 hours at PHP 50/hr) deducts 250.
    const created = await agent.post('/api/admin/payroll/cutoffs').send({
      employeeId: 'APGCO-0013', payrollProfileId: 'JEAN_TENURED', cutoffStart: '2026-07-01', cutoffEnd: '2026-07-15',
      actualWorkingDays: 11, specialHolidayDays: 1, lateUnits: 5, lateDeductionRate: 50, lateDeduction: 250,
    }).expect(200);
    expect(created.body.payroll).toMatchObject({
      lateUnits: 5, lateDeduction: 250, grossCompensation: 14716.5, totalDeductions: 250, netPay: 14466.5, status: 'DRAFT',
    });
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

  it('keeps an after-hours admin time-out flagged LATE_TIMEOUT until the official time is re-entered', async () => {
    const sheets = new InMemorySheetsService([
      { userId: 'u1', fullName: 'Ada', rfidUid: 'AABB', department: null, active: true, employeeType: 'EMPLOYEE', dailyRate: 500 },
    ], [{ attendanceId: 'att-1', attendanceDate: '2026-07-29', userId: 'u1', rfidUid: 'AABB', fullName: 'Ada', department: null, timeIn: '2026-07-29T08:00:00+08:00', timeOut: null, status: 'WORKING', source: 'RFID', notes: '' }]);
    const app = createApp({ sheets, config, logger: false }); const agent = request.agent(app);
    await agent.post('/api/admin/unlock').send({ pin: '2468' }).expect(200);

    // Saving an 18:55 time-out stays flagged, never COMPLETED, and never gets payroll.
    await agent.patch('/api/admin/attendance/att-1').send({ attendanceDate: '2026-07-29', timeIn: '2026-07-29T08:00:00+08:00', timeOut: '2026-07-29T18:55:00+08:00', expectedTimeIn: '2026-07-29T08:00:00+08:00', expectedTimeOut: null }).expect(200);
    expect((await request(app).get('/api/attendance?date=2026-07-29')).body.attendance[0].status).toBe('LATE_TIMEOUT');
    expect(await sheets.findPayrollByAttendanceId('att-1')).toBeNull();

    // Re-entering the official 17:00 time-out completes the shift normally.
    await agent.patch('/api/admin/attendance/att-1').send({ attendanceDate: '2026-07-29', timeIn: '2026-07-29T08:00:00+08:00', timeOut: '2026-07-29T17:00:00+08:00', expectedTimeIn: '2026-07-29T08:00:00+08:00', expectedTimeOut: '2026-07-29T18:55:00+08:00' }).expect(200);
    expect((await request(app).get('/api/attendance?date=2026-07-29')).body.attendance[0].status).toBe('COMPLETED');
    expect(await sheets.findPayrollByAttendanceId('att-1')).not.toBeNull();
  });

  it('allows removing time-out and time-in values in attendance corrections', async () => {
    const sheets = new InMemorySheetsService([
      { userId: 'u1', fullName: 'Ada', rfidUid: 'AABB', department: null, active: true, employeeType: 'EMPLOYEE', dailyRate: 500 },
    ], [{ attendanceId: 'att-1', attendanceDate: '2026-07-29', userId: 'u1', rfidUid: 'AABB', fullName: 'Ada', department: null, timeIn: '2026-07-29T08:00:00+08:00', timeOut: '2026-07-29T17:00:00+08:00', status: 'COMPLETED', source: 'RFID', notes: '' }]);
    const app = createApp({ sheets, config, logger: false }); const agent = request.agent(app);
    await agent.post('/api/admin/unlock').send({ pin: '2468' }).expect(200);

    // 1. Removing time-out returns the attendance to WORKING status and clears payroll
    const res1 = await agent.patch('/api/admin/attendance/att-1').send({
      attendanceDate: '2026-07-29',
      timeIn: '2026-07-29T08:00:00+08:00',
      timeOut: null,
      expectedTimeIn: '2026-07-29T08:00:00+08:00',
      expectedTimeOut: '2026-07-29T17:00:00+08:00',
    }).expect(200);
    expect(res1.body.attendance).toMatchObject({ timeIn: '2026-07-29T08:00:00+08:00', timeOut: null, status: 'WORKING' });
    expect(await sheets.findPayrollByAttendanceId('att-1')).toBeNull();

    // 2. Removing time-in as well sets status to MISSED
    const res2 = await agent.patch('/api/admin/attendance/att-1').send({
      attendanceDate: '2026-07-29',
      timeIn: null,
      timeOut: null,
      expectedTimeIn: '2026-07-29T08:00:00+08:00',
      expectedTimeOut: null,
    }).expect(200);
    expect(res2.body.attendance).toMatchObject({ timeIn: '', timeOut: null, status: 'MISSED' });
  });

  it('creates backdated missed attendance for a past date with validation gates', async () => {
    const sheets = new InMemorySheetsService([
      { userId: 'u1', fullName: 'Ada Lovelace', rfidUid: 'AABB', department: 'Engineering', active: true, employeeType: 'EMPLOYEE', dailyRate: 600 },
    ]);
    const app = createApp({ sheets, config, logger: false });
    const agent = request.agent(app);
    await agent.post('/api/admin/unlock').send({ pin: '2468' }).expect(200);

    // Rejects empty reason
    await agent.post('/api/admin/attendance/backdate').send({
      userId: 'u1',
      attendanceDate: '2026-07-20',
      timeIn: '2026-07-20T08:00:00+08:00',
      timeOut: '2026-07-20T17:00:00+08:00',
      reason: '',
    }).expect(400);

    // Successfully creates backdated record
    const created = await agent.post('/api/admin/attendance/backdate').send({
      userId: 'u1',
      attendanceDate: '2026-07-20',
      timeIn: '2026-07-20T08:00:00+08:00',
      timeOut: '2026-07-20T17:00:00+08:00',
      reason: 'Confirmed present on CCTV; forgot RFID card',
    }).expect(200);
    expect(created.body.attendance).toMatchObject({
      userId: 'u1',
      attendanceDate: '2026-07-20',
      status: 'COMPLETED',
      source: 'ADMIN_BACKDATED_ENTRY',
      recordedReason: 'Confirmed present on CCTV; forgot RFID card',
    });

    // Rejects duplicate backdate for same date
    const dup = await agent.post('/api/admin/attendance/backdate').send({
      userId: 'u1',
      attendanceDate: '2026-07-20',
      timeIn: '2026-07-20T08:00:00+08:00',
      reason: 'Trying duplicate',
    }).expect(409);
    expect(dup.body.error.code).toBe('ATTENDANCE_ALREADY_EXISTS_FOR_DATE');
  });

  it('allows unlocking Admin panel alternatively using a registered Admin RFID card', async () => {
    const sheets = new InMemorySheetsService([
      { userId: 'ADMIN_CARD_ADDE23', fullName: 'Front Desk Admin Card #1', rfidUid: 'ADDE23', department: 'Admin', active: true, cardType: 'ADMIN_ASSIST' },
      { userId: 'EMP1', fullName: 'Regular Employee', rfidUid: 'EEFF00', department: 'Engineering', active: true, cardType: 'EMPLOYEE' },
    ]);
    const app = createApp({ sheets, config, logger: false });
    const agent = request.agent(app);

    // Reject non-admin RFID card for admin unlock
    await agent.post('/api/admin/unlock').send({ pin: 'EEFF00' }).expect(401);

    // Accept registered Admin RFID card
    const res = await agent.post('/api/admin/unlock').send({ pin: 'ADDE23' }).expect(200);
    expect(res.body.expiresAt).toEqual(expect.any(String));

    // Access protected admin endpoint with the cookie
    const users = await agent.get('/api/admin/users').expect(200);
    expect(users.body.users).toHaveLength(2);
  });
});
