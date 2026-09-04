#!/usr/bin/env node
/**
 * Convert pre-rendered Bea clips to MP3 (64 kbps mono) alongside the originals.
 *
 * Post-cutover role: regenerating `.mp3` siblings for newly generated `.wav`
 * clips (the voice generators already transcode in-line via ffmpeg, so this is
 * now a repair/backfill helper). Never deletes files; skips up-to-date `.mp3`
 * unless --force. Frontend `resolveCompressedVoiceUrl()` prefers the `.mp3`
 * and falls back to `.wav`, so a partial conversion is always safe.
 *
 * Usage:
 *   node scripts/convert-voices.mjs [--dir client/public/voices/bea] [--limit 5] [--dry-run] [--force]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const argv = process.argv.slice(2);
function flagValue(name, fallback) {
  const prefix = `--${name}=`;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith(prefix)) return a.slice(prefix.length);
    if (a === `--${name}` && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      return argv[i + 1];
    }
  }
  return fallback;
}

const dir = path.resolve(root, flagValue('dir', 'client/public/voices/bea'));
const limitRaw = Number(flagValue('limit', '0'));
const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 0;
const dryRun = args.has('--dry-run');
const force = args.has('--force');

function walkWavs(start) {
  const out = [];
  const stack = [start];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) break;
    const entries = fs.readdirSync(cur, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.wav')) out.push(full);
    }
  }
  return out.sort();
}

const wavs = walkWavs(dir);
const picked = limit > 0 ? wavs.slice(0, limit) : wavs;
let converted = 0;
let skipped = 0;
let wavBytes = 0;
let mp3Bytes = 0;

for (const wav of picked) {
  const mp3 = wav.replace(/\.wav$/i, '.mp3');
  const wavStat = fs.statSync(wav);
  wavBytes += wavStat.size;
  if (!force && fs.existsSync(mp3) && fs.statSync(mp3).mtimeMs >= wavStat.mtimeMs) {
    skipped += 1;
    mp3Bytes += fs.statSync(mp3).size;
    continue;
  }
  if (dryRun) {
    console.log(`would convert: ${path.relative(root, wav)}`);
    continue;
  }
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', wav, '-codec:a', 'libmp3lame', '-b:a', '64k', '-ac', '1', mp3]);
  converted += 1;
  mp3Bytes += fs.statSync(mp3).size;
}

console.log(`wavs scanned: ${picked.length} (of ${wavs.length})`);
console.log(`converted: ${converted}, skipped (up-to-date): ${skipped}`);
if (!dryRun && wavBytes > 0) {
  const ratio = mp3Bytes / wavBytes;
  console.log(`wav bytes: ${wavBytes}, mp3 bytes: ${mp3Bytes}, ratio: ${ratio.toFixed(3)}`);
  const fullWavEstimate = 12134201; // measured client/public/voices payload, bytes
  console.log(`projected full-payload mp3 size: ~${Math.round(fullWavEstimate * ratio)} bytes`);
}
