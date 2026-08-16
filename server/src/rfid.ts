/** Convert reader formats (spaces, colons, dashes) to a stable uppercase UID. */
export function normalizeRfidUid(value: unknown): string {
  if (!isString(value)) throw new Error('RFID UID must be a string');
  const normalized = value.trim().replace(/[\s:-]/g, '').toUpperCase();
  if (!normalized || normalized.length < 4 || normalized.length > 64 || !/^[0-9A-F]+$/.test(normalized)) {
    throw new Error('RFID UID must be 4-64 hexadecimal characters');
  }
  return normalized;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
