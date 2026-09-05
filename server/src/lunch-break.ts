import { DateTime } from 'luxon';

/**
 * Fixed unpaid lunch break applied to every paid-hours calculation in the
 * server payroll layer.
 *
 * Work performed between 12:00 and 13:00 Manila time is never counted as
 * payable time — for employees and interns alike. The window is centralized
 * here so every consumer (daily payroll, worked-hours reporting) stays
 * consistent and the rule can be audited or changed in one place. The desktop
 * app mirrors this in `src-tauri/src/services/lunch_break.rs`.
 *
 * Overnight/multi-day spans subtract EVERY touched day's window (a 22:00 to
 * next-day 14:00 shift loses one hour per day crossed). Night shifts are
 * unsupported by design: office hours are 08:00–17:00 Asia/Manila.
 */
export const LUNCH_START_HOUR = 12;
export const LUNCH_END_HOUR = 13;
export const LUNCH_DURATION_HOURS = 1;
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

/** Paid work hours (fractional, e.g. 7.5) between two timestamps, excluding lunch. */
export function paidWorkHours(start: DateTime, end: DateTime): number {
  return paidWorkSeconds(start, end) / 3600;
}

/**
 * Paid work hours rounded up to the next whole hour, excluding lunch.
 *
 * Mirrors the existing payroll convention of ceiling fractional hours so a
 * 07:30–16:30 shift (8.0 paid hours after the lunch cut) still reports 8
 * hours, never 9.
 */
export function paidWorkHoursCeiled(start: DateTime, end: DateTime): number {
  return Math.ceil(paidWorkSeconds(start, end) / 3600);
}

/** Parses an ISO timestamp into Manila time, throwing on invalid input. */
export function manilaTimestamp(value: string): DateTime {
  // P6: require an explicit UTC offset (RFC3339) — offset-less local times
  // are silently misread when client and server zones disagree.
  const text = value.trim();
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(text)) throw new Error('Payroll timestamps must include a UTC offset (RFC3339)');
  const parsed = DateTime.fromISO(text, { setZone: true }).setZone(timezone);
  if (!parsed.isValid) throw new Error('Payroll timestamps must be valid ISO values');
  return parsed;
}
