import type { OfficeIdentity } from './office.js';
export type { OfficeIdentity, OfficeDisplayVariant } from './office.js';
export { DEFAULT_OFFICE_IDENTITY, OFFICE_FALLBACK_DISPLAY, composeOfficeAddress, officeCompanyName, officeMetadataLines, resolveOfficeDisplay } from './office.js';

export const scanSources = ['RFID', 'MANUAL_TEST', 'ADMIN_ASSISTED_SCAN', 'ADMIN_BACKDATED_ENTRY'] as const;
export type ScanSource = (typeof scanSources)[number];

export const cardTypes = ['EMPLOYEE', 'ADMIN_ASSIST'] as const;
export type CardType = (typeof cardTypes)[number];

export type ScannerStatus = {
  state: 'connected' | 'scanning' | 'offline' | 'error';
  message: string;
  detail: string | null;
  mode: 'keyboard';
  paused: boolean;
};

export const attendanceActions = ['TIME_IN', 'TIME_OUT'] as const;
export type AttendanceAction = (typeof attendanceActions)[number];

export const userGenders = ['MALE', 'FEMALE'] as const;
export type UserGender = (typeof userGenders)[number];

export const attendanceStatuses = ['WORKING', 'COMPLETED', 'MISSED', 'LATE_TIMEOUT'] as const;
export type AttendanceStatus = (typeof attendanceStatuses)[number];

/**
 * Attendance policy constants. The office does not allow overtime: a time-out
 * recorded strictly after the late-timeout cutoff is saved as `LATE_TIMEOUT`
 * (flagged for manual correction) instead of a normal `COMPLETED` shift.
 */
export const ATTENDANCE_TIMEZONE = 'Asia/Manila';
/** Official start of the workday. Arrivals at or before 08:00 are on time. */
export const OFFICE_HOURS_START = '08:00';
/** Official end of grace period window (8:00 AM - 8:15 AM). */
export const GRACE_PERIOD_END = '08:15';
/** Official end of office hours (5:00 PM / 17:00). */
export const OFFICE_HOURS_END = '17:00';
/** Late time-out cutoff (6:00 PM / 18:00). Time-outs strictly after 17:59 are flagged `LATE_TIMEOUT`. */
export const LATE_TIMEOUT_THRESHOLD = '18:00';
/** Alias for official end of workday / office hours (5:00 PM / 17:00). */
export const WORKDAY_END = OFFICE_HOURS_END;

export type ArrivalStatus = 'ON_TIME' | 'GRACE_PERIOD' | 'LATE' | 'NONE';

/**
 * Returns Monday (YYYY-MM-DD) of the work week for a given Manila date string.
 */
export function getManilaWeekStart(dateStr: string): string {
  const [yearStr, monthStr, dayStr] = dateStr.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return dateStr;
  }
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  const dayOfWeek = utcDate.getUTCDay(); // 0 is Sunday, 1 is Monday...
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const mondayUtc = new Date(Date.UTC(year, month - 1, day + diffToMonday));
  return mondayUtc.toISOString().slice(0, 10);
}

/**
 * Returns the number of standard workdays (Monday through Friday) between
 * two dates (inclusive).
 */
export function countWorkdays(startDateStr: string, endDateStr: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDateStr) || !/^\d{4}-\d{2}-\d{2}$/.test(endDateStr)) {
    return 0;
  }
  const [startYear, startMonth, startDay] = startDateStr.split('-').map(Number);
  const [endYear, endMonth, endDay] = endDateStr.split('-').map(Number);
  const start = new Date(Date.UTC(startYear, startMonth - 1, startDay));
  const end = new Date(Date.UTC(endYear, endMonth - 1, endDay));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return 0;
  }
  let count = 0;
  const current = new Date(start);
  while (current <= end) {
    const day = current.getUTCDay(); // 0 is Sunday, 6 is Saturday
    if (day !== 0 && day !== 6) {
      count++;
    }
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return count;
}


/**
 * Determines arrival evaluation (ON_TIME, GRACE_PERIOD, LATE) across a collection of rows,
 * enforcing that each user receives at most 1 Grace Period (08:00:01 - 08:15:00) per work week.
 */
export function evaluateAttendanceArrivals(
  rows: Array<{ attendanceId: string; userId: string; attendanceDate: string; timeIn?: string | null }>,
): Map<string, { arrivalStatus: ArrivalStatus; minutesLate: number }> {
  const result = new Map<string, { arrivalStatus: ArrivalStatus; minutesLate: number }>();

  // Group by userId and weekStart
  const groups = new Map<string, Array<{ attendanceId: string; userId: string; attendanceDate: string; timeIn: string }>>();
  for (const row of rows) {
    if (!row.timeIn) {
      result.set(row.attendanceId, { arrivalStatus: 'NONE', minutesLate: 0 });
      continue;
    }
    const weekStart = getManilaWeekStart(row.attendanceDate);
    const key = `${row.userId}:${weekStart}`;
    const list = groups.get(key) ?? [];
    list.push({ attendanceId: row.attendanceId, userId: row.userId, attendanceDate: row.attendanceDate, timeIn: row.timeIn });
    groups.set(key, list);
  }

  for (const list of groups.values()) {
    list.sort((a, b) => {
      const d = a.attendanceDate.localeCompare(b.attendanceDate);
      if (d !== 0) return d;
      return a.timeIn.localeCompare(b.timeIn);
    });

    let graceUsedThisWeek = false;

    for (const item of list) {
      const date = new Date(item.timeIn);
      if (!Number.isFinite(date.getTime())) {
        result.set(item.attendanceId, { arrivalStatus: 'NONE', minutesLate: 0 });
        continue;
      }
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: ATTENDANCE_TIMEZONE,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(date);
      const read = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
      const seconds = read('hour') * 3600 + read('minute') * 60 + read('second');
      const startSeconds = 8 * 3600; // 08:00:00
      const graceEndSeconds = 8 * 3600 + 15 * 60; // 08:15:00

      if (seconds <= startSeconds) {
        // <= 08:00:00
        result.set(item.attendanceId, { arrivalStatus: 'ON_TIME', minutesLate: 0 });
      } else if (seconds <= graceEndSeconds) {
        // 08:00:01 - 08:15:00
        if (!graceUsedThisWeek) {
          graceUsedThisWeek = true;
          result.set(item.attendanceId, { arrivalStatus: 'GRACE_PERIOD', minutesLate: 0 });
        } else {
          // Already used 1 weekly GP -> Late!
          const mins = Math.ceil((seconds - startSeconds) / 60);
          result.set(item.attendanceId, { arrivalStatus: 'LATE', minutesLate: mins });
        }
      } else {
        // > 08:15:00 -> Strictly Late
        const mins = Math.ceil((seconds - startSeconds) / 60);
        result.set(item.attendanceId, { arrivalStatus: 'LATE', minutesLate: mins });
      }
    }
  }

  return result;
}

/**
 * Evaluates a single arrival timestamp against office hours policy:
 * - <= 08:00:00: ON_TIME
 * - 08:00:01 - 08:15:00: GRACE_PERIOD
 * - > 08:15:00: LATE
 */
export function evaluateArrivalFromTimestamp(
  timeInIso: string,
  timezone = ATTENDANCE_TIMEZONE,
): ArrivalStatus {
  const date = new Date(timeInIso);
  if (!Number.isFinite(date.getTime())) return 'NONE';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const read = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const seconds = read('hour') * 3600 + read('minute') * 60 + read('second');
  const [startHour, startMinute] = OFFICE_HOURS_START.split(':').map(Number);
  const [graceHour, graceMinute] = GRACE_PERIOD_END.split(':').map(Number);
  const startSeconds = startHour * 3600 + startMinute * 60;
  const graceEndSeconds = graceHour * 3600 + graceMinute * 60;

  if (seconds <= startSeconds) return 'ON_TIME';
  if (seconds <= graceEndSeconds) return 'GRACE_PERIOD';
  return 'LATE';
}

/**
 * True when the Manila-local clock time of a time-out timestamp is strictly
 * after 17:59 (i.e. 18:00 / 6 PM onwards). A time-out up to 17:59 is a normal
 * end-of-day COMPLETED shift; anything at or after 18:00 must be corrected
 * because the office does not allow overtime.
 */
export function isLateTimeout(timeOutIso: string): boolean {
  const date = new Date(timeOutIso);
  if (!Number.isFinite(date.getTime())) return false;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ATTENDANCE_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const minutesSinceMidnight = read('hour') * 60 + read('minute');
  const [cutoffHour, cutoffMinute] = LATE_TIMEOUT_THRESHOLD.split(':').map(Number);
  return minutesSinceMidnight >= cutoffHour * 60 + cutoffMinute;
}

/**
 * True when the Manila-local clock time of a time-out timestamp is strictly
 * before 5:00 PM (17:00:00). A time-out before 5:00 PM is automatically considered
 * a half day.
 */
export function isBeforeFivePm(timeOutIso: string): boolean {
  const date = new Date(timeOutIso);
  if (!Number.isFinite(date.getTime())) return false;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ATTENDANCE_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const secondsSinceMidnight = read('hour') * 3600 + read('minute') * 60 + read('second');
  const [endHour, endMinute] = WORKDAY_END.split(':').map(Number);
  return secondsSinceMidnight < endHour * 3600 + endMinute * 60;
}

/**
 * Normalizes and capitalizes a full name:
 * - Trims leading and trailing whitespace
 * - Collapses consecutive whitespace into a single space
 * - Title-cases each word / name component (handling hyphens, apostrophes, periods, slashes)
 */
export function normalizeName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  return trimmed
    .toLowerCase()
    .replace(/(?:^|[\s\-'’/.])\p{L}/gu, (char) => char.toUpperCase());
}

export type ScanRequest = {
  rfidUid: string;
  source: ScanSource;
  targetUserId?: string;
  reason?: string;
};

export type UserSummary = {
  userId: string;
  fullName: string;
  department: string | null;
  employeeType: 'INTERN' | 'EMPLOYEE';
  photoUrl: string | null;
  /** Honorific basis for spoken greetings (Sir/Ma'am); null when unset. */
  gender: UserGender | null;
};

export type AttendanceSummary = {
  attendanceId: string;
  attendanceDate: string;
  timeIn: string;
  timeOut: string | null;
  status: AttendanceStatus;
  source?: ScanSource;
  recordedBy?: string | null;
  recordedReason?: string | null;
  recordedAt?: string | null;
  /** True only when this TIME_IN created the first attendance row for the date. */
  isFirstArrivalToday?: boolean;
};

export type AttendanceListItem = AttendanceSummary & {
  userId: string;
  fullName: string;
  department: string | null;
};

export type AttendanceListResponse = { success: true; date: string; attendance: AttendanceListItem[]; fetchedAt: string };

export type LanAttendanceSnapshotResponse = {
  success: true;
  serverInstanceId: string;
  snapshotVersion: number;
  date: string;
  attendance: AttendanceListItem[];
  fetchedAt: string;
};

export type LanAttendanceUpdatedEvent = {
  type: 'attendance-updated';
  eventId: string;
  serverInstanceId: string;
  sequence: number;
  occurredAt: string;
  requestId: string;
  attendanceDate: string;
  attendanceId: string;
  cause: 'TIME_IN' | 'TIME_OUT' | 'ADMIN_CORRECTION' | 'ADMIN_DELETE' | 'PAYROLL_RECONCILIATION';
  mutation: 'upsert' | 'delete' | 'refetch';
  attendance: AttendanceListItem | null;
};

export type LanConnectionStatusEvent = {
  type: 'connection-status';
  eventId: string;
  serverInstanceId: string;
  sequence: number;
  occurredAt: string;
  status: 'connected';
  connectionId: string;
};

export type LanStaleDataEvent = {
  type: 'stale-data';
  eventId: string;
  serverInstanceId: string;
  sequence: number;
  occurredAt: string;
  reason: 'event-gap' | 'database-read-failed' | 'server-restarted';
  shouldRefetch: true;
};

export type LanAttendanceEvent = LanAttendanceUpdatedEvent | LanConnectionStatusEvent | LanStaleDataEvent;

export type LanHealthResponse = {
  success: true;
  service: 'alpha-premier-attendance-lan';
  status: 'healthy' | 'degraded';
  serverInstanceId: string;
  timestamp: string;
  timezone: 'Asia/Manila';
  sqlite: 'connected' | 'unavailable';
  lan: { bindAddress: string; port: number; viewerMode: 'read-only'; connectedSseClients: number; uptimeSeconds: number };
  googleSheetsExport: 'connected' | 'offline' | 'disabled';
};

export type LanErrorResponse = {
  success: false;
  requestId: string;
  error: { code: 'INVALID_DATE' | 'VIEWER_AUTH_REQUIRED' | 'VIEWER_AUTH_INVALID' | 'SOURCE_NOT_ALLOWED' | 'DATABASE_UNAVAILABLE' | 'INTERNAL_SERVER_ERROR'; message: string };
};

/**
 * LAN live-attendance viewer contracts (desktop app <-> browser viewer).
 *
 * The LAN viewer is strictly read-only: it exposes today's attendance snapshot
 * and an SSE event stream. It never exposes admin, setup, payroll, mutation,
 * credential, or photo-management surfaces.
 */
export const lanServerStates = ['starting', 'running', 'stopped', 'disabled', 'error'] as const;
export type LanServerState = (typeof lanServerStates)[number];

export const lanNetworkProfiles = ['public', 'private', 'domain', 'unknown'] as const;
export type LanNetworkProfile = (typeof lanNetworkProfiles)[number];

export const lanDiagnosticIssues = [
  'none',
  'not_tauri',
  'config_invalid',
  'port_in_use',
  'firewall_likely_blocked',
  'no_lan_ip',
  'loopback_bind',
  'bind_address_not_present',
  'bind_failed',
] as const;
export type LanDiagnosticIssue = (typeof lanDiagnosticIssues)[number];

/** Firewall allow-rule state for the LAN viewer port, for operator guidance. */
export const lanFirewallRuleStates = ['present', 'missing', 'unknown'] as const;
export type LanFirewallRuleState = (typeof lanFirewallRuleStates)[number];

/** Safe read-only fields exposed for one attendance row on the LAN viewer. */
export type LanAttendanceRow = {
  attendanceId: string;
  attendanceDate: string;
  userId: string;
  fullName: string;
  department: string | null;
  timeIn: string | null;
  timeOut: string | null;
  status: string;
};

/** Status of the in-app LAN attendance viewer server, reported by the desktop app. */
export type LanStatusResponse = {
  success: boolean;
  state: LanServerState;
  /** Auto-start at boot is driven by `lan.enabled` in config.toml. */
  enabled: boolean;
  /** When false, config.toml forbids starting the viewer from the Live Attendance panel. */
  allowRuntimeStart: boolean;
  port: number;
  bindAddress: string | null;
  /** Shareable browser URL, e.g. http://192.168.1.50:4173/attendance (never localhost). */
  viewerUrl: string | null;
  /** Candidate LAN IPs found on this laptop, in preference order. */
  lanIps: string[];
  activeLanIp: string | null;
  networkScope: string;
  networkProfile: LanNetworkProfile;
  configValid: boolean;
  configError: string | null;
  issue: LanDiagnosticIssue;
  connectedSseClients: number;
  startedAt: number | null;
  lastError: string | null;
  /** Allowed client subnets from `lan.allowed_subnets` (empty = any private RFC1918 address). */
  allowedSubnets: string[];
  /** True when the configured bind address (if any) is on an active adapter. */
  configuredBindPresent: boolean;
  /** Local `/api/health` probe: true = reachable, false = unreachable, null = not checked. */
  localHealthOk: boolean | null;
  localHealthError: string | null;
  /** Whether an inbound Windows Firewall allow rule covers the viewer port. */
  firewallAllowRule: LanFirewallRuleState;
  /** Plain-language operator guidance in priority order. */
  guidance: string[];
};

export type LanStartResponse = LanStatusResponse;
export type LanStopResponse = LanStatusResponse;

export type AdminUser = SetupUser;
export type AdminUsersResponse = { success: true; users: AdminUser[] };
export type AdminAttendanceResponse = { success: true; date: string; attendance: AttendanceListItem[]; fetchedAt: string };
export type AdminAttendanceUpdateRequest = {
  timeIn: string | null;
  timeOut: string | null;
  expectedTimeIn: string | null;
  expectedTimeOut: string | null;
};
export type AdminUnlockResponse = { success: true; expiresAt: string };

export const payrollFrequencies = ['SEMI_MONTHLY'] as const;
export type PayrollFrequency = (typeof payrollFrequencies)[number];
export type PayrollProfileId = 'JEAN_TENURED' | 'BEA_STANDARD' | string;

/**
 * Intern payroll policy shared by the server, the desktop payroll commands,
 * and the printable payroll worksheet. Interns earn a fixed PHP 80.00 per day
 * and are charged PHP 10.00 for every full hour of lateness (after the weekly
 * grace already applied at the daily ledger level).
 */
export const INTERN_DAILY_RATE_PHP = 80;
export const INTERN_LATE_DEDUCTION_PER_HOUR_PHP = 10;

/**
 * Payroll profile id stored on intern cutoff records so every payroll record
 * stays auditable. It intentionally does not exist in the payroll_profiles
 * table: intern payroll uses a fixed formula, not a configurable profile.
 */
export const INTERN_PAYROLL_PROFILE_ID = 'INTERN_STANDARD';

export type EmployeeClassification = 'INTERN' | 'EMPLOYEE';

export type PayrollCalculationProfile = {
  profileId: PayrollProfileId;
  label: string;
  payrollFrequency: PayrollFrequency;
  standardWorkingDaysPerCutoff: number;
  incentivesAllowance: number;
  specialAllowance: number;
  specialHolidayMultiplier: number;
  regularHolidayMultiplier: number;
  halfDayFraction: number;
  overtimeRate: number;
};

export type PayrollCutoffRecord = {
  payrollId: string;
  employeeId: string;
  employeeName: string;
  /** Intern vs employee payroll classification; drives intern-specific rules and sheet layout. */
  employeeType: EmployeeClassification;
  payrollProfileId: PayrollProfileId;
  payrollCutoffLabel: string;
  cutoffStart: string;
  cutoffEnd: string;
  payrollFrequency: PayrollFrequency;
  dailyRate: number;
  standardWorkingDays: number;
  actualWorkingDays: number;
  basicPay: number;
  specialHolidayDays: number;
  specialHolidayMultiplier: number;
  specialHolidayPay: number;
  regularHolidayDays: number;
  regularHolidayMultiplier: number;
  regularHolidayPay: number;
  incentivesAllowance: number;
  specialAllowance: number;
  totalCompensation: number;
  totalAllowance: number;
  lateUnits: number;
  lateDeduction: number;
  halfDayCount: number;
  halfDayDeduction: number;
  absentDays: number;
  absenceDeduction: number;
  overtimeHours: number;
  overtimeRate: number;
  overtimePay: number;
  manualAdjustment: number;
  adjustmentReason: string | null;
  grossCompensation: number;
  netPay: number;
  calculationBreakdown: string;
  approvedWorkingDayOverage: boolean;
  status: 'DRAFT' | 'FINALIZED';
  finalizedAt: string | null;
  department?: string;
  designation?: string;
  tin?: string;
  bankName?: string;
  accountNumber?: string;
  hra?: number;
  sss?: number;
  phic?: number;
  hdmf?: number;
  salaryAdvance?: number;
  totalDeductions?: number;
};

export const generatedFileKinds = ['csv', 'xlsx', 'pdf', 'backup', 'report', 'other'] as const;
export type GeneratedFileKind = (typeof generatedFileKinds)[number];

/** Structured metadata returned by every file-generating action so the UI can offer Open/Reveal actions. */
export type GeneratedFileMetadata = {
  /** Absolute path to the generated file, or null when only a directory is available. */
  filePath: string | null;
  /** Absolute path to the containing folder. */
  directoryPath: string | null;
  fileName: string | null;
  fileKind: GeneratedFileKind;
  /** True when the app is running in portable mode (files stored next to the executable). */
  isPortableMode: boolean;
  /** Human-readable summary of what was created. */
  message?: string;
};

/** One portable application backup stored in the app backups directory. */
export type DatabaseBackupInfo = {
  fileName: string;
  filePath: string;
  sizeBytes: number;
  modifiedAt: string | null;
};

/** Status of the local SQLite database for the Data & backup admin panel. */
export type DatabaseInfoResponse = {
  success: true;
  /** Absolute path to the live `attendance.db` file. */
  dbPath: string;
  dataDir: string;
  backupDir: string;
  isPortableMode: boolean;
  /** True when a restore is waiting to be applied on the next launch. */
  restorePending: boolean;
  restoreSourcePath: string | null;
  backups: DatabaseBackupInfo[];
  lastBackupAt: string | null;
  restoreFailed?: string | null;
};

/** Result of creating a database backup; carries the same file actions as other generated files. */
export type DatabaseBackupResponse = { success: true } & GeneratedFileMetadata;

export type PayrollProfilesResponse = { success: true; profiles: PayrollCalculationProfile[] };
export type PayrollCutoffsResponse = { success: true; payroll: PayrollCutoffRecord[] };
export type InternPayrollReportResponse = { success: true; payroll: PayrollCutoffRecord[] };

/** Payroll PDF generation targets: employees only, or interns only. */
export const payrollPdfWorkerTypes = ['employee', 'intern'] as const;
export type PayrollPdfWorkerType = (typeof payrollPdfWorkerTypes)[number];

/**
 * Metadata for one generated payroll PDF. Produced entirely by the Tauri
 * backend (printpdf) and listed in the Payroll tab history; never printed
 * from the browser.
 */
export type PayrollPdfRecord = {
  /** Stable id: the PDF filename without the `.pdf` extension. */
  payrollPdfId: string;
  fileName: string;
  /** Absolute path to the PDF on the local machine (desktop app). */
  filePath: string;
  /** Absolute path to the folder containing the PDF. */
  directoryPath: string;
  cutoffStart: string;
  cutoffEnd: string;
  /** Human period label, e.g. "August 1-15, 2026". */
  payrollCutoffLabel: string;
  workerType: PayrollPdfWorkerType;
  /** ISO timestamp (Asia/Manila). */
  generatedAt: string;
  employeeCount: number;
  /** Sum of gross compensation in PHP. */
  totalAmount: number;
  sizeBytes: number;
};

export type PayrollPdfGenerateRequest = {
  cutoffStart: string;
  cutoffEnd: string;
  payrollCutoffLabel?: string;
  workerType: PayrollPdfWorkerType;
};

export type PayrollPdfGenerateResponse =
  | ({ success: true; pdf: PayrollPdfRecord } & GeneratedFileMetadata)
  | { success: false; error: { message: string } };

export type PayrollPdfListResponse =
  | { success: true; payrollPdfs: PayrollPdfRecord[] }
  | { success: false; error: { message: string } };
export type AttendanceXlsxExportResponse = { success: true; jobId: string; artifactId: string; fileName: string; sizeBytes: number; sha256: string; rowCount: number } & GeneratedFileMetadata;
export type ArtifactExportResponse = { success: true; jobId: string; artifactId: string; fileName: string; sizeBytes: number; sha256: string; rowCount?: number; status?: string } & GeneratedFileMetadata;
export type PayrollCsvExportResponse = { success: true; fileName: string } & GeneratedFileMetadata;

export type ScanSuccessResponse = {
  success: true;
  requestId: string;
  action: AttendanceAction;
  message: string;
  attendance: AttendanceSummary;
  user: UserSummary;
};

export const scanErrorCodes = [
  'SCAN_TIMEOUT',
  'INVALID_SCAN_INPUT',
  'UNKNOWN_RFID_CARD',
  'INACTIVE_USER',
  'DUPLICATE_SCAN',
  'ATTENDANCE_ALREADY_COMPLETED',
  'ATTENDANCE_DATA_CONFLICT',
  'GOOGLE_SHEETS_UNAVAILABLE',
  'PAYROLL_GENERATION_FAILED',
  'RATE_LIMITED',
  'INTERNAL_SERVER_ERROR',
  'CONFIGURATION_ERROR',
  'ADMIN_CARD_REQUIRES_SELECTION',
  'ATTENDANCE_ALREADY_EXISTS_FOR_DATE',
  'BACKDATE_LIMIT_EXCEEDED',
] as const;
export type ScanErrorCode = (typeof scanErrorCodes)[number];

export type ActiveEmployeeSummary = {
  userId: string;
  fullName: string;
  department: string | null;
  photoUrl: string | null;
};

export type ScanAdminAssistResponse = {
  success: true;
  requestId: string;
  action: 'ADMIN_ASSIST';
  message: string;
  adminCard: {
    rfidUid: string;
    label: string;
  };
  activeEmployees: ActiveEmployeeSummary[];
};

export type ScanErrorResponse = {
  success: false;
  requestId: string;
  error: {
    code: ScanErrorCode;
    message: string;
    retryAfterSeconds?: number;
  };
};

export type OfflineScanResponse = {
  success: true;
  offlineQueued: true;
  message: string;
};

export type ScanResponse = ScanSuccessResponse | ScanAdminAssistResponse | ScanErrorResponse | OfflineScanResponse;

export type HealthResponse = {
  success: true;
  service: 'rfid-attendance-api';
  timestamp: string;
  googleSheets: 'connected';
};

export type SafeConfigResponse = {
  success: true;
  timezone: string;
  rfidAutoSubmitDelayMs: number;
  resultResetDelayMs: number;
  enableCardSetup?: boolean;
  enableAdmin?: boolean;
  /** Office identity used for production-facing place labels, exports, and reports. */
  office?: OfficeIdentity;
  scanner?: { mode?: 'keyboard'; paused: boolean; expectedLength: number; characterSet: 'decimal' | 'hex' };
  updater?: { enabled: boolean; autoCheck: boolean; checkIntervalHours: number };
};

export type SetupUser = {
  userId: string;
  rfidUid: string;
  fullName: string;
  department: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  employeeType: 'INTERN' | 'EMPLOYEE';
  gender: UserGender | null;
  dailyRate: number | null;
  payrollProfileId?: PayrollProfileId | null;
  photoUrl: string | null;
  cardType?: CardType;
};

export type SetupUnlockRequest = { pin: string };

export type SetupUnlockResponse = {
  success: true;
  setupToken: string;
  expiresAt: string;
};

export type SetupLookupResponse = {
  success: true;
  rfidUid: string;
  user: SetupUser | null;
};

export type SetupUpsertRequest = {
  rfidUid: string;
  userId?: string;
  fullName?: string;
  department?: string;
  status: 'ACTIVE' | 'INACTIVE';
  employeeType?: 'INTERN' | 'EMPLOYEE';
  gender?: UserGender | null;
  dailyRate?: number | null;
  payrollProfileId?: PayrollProfileId | null;
  photoUrl?: string | null;
  cardType?: CardType;
  label?: string;
};

export type SetupUpsertResponse = {
  success: true;
  created: boolean;
  user: SetupUser;
};

export const setupErrorCodes = [
  'SETUP_DISABLED',
  'INVALID_SETUP_PIN',
  'SETUP_AUTH_REQUIRED',
  'SETUP_SESSION_EXPIRED',
  'SETUP_VALIDATION_ERROR',
  'USER_CONFLICT',
  'GOOGLE_SHEETS_UNAVAILABLE',
] as const;
export type SetupErrorCode = (typeof setupErrorCodes)[number];

export type SetupErrorResponse = {
  success: false;
  error: { code: SetupErrorCode; message: string };
};

export const adminErrorCodes = [
  'ADMIN_DISABLED', 'INVALID_ADMIN_PIN', 'ADMIN_AUTH_REQUIRED', 'ADMIN_SESSION_EXPIRED',
  'ADMIN_VALIDATION_ERROR', 'USER_CONFLICT', 'ATTENDANCE_CONFLICT', 'GOOGLE_SHEETS_UNAVAILABLE',
  'ATTENDANCE_ALREADY_EXISTS_FOR_DATE', 'BACKDATE_LIMIT_EXCEEDED',
] as const;
export type AdminErrorCode = (typeof adminErrorCodes)[number];
export type AdminErrorResponse = { success: false; error: { code: AdminErrorCode; message: string } };

export type AdminBackdatedAttendanceRequest = {
  userId: string;
  attendanceDate: string;
  timeIn: string;
  timeOut?: string | null;
  reason: string;
};

export type AdminBackdatedAttendanceResponse = {
  success: true;
  attendance: AttendanceListItem;
};

export const ttsEngines = ['auto', 'cloned-bea', 'piper', 'system', 'disabled'] as const;
export type TtsEngine = (typeof ttsEngines)[number];

export type TtsSettings = {
  enabled: boolean;
  engine: TtsEngine;
  voiceModel: string;
  rate: number;
  volume: number;
};

export type TtsSpeakOptions = {
  engine?: TtsEngine;
  voiceModel?: string;
  rate?: number;
  volume?: number;
};

export type TtsSpeakResult = {
  success: boolean;
  engineUsed: 'cloned-bea' | 'piper' | 'system' | 'none';
  message?: string;
};

export type TtsStatusResponse = {
  enabled: boolean;
  engine: TtsEngine;
  piperAvailable: boolean;
  piperPath: string | null;
  voiceModelAvailable: boolean;
  voiceModelPath: string | null;
  systemSapiAvailable: boolean;
  isSpeaking: boolean;
};

export const bathroomGenderKeys = ['MALE', 'FEMALE'] as const;
export type BathroomGenderKey = (typeof bathroomGenderKeys)[number];

export const bathroomLogStatuses = ['OUT', 'RETURNED'] as const;
export type BathroomLogStatus = (typeof bathroomLogStatuses)[number];

export type BathroomLogItem = {
  logId: string;
  logDate: string;
  userId: string;
  fullName: string;
  department: string | null;
  genderKey: BathroomGenderKey;
  timeOut: string;
  timeIn: string | null;
  durationSeconds: number | null;
  status: BathroomLogStatus;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

export type BathroomActiveHolder = {
  logId: string;
  userId: string;
  fullName: string;
  department: string | null;
  genderKey: BathroomGenderKey;
  timeOut: string;
};

export type BathroomStatusResponse = {
  success: true;
  date: string;
  maleActive: BathroomActiveHolder | null;
  femaleActive: BathroomActiveHolder | null;
  maleLogs: BathroomLogItem[];
  femaleLogs: BathroomLogItem[];
  fetchedAt: string;
};

export type BathroomTimeOutRequest = {
  userId: string;
  genderKey: BathroomGenderKey;
  notes?: string;
};

export type BathroomTimeInRequest = {
  logId: string;
  notes?: string;
};

export type BathroomUpdateRequest = {
  timeOut?: string;
  timeIn?: string | null;
  notes?: string;
};

export type BathroomActionResponse = {
  success: boolean;
  entry?: BathroomLogItem;
  error?: {
    code: string;
    message: string;
  };
};

export type BathroomScanRequest = {
  rfidUid: string;
  source?: 'RFID' | 'MANUAL_TEST';
};

export type BathroomScanSuccessResponse = {
  success: true;
  action: 'CHECKOUT' | 'RETURN';
  genderKey: BathroomGenderKey;
  user: {
    userId: string;
    fullName: string;
    department: string | null;
    photoUrl: string | null;
    gender: BathroomGenderKey | null;
  };
  timeOut: string;
  timeIn?: string | null;
  durationSeconds?: number | null;
  message: string;
  timestamp: string;
};

export type BathroomScanErrorResponse = {
  success: false;
  error: {
    code: 'BATHROOM_KEY_IN_USE' | 'USER_NOT_FOUND' | 'USER_INACTIVE' | 'ADMIN_CARD_NOT_ALLOWED' | 'GENDER_NOT_SET' | 'INTERNAL_ERROR';
    message: string;
  };
  genderKey?: BathroomGenderKey;
  activeHolder?: BathroomActiveHolder | null;
};

export type BathroomScanResponse = BathroomScanSuccessResponse | BathroomScanErrorResponse;

