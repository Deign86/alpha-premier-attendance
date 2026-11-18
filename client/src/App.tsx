import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, ArrowRight, CircleAlert, CreditCard, Keyboard, KeyRound, LayoutDashboard, LoaderCircle, LockKeyhole, LogIn, LogOut, Nfc, ShieldCheck, Users, WifiOff, X } from "lucide-react";
import type { ScanErrorResponse, ScanSuccessResponse, ScanAdminAssistResponse, SetupUser } from "@rfid-attendance/shared";
import { resolveOfficeDisplay, isLateTimeout, normalizeName } from "@rfid-attendance/shared";
import { DEFAULT_CONFIG, loadAttendance, loadConfig, lockSetup, lookupSetupCard, submitScan, unlockSetup, uploadSetupPhoto, upsertSetupUser, loadBathroomStatus, submitBathroomScan } from "./api";
import { onNetworkStatusChange, getOfflineQueue, removeQueuedScan, isOnline } from "./network";
import "./styles.css";
import { BathroomKioskView, ResultPortrait } from "./bathroom-kiosk-view";
import type { BathroomScanResponse, BathroomStatusResponse } from "@rfid-attendance/shared";
import { listenForGlobalRfid, listenForScannerStatus, listenForDtrSyncHealth, getScannerStatus, setScannerPaused, notifyScanSuccess, detachWhenDone } from "./tauri-api";
import { dtrSyncHealthCopy, dtrSyncNoticeKind, setDtrSyncHealthSnapshot, useDtrSyncHealthSnapshot } from "./dtr-sync-guard";
import type { DtrSyncHealthSnapshot, DtrSyncNoticeKind } from "./dtr-sync-guard";
import { announceAdminAssist, announceAttendance, announceBathroom, announceScanError, loadNameManifest } from "./services/ttsService";
import { UpdateBanner } from "./update-banner";
import { formatDate, formatTime } from "./format";
import type { Notice } from "./notice";
import logoPhoenix from "./assets/branding/logo-phoenix.png";
import { AdminPanel } from "./admin-panel";
import { preparePhotoDataUrl } from "./app-shared";
import { AssistedAttendanceModal } from "./assisted-attendance-modal";
import { LiveAttendance } from "./live-attendance";
import type { ScannerStatus } from "./scanner-status";
import { SetupDialog, emptySetupForm } from "./setup-dialog";
import type { SetupForm, SetupStep } from "./setup-dialog";

type KioskState = "ready" | "processing" | "success" | "error";

type Result = ScanSuccessResponse | ScanErrorResponse;

/** The native pipeline deduplicates device events before they reach the UI. */
const SCAN_DEDUP_WINDOW_MS = 2000;

export function greetingForDate(date: Date, timeZone: string): string {
  const hourPart = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(date)
    .find((part) => part.type === "hour");
  const hour = Number(hourPart?.value ?? 0);
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function shouldRouteGlobalRfidToSetup(
  dialogOpen: boolean,
  token: string,
  step: SetupStep,
): boolean {
  return dialogOpen && Boolean(token) && step === "scan";
}

export default function App() {
  const path = window.location.pathname;
  if (path === "/attendance") return <LiveAttendance />;
  if (path === "/admin") return <AdminPanel />;
  const syncSnapshot = useDtrSyncHealthSnapshot();
  const [state, setState] = useState<KioskState>("ready");
  const [uid, setUid] = useState("");
  const [manualMode, setManualMode] = useState(false);
  const [manualUid, setManualUid] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  // Transient operator hint when the wedge drops a scan (bad charset/length).
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashScanNotice = useCallback((message: string) => {
    setScanNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setScanNotice(null), 3000);
  }, []);
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [now, setNow] = useState(() => new Date());
  const [scannerStatus, setScannerStatus] = useState<ScannerStatus | null>(() =>
    // Keyboard-mode RFID reader uses the kiosk window's key stream.
    "__TAURI_INTERNALS__" in window
      ? null
      : {
          state: "connected",
          message: "Keyboard-mode RFID reader ready",
          detail: "Keep the attendance window focused before scanning",
          mode: "keyboard",
          paused: false,
        },
  );
  useEffect(() => detachWhenDone(listenForDtrSyncHealth((health) => setDtrSyncHealthSnapshot(health))), []);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestController = useRef<AbortController | null>(null);
  const recentScans = useRef(new Map<string, number>());
  // Synchronous in-flight guard: set before the first await so two rapid native
  // scan events can never start two attendance writes for the same tap.
  const scanInFlightRef = useRef(false);
  // Bumped by every armed scan: work that resumes after an await checks it
  // so a slow earlier scan never announces over (or re-times) a newer one.
  // Synchronous assisted-confirm guard: prevents double-post when Confirm is
  // activated twice before busy state propagates, or the auto-close timer
  // fires mid-flight.
  const assistConfirmRef = useRef(false);

  const [setupToken, setSetupToken] = useState("");
  const [setupExpiresAt, setSetupExpiresAt] = useState("");
  const [setupDialogOpen, setSetupDialogOpen] = useState(false);
  const [setupStep, setSetupStep] = useState<SetupStep>("scan");
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupNotice, setSetupNotice] = useState<Notice | null>(null);
  const [adminPin, setAdminPin] = useState("");
  const [setupUid, setSetupUid] = useState("");
  const [setupUser, setSetupUser] = useState<SetupUser | null>(null);
  const [setupForm, setSetupForm] = useState<SetupForm>(emptySetupForm);
  const [adminAssistData, setAdminAssistData] = useState<ScanAdminAssistResponse | null>(null);
  // Stable on purpose: the clock re-renders App every second, and a new onClose
  // each time restarted the modal's 1 s auto-cancel countdown before it fired (S4).
  const closeAssist = useCallback(() => setAdminAssistData(null), []);
  const [assistedBusy, setAssistedBusy] = useState(false);
  const [assistedError, setAssistedError] = useState("");
  const setupInputRef = useRef<HTMLInputElement>(null);
  const setupIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped on close: an unlock that answers after the dialog was closed is stale.
  const setupAttempt = useRef(0);
  const setupSessionTimer = useRef<number | null>(null);

  // Kiosk mode: 1 = Attendance, 2 = Bathroom Key Log
  const [kioskMode, setKioskMode] = useState<"attendance" | "bathroom">("attendance");
  const [bathroomStatus, setBathroomStatus] = useState<BathroomStatusResponse | null>(null);
  const [bathroomScanResult, setBathroomScanResult] = useState<BathroomScanResponse | null>(null);
  const bathroomResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchBathroomStatus = useCallback(async () => {
    try {
      const data = await loadBathroomStatus();
      setBathroomStatus(data);
    } catch (error) {
      // Background refresh: keep stale state, log for diagnostics.
      console.warn("Bathroom status refresh failed.", error);
    }
  }, []);

  useEffect(() => {
    if (kioskMode !== "bathroom") return;
    void fetchBathroomStatus();
    const timer = window.setInterval(fetchBathroomStatus, 5_000);
    return () => window.clearInterval(timer);
  }, [kioskMode, fetchBathroomStatus]);

  // Front-desk headcount: people timed in today who have not timed out yet (null until it first loads).
  const [inOfficeCount, setInOfficeCount] = useState<number | null>(null);
  const fetchInOfficeCount = useCallback(async () => {
    try {
      const data = await loadAttendance();
      if (Array.isArray(data.attendance)) setInOfficeCount(data.attendance.filter((row) => row.status === "WORKING").length);
    } catch (error) {
      // Background refresh: keep the last count, log for diagnostics.
      console.warn("In-office count refresh failed.", error);
    }
  }, []);

  // Every minute, for scans on other devices; and right after a scan is recorded here.
  useEffect(() => {
    void fetchInOfficeCount();
    const timer = window.setInterval(fetchInOfficeCount, 60_000);
    return () => window.clearInterval(timer);
  }, [fetchInOfficeCount]);

  useEffect(() => {
    if (kioskMode === "attendance" && state === "success") void fetchInOfficeCount();
  }, [kioskMode, state, fetchInOfficeCount]);

  // Manual entry is for typing, so put the cursor in the field when it opens.
  const scannerInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (manualMode) scannerInputRef.current?.focus();
  }, [manualMode]);

  useEffect(() => {
    const controller = new AbortController();
    void loadConfig(controller.signal).then(setConfig);
    void loadNameManifest();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const focusSetupInput = useCallback(() => {
    window.requestAnimationFrame(() => setupInputRef.current?.focus());
  }, []);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
      if (bathroomResetTimer.current) clearTimeout(bathroomResetTimer.current);
      requestController.current?.abort();
      if (setupIdleTimer.current) clearTimeout(setupIdleTimer.current);
      if (setupSessionTimer.current) {
        clearInterval(setupSessionTimer.current);
        setupSessionTimer.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    if (!setupToken || !setupExpiresAt) return;
    const deadline = new Date(setupExpiresAt).getTime();
    const checkSession = () => {
      if (Date.now() < deadline) return;
      if (setupSessionTimer.current) {
        clearInterval(setupSessionTimer.current);
        setupSessionTimer.current = null;
      }
      setSetupToken("");
      setSetupExpiresAt("");
      setSetupStep("scan");
      setSetupNotice({ tone: "error", text: "Setup session expired. Unlock again to continue." });
    };
    checkSession();
    setupSessionTimer.current = window.setInterval(checkSession, 1_000);
    return () => {
      if (setupSessionTimer.current) {
        clearInterval(setupSessionTimer.current);
        setupSessionTimer.current = null;
      }
    };
  }, [setupToken, setupExpiresAt]);

  // Attendance is no longer saved offline (owner decision D6); this only
  // drains scans an older version saved, when the network comes back and at
  // start (a service outage never fires "online").
  const replayingOffline = useRef(false);
  useEffect(() => {
    const replay = async () => {
      // One pass at a time: overlapping passes replayed the same items twice.
      if (replayingOffline.current) return;
      replayingOffline.current = true;
      try {
        for (const item of getOfflineQueue()) {
          // Still unreachable (throws) or failing: stop and keep order (a later
          // tap must not land as a time-in before an earlier one). Any other
          // answer is final.
          const res = await submitScan(item.request).catch(() => null);
          if (!res || (!res.success && res.error.code === "INTERNAL_SERVER_ERROR")) break;
          removeQueuedScan(item.id);
        }
      } finally {
        replayingOffline.current = false;
      }
    };
    if (isOnline()) void replay();
    return onNetworkStatusChange((online) => {
      if (online) void replay();
    });
  }, []);

  const resetToReady = useCallback(() => {
    requestController.current?.abort();
    scanInFlightRef.current = false;
    setState("ready");
    setResult(null);
    setBathroomScanResult(null);
    setUid("");
    setManualUid("");
  }, []);

  // Bathroom mode's Type card ID box: it closes and clears after a recorded scan, on Cancel or Escape, on a mode
  // switch, and after a minute without typing, so the kiosk goes back to reading cards.
  const manualToggleRef = useRef<HTMLButtonElement>(null);
  const closeManualEntry = useCallback(() => {
    setManualMode(false);
    setManualUid("");
  }, []);
  const cancelManualEntry = useCallback(() => {
    closeManualEntry();
    window.requestAnimationFrame(() => manualToggleRef.current?.focus());
  }, [closeManualEntry]);
  useEffect(() => {
    if (kioskMode !== "bathroom" || !manualMode) return;
    const timer = window.setTimeout(closeManualEntry, 60_000);
    return () => window.clearTimeout(timer);
  }, [kioskMode, manualMode, manualUid, closeManualEntry]);

  const openSetup = useCallback(
    (initialUid = "") => {
      setSetupDialogOpen(true);
      setSetupNotice(null);
      if (initialUid) setSetupUid(initialUid);
      setAdminPin("");
      if (setupToken) {
        setSetupStep("scan");
        window.setTimeout(focusSetupInput, 0);
      }
    },
    [focusSetupInput, setupToken],
  );

  const unlockSetupWithPinOrCard = useCallback(
    async (pinOrUid: string) => {
      const candidate = pinOrUid.trim();
      if (!candidate || setupBusy) return;
      setSetupBusy(true);
      setSetupNotice(null);
      const attempt = setupAttempt.current;
      try {
        const response = await unlockSetup(candidate);
        if (attempt !== setupAttempt.current) {
          // Closed while unlocking: never reopen an unattended, unlocked setup.
          if (response.success) void lockSetup(response.setupToken);
          return;
        }
        if (!response.success) {
          setSetupNotice({ tone: "error", text: response.error.message });
          return;
        }
        setSetupToken(response.setupToken);
        setSetupExpiresAt(response.expiresAt);
        setAdminPin("");
        setSetupStep("scan");
        setSetupDialogOpen(true);
        window.setTimeout(focusSetupInput, 0);
      } catch (error) {
        setSetupNotice({ tone: "error", text: error instanceof Error ? error.message : "Unable to unlock setup. Please try again." });
      } finally {
        setSetupBusy(false);
      }
    },
    [focusSetupInput, setupBusy],
  );

  const handleUnlock = async (event: React.FormEvent) => {
    event.preventDefault();
    await unlockSetupWithPinOrCard(adminPin);
  };

  const closeSetup = async () => {
    setupAttempt.current += 1;
    if (setupToken) void lockSetup(setupToken);
    if (setupIdleTimer.current) clearTimeout(setupIdleTimer.current);
    setSetupToken("");
    setSetupExpiresAt("");
    setSetupDialogOpen(false);
    setSetupStep("scan");
    setSetupUid("");
    setSetupUser(null);
    setSetupNotice(null);
    setAdminPin("");
    setSetupForm(emptySetupForm);
  };

  const setupSessionExpired = useCallback(() => {
    if (!setupToken || !setupExpiresAt) return false;
    if (Date.now() < new Date(setupExpiresAt).getTime()) return false;
    if (setupSessionTimer.current) {
      clearInterval(setupSessionTimer.current);
      setupSessionTimer.current = null;
    }
    setSetupToken("");
    setSetupExpiresAt("");
    setSetupStep("scan");
    setSetupNotice({ tone: "error", text: "Setup session expired. Unlock again to continue." });
    return true;
  }, [setupToken, setupExpiresAt]);

  const lookupCardForSetup = useCallback(
    async (rawUid: string) => {
      const normalizedUid = rawUid.trim();
      if (!normalizedUid || !setupToken || setupBusy) return;
      if (setupSessionExpired()) return;
      if (setupIdleTimer.current) clearTimeout(setupIdleTimer.current);
      setSetupBusy(true);
      setSetupNotice(null);
      const response = await lookupSetupCard(normalizedUid, setupToken);
      setSetupBusy(false);
      if (!response.success) {
        setSetupNotice({ tone: "error", text: response.error.message });
        return;
      }
      setSetupUid(response.rfidUid);
      setSetupUser(response.user);
      setSetupForm(
        response.user
          ? {
              cardType: response.user.cardType ?? "EMPLOYEE",
              label: response.user.cardType === "ADMIN_ASSIST" ? response.user.fullName : "",
              userId: response.user.userId,
              fullName: response.user.fullName,
              department: response.user.department ?? "",
              status: response.user.status,
              employeeType: response.user.employeeType ?? "INTERN",
              gender: response.user.gender ?? "",
              dailyRate:
                response.user.dailyRate === null
                  ? ""
                  : String(response.user.dailyRate),
              photoUrl: response.user.photoUrl ?? "",
            }
          : emptySetupForm,
      );
      setSetupStep("edit");
    },
    [setupBusy, setupToken, setupSessionExpired],
  );

  const handleSetupInput = useCallback(
    (value: string) => {
      setSetupUid(value);
      if (setupIdleTimer.current) clearTimeout(setupIdleTimer.current);
      if (value.trim())
        setupIdleTimer.current = setTimeout(
          () => void lookupCardForSetup(value),
          config.rfidAutoSubmitDelayMs,
        );
    },
    [config.rfidAutoSubmitDelayMs, lookupCardForSetup],
  );

  const submitSetupUser = async (event: React.FormEvent) => {
    event.preventDefault();
    const isAssist = setupForm.cardType === "ADMIN_ASSIST";
    if (
      !setupToken ||
      !(setupUid ?? "").trim() ||
      (!isAssist && (!setupForm.userId.trim() || !setupForm.fullName.trim())) ||
      setupBusy
    )
      return;
    setSetupBusy(true);
    setSetupNotice(null);
    const cleanUid = (setupUid ?? "").trim().toUpperCase();
    const response = await upsertSetupUser(
      {
        rfidUid: cleanUid,
        userId: isAssist ? `ADMIN_CARD_${cleanUid}` : setupForm.userId.trim().toUpperCase(),
        fullName: isAssist
          ? (setupForm.label.trim() ? normalizeName(setupForm.label) : "Admin Assist Card")
          : normalizeName(setupForm.fullName),
        department: isAssist
          ? "Admin"
          : (setupForm.department.trim().replace(/\s+/g, " ") || undefined),
        status: setupForm.status,
        employeeType: "INTERN",
        gender: isAssist ? null : (setupForm.gender || null),
        dailyRate: null,
        photoUrl: isAssist ? null : (setupForm.photoUrl || null),
        cardType: setupForm.cardType,
        label: setupForm.label.trim() || undefined,
      },
      setupToken,
    );
    setSetupBusy(false);
    if (!response.success) {
      setSetupNotice({ tone: "error", text: response.error.message });
      return;
    }
    if (setupSessionExpired()) return;
    setSetupUser(response.user);
    setSetupNotice({ tone: "success", text: response.created ? "Card enrolled successfully." : "Card configuration updated successfully." });
    setSetupStep("scan");
    setSetupUid("");
    setSetupForm(emptySetupForm);
    window.setTimeout(focusSetupInput, 0);
  };

  const uploadSetupPhotoFile = async (file: File) => {
    if (!setupToken || !setupForm.userId.trim()) {
      setSetupNotice({ tone: "error", text: "Enter the User ID before uploading a photo." });
      return;
    }
    if (setupSessionExpired()) return;
    const isImage =
      ["image/jpeg", "image/png", "image/webp", "image/jpg"].includes(
        file.type.toLowerCase(),
      ) || /\.(jpe?g|png|webp)$/i.test(file.name);
    if (!isImage) {
      setSetupNotice({ tone: "error", text: "Choose a JPEG, PNG, or WebP photo." });
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setSetupNotice({ tone: "error", text: "Photo file must be under 25 MB." });
      return;
    }
    setSetupBusy(true);
    setSetupNotice({ tone: "info", text: "Preparing photo…" });
    let dataUrl: string;
    try {
      dataUrl = await preparePhotoDataUrl(file);
    } catch (error) {
      setSetupBusy(false);
      setSetupNotice({ tone: "error", text: error instanceof Error ? error.message : "Unable to prepare this photo." });
      return;
    }
    setSetupNotice({ tone: "info", text: "Uploading photo…" });
    const response = await uploadSetupPhoto(
      setupForm.userId.trim().toUpperCase(),
      dataUrl,
      setupToken,
    );
    setSetupBusy(false);
    if (!response.success) {
      setSetupNotice({ tone: "error", text: response.error.message });
      return;
    }
    setSetupForm((current) => ({ ...current, photoUrl: response.photoUrl }));
    setSetupNotice({ tone: "success", text: "Photo uploaded and ready to save." });
  };

  // Shared scan pipeline: normalize, dedupe, guard, and arm the request
  // controller identically for attendance and bathroom scans so the two paths
  // can never diverge again (T1 unification).
  const armScanPipeline = (
    rawUid: string,
  ): { normalizedUid: string; controller: AbortController } | null => {
    // The read-only scanner box and the native pipeline both capture the same
    // card tap in the desktop app; drop the second copy so one tap never posts
    // twice (which the backend would reject as a duplicate scan).
    const normalizedUid = rawUid.trim().toUpperCase();
    if (!normalizedUid || scanInFlightRef.current) return null;
    const now = Date.now();
    const previousScanAt = recentScans.current.get(normalizedUid);
    if (
      previousScanAt !== undefined &&
      now - previousScanAt < SCAN_DEDUP_WINDOW_MS
    )
      return null;
    recentScans.current.set(normalizedUid, now);
    if (recentScans.current.size > 128) {
      for (const [key, at] of recentScans.current) {
        if (now - at >= SCAN_DEDUP_WINDOW_MS) recentScans.current.delete(key);
      }
    }
    scanInFlightRef.current = true;
    // A new scan takes over: the last result's reset must not fire mid-request and abort it.
    if (resetTimer.current) clearTimeout(resetTimer.current);
    if (bathroomResetTimer.current) clearTimeout(bathroomResetTimer.current);
    setUid(normalizedUid);
    setState("processing");
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    return { normalizedUid, controller };
  };

  const releaseScanPipeline = (controller: AbortController) => {
    // Abort is a no-op under Tauri invoke: always release the guards so a
    // failed or superseded scan can never wedge the kiosk in processing.
    if (requestController.current === controller) requestController.current = null;
    scanInFlightRef.current = false;
  };

  const submit = useCallback(
    async (rawUid: string, source: "RFID" | "MANUAL_TEST") => {
      const armed = armScanPipeline(rawUid);
      if (!armed) return;
      const { normalizedUid, controller } = armed;
      setResult(null);
      let response: Awaited<ReturnType<typeof submitScan>>;
      try {
        response = await submitScan(
          { rfidUid: normalizedUid, source },
          controller.signal,
        );
      } catch {
        if (controller.signal.aborted) return;
        setState("error");
        setResult(null);
        void announceScanError({
          errorCode: "NETWORK_ERROR",
          message: "Unable to reach attendance service.",
        });
        if (resetTimer.current) clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(resetToReady, config.resultResetDelayMs);
        return;
      } finally {
        releaseScanPipeline(controller);
      }
      if (controller.signal.aborted) return;
      if (response.success && "action" in response && response.action === "ADMIN_ASSIST") {
        setAdminAssistData(response);
        setAssistedError("");
        setState("ready");
        void announceAdminAssist();
        return;
      }
      setResult(response);
      const nextState = response.success ? "success" : "error";
      setState(nextState);
      // Voice announcement: greet the employee on time-in, say goodbye on time-out.
      if (response.success) {
        if (document.visibilityState === "hidden" || !document.hasFocus()) void notifyScanSuccess(response.user.fullName).catch(() => undefined);
        const isLate = response.attendance.status === "LATE_TIMEOUT" || (response.attendance.timeOut ? isLateTimeout(response.attendance.timeOut) : false);
        const arrival = response.action === "TIME_IN" && response.attendance.timeIn
          ? response.attendance.arrivalStatus ?? undefined
          : undefined;
        const isFirstTimeInToday = response.action === "TIME_IN" && response.attendance.isFirstArrivalToday === true;
        void announceAttendance({
          employeeName: response.user.fullName,
          personId: response.user.userId,
          userId: response.user.userId,
          attendanceType: response.action === "TIME_IN" ? "time_in" : "time_out",
          arrivalStatus: arrival,
          attendanceDate: response.attendance.attendanceDate,
          employeeType: response.user.employeeType,
          isLateTimeout: isLate,
          isAssisted: response.attendance.source === "ADMIN_ASSISTED_SCAN",
          isFirstTimeInToday: response.action === "TIME_IN" ? isFirstTimeInToday : undefined,
          timeInIso: response.attendance.timeIn,
        });
      } else {
        void announceScanError({
          errorCode: response.error.code,
          message: response.error.message,
        });
      }
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(resetToReady, config.resultResetDelayMs);
    },
    [config.resultResetDelayMs, config.timezone, resetToReady],
  );

  const handleAssistedConfirm = async (targetUserId: string, reason: string) => {
    // Freeze the card UID and guard re-entry: the 25s auto-close timer or a
    // second Confirm activation must not move or duplicate the in-flight post.
    if (!adminAssistData || assistConfirmRef.current) return;
    assistConfirmRef.current = true;
    const adminCardUid = adminAssistData.adminCard.rfidUid;
    setAssistedBusy(true);
    setAssistedError("");
    try {
      const response = await submitScan({
        rfidUid: adminCardUid,
        source: "ADMIN_ASSISTED_SCAN",
        targetUserId,
        reason,
      });
      setAssistedBusy(false);
      assistConfirmRef.current = false;
      if (response.success && "attendance" in response) {
        setAdminAssistData(null);
        setResult(response);
        setState("success");
        if (document.visibilityState === "hidden" || !document.hasFocus()) void notifyScanSuccess(response.user.fullName).catch(() => undefined);
        const isLate = response.attendance.status === "LATE_TIMEOUT" || (response.attendance.timeOut ? isLateTimeout(response.attendance.timeOut) : false);
        const arrival = response.action === "TIME_IN" && response.attendance.timeIn
          ? response.attendance.arrivalStatus ?? undefined
          : undefined;
        const isFirstTimeInToday = response.action === "TIME_IN" && response.attendance.isFirstArrivalToday === true;
        void announceAttendance({
          employeeName: response.user.fullName,
          personId: response.user.userId,
          userId: response.user.userId,
          attendanceType: response.action === "TIME_IN" ? "time_in" : "time_out",
          arrivalStatus: arrival,
          attendanceDate: response.attendance.attendanceDate,
          employeeType: response.user.employeeType,
          isLateTimeout: isLate,
          isAssisted: true,
          isFirstTimeInToday: response.action === "TIME_IN" ? isFirstTimeInToday : undefined,
          timeInIso: response.attendance.timeIn,
        });
        if (resetTimer.current) clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(resetToReady, config.resultResetDelayMs);
      } else if (!response.success) {
        setAssistedBusy(false);
        assistConfirmRef.current = false;
        setAssistedError(response.error.message);
        void announceScanError({
          errorCode: response.error.code,
          message: response.error.message,
        });
      }
    } catch {
      setAssistedBusy(false);
      assistConfirmRef.current = false;
      const msg = "Failed to record assisted attendance. Please try again.";
      setAssistedError(msg);
      void announceScanError({
        errorCode: "SERVICE_ERROR",
        message: msg,
      });
    }
  };

  const submitBathroom = useCallback(
    async (rawUid: string, source: "RFID" | "MANUAL_TEST") => {
      const armed = armScanPipeline(rawUid);
      if (!armed) return;
      const { normalizedUid, controller } = armed;
      setBathroomScanResult(null);

      try {
        const response = await submitBathroomScan(
          { rfidUid: normalizedUid, source },
          controller.signal,
        );
        if (controller.signal.aborted) return;

        closeManualEntry();
        // The key cards refresh under the result card, so a taken key already shows as in use.
        void fetchBathroomStatus();

        // A success shows the person's ID card in the title's place (photo, key, times); an error its error card.
        setBathroomScanResult(response);
        setState(response.success ? "success" : "error");

        // Voice announcement
        if (response.success) {
          if (document.visibilityState === "hidden" || !document.hasFocus()) {
            void notifyScanSuccess(response.user.fullName).catch(() => undefined);
          }
          void announceBathroom({
            action: response.action,
            genderKey: response.genderKey,
            employeeName: response.user.fullName,
            personId: response.user.userId,
          });
        } else {
          void announceScanError({
            errorCode: response.error.code,
            message: response.error.message,
            activeHolderName: response.activeHolder?.fullName,
            activeHolderId: response.activeHolder?.userId,
            genderKey: response.genderKey,
          });
        }
        // Either card stays for the reset delay, like the time-in card; same reset as attendance, so the card ID box is
        // cleared too. A card tapped meanwhile is read at once (arming it clears this timer) and replaces the card.
        bathroomResetTimer.current = setTimeout(resetToReady, config.resultResetDelayMs);
      } catch {
        if (controller.signal.aborted) return;
        setState("error");
        setBathroomScanResult({
          success: false,
          error: { code: "INTERNAL_ERROR", message: "Bathroom service is temporarily unavailable." },
        });
        closeManualEntry();
        void announceScanError({
          errorCode: "SERVICE_ERROR",
          message: "Bathroom service is temporarily unavailable.",
        });
        if (bathroomResetTimer.current) clearTimeout(bathroomResetTimer.current);
        bathroomResetTimer.current = setTimeout(() => {
          // Same reset as attendance, so the reader box is cleared too.
          resetToReady();
        }, config.resultResetDelayMs);
      } finally {
        releaseScanPipeline(controller);
      }
    },
    [closeManualEntry, config.resultResetDelayMs, fetchBathroomStatus, resetToReady],
  );

  const handleManualKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (kioskMode === "bathroom") {
      void submitBathroom(manualUid, "MANUAL_TEST");
    } else {
      void submit(manualUid, "MANUAL_TEST");
    }
  };

  // Latest scan-routing closure, re-assigned every render so the single native
  // listener always uses fresh state without re-registering (which would risk
  // duplicate listeners while config/setup state settles).
  const scanHandlerRef = useRef<(value: string) => void>(() => {});
  scanHandlerRef.current = (value) => {
    if (adminAssistData) return;
    if (setupDialogOpen && !setupToken) {
      void unlockSetupWithPinOrCard(value);
    } else if (shouldRouteGlobalRfidToSetup(setupDialogOpen, setupToken, setupStep)) {
      handleSetupInput(value);
    } else if (!setupDialogOpen || !setupToken) {
      if (kioskMode === "bathroom") {
        void submitBathroom(value, "RFID");
      } else {
        void submit(value, "RFID");
      }
    }
  };

  // Latest mode switch (assigned below, every render), so the wedge listener's 1/2 keys switch the same way as
  // the tabs without re-registering the listener.
  const switchKioskModeRef = useRef<(mode: "attendance" | "bathroom") => void>(() => {});

  // Keyboard-mode RFID reader scan handling.
  // The reader acts as a keyboard wedge emitting a rapid sequence of keypresses
  // terminated with Enter. Scans are captured only while the kiosk window is focused.
  useEffect(() => {
    let buffer = "";
    let lastKeyAt = 0;
    let modeSwitchTimer: ReturnType<typeof setTimeout> | null = null;

    const resetBuffer = () => {
      buffer = "";
      lastKeyAt = 0;
      if (modeSwitchTimer) {
        clearTimeout(modeSwitchTimer);
        modeSwitchTimer = null;
      }
    };

    const flush = () => {
      const candidate = buffer;
      resetBuffer();
      if (!candidate) return;
      const rawExpectedLength = Number(config.scanner?.expectedLength ?? 10);
      const expectedLength = Number.isFinite(rawExpectedLength) && rawExpectedLength >= 0 ? rawExpectedLength : 10;
      const characterSet = config.scanner?.characterSet ?? "decimal";
      const allowedRegex = characterSet === "hex" ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/;

      if (!allowedRegex.test(candidate)) {
        flashScanNotice("Card not recognized — check the reader format.");
        return;
      }
      if (candidate.length < 4 || candidate.length > 64) {
        flashScanNotice("Card not recognized — check the reader format.");
        return;
      }
      if (expectedLength > 0 && candidate.length !== expectedLength) {
        flashScanNotice("Card not recognized — check the reader format.");
        return;
      }

      const normalized = candidate.toUpperCase();
      if (setupDialogOpen && !setupToken) {
        void unlockSetupWithPinOrCard(normalized);
      } else if (shouldRouteGlobalRfidToSetup(setupDialogOpen, setupToken, setupStep)) {
        handleSetupInput(normalized);
      } else if (manualMode && kioskMode === "bathroom") {
        // A card tapped while Type card ID is open (focus outside its field) isn't read: say how to scan it.
        flashScanNotice("Close Type card ID to scan your card");
      } else if (!manualMode && !setupDialogOpen && !adminAssistData) {
        if (kioskMode === "bathroom") {
          void submitBathroom(normalized, "RFID");
        } else {
          void submit(normalized, "RFID");
        }
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // Bathroom mode's Type card ID box closes on Escape wherever the focus is.
      if (event.key === "Escape" && kioskMode === "bathroom" && manualMode) cancelManualEntry();
      if (!document.hasFocus()) {
        resetBuffer();
        return;
      }
      if (event.key === "Escape") {
        resetBuffer();
        return;
      }
      const target = event.target instanceof HTMLElement ? event.target : null;
      const isTextEntry = Boolean(
        target &&
          (target.matches("textarea, select, [contenteditable='true']") ||
            (target.matches("input") && target.id !== "scanner-uid" && target.id !== "setup-card-uid" && target.id !== "admin-pin")),
      );
      // While any modal dialog is open (e.g. Associate RFID unlock input
      // #admin-pin), keys must go only to the dialog. Without this, typing
      // "2" in the PIN box arms the kiosk mode-switch timer below and flips
      // the background kiosk to Bathroom mode. Scans still work: wedge digits
      // land in the focused input's React state and native scanner events
      // bypass this keyboard-wedge path entirely.
      const isInDialog = Boolean(target?.closest('[role="dialog"]') || setupDialogOpen);
      // Manual entry gets its keys. Bathroom mode's Type card ID box only while the focus is inside it: elsewhere a
      // card tap still fills the buffer, so flush() can say why it wasn't read.
      const typingCardId = manualMode && (kioskMode !== "bathroom" || Boolean(target?.closest(".bathroom-manual-box")));
      if (isInDialog || isTextEntry || typingCardId || adminAssistData || (setupDialogOpen && setupToken && !shouldRouteGlobalRfidToSetup(setupDialogOpen, setupToken, setupStep))) {
        resetBuffer();
        return;
      }

      if (modeSwitchTimer) {
        clearTimeout(modeSwitchTimer);
        modeSwitchTimer = null;
      }

      const now = Date.now();
      const interKeyTimeout = 250;
      if (lastKeyAt > 0 && now - lastKeyAt > interKeyTimeout) {
        resetBuffer();
      }
      lastKeyAt = now;

      if (event.key === "Enter") {
        // The Enter that ends a card tap is the reader's, not the focused button's (with Type card ID open, a lone
        // Enter still presses the button it is on).
        if (buffer || !manualMode) event.preventDefault();
        flush();
        return;
      }

      const characterSet = config.scanner?.characterSet ?? "decimal";
      const allowedCharRegex = characterSet === "hex" ? /^[0-9a-fA-F]$/ : /^[0-9]$/;
      if (allowedCharRegex.test(event.key)) {
        buffer += event.key;
        if (!manualMode && (buffer === "1" || buffer === "2")) {
          const modeKey = buffer;
          modeSwitchTimer = setTimeout(() => {
            if (buffer === modeKey) {
              switchKioskModeRef.current(modeKey === "1" ? "attendance" : "bathroom");
              resetBuffer();
            }
          }, 200);
        }
      } else {
        // Any character outside the configured character set invalidates the buffer immediately.
        resetBuffer();
      }
    };

    const onBlur = () => {
      resetBuffer();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      resetBuffer();
    };
  }, [adminAssistData, cancelManualEntry, config, flashScanNotice, handleSetupInput, kioskMode, manualMode, setupDialogOpen, setupStep, setupToken, submit, submitBathroom, unlockSetupWithPinOrCard]);

  // Native scanner events: card taps arrive here from the Rust layer without
  // any focused webview input. The listener also feeds the card-setup dialog
  // while it is open and awaiting a scan.
  useEffect(() => {
    const stopScan = detachWhenDone(listenForGlobalRfid((value) => scanHandlerRef.current(value)));
    const stopStatus = detachWhenDone(listenForScannerStatus((nextStatus) => setScannerStatus(nextStatus)));
    void getScannerStatus()
      .then((nextStatus) => setScannerStatus(nextStatus))
      .catch(() => {
        /* web mode */
      });
    return () => {
      stopScan();
      stopStatus();
    };
  }, []);

  // While the operator types (admin, setup PIN/form steps, manual entry) the
  // native scanner listener is paused so keystrokes are never misread as card
  // scans. Only the setup dialog's scan step stays live: that is how a new
  // card is enrolled.
  useEffect(() => {
    const paused =
      manualMode ||
      (setupDialogOpen && Boolean(setupToken) && setupStep !== "scan");
    void setScannerPaused(paused).catch(() => {
      /* web mode */
    });
  }, [manualMode, setupDialogOpen, setupStep, setupToken]);

  const toggleManualMode = () => {
    if (state !== "ready") return;
    setManualMode((current) => !current);
    setUid("");
    setManualUid("");
  };

  // Each mode starts ready, in reader mode: an open card ID box, a scan still being read or a result card never
  // carries over to the other mode (attendance would read a bathroom result as "Can't reach the system").
  // resetToReady aborts a scan in flight; its late answer is dropped by the aborted checks after each await,
  // which also cover the desktop app, where the IPC call itself can't be cancelled.
  const switchKioskMode = (mode: "attendance" | "bathroom") => {
    if (mode === kioskMode) return;
    setKioskMode(mode);
    closeManualEntry();
    if (state !== "ready") {
      if (resetTimer.current) clearTimeout(resetTimer.current);
      if (bathroomResetTimer.current) clearTimeout(bathroomResetTimer.current);
      resetToReady();
    }
  };
  switchKioskModeRef.current = switchKioskMode;

  const displayDate = new Intl.DateTimeFormat("en-PH", {
    timeZone: config.timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(now);
  // "Sat, Oct 31, 2026": shown on mid-size screens so the clock side of the header stays within its half.
  const displayDateShort = formatDate(now, config.timezone);
  const displayTime = new Intl.DateTimeFormat("en-PH", {
    timeZone: config.timezone,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(now);

  const success = result?.success ? result : null;
  const error = result && !result.success ? result : null;
  const errorCopy = error ? friendlyScanError(error.error.code, error.error.message) : null;
  const bathroomErrorCopy = bathroomScanResult && !bathroomScanResult.success
    ? friendlyScanError(bathroomScanResult.error.code, bathroomScanResult.error.message)
    : null;

  // Scanner readiness for the compact status pill. Falls back to a neutral
  // state when the native layer is unavailable (browser dev mode).
  const scannerPill = (() => {
    // A scan on screen outranks the reader's own state, which comes back when the result clears.
    if (state === "processing")
      return { label: "Reading…", state: "scanning" as const, detail: "Reading the card" };
    if (state === "success")
      return { label: "Done", state: "connected" as const, detail: "Scan finished" };
    // A repeat tap shows the calm "Already scanned" card, so the pill stays calm too.
    if (state === "error" && error?.error.code === "DUPLICATE_SCAN")
      return { label: "Done", state: "connected" as const, detail: "Card already scanned" };
    if (state === "error")
      return { label: "Error", state: "error" as const, detail: "The scan did not go through" };
    if (!scannerStatus)
      return { label: "Connecting…", state: "scanning" as const, detail: "" };
    switch (scannerStatus.state) {
      case "connected":
        return {
          label: "Ready",
          state: "connected" as const,
          detail: scannerStatus.detail ?? scannerStatus.message,
        };
      case "scanning":
        return {
          label: "Scanning",
          state: "scanning" as const,
          detail: scannerStatus.message,
        };
      case "offline":
        return {
          label: "Offline",
          state: "offline" as const,
          detail: scannerStatus.detail ?? scannerStatus.message,
        };
      case "error":
        return {
          label: "Error",
          state: "error" as const,
          detail: scannerStatus.detail ?? scannerStatus.message,
        };
      default:
        return { label: "Connecting…", state: "scanning" as const, detail: scannerStatus.message };
    }
  })();

  const heroTitle =
    kioskMode === "bathroom"
      ? state === "processing"
        ? "Reading card…"
        : "Bathroom Key Log"
      : state === "processing"
        ? "Reading card…"
        : greetingForDate(now, config.timezone);
  const heroSub =
    kioskMode === "bathroom"
      ? state === "processing"
        ? "Logging bathroom key"
        : manualMode
          ? "Enter a card ID below"
          : "Tap your card on the reader to check out or return a key"
      : state === "processing"
        ? "Checking your attendance"
        : manualMode
          ? "Enter a card ID below"
          : "Tap your card on the reader";

  return (
    <main className={`kiosk-shell state-${state} mode-${kioskMode}`}>
      {/* Gold sparkles rising behind the kiosk (styles.css "Kiosk sparkles"). */}
      <div className="kiosk-ambient" aria-hidden="true">{KIOSK_SPARKLES}</div>
      <header className="kiosk-topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <img src={logoPhoenix} alt="" />
          </div>
          <div className="brand-text">
            <p className="brand-name">ALPHA PREMIER</p>
            <p className="brand-subtitle">
              {resolveOfficeDisplay(config.office, "short")}
            </p>
          </div>
        </div>

        <div className="kiosk-mode-switcher" role="tablist" aria-label="Kiosk scanning mode" data-active={kioskMode}>
          <button
            type="button"
            role="tab"
            data-testid="kiosk-mode-attendance"
            aria-selected={kioskMode === "attendance"}
            className={`kiosk-mode-tab ${kioskMode === "attendance" ? "active" : ""}`}
            onClick={() => switchKioskMode("attendance")}
          >
            <span className="mode-shortcut-badge">1</span> Attendance
          </button>
          <button
            type="button"
            role="tab"
            data-testid="kiosk-mode-bathroom"
            aria-selected={kioskMode === "bathroom"}
            className={`kiosk-mode-tab ${kioskMode === "bathroom" ? "active" : ""}`}
            onClick={() => switchKioskMode("bathroom")}
          >
            <span className="mode-shortcut-badge">2</span> Bathroom Key Log
          </button>
        </div>

        <div className="topbar-cluster">
          {inOfficeCount !== null && (
            <span className="office-count" data-testid="kiosk-in-office" title="Timed in today and not yet timed out">
              <Users size={16} aria-hidden="true" />
              <strong>{inOfficeCount}</strong> in office
            </span>
          )}
          <span
            className={`scanner-pill is-${scannerPill.state}`}
            role="status"
            title={scannerPill.detail}
          >
            <i aria-hidden="true" />
            <span className="scanner-pill-label">{scannerPill.label}</span>
          </span>
          <div
            className="clock"
            aria-label={`Current time in ${config.timezone}`}
          >
            <span className="clock-date-long">{displayDate}</span>
            <span className="clock-date-short">{displayDateShort}</span>
            <strong>{displayTime}</strong>
          </div>
        </div>
      </header>

      <section className="kiosk-stage" aria-label="Kiosk status">
        {/* ATTENDANCE SCAN SUCCESS */}
        {kioskMode === "attendance" && state === "success" && success && (
          <div
            className="kiosk-result is-success"
            data-testid="kiosk-result-success"
            role="status"
            aria-live="polite"
          >
            <div className={`result-card ${success.action === "TIME_IN" ? "is-in" : "is-out"}`}>
              <ResultPortrait photoUrl={success.user.photoUrl} fullName={success.user.fullName} />
              <div className="result-body">
                <span className="result-status">
                  {success.action === "TIME_IN" ? <LogIn size={15} aria-hidden="true" /> : <LogOut size={15} aria-hidden="true" />}
                  {success.action === "TIME_IN" ? "Timed in" : "Timed out"}
                </span>
                <h2 className="result-name">{success.user.fullName}</h2>
                <p className="result-user-id">
                  {success.user.userId}
                  {success.user.department ? ` · ${success.user.department}` : ""}
                </p>
                <dl className="result-times">
                  {success.action === "TIME_OUT" && success.attendance.timeIn && (
                    <div className="result-time is-secondary">
                      <dt>Time in</dt>
                      <dd>{formatTime(success.attendance.timeIn, config.timezone)}</dd>
                    </div>
                  )}
                  <div className="result-time">
                    <dt>{formatAction(success.action)}</dt>
                    <dd>
                      {formatTime(
                        success.attendance.timeOut ?? success.attendance.timeIn,
                        config.timezone,
                      )}
                    </dd>
                  </div>
                </dl>
                {!isStockScanMessage(success.message) && (
                  <p className="result-message">{success.message}</p>
                )}
                <div className="result-meta">
                  <span
                    className={`employee-badge${success.user.employeeType === "INTERN" ? " intern-badge" : ""}`}
                  >
                    {success.user.employeeType === "INTERN" ? "Intern" : "Employee"}
                  </span>
                  {success.attendance.source === "ADMIN_ASSISTED_SCAN" && (
                    <span className="badge badge-assisted">
                      Assisted by {success.attendance.recordedBy || "Admin"}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* BATHROOM SCAN SUCCESS: the person's ID card in the title's place, with the key cards still below it. */}
        {kioskMode === "bathroom" && state === "success" && bathroomScanResult?.success && (
          <div
            className="kiosk-result is-success"
            data-testid="kiosk-result-success"
            role="status"
            aria-live="polite"
          >
            <div className={`result-card ${bathroomScanResult.action === "CHECKOUT" ? "is-in" : "is-out"}`}>
              <ResultPortrait photoUrl={bathroomScanResult.user.photoUrl} fullName={bathroomScanResult.user.fullName} />
              <div className="result-body">
                <span className="result-status">
                  <KeyRound size={15} aria-hidden="true" />
                  {bathroomScanResult.genderKey === "MALE" ? "Male" : "Female"} key {bathroomScanResult.action === "CHECKOUT" ? "taken" : "returned"}
                </span>
                <h2 className="result-name">{bathroomScanResult.user.fullName}</h2>
                <p className="result-user-id">
                  {bathroomScanResult.user.userId}
                  {bathroomScanResult.user.department ? ` · ${bathroomScanResult.user.department}` : ""}
                </p>
                <dl className="result-times">
                  {bathroomScanResult.action === "RETURN" && (
                    <div className="result-time is-secondary">
                      <dt>Taken</dt>
                      <dd>{formatTime(bathroomScanResult.timeOut, config.timezone)}</dd>
                    </div>
                  )}
                  <div className="result-time">
                    <dt>{bathroomScanResult.action === "CHECKOUT" ? "Taken" : "Returned"}</dt>
                    <dd>
                      {formatTime(
                        (bathroomScanResult.action === "CHECKOUT" ? bathroomScanResult.timeOut : bathroomScanResult.timeIn) ?? bathroomScanResult.timestamp,
                        config.timezone,
                      )}
                    </dd>
                  </div>
                </dl>
              </div>
            </div>
          </div>
        )}

        {/* ATTENDANCE SCAN ERROR */}
        {kioskMode === "attendance" && state === "error" && error && error.error.code === "DUPLICATE_SCAN" && (
          <div
            className="kiosk-result is-notice"
            data-testid="kiosk-result-error"
            role="status"
            aria-live="polite"
          >
            <CreditCard className="result-notice-icon" size={42} aria-hidden="true" />
            <h2 className="result-name">Already scanned</h2>
            <p className="result-message">
              This card was just tapped. Please wait a few seconds before tapping again.
            </p>
          </div>
        )}

        {kioskMode === "attendance" && state === "error" && error && error.error.code !== "DUPLICATE_SCAN" && (
          <div
            className="kiosk-result is-error"
            data-testid="kiosk-result-error"
            role="alert"
            aria-live="assertive"
          >
            <CircleAlert
              className="result-error-icon"
              size={42}
              aria-hidden="true"
            />
            <h2 className="result-name">{errorCopy?.title}</h2>
            {errorCopy?.hint && <p className="result-message">{errorCopy.hint}</p>}
            {error.error.code === "UNKNOWN_RFID_CARD" &&
              config.enableCardSetup && (
                <button
                  className="setup-card-button"
                  data-testid="setup-this-card"
                  type="button"
                  onClick={() => openSetup(uid)}
                >
                  <ShieldCheck size={17} /> Set up this card
                </button>
              )}
          </div>
        )}

        {/* ATTENDANCE SERVICE UNREACHABLE: no answer came back for the scan */}
        {kioskMode === "attendance" && state === "error" && !result && (
          <div
            className="kiosk-result is-error"
            data-testid="kiosk-result-unreachable"
            role="alert"
            aria-live="assertive"
          >
            <WifiOff className="result-error-icon" size={42} aria-hidden="true" />
            <h2 className="result-name">Can&apos;t reach the system</h2>
            <p className="result-message">We couldn&apos;t confirm your scan. Please tap your card again.</p>
          </div>
        )}

        {/* BATHROOM SCAN ERROR */}
        {kioskMode === "bathroom" && state === "error" && bathroomScanResult && !bathroomScanResult.success && (
          <div
            className="kiosk-result is-error"
            data-testid="kiosk-result-error"
            role="alert"
            aria-live="assertive"
          >
            <CircleAlert
              className="result-error-icon"
              size={42}
              aria-hidden="true"
            />
            <h2 className="result-name">{bathroomErrorCopy?.title}</h2>
            {bathroomErrorCopy?.hint && <p className="result-message">{bathroomErrorCopy.hint}</p>}
            {bathroomScanResult.activeHolder && (
              <p className="result-holder-detail">
                Currently with <strong>{bathroomScanResult.activeHolder.fullName}</strong> ({bathroomScanResult.activeHolder.department}) since {formatTime(bathroomScanResult.activeHolder.timeOut, config.timezone)}
              </p>
            )}
          </div>
        )}

        {/* The countdown sits right under the result card (bathroom mode: above the key cards). */}
        {(state === "success" || state === "error") && (
          <div className="reset-progress" role="progressbar" aria-label="Returning to ready mode">
            {/* Keyed per scan so the bar restarts when a new result replaces the last one. */}
            <span key={result?.requestId ?? (bathroomScanResult?.success ? bathroomScanResult.timestamp : state)} style={{ animationDuration: `${config.resultResetDelayMs}ms` }} />
          </div>
        )}

        {/* READY / PROCESSING HERO (in bathroom mode the ID card or the error card replaces it) */}
        {((kioskMode === "attendance" && (state === "ready" || state === "processing")) ||
          (kioskMode === "bathroom" && !bathroomScanResult)) && (
          <div className="kiosk-hero">
            <div className={`hero-icon icon-${state}`} aria-hidden="true">
              {state === "processing" ? (
                <LoaderCircle className="spin" size={46} />
              ) : kioskMode === "bathroom" ? (
                <KeyRound size={48} />
              ) : (
                <CreditCard size={48} />
              )}
            </div>
            <h1 id="kiosk-heading">{heroTitle}</h1>
            <p className="hero-sub">{heroSub}</p>
          </div>
        )}

        {/* The reader box is attendance-only; bathroom mode reads cards without it (Type card ID below). */}
        {kioskMode === "attendance" && (state === "ready" || state === "processing") && (
          <div
            className={`scan-console${manualMode ? " is-manual" : ""}`}
            aria-label={manualMode ? "Manual card entry" : "RFID scanner"}
          >
            <div className="scan-console-head">
              <span className="scan-console-title">
                {manualMode ? "Manual card ID" : "RFID reader"}
              </span>
            </div>
            <div className="input-row">
              {!manualMode && (
                <span className="scan-input-icon" aria-hidden="true">
                  <Nfc size={22} />
                </span>
              )}
              <input
                ref={scannerInputRef}
                id="scanner-uid"
                data-testid="scanner-uid"
                aria-label={manualMode ? "Manual card ID" : "Scanner card ID"}
                type="password"
                value={manualMode ? manualUid : (uid ? "•".repeat(Math.max(8, uid.length)) : "")}
                readOnly={!manualMode}
                onChange={(event) => {
                  if (manualMode) setManualUid(event.target.value);
                }}
                onKeyDown={manualMode ? handleManualKeyDown : undefined}
                placeholder={
                  manualMode ? "Enter a card ID" : "Waiting for card…"
                }
                autoComplete="off"
                spellCheck={false}
                disabled={state !== "ready"}
                autoFocus={false}
              />
              {manualMode && (
                <button
                  className="submit-button"
                  data-testid="kiosk-record-submit"
                  type="button"
                  onClick={() => void submit(manualUid, "MANUAL_TEST")}
                  disabled={!manualUid.trim() || state !== "ready"}
                >
                  <ArrowRight size={18} /> Record
                </button>
              )}
            </div>
            <p className="input-hint">
              {manualMode ? (
                <>
                  <Keyboard size={14} /> Press Enter or use the button — a
                  fallback when the reader is unavailable
                </>
              ) : (
                <>No card? Use Manual entry to type the ID.</>
              )}
            </p>
            {scanNotice && (
              <p className="input-hint" role="status" data-testid="kiosk-scan-notice">
                {scanNotice}
              </p>
            )}
          </div>
        )}

        {/* KEY CARDS (always shown in mode 2), right under the title or the result card */}
        {kioskMode === "bathroom" && (
          <BathroomKioskView
            status={bathroomStatus}
            timezone={config.timezone}
            nowMs={now.getTime()}
          />
        )}

        {/* Cards arrive through the wedge listener and native scanner events, so bathroom mode shows no reader box:
            Type card ID opens a small box for someone without their ID. Under an ID card it stays, greyed out (a card
            tap still works); it steps aside while an error card shows, so the error, the cards and the countdown still
            fit a laptop screen. */}
        {kioskMode === "bathroom" && !(bathroomScanResult && !bathroomScanResult.success) && (manualMode ? (
          <div className="bathroom-manual-box" role="group" aria-label="Type card ID">
            <div className="input-row">
              <input
                ref={scannerInputRef}
                id="scanner-uid"
                data-testid="scanner-uid"
                aria-label="Manual card ID"
                type="password"
                value={manualUid}
                onChange={(event) => setManualUid(event.target.value)}
                onKeyDown={handleManualKeyDown}
                placeholder="Enter a card ID"
                autoComplete="off"
                spellCheck={false}
                disabled={state !== "ready"}
              />
              <button
                className="submit-button"
                data-testid="kiosk-record-submit"
                type="button"
                onClick={() => void submitBathroom(manualUid, "MANUAL_TEST")}
                disabled={!manualUid.trim() || state !== "ready"}
              >
                <ArrowRight size={16} /> Record
              </button>
            </div>
            <button className="bathroom-manual-cancel" type="button" aria-label="Cancel" title="Cancel" onClick={cancelManualEntry}>
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        ) : (
          <button
            ref={manualToggleRef}
            className="bathroom-manual-toggle"
            data-testid="kiosk-manual-toggle"
            type="button"
            onClick={toggleManualMode}
            disabled={state !== "ready"}
          >
            <Keyboard size={14} aria-hidden="true" /> Type card ID
          </button>
        ))}
        {kioskMode === "bathroom" && scanNotice && (
          <p className="input-hint" role="status" data-testid="kiosk-scan-notice">
            {scanNotice}
          </p>
        )}
      </section>

      {/* The options row is attendance-only; bathroom mode has Type card ID under the key cards. */}
      {kioskMode === "attendance" && (
        <footer className="kiosk-actions">
          <button
            className="kiosk-action"
            data-testid="kiosk-manual-toggle"
            type="button"
            onClick={toggleManualMode}
            disabled={state !== "ready"}
            aria-pressed={manualMode}
          >
            {manualMode ? <CreditCard size={16} /> : <Keyboard size={16} />}
            {manualMode ? "Use card reader" : "Manual entry"}
          </button>
          <a className="kiosk-action" data-testid="kiosk-link-live" href="/attendance">
            <Activity size={16} /> Live attendance
          </a>
          {config.enableAdmin && (
            <a className="kiosk-action" data-testid="kiosk-link-admin" href="/admin">
              <LayoutDashboard size={16} /> Admin
            </a>
          )}
          {config.enableCardSetup && (
            <button
              className="kiosk-action"
              data-testid="kiosk-setup-open"
              type="button"
              onClick={() => openSetup()}
            >
              <LockKeyhole size={15} /> Admin setup
            </button>
          )}
        </footer>
      )}

      <KioskDtrNotice snapshot={syncSnapshot} />

      {setupDialogOpen && (
        <SetupDialog
          token={setupToken}
          step={setupStep}
          busy={setupBusy}
          notice={setupNotice}
          pin={adminPin}
          uid={setupUid}
          user={setupUser}
          form={setupForm}
          inputRef={setupInputRef}
          onPinChange={setAdminPin}
          onAccountStart={() => {
            setSetupNotice(null);
            setAdminPin("");
          }}
          onAccountUnlocked={(token, expiresAt) => {
            setSetupToken(token);
            setSetupExpiresAt(expiresAt);
            setAdminPin("");
            setSetupNotice(null);
            setSetupStep("scan");
            window.setTimeout(focusSetupInput, 0);
          }}
          onUnlock={handleUnlock}
          onUidChange={handleSetupInput}
          onScanAnother={() => {
            setSetupStep("scan");
            setSetupUid("");
            setSetupUser(null);
            setSetupNotice(null);
            setSetupForm(emptySetupForm);
            window.setTimeout(focusSetupInput, 0);
          }}
          onUidEnter={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void lookupCardForSetup(setupUid);
            }
          }}
          onFormChange={(field, value) =>
            setSetupForm((current) => ({ ...current, [field]: value }))
          }
          onPhotoFile={(file) => void uploadSetupPhotoFile(file)}
          onUpsert={submitSetupUser}
          onClose={closeSetup}
        />
      )}

      {adminAssistData && (
        <AssistedAttendanceModal
          data={adminAssistData}
          onClose={closeAssist}
          onConfirm={handleAssistedConfirm}
          busy={assistedBusy}
          error={assistedError}
        />
      )}

      <UpdateBanner />
    </main>
  );
}

function formatAction(action: ScanSuccessResponse["action"]) {
  return action === "TIME_IN" ? "Time in" : "Time out";
}

/** The action band already says what was recorded, so the backend's stock confirmation is not repeated. */
function isStockScanMessage(message: string): boolean {
  return /^time (in|out) recorded( successfully)?\.?$/i.test(message.trim());
}

/** What the kiosk says for a failed scan: a title and, when people can act on it, a next step. */
type ScanErrorCopy = { title: string; hint: string | null };

/** Plain words and a next step for the scan errors people can act on; any other error keeps the system's own message. */
function friendlyScanError(code: string, message: string): ScanErrorCopy {
  switch (code) {
    case "UNKNOWN_RFID_CARD":
    case "USER_NOT_FOUND":
      return { title: "Card not registered", hint: "Please ask an admin to set up this card." };
    case "INACTIVE_USER":
    case "USER_INACTIVE":
      return { title: "Card inactive", hint: "Please see an admin to turn this card back on." };
    default:
      return { title: message, hint: null };
  }
}

/** The kiosk's rising gold sparkles; each one's position, size and timing come from styles.css. */
const KIOSK_SPARKLES = Array.from({ length: 18 }, (_, index) => <i key={index} />);

/** Desktop app only: a small card when Intern DTR sync needs a look; nothing while it is idle, syncing or simply queued.
    It never takes focus. × hides that kind of problem (a changing count doesn't bring it back) until sync is fine again.
    The live region is always there, so a screen reader announces the card when it appears. */
function KioskDtrNotice({ snapshot }: { snapshot: DtrSyncHealthSnapshot | null }) {
  const kind = snapshot ? dtrSyncNoticeKind(snapshot) : null;
  const [dismissed, setDismissed] = useState<ReadonlySet<DtrSyncNoticeKind>>(() => new Set());
  // Fine again forgets every ×, so a problem coming back later shows again.
  if (!kind && dismissed.size > 0) setDismissed(new Set());
  return (
    <div className="kiosk-dtr-notice-region" role="status" aria-live="polite">
      {snapshot && kind && !dismissed.has(kind) && (
        <div className={`kiosk-dtr-notice${kind === "persistence" || kind === "attention" ? " is-urgent" : ""}`} data-testid="kiosk-dtr-notice">
          <p className="kiosk-dtr-notice-title">DTR sync</p>
          {/* The problem's own sentence even when the heartbeat is late (the kiosk's card never says "delayed"). */}
          <p className="kiosk-dtr-notice-text">{dtrSyncHealthCopy({ ...snapshot, stale: false })}</p>
          {/* No mousedown default, so a click never takes the focus from Manual entry or Type card ID. */}
          <button
            className="kiosk-dtr-notice-close"
            type="button"
            aria-label="Hide DTR sync message"
            title="Hide"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setDismissed(new Set(dismissed).add(kind))}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
