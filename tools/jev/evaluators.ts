import { recordAuditEvent } from './audit.js';
import { JevClient, type JevClientOptions } from './client.js';
import {
  createFallbackAttendanceAnomalyResult,
  createFallbackAttendanceCorrectionResult,
  createFallbackPayrollRecordResult,
  resolvePolicyConfig,
} from './policy.js';
import {
  type RawAttendanceAnomalyPayload,
  type RawAttendanceCorrectionPayload,
  type RawPayrollRecordReviewPayload,
  validateAttendanceAnomalyInput,
  validateAttendanceCorrectionInput,
  validatePayrollRecordReviewInput,
} from './schemas.js';
import {
  ATTENDANCE_ANOMALY_CHOICES,
  ATTENDANCE_CORRECTION_CHOICES,
  PAYROLL_RECORD_REVIEW_CHOICES,
  type AttendanceAnomalyChoice,
  type AttendanceAnomalyResult,
  type AttendanceCorrectionChoice,
  type AttendanceCorrectionResult,
  type JevPolicyConfig,
  type PayrollRecordReviewChoice,
  type PayrollRecordReviewResult,
} from './types.js';

export interface EvaluatorOptions {
  client?: JevClient;
  policy?: Partial<JevPolicyConfig>;
  apiKey?: string;
  customFetch?: typeof fetch;
}

export interface ResolvedClientContext {
  client: JevClient;
  policy: JevPolicyConfig;
}

function getClient(options?: EvaluatorOptions): ResolvedClientContext {
  const policy = resolvePolicyConfig(options?.policy);
  if (options?.client) {
    return { client: options.client, policy };
  }
  const clientOptions: JevClientOptions = {
    policy,
    apiKey: options?.apiKey,
    customFetch: options?.customFetch,
  };
  return { client: new JevClient(clientOptions), policy };
}

const ATTENDANCE_ANOMALY_RUBRIC = {
  normal: 'Standard attendance shift with regular hours',
  late_arrival: 'Shift started after the scheduled work start time',
  early_departure: 'Shift completed before the scheduled end time',
  missing_time_in: 'Attendance record has time out but no time in',
  missing_time_out: 'Attendance record has time in but no time out',
  duplicate_scan: 'Rapid repeated scans within cooldown window',
  overlapping_record: 'Shift times conflict with another active session',
  unusually_long_shift: 'Worked duration exceeds realistic shift bounds (e.g. >12h)',
  unusually_short_shift: 'Worked duration is unusually short (e.g. <1h)',
  manual_review: 'Ambiguous or conflicting shift requiring supervisor check',
  evaluation_unavailable: 'Cannot evaluate or service offline',
} satisfies Record<AttendanceAnomalyChoice, string>;

export async function evaluateAttendanceAnomaly(
  rawInput: RawAttendanceAnomalyPayload,
  options?: EvaluatorOptions,
): Promise<AttendanceAnomalyResult> {
  const startTime = Date.now();
  const input = validateAttendanceAnomalyInput(rawInput);
  const { client, policy } = getClient(options);

  // Deterministic guardrails: If time_in or time_out is missing, we don't strictly need external model
  if (!input.timeIn && input.timeOut) {
    const fallback = createFallbackAttendanceAnomalyResult('disabled_by_policy', Date.now() - startTime);
    const result: AttendanceAnomalyResult = {
      ...fallback,
      decision: 'missing_time_in',
      confidence: 1.0,
      status: 'evaluated',
      model: 'deterministic-rules',
    };
    result.probabilities['missing_time_in'] = 1.0;
    result.probabilities['evaluation_unavailable'] = 0.0;
    recordAuditEvent({
      eventId: `audit_${Date.now()}_${input.recordId}`,
      timestamp: new Date().toISOString(),
      evaluator: 'attendance_anomaly',
      targetRef: input.recordId,
      decision: result.decision,
      confidence: result.confidence,
      status: result.status,
      latencyMs: result.latencyMs,
      model: result.model,
    });
    return result;
  }

  if (input.timeIn && !input.timeOut) {
    const fallback = createFallbackAttendanceAnomalyResult('disabled_by_policy', Date.now() - startTime);
    const result: AttendanceAnomalyResult = {
      ...fallback,
      decision: 'missing_time_out',
      confidence: 1.0,
      status: 'evaluated',
      model: 'deterministic-rules',
    };
    result.probabilities['missing_time_out'] = 1.0;
    result.probabilities['evaluation_unavailable'] = 0.0;
    recordAuditEvent({
      eventId: `audit_${Date.now()}_${input.recordId}`,
      timestamp: new Date().toISOString(),
      evaluator: 'attendance_anomaly',
      targetRef: input.recordId,
      decision: result.decision,
      confidence: result.confidence,
      status: result.status,
      latencyMs: result.latencyMs,
      model: result.model,
    });
    return result;
  }

  const structuredState = {
    record_id: input.recordId,
    employee_ref: input.employeeRef,
    date: input.date,
    scheduled_start: input.scheduledStart,
    scheduled_end: input.scheduledEnd,
    time_in: input.timeIn,
    time_out: input.timeOut,
    worked_minutes: input.workedMinutes,
    deterministic_flags: input.deterministicFlags,
    prior_anomaly_count: input.priorAnomalyCount ?? 0,
    source: input.source,
    has_supervisor_correction: input.hasSupervisorCorrection ?? false,
    choices: [...ATTENDANCE_ANOMALY_CHOICES],
  };

  const response = await client.evaluateChoice(
    structuredState,
    'attendance_anomaly',
    'Evaluate the attendance record for anomalies and classify into exactly one predefined choice.',
    ATTENDANCE_ANOMALY_RUBRIC,
    ATTENDANCE_ANOMALY_CHOICES,
  );

  let result: AttendanceAnomalyResult;
  if (!response.success) {
    result = createFallbackAttendanceAnomalyResult(response.reason, response.latencyMs);
  } else if (response.answer.confidence < policy.minConfidenceThreshold) {
    result = {
      decision: 'manual_review',
      confidence: response.answer.confidence,
      probabilities: response.answer.probabilities,
      status: 'fallback',
      fallbackReason: 'confidence_below_threshold',
      model: response.answer.model,
      latencyMs: response.latencyMs,
    };
  } else {
    result = {
      decision: response.answer.choice,
      confidence: response.answer.confidence,
      probabilities: response.answer.probabilities,
      status: 'evaluated',
      model: response.answer.model,
      latencyMs: response.latencyMs,
    };
  }

  recordAuditEvent({
    eventId: `audit_${Date.now()}_${input.recordId}`,
    timestamp: new Date().toISOString(),
    evaluator: 'attendance_anomaly',
    targetRef: input.recordId,
    decision: result.decision,
    confidence: result.confidence,
    status: result.status,
    fallbackReason: result.fallbackReason,
    latencyMs: result.latencyMs,
    model: result.model,
  });

  return result;
}

const PAYROLL_REVIEW_RUBRIC = {
  consistent: 'Payroll calculation is consistent with worked attendance and absence records',
  contains_anomaly: 'Calculation displays unexplained anomalies or internal inconsistencies',
  missing_supporting_record: 'Payroll line items lack corresponding verified attendance scans',
  conflicting_adjustment: 'Manual adjustments directly conflict with attendance records',
  unusual_change: 'Net compensation variance across cutoffs is unusually large',
  requires_supervisor_review: 'Flagged for explicit management sign-off before payout',
  evaluation_unavailable: 'Cannot evaluate or service offline',
} satisfies Record<PayrollRecordReviewChoice, string>;

export async function evaluatePayrollRecord(
  rawInput: RawPayrollRecordReviewPayload,
  options?: EvaluatorOptions,
): Promise<PayrollRecordReviewResult> {
  const input = validatePayrollRecordReviewInput(rawInput);
  const { client, policy } = getClient(options);

  const structuredState = {
    payroll_ref: input.payrollRef,
    period: input.period,
    regular_minutes: input.regularMinutes,
    overtime_minutes: input.overtimeMinutes,
    late_minutes: input.lateMinutes,
    undertime_minutes: input.undertimeMinutes,
    absence_days: input.absenceDays,
    manual_adjustment_count: input.manualAdjustmentCount,
    previous_period_net_change_percent: input.previousPeriodNetChangePercent,
    calculation_version: input.calculationVersion,
    choices: [...PAYROLL_RECORD_REVIEW_CHOICES],
  };

  const response = await client.evaluateChoice(
    structuredState,
    'payroll_review',
    'Review the completed deterministic payroll summary for discrepancies or review flags. Do not recalculate pay.',
    PAYROLL_REVIEW_RUBRIC,
    PAYROLL_RECORD_REVIEW_CHOICES,
  );

  let result: PayrollRecordReviewResult;
  if (!response.success) {
    result = createFallbackPayrollRecordResult(response.reason, response.latencyMs);
  } else if (response.answer.confidence < policy.minConfidenceThreshold) {
    result = {
      decision: 'requires_supervisor_review',
      confidence: response.answer.confidence,
      probabilities: response.answer.probabilities,
      status: 'fallback',
      fallbackReason: 'confidence_below_threshold',
      model: response.answer.model,
      latencyMs: response.latencyMs,
    };
  } else {
    result = {
      decision: response.answer.choice,
      confidence: response.answer.confidence,
      probabilities: response.answer.probabilities,
      status: 'evaluated',
      model: response.answer.model,
      latencyMs: response.latencyMs,
    };
  }

  recordAuditEvent({
    eventId: `audit_${Date.now()}_${input.payrollRef}`,
    timestamp: new Date().toISOString(),
    evaluator: 'payroll_record',
    targetRef: input.payrollRef,
    decision: result.decision,
    confidence: result.confidence,
    status: result.status,
    fallbackReason: result.fallbackReason,
    latencyMs: result.latencyMs,
    model: result.model,
  });

  return result;
}

const ATTENDANCE_CORRECTION_RUBRIC = {
  plausible: 'Correction is logical, justified, and aligns with work patterns',
  missing_reason: 'Correction has no explanation or justification provided',
  conflicts_with_rfid: 'Correction contradicts hardware RFID scan timestamps',
  conflicts_with_schedule: 'Proposed hours fall outside authorized office shifts',
  unusually_large_adjustment: 'Correction proposes a major time shift (e.g. >4 hours)',
  repeated_adjustment_pattern: 'Excessive recurring manual corrections for same user',
  requires_approval: 'Requires higher managerial authorization before applying',
  evaluation_unavailable: 'Cannot evaluate or service offline',
} satisfies Record<AttendanceCorrectionChoice, string>;

export async function evaluateAttendanceCorrection(
  rawInput: RawAttendanceCorrectionPayload,
  options?: EvaluatorOptions,
): Promise<AttendanceCorrectionResult> {
  const input = validateAttendanceCorrectionInput(rawInput);
  const { client, policy } = getClient(options);

  // Deterministic guardrails: If reason is completely blank, immediately flag missing_reason
  if (!input.reason || input.reason.trim().length === 0) {
    const fallback = createFallbackAttendanceCorrectionResult('disabled_by_policy');
    const result: AttendanceCorrectionResult = {
      ...fallback,
      decision: 'missing_reason',
      confidence: 1.0,
      status: 'evaluated',
      model: 'deterministic-rules',
    };
    result.probabilities['missing_reason'] = 1.0;
    result.probabilities['evaluation_unavailable'] = 0.0;
    recordAuditEvent({
      eventId: `audit_${Date.now()}_${input.correctionRef}`,
      timestamp: new Date().toISOString(),
      evaluator: 'attendance_correction',
      targetRef: input.correctionRef,
      decision: result.decision,
      confidence: result.confidence,
      status: result.status,
      latencyMs: result.latencyMs,
      model: result.model,
    });
    return result;
  }

  const structuredState = {
    correction_ref: input.correctionRef,
    employee_ref: input.employeeRef,
    date: input.date,
    original_time_in: input.originalTimeIn,
    original_time_out: input.originalTimeOut,
    proposed_time_in: input.proposedTimeIn,
    proposed_time_out: input.proposedTimeOut,
    adjustment_minutes: input.adjustmentMinutes,
    reason: input.reason,
    supervisor_ref: input.supervisorRef,
    prior_correction_count_30_days: input.priorCorrectionCount30Days ?? 0,
    has_conflicting_rfid_scan: input.hasConflictingRfidScan ?? false,
    choices: [...ATTENDANCE_CORRECTION_CHOICES],
  };

  const response = await client.evaluateChoice(
    structuredState,
    'attendance_correction',
    'Classify the manual attendance correction request submitted by supervisor into exactly one choice.',
    ATTENDANCE_CORRECTION_RUBRIC,
    ATTENDANCE_CORRECTION_CHOICES,
  );

  let result: AttendanceCorrectionResult;
  if (!response.success) {
    result = createFallbackAttendanceCorrectionResult(response.reason, response.latencyMs);
  } else if (response.answer.confidence < policy.minConfidenceThreshold) {
    result = {
      decision: 'requires_approval',
      confidence: response.answer.confidence,
      probabilities: response.answer.probabilities,
      status: 'fallback',
      fallbackReason: 'confidence_below_threshold',
      model: response.answer.model,
      latencyMs: response.latencyMs,
    };
  } else {
    result = {
      decision: response.answer.choice,
      confidence: response.answer.confidence,
      probabilities: response.answer.probabilities,
      status: 'evaluated',
      model: response.answer.model,
      latencyMs: response.latencyMs,
    };
  }

  recordAuditEvent({
    eventId: `audit_${Date.now()}_${input.correctionRef}`,
    timestamp: new Date().toISOString(),
    evaluator: 'attendance_correction',
    targetRef: input.correctionRef,
    decision: result.decision,
    confidence: result.confidence,
    status: result.status,
    fallbackReason: result.fallbackReason,
    latencyMs: result.latencyMs,
    model: result.model,
  });

  return result;
}
