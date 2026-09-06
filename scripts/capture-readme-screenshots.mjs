import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outputDir = path.join(rootDir, 'docs', 'screenshots');
fs.mkdirSync(outputDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendCdp(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 1000000);
  return new Promise((resolve, reject) => {
    const handler = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id === id) {
        ws.removeEventListener('message', handler);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function capture(ws, filename) {
  const res = await sendCdp(ws, 'Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outputDir, filename), Buffer.from(res.data, 'base64'));
  console.log(`saved docs/screenshots/${filename}`);
}

async function navigate(ws, url) {
  await sendCdp(ws, 'Page.navigate', { url });
  await sleep(1500);
}

async function click(ws, selector) {
  await sendCdp(ws, 'Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(selector)})?.click()`,
  });
  await sleep(800);
}

async function run() {
  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const port = 9334;
  const userDataDir = path.join(rootDir, 'temp_edge_readme_profile');
  const browser = spawn(edgePath, [
    `--remote-debugging-port=${port}`,
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1280,820',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ]);
  browser.stderr?.on('data', () => {});
  let wsUrl = '';
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      const data = await res.json();
      wsUrl = data.webSocketDebuggerUrl;
      if (wsUrl) break;
    } catch { /* retry */ }
  }
  if (!wsUrl) { browser.kill(); throw new Error('CDP connect failed'); }
  const newTargetRes = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  const newTarget = await newTargetRes.json();
  const pageWs = new WebSocket(newTarget.webSocketDebuggerUrl);
  await new Promise((res) => pageWs.addEventListener('open', res));
  await sendCdp(pageWs, 'Page.enable');
  await sendCdp(pageWs, 'Runtime.enable');
  await sendCdp(pageWs, 'Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
  });

  await navigate(pageWs, 'http://127.0.0.1:5173/');
  await capture(pageWs, 'kiosk.png');

  await click(pageWs, '[data-testid="kiosk-mode-bathroom"]');
  await sendCdp(pageWs, 'Runtime.evaluate', { expression: `document.dispatchEvent(new KeyboardEvent('keydown',{key:'2',bubbles:true}))` });
  await sleep(600);
  await capture(pageWs, 'bathroom-kiosk.png');

  await navigate(pageWs, 'http://127.0.0.1:5173/attendance');
  await capture(pageWs, 'live-attendance.png');

  await navigate(pageWs, 'http://127.0.0.1:5173/admin');
  await capture(pageWs, 'admin.png');

  pageWs.close();
  browser.kill();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  console.log('done');
}

run().catch((err) => { console.error('Error:', err); process.exit(1); });
