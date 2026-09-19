/**
 * Safe, typed contracts for JEV evaluation layer.
 * All evaluators operate on strictly bounded, predefined decision choices
 * over redacted or synthetic identifiers.
 */

export const ATTENDANCE_ANOMALY_CHOICES = [
  'normal',
  'late_arrival',
  'early_departure',
  'missing_time_in',
  'missing_time_out',
  'duplicate_scan',
  'overlapping_record',
  'unusually_long_shift',
  'unusually_short_shift',
  'manual_review',
  'evaluation_unavailable',
] as const;

export type AttendanceAnomalyChoice = (typeof ATTENDANCE_ANOMALY_CHOICES)[number];

export const PAYROLL_RECORD_REVIEW_CHOICES = [
  'consistent',
  'contains_anomaly',
  'missing_supporting_record',
  'conflicting_adjustment',
  'unusual_change',
  'requires_supervisor_review',
  'evaluation_unavailable',
] as const;

export type PayrollRecordReviewChoice = (typeof PAYROLL_RECORD_REVIEW_CHOICES)[number];

export const ATTENDANCE_CORRECTION_CHOICES = [
  'plausible',
  'missing_reason',
  'conflicts_with_rfid',
  'conflicts_with_schedule',
  'unusually_large_adjustment',
  'repeated_adjustment_pattern',
  'requires_approval',
  'evaluation_unavailable',
] as const;

export type AttendanceCorrectionChoice = (typeof ATTENDANCE_CORRECTION_CHOICES)[number];

export interface AttendanceAnomalyInput {
  recordId: string;
  employeeRef: string;
  date: string;
  scheduledStart: string;
  scheduledEnd: string;
  timeIn: string | null;
  timeOut: string | null;
  workedMinutes: number;
  deterministicFlags: string[];
  priorAnomalyCount?: number;
  source: string;
  hasSupervisorCorrection?: boolean;
}

export interface PayrollRecordReviewInput {
  payrollRef: string;
  period: string;
  regularMinutes: number;
  overtimeMinutes: number;
  lateMinutes: number;
  undertimeMinutes: number;
  absenceDays: number;
  manualAdjustmentCount: number;
  previousPeriodNetChangePercent: number;
  calculationVersion: string;
}

export interface AttendanceCorrectionInput {
  correctionRef: string;
  employeeRef: string;
  date: string;
  originalTimeIn: string | null;
  originalTimeOut: string | null;
  proposedTimeIn: string | null;
  proposedTimeOut: string | null;
  adjustmentMinutes: number;
  reason: string | null;
  supervisorRef: string;
  priorCorrectionCount30Days?: number;
  hasConflictingRfidScan?: boolean;
}

export type FallbackReason =
  | 'disabled_by_policy'
  | 'missing_api_key'
  | 'request_timeout'
  | 'network_error'
  | 'rate_limited'
  | 'invalid_response_schema'
  | 'confidence_below_threshold'
  | 'unknown_choice';

export interface EvaluationResult<TChoice extends string> {
  decision: TChoice;
  confidence: number;
  probabilities: Record<TChoice, number>;
  status: 'evaluated' | 'fallback';
  fallbackReason?: FallbackReason;
  model: string;
  latencyMs: number;
}

export type AttendanceAnomalyResult = EvaluationResult<AttendanceAnomalyChoice>;
export type PayrollRecordReviewResult = EvaluationResult<PayrollRecordReviewChoice>;
export type AttendanceCorrectionResult = EvaluationResult<AttendanceCorrectionChoice>;

export interface JevPolicyConfig {
  enabled: boolean;
  minConfidenceThreshold: number;
  timeoutMs: number;
  maxRetries: number;
  model: string;
  apiBaseUrl: string;
}

export interface JevAuditEvent {
  eventId: string;
  timestamp: string;
  evaluator: 'attendance_anomaly' | 'payroll_record' | 'attendance_correction';
  targetRef: string;
  decision: string;
  confidence: number;
  status: 'evaluated' | 'fallback';
  fallbackReason?: FallbackReason;
  latencyMs: number;
  model: string;
}
