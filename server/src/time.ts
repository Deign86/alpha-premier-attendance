import { DateTime } from 'luxon';

export function manilaDate(date: Date, timezone = 'Asia/Manila'): string {
  return DateTime.fromJSDate(date, { zone: timezone }).toFormat('yyyy-LL-dd');
}

export function manilaTimestamp(date: Date, timezone = 'Asia/Manila'): string {
  const value = DateTime.fromJSDate(date, { zone: timezone }).toISO({ suppressMilliseconds: true });
  if (!value) throw new Error('Unable to format timestamp');
  return value;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}
