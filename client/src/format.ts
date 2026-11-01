import { ATTENDANCE_TIMEZONE } from "@rfid-attendance/shared";

/**
 * One date and time style for everything shown on screen, always on office (Manila) time:
 * "Fri, Oct 30, 2026", "Oct 30, 2026", "1:26 PM", "Oct 30, 2026, 1:26 PM", "2m 30s", "Oct 16–31, 2026".
 * Display only: values sent to the server, CSV files and date inputs keep their own formats.
 */

/** A calendar day ("2026-10-30") or an instant (ISO timestamp or Date). */
type DateInput = string | Date;

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Calendar days are read as noon in Manila so they never slip to the day before or after. */
function toDate(value: DateInput): Date | null {
  const date = value instanceof Date ? value : new Date(CALENDAR_DAY.test(value) ? `${value}T12:00:00+08:00` : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Formats a valid value; anything that can't be read as a date is shown as it came. */
function format(value: DateInput, options: Intl.DateTimeFormatOptions, timeZone: string): string {
  const date = toDate(value);
  if (!date) return value instanceof Date ? "" : value;
  // Some browsers put a narrow no-break space before AM/PM; a plain space keeps one look everywhere.
  return new Intl.DateTimeFormat("en-PH", { timeZone, ...options }).format(date).replace(/ /g, " ");
}

/** "Fri, Oct 30, 2026" */
export function formatDate(value: DateInput, timeZone = ATTENDANCE_TIMEZONE): string {
  return format(value, { weekday: "short", month: "short", day: "numeric", year: "numeric" }, timeZone);
}

/** "Oct 30, 2026" */
export function formatShortDate(value: DateInput, timeZone = ATTENDANCE_TIMEZONE): string {
  return format(value, { month: "short", day: "numeric", year: "numeric" }, timeZone);
}

/** "Sun, Nov 1": a day heading; the year is added only when it isn't this year. */
export function formatDayHeading(value: DateInput, timeZone = ATTENDANCE_TIMEZONE): string {
  const sameYear = format(value, { year: "numeric" }, timeZone) === format(new Date(), { year: "numeric" }, timeZone);
  return sameYear ? format(value, { weekday: "short", month: "short", day: "numeric" }, timeZone) : formatDate(value, timeZone);
}

/** "October 2026" */
export function formatMonth(value: DateInput, timeZone = ATTENDANCE_TIMEZONE): string {
  return format(value, { month: "long", year: "numeric" }, timeZone);
}

/** "1:26 PM" */
export function formatTime(value: DateInput, timeZone = ATTENDANCE_TIMEZONE): string {
  return format(value, { hour: "numeric", minute: "2-digit", hour12: true }, timeZone);
}

/** "Oct 30, 2026, 1:26 PM" */
export function formatDateTime(value: DateInput, timeZone = ATTENDANCE_TIMEZONE): string {
  return format(value, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }, timeZone);
}

/** "45s", "2m 30s", "5h 22m" */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/** Minutes late: "13m", "1h 05m", "5h 22m". */
export function formatLateMinutes(totalMinutes: number): string {
  const minutes = Math.max(0, Math.floor(totalMinutes));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
}

/**
 * A payroll cutoff between two calendar days: "Oct 16–31, 2026", "Oct 16 – Nov 15, 2026" across months and
 * "Dec 16, 2026 – Jan 15, 2027" across years. Falls back to "start – end" when either day can't be read.
 */
export function formatCutoffRange(start: string, end: string): string {
  const day = (value: string) => (CALENDAR_DAY.test(value) ? value.split("-").map(Number) : null);
  const from = day(start);
  const to = day(end);
  if (!from || !to || !MONTHS[from[1] - 1] || !MONTHS[to[1] - 1]) return `${start} – ${end}`;
  const [fromYear, fromMonth, fromDay] = from;
  const [toYear, toMonth, toDay] = to;
  if (fromYear !== toYear) return `${MONTHS[fromMonth - 1]} ${fromDay}, ${fromYear} – ${MONTHS[toMonth - 1]} ${toDay}, ${toYear}`;
  if (fromMonth !== toMonth) return `${MONTHS[fromMonth - 1]} ${fromDay} – ${MONTHS[toMonth - 1]} ${toDay}, ${toYear}`;
  if (fromDay === toDay) return `${MONTHS[fromMonth - 1]} ${fromDay}, ${fromYear}`;
  return `${MONTHS[fromMonth - 1]} ${fromDay}–${toDay}, ${fromYear}`;
}
