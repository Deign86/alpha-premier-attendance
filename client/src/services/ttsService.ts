import type {
  TtsEngine,
  TtsSettings,
  TtsSpeakOptions,
  TtsSpeakResult,
  TtsStatusResponse,
} from '@rfid-attendance/shared';
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

export type AnnounceAttendanceOptions = {
  employeeName?: string | null;
  attendanceType: 'time_in' | 'time_out';
  settings?: TtsSettings;
};

/**
 * Generates the appropriate attendance announcement phrase.
 *
 * Rules:
 * - Time-in with name: "Good morning, {name}. Your time in has been recorded."
 * - Time-out with name: "Goodbye, {name}. Your time out has been recorded."
 * - Time-in without name: "Your time in has been recorded."
 * - Time-out without name: "Your time out has been recorded."
 */
export function buildAttendancePhrase(
  attendanceType: 'time_in' | 'time_out',
  employeeName?: string | null,
): string {
  const cleanName = sanitizeTextForSpeech(employeeName ?? '', 100);

  if (attendanceType === 'time_in') {
    if (cleanName.length > 0) {
      return `Good morning, ${cleanName}. Your time in has been recorded.`;
    }
    return 'Your time in has been recorded.';
  }

  if (cleanName.length > 0) {
    return `Goodbye, ${cleanName}. Your time out has been recorded.`;
  }
  return 'Your time out has been recorded.';
}

/**
 * Non-blocking offline TTS voice announcement for attendance events.
 *
 * Voice failures never throw or interrupt attendance flow.
 */
export async function announceAttendance({
  employeeName,
  attendanceType,
  settings,
}: AnnounceAttendanceOptions): Promise<TtsSpeakResult | null> {
  const activeSettings = settings ?? loadTtsSettings();

  if (!activeSettings.enabled || activeSettings.engine === 'disabled') {
    return null;
  }

  const phrase = buildAttendancePhrase(attendanceType, employeeName);
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
