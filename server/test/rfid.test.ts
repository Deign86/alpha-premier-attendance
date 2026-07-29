import { describe, expect, it } from 'vitest';
import { normalizeRfidUid } from '../src/rfid.js';

describe('normalizeRfidUid', () => {
  it('normalizes case and common separators', () => {
    expect(normalizeRfidUid(' aa-bb:cc 11 ')).toBe('AABBCC11');
  });

  it('rejects empty and non-hex values', () => {
    expect(() => normalizeRfidUid('')).toThrow();
    expect(() => normalizeRfidUid('ZZ-11')).toThrow();
  });
});
