import {
  type AttendanceAnomalyInput,
  type AttendanceCorrectionInput,
  type PayrollRecordReviewInput,
} from './types.js';

/**
 * Redaction layer for personal and sensitive employee data.
 * Produces deterministic, non-reversible synthetic references
 * and strips names, photos, RFID UIDs, phone numbers, and raw notes.
 */

function simpleHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Creates a deterministic, non-reversible synthetic reference.
 * Example: "USR_12345" -> "emp_d4e5f6a7"
 */
export function pseudonymizeEmployeeId(userId: string): string {
  if (!userId || userId.trim().length === 0) {
    return 'emp_anonymous';
  }
  return `emp_${simpleHash(userId.trim())}`;
}

export function pseudonymizeSupervisorId(supervisorId: string): string {
  if (!supervisorId || supervisorId.trim().length === 0) {
    return 'sup_anonymous';
  }
  return `sup_${simpleHash(supervisorId.trim())}`;
}

export function pseudonymizeRecordId(prefix: string, id: string): string {
  if (!id || id.trim().length === 0) {
    return `${prefix}_unknown`;
  }
  return `${prefix}_${simpleHash(id.trim())}`;
}

/**
 * Strips phone numbers, email addresses, and names from free-form text.
 */
export function sanitizeReasonText(text: string | null | undefined): string | null {
  if (!text || text.trim().length === 0) {
    return null;
  }
  let cleaned = text.trim();
  // Strip email addresses
  cleaned = cleaned.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]');
  // Strip phone numbers (Philippine/general international patterns)
  cleaned = cleaned.replace(/(?:\+63|0)9\d{9}\b|\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[REDACTED_PHONE]');
  // Cap length
  if (cleaned.length > 200) {
    cleaned = `${cleaned.slice(0, 200)}...`;
  }
  return cleaned;
}

export interface RawAttendanceData {
  attendanceId: string;
  userId: string;
  attendanceDate: string;
  timeIn: string | null;
  timeOut: string | null;
  workedMinutes: number;
  deterministicFlags: string[];
  priorAnomalyCount?: number;
  source: string;
  hasSupervisorCorrection?: boolean;
}

export function redactAttendanceInput(data: RawAttendanceData): AttendanceAnomalyInput {
  return {
    recordId: pseudonymizeRecordId('att', data.attendanceId),
    employeeRef: pseudonymizeEmployeeId(data.userId),
    date: data.attendanceDate,
    scheduledStart: '08:00',
    scheduledEnd: '17:00',
    timeIn: data.timeIn,
    timeOut: data.timeOut,
    workedMinutes: data.workedMinutes,
    deterministicFlags: [...data.deterministicFlags],
    priorAnomalyCount: data.priorAnomalyCount ?? 0,
    source: data.source,
    hasSupervisorCorrection: data.hasSupervisorCorrection ?? false,
  };
}

export interface RawPayrollData {
  payrollId: string;
  cutoffStart: string;
  cutoffEnd: string;
  regularMinutes: number;
  overtimeMinutes: number;
  lateMinutes: number;
  undertimeMinutes: number;
  absenceDays: number;
  manualAdjustmentCount: number;
  previousPeriodNetChangePercent: number;
  calculationVersion?: string;
}

export function redactPayrollInput(data: RawPayrollData): PayrollRecordReviewInput {
  return {
    payrollRef: pseudonymizeRecordId('pay', data.payrollId),
    period: `${data.cutoffStart}/${data.cutoffEnd}`,
    regularMinutes: data.regularMinutes,
    overtimeMinutes: data.overtimeMinutes,
    lateMinutes: data.lateMinutes,
    undertimeMinutes: data.undertimeMinutes,
    absenceDays: data.absenceDays,
    manualAdjustmentCount: data.manualAdjustmentCount,
    previousPeriodNetChangePercent: data.previousPeriodNetChangePercent,
    calculationVersion: data.calculationVersion ?? 'deterministic-v1',
  };
}

export interface RawCorrectionData {
  correctionId: string;
  userId: string;
  attendanceDate: string;
  originalTimeIn: string | null;
  originalTimeOut: string | null;
  proposedTimeIn: string | null;
  proposedTimeOut: string | null;
  adjustmentMinutes: number;
  reason: string | null;
  supervisorId: string;
  priorCorrectionCount30Days?: number;
  hasConflictingRfidScan?: boolean;
}

export function redactCorrectionInput(data: RawCorrectionData): AttendanceCorrectionInput {
  return {
    correctionRef: pseudonymizeRecordId('corr', data.correctionId),
    employeeRef: pseudonymizeEmployeeId(data.userId),
    date: data.attendanceDate,
    originalTimeIn: data.originalTimeIn,
    originalTimeOut: data.originalTimeOut,
    proposedTimeIn: data.proposedTimeIn,
    proposedTimeOut: data.proposedTimeOut,
    adjustmentMinutes: data.adjustmentMinutes,
    reason: sanitizeReasonText(data.reason),
    supervisorRef: pseudonymizeSupervisorId(data.supervisorId),
    priorCorrectionCount30Days: data.priorCorrectionCount30Days ?? 0,
    hasConflictingRfidScan: data.hasConflictingRfidScan ?? false,
  };
}
