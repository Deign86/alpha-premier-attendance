import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export const TERMINAL_DISABLE_AUTO_UPDATE_KEY = 'alpha_premier_terminal_disable_auto_update';

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  body?: string;
  date?: string;
}

export interface UpdateProgress {
  downloadedBytes: number;
  totalBytes: number;
  percentage: number;
  phase: 'starting' | 'downloading' | 'installing' | 'finished';
}

export interface CheckUpdateResult {
  available: boolean;
  update: Update | null;
  info: UpdateInfo | null;
  error: string | null;
}

export interface UpdaterClient {
  check: () => Promise<Update | null>;
  relaunch: () => Promise<void>;
}

export const defaultUpdaterClient: UpdaterClient = {
  check: () => check(),
  relaunch: () => relaunch(),
};

export function isAutoUpdateDisabledLocally(): boolean {
  try {
    return globalThis.localStorage?.getItem(TERMINAL_DISABLE_AUTO_UPDATE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setAutoUpdateDisabledLocally(disabled: boolean): void {
  try {
    if (disabled) {
      globalThis.localStorage?.setItem(TERMINAL_DISABLE_AUTO_UPDATE_KEY, 'true');
    } else {
      globalThis.localStorage?.removeItem(TERMINAL_DISABLE_AUTO_UPDATE_KEY);
    }
  } catch {
    // Ignore storage write errors
  }
}

const runningInTauri = () =>
  globalThis.window !== undefined && '__TAURI_INTERNALS__' in globalThis.window;

/**
 * Check for updates from GitHub Releases via the Tauri v2 updater plugin.
 *
 * When `manual` is false (background check), respects the terminal-level
 * auto-update disable flag and network disconnects fail silently without
 * interrupting the attendance kiosk.
 */
export async function checkForUpdates(
  manual = false,
  client: UpdaterClient = defaultUpdaterClient,
): Promise<CheckUpdateResult> {
  if (!manual && isAutoUpdateDisabledLocally()) {
    return {
      available: false,
      update: null,
      info: null,
      error: null,
    };
  }

  if (!runningInTauri()) {
    if (manual) {
      return {
        available: false,
        update: null,
        info: null,
        error: 'Update checks are available in the desktop application only.',
      };
    }
    return {
      available: false,
      update: null,
      info: null,
      error: null,
    };
  }

  try {
    const update = await client.check();
    if (update) {
      return {
        available: true,
        update,
        info: {
          version: update.version,
          currentVersion: update.currentVersion,
          body: update.body,
          date: update.date,
        },
        error: null,
      };
    }
    return {
      available: false,
      update: null,
      info: null,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!manual) {
      // Background checks fail silently so kiosk operation is never blocked by network issues
      console.warn('Silent background update check failed:', message);
      return {
        available: false,
        update: null,
        info: null,
        error: null,
      };
    }

    const normalized = message.toLowerCase();
    // When the release endpoint returns 404 or no latest.json exists on the latest release,
    // there are no published updates available. Treat as up-to-date rather than an error.
    if (
      normalized.includes('could not fetch a valid release json') ||
      normalized.includes('release json') ||
      normalized.includes('releasenotfound') ||
      normalized.includes('could not find a release') ||
      normalized.includes('no release found') ||
      normalized.includes('404') ||
      normalized.includes('uptodate') ||
      normalized.includes('up to date')
    ) {
      return {
        available: false,
        update: null,
        info: null,
        error: null,
      };
    }

    return {
      available: false,
      update: null,
      info: null,
      error: message || 'Unable to check for updates.',
    };
  }
}

/**
 * Download and install the update package, notifying progress, then relaunch.
 */
export async function downloadAndInstallUpdate(
  update: Update,
  onProgress?: (progress: UpdateProgress) => void,
  client: UpdaterClient = defaultUpdaterClient,
): Promise<{ success: boolean; error: string | null }> {
  try {
    let totalLength = 0;
    let downloaded = 0;

    if (onProgress) {
      onProgress({
        downloadedBytes: 0,
        totalBytes: 0,
        percentage: 0,
        phase: 'starting',
      });
    }

    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case 'Started':
          totalLength = event.data.contentLength ?? 0;
          if (onProgress) {
            onProgress({
              downloadedBytes: 0,
              totalBytes: totalLength,
              percentage: 0,
              phase: 'downloading',
            });
          }
          break;
        case 'Progress':
          downloaded += event.data.chunkLength;
          if (onProgress) {
            const pct =
              totalLength > 0
                ? Math.min(100, Math.round((downloaded / totalLength) * 100))
                : 0;
            onProgress({
              downloadedBytes: downloaded,
              totalBytes: totalLength,
              percentage: pct,
              phase: 'downloading',
            });
          }
          break;
        case 'Finished':
          if (onProgress) {
            onProgress({
              downloadedBytes: totalLength || downloaded,
              totalBytes: totalLength || downloaded,
              percentage: 100,
              phase: 'installing',
            });
          }
          break;
      }
    });

    if (onProgress) {
      onProgress({
        downloadedBytes: totalLength || downloaded,
        totalBytes: totalLength || downloaded,
        percentage: 100,
        phase: 'finished',
      });
    }

    // Relaunch the desktop app into the updated version
    await client.relaunch();
    return { success: true, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Update install failed:', message);
    return {
      success: false,
      error: message || 'Failed to install update.',
    };
  }
}
