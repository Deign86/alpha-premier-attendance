import { describe, expect, it } from 'vitest';
import { manilaDate, manilaTimestamp } from '../src/time.js';

describe('Manila time helpers', () => {
  it('returns the Manila calendar date and offset timestamp', () => {
    const instant = new Date('2026-07-28T16:01:15.000Z');
    expect(manilaDate(instant)).toBe('2026-07-29');
    expect(manilaTimestamp(instant)).toBe('2026-07-29T00:01:15+08:00');
  });
});
