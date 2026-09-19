import { describe, expect, it } from 'vitest';
import {
  pseudonymizeEmployeeId,
  pseudonymizeRecordId,
  pseudonymizeSupervisorId,
  redactAttendanceInput,
  redactCorrectionInput,
  redactPayrollInput,
  sanitizeReasonText,
} from '../redaction.js';

describe('JEV redaction', () => {
  it('pseudonymizes user IDs deterministically without exposing raw input', () => {
    const p1 = pseudonymizeEmployeeId('USR_001');
    const p2 = pseudonymizeEmployeeId('USR_001');
    const p3 = pseudonymizeEmployeeId('USR_002');

    expect(p1).toBe(p2);
    expect(p1).not.toBe(p3);
    expect(p1).toMatch(/^emp_[0-9a-f]{8}$/);
    expect(p1).not.toContain('USR_001');
  });

  it('pseudonymizes supervisor and record IDs', () => {
    const sup = pseudonymizeSupervisorId('ADMIN_SUPERVISOR_1');
    expect(sup).toMatch(/^sup_[0-9a-f]{8}$/);

    const rec = pseudonymizeRecordId('att', 'attendance-uuid-456');
    expect(rec).toMatch(/^att_[0-9a-f]{8}$/);
  });

  it('strips emails and phone numbers from reason strings', () => {
    const raw = 'Employee called +639171234567 and emailed john.doe@example.com stating car breakdown';
    const cleaned = sanitizeReasonText(raw);

    expect(cleaned).not.toContain('+639171234567');
    expect(cleaned).not.toContain('john.doe@example.com');
    expect(cleaned).toContain('[REDACTED_PHONE]');
    expect(cleaned).toContain('[REDACTED_EMAIL]');
    expect(cleaned).toContain('stating car breakdown');
  });

  it('redacts raw attendance records into safe anonymous inputs', () => {
    const raw = {
      attendanceId: 'att-uuid-1',
      userId: 'USR_REAL_001',
      attendanceDate: '2026-09-01',
      timeIn: '08:05',
      timeOut: '17:00',
      workedMinutes: 475,
      deterministicFlags: ['grace_period'],
      priorAnomalyCount: 0,
      source: 'RFID',
      hasSupervisorCorrection: false,
    };

    const redacted = redactAttendanceInput(raw);
    expect(redacted.employeeRef).not.toContain('USR_REAL_001');
    expect(redacted.recordId).not.toContain('att-uuid-1');
    expect(redacted.workedMinutes).toBe(475);
    expect(redacted.deterministicFlags).toEqual(['grace_period']);
  });

  it('redacts raw payroll data into aggregated metrics', () => {
    const raw = {
      payrollId: 'pay-uuid-10',
      cutoffStart: '2026-09-01',
      cutoffEnd: '2026-09-15',
      regularMinutes: 4800,
      overtimeMinutes: 0,
      lateMinutes: 15,
      undertimeMinutes: 0,
      absenceDays: 0,
      manualAdjustmentCount: 0,
      previousPeriodNetChangePercent: 2.1,
    };

    const redacted = redactPayrollInput(raw);
    expect(redacted.payrollRef).toMatch(/^pay_[0-9a-f]{8}$/);
    expect(redacted.period).toBe('2026-09-01/2026-09-15');
    expect(redacted.previousPeriodNetChangePercent).toBe(2.1);
  });

  it('redacts correction data and sanitizes free-form text', () => {
    const raw = {
      correctionId: 'corr-uuid-99',
      userId: 'USR_777',
      attendanceDate: '2026-09-03',
      originalTimeIn: '09:00',
      originalTimeOut: '17:00',
      proposedTimeIn: '08:00',
      proposedTimeOut: '17:00',
      adjustmentMinutes: 60,
      reason: 'Please adjust, employee reached out to boss@company.ph',
      supervisorId: 'ADMIN_01',
    };

    const redacted = redactCorrectionInput(raw);
    expect(redacted.employeeRef).toMatch(/^emp_[0-9a-f]{8}$/);
    expect(redacted.supervisorRef).toMatch(/^sup_[0-9a-f]{8}$/);
    expect(redacted.reason).not.toContain('boss@company.ph');
    expect(redacted.reason).toContain('[REDACTED_EMAIL]');
  });
});
