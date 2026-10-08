import { describe, expect, it } from 'vitest';
import { getManilaWeekStart } from '@rfid-attendance/shared';
import payrollContract from './fixtures/ts-payroll-fixtures.json';
import { calculateInternPayroll } from '../src/intern-payroll.js';
import { buildDtrRow } from '../src/intern-dtr-sync.js';

type SeptemberAttendanceFixture = {
  attendanceDate: string;
  userId: string;
  fullName: string;
  timeIn: string;
  timeOut: string;
  expected: {
    graceUsed: boolean;
    lateHours: number;
    lateDeduction: number;
    halfDayDeduction: number;
    dailyPay: number;
  };
};

const SEPTEMBER_ATTENDANCE: SeptemberAttendanceFixture[] = [
  { attendanceDate: '2026-09-01', userId: 'APG-2026-116', fullName: 'Maricon', timeIn: '08:08:00', timeOut: '17:00:00', expected: { graceUsed: true, lateHours: 0, lateDeduction: 0, halfDayDeduction: 0, dailyPay: 80 } },
  { attendanceDate: '2026-09-02', userId: 'APG-2026-116', fullName: 'Maricon', timeIn: '08:08:00', timeOut: '17:00:00', expected: { graceUsed: false, lateHours: 1, lateDeduction: 10, halfDayDeduction: 0, dailyPay: 70 } },
  { attendanceDate: '2026-09-03', userId: 'APG-2026-117', fullName: 'Lhoize', timeIn: '08:00:00', timeOut: '17:00:00', expected: { graceUsed: false, lateHours: 0, lateDeduction: 0, halfDayDeduction: 0, dailyPay: 80 } },
  { attendanceDate: '2026-09-04', userId: 'APG-2026-117', fullName: 'Lhoize', timeIn: '08:00:01', timeOut: '17:00:00', expected: { graceUsed: false, lateHours: 0, lateDeduction: 0, halfDayDeduction: 0, dailyPay: 80 } },
  { attendanceDate: '2026-09-01', userId: 'APG-2026-119', fullName: 'Melanie', timeIn: '09:00:01', timeOut: '17:00:00', expected: { graceUsed: false, lateHours: 1, lateDeduction: 10, halfDayDeduction: 10, dailyPay: 60 } },
  { attendanceDate: '2026-09-02', userId: 'APG-2026-119', fullName: 'Melanie', timeIn: '08:00:00', timeOut: '16:00:00', expected: { graceUsed: false, lateHours: 0, lateDeduction: 0, halfDayDeduction: 10, dailyPay: 70 } },
  { attendanceDate: '2026-09-03', userId: 'APG-2026-119', fullName: 'Melanie', timeIn: '08:00:00', timeOut: '15:00:00', expected: { graceUsed: false, lateHours: 0, lateDeduction: 0, halfDayDeduction: 20, dailyPay: 60 } },
  { attendanceDate: '2026-09-04', userId: 'APG-2026-119', fullName: 'Melanie', timeIn: '08:30:00', timeOut: '16:00:00', expected: { graceUsed: false, lateHours: 1, lateDeduction: 10, halfDayDeduction: 10, dailyPay: 60 } },
  { attendanceDate: '2026-09-07', userId: 'APG-2026-117', fullName: 'Lhoize', timeIn: '08:08:00', timeOut: '17:00:00', expected: { graceUsed: true, lateHours: 0, lateDeduction: 0, halfDayDeduction: 0, dailyPay: 80 } },
  { attendanceDate: '2026-09-08', userId: 'APG-2026-117', fullName: 'Lhoize', timeIn: '08:08:00', timeOut: '17:00:00', expected: { graceUsed: false, lateHours: 1, lateDeduction: 10, halfDayDeduction: 0, dailyPay: 70 } },
  { attendanceDate: '2026-09-09', userId: 'APG-2026-118', fullName: 'Sophia', timeIn: '08:15:00', timeOut: '17:00:00', expected: { graceUsed: true, lateHours: 0, lateDeduction: 0, halfDayDeduction: 0, dailyPay: 80 } },
  { attendanceDate: '2026-09-10', userId: 'APG-2026-118', fullName: 'Sophia', timeIn: '08:15:01', timeOut: '17:00:00', expected: { graceUsed: false, lateHours: 1, lateDeduction: 10, halfDayDeduction: 0, dailyPay: 70 } },
  { attendanceDate: '2026-09-11', userId: 'APG-2026-118', fullName: 'Sophia', timeIn: '08:16:00', timeOut: '17:00:00', expected: { graceUsed: false, lateHours: 1, lateDeduction: 10, halfDayDeduction: 0, dailyPay: 70 } },
  { attendanceDate: '2026-09-14', userId: 'APG-2026-118', fullName: 'Sophia', timeIn: '08:08:00', timeOut: '17:00:00', expected: { graceUsed: true, lateHours: 0, lateDeduction: 0, halfDayDeduction: 0, dailyPay: 80 } },
  { attendanceDate: '2026-09-15', userId: 'APG-2026-118', fullName: 'Sophia', timeIn: '08:30:00', timeOut: '16:00:00', expected: { graceUsed: false, lateHours: 1, lateDeduction: 10, halfDayDeduction: 10, dailyPay: 60 } },
];

function fixtureTimestamp(date: string, time: string): string {
  return `${date}T${time}+08:00`;
}

describe('intern payroll policy', () => {
  const sepSeed = payrollContract.sepInternGraceSeed;

  it.each(payrollContract.internArrivalPolicyV3)('$name', (testCase) => {
    const timeIn = fixtureTimestamp(testCase.date, testCase.timeIn);
    const result = calculateInternPayroll({
      attendanceDate: testCase.date,
      actualTimeIn: timeIn,
      actualTimeOut: fixtureTimestamp(testCase.date, '17:00:00'),
      graceAvailable: testCase.graceAvailable,
    });
    const dtr = buildDtrRow(timeIn, fixtureTimestamp(testCase.date, '17:00:00'), testCase.date,
      !testCase.expected.graceUsed);
    const { dtrIn: _dtrIn, ...payrollExpected } = testCase.expected;
    expect(result).toMatchObject(payrollExpected);
    expect(dtr[0]).toBe(testCase.expected.dtrIn);
  });

  it.each(sepSeed.expected.daily)(
    'matches Sep 1-15 intern seed $date ($computedTimeIn)',
    (expected) => {
      const { date: expectedDate, ...expectedResult } = expected;
      const row = sepSeed.rows.find((candidate) => candidate.date === expectedDate);
      expect(row, `seed row ${expectedDate}`).toBeDefined();
      if (!row) return;
      const weekStart = getManilaWeekStart(row.date);
      const graceAvailable = !sepSeed.rows.some((prior) =>
        prior.date < row.date &&
        getManilaWeekStart(prior.date) === weekStart &&
        prior.timeIn > '08:00:00' && prior.timeIn <= '08:15:00',
      );
      const result = calculateInternPayroll({
        attendanceDate: row.date,
        actualTimeIn: fixtureTimestamp(row.date, row.timeIn),
        actualTimeOut: fixtureTimestamp(row.date, row.timeOut),
        graceAvailable,
      });

      expect(result, `${row.date} ${row.timeIn}-${row.timeOut}`).toMatchObject({ basePay: 80, ...expectedResult });
      expect(result.lateDeduction + result.halfDayDeduction).toBeCloseTo(80 - result.dailyPay, 10);
    },
  );

  it('matches Sep 1-15 intern cutoff daily-pay total', () => {
    let total = 0;
    for (const row of sepSeed.rows) {
      const weekStart = getManilaWeekStart(row.date);
      const graceAvailable = !sepSeed.rows.some((prior) =>
        prior.date < row.date &&
        getManilaWeekStart(prior.date) === weekStart &&
        prior.timeIn > '08:00:00' && prior.timeIn <= '08:15:00',
      );
      total += calculateInternPayroll({
        attendanceDate: row.date,
        actualTimeIn: fixtureTimestamp(row.date, row.timeIn),
        actualTimeOut: fixtureTimestamp(row.date, row.timeOut),
        graceAvailable,
      }).dailyPay;
    }
    expect(total).toBe(780);
  });

  it('prices 08:15-to-15:00 grace and adjacent boundaries without double-charging', () => {
    const cases = [
      { label: 'first grace, exact 08:15', attendanceDate: '2026-09-21', timeIn: '08:15:00', timeOut: '15:00:00', graceAvailable: true, expected: { computedTimeIn: '2026-09-21T08:00:00+08:00', graceUsed: true, lateHours: 0, lateDeduction: 0, halfDayDeduction: 20, dailyPay: 60, workedHours: 6 } },
      { label: 'same-week grace exhausted, exact 08:15', attendanceDate: '2026-09-22', timeIn: '08:15:00', timeOut: '15:00:00', graceAvailable: false, expected: { graceUsed: false, lateHours: 1, lateDeduction: 10, halfDayDeduction: 20, dailyPay: 50, workedHours: 5.75 } },
      { label: 'one second beyond grace is ungraced', attendanceDate: '2026-09-23', timeIn: '08:15:01', timeOut: '17:00:00', graceAvailable: true, expected: { graceUsed: false, lateHours: 1, lateDeduction: 10, halfDayDeduction: 0, dailyPay: 70, workedHours: 7 } },
      { label: '08:16 arrival is ungraced when weekly budget is available', attendanceDate: '2026-09-24', timeIn: '08:16:00', timeOut: '17:00:00', graceAvailable: true, expected: { graceUsed: false, lateHours: 1, lateDeduction: 10, halfDayDeduction: 0, dailyPay: 70, workedHours: 7 } },
      { label: '08:00:01 arrival to 17:00', attendanceDate: '2026-09-25', timeIn: '08:00:01', timeOut: '17:00:00', graceAvailable: true, expected: { graceUsed: false, lateHours: 0, lateDeduction: 0, halfDayDeduction: 0, dailyPay: 80, workedHours: 8 } },
    ];

    expect(getManilaWeekStart(cases[0].attendanceDate)).toBe(getManilaWeekStart(cases[1].attendanceDate));

    for (const testCase of cases) {
      const result = calculateInternPayroll({
        attendanceDate: testCase.attendanceDate,
        actualTimeIn: fixtureTimestamp(testCase.attendanceDate, testCase.timeIn),
        actualTimeOut: fixtureTimestamp(testCase.attendanceDate, testCase.timeOut),
        graceAvailable: testCase.graceAvailable,
      });

      expect(result, testCase.label).toMatchObject({ basePay: 80, ...testCase.expected });
      expect(result.lateDeduction + result.halfDayDeduction, testCase.label).toBe(80 - result.dailyPay);
    }
  });

  it('September 2026 seeded attendance proves global rates, weekly grace, and non-overlapping deductions', () => {
    const graceUsedByUserWeek = new Set<string>();
    const sortedAttendance = [...SEPTEMBER_ATTENDANCE].sort((left, right) =>
      `${left.attendanceDate}T${left.timeIn}`.localeCompare(`${right.attendanceDate}T${right.timeIn}`),
    );

    for (const row of sortedAttendance) {
      const userWeek = `${row.userId}:${getManilaWeekStart(row.attendanceDate)}`;
      const graceAvailable = !graceUsedByUserWeek.has(userWeek);
      const result = calculateInternPayroll({
        attendanceDate: row.attendanceDate,
        actualTimeIn: fixtureTimestamp(row.attendanceDate, row.timeIn),
        actualTimeOut: fixtureTimestamp(row.attendanceDate, row.timeOut),
        graceAvailable,
      });

      expect(result, `${row.userId} ${row.fullName} ${row.attendanceDate} ${row.timeIn}-${row.timeOut}`).toMatchObject(row.expected);
      expect(result.basePay).toBe(80);
      expect(result.lateDeduction + result.halfDayDeduction).toBeCloseTo(80 - result.dailyPay, 10);
      if (result.graceUsed) graceUsedByUserWeek.add(userWeek);
    }
  });

  it('applies available weekly grace period for arrival between 08:00 and 08:15', () => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:12:00+08:00',
      actualTimeOut: '2026-07-28T17:10:00+08:00',
      graceAvailable: true,
    });

    expect(result).toMatchObject({
      computedTimeIn: '2026-07-28T08:00:00+08:00',
      computedTimeOut: '2026-07-28T17:10:00+08:00',
      lateHours: 0,
      lateDeduction: 0,
      graceUsed: true,
      basePay: 80,
      dailyPay: 80,
      workedHours: 8,
    });
  });

  it('QA Sept 24 Lhoize APG-2026-117: one late hour plus one separate undertime hour is PHP 20', () => {
    const result = calculateInternPayroll({ attendanceDate: '2026-09-24', actualTimeIn: '2026-09-24T08:30:00+08:00', actualTimeOut: '2026-09-24T16:00:00+08:00', graceAvailable: false });
    expect(result).toMatchObject({ lateHours: 1, lateDeduction: 10, halfDayDeduction: 10, dailyPay: 60 });
    expect(result.lateDeduction + result.halfDayDeduction).toBe(20);
  });

  it('QA Sept 24 Melanie APG-2026-119: one late hour plus one separate undertime hour is PHP 20', () => {
    const result = calculateInternPayroll({ attendanceDate: '2026-09-24', actualTimeIn: '2026-09-24T08:30:00+08:00', actualTimeOut: '2026-09-24T16:00:00+08:00', graceAvailable: false });
    expect(result.lateDeduction + result.halfDayDeduction).toBe(20);
  });

  it('QA Sept 22 Sophia APG-2026-118: one late hour plus one separate undertime hour is PHP 20', () => {
    const result = calculateInternPayroll({ attendanceDate: '2026-09-22', actualTimeIn: '2026-09-22T08:30:00+08:00', actualTimeOut: '2026-09-22T16:00:00+08:00', graceAvailable: false });
    expect(result.lateDeduction + result.halfDayDeduction).toBe(20);
  });

  it('Maricon second weekly grace is late', () => {
    expect(['2026-09-22', '2026-09-24', '2026-09-25'].map(getManilaWeekStart)).toEqual([
      '2026-09-21', '2026-09-21', '2026-09-21',
    ]);
    const results = ['2026-09-24', '2026-09-25'].map((date, index) =>
      calculateInternPayroll({ attendanceDate: date, actualTimeIn: `${date}T08:10:00+08:00`, actualTimeOut: `${date}T17:00:00+08:00`, graceAvailable: index === 0 }),
    );
    expect(results[0]).toMatchObject({ graceUsed: true, lateHours: 0, lateDeduction: 0, halfDayDeduction: 0, dailyPay: 80 });
    expect(results[1]).toMatchObject({ graceUsed: false, lateHours: 1, lateDeduction: 10, halfDayDeduction: 0, dailyPay: 70 });
  });

  it('does not forgive a late arrival outside the 08:15 grace window', () => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:17:00+08:00',
      actualTimeOut: '2026-07-28T17:10:00+08:00',
      graceAvailable: true,
    });

    expect(result).toMatchObject({
      computedTimeIn: '2026-07-28T09:00:00+08:00',
      lateHours: 1,
      lateDeduction: 10,
      graceUsed: false,
      basePay: 80,
      dailyPay: 70,
      workedHours: 7 + 1 / 6,
    });
  });

  it('late arrivals outside grace use the minute-15 hourly clamp', () => {
    for (const timeIn of ['08:30:00', '09:30:00']) {
      const result = calculateInternPayroll({
        attendanceDate: '2026-07-28',
        actualTimeIn: `2026-07-28T${timeIn}+08:00`,
        actualTimeOut: '2026-07-28T17:00:00+08:00',
        graceAvailable: true,
      });
      const afterNine = timeIn > '09:00:00';
      expect(result).toMatchObject({
        computedTimeIn: afterNine ? '2026-07-28T10:00:00+08:00' : '2026-07-28T09:00:00+08:00',
        graceUsed: false,
        lateHours: afterNine ? 2 : 1,
        lateDeduction: afterNine ? 20 : 10,
      });
      expect(result.dailyPay).toBeCloseTo(afterNine ? 60 : 70, 6);
    }
  });

  it('keeps an exact 09:00 late arrival at 09:00 and charges exactly one late hour', () => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-10-01',
      actualTimeIn: '2026-10-01T09:00:00+08:00',
      actualTimeOut: '2026-10-01T17:00:00+08:00',
      graceAvailable: true,
    });

    expect(result).toMatchObject({
      computedTimeIn: '2026-10-01T09:00:00+08:00',
      computedTimeOut: '2026-10-01T17:00:00+08:00',
      graceUsed: false,
      lateHours: 1,
      lateDeduction: 10,
      isHalfDay: false,
      halfDayDeduction: 0,
      dailyPay: 70,
      workedHours: 7,
    });
  });

  it('caps an exact 18:00 clock-out but preserves 17:59:59 below the threshold', () => {
    const atBoundary = calculateInternPayroll({
      attendanceDate: '2026-10-01',
      actualTimeIn: '2026-10-01T08:00:00+08:00',
      actualTimeOut: '2026-10-01T18:00:00+08:00',
      graceAvailable: false,
    });
    const beforeBoundary = calculateInternPayroll({
      attendanceDate: '2026-10-01',
      actualTimeIn: '2026-10-01T08:00:00+08:00',
      actualTimeOut: '2026-10-01T17:59:59+08:00',
      graceAvailable: false,
    });

    expect(atBoundary).toMatchObject({
      computedTimeOut: '2026-10-01T17:00:00+08:00',
      workedHours: 8,
      isHalfDay: false,
      halfDayDeduction: 0,
      dailyPay: 80,
    });
    expect(beforeBoundary).toMatchObject({
      computedTimeOut: '2026-10-01T17:59:59+08:00',
      workedHours: 8,
      isHalfDay: false,
      halfDayDeduction: 0,
      dailyPay: 80,
    });
  });

  it('weekly grace exhausted 08:08 stays actual and deducts one late hour', () => {
    const result = calculateInternPayroll({ attendanceDate: '2026-09-22', actualTimeIn: '2026-09-22T08:08:00+08:00', actualTimeOut: '2026-09-22T17:00:00+08:00', graceAvailable: false });
    expect(result).toMatchObject({ computedTimeIn: '2026-09-22T08:08:00+08:00', lateHours: 1, lateDeduction: 10, halfDayDeduction: 0, dailyPay: 70 });
  });

  it('preserves sub-millisecond precision when rounding post-cutover late hours', () => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-10-01',
      actualTimeIn: '2026-10-01T09:00:00.000000001+08:00',
      actualTimeOut: '2026-10-01T17:00:00+08:00',
      graceAvailable: true,
    });
    expect(result).toMatchObject({
      computedTimeIn: '2026-10-01T09:00:00+08:00',
      graceUsed: false,
      lateHours: 2,
      lateDeduction: 20,
    });
  });

  it('rejects post-cutover clock-ins on a different Manila calendar date', () => {
    expect(() => calculateInternPayroll({
      attendanceDate: '2026-10-01',
      actualTimeIn: '2026-09-30T15:59:00Z',
      actualTimeOut: '2026-10-01T17:00:00+08:00',
      graceAvailable: true,
    })).toThrow('Payroll clock-in date must match attendanceDate in Manila');
  });

  it('keeps legacy pre-cutover handling for mismatched clock-in dates', () => {
    expect(() => calculateInternPayroll({
      attendanceDate: '2026-09-30',
      actualTimeIn: '2026-10-01T00:00:00+08:00',
      actualTimeOut: '2026-10-01T17:00:00+08:00',
      graceAvailable: true,
    })).not.toThrow();
  });

  it('treats fractional milliseconds after 08:15:00 as late but preserves the exact grace endpoint', () => {
    const exactGraceEnd = calculateInternPayroll({
      attendanceDate: '2026-09-22',
      actualTimeIn: '2026-09-22T08:15:00.000+08:00',
      actualTimeOut: '2026-09-22T17:00:00+08:00',
      graceAvailable: true,
    });
    const fractionalLate = calculateInternPayroll({
      attendanceDate: '2026-09-22',
      actualTimeIn: '2026-09-22T08:15:00.500+08:00',
      actualTimeOut: '2026-09-22T17:00:00+08:00',
      graceAvailable: true,
    });

    expect(exactGraceEnd).toMatchObject({ graceUsed: true, lateHours: 0, computedTimeIn: '2026-09-22T08:00:00+08:00' });
    expect(fractionalLate).toMatchObject({
      graceUsed: false,
      lateHours: 1,
      lateDeduction: 10,
      computedTimeIn: '2026-09-22T09:00:00+08:00',
    });
  });

  it.each([
    { timeIn: '09:03:00', effective: '09:03:00', hours: 1 },
    { timeIn: '09:15:00', effective: '09:15:00', hours: 1 },
    { timeIn: '09:15:00.000000001', effective: '10:00:00', hours: 2 },
    { timeIn: '09:15:00.001', effective: '10:00:00', hours: 2 },
    { timeIn: '09:16:00', effective: '10:00:00', hours: 2 },
    { timeIn: '10:16:00', effective: '11:00:00', hours: 3 },
  ])('applies hourly :15 clamp at $timeIn', ({ timeIn, effective, hours }) => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-09-22',
      actualTimeIn: `2026-09-22T${timeIn}+08:00`,
      actualTimeOut: '2026-09-22T17:00:00+08:00',
      graceAvailable: false,
    });
    expect(result.computedTimeIn).toBe(`2026-09-22T${effective}+08:00`);
    expect(result.lateHours).toBe(hours);
    expect(result.lateDeduction).toBe(hours * 10);
  });

  it('keeps exact 08:15:00 grace but treats the next nanosecond as late', () => {
    const exact = calculateInternPayroll({
      attendanceDate: '2026-09-22',
      actualTimeIn: '2026-09-22T08:15:00.000+08:00',
      actualTimeOut: '2026-09-22T17:00:00+08:00',
      graceAvailable: true,
    });
    const after = calculateInternPayroll({
      attendanceDate: '2026-09-22',
      actualTimeIn: '2026-09-22T08:15:00.000000001+08:00',
      actualTimeOut: '2026-09-22T17:00:00+08:00',
      graceAvailable: true,
    });
    expect(exact).toMatchObject({ graceUsed: true, lateHours: 0, computedTimeIn: '2026-09-22T08:00:00+08:00' });
    expect(after).toMatchObject({ graceUsed: false, lateHours: 1, computedTimeIn: '2026-09-22T09:00:00+08:00' });
  });

  it('undertime excludes late hours already deducted through computed time-in', () => {
    const noExtraShortfall = calculateInternPayroll({ attendanceDate: '2026-09-22', actualTimeIn: '2026-09-22T08:08:00+08:00', actualTimeOut: '2026-09-22T17:00:00+08:00', graceAvailable: false });
    const oneAdditionalShortfall = calculateInternPayroll({ attendanceDate: '2026-09-22', actualTimeIn: '2026-09-22T08:08:00+08:00', actualTimeOut: '2026-09-22T16:00:00+08:00', graceAvailable: false });
    expect(noExtraShortfall.lateDeduction + noExtraShortfall.halfDayDeduction).toBe(10);
    expect(oneAdditionalShortfall.lateDeduction + oneAdditionalShortfall.halfDayDeduction).toBe(20);
    expect(oneAdditionalShortfall.halfDayDeduction).toBe(10);
  });

  it('computes daily pay strictly 1:1 from DTR hours (8:00 AM to 3:00 PM -> 6 hours -> ₱60)', () => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T15:00:00+08:00',
      graceAvailable: false,
    });
    expect(result.workedHours).toBe(6);
    expect(result.dailyPay).toBe(60);
    expect(result.halfDayDeduction).toBe(20);
    expect(result.basePay).toBe(80);
  });

  it('computes 7 hours for 8:00 AM to 4:00 PM -> ₱70 (₱10 deduction)', () => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T16:00:00+08:00',
      graceAvailable: true,
    });
    expect(result.workedHours).toBe(7);
    expect(result.dailyPay).toBe(70);
    expect(result.halfDayDeduction).toBe(10);
    expect(result.basePay).toBe(80);
  });

  it('computes full daily rate for 8:00 AM to 5:00 PM full day -> 8 hours -> ₱80', () => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T17:00:00+08:00',
      graceAvailable: true,
    });
    expect(result.workedHours).toBe(8);
    expect(result.dailyPay).toBe(80);
    expect(result.halfDayDeduction).toBe(0);
    expect(result.basePay).toBe(80);
  });

  it('never counts unworked time beyond DTR time-in/out and calculates 1:1 hours', () => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T17:00:00+08:00',
      graceAvailable: true,
    });
    expect(result.workedHours).toBe(8);
    expect(result.isHalfDay).toBe(false);
    expect(result.dailyPay).toBe(80);
  });

  it('deducts unrendered hours for shifts under 8 hours and treats full shift as full day', () => {
    // 08:00 to 15:00 (3:00 PM): 6 payable hours (7h - 1h lunch), 2h unrendered deducted (₱20).
    const early = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T15:00:00+08:00',
      graceAvailable: true,
    });
    expect(early.workedHours).toBe(6);
    expect(early.isHalfDay).toBe(false);
    expect(early.halfDayDeduction).toBe(20);
    expect(early.dailyPay).toBe(60);

    // 08:00 to 16:00: 7 hours (8h - 1h lunch), 1h unrendered deducted (₱10).
    const sevenHours = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T16:00:00+08:00',
      graceAvailable: true,
    });
    expect(sevenHours.workedHours).toBe(7);
    expect(sevenHours.isHalfDay).toBe(false);
    expect(sevenHours.halfDayDeduction).toBe(10);
    expect(sevenHours.dailyPay).toBe(70);

    // 08:00 to 17:00:00: full day (8 hours).
    const fullDay = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T17:00:00+08:00',
      graceAvailable: true,
    });
    expect(fullDay.workedHours).toBe(8);
    expect(fullDay.isHalfDay).toBe(false);
    expect(fullDay.halfDayDeduction).toBe(0);
    expect(fullDay.dailyPay).toBe(80);
  });

  it('afternoon arrival at/after 12:00 PM books half-day deduction, not late', () => {
    const noon = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T12:00:00+08:00',
      actualTimeOut: '2026-07-28T17:00:00+08:00',
      graceAvailable: false,
    });
    expect(noon.workedHours).toBe(4);
    expect(noon.isHalfDay).toBe(true);
    expect(noon.halfDayDeduction).toBe(40);
    expect(noon.lateHours).toBe(0);
    expect(noon.lateDeduction).toBe(0);
    expect(noon.dailyPay).toBe(40);
  });

  it('T6 decision A: one second past 17:00:00 is still a full day', () => {
    const justAfterFive = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T17:00:01+08:00',
      graceAvailable: true,
    });
    expect(justAfterFive.isHalfDay).toBe(false);
    expect(justAfterFive.halfDayDeduction).toBe(0);
    expect(justAfterFive.dailyPay).toBe(80);
  });

  it('clamps 09:30 to 10:00 and charges two late hours', () => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T09:30:00+08:00',
      actualTimeOut: '2026-07-28T17:10:00+08:00',
      graceAvailable: false,
    });

    expect(result).toMatchObject({ computedTimeIn: '2026-07-28T10:00:00+08:00', lateHours: 2, lateDeduction: 20, graceUsed: false });
    expect(result.dailyPay).toBe(60);
    expect(result.workedHours).toBeCloseTo(6 + 1 / 6, 8);
  });

  it('strictly counts whole hours: 08:00-12:30 pays 4 hours (₱40), matching 08:00-12:00', () => {
    const atNoon = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T12:00:00+08:00',
      graceAvailable: true,
    });
    expect(atNoon.workedHours).toBe(4);
    expect(atNoon.dailyPay).toBe(40);
    expect(atNoon.isHalfDay).toBe(true);
    expect(atNoon.halfDayDeduction).toBe(40);

    const atTwelveThirty = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T12:30:00+08:00',
      graceAvailable: true,
    });
    expect(atTwelveThirty.workedHours).toBe(4);
    expect(atTwelveThirty.dailyPay).toBe(40);
    expect(atTwelveThirty.isHalfDay).toBe(true);
    expect(atTwelveThirty.halfDayDeduction).toBe(40);
  });

  it('uses Monday as the Manila payroll week boundary', () => {
    expect(getManilaWeekStart('2026-08-02')).toBe('2026-07-27');
    expect(getManilaWeekStart('2026-08-03')).toBe('2026-08-03');
  });

  it('deducts half day pay when worked hours are 4 or fewer', () => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T12:00:00+08:00',
      graceAvailable: true,
    });
    expect(result).toMatchObject({
      workedHours: 4,
      isHalfDay: true,
      halfDayDeduction: 40,
      basePay: 80,
      dailyPay: 40,
    });
  });

  it('P4: rejects time-out earlier than time-in instead of zeroing hours', () => {
    expect(() => calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T09:00:00+08:00',
      actualTimeOut: '2026-07-28T08:00:00+08:00',
      graceAvailable: true,
    })).toThrow('earlier than time-in');
  });

  it('A2: morning half-day closed before office close pays an effective 12:00 time-out', () => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T11:30:00+08:00',
      graceAvailable: true,
    });
    expect(result.isHalfDay).toBe(true);
    expect(result.computedTimeOut).toBe('2026-07-28T12:00:00+08:00');
  });

  it('A2: afternoon arrival at/after 12:00 is not replaced with a 12:00 time-out', () => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T12:30:00+08:00',
      actualTimeOut: '2026-07-28T16:30:00+08:00',
      graceAvailable: false,
    });
    expect(result.isHalfDay).toBe(true);
    expect(result.computedTimeOut).toBe('2026-07-28T16:30:00+08:00');
  });

  it('A2: a clock-out exactly at 17:00 is not replaced with a 12:00 time-out', () => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T17:00:00+08:00',
      graceAvailable: true,
    });
    expect(result.isHalfDay).toBe(false);
    expect(result.computedTimeOut).toBe('2026-07-28T17:00:00+08:00');
  });

  it('A2: a post-18:00 clock-out caps to 17:00 before the half-day rule runs', () => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T18:30:00+08:00',
      graceAvailable: true,
    });
    expect(result.isHalfDay).toBe(false);
    expect(result.computedTimeOut).toBe('2026-07-28T17:00:00+08:00');
  });

  it('A2: the non-morning-half-day else branch returns the capped stamp unchanged', () => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T13:30:00+08:00',
      actualTimeOut: '2026-07-28T16:45:00+08:00',
      graceAvailable: false,
    });
    expect(result.isHalfDay).toBe(true);
    expect(result.computedTimeOut).toBe('2026-07-28T16:45:00+08:00');
  });

  it('A2: 17:30 stays 17:30 where the employee engine floors to 17:00', () => {
    // Locks the intentional intern/employee difference at the exact value the
    // Rust engines assert, so the two stacks cannot drift apart unnoticed.
    const result = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T17:30:00+08:00',
      graceAvailable: false,
    });
    expect(result.isHalfDay).toBe(false);
    expect(result.computedTimeOut).toBe('2026-07-28T17:30:00+08:00');
  });
});
