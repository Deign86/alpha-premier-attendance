import { describe, expect, it } from 'vitest';
import { attendanceActions, attendanceStatuses, scanSources, setupErrorCodes } from './api-contracts.js';

describe('shared API contract literals', () => {
  it('keeps scan sources and attendance states stable', () => {
    expect(scanSources).toEqual(['RFID', 'MANUAL_TEST']);
    expect(attendanceActions).toEqual(['TIME_IN', 'TIME_OUT']);
    expect(attendanceStatuses).toEqual(['WORKING', 'COMPLETED', 'MISSED']);
  });

  it('exposes protected setup error codes for both workspaces', () => {
    expect(setupErrorCodes).toContain('SETUP_AUTH_REQUIRED');
    expect(setupErrorCodes).toContain('USER_CONFLICT');
  });
});
