import { afterEach, describe, expect, it, vi } from 'vitest';
import { announceTimeIn, announceTimeOut, pickFemaleVoice, speak } from './speech';

const voice = (name: string): SpeechSynthesisVoice => ({
  name,
  lang: 'en-US',
  localService: true,
  default: false,
  voiceURI: name,
});

/** jsdom has no speech synthesis; stub it before the module's import-time setup runs. */
function stubSpeechSynthesis(voices: SpeechSynthesisVoice[]) {
  const synthesis = {
    speak: vi.fn(),
    cancel: vi.fn(),
    resume: vi.fn(),
    getVoices: vi.fn(() => voices),
    addEventListener: vi.fn(),
  };
  class MockUtterance {
    voice: SpeechSynthesisVoice | null = null;
    rate = 1;
    pitch = 1;
    constructor(public text: string) {}
  }
  vi.stubGlobal('speechSynthesis', synthesis);
  vi.stubGlobal('SpeechSynthesisUtterance', MockUtterance);
  return { synthesis, MockUtterance };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pickFemaleVoice', () => {
  it('prefers a female voice over a male default', () => {
    const picked = pickFemaleVoice([
      voice('Microsoft David - English (United States)'),
      voice('Microsoft Zira - English (United States)'),
    ]);
    expect(picked?.name).toContain('Zira');
  });

  it('prefers a modern assistant voice (Aria, Jenny) over legacy Zira', () => {
    expect(pickFemaleVoice([voice('Microsoft Zira'), voice('Microsoft Aria')])?.name).toBe('Microsoft Aria');
    expect(pickFemaleVoice([voice('Microsoft Zira'), voice('Microsoft Jenny')])?.name).toBe('Microsoft Jenny');
  });

  it('recognizes Apple and Google female voices', () => {
    expect(pickFemaleVoice([voice('Samantha (English)')])?.name).toContain('Samantha');
    expect(pickFemaleVoice([voice('Google US English')])?.name).toContain('Google US English');
  });

  it('returns null when no female voice is installed', () => {
    expect(pickFemaleVoice([voice('Microsoft David'), voice('Microsoft Mark')])).toBeNull();
  });
});

describe('announceTimeIn', () => {
  it('composes the greeting with the employee name and male honorific', () => {
    const { synthesis } = stubSpeechSynthesis([voice('Microsoft Zira - English (United States)')]);
    announceTimeIn('Good afternoon', 'Deign Lazaro', 'MALE');
    // SAFETY: Mock call argument is SpeechSynthesisUtterance
    const utterance = synthesis.speak.mock.calls[0][0] as SpeechSynthesisUtterance;
    expect(utterance.text).toBe('Good afternoon Sir Deign Lazaro');
  });

  it('uses Ma\'am for female employees', () => {
    const { synthesis } = stubSpeechSynthesis([]);
    announceTimeIn('Good morning', 'Maria Santos', 'FEMALE');
    // SAFETY: Mock call argument is SpeechSynthesisUtterance
    const utterance = synthesis.speak.mock.calls[0][0] as SpeechSynthesisUtterance;
    expect(utterance.text).toBe('Good morning Ma\'am Maria Santos');
  });

  it('falls back to Sir when gender is unset', () => {
    const { synthesis } = stubSpeechSynthesis([]);
    announceTimeIn('Good morning', 'Deign Lazaro', null);
    // SAFETY: Mock call argument is SpeechSynthesisUtterance
    const utterance = synthesis.speak.mock.calls[0][0] as SpeechSynthesisUtterance;
    expect(utterance.text).toBe('Good morning Sir Deign Lazaro');
  });
});

describe('speak', () => {
  it('says goodbye with the employee name', () => {
    const { synthesis } = stubSpeechSynthesis([]);
    announceTimeOut('Deign Lazaro');
    // SAFETY: Mock call argument is SpeechSynthesisUtterance
    const utterance = synthesis.speak.mock.calls[0][0] as SpeechSynthesisUtterance;
    expect(utterance.text).toBe('Good bye Deign Lazaro');
  });

  it('speaks the phrase through the chosen female voice', () => {
    const { synthesis } = stubSpeechSynthesis([voice('Microsoft Zira - English (United States)')]);
    speak('Good morning');
    expect(synthesis.cancel).toHaveBeenCalledOnce();
    expect(synthesis.speak).toHaveBeenCalledOnce();
    // SAFETY: Mock call argument is SpeechSynthesisUtterance
    const utterance = synthesis.speak.mock.calls[0][0] as SpeechSynthesisUtterance;
    expect(utterance.text).toBe('Good morning');
    expect(utterance.voice?.name).toContain('Zira');
  });

  it('falls back to the default voice when no female voice exists', () => {
    const { synthesis } = stubSpeechSynthesis([voice('Microsoft David - English (United States)')]);
    speak('Good bye');
    // SAFETY: Mock call argument is SpeechSynthesisUtterance
    const utterance = synthesis.speak.mock.calls[0][0] as SpeechSynthesisUtterance;
    expect(utterance.voice).toBeNull();
  });

  it('does nothing when speech synthesis is unavailable', () => {
    // No stub installed: jsdom has no speechSynthesis global.
    expect(() => speak('Good morning')).not.toThrow();
  });
});
