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
  'Good morning,': '/voices/bea/attendance/good-morning.wav',
  'Good afternoon,': '/voices/bea/attendance/good-afternoon.wav',
  'Good evening,': '/voices/bea/attendance/good-evening.wav',
  'Goodbye,': '/voices/bea/attendance/goodbye.wav',
  'Attendance recorded for': '/voices/bea/attendance/attendance-recorded-for.wav',
  'Thank you, and have a great day.': '/voices/bea/attendance/thank-you-great-day.wav',

  // 2. Hybrid Splicing Suffixes & Attendance Announcements
  'Your time in has been recorded.': '/voices/bea/attendance/time-in-standard.wav',
  'Your time in has been recorded. You are the first arrival today.': '/voices/bea/attendance/time-in-first-arrival.wav',
  'Your time in has been recorded within the grace period.': '/voices/bea/attendance/time-in-grace.wav',
  'Your time in has been recorded within the grace period. You are the first arrival today.': '/voices/bea/attendance/time-in-grace-first-arrival.wav',
  'Your time in has been recorded. You made it within the grace period.': '/voices/bea/attendance/time-in-grace.wav',
  'Your time in has been recorded. You made it within the grace period. You are the first arrival today.': '/voices/bea/attendance/time-in-grace-first-arrival.wav',
  'Your time in has been recorded. You are late.': '/voices/bea/attendance/time-in-late.wav',
  'Your time in has been recorded. You are late. You are the first arrival today.': '/voices/bea/attendance/time-in-late-first-arrival.wav',
  'Your assisted time in has been recorded.': '/voices/bea/attendance/time-in-assisted-standard.wav',
  'Your assisted time in has been recorded. You are the first arrival today.': '/voices/bea/attendance/time-in-assisted-first-arrival.wav',
  'Your assisted time in has been recorded within the grace period.': '/voices/bea/attendance/time-in-assisted-grace.wav',
  'Your assisted time in has been recorded within the grace period. You are the first arrival today.': '/voices/bea/attendance/time-in-assisted-grace-first-arrival.wav',
  'Your assisted time in has been recorded. You made it within the grace period.': '/voices/bea/attendance/time-in-assisted-grace.wav',
  'Your assisted time in has been recorded. You made it within the grace period. You are the first arrival today.': '/voices/bea/attendance/time-in-assisted-grace-first-arrival.wav',
  'Your assisted time in has been recorded. You are late.': '/voices/bea/attendance/time-in-assisted-late.wav',
  'Your assisted time in has been recorded. You are late. You are the first arrival today.': '/voices/bea/attendance/time-in-assisted-late-first-arrival.wav',
  'Your time out has been recorded.': '/voices/bea/attendance/time-out-standard.wav',
  'Your time out was recorded after office hours. Manual correction is required.': '/voices/bea/attendance/time-out-late-timeout.wav',
  'Your assisted time out has been recorded.': '/voices/bea/attendance/time-out-assisted-standard.wav',
  'Your assisted time out was recorded after office hours. Manual correction is required.': '/voices/bea/attendance/time-out-assisted-late-timeout.wav',

  // 3. Bathroom (Warm Tone)
  'Your bathroom key has been checked out. Please return it within fifteen minutes.': '/voices/bea/bathroom/bathroom-key-checked-out-15min.wav',
  'Male bathroom key checked out.': '/voices/bea/bathroom/checkout-male.wav',
  'Female bathroom key checked out.': '/voices/bea/bathroom/checkout-female.wav',
  'Male bathroom key checked out for': '/voices/bea/bathroom/checkout-male-for.wav',
  'Female bathroom key checked out for': '/voices/bea/bathroom/checkout-female-for.wav',
  'Female bathroom key checked out for Jane Doe.': '/voices/bea/bathroom/checkout-female-name.wav',
  'Male bathroom key checked out for John Doe.': '/voices/bea/bathroom/checkout-male-name.wav',
  'Thank you,': '/voices/bea/bathroom/thank-you.wav',
  'Male bathroom key returned.': '/voices/bea/bathroom/return-male.wav',
  'Female bathroom key returned.': '/voices/bea/bathroom/return-female.wav',

  // 4. Admin Assist (Warm Tone)
  'Admin assist card recognized. Please select an employee.': '/voices/bea/admin-assist/admin-assist-prompt.wav',

  // 5. Scan Errors (Neutral/Alert Tone)
  "Sorry, that card wasn't recognized. Please try scanning again.": '/voices/bea/scan-error/sorry-card-not-recognized.wav',
  'The male bathroom key is currently in use.': '/voices/bea/scan-error/bathroom-key-in-use-male.wav',
  'The female bathroom key is currently in use.': '/voices/bea/scan-error/bathroom-key-in-use-female.wav',
  'The bathroom key is currently in use.': '/voices/bea/scan-error/bathroom-key-in-use.wav',
  'The male bathroom key is currently in use by': '/voices/bea/scan-error/bathroom-key-in-use-male-by.wav',
  'The female bathroom key is currently in use by': '/voices/bea/scan-error/bathroom-key-in-use-female-by.wav',
  'This card is not registered.': '/voices/bea/scan-error/card-not-registered.wav',
  'Employee record is inactive.': '/voices/bea/scan-error/employee-record-inactive.wav',
  'Card scanned too recently. Please wait.': '/voices/bea/scan-error/card-scanned-too-recently.wav',
  'Admin cards cannot check out bathroom keys.': '/voices/bea/scan-error/admin-card-not-allowed.wav',
  'Admin card requires employee selection.': '/voices/bea/scan-error/admin-card-requires-selection.wav',
  'Attendance is already completed for today.': '/voices/bea/scan-error/attendance-already-completed.wav',
  'Attendance timed out after office hours and is pending manual correction.': '/voices/bea/scan-error/attendance-timed-out-correction.wav',
  'Attendance service is temporarily unavailable.': '/voices/bea/scan-error/service-unavailable.wav',
  'Attendance conflict. Please try again.': '/voices/bea/scan-error/attendance-conflict.wav',
  'Scan could not be processed.': '/voices/bea/scan-error/scan-generic-error.wav',

  // 6. General / Test (Main Tone)
  'Voice announcements are working correctly.': '/voices/bea/general/test-voice.wav',
});

import { tauriApi } from '../tauri-api';

const DEFAULT_NAME_PROFILES: Readonly<Record<string, { audioFile: string }>> = Object.freeze({
  'APG-2026-019': { audioFile: '/voices/bea/names/APG-2026-019.wav' },
  'APG-2026-113': { audioFile: '/voices/bea/names/APG-2026-113.wav' },
  'APG-2026-110': { audioFile: '/voices/bea/names/APG-2026-110.wav' },
  'APG-2026-102': { audioFile: '/voices/bea/names/APG-2026-102.wav' },
  'APG-2026-109': { audioFile: '/voices/bea/names/APG-2026-109.wav' },
  'APG-2026-095': { audioFile: '/voices/bea/names/APG-2026-095.wav' },
  'APG-2026-099': { audioFile: '/voices/bea/names/APG-2026-099.wav' },
  'APG-2026-112': { audioFile: '/voices/bea/names/APG-2026-112.wav' },
  'APG-2026-092': { audioFile: '/voices/bea/names/APG-2026-092.wav' },
  'APG-2026-101': { audioFile: '/voices/bea/names/APG-2026-101.wav' },
  'APG-2026-104': { audioFile: '/voices/bea/names/APG-2026-104.wav' },
  'APG-2026-098': { audioFile: '/voices/bea/names/APG-2026-098.wav' },
  'APG-2026-100': { audioFile: '/voices/bea/names/APG-2026-100.wav' },
  'APG-2026-103': { audioFile: '/voices/bea/names/APG-2026-103.wav' },
  'APG-2026-111': { audioFile: '/voices/bea/names/APG-2026-111.wav' },
  'APG-2026-107': { audioFile: '/voices/bea/names/APG-2026-107.wav' },
  'APG-2026-097': { audioFile: '/voices/bea/names/APG-2026-097.wav' },
  'APG-2026-106': { audioFile: '/voices/bea/names/APG-2026-106.wav' },
  'APG-2026-105': { audioFile: '/voices/bea/names/APG-2026-105.wav' },
  'APG-2026-114': { audioFile: '/voices/bea/names/APG-2026-114.wav' },
  'APG-2026-108': { audioFile: '/voices/bea/names/APG-2026-108.wav' },
  'APG-2026-094': { audioFile: '/voices/bea/names/APG-2026-094.wav' },
  'USR_INT_001': { audioFile: '/voices/bea/names/USR_INT_001.wav' },
  'USR_INT_002': { audioFile: '/voices/bea/names/USR_INT_002.wav' },
  'USR_EMP_001': { audioFile: '/voices/bea/names/USR_EMP_001.wav' },
});

let nameManifestCache: Record<string, { audioFile: string }> | null = { ...DEFAULT_NAME_PROFILES };
let nameManifestLoaded = false;

/**
 * Manually set the name manifest for tests or runtime registration.
 */
export function setNameManifest(manifest: Record<string, { audioFile: string }> | null): void {
  nameManifestCache = manifest;
  nameManifestLoaded = true;
}

interface NameManifestJson {
  profiles?: Record<string, { audioFile?: string }>;
}

/**
 * Loads the name manifest from /voices/bea/bea-name-manifest.json if available.
 */
export async function loadNameManifest(): Promise<Record<string, { audioFile: string }> | null> {
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
          ...(data.profiles as Record<string, { audioFile: string }>),
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
 * Returns the cached audio URL for an existing intern's cloned name audio by personId, or null if uncached.
 */
export function getClonedBeaNameAudioUrl(personId?: string | null): string | null {
  if (!personId || personId.trim().length === 0) {
    return null;
  }
  const cleanId = personId.trim();
  if (nameManifestCache && cleanId in nameManifestCache) {
    return nameManifestCache[cleanId]?.audioFile ?? `/voices/bea/names/${cleanId}.wav`;
  }
  if (cleanId in DEFAULT_NAME_PROFILES) {
    return DEFAULT_NAME_PROFILES[cleanId]?.audioFile ?? `/voices/bea/names/${cleanId}.wav`;
  }
  return null;
}

let activeAudioElement: HTMLAudioElement | null = null;

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
    const audio = new Audio(audioUrl);
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

