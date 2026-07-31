export const scanSources = ['RFID', 'MANUAL_TEST'] as const;
export type ScanSource = (typeof scanSources)[number];

export const attendanceActions = ['TIME_IN', 'TIME_OUT'] as const;
export type AttendanceAction = (typeof attendanceActions)[number];

export const attendanceStatuses = ['OPEN', 'COMPLETED', 'INCOMPLETE'] as const;
export type AttendanceStatus = (typeof attendanceStatuses)[number];

export type ScanRequest = {
  rfidUid: string;
  source: ScanSource;
};

export type UserSummary = {
  userId: string;
  fullName: string;
  department: string | null;
  employeeType: 'INTERN' | 'EMPLOYEE';
  photoUrl: string | null;
};

export type AttendanceSummary = {
  attendanceId: string;
  attendanceDate: string;
  timeIn: string;
  timeOut: string | null;
  status: AttendanceStatus;
};

export type AttendanceListItem = AttendanceSummary & {
  userId: string;
  fullName: string;
  department: string | null;
};

export type AttendanceListResponse = { success: true; date: string; attendance: AttendanceListItem[]; fetchedAt: string };

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
  signaturePlaceholder: string;
  calculationBreakdown: string;
  approvedWorkingDayOverage: boolean;
  status: 'DRAFT' | 'FINALIZED';
  finalizedAt: string | null;
};

export type PayrollProfilesResponse = { success: true; profiles: PayrollCalculationProfile[] };
export type PayrollCutoffsResponse = { success: true; payroll: PayrollCutoffRecord[] };

export type ScanSuccessResponse = {
  success: true;
  requestId: string;
  action: AttendanceAction;
  message: string;
  attendance: AttendanceSummary;
  user: UserSummary;
};

export const scanErrorCodes = [
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
  'CONFIGURATION_ERROR'
] as const;
export type ScanErrorCode = (typeof scanErrorCodes)[number];

export type ScanErrorResponse = {
  success: false;
  requestId: string;
  error: {
    code: ScanErrorCode;
    message: string;
    retryAfterSeconds?: number;
  };
};

export type ScanResponse = ScanSuccessResponse | ScanErrorResponse;

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
  enableScanSounds: boolean;
  resultResetDelayMs: number;
  enableCardSetup?: boolean;
  enableAdmin?: boolean;
};

export type SetupUser = {
  userId: string;
  rfidUid: string;
  fullName: string;
  department: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  employeeType: 'INTERN' | 'EMPLOYEE';
  dailyRate: number | null;
  payrollProfileId?: PayrollProfileId | null;
  photoUrl: string | null;
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
  userId: string;
  fullName: string;
  department?: string;
  status: 'ACTIVE' | 'INACTIVE';
  employeeType?: 'INTERN' | 'EMPLOYEE';
  dailyRate?: number | null;
  payrollProfileId?: PayrollProfileId | null;
  photoUrl?: string | null;
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
] as const;
export type AdminErrorCode = (typeof adminErrorCodes)[number];
export type AdminErrorResponse = { success: false; error: { code: AdminErrorCode; message: string } };
