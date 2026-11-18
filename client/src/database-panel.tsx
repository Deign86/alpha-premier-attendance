import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, Check, Download, History, RefreshCcw, ShieldAlert } from "lucide-react";
import type { DatabaseInfoResponse } from "@rfid-attendance/shared";
import { dismissRestoreFailure, loadDatabaseInfo, loadDtrSyncHealth, getInternDtrSync, setInternDtrSync, syncInternDtr, openDatabaseBackupsFolder, saveBackupCopy, requestDatabaseRestore } from "./api";
import type { DtrSyncHealth } from "./api";
import { listenForDtrSyncProgress, detachWhenDone } from "./tauri-api";
import type { DtrSyncProgress, DtrSyncSource } from "./tauri-api";
import { isDtrSyncAlreadyRunning, refreshDtrSyncHealth, setDtrSyncActive, setDtrSyncHealthSnapshot, startDtrSyncHealthPolling, useDtrSyncActive } from "./dtr-sync-guard";
import { pickRestoreBackupFile } from "./api";
import { AdminUpdatesCard } from "./admin-updates-card";
import { createBackupNow, LastBackupLine, manilaDay, useBackupCreated, useBackupRunning } from "./backup-reminder";
import { formatDateTime, formatDuration, formatMonth, formatTime } from "./format";
import { useDialogKeys } from "./use-dialog-keys";
import { NoticeLine } from "./notice";
import type { Notice } from "./notice";
import { showToast } from "./toasts";
import { LoadFailed, useListLoad } from "./list-load";
import { ConfirmDialog } from "./confirm-dialog";
import { showResult } from "./payroll-workspace";
import { ReaderStatusLine } from "./scanner-status";

/** Data & backup panel: configurable DB location, safe backups, and the PC-switch restore flow. */
type RestoreFailureDetail = {
  friendly: string;
  sourceFile: string | null;
};

function describeRestoreFailure(raw: string): RestoreFailureDetail {
  const text = raw.trim();
  let sourceFile: string | null = null;
  let detail = text;
  const sep = text.indexOf(": ");
  if (sep > 0) {
    const head = text.slice(0, sep).trim();
    if (head.length > 0 && head.length < 300 && /[/\\.]/.test(head)) {
      sourceFile = head.split(/[/\\]/).filter(Boolean).pop() ?? head;
      detail = text.slice(sep + 2).trim() || head;
    }
  }
  const lower = detail.toLowerCase();
  if (lower.includes("missing") || lower.includes("not found") || lower.includes("no such file")) {
    return {
      friendly: "The selected backup file could no longer be found when the app restarted (it may have been moved, renamed, or removed from the USB drive).",
      sourceFile,
    };
  }
  if (
    lower.includes("not a valid") ||
    lower.includes("not an alpha premier") ||
    lower.includes("integrity") ||
    lower.includes("foreign key") ||
    lower.includes("schema") ||
    lower.includes("not a database") ||
    lower.includes("file is encrypted")
  ) {
    return {
      friendly: "The selected file is not a valid Alpha Premier attendance backup (it failed the database integrity check).",
      sourceFile,
    };
  }
  if (
    lower.includes("unsafe path") ||
    lower.includes("zip") ||
    lower.includes("unpack") ||
    lower.includes("config") ||
    lower.includes("staging")
  ) {
    return {
      friendly: "The backup file could not be unpacked on this computer (the archive looks incomplete or damaged).",
      sourceFile,
    };
  }
  return {
    friendly: "The restore could not be applied on the next launch.",
    sourceFile,
  };
}

export function dtrSyncSourceLabel(source: DtrSyncSource | undefined): string {
  return source === "queue" ? "Queue" : "Manual";
}

export function applyDtrProgressToGuard(progress: DtrSyncProgress): void {
  setDtrSyncActive(progress.status !== "completed");
}

type SyncHealthState =
  | { kind: "loading" }
  | { kind: "ready"; health: DtrSyncHealth }
  | { kind: "refreshing"; health: DtrSyncHealth }
  | { kind: "stale"; health: DtrSyncHealth; message: string }
  | { kind: "error"; message: string }
  | { kind: "syncing" };

type StoppedDtrSync = { tab: string; userId: string | null };

/** "12:50 PM" for today, "Oct 29, 2026, 12:50 PM" for another day (office time). */
function clockTime(value: string): string {
  return manilaDay(new Date(value)) === manilaDay(new Date()) ? formatTime(value) : formatDateTime(value);
}

type SheetsStatus = { tone: "ok" | "waiting" | "failed" | "quiet"; text: string };

/** "1 record", "12 records". */
export function recordCount(count: number): string {
  return `${count} record${count === 1 ? "" : "s"}`;
}

/** What uploading off means, shown under the tick box and as the toast when it is turned off. */
const UPLOAD_OFF_TEXT = "Uploading is off for this PC. Attendance is kept here and uploads when it's turned back on.";

/**
 * The Google Sheets upload in plain words, one line in one colour: green when up to date, gold while records wait,
 * coral only when something really failed, grey when there is nothing to tell yet (checking, paused, unavailable).
 * The waiting count is every intern DTR record not uploaded yet, the same numbers "Details for support" lists.
 */
function sheetsStatus(state: SyncHealthState, health: DtrSyncHealth | null, uploadOn: boolean | null): SheetsStatus {
  if (state.kind === "syncing") return { tone: "waiting", text: "Uploading…" };
  if (state.kind === "loading") return { tone: "quiet", text: "Checking…" };
  const dtr = health?.dtr;
  if (!health || !dtr) return { tone: "quiet", text: "Status unavailable" };
  if (dtr.persistenceFailure || dtr.currentIssue === "persistence") {
    return { tone: "failed", text: "An attendance record couldn't be saved for upload. Tell an administrator." };
  }
  // Sync now is off while uploading is off, so it is only suggested while it can be used.
  if (dtr.dead > 0) {
    return { tone: "failed", text: `${recordCount(dtr.dead)} couldn't upload.${uploadOn === false ? "" : " Use Sync now to try again."}` };
  }
  if (dtr.needsAttention > 0) {
    const one = dtr.needsAttention === 1;
    return { tone: "failed", text: `${recordCount(dtr.needsAttention)} ${one ? "needs" : "need"} an administrator before ${one ? "it" : "they"} can upload.` };
  }
  if (dtr.activity === "unavailable") return { tone: "quiet", text: "Status unavailable. Attendance keeps saving on this PC." };
  if (!dtr.enabled || dtr.activity === "disabled" || uploadOn === false) return { tone: "quiet", text: "Paused on this PC" };
  const waiting = dtr.queued + dtr.retrying + dtr.processing + dtr.retryablePending;
  const nextTry = dtr.nextRetryEligibleAt ?? health.throttledUntil;
  const nextTryText = nextTry ? ` · next try ${clockTime(nextTry)}` : "";
  if (waiting > 0) return { tone: "waiting", text: `${recordCount(waiting)} waiting${nextTryText}` };
  if (dtr.currentIssue === "auth_config" || dtr.currentIssue === "unresolved_layout") {
    return { tone: "failed", text: "Google Sheets needs an administrator before uploads can continue." };
  }
  if (dtr.activity === "offline") return { tone: "waiting", text: "Can't reach Google Sheets right now" };
  if (dtr.activity === "throttled") return { tone: "waiting", text: `Google Sheets asked to slow down${nextTryText}` };
  const lastUpload = dtr.lastSuccessfulWriteAt ?? health.lastSyncedAt;
  return { tone: "ok", text: `Up to date${lastUpload ? ` · last upload ${clockTime(lastUpload)}` : ""}` };
}

/** The database status for Data and backup and the System tab; throws when it can't be read (or in a browser). */
async function fetchDatabaseInfo(): Promise<DatabaseInfoResponse | null> {
  const response = await loadDatabaseInfo();
  if (!response.success) throw new Error(response.error.message);
  return response;
}

/**
 * System: one flat "This PC" card. The version beside Check for updates now, two plain tick boxes, one card reader
 * line, and the file paths for support folded under a closed "Technical details (for support)" line.
 */
export function SystemPanel({ onManualUpdateCheck, lastScanAt = null }: { onManualUpdateCheck: () => void; lastScanAt?: string | null }) {
  const infoList = useListLoad(fetchDatabaseInfo, null);
  const info = infoList.data;
  return (
    <section className="lan-panel system-panel" aria-labelledby="system-heading">
      <h2 id="system-heading">This PC</h2>
      <AdminUpdatesCard onManualCheck={onManualUpdateCheck} />
      <ReaderStatusLine lastScanAt={lastScanAt} />
      <details className="tech-details">
        <summary>Technical details (for support)</summary>
        <dl>
          <div>
            <dt>Database file</dt>
            <dd><bdi>{info?.dbPath ?? "—"}</bdi></dd>
          </div>
          <div>
            <dt>Data folder</dt>
            <dd><bdi>{info?.dataDir ?? "—"}</bdi></dd>
          </div>
          <div>
            <dt>Backups folder</dt>
            <dd><bdi>{info?.backupDir ?? "—"}</bdi></dd>
          </div>
          <div>
            <dt>Storage mode</dt>
            <dd>{info ? (info.isPortableMode ? "Portable — next to the .exe" : "Installed — app data folder") : "—"}</dd>
          </div>
          {infoList.status === "failed" && (
            <div>
              <dt>Database status</dt>
              <dd>{infoList.error ?? "Unavailable."}</dd>
            </div>
          )}
        </dl>
      </details>
    </section>
  );
}

export function DatabasePanel() {
  // Results that need reading stay in their section; routine ones (backup created, saved a copy) show as toasts.
  const [backupMessage, setBackupMessage] = useState<Notice | null>(null);
  const [syncMessage, setSyncMessage] = useState<Notice | null>(null);
  // Backups and uploads lock only their own buttons: a restore being scheduled, or a backup being made anywhere
  // (here or from the Friday reminder), locks the backup buttons; an upload locks Sync now and its tick box.
  const [restoreBusy, setRestoreBusy] = useState(false);
  const backupRunning = useBackupRunning();
  const backupBusy = restoreBusy || backupRunning;
  const [syncBusy, setSyncBusy] = useState(false);
  const [stoppedDtrSync, setStoppedDtrSync] = useState<StoppedDtrSync | null>(null);
  const [restoreFile, setRestoreFile] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [dismissingRestore, setDismissingRestore] = useState(false);
  const [syncState, setSyncState] = useState<SyncHealthState>({ kind: "loading" });
  const [dtrProgress, setDtrProgress] = useState<DtrSyncProgress | null>(null);
  const dtrSyncActive = useDtrSyncActive();
  // Per-device DTR kill switch: null = still loading, boolean = stored state.
  const [dtrSyncEnabled, setDtrSyncEnabled] = useState<boolean | null>(null);
  const [dtrToggleBusy, setDtrToggleBusy] = useState(false);
  const syncHealth =
    syncState.kind === "ready" || syncState.kind === "refreshing" || syncState.kind === "stale"
      ? syncState.health
      : null;
  const syncHealthSeq = useRef(0);
  const refreshSyncHealth = useCallback(async (releaseSyncing = false) => {
    setSyncState((prev) =>
      // A manual sync owns the badge while it is in flight: a background poll
      // must not downgrade `syncing` to `loading`/`refreshing` and make the
      // panel read "Not synced" mid-sync.
      prev.kind === "syncing"
        ? prev
        : prev.kind === "ready" || prev.kind === "refreshing" || prev.kind === "stale"
          ? { kind: "refreshing", health: prev.health }
          : { kind: "loading" },
    );
    const seq = syncHealthSeq.current + 1;
    syncHealthSeq.current = seq;
    const response = await loadDtrSyncHealth();
    if (syncHealthSeq.current !== seq) return;
    if (response.success && response.health.dtr) {
      setDtrSyncHealthSnapshot({
        activity: response.health.dtr.activity,
        queued: response.health.dtr.queued,
        retryablePending: response.health.dtr.retryablePending,
        needsAttention: response.health.dtr.needsAttention,
        dead: response.health.dtr.dead,
        persistenceFailure: response.health.dtr.persistenceFailure,
        emittedAt: response.health.dtr.emittedAt,
      });
    } else {
      setDtrSyncHealthSnapshot({
        activity: "unavailable",
        queued: 0,
        retryablePending: 0,
        needsAttention: 0,
        dead: 0,
        persistenceFailure: false,
      });
    }
    setSyncState((prev) => {
      // A background poll must not dislodge `syncing`; only the manual sync's
      // own post-sync refresh (releaseSyncing) may leave it — :3339 is the
      // sole exit from `syncing`, so a blanket guard would strand the badge.
      if (prev.kind === "syncing" && !releaseSyncing) return prev;
      if (response.success) return { kind: "ready", health: response.health };
      if (prev.kind === "ready" || prev.kind === "refreshing" || prev.kind === "stale") {
        return { kind: "stale", health: prev.health, message: response.error.message };
      }
      return { kind: "error", message: response.error.message };
    });
  }, []);
  const refreshDtrSyncToggle = useCallback(async () => {
    const response = await getInternDtrSync();
    if (response.success) setDtrSyncEnabled(response.enabled);
  }, []);
  useEffect(() => startDtrSyncHealthPolling(() => refreshSyncHealth()), [refreshSyncHealth]);
  useEffect(() => {
    void refreshDtrSyncToggle();
  }, [refreshDtrSyncToggle]);

  useEffect(() => detachWhenDone(listenForDtrSyncProgress((progress) => {
    setDtrProgress(progress);
    applyDtrProgressToGuard(progress);
    if (progress.status === "completed") void refreshDtrSyncHealth(() => refreshSyncHealth());
  })), [refreshSyncHealth]);

  const infoList = useListLoad(fetchDatabaseInfo, null);
  const info = infoList.data;
  // A backup made anywhere (here or from the Friday reminder) shows in the list and the Last backup line at once.
  const refreshInfo = infoList.refresh;
  useBackupCreated(useCallback(() => void refreshInfo(), [refreshInfo]));
  const guideRef = useRef<HTMLElement>(null);
  useDialogKeys(guideRef, () => setGuideOpen(false), { open: guideOpen });

  const toggleDtrSync = async () => {
    if (dtrSyncEnabled === null || dtrToggleBusy) return;
    const next = !dtrSyncEnabled;
    setDtrToggleBusy(true);
    setSyncMessage(null);
    const response = await setInternDtrSync(next);
    if (response.success) {
      setDtrSyncEnabled(response.enabled);
      void refreshDtrSyncHealth(() => refreshSyncHealth());
      showToast(response.enabled ? "Uploading to Google Sheets is on for this PC." : UPLOAD_OFF_TEXT);
    } else {
      setSyncMessage({ tone: "error", text: "Couldn't change the upload setting." });
    }
    setDtrToggleBusy(false);
  };

  const syncInterns = async (startFromUserId?: string) => {
    if (dtrSyncActive) {
      setSyncMessage({ tone: "info", text: "Sync already running." });
      return;
    }
    setSyncBusy(true);
    setSyncState({ kind: "syncing" });
    setDtrSyncActive(true);
    setDtrProgress(null);
    setSyncMessage(null);
    try {
      const response = await syncInternDtr(undefined, startFromUserId);
      const hasErrors = Array.isArray(response.errors) && response.errors.length > 0;
      if (response.stoppedTab || response.stoppedUserId) {
        const stoppedDetail = (response.stoppedUserId
          ? response.details.find((detail) => detail.userId === response.stoppedUserId)
          : undefined)
          ?? (response.stoppedTab
            ? response.details.find((detail) => detail.tab === response.stoppedTab)
            : undefined);
        setStoppedDtrSync({
          tab: response.stoppedTab ?? stoppedDetail?.fullName ?? "Unknown tab",
          userId: response.stoppedUserId ?? stoppedDetail?.userId ?? null,
        });
      } else if (response.success && !hasErrors) {
        setStoppedDtrSync(null);
      }
      if (response.success && !hasErrors) {
        setSyncMessage({ tone: "success", text: `Upload finished: ${recordCount(response.rowsSynced ?? 0)} sent.` });
      } else {
        const errDetail = hasErrors
          ? response.errors.join("; ")
          : response.error?.message || "Upload failed.";
        if (isDtrSyncAlreadyRunning(errDetail)) {
          setSyncMessage({ tone: "info", text: "Sync already running." });
        } else if (response.rowsSynced > 0) {
          setSyncMessage({ tone: "error", text: `${recordCount(response.rowsSynced)} sent, but some didn't upload: ${errDetail}` });
        } else {
          setSyncMessage({ tone: "error", text: errDetail });
        }
      }
    } finally {
      setSyncBusy(false);
      setDtrSyncActive(false);
      setDtrProgress(null);
    }
    setSyncState((prev) => prev.kind === "syncing"
      ? syncHealth ? { kind: "refreshing", health: syncHealth } : { kind: "loading" }
      : prev);
    void refreshDtrSyncHealth(() => refreshSyncHealth(true));
  };

  const createBackup = async () => {
    setBackupMessage(null);
    // A toast says it worked and the Last backup line moves to now; only a problem stays on the page.
    const response = await createBackupNow();
    if (!response.success) setBackupMessage({ tone: "error", text: response.error.message });
  };

  const restore = async () => {
    if (!("__TAURI_INTERNALS__" in window)) {
      setBackupMessage({ tone: "error", text: "Restore is available in the desktop application." });
      return;
    }
    try {
      const selected = await pickRestoreBackupFile();
      if (!selected) return;
      setRestoreFile(selected);
    } catch {
      setBackupMessage({ tone: "error", text: "Unable to open the file picker." });
    }
  };

  const confirmRestore = async () => {
    if (!restoreFile) return;
    const file = restoreFile;
    setRestoreFile(null);
    setRestoreBusy(true);
    setBackupMessage(null);
    const response = await requestDatabaseRestore(file);
    setRestoreBusy(false);
    // A scheduled restore closes the app, so it stays on the page rather than in a toast.
    if (response.success) setBackupMessage({ tone: "success", text: response.message });
    else setBackupMessage({ tone: "error", text: response.error.message });
  };

  const dismissRestoreNotice = async () => {
    setDismissingRestore(true);
    const response = await dismissRestoreFailure();
    setDismissingRestore(false);
    if (response.success) {
      void infoList.refresh();
      showResult({ tone: "success", text: "Restore notice dismissed. Your current data was left untouched." }, setBackupMessage);
    } else {
      setBackupMessage({ tone: "error", text: response.error.message });
    }
  };

  const openBackups = async () => {
    const outcome = await openDatabaseBackupsFolder();
    if (!outcome.ok) setBackupMessage({ tone: "error", text: outcome.message });
  };

  const downloadBackup = async (filePath: string, fileName: string) => {
    setBackupMessage(null);
    const outcome = await saveBackupCopy(filePath, fileName);
    if (outcome === null) return;
    if (outcome.ok) showToast(outcome.message);
    else setBackupMessage({ tone: "error", text: outcome.message });
  };

  const formatSize = (bytes: number) =>
    bytes > 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const formatWhen = (value: string | null) => (value ? formatDateTime(value) : "—");

  // One fold per calendar month, newest first. The desktop app lists backups by file name (every "pre-restore-" snapshot
  // before the "attendance-backup-" files), not by date, so they are sorted here: newest first, undated ones last.
  const backupMonths: { label: string; backups: DatabaseInfoResponse["backups"] }[] = [];
  const backupsByDate = [...(info?.backups ?? [])].sort((a, b) => (Date.parse(b.modifiedAt ?? "") || 0) - (Date.parse(a.modifiedAt ?? "") || 0));
  for (const backup of backupsByDate) {
    const date = backup.modifiedAt ? new Date(backup.modifiedAt) : null;
    const label = date && !Number.isNaN(date.getTime()) ? formatMonth(date) : "Unknown date";
    const month = backupMonths.find((group) => group.label === label);
    if (month) month.backups.push(backup);
    else backupMonths.push({ label, backups: [backup] });
  }

  const sheets = sheetsStatus(syncState, syncHealth, dtrSyncEnabled);
  const dtr = syncHealth?.dtr;
  const progressPercent = dtrProgress && dtrProgress.total > 0 ? Math.min(100, Math.round((dtrProgress.current / dtrProgress.total) * 100)) : 0;

  return (
    <section className="lan-panel db-panel" aria-label="Database and backup">
      {/* Backups first: how fresh the newest one is, the three backup buttons, then the months and the guide. */}
      <section className="db-section" aria-labelledby="db-backups-heading">
        <h2 id="db-backups-heading">Backups</h2>
        {info && <LastBackupLine backups={info.backups} now={new Date()} />}
        {info?.restorePending && (
          <p className="db-restore-waiting" role="status">A restore is waiting. Close and reopen the app to finish it.</p>
        )}
        {info?.restoreFailed && (() => {
          const failure = describeRestoreFailure(info.restoreFailed ?? "");
          return (
            <div className="warning-banner" role="alert">
              <ShieldAlert size={20} />
              <div>
                <strong>Restore didn&apos;t go through — your current data is safe</strong>
                <p>{failure.friendly}</p>
                {failure.sourceFile && (
                  <p>Backup file: <code>{failure.sourceFile}</code></p>
                )}
                <p>Your current database was kept — nothing was replaced and no attendance data was lost.</p>
                <p>What to do next: pick the correct <code>attendance-backup-*.apbackup</code> file and choose Restore again, or dismiss this notice if you no longer need the restore.</p>
                <details>
                  <summary>Technical details (for support)</summary>
                  <code>{info.restoreFailed}</code>
                </details>
                <div className="lan-actions" style={{ marginTop: 8 }}>
                  <button
                    className="admin-button file-action-primary"
                    type="button"
                    disabled={backupBusy || dismissingRestore}
                    onClick={() => void restore()}
                  >
                    Try again…
                  </button>
                  <button
                    className="admin-button"
                    type="button"
                    disabled={backupBusy || dismissingRestore}
                    onClick={() => void dismissRestoreNotice()}
                  >
                    {dismissingRestore ? "Dismissing…" : "Dismiss"}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
        <div className="db-action-group">
          <button
            className="admin-button file-action-primary"
            type="button"
            disabled={backupBusy}
            onClick={() => void createBackup()}
          >
            {backupRunning ? "Saving backup…" : "Create backup now"}
          </button>
          <button
            className="admin-button"
            type="button"
            disabled={backupBusy}
            onClick={() => void restore()}
          >
            Restore from backup file…
          </button>
          <button
            className="admin-button"
            type="button"
            onClick={() => void openBackups()}
          >
            Open backups folder
          </button>
        </div>
        <NoticeLine notice={backupMessage} />
        {infoList.status === "loading" && <p className="load-pending">Loading backups…</p>}
        {/* In a browser the backup tools are not there at all, so that is a calm note with no Retry. */}
        {infoList.status === "failed" &&
          ("__TAURI_INTERNALS__" in window ? (
            <LoadFailed what="the backup list" reason={infoList.error} onRetry={() => void infoList.reload()} />
          ) : (
            <NoticeLine notice={{ tone: "info", text: infoList.error ?? "Backups are available in the desktop application." }} />
          ))}
        {info && info.backups.length > 0 && (
          <details className="db-backup-list" open>
            <summary>
              Existing backups <span className="db-backup-count">{info.backups.length}</span>
            </summary>
            <div className="db-backup-months">
              {backupMonths.map((month) => (
                <details key={month.label} className="db-backup-month">
                  <summary>
                    {month.label} <span className="db-backup-count">{month.backups.length}</span>
                  </summary>
                  <ul>
                    {month.backups.map((backup) => (
                      <li key={backup.filePath}>
                        {/* The date leads; the file name is for finding it in the folder. */}
                        <span className="db-backup-when">{formatWhen(backup.modifiedAt)}</span>
                        <code>{backup.fileName}</code>
                        <span>{formatSize(backup.sizeBytes)}</span>
                        <div className="db-backup-actions">
                          <button
                            className="admin-button"
                            type="button"
                            disabled={backupBusy}
                            onClick={() => setRestoreFile(backup.filePath)}
                          >
                            <History size={14} aria-hidden="true" /> Restore
                          </button>
                          <button
                            className="admin-button"
                            type="button"
                            disabled={backupBusy}
                            onClick={() => void downloadBackup(backup.filePath, backup.fileName)}
                          >
                            <Download size={14} aria-hidden="true" /> Download
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
            </div>
          </details>
        )}
        <button className="text-button db-guide-link" type="button" onClick={() => setGuideOpen(true)}>
          <BookOpen size={14} aria-hidden="true" /> How to move to a new PC
        </button>
      </section>

      {/* Google Sheets (intern DTR upload): one status in plain words beside the heading, one Sync now and the
          on/off for this PC; queue numbers and retry details only under "Details for support". */}
      <section className="db-section" aria-labelledby="db-sheets-heading">
        <div className="db-section-head">
          <h2 id="db-sheets-heading">Google Sheets</h2>
          <span className={`sheets-status is-${sheets.tone}`} role="status">
            <i aria-hidden="true" />
            {sheets.text}
          </span>
        </div>
        <div className="db-action-group">
          <button
            className="admin-button"
            type="button"
            data-testid="dtr-sync-now"
            disabled={syncBusy || dtrSyncActive || dtrSyncEnabled === false}
            onClick={() => void syncInterns()}
          >
            <RefreshCcw size={14} aria-hidden="true" /> Sync now
          </button>
          <label className="voice-toggle-label">
            <input
              type="checkbox"
              checked={dtrSyncEnabled ?? true}
              disabled={dtrSyncEnabled === null || dtrToggleBusy || syncBusy}
              onChange={() => void toggleDtrSync()}
            />
            <span>Upload attendance to Google Sheets from this PC</span>
          </label>
        </div>
        {/* Off: Sync now waits too, and this says why. */}
        {dtrSyncEnabled === false && <p className="reset-hint">{UPLOAD_OFF_TEXT}</p>}
        {syncState.kind === "syncing" && (
          <div
            className="sync-progress-wrap"
            role="progressbar"
            aria-valuenow={progressPercent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Intern DTR sync progress"
          >
            <div className="sync-progress-status">
              <strong>
                {dtrProgress && dtrProgress.total > 0
                  ? `Uploading ${dtrProgress.status === "starting" ? 0 : dtrProgress.current} of ${dtrProgress.total}…`
                  : "Starting the upload…"}
              </strong>
              <span>{dtrProgress && dtrProgress.total > 0 ? `${progressPercent}%` : "…"}</span>
            </div>
            <div className="sync-progress-bar">
              <div className="sync-progress-fill" style={{ width: `${progressPercent}%` }} />
            </div>
          </div>
        )}
        {stoppedDtrSync && (
          <p className="load-failed" role="status">
            Stopped at {stoppedDtrSync.tab}{" "}
            <button
              className="text-button"
              type="button"
              disabled={syncBusy || dtrSyncActive || dtrSyncEnabled === false || stoppedDtrSync.userId === null}
              onClick={() => {
                if (stoppedDtrSync.userId !== null) void syncInterns(stoppedDtrSync.userId);
              }}
            >
              Retry
            </button>
          </p>
        )}
        <NoticeLine notice={syncMessage} />
        {syncState.kind === "error" && <p className="sync-health-note">{syncState.message}</p>}
        {syncState.kind === "stale" && (
          <p className="sync-health-note">Couldn&apos;t refresh the status, showing the last known one ({syncState.message}).</p>
        )}
        {syncHealth && (
          <details className="tech-details">
            <summary>Details for support</summary>
            <dl>
              {dtr && (
                <div>
                  <dt>Intern DTR records</dt>
                  <dd>
                    {`${dtr.queued} queued · ${dtr.retrying} retrying · ${dtr.processing} uploading · ${dtr.retryablePending} waiting for a tab · ${dtr.dead} failed · ${dtr.needsAttention} need an administrator`}
                  </dd>
                </div>
              )}
              {syncHealth.byTable.map((row) => (
                <div key={row.tableName}>
                  <dt><code>{row.tableName}</code></dt>
                  <dd>{row.pending > 0 ? `${row.pending} pending` : "OK"}</dd>
                </div>
              ))}
              <div>
                <dt><code>InternDtr tabs</code></dt>
                <dd>{syncHealth.dtrPendingCount > 0 ? `${syncHealth.dtrPendingCount} pending` : "OK"}</dd>
              </div>
              {syncHealth.dtrPendingItems.length > 0 && (
                <div>
                  <dt>Waiting for a tab</dt>
                  <dd>
                    {syncHealth.dtrPendingItems.slice(0, 5).map((person) => person.fullName).join(", ")}
                    {syncHealth.dtrPendingCount > 5 ? ` (+${syncHealth.dtrPendingCount - 5} more)` : ""}
                  </dd>
                </div>
              )}
              {syncHealth.throttledUntil && (
                <div>
                  <dt>Throttled until</dt>
                  <dd>
                    {formatWhen(syncHealth.throttledUntil)}
                    {syncHealth.lastThrottleReason ? ` — ${syncHealth.lastThrottleReason}` : ""}
                  </dd>
                </div>
              )}
              {syncHealth.inProgress && (
                <div>
                  <dt>Sync in progress</dt>
                  <dd>{`${syncHealth.inProgress.owner} since ${formatWhen(syncHealth.inProgress.startedAt)}`}</dd>
                </div>
              )}
              {syncHealth.leaseRecovered > 0 && (
                <div>
                  <dt>Lease recovered</dt>
                  <dd>{syncHealth.leaseRecovered}</dd>
                </div>
              )}
              {syncHealth.oldestRetryableAgeSec !== null && (
                <div>
                  <dt>Oldest retryable</dt>
                  <dd>
                    {`${formatDuration(syncHealth.oldestRetryableAgeSec)} old`}
                    {syncHealth.pendingAgeAlert ? " — over 6h, queue needs attention" : ""}
                  </dd>
                </div>
              )}
              <div>
                <dt>Last sync</dt>
                <dd>{formatWhen(syncHealth.lastSyncedAt)}</dd>
              </div>
            </dl>
          </details>
        )}
      </section>
      {guideOpen && (
        <div className="confirm-backdrop" role="presentation">
          <section ref={guideRef} className="confirm-dialog db-guide-dialog" role="dialog" aria-modal="true" aria-labelledby="db-guide-heading">
            <BookOpen size={22} aria-hidden="true" />
            <h2 id="db-guide-heading">Moving to the new front-desk PC</h2>
            <p>Three steps, and nothing is lost:</p>
            <ol className="db-steps">
              <li>
                On the <strong>old PC</strong>: open Admin → Data and backup and
                press <strong>Create backup now</strong>. The app saves a complete
                copy of all attendance data (safe even while the app is running)
                and keeps the newest 10.
              </li>
              <li>
                Copy the <code>attendance-backup-*.apbackup</code> file to a USB drive (or
                the office network) — <strong>Download</strong> next to it under Existing
                backups saves a copy wherever you choose — and plug it into the{" "}
                <strong>new PC</strong>.
              </li>
              <li>
                On the <strong>new PC</strong>: open Admin → Data and backup, press{" "}
                <strong>Restore from backup file…</strong>, select the copied file,
                and confirm. The app closes, restores the database on the next
                launch, and starts with all users, attendance, payroll, and settings
                intact.
              </li>
            </ol>
            <p>
              A backup is also made automatically every time the app closes
              normally. If the new PC already has data, restoring replaces it, but
              that data is saved in the backups folder first, so a restore can
              always be undone.
            </p>
            <div className="confirm-actions">
              <button className="submit-button" type="button" onClick={() => setGuideOpen(false)}>
                <Check size={16} /> Got it
              </button>
            </div>
          </section>
        </div>
      )}
      <ConfirmDialog
        open={Boolean(restoreFile)}
        busy={restoreBusy}
        tone="danger"
        title="Restore database from backup?"
        message="The app will close and restore the database from the selected file on the next launch. Any data on this device will be replaced."
        confirmLabel="Restore database"
        onCancel={() => setRestoreFile(null)}
        onConfirm={() => void confirmRestore()}
      />
    </section>
  );
}
