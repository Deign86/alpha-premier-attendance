#!/usr/bin/env node
// Stop hook for Claude Code (.claude/settings.json): runs the cheap checks that
// match the uncommitted files, so a session cannot end on a broken change.
// Exit 2 sends the failure back to Claude; nothing changed means nothing runs.
// Manual run: `npm run verify:changed`.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PAYROLL_TESTS =
  'cargo test --manifest-path src-tauri/Cargo.toml --test intern_payroll_isolated --test payroll_hours_accuracy --test cutoff_freeze --test intern_payslips';
const CHECKS = [
  { name: 'oxlint', when: /^(shared|client|server)\/.*\.(ts|tsx)$/, command: 'npm run lint:oxlint' },
  { name: 'typecheck', when: /^(shared|client|server)\/.*\.(ts|tsx)$/, command: 'npm run typecheck' },
  {
    name: 'payroll engine tests',
    when: /^(src-tauri\/src\/(services\/(intern_payroll|cutoff_payroll|payroll|lunch_break)|reporting\/mod)\.rs|src-tauri\/tests\/|shared\/payroll-fixtures\.json)/,
    command: PAYROLL_TESTS,
  },
];

function run(command) {
  return spawnSync(command, { shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// A second stop in the same turn must not loop forever: report, but let it end.
let alreadyBlockedOnce = false;
try {
  alreadyBlockedOnce = JSON.parse(readFileSync(0, 'utf8')).stop_hook_active === true;
} catch {
  // No hook input (manual run).
}

const status = run('git status --porcelain');
if (status.status !== 0) process.exit(0);
const changed = status.stdout
  .split('\n')
  .filter(Boolean)
  .map((line) => line.slice(3).split(' -> ').pop().replaceAll('\\', '/').replaceAll('"', ''));

const failures = [];
for (const check of CHECKS) {
  if (!changed.some((file) => check.when.test(file))) continue;
  const result = run(check.command);
  if (result.status !== 0) {
    const tail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-25).join('\n');
    failures.push(`${check.name} failed (${check.command}):\n${tail}`);
  }
}

if (failures.length === 0) process.exit(0);
console.error(`Verification failed for uncommitted changes. Fix the cause; do not skip or weaken a check.\n\n${failures.join('\n\n')}`);
process.exit(alreadyBlockedOnce ? 1 : 2);
