import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { ArtifactExportResponse, AttendanceXlsxExportResponse, LanStatusResponse, PayrollCsvExportResponse, ScanRequest, ScanResponse, SafeConfigResponse } from '@rfid-attendance/shared';

/** Native command bridge. The existing HTTP API remains available during cutover. */
export const tauriApi = {
  getConfig: () => invoke<SafeConfigResponse>('get_config'),
  getHealth: () => invoke<Record<string, unknown>>('get_health'),
  getAttendance: (date?: string) => invoke('get_attendance', { date }),
  lanStatus: () => invoke<LanStatusResponse>('lan_status'),
  lanStart: () => invoke<LanStatusResponse>('lan_start'),
  lanStop: () => invoke<LanStatusResponse>('lan_stop'),
  openViewerUrl: (url: string) => invoke<void>('open_viewer_url', { url }),
  scanRfid: (request: ScanRequest) => invoke<ScanResponse>('scan_rfid', { request }),
  setupUnlock: (pin: string) => invoke<{ success: true; token: string; expiresAt: string }>('setup_unlock', { pin }),
  setupLock: () => invoke<{ success: true }>('setup_lock'),
  setupLookupCard: (token: string, rfidUid: string) => invoke('setup_lookup_card', { token, rfidUid }),
  setupUpsertUser: (token: string, user: unknown) => invoke('setup_upsert_user', { token, user }),
  adminGetSession: (token: string) => invoke('admin_get_session', { token }),
  adminUsers: (token: string) => invoke<{ success: true; users: unknown[] }>('admin_users', { token }),
  adminListUsers: (token: string) => invoke<{ success: true; users: unknown[] }>('admin_list_users', { token }),
  adminUpsertUser: (token: string, user: unknown) => invoke('admin_upsert_user', { token, user }),
  adminDeleteUser: (token: string, userId: string) => invoke('admin_delete_user', { token, userId }),
  adminAttendance: (token: string, date: string) => invoke('admin_attendance', { token, date }),
  adminListAttendance: (token: string, date: string) => invoke('admin_list_attendance', { token, date }),
  adminUpdateAttendance: (token: string, attendanceId: string, payload: unknown) => invoke('admin_update_attendance', { token, attendanceId, payload }),
  adminDeleteAttendance: (token: string, attendanceId: string, date: string) => invoke('admin_delete_attendance', { token, attendanceId, date }),
  payrollProfiles: (token: string) => invoke('payroll_list_profiles', { token }),
  payrollUpsertProfile: (token: string, profile: unknown) => invoke('payroll_upsert_profile', { token, profile }),
  payrollCutoffs: (token: string) => invoke('payroll_list_cutoffs', { token }),
  payrollCreateCutoff: (token: string, input: unknown) => invoke('payroll_create_cutoff', { token, input }),
  payrollUpdateCutoff: (token: string, input: unknown) => invoke('payroll_update_cutoff', { token, input }),
  payrollFinalizeCutoff: (token: string, payrollId: string) => invoke('payroll_finalize_cutoff', { token, payrollId }),
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
};

export const listenForGlobalRfid = (handler: (uid: string) => void) => listen<string>('rfid-scan', (event) => handler(event.payload));

/** Scanner lifecycle state reported by the native pipeline. */
export type ScannerState = 'connected' | 'scanning' | 'offline' | 'error';
export type ScannerStatus = {
  state: ScannerState;
  message: string;
  detail?: string | null;
  mode: string;
};

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
