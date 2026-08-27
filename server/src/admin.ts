import crypto from 'node:crypto';
import type { AdminUser, AttendanceListItem, PayrollCalculationProfile } from '@rfid-attendance/shared';
import { INTERN_DAILY_RATE_PHP, INTERN_LATE_DEDUCTION_PER_HOUR_PHP, INTERN_PAYROLL_PROFILE_ID, isLateTimeout, normalizeName } from '@rfid-attendance/shared';
import { normalizeRfidUid } from './rfid.js';
import { manilaDate, manilaTimestamp } from './time.js';
import type { GoogleSheetsService, SheetAttendance, SheetPayrollCutoff, SheetUser } from './sheets.js';
import { PayrollService } from './payroll.js';
import { calculateCutoffPayroll, defaultPayrollProfiles, type CutoffInput } from './cutoff-payroll.js';

export type AdminConfig = { enableAdmin?: boolean; adminPin?: string; adminSessionSecret?: string; adminSessionMinutes?: number; timezone: string };
export class AdminError extends Error {
  constructor(readonly code: 'ADMIN_DISABLED' | 'INVALID_ADMIN_PIN' | 'ADMIN_AUTH_REQUIRED' | 'ADMIN_SESSION_EXPIRED' | 'ADMIN_VALIDATION_ERROR' | 'USER_CONFLICT' | 'ATTENDANCE_CONFLICT' | 'GOOGLE_SHEETS_UNAVAILABLE' | 'ATTENDANCE_ALREADY_EXISTS_FOR_DATE' | 'BACKDATE_LIMIT_EXCEEDED', message: string, readonly status = 400) { super(message); }
}

export interface AdminUnlockResult {
  token: string;
  expiresAt: string;
}

export class AdminService {
  constructor(private readonly sheets: GoogleSheetsService, private readonly config: AdminConfig, private readonly payroll = new PayrollService(sheets)) {}

  async unlock<T>(pin: T): Promise<AdminUnlockResult> {
    this.assertEnabled();
    let authenticated = false;
    if (isString(pin)) {
      const trimmed = pin.trim();
      if (this.equal(trimmed, this.config.adminPin ?? '')) {
        authenticated = true;
      } else {
        try {
          const normalized = normalizeRfidUid(trimmed);
          const user = await this.sheets.findUserByUid(normalized);
          if (user && user.active && user.cardType === 'ADMIN_ASSIST') {
            authenticated = true;
          }
        } catch {
          // Not a valid RFID UID or user not found
        }
      }
    }
    if (!authenticated) throw new AdminError('INVALID_ADMIN_PIN', 'The administrator PIN is invalid.', 401);
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

  async saveUser<T>(input: T, existingUserId?: string): Promise<{ user: AdminUser; created: boolean }> {
    const value = parseAdminUserInput(input);
    if (value === null) throw new AdminError('ADMIN_VALIDATION_ERROR', 'A user object is required.');
    const isAssist = value.cardType === 'ADMIN_ASSIST';
    let rfidUid: string;
    try { rfidUid = normalizeRfidUid(value.rfidUid); } catch { throw new AdminError('ADMIN_VALIDATION_ERROR', 'RFID UID is invalid.'); }
    const userId = existingUserId ?? (isAssist ? `ADMIN_CARD_${rfidUid}` : (value.userId?.trim().toUpperCase() ?? ''));
    const fullName = value.fullName?.trim() || (isAssist ? (value.label?.trim() || 'Admin Assist Card') : '');
    if (!userId || !rfidUid || !fullName || (value.status !== 'ACTIVE' && value.status !== 'INACTIVE')) throw new AdminError('ADMIN_VALIDATION_ERROR', 'userId, RFID UID, full name, and status are required.');
    if (existingUserId && value.userId && value.userId.trim() !== existingUserId && value.userId.trim().toUpperCase() !== existingUserId.toUpperCase()) throw new AdminError('ADMIN_VALIDATION_ERROR', 'User ID cannot be changed.');
    const current = await this.sheets.findUserById(userId);
    const byUid = await this.sheets.findUserByUid(rfidUid);
    if (byUid && byUid.userId !== userId) throw new AdminError('USER_CONFLICT', 'That RFID card is assigned to another user.', 409);
    const employeeType = isAssist ? 'EMPLOYEE' : (value.employeeType ?? current?.employeeType ?? 'INTERN');
    const dailyRate = !isAssist && employeeType === 'EMPLOYEE' ? value.dailyRate : null;
    if (!isAssist && employeeType === 'EMPLOYEE' && (!Number.isFinite(dailyRate) || (dailyRate ?? 0) <= 0)) throw new AdminError('ADMIN_VALIDATION_ERROR', 'Employees require a positive daily rate.');
    if (value.gender !== undefined && value.gender !== null && value.gender !== 'MALE' && value.gender !== 'FEMALE') throw new AdminError('ADMIN_VALIDATION_ERROR', 'Gender must be MALE or FEMALE.');
    const user: SheetUser = {
      userId,
      rfidUid,
      fullName: normalizeName(fullName),
      department: isAssist ? (value.department?.trim() || 'Admin') : (value.department?.trim().replace(/\s+/g, ' ') || null),
      active: value.status === 'ACTIVE',
      employeeType,
      gender: isAssist ? null : (value.gender === undefined ? current?.gender ?? null : value.gender),
      dailyRate,
      payrollProfileId: isAssist ? null : (value.payrollProfileId === undefined ? current?.payrollProfileId ?? null : value.payrollProfileId),
      photoUrl: isAssist ? null : (value.photoUrl === undefined ? current?.photoUrl ?? null : value.photoUrl),
      cardType: value.cardType ?? current?.cardType ?? 'EMPLOYEE',
    };
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
      const cutoffs = await this.sheets.listPayrollCutoffs();
      for (const cutoff of cutoffs) {
        if (cutoff.employeeId === userId) {
          await this.sheets.deletePayrollCutoff(cutoff.payrollId).catch(() => undefined);
        }
      }
      await this.sheets.writeAudit({ eventType: 'ADMIN_USER_DELETED', userId, message: `User ${userId} deleted by administrator`, requestId: `admin-${crypto.randomUUID()}` }).catch(() => undefined);
    } catch { throw new AdminError('GOOGLE_SHEETS_UNAVAILABLE', 'User data is temporarily unavailable.', 503); }
  }

  async attendance(date: string, includeBlank = false): Promise<AttendanceListItem[]> {
    const rows = await this.sheets.listAttendance(date);
    const users = await this.sheets.listUsers();
    const byId = new Map(users.map((user) => [user.userId, user]));
    return rows.filter((row) => includeBlank || row.timeIn || row.timeOut).map((row) => toAttendance(row, byId.get(row.userId)));
  }

  async updateAttendance<T>(attendanceId: string, input: T): Promise<AttendanceListItem> {
    const value = parseAttendanceInput(input);
    if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value.attendanceDate)) throw new AdminError('ADMIN_VALIDATION_ERROR', 'A valid attendance date is required.');
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

  async createBackdatedAttendance<T>(input: T): Promise<AttendanceListItem> {
    const value = parseBackdatedAttendanceInput(input);
    if (value === null) throw new AdminError('ADMIN_VALIDATION_ERROR', 'A valid backdated attendance record with mandatory reason is required.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value.attendanceDate)) throw new AdminError('ADMIN_VALIDATION_ERROR', 'A valid attendance date is required.');

    const today = manilaDate(new Date(), this.config.timezone);
    if (value.attendanceDate >= today) {
      throw new AdminError('ADMIN_VALIDATION_ERROR', 'Backdated attendance date must be strictly in the past.');
    }

    const user = await this.sheets.findUserById(value.userId);
    if (!user) throw new AdminError('ADMIN_VALIDATION_ERROR', 'User was not found.', 404);
    if (user.cardType === 'ADMIN_ASSIST') throw new AdminError('ADMIN_VALIDATION_ERROR', 'Cannot create attendance for an Admin RFID card.', 400);
    if (!user.active) throw new AdminError('ADMIN_VALIDATION_ERROR', 'Cannot create attendance for an inactive user.', 400);

    const existing = await this.sheets.findAttendance(user.userId, value.attendanceDate);
    if (existing) {
      throw new AdminError('ATTENDANCE_ALREADY_EXISTS_FOR_DATE', 'An attendance record already exists for this employee on this date. Use attendance correction instead.', 409);
    }

    const cutoffs = await this.sheets.listPayrollCutoffs();
    const finalizedCutoff = cutoffs.find(
      (c) => c.status === 'FINALIZED' && c.employeeId === user.userId && value.attendanceDate >= c.cutoffStart && value.attendanceDate <= c.cutoffEnd
    );
    if (finalizedCutoff) {
      throw new AdminError('BACKDATE_LIMIT_EXCEEDED', `Cannot add backdated attendance: date falls within finalized payroll cutoff ${finalizedCutoff.cutoffStart} to ${finalizedCutoff.cutoffEnd}.`, 409);
    }

    const timeIn = value.timeIn;
    const timeOut = value.timeOut || null;
    if (!validTimestamp(timeIn, value.attendanceDate)) throw new AdminError('ADMIN_VALIDATION_ERROR', 'Time-in must be a valid timestamp on the attendance date.');
    if (timeOut && !validTimestamp(timeOut, value.attendanceDate)) throw new AdminError('ADMIN_VALIDATION_ERROR', 'Time-out must be a valid timestamp on the attendance date.');
    if (timeOut && new Date(timeOut).getTime() < new Date(timeIn).getTime()) throw new AdminError('ADMIN_VALIDATION_ERROR', 'Time-out cannot precede time-in.');

    const newAttendance: SheetAttendance = {
      attendanceId: crypto.randomUUID(),
      attendanceDate: value.attendanceDate,
      userId: user.userId,
      rfidUid: user.rfidUid,
      fullName: user.fullName,
      department: user.department,
      timeIn,
      timeOut,
      status: timeIn && timeOut ? (isLateTimeout(timeOut) ? 'LATE_TIMEOUT' : 'COMPLETED') : 'WORKING',
      source: 'ADMIN_BACKDATED_ENTRY',
      notes: '',
      recordedBy: 'Admin',
      recordedReason: value.reason.trim(),
      recordedAt: manilaTimestamp(new Date(), this.config.timezone),
    };

    try {
      const saved = await this.sheets.createAttendance(newAttendance);
      if (saved.status === 'COMPLETED' && saved.timeOut) {
        await this.payroll.ensureForCompletedAttendance(saved, user);
      }
      await this.sheets.writeAudit({
        eventType: 'ADMIN_BACKDATED_ATTENDANCE',
        userId: user.userId,
        message: `Backdated attendance created for ${value.attendanceDate}: ${value.reason.trim()}`,
        requestId: `admin-${crypto.randomUUID()}`,
      }).catch(() => undefined);
      return toAttendance(saved, user);
    } catch {
      throw new AdminError('GOOGLE_SHEETS_UNAVAILABLE', 'Attendance data is temporarily unavailable.', 503);
    }
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

  async savePayrollProfile<T>(input: T): Promise<PayrollCalculationProfile> {
    const profile = parsePayrollProfile(input);
    if (profile === null) throw new AdminError('ADMIN_VALIDATION_ERROR', 'A payroll profile is required.');
    const numbers = [profile.standardWorkingDaysPerCutoff, profile.incentivesAllowance, profile.specialAllowance, profile.specialHolidayMultiplier, profile.regularHolidayMultiplier, profile.halfDayFraction, profile.overtimeRate];
    if (!profile.profileId?.trim() || !profile.label?.trim() || profile.payrollFrequency !== 'SEMI_MONTHLY' || numbers.some((value) => !Number.isFinite(value) || value < 0)) throw new AdminError('ADMIN_VALIDATION_ERROR', 'Payroll profile fields are invalid.');
    return this.sheets.upsertPayrollProfile({ ...profile, profileId: profile.profileId.trim(), label: profile.label.trim() });
  }

  async cutoffPayroll(): Promise<SheetPayrollCutoff[]> {
    const [records, users] = await Promise.all([this.sheets.listPayrollCutoffs(), this.sheets.listUsers()]);
    // The PayrollCutoffs register does not store an employee type column; derive
    // intern vs employee classification from the live Users register so the
    // printable worksheet can apply intern-specific layout and labels.
    const byId = new Map(users.map((user): [string, 'EMPLOYEE' | 'INTERN'] => [user.userId, (user.employeeType ?? 'INTERN') === 'EMPLOYEE' ? 'EMPLOYEE' : 'INTERN']));
    return records
      .map((record) => ({ ...record, employeeType: byId.get(record.employeeId) ?? 'EMPLOYEE' }))
      .sort((a, b) => b.cutoffStart.localeCompare(a.cutoffStart));
  }

  async saveCutoffPayroll<T>(input: T, existingPayrollId?: string): Promise<SheetPayrollCutoff> {
    const value = parseCutoffInput(input);
    if (value === null) throw new AdminError('ADMIN_VALIDATION_ERROR', 'Payroll values are required.');
    const employeeId = String(value.employeeId ?? '').trim();
    const employee = await this.sheets.findUserById(employeeId);
    if (!employee) throw new AdminError('ADMIN_VALIDATION_ERROR', 'The employee was not found.');
    const isIntern = (employee.employeeType ?? 'INTERN') !== 'EMPLOYEE';
    if (!isIntern && !employee.dailyRate) throw new AdminError('ADMIN_VALIDATION_ERROR', 'An employee daily rate is required before cutoff payroll can be saved.');
    const profiles = await this.payrollProfiles();
    const profileId = isIntern ? INTERN_PAYROLL_PROFILE_ID : String(value.payrollProfileId ?? employee.payrollProfileId ?? 'BEA_STANDARD');
    const number = (field: CutoffNumberField, fallback: number) => value[field] === undefined || value[field] === null || value[field] === '' ? fallback : Number(value[field]);
    const existing = existingPayrollId ? await this.sheets.findPayrollCutoff(existingPayrollId) : null;
    if (existingPayrollId && !existing) throw new AdminError('ADMIN_VALIDATION_ERROR', 'Payroll record was not found.', 404);
    if (existing?.status === 'FINALIZED') throw new AdminError('ADMIN_VALIDATION_ERROR', 'Finalized payroll cannot be edited.');
    try {
      const cutoffLabel = String(value.payrollCutoffLabel ?? '').trim() || `${value.cutoffStart ?? ''} to ${value.cutoffEnd ?? ''}`;
      let cutoff: CutoffInput;
      if (isIntern) {
        cutoff = internCutoffInput({ value, employee, profileId: INTERN_PAYROLL_PROFILE_ID, cutoffLabel, number });
      } else {
        const profile = profiles.find((item) => item.profileId === profileId) ?? defaultPayrollProfiles.find((item) => item.profileId === profileId);
        if (!profile) throw new AdminError('ADMIN_VALIDATION_ERROR', 'Select a valid payroll calculation profile.');
        cutoff = employeeCutoffInput({ value, employee, profile, profileId, cutoffLabel, number });
      }
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

  async deleteCutoffPayroll(payrollId: string): Promise<void> {
    const record = await this.sheets.findPayrollCutoff(payrollId);
    if (!record) throw new AdminError('ADMIN_VALIDATION_ERROR', 'Payroll record was not found.', 404);
    await this.sheets.deletePayrollCutoff(payrollId);
  }

  private assertEnabled() { if (!this.config.enableAdmin || !this.config.adminPin || !this.config.adminSessionSecret) throw new AdminError('ADMIN_DISABLED', 'Administrator access is not configured.', 403); }
  private equal(a: string, b: string) { const ah = crypto.createHash('sha256').update(a).digest(); const bh = crypto.createHash('sha256').update(b).digest(); return crypto.timingSafeEqual(ah, bh); }
}
function toAdminUser(user: SheetUser): AdminUser { return { userId: user.userId, rfidUid: user.rfidUid, fullName: user.fullName, department: user.department, status: user.active ? 'ACTIVE' : 'INACTIVE', employeeType: user.employeeType ?? 'INTERN', gender: user.gender ?? null, dailyRate: user.dailyRate ?? null, payrollProfileId: user.payrollProfileId ?? null, photoUrl: user.photoUrl ?? null, cardType: user.cardType ?? 'EMPLOYEE' }; }
function toAttendance(row: SheetAttendance, user?: SheetUser): AttendanceListItem { return { attendanceId: row.attendanceId, attendanceDate: row.attendanceDate, timeIn: row.timeIn, timeOut: row.timeOut, status: row.status, userId: row.userId, fullName: user?.fullName ?? row.fullName, department: user?.department ?? row.department, source: row.source, recordedBy: row.recordedBy ?? null, recordedReason: row.recordedReason ?? null, recordedAt: row.recordedAt ?? null }; }
function validTimestamp(value: string, date: string): boolean { return value.startsWith(`${date}T`) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?[+-]\d{2}:\d{2}$/.test(value) && Number.isFinite(new Date(value).getTime()); }

function employeeCutoffInput({ value, employee, profile, profileId, cutoffLabel, number }: CutoffInputBuilder & { profile: PayrollCalculationProfile }): CutoffInput {
  return {
    employeeId: employee.userId, employeeName: employee.fullName, employeeType: 'EMPLOYEE', payrollProfileId: profileId, payrollCutoffLabel: cutoffLabel,
    cutoffStart: String(value.cutoffStart ?? ''), cutoffEnd: String(value.cutoffEnd ?? ''), payrollFrequency: 'SEMI_MONTHLY', dailyRate: number('dailyRate', employee.dailyRate ?? 0),
    standardWorkingDays: number('standardWorkingDays', profile.standardWorkingDaysPerCutoff), actualWorkingDays: number('actualWorkingDays', profile.standardWorkingDaysPerCutoff),
    basicPay: value.basicPay != null ? number('basicPay', 0) : undefined,
    specialHolidayDays: number('specialHolidayDays', 0), specialHolidayMultiplier: number('specialHolidayMultiplier', profile.specialHolidayMultiplier),
    specialHolidayPay: value.specialHolidayPay != null ? number('specialHolidayPay', 0) : undefined,
    regularHolidayDays: number('regularHolidayDays', 0), regularHolidayMultiplier: number('regularHolidayMultiplier', profile.regularHolidayMultiplier),
    regularHolidayPay: value.regularHolidayPay != null ? number('regularHolidayPay', 0) : undefined,
    hra: number('hra', 0),
    incentivesAllowance: number('incentivesAllowance', profile.incentivesAllowance), specialAllowance: number('specialAllowance', profile.specialAllowance),
    lateUnits: number('lateUnits', 0), lateDeduction: number('lateDeduction', 0),
    halfDayCount: number('halfDayCount', 0), halfDayFraction: profile.halfDayFraction, absentDays: number('absentDays', 0),
    absenceDeduction: value.absenceDeduction != null ? number('absenceDeduction', 0) : undefined,
    overtimeHours: number('overtimeHours', 0), overtimeRate: number('overtimeRate', profile.overtimeRate),
    overtimePay: value.overtimePay != null ? number('overtimePay', 0) : undefined,
    sss: number('sss', 0), phic: number('phic', 0), hdmf: number('hdmf', 0), salaryAdvance: number('salaryAdvance', 0),
    manualAdjustment: number('manualAdjustment', 0), adjustmentReason: cutoffAdjustmentReason(value.adjustmentReason),
    approvedWorkingDayOverage: Boolean(value.approvedWorkingDayOverage), status: 'DRAFT',
  };
}

/**
 * Builds the shared cutoff input for an intern record using the fixed intern
 * policy: PHP 80.00 per day and PHP 10.00 per hour of lateness. No holiday
 * premium, allowances, or overtime apply to interns. Absence days are derived
 * from standard less actual working days, while half-days remain inputtable.
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
    halfDayCount: number('halfDayCount', 0), halfDayFraction: 0.5,
    absentDays: Math.max(0, number('standardWorkingDays', 11) - number('actualWorkingDays', 11)),
    overtimeHours: 0, overtimeRate: 0,
    manualAdjustment: number('manualAdjustment', 0), adjustmentReason: cutoffAdjustmentReason(value.adjustmentReason),
    approvedWorkingDayOverage: Boolean(value.approvedWorkingDayOverage), status: 'DRAFT',
  };
}

type AdminUserInput = {
  userId?: string | null;
  rfidUid: string;
  fullName: string;
  department?: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  employeeType?: 'INTERN' | 'EMPLOYEE';
  gender?: 'MALE' | 'FEMALE' | null;
  dailyRate?: number | null;
  payrollProfileId?: string | null;
  photoUrl?: string | null;
  cardType?: 'EMPLOYEE' | 'ADMIN_ASSIST';
  label?: string | null;
};
type AttendanceInput = { timeIn?: string | null; timeOut?: string | null; expectedTimeIn?: string | null; expectedTimeOut?: string | null; attendanceDate: string };
type PayrollProfileInput = PayrollCalculationProfile;
type CutoffValue = string | number | null;
type CutoffNumberField = 'dailyRate' | 'standardWorkingDays' | 'actualWorkingDays' | 'basicPay' | 'specialHolidayDays' | 'specialHolidayMultiplier' | 'specialHolidayPay' | 'regularHolidayDays' | 'regularHolidayMultiplier' | 'regularHolidayPay' | 'hra' | 'incentivesAllowance' | 'specialAllowance' | 'lateUnits' | 'lateDeduction' | 'halfDayCount' | 'halfDayFraction' | 'absentDays' | 'absenceDeduction' | 'overtimeHours' | 'overtimeRate' | 'overtimePay' | 'sss' | 'phic' | 'hdmf' | 'salaryAdvance' | 'manualAdjustment';
interface CutoffFormInput {
  employeeId?: CutoffValue;
  employeeName?: CutoffValue;
  employeeType?: CutoffValue;
  payrollProfileId?: CutoffValue;
  payrollCutoffLabel?: CutoffValue;
  cutoffStart?: CutoffValue;
  cutoffEnd?: CutoffValue;
  payrollFrequency?: CutoffValue;
  dailyRate?: CutoffValue;
  standardWorkingDays?: CutoffValue;
  actualWorkingDays?: CutoffValue;
  basicPay?: CutoffValue;
  specialHolidayDays?: CutoffValue;
  specialHolidayMultiplier?: CutoffValue;
  specialHolidayPay?: CutoffValue;
  regularHolidayDays?: CutoffValue;
  regularHolidayMultiplier?: CutoffValue;
  regularHolidayPay?: CutoffValue;
  hra?: CutoffValue;
  incentivesAllowance?: CutoffValue;
  specialAllowance?: CutoffValue;
  lateUnits?: CutoffValue;
  lateDeduction?: CutoffValue;
  halfDayCount?: CutoffValue;
  halfDayFraction?: CutoffValue;
  absentDays?: CutoffValue;
  absenceDeduction?: CutoffValue;
  overtimeHours?: CutoffValue;
  overtimeRate?: CutoffValue;
  overtimePay?: CutoffValue;
  sss?: CutoffValue;
  phic?: CutoffValue;
  hdmf?: CutoffValue;
  salaryAdvance?: CutoffValue;
  manualAdjustment?: CutoffValue;
  lateDeductionRate?: CutoffValue;
  adjustmentReason?: CutoffValue;
  approvedWorkingDayOverage?: CutoffValue | boolean;
  status?: CutoffValue;
}

function isString<T>(value: T): value is T & string { return Object(value) !== value && Object.prototype.toString.call(value) === '[object String]'; }
function isNumber<T>(value: T): value is T & number { return Object(value) !== value && Object.prototype.toString.call(value) === '[object Number]' && Number.isFinite(value); }
function isBoolean<T>(value: T): value is T & boolean { return Object(value) !== value && Object.prototype.toString.call(value) === '[object Boolean]'; }
type AdminInputValue = string | number | boolean | bigint | symbol | null | undefined;
interface InputObject {
  cardType?: AdminInputValue;
  userId?: AdminInputValue;
  rfidUid?: AdminInputValue;
  fullName?: AdminInputValue;
  department?: AdminInputValue;
  status?: AdminInputValue;
  employeeType?: AdminInputValue;
  gender?: AdminInputValue;
  dailyRate?: AdminInputValue;
  payrollProfileId?: AdminInputValue;
  photoUrl?: AdminInputValue;
  timeIn?: AdminInputValue;
  timeOut?: AdminInputValue;
  expectedTimeIn?: AdminInputValue;
  expectedTimeOut?: AdminInputValue;
  attendanceDate?: AdminInputValue;
  profileId?: AdminInputValue;
  label?: AdminInputValue;
  payrollFrequency?: AdminInputValue;
  standardWorkingDaysPerCutoff?: AdminInputValue;
  incentivesAllowance?: AdminInputValue;
  specialAllowance?: AdminInputValue;
  specialHolidayMultiplier?: AdminInputValue;
  regularHolidayMultiplier?: AdminInputValue;
  halfDayFraction?: AdminInputValue;
  overtimeRate?: AdminInputValue;
  employeeName?: AdminInputValue;
  employeeId?: AdminInputValue;
  lateDeductionRate?: AdminInputValue;
  payrollCutoffLabel?: AdminInputValue;
  cutoffStart?: AdminInputValue;
  cutoffEnd?: AdminInputValue;
  standardWorkingDays?: AdminInputValue;
  actualWorkingDays?: AdminInputValue;
  specialHolidayDays?: AdminInputValue;
  regularHolidayDays?: AdminInputValue;
  lateUnits?: AdminInputValue;
  lateDeduction?: AdminInputValue;
  halfDayCount?: AdminInputValue;
  absentDays?: AdminInputValue;
  overtimeHours?: AdminInputValue;
  manualAdjustment?: AdminInputValue;
  adjustmentReason?: AdminInputValue;
  approvedWorkingDayOverage?: AdminInputValue;
  reason?: AdminInputValue;
}
function isInputObject<T>(value: T): value is T & InputObject { return value !== null && Object(value) === value && !Array.isArray(value) && !(value instanceof Function); }
function optionalString<T>(value: T): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return isString(value) ? value : undefined;
}
function cutoffAdjustmentReason(value: CutoffValue | undefined): string | null {
  return isString(value) ? value.trim() || null : null;
}
function parseAdminUserInput<T>(input: T): AdminUserInput | null {
  if (!isInputObject(input) || !isString(input.rfidUid)) return null;
  const cardType = input.cardType === 'ADMIN_ASSIST' ? 'ADMIN_ASSIST' : 'EMPLOYEE';
  const label = isString(input.label) ? input.label : undefined;
  const status = input.status === undefined && cardType === 'ADMIN_ASSIST' ? 'ACTIVE' : input.status;
  if (status !== 'ACTIVE' && status !== 'INACTIVE') return null;

  const userId = isString(input.userId) ? input.userId : undefined;
  const fullName = isString(input.fullName) ? input.fullName : (cardType === 'ADMIN_ASSIST' ? (label ?? 'Admin Assist Card') : '');
  if (cardType === 'EMPLOYEE' && (!userId || !fullName)) return null;

  const department = input.department;
  const employeeType = input.employeeType; const gender = input.gender; const dailyRate = input.dailyRate;
  const payrollProfileId = input.payrollProfileId; const photoUrl = input.photoUrl;
  if (department !== undefined && department !== null && !isString(department)) return null;
  if (payrollProfileId !== undefined && payrollProfileId !== null && !isString(payrollProfileId)) return null;
  if (photoUrl !== undefined && photoUrl !== null && !isString(photoUrl)) return null;
  if (employeeType !== undefined && employeeType !== 'INTERN' && employeeType !== 'EMPLOYEE') return null;
  if (gender !== undefined && gender !== null && gender !== 'MALE' && gender !== 'FEMALE') return null;
  if (dailyRate !== undefined && dailyRate !== null && !isNumber(dailyRate)) return null;
  return { userId, rfidUid: input.rfidUid, fullName, department, status, employeeType, gender, dailyRate, payrollProfileId, photoUrl, cardType, label };
}
function parseAttendanceInput<T>(input: T): AttendanceInput | null {
  if (!isInputObject(input) || !isString(input.attendanceDate)) return null;
  const timeIn = optionalString(input.timeIn); const timeOut = optionalString(input.timeOut);
  const expectedTimeIn = optionalString(input.expectedTimeIn); const expectedTimeOut = optionalString(input.expectedTimeOut);
  if (timeIn === undefined && input.timeIn !== undefined && input.timeIn !== null) return null;
  if (timeOut === undefined && input.timeOut !== undefined && input.timeOut !== null) return null;
  if (expectedTimeIn === undefined && input.expectedTimeIn !== undefined && input.expectedTimeIn !== null) return null;
  if (expectedTimeOut === undefined && input.expectedTimeOut !== undefined && input.expectedTimeOut !== null) return null;
  return { attendanceDate: input.attendanceDate, timeIn, timeOut, expectedTimeIn, expectedTimeOut };
}
type PayrollProfileNumberField = 'standardWorkingDaysPerCutoff' | 'incentivesAllowance' | 'specialAllowance' | 'specialHolidayMultiplier' | 'regularHolidayMultiplier' | 'halfDayFraction' | 'overtimeRate';
const payrollProfileNumberFields: PayrollProfileNumberField[] = ['standardWorkingDaysPerCutoff', 'incentivesAllowance', 'specialAllowance', 'specialHolidayMultiplier', 'regularHolidayMultiplier', 'halfDayFraction', 'overtimeRate'];
function parsePayrollProfile<T>(input: T): PayrollProfileInput | null {
  if (!isInputObject(input) || !isString(input.profileId) || !isString(input.label) || input.payrollFrequency !== 'SEMI_MONTHLY') return null;
  if (!payrollProfileNumberFields.every((field) => isNumber(input[field]))) return null;
  if (!isPayrollProfileRecord(input)) return null;
  return input;
}
function isPayrollProfileRecord(input: InputObject): input is PayrollProfileInput {
  return isString(input.profileId) && isString(input.label) && input.payrollFrequency === 'SEMI_MONTHLY' &&
    payrollProfileNumberFields.every((field) => isNumber(input[field]));
}
function parseCutoffInput<T>(input: T): CutoffFormInput | null {
  return isInputObject(input) && isCutoffInputRecord(input) ? input : null;
}
function isCutoffValue<T>(value: T): value is T & CutoffValue {
  return isString(value) || isNumber(value) || value === null;
}
function isOptionalCutoffValue<T>(value: T): boolean {
  return value === undefined || isCutoffValue(value);
}
function isOptionalApprovedWorkingDayOverage<T>(value: T): boolean {
  return value === undefined || isBoolean(value) || isCutoffValue(value);
}
type CutoffInputField = keyof CutoffFormInput;
function isCutoffInputField(value: string): value is CutoffInputField { return cutoffInputFields.has(value); }
function isCutoffInputRecord(input: InputObject): input is CutoffFormInput {
  return Object.keys(input).every(isCutoffInputField) &&
    isOptionalCutoffValue(input.employeeId) && isOptionalCutoffValue(input.employeeName) &&
    isOptionalCutoffValue(input.employeeType) && isOptionalCutoffValue(input.payrollProfileId) &&
    isOptionalCutoffValue(input.payrollCutoffLabel) && isOptionalCutoffValue(input.cutoffStart) &&
    isOptionalCutoffValue(input.cutoffEnd) && isOptionalCutoffValue(input.payrollFrequency) &&
    isOptionalCutoffValue(input.dailyRate) && isOptionalCutoffValue(input.standardWorkingDays) &&
    isOptionalCutoffValue(input.actualWorkingDays) && isOptionalCutoffValue(input.specialHolidayDays) &&
    isOptionalCutoffValue(input.specialHolidayMultiplier) && isOptionalCutoffValue(input.regularHolidayDays) &&
    isOptionalCutoffValue(input.regularHolidayMultiplier) && isOptionalCutoffValue(input.incentivesAllowance) &&
    isOptionalCutoffValue(input.specialAllowance) && isOptionalCutoffValue(input.lateUnits) &&
    isOptionalCutoffValue(input.lateDeduction) && isOptionalCutoffValue(input.halfDayCount) &&
    isOptionalCutoffValue(input.halfDayFraction) && isOptionalCutoffValue(input.absentDays) &&
    isOptionalCutoffValue(input.overtimeHours) && isOptionalCutoffValue(input.overtimeRate) &&
    isOptionalCutoffValue(input.manualAdjustment) && isOptionalCutoffValue(input.lateDeductionRate) && isOptionalCutoffValue(input.adjustmentReason) &&
    isOptionalApprovedWorkingDayOverage(input.approvedWorkingDayOverage) && isOptionalCutoffValue(input.status);
}
const cutoffInputFields = new Set([
  'employeeId', 'employeeName', 'employeeType', 'payrollProfileId', 'payrollCutoffLabel', 'cutoffStart', 'cutoffEnd', 'payrollFrequency', 'dailyRate', 'standardWorkingDays', 'actualWorkingDays', 'specialHolidayDays', 'specialHolidayMultiplier', 'regularHolidayDays', 'regularHolidayMultiplier', 'incentivesAllowance', 'specialAllowance', 'lateUnits', 'lateDeduction', 'lateDeductionRate', 'halfDayCount', 'halfDayFraction', 'absentDays', 'overtimeHours', 'overtimeRate', 'manualAdjustment', 'adjustmentReason', 'approvedWorkingDayOverage', 'status',
]);


type CutoffInputBuilder = {
  value: CutoffFormInput;
  employee: SheetUser;
  profileId: string;
  cutoffLabel: string;
  number: (field: CutoffNumberField, fallback: number) => number;
};

type BackdatedAttendanceInput = {
  userId: string;
  attendanceDate: string;
  timeIn: string;
  timeOut?: string | null;
  reason: string;
};

function parseBackdatedAttendanceInput<T>(input: T): BackdatedAttendanceInput | null {
  if (!isInputObject(input)) return null;
  const userId = isString(input.userId) ? input.userId.trim() : '';
  const attendanceDate = isString(input.attendanceDate) ? input.attendanceDate.trim() : '';
  const timeIn = isString(input.timeIn) ? input.timeIn.trim() : '';
  const timeOut = isString(input.timeOut) ? input.timeOut.trim() : null;
  const reason = isString(input.reason) ? input.reason.trim() : '';
  if (!userId || !attendanceDate || !timeIn || !reason) return null;
  return { userId, attendanceDate, timeIn, timeOut, reason };
}
