import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as clonedBeaVoice from './clonedBeaVoice';
import {
  DEFAULT_TTS_SETTINGS,
  announceAdminAssist,
  announceAttendance,
  announceBathroom,
  announceScanError,
  buildAttendancePhrase,
  buildBathroomPhrase,
  buildScanErrorPhrase,
  getClonedBeaAudioUrl,
  getTtsStatus,
  isClonedBeaPhraseAvailable,
  isTtsEngine,
  loadTtsSettings,
  sanitizeTextForSpeech,
  saveTtsSettings,
  setNameManifest,
  speakText,
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

    it('builds first arrival of the day time-in phrases', () => {
      expect(
        buildAttendancePhrase({
          attendanceType: 'time_in',
          employeeName: 'Ada Lovelace',
          isFirstTimeInToday: true,
        }),
      ).toBe(
        'Good morning, Ada Lovelace. Your time in has been recorded. You are the first arrival today.',
      );

      expect(
        buildAttendancePhrase({
          attendanceType: 'time_in',
          employeeName: null,
          isFirstTimeInToday: true,
        }),
      ).toBe('Your time in has been recorded. You are the first arrival today.');

      expect(
        buildAttendancePhrase({
          attendanceType: 'time_in',
          employeeName: null,
          isAssisted: true,
          isFirstTimeInToday: true,
        }),
      ).toBe('Your assisted time in has been recorded. You are the first arrival today.');
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

    it('appends the return-window reminder to checkout phrases when requested', () => {
      expect(
        buildBathroomPhrase({
          action: 'CHECKOUT',
          genderKey: 'MALE',
          employeeName: 'John Doe',
          remindReturnWindow: true,
        }),
      ).toBe(
        'Male bathroom key checked out for John Doe. Your bathroom key has been checked out. Please return it within fifteen minutes.',
      );
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
    it('triggers speech when TTS is enabled with Piper', async () => {
      const spy = vi
        .spyOn(tauriApi, 'ttsSpeak')
        .mockResolvedValue({ success: true, engineUsed: 'piper' });

      const result = await announceAttendance({
        employeeName: 'Ada Lovelace',
        attendanceType: 'time_in',
        settings: {
          enabled: true,
          engine: 'piper',
          voiceModel: 'en_US-lessac-medium',
          rate: 1.0,
          volume: 1.0,
        },
      });

      expect(spy).toHaveBeenCalledWith(
        'Good morning, Ada Lovelace. Your time in has been recorded.',
        {
          engine: 'piper',
          voiceModel: 'en_US-lessac-medium',
          rate: 1.0,
          volume: 1.0,
        },
      );
      expect(result?.success).toBe(true);
    });

    it('performs hybrid splicing: static cloned prefix + dynamic Piper name + static cloned suffix', async () => {
      const callOrder: string[] = [];
      const playSpy = vi.spyOn(clonedBeaVoice, 'playClonedBeaAudio').mockImplementation(async (url) => {
        callOrder.push(`cloned:${url}`);
        return true;
      });
      const ttsSpy = vi.spyOn(tauriApi, 'ttsSpeak').mockImplementation(async (text, opts) => {
        callOrder.push(`piper:${text}:${opts?.engine ?? 'default'}`);
        return { success: true, engineUsed: 'piper' };
      });

      const result = await announceAttendance({
        employeeName: 'Dynamic Future Intern',
        attendanceType: 'time_in',
        greeting: 'Good morning',
        settings: {
          enabled: true,
          engine: 'cloned-bea',
          voiceModel: 'en_US-amy-medium',
          rate: 1.0,
          volume: 1.0,
        },
      });

      expect(playSpy).toHaveBeenCalledTimes(2);
      expect(ttsSpy).toHaveBeenCalledWith(
        'Dynamic Future Intern',
        expect.objectContaining({ engine: 'piper' }),
      );
      expect(callOrder).toEqual([
        'cloned:/voices/bea/attendance/good-morning.mp3',
        'piper:Dynamic Future Intern:piper',
        'cloned:/voices/bea/attendance/time-in-standard.mp3',
      ]);
      expect(result?.success).toBe(true);
      expect(result?.engineUsed).toBe('cloned-bea');
    });

    it('plays pure static cloned file directly when no employee name is present', async () => {
      const playSpy = vi.spyOn(clonedBeaVoice, 'playClonedBeaAudio').mockResolvedValue(true);
      const ttsSpy = vi.spyOn(tauriApi, 'ttsSpeak');

      const result = await announceAttendance({
        attendanceType: 'time_in',
        settings: {
          enabled: true,
          engine: 'cloned-bea',
          voiceModel: 'en_US-amy-medium',
          rate: 1.0,
          volume: 1.0,
        },
      });

      expect(playSpy).toHaveBeenCalledWith(
        '/voices/bea/attendance/time-in-standard.mp3',
        1.0,
        1.0,
      );
      expect(ttsSpy).not.toHaveBeenCalled();
      expect(result?.success).toBe(true);
      expect(result?.engineUsed).toBe('cloned-bea');
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
        settings: {
          enabled: true,
          engine: 'piper',
          voiceModel: 'en_US-amy-medium',
          rate: 1.0,
          volume: 1.0,
        },
      });

      expect(result).toEqual({
        success: false,
        engineUsed: 'none',
        message: 'Backend audio device failure',
      });
    });
  });

  describe('announceBathroom', () => {
    it('plays single pre-rendered cloned file directly for anonymous bathroom checkout when cloned-bea is active', async () => {
      const playSpy = vi.spyOn(clonedBeaVoice, 'playClonedBeaAudio').mockResolvedValue(true);
      const backendSpy = vi.spyOn(tauriApi, 'ttsSpeak');

      const result = await announceBathroom({
        action: 'CHECKOUT',
        genderKey: 'MALE',
        settings: {
          enabled: true,
          engine: 'cloned-bea',
          voiceModel: 'en_US-amy-medium',
          rate: 1.0,
          volume: 1.0,
        },
      });

      expect(playSpy).toHaveBeenCalledWith(
        '/voices/bea/bathroom/checkout-male.mp3',
        1.0,
        1.0,
      );
      expect(backendSpy).not.toHaveBeenCalled();
      expect(result?.success).toBe(true);
      expect(result?.engineUsed).toBe('cloned-bea');
    });

    it('plays 100% Ma\'am Bea voice for checkout of employee with cloned profile without triggering Piper or double suffix', async () => {
      const playSpy = vi.spyOn(clonedBeaVoice, 'playClonedBeaAudio').mockResolvedValue(true);
      const backendSpy = vi.spyOn(tauriApi, 'ttsSpeak');

      const result = await announceBathroom({
        action: 'CHECKOUT',
        genderKey: 'MALE',
        employeeName: 'Deign Lazaro',
        personId: 'APG-2026-102',
        settings: {
          enabled: true,
          engine: 'cloned-bea',
          voiceModel: 'en_US-amy-medium',
          rate: 1.0,
          volume: 1.0,
        },
      });

      // Checkout only plays 2 segments (prefix + name), NO extra suffix phrase
      expect(playSpy).toHaveBeenCalledTimes(2);
      expect(playSpy).toHaveBeenNthCalledWith(1, '/voices/bea/bathroom/checkout-male-for.mp3', 1.0, 1.0);
      expect(playSpy).toHaveBeenNthCalledWith(2, '/voices/bea/names/APG-2026-102.mp3', 1.0, 1.0);
      expect(backendSpy).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        engineUsed: 'cloned-bea',
      });
    });

    it('appends the Bea return-window reminder to kiosk checkout without Piper', async () => {
      const playSpy = vi.spyOn(clonedBeaVoice, 'playClonedBeaAudio').mockResolvedValue(true);
      const backendSpy = vi.spyOn(tauriApi, 'ttsSpeak');

      const result = await announceBathroom({
        action: 'CHECKOUT',
        genderKey: 'MALE',
        employeeName: 'Deign Lazaro',
        personId: 'APG-2026-102',
        remindReturnWindow: true,
        settings: {
          enabled: true,
          engine: 'cloned-bea',
          voiceModel: 'en_US-amy-medium',
          rate: 1.0,
          volume: 1.0,
        },
      });

      // Checkout plays 3 Bea segments (prefix + name + 15-minute reminder)
      expect(playSpy).toHaveBeenCalledTimes(3);
      expect(playSpy).toHaveBeenNthCalledWith(1, '/voices/bea/bathroom/checkout-male-for.mp3', 1.0, 1.0);
      expect(playSpy).toHaveBeenNthCalledWith(2, '/voices/bea/names/APG-2026-102.mp3', 1.0, 1.0);
      expect(playSpy).toHaveBeenNthCalledWith(3, '/voices/bea/bathroom/bathroom-key-checked-out-15min.mp3', 1.0, 1.0);
      expect(backendSpy).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        engineUsed: 'cloned-bea',
      });
    });

    it('plays 100% Ma\'am Bea voice for return of employee with cloned profile', async () => {
      const playSpy = vi.spyOn(clonedBeaVoice, 'playClonedBeaAudio').mockResolvedValue(true);
      const backendSpy = vi.spyOn(tauriApi, 'ttsSpeak');

      const result = await announceBathroom({
        action: 'RETURN',
        genderKey: 'MALE',
        employeeName: 'Deign Grey O. Lazaro',
        personId: 'APG-2026-102',
        settings: {
          enabled: true,
          engine: 'cloned-bea',
          voiceModel: 'en_US-amy-medium',
          rate: 1.0,
          volume: 1.0,
        },
      });

      // Return plays 3 segments (prefix + name + suffix)
      expect(playSpy).toHaveBeenCalledTimes(3);
      expect(playSpy).toHaveBeenNthCalledWith(1, '/voices/bea/bathroom/thank-you.mp3', 1.0, 1.0);
      expect(playSpy).toHaveBeenNthCalledWith(2, '/voices/bea/names/APG-2026-102.mp3', 1.0, 1.0);
      expect(playSpy).toHaveBeenNthCalledWith(3, '/voices/bea/bathroom/return-male.mp3', 1.0, 1.0);
      expect(backendSpy).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        engineUsed: 'cloned-bea',
      });
    });

    it('plays hybrid splicing (cloned prefix -> live Piper name) for checkout of employee without cloned profile without duplicate suffix', async () => {
      const playSpy = vi.spyOn(clonedBeaVoice, 'playClonedBeaAudio').mockResolvedValue(true);
      const backendSpy = vi.spyOn(tauriApi, 'ttsSpeak').mockResolvedValue({ success: true, engineUsed: 'piper' });

      const result = await announceBathroom({
        action: 'CHECKOUT',
        genderKey: 'FEMALE',
        employeeName: 'Dynamic Employee',
        personId: 'USR_NEW_999',
        settings: {
          enabled: true,
          engine: 'cloned-bea',
          voiceModel: 'en_US-amy-medium',
          rate: 1.0,
          volume: 1.0,
        },
      });

      expect(playSpy).toHaveBeenCalledTimes(1);
      expect(playSpy).toHaveBeenCalledWith('/voices/bea/bathroom/checkout-female-for.mp3', 1.0, 1.0);
      expect(backendSpy).toHaveBeenCalledWith('Dynamic Employee', expect.objectContaining({ engine: 'piper' }));
      expect(result).toEqual({
        success: true,
        engineUsed: 'cloned-bea',
      });
    });

    it('triggers speech with bathroom phrase when enabled with Piper', async () => {
      const spy = vi
        .spyOn(tauriApi, 'ttsSpeak')
        .mockResolvedValue({ success: true, engineUsed: 'piper' });

      const result = await announceBathroom({
        action: 'CHECKOUT',
        genderKey: 'MALE',
        employeeName: 'John Doe',
        settings: {
          enabled: true,
          engine: 'piper',
          voiceModel: 'en_US-amy-medium',
          rate: 1.0,
          volume: 1.0,
        },
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
      vi.spyOn(clonedBeaVoice, 'playClonedBeaAudio').mockResolvedValue(true);
      const result = await announceAdminAssist();
      expect(result?.success).toBe(true);
      expect(result?.engineUsed).toBe('cloned-bea');
    });
  });

  describe('announceScanError', () => {
    it('plays single pre-rendered cloned file directly for scan errors when cloned-bea is active', async () => {
      const playSpy = vi.spyOn(clonedBeaVoice, 'playClonedBeaAudio').mockResolvedValue(true);
      const backendSpy = vi.spyOn(tauriApi, 'ttsSpeak');

      const result = await announceScanError({
        errorCode: 'UNREGISTERED_CARD',
        settings: {
          enabled: true,
          engine: 'cloned-bea',
          voiceModel: 'en_US-amy-medium',
          rate: 1.0,
          volume: 1.0,
        },
      });

      expect(playSpy).toHaveBeenCalledWith(
        '/voices/bea/scan-error/sorry-card-not-recognized.mp3',
        1.0,
        1.0,
      );
      expect(backendSpy).not.toHaveBeenCalled();
      expect(result?.success).toBe(true);
      expect(result?.engineUsed).toBe('cloned-bea');
    });

    it('speaks scan error phrase when enabled with Piper', async () => {
      const spy = vi
        .spyOn(tauriApi, 'ttsSpeak')
        .mockResolvedValue({ success: true, engineUsed: 'system' });

      const result = await announceScanError({
        errorCode: 'BATHROOM_KEY_IN_USE',
        activeHolderName: 'John Doe',
        genderKey: 'MALE',
        settings: {
          enabled: true,
          engine: 'piper',
          voiceModel: 'en_US-amy-medium',
          rate: 1.0,
          volume: 1.0,
        },
      });

      expect(spy).toHaveBeenCalledWith(
        'The male bathroom key is currently in use by John Doe.',
        expect.any(Object),
      );
      expect(result?.success).toBe(true);
    });

    it('splices the Bea "-by" carrier with the holder cloned name without Piper', async () => {
      setNameManifest({
        'EMP-01': { personId: 'EMP-01', displayName: 'John Doe', audioFile: '/voices/bea/names/EMP-01.mp3' },
      });
      const playSpy = vi.spyOn(clonedBeaVoice, 'playClonedBeaAudio').mockResolvedValue(true);
      const backendSpy = vi.spyOn(tauriApi, 'ttsSpeak');

      const result = await announceScanError({
        errorCode: 'BATHROOM_KEY_IN_USE',
        activeHolderName: 'John Doe',
        activeHolderId: 'EMP-01',
        genderKey: 'MALE',
        settings: {
          enabled: true,
          engine: 'cloned-bea',
          voiceModel: 'en_US-amy-medium',
          rate: 1.0,
          volume: 1.0,
        },
      });

      expect(playSpy).toHaveBeenCalledTimes(2);
      expect(playSpy).toHaveBeenNthCalledWith(1, '/voices/bea/scan-error/bathroom-key-in-use-male-by.mp3', 1.0, 1.0);
      expect(playSpy).toHaveBeenNthCalledWith(2, '/voices/bea/names/EMP-01.mp3', 1.0, 1.0);
      expect(backendSpy).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        engineUsed: 'cloned-bea',
      });
    });

    it('falls back to Piper only for the holder name when no cloned clip exists', async () => {
      setNameManifest(null);
      const playSpy = vi.spyOn(clonedBeaVoice, 'playClonedBeaAudio').mockResolvedValue(true);
      const backendSpy = vi.spyOn(tauriApi, 'ttsSpeak').mockResolvedValue({ success: true, engineUsed: 'piper' });

      const result = await announceScanError({
        errorCode: 'BATHROOM_KEY_IN_USE',
        activeHolderName: 'Dynamic Employee',
        activeHolderId: 'USR_NEW_999',
        genderKey: 'FEMALE',
        settings: {
          enabled: true,
          engine: 'cloned-bea',
          voiceModel: 'en_US-amy-medium',
          rate: 1.0,
          volume: 1.0,
        },
      });

      expect(playSpy).toHaveBeenCalledTimes(1);
      expect(playSpy).toHaveBeenCalledWith('/voices/bea/scan-error/bathroom-key-in-use-female-by.mp3', 1.0, 1.0);
      expect(backendSpy).toHaveBeenCalledWith('Dynamic Employee', expect.objectContaining({ engine: 'piper' }));
      expect(result).toEqual({
        success: true,
        engineUsed: 'cloned-bea',
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

  describe('cloned-bea engine', () => {
    it('recognizes cloned-bea as valid TtsEngine', () => {
      expect(isTtsEngine('cloned-bea')).toBe(true);
      expect(isTtsEngine('invalid-engine')).toBe(false);
    });

    it('resolves pre-rendered phrases and rejects uncached dynamic phrases', () => {
      expect(isClonedBeaPhraseAvailable('Your time in has been recorded.')).toBe(true);
      expect(getClonedBeaAudioUrl('Your time in has been recorded.')).toBe(
        '/voices/bea/attendance/time-in-standard.mp3',
      );
      expect(isClonedBeaPhraseAvailable('Good morning, Ada Lovelace. Your time in has been recorded.')).toBe(
        false,
      );
      expect(getClonedBeaAudioUrl('Good morning, Ada Lovelace. Your time in has been recorded.')).toBeNull();
    });

    it('plays pre-rendered attendance audio directly when cloned-bea is selected', async () => {
      const playSpy = vi.spyOn(clonedBeaVoice, 'playClonedBeaAudio').mockResolvedValue(true);
      const backendSpy = vi.spyOn(tauriApi, 'ttsSpeak');

      const result = await announceAttendance({
        attendanceType: 'time_in',
        employeeName: null,
        settings: {
          enabled: true,
          engine: 'cloned-bea',
          voiceModel: 'en_US-amy-medium',
          rate: 1.0,
          volume: 0.9,
        },
      });

      expect(playSpy).toHaveBeenCalledWith(
        '/voices/bea/attendance/time-in-standard.mp3',
        0.9,
        1.0,
      );
      expect(backendSpy).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        engineUsed: 'cloned-bea',
      });
    });

    it('resolves both gendered bathroom checkout-name carriers', () => {
      expect(getClonedBeaAudioUrl('Male bathroom key checked out for')).toBe(
        '/voices/bea/bathroom/checkout-male-for.mp3',
      );
      expect(getClonedBeaAudioUrl('Female bathroom key checked out for')).toBe(
        '/voices/bea/bathroom/checkout-female-for.mp3',
      );
    });

    it('plays pre-rendered bathroom audio directly when cloned-bea is selected', async () => {
      const playSpy = vi.spyOn(clonedBeaVoice, 'playClonedBeaAudio').mockResolvedValue(true);
      const backendSpy = vi.spyOn(tauriApi, 'ttsSpeak');

      const result = await announceBathroom({
        action: 'CHECKOUT',
        genderKey: 'MALE',
        employeeName: null,
        settings: {
          enabled: true,
          engine: 'cloned-bea',
          voiceModel: 'en_US-amy-medium',
          rate: 1.1,
          volume: 0.8,
        },
      });

      expect(playSpy).toHaveBeenCalledWith(
        '/voices/bea/bathroom/checkout-male.mp3',
        0.8,
        1.1,
      );
      expect(backendSpy).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        engineUsed: 'cloned-bea',
      });
    });

    it('plays pre-rendered admin assist audio directly when cloned-bea is selected', async () => {
      const playSpy = vi.spyOn(clonedBeaVoice, 'playClonedBeaAudio').mockResolvedValue(true);
      const backendSpy = vi.spyOn(tauriApi, 'ttsSpeak');

      const result = await announceAdminAssist({
        enabled: true,
        engine: 'cloned-bea',
        voiceModel: 'en_US-amy-medium',
        rate: 1.0,
        volume: 1.0,
      });

      expect(playSpy).toHaveBeenCalledWith(
        '/voices/bea/admin-assist/admin-assist-prompt.mp3',
        1.0,
        1.0,
      );
      expect(backendSpy).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        engineUsed: 'cloned-bea',
      });
    });

    it('plays pre-rendered scan error audio directly when cloned-bea is selected', async () => {
      const playSpy = vi.spyOn(clonedBeaVoice, 'playClonedBeaAudio').mockResolvedValue(true);
      const backendSpy = vi.spyOn(tauriApi, 'ttsSpeak');

      const result = await announceScanError({
        errorCode: 'UNKNOWN_RFID_CARD',
        settings: {
          enabled: true,
          engine: 'cloned-bea',
          voiceModel: 'en_US-amy-medium',
          rate: 1.0,
          volume: 1.0,
        },
      });

      expect(playSpy).toHaveBeenCalledWith(
        '/voices/bea/scan-error/card-not-registered.mp3',
        1.0,
        1.0,
      );
      expect(backendSpy).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        engineUsed: 'cloned-bea',
      });
    });

    it('plays pre-rendered test voice audio directly when cloned-bea is selected', async () => {
      const playSpy = vi.spyOn(clonedBeaVoice, 'playClonedBeaAudio').mockResolvedValue(true);
      const backendSpy = vi.spyOn(tauriApi, 'ttsSpeak');

      const result = await testVoice({
        enabled: true,
        engine: 'cloned-bea',
        voiceModel: 'en_US-amy-medium',
        rate: 1.0,
        volume: 1.0,
      });

      expect(playSpy).toHaveBeenCalledWith(
        '/voices/bea/general/test-voice.mp3',
        1.0,
        1.0,
      );
      expect(backendSpy).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        engineUsed: 'cloned-bea',
      });
    });

    it('falls back gracefully to backend Piper/SAPI when phrase contains dynamic text', async () => {
      const playSpy = vi.spyOn(clonedBeaVoice, 'playClonedBeaAudio');
      const backendSpy = vi
        .spyOn(tauriApi, 'ttsSpeak')
        .mockResolvedValue({ success: true, engineUsed: 'piper' });

      const result = await speakText('Custom non-cached employee announcement for Ada Lovelace.', {
        engine: 'cloned-bea',
        voiceModel: 'en_US-amy-medium',
        rate: 1.0,
        volume: 1.0,
      });

      expect(playSpy).not.toHaveBeenCalled();
      expect(backendSpy).toHaveBeenCalledWith(
        'Custom non-cached employee announcement for Ada Lovelace.',
        expect.objectContaining({ engine: 'auto' }),
      );
      expect(result).toEqual({
        success: true,
        engineUsed: 'piper',
      });
    });

    it('falls back gracefully to backend Piper/SAPI when audio playback fails', async () => {
      vi.spyOn(clonedBeaVoice, 'playClonedBeaAudio').mockResolvedValue(false);
      const backendSpy = vi
        .spyOn(tauriApi, 'ttsSpeak')
        .mockResolvedValue({ success: true, engineUsed: 'system' });

      const result = await speakText('Your time in has been recorded.', {
        engine: 'cloned-bea',
        volume: 1.0,
        rate: 1.0,
      });

      expect(backendSpy).toHaveBeenCalledWith(
        'Your time in has been recorded.',
        expect.objectContaining({ engine: 'auto' }),
      );
      expect(result).toEqual({
        success: true,
        engineUsed: 'system',
      });
    });

    it('falls back gracefully when playClonedBeaAudio throws an unexpected error', async () => {
      vi.spyOn(clonedBeaVoice, 'playClonedBeaAudio').mockRejectedValue(
        new Error('MediaDecodeError'),
      );
      const backendSpy = vi
        .spyOn(tauriApi, 'ttsSpeak')
        .mockResolvedValue({ success: true, engineUsed: 'piper' });

      const result = await speakText('Your time in has been recorded.', {
        engine: 'cloned-bea',
        volume: 1.0,
        rate: 1.0,
      });

      expect(backendSpy).toHaveBeenCalledWith(
        'Your time in has been recorded.',
        expect.objectContaining({ engine: 'auto' }),
      );
      expect(result).toEqual({
        success: true,
        engineUsed: 'piper',
      });
    });

    it('plays cloned prefix -> cloned name -> cloned suffix for existing intern in manifest', async () => {
      setNameManifest({
        usr_intern_123: { audioFile: '/voices/bea/names/usr_intern_123.mp3' },
      });
      const playSpy = vi.spyOn(clonedBeaVoice, 'playClonedBeaAudio').mockResolvedValue(true);
      const piperSpy = vi.spyOn(tauriApi, 'ttsSpeak');

      const result = await announceAttendance({
        attendanceType: 'time_in',
        employeeName: 'Maria Santos',
        personId: 'usr_intern_123',
        settings: {
          enabled: true,
          engine: 'cloned-bea',
          voiceModel: 'en_US-amy-medium',
          rate: 1.0,
          volume: 1.0,
        },
      });

      expect(playSpy).toHaveBeenCalledTimes(3);
      expect(playSpy).toHaveBeenNthCalledWith(1, '/voices/bea/attendance/good-morning.mp3', 1.0, 1.0);
      expect(playSpy).toHaveBeenNthCalledWith(2, '/voices/bea/names/usr_intern_123.mp3', 1.0, 1.0);
      expect(playSpy).toHaveBeenNthCalledWith(3, '/voices/bea/attendance/time-in-standard.mp3', 1.0, 1.0);
      expect(piperSpy).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        engineUsed: 'cloned-bea',
      });
    });

    it('plays cloned prefix -> live Piper name -> cloned suffix for future registrations without cached name', async () => {
      setNameManifest(null);
      const playSpy = vi.spyOn(clonedBeaVoice, 'playClonedBeaAudio').mockResolvedValue(true);
      const piperSpy = vi.spyOn(tauriApi, 'ttsSpeak').mockResolvedValue({ success: true, engineUsed: 'piper' });

      const result = await announceAttendance({
        attendanceType: 'time_in',
        employeeName: 'New Intern',
        personId: 'usr_new_999',
        settings: {
          enabled: true,
          engine: 'cloned-bea',
          voiceModel: 'en_US-amy-medium',
          rate: 1.0,
          volume: 1.0,
        },
      });

      expect(playSpy).toHaveBeenCalledTimes(2);
      expect(playSpy).toHaveBeenNthCalledWith(1, '/voices/bea/attendance/good-morning.mp3', 1.0, 1.0);
      expect(piperSpy).toHaveBeenCalledWith('New Intern', expect.objectContaining({ engine: 'piper' }));
      expect(playSpy).toHaveBeenNthCalledWith(2, '/voices/bea/attendance/time-in-standard.mp3', 1.0, 1.0);
      expect(result).toEqual({
        success: true,
        engineUsed: 'cloned-bea',
      });
    });

    it('falls back to Piper dynamic name when cached name file fails to play', async () => {
      setNameManifest({
        usr_intern_broken: { audioFile: '/voices/bea/names/corrupted.mp3' },
      });
      const playSpy = vi
        .spyOn(clonedBeaVoice, 'playClonedBeaAudio')
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      const piperSpy = vi.spyOn(tauriApi, 'ttsSpeak').mockResolvedValue({ success: true, engineUsed: 'piper' });

      const result = await announceAttendance({
        attendanceType: 'time_in',
        employeeName: 'Maria Santos',
        personId: 'usr_intern_broken',
        settings: {
          enabled: true,
          engine: 'cloned-bea',
          voiceModel: 'en_US-amy-medium',
          rate: 1.0,
          volume: 1.0,
        },
      });

      expect(playSpy).toHaveBeenCalledTimes(3);
      expect(piperSpy).toHaveBeenCalledWith('Maria Santos', expect.objectContaining({ engine: 'piper' }));
      expect(result).toEqual({
        success: true,
        engineUsed: 'cloned-bea',
      });
    });

    it('handles backend failure on fallback without throwing', async () => {
      vi.spyOn(clonedBeaVoice, 'playClonedBeaAudio').mockResolvedValue(false);
      vi.spyOn(tauriApi, 'ttsSpeak').mockRejectedValue(new Error('Audio device offline'));

      const result = await speakText('Your time in has been recorded.', {
        engine: 'cloned-bea',
        volume: 1.0,
        rate: 1.0,
      });

      expect(result).toEqual({
        success: false,
        engineUsed: 'none',
        message: 'Audio device offline',
      });
    });

    it('stops active cloned voice playback when stopSpeech is called', async () => {
      const stopClonedSpy = vi.spyOn(clonedBeaVoice, 'stopClonedBeaAudio');
      const stopBackendSpy = vi.spyOn(tauriApi, 'ttsStop').mockResolvedValue();

      await stopSpeech();

      expect(stopClonedSpy).toHaveBeenCalled();
      expect(stopBackendSpy).toHaveBeenCalled();
    });
  });

  describe('Voicebox runtime isolation', () => {
    it('confirms cloned-bea audio manifest contains no Voicebox network endpoints', () => {
      const manifestStr = JSON.stringify(clonedBeaVoice.CLONED_BEA_PHRASE_MANIFEST);
      expect(manifestStr).not.toContain('127.0.0.1:17493');
      expect(manifestStr).not.toContain('localhost:17493');
      expect(manifestStr).not.toContain('voicebox');
      expect(manifestStr).not.toContain('http://');
      expect(manifestStr).not.toContain('https://');
      expect(manifestStr).toContain('/voices/bea/');
    });
  });
});
