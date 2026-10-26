import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Info, PlugZap } from 'lucide-react';
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
    // adopt native host/PIN when present; only push up if native is unconfigured.
    try {
      void tauriApi
        .getVoicestudioHost()
        .then((host) => {
          const trimmed = host.trim();
          setSettings((prev) => {
            const local = prev.voiceStudioBaseUrl ?? DEFAULT_VOICESTUDIO_BASE_URL;
            if (trimmed.length > 0 && trimmed !== DEFAULT_VOICESTUDIO_BASE_URL) {
              if (prev.voiceStudioBaseUrl === trimmed) return prev;
              const next = { ...prev, voiceStudioBaseUrl: trimmed };
              saveTtsSettings(next);
              return next;
            }
            if (trimmed.length === 0 && local.length > 0 && local !== DEFAULT_VOICESTUDIO_BASE_URL) {
              persistHostToNative(local);
              return prev;
            }
            if (trimmed.length > 0) {
              return { ...prev, voiceStudioBaseUrl: trimmed };
            }
            return prev;
          });
        })
        .catch(() => undefined);
      void tauriApi
        .getVoicestudioPin()
        .then((pin) => {
          const trimmed = pin.trim();
          setSettings((prev) => {
            const local = prev.voiceStudioPin ?? '';
            if (trimmed.length > 0) {
              if (prev.voiceStudioPin === trimmed) return prev;
              const next = { ...prev, voiceStudioPin: trimmed };
              saveTtsSettings(next);
              return next;
            }
            if (trimmed.length === 0 && local.length > 0) {
              persistPinToNative(local);
              return prev;
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

    // null means Stop (or a newer announcement) cancelled the test; keep that message.
    if (result === null) return;

    if (result.success) {
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
      setFeedback(result.message ?? 'Speech synthesis failed. Check if local TTS engines are available.');
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
        {/* Audio Settings Card: on/off switch, speech rate + volume */}
        <div className="voice-control-card voice-settings-card">
          <h3 className="voice-card-title">Audio Settings</h3>
          <div className="voice-enable-row">
            <label className="voice-switch-label" htmlFor="tts-enabled-toggle">
              <input
                type="checkbox"
                role="switch"
                id="tts-enabled-toggle"
                className="voice-switch"
                checked={settings.enabled}
                onChange={(e) => updateSetting('enabled', e.target.checked)}
              />
              <span>Enable Voice Announcements</span>
            </label>
            <InfoTip id="tts-enabled-tip">
              When on, attendance scans greet employees on time-in and say goodbye on time-out.
            </InfoTip>
          </div>
          <div className={`voice-slider-row ${isTtsDisabled ? 'is-disabled' : ''}`}>
            <div className="voice-control-header">
              <span className="voice-label-with-tip">
                <label htmlFor="tts-rate-slider" className="voice-control-label">
                  Speech Rate
                </label>
                <InfoTip id="tts-rate-tip">How fast announcements are spoken. 1.0x is the default.</InfoTip>
              </span>
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
          </div>
          <div className={`voice-slider-row ${isTtsDisabled ? 'is-disabled' : ''}`}>
            <div className="voice-control-header">
              <span className="voice-label-with-tip">
                <label htmlFor="tts-volume-slider" className="voice-control-label">
                  Volume
                </label>
                <InfoTip id="tts-volume-tip">How loud announcements play.</InfoTip>
              </span>
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
          </div>
        </div>

        {/* VoiceStudio Server Card */}
        <div className="voice-control-card voice-settings-card">
          <div className="voice-control-header">
            <h3 className="voice-card-title">VoiceStudio Server</h3>
            <button
              type="button"
              className="admin-button voice-test-connection"
              disabled={checkingStudio}
              onClick={() => void handleCheckVoiceStudio()}
            >
              <PlugZap size={14} aria-hidden="true" />
              {checkingStudio ? 'Checking…' : 'Test Connection'}
            </button>
          </div>
          <div className="voice-field">
            <span className="voice-label-with-tip">
              <label htmlFor="tts-voicestudio-url" className="voice-control-label">
                Server address
              </label>
              <InfoTip id="tts-voicestudio-url-tip">
                Address of the PC running VoiceStudio. Use port 3901 when it is shared from another PC (Network sharing on), or 3900 when VoiceStudio runs on this PC.
              </InfoTip>
            </span>
            <input
              type="url"
              id="tts-voicestudio-url"
              className="input"
              inputMode="url"
              placeholder="http://192.168.1.50:3901"
              value={settings.voiceStudioBaseUrl ?? DEFAULT_VOICESTUDIO_BASE_URL}
              onChange={(e) => {
                updateSetting('voiceStudioBaseUrl', e.target.value);
                persistHostToNative(e.target.value);
              }}
            />
          </div>
          <div className="voice-field">
            <span className="voice-label-with-tip">
              <label htmlFor="tts-voicestudio-pin" className="voice-control-label">
                Share PIN
              </label>
              <InfoTip id="tts-voicestudio-pin-tip">
                Shown on the host PC&apos;s Network screen while sharing is on. Leave empty if the host has no PIN.
              </InfoTip>
            </span>
            <input
              type="password"
              id="tts-voicestudio-pin"
              className="input"
              inputMode="numeric"
              autoComplete="off"
              placeholder="6-digit PIN"
              value={settings.voiceStudioPin ?? ''}
              onChange={(e) => {
                updateSetting('voiceStudioPin', e.target.value);
                persistPinToNative(e.target.value);
              }}
            />
          </div>
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

// Small info icon whose help text shows on hover or keyboard focus.
function InfoTip({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <span className="info-tip">
      <button type="button" className="info-tip-button" aria-label="More info" aria-describedby={id}>
        <Info size={14} aria-hidden="true" />
      </button>
      <span className="info-tip-bubble" role="tooltip" id={id}>
        {children}
      </span>
    </span>
  );
}
