// Launch Chrome headless with remote debugging, connect via CDP, and dump layout metrics.
const { spawn } = require('child_process');
const fs = require('fs');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const URL = process.argv[2] || 'http://localhost:5173/';

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=/tmp/cdp-profile-' + Date.now(),
  '--window-size=1440,900',
  '--hide-scrollbars',
  '--no-first-run',
  URL,
], { stdio: 'ignore' });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

async function main() {
  // Wait for the debugging endpoint
  let tabs = null;
  for (let i = 0; i < 40; i++) {
    try {
      tabs = await getJson(`http://localhost:${PORT}/json`);
      if (tabs && tabs.length) break;
    } catch (e) {}
    await wait(250);
  }
  if (!tabs || !tabs.length) { console.error('No tabs'); process.exit(1); }
  const page = tabs.find((t) => t.type === 'page');
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
  await wait(1500); // let the app render

  const expr = `(() => {
    const out = {};
    const pick = (el) => {
      if (!el) return null;
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName, cls: el.className,
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        display: s.display, gap: s.gap, padding: s.padding, margin: s.margin,
        fontSize: s.fontSize, lineHeight: s.lineHeight, border: s.borderRadius,
        background: s.backgroundColor, color: s.color,
      };
    };
    out.kioskStage = pick(document.querySelector('.kiosk-stage'));
    out.hero = pick(document.querySelector('.kiosk-hero'));
    out.heroIcon = pick(document.querySelector('.hero-icon'));
    out.h1 = pick(document.querySelector('.kiosk-hero h1'));
    out.heroSub = pick(document.querySelector('.hero-sub'));
    out.scanConsole = pick(document.querySelector('.scan-console'));
    out.scanConsoleHead = pick(document.querySelector('.scan-console-head'));
    out.scanTitle = pick(document.querySelector('.scan-console-title'));
    out.inputRow = pick(document.querySelector('.input-row'));
    out.scanIcon = pick(document.querySelector('.scan-input-icon'));
    out.input = pick(document.querySelector('.input-row input'));
    out.hint = pick(document.querySelector('.input-hint'));
    out.actions = pick(document.querySelector('.kiosk-actions'));
    out.actionButtons = [...document.querySelectorAll('.kiosk-action')].map(pick);
    out.topbar = pick(document.querySelector('.kiosk-topbar'));
    return out;
  })()`;

  const { result } = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log(JSON.stringify(result.value, null, 2));
  ws.close();
  chrome.kill();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
