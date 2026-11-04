import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Update } from '@tauri-apps/plugin-updater';
import { UpdateBanner, updaterReleaseInstant } from './update-banner';
import { AdminUpdatesCard } from './admin-updates-card';
import * as updateService from './services/updateService';
import * as api from './api';

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
        state: 'up-to-date',
      });

      render(<UpdateBanner />);

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByText(/Update available/i)).not.toBeInTheDocument();
    });

    it('renders banner when update is available and opens modal on click', async () => {
      const mockUpdate = createMockUpdate('0.1.15', '0.1.14', 'Added new payroll export format.');

      vi.spyOn(updateService, 'checkForUpdates').mockResolvedValue({
        state: 'available',
        update: mockUpdate,
        info: {
          version: mockUpdate.version,
          currentVersion: mockUpdate.currentVersion,
          body: mockUpdate.body,
        },
      });

      render(<UpdateBanner manualCheckTrigger={1} />);

      expect(await screen.findByText(/Update Alpha Premier Attendance/i)).toBeInTheDocument();
      expect(screen.getByText('v0.1.15')).toBeInTheDocument();
      expect(screen.getByText('v0.1.14')).toBeInTheDocument();
      expect(screen.getByText(/Added new payroll export format/i)).toBeInTheDocument();
    });

    it('shows the release day on Manila time, and nothing when the date cannot be read', async () => {
      const mockUpdate = createMockUpdate('0.1.15', '0.1.14', 'Fixes.');
      const check = vi.spyOn(updateService, 'checkForUpdates').mockResolvedValue({
        state: 'available',
        update: mockUpdate,
        // 23:30 UTC on Oct 30 is already Oct 31 in Manila.
        info: { version: '0.1.15', currentVersion: '0.1.14', date: '2026-10-30 23:30:00.0 +00:00:00' },
      });
      const { unmount } = render(<UpdateBanner manualCheckTrigger={1} />);
      expect(await screen.findByText('Released Oct 31, 2026')).toBeInTheDocument();
      unmount();

      check.mockResolvedValue({
        state: 'available',
        update: mockUpdate,
        info: { version: '0.1.15', currentVersion: '0.1.14', date: 'sometime soon' },
      });
      render(<UpdateBanner manualCheckTrigger={1} />);
      expect(await screen.findByText(/Update Alpha Premier Attendance/i)).toBeInTheDocument();
      expect(screen.queryByText(/^Released/)).not.toBeInTheDocument();
    });

    it('reads the updater release time as an instant', () => {
      expect(updaterReleaseInstant('2026-10-30 23:30:00.0 +00:00:00')).toBe('2026-10-30T23:30:00+00:00');
      expect(updaterReleaseInstant('2026-10-30 5:26:07.123 +08:00:00')).toBe('2026-10-30T05:26:07+08:00');
      expect(updaterReleaseInstant('2026-10-30T05:26:00Z')).toBe('2026-10-30T05:26:00Z');
      expect(updaterReleaseInstant('2026-08-26')).toBe('2026-08-26');
      expect(updaterReleaseInstant('soon')).toBeNull();
      expect(updaterReleaseInstant(undefined)).toBeNull();
    });

    it('triggers download and install on button click', async () => {
      const mockUpdate = createMockUpdate('0.1.15', '0.1.14', 'Security updates');

      vi.spyOn(updateService, 'checkForUpdates').mockResolvedValue({
        state: 'available',
        update: mockUpdate,
        info: {
          version: mockUpdate.version,
          currentVersion: mockUpdate.currentVersion,
          body: mockUpdate.body,
        },
      });

      const installSpy = vi.spyOn(updateService, 'downloadAndInstallUpdate').mockImplementation(async (_u, onProgress) => {
        onProgress?.({
          downloadedBytes: 500,
          totalBytes: 1000,
          percentage: 50,
          phase: 'downloading',
        });
        return { ok: true };
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
        state: 'up-to-date',
      });

      render(<UpdateBanner manualCheckTrigger={1} />);

      expect(await screen.findByText(/Alpha Premier Attendance is up to date/i)).toBeInTheDocument();
    });

    it('displays error toast with error icon on manual check when check returns error', async () => {
      vi.spyOn(updateService, 'checkForUpdates').mockResolvedValue({
        state: 'error',
        message: 'Unable to connect to update server.',
      });

      render(<UpdateBanner manualCheckTrigger={1} />);

      const errorToast = await screen.findByText(/Unable to connect to update server/i);
      expect(errorToast).toBeInTheDocument();
      expect(errorToast.closest('.update-toast')).toHaveClass('error');
    });

    it('does not re-trigger update check in a loop when checking returns up to date', async () => {
      const checkSpy = vi.spyOn(updateService, 'checkForUpdates').mockResolvedValue({
        state: 'up-to-date',
      });

      const { rerender } = render(<UpdateBanner manualCheckTrigger={1} />);

      expect(await screen.findByText(/Alpha Premier Attendance is up to date/i)).toBeInTheDocument();
      expect(checkSpy).toHaveBeenCalledTimes(1);

      // Re-rendering with identical trigger should not re-fire
      rerender(<UpdateBanner manualCheckTrigger={1} />);
      expect(checkSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('AdminUpdatesCard', () => {
    afterEach(() => {
      // SAFETY: Cleaning up the desktop-layer mock from window
      delete (window as Window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
    });

    it('shows plain rows with no developer words, and Check for updates now triggers a manual check', async () => {
      const manualCheckMock = vi.fn();
      render(<AdminUpdatesCard onManualCheck={manualCheckMock} />);

      // In a web browser there is no installed version to show.
      expect(screen.getByText('Version: desktop app only')).toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: 'Check for updates automatically' })).toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: 'Open the attendance screen when you log in' })).toBeInTheDocument();
      expect(screen.queryByText(/github|Deign86|release channel|kiosk terminal|Software updates/i)).not.toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Check for updates now/i }));
      });
      expect(manualCheckMock).toHaveBeenCalled();
    });

    it('shows the installed version beside Check for updates now in the desktop app', async () => {
      const invoke = vi.fn(async (command: string) => (command === 'plugin:app|version' ? '0.2.25' : null));
      // SAFETY: Minimal desktop-layer mock for the version request in jsdom
      (window as Window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = { invoke };
      vi.spyOn(api, 'getAutostartStatus').mockResolvedValue(false);
      render(<AdminUpdatesCard onManualCheck={vi.fn()} />);

      const version = await screen.findByText('Version 0.2.25');
      expect(version.nextElementSibling).toHaveTextContent('Check for updates now');
    });

    it('toggles automatic update checks and stores the choice', async () => {
      render(<AdminUpdatesCard onManualCheck={vi.fn()} />);

      const checkbox = screen.getByRole('checkbox', { name: 'Check for updates automatically' });
      expect(checkbox).toBeChecked();
      await act(async () => {
        fireEvent.click(checkbox);
      });

      expect(checkbox).not.toBeChecked();
      expect(updateService.isAutoUpdateDisabledLocally()).toBe(true);
      expect(screen.getByText('Off. Check for updates now still works.')).toBeInTheDocument();
    });

    it('turns Windows startup off in a web browser instead of letting it untick itself', () => {
      const setSpy = vi.spyOn(api, 'setAutostartStatus');
      render(<AdminUpdatesCard onManualCheck={vi.fn()} />);

      const startup = screen.getByRole('checkbox', { name: 'Open the attendance screen when you log in' });
      expect(startup).toBeDisabled();
      expect(screen.getByText('Only in the desktop app.')).toBeInTheDocument();
      expect(setSpy).not.toHaveBeenCalled();
    });

    it('reads the startup setting back and says so when turning it on did not take', async () => {
      // SAFETY: Minimal desktop-layer mock so the startup box is on
      (window as Window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = { invoke: vi.fn(async () => null) };
      // Opening: off. First try: still off afterwards. Second try: on.
      const getSpy = vi.spyOn(api, 'getAutostartStatus').mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      const setSpy = vi.spyOn(api, 'setAutostartStatus').mockResolvedValue(true);
      render(<AdminUpdatesCard onManualCheck={vi.fn()} />);

      const startup = screen.getByRole('checkbox', { name: 'Open the attendance screen when you log in' });
      expect(startup).toBeEnabled();
      await act(async () => {
        fireEvent.click(startup);
      });
      expect(setSpy).toHaveBeenCalledWith(true);
      expect(getSpy).toHaveBeenCalledTimes(2);
      expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't change the startup setting.");
      expect(startup).not.toBeChecked();

      // A later change that works clears the message.
      await act(async () => {
        fireEvent.click(startup);
      });
      expect(startup).toBeChecked();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('says so when turning startup off did not take, and keeps the box ticked', async () => {
      // SAFETY: Minimal desktop-layer mock so the startup box is on
      (window as Window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = { invoke: vi.fn(async () => null) };
      // Opening: on. After the try: still on (setAutostartStatus reports the request, Windows kept it).
      vi.spyOn(api, 'getAutostartStatus').mockResolvedValue(true);
      const setSpy = vi.spyOn(api, 'setAutostartStatus').mockResolvedValue(false);
      render(<AdminUpdatesCard onManualCheck={vi.fn()} />);

      const startup = screen.getByRole('checkbox', { name: 'Open the attendance screen when you log in' });
      await waitFor(() => expect(startup).toBeChecked());
      await act(async () => {
        fireEvent.click(startup);
      });
      expect(setSpy).toHaveBeenCalledWith(false);
      expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't change the startup setting.");
      expect(startup).toBeChecked();
    });
  });
});
