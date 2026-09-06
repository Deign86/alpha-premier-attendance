import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function photoDir(): string {
  const base = process.env.PHOTO_STORAGE_DIR?.trim()
    || path.join(os.homedir(), '.rfid-attendance', 'photos');
  return path.resolve(base);
}

function safeUserId(userId: string): string {
  const clean = userId.trim();
  if (!clean || clean.length > 100 || !/^[A-Za-z0-9._-]+$/.test(clean)) throw new Error('Invalid userId');
  return clean;
}

export async function uploadPhotoDataUrl(userId: string, dataUrl: string): Promise<string> {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
  if (!match) throw new Error('Photo must be a JPEG, PNG, or WebP data URL');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > 500_000) throw new Error('Photo must be no larger than 500 KB');
  const mime = match[1].toLowerCase();
  const extension = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1];
  const dir = path.join(photoDir(), 'users', safeUserId(userId));
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${crypto.randomUUID()}.${extension}`);
  await fs.promises.writeFile(file, bytes);
  return file;
}
