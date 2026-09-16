#!/usr/bin/env node
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const shouldCommit = args.includes('--commit');

function parseSemver(ver) {
  const clean = ver.replace(/^v/, '').trim();
  const match = clean.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

function compareSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

// 1. Read current version from tauri.conf.json
const tauriConfPath = path.join(ROOT_DIR, 'src-tauri', 'tauri.conf.json');
const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
const currentVersionStr = tauriConf.version || '0.1.0';
const currentSemver = parseSemver(currentVersionStr);

if (!currentSemver) {
  console.error(`Invalid version in ${tauriConfPath}: ${currentVersionStr}`);
  process.exit(1);
}

// 2. Query git tags
let existingTags = [];
try {
  const stdout = execSync('git tag -l "v*"', { cwd: ROOT_DIR, encoding: 'utf8' });
  existingTags = stdout.split('\n').map((t) => t.trim()).filter(Boolean);
} catch {
  // If git fails, fallback to empty list
}

// 3. Find highest existing tag
let highestSemver = [0, 0, 0];
for (const tag of existingTags) {
  const parsed = parseSemver(tag);
  if (parsed && compareSemver(parsed, highestSemver) > 0) {
    highestSemver = parsed;
  }
}

// 4. Determine target version
let targetSemver = [...currentSemver];
let needsBump = false;

// If current version is <= highest existing tag (i.e. this version tag already exists)
if (compareSemver(currentSemver, highestSemver) <= 0) {
  // Bump patch of highest existing tag
  targetSemver = [highestSemver[0], highestSemver[1], highestSemver[2] + 1];
  needsBump = true;
}

const targetVersionStr = `${targetSemver[0]}.${targetSemver[1]}.${targetSemver[2]}`;

console.log(`Current version : ${currentVersionStr}`);
console.log(`Highest tag     : v${highestSemver.join('.')}`);
console.log(`Target version  : ${targetVersionStr} ${needsBump ? '(bumped)' : '(existing/manual)'}`);

if (needsBump && !isDryRun) {
  // Update package.json files
  const jsonFiles = [
    'package.json',
    'client/package.json',
    'server/package.json',
    'shared/package.json',
    'src-tauri/tauri.conf.json',
  ];

  for (const relPath of jsonFiles) {
    const fullPath = path.join(ROOT_DIR, relPath);
    if (fs.existsSync(fullPath)) {
      const content = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      content.version = targetVersionStr;
      fs.writeFileSync(fullPath, JSON.stringify(content, null, 2) + '\n', 'utf8');
      console.log(`Updated ${relPath} -> ${targetVersionStr}`);
    }
  }

  // Update src-tauri/Cargo.toml
  const cargoTomlPath = path.join(ROOT_DIR, 'src-tauri', 'Cargo.toml');
  if (fs.existsSync(cargoTomlPath)) {
    let cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
    cargoToml = cargoToml.replace(
      /(\[package\][\s\S]*?version\s*=\s*)"[^"]+"/,
      `$1"${targetVersionStr}"`
    );
    fs.writeFileSync(cargoTomlPath, cargoToml, 'utf8');
    console.log(`Updated src-tauri/Cargo.toml -> ${targetVersionStr}`);
  }

  // Update src-tauri/Cargo.lock if present
  const cargoLockPath = path.join(ROOT_DIR, 'src-tauri', 'Cargo.lock');
  if (fs.existsSync(cargoLockPath)) {
    let cargoLock = fs.readFileSync(cargoLockPath, 'utf8');
    cargoLock = cargoLock.replace(
      /(name\s*=\s*"alpha-premier-attendance"\s*\n\s*version\s*=\s*)"[^"]+"/,
      `$1"${targetVersionStr}"`
    );
    fs.writeFileSync(cargoLockPath, cargoLock, 'utf8');
    console.log(`Updated src-tauri/Cargo.lock -> ${targetVersionStr}`);
  }

  // Update CHANGELOG.md if present and missing header
  const changelogPath = path.join(ROOT_DIR, 'CHANGELOG.md');
  if (fs.existsSync(changelogPath)) {
    let changelog = fs.readFileSync(changelogPath, 'utf8');
    const header = `## [${targetVersionStr}]`;
    if (!changelog.includes(header)) {
      const today = new Date().toISOString().slice(0, 10);
      const entry = `## [${targetVersionStr}] - ${today}\n\n### Changed\n- Automatic release on push to main.\n\n`;
      changelog = changelog.replace(/(# Changelog[\s\S]*?\n\n)/, `$1${entry}`);
      fs.writeFileSync(changelogPath, changelog, 'utf8');
      console.log(`Updated CHANGELOG.md with entry for ${targetVersionStr}`);
    }
  }

  // Commit and push back to main if requested
  if (shouldCommit) {
    try {
      console.log('Committing version bump to git...');
      execSync('git add package.json client/package.json server/package.json shared/package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock CHANGELOG.md', {
        cwd: ROOT_DIR,
        stdio: 'inherit',
      });
      execSync(`git commit -m "chore(release): bump version to v${targetVersionStr} [skip ci]"`, {
        cwd: ROOT_DIR,
        stdio: 'inherit',
      });
      console.log('Pushing version bump to main...');
      execSync('git push origin main', {
        cwd: ROOT_DIR,
        stdio: 'inherit',
      });
      console.log('Successfully pushed version bump to main.');
    } catch (err) {
      console.warn(`Note: Could not push version bump to main: ${err.message}. Release build will still proceed with tag v${targetVersionStr}.`);
    }
  }
}

// 5. Output to GitHub Actions environment if running in CI
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${targetVersionStr}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `tag=v${targetVersionStr}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `bumped=${needsBump}\n`);
}
