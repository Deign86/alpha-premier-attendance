/** Convert reader formats (spaces, colons, dashes) to a stable uppercase UID. */
export function normalizeRfidUid(value: string): string {
  if (typeof value !== 'string') throw new Error('RFID UID must be a string');
  const normalized = value.trim().replace(/[\s:-]/g, '').toUpperCase();
  if (!normalized || normalized.length < 4 || normalized.length > 64 || !/^[0-9A-F]+$/.test(normalized)) {
    throw new Error('RFID UID must be 4-64 hexadecimal characters');
  }
  return normalized;
}
