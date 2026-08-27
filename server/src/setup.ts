import crypto from 'node:crypto';
import { normalizeName } from '@rfid-attendance/shared';
import type { GoogleSheetsService, SheetUser } from './sheets.js';
import { normalizeRfidUid } from './rfid.js';

export const setupErrorCodes = [
  'SETUP_DISABLED',
  'INVALID_SETUP_PIN',
  'SETUP_AUTH_REQUIRED',
  'SETUP_SESSION_EXPIRED',
  'SETUP_VALIDATION_ERROR',
  'USER_CONFLICT',
  'GOOGLE_SHEETS_UNAVAILABLE',
] as const;
export type SetupErrorCode = 'SETUP_DISABLED' | 'INVALID_SETUP_PIN' | 'SETUP_AUTH_REQUIRED' | 'SETUP_SESSION_EXPIRED' | 'SETUP_VALIDATION_ERROR' | 'USER_CONFLICT' | 'GOOGLE_SHEETS_UNAVAILABLE';

export class SetupError extends Error {
  constructor(readonly code: SetupErrorCode, message: string, readonly status = 400) {
    super(message);
    this.name = 'SetupError';
  }
  toResponse(requestId: string) {
    return { success: false as const, requestId, error: { code: this.code, message: this.message } };
  }
}

export type SetupConfig = {
  enableCardSetup?: boolean;
  setupAdminPin?: string;
  setupSessionMinutes?: number;
};

import type { CardType } from '@rfid-attendance/shared';

export type SetupUserInput = {
  userId?: string;
  fullName?: string;
  rfidUid: string;
  department?: string | null;
  status?: 'ACTIVE' | 'INACTIVE';
  employeeType?: 'INTERN' | 'EMPLOYEE';
  gender?: 'MALE' | 'FEMALE' | null;
  dailyRate?: number | null;
  photoUrl?: string | null;
  cardType?: CardType;
  label?: string | null;
};

type TokenRecord = { expiresAtMs: number };
type Clock = () => Date;

export interface SetupUnlockResult {
  setupToken: string;
  expiresAt: string;
}

export class SetupService {
  private readonly tokens = new Map<string, TokenRecord>();
  private now: Clock;

  constructor(private readonly sheets: GoogleSheetsService, private readonly config: SetupConfig, now: Clock = () => new Date()) {
    this.now = now;
  }

  setNowProvider(now: Clock): void { this.now = now; }
  authorize(token: string | undefined): void { this.requireToken(token); }

  async unlock<T>(pin: T): Promise<SetupUnlockResult> {
    this.assertEnabled();
    let authenticated = false;
    if (isString(pin)) {
      const trimmed = pin.trim();
      if (this.constantTimePinEqual(trimmed, this.config.setupAdminPin ?? '')) {
        authenticated = true;
      } else {
        try {
          const normalized = normalizeRfidUid(trimmed);
          const user = await this.sheets.findUserByUid(normalized);
          if (user && user.active && user.cardType === 'ADMIN_ASSIST') {
            authenticated = true;
          }
        } catch {
          // Not a valid RFID UID or user not found
        }
      }
    }
    if (!authenticated) {
      throw new SetupError('INVALID_SETUP_PIN', 'The setup PIN is invalid.', 401);
    }
    const setupToken = crypto.randomBytes(32).toString('hex');
    const expiresAtMs = this.now().getTime() + (this.config.setupSessionMinutes ?? 15) * 60_000;
    this.tokens.set(setupToken, { expiresAtMs });
    return { setupToken, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  lock(token: string | undefined): void {
    const validToken = this.requireToken(token);
    this.tokens.delete(validToken);
  }

  async lookupCard(token: string | undefined, rawUid: string): Promise<{ rfidUid: string; user: SheetUser | null }> {
    this.requireToken(token);
    let rfidUid: string;
    try { rfidUid = normalizeRfidUid(rawUid); } catch { throw new SetupError('SETUP_VALIDATION_ERROR', 'rfidUid must be a valid hexadecimal UID.', 400); }
    try {
      const user = await this.sheets.findUserByUid(rfidUid);
      return { rfidUid, user };
    } catch {
      throw new SetupError('GOOGLE_SHEETS_UNAVAILABLE', 'User data is temporarily unavailable.', 503);
    }
  }

  async upsertUser<T>(token: string | undefined, input: T): Promise<{ user: SheetUser; created: boolean }> {
    this.requireToken(token);
    const value = parseSetupUserInput(input);
    if (value === null) throw new SetupError('SETUP_VALIDATION_ERROR', 'A user object is required.', 400);
    const isAssist = value.cardType === 'ADMIN_ASSIST';
    let rfidUid: string;
    try { rfidUid = normalizeRfidUid(value.rfidUid); } catch { throw new SetupError('SETUP_VALIDATION_ERROR', 'rfidUid must be a valid hexadecimal UID.', 400); }
    const userId = (value.userId?.trim() || (isAssist ? `ADMIN_CARD_${rfidUid}` : '')).toUpperCase();
    const fullName = value.fullName?.trim() || (isAssist ? (value.label?.trim() || 'Admin Assist Card') : '');
    const status = value.status ?? 'ACTIVE';
    if (!userId || !fullName || (status !== 'ACTIVE' && status !== 'INACTIVE')) {
      throw new SetupError('SETUP_VALIDATION_ERROR', 'userId, fullName, and rfidUid are required.', 400);
    }
    const byUid = await this.sheets.findUserByUid(rfidUid);
    if (byUid && byUid.userId !== userId) {
      throw new SetupError('USER_CONFLICT', 'That RFID card is already assigned to another user.', 409);
    }
    const existing = await this.sheets.findUserById(userId);
    const employeeType = isAssist ? 'EMPLOYEE' : (value.employeeType ?? existing?.employeeType ?? 'INTERN');
    const dailyRate = !isAssist && employeeType === 'EMPLOYEE' ? value.dailyRate : null;
    if (!isAssist && employeeType === 'EMPLOYEE' && (!Number.isFinite(dailyRate) || (dailyRate ?? 0) <= 0)) {
      throw new SetupError('SETUP_VALIDATION_ERROR', 'Employees require a positive daily rate.', 400);
    }
    if (value.gender !== undefined && value.gender !== null && value.gender !== 'MALE' && value.gender !== 'FEMALE') {
      throw new SetupError('SETUP_VALIDATION_ERROR', 'Gender must be MALE or FEMALE.', 400);
    }
    if (value.photoUrl !== undefined && value.photoUrl !== null && !isPhotoUrl(value.photoUrl)) {
      throw new SetupError('SETUP_VALIDATION_ERROR', 'Photo URL must be HTTPS.', 400);
    }
    const user: SheetUser = {
      userId,
      fullName: normalizeName(fullName),
      rfidUid,
      department: isAssist ? (value.department?.trim() || 'Admin') : (isString(value.department) && value.department.trim() ? value.department.trim().replace(/\s+/g, ' ') : null),
      active: status === 'ACTIVE',
      employeeType,
      gender: isAssist ? null : (value.gender === undefined ? existing?.gender ?? null : value.gender),
      dailyRate,
      photoUrl: isAssist ? null : (value.photoUrl === undefined ? existing?.photoUrl ?? null : isPhotoUrl(value.photoUrl) ? value.photoUrl : null),
      cardType: value.cardType ?? 'EMPLOYEE',
    };
    try {
      const saved = await this.sheets.upsertUser(user);
      return { user: saved, created: existing === null };
    } catch (error) {
      if (error instanceof Error && /duplicate.*uid|duplicate.*rfid/i.test(error.message)) {
        throw new SetupError('USER_CONFLICT', 'That RFID card is already assigned to another user.', 409);
      }
      throw new SetupError('GOOGLE_SHEETS_UNAVAILABLE', 'User data is temporarily unavailable.', 503);
    }
  }

  private assertEnabled(): void {
    if (!this.config.enableCardSetup) throw new SetupError('SETUP_DISABLED', 'Card setup is disabled.', 403);
    if (!this.config.setupAdminPin) throw new SetupError('SETUP_DISABLED', 'Card setup is not configured.', 403);
  }

  private requireToken(token: string | undefined): string {
    this.assertEnabled();
    if (!isString(token) || !token) throw new SetupError('SETUP_AUTH_REQUIRED', 'A setup token is required.', 401);
    const record = this.tokens.get(token);
    if (!record) throw new SetupError('SETUP_AUTH_REQUIRED', 'The setup session is invalid.', 401);
    if (this.now().getTime() >= record.expiresAtMs) {
      this.tokens.delete(token);
      throw new SetupError('SETUP_SESSION_EXPIRED', 'The setup session has expired.', 401);
    }
    return token;
  }

  private constantTimePinEqual(input: string, expected: string): boolean {
    const inputHash = crypto.createHash('sha256').update(input).digest();
    const expectedHash = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(inputHash, expectedHash);
  }
}

type SetupInputValue = string | number | boolean | bigint | symbol | null | undefined;
function isString<T>(value: T): value is T & string { return Object(value) !== value && Object.prototype.toString.call(value) === '[object String]'; }
function isNumber(value: SetupInputValue): value is number { return Object(value) !== value && Object.prototype.toString.call(value) === '[object Number]' && Number.isFinite(value); }
interface SetupInputObject {
  userId?: SetupInputValue;
  fullName?: SetupInputValue;
  rfidUid?: SetupInputValue;
  department?: SetupInputValue;
  status?: SetupInputValue;
  employeeType?: SetupInputValue;
  gender?: SetupInputValue;
  dailyRate?: SetupInputValue;
  photoUrl?: SetupInputValue;
  cardType?: SetupInputValue;
  label?: SetupInputValue;
}
function isSetupInputObject<T>(value: T): value is T & SetupInputObject { return value !== null && Object(value) === value && !Array.isArray(value) && !(value instanceof Function); }
function isPhotoUrl(value: SetupInputValue): value is string { return isString(value) && /^https:\/\//i.test(value); }

function parseSetupUserInput<T>(input: T): SetupUserInput | null {
  if (!isSetupInputObject(input)) return null;
  const rfidUid = input.rfidUid;
  if (!isString(rfidUid)) return null;

  const cardType = input.cardType === 'ADMIN_ASSIST' ? 'ADMIN_ASSIST' : 'EMPLOYEE';
  const label = isString(input.label) ? input.label : undefined;
  const status = input.status === undefined && cardType === 'ADMIN_ASSIST' ? 'ACTIVE' : input.status;
  if (status !== 'ACTIVE' && status !== 'INACTIVE') return null;

  const userId = isString(input.userId) ? input.userId : undefined;
  const fullName = isString(input.fullName) ? input.fullName : undefined;

  if (cardType === 'EMPLOYEE' && (!userId || !fullName)) {
    return null;
  }

  const department = input.department;
  const employeeType = input.employeeType;
  const gender = input.gender;
  const dailyRate = input.dailyRate;
  const photoUrl = input.photoUrl;
  if (department !== undefined && department !== null && !isString(department)) return null;
  if (employeeType !== undefined && employeeType !== 'INTERN' && employeeType !== 'EMPLOYEE') return null;
  if (gender !== undefined && gender !== null && gender !== 'MALE' && gender !== 'FEMALE') return null;
  if (dailyRate !== undefined && dailyRate !== null && !isNumber(dailyRate)) return null;
  if (photoUrl !== undefined && photoUrl !== null && !isString(photoUrl)) return null;
  return { userId, fullName, rfidUid, department, status, employeeType, gender, dailyRate, photoUrl, cardType, label };
}

export function setupTokenFromRequest(headers: { authorization?: string; 'x-setup-token'?: string }): string | undefined {
  const bearer = headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  return bearer || headers['x-setup-token'];
}
