import fs from 'node:fs';
import path from 'node:path';
import { google } from 'file:///C:/Users/APG/Downloads/alpha-premier-attendance/node_modules/googleapis/build/src/index.js';
import { DateTime } from 'file:///C:/Users/APG/Downloads/alpha-premier-attendance/node_modules/luxon/build/es6/luxon.mjs';

const SPREADSHEET_ID = '1ncnrcZY3Zr8ce_YBQQqU4LiMP80gqcd9WHr8dzjE-wE';
const KEY_PATH = path.join(process.env.APPDATA, 'com.alphapremier.attendance', 'attendance-sheets-key.json');

async function auditAbsent() {
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

  const pendingTabs = [];
  let totalMissingRedRows = 0;

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
    const missingRows = [];

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
          missingRows.push({
            row1Based: idx + 1,
            date: dateVal,
            weekday: d.weekdayLong,
          });
        }
      }
    });

    if (missingRows.length > 0) {
      pendingTabs.push({ tab: title, sheetId, count: missingRows.length, rows: missingRows });
      totalMissingRedRows += missingRows.length;
    }
  }

  console.log(`Tabs needing red absent marking: ${pendingTabs.length}`);
  console.log(`Total missing red rows across all tabs: ${totalMissingRedRows}`);
  pendingTabs.forEach(p => {
    console.log(`- ${p.tab} (${p.count} rows): dates ${p.rows[0].date} .. ${p.rows[p.rows.length - 1].date}`);
  });

  return pendingTabs;
}

auditAbsent().catch(console.error);
