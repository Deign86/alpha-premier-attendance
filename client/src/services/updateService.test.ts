import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Update } from '@tauri-apps/plugin-updater';
import {
  checkForUpdates,
  downloadAndInstallUpdate,
  isAutoUpdateDisabledLocally,
  setAutoUpdateDisabledLocally,
  TERMINAL_DISABLE_AUTO_UPDATE_KEY,
  type UpdaterClient,
} from './updateService';

interface TauriGlobalWindow {
  __TAURI_INTERNALS__?: {
    transformCallback?: (callback: () => void, once?: boolean) => number;
  };
}

function createMockUpdate(
  version = '0.1.15',
  currentVersion = '0.1.14',
  body?: string,
  onDownloadAndInstall?: (
    eventHandler: (event: {
      event: 'Started' | 'Progress' | 'Finished';
      data?: { contentLength?: number; chunkLength?: number };
    }) => void,
  ) => Promise<void>,
): Update {
  const update = new Update({
    rid: 1,
    currentVersion,
    version,
    date: '2026-08-26',
    body: body ?? 'Bug fixes and performance improvements.',
    rawJson: {},
  });

  if (onDownloadAndInstall) {
    update.downloadAndInstall = vi.fn().mockImplementation(onDownloadAndInstall);
  } else {
    update.downloadAndInstall = vi.fn().mockResolvedValue(undefined);
  }

  return update;
}

describe('updateService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    // SAFETY: Setting up mock Tauri window environment for desktop unit testing
    const win = window as TauriGlobalWindow;
    win.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
    };
  });

  describe('terminal auto-update opt-out configuration', () => {
    it('defaults to enabled (not disabled)', () => {
      expect(isAutoUpdateDisabledLocally()).toBe(false);
    });

    it('sets and clears terminal disable flag in localStorage', () => {
      setAutoUpdateDisabledLocally(true);
      expect(window.localStorage.getItem(TERMINAL_DISABLE_AUTO_UPDATE_KEY)).toBe('true');
      expect(isAutoUpdateDisabledLocally()).toBe(true);

      setAutoUpdateDisabledLocally(false);
      expect(window.localStorage.getItem(TERMINAL_DISABLE_AUTO_UPDATE_KEY)).toBeNull();
      expect(isAutoUpdateDisabledLocally()).toBe(false);
    });

    it('bypasses background update checks when terminal is pinned / disabled', async () => {
      setAutoUpdateDisabledLocally(true);
      const mockClient: UpdaterClient = {
        check: vi.fn().mockResolvedValue(null),
        relaunch: vi.fn().mockResolvedValue(undefined),
      };

      const result = await checkForUpdates(false, mockClient);
      expect(result.state).toBe('disabled');
      expect(mockClient.check).not.toHaveBeenCalled();
    });

    it('still allows manual update checks when terminal auto-update is disabled', async () => {
      setAutoUpdateDisabledLocally(true);
      const mockClient: UpdaterClient = {
        check: vi.fn().mockResolvedValue(null),
        relaunch: vi.fn().mockResolvedValue(undefined),
      };

      const result = await checkForUpdates(true, mockClient);
      expect(result.state).toBe('up-to-date');
      expect(mockClient.check).toHaveBeenCalled();
    });
  });

  describe('checkForUpdates', () => {
    it('returns available: false when app is up to date', async () => {
      const mockClient: UpdaterClient = {
        check: vi.fn().mockResolvedValue(null),
        relaunch: vi.fn().mockResolvedValue(undefined),
      };

      const result = await checkForUpdates(false, mockClient);
      expect(result.state).toBe('up-to-date');
    });

    it('returns available: true and info when an update is found', async () => {
      const mockUpdate = createMockUpdate(
        '0.1.15',
        '0.1.14',
        'Bug fixes and performance improvements.',
      );
      const mockClient: UpdaterClient = {
        check: vi.fn().mockResolvedValue(mockUpdate),
        relaunch: vi.fn().mockResolvedValue(undefined),
      };

      const result = await checkForUpdates(false, mockClient);
      expect(result.state).toBe('available');
      if (result.state !== 'available') throw new Error('expected an available update');
      expect(result.update).toBe(mockUpdate);
      expect(result.info.version).toBe('0.1.15');
      expect(result.info.currentVersion).toBe('0.1.14');
      expect(result.info.body).toBe('Bug fixes and performance improvements.');
    });

    it('fails silently on network failure during background check', async () => {
      const mockClient: UpdaterClient = {
        check: vi.fn().mockRejectedValue(new Error('Network error: 404 not found')),
        relaunch: vi.fn().mockResolvedValue(undefined),
      };

      const result = await checkForUpdates(false, mockClient);
      expect(result.state).toBe('disabled');
    });

    it('treats missing release JSON or 404 on remote as up to date during manual check', async () => {
      const mockClient: UpdaterClient = {
        check: vi.fn().mockRejectedValue(new Error('Could not fetch a valid release JSON from the remote')),
        relaunch: vi.fn().mockResolvedValue(undefined),
      };

      const result = await checkForUpdates(true, mockClient);
      expect(result.state).toBe('up-to-date');
    });

    it('returns user-friendly error message on true network failure during manual check', async () => {
      const mockClient: UpdaterClient = {
        check: vi.fn().mockRejectedValue(new Error('Connection timed out')),
        relaunch: vi.fn().mockResolvedValue(undefined),
      };

      const result = await checkForUpdates(true, mockClient);
      expect(result.state).toBe('error');
      if (result.state !== 'error') throw new Error('expected an update error');
      expect(result.message).toContain('Unable to connect to the update server');
    });

    it('handles reqwest unreachable network error gracefully with clear message', async () => {
      const mockClient: UpdaterClient = {
        check: vi.fn().mockRejectedValue(new Error('error sending request for url (https://github.com/Deign86/alpha-premier-attendance/releases/latest/download/latest.json)')),
        relaunch: vi.fn().mockResolvedValue(undefined),
      };

      const result = await checkForUpdates(true, mockClient);
      expect(result.state).toBe('error');
      if (result.state !== 'error') throw new Error('expected an update error');
      expect(result.message).toContain('Unable to connect to the update server');
    });

    it('handles non-Tauri browser environments gracefully', async () => {
      // SAFETY: Clearing mock Tauri property to simulate a pure web browser environment
      const win = window as TauriGlobalWindow;
      delete win.__TAURI_INTERNALS__;

      const mockClient: UpdaterClient = {
        check: vi.fn().mockResolvedValue(null),
        relaunch: vi.fn().mockResolvedValue(undefined),
      };

      const bgResult = await checkForUpdates(false, mockClient);
      expect(bgResult.state).toBe('disabled');

      const manualResult = await checkForUpdates(true, mockClient);
      expect(manualResult.state).toBe('error');
      if (manualResult.state !== 'error') throw new Error('expected a desktop-only error');
      expect(manualResult.message).toContain('desktop application only');
    });
  });

  describe('downloadAndInstallUpdate', () => {
    it('invokes downloadAndInstall with progress and triggers relaunch', async () => {
      const progressSteps: number[] = [];
      const mockClient: UpdaterClient = {
        check: vi.fn().mockResolvedValue(null),
        relaunch: vi.fn().mockResolvedValue(undefined),
      };

      const mockUpdate = createMockUpdate('0.1.15', '0.1.14', undefined, async (onEvent) => {
        onEvent({ event: 'Started', data: { contentLength: 1000 } });
        onEvent({ event: 'Progress', data: { chunkLength: 500 } });
        onEvent({ event: 'Finished' });
      });

      const outcome = await downloadAndInstallUpdate(
        mockUpdate,
        (p) => {
          progressSteps.push(p.percentage);
        },
        mockClient,
      );

      expect(outcome.ok).toBe(true);
      expect(mockClient.relaunch).toHaveBeenCalled();
      expect(progressSteps).toContain(0);
      expect(progressSteps).toContain(50);
      expect(progressSteps).toContain(100);
    });

    it('catches and isolates install failures without crashing caller', async () => {
      const mockClient: UpdaterClient = {
        check: vi.fn().mockResolvedValue(null),
        relaunch: vi.fn().mockResolvedValue(undefined),
      };

      const mockUpdate = createMockUpdate('0.1.15', '0.1.14', undefined, async () => {
        throw new Error('Signature verification failed');
      });

      const outcome = await downloadAndInstallUpdate(mockUpdate, undefined, mockClient);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('expected a failed install');
      expect(outcome.error).toContain('Signature verification failed');
      expect(outcome.error.length).toBeGreaterThan(0);
    });
  });
});
