import { describe, expect, it } from 'vitest';
import {
  isAttendanceAnomalyChoice,
  isAttendanceCorrectionChoice,
  isPayrollRecordReviewChoice,
  JevValidationError,
  validateAttendanceAnomalyInput,
  validateAttendanceCorrectionInput,
  validateChoiceAnswer,
  validatePayrollRecordReviewInput,
} from '../schemas.js';
import { ATTENDANCE_ANOMALY_CHOICES } from '../types.js';

describe('JEV schemas', () => {
  describe('validateAttendanceAnomalyInput', () => {
    it('validates a complete, well-formed attendance anomaly input', () => {
      const input = {
        recordId: 'att_123',
        employeeRef: 'emp_abc',
        date: '2026-09-01',
        scheduledStart: '08:00',
        scheduledEnd: '17:00',
        timeIn: '08:17',
        timeOut: '17:02',
        workedMinutes: 482,
        deterministicFlags: ['late_arrival'],
        priorAnomalyCount: 1,
        source: 'RFID',
        hasSupervisorCorrection: false,
      };

      const result = validateAttendanceAnomalyInput(input);
      expect(result.recordId).toBe('att_123');
      expect(result.employeeRef).toBe('emp_abc');
      expect(result.date).toBe('2026-09-01');
      expect(result.workedMinutes).toBe(482);
      expect(result.deterministicFlags).toEqual(['late_arrival']);
    });

    it('rejects invalid date format', () => {
      const input = {
        recordId: 'att_123',
        employeeRef: 'emp_abc',
        date: '09-01-2026',
        scheduledStart: '08:00',
        scheduledEnd: '17:00',
        workedMinutes: 480,
        deterministicFlags: [],
        source: 'RFID',
      };

      expect(() => validateAttendanceAnomalyInput(input)).toThrow(JevValidationError);
    });

    it('rejects negative worked minutes', () => {
      const input = {
        recordId: 'att_123',
        employeeRef: 'emp_abc',
        date: '2026-09-01',
        scheduledStart: '08:00',
        scheduledEnd: '17:00',
        workedMinutes: -10,
        deterministicFlags: [],
        source: 'RFID',
      };

      expect(() => validateAttendanceAnomalyInput(input)).toThrow(JevValidationError);
    });
  });

  describe('validatePayrollRecordReviewInput', () => {
    it('validates a complete payroll review input', () => {
      const input = {
        payrollRef: 'pay_999',
        period: '2026-09-01/2026-09-15',
        regularMinutes: 4800,
        overtimeMinutes: 120,
        lateMinutes: 45,
        undertimeMinutes: 0,
        absenceDays: 0,
        manualAdjustmentCount: 1,
        previousPeriodNetChangePercent: 8.5,
        calculationVersion: 'deterministic-v1',
      };

      const result = validatePayrollRecordReviewInput(input);
      expect(result.payrollRef).toBe('pay_999');
      expect(result.regularMinutes).toBe(4800);
      expect(result.previousPeriodNetChangePercent).toBe(8.5);
    });

    it('rejects missing payrollRef', () => {
      const input = {
        payrollRef: '',
        period: '2026-09-01/2026-09-15',
        regularMinutes: 4800,
        overtimeMinutes: 0,
        lateMinutes: 0,
        undertimeMinutes: 0,
        absenceDays: 0,
        manualAdjustmentCount: 0,
        previousPeriodNetChangePercent: 0,
        calculationVersion: 'v1',
      };

      expect(() => validatePayrollRecordReviewInput(input)).toThrow(JevValidationError);
    });
  });

  describe('validateAttendanceCorrectionInput', () => {
    it('validates a valid manual correction request', () => {
      const input = {
        correctionRef: 'corr_555',
        employeeRef: 'emp_xyz',
        date: '2026-09-02',
        originalTimeIn: '08:45',
        originalTimeOut: '17:00',
        proposedTimeIn: '08:00',
        proposedTimeOut: '17:00',
        adjustmentMinutes: 45,
        reason: 'Badge scanner timeout at front desk',
        supervisorRef: 'sup_admin',
        priorCorrectionCount30Days: 0,
        hasConflictingRfidScan: false,
      };

      const result = validateAttendanceCorrectionInput(input);
      expect(result.correctionRef).toBe('corr_555');
      expect(result.adjustmentMinutes).toBe(45);
      expect(result.reason).toBe('Badge scanner timeout at front desk');
    });
  });

  describe('validateChoiceAnswer', () => {
    it('validates a correct choice answer and parses probabilities map', () => {
      const raw = {
        model: 'jev-latest',
        answers: {
          test_q: {
            type: 'choice',
            choice: 'late_arrival',
            confidence: 0.94,
            probabilities: {
              normal: 0.04,
              late_arrival: 0.94,
              early_departure: 0.02,
            },
          },
        },
      };

      const validated = validateChoiceAnswer(raw, 'test_q', ATTENDANCE_ANOMALY_CHOICES);
      expect(validated.choice).toBe('late_arrival');
      expect(validated.confidence).toBe(0.94);
      expect(validated.probabilities['late_arrival']).toBe(0.94);
      expect(validated.probabilities['normal']).toBe(0.04);
      expect(validated.probabilities['duplicate_scan']).toBe(0);
    });

    it('rejects an answer with choice not in allowed list', () => {
      const raw = {
        model: 'jev-latest',
        answers: {
          test_q: {
            type: 'choice',
            choice: 'fabricated_choice',
            confidence: 0.9,
            probabilities: { fabricated_choice: 0.9 },
          },
        },
      };

      expect(() => validateChoiceAnswer(raw, 'test_q', ATTENDANCE_ANOMALY_CHOICES)).toThrow(
        JevValidationError,
      );
    });

    it('rejects out-of-bounds confidence', () => {
      const raw = {
        model: 'jev-latest',
        answers: {
          test_q: {
            type: 'choice',
            choice: 'normal',
            confidence: 1.5,
            probabilities: { normal: 1.0 },
          },
        },
      };

      expect(() => validateChoiceAnswer(raw, 'test_q', ATTENDANCE_ANOMALY_CHOICES)).toThrow(
        JevValidationError,
      );
    });
  });

  describe('choice guards', () => {
    it('verifies valid choices against union lists', () => {
      expect(isAttendanceAnomalyChoice('normal')).toBe(true);
      expect(isAttendanceAnomalyChoice('invalid_choice')).toBe(false);

      expect(isPayrollRecordReviewChoice('consistent')).toBe(true);
      expect(isPayrollRecordReviewChoice('unknown')).toBe(false);

      expect(isAttendanceCorrectionChoice('plausible')).toBe(true);
      expect(isAttendanceCorrectionChoice('unknown')).toBe(false);
    });
  });
});
