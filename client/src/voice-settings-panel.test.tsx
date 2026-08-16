import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { VoiceSettingsPanel } from './voice-settings-panel';
import * as ttsService from './services/ttsService';

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
    expect(screen.getByLabelText(/TTS Engine/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Piper Voice Model/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Speech Rate/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Volume/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test Voice' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });

  it('triggers test voice on click', async () => {
    const testSpy = vi.spyOn(ttsService, 'testVoice').mockResolvedValue({
      success: true,
      engineUsed: 'piper',
    });

    await act(async () => {
      render(<VoiceSettingsPanel />);
    });
    const testButton = screen.getByRole('button', { name: 'Test Voice' });

    await act(async () => {
      fireEvent.click(testButton);
    });

    expect(testSpy).toHaveBeenCalled();
    expect(await screen.findByText(/Voice played successfully via Piper/i)).toBeInTheDocument();
  });

  it('disables controls when voice announcements are unchecked', async () => {
    await act(async () => {
      render(<VoiceSettingsPanel />);
    });
    const toggle = screen.getByLabelText(/Enable Voice Announcements/i);

    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(screen.getByLabelText(/TTS Engine/i)).toBeDisabled();
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
  });
});
