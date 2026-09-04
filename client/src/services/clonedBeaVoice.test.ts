import { describe, it, expect } from 'vitest';
import {
  getClonedBeaAudioUrl,
  getClonedBeaNameAudioUrl,
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
});
