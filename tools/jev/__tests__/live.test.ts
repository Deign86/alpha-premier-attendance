import { describe, expect, it } from 'vitest';
import {
  evaluateAttendanceAnomaly,
  evaluateAttendanceCorrection,
  evaluatePayrollRecord,
} from '../evaluators.js';

const apiKey = globalThis.process?.env?.['TYPESAFE_API_KEY'];
const runLive = Boolean(apiKey && apiKey.trim().length > 0);

describe.runIf(runLive)('JEV live API integration (System One)', () => {
  it('evaluates attendance anomaly against live TypeSafe endpoint', async () => {
    const input = {
      recordId: 'att-live-001',
      employeeRef: 'emp-live-001',
      date: '2026-09-01',
      scheduledStart: '08:00',
      scheduledEnd: '17:00',
      timeIn: '08:17',
      timeOut: '17:02',
      workedMinutes: 482,
      deterministicFlags: ['late_arrival'],
      priorAnomalyCount: 0,
      source: 'RFID',
      hasSupervisorCorrection: false,
    };

    const result = await evaluateAttendanceAnomaly(input, {
      policy: { enabled: true, timeoutMs: 10000 },
      apiKey,
    });

    expect(result.model).toContain('jev');
    expect(result.status).toBe('evaluated');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.decision).toBe('late_arrival');
    expect(result.latencyMs).toBeGreaterThan(0);
  }, 15000);

  it('evaluates payroll record review against live TypeSafe endpoint', async () => {
    const input = {
      payrollRef: 'pay-live-001',
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

    const result = await evaluatePayrollRecord(input, {
      policy: { enabled: true, timeoutMs: 10000 },
      apiKey,
    });

    expect(result.model).toContain('jev');
    expect(result.status).toBe('evaluated');
    expect(result.decision).toBe('consistent');
    expect(result.confidence).toBeGreaterThan(0.7);
  }, 15000);

  it('evaluates attendance correction against live TypeSafe endpoint', async () => {
    const input = {
      correctionRef: 'corr-live-001',
      employeeRef: 'emp-live-001',
      date: '2026-09-02',
      originalTimeIn: '08:25',
      originalTimeOut: '17:00',
      proposedTimeIn: '08:00',
      proposedTimeOut: '17:00',
      adjustmentMinutes: 25,
      reason: 'Front desk scanner queue delay confirmed by front desk officer',
      supervisorRef: 'sup-live-001',
      priorCorrectionCount30Days: 0,
      hasConflictingRfidScan: false,
    };

    const result = await evaluateAttendanceCorrection(input, {
      policy: { enabled: true, timeoutMs: 10000 },
      apiKey,
    });

    expect(result.model).toContain('jev');
    expect(result.status).toBe('evaluated');
    expect(result.decision).toBe('plausible');
    expect(result.confidence).toBeGreaterThan(0.7);
  }, 15000);
});
