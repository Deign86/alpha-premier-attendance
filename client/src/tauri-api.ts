import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { ArtifactExportResponse, AttendanceXlsxExportResponse, BathroomActionResponse, BathroomScanResponse, BathroomStatusResponse, DatabaseBackupResponse, DatabaseInfoResponse, LanStatusResponse, PayrollCsvExportResponse, PayrollPdfGenerateResponse, PayrollPdfListResponse, ScanRequest, ScanResponse, SafeConfigResponse, ScannerStatus, TtsSpeakOptions, TtsSpeakResult, TtsStatusResponse } from '@rfid-attendance/shared';

export interface HealthStatusResponse {
  status: string;
  uptimeSeconds?: number;
  timestamp?: string;
}

/** Native command bridge. The existing HTTP API remains available during cutover. */
export const tauriApi = {
  getConfig: () => invoke<SafeConfigResponse>('get_config'),
  getHealth: () => invoke<HealthStatusResponse>('get_health'),
  generatePayrollPdf: (token: string, cutoffStart: string, cutoffEnd: string, payrollCutoffLabel: string, workerType: string) => invoke<PayrollPdfGenerateResponse>('generate_payroll_pdf', { token, cutoffStart, cutoffEnd, payrollCutoffLabel, workerType }),
  listPayrollPdfs: (token: string) => invoke<PayrollPdfListResponse>('list_payroll_pdfs', { token }),
  getAttendance: (date?: string) => invoke('get_attendance', { date }),
  bathroomGetStatus: (token?: string, date?: string) => invoke<BathroomStatusResponse>('bathroom_get_status', { token, date }),
  bathroomScanRfid: (rfidUid: string) => invoke<BathroomScanResponse>('bathroom_scan_rfid', { rfidUid }),
  bathroomTimeOut: (token: string, userId: string, genderKey: 'MALE' | 'FEMALE', notes?: string) => invoke<BathroomActionResponse>('bathroom_time_out', { token, userId, genderKey, notes }),
  bathroomTimeIn: (token: string, logId: string, notes?: string) => invoke<BathroomActionResponse>('bathroom_time_in', { token, logId, notes }),
  lanStatus: () => invoke<LanStatusResponse>('lan_status'),
  lanStart: () => invoke<LanStatusResponse>('lan_start'),
  lanStop: () => invoke<LanStatusResponse>('lan_stop'),
  openViewerUrl: (url: string) => invoke<void>('open_viewer_url', { url }),
  scanRfid: (request: ScanRequest) => invoke<ScanResponse>('scan_rfid', { request }),
  setupUnlock: (pin: string) => invoke<{ success: true; token: string; expiresAt: string }>('setup_unlock', { pin }),
  setupLock: () => invoke<{ success: true }>('setup_lock'),
  setupLookupCard: (token: string, rfidUid: string) => invoke('setup_lookup_card', { token, rfidUid }),
  setupUpsertUser: <T extends object>(token: string, user: T) => invoke('setup_upsert_user', { token, user }),
  adminGetSession: (token: string) => invoke('admin_get_session', { token }),
  adminUsers: (token: string) => invoke<{ success: true; users: unknown[] }>('admin_users', { token }),
  adminListUsers: (token: string) => invoke<{ success: true; users: unknown[] }>('admin_list_users', { token }),
  adminUpsertUser: <T extends object>(token: string, user: T) => invoke('admin_upsert_user', { token, user }),
  adminDeleteUser: (token: string, userId: string) => invoke('admin_delete_user', { token, userId }),
  adminAttendance: (token: string, date: string) => invoke('admin_attendance', { token, date }),
  adminListAttendance: (token: string, date: string) => invoke('admin_list_attendance', { token, date }),
  adminUpdateAttendance: <T extends object>(token: string, attendanceId: string, payload: T) => invoke('admin_update_attendance', { token, attendanceId, payload }),
  adminCreateBackdatedAttendance: <T extends object>(token: string, payload: T) => invoke('admin_create_backdated_attendance', { token, payload }),
  adminDeleteAttendance: (token: string, attendanceId: string, date: string) => invoke('admin_delete_attendance', { token, attendanceId, date }),
  payrollProfiles: (token: string) => invoke('payroll_list_profiles', { token }),
  payrollUpsertProfile: <T extends object>(token: string, profile: T) => invoke('payroll_upsert_profile', { token, profile }),
  payrollCutoffs: (token: string) => invoke('payroll_list_cutoffs', { token }),
  internPayrollReport: (token: string, cutoffStart: string, cutoffEnd: string, payrollCutoffLabel: string) =>
    invoke('payroll_intern_report', { token, cutoffStart, cutoffEnd, payrollCutoffLabel }),
  payrollGenerateCutoff: <T extends object>(token: string, cutoffStart: string, cutoffEnd: string, payrollCutoffLabel: string, customization: T) => invoke('payroll_generate_cutoff', { token, cutoffStart, cutoffEnd, payrollCutoffLabel, customization }),
  payrollCreateCutoff: <T extends object>(token: string, input: T) => invoke('payroll_create_cutoff', { token, input }),
  payrollUpdateCutoff: <T extends object>(token: string, input: T) => invoke('payroll_update_cutoff', { token, input }),
  payrollFinalizeCutoff: (token: string, payrollId: string) => invoke('payroll_finalize_cutoff', { token, payrollId }),
  payrollDeleteCutoff: (token: string, payrollId: string) => invoke('payroll_delete_cutoff', { token, payrollId }),
  payrollExportCsv: (token: string) => invoke<PayrollCsvExportResponse>('payroll_export_csv', { token }),
  exportAttendanceXlsx: (token: string, date: string) => invoke<AttendanceXlsxExportResponse>('export_attendance_xlsx', { token, date }),
  exportPayrollXlsx: (token: string, cutoff?: string) => invoke<ArtifactExportResponse>('export_payroll_xlsx', { token, cutoff }),
  generatePayrollPayslipPdf: (token: string, payrollId: string) => invoke<ArtifactExportResponse>('generate_payroll_payslip_pdf', { token, payrollId }),
  generatePayrollRegisterPdf: (token: string, cutoff?: string) => invoke<ArtifactExportResponse>('generate_payroll_register_pdf', { token, cutoff }),
  openGeneratedFile: (token: string, filePath: string) => invoke<{ success: true; message: string }>('open_generated_file', { token, filePath }),
  revealGeneratedFile: (token: string, filePath: string) => invoke<{ success: true; message: string }>('reveal_generated_file', { token, filePath }),
  openGeneratedDirectory: (token: string, directoryPath: string) => invoke<{ success: true; message: string }>('open_generated_directory', { token, directoryPath }),
  openGeneratedArtifact: (token: string, artifactId: string) => invoke<{ success: true; artifactId: string }>('open_generated_artifact', { token, artifactId }),
  syncStatus: (token: string) => invoke('admin_get_sync_status', { token }),
  syncNow: (token: string) => invoke('admin_sync_now', { token }),
  sheetsNukeResync: (token: string, confirm: boolean) => invoke('admin_sheets_nuke_resync', { token, confirm }),
  uploadPhoto: (token: string, userId: string, base64Data: string) => invoke<{ success: true; photoUrl: string }>('upload_photo', { token, userId, base64Data }),
  dbInfo: () => invoke<DatabaseInfoResponse>('db_info'),
  dbBackup: (token: string) => invoke<DatabaseBackupResponse>('db_backup', { token }),
  dbRestoreRequest: (token: string, sourcePath: string) => invoke<{ success: true; message: string }>('db_restore_request', { token, sourcePath }),
  dbOpenBackupsDir: (token: string) => invoke<{ success: true; message: string }>('db_open_backups_dir', { token }),
  ttsSpeak: (text: string, options?: TtsSpeakOptions) => invoke<TtsSpeakResult>('tts_speak', { text, options }),
  ttsStop: () => invoke<void>('tts_stop'),
  ttsStatus: () => invoke<TtsStatusResponse>('tts_status'),
  autostartStatus: () => invoke<boolean>('autostart_status'),
  autostartSet: (enabled: boolean) => invoke<boolean>('autostart_set', { enabled }),
};

export const listenForGlobalRfid = (handler: (uid: string) => void) => listen<string>('rfid-scan', (event) => handler(event.payload));

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

/** Listen for native real-time attendance changes from the Rust/SQLite layer. */
export const listenForAttendanceUpdates = (handler: (payload: { attendanceId: string; attendanceDate: string; action: string }) => void) =>
  listen<{ attendanceId: string; attendanceDate: string; action: string }>('attendance-updated', (event) => handler(event.payload));

/** Listen for tray menu "Check for updates…" trigger. */
export const listenForCheckForUpdates = (handler: () => void): Promise<() => void> => {
  if (globalThis.window === undefined || !('__TAURI_INTERNALS__' in globalThis.window)) {
    return Promise.resolve(() => {});
  }
  return listen<void>('check-for-updates', () => handler());
};

