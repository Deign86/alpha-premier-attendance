import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { sheets_v4, drive_v3 } from 'googleapis';
import { GoogleSheetsAdapter } from '../src/sheets.js';

const HEADERS: Record<string, string[]> = {
  Users: ['user_id', 'rfid_uid', 'full_name', 'department', 'status', 'created_at', 'employee_type', 'daily_rate', 'photo_url', 'payroll_profile_id'],
  Attendance: ['attendance_id', 'attendance_date', 'user_id', 'rfid_uid', 'full_name', 'department', 'time_in', 'time_out', 'status', 'source', 'notes'],
  AuditLogs: ['log_id', 'timestamp', 'event_type', 'rfid_uid', 'user_id', 'message', 'request_id'],
  Payroll: ['payroll_id', 'attendance_id', 'user_id', 'full_name', 'employee_type', 'attendance_date', 'actual_time_in', 'actual_time_out', 'computed_time_in', 'computed_time_out', 'grace_used', 'late_hours', 'late_deduction', 'base_pay', 'daily_pay', 'notes'],
  InternGrace: ['grace_id', 'user_id', 'week_start', 'attendance_id', 'used_at'],
  PayrollProfiles: ['profile_id', 'label', 'payroll_frequency', 'standard_working_days_per_cutoff', 'incentives_allowance', 'special_allowance', 'special_holiday_multiplier', 'regular_holiday_multiplier', 'half_day_fraction', 'overtime_rate'],
  PayrollCutoffs: ['payroll_id', 'employee_id', 'employee_name', 'payroll_profile_id', 'payroll_cutoff_label', 'cutoff_start', 'cutoff_end', 'payroll_frequency', 'daily_rate', 'standard_working_days', 'actual_working_days', 'basic_pay', 'special_holiday_days', 'special_holiday_multiplier', 'special_holiday_pay', 'regular_holiday_days', 'regular_holiday_multiplier', 'regular_holiday_pay', 'incentives_allowance', 'special_allowance', 'total_compensation', 'total_allowance', 'late_units', 'late_deduction', 'half_day_count', 'half_day_deduction', 'absent_days', 'absence_deduction', 'overtime_hours', 'overtime_rate', 'overtime_pay', 'manual_adjustment', 'adjustment_reason', 'gross_compensation', 'net_pay', 'calculation_breakdown', 'approved_working_day_overage', 'status', 'finalized_at'],
};

const TITLES = Object.keys(HEADERS);

type StoredSheet = { title: string; sheetId: number; rows: string[][] };
type StoredSpreadsheet = { id: string; title: string; sheets: StoredSheet[]; nextSheetId: number };

function makeSheetsApi(seed?: { id: string; titles?: string[]; users?: string[][]; profiles?: string[][] }) {
  const spreadsheets = new Map<string, StoredSpreadsheet>();
  const calls = { creates: 0, batchUpdates: [] as unknown[][], gets: [] as string[], updates: [] as string[], appends: [] as string[] };

  function titleFromRange(range: string): string {
    const token = range.split('!')[0];
    return token.startsWith("'") && token.endsWith("'") ? token.slice(1, -1).replace(/''/g, "'") : token;
  }

  function getSpreadsheet(id: string): StoredSpreadsheet {
    const spreadsheet = spreadsheets.get(id);
    if (!spreadsheet) throw new Error(`missing spreadsheet ${id}`);
    return spreadsheet;
  }

  if (seed) {
    const sheets: StoredSheet[] = [];
    let nextSheetId = 1;
    for (const title of seed.titles ?? TITLES) {
      const rows = title === 'Users' && seed.users ? [HEADERS.Users, ...seed.users] : title === 'PayrollProfiles' && seed.profiles ? [HEADERS.PayrollProfiles, ...seed.profiles] : [HEADERS[title]];
      sheets.push({ title, sheetId: nextSheetId++, rows });
    }
    spreadsheets.set(seed.id, { id: seed.id, title: seed.id, sheets, nextSheetId });
  }

  const values = {
    get: async ({ spreadsheetId, range }: { spreadsheetId: string; range: string }) => {
      calls.gets.push(range);
      const spreadsheet = getSpreadsheet(spreadsheetId);
      const title = titleFromRange(range);
      const sheet = spreadsheet.sheets.find((item) => item.title === title);
      const rows = sheet ? sheet.rows : [];
      return { data: { values: range.endsWith('!1:1') ? rows.slice(0, 1) : rows } };
    },
    update: async ({ spreadsheetId, range, requestBody }: { spreadsheetId: string; range: string; requestBody: { values: string[][] } }) => {
      calls.updates.push(range);
      const spreadsheet = getSpreadsheet(spreadsheetId);
      const title = titleFromRange(range);
      const sheet = spreadsheet.sheets.find((item) => item.title === title);
      if (sheet) sheet.rows[0] = requestBody.values[0];
      return { data: {} };
    },
    append: async ({ spreadsheetId, range, requestBody }: { spreadsheetId: string; range: string; requestBody: { values: string[][] } }) => {
      calls.appends.push(range);
      const spreadsheet = getSpreadsheet(spreadsheetId);
      const title = titleFromRange(range);
      const sheet = spreadsheet.sheets.find((item) => item.title === title);
      if (sheet) sheet.rows.push(...requestBody.values);
      return { data: {} };
    },
  };

  const api = {
    spreadsheets: {
      get: async ({ spreadsheetId, fields }: { spreadsheetId: string; fields?: string }) => {
        const spreadsheet = getSpreadsheet(spreadsheetId);
        if (fields === 'spreadsheetId') return { data: { spreadsheetId } };
        return { data: { sheets: spreadsheet.sheets.map((sheet) => ({ properties: { sheetId: sheet.sheetId, title: sheet.title } })) } };
      },
      create: async ({ requestBody }: { requestBody: { properties: { title: string } } }) => {
        calls.creates += 1;
        const id = `sheet-${calls.creates}`;
        spreadsheets.set(id, { id, title: requestBody.properties.title, sheets: [], nextSheetId: 1 });
        return { data: { spreadsheetId: id } };
      },
      batchUpdate: async ({ spreadsheetId, requestBody }: { spreadsheetId: string; requestBody: { requests: Array<{ addSheet?: { properties: { title: string } } }> } }) => {
        calls.batchUpdates.push(requestBody.requests);
        const spreadsheet = getSpreadsheet(spreadsheetId);
        const replies = requestBody.requests.map((request) => {
          if (request.addSheet) {
            const sheet = { title: request.addSheet.properties.title, sheetId: spreadsheet.nextSheetId++, rows: [] };
            spreadsheet.sheets.push(sheet);
            return { addSheet: { properties: { sheetId: sheet.sheetId, title: sheet.title } } };
          }
          return {};
        });
        return { data: { replies } };
      },
      values,
    },
  };

  return { api: api as unknown as sheets_v4.Sheets, spreadsheets, calls };
}

function makeDriveApi(seedFolder?: { id: string; name: string }, seedParents?: Record<string, string[]>, getError?: unknown) {
  const folders = new Map<string, { id: string; name: string }>();
  const fileParents = new Map<string, string[]>(Object.entries(seedParents ?? {}));
  const calls = { creates: [] as string[], gets: [] as Array<{ fileId: string; supportsAllDrives?: boolean }>, updates: [] as Array<{ fileId: string; addParents?: string; removeParents?: string; supportsAllDrives?: boolean }> };

  if (seedFolder) folders.set(seedFolder.id, seedFolder);

  const api = {
    files: {
      get: async ({ fileId, fields, supportsAllDrives }: { fileId: string; fields?: string; supportsAllDrives?: boolean }) => {
        calls.gets.push({ fileId, supportsAllDrives });
        if (getError) throw getError;
        const folder = folders.get(fileId);
        if (folder) return { data: { id: fileId, mimeType: 'application/vnd.google-apps.folder' } };
        if (fileId.startsWith('sheet-') || fileId === 'sheet-1') {
          return { data: { id: fileId, parents: fileParents.get(fileId) ?? [] } };
        }
        throw Object.assign(new Error('not found'), { code: 404 });
      },
      create: async ({ requestBody }: { requestBody: { name: string; mimeType: string } }) => {
        calls.creates.push(requestBody.name);
        const id = `folder-${calls.creates.length}`;
        folders.set(id, { id, name: requestBody.name });
        return { data: { id } };
      },
      update: async (params: { fileId: string; addParents?: string; removeParents?: string; supportsAllDrives?: boolean }) => {
        calls.updates.push({ fileId: params.fileId, addParents: params.addParents, removeParents: params.removeParents, supportsAllDrives: params.supportsAllDrives });
        if (params.fileId && params.addParents) {
          const current = fileParents.get(params.fileId) ?? [];
          const next = current.filter((parent) => params.removeParents?.split(',').includes(parent) === false);
          if (!next.includes(params.addParents)) next.push(params.addParents);
          fileParents.set(params.fileId, next);
        }
        return { data: { id: params.fileId } };
      },
    },
  };

  return { api: api as unknown as drive_v3.Drive, folders, fileParents, calls };
}

const tempDirs: string[] = [];

function tempStateFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheets-drive-'));
  tempDirs.push(dir);
  return path.join(dir, 'state.json');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('GoogleSheetsAdapter Drive folder auto-create/reuse', () => {
  it('moves an existing spreadsheet into a verified folder and reconciles missing tabs', async () => {
    const sheets = makeSheetsApi({
      id: 'sheet-1',
      titles: ['Users'],
      users: [['u1', 'AABBCC11', 'Test User', 'Eng', 'ACTIVE', '2026-01-01T00:00:00+08:00', 'INTERN', '', '', '']],
    });
    const drive = makeDriveApi({ id: 'folder-1', name: 'Alpha Premier Attendance' });
    const stateFile = tempStateFile();

    const adapter = new GoogleSheetsAdapter(
      { spreadsheetId: 'sheet-1', driveFolderId: 'folder-1', stateFile },
      sheets.api,
      drive.api,
    );

    await expect(adapter.ensureSpreadsheet()).resolves.toBe('sheet-1');

    const moveCall = drive.calls.updates.find((call) => call.fileId === 'sheet-1' && call.addParents === 'folder-1');
    expect(moveCall).toMatchObject({ supportsAllDrives: true });
    expect(moveCall?.removeParents).toBeUndefined();
    expect(drive.calls.gets.every((call) => call.supportsAllDrives === true)).toBe(true);
    expect(sheets.calls.gets).toContain("'Users'!1:1");
    const addSheetCount = sheets.calls.batchUpdates
      .flat()
      .filter((request) => (request as { addSheet?: unknown }).addSheet).length;
    expect(addSheetCount).toBe(6);
    expect(sheets.calls.appends).toContain('PayrollProfiles');
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).toMatchObject({ driveFolderId: 'folder-1', spreadsheetId: 'sheet-1' });
  });

  it('creates the target folder when it is missing and persists the new ID', async () => {
    const sheets = makeSheetsApi({ id: 'sheet-1' });
    const drive = makeDriveApi();
    const stateFile = tempStateFile();

    const adapter = new GoogleSheetsAdapter(
      { spreadsheetId: 'sheet-1', driveFolderId: 'missing-folder', createFolderIfMissing: true, stateFile },
      sheets.api,
      drive.api,
    );

    await expect(adapter.ensureSpreadsheet()).resolves.toBe('sheet-1');
    expect(drive.calls.creates).toEqual(['Alpha Premier Attendance']);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).toMatchObject({ driveFolderId: 'folder-1', spreadsheetId: 'sheet-1' });
    expect(sheets.calls.creates).toBe(0);
  });

  it('propagates Drive permission failures instead of creating a duplicate folder', async () => {
    const sheets = makeSheetsApi({ id: 'sheet-1' });
    const drive = makeDriveApi(undefined, undefined, Object.assign(new Error('forbidden'), { code: 403 }));
    const adapter = new GoogleSheetsAdapter(
      { driveFolderId: 'folder-1', createFolderIfMissing: true, stateFile: tempStateFile() },
      sheets.api,
      drive.api,
    );

    await expect(adapter.ensureSpreadsheet()).rejects.toMatchObject({ code: 403 });
    expect(drive.calls.creates).toHaveLength(0);
    expect(sheets.calls.creates).toBe(0);
  });

  it('creates a spreadsheet in the folder and reuses both IDs from state on restart', async () => {
    const sheets = makeSheetsApi();
    const drive = makeDriveApi();
    const stateFile = tempStateFile();

    const first = new GoogleSheetsAdapter(
      { createFolderIfMissing: true, stateFile },
      sheets.api,
      drive.api,
    );

    await expect(first.ensureSpreadsheet()).resolves.toBe('sheet-1');
    expect(sheets.calls.creates).toBe(1);
    expect(drive.calls.creates).toEqual(['Alpha Premier Attendance']);

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(state).toMatchObject({ driveFolderId: 'folder-1', spreadsheetId: 'sheet-1' });

    const second = new GoogleSheetsAdapter(
      { createFolderIfMissing: true, stateFile },
      sheets.api,
      drive.api,
    );

    await expect(second.ensureSpreadsheet()).resolves.toBe('sheet-1');
    expect(sheets.calls.creates).toBe(1);
    expect(drive.calls.creates).toHaveLength(1);
  });
});
