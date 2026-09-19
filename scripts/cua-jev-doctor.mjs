#!/usr/bin/env node
// CUA+Tauri bridge pre-flight (read-only unless --fix).
// GATES G1 (CUA-JEV wave): CHECK: npm run doctor:mcp (+ this script --json for CUA side)
// EXPECT: exit 0 with bridge port 9223 responsive, or a clear offline report
// (liveBridge.active false / installed:false + ports false = contract-only, not live proof).
// Reuses `npm run doctor:mcp` for Tauri config checks — this file probes ONLY the
// CUA driver binary + TCP ports 5173/9223 and never duplicates doctor-tauri-mcp.mjs.
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
const doFix = args.has('--fix');

function tcpProbe(port, host = '127.0.0.1', timeoutMs = 1000) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(timeoutMs);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => { s.destroy(); resolve(false); });
    s.connect(port, host);
  });
}

async function tryRun(bin, argv, timeoutMs = 4000) {
  try {
    const { stdout } = await execFileAsync(bin, argv, { timeout: timeoutMs, windowsHide: true });
    return String(stdout || '').trim();
  } catch {
    return null;
  }
}

async function probeCua() {
  const versionRaw = await tryRun('cua-driver', ['--version']);
  if (versionRaw === null) return { installed: false, version: null, channel: 'unknown', detail: 'cua-driver not on PATH' };
  const m = versionRaw.match(/(\d+\.\d+\.\d+[^ \r\n]*)/);
  const version = m ? m[1] : versionRaw.split(/\r?\n/)[0].slice(0, 64);
  const channel = /beta|dev|nightly|preview/i.test(versionRaw) ? 'preview' : 'stable';
  // Best-effort liveness probes; never throw, never side-effect.
  const status = await tryRun('cua-driver', ['status']);
  const doctor = await tryRun('cua-driver', ['doctor']);
  const apps = await tryRun('cua-driver', ['call', 'list_apps']);
  return { installed: true, version, channel, reachable: status !== null, doctorOk: doctor !== null, appsSeen: apps !== null };
}

function runFix() {
  // Opt-in only: install driver via official script, then enable autostart.
  const installPs = 'irm https://cua.ai/driver/install.ps1 | iex';
  const child = spawn('powershell.exe', ['-NoProfile', '-Command', installPs], { stdio: 'inherit' });
  child.on('exit', (code) => {
    if (code !== 0) process.exit(code ?? 1);
    const auto = spawn('powershell.exe', ['-NoProfile', '-Command', 'cua-driver autostart --enable'], { stdio: 'inherit' });
    auto.on('exit', (c) => process.exit(c ?? 0));
  });
}

const [port5173, port9223] = await Promise.all([tcpProbe(5173), tcpProbe(9223)]);
const cua = await probeCua();
const report = {
  cua,
  tauri: { port5173, bridge9223: port9223, liveBridgeActive: port9223 },
  gates: 'G1 doctor:mcp exit 0 with 9223 responsive, else offline contract-only report',
  hint: cua.installed ? 'Tauri config: npm run doctor:mcp' : 'Install (opt-in): node scripts/cua-jev-doctor.mjs --fix',
};

if (doFix && !asJson) runFix();
else if (doFix && asJson) { console.log(JSON.stringify({ ...report, fix: 'rerun without --json to apply --fix' })); }
else if (asJson) console.log(JSON.stringify(report));
else {
  console.log('=== CUA-JEV Doctor (read-only) ===');
  console.log(`  cua-driver: ${cua.installed ? `installed ${cua.version} (${cua.channel})` : 'missing (installed:false)'}`);
  console.log(`  vite 127.0.0.1:5173: ${port5173 ? 'open' : 'closed'}`);
  console.log(`  bridge 127.0.0.1:9223: ${port9223 ? 'open' : 'closed'}`);
  console.log('  G1: npm run doctor:mcp for Tauri config (not duplicated here)');
  if (!cua.installed || !port9223) console.log('  offline contract-only report — not live proof');
}
process.exit(0);
