import { describe, it, expect } from 'vitest';
import {
  getClonedBeaAudioUrl,
  getClonedBeaNameAudioUrl,
  getWorkerNameAudioUrl,
  previewVoiceClip,
  resolveVoiceSlot,
  resolveWavFallbackUrl,
  isClonedBeaPhraseAvailable,
  setNameManifest,
} from './clonedBeaVoice';

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

    it('returns mp3 URL for newly registered intern APG-2026-116', () => {
      expect(getClonedBeaNameAudioUrl('APG-2026-116', null)).toBe('/voices/bea/names/APG-2026-116.mp3');
      expect(getClonedBeaNameAudioUrl(null, 'Maricon C. Danao')).toBe('/voices/bea/names/APG-2026-116.mp3');
      expect(getClonedBeaNameAudioUrl(null, 'Maricon Danao')).toBe('/voices/bea/names/APG-2026-116.mp3');
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
});
