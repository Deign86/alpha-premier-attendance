import { describe, it, expect, vi } from 'vitest';
import {
  getClonedBeaAudioUrl,
  getClonedBeaNameAudioUrl,
  getWorkerNameAudioUrl,
  playClonedBeaAudio,
  previewVoiceClip,
  resolveVoiceSlot,
  resolveWavFallbackUrl,
  isClonedBeaPhraseAvailable,
  setNameManifest,
} from './clonedBeaVoice';
import { tauriApi } from '../tauri-api';

describe('clonedBeaVoice', () => {
  describe('getClonedBeaAudioUrl', () => {
    it('returns mp3 URL for known phrase', () => {
      const url = getClonedBeaAudioUrl('Good morning,');
      expect(url).toBe('/voices/bea/attendance/good-morning.mp3');
    });

    it('returns mp3 URL for scan error phrase', () => {
      const url = getClonedBeaAudioUrl('Card scanned too recently. Please wait.');
      expect(url).toBe('/voices/bea/scan-error/card-scanned-too-recently.mp3');
    });

    it('returns null for unknown phrase', () => {
      const url = getClonedBeaAudioUrl('This phrase does not exist');
      expect(url).toBeNull();
    });

    it('trims input before lookup', () => {
      const url = getClonedBeaAudioUrl('  Good morning,  ');
      expect(url).toBe('/voices/bea/attendance/good-morning.mp3');
    });
  });

  describe('getClonedBeaNameAudioUrl', () => {
    it('returns mp3 URL for known person ID', () => {
      const url = getClonedBeaNameAudioUrl('APG-2026-102', null);
      expect(url).toBe('/voices/bea/names/APG-2026-102.mp3');
    });

    it('returns mp3 URL for known employee name', () => {
      const url = getClonedBeaNameAudioUrl(null, 'Deign Grey O. Lazaro');
      expect(url).toBe('/voices/bea/names/APG-2026-102.mp3');
    });

    it('returns mp3 URL for relaxed name match', () => {
      const url = getClonedBeaNameAudioUrl(null, 'Deign Lazaro');
      expect(url).toBe('/voices/bea/names/APG-2026-102.mp3');
    });

    it('returns mp3 URL for newly registered interns APG-2026-116 to APG-2026-119', () => {
      expect(getClonedBeaNameAudioUrl('APG-2026-116', null)).toBe('/voices/bea/names/APG-2026-116.mp3');
      expect(getClonedBeaNameAudioUrl(null, 'Maricon C. Danao')).toBe('/voices/bea/names/APG-2026-116.mp3');
      expect(getClonedBeaNameAudioUrl(null, 'Maricon Danao')).toBe('/voices/bea/names/APG-2026-116.mp3');

      expect(getClonedBeaNameAudioUrl('APG-2026-117', null)).toBe('/voices/bea/names/APG-2026-117.mp3');
      expect(getClonedBeaNameAudioUrl(null, 'Jennirille Lhoize S. Cordova')).toBe('/voices/bea/names/APG-2026-117.mp3');
      expect(getClonedBeaNameAudioUrl(null, 'Jennirille Lhoize Cordova')).toBe('/voices/bea/names/APG-2026-117.mp3');

      expect(getClonedBeaNameAudioUrl('APG-2026-118', null)).toBe('/voices/bea/names/APG-2026-118.mp3');
      expect(getClonedBeaNameAudioUrl(null, 'Sophia Marielle A. Urbano')).toBe('/voices/bea/names/APG-2026-118.mp3');
      expect(getClonedBeaNameAudioUrl(null, 'Sophia Marielle Urbano')).toBe('/voices/bea/names/APG-2026-118.mp3');

      expect(getClonedBeaNameAudioUrl('APG-2026-119', null)).toBe('/voices/bea/names/APG-2026-119.mp3');
      expect(getClonedBeaNameAudioUrl(null, 'Melanie P. Garcia')).toBe('/voices/bea/names/APG-2026-119.mp3');
      expect(getClonedBeaNameAudioUrl(null, 'Melanie Garcia')).toBe('/voices/bea/names/APG-2026-119.mp3');
    });

    it('returns null for unknown person', () => {
      const url = getClonedBeaNameAudioUrl('UNKNOWN-999', null);
      expect(url).toBeNull();
    });

    it('prefers person ID over employee name when both provided', () => {
      const url = getClonedBeaNameAudioUrl('APG-2026-092', 'Wrong Name');
      expect(url).toBe('/voices/bea/names/APG-2026-092.mp3');
    });

    it('uses runtime manifest when set', () => {
      setNameManifest({
        'TEST-001': {
          audioFile: '/voices/bea/names/TEST-001.mp3',
          displayName: 'Test Person',
          normalizedSpeechText: 'Test Person',
        },
      });

      const url = getClonedBeaNameAudioUrl('TEST-001', null);
      expect(url).toBe('/voices/bea/names/TEST-001.mp3');

      // Reset to default
      setNameManifest(null);
    });
  });

  describe('resolveWavFallbackUrl', () => {
    it('converts mp3 URL to wav URL', () => {
      const mp3Url = '/voices/bea/attendance/good-morning.mp3';
      const wavUrl = resolveWavFallbackUrl(mp3Url);
      expect(wavUrl).toBe('/voices/bea/attendance/good-morning.wav');
    });

    it('handles uppercase extension', () => {
      const mp3Url = '/voices/bea/names/APG-2026-102.MP3';
      const wavUrl = resolveWavFallbackUrl(mp3Url);
      expect(wavUrl).toBe('/voices/bea/names/APG-2026-102.wav');
    });

    it('returns unchanged URL if not mp3', () => {
      const url = '/voices/bea/attendance/good-morning.wav';
      const result = resolveWavFallbackUrl(url);
      expect(result).toBe('/voices/bea/attendance/good-morning.wav');
    });
  });

  describe('isClonedBeaPhraseAvailable', () => {
    it('returns true for available phrase', () => {
      expect(isClonedBeaPhraseAvailable('Good morning,')).toBe(true);
    });

    it('returns false for unavailable phrase', () => {
      expect(isClonedBeaPhraseAvailable('Unknown phrase')).toBe(false);
    });
  });

  describe('resolveVoiceSlot', () => {
    it('prefers worker clips, then queue, then manifest', () => {
      expect(resolveVoiceSlot(true, 'DONE', null)).toBe('cloned');
      expect(resolveVoiceSlot(false, null, '/voices/bea/names/X.mp3')).toBe('cloned');
      expect(resolveVoiceSlot(false, 'PENDING', null)).toBe('queued');
      expect(resolveVoiceSlot(false, 'RETRY', null)).toBe('queued');
      expect(resolveVoiceSlot(false, 'PROCESSING', null)).toBe('queued');
      expect(resolveVoiceSlot(false, 'DONE', null)).toBe('fallback');
      expect(resolveVoiceSlot(false, null, null)).toBe('fallback');
    });
  });

  describe('getWorkerNameAudioUrl', () => {
    it('returns null without a person id', async () => {
      await expect(getWorkerNameAudioUrl(null)).resolves.toBeNull();
      await expect(getWorkerNameAudioUrl('   ')).resolves.toBeNull();
    });

    it('returns null outside Tauri without invoking the backend', async () => {
      await expect(getWorkerNameAudioUrl('APG-2026-102')).resolves.toBeNull();
    });
  });

  describe('previewVoiceClip', () => {
    it('resolves false without throwing when HTML Audio is unavailable', async () => {
      await expect(previewVoiceClip('/voices/bea/names/APG-2026-102.mp3')).resolves.toBe(false);
    });
  });

  describe('playClonedBeaAudio', () => {
    it('does not invoke tauriApi.ttsSpeak with arbitrary URLs or unmapped name clips', async () => {
      Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
      const ttsSpeakSpy = vi.spyOn(tauriApi, 'ttsSpeak').mockResolvedValue({
        success: true,
        engineUsed: 'piper',
      });

      try {
        const result = await playClonedBeaAudio('http://127.0.0.1:3900/voices/bea/names/custom.mp3');
        // Because it is a URL and not a mapped phrase, ttsSpeak must NOT be called with it
        expect(ttsSpeakSpy).not.toHaveBeenCalled();
        expect(result).toBe(false);
      } finally {
        // SAFETY: Type refinement to delete test mock property on window
        delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      }
    });

    it('only accepts ttsSpeak success if engineUsed is cloned-bea', async () => {
      Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
      const ttsSpeakSpy = vi.spyOn(tauriApi, 'ttsSpeak').mockResolvedValue({
        success: true,
        engineUsed: 'piper', // Fell back to Piper, not actual cloned audio
      });

      try {
        const result = await playClonedBeaAudio('/voices/bea/attendance/good-morning.mp3');
        expect(ttsSpeakSpy).toHaveBeenCalledWith('Good morning,', expect.objectContaining({ engine: 'cloned-bea' }));
        // Because engineUsed was 'piper', it must not treat it as cloned audio success
        expect(result).toBe(false);
      } finally {
        // SAFETY: Type refinement to delete test mock property on window
        delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      }
    });

    it('returns true when tauriApi.ttsSpeak succeeds with engineUsed cloned-bea', async () => {
      Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
      const ttsSpeakSpy = vi.spyOn(tauriApi, 'ttsSpeak').mockResolvedValue({
        success: true,
        engineUsed: 'cloned-bea',
      });

      try {
        const result = await playClonedBeaAudio('/voices/bea/attendance/good-morning.mp3');
        expect(ttsSpeakSpy).toHaveBeenCalledWith('Good morning,', expect.objectContaining({ engine: 'cloned-bea' }));
        expect(result).toBe(true);
      } finally {
        // SAFETY: Type refinement to delete test mock property on window
        delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      }
    });
  });
});
