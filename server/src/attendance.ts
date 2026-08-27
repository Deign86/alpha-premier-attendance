import crypto from 'node:crypto';
import {
  attendanceActions,
  isLateTimeout,
  type ScanAdminAssistResponse,
  type ScanRequest,
  type ScanResponse,
  type ScanSuccessResponse,
  type UserSummary,
} from '@rfid-attendance/shared';
import { asScanError, ScanError } from './errors.js';
import { KeyedMutex } from './mutex.js';
import { normalizeRfidUid } from './rfid.js';
import { manilaDate, manilaTimestamp } from './time.js';
import type { AuditEvent, GoogleSheetsService, SheetAttendance, SheetUser } from './sheets.js';
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
      if (!isScanRequest(request)) throw new Error('Invalid scan request');
      uid = normalizeRfidUid(request.rfidUid);
    } catch {
      return new ScanError('INVALID_SCAN_INPUT', 'rfidUid and source are required.', 400).toResponse(requestId);
    }

    try {
      return await this.mutex.runExclusive(uid, async () => {
        const now = this.now();
        const currentMs = now.getTime();
        let user: SheetUser | null;
        try {
          user = await this.sheets.findUserByUid(uid);
        } catch {
          throw new ScanError('GOOGLE_SHEETS_UNAVAILABLE', 'Attendance data is temporarily unavailable.', 503);
        }
        if (!user) throw new ScanError('UNKNOWN_RFID_CARD', 'This RFID card is not registered.', 404);
        if (!user.active) throw new ScanError('INACTIVE_USER', 'This user is inactive.', 403);

        const timestamp = manilaTimestamp(now, this.config.timezone);

        // Handle Admin Assist cards
        const isAssist = user.cardType === 'ADMIN_ASSIST';
        let effectiveUser: SheetUser = user;
        let recordedBy: string | null = null;
        let recordedReason: string | null = null;
        let recordedAt: string | null = null;

        if (isAssist) {
          if (!request.targetUserId) {
            const allUsers = await this.sheets.listUsers();
            const activeEmployees = allUsers
              .filter((u) => u.active && u.cardType !== 'ADMIN_ASSIST')
              .map((u) => ({
                userId: u.userId,
                fullName: u.fullName,
                department: u.department,
                photoUrl: u.photoUrl ?? null,
              }));
            this.lastScans.set(uid, currentMs);
            void this.writeAudit({
              eventType: 'SCAN_SUCCESS',
              rfidUid: uid,
              userId: user.userId,
              message: 'ADMIN_ASSIST card presented',
              requestId,
            });
            const assistResponse: ScanAdminAssistResponse = {
              success: true,
              requestId,
              action: 'ADMIN_ASSIST',
              message: 'Admin assist card accepted. Select an employee to record attendance.',
              adminCard: {
                rfidUid: user.rfidUid,
                label: user.fullName || 'Admin Assist Card',
              },
              activeEmployees,
            };
            return assistResponse;
          }

          if (request.targetUserId === user.userId) {
            throw new ScanError('ADMIN_CARD_REQUIRES_SELECTION', 'Admin RFID cards cannot record attendance for themselves.', 400);
          }
          const target = await this.sheets.findUserById(request.targetUserId);
          if (!target) {
            throw new ScanError('UNKNOWN_RFID_CARD', 'Selected employee not found.', 404);
          }
          if (target.cardType === 'ADMIN_ASSIST') {
            throw new ScanError('ADMIN_CARD_REQUIRES_SELECTION', 'Cannot record attendance for another admin card.', 400);
          }
          if (!target.active) {
            throw new ScanError('INACTIVE_USER', 'This employee is inactive.', 403);
          }

          effectiveUser = target;
          recordedBy = user.fullName || 'Admin';
          recordedReason = request.reason?.trim() || 'Forgot RFID card';
          recordedAt = timestamp;
        } else if (request.targetUserId && request.targetUserId !== user.userId) {
          throw new ScanError('INVALID_SCAN_INPUT', 'Only Admin RFID cards can record attendance for other employees.', 403);
        }

        const cooldownKey = isAssist && request.targetUserId ? effectiveUser.rfidUid : uid;
        const previousMs = this.lastScans.get(cooldownKey);
        if (previousMs !== undefined && currentMs - previousMs < this.config.scanCooldownMs) {
          const retryAfterSeconds = Math.max(1, Math.ceil((this.config.scanCooldownMs - (currentMs - previousMs)) / 1000));
          throw new ScanError('DUPLICATE_SCAN', 'This card was scanned too recently.', 429, retryAfterSeconds);
        }

        const attendanceDate = manilaDate(now, this.config.timezone);
        let attendance: SheetAttendance | null;
        try {
          attendance = await this.sheets.findAttendance(effectiveUser.userId, attendanceDate);
        } catch {
          throw new ScanError('GOOGLE_SHEETS_UNAVAILABLE', 'Attendance data is temporarily unavailable.', 503);
        }

        let action: (typeof attendanceActions)[number];
        let saved: SheetAttendance;
        const effectiveSource = isAssist ? 'ADMIN_ASSISTED_SCAN' : request.source;

        if (!attendance) {
          const newAttendance: SheetAttendance = {
            attendanceId: crypto.randomUUID(),
            attendanceDate,
            userId: effectiveUser.userId,
            rfidUid: isAssist ? effectiveUser.rfidUid : uid,
            fullName: effectiveUser.fullName,
            department: effectiveUser.department,
            timeIn: timestamp,
            timeOut: null,
            status: 'WORKING',
            source: effectiveSource,
            notes: '',
            recordedBy,
            recordedReason,
            recordedAt,
          };
          try {
            saved = await this.sheets.createAttendance(newAttendance);
          } catch {
            const reconciled = await this.sheets.findAttendance(effectiveUser.userId, attendanceDate).catch(() => null);
            if (reconciled?.attendanceId === newAttendance.attendanceId) saved = reconciled;
            else throw new ScanError('GOOGLE_SHEETS_UNAVAILABLE', 'Attendance data is temporarily unavailable.', 503);
          }
          action = 'TIME_IN';
        } else {
          if (!attendance.timeIn && !attendance.timeOut) {
            const restarted: SheetAttendance = {
              ...attendance,
              rfidUid: isAssist ? effectiveUser.rfidUid : uid,
              fullName: effectiveUser.fullName,
              department: effectiveUser.department,
              timeIn: timestamp,
              timeOut: null,
              status: 'WORKING',
              source: effectiveSource,
              recordedBy: recordedBy ?? attendance.recordedBy,
              recordedReason: recordedReason ?? attendance.recordedReason,
              recordedAt: recordedAt ?? attendance.recordedAt,
            };
            try { saved = await this.sheets.updateAttendance(restarted, { timeIn: null, timeOut: null }); }
            catch { throw new ScanError('ATTENDANCE_DATA_CONFLICT', 'Attendance data changed before the scan was saved.', 409); }
            action = 'TIME_IN';
            this.lastScans.set(uid, currentMs);
            void this.writeAudit({
              eventType: 'SCAN_SUCCESS',
              rfidUid: uid,
              userId: effectiveUser.userId,
              message: isAssist ? `TIME_IN recorded (Assisted by ${user.fullName})` : 'TIME_IN recorded in a cleared row',
              requestId,
            });
            return this.successResponse(requestId, action, saved, effectiveUser);
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
              try { await this.payroll.ensureForCompletedAttendance(attendance, effectiveUser); }
              catch { throw new ScanError('PAYROLL_GENERATION_FAILED', 'Attendance is complete but payroll could not be generated.', 503); }
            }
            throw new ScanError('ATTENDANCE_ALREADY_COMPLETED', 'Attendance is already complete for today.', 409);
          }

          if (isAssist) {
            const completedRow: SheetAttendance = {
              ...attendance,
              timeOut: timestamp,
              status: isLateTimeout(timestamp) ? 'LATE_TIMEOUT' : 'COMPLETED',
              source: 'ADMIN_ASSISTED_SCAN',
              recordedBy,
              recordedReason,
              recordedAt,
            };
            try {
              saved = await this.sheets.updateAttendance(completedRow, { timeIn: attendance.timeIn, timeOut: null });
            } catch {
              const reconciled = await this.sheets.findAttendance(effectiveUser.userId, attendanceDate).catch(() => null);
              if (reconciled?.attendanceId === attendance.attendanceId && (reconciled.status === 'COMPLETED' || reconciled.status === 'LATE_TIMEOUT') && reconciled.timeOut) saved = reconciled;
              else throw new ScanError('GOOGLE_SHEETS_UNAVAILABLE', 'Attendance data is temporarily unavailable.', 503);
            }
          } else {
            try {
              saved = await this.sheets.completeAttendance(attendance, timestamp);
            } catch {
              const reconciled = await this.sheets.findAttendance(effectiveUser.userId, attendanceDate).catch(() => null);
              if (reconciled?.attendanceId === attendance.attendanceId && (reconciled.status === 'COMPLETED' || reconciled.status === 'LATE_TIMEOUT') && reconciled.timeOut) saved = reconciled;
              else throw new ScanError('GOOGLE_SHEETS_UNAVAILABLE', 'Attendance data is temporarily unavailable.', 503);
            }
          }
          action = 'TIME_OUT';
          if (saved.status === 'COMPLETED') {
            try { await this.payroll.ensureForCompletedAttendance(saved, effectiveUser); }
            catch { throw new ScanError('PAYROLL_GENERATION_FAILED', 'Attendance was completed but payroll could not be generated.', 503); }
          }
        }

        this.lastScans.set(uid, currentMs);
        void this.writeAudit({
          eventType: 'SCAN_SUCCESS',
          rfidUid: uid,
          userId: effectiveUser.userId,
          message: isAssist ? `${action} recorded (Assisted by ${user.fullName})` : `${action} recorded`,
          requestId,
        });
        return this.successResponse(requestId, action, saved, effectiveUser);
      });
    } catch (error) {
      const scanErr = asScanError(error);
      void this.writeAudit({ eventType: auditEventFor(scanErr), rfidUid: uid, message: scanErr.message, requestId });
      return scanErr.toResponse(requestId);
    }
  }

  private async writeAudit(event: AuditEvent): Promise<void> {
    try {
      await this.sheets.writeAudit(event);
    } catch {
      // Audit logging is best effort; attendance results remain authoritative.
    }
  }

  private successResponse(requestId: string, action: (typeof attendanceActions)[number], attendance: SheetAttendance, user: { userId: string; fullName: string; department: string | null; employeeType?: 'INTERN' | 'EMPLOYEE'; gender?: 'MALE' | 'FEMALE' | null; photoUrl?: string | null }): ScanSuccessResponse {
    const userSummary: UserSummary = { userId: user.userId, fullName: user.fullName, department: user.department, employeeType: user.employeeType ?? 'INTERN', gender: user.gender ?? null, photoUrl: user.photoUrl ?? null };
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
        source: attendance.source,
        recordedBy: attendance.recordedBy ?? null,
        recordedReason: attendance.recordedReason ?? null,
        recordedAt: attendance.recordedAt ?? null,
      },
      user: userSummary,
    };
  }
}

function isScanRequest(request: ScanRequest): boolean {
  if (!request) return false;
  if (Object.prototype.toString.call(request.rfidUid) !== '[object String]') return false;
  return request.source === 'RFID' || request.source === 'MANUAL_TEST' || request.source === 'ADMIN_ASSISTED_SCAN';
}

function auditEventFor(error: ScanError | Error): AuditEvent['eventType'] {
  if (error instanceof ScanError) {
    if (error.code === 'UNKNOWN_RFID_CARD') return 'UNKNOWN_CARD';
    if (error.code === 'INACTIVE_USER') return 'INACTIVE_USER';
    if (error.code === 'DUPLICATE_SCAN') return 'DUPLICATE_SCAN';
    if (error.code === 'ATTENDANCE_ALREADY_COMPLETED') return 'ATTENDANCE_COMPLETED';
    if (error.code === 'INVALID_SCAN_INPUT' || error.code === 'ADMIN_CARD_REQUIRES_SELECTION') return 'VALIDATION_ERROR';
  }
  return 'API_ERROR';
}
