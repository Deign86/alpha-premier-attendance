import { describe, expect, it } from 'vitest';
import {
  buildDtrRow,
  buildFormatRequests,
  classifyRecordKind,
  dtrTokens,
  DTR_TEMPLATE_SHEET_ID,
  ensurePersonTab,
  findDateRow,
  findDateRowIn,
  formatSheetTime,
  hasTabOverlap,
  isDuplicateNameError,
  isShortStint,
  isValidTabName,
  monthBlockRange,
  normalizeDtrToken,
  parseMonthHeader,
  parseSheetDate,
  pickTemplateSheet,
  planAbsentSweep,
  planPush,
  executePush,
  planRowFormat,
  dtrStaleReason,
  sheetTimeSecs,
  resolveUserTab,
  userLastToken,
  type AttendanceDay,
  type DtrSyncUser,
  type FormatRequest,
  type SheetsClient,
} from '../src/intern-dtr-sync.js';

const ROSTER: DtrSyncUser[] = [
  { userId: 'APG-2026-108', fullName: 'Raineer C. Rosado' },
  { userId: 'APG-2026-102', fullName: 'Deign Grey O. Lazaro' },
  { userId: 'APG-2026-111', fullName: 'Ma. Ellaine Zapico' },
  { userId: 'APG-2026-112', fullName: 'John Frederick Ruiz' },
  { userId: 'APG-2026-104', fullName: 'Kizziah Ishi De Guerto' },
];

const TABS = [
  'COPY OF TEMPLATE',
  'ROSADO RAINEER',
  'LAZARO DEIGN ',
  'ELLAINE ',
  'RUIZ FREDERIK',
  'DE GUERTO ISHI ',
];

function makeClient(valuesByTab: Record<string, string[][]>): SheetsClient & { writes: { tab: string; row: number; values: string[] }[]; paints: FormatRequest[]; created: string[] } {
  const writes: { tab: string; row: number; values: string[] }[] = [];
  const paints: FormatRequest[] = [];
  const created: string[] = [];
  return {
    writes,
    paints,
    created,
    async getTabTitles(): Promise<string[]> {
      return Object.keys(valuesByTab);
    },
    async getTabMeta(): Promise<{ title: string; sheetId: number }[]> {
      return Object.keys(valuesByTab).map((title, i) => ({ title, sheetId: 100 + i }));
    },
    async getTabValues(tab: string): Promise<string[][]> {
      return valuesByTab[tab] ?? [];
    },
    async updateRow(tab: string, row1Based: number, values: string[]): Promise<void> {
      writes.push({ tab, row: row1Based, values });
    },
    async applyFormats(requests: FormatRequest[]): Promise<void> {
      paints.push(...requests);
    },
    async duplicateTemplate(
      _sourceSheetId: number,
      newTitle: string,
    ): Promise<{ title: string; sheetId: number } | null> {
      if (newTitle in valuesByTab) return null;
      created.push(newTitle);
      valuesByTab[newTitle] = [
        ['DATE-September', 'TIME IN MORNING', 'OUT LUNCH', 'TIME IN AFTERNOON', 'TIME OUT', 'TOTAL HOURS'],
        ['9/5/2026', '', '', '', '', '0'],
      ];
      return { title: newTitle, sheetId: 900 };
    },
  };
}

const DAY: AttendanceDay = {
  userId: 'APG-2026-108',
  fullName: 'Raineer C. Rosado',
  attendanceDate: '2026-09-05',
  timeIn: '2026-09-05T07:24:00+08:00',
  timeOut: '2026-09-05T17:00:00+08:00',
  status: 'COMPLETED',
};

describe('normalizeDtrToken', () => {
  it('strips hyphens/dots and lowercases', () => {
    expect(normalizeDtrToken('Ar-jee')).toBe('arjee');
    expect(normalizeDtrToken('Ma.')).toBe('ma');
    expect(normalizeDtrToken('C.')).toBe('c');
  });
  it('folds diacritics to ASCII on both sides', () => {
    expect(normalizeDtrToken('Peña')).toBe('pena');
    expect(normalizeDtrToken('José')).toBe('jose');
    expect(dtrTokens('María Peña')).toEqual(['maria', 'pena']);
  });
  it('folded spelling still fails closed (FREDERIK vs Frederick)', () => {
    expect(normalizeDtrToken('FREDERIK')).not.toBe(normalizeDtrToken('Frederick'));
  });
  it('tokenizes multi-word surnames', () => {
    expect(dtrTokens('DE GUERTO ISHI ')).toEqual(['de', 'guerto', 'ishi']);
    expect(userLastToken('Raineer C. Rosado')).toBe('rosado');
  });
  it('strips generational suffixes for the last token', () => {
    expect(userLastToken('Juan Dela Cruz Jr')).toBe('cruz');
    expect(
      resolveUserTab(
        ['DELA CRUZ'],
        { userId: 'J', fullName: 'Juan Dela Cruz Jr' },
        [{ userId: 'J', fullName: 'Juan Dela Cruz Jr' }],
      ),
    ).toEqual({ status: 'MATCH', tab: 'DELA CRUZ' });
  });
});

describe('resolveUserTab', () => {
  it('LAST FIRST pair with middle initial', () => {
    expect(resolveUserTab(TABS, ROSTER[0], ROSTER)).toEqual({ status: 'MATCH', tab: 'ROSADO RAINEER' });
  });
  it('LAST FIRST pair with middle names + trailing space', () => {
    expect(resolveUserTab(TABS, ROSTER[1], ROSTER)).toEqual({ status: 'MATCH', tab: 'LAZARO DEIGN ' });
  });
  it('single middle-name token', () => {
    expect(resolveUserTab(TABS, ROSTER[2], ROSTER)).toEqual({ status: 'MATCH', tab: 'ELLAINE ' });
  });
  it('multi-word surname LASTS FIRST(middle)', () => {
    expect(resolveUserTab(TABS, ROSTER[4], ROSTER)).toEqual({ status: 'MATCH', tab: 'DE GUERTO ISHI ' });
  });
  it('name variant fails closed (FREDERIK vs Frederick)', () => {
    expect(resolveUserTab(TABS, ROSTER[3], ROSTER)).toEqual({ status: 'NO_MATCH', tab: null });
  });
  it('correctly spelled LAST FIRST matches (rename target RUIZ FREDERICK)', () => {
    const tabs = [...TABS.filter((t) => t !== 'RUIZ FREDERIK'), 'RUIZ FREDERICK'];
    expect(resolveUserTab(tabs, ROSTER[3], ROSTER)).toEqual({ status: 'MATCH', tab: 'RUIZ FREDERICK' });
  });
  it('ambiguous when two users share coverage', () => {
    const users: DtrSyncUser[] = [
      { userId: 'A', fullName: 'Ellaine Reyes' },
      { userId: 'B', fullName: 'Ellaine Zapico' },
    ];
    // 'ELLAINE ' sits in both token sets → AMBIGUOUS, never first-hit-wins.
    expect(resolveUserTab(['ELLAINE '], users[0], users).status).toBe('AMBIGUOUS');
    // Shared surname tab covering both → AMBIGUOUS.
    const users2: DtrSyncUser[] = [
      { userId: 'A', fullName: 'Juan Dela Cruz' },
      { userId: 'B', fullName: 'Maria Dela Cruz' },
    ];
    expect(resolveUserTab(['DELA CRUZ'], users2[0], users2)).toEqual({ status: 'AMBIGUOUS', tab: null });
  });
  it('SKIP blank user', () => {
    expect(resolveUserTab(TABS, { userId: 'X', fullName: '   ' }, ROSTER)).toEqual({ status: 'SKIP', tab: null });
  });
});

describe('parseMonthHeader', () => {
  it('parses block headers', () => {
    expect(parseMonthHeader('JUNE')).toBe(6);
    expect(parseMonthHeader('DATE-September')).toBe(9);
    expect(parseMonthHeader('DATE-October')).toBe(10);
    expect(parseMonthHeader('TOTAL HOURS')).toBeNull();
    expect(parseMonthHeader('9/5/2026')).toBeNull();
  });
});

describe('monthBlockRange', () => {
  const rows = [
    ['JUNE'], ['6/30/2026'], ['TOTAL HOURS'], ['DATE-September'],
    ['9/4/2026'], ['TOTAL HOURS'], ['DATE-October'], ['9/4/2026'], ['TOTAL HOURS'],
  ];
  it('scopes September between headers', () => {
    expect(monthBlockRange(rows, 9)).toEqual({ start: 4, end: 6 });
  });
  it('returns null for a month with no block', () => {
    expect(monthBlockRange(rows, 11)).toBeNull();
  });
  it('returns no-headers sentinel without headers', () => {
    expect(monthBlockRange([['9/4/2026']], 9)).toBe('no-headers');
  });
  it('scoped search ignores the same date in another block', () => {
    const range = monthBlockRange(rows, 9);
    if (range === null || range === 'no-headers') throw new Error('expected range');
    expect(findDateRowIn(rows, '2026-09-04', range.start, range.end)).toBe(4);
  });
});

describe('parseSheetDate', () => {
  it('parses M/D/YYYY and ISO', () => {
    expect(parseSheetDate('9/5/2026')).toEqual({ y: 2026, m: 9, d: 5 });
    expect(parseSheetDate(' 2026-09-05 ')).toEqual({ y: 2026, m: 9, d: 5 });
  });
  it('rejects headers and totals', () => {
    expect(parseSheetDate('DATE-September')).toBeNull();
    expect(parseSheetDate('TOTAL HOURS')).toBeNull();
    expect(parseSheetDate('')).toBeNull();
  });
});

describe('findDateRow', () => {
  const rows = [
    ['DATE-September', 'TIME IN MORNING', 'OUT LUNCH', 'TIME IN AFTERNOON', 'TIME OUT', 'TOTAL HOURS'],
    ['9/4/2026', '', '', '', '', '0'],
    ['9/5/2026', '', '', '', '', '0'],
    ['TOTAL HOURS', '0'],
  ];
  it('finds exact row 0-based', () => {
    expect(findDateRow(rows, '2026-09-05')).toBe(2);
  });
  it('returns -1 when missing', () => {
    expect(findDateRow(rows, '2026-09-06')).toBe(-1);
  });
  it('throws on duplicates', () => {
    const dup = [...rows, ['9/5/2026', '', '', '', '', '0']];
    expect(() => findDateRow(dup, '2026-09-05')).toThrow(/duplicate date rows/);
  });
});

describe('formatSheetTime', () => {
  it('formats morning and afternoon', () => {
    expect(formatSheetTime('2026-09-05T07:24:00+08:00')).toBe('7:24:00 AM');
    expect(formatSheetTime('2026-09-05T17:00:00+08:00')).toBe('5:00:00 PM');
    expect(formatSheetTime('2026-09-05T12:00:00+08:00')).toBe('12:00:00 PM');
  });
  it('rejects invalid', () => {
    expect(() => formatSheetTime('not-a-time')).toThrow(/invalid Manila timestamp/);
  });
});

describe('buildDtrRow', () => {
  const date = '2026-09-05';
  it('completed day keeps actual stamps with no fixed lunch', () => {
    expect(buildDtrRow('2026-09-05T07:24:00+08:00', '2026-09-05T17:00:00+08:00', date)).toEqual([
      '7:24:00 AM',
      '',
      '',
      '5:00:00 PM',
    ]);
  });
  it('in-only leaves C:D:E empty (no fabricated lunch)', () => {
    expect(buildDtrRow('2026-09-05T07:24:00+08:00', null, date)).toEqual([
      '7:24:00 AM',
      '',
      '',
      '',
    ]);
  });
  it('no time-in is all empty', () => {
    expect(buildDtrRow(null, null, date)).toEqual(['', '', '', '']);
  });
  it('half-day timeout keeps actual stamps (no tap-out discard)', () => {
    expect(buildDtrRow('2026-09-05T08:04:00+08:00', '2026-09-05T15:00:00+08:00', date)).toEqual([
      '8:04:00 AM',
      '',
      '',
      '3:00:00 PM',
    ]);
  });
  it('sub-4h lunch-spanning stint keeps actuals at both ends (never half-day)', () => {
    expect(buildDtrRow('2026-09-05T11:30:00+08:00', '2026-09-05T14:30:00+08:00', date)).toEqual([
      '11:30:00 AM',
      '',
      '',
      '2:30:00 PM',
    ]);
    expect(classifyRecordKind('2026-09-05T11:30:00+08:00', '2026-09-05T14:30:00+08:00', date)).toBe(
      'lunch-span-fragment',
    );
    expect(planRowFormat('T', 107, 'lunch-span-fragment')).toEqual([
      { tab: 'T', row1Based: 107, endRow1BasedExcl: 108, startCol0: 1, endCol0Excl: 2, red: false },
      { tab: 'T', row1Based: 107, endRow1BasedExcl: 108, startCol0: 2, endCol0Excl: 4, red: true },
      { tab: 'T', row1Based: 107, endRow1BasedExcl: 108, startCol0: 4, endCol0Excl: 5, red: false },
    ]);
  });
  it('4h+ morning span closing early keeps actual stamps (payroll-only half-day)', () => {
    expect(buildDtrRow('2026-09-05T08:00:00+08:00', '2026-09-05T15:00:00+08:00', date)).toEqual([
      '8:00:00 AM',
      '',
      '',
      '3:00:00 PM',
    ]);
    expect(isShortStint('2026-09-05T08:00:00+08:00', '2026-09-05T15:00:00+08:00')).toBe(false);
    expect(isShortStint('2026-09-05T11:30:00+08:00', '2026-09-05T14:30:00+08:00')).toBe(true);
  });
  it('cutoff boundary keeps actual stamps on both sides of 16:59', () => {
    const early = buildDtrRow('2026-09-05T08:00:00+08:00', '2026-09-05T16:58:59+08:00', date);
    expect(early).toEqual(['8:00:00 AM', '', '', '4:58:59 PM']);
    expect(buildDtrRow('2026-09-05T08:00:00+08:00', '2026-09-05T16:59:00+08:00', date)).toEqual([
      '8:00:00 AM',
      '',
      '',
      '4:59:00 PM',
    ]);
  });
  it('afternoon arrival keeps actual stamps in the afternoon pair', () => {
    expect(buildDtrRow('2026-09-05T12:00:00+08:00', '2026-09-05T17:00:00+08:00', date)).toEqual([
      '',
      '',
      '12:00:00 PM',
      '5:00:00 PM',
    ]);
    expect(buildDtrRow('2026-09-05T12:30:00+08:00', '2026-09-05T17:00:00+08:00', date)).toEqual([
      '',
      '',
      '12:30:00 PM',
      '5:00:00 PM',
    ]);
  });

  it('working-to-half-day rewrite changes the row (skip-identical fires)', () => {
    const working = buildDtrRow('2026-09-05T08:00:00+08:00', null, date);
    const half = buildDtrRow('2026-09-05T08:00:00+08:00', '2026-09-05T12:30:00+08:00', date);
    expect(working).not.toEqual(half);
    expect(half).toEqual(['8:00:00 AM', '12:30:00 PM', '', '']);
  });
  it('rejects inverted timestamps (time-out before time-in)', () => {
    expect(() =>
      buildDtrRow('2026-09-05T09:00:00+08:00', '2026-09-05T08:00:00+08:00', date),
    ).toThrow('earlier than time-in');
  });
});

describe('planPush', () => {
  const baseRows = [
    ['DATE-September', 'TIME IN MORNING', 'OUT LUNCH', 'TIME IN AFTERNOON', 'TIME OUT', 'TOTAL HOURS'],
    ['9/5/2026', '', '', '', '', '0'],
  ];
  it('plans a B:E write at the right 1-based row', async () => {
    const client = makeClient({ 'ROSADO RAINEER': baseRows });
    const plan = await planPush(client, DAY, ROSTER);
    expect(plan.skipped).toBe(false);
    expect(plan.tab).toBe('ROSADO RAINEER');
    expect(plan.row1Based).toBe(2);
    expect(plan.values).toEqual(['7:24:00 AM', '', '', '5:00:00 PM']);
    await executePush(client, plan);
    expect(client.writes).toEqual([{ tab: 'ROSADO RAINEER', row: 2, values: ['7:24:00 AM', '', '', '5:00:00 PM'] }]);
  });
  it('skips identical cells without writing', async () => {
    const synced = [
      baseRows[0],
      ['9/5/2026', '7:24:00 AM', '', '', '5:00:00 PM', '8'],
    ];
    const client = makeClient({ 'ROSADO RAINEER': synced });
    const plan = await planPush(client, DAY, ROSTER);
    expect(plan.skipped).toBe(true);
    expect(plan.reason).toBe('already in sync');
    // P1-B contract: in-sync plans still carry tab+row so the CLI paint
    // pass can white/clear them (Rust InSync branch parity).
    expect(plan.tab).toBe('ROSADO RAINEER');
    expect(plan.row1Based).toBe(2);
    await executePush(client, plan);
    expect(client.writes).toEqual([]);
  });
  it('skips NO_MATCH tabs with reason', async () => {
    const client = makeClient({ 'RUIZ FREDERIK': baseRows });
    const ruiz: AttendanceDay = { ...DAY, userId: 'APG-2026-112', fullName: 'John Frederick Ruiz' };
    const plan = await planPush(client, ruiz, ROSTER);
    expect(plan.skipped).toBe(true);
    expect(plan.reason).toMatch(/NO_MATCH/);
  });
  it('skips missing date rows with reason', async () => {
    const client = makeClient({ 'ROSADO RAINEER': [baseRows[0]] });
    const plan = await planPush(client, DAY, ROSTER);
    expect(plan.skipped).toBe(true);
    expect(plan.reason).toMatch(/not found/);
  });
  it('throws on duplicate date rows (fail closed)', async () => {
    const client = makeClient({ 'ROSADO RAINEER': [...baseRows, ['9/5/2026', '', '', '', '', '0']] });
    await expect(planPush(client, DAY, ROSTER)).rejects.toThrow(/duplicate date rows/);
  });
  it('stale-skips a local working record over a completed sheet row', async () => {
    const completed = [
      baseRows[0],
      ['9/5/2026', '7:24:00 AM', '', '', '5:00:00 PM', '8'],
    ];
    const client = makeClient({ 'ROSADO RAINEER': completed });
    const working: AttendanceDay = { ...DAY, timeOut: null };
    const plan = await planPush(client, working, ROSTER);
    expect(plan.skipped).toBe(true);
    expect(plan.reason).toMatch(/stale skip/);
    await executePush(client, plan);
    expect(client.writes).toEqual([]);
  });
  it('stale-skips an older local clock-out over a newer sheet clock-out', async () => {
    const completed = [
      baseRows[0],
      ['9/5/2026', '7:24:00 AM', '', '', '5:00:00 PM', '8'],
    ];
    const client = makeClient({ 'ROSADO RAINEER': completed });
    const older: AttendanceDay = { ...DAY, timeOut: '2026-09-05T16:00:00+08:00' };
    const plan = await planPush(client, older, ROSTER);
    expect(plan.skipped).toBe(true);
    expect(plan.reason).toMatch(/stale skip/);
    expect(client.writes).toEqual([]);
  });
  it('writes a newer local clock-out over an older sheet row', async () => {
    const older = [
      baseRows[0],
      ['9/5/2026', '7:24:00 AM', '', '', '4:00:00 PM', '8'],
    ];
    const client = makeClient({ 'ROSADO RAINEER': older });
    const plan = await planPush(client, DAY, ROSTER);
    expect(plan.skipped).toBe(false);
  });
});

describe('sheetTimeSecs', () => {
  it('parses sheet wall-clock cells', () => {
    expect(sheetTimeSecs('9:46:23 AM')).toBe(9 * 3600 + 46 * 60 + 23);
    expect(sheetTimeSecs('12:00:00 PM')).toBe(12 * 3600);
    expect(sheetTimeSecs('12:00:00 AM')).toBe(0);
    expect(sheetTimeSecs('5:00:00 PM')).toBe(17 * 3600);
    expect(sheetTimeSecs('')).toBeNull();
    expect(sheetTimeSecs('TOTAL HOURS')).toBeNull();
    expect(sheetTimeSecs('13:00:00 PM')).toBeNull();
  });
  it('rates staleness timestamp-wins', () => {
    expect(dtrStaleReason(['8:00:00 AM', '', '', '5:00:00 PM'], ['8:00:00 AM', '', '', ''])).not.toBeNull();
    expect(dtrStaleReason(['8:00:00 AM', '', '', '5:00:00 PM'], ['8:00:00 AM', '', '', '4:00:00 PM'])).not.toBeNull();
    expect(dtrStaleReason(['8:00:00 AM', '', '', '4:00:00 PM'], ['8:00:00 AM', '', '', '5:00:00 PM'])).toBeNull();
    expect(dtrStaleReason(['', '', '', ''], ['8:00:00 AM', '', '', '5:00:00 PM'])).toBeNull();
  });
});

describe('red paint planner', () => {
  it('classifies records like the display rule', () => {
    expect(classifyRecordKind('2026-09-05T08:00:00+08:00', null, '2026-09-05')).toBe('working');
    expect(classifyRecordKind('2026-09-05T08:00:00+08:00', '2026-09-05T11:10:00+08:00', '2026-09-05')).toBe('morning-fragment');
    expect(classifyRecordKind('2026-09-05T08:00:00+08:00', '2026-09-05T12:30:00+08:00', '2026-09-05')).toBe('morning-fragment');
    expect(classifyRecordKind('2026-09-05T08:00:00+08:00', '2026-09-05T15:00:00+08:00', '2026-09-05')).toBe('half');
    expect(classifyRecordKind('2026-09-05T14:00:00+08:00', '2026-09-05T16:00:00+08:00', '2026-09-05')).toBe('afternoon-fragment');
    expect(classifyRecordKind('2026-09-05T08:00:00+08:00', '2026-09-05T17:00:00+08:00', '2026-09-05')).toBe('full');
    expect(classifyRecordKind('2026-09-05T12:00:00+08:00', '2026-09-05T17:00:00+08:00', '2026-09-05')).toBe('half-pm');
    expect(classifyRecordKind(null, null, '2026-09-05')).toBe('absent');
  });
  it('fragment rows render actual stamps + paint like their half-day shape', () => {
    expect(buildDtrRow('2026-09-05T11:06:00+08:00', '2026-09-05T11:10:00+08:00', '2026-09-05')).toEqual([
      '11:06:00 AM',
      '11:10:00 AM',
      '',
      '',
    ]);
    expect(buildDtrRow('2026-09-05T14:00:00+08:00', '2026-09-05T16:00:00+08:00', '2026-09-05')).toEqual([
      '',
      '',
      '2:00:00 PM',
      '4:00:00 PM',
    ]);
    expect(planRowFormat('T', 107, 'morning-fragment')).toEqual(planRowFormat('T', 107, 'half'));
    expect(planRowFormat('T', 107, 'afternoon-fragment')).toEqual(planRowFormat('T', 107, 'half-pm'));
  });
  it('absent paints B:E red; half whites morning + reds remainder', () => {
    expect(planRowFormat('T', 107, 'absent')).toEqual([
      { tab: 'T', row1Based: 107, endRow1BasedExcl: 108, startCol0: 1, endCol0Excl: 5, red: true },
    ]);
    expect(planRowFormat('T', 107, 'half')).toEqual([
      { tab: 'T', row1Based: 107, endRow1BasedExcl: 108, startCol0: 1, endCol0Excl: 3, red: false },
      { tab: 'T', row1Based: 107, endRow1BasedExcl: 108, startCol0: 3, endCol0Excl: 5, red: true },
    ]);
  });
  it('half-pm reds the empty morning + whites the afternoon', () => {
    expect(planRowFormat('T', 107, 'half-pm')).toEqual([
      { tab: 'T', row1Based: 107, endRow1BasedExcl: 108, startCol0: 1, endCol0Excl: 3, red: true },
      { tab: 'T', row1Based: 107, endRow1BasedExcl: 108, startCol0: 3, endCol0Excl: 5, red: false },
    ]);
  });
  it('full whites everything; working leaves E untouched', () => {
    expect(planRowFormat('T', 107, 'full')).toEqual([
      { tab: 'T', row1Based: 107, endRow1BasedExcl: 108, startCol0: 1, endCol0Excl: 5, red: false },
    ]);
    expect(planRowFormat('T', 107, 'working')).toEqual([
      { tab: 'T', row1Based: 107, endRow1BasedExcl: 108, startCol0: 1, endCol0Excl: 4, red: false },
    ]);
  });
  it('absent sweep paints only past weekdays, merged', () => {
    // 2026-09-05 is a Saturday: 9/1 Tue + 9/3 Wed + 9/4 Thu empty → red;
    // 9/2 has values, 9/5 today, 9/6 future Sunday, 8/30 Sunday skipped.
    const rows = [
      ['SEPTEMBER'],
      ['9/1/2026', '', '', '', ''],
      ['9/2/2026', '7:40:00 AM', '12:00:00 PM', '1:00:00 PM', '5:00:00 PM'],
      ['9/3/2026', '', '', '', ''],
      ['9/4/2026', '', '', '', ''],
      ['9/5/2026', '', '', '', ''],
      ['9/6/2026', '', '', '', ''],
      ['8/30/2026', '', '', '', ''],
      ['TOTAL HOURS'],
    ];
    expect(planAbsentSweep('T', rows, '2026-09-05')).toEqual([
      { tab: 'T', row1Based: 2, endRow1BasedExcl: 3, startCol0: 1, endCol0Excl: 5, red: true },
      { tab: 'T', row1Based: 4, endRow1BasedExcl: 6, startCol0: 1, endCol0Excl: 5, red: true },
    ]);
    expect(planAbsentSweep('T', rows, 'not-a-date')).toEqual([]);
  });
  it('builds repeatCell background-only requests capped at column E', () => {
    const ids = new Map([['T', 1880677918]]);
    const reqs = buildFormatRequests(
      [
        { tab: 'T', row1Based: 107, endRow1BasedExcl: 108, startCol0: 3, endCol0Excl: 5, red: true },
        { tab: 'T', row1Based: 107, endRow1BasedExcl: 108, startCol0: 1, endCol0Excl: 3, red: false },
      ],
      (tab) => {
        const id = ids.get(tab);
        if (id === undefined) throw new Error(`unknown tab ${tab}`);
        return id;
      },
    );
    expect(reqs.length).toBe(2);
    const [red, white] = reqs;
    expect(red.repeatCell.range).toEqual({
      sheetId: 1880677918,
      startRowIndex: 106,
      endRowIndex: 107,
      startColumnIndex: 3,
      endColumnIndex: 5,
    });
    expect(red.repeatCell.cell.userEnteredFormat.backgroundColor).toEqual({ red: 1, green: 0, blue: 0 });
    expect(red.repeatCell.fields).toBe('userEnteredFormat.backgroundColor');
    expect(white.repeatCell.cell.userEnteredFormat.backgroundColor).toEqual({ red: 1, green: 1, blue: 1 });
    for (const r of reqs) {
      expect(r.repeatCell.range.endColumnIndex).toBeLessThanOrEqual(5);
    }
  });
  it('end-to-end: half-day push paints D:E red via fake client', async () => {
    const rows = [
      ['SEPTEMBER'],
      ['9/1/2026', '', '', '', ''],
    ];
    const client = makeClient({ 'ROSADO RAINEER': rows });
    const half: AttendanceDay = { ...DAY, timeOut: '2026-09-05T12:30:00+08:00' };
    const rec: AttendanceDay = { ...half, attendanceDate: '2026-09-01', timeIn: '2026-09-01T08:04:00+08:00', timeOut: '2026-09-01T12:30:00+08:00' };
    const plan = await planPush(client, rec, ROSTER);
    expect(plan.skipped).toBe(false);
    expect(plan.values).toEqual(['8:04:00 AM', '12:30:00 PM', '', '']);
    await executePush(client, plan);
    const kind = classifyRecordKind(rec.timeIn, rec.timeOut, rec.attendanceDate);
    const ops = planRowFormat(plan.tab, plan.row1Based, kind);
    const meta = await client.getTabMeta();
    const idOf = (tab: string): number => {
      const found = meta.find((m) => m.title === tab);
      if (!found) throw new Error(`unknown tab ${tab}`);
      return found.sheetId;
    };
    await client.applyFormats(buildFormatRequests(ops, idOf));
    expect(client.paints.length).toBe(2);
    expect(client.paints[1].repeatCell.cell.userEnteredFormat.backgroundColor).toEqual({ red: 1, green: 0, blue: 0 });
  });
});

describe('auto-create tab alignment', () => {
  const RONA: DtrSyncUser = { userId: 'INTERN-999', fullName: 'Rona Khristelle Angelique Pacada' };
  it('picks the live template tab, else the known gid', () => {
    expect(pickTemplateSheet([{ title: 'X', sheetId: 1 }, { title: 'COPY OF TEMPLATE', sheetId: 42 }])).toEqual({
      title: 'COPY OF TEMPLATE',
      sheetId: 42,
    });
    expect(pickTemplateSheet([{ title: 'X', sheetId: 1 }])).toEqual({
      title: 'COPY OF TEMPLATE',
      sheetId: DTR_TEMPLATE_SHEET_ID,
    });
  });
  it('validates tab names like Sheets does', () => {
    expect(isValidTabName('Deign Grey O. Lazaro')).toBe(true);
    expect(isValidTabName('')).toBe(false);
    expect(isValidTabName('A:B')).toBe(false);
    expect(isValidTabName('A/B')).toBe(false);
    expect(isValidTabName('x'.repeat(101))).toBe(false);
  });
  it('detects duplicate-name errors only', () => {
    expect(isDuplicateNameError(400, 'A sheet with the name X already exists.')).toBe(true);
    expect(isDuplicateNameError(403, 'denied')).toBe(false);
    expect(isDuplicateNameError(400, 'other 400')).toBe(false);
  });
  it('overlap gate blocks ambiguous creates, allows clean misses', () => {
    expect(hasTabOverlap(['MARY', 'COPY OF TEMPLATE'], 'Mary Jane Santos')).toBe(true);
    expect(hasTabOverlap(['MARY', 'COPY OF TEMPLATE'], 'Rona Khristelle Angelique Pacada')).toBe(false);
    expect(hasTabOverlap(['COPY OF TEMPLATE'], 'Rona Khristelle Angelique Pacada')).toBe(false);
    // Single-character middle initial "C." must not collide between distinct people
    expect(hasTabOverlap(['Raineer C. Rosado'], 'Maricon C. Danao')).toBe(false);
    expect(hasTabOverlap([], '')).toBe(true);
  });
  it('creates a missing tab and resolves it', async () => {
    const client = makeClient({ 'COPY OF TEMPLATE': [] });
    const tab = await ensurePersonTab(client, RONA, [RONA]);
    expect(tab).toBe('Rona Khristelle Angelique Pacada');
    expect(client.created).toEqual(['Rona Khristelle Angelique Pacada']);
  });
  it('returns existing tabs without creating', async () => {
    const client = makeClient({ 'Raineer C. Rosado': [] });
    const tab = await ensurePersonTab(client, ROSTER[0], ROSTER);
    expect(tab).toBe('Raineer C. Rosado');
    expect(client.created).toEqual([]);
  });
  it('returns null on overlap instead of minting a second tab', async () => {
    const client = makeClient({ MARY: [] });
    const mary: DtrSyncUser = { userId: 'X', fullName: 'Mary Jane Santos' };
    const rival: DtrSyncUser = { userId: 'Y', fullName: 'Mary Ann Reyes' };
    const tab = await ensurePersonTab(client, mary, [mary, rival]);
    expect(tab).toBeNull();
    expect(client.created).toEqual([]);
  });
});

describe('DTR vs payroll independence (half-day decoupling)', () => {
  const date = '2026-09-05';
  it('08:00-15:00 DTR keeps actual stamps while payroll is half-day with 08:00-12:00 window', async () => {
    const { calculateInternPayroll } = await import('../src/intern-payroll.js');
    expect(buildDtrRow('2026-09-05T08:00:00+08:00', '2026-09-05T15:00:00+08:00', date)).toEqual([
      '8:00:00 AM', '', '', '3:00:00 PM',
    ]);
    const pay = calculateInternPayroll({
      attendanceDate: date,
      actualTimeIn: '2026-09-05T08:00:00+08:00',
      actualTimeOut: '2026-09-05T15:00:00+08:00',
      graceAvailable: true,
    });
    expect(pay.isHalfDay).toBe(true);
    expect(pay.halfDayDeduction).toBe(40);
    expect(pay.dailyPay).toBe(40);
    expect(pay.computedTimeIn).toBe('2026-09-05T08:00:00+08:00');
    expect(pay.computedTimeOut).toBe('2026-09-05T12:00:00+08:00');
  });
  it('08:00-17:00 full day keeps actual stamps and full pay', async () => {
    const { calculateInternPayroll } = await import('../src/intern-payroll.js');
    expect(buildDtrRow('2026-09-05T08:00:00+08:00', '2026-09-05T17:00:00+08:00', date)).toEqual([
      '8:00:00 AM', '', '', '5:00:00 PM',
    ]);
    const pay = calculateInternPayroll({
      attendanceDate: date,
      actualTimeIn: '2026-09-05T08:00:00+08:00',
      actualTimeOut: '2026-09-05T17:00:00+08:00',
      graceAvailable: true,
    });
    expect(pay.isHalfDay).toBe(false);
    expect(pay.dailyPay).toBe(80);
  });
  it('sub-4h shift keeps actual stamps and stays half-day for pay', async () => {
    const { calculateInternPayroll } = await import('../src/intern-payroll.js');
    expect(buildDtrRow('2026-09-05T11:30:00+08:00', '2026-09-05T14:30:00+08:00', date)).toEqual([
      '11:30:00 AM', '', '', '2:30:00 PM',
    ]);
    const pay = calculateInternPayroll({
      attendanceDate: date,
      actualTimeIn: '2026-09-05T11:30:00+08:00',
      actualTimeOut: '2026-09-05T14:30:00+08:00',
      graceAvailable: true,
    });
    expect(pay.isHalfDay).toBe(true);
  });
  it('12:30 arrival keeps the actual in-time on the DTR', () => {
    expect(buildDtrRow('2026-09-05T12:30:00+08:00', '2026-09-05T17:00:00+08:00', date)).toEqual([
      '', '', '12:30:00 PM', '5:00:00 PM',
    ]);
  });
});

describe('late time-out auto-cap (18:00+ renders/pays as 17:00)', () => {
  const date = '2026-09-05';
  it('08:00-19:30 DTR out shows 17:00 and classifies full', () => {
    expect(buildDtrRow('2026-09-05T08:00:00+08:00', '2026-09-05T19:30:00+08:00', date)).toEqual([
      '8:00:00 AM', '', '', '5:00:00 PM',
    ]);
    expect(classifyRecordKind('2026-09-05T08:00:00+08:00', '2026-09-05T19:30:00+08:00', date)).toBe('full');
  });
  it('18:00:00 boundary caps while 17:59:59 stays actual', () => {
    expect(buildDtrRow('2026-09-05T08:00:00+08:00', '2026-09-05T18:00:00+08:00', date)).toEqual([
      '8:00:00 AM', '', '', '5:00:00 PM',
    ]);
    expect(buildDtrRow('2026-09-05T08:00:00+08:00', '2026-09-05T17:59:59+08:00', date)).toEqual([
      '8:00:00 AM', '', '', '5:59:59 PM',
    ]);
  });
  it('08:00-19:30 payroll is full-day computed on capped 08:00-17:00', async () => {
    const { calculateInternPayroll } = await import('../src/intern-payroll.js');
    const pay = calculateInternPayroll({
      attendanceDate: date,
      actualTimeIn: '2026-09-05T08:00:00+08:00',
      actualTimeOut: '2026-09-05T19:30:00+08:00',
      graceAvailable: true,
    });
    expect(pay.isHalfDay).toBe(false);
    expect(pay.computedTimeOut).toBe('2026-09-05T17:00:00+08:00');
    expect(pay.dailyPay).toBe(80);
  });
});

describe('audit A1: shared normalization validates ordering after the cap', () => {
  const date = '2026-09-05';
  it('classifyRecordKind throws when capping inverts the pair (17:30 in, 18:00 out)', () => {
    expect(() =>
      classifyRecordKind('2026-09-05T17:30:00+08:00', '2026-09-05T18:00:00+08:00', date),
    ).toThrow('earlier than time-in');
  });
  it('buildDtrRow throws for the same capped-inverted pair', () => {
    expect(() =>
      buildDtrRow('2026-09-05T17:30:00+08:00', '2026-09-05T18:00:00+08:00', date),
    ).toThrow('earlier than time-in');
  });
  it('08:00-19:30 caps to 17:00 in both paths (row + full)', () => {
    expect(buildDtrRow('2026-09-05T08:00:00+08:00', '2026-09-05T19:30:00+08:00', date)).toEqual([
      '8:00:00 AM',
      '',
      '',
      '5:00:00 PM',
    ]);
    expect(classifyRecordKind('2026-09-05T08:00:00+08:00', '2026-09-05T19:30:00+08:00', date)).toBe('full');
  });
  it('18:00:00 caps while 17:59:59 stays actual', () => {
    expect(buildDtrRow('2026-09-05T08:00:00+08:00', '2026-09-05T18:00:00+08:00', date)).toEqual([
      '8:00:00 AM',
      '',
      '',
      '5:00:00 PM',
    ]);
    expect(buildDtrRow('2026-09-05T08:00:00+08:00', '2026-09-05T17:59:59+08:00', date)).toEqual([
      '8:00:00 AM',
      '',
      '',
      '5:59:59 PM',
    ]);
  });
  it('exactly 4 hours is NOT a short stint; just under 4 hours IS', () => {
    expect(isShortStint('2026-09-05T08:00:00+08:00', '2026-09-05T12:00:00+08:00')).toBe(false);
    expect(isShortStint('2026-09-05T08:00:00+08:00', '2026-09-05T11:59:59+08:00')).toBe(true);
  });
  it('whitespace-only stamps agree across both consumers (Rust parity)', () => {
    // Independent verification found the two consumers disagreed here:
    // buildDtrRow threw `invalid Manila timestamp` while classifyRecordKind
    // returned 'working'. Whitespace-only must read as absent/working in both.
    expect(buildDtrRow('   ', null, date)).toEqual(['', '', '', '']);
    expect(classifyRecordKind('   ', null, date)).toBe('absent');
    expect(buildDtrRow('   ', '2026-09-05T17:00:00+08:00', date)).toEqual(['', '', '', '']);
    expect(classifyRecordKind('   ', '2026-09-05T17:00:00+08:00', date)).toBe('absent');
    // Whitespace-only time-out reads as a working record, not invalid.
    expect(buildDtrRow('2026-09-05T08:00:00+08:00', '   ', date)).toEqual([
      '8:00:00 AM',
      '',
      '',
      '',
    ]);
    expect(classifyRecordKind('2026-09-05T08:00:00+08:00', '   ', date)).toBe('working');
  });
});
