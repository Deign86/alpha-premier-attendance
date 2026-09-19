import { describe, expect, it } from 'vitest';
import {
  evaluateAttendanceAnomaly,
  evaluateAttendanceCorrection,
  evaluatePayrollRecord,
} from '../evaluators.js';

describe('JEV evaluators', () => {
  describe('Evaluator A: evaluateAttendanceAnomaly', () => {
    it('applies deterministic rule for missing time_in', async () => {
      const input = {
        recordId: 'att-1',
        employeeRef: 'emp-1',
        date: '2026-09-01',
        scheduledStart: '08:00',
        scheduledEnd: '17:00',
        timeIn: null,
        timeOut: '17:00',
        workedMinutes: 0,
        deterministicFlags: ['missing_time_in'],
        source: 'RFID',
      };

      const result = await evaluateAttendanceAnomaly(input, {
        policy: { enabled: true },
        apiKey: 'key',
      });

      expect(result.decision).toBe('missing_time_in');
      expect(result.confidence).toBe(1.0);
      expect(result.model).toBe('deterministic-rules');
      expect(result.status).toBe('evaluated');
    });

    it('applies deterministic rule for missing time_out', async () => {
      const input = {
        recordId: 'att-2',
        employeeRef: 'emp-1',
        date: '2026-09-01',
        scheduledStart: '08:00',
        scheduledEnd: '17:00',
        timeIn: '08:00',
        timeOut: null,
        workedMinutes: 0,
        deterministicFlags: ['working'],
        source: 'RFID',
      };

      const result = await evaluateAttendanceAnomaly(input, {
        policy: { enabled: true },
        apiKey: 'key',
      });

      expect(result.decision).toBe('missing_time_out');
      expect(result.confidence).toBe(1.0);
      expect(result.model).toBe('deterministic-rules');
    });

    it('evaluates normal shift with high confidence', async () => {
      const mockFetch = async () =>
        new Response(
          JSON.stringify({
            model: 'jev-latest',
            answers: {
              attendance_anomaly: {
                type: 'choice',
                choice: 'normal',
                confidence: 0.95,
                probabilities: { normal: 0.95, late_arrival: 0.05 },
              },
            },
          }),
        );

      const input = {
        recordId: 'att-3',
        employeeRef: 'emp-1',
        date: '2026-09-01',
        scheduledStart: '08:00',
        scheduledEnd: '17:00',
        timeIn: '07:58',
        timeOut: '17:01',
        workedMinutes: 480,
        deterministicFlags: [],
        source: 'RFID',
      };

      // SAFETY: custom fetch test double adheres to Fetch signature
      const customFetch = mockFetch as typeof fetch;
      const result = await evaluateAttendanceAnomaly(input, {
        policy: { enabled: true, minConfidenceThreshold: 0.7 },
        apiKey: 'test-key',
        customFetch,
      });

      expect(result.decision).toBe('normal');
      expect(result.confidence).toBe(0.95);
      expect(result.status).toBe('evaluated');
    });

    it('routes low confidence evaluation to manual_review', async () => {
      const mockFetch = async () =>
        new Response(
          JSON.stringify({
            model: 'jev-latest',
            answers: {
              attendance_anomaly: {
                type: 'choice',
                choice: 'late_arrival',
                confidence: 0.55,
                probabilities: { late_arrival: 0.55, normal: 0.45 },
              },
            },
          }),
        );

      const input = {
        recordId: 'att-4',
        employeeRef: 'emp-1',
        date: '2026-09-01',
        scheduledStart: '08:00',
        scheduledEnd: '17:00',
        timeIn: '08:01',
        timeOut: '17:00',
        workedMinutes: 479,
        deterministicFlags: ['grace_period'],
        source: 'RFID',
      };

      // SAFETY: custom fetch test double adheres to Fetch signature
      const customFetch = mockFetch as typeof fetch;
      const result = await evaluateAttendanceAnomaly(input, {
        policy: { enabled: true, minConfidenceThreshold: 0.7 },
        apiKey: 'test-key',
        customFetch,
      });

      expect(result.decision).toBe('manual_review');
      expect(result.status).toBe('fallback');
      expect(result.fallbackReason).toBe('confidence_below_threshold');
    });
  });

  describe('Evaluator B: evaluatePayrollRecord', () => {
    it('evaluates consistent payroll calculation', async () => {
      const mockFetch = async () =>
        new Response(
          JSON.stringify({
            model: 'jev-latest',
            answers: {
              payroll_review: {
                type: 'choice',
                choice: 'consistent',
                confidence: 0.92,
                probabilities: { consistent: 0.92, contains_anomaly: 0.08 },
              },
            },
          }),
        );

      const input = {
        payrollRef: 'pay-1',
        period: '2026-09-01/2026-09-15',
        regularMinutes: 4800,
        overtimeMinutes: 0,
        lateMinutes: 0,
        undertimeMinutes: 0,
        absenceDays: 0,
        manualAdjustmentCount: 0,
        previousPeriodNetChangePercent: 0,
        calculationVersion: 'deterministic-v1',
      };

      // SAFETY: custom fetch test double adheres to Fetch signature
      const customFetch = mockFetch as typeof fetch;
      const result = await evaluatePayrollRecord(input, {
        policy: { enabled: true, minConfidenceThreshold: 0.7 },
        apiKey: 'test-key',
        customFetch,
      });

      expect(result.decision).toBe('consistent');
      expect(result.confidence).toBe(0.92);
      expect(result.status).toBe('evaluated');
    });

    it('routes low confidence payroll to requires_supervisor_review', async () => {
      const mockFetch = async () =>
        new Response(
          JSON.stringify({
            model: 'jev-latest',
            answers: {
              payroll_review: {
                type: 'choice',
                choice: 'consistent',
                confidence: 0.5,
                probabilities: { consistent: 0.5, unusual_change: 0.5 },
              },
            },
          }),
        );

      const input = {
        payrollRef: 'pay-2',
        period: '2026-09-01/2026-09-15',
        regularMinutes: 4800,
        overtimeMinutes: 200,
        lateMinutes: 10,
        undertimeMinutes: 0,
        absenceDays: 0,
        manualAdjustmentCount: 2,
        previousPeriodNetChangePercent: 35.0,
        calculationVersion: 'deterministic-v1',
      };

      // SAFETY: custom fetch test double adheres to Fetch signature
      const customFetch = mockFetch as typeof fetch;
      const result = await evaluatePayrollRecord(input, {
        policy: { enabled: true, minConfidenceThreshold: 0.7 },
        apiKey: 'test-key',
        customFetch,
      });

      expect(result.decision).toBe('requires_supervisor_review');
      expect(result.status).toBe('fallback');
      expect(result.fallbackReason).toBe('confidence_below_threshold');
    });
  });

  describe('Evaluator C: evaluateAttendanceCorrection', () => {
    it('applies deterministic rule when reason is empty', async () => {
      const input = {
        correctionRef: 'corr-1',
        employeeRef: 'emp-1',
        date: '2026-09-02',
        originalTimeIn: '08:45',
        originalTimeOut: '17:00',
        proposedTimeIn: '08:00',
        proposedTimeOut: '17:00',
        adjustmentMinutes: 45,
        reason: '   ',
        supervisorRef: 'sup-1',
      };

      const result = await evaluateAttendanceCorrection(input, {
        policy: { enabled: true },
        apiKey: 'key',
      });

      expect(result.decision).toBe('missing_reason');
      expect(result.confidence).toBe(1.0);
      expect(result.model).toBe('deterministic-rules');
    });

    it('evaluates plausible correction with high confidence', async () => {
      const mockFetch = async () =>
        new Response(
          JSON.stringify({
            model: 'jev-latest',
            answers: {
              attendance_correction: {
                type: 'choice',
                choice: 'plausible',
                confidence: 0.88,
                probabilities: { plausible: 0.88, requires_approval: 0.12 },
              },
            },
          }),
        );

      const input = {
        correctionRef: 'corr-2',
        employeeRef: 'emp-1',
        date: '2026-09-02',
        originalTimeIn: '08:30',
        originalTimeOut: '17:00',
        proposedTimeIn: '08:00',
        proposedTimeOut: '17:00',
        adjustmentMinutes: 30,
        reason: 'Operator verified RFID reader was offline between 8:00 and 8:30',
        supervisorRef: 'sup-1',
      };

      // SAFETY: custom fetch test double adheres to Fetch signature
      const customFetch = mockFetch as typeof fetch;
      const result = await evaluateAttendanceCorrection(input, {
        policy: { enabled: true, minConfidenceThreshold: 0.7 },
        apiKey: 'test-key',
        customFetch,
      });

      expect(result.decision).toBe('plausible');
      expect(result.confidence).toBe(0.88);
      expect(result.status).toBe('evaluated');
    });

    it('routes low confidence correction to requires_approval', async () => {
      const mockFetch = async () =>
        new Response(
          JSON.stringify({
            model: 'jev-latest',
            answers: {
              attendance_correction: {
                type: 'choice',
                choice: 'plausible',
                confidence: 0.6,
                probabilities: { plausible: 0.6, unusually_large_adjustment: 0.4 },
              },
            },
          }),
        );

      const input = {
        correctionRef: 'corr-3',
        employeeRef: 'emp-1',
        date: '2026-09-02',
        originalTimeIn: null,
        originalTimeOut: null,
        proposedTimeIn: '08:00',
        proposedTimeOut: '17:00',
        adjustmentMinutes: 480,
        reason: 'Forgot card at home',
        supervisorRef: 'sup-1',
      };

      // SAFETY: custom fetch test double adheres to Fetch signature
      const customFetch = mockFetch as typeof fetch;
      const result = await evaluateAttendanceCorrection(input, {
        policy: { enabled: true, minConfidenceThreshold: 0.7 },
        apiKey: 'test-key',
        customFetch,
      });

      expect(result.decision).toBe('requires_approval');
      expect(result.status).toBe('fallback');
      expect(result.fallbackReason).toBe('confidence_below_threshold');
    });
  });
});
