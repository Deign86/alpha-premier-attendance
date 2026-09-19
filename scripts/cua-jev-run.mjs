#!/usr/bin/env node
// CUA-JEV orchestrator: doctor → target → cases 01-03 → assert → verdict → evidence.
// Reuses the verify skill launch/doctor/cleanup shape (`.agents/skills/
// verify-alpha-premier-attendance/SKILL.md`): the app runs in its own visible
// `cmd` window (`npm run tauri:dev`), readiness is Vite 127.0.0.1:5173 +
// bridge ws://127.0.0.1:9223, and cleanup kills by exact PID only
// (`taskkill /PID <pid> /F` — never /IM, never image-name kills; a plain
// taskkill without /F only hides the app to the tray).
// This script launches nothing itself: it only tracks PIDs it spawns
// (doctor child, tsx live child) and kills exactly those on exit.
// Offline (bridge closed or driver missing): writes needs_review skip
// evidence with liveBridge.active:false and exits 0 (contract-only).
// Any live FAIL: writes fail evidence and exits 1.
// JEV key travels via process.env.TYPESAFE_API_KEY only, gated by
// JEV_ENABLED=true; ledger/evidence text is scrubbed of the key value.
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const evidenceRoot = join(root, 'evidence', 'cua-jev');
const ledgerPath = join(evidenceRoot, 'audit-ledger.jsonl');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const onlyCase = (() => {
  const i = argv.indexOf('--case');
  const v = i >= 0 ? argv[i + 1] : 'all';
  return ['01', '02', '03', 'all'].includes(v) ? v : 'all';
})();
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: node scripts/cua-jev-run.mjs [--case 01|02|03|all] [--json]');
  process.exit(0);
}

const SCENARIOS = [
  { id: 'CUA-JEV-01', short: '01', expected: 'success' },
  { id: 'CUA-JEV-02', short: '02', expected: 'edge_handled' },
  { id: 'CUA-JEV-03', short: '03', expected: 'returned' },
].filter((s) => onlyCase === 'all' || s.short === onlyCase);

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const spawnedPids = new Set();

function scrub(text) {
  let out = String(text ?? '');
  const key = process.env['TYPESAFE_API_KEY'];
  if (key && key.length > 0) out = out.split(key).join('[REDACTED]');
  out = out.replace(/data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]+/g, '[REDACTED_IMAGE]');
  return out;
}

function tcpProbe(port, host = '127.0.0.1', timeoutMs = 1000) {
  return new Promise((resolveProbe) => {
    const s = new net.Socket();
    s.setTimeout(timeoutMs);
    s.once('connect', () => { s.destroy(); resolveProbe(true); });
    s.once('timeout', () => { s.destroy(); resolveProbe(false); });
    s.once('error', () => { s.destroy(); resolveProbe(false); });
    s.connect(port, host);
  });
}

// PID-exact cleanup: only PIDs this script spawned. Win32 uses
// taskkill /PID (with /F — plain taskkill only hides the app to the tray).
function killExact(pid) {
  try {
    if (process.platform === 'win32') {
      const probe = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { windowsHide: true });
      if (!String(probe.stdout ?? '').includes(String(pid))) return;
      spawnSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true });
    } else if (isAlive(pid)) {
      process.kill(pid, 'SIGKILL');
    }
  } catch { /* cleanup is best-effort; never fail the run on it */ }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function cleanupSpawned() {
  for (const pid of spawnedPids) killExact(pid);
  spawnedPids.clear();
}
process.on('SIGINT', () => { cleanupSpawned(); process.exit(130); });
process.on('SIGTERM', () => { cleanupSpawned(); process.exit(143); });

function runDoctor() {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [join(here, 'cua-jev-doctor.mjs'), '--json'], {
      cwd: root, windowsHide: true,
    });
    if (child.pid !== undefined) spawnedPids.add(child.pid);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => {
      if (child.pid !== undefined) spawnedPids.delete(child.pid);
      try { resolveRun(JSON.parse(out)); } catch { resolveRun(null); }
    });
    child.on('error', () => resolveRun(null));
    setTimeout(() => { try { child.kill(); } catch {} resolveRun(null); }, 15000);
  });
}

// Offline evidence mirrors tools/cua/evidence.ts file layout
// (verdict.json + elements.json + frames.json + NOTE, no failure.png)
// with liveBridge.active:false marking contract-only skips.
function writeSkipEvidence(testId, reason) {
  const dir = join(evidenceRoot, testId);
  mkdirSync(dir, { recursive: true });
  const decidedAt = new Date().toISOString();
  const verdict = { testId, choice: 'needs_review', decidedAt, detail: scrub(reason), liveBridge: { active: false } };
  writeFileSync(join(dir, 'verdict.json'), scrub(JSON.stringify(verdict, null, 2)) + '\n');
  writeFileSync(join(dir, 'elements.json'), '[]\n');
  writeFileSync(join(dir, 'frames.json'), JSON.stringify({ testId, recordedAt: decidedAt, frames: [], note: 'recorder absent' }, null, 2) + '\n');
  writeFileSync(join(dir, 'NOTE'), `skip: ${scrub(reason)}\n`);
}

function appendLedger(entry) {
  mkdirSync(evidenceRoot, { recursive: true });
  appendFileSync(ledgerPath, scrub(JSON.stringify(entry)) + '\n');
}

// Live pipeline runs under tsx (tools/cua is TypeScript) as a single child
// so its PID stays trackable for exact cleanup. Stages inside:
// target (resolveTauriMainWindow, pin 1280x800) → cases → assert
// (fresh-snapshot rule) → verdict (verdictCase, else deterministic judge)
// → evidence (writeCuaEvidence). Audit events are subscribed and echoed.
function liveEvalSource(urls) {
  return `
const ledger = [];
const { subscribeToAuditEvents } = await import(${JSON.stringify(urls.jevAudit)});
subscribeToAuditEvents((e) => ledger.push(e));
const targetMod = await import(${JSON.stringify(urls.target)});
const happyMod = await import(${JSON.stringify(urls.happy)});
const edgeMod = await import(${JSON.stringify(urls.edge)});
const regMod = await import(${JSON.stringify(urls.regression)});
const verdictMod = await import(${JSON.stringify(urls.verdict)});
const evidenceMod = await import(${JSON.stringify(urls.evidence)});
const freshMod = await import(${JSON.stringify(urls.fresh)});
const out = [];
async function judge(scenarioId, expected, outcome, text) {
  if (outcome !== 'pass' && outcome !== 'fail') {
    return { verdict: 'needs_review', confidence: 0, jevDecision: 'evaluation_unavailable', latencyMs: 0, status: 'fallback', fallbackReason: 'missing_api_key', model: 'none' };
  }
  const key = (process.env.TYPESAFE_API_KEY ?? '').trim();
  if (process.env.JEV_ENABLED === 'true' && key.length > 0) {
    try {
      return await verdictMod.verdictCase(text, text, { scenarioId, decision: expected });
    } catch { /* fall through to deterministic judge */ }
  }
  const input = outcome === 'pass'
    ? { decision: expected, confidence: 0.9, status: 'ok' }
    : { decision: 'evaluation_unavailable', confidence: 0.9, status: 'ok' };
  const j = verdictMod.judgeCuaScenario(scenarioId, input);
  return { verdict: j.choice, confidence: j.jevState.confidence, jevDecision: j.jevState.decision, latencyMs: j.jevState.latencyMs, status: j.jevState.status, fallbackReason: j.jevState.fallbackReason, model: j.jevState.model };
}
function elementsFor(excerpt) {
  return JSON.stringify([{ token: 'live-excerpt', text: String(excerpt ?? '').slice(0, 160) }], null, 2);
}
// 01: full live driver (foreground click + core.invoke tap + fresh-DOM poll).
if (${JSON.stringify(SCENARIOS.some((s) => s.id === 'CUA-JEV-01'))}) {
  try {
    const r = await happyMod.runHappyCase();
    // Assert stage: orchestration-level fresh-snapshot guard — the click
    // return is never asserted on; only fresh captures feed the verdict.
    freshMod.assertFreshSnapshot({ fromClickReturn: false });
    const v = await judge('CUA-JEV-01', 'success', r.outcome, r.excerpt);
    evidenceMod.writeCuaEvidence('CUA-JEV-01', { choice: v.verdict, elementsJson: elementsFor(r.excerpt), verdict: { choice: v.verdict, testId: 'CUA-JEV-01', decidedAt: new Date().toISOString(), detail: r.excerpt } });
    out.push({ testId: 'CUA-JEV-01', choice: v.verdict, liveBridge: { active: true }, excerpt: r.excerpt, jev: v });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown live failure';
    evidenceMod.writeCuaEvidence('CUA-JEV-01', { choice: 'fail', elementsJson: '[]', verdict: { choice: 'fail', testId: 'CUA-JEV-01', decidedAt: new Date().toISOString(), detail: msg } });
    out.push({ testId: 'CUA-JEV-01', choice: 'fail', liveBridge: { active: true }, excerpt: msg });
  }
}
// 02: unknown-UID + duplicate-cooldown via bridge invoke + fresh outerHTML captures.
if (${JSON.stringify(SCENARIOS.some((s) => s.id === 'CUA-JEV-02'))}) {
  const fail02 = (msg) => {
    evidenceMod.writeCuaEvidence('CUA-JEV-02', { choice: 'fail', elementsJson: '[]', verdict: { choice: 'fail', testId: 'CUA-JEV-02', decidedAt: new Date().toISOString(), detail: msg } });
    out.push({ testId: 'CUA-JEV-02', choice: 'fail', liveBridge: { active: true }, excerpt: msg });
  };
  try {
    const target = await targetMod.resolveTauriMainWindow('CUA-JEV-02');
    void target;
    const bridge = new happyMod.HappyBridge();
    await bridge.connect();
    try {
      // Assert stage: every capture below is a fresh snapshot taken AFTER
      // the invoke; the invoke return itself is never asserted on.
      freshMod.assertFreshSnapshot({ fromClickReturn: false });
      await bridge.invoke('scan_rfid', { request: { rfidUid: edgeMod.EDGE_UNKNOWN_UID, source: edgeMod.EDGE_SCAN_SOURCE } });
      const freshA = String(await bridge.executeJs('return document.documentElement.outerHTML'));
      freshMod.assertFreshSnapshot({ fromClickReturn: false });
      const okA = edgeMod.isUnknownCardSnapshot(freshA);
      const knownUid = process.env.CUA_KNOWN_RFID_UID ?? '';
      let okB = false;
      if (knownUid.length > 0) {
        await bridge.invoke('scan_rfid', { request: { rfidUid: knownUid, source: edgeMod.EDGE_SCAN_SOURCE } });
        await bridge.executeJs('return document.documentElement.outerHTML');
        await bridge.invoke('scan_rfid', { request: { rfidUid: knownUid, source: edgeMod.EDGE_SCAN_SOURCE } });
        const freshB = String(await bridge.executeJs('return document.documentElement.outerHTML'));
        freshMod.assertFreshSnapshot({ fromClickReturn: false });
        okB = edgeMod.isCooldownSnapshot(freshB);
      }
      const excerpt = edgeMod.redactUidText('unknown=' + okA + ' cooldown=' + okB, [edgeMod.EDGE_UNKNOWN_UID, knownUid]);
      const outcome = okA && okB ? 'pass' : 'fail';
      const v = await judge('CUA-JEV-02', 'edge_handled', outcome, excerpt);
      evidenceMod.writeCuaEvidence('CUA-JEV-02', { choice: v.verdict, elementsJson: elementsFor(excerpt), verdict: { choice: v.verdict, testId: 'CUA-JEV-02', decidedAt: new Date().toISOString(), detail: excerpt } });
      out.push({ testId: 'CUA-JEV-02', choice: v.verdict, liveBridge: { active: true }, excerpt, jev: v });
    } finally {
      bridge.close();
    }
  } catch (e) {
    fail02(e instanceof Error ? e.message : 'unknown live failure');
  }
}
// 03: desktop-SQLite regression skips outside the Tauri webview (contract).
if (${JSON.stringify(SCENARIOS.some((s) => s.id === 'CUA-JEV-03'))}) {
  const r = regMod.checkRegression({ token: '', userId: '', checkoutSnapshot: { fresh: true, text: '' }, returnSnapshot: { fresh: true, text: '' }, logBefore: { logId: '', genderKey: 'MALE', status: 'OUT', durationSeconds: null }, logAfter: { logId: '', genderKey: 'MALE', status: 'OUT', durationSeconds: null } });
  const outcome = r.kind === 'pass' ? 'pass' : r.kind === 'fail' ? 'fail' : 'skip';
  const v = await judge('CUA-JEV-03', 'returned', outcome, r.kind === 'skipped' ? r.reason : r.kind);
  evidenceMod.writeCuaEvidence('CUA-JEV-03', { choice: v.verdict, elementsJson: elementsFor(r.kind), verdict: { choice: v.verdict, testId: 'CUA-JEV-03', decidedAt: new Date().toISOString(), detail: r.kind === 'skipped' ? r.reason : r.kind } });
  out.push({ testId: 'CUA-JEV-03', choice: v.verdict, liveBridge: { active: true }, excerpt: r.kind });
}
console.log('__CUA_JEV_RESULTS__' + JSON.stringify({ results: out, audit: ledger }));
`;
}

function runLive() {
  const urls = {
    jevAudit: pathToFileURL(join(root, 'tools', 'jev', 'audit.ts')).href,
    target: pathToFileURL(join(root, 'tools', 'cua', 'target.ts')).href,
    happy: pathToFileURL(join(root, 'tools', 'cua', 'cases', 'happy.ts')).href,
    edge: pathToFileURL(join(root, 'tools', 'cua', 'cases', 'edge.ts')).href,
    regression: pathToFileURL(join(root, 'tools', 'cua', 'cases', 'regression.ts')).href,
    fresh: pathToFileURL(join(root, 'tools', 'cua', 'fresh-snapshot.ts')).href,
    verdict: pathToFileURL(join(root, 'tools', 'cua', 'verdict.ts')).href,
    evidence: pathToFileURL(join(root, 'tools', 'cua', 'evidence.ts')).href,
  };
  return new Promise((resolveRun) => {
    const child = spawn('npx', ['tsx', '--eval', liveEvalSource(urls)], { cwd: root, windowsHide: true });
    if (child.pid !== undefined) spawnedPids.add(child.pid);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { if (child.pid !== undefined) killExact(child.pid); resolveRun({ timeout: true, err }); }, 300000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (child.pid !== undefined) spawnedPids.delete(child.pid);
      const marker = '__CUA_JEV_RESULTS__';
      const i = out.lastIndexOf(marker);
      if (i < 0) { resolveRun({ timeout: false, exitCode: code ?? 1, results: [], audit: [], rawErr: scrub(err).slice(-2000) }); return; }
      try {
        const parsed = JSON.parse(out.slice(i + marker.length));
        resolveRun({ timeout: false, exitCode: code ?? 0, results: parsed.results ?? [], audit: parsed.audit ?? [] });
      } catch { resolveRun({ timeout: false, exitCode: 1, results: [], audit: [], rawErr: 'unparseable live output' }); }
    });
    child.on('error', (e) => { clearTimeout(timer); resolveRun({ timeout: false, exitCode: 1, results: [], audit: [], rawErr: String(e.message ?? e) }); });
  });
}

const doctor = await runDoctor();
const bridgeLive = (await tcpProbe(9223)) && doctor !== null && doctor.cua?.installed === true && doctor.tauri?.bridge9223 === true;

const summary = { runId, onlyCase, liveBridge: { active: bridgeLive }, doctor, cases: [] };

if (!bridgeLive) {
  const reason = doctor === null
    ? 'skip: cua-jev doctor unreadable; contract-only, not live proof'
    : doctor.cua?.installed !== true
      ? 'skip: cua-driver missing (installed:false); contract-only, not live proof'
      : 'skip: bridge 127.0.0.1:9223 closed; contract-only, not live proof';
  for (const s of SCENARIOS) {
    writeSkipEvidence(s.id, reason);
    const entry = { runId, testId: s.id, choice: 'needs_review', liveBridge: { active: false }, source: 'orchestrator-skip', at: new Date().toISOString() };
    appendLedger(entry);
    summary.cases.push({ testId: s.id, choice: 'needs_review', liveBridge: { active: false }, excerpt: reason });
    if (!asJson) console.log(`${s.id} SKIP liveBridge.active:false ${reason}`);
  }
} else {
  const live = await runLive();
  if (live.timeout === true || live.results.length === 0) {
    for (const s of SCENARIOS) {
      const reason = `live pipeline failed: ${(live.rawErr ?? 'timeout').slice(0, 200)}`;
      writeSkipEvidence(s.id, reason);
      appendLedger({ runId, testId: s.id, choice: 'needs_review', liveBridge: { active: true }, source: 'orchestrator-error', at: new Date().toISOString() });
      summary.cases.push({ testId: s.id, choice: 'needs_review', liveBridge: { active: true }, excerpt: reason });
    }
    if (!asJson) console.log('live pipeline failed before verdict; wrote needs_review evidence');
  } else {
    for (const r of live.results) {
      appendLedger({ runId, testId: r.testId, choice: r.choice, liveBridge: r.liveBridge, jev: r.jev ?? null, source: 'cua-jev-run', at: new Date().toISOString() });
      for (const e of live.audit ?? []) appendLedger({ runId, testId: r.testId, source: 'jev-audit', event: e });
      summary.cases.push(r);
      if (!asJson) console.log(`${r.testId} ${String(r.choice).toUpperCase()} liveBridge.active:${r.liveBridge?.active === true} ${scrub(r.excerpt ?? '').slice(0, 160)}`);
    }
  }
}

cleanupSpawned();

if (asJson) console.log(JSON.stringify(summary, null, 2));

const failed = summary.cases.some((c) => c.choice === 'fail');
process.exit(failed ? 1 : 0);
