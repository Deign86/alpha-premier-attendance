import { describe, expect, it } from 'vitest';
import { resolveApiBaseUrl } from './network';

describe('browser endpoint resolution', () => {
  it('uses the current browser origin by default', () => {
    expect(resolveApiBaseUrl('http://192.168.1.25:5173')).toBe('http://192.168.1.25:5173');
  });

  it('uses the explicit API override when supplied', () => {
    expect(resolveApiBaseUrl('http://192.168.1.25:5173', 'https://attendance.example.test/api')).toBe('https://attendance.example.test/api');
  });
});
