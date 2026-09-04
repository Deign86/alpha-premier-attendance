import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { TtsSettings, TtsStatusResponse } from '@rfid-attendance/shared';
import {
  DEFAULT_TTS_SETTINGS,
  getTtsStatus,
  loadTtsSettings,
  saveTtsSettings,
  stopSpeech,
  testVoice,
} from './services/ttsService';

export interface VoiceSettingsPanelProps {
  onSettingsChange?: (settings: TtsSettings) => void;
  onOpenVoiceboxNames?: () => void;
}

export function VoiceSettingsPanel({ onSettingsChange, onOpenVoiceboxNames }: VoiceSettingsPanelProps) {
  const [settings, setSettings] = useState<TtsSettings>(DEFAULT_TTS_SETTINGS);
  const [status, setStatus] = useState<TtsStatusResponse | null>(null);
  const [testing, setTesting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [feedbackType, setFeedbackType] = useState<'info' | 'error' | 'success'>('info');
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const handleStopVoice = async () => {
    await stopSpeech();
    setTesting(false);
    setFeedback('Playback stopped.');
    setFeedbackType('info');
    void refreshStatus();
  };

  const isTtsDisabled = !settings.enabled || settings.engine === 'disabled';

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
              settings.engine === 'cloned-bea' || status.piperAvailable
                ? 'lan-state-running'
                : status.systemSapiAvailable
                  ? 'lan-state-starting'
                  : 'lan-state-disabled'
            }`}
            title={
              settings.engine === 'cloned-bea'
                ? "Ma'am Bea cloned voice active (pre-rendered phrases + neural fallback)"
                : status.piperAvailable
                  ? `Piper neural TTS active (${status.piperPath ?? 'bundled'})`
                  : status.systemSapiAvailable
                    ? 'Windows SAPI system voice active'
                    : 'No offline TTS engine detected'
            }
          >
            <i />
            {settings.engine === 'cloned-bea'
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
            {!settings.enabled
              ? 'Disabled'
              : "Ma'am Bea (Hybrid Cloned Voice)"}
          </strong>
        </span>
        <span>
          Status{' '}
          <strong>
            {!settings.enabled
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

      {/* Voicebox Name Pronunciations Card */}
      <div
        className="kiosk-card voicebox-names-promo-card"
        style={{
          marginTop: '22px',
          padding: '18px 20px',
          borderRadius: '8px',
          background: 'var(--surface-input, rgba(255, 255, 255, 0.03))',
          border: '1px solid var(--gold-soft, rgba(198, 162, 84, 0.3))',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '14px' }}>
          <div>
            <p className="section-kicker" style={{ color: 'var(--gold, #c6a254)' }}>Phonetics &amp; Overrides</p>
            <h3 style={{ margin: '4px 0 0', fontFamily: 'Orbitron, sans-serif', fontSize: '1.05rem' }}>
              Voicebox Name Pronunciations
            </h3>
            <p className="form-help" style={{ margin: '4px 0 0' }}>
              Manage pronunciation overrides and phonetic dictionaries for TTS name playback from apgbackup.
            </p>
          </div>
          <button
            type="button"
            className="admin-button file-action-primary"
            onClick={() => {
              if (onOpenVoiceboxNames) {
                onOpenVoiceboxNames();
              } else if ('window' in globalThis) {
                window.location.hash = '#/voicebox-names';
              }
            }}
          >
            Open Pronunciation Manager
          </button>
        </div>
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
