import fs from 'node:fs';
import path from 'node:path';
import { google } from 'file:///C:/Users/APG/Downloads/alpha-premier-attendance/node_modules/googleapis/build/src/index.js';

const SPREADSHEET_ID = '1ncnrcZY3Zr8ce_YBQQqU4LiMP80gqcd9WHr8dzjE-wE';
const KEY_PATH = path.join(process.env.APPDATA, 'com.alphapremier.attendance', 'attendance-sheets-key.json');

function getSheetsClient() {
  if (!fs.existsSync(KEY_PATH)) {
    throw new Error(`Service account key not found at ${KEY_PATH}`);
  }
  const key = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
  const auth = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

export async function updateTabs(tabNames, dryRun = false) {
  const sheets = getSheetsClient();
  const summary = [];

  for (const tab of tabNames) {
    try {
      const quoted = `'${tab.replace(/'/g, "''")}'`;
      // Read current formulas in column F using open range F:F
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${quoted}!F:F`,
        valueRenderOption: 'FORMULA',
      });

      const rows = res.data.values || [];
      if (rows.length === 0) {
        summary.push({ tab, status: 'empty', replaced: 0 });
        continue;
      }

      let replacedCount = 0;
      const newValues = rows.map((r, idx) => {
        const row1 = idx + 1;
        const val = r[0];
        if (typeof val === 'string') {
          // Match =MIN(8,((C{r}-B{r})+(E{r}-D{r}))*24) or variations
          const minMatch = val.match(/^=MIN\(8,\s*\(?\(?C(\d+)-B\1\)?\s*\+\s*\(?E\1-D\1\)?\)?\*24\)$/i);
          if (minMatch) {
            const rowNum = minMatch[1];
            replacedCount++;
            return [`=MIN(8,CEILING(((C${rowNum}-B${rowNum})+(E${rowNum}-D${rowNum}))*24,1))`];
          }
          // Match Lorraine experimental formula: =IF(((C{r}-B{r})+(E{r}-D{r}))*24 <= 4, 4, MIN(8, ROUND(((C{r}-B{r})+(E{r}-D{r}))*24, 0)))
          const ifMatch = val.match(/^=IF\(\(\(C(\d+)-B\1\)\+\(E\1-D\1\)\)\*24\s*<=\s*4/i);
          if (ifMatch) {
            const rowNum = ifMatch[1];
            replacedCount++;
            return [`=MIN(8,CEILING(((C${rowNum}-B${rowNum})+(E${rowNum}-D${rowNum}))*24,1))`];
          }
        }
        return [val ?? ''];
      });

      if (replacedCount === 0) {
        summary.push({ tab, status: 'no_changes_needed', replaced: 0, totalRows: rows.length });
        continue;
      }

      if (!dryRun) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `${quoted}!F1:F${newValues.length}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: newValues },
        });

        // Verify formatted values in column F
        const verifyRes = await sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: `${quoted}!F:F`,
          valueRenderOption: 'FORMATTED_VALUE',
        });
        const verifyRows = verifyRes.data.values || [];
        const decimalRows = [];
        verifyRows.forEach((r, idx) => {
          const v = r[0];
          // Flag numbers with non-zero decimal part
          if (typeof v === 'string' && /^\d+\.\d+$/.test(v.trim())) {
            const num = parseFloat(v);
            if (num % 1 !== 0) {
              decimalRows.push({ row: idx + 1, value: v });
            }
          }
        });

        summary.push({
          tab,
          status: 'updated',
          replaced: replacedCount,
          totalRows: newValues.length,
          decimalRowsRemaining: decimalRows.length,
          sampleDecimals: decimalRows.slice(0, 3),
        });
      } else {
        summary.push({ tab, status: 'dry_run', replaced: replacedCount, totalRows: newValues.length });
      }
    } catch (err) {
      summary.push({ tab, status: 'error', error: err.message, replaced: 0 });
    }
  }

  return summary;
}

// CLI runner
if (process.argv[1] && process.argv[1].endsWith('update-dtr-tab-formulas.mjs')) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const tabs = args.filter(a => !a.startsWith('--'));

  if (tabs.length === 0) {
    console.error('Usage: node update-dtr-tab-formulas.mjs [--dry-run] "Tab 1" "Tab 2" ...');
    process.exit(1);
  }

  updateTabs(tabs, dryRun)
    .then(res => {
      console.log(JSON.stringify(res, null, 2));
    })
    .catch(err => {
      console.error('Error updating tabs:', err);
      process.exit(1);
    });
}
