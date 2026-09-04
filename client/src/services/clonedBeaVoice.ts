/**
 * CONSENT SAFEGUARD:
 * The "Ma'am Bea" cloned voice profile requires recorded, on-file employee consent.
 * This voice model is strictly authorized for official attendance and kiosk system announcements only.
 *
 * Revocation Policy:
 * If consent is withdrawn at any time:
 * 1. Delete all reference audio clips (resources/voices/bea/*.wav).
 * 2. Delete all pre-rendered cached audio files (client/public/voices/bea/**).
 * 3. Revert the active TTS engine setting in storage and configuration to 'auto' or 'piper'.
 */

/**
 * Static manifest mapping fixed announcement phrases to their pre-rendered audio cache paths.
 *
 * Tone mappings:
 * - Attendance announcements -> Main Reference (neutral-warm)
 * - Scan errors / warnings   -> Neutral (alert)
 * - Bathroom key management  -> Warm (helpful)
 * - Admin Assist recognition -> Warm (helpful)
 * - General / Test voice     -> Main Reference (neutral-warm)
 */
export const CLONED_BEA_PHRASE_MANIFEST: Readonly<Record<string, string>> = Object.freeze({
  // 1. Hybrid Splicing Carrier Prefixes (Main Tone)
  'Good morning,': '/voices/bea/attendance/good-morning.mp3',
  'Good afternoon,': '/voices/bea/attendance/good-afternoon.mp3',
  'Good evening,': '/voices/bea/attendance/good-evening.mp3',
  'Goodbye,': '/voices/bea/attendance/goodbye.mp3',
  'Attendance recorded for': '/voices/bea/attendance/attendance-recorded-for.mp3',
  'Thank you, and have a great day.': '/voices/bea/attendance/thank-you-great-day.mp3',

  // 2. Hybrid Splicing Suffixes & Attendance Announcements
  'Your time in has been recorded.': '/voices/bea/attendance/time-in-standard.mp3',
  'Your time in has been recorded. You are the first arrival today.': '/voices/bea/attendance/time-in-first-arrival.mp3',
  'Your time in has been recorded within the grace period.': '/voices/bea/attendance/time-in-grace.mp3',
  'Your time in has been recorded within the grace period. You are the first arrival today.': '/voices/bea/attendance/time-in-grace-first-arrival.mp3',
  'Your time in has been recorded. You made it within the grace period.': '/voices/bea/attendance/time-in-grace.mp3',
  'Your time in has been recorded. You made it within the grace period. You are the first arrival today.': '/voices/bea/attendance/time-in-grace-first-arrival.mp3',
  'Your time in has been recorded. You are late.': '/voices/bea/attendance/time-in-late.mp3',
  'Your time in has been recorded. You are late. You are the first arrival today.': '/voices/bea/attendance/time-in-late-first-arrival.mp3',
  'Your assisted time in has been recorded.': '/voices/bea/attendance/time-in-assisted-standard.mp3',
  'Your assisted time in has been recorded. You are the first arrival today.': '/voices/bea/attendance/time-in-assisted-first-arrival.mp3',
  'Your assisted time in has been recorded within the grace period.': '/voices/bea/attendance/time-in-assisted-grace.mp3',
  'Your assisted time in has been recorded within the grace period. You are the first arrival today.': '/voices/bea/attendance/time-in-assisted-grace-first-arrival.mp3',
  'Your assisted time in has been recorded. You made it within the grace period.': '/voices/bea/attendance/time-in-assisted-grace.mp3',
  'Your assisted time in has been recorded. You made it within the grace period. You are the first arrival today.': '/voices/bea/attendance/time-in-assisted-grace-first-arrival.mp3',
  'Your assisted time in has been recorded. You are late.': '/voices/bea/attendance/time-in-assisted-late.mp3',
  'Your assisted time in has been recorded. You are late. You are the first arrival today.': '/voices/bea/attendance/time-in-assisted-late-first-arrival.mp3',
  'Your time out has been recorded.': '/voices/bea/attendance/time-out-standard.mp3',
  'Your time out was recorded after office hours. Manual correction is required.': '/voices/bea/attendance/time-out-late-timeout.mp3',
  'Your assisted time out has been recorded.': '/voices/bea/attendance/time-out-assisted-standard.mp3',
  'Your assisted time out was recorded after office hours. Manual correction is required.': '/voices/bea/attendance/time-out-assisted-late-timeout.mp3',

  // 3. Bathroom (Warm Tone)
  'Your bathroom key has been checked out. Please return it within fifteen minutes.': '/voices/bea/bathroom/bathroom-key-checked-out-15min.mp3',
  'Male bathroom key checked out.': '/voices/bea/bathroom/checkout-male.mp3',
  'Female bathroom key checked out.': '/voices/bea/bathroom/checkout-female.mp3',
  'Male bathroom key checked out for': '/voices/bea/bathroom/checkout-male-for.mp3',
  'Female bathroom key checked out for': '/voices/bea/bathroom/checkout-female-for.mp3',
  'Female bathroom key checked out for Jane Doe.': '/voices/bea/bathroom/checkout-female-name.mp3',
  'Male bathroom key checked out for John Doe.': '/voices/bea/bathroom/checkout-male-name.mp3',
  'Thank you,': '/voices/bea/bathroom/thank-you.mp3',
  'Male bathroom key returned.': '/voices/bea/bathroom/return-male.mp3',
  'Female bathroom key returned.': '/voices/bea/bathroom/return-female.mp3',

  // 4. Admin Assist (Warm Tone)
  'Admin assist card recognized. Please select an employee.': '/voices/bea/admin-assist/admin-assist-prompt.mp3',

  // 5. Scan Errors (Neutral/Alert Tone)
  "Sorry, that card wasn't recognized. Please try scanning again.": '/voices/bea/scan-error/sorry-card-not-recognized.mp3',
  'The male bathroom key is currently in use.': '/voices/bea/scan-error/bathroom-key-in-use-male.mp3',
  'The female bathroom key is currently in use.': '/voices/bea/scan-error/bathroom-key-in-use-female.mp3',
  'The bathroom key is currently in use.': '/voices/bea/scan-error/bathroom-key-in-use.mp3',
  'The male bathroom key is currently in use by': '/voices/bea/scan-error/bathroom-key-in-use-male-by.mp3',
  'The female bathroom key is currently in use by': '/voices/bea/scan-error/bathroom-key-in-use-female-by.mp3',
  'This card is not registered.': '/voices/bea/scan-error/card-not-registered.mp3',
  'Employee record is inactive.': '/voices/bea/scan-error/employee-record-inactive.mp3',
  'Card scanned too recently. Please wait.': '/voices/bea/scan-error/card-scanned-too-recently.mp3',
  'Admin cards cannot check out bathroom keys.': '/voices/bea/scan-error/admin-card-not-allowed.mp3',
  'Admin card requires employee selection.': '/voices/bea/scan-error/admin-card-requires-selection.mp3',
  'Attendance is already completed for today.': '/voices/bea/scan-error/attendance-already-completed.mp3',
  'Attendance timed out after office hours and is pending manual correction.': '/voices/bea/scan-error/attendance-timed-out-correction.mp3',
  'Attendance service is temporarily unavailable.': '/voices/bea/scan-error/service-unavailable.mp3',
  'Attendance conflict. Please try again.': '/voices/bea/scan-error/attendance-conflict.mp3',
  'Scan could not be processed.': '/voices/bea/scan-error/scan-generic-error.mp3',

  // 6. General / Test (Main Tone)
  'Voice announcements are working correctly.': '/voices/bea/general/test-voice.mp3',
});

import { tauriApi } from '../tauri-api';

interface NameProfileEntry {
  personId?: string;
  displayName?: string;
  normalizedSpeechText?: string;
  audioFile: string;
}

const DEFAULT_NAME_PROFILES: Readonly<Record<string, NameProfileEntry>> = Object.freeze({
  'APG-2026-019': { personId: 'APG-2026-019', displayName: 'Beatriz Conos', normalizedSpeechText: 'Beatriz Conos', audioFile: '/voices/bea/names/APG-2026-019.mp3' },
  'APG-2026-113': { personId: 'APG-2026-113', displayName: 'Ar-jee Felizarte', normalizedSpeechText: 'Arjee Felizarte', audioFile: '/voices/bea/names/APG-2026-113.mp3' },
  'APG-2026-110': { personId: 'APG-2026-110', displayName: 'Bianca Marie Antoy', normalizedSpeechText: 'Bianca Marie Antoy', audioFile: '/voices/bea/names/APG-2026-110.mp3' },
  'APG-2026-102': { personId: 'APG-2026-102', displayName: 'Deign Grey O. Lazaro', normalizedSpeechText: 'Deign Grey Lazaro', audioFile: '/voices/bea/names/APG-2026-102.mp3' },
  'APG-2026-109': { personId: 'APG-2026-109', displayName: 'Elaizah Jane Altiche', normalizedSpeechText: 'Elaizah Jane Altiche', audioFile: '/voices/bea/names/APG-2026-109.mp3' },
  'APG-2026-095': { personId: 'APG-2026-095', displayName: 'Jannela Pasacay', normalizedSpeechText: 'Jannela Pasacay', audioFile: '/voices/bea/names/APG-2026-095.mp3' },
  'APG-2026-099': { personId: 'APG-2026-099', displayName: 'Jeremy Bugarin', normalizedSpeechText: 'Jeremy Bugarin', audioFile: '/voices/bea/names/APG-2026-099.mp3' },
  'APG-2026-112': { personId: 'APG-2026-112', displayName: 'John Frederick Ruiz', normalizedSpeechText: 'John Frederick Ruiz', audioFile: '/voices/bea/names/APG-2026-112.mp3' },
  'APG-2026-092': { personId: 'APG-2026-092', displayName: 'Joseph Amandy', normalizedSpeechText: 'Joseph Amandy', audioFile: '/voices/bea/names/APG-2026-092.mp3' },
  'APG-2026-101': { personId: 'APG-2026-101', displayName: 'Khemuel Rosh Timkang', normalizedSpeechText: 'Khemuel Rosh Timkang', audioFile: '/voices/bea/names/APG-2026-101.mp3' },
  'APG-2026-104': { personId: 'APG-2026-104', displayName: 'Kizziah Ishi De Guerto', normalizedSpeechText: 'Kizziah Ishi De Guerto', audioFile: '/voices/bea/names/APG-2026-104.mp3' },
  'APG-2026-098': { personId: 'APG-2026-098', displayName: 'Kurt Lawrenz De Leon', normalizedSpeechText: 'Kurt Lawrenz De Leon', audioFile: '/voices/bea/names/APG-2026-098.mp3' },
  'APG-2026-100': { personId: 'APG-2026-100', displayName: 'Kylle Ricio', normalizedSpeechText: 'Kylle Ricio', audioFile: '/voices/bea/names/APG-2026-100.mp3' },
  'APG-2026-103': { personId: 'APG-2026-103', displayName: 'Lorraine Isabel Cabigon', normalizedSpeechText: 'Lorraine Isabel Cabigon', audioFile: '/voices/bea/names/APG-2026-103.mp3' },
  'APG-2026-111': { personId: 'APG-2026-111', displayName: 'Ma. Ellaine Zapico', normalizedSpeechText: 'Maria Ellaine Zapico', audioFile: '/voices/bea/names/APG-2026-111.mp3' },
  'APG-2026-107': { personId: 'APG-2026-107', displayName: 'Margaux Zyann Delaog', normalizedSpeechText: 'Margaux Zyann Delaog', audioFile: '/voices/bea/names/APG-2026-107.mp3' },
  'APG-2026-097': { personId: 'APG-2026-097', displayName: 'Mary Antonette Yaguel', normalizedSpeechText: 'Mary Antonette Yaguel', audioFile: '/voices/bea/names/APG-2026-097.mp3' },
  'APG-2026-106': { personId: 'APG-2026-106', displayName: 'Mitchi Hashidate', normalizedSpeechText: 'Mitchi Hashidate', audioFile: '/voices/bea/names/APG-2026-106.mp3' },
  'APG-2026-105': { personId: 'APG-2026-105', displayName: 'Narciso Lontoc', normalizedSpeechText: 'Narciso Lontoc', audioFile: '/voices/bea/names/APG-2026-105.mp3' },
  'APG-2026-114': { personId: 'APG-2026-114', displayName: 'Noeme P. Diola', normalizedSpeechText: 'Noeme Diola', audioFile: '/voices/bea/names/APG-2026-114.mp3' },
  'APG-2026-108': { personId: 'APG-2026-108', displayName: 'Raineer C. Rosado', normalizedSpeechText: 'Raineer Rosado', audioFile: '/voices/bea/names/APG-2026-108.mp3' },
  'APG-2026-094': { personId: 'APG-2026-094', displayName: 'Rona Khristelle Angelique Pacada', normalizedSpeechText: 'Rona Khristelle Angelique Pacada', audioFile: '/voices/bea/names/APG-2026-094.mp3' },
  'USR_INT_001': { personId: 'USR_INT_001', displayName: 'Maria Santos', normalizedSpeechText: 'Maria Santos', audioFile: '/voices/bea/names/USR_INT_001.mp3' },
  'USR_INT_002': { personId: 'USR_INT_002', displayName: 'JUAN DELA CRUZ', normalizedSpeechText: 'Juan Dela Cruz', audioFile: '/voices/bea/names/USR_INT_002.mp3' },
  'USR_EMP_001': { personId: 'USR_EMP_001', displayName: 'Ada Lovelace', normalizedSpeechText: 'Ada Lovelace', audioFile: '/voices/bea/names/USR_EMP_001.mp3' },
  'APG-2026-115': { personId: 'APG-2026-115', displayName: 'Allaena Nicole E. Vizon', normalizedSpeechText: 'Allaena Nicole Vizon', audioFile: '/voices/bea/names/APG-2026-115.mp3' },
});

function normalizeNameForLookup(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

let nameManifestCache: Record<string, NameProfileEntry> | null = { ...DEFAULT_NAME_PROFILES };
let nameManifestLoaded = false;

/**
 * Manually set the name manifest for tests or runtime registration.
 */
export function setNameManifest(manifest: Record<string, { audioFile: string; displayName?: string; normalizedSpeechText?: string; personId?: string }> | null): void {
  nameManifestCache = manifest;
  nameManifestLoaded = true;
}

interface NameManifestJson {
  profiles?: Record<string, NameProfileEntry>;
}

/**
 * Loads the name manifest from /voices/bea/bea-name-manifest.json if available.
 */
export async function loadNameManifest(): Promise<Record<string, NameProfileEntry> | null> {
  if (nameManifestLoaded) {
    return nameManifestCache;
  }
  if (!('fetch' in globalThis)) {
    nameManifestLoaded = true;
    return nameManifestCache;
  }
  try {
    const res = await fetch('/voices/bea/bea-name-manifest.json');
    if (res.ok) {
      // SAFETY: Parsing schema at I/O boundary
      const data = (await res.json()) as NameManifestJson | null;
      if (data && data.profiles && !Array.isArray(data.profiles)) {
        // SAFETY: Verified profiles is dictionary
        nameManifestCache = {
          ...DEFAULT_NAME_PROFILES,
          ...(data.profiles as Record<string, NameProfileEntry>),
        };
      }
    }
  } catch {
    // Ignore fetch error when running without server or manifest
  }
  nameManifestLoaded = true;
  return nameManifestCache;
}

/**
 * Returns the cached audio URL for an existing intern's or employee's cloned name audio
 * by personId or employeeName, or null if uncached.
 */
export function getClonedBeaNameAudioUrl(
  personId?: string | null,
  employeeName?: string | null,
): string | null {
  const cleanId = personId?.trim() ?? '';
  if (cleanId.length > 0) {
    if (nameManifestCache && cleanId in nameManifestCache) {
      return nameManifestCache[cleanId]?.audioFile ?? `/voices/bea/names/${cleanId}.mp3`;
    }
    if (cleanId in DEFAULT_NAME_PROFILES) {
      return DEFAULT_NAME_PROFILES[cleanId]?.audioFile ?? `/voices/bea/names/${cleanId}.mp3`;
    }
  }

  const cleanName = employeeName?.trim() ?? '';
  if (cleanName.length > 0) {
    const normalizedInput = normalizeNameForLookup(cleanName);
    const profiles = nameManifestCache ?? DEFAULT_NAME_PROFILES;
    for (const [id, profile] of Object.entries(profiles)) {
      if (profile.displayName && normalizeNameForLookup(profile.displayName) === normalizedInput) {
        return profile.audioFile ?? `/voices/bea/names/${id}.mp3`;
      }
      if (profile.normalizedSpeechText && normalizeNameForLookup(profile.normalizedSpeechText) === normalizedInput) {
        return profile.audioFile ?? `/voices/bea/names/${id}.mp3`;
      }
    }

    // Secondary relaxed match: check if first & last name match (e.g. "Deign Lazaro" matching "Deign Grey O. Lazaro")
    const inputParts = normalizedInput.split(' ').filter(Boolean);
    if (inputParts.length >= 2) {
      const inputFirst = inputParts[0];
      const inputLast = inputParts[inputParts.length - 1];
      for (const [id, profile] of Object.entries(profiles)) {
        const target = normalizeNameForLookup(profile.displayName || profile.normalizedSpeechText || '');
        const targetParts = target.split(' ').filter(Boolean);
        if (targetParts.length >= 2) {
          const targetFirst = targetParts[0];
          const targetLast = targetParts[targetParts.length - 1];
          if (inputFirst === targetFirst && inputLast === targetLast) {
            return profile.audioFile ?? `/voices/bea/names/${id}.mp3`;
          }
        }
      }
    }
  }

  return null;
}

let activeAudioElement: HTMLAudioElement | null = null;

/**
 * Fallback voice URL resolver.
 *
 * Manifests now reference `.mp3` as the primary format. If an `.mp3` fails to load,
 * this resolver attempts the `.wav` fallback for legacy or incomplete conversions.
 * The `.mp3` plays natively in WebView2/HTML5 Audio and (with the `mp3` rodio feature)
 * in the Rust backend, at roughly 1/5 the bytes of the original `.wav`.
 */
export function resolveWavFallbackUrl(mp3Url: string): string {
  return mp3Url.replace(/\.mp3$/i, '.wav');
}

/**
 * Returns the cached audio URL for a known fixed announcement phrase, or null if uncached.
 */
export function getClonedBeaAudioUrl(phrase: string): string | null {
  const clean = phrase.trim();
  return CLONED_BEA_PHRASE_MANIFEST[clean] ?? null;
}

function getClonedBeaPhraseForAudioUrl(audioUrl: string): string | null {
  for (const [phrase, url] of Object.entries(CLONED_BEA_PHRASE_MANIFEST)) {
    if (url === audioUrl) return phrase;
  }
  return null;
}

/**
 * Checks whether a phrase is pre-rendered in the cloned voice audio cache.
 */
export function isClonedBeaPhraseAvailable(phrase: string): boolean {
  return getClonedBeaAudioUrl(phrase) !== null;
}

/**
 * Immediately stops any playing cloned voice audio playback.
 */
export function stopClonedBeaAudio(): void {
  if (activeAudioElement) {
    try {
      activeAudioElement.pause();
      activeAudioElement.currentTime = 0;
    } catch {
      // Ignore pause errors
    }
    activeAudioElement = null;
  }
}

/**
 * Plays a pre-rendered cloned voice audio file through native Tauri audio or standard HTML5 Audio.
 * Returns true if playback succeeded, or false if an error occurred.
 */
export async function playClonedBeaAudio(
  audioUrl: string,
  volume = 1.0,
  rate = 1.0,
): Promise<boolean> {
  stopClonedBeaAudio();

  // In Tauri desktop environment, prefer native Rodio playback for seamless hardware output
  if ('window' in globalThis && '__TAURI_INTERNALS__' in window) {
    try {
      const phrase = getClonedBeaPhraseForAudioUrl(audioUrl);
      const nativeText = phrase ?? audioUrl;
      const result = await tauriApi.ttsSpeak(nativeText, {
        engine: 'cloned-bea',
        volume,
        rate,
      });
      if (result && result.success) {
        return true;
      }
    } catch (nativeErr) {
      console.warn('Native Rodio audio playback failed, falling back to HTML5 Audio:', nativeErr);
    }
  }

  if (!('window' in globalThis) || !('Audio' in globalThis)) {
    return false;
  }

  try {
    const attempted = await attemptAudioPlay(audioUrl, volume, rate);
    if (attempted) return true;
    const wavFallback = resolveWavFallbackUrl(audioUrl);
    if (wavFallback !== audioUrl) {
      return attemptAudioPlay(wavFallback, volume, rate);
    }
    return false;
  } catch (error) {
    console.warn('Cloned voice audio playback threw exception:', error);
    return false;
  }
}

/**
 * Single-URL HTML5 Audio playback attempt. Returns true on end/timeout, false on error.
 */
async function attemptAudioPlay(
  url: string,
  volume: number,
  rate: number,
): Promise<boolean> {
  try {
    const audio = new Audio(url);
    activeAudioElement = audio;

    const clampedVolume = Math.min(Math.max(Number.isFinite(volume) ? volume : 1.0, 0.0), 1.0);
    const clampedRate = Math.min(Math.max(Number.isFinite(rate) ? rate : 1.0, 0.5), 2.0);

    audio.volume = clampedVolume;
    audio.playbackRate = clampedRate;

    return await new Promise<boolean>((resolve) => {
      let resolved = false;

      const timer = setTimeout(() => {
        finish(true);
      }, 8000);

      const finish = (ok: boolean) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          if (activeAudioElement === audio) {
            activeAudioElement = null;
          }
          resolve(ok);
        }
      };

      audio.onended = () => finish(true);
      audio.onerror = () => finish(false);

      audio.play().catch(() => finish(false));
    });
  } catch (error) {
    console.warn('Cloned voice audio playback threw exception:', error);
    return false;
  }
}

