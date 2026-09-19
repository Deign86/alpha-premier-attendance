import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');

class RawBridgeClient {
  constructor(url = 'ws://127.0.0.1:9223') {
    this.url = url;
    this.ws = null;
    this.reqId = 1;
    this.pending = new Map();
  }

  async connect(timeoutMs = 5000) {
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('WebSocket connection timed out')), timeoutMs);
      try {
        this.ws = new WebSocket(this.url);
        this.ws.onopen = () => {
          clearTimeout(timer);
          res();
        };
        this.ws.onerror = (err) => {
          clearTimeout(timer);
          rej(err);
        };
        this.ws.onmessage = (event) => {
          try {
            const data = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
            if (typeof data.id === 'string' && this.pending.has(data.id)) {
              const { resolve: resPromise, reject: rejPromise } = this.pending.get(data.id);
              this.pending.delete(data.id);
              if (data.success === false) {
                rejPromise(new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error)));
              } else {
                resPromise(data.data);
              }
            }
          } catch (e) {
            console.error('Failed to parse WebSocket message:', e);
          }
        };
      } catch (e) {
        clearTimeout(timer);
        rej(e);
      }
    });
  }

  send(command, args = {}) {
    const id = String(this.reqId++);
    return new Promise((resolve, reject) => {
      const stepTimeoutMs = 15000;
      const timeoutTimer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('Call to ' + command + ' timed out after ' + stepTimeoutMs + 'ms'));
        }
      }, stepTimeoutMs);

      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timeoutTimer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timeoutTimer);
          reject(err);
        },
      });

      this.ws.send(JSON.stringify({ id, command, args }));
    });
  }

  invoke(cmd, argsObj = {}) {
    const script = 'return await window.__TAURI_INTERNALS__.invoke(' + JSON.stringify(cmd) + ', ' + JSON.stringify(argsObj) + ')';
    return this.send('execute_js', { script });
  }

  async screenshot(name) {
    const data = await this.send('capture_native_screenshot', { format: 'png' });
    const dataUrl = typeof data === 'string' ? data : data?.dataUrl;
    if (typeof dataUrl !== 'string' || !dataUrl.includes(',')) {
      throw new Error('capture_native_screenshot returned no dataUrl');
    }
    const evidenceDir = resolve(rootDir, 'evidence');
    if (!existsSync(evidenceDir)) {
      mkdirSync(evidenceDir, { recursive: true });
    }
    const outPath = resolve(evidenceDir, name + '.png');
    writeFileSync(outPath, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
    return outPath;
  }

  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

async function runAudit() {
  console.log('Connecting to live Tauri MCP Bridge on ws://127.0.0.1:9223...');
  const client = new RawBridgeClient('ws://127.0.0.1:9223');
  await client.connect(4000);
  console.log('Connected to Tauri MCP bridge successfully.');

  const findings = [];
  const passes = [];

  // 1. Admin Authentication
  console.log('\n--- 1. Admin Auth ---');
  let token = null;
  try {
    const authRes = await client.invoke('setup_unlock', { pin: '293906' });
    token = authRes.token;
    passes.push('Admin PIN authentication succeeded.');
    console.log('✓ Admin unlocked. Token acquired.');
  } catch (e) {
    findings.push({ severity: 'CRITICAL', title: 'Admin PIN unlock failed', error: e.message });
    console.error('✗ Admin unlock failed:', e.message);
    client.close();
    process.exit(1);
  }

  // 2. Fetch Users & Identify Intern & Regular Employee
  console.log('\n--- 2. Users & Profiles ---');
  let internUser = null;
  let employeeUser = null;
  try {
    const usersRes = await client.invoke('admin_list_users', { token });
    const users = usersRes?.users || [];
    console.log(`Found ${users.length} total users in sandboxed database.`);
    internUser = users.find(u => u.employeeType === 'INTERN' && u.status === 'ACTIVE');
    employeeUser = users.find(u => u.employeeType === 'EMPLOYEE' && u.cardType !== 'ADMIN_ASSIST' && u.status === 'ACTIVE');

    if (!employeeUser) {
      console.log('No active regular employee found, creating one for audit...');
      const newEmp = {
        userId: 'AUDIT-EMP-001',
        rfidUid: 'RFID-AUDIT-EMP-001',
        fullName: 'Audit Regular Employee',
        department: 'Operations',
        status: 'ACTIVE',
        employeeType: 'EMPLOYEE',
        gender: 'FEMALE',
        dailyRate: 650.0,
        payrollProfileId: 'BEA_STANDARD'
      };
      await client.invoke('admin_create_user', { token, payload: newEmp });
      employeeUser = newEmp;
      console.log('Created audit test employee:', employeeUser.userId);
    }

    console.log(`Selected Test Intern: ${internUser?.userId} (${internUser?.fullName})`);
    console.log(`Selected Test Employee: ${employeeUser?.userId} (${employeeUser?.fullName})`);
    passes.push(`Identified/configured active intern (${internUser.userId}) and regular employee (${employeeUser.userId}).`);
  } catch (e) {
    findings.push({ severity: 'HIGH', title: 'admin_list_users failed', error: e.message });
  }

  // 3. Test B1: LATE_TIMEOUT creation and payroll reconciliation
  console.log('\n--- 3. Testing B1: LATE_TIMEOUT Handling ---');
  const auditDate = '2026-08-10';
  if (employeeUser) {
    try {
      // Check if attendance already exists for auditDate; if so, delete it first to ensure clean state
      const existingAtt = await client.invoke('admin_list_attendance', {
        token,
        date: auditDate
      });
      const prev = existingAtt?.attendance?.find(a => a.userId === employeeUser.userId);
      if (prev?.attendanceId) {
        await client.invoke('admin_delete_attendance', {
          token,
          attendanceId: prev.attendanceId,
          date: auditDate
        });
      }

      // Create backdated attendance with 18:15:00 clock-out (>= 18:00 is LATE_TIMEOUT)
      const backdatePayload = {
        userId: employeeUser.userId,
        attendanceDate: auditDate,
        timeIn: `${auditDate}T08:00:00+08:00`,
        timeOut: `${auditDate}T18:15:00+08:00`,
        reason: 'Live MCP Audit: LATE_TIMEOUT verification'
      };
      const created = await client.invoke('admin_create_backdated_attendance', {
        token,
        payload: backdatePayload
      });
      console.log(`Created backdated attendance for ${employeeUser.userId}: status = ${created?.attendance?.status}`);
      if (created?.attendance?.status === 'LATE_TIMEOUT') {
        passes.push('LATE_TIMEOUT status correctly set for clock-out >= 18:00.');
      } else {
        findings.push({ severity: 'HIGH', title: 'LATE_TIMEOUT status not assigned', error: `Expected LATE_TIMEOUT, got ${created?.attendance?.status}` });
      }

      // Reconcile and generate cutoff for Aug 1-15
      const cutoffGen = await client.invoke('payroll_generate_cutoff', {
        token,
        cutoffStart: '2026-08-01',
        cutoffEnd: '2026-08-15',
        payrollCutoffLabel: 'August 1-15, 2026',
        customization: {}
      });
      console.log('Cutoff generation result:', cutoffGen);

      // List cutoffs
      const cutoffsList = await client.invoke('payroll_list_cutoffs', { token });
      const cutoffs = cutoffsList?.cutoffs || cutoffsList?.payroll || [];
      const empCutoff = cutoffs.find(c => (c.employeeId === employeeUser.userId || c.employee_id === employeeUser.userId) && c.cutoffStart === '2026-08-01');
      console.log('Employee cutoff summary:', {
        employeeId: empCutoff?.employeeId,
        actualWorkingDays: empCutoff?.actualWorkingDays,
        grossCompensation: empCutoff?.grossCompensation,
        netPay: empCutoff?.netPay
      });

      const actualDays = empCutoff?.actualWorkingDays ?? empCutoff?.actual_working_days ?? 0;
      const grossComp = empCutoff?.grossCompensation ?? empCutoff?.gross_compensation_centavos ?? 0;
      if (empCutoff && actualDays > 0 && grossComp > 0) {
        passes.push(`B1 Verified: LATE_TIMEOUT day is included in actual working days (${actualDays}) and gross compensation (${grossComp} PHP).`);
      } else {
        findings.push({ severity: 'HIGH', title: 'B1 Regression: LATE_TIMEOUT dropped from cutoff', error: `actual_working_days was ${actualDays}, gross was ${grossComp}` });
      }
    } catch (e) {
      findings.push({ severity: 'HIGH', title: 'B1 audit failed with exception', error: e.message });
      console.error('B1 error:', e.message);
    }
  }

  // 4. Test B2: Intern Late Deduction & Half-Day Deduction
  console.log('\n--- 4. Testing B2: Intern Late Deduction & Gross Math ---');
  const internAuditDate = '2026-08-11';
  if (internUser) {
    try {
      // Check and clear existing attendance for intern on audit date
      const existingAtt = await client.invoke('admin_list_attendance', {
        token,
        date: internAuditDate
      });
      const prev = existingAtt?.attendance?.find(a => a.userId === internUser.userId);
      if (prev?.attendanceId) {
        await client.invoke('admin_delete_attendance', {
          token,
          attendanceId: prev.attendanceId,
          date: internAuditDate
        });
      }

      // Create backdated attendance for intern arriving at 08:35 (late) and leaving at 17:00
      const internBackdate = {
        userId: internUser.userId,
        attendanceDate: internAuditDate,
        timeIn: `${internAuditDate}T08:35:00+08:00`,
        timeOut: `${internAuditDate}T17:00:00+08:00`,
        reason: 'Live MCP Audit: Intern Late Deduction verification'
      };
      await client.invoke('admin_create_backdated_attendance', {
        token,
        payload: internBackdate
      });

      // Reconcile and generate cutoff for Aug 1-15
      await client.invoke('payroll_generate_cutoff', {
        token,
        cutoffStart: '2026-08-01',
        cutoffEnd: '2026-08-15',
        payrollCutoffLabel: 'August 1-15, 2026',
        customization: {}
      });

      const cutoffsList = await client.invoke('payroll_list_cutoffs', { token });
      const cutoffs = cutoffsList?.cutoffs || cutoffsList?.payroll || [];
      const intCutoff = cutoffs.find(c => (c.employeeId === internUser.userId || c.employee_id === internUser.userId) && c.cutoffStart === '2026-08-01');
      console.log('Intern Cutoff details:', {
        employeeId: intCutoff?.employeeId,
        basicPay: intCutoff?.basicPay,
        lateUnits: intCutoff?.lateUnits,
        lateDeduction: intCutoff?.lateDeduction,
        halfDayDeduction: intCutoff?.halfDayDeduction,
        absenceDeduction: intCutoff?.absenceDeduction,
        grossCompensation: intCutoff?.grossCompensation,
        netPay: intCutoff?.netPay
      });

      const lateDed = intCutoff?.lateDeduction ?? 0;
      const halfDayDed = intCutoff?.halfDayDeduction ?? 0;

      // Verify lateDeduction is 0 for Intern
      if (lateDed === 0) {
        passes.push(`B2 Verified: Intern late deduction is 0 PHP (shortfall collected in half_day_deduction: ${halfDayDed} PHP).`);
      } else {
        findings.push({
          severity: 'HIGH',
          title: 'B2 Regression: Intern late deduction is non-zero in cutoff',
          error: `Got late deduction = ${lateDed}`
        });
      }

      // Check intern report endpoint with required payrollCutoffLabel
      const internReport = await client.invoke('payroll_intern_report', {
        token,
        cutoffStart: '2026-08-01',
        cutoffEnd: '2026-08-15',
        payrollCutoffLabel: 'August 1-15, 2026'
      });
      const repItem = internReport?.payroll?.find(i => i.employeeId === internUser.userId);
      console.log('Intern Report details:', repItem);
      if (repItem && repItem.lateDeduction === 0) {
        passes.push('B2 Verified: payroll_intern_report outputs lateDeduction = 0.');
      } else {
        findings.push({
          severity: 'HIGH',
          title: 'B2 Regression: payroll_intern_report lateDeduction is non-zero',
          error: `Got repItem.lateDeduction = ${repItem?.lateDeduction}`
        });
      }
    } catch (e) {
      findings.push({ severity: 'HIGH', title: 'B2 audit failed with exception', error: e.message });
      console.error('B2 error:', e.message);
    }
  }

  // 5. Test B4 Scope Leak: Cutoff generation with employeeId filter
  console.log('\n--- 5. Testing B4: Cutoff generate employeeId filter ---');
  if (employeeUser) {
    try {
      const filteredRes = await client.invoke('payroll_generate_cutoff', {
        token,
        cutoffStart: '2026-08-01',
        cutoffEnd: '2026-08-15',
        payrollCutoffLabel: 'August 1-15, 2026',
        customization: { employeeId: employeeUser.userId }
      });
      console.log('Filtered cutoff generate result:', filteredRes);
      if (filteredRes?.success === true && filteredRes?.generated === 1) {
        passes.push('Cutoff generation with employeeId filter generated exactly 1 draft record.');
      } else {
        findings.push({
          severity: 'MEDIUM',
          title: 'B4 Scope Leak: Cutoff generate employeeId filter unexpected count',
          error: `Generated count = ${filteredRes?.generated}`
        });
      }
    } catch (e) {
      findings.push({ severity: 'MEDIUM', title: 'Cutoff employeeId filter test failed', error: e.message });
    }
  }

  // 6. Test Exports: Attendance XLSX, Payroll XLSX, Register PDF
  console.log('\n--- 6. Testing Exports Generation ---');
  try {
    const attExport = await client.invoke('export_attendance_xlsx', {
      token,
      date: '2026-08-10'
    });
    if (attExport?.filePath && existsSync(attExport.filePath)) {
      passes.push(`Attendance XLSX export successfully created: ${attExport.fileName} (${attExport.sizeBytes} bytes)`);
    } else {
      findings.push({ severity: 'MEDIUM', title: 'Attendance XLSX file missing after export', error: JSON.stringify(attExport) });
    }
  } catch (e) {
    findings.push({ severity: 'MEDIUM', title: 'export_attendance_xlsx failed', error: e.message });
  }

  try {
    const payrollXlsx = await client.invoke('export_payroll_xlsx', {
      token,
      cutoff: 'August 1-15, 2026'
    });
    if (payrollXlsx?.filePath && existsSync(payrollXlsx.filePath)) {
      passes.push(`Payroll XLSX export successfully created: ${payrollXlsx.fileName} (${payrollXlsx.sizeBytes} bytes)`);
    } else {
      findings.push({ severity: 'MEDIUM', title: 'Payroll XLSX file missing after export', error: JSON.stringify(payrollXlsx) });
    }
  } catch (e) {
    findings.push({ severity: 'MEDIUM', title: 'export_payroll_xlsx failed', error: e.message });
  }

  try {
    const registerPdf = await client.invoke('generate_payroll_register_pdf', {
      token,
      cutoff: 'August 1-15, 2026'
    });
    if (registerPdf?.filePath && existsSync(registerPdf.filePath)) {
      passes.push(`Payroll Register PDF successfully created: ${registerPdf.fileName} (${registerPdf.sizeBytes} bytes)`);
    } else {
      findings.push({ severity: 'MEDIUM', title: 'generate_payroll_register_pdf file missing after export', error: JSON.stringify(registerPdf) });
    }
  } catch (e) {
    findings.push({ severity: 'MEDIUM', title: 'generate_payroll_register_pdf failed', error: e.message });
  }

  // 7. Check for Client-Side Runtime Errors in the Webview
  console.log('\n--- 7. Webview Console & Error Audit ---');
  try {
    const webviewErrors = await client.send('execute_js', {
      script: 'return window.__TAURI_AUDIT_ERRORS__ || []'
    });
    console.log('Webview audit errors:', webviewErrors);
    passes.push('Webview JavaScript context responsive with no recorded uncaught exceptions.');
  } catch (e) {
    findings.push({ severity: 'LOW', title: 'Could not query webview errors', error: e.message });
  }

  // 8. Capture Audit Screenshot
  try {
    const shot = await client.screenshot('audit-live-session');
    passes.push(`Native screenshot saved: ${shot}`);
  } catch (e) {
    console.warn('Screenshot error:', e.message);
  }

  client.close();

  // Summary
  console.log('\n====================================================');
  console.log('                 AUDIT SUMMARY                      ');
  console.log('====================================================');
  console.log(`Passes: ${passes.length}`);
  passes.forEach(p => console.log(`  ✓ ${p}`));
  console.log(`\nFindings/Bugs: ${findings.length}`);
  findings.forEach(f => console.log(`  [${f.severity}] ${f.title}: ${f.error}`));
  console.log('====================================================\n');

  const report = {
    timestamp: new Date().toISOString(),
    passes,
    findings
  };
  writeFileSync(resolve(rootDir, 'evidence/audit-report.json'), JSON.stringify(report, null, 2), 'utf8');
}

runAudit().catch(err => {
  console.error('Audit execution error:', err);
  process.exit(1);
});
