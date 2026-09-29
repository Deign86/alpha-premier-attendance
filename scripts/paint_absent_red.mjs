import fs from 'node:fs';
import path from 'node:path';
import { google } from 'file:///C:/Users/APG/Downloads/alpha-premier-attendance/node_modules/googleapis/build/src/index.js';
import { DateTime } from 'file:///C:/Users/APG/Downloads/alpha-premier-attendance/node_modules/luxon/build/es6/luxon.mjs';

const SPREADSHEET_ID = '1ncnrcZY3Zr8ce_YBQQqU4LiMP80gqcd9WHr8dzjE-wE';
const KEY_PATH = path.join(process.env.APPDATA, 'com.alphapremier.attendance', 'attendance-sheets-key.json');

export async function paintAbsentRed(dryRun = false) {
  const key = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
  const auth = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: 'sheets.properties(sheetId,title)',
  });

  const today = DateTime.fromISO('2026-09-28', { zone: 'Asia/Manila' }).startOf('day');
  const allRequests = [];
  const tabSummaries = [];

  for (const s of meta.data.sheets) {
    const title = s.properties.title;
    if (title === 'COPY OF TEMPLATE') continue;
    const sheetId = s.properties.sheetId;

    const res = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
      ranges: [`'${title.replace(/'/g, "''")}'!A:F`],
      fields: 'sheets.data.rowData.values(formattedValue,effectiveFormat.backgroundColor,userEnteredFormat.backgroundColor)',
    });

    const rows = res.data.sheets?.[0]?.data?.[0]?.rowData || [];
    const missingIndices = [];

    rows.forEach((r, idx) => {
      const cells = r.values || [];
      const dateVal = cells[0]?.formattedValue;
      if (!dateVal) return;

      let d = DateTime.fromFormat(dateVal, 'M/d/yyyy', { zone: 'Asia/Manila' });
      if (!d.isValid) {
        d = DateTime.fromFormat(dateVal, 'yyyy-MM-dd', { zone: 'Asia/Manila' });
      }
      if (!d.isValid) return;

      if (d >= today) return;
      if (d.weekday > 5) return; // 6=Sat, 7=Sun

      const b = (cells[1]?.formattedValue ?? '').trim();
      const c = (cells[2]?.formattedValue ?? '').trim();
      const dVal = (cells[3]?.formattedValue ?? '').trim();
      const e = (cells[4]?.formattedValue ?? '').trim();

      if (!b && !c && !dVal && !e) {
        const bg = cells[1]?.effectiveFormat?.backgroundColor || cells[1]?.userEnteredFormat?.backgroundColor;
        const isRed = bg && (bg.red ?? 0) > 0.8 && (bg.green ?? 0) < 0.2 && (bg.blue ?? 0) < 0.2;
        if (!isRed) {
          missingIndices.push(idx);
        }
      }
    });

    if (missingIndices.length === 0) {
      continue;
    }

    // Merge consecutive row indices into runs [start, endExcl]
    const runs = [];
    for (const idx of missingIndices) {
      const last = runs[runs.length - 1];
      if (last && last[1] === idx) {
        last[1] = idx + 1;
      } else {
        runs.push([idx, idx + 1]);
      }
    }

    const tabRequests = runs.map(([startRow, endRow]) => ({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: startRow,
          endRowIndex: endRow,
          startColumnIndex: 1,
          endColumnIndex: 5,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 1, green: 0, blue: 0 },
          },
        },
        fields: 'userEnteredFormat.backgroundColor',
      },
    }));

    allRequests.push(...tabRequests);
    tabSummaries.push({
      tab: title,
      sheetId,
      missingRowsCount: missingIndices.length,
      runsCount: runs.length,
      runs: runs.map(([s, e]) => `Rows ${s + 1}..${e}`),
    });
  }

  console.log(`Prepared ${allRequests.length} repeatCell requests across ${tabSummaries.length} tabs.`);
  console.log(JSON.stringify(tabSummaries, null, 2));

  if (!dryRun && allRequests.length > 0) {
    console.log('Applying batchUpdate to Google Sheets...');
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: allRequests },
    });
    console.log('batchUpdate successfully applied!');
  }

  return { tabSummaries, requestCount: allRequests.length };
}

// CLI runner
if (process.argv[1] && process.argv[1].endsWith('paint_absent_red.mjs')) {
  const dryRun = process.argv.includes('--dry-run');
  paintAbsentRed(dryRun).catch(err => {
    console.error('Error painting absent red:', err);
    process.exit(1);
  });
}
