/**
 * Live intern-DTR sync logic (INTERN DTR 2026 human sheet).
 *
 * Tab-naming reality: roster stores `FIRST [middle…] LAST`
 * (e.g. `Raineer C. Rosado`) while tabs are `LAST FIRST`
 * (`ROSADO RAINEER`), single first-names, or multi-word surnames
 * (`DE GUERTO ISHI`). Resolution rule: a tab belongs to a user iff
 * every normalized tab token appears in the user's tokens AND the tab
 * includes the user's last token. Surnames are unique in the roster,
 * so the last-token requirement keeps matches unique; anything else
 * fails closed (AMBIGUOUS / NO_MATCH) and is skipped with a log.
 *
 * Writes touch ONLY B:E data cells (TIME IN MORNING, OUT LUNCH,
 * TIME IN AFTERNOON, TIME OUT). Columns F (TOTAL HOURS) and the
 * H:J counters are formula territory and are never written.
 */
import { DateTime } from 'luxon';

export type DtrSyncUser = {
  userId: string;
  fullName: string;
};

export type AttendanceDay = {
  userId: string;
  fullName: string;
  /** Calendar date `YYYY-MM-DD` (Manila). */
  attendanceDate: string;
  /** ISO Manila timestamp, null when not yet timed in. */
  timeIn: string | null;
  /** ISO Manila timestamp, null until timed out. */
  timeOut: string | null;
  status: string;
};

/** Minimal Sheets surface so push logic is unit-testable without network. */
export interface SheetsClient {
  getTabTitles(): Promise<string[]>;
  getTabMeta(): Promise<{ title: string; sheetId: number }[]>;
  /** Full tab values for columns A:F (all rows). */
  getTabValues(tab: string): Promise<string[][]>;
  /** Write contiguous B:E cells of one 1-based row. */
  updateRow(tab: string, row1Based: number, values: string[]): Promise<void>;
  /** Paint cells (ONE spreadsheets.batchUpdate; skips empty internally). */
  applyFormats(requests: FormatRequest[]): Promise<void>;
  /** Duplicate the template tab as `newTitle` (tabs align to roster names).
   *  `sourceSheetId` is the template tab id. Returns the new tab meta, or
   *  null when the name was taken concurrently (caller re-resolves). */
  duplicateTemplate(sourceSheetId: number, newTitle: string): Promise<DtrTabMeta | null>;
}

export type TabResolution =
  | { status: 'MATCH'; tab: string }
  | { status: 'AMBIGUOUS' | 'NO_MATCH' | 'SKIP'; tab: null };

export type PushPlan = {
  record: AttendanceDay;
  tab: string;
  row1Based: number;
  /** [B, C, D, E] values to write. */
  values: [string, string, string, string];
  skipped: boolean;
  reason: string;
};

const TEMPLATE_TITLES = new Set(['copy of template', 'template']);

/** Tab title + numeric id (Sheets metadata shape). */
export interface DtrTabMeta {
  title: string;
  sheetId: number;
}

/** gid of the operator "COPY OF TEMPLATE" tab (auto-create fallback). */
export const DTR_TEMPLATE_SHEET_ID = 1417402751;

/** Pick the template tab to duplicate: a live title mentioning
 *  "template" (case-insensitive), else the known template gid with a
 *  placeholder title (the duplicate then fails closed if gone too). */
export function pickTemplateSheet(meta: DtrTabMeta[]): DtrTabMeta {
  const live = meta.find((m) => m.title.toLowerCase().includes('template'));
  if (live) return { title: live.title, sheetId: live.sheetId };
  return { title: 'COPY OF TEMPLATE', sheetId: DTR_TEMPLATE_SHEET_ID };
}

/** Sheets forbids these characters in tab titles (100 chars max). */
export function isValidTabName(name: string): boolean {
  const trimmed = name.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= 100 &&
    !/[:\\/?*[\]]/.test(trimmed)
  );
}

/** True when some live (non-template) tab already shares a normalized
 *  token with the user. Auto-create fires only on a clean miss. */
export function hasTabOverlap(tabTitles: string[], fullName: string): boolean {
  const userToks = dtrTokens(fullName);
  const stripped = stripNameSuffix(userToks);
  const core = stripped.length > 0 ? stripped : userToks;
  if (core.length === 0) return true;
  const owned = new Set(core);
  return tabTitles.some((title) => {
    if (isSkippableTitle(title)) return false;
    return dtrTokens(title).some((t) => owned.has(t));
  });
}

/** True when a duplicateSheet failure means "name already taken". */
export function isDuplicateNameError(status: number, body: string): boolean {
  return status === 400 && body.includes('already exists');
}

/** Resolve the user's tab, auto-creating it from the template when an
 *  intern genuinely has none. Tabs align to roster names verbatim.
 *  Returns the title, or null when still pending (overlap / invalid
 *  name / duplicate race / no template). The caller's roster here is
 *  interns-only, matching the Rust side's active-intern gate. */
export async function ensurePersonTab(
  client: SheetsClient,
  user: DtrSyncUser,
  allUsers: DtrSyncUser[],
): Promise<string | null> {
  const meta = await client.getTabMeta();
  const titles = meta.map((m) => m.title);
  const hit = resolveUserTab(titles, user, allUsers);
  if (hit.status === 'MATCH') return hit.tab;
  if (hasTabOverlap(titles, user.fullName)) return null;
  if (!isValidTabName(user.fullName)) return null;
  const template = pickTemplateSheet(meta);
  const created = await client.duplicateTemplate(template.sheetId, user.fullName.trim());
  if (!created) return null;
  const fresh = await client.getTabTitles();
  const again = resolveUserTab(fresh, user, allUsers);
  return again.status === 'MATCH' ? again.tab : null;
}

export const LUNCH_OUT = '12:00:00 PM';
export const LUNCH_IN = '1:00:00 PM';

const MANILA_ZONE = 'Asia/Manila';

/** Fold common Latin diacritics to ASCII before filtering, so roster
 * `Peña` still matches tab `PENA`. No dependency; characters outside
 * this table that are not a-z0-9 are dropped on both sides (consistent,
 * but e.g. `Nguyễn` → `nguyn` only matches the same folded spelling).
 */
function foldDiacritic(c: string): string {
  switch (c) {
    case 'á': case 'à': case 'â': case 'ä': case 'ã': case 'å': case 'ā': case 'ă': case 'ą': return 'a';
    case 'é': case 'è': case 'ê': case 'ë': case 'ē': case 'ę': return 'e';
    case 'í': case 'ì': case 'î': case 'ï': case 'ī': return 'i';
    case 'ó': case 'ò': case 'ô': case 'ö': case 'õ': case 'ō': return 'o';
    case 'ú': case 'ù': case 'û': case 'ü': case 'ū': return 'u';
    case 'ñ': case 'ń': return 'n';
    case 'ç': case 'ć': case 'č': return 'c';
    case 'ý': case 'ÿ': return 'y';
    case 'ß': return 's';
    case 'ø': return 'o';
    case 'æ': return 'a';
    case 'œ': return 'o';
    case 'ð': return 'd';
    case 'þ': return 't';
    case 'ł': return 'l';
    case 'š': return 's';
    case 'ž': return 'z';
    default: return c;
  }
}

/** Lowercase + strip everything but a-z0-9 (`Ar-jee`→`arjee`, `Ma.`→`ma`). */
export function normalizeDtrToken(token: string): string {
  return [...token.trim().toLowerCase()].map(foldDiacritic).join('').replace(/[^a-z0-9]/g, '');
}

/** Normalized non-empty tokens of a name or tab title. */
export function dtrTokens(name: string): string[] {
  return name
    .split(/\s+/)
    .map(normalizeDtrToken)
    .filter((t) => t.length > 0);
}

/** Last token of a full name sans generational suffix, null when blank.
 * `Juan Dela Cruz Jr` → `cruz`: without suffix stripping no LAST FIRST
 * tab could ever satisfy the last-token rule. Mirrors the Rust side. */
export function userLastToken(fullName: string): string | null {
  const toks = stripNameSuffix(dtrTokens(fullName));
  return toks.length > 0 ? toks[toks.length - 1] : null;
}

const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

/** Drop trailing generational suffixes (jr/sr/ii/iii/iv/v). */
function stripNameSuffix(toks: string[]): string[] {
  let end = toks.length;
  while (end > 0 && NAME_SUFFIXES.has(toks[end - 1])) end -= 1;
  return toks.slice(0, end);
}

function isSkippableTitle(title: string): boolean {
  const toks = dtrTokens(title);
  return toks.length === 0 || TEMPLATE_TITLES.has(toks.join(' '));
}

/** True when every tab token appears in the user's tokens (order-free). */
function tabCoveredByUser(tabToks: string[], userToks: string[]): boolean {
  const owned = new Set(userToks);
  return tabToks.length > 0 && tabToks.every((t) => owned.has(t));
}

/**
 * Resolve the DTR tab for one roster user. `allUsers` is the full roster
 * (used to detect a tab that also covers somebody else → AMBIGUOUS).
 */
export function resolveUserTab(
  tabTitles: string[],
  user: DtrSyncUser,
  allUsers: DtrSyncUser[],
): TabResolution {
  const userToks = dtrTokens(user.fullName);
  const coreToks = stripNameSuffix(userToks);
  const last = coreToks.length > 0 ? coreToks[coreToks.length - 1] : null;
  if (userToks.length === 0 || last === null) return { status: 'SKIP', tab: null };

  const candidates: string[] = [];
  for (const title of tabTitles) {
    if (isSkippableTitle(title)) continue;
    const tabToks = dtrTokens(title);
    if (tabToks.length === 1) {
      // Single-name tab (ELLAINE, KURT, …): matches when the token sits
      // anywhere in exactly one roster user's tokens.
      if (!userToks.includes(tabToks[0])) continue;
      const collides = allUsers.some(
        (other) => other.userId !== user.userId && dtrTokens(other.fullName).includes(tabToks[0]),
      );
      if (collides) return { status: 'AMBIGUOUS', tab: null };
      candidates.push(title);
      continue;
    }
    if (!tabToks.includes(last)) continue;
    if (!tabCoveredByUser(tabToks, coreToks)) continue;
    // Fail closed when another roster user is also covered by this tab
    // (suffix-stripped on their side too).
    const collides = allUsers.some((other) => {
      if (other.userId === user.userId) return false;
      return tabCoveredByUser(tabToks, stripNameSuffix(dtrTokens(other.fullName)));
    });
    if (collides) return { status: 'AMBIGUOUS', tab: null };
    candidates.push(title);
  }
  if (candidates.length === 1) return { status: 'MATCH', tab: candidates[0] };
  if (candidates.length > 1) return { status: 'AMBIGUOUS', tab: null };
  return { status: 'NO_MATCH', tab: null };
}

type DateParts = { y: number; m: number; d: number };

function toParts(y: number, m: number, d: number): DateParts | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d };
}

/** Parse a sheet date cell (`M/D/YYYY`, `MM/DD/YYYY`, `YYYY-MM-DD`). */
export function parseSheetDate(cell: string): DateParts | null {
  const text = cell.trim();
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (slash) return toParts(Number(slash[3]), Number(slash[1]), Number(slash[2]));
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return toParts(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  return null;
}

function parseYmd(ymd: string): DateParts {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  const parts = iso ? toParts(Number(iso[1]), Number(iso[2]), Number(iso[3])) : null;
  if (!parts) throw new Error(`attendanceDate must be YYYY-MM-DD, got ${ymd}`);
  return parts;
}

/** Parse a month-block header (`JUNE`, `DATE-September`) → 1-12. */
export function parseMonthHeader(cell: string): number | null {
  const text = cell.trim().replace(/^date\s*-\s*/i, '').toLowerCase();
  const months = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ];
  const idx = months.indexOf(text);
  if (idx !== -1) return idx + 1;
  const abbrev = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec'];
  const a = abbrev.indexOf(text);
  if (a !== -1) return [1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 10, 11, 12][a];
  return null;
}

export type RowRange = { start: number; end: number };

/**
 * 0-based exclusive search bounds for one month block: rows strictly
 * between this month's header and the next month header (or sheet end).
 * Null when the tab carries month headers but none matches `m`, or when
 * the tab has no month headers at all (caller falls back to whole-tab).
 */
export function monthBlockRange(rows: string[][], m: number): RowRange | 'no-headers' | null {
  let sawHeader = false;
  let blockStart = -1;
  for (let i = 0; i < rows.length; i += 1) {
    const month = parseMonthHeader(rows[i]?.[0] ?? '');
    if (month === null) continue;
    sawHeader = true;
    if (blockStart !== -1) return { start: blockStart, end: i };
    if (month === m) blockStart = i + 1;
  }
  if (!sawHeader) return 'no-headers';
  if (blockStart === -1) return null;
  return { start: blockStart, end: rows.length };
}

/**
 * Find the 0-based row index of `ymd` in full tab values (col A).
 * Returns -1 when absent; throws when the date appears twice
 * (corrupt block — operator must fix, never guess).
 */
export function findDateRow(rows: string[][], ymd: string): number {
  return findDateRowIn(rows, ymd, 0, rows.length);
}

/** Same as findDateRow but scoped to rows[start, end). */
export function findDateRowIn(rows: string[][], ymd: string, start: number, end: number): number {
  const want = parseYmd(ymd);
  let found = -1;
  for (let i = start; i < Math.min(end, rows.length); i += 1) {
    const cell = rows[i]?.[0] ?? '';
    const parts = parseSheetDate(cell);
    if (!parts) continue;
    if (parts.y === want.y && parts.m === want.m && parts.d === want.d) {
      if (found !== -1) {
        throw new Error(`duplicate date rows for ${ymd} at rows ${found + 1} and ${i + 1}`);
      }
      found = i;
    }
  }
  return found;
}

/** ISO Manila timestamp → sheet `h:mm:ss AM/PM` (e.g. `7:24:00 AM`). */
export function formatSheetTime(isoManila: string): string {
  const dt = DateTime.fromISO(isoManila, { zone: MANILA_ZONE });
  if (!dt.isValid) throw new Error(`invalid Manila timestamp: ${isoManila}`);
  return dt.toFormat('h:mm:ss a').toUpperCase();
}

/**
 * Build [B, C, D, E] (DTR display rule, not payroll): time-in is always
 * written as-is once present; still WORKING (no time-out) keeps the
 * lunch pair with E empty; a time-out before 16:59 Manila renders
 * morning-only [in, 12PM, '', ''] with the tap-out time discarded;
 * at/after 16:59 the full [in, 12PM, 1PM, out] row is written.
 * A time-out earlier than the time-in is rejected (P4 inverted-log
 * precedent): overnight shifts are outside the kiosk same-day model.
 */
export function buildDtrRow(
  timeIn: string | null,
  timeOut: string | null,
  attendanceDate: string,
): [string, string, string, string] {
  if (!timeIn) return ['', '', '', ''];
  const started = formatSheetTime(timeIn);
  if (!timeOut) return [started, LUNCH_OUT, LUNCH_IN, ''];
  const tin = DateTime.fromISO(timeIn, { zone: MANILA_ZONE });
  const tout = DateTime.fromISO(timeOut, { zone: MANILA_ZONE });
  if (!tin.isValid) throw new Error(`invalid Manila timestamp: ${timeIn}`);
  if (!tout.isValid) throw new Error(`invalid Manila timestamp: ${timeOut}`);
  if (tout < tin) throw new Error(`Time-out cannot be earlier than time-in: ${timeOut} < ${timeIn}`);
  if (isHalfDayTimeout(timeOut, attendanceDate)) return [started, LUNCH_OUT, '', ''];
  return [started, LUNCH_OUT, LUNCH_IN, formatSheetTime(timeOut)];
}

/**
 * True when the Manila wall-clock time-out is strictly before 16:59.
 * `attendanceDate` is accepted for signature parity with the Rust side
 * (cutoff is wall-clock; overnight outs keep their own date).
 */
export function isHalfDayTimeout(timeOut: string, _attendanceDate: string): boolean {
  const dt = DateTime.fromISO(timeOut, { zone: MANILA_ZONE });
  if (!dt.isValid) throw new Error(`invalid Manila timestamp: ${timeOut}`);
  return dt.hour < 16 || (dt.hour === 16 && dt.minute < 59);
}

/**
 * DTR data-cell paint (B:E only — F TOTAL and H:J counters are formula
 * territory and never enter a format range).
 * Measured 2026-09-05 from the live INTERN DTR 2026 sheet via
 * spreadsheets.get on `LAZARO DEIGN ` D103:E103
 * (userEnteredFormat.backgroundColor of the owner-painted half-day
 * cells): pure red. WHITE clears stale paint.
 */
export const DTR_RED = { red: 1, green: 0, blue: 0 } as const;
export const DTR_WHITE = { red: 1, green: 1, blue: 1 } as const;

export type DtrRowKind = 'absent' | 'half' | 'full' | 'working';

export type FormatOp = {
  tab: string;
  /** 1-based first row of the rectangle. */
  row1Based: number;
  /** 1-based exclusive end row (merges consecutive same-color rows). */
  endRow1BasedExcl: number;
  /** 0-based start column (B = 1). */
  startCol0: number;
  /** 0-based exclusive end column (E = 5 exclusive). */
  endCol0Excl: number;
  red: boolean;
};

export type FormatRequest = {
  repeatCell: {
    range: {
      sheetId: number;
      startRowIndex: number;
      endRowIndex: number;
      startColumnIndex: number;
      endColumnIndex: number;
    };
    cell: {
      userEnteredFormat: {
        backgroundColor: { red: number; green: number; blue: number };
      };
    };
    fields: 'userEnteredFormat.backgroundColor';
  };
};

/** Classify one record for paint (same Manila cutoff as buildDtrRow). */
export function classifyRecordKind(
  timeIn: string | null,
  timeOut: string | null,
  attendanceDate: string,
): DtrRowKind {
  if (!timeIn) return 'absent';
  if (!timeOut) return 'working';
  return isHalfDayTimeout(timeOut, attendanceDate) ? 'half' : 'full';
}

/**
 * Format ops for one pushed row: absent → B:E red; half → B:C white +
 * D:E red (empty remainder); full → B:E white (clears stale red);
 * working → B:D white, E untouched.
 */
export function planRowFormat(tab: string, row1Based: number, kind: DtrRowKind): FormatOp[] {
  const one = (s: number, e: number, red: boolean): FormatOp => ({
    tab,
    row1Based,
    endRow1BasedExcl: row1Based + 1,
    startCol0: s,
    endCol0Excl: e,
    red,
  });
  if (kind === 'absent') return [one(1, 5, true)];
  if (kind === 'half') return [one(1, 3, false), one(3, 5, true)];
  if (kind === 'full') return [one(1, 5, false)];
  return [one(1, 4, false)];
}

/**
 * Absent sweep over already-fetched A:F: every date row strictly before
 * `todayYmd` (Manila `YYYY-MM-DD`) that falls Mon–Fri with empty B:E
 * gets red; consecutive rows merge. Weekends (owner greens them),
 * today/future, and non-date rows are never touched.
 */
export function planAbsentSweep(tab: string, rows: string[][], todayYmd: string): FormatOp[] {
  const today = DateTime.fromISO(todayYmd, { zone: MANILA_ZONE }).startOf('day');
  if (!today.isValid) return [];
  const runs: [number, number][] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const parts = parseSheetDate(rows[i]?.[0] ?? '');
    if (!parts) continue;
    const day = DateTime.fromObject(
      { year: parts.y, month: parts.m, day: parts.d },
      { zone: MANILA_ZONE },
    );
    if (!day.isValid || day >= today) continue;
    if (day.weekday >= 6) continue;
    const empty = [1, 2, 3, 4].every((c) => (rows[i]?.[c] ?? '').trim() === '');
    if (!empty) continue;
    const last = runs[runs.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else runs.push([i, i + 1]);
  }
  return runs.map(([s, e]) => ({
    tab,
    row1Based: s + 1,
    endRow1BasedExcl: e + 1,
    startCol0: 1,
    endCol0Excl: 5,
    red: true,
  }));
}

/**
 * Build spreadsheets.batchUpdate repeatCell requests (pure). `sheetIdOf`
 * throws on unknown tabs — the CLI resolves ids from live metadata first.
 */
export function buildFormatRequests(
  ops: FormatOp[],
  sheetIdOf: (tab: string) => number,
): FormatRequest[] {
  return ops.map((op) => {
    const color = op.red ? DTR_RED : DTR_WHITE;
    return {
      repeatCell: {
        range: {
          sheetId: sheetIdOf(op.tab),
          startRowIndex: op.row1Based - 1,
          endRowIndex: op.endRow1BasedExcl - 1,
          startColumnIndex: op.startCol0,
          endColumnIndex: op.endCol0Excl,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: color.red, green: color.green, blue: color.blue },
          },
        },
        fields: 'userEnteredFormat.backgroundColor',
      },
    };
  });
}

function rowCells(row: string[] | undefined): [string, string, string, string] {
  return [row?.[1] ?? '', row?.[2] ?? '', row?.[3] ?? '', row?.[4] ?? ''];
}

/**
 * Plan one attendance day against the live sheet. Never throws for
 * expected misses (NO_MATCH / AMBIGUOUS tab / missing date row) — those
 * become skipped plans the CLI reports; throws only for corrupt states
 * (duplicate date rows) and invalid inputs — also surfaced per record.
 */
export async function planPush(
  client: SheetsClient,
  record: AttendanceDay,
  allUsers: DtrSyncUser[],
): Promise<PushPlan> {
  const fail = (reason: string): PushPlan => ({
    record,
    tab: '',
    row1Based: -1,
    values: ['', '', '', ''],
    skipped: true,
    reason,
  });
  const titles = await client.getTabTitles();
  const resolved = resolveUserTab(
    titles,
    { userId: record.userId, fullName: record.fullName },
    allUsers,
  );
  if (resolved.status !== 'MATCH') {
    return fail(`tab ${resolved.status} for ${record.fullName}`);
  }
  const values = buildDtrRow(record.timeIn, record.timeOut, record.attendanceDate);
  if (values.every((v) => v === '')) return fail('no time-in yet');
  const rows = await client.getTabValues(resolved.tab);
  const wantMonth = Number(record.attendanceDate.slice(5, 7));
  const block = monthBlockRange(rows, wantMonth);
  if (block === null) {
    const monthName = DateTime.fromObject({ month: wantMonth }, { zone: MANILA_ZONE }).toFormat('LLLL');
    return fail(`no ${monthName} block in tab ${resolved.tab}`);
  }
  const idx = block === 'no-headers'
    ? findDateRow(rows, record.attendanceDate)
    : findDateRowIn(rows, record.attendanceDate, block.start, block.end);
  if (idx === -1) return fail(`date ${record.attendanceDate} not found in tab ${resolved.tab}`);
  const existing = rowCells(rows[idx]);
  if (existing.every((v, i) => v === values[i])) {
    return {
      record,
      tab: resolved.tab,
      row1Based: idx + 1,
      values,
      skipped: true,
      reason: 'already in sync',
    };
  }
  return {
    record,
    tab: resolved.tab,
    row1Based: idx + 1,
    values,
    skipped: false,
    reason: 'pending write B:E',
  };
}

/** Execute a non-skipped plan (single B:E range write). */
export async function executePush(client: SheetsClient, plan: PushPlan): Promise<void> {
  if (plan.skipped) return;
  await client.updateRow(plan.tab, plan.row1Based, [...plan.values]);
}
