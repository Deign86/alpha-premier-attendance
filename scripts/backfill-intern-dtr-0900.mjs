import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { google } from 'googleapis';

const SPREADSHEET_ID = '1ncnrcZY3Zr8ce_YBQQqU4LiMP80gqcd9WHr8dzjE-wE';
const SHEET_ID = 1880677918;
const KEY_NAME = 'attendance-sheets-key.json';

function getSheetsClient() {
  const candidates = [
    path.join(process.cwd(), 'credentials', KEY_NAME),
    path.join(process.env.APPDATA ?? '', 'com.alphapremier.attendance', KEY_NAME),
  ];
  const keyPath = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (keyPath) {
    const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    const auth = new google.auth.JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    return google.sheets({ version: 'v4', auth });
  }

  const accessToken = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.sheets({ version: 'v4', auth });
}

async function main() {
  const sheets = getSheetsClient();
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: 'sheets(properties(sheetId,title,gridProperties(rowCount)))',
  });
  const sheetTabs = metadata.data.sheets ?? [];
  const focus = sheetTabs.find(({ properties }) => properties?.sheetId === SHEET_ID);
  if (!focus?.properties?.title) throw new Error(`No tab found for gid ${SHEET_ID}`);
  const ranges = sheetTabs
    .filter(({ properties }) => properties?.title && properties.title !== 'Sheet2' && properties.title !== 'COPY OF TEMPLATE')
    .map(({ properties }) => {
      const title = properties?.title;
      if (!title) throw new Error('Found a sheet tab without a title');
      return `'${title.replaceAll("'", "''")}'!A1:F${properties.gridProperties?.rowCount ?? 1000}`;
    });
  const data = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: SPREADSHEET_ID,
    ranges,
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const valuesByRange = data.data.valueRanges ?? [];
  let rowsScanned = 0;
  const edits = [];
  const actualsKept = [];
  const tabsScanned = [];

  for (const [index, rangeData] of valuesByRange.entries()) {
    const tab = sheetTabs.filter(({ properties }) => properties?.title && properties.title !== 'Sheet2' && properties.title !== 'COPY OF TEMPLATE')[index];
    const title = tab?.properties?.title;
    if (!title) continue;
    const rows = rangeData.values ?? [];
    const datedRows = rows.flatMap((cells, rowIndex) => {
      const parsedDate = parseDate(cells[0]);
      return parsedDate
        ? [{ cells, rowNumber: rowIndex + 1, date: parsedDate }]
        : [];
    });
    if (datedRows.length === 0) continue;
    tabsScanned.push({ tab: title, rows: datedRows.length });
    rowsScanned += datedRows.length;
    const inWindowLateByWeek = new Map();
    datedRows.sort((left, right) => dateValue(left.date) - dateValue(right.date));
    for (const { cells, rowNumber, date } of datedRows) {
      const timeIn = parseTime(cells[1]);
      if (timeIn === null) continue;
      if (timeIn > 9 * 60 * 60) {
        actualsKept.push({
          tab: title,
          date: `${date.month}/${date.day}/${date.year}`,
          cell: `B${rowNumber}`,
          range: `'${title.replaceAll("'", "''")}'!B${rowNumber}`,
          value: cells[1],
        });
        continue;
      }
      if (timeIn <= 8 * 60 * 60) continue;
      const week = weekStart(date);
      const isInWindowLate = timeIn <= 8 * 60 * 60 + 15 * 60;
      const graceUsed = inWindowLateByWeek.get(week) ?? false;
      if (isInWindowLate && !graceUsed) {
        inWindowLateByWeek.set(week, true);
        continue;
      }
      if (timeIn === 9 * 60 * 60) continue;
      edits.push({
        tab: title,
        date: `${date.month}/${date.day}/${date.year}`,
        week,
        oldTimeIn: cells[1],
        newTimeIn: '09:00 AM',
        cell: `B${rowNumber}`,
        range: `'${title.replaceAll("'", "''")}'!B${rowNumber}`,
      });
    }
  }

  const isWrite = process.argv.includes('--write');
  let batchUpdateResponse = null;
  let readBack = [];
  let actualsKeptReadBack = [];
  if (actualsKept.length > 0 && (!isWrite || edits.length === 0)) {
    const verified = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: SPREADSHEET_ID,
      ranges: actualsKept.map(({ range }) => range),
      valueRenderOption: 'FORMATTED_VALUE',
    });
    actualsKeptReadBack = actualsKept.map((actual, index) => ({
      tab: actual.tab,
      date: actual.date,
      cell: actual.cell,
      value: verified.data.valueRanges?.[index]?.values?.[0]?.[0] ?? null,
    }));
    for (const [index, actual] of actualsKeptReadBack.entries()) {
      if (actual.value !== actualsKept[index].value) {
        throw new Error(`Actual-time verification failed at ${actual.tab}!${actual.cell}: ${String(actual.value)}`);
      }
    }
  }
  if (isWrite && edits.length > 0) {
    const response = await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        valueInputOption: 'RAW',
        data: edits.map(({ range }) => ({ range, values: [['09:00 AM']] })),
      },
    });
    batchUpdateResponse = response.data;
    const verified = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: SPREADSHEET_ID,
      ranges: [...edits.map(({ range }) => range), ...actualsKept.map(({ range }) => range)],
      valueRenderOption: 'FORMATTED_VALUE',
    });
    const values = verified.data.valueRanges ?? [];
    readBack = edits.map((edit, index) => ({
      tab: edit.tab,
      date: edit.date,
      cell: edit.cell,
      value: values[index]?.values?.[0]?.[0] ?? null,
    }));
    for (const cell of readBack) {
      if (cell.value !== '09:00 AM' && cell.value !== '9:00:00 AM') {
        throw new Error(`Write verification failed at ${cell.tab}!${cell.cell}: ${String(cell.value)}`);
      }
    }
    actualsKeptReadBack = actualsKept.map((actual, index) => ({
      tab: actual.tab,
      date: actual.date,
      cell: actual.cell,
      value: values[edits.length + index]?.values?.[0]?.[0] ?? null,
    }));
    for (const [index, actual] of actualsKeptReadBack.entries()) {
      if (actual.value !== actualsKept[index].value) {
        throw new Error(`Actual-time verification failed at ${actual.tab}!${actual.cell}: ${String(actual.value)}`);
      }
    }
  }

  console.log(JSON.stringify({
    tabTitleForGid: focus.properties.title,
    focusedTabRowsScanned: tabsScanned.find(({ tab }) => tab === focus.properties.title)?.rows ?? 0,
    tabsScanned,
    tabsScannedCount: tabsScanned.length,
    rowsScanned,
    editCount: edits.length,
    edits,
    readBack,
    actualsKept: actualsKeptReadBack,
    mode: isWrite ? 'write' : 'dry-run',
    batchUpdateResponse,
  }, null, 2));
}

function parseDate(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const [, month, day, year] = match;
  return { month: Number(month), day: Number(day), year: Number(year) };
}

function parseTime(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (!match) return null;
  let hour = Number(match[1]) % 12;
  if (match[4].toUpperCase() === 'PM') hour += 12;
  return hour * 60 * 60 + Number(match[2]) * 60 + Number(match[3] ?? 0);
}

function weekStart(date) {
  const monday = new Date(Date.UTC(date.year, date.month - 1, date.day));
  const weekday = monday.getUTCDay();
  monday.setUTCDate(monday.getUTCDate() - ((weekday + 6) % 7));
  return `${monday.getUTCFullYear()}-${String(monday.getUTCMonth() + 1).padStart(2, '0')}-${String(monday.getUTCDate()).padStart(2, '0')}`;
}

function dateValue(date) {
  return Date.UTC(date.year, date.month - 1, date.day);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
