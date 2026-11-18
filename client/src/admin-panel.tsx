import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Activity, CalendarCheck, ClipboardCheck, Database, KeyRound, LockKeyhole, Nfc, RefreshCcw, Settings, Users, Volume2, Wallet } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { AttendanceListItem, PayrollCutoffRecord } from "@rfid-attendance/shared";
import { resolveOfficeDisplay } from "@rfid-attendance/shared";
import { checkAdminSession, loadAdminAttendance, loadAdminUsers, loadPayrollCutoffs, lockAdmin, nukeSheetsResync, unlockAdmin } from "./api";
import { listenForGlobalRfid, detachWhenDone } from "./tauri-api";
import { VoiceSettingsPanel } from "./voice-settings-panel";
import { UpdateBanner } from "./update-banner";
import { AccountSignInPanel } from './account-sign-in';
import { IdRegisterPanel } from "./id-register-panel";
import { FridayBackupReminder } from "./backup-reminder";
import { BathroomKeyLogPanel } from "./bathroom-key-log";
import { Toasts, showToast } from "./toasts";
import { useListLoad } from "./list-load";
import { AdminAttendance } from "./admin-attendance";
import { DashboardBrand, localDate, useOfficeIdentity } from "./app-shared";
import { ConfirmDialog } from "./confirm-dialog";
import { DatabasePanel, SystemPanel } from "./database-panel";
import { PayrollWorkspace } from "./payroll-workspace";
import { ScannerDiagnostics, useScannerPause } from "./scanner-status";
import { UserEditor } from "./user-editor";
import type { AdminUser } from "./user-editor";

type AdminTab = "users" | "attendance" | "payroll" | "data" | "voice" | "system";

// Attendance corrections first: it is the main reason an admin opens this page. Payroll second, then Users and RFID.
// System (updates, startup, the reader and technical details) last: it is rarely needed.
const ADMIN_TABS = [
  { id: "attendance", label: "Attendance corrections", Icon: ClipboardCheck },
  { id: "payroll", label: "Payroll", Icon: Wallet },
  { id: "users", label: "Users and RFID", Icon: Users },
  { id: "data", label: "Data and backup", Icon: Database },
  { id: "voice", label: "Voice announcements", Icon: Volume2 },
  { id: "system", label: "System", Icon: Settings },
] satisfies { id: AdminTab; label: string; Icon: LucideIcon }[];

type ActiveThumb = { x: number; y: number; width: number; height: number };

/**
 * Where the active button (`button.is-active`) sits inside `ref`, so a thumb or underline can slide to it.
 * Re-measured when `activeKey` changes and whenever the bar or one of its buttons changes size; a measurement that
 * matches the last one changes nothing, so a resize that leaves the button where it was never restarts a slide.
 * `fromRight`: x is the button's left edge counted from the bar's right edge (negative), for a right-aligned bar whose
 * width changes with the choice; its thumb (anchored at the right) then starts each slide exactly where it was.
 */
export function useActiveThumb(ref: { readonly current: HTMLElement | null }, activeKey: string, fromRight = false): ActiveThumb | null {
  const [thumb, setThumb] = useState<ActiveThumb | null>(null);
  const placedRef = useRef<ActiveThumb | null>(null);
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!bar) {
      placedRef.current = null;
      setThumb(null);
      return;
    }
    const place = () => {
      const active = bar.querySelector<HTMLElement>("button.is-active");
      if (!active) return;
      const x = fromRight ? active.offsetLeft - bar.clientWidth : active.offsetLeft;
      const next = { x, y: active.offsetTop, width: active.offsetWidth, height: active.offsetHeight };
      const last = placedRef.current;
      if (last && last.x === next.x && last.y === next.y && last.width === next.width && last.height === next.height) return;
      placedRef.current = next;
      setThumb(next);
    };
    place();
    if (!("ResizeObserver" in window)) return;
    const observer = new ResizeObserver(place);
    // Border boxes, so padding changes at narrow widths move the thumb too.
    observer.observe(bar, { box: "border-box" });
    bar.querySelectorAll("button").forEach((button) => observer.observe(button, { box: "border-box" }));
    return () => observer.disconnect();
  }, [ref, activeKey, fromRight]);
  return thumb;
}

/** The middle strip's own width; it is stretched with scaleX to fill between the two caps (.admin-tabs-thumb). */
const TABS_THUMB_FILL_PX = 100;

/**
 * The admin tabs' (and mode switch's) gold thumb, moved with transforms only, so the browser slides it on its own
 * (compositor) thread and a big page being built for the new tab can't make it jump. It is three pieces sliding
 * together: a left cap and a right cap, each half as wide as the thumb is tall so the round ends are perfect half
 * circles at every width, and a middle strip stretched with scaleX to the tab's width; they overlap by 1px so no seam
 * shows.
 */
function TabsThumb({ thumb }: { thumb: ActiveThumb }) {
  const { x, y, width, height } = thumb;
  const cap = height / 2;
  const fillScale = Math.max(0, width - 2 * cap + 2) / TABS_THUMB_FILL_PX;
  return (
    <span className="admin-tabs-thumb" aria-hidden="true" style={{ height }}>
      <span style={{ width: cap, transform: `translate(${x}px, ${y}px)` }} />
      <span style={{ transform: `translate(${x + cap - 1}px, ${y}px) scaleX(${fillScale})` }} />
      <span style={{ width: cap, transform: `translate(${x + width - cap}px, ${y}px)` }} />
    </span>
  );
}

/** The newest time-in or time-out among the rows; null when there is none. */
function newestPunchAt(rows: readonly AttendanceListItem[]): string | null {
  let newest: string | null = null;
  for (const row of rows) {
    for (const at of [row.timeIn, row.timeOut]) {
      if (at && (!newest || Date.parse(at) > Date.parse(newest))) newest = at;
    }
  }
  return newest;
}

export function AdminPanel() {
  const [unlocked, setUnlocked] = useState(false);
  // False until the saved session has been checked: the page stays empty meanwhile, so an admin who is still signed
  // in goes straight to the dashboard instead of seeing the unlock card flash first.
  const [sessionChecked, setSessionChecked] = useState(false);
  useScannerPause(unlocked);
  const office = useOfficeIdentity();
  const [sessionExpiresAt, setSessionExpiresAt] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [adminMode, setAdminMode] = useState<"attendance" | "bathroom">("attendance");
  const [tab, setTab] = useState<AdminTab>("attendance");
  // The gold thumb behind the current tab; measured so it can slide between tabs of different widths.
  const tabsRef = useRef<HTMLDivElement>(null);
  // The same kind of thumb behind the chosen mode; only the chosen mode shows its name, so it grows and shrinks too.
  const modeRef = useRef<HTMLDivElement>(null);
  const [date, setDate] = useState(localDate());
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [busy, setBusy] = useState(false);
  const [nuking, setNuking] = useState(false);
  const [nukeConfirmOpen, setNukeConfirmOpen] = useState(false);
  const [manualUpdateCheck, setManualUpdateCheck] = useState<number>(0);
  const [withAccount, setWithAccount] = useState(false);
  // An admin card tap can unlock while the account sign-in is open; a later expiry must land on the card, not on it.
  useEffect(() => {
    if (unlocked) setWithAccount(false);
  }, [unlocked]);
  // Unsaved typing in User registration or in Attendance corrections: anything that would close that tab asks first.
  const [usersDirty, setUsersDirty] = useState(false);
  const [attendanceDirty, setAttendanceDirty] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const guardUnsaved =
    adminMode === "attendance" && ((usersDirty && tab === "users") || (attendanceDirty && tab === "attendance"));
  const leaveSection = (action: () => void) => {
    if (guardUnsaved) setPendingLeave(() => action);
    else action();
  };
  // Set once a discard is confirmed for a link, so the browser doesn't ask a second time on the way out.
  const leavingRef = useRef(false);
  const leaveLink = (event: React.MouseEvent<HTMLAnchorElement>) => {
    // Ctrl/Cmd/Shift/middle clicks open a new tab or window, which keeps this page and its typing.
    if (!guardUnsaved || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const href = event.currentTarget.href;
    setPendingLeave(() => () => {
      leavingRef.current = true;
      window.location.assign(href);
    });
  };
  // Closing or reloading the window: the browser shows its own "Leave site?" prompt.
  useEffect(() => {
    if (!guardUnsaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      if (!leavingRef.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [guardUnsaved]);
  // A prompt left open when the session locks must not come back (and run its old action) after unlocking.
  useEffect(() => {
    if (!unlocked) setPendingLeave(null);
  }, [unlocked]);

  // sessionChecked too: the bar first appears when the session check ends, which can be a render after `unlocked`.
  const tabThumb = useActiveThumb(tabsRef, `${sessionChecked}:${unlocked}:${adminMode}:${tab}`);
  // Counted from the right: the switch sits at the right and widens or narrows to the left with the chosen name.
  const modeThumb = useActiveThumb(modeRef, `${sessionChecked}:${unlocked}:${adminMode}`, true);
  // The page under the tabs follows the chosen tab at low priority, so the tab bar and its thumb update (and start
  // sliding) in the same frame as the click, even when the new page is a big one like Payroll.
  const shownTab = useDeferredValue(tab);

  const unlockWithPinOrRfid = useCallback(
    async (candidate: string) => {
      const trimmed = candidate.trim();
      if (!trimmed || busy) return;
      setBusy(true);
      setError("");
      const response = await unlockAdmin(trimmed);
      setBusy(false);
      if (!response.success) {
        setError(response.error.message);
        return;
      }
      setUnlocked(true);
      setSessionExpiresAt(response.expiresAt);
      setPin("");
      setError("");
    },
    [busy],
  );

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    await unlockWithPinOrRfid(pin);
  };

  useEffect(() => {
    if (!unlocked) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const isTextEntry = Boolean(
        target &&
          (target.matches("input, textarea, select, [contenteditable='true']") ||
            target.isContentEditable),
      );
      // No mode switching while a pop-up or prompt is open (it would replace or stack on the waiting choice).
      if (isTextEntry || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (event.key === "1") {
        setAdminMode("attendance");
      } else if (event.key === "2") {
        if (guardUnsaved) setPendingLeave(() => () => setAdminMode("bathroom"));
        else setAdminMode("bathroom");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [unlocked, guardUnsaved]);

  // An admin card tap unlocks, but only once the session check is done, so a tap can't race its answer.
  useEffect(() => {
    if (unlocked || !sessionChecked) return;
    return detachWhenDone(listenForGlobalRfid((scannedUid) => {
      void unlockWithPinOrRfid(scannedUid);
    }));
  }, [sessionChecked, unlocked, unlockWithPinOrRfid]);

  const nukeSheets = async () => {
    setNukeConfirmOpen(false);
    setNuking(true);
    setError("");
    const response = await nukeSheetsResync(true);
    setNuking(false);
    if (response.success) {
      showToast("Google Sheets wiped; re-export queued from SQLite.");
    } else {
      setError(response.error?.message ?? "Unable to reset Google Sheets.");
    }
  };
  // Users, attendance and payroll load on their own: each shows its own loading rows and Retry, and one failing
  // never blocks the other tabs.
  const fetchUsers = useCallback(async (): Promise<AdminUser[]> => {
    const response = await loadAdminUsers();
    if (!response.success) throw new Error("Users did not load.");
    return response.users ?? [];
  }, []);
  const fetchRows = useCallback(async (): Promise<AttendanceListItem[]> => {
    const response = await loadAdminAttendance(date);
    if (!response.success) throw new Error("Attendance did not load.");
    return response.attendance ?? [];
  }, [date]);
  const fetchCutoffs = useCallback(async (): Promise<PayrollCutoffRecord[]> => {
    const response = await loadPayrollCutoffs();
    if (!response.success) throw new Error("Payroll did not load.");
    return response.payroll ?? [];
  }, []);
  const usersList = useListLoad(fetchUsers, [], unlocked);
  const rowsList = useListLoad(fetchRows, [], unlocked);
  const cutoffsList = useListLoad(fetchCutoffs, [], unlocked);
  // The reader's "last scan" (it reports no scan times itself): the newest time in today's rows. It stays while
  // another date is open, so looking at an older day doesn't hide it.
  const [lastScanAt, setLastScanAt] = useState<string | null>(null);
  useEffect(() => {
    if (date === localDate() && rowsList.status === "ready") setLastScanAt(newestPunchAt(rowsList.data));
  }, [date, rowsList.status, rowsList.data]);
  const users = usersList.data;
  // After a save or delete every list refreshes in place (names and pay can change with it).
  const refreshUsers = usersList.refresh;
  const refreshCutoffs = cutoffsList.refresh;
  // Attendance refreshes through a ref: a save that finishes after the date changed refreshes the new date's
  // rows, never the old date's (an old refresh would leave the new date loading).
  const refreshRowsRef = useRef(rowsList.refresh);
  useLayoutEffect(() => {
    refreshRowsRef.current = rowsList.refresh;
  }, [rowsList.refresh]);
  // Resolves once all three have answered, so a saved attendance row can wait for its new times.
  const load = useCallback(async () => {
    await Promise.all([refreshUsers(), refreshRowsRef.current(), refreshCutoffs()]);
  }, [refreshUsers, refreshCutoffs]);
  useEffect(() => {
    void checkAdminSession()
      .then((expiresAt) => {
        setSessionExpiresAt(expiresAt ?? "");
        setUnlocked(Boolean(expiresAt));
      })
      .finally(() => setSessionChecked(true));
  }, []);
  useEffect(() => {
    if (!unlocked || !sessionExpiresAt) return;
    const remaining = new Date(sessionExpiresAt).getTime() - Date.now();
    if (remaining <= 0) {
      void lockAdmin();
      setUnlocked(false);
      setSessionExpiresAt("");
      setError("Admin session expired. Please unlock again.");
      return;
    }
    const timer = window.setTimeout(() => {
      void lockAdmin();
      setUnlocked(false);
      setSessionExpiresAt("");
      setError("Admin session expired. Please unlock again.");
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [sessionExpiresAt, unlocked]);
  // The chosen tab's page, rebuilt only when the deferred tab or its own data changes: a tab click's urgent render
  // (tab bar and thumb) skips it, and the new page follows at low priority.
  const tabPage = useMemo(
    () =>
      shownTab === "users" ? (
        <UserEditor
          users={users}
          editing={editing}
          setEditing={setEditing}
          onSaved={load}
          onDirtyChange={setUsersDirty}
          loadStatus={usersList.status}
          onRetry={() => void usersList.reload()}
        />
      ) : shownTab === "attendance" ? (
        <AdminAttendance
          rows={rowsList.data}
          date={date}
          setDate={setDate}
          users={users}
          onSaved={load}
          onDirtyChange={setAttendanceDirty}
          loadStatus={rowsList.status}
          onRetry={() => void rowsList.reload()}
        />
      ) : shownTab === "payroll" ? (
        <PayrollWorkspace
          records={cutoffsList.data}
          onSaved={load}
          loadStatus={cutoffsList.status}
          onRetry={() => void cutoffsList.reload()}
        />
      ) : shownTab === "voice" ? (
        <VoiceSettingsPanel />
      ) : shownTab === "system" ? (
        <>
          <SystemPanel onManualUpdateCheck={() => setManualUpdateCheck(Date.now())} lastScanAt={lastScanAt} />
          <IdRegisterPanel />
        </>
      ) : (
        <DatabasePanel />
      ),
    [shownTab, users, editing, load, usersList.status, usersList.reload, rowsList.data, rowsList.status, rowsList.reload, date, cutoffsList.data, cutoffsList.status, cutoffsList.reload, lastScanAt],
  );
  if (!sessionChecked)
    return (
      <main className="dashboard-shell admin-shell" aria-busy="true">
        <p className="visually-hidden" role="status">Checking admin session…</p>
      </main>
    );
  if (!unlocked && withAccount)
    return (
      <main className="dashboard-shell admin-login admin-shell">
        <a href="/"><Nfc size={16} aria-hidden="true" /> Scanner</a>
        <AccountSignInPanel
          onUnlocked={(expiresAt) => {
            setWithAccount(false);
            setUnlocked(true);
            setSessionExpiresAt(expiresAt);
            setPin("");
            setError("");
          }}
          onBack={() => setWithAccount(false)}
        />
      </main>
    );
  if (!unlocked)
    return (
      <main className="dashboard-shell admin-login admin-shell">
        <a href="/"><Nfc size={16} aria-hidden="true" /> Scanner</a>
        <form onSubmit={unlock}>
          <DashboardBrand />
          <p className="section-kicker">Administrator access</p>
          <h1>Manage attendance</h1>
          <p className="setup-copy" style={{ marginBottom: "1rem" }}>
            Scan a registered admin RFID card, or sign in with your Keystone account.
          </p>
          <label>
            Admin RFID card
            <input
              autoFocus
              type="password"
              placeholder="Scan admin card…"
              value={pin}
              onChange={(event) => setPin(event.target.value)}
            />
          </label>
          {error && <p className="dashboard-alert">{error}</p>}
          <button className="submit-button" disabled={busy || !pin.trim()}>
            Unlock admin
          </button>
          <button
            className="text-button"
            type="button"
            onClick={() => {
              setError("");
              setPin("");
              setWithAccount(true);
            }}
          >
            Sign in with your Keystone account
          </button>
        </form>
      </main>
    );
  return (
    <main className="dashboard-shell admin-shell">
      {/* On the page itself, no card: the brand block on the left, the reader status and page buttons on the right. */}
      <header className="dashboard-header">
        <div className="admin-title">
          <DashboardBrand />
          <p className="section-kicker">Administrator access</p>
          <h1>Manage attendance</h1>
          <p className="section-description">
            {resolveOfficeDisplay(office, "short")}
          </p>
        </div>
        <div className="admin-header-actions">
          <ScannerDiagnostics lastScanAt={lastScanAt} />
          <nav>
            <a href="/" onClick={leaveLink}><Nfc size={16} aria-hidden="true" /> Scanner</a>
            <a href="/attendance" onClick={leaveLink}><Activity size={16} aria-hidden="true" /> Live view</a>
            {import.meta.env.DEV && (
              <button
                className="text-button is-danger"
                type="button"
                disabled={nuking}
                onClick={() => setNukeConfirmOpen(true)}
              >
                <RefreshCcw size={16} aria-hidden="true" />
                {nuking ? "Nuking…" : "Nuke & resync Sheets"}
              </button>
            )}
            <button
              className="text-button"
              type="button"
              onClick={() =>
                leaveSection(() => {
                  void lockAdmin();
                  setUnlocked(false);
                  setSessionExpiresAt("");
                })
              }
            >
              <LockKeyhole size={16} aria-hidden="true" />
              Lock
            </button>
          </nav>
        </div>
      </header>
      <FridayBackupReminder users={users} />
      {/* Two separate glass bars on one row: the section tabs (Attendance mode only) and the mode switch. */}
      <div className="admin-toolbar">
        {adminMode === "attendance" && (
          <div className="admin-tabs" ref={tabsRef}>
            {tabThumb && <TabsThumb thumb={tabThumb} />}
            {ADMIN_TABS.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                className={tab === id ? "is-active" : ""}
                aria-current={tab === id ? "page" : undefined}
                onClick={() => (id === tab ? undefined : leaveSection(() => setTab(id)))}
              >
                <Icon size={16} aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>
        )}
        {/* Minimal: icons, with the name of the chosen mode only; the 1/2 keys are in each name and tooltip. */}
        <div className="admin-mode-switcher" role="tablist" aria-label="Administrator mode switcher" ref={modeRef}>
          {modeThumb && <TabsThumb thumb={modeThumb} />}
          <button
            type="button"
            role="tab"
            aria-selected={adminMode === "attendance"}
            aria-label="Attendance (shortcut 1)"
            title="Attendance (shortcut 1)"
            className={`admin-mode-btn ${adminMode === "attendance" ? "is-active" : ""}`}
            onClick={() => setAdminMode("attendance")}
          >
            <CalendarCheck size={15} aria-hidden="true" />
            {adminMode === "attendance" && <span className="admin-mode-label">Attendance</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={adminMode === "bathroom"}
            aria-label="Bathroom Key Log (shortcut 2)"
            title="Bathroom Key Log (shortcut 2)"
            className={`admin-mode-btn ${adminMode === "bathroom" ? "is-active" : ""}`}
            onClick={() => leaveSection(() => setAdminMode("bathroom"))}
          >
            <KeyRound size={15} aria-hidden="true" />
            {adminMode === "bathroom" && <span className="admin-mode-label">Bathroom Key Log</span>}
          </button>
        </div>
      </div>
      {adminMode === "bathroom" ? (
        <BathroomKeyLogPanel users={users} />
      ) : (
        <>
          {error && <p className="dashboard-alert">{error}</p>}
          {tabPage}
        </>
      )}
      <ConfirmDialog
        open={pendingLeave !== null}
        busy={false}
        tone="danger"
        title="Discard unsaved changes?"
        message={`You have unsaved changes in ${tab === "attendance" ? "Attendance corrections" : "User registration"}. Leaving now discards them.`}
        cancelLabel="Keep editing"
        confirmLabel="Discard changes"
        onCancel={() => setPendingLeave(null)}
        onConfirm={() => {
          // Every waiting action closes the guarded tab (it then reports "clean") or leaves the page.
          const action = pendingLeave;
          setPendingLeave(null);
          action?.();
        }}
      />
      <ConfirmDialog
        open={nukeConfirmOpen}
        busy={nuking}
        tone="danger"
        title="Wipe Google Sheets?"
        message="This will wipe all Google Sheets data and re-export everything from SQLite. This cannot be undone."
        confirmLabel="Wipe Sheets"
        onCancel={() => setNukeConfirmOpen(false)}
        onConfirm={() => void nukeSheets()}
      />
      <UpdateBanner manualCheckTrigger={manualUpdateCheck} beforeInstall={leaveSection} />
      <Toasts />
    </main>
  );
}
