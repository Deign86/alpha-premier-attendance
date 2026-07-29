import { describe, expect, it } from 'vitest';
import { attendanceApiProxy } from './dev-server-config';

describe('Vite development server', () => {
  it('proxies API requests to the attendance server', () => {
    expect(attendanceApiProxy).toMatchObject({ target: 'http://localhost:3001' });
  });
});
