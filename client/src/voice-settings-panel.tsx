import React, { useState, useEffect, useCallback } from 'react';
import type { TtsSettings, TtsStatusResponse } from '@rfid-attendance/shared';
import {
  AVAILABLE_VOICE_MODELS,
  DEFAULT_TTS_SETTINGS,
  getTtsStatus,
  isTtsEngine,
  loadTtsSettings,
  saveTtsSettings,
  stopSpeech,
  testVoice,
} from './services/ttsService';

export interface VoiceSettingsPanelProps {
  onSettingsChange?: (settings: TtsSettings) => void;
}

export function VoiceSettingsPanel({ onSettingsChange }: VoiceSettingsPanelProps) {
  const [settings, setSettings] = useState<TtsSettings>(DEFAULT_TTS_SETTINGS);
  const [status, setStatus] = useState<TtsStatusResponse | null>(null);
  const [testing, setTesting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [feedbackType, setFeedbackType] = useState<'info' | 'error' | 'success'>('info');

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
  }, [refreshStatus]);

  const updateSetting = <K extends keyof TtsSettings>(key: K, value: TtsSettings[K]) => {
    setSettings((prev) => {
      const updated = { ...prev, [key]: value };
      saveTtsSettings(updated);
      onSettingsChange?.(updated);
      return updated;
    });
  };

  const handleTestVoice = async () => {
    setTesting(true);
    setFeedback('Playing sample voice announcement…');
    setFeedbackType('info');

    const result = await testVoice(settings);
    setTesting(false);

    if (result && result.success) {
      const engineLabel =
        result.engineUsed === 'piper'
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

  const handleStopVoice = async () => {
    await stopSpeech();
    setTesting(false);
    setFeedback('Playback stopped.');
    setFeedbackType('info');
    void refreshStatus();
  };

  const isTtsDisabled = !settings.enabled || settings.engine === 'disabled';
  const isPiperSelected = settings.engine === 'auto' || settings.engine === 'piper';

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
              status.piperAvailable
                ? 'lan-state-running'
                : status.systemSapiAvailable
                  ? 'lan-state-starting'
                  : 'lan-state-disabled'
            }`}
            title={
              status.piperAvailable
                ? `Piper neural TTS active (${status.piperPath ?? 'bundled'})`
                : status.systemSapiAvailable
                  ? 'Windows SAPI system voice active'
                  : 'No offline TTS engine detected'
            }
          >
            <i />
            {status.piperAvailable
              ? 'Piper TTS Ready'
              : status.systemSapiAvailable
                ? 'SAPI Ready'
                : 'Offline TTS Unavailable'}
          </span>
        )}
      </div>

      <div className="lan-facts db-facts">
        <span>
          TTS Engine{' '}
          <strong>
            {!settings.enabled
              ? 'Disabled'
              : settings.engine === 'auto'
                ? 'Auto (Neural / SAPI)'
                : settings.engine === 'piper'
                  ? 'Piper (Neural)'
                  : 'Windows SAPI'}
          </strong>
        </span>
        <span>
          Engine Status{' '}
          <strong>
            {status?.piperAvailable
              ? 'Piper Active (Local)'
              : status?.systemSapiAvailable
                ? 'Windows SAPI Fallback'
                : 'Unavailable'}
          </strong>
        </span>
        <span>
          Voice Model{' '}
          <strong>
            {AVAILABLE_VOICE_MODELS.find((m) => m.id === settings.voiceModel)?.label.split(' ')[0] ?? 'Amy'}
          </strong>
        </span>
        <span>
          Speed / Volume{' '}
          <strong>
            {settings.rate.toFixed(1)}x / {Math.round(settings.volume * 100)}%
          </strong>
        </span>
      </div>

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

        {/* TTS Engine Selector Card */}
        <div className={`voice-control-card ${!settings.enabled ? 'is-disabled' : ''}`}>
          <div className="voice-control-header">
            <label htmlFor="tts-engine-select" className="voice-control-label">
              TTS Engine
            </label>
          </div>
          <select
            id="tts-engine-select"
            className="voice-select"
            value={settings.engine}
            disabled={!settings.enabled}
            onChange={(e) => {
              const val = e.target.value;
              if (isTtsEngine(val)) {
                updateSetting('engine', val);
              }
            }}
          >
            <option value="auto">Auto (Piper, then system fallback)</option>
            <option value="piper">Piper (Bundled Neural Voice)</option>
            <option value="system">System Voice (Windows SAPI)</option>
            <option value="disabled">Disabled</option>
          </select>
          <p className="form-help">
            Auto tries high-quality Piper first, falling back smoothly to Windows SAPI if unavailable.
          </p>
        </div>

        {/* Piper Voice Model Selector Card */}
        <div className={`voice-control-card ${isTtsDisabled || !isPiperSelected ? 'is-disabled' : ''}`}>
          <div className="voice-control-header">
            <label htmlFor="tts-model-select" className="voice-control-label">
              Piper Voice Model
            </label>
          </div>
          <select
            id="tts-model-select"
            className="voice-select"
            value={settings.voiceModel}
            disabled={isTtsDisabled || !isPiperSelected}
            onChange={(e) => updateSetting('voiceModel', e.target.value)}
          >
            {AVAILABLE_VOICE_MODELS.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
          <p className="form-help">
            Lightweight neural models designed for responsive, natural office voice playback.
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
          Runs 100% locally with high-quality Piper neural voices (ONNX) and Windows SAPI fallback.
          Spoken greetings are triggered immediately on successful RFID card scans with zero internet latency.
        </p>
      </div>
    </section>
  );
}
