import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { VoiceboxNamesPage } from './voicebox-names-page';
import * as api from './api';
import type { VoiceboxNameListItem } from '@rfid-attendance/shared';

const mockNames: VoiceboxNameListItem[] = [
  {
    employeeId: 'EMP-001',
    fullName: 'Beatrice Alonzo',
    firstName: 'Beatrice',
    lastName: 'Alonzo',
    displayName: 'Bea',
    hasPronunciation: true,
    phoneticSimple: 'BEE-ah',
    phoneticIpa: 'ˈbiː.ə',
    languageTag: 'en-PH',
    notes: 'Cloned voice reference',
  },
  {
    employeeId: 'EMP-002',
    fullName: 'Carlos Mendoza',
    firstName: 'Carlos',
    lastName: 'Mendoza',
    displayName: 'Carlos',
    hasPronunciation: false,
    phoneticSimple: null,
    phoneticIpa: null,
    languageTag: null,
    notes: null,
  },
  {
    employeeId: 'EMP-003',
    fullName: 'Maria Santos',
    firstName: 'Maria',
    lastName: 'Santos',
    displayName: 'Maria',
    hasPronunciation: false,
    phoneticSimple: null,
    phoneticIpa: null,
    languageTag: null,
    notes: null,
  },
];

describe('VoiceboxNamesPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'loadVoiceboxNames').mockResolvedValue({
      success: true,
      names: mockNames,
    });
  });

  it('loads and renders the list of names with status badges', async () => {
    await act(async () => {
      render(<VoiceboxNamesPage />);
    });

    expect(screen.getByRole('heading', { name: /Voicebox Name Pronunciations/i })).toBeInTheDocument();
    expect(screen.getByText('Beatrice Alonzo')).toBeInTheDocument();
    expect(screen.getByText('Carlos Mendoza')).toBeInTheDocument();
    expect(screen.getByText('Maria Santos')).toBeInTheDocument();

    // Badges
    expect(screen.getByText('Configured')).toBeInTheDocument();
    const missingBadges = screen.getAllByText('Missing');
    expect(missingBadges.length).toBe(2);

    // Phonetics
    expect(screen.getByText('BEE-ah')).toBeInTheDocument();
    expect(screen.getByText('/ˈbiː.ə/')).toBeInTheDocument();
  });

  it('filters names via search input', async () => {
    await act(async () => {
      render(<VoiceboxNamesPage />);
    });

    const searchInput = screen.getByPlaceholderText(/Search by full name/i);
    fireEvent.change(searchInput, { target: { value: 'Carlos' } });

    expect(screen.getByText('Carlos Mendoza')).toBeInTheDocument();
    expect(screen.queryByText('Beatrice Alonzo')).not.toBeInTheDocument();
    expect(screen.queryByText('Maria Santos')).not.toBeInTheDocument();
  });

  it('filters names via segmented status tabs', async () => {
    await act(async () => {
      render(<VoiceboxNamesPage />);
    });

    // Click "Configured" tab
    const configuredTab = screen.getByRole('tab', { name: /Configured \(1\)/i });
    fireEvent.click(configuredTab);

    expect(screen.getByText('Beatrice Alonzo')).toBeInTheDocument();
    expect(screen.queryByText('Carlos Mendoza')).not.toBeInTheDocument();
    expect(screen.queryByText('Maria Santos')).not.toBeInTheDocument();

    // Click "Missing" tab
    const missingTab = screen.getByRole('tab', { name: /Missing \(2\)/i });
    fireEvent.click(missingTab);

    expect(screen.queryByText('Beatrice Alonzo')).not.toBeInTheDocument();
    expect(screen.getByText('Carlos Mendoza')).toBeInTheDocument();
    expect(screen.getByText('Maria Santos')).toBeInTheDocument();

    // Click "All" tab
    const allTab = screen.getByRole('tab', { name: /All \(3\)/i });
    fireEvent.click(allTab);

    expect(screen.getByText('Beatrice Alonzo')).toBeInTheDocument();
    expect(screen.getByText('Carlos Mendoza')).toBeInTheDocument();
    expect(screen.getByText('Maria Santos')).toBeInTheDocument();
  });

  it('opens VoiceNameEditor dialog when clicking Edit and updates list on save', async () => {
    const saveSpy = vi.spyOn(api, 'saveVoiceboxPronunciation').mockResolvedValue({
      success: true,
      record: {
        employeeId: 'EMP-002',
        displayName: 'Caloy',
        phoneticSimple: 'KAH-loy',
        phoneticIpa: 'ˈka.loɪ',
        languageTag: 'en-PH',
        notes: 'Nickname',
      },
    });

    await act(async () => {
      render(<VoiceboxNamesPage />);
    });

    // Find the Edit button for Carlos Mendoza (second row)
    const editButtons = screen.getAllByRole('button', { name: 'Edit' });
    fireEvent.click(editButtons[1]);

    // Modal dialog opens
    expect(screen.getByRole('heading', { name: /Edit Pronunciation: Carlos Mendoza/i })).toBeInTheDocument();

    // Edit simple phonetic and display name
    fireEvent.change(screen.getByLabelText(/Spoken Display Name/i), {
      target: { value: 'Caloy' },
    });
    fireEvent.change(screen.getByLabelText(/Simple Phonetic Guide/i), {
      target: { value: 'KAH-loy' },
    });

    // Click Save Pronunciation
    const saveButton = screen.getByRole('button', { name: /Save Pronunciation/i });
    await act(async () => {
      fireEvent.click(saveButton);
    });

    expect(saveSpy).toHaveBeenCalledWith('EMP-002', {
      displayName: 'Caloy',
      phoneticSimple: 'KAH-loy',
      phoneticIpa: '',
      languageTag: 'en-PH',
      notes: '',
    });

    // Modal closes and success toast appears
    expect(screen.queryByRole('heading', { name: /Edit Pronunciation: Carlos Mendoza/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Saved pronunciation for Caloy/i)).toBeInTheDocument();

    // Carlos row is now updated to Configured and has new display name and phonetic
    expect(screen.getByText('Caloy')).toBeInTheDocument();
    expect(screen.getByText('KAH-loy')).toBeInTheDocument();
  });

  it('calls onBack prop when clicking Back button', async () => {
    const onBackMock = vi.fn();
    await act(async () => {
      render(<VoiceboxNamesPage onBack={onBackMock} />);
    });

    const backButton = screen.getByRole('button', { name: /Back to Admin/i });
    fireEvent.click(backButton);

    expect(onBackMock).toHaveBeenCalledTimes(1);
  });
});
