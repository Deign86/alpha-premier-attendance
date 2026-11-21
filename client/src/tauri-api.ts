import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { save as saveFileDialog } from '@tauri-apps/plugin-dialog';
import type { CodedOutcome, CutoffSaved, Outcome, Transport, Unlocked } from './transport';
import type { AdminAttendanceResponse, AdminUsersResponse, AttendanceListItem, AttendanceListResponse, InternPayrollReportResponse, PayrollCutoffsResponse, PayrollProfilesResponse, SetupErrorResponse, SetupLookupResponse, SetupUpsertResponse, AdminSyncDtrResponse, AttendanceXlsxExportResponse, BathroomActionResponse, BathroomScanResponse, BathroomStatusResponse, BathroomUpdateRequest, DatabaseBackupResponse, DatabaseInfoResponse, InternPayslipImage, InternPayslipSaveResponse, InternPayslipsResponse, LanStatusResponse, PayrollPdfGenerateResponse, PayrollPdfListResponse, ScanRequest, ScanResponse, SafeConfigResponse, ScannerStatus, TtsSpeakOptions, TtsSpeakResult, TtsStatusResponse, VoiceClipState, IdRegisterStatus, VoiceStudioConnection, VoiceWorkerStatus } from '@rfid-attendance/shared';

export interface NativeHealthResponse {
  success: boolean;
  service: string;
  timestamp: string;
  timezone: string;
  sqlite: string;
  lanEnabled: boolean;
  lan: { bindAddress: string | null; port: number; connectedSseClients: number };
  googleSheetsExport: string;
}

export interface NativeSyncTableStatus {
  tableName: string;
  pending: number;
}

export interface NativeDtrPendingItem {
  userId: string;
  fullName: string;
  attempts: number;
  lastChecked: string | null;
}

export interface NativeSyncInProgress {
  owner: string;
  startedAt: string;
}

export interface NativeSyncStatusResponse {
  success: boolean;
  pending: number;
  deadLetter: number;
  byTable?: NativeSyncTableStatus[] | null;
  dtrPending?: { count: number; items: NativeDtrPendingItem[] } | null;
  lastSyncedAt?: string | null;
  lastError?: string | null;
  throttledUntil?: string | null;
  lastThrottleReason?: string | null;
  inProgress?: NativeSyncInProgress | null;
  leaseRecovered?: number | null;
  oldestRetryableAgeSec?: number | null;
  pendingAgeAlert?: boolean | null;
  dtr?: {
    enabled: boolean;
    queued: number;
    retrying: number;
    processing: number;
    dead: number;
    retryablePending: number;
    needsAttention: number;
    persistenceFailure: boolean;
    nextRetryEligibleAt: string | null;
    oldestOutstandingAgeSec: number | null;
    currentIssue: 'none' | 'transport' | 'auth_config' | 'quota' | 'unresolved_layout' | 'persistence';
    currentIssueSince: string | null;
    lastSuccessfulWriteAt: string | null;
    activity: 'idle' | 'queued' | 'syncing' | 'throttled' | 'retrying' | 'disabled' | 'offline' | 'unavailable';
    emittedAt: string;
  } | null;
}

/**
 * The desktop transport: `Transport` (see `transport.ts`) answered by the Rust commands. `http-api.ts` implements
 * the same interface against the legacy Node server for browser development, and `transport.ts` picks one of the two.
 */
export const tauriApi: Transport = {
  getConfig: () => invoke<SafeConfigResponse>('get_config'),
  getHealth: () => invoke<NativeHealthResponse>('get_health'),
  generatePayrollPdf: (token: string, cutoffStart: string, cutoffEnd: string, payrollCutoffLabel: string, workerType: string) => invoke<PayrollPdfGenerateResponse>('generate_payroll_pdf', { token, cutoffStart, cutoffEnd, payrollCutoffLabel, workerType }),
  listPayrollPdfs: (token: string) => invoke<PayrollPdfListResponse>('list_payroll_pdfs', { token }),
  internPayslips: (token: string, cutoffStart: string, cutoffEnd: string) => invoke<InternPayslipsResponse>('payroll_intern_payslips', { token, cutoffStart, cutoffEnd }),
  saveInternPayslipImages: (token: string, payrollCutoffLabel: string, images: InternPayslipImage[]) => invoke<InternPayslipSaveResponse>('save_intern_payslip_images', { token, payrollCutoffLabel, images }),
  getAttendance: (date?: string) => invoke<AttendanceListResponse>('get_attendance', { date }),
  bathroomGetStatus: (token?: string, date?: string) => invoke<BathroomStatusResponse>('bathroom_get_status', { token, date }),
  bathroomScanRfid: (rfidUid: string) => invoke<BathroomScanResponse>('bathroom_scan_rfid', { rfidUid }),
  bathroomTimeOut: (token: string, userId: string, genderKey: 'MALE' | 'FEMALE', notes?: string) => invoke<BathroomActionResponse>('bathroom_time_out', { token, userId, genderKey, notes }),
  bathroomTimeIn: (token: string, logId: string, notes?: string) => invoke<BathroomActionResponse>('bathroom_time_in', { token, logId, notes }),
  bathroomUpdateLog: (token: string, logId: string, request: BathroomUpdateRequest) => invoke<BathroomActionResponse>('bathroom_update_log', { token, logId, request }),
  lanStatus: () => invoke<LanStatusResponse>('lan_status'),
  lanStart: () => invoke<LanStatusResponse>('lan_start'),
  lanStop: () => invoke<LanStatusResponse>('lan_stop'),
  openViewerUrl: (url: string) => invoke<void>('open_viewer_url', { url }),
  scanRfid: (request: ScanRequest) => invoke<ScanResponse>('scan_rfid', { request }),
  /** The command's argument is still named `pin` on the wire; it carries a card ID or the code IT set. */
  setupUnlock: (cardOrCode: string) => invoke<Unlocked | SetupErrorResponse>('setup_unlock', { pin: cardOrCode }),
  setupLock: () => invoke<{ success: true }>('setup_lock'),
  /** The Admin panel's unlock and lock. On the desktop they are the setup commands; the legacy server has its own routes. */
  adminUnlock: (cardOrCode: string): Promise<Unlocked | { success: false; error: { message: string } }> => tauriApi.setupUnlock(cardOrCode),
  adminLock: (): Promise<{ success: true }> => tauriApi.setupLock(),
  adminAccountUnlock: (email: string, password: string) => invoke<{ success: true; token: string; expiresAt: string; name: string }>('admin_account_unlock', { email, password }),
  adminAccountReset: (email: string) => invoke<{ success: true }>('admin_account_reset', { email }),
  setupLookupCard: (token: string, rfidUid: string) => invoke<SetupLookupResponse | SetupErrorResponse>('setup_lookup_card', { token, rfidUid }),
  setupUpsertUser: <T extends object>(token: string, user: T) => invoke<SetupUpsertResponse | SetupErrorResponse>('setup_upsert_user', { token, user }),
  /** Rejects without asking when there is no token: no token, no session. */
  adminGetSession: (token: string) => (token ? invoke<{ success: true; expiresAt?: string }>('admin_get_session', { token }) : Promise.reject<{ success: true; expiresAt?: string }>('ADMIN_SESSION_EXPIRED')),
  adminUsers: (token: string) => invoke<AdminUsersResponse>('admin_users', { token }),
  adminUpsertUser: <T extends object>(token: string, user: T) => invoke<Outcome>('admin_upsert_user', { token, user }),
  adminDeleteUser: (token: string, userId: string) => invoke<Outcome>('admin_delete_user', { token, userId }),
  adminAttendance: (token: string, date: string) => invoke<AdminAttendanceResponse>('admin_attendance', { token, date }),
  adminUpdateAttendance: <T extends object>(token: string, attendanceId: string, payload: T) => invoke<CodedOutcome>('admin_update_attendance', { token, attendanceId, payload }),
  adminCreateBackdatedAttendance: <T extends object>(token: string, payload: T) => invoke<{ success: boolean; attendance?: AttendanceListItem; error?: { code?: string; message?: string } }>('admin_create_backdated_attendance', { token, payload }),
  adminDeleteAttendance: (token: string, attendanceId: string, date: string) => invoke<Outcome>('admin_delete_attendance', { token, attendanceId, date }),
  payrollProfiles: (token: string) => invoke<PayrollProfilesResponse>('payroll_list_profiles', { token }),
  payrollUpsertProfile: <T extends object>(token: string, profile: T) => invoke<{ success: boolean }>('payroll_upsert_profile', { token, profile }),
  payrollDeleteProfile: (token: string, profileId: string) => invoke<Outcome>('payroll_delete_profile', { token, profileId }),
  payrollCutoffs: (token: string) => invoke<PayrollCutoffsResponse>('payroll_list_cutoffs', { token }),
  internPayrollReport: (token: string, cutoffStart: string, cutoffEnd: string, payrollCutoffLabel: string) =>
    invoke<InternPayrollReportResponse>('payroll_intern_report', { token, cutoffStart, cutoffEnd, payrollCutoffLabel }),
  payrollGenerateCutoff: <T extends object>(token: string, cutoffStart: string, cutoffEnd: string, payrollCutoffLabel: string, customization: T) => invoke<{ success: boolean; generated?: number; warnings?: string[]; error?: { message: string } }>('payroll_generate_cutoff', { token, cutoffStart, cutoffEnd, payrollCutoffLabel, customization }),
  payrollCreateCutoff: <T extends object>(token: string, input: T) => invoke<CutoffSaved>('payroll_create_cutoff', { token, input }),
  payrollUpdateCutoff: <T extends object>(token: string, input: T) => invoke<CutoffSaved>('payroll_update_cutoff', { token, input }),
  payrollFinalizeCutoff: (token: string, payrollId: string) => invoke<Outcome>('payroll_finalize_cutoff', { token, payrollId }),
  payrollDeleteCutoff: (token: string, payrollId: string) => invoke<Outcome>('payroll_delete_cutoff', { token, payrollId }),
  exportAttendanceXlsx: (token: string, date: string) => invoke<AttendanceXlsxExportResponse>('export_attendance_xlsx', { token, date }),
  openGeneratedFile: (token: string, filePath: string) => invoke<{ success: true; message: string }>('open_generated_file', { token, filePath }),
  revealGeneratedFile: (token: string, filePath: string) => invoke<{ success: true; message: string }>('reveal_generated_file', { token, filePath }),
  openGeneratedDirectory: (token: string, directoryPath: string) => invoke<{ success: true; message: string }>('open_generated_directory', { token, directoryPath }),
  syncStatus: (token: string) => invoke<NativeSyncStatusResponse>('admin_get_sync_status', { token }),
  syncInternDtr: (token: string, userId?: string, startFromUserId?: string) => invoke<ManualSyncReport>('admin_sync_intern_dtr', { token, userId, startFromUserId }),
  getInternDtrSync: (token: string) => invoke<{ success: true; enabled: boolean }>('admin_get_intern_dtr_sync', { token }),
  setInternDtrSync: (token: string, enabled: boolean) => invoke<{ success: true; enabled: boolean }>('admin_set_intern_dtr_sync', { token, enabled }),
  sheetsNukeResync: (token: string, confirm: boolean) => invoke<Outcome>('admin_sheets_nuke_resync', { token, confirm }),
  uploadPhoto: (token: string, userId: string, base64Data: string) => invoke<{ success: true; photoUrl: string } | SetupErrorResponse>('upload_photo', { token, userId, base64Data }),
  dbInfo: () => invoke<DatabaseInfoResponse>('db_info'),
  dbBackup: (token: string) => invoke<DatabaseBackupResponse>('db_backup', { token }),
  dbRestoreRequest: (token: string, sourcePath: string) => invoke<{ success: true; message: string }>('db_restore_request', { token, sourcePath }),
  dbDismissRestoreFailure: (token: string) => invoke<{ success: true; message: string }>('db_dismiss_restore_failure', { token }),
  dbOpenBackupsDir: (token: string) => invoke<{ success: true; message: string }>('db_open_backups_dir', { token }),
  dbSaveBackupCopy: (token: string, sourcePath: string, destinationPath: string) => invoke<{ success: true; message: string }>('db_save_backup_copy', { token, sourcePath, destinationPath }),
  ttsSpeak: (text: string, options?: TtsSpeakOptions) => invoke<TtsSpeakResult>('tts_speak', { text, options }),
  ttsStop: () => invoke<void>('tts_stop'),
  ttsStatus: () => invoke<TtsStatusResponse>('tts_status'),
  getVoicestudioHost: (token: string) => invoke<string>('get_voicestudio_host', { token }),
  setVoicestudioHost: (token: string, host: string) => invoke<string>('set_voicestudio_host', { token, host }),
  getVoicestudioPin: (token: string) => invoke<string>('get_voicestudio_pin', { token }),
  setVoicestudioPin: (token: string, pin: string) => invoke<void>('set_voicestudio_pin', { token, pin }),
  checkVoicestudio: (token: string, host?: string, pin?: string) => invoke<VoiceStudioConnection>('check_voicestudio', { token, host, pin }),
  voiceClipStates: () => invoke<VoiceClipState[]>('voice_clip_states'),
  voiceWorkerStatus: () => invoke<VoiceWorkerStatus>('voice_worker_status'),
  voiceRegenerate: (token: string, personId: string) => invoke<string>('voice_regenerate', { token, personId }),
  voiceNameAudioUrl: (personId: string) => invoke<string | null>('voice_name_audio_url', { personId }),
  idRegisterStatus: (token: string) => invoke<IdRegisterStatus>('id_register_status', { token }),
  idRegisterSignIn: (token: string, email: string, password: string) => invoke<IdRegisterStatus>('id_register_sign_in', { token, email, password }),
  idRegisterSignOut: (token: string) => invoke<IdRegisterStatus>('id_register_sign_out', { token }),
  idRegisterCheck: (token: string) => invoke<IdRegisterStatus>('id_register_check', { token }),
  autostartStatus: () => invoke<boolean>('autostart_status'),
  autostartSet: (enabled: boolean) => invoke<boolean>('autostart_set', { enabled }),
  /** Asks where to save a copy of a backup (e.g. a USB drive); null when the dialog is cancelled. */
  pickBackupDestination: (fileName: string) => saveFileDialog({ defaultPath: fileName, filters: [{ name: 'Alpha Premier portable backup', extensions: ['apbackup', 'db'] }] }),
};

export const notifyScanSuccess = (name: string) => invoke<void>('notify_scan_success', { fullName: name });

/** Native scanner status changes (`scanner-status` events). */
export const listenForScannerStatus = (handler: (status: ScannerStatus) => void) =>
  listen<ScannerStatus>('scanner-status', (event) => handler(event.payload));

/** Snapshot the current native scanner status (fallback for the initial render). */
export const getScannerStatus = () => invoke<ScannerStatus>('scanner_status');

/**
 * Pause/resume the native scanner listener while the operator types (admin,
 * setup, manual entry) so keystrokes are never misread as card scans.
 */
export const setScannerPaused = (paused: boolean) => invoke<void>('scanner_pause', { paused });

export const listenForAttendanceUpdates = (handler: (payload: { attendanceId: string; attendanceDate: string; action: string }) => void) =>
  listen<{ attendanceId: string; attendanceDate: string; action: string }>('attendance-updated', (event) => handler(event.payload));

export type DtrSyncSource = "queue" | "manual";

/** Exactly what `dtr_sync.rs` emits; a sync always ends with "completed". */
export type DtrSyncProgressStatus = "starting" | "syncing" | "completed";

export interface DtrSyncProgress {
  current: number;
  total: number;
  userId: string;
  fullName: string;
  status: DtrSyncProgressStatus;
  source?: DtrSyncSource;
}

export type ManualSyncReport = AdminSyncDtrResponse & {
  stoppedTab?: string | null;
  stoppedUserId?: string | null;
};

export interface DtrSyncHealthEvent {
  activity: 'idle' | 'queued' | 'syncing' | 'throttled' | 'retrying' | 'disabled' | 'offline' | 'unavailable';
  queued: number;
  retryablePending: number;
  needsAttention: number;
  dead: number;
  persistenceFailure: boolean;
  emittedAt: string;
}

export const listenForDtrSyncProgress = (handler: (payload: DtrSyncProgress) => void) =>
  listen<DtrSyncProgress>('dtr-sync-progress', (event) => handler(event.payload));

/** Listen for the counts-only kiosk DTR health event. */
export const listenForDtrSyncHealth = (handler: (payload: DtrSyncHealthEvent) => void) =>
  listen<DtrSyncHealthEvent>('dtr-sync-health', (event) => handler(event.payload));

/** Listen for tray menu "Check for updates…" trigger. */
export const listenForCheckForUpdates = async (handler: () => void): Promise<() => void> => {
  if (globalThis.window === undefined || !('__TAURI_INTERNALS__' in globalThis.window)) {
    return () => {};
  }
  const globalUnlisten = await listen<void>('check-for-updates', () => handler());
  let winUnlisten: (() => void) | undefined;
  try {
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    winUnlisten = await getCurrentWebviewWindow().listen<void>('check-for-updates', () => handler());
  } catch {
    // Ignore webview window listener setup failure in mock/test environments
  }
  return () => {
    globalUnlisten();
    if (winUnlisten) winUnlisten();
  };
};

/**
 * Cleanup for a native listener that attaches asynchronously. With
 * `listen().then(fn => unlisten = fn)`, a cleanup that ran before the listener
 * attached (StrictMode remounts, quick re-subscribes) leaked it; here it is
 * detached the moment it arrives.
 */
export function detachWhenDone(attaching: Promise<() => void>): () => void {
  let detach: (() => void) | undefined;
  let disposed = false;
  attaching
    .then((fn) => {
      if (disposed) fn();
      else detach = fn;
    })
    .catch(() => {
      /* web mode: no desktop layer to listen to */
    });
  return () => {
    disposed = true;
    detach?.();
  };
}
