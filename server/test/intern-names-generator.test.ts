import { describe, expect, it } from 'vitest';
import { leadInMsFromPcm, normalizePronunciation, runBatchInternNameGeneration } from '../../scripts/generate_existing_intern_names.js';
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

    // Employee and archived records are excluded from intern name generation.
    expect(profiles['USR_EMP_001']).toBeUndefined();
    expect(profiles['USR_INT_003']).toBeUndefined();
  });

  it('excludes legacy employee records by default', async () => {
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
      mockUsers,
    });

    expect(result.discovered).toBe(1);
    expect(result.generated).toBe(1);

    const profiles = result.manifest.profiles;
    expect(profiles['USR_INT_001']).toBeDefined();
    expect(profiles['USR_INT_001'].employeeType).toBe('INTERN');
    expect(profiles['USR_INT_001'].normalizedSpeechText).toBe('Maria Santos');

    expect(profiles['USR_EMP_001']).toBeUndefined();
    expect(profiles['USR_EMP_002']).toBeUndefined();
  });

  it('drops the hyphen from "Ar-jee" whatever its casing', () => {
    expect(normalizePronunciation('Ar-jee Felizarte')).toBe('Arjee Felizarte');
    expect(normalizePronunciation('Ar-Jee Felizarte')).toBe('Arjee Felizarte');
  });
});

describe('lead-in (breath before the first word) detection', () => {
  // 16 kHz PCM pieces: a 200 Hz tone stands in for voiced speech, seeded noise for breath/fricatives.
  const silence = (ms: number): number[] => new Array<number>(ms * 16).fill(0);
  const tone = (ms: number, amp = 20000): number[] =>
    Array.from({ length: ms * 16 }, (_, i) => Math.round(amp * Math.sin((2 * Math.PI * 200 * i) / 16000)));
  const noise = (ms: number, amp: number): number[] => {
    let seed = 12345;
    return Array.from({ length: ms * 16 }, () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return Math.round((seed / 2147483648 - 0.5) * 2 * amp);
    });
  };
  const pcm = (...parts: number[][]): Int16Array => Int16Array.from(parts.flat());

  it('measures a breath that a pause separates from the first word', () => {
    const lead = leadInMsFromPcm(pcm(silence(100), noise(200, 3000), silence(150), tone(400)));
    expect(lead).toBeGreaterThanOrEqual(180);
    expect(lead).toBeLessThanOrEqual(220);
  });

  it('measures a short voiced blip before the first word', () => {
    const lead = leadInMsFromPcm(pcm(silence(100), tone(100, 8000), silence(300), tone(400)));
    expect(lead).toBeGreaterThanOrEqual(90);
    expect(lead).toBeLessThanOrEqual(120);
  });

  it('treats a word-initial fricative and plain leading silence as clean', () => {
    expect(leadInMsFromPcm(pcm(silence(100), noise(120, 8000), tone(400)))).toBe(0);
    expect(leadInMsFromPcm(pcm(silence(150), tone(400)))).toBe(0);
    expect(leadInMsFromPcm(pcm(silence(50)))).toBe(0);
  });
});
