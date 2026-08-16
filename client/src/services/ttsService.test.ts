import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TTS_SETTINGS,
  announceAttendance,
  buildAttendancePhrase,
  getTtsStatus,
  loadTtsSettings,
  sanitizeTextForSpeech,
  saveTtsSettings,
  stopSpeech,
  testVoice,
} from './ttsService';
import { tauriApi } from '../tauri-api';

describe('ttsService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  describe('buildAttendancePhrase', () => {
    it('builds time-in phrase with employee name', () => {
      expect(buildAttendancePhrase('time_in', 'Ada Lovelace')).toBe(
        'Good morning, Ada Lovelace. Your time in has been recorded.',
      );
    });

    it('builds time-out phrase with employee name', () => {
      expect(buildAttendancePhrase('time_out', 'Grace Hopper')).toBe(
        'Goodbye, Grace Hopper. Your time out has been recorded.',
      );
    });

    it('uses safe generic phrase on time-in when employee name is missing or empty', () => {
      expect(buildAttendancePhrase('time_in', null)).toBe(
        'Your time in has been recorded.',
      );
      expect(buildAttendancePhrase('time_in', undefined)).toBe(
        'Your time in has been recorded.',
      );
      expect(buildAttendancePhrase('time_in', '   ')).toBe(
        'Your time in has been recorded.',
      );
    });

    it('uses safe generic phrase on time-out when employee name is missing or empty', () => {
      expect(buildAttendancePhrase('time_out', null)).toBe(
        'Your time out has been recorded.',
      );
      expect(buildAttendancePhrase('time_out', '')).toBe(
        'Your time out has been recorded.',
      );
      expect(buildAttendancePhrase('time_out', '  \t\n ')).toBe(
        'Your time out has been recorded.',
      );
    });
  });

  describe('sanitizeTextForSpeech', () => {
    it('collapses whitespace and trims', () => {
      expect(sanitizeTextForSpeech('  Hello   world \t\n ')).toBe('Hello world');
    });

    it('strips ASCII control characters', () => {
      expect(sanitizeTextForSpeech('Hello\x00\x07\x1B World\x7F!')).toBe(
        'Hello World!',
      );
    });

    it('enforces maximum character length', () => {
      const longText = 'a'.repeat(400);
      expect(sanitizeTextForSpeech(longText, 50).length).toBe(50);
    });
  });

  describe('loadTtsSettings and saveTtsSettings', () => {
    it('returns default settings when storage is empty', () => {
      expect(loadTtsSettings()).toEqual(DEFAULT_TTS_SETTINGS);
    });

    it('persists and retrieves custom settings', () => {
      const custom = {
        enabled: true,
        engine: 'piper' as const,
        voiceModel: 'en_US-amy-medium',
        rate: 1.2,
        volume: 0.8,
      };
      saveTtsSettings(custom);
      expect(loadTtsSettings()).toEqual(custom);
    });

    it('clamps invalid rates and volumes during loading', () => {
      window.localStorage.setItem(
        'alpha_premier_tts_settings',
        JSON.stringify({
          enabled: true,
          engine: 'piper',
          rate: 5.0,
          volume: -2.0,
        }),
      );
      const loaded = loadTtsSettings();
      expect(loaded.rate).toBe(2.0);
      expect(loaded.volume).toBe(0.0);
    });
  });

  describe('announceAttendance', () => {
    it('triggers speech when TTS is enabled', async () => {
      const spy = vi
        .spyOn(tauriApi, 'ttsSpeak')
        .mockResolvedValue({ success: true, engineUsed: 'piper' });

      const result = await announceAttendance({
        employeeName: 'Ada Lovelace',
        attendanceType: 'time_in',
        settings: {
          enabled: true,
          engine: 'auto',
          voiceModel: 'en_US-lessac-medium',
          rate: 1.0,
          volume: 1.0,
        },
      });

      expect(spy).toHaveBeenCalledWith(
        'Good morning, Ada Lovelace. Your time in has been recorded.',
        {
          engine: 'auto',
          voiceModel: 'en_US-lessac-medium',
          rate: 1.0,
          volume: 1.0,
        },
      );
      expect(result?.success).toBe(true);
    });

    it('does not speak when TTS is disabled', async () => {
      const spy = vi.spyOn(tauriApi, 'ttsSpeak');

      const result = await announceAttendance({
        employeeName: 'Ada Lovelace',
        attendanceType: 'time_in',
        settings: {
          enabled: false,
          engine: 'auto',
          voiceModel: 'en_US-lessac-medium',
          rate: 1.0,
          volume: 1.0,
        },
      });

      expect(spy).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it('catches and isolates backend errors so caller never throws', async () => {
      vi.spyOn(tauriApi, 'ttsSpeak').mockRejectedValue(
        new Error('Backend audio device failure'),
      );

      const result = await announceAttendance({
        employeeName: 'Ada Lovelace',
        attendanceType: 'time_in',
      });

      expect(result).toEqual({
        success: false,
        engineUsed: 'none',
        message: 'Backend audio device failure',
      });
    });
  });

  describe('testVoice and stopSpeech', () => {
    it('speaks verification phrase in testVoice', async () => {
      const spy = vi
        .spyOn(tauriApi, 'ttsSpeak')
        .mockResolvedValue({ success: true, engineUsed: 'system' });

      const result = await testVoice();
      expect(spy).toHaveBeenCalledWith(
        'Voice announcements are working correctly.',
        expect.any(Object),
      );
      expect(result?.success).toBe(true);
    });

    it('calls ttsStop in stopSpeech', async () => {
      const spy = vi.spyOn(tauriApi, 'ttsStop').mockResolvedValue();
      await stopSpeech();
      expect(spy).toHaveBeenCalled();
    });

    it('queries live status in getTtsStatus', async () => {
      vi.spyOn(tauriApi, 'ttsStatus').mockResolvedValue({
        enabled: true,
        engine: 'auto',
        piperAvailable: true,
        piperPath: 'C:/piper/piper.exe',
        voiceModelAvailable: true,
        voiceModelPath: 'C:/models/voice.onnx',
        systemSapiAvailable: true,
        isSpeaking: false,
      });

      const status = await getTtsStatus();
      expect(status?.piperAvailable).toBe(true);
      expect(status?.systemSapiAvailable).toBe(true);
    });
  });
});
