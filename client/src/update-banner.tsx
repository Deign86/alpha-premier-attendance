import { useState, useEffect, useCallback, useId, useRef } from 'react';
import {
  AlertCircle,
  ArrowUpCircle,
  CheckCircle,
  Download,
  LoaderCircle,
  RefreshCw,
  X,
} from 'lucide-react';
import type { Update } from '@tauri-apps/plugin-updater';
import {
  checkForUpdates,
  downloadAndInstallUpdate,
  type UpdateInfo,
  type UpdateProgress,
} from './services/updateService';
import { detachWhenDone, listenForCheckForUpdates } from './tauri-api';
import { formatShortDate } from './format';
import { useDialogKeys } from './use-dialog-keys';

interface UpdateBannerProps {
  /** Optional manual trigger signal from admin panel */
  manualCheckTrigger?: number;
  /** Admin passes its unsaved-changes check; the install (which restarts the app) runs once it allows. */
  beforeInstall?: (install: () => void) => void;
}

interface ToastState {
  status: 'checking' | 'success' | 'error';
  message: string;
}

type UpdateAvailability =
  | { status: 'none' }
  | { status: 'available'; update: Update; info: UpdateInfo };

const UPDATER_TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)?\s*(Z|[+-]\d{1,2}:\d{2}(?::\d{2})?)?$/;

/**
 * The release time the updater reports ("2026-10-30 23:30:00.0 +00:00:00", or an ISO time) as an ISO instant, so
 * it can be shown on Manila time; a bare day is kept as that day. Null when it can't be read (the date is then left out).
 */
export function updaterReleaseInstant(raw: string | undefined): string | null {
  const text = raw?.trim() ?? '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = UPDATER_TIME.exec(text);
  if (!match) return null;
  const [, day, hour, minute, second, offset] = match;
  const [offsetHours = '0', offsetMinutes = '00'] = offset && offset !== 'Z' ? offset.slice(1).split(':') : [];
  const zone = offset && offset !== 'Z' ? `${offset[0]}${offsetHours.padStart(2, '0')}:${offsetMinutes}` : 'Z';
  const iso = `${day}T${hour.padStart(2, '0')}:${minute}:${second}${zone}`;
  return Number.isNaN(new Date(iso).getTime()) ? null : iso;
}

export function UpdateBanner({ manualCheckTrigger, beforeInstall }: UpdateBannerProps) {
  const [availability, setAvailability] = useState<UpdateAvailability>({ status: 'none' });
  const [bannerDismissed, setBannerDismissed] = useState(() =>
    sessionStorage.getItem('alpha_dismissed_update') === 'true',
  );
  const [modalOpen, setModalOpen] = useState(false);
  const isCheckingRef = useRef(false);
  const isInstallingRef = useRef(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [toastState, setToastState] = useState<ToastState | null>(null);

  // Install progress state
  const [isInstalling, setIsInstalling] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const titleId = useId();
  const releasedAt = availability.status === 'available' ? updaterReleaseInstant(availability.info.date) : null;
  // Escape closes the details ("Later") except while the update installs; Tab stays inside.
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogKeys(dialogRef, () => setModalOpen(false), {
    busy: isInstalling,
    open: modalOpen && availability.status === 'available',
  });

  const showToast = useCallback((state: ToastState | null, autoDismissMs?: number) => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToastState(state);
    if (state && autoDismissMs) {
      toastTimerRef.current = setTimeout(() => {
        setToastState(null);
        toastTimerRef.current = null;
      }, autoDismissMs);
    }
  }, []);

  const runCheck = useCallback(async (manual = false) => {
    if (isCheckingRef.current || isInstallingRef.current) return;
    isCheckingRef.current = true;
    if (manual) {
      showToast({ status: 'checking', message: 'Checking for updates…' });
    }

    try {
      const result = await checkForUpdates(manual);
      if (result.state === 'available') {
        setAvailability({ status: 'available', update: result.update, info: result.info });
        setBannerDismissed(false);
        if (manual) {
          setModalOpen(true);
          showToast(null);
        }
      } else if (manual) {
        if (result.state === 'error') {
          showToast({ status: 'error', message: result.message }, 5000);
        } else {
          showToast(
            {
              status: 'success',
              message: 'Alpha Premier Attendance is up to date.',
            },
            4000,
          );
        }
      }
    } catch {
      if (manual) {
        showToast({ status: 'error', message: 'Unable to check for updates.' }, 5000);
      }
    } finally {
      isCheckingRef.current = false;
    }
  }, [showToast]);

  // Initial check on load (after 4-second delay so startup isn't competed for resources)
  useEffect(() => {
    const startupTimer = setTimeout(() => {
      void runCheck(false);
    }, 4000);

    // Periodic check every 8 hours
    const intervalTimer = setInterval(() => {
      void runCheck(false);
    }, 8 * 60 * 60 * 1000);

    return () => {
      clearTimeout(startupTimer);
      clearInterval(intervalTimer);
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, [runCheck]);

  // Listen for tray menu "Check for updates…"
  useEffect(() => detachWhenDone(listenForCheckForUpdates(() => {
    void runCheck(true);
  })), [runCheck]);

  // Manual trigger from props (e.g. from admin panel)
  const prevTriggerRef = useRef<number | undefined>(0);
  useEffect(() => {
    if (
      manualCheckTrigger !== undefined &&
      manualCheckTrigger > 0 &&
      manualCheckTrigger !== prevTriggerRef.current
    ) {
      prevTriggerRef.current = manualCheckTrigger;
      void runCheck(true);
    }
  }, [manualCheckTrigger, runCheck]);

  const handleStartInstall = async () => {
    if (availability.status !== 'available' || isInstalling) return;
    setIsInstalling(true);
    isInstallingRef.current = true;
    setInstallError(null);

    const result = await downloadAndInstallUpdate(availability.update, (p) => {
      setProgress(p);
    });

    if (!result.ok) {
      setIsInstalling(false);
      isInstallingRef.current = false;
      setInstallError(result.error);
    }
  };

  return (
    <>
      {/* Toast message for manual up-to-date checks */}
      {toastState && (
        <div
          className={`update-toast${toastState.status === 'error' ? ' error' : ''}`}
          role="status"
          aria-live="polite"
        >
          {toastState.status === 'checking' && <LoaderCircle className="spin" size={16} />}
          {toastState.status === 'success' && <CheckCircle size={16} />}
          {toastState.status === 'error' && <AlertCircle size={16} />}
          <span>{toastState.message}</span>
        </div>
      )}

      {/* Floating In-App Update Banner */}
      {availability.status === 'available' && !bannerDismissed && !modalOpen && (
        <div className="update-banner" role="alert">
          <div className="update-banner-content">
            <div className="update-banner-icon">
              <ArrowUpCircle size={20} />
            </div>
            <div className="update-banner-text">
              <strong>Update available: v{availability.info.version}</strong>
              <span>A new version of Alpha Premier Attendance is ready.</span>
            </div>
          </div>
          <div className="update-banner-actions">
            <button
              className="update-banner-button primary"
              type="button"
              onClick={() => setModalOpen(true)}
            >
              <Download size={14} />
              View &amp; install
            </button>
            <button
              className="update-banner-button dismiss"
              type="button"
              aria-label="Dismiss update notification"
              onClick={() => {
                setBannerDismissed(true);
                sessionStorage.setItem('alpha_dismissed_update', 'true');
              }}
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Modal Dialog for Update Details & Installation */}
      {modalOpen && availability.status === 'available' && (
        <div ref={dialogRef} className="setup-backdrop" role="dialog" aria-modal="true" aria-labelledby={titleId}>
          <div className="setup-dialog update-dialog">
            <div className="setup-dialog-header">
              <div className="setup-title-wrap">
                <div className="setup-icon">
                  <ArrowUpCircle size={22} />
                </div>
                <div>
                  <p className="section-kicker">Software update</p>
                  <h2 id={titleId}>Update Alpha Premier Attendance</h2>
                </div>
              </div>
              {!isInstalling && (
                <button
                  className="icon-button"
                  type="button"
                  aria-label="Close dialog"
                  onClick={() => setModalOpen(false)}
                >
                  <X size={18} />
                </button>
              )}
            </div>

            <div className="setup-form">
              <div className="update-version-row">
                <div className="version-tag current">
                  <small>Current version</small>
                  <strong>v{availability.info.currentVersion}</strong>
                </div>
                <div className="version-arrow">→</div>
                <div className="version-tag new">
                  <small>New release</small>
                  <strong>v{availability.info.version}</strong>
                  {releasedAt && <small>Released {formatShortDate(releasedAt)}</small>}
                </div>
              </div>

              {availability.info.body && (
                <div className="update-notes-container">
                  <label htmlFor="update-release-notes">Release notes:</label>
                  <div id="update-release-notes" className="update-notes-body">
                    {availability.info.body}
                  </div>
                </div>
              )}

              {/* Download / Installation Progress Bar */}
              {isInstalling && (
                <div className="update-progress-card">
                  <div className="update-progress-label">
                    <span>
                      {progress?.phase === 'starting' && 'Connecting to release server…'}
                      {progress?.phase === 'downloading' && 'Downloading update package…'}
                      {progress?.phase === 'installing' && 'Installing update…'}
                      {progress?.phase === 'finished' && 'Restarting application…'}
                    </span>
                    <strong>{progress?.percentage ?? 0}%</strong>
                  </div>
                  <div className="update-progress-track">
                    <div
                      className="update-progress-fill"
                      style={{ width: `${progress?.percentage ?? 0}%` }}
                    />
                  </div>
                  <p className="update-progress-hint">
                    Attendance data and settings will be preserved across the update.
                  </p>
                </div>
              )}

              {installError && (
                <p className="dashboard-alert" role="alert">
                  {installError}
                </p>
              )}

              <div className="update-dialog-footer">
                {!isInstalling ? (
                  <>
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => setModalOpen(false)}
                    >
                      Later
                    </button>
                    <button
                      className="submit-button"
                      type="button"
                      onClick={() => (beforeInstall ? beforeInstall(() => void handleStartInstall()) : void handleStartInstall())}
                    >
                      <Download size={16} />
                      Download &amp; restart
                    </button>
                  </>
                ) : (
                  <div className="update-installing-status">
                    <RefreshCw className="spin" size={16} />
                    <span>Please do not close the window…</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
