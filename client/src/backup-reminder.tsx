import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DatabaseBackup } from "lucide-react";
import { ATTENDANCE_TIMEZONE, type AttendanceListItem, type DatabaseBackupInfo, type UserSummary } from "@rfid-attendance/shared";
import { createDatabaseBackup, loadAdminAttendance, loadDatabaseInfo } from "./api";
import { formatDateTime, formatTime } from "./format";
import { NoticeLine } from "./notice";
import { showToast } from "./toasts";

/** The office (Manila) calendar day of an instant, as the server reads dates: "2026-10-30". */
export function manilaDay(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ATTENDANCE_TIMEZONE }).format(at);
}

function isManilaFriday(at: Date): boolean {
  return new Intl.DateTimeFormat("en-US", { timeZone: ATTENDANCE_TIMEZONE, weekday: "short" }).format(at) === "Fri";
}

/** Calendar days from one office day to another: "2026-10-21" to "2026-10-30" is 9. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** When the newest backup in the list was made; null when there is none with a readable time. */
export function newestBackupAt(backups: readonly DatabaseBackupInfo[]): Date | null {
  let newest: Date | null = null;
  for (const backup of backups) {
    const at = backup.modifiedAt ? new Date(backup.modifiedAt) : null;
    if (at && !Number.isNaN(at.getTime()) && (!newest || at > newest)) newest = at;
  }
  return newest;
}

/** A backup older than this many days turns the Last backup line coral. */
const STALE_AFTER_DAYS = 7;

/** The first line of Data and backup: when the newest backup was made, in coral once it is over a week old or when
 *  there is none. */
export function LastBackupLine({ backups, now }: { backups: readonly DatabaseBackupInfo[]; now: Date }) {
  const newest = newestBackupAt(backups);
  if (!newest) return <p className="db-last-backup is-stale">No backups yet. Create one now.</p>;
  const daysAgo = daysBetween(manilaDay(newest), manilaDay(now));
  if (daysAgo > STALE_AFTER_DAYS) {
    return <p className="db-last-backup is-stale">{`Last backup was ${daysAgo} days ago. Create one now.`}</p>;
  }
  return (
    <p className="db-last-backup">
      Last backup: <strong>{daysAgo === 0 ? `today, ${formatTime(newest)}` : formatDateTime(newest)}</strong>
    </p>
  );
}

type BackupResult = Awaited<ReturnType<typeof createDatabaseBackup>>;
/** The backup being made right now, shared by every button, so two buttons never start two backups. */
let runningBackup: Promise<BackupResult> | null = null;
const runningListeners = new Set<() => void>();
const createdListeners = new Set<() => void>();

function subscribeRunning(listener: () => void): () => void {
  runningListeners.add(listener);
  return () => runningListeners.delete(listener);
}

/**
 * Makes a backup the same way from every button (Data and backup, the Friday reminder): while one runs, a second
 * call gets that same one. A toast says when it worked, and every open backup list and reminder checks again.
 */
export function createBackupNow(): Promise<BackupResult> {
  if (runningBackup) return runningBackup;
  const run = (async () => {
    try {
      const response = await createDatabaseBackup();
      if (response.success) {
        showToast(`Backup created: ${response.fileName}`);
        createdListeners.forEach((listener) => listener());
      }
      return response;
    } finally {
      runningBackup = null;
      runningListeners.forEach((listener) => listener());
    }
  })();
  runningBackup = run;
  runningListeners.forEach((listener) => listener());
  return run;
}

/** True while a backup is being made, so every Create backup now button shows "Saving backup…" and waits. */
export function useBackupRunning(): boolean {
  return useSyncExternalStore(subscribeRunning, () => runningBackup !== null);
}

/** Runs `listener` after every backup made with createBackupNow. */
export function useBackupCreated(listener: () => void): void {
  useEffect(() => {
    createdListeners.add(listener);
    return () => {
      createdListeners.delete(listener);
    };
  }, [listener]);
}

type ReminderUser = Pick<UserSummary, "userId" | "employeeType">;

/**
 * When the last intern timed out today (ms), from today's rows; null while no intern came in or one is still timed
 * in.
 */
function lastInternTimeOut(attendance: readonly AttendanceListItem[], users: readonly ReminderUser[]): number | null {
  const interns = new Set(users.filter((user) => user.employeeType === "INTERN").map((user) => user.userId));
  let last: number | null = null;
  for (const row of attendance) {
    if (!interns.has(row.userId)) continue;
    if (!row.timeOut) return null;
    last = Math.max(last ?? 0, Date.parse(row.timeOut));
  }
  return last;
}

/**
 * True when the Friday backup reminder is due at `now`: it is Friday in Manila, at least one intern timed in today,
 * every one of them has timed out, and no backup was made since the last of them left (a morning or automatic
 * backup doesn't hold the week's last hours). `attendance` holds today's rows.
 */
export function fridayBackupDue(
  now: Date,
  attendance: readonly AttendanceListItem[],
  users: readonly ReminderUser[],
  backups: readonly DatabaseBackupInfo[],
): boolean {
  if (!isManilaFriday(now)) return false;
  const lastOut = lastInternTimeOut(attendance, users);
  if (lastOut === null) return false;
  const newest = newestBackupAt(backups);
  return !newest || newest.getTime() < lastOut;
}

const RECHECK_MS = 5 * 60_000;
/** The office day "Later" was pressed on; the reminder stays hidden for the rest of that day. */
const LATER_KEY = "apg-friday-backup-later";
let reminderClock = () => new Date();

/** Tests pin the reminder's default clock, so admin screens behave the same on any weekday; null puts it back. */
export function setFridayReminderClockForTests(clock: (() => Date) | null): void {
  reminderClock = clock ?? (() => new Date());
}

function readLaterDay(): string | null {
  try {
    return window.localStorage.getItem(LATER_KEY);
  } catch {
    return null;
  }
}

function saveLaterDay(day: string): void {
  try {
    window.localStorage.setItem(LATER_KEY, day);
  } catch {
    /* Storage blocked: hidden until the page reloads. */
  }
}

/**
 * Fridays, once every intern who came in today has timed out and no backup was made since: a calm gold line under
 * the admin header asking for this week's backup. Checks every five minutes and after any backup. Nothing is asked
 * of the server on other days, after "Later" (hidden for the rest of the day) or once a backup covers the day; the
 * backups are read first and today's attendance only when they are there. `now` is the clock (tests pass a Friday).
 */
export function FridayBackupReminder({ users, now }: { users: readonly ReminderUser[]; now?: () => Date }) {
  // The office day the reminder is due for; null while it is not due.
  const [dueDay, setDueDay] = useState<string | null>(null);
  const [laterDay, setLaterDay] = useState<string | null>(readLaterDay);
  const [error, setError] = useState<string | null>(null);
  const backupRunning = useBackupRunning();
  // Only the newest check may write, so a slow answer from before a backup can't bring the reminder back.
  const latest = useRef(0);
  // The office day a backup already covers (made after the last intern left): no more checks that day.
  const coveredDay = useRef<string | null>(null);

  const check = useCallback(async () => {
    const id = ++latest.current;
    const at = (now ?? reminderClock)();
    const day = manilaDay(at);
    const skip =
      !isManilaFriday(at) || !users.some((user) => user.employeeType === "INTERN") || laterDay === day || coveredDay.current === day;
    if (skip) {
      setDueDay(null);
      return;
    }
    try {
      // Backups first: without them (a web browser has none) there is nothing to remind about.
      const info = await loadDatabaseInfo();
      if (id !== latest.current) return;
      if (!info.success) {
        setDueDay(null);
        return;
      }
      const attendance = await loadAdminAttendance(day);
      if (id !== latest.current) return;
      if (!attendance.success) {
        setDueDay(null);
        return;
      }
      const rows = attendance.attendance ?? [];
      const lastOut = lastInternTimeOut(rows, users);
      const newest = newestBackupAt(info.backups);
      if (lastOut !== null && newest && newest.getTime() >= lastOut) coveredDay.current = day;
      setDueDay(fridayBackupDue(at, rows, users, info.backups) ? day : null);
    } catch {
      if (id === latest.current) setDueDay(null);
    }
  }, [now, users, laterDay]);
  const recheck = useCallback(() => void check(), [check]);

  useEffect(() => {
    recheck();
    const timer = window.setInterval(recheck, RECHECK_MS);
    return () => window.clearInterval(timer);
  }, [recheck]);
  useBackupCreated(recheck);

  if (!dueDay || laterDay === dueDay) return null;

  const backUpNow = async () => {
    setError(null);
    const response = await createBackupNow();
    if (response.success) {
      // Made after everyone left, so it covers today.
      coveredDay.current = dueDay;
      setDueDay(null);
    } else setError(response.error.message);
  };

  return (
    <div className="backup-reminder" role="status">
      <DatabaseBackup size={18} aria-hidden="true" />
      <p>It&apos;s Friday and everyone has timed out. Save this week&apos;s backup.</p>
      <div className="backup-reminder-actions">
        <button className="admin-button file-action-primary" type="button" disabled={backupRunning} onClick={() => void backUpNow()}>
          {backupRunning ? "Saving backup…" : "Create backup now"}
        </button>
        <button
          className="text-button"
          type="button"
          disabled={backupRunning}
          onClick={() => {
            saveLaterDay(dueDay);
            setLaterDay(dueDay);
            setError(null);
          }}
        >
          Later
        </button>
      </div>
      <NoticeLine notice={error ? { tone: "error", text: error } : null} />
    </div>
  );
}
