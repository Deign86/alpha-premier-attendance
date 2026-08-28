import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outputDir = 'C:\\Users\\Deign\\Downloads\\alpha-premier-attendance-screenshots';

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

async function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

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

async function captureScreenshot(ws, filename) {
  const res = await sendCdp(ws, 'Page.captureScreenshot', { format: 'png', quality: 100 });
  const buffer = Buffer.from(res.data, 'base64');
  const targetPath = path.join(outputDir, filename);
  fs.writeFileSync(targetPath, buffer);
  console.log(`✓ Screenshot captured: ${targetPath}`);
}

async function run() {
  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const port = 9333;
  const userDataDir = path.join(rootDir, 'temp_edge_profile');

  console.log('Launching headless browser on port', port);
  const browser = spawn(edgePath, [
    `--remote-debugging-port=${port}`,
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1280,820',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ]);

  // Wait for remote debugging endpoint
  let wsUrl = '';
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      const data = await res.json();
      wsUrl = data.webSocketDebuggerUrl;
      if (wsUrl) break;
    } catch {
      /* retry */
    }
  }

  if (!wsUrl) {
    browser.kill();
    throw new Error('Failed to connect to browser CDP port');
  }

  console.log('Connected to browser CDP');
  // Create a new target page
  const newTargetRes = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  const newTarget = await newTargetRes.json();
  const pageWs = new WebSocket(newTarget.webSocketDebuggerUrl);

  await new Promise((res) => {
    pageWs.addEventListener('open', res);
  });

  await sendCdp(pageWs, 'Page.enable');
  await sendCdp(pageWs, 'Runtime.enable');
  await sendCdp(pageWs, 'Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 2,
    mobile: false,
  });

  const fileUrl = `file:///${path.join(rootDir, 'client/dist/index.html').replace(/\\/g, '/')}`;
  console.log('Navigating to Kiosk:', fileUrl);
  await sendCdp(pageWs, 'Page.navigate', { url: fileUrl });
  await sleep(1000);

  // 1. Kiosk in Attendance Mode (1)
  console.log('[1/7] Capturing Kiosk Mode 1 (Attendance Scanning)...');
  await captureScreenshot(pageWs, '01_kiosk_mode_1_attendance.png');

  // 2. Switch to Mode 2 (Bathroom Key Log) via clicking mode tab or pressing key "2"
  console.log('[2/7] Switching to Kiosk Mode 2 (Bathroom Key Log)...');
  await sendCdp(pageWs, 'Runtime.evaluate', {
    expression: `
      document.querySelector('[data-testid="kiosk-mode-bathroom"]')?.click();
    `,
  });
  await sleep(600);
  await captureScreenshot(pageWs, '02_kiosk_mode_2_bathroom_available.png');

  // 3. Simulate Male Key Checkout
  console.log('[3/7] Simulating Male Key RFID Checkout on Kiosk...');
  await sendCdp(pageWs, 'Runtime.evaluate', {
    expression: `
      // Simulate live Male key status transition to IN USE
      const view = document.querySelector('[data-testid="bathroom-kiosk-view"]');
      if (view) {
        // Trigger visual state update for checkout
        const maleCard = document.querySelector('[data-testid="bathroom-kiosk-card-male"]');
        if (maleCard) {
          maleCard.className = 'bathroom-kiosk-card gender-male is-in-use';
          const body = maleCard.querySelector('.bathroom-card-body');
          if (body) {
            body.innerHTML = \`
              <div class="active-holder-box">
                <div class="active-holder-header">
                  <div class="holder-avatar">JD</div>
                  <div class="holder-meta">
                    <p class="holder-label">Currently with</p>
                    <h4 class="holder-name">Juan Dela Cruz</h4>
                    <p class="holder-dept">EMP-001 · Engineering</p>
                  </div>
                </div>
                <div class="elapsed-timer-container">
                  <div class="elapsed-stat">
                    <svg class="lucide lucide-clock" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                    <span>Time Out: \${new Date().toLocaleTimeString()}</span>
                  </div>
                  <div class="elapsed-counter">
                    <strong>03m 42s</strong>
                  </div>
                </div>
              </div>
            \`;
          }
          const pill = maleCard.querySelector('.status-pill');
          if (pill) {
            pill.className = 'status-pill status-in-use';
            pill.textContent = 'IN USE';
          }
        }
      }
    `,
  });
  await sleep(400);
  await captureScreenshot(pageWs, '03_kiosk_bathroom_male_checked_out.png');

  // 4. Simulate Both Keys Checked Out
  console.log('[4/7] Simulating Both Male & Female Keys Checked Out...');
  await sendCdp(pageWs, 'Runtime.evaluate', {
    expression: `
      const femaleCard = document.querySelector('[data-testid="bathroom-kiosk-card-female"]');
      if (femaleCard) {
        femaleCard.className = 'bathroom-kiosk-card gender-female is-in-use';
        const body = femaleCard.querySelector('.bathroom-card-body');
        if (body) {
          body.innerHTML = \`
            <div class="active-holder-box">
              <div class="active-holder-header">
                <div class="holder-avatar" style="background:#ec4899;color:white;">MS</div>
                <div class="holder-meta">
                  <p class="holder-label">Currently with</p>
                  <h4 class="holder-name">Maria Santos</h4>
                  <p class="holder-dept">EMP-002 · Operations</p>
                </div>
              </div>
              <div class="elapsed-timer-container">
                <div class="elapsed-stat">
                  <svg class="lucide lucide-clock" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                  <span>Time Out: \${new Date().toLocaleTimeString()}</span>
                </div>
                <div class="elapsed-counter">
                  <strong>01m 15s</strong>
                </div>
              </div>
            </div>
          \`;
        }
        const pill = femaleCard.querySelector('.status-pill');
        if (pill) {
          pill.className = 'status-pill status-in-use';
          pill.textContent = 'IN USE';
        }
      }
    `,
  });
  await sleep(400);
  await captureScreenshot(pageWs, '04_kiosk_bathroom_both_checked_out.png');

  // 5. Simulate Key-in-use Conflict Scan Banner
  console.log('[5/7] Simulating Key In Use Conflict scan banner on Kiosk...');
  await sendCdp(pageWs, 'Runtime.evaluate', {
    expression: `
      const container = document.querySelector('[data-testid="bathroom-kiosk-view"]');
      if (container) {
        const banner = document.createElement('div');
        banner.className = 'bathroom-kiosk-scan-banner is-error';
        banner.innerHTML = \`
          <div class="bathroom-scan-error-layout">
            <svg class="bathroom-scan-error-icon" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <div>
              <span class="badge-conflict">KEY CURRENTLY IN USE</span>
              <h3 class="bathroom-scan-error-title" style="margin:4px 0 2px;">Male key is already checked out</h3>
              <p class="bathroom-scan-conflict-holder" style="margin:0;">Currently held by <strong>Juan Dela Cruz</strong> (Engineering) · Checked out 4m ago</p>
            </div>
          </div>
        \`;
        container.prepend(banner);
      }
    `,
  });
  await sleep(400);
  await captureScreenshot(pageWs, '05_kiosk_bathroom_key_in_use_conflict.png');

  // 6. Simulate Male Key Return with Duration in History
  console.log('[6/7] Simulating Key Return and History Log on Kiosk...');
  await sendCdp(pageWs, 'Runtime.evaluate', {
    expression: `
      const banner = document.querySelector('.bathroom-kiosk-scan-banner');
      if (banner) banner.remove();

      const maleCard = document.querySelector('[data-testid="bathroom-kiosk-card-male"]');
      if (maleCard) {
        maleCard.className = 'bathroom-kiosk-card gender-male is-available';
        const body = maleCard.querySelector('.bathroom-card-body');
        if (body) {
          body.innerHTML = \`
            <div class="available-prompt-box">
              <svg class="lucide lucide-key-round available-icon" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/></svg>
              <p class="available-main">Key is Available</p>
              <p class="available-sub">Tap male employee RFID card to check out</p>
            </div>
          \`;
        }
        const pill = maleCard.querySelector('.status-pill');
        if (pill) {
          pill.className = 'status-pill status-available';
          pill.textContent = 'AVAILABLE';
        }
      }

      // Add Return Scan banner
      const container = document.querySelector('[data-testid="bathroom-kiosk-view"]');
      if (container) {
        const retBanner = document.createElement('div');
        retBanner.className = 'bathroom-kiosk-scan-banner is-success';
        retBanner.innerHTML = \`
          <div class="bathroom-scan-success-layout">
            <div class="bathroom-scan-photo-fallback">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/></svg>
            </div>
            <div class="bathroom-scan-meta">
              <span class="badge-return">MALE KEY RETURNED</span>
              <h3 class="bathroom-scan-name">Juan Dela Cruz</h3>
              <p class="bathroom-scan-dept">EMP-001 · Engineering</p>
              <p class="bathroom-scan-time">Key returned · Total duration: <strong>4 mins</strong></p>
            </div>
          </div>
        \`;
        container.prepend(retBanner);

        // Update history table
        const historySection = container.querySelector('.bathroom-kiosk-history-section');
        if (historySection) {
          historySection.innerHTML = \`
            <div class="history-header">
              <h4>Today's Bathroom Key Activity</h4>
              <span class="history-count">1 entry today</span>
            </div>
            <table class="bathroom-history-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Key</th>
                  <th>Time Out</th>
                  <th>Time In</th>
                  <th>Duration</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><strong>Juan Dela Cruz</strong><span class="cell-dept">Engineering</span></td>
                  <td><span class="key-badge male">MALE</span></td>
                  <td>08:45 PM</td>
                  <td>08:49 PM</td>
                  <td><strong>4m</strong></td>
                  <td><span class="status-tag tag-returned">RETURNED</span></td>
                </tr>
              </tbody>
            </table>
          \`;
        }
      }
    `,
  });
  await sleep(400);
  await captureScreenshot(pageWs, '06_kiosk_bathroom_male_returned.png');

  // 7. Switch back to Attendance Mode 1 via tab button or key "1"
  console.log('[7/7] Switching back to Kiosk Mode 1 (Attendance)...');
  await sendCdp(pageWs, 'Runtime.evaluate', {
    expression: `
      document.querySelector('[data-testid="kiosk-mode-attendance"]')?.click();
    `,
  });
  await sleep(600);
  await captureScreenshot(pageWs, '07_kiosk_mode_1_return_attendance.png');

  pageWs.close();
  browser.kill();
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  console.log('\n======================================================');
  console.log('  ALL UI/UX SCREENSHOTS CAPTURED TO DOWNLOADS FOLDER  ');
  console.log(`  Location: ${outputDir}`);
  console.log('======================================================\n');
}

run().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
