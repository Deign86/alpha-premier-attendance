import { describe, expect, it } from 'vitest';
import { formatDeductionDate, keepOrBuildManilaIso } from './App';

describe('keepOrBuildManilaIso', () => {
  it('keeps the exact stamp (seconds included) when the HH:MM was not edited', () => {
    expect(keepOrBuildManilaIso('2026-10-08', '09:00', '2026-10-08T09:00:30+08:00')).toBe('2026-10-08T09:00:30+08:00');
  });

  it('builds HH:MM:00 in Manila time when the admin changed the time', () => {
    expect(keepOrBuildManilaIso('2026-10-08', '08:10', '2026-10-08T09:00:30+08:00')).toBe('2026-10-08T08:10:00+08:00');
  });

  it('builds a stamp for a time that had no original', () => {
    expect(keepOrBuildManilaIso('2026-10-08', '17:00', null)).toBe('2026-10-08T17:00:00+08:00');
  });

  it('returns null when the time was cleared', () => {
    expect(keepOrBuildManilaIso('2026-10-08', '', '2026-10-08T09:00:30+08:00')).toBeNull();
  });
});

describe('formatDeductionDate', () => {
  it('does not crash on a deduction item without a date', () => {
    expect(formatDeductionDate(undefined)).toBe('—');
    expect(formatDeductionDate(null)).toBe('—');
    expect(formatDeductionDate('')).toBe('—');
  });

  it('formats a real date and passes unknown text through', () => {
    expect(formatDeductionDate('2026-10-08')).toContain('2026');
    expect(formatDeductionDate('soon')).toBe('soon');
  });
});
