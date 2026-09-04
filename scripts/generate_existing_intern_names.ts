#!/usr/bin/env node
/**
 * Alpha Premier Attendance — Batch Intern Name Voice Generator (Ma'am Bea Cloned Voice).
 *
 * Discovers active interns from the authoritative database, normalizes names for speech,
 * generates cloned name audio via local VoiceStudio (Ma'am Bea profile), and creates a machine-readable manifest.
 *
 * Usage:
 *   npx tsx scripts/generate_existing_intern_names.ts [--dry-run] [--missing-only] [--force] [--person-id <id>] [--interns-only]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { GoogleSheetsAdapter, InMemorySheetsService, type GoogleSheetsService, type SheetUser } from '../server/src/sheets.js';
import { normalizeName } from '../shared/src/api-contracts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const VOICESTUDIO_BASE = process.env.VOICESTUDIO_BASE_URL || process.env.VOICEBOX_BASE_URL || 'http://127.0.0.1:3900';
const VOICESTUDIO_BEA_PROFILE_ID = '1b3e828b';
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
  internsOnly?: boolean;
  mockUsers?: SheetUser[];
};

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

export async function generateVoicestudioClip(
  profileId: string,
  text: string,
  outPath: string,
): Promise<boolean> {
  try {
    // VoiceStudio POST /generate accepts multipart form fields and returns raw WAV bytes.
    // Repo standard is MP3 (64k mono): transcode via ffmpeg, keep only the `.mp3`.
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
      return false;
    }
    const tmpWav = /\.mp3$/i.test(outPath) ? outPath.replace(/\.mp3$/i, '.tmp.wav') : `${outPath}.tmp.wav`;
    fs.writeFileSync(tmpWav, audio);
    try {
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', tmpWav, '-codec:a', 'libmp3lame', '-b:a', '64k', '-ac', '1', outPath]);
    } catch (err) {
      console.error(`[VoiceStudio] ffmpeg transcode failed for "${text}":`, err);
      return false;
    } finally {
      fs.rmSync(tmpWav, { force: true });
    }
    return fs.existsSync(outPath) && fs.statSync(outPath).size > 100;
  } catch (err) {
    console.error(`[VoiceStudio] Error during generation for "${text}":`, err);
  }
  return false;
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
    internsOnly = false,
    mockUsers,
  } = options;

  console.log('='.repeat(75));
  console.log(' Alpha Premier Attendance — Cloned Bea Intern & Employee Name Generator');
  console.log('='.repeat(75));

  // 1. Load users from source
  let users: SheetUser[] = [];
  if (mockUsers && mockUsers.length > 0) {
    users = mockUsers;
  } else {
    const keyPath = path.join(REPO_ROOT, 'credentials', 'attendance-sheets-key.json');
    const statePath = path.join(REPO_ROOT, 'credentials', 'google-sheets-state.json');
    if (fs.existsSync(keyPath) && fs.existsSync(statePath)) {
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
      console.log('Google Sheets credentials not found. Using InMemorySheetsService.');
      const inMem = new InMemorySheetsService();
      users = await inMem.listUsers();
    }
  }

  // 2. Filter target users
  let targetUsers = users.filter((u) => u.status === 'ACTIVE');
  if (internsOnly) {
    targetUsers = targetUsers.filter((u) => u.employeeType === 'INTERN');
  }
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
    const speechName = normalizeName(rawName);
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
        voiceProfileVersion: 'voicestudio-bea-1b3e828b-v1',
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
        voiceProfileVersion: 'voicestudio-bea-1b3e828b-v1',
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
  const internsOnly = args.includes('--interns-only');
  const personIdIndex = args.indexOf('--person-id');
  const personId = personIdIndex >= 0 && args[personIdIndex + 1] ? args[personIdIndex + 1] : undefined;

  runBatchInternNameGeneration({
    dryRun,
    missingOnly,
    force,
    personId,
    internsOnly,
  }).catch((err) => {
    console.error('Fatal error during batch name generation:', err);
    process.exit(1);
  });
}
