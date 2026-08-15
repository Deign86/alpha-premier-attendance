import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { google, type sheets_v4, type drive_v3 } from 'googleapis';
import { normalizeRfidUid } from './rfid.js';
import { manilaTimestamp } from './time.js';
import type { PayrollCalculationProfile, PayrollCutoffRecord } from '@rfid-attendance/shared';
import { isLateTimeout } from '@rfid-attendance/shared';
import { defaultPayrollProfiles } from './cutoff-payroll.js';

export type SheetUser = {
  userId: string;
  fullName: string;
  rfidUid: string;
  department: string | null;
  active: boolean;
  employeeType?: 'INTERN' | 'EMPLOYEE';
  gender?: 'MALE' | 'FEMALE' | null;
  dailyRate?: number | null;
  payrollProfileId?: string | null;
  photoUrl?: string | null;
};

export type SheetPayroll = {
  payrollId: string; attendanceId: string; userId: string; fullName: string; employeeType: 'INTERN' | 'EMPLOYEE'; attendanceDate: string;
  actualTimeIn: string; actualTimeOut: string; computedTimeIn: string; computedTimeOut: string; graceUsed: boolean | null;
  lateHours: number; lateDeduction: number; basePay: number; dailyPay: number; notes: string; rowNumber?: number;
};
export type SheetPayrollProfile = PayrollCalculationProfile & { rowNumber?: number };
export type SheetPayrollCutoff = PayrollCutoffRecord & { rowNumber?: number };

export type SheetInternGrace = { graceId: string; userId: string; weekStart: string; attendanceId: string; usedAt: string; rowNumber?: number };

export type SheetAttendance = {
  attendanceId: string;
  attendanceDate: string;
  userId: string;
  rfidUid: string;
  fullName: string;
  department: string | null;
  timeIn: string;
  timeOut: string | null;
  status: 'WORKING' | 'COMPLETED' | 'MISSED' | 'LATE_TIMEOUT';
  source: 'RFID' | 'MANUAL_TEST';
  notes: string;
  rowNumber?: number;
};

export type AuditEvent = {
  eventType: 'SCAN_SUCCESS' | 'UNKNOWN_CARD' | 'INACTIVE_USER' | 'DUPLICATE_SCAN' | 'ATTENDANCE_COMPLETED' | 'API_ERROR' | 'VALIDATION_ERROR' | 'ADMIN_USER_CREATED' | 'ADMIN_USER_UPDATED' | 'ADMIN_USER_DELETED' | 'ADMIN_ATTENDANCE_UPDATED' | 'ADMIN_ATTENDANCE_DELETED';
  rfidUid?: string;
  userId?: string;
  message: string;
  requestId: string;
};

export interface GoogleSheetsService {
  listUsers(): Promise<SheetUser[]>;
  listAttendance(attendanceDate: string): Promise<SheetAttendance[]>;
  findUserByUid(uid: string): Promise<SheetUser | null>;
  findUserById(userId: string): Promise<SheetUser | null>;
  upsertUser(user: SheetUser): Promise<SheetUser>;
  deleteUser(userId: string): Promise<void>;
  findAttendance(userId: string, attendanceDate: string): Promise<SheetAttendance | null>;
  createAttendance(attendance: SheetAttendance): Promise<SheetAttendance>;
  completeAttendance(attendance: SheetAttendance, timeOut: string): Promise<SheetAttendance>;
  updateAttendance(attendance: SheetAttendance, expected: { timeIn: string | null; timeOut: string | null }): Promise<SheetAttendance>;
  deleteAttendance(attendanceId: string, attendanceDate: string): Promise<void>;
  findPayrollByAttendanceId(attendanceId: string): Promise<SheetPayroll | null>;
  createPayroll(payroll: SheetPayroll): Promise<SheetPayroll>;
  deletePayrollByAttendanceId(attendanceId: string): Promise<void>;
  listPayrollProfiles(): Promise<SheetPayrollProfile[]>;
  upsertPayrollProfile(profile: SheetPayrollProfile): Promise<SheetPayrollProfile>;
  listPayrollCutoffs(): Promise<SheetPayrollCutoff[]>;
  findPayrollCutoff(payrollId: string): Promise<SheetPayrollCutoff | null>;
  upsertPayrollCutoff(payroll: SheetPayrollCutoff): Promise<SheetPayrollCutoff>;
  deletePayrollCutoff(payrollId: string): Promise<void>;
  findInternGrace(userId: string, weekStart: string): Promise<SheetInternGrace | null>;
  claimInternGrace(grace: SheetInternGrace): Promise<SheetInternGrace>;
  writeAudit(event: AuditEvent): Promise<void>;
  healthCheck(): Promise<void>;
}

export class InMemorySheetsService implements GoogleSheetsService {
  private readonly users: SheetUser[];
  private readonly attendance: SheetAttendance[];
  private readonly payroll: SheetPayroll[] = [];
  private readonly grace: SheetInternGrace[] = [];
  private readonly payrollProfiles: SheetPayrollProfile[] = [];
  private readonly payrollCutoffs: SheetPayrollCutoff[] = [];
  readonly audits: AuditEvent[] = [];

  constructor(users: SheetUser[] = [], attendance: SheetAttendance[] = []) {
    this.users = users.map((user) => ({ ...user, rfidUid: normalizeRfidUid(user.rfidUid) }));
    this.attendance = attendance.map((row) => ({ ...row }));
    this.payrollProfiles.push(...defaultPayrollProfiles.map((profile) => ({ ...profile })));
  }

  async findUserByUid(uid: string): Promise<SheetUser | null> {
    const matches = this.users.filter((user) => user.rfidUid === uid);
    if (matches.length > 1) throw new Error('Duplicate RFID UID in Users sheet');
    return matches[0] ?? null;
  }

  async listUsers(): Promise<SheetUser[]> { return this.users.map((user) => ({ ...user })); }

  async listAttendance(attendanceDate: string): Promise<SheetAttendance[]> {
    return this.attendance.filter((row) => row.attendanceDate === attendanceDate).map((row) => ({ ...row }));
  }

  async findUserById(userId: string): Promise<SheetUser | null> {
    const matches = this.users.filter((user) => user.userId === userId);
    if (matches.length > 1) throw new Error('Duplicate user ID in Users sheet');
    return matches[0] ? { ...matches[0] } : null;
  }

  async upsertUser(user: SheetUser): Promise<SheetUser> {
    const uidMatches = this.users.filter((item) => item.rfidUid === user.rfidUid);
    if (uidMatches.some((item) => item.userId !== user.userId)) throw new Error('Duplicate RFID UID in Users sheet');
    const idMatches = this.users.filter((item) => item.userId === user.userId);
    if (idMatches.length > 1) throw new Error('Duplicate user ID in Users sheet');
    const existing = idMatches[0];
    if (existing) Object.assign(existing, { ...user, rfidUid: normalizeRfidUid(user.rfidUid) });
    else this.users.push({ ...user, rfidUid: normalizeRfidUid(user.rfidUid) });
    return { ...(existing ?? this.users[this.users.length - 1]) };
  }

  async deleteUser(userId: string): Promise<void> {
    const index = this.users.findIndex((user) => user.userId === userId);
    if (index < 0) throw new Error('User row was not found');
    this.users.splice(index, 1);
  }

  async findAttendance(userId: string, attendanceDate: string): Promise<SheetAttendance | null> {
    const matches = this.attendance.filter((row) => row.userId === userId && row.attendanceDate === attendanceDate);
    if (matches.length > 1) throw new Error('Duplicate attendance rows for user and date');
    return matches[0] ? { ...matches[0] } : null;
  }

  async createAttendance(attendance: SheetAttendance): Promise<SheetAttendance> {
    this.attendance.push({ ...attendance });
    return { ...attendance };
  }

  async completeAttendance(attendance: SheetAttendance, timeOut: string): Promise<SheetAttendance> {
    const row = this.attendance.find((item) => item.attendanceId === attendance.attendanceId);
    if (!row || row.status !== 'WORKING' || row.timeOut) throw new Error('Attendance row is no longer working');
    row.timeOut = timeOut;
    row.status = isLateTimeout(timeOut) ? 'LATE_TIMEOUT' : 'COMPLETED';
    return { ...row };
  }

  async updateAttendance(attendance: SheetAttendance, expected: { timeIn: string | null; timeOut: string | null }): Promise<SheetAttendance> {
    const row = this.attendance.find((item) => item.attendanceId === attendance.attendanceId);
    if (!row || (row.timeIn || null) !== expected.timeIn || (row.timeOut || null) !== expected.timeOut) throw new Error('Attendance row has changed');
    Object.assign(row, attendance);
    return { ...row };
  }

  async deleteAttendance(attendanceId: string, attendanceDate: string): Promise<void> {
    const index = this.attendance.findIndex((row) => row.attendanceId === attendanceId && row.attendanceDate === attendanceDate);
    if (index < 0) throw new Error('Attendance row was not found');
    this.attendance.splice(index, 1);
  }

  async findPayrollByAttendanceId(attendanceId: string): Promise<SheetPayroll | null> {
    const matches = this.payroll.filter((row) => row.attendanceId === attendanceId);
    if (matches.length > 1) throw new Error('Duplicate payroll rows for attendance');
    return matches[0] ? { ...matches[0] } : null;
  }

  async createPayroll(payroll: SheetPayroll): Promise<SheetPayroll> {
    if (await this.findPayrollByAttendanceId(payroll.attendanceId)) throw new Error('Payroll already exists for attendance');
    this.payroll.push({ ...payroll });
    return { ...payroll };
  }
  async deletePayrollByAttendanceId(attendanceId: string): Promise<void> { const index = this.payroll.findIndex((row) => row.attendanceId === attendanceId); if (index >= 0) this.payroll.splice(index, 1); }
  async listPayrollProfiles(): Promise<SheetPayrollProfile[]> { return this.payrollProfiles.map((row) => ({ ...row })); }
  async upsertPayrollProfile(profile: SheetPayrollProfile): Promise<SheetPayrollProfile> { const existing = this.payrollProfiles.find((row) => row.profileId === profile.profileId); if (existing) Object.assign(existing, profile); else this.payrollProfiles.push({ ...profile }); return { ...(existing ?? this.payrollProfiles[this.payrollProfiles.length - 1]) }; }
  async listPayrollCutoffs(): Promise<SheetPayrollCutoff[]> { return this.payrollCutoffs.map((row) => ({ ...row })); }
  async findPayrollCutoff(payrollId: string): Promise<SheetPayrollCutoff | null> { const row = this.payrollCutoffs.find((item) => item.payrollId === payrollId); return row ? { ...row } : null; }
  async upsertPayrollCutoff(payroll: SheetPayrollCutoff): Promise<SheetPayrollCutoff> { const existing = this.payrollCutoffs.find((row) => row.payrollId === payroll.payrollId); if (existing) Object.assign(existing, payroll); else this.payrollCutoffs.push({ ...payroll }); return { ...(existing ?? this.payrollCutoffs[this.payrollCutoffs.length - 1]) }; }
  async deletePayrollCutoff(payrollId: string): Promise<void> { const index = this.payrollCutoffs.findIndex((row) => row.payrollId === payrollId); if (index >= 0) this.payrollCutoffs.splice(index, 1); }

  async findInternGrace(userId: string, weekStart: string): Promise<SheetInternGrace | null> {
    const matches = this.grace.filter((row) => row.userId === userId && row.weekStart === weekStart);
    if (matches.length > 1) throw new Error('Duplicate intern grace rows');
    return matches[0] ? { ...matches[0] } : null;
  }

  async claimInternGrace(grace: SheetInternGrace): Promise<SheetInternGrace> {
    if (await this.findInternGrace(grace.userId, grace.weekStart)) throw new Error('Intern grace already claimed');
    this.grace.push({ ...grace });
    return { ...grace };
  }

  async writeAudit(event: AuditEvent): Promise<void> {
    this.audits.push({ ...event });
  }

  async healthCheck(): Promise<void> { return undefined; }
}

type GoogleSheetsOptions = {
  spreadsheetId?: string;
  spreadsheetTitle?: string;
  clientEmail?: string;
  privateKey?: string;
  driveFolderId?: string;
  driveFolderName?: string;
  createFolderIfMissing?: boolean;
  stateFile?: string;
  usersRange?: string;
  attendanceRange?: string;
  auditRange?: string;
  payrollRange?: string;
  internGraceRange?: string;
  payrollProfilesRange?: string;
  payrollCutoffsRange?: string;
};

type ResolvedGoogleSheetsOptions = {
  spreadsheetId: string;
  spreadsheetTitle: string;
  clientEmail: string;
  privateKey: string;
  driveFolderId?: string;
  driveFolderName: string;
  createFolderIfMissing: boolean;
  stateFile?: string;
  usersRange: string;
  attendanceRange: string;
  auditRange: string;
  payrollRange: string;
  internGraceRange: string;
  payrollProfilesRange: string;
  payrollCutoffsRange: string;
};

type GoogleSheetsState = {
  version: number;
  driveFolderId?: string;
  spreadsheetId?: string;
};

type Table = { headers: string[]; rows: string[][] };

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
];

const requiredHeaders = {
  Users: ['userid', 'rfiduid', 'fullname', 'department', 'status', 'createdat', 'employeetype', 'dailyrate', 'photourl'],
  Attendance: ['attendanceid', 'attendancedate', 'userid', 'rfiduid', 'fullname', 'department', 'timein', 'timeout', 'status', 'source', 'notes'],
  AuditLogs: ['logid', 'timestamp', 'eventtype', 'rfiduid', 'userid', 'message', 'requestid'],
  Payroll: ['payrollid', 'attendanceid', 'userid', 'fullname', 'employeetype', 'attendancedate', 'actualtimein', 'actualtimeout', 'computedtimein', 'computedtimeout', 'graceused', 'latehours', 'latededuction', 'basepay', 'dailypay', 'notes'],
  InternGrace: ['graceid', 'userid', 'weekstart', 'attendanceid', 'usedat'],
  PayrollProfiles: ['profileid', 'label', 'payrollfrequency', 'standardworkingdayspercutoff', 'incentivesallowance', 'specialallowance', 'specialholidaymultiplier', 'regularholidaymultiplier', 'halfdayfraction', 'overtimerate'],
  PayrollCutoffs: ['payrollid', 'employeeid', 'employeename', 'payrollprofileid', 'payrollcutofflabel', 'cutoffstart', 'cutoffend', 'payrollfrequency', 'dailyrate', 'standardworkingdays', 'actualworkingdays', 'basicpay', 'specialholidaydays', 'specialholidaymultiplier', 'specialholidaypay', 'regularholidaydays', 'regularholidaymultiplier', 'regularholidaypay', 'incentivesallowance', 'specialallowance', 'totalcompensation', 'totalallowance', 'lateunits', 'latededuction', 'halfdaycount', 'halfdaydeduction', 'absentdays', 'absencededuction', 'overtimehours', 'overtimerate', 'overtimepay', 'manualadjustment', 'adjustmentreason', 'grosscompensation', 'netpay', 'calculationbreakdown', 'approvedworkingdayoverage', 'status', 'finalizedat'],
} as const;
const optionalHeaders = { Users: ['payrollprofileid'] } as const;

/**
 * Human-readable row-1 headers written when the adapter creates or repairs a
 * tab. They mirror the operator runbook and canonicalize to `requiredHeaders`
 * when read back, so existing snake_case and legacy flat header styles both
 * validate.
 */
const sheetHeaderLabels: Record<keyof typeof requiredHeaders, string[]> = {
  Users: ['user_id', 'rfid_uid', 'full_name', 'department', 'status', 'created_at', 'employee_type', 'daily_rate', 'photo_url', 'payroll_profile_id'],
  Attendance: ['attendance_id', 'attendance_date', 'user_id', 'rfid_uid', 'full_name', 'department', 'time_in', 'time_out', 'status', 'source', 'notes'],
  AuditLogs: ['log_id', 'timestamp', 'event_type', 'rfid_uid', 'user_id', 'message', 'request_id'],
  Payroll: ['payroll_id', 'attendance_id', 'user_id', 'full_name', 'employee_type', 'attendance_date', 'actual_time_in', 'actual_time_out', 'computed_time_in', 'computed_time_out', 'grace_used', 'late_hours', 'late_deduction', 'base_pay', 'daily_pay', 'notes'],
  InternGrace: ['grace_id', 'user_id', 'week_start', 'attendance_id', 'used_at'],
  PayrollProfiles: ['profile_id', 'label', 'payroll_frequency', 'standard_working_days_per_cutoff', 'incentives_allowance', 'special_allowance', 'special_holiday_multiplier', 'regular_holiday_multiplier', 'half_day_fraction', 'overtime_rate'],
  PayrollCutoffs: ['payroll_id', 'employee_id', 'employee_name', 'payroll_profile_id', 'payroll_cutoff_label', 'cutoff_start', 'cutoff_end', 'payroll_frequency', 'daily_rate', 'standard_working_days', 'actual_working_days', 'basic_pay', 'special_holiday_days', 'special_holiday_multiplier', 'special_holiday_pay', 'regular_holiday_days', 'regular_holiday_multiplier', 'regular_holiday_pay', 'incentives_allowance', 'special_allowance', 'total_compensation', 'total_allowance', 'late_units', 'late_deduction', 'half_day_count', 'half_day_deduction', 'absent_days', 'absence_deduction', 'overtime_hours', 'overtime_rate', 'overtime_pay', 'manual_adjustment', 'adjustment_reason', 'gross_compensation', 'net_pay', 'calculation_breakdown', 'approved_working_day_overage', 'status', 'finalized_at'],
};

export class GoogleSheetsAdapter implements GoogleSheetsService {
  private readonly api: sheets_v4.Sheets;
  private driveApi?: drive_v3.Drive;
  private authInstance?: InstanceType<typeof google.auth.JWT>;
  private readonly options: ResolvedGoogleSheetsOptions;
  private state: GoogleSheetsState | undefined;

  constructor(options: GoogleSheetsOptions = {}, api?: sheets_v4.Sheets, driveApi?: drive_v3.Drive) {
    this.options = {
      spreadsheetId: options.spreadsheetId ?? '',
      spreadsheetTitle: options.spreadsheetTitle ?? 'Alpha Premier Attendance',
      clientEmail: options.clientEmail ?? '',
      privateKey: options.privateKey ?? '',
      driveFolderId: options.driveFolderId,
      driveFolderName: options.driveFolderName ?? 'Alpha Premier Attendance',
      createFolderIfMissing: options.createFolderIfMissing ?? false,
      stateFile: options.stateFile,
      usersRange: options.usersRange ?? 'Users',
      attendanceRange: options.attendanceRange ?? 'Attendance',
      auditRange: options.auditRange ?? 'AuditLogs',
      payrollRange: options.payrollRange ?? 'Payroll',
      internGraceRange: options.internGraceRange ?? 'InternGrace',
      payrollProfilesRange: options.payrollProfilesRange ?? 'PayrollProfiles',
      payrollCutoffsRange: options.payrollCutoffsRange ?? 'PayrollCutoffs',
    };
    if (driveApi) this.driveApi = driveApi;
    this.api = api ?? google.sheets({ version: 'v4', auth: this.auth });
  }

  private get auth(): InstanceType<typeof google.auth.JWT> {
    if (!this.authInstance) {
      this.authInstance = new google.auth.JWT({
        email: this.options.clientEmail,
        key: this.options.privateKey,
        scopes: GOOGLE_SCOPES,
      });
    }
    return this.authInstance;
  }

  private get drive(): drive_v3.Drive {
    if (!this.driveApi) this.driveApi = google.drive({ version: 'v3', auth: this.auth });
    return this.driveApi;
  }

  private readonly headersCache = new Map<keyof typeof requiredHeaders, { headers: string[]; fetchedAt: number }>();
  private readonly HEADER_CACHE_TTL_MS = 60_000;

  private async values(range: string): Promise<string[][]> {
    const result = await this.api.spreadsheets.values.get({ spreadsheetId: this.options.spreadsheetId, range });
    return (result.data.values ?? []) as string[][];
  }

  private rangeFor(sheet: keyof typeof requiredHeaders): string {
    switch (sheet) {
      case 'Users': return this.options.usersRange;
      case 'Attendance': return this.options.attendanceRange;
      case 'AuditLogs': return this.options.auditRange;
      case 'Payroll': return this.options.payrollRange;
      case 'InternGrace': return this.options.internGraceRange;
      case 'PayrollProfiles': return this.options.payrollProfilesRange;
      case 'PayrollCutoffs': return this.options.payrollCutoffsRange;
    }
  }

  private tabSpecs(): Array<{ sheet: keyof typeof requiredHeaders; title: string; headers: string[] }> {
    return [
      { sheet: 'Users', title: this.options.usersRange, headers: sheetHeaderLabels.Users },
      { sheet: 'Attendance', title: this.options.attendanceRange, headers: sheetHeaderLabels.Attendance },
      { sheet: 'AuditLogs', title: this.options.auditRange, headers: sheetHeaderLabels.AuditLogs },
      { sheet: 'Payroll', title: this.options.payrollRange, headers: sheetHeaderLabels.Payroll },
      { sheet: 'InternGrace', title: this.options.internGraceRange, headers: sheetHeaderLabels.InternGrace },
      { sheet: 'PayrollProfiles', title: this.options.payrollProfilesRange, headers: sheetHeaderLabels.PayrollProfiles },
      { sheet: 'PayrollCutoffs', title: this.options.payrollCutoffsRange, headers: sheetHeaderLabels.PayrollCutoffs },
    ];
  }

  private async getState(): Promise<GoogleSheetsState> {
    if (!this.state) this.state = await this.readState();
    return this.state;
  }

  private async readState(): Promise<GoogleSheetsState> {
    if (!this.options.stateFile) return { version: 1 };
    const file = path.resolve(this.options.stateFile);
    let raw: string;
    try {
      raw = await fs.promises.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1 };
      throw new Error(`Google Sheets state file is not readable: ${file}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Google Sheets state file is not valid JSON: ${file}`);
    }
    const value = parsed as Partial<GoogleSheetsState> | null;
    return {
      version: typeof value?.version === 'number' ? value.version : 1,
      driveFolderId: typeof value?.driveFolderId === 'string' && value.driveFolderId ? value.driveFolderId : undefined,
      spreadsheetId: typeof value?.spreadsheetId === 'string' && value.spreadsheetId ? value.spreadsheetId : undefined,
    };
  }

  private async writeState(patch: Partial<GoogleSheetsState>): Promise<void> {
    const current = this.state ?? await this.readState();
    this.state = { ...current, ...patch, version: patch.version ?? current.version ?? 1 };
    if (!this.options.stateFile) return;
    const file = path.resolve(this.options.stateFile);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.promises.writeFile(temp, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.promises.rename(temp, file);
  }

  private async driveFolderExists(folderId: string): Promise<boolean> {
    try {
      const result = await this.drive.files.get({ fileId: folderId, fields: 'id, mimeType', supportsAllDrives: true });
      return result.data.mimeType === 'application/vnd.google-apps.folder';
    } catch (error) {
      if (googleApiStatus(error) === 404) return false;
      throw error;
    }
  }

  private async createDriveFolder(name: string): Promise<string> {
    const result = await this.drive.files.create({
      requestBody: { name, mimeType: 'application/vnd.google-apps.folder' },
      fields: 'id',
      supportsAllDrives: true,
    });
    const id = result.data.id;
    if (!id) throw new Error('Google Drive did not return a folder ID');
    return id;
  }

  private async resolveTargetFolder(): Promise<string | null> {
    const configured = this.options.driveFolderId;
    if (configured) {
      if (await this.driveFolderExists(configured)) return configured;
      if (this.options.createFolderIfMissing) {
        const id = await this.createDriveFolder(this.options.driveFolderName);
        await this.writeState({ driveFolderId: id });
        return id;
      }
      throw new Error(`Google Drive folder ${configured} is not accessible`);
    }

    const state = await this.getState();
    if (state.driveFolderId && await this.driveFolderExists(state.driveFolderId)) {
      return state.driveFolderId;
    }

    if (this.options.createFolderIfMissing) {
      const id = await this.createDriveFolder(this.options.driveFolderName);
      await this.writeState({ driveFolderId: id });
      return id;
    }

    return null;
  }

  private async spreadsheetExists(spreadsheetId: string): Promise<boolean> {
    try {
      await this.api.spreadsheets.get({ spreadsheetId, fields: 'spreadsheetId' });
      return true;
    } catch (error) {
      if (googleApiStatus(error) === 404) return false;
      throw error;
    }
  }

  private async createSpreadsheet(title: string, folderId: string | null): Promise<string> {
    const result = await this.api.spreadsheets.create({
      requestBody: { properties: { title } },
      fields: 'spreadsheetId',
    });
    const spreadsheetId = result.data.spreadsheetId;
    if (!spreadsheetId) throw new Error('Google Sheets did not return a spreadsheet ID');
    if (folderId) {
      await this.drive.files.update({ fileId: spreadsheetId, addParents: folderId, fields: 'id, parents', supportsAllDrives: true });
    }
    return spreadsheetId;
  }

  private async ensureSpreadsheetInFolder(spreadsheetId: string, folderId: string): Promise<void> {
    let parents: string[] = [];
    try {
      const metadata = await this.drive.files.get({ fileId: spreadsheetId, fields: 'id, parents', supportsAllDrives: true });
      parents = metadata.data.parents ?? [];
    } catch (error) {
      if (googleApiStatus(error) !== 404) throw error;
    }
    if (!parents.includes(folderId)) {
      const request: drive_v3.Params$Resource$Files$Update = {
        fileId: spreadsheetId,
        addParents: folderId,
        fields: 'id, parents',
        supportsAllDrives: true,
      };
      await this.drive.files.update(request);
    }
  }

  /**
   * Production entry point for the Drive folder auto-create/reuse path.
   *
   * 1. Resolve the target Drive folder from `driveFolderId`, the persisted
   *    state file, or a newly created folder when `createFolderIfMissing` is
   *    enabled.
   * 2. Reuse `spreadsheetId` when configured/persisted and still reachable;
   *    otherwise create a spreadsheet inside the resolved folder.
   * 3. Move an existing spreadsheet into the folder and reconcile the tab
   *    schema (create missing tabs, write missing headers, format new tabs,
   *    and seed default payroll profiles when the tab is empty).
   */
  async ensureSpreadsheet(): Promise<string> {
    const persisted = await this.getState();
    const folderId = await this.resolveTargetFolder();

    let spreadsheetId = this.options.spreadsheetId || persisted.spreadsheetId || '';
    const explicitSpreadsheetId = Boolean(this.options.spreadsheetId);

    if (spreadsheetId && !(await this.spreadsheetExists(spreadsheetId))) {
      if (explicitSpreadsheetId) {
        throw new Error(`Configured Google spreadsheet ${spreadsheetId} is not accessible`);
      }
      spreadsheetId = '';
    }

    if (!spreadsheetId) {
      if (!folderId) {
        throw new Error('A Google Drive folder is required to auto-create a spreadsheet. Set GOOGLE_DRIVE_FOLDER_ID or GOOGLE_CREATE_FOLDER_IF_MISSING.');
      }
      spreadsheetId = await this.createSpreadsheet(this.options.spreadsheetTitle, folderId);
      await this.writeState({ spreadsheetId });
    } else if (folderId) {
      await this.ensureSpreadsheetInFolder(spreadsheetId, folderId);
    }

    this.options.spreadsheetId = spreadsheetId;
    // Persist the effective target even when it was supplied explicitly. This
    // makes the target durable for later folder-based migrations without ever
    // replacing the explicit GOOGLE_SHEET_ID precedence.
    await this.writeState({ spreadsheetId });

    await this.reconcileTabs();

    if (folderId) await this.writeState({ driveFolderId: folderId });

    return spreadsheetId;
  }

  private async writeHeaderRow(title: string, headers: string[]): Promise<void> {
    await this.api.spreadsheets.values.update({
      spreadsheetId: this.options.spreadsheetId,
      range: `${quoteA1SheetTitle(title)}!A1:${columnName(headers.length - 1)}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });
  }

  private async formatTabs(sheetIds: Map<string, { sheetId: number; columnCount: number }>): Promise<void> {
    if (sheetIds.size === 0) return;
    const requests: sheets_v4.Schema$Request[] = [];
    for (const { sheetId, columnCount } of sheetIds.values()) {
      requests.push(
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: columnCount },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true },
                backgroundColorStyle: { rgbColor: { red: 0.85, green: 0.87, blue: 0.93 } },
              },
            },
            fields: 'userEnteredFormat(textFormat,backgroundColorStyle)',
          },
        },
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount',
          },
        },
        {
          autoResizeDimensions: {
            dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: columnCount },
          },
        },
      );
    }
    await this.api.spreadsheets.batchUpdate({
      spreadsheetId: this.options.spreadsheetId,
      requestBody: { requests },
    });
  }

  private async reconcileTabs(): Promise<void> {
    const spreadsheetId = this.options.spreadsheetId;
    const metadata = await this.api.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(sheetId,title))' });
    const existing = new Map<string, number>();
    for (const sheet of metadata.data.sheets ?? []) {
      const title = sheet.properties?.title;
      const sheetId = sheet.properties?.sheetId;
      if (title && typeof sheetId === 'number') existing.set(title, sheetId);
    }

    const specs = this.tabSpecs();
    const missing = specs.filter((spec) => !existing.has(spec.title));
    const toFormat = new Map<string, { sheetId: number; columnCount: number }>();

    const addRequests = missing.map((spec) => ({ addSheet: { properties: { title: spec.title } } }));
    if (addRequests.length > 0) {
      const result = await this.api.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: addRequests },
      });
      result.data.replies?.forEach((reply, index) => {
        const spec = missing[index];
        const sheetId = reply.addSheet?.properties?.sheetId;
        if (spec && typeof sheetId === 'number') toFormat.set(spec.title, { sheetId, columnCount: spec.headers.length });
      });
    }

    for (const spec of missing) {
      await this.writeHeaderRow(spec.title, spec.headers);
    }

    for (const spec of specs) {
      if (existing.has(spec.title)) {
        const rows = await this.values(`${quoteA1SheetTitle(spec.title)}!1:1`);
        const headerRow = rows[0] ?? [];
        if (headerRow.length === 0 || headerRow.every((cell) => String(cell ?? '').trim() === '')) {
          await this.writeHeaderRow(spec.title, spec.headers);
          const sheetId = existing.get(spec.title);
          if (typeof sheetId === 'number') toFormat.set(spec.title, { sheetId, columnCount: spec.headers.length });
        } else {
          try {
            validateHeaders(spec.sheet, headerRow.map(canonicalHeader));
          } catch (error) {
            throw new Error(`Invalid ${spec.title} sheet headers: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
          }
        }
      }
    }

    await this.formatTabs(toFormat);

    // Seed adapter-owned defaults so the admin workspace reads the same
    // profiles as the in-memory adapter, but never overwrite operator data.
    await this.seedDefaultPayrollProfiles();
  }

  private async seedDefaultPayrollProfiles(): Promise<void> {
    const { rows } = await this.table(this.options.payrollProfilesRange, 'PayrollProfiles');
    if (rows.length > 0) return;
    const headers = [...requiredHeaders.PayrollProfiles];
    const values = defaultPayrollProfiles.map((profile) => valuesForPayrollProfile(headers, profile));
    await this.api.spreadsheets.values.append({
      spreadsheetId: this.options.spreadsheetId,
      range: this.options.payrollProfilesRange,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    });
  }

  /**
   * Canonicalized + validated headers for a sheet, served from a short TTL
   * cache. On the scan path every target sheet was already read by `table()`,
   * so this adds no round trip; a cold-cache sheet (e.g. AuditLogs, which is
   * only ever written) costs one read.
   */
  private async headersFor(sheet: keyof typeof requiredHeaders): Promise<string[]> {
    const cached = this.headersCache.get(sheet);
    if (cached && Date.now() - cached.fetchedAt < this.HEADER_CACHE_TTL_MS) return cached.headers;
    const rows = await this.values(this.rangeFor(sheet));
    const headers = (rows[0] ?? []).map(canonicalHeader);
    validateHeaders(sheet, headers);
    this.headersCache.set(sheet, { headers, fetchedAt: Date.now() });
    return headers;
  }

  private async table(range: string, sheet: keyof typeof requiredHeaders): Promise<Table> {
    const rows = await this.values(range);
    const headers = (rows[0] ?? []).map(canonicalHeader);
    validateHeaders(sheet, headers);
    this.headersCache.set(sheet, { headers, fetchedAt: Date.now() });
    return { headers, rows: rows.slice(1) };
  }

  async findUserByUid(uid: string): Promise<SheetUser | null> {
    const { headers, rows } = await this.table(this.options.usersRange, 'Users');
    const index = indexMap(headers);
    const matches = rows.filter((row) => normalizeCell(row[index.rfiduid]) === uid);
    if (matches.length > 1) throw new Error('Duplicate RFID UID in Users sheet');
    const row = matches[0];
    if (!row) return null;
    return {
      userId: row[index.userid] ?? '',
      rfidUid: uid,
      fullName: row[index.fullname] ?? '',
      department: row[index.department] || null,
      active: String(row[index.status] ?? '').trim().toUpperCase() === 'ACTIVE',
      employeeType: String(row[index.employeetype] ?? '').trim().toUpperCase() === 'EMPLOYEE' ? 'EMPLOYEE' : 'INTERN',
      dailyRate: parseRate(row[index.dailyrate]),
      payrollProfileId: row[index.payrollprofileid] || null,
      photoUrl: row[index.photourl] || null,
    };
  }

  async listUsers(): Promise<SheetUser[]> {
    const { headers, rows } = await this.table(this.options.usersRange, 'Users');
    const index = indexMap(headers);
    return rows.map((row) => userFromRow(row, index));
  }

  async listAttendance(attendanceDate: string): Promise<SheetAttendance[]> {
    const { headers, rows } = await this.table(this.options.attendanceRange, 'Attendance');
    const index = indexMap(headers);
    return rows.flatMap((row, offset) => row[index.attendancedate] === attendanceDate ? [attendanceFromRow(row, index, offset + 2)] : []);
  }

  async findUserById(userId: string): Promise<SheetUser | null> {
    const { headers, rows } = await this.table(this.options.usersRange, 'Users');
    const index = indexMap(headers);
    const matches = rows.filter((row) => row[index.userid] === userId);
    if (matches.length > 1) throw new Error('Duplicate user ID in Users sheet');
    const row = matches[0];
    if (!row) return null;
    return userFromRow(row, index);
  }

  async upsertUser(user: SheetUser): Promise<SheetUser> {
    const { headers, rows } = await this.table(this.options.usersRange, 'Users');
    const index = indexMap(headers);
    const uid = normalizeRfidUid(user.rfidUid);
    const uidMatches = rows.flatMap((row, offset) => normalizeCell(row[index.rfiduid]) === uid ? [{ row, rowNumber: offset + 2 }] : []);
    const idMatches = rows.flatMap((row, offset) => row[index.userid] === user.userId ? [{ row, rowNumber: offset + 2 }] : []);
    if (uidMatches.length > 1 || idMatches.length > 1) throw new Error('Duplicate user row in Users sheet');
    if (uidMatches[0] && uidMatches[0].row[index.userid] !== user.userId) throw new Error('Duplicate RFID UID in Users sheet');
    const values = valuesForUser(headers, user, idMatches[0]?.row);
    if (idMatches[0]) {
      const rowNumber = idMatches[0].rowNumber;
      await this.api.spreadsheets.values.update({
        spreadsheetId: this.options.spreadsheetId,
        range: `${quoteA1SheetTitle(sheetName(this.options.usersRange))}!A${rowNumber}:${columnName(headers.length - 1)}${rowNumber}`,
        valueInputOption: 'RAW',
        requestBody: { values: [values] },
      });
    } else {
      await this.api.spreadsheets.values.append({
        spreadsheetId: this.options.spreadsheetId,
        range: this.options.usersRange,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [values] },
      });
    }
    return { ...user, rfidUid: uid };
  }

  async deleteUser(userId: string): Promise<void> {
    const { headers, rows } = await this.table(this.options.usersRange, 'Users');
    const index = indexMap(headers);
    const matches = rows.flatMap((row, offset) => row[index.userid] === userId ? [offset + 2] : []);
    if (matches.length !== 1) throw new Error('User row was not found or is duplicated');
    await this.deleteRow(this.options.usersRange, matches[0]);
  }

  async findAttendance(userId: string, attendanceDate: string): Promise<SheetAttendance | null> {
    const { headers, rows } = await this.table(this.options.attendanceRange, 'Attendance');
    const index = indexMap(headers);
    const matches = rows.flatMap((row, offset) => row[index.userid] === userId && row[index.attendancedate] === attendanceDate ? [{ row, rowNumber: offset + 2 }] : []);
    if (matches.length > 1) throw new Error('Duplicate attendance rows for user and date');
    const match = matches[0];
    if (!match) return null;
    const row = match.row;
    return {
      attendanceId: row[index.attendanceid] ?? '',
      attendanceDate: row[index.attendancedate] ?? attendanceDate,
      userId: row[index.userid] ?? userId,
      rfidUid: row[index.rfiduid] ?? '',
      fullName: row[index.fullname] ?? '',
      department: row[index.department] || null,
      timeIn: row[index.timein] ?? '',
      timeOut: row[index.timeout] || null,
      status: normalizeAttendanceStatus(row[index.status]),
      source: String(row[index.source] ?? '').trim().toUpperCase() === 'MANUAL_TEST' ? 'MANUAL_TEST' : 'RFID',
      notes: row[index.notes] ?? '',
      rowNumber: match.rowNumber,
    };
  }

  async createAttendance(attendance: SheetAttendance): Promise<SheetAttendance> {
    const headers = await this.headersFor('Attendance');
    await this.api.spreadsheets.values.append({
      spreadsheetId: this.options.spreadsheetId,
      range: this.options.attendanceRange,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [valuesForAttendance(headers, attendance)] },
    });
    return attendance;
  }

  async completeAttendance(attendance: SheetAttendance, timeOut: string): Promise<SheetAttendance> {
    if (!attendance.rowNumber) throw new Error('Attendance row number unavailable');
    const headers = await this.headersFor('Attendance');
    const index = indexMap(headers);
    const rowRange = `${sheetName(this.options.attendanceRange)}!A${attendance.rowNumber}:${columnName(headers.length - 1)}${attendance.rowNumber}`;
    const existing = (await this.values(rowRange))[0];
    if (!existing || existing[index.attendanceid] !== attendance.attendanceId || existing[index.status] !== 'WORKING' || existing[index.timeout]) throw new Error('Attendance row is no longer working');
    const updated = { ...attendance, timeOut, status: isLateTimeout(timeOut) ? 'LATE_TIMEOUT' as const : 'COMPLETED' as const };
    await this.api.spreadsheets.values.update({
      spreadsheetId: this.options.spreadsheetId,
      range: rowRange,
      valueInputOption: 'RAW',
      requestBody: { values: [valuesForAttendance(headers, updated, existing)] },
    });
    return updated;
  }

  async updateAttendance(attendance: SheetAttendance, expected: { timeIn: string | null; timeOut: string | null }): Promise<SheetAttendance> {
    if (!attendance.rowNumber) throw new Error('Attendance row number unavailable');
    const headers = await this.headersFor('Attendance');
    const index = indexMap(headers);
    const rowRange = `${sheetName(this.options.attendanceRange)}!A${attendance.rowNumber}:${columnName(headers.length - 1)}${attendance.rowNumber}`;
    const existing = (await this.values(rowRange))[0];
    if (!existing || existing[index.attendanceid] !== attendance.attendanceId || (existing[index.timein] || null) !== expected.timeIn || (existing[index.timeout] || null) !== expected.timeOut) throw new Error('Attendance row has changed');
    await this.api.spreadsheets.values.update({
      spreadsheetId: this.options.spreadsheetId,
      range: rowRange,
      valueInputOption: 'RAW',
      requestBody: { values: [valuesForAttendance(headers, attendance, existing)] },
    });
    return attendance;
  }

  async deleteAttendance(attendanceId: string, attendanceDate: string): Promise<void> {
    const { headers, rows } = await this.table(this.options.attendanceRange, 'Attendance');
    const index = indexMap(headers);
    const matches = rows.flatMap((row, offset) => row[index.attendanceid] === attendanceId && row[index.attendancedate] === attendanceDate ? [offset + 2] : []);
    if (matches.length !== 1) throw new Error('Attendance row was not found or is duplicated');
    await this.deleteRow(this.options.attendanceRange, matches[0]);
  }

  async findPayrollByAttendanceId(attendanceId: string): Promise<SheetPayroll | null> {
    const { headers, rows } = await this.table(this.options.payrollRange, 'Payroll');
    const index = indexMap(headers);
    const matches = rows.flatMap((row, offset) => row[index.attendanceid] === attendanceId ? [payrollFromRow(row, index, offset + 2)] : []);
    if (matches.length > 1) throw new Error('Duplicate payroll rows for attendance');
    return matches[0] ?? null;
  }

  async createPayroll(payroll: SheetPayroll): Promise<SheetPayroll> {
    const headers = await this.headersFor('Payroll');
    await this.api.spreadsheets.values.append({ spreadsheetId: this.options.spreadsheetId, range: this.options.payrollRange, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [valuesForPayroll(headers, payroll)] } });
    return payroll;
  }
  async deletePayrollByAttendanceId(attendanceId: string): Promise<void> {
    const { rows } = await this.table(this.options.payrollRange, 'Payroll');
    const { headers } = await this.table(this.options.payrollRange, 'Payroll');
    const index = indexMap(headers);
    const match = rows.findIndex((row) => row[index.attendanceid] === attendanceId);
    if (match >= 0) await this.deleteRow(this.options.payrollRange, match + 2);
  }

  async listPayrollProfiles(): Promise<SheetPayrollProfile[]> {
    try {
      const { headers, rows } = await this.table(this.options.payrollProfilesRange, 'PayrollProfiles');
      const index = indexMap(headers);
      return rows.map((row, offset) => payrollProfileFromRow(row, index, offset + 2));
    } catch { return []; }
  }

  async upsertPayrollProfile(profile: SheetPayrollProfile): Promise<SheetPayrollProfile> {
    const { headers, rows } = await this.table(this.options.payrollProfilesRange, 'PayrollProfiles');
    const index = indexMap(headers);
    const matches = rows.flatMap((row, offset) => row[index.profileid] === profile.profileId ? [offset + 2] : []);
    if (matches.length > 1) throw new Error('Duplicate payroll profile');
    const values = valuesForPayrollProfile(headers, profile);
    if (matches[0]) await this.api.spreadsheets.values.update({ spreadsheetId: this.options.spreadsheetId, range: `${quoteA1SheetTitle(sheetName(this.options.payrollProfilesRange))}!A${matches[0]}:${columnName(headers.length - 1)}${matches[0]}`, valueInputOption: 'RAW', requestBody: { values: [values] } });
    else await this.api.spreadsheets.values.append({ spreadsheetId: this.options.spreadsheetId, range: this.options.payrollProfilesRange, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [values] } });
    return profile;
  }

  async listPayrollCutoffs(): Promise<SheetPayrollCutoff[]> {
    try {
      const { headers, rows } = await this.table(this.options.payrollCutoffsRange, 'PayrollCutoffs');
      const index = indexMap(headers);
      return rows.map((row, offset) => payrollCutoffFromRow(row, index, offset + 2));
    } catch { return []; }
  }

  async findPayrollCutoff(payrollId: string): Promise<SheetPayrollCutoff | null> {
    return (await this.listPayrollCutoffs()).find((row) => row.payrollId === payrollId) ?? null;
  }

  async upsertPayrollCutoff(payroll: SheetPayrollCutoff): Promise<SheetPayrollCutoff> {
    const { headers, rows } = await this.table(this.options.payrollCutoffsRange, 'PayrollCutoffs');
    const index = indexMap(headers);
    const matches = rows.flatMap((row, offset) => row[index.payrollid] === payroll.payrollId ? [offset + 2] : []);
    if (matches.length > 1) throw new Error('Duplicate cutoff payroll');
    const values = valuesForPayrollCutoff(headers, payroll);
    if (matches[0]) await this.api.spreadsheets.values.update({ spreadsheetId: this.options.spreadsheetId, range: `${quoteA1SheetTitle(sheetName(this.options.payrollCutoffsRange))}!A${matches[0]}:${columnName(headers.length - 1)}${matches[0]}`, valueInputOption: 'RAW', requestBody: { values: [values] } });
    else await this.api.spreadsheets.values.append({ spreadsheetId: this.options.spreadsheetId, range: this.options.payrollCutoffsRange, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [values] } });
    return payroll;
  }

  async deletePayrollCutoff(payrollId: string): Promise<void> {
    const { headers, rows } = await this.table(this.options.payrollCutoffsRange, 'PayrollCutoffs');
    const index = indexMap(headers);
    const matches = rows.flatMap((row, offset) => row[index.payrollid] === payrollId ? [offset + 2] : []);
    if (matches.length > 1) throw new Error('Duplicate cutoff payroll');
    if (matches[0]) await this.deleteRow(this.options.payrollCutoffsRange, matches[0]);
  }

  async findInternGrace(userId: string, weekStart: string): Promise<SheetInternGrace | null> {
    const { headers, rows } = await this.table(this.options.internGraceRange, 'InternGrace');
    const index = indexMap(headers);
    const matches = rows.flatMap((row, offset) => row[index.userid] === userId && row[index.weekstart] === weekStart ? [graceFromRow(row, index, offset + 2)] : []);
    if (matches.length > 1) throw new Error('Duplicate intern grace rows');
    return matches[0] ?? null;
  }

  async claimInternGrace(grace: SheetInternGrace): Promise<SheetInternGrace> {
    const headers = await this.headersFor('InternGrace');
    await this.api.spreadsheets.values.append({ spreadsheetId: this.options.spreadsheetId, range: this.options.internGraceRange, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [valuesForGrace(headers, grace)] } });
    return grace;
  }

  private async deleteRow(range: string, rowNumber: number): Promise<void> {
    const title = sheetName(range);
    const metadata = await this.api.spreadsheets.get({ spreadsheetId: this.options.spreadsheetId, fields: 'sheets(properties(sheetId,title))' });
    const sheet = metadata.data.sheets?.find((item) => item.properties?.title === title);
    const sheetId = sheet?.properties?.sheetId;
    if (sheetId === undefined) throw new Error(`Sheet ${title} was not found`);
    await this.api.spreadsheets.batchUpdate({
      spreadsheetId: this.options.spreadsheetId,
      requestBody: { requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: rowNumber - 1, endIndex: rowNumber } } }] },
    });
  }

  async writeAudit(event: AuditEvent): Promise<void> {
    const headers = await this.headersFor('AuditLogs');
    const index = indexMap(headers);
    const row = Array.from({ length: headers.length }, () => '');
    row[index.logid] = crypto.randomUUID();
    row[index.timestamp] = manilaTimestamp(new Date());
    row[index.eventtype] = event.eventType;
    row[index.rfiduid] = event.rfidUid ?? '';
    row[index.userid] = event.userId ?? '';
    row[index.message] = event.message;
    row[index.requestid] = event.requestId;
    await this.api.spreadsheets.values.append({ spreadsheetId: this.options.spreadsheetId, range: this.options.auditRange, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [row] } });
  }

  async healthCheck(): Promise<void> {
    await this.api.spreadsheets.get({ spreadsheetId: this.options.spreadsheetId, fields: 'spreadsheetId' });
    await Promise.all([
      this.table(this.options.usersRange, 'Users'),
      this.table(this.options.attendanceRange, 'Attendance'),
      this.table(this.options.auditRange, 'AuditLogs'),
      this.table(this.options.payrollRange, 'Payroll'),
      this.table(this.options.internGraceRange, 'InternGrace'),
    ]);
  }
}

function quoteA1SheetTitle(title: string): string {
  const unquoted = title.replace(/^'(.*)'$/, '$1').replace(/''/g, "'");
  return `'${unquoted.replace(/'/g, "''")}'`;
}
function googleApiStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  for (const candidate of [value.code, value.status, value.response?.status]) {
    if (typeof candidate === 'number') return candidate;
    if (typeof candidate === 'string' && /^\d+$/.test(candidate)) return Number(candidate);
  }
  return undefined;
}
function canonicalHeader(value: string): string { return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function normalizeCell(value: string | undefined): string {
  try { return normalizeRfidUid(value ?? ''); } catch { return String(value ?? '').trim().replace(/[\s:-]/g, '').toUpperCase(); }
}
function validateHeaders(sheet: keyof typeof requiredHeaders, headers: string[]): void {
  const expected = requiredHeaders[sheet];
  const optional = sheet === 'Users' ? optionalHeaders.Users : [];
  const validLength = headers.length === expected.length || headers.length === expected.length + optional.length;
  const prefixMatches = expected.every((header, index) => headers[index] === header);
  const optionalMatches = headers.length === expected.length || optional.every((header, index) => headers[expected.length + index] === header);
  if (!validLength || !prefixMatches || !optionalMatches) throw new Error(`${sheet} sheet headers are missing or out of order`);
  if (new Set(headers).size !== headers.length) throw new Error(`${sheet} sheet has duplicate headers`);
}
function indexMap(headers: string[]): Record<string, number> { return Object.fromEntries(headers.map((header, index) => [header, index])); }
function valuesForAttendance(headers: string[], attendance: SheetAttendance, existing: string[] = []): string[] {
  const row = [...existing];
  while (row.length < headers.length) row.push('');
  const values: Record<string, string> = {
    attendanceid: attendance.attendanceId, attendancedate: attendance.attendanceDate, userid: attendance.userId,
    rfiduid: attendance.rfidUid, fullname: attendance.fullName, department: attendance.department ?? '',
    timein: attendance.timeIn, timeout: attendance.timeOut ?? '', status: attendance.status, source: attendance.source, notes: attendance.notes,
  };
  headers.forEach((header, index) => { if (values[header] !== undefined) row[index] = values[header]; });
  return row.slice(0, headers.length);
}
function userFromRow(row: string[], index: Record<string, number>): SheetUser {
  return {
    userId: row[index.userid] ?? '',
    rfidUid: normalizeCell(row[index.rfiduid]),
    fullName: row[index.fullname] ?? '',
    department: row[index.department] || null,
    active: String(row[index.status] ?? '').trim().toUpperCase() === 'ACTIVE',
    employeeType: String(row[index.employeetype] ?? '').trim().toUpperCase() === 'EMPLOYEE' ? 'EMPLOYEE' : 'INTERN',
    dailyRate: parseRate(row[index.dailyrate]),
    photoUrl: row[index.photourl] || null,
  };
}
function normalizeAttendanceStatus(value: string | undefined): SheetAttendance['status'] {
  const status = String(value ?? '').trim().toUpperCase();
  if (status === 'COMPLETED') return 'COMPLETED';
  if (status === 'LATE_TIMEOUT') return 'LATE_TIMEOUT';
  return status === 'MISSED' || status === 'INCOMPLETE' ? 'MISSED' : 'WORKING';
}
function attendanceFromRow(row: string[], index: Record<string, number>, rowNumber: number): SheetAttendance {
  return {
    attendanceId: row[index.attendanceid] ?? '', attendanceDate: row[index.attendancedate] ?? '', userId: row[index.userid] ?? '',
    rfidUid: row[index.rfiduid] ?? '', fullName: row[index.fullname] ?? '', department: row[index.department] || null,
    timeIn: row[index.timein] ?? '', timeOut: row[index.timeout] || null, status: normalizeAttendanceStatus(row[index.status]),
    source: String(row[index.source] ?? '').trim().toUpperCase() === 'MANUAL_TEST' ? 'MANUAL_TEST' : 'RFID', notes: row[index.notes] ?? '', rowNumber,
  };
}
function valuesForUser(headers: string[], user: SheetUser, existing: string[] = []): string[] {
  const row = [...existing];
  while (row.length < headers.length) row.push('');
  const values: Record<string, string> = {
    userid: user.userId,
    rfiduid: normalizeRfidUid(user.rfidUid),
    fullname: user.fullName,
    department: user.department ?? '',
    status: user.active ? 'ACTIVE' : 'INACTIVE',
    createdat: row[headers.indexOf('createdat')] || manilaTimestamp(new Date()),
    employeetype: user.employeeType ?? 'INTERN',
    dailyrate: user.dailyRate == null ? '' : String(user.dailyRate),
    payrollprofileid: user.payrollProfileId ?? '',
    photourl: user.photoUrl ?? '',
  };
  headers.forEach((header, offset) => { if (values[header] !== undefined) row[offset] = values[header]; });
  return row.slice(0, headers.length);
}
function parseRate(value: string | undefined): number | null {
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}
function payrollFromRow(row: string[], index: Record<string, number>, rowNumber: number): SheetPayroll {
  return {
    payrollId: row[index.payrollid] ?? '', attendanceId: row[index.attendanceid] ?? '', userId: row[index.userid] ?? '', fullName: row[index.fullname] ?? '',
    employeeType: String(row[index.employeetype] ?? '').toUpperCase() === 'EMPLOYEE' ? 'EMPLOYEE' : 'INTERN', attendanceDate: row[index.attendancedate] ?? '',
    actualTimeIn: row[index.actualtimein] ?? '', actualTimeOut: row[index.actualtimeout] ?? '', computedTimeIn: row[index.computedtimein] ?? '', computedTimeOut: row[index.computedtimeout] ?? '',
    graceUsed: row[index.graceused] === '' ? null : String(row[index.graceused]).toUpperCase() === 'TRUE', lateHours: Number(row[index.latehours] ?? 0), lateDeduction: Number(row[index.latededuction] ?? 0),
    basePay: Number(row[index.basepay] ?? 0), dailyPay: Number(row[index.dailypay] ?? 0), notes: row[index.notes] ?? '', rowNumber,
  };
}
function valuesForPayroll(headers: string[], payroll: SheetPayroll): string[] {
  const values: Record<string, string> = {
    payrollid: payroll.payrollId, attendanceid: payroll.attendanceId, userid: payroll.userId, fullname: payroll.fullName, employeetype: payroll.employeeType,
    attendancedate: payroll.attendanceDate, actualtimein: payroll.actualTimeIn, actualtimeout: payroll.actualTimeOut, computedtimein: payroll.computedTimeIn, computedtimeout: payroll.computedTimeOut,
    graceused: payroll.graceUsed === null ? '' : payroll.graceUsed ? 'TRUE' : 'FALSE', latehours: String(payroll.lateHours), latededuction: String(payroll.lateDeduction), basepay: String(payroll.basePay), dailypay: String(payroll.dailyPay), notes: payroll.notes,
  };
  return headers.map((header) => values[header] ?? '');
}
function payrollProfileFromRow(row: string[], index: Record<string, number>, rowNumber: number): SheetPayrollProfile {
  return {
    profileId: row[index.profileid] ?? '', label: row[index.label] ?? '', payrollFrequency: 'SEMI_MONTHLY',
    standardWorkingDaysPerCutoff: Number(row[index.standardworkingdayspercutoff] ?? 0), incentivesAllowance: Number(row[index.incentivesallowance] ?? 0), specialAllowance: Number(row[index.specialallowance] ?? 0),
    specialHolidayMultiplier: Number(row[index.specialholidaymultiplier] ?? 0), regularHolidayMultiplier: Number(row[index.regularholidaymultiplier] ?? 0), halfDayFraction: Number(row[index.halfdayfraction] ?? 0), overtimeRate: Number(row[index.overtimerate] ?? 0), rowNumber,
  };
}
function valuesForPayrollProfile(headers: string[], profile: SheetPayrollProfile): string[] {
  const values: Record<string, string> = {
    profileid: profile.profileId, label: profile.label, payrollfrequency: profile.payrollFrequency, standardworkingdayspercutoff: String(profile.standardWorkingDaysPerCutoff), incentivesallowance: String(profile.incentivesAllowance), specialallowance: String(profile.specialAllowance), specialholidaymultiplier: String(profile.specialHolidayMultiplier), regularholidaymultiplier: String(profile.regularHolidayMultiplier), halfdayfraction: String(profile.halfDayFraction), overtimerate: String(profile.overtimeRate),
  };
  return headers.map((header) => values[header] ?? '');
}
function payrollCutoffFromRow(row: string[], index: Record<string, number>, rowNumber: number): SheetPayrollCutoff {
  const number = (key: string) => Number(row[index[key]] ?? 0);
  return {
    payrollId: row[index.payrollid] ?? '', employeeId: row[index.employeeid] ?? '', employeeName: row[index.employeename] ?? '',
    // The PayrollCutoffs tab does not carry an employee type column; callers
    // (AdminService.cutoffPayroll) derive it from the live Users register.
    employeeType: 'EMPLOYEE', payrollProfileId: row[index.payrollprofileid] ?? '', payrollCutoffLabel: row[index.payrollcutofflabel] ?? '', cutoffStart: row[index.cutoffstart] ?? '', cutoffEnd: row[index.cutoffend] ?? '', payrollFrequency: 'SEMI_MONTHLY', dailyRate: number('dailyrate'), standardWorkingDays: number('standardworkingdays'), actualWorkingDays: number('actualworkingdays'), basicPay: number('basicpay'), specialHolidayDays: number('specialholidaydays'), specialHolidayMultiplier: number('specialholidaymultiplier'), specialHolidayPay: number('specialholidaypay'), regularHolidayDays: number('regularholidaydays'), regularHolidayMultiplier: number('regularholidaymultiplier'), regularHolidayPay: number('regularholidaypay'), incentivesAllowance: number('incentivesallowance'), specialAllowance: number('specialallowance'), totalCompensation: number('totalcompensation'), totalAllowance: number('totalallowance'), lateUnits: number('lateunits'), lateDeduction: number('latededuction'), halfDayCount: number('halfdaycount'), halfDayDeduction: number('halfdaydeduction'), absentDays: number('absentdays'), absenceDeduction: number('absencededuction'), overtimeHours: number('overtimehours'), overtimeRate: number('overtimerate'), overtimePay: number('overtimepay'), manualAdjustment: number('manualadjustment'), adjustmentReason: row[index.adjustmentreason] || null, grossCompensation: number('grosscompensation'), netPay: number('netpay'), calculationBreakdown: row[index.calculationbreakdown] ?? '', approvedWorkingDayOverage: String(row[index.approvedworkingdayoverage] ?? '').toUpperCase() === 'TRUE', status: String(row[index.status] ?? '').toUpperCase() === 'FINALIZED' ? 'FINALIZED' : 'DRAFT', finalizedAt: row[index.finalizedat] || null, rowNumber,
  };
}
function valuesForPayrollCutoff(headers: string[], payroll: SheetPayrollCutoff): string[] {
  const values: Record<string, string> = { payrollid: payroll.payrollId, employeeid: payroll.employeeId, employeename: payroll.employeeName, payrollprofileid: payroll.payrollProfileId, payrollcutofflabel: payroll.payrollCutoffLabel, cutoffstart: payroll.cutoffStart, cutoffend: payroll.cutoffEnd, payrollfrequency: payroll.payrollFrequency, dailyrate: String(payroll.dailyRate), standardworkingdays: String(payroll.standardWorkingDays), actualworkingdays: String(payroll.actualWorkingDays), basicpay: String(payroll.basicPay), specialholidaydays: String(payroll.specialHolidayDays), specialholidaymultiplier: String(payroll.specialHolidayMultiplier), specialholidaypay: String(payroll.specialHolidayPay), regularholidaydays: String(payroll.regularHolidayDays), regularholidaymultiplier: String(payroll.regularHolidayMultiplier), regularholidaypay: String(payroll.regularHolidayPay), incentivesallowance: String(payroll.incentivesAllowance), specialallowance: String(payroll.specialAllowance), totalcompensation: String(payroll.totalCompensation), totalallowance: String(payroll.totalAllowance), lateunits: String(payroll.lateUnits), latededuction: String(payroll.lateDeduction), halfdaycount: String(payroll.halfDayCount), halfdaydeduction: String(payroll.halfDayDeduction), absentdays: String(payroll.absentDays), absencededuction: String(payroll.absenceDeduction), overtimehours: String(payroll.overtimeHours), overtimerate: String(payroll.overtimeRate), overtimepay: String(payroll.overtimePay), manualadjustment: String(payroll.manualAdjustment), adjustmentreason: payroll.adjustmentReason ?? '', grosscompensation: String(payroll.grossCompensation), netpay: String(payroll.netPay), calculationbreakdown: payroll.calculationBreakdown, approvedworkingdayoverage: payroll.approvedWorkingDayOverage ? 'TRUE' : 'FALSE', status: payroll.status, finalizedat: payroll.finalizedAt ?? '' };
  return headers.map((header) => values[header] ?? '');
}
function graceFromRow(row: string[], index: Record<string, number>, rowNumber: number): SheetInternGrace {
  return { graceId: row[index.graceid] ?? '', userId: row[index.userid] ?? '', weekStart: row[index.weekstart] ?? '', attendanceId: row[index.attendanceid] ?? '', usedAt: row[index.usedat] ?? '', rowNumber };
}
function valuesForGrace(headers: string[], grace: SheetInternGrace): string[] {
  const values: Record<string, string> = { graceid: grace.graceId, userid: grace.userId, weekstart: grace.weekStart, attendanceid: grace.attendanceId, usedat: grace.usedAt };
  return headers.map((header) => values[header] ?? '');
}
function columnName(index: number): string {
  let value = index + 1; let result = '';
  while (value > 0) { const remainder = (value - 1) % 26; result = String.fromCharCode(65 + remainder) + result; value = Math.floor((value - 1) / 26); }
  return result;
}
function sheetName(range: string): string { return range.split('!')[0] || range; }
