import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { google } from 'googleapis';

const SPREADSHEET_ID = '1ncnrcZY3Zr8ce_YBQQqU4LiMP80gqcd9WHr8dzjE-wE';
const SHEET_ID = 1860454512;
const REVERT_TAB = 'Khemuel Rosh Timkang';
const REVERT_RANGE = "'Khemuel Rosh Timkang'!B110";
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
      if (timeIn === null || timeIn <= 8 * 60 || timeIn > 9 * 60) continue;
      const week = weekStart(date);
      const isInWindowLate = timeIn <= 8 * 60 + 15;
      const priorLate = inWindowLateByWeek.get(week) ?? 0;
      if (isInWindowLate) inWindowLateByWeek.set(week, priorLate + 1);
      if (priorLate === 0) continue;
      if (title === REVERT_TAB && rowNumber === 110) continue;
      if (timeIn === 9 * 60) continue;
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
  let revertBatchUpdateResponse = null;
  let revertReadBack = null;
  let batchUpdateResponse = null;
  if (isWrite) {
    const revertTab = sheetTabs.find(({ properties }) => properties?.title === REVERT_TAB);
    if (!revertTab) throw new Error(`No tab found for ${REVERT_TAB}`);
    const current = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: REVERT_RANGE,
      valueRenderOption: 'FORMATTED_VALUE',
    });
    const currentValue = current.data.values?.[0]?.[0];
    if (currentValue === '09:00 AM' || currentValue === '9:00:00 AM') {
      const response = await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          valueInputOption: 'RAW',
          data: [{ range: REVERT_RANGE, values: [['10:00:00 AM']] }],
        },
      });
      revertBatchUpdateResponse = response.data;
    } else if (currentValue !== '10:00:00 AM') {
      throw new Error(`Unexpected value at ${REVERT_RANGE}: ${String(currentValue)}`);
    }
    const verify = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: REVERT_RANGE,
      valueRenderOption: 'FORMATTED_VALUE',
    });
    revertReadBack = verify.data.values?.[0]?.[0] ?? null;
    if (revertReadBack !== '10:00:00 AM') {
      throw new Error(`Revert verification failed at ${REVERT_RANGE}: ${String(revertReadBack)}`);
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
  }

  console.log(JSON.stringify({
    tabTitleForGid: focus.properties.title,
    tabsScanned,
    tabsScannedCount: tabsScanned.length,
    rowsScanned,
    revertedCell: isWrite ? { range: REVERT_RANGE, value: revertReadBack, batchUpdateResponse: revertBatchUpdateResponse } : null,
    editCount: edits.length,
    edits,
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
  const match = value.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)$/i);
  if (!match) return null;
  let hour = Number(match[1]) % 12;
  if (match[3].toUpperCase() === 'PM') hour += 12;
  return hour * 60 + Number(match[2]);
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
