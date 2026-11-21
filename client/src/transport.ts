import type {
  AdminAttendanceResponse,
  AdminUsersResponse,
  AttendanceListItem,
  AttendanceListResponse,
  AttendanceXlsxExportResponse,
  BathroomActionResponse,
  BathroomScanRequest,
  BathroomScanResponse,
  BathroomStatusResponse,
  BathroomUpdateRequest,
  DatabaseBackupResponse,
  DatabaseInfoResponse,
  IdRegisterStatus,
  InternPayrollReportResponse,
  InternPayslipImage,
  InternPayslipSaveResponse,
  InternPayslipsResponse,
  LanStatusResponse,
  PayrollCutoffsResponse,
  PayrollPdfGenerateResponse,
  PayrollPdfListResponse,
  PayrollProfilesResponse,
  SafeConfigResponse,
  ScanRequest,
  ScanResponse,
  SetupErrorResponse,
  SetupLookupResponse,
  SetupUpsertResponse,
  TtsSpeakOptions,
  TtsSpeakResult,
  TtsStatusResponse,
  VoiceClipState,
  VoiceStudioConnection,
  VoiceWorkerStatus,
} from '@rfid-attendance/shared';
import { httpApi } from './http-api';
import { tauriApi } from './tauri-api';
import type { ManualSyncReport, NativeHealthResponse, NativeSyncStatusResponse } from './tauri-api';

export type Outcome = { success: boolean; error?: { message?: string } };
export type CodedOutcome = { success: boolean; error?: { code?: string; message?: string } };
export type CutoffSaved = { success: boolean; payrollId?: string; netPay?: number };
export type Unlocked = { success: true; token: string; expiresAt: string };

/**
 * What the client asks of whatever answers it: one member per command. `tauri-api.ts` implements it against the
 * Rust commands (the shipped app) and `http-api.ts` against the legacy Node server (browser development).
 *
 * A `token` is the admin session's; the legacy server keeps that session in a cookie and ignores it. A `signal`
 * cancels the request in a browser tab; the desktop app has nothing to cancel and ignores it.
 */
export interface Transport {
  getConfig(signal?: AbortSignal): Promise<SafeConfigResponse>;
  getHealth(): Promise<NativeHealthResponse>;
  generatePayrollPdf(token: string, cutoffStart: string, cutoffEnd: string, payrollCutoffLabel: string, workerType: string): Promise<PayrollPdfGenerateResponse>;
  listPayrollPdfs(token: string): Promise<PayrollPdfListResponse>;
  internPayslips(token: string, cutoffStart: string, cutoffEnd: string): Promise<InternPayslipsResponse>;
  saveInternPayslipImages(token: string, payrollCutoffLabel: string, images: InternPayslipImage[]): Promise<InternPayslipSaveResponse>;
  getAttendance(date?: string, signal?: AbortSignal): Promise<AttendanceListResponse>;
  bathroomGetStatus(token?: string, date?: string, signal?: AbortSignal): Promise<BathroomStatusResponse>;
  /** `request` is what the legacy server is sent (it also wants the source); the desktop command takes the card alone. */
  bathroomScanRfid(rfidUid: string, request?: BathroomScanRequest, signal?: AbortSignal): Promise<BathroomScanResponse>;
  bathroomTimeOut(token: string, userId: string, genderKey: 'MALE' | 'FEMALE', notes?: string): Promise<BathroomActionResponse>;
  bathroomTimeIn(token: string, logId: string, notes?: string): Promise<BathroomActionResponse>;
  bathroomUpdateLog(token: string, logId: string, request: BathroomUpdateRequest): Promise<BathroomActionResponse>;
  lanStatus(): Promise<LanStatusResponse>;
  lanStart(): Promise<LanStatusResponse>;
  lanStop(): Promise<LanStatusResponse>;
  openViewerUrl(url: string): Promise<void>;
  scanRfid(request: ScanRequest, signal?: AbortSignal): Promise<ScanResponse>;
  setupUnlock(cardOrCode: string, signal?: AbortSignal): Promise<Unlocked | SetupErrorResponse>;
  /** The legacy server ends a setup session by its token; the desktop app has one session and ignores it. */
  setupLock(setupToken?: string, signal?: AbortSignal): Promise<{ success: true }>;
  /** The Admin panel's unlock and lock. On the desktop they are the setup commands; the legacy server has its own routes. */
  adminUnlock(cardOrCode: string): Promise<Unlocked | { success: false; error: { message: string } }>;
  adminLock(): Promise<{ success: true }>;
  adminAccountUnlock(email: string, password: string): Promise<{ success: true; token: string; expiresAt: string; name: string }>;
  adminAccountReset(email: string): Promise<{ success: true }>;
  setupLookupCard(token: string, rfidUid: string, signal?: AbortSignal): Promise<SetupLookupResponse | SetupErrorResponse>;
  setupUpsertUser<T extends object>(token: string, user: T, signal?: AbortSignal): Promise<SetupUpsertResponse | SetupErrorResponse>;
  /** Rejects when there is no session. */
  adminGetSession(token: string): Promise<{ success: true; expiresAt?: string }>;
  adminUsers(token: string, signal?: AbortSignal): Promise<AdminUsersResponse>;
  /** `existingUserId` tells the legacy server an update from a new user; the desktop command reads it from `user`. */
  adminUpsertUser<T extends object>(token: string, user: T, existingUserId?: string): Promise<Outcome>;
  adminDeleteUser(token: string, userId: string): Promise<Outcome>;
  adminAttendance(token: string, date: string, signal?: AbortSignal): Promise<AdminAttendanceResponse>;
  adminUpdateAttendance<T extends object>(token: string, attendanceId: string, payload: T): Promise<CodedOutcome>;
  adminCreateBackdatedAttendance<T extends object>(token: string, payload: T): Promise<{ success: boolean; attendance?: AttendanceListItem; error?: { code?: string; message?: string } }>;
  adminDeleteAttendance(token: string, attendanceId: string, date: string): Promise<Outcome>;
  payrollProfiles(token: string): Promise<PayrollProfilesResponse>;
  payrollUpsertProfile<T extends object>(token: string, profile: T): Promise<{ success: boolean }>;
  payrollDeleteProfile(token: string, profileId: string): Promise<Outcome>;
  payrollCutoffs(token: string): Promise<PayrollCutoffsResponse>;
  internPayrollReport(token: string, cutoffStart: string, cutoffEnd: string, payrollCutoffLabel: string): Promise<InternPayrollReportResponse>;
  payrollGenerateCutoff<T extends object>(token: string, cutoffStart: string, cutoffEnd: string, payrollCutoffLabel: string, customization: T): Promise<{ success: boolean; generated?: number; warnings?: string[]; error?: { message: string } }>;
  payrollCreateCutoff<T extends object>(token: string, input: T): Promise<CutoffSaved>;
  payrollUpdateCutoff<T extends object>(token: string, input: T): Promise<CutoffSaved>;
  payrollFinalizeCutoff(token: string, payrollId: string): Promise<Outcome>;
  payrollDeleteCutoff(token: string, payrollId: string): Promise<Outcome>;
  exportAttendanceXlsx(token: string, date: string): Promise<AttendanceXlsxExportResponse>;
  openGeneratedFile(token: string, filePath: string): Promise<{ success: true; message: string }>;
  revealGeneratedFile(token: string, filePath: string): Promise<{ success: true; message: string }>;
  openGeneratedDirectory(token: string, directoryPath: string): Promise<{ success: true; message: string }>;
  syncStatus(token: string): Promise<NativeSyncStatusResponse>;
  syncInternDtr(token: string, userId?: string, startFromUserId?: string): Promise<ManualSyncReport>;
  getInternDtrSync(token: string): Promise<{ success: true; enabled: boolean }>;
  setInternDtrSync(token: string, enabled: boolean): Promise<{ success: true; enabled: boolean }>;
  sheetsNukeResync(token: string, confirm: boolean): Promise<Outcome>;
  uploadPhoto(token: string, userId: string, base64Data: string): Promise<{ success: true; photoUrl: string } | SetupErrorResponse>;
  dbInfo(): Promise<DatabaseInfoResponse>;
  dbBackup(token: string): Promise<DatabaseBackupResponse>;
  dbRestoreRequest(token: string, sourcePath: string): Promise<{ success: true; message: string }>;
  dbDismissRestoreFailure(token: string): Promise<{ success: true; message: string }>;
  dbOpenBackupsDir(token: string): Promise<{ success: true; message: string }>;
  dbSaveBackupCopy(token: string, sourcePath: string, destinationPath: string): Promise<{ success: true; message: string }>;
  ttsSpeak(text: string, options?: TtsSpeakOptions): Promise<TtsSpeakResult>;
  ttsStop(): Promise<void>;
  ttsStatus(): Promise<TtsStatusResponse>;
  getVoicestudioHost(token: string): Promise<string>;
  setVoicestudioHost(token: string, host: string): Promise<string>;
  getVoicestudioPin(token: string): Promise<string>;
  setVoicestudioPin(token: string, pin: string): Promise<void>;
  checkVoicestudio(token: string, host?: string, pin?: string): Promise<VoiceStudioConnection>;
  voiceClipStates(): Promise<VoiceClipState[]>;
  voiceWorkerStatus(): Promise<VoiceWorkerStatus>;
  voiceRegenerate(token: string, personId: string): Promise<string>;
  voiceNameAudioUrl(personId: string): Promise<string | null>;
  idRegisterStatus(token: string): Promise<IdRegisterStatus>;
  idRegisterSignIn(token: string, email: string, password: string): Promise<IdRegisterStatus>;
  idRegisterSignOut(token: string): Promise<IdRegisterStatus>;
  idRegisterCheck(token: string): Promise<IdRegisterStatus>;
  autostartStatus(): Promise<boolean>;
  autostartSet(enabled: boolean): Promise<boolean>;
  /** Asks where to save a copy of a backup (e.g. a USB drive); null when the dialog is cancelled. */
  pickBackupDestination(fileName: string): Promise<string | null>;
}

export const runningInTauri = (): boolean => globalThis.window !== undefined && '__TAURI_INTERNALS__' in globalThis.window;

/** The one place the transport is chosen: the desktop app talks to Rust, a browser tab to the legacy Node server. */
export const transport = (): Transport => (runningInTauri() ? tauriApi : httpApi);
