import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { VoiceNameEditor } from './voice-name-editor';

describe('VoiceNameEditor', () => {
  const defaultProps = {
    employeeId: 'EMP-001',
    initialDisplayName: 'Bea',
    fullName: 'Beatrice Alonzo',
    onSave: vi.fn().mockResolvedValue(undefined),
    onCancel: vi.fn(),
  };

  it('renders with initial values and live preview elements', () => {
    render(<VoiceNameEditor {...defaultProps} />);

    expect(screen.getByRole('heading', { name: /Edit Pronunciation: Beatrice Alonzo/i })).toBeInTheDocument();
    expect(screen.getByText(/Employee ID:/i)).toBeInTheDocument();
    expect(screen.getByText('EMP-001')).toBeInTheDocument();

    // Check inputs
    expect(screen.getByLabelText(/Spoken Display Name/i)).toHaveValue('Bea');
    expect(screen.getByLabelText(/Simple Phonetic Guide/i)).toHaveValue('');
    expect(screen.getByLabelText(/IPA Transcription/i)).toHaveValue('');
    expect(screen.getByLabelText(/Language \/ Accent Tag/i)).toHaveValue('en-PH');

    // Live preview contains Spoken Display Name
    expect(screen.getByText(/Live TTS Audio Preview/i)).toBeInTheDocument();
    expect(screen.getByText('Bea')).toBeInTheDocument();
  });

  it('populates existing pronunciation override data if provided', () => {
    render(
      <VoiceNameEditor
        {...defaultProps}
        existingPronunciation={{
          displayName: 'Bea Alonzo',
          phoneticSimple: 'BEE-ah',
          phoneticIpa: 'ˈbiː.ə',
          languageTag: 'fil-PH',
          notes: 'Stress first syllable',
        }}
      />,
    );

    expect(screen.getByLabelText(/Spoken Display Name/i)).toHaveValue('Bea Alonzo');
    expect(screen.getByLabelText(/Simple Phonetic Guide/i)).toHaveValue('BEE-ah');
    expect(screen.getByLabelText(/IPA Transcription/i)).toHaveValue('ˈbiː.ə');
    expect(screen.getByLabelText(/Language \/ Accent Tag/i)).toHaveValue('fil-PH');
    expect(screen.getByLabelText(/Pronunciation Notes/i)).toHaveValue('Stress first syllable');

    // Check preview breakdown pills
    expect(screen.getByText('BEE')).toBeInTheDocument();
    expect(screen.getByText('ah')).toBeInTheDocument();
  });

  it('updates form fields on typing and updates live preview pills', () => {
    render(<VoiceNameEditor {...defaultProps} />);

    const nameInput = screen.getByLabelText(/Spoken Display Name/i);
    fireEvent.change(nameInput, { target: { value: 'Carlos' } });
    expect(nameInput).toHaveValue('Carlos');

    const simpleInput = screen.getByLabelText(/Simple Phonetic Guide/i);
    fireEvent.change(simpleInput, { target: { value: 'kar-LOHS' } });
    expect(simpleInput).toHaveValue('kar-LOHS');

    // Syllables breakdown pills rendered in live preview
    expect(screen.getByText('kar')).toBeInTheDocument();
    expect(screen.getByText('LOHS')).toBeInTheDocument();
  });

  it('inserts IPA character when clicking an on-screen IPA keyboard button', () => {
    render(<VoiceNameEditor {...defaultProps} />);

    // SAFETY: Casting to HTMLInputElement to test value property
    const ipaInput = screen.getByLabelText(/IPA Transcription/i) as HTMLInputElement;
    fireEvent.focus(ipaInput);

    // Click vowel 'ə'
    const schwaBtn = screen.getByRole('button', { name: 'IPA vowel ə' });
    fireEvent.mouseDown(schwaBtn);
    fireEvent.click(schwaBtn);

    expect(ipaInput.value).toBe('ə');

    // Click stress marker 'ˈ'
    const stressBtn = screen.getByRole('button', { name: 'IPA marker ˈ' });
    fireEvent.mouseDown(stressBtn);
    fireEvent.click(stressBtn);

    expect(ipaInput.value).toBe('əˈ');
  });

  it('submits valid data to onSave callback', async () => {
    const onSaveMock = vi.fn().mockResolvedValue(undefined);
    render(<VoiceNameEditor {...defaultProps} onSave={onSaveMock} />);

    fireEvent.change(screen.getByLabelText(/Spoken Display Name/i), {
      target: { value: ' Carlos ' },
    });
    fireEvent.change(screen.getByLabelText(/Simple Phonetic Guide/i), {
      target: { value: ' kar-LOHS ' },
    });
    fireEvent.change(screen.getByLabelText(/IPA Transcription/i), {
      target: { value: ' kɑːrˈloʊs ' },
    });
    fireEvent.change(screen.getByLabelText(/Pronunciation Notes/i), {
      target: { value: ' Spanish origin ' },
    });

    const submitBtn = screen.getByRole('button', { name: /Save Pronunciation/i });
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    expect(onSaveMock).toHaveBeenCalledWith({
      displayName: 'Carlos',
      phoneticSimple: 'kar-LOHS',
      phoneticIpa: 'kɑːrˈloʊs',
      languageTag: 'en-PH',
      notes: 'Spanish origin',
    });
  });

  it('triggers onCancel when Cancel button is clicked', () => {
    const onCancelMock = vi.fn();
    render(<VoiceNameEditor {...defaultProps} onCancel={onCancelMock} />);

    const cancelBtn = screen.getByRole('button', { name: 'Cancel' });
    fireEvent.click(cancelBtn);

    expect(onCancelMock).toHaveBeenCalledTimes(1);
  });
});
