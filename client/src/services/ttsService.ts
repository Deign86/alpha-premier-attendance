import type {
  ArrivalStatus,
  BathroomGenderKey,
  TtsEngine,
  TtsSettings,
  TtsSpeakOptions,
  TtsSpeakResult,
  TtsStatusResponse,
} from '@rfid-attendance/shared';
import { ATTENDANCE_TIMEZONE } from '@rfid-attendance/shared';
import { tauriApi } from '../tauri-api';

const TTS_STORAGE_KEY = 'alpha_premier_tts_settings';

export const DEFAULT_TTS_SETTINGS: TtsSettings = {
  enabled: true,
  engine: 'auto',
  voiceModel: 'en_US-amy-medium',
  rate: 1.0,
  volume: 1.0,
};

export const AVAILABLE_VOICE_MODELS = [
  { id: 'en_US-amy-medium', label: 'Amy (Professional & Warm Female Voice)' },
  { id: 'en_US-lessac-medium', label: 'Lessac (Natural US English, Balanced)' },
  { id: 'en_US-libritts_r-medium', label: 'LibriTTS (Studio Quality Voice)' },
  { id: 'en_US-hfc_female-medium', label: 'HFC Female (Clear Office Voice)' },
] as const;

type SerializedTtsSettings = {
  enabled?: boolean;
  engine?: string;
  voiceModel?: string;
  rate?: number;
  volume?: number;
};

export function isTtsEngine(value?: string): value is TtsEngine {
  return value === 'auto' || value === 'piper' || value === 'system' || value === 'disabled';
}

function parseStoredTtsSettings(raw: string): TtsSettings {
  try {
    // SAFETY: Parsed JSON payload is checked field-by-field before constructing domain object
    const parsed = JSON.parse(raw) as SerializedTtsSettings;
    if (!parsed || Object.prototype.toString.call(parsed) !== '[object Object]') {
      return DEFAULT_TTS_SETTINGS;
    }

    const enabled = parsed.enabled === true || parsed.enabled === false
      ? parsed.enabled
      : DEFAULT_TTS_SETTINGS.enabled;

    const engine = isTtsEngine(parsed.engine)
      ? parsed.engine
      : DEFAULT_TTS_SETTINGS.engine;

    const voiceModel = parsed.voiceModel && parsed.voiceModel.trim().length > 0
      ? parsed.voiceModel.trim()
      : DEFAULT_TTS_SETTINGS.voiceModel;

    const rateNum = Number(parsed.rate);
    const rate = Number.isFinite(rateNum)
      ? Math.min(Math.max(rateNum, 0.5), 2.0)
      : DEFAULT_TTS_SETTINGS.rate;

    const volumeNum = Number(parsed.volume);
    const volume = Number.isFinite(volumeNum)
      ? Math.min(Math.max(volumeNum, 0.0), 1.0)
      : DEFAULT_TTS_SETTINGS.volume;

    return { enabled, engine, voiceModel, rate, volume };
  } catch {
    return DEFAULT_TTS_SETTINGS;
  }
}

/**
 * Loads TTS settings from localStorage with safe fallback to defaults.
 */
export function loadTtsSettings(): TtsSettings {
  if (!('window' in globalThis) || !('localStorage' in window)) {
    return DEFAULT_TTS_SETTINGS;
  }
  try {
    const raw = window.localStorage.getItem(TTS_STORAGE_KEY);
    if (!raw) return DEFAULT_TTS_SETTINGS;
    return parseStoredTtsSettings(raw);
  } catch {
    return DEFAULT_TTS_SETTINGS;
  }
}

/**
 * Persists TTS settings into localStorage.
 */
export function saveTtsSettings(settings: TtsSettings): void {
  if (!('window' in globalThis) || !('localStorage' in window)) return;
  try {
    window.localStorage.setItem(TTS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage quota errors
  }
}

/**
 * Sanitizes speech text to eliminate ASCII control bytes, collapse extra whitespace,
 * and enforce a maximum character length.
 */
export function sanitizeTextForSpeech(text: string, maxLen = 300): string {
  if (!text) return '';

  const chars: string[] = [];
  let lastWasSpace = false;

  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    // ASCII control codes 0..31 or 127
    if ((code >= 0 && code <= 31) || code === 127) {
      if (code === 9 || code === 10 || code === 13) {
        if (!lastWasSpace) {
          chars.push(' ');
          lastWasSpace = true;
        }
      }
      continue;
    }

    const char = text.charAt(i);
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      if (!lastWasSpace) {
        chars.push(' ');
        lastWasSpace = true;
      }
    } else {
      chars.push(char);
      lastWasSpace = false;
    }
  }

  const result = chars.join('').trim();
  return result.length > maxLen ? result.slice(0, maxLen).trimEnd() : result;
}

export type AttendancePhraseOptions = {
  attendanceType: 'time_in' | 'time_out';
  employeeName?: string | null;
  arrivalStatus?: ArrivalStatus | null;
  isLateTimeout?: boolean | null;
  isAssisted?: boolean;
  timeInIso?: string | null;
  greeting?: string;
};

export type AnnounceAttendanceOptions = AttendancePhraseOptions & {
  settings?: TtsSettings;
};

export type BathroomPhraseOptions = {
  action: 'CHECKOUT' | 'RETURN';
  genderKey: BathroomGenderKey;
  employeeName?: string | null;
};

export type AnnounceBathroomOptions = BathroomPhraseOptions & {
  settings?: TtsSettings;
};

export type ScanErrorPhraseOptions = {
  errorCode: string;
  message?: string;
  activeHolderName?: string | null;
  genderKey?: BathroomGenderKey | null;
};

export type AnnounceScanErrorOptions = ScanErrorPhraseOptions & {
  settings?: TtsSettings;
};

function getGreetingForTime(timeIso?: string | null): string {
  if (!timeIso) return 'Good morning';
  try {
    const d = new Date(timeIso);
    if (!Number.isFinite(d.getTime())) return 'Good morning';
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: ATTENDANCE_TIMEZONE,
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(d);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  } catch {
    return 'Good morning';
  }
}

/**
 * Generates the appropriate attendance announcement phrase.
 *
 * Supports grace period notes, late arrival notes, late time-out notices,
 * and admin assisted prefixing.
 */
export function buildAttendancePhrase(
  typeOrOptions: 'time_in' | 'time_out' | AttendancePhraseOptions,
  legacyEmployeeName?: string | null,
  legacyOptions?: Partial<AttendancePhraseOptions>,
): string {
  const options: AttendancePhraseOptions =
    typeOrOptions === 'time_in' || typeOrOptions === 'time_out'
      ? {
          attendanceType: typeOrOptions,
          employeeName: legacyEmployeeName,
          ...legacyOptions,
        }
      : typeOrOptions;

  const cleanName = sanitizeTextForSpeech(options.employeeName ?? '', 100);
  const assistedPrefix = options.isAssisted ? 'assisted ' : '';

  if (options.attendanceType === 'time_in') {
    const greeting = options.greeting || getGreetingForTime(options.timeInIso);

    if (options.arrivalStatus === 'GRACE_PERIOD') {
      if (cleanName.length > 0) {
        return `${greeting}, ${cleanName}. Your ${assistedPrefix}time in has been recorded. You made it within the grace period.`;
      }
      return `Your ${assistedPrefix}time in has been recorded within the grace period.`;
    }

    if (options.arrivalStatus === 'LATE') {
      if (cleanName.length > 0) {
        return `${greeting}, ${cleanName}. Your ${assistedPrefix}time in has been recorded. You are late.`;
      }
      return `Your ${assistedPrefix}time in has been recorded. You are late.`;
    }

    if (cleanName.length > 0) {
      return `${greeting}, ${cleanName}. Your ${assistedPrefix}time in has been recorded.`;
    }
    return `Your ${assistedPrefix}time in has been recorded.`;
  }

  // time_out
  if (options.isLateTimeout) {
    if (cleanName.length > 0) {
      return `Goodbye, ${cleanName}. Your ${assistedPrefix}time out was recorded after office hours. Manual correction is required.`;
    }
    return `Your ${assistedPrefix}time out was recorded after office hours. Manual correction is required.`;
  }

  if (cleanName.length > 0) {
    return `Goodbye, ${cleanName}. Your ${assistedPrefix}time out has been recorded.`;
  }
  return `Your ${assistedPrefix}time out has been recorded.`;
}

/**
 * Generates bathroom key checkout or return announcement phrases.
 */
export function buildBathroomPhrase({
  action,
  genderKey,
  employeeName,
}: BathroomPhraseOptions): string {
  const cleanName = sanitizeTextForSpeech(employeeName ?? '', 100);
  const genderLabel = genderKey === 'MALE' ? 'Male' : 'Female';

  if (action === 'CHECKOUT') {
    if (cleanName.length > 0) {
      return `${genderLabel} bathroom key checked out for ${cleanName}.`;
    }
    return `${genderLabel} bathroom key checked out.`;
  }

  if (cleanName.length > 0) {
    return `Thank you, ${cleanName}. ${genderLabel} bathroom key returned.`;
  }
  return `${genderLabel} bathroom key returned.`;
}

/**
 * Generates clear spoken feedback for scan errors.
 */
export function buildScanErrorPhrase({
  errorCode,
  message,
  activeHolderName,
  genderKey,
}: ScanErrorPhraseOptions): string {
  if (errorCode === 'BATHROOM_KEY_IN_USE') {
    const cleanHolder = sanitizeTextForSpeech(activeHolderName ?? '', 100);
    const genderPrefix = genderKey ? `${genderKey === 'MALE' ? 'male' : 'female'} ` : '';
    if (cleanHolder.length > 0) {
      return `The ${genderPrefix}bathroom key is currently in use by ${cleanHolder}.`;
    }
    return `The ${genderPrefix}bathroom key is currently in use.`;
  }

  if (errorCode === 'UNKNOWN_RFID_CARD' || errorCode === 'USER_NOT_FOUND') {
    return 'This card is not registered.';
  }

  if (errorCode === 'INACTIVE_USER' || errorCode === 'USER_INACTIVE') {
    return 'Employee record is inactive.';
  }

  if (errorCode === 'DUPLICATE_SCAN') {
    return 'Card scanned too recently. Please wait.';
  }

  if (errorCode === 'ADMIN_CARD_NOT_ALLOWED') {
    return 'Admin cards cannot check out bathroom keys.';
  }

  if (errorCode === 'ADMIN_CARD_REQUIRES_SELECTION') {
    return 'Admin card requires employee selection.';
  }

  if (errorCode === 'ATTENDANCE_ALREADY_COMPLETED') {
    if (
      message &&
      (message.toLowerCase().includes('office hours') ||
        message.toLowerCase().includes('correction'))
    ) {
      return 'Attendance timed out after office hours and is pending manual correction.';
    }
    return 'Attendance is already completed for today.';
  }

  if (errorCode === 'GOOGLE_SHEETS_UNAVAILABLE') {
    return 'Attendance service is temporarily unavailable.';
  }

  if (errorCode === 'ATTENDANCE_DATA_CONFLICT') {
    return 'Attendance conflict. Please try again.';
  }

  if (message && message.trim().length > 0) {
    return sanitizeTextForSpeech(message, 120);
  }

  return 'Scan could not be processed.';
}

/**
 * Non-blocking offline TTS voice announcement for attendance events.
 */
export async function announceAttendance(
  options: AnnounceAttendanceOptions,
): Promise<TtsSpeakResult | null> {
  const activeSettings = options.settings ?? loadTtsSettings();

  if (!activeSettings.enabled || activeSettings.engine === 'disabled') {
    return null;
  }

  const phrase = buildAttendancePhrase(options);
  return speakText(phrase, {
    engine: activeSettings.engine,
    voiceModel: activeSettings.voiceModel,
    rate: activeSettings.rate,
    volume: activeSettings.volume,
  });
}

/**
 * Non-blocking offline TTS voice announcement for bathroom key checkout and returns.
 */
export async function announceBathroom(
  options: AnnounceBathroomOptions,
): Promise<TtsSpeakResult | null> {
  const activeSettings = options.settings ?? loadTtsSettings();

  if (!activeSettings.enabled || activeSettings.engine === 'disabled') {
    return null;
  }

  const phrase = buildBathroomPhrase(options);
  return speakText(phrase, {
    engine: activeSettings.engine,
    voiceModel: activeSettings.voiceModel,
    rate: activeSettings.rate,
    volume: activeSettings.volume,
  });
}

/**
 * Non-blocking offline TTS voice announcement when an Admin Assist card is recognized.
 */
export async function announceAdminAssist(
  settings?: TtsSettings,
): Promise<TtsSpeakResult | null> {
  const activeSettings = settings ?? loadTtsSettings();

  if (!activeSettings.enabled || activeSettings.engine === 'disabled') {
    return null;
  }

  return speakText('Admin assist card recognized. Please select an employee.', {
    engine: activeSettings.engine,
    voiceModel: activeSettings.voiceModel,
    rate: activeSettings.rate,
    volume: activeSettings.volume,
  });
}

/**
 * Non-blocking offline TTS voice announcement for scan error feedback.
 */
export async function announceScanError(
  options: AnnounceScanErrorOptions,
): Promise<TtsSpeakResult | null> {
  const activeSettings = options.settings ?? loadTtsSettings();

  if (!activeSettings.enabled || activeSettings.engine === 'disabled') {
    return null;
  }

  const phrase = buildScanErrorPhrase(options);
  return speakText(phrase, {
    engine: activeSettings.engine,
    voiceModel: activeSettings.voiceModel,
    rate: activeSettings.rate,
    volume: activeSettings.volume,
  });
}

/**
 * Speaks arbitrary text using local backend TTS engines (Piper / SAPI).
 */
export async function speakText(
  text: string,
  options?: TtsSpeakOptions,
): Promise<TtsSpeakResult | null> {
  const sanitized = sanitizeTextForSpeech(text);
  if (!sanitized) return null;

  try {
    return await tauriApi.ttsSpeak(sanitized, options);
  } catch (error) {
    console.warn('Local TTS speech synthesis failed:', error);
    return {
      success: false,
      engineUsed: 'none',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Immediately stops any currently playing audio or speech process.
 */
export async function stopSpeech(): Promise<void> {
  try {
    await tauriApi.ttsStop();
  } catch (error) {
    console.warn('Failed to stop TTS speech:', error);
  }
}

/**
 * Queries the live status of offline TTS engines.
 */
export async function getTtsStatus(): Promise<TtsStatusResponse | null> {
  try {
    return await tauriApi.ttsStatus();
  } catch {
    return null;
  }
}

/**
 * Speaks the test phrase to verify voice output settings.
 */
export async function testVoice(settings?: TtsSettings): Promise<TtsSpeakResult | null> {
  const activeSettings = settings ?? loadTtsSettings();
  const testPhrase = 'Voice announcements are working correctly.';

  return speakText(testPhrase, {
    engine: activeSettings.engine,
    voiceModel: activeSettings.voiceModel,
    rate: activeSettings.rate,
    volume: activeSettings.volume,
  });
}
