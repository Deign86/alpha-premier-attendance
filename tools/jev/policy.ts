import {
  ATTENDANCE_ANOMALY_CHOICES,
  ATTENDANCE_CORRECTION_CHOICES,
  PAYROLL_RECORD_REVIEW_CHOICES,
  type AttendanceAnomalyChoice,
  type AttendanceAnomalyResult,
  type AttendanceCorrectionChoice,
  type AttendanceCorrectionResult,
  type FallbackReason,
  type JevPolicyConfig,
  type PayrollRecordReviewChoice,
  type PayrollRecordReviewResult,
} from './types.js';

export const DEFAULT_JEV_POLICY: JevPolicyConfig = {
  enabled: Boolean(globalThis.process?.env?.['JEV_ENABLED'] === 'true'),
  minConfidenceThreshold: 0.7,
  timeoutMs: 5000,
  maxRetries: 2,
  model: 'jev-latest',
  apiBaseUrl: 'https://api.typesafe.ai/v1/systemone',
};

export function resolvePolicyConfig(override?: Partial<JevPolicyConfig>): JevPolicyConfig {
  if (!override) return { ...DEFAULT_JEV_POLICY };
  return {
    enabled: override.enabled ?? DEFAULT_JEV_POLICY.enabled,
    minConfidenceThreshold: override.minConfidenceThreshold ?? DEFAULT_JEV_POLICY.minConfidenceThreshold,
    timeoutMs: override.timeoutMs ?? DEFAULT_JEV_POLICY.timeoutMs,
    maxRetries: override.maxRetries ?? DEFAULT_JEV_POLICY.maxRetries,
    model: override.model ?? DEFAULT_JEV_POLICY.model,
    apiBaseUrl: override.apiBaseUrl ?? DEFAULT_JEV_POLICY.apiBaseUrl,
  };
}

export function createFallbackAttendanceAnomalyResult(
  reason: FallbackReason,
  latencyMs = 0,
): AttendanceAnomalyResult {
  // SAFETY: building zeroed probabilities map across all valid choices
  const probabilities = {} as Record<AttendanceAnomalyChoice, number>;
  for (const choice of ATTENDANCE_ANOMALY_CHOICES) {
    probabilities[choice] = choice === 'evaluation_unavailable' ? 1.0 : 0.0;
  }

  return {
    decision: 'evaluation_unavailable',
    confidence: 0,
    probabilities,
    status: 'fallback',
    fallbackReason: reason,
    model: 'none',
    latencyMs,
  };
}

export function createFallbackPayrollRecordResult(
  reason: FallbackReason,
  latencyMs = 0,
): PayrollRecordReviewResult {
  // SAFETY: building zeroed probabilities map across all valid choices
  const probabilities = {} as Record<PayrollRecordReviewChoice, number>;
  for (const choice of PAYROLL_RECORD_REVIEW_CHOICES) {
    probabilities[choice] = choice === 'evaluation_unavailable' ? 1.0 : 0.0;
  }

  return {
    decision: 'evaluation_unavailable',
    confidence: 0,
    probabilities,
    status: 'fallback',
    fallbackReason: reason,
    model: 'none',
    latencyMs,
  };
}

export function createFallbackAttendanceCorrectionResult(
  reason: FallbackReason,
  latencyMs = 0,
): AttendanceCorrectionResult {
  // SAFETY: building zeroed probabilities map across all valid choices
  const probabilities = {} as Record<AttendanceCorrectionChoice, number>;
  for (const choice of ATTENDANCE_CORRECTION_CHOICES) {
    probabilities[choice] = choice === 'evaluation_unavailable' ? 1.0 : 0.0;
  }

  return {
    decision: 'evaluation_unavailable',
    confidence: 0,
    probabilities,
    status: 'fallback',
    fallbackReason: reason,
    model: 'none',
    latencyMs,
  };
}
