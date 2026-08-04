import crypto from 'node:crypto';
import { attendanceActions, type ScanRequest, type ScanResponse, type ScanSuccessResponse, type UserSummary } from '@rfid-attendance/shared';
import { asScanError, ScanError } from './errors.js';
import { KeyedMutex } from './mutex.js';
import { normalizeRfidUid } from './rfid.js';
import { manilaDate, manilaTimestamp } from './time.js';
import type { AuditEvent, GoogleSheetsService, SheetAttendance } from './sheets.js';
import { PayrollService } from './payroll.js';

export type AttendanceServiceConfig = { timezone: string; scanCooldownMs: number };
type Clock = () => Date;

export class AttendanceService {
  private readonly mutex = new KeyedMutex();
  private readonly lastScans = new Map<string, number>();
  private now: Clock;

  constructor(private readonly sheets: GoogleSheetsService, private readonly config: AttendanceServiceConfig, now: Clock = () => new Date(), private readonly payroll = new PayrollService(sheets)) {
    this.now = now;
  }

  setNowProvider(now: Clock): void { this.now = now; }

  async scan(request: ScanRequest, requestId: string): Promise<ScanResponse> {
    let uid: string;
    try {
      if (!request || typeof request.rfidUid !== 'string' || !['RFID', 'MANUAL_TEST'].includes(request.source)) throw new Error('Invalid scan request');
      uid = normalizeRfidUid(request.rfidUid);
    } catch {
      return new ScanError('INVALID_SCAN_INPUT', 'rfidUid and source are required.', 400).toResponse(requestId);
    }

    try {
      return await this.mutex.runExclusive(uid, async () => {
        const now = this.now();
        const currentMs = now.getTime();
        const previousMs = this.lastScans.get(uid);
        if (previousMs !== undefined && currentMs - previousMs < this.config.scanCooldownMs) {
          const retryAfterSeconds = Math.max(1, Math.ceil((this.config.scanCooldownMs - (currentMs - previousMs)) / 1000));
          throw new ScanError('DUPLICATE_SCAN', 'This card was scanned too recently.', 429, retryAfterSeconds);
        }

        let user;
        try {
          user = await this.sheets.findUserByUid(uid);
        } catch {
          throw new ScanError('GOOGLE_SHEETS_UNAVAILABLE', 'Attendance data is temporarily unavailable.', 503);
        }
        if (!user) throw new ScanError('UNKNOWN_RFID_CARD', 'This RFID card is not registered.', 404);
        if (!user.active) throw new ScanError('INACTIVE_USER', 'This user is inactive.', 403);

        const attendanceDate = manilaDate(now, this.config.timezone);
        const timestamp = manilaTimestamp(now, this.config.timezone);
        let attendance: SheetAttendance | null;
        try {
          attendance = await this.sheets.findAttendance(user.userId, attendanceDate);
        } catch {
          throw new ScanError('GOOGLE_SHEETS_UNAVAILABLE', 'Attendance data is temporarily unavailable.', 503);
        }

        let action: (typeof attendanceActions)[number];
        let saved: SheetAttendance;
        if (!attendance) {
          const newAttendance: SheetAttendance = {
            attendanceId: crypto.randomUUID(),
            attendanceDate,
            userId: user.userId,
            rfidUid: uid,
            fullName: user.fullName,
            department: user.department,
            timeIn: timestamp,
            timeOut: null,
            status: 'WORKING',
            source: request.source,
            notes: '',
          };
          try {
            saved = await this.sheets.createAttendance(newAttendance);
          } catch {
            const reconciled = await this.sheets.findAttendance(user.userId, attendanceDate).catch(() => null);
            if (reconciled?.attendanceId === newAttendance.attendanceId) saved = reconciled;
            else throw new ScanError('GOOGLE_SHEETS_UNAVAILABLE', 'Attendance data is temporarily unavailable.', 503);
          }
          action = 'TIME_IN';
        } else {
          if (!attendance.timeIn && !attendance.timeOut) {
            const restarted: SheetAttendance = { ...attendance, rfidUid: uid, fullName: user.fullName, department: user.department, timeIn: timestamp, timeOut: null, status: 'WORKING', source: request.source };
            try { saved = await this.sheets.updateAttendance(restarted, { timeIn: null, timeOut: null }); }
            catch { throw new ScanError('ATTENDANCE_DATA_CONFLICT', 'Attendance data changed before the scan was saved.', 409); }
            action = 'TIME_IN';
            this.lastScans.set(uid, currentMs);
            void this.writeAudit({ eventType: 'SCAN_SUCCESS', rfidUid: uid, userId: user.userId, message: 'TIME_IN recorded in a cleared row', requestId });
            return this.successResponse(requestId, action, saved, user);
          }
          if (!attendance.timeIn && attendance.timeOut) throw new ScanError('ATTENDANCE_DATA_CONFLICT', 'Attendance has a time-out but no time-in.', 409);
          if (!attendance.timeIn || attendance.attendanceDate !== attendanceDate || (attendance.status === 'COMPLETED' && !attendance.timeOut) || (attendance.status === 'LATE_TIMEOUT' && !attendance.timeOut) || (attendance.status === 'WORKING' && attendance.timeOut)) {
            throw new ScanError('ATTENDANCE_DATA_CONFLICT', 'Attendance data is inconsistent.', 409);
          }
          if (attendance.status === 'COMPLETED' || attendance.status === 'LATE_TIMEOUT') {
            if (attendance.status === 'LATE_TIMEOUT') {
              throw new ScanError('ATTENDANCE_ALREADY_COMPLETED', 'Attendance timed out after office hours and is pending manual correction.', 409);
            }
            if (!await this.sheets.findPayrollByAttendanceId(attendance.attendanceId)) {
              try { await this.payroll.ensureForCompletedAttendance(attendance, user); }
              catch { throw new ScanError('PAYROLL_GENERATION_FAILED', 'Attendance is complete but payroll could not be generated.', 503); }
            }
            throw new ScanError('ATTENDANCE_ALREADY_COMPLETED', 'Attendance is already complete for today.', 409);
          }
          try {
            saved = await this.sheets.completeAttendance(attendance, timestamp);
          } catch {
            const reconciled = await this.sheets.findAttendance(user.userId, attendanceDate).catch(() => null);
            if (reconciled?.attendanceId === attendance.attendanceId && (reconciled.status === 'COMPLETED' || reconciled.status === 'LATE_TIMEOUT') && reconciled.timeOut) saved = reconciled;
            else throw new ScanError('GOOGLE_SHEETS_UNAVAILABLE', 'Attendance data is temporarily unavailable.', 503);
          }
          action = 'TIME_OUT';
          if (saved.status === 'COMPLETED') {
            try { await this.payroll.ensureForCompletedAttendance(saved, user); }
            catch { throw new ScanError('PAYROLL_GENERATION_FAILED', 'Attendance was completed but payroll could not be generated.', 503); }
          }
        }

        this.lastScans.set(uid, currentMs);
        void this.writeAudit({ eventType: 'SCAN_SUCCESS', rfidUid: uid, userId: user.userId, message: `${action} recorded`, requestId });
        return this.successResponse(requestId, action, saved, user);
      });
    } catch (error) {
      void this.writeAudit({ eventType: auditEventFor(error), rfidUid: uid, message: error instanceof Error ? error.message : 'Scan failed', requestId });
      return asScanError(error).toResponse(requestId);
    }
  }

  private async writeAudit(event: AuditEvent): Promise<void> {
    try {
      await this.sheets.writeAudit(event);
    } catch {
      // Audit logging is best effort; attendance results remain authoritative.
    }
  }

  private successResponse(requestId: string, action: (typeof attendanceActions)[number], attendance: SheetAttendance, user: { userId: string; fullName: string; department: string | null; employeeType?: 'INTERN' | 'EMPLOYEE'; photoUrl?: string | null }): ScanSuccessResponse {
    const userSummary: UserSummary = { userId: user.userId, fullName: user.fullName, department: user.department, employeeType: user.employeeType ?? 'INTERN', photoUrl: user.photoUrl ?? null };
    const message = action === 'TIME_IN'
      ? 'Time In recorded successfully.'
      : attendance.status === 'LATE_TIMEOUT'
        ? 'Time Out recorded after office hours. Manual correction is required.'
        : 'Time Out recorded successfully.';
    return {
      success: true,
      requestId,
      action,
      message,
      attendance: {
        attendanceId: attendance.attendanceId,
        attendanceDate: attendance.attendanceDate,
        timeIn: attendance.timeIn,
        timeOut: attendance.timeOut,
        status: attendance.status,
      },
      user: userSummary,
    };
  }
}

function auditEventFor(error: unknown): AuditEvent['eventType'] {
  if (error instanceof ScanError) {
    if (error.code === 'UNKNOWN_RFID_CARD') return 'UNKNOWN_CARD';
    if (error.code === 'INACTIVE_USER') return 'INACTIVE_USER';
    if (error.code === 'DUPLICATE_SCAN') return 'DUPLICATE_SCAN';
    if (error.code === 'ATTENDANCE_ALREADY_COMPLETED') return 'ATTENDANCE_COMPLETED';
    if (error.code === 'INVALID_SCAN_INPUT') return 'VALIDATION_ERROR';
  }
  return 'API_ERROR';
}
