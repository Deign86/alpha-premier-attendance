/**
 * Developer-only CLI tool for testing JEV evaluation layer.
 * Run via: npx tsx tools/jev/cli.ts [scenario]
 * Scenarios: all | attendance | payroll | correction
 */

import {
  evaluateAttendanceAnomaly,
  evaluateAttendanceCorrection,
  evaluatePayrollRecord,
} from './evaluators.js';

const apiKey = globalThis.process?.env?.['TYPESAFE_API_KEY'];

console.log('======================================================');
console.log(' Alpha Premier Attendance — JEV Developer Bug Finder  ');
console.log('======================================================');
console.log(`TypeSafe API Key: ${apiKey ? 'Configured (Live mode)' : 'Not found (Offline fallback mode)'}\n`);

async function runAttendanceBugCheck() {
  console.log('--- 1. Testing Attendance Anomaly Classifier ---');

  const testCases = [
    {
      name: 'Shift with 17-minute arrival delay',
      input: {
        recordId: 'dev-att-001',
        employeeRef: 'emp_dev_01',
        date: '2026-09-01',
        scheduledStart: '08:00',
        scheduledEnd: '17:00',
        timeIn: '08:17',
        timeOut: '17:05',
        workedMinutes: 482,
        deterministicFlags: ['late_arrival'],
        priorAnomalyCount: 0,
        source: 'RFID',
        hasSupervisorCorrection: false,
      },
    },
    {
      name: 'Missing Time-In Bug Candidate',
      input: {
        recordId: 'dev-att-002',
        employeeRef: 'emp_dev_02',
        date: '2026-09-01',
        scheduledStart: '08:00',
        scheduledEnd: '17:00',
        timeIn: null,
        timeOut: '17:00',
        workedMinutes: 0,
        deterministicFlags: ['missing_time_in'],
        priorAnomalyCount: 1,
        source: 'RFID',
        hasSupervisorCorrection: false,
      },
    },
    {
      name: 'Unusually Short Shift (< 1 hour worked)',
      input: {
        recordId: 'dev-att-003',
        employeeRef: 'emp_dev_03',
        date: '2026-09-01',
        scheduledStart: '08:00',
        scheduledEnd: '17:00',
        timeIn: '08:00',
        timeOut: '08:42',
        workedMinutes: 42,
        deterministicFlags: ['early_departure'],
        priorAnomalyCount: 2,
        source: 'RFID',
        hasSupervisorCorrection: false,
      },
    },
  ];

  for (const tc of testCases) {
    const res = await evaluateAttendanceAnomaly(tc.input, {
      policy: { enabled: true, timeoutMs: 10000 },
      apiKey,
    });
    console.log(`[Case] ${tc.name}`);
    console.log(`  Decision:   ${res.decision}`);
    console.log(`  Confidence: ${(res.confidence * 100).toFixed(1)}%`);
    console.log(`  Model:      ${res.model} (${res.latencyMs}ms)`);
    console.log(`  Status:     ${res.status}`);
    console.log();
  }
}

async function runPayrollBugCheck() {
  console.log('--- 2. Testing Payroll Calculation Reviewer ---');

  const testCases = [
    {
      name: 'Standard Clean Cutoff Summary',
      input: {
        payrollRef: 'dev-pay-001',
        period: '2026-09-01/2026-09-15',
        regularMinutes: 4800,
        overtimeMinutes: 0,
        lateMinutes: 0,
        undertimeMinutes: 0,
        absenceDays: 0,
        manualAdjustmentCount: 0,
        previousPeriodNetChangePercent: 1.2,
        calculationVersion: 'deterministic-v1',
      },
    },
    {
      name: 'Suspicious 45% Net Pay Spike with Manual Adjustments',
      input: {
        payrollRef: 'dev-pay-002',
        period: '2026-09-01/2026-09-15',
        regularMinutes: 4800,
        overtimeMinutes: 300,
        lateMinutes: 0,
        undertimeMinutes: 0,
        absenceDays: 0,
        manualAdjustmentCount: 4,
        previousPeriodNetChangePercent: 45.8,
        calculationVersion: 'deterministic-v1',
      },
    },
  ];

  for (const tc of testCases) {
    const res = await evaluatePayrollRecord(tc.input, {
      policy: { enabled: true, timeoutMs: 10000 },
      apiKey,
    });
    console.log(`[Case] ${tc.name}`);
    console.log(`  Decision:   ${res.decision}`);
    console.log(`  Confidence: ${(res.confidence * 100).toFixed(1)}%`);
    console.log(`  Model:      ${res.model} (${res.latencyMs}ms)`);
    console.log(`  Status:     ${res.status}`);
    console.log();
  }
}

async function runCorrectionBugCheck() {
  console.log('--- 3. Testing Attendance Correction Evaluator ---');

  const testCases = [
    {
      name: 'Reasonable Correction: Hardware scanner timeout',
      input: {
        correctionRef: 'dev-corr-001',
        employeeRef: 'emp_dev_01',
        date: '2026-09-02',
        originalTimeIn: '08:20',
        originalTimeOut: '17:00',
        proposedTimeIn: '08:00',
        proposedTimeOut: '17:00',
        adjustmentMinutes: 20,
        reason: 'Front desk scanner queue delay verified by receptionist',
        supervisorRef: 'sup_admin_01',
        priorCorrectionCount30Days: 0,
        hasConflictingRfidScan: false,
      },
    },
    {
      name: 'Suspicious Correction: Blank reason with 5-hour adjustment',
      input: {
        correctionRef: 'dev-corr-002',
        employeeRef: 'emp_dev_02',
        date: '2026-09-02',
        originalTimeIn: '13:00',
        originalTimeOut: '17:00',
        proposedTimeIn: '08:00',
        proposedTimeOut: '17:00',
        adjustmentMinutes: 300,
        reason: '   ',
        supervisorRef: 'sup_admin_02',
        priorCorrectionCount30Days: 4,
        hasConflictingRfidScan: true,
      },
    },
  ];

  for (const tc of testCases) {
    const res = await evaluateAttendanceCorrection(tc.input, {
      policy: { enabled: true, timeoutMs: 10000 },
      apiKey,
    });
    console.log(`[Case] ${tc.name}`);
    console.log(`  Decision:   ${res.decision}`);
    console.log(`  Confidence: ${(res.confidence * 100).toFixed(1)}%`);
    console.log(`  Model:      ${res.model} (${res.latencyMs}ms)`);
    console.log(`  Status:     ${res.status}`);
    console.log();
  }
}

async function main() {
  const arg = (globalThis.process?.argv?.[2] ?? 'all').toLowerCase();
  if (arg === 'attendance' || arg === 'all') await runAttendanceBugCheck();
  if (arg === 'payroll' || arg === 'all') await runPayrollBugCheck();
  if (arg === 'correction' || arg === 'all') await runCorrectionBugCheck();
  console.log('Developer evaluation run completed.');
}

void main();
