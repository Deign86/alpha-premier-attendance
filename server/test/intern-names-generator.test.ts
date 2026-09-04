import { describe, expect, it } from 'vitest';
import { runBatchInternNameGeneration } from '../../scripts/generate_existing_intern_names.js';
import type { SheetUser } from '../src/sheets.js';

describe('batch intern name voice generation', () => {
  it('discovers active interns, normalizes names, and builds a valid manifest in dry-run mode', async () => {
    const mockUsers: SheetUser[] = [
      {
        userId: 'USR_INT_001',
        fullName: 'maria clara santos',
        rfidUid: 'CARD001',
        department: 'IT',
        status: 'ACTIVE',
        employeeType: 'INTERN',
        createdAt: '2026-08-01',
      },
      {
        userId: 'USR_INT_002',
        fullName: 'JUAN DELA CRUZ',
        rfidUid: 'CARD002',
        department: 'Marketing',
        status: 'ACTIVE',
        employeeType: 'INTERN',
        createdAt: '2026-08-01',
      },
      {
        userId: 'USR_EMP_001',
        fullName: 'Ada Lovelace',
        rfidUid: 'CARD003',
        department: 'Engineering',
        status: 'ACTIVE',
        employeeType: 'EMPLOYEE',
        createdAt: '2026-08-01',
      },
      {
        userId: 'USR_INT_003',
        fullName: 'Inactive Intern',
        rfidUid: 'CARD004',
        department: 'Finance',
        status: 'ARCHIVED',
        employeeType: 'INTERN',
        createdAt: '2026-08-01',
      },
    ];

    const result = await runBatchInternNameGeneration({
      dryRun: true,
      internsOnly: true,
      mockUsers,
    });

    expect(result.discovered).toBe(2);
    expect(result.generated).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);

    const profiles = result.manifest.profiles;
    expect(profiles['USR_INT_001']).toBeDefined();
    expect(profiles['USR_INT_001'].normalizedSpeechText).toBe('Maria Clara Santos');
    expect(profiles['USR_INT_001'].employeeType).toBe('INTERN');
    expect(profiles['USR_INT_001'].audioFile).toBe('/voices/bea/names/USR_INT_001.mp3');

    expect(profiles['USR_INT_002']).toBeDefined();
    expect(profiles['USR_INT_002'].normalizedSpeechText).toBe('Juan Dela Cruz');

    // Should NOT include regular employee or archived intern when internsOnly is set
    expect(profiles['USR_EMP_001']).toBeUndefined();
    expect(profiles['USR_INT_003']).toBeUndefined();
  });

  it('discovers BOTH active interns and regular employees by default', async () => {
    const mockUsers: SheetUser[] = [
      {
        userId: 'USR_INT_001',
        fullName: 'Maria Santos',
        rfidUid: 'CARD001',
        department: 'IT',
        status: 'ACTIVE',
        employeeType: 'INTERN',
        createdAt: '2026-08-01',
      },
      {
        userId: 'USR_EMP_001',
        fullName: 'Ada Lovelace',
        rfidUid: 'CARD002',
        department: 'Engineering',
        status: 'ACTIVE',
        employeeType: 'EMPLOYEE',
        createdAt: '2026-08-01',
      },
      {
        userId: 'USR_EMP_002',
        fullName: 'Alan Turing',
        rfidUid: 'CARD003',
        department: 'Research',
        status: 'ARCHIVED',
        employeeType: 'EMPLOYEE',
        createdAt: '2026-08-01',
      },
    ];

    const result = await runBatchInternNameGeneration({
      dryRun: true,
      internsOnly: false,
      mockUsers,
    });

    // 2 active users (1 intern + 1 employee, excluding archived)
    expect(result.discovered).toBe(2);
    expect(result.generated).toBe(2);

    const profiles = result.manifest.profiles;
    expect(profiles['USR_INT_001']).toBeDefined();
    expect(profiles['USR_INT_001'].employeeType).toBe('INTERN');
    expect(profiles['USR_INT_001'].normalizedSpeechText).toBe('Maria Santos');

    expect(profiles['USR_EMP_001']).toBeDefined();
    expect(profiles['USR_EMP_001'].employeeType).toBe('EMPLOYEE');
    expect(profiles['USR_EMP_001'].normalizedSpeechText).toBe('Ada Lovelace');

    expect(profiles['USR_EMP_002']).toBeUndefined();
  });
});
