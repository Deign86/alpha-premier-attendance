import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outputDir = 'C:\\Users\\Deign\\Downloads\\alpha-premier-attendance-screenshots';

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

async function run() {
  console.log('Launching browser to capture UI/UX screenshots...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  let maleCheckedOut = false;
  let femaleCheckedOut = false;
  let logs = [];

  await page.route('**/api/config', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        office: {
          buildingName: 'Tektite East Tower',
          roomUnit: 'Unit 2104',
          streetAddress: 'Ortigas Center',
          city: 'Pasig City',
          metroArea: 'Metro Manila',
          country: 'Philippines',
          timezone: 'Asia/Manila',
        },
        timezone: 'Asia/Manila',
        enableCardSetup: true,
        enableAdmin: true,
        resultResetDelayMs: 6000,
      }),
    });
  });

  await page.route('**/api/bathroom/status', async (route) => {
    const maleActive = maleCheckedOut
      ? {
          logId: 'bath_log_male_1',
          userId: 'EMP-001',
          fullName: 'Juan Dela Cruz',
          department: 'Engineering',
          genderKey: 'MALE',
          timeOut: new Date(Date.now() - 4 * 60 * 1000 - 15 * 1000).toISOString(),
        }
      : null;

    const femaleActive = femaleCheckedOut
      ? {
          logId: 'bath_log_female_1',
          userId: 'EMP-002',
          fullName: 'Maria Santos',
          department: 'Operations',
          genderKey: 'FEMALE',
          timeOut: new Date(Date.now() - 1 * 60 * 1000 - 30 * 1000).toISOString(),
        }
      : null;

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        date: '2026-08-27',
        maleActive,
        femaleActive,
        maleLogs: logs.filter((l) => l.genderKey === 'MALE'),
        femaleLogs: logs.filter((l) => l.genderKey === 'FEMALE'),
        fetchedAt: new Date().toISOString(),
      }),
    });
  });

  await page.route('**/api/attendance/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        items: [
          {
            userId: 'EMP-001',
            fullName: 'Juan Dela Cruz',
            department: 'Engineering',
            employeeType: 'REGULAR',
            timeIn: '2026-08-27T08:02:15+08:00',
            timeOut: null,
            workMode: 'OFFICE',
          },
          {
            userId: 'EMP-002',
            fullName: 'Maria Santos',
            department: 'Operations',
            employeeType: 'REGULAR',
            timeIn: '2026-08-27T08:14:30+08:00',
            timeOut: null,
            workMode: 'OFFICE',
          },
        ],
      }),
    });
  });

  // 1. Load Kiosk in Attendance Mode (1)
  console.log('Navigating to Kiosk (Attendance Mode 1)...');
  await page.goto(`file://${path.join(rootDir, 'client/dist/index.html')}`);
  await page.waitForTimeout(500);

  const shot1 = path.join(outputDir, '01_kiosk_mode_1_attendance.png');
  await page.screenshot({ path: shot1, fullPage: true });
  console.log(`Saved: ${shot1}`);

  // 2. Switch to Mode 2 (Bathroom Key Log) via tab click or pressing "2"
  console.log('Switching to Mode 2 (Bathroom Key Log)...');
  await page.keyboard.press('2');
  await page.waitForTimeout(500);

  const shot2 = path.join(outputDir, '02_kiosk_mode_2_bathroom_available.png');
  await page.screenshot({ path: shot2, fullPage: true });
  console.log(`Saved: ${shot2}`);

  // 3. Simulate Male Key Checkout
  console.log('Simulating Male Key Checkout scan...');
  maleCheckedOut = true;
  logs.unshift({
    logId: 'bath_log_male_1',
    userId: 'EMP-001',
    fullName: 'Juan Dela Cruz',
    department: 'Engineering',
    genderKey: 'MALE',
    timeOut: new Date(Date.now() - 4 * 60 * 1000 - 15 * 1000).toISOString(),
    timeIn: null,
    durationMinutes: null,
    logDate: '2026-08-27',
    status: 'OUT',
  });

  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
  });
  await page.waitForTimeout(600);

  const shot3 = path.join(outputDir, '03_kiosk_bathroom_male_checked_out.png');
  await page.screenshot({ path: shot3, fullPage: true });
  console.log(`Saved: ${shot3}`);

  // 4. Simulate Female Key Checkout as well
  console.log('Simulating Female Key Checkout scan...');
  femaleCheckedOut = true;
  logs.unshift({
    logId: 'bath_log_female_1',
    userId: 'EMP-002',
    fullName: 'Maria Santos',
    department: 'Operations',
    genderKey: 'FEMALE',
    timeOut: new Date(Date.now() - 1 * 60 * 1000 - 30 * 1000).toISOString(),
    timeIn: null,
    durationMinutes: null,
    logDate: '2026-08-27',
    status: 'OUT',
  });

  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
  });
  await page.waitForTimeout(600);

  const shot4 = path.join(outputDir, '04_kiosk_bathroom_both_checked_out.png');
  await page.screenshot({ path: shot4, fullPage: true });
  console.log(`Saved: ${shot4}`);

  // 5. Simulate Male Key Return
  console.log('Simulating Male Key Return scan...');
  maleCheckedOut = false;
  logs[1] = {
    ...logs[1],
    timeIn: new Date().toISOString(),
    durationMinutes: 4,
    status: 'RETURNED',
  };

  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
  });
  await page.waitForTimeout(600);

  const shot5 = path.join(outputDir, '05_kiosk_bathroom_male_returned.png');
  await page.screenshot({ path: shot5, fullPage: true });
  console.log(`Saved: ${shot5}`);

  // 6. Switch back to Mode 1 (Attendance) via pressing "1"
  console.log('Switching back to Mode 1 (Attendance)...');
  await page.keyboard.press('1');
  await page.waitForTimeout(500);

  const shot6 = path.join(outputDir, '06_kiosk_mode_1_return_attendance.png');
  await page.screenshot({ path: shot6, fullPage: true });
  console.log(`Saved: ${shot6}`);

  // 7. Open Admin Panel -> Bathroom Key Log
  console.log('Navigating to Admin view...');
  await page.evaluate(() => {
    window.history.pushState({}, '', '/admin');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await page.waitForTimeout(500);

  // Unlock Admin
  const pinInput = page.locator('input[type="password"]');
  if (await pinInput.isVisible()) {
    await pinInput.fill('1234');
    await page.locator('button:has-text("Unlock admin")').click();
    await page.waitForTimeout(500);
  }

  // Switch to Bathroom Key Log tab in Admin
  const adminBathroomTab = page.locator('button:has-text("Bathroom Key Log")');
  if (await adminBathroomTab.isVisible()) {
    await adminBathroomTab.click();
    await page.waitForTimeout(500);
    const shot7 = path.join(outputDir, '07_admin_bathroom_key_log_workspace.png');
    await page.screenshot({ path: shot7, fullPage: true });
    console.log(`Saved: ${shot7}`);
  }

  await browser.close();
  console.log('All screenshots captured successfully in Downloads folder!');
}

run().catch((err) => {
  console.error('Error capturing screenshots:', err);
  process.exit(1);
});
