import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { VoiceSettingsPanel } from './voice-settings-panel';
import * as ttsService from './services/ttsService';
import * as tauriApiModule from './tauri-api';

describe('VoiceSettingsPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    vi.spyOn(ttsService, 'getTtsStatus').mockResolvedValue({
      enabled: true,
      engine: 'auto',
      piperAvailable: true,
      piperPath: 'C:/piper/piper.exe',
      voiceModelAvailable: true,
      voiceModelPath: 'C:/piper/models/voice.onnx',
      systemSapiAvailable: true,
      isSpeaking: false,
    });
  });

  it('renders all voice settings controls', async () => {
    await act(async () => {
      render(<VoiceSettingsPanel />);
    });
    expect(screen.getByRole('heading', { name: 'Voice Announcements' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Enable Voice Announcements/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Speech Rate/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Volume/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test Voice' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.getByLabelText(/VoiceStudio Server/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test Connection' })).toBeInTheDocument();
  });

  it('triggers test voice on click and displays feedback', async () => {
    const testSpy = vi.spyOn(ttsService, 'testVoice').mockResolvedValue({
      success: true,
      engineUsed: 'cloned-bea',
    });

    await act(async () => {
      render(<VoiceSettingsPanel />);
    });
    const testButton = screen.getByRole('button', { name: 'Test Voice' });

    await act(async () => {
      fireEvent.click(testButton);
    });

    expect(testSpy).toHaveBeenCalled();
    expect(
      await screen.findByText(/Voice played successfully via Ma'am Bea \(Cloned voice\)/i),
    ).toBeInTheDocument();
  });

  it('updates the VoiceStudio host address', async () => {
    const onChange = vi.fn();
    await act(async () => {
      render(<VoiceSettingsPanel onSettingsChange={onChange} />);
    });

    const hostInput = screen.getByLabelText(/VoiceStudio Server/i);
    await act(async () => {
      fireEvent.change(hostInput, { target: { value: 'http://192.168.1.50:3900' } });
    });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        voiceStudioBaseUrl: 'http://192.168.1.50:3900',
      }),
    );
  });

  it('shows live cloning activity from the worker', async () => {
    vi.spyOn(tauriApiModule.tauriApi, 'voiceWorkerStatus').mockResolvedValue({
      active: 2,
      retry: 0,
      lastPersonId: 'APG-1',
      lastSpokenText: 'Ada Lovelace',
      lastCompletedAt: '2026-09-12T00:00:00Z',
      lastError: null,
    });
    vi.spyOn(tauriApiModule.tauriApi, 'getVoicestudioHost').mockRejectedValue(new Error('no native'));
    vi.spyOn(tauriApiModule.tauriApi, 'getVoicestudioPin').mockRejectedValue(new Error('no native'));
    await act(async () => {
      render(<VoiceSettingsPanel />);
    });
    expect(await screen.findByText('Cloning…')).toBeInTheDocument();
    expect(screen.getByText(/Working \(2 queued\)/)).toBeInTheDocument();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('updates the VoiceStudio share PIN', async () => {
    const onChange = vi.fn();
    await act(async () => {
      render(<VoiceSettingsPanel onSettingsChange={onChange} />);
    });

    const pinInput = screen.getByLabelText(/Share PIN/i);
    await act(async () => {
      fireEvent.change(pinInput, { target: { value: '166387' } });
    });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        voiceStudioPin: '166387',
      }),
    );
  });

  it('disables controls when voice announcements are unchecked', async () => {
    await act(async () => {
      render(<VoiceSettingsPanel />);
    });
    const toggle = screen.getByLabelText(/Enable Voice Announcements/i);

    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(screen.getByLabelText(/Speech Rate/i)).toBeDisabled();
    expect(screen.getByLabelText(/Volume/i)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Test Voice' })).toBeDisabled();
  });

  it('updates speech rate and volume sliders', async () => {
    const onChange = vi.fn();
    await act(async () => {
      render(<VoiceSettingsPanel onSettingsChange={onChange} />);
    });

    const rateSlider = screen.getByLabelText(/Speech Rate/i);
    await act(async () => {
      fireEvent.change(rateSlider, { target: { value: '1.4' } });
    });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        rate: 1.4,
      }),
    );

    const volumeSlider = screen.getByLabelText(/Volume/i);
    await act(async () => {
      fireEvent.change(volumeSlider, { target: { value: '0.8' } });
    });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        volume: 0.8,
      }),
    );
  });
});
