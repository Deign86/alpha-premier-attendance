import { DateTime } from 'luxon';

/**
 * Shared payroll clock helpers and the fixed 12:00–13:00 Manila lunch window.
 *
 * Payroll hours use the paid-work helpers below: fractional elapsed hours
 * capped at 8, with the overlapping lunch window excluded.
 *
 * The remaining exports here (`capLateTimeoutOut`, `isHalfDayWork`,
 * `effectiveHalfDayTimeOut`, `manilaTimestamp`) ARE live payroll
 * inputs and must not be removed. `officeCloseFor` and the hour constants have
 * no external consumer either; they back the helpers above.
 *
 * Overnight/multi-day spans subtract EVERY touched day's window (a 22:00 to
 * next-day 14:00 shift loses one hour per day crossed). Night shifts are
 * unsupported by design: office hours are 08:00–17:00 Asia/Manila.
 */
export const LUNCH_START_HOUR = 12;
export const LUNCH_END_HOUR = 13;
export const LUNCH_DURATION_HOURS = 1;
/** Official office close (17:00 Manila). Clock-out at exactly this instant counts a full day (T6 decision A). */
export const OFFICE_CLOSE_HOUR = 17;
/** Late time-out flag hour (18:00 Manila): overtime is forbidden, so a
 * clock-out at/after this hour is auto-capped to OFFICE_CLOSE_HOUR (17:00)
 * BEFORE DTR row building and payroll math (single normalization point).
 * 17:59:59 stays actual; 18:00:00+ caps. Mirrors shared `LATE_TIMEOUT_THRESHOLD`. */
export const LATE_TIMEOUT_HOUR = 18;
const timezone = 'Asia/Manila';

/**
 * Seconds of the lunch break that fall inside the `[start, end]` interval.
 *
 * Only the overlapping portion is subtracted, which handles:
 * - shifts spanning the whole window (09:00–17:00 → 3600 s excluded),
 * - clock-in before / clock-out after the window,
 * - clock-in or clock-out inside the window (partial overlap),
 * - overnight or multi-day spans (every touched day's window is checked).
 */
export function lunchBreakExcludedSeconds(start: DateTime, end: DateTime): number {
  let excluded = 0;
  let day = start.startOf('day');
  const lastDay = end.startOf('day');
  while (day <= lastDay) {
    const lunchStart = day.set({ hour: LUNCH_START_HOUR, minute: 0, second: 0, millisecond: 0 });
    const lunchEnd = lunchStart.plus({ hours: LUNCH_DURATION_HOURS });
    const overlapStart = start > lunchStart ? start : lunchStart;
    const overlapEnd = end < lunchEnd ? end : lunchEnd;
    if (overlapEnd > overlapStart) {
      excluded += overlapEnd.diff(overlapStart).as('seconds');
    }
    day = day.plus({ days: 1 });
  }
  return excluded;
}

/** Paid seconds between two timestamps, excluding the lunch window. */
export function paidWorkSeconds(start: DateTime, end: DateTime): number {
  const elapsed = Math.max(0, end.diff(start).as('seconds'));
  return Math.max(0, elapsed - lunchBreakExcludedSeconds(start, end));
}

/** Paid work hours as fractional hours, capped at 8, excluding lunch. */
export function paidWorkHours(start: DateTime, end: DateTime): number {
  return Math.min(8, paidWorkSeconds(start, end) / 3600);
}

/** 17:00:00 Manila on the same calendar day as the given clock-out. */
export function officeCloseFor(clockOut: DateTime): DateTime {
  return clockOut.set({ hour: OFFICE_CLOSE_HOUR, minute: 0, second: 0, millisecond: 0 });
}

/**
 * Auto-cap a clock-out at/after 18:00 Manila to 17:00 same-day (overtime
 * forbidden — avoids manual HR/IT correction). Returns the input unchanged
 * when before 18:00. Single normalization used by DTR row building
 * (`buildDtrRow`, `classifyRecordKind`) and payroll compute so both stay
 * consistent. Not a half-day override: half-day rules apply after capping.
 */
export function capLateTimeoutOut(clockOut: DateTime): DateTime {
  if (clockOut.hour >= LATE_TIMEOUT_HOUR) {
    return clockOut.set({ hour: OFFICE_CLOSE_HOUR, minute: 0, second: 0, millisecond: 0 });
  }
  return clockOut;
}
