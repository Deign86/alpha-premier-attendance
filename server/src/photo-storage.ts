import crypto from 'node:crypto';
import { put } from '@vercel/blob';

export async function uploadPhotoDataUrl(userId: string, dataUrl: string): Promise<string> {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
  if (!match) throw new Error('Photo must be a JPEG, PNG, or WebP data URL');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > 500_000) throw new Error('Photo must be no larger than 500 KB');
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('Photo storage is not configured');
  const extension = match[1].split('/')[1].replace('jpeg', 'jpg');
  const result = await put(`users/${userId}/${crypto.randomUUID()}.${extension}`, bytes, { access: 'public', contentType: match[1], token: process.env.BLOB_READ_WRITE_TOKEN, addRandomSuffix: false });
  return result.url;
}
