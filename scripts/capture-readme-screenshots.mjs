// Captures README screenshots (1280x800) from the WEB stack using FAKE demo data only.
// Prereq: `SHEETS_MODE=memory node scripts/start-dev.mjs` (API :3001, Vite :5173).
// Usage:  node scripts/capture-readme-screenshots.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(rootDir, 'docs', 'screenshots');
const WEB = 'http://127.0.0.1:5173';
const API = 'http://127.0.0.1:3001';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP_PORT = 9334;
const TZ = 'Asia/Manila';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pin = fs.readFileSync(path.join(rootDir, 'credentials', 'rfid-attendance-admin-pin.txt'), 'utf8').trim();
fs.mkdirSync(outputDir, { recursive: true });

// ---------- demo data (fake names and card UIDs only) ----------
const DEMO = [
  ['Alex Rivera', 'MALE'], ['Sam Santos', 'FEMALE'], ['Jamie Cruz', 'MALE'],
  ['Taylor Reyes', 'FEMALE'], ['Jordan Dela Cruz', 'MALE'], ['Casey Mendoza', 'FEMALE'],
].map(([fullName, gender], i) => ({ userId: `DEMO-00${i + 1}`, rfidUid: `00990${i + 1}0000`, fullName, gender }));
const SCAN_USER = DEMO[5]; // scanned live through the kiosk UI

const manilaDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const ts = (date, t) => `${date}T${t}:00+08:00`;

async function seed() {
  const unlock = await fetch(`${API}/api/admin/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin }) });
  if (!unlock.ok) throw new Error(`admin unlock failed (${unlock.status})`);
  const cookie = unlock.headers.get('set-cookie').split(';')[0];
  const call = async (method, url, body) => {
    const r = await fetch(API + url, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    return { ok: r.ok, status: r.status, json: await r.json().catch(() => ({})) };
  };
  const today = manilaDate(new Date());
  const prev = [];
  for (let d = new Date(`${today}T00:00:00+08:00`); prev.length < 3;) {
    d = new Date(d.getTime() - 86400000);
    const dow = new Date(d.getTime() + 8 * 3600e3).getUTCDay();
    if (dow !== 0 && dow !== 6) prev.push(manilaDate(d));
  }
  for (const u of DEMO) {
    await call('POST', '/api/admin/users', { userId: u.userId, rfidUid: u.rfidUid, fullName: u.fullName, department: 'Interns', status: 'ACTIVE', employeeType: 'INTERN', gender: u.gender });
  }
  // previous weekdays: on time, late, half day, missing time-out, full day (409 on re-run = already seeded)
  const pat = [['08:55', '18:02'], ['09:20', '18:05'], ['08:58', '13:05'], ['09:00', null], ['09:45', '18:10'], ['08:50', '18:00']];
  for (const [di, date] of prev.entries()) {
    for (const [i, u] of DEMO.entries()) {
      const [a, b] = pat[(i + di) % pat.length];
      await call('POST', '/api/admin/attendance/backdate', { userId: u.userId, attendanceDate: date, timeIn: ts(date, a), timeOut: b ? ts(date, b) : null, reason: 'Demo data' });
    }
  }
  // today: scan once (skip if already scanned), then correct the times; keep SCAN_USER free for the live scan shot
  let rows = (await call('GET', `/api/admin/attendance?date=${today}`)).json.attendance ?? [];
  const scanRow = rows.find((r) => r.userId === SCAN_USER.userId);
  if (scanRow) await call('DELETE', `/api/admin/attendance/${scanRow.attendanceId}?date=${today}`);
  for (const u of DEMO.slice(0, 5)) {
    if (!rows.some((r) => r.userId === u.userId)) await call('POST', '/api/attendance/scan', { rfidUid: u.rfidUid, source: 'MANUAL_TEST' });
  }
  rows = (await call('GET', `/api/admin/attendance?date=${today}`)).json.attendance ?? [];
  const todayTimes = { 'DEMO-001': ['08:57', null], 'DEMO-002': ['09:25', null], 'DEMO-003': ['08:59', '13:02'], 'DEMO-004': ['10:05', null], 'DEMO-005': ['08:45', '18:01'] };
  for (const row of rows) {
    const t = todayTimes[row.userId];
    if (!t) continue;
    await call('PATCH', `/api/admin/attendance/${row.attendanceId}`, { attendanceDate: today, timeIn: ts(today, t[0]), timeOut: t[1] ? ts(today, t[1]) : null, expectedTimeIn: row.timeIn, expectedTimeOut: row.timeOut });
  }
  // bathroom key: one active checkout (male key)
  const bath = (await call('GET', '/api/admin/bathroom/status')).json;
  if (!JSON.stringify(bath).includes('"OUT"')) await call('POST', '/api/admin/bathroom/time-out', { userId: DEMO[0].userId, genderKey: 'MALE' });
  // one generated payroll cutoff for the first intern (replace on re-run)
  const cutoffs = (await call('GET', '/api/admin/payroll/cutoffs')).json.payroll ?? [];
  for (const c of cutoffs) if (c.status !== 'FINALIZED') await call('DELETE', `/api/admin/payroll/cutoffs/${c.payrollId}`);
  const month = prev[prev.length - 1].slice(0, 8);
  await call('POST', '/api/admin/payroll/cutoffs', { employeeId: DEMO[0].userId, cutoffStart: `${month}01`, cutoffEnd: `${month}15` });
}

// ---------- CDP helpers ----------
let ws;
let nextId = 1;
const pending = new Map();
function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed');
  return r.result.value;
};
async function waitFor(expression, label, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await evaluate(`Boolean(${expression})`).catch(() => false)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function goto(url, readyExpr, label) {
  await send('Page.navigate', { url });
  await waitFor(readyExpr, label);
}
const byText = (sel, text) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.trim().includes(${JSON.stringify(text)}))`;
const clickText = async (sel, text) => {
  await waitFor(byText(sel, text), `${sel} "${text}"`);
  await evaluate(`${byText(sel, text)}.click()`);
};
async function typeInto(selector, text) {
  await waitFor(`document.querySelector(${JSON.stringify(selector)})`, selector);
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await send('Input.insertText', { text });
}
async function shot(filename) {
  await sleep(350); // let transitions settle
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outputDir, filename), Buffer.from(r.data, 'base64'));
  console.log(`saved docs/screenshots/${filename}`);
}

async function run() {
  await seed();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-readme-'));
  const browser = spawn(EDGE, [`--remote-debugging-port=${CDP_PORT}`, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=1280,800', `--user-data-dir=${userDataDir}`, 'about:blank'], { stdio: 'ignore' });
  try {
    let wsUrl = '';
    for (let i = 0; i < 50 && !wsUrl; i++) {
      await sleep(300);
      wsUrl = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json()).then((t) => t.webSocketDebuggerUrl).catch(() => '');
    }
    if (!wsUrl) throw new Error('CDP connect failed');
    ws = new WebSocket(wsUrl);
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    });
    await new Promise((res) => ws.addEventListener('open', res));
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

    // kiosk idle
    await goto(`${WEB}/`, `document.querySelector('[data-testid="kiosk-manual-toggle"]') && !document.querySelector('[data-testid="kiosk-manual-toggle"]').disabled`, 'kiosk');
    await shot('kiosk.png');

    // kiosk scan success (manual entry of a seeded fake card)
    await evaluate(`document.querySelector('[data-testid="kiosk-manual-toggle"]').click()`);
    await typeInto('[data-testid="scanner-uid"]', SCAN_USER.rfidUid);
    await evaluate(`document.querySelector('[data-testid="kiosk-record-submit"]').click()`);
    await waitFor(`document.querySelector('[data-testid="kiosk-result-success"]')`, 'scan success card');
    await shot('kiosk-scan-success.png');

    // bathroom key mode with active checkout
    await goto(`${WEB}/`, `document.querySelector('[data-testid="kiosk-mode-bathroom"]')`, 'kiosk');
    await evaluate(`document.querySelector('[data-testid="kiosk-mode-bathroom"]').click()`);
    await waitFor(`document.body.innerText.includes(${JSON.stringify(DEMO[0].fullName)})`, 'bathroom checkout');
    await shot('bathroom-kiosk.png');

    // live attendance
    await goto(`${WEB}/attendance`, `document.body.innerText.includes(${JSON.stringify(DEMO[0].fullName)})`, 'live attendance rows');
    await shot('live-attendance.png');

    // admin locked + forgot PIN
    await goto(`${WEB}/admin`, byText('button', 'Forgot PIN?'), 'admin unlock');
    await shot('admin-unlock.png');
    await clickText('button', 'Forgot PIN?');
    await waitFor(`document.body.innerText.includes('Email reset code')`, 'forgot PIN panel');
    await shot('admin-forgot-pin.png');

    // admin unlocked (fresh load so the PIN panel state resets)
    await goto(`${WEB}/admin`, `document.querySelector('input[type="password"]')`, 'admin unlock form');
    await typeInto('input[type="password"]', pin);
    await clickText('button', 'Unlock admin');
    await waitFor(byText('.admin-tabs button', 'Attendance corrections'), 'admin tabs');

    await clickText('.admin-tabs button', 'Attendance corrections');
    await waitFor(`document.body.innerText.includes(${JSON.stringify(DEMO[0].fullName)})`, 'admin attendance rows');
    await shot('admin-attendance.png');

    await clickText('.admin-tabs button', 'Users and RFID');
    await waitFor(`document.body.innerText.includes(${JSON.stringify(DEMO[1].fullName)})`, 'admin users');
    await shot('admin-users.png');

    await clickText('.admin-tabs button', 'Payroll');
    await waitFor(`document.body.innerText.includes(${JSON.stringify(DEMO[0].fullName)})`, 'payroll workspace');
    await shot('admin-payroll.png');
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    spawnSync('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' });
    await sleep(500);
    try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* ignore */ }
  }
  console.log('done');
}

run().catch((err) => { console.error('Error:', err); process.exit(1); });
