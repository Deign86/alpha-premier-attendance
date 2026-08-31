import type { UserGender } from '@rfid-attendance/shared';

/**
 * @deprecated Legacy Web Speech API helper.
 *
 * NOTE: All authoritative kiosk announcements are handled exclusively by
 * `client/src/services/ttsService.ts` (Ma'am Bea Cloned Voice / Piper / SAPI).
 * This module is maintained only for legacy backwards-compatibility unit tests.
 */

/** Female voice names, best first. Each entry is matched as a lowercase substring. */
const FEMALE_VOICE_HINTS = [
  'aria',
  'jenny',
  'zira',
  'samantha',
  'victoria',
  'karen',
  'moira',
  'tessa',
  'susan',
  'veena',
  'female',
  'google us english',
  'michelle',
  'allison',
  'ava',
  'emma',
  'joanna',
  'kendra',
  'kimberly',
  'salli',
  'ivy',
  'libby',
  'sonia',
  'natasha',
  'serena',
] as const;

let cachedVoices: SpeechSynthesisVoice[] = [];

/** Snapshot the OS voice list; browsers populate it asynchronously. */
function refreshVoices() {
  if (!('window' in globalThis) || !('speechSynthesis' in window)) return;
  cachedVoices = window.speechSynthesis.getVoices();
}

if ('window' in globalThis && 'speechSynthesis' in window) {
  refreshVoices();
  window.speechSynthesis.addEventListener?.('voiceschanged', refreshVoices);
}

/**
 * Pick the most natural female voice available. Voice lists are scanned in
 * hint-priority order so a modern assistant voice (Aria, Jenny) wins over a
 * legacy one (Zira) when the OS installs both.
 */
export function pickFemaleVoice(voices: readonly SpeechSynthesisVoice[] = cachedVoices): SpeechSynthesisVoice | null {
  for (const hint of FEMALE_VOICE_HINTS) {
    const match = voices.find((voice) => voice.name.toLowerCase().includes(hint));
    if (match) return match;
  }
  return null;
}

export type SpeakOptions = {
  /** Speaking rate multiplier; 1 is the default. */
  rate?: number;
  /** Voice pitch multiplier; 1 is the default. */
  pitch?: number;
};

/**
 * Speak a phrase through a female voice. Any previous utterance is cancelled
 * first so rapid card taps never queue overlapping announcements.
 */
export function speak(phrase: string, { rate = 1, pitch = 1 }: SpeakOptions = {}) {
  if (!('window' in globalThis) || !('speechSynthesis' in window)) return;
  const synthesis = window.speechSynthesis;
  const utterance = new SpeechSynthesisUtterance(phrase);
  // Query the live voice list: browsers may load voices after module init.
  const voices = synthesis.getVoices();
  const voice = voices.length ? pickFemaleVoice(voices) : pickFemaleVoice(cachedVoices);
  if (voice) utterance.voice = voice;
  utterance.rate = rate;
  utterance.pitch = pitch;
  // BUG-VOICE-01: Attach onerror handler to report speech synthesis errors
  utterance.onerror = (event) => {
    console.warn('Speech synthesis utterance error:', event.error);
  };
  synthesis.cancel();
  synthesis.speak(utterance);
}

/**
 * Time-in announcement: the time-appropriate greeting ("Good morning") plus
 * the employee's honorific and name, e.g. "Good morning Sir Ada Lovelace" or
 * "Good morning Ma'am Maria Santos". Falls back to "Sir" when gender is
 * unset, preserving the original behavior.
 */
export function announceTimeIn(greeting: string, employeeName: string, gender: UserGender | null | undefined) {
  const title = gender === 'FEMALE' ? 'Ma\'am' : 'Sir';
  speak(`${greeting} ${title} ${employeeName}`);
}

/** Time-out announcement: a named farewell. */
export function announceTimeOut(employeeName: string) {
  speak(`Good bye ${employeeName}`);
}

/**
 * Chromium keeps speech synthesis paused until the page has seen a user
 * gesture, and has a long-standing quirk where synthesis can stall in a paused
 * state. The kiosk unlocks audio on the first interaction and keeps a light
 * heartbeat that resumes any stalled synthesis, so the very first card tap can
 * announce without the operator having to click first.
 */
function keepAudioUnlocked() {
  if (!('window' in globalThis) || !('speechSynthesis' in window)) return;
  const resume = () => window.speechSynthesis.resume();
  window.addEventListener('pointerdown', resume);
  window.addEventListener('keydown', resume);
  if (import.meta.env.MODE === 'test') return; // no heartbeat under vitest
  const heartbeat = window.setInterval(resume, 10_000);
  window.addEventListener('beforeunload', () => window.clearInterval(heartbeat));
}

keepAudioUnlocked();
