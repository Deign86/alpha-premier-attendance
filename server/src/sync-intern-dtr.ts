/**
 * Sync kiosk attendance (local SQLite) → INTERN DTR 2026 human sheet.
 *
 * Dry-run by default (prints the plan). Pass `--execute` to write.
 * Writes ONLY B:E data cells via values.update USER_ENTERED.
 *
 * Usage:
 *   tsx src/sync-intern-dtr.ts [--db PATH] [--date YYYY-MM-DD]
 *     [--user <userId|name-fragment>] [--sheet ID] [--execute]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';
import { google } from 'googleapis';
import {
  buildFormatRequests,
  classifyRecordKind,
  ensurePersonTab,
  executePush,
  isDuplicateNameError,
  planAbsentSweep,
  planPush,
  planRowFormat,
  type AttendanceDay,
  type DtrSyncUser,
  type DtrTabMeta,
  type FormatOp,
  type FormatRequest,
  type PushPlan,
  type SheetsClient,
} from './intern-dtr-sync.js';

const MANILA_ZONE = 'Asia/Manila';
const DEFAULT_DB = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
  'com.alphapremier.attendance',
  'attendance.db',
);
const KEY_PATH = path.join(os.homedir(), '.rfid-attendance', 'attendance-sheets-key.json');

type Args = {
  db: string;
  date: string;
  user: string | null;
  sheet: string | null;
  execute: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {
    db: process.env.ALPHA_PREMIER_DB_PATH?.trim() || DEFAULT_DB,
    date: DateTime.now().setZone(MANILA_ZONE).toISODate() ?? '',
    user: null,
    sheet: null,
    execute: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--db' && next) { out.db = next; i += 1; }
    else if (a === '--date' && next) { out.date = next; i += 1; }
    else if (a === '--user' && next) { out.user = next; i += 1; }
    else if (a === '--sheet' && next) { out.sheet = next; i += 1; }
    else if (a === '--execute') { out.execute = true; }
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.date)) {
    throw new Error(`--date must be YYYY-MM-DD, got ${out.date}`);
  }
  return out;
}

/** Minimal KEY=VALUE parser for server/.env (only INTERN_DTR_SHEET_ID is read). */
function readEnvSheetId(serverDir: string): string | null {
  const envPath = path.join(serverDir, '.env');
  if (!fs.existsSync(envPath)) return null;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^INTERN_DTR_SHEET_ID\s*=\s*(.+?)\s*$/.exec(line.trim());
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  return null;
}

function quoteTab(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`;
}

function createSheetsClient(keyEmail: string, keyPrivate: string, spreadsheetId: string): SheetsClient {
  const auth = new google.auth.JWT({
    email: keyEmail,
    key: keyPrivate,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  return {
    async getTabMeta(): Promise<{ title: string; sheetId: number }[]> {
      const res = await sheets.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets.properties(title,sheetId)',
      });
      return (res.data.sheets ?? []).flatMap((s) => {
        const title = s.properties?.title;
        const sheetId = s.properties?.sheetId;
        if (
          Object.prototype.toString.call(title) !== '[object String]' ||
          Object.prototype.toString.call(sheetId) !== '[object Number]'
        ) {
          return [];
        }
        // SAFETY: title/sheetId verified as string/number at this I/O boundary above.
        return [{ title: title as string, sheetId: sheetId as number }];
      });
    },
    async getTabTitles(): Promise<string[]> {
      const meta = await this.getTabMeta();
      return meta.map((m) => m.title);
    },
    async getTabValues(tab: string): Promise<string[][]> {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${quoteTab(tab)}!A:F`,
      });
      return (res.data.values ?? []).map((row) => row.map((c) => String(c ?? '')));
    },
    async updateRow(tab: string, row1Based: number, values: string[]): Promise<void> {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${quoteTab(tab)}!B${row1Based}:E${row1Based}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [values] },
      });
    },
    async applyFormats(requests: FormatRequest[]): Promise<void> {
      if (requests.length === 0) return;
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests },
      });
    },
    async duplicateTemplate(sourceSheetId: number, newTitle: string): Promise<DtrTabMeta | null> {
      let res: unknown;
      try {
        res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [{ duplicateSheet: { sourceSheetId, newSheetName: newTitle } }],
          },
        });
      } catch (err) {
        // SAFETY: googleapis errors carry response/status/payload fields;
        // each is structurally verified before use below, nothing is logged.
        const maybeResponse = (err as { response?: unknown })?.response;
        if (Object.prototype.toString.call(maybeResponse) !== '[object Object]') throw err;
        // SAFETY: response verified as a plain object by the guard above.
        const response = maybeResponse as { status?: unknown; data?: unknown };
        let body: string;
        if (Object.prototype.toString.call(response.data) === '[object String]') {
          // SAFETY: data verified as a string by the check above.
          body = response.data as string;
        } else {
          body = JSON.stringify(response.data ?? '');
        }
        if (Object.prototype.toString.call(response.status) === '[object Number]') {
          // SAFETY: status verified as a number by the check above.
          const status: number = response.status as number;
          if (isDuplicateNameError(status, body)) return null;
        }
        throw err;
      }
      // SAFETY: reply shape validated field-by-field below before use.
      const replies = (res as { data?: { replies?: unknown } })?.data?.replies;
      // SAFETY: first reply is an object; sheetId is read as unknown and verified below.
      const props = Array.isArray(replies)
        ? (replies[0] as { duplicateSheet?: { properties?: { sheetId?: unknown } } })?.duplicateSheet
          ?.properties
        : undefined;
      if (Object.prototype.toString.call(props?.sheetId) !== '[object Number]') {
        throw new Error(`duplicateSheet reply missing numeric sheetId for ${newTitle}`);
      }
      const sheetId: number = Number(props?.sheetId);
      return { title: newTitle, sheetId };
    },
  };
}

type DbRow = Record<string, string | number | null>;

async function loadDay(dbPath: string, date: string, userFilter: string | null): Promise<{
  users: DtrSyncUser[];
  records: AttendanceDay[];
}> {
  let sqlite: typeof import('node:sqlite');
  try {
    sqlite = await import('node:sqlite');
  } catch {
    throw new Error(
      'node:sqlite is unavailable — run with a Node 22.13+ runtime ' +
        '(e.g. node --experimental-sqlite ./node_modules/tsx/dist/cli.mjs src/sync-intern-dtr.ts)',
    );
  }
  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `attendance.db not found at ${dbPath} — pass --db PATH or set ALPHA_PREMIER_DB_PATH`,
    );
  }
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    // SAFETY: node:sqlite .all() returns one object per row keyed by the
    // SELECT column list; every field is coerced via String() below.
    const users = db
      .prepare(
        "select user_id, full_name from users where status = 'ACTIVE' and upper(employee_type) = 'INTERN' order by full_name",
      )
      .all() as DbRow[];
    const allUsers: DtrSyncUser[] = users.map((u) => ({
      userId: String(u.user_id ?? ''),
      fullName: String(u.full_name ?? ''),
    }));
    const wanted = userFilter
      ? allUsers.filter(
          (u) =>
            u.userId === userFilter ||
            u.fullName.toLowerCase().includes(userFilter.toLowerCase()),
        )
      : allUsers;
    if (wanted.length === 0) throw new Error(`--user matched nobody: ${userFilter}`);
    const ids = new Set(wanted.map((u) => u.userId));
    // SAFETY: same node:sqlite row-object contract as above; String()-coerced at use.
    const rows = db
      .prepare(
        'select user_id, full_name, attendance_date, time_in, time_out, status from attendance where attendance_date = ?',
      )
      .all(date) as DbRow[];
    const records: AttendanceDay[] = rows
      .filter((r) => ids.has(String(r.user_id ?? '')))
      .map((r) => ({
        userId: String(r.user_id ?? ''),
        fullName: String(r.full_name ?? ''),
        attendanceDate: String(r.attendance_date ?? ''),
        timeIn: r.time_in ? String(r.time_in) : null,
        timeOut: r.time_out ? String(r.time_out) : null,
        status: String(r.status ?? ''),
      }));
    return { users: allUsers, records };
  } finally {
    db.close();
  }
}

function describePlan(p: PushPlan): string {
  const who = `${p.record.fullName} (${p.record.userId})`;
  if (p.skipped) return `SKIP ${who}: ${p.reason}`;
  const [b, c, d, e] = p.values;
  return `WRITE ${who} → '${p.tab}' row ${p.row1Based}: B=${b} C=${c} D=${d} E=${e || '(empty)'}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const serverDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const sheetId = args.sheet ?? readEnvSheetId(serverDir);
  if (!sheetId) {
    throw new Error('sheet id missing — pass --sheet ID or set INTERN_DTR_SHEET_ID in server/.env');
  }
  if (!fs.existsSync(KEY_PATH)) {
    throw new Error(`service-account key missing at ${KEY_PATH}`);
  }
  // SAFETY: key file is minted by `gcloud iam service-accounts keys create`
  // (JSON object with string client_email/private_key); shape checked below.
  const keyRaw = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8')) as { client_email?: unknown; private_key?: unknown };
  if (
    Object.prototype.toString.call(keyRaw.client_email) !== '[object String]' ||
    Object.prototype.toString.call(keyRaw.private_key) !== '[object String]'
  ) {
    throw new Error(`service-account key at ${KEY_PATH} lacks string client_email/private_key`);
  }
  // SAFETY: both fields verified as strings above.
  const key = keyRaw as { client_email: string; private_key: string };
  const { users, records } = await loadDay(args.db, args.date, args.user);
  console.log(`date=${args.date} interns=${users.length} records=${records.length} mode=${args.execute ? 'EXECUTE' : 'DRY-RUN'}`);
  if (records.length === 0) {
    console.log('nothing to sync — no attendance rows for this date/filter');
    return;
  }
  const client = createSheetsClient(key.client_email, key.private_key, sheetId);
  const meta = await client.getTabMeta();
  const sheetIdOf = (tab: string): number => {
    const found = meta.find((m) => m.title === tab);
    if (!found) throw new Error(`tab id missing for resolved tab ${tab}`);
    return found.sheetId;
  };
  const manilaToday = DateTime.now().setZone(MANILA_ZONE).toISODate() ?? args.date;
  const rowOpsByTab = new Map<string, FormatOp[]>();
  const valuesCache = new Map<string, string[][]>();
  let wrote = 0;
  let skipped = 0;
  const failures: string[] = [];
  for (const record of records) {
    try {
      let plan = await planPush(client, record, users);
      console.log(describePlan(plan));
      // Tabs align to roster names: on a clean miss for an intern,
      // auto-create the tab from the template and re-plan once.
      // Overlaps/invalid names stay skipped for the owner.
      if (plan.skipped && plan.reason.startsWith('tab NO_MATCH')) {
        const user = users.find((u) => u.userId === record.userId);
        const created = user ? await ensurePersonTab(client, user, users) : null;
        if (created) {
          console.log(`TAB-CREATED ${created} for ${record.fullName}; re-planning`);
          plan = await planPush(client, record, users);
          console.log(describePlan(plan));
        }
      }
      // P1: 'already in sync' carries a real tab+row — its format ops
      // (white/clear + absent sweep below) must still ride the paint
      // pass, mirroring the Rust InSync branch. Only true misses skip.
      if (plan.skipped && plan.reason !== 'already in sync') {
        skipped += 1;
        continue;
      }
      const kind = classifyRecordKind(record.timeIn, record.timeOut, record.attendanceDate);
      const ops = planRowFormat(plan.tab, plan.row1Based, kind);
      const list = rowOpsByTab.get(plan.tab) ?? [];
      list.push(...ops);
      rowOpsByTab.set(plan.tab, list);
      if (plan.skipped) {
        skipped += 1;
        continue;
      }
      if (!args.execute) {
        skipped += 1;
        continue;
      }
      await executePush(client, plan);
      wrote += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`${record.fullName}: ${msg}`);
      console.log(`FAIL ${record.fullName} (${record.userId}): ${msg}`);
    }
  }
  // Paint pass: row ops + absent sweep per touched tab, one batchUpdate.
  let paintedTabs = 0;
  for (const [tab, ops] of rowOpsByTab) {
    try {
      let rows = valuesCache.get(tab);
      if (!rows) {
        rows = await client.getTabValues(tab);
        valuesCache.set(tab, rows);
      }
      const all = [...ops, ...planAbsentSweep(tab, rows, manilaToday)];
      if (!args.execute) {
        const reds = all.filter((o) => o.red).length;
        console.log(`FORMAT ${tab}: ${all.length} ops (${reds} red) — dry run, not applied`);
        continue;
      }
      await client.applyFormats(buildFormatRequests(all, sheetIdOf));
      paintedTabs += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`${tab}: paint failed: ${msg}`);
      console.log(`FAIL paint ${tab}: ${msg}`);
    }
  }
  console.log(`done: wrote=${wrote} skipped=${skipped} paintedTabs=${paintedTabs} failed=${failures.length}`);
  if (failures.length > 0) process.exitCode = 1;
}

await main();
