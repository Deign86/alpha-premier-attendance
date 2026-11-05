#!/usr/bin/env node
/**
 * Alpha Premier Attendance — Batch Intern Name Voice Generator (Ma'am Bea Cloned Voice).
 *
 * Discovers active interns from the authoritative database, normalizes names for speech,
 * generates cloned name audio via local VoiceStudio (Ma'am Bea profile), and creates a machine-readable manifest.
 *
 * Usage:
 *   npx tsx scripts/generate_existing_intern_names.ts [--dry-run] [--missing-only] [--force] [--person-id <id>]
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { normalizeName } from '../shared/src/api-contracts.js';

export type SheetUser = {
  userId: string;
  fullName: string;
  rfidUid?: string;
  department?: string | null;
  status?: string;
  active?: boolean;
  employeeType?: 'INTERN' | 'EMPLOYEE';
  gender?: 'MALE' | 'FEMALE' | null;
  dailyRate?: number | null;
  payrollProfileId?: string | null;
  photoUrl?: string | null;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const VOICESTUDIO_BASE = process.env.VOICESTUDIO_BASE_URL || 'http://127.0.0.1:3900';
const VOICESTUDIO_BEA_PROFILE_ID = '1b3e828b';
// v2 = Bea reference rebuilt from the FB Ad Tutorial VO clips (2026-11-04).
// v3 = the v2 reference + 0.4 s trailing silence; without it most takes opened with a breath.
const VOICE_PROFILE_VERSION = 'voicestudio-bea-v3';
// Every clip lands at the same loudness so spliced prefix + name + suffix play level.
const TARGET_LUFS = -15;
const PEAK_LIMIT = 0.794; // -2 dBFS sample ceiling keeps the mp3 true peak under ~-1 dBTP
// De-esser for Bea's sharp "s": above 4.5 kHz, peaks over -18 dBFS (input already at
// TARGET_LUFS) are compressed 3:1: "s" peaks drop from ~4.5 to ~11 dB under the vowels, which barely change.
const DEESS =
  'acrossover=split=4500:order=8th[lo][hi];' +
  '[hi]acompressor=threshold=-18dB:ratio=3:attack=0.5:release=40:knee=3[hic];' +
  '[lo][hic]amix=inputs=2:normalize=0';
// 64k MP3 punched holes into the "s" band that sounded like static; 128k leaves none.
const MP3_BITRATE = '128k';
// A take that opens with a breath or blip before the first word is re-rolled.
const LEAD_IN_LIMIT_MS = 50;
const MAX_TAKES = 4;
const CLIENT_NAMES_DIR = path.join(REPO_ROOT, 'client', 'public', 'voices', 'bea', 'names');
const TAURI_NAMES_DIR = path.join(REPO_ROOT, 'src-tauri', 'resources', 'voices', 'bea', 'names');
const CLIENT_MANIFEST_PATH = path.join(REPO_ROOT, 'client', 'public', 'voices', 'bea', 'bea-name-manifest.json');
const TAURI_MANIFEST_PATH = path.join(REPO_ROOT, 'src-tauri', 'resources', 'voices', 'bea', 'bea-name-manifest.json');

export type NameManifestEntry = {
  personId: string;
  displayName: string;
  normalizedSpeechText: string;
  employeeType: 'INTERN' | 'EMPLOYEE';
  voiceProfileVersion: string;
  audioFile: string;
  generatedAt: string;
  audioHash: string;
};

export type NameManifest = {
  version: string;
  voice: 'bea';
  engine: string;
  generatedAt: string;
  profiles: Record<string, NameManifestEntry>;
};

export type BatchGeneratorOptions = {
  dryRun?: boolean;
  missingOnly?: boolean;
  force?: boolean;
  personId?: string;
  mockUsers?: SheetUser[];
  backupPath?: string;
  dbPath?: string;
};

export const CUSTOM_PRONUNCIATION_OVERRIDES: Record<string, string> = {
  // 'PERSON_ID': 'Phonetic Spoken Name'
  'APG-2026-121': 'John Ma-rey Raphael Rodriguez',
  // Filipino "Bar-to-lo-meh"; the v2 voice otherwise says "Bartholomew".
  'APG-2026-123': 'Lord Bar-to-lo-meh',
};

export function normalizePronunciation(rawName: string, personId?: string): string {
  if (personId && CUSTOM_PRONUNCIATION_OVERRIDES[personId]) {
    return CUSTOM_PRONUNCIATION_OVERRIDES[personId];
  }
  let clean = rawName.trim();
  if (clean.startsWith('Admin Rfid')) {
    return clean;
  }

  // Expand "Ma." / "Ma " prefix to "Maria "
  if (clean.startsWith('Ma. ') || clean.startsWith('Ma ')) {
    clean = 'Maria ' + clean.slice(4);
  }

  // Clean middle initials like " O. ", " P. ", " C. " -> remove initial for seamless spoken flow
  const parts = clean.split(/\s+/);
  const speechParts: string[] = [];
  for (const p of parts) {
    if (p.length === 2 && p[1] === '.' && /^[a-zA-Z]$/.test(p[0])) {
      continue;
    }
    speechParts.push(p);
  }

  let spoken = speechParts.join(' ');
  // Clean hyphens in first names like "Ar-jee" -> "Arjee"
  spoken = spoken.replace(/Ar-jee/gi, 'Arjee');
  return normalizeName(spoken);
}

function sha256File(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function httpGetJson(urlStr: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get(urlStr, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          } else {
            resolve(JSON.parse(body));
          }
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function getVoicestudioBeaProfileId(): Promise<string | null> {
  try {
    const profiles = await httpGetJson(`${VOICESTUDIO_BASE}/profiles`);
    if (Array.isArray(profiles)) {
      for (const p of profiles) {
        if (typeof p.name === 'string' && p.name.toLowerCase().includes('bea')) {
          return p.id;
        }
      }
    }
  } catch (err) {
    console.warn(`[VoiceStudio] Failed to query profiles from ${VOICESTUDIO_BASE}:`, err);
  }
  return null;
}

/** Integrated loudness (EBU R128) of an audio file. */
function measureLufs(filePath: string): number {
  const meter = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', filePath, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' });
  const readings = [...meter.stderr.matchAll(/I:\s+(-?[\d.]+) LUFS/g)];
  const lufs = Number(readings[readings.length - 1]?.[1]);
  if (!Number.isFinite(lufs) || lufs < -50) {
    throw new Error(`no usable loudness reading for ${filePath}`);
  }
  return lufs;
}

/**
 * WAV -> de-essed mono MP3 at TARGET_LUFS behind a peak limiter. De-essing and
 * limiting cost loudness, so the measured shortfall is added back after the
 * de-esser (whose input level stays fixed) and the clip re-encoded, at most twice.
 */
export function transcodeNormalized(wavPath: string, outPath: string): void {
  const gain = TARGET_LUFS - measureLufs(wavPath);
  let makeup = 0;
  for (let pass = 0; pass < 3; pass++) {
    const filters = `volume=${gain.toFixed(2)}dB,${DEESS},volume=${makeup.toFixed(2)}dB,alimiter=limit=${PEAK_LIMIT}:level=false`;
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', wavPath, '-af', filters, '-codec:a', 'libmp3lame', '-b:a', MP3_BITRATE, '-ac', '1', outPath]);
    const shortfall = TARGET_LUFS - measureLufs(outPath);
    if (shortfall <= 0.5) return;
    makeup += shortfall;
  }
}

/**
 * Sound before the first word (a breath or blip), in ms, from 16 kHz mono PCM.
 *
 * The first word is the first run of sound (within 40 dB of the peak) that lasts
 * 250 ms and has a loud, low zero-crossing (voiced) frame; a breath is noisy and a
 * blip is short, so anything audible before that run counts.
 */
export function leadInMsFromPcm(pcm: Int16Array): number {
  const db: number[] = [];
  const zcr: number[] = [];
  for (let start = 0; start + 320 <= pcm.length; start += 160) {
    // 20 ms frames, 10 ms hop
    let energy = 0;
    let crossings = 0;
    for (let k = start; k < start + 320; k++) {
      energy += pcm[k] * pcm[k];
      if (k > start && (pcm[k] < 0) !== (pcm[k - 1] < 0)) crossings++;
    }
    db.push(10 * Math.log10(energy / 320 + 1e-9));
    zcr.push(crossings / 319);
  }
  if (db.length === 0) return 0;
  const peak = Math.max(...db);
  for (let i = 0; i < db.length; ) {
    if (db[i] <= peak - 40) {
      i++;
      continue;
    }
    let j = i;
    while (j < db.length && db[j] > peak - 40) j++;
    let voiced = false;
    for (let k = i; k < j; k++) voiced ||= db[k] > peak - 20 && zcr[k] < 0.15;
    if (j - i >= 25 && voiced) return 10 * db.slice(0, i).filter((d) => d > peak - 40).length;
    i = j;
  }
  return 0;
}

function leadInMs(audioPath: string): number {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', audioPath, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { maxBuffer: 64 * 1024 * 1024 });
  const pcm = new Int16Array(raw.length >> 1);
  for (let i = 0; i < pcm.length; i++) pcm[i] = raw.readInt16LE(i * 2);
  return leadInMsFromPcm(pcm);
}

export async function generateVoicestudioClip(
  profileId: string,
  text: string,
  outPath: string,
): Promise<boolean> {
  const tmpWav = /\.mp3$/i.test(outPath) ? outPath.replace(/\.mp3$/i, '.tmp.wav') : `${outPath}.tmp.wav`;
  try {
    // Takes that open with a breath are re-rolled; the cleanest one is kept.
    // Repo standard is MP3 (128k mono): transcode via ffmpeg, keep only the `.mp3`.
    let best: { leadMs: number; audio: Buffer } | null = null;
    for (let take = 0; take < MAX_TAKES; take++) {
      const audio = await requestTake(profileId, text);
      if (!audio) return false;
      fs.writeFileSync(tmpWav, audio);
      const leadMs = leadInMs(tmpWav);
      if (!best || leadMs < best.leadMs) best = { leadMs, audio };
      if (leadMs < LEAD_IN_LIMIT_MS) break;
    }
    if (!best) return false;
    if (best.leadMs >= LEAD_IN_LIMIT_MS) {
      console.warn(`[VoiceStudio] Every take of "${text}" opens with ~${best.leadMs} ms of breath; kept the shortest`);
    }
    fs.writeFileSync(tmpWav, best.audio);
    transcodeNormalized(tmpWav, outPath);
    return fs.existsSync(outPath) && fs.statSync(outPath).size > 100;
  } catch (err) {
    console.error(`[VoiceStudio] Error during generation for "${text}":`, err);
  } finally {
    fs.rmSync(tmpWav, { force: true });
  }
  return false;
}

/** One VoiceStudio /generate take as raw WAV bytes, or null. */
async function requestTake(profileId: string, text: string): Promise<Buffer | null> {
  try {
    // VoiceStudio POST /generate accepts multipart form fields and returns raw WAV bytes.
    const boundary = '----bea' + crypto.randomBytes(8).toString('hex');
    const chunks: Buffer[] = [];
    const pushField = (name: string, value: string): void => {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
    };
    pushField('text', text);
    pushField('profile_id', profileId);
    pushField('language', 'en');
    chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
    const payload = Buffer.concat(chunks);
    const audio: Buffer = await new Promise((resolve, reject) => {
      const req = http.request(
        new URL(`${VOICESTUDIO_BASE}/generate`),
        {
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': payload.length,
          },
        },
        (res) => {
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          const data: Buffer[] = [];
          res.on('data', (chunk: Buffer) => data.push(chunk));
          res.on('end', () => resolve(Buffer.concat(data)));
        },
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
    if (audio.length <= 1000 || audio.subarray(0, 4).toString('ascii') !== 'RIFF') {
      console.error(`[VoiceStudio] Invalid audio for "${text}" (${audio.length} bytes)`);
      return null;
    }
    return audio;
  } catch (err) {
    console.error(`[VoiceStudio] Error during generation for "${text}":`, err);
  }
  return null;
}

function findPythonBinary(): string {
  if (process.env.PYTHON && fs.existsSync(process.env.PYTHON)) {
    return process.env.PYTHON;
  }
  const uvPython = path.join(
    process.env.USERPROFILE || '',
    'AppData',
    'Roaming',
    'uv',
    'python',
    'cpython-3.11-windows-x86_64-none',
    'python.exe',
  );
  if (fs.existsSync(uvPython)) {
    return uvPython;
  }
  return 'python';
}

export async function runBatchInternNameGeneration(
  options: BatchGeneratorOptions = {},
): Promise<{
  discovered: number;
  generated: number;
  skipped: number;
  failed: number;
  manifest: NameManifest;
}> {
  const {
    dryRun = false,
    missingOnly = true,
    force = false,
    personId,
    mockUsers,
    backupPath,
    dbPath,
  } = options;

  console.log('='.repeat(75));
  console.log(' Alpha Premier Attendance — Cloned Bea Intern Name Generator');
  console.log('='.repeat(75));

  // 1. Load users from source
  let users: SheetUser[] = [];
  if (mockUsers && mockUsers.length > 0) {
    users = mockUsers;
  } else if (backupPath) {
    console.log(`Loading users from backup archive: ${backupPath}`);
    const pyScript = [
      'import zipfile, sqlite3, json, tempfile, os, sys',
      'with zipfile.ZipFile(sys.argv[1], "r") as z:',
      '    db_data = z.read("database/attendance.db")',
      'with tempfile.NamedTemporaryFile(delete=False, suffix=".db") as tmp:',
      '    tmp.write(db_data)',
      '    tmp_path = tmp.name',
      'try:',
      '    conn = sqlite3.connect(tmp_path)',
      '    cur = conn.cursor()',
      '    cur.execute("SELECT user_id, full_name, employee_type, status, department, photo_url, gender FROM users")',
      '    out = []',
      '    for r in cur.fetchall():',
      '        out.append({"userId": r[0], "fullName": r[1], "employeeType": r[2], "status": r[3], "department": r[4], "photoUrl": r[5], "gender": r[6]})',
      '    print(json.dumps(out))',
      'finally:',
      '    conn.close()',
      '    if os.path.exists(tmp_path):',
      '        try: os.unlink(tmp_path)',
      '        except: pass',
    ].join('\n');
    const stdout = execFileSync(findPythonBinary(), ['-c', pyScript, backupPath], { encoding: 'utf8' });
    // SAFETY: Output from Python script matches SheetUser structure
    users = JSON.parse(stdout) as SheetUser[];
  } else if (dbPath) {
    console.log(`Loading users from SQLite database: ${dbPath}`);
    const pyScript = [
      'import sqlite3, json, sys',
      'conn = sqlite3.connect(sys.argv[1])',
      'cur = conn.cursor()',
      'cur.execute("SELECT user_id, full_name, employee_type, status, department, photo_url, gender FROM users")',
      'out = []',
      'for r in cur.fetchall():',
      '    out.append({"userId": r[0], "fullName": r[1], "employeeType": r[2], "status": r[3], "department": r[4], "photoUrl": r[5], "gender": r[6]})',
      'print(json.dumps(out))',
      'conn.close()',
    ].join('\n');
    const stdout = execFileSync(findPythonBinary(), ['-c', pyScript, dbPath], { encoding: 'utf8' });
    // SAFETY: Output from Python script matches SheetUser structure
    users = JSON.parse(stdout) as SheetUser[];
  } else {
    const keyPath = path.join(REPO_ROOT, 'credentials', 'attendance-sheets-key.json');
    const statePath = path.join(REPO_ROOT, 'credentials', 'google-sheets-state.json');
    if (fs.existsSync(keyPath) && fs.existsSync(statePath)) {
      const { GoogleSheetsAdapter } = await import('../server/src/sheets.js');
      const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const adapter = new GoogleSheetsAdapter({
        spreadsheetId: state.spreadsheetId,
        clientEmail: key.client_email,
        privateKey: key.private_key,
        driveFolderId: state.driveFolderId,
      });
      users = await adapter.listUsers();
    } else {
      console.log('Google Sheets credentials not found. Using default mock users.');
      users = [
        { userId: 'USR_INT_001', fullName: 'Maria Santos', employeeType: 'INTERN', status: 'ACTIVE' },
        { userId: 'USR_INT_002', fullName: 'Juan Dela Cruz', employeeType: 'INTERN', status: 'ACTIVE' },
      ];
    }
  }

  // 2. Filter target users
  let targetUsers = users.filter(
    (u) => (u.status === 'ACTIVE' || u.active === true)
      && (u.employeeType ?? 'INTERN') === 'INTERN'
      && !u.userId.startsWith('ADMIN_CARD')
      && !u.userId.startsWith('ADMIN_'),
  );
  if (personId) {
    targetUsers = targetUsers.filter((u) => u.userId === personId);
  }

  console.log(`Discovered ${targetUsers.length} active target user(s) for name voice generation.`);

  // 3. Ensure directories
  fs.mkdirSync(CLIENT_NAMES_DIR, { recursive: true });
  fs.mkdirSync(TAURI_NAMES_DIR, { recursive: true });

  // 4. Load existing manifest
  let manifest: NameManifest = {
    version: '1.0.0',
    voice: 'bea',
    engine: 'voicestudio-bea-cloned',
    generatedAt: new Date().toISOString(),
    profiles: {},
  };

  if (!mockUsers && fs.existsSync(CLIENT_MANIFEST_PATH)) {
    try {
      manifest = JSON.parse(fs.readFileSync(CLIENT_MANIFEST_PATH, 'utf8'));
    } catch {
      // fresh manifest
    }
  }

  let voicestudioProfileId: string | null = null;
  if (!dryRun) {
    voicestudioProfileId = await getVoicestudioBeaProfileId();
    if (!voicestudioProfileId) {
      console.warn(`[VoiceStudio] Could not find Ma'am Bea profile on ${VOICESTUDIO_BASE}. Using cached profile ${VOICESTUDIO_BEA_PROFILE_ID}.`);
      voicestudioProfileId = VOICESTUDIO_BEA_PROFILE_ID;
    }
  }

  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (const user of targetUsers) {
    const rawName = user.fullName || '';
    const speechName = normalizePronunciation(rawName, user.userId);
    const audioFileName = `${user.userId}.mp3`;
    const clientAudioPath = path.join(CLIENT_NAMES_DIR, audioFileName);
    const tauriAudioPath = path.join(TAURI_NAMES_DIR, audioFileName);
    const relativeUrl = `/voices/bea/names/${audioFileName}`;

    console.log(`\n[Person ID: ${user.userId}] ${user.employeeType}: "${rawName}" -> Spoken: "${speechName}"`);

    const existingValidFile =
      fs.existsSync(clientAudioPath) &&
      fs.statSync(clientAudioPath).size > 1000 &&
      manifest.profiles[user.userId];

    if (existingValidFile && missingOnly && !force) {
      console.log(`  ✓ Already cached & valid (Skipping)`);
      skipped++;
      continue;
    }

    if (dryRun) {
      console.log(`  [DRY-RUN] Would generate clip via VoiceStudio -> ${relativeUrl}`);
      generated++;
      manifest.profiles[user.userId] = {
        personId: user.userId,
        displayName: user.fullName,
        normalizedSpeechText: speechName,
        employeeType: user.employeeType,
        voiceProfileVersion: VOICE_PROFILE_VERSION,
        audioFile: relativeUrl,
        generatedAt: new Date().toISOString(),
        audioHash: 'dry-run-hash',
      };
      continue;
    }

    if (!voicestudioProfileId) {
      console.log(`  ✗ VoiceStudio not connected. Skipping generation.`);
      failed++;
      continue;
    }

    console.log(`  Generating via VoiceStudio Ma'am Bea...`);
    const success = await generateVoicestudioClip(voicestudioProfileId, speechName, clientAudioPath);
    if (success && fs.existsSync(clientAudioPath)) {
      fs.copyFileSync(clientAudioPath, tauriAudioPath);
      const hash = sha256File(clientAudioPath);
      manifest.profiles[user.userId] = {
        personId: user.userId,
        displayName: user.fullName,
        normalizedSpeechText: speechName,
        employeeType: user.employeeType,
        voiceProfileVersion: VOICE_PROFILE_VERSION,
        audioFile: relativeUrl,
        generatedAt: new Date().toISOString(),
        audioHash: hash,
      };
      console.log(`  ✓ Saved (${fs.statSync(clientAudioPath).size} bytes, SHA-256: ${hash.slice(0, 12)}...)`);
      generated++;
    } else {
      console.log(`  ✗ Generation failed.`);
      failed++;
    }
  }

  manifest.generatedAt = new Date().toISOString();

  if (!dryRun && !mockUsers) {
    fs.writeFileSync(CLIENT_MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
    fs.writeFileSync(TAURI_MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
  }

  console.log('\n' + '='.repeat(75));
  console.log(' Batch Generation Summary:');
  console.log(`   Discovered: ${targetUsers.length}`);
  console.log(`   Generated:  ${generated}`);
  console.log(`   Skipped:    ${skipped}`);
  console.log(`   Failed:     ${failed}`);
  console.log(`   Manifest:   ${CLIENT_MANIFEST_PATH}`);
  console.log('='.repeat(75));

  return {
    discovered: targetUsers.length,
    generated,
    skipped,
    failed,
    manifest,
  };
}

// CLI entrypoint
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const missingOnly = !force || args.includes('--missing-only');
  const personIdIndex = args.indexOf('--person-id');
  const personId = personIdIndex >= 0 && args[personIdIndex + 1] ? args[personIdIndex + 1] : undefined;
  const backupIndex = args.indexOf('--backup');
  const backupPath = backupIndex >= 0 && args[backupIndex + 1] ? args[backupIndex + 1] : undefined;
  const dbIndex = args.indexOf('--db');
  const dbPath = dbIndex >= 0 && args[dbIndex + 1] ? args[dbIndex + 1] : undefined;

  runBatchInternNameGeneration({
    dryRun,
    missingOnly,
    force,
    personId,
    backupPath,
    dbPath,
  }).catch((err) => {
    console.error('Fatal error during batch name generation:', err);
    process.exit(1);
  });
}
