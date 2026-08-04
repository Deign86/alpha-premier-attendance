import crypto from 'node:crypto';
import type { AdminUser, AttendanceListItem, PayrollCalculationProfile, PayrollCutoffRecord } from '@rfid-attendance/shared';
import { INTERN_DAILY_RATE_PHP, INTERN_LATE_DEDUCTION_PER_HOUR_PHP, INTERN_PAYROLL_PROFILE_ID, isLateTimeout } from '@rfid-attendance/shared';
import { normalizeRfidUid } from './rfid.js';
import type { GoogleSheetsService, SheetAttendance, SheetPayrollCutoff, SheetUser } from './sheets.js';
import { manilaTimestamp } from './time.js';
import { PayrollService } from './payroll.js';
import { calculateCutoffPayroll, defaultPayrollProfiles, type CutoffInput } from './cutoff-payroll.js';

export type AdminConfig = { enableAdmin?: boolean; adminPin?: string; adminSessionSecret?: string; adminSessionMinutes?: number; timezone: string };
export class AdminError extends Error {
  constructor(readonly code: 'ADMIN_DISABLED' | 'INVALID_ADMIN_PIN' | 'ADMIN_AUTH_REQUIRED' | 'ADMIN_SESSION_EXPIRED' | 'ADMIN_VALIDATION_ERROR' | 'USER_CONFLICT' | 'ATTENDANCE_CONFLICT' | 'GOOGLE_SHEETS_UNAVAILABLE', message: string, readonly status = 400) { super(message); }
}

export class AdminService {
  constructor(private readonly sheets: GoogleSheetsService, private readonly config: AdminConfig, private readonly payroll = new PayrollService(sheets)) {}

  unlock(pin: unknown): { token: string; expiresAt: string } {
    this.assertEnabled();
    if (typeof pin !== 'string' || !this.equal(pin, this.config.adminPin ?? '')) throw new AdminError('INVALID_ADMIN_PIN', 'The administrator PIN is invalid.', 401);
    const expiresAt = Date.now() + (this.config.adminSessionMinutes ?? 15) * 60_000;
    const payload = `${expiresAt}.${crypto.randomBytes(16).toString('hex')}`;
    const signature = crypto.createHmac('sha256', this.config.adminSessionSecret!).update(payload).digest('base64url');
    return { token: `${payload}.${signature}`, expiresAt: new Date(expiresAt).toISOString() };
  }

  verify(token: string | undefined): void {
    this.assertEnabled();
    if (!token) throw new AdminError('ADMIN_AUTH_REQUIRED', 'Administrator authentication is required.', 401);
    const parts = token.split('.');
    if (parts.length !== 3 || !/^\d+$/.test(parts[0])) throw new AdminError('ADMIN_AUTH_REQUIRED', 'Administrator session is invalid.', 401);
    const expected = crypto.createHmac('sha256', this.config.adminSessionSecret!).update(`${parts[0]}.${parts[1]}`).digest('base64url');
    const actual = Buffer.from(parts[2]); const expectedBuffer = Buffer.from(expected);
    if (actual.length !== expectedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actual) || Date.now() >= Number(parts[0])) throw new AdminError('ADMIN_SESSION_EXPIRED', 'Administrator session has expired.', 401);
  }

  async users(): Promise<AdminUser[]> { return (await this.sheets.listUsers()).map(toAdminUser); }

  async saveUser(input: unknown, existingUserId?: string): Promise<{ user: AdminUser; created: boolean }> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AdminError('ADMIN_VALIDATION_ERROR', 'A user object is required.');
    const value = input as Partial<{ userId: string; rfidUid: string; fullName: string; department: string; status: 'ACTIVE' | 'INACTIVE'; employeeType: 'INTERN' | 'EMPLOYEE'; dailyRate: number | null; payrollProfileId: string | null; photoUrl: string | null }>;
    const userId = existingUserId ?? value.userId?.trim();
    if (!userId || typeof value.rfidUid !== 'string' || !value.rfidUid.trim() || !value.fullName?.trim() || (value.status !== 'ACTIVE' && value.status !== 'INACTIVE')) throw new AdminError('ADMIN_VALIDATION_ERROR', 'userId, RFID UID, full name, and status are required.');
    if (existingUserId && value.userId && value.userId !== existingUserId) throw new AdminError('ADMIN_VALIDATION_ERROR', 'User ID cannot be changed.');
    let rfidUid: string;
    try { rfidUid = normalizeRfidUid(value.rfidUid); } catch { throw new AdminError('ADMIN_VALIDATION_ERROR', 'RFID UID is invalid.'); }
    const current = await this.sheets.findUserById(userId);
    const byUid = await this.sheets.findUserByUid(rfidUid);
    if (byUid && byUid.userId !== userId) throw new AdminError('USER_CONFLICT', 'That RFID card is assigned to another user.', 409);
    const employeeType = value.employeeType ?? current?.employeeType ?? 'INTERN';
    const dailyRate = employeeType === 'EMPLOYEE' ? value.dailyRate : null;
    if (employeeType === 'EMPLOYEE' && (!Number.isFinite(dailyRate) || (dailyRate ?? 0) <= 0)) throw new AdminError('ADMIN_VALIDATION_ERROR', 'Employees require a positive daily rate.');
    const user: SheetUser = { userId, rfidUid, fullName: value.fullName.trim(), department: value.department?.trim() || null, active: value.status === 'ACTIVE', employeeType, dailyRate, payrollProfileId: value.payrollProfileId === undefined ? current?.payrollProfileId ?? null : value.payrollProfileId, photoUrl: value.photoUrl === undefined ? current?.photoUrl ?? null : value.photoUrl };
    try {
      const saved = await this.sheets.upsertUser(user);
      await this.sheets.writeAudit({ eventType: current ? 'ADMIN_USER_UPDATED' : 'ADMIN_USER_CREATED', userId: user.userId, rfidUid: user.rfidUid, message: current ? 'User profile updated by administrator' : 'User profile created by administrator', requestId: `admin-${crypto.randomUUID()}` }).catch(() => undefined);
      return { user: toAdminUser(saved), created: !current };
    } catch (error) { if (error instanceof AdminError) throw error; throw new AdminError('GOOGLE_SHEETS_UNAVAILABLE', 'User data is temporarily unavailable.', 503); }
  }

  async deleteUser(userId: string): Promise<void> {
    if (!userId.trim()) throw new AdminError('ADMIN_VALIDATION_ERROR', 'A user ID is required.');
    if (!await this.sheets.findUserById(userId)) throw new AdminError('ADMIN_VALIDATION_ERROR', 'User was not found.', 404);
    try {
      await this.sheets.deleteUser(userId);
      await this.sheets.writeAudit({ eventType: 'ADMIN_USER_DELETED', userId, message: `User ${userId} deleted by administrator`, requestId: `admin-${crypto.randomUUID()}` }).catch(() => undefined);
    } catch { throw new AdminError('GOOGLE_SHEETS_UNAVAILABLE', 'User data is temporarily unavailable.', 503); }
  }

  async attendance(date: string, includeBlank = false): Promise<AttendanceListItem[]> {
    const rows = await this.sheets.listAttendance(date);
    const users = await this.sheets.listUsers();
    const byId = new Map(users.map((user) => [user.userId, user]));
    return rows.filter((row) => includeBlank || row.timeIn || row.timeOut).map((row) => toAttendance(row, byId.get(row.userId)));
  }

  async updateAttendance(attendanceId: string, input: unknown): Promise<AttendanceListItem> {
    if (!input || typeof input !== 'object') throw new AdminError('ADMIN_VALIDATION_ERROR', 'Attendance values are required.');
    const value = input as Partial<{ timeIn: string | null; timeOut: string | null; expectedTimeIn: string | null; expectedTimeOut: string | null; attendanceDate: string }>;
    if (typeof value.attendanceDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.attendanceDate)) throw new AdminError('ADMIN_VALIDATION_ERROR', 'A valid attendance date is required.');
    const rows = await this.sheets.listAttendance(value.attendanceDate);
    const row = rows.find((item) => item.attendanceId === attendanceId);
    if (!row) throw new AdminError('ADMIN_VALIDATION_ERROR', 'Attendance record was not found.', 404);
    const timeIn = value.timeIn || null; const timeOut = value.timeOut || null;
    if (timeIn && !validTimestamp(timeIn, value.attendanceDate)) throw new AdminError('ADMIN_VALIDATION_ERROR', 'Time-in must be a valid timestamp on the attendance date.');
    if (timeOut && !validTimestamp(timeOut, value.attendanceDate)) throw new AdminError('ADMIN_VALIDATION_ERROR', 'Time-out must be a valid timestamp on the attendance date.');
    if (timeIn && timeOut && new Date(timeOut).getTime() < new Date(timeIn).getTime()) throw new AdminError('ADMIN_VALIDATION_ERROR', 'Time-out cannot precede time-in.');
    const updated: SheetAttendance = { ...row, timeIn: timeIn ?? '', timeOut, status: timeIn && timeOut ? (isLateTimeout(timeOut) ? 'LATE_TIMEOUT' : 'COMPLETED') : timeIn ? 'WORKING' : 'MISSED' };
    try {
      const saved = await this.sheets.updateAttendance(updated, { timeIn: value.expectedTimeIn ?? null, timeOut: value.expectedTimeOut ?? null });
      const user = await this.sheets.findUserById(row.userId);
      if (saved.status === 'COMPLETED' && saved.timeOut && user) await this.payroll.ensureForCompletedAttendance(saved, user);
      if (saved.status !== 'COMPLETED') await this.sheets.deletePayrollByAttendanceId(saved.attendanceId);
      await this.sheets.writeAudit({ eventType: 'ADMIN_ATTENDANCE_UPDATED', userId: row.userId, message: `Attendance ${attendanceId} corrected by administrator`, requestId: `admin-${crypto.randomUUID()}` }).catch(() => undefined);
      return toAttendance(saved);
    } catch { throw new AdminError('ATTENDANCE_CONFLICT', 'Attendance changed before it could be saved.', 409); }
  }

  async deleteAttendance(attendanceId: string, attendanceDate: string): Promise<void> {
    if (!attendanceId.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(attendanceDate)) throw new AdminError('ADMIN_VALIDATION_ERROR', 'A valid attendance record is required.');
    const rows = await this.sheets.listAttendance(attendanceDate);
    const row = rows.find((item) => item.attendanceId === attendanceId);
    if (!row) throw new AdminError('ADMIN_VALIDATION_ERROR', 'Attendance record was not found.', 404);
    try {
      await this.sheets.deleteAttendance(attendanceId, attendanceDate);
      await this.sheets.deletePayrollByAttendanceId(attendanceId);
      await this.sheets.writeAudit({ eventType: 'ADMIN_ATTENDANCE_DELETED', userId: row.userId, rfidUid: row.rfidUid, message: `Attendance ${attendanceId} deleted by administrator`, requestId: `admin-${crypto.randomUUID()}` }).catch(() => undefined);
    } catch { throw new AdminError('GOOGLE_SHEETS_UNAVAILABLE', 'Attendance data is temporarily unavailable.', 503); }
  }

  async payrollProfiles(): Promise<PayrollCalculationProfile[]> {
    const stored = await this.sheets.listPayrollProfiles();
    return stored.length ? stored : defaultPayrollProfiles;
  }

  async savePayrollProfile(input: unknown): Promise<PayrollCalculationProfile> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AdminError('ADMIN_VALIDATION_ERROR', 'A payroll profile is required.');
    const profile = input as PayrollCalculationProfile;
    const numbers = [profile.standardWorkingDaysPerCutoff, profile.incentivesAllowance, profile.specialAllowance, profile.specialHolidayMultiplier, profile.regularHolidayMultiplier, profile.halfDayFraction, profile.overtimeRate];
    if (!profile.profileId?.trim() || !profile.label?.trim() || profile.payrollFrequency !== 'SEMI_MONTHLY' || numbers.some((value) => !Number.isFinite(value) || value < 0)) throw new AdminError('ADMIN_VALIDATION_ERROR', 'Payroll profile fields are invalid.');
    return this.sheets.upsertPayrollProfile({ ...profile, profileId: profile.profileId.trim(), label: profile.label.trim() });
  }

  async cutoffPayroll(): Promise<SheetPayrollCutoff[]> {
    const [records, users] = await Promise.all([this.sheets.listPayrollCutoffs(), this.sheets.listUsers()]);
    // The PayrollCutoffs register does not store an employee type column; derive
    // intern vs employee classification from the live Users register so the
    // printable worksheet can apply intern-specific layout and labels.
    const byId = new Map(users.map((user) => [user.userId, (user.employeeType ?? 'INTERN') === 'EMPLOYEE' ? ('EMPLOYEE' as const) : ('INTERN' as const)]));
    return records
      .map((record) => ({ ...record, employeeType: byId.get(record.employeeId) ?? 'EMPLOYEE' }))
      .sort((a, b) => b.cutoffStart.localeCompare(a.cutoffStart));
  }

  async saveCutoffPayroll(input: unknown, existingPayrollId?: string): Promise<SheetPayrollCutoff> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AdminError('ADMIN_VALIDATION_ERROR', 'Payroll values are required.');
    const value = input as Partial<CutoffInput>;
    const employeeId = String(value.employeeId ?? '').trim();
    const employee = await this.sheets.findUserById(employeeId);
    if (!employee) throw new AdminError('ADMIN_VALIDATION_ERROR', 'The employee was not found.');
    const isIntern = (employee.employeeType ?? 'INTERN') !== 'EMPLOYEE';
    if (!isIntern && !employee.dailyRate) throw new AdminError('ADMIN_VALIDATION_ERROR', 'An employee daily rate is required before cutoff payroll can be saved.');
    const profiles = await this.payrollProfiles();
    const profileId = isIntern ? INTERN_PAYROLL_PROFILE_ID : String(value.payrollProfileId ?? employee.payrollProfileId ?? 'BEA_STANDARD');
    let profile: PayrollCalculationProfile | undefined;
    if (!isIntern) {
      profile = profiles.find((item) => item.profileId === profileId) ?? defaultPayrollProfiles.find((item) => item.profileId === profileId);
      if (!profile) throw new AdminError('ADMIN_VALIDATION_ERROR', 'Select a valid payroll calculation profile.');
    }
    const number = (field: keyof CutoffInput, fallback: number) => value[field] === undefined || value[field] === null || value[field] === '' ? fallback : Number(value[field]);
    const existing = existingPayrollId ? await this.sheets.findPayrollCutoff(existingPayrollId) : null;
    if (existingPayrollId && !existing) throw new AdminError('ADMIN_VALIDATION_ERROR', 'Payroll record was not found.', 404);
    if (existing?.status === 'FINALIZED') throw new AdminError('ADMIN_VALIDATION_ERROR', 'Finalized payroll cannot be edited.');
    try {
      const cutoffLabel = String(value.payrollCutoffLabel ?? '').trim() || `${value.cutoffStart ?? ''} to ${value.cutoffEnd ?? ''}`;
      const cutoff = isIntern
        ? internCutoffInput({ value, employee, profileId: INTERN_PAYROLL_PROFILE_ID, cutoffLabel, number })
        : employeeCutoffInput({ value, employee, profile: profile!, profileId, cutoffLabel, number });
      const calculated = calculateCutoffPayroll(cutoff);
      return this.sheets.upsertPayrollCutoff({ ...calculated, payrollId: existingPayrollId ?? crypto.randomUUID(), finalizedAt: null });
    } catch (error) { throw new AdminError('ADMIN_VALIDATION_ERROR', error instanceof Error ? error.message : 'Payroll values are invalid.'); }
  }

  async finalizeCutoffPayroll(payrollId: string): Promise<SheetPayrollCutoff> {
    const record = await this.sheets.findPayrollCutoff(payrollId);
    if (!record) throw new AdminError('ADMIN_VALIDATION_ERROR', 'Payroll record was not found.', 404);
    if (record.status === 'FINALIZED') return record;
    return this.sheets.upsertPayrollCutoff({ ...record, status: 'FINALIZED', finalizedAt: new Date().toISOString() });
  }

  private assertEnabled() { if (!this.config.enableAdmin || !this.config.adminPin || !this.config.adminSessionSecret) throw new AdminError('ADMIN_DISABLED', 'Administrator access is not configured.', 403); }
  private equal(a: string, b: string) { const ah = crypto.createHash('sha256').update(a).digest(); const bh = crypto.createHash('sha256').update(b).digest(); return crypto.timingSafeEqual(ah, bh); }
}
function toAdminUser(user: SheetUser): AdminUser { return { userId: user.userId, rfidUid: user.rfidUid, fullName: user.fullName, department: user.department, status: user.active ? 'ACTIVE' : 'INACTIVE', employeeType: user.employeeType ?? 'INTERN', dailyRate: user.dailyRate ?? null, payrollProfileId: user.payrollProfileId ?? null, photoUrl: user.photoUrl ?? null }; }
function toAttendance(row: SheetAttendance, user?: SheetUser): AttendanceListItem { return { attendanceId: row.attendanceId, attendanceDate: row.attendanceDate, timeIn: row.timeIn, timeOut: row.timeOut, status: row.status, userId: row.userId, fullName: user?.fullName ?? row.fullName, department: user?.department ?? row.department }; }
function validTimestamp(value: string, date: string): boolean { return value.startsWith(`${date}T`) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?[+-]\d{2}:\d{2}$/.test(value) && Number.isFinite(new Date(value).getTime()); }

/** Builds the shared cutoff input for a standard employee record (existing rules unchanged). */
function employeeCutoffInput({ value, employee, profile, profileId, cutoffLabel, number }: CutoffInputBuilder & { profile: PayrollCalculationProfile }): CutoffInput {
  return {
    employeeId: employee.userId, employeeName: employee.fullName, employeeType: 'EMPLOYEE', payrollProfileId: profileId, payrollCutoffLabel: cutoffLabel,
    cutoffStart: String(value.cutoffStart ?? ''), cutoffEnd: String(value.cutoffEnd ?? ''), payrollFrequency: 'SEMI_MONTHLY', dailyRate: number('dailyRate', employee.dailyRate ?? 0),
    standardWorkingDays: number('standardWorkingDays', profile.standardWorkingDaysPerCutoff), actualWorkingDays: number('actualWorkingDays', profile.standardWorkingDaysPerCutoff),
    specialHolidayDays: number('specialHolidayDays', 0), specialHolidayMultiplier: number('specialHolidayMultiplier', profile.specialHolidayMultiplier),
    regularHolidayDays: number('regularHolidayDays', 0), regularHolidayMultiplier: number('regularHolidayMultiplier', profile.regularHolidayMultiplier),
    incentivesAllowance: number('incentivesAllowance', profile.incentivesAllowance), specialAllowance: number('specialAllowance', profile.specialAllowance),
    lateUnits: number('lateUnits', 0), lateDeduction: number('lateDeduction', 0),
    halfDayCount: number('halfDayCount', 0), halfDayFraction: profile.halfDayFraction, absentDays: number('absentDays', 0),
    overtimeHours: number('overtimeHours', 0), overtimeRate: number('overtimeRate', profile.overtimeRate),
    manualAdjustment: number('manualAdjustment', 0), adjustmentReason: value.adjustmentReason?.trim() || null, signaturePlaceholder: String(value.signaturePlaceholder ?? ''),
    approvedWorkingDayOverage: Boolean(value.approvedWorkingDayOverage), status: 'DRAFT',
  };
}

/**
 * Builds the shared cutoff input for an intern record using the fixed intern
 * policy: PHP 80.00 per day and PHP 10.00 per hour of lateness. No holiday
 * premium, allowances, half-days, absences, or overtime apply to interns.
 */
function internCutoffInput({ value, employee, profileId, cutoffLabel, number }: CutoffInputBuilder): CutoffInput {
  const lateUnits = Math.max(0, number('lateUnits', 0));
  return {
    employeeId: employee.userId, employeeName: employee.fullName, employeeType: 'INTERN', payrollProfileId: profileId, payrollCutoffLabel: cutoffLabel,
    cutoffStart: String(value.cutoffStart ?? ''), cutoffEnd: String(value.cutoffEnd ?? ''), payrollFrequency: 'SEMI_MONTHLY',
    // Fixed intern rate — any submitted rate is ignored for interns.
    dailyRate: INTERN_DAILY_RATE_PHP,
    standardWorkingDays: number('standardWorkingDays', 11), actualWorkingDays: number('actualWorkingDays', 11),
    specialHolidayDays: 0, specialHolidayMultiplier: 0, regularHolidayDays: 0, regularHolidayMultiplier: 0,
    incentivesAllowance: 0, specialAllowance: 0,
    lateUnits,
    // Late deduction is PHP 10.00 per hour, computed from the total late hours.
    lateDeduction: Math.round(lateUnits * INTERN_LATE_DEDUCTION_PER_HOUR_PHP),
    halfDayCount: 0, halfDayFraction: 0, absentDays: 0,
    overtimeHours: 0, overtimeRate: 0,
    manualAdjustment: number('manualAdjustment', 0), adjustmentReason: value.adjustmentReason?.trim() || null, signaturePlaceholder: String(value.signaturePlaceholder ?? ''),
    approvedWorkingDayOverage: Boolean(value.approvedWorkingDayOverage), status: 'DRAFT',
  };
}

type CutoffInputBuilder = {
  value: Partial<CutoffInput>;
  employee: SheetUser;
  profileId: string;
  cutoffLabel: string;
  number: (field: keyof CutoffInput, fallback: number) => number;
};
