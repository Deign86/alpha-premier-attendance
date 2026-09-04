import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

const nodeRequire = createRequire(import.meta.url);
interface NodeSqliteModule {
  DatabaseSync: typeof DatabaseSyncType;
}
// SAFETY: Loading Node.js 22 built-in node:sqlite module via createRequire
const { DatabaseSync } = nodeRequire('node:sqlite') as NodeSqliteModule;
export type DatabaseSyncInstance = DatabaseSyncType;
import type {
  PronunciationRecord,
  UpsertPronunciationRequest,
  VoiceboxDetectedName,
  VoiceboxNameListItem,
  VoiceboxPronunciationItem,
} from '@rfid-attendance/shared';

type SqliteScalar = null | number | bigint | string | NodeJS.NonSharedUint8Array;

interface SqliteMasterRow {
  name?: SqliteScalar;
}

interface SqliteTableColumn {
  cid?: SqliteScalar;
  name?: SqliteScalar;
  type?: SqliteScalar;
  notnull?: SqliteScalar;
  dflt_value?: SqliteScalar;
  pk?: SqliteScalar;
}

interface RawTableRow {
  id?: SqliteScalar;
  user_id?: SqliteScalar;
  userId?: SqliteScalar;
  employee_id?: SqliteScalar;
  employeeId?: SqliteScalar;
  full_name?: SqliteScalar;
  fullName?: SqliteScalar;
  name?: SqliteScalar;
  first_name?: SqliteScalar;
  firstName?: SqliteScalar;
  last_name?: SqliteScalar;
  lastName?: SqliteScalar;
  display_name?: SqliteScalar;
  displayName?: SqliteScalar;
}

interface SqlitePronunciationRow {
  id?: SqliteScalar;
  employee_id?: SqliteScalar;
  display_name?: SqliteScalar;
  phonetic_simple?: SqliteScalar;
  phonetic_ipa?: SqliteScalar;
  language_tag?: SqliteScalar;
  notes?: SqliteScalar;
  created_at?: SqliteScalar;
  updated_at?: SqliteScalar;
}

const dbCache = new Map<string, DatabaseSyncInstance>();

export function resolveDatabasePath(customPath?: string): string {
  if (customPath && customPath.trim().length > 0) {
    return customPath.trim();
  }

  const envApg = process.env.APGBACKUP_DB_PATH;
  if (envApg && envApg.trim().length > 0) {
    return envApg.trim();
  }

  const envAlpha = process.env.ALPHA_PREMIER_DB_PATH;
  if (envAlpha && envAlpha.trim().length > 0) {
    return envAlpha.trim();
  }

  const localApg = path.resolve(process.cwd(), 'apgbackup.db');
  if (fs.existsSync(localApg)) {
    return localApg;
  }

  const localAtt = path.resolve(process.cwd(), 'attendance.db');
  if (fs.existsSync(localAtt)) {
    return localAtt;
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData && localAppData.trim().length > 0) {
    const appDataDb = path.resolve(localAppData.trim(), 'com.alphapremier.attendance', 'attendance.db');
    if (fs.existsSync(appDataDb)) {
      return appDataDb;
    }
  }

  return localApg;
}

function initPronunciationsSchema(db: DatabaseSyncInstance): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pronunciations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id TEXT NOT NULL,
      display_name TEXT,
      phonetic_simple TEXT,
      phonetic_ipa TEXT,
      language_tag TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(employee_id)
    );
    CREATE INDEX IF NOT EXISTS ix_pronunciations_employee_id ON pronunciations(employee_id);
    CREATE INDEX IF NOT EXISTS ix_pronunciations_display_name ON pronunciations(display_name);
  `);
}

export function getVoiceboxDb(dbPath?: string): DatabaseSyncInstance {
  const resolved = resolveDatabasePath(dbPath);
  const existing = dbCache.get(resolved);
  if (existing) {
    return existing;
  }

  if (resolved !== ':memory:') {
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new DatabaseSync(resolved);
  initPronunciationsSchema(db);
  dbCache.set(resolved, db);
  return db;
}

export function closeVoiceboxDb(dbPath?: string): void {
  const resolved = resolveDatabasePath(dbPath);
  const db = dbCache.get(resolved);
  if (db) {
    try {
      db.close();
    } catch {
      // Ignored if already closed
    }
    dbCache.delete(resolved);
  }
}

export function closeAllVoiceboxDbs(): void {
  for (const [, db] of dbCache.entries()) {
    try {
      db.close();
    } catch {
      // Ignored if already closed
    }
  }
  dbCache.clear();
}

export interface SplitFullNameResult {
  firstName: string;
  lastName: string;
}

export function splitFullName(fullName: string): SplitFullNameResult {
  const trimmed = fullName.trim();
  if (!trimmed) {
    return { firstName: '', lastName: '' };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: '' };
  }
  const lastName = parts[parts.length - 1];
  const firstName = parts.slice(0, -1).join(' ');
  return { firstName, lastName };
}

function getRowString(row: RawTableRow, colName: string): string {
  const lower = colName.toLowerCase().replace(/_/g, '');
  if (lower === 'id') {
    return row.id !== undefined && row.id !== null ? String(row.id).trim() : '';
  }
  if (lower === 'userid') {
    const val = row.user_id ?? row.userId;
    return val !== undefined && val !== null ? String(val).trim() : '';
  }
  if (lower === 'employeeid') {
    const val = row.employee_id ?? row.employeeId;
    return val !== undefined && val !== null ? String(val).trim() : '';
  }
  if (lower === 'fullname') {
    const val = row.full_name ?? row.fullName;
    return val ? String(val).trim() : '';
  }
  if (lower === 'name') {
    return row.name ? String(row.name).trim() : '';
  }
  if (lower === 'firstname') {
    const val = row.first_name ?? row.firstName;
    return val ? String(val).trim() : '';
  }
  if (lower === 'lastname') {
    const val = row.last_name ?? row.lastName;
    return val ? String(val).trim() : '';
  }
  if (lower === 'displayname') {
    const val = row.display_name ?? row.displayName;
    return val ? String(val).trim() : '';
  }
  return '';
}

export function detectNamesFromApgbackup(dbPath?: string): VoiceboxDetectedName[] {
  const db = getVoiceboxDb(dbPath);
  const candidateTables = ['users', 'employees', 'attendees', 'staff'] as const;

  // SAFETY: Selecting existing candidate table names from sqlite_master
  const masterRows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'employees', 'attendees', 'staff')"
  ).all() as SqliteMasterRow[];

  const existingTables = new Set(masterRows.map((r) => String(r.name || '').toLowerCase()));
  const targetTable = candidateTables.find((t) => existingTables.has(t));
  if (!targetTable) {
    return [];
  }

  // SAFETY: Introspecting table columns via PRAGMA table_info on validated candidate table name
  const colRows = db.prepare(`PRAGMA table_info(${targetTable})`).all() as SqliteTableColumn[];
  const colMap = new Map<string, string>();
  for (const col of colRows) {
    const colName = String(col.name || '');
    colMap.set(colName.toLowerCase().replace(/_/g, ''), colName);
  }

  const idCol = ['userid', 'employeeid', 'id'].find((c) => colMap.has(c));
  const fullNameCol = ['fullname', 'name'].find((c) => colMap.has(c));
  const firstNameCol = ['firstname'].find((c) => colMap.has(c));
  const lastNameCol = ['lastname'].find((c) => colMap.has(c));
  const displayNameCol = ['displayname'].find((c) => colMap.has(c));

  // SAFETY: Selecting rows from validated candidate table name
  const rows = db.prepare(`SELECT * FROM ${targetTable}`).all() as RawTableRow[];
  const results: VoiceboxDetectedName[] = [];

  for (const row of rows) {
    const employeeId = idCol ? getRowString(row, colMap.get(idCol)!) : '';
    if (!employeeId) {
      continue;
    }

    if (employeeId.toUpperCase().startsWith('ADMIN_CARD')) {
      continue;
    }

    let fullName = fullNameCol ? getRowString(row, colMap.get(fullNameCol)!) : '';
    const explicitFirst = firstNameCol ? getRowString(row, colMap.get(firstNameCol)!) : '';
    const explicitLast = lastNameCol ? getRowString(row, colMap.get(lastNameCol)!) : '';

    if (!fullName && (explicitFirst || explicitLast)) {
      fullName = [explicitFirst, explicitLast].filter(Boolean).join(' ');
    }
    if (!fullName) {
      fullName = employeeId;
    }

    if (fullName.toUpperCase().startsWith('ADMIN_CARD')) {
      continue;
    }

    let firstName = explicitFirst;
    let lastName = explicitLast;
    if (!firstName && !lastName) {
      const split = splitFullName(fullName);
      firstName = split.firstName;
      lastName = split.lastName;
    } else if (!firstName) {
      firstName = splitFullName(fullName).firstName;
    } else if (!lastName) {
      lastName = splitFullName(fullName).lastName;
    }

    const explicitDisplay = displayNameCol ? getRowString(row, colMap.get(displayNameCol)!) : '';
    const existingDisplayName = explicitDisplay || fullName;

    results.push({
      employeeId,
      fullName,
      firstName,
      lastName,
      existingDisplayName,
    });
  }

  return results;
}

export function getPronunciationByEmployeeId(
  employeeId: string,
  dbPath?: string
): PronunciationRecord | null {
  const trimmed = employeeId.trim();
  if (!trimmed) {
    return null;
  }
  const db = getVoiceboxDb(dbPath);

  // SAFETY: Reading single pronunciation record by employee_id
  const row = db.prepare(
    'SELECT id, employee_id, display_name, phonetic_simple, phonetic_ipa, language_tag, notes, created_at, updated_at FROM pronunciations WHERE employee_id = ?'
  ).get(trimmed) as SqlitePronunciationRow | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id !== undefined && row.id !== null ? Number(row.id) : undefined,
    employeeId: row.employee_id ? String(row.employee_id) : '',
    displayName: row.display_name ? String(row.display_name) : null,
    phoneticSimple: row.phonetic_simple ? String(row.phonetic_simple) : null,
    phoneticIpa: row.phonetic_ipa ? String(row.phonetic_ipa) : null,
    languageTag: row.language_tag ? String(row.language_tag) : null,
    notes: row.notes ? String(row.notes) : null,
    createdAt: row.created_at ? String(row.created_at) : undefined,
    updatedAt: row.updated_at ? String(row.updated_at) : undefined,
  };
}

export function upsertPronunciation(
  employeeId: string,
  data: UpsertPronunciationRequest,
  dbPath?: string
): PronunciationRecord {
  const trimmedEmpId = employeeId.trim();
  if (!trimmedEmpId) {
    throw new Error('Employee ID is required');
  }
  const db = getVoiceboxDb(dbPath);
  const existing = getPronunciationByEmployeeId(trimmedEmpId, dbPath);

  let fallbackDisplayName: string | null = null;
  if (data.displayName === undefined && !existing?.displayName) {
    const detected = detectNamesFromApgbackup(dbPath).find((d) => d.employeeId === trimmedEmpId);
    if (detected) {
      fallbackDisplayName = detected.existingDisplayName || detected.fullName;
    }
  }

  const displayName = data.displayName !== undefined
    ? (data.displayName.trim() || null)
    : (existing?.displayName ?? fallbackDisplayName);

  const phoneticSimple = data.phoneticSimple !== undefined
    ? (data.phoneticSimple.trim() || null)
    : (existing?.phoneticSimple ?? null);

  const phoneticIpa = data.phoneticIpa !== undefined
    ? (data.phoneticIpa.trim() || null)
    : (existing?.phoneticIpa ?? null);

  const languageTag = data.languageTag !== undefined
    ? (data.languageTag.trim() || null)
    : (existing?.languageTag ?? null);

  const notes = data.notes !== undefined
    ? (data.notes.trim() || null)
    : (existing?.notes ?? null);

  const stmt = db.prepare(`
    INSERT INTO pronunciations (
      employee_id,
      display_name,
      phonetic_simple,
      phonetic_ipa,
      language_tag,
      notes,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_id) DO UPDATE SET
      display_name = excluded.display_name,
      phonetic_simple = excluded.phonetic_simple,
      phonetic_ipa = excluded.phonetic_ipa,
      language_tag = excluded.language_tag,
      notes = excluded.notes,
      updated_at = CURRENT_TIMESTAMP
  `);

  stmt.run(trimmedEmpId, displayName, phoneticSimple, phoneticIpa, languageTag, notes);

  const updated = getPronunciationByEmployeeId(trimmedEmpId, dbPath);
  if (!updated) {
    throw new Error(`Failed to retrieve pronunciation for employee ${trimmedEmpId}`);
  }
  return updated;
}

export function listVoiceboxNames(dbPath?: string): VoiceboxNameListItem[] {
  const db = getVoiceboxDb(dbPath);
  const detected = detectNamesFromApgbackup(dbPath);

  // SAFETY: Selecting all pronunciation records
  const pronRows = db.prepare(
    'SELECT id, employee_id, display_name, phonetic_simple, phonetic_ipa, language_tag, notes, created_at, updated_at FROM pronunciations'
  ).all() as SqlitePronunciationRow[];

  const pronMap = new Map<string, SqlitePronunciationRow>();
  for (const row of pronRows) {
    if (row.employee_id) {
      pronMap.set(String(row.employee_id), row);
    }
  }

  const seenIds = new Set<string>();
  const items: VoiceboxNameListItem[] = [];

  for (const d of detected) {
    seenIds.add(d.employeeId);
    const pron = pronMap.get(d.employeeId);
    const ipaStr = pron?.phonetic_ipa ? String(pron.phonetic_ipa).trim() : '';
    const simpleStr = pron?.phonetic_simple ? String(pron.phonetic_simple).trim() : '';
    const hasPronunciation = Boolean(ipaStr.length > 0 || simpleStr.length > 0);

    items.push({
      employeeId: d.employeeId,
      fullName: d.fullName,
      firstName: d.firstName,
      lastName: d.lastName,
      displayName: pron?.display_name ? String(pron.display_name).trim() : (d.existingDisplayName || d.fullName),
      hasPronunciation,
      phoneticSimple: pron?.phonetic_simple ? String(pron.phonetic_simple) : null,
      phoneticIpa: pron?.phonetic_ipa ? String(pron.phonetic_ipa) : null,
      languageTag: pron?.language_tag ? String(pron.language_tag) : null,
      notes: pron?.notes ? String(pron.notes) : null,
    });
  }

  for (const pron of pronRows) {
    const empId = pron.employee_id ? String(pron.employee_id) : '';
    if (empId && !seenIds.has(empId)) {
      const disp = pron.display_name ? String(pron.display_name) : empId;
      const split = splitFullName(disp);
      const ipaStr = pron.phonetic_ipa ? String(pron.phonetic_ipa).trim() : '';
      const simpleStr = pron.phonetic_simple ? String(pron.phonetic_simple).trim() : '';
      const hasPronunciation = Boolean(ipaStr.length > 0 || simpleStr.length > 0);

      items.push({
        employeeId: empId,
        fullName: disp,
        firstName: split.firstName,
        lastName: split.lastName,
        displayName: disp,
        hasPronunciation,
        phoneticSimple: pron.phonetic_simple ? String(pron.phonetic_simple) : null,
        phoneticIpa: pron.phonetic_ipa ? String(pron.phonetic_ipa) : null,
        languageTag: pron.language_tag ? String(pron.language_tag) : null,
        notes: pron.notes ? String(pron.notes) : null,
      });
    }
  }

  return items;
}

export function getAllVoiceboxPronunciations(dbPath?: string): VoiceboxPronunciationItem[] {
  const names = listVoiceboxNames(dbPath);
  return names.map((item) => ({
    employeeId: item.employeeId,
    displayName: item.displayName,
    fullName: item.fullName,
    phoneticSimple: item.phoneticSimple ?? null,
    phoneticIpa: item.phoneticIpa ?? null,
    languageTag: item.languageTag ?? null,
    notes: item.notes ?? null,
  }));
}

export function findPronunciationsByName(
  queryName: string,
  dbPath?: string
): VoiceboxPronunciationItem[] {
  const q = queryName.trim().toLowerCase();
  if (!q) {
    return [];
  }
  const all = getAllVoiceboxPronunciations(dbPath);

  const exact = all.filter(
    (item) =>
      item.displayName.toLowerCase() === q ||
      (item.fullName ? item.fullName.toLowerCase() === q : false)
  );
  if (exact.length > 0) {
    return exact;
  }

  const wordMatches = all.filter((item) => {
    const dispWords = item.displayName.toLowerCase().split(/\s+/);
    const fullWords = item.fullName ? item.fullName.toLowerCase().split(/\s+/) : [];
    return dispWords.includes(q) || fullWords.includes(q);
  });
  if (wordMatches.length > 0) {
    return wordMatches;
  }

  return all.filter((item) => {
    const dLower = item.displayName.toLowerCase();
    const fLower = item.fullName ? item.fullName.toLowerCase() : '';
    return dLower.includes(q) || fLower.includes(q);
  });
}
