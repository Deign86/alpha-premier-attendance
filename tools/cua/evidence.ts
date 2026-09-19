import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type CuaVerdictChoice = 'pass' | 'fail' | 'needs_review';

export interface CuaElementRecord {
  readonly token: string;
  readonly text: string;
}

export interface CuaEvidenceVerdict {
  readonly choice: CuaVerdictChoice;
  readonly testId: string;
  readonly decidedAt: string;
  readonly detail?: string;
}

export interface CuaEvidenceInput {
  readonly choice?: CuaVerdictChoice;
  readonly snapshotPng?: Buffer | string;
  readonly elementsJson?: string | readonly CuaElementRecord[];
  readonly verdict?: CuaEvidenceVerdict;
  readonly recording?: Buffer | string;
}

function evidenceDirFor(testId: string): string {
  return resolve(process.cwd(), 'evidence', 'cua-jev', testId);
}

function toRelative(p: string): string {
  return p.split('\\').join('/').replace(/^\//, '');
}

function relativeToCwd(abs: string): string {
  const cwd = resolve(process.cwd()).split('\\').join('/');
  const fwd = abs.split('\\').join('/');
  return fwd.startsWith(cwd + '/') ? fwd.slice(cwd.length + 1) : fwd;
}

function writeAtomic(absPath: string, data: Buffer | string): void {
  mkdirSync(dirname(absPath), { recursive: true });
  const tmp = absPath + '.tmp';
  writeFileSync(tmp, data);
  renameSync(tmp, absPath);
}

function scrubSecretsText(text: string): string {
  let out = text;
  const key = process.env['TYPESAFE_API_KEY'];
  if (key !== undefined && key.length > 0) {
    out = out.split(key).join('[REDACTED]');
  }
  out = out.replace(/data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]+/g, '[REDACTED_IMAGE]');
  return out;
}

function scrubValue(value: string | number | boolean | null): string | number | boolean | null {
  if (typeof value === 'string') return scrubSecretsText(value);
  return value;
}

type JsonScalar = string | number | boolean | null;
interface JsonRecord {
  readonly [key: string]: JsonScalar | JsonRecord | readonly JsonScalar[];
}

function isSecretKey(key: string): boolean {
  return /api[_-]?key|secret|password|pin|token/i.test(key);
}

function scrubRecord(record: JsonRecord): JsonRecord {
  const out: Record<string, JsonScalar | JsonRecord | readonly JsonScalar[]> = {};
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (value === undefined) continue;
    if (isSecretKey(key)) {
      out[key] = '[REDACTED]';
    } else if (Array.isArray(value)) {
      out[key] = value.map((v) => scrubValue(v));
    } else if (typeof value === 'object' && value !== null) {
      // SAFETY: the Array.isArray branch above handles every array at runtime,
      // so a non-null object here is always a JsonRecord; the readonly-array
      // survivor in the static type is an Array.isArray narrowing limitation.
      out[key] = scrubRecord(value as JsonRecord);
    } else if (typeof value === 'string') {
      out[key] = scrubSecretsText(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function toPngBuffer(snapshotPng: Buffer | string): Buffer {
  if (Buffer.isBuffer(snapshotPng)) return snapshotPng;
  const comma = snapshotPng.indexOf(',');
  const b64 = comma >= 0 ? snapshotPng.slice(comma + 1) : snapshotPng;
  return Buffer.from(b64, 'base64');
}

function toRecordingBuffer(recording: Buffer | string): Buffer {
  if (Buffer.isBuffer(recording)) return recording;
  return Buffer.from(recording, 'base64');
}

/**
 * Persist CUA-JEV evidence under evidence/cua-jev/<testId>/.
 * Always writes verdict.json + elements.json; writes failure.png only on
 * fail with a snapshot; writes recording.mp4 when a recording is supplied,
 * otherwise frames.json + NOTE explaining the recorder was absent.
 */
export function writeCuaEvidence(testId: string, input: CuaEvidenceInput = {}): string[] {
  const dir = evidenceDirFor(testId);
  mkdirSync(dir, { recursive: true });
  const written: string[] = [toRelative(relativeToCwd(dir) + '/')];

  const choice: CuaVerdictChoice = input.verdict?.choice ?? input.choice ?? 'needs_review';
  const decidedAt = new Date().toISOString();
  const verdictBase: JsonRecord = {
    testId,
    choice,
    decidedAt,
    ...(input.verdict?.detail !== undefined ? { detail: input.verdict.detail } : {}),
  };
  const verdictJson = JSON.stringify(scrubRecord(verdictBase), null, 2) + '\n';
  const verdictPath = join(dir, 'verdict.json');
  writeAtomic(verdictPath, scrubSecretsText(verdictJson));
  written.push(relativeToCwd(verdictPath));

  const elementsText =
    typeof input.elementsJson === 'string'
      ? input.elementsJson
      : JSON.stringify(input.elementsJson ?? [], null, 2) + '\n';
  const elementsPath = join(dir, 'elements.json');
  writeAtomic(elementsPath, scrubSecretsText(elementsText));
  written.push(relativeToCwd(elementsPath));

  if (choice === 'fail' && input.snapshotPng !== undefined) {
    const pngPath = join(dir, 'failure.png');
    writeAtomic(pngPath, toPngBuffer(input.snapshotPng));
    written.push(relativeToCwd(pngPath));
  }

  if (input.recording !== undefined) {
    const recPath = join(dir, 'recording.mp4');
    writeAtomic(recPath, toRecordingBuffer(input.recording));
    written.push(relativeToCwd(recPath));
  } else {
    const framesPath = join(dir, 'frames.json');
    const framesJson =
      JSON.stringify({ testId, recordedAt: decidedAt, frames: [], note: 'recorder absent' }, null, 2) + '\n';
    writeAtomic(framesPath, scrubSecretsText(framesJson));
    written.push(relativeToCwd(framesPath));
    const notePath = join(dir, 'NOTE');
    writeAtomic(notePath, 'recorder absent: no recording.mp4 captured for ' + testId + '\n');
    written.push(relativeToCwd(notePath));
  }

  return written.map((p) => toRelative(p));
}

export function saveEvidence(testId: string, input: CuaEvidenceInput = {}): string[] {
  return writeCuaEvidence(testId, input);
}
