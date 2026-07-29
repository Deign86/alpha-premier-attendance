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
};

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
  eventType: 'SCAN_SUCCESS' | 'UNKNOWN_CARD' | 'INACTIVE_USER' | 'DUPLICATE_SCAN' | 'ATTENDANCE_COMPLETED' | 'API_ERROR' | 'VALIDATION_ERROR' | 'ADMIN_USER_CREATED' | 'ADMIN_USER_UPDATED' | 'ADMIN_ATTENDANCE_UPDATED';
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
  findAttendance(userId: string, attendanceDate: string): Promise<SheetAttendance | null>;
  createAttendance(attendance: SheetAttendance): Promise<SheetAttendance>;
  completeAttendance(attendance: SheetAttendance, timeOut: string): Promise<SheetAttendance>;
  updateAttendance(attendance: SheetAttendance, expected: { timeIn: string | null; timeOut: string | null }): Promise<SheetAttendance>;
  writeAudit(event: AuditEvent): Promise<void>;
  healthCheck(): Promise<void>;
}

export class InMemorySheetsService implements GoogleSheetsService {
  private readonly users: SheetUser[];
  private readonly attendance: SheetAttendance[];
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
};

type Table = { headers: string[]; rows: string[][] };

const requiredHeaders = {
  Users: ['userid', 'rfiduid', 'fullname', 'department', 'status', 'createdat'],
  Attendance: ['attendanceid', 'attendancedate', 'userid', 'rfiduid', 'fullname', 'department', 'timein', 'timeout', 'status', 'source', 'notes'],
  AuditLogs: ['logid', 'timestamp', 'eventtype', 'rfiduid', 'userid', 'message', 'requestid'],
} as const;

export class GoogleSheetsAdapter implements GoogleSheetsService {
  private readonly api: sheets_v4.Sheets;
  private readonly options: Required<GoogleSheetsOptions>;

  constructor(options: GoogleSheetsOptions, api?: sheets_v4.Sheets) {
    this.options = {
      usersRange: 'Users',
      attendanceRange: 'Attendance',
      auditRange: 'AuditLogs',
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
  };
  headers.forEach((header, offset) => { if (values[header] !== undefined) row[offset] = values[header]; });
  return row.slice(0, headers.length);
}
function columnName(index: number): string {
  let value = index + 1; let result = '';
  while (value > 0) { const remainder = (value - 1) % 26; result = String.fromCharCode(65 + remainder) + result; value = Math.floor((value - 1) / 26); }
  return result;
}
function sheetName(range: string): string { return range.split('!')[0] || range; }
