import type {
  AttendanceXlsxExportResponse,
  BathroomActionResponse,
  BathroomScanRequest,
  BathroomScanResponse,
  BathroomStatusResponse,
  BathroomUpdateRequest,
  DatabaseBackupResponse,
  DatabaseInfoResponse,
  IdRegisterStatus,
  InternPayslipImage,
  InternPayslipSaveResponse,
  LanStatusResponse,
  OfficeIdentity,
  SafeConfigResponse,
  ScanErrorResponse,
  ScanRequest,
  ScanResponse,
  SetupErrorResponse,
  SetupLookupResponse,
  SetupUnlockResponse,
  SetupUpsertRequest,
  SetupUpsertResponse,
  AttendanceListItem,
  AttendanceListResponse,
  AdminAttendanceResponse,
  AdminUsersResponse,
  PayrollCalculationProfile,
  PayrollCutoffsResponse,
  InternPayrollReportResponse,
  PayrollProfilesResponse,
  PayrollPdfGenerateRequest,
  PayrollPdfGenerateResponse,
  PayrollPdfListResponse,
  VoiceClipState,
  VoiceWorkerStatus,
} from '@rfid-attendance/shared';
import { DEFAULT_OFFICE_IDENTITY, resolveOfficeDisplay } from '@rfid-attendance/shared';
import { convertFileSrc } from '@tauri-apps/api/core';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { adminSession } from './admin-session';
import { errorCode, knownSentence, sentenceFor, setupErrorFrom } from './error-sentences';
import { withAbort } from './http-api';
import { renderInternPayslipPng } from './intern-payslip-image';
import { runningInTauri, transport } from './transport';
import type { ManualSyncReport, NativeDtrPendingItem, NativeSyncInProgress, NativeSyncStatusResponse, NativeSyncTableStatus } from './tauri-api';

export { setupErrorFrom } from './error-sentences';

type Failure = { success: false; error: { message: string } };
const failure = (message: string): Failure => ({ success: false, error: { message } });

/** The admin session token for admin-only commands (empty when locked). */
export const nativeAdminSessionToken = adminSession.token;

export async function loadVoiceClipStates(): Promise<VoiceClipState[]> {
  try {
    const states = await transport().voiceClipStates();
    return Array.isArray(states) ? states : [];
  } catch {
    return [];
  }
}

export async function loadVoiceWorkerStatus(): Promise<VoiceWorkerStatus | null> {
  try {
    return await transport().voiceWorkerStatus();
  } catch {
    return null;
  }
}

export async function regenerateVoiceClip(personId: string): Promise<{ ok: boolean; spokenText?: string; error?: string }> {
  try {
    const spokenText = await transport().voiceRegenerate(nativeAdminSessionToken(), personId);
    return { ok: true, spokenText };
  } catch (error) {
    return { ok: false, error: errorCode(error) || 'Voice regeneration failed.' };
  }
}

export type VoiceRegenOutcome = 'ready' | 'timeout' | 'aborted';

export type VoiceRegenPollOptions = {
  load: () => Promise<VoiceClipState[]>;
  onSnapshot?: (states: VoiceClipState[]) => void;
  intervalMs?: number;
  timeoutMs?: number;
  isCancelled?: () => boolean;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });

/**
 * Poll clip states until one person's regeneration job reaches DONE.
 * `regenerate` enqueues PENDING synchronously before returning, so DONE
 * always means this run finished (workerClip alone can't prove that — a
 * previous clip may already exist). Load failures are tolerated: the loop
 * keeps polling until the timeout. Returns how the wait ended.
 */
export async function pollVoiceClipReady(personId: string, options: VoiceRegenPollOptions): Promise<VoiceRegenOutcome> {
  const intervalMs = options.intervalMs ?? 2000;
  const timeoutMs = options.timeoutMs ?? 120000;
  const maxRounds = Math.max(1, Math.ceil(timeoutMs / intervalMs)) + 1;
  for (let round = 0; round < maxRounds; round += 1) {
    if (options.isCancelled?.()) return 'aborted';
    await sleep(intervalMs);
    if (options.isCancelled?.()) return 'aborted';
    let states: VoiceClipState[] = [];
    try {
      states = await options.load();
    } catch {
      states = [];
    }
    if (states.length > 0) options.onSnapshot?.(states);
    const mine = states.find((state) => state.personId === personId);
    if (mine?.jobStatus === 'DONE') return 'ready';
    if (round >= maxRounds - 1) return 'timeout';
  }
  return 'timeout';
}

export async function pickRestoreBackupFile(): Promise<string | null> {
  const selected = await openFileDialog({
    multiple: false,
    directory: false,
    filters: [{ name: 'Alpha Premier portable backup', extensions: ['apbackup', 'db'] }],
  });
  if (selected && Object.prototype.toString.call(selected) === '[object String]') {
    // SAFETY: Verified selected is a string file path
    return selected as string;
  }
  return null;
}

export function photoSource(photoUrl: string | null | undefined): string | undefined {
  if (!photoUrl || !runningInTauri()) return photoUrl || undefined;
  try {
    const [rawPath, rawQuery] = photoUrl.includes('?') ? photoUrl.split('?', 2) : [photoUrl, ''];
    let converted = rawPath;
    if (rawPath.startsWith('asset://localhost/')) {
      converted = convertFileSrc(decodeURIComponent(rawPath.slice('asset://localhost/'.length)));
    } else if (/^[A-Za-z]:[\\/]/.test(rawPath) || rawPath.startsWith('\\\\')) {
      converted = convertFileSrc(rawPath);
    }
    return rawQuery ? `${converted}${converted.includes('?') ? '&' : '?'}${rawQuery}` : converted;
  } catch {
    return photoUrl;
  }
}

export const DEFAULT_CONFIG: Omit<SafeConfigResponse, 'success'> = {
  timezone: 'Asia/Manila',
  rfidAutoSubmitDelayMs: 150,
  resultResetDelayMs: 4_000,
  enableCardSetup: false,
  enableAdmin: false,
  office: DEFAULT_OFFICE_IDENTITY,
  scanner: { mode: 'keyboard', paused: false, expectedLength: 10, characterSet: 'decimal' },
};

/** Merge a partial office payload from the backend with canonical defaults. */
export function normalizeOffice(office: Partial<OfficeIdentity> | undefined): OfficeIdentity {
  const merged = { ...DEFAULT_OFFICE_IDENTITY, ...office };
  return {
    ...merged,
    // Display strings derive from the same source of truth when not configured.
    officeDisplayShort: resolveOfficeDisplay(merged, 'short'),
    officeDisplayFull: resolveOfficeDisplay(merged, 'full'),
  };
}

export async function loadConfig(signal?: AbortSignal): Promise<Omit<SafeConfigResponse, 'success'>> {
  try {
    // SAFETY: Either backend may leave fields out; every one is filled from the defaults below
    const data = (await withAbort(signal, () => transport().getConfig())) as Partial<SafeConfigResponse>;
    return {
      timezone: data.timezone || DEFAULT_CONFIG.timezone,
      rfidAutoSubmitDelayMs: positiveNumber(data.rfidAutoSubmitDelayMs, DEFAULT_CONFIG.rfidAutoSubmitDelayMs),
      resultResetDelayMs: positiveNumber(data.resultResetDelayMs, DEFAULT_CONFIG.resultResetDelayMs),
      enableCardSetup: data.enableCardSetup ?? DEFAULT_CONFIG.enableCardSetup,
      enableAdmin: data.enableAdmin ?? DEFAULT_CONFIG.enableAdmin,
      // SAFETY: Casting data.office to partial OfficeIdentity
      office: normalizeOffice(data.office as Partial<OfficeIdentity> | undefined),
      scanner: data.scanner ?? DEFAULT_CONFIG.scanner,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** A scan normally answers in well under a second; one that never does must not hold the kiosk in "processing". */
const SCAN_TIMEOUT_MS = 15_000;

export async function submitScan(request: ScanRequest, signal?: AbortSignal): Promise<ScanResponse> {
  // The caller's abort (a newer scan, a mode switch) or the timeout, whichever comes first.
  const limit = new AbortController();
  const timer = setTimeout(() => limit.abort(), SCAN_TIMEOUT_MS);
  signal?.addEventListener('abort', () => limit.abort(), { once: true });
  try {
    return await withAbort(limit.signal, () => transport().scanRfid(request));
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    // A timeout is an unreachable service too.
    const timedOut = limit.signal.aborted && !signal?.aborted;
    const isNetworkError = timedOut || !navigator.onLine || err.includes('fetch') || err.includes('network') || err.includes('connectivity');
    // Attendance is never saved offline (owner decision D6): a replay was
    // recorded at replay time, not tap time. The kiosk shows its
    // "Can't reach the system" card and the person taps again.
    if (isNetworkError) throw error;
    return networkError('Unable to reach the attendance service. Please try again.');
  } finally {
    clearTimeout(timer);
  }
}

export async function unlockSetup(pin: string, signal?: AbortSignal): Promise<SetupUnlockResponse | SetupErrorResponse> {
  try {
    const response = await withAbort(signal, () => transport().setupUnlock(pin));
    if (!response.success) return response;
    adminSession.open(response.token, response.expiresAt);
    return { success: true, setupToken: response.token, expiresAt: response.expiresAt };
  } catch (error) {
    return setupErrorFrom(error, 'INVALID_SETUP_PIN');
  }
}

export async function lookupSetupCard(rfidUid: string, setupToken: string, signal?: AbortSignal): Promise<SetupLookupResponse | SetupErrorResponse> {
  try {
    return await withAbort(signal, () => transport().setupLookupCard(setupToken, rfidUid));
  } catch (error) {
    return setupErrorFrom(error, 'SETUP_AUTH_REQUIRED');
  }
}

export async function upsertSetupUser(request: SetupUpsertRequest, setupToken: string, signal?: AbortSignal): Promise<SetupUpsertResponse | SetupErrorResponse> {
  try {
    return await withAbort(signal, () => transport().setupUpsertUser(setupToken, request));
  } catch (error) {
    return setupErrorFrom(error, 'SETUP_AUTH_REQUIRED');
  }
}

export async function lockSetup(setupToken: string, signal?: AbortSignal): Promise<void> {
  adminSession.dropToken();
  await withAbort(signal, () => transport().setupLock(setupToken));
}

export async function uploadSetupPhoto(userId: string, dataUrl: string, setupToken: string): Promise<{ success: true; photoUrl: string } | SetupErrorResponse> {
  try {
    return await transport().uploadPhoto(setupToken, userId, dataUrl);
  } catch (error) {
    return setupErrorFrom(error, 'SETUP_AUTH_REQUIRED');
  }
}

export function uploadAdminPhoto(userId: string, dataUrl: string): Promise<{ success: true; photoUrl: string } | SetupErrorResponse> {
  return uploadSetupPhoto(userId, dataUrl, nativeAdminSessionToken());
}

export function loadAttendance(date?: string, signal?: AbortSignal): Promise<AttendanceListResponse> {
  return withAbort(signal, () => transport().getAttendance(date));
}

/** LAN viewer status used when the viewer cannot be asked. */
function lanUnavailableStatus(message: string): LanStatusResponse {
  return {
    success: false,
    state: 'disabled',
    enabled: false,
    allowRuntimeStart: false,
    port: 4173,
    bindAddress: null,
    viewerUrl: null,
    lanIps: [],
    activeLanIp: null,
    networkScope: 'The LAN viewer is available in the desktop application.',
    networkProfile: 'unknown',
    configValid: false,
    configError: message,
    issue: 'not_tauri',
    connectedSseClients: 0,
    startedAt: null,
    lastError: null,
    allowedSubnets: [],
    configuredBindPresent: true,
    localHealthOk: null,
    localHealthError: null,
    firewallAllowRule: 'unknown',
    guidance: [message],
  };
}

async function lanAsk(ask: () => Promise<LanStatusResponse>): Promise<LanStatusResponse> {
  try {
    return await ask();
  } catch (error) {
    return lanUnavailableStatus(sentenceFor(null, error, () => 'Unable to reach the LAN viewer service.'));
  }
}

/** Start (or verify) the LAN live attendance viewer. */
export function startLanViewer(): Promise<LanStatusResponse> {
  return lanAsk(() => transport().lanStart());
}

/** Read the current LAN viewer status for the Live Attendance panel. */
export function getLanStatus(): Promise<LanStatusResponse> {
  return lanAsk(() => transport().lanStatus());
}

/** Stop the LAN viewer (attendance recording on this laptop is unaffected). */
export function stopLanViewer(): Promise<LanStatusResponse> {
  return lanAsk(() => transport().lanStop());
}

/** Open the viewer URL in the system default browser (in a browser tab: a new tab). */
export async function openViewerUrl(url: string): Promise<boolean> {
  try {
    await transport().openViewerUrl(url);
    return true;
  } catch {
    return false;
  }
}

export async function unlockAdmin(pin: string): Promise<{ success: true; expiresAt: string } | Failure> {
  try {
    const response = await transport().adminUnlock(pin);
    if (!response.success) return response;
    adminSession.open(response.token, response.expiresAt);
    return { success: true, expiresAt: response.expiresAt };
  } catch (error) {
    return failure(sentenceFor('unlock', error, () => 'That is not a registered admin RFID card.'));
  }
}

type AccountFailure = Failure;

function accountError<T>(error: T): AccountFailure {
  return failure(sentenceFor('account', error, (code) => code || 'The sign-in could not be completed.'));
}

/** Opens the admin screens with the person's own Keystone account (the CEO, or staff the CEO made an attendance admin). */
export async function unlockAdminWithAccount(email: string, password: string): Promise<{ success: true; expiresAt: string; token: string; name: string } | AccountFailure> {
  try {
    const response = await transport().adminAccountUnlock(email, password);
    adminSession.open(response.token, response.expiresAt);
    return { success: true, expiresAt: response.expiresAt, token: response.token, name: response.name };
  } catch (error) {
    return accountError(error);
  }
}

/** Forgot password: Firebase emails the reset link, if the address has an account. */
export async function requestAccountPasswordReset(email: string): Promise<{ success: true } | AccountFailure> {
  try {
    await transport().adminAccountReset(email);
    return { success: true };
  } catch (error) {
    const blank = knownSentence('accountReset', errorCode(error));
    return blank ? failure(blank.message) : accountError(error);
  }
}

export async function lockAdmin(): Promise<void> {
  adminSession.close();
  await transport().adminLock();
}

export async function checkAdminSession(): Promise<string | null> {
  try {
    const session = await transport().adminGetSession(nativeAdminSessionToken());
    return session.expiresAt ?? adminSession.get().expiresAt ?? new Date(Date.now() + 15 * 60 * 1000).toISOString();
  } catch {
    adminSession.close();
    return null;
  }
}
export function loadAdminUsers(signal?: AbortSignal): Promise<AdminUsersResponse> {
  return withAbort(signal, () => transport().adminUsers(nativeAdminSessionToken()));
}
export function loadAdminAttendance(date: string, signal?: AbortSignal): Promise<AdminAttendanceResponse> {
  return withAbort(signal, () => transport().adminAttendance(nativeAdminSessionToken(), date));
}

export async function saveAdminUser<T extends object>(user: T, userId?: string): Promise<{ success: boolean; error?: { message?: string } }> {
  const payload = Object.assign({}, user, userId ? { userId } : undefined);
  try {
    return await transport().adminUpsertUser(nativeAdminSessionToken(), payload, userId);
  } catch (err) {
    const known = knownSentence('userSave', errorCode(err));
    if (!known) throw err;
    return failure(known.message);
  }
}

export async function saveAdminAttendance<T extends object>(attendanceId: string, payload: T): Promise<{ success: boolean; error?: { code?: string; message?: string } }> {
  try {
    return await transport().adminUpdateAttendance(nativeAdminSessionToken(), attendanceId, payload);
  } catch (err) {
    const raw = errorCode(err);
    return { success: false, error: knownSentence('attendance', raw) ?? { message: raw || 'Unable to save attendance.' } };
  }
}
export async function createAdminBackdatedAttendance<T extends object>(payload: T): Promise<{ success: boolean; attendance?: AttendanceListItem; error?: { code?: string; message?: string } }> {
  try {
    return await transport().adminCreateBackdatedAttendance(nativeAdminSessionToken(), payload);
  } catch (err: unknown) {
    const raw = errorCode(err);
    const message = knownSentence('backdate', raw)?.message ?? (raw || 'Failed to add backdated attendance');
    return { success: false, error: { code: raw || undefined, message } };
  }
}
export function deleteAdminUser(userId: string): Promise<{ success: boolean; error?: { message?: string } }> {
  return transport().adminDeleteUser(nativeAdminSessionToken(), userId);
}
export async function deleteAdminAttendance(attendanceId: string, date: string): Promise<{ success: boolean; error?: { message?: string } }> {
  try {
    return await transport().adminDeleteAttendance(nativeAdminSessionToken(), attendanceId, date);
  } catch (err) {
    return failure(sentenceFor('attendance', err, (code) => code || 'Unable to delete record.'));
  }
}
export function loadPayrollProfiles(): Promise<PayrollProfilesResponse> {
  return transport().payrollProfiles(nativeAdminSessionToken());
}
export function savePayrollProfile(profile: PayrollCalculationProfile): Promise<{ success: boolean }> {
  return transport().payrollUpsertProfile(nativeAdminSessionToken(), profile);
}
export async function deletePayrollProfile(profileId: string): Promise<{ success: boolean; error?: { message?: string } }> {
  try {
    return await transport().payrollDeleteProfile(nativeAdminSessionToken(), profileId);
  } catch (error) {
    return failure(sentenceFor('payrollProfile', error, (code) => code || 'Unable to delete payroll profile.'));
  }
}
export function loadPayrollCutoffs(): Promise<PayrollCutoffsResponse> {
  return transport().payrollCutoffs(nativeAdminSessionToken());
}
export async function loadPayrollPdfs(): Promise<PayrollPdfListResponse> {
  try {
    return await transport().listPayrollPdfs(nativeAdminSessionToken());
  } catch (error) {
    return failure(sentenceFor(null, error, () => 'Unable to load payroll PDFs.'));
  }
}
export async function generatePayrollPdf(request: PayrollPdfGenerateRequest): Promise<PayrollPdfGenerateResponse> {
  try {
    return await transport().generatePayrollPdf(nativeAdminSessionToken(), request.cutoffStart, request.cutoffEnd, request.payrollCutoffLabel ?? '', request.workerType.toUpperCase());
  } catch (error) {
    return failure(sentenceFor('payrollPdf', error, () => 'Unable to generate the payroll PDF.'));
  }
}
/** Renders one payslip PNG per intern in the WebView, then hands them to the backend to save in one folder. */
export async function generateInternPayslipImages(request: { cutoffStart: string; cutoffEnd: string; payrollCutoffLabel: string }): Promise<InternPayslipSaveResponse> {
  const periodLabel = request.payrollCutoffLabel.trim() || `${request.cutoffStart} to ${request.cutoffEnd}`;
  try {
    const data = await transport().internPayslips(nativeAdminSessionToken(), request.cutoffStart, request.cutoffEnd);
    if (!data.success) return data;
    const images: InternPayslipImage[] = [];
    for (const payslip of data.payslips) {
      const pngBase64 = await renderInternPayslipPng(payslip, { companyName: data.companyName, companyAddress: data.companyAddress, periodLabel });
      images.push({ employeeId: payslip.employeeId, employeeName: payslip.employeeName, pngBase64 });
    }
    return await transport().saveInternPayslipImages(nativeAdminSessionToken(), periodLabel, images);
  } catch (error) {
    return failure(sentenceFor('payslips', error, () => 'Unable to generate the payslips.'));
  }
}
export function loadInternPayrollReport(cutoffStart: string, cutoffEnd: string, payrollCutoffLabel: string): Promise<InternPayrollReportResponse> {
  return transport().internPayrollReport(nativeAdminSessionToken(), cutoffStart, cutoffEnd, payrollCutoffLabel);
}
export function savePayrollCutoff<T extends object>(payroll: T, payrollId?: string): Promise<{ success: boolean; payrollId?: string; netPay?: number }> {
  if (payrollId) return transport().payrollUpdateCutoff(nativeAdminSessionToken(), Object.assign({}, payroll, { payrollId }));
  return transport().payrollCreateCutoff(nativeAdminSessionToken(), payroll);
}
export async function generatePayrollCutoff<T extends object>(cutoffStart: string, cutoffEnd: string, payrollCutoffLabel: string, customization?: T): Promise<{ success: boolean; generated?: number; warnings?: string[]; error?: { message: string } }> {
  try {
    return await transport().payrollGenerateCutoff(nativeAdminSessionToken(), cutoffStart, cutoffEnd, payrollCutoffLabel, customization ?? {});
  } catch (err) {
    return failure(err instanceof Error ? err.message : String(err));
  }
}
export async function finalizePayrollCutoff(payrollId: string): Promise<{ success: boolean; error?: { message?: string } }> {
  try {
    return await transport().payrollFinalizeCutoff(nativeAdminSessionToken(), payrollId);
  } catch (err) {
    return failure(err instanceof Error ? err.message : String(err));
  }
}
export async function deletePayrollCutoff(payrollId: string): Promise<{ success: boolean; error?: { message?: string } }> {
  try {
    return await transport().payrollDeleteCutoff(nativeAdminSessionToken(), payrollId);
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    return failure(rawMessage || 'Unable to delete payroll cutoff.');
  }
}
export async function exportAttendanceXlsx(date: string): Promise<AttendanceXlsxExportResponse | Failure> {
  try {
    return await transport().exportAttendanceXlsx(nativeAdminSessionToken(), date);
  } catch (error) {
    return failure(sentenceFor(null, error, () => 'Unable to generate the attendance workbook.'));
  }
}

export type FileActionResult = { ok: boolean; message: string };

function fileActionError<T>(error: T, fallback: string): FileActionResult {
  return { ok: false, message: sentenceFor('file', error, () => fallback) };
}

async function runFileAction(action: (token: string) => Promise<{ success: boolean; message?: string } | void>): Promise<FileActionResult> {
  try {
    await action(nativeAdminSessionToken());
    return { ok: true, message: '' };
  } catch (error) {
    return fileActionError(error, 'The file action could not be completed.');
  }
}

/** Open a generated file with the system default application. */
export function openGeneratedFile(filePath: string): Promise<FileActionResult> {
  return runFileAction((token) => transport().openGeneratedFile(token, filePath));
}

/** Reveal the exact generated file in the OS file explorer. */
export function revealGeneratedFile(filePath: string): Promise<FileActionResult> {
  return runFileAction((token) => transport().revealGeneratedFile(token, filePath));
}

/** Open a generated-file directory in the OS file explorer. */
export function openGeneratedDirectory(directoryPath: string): Promise<FileActionResult> {
  return runFileAction((token) => transport().openGeneratedDirectory(token, directoryPath));
}
export function nukeSheetsResync(confirm: boolean): Promise<{ success: boolean; error?: { message?: string } }> {
  return transport().sheetsNukeResync(nativeAdminSessionToken(), confirm);
}
export async function syncInternDtr(userId?: string, startFromUserId?: string): Promise<ManualSyncReport> {
  try {
    return await transport().syncInternDtr(nativeAdminSessionToken(), userId, startFromUserId);
  } catch (error) {
    return {
      success: false,
      internsChecked: 0,
      tabsCreated: [],
      rowsSynced: 0,
      details: [],
      errors: [errorCode(error)],
      error: { message: errorCode(error) },
    };
  }
}

export interface InternDtrSyncToggle {
  success: boolean;
  enabled: boolean;
  error?: { message: string };
}

export interface DtrSyncTableStatus {
  tableName: string;
  pending: number;
}

export interface DtrPendingPerson {
  userId: string;
  fullName: string;
  attempts: number;
  lastChecked: string | null;
}

export interface DtrSyncInProgress {
  owner: string;
  startedAt: string;
}

export interface DtrSyncHealth {
  pending: number;
  deadLetter: number;
  byTable: DtrSyncTableStatus[];
  dtrPendingCount: number;
  dtrPendingItems: DtrPendingPerson[];
  lastSyncedAt: string | null;
  lastError: string | null;
  throttledUntil: string | null;
  lastThrottleReason: string | null;
  inProgress: DtrSyncInProgress | null;
  leaseRecovered: number;
  oldestRetryableAgeSec: number | null;
  pendingAgeAlert: boolean;
  dtr?: NativeSyncStatusResponse['dtr'];
}

export type DtrSyncHealthResult =
  | { success: true; health: DtrSyncHealth }
  | { success: false; error: { message: string } };

function isPlainObject<T>(value: T): boolean {
  return value !== null && value !== undefined && Object.prototype.toString.call(value) === '[object Object]';
}

function isMissing<T>(value: T): boolean {
  return value === null || value === undefined;
}

function toNonNegativeInt<T>(value: T): number | null {
  if (!isMissing(value) && Object.prototype.toString.call(value) === '[object Number]') {
    // SAFETY: Verified that value is a number
    const num = value as number;
    if (Number.isFinite(num) && num >= 0) return Math.floor(num);
  }
  return null;
}

function toText<T>(value: T): string | null {
  if (isMissing(value)) return null;
  if (Object.prototype.toString.call(value) === '[object String]') {
    // SAFETY: Verified that value is a string
    return value as string;
  }
  return null;
}

function parseDtrSyncTable(entry: NativeSyncTableStatus): DtrSyncTableStatus | null {
  if (!isPlainObject(entry)) return null;
  const tableName = toText(entry.tableName);
  if (!tableName) return null;
  const pending = toNonNegativeInt(entry.pending);
  if (pending === null) return null;
  return { tableName, pending };
}

function parseDtrPendingPerson(entry: NativeDtrPendingItem): DtrPendingPerson | null {
  if (!isPlainObject(entry)) return null;
  const userId = toText(entry.userId);
  const fullName = toText(entry.fullName);
  if (!userId || !fullName) return null;
  const attempts = toNonNegativeInt(entry.attempts);
  if (attempts === null) return null;
  if (!isMissing(entry.lastChecked) && toText(entry.lastChecked) === null) return null;
  return { userId, fullName, attempts, lastChecked: toText(entry.lastChecked) };
}

function parseDtrSyncInProgress(entry: NativeSyncInProgress | null | undefined): DtrSyncInProgress | null {
  if (isMissing(entry)) return null;
  if (!isPlainObject(entry)) return null;
  // SAFETY: Object shape of the guard holder was verified above
  const holder = entry as NativeSyncInProgress;
  const owner = toText(holder.owner);
  const startedAt = toText(holder.startedAt);
  if (!owner || !startedAt) return null;
  return { owner, startedAt };
}

function parseDtrSyncSummary(summary: NativeSyncStatusResponse['dtr']): NativeSyncStatusResponse['dtr'] | undefined {
  if (summary === null || summary === undefined) return undefined;
  const retryablePending = isMissing(summary.retryablePending) ? 0 : toNonNegativeInt(summary.retryablePending);
  if (retryablePending === null) return undefined;
  if (!isMissing(summary.persistenceFailure) && summary.persistenceFailure !== true && summary.persistenceFailure !== false) return undefined;
  const persistenceFailure = isMissing(summary.persistenceFailure) ? false : summary.persistenceFailure;
  const emittedAt = isMissing(summary.emittedAt) ? new Date().toISOString() : toText(summary.emittedAt);
  if (emittedAt === null) return undefined;
  return { ...summary, retryablePending, persistenceFailure, emittedAt };
}

function parseDtrSyncHealth(raw: NativeSyncStatusResponse | null): DtrSyncHealth | null {
  if (!isPlainObject(raw)) return null;
  // SAFETY: Presence of the status envelope was verified above
  const response = raw as NativeSyncStatusResponse;
  if (response.success !== true) return null;
  const pending = toNonNegativeInt(response.pending);
  const deadLetter = toNonNegativeInt(response.deadLetter);
  if (pending === null || deadLetter === null) return null;
  const byTable: DtrSyncTableStatus[] = [];
  if (Array.isArray(response.byTable)) {
    for (const entry of response.byTable) {
      const parsed = parseDtrSyncTable(entry);
      if (parsed) byTable.push(parsed);
    }
  }
  let dtrPendingCount = 0;
  const dtrPendingItems: DtrPendingPerson[] = [];
  if (!isMissing(response.dtrPending) && isPlainObject(response.dtrPending)) {
    // SAFETY: Presence and object shape of dtrPending were verified above
    const dtr = response.dtrPending as { count: number; items: NativeDtrPendingItem[] };
    const count = toNonNegativeInt(dtr.count);
    if (count !== null) dtrPendingCount = count;
    if (Array.isArray(dtr.items)) {
      for (const entry of dtr.items) {
        const parsed = parseDtrPendingPerson(entry);
        if (parsed) dtrPendingItems.push(parsed);
      }
    }
  }
  if (!isMissing(response.lastSyncedAt) && toText(response.lastSyncedAt) === null) return null;
  if (!isMissing(response.lastError) && toText(response.lastError) === null) return null;
  if (!isMissing(response.throttledUntil) && toText(response.throttledUntil) === null) return null;
  if (!isMissing(response.lastThrottleReason) && toText(response.lastThrottleReason) === null) return null;
  const leaseRecovered = isMissing(response.leaseRecovered) ? 0 : toNonNegativeInt(response.leaseRecovered);
  if (leaseRecovered === null) return null;
  const oldestRetryableAgeSec = isMissing(response.oldestRetryableAgeSec) ? null : toNonNegativeInt(response.oldestRetryableAgeSec);
  if (!isMissing(response.oldestRetryableAgeSec) && oldestRetryableAgeSec === null) return null;
  if (!isMissing(response.pendingAgeAlert) && Object.prototype.toString.call(response.pendingAgeAlert) !== '[object Boolean]') return null;
  const dtr = parseDtrSyncSummary(response.dtr);
  if (!isMissing(response.dtr) && !dtr) return null;
  return {
    pending,
    deadLetter,
    byTable,
    dtrPendingCount,
    dtrPendingItems,
    lastSyncedAt: toText(response.lastSyncedAt),
    lastError: toText(response.lastError),
    throttledUntil: toText(response.throttledUntil),
    lastThrottleReason: toText(response.lastThrottleReason),
    inProgress: parseDtrSyncInProgress(response.inProgress),
    leaseRecovered,
    oldestRetryableAgeSec,
    // SAFETY: Boolean shape of pendingAgeAlert was verified above
    pendingAgeAlert: (isMissing(response.pendingAgeAlert) ? false : response.pendingAgeAlert) as boolean,
    dtr,
  };
}

/** Per-device DTR kill switch state (local SQLite; OFF here never affects deployment). */
export async function getInternDtrSync(): Promise<InternDtrSyncToggle> {
  try {
    return await transport().getInternDtrSync(nativeAdminSessionToken());
  } catch (error) {
    return { success: false, enabled: true, error: { message: errorCode(error) } };
  }
}

/** Persist the per-device toggle. Returns the stored state. */
export async function setInternDtrSync(enabled: boolean): Promise<InternDtrSyncToggle> {
  try {
    return await transport().setInternDtrSync(nativeAdminSessionToken(), enabled);
  } catch (error) {
    return { success: false, enabled: true, error: { message: errorCode(error) } };
  }
}

/** Live DTR/sync-queue health for the Data & backup panel. */
export async function loadDtrSyncHealth(): Promise<DtrSyncHealthResult> {
  try {
    const raw = await transport().syncStatus(nativeAdminSessionToken());
    const health = parseDtrSyncHealth(raw);
    if (!health) return failure('Unable to read the sync status.');
    return { success: true, health };
  } catch (error) {
    return failure(errorCode(error) || 'Unable to read the sync status.');
  }
}

/** Read the live SQLite database status for the Data & backup panel. */
export async function loadDatabaseInfo(): Promise<DatabaseInfoResponse | Failure> {
  try {
    return await transport().dbInfo();
  } catch (error) {
    return failure(sentenceFor(null, error, () => 'Unable to read the database status.'));
  }
}

/** Create a consistent timestamped backup of the SQLite database. */
export async function createDatabaseBackup(): Promise<DatabaseBackupResponse | Failure> {
  try {
    return await transport().dbBackup(nativeAdminSessionToken());
  } catch (error) {
    return failure(sentenceFor(null, error, () => 'Unable to create a database backup.'));
  }
}

/** Schedule a restore from `sourcePath`; the app exits and restores on next launch. */
export async function requestDatabaseRestore(sourcePath: string): Promise<{ success: true; message: string } | Failure> {
  try {
    return await transport().dbRestoreRequest(nativeAdminSessionToken(), sourcePath);
  } catch (error) {
    return failure(sentenceFor('restore', error, () => 'Unable to schedule the restore.'));
  }
}

/** Dismiss the persisted restore-failure notice after it has been reviewed. */
export async function dismissRestoreFailure(): Promise<{ success: true; message: string } | Failure> {
  try {
    return await transport().dbDismissRestoreFailure(nativeAdminSessionToken());
  } catch (error) {
    return failure(sentenceFor(null, error, () => 'Unable to dismiss the restore notice.'));
  }
}

/** Open the backups folder in the OS file explorer. */
export function openDatabaseBackupsFolder(): Promise<FileActionResult> {
  return runFileAction((token) => transport().dbOpenBackupsDir(token));
}

/** Ask where to save (e.g. a USB drive), then copy one saved backup there. Resolves null when the save dialog is cancelled. */
export async function saveBackupCopy(sourcePath: string, fileName: string): Promise<FileActionResult | null> {
  let destination: string | null;
  try {
    destination = await transport().pickBackupDestination(fileName);
  } catch (error) {
    return { ok: false, message: sentenceFor(null, error, () => 'Unable to open the save dialog.') };
  }
  if (!destination) return null;
  try {
    await transport().dbSaveBackupCopy(nativeAdminSessionToken(), sourcePath, destination);
    return { ok: true, message: `Backup saved to ${destination}.` };
  } catch (error) {
    return fileActionError(error, 'The backup could not be saved.');
  }
}

function positiveNumber<T>(value: T, fallback: number): number {
  if (value && Object.prototype.toString.call(value) === '[object Number]') {
    // SAFETY: Verified that value is a number
    const num = value as number;
    if (Number.isFinite(num) && num > 0) return num;
  }
  return fallback;
}

function networkError(message: string): ScanErrorResponse {
  return {
    success: false,
    requestId: `client-${Date.now()}`,
    error: { code: 'INTERNAL_SERVER_ERROR', message },
  };
}

export async function getAutostartStatus(): Promise<boolean> {
  try {
    return await transport().autostartStatus();
  } catch {
    return false;
  }
}

export async function setAutostartStatus(enabled: boolean): Promise<boolean> {
  try {
    return await transport().autostartSet(enabled);
  } catch {
    return false;
  }
}

export function loadBathroomStatus(date?: string, signal?: AbortSignal): Promise<BathroomStatusResponse> {
  return withAbort(signal, () => transport().bathroomGetStatus(adminSession.get().token ?? undefined, date));
}

export async function submitBathroomScan(
  request: BathroomScanRequest,
  signal?: AbortSignal,
): Promise<BathroomScanResponse> {
  try {
    return await withAbort(signal, () => transport().bathroomScanRfid(request.rfidUid, request));
  } catch (error) {
    return {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: errorCode(error) },
    };
  }
}

/** Native bathroom errors read "CODE: sentence"; split them so the UI shows only the sentence. */
function bathroomError<T>(error: T): { code: string; message: string } {
  const raw = errorCode(error);
  const match = /^([A-Z_]+):\s*(.+)$/s.exec(raw);
  return match ? { code: match[1], message: match[2] } : { code: 'BATHROOM_ERROR', message: raw };
}

export async function bathroomTimeOut(
  userId: string,
  genderKey: 'MALE' | 'FEMALE',
  notes?: string,
): Promise<BathroomActionResponse> {
  try {
    return await transport().bathroomTimeOut(nativeAdminSessionToken(), userId, genderKey, notes);
  } catch (error) {
    return { success: false, error: bathroomError(error) };
  }
}

export async function bathroomTimeIn(
  logId: string,
  notes?: string,
): Promise<BathroomActionResponse> {
  try {
    return await transport().bathroomTimeIn(nativeAdminSessionToken(), logId, notes);
  } catch (error) {
    return { success: false, error: bathroomError(error) };
  }
}

export async function updateBathroomLog(
  logId: string,
  request: BathroomUpdateRequest,
): Promise<BathroomActionResponse> {
  try {
    return await transport().bathroomUpdateLog(nativeAdminSessionToken(), logId, request);
  } catch (error) {
    return { success: false, error: bathroomError(error) };
  }
}

/** The ID register panel's four commands; each answers with the register's status. */
export const idRegister = {
  status: (): Promise<IdRegisterStatus> => transport().idRegisterStatus(nativeAdminSessionToken()),
  signIn: (email: string, password: string): Promise<IdRegisterStatus> => transport().idRegisterSignIn(nativeAdminSessionToken(), email, password),
  signOut: (): Promise<IdRegisterStatus> => transport().idRegisterSignOut(nativeAdminSessionToken()),
  check: (): Promise<IdRegisterStatus> => transport().idRegisterCheck(nativeAdminSessionToken()),
};

/** What the kiosk says when a register command itself fails (the register's own problems come in plain words). */
export function idRegisterProblem<T>(error: T): string {
  return sentenceFor('idRegister', error, (code) => code || 'The ID register could not be asked.');
}
