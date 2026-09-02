#!/usr/bin/env node
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const DEFAULT_THRESHOLD_GB = 15;
const BYTES_PER_GB = 1024 * 1024 * 1024;
const BYTES_PER_MB = 1024 * 1024;

const ARTIFACT_TARGETS = [
  'src-tauri/target',
  'client/dist',
  'server/dist',
  'shared/dist',
  'src-tauri/gen',
  'client/tsconfig.tsbuildinfo',
  'server/tsconfig.tsbuildinfo',
  'shared/tsconfig.tsbuildinfo',
  'coverage',
  '.vite',
];

function formatBytes(bytes) {
  if (bytes < BYTES_PER_MB) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < BYTES_PER_GB) {
    return `${(bytes / BYTES_PER_MB).toFixed(2)} MB`;
  }
  return `${(bytes / BYTES_PER_GB).toFixed(2)} GB`;
}

function getPathSize(itemPath) {
  try {
    const stat = fs.statSync(itemPath);
    if (!stat.isDirectory()) {
      return stat.size;
    }
    let total = 0;
    const entries = fs.readdirSync(itemPath, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        try {
          const entryParent = entry.parentPath ?? entry.path;
          const fileStat = fs.statSync(path.join(entryParent, entry.name));
          total += fileStat.size;
        } catch {
          // Ignore files that vanish or are locked
        }
      }
    }
    return total;
  } catch {
    return 0;
  }
}

function cleanArtifacts() {
  const cargoTomlPath = path.join(ROOT_DIR, 'src-tauri', 'Cargo.toml');
  const targetDir = path.join(ROOT_DIR, 'src-tauri', 'target');
  let cargoCleaned = false;

  if (fs.existsSync(targetDir) && fs.existsSync(cargoTomlPath)) {
    try {
      execSync(`cargo clean --manifest-path "${cargoTomlPath}"`, {
        cwd: ROOT_DIR,
        stdio: 'pipe',
      });
      cargoCleaned = true;
    } catch {
      // Fall through to file deletion if cargo clean fails
    }
  }

  for (const relativePath of ARTIFACT_TARGETS) {
    if (relativePath === 'src-tauri/target' && cargoCleaned && !fs.existsSync(targetDir)) {
      continue;
    }
    const fullPath = path.join(ROOT_DIR, relativePath);
    if (fs.existsSync(fullPath)) {
      try {
        fs.rmSync(fullPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch (err) {
        console.warn(`[auto-clean] Warning: Failed to remove ${relativePath}:`, err.message);
      }
    }
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  let maxGb = Number(process.env.AUTO_CLEAN_MAX_GB) || DEFAULT_THRESHOLD_GB;
  let force = false;
  let dryRun = false;
  let quiet = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--max-gb' && i + 1 < args.length) {
      maxGb = parseFloat(args[++i]);
    } else if (arg === '--max-mb' && i + 1 < args.length) {
      maxGb = parseFloat(args[++i]) / 1024;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--quiet' || arg === '-q') {
      quiet = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/auto-clean.mjs [options]

Options:
  --max-gb <N>   Threshold in GB to trigger auto-clean (default: ${DEFAULT_THRESHOLD_GB} GB or AUTO_CLEAN_MAX_GB env)
  --max-mb <N>   Threshold in MB to trigger auto-clean
  --force        Force cleanup regardless of size
  --dry-run      Report size and action without deleting anything
  --quiet, -q    Do not print status unless artifacts are cleaned
  --help, -h     Show this help message
`);
      process.exit(0);
    }
  }

  return { maxGb, force, dryRun, quiet };
}

function main() {
  const { maxGb, force, dryRun, quiet } = parseArgs();
  const thresholdBytes = maxGb * BYTES_PER_GB;

  let totalBytes = 0;
  const found = [];

  for (const relativePath of ARTIFACT_TARGETS) {
    const fullPath = path.join(ROOT_DIR, relativePath);
    if (fs.existsSync(fullPath)) {
      const size = getPathSize(fullPath);
      totalBytes += size;
      if (size > 0) {
        found.push({ relativePath, size });
      }
    }
  }

  const shouldClean = force || totalBytes >= thresholdBytes;

  if (dryRun) {
    console.log(`[auto-clean:dry-run] Total artifact size: ${formatBytes(totalBytes)} (threshold: ${maxGb} GB)`);
    if (found.length > 0) {
      for (const item of found) {
        console.log(`  - ${item.relativePath}: ${formatBytes(item.size)}`);
      }
    }
    console.log(`[auto-clean:dry-run] Cleanup would ${shouldClean ? 'TRIGGER' : 'NOT trigger'}.`);
    return;
  }

  if (shouldClean) {
    const reason = force
      ? 'Forced clean requested'
      : `Artifact size (${formatBytes(totalBytes)}) exceeds threshold (${maxGb} GB)`;
    console.log(`[auto-clean] ${reason}. Cleaning build artifacts...`);
    cleanArtifacts();
    console.log(`[auto-clean] Successfully cleaned build artifacts (${formatBytes(totalBytes)} reclaimed).`);
  } else if (!quiet) {
    console.log(`[auto-clean] Artifact size: ${formatBytes(totalBytes)} (threshold: ${maxGb} GB) - clean not needed.`);
  }
}

main();
