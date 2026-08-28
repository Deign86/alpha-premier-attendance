import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TTS_SETTINGS,
  announceAdminAssist,
  announceAttendance,
  announceBathroom,
  announceScanError,
  buildAttendancePhrase,
  buildBathroomPhrase,
  buildScanErrorPhrase,
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

    it('builds grace period time-in phrase noting outlier', () => {
      expect(
        buildAttendancePhrase({
          attendanceType: 'time_in',
          employeeName: 'Ada Lovelace',
          arrivalStatus: 'GRACE_PERIOD',
        }),
      ).toBe(
        'Good morning, Ada Lovelace. Your time in has been recorded. You made it within the grace period.',
      );

      expect(
        buildAttendancePhrase({
          attendanceType: 'time_in',
          employeeName: null,
          arrivalStatus: 'GRACE_PERIOD',
        }),
      ).toBe(
        'Your time in has been recorded within the grace period.',
      );
    });

    it('builds late time-in phrase noting outlier', () => {
      expect(
        buildAttendancePhrase({
          attendanceType: 'time_in',
          employeeName: 'Ada Lovelace',
          arrivalStatus: 'LATE',
        }),
      ).toBe(
        'Good morning, Ada Lovelace. Your time in has been recorded. You are late.',
      );

      expect(
        buildAttendancePhrase({
          attendanceType: 'time_in',
          employeeName: null,
          arrivalStatus: 'LATE',
        }),
      ).toBe(
        'Your time in has been recorded. You are late.',
      );
    });

    it('builds late time-out phrase noting manual correction required', () => {
      expect(
        buildAttendancePhrase({
          attendanceType: 'time_out',
          employeeName: 'Grace Hopper',
          isLateTimeout: true,
        }),
      ).toBe(
        'Goodbye, Grace Hopper. Your time out was recorded after office hours. Manual correction is required.',
      );

      expect(
        buildAttendancePhrase({
          attendanceType: 'time_out',
          employeeName: null,
          isLateTimeout: true,
        }),
      ).toBe(
        'Your time out was recorded after office hours. Manual correction is required.',
      );
    });

    it('builds assisted attendance phrases with assisted prefix', () => {
      expect(
        buildAttendancePhrase({
          attendanceType: 'time_in',
          employeeName: 'Ada Lovelace',
          isAssisted: true,
          arrivalStatus: 'ON_TIME',
        }),
      ).toBe(
        'Good morning, Ada Lovelace. Your assisted time in has been recorded.',
      );

      expect(
        buildAttendancePhrase({
          attendanceType: 'time_out',
          employeeName: 'Grace Hopper',
          isAssisted: true,
        }),
      ).toBe(
        'Goodbye, Grace Hopper. Your assisted time out has been recorded.',
      );
    });

    it('determines time-of-day greeting from ISO timestamps', () => {
      expect(
        buildAttendancePhrase({
          attendanceType: 'time_in',
          employeeName: 'Ada Lovelace',
          timeInIso: '2026-08-28T07:30:00+08:00',
        }),
      ).toBe(
        'Good morning, Ada Lovelace. Your time in has been recorded.',
      );

      expect(
        buildAttendancePhrase({
          attendanceType: 'time_in',
          employeeName: 'Ada Lovelace',
          timeInIso: '2026-08-28T13:30:00+08:00',
          arrivalStatus: 'LATE',
        }),
      ).toBe(
        'Good afternoon, Ada Lovelace. Your time in has been recorded. You are late.',
      );

      expect(
        buildAttendancePhrase({
          attendanceType: 'time_in',
          employeeName: 'Ada Lovelace',
          timeInIso: '2026-08-28T19:00:00+08:00',
        }),
      ).toBe(
        'Good evening, Ada Lovelace. Your time in has been recorded.',
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

  describe('buildBathroomPhrase', () => {
    it('builds male and female key checkout phrases with names', () => {
      expect(
        buildBathroomPhrase({
          action: 'CHECKOUT',
          genderKey: 'MALE',
          employeeName: 'John Doe',
        }),
      ).toBe('Male bathroom key checked out for John Doe.');

      expect(
        buildBathroomPhrase({
          action: 'CHECKOUT',
          genderKey: 'FEMALE',
          employeeName: 'Jane Smith',
        }),
      ).toBe('Female bathroom key checked out for Jane Smith.');
    });

    it('builds male and female key return phrases with names', () => {
      expect(
        buildBathroomPhrase({
          action: 'RETURN',
          genderKey: 'MALE',
          employeeName: 'John Doe',
        }),
      ).toBe('Thank you, John Doe. Male bathroom key returned.');

      expect(
        buildBathroomPhrase({
          action: 'RETURN',
          genderKey: 'FEMALE',
          employeeName: 'Jane Smith',
        }),
      ).toBe('Thank you, Jane Smith. Female bathroom key returned.');
    });

    it('handles checkout and return phrases when name is missing', () => {
      expect(
        buildBathroomPhrase({
          action: 'CHECKOUT',
          genderKey: 'MALE',
          employeeName: null,
        }),
      ).toBe('Male bathroom key checked out.');

      expect(
        buildBathroomPhrase({
          action: 'RETURN',
          genderKey: 'FEMALE',
          employeeName: undefined,
        }),
      ).toBe('Female bathroom key returned.');
    });
  });

  describe('buildScanErrorPhrase', () => {
    it('builds bathroom key in use phrase with active holder name', () => {
      expect(
        buildScanErrorPhrase({
          errorCode: 'BATHROOM_KEY_IN_USE',
          activeHolderName: 'John Doe',
          genderKey: 'MALE',
        }),
      ).toBe('The male bathroom key is currently in use by John Doe.');

      expect(
        buildScanErrorPhrase({
          errorCode: 'BATHROOM_KEY_IN_USE',
          genderKey: 'FEMALE',
        }),
      ).toBe('The female bathroom key is currently in use.');
    });

    it('builds known scan error messages clearly', () => {
      expect(buildScanErrorPhrase({ errorCode: 'UNKNOWN_RFID_CARD' })).toBe(
        'This card is not registered.',
      );
      expect(buildScanErrorPhrase({ errorCode: 'USER_NOT_FOUND' })).toBe(
        'This card is not registered.',
      );
      expect(buildScanErrorPhrase({ errorCode: 'INACTIVE_USER' })).toBe(
        'Employee record is inactive.',
      );
      expect(buildScanErrorPhrase({ errorCode: 'USER_INACTIVE' })).toBe(
        'Employee record is inactive.',
      );
      expect(buildScanErrorPhrase({ errorCode: 'DUPLICATE_SCAN' })).toBe(
        'Card scanned too recently. Please wait.',
      );
      expect(buildScanErrorPhrase({ errorCode: 'ADMIN_CARD_NOT_ALLOWED' })).toBe(
        'Admin cards cannot check out bathroom keys.',
      );
      expect(buildScanErrorPhrase({ errorCode: 'ADMIN_CARD_REQUIRES_SELECTION' })).toBe(
        'Admin card requires employee selection.',
      );
      expect(buildScanErrorPhrase({ errorCode: 'GOOGLE_SHEETS_UNAVAILABLE' })).toBe(
        'Attendance service is temporarily unavailable.',
      );
      expect(buildScanErrorPhrase({ errorCode: 'ATTENDANCE_DATA_CONFLICT' })).toBe(
        'Attendance conflict. Please try again.',
      );
    });

    it('builds attendance already completed error messages', () => {
      expect(
        buildScanErrorPhrase({
          errorCode: 'ATTENDANCE_ALREADY_COMPLETED',
          message: 'Attendance is already complete for today.',
        }),
      ).toBe('Attendance is already completed for today.');

      expect(
        buildScanErrorPhrase({
          errorCode: 'ATTENDANCE_ALREADY_COMPLETED',
          message: 'Attendance timed out after office hours and is pending manual correction.',
        }),
      ).toBe('Attendance timed out after office hours and is pending manual correction.');
    });

    it('falls back to sanitized message or generic default', () => {
      expect(
        buildScanErrorPhrase({
          errorCode: 'UNKNOWN_CUSTOM_ERROR',
          message: 'Custom system warning',
        }),
      ).toBe('Custom system warning');

      expect(
        buildScanErrorPhrase({
          errorCode: 'UNKNOWN_CUSTOM_ERROR',
          message: '',
        }),
      ).toBe('Scan could not be processed.');
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

  describe('announceBathroom', () => {
    it('triggers speech with bathroom phrase when enabled', async () => {
      const spy = vi
        .spyOn(tauriApi, 'ttsSpeak')
        .mockResolvedValue({ success: true, engineUsed: 'piper' });

      const result = await announceBathroom({
        action: 'CHECKOUT',
        genderKey: 'MALE',
        employeeName: 'John Doe',
      });

      expect(spy).toHaveBeenCalledWith(
        'Male bathroom key checked out for John Doe.',
        expect.any(Object),
      );
      expect(result?.success).toBe(true);
    });

    it('does not speak when TTS is disabled', async () => {
      const spy = vi.spyOn(tauriApi, 'ttsSpeak');

      const result = await announceBathroom({
        action: 'RETURN',
        genderKey: 'FEMALE',
        employeeName: 'Jane Smith',
        settings: {
          enabled: false,
          engine: 'disabled',
          voiceModel: 'en_US-amy-medium',
          rate: 1.0,
          volume: 1.0,
        },
      });

      expect(spy).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });
  });

  describe('announceAdminAssist', () => {
    it('speaks admin assist recognition phrase when enabled', async () => {
      const spy = vi
        .spyOn(tauriApi, 'ttsSpeak')
        .mockResolvedValue({ success: true, engineUsed: 'piper' });

      const result = await announceAdminAssist();
      expect(spy).toHaveBeenCalledWith(
        'Admin assist card recognized. Please select an employee.',
        expect.any(Object),
      );
      expect(result?.success).toBe(true);
    });
  });

  describe('announceScanError', () => {
    it('speaks scan error phrase when enabled', async () => {
      const spy = vi
        .spyOn(tauriApi, 'ttsSpeak')
        .mockResolvedValue({ success: true, engineUsed: 'system' });

      const result = await announceScanError({
        errorCode: 'BATHROOM_KEY_IN_USE',
        activeHolderName: 'John Doe',
        genderKey: 'MALE',
      });

      expect(spy).toHaveBeenCalledWith(
        'The male bathroom key is currently in use by John Doe.',
        expect.any(Object),
      );
      expect(result?.success).toBe(true);
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
