const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9341;
const BASE_URL = 'http://localhost:5173';
const OUTPUT_DIR = 'C:/Users/Deign/.gemini/antigravity/brain/81786ffd-4c6a-4a9a-a89d-fe802a5572cb';

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + path.join(process.env.TEMP, 'cdp-profile-' + Date.now()),
  '--window-size=1440,900',
  '--hide-scrollbars',
  '--no-first-run',
  BASE_URL + '/admin',
], { stdio: 'ignore' });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

async function main() {
  let tabs = null;
  for (let i = 0; i < 40; i++) {
    try {
      tabs = await getJson(`http://localhost:${PORT}/json`);
      if (tabs && tabs.length) break;
    } catch (e) {}
    await wait(250);
  }
  if (!tabs || !tabs.length) { console.error('No tabs'); process.exit(1); }
  
  // Explicitly select the localhost page, NOT background extension page
  const page = tabs.find((t) => t.type === 'page' && t.url.includes('localhost')) || tabs.find((t) => t.type === 'page' && !t.url.startsWith('chrome'));
  if (!page) { console.error('Target page tab not found'); process.exit(1); }
  
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
  };
  await new Promise((resolve) => ws.onopen = resolve);
  await wait(2000);

  // Helper to take screenshot
  async function captureScreenshot(filename) {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    const buffer = Buffer.from(data, 'base64');
    const outPath = path.join(OUTPUT_DIR, filename);
    fs.writeFileSync(outPath, buffer);
    console.log(`Saved screenshot: ${outPath}`);
  }

  // 1. Admin login screen
  await captureScreenshot('admin_login_screen.png');

  // 2. Perform unlock via fetch and click button
  await send('Runtime.evaluate', {
    expression: `(() => {
      const input = document.querySelector('input[type="password"]');
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '293906');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const btn = document.querySelector('.submit-button') || document.querySelector('button[type="submit"]');
      if (btn) btn.click();
    })()`
  });
  await wait(2500);

  // 3. Admin unlocked Users tab
  await captureScreenshot('admin_users_and_rfid.png');

  // 4. Click Data and backup tab
  await send('Runtime.evaluate', {
    expression: `(() => {
      const dataTab = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Data and backup'));
      if (dataTab) dataTab.click();
    })()`
  });
  await wait(2000);
  await captureScreenshot('admin_data_and_backup_panel.png');

  // 5. Click Attendance corrections tab
  await send('Runtime.evaluate', {
    expression: `(() => {
      const attTab = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Attendance'));
      if (attTab) attTab.click();
    })()`
  });
  await wait(2000);
  await captureScreenshot('admin_attendance_records.png');

  // 6. Click Payroll tab
  await send('Runtime.evaluate', {
    expression: `(() => {
      const payrollTab = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Payroll'));
      if (payrollTab) payrollTab.click();
    })()`
  });
  await wait(2000);
  await captureScreenshot('admin_payroll_workspace.png');

  // 7. Kiosk main screen
  await send('Page.navigate', { url: BASE_URL + '/' });
  await wait(2000);
  await captureScreenshot('kiosk_main_screen.png');

  // 8. Live attendance view
  await send('Page.navigate', { url: BASE_URL + '/attendance' });
  await wait(2000);
  await captureScreenshot('live_attendance_view.png');

  ws.close();
  chrome.kill();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
