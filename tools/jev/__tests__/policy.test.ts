import { describe, expect, it } from 'vitest';
import {
  createFallbackAttendanceAnomalyResult,
  createFallbackAttendanceCorrectionResult,
  createFallbackPayrollRecordResult,
  DEFAULT_JEV_POLICY,
  resolvePolicyConfig,
} from '../policy.js';

describe('JEV policy & fallbacks', () => {
  it('resolves policy config with defaults and overrides', () => {
    const config = resolvePolicyConfig({ minConfidenceThreshold: 0.85 });
    expect(config.minConfidenceThreshold).toBe(0.85);
    expect(config.timeoutMs).toBe(DEFAULT_JEV_POLICY.timeoutMs);
    expect(config.model).toBe('jev-latest');
  });

  it('creates safe fallback for attendance anomaly', () => {
    const fallback = createFallbackAttendanceAnomalyResult('network_error', 120);
    expect(fallback.decision).toBe('evaluation_unavailable');
    expect(fallback.confidence).toBe(0);
    expect(fallback.status).toBe('fallback');
    expect(fallback.fallbackReason).toBe('network_error');
    expect(fallback.latencyMs).toBe(120);
    expect(fallback.probabilities['evaluation_unavailable']).toBe(1.0);
    expect(fallback.probabilities['normal']).toBe(0.0);
  });

  it('creates safe fallback for payroll record review', () => {
    const fallback = createFallbackPayrollRecordResult('request_timeout', 5000);
    expect(fallback.decision).toBe('evaluation_unavailable');
    expect(fallback.status).toBe('fallback');
    expect(fallback.fallbackReason).toBe('request_timeout');
    expect(fallback.probabilities['evaluation_unavailable']).toBe(1.0);
  });

  it('creates safe fallback for attendance correction', () => {
    const fallback = createFallbackAttendanceCorrectionResult('confidence_below_threshold', 250);
    expect(fallback.decision).toBe('evaluation_unavailable');
    expect(fallback.status).toBe('fallback');
    expect(fallback.fallbackReason).toBe('confidence_below_threshold');
  });
});
