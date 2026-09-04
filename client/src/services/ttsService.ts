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
import {
  getClonedBeaAudioUrl,
  getClonedBeaNameAudioUrl,
  playClonedBeaAudio,
  stopClonedBeaAudio,
} from './clonedBeaVoice';

export {
  CLONED_BEA_PHRASE_MANIFEST,
  getClonedBeaAudioUrl,
  getClonedBeaNameAudioUrl,
  isClonedBeaPhraseAvailable,
  loadNameManifest,
  playClonedBeaAudio,
  setNameManifest,
  stopClonedBeaAudio,
} from './clonedBeaVoice';

const TTS_STORAGE_KEY = 'alpha_premier_tts_settings';

export const DEFAULT_TTS_SETTINGS: TtsSettings = {
  enabled: true,
  engine: 'cloned-bea',
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
  return value === 'auto' || value === 'cloned-bea' || value === 'piper' || value === 'system' || value === 'disabled';
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
  personId?: string | null;
  userId?: string | null;
  arrivalStatus?: ArrivalStatus | null;
  isLateTimeout?: boolean | null;
  isAssisted?: boolean;
  isFirstTimeInToday?: boolean | null;
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
  personId?: string | null;
  /** Kiosk self-service checkout: append the 15-minute return reminder (Bea clip). */
  remindReturnWindow?: boolean;
};

export type AnnounceBathroomOptions = BathroomPhraseOptions & {
  settings?: TtsSettings;
};

export type ScanErrorPhraseOptions = {
  errorCode: string;
  message?: string;
  activeHolderName?: string | null;
  activeHolderId?: string | null;
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
 * Supports grace period notes, late arrival notes, first arrival of the day note,
 * late time-out notices, and admin assisted prefixing.
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
    const firstArrivalNote = options.isFirstTimeInToday ? ' You are the first arrival today.' : '';

    if (options.arrivalStatus === 'GRACE_PERIOD') {
      if (cleanName.length > 0) {
        return `${greeting}, ${cleanName}. Your ${assistedPrefix}time in has been recorded. You made it within the grace period.${firstArrivalNote}`;
      }
      return `Your ${assistedPrefix}time in has been recorded within the grace period.${firstArrivalNote}`;
    }

    if (options.arrivalStatus === 'LATE') {
      if (cleanName.length > 0) {
        return `${greeting}, ${cleanName}. Your ${assistedPrefix}time in has been recorded. You are late.${firstArrivalNote}`;
      }
      return `Your ${assistedPrefix}time in has been recorded. You are late.${firstArrivalNote}`;
    }

    if (cleanName.length > 0) {
      return `${greeting}, ${cleanName}. Your ${assistedPrefix}time in has been recorded.${firstArrivalNote}`;
    }
    return `Your ${assistedPrefix}time in has been recorded.${firstArrivalNote}`;
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

/** Static Bea carrier for the kiosk return-window reminder (played after checkout). */
const RETURN_REMINDER_PHRASE =
  'Your bathroom key has been checked out. Please return it within fifteen minutes.';

/**
 * Generates bathroom key checkout or return announcement phrases.
 */
export function buildBathroomPhrase({
  action,
  genderKey,
  employeeName,
  remindReturnWindow,
}: BathroomPhraseOptions): string {
  const cleanName = sanitizeTextForSpeech(employeeName ?? '', 100);
  const genderLabel = genderKey === 'MALE' ? 'Male' : 'Female';
  const reminder = remindReturnWindow === true ? ` ${RETURN_REMINDER_PHRASE}` : '';

  if (action === 'CHECKOUT') {
    if (cleanName.length > 0) {
      return `${genderLabel} bathroom key checked out for ${cleanName}.${reminder}`;
    }
    return `${genderLabel} bathroom key checked out.${reminder}`;
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

  const cleanName = sanitizeTextForSpeech(options.employeeName ?? '', 100);
  const isClonedBea = activeSettings.engine === 'cloned-bea' || activeSettings.engine === 'auto';

  // Hybrid Splicing: When using Ma'am Bea cloned voice and a dynamic employee/intern name is present:
  // 1. Play pre-rendered cloned prefix carrier ("Good morning,", "Goodbye,", etc.)
  // 2. Synthesize and speak dynamic name via local Piper engine on kiosk
  // 3. Play pre-rendered cloned suffix carrier ("Your time in has been recorded.", etc.)
  if (isClonedBea && cleanName.length > 0) {
    const greeting = options.greeting || getGreetingForTime(options.timeInIso);
    const prefixPhrase = options.attendanceType === 'time_in' ? `${greeting},` : 'Goodbye,';

    const firstArrivalNote = options.isFirstTimeInToday ? ' You are the first arrival today.' : '';
    const assistedPrefix = options.isAssisted ? 'assisted ' : '';
    let suffixPhrase: string;

    if (options.attendanceType === 'time_in') {
      if (options.arrivalStatus === 'GRACE_PERIOD') {
        suffixPhrase = `Your ${assistedPrefix}time in has been recorded. You made it within the grace period.${firstArrivalNote}`;
      } else if (options.arrivalStatus === 'LATE') {
        suffixPhrase = `Your ${assistedPrefix}time in has been recorded. You are late.${firstArrivalNote}`;
      } else {
        suffixPhrase = `Your ${assistedPrefix}time in has been recorded.${firstArrivalNote}`;
      }
    } else {
      // time_out
      if (options.isLateTimeout) {
        suffixPhrase = `Your ${assistedPrefix}time out was recorded after office hours. Manual correction is required.`;
      } else {
        suffixPhrase = `Your ${assistedPrefix}time out has been recorded.`;
      }
    }

    const prefixUrl = getClonedBeaAudioUrl(prefixPhrase);
    const suffixUrl = getClonedBeaAudioUrl(suffixPhrase);
    const targetPersonId = options.personId || options.userId;
    const clonedNameUrl = getClonedBeaNameAudioUrl(targetPersonId, cleanName);

    // If both static cloned segments are present in cache, execute sequential playback:
    // Case A (Existing Intern with generated name file): cloned prefix -> cloned name -> cloned suffix (all Ma'am Bea)
    // Case B (Future Intern/Employee): cloned prefix -> live Piper name -> cloned suffix (hybrid splicing)
    if (prefixUrl && suffixUrl) {
      try {
        // Step 1: Play cloned greeting / prefix
        const prefixPlayed = await playClonedBeaAudio(prefixUrl, activeSettings.volume, activeSettings.rate);
        if (prefixPlayed) {
          let namePlayed = false;
          // Step 2A: Play pre-rendered cloned name if available
          if (clonedNameUrl) {
            namePlayed = await playClonedBeaAudio(clonedNameUrl, activeSettings.volume, activeSettings.rate);
          }

          // Step 2B: If no pre-rendered name file or playback failed, synthesize name live via local Piper engine
          if (!namePlayed) {
            try {
              await tauriApi.ttsSpeak(cleanName, {
                engine: 'piper',
                voiceModel: activeSettings.voiceModel,
                rate: activeSettings.rate,
                volume: activeSettings.volume,
              });
            } catch (piperErr) {
              console.warn('Local Piper synthesis for dynamic name failed:', piperErr);
            }
          }

          // Step 3: Play cloned carrier suffix segment
          await playClonedBeaAudio(suffixUrl, activeSettings.volume, activeSettings.rate);

          return {
            success: true,
            engineUsed: 'cloned-bea',
          };
        }
      } catch (spliceErr) {
        console.warn('Hybrid splicing failed, falling back to full Piper/SAPI synthesis:', spliceErr);
      }
    }
  }

  // Pure static phrase or full fallback phrase
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
 * - Checkout with employee name: prefix ("Male/Female bathroom key checked out for") + name clip (or dynamic Piper name)
 * - Return with employee name: prefix ("Thank you,") + name clip (or dynamic Piper name) + suffix ("Male/Female bathroom key returned.")
 * - Anonymous checkout/return: static pre-rendered carrier clip ("Male/Female bathroom key checked out/returned.")
 */
export async function announceBathroom(
  options: AnnounceBathroomOptions,
): Promise<TtsSpeakResult | null> {
  const activeSettings = options.settings ?? loadTtsSettings();

  if (!activeSettings.enabled || activeSettings.engine === 'disabled') {
    return null;
  }

  const isClonedBea = activeSettings.engine === 'cloned-bea' || activeSettings.engine === 'auto';
  const cleanName = sanitizeTextForSpeech(options.employeeName ?? '', 100);

  if (isClonedBea) {
    const genderLabel = options.genderKey === 'MALE' ? 'Male' : 'Female';
    const targetPersonId = options.personId;

    // Bea-first return-window reminder for kiosk self-service checkout.
    const playReturnReminder = async (): Promise<void> => {
      if (options.remindReturnWindow !== true) return;
      const reminderUrl = getClonedBeaAudioUrl(RETURN_REMINDER_PHRASE);
      if (!reminderUrl) return;
      try {
        await playClonedBeaAudio(reminderUrl, activeSettings.volume, activeSettings.rate);
      } catch (error) {
        console.warn('Return-window reminder playback failed:', error);
      }
    };

    if (cleanName.length > 0) {
      const nameUrl = getClonedBeaNameAudioUrl(targetPersonId, cleanName);

      if (options.action === 'CHECKOUT') {
        const prefixPhrase = `${genderLabel} bathroom key checked out for`;
        const prefixUrl = getClonedBeaAudioUrl(prefixPhrase);

        if (prefixUrl) {
          try {
            const prefixPlayed = await playClonedBeaAudio(prefixUrl, activeSettings.volume, activeSettings.rate);
            if (prefixPlayed) {
              let namePlayed = false;
              if (nameUrl) {
                namePlayed = await playClonedBeaAudio(nameUrl, activeSettings.volume, activeSettings.rate);
              }
              if (!namePlayed) {
                try {
                  await tauriApi.ttsSpeak(cleanName, {
                    engine: 'piper',
                    voiceModel: activeSettings.voiceModel,
                    rate: activeSettings.rate,
                    volume: activeSettings.volume,
                  });
                  namePlayed = true;
                } catch (error) {
                  console.warn('Local Piper synthesis for bathroom name failed:', error);
                }
              }
              if (namePlayed) {
                await playReturnReminder();
                return { success: true, engineUsed: 'cloned-bea' };
              }
            }
          } catch (error) {
            console.warn('Bathroom checkout cloned voice splicing failed:', error);
          }
        }
      } else {
        // RETURN with dynamic or known employee name: "Thank you, [Name]. Male/Female bathroom key returned."
        const prefixPhrase = 'Thank you,';
        const suffixPhrase = `${genderLabel} bathroom key returned.`;
        const prefixUrl = getClonedBeaAudioUrl(prefixPhrase);
        const suffixUrl = getClonedBeaAudioUrl(suffixPhrase);

        if (prefixUrl && suffixUrl) {
          try {
            const prefixPlayed = await playClonedBeaAudio(prefixUrl, activeSettings.volume, activeSettings.rate);
            if (prefixPlayed) {
              let namePlayed = false;
              if (nameUrl) {
                namePlayed = await playClonedBeaAudio(nameUrl, activeSettings.volume, activeSettings.rate);
              }
              if (!namePlayed) {
                try {
                  await tauriApi.ttsSpeak(cleanName, {
                    engine: 'piper',
                    voiceModel: activeSettings.voiceModel,
                    rate: activeSettings.rate,
                    volume: activeSettings.volume,
                  });
                  namePlayed = true;
                } catch (error) {
                  console.warn('Local Piper synthesis for bathroom name failed:', error);
                }
              }
              if (namePlayed) {
                const suffixPlayed = await playClonedBeaAudio(suffixUrl, activeSettings.volume, activeSettings.rate);
                if (suffixPlayed) {
                  return { success: true, engineUsed: 'cloned-bea' };
                }
              }
            }
          } catch (error) {
            console.warn('Bathroom return cloned voice splicing failed:', error);
          }
        }
      }
    } else {
      // Anonymous bathroom checkout or return (no employee name)
      const staticPhrase = options.action === 'CHECKOUT'
        ? `${genderLabel} bathroom key checked out.`
        : `${genderLabel} bathroom key returned.`;
      const staticUrl = getClonedBeaAudioUrl(staticPhrase);
      if (staticUrl) {
        try {
          const played = await playClonedBeaAudio(staticUrl, activeSettings.volume, activeSettings.rate);
          if (played) {
            if (options.action === 'CHECKOUT') {
              await playReturnReminder();
            }
            return { success: true, engineUsed: 'cloned-bea' };
          }
        } catch (error) {
          console.warn('Bathroom static cloned voice playback failed:', error);
        }
      }
    }
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
 * Pure static cloned carrier phrase.
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
 * When Ma'am Bea is active, plays the static cloned error clip; a known key
 * holder is spliced as "-by" carrier + cloned name clip (Bea-first).
 */
export async function announceScanError(
  options: AnnounceScanErrorOptions,
): Promise<TtsSpeakResult | null> {
  const activeSettings = options.settings ?? loadTtsSettings();

  if (!activeSettings.enabled || activeSettings.engine === 'disabled') {
    return null;
  }

  const isClonedBea = activeSettings.engine === 'cloned-bea' || activeSettings.engine === 'auto';

  // Bea-first: splice the static "-by" carrier with the holder's cloned name clip
  // so the holder is actually named (previously the name was dropped in Bea mode).
  // Piper speaks only the holder name when no cloned clip exists for them.
  if (isClonedBea && options.errorCode === 'BATHROOM_KEY_IN_USE') {
    const holderName = sanitizeTextForSpeech(options.activeHolderName ?? '', 100);
    if (holderName.length > 0) {
      const holderGender =
        options.genderKey === 'MALE' ? 'male' : options.genderKey === 'FEMALE' ? 'female' : '';
      const holderPrefix =
        holderGender.length > 0
          ? `The ${holderGender} bathroom key is currently in use by`
          : 'The bathroom key is currently in use by';
      const holderPrefixUrl = getClonedBeaAudioUrl(holderPrefix);
      const holderId = options.activeHolderId?.trim() ? options.activeHolderId.trim() : null;
      const holderNameUrl = getClonedBeaNameAudioUrl(holderId, holderName);
      if (holderPrefixUrl) {
        try {
          const prefixPlayed = await playClonedBeaAudio(
            holderPrefixUrl,
            activeSettings.volume,
            activeSettings.rate,
          );
          if (prefixPlayed) {
            let holderPlayed = false;
            if (holderNameUrl) {
              holderPlayed = await playClonedBeaAudio(
                holderNameUrl,
                activeSettings.volume,
                activeSettings.rate,
              );
            }
            if (!holderPlayed) {
              try {
                await tauriApi.ttsSpeak(holderName, {
                  engine: 'piper',
                  voiceModel: activeSettings.voiceModel,
                  rate: activeSettings.rate,
                  volume: activeSettings.volume,
                });
                holderPlayed = true;
              } catch (error) {
                console.warn('Local Piper synthesis for key-holder name failed:', error);
              }
            }
            if (holderPlayed) {
              return { success: true, engineUsed: 'cloned-bea' };
            }
          }
        } catch (error) {
          console.warn('Key-in-use cloned voice splicing failed:', error);
        }
      }
    }
  }

  const phrase = isClonedBea
    ? (options.errorCode === 'INVALID_UID' || options.errorCode === 'UNREGISTERED_CARD'
        ? "Sorry, that card wasn't recognized. Please try scanning again."
        : buildScanErrorPhrase({ ...options, activeHolderName: null }))
    : buildScanErrorPhrase(options);

  return speakText(phrase, {
    engine: activeSettings.engine,
    voiceModel: activeSettings.voiceModel,
    rate: activeSettings.rate,
    volume: activeSettings.volume,
  });
}

/**
 * Speaks arbitrary text using local backend TTS engines (Piper / SAPI) or cloned voice audio cache.
 */
export async function speakText(
  text: string,
  options?: TtsSpeakOptions,
): Promise<TtsSpeakResult | null> {
  const sanitized = sanitizeTextForSpeech(text);
  if (!sanitized) return null;

  // In Tauri desktop environment, native Tauri TTS handles playback (cloned-bea, piper, SAPI) with native Rodio audio.
  if ('window' in globalThis && '__TAURI_INTERNALS__' in window) {
    try {
      return await tauriApi.ttsSpeak(sanitized, options);
    } catch (error) {
      console.warn('Native TTS speech synthesis failed:', error);
      return {
        success: false,
        engineUsed: 'none',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (options?.engine === 'cloned-bea' || options?.engine === 'auto') {
    const cachedUrl = getClonedBeaAudioUrl(sanitized);
    if (cachedUrl) {
      try {
        const played = await playClonedBeaAudio(cachedUrl, options.volume, options.rate);
        if (played) {
          return {
            success: true,
            engineUsed: 'cloned-bea',
          };
        }
        console.warn(
          `Cloned voice audio playback failed for phrase: "${sanitized}". Falling back to Piper/SAPI TTS.`,
        );
      } catch (audioError) {
        console.warn('Cloned voice audio playback error, falling back to Piper/SAPI:', audioError);
      }
    } else {
      console.warn(
        `Cloned voice ("Ma'am Bea") cache miss for phrase: "${sanitized}". Falling back to Piper/SAPI TTS.`,
      );
    }

    // Fall back gracefully to backend TTS (auto engine)
    try {
      return await tauriApi.ttsSpeak(sanitized, { ...options, engine: 'auto' });
    } catch (fallbackError) {
      console.warn('Fallback TTS speech synthesis failed:', fallbackError);
      return {
        success: false,
        engineUsed: 'none',
        message: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      };
    }
  }

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
  stopClonedBeaAudio();
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
