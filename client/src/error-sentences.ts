import type { SetupErrorCode, SetupErrorResponse } from '@rfid-attendance/shared';

/**
 * The one place an error code from the desktop app becomes a sentence.
 *
 * The same code can read differently on different screens (an ended session on the attendance editor, on a
 * backdated record, on the ID register), so sentences are grouped by the screen that shows them. A key ending in
 * `*` matches any code that starts with it; a key wrapped in `*` matches a code that contains it.
 */
const SENTENCES = {
  unlock: {
    ADMIN_DISABLED: 'Administrator access is turned off on this kiosk.',
    ADMIN_PIN_LOCKED: 'Too many wrong tries. Typing is paused for 5 minutes; tapping an admin card still works.',
  },
  account: {
    ADMIN_DISABLED: 'Administrator access is turned off on this kiosk.',
    ADMIN_PIN_LOCKED: 'Too many wrong tries. Typing is paused for 5 minutes; tapping an admin card still works.',
    ACCOUNT_SIGN_IN_UNAVAILABLE: 'Account sign-in is not set up in this app build. Use an admin card, or contact IT.',
    INVALID_ACCOUNT: 'The email or password is not right.',
    ACCOUNT_TURNED_OFF: 'This account has been turned off. Ask the CEO.',
    NOT_ATTENDANCE_ADMIN: 'This account is not an attendance admin. The CEO sets that in Keystone, under User Accounts.',
    ACCOUNT_NEEDS_INTERNET: 'There is no internet, and this account has not signed in on this kiosk in the last 7 days. Use an admin card, or try again when the internet is back.',
    ACCOUNT_TRY_LATER: 'Too many tries. Wait a few minutes and try again.',
  },
  accountReset: {
    INVALID_ACCOUNT: 'Type your email address first.',
  },
  userSave: {
    USER_HAS_OPEN_DAY: 'This person is still timed in today. Time them out (or correct the day) before deactivating.',
    USER_HOLDS_BATHROOM_KEY: 'This person still has a bathroom key. Return it before deactivating.',
  },
  attendance: {
    ATTENDANCE_CONFLICT: 'This record was changed by another update. The list was reloaded — check the times and save again.',
    ATTENDANCE_NOT_FOUND: 'This attendance record no longer exists. The list was reloaded.',
    ADMIN_VALIDATION_ERROR: 'The date or time is not valid. Check the times and try again.',
    ADMIN_AUTH_REQUIRED: 'Administrator session expired. Unlock admin to continue.',
    ATTENDANCE_IN_FINALIZED_CUTOFF: 'This day is in a finalized payroll cutoff, so it can\'t be changed.',
    ATTENDANCE_TIME_IN_REQUIRED: 'A record needs a time-in. To remove the day, delete the record instead.',
  },
  backdate: {
    ATTENDANCE_ALREADY_EXISTS_FOR_DATE: 'An attendance record already exists for this employee on this date. Use attendance correction instead.',
    BACKDATE_LIMIT_EXCEEDED: 'Cannot add backdated attendance: date falls within a finalized payroll cutoff.',
    ADMIN_VALIDATION_ERROR: 'Please check the employee, date, time, and reason fields.',
    ADMIN_AUTH_REQUIRED: 'Administrator authentication required.',
    INACTIVE_USER: 'Cannot create attendance for an inactive user.',
    ADMIN_CARD_REQUIRES_SELECTION: 'Cannot create attendance for an Admin RFID card.',
    ADMIN_CARD_NOT_ALLOWED: 'Cannot create attendance for an Admin RFID card.',
  },
  payrollPdf: {
    'NO_PAYROLL_RECORDS*': 'No payroll records exist for these cutoff dates. Generate the cutoff payroll first, then create the PDF.',
    ADMIN_AUTH_REQUIRED: 'Administrator session expired. Unlock admin to continue.',
  },
  payslips: {
    'NO_PAYROLL_RECORDS*': 'No payroll records exist for these cutoff dates. Generate the cutoff payroll first, then create the payslips.',
    ADMIN_AUTH_REQUIRED: 'Administrator session expired. Unlock admin to continue.',
  },
  payrollProfile: {
    PAYROLL_PROFILE_ASSIGNED: 'Reassign employees before deleting this profile.',
  },
  file: {
    FILE_NOT_FOUND: 'The file could not be found. It may have been moved or deleted.',
    DIRECTORY_NOT_FOUND: 'The folder could not be found. It may have been moved or deleted.',
    ADMIN_AUTH_REQUIRED: 'Administrator session expired. Unlock admin to continue.',
  },
  restore: {
    'RESTORE_SOURCE_INVALID*': 'The selected file is not a valid Alpha Premier attendance database.',
    RESTORE_SOURCE_NOT_FOUND: 'The selected file could not be found.',
  },
  idRegister: {
    '*ADMIN_AUTH_REQUIRED*': 'The administrator session ended. Unlock Admin again.',
  },
} as const;

export type ErrorScreen = keyof typeof SENTENCES;

/** What the kiosk setup dialog says, and the code it reports, for each code the desktop app refuses with. */
const SETUP_REFUSALS = {
  SETUP_AUTH_REQUIRED: { code: 'SETUP_AUTH_REQUIRED', message: 'Your setup session expired or was replaced (e.g. by unlocking the Admin panel). Unlock setup again to continue.' },
  SETUP_SESSION_EXPIRED: { code: 'SETUP_SESSION_EXPIRED', message: 'Your setup session expired. Unlock setup again to continue.' },
  INVALID_SETUP_PIN: { code: 'INVALID_SETUP_PIN', message: 'That is not a registered admin RFID card.' },
  INVALID_ADMIN_PIN: { code: 'INVALID_SETUP_PIN', message: 'That is not a registered admin RFID card.' },
  ADMIN_DISABLED: { code: 'SETUP_DISABLED', message: 'Admin setup is disabled in the configuration.' },
  SETUP_DISABLED: { code: 'SETUP_DISABLED', message: 'Admin setup is disabled in the configuration.' },
  SETUP_VALIDATION_ERROR: { code: 'SETUP_VALIDATION_ERROR', message: 'Some form fields are missing or invalid.' },
  ADMIN_PIN_LOCKED: { code: 'ADMIN_PIN_LOCKED', message: SENTENCES.unlock.ADMIN_PIN_LOCKED },
  USER_CONFLICT: { code: 'USER_CONFLICT', message: 'That User ID or RFID card is already in use by another user.' },
  INVALID_USER_ID: { code: 'SETUP_VALIDATION_ERROR', message: 'The User ID may only contain letters, numbers, dashes, underscores, and dots.' },
} satisfies { [code: string]: { code: SetupErrorCode; message: string } };

/** A failure the transport already put into words: the browser adapter's "only in the desktop app" lines. */
export class SpokenFailure extends Error {}

const unreachable = new WeakSet<object>();

/**
 * Browser development only: marks "the legacy server did not answer" on the routes whose callers have always
 * received that as a rejected promise, so `errorCode` passes it on instead of turning it into a result.
 */
export function markUnreachable<T>(error: T): T {
  if (error instanceof Error) unreachable.add(error);
  return error;
}

/** The code (or sentence) a failed command carries. Desktop commands reject with a plain string. */
export function errorCode<T>(error: T): string {
  if (error instanceof Error && unreachable.has(error)) throw error;
  if (error && Object.prototype.toString.call(error) === '[object String]') {
    // SAFETY: Verified error is a string
    return error as string;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return '';
}

function matches(key: string, code: string): boolean {
  if (key.startsWith('*') && key.endsWith('*')) return code.includes(key.slice(1, -1));
  if (key.endsWith('*')) return code.startsWith(key.slice(0, -1));
  return key === code;
}

/** The sentence a screen shows for a code, and the code's key in the table; nothing when the screen has no sentence for it. */
export function knownSentence(screen: ErrorScreen, code: string): { code: string; message: string } | null {
  const found = Object.entries(SENTENCES[screen]).find(([key]) => matches(key, code));
  return found ? { code: found[0], message: found[1] } : null;
}

/** The sentence for a failed command: the transport's own words, else the screen's sentence for the code, else `otherwise`. */
export function sentenceFor<T>(screen: ErrorScreen | null, error: T, otherwise: (code: string) => string): string {
  if (error instanceof SpokenFailure) return error.message;
  const code = errorCode(error);
  const known = screen ? knownSentence(screen, code) : null;
  return known ? known.message : otherwise(code);
}

/**
 * Tauri command errors arrive as the `Err(String)` value (e.g. "SETUP_AUTH_REQUIRED").
 * Map them to a readable setup error instead of masking every failure as an
 * authentication problem — otherwise a user whose session simply expired sees
 * the misleading "Setup authentication is required" with all fields filled.
 */
export function setupErrorFrom<T>(error: T, fallback: SetupErrorCode): SetupErrorResponse {
  const raw = errorCode(error);
  const known = Object.entries(SETUP_REFUSALS).find(([code]) => code === raw);
  if (known) return { success: false, error: known[1] };
  // Unknown backend error: surface the real message so the true cause is visible.
  return { success: false, error: { code: fallback, message: raw || 'The setup request could not be completed.' } };
}
