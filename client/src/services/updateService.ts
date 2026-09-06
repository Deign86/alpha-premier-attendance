import { check, type CheckOptions, type Update } from '@tauri-apps/plugin-updater';
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

/**
 * Discriminated update-check outcome: exactly one state is ever present, so
 * callers narrow on `state` instead of re-checking an `available`/`error`
 * pair that permitted `available: true` alongside a set error.
 */
export type CheckUpdateResult =
  | { state: 'disabled' }
  | { state: 'up-to-date' }
  | { state: 'available'; update: Update; info: UpdateInfo }
  | { state: 'error'; message: string };

/** Release-endpoint responses that mean "no published update", not a failure. */
const NOT_FOUND_PATTERNS = [
  'could not fetch a valid release json',
  'release json',
  'releasenotfound',
  'could not find a release',
  'no release found',
  'status 404',
  '404 not found',
  '404',
  'not found',
  'uptodate',
  'up to date',
] as const;

/** Transport-level failures that mean "could not reach the update server". */
const NETWORK_PATTERNS = [
  'error sending request',
  'connect error',
  'timed out',
  'timeout',
  'network unreachable',
  'unreachable network',
  'could not connect',
  'connection refused',
  'connection reset',
  'dns error',
  'failed to resolve',
  'failed to connect',
  'failed to fetch',
] as const;

function matchesAny(normalizedMessage: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => normalizedMessage.includes(pattern));
}

export function isUpdateNotFoundMessage(normalizedMessage: string): boolean {
  return matchesAny(normalizedMessage, NOT_FOUND_PATTERNS);
}

export function isUpdateNetworkMessage(normalizedMessage: string): boolean {
  return matchesAny(normalizedMessage, NETWORK_PATTERNS);
}

export interface UpdaterClient {
  check: (options?: CheckOptions) => Promise<Update | null>;
  relaunch: () => Promise<void>;
}

export const defaultUpdaterClient: UpdaterClient = {
  check: (options?: CheckOptions) => check(options),
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
    return { state: 'disabled' };
  }

  if (!runningInTauri()) {
    if (manual) {
      return { state: 'error', message: 'Update checks are available in the desktop application only.' };
    }
    return { state: 'disabled' };
  }

  try {
    const update = await client.check({ timeout: 8_000 });
    if (update) {
      return {
        state: 'available',
        update,
        info: {
          version: update.version,
          currentVersion: update.currentVersion,
          body: update.body,
          date: update.date,
        },
      };
    }
    return { state: 'up-to-date' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!manual) {
      // Background checks fail silently so kiosk operation is never blocked by network issues
      console.warn('Silent background update check failed:', message);
      return { state: 'disabled' };
    }

    const normalized = message.toLowerCase();
    // When the release endpoint returns 404 or no latest.json exists on the latest release,
    // there are no published updates available. Treat as up-to-date rather than an error.
    if (isUpdateNotFoundMessage(normalized)) {
      return { state: 'up-to-date' };
    }

    // Network / connectivity / timeout issues
    if (isUpdateNetworkMessage(normalized)) {
      return { state: 'error', message: 'Unable to connect to the update server. Please check your internet connection.' };
    }

    return { state: 'error', message: message || 'Unable to check for updates.' };
  }
}

/**
 * Install outcome as a discriminated union: success carries no error
 * payload, failure always carries a message. Unlike the former
 * `{success, error}` pair, `ok: true` alongside an error is unrepresentable.
 */
export type InstallUpdateResult = { ok: true } | { ok: false; error: string };

/**
 * Download and install the update package, notifying progress, then relaunch.
 */
export async function downloadAndInstallUpdate(
  update: Update,
  onProgress?: (progress: UpdateProgress) => void,
  client: UpdaterClient = defaultUpdaterClient,
): Promise<InstallUpdateResult> {
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
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Update install failed:', message);
    return {
      ok: false,
      error: message || 'Failed to install update.',
    };
  }
}
