import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { TtsSettings, TtsStatusResponse, VoiceWorkerStatus } from '@rfid-attendance/shared';
import {
  DEFAULT_TTS_SETTINGS,
  DEFAULT_VOICESTUDIO_BASE_URL,
  checkVoiceStudioConnection,
  getTtsStatus,
  loadTtsSettings,
  resolveTtsMode,
  saveTtsSettings,
  stopSpeech,
  testVoice,
} from './services/ttsService';
import { tauriApi } from './tauri-api';

export interface VoiceSettingsPanelProps {
  onSettingsChange?: (settings: TtsSettings) => void;
}

export function VoiceSettingsPanel({ onSettingsChange }: VoiceSettingsPanelProps) {
  const [settings, setSettings] = useState<TtsSettings>(DEFAULT_TTS_SETTINGS);
  const [status, setStatus] = useState<TtsStatusResponse | null>(null);
  const [testing, setTesting] = useState(false);
  const [checkingStudio, setCheckingStudio] = useState(false);
  const [workerStatus, setWorkerStatus] = useState<VoiceWorkerStatus | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [feedbackType, setFeedbackType] = useState<'info' | 'error' | 'success'>('info');
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persistHostToNative = (host: string): void => {
    try {
      void tauriApi.setVoicestudioHost(host).catch(() => undefined);
    } catch {
      // Browser dev: localStorage only.
    }
  };

  const persistPinToNative = (pin: string): void => {
    try {
      void tauriApi.setVoicestudioPin(pin).catch(() => undefined);
    } catch {
      // Browser dev: localStorage only.
    }
  };

  const refreshStatus = useCallback(async () => {
    const liveStatus = await getTtsStatus();
    if (liveStatus) {
      setStatus(liveStatus);
    }
  }, []);

  useEffect(() => {
    const loaded = loadTtsSettings();
    setSettings(loaded);
    void refreshStatus();
    // Native host is the worker's source of truth; converge once on mount:
    // push a local custom value up, otherwise adopt the stored native value.
    try {
      void tauriApi
        .getVoicestudioHost()
        .then((host) => {
          setSettings((prev) => {
            const local = prev.voiceStudioBaseUrl ?? DEFAULT_VOICESTUDIO_BASE_URL;
            if (host.length > 0 && host !== local) {
              persistHostToNative(local);
              return prev;
            }
            if (host.length > 0) {
              return { ...prev, voiceStudioBaseUrl: host };
            }
            return prev;
          });
        })
        .catch(() => undefined);
      void tauriApi
        .getVoicestudioPin()
        .then((pin) => {
          setSettings((prev) => {
            const local = prev.voiceStudioPin ?? '';
            if (pin !== local) {
              if (local.length > 0) {
                persistPinToNative(local);
                return prev;
              }
              return { ...prev, voiceStudioPin: pin };
            }
            return prev;
          });
        })
        .catch(() => undefined);
    } catch {
      // Browser dev: localStorage only.
    }
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [refreshStatus]);

  const updateSetting = <K extends keyof TtsSettings>(key: K, value: TtsSettings[K]) => {
    setSettings((prev) => {
      const updated = { ...prev, [key]: value };
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => saveTtsSettings(updated), 250);
      onSettingsChange?.(updated);
      return updated;
    });
  };

  useEffect(() => {
    let cancelled = false;
    const refreshWorker = (): void => {
      try {
        void tauriApi
          .voiceWorkerStatus()
          .then((worker) => {
            if (!cancelled) setWorkerStatus(worker);
          })
          .catch(() => undefined);
      } catch {
        // Browser dev: no worker status.
      }
    };
    refreshWorker();
    const timer = window.setInterval(refreshWorker, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const handleTestVoice = async () => {
    setTesting(true);
    setFeedback('Playing sample voice announcement…');
    setFeedbackType('info');

    const result = await testVoice(settings);
    setTesting(false);

    if (result && result.success) {
      const engineLabel =
        result.engineUsed === 'cloned-bea'
          ? "Ma'am Bea (Cloned voice)"
          : result.engineUsed === 'piper'
            ? 'Piper (local neural voice)'
            : result.engineUsed === 'system'
              ? 'Windows SAPI (system voice)'
              : 'No voice played';
      setFeedback(`Voice played successfully via ${engineLabel}.`);
      setFeedbackType('success');
    } else {
      setFeedback(result?.message ?? 'Speech synthesis failed. Check if local TTS engines are available.');
      setFeedbackType('error');
    }
    void refreshStatus();
  };

  const handleCheckVoiceStudio = async () => {
    setCheckingStudio(true);
    setFeedback('Contacting VoiceStudio server…');
    setFeedbackType('info');
    const result = await checkVoiceStudioConnection(
      settings.voiceStudioBaseUrl ?? DEFAULT_VOICESTUDIO_BASE_URL,
      settings.voiceStudioPin ?? '',
    );
    setCheckingStudio(false);
    setFeedback(result.message);
    setFeedbackType(result.ok ? 'success' : 'error');
  };

  const handleStopVoice = async () => {
    await stopSpeech();
    setTesting(false);
    setFeedback('Playback stopped.');
    setFeedbackType('info');
    void refreshStatus();
  };

  const mode = resolveTtsMode(settings);
  const isTtsDisabled = mode.kind === 'disabled';
  const isBeaActive = mode.kind === 'enabled' && mode.engine === 'cloned-bea';

  return (
    <section className="lan-panel" aria-label="Voice Announcements">
      <div className="lan-panel-head">
        <div>
          <p className="section-kicker">Audio &amp; Feedback</p>
          <h2>Voice Announcements</h2>
        </div>
        {status && (
          <span
            className={`lan-state ${
              isTtsDisabled
                ? 'lan-state-disabled'
                : isBeaActive || status.piperAvailable
                  ? 'lan-state-running'
                  : status.systemSapiAvailable
                    ? 'lan-state-starting'
                    : 'lan-state-disabled'
            }`}
            title={
              isTtsDisabled
                ? 'Voice announcements disabled'
                : isBeaActive
                  ? "Ma'am Bea cloned voice active (pre-rendered phrases + neural fallback)"
                  : status.piperAvailable
                    ? `Piper neural TTS active (${status.piperPath ?? 'bundled'})`
                    : status.systemSapiAvailable
                      ? 'Windows SAPI system voice active'
                      : 'No offline TTS engine detected'
            }
          >
            <i />
            {isTtsDisabled
              ? 'Voice Disabled'
              : isBeaActive
                ? "Ma'am Bea Ready"
                : status.piperAvailable
                  ? 'Piper TTS Ready'
                  : status.systemSapiAvailable
                    ? 'SAPI Ready'
                    : 'Offline TTS Unavailable'}
          </span>
        )}
      </div>

      <div className="lan-facts db-facts">
        <span>
          Voice{' '}
          <strong>
            {isTtsDisabled
              ? 'Disabled'
              : "Ma'am Bea (Hybrid Cloned Voice)"}
          </strong>
        </span>
        <span>
          Status{' '}
          <strong>
            {isTtsDisabled
              ? 'Disabled'
              : 'Ready (Local Offline)'}
          </strong>
        </span>
        <span>
          Speed / Volume{' '}
          <strong>
            {settings.rate.toFixed(1)}x / {Math.round(settings.volume * 100)}%
          </strong>
        </span>
      </div>

      {workerStatus && (
        <div className="lan-facts db-facts" aria-live="polite">
          <span>
            Cloning{' '}
            <strong>
              {workerStatus.active > 0 ? `Working (${workerStatus.active} queued)` : workerStatus.retry > 0 ? `Retrying (${workerStatus.retry})` : 'Idle'}
            </strong>
          </span>
          {workerStatus.lastSpokenText && (
            <span>
              Last clip{' '}
              <strong>{workerStatus.lastSpokenText}</strong>
            </span>
          )}
          {workerStatus.lastError && workerStatus.active === 0 && (
            <span>
              Worker note{' '}
              <strong>{workerStatus.lastError}</strong>
            </span>
          )}
          <span
            className={`lan-state ${
              workerStatus.active > 0 ? 'lan-state-starting' : workerStatus.retry > 0 ? 'lan-state-disabled' : 'lan-state-running'
            }`}
            title={workerStatus.active > 0 ? 'Pulling clips from VoiceStudio' : 'Worker idle'}
          >
            <i />
            {workerStatus.active > 0 ? 'Cloning…' : workerStatus.retry > 0 ? 'Retrying' : 'Up to date'}
          </span>
        </div>
      )}

      {feedback && (
        <p
          className={`dashboard-alert ${feedbackType === 'error' ? '' : 'db-notice'}`}
          role={feedbackType === 'error' ? 'alert' : 'status'}
        >
          {feedback}
        </p>
      )}

      <div className="voice-settings-grid">
        {/* Enable / Disable Toggle Card */}
        <div className="voice-control-card">
          <label className="voice-toggle-label" htmlFor="tts-enabled-toggle">
            <input
              type="checkbox"
              id="tts-enabled-toggle"
              checked={settings.enabled}
              onChange={(e) => updateSetting('enabled', e.target.checked)}
            />
            <span>Enable Voice Announcements</span>
          </label>
          <p className="form-help">
            When enabled, attendance scans greet employees on time-in and say goodbye on time-out.
          </p>
        </div>

        {/* Speech Rate Slider Card */}
        <div className={`voice-control-card ${isTtsDisabled ? 'is-disabled' : ''}`}>
          <div className="voice-control-header">
            <label htmlFor="tts-rate-slider" className="voice-control-label">
              Speech Rate
            </label>
            <span className="slider-badge">{settings.rate.toFixed(1)}x</span>
          </div>
          <input
            type="range"
            id="tts-rate-slider"
            min="0.5"
            max="2.0"
            step="0.1"
            value={settings.rate}
            disabled={isTtsDisabled}
            onChange={(e) => updateSetting('rate', parseFloat(e.target.value))}
          />
          <p className="form-help">Adjust the speed of spoken announcements (1.0x is default).</p>
        </div>

        {/* Volume Slider Card */}
        <div className={`voice-control-card ${isTtsDisabled ? 'is-disabled' : ''}`}>
          <div className="voice-control-header">
            <label htmlFor="tts-volume-slider" className="voice-control-label">
              Volume
            </label>
            <span className="slider-badge">{Math.round(settings.volume * 100)}%</span>
          </div>
          <input
            type="range"
            id="tts-volume-slider"
            min="0.0"
            max="1.0"
            step="0.05"
            value={settings.volume}
            disabled={isTtsDisabled}
            onChange={(e) => updateSetting('volume', parseFloat(e.target.value))}
          />
          <p className="form-help">Adjust audio playback volume for announcements.</p>
        </div>

        {/* VoiceStudio Server Card */}
        <div className="voice-control-card">
          <div className="voice-control-header">
            <label htmlFor="tts-voicestudio-url" className="voice-control-label">
              VoiceStudio Server
            </label>
            <button
              type="button"
              className="text-button"
              disabled={checkingStudio}
              onClick={() => void handleCheckVoiceStudio()}
            >
              {checkingStudio ? 'Checking…' : 'Test Connection'}
            </button>
          </div>
          <input
            type="url"
            id="tts-voicestudio-url"
            className="input"
            inputMode="url"
            placeholder="http://192.168.1.50:3900"
            value={settings.voiceStudioBaseUrl ?? DEFAULT_VOICESTUDIO_BASE_URL}
            onChange={(e) => {
              updateSetting('voiceStudioBaseUrl', e.target.value);
              persistHostToNative(e.target.value);
            }}
          />
          <p className="form-help">LAN address of the PC running VoiceStudio voice cloning (port 3900).</p>
          <label htmlFor="tts-voicestudio-pin" className="voice-control-label">
            Share PIN
          </label>
          <input
            type="password"
            id="tts-voicestudio-pin"
            className="input"
            inputMode="numeric"
            autoComplete="off"
            placeholder="6-digit PIN from the host's Network screen"
            value={settings.voiceStudioPin ?? ''}
            onChange={(e) => {
              updateSetting('voiceStudioPin', e.target.value);
              persistPinToNative(e.target.value);
            }}
          />
          <p className="form-help">Shown on the host PC while Network sharing is on. Leave empty for PIN-less hosts.</p>
        </div>
      </div>

      <div className="lan-actions">
        <button
          type="button"
          id="tts-test-button"
          className="admin-button file-action-primary"
          disabled={isTtsDisabled || testing}
          onClick={() => void handleTestVoice()}
        >
          {testing ? 'Speaking…' : 'Test Voice'}
        </button>

        <button
          type="button"
          id="tts-stop-button"
          className="admin-button"
          disabled={isTtsDisabled}
          onClick={() => void handleStopVoice()}
        >
          Stop
        </button>

        <button
          type="button"
          className="text-button"
          onClick={() => {
            setSettings(DEFAULT_TTS_SETTINGS);
            saveTtsSettings(DEFAULT_TTS_SETTINGS);
            onSettingsChange?.(DEFAULT_TTS_SETTINGS);
            setFeedback('Reset to default settings.');
            setFeedbackType('info');
          }}
        >
          Reset Defaults
        </button>
      </div>

      <div className="lan-guidance" style={{ marginTop: '18px' }}>
        <p>
          <strong>Zero-cloud, offline speech synthesis:</strong>
        </p>
        <p>
          Runs 100% locally with Ma&apos;am Bea cloned voice (multi-tone pre-rendered clips) and high-quality Piper neural voices (ONNX) with Windows SAPI fallback.
          Spoken greetings are triggered immediately on successful RFID card scans with zero internet latency.
        </p>
      </div>
    </section>
  );
}
