import { isValidTimezone } from './time.js';
import { DEFAULT_OFFICE_IDENTITY, resolveOfficeDisplay, type OfficeIdentity } from '@rfid-attendance/shared';

export type AppConfig = {
  timezone: string;
  rfidAutoSubmitDelayMs: number;
  resultResetDelayMs: number;
  scanCooldownMs: number;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  host?: string;
  port: number;
  corsOrigin: string;
  sheetsMode: 'memory' | 'google';
  googleSheetsId?: string;
  googleServiceAccountEmail?: string;
  googlePrivateKey?: string;
  enableCardSetup: boolean;
  setupAdminPin?: string;
  setupSessionMinutes: number;
  enableAdmin?: boolean;
  adminPin?: string;
  adminSessionSecret?: string;
  adminSessionMinutes?: number;
  /** Canonical office identity used for place labels, exports, and reports. */
  office?: OfficeIdentity;
};

function numberEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 0): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min) throw new Error(`${name} must be a number >= ${min}`);
  return parsed;
}

function boolEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} must be true or false`);
}

function officeEnv(env: NodeJS.ProcessEnv): OfficeIdentity {
  const read = (name: string) => env[name]?.trim() ?? '';
  const office = {
    ...DEFAULT_OFFICE_IDENTITY,
    companyName: read('COMPANY_NAME') || DEFAULT_OFFICE_IDENTITY.companyName,
    officeLabel: read('OFFICE_LABEL') || DEFAULT_OFFICE_IDENTITY.officeLabel,
    officeAddressLine1: read('OFFICE_ADDRESS_LINE_1') || DEFAULT_OFFICE_IDENTITY.officeAddressLine1,
    officeBuilding: read('OFFICE_BUILDING') || DEFAULT_OFFICE_IDENTITY.officeBuilding,
    officeDistrict: read('OFFICE_DISTRICT') || DEFAULT_OFFICE_IDENTITY.officeDistrict,
    officeCity: read('OFFICE_CITY') || DEFAULT_OFFICE_IDENTITY.officeCity,
    officeRegion: read('OFFICE_REGION') || DEFAULT_OFFICE_IDENTITY.officeRegion,
    officeCountry: read('OFFICE_COUNTRY') || DEFAULT_OFFICE_IDENTITY.officeCountry,
    officePostalCode: read('OFFICE_POSTAL_CODE'),
    officeDisplayShort: read('OFFICE_DISPLAY_SHORT'),
    officeDisplayFull: read('OFFICE_DISPLAY_FULL'),
  };
  // Display strings are derived from the same source of truth when not configured.
  office.officeDisplayShort = resolveOfficeDisplay(office, 'short');
  office.officeDisplayFull = resolveOfficeDisplay(office, 'full');
  return office;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const timezone = env.TIMEZONE || env.APP_TIMEZONE || 'Asia/Manila';
  if (!isValidTimezone(timezone)) throw new Error(`TIMEZONE is invalid: ${timezone}`);
  const hasGoogleConfig = Boolean(env.GOOGLE_SHEET_ID && env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_PRIVATE_KEY);
  const requestedMode = (env.SHEETS_MODE || '').toLowerCase();
  const sheetsMode = requestedMode || (hasGoogleConfig ? 'google' : 'memory');
  if (sheetsMode !== 'memory' && sheetsMode !== 'google') throw new Error('SHEETS_MODE must be memory or google');
  const config: AppConfig = {
    timezone,
    rfidAutoSubmitDelayMs: numberEnv(env, 'RFID_AUTO_SUBMIT_DELAY_MS', 150),
    resultResetDelayMs: numberEnv(env, 'RESULT_RESET_DELAY_MS', 4000),
    scanCooldownMs: numberEnv(env, 'SCAN_COOLDOWN_SECONDS', 10, 0) * 1000,
    rateLimitWindowMs: numberEnv(env, 'RATE_LIMIT_WINDOW_MS', 60_000, 1000),
    rateLimitMax: numberEnv(env, 'RATE_LIMIT_MAX', 60, 1),
    host: env.HOST || env.BIND_HOST || '0.0.0.0',
    port: numberEnv(env, 'PORT', 3001, 1),
    corsOrigin: env.CLIENT_ORIGIN || env.CORS_ORIGIN || 'http://localhost:5173',
    sheetsMode,
    googleSheetsId: env.GOOGLE_SHEET_ID || env.GOOGLE_SHEETS_ID,
    googleServiceAccountEmail: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    googlePrivateKey: env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    enableCardSetup: boolEnv(env, 'ENABLE_CARD_SETUP', false),
    setupAdminPin: env.SETUP_ADMIN_PIN,
    setupSessionMinutes: numberEnv(env, 'SETUP_SESSION_MINUTES', 15, 1),
    enableAdmin: boolEnv(env, 'ENABLE_ADMIN', boolEnv(env, 'ENABLE_CARD_SETUP', false)),
    adminPin: env.ADMIN_PIN || env.SETUP_ADMIN_PIN,
    adminSessionSecret: env.ADMIN_SESSION_SECRET || env.SETUP_SESSION_SECRET,
    adminSessionMinutes: numberEnv(env, 'ADMIN_SESSION_MINUTES', numberEnv(env, 'SETUP_SESSION_MINUTES', 15, 1), 1),
    office: officeEnv(env),
  };
  if (sheetsMode === 'google') {
    if (!config.googleSheetsId || !config.googleServiceAccountEmail || !config.googlePrivateKey) {
      throw new Error('Google Sheets mode requires GOOGLE_SHEETS_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, and GOOGLE_PRIVATE_KEY');
    }
  }
  if (env.NODE_ENV === 'production' && sheetsMode !== 'google') {
    throw new Error('Production requires Google Sheets configuration');
  }
  if (config.enableCardSetup && !config.setupAdminPin) {
    throw new Error('ENABLE_CARD_SETUP requires SETUP_ADMIN_PIN');
  }
  if (config.enableAdmin && (!config.adminPin || !config.adminSessionSecret)) {
    throw new Error('ENABLE_ADMIN requires ADMIN_PIN and ADMIN_SESSION_SECRET');
  }
  return config;
}

export function safeConfig(config: AppConfig) {
  return {
    success: true as const,
    timezone: config.timezone,
    rfidAutoSubmitDelayMs: config.rfidAutoSubmitDelayMs,
    resultResetDelayMs: config.resultResetDelayMs,
    enableCardSetup: config.enableCardSetup,
    enableAdmin: config.enableAdmin ?? config.enableCardSetup,
    office: config.office ?? DEFAULT_OFFICE_IDENTITY,
  };
}
