import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Update } from '@tauri-apps/plugin-updater';
import { UpdateBanner } from './update-banner';
import { AdminUpdatesCard } from './admin-updates-card';
import * as updateService from './services/updateService';

function createMockUpdate(
  version = '0.1.15',
  currentVersion = '0.1.14',
  body = 'Added new payroll export format.',
): Update {
  return new Update({
    rid: 1,
    currentVersion,
    version,
    date: '2026-08-26',
    body,
    rawJson: {},
  });
}

describe('UpdateBanner & AdminUpdatesCard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  describe('UpdateBanner', () => {
    it('does not display banner when no update is available', async () => {
      vi.spyOn(updateService, 'checkForUpdates').mockResolvedValue({
        available: false,
        update: null,
        info: null,
        error: null,
      });

      render(<UpdateBanner />);

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByText(/Update available/i)).not.toBeInTheDocument();
    });

    it('renders banner when update is available and opens modal on click', async () => {
      const mockUpdate = createMockUpdate('0.1.15', '0.1.14', 'Added new payroll export format.');

      vi.spyOn(updateService, 'checkForUpdates').mockResolvedValue({
        available: true,
        update: mockUpdate,
        info: {
          version: mockUpdate.version,
          currentVersion: mockUpdate.currentVersion,
          body: mockUpdate.body,
        },
        error: null,
      });

      render(<UpdateBanner manualCheckTrigger={1} />);

      expect(await screen.findByText(/Update Alpha Premier Attendance/i)).toBeInTheDocument();
      expect(screen.getByText('v0.1.15')).toBeInTheDocument();
      expect(screen.getByText('v0.1.14')).toBeInTheDocument();
      expect(screen.getByText(/Added new payroll export format/i)).toBeInTheDocument();
    });

    it('triggers download and install on button click', async () => {
      const mockUpdate = createMockUpdate('0.1.15', '0.1.14', 'Security updates');

      vi.spyOn(updateService, 'checkForUpdates').mockResolvedValue({
        available: true,
        update: mockUpdate,
        info: {
          version: mockUpdate.version,
          currentVersion: mockUpdate.currentVersion,
          body: mockUpdate.body,
        },
        error: null,
      });

      const installSpy = vi.spyOn(updateService, 'downloadAndInstallUpdate').mockImplementation(async (_u, onProgress) => {
        onProgress?.({
          downloadedBytes: 500,
          totalBytes: 1000,
          percentage: 50,
          phase: 'downloading',
        });
        return { success: true, error: null };
      });

      render(<UpdateBanner manualCheckTrigger={1} />);

      const installBtn = await screen.findByRole('button', { name: /Download & restart/i });
      await act(async () => {
        fireEvent.click(installBtn);
      });

      expect(installSpy).toHaveBeenCalled();
    });

    it('displays up-to-date toast on manual check when no update is available', async () => {
      vi.spyOn(updateService, 'checkForUpdates').mockResolvedValue({
        available: false,
        update: null,
        info: null,
        error: null,
      });

      render(<UpdateBanner manualCheckTrigger={1} />);

      expect(await screen.findByText(/Alpha Premier Attendance is up to date/i)).toBeInTheDocument();
    });

    it('displays error toast with error icon on manual check when check returns error', async () => {
      vi.spyOn(updateService, 'checkForUpdates').mockResolvedValue({
        available: false,
        update: null,
        info: null,
        error: 'Unable to connect to update server.',
      });

      render(<UpdateBanner manualCheckTrigger={1} />);

      const errorToast = await screen.findByText(/Unable to connect to update server/i);
      expect(errorToast).toBeInTheDocument();
      expect(errorToast.closest('.update-toast')).toHaveClass('error');
    });
  });

  describe('AdminUpdatesCard', () => {
    it('renders software updates card and triggers manual check', async () => {
      const manualCheckMock = vi.fn();
      render(<AdminUpdatesCard onManualCheck={manualCheckMock} />);

      expect(screen.getByText(/Software updates/i)).toBeInTheDocument();
      expect(screen.getByText(/Application version & release channel/i)).toBeInTheDocument();

      const checkButton = screen.getByRole('button', { name: /Check for updates now/i });
      await act(async () => {
        fireEvent.click(checkButton);
      });

      expect(manualCheckMock).toHaveBeenCalled();
    });

    it('toggles terminal auto-update setting and stores in localStorage', async () => {
      render(<AdminUpdatesCard onManualCheck={vi.fn()} />);

      const checkbox = screen.getByRole('checkbox', {
        name: /Automatically check for updates on this kiosk terminal/i,
      });
      expect(checkbox).toBeChecked();

      // Uncheck auto-update
      await act(async () => {
        fireEvent.click(checkbox);
      });

      expect(checkbox).not.toBeChecked();
      expect(updateService.isAutoUpdateDisabledLocally()).toBe(true);
      expect(
        screen.getByText(/Automatic background checks are disabled for this kiosk terminal/i),
      ).toBeInTheDocument();
    });
  });
});
