import { useState, useEffect, useCallback, useId } from 'react';
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
import { listenForCheckForUpdates } from './tauri-api';

interface UpdateBannerProps {
  /** Optional manual trigger signal from admin panel */
  manualCheckTrigger?: number;
}

interface ToastState {
  status: 'checking' | 'success' | 'error';
  message: string;
}

export function UpdateBanner({ manualCheckTrigger }: UpdateBannerProps) {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateObj, setUpdateObj] = useState<Update | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [toastState, setToastState] = useState<ToastState | null>(null);

  // Install progress state
  const [isInstalling, setIsInstalling] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const titleId = useId();

  const runCheck = useCallback(async (manual = false) => {
    if (isChecking || isInstalling) return;
    setIsChecking(true);
    if (manual) {
      setToastState({ status: 'checking', message: 'Checking for updates…' });
    }

    try {
      const result = await checkForUpdates(manual);
      if (result.available && result.update && result.info) {
        setUpdateAvailable(true);
        setUpdateObj(result.update);
        setUpdateInfo(result.info);
        setBannerDismissed(false);
        if (manual) {
          setModalOpen(true);
          setToastState(null);
        }
      } else {
        if (manual) {
          if (result.error) {
            setToastState({ status: 'error', message: result.error });
            setTimeout(() => setToastState(null), 5000);
          } else {
            setToastState({
              status: 'success',
              message: 'Alpha Premier Attendance is up to date.',
            });
            setTimeout(() => setToastState(null), 4000);
          }
        }
      }
    } catch {
      if (manual) {
        setToastState({ status: 'error', message: 'Unable to check for updates.' });
        setTimeout(() => setToastState(null), 5000);
      }
    } finally {
      setIsChecking(false);
    }
  }, [isChecking, isInstalling]);

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
    };
  }, [runCheck]);

  // Listen for tray menu "Check for updates…"
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenForCheckForUpdates(() => {
      void runCheck(true);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {
        // Ignore listener setup error
      });

    return () => {
      if (unlisten) unlisten();
    };
  }, [runCheck]);

  // Manual trigger from props (e.g. from admin panel)
  useEffect(() => {
    if (manualCheckTrigger && manualCheckTrigger > 0) {
      void runCheck(true);
    }
  }, [manualCheckTrigger, runCheck]);

  const handleStartInstall = async () => {
    if (!updateObj || isInstalling) return;
    setIsInstalling(true);
    setInstallError(null);

    const result = await downloadAndInstallUpdate(updateObj, (p) => {
      setProgress(p);
    });

    if (!result.success) {
      setIsInstalling(false);
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
      {updateAvailable && updateInfo && !bannerDismissed && !modalOpen && (
        <div className="update-banner" role="alert">
          <div className="update-banner-content">
            <div className="update-banner-icon">
              <ArrowUpCircle size={20} />
            </div>
            <div className="update-banner-text">
              <strong>Update available: v{updateInfo.version}</strong>
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
              onClick={() => setBannerDismissed(true)}
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Modal Dialog for Update Details & Installation */}
      {modalOpen && updateInfo && (
        <div className="setup-backdrop" role="dialog" aria-modal="true" aria-labelledby={titleId}>
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
                  <strong>v{updateInfo.currentVersion}</strong>
                </div>
                <div className="version-arrow">→</div>
                <div className="version-tag new">
                  <small>New release</small>
                  <strong>v{updateInfo.version}</strong>
                </div>
              </div>

              {updateInfo.body && (
                <div className="update-notes-container">
                  <label htmlFor="update-release-notes">Release notes:</label>
                  <div id="update-release-notes" className="update-notes-body">
                    {updateInfo.body}
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
                      onClick={() => void handleStartInstall()}
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
