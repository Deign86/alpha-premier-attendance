import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatCutoffRange,
  formatDate,
  formatDateTime,
  formatDayHeading,
  formatDuration,
  formatLateMinutes,
  formatMonth,
  formatShortDate,
  formatTime,
} from './format';

// 1:26 PM on Friday, Oct 30, 2026 in Manila.
const instant = '2026-10-30T05:26:00Z';

describe('shared date and time style', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats dates, times and date-times on Manila time', () => {
    expect(formatDate(instant)).toBe('Fri, Oct 30, 2026');
    expect(formatShortDate(instant)).toBe('Oct 30, 2026');
    expect(formatTime(instant)).toBe('1:26 PM');
    expect(formatDateTime(instant)).toBe('Oct 30, 2026, 1:26 PM');
    expect(formatMonth(instant)).toBe('October 2026');
    // A time late in the Manila evening is still that Manila day, not the UTC one.
    expect(formatDate('2026-10-30T23:30:00+08:00')).toBe('Fri, Oct 30, 2026');
  });

  it('reads calendar days as that day, never the day before', () => {
    expect(formatDate('2026-11-01')).toBe('Sun, Nov 1, 2026');
    expect(formatShortDate('2026-01-01')).toBe('Jan 1, 2026');
  });

  it('accepts another time zone for screens set to one', () => {
    expect(formatTime(instant, 'UTC')).toBe('5:26 AM');
  });

  it('shows anything that is not a date as it came', () => {
    expect(formatDate('soon')).toBe('soon');
    expect(formatDateTime('')).toBe('');
  });

  it('drops the year from a day heading only in the current year', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T04:00:00Z'));
    expect(formatDayHeading('2026-11-01')).toBe('Sun, Nov 1');
    expect(formatDayHeading('2025-11-01')).toBe('Sat, Nov 1, 2025');
  });

  it('formats durations in seconds, minutes and hours', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(150)).toBe('2m 30s');
    expect(formatDuration(19_320)).toBe('5h 22m');
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(-5)).toBe('0s');
  });

  it('formats minutes late with hours and two-digit minutes', () => {
    expect(formatLateMinutes(13)).toBe('13m');
    expect(formatLateMinutes(65)).toBe('1h 05m');
    expect(formatLateMinutes(322)).toBe('5h 22m');
    expect(formatLateMinutes(60)).toBe('1h 00m');
    expect(formatLateMinutes(-3)).toBe('0m');
  });

  it('formats cutoff ranges with an en dash', () => {
    expect(formatCutoffRange('2026-10-16', '2026-10-31')).toBe('Oct 16–31, 2026');
    expect(formatCutoffRange('2026-10-16', '2026-11-15')).toBe('Oct 16 – Nov 15, 2026');
    expect(formatCutoffRange('2026-12-16', '2027-01-15')).toBe('Dec 16, 2026 – Jan 15, 2027');
    expect(formatCutoffRange('2026-10-16', '2026-10-16')).toBe('Oct 16, 2026');
    expect(formatCutoffRange('', '2026-10-31')).toBe(' – 2026-10-31');
  });
});
