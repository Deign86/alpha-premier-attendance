import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  BookOpen,
  CalendarPlus,
  Check,
  ChevronDown,
  CircleAlert,
  ClipboardCheck,
  Clock,
  CloudOff,
  CreditCard,
  Database,
  Download,
  History,
  ImagePlus,
  Keyboard,
  KeyRound,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  LogIn,
  LogOut,
  Nfc,
  Plus,
  PlusCircle,
  RefreshCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Upload,
  UserCheck,
  UserRound,
  Users,
  Volume2,
  Wallet,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type {
  ScanErrorResponse,
  ScanSuccessResponse,
  ScanAdminAssistResponse,
  CardType,
  SetupUser,
  UserGender,
  AttendanceListItem,
  PayrollCutoffRecord,
  CutoffCalculationBreakdownData,
  AttendanceDeductionItem,
  OfficeIdentity,
  LanStatusResponse,
  DatabaseInfoResponse,
  PayrollPdfRecord,
  ArrivalStatus,
} from "@rfid-attendance/shared";
import {
  DEFAULT_OFFICE_IDENTITY,
  resolveOfficeDisplay,
  INTERN_DAILY_RATE_PHP,
  INTERN_LATE_DEDUCTION_PER_HOUR_PHP,
  LATE_TIMEOUT_THRESHOLD,
  ATTENDANCE_TIMEZONE,
  isNoGraceDate,
  isLateTimeout,
  normalizeName,
  evaluateArrivalFromTimestamp,
  evaluateAttendanceArrivals,
  getManilaWeekStart,
  countWorkdays,
} from "@rfid-attendance/shared";
import {
  DEFAULT_CONFIG,
  checkAdminSession,
  createDatabaseBackup,
  deletePayrollCutoff,
  deleteAdminAttendance,
  deleteAdminUser,
  dismissRestoreFailure,
  finalizePayrollCutoff,
  getLanStatus,
  loadAttendance,
  loadAdminAttendance,
  loadAdminUsers,
  loadConfig,
  loadDatabaseInfo,
  loadDtrSyncHealth,
  getInternDtrSync,
  setInternDtrSync,
  loadPayrollCutoffs,
  lockAdmin,
  lockSetup,
  lookupSetupCard,
  nukeSheetsResync,
  syncInternDtr,
  openDatabaseBackupsFolder,
  saveBackupCopy,
  openViewerUrl,
  photoSource,
  requestDatabaseRestore,
  saveAdminAttendance,
  saveAdminUser,
  savePayrollCutoff,
  generatePayrollCutoff,
  generateInternPayslipImages,
  generatePayrollPdf,
  loadPayrollPdfs,
  openGeneratedDirectory,
  openGeneratedFile,
  revealGeneratedFile,
  startLanViewer,
  stopLanViewer,
  submitScan,
  unlockAdmin,
  unlockSetup,
  uploadAdminPhoto,
  uploadSetupPhoto,
  upsertSetupUser,
  createAdminBackdatedAttendance,
  loadBathroomStatus,
  submitBathroomScan,
  loadVoiceClipStates,
  loadVoiceWorkerStatus,
  pollVoiceClipReady,
  regenerateVoiceClip,
} from "./api";
import { sseUrl, onNetworkStatusChange, getOfflineQueue, removeQueuedScan, isOnline } from "./network";
import type { FileActionResult } from "./api";
import type { DtrSyncHealth } from "./api";
import "./styles.css";
import { BathroomKioskView } from "./bathroom-kiosk-view";
import type { BathroomScanResponse, BathroomStatusResponse, VoiceClipState, VoiceWorkerStatus } from "@rfid-attendance/shared";
import {
  listenForGlobalRfid,
  listenForScannerStatus,
  listenForAttendanceUpdates,
  listenForDtrSyncProgress,
  listenForDtrSyncHealth,
  type DtrSyncProgress,
  type DtrSyncSource,
  getScannerStatus,
  setScannerPaused,
  notifyScanSuccess,
} from "./tauri-api";
import { dtrSyncHealthCopy, isDtrSyncAlreadyRunning, refreshDtrSyncHealth, setDtrSyncActive, setDtrSyncHealthSnapshot, startDtrSyncHealthPolling, useDtrSyncActive, useDtrSyncHealthSnapshot } from "./dtr-sync-guard";

type ScannerStatus = {
  state: "connected" | "scanning" | "offline" | "error";
  message: string;
  detail: string | null;
  mode: string;
  paused: boolean;
};

import { GeneratedFileActions, type GeneratedFileResult } from "./file-actions";
import {
  announceAdminAssist,
  announceAttendance,
  announceBathroom,
  announceScanError,
  getClonedBeaNameAudioUrl,
  getWorkerNameAudioUrl,
  loadNameManifest,
  previewVoiceClip,
  resolveVoiceSlot,
} from "./services/ttsService";
import { VoiceSettingsPanel } from "./voice-settings-panel";
import { pickRestoreBackupFile } from "./api";
import { UpdateBanner } from "./update-banner";
import { PinResetPanel } from "./pin-reset";
import { AdminUpdatesCard } from "./admin-updates-card";
import { BathroomKeyLogPanel, getAvatarInitials } from "./bathroom-key-log";
import { formatCutoffRange, formatDate, formatDateTime, formatDuration, formatLateMinutes, formatMonth, formatTime } from "./format";
import { useDialogKeys } from "./use-dialog-keys";
import { NoticeLine, type Notice } from "./notice";
import { Toasts, showToast } from "./toasts";
import { LoadFailed, LoadingRows, useListLoad, type LoadStatus } from "./list-load";
import { sortByTime, TimeOrderToggle, TimeSortHeading, useTimeOrder, type TimeOrder } from "./time-sort";
import logoPhoenix from "./assets/branding/logo-phoenix.png";

function toErrorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error) return cause.message;
  if (cause && Object.prototype.toString.call(cause) === "[object String]") {
    // SAFETY: Verified cause is string primitive
    return cause as string;
  }
  return fallback;
}

async function evaluateKioskArrival(
  attendance: { attendanceId: string; attendanceDate: string; timeIn: string },
  userId: string,
  timezone: string,
): Promise<ArrivalStatus> {
  const fallback = evaluateArrivalFromTimestamp(attendance.timeIn, timezone, attendance.attendanceDate);
  try {
    const weekStart = getManilaWeekStart(attendance.attendanceDate);
    const start = new Date(`${weekStart}T00:00:00Z`);
    const end = new Date(`${attendance.attendanceDate}T00:00:00Z`);
    const dates: string[] = [];
    for (const date = new Date(start); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
      dates.push(date.toISOString().slice(0, 10));
    }
    const responses = await Promise.all(dates.map((date) => loadAttendance(date)));
    const history = responses.flatMap((response) =>
      response.success
        ? response.attendance
            .filter((row) => row.userId === userId)
            .map((row) => ({
              attendanceId: row.attendanceId,
              userId: row.userId,
              attendanceDate: row.attendanceDate,
              timeIn: row.timeIn,
            }))
        : [],
    );
    if (!history.some((row) => row.attendanceId === attendance.attendanceId)) {
      history.push({ ...attendance, userId });
    }
    return evaluateAttendanceArrivals(history).get(attendance.attendanceId)?.arrivalStatus ?? fallback;
  } catch {
    return fallback;
  }
}

type KioskState = "ready" | "processing" | "success" | "error";
type Result = ScanSuccessResponse | ScanErrorResponse;
type SetupStep = "scan" | "edit";
type SetupForm = {
  cardType: CardType;
  label: string;
  userId: string;
  fullName: string;
  department: string;
  status: SetupUser["status"];
  employeeType: SetupUser["employeeType"];
  gender: UserGender | "";
  dailyRate: string;
  photoUrl: string;
};
const emptySetupForm: SetupForm = {
  cardType: "EMPLOYEE",
  label: "",
  userId: "",
  fullName: "",
  department: "",
  status: "ACTIVE",
  employeeType: "INTERN",
  gender: "",
  dailyRate: "",
  photoUrl: "",
};

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
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenForDtrSyncHealth((health) => setDtrSyncHealthSnapshot(health))
      .then((cleanup) => { unlisten = cleanup; })
      .catch(() => { /* web mode or mock environment */ });
    return () => { if (unlisten) unlisten(); };
  }, []);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestController = useRef<AbortController | null>(null);
  const recentScans = useRef(new Map<string, number>());
  // Synchronous in-flight guard: set before the first await so two rapid native
  // scan events can never start two attendance writes for the same tap.
  const scanInFlightRef = useRef(false);
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
  const [assistedBusy, setAssistedBusy] = useState(false);
  const [assistedError, setAssistedError] = useState("");
  const setupInputRef = useRef<HTMLInputElement>(null);
  const setupIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // BUG-ATT-02: Re-sync offline scans when network comes back online
  useEffect(() => {
    const unsubscribe = onNetworkStatusChange((online) => {
      if (!online) return;
      const queue = getOfflineQueue();
      if (queue.length === 0) return;
      void (async () => {
        for (const item of queue) {
          try {
            const res = await submitScan(item.request);
            if (res.success && !("offlineQueued" in res)) {
              removeQueuedScan(item.id);
            }
          } catch (err) {
            console.warn('Failed to re-sync offline scan:', err);
          }
        }
      })();
    });
    return unsubscribe;
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
      try {
        const response = await unlockSetup(candidate);
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
      if (response.success && "offlineQueued" in response) {
        setResult(null);
        setState("success");
        if (resetTimer.current) clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(resetToReady, config.resultResetDelayMs);
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
          ? await evaluateKioskArrival(response.attendance, response.user.userId, config.timezone)
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
          ? await evaluateKioskArrival(response.attendance, response.user.userId, config.timezone)
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

        void fetchBathroomStatus();

        if (bathroomResetTimer.current) clearTimeout(bathroomResetTimer.current);
        bathroomResetTimer.current = setTimeout(() => {
          // Same reset as attendance, so the reader box is cleared too.
          resetToReady();
        }, config.resultResetDelayMs);
      } catch {
        setState("error");
        setBathroomScanResult({
          success: false,
          error: { code: "INTERNAL_ERROR", message: "Bathroom service is temporarily unavailable." },
        });
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
    [config.resultResetDelayMs, fetchBathroomStatus, resetToReady],
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
      } else if (!manualMode && !setupDialogOpen && !adminAssistData) {
        if (kioskMode === "bathroom") {
          void submitBathroom(normalized, "RFID");
        } else {
          void submit(normalized, "RFID");
        }
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
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
      if (isInDialog || isTextEntry || manualMode || adminAssistData || (setupDialogOpen && setupToken && !shouldRouteGlobalRfidToSetup(setupDialogOpen, setupToken, setupStep))) {
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
        event.preventDefault();
        flush();
        return;
      }

      const characterSet = config.scanner?.characterSet ?? "decimal";
      const allowedCharRegex = characterSet === "hex" ? /^[0-9a-fA-F]$/ : /^[0-9]$/;
      if (allowedCharRegex.test(event.key)) {
        buffer += event.key;
        if (buffer === "1" || buffer === "2") {
          const modeKey = buffer;
          modeSwitchTimer = setTimeout(() => {
            if (buffer === modeKey) {
              setKioskMode(modeKey === "1" ? "attendance" : "bathroom");
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
  }, [adminAssistData, config, flashScanNotice, handleSetupInput, kioskMode, manualMode, setupDialogOpen, setupStep, setupToken, submit, submitBathroom, unlockSetupWithPinOrCard]);

  // Native scanner events: card taps arrive here from the Rust layer without
  // any focused webview input. The listener also feeds the card-setup dialog
  // while it is open and awaiting a scan.
  useEffect(() => {
    let unlistenScan: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;
    void listenForGlobalRfid((value) => scanHandlerRef.current(value))
      .then((cleanup) => {
        unlistenScan = cleanup;
      })
      .catch(() => {
        /* web mode */
      });
    void listenForScannerStatus((nextStatus) => setScannerStatus(nextStatus))
      .then((cleanup) => {
        unlistenStatus = cleanup;
      })
      .catch(() => {
        /* web mode */
      });
    void getScannerStatus()
      .then((nextStatus) => setScannerStatus(nextStatus))
      .catch(() => {
        /* web mode */
      });
    return () => {
      unlistenScan?.();
      unlistenStatus?.();
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
            <p className="brand-name">ALPHA PREMIER REALTY</p>
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
            onClick={() => setKioskMode("attendance")}
          >
            <span className="mode-shortcut-badge">1</span> Attendance
          </button>
          <button
            type="button"
            role="tab"
            data-testid="kiosk-mode-bathroom"
            aria-selected={kioskMode === "bathroom"}
            className={`kiosk-mode-tab ${kioskMode === "bathroom" ? "active" : ""}`}
            onClick={() => setKioskMode("bathroom")}
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
          {syncSnapshot && (
            <span className={`sync-badge ${syncSnapshot.needsAttention > 0 || syncSnapshot.dead > 0 ? "attention" : syncSnapshot.queued > 0 ? "pending" : "idle"}`} role="status" aria-label="Intern DTR sync health">
              {dtrSyncHealthCopy(syncSnapshot)}
            </span>
          )}
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

        {/* ATTENDANCE SAVED OFFLINE: the scan is queued and will sync later */}
        {kioskMode === "attendance" && state === "success" && !result && (
          <div
            className="kiosk-result is-notice"
            data-testid="kiosk-result-offline"
            role="status"
            aria-live="polite"
          >
            <CloudOff className="result-notice-icon" size={42} aria-hidden="true" />
            <h2 className="result-name">Saved offline</h2>
            <p className="result-message">
              Your scan is saved on this computer and will sync automatically when the connection is back.
            </p>
          </div>
        )}

        {/* BATHROOM SCAN SUCCESS */}
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
                  {bathroomScanResult.genderKey === "MALE" ? "Male" : "Female"} key {bathroomScanResult.action === "CHECKOUT" ? "checked out" : "returned"}
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
                {bathroomScanResult.durationSeconds !== null && bathroomScanResult.durationSeconds !== undefined && (
                  <div className="result-meta">
                    <span className="badge badge-duration">
                      Out for {Math.max(1, Math.round(bathroomScanResult.durationSeconds / 60))} min
                    </span>
                  </div>
                )}
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

        {/* READY / PROCESSING HERO */}
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

        {((kioskMode === "attendance" && (state === "ready" || state === "processing")) ||
          (kioskMode === "bathroom" && (manualMode || !bathroomScanResult))) && (
          <div
            className={`scan-console${manualMode ? " is-manual" : ""}`}
            aria-label={manualMode ? "Manual card entry" : "RFID scanner"}
          >
            <div className="scan-console-head">
              <span className="scan-console-title">
                {manualMode ? "Manual card ID" : "RFID reader"}
              </span>
              {kioskMode === "bathroom" && (
                <button
                  className="text-button scan-console-toggle"
                  data-testid="kiosk-manual-toggle"
                  type="button"
                  onClick={toggleManualMode}
                  disabled={state !== "ready"}
                  aria-pressed={manualMode}
                >
                  {manualMode ? <CreditCard size={14} /> : <Keyboard size={14} />}
                  {manualMode ? "Use card reader" : "Manual entry"}
                </button>
              )}
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
                  onClick={() => {
                    if (kioskMode === "bathroom") {
                      void submitBathroom(manualUid, "MANUAL_TEST");
                    } else {
                      void submit(manualUid, "MANUAL_TEST");
                    }
                  }}
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

        {/* DYNAMIC BATHROOM STATUS & HISTORY (ALWAYS VISIBLE IN MODE 2), below the reader */}
        {kioskMode === "bathroom" && (
          <BathroomKioskView
            status={bathroomStatus}
            timezone={config.timezone}
            nowMs={now.getTime()}
          />
        )}

        {(state === "success" || state === "error") && (
          <div className="reset-progress" role="progressbar" aria-label="Returning to ready mode">
            {/* Keyed per scan so the bar restarts when a new result replaces the last one. */}
            <span key={result?.requestId ?? (bathroomScanResult?.success ? bathroomScanResult.timestamp : state)} style={{ animationDuration: `${config.resultResetDelayMs}ms` }} />
          </div>
        )}
      </section>

      {/* The options row is attendance-only; bathroom mode keeps Manual entry inside the reader card. */}
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
          onPinResetStart={() => {
            setSetupNotice(null);
            setAdminPin("");
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
          onClose={() => setAdminAssistData(null)}
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

/** The ID photo when there is one; otherwise the same initials circle the bathroom key cards use. */
function ResultPortrait({ photoUrl, fullName }: { photoUrl?: string | null; fullName: string }) {
  return photoUrl ? (
    <img className="result-photo result-photo-full" src={photoSource(photoUrl)} alt={`${fullName} ID`} />
  ) : (
    <div className="result-avatar" aria-label="ID photo unavailable">
      {getAvatarInitials(fullName)}
    </div>
  );
}

type SetupDialogProps = {
  token: string;
  step: SetupStep;
  busy: boolean;
  notice: Notice | null;
  pin: string;
  uid: string;
  user: SetupUser | null;
  form: SetupForm;
  inputRef: React.Ref<HTMLInputElement>;
  onPinChange: (value: string) => void;
  /** Clears the PIN field and stale unlock error when Forgot PIN opens. */
  onPinResetStart: () => void;
  onUnlock: (event: React.FormEvent) => void;
  onUidChange: (value: string) => void;
  onScanAnother: () => void;
  onUidEnter: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onFormChange: (field: keyof SetupForm, value: string) => void;
  onPhotoFile: (file: File) => void;
  onUpsert: (event: React.FormEvent) => void;
  onClose: () => void;
};

/** The kiosk's rising gold sparkles; each one's position, size and timing come from styles.css. */
const KIOSK_SPARKLES = Array.from({ length: 18 }, (_, index) => <i key={index} />);

/** Card setup progress: the step on screen is highlighted and earlier steps show as done. */
function SetupSteps({ current }: { current: 1 | 2 | 3 }) {
  return (
    <div className="setup-steps" aria-label="Card association steps">
      {["01 Unlock", "02 Scan card", "03 Save user"].map((label, index) => (
        <span
          key={label}
          className={index + 1 === current ? "is-active" : index + 1 < current ? "is-done" : undefined}
          aria-current={index + 1 === current ? "step" : undefined}
        >
          {label}
        </span>
      ))}
    </div>
  );
}

/** Intern User IDs usually look like APG-2026-001. Only a nudge while typing: demo IDs and others still save. */
const USUAL_USER_ID = /^APG-\d{4}-\d{3}$/i;
function unusualUserId(userId: string): boolean {
  const value = userId.trim();
  return value !== "" && !USUAL_USER_ID.test(value);
}
/** Under the User ID field. Kept out of the field's name (aria-hidden); the field reads it as its description. */
function UserIdFormatHint({ id }: { id: string }) {
  return (
    <small id={id} className="user-id-hint" aria-hidden="true">
      Usual format: APG-YYYY-NNN
    </small>
  );
}

function SetupDialog(props: SetupDialogProps) {
  const [isDraggingPhoto, setIsDraggingPhoto] = useState(false);
  // New cards only: an existing card keeps the ID it was saved with.
  const userIdHintId = useId();
  const showUserIdHint = !props.user && unusualUserId(props.form.userId);
  // The save step puts the cursor in its first field once, when it opens for a card (not on card-type switches).
  const saveFormRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (props.token && props.step === "edit") saveFormRef.current?.querySelector<HTMLInputElement>(".setup-fields input")?.focus({ preventScroll: true });
  }, [props.token, props.step, props.uid]);
  const [resettingPin, setResettingPin] = useState(false);
  const [pinNotice, setPinNotice] = useState("");
  // An admin card tap can unlock mid-reset; a later expiry must land on unlock, not reset.
  useEffect(() => {
    if (props.token) setResettingPin(false);
  }, [props.token]);
  const dialogRef = useRef<HTMLElement>(null);
  useDialogKeys(dialogRef, props.onClose, { busy: props.busy });
  useEffect(() => {
    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = "copy";
      }
    };
    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
    };
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("drop", handleDrop);
    return () => {
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("drop", handleDrop);
    };
  }, []);

  return (
    <div
      className="setup-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          props.onClose();
        }
      }}
    >
      <section
        ref={dialogRef}
        className="setup-dialog card-setup-dialog"
        data-step={!props.token ? (resettingPin ? "reset" : "unlock") : props.step === "scan" ? "scan" : "save"}
        role="dialog"
        aria-modal="true"
        aria-labelledby="setup-heading"
      >
        <div className="setup-dialog-header">
          <div className="setup-title-wrap">
            <div className="setup-icon" aria-hidden="true">
              <ShieldCheck size={21} />
            </div>
            <div>
              <p className="section-kicker">Secure user mapping</p>
              <h2 id="setup-heading">Associate RFID card</h2>
            </div>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={props.onClose}
            aria-label="Close card setup"
          >
            <X size={19} />
          </button>
        </div>
        {!props.token && resettingPin ? (
          <PinResetPanel
            onDone={(notice) => {
              setResettingPin(false);
              setPinNotice(notice ?? "");
            }}
          />
        ) : !props.token ? (
          <form className="setup-form" onSubmit={props.onUnlock}>
            <SetupSteps current={1} />
            <p className="setup-copy">
              Tap an admin RFID card on the reader, or type the administrator PIN, to link a card to an employee.
            </p>
            <label htmlFor="admin-pin">Administrator PIN or Admin RFID card</label>
            <input
              id="admin-pin"
              type="password"
              placeholder="Enter PIN or scan admin card…"
              autoComplete="off"
              value={props.pin}
              onChange={(event) => {
                setPinNotice("");
                props.onPinChange(event.target.value);
              }}
              autoFocus
              data-autofocus
            />
            <NoticeLine notice={props.notice} />
            <button
              className="submit-button setup-submit"
              type="submit"
              disabled={props.busy || !props.pin.trim()}
            >
              {props.busy ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <LockKeyhole size={17} />
              )}{" "}
              Unlock setup
            </button>
            <NoticeLine notice={pinNotice ? { tone: "success", text: pinNotice } : null} />
            <button
              className="text-button"
              type="button"
              onClick={() => {
                setPinNotice("");
                props.onPinResetStart();
                setResettingPin(true);
              }}
            >
              Forgot PIN?
            </button>
          </form>
        ) : props.step === "scan" ? (
          <div className="setup-form">
            <SetupSteps current={2} />
            <p className="setup-copy">
              Scan the employee card now. Existing cards open with their current
              details; new cards start with a blank profile.
            </p>
            <label htmlFor="setup-card-uid">Card ID</label>
            <input
              ref={props.inputRef}
              id="setup-card-uid"
              aria-label="Setup card ID"
              value={props.uid}
              onChange={(event) => props.onUidChange(event.target.value)}
              onKeyDown={props.onUidEnter}
              placeholder="Waiting for card reader…"
              autoComplete="off"
              spellCheck={false}
              readOnly={props.busy}
              aria-busy={props.busy}
            />
            {props.busy && (
              <p className="setup-progress">
                <LoaderCircle className="spin" size={15} /> Looking up card…
              </p>
            )}
            <NoticeLine notice={props.notice} />
            <div className="setup-footer">
              <span>
                <UserRound size={15} />{" "}
                {/* A save clears the card ID and keeps the saved user; an expired session keeps both. */}
                {!props.user ? "New card enrollment" : props.uid ? "Existing user" : "Ready for the next card"}
              </span>
              <button
                className="text-button"
                type="button"
                onClick={props.onClose}
              >
                Lock setup
              </button>
            </div>
          </div>
        ) : (
          <form className="setup-form setup-form-save" onSubmit={props.onUpsert} ref={saveFormRef}>
            <SetupSteps current={3} />
            <div className="card-badge">
              <CreditCard size={15} /> {props.uid}
              <span>{props.user ? "Existing card" : "New card"}</span>
            </div>
            <p className="setup-copy">
              Review the profile before saving. Saving here changes the Users
              register only; it does not create attendance.
            </p>
            <div className="card-type-toggle" role="radiogroup" aria-label="Register card as:">
              <span className="field-label">Register card as:</span>
              <div className="segmented-control">
                <label className={`segment-option ${props.form.cardType === "EMPLOYEE" ? "is-selected" : ""}`}>
                  <input
                    type="radio"
                    name="cardType"
                    value="EMPLOYEE"
                    checked={props.form.cardType === "EMPLOYEE"}
                    onChange={() => props.onFormChange("cardType", "EMPLOYEE")}
                  />
                  <UserRound size={16} aria-hidden="true" />
                  <span>Intern card</span>
                </label>
                <label className={`segment-option is-admin-card ${props.form.cardType === "ADMIN_ASSIST" ? "is-selected" : ""}`}>
                  <input
                    type="radio"
                    name="cardType"
                    value="ADMIN_ASSIST"
                    checked={props.form.cardType === "ADMIN_ASSIST"}
                    onChange={() => props.onFormChange("cardType", "ADMIN_ASSIST")}
                  />
                  <ShieldCheck size={16} aria-hidden="true" />
                  <span>Admin RFID card</span>
                </label>
              </div>
            </div>
            {props.form.cardType === "ADMIN_ASSIST" ? (
              <div className="setup-fields" key="admin-card">
                <label>
                  <span className="field-label">
                    Card label <span className="optional">optional</span>
                  </span>
                  <input
                    placeholder="e.g. Front desk admin card #1"
                    value={props.form.label}
                    onChange={(event) =>
                      props.onFormChange("label", event.target.value)
                    }
                    autoComplete="off"
                  />
                </label>
                <p className="field-hint">
                  Admin RFID cards are used to time-in or time-out employees who physically showed up but forgot their card. Admin cards cannot record attendance for themselves.
                </p>
              </div>
            ) : (
              <div className="setup-fields" key="intern-card">
                <label className="user-id-field">
                  <span className="field-label">User ID</span>
                  <input
                    placeholder="e.g. APG-2026-001"
                    aria-describedby={showUserIdHint ? userIdHintId : undefined}
                    value={props.form.userId}
                    onChange={(event) =>
                      props.onFormChange("userId", event.target.value.toUpperCase())
                    }
                    onBlur={() =>
                      props.onFormChange("userId", props.form.userId.trim().toUpperCase())
                    }
                    autoComplete="off"
                    required
                  />
                  {showUserIdHint && <UserIdFormatHint id={userIdHintId} />}
                </label>
                <label>
                  <span className="field-label">Full name</span>
                  <input
                    value={props.form.fullName}
                    onChange={(event) =>
                      props.onFormChange("fullName", event.target.value)
                    }
                    onBlur={() =>
                      props.onFormChange(
                        "fullName",
                        normalizeName(props.form.fullName),
                      )
                    }
                    autoComplete="name"
                    required
                  />
                </label>
                <label>
                  <span className="field-label">
                    Department / role <span className="optional">optional</span>
                  </span>
                  <input
                    placeholder="IT / Admin"
                    value={props.form.department}
                    onChange={(event) =>
                      props.onFormChange("department", event.target.value)
                    }
                    onBlur={() =>
                      props.onFormChange(
                        "department",
                        props.form.department.trim().replace(/\s+/g, " "),
                      )
                    }
                    autoComplete="organization"
                  />
                </label>
                <label>
                  <span className="field-label">Status</span>
                  <select
                    value={props.form.status}
                    onChange={(event) =>
                      props.onFormChange(
                        "status",
                        event.target.value === "INACTIVE"
                          ? "INACTIVE"
                          : "ACTIVE",
                      )
                    }
                  >
                    <option value="ACTIVE">Active</option>
                    <option value="INACTIVE">Inactive</option>
                  </select>
                </label>
                <label>
                  <span className="field-label">
                    Gender <span className="optional">optional</span>
                  </span>
                  <select
                    value={props.form.gender}
                    onChange={(event) =>
                      props.onFormChange(
                        "gender",
                        event.target.value === "MALE" ||
                          event.target.value === "FEMALE"
                          ? event.target.value
                          : "",
                      )
                    }
                  >
                    <option value="">Not set</option>
                    <option value="MALE">Male (Sir)</option>
                    <option value="FEMALE">Female (Ma'am)</option>
                  </select>
                </label>
                <div className="photo-field">
                  <span className="field-label">
                    ID photo <span className="optional">optional</span>
                  </span>
                  <label
                    className={`photo-dropzone${props.form.photoUrl ? " has-photo" : ""}${isDraggingPhoto ? " is-dragging" : ""}`}
                    htmlFor="setup-photo"
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (event.dataTransfer) {
                        event.dataTransfer.dropEffect = "copy";
                      }
                    }}
                    onDragEnter={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setIsDraggingPhoto(true);
                    }}
                    onDragLeave={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (
                        event.relatedTarget instanceof Node &&
                        event.currentTarget.contains(event.relatedTarget)
                      ) {
                        return;
                      }
                      setIsDraggingPhoto(false);
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setIsDraggingPhoto(false);
                      const file =
                        event.dataTransfer.files?.[0] ??
                        (event.dataTransfer.items &&
                        event.dataTransfer.items.length > 0
                          ? event.dataTransfer.items[0].getAsFile()
                          : null);
                      if (file) props.onPhotoFile(file);
                    }}
                  >
                    <input
                      id="setup-photo"
                      className="photo-input"
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) props.onPhotoFile(file);
                        event.currentTarget.value = "";
                      }}
                    />
                    {props.form.photoUrl ? (
                      <>
                        <img
                          src={photoSource(props.form.photoUrl)}
                          alt="Uploaded ID preview"
                        />
                        <span className="photo-overlay">
                          <Check size={17} /> Photo ready
                        </span>
                      </>
                    ) : isDraggingPhoto ? (
                      <>
                        <ImagePlus size={28} />
                        <strong>Drop ID photo here</strong>
                        <small>Release mouse to upload photo</small>
                      </>
                    ) : (
                      <>
                        <ImagePlus size={25} />
                        <strong>Choose an ID photo</strong>
                        <small>JPG, PNG, or WebP - resized automatically</small>
                        <span className="photo-upload-link">
                          <Upload size={14} /> Browse files
                        </span>
                      </>
                    )}
                  </label>
                </div>
              </div>
            )}
            <NoticeLine notice={props.notice} />
            <div className="setup-footer">
              <button
                className="text-button"
                type="button"
                onClick={props.onScanAnother}
              >
                Scan another card
              </button>
              <button
                className="submit-button"
                type="submit"
                disabled={
                  props.busy ||
                  (props.form.cardType === "EMPLOYEE" &&
                    (!props.form.userId.trim() ||
                      !props.form.fullName.trim()))
                }
              >
                {props.busy ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <Check size={17} />
                )}{" "}
                {props.form.cardType === "ADMIN_ASSIST" ? "Save admin card" : "Save user"}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}

function AssistedAttendanceModal({
  data,
  onClose,
  onConfirm,
  busy,
  error,
}: {
  data: ScanAdminAssistResponse;
  onClose: () => void;
  onConfirm: (targetUserId: string, reason: string) => Promise<void>;
  busy: boolean;
  error: string;
}) {
  const [timeLeft, setTimeLeft] = useState(25);
  const [search, setSearch] = useState("");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [reasonType, setReasonType] = useState<"Forgot RFID card" | "Defective RFID card" | "Other">("Forgot RFID card");
  const [customReason, setCustomReason] = useState("");

  useEffect(() => {
    // Pause the auto-close countdown while a confirm is in flight so the
    // modal can never close under an awaiting post.
    if (busy) return;
    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          onClose();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [onClose, busy]);

  const dialogRef = useRef<HTMLElement>(null);
  useDialogKeys(dialogRef, onClose, { busy });

  const filteredEmployees = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return data.activeEmployees;
    return data.activeEmployees.filter(
      (e) =>
        e.fullName.toLowerCase().includes(q) ||
        (e.department && e.department.toLowerCase().includes(q)) ||
        e.userId.toLowerCase().includes(q),
    );
  }, [data.activeEmployees, search]);

  const effectiveReason = reasonType === "Other" ? customReason.trim() : reasonType;
  const canConfirm = Boolean(selectedUserId) && Boolean(effectiveReason) && !busy;

  const handleConfirm = () => {
    if (!selectedUserId || !canConfirm) return;
    void onConfirm(selectedUserId, effectiveReason);
  };

  const selectedEmployee = data.activeEmployees.find((e) => e.userId === selectedUserId);

  return (
    <div
      className="assisted-modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="assisted-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="assisted-heading"
      >
        <div className="assisted-modal-header">
          <div className="assisted-modal-title-wrap">
            <div className="assisted-modal-icon" aria-hidden="true">
              <ShieldCheck size={22} />
            </div>
            <div>
              <p className="section-kicker">Kiosk assist mode</p>
              <h3 id="assisted-heading">Assisted Attendance</h3>
              <p className="assisted-modal-subtitle">
                Admin Card: <span className="assisted-admin-card-tag">{data.adminCard.label || "Admin Card"}</span>
              </p>
            </div>
          </div>
          <div className="assisted-timer-pill" aria-live="polite" title="Auto-closes if no action is taken">
            <Clock size={13} /> Auto-cancels in {timeLeft}s
          </div>
        </div>

        <div className="assisted-modal-body">
          {error && <p className="dashboard-alert">{error}</p>}

          <div className="modal-audit-callout">
            <ShieldAlert size={16} />
            <span>Select the employee to record attendance for. This scan will be signed in the audit log under this admin card.</span>
          </div>

          <div className="modal-section-group">
            <label className="field-label" htmlFor="assisted-search">
              <span>Select Employee</span>
              {selectedEmployee && (
                <span style={{ color: "var(--gold-bright)", fontWeight: 400, fontSize: "0.72rem" }}>
                  Selected: {selectedEmployee.fullName}
                </span>
              )}
            </label>
            <div className="search-input-wrap">
              <Search size={16} />
              <input
                id="assisted-search"
                type="text"
                className="input"
                placeholder="Search employee by name, ID, or department…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
                data-autofocus
              />
            </div>
            <div className="employee-picker-list" role="group" aria-label="Active employees">
              {filteredEmployees.length === 0 ? (
                <div style={{ padding: "20px 12px", textAlign: "center", color: "var(--muted)", fontSize: "0.82rem" }}>
                  No active employees found matching &ldquo;{search}&rdquo;.
                </div>
              ) : (
                filteredEmployees.map((emp) => {
                  const isSelected = selectedUserId === emp.userId;
                  const initials = emp.fullName
                    .split(" ")
                    .map((n) => n[0])
                    .filter(Boolean)
                    .slice(0, 2)
                    .join("")
                    .toUpperCase();
                  return (
                    <button
                      key={emp.userId}
                      type="button"
                      aria-pressed={isSelected}
                      className={`employee-picker-item ${isSelected ? "is-selected" : ""}`}
                      onClick={() => setSelectedUserId(emp.userId)}
                    >
                      <div style={{ display: "flex", alignItems: "center" }}>
                        <div className="employee-picker-avatar" aria-hidden="true">
                          {initials}
                        </div>
                        <div className="employee-picker-meta">
                          <strong>{emp.fullName}</strong>
                          <small>
                            {emp.userId} {emp.department ? `· ${emp.department}` : ""}
                          </small>
                        </div>
                      </div>
                      {isSelected && (
                        <div style={{ display: "grid", placeItems: "center", width: 24, height: 24, borderRadius: "50%", background: "var(--gold)", color: "#11100c" }}>
                          <Check size={14} strokeWidth={3} />
                        </div>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <div className="modal-section-group">
            <span className="field-label">Reason for assisted scan:</span>
            <div className="reason-pill-group" role="radiogroup" aria-label="Reason for assisted scan">
              <button
                type="button"
                className={`reason-pill-btn ${reasonType === "Forgot RFID card" ? "is-active" : ""}`}
                onClick={() => setReasonType("Forgot RFID card")}
              >
                Forgot RFID card
              </button>
              <button
                type="button"
                className={`reason-pill-btn ${reasonType === "Defective RFID card" ? "is-active" : ""}`}
                onClick={() => setReasonType("Defective RFID card")}
              >
                Defective RFID card
              </button>
              <button
                type="button"
                className={`reason-pill-btn ${reasonType === "Other" ? "is-active" : ""}`}
                onClick={() => setReasonType("Other")}
              >
                Other reason…
              </button>
            </div>
          </div>

          {reasonType === "Other" && (
            <div className="modal-section-group">
              <label className="field-label" htmlFor="assisted-custom-reason">
                Custom reason (mandatory for audit trail):
              </label>
              <input
                id="assisted-custom-reason"
                type="text"
                className="input"
                placeholder="Explain why assisted attendance was required…"
                value={customReason}
                onChange={(e) => setCustomReason(e.target.value)}
                autoFocus
              />
            </div>
          )}
        </div>

        <div className="assisted-modal-footer">
          <button className="modal-btn-cancel" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="modal-btn-primary"
            type="button"
            onClick={handleConfirm}
            disabled={!canConfirm}
          >
            {busy ? (
              <>
                <LoaderCircle className="spin" size={16} /> Recording…
              </>
            ) : (
              <>
                <UserCheck size={16} /> Confirm attendance
              </>
            )}
          </button>
        </div>
      </section>
    </div>
  );
}

async function preparePhotoDataUrl(file: File): Promise<string> {
  const source = await createImageBitmap(file);
  const scale = Math.min(1, 4096 / Math.max(source.width, source.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const context = canvas.getContext("2d");
  if (!context)
    throw new Error("Photo preparation is unavailable in this browser.");
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close();
  for (const quality of [0.82, 0.68, 0.55, 0.42]) {
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    if (dataUrl.length * 0.75 <= PHOTO_UPLOAD_MAX_BYTES) return dataUrl;
  }
  throw new Error(
    "This photo could not be compressed below the 500 KB upload limit.",
  );
}

const PHOTO_UPLOAD_MAX_BYTES = 500 * 1024;

function localDate(timezone = "Asia/Manila") {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(
    new Date(),
  );
}

/**
 * Pauses the native scanner listener while a screen with text input is open
 * (admin, live attendance) and resumes it when the kiosk comes back, so
 * operator keystrokes are never misread as card scans.
 */
/**
 * True while a capped, scrolling list holds more than fits in its box, so a
 * "See all" toggle is worth showing. `enabled` re-arms it once the box renders.
 */
function useVerticalOverflow(ref: React.RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const box = ref.current;
    if (!enabled || !box || !("ResizeObserver" in window)) return;
    const measure = () => setOverflowing(box.scrollHeight > box.clientHeight + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    if (box.firstElementChild) observer.observe(box.firstElementChild);
    measure();
    return () => observer.disconnect();
  }, [ref, enabled]);
  return overflowing;
}

function useScannerPause(paused: boolean) {
  useEffect(() => {
    void setScannerPaused(paused).catch(() => {
      /* web mode */
    });
    return () => {
      void setScannerPaused(false).catch(() => {
        /* web mode */
      });
    };
  }, [paused]);
}

/** Loads the canonical office identity with a safe fallback to defaults. */
function useOfficeIdentity(): OfficeIdentity {
  const [office, setOffice] = useState<OfficeIdentity>(DEFAULT_OFFICE_IDENTITY);
  useEffect(() => {
    const controller = new AbortController();
    void loadConfig(controller.signal).then((config) =>
      setOffice(config.office ?? DEFAULT_OFFICE_IDENTITY),
    );
    return () => controller.abort();
  }, []);
  return office;
}

type LiveAttendanceState =
  | { kind: "loading" }
  | { kind: "ready"; rows: AttendanceListItem[]; fetchedAt: string }
  | { kind: "stale"; rows: AttendanceListItem[]; fetchedAt: string; message: string };

function LiveAttendance() {
  useScannerPause(true);
  const office = useOfficeIdentity();
  const [attendance, setAttendance] = useState<LiveAttendanceState>({ kind: "loading" });
  const [lan, setLan] = useState<LanStatusResponse | null>(null);
  const [lanBusy, setLanBusy] = useState(false);
  const [lanOpen, setLanOpen] = useState(false);
  // On-screen filters only: the counts and the refresh cycle always cover the whole day.
  const [search, setSearch] = useState("");
  const [department, setDepartment] = useState("");
  const [timeOrder, toggleTimeOrder] = useTimeOrder("alpha_premier_sort_live_attendance");
  const searchRef = useRef<HTMLInputElement>(null);
  const [tableUsers, setTableUsers] = useState<AdminUser[]>([]);
  const [clampHistory, setClampHistory] = useState<AttendanceListItem[]>([]);
  const clampHistoryWeekRef = useRef("");
  const liveAttendanceSeq = useRef(0);
  const refresh = useCallback(async () => {
    const seq = liveAttendanceSeq.current + 1;
    liveAttendanceSeq.current = seq;
    try {
      const response = await loadAttendance();
      if (liveAttendanceSeq.current !== seq) return;
      if (response.success) {
        setAttendance({ kind: "ready", rows: response.attendance, fetchedAt: response.fetchedAt });
      } else throw new Error("Unable to load attendance");
    } catch {
      if (liveAttendanceSeq.current !== seq) return;
      setAttendance((prev) =>
        prev.kind === "loading"
          ? { kind: "stale", rows: [], fetchedAt: "", message: "Live attendance is temporarily unavailable." }
          : { kind: "stale", rows: prev.rows, fetchedAt: prev.fetchedAt, message: "Live attendance is temporarily unavailable." },
      );
    }
  }, []);

  useEffect(() => {
    void refresh();

    // 1. Listen for native desktop Tauri events
    let unlistenUpdated: (() => void) | undefined;
    void listenForAttendanceUpdates(() => {
      void refresh();
    }).then((cleanup) => {
      unlistenUpdated = cleanup;
    }).catch(() => {
      /* web mode */
    });

    // 2. Connect to LAN SSE stream for remote browser viewer
    let sse: EventSource | null = null;
    try {
      sse = new EventSource(sseUrl("/api/events/attendance"));
      sse.addEventListener("attendance-updated", () => {
        void refresh();
      });
      sse.addEventListener("message", () => {
        void refresh();
      });
      sse.onerror = () => {
        /* fallback gracefully to polling */
      };
    } catch {
      /* SSE unavailable */
    }

    // 3. Fallback polling timer (every 5 seconds)
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 5_000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);

    return () => {
      unlistenUpdated?.();
      sse?.close();
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  useEffect(() => {
    // Best-effort roster so the live table can show the display-only
    // hourly payable clamp for non-graced intern late arrivals. Viewers without
    // an admin session never resolve this, so actual times simply stay visible.
    void loadAdminUsers()
      .then((response) => {
        // SAFETY: Error-shaped 401 bodies cast as AdminUsersResponse can omit users
        setTableUsers(response.success ? response.users ?? [] : []);
      })
      .catch(() => setTableUsers([]));
  }, []);

  // The live snapshot only covers today, so weekly-grace exhaustion never
  // shows in the loaded rows alone. Best-effort: fetch the earlier days of
  // the current Manila week once so the display-only clamp can group by
  // week. Any failure leaves history empty and the table shows actual times
  // exactly as before, with no layout change.
  useEffect(() => {
    if (attendance.kind === "loading") return;
    const today = localDate();
    let weekStart: string;
    try {
      weekStart = getManilaWeekStart(today);
    } catch {
      return;
    }
    if (clampHistoryWeekRef.current === weekStart) return;
    clampHistoryWeekRef.current = weekStart;
    const dates: string[] = [];
    for (
      const cursor = new Date(`${weekStart}T00:00:00Z`);
      cursor.toISOString().slice(0, 10) < today;
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    ) {
      dates.push(cursor.toISOString().slice(0, 10));
    }
    if (!dates.length) return;
    void (async () => {
      try {
        const responses = await Promise.all(dates.map((day) => loadAttendance(day)));
        setClampHistory(
          responses.flatMap((response) =>
            response.success && Array.isArray(response.attendance) ? response.attendance : [],
          ),
        );
      } catch {
        setClampHistory([]);
      }
    })();
  }, [attendance]);

  const refreshLan = useCallback(async () => {
    setLan(await getLanStatus());
  }, []);
  useEffect(() => {
    // Opening Live Attendance starts (or verifies) the LAN viewer server.
    void startLanViewer().then(setLan);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshLan();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [refreshLan]);
  const startNow = async () => {
    setLanBusy(true);
    setLan(await startLanViewer());
    setLanBusy(false);
  };
  const stopNow = async () => {
    setLanBusy(true);
    setLan(await stopLanViewer());
    setLanBusy(false);
  };
  const liveRows: AttendanceListItem[] = attendance.kind === "loading" ? [] : attendance.rows;
  const inOffice = liveRows.filter((row) => row.status === "WORKING").length;
  // Same truthiness checks as AttendanceTable's cells (a MISSED row can lack a valid time in).
  const timedIn = liveRows.filter((row) => Boolean(row.timeIn)).length;
  const timedOut = liveRows.filter((row) => Boolean(row.timeOut)).length;
  const needsCorrection = liveRows.filter((row) => row.status === "LATE_TIMEOUT").length;
  // Departments in today's rows (plus the chosen one, so the dropdown never loses it after a refresh).
  const departments = [...new Set([...liveRows.map((row) => row.department?.trim() ?? ""), department].filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const query = search.trim().toLowerCase();
  const shownRows = liveRows.filter(
    (row) =>
      (!department || row.department?.trim() === department) &&
      (!query || row.fullName.toLowerCase().includes(query) || row.userId.toLowerCase().includes(query)),
  );
  // Focus goes back to the search box, since the Clear filters button disappears with the empty message.
  const clearFilters = () => {
    setSearch("");
    setDepartment("");
    searchRef.current?.focus();
  };
  // Running but likely unreachable from other devices: flag it on the collapsed LAN toggle.
  const lanNeedsCheck = lan !== null && lan.state === "running" && (lan.networkProfile === "public" || lan.localHealthOk === false);
  return (
    <main className="dashboard-shell live-shell">
      <header className="dashboard-header">
        <div>
          <DashboardBrand />
          <p className="section-kicker">Live attendance</p>
          <h1>Today’s timing</h1>
          <p className="section-description">
            {resolveOfficeDisplay(office, "short")} · {formatDeductionDate(localDate())}
          </p>
        </div>
        <nav>
          <a href="/"><Nfc size={16} aria-hidden="true" /> Scanner</a>
          <a href="/admin"><LayoutDashboard size={16} aria-hidden="true" /> Admin</a>
        </nav>
      </header>
      {attendance.kind === "stale" && <p className="dashboard-alert">{attendance.message}</p>}
      <div className="live-bar">
        {liveRows.length > 0 && (
          <ul className="live-counts" aria-label="Today at a glance">
            <li className="office-count"><Users size={16} aria-hidden="true" /><strong>{inOffice}</strong> in office</li>
            <li className="office-count"><LogOut size={16} aria-hidden="true" /><strong>{timedOut}</strong> timed out</li>
            <li className="office-count"><LogIn size={16} aria-hidden="true" /><strong>{timedIn}</strong> timed in</li>
            {needsCorrection > 0 && (
              <li className="office-count is-alert"><CircleAlert size={16} aria-hidden="true" /><strong>{needsCorrection}</strong> need correction</li>
            )}
          </ul>
        )}
        <div className="dashboard-status" data-state={attendance.kind}>
          {attendance.kind === "stale"
            ? "Showing last successful update"
            : attendance.kind === "ready"
              ? `Last updated ${attendance.fetchedAt ? formatTime(attendance.fetchedAt, "Asia/Manila") : "just now"}`
              : "Loading live attendance…"}
        </div>
        <button
          type="button"
          className={lanNeedsCheck ? "live-lan-toggle is-attention" : "live-lan-toggle"}
          aria-expanded={lanOpen}
          aria-controls="live-lan-drawer"
          onClick={() => setLanOpen((open) => !open)}
        >
          <Wifi size={16} aria-hidden="true" />
          LAN viewer
          <span className={`lan-state lan-state-${lan ? lan.state : "starting"}`}><i />{lan ? LAN_STATE_LABEL[lan.state] : "Checking…"}</span>
          {lanNeedsCheck && <span className="live-lan-flag"><CircleAlert size={14} aria-hidden="true" />Check setup</span>}
          <ChevronDown className="live-lan-chevron" size={16} aria-hidden="true" />
        </button>
      </div>
      {/* `hidden` keeps the panel mounted, so its copy state and the auto-start above are unaffected. */}
      <div id="live-lan-drawer" className="live-lan-drawer" hidden={!lanOpen}>
        <LanViewerPanel
          status={lan}
          busy={lanBusy}
          onStart={() => void startNow()}
          onStop={() => void stopNow()}
          onRefresh={() => void refreshLan()}
        />
      </div>
      {liveRows.length > 0 && (
        <div className="live-filters">
          <div className="search-input-wrap">
            <Search size={15} aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              className="input"
              aria-label="Search name or ID"
              placeholder="Search name or ID"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <select
            className="select"
            aria-label="Department"
            value={department}
            onChange={(event) => setDepartment(event.target.value)}
          >
            <option value="">All departments</option>
            {departments.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
          {/* Phones: the cards have no Time in heading, so the order gets a small toggle here. */}
          <TimeOrderToggle column="Time in" order={timeOrder} onToggle={toggleTimeOrder} />
        </div>
      )}
      {attendance.kind === "loading" ? null : liveRows.length > 0 && shownRows.length === 0 ? (
        <div className="empty-state live-no-match">
          <p>No one matches</p>
          <button type="button" className="text-button" onClick={clearFilters}>Clear filters</button>
        </div>
      ) : (
        <AttendanceTable
          rows={shownRows}
          timezone="Asia/Manila"
          users={tableUsers}
          history={clampHistory}
          order={timeOrder}
          onToggleOrder={toggleTimeOrder}
        />
      )}
    </main>
  );
}

const LAN_STATE_LABEL = {
  starting: "Starting",
  running: "Running",
  stopped: "Stopped",
  disabled: "Disabled",
  error: "Needs attention",
} satisfies Record<LanStatusResponse["state"], string>;

function lanProfileLabel(profile: LanStatusResponse["networkProfile"]): string {
  switch (profile) {
    case "public":
      return "Public — inbound blocked by default";
    case "private":
      return "Private — office-ready";
    case "domain":
      return "Domain";
    default:
      return "Unknown";
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through */
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    el.remove();
    return ok;
  } catch {
    return false;
  }
}

/** In-app Live Attendance panel: LAN viewer status, URL, and operator guidance. */
function LanViewerPanel({
  status,
  busy,
  onStart,
  onStop,
  onRefresh,
}: {
  status: LanStatusResponse | null;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  onRefresh: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (!status)
    return (
      <section className="lan-panel" aria-label="LAN viewer">
        <p className="lan-note">Checking the LAN viewer…</p>
      </section>
    );
  const running = status.state === "running";
  const copyUrl = async () => {
    if (!status.viewerUrl) return;
    setCopied(await copyText(status.viewerUrl));
    window.setTimeout(() => setCopied(false), 2000);
  };
  const openUrl = async () => {
    if (status.viewerUrl) await openViewerUrl(status.viewerUrl);
  };
  const firewallCommand = `netsh advfirewall firewall add rule name="Alpha Premier Live Attendance" dir=in action=allow protocol=TCP localport=${status.port} profile=private`;
  const subnetLabel = status.allowedSubnets.length
    ? status.allowedSubnets.join(", ")
    : "Any private (same LAN)";
  const healthLabel =
    status.localHealthOk === true
      ? "Reachable locally"
      : status.localHealthOk === false
        ? "Not reachable locally"
        : "Not checked";
  const firewallLabel =
    status.firewallAllowRule === "present"
      ? "Allow rule found"
      : status.firewallAllowRule === "missing"
        ? "No allow rule found"
        : "Unknown";
  return (
    <section className="lan-panel" aria-label="LAN viewer">
      <div className="lan-panel-head">
        <div>
          <p className="section-kicker">Live Attendance LAN viewer</p>
          <h2>Share today’s timing with the office</h2>
        </div>
        <span className={`lan-state lan-state-${status.state}`}>
          <i />
          {LAN_STATE_LABEL[status.state]}
        </span>
      </div>
      {running && status.viewerUrl ? (
        <>
          <div className="lan-url-row">
            <code className="lan-url">{status.viewerUrl}</code>
            <button
              className="admin-button"
              type="button"
              onClick={() => void copyUrl()}
            >
              {copied ? "Copied" : "Copy URL"}
            </button>
            <button
              className="admin-button file-action-primary"
              type="button"
              onClick={() => void openUrl()}
            >
              Open Local Viewer
            </button>
          </div>
          <p className="lan-note">
            Open this link on any device connected to the same office Wi‑Fi.{" "}
            {status.networkScope}
          </p>
          {status.networkProfile === "public" && (
            <div className="lan-guidance">
              <p>
                <strong>This laptop’s network profile is Public.</strong>{" "}
                Windows blocks most inbound traffic on Public networks. Set the
                Wi‑Fi/LAN profile to <em>Private</em> so other devices can reach
                the viewer, then try opening the link again.
              </p>
              <p className="lan-code">{firewallCommand}</p>
            </div>
          )}
          {status.guidance.length > 0 && (
            <div className="lan-guidance">
              {status.guidance.map((line) => (
                <p key={line}>{line}</p>
              ))}
              {status.firewallAllowRule === "missing" && (
                <p className="lan-code">{firewallCommand}</p>
              )}
            </div>
          )}
          <div className="lan-actions">
            <button
              className="text-button"
              type="button"
              disabled={busy}
              onClick={onStop}
            >
              Stop viewer
            </button>
            <button className="text-button" type="button" onClick={onRefresh}>
              Refresh status
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="lan-note">
            {status.issue === "not_tauri" && status.configError
              ? status.configError
              : status.state === "disabled"
              ? "The LAN viewer is disabled by configuration."
              : status.state === "starting"
                ? "The LAN viewer is starting…"
                : status.state === "error"
                  ? "The LAN viewer could not start."
                  : "The LAN viewer is not running yet."}
          </p>
          {status.state === "stopped" && (
            <p className="lan-note">
              Start it to let any device on the same office Wi‑Fi open a
              read-only live attendance screen. {status.networkScope}
            </p>
          )}
          {status.issue === "no_lan_ip" && (
            <div className="lan-guidance">
              <p>
                <strong>No reachable office LAN IP was detected.</strong>{" "}
                Connect this laptop to the office Wi‑Fi/LAN, or set{" "}
                <code>lan.bind_address</code> to the office LAN IP in
                config.toml (loopback/localhost is never shareable).
              </p>
            </div>
          )}
          {status.issue === "loopback_bind" && (
            <div className="lan-guidance">
              <p>
                <strong>
                  Live Attendance is bound to localhost and cannot be reached by
                  other devices.
                </strong>{" "}
                Set <code>lan.bind_address</code> to the office LAN IP in
                config.toml, or leave it unset so the app auto-detects the Wi‑Fi
                address.
              </p>
            </div>
          )}
          {status.issue === "bind_address_not_present" && (
            <div className="lan-guidance">
              <p>
                <strong>
                  The configured bind address does not match an active network
                  adapter.
                </strong>{" "}
                The laptop’s current IP changed. Set{" "}
                <code>lan.bind_address</code> to the current office LAN IP (
                {status.activeLanIp || "unknown"}), or leave it unset to
                auto-detect.
              </p>
            </div>
          )}
          {status.issue === "port_in_use" && (
            <div className="lan-guidance">
              <p>
                <strong>Port {status.port} is already in use.</strong> Close the
                other program or change <code>lan.port</code> in config.toml,
                then start the viewer again.
              </p>
            </div>
          )}
          {status.issue === "config_invalid" && status.configError && (
            <div className="lan-guidance">
              <p>
                <strong>Invalid LAN configuration:</strong> {status.configError}
              </p>
            </div>
          )}
          {status.lastError && <p className="lan-error">{status.lastError}</p>}
          {status.state !== "disabled" && status.state !== "starting" && (
            <div className="lan-actions">
              <button
                className="admin-button file-action-primary"
                type="button"
                disabled={busy}
                onClick={onStart}
              >
                {busy ? "Starting…" : "Start LAN viewer"}
              </button>
              <button className="text-button" type="button" onClick={onRefresh}>
                Refresh status
              </button>
            </div>
          )}
        </>
      )}
      <div className="lan-facts">
        <span>
          Port <strong>{status.port}</strong>
        </span>
        <span>
          LAN IP{" "}
          <strong>{status.activeLanIp || status.bindAddress || "—"}</strong>
        </span>
        <span>
          Allowed subnets <strong>{subnetLabel}</strong>
        </span>
        <span>
          Firewall rule <strong>{firewallLabel}</strong>
        </span>
        <span>
          Local /api/health <strong>{healthLabel}</strong>
        </span>
        <span>
          Network profile{" "}
          <strong>{lanProfileLabel(status.networkProfile)}</strong>
        </span>
        <span>
          Connected viewers <strong>{status.connectedSseClients}</strong>
        </span>
        {status.configuredBindPresent ? (
          <span>
            Bind address <strong>On an active adapter</strong>
          </span>
        ) : (
          <span>
            Bind address <strong>Not on any adapter</strong>
          </span>
        )}
      </div>
    </section>
  );
}

/** Card reader status for the admin header: a coloured dot and a short word; the details open on click. */
export function ScannerDiagnostics() {
  const [status, setStatus] = useState<ScannerStatus | null>(null);
  const [lastActivity, setLastActivity] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const detailsId = useId();
  // The browser build has no desktop layer, so no reader status ever arrives there.
  const browserMode = !("__TAURI_INTERNALS__" in window);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenForScannerStatus((nextStatus) => {
        setStatus(nextStatus);
        setLastActivity(new Date().toISOString());
      })
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch(() => {
        /* web mode */
      });
    void getScannerStatus()
      .then((nextStatus) => {
        setStatus(nextStatus);
        setLastActivity(new Date().toISOString());
      })
      .catch(() => {
        /* web mode */
      });
    return () => unlisten?.();
  }, []);

  // Escape, or a click or keyboard focus anywhere else, closes the details. Escape only brings focus back to the
  // button when focus was on it, so an Escape typed elsewhere on the page never pulls focus up to the header.
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent | FocusEvent) => {
      if (event.target instanceof Node && !boxRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const focusInside = boxRef.current?.contains(document.activeElement) ?? false;
      setOpen(false);
      if (focusInside) buttonRef.current?.focus();
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const reader = !status
    ? browserMode
      ? { tone: "browser", word: "Browser mode" }
      : { tone: "checking", word: "Checking…" }
    : status.state === "offline"
      ? { tone: "missing", word: "Reader missing" }
      : status.state === "error"
        ? { tone: "error", word: "Reader error" }
        : { tone: "ready", word: "Reader ready" };

  const stateLabel = {
    connected: "Waiting for card",
    scanning: "Scan received",
    offline: "Scanner unavailable",
    error: "Scan error",
  } satisfies Record<ScannerStatus["state"], string>;

  return (
    <div className="reader-status" ref={boxRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`reader-status-button is-${reader.tone}`}
        aria-expanded={open}
        aria-controls={open ? detailsId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <i aria-hidden="true" />
        <span className="reader-status-word">{reader.word}</span>
      </button>
      {open && (
        <div id={detailsId} className="reader-status-details">
          {status ? (
            <>
              <p className="reader-status-headline">
                {status.paused ? "Paused — this screen is typing" : stateLabel[status.state]}
              </p>
              <p>Reader: Keyboard-mode RFID reader</p>
              <p>
                Last activity: {lastActivity ? formatTime(lastActivity, "Asia/Manila") : "Not yet recorded"}
              </p>
              <p>Keep the attendance window focused before scanning.</p>
              {status.detail && status.detail !== "Keep the attendance window focused before scanning" && (
                <p>{status.detail}</p>
              )}
            </>
          ) : browserMode ? (
            <>
              <p className="reader-status-headline">Opened in a web browser</p>
              <p>The card reader is checked only in the desktop app on the attendance PC.</p>
            </>
          ) : (
            <p className="reader-status-headline">Checking the card reader connection…</p>
          )}
        </div>
      )}
    </div>
  );
}

/** Compact brand lockup for the shared dashboard header (live + admin screens). */
function DashboardBrand() {
  return (
    <div className="dashboard-brand">
      <img
        className="dashboard-brand-mark"
        src={logoPhoenix}
        alt=""
        aria-hidden="true"
      />
      <span className="dashboard-brand-name">ALPHA PREMIER REALTY</span>
    </div>
  );
}

function AttendanceTable({
  rows,
  timezone,
  users = [],
  history = [],
  order,
  onToggleOrder,
}: {
  rows: AttendanceListItem[];
  timezone: string;
  users?: AdminUser[];
  history?: AttendanceListItem[];
  /** Time in order on screen (LiveAttendance keeps the viewer's choice). */
  order: TimeOrder;
  onToggleOrder: () => void;
}) {
  const clampedTimeInIds = useMemo(
    () => clampedGraceTimeInIds([...rows, ...history], users),
    [rows, users, history],
  );
  if (!rows.length)
    return (
      <div className="empty-state">No attendance has been recorded today.</div>
    );
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Employee</th>
            <th>Department</th>
            <TimeSortHeading label="Time in" order={order} onToggle={onToggleOrder} />
            <th>Time out</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {/* Sorted by the time shown: a clamped time-in sorts as its payable hour. */}
          {sortByTime(rows, (row) => (clampedTimeInIds.has(row.attendanceId) && row.timeIn ? clampedTimeInIso(row.timeIn) : row.timeIn), order).map((row) => {
            const late = row.status === "LATE_TIMEOUT";
            return (
              <tr key={row.attendanceId}>
                <td>
                  <strong>{row.fullName}</strong>
                  <small>{row.userId}</small>
                </td>
                <td>{row.department || "—"}</td>
                <td>
                  {clampedTimeInIds.has(row.attendanceId) && row.timeIn ? (
                    <span
                      className="clamped-time-in-chip clamped-time-in-static"
                      data-testid="clamped-time-in"
                      title={`Actual scan: ${formatTime(row.timeIn, timezone)} (payable time clamped)`}
                    >
                      {clampedTimeLabel(row.timeIn)}
                    </span>
                  ) : (
                    row.timeIn ? formatTime(row.timeIn, timezone) : "—"
                  )}
                </td>
                <td>{row.timeOut ? formatTime(row.timeOut, timezone) : "—"}</td>
                <td>
                  {late ? (
                    <>
                      <span
                        className="status-pill status-late_timeout"
                        title="Time-out recorded after office hours; manual correction required"
                      >
                        LATE TIMEOUT
                      </span>
                      <small className="status-hint">Correction needed</small>
                    </>
                  ) : (
                    <span
                      className={`status-pill status-${row.status.toLowerCase()}`}
                    >
                      {row.status}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type AdminTab = "users" | "attendance" | "payroll" | "data" | "voice";

// Attendance corrections first: it is the main reason an admin opens this page.
const ADMIN_TABS = [
  { id: "attendance", label: "Attendance corrections", Icon: ClipboardCheck },
  { id: "users", label: "Users and RFID", Icon: Users },
  { id: "payroll", label: "Payroll", Icon: Wallet },
  { id: "data", label: "Data and backup", Icon: Database },
  { id: "voice", label: "Voice announcements", Icon: Volume2 },
] satisfies { id: AdminTab; label: string; Icon: LucideIcon }[];

type ActiveThumb = { x: number; y: number; width: number; height: number };

/**
 * Where the active button (`button.is-active`) sits inside `ref`, so a thumb or underline can slide to it.
 * Re-measured when `activeKey` changes and whenever the bar or one of its buttons changes size.
 */
function useActiveThumb(ref: { readonly current: HTMLElement | null }, activeKey: string): ActiveThumb | null {
  const [thumb, setThumb] = useState<ActiveThumb | null>(null);
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!bar) {
      setThumb(null);
      return;
    }
    const place = () => {
      const active = bar.querySelector<HTMLElement>("button.is-active");
      if (active) setThumb({ x: active.offsetLeft, y: active.offsetTop, width: active.offsetWidth, height: active.offsetHeight });
    };
    place();
    if (!("ResizeObserver" in window)) return;
    const observer = new ResizeObserver(place);
    // Border boxes, so padding changes at narrow widths move the thumb too.
    observer.observe(bar, { box: "border-box" });
    bar.querySelectorAll("button").forEach((button) => observer.observe(button, { box: "border-box" }));
    return () => observer.disconnect();
  }, [ref, activeKey]);
  return thumb;
}

function AdminPanel() {
  const [unlocked, setUnlocked] = useState(false);
  useScannerPause(unlocked);
  const office = useOfficeIdentity();
  const [sessionExpiresAt, setSessionExpiresAt] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [adminMode, setAdminMode] = useState<"attendance" | "bathroom">("attendance");
  const [tab, setTab] = useState<AdminTab>("attendance");
  // The gold thumb behind the current tab; measured so it can slide between tabs of different widths.
  const tabsRef = useRef<HTMLDivElement>(null);
  const [date, setDate] = useState(localDate());
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [busy, setBusy] = useState(false);
  const [nuking, setNuking] = useState(false);
  const [nukeConfirmOpen, setNukeConfirmOpen] = useState(false);
  const [manualUpdateCheck, setManualUpdateCheck] = useState<number>(0);
  const [resettingPin, setResettingPin] = useState(false);
  const [pinNotice, setPinNotice] = useState("");
  // An admin card tap can unlock mid-reset; a later expiry must land on unlock, not reset.
  useEffect(() => {
    if (unlocked) setResettingPin(false);
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

  const tabThumb = useActiveThumb(tabsRef, `${unlocked}:${adminMode}:${tab}`);

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

  useEffect(() => {
    if (unlocked) return;
    let unlisten: (() => void) | undefined;
    void listenForGlobalRfid((scannedUid) => {
      void unlockWithPinOrRfid(scannedUid);
    })
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch(() => {});
    return () => {
      unlisten?.();
    };
  }, [unlocked, unlockWithPinOrRfid]);

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
    void checkAdminSession().then((expiresAt) => {
      setSessionExpiresAt(expiresAt ?? "");
      setUnlocked(Boolean(expiresAt));
    });
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
  if (!unlocked && resettingPin)
    return (
      <main className="dashboard-shell admin-login admin-shell">
        <a href="/"><Nfc size={16} aria-hidden="true" /> Scanner</a>
        <PinResetPanel
          onDone={(notice) => {
            setResettingPin(false);
            setPinNotice(notice ?? "");
          }}
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
            Scan registered admin RFID card or enter administrator PIN.
          </p>
          <label>
            Administrator PIN or Admin RFID card
            <input
              autoFocus
              type="password"
              placeholder="Enter PIN or scan admin card…"
              value={pin}
              onChange={(event) => {
                setPinNotice("");
                setPin(event.target.value);
              }}
            />
          </label>
          {error && <p className="dashboard-alert">{error}</p>}
          <button className="submit-button" disabled={busy || !pin.trim()}>
            Unlock admin
          </button>
          <NoticeLine notice={pinNotice ? { tone: "success", text: pinNotice } : null} />
          <button
            className="text-button"
            type="button"
            onClick={() => {
              setPinNotice("");
              setError("");
              setPin("");
              setResettingPin(true);
            }}
          >
            Forgot PIN?
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
          <ScannerDiagnostics />
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
      {/* Two separate glass bars on one row: the section tabs (Attendance mode only) and the mode switch. */}
      <div className="admin-toolbar">
        {adminMode === "attendance" && (
          <div className="admin-tabs" ref={tabsRef}>
            {tabThumb && (
              <span
                className="admin-tabs-thumb"
                aria-hidden="true"
                style={{ width: tabThumb.width, height: tabThumb.height, transform: `translate(${tabThumb.x}px, ${tabThumb.y}px)` }}
              />
            )}
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
        <div className="admin-mode-switcher" role="tablist" aria-label="Administrator mode switcher" data-active={adminMode}>
          <button
            type="button"
            role="tab"
            aria-selected={adminMode === "attendance"}
            className={`admin-mode-btn ${adminMode === "attendance" ? "is-active" : ""}`}
            onClick={() => setAdminMode("attendance")}
          >
            <span className="admin-mode-key-badge" aria-hidden="true">1</span>
            <span>Attendance</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={adminMode === "bathroom"}
            className={`admin-mode-btn ${adminMode === "bathroom" ? "is-active" : ""}`}
            onClick={() => leaveSection(() => setAdminMode("bathroom"))}
          >
            <span className="admin-mode-key-badge" aria-hidden="true">2</span>
            <span>Bathroom Key Log</span>
          </button>
        </div>
      </div>
      {adminMode === "bathroom" ? (
        <BathroomKeyLogPanel users={users} />
      ) : (
        <>
          {error && <p className="dashboard-alert">{error}</p>}
          {tab === "users" ? (
            <UserEditor
              users={users}
              editing={editing}
              setEditing={setEditing}
              onSaved={load}
              onDirtyChange={setUsersDirty}
              loadStatus={usersList.status}
              onRetry={() => void usersList.reload()}
            />
          ) : tab === "attendance" ? (
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
          ) : tab === "payroll" ? (
            <PayrollWorkspace
              records={cutoffsList.data}
              onSaved={load}
              loadStatus={cutoffsList.status}
              onRetry={() => void cutoffsList.reload()}
            />
          ) : tab === "voice" ? (
            <VoiceSettingsPanel />
          ) : (
            <DatabasePanel onManualUpdateCheck={() => setManualUpdateCheck(Date.now())} />
          )}
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

type AdminUser = {
  userId: string;
  rfidUid: string;
  fullName: string;
  department: string | null;
  status: "ACTIVE" | "INACTIVE";
  employeeType: "INTERN";
  gender: UserGender | null;
  dailyRate: number | null;
  payrollProfileId?: string | null;
  photoUrl?: string | null;
  cardType?: CardType;
  label?: string | null;
};

/** True when the registration form differs from the record it was opened with (the blank user when adding).
 *  Both sides are compared as save() would send them, so the clean-ups done on blur don't count as changes. */
function userFormChanged(form: AdminUser, base: AdminUser): boolean {
  const comparable = (user: AdminUser) => [
    user.userId.trim().toUpperCase(),
    user.rfidUid.trim().toUpperCase(),
    normalizeName(user.fullName),
    (user.department ?? "").trim().replace(/\s+/g, " "),
    user.status,
    user.gender ?? "",
    user.photoUrl ?? "",
    user.cardType ?? "EMPLOYEE",
  ];
  const a = comparable(form);
  const b = comparable(base);
  return a.some((value, index) => value !== b[index]);
}

/** Data & backup panel: configurable DB location, safe backups, and the PC-switch restore flow. */
type RestoreFailureDetail = {
  friendly: string;
  sourceFile: string | null;
};

function describeRestoreFailure(raw: string): RestoreFailureDetail {
  const text = raw.trim();
  let sourceFile: string | null = null;
  let detail = text;
  const sep = text.indexOf(": ");
  if (sep > 0) {
    const head = text.slice(0, sep).trim();
    if (head.length > 0 && head.length < 300 && /[/\\.]/.test(head)) {
      sourceFile = head.split(/[/\\]/).filter(Boolean).pop() ?? head;
      detail = text.slice(sep + 2).trim() || head;
    }
  }
  const lower = detail.toLowerCase();
  if (lower.includes("missing") || lower.includes("not found") || lower.includes("no such file")) {
    return {
      friendly: "The selected backup file could no longer be found when the app restarted (it may have been moved, renamed, or removed from the USB drive).",
      sourceFile,
    };
  }
  if (
    lower.includes("not a valid") ||
    lower.includes("not an alpha premier") ||
    lower.includes("integrity") ||
    lower.includes("foreign key") ||
    lower.includes("schema") ||
    lower.includes("not a database") ||
    lower.includes("file is encrypted")
  ) {
    return {
      friendly: "The selected file is not a valid Alpha Premier attendance backup (it failed the database integrity check).",
      sourceFile,
    };
  }
  if (
    lower.includes("unsafe path") ||
    lower.includes("zip") ||
    lower.includes("unpack") ||
    lower.includes("config") ||
    lower.includes("staging")
  ) {
    return {
      friendly: "The backup file could not be unpacked on this computer (the archive looks incomplete or damaged).",
      sourceFile,
    };
  }
  return {
    friendly: "The restore could not be applied on the next launch.",
    sourceFile,
  };
}

function dtrSyncSourceLabel(source: DtrSyncSource | undefined): string {
  return source === "queue" ? "Queue" : "Manual";
}

function applyDtrProgressToGuard(progress: DtrSyncProgress): void {
  if (progress.status === "starting" || progress.status === "syncing") {
    setDtrSyncActive(true);
  } else if (progress.status === "done" || progress.status === "complete" || progress.status === "error") {
    setDtrSyncActive(false);
  }
}

type SyncHealthState =
  | { kind: "loading" }
  | { kind: "ready"; health: DtrSyncHealth }
  | { kind: "refreshing"; health: DtrSyncHealth }
  | { kind: "stale"; health: DtrSyncHealth; message: string }
  | { kind: "error"; message: string }
  | { kind: "syncing" };

type StoppedDtrSync = { tab: string; userId: string | null };

function dtrHealthCopy(health: DtrSyncHealth | null, stale: boolean): string | null {
  if (stale) return "DTR status update delayed";
  const dtr = health?.dtr;
  if (!dtr) return null;
  if (dtr.activity === "unavailable") return "DTR status unavailable. Attendance continues to save locally.";
  if (dtr.retryablePending > 0) {
    const eligibility = dtr.nextRetryEligibleAt
      ? ` Next retry eligibility: ${formatDateTime(dtr.nextRetryEligibleAt)}.`
      : "";
    return `${dtr.retryablePending} punches are waiting for retry. Retry attempts are bounded.${eligibility}`;
  }
  if (!dtr.enabled || dtr.activity === "disabled") return "Sheet syncing paused; attendance recording continues.";
  if (dtr.dead > 0) return `Some punches need admin help (${dtr.dead} permanently failed).`;
  if (dtr.needsAttention > 0) return "Punches need admin attention before they can sync.";
  if (dtr.persistenceFailure || dtr.currentIssue === "persistence") return "An attendance punch could not be queued for DTR sync; notify an administrator.";
  if (dtr.currentIssue === "auth_config" || dtr.currentIssue === "unresolved_layout") return "Punches need admin attention before they can sync.";
  if (dtr.activity === "throttled") return "Google Sheets is rate-limiting sync. Punches are safe and waiting.";
  if (dtr.activity === "retrying") return "DTR retry attempts are in progress; attempts are bounded.";
  if (dtr.activity === "offline") return "DTR connection unavailable.";
  if (dtr.retryablePending > 0 || dtr.activity === "queued" || dtr.queued > 0) return "Punches are waiting in the DTR queue.";
  return null;
}

export function DatabasePanel(props: { onManualUpdateCheck?: () => void } = {}) {
  // Results that need reading stay on the page; routine ones (backup created, saved a copy) show as toasts.
  const [message, setMessage] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [stoppedDtrSync, setStoppedDtrSync] = useState<StoppedDtrSync | null>(null);
  const [backupResult, setBackupResult] = useState<GeneratedFileResult | null>(
    null,
  );
  const [restoreFile, setRestoreFile] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [dismissingRestore, setDismissingRestore] = useState(false);
  const [syncState, setSyncState] = useState<SyncHealthState>({ kind: "loading" });
  const [dtrProgress, setDtrProgress] = useState<DtrSyncProgress | null>(null);
  const dtrSyncActive = useDtrSyncActive();
  // Per-device DTR kill switch: null = still loading, boolean = stored state.
  const [dtrSyncEnabled, setDtrSyncEnabled] = useState<boolean | null>(null);
  const [dtrToggleBusy, setDtrToggleBusy] = useState(false);
  const syncHealth =
    syncState.kind === "ready" || syncState.kind === "refreshing" || syncState.kind === "stale"
      ? syncState.health
      : null;
  const dtrDead = syncHealth?.dtr?.dead ?? 0;
  const syncBadge = (() => {
    if (syncState.kind === "syncing") return { label: "Syncing", className: "sync-badge pending" };
    if (syncState.kind === "error") return { label: "DTR status unavailable", className: "sync-badge idle" };
    if (syncState.kind === "stale") return { label: "DTR status delayed", className: "sync-badge idle" };
    if (!syncHealth?.dtr) return { label: "DTR status unavailable", className: "sync-badge idle" };
    if (syncHealth.dtr.dead > 0 || syncHealth.dtr.needsAttention > 0) return { label: "DTR attention", className: "sync-badge attention" };
    if (syncHealth.dtr.activity === "queued" || syncHealth.dtr.queued > 0 || syncHealth.dtr.retryablePending > 0 || syncHealth.dtr.retrying > 0 || syncHealth.dtr.processing > 0) return { label: "DTR pending", className: "sync-badge pending" };
    if (syncHealth.dtr.activity === "disabled") return { label: "DTR paused", className: "sync-badge idle" };
    return { label: "DTR idle", className: "sync-badge idle" };
  })();

  const syncHealthSeq = useRef(0);
  const refreshSyncHealth = useCallback(async (releaseSyncing = false) => {
    setSyncState((prev) =>
      // A manual sync owns the badge while it is in flight: a background poll
      // must not downgrade `syncing` to `loading`/`refreshing` and make the
      // panel read "Not synced" mid-sync.
      prev.kind === "syncing"
        ? prev
        : prev.kind === "ready" || prev.kind === "refreshing" || prev.kind === "stale"
          ? { kind: "refreshing", health: prev.health }
          : { kind: "loading" },
    );
    const seq = syncHealthSeq.current + 1;
    syncHealthSeq.current = seq;
    const response = await loadDtrSyncHealth();
    if (syncHealthSeq.current !== seq) return;
    if (response.success && response.health.dtr) {
      setDtrSyncHealthSnapshot({
        activity: response.health.dtr.activity,
        queued: response.health.dtr.queued,
        retryablePending: response.health.dtr.retryablePending,
        needsAttention: response.health.dtr.needsAttention,
        dead: response.health.dtr.dead,
        persistenceFailure: response.health.dtr.persistenceFailure,
        emittedAt: response.health.dtr.emittedAt,
      });
    } else {
      setDtrSyncHealthSnapshot({
        activity: "unavailable",
        queued: 0,
        retryablePending: 0,
        needsAttention: 0,
        dead: 0,
        persistenceFailure: false,
      });
    }
    setSyncState((prev) => {
      // A background poll must not dislodge `syncing`; only the manual sync's
      // own post-sync refresh (releaseSyncing) may leave it — :3339 is the
      // sole exit from `syncing`, so a blanket guard would strand the badge.
      if (prev.kind === "syncing" && !releaseSyncing) return prev;
      if (response.success) return { kind: "ready", health: response.health };
      if (prev.kind === "ready" || prev.kind === "refreshing" || prev.kind === "stale") {
        return { kind: "stale", health: prev.health, message: response.error.message };
      }
      return { kind: "error", message: response.error.message };
    });
  }, []);
  const refreshDtrSyncToggle = useCallback(async () => {
    const response = await getInternDtrSync();
    if (response.success) setDtrSyncEnabled(response.enabled);
  }, []);
  useEffect(() => startDtrSyncHealthPolling(() => refreshSyncHealth()), [refreshSyncHealth]);
  useEffect(() => {
    void refreshDtrSyncToggle();
  }, [refreshDtrSyncToggle]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenForDtrSyncProgress((progress) => {
      setDtrProgress(progress);
      applyDtrProgressToGuard(progress);
      if (progress.status === "done" || progress.status === "complete" || progress.status === "error") void refreshDtrSyncHealth(() => refreshSyncHealth());
    })
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch(() => {
        /* web mode or mock environment */
      });
    return () => {
      if (unlisten) unlisten();
    };
  }, [refreshSyncHealth]);

  const fetchInfo = useCallback(async (): Promise<DatabaseInfoResponse | null> => {
    const response = await loadDatabaseInfo();
    if (!response.success) throw new Error(response.error.message);
    return response;
  }, []);
  const infoList = useListLoad(fetchInfo, null);
  const info = infoList.data;
  const guideRef = useRef<HTMLElement>(null);
  useDialogKeys(guideRef, () => setGuideOpen(false), { open: guideOpen });

  const toggleDtrSync = async () => {
    if (dtrSyncEnabled === null || dtrToggleBusy) return;
    const next = !dtrSyncEnabled;
    setDtrToggleBusy(true);
    setMessage(null);
    const response = await setInternDtrSync(next);
    if (response.success) {
      setDtrSyncEnabled(response.enabled);
      void refreshDtrSyncHealth(() => refreshSyncHealth());
      showToast(response.enabled ? "Intern DTR sync turned on for this device." : "Intern DTR sync turned off for this device. Queued punches are kept.");
    } else {
      setMessage({ tone: "error", text: response.error?.message ?? "DTR sync toggle failed." });
    }
    setDtrToggleBusy(false);
  };

  const syncInterns = async (startFromUserId?: string) => {
    if (dtrSyncActive) {
      setMessage({ tone: "info", text: "Sync already running." });
      return;
    }
    setBusy(true);
    setSyncState({ kind: "syncing" });
    setDtrSyncActive(true);
    setDtrProgress(null);
    setMessage(null);
    try {
      const response = await syncInternDtr(undefined, startFromUserId);
      const hasErrors = Array.isArray(response.errors) && response.errors.length > 0;
      if (response.stoppedTab || response.stoppedUserId) {
        const stoppedDetail = (response.stoppedUserId
          ? response.details.find((detail) => detail.userId === response.stoppedUserId)
          : undefined)
          ?? (response.stoppedTab
            ? response.details.find((detail) => detail.tab === response.stoppedTab)
            : undefined);
        setStoppedDtrSync({
          tab: response.stoppedTab ?? stoppedDetail?.fullName ?? "Unknown tab",
          userId: response.stoppedUserId ?? stoppedDetail?.userId ?? null,
        });
      } else if (response.success && !hasErrors) {
        setStoppedDtrSync(null);
      }
      if (response.success && !hasErrors) {
        const createdCount = response.tabsCreated?.length ?? 0;
        const createdMsg = createdCount > 0 ? ` (${createdCount} new tab(s) created: ${response.tabsCreated.join(", ")})` : "";
        setMessage({ tone: "success", text: `DTR sync complete: checked ${response.internsChecked ?? 0} intern(s), synced ${response.rowsSynced ?? 0} row(s)${createdMsg}.` });
      } else {
        const errDetail = hasErrors
          ? response.errors.join("; ")
          : response.error?.message || "DTR sync failed.";
        if (isDtrSyncAlreadyRunning(errDetail)) {
          setMessage({ tone: "info", text: "Sync already running." });
        } else if (response.rowsSynced > 0) {
          setMessage({ tone: "error", text: `Synced ${response.rowsSynced} row(s), but encountered errors: ${errDetail}` });
        } else {
          setMessage({ tone: "error", text: errDetail });
        }
      }
    } finally {
      setBusy(false);
      setDtrSyncActive(false);
      setDtrProgress(null);
    }
    setSyncState((prev) => prev.kind === "syncing"
      ? syncHealth ? { kind: "refreshing", health: syncHealth } : { kind: "loading" }
      : prev);
    void refreshDtrSyncHealth(() => refreshSyncHealth(true));
  };

  const createBackup = async () => {
    setBusy(true);
    setMessage(null);
    const response = await createDatabaseBackup();
    setBusy(false);
    if (response.success) {
      showToast(`Backup created: ${response.fileName}`);
      setBackupResult({
        filePath: null,
        directoryPath: response.directoryPath,
        fileName: response.fileName,
        fileKind: response.fileKind,
        isPortableMode: response.isPortableMode,
      });
      void infoList.refresh();
    } else setMessage({ tone: "error", text: response.error.message });
  };

  const restore = async () => {
    if (!("__TAURI_INTERNALS__" in window)) {
      setMessage({ tone: "error", text: "Restore is available in the desktop application." });
      return;
    }
    try {
      const selected = await pickRestoreBackupFile();
      if (!selected) return;
      setRestoreFile(selected);
    } catch {
      setMessage({ tone: "error", text: "Unable to open the file picker." });
    }
  };

  const confirmRestore = async () => {
    if (!restoreFile) return;
    const file = restoreFile;
    setRestoreFile(null);
    setBusy(true);
    setMessage(null);
    const response = await requestDatabaseRestore(file);
    setBusy(false);
    // A scheduled restore closes the app, so it stays on the page rather than in a toast.
    if (response.success) setMessage({ tone: "success", text: response.message });
    else setMessage({ tone: "error", text: response.error.message });
  };

  const dismissRestoreNotice = async () => {
    setDismissingRestore(true);
    const response = await dismissRestoreFailure();
    setDismissingRestore(false);
    if (response.success) {
      void infoList.refresh();
      showResult({ tone: "success", text: "Restore notice dismissed. Your current data was left untouched." }, setMessage);
    } else {
      setMessage({ tone: "error", text: response.error.message });
    }
  };

  const openBackups = async () => {
    const outcome = await openDatabaseBackupsFolder();
    if (!outcome.ok) setMessage({ tone: "error", text: outcome.message });
  };

  const downloadBackup = async (filePath: string, fileName: string) => {
    setMessage(null);
    const outcome = await saveBackupCopy(filePath, fileName);
    if (outcome === null) return;
    if (outcome.ok) showToast(outcome.message);
    else setMessage({ tone: "error", text: outcome.message });
  };

  const formatSize = (bytes: number) =>
    bytes > 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const formatWhen = (value: string | null) => (value ? formatDateTime(value) : "—");

  // One fold per calendar month; backups arrive newest-first, so the first month is the latest.
  const backupMonths: { label: string; backups: DatabaseInfoResponse["backups"] }[] = [];
  for (const backup of info?.backups ?? []) {
    const date = backup.modifiedAt ? new Date(backup.modifiedAt) : null;
    const label = date && !Number.isNaN(date.getTime()) ? formatMonth(date) : "Unknown date";
    const month = backupMonths.find((group) => group.label === label);
    if (month) month.backups.push(backup);
    else backupMonths.push({ label, backups: [backup] });
  }

  return (
    <section className="lan-panel" aria-label="Database and backup">
      <div className="lan-panel-head">
        <div>
          <p className="section-kicker">Data and backup</p>
          <h2>Move the attendance database to a new computer</h2>
        </div>
        <button className="admin-button db-guide-button" type="button" onClick={() => setGuideOpen(true)}>
          <BookOpen size={15} aria-hidden="true" /> How to move to a new PC
        </button>
      </div>
      <div className="lan-facts db-facts">
        <span>
          Database file{" "}
          <strong className="db-path-value" title={info?.dbPath}><bdi>{info?.dbPath ?? "—"}</bdi></strong>
        </span>
        <span>
          Storage mode{" "}
          <strong>
            {info?.isPortableMode
              ? "Portable — next to the .exe"
              : "Installed — app data folder"}
          </strong>
        </span>
        <span>
          Saved backups <strong>{info?.backups.length ?? 0}</strong>
        </span>
        <span>
          Pending restore{" "}
          <strong>
            {info?.restorePending ? "Yes — restart to apply" : "None"}
          </strong>
        </span>
      </div>
      {info?.restoreFailed && (() => {
        const failure = describeRestoreFailure(info.restoreFailed ?? "");
        return (
          <div className="warning-banner" role="alert">
            <ShieldAlert size={20} />
            <div>
              <strong>Restore didn&apos;t go through — your current data is safe</strong>
              <p>{failure.friendly}</p>
              {failure.sourceFile && (
                <p>Backup file: <code>{failure.sourceFile}</code></p>
              )}
              <p>Your current database was kept — nothing was replaced and no attendance data was lost.</p>
              <p>What to do next: pick the correct <code>attendance-backup-*.apbackup</code> file and choose Restore again, or dismiss this notice if you no longer need the restore.</p>
              <details>
                <summary>Technical details (for support)</summary>
                <code>{info.restoreFailed}</code>
              </details>
              <div className="lan-actions" style={{ marginTop: 8 }}>
                <button
                  className="admin-button file-action-primary"
                  type="button"
                  disabled={busy || dismissingRestore}
                  onClick={() => void restore()}
                >
                  Try again…
                </button>
                <button
                  className="admin-button"
                  type="button"
                  disabled={busy || dismissingRestore}
                  onClick={() => void dismissRestoreNotice()}
                >
                  {dismissingRestore ? "Dismissing…" : "Dismiss"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
      <div className="lan-actions db-actions">
        <div className="db-action-group">
          <button
            className="admin-button file-action-primary"
            type="button"
            disabled={busy}
            onClick={() => void createBackup()}
          >
            {busy ? "Working…" : "Create backup now"}
          </button>
          <button
            className="admin-button"
            type="button"
            disabled={busy}
            onClick={() => void restore()}
          >
            Restore from backup file…
          </button>
          <button
            className="admin-button"
            type="button"
            onClick={() => void openBackups()}
          >
            Open backups folder
          </button>
        </div>
        <div className="db-action-group db-sync-group">
          <button
            className="admin-button"
            type="button"
            data-testid="dtr-sync-now"
            disabled={busy || dtrSyncActive}
            onClick={() => void syncInterns()}
          >
            Sync Intern DTR now
          </button>
          <label className="sync-toggle" title="Per-device kill switch: OFF on this PC never affects deployment. While OFF, punches queue locally and manual sync refuses.">
            <input
              type="checkbox"
              checked={dtrSyncEnabled ?? true}
              disabled={dtrSyncEnabled === null || dtrToggleBusy || busy}
              onChange={() => void toggleDtrSync()}
              aria-label="Sync intern attendance to the DTR sheet on this device"
            />
            Sync interns to DTR sheet on this device{dtrSyncEnabled === false ? " (OFF — queuing only)" : ""}
          </label>
        </div>
      </div>
      {stoppedDtrSync && (
        <p className="load-failed" role="status">
          Stopped at {stoppedDtrSync.tab}{" "}
          <button
            className="text-button"
            type="button"
            disabled={busy || dtrSyncActive || stoppedDtrSync.userId === null}
            onClick={() => {
              if (stoppedDtrSync.userId !== null) void syncInterns(stoppedDtrSync.userId);
            }}
          >
            Retry
          </button>
        </p>
      )}
      <NoticeLine notice={message} />
      <div className="sync-health" aria-label="DTR sync status" role="status">
        <div className="sync-health-head">
          <strong>DTR sync status</strong>
          <span className={syncBadge.className} aria-label="DTR-only sync status">{syncState.kind === "syncing" ? "Syncing…" : syncBadge.label}</span>
          {dtrDead > 0 && (
            <span className="sync-badge attention" aria-label="DTR sync failures">DTR sync failures: {dtrDead}</span>
          )}
        </div>
        {syncState.kind === "syncing" && (
          <div
            className="sync-progress-wrap"
            role="progressbar"
            aria-valuenow={dtrProgress && dtrProgress.total > 0 ? Math.round((dtrProgress.current / dtrProgress.total) * 100) : 0}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Intern DTR sync progress"
          >
            <div className="sync-progress-status">
              <strong>
                {dtrProgress
                  ? dtrProgress.status === "starting"
                    ? `Starting DTR sync (${dtrProgress.total} interns)…`
                    : `Syncing intern ${dtrProgress.current} of ${dtrProgress.total}: ${dtrProgress.fullName}`
                  : "Syncing intern DTR sheets…"}
              </strong>
              <span className="sync-badge idle">{dtrSyncSourceLabel(dtrProgress?.source)}</span>
              <span>
                {dtrProgress && dtrProgress.total > 0
                  ? `${Math.min(100, Math.round((dtrProgress.current / dtrProgress.total) * 100))}%`
                  : "…"}
              </span>
            </div>
            <div className="sync-progress-bar">
              <div
                className="sync-progress-fill"
                style={{
                  width: `${dtrProgress && dtrProgress.total > 0 ? Math.min(100, Math.round((dtrProgress.current / dtrProgress.total) * 100)) : 0}%`,
                }}
              />
            </div>
          </div>
        )}
        {syncState.kind === "error" ? (
        <p className="sync-health-note">DTR status unavailable — {syncState.message}</p>
        ) : (
          <>
            {dtrHealthCopy(syncHealth, syncState.kind === "stale") && (
              <p className={syncHealth?.dtr?.dead || syncHealth?.dtr?.needsAttention ? "sync-health-error" : "sync-health-note"}>
                {dtrHealthCopy(syncHealth, syncState.kind === "stale")}
              </p>
            )}
            {syncState.kind === "stale" && (
              <p className="sync-health-error">Sync status unavailable — showing last known data ({syncState.message})</p>
            )}
            <ul className="sync-health-rows">
              {(syncHealth?.byTable ?? []).map((row) => (
                <li key={row.tableName}>
                  <code>{row.tableName}</code>
                  <span className={row.pending > 0 ? "sync-badge pending" : "sync-badge ok"}>
                    {row.pending > 0 ? `${row.pending} pending` : "OK"}
                  </span>
                </li>
              ))}
              <li>
                <code>InternDtr tabs</code>
                <span className={(syncHealth?.dtrPendingCount ?? 0) > 0 ? "sync-badge pending" : "sync-badge ok"}>
                  {(syncHealth?.dtrPendingCount ?? 0) > 0
                    ? `${syncHealth?.dtrPendingCount} pending`
                    : "OK"}
                </span>
              </li>
            </ul>
            {(syncHealth?.dtrPendingItems ?? []).length > 0 && (
              <p className="sync-health-note">
                Waiting for a tab: {(syncHealth?.dtrPendingItems ?? []).slice(0, 5).map((person) => person.fullName).join(", ")}
                {(syncHealth?.dtrPendingCount ?? 0) > 5 ? ` (+${(syncHealth?.dtrPendingCount ?? 0) - 5} more)` : ""}
              </p>
            )}
            {syncHealth?.throttledUntil && (
              <p className="sync-health-error">
                Throttled until {formatWhen(syncHealth.throttledUntil)}
                {syncHealth.lastThrottleReason ? ` — ${syncHealth.lastThrottleReason}` : ""}
              </p>
            )}
            {syncHealth?.inProgress && (
              <p className="sync-health-note">
                Sync in progress — {syncHealth.inProgress.owner} since {formatWhen(syncHealth.inProgress.startedAt)}
              </p>
            )}
            {(syncHealth?.leaseRecovered ?? 0) > 0 && (
              <p className="sync-health-note">Lease recovered: {syncHealth?.leaseRecovered}</p>
            )}
            {(syncHealth?.oldestRetryableAgeSec ?? null) !== null && (
              <p className={syncHealth?.pendingAgeAlert ? "sync-health-error" : "sync-health-note"}>
                Oldest retryable: {formatDuration(syncHealth?.oldestRetryableAgeSec ?? 0)} old
                {syncHealth?.pendingAgeAlert ? " — over 6h, queue needs attention" : ""}
              </p>
            )}
            <p className="sync-health-note">
              Last sync: {formatWhen(syncHealth?.lastSyncedAt ?? null)}
              {dtrDead > 0 ? (
                <>
                  {` · ${dtrDead} failed DTR item(s) `}
                  <button className="text-button" type="button" disabled={busy} onClick={() => void syncInterns()}>
                    Retry sync now
                  </button>
                </>
              ) : ""}
            </p>
          </>
        )}
      </div>
      <AdminUpdatesCard onManualCheck={props.onManualUpdateCheck ?? (() => {})} />
      <GeneratedFileActions result={backupResult} label="Latest backup" />
      {infoList.status === "loading" && <p className="load-pending">Loading backups…</p>}
      {/* In a browser the backup tools are not there at all, so that is a calm note with no Retry. */}
      {infoList.status === "failed" &&
        ("__TAURI_INTERNALS__" in window ? (
          <LoadFailed what="the backup list" reason={infoList.error} onRetry={() => void infoList.reload()} />
        ) : (
          <NoticeLine notice={{ tone: "info", text: infoList.error ?? "Backups are available in the desktop application." }} />
        ))}
      {info && info.backups.length > 0 && (
        <details className="db-backup-list" open>
          <summary>
            Existing backups <span className="db-backup-count">{info.backups.length}</span>
          </summary>
          <div className="db-backup-months">
            {backupMonths.map((month) => (
              <details key={month.label} className="db-backup-month">
                <summary>
                  {month.label} <span className="db-backup-count">{month.backups.length}</span>
                </summary>
                <ul>
                  {month.backups.map((backup) => (
                    <li key={backup.filePath}>
                      <code>{backup.fileName}</code>
                      <span>{formatSize(backup.sizeBytes)}</span>
                      <span>{formatWhen(backup.modifiedAt)}</span>
                      <div className="db-backup-actions">
                        <button
                          className="admin-button"
                          type="button"
                          disabled={busy}
                          onClick={() => setRestoreFile(backup.filePath)}
                        >
                          <History size={14} aria-hidden="true" /> Restore
                        </button>
                        <button
                          className="admin-button"
                          type="button"
                          disabled={busy}
                          onClick={() => void downloadBackup(backup.filePath, backup.fileName)}
                        >
                          <Download size={14} aria-hidden="true" /> Download
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
        </details>
      )}
      {guideOpen && (
        <div className="confirm-backdrop" role="presentation">
          <section ref={guideRef} className="confirm-dialog db-guide-dialog" role="dialog" aria-modal="true" aria-labelledby="db-guide-heading">
            <BookOpen size={22} aria-hidden="true" />
            <h2 id="db-guide-heading">Moving to the new front-desk PC</h2>
            <p>No data loss, no manual SQL:</p>
            <ol className="db-steps">
              <li>
                On the <strong>old PC</strong>: open Admin → Data and backup and
                press <strong>Create backup now</strong>. The app writes a
                consistent copy of the entire database (SQLite online backup — safe
                even while the app is running) and keeps the newest 10.
              </li>
              <li>
                Copy the <code>attendance-backup-*.apbackup</code> file to a USB drive (or
                the office network) — <strong>Download</strong> next to it under Existing
                backups saves a copy wherever you choose — and plug it into the{" "}
                <strong>new PC</strong>.
              </li>
              <li>
                On the <strong>new PC</strong>: open Admin → Data and backup, press{" "}
                <strong>Restore from backup file…</strong>, select the copied file,
                and confirm. The app closes, restores the database on the next
                launch, and starts with all users, attendance, payroll, and settings
                intact.
              </li>
            </ol>
            <p>
              A backup is also written automatically every time the app closes
              cleanly. If the new PC already has data, restoring replaces it — the
              previous database is saved first under{" "}
              <code>backups/pre-restore-*.db</code> so the restore can always be
              rolled back. The database file location is configurable in{" "}
              <code>config.toml</code> (<code>[database] path</code>) — see
              docs/database-migration.md.
            </p>
            <div className="confirm-actions">
              <button className="submit-button" type="button" onClick={() => setGuideOpen(false)}>
                <Check size={16} /> Got it
              </button>
            </div>
          </section>
        </div>
      )}
      <ConfirmDialog
        open={Boolean(restoreFile)}
        busy={busy}
        tone="danger"
        title="Restore database from backup?"
        message="The app will close and restore the database from the selected file on the next launch. Any data on this device will be replaced."
        confirmLabel="Restore database"
        onCancel={() => setRestoreFile(null)}
        onConfirm={() => void confirmRestore()}
      />
    </section>
  );
}
export function UserEditor({
  users = [],
  editing,
  setEditing,
  onSaved,
  onDirtyChange,
  loadStatus = "ready",
  onRetry,
}: {
  users?: AdminUser[];
  editing: AdminUser | null;
  setEditing: (user: AdminUser | null) => void;
  onSaved: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Where the users list load stands (Admin loads it); loading shows placeholder rows, failed shows Retry. */
  loadStatus?: LoadStatus;
  onRetry?: () => void;
}) {
  const safeUsers = users ?? [];
  const blankUser: AdminUser = {
    userId: "",
    rfidUid: "",
    fullName: "",
    department: "",
    status: "ACTIVE",
    employeeType: "INTERN",
    gender: null,
    dailyRate: null,
    payrollProfileId: null,
    photoUrl: null,
  };
  const [form, setForm] = useState<AdminUser>(editing ?? blankUser);
  // Progress and problems stay on the page; routine successes (saved, deleted) show as toasts.
  const [message, setMessage] = useState<Notice | null>(null);
  const [deletingUserId, setDeletingUserId] = useState("");
  const [deleteUserTarget, setDeleteUserTarget] = useState<AdminUser | null>(null);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [batchDeleteUsersOpen, setBatchDeleteUsersOpen] = useState(false);
  const [batchUpdatingUsers, setBatchUpdatingUsers] = useState(false);
  const [syncingDtrUserId, setSyncingDtrUserId] = useState<string | null>(null);
  const [dtrProgress, setDtrProgress] = useState<DtrSyncProgress | null>(null);
  const dtrSyncActive = useDtrSyncActive();
  const [voiceClipStates, setVoiceClipStates] = useState<Record<string, VoiceClipState>>({});
  const [playingVoiceUserId, setPlayingVoiceUserId] = useState<string | null>(null);
  const [regeneratingVoiceUserId, setRegeneratingVoiceUserId] = useState<string | null>(null);
  // Latest-run-wins owner of the single regen loader slot: a superseded run
  // must write nothing (loader, snapshot, or message).
  const regeneratingVoiceOwner = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadVoiceClipStates()
      .then((states) => {
        if (cancelled) return;
        const mapped: Record<string, VoiceClipState> = {};
        for (const state of states) mapped[state.personId] = state;
        setVoiceClipStates(mapped);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [users]);
  const [userSearch, setUserSearch] = useState("");
  const [photoUploading, setPhotoUploading] = useState(false);
  const [isDraggingPhoto, setIsDraggingPhoto] = useState(false);
  const [photoBuster, setPhotoBuster] = useState(() => Date.now());
  const masterUserCheckboxRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenForDtrSyncProgress((progress) => {
      setDtrProgress(progress);
      applyDtrProgressToGuard(progress);
      if (progress.status === "syncing") {
        setMessage({ tone: "info", text: `Syncing intern ${progress.current} of ${progress.total}: ${progress.fullName}…` });
      }
    })
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch(() => {
        /* web mode or mock environment */
      });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const handleSyncDtr = async (userId?: string) => {
    if (dtrSyncActive) {
      setMessage({ tone: "info", text: "Sync already running." });
      return;
    }
    setSyncingDtrUserId(userId ?? "ALL");
    setDtrSyncActive(true);
    setDtrProgress(null);
    setMessage({ tone: "info", text: userId ? "Syncing intern DTR sheet…" : "Starting intern DTR sync…" });
    try {
      const response = await syncInternDtr(userId);
      const hasErrors = Array.isArray(response.errors) && response.errors.length > 0;
      if (response.success && !hasErrors) {
        const createdCount = response.tabsCreated?.length ?? 0;
        const createdMsg = createdCount > 0 ? ` (${createdCount} new tab(s) created: ${response.tabsCreated.join(", ")})` : "";
        setMessage({ tone: "success", text: `DTR sync complete: checked ${response.internsChecked ?? 0} intern(s), synced ${response.rowsSynced ?? 0} row(s)${createdMsg}.` });
      } else {
        const errDetail = hasErrors
          ? response.errors.join("; ")
          : response.error?.message || "DTR sync failed.";
        setMessage(isDtrSyncAlreadyRunning(errDetail) ? { tone: "info", text: "Sync already running." } : { tone: "error", text: `DTR sync error: ${errDetail}` });
      }
    } finally {
      setSyncingDtrUserId(null);
      setDtrSyncActive(false);
      setDtrProgress(null);
    }
  };

  const handlePlayVoiceClip = async (userId: string, fullName: string) => {
    setPlayingVoiceUserId(userId);
    try {
      const url =
        (await getWorkerNameAudioUrl(userId)) ?? getClonedBeaNameAudioUrl(userId, fullName);
      if (url) {
        await previewVoiceClip(url);
      }
    } finally {
      setPlayingVoiceUserId(null);
    }
  };

  const handleRegenerateVoiceClip = async (userId: string) => {
    regeneratingVoiceOwner.current = userId;
    setRegeneratingVoiceUserId(userId);
    setMessage(null);
    try {
      const result = await regenerateVoiceClip(userId);
      if (regeneratingVoiceOwner.current !== userId) return;
      if (!result.ok) {
        setMessage({ tone: "error", text: result.error ?? "Voice regeneration failed." });
        return;
      }
      const applySnapshot = (states: VoiceClipState[]): void => {
        const mapped: Record<string, VoiceClipState> = {};
        for (const state of states) mapped[state.personId] = state;
        setVoiceClipStates(mapped);
      };
      // The queue call above returns fast; the worker clones in the
      // background. Keep the row loader up until this person's job reads
      // DONE so the user watches Queued → Cloning → Ready to the finish.
      const outcome = await pollVoiceClipReady(userId, {
        load: loadVoiceClipStates,
        onSnapshot: applySnapshot,
        isCancelled: () => regeneratingVoiceOwner.current !== userId,
      });
      if (outcome === "aborted") return;
      if (regeneratingVoiceOwner.current !== userId) return;
      try {
        applySnapshot(await loadVoiceClipStates());
      } catch {
        // Keep the previous snapshot on refresh failure.
      }
      if (outcome === "ready") {
        showToast(`Voice clip ready (${result.spokenText ?? userId}). Plays automatically on the next scan.`);
      } else {
        setMessage({ tone: "info", text: `Voice clip queued for regeneration (${result.spokenText ?? userId}). Still working — it plays automatically once pulled.` });
      }
    } finally {
      if (regeneratingVoiceOwner.current === userId) regeneratingVoiceOwner.current = null;
      setRegeneratingVoiceUserId((cur) => (cur === userId ? null : cur));
    }
  };

  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    if (!q) return safeUsers;
    return safeUsers.filter((u) =>
      u.fullName.toLowerCase().includes(q) ||
      u.userId.toLowerCase().includes(q) ||
      u.rfidUid.toLowerCase().includes(q) ||
      (u.department ?? "").toLowerCase().includes(q),
    );
  }, [safeUsers, userSearch]);
  const isUserFiltering = userSearch.trim().length > 0;

  // Ticks belong to the rows on screen: the header tick box, the count and the batch actions all work from the rows
  // the search shows, and a search that hides a ticked user unticks it (below), so nothing acts on unseen users.
  const tickedUsers = filteredUsers.filter((u) => selectedUserIds.has(u.userId));
  const allUsersSelected = filteredUsers.length > 0 && tickedUsers.length === filteredUsers.length;
  const someUsersSelected = tickedUsers.length > 0 && !allUsersSelected;
  const usersSelecting = tickedUsers.length > 0;
  const listBarRef = useRef<HTMLDivElement>(null);
  const selectionBarRef = useRef<HTMLDivElement>(null);
  // The selection-bar button that started the last action, so the focus can come back after it is disabled or hidden.
  const barActionFrom = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (masterUserCheckboxRef.current) {
      masterUserCheckboxRef.current.indeterminate = someUsersSelected;
    }
  }, [someUsersSelected]);

  // The bar that isn't showing can't be clicked or tabbed into (React 18 has no inert prop).
  useLayoutEffect(() => {
    listBarRef.current?.toggleAttribute("inert", usersSelecting);
    selectionBarRef.current?.toggleAttribute("inert", !usersSelecting);
  }, [usersSelecting]);

  // When an action started from the selection bar ends, put the focus somewhere sensible if the bar dropped it: the
  // header tick box once the bar hides, else back on the button (it was disabled while the action ran). Only when the
  // focus fell to the page or is still in the hidden bar, and never while a pop-up is open.
  useLayoutEffect(() => {
    const from = barActionFrom.current;
    if (!from || batchUpdatingUsers || document.querySelector("[aria-modal='true']")) return;
    barActionFrom.current = null;
    const focus = document.activeElement;
    if (!usersSelecting) {
      if (focus === document.body || selectionBarRef.current?.contains(focus)) {
        masterUserCheckboxRef.current?.focus({ preventScroll: true });
      }
    } else if (focus === document.body) {
      const target = from.disabled || !from.isConnected
        ? selectionBarRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        : from;
      target?.focus({ preventScroll: true });
    }
  }, [usersSelecting, batchUpdatingUsers]);

  useEffect(() => {
    setSelectedUserIds((prev) => {
      const shown = new Set(filteredUsers.map((u) => u.userId));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (shown.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [filteredUsers]);

  const toggleSelectAllUsers = () => {
    if (allUsersSelected) {
      setSelectedUserIds(new Set());
    } else {
      setSelectedUserIds(new Set(filteredUsers.map((u) => u.userId)));
    }
  };

  const toggleSelectUser = (id: string) => {
    setSelectedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const removeBatchUsers = async () => {
    if (tickedUsers.length === 0) return;
    setBatchDeleteUsersOpen(false);
    setBatchUpdatingUsers(true);
    const ids = tickedUsers.map((u) => u.userId);
    const failed: string[] = [];
    for (const id of ids) {
      const deleted = await deleteAdminUser(id).then((res) => res.success, () => false);
      if (!deleted) {
        failed.push(id);
        continue;
      }
      if (editingRef.current?.userId === id) {
        setEditing(null);
        setFormOpen(false);
      }
    }
    setBatchUpdatingUsers(false);
    // Users that could not be deleted stay selected, ready for another try.
    setSelectedUserIds(new Set(failed));
    showResult(batchOutcome(ids.length - failed.length, ids.length, "Deleted", "user(s)"), setMessage);
    onSaved();
  };

  const setStatusBatchUsers = async (status: "ACTIVE" | "INACTIVE") => {
    if (tickedUsers.length === 0) return;
    setBatchUpdatingUsers(true);
    const targetUsers = tickedUsers;
    const failed: string[] = [];
    for (const u of targetUsers) {
      const saved = await saveAdminUser({ ...u, status }, u.userId).then((res) => res.success, () => false);
      if (!saved) {
        failed.push(u.userId);
        continue;
      }
      const open = editingRef.current;
      if (open?.userId === u.userId) {
        setEditing({ ...open, status });
        setForm((current) => ({ ...current, status }));
      }
    }
    setBatchUpdatingUsers(false);
    setSelectedUserIds(new Set(failed));
    showResult(batchOutcome(targetUsers.length - failed.length, targetUsers.length, "Updated", `user(s) to ${status.toLowerCase()}`), setMessage);
    onSaved();
  };

  // Messages are cleared by the actions that open or switch the form.
  useEffect(() => {
    formSession.current += 1;
    setForm(editing ?? blankUser);
    setPhotoBuster(Date.now());
  }, [editing]);

  // The registration form opens on demand ("+ Add user" or Edit) in a pop-up, and closes after Save.
  const userFormRef = useRef<HTMLElement>(null);
  const [formOpen, setFormOpen] = useState(Boolean(editing));
  const formDirty = formOpen && (photoUploading || userFormChanged(form, editing ?? blankUser));
  // Not while editing: the ID is locked then, and older IDs are fine as they are.
  const userIdHintId = useId();
  const showUserIdHint = !editing && unusualUserId(form.userId);
  // Bumped whenever the form is reset or switched, so a photo upload that finishes later can tell it is stale.
  const formSession = useRef(0);
  // The record being edited right now (delete and batch actions read it after their awaits).
  const editingRef = useRef(editing);
  editingRef.current = editing;
  // A discard waiting for confirmation (Edit another user, Add user, close) while the form has unsaved typing.
  const [pendingDiscard, setPendingDiscard] = useState<(() => void) | null>(null);
  const guardDiscard = (action: () => void) => {
    if (formDirty) setPendingDiscard(() => action);
    else action();
  };
  const openAddForm = () => {
    guardDiscard(() => {
      formSession.current += 1;
      setEditing(null);
      setForm(blankUser);
      setMessage(null);
      setFormOpen(true);
    });
  };
  const closeForm = () =>
    guardDiscard(() => {
      formSession.current += 1;
      setEditing(null);
      setForm(blankUser);
      setMessage(null);
      setFormOpen(false);
    });
  const requestEdit = (user: AdminUser) => {
    if (editing?.userId === user.userId) setFormOpen(true);
    else
      guardDiscard(() => {
        formSession.current += 1;
        setEditing(user);
        setForm(user);
        setMessage(null);
        setFormOpen(true);
      });
  };
  // Admin asks before leaving this tab while the form has unsaved typing; it learns about that here.
  useEffect(() => {
    onDirtyChange?.(formDirty);
  }, [formDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  // Escape closes the pop-up (asking first when there is unsaved typing), Tab stays inside it, and focus goes back
  // to the Add user or Edit button that opened it.
  useDialogKeys(userFormRef, closeForm, { open: formOpen });
  // When the pop-up opens (or switches to another user), put the cursor in the first field that can be changed.
  useEffect(() => {
    if (!formOpen) return;
    userFormRef.current
      ?.querySelector<HTMLElement>("input:not([disabled]):not([type='radio']):not([type='file']), select")
      ?.focus({ preventScroll: true });
  }, [formOpen, editing]);
  // The list is capped (styles.css) and scrolls inside; "See all" lifts the cap and only shows when users are hidden.
  const usersWrapRef = useRef<HTMLDivElement>(null);
  const [showAllUsers, setShowAllUsers] = useState(false);
  const usersCapped = !showAllUsers;
  const usersOverflowing = useVerticalOverflow(usersWrapRef, usersCapped);

  const handlePhotoUpload = async (file: File) => {
    if (!form.userId.trim()) {
      setMessage({ tone: "error", text: "Enter the User ID before uploading a photo." });
      return;
    }
    const isImage =
      ["image/jpeg", "image/png", "image/webp", "image/jpg"].includes(
        file.type.toLowerCase(),
      ) || /\.(jpe?g|png|webp)$/i.test(file.name);
    if (!isImage) {
      setMessage({ tone: "error", text: "Choose a JPEG, PNG, or WebP photo." });
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setMessage({ tone: "error", text: "Photo file must be under 25 MB." });
      return;
    }
    setPhotoUploading(true);
    const session = formSession.current;
    let dataUrl: string;
    try {
      dataUrl = await preparePhotoDataUrl(file);
    } catch (error) {
      setPhotoUploading(false);
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Unable to prepare this photo." });
      return;
    }
    try {
      const response = await uploadAdminPhoto(
        form.userId.trim().toUpperCase(),
        dataUrl,
      );
      setPhotoUploading(false);
      // The form was switched or closed while uploading: don't put this photo on another record.
      if (session !== formSession.current) return;
      if (!response.success) {
        setMessage({ tone: "error", text: response.error.message });
        return;
      }
      setForm((current) => ({ ...current, photoUrl: response.photoUrl }));
      setPhotoBuster(Date.now());
      showResult({ tone: "success", text: "Photo uploaded." }, setMessage);
    } catch (err) {
      setPhotoUploading(false);
      setMessage({ tone: "error", text: toErrorMessage(err, "Unable to upload photo.") });
    }
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const payload = {
        ...form,
        userId: form.userId.trim().toUpperCase(),
        rfidUid: form.rfidUid.trim().toUpperCase(),
        fullName: normalizeName(form.fullName),
        department: form.department
          ? form.department.trim().replace(/\s+/g, " ")
          : null,
        // "Not set" renders as "" in the select; send null so the backend
        // clears the field instead of writing an empty string.
        gender: form.gender || null,
        employeeType: "INTERN",
        dailyRate: null,
        payrollProfileId: null,
        photoUrl: form.cardType === "ADMIN_ASSIST" ? null : (form.photoUrl ?? null),
      };
      const response = await saveAdminUser(payload, editing?.userId);
      if (response.success) {
        showResult({ tone: "success", text: "User saved." }, setMessage);
        setEditing(null);
        setForm(blankUser);
        setFormOpen(false);
        onSaved();
      } else {
        setMessage({ tone: "error", text: response.error?.message ?? "Unable to save user." });
      }
    } catch (err) {
      const errMsg = toErrorMessage(err, "Unable to save user.");
      if (errMsg.includes("USER_CONFLICT")) {
        setMessage({ tone: "error", text: "This RFID card or User ID is already assigned to another user." });
      } else {
        setMessage({ tone: "error", text: errMsg });
      }
    }
  };
  const remove = async () => {
    if (!deleteUserTarget) return;
    const user = deleteUserTarget;
    setDeleteUserTarget(null);
    setDeletingUserId(user.userId);
    try {
      const response = await deleteAdminUser(user.userId);
      if (response.success) {
        showResult({ tone: "success", text: `Deleted ${user.fullName}.` }, setMessage);
        if (editingRef.current?.userId === user.userId) {
          setEditing(null);
          setFormOpen(false);
        }
        onSaved();
      } else {
        setMessage({ tone: "error", text: response.error?.message ?? "Unable to delete user." });
      }
    } catch (err) {
      setMessage({ tone: "error", text: toErrorMessage(err, "Unable to delete user.") });
    } finally {
      setDeletingUserId("");
    }
  };
  // Status sits next to Gender for interns and after the identifier for admin cards.
  const statusField = (
    <label>
      Status
      <select
        value={form.status}
        onChange={(e) =>
          setForm({
            ...form,
            status: e.target.value === "INACTIVE" ? "INACTIVE" : "ACTIVE",
          })
        }
      >
        <option value="ACTIVE">Active</option>
        <option value="INACTIVE">Inactive</option>
      </select>
    </label>
  );

  // Shown in the form while it is open, otherwise above the list (save, delete and table actions report here).
  const messageLine = <NoticeLine notice={message} className="form-message" />;

  return (
    <div className="admin-grid">
      {formOpen && (
      // A click outside does not close the pop-up, so a stray click never throws typing away.
      <div className="user-form-backdrop" role="presentation">
      <section
        className="admin-form user-form-dialog"
        ref={userFormRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="user-form-heading"
      >
        <div className="editor-heading">
          <div>
            <p className="section-kicker">User registration</p>
            <h2 id="user-form-heading">{editing ? `Editing ${editing.fullName}` : "Add user"}</h2>
            {formDirty && <span className="unsaved-tag">Unsaved changes</span>}
          </div>
          <button className="icon-button" type="button" onClick={closeForm} aria-label="Close user form">
            <X size={17} aria-hidden="true" />
          </button>
        </div>
        {editing && (
          <p className="edit-context" role="status">
            Active record: <strong>{editing.userId}</strong> · RFID {editing.rfidUid}
          </p>
        )}
        {messageLine}
        <form onSubmit={save}>
          <div className="card-type-toggle" role="radiogroup" aria-label="Register user as:">
            <span className="field-label">Card assignment type:</span>
            <div className="segmented-control">
              <label className={`segment-option ${form.cardType !== "ADMIN_ASSIST" ? "is-selected" : ""}`}>
                <input
                  type="radio"
                  name="userCardType"
                  value="EMPLOYEE"
                  checked={form.cardType !== "ADMIN_ASSIST"}
                  onChange={() => setForm({ ...form, cardType: "EMPLOYEE" })}
                />
                <UserRound size={16} aria-hidden="true" />
                <span>Intern card</span>
              </label>
              <label className={`segment-option is-admin-card ${form.cardType === "ADMIN_ASSIST" ? "is-selected" : ""}`}>
                <input
                  type="radio"
                  name="userCardType"
                  value="ADMIN_ASSIST"
                  checked={form.cardType === "ADMIN_ASSIST"}
                  onChange={() =>
                    setForm({
                      ...form,
                      cardType: "ADMIN_ASSIST",
                      userId: form.userId || (form.rfidUid ? `ADMIN_CARD_${form.rfidUid}` : ""),
                    })
                  }
                />
                <ShieldCheck size={16} aria-hidden="true" />
                <span>Admin RFID card</span>
              </label>
            </div>
          </div>

          {form.cardType === "ADMIN_ASSIST" ? (
            <Fragment key="admin-card">
              <div className="modal-audit-callout" style={{ marginBottom: 12 }}>
                <ShieldAlert size={16} />
                <span>Admin RFID cards allow supervisors to perform assisted clock-ins at the kiosk. They do not record attendance for themselves.</span>
              </div>
              <label>
                Card label
                <input
                  required
                  placeholder="e.g. Front desk master card #1"
                  value={form.fullName}
                  onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                />
              </label>
              <label>
                RFID UID
                <input
                  required
                  value={form.rfidUid}
                  onChange={(e) =>
                    setForm({ ...form, rfidUid: e.target.value.toUpperCase() })
                  }
                  onBlur={() =>
                    setForm((f) => ({
                      ...f,
                      rfidUid: f.rfidUid.trim().toUpperCase(),
                      userId: f.userId || `ADMIN_CARD_${f.rfidUid.trim().toUpperCase()}`,
                    }))
                  }
                />
              </label>
              <label>
                Identifier / User ID
                <input
                  required
                  disabled={Boolean(editing)}
                  value={form.userId}
                  onChange={(e) =>
                    setForm({ ...form, userId: e.target.value.toUpperCase() })
                  }
                  onBlur={() =>
                    setForm((f) => ({
                      ...f,
                      userId: f.userId.trim().toUpperCase(),
                    }))
                  }
                />
              </label>
              {statusField}
            </Fragment>
          ) : (
            <Fragment key="intern-card">
              <label className="user-id-field">
                User ID
                <input
                  required
                  disabled={Boolean(editing)}
                  placeholder="e.g. APG-2026-001"
                  aria-describedby={showUserIdHint ? userIdHintId : undefined}
                  value={form.userId}
                  onChange={(e) =>
                    setForm({ ...form, userId: e.target.value.toUpperCase() })
                  }
                  onBlur={() =>
                    setForm((f) => ({
                      ...f,
                      userId: f.userId.trim().toUpperCase(),
                    }))
                  }
                />
                {showUserIdHint && <UserIdFormatHint id={userIdHintId} />}
              </label>
              <label>
                RFID UID
                <input
                  required
                  value={form.rfidUid}
                  onChange={(e) =>
                    setForm({ ...form, rfidUid: e.target.value.toUpperCase() })
                  }
                  onBlur={() =>
                    setForm((f) => ({
                      ...f,
                      rfidUid: f.rfidUid.trim().toUpperCase(),
                    }))
                  }
                />
              </label>
              <label>
                Full name
                <input
                  required
                  value={form.fullName}
                  onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                  onBlur={() =>
                    setForm((f) => ({ ...f, fullName: normalizeName(f.fullName) }))
                  }
                />
              </label>
              <label>
                Department
                <input
                  value={form.department ?? ""}
                  onChange={(e) => setForm({ ...form, department: e.target.value })}
                  onBlur={() =>
                    setForm((f) => ({
                      ...f,
                      department: f.department
                        ? f.department.trim().replace(/\s+/g, " ")
                        : "",
                    }))
                  }
                />
              </label>
              <label>
                Gender
                <select
                  value={form.gender ?? ""}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      gender: e.target.value === "MALE" ? "MALE" : e.target.value === "FEMALE" ? "FEMALE" : null,
                    })
                  }
                >
                  <option value="">Not set</option>
                  <option value="MALE">Male</option>
                  <option value="FEMALE">Female</option>
                </select>
              </label>
              {statusField}
              <div className="photo-field">
                <span className="field-label">
                  ID photo <span className="optional">optional</span>
                </span>
                {form.photoUrl ? (
                  <div className="photo-preview-wrap">
                    <div
                      className={`photo-dropzone has-photo${isDraggingPhoto ? " is-dragging" : ""}`}
                      onDragOver={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
                      }}
                      onDragEnter={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setIsDraggingPhoto(true);
                      }}
                      onDragLeave={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
                        setIsDraggingPhoto(false);
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setIsDraggingPhoto(false);
                        const file = event.dataTransfer.files?.[0] ?? (event.dataTransfer.items?.[0]?.getAsFile() ?? null);
                        if (file) void handlePhotoUpload(file);
                      }}
                    >
                      <img
                        key={photoBuster}
                        src={photoSource(form.photoUrl)}
                        alt="Uploaded ID preview"
                      />
                      {photoUploading ? (
                        <span className="photo-overlay">
                          <LoaderCircle size={16} className="spin" /> Uploading photo…
                        </span>
                      ) : (
                        <span className="photo-overlay">
                          <Check size={16} /> Photo ready
                        </span>
                      )}
                    </div>
                    <div className="photo-preview-actions" style={{ display: "flex", gap: "10px", marginTop: "8px" }}>
                      <label className="text-button" style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "5px" }}>
                        <Upload size={14} /> Change photo
                        <input
                          type="file"
                          className="photo-input"
                          accept="image/jpeg,image/png,image/webp"
                          disabled={photoUploading}
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) void handlePhotoUpload(file);
                            event.currentTarget.value = "";
                          }}
                        />
                      </label>
                      <button
                        type="button"
                        className="text-button danger-button"
                        disabled={photoUploading}
                        onClick={() => setForm((f) => ({ ...f, photoUrl: null }))}
                      >
                        Remove photo
                      </button>
                    </div>
                  </div>
                ) : (
                  <label
                    className={`photo-dropzone${isDraggingPhoto ? " is-dragging" : ""}`}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
                    }}
                    onDragEnter={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setIsDraggingPhoto(true);
                    }}
                    onDragLeave={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
                      setIsDraggingPhoto(false);
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setIsDraggingPhoto(false);
                      const file = event.dataTransfer.files?.[0] ?? (event.dataTransfer.items?.[0]?.getAsFile() ?? null);
                      if (file) void handlePhotoUpload(file);
                    }}
                  >
                    <input
                      className="photo-input"
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      disabled={photoUploading}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void handlePhotoUpload(file);
                        event.currentTarget.value = "";
                      }}
                    />
                    {photoUploading ? (
                      <>
                        <LoaderCircle size={25} className="spin" />
                        <strong>Uploading photo…</strong>
                      </>
                    ) : isDraggingPhoto ? (
                      <>
                        <ImagePlus size={28} />
                        <strong>Drop ID photo here</strong>
                        <small>Release mouse to upload photo</small>
                      </>
                    ) : (
                      <>
                        <ImagePlus size={25} />
                        <strong>Choose an ID photo</strong>
                        <small>JPG, PNG, or WebP - resized automatically</small>
                        <span className="photo-upload-link">
                          <Upload size={14} /> Browse files
                        </span>
                      </>
                    )}
                  </label>
                )}
              </div>
            </Fragment>
          )}
          <div className="user-form-actions">
            <button className="text-button" type="button" onClick={closeForm}>
              Cancel
            </button>
            <button className="submit-button" type="submit">
              Save user
            </button>
          </div>
        </form>
      </section>
      </div>
      )}
      <section className={`table-with-bar users-table-section ${usersCapped ? "is-capped" : ""}`}>
        {/* While rows are ticked the selection bar takes the list bar's place. Both stay mounted in the same spot (the
            voice chip keeps polling, and the bar keeps the taller one's height so the list never moves); the one not
            showing is hidden and inert, and the two cross-fade. */}
        <div className="table-header-bar users-list-bar">
          <div className="users-bar-layer" ref={listBarRef} aria-hidden={usersSelecting}>
            <div className="table-selection-count">
              <span>
                {isUserFiltering
                  ? `${filteredUsers.length} of ${safeUsers.length} match`
                  : `${safeUsers.length} ${safeUsers.length === 1 ? "user" : "users"}`}
              </span>
              {(showAllUsers || usersOverflowing) && (
                <button
                  className="text-button see-all-toggle"
                  type="button"
                  aria-expanded={showAllUsers}
                  onClick={() => setShowAllUsers((current) => !current)}
                >
                  {showAllUsers ? "Show fewer" : "See all"}
                </button>
              )}
              <VoiceWorkerChip refreshKey={safeUsers.length} />
            </div>
            <div className="table-batch-actions">
              <button
                className="admin-button"
                type="button"
                data-testid="dtr-sync-bulk"
                disabled={Boolean(syncingDtrUserId) || dtrSyncActive}
                onClick={() => void handleSyncDtr()}
              >
                {syncingDtrUserId === "ALL" ? "Syncing DTR…" : "Sync Interns to DTR"}
              </button>
              {/* Stays on the page under the pop-up, so focus can come back to it when the form closes. */}
              <button className="admin-button add-user-button" type="button" onClick={openAddForm}>
                <Plus size={15} aria-hidden="true" /> Add user
              </button>
            </div>
          </div>
          {/* No Sync DTR here: DTR sync runs for one intern or for all, never for a picked few. */}
          <div
            className="users-bar-layer users-selection-bar"
            role="group"
            aria-label="Selected users"
            ref={selectionBarRef}
            aria-hidden={!usersSelecting}
          >
            <div className="table-selection-count">
              <span className="table-selection-badge">{tickedUsers.length} selected</span>
              <button
                className="text-button"
                type="button"
                onClick={(event) => {
                  barActionFrom.current = event.currentTarget;
                  setSelectedUserIds(new Set());
                }}
              >
                Clear
              </button>
            </div>
            <div className="table-batch-actions">
              <button
                className="admin-button"
                type="button"
                disabled={batchUpdatingUsers}
                onClick={(event) => {
                  barActionFrom.current = event.currentTarget;
                  void setStatusBatchUsers("ACTIVE");
                }}
              >
                Set active
              </button>
              <button
                className="admin-button"
                type="button"
                disabled={batchUpdatingUsers}
                onClick={(event) => {
                  barActionFrom.current = event.currentTarget;
                  void setStatusBatchUsers("INACTIVE");
                }}
              >
                Set inactive
              </button>
              <button
                className="admin-button danger-button"
                type="button"
                disabled={batchUpdatingUsers}
                onClick={(event) => {
                  barActionFrom.current = event.currentTarget;
                  setBatchDeleteUsersOpen(true);
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
        {syncingDtrUserId !== null && (
          <div
            className="sync-progress-wrap"
            role="progressbar"
            aria-valuenow={dtrProgress && dtrProgress.total > 0 ? Math.round((dtrProgress.current / dtrProgress.total) * 100) : 0}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Intern DTR sync progress"
          >
            <div className="sync-progress-status">
              <strong>
                {dtrProgress
                  ? dtrProgress.status === "starting"
                    ? `Starting DTR sync (${dtrProgress.total} interns)…`
                    : `Syncing intern ${dtrProgress.current} of ${dtrProgress.total}: ${dtrProgress.fullName}`
                  : "Syncing intern DTR sheets…"}
              </strong>
              <span className="sync-badge idle">{dtrSyncSourceLabel(dtrProgress?.source)}</span>
              <span>
                {dtrProgress && dtrProgress.total > 0
                  ? `${Math.min(100, Math.round((dtrProgress.current / dtrProgress.total) * 100))}%`
                  : "…"}
              </span>
            </div>
            <div className="sync-progress-bar">
              <div
                className="sync-progress-fill"
                style={{
                  width: `${dtrProgress && dtrProgress.total > 0 ? Math.min(100, Math.round((dtrProgress.current / dtrProgress.total) * 100)) : 0}%`,
                }}
              />
            </div>
          </div>
        )}
        {!formOpen && messageLine}
        {loadStatus === "failed" && onRetry && <LoadFailed what="users" onRetry={onRetry} />}
        <div className="user-search-row">
          <div className="search-input-wrap">
            <Search size={15} />
            <input
              type="search"
              className="input"
              aria-label="Search users"
              placeholder="Search users by name, ID, RFID, or department…"
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
            />
          </div>
        </div>
        <div className="table-wrap" ref={usersWrapRef}>
          <table>
            <thead>
              <tr>
                <th className="table-select-col">
                  <input
                    type="checkbox"
                    ref={masterUserCheckboxRef}
                    checked={allUsersSelected}
                    onChange={toggleSelectAllUsers}
                    aria-label="Select all users"
                  />
                </th>
                <th>User</th>
                <th>RFID</th>
                <th>Status</th>
                <th>Voice</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loadStatus === "loading" ? (
                <LoadingRows columns={6} label="Loading users…" />
              ) : filteredUsers.length === 0 ? (
                loadStatus === "failed" ? null : (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", padding: "20px 12px" }}>
                    {userSearch.trim() ? (
                      <>
                        No users match &ldquo;{userSearch.trim()}&rdquo;.{" "}
                        <button className="text-button" type="button" onClick={() => setUserSearch("")}>
                          Clear
                        </button>
                      </>
                    ) : (
                      "No users yet. Use Add user to register the first one."
                    )}
                  </td>
                </tr>
                )
              ) : (
                filteredUsers.map((user) => (
                <tr
                  key={user.userId}
                  className={`${editing?.userId === user.userId ? "is-editing" : ""} ${selectedUserIds.has(user.userId) ? "selected-row" : ""}`}
                >
                  <td className="table-select-cell">
                    <input
                      type="checkbox"
                      checked={selectedUserIds.has(user.userId)}
                      onChange={() => toggleSelectUser(user.userId)}
                      aria-label={`Select user ${user.fullName}`}
                    />
                  </td>
                  <td>
                    {user.cardType === "ADMIN_ASSIST" ? (
                      <div style={{ display: "flex", alignItems: "center" }}>
                        <div className="user-photo user-photo-admin-card" aria-label="Admin RFID Card" title="Admin RFID Card">
                          <ShieldCheck size={18} />
                        </div>
                        <div className="user-info-admin-card">
                          <span className="badge badge-admin-card">Admin RFID Card</span>
                          <strong>{user.fullName}</strong>
                          <small>{user.userId}</small>
                        </div>
                      </div>
                    ) : (
                      <>
                        <UserPhoto photoUrl={user.photoUrl} name={user.fullName} />
                        <strong>{user.fullName}</strong>
                        <small>{user.userId}</small>
                      </>
                    )}
                  </td>
                  <td className="user-status-cell">{user.rfidUid}</td>
                  <td className="user-status-cell">
                    <span className={`status-pill status-${user.status.toLowerCase()}`}>{user.status}</span>
                  </td>
                  <td>
                    {user.cardType === "ADMIN_ASSIST" ? (
                      <span className="form-help">—</span>
                    ) : (
                      <VoiceSlotCell
                        userId={user.userId}
                        fullName={user.fullName}
                        clipState={voiceClipStates[user.userId]}
                        playing={playingVoiceUserId === user.userId}
                        regenerating={regeneratingVoiceUserId === user.userId}
                        onPlay={() => void handlePlayVoiceClip(user.userId, user.fullName)}
                        onRegenerate={() => void handleRegenerateVoiceClip(user.userId)}
                      />
                    )}
                  </td>
                  <td>
                    {user.employeeType === "INTERN" && (
                      <button
                        className="text-button"
                        type="button"
                        data-testid={`dtr-sync-row-${user.userId}`}
                        disabled={Boolean(syncingDtrUserId) || dtrSyncActive}
                        onClick={() => void handleSyncDtr(user.userId)}
                        title="Synchronize this intern to the Google Sheets DTR tab"
                      >
                        {syncingDtrUserId === user.userId ? "Syncing…" : "Sync DTR"}
                      </button>
                    )}
                    <button
                      className="text-button"
                      onClick={() => requestEdit(user)}
                    >
                      Edit
                    </button>
                    <button
                      className="text-button danger-button"
                      disabled={deletingUserId === user.userId}
                      onClick={() => setDeleteUserTarget(user)}
                    >
                      {deletingUserId === user.userId
                        ? "Deleting..."
                        : "Delete"}
                    </button>
                  </td>
                </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
      <ConfirmDialog
        open={Boolean(deleteUserTarget)}
        busy={Boolean(deletingUserId)}
        tone="danger"
        title="Delete user?"
        message={deleteUserTarget ? `Are you sure you want to delete ${deleteUserTarget.fullName} (${deleteUserTarget.userId})? All associated records (attendance, bathroom logs, and payroll) will be permanently deleted. This cannot be undone.` : ""}
        confirmLabel="Delete user"
        requireText={deleteUserTarget?.userId}
        onCancel={() => setDeleteUserTarget(null)}
        onConfirm={() => void remove()}
      />
      <ConfirmDialog
        open={batchDeleteUsersOpen}
        busy={batchUpdatingUsers}
        tone="danger"
        title="Delete selected users?"
        message={`Are you sure you want to delete ${tickedUsers.length} selected user(s)? All associated records (attendance, bathroom logs, and payroll) will be permanently deleted. This cannot be undone.`}
        confirmLabel="Delete users"
        onCancel={() => {
          // Focus goes back to Delete by itself; nothing for the bar to restore.
          barActionFrom.current = null;
          setBatchDeleteUsersOpen(false);
        }}
        onConfirm={() => void removeBatchUsers()}
      />
      <ConfirmDialog
        open={pendingDiscard !== null}
        busy={false}
        tone="danger"
        title="Discard unsaved changes?"
        message="You have unsaved changes in User registration. Discarding them can't be undone."
        cancelLabel="Keep editing"
        confirmLabel="Discard changes"
        onCancel={() => setPendingDiscard(null)}
        onConfirm={() => {
          const action = pendingDiscard;
          setPendingDiscard(null);
          action?.();
        }}
      />
    </div>
  );
}

type VoiceSlotCellProps = {
  userId: string;
  fullName: string;
  clipState?: VoiceClipState;
  playing: boolean;
  regenerating: boolean;
  onPlay: () => void;
  onRegenerate: () => void;
};

type VoiceWorkerChipProps = {
  refreshKey: number;
};

function VoiceWorkerChip({ refreshKey }: VoiceWorkerChipProps) {
  const [worker, setWorker] = useState<VoiceWorkerStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    const refresh = (): void => {
      void loadVoiceWorkerStatus()
        .then((status) => {
          if (!cancelled) setWorker(status);
        })
        .catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshKey]);
  if (!worker) return null;
  const label =
    worker.active > 0
      ? `Cloning ${worker.active}…`
      : worker.retry > 0
        ? `Retrying ${worker.retry}…`
        : 'Voices ready';
  return (
    <span
      className={`lan-state ${worker.active > 0 ? 'lan-state-starting' : worker.retry > 0 ? 'lan-state-disabled' : 'lan-state-running'}`}
      title={worker.lastSpokenText ? `Last clip: ${worker.lastSpokenText}` : 'Voice clone worker'}
    >
      <i />
      {label}
    </span>
  );
}

function VoiceSlotCell({ userId, fullName, clipState, playing, regenerating, onPlay, onRegenerate }: VoiceSlotCellProps) {
  const slot = resolveVoiceSlot(
    clipState?.workerClip ?? false,
    clipState?.jobStatus,
    getClonedBeaNameAudioUrl(userId, fullName),
  );
  const busy = playing || regenerating;
  const slotChip = (
    <span
      className={`lan-state ${slot === "cloned" ? "lan-state-running" : slot === "queued" ? "lan-state-starting" : "lan-state-disabled"}`}
      title={slot === "cloned" ? "Cloned name clip ready" : slot === "queued" ? "Clip queued — generating" : "No clip yet — Piper speaks the name live"}
    >
      <i />
      {slot === "cloned" ? "Bea" : slot === "queued" ? "Queued" : "Piper"}
    </span>
  );
  if (regenerating) {
    const cloning = clipState?.jobStatus === "PROCESSING" || clipState?.jobStatus === "RETRY";
    const stageLabel = cloning ? "Cloning…" : "Queued…";
    return (
      <span className="voice-slot">
        {slotChip}
        <span
          className="voice-regen"
          role="status"
          aria-label={`${stageLabel} regenerating voice for ${fullName}`}
        >
          <span className="voice-spinner" aria-hidden="true" />
          <span className="voice-regen-label">{stageLabel}</span>
          <span className="voice-progress" role="progressbar" aria-label={`Regeneration progress for ${fullName}`}>
            <i aria-hidden="true" />
          </span>
        </span>
      </span>
    );
  }
  return (
    <span className="voice-slot">
      {slotChip}
      {slot !== "fallback" && (
        <button className="text-button" type="button" disabled={busy} onClick={onPlay} title={`Play ${fullName}'s cloned name`}>
          {playing ? "Playing…" : "Play"}
        </button>
      )}
      <button className="text-button" type="button" disabled={busy} onClick={onRegenerate} title="Queue a fresh clone (replaces the current clip)">
        Regenerate
      </button>
    </span>
  );
}

function UserPhoto({ photoUrl, name }: { photoUrl?: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  const [timestamp, setTimestamp] = useState(() => Date.now());

  useEffect(() => {
    setFailed(false);
    setTimestamp(Date.now());
  }, [photoUrl]);

  if (!photoUrl || failed) {
    return <span className="user-photo-fallback" aria-label={`${name} has no available photo`}><UserRound size={16} /></span>;
  }
  const rawSrc = photoSource(photoUrl);
  const src = rawSrc && !rawSrc.startsWith("data:")
    ? `${rawSrc}${rawSrc.includes("?") ? "&" : "?"}t=${timestamp}`
    : rawSrc;

  return (
    <img
      key={`${photoUrl}-${timestamp}`}
      className="user-photo"
      src={src}
      alt={`${name} profile`}
      onError={() => setFailed(true)}
    />
  );
}

type PayrollForm = {
  employeeId: string;
  payrollProfileId: string;
  cutoffStart: string;
  cutoffEnd: string;
  payrollCutoffLabel: string;
  standardWorkingDays: string;
  actualWorkingDays: string;
  specialHolidayDays: string;
  regularHolidayDays: string;
  incentivesAllowance: string;
  specialAllowance: string;
  lateUnits: string;
  lateDeductionRate: string;
  lateDeduction: string;
  halfDayCount: string;
  absentDays: string;
  overtimeHours: string;
  overtimeRate: string;
  manualAdjustment: string;
  adjustmentReason: string;
  approvedWorkingDayOverage: boolean;
};
const emptyPayrollForm: PayrollForm = {
  employeeId: "",
  payrollProfileId: "BEA_STANDARD",
  cutoffStart: "",
  cutoffEnd: "",
  payrollCutoffLabel: "",
  standardWorkingDays: "11",
  actualWorkingDays: "11",
  specialHolidayDays: "0",
  regularHolidayDays: "0",
  incentivesAllowance: "0",
  specialAllowance: "0",
  lateUnits: "0",
  lateDeductionRate: "0",
  lateDeduction: "0",
  halfDayCount: "0",
  absentDays: "0",
  overtimeHours: "0",
  overtimeRate: "0",
  manualAdjustment: "0",
  adjustmentReason: "",
  approvedWorkingDayOverage: false,
};

const monthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

interface SemiMonthlyCutoffRange {
  cutoffStart: string;
  cutoffEnd: string;
  payrollCutoffLabel: string;
}

function computeSemiMonthlyCutoff(
  month: string,
  half: "first" | "second",
): SemiMonthlyCutoffRange {
  const [yearText, monthText] = month.split("-");
  const year = Number(yearText);
  const monthNumber = Number(monthText);
  const pad = (value: number) => String(value).padStart(2, "0");
  const monthName = monthNames[(monthNumber - 1 + 12) % 12];
  if (half === "first") {
    return {
      cutoffStart: `${year}-${pad(monthNumber)}-01`,
      cutoffEnd: `${year}-${pad(monthNumber)}-15`,
      payrollCutoffLabel: `${monthName} 1-15, ${year}`,
    };
  }
  const lastDay = new Date(year, monthNumber, 0).getDate();
  return {
    cutoffStart: `${year}-${pad(monthNumber)}-16`,
    cutoffEnd: `${year}-${pad(monthNumber)}-${pad(lastDay)}`,
    payrollCutoffLabel: `${monthName} 16-${lastDay}, ${year}`,
  };
}

export function PayrollWorkspace({
  records,
  onSaved,
  loadStatus = "ready",
  onRetry,
}: {
  records: PayrollCutoffRecord[];
  onSaved: () => void;
  /** Where the payroll records load stands (Admin loads them). */
  loadStatus?: LoadStatus;
  onRetry?: () => void;
}) {
  const [form, setForm] = useState<PayrollForm>(emptyPayrollForm);
  // Problems stay on the page; generated, deleted and saved results show as toasts.
  const [message, setMessage] = useState<Notice | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cutoffMonth, setCutoffMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });

  // Keep the browser print header (if any) on-brand instead of the generic kiosk title.
  useEffect(() => {
    const previous = document.title;
    document.title = "Alpha Premier Attendance — Payroll Worksheet";
    return () => {
      document.title = previous;
    };
  }, []);

  const update = (field: keyof PayrollForm, value: string | boolean) =>
    setForm((current) => ({ ...current, [field]: value }));

  const applyCutoffHalf = (half: "first" | "second") => {
    const range = computeSemiMonthlyCutoff(cutoffMonth, half);
    const workdays = countWorkdays(range.cutoffStart, range.cutoffEnd);
    setForm((current) => ({
      ...current,
      cutoffStart: range.cutoffStart,
      cutoffEnd: range.cutoffEnd,
      payrollCutoffLabel: range.payrollCutoffLabel,
      standardWorkingDays: String(workdays || 11),
    }));
  };

  const handleCutoffDateChange = (field: "cutoffStart" | "cutoffEnd", value: string) => {
    setForm((current) => {
      const next = { ...current, [field]: value };
      const start = field === "cutoffStart" ? value : current.cutoffStart;
      const end = field === "cutoffEnd" ? value : current.cutoffEnd;
      if (start && end && start <= end) {
        const days = countWorkdays(start, end);
        next.standardWorkingDays = String(days || 11);
      }
      return next;
    });
  };

  const [clearCutoffOpen, setClearCutoffOpen] = useState(false);
  const [clearingCutoff, setClearingCutoff] = useState(false);
  // The picked cutoff as people read it ("Aug 1–15, 2026"); the label saved with the payroll is unchanged.
  const cutoffRange = formatCutoffRange(form.cutoffStart, form.cutoffEnd);

  const existingCutoffRecords = useMemo(() => {
    if (!form.cutoffStart || !form.cutoffEnd) return [];
    return records.filter(
      (record) =>
        record.cutoffStart === form.cutoffStart &&
        record.cutoffEnd === form.cutoffEnd,
    );
  }, [records, form.cutoffStart, form.cutoffEnd]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.cutoffStart || !form.cutoffEnd) {
      setMessage({ tone: "error", text: "Select a cutoff period first." });
      return;
    }
    if (form.cutoffStart > form.cutoffEnd) {
      setMessage({ tone: "error", text: "Cutoff start must be on or before cutoff end." });
      return;
    }
    setMessage(null);
    setConfirmOpen(true);
  };

  const confirmGenerate = async () => {
    if (saving) return;
    setSaving(true);
    try {
      // Finalized rows are approved pay: regenerating rebuilds drafts only.
      for (const r of existingCutoffRecords) {
        if (r.status !== "FINALIZED") await deletePayrollCutoff(r.payrollId);
      }
      const stdDays = Number(form.standardWorkingDays);
      const customization = !Number.isNaN(stdDays) && stdDays > 0 ? { standardWorkingDays: stdDays } : undefined;
      const response = await generatePayrollCutoff(
        form.cutoffStart,
        form.cutoffEnd,
        form.payrollCutoffLabel || `${form.cutoffStart} to ${form.cutoffEnd}`,
        customization,
      );
      if (response.success) {
        const skipped = response.warnings ?? [];
        showToast(
          existingCutoffRecords.length > 0
            ? `Payroll regenerated for ${cutoffRange}; finalized records were kept.`
            : `Payroll generated for ${cutoffRange}.`,
        );
        // Records left out need fixing, so that part stays on the page.
        setMessage(
          skipped.length > 0
            ? { tone: "error", text: `${skipped.length} attendance record(s) could not be priced and were left out: ${skipped.slice(0, 3).join("; ")}${skipped.length > 3 ? "…" : ""}. Fix them in Attendance, then regenerate.` }
            : null,
        );
        onSaved();
        setConfirmOpen(false);
      } else {
        setMessage({ tone: "error", text: response.error?.message ?? "Unable to save payroll." });
      }
    } catch (error) {
      setMessage({ tone: "error", text: toErrorMessage(error, "Unable to save payroll.") });
    } finally {
      setSaving(false);
    }
  };

  const clearCutoffRecords = async () => {
    if (clearingCutoff || existingCutoffRecords.length === 0) return;
    setClearingCutoff(true);
    try {
      let count = 0;
      let failCount = 0;
      for (const r of existingCutoffRecords) {
        const res = await deletePayrollCutoff(r.payrollId);
        if (res.success) {
          count++;
        } else {
          failCount++;
        }
      }
      if (failCount > 0) {
        setMessage({ tone: "error", text: `Deleted ${count} payroll record(s) for ${cutoffRange}. ${failCount} record(s) could not be deleted.` });
      } else {
        showResult({ tone: "success", text: `Deleted ${count} payroll record(s) for ${cutoffRange}.` }, setMessage);
      }
      onSaved();
    } catch (error) {
      setMessage({ tone: "error", text: toErrorMessage(error, "Unable to delete payroll records.") });
    } finally {
      setClearingCutoff(false);
      setClearCutoffOpen(false);
    }
  };

  // The selected payroll cutoff drives both generated payroll PDFs: the
  // cutoff picked in the create form when set, otherwise the most recent
  // cutoff found in the saved records.
  const selectedCutoff = useMemo<{
    cutoffStart: string;
    cutoffEnd: string;
    label: string;
  } | null>(() => {
    if (form.cutoffStart && form.cutoffEnd) {
      return {
        cutoffStart: form.cutoffStart,
        cutoffEnd: form.cutoffEnd,
        label:
          form.payrollCutoffLabel ||
          `${form.cutoffStart} to ${form.cutoffEnd}`,
      };
    }
    const latest = records.reduce<PayrollCutoffRecord | null>(
      (best, row) => (!best || row.cutoffStart > best.cutoffStart ? row : best),
      null,
    );
    return latest
      ? {
          cutoffStart: latest.cutoffStart,
          cutoffEnd: latest.cutoffEnd,
          label: latest.payrollCutoffLabel,
        }
      : null;
  }, [form.cutoffStart, form.cutoffEnd, form.payrollCutoffLabel, records]);

  const [pdfMessage, setPdfMessage] = useState<Notice | null>(null);
  const [generating, setGenerating] = useState(false);
  const [payrollPdfs, setPayrollPdfs] = useState<PayrollPdfRecord[]>([]);
  const [payslipMessage, setPayslipMessage] = useState<Notice | null>(null);
  const [payslipDirectory, setPayslipDirectory] = useState<string | null>(null);
  const [payslipOpenMessage, setPayslipOpenMessage] = useState<Notice | null>(null);
  const [generatingPayslips, setGeneratingPayslips] = useState(false);

  useEffect(() => {
    void loadPayrollPdfs().then((response) => {
      if (response.success) setPayrollPdfs(response.payrollPdfs);
    });
  }, []);

  const generatePdf = async () => {
    if (generating) return;
    if (!selectedCutoff) {
      setPdfMessage({ tone: "error", text: "No payroll records to generate. Create and save a payroll first." });
      return;
    }
    setGenerating(true);
    setPdfMessage(null);
    try {
      const response = await generatePayrollPdf({
        cutoffStart: selectedCutoff.cutoffStart,
        cutoffEnd: selectedCutoff.cutoffEnd,
        payrollCutoffLabel: selectedCutoff.label,
        workerType: "intern",
      });
      if (response.success) {
        setPayrollPdfs((current) => [
          response.pdf,
          ...current.filter(
            (item) => item.payrollPdfId !== response.pdf.payrollPdfId,
          ),
        ]);
        showToast(`Payroll PDF generated for ${formatCutoffRange(selectedCutoff.cutoffStart, selectedCutoff.cutoffEnd)}.`);
      } else setPdfMessage({ tone: "error", text: response.error.message });
    } catch (error) {
      setPdfMessage({ tone: "error", text: error instanceof Error ? error.message : "Unable to generate the payroll PDF." });
    } finally {
      setGenerating(false);
    }
  };

  const generatePayslips = async () => {
    if (generatingPayslips) return;
    setPayslipDirectory(null);
    setPayslipOpenMessage(null);
    if (!selectedCutoff) {
      setPayslipMessage({ tone: "error", text: "No payroll records to generate payslips for. Create and save a payroll first." });
      return;
    }
    setGeneratingPayslips(true);
    setPayslipMessage(null);
    try {
      const response = await generateInternPayslipImages({
        cutoffStart: selectedCutoff.cutoffStart,
        cutoffEnd: selectedCutoff.cutoffEnd,
        payrollCutoffLabel: selectedCutoff.label,
      });
      if (response.success) {
        setPayslipDirectory(response.directoryPath);
        showToast(`Saved ${response.fileCount} payslip image(s) for ${formatCutoffRange(selectedCutoff.cutoffStart, selectedCutoff.cutoffEnd)}.`);
      } else setPayslipMessage({ tone: "error", text: response.error.message });
    } catch (error) {
      setPayslipMessage({ tone: "error", text: error instanceof Error ? error.message : "Unable to generate the payslips." });
    } finally {
      setGeneratingPayslips(false);
    }
  };

  const openPayslipFolder = async (directoryPath: string) => {
    const result = await openGeneratedDirectory(directoryPath);
    setPayslipOpenMessage(result.ok ? null : { tone: "error", text: result.message });
  };

  return (
    <section className="payroll-workspace">
      <div className="payroll-toolbar">
        <form className="payroll-generate-panel" onSubmit={save}>
          <div className="payroll-panel-heading">
            <h2>Generate cutoff payroll</h2>
            <button
              className="submit-button payroll-generate-submit"
              type="submit"
              disabled={saving || !form.cutoffStart || !form.cutoffEnd}
            >
              {saving ? "Generating..." : "Generate from attendance"}
            </button>
          </div>
          <div className="payroll-generate-controls">
            <div className="cutoff-period">
              <label>
                Cutoff month
                <input
                  type="month"
                  value={cutoffMonth}
                  onChange={(event) => setCutoffMonth(event.target.value)}
                />
              </label>
              <div className="cutoff-fill-buttons">
                <button
                  className="admin-button"
                  type="button"
                  onClick={() => applyCutoffHalf("first")}
                >
                  1st&ndash;15th
                </button>
                <button
                  className="admin-button"
                  type="button"
                  onClick={() => applyCutoffHalf("second")}
                >
                  16th&ndash;last day
                </button>
              </div>
            </div>
            <label>
              Cutoff start
              <input
                required
                type="date"
                value={form.cutoffStart}
                onChange={(event) => handleCutoffDateChange("cutoffStart", event.target.value)}
              />
            </label>
            <label>
              Cutoff end
              <input
                required
                type="date"
                value={form.cutoffEnd}
                onChange={(event) => handleCutoffDateChange("cutoffEnd", event.target.value)}
              />
            </label>
            <label className="payroll-standard-days">
              Standard days
              <input
                required
                type="number"
                min="0"
                max="31"
                step="0.5"
                value={form.standardWorkingDays}
                onChange={(event) => update("standardWorkingDays", event.target.value)}
              />
            </label>
          </div>
        </form>

        <div className="payroll-pdf-actions-panel">
          <div className="payroll-panel-heading">
            <h2>Export payroll</h2>
          </div>
          <div className="payroll-actions">
            <button
              className="admin-button"
              type="button"
              onClick={() => void generatePdf()}
              disabled={generating}
            >
              {generating ? "Generating..." : "Generate Intern Payroll PDF"}
            </button>
            <button
              className="admin-button"
              type="button"
              onClick={() => void generatePayslips()}
              disabled={generatingPayslips}
            >
              {generatingPayslips
                ? "Generating payslips..."
                : "Generate Intern Payslips"}
            </button>
            {payslipDirectory && (
              <button
                className="admin-button"
                type="button"
                onClick={() => void openPayslipFolder(payslipDirectory)}
              >
                Open payslip folder
              </button>
            )}
          </div>
        </div>
      </div>

      {existingCutoffRecords.length > 0 && (
        <div className="cutoff-existing-banner" role="status">
          <span>
            Payroll already exists for this cutoff ({existingCutoffRecords.length} record(s)). Generating from attendance will replace draft records; finalized records are kept.
          </span>
          <div className="cutoff-existing-actions">
            <button
              className="admin-button danger-button"
              type="button"
              disabled={clearingCutoff || saving}
              onClick={() => setClearCutoffOpen(true)}
            >
              Delete all records for this cutoff ({existingCutoffRecords.length})
            </button>
          </div>
        </div>
      )}

      <NoticeLine notice={message} />
      <NoticeLine notice={pdfMessage} />
      <NoticeLine notice={payslipMessage} />
      <NoticeLine notice={payslipOpenMessage} />

      <section className="payroll-table">
        <PayrollTable records={records} onFinalized={onSaved} loadStatus={loadStatus} onRetry={onRetry} />
      </section>

      <section className="payroll-pdf-section">
        <h2>Generated payroll PDFs</h2>
        <PayrollPdfList pdfs={payrollPdfs} />
      </section>

      <ConfirmDialog
        open={confirmOpen}
        busy={saving}
        title={existingCutoffRecords.length > 0 ? "Regenerate cutoff payroll?" : "Generate payroll drafts?"}
        message={
          existingCutoffRecords.length > 0
            ? `Payroll already exists for ${cutoffRange} (${existingCutoffRecords.length} record(s)). Generating new payroll will replace the draft records with fresh calculations from latest attendance; finalized records are kept. Continue?`
            : `This will generate payroll records for ${cutoffRange} from completed attendance. Days without a time-out are not paid; late time-outs are paid up to 17:00. Continue?`
        }
        confirmLabel={existingCutoffRecords.length > 0 ? "Regenerate payroll" : "Generate payroll"}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void confirmGenerate()}
      />
      <ConfirmDialog
        open={clearCutoffOpen}
        busy={clearingCutoff}
        tone="danger"
        title="Delete cutoff records?"
        message={`This will permanently delete all ${existingCutoffRecords.length} payroll record(s) for ${cutoffRange}. Continue?`}
        confirmLabel="Delete cutoff records"
        onCancel={() => setClearCutoffOpen(false)}
        onConfirm={() => void clearCutoffRecords()}
      />
    </section>
  );
}

/** Shows a result: a routine success as a toast (clearing any older problem left on the page), anything else inline. */
function showResult(notice: Notice, setMessage: (notice: Notice | null) => void): void {
  if (notice.tone === "success") {
    setMessage(null);
    showToast(notice.text);
  } else setMessage(notice);
}

/** A batch action's result: success when every item worked, otherwise a problem saying how many did not. */
function batchOutcome(done: number, total: number, verb: string, noun: string): Notice {
  return done === total
    ? { tone: "success", text: `${verb} ${done} ${noun}.` }
    : { tone: "error", text: `${verb} ${done} of ${total} ${noun}. ${total - done} could not be ${verb.toLowerCase()}.` };
}

type ConfirmDialogProps = {
  open: boolean;
  busy: boolean;
  title: string;
  message: string;
  onCancel: () => void;
  onConfirm: () => void;
  cancelLabel?: string;
  /** Names the action ("Delete user", "Restore database"), never a bare "Confirm". */
  confirmLabel: string;
  /** "danger" for actions that delete, wipe, replace or discard: coral icon, edge and confirm button. */
  tone?: "default" | "danger";
  /** For permanent deletes: the confirm button stays off until this text (say, the User ID) is typed. */
  requireText?: string;
};

function ConfirmDialog(props: ConfirmDialogProps) {
  return props.open ? <ConfirmDialogCard {...props} /> : null;
}

function ConfirmDialogCard({
  busy,
  title,
  message,
  onCancel,
  onConfirm,
  cancelLabel = "Cancel",
  confirmLabel,
  tone = "default",
  requireText,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  useDialogKeys(dialogRef, onCancel, { busy });
  const [typed, setTyped] = useState("");
  const typedId = useId();
  const danger = tone === "danger";
  const unlocked = !requireText || typed.trim().toUpperCase() === requireText.trim().toUpperCase();
  return (
    <div className="confirm-backdrop" role="presentation">
      <section ref={dialogRef} className={danger ? "confirm-dialog is-danger" : "confirm-dialog"} role="dialog" aria-modal="true" aria-labelledby="confirm-heading">
        <CircleAlert className="confirm-icon" size={20} aria-hidden="true" />
        <h2 id="confirm-heading">{title}</h2>
        <p>{message}</p>
        {requireText && (
          <label className="confirm-type-field" htmlFor={typedId}>
            <span>
              Type <strong>{requireText}</strong> to confirm
            </span>
            <input
              id={typedId}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && unlocked && !busy) onConfirm();
              }}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              data-autofocus
            />
          </label>
        )}
        <div className="confirm-actions">
          {/* Destructive: focus starts on Cancel, so Enter never deletes by accident. */}
          <button className="text-button" type="button" disabled={busy} onClick={onCancel} data-autofocus={danger ? true : undefined}>
            {cancelLabel}
          </button>
          <button
            className={danger ? "submit-button is-danger" : "submit-button"}
            type="button"
            disabled={busy || !unlocked}
            onClick={onConfirm}
            data-autofocus={danger ? undefined : true}
          >
            {busy ? <LoaderCircle className="spin" size={16} /> : danger ? null : <Check size={16} />} {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function EditPayrollDialog({
  record,
  open,
  onClose,
  onSaved,
}: {
  record: PayrollCutoffRecord | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isIntern = record?.employeeType === "INTERN";
  const [hra, setHra] = useState("0");
  const [incentivesAllowance, setIncentivesAllowance] = useState("0");
  const [specialAllowance, setSpecialAllowance] = useState("0");
  const [overtimePay, setOvertimePay] = useState("0");
  const [manualAdjustment, setManualAdjustment] = useState("0");
  const [adjustmentReason, setAdjustmentReason] = useState("");

  const [sss, setSss] = useState("0");
  const [phic, setPhic] = useState("0");
  const [hdmf, setHdmf] = useState("0");
  const [salaryAdvance, setSalaryAdvance] = useState("0");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  useDialogKeys(dialogRef, onClose, { busy: saving, open: open && Boolean(record) });

  useEffect(() => {
    if (record) {
      setHra(String(record.hra ?? 0));
      setIncentivesAllowance(String(record.incentivesAllowance ?? 0));
      setSpecialAllowance(String(record.specialAllowance ?? 0));
      setOvertimePay(String(record.overtimePay ?? 0));
      setManualAdjustment(String(record.manualAdjustment ?? 0));
      setAdjustmentReason(record.adjustmentReason ?? "");

      setSss(String(record.sss ?? 0));
      setPhic(String(record.phic ?? 0));
      setHdmf(String(record.hdmf ?? 0));
      setSalaryAdvance(String(record.salaryAdvance ?? 0));
      setError("");
    }
  }, [record]);

  if (!open || !record) return null;

  const nStdDays = Math.max(0, record.standardWorkingDays ?? 11);
  const actualDays = record.actualWorkingDays;
  const absentDays = record.absentDays;
  const basicPay = record.basicPay;
  const absenceDeduction = record.absenceDeduction;

  const nHra = isIntern ? 0 : Number(hra) || 0;
  const nInc = isIntern ? 0 : Number(incentivesAllowance) || 0;
  const nSpecAllow = isIntern ? 0 : Number(specialAllowance) || 0;
  const nOt = isIntern ? 0 : Number(overtimePay) || 0;
  const nAdj = Number(manualAdjustment) || 0;

  const nSss = isIntern ? 0 : Number(sss) || 0;
  const nPhic = isIntern ? 0 : Number(phic) || 0;
  const nHdmf = isIntern ? 0 : Number(hdmf) || 0;
  const nAdvance = isIntern ? 0 : Number(salaryAdvance) || 0;

  const halfDayDeduction = record.halfDayDeduction;
  const totalAllowance = record.totalAllowance;
  const totalEarnings = record.grossCompensation;
  const totalDeductions = payrollTotalDeductions(record);

  const netPay = record.netPay;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (nAdj !== 0 && !adjustmentReason.trim()) {
      setError("A reason is required when setting a manual adjustment.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const payload = {
        payrollId: record.payrollId,
        employeeId: record.employeeId,
        employeeName: record.employeeName,
        payrollProfileId: record.payrollProfileId,
        payrollCutoffLabel: record.payrollCutoffLabel,
        cutoffStart: record.cutoffStart,
        cutoffEnd: record.cutoffEnd,
        dailyRate: record.dailyRate,
        standardWorkingDays: nStdDays,
        actualWorkingDays: record.actualWorkingDays,
        basicPay: record.basicPay,
        hra: nHra,
        incentivesAllowance: nInc,
        specialAllowance: nSpecAllow,
        regularHolidayPay: isIntern ? 0 : record.regularHolidayPay,
        specialHolidayPay: isIntern ? 0 : record.specialHolidayPay,
        overtimePay: nOt,
        sss: nSss,
        phic: nPhic,
        hdmf: nHdmf,
        salaryAdvance: nAdvance,
        absentDays: record.absentDays,
        absenceDeduction: record.absenceDeduction,
        halfDayCount: record.halfDayCount,
        halfDayDeduction,
        // Backend defaults a missing fraction to 0.0, which zeroes the
        // EMPLOYEE half-day recompute (daily * count * fraction).
        halfDayFraction: 0.5,
        lateUnits: record.lateUnits,
        lateDeduction: record.lateDeduction,
        manualAdjustment: nAdj,
        adjustmentReason: adjustmentReason.trim() || undefined,
        approvedWorkingDayOverage: nStdDays < record.actualWorkingDays ? true : record.approvedWorkingDayOverage,
      };
      const response = await savePayrollCutoff(payload, record.payrollId);
      setSaving(false);
      if (response.success) {
        onSaved();
        onClose();
      } else {
        setError("Failed to save payroll changes.");
      }
    } catch (err) {
      setSaving(false);
      setError(err instanceof Error ? err.message : "Error saving payroll changes.");
    }
  };

  return (
    <div className="confirm-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="edit-payroll-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-payroll-heading"
      >
        <h2 id="edit-payroll-heading">
          Edit Payroll — {record.employeeName}
          {isIntern ? " (Intern)" : ""}
        </h2>
        <p className="modal-subtitle">
          {record.payrollCutoffLabel} ({formatCutoffRange(record.cutoffStart, record.cutoffEnd)}) • {record.employeeId}
        </p>

        <div className="edit-payroll-attendance-box">
          <div className="attendance-stat">
            <span className="attendance-label">Attendance Basic</span>
            <span className="attendance-value">{php(basicPay)} ({actualDays} worked / {nStdDays} std days)</span>
          </div>
          {!isIntern && (record.regularHolidayPay > 0 || record.specialHolidayPay > 0) && (
            <div className="attendance-stat">
              <span className="attendance-label">Holiday Pay</span>
              <span className="attendance-value">{php(record.regularHolidayPay + record.specialHolidayPay)}</span>
            </div>
          )}
          <div className="attendance-stat">
            <span className="attendance-label">Late Deduction</span>
            <span className="attendance-value" style={{ color: record.lateDeduction > 0 ? "var(--danger)" : undefined }}>
              {php(record.lateDeduction)} ({record.lateUnits} hrs)
            </span>
          </div>
          <div className="attendance-stat">
            <span className="attendance-label">Absent / Halfday</span>
            <span className="attendance-value" style={{ color: (absenceDeduction + record.halfDayDeduction) > 0 ? "var(--danger)" : undefined }}>
              {php(absenceDeduction + record.halfDayDeduction)} ({absentDays} absent)
            </span>
          </div>
        </div>

        {isIntern ? (
          <form onSubmit={handleSubmit}>
            <div className="edit-payroll-notice">
              Intern stipend (PHP 80.00/day) and late deductions (PHP 10.00/hr) are automatically calculated from RFID attendance scans. Standard working days ({nStdDays} days) are set globally for the cutoff. You can apply manual adjustments below.
            </div>

            <div className="edit-payroll-section" style={{ marginTop: "12px" }}>
              <h3>Manual Adjustment</h3>
              <label>
                Manual Adjustment (PHP)
                <input
                  type="number"
                  step="0.01"
                  value={manualAdjustment}
                  onChange={(e) => setManualAdjustment(e.target.value)}
                />
              </label>
              {nAdj !== 0 && (
                <label>
                  Adjustment Reason
                  <input
                    type="text"
                    required
                    value={adjustmentReason}
                    onChange={(e) => setAdjustmentReason(e.target.value)}
                    placeholder="Reason for adjustment"
                  />
                </label>
              )}
            </div>

            <div className="edit-payroll-summary">
              <div className="summary-item">
                <span className="summary-label">Total Earnings</span>
                <span className="summary-value">{php(totalEarnings)}</span>
              </div>
              <div className="summary-item">
                <span className="summary-label">Total Deductions</span>
                <span className="summary-value" style={{ color: "var(--danger)" }}>
                  {php(totalDeductions)}
                </span>
              </div>
              <div className="summary-item">
                <span className="summary-label">Net Pay</span>
                <span className="net-pay-box">{php(netPay)}</span>
              </div>
            </div>

            {error && <p className="dashboard-alert" style={{ marginTop: "12px" }}>{error}</p>}

            <div className="confirm-actions">
              <button
                className="text-button"
                type="button"
                disabled={saving}
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                className="submit-button"
                type="submit"
                disabled={saving || !isOnline()}
              >
                {saving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} {!isOnline() ? "Offline" : "Save Changes"}
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="edit-payroll-grid">
              <div className="edit-payroll-section">
                <h3>Allowances & Adjustments (PHP)</h3>
                <label>
                  HRA
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={hra}
                    onChange={(e) => setHra(e.target.value)}
                  />
                </label>
                <label>
                  Incentives Allowance
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={incentivesAllowance}
                    onChange={(e) => setIncentivesAllowance(e.target.value)}
                  />
                </label>
                <label>
                  Special Allowance
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={specialAllowance}
                    onChange={(e) => setSpecialAllowance(e.target.value)}
                  />
                </label>
                <label>
                  Overtime Pay
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={overtimePay}
                    onChange={(e) => setOvertimePay(e.target.value)}
                  />
                </label>
                <label>
                  Manual Adjustment
                  <input
                    type="number"
                    step="0.01"
                    value={manualAdjustment}
                    onChange={(e) => setManualAdjustment(e.target.value)}
                  />
                </label>
                {nAdj !== 0 && (
                  <label>
                    Adjustment Reason
                    <input
                      type="text"
                      required
                      value={adjustmentReason}
                      onChange={(e) => setAdjustmentReason(e.target.value)}
                      placeholder="Reason for adjustment"
                    />
                  </label>
                )}
              </div>

              <div className="edit-payroll-section">
                <h3>Statutory & Other Deductions (PHP)</h3>
                <label>
                  SSS Employee Share
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={sss}
                    onChange={(e) => setSss(e.target.value)}
                  />
                </label>
                <label>
                  Phic (PhilHealth) Employee Share
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={phic}
                    onChange={(e) => setPhic(e.target.value)}
                  />
                </label>
                <label>
                  HDMF (Pag-IBIG) Employee Share
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={hdmf}
                    onChange={(e) => setHdmf(e.target.value)}
                  />
                </label>
                <label>
                  Salary Advance
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={salaryAdvance}
                    onChange={(e) => setSalaryAdvance(e.target.value)}
                  />
                </label>
              </div>
            </div>

            <div className="edit-payroll-summary">
              <div className="summary-item">
                <span className="summary-label">Total Allowance</span>
                <span className="summary-value">{php(totalAllowance)}</span>
              </div>
              <div className="summary-item">
                <span className="summary-label">Total Earnings</span>
                <span className="summary-value">{php(totalEarnings)}</span>
              </div>
              <div className="summary-item">
                <span className="summary-label">Total Deductions</span>
                <span className="summary-value" style={{ color: "var(--danger)" }}>
                  {php(totalDeductions)}
                </span>
              </div>
              <div className="summary-item">
                <span className="summary-label">Net Pay</span>
                <span className="net-pay-box">{php(netPay)}</span>
              </div>
            </div>

            {error && <p className="dashboard-alert" style={{ marginTop: "12px" }}>{error}</p>}

            <div className="confirm-actions">
              <button
                className="text-button"
                type="button"
                disabled={saving}
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                className="submit-button"
                type="submit"
                disabled={saving || !isOnline()}
              >
                {saving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} {!isOnline() ? "Offline" : "Save Changes"}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}

type PayrollAmountColumn = { label: string; value: (row: PayrollCutoffRecord) => number };

// Money fields that are ₱0 for interns. The table hides each one while every row is ₱0;
// the Breakdown popup always lists them.
const PAYROLL_OPTIONAL_EARNINGS: PayrollAmountColumn[] = [
  { label: "HRA", value: (row) => row.hra ?? 0 },
  { label: "Incentives", value: (row) => row.incentivesAllowance },
  { label: "Special Allow.", value: (row) => row.specialAllowance },
  { label: "Total Allow.", value: (row) => row.totalAllowance },
  { label: "Reg. Hol.", value: (row) => row.regularHolidayPay },
  { label: "Spec. Hol.", value: (row) => row.specialHolidayPay },
  { label: "Overtime", value: (row) => row.overtimePay },
];
const PAYROLL_OPTIONAL_DEDUCTIONS: PayrollAmountColumn[] = [
  { label: "SSS", value: (row) => row.sss ?? 0 },
  { label: "PhilHealth", value: (row) => row.phic ?? 0 },
  { label: "HDMF", value: (row) => row.hdmf ?? 0 },
  { label: "Advance", value: (row) => row.salaryAdvance ?? 0 },
];

function payrollDeptRole(row: PayrollCutoffRecord): string {
  return row.department || row.designation
    ? `${row.department ?? ""}${row.department && row.designation ? " — " : ""}${row.designation ?? ""}`
    : "—";
}

function payrollBankAccount(row: PayrollCutoffRecord): string {
  return row.bankName || row.accountNumber
    ? `${row.bankName ?? "CASH"} / ${row.accountNumber ?? "0000"}`
    : "CASH / 0000";
}

/** The full calculation and payslip detail for one payroll row, shown in the Breakdown popup. */
function PayrollBreakdownDetail({ row }: { row: PayrollCutoffRecord }) {
  const sss = row.sss ?? 0;
  const phic = row.phic ?? 0;
  const hdmf = row.hdmf ?? 0;
  const advance = row.salaryAdvance ?? 0;
  const parsedBreakdown = parseCalculationBreakdown(row.calculationBreakdown);
  const totalDeductions = payrollTotalDeductions(row);
  const netPay = row.netPay;
  // Every payslip field, including the ones the table hides while they are ₱0.
  const fieldGroups: { title: string; fields: [string, string][] }[] = [
    {
      title: "Employee",
      fields: [
        ["Employee #", row.employeeId],
        ["Dept / Role", payrollDeptRole(row)],
        ["Bank / A/C", payrollBankAccount(row)],
        ["TIN #", row.tin || "—"],
        ["Standard days", String(row.standardWorkingDays)],
        ["Paid days", String(row.actualWorkingDays)],
        ["LWOP", String(row.absentDays)],
        ["Daily rate", php(row.dailyRate)],
      ],
    },
    {
      title: "Earnings",
      fields: [
        ["Basic pay", php(row.basicPay)],
        ...PAYROLL_OPTIONAL_EARNINGS.map((column): [string, string] => [column.label, php(column.value(row))]),
        ["Total earnings", php(row.grossCompensation)],
      ],
    },
    {
      title: "Deductions",
      fields: [
        ...PAYROLL_OPTIONAL_DEDUCTIONS.map((column): [string, string] => [column.label, php(column.value(row))]),
        ["Absent", php(row.absenceDeduction)],
        ["Late / Halfday", php(row.lateDeduction + row.halfDayDeduction)],
        ["Total deductions", php(totalDeductions)],
      ],
    },
  ];
  return (
    <>
      <div className="payroll-breakdown-fields">
        {fieldGroups.map((group) => (
          <section key={group.title}>
            <h3>{group.title}</h3>
            <dl>
              {group.fields.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      {row.employeeType === "INTERN" ? (
        <div className="payroll-breakdown-formula">
          <p>
            <strong>Cutoff Rate:</strong> {php(row.totalCompensation || row.basicPay)} ({row.standardWorkingDays} std days at {php(INTERN_DAILY_RATE_PHP)}/day)
            {row.manualAdjustment !== 0
              ? ` + ${php(row.manualAdjustment)} manual adjustment (${row.adjustmentReason})`
              : ""}
            {" = "}
            <strong>{php(row.grossCompensation)}</strong> (Gross Earnings).
            <br />
            <strong>Total Deductions:</strong>{" "}
            {php(row.absenceDeduction)} absent ({row.absentDays} day(s))
            {row.lateDeduction > 0 ? ` + ${php(row.lateDeduction)} late (${row.lateUnits} hr(s) at ${php(INTERN_LATE_DEDUCTION_PER_HOUR_PHP)}/hr)` : ""}
            {row.halfDayDeduction > 0 ? ` + ${php(row.halfDayDeduction)} half-day / undertime (${row.halfDayCount} day(s))` : ""}
            {row.absenceDeduction === 0 && row.lateDeduction === 0 && row.halfDayDeduction === 0 ? "None" : ""}
            {" = "}
            <strong className="payroll-deductions-total">{php(totalDeductions)}</strong>.
            <br />
            <strong>Net Pay:</strong> {php(row.grossCompensation)} - {php(totalDeductions)} ={" "}
            <strong className="payroll-net-pay-pill">
              {php(netPay)}
            </strong>
          </p>
        </div>
      ) : (
        <div className="payroll-breakdown-formula">
          <p>
            <strong>Earnings:</strong> {php(row.basicPay)} basic +{" "}
            {php(row.hra ?? 0)} HRA +{" "}
            {php(row.incentivesAllowance)} incentives +{" "}
            {php(row.specialAllowance)} special allow. +{" "}
            {php(row.regularHolidayPay)} reg. hol. +{" "}
            {php(row.specialHolidayPay)} spec. hol. +{" "}
            {php(row.overtimePay)} overtime ={" "}
            <strong>{php(row.grossCompensation)}</strong> (Total Earnings).
            <br />
            <strong>Deductions:</strong> SSS {php(sss)} + Phic {php(phic)} + HDMF {php(hdmf)} + Advance {php(advance)} + Absent {php(row.absenceDeduction)} + Late/Halfday {php(row.lateDeduction + row.halfDayDeduction)} ={" "}
            <strong className="payroll-deductions-total">{php(totalDeductions)}</strong> (Total Deductions).
            <br />
            <strong>Net Pay:</strong> {php(row.grossCompensation)} - {php(totalDeductions)} ={" "}
            <strong className="payroll-net-pay-pill">
              {php(netPay)}
            </strong>
          </p>
        </div>
      )}

      {parsedBreakdown?.deductions && parsedBreakdown.deductions.length > 0 ? (
        <div className="payroll-deductions-container">
          <div className="payroll-deductions-header">
            <h4 className="payroll-deductions-heading">
              Transparent Deductions Breakdown ({parsedBreakdown.deductions.length} item{parsedBreakdown.deductions.length === 1 ? "" : "s"}):
            </h4>
          </div>
          <div className="payroll-deductions-table-wrap">
            <table className="payroll-deductions-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Attendance Time</th>
                  <th>Cause / Details</th>
                  <th className="payroll-col-amount">Deduction</th>
                </tr>
              </thead>
              <tbody>
                {parsedBreakdown.deductions.map((item: AttendanceDeductionItem, idx: number) => {
                  const clampedPayrollTimeIn =
                    row.employeeType === "INTERN" &&
                    !isNoGraceDate(item.date) &&
                    item.category === "LATE" &&
                    Boolean(item.timeIn && shouldClampHour(item.timeIn)) &&
                    item.amount > 0;
                  return (
                  <tr key={`${item.date}-${item.category}-${idx}`}>
                    <td className="payroll-deduction-date">
                      {formatDeductionDate(item.date)}
                    </td>
                    <td>
                      <span className={`deduction-badge badge-${item.category.toLowerCase()}`}>
                        {item.label}
                      </span>
                    </td>
                    <td className="payroll-deduction-time">
                      {item.timeIn || item.timeOut ? (
                        <>
                          {clampedPayrollTimeIn ? (
                            <span
                              className="clamped-time-in-chip clamped-time-in-static"
                              data-testid="clamped-payroll-time-in"
                              title={`Actual scan: ${item.timeIn} (payable time clamped)`}
                            >
                              {clampedTimeLabel(item.timeIn ?? "")}
                            </span>
                          ) : (
                            item.timeIn ?? "—"
                          )}
                          {" – "}
                          {item.timeOut ?? "—"}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="payroll-deduction-details">{item.details}</td>
                    <td className="payroll-deduction-amount">
                      {php(item.amount)}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        (row.absenceDeduction > 0 || row.lateDeduction > 0 || row.halfDayDeduction > 0) ? (
          <p className="payroll-deductions-note">
            Summary of deductions: {row.absenceDeduction > 0 ? `${row.absentDays} day(s) absent (${php(row.absenceDeduction)}). ` : ""}
            {row.lateDeduction > 0 ? `${row.lateUnits} hr(s) late (${php(row.lateDeduction)}). ` : ""}
            {row.halfDayDeduction > 0 ? `${row.halfDayCount} half-day / undertime day(s) (${php(row.halfDayDeduction)}). ` : ""}
            <em>(Full date-by-date breakdown will be shown on next generation from attendance).</em>
          </p>
        ) : (
          <p className="payroll-deductions-none">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span>No attendance deductions incurred for this cutoff period.</span>
          </p>
        )
      )}

      <p className="payroll-cutoff-status">
        Status: {row.status}. Cutoff: {row.payrollCutoffLabel} ({formatCutoffRange(row.cutoffStart, row.cutoffEnd)}).
      </p>
    </>
  );
}

function PayrollTable({
  records,
  onFinalized,
  loadStatus = "ready",
  onRetry,
}: {
  records: PayrollCutoffRecord[];
  onFinalized: () => void;
  loadStatus?: LoadStatus;
  onRetry?: () => void;
}) {
  // Problems stay under the table; finalized, deleted and updated results show as toasts.
  const [message, setMessage] = useState<Notice | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [editTarget, setEditTarget] = useState<PayrollCutoffRecord | null>(null);
  const [breakdownTarget, setBreakdownTarget] = useState<PayrollCutoffRecord | null>(null);
  const breakdownRef = useRef<HTMLElement>(null);
  useDialogKeys(breakdownRef, () => setBreakdownTarget(null), { open: Boolean(breakdownTarget) });
  const [deleteTarget, setDeleteTarget] = useState<PayrollCutoffRecord | null>(null);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [finalizeTarget, setFinalizeTarget] = useState<PayrollCutoffRecord | null>(null);
  const [batchFinalizeOpen, setBatchFinalizeOpen] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [deletingBatch, setDeletingBatch] = useState(false);
  const masterCheckboxRef = useRef<HTMLInputElement>(null);
  const payrollWrapRef = useRef<HTMLDivElement>(null);
  const [showAllPayroll, setShowAllPayroll] = useState(false);
  const payrollOverflowing = useVerticalOverflow(payrollWrapRef, loadStatus !== "loading" && records.length > 0);

  const allSelected = records.length > 0 && selectedIds.size === records.length;
  const someSelected = selectedIds.size > 0 && selectedIds.size < records.length;

  useEffect(() => {
    if (masterCheckboxRef.current) {
      masterCheckboxRef.current.indeterminate = someSelected;
    }
  }, [someSelected]);

  // Clean up selectedIds when records change
  useEffect(() => {
    setSelectedIds((prev) => {
      const validIds = new Set(records.map((r) => r.payrollId));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (validIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [records]);

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(records.map((r) => r.payrollId)));
    }
  };

  const toggleSelectRow = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const finalize = async () => {
    if (!finalizeTarget) return;
    const target = finalizeTarget;
    setFinalizeTarget(null);
    setFinalizing(true);
    try {
      const response = await finalizePayrollCutoff(target.payrollId);
      if (response.success) {
        showResult({ tone: "success", text: "Payroll finalized." }, setMessage);
        onFinalized();
      } else {
        setMessage({ tone: "error", text: response.error?.message ?? "Unable to finalize payroll." });
      }
    } catch (error) {
      setMessage({ tone: "error", text: toErrorMessage(error, "Unable to finalize payroll.") });
    } finally {
      setFinalizing(false);
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    try {
      const response = await deletePayrollCutoff(target.payrollId);
      if (response.success) {
        showResult({ tone: "success", text: "Payroll deleted." }, setMessage);
        setSelectedIds((prev) => {
          const next = new Set(prev);
          next.delete(target.payrollId);
          return next;
        });
        onFinalized();
      } else {
        setMessage({ tone: "error", text: response.error?.message ?? "Unable to delete payroll." });
      }
    } catch (error) {
      setMessage({ tone: "error", text: toErrorMessage(error, "Unable to delete payroll.") });
    }
  };

  const selectedDraftsCount = records.filter(
    (r) => selectedIds.has(r.payrollId) && r.status === "DRAFT",
  ).length;

  const removeBatch = async () => {
    if (selectedIds.size === 0) return;
    setBatchDeleteOpen(false);
    setDeletingBatch(true);
    try {
      const ids = Array.from(selectedIds);
      const failed: string[] = [];
      for (const id of ids) {
        const deleted = await deletePayrollCutoff(id).then((response) => response.success, () => false);
        if (!deleted) failed.push(id);
      }
      // Records that could not be deleted stay selected, ready for another try.
      setSelectedIds(new Set(failed));
      showResult(batchOutcome(ids.length - failed.length, ids.length, "Deleted", "payroll record(s)"), setMessage);
      onFinalized();
    } catch (error) {
      setMessage({ tone: "error", text: toErrorMessage(error, "Unable to complete batch deletion.") });
    } finally {
      setDeletingBatch(false);
    }
  };

  const finalizeBatch = async () => {
    const draftIds = records
      .filter((r) => selectedIds.has(r.payrollId) && r.status === "DRAFT")
      .map((r) => r.payrollId);
    if (draftIds.length === 0) return;
    setBatchFinalizeOpen(false);
    setFinalizing(true);
    try {
      const failed: string[] = [];
      for (const id of draftIds) {
        const finalized = await finalizePayrollCutoff(id).then((response) => response.success, () => false);
        if (!finalized) failed.push(id);
      }
      setSelectedIds(new Set(failed));
      showResult(batchOutcome(draftIds.length - failed.length, draftIds.length, "Finalized", "payroll record(s)"), setMessage);
      onFinalized();
    } catch (error) {
      setMessage({ tone: "error", text: toErrorMessage(error, "Unable to complete batch finalization.") });
    } finally {
      setFinalizing(false);
    }
  };

  if (loadStatus === "loading")
    return (
      <div className="table-wrap">
        <table>
          <tbody>
            <LoadingRows columns={8} label="Loading payroll…" />
          </tbody>
        </table>
      </div>
    );
  const failedLine = loadStatus === "failed" && onRetry ? <LoadFailed what="payroll" onRetry={onRetry} /> : null;
  if (!records.length)
    return failedLine ?? <div className="empty-state">No cutoff payroll has been created.</div>;

  // Hide columns that are blank or ₱0 on every row; they reappear once any row has a value,
  // and the Breakdown popup always shows them.
  const showDept = records.some((r) => r.department || r.designation);
  const showBank = records.some((r) => (r.bankName && r.bankName !== "CASH") || (r.accountNumber && r.accountNumber !== "0000"));
  const showTin = records.some((r) => r.tin);
  const visibleEarnings = PAYROLL_OPTIONAL_EARNINGS.filter((column) => records.some((r) => column.value(r) !== 0));
  const visibleDeductions = PAYROLL_OPTIONAL_DEDUCTIONS.filter((column) => records.some((r) => column.value(r) !== 0));

  return (
    <div className="payroll-table-with-bar">
      {failedLine}
      <div className="payroll-table-header-bar">
        <div className="payroll-selection-count">
          {selectedIds.size > 0 ? (
            <span className="table-selection-badge">{selectedIds.size} of {records.length} payroll record(s) selected</span>
          ) : (
            <span>Total records: {records.length}</span>
          )}
          {(showAllPayroll || payrollOverflowing) && (
            <button
              className="text-button see-all-toggle"
              type="button"
              aria-expanded={showAllPayroll}
              onClick={() => setShowAllPayroll((current) => !current)}
            >
              {showAllPayroll ? "Show less" : `See all (${records.length})`}
            </button>
          )}
        </div>
        <div className="payroll-batch-actions">
          {selectedIds.size > 0 ? (
            <>
              {selectedIds.size < records.length && (
                <button
                  className="text-button"
                  type="button"
                  onClick={() => setSelectedIds(new Set(records.map((r) => r.payrollId)))}
                >
                  Select all ({records.length})
                </button>
              )}
              <button
                className="text-button"
                type="button"
                onClick={() => setSelectedIds(new Set())}
              >
                Clear selection
              </button>
              {selectedDraftsCount > 0 && (
                <button
                  className="admin-button"
                  type="button"
                  disabled={finalizing}
                  onClick={() => setBatchFinalizeOpen(true)}
                >
                  Finalize selected ({selectedDraftsCount})
                </button>
              )}
              <button
                className="admin-button danger-button"
                type="button"
                disabled={deletingBatch}
                onClick={() => setBatchDeleteOpen(true)}
              >
                Delete selected ({selectedIds.size})
              </button>
            </>
          ) : (
            <button
              className="text-button"
              type="button"
              onClick={() => setSelectedIds(new Set(records.map((r) => r.payrollId)))}
            >
              Select all
            </button>
          )}
        </div>
      </div>

      <div className={`table-wrap ${showAllPayroll ? "is-expanded" : ""}`} ref={payrollWrapRef}>
        <table>
          <thead>
            <tr>
              <th className="payroll-select-col">
                <input
                  type="checkbox"
                  ref={masterCheckboxRef}
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  aria-label="Select all payroll records"
                />
              </th>
              <th>Employee #</th>
              <th>Employee Name</th>
              {showDept && <th>Dept / Role</th>}
              {showBank && <th>Bank / A/C</th>}
              {showTin && <th>TIN #</th>}
              <th>Standard</th>
              <th>Paid Days</th>
              <th>LWOP</th>
              <th>Daily Rate</th>
              <th>Basic Pay</th>
              {visibleEarnings.map((column) => <th key={column.label}>{column.label}</th>)}
              <th>Total Earnings</th>
              {visibleDeductions.map((column) => <th key={column.label}>{column.label}</th>)}
              <th>Absent</th>
              <th>Late / Halfday</th>
              <th>Total Deductions</th>
              <th>Net Pay</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {records.map((row) => {
              const totalDeductions = payrollTotalDeductions(row);

              const netPay = row.netPay;

              return (
                <tr key={row.payrollId} className={selectedIds.has(row.payrollId) ? "selected-row" : ""}>
                  <td className="payroll-select-cell">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(row.payrollId)}
                      onChange={() => toggleSelectRow(row.payrollId)}
                      aria-label={`Select payroll for ${row.employeeName}`}
                    />
                  </td>
                  <td>{row.employeeId}</td>
                  <td>
                    <strong>
                      {row.employeeType === "INTERN"
                        ? `${row.employeeName} (Intern)`
                        : row.employeeName}
                    </strong>
                  </td>
                  {showDept && <td>{payrollDeptRole(row)}</td>}
                  {showBank && <td>{payrollBankAccount(row)}</td>}
                  {showTin && <td>{row.tin || "—"}</td>}
                  <td>{row.standardWorkingDays}</td>
                  <td>{row.actualWorkingDays}</td>
                  <td>{row.absentDays}</td>
                  <td>{php(row.dailyRate)}</td>
                  <td>{php(row.basicPay)}</td>
                  {visibleEarnings.map((column) => <td key={column.label}>{php(column.value(row))}</td>)}
                  <td>
                    <strong>{php(row.grossCompensation)}</strong>
                  </td>
                  {visibleDeductions.map((column) => <td key={column.label}>{php(column.value(row))}</td>)}
                  <td>{php(row.absenceDeduction)}</td>
                  <td>{php(row.lateDeduction + row.halfDayDeduction)}</td>
                  <td>
                    <strong style={{ color: "var(--danger)" }}>{php(totalDeductions)}</strong>
                  </td>
                  <td style={{ backgroundColor: "#fef08a" }}>
                    <strong style={{ color: "#854d0e" }}>{php(netPay)}</strong>
                  </td>
                  <td className="payroll-actions-cell">
                    {row.status === "DRAFT" ? (
                      <span className="payroll-row-actions">
                        <button
                          className="text-button"
                          type="button"
                          onClick={() => setBreakdownTarget(row)}
                        >
                          Breakdown
                        </button>
                        <button
                          className="text-button"
                          type="button"
                          onClick={() => setEditTarget(row)}
                        >
                          Edit
                        </button>
                        <button
                          className="text-button"
                          type="button"
                          disabled={finalizing}
                          onClick={() => setFinalizeTarget(row)}
                        >
                          Finalize
                        </button>
                        <button
                          className="text-button danger-button"
                          type="button"
                          onClick={() => setDeleteTarget(row)}
                        >
                          Delete
                        </button>
                      </span>
                    ) : (
                      <span className="payroll-row-actions">
                        <span className="payroll-finalized-label">Finalized</span>
                        <button
                          className="text-button"
                          type="button"
                          onClick={() => setBreakdownTarget(row)}
                        >
                          Breakdown
                        </button>
                        <button
                          className="text-button danger-button"
                          type="button"
                          onClick={() => setDeleteTarget(row)}
                        >
                          Delete
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <NoticeLine notice={message} />
      {breakdownTarget && (
        <div className="confirm-backdrop" role="presentation">
          <section
            ref={breakdownRef}
            className="confirm-dialog payroll-breakdown-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="payroll-breakdown-heading"
          >
            <div className="payroll-breakdown-head">
              <h2 id="payroll-breakdown-heading">Calculation breakdown — {breakdownTarget.employeeName}</h2>
              <p className="payroll-breakdown-net">
                Net pay <strong>{php(breakdownTarget.netPay)}</strong>
              </p>
            </div>
            <PayrollBreakdownDetail row={breakdownTarget} />
            <div className="confirm-actions">
              <button className="submit-button" type="button" onClick={() => setBreakdownTarget(null)}>
                <Check size={16} /> Close
              </button>
            </div>
          </section>
        </div>
      )}
      <EditPayrollDialog
        record={editTarget}
        open={Boolean(editTarget)}
        onClose={() => setEditTarget(null)}
        onSaved={() => {
          showResult({ tone: "success", text: "Payroll updated." }, setMessage);
          onFinalized();
        }}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        busy={false}
        tone="danger"
        title={deleteTarget?.status === "FINALIZED" ? "Delete finalized payroll?" : "Delete saved payroll?"}
        message={
          deleteTarget
            ? deleteTarget.status === "FINALIZED"
              ? `This will delete the finalized payroll for ${deleteTarget.employeeName} (${deleteTarget.payrollCutoffLabel}). Use this if the employee left, was promoted, or needs their cutoff regenerated. Continue?`
              : `This will permanently delete the draft payroll for ${deleteTarget.employeeName} (${deleteTarget.payrollCutoffLabel}). Continue?`
            : ""
        }
        confirmLabel="Delete payroll"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void remove()}
      />
      <ConfirmDialog
        open={batchDeleteOpen}
        busy={deletingBatch}
        tone="danger"
        title="Delete selected payrolls?"
        message={`Are you sure you want to delete ${selectedIds.size} selected payroll record(s)? This will permanently remove them from the cutoff.`}
        confirmLabel="Delete payrolls"
        onCancel={() => setBatchDeleteOpen(false)}
        onConfirm={() => void removeBatch()}
      />
      <ConfirmDialog
        open={Boolean(finalizeTarget)}
        busy={finalizing}
        title="Finalize payroll?"
        message={
          finalizeTarget
            ? `This will finalize the payroll for ${finalizeTarget.employeeName} (${finalizeTarget.payrollCutoffLabel}). Values will be locked from further edits.`
            : ""
        }
        confirmLabel="Finalize payroll"
        onCancel={() => setFinalizeTarget(null)}
        onConfirm={() => void finalize()}
      />
      <ConfirmDialog
        open={batchFinalizeOpen}
        busy={finalizing}
        title="Finalize selected payrolls?"
        message={`This will finalize ${selectedDraftsCount} selected draft payroll record(s). Values will be locked from further edits.`}
        confirmLabel="Finalize payrolls"
        onCancel={() => setBatchFinalizeOpen(false)}
        onConfirm={() => void finalizeBatch()}
      />
    </div>
  );
}

function php(value: number): string {
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
    .format(Number.isFinite(value) ? value : 0)
    .replace("₱", "PHP ");
}

export function formatDeductionDate(dateStr: string | null | undefined): string {
  return dateStr ? formatDate(dateStr) : "—";
}

/**
 * Total deductions for display: the backend-authoritative value wins when
 * present; legacy Sheets cutoff rows omit `totalDeductions`, so derive it
 * from its components instead of showing ₱0 beside a reduced net pay.
 */
function payrollTotalDeductions(record: PayrollCutoffRecord): number {
  if (record.totalDeductions != null) return record.totalDeductions;
  return (
    record.lateDeduction +
    record.halfDayDeduction +
    record.absenceDeduction +
    (record.sss ?? 0) +
    (record.phic ?? 0) +
    (record.hdmf ?? 0) +
    (record.salaryAdvance ?? 0)
  );
}

function parseCalculationBreakdown(
  breakdownStr: string | null | undefined,
): CutoffCalculationBreakdownData | null {
  if (!breakdownStr || !breakdownStr.trim()) return null;
  try {
    // SAFETY: Input is a verified JSON string produced by payroll calculation stored in SQLite
    const parsed = JSON.parse(breakdownStr) as CutoffCalculationBreakdownData;
    return parsed && parsed.deductions ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * History of generated payroll PDFs produced by the Tauri backend. Each row
 * offers Open PDF (system default viewer) and Show in Folder actions backed by
 * the existing opener commands; nothing is ever printed from the browser.
 */
function PayrollPdfList({ pdfs }: { pdfs: PayrollPdfRecord[] }) {
  const [actionMessage, setActionMessage] = useState<Notice | null>(null);
  // Months opened or closed by hand; the latest month starts open and older months start closed.
  const [toggledMonths, setToggledMonths] = useState<ReadonlySet<string>>(new Set());
  const runAction = async (
    action: (filePath: string) => Promise<FileActionResult>,
    filePath: string,
  ) => {
    const result = await action(filePath);
    setActionMessage(result.ok ? null : { tone: "error", text: result.message });
  };
  const sorted = [...pdfs].sort((a, b) =>
    b.generatedAt.localeCompare(a.generatedAt),
  );
  if (!sorted.length)
    return (
      <div className="empty-state">No payroll PDFs have been generated yet.</div>
    );
  // One fold per cutoff month, newest month first; PDFs inside stay newest-generated first.
  const months: { key: string; label: string; pdfs: PayrollPdfRecord[] }[] = [];
  for (const pdf of sorted) {
    const key = /^\d{4}-\d{2}/.test(pdf.cutoffStart) ? pdf.cutoffStart.slice(0, 7) : "";
    const month = months.find((group) => group.key === key);
    if (month) month.pdfs.push(pdf);
    else
      months.push({
        key,
        label: key ? formatMonth(`${key}-01`) : "Other",
        pdfs: [pdf],
      });
  }
  months.sort((a, b) => b.key.localeCompare(a.key));
  const toggleMonth = (key: string) =>
    setToggledMonths((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Period</th>
              <th>Type</th>
              <th>Generated</th>
              <th>Interns</th>
              <th>Total</th>
              <th>Actions</th>
            </tr>
          </thead>
          {months.map((month, index) => {
            const open = (index === 0) !== toggledMonths.has(month.key);
            return (
              <tbody key={month.key} className="payroll-pdf-month">
                <tr>
                  <th colSpan={6} scope="rowgroup">
                    <button type="button" aria-expanded={open} onClick={() => toggleMonth(month.key)}>
                      {month.label} <span className="db-backup-count">{month.pdfs.length}</span>
                    </button>
                  </th>
                </tr>
                {open && month.pdfs.map((pdf) => (
                  <tr key={pdf.payrollPdfId}>
                    <td>
                      <strong>{pdf.payrollCutoffLabel}</strong>
                      <small>{formatCutoffRange(pdf.cutoffStart, pdf.cutoffEnd)}</small>
                    </td>
                    <td>Intern</td>
                    <td>{formatDateTime(pdf.generatedAt)}</td>
                    <td>{pdf.employeeCount}</td>
                    <td>
                      <strong>{php(pdf.totalAmount)}</strong>
                    </td>
                    <td className="payroll-pdf-actions">
                      <button
                        className="text-button"
                        type="button"
                        onClick={() => void runAction(openGeneratedFile, pdf.filePath)}
                      >
                        Open PDF
                      </button>
                      <button
                        className="text-button"
                        type="button"
                        onClick={() =>
                          void runAction(revealGeneratedFile, pdf.filePath)
                        }
                      >
                        Show in Folder
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            );
          })}
        </table>
      </div>
      <NoticeLine notice={actionMessage} />
    </>
  );
}

/**
 * Manila clock seconds since midnight for an ISO time-in, or null when
 * unparseable.
 */
function manilaClockSeconds(timeInIso: string): number | null {
  const date = new Date(timeInIso);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ATTENDANCE_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const read = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return read("hour") * 3600 + read("minute") * 60 + read("second");
}

/**
 * Clock seconds since midnight for either an ISO time-in or a payroll
 * "8:30 AM" style display label, or null when neither parses. Shared by the
 * hourly clamp display and payroll details.
 */
function clampWindowClockSeconds(timeInValue: string): number | null {
  const match = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(timeInValue.trim());
  if (match) {
    const hour = Number(match[1]) % 12;
    const minute = Number(match[2]);
    if (hour > 11 || minute > 59) return null;
    return (
      hour * 3600 + minute * 60 + (match[3].toUpperCase() === "PM" ? 12 * 3600 : 0)
    );
  }
  return manilaClockSeconds(timeInValue);
}

/** Round a payable late arrival strictly after :15 to the next Manila hour. */
function clampedTimeLabel(timeInValue: string): string {
  const seconds = clampWindowClockSeconds(timeInValue);
  if (seconds === null) return timeInValue;
  const hour = Math.floor(seconds / 3600);
  const withinHour = seconds % 3600;
  const clampedHour = isStrictlyPastQuarterHour(timeInValue, withinHour)
    ? (hour + 1) % 24
    : hour;
  return `${clampedHour % 12 || 12}:00 ${clampedHour < 12 ? "AM" : "PM"}`;
}

function hasNonZeroSubMillisecondFraction(timeInValue: string): boolean {
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/i.exec(timeInValue)?.[1];
  return fraction !== undefined && /[1-9]/.test(fraction.slice(3));
}

function isStrictlyPastQuarterHour(timeInValue: string, withinHour: number): boolean {
  const date = new Date(timeInValue);
  const fraction = Number.isFinite(date.getTime()) ? date.getMilliseconds() : 0;
  return withinHour > 15 * 60 ||
    (withinHour === 15 * 60 && (fraction > 0 || hasNonZeroSubMillisecondFraction(timeInValue)));
}

function shouldClampHour(timeInValue: string): boolean {
  const seconds = clampWindowClockSeconds(timeInValue);
  if (seconds === null) return false;
  return isStrictlyPastQuarterHour(timeInValue, seconds % 3600);
}

function clampedTimeInIso(timeInIso: string): string {
  const seconds = manilaClockSeconds(timeInIso);
  const date = new Date(timeInIso);
  if (seconds === null || !Number.isFinite(date.getTime())) return timeInIso;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ATTENDANCE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  const dateText = `${part("year")}-${part("month")}-${part("day")}`;
  const withinHour = seconds % 3600;
  const nextHour = isStrictlyPastQuarterHour(timeInIso, withinHour)
    ? Math.floor(seconds / 3600) + 1
    : Math.floor(seconds / 3600);
  const payable = new Date(`${dateText}T00:00:00+08:00`);
  payable.setTime(payable.getTime() + nextHour * 3600_000);
  const payableParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ATTENDANCE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(payable);
  const payablePart = (type: string) => payableParts.find((item) => item.type === type)?.value ?? "";
  const payableDate = `${payablePart("year")}-${payablePart("month")}-${payablePart("day")}`;
  return `${payableDate}T${String(nextHour % 24).padStart(2, "0")}:00:00+08:00`;
}

/**
 * Display-only payable clamp: non-graced late intern rows are clamped. The
 * week's first grace-window arrival stays actual; employees and on-time rows
 * are excluded. Grouping stays
 * per userId + Manila Monday-week; callers may pass a wider set than they
 * render (e.g. earlier days of the week alongside today's rows) and
 * duplicated attendanceIds count once. Backing data (row.timeIn) is never
 * mutated.
 */
function clampedGraceTimeInIds(
  rows: AttendanceListItem[],
  users: AdminUser[],
): Set<string> {
  const internIds = new Set(
    users
      .filter((user) => user.employeeType === "INTERN")
      .map((user) => user.userId),
  );
  const groups = new Map<string, AttendanceListItem[]>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.attendanceId)) continue;
    seen.add(row.attendanceId);
    if (!row.timeIn || !internIds.has(row.userId)) continue;
    const arrival = evaluateArrivalFromTimestamp(row.timeIn, ATTENDANCE_TIMEZONE, row.attendanceDate);
    if (arrival !== "LATE" && arrival !== "GRACE_PERIOD") {
      continue;
    }
    let weekStart: string;
    try {
      weekStart = getManilaWeekStart(row.attendanceDate);
    } catch {
      continue;
    }
    const key = `${row.userId}:${weekStart}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const clamped = new Set<string>();
  for (const list of groups.values()) {
    list.sort((a, b) => {
      const byDate = a.attendanceDate.localeCompare(b.attendanceDate);
      return byDate !== 0 ? byDate : a.timeIn.localeCompare(b.timeIn);
    });
    let graceUsed = false;
    for (const row of list) {
      if (isNoGraceDate(row.attendanceDate)) continue;
      const inGraceWindow =
        evaluateArrivalFromTimestamp(row.timeIn, ATTENDANCE_TIMEZONE) ===
          "GRACE_PERIOD" &&
        !(
          manilaClockSeconds(row.timeIn) === 8 * 3600 + 15 * 60 &&
          isStrictlyPastQuarterHour(row.timeIn, 15 * 60)
        );
      if (inGraceWindow && !graceUsed) {
        graceUsed = true;
        continue;
      }
      if (shouldClampHour(row.timeIn)) clamped.add(row.attendanceId);
    }
  }
  return clamped;
}

/** No rows: what the attendance page counts, selects and exports until a date's rows have loaded. */
const NO_ATTENDANCE_ROWS: AttendanceListItem[] = [];

/**
 * A row open for editing: the times typed (HH:MM, "" when cleared), the record's stamps when it opened, and
 * whether typed changes were cleared because the record changed on the server meanwhile.
 */
type AttendanceDraft = { timeIn: string; timeOut: string; fromIn: string; fromOut: string | null; changedOnServer: boolean };

/** "2026-10-30T08:12:00+08:00" → "08:12", the value a time input shows. */
function clockOf(stamp: string | null): string {
  return stamp ? stamp.slice(11, 16) : "";
}

function draftFor(row: AttendanceListItem): AttendanceDraft {
  return { timeIn: clockOf(row.timeIn), timeOut: clockOf(row.timeOut), fromIn: row.timeIn, fromOut: row.timeOut, changedOnServer: false };
}

const RECORD_CHANGED_NOTICE: Notice = {
  tone: "error",
  text: "This record changed (for example a new scan). Your typed times were cleared; check and edit again.",
};

function draftChanged(draft: AttendanceDraft): boolean {
  return draft.timeIn !== clockOf(draft.fromIn) || draft.timeOut !== clockOf(draft.fromOut);
}

function AdminAttendance({
  rows,
  date,
  setDate,
  users = [],
  onSaved,
  onDirtyChange,
  loadStatus = "ready",
  onRetry,
}: {
  rows: AttendanceListItem[];
  date: string;
  setDate: (value: string) => void;
  users?: AdminUser[];
  /** Refreshes the lists; a saved row stays on "Saving…" until it resolves. */
  onSaved: () => void | Promise<void>;
  /** Reports whether any open row has unsaved times, so Admin can ask before leaving the tab or page. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Where this date's attendance load stands (Admin loads it). */
  loadStatus?: LoadStatus;
  onRetry?: () => void;
}) {
  // Problems stay in the filter bar; exports and deletes show as toasts.
  const [message, setMessage] = useState<Notice | null>(null);
  const [exporting, setExporting] = useState(false);
  const [fileResult, setFileResult] = useState<GeneratedFileResult | null>(
    null,
  );
  const [employeeFilter, setEmployeeFilter] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const statusFilterRef = useRef<HTMLDivElement>(null);
  const statusThumb = useActiveThumb(statusFilterRef, statusFilter);
  const [backdatedModalOpen, setBackdatedModalOpen] = useState(false);

  // Until this date's rows have loaded (or after they failed to), nothing is counted, selected or exported.
  const ready = loadStatus === "ready";
  const activeRows = ready ? rows : NO_ATTENDANCE_ROWS;

  // Rows open for editing, by record. Kept here, above the filters, so searching or filtering never loses typing.
  const [drafts, setDrafts] = useState<Map<string, AttendanceDraft>>(() => new Map());
  const setDraft = (id: string, draft: AttendanceDraft | null) =>
    setDrafts((current) => {
      const next = new Map(current);
      if (draft) next.set(id, draft);
      else next.delete(id);
      return next;
    });
  // Rows saving or deleting: the date stays put until they finish, so their refresh lands on their own date.
  const busyRowIds = useRef(new Set<string>());
  const [rowsBusy, setRowsBusy] = useState(false);
  const setRowBusy = (id: string, busy: boolean) => {
    if (busy) busyRowIds.current.add(id);
    else busyRowIds.current.delete(id);
    setRowsBusy(busyRowIds.current.size > 0);
  };
  // A record that changed on the server (say, a new scan or a save conflict) shows its current times again, with a
  // note on the row when typed changes were cleared; a record that is gone drops its draft.
  useEffect(() => {
    if (!ready) return;
    setDrafts((current) => {
      let changed = false;
      const next = new Map<string, AttendanceDraft>();
      for (const [id, draft] of current) {
        const row = rows.find((candidate) => candidate.attendanceId === id);
        if (!row) changed = true;
        else if (row.timeIn !== draft.fromIn || row.timeOut !== draft.fromOut) {
          // A row's own save changes its record too; that is not news to the admin.
          next.set(id, { ...draftFor(row), changedOnServer: draftChanged(draft) && !busyRowIds.current.has(id) });
          changed = true;
        } else next.set(id, draft);
      }
      return changed ? next : current;
    });
  }, [rows, ready]);
  const hasUnsaved = [...drafts.values()].some(draftChanged);
  useEffect(() => {
    onDirtyChange?.(hasUnsaved);
  }, [hasUnsaved, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  // Another date shows other records: unsaved times are discarded first, after asking.
  const [pendingDate, setPendingDate] = useState<string | null>(null);
  const changeDate = (next: string) => {
    if (next === date || busyRowIds.current.size > 0 || batchDeletingAttendance) return;
    if (hasUnsaved) {
      setPendingDate(next);
      return;
    }
    setDrafts(new Map());
    setDate(next);
  };
  // A date typed into the field while rows are unsaved, held until Enter or leaving the field.
  const [typedDate, setTypedDate] = useState<string | null>(null);
  const typingDate = useRef(false);
  const commitTypedDate = () => {
    if (typedDate) changeDate(typedDate);
    setTypedDate(null);
  };

  const [clampWeekHistory, setClampWeekHistory] = useState<AttendanceListItem[]>([]);
  const hasInternRoster = users.some((user) => user.employeeType === "INTERN");

  useEffect(() => {
    let cancelled = false;
    setClampWeekHistory([]);
    if (!hasInternRoster || !date) return () => { cancelled = true; };

    let weekStart: string;
    try {
      weekStart = getManilaWeekStart(date);
    } catch {
      return () => { cancelled = true; };
    }

    const dates: string[] = [];
    for (
      const cursor = new Date(`${weekStart}T00:00:00Z`);
      cursor.toISOString().slice(0, 10) < date;
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    ) {
      dates.push(cursor.toISOString().slice(0, 10));
    }
    if (!dates.length) return () => { cancelled = true; };

    void Promise.all(dates.map((day) => loadAttendance(day)))
      .then((responses) => {
        if (cancelled) return;
        setClampWeekHistory(
          responses.flatMap((response) =>
            response.success && Array.isArray(response.attendance) ? response.attendance : [],
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setClampWeekHistory([]);
      });

    return () => { cancelled = true; };
  }, [date, hasInternRoster]);

  const arrivalMap = useMemo(
    () => {
      const employeeTypes = new Map(users.map((user) => [user.userId, user.employeeType]));
      return evaluateAttendanceArrivals(activeRows.map((row) => ({
        ...row,
        employeeType: employeeTypes.get(row.userId) ?? "EMPLOYEE",
      })));
    },
    [activeRows, users],
  );

  const clampedTimeInIds = useMemo(
    () => clampedGraceTimeInIds([...activeRows, ...clampWeekHistory], users),
    [activeRows, clampWeekHistory, users],
  );

  const counts = useMemo(() => {
    let lateCount = 0;
    for (const info of arrivalMap.values()) {
      if (info.arrivalStatus === "LATE") lateCount++;
    }
    return {
      all: activeRows.length,
      late: lateCount,
      lateTimeout: activeRows.filter((r) => r.status === "LATE_TIMEOUT").length,
      working: activeRows.filter((r) => r.status === "WORKING").length,
      completed: activeRows.filter((r) => r.status === "COMPLETED").length,
      missed: activeRows.filter((r) => r.status === "MISSED").length,
      assisted: activeRows.filter((r) => r.source === "ADMIN_ASSISTED_SCAN").length,
      backdated: activeRows.filter((r) => r.source === "ADMIN_BACKDATED_ENTRY").length,
    };
  }, [activeRows, arrivalMap]);

  const filteredRows = activeRows.filter((row) => {
    if (
      employeeFilter &&
      !`${row.fullName} ${row.userId}`
        .toLowerCase()
        .includes(employeeFilter.toLowerCase())
    ) {
      return false;
    }
    if (departmentFilter && row.department !== departmentFilter) {
      return false;
    }
    if (sourceFilter && row.source !== sourceFilter) {
      return false;
    }
    if (!statusFilter) return true;
    if (statusFilter === "LATE") {
      return arrivalMap.get(row.attendanceId)?.arrivalStatus === "LATE";
    }
    return row.status === statusFilter;
  });

  // On screen only: counts, selection and the CSV export keep using filteredRows in the server's order. Rows sort
  // by the time they show, so a clamped time-in sorts as its payable 9:00 AM.
  const [timeOrder, toggleTimeOrder] = useTimeOrder("alpha_premier_sort_attendance_corrections");
  const shownRows = sortByTime(
    filteredRows,
    (row) => (clampedTimeInIds.has(row.attendanceId) && row.timeIn ? clampedTimeInIso(row.timeIn) : row.timeIn),
    timeOrder,
  );
  // Unsaved rows that the filters hide get a note by the count, with a way to show them again.
  const shownIds = new Set(filteredRows.map((row) => row.attendanceId));
  const hiddenUnsaved = activeRows.filter((row) => {
    const draft = drafts.get(row.attendanceId);
    return draft !== undefined && draftChanged(draft) && !shownIds.has(row.attendanceId);
  }).length;
  const clearFilters = () => {
    setStatusFilter("");
    setSourceFilter("");
    setEmployeeFilter("");
    setDepartmentFilter("");
  };

  const departments = [
    ...new Set(
      activeRows
        .map((row) => row.department)
        .filter((d): d is string => Boolean(d)),
    ),
  ];

  const [selectedAttendanceIds, setSelectedAttendanceIds] = useState<Set<string>>(new Set());
  // A selection belongs to one date's rows.
  useEffect(() => {
    setSelectedAttendanceIds(new Set());
  }, [date]);
  const [batchDeleteAttendanceOpen, setBatchDeleteAttendanceOpen] = useState(false);
  const [batchDeletingAttendance, setBatchDeletingAttendance] = useState(false);
  // No other date while rows are saving or deleting: their refresh must land on this date.
  const dateLocked = rowsBusy || batchDeletingAttendance;
  const masterAttendanceCheckboxRef = useRef<HTMLInputElement>(null);
  const attendanceWrapRef = useRef<HTMLDivElement>(null);
  const [showAllAttendance, setShowAllAttendance] = useState(false);
  const attendanceOverflowing = useVerticalOverflow(attendanceWrapRef, true);

  const allAttendanceSelected = filteredRows.length > 0 && selectedAttendanceIds.size === filteredRows.length;
  const someAttendanceSelected = selectedAttendanceIds.size > 0 && selectedAttendanceIds.size < filteredRows.length;

  useEffect(() => {
    if (masterAttendanceCheckboxRef.current) {
      masterAttendanceCheckboxRef.current.indeterminate = someAttendanceSelected;
    }
  }, [someAttendanceSelected]);

  useEffect(() => {
    setSelectedAttendanceIds((prev) => {
      const valid = new Set(filteredRows.map((r) => r.attendanceId));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (valid.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [filteredRows]);

  const toggleSelectAllAttendance = () => {
    if (allAttendanceSelected) {
      setSelectedAttendanceIds(new Set());
    } else {
      setSelectedAttendanceIds(new Set(filteredRows.map((r) => r.attendanceId)));
    }
  };

  const toggleSelectAttendance = (id: string) => {
    setSelectedAttendanceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exportSelectedAttendance = () => {
    const selectedRows = filteredRows.filter((r) => selectedAttendanceIds.has(r.attendanceId));
    if (selectedRows.length === 0) return;
    const result = exportAttendanceCsv(
      selectedRows,
      arrivalMap,
      clampedTimeInIds,
      date,
    );
    if (result.success) {
      setMessage(null);
      showToast(`Generated ${result.fileName} (${selectedRows.length} rows).`);
      setFileResult({
        filePath: result.filePath,
        directoryPath: result.directoryPath,
        fileName: result.fileName,
        fileKind: "csv",
        isPortableMode: false,
      });
    } else setMessage({ tone: "error", text: result.message });
  };

  const removeBatchAttendance = async () => {
    if (selectedAttendanceIds.size === 0) return;
    setBatchDeleteAttendanceOpen(false);
    setBatchDeletingAttendance(true);
    const targetRows = filteredRows.filter((r) => selectedAttendanceIds.has(r.attendanceId));
    const failed: string[] = [];
    for (const r of targetRows) {
      const deleted = await deleteAdminAttendance(r.attendanceId, r.attendanceDate).then((res) => res.success, () => false);
      if (!deleted) failed.push(r.attendanceId);
    }
    setBatchDeletingAttendance(false);
    // Records that could not be deleted stay selected, ready for another try.
    setSelectedAttendanceIds(new Set(failed));
    showResult(batchOutcome(targetRows.length - failed.length, targetRows.length, "Deleted", "attendance record(s)"), setMessage);
    onSaved();
  };

  const exportWorkbook = async () => {
    setExporting(true);
    const result = exportAttendanceCsv(
      filteredRows,
      arrivalMap,
      clampedTimeInIds,
      date,
    );
    setExporting(false);
    if (result.success) {
      setMessage(null);
      showToast(`Generated ${result.fileName} (${filteredRows.length} rows).`);
      setFileResult({
        filePath: result.filePath,
        directoryPath: result.directoryPath,
        fileName: result.fileName,
        fileKind: "csv",
        isPortableMode: false,
      });
    } else setMessage({ tone: "error", text: result.message });
  };

  const statusOptions = [
    ["", "All", counts.all],
    ["LATE", "Late", counts.late],
    ["LATE_TIMEOUT", "Late time-out", counts.lateTimeout],
    ["WORKING", "Working", counts.working],
    ["COMPLETED", "Completed", counts.completed],
    ["MISSED", "Missed", counts.missed],
  ] as const;

  return (
    <section className="table-with-bar">
      <div className="attendance-filter-bar">
        <div className="attendance-filter-top">
          {/* Status: one choice at a time, marked by a gold underline that slides to it. */}
          <div className="attendance-status-filter" role="group" aria-label="Filter by status" ref={statusFilterRef}>
            {statusThumb && (
              <span
                className="attendance-status-thumb"
                aria-hidden="true"
                style={{ width: statusThumb.width, transform: `translate(${statusThumb.x}px, ${statusThumb.y + statusThumb.height - 2}px)` }}
              />
            )}
            {statusOptions.map(([id, label, count]) => (
              <button
                key={label}
                type="button"
                className={`${statusFilter === id ? "is-active" : ""}${count ? "" : " is-empty"}`}
                aria-pressed={statusFilter === id}
                onClick={() => setStatusFilter(id && statusFilter === id ? "" : id)}
              >
                {label} <span className="filter-count">{count}</span>
              </button>
            ))}
          </div>
          {/* Source: Assisted and Backdated switch on and off on their own and combine with the status. */}
          <div className="attendance-source-filter" role="group" aria-label="Show only">
            <button
              className={`source-toggle ${sourceFilter === "ADMIN_ASSISTED_SCAN" ? "is-active" : ""}`}
              type="button"
              aria-pressed={sourceFilter === "ADMIN_ASSISTED_SCAN"}
              title="Show only kiosk scans assisted by an administrator"
              onClick={() =>
                setSourceFilter(
                  sourceFilter === "ADMIN_ASSISTED_SCAN" ? "" : "ADMIN_ASSISTED_SCAN",
                )
              }
            >
              <UserCheck size={14} aria-hidden="true" />
              Assisted <span className="filter-count">{counts.assisted}</span>
            </button>
            <button
              className={`source-toggle ${sourceFilter === "ADMIN_BACKDATED_ENTRY" ? "is-active" : ""}`}
              type="button"
              aria-pressed={sourceFilter === "ADMIN_BACKDATED_ENTRY"}
              title="Show only backdated attendance manually entered by an administrator"
              onClick={() =>
                setSourceFilter(
                  sourceFilter === "ADMIN_BACKDATED_ENTRY" ? "" : "ADMIN_BACKDATED_ENTRY",
                )
              }
            >
              <History size={14} aria-hidden="true" />
              Backdated <span className="filter-count">{counts.backdated}</span>
            </button>
          </div>
        </div>
        <div className="date-filter">
          <label>
            Date
            <input
              type="date"
              aria-label="Filter attendance date"
              value={typedDate ?? date}
              disabled={dateLocked}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitTypedDate();
                else typingDate.current = true;
              }}
              onPointerDown={() => {
                typingDate.current = false;
              }}
              onBlur={commitTypedDate}
              onChange={(event) => {
                const val = event.target.value;
                if (!val) return;
                // With unsaved rows, a date typed segment by segment waits for Enter or leaving the field, so the
                // discard question never opens on a half-typed date. A date picked from the calendar applies at once.
                if (hasUnsaved && typingDate.current) setTypedDate(val);
                else {
                  setTypedDate(null);
                  changeDate(val);
                }
              }}
            />
          </label>
          <button
            type="button"
            className="filter-preset-btn"
            onClick={() => changeDate(localDate())}
            disabled={date === localDate() || dateLocked}
          >
            Today
          </button>
          <label>
            Employee
            <input
              placeholder="Name or ID"
              value={employeeFilter}
              onChange={(event) => setEmployeeFilter(event.target.value)}
            />
          </label>
          <label>
            Department
            <select
              value={departmentFilter}
              onChange={(event) => setDepartmentFilter(event.target.value)}
            >
              <option value="">All departments</option>
              {departments.map((department) => (
                <option key={department} value={department}>
                  {department}
                </option>
              ))}
            </select>
          </label>
          <button
            className="admin-button-primary"
            type="button"
            aria-label="+ Add missed attendance"
            onClick={() => setBackdatedModalOpen(true)}
          >
            <Plus size={15} /> Add missed attendance
          </button>
          <button
            className="admin-button"
            type="button"
            disabled={exporting || !ready}
            onClick={() => void exportWorkbook()}
          >
            {exporting ? (
              "Preparing..."
            ) : (
              <>
                <Download size={15} /> Export CSV
              </>
            )}
          </button>
          <NoticeLine notice={message} className="attendance-filter-message" />
        </div>
      </div>
      <GeneratedFileActions result={fileResult} label="Attendance export" />
      {loadStatus === "failed" && onRetry && <LoadFailed what="attendance for this date" onRetry={onRetry} />}

      <div className="table-header-bar">
        <div className="table-selection-count">
          {/* The chosen day, once for the whole table. */}
          <span className="attendance-day">{formatDate(date)}</span>
          {selectedAttendanceIds.size > 0 ? (
            <span className="table-selection-badge">{selectedAttendanceIds.size} of {filteredRows.length} attendance record(s) selected</span>
          ) : (
            <span>Total records: {filteredRows.length}</span>
          )}
          {hiddenUnsaved > 0 && (
            <span className="attendance-hidden-unsaved">
              {hiddenUnsaved === 1 ? "1 unsaved row" : `${hiddenUnsaved} unsaved rows`} hidden by filters ·{" "}
              <button type="button" className="text-button" onClick={clearFilters}>
                Show
              </button>
            </span>
          )}
          {/* Phones: the cards have no Time in heading, so the order gets a small toggle here. */}
          <TimeOrderToggle column="Time in" order={timeOrder} onToggle={toggleTimeOrder} />
          {(showAllAttendance || attendanceOverflowing) && (
            <button
              className="text-button see-all-toggle"
              type="button"
              aria-expanded={showAllAttendance}
              onClick={() => setShowAllAttendance((current) => !current)}
            >
              {showAllAttendance ? "Show less" : `See all (${filteredRows.length})`}
            </button>
          )}
        </div>
        <div className="table-batch-actions">
          {selectedAttendanceIds.size > 0 ? (
            <>
              {selectedAttendanceIds.size < filteredRows.length && (
                <button
                  className="text-button"
                  type="button"
                  disabled={!ready}
                  onClick={() => setSelectedAttendanceIds(new Set(filteredRows.map((r) => r.attendanceId)))}
                >
                  Select all ({filteredRows.length})
                </button>
              )}
              <button
                className="text-button"
                type="button"
                onClick={() => setSelectedAttendanceIds(new Set())}
              >
                Clear selection
              </button>
              <button
                className="admin-button"
                type="button"
                disabled={!ready}
                onClick={exportSelectedAttendance}
              >
                <Download size={14} /> Export selected CSV ({selectedAttendanceIds.size})
              </button>
              <button
                className="admin-button danger-button"
                type="button"
                disabled={batchDeletingAttendance || !ready}
                onClick={() => setBatchDeleteAttendanceOpen(true)}
              >
                Delete selected ({selectedAttendanceIds.size})
              </button>
            </>
          ) : (
            <button
              className="text-button"
              type="button"
              disabled={!ready || filteredRows.length === 0}
              onClick={() => setSelectedAttendanceIds(new Set(filteredRows.map((r) => r.attendanceId)))}
            >
              Select all
            </button>
          )}
        </div>
      </div>

      <div
        className={`table-wrap attendance-table-wrap ${showAllAttendance ? "is-expanded" : ""}`}
        ref={attendanceWrapRef}
      >
        <table>
          <thead>
            <tr>
              <th className="table-select-col">
                <input
                  type="checkbox"
                  ref={masterAttendanceCheckboxRef}
                  checked={allAttendanceSelected}
                  disabled={!ready}
                  onChange={toggleSelectAllAttendance}
                  aria-label="Select all attendance records"
                />
              </th>
              <th>Employee</th>
              <TimeSortHeading label="Time in" order={timeOrder} onToggle={toggleTimeOrder} />
              <th>Arrival</th>
              <th>Time out</th>
              <th>Status</th>
              <th>
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {loadStatus === "loading" ? (
              <LoadingRows columns={7} label="Loading attendance…" />
            ) : filteredRows.length === 0 ? (
              loadStatus === "failed" ? null : (
              <tr>
                <td colSpan={7} className="table-empty-cell">
                  <div className="empty-state">
                    No attendance records found for this day
                    {employeeFilter || departmentFilter || statusFilter || sourceFilter
                      ? " matching the selected filters"
                      : ""}
                    .
                  </div>
                </td>
              </tr>
              )
            ) : (
              shownRows.map((row) => (
                <AttendanceEditRow
                  key={row.attendanceId}
                  row={row}
                  draft={drafts.get(row.attendanceId)}
                  onDraftChange={(draft) => setDraft(row.attendanceId, draft)}
                  onBusyChange={(busy) => setRowBusy(row.attendanceId, busy)}
                  selected={selectedAttendanceIds.has(row.attendanceId)}
                  onToggleSelect={() => toggleSelectAttendance(row.attendanceId)}
                  arrivalInfo={arrivalMap.get(row.attendanceId)}
                  timeInClamped={clampedTimeInIds.has(row.attendanceId)}
                  onSaved={onSaved}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
      <ConfirmDialog
        open={batchDeleteAttendanceOpen}
        busy={batchDeletingAttendance}
        tone="danger"
        title="Delete selected attendance records?"
        message={`Are you sure you want to delete ${selectedAttendanceIds.size} selected attendance record(s)? This will remove them from the logs.`}
        confirmLabel="Delete records"
        onCancel={() => setBatchDeleteAttendanceOpen(false)}
        onConfirm={() => void removeBatchAttendance()}
      />
      <ConfirmDialog
        open={pendingDate !== null}
        busy={false}
        tone="danger"
        title="Discard unsaved changes?"
        message={`Some times on ${formatDate(date)} are not saved yet. Showing ${pendingDate ? formatDate(pendingDate) : "another day"} discards them.`}
        cancelLabel="Keep editing"
        confirmLabel="Discard changes"
        onCancel={() => setPendingDate(null)}
        onConfirm={() => {
          if (pendingDate) setDate(pendingDate);
          setDrafts(new Map());
          setPendingDate(null);
        }}
      />
      {backdatedModalOpen && (
        <BackdatedAttendanceModal
          activeEmployees={users.filter(
            (u) => u.status === "ACTIVE" && u.cardType !== "ADMIN_ASSIST",
          )}
          onClose={() => setBackdatedModalOpen(false)}
          onSaved={(createdDate?: string) => {
            if (createdDate) {
              changeDate(createdDate);
            }
            void onSaved();
          }}
        />
      )}
    </section>
  );
}

function BackdatedAttendanceModal({
  activeEmployees,
  onClose,
  onSaved,
}: {
  activeEmployees: AdminUser[];
  onClose: () => void;
  onSaved: (createdDate?: string) => void;
}) {
  const yesterday = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
  }, []);

  const [userId, setUserId] = useState(activeEmployees[0]?.userId ?? "");
  const [attendanceDate, setAttendanceDate] = useState(yesterday);
  const [timeIn, setTimeIn] = useState("08:00");
  const [timeOut, setTimeOut] = useState("17:00");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  useDialogKeys(dialogRef, onClose, { busy });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId || !attendanceDate || !timeIn || !reason.trim()) {
      setError("Employee, attendance date, time-in, and reason are required.");
      return;
    }
    if (attendanceDate > yesterday) {
      setError("Backdated attendance date must be strictly in the past.");
      return;
    }
    if (timeOut && timeOut < timeIn) {
      setError("Time-out cannot precede time-in.");
      return;
    }

    setBusy(true);
    setError("");
    const timeInIso = `${attendanceDate}T${timeIn}:00+08:00`;
    const timeOutIso = timeOut ? `${attendanceDate}T${timeOut}:00+08:00` : null;

    try {
      const response = await createAdminBackdatedAttendance({
        userId,
        attendanceDate,
        timeIn: timeInIso,
        timeOut: timeOutIso,
        reason: reason.trim(),
      });
      setBusy(false);
      if (response.success) {
        showToast("Missed attendance added.");
        onSaved(attendanceDate);
        onClose();
      } else {
        setError(response.error?.message ?? "Failed to add backdated attendance.");
      }
    } catch {
      setBusy(false);
      setError("Network or server error while adding backdated attendance.");
    }
  };

  return (
    <div
      className="assisted-modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="assisted-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="backdated-heading"
      >
        <div className="assisted-modal-header">
          <div className="assisted-modal-title-wrap">
            <div className="assisted-modal-icon icon-purple" aria-hidden="true">
              <CalendarPlus size={22} />
            </div>
            <div>
              <p className="section-kicker">Attendance override</p>
              <h3 id="backdated-heading">Add Missed Attendance</h3>
              <p className="assisted-modal-subtitle">
                Create a past-date entry with verified time-in and audit record
              </p>
            </div>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="assisted-modal-body">
            {error && <p className="dashboard-alert">{error}</p>}

            <div className="modal-audit-callout purple-callout">
              <History size={16} />
              <span>Backdated attendance entries are permanently tagged with an audit badge and linked to your administrator session in reports and sync logs.</span>
            </div>

            <div className="modal-section-group">
              <label className="field-label" htmlFor="backdated-employee">
                Employee:
              </label>
              <select
                id="backdated-employee"
                className="select"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                required
              >
                {activeEmployees.map((emp) => (
                  <option key={emp.userId} value={emp.userId}>
                    {emp.fullName} ({emp.userId}){emp.department ? ` — ${emp.department}` : ""}
                  </option>
                ))}
              </select>
            </div>

            <div className="modal-section-group">
              <label className="field-label" htmlFor="backdated-date">
                Attendance Date (past date only):
              </label>
              <input
                id="backdated-date"
                type="date"
                className="input"
                max={yesterday}
                value={attendanceDate}
                onChange={(e) => setAttendanceDate(e.target.value)}
                required
              />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
              <div className="modal-section-group">
                <label className="field-label" htmlFor="backdated-time-in">
                  Time In
                </label>
                <input
                  id="backdated-time-in"
                  type="time"
                  className="input"
                  value={timeIn}
                  onChange={(e) => setTimeIn(e.target.value)}
                  required
                />
              </div>
              <div className="modal-section-group">
                <label className="field-label" htmlFor="backdated-time-out">
                  Time Out <span style={{ color: "var(--quiet)", fontWeight: 400 }}>(optional)</span>
                </label>
                <input
                  id="backdated-time-out"
                  type="time"
                  className="input"
                  value={timeOut}
                  onChange={(e) => setTimeOut(e.target.value)}
                />
              </div>
            </div>

            <div className="modal-section-group">
              <label className="field-label" htmlFor="backdated-reason">
                Reason (mandatory audit trail):
              </label>
              <textarea
                id="backdated-reason"
                className="input"
                placeholder="e.g. Employee forgot RFID card at home and reported in person to supervisor at 8:00 AM…"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="assisted-modal-footer">
            <button className="modal-btn-cancel" type="button" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              className="modal-btn-primary"
              type="submit"
              disabled={busy || !userId || !attendanceDate || !timeIn || !reason.trim()}
            >
              {busy ? (
                <>
                  <LoaderCircle className="spin" size={16} /> Saving…
                </>
              ) : (
                <>
                  <PlusCircle size={16} /> Add missed attendance
                </>
              )}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function exportAttendanceCsv(
  rows: AttendanceListItem[],
  arrivalMap: Map<string, { arrivalStatus: ArrivalStatus; minutesLate: number }>,
  clampedTimeInIds: Set<string>,
  startDate: string,
  endDate?: string,
):
  | {
      success: true;
      fileName: string;
      content: string;
      filePath: null;
      directoryPath: null;
    }
  | { success: false; message: string } {
  const fileName =
    endDate && endDate !== startDate
      ? `attendance-export-${startDate}-to-${endDate}.csv`
      : `attendance-export-${startDate}.csv`;
  const headers = [
    "Employee name",
    "Employee ID",
    "Department",
    "Date",
    "Time in",
    "Arrival",
    "Time out",
    "Status",
    "Total hours",
    "Source",
    "Recorded By",
    "Recorded Reason",
    "Recorded At",
    // Audit column appended last so every pre-existing column keeps its index.
    "Actual time-in",
  ];
  const csvCell = (value: string | number | null) =>
    `"${String(value ?? "").replace(/"/g, '""')}"`;
  const totalHours = (row: AttendanceListItem) => {
    if (!row.timeIn || !row.timeOut) return "";
    const hours =
      (new Date(row.timeOut).getTime() - new Date(row.timeIn).getTime()) /
      3_600_000;
    return Number.isFinite(hours) && hours >= 0
      ? Math.min(8, Math.round(hours)).toString()
      : "";
  };
  const getArrivalText = (row: AttendanceListItem) => {
    const info = arrivalMap.get(row.attendanceId);
    // Grace-period arrivals are left blank, matching the table.
    if (!info || info.arrivalStatus === "NONE" || info.arrivalStatus === "GRACE_PERIOD") return "";
    if (info.arrivalStatus === "ON_TIME") return "On time";
    return `Late (${info.minutesLate}m)`;
  };
  // Clamped rows export their hourly payable Manila time-in in the
  // Time in column (same ISO shape as every other row); the real scan keeps
  // its own audit column because a CSV cell cannot carry the table tooltip.
  const payableTimeIn = (row: AttendanceListItem) =>
    clampedTimeInIds.has(row.attendanceId) && row.timeIn
      ? clampedTimeInIso(row.timeIn)
      : row.timeIn;
  const content = [
    headers,
    ...rows.map((row) => [
      row.fullName,
      row.userId,
      row.department,
      row.attendanceDate,
      payableTimeIn(row),
      getArrivalText(row),
      row.timeOut,
      row.status,
      totalHours(row),
      row.source ?? "",
      row.recordedBy ?? "",
      row.recordedReason ?? "",
      row.recordedAt ?? "",
      row.timeIn,
    ]),
  ]
    .map((line) => line.map(csvCell).join(","))
    .join("\r\n");
  if (!rows.length)
    return {
      success: false,
      message: "No attendance matches the active filters; nothing was exported.",
    };
  const url = URL.createObjectURL(
    new Blob([`\ufeff${content}\r\n`], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return {
    success: true,
    fileName,
    content,
    filePath: null,
    directoryPath: null,
  };
}

/** Edited HH:MM becomes HH:MM:00+08:00; an unchanged HH:MM keeps the original stamp. */
export function keepOrBuildManilaIso(date: string, hhmm: string, original: string | null | undefined): string | null {
  if (!hhmm) return null;
  if (original && original.slice(11, 16) === hhmm) return original;
  return `${date}T${hhmm}:00+08:00`;
}

function AttendanceEditRow({
  row,
  draft,
  onDraftChange,
  onBusyChange,
  selected,
  onToggleSelect,
  arrivalInfo,
  timeInClamped,
  onSaved,
}: {
  row: AttendanceListItem;
  /** Present while the row is open for editing. */
  draft?: AttendanceDraft;
  /** Opens or updates the row's editor (a draft) or closes it (null). */
  onDraftChange: (draft: AttendanceDraft | null) => void;
  /** Reports while the row is saving or deleting, so the date can't change under it. */
  onBusyChange: (busy: boolean) => void;
  selected?: boolean;
  onToggleSelect?: () => void;
  arrivalInfo?: { arrivalStatus: ArrivalStatus; minutesLate: number };
  timeInClamped?: boolean;
  onSaved: () => void | Promise<void>;
}) {
  // A note that needs acting on stays on the row; a plain save or delete shows as a toast.
  const [message, setMessage] = useState<Notice | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteAttendanceConfirm, setDeleteAttendanceConfirm] = useState(false);
  const rowRef = useRef<HTMLTableRowElement>(null);
  const timeInInputRef = useRef<HTMLInputElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const editing = draft !== undefined;
  const unsaved = draft ? draftChanged(draft) : false;
  const notice = message ?? (draft?.changedOnServer ? RECORD_CHANGED_NOTICE : null);
  // Opening the editor moves focus to its time-in field. Closing it moves focus back to Edit: always after Cancel,
  // after a save only when focus is still in this row (or nowhere), never away from typing elsewhere.
  const moveFocus = useRef<"always" | "if-here" | null>(null);
  useEffect(() => {
    const mode = moveFocus.current;
    moveFocus.current = null;
    if (!mode) return;
    if (editing) {
      timeInInputRef.current?.focus();
      return;
    }
    const active = document.activeElement;
    if (mode === "always" || !active || active === document.body || rowRef.current?.contains(active)) editButtonRef.current?.focus();
  }, [editing]);
  const openEditor = () => {
    moveFocus.current = "always";
    onDraftChange(draftFor(row));
  };
  const closeEditor = (focus: "always" | "if-here") => {
    moveFocus.current = focus;
    onDraftChange(null);
  };

  const late = row.status === "LATE_TIMEOUT";
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    onBusyChange(true);
    try {
      // An untouched time keeps its exact stamp: rebuilding it as HH:MM:00 would drop
      // the seconds and can change late hours and grace use.
      const timeInIso = keepOrBuildManilaIso(row.attendanceDate, draft.timeIn, row.timeIn);
      const timeOutIso = keepOrBuildManilaIso(row.attendanceDate, draft.timeOut, row.timeOut);
      const response = await saveAdminAttendance(row.attendanceId, {
        attendanceDate: row.attendanceDate,
        timeIn: timeInIso,
        timeOut: timeOutIso,
        expectedTimeIn: row.timeIn || null,
        expectedTimeOut: row.timeOut || null,
      });
      if (response.success) {
        if (timeOutIso && isLateTimeout(timeOutIso)) {
          setMessage({ tone: "info", text: "Saved — time-out is still after office hours, correction remains required." });
        } else {
          setMessage(null);
          showToast(`Saved ${row.fullName}'s times.`);
        }
        // Back to read-only once the list shows the new times.
        await onSaved();
        closeEditor("if-here");
      } else {
        setMessage({ tone: "error", text: response.error?.message ?? "Unable to save attendance." });
        // A stale row cannot be saved again as-is; reload it so the admin sees the current times.
        if (response.error?.code === "ATTENDANCE_CONFLICT" || response.error?.code === "ATTENDANCE_NOT_FOUND") await onSaved();
      }
    } finally {
      setSaving(false);
      onBusyChange(false);
    }
  };
  const remove = async () => {
    setDeleteAttendanceConfirm(false);
    setDeleting(true);
    onBusyChange(true);
    try {
      const response = await deleteAdminAttendance(
        row.attendanceId,
        row.attendanceDate,
      );
      if (response.success) {
        showResult({ tone: "success", text: `Deleted ${row.fullName}'s record.` }, setMessage);
        await onSaved();
      } else {
        setMessage({ tone: "error", text: response.error?.message ?? "Unable to delete record." });
      }
    } finally {
      setDeleting(false);
      onBusyChange(false);
    }
  };

  const renderArrival = () => {
    // Grace-period arrivals show no label in the table; payroll still treats them as grace-period days.
    if (
      !arrivalInfo ||
      arrivalInfo.arrivalStatus === "NONE" ||
      arrivalInfo.arrivalStatus === "GRACE_PERIOD"
    ) {
      return <span className="arrival-badge badge-none">—</span>;
    }
    if (arrivalInfo.arrivalStatus === "ON_TIME") {
      return <span className="arrival-badge badge-ontime">On time</span>;
    }
    return (
      <span
        className="arrival-badge badge-late"
        title={`Late arrival (${arrivalInfo.minutesLate} minutes)`}
      >
        Late {formatLateMinutes(arrivalInfo.minutesLate)}
      </span>
    );
  };

  /** The editor's time field with its clear button. */
  const timeField = (which: "in" | "out") => {
    if (!draft) return null;
    const value = which === "in" ? draft.timeIn : draft.timeOut;
    // Typing again answers the "record changed" note.
    const setValue = (next: string) =>
      onDraftChange(which === "in" ? { ...draft, timeIn: next, changedOnServer: false } : { ...draft, timeOut: next, changedOnServer: false });
    const label = `time ${which}`;
    return (
      <div className="time-input-group">
        <input
          ref={which === "in" ? timeInInputRef : undefined}
          aria-label={`Time ${which} for ${row.fullName}`}
          type="time"
          value={value}
          disabled={saving}
          onChange={(e) => setValue(e.target.value)}
        />
        {value && !saving ? (
          <button
            type="button"
            className="time-clear-btn"
            title={`Clear ${label}`}
            aria-label={`Clear ${label} for ${row.fullName}`}
            onMouseDown={(e) => {
              e.preventDefault();
              setValue("");
            }}
            onClick={(e) => {
              e.preventDefault();
              setValue("");
            }}
          >
            <X size={13} />
          </button>
        ) : null}
      </div>
    );
  };

  return (
    <>
      {late && (
        <tr className="admin-attention-row">
          <td colSpan={7} className="admin-attention">
            <strong>Late time-out — manual correction required.</strong> This
            time-out was recorded after office hours (
            {formatTime(`${row.attendanceDate}T${LATE_TIMEOUT_THRESHOLD}:00+08:00`)}); the
            office does not allow overtime. Edit the time-out below to complete the shift.
          </td>
        </tr>
      )}
      <tr ref={rowRef} className={`attendance-row${selected ? " selected-row" : ""}${editing ? " is-open" : ""}${unsaved ? " is-unsaved" : ""}`}>
        <td className="table-select-cell">
          {onToggleSelect && (
            <input
              type="checkbox"
              checked={Boolean(selected)}
              onChange={onToggleSelect}
              aria-label={`Select attendance for ${row.fullName}`}
            />
          )}
        </td>
        <td>
          <strong>{row.fullName}</strong>
          <small>{row.userId}</small>
          {row.source === "ADMIN_ASSISTED_SCAN" && (
            <span
              className="badge badge-assisted"
              title={`Kiosk scan assisted by: ${row.recordedBy || "Admin"}${row.recordedReason ? ` (${row.recordedReason})` : ""}`}
              style={{ display: "inline-flex", marginTop: 4 }}
            >
              <UserCheck size={11} /> Assisted by {row.recordedBy || "Admin"}
            </span>
          )}
          {row.source === "ADMIN_BACKDATED_ENTRY" && (
            <span
              className="badge badge-backdated"
              title={`Backdated manual entry by: ${row.recordedBy || "Admin"}${row.recordedReason ? ` — Reason: ${row.recordedReason}` : ""}`}
              style={{ display: "inline-flex", marginTop: 4 }}
            >
              <History size={11} /> Backdated entry by {row.recordedBy || "Admin"}{row.recordedReason ? ` — ${row.recordedReason}` : ""}
            </span>
          )}
          {unsaved && <span className="unsaved-tag">Unsaved</span>}
        </td>
        <td>
          {editing ? (
            timeField("in")
          ) : timeInClamped && row.timeIn ? (
            // The payable (clamped) time; the actual scan is in the tooltip, and a click opens it for editing.
            <button
              type="button"
              className="clamped-time-in-chip clamped-time-in-static"
              data-testid="clamped-time-in"
              title={`Actual scan: ${formatTime(row.timeIn, ATTENDANCE_TIMEZONE)} (payable time clamped)`}
              aria-label={`Shown as ${clampedTimeLabel(row.timeIn)} for ${row.fullName}; actual scan ${formatTime(row.timeIn, ATTENDANCE_TIMEZONE)}. Click to edit.`}
              onClick={openEditor}
            >
              {clampedTimeLabel(row.timeIn)}
            </button>
          ) : row.timeIn ? (
            formatTime(row.timeIn)
          ) : (
            "—"
          )}
        </td>
        <td>{renderArrival()}</td>
        <td>{editing ? timeField("out") : row.timeOut ? formatTime(row.timeOut) : "—"}</td>
        <td>
          <span className={`status-pill status-${row.status.toLowerCase()}`}>
            {late ? "LATE TIMEOUT" : row.status}
          </span>
        </td>
        <td className="attendance-row-actions">
          {editing ? (
            <>
              <button className="attendance-save-button" type="button" disabled={saving} onClick={() => void save()}>
                {saving ? "Saving…" : "Save"}
              </button>
              <button
                className="text-button"
                type="button"
                disabled={saving}
                onClick={() => {
                  setMessage(null);
                  closeEditor("always");
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                ref={editButtonRef}
                className="text-button"
                type="button"
                aria-label={`Edit times for ${row.fullName}`}
                disabled={deleting}
                onClick={openEditor}
              >
                Edit
              </button>
              <button
                className="text-button danger-button"
                type="button"
                aria-label={`Delete ${row.fullName}'s record`}
                disabled={deleting}
                onClick={() => setDeleteAttendanceConfirm(true)}
              >
                {deleting ? "Deleting..." : "Delete"}
              </button>
            </>
          )}
        </td>
      </tr>
      {/* A note for this record (a save problem, the late time-out reminder) on its own full-width line under it. */}
      {notice && (
        <tr className="attendance-row-note">
          <td colSpan={7}>
            <NoticeLine notice={notice} className="row-message" />
          </td>
        </tr>
      )}
      {deleteAttendanceConfirm && (
        <tr>
          <td colSpan={7} style={{ padding: 0 }}>
            <ConfirmDialog
              open={true}
              busy={deleting}
              tone="danger"
              title="Delete attendance record?"
              message={`This will permanently delete ${row.fullName}'s time-in/time-out record for ${formatDate(row.attendanceDate)}. This cannot be undone.`}
              confirmLabel="Delete record"
              onCancel={() => setDeleteAttendanceConfirm(false)}
              onConfirm={() => void remove()}
            />
          </td>
        </tr>
      )}
    </>
  );
}
