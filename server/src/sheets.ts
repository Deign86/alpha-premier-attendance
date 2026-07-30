import crypto from 'node:crypto';
import { google, type sheets_v4 } from 'googleapis';
import { normalizeRfidUid } from './rfid.js';
import { manilaTimestamp } from './time.js';

export type SheetUser = {
  userId: string;
  fullName: string;
  rfidUid: string;
  department: string | null;
  active: boolean;
  employeeType?: 'INTERN' | 'EMPLOYEE';
  dailyRate?: number | null;
  photoUrl?: string | null;
};

export type SheetPayroll = {
  payrollId: string; attendanceId: string; userId: string; fullName: string; employeeType: 'INTERN' | 'EMPLOYEE'; attendanceDate: string;
  actualTimeIn: string; actualTimeOut: string; computedTimeIn: string; computedTimeOut: string; graceUsed: boolean | null;
  lateHours: number; lateDeduction: number; basePay: number; dailyPay: number; notes: string; rowNumber?: number;
};

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
  status: 'OPEN' | 'COMPLETED' | 'INCOMPLETE';
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
  readonly audits: AuditEvent[] = [];

  constructor(users: SheetUser[] = [], attendance: SheetAttendance[] = []) {
    this.users = users.map((user) => ({ ...user, rfidUid: normalizeRfidUid(user.rfidUid) }));
    this.attendance = attendance.map((row) => ({ ...row }));
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
    if (!row || row.status !== 'OPEN' || row.timeOut) throw new Error('Attendance row is no longer open');
    row.timeOut = timeOut;
    row.status = 'COMPLETED';
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
  spreadsheetId: string;
  clientEmail: string;
  privateKey: string;
  usersRange?: string;
  attendanceRange?: string;
  auditRange?: string;
  payrollRange?: string;
  internGraceRange?: string;
};

type Table = { headers: string[]; rows: string[][] };

const requiredHeaders = {
  Users: ['userid', 'rfiduid', 'fullname', 'department', 'status', 'createdat', 'employeetype', 'dailyrate', 'photourl'],
  Attendance: ['attendanceid', 'attendancedate', 'userid', 'rfiduid', 'fullname', 'department', 'timein', 'timeout', 'status', 'source', 'notes'],
  AuditLogs: ['logid', 'timestamp', 'eventtype', 'rfiduid', 'userid', 'message', 'requestid'],
  Payroll: ['payrollid', 'attendanceid', 'userid', 'fullname', 'employeetype', 'attendancedate', 'actualtimein', 'actualtimeout', 'computedtimein', 'computedtimeout', 'graceused', 'latehours', 'latededuction', 'basepay', 'dailypay', 'notes'],
  InternGrace: ['graceid', 'userid', 'weekstart', 'attendanceid', 'usedat'],
} as const;

export class GoogleSheetsAdapter implements GoogleSheetsService {
  private readonly api: sheets_v4.Sheets;
  private readonly options: Required<GoogleSheetsOptions>;

  constructor(options: GoogleSheetsOptions, api?: sheets_v4.Sheets) {
    this.options = {
      usersRange: 'Users',
      attendanceRange: 'Attendance',
      auditRange: 'AuditLogs',
      payrollRange: 'Payroll',
      internGraceRange: 'InternGrace',
      ...options,
    };
    if (api) this.api = api;
    else {
      const auth = new google.auth.JWT({
        email: this.options.clientEmail,
        key: this.options.privateKey,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      this.api = google.sheets({ version: 'v4', auth });
    }
  }

  private async values(range: string): Promise<string[][]> {
    const result = await this.api.spreadsheets.values.get({ spreadsheetId: this.options.spreadsheetId, range });
    return (result.data.values ?? []) as string[][];
  }

  private async table(range: string, sheet: keyof typeof requiredHeaders): Promise<Table> {
    const rows = await this.values(range);
    const headers = (rows[0] ?? []).map(canonicalHeader);
    validateHeaders(sheet, headers);
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
        range: `${sheetName(this.options.usersRange)}!A${rowNumber}:${columnName(headers.length - 1)}${rowNumber}`,
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
    const { headers } = await this.table(this.options.attendanceRange, 'Attendance');
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
    const { headers, rows } = await this.table(this.options.attendanceRange, 'Attendance');
    const index = indexMap(headers);
    const existing = rows[attendance.rowNumber - 2];
    if (!existing || existing[index.attendanceid] !== attendance.attendanceId || existing[index.status] !== 'OPEN' || existing[index.timeout]) throw new Error('Attendance row is no longer open');
    const updated = { ...attendance, timeOut, status: 'COMPLETED' as const };
    await this.api.spreadsheets.values.update({
      spreadsheetId: this.options.spreadsheetId,
      range: `${sheetName(this.options.attendanceRange)}!A${attendance.rowNumber}:${columnName(headers.length - 1)}${attendance.rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [valuesForAttendance(headers, updated, existing)] },
    });
    return updated;
  }

  async updateAttendance(attendance: SheetAttendance, expected: { timeIn: string | null; timeOut: string | null }): Promise<SheetAttendance> {
    if (!attendance.rowNumber) throw new Error('Attendance row number unavailable');
    const { headers, rows } = await this.table(this.options.attendanceRange, 'Attendance');
    const index = indexMap(headers);
    const existing = rows[attendance.rowNumber - 2];
    if (!existing || existing[index.attendanceid] !== attendance.attendanceId || (existing[index.timein] || null) !== expected.timeIn || (existing[index.timeout] || null) !== expected.timeOut) throw new Error('Attendance row has changed');
    await this.api.spreadsheets.values.update({
      spreadsheetId: this.options.spreadsheetId,
      range: `${sheetName(this.options.attendanceRange)}!A${attendance.rowNumber}:${columnName(headers.length - 1)}${attendance.rowNumber}`,
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
    const { headers } = await this.table(this.options.payrollRange, 'Payroll');
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

  async findInternGrace(userId: string, weekStart: string): Promise<SheetInternGrace | null> {
    const { headers, rows } = await this.table(this.options.internGraceRange, 'InternGrace');
    const index = indexMap(headers);
    const matches = rows.flatMap((row, offset) => row[index.userid] === userId && row[index.weekstart] === weekStart ? [graceFromRow(row, index, offset + 2)] : []);
    if (matches.length > 1) throw new Error('Duplicate intern grace rows');
    return matches[0] ?? null;
  }

  async claimInternGrace(grace: SheetInternGrace): Promise<SheetInternGrace> {
    const { headers } = await this.table(this.options.internGraceRange, 'InternGrace');
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
    const { headers } = await this.table(this.options.auditRange, 'AuditLogs');
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

function canonicalHeader(value: string): string { return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function normalizeCell(value: string | undefined): string {
  try { return normalizeRfidUid(value ?? ''); } catch { return String(value ?? '').trim().replace(/[\s:-]/g, '').toUpperCase(); }
}
function validateHeaders(sheet: keyof typeof requiredHeaders, headers: string[]): void {
  const expected = requiredHeaders[sheet];
  if (headers.length !== expected.length || expected.some((header, index) => headers[index] !== header)) throw new Error(`${sheet} sheet headers are missing or out of order`);
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
  return status === 'COMPLETED' ? 'COMPLETED' : status === 'INCOMPLETE' ? 'INCOMPLETE' : 'OPEN';
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
