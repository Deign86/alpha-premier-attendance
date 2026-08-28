import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  CalendarPlus,
  Check,
  CircleAlert,
  Clock,
  CreditCard,
  Download,
  History,
  ImagePlus,
  Keyboard,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Nfc,
  Plus,
  PlusCircle,
  Search,
  ShieldAlert,
  ShieldCheck,
  Upload,
  UserCheck,
  UserRound,
  X,
} from "lucide-react";
import type {
  ScanErrorResponse,
  ScanSuccessResponse,
  ScanAdminAssistResponse,
  CardType,
  SetupUser,
  UserGender,
  AttendanceListItem,
  PayrollCalculationProfile,
  PayrollCutoffRecord,
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
  OFFICE_HOURS_END,
  isLateTimeout,
  normalizeName,
  evaluateArrivalFromTimestamp,
  evaluateAttendanceArrivals,
  countWorkdays,
} from "@rfid-attendance/shared";
import {
  DEFAULT_CONFIG,
  checkAdminSession,
  createDatabaseBackup,
  deletePayrollCutoff,
  deleteAdminAttendance,
  deleteAdminUser,
  finalizePayrollCutoff,
  getLanStatus,
  loadAttendance,
  loadAdminAttendance,
  loadAdminUsers,
  loadConfig,
  loadDatabaseInfo,
  loadPayrollCutoffs,
  loadPayrollProfiles,
  lockAdmin,
  lockSetup,
  lookupSetupCard,
  nukeSheetsResync,
  openDatabaseBackupsFolder,
  openViewerUrl,
  photoSource,
  requestDatabaseRestore,
  saveAdminAttendance,
  saveAdminUser,
  savePayrollCutoff,
  generatePayrollCutoff,
  generatePayrollPdf,
  loadPayrollPdfs,
  openGeneratedFile,
  revealGeneratedFile,
  startLanViewer,
  stopLanViewer,
  submitScan,
  unlockAdmin,
  unlockSetup,
  uploadSetupPhoto,
  upsertSetupUser,
  createAdminBackdatedAttendance,
  loadBathroomStatus,
  submitBathroomScan,
} from "./api";
import { sseUrl, onNetworkStatusChange, getOfflineQueue, removeQueuedScan, isOnline } from "./network";
import type { FileActionResult } from "./api";
import "./styles.css";
import { BathroomKioskView } from "./bathroom-kiosk-view";
import type { BathroomScanResponse, BathroomStatusResponse } from "@rfid-attendance/shared";
import {
  listenForGlobalRfid,
  listenForScannerStatus,
  listenForAttendanceUpdates,
  getScannerStatus,
  setScannerPaused,
  notifyScanSuccess,
} from "./tauri-api";

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
} from "./services/ttsService";
import { VoiceSettingsPanel } from "./voice-settings-panel";
import { pickRestoreBackupFile } from "./api";
import { UpdateBanner } from "./update-banner";
import { AdminUpdatesCard } from "./admin-updates-card";
import { BathroomKeyLogPanel } from "./bathroom-key-log";
import logoPhoenix from "./assets/branding/logo-phoenix.png";

function toErrorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error) return cause.message;
  if (cause && Object.prototype.toString.call(cause) === "[object String]") {
    // SAFETY: Verified cause is string primitive
    return cause as string;
  }
  return fallback;
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
  const [state, setState] = useState<KioskState>("ready");
  const [uid, setUid] = useState("");
  const [manualMode, setManualMode] = useState(false);
  const [manualUid, setManualUid] = useState("");
  const [result, setResult] = useState<Result | null>(null);
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
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestController = useRef<AbortController | null>(null);
  const recentScans = useRef(new Map<string, number>());
  // Synchronous in-flight guard: set before the first await so two rapid native
  // scan events can never start two attendance writes for the same tap.
  const processingRef = useRef(false);
  const scanInFlightRef = useRef(false);

  const [setupToken, setSetupToken] = useState("");
  const [setupExpiresAt, setSetupExpiresAt] = useState("");
  const [setupDialogOpen, setSetupDialogOpen] = useState(false);
  const [setupStep, setSetupStep] = useState<SetupStep>("scan");
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupError, setSetupError] = useState("");
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
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (kioskMode !== "bathroom") return;
    void fetchBathroomStatus();
    const timer = window.setInterval(fetchBathroomStatus, 5_000);
    return () => window.clearInterval(timer);
  }, [kioskMode, fetchBathroomStatus]);

  useEffect(() => {
    const controller = new AbortController();
    void loadConfig(controller.signal).then(setConfig);
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
      setSetupError("Setup session expired. Unlock again to continue.");
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
    processingRef.current = false;
    setState("ready");
    setResult(null);
    setUid("");
    setManualUid("");
  }, []);

  const openSetup = useCallback(
    (initialUid = "") => {
      setSetupDialogOpen(true);
      setSetupError("");
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
      setSetupError("");
      const response = await unlockSetup(candidate);
      setSetupBusy(false);
      if (!response.success) {
        setSetupError(response.error.message);
        return;
      }
      setSetupToken(response.setupToken);
      setSetupExpiresAt(response.expiresAt);
      setAdminPin("");
      setSetupStep("scan");
      setSetupDialogOpen(true);
      window.setTimeout(focusSetupInput, 0);
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
    setSetupError("");
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
    setSetupError("Setup session expired. Unlock again to continue.");
    return true;
  }, [setupToken, setupExpiresAt]);

  const lookupCardForSetup = useCallback(
    async (rawUid: string) => {
      const normalizedUid = rawUid.trim();
      if (!normalizedUid || !setupToken || setupBusy) return;
      if (setupSessionExpired()) return;
      if (setupIdleTimer.current) clearTimeout(setupIdleTimer.current);
      setSetupBusy(true);
      setSetupError("");
      const response = await lookupSetupCard(normalizedUid, setupToken);
      setSetupBusy(false);
      if (!response.success) {
        setSetupError(response.error.message);
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
    setSetupError("");
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
        employeeType: isAssist ? "EMPLOYEE" : setupForm.employeeType,
        gender: isAssist ? null : (setupForm.gender || null),
        dailyRate:
          !isAssist && setupForm.employeeType === "EMPLOYEE"
            ? Number(setupForm.dailyRate)
            : null,
        photoUrl: isAssist ? null : (setupForm.photoUrl || null),
        cardType: setupForm.cardType,
        label: setupForm.label.trim() || undefined,
      },
      setupToken,
    );
    setSetupBusy(false);
    if (!response.success) {
      setSetupError(response.error.message);
      return;
    }
    if (setupSessionExpired()) return;
    setSetupUser(response.user);
    setSetupError(
      response.created
        ? "Card enrolled successfully."
        : "Card configuration updated successfully.",
    );
    setSetupStep("scan");
    setSetupUid("");
    setSetupForm(emptySetupForm);
    window.setTimeout(focusSetupInput, 0);
  };

  const uploadSetupPhotoFile = async (file: File) => {
    if (!setupToken || !setupForm.userId.trim()) {
      setSetupError("Enter the User ID before uploading a photo.");
      return;
    }
    if (setupSessionExpired()) return;
    const isImage =
      ["image/jpeg", "image/png", "image/webp", "image/jpg"].includes(
        file.type.toLowerCase(),
      ) || /\.(jpe?g|png|webp)$/i.test(file.name);
    if (!isImage) {
      setSetupError("Choose a JPEG, PNG, or WebP photo.");
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setSetupError("Photo file must be under 25 MB.");
      return;
    }
    setSetupBusy(true);
    setSetupError("Preparing photo…");
    let dataUrl: string;
    try {
      dataUrl = await preparePhotoDataUrl(file);
    } catch (error) {
      setSetupBusy(false);
      setSetupError(
        error instanceof Error
          ? error.message
          : "Unable to prepare this photo.",
      );
      return;
    }
    setSetupError("Uploading photo…");
    const response = await uploadSetupPhoto(
      setupForm.userId.trim().toUpperCase(),
      dataUrl,
      setupToken,
    );
    setSetupBusy(false);
    if (!response.success) {
      setSetupError(response.error.message);
      return;
    }
    setSetupForm((current) => ({ ...current, photoUrl: response.photoUrl }));
    setSetupError("Photo uploaded and ready to save.");
  };

  const submit = useCallback(
    async (rawUid: string, source: "RFID" | "MANUAL_TEST") => {
      const normalizedUid = rawUid.trim();
      if (!normalizedUid || processingRef.current) return;
      // The read-only scanner box and the native pipeline both capture the same
      // card tap in the desktop app; drop the second copy so one tap never posts
      // twice (which the backend would reject as a duplicate scan).
      const now = Date.now();
      const previousScanAt = recentScans.current.get(normalizedUid);
      if (
        previousScanAt !== undefined &&
        now - previousScanAt < SCAN_DEDUP_WINDOW_MS
      )
        return;
      recentScans.current.set(normalizedUid, now);
      if (recentScans.current.size > 128) {
        for (const [key, at] of recentScans.current) {
          if (now - at >= SCAN_DEDUP_WINDOW_MS) recentScans.current.delete(key);
        }
      }
      if (scanInFlightRef.current) return;
      scanInFlightRef.current = true;
      processingRef.current = true;
      setUid(normalizedUid);
      setState("processing");
      setResult(null);
      requestController.current?.abort();
      const controller = new AbortController();
      requestController.current = controller;
      const response = await submitScan(
        { rfidUid: normalizedUid, source },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      requestController.current = null;
      scanInFlightRef.current = false;
      processingRef.current = false;
      setTimeout(() => {
        scanInFlightRef.current = false;
      }, 300);
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
          ? evaluateArrivalFromTimestamp(response.attendance.timeIn, config.timezone)
          : undefined;
        void announceAttendance({
          employeeName: response.user.fullName,
          attendanceType: response.action === "TIME_IN" ? "time_in" : "time_out",
          arrivalStatus: arrival,
          isLateTimeout: isLate,
          isAssisted: response.attendance.source === "ADMIN_ASSISTED_SCAN",
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
    if (!adminAssistData) return;
    setAssistedBusy(true);
    setAssistedError("");
    try {
      const response = await submitScan({
        rfidUid: adminAssistData.adminCard.rfidUid,
        source: "ADMIN_ASSISTED_SCAN",
        targetUserId,
        reason,
      });
      setAssistedBusy(false);
      if (response.success && "attendance" in response) {
        setAdminAssistData(null);
        setResult(response);
        setState("success");
        if (document.visibilityState === "hidden" || !document.hasFocus()) void notifyScanSuccess(response.user.fullName).catch(() => undefined);
        const isLate = response.attendance.status === "LATE_TIMEOUT" || (response.attendance.timeOut ? isLateTimeout(response.attendance.timeOut) : false);
        const arrival = response.action === "TIME_IN" && response.attendance.timeIn
          ? evaluateArrivalFromTimestamp(response.attendance.timeIn, config.timezone)
          : undefined;
        void announceAttendance({
          employeeName: response.user.fullName,
          attendanceType: response.action === "TIME_IN" ? "time_in" : "time_out",
          arrivalStatus: arrival,
          isLateTimeout: isLate,
          isAssisted: true,
          timeInIso: response.attendance.timeIn,
        });
        if (resetTimer.current) clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(resetToReady, config.resultResetDelayMs);
      } else if (!response.success) {
        setAssistedError(response.error.message);
        void announceScanError({
          errorCode: response.error.code,
          message: response.error.message,
        });
      }
    } catch {
      setAssistedBusy(false);
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
      const normalizedUid = rawUid.trim();
      if (!normalizedUid || processingRef.current) return;

      const nowTime = Date.now();
      const previousScanAt = recentScans.current.get(normalizedUid);
      if (
        previousScanAt !== undefined &&
        nowTime - previousScanAt < SCAN_DEDUP_WINDOW_MS
      ) {
        return;
      }
      recentScans.current.set(normalizedUid, nowTime);

      processingRef.current = true;
      setUid(normalizedUid);
      setState("processing");
      setBathroomScanResult(null);

      requestController.current?.abort();
      const controller = new AbortController();
      requestController.current = controller;

      try {
        const response = await submitBathroomScan(
          { rfidUid: normalizedUid, source },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        requestController.current = null;
        processingRef.current = false;

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
          });
        } else {
          void announceScanError({
            errorCode: response.error.code,
            message: response.error.message,
            activeHolderName: response.activeHolder?.fullName,
            genderKey: response.genderKey,
          });
        }

        void fetchBathroomStatus();

        if (bathroomResetTimer.current) clearTimeout(bathroomResetTimer.current);
        bathroomResetTimer.current = setTimeout(() => {
          setBathroomScanResult(null);
          setState("ready");
        }, config.resultResetDelayMs);
      } catch {
        processingRef.current = false;
        setState("error");
        void announceScanError({
          errorCode: "SERVICE_ERROR",
          message: "Bathroom service is temporarily unavailable.",
        });
      }
    },
    [config.resultResetDelayMs, fetchBathroomStatus],
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
      const expectedLength = Number(config.scanner?.expectedLength ?? 10);
      const characterSet = config.scanner?.characterSet ?? "decimal";
      const allowedRegex = characterSet === "hex" ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/;

      if (!allowedRegex.test(candidate)) return;
      if (candidate.length < 4 || candidate.length > 64) return;
      if (expectedLength > 0 && candidate.length !== expectedLength) return;

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
      if (isTextEntry || manualMode || adminAssistData || (setupDialogOpen && setupToken && !shouldRouteGlobalRfidToSetup(setupDialogOpen, setupToken, setupStep))) {
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
      resetBuffer();
    };
  }, [adminAssistData, config, handleSetupInput, kioskMode, manualMode, setupDialogOpen, setupStep, setupToken, submit, submitBathroom, unlockSetupWithPinOrCard]);

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
  const displayTime = new Intl.DateTimeFormat("en-PH", {
    timeZone: config.timezone,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(now);

  const success = result?.success ? result : null;
  const error = result && !result.success ? result : null;

  // Scanner readiness for the compact status pill. Falls back to a neutral
  // state when the native layer is unavailable (browser dev mode).
  const scannerPill = (() => {
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
    <main className={`kiosk-shell state-${state}`}>
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

        <div className="kiosk-mode-switcher" role="tablist" aria-label="Kiosk scanning mode">
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
          <span
            className={`scanner-pill is-${scannerPill.state}`}
            role="status"
            title={scannerPill.detail}
          >
            <i aria-hidden="true" />
            {scannerPill.label}
          </span>
          <div
            className="clock"
            aria-label={`Current time in ${config.timezone}`}
          >
            <span>{displayDate}</span>
            <strong>{displayTime}</strong>
          </div>
        </div>
      </header>

      <section className="kiosk-stage" aria-labelledby="kiosk-heading">
        {/* ATTENDANCE SCAN SUCCESS */}
        {kioskMode === "attendance" && state === "success" && success && (
          <div
            className="kiosk-result is-success"
            role="status"
            aria-live="polite"
          >
            {success.user.photoUrl ? (
              <img
                className="result-photo result-photo-full"
                src={photoSource(success.user.photoUrl)}
                alt={`${success.user.fullName} ID`}
              />
            ) : (
              <div
                className="result-photo result-photo-fallback"
                aria-label="ID photo unavailable"
              >
                <UserRound size={72} />
              </div>
            )}
            <h2 className="result-name">{success.user.fullName}</h2>
            <p className="result-message">{success.message}</p>
            <p className="result-user-id">
              {success.user.userId}
              {success.user.department ? ` · ${success.user.department}` : ""}
            </p>
            <div className="result-meta">
              <span
                className={`employee-badge${success.user.employeeType === "INTERN" ? " intern-badge" : ""}`}
              >
                {success.user.employeeType}
              </span>
              {success.attendance.source === "ADMIN_ASSISTED_SCAN" && (
                <span className="badge badge-assisted">
                  Assisted by {success.attendance.recordedBy || "Admin"}
                </span>
              )}
              <span>{formatAction(success.action)}</span>
              <span>
                {formatTime(
                  success.attendance.timeOut ?? success.attendance.timeIn,
                  config.timezone,
                )}
              </span>
            </div>
          </div>
        )}

        {/* BATHROOM SCAN SUCCESS */}
        {kioskMode === "bathroom" && state === "success" && bathroomScanResult?.success && (
          <div
            className="kiosk-result is-success"
            role="status"
            aria-live="polite"
          >
            {bathroomScanResult.user.photoUrl ? (
              <img
                className="result-photo result-photo-full"
                src={photoSource(bathroomScanResult.user.photoUrl)}
                alt={`${bathroomScanResult.user.fullName} ID`}
              />
            ) : (
              <div
                className="result-photo result-photo-fallback"
                aria-label="ID photo unavailable"
              >
                <UserRound size={72} />
              </div>
            )}
            <h2 className="result-name">{bathroomScanResult.user.fullName}</h2>
            <p className="result-message">
              {bathroomScanResult.action === "CHECKOUT"
                ? `${bathroomScanResult.genderKey === "MALE" ? "Male" : "Female"} floor key checked out`
                : `${bathroomScanResult.genderKey === "MALE" ? "Male" : "Female"} floor key returned`}
            </p>
            <p className="result-user-id">
              {bathroomScanResult.user.userId}
              {bathroomScanResult.user.department ? ` · ${bathroomScanResult.user.department}` : ""}
            </p>
            <div className="result-meta">
              <span className={`key-badge ${bathroomScanResult.genderKey.toLowerCase()}`}>
                {bathroomScanResult.genderKey} KEY
              </span>
              <span>{bathroomScanResult.action}</span>
              <span>
                {formatTime(
                  bathroomScanResult.timeOut ?? bathroomScanResult.timeIn ?? bathroomScanResult.timestamp,
                  config.timezone,
                )}
              </span>
              {bathroomScanResult.durationSeconds !== null && bathroomScanResult.durationSeconds !== undefined && (
                <span className="badge badge-duration">
                  Duration: {Math.max(1, Math.round(bathroomScanResult.durationSeconds / 60))}m
                </span>
              )}
            </div>
          </div>
        )}

        {/* ATTENDANCE SCAN ERROR */}
        {kioskMode === "attendance" && state === "error" && error && (
          <div
            className="kiosk-result is-error"
            role="alert"
            aria-live="assertive"
          >
            <CircleAlert
              className="result-error-icon"
              size={42}
              aria-hidden="true"
            />
            <h2 className="result-name">{error.error.message}</h2>
            <p className="error-code">
              {error.error.code.replaceAll("_", " ")}
            </p>
            {error.error.code === "UNKNOWN_RFID_CARD" &&
              config.enableCardSetup && (
                <button
                  className="setup-card-button"
                  type="button"
                  onClick={() => openSetup(uid)}
                >
                  <ShieldCheck size={17} /> Setup this card
                </button>
              )}
          </div>
        )}

        {/* BATHROOM SCAN ERROR */}
        {kioskMode === "bathroom" && state === "error" && bathroomScanResult && !bathroomScanResult.success && (
          <div
            className="kiosk-result is-error"
            role="alert"
            aria-live="assertive"
          >
            <CircleAlert
              className="result-error-icon"
              size={42}
              aria-hidden="true"
            />
            <h2 className="result-name">{bathroomScanResult.error.message}</h2>
            <p className="error-code">
              {bathroomScanResult.error.code.replaceAll("_", " ")}
            </p>
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

        {/* DYNAMIC BATHROOM STATUS & HISTORY (ALWAYS VISIBLE IN MODE 2) */}
        {kioskMode === "bathroom" && (
          <BathroomKioskView
            status={bathroomStatus}
            timezone={config.timezone}
            nowMs={now.getTime()}
          />
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
            </div>
            <div className="input-row">
              {!manualMode && (
                <span className="scan-input-icon" aria-hidden="true">
                  <Nfc size={22} />
                </span>
              )}
              <input
                id="scanner-uid"
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
                <>
                  <span className="scan-live">
                    <i aria-hidden="true" />
                    Locked
                  </span>{" "}
                  — tap your card, or use Manual entry to type an ID
                </>
              )}
            </p>
          </div>
        )}

        {(state === "success" || state === "error") && (
          <p className="reset-hint">
            Returning to ready mode in a few seconds…
          </p>
        )}
      </section>

      <footer className="kiosk-actions">
        <button
          className="kiosk-action"
          type="button"
          onClick={toggleManualMode}
          disabled={state !== "ready"}
          aria-pressed={manualMode}
        >
          {manualMode ? <CreditCard size={16} /> : <Keyboard size={16} />}
          {manualMode ? "Use card reader" : "Manual entry"}
        </button>
        <a className="kiosk-action" href="/attendance">
          Live attendance
        </a>
        {config.enableAdmin && (
          <a className="kiosk-action" href="/admin">
            Admin
          </a>
        )}
        {config.enableCardSetup && (
          <button
            className="kiosk-action"
            type="button"
            onClick={() => openSetup()}
          >
            <LockKeyhole size={15} /> Admin setup
          </button>
        )}
      </footer>

      {setupDialogOpen && (
        <SetupDialog
          token={setupToken}
          step={setupStep}
          busy={setupBusy}
          error={setupError}
          pin={adminPin}
          uid={setupUid}
          user={setupUser}
          form={setupForm}
          inputRef={setupInputRef}
          onPinChange={setAdminPin}
          onUnlock={handleUnlock}
          onUidChange={handleSetupInput}
          onScanAnother={() => {
            setSetupStep("scan");
            setSetupUid("");
            setSetupUser(null);
            setSetupError("");
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

type SetupDialogProps = {
  token: string;
  step: SetupStep;
  busy: boolean;
  error: string;
  pin: string;
  uid: string;
  user: SetupUser | null;
  form: SetupForm;
  inputRef: React.Ref<HTMLInputElement>;
  onPinChange: (value: string) => void;
  onUnlock: (event: React.FormEvent) => void;
  onUidChange: (value: string) => void;
  onScanAnother: () => void;
  onUidEnter: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onFormChange: (field: keyof SetupForm, value: string) => void;
  onPhotoFile: (file: File) => void;
  onUpsert: (event: React.FormEvent) => void;
  onClose: () => void;
};

function SetupDialog(props: SetupDialogProps) {
  const [isDraggingPhoto, setIsDraggingPhoto] = useState(false);
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        props.onClose();
      }
    };
    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = "copy";
      }
    };
    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("drop", handleDrop);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("drop", handleDrop);
    };
  }, [props.onClose]);

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
        className="setup-dialog"
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
        {!props.token ? (
          <form className="setup-form" onSubmit={props.onUnlock}>
            <div className="setup-steps" aria-label="Card association steps">
              <span className="is-active">01 Unlock</span>
              <span>02 Scan card</span>
              <span>03 Save user</span>
            </div>
            <p className="setup-copy">
              Scan registered admin RFID card or enter administrator PIN to associate a card with an employee.
              Example: Deign Lazaro, IT / Admin.
            </p>
            <label htmlFor="admin-pin">Administrator PIN or Admin RFID card</label>
            <input
              id="admin-pin"
              type="password"
              placeholder="Enter PIN or scan admin card…"
              autoComplete="off"
              value={props.pin}
              onChange={(event) => props.onPinChange(event.target.value)}
              autoFocus
            />
            {props.error && (
              <p className="setup-error" role="alert">
                {props.error}
              </p>
            )}
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
          </form>
        ) : props.step === "scan" ? (
          <div className="setup-form">
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
            {props.error && (
              <p
                className={
                  props.error.includes("successfully")
                    ? "setup-success"
                    : "setup-error"
                }
                role="status"
              >
                {props.error}
              </p>
            )}
            <div className="setup-footer">
              <span>
                <UserRound size={15} />{" "}
                {props.user ? "Existing user" : "New card enrollment"}
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
          <form className="setup-form" onSubmit={props.onUpsert}>
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
                  Employee card
                </label>
                <label className={`segment-option ${props.form.cardType === "ADMIN_ASSIST" ? "is-selected" : ""}`}>
                  <input
                    type="radio"
                    name="cardType"
                    value="ADMIN_ASSIST"
                    checked={props.form.cardType === "ADMIN_ASSIST"}
                    onChange={() => props.onFormChange("cardType", "ADMIN_ASSIST")}
                  />
                  Admin RFID card
                </label>
              </div>
            </div>
            {props.form.cardType === "ADMIN_ASSIST" ? (
              <div className="setup-fields">
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
                    autoFocus
                  />
                </label>
                <p className="field-hint">
                  Admin RFID cards are used to time-in or time-out employees who physically showed up but forgot their card. Admin cards cannot record attendance for themselves.
                </p>
              </div>
            ) : (
              <div className="setup-fields">
                <label>
                  <span className="field-label">User ID</span>
                  <input
                    value={props.form.userId}
                    onChange={(event) =>
                      props.onFormChange("userId", event.target.value.toUpperCase())
                    }
                    onBlur={() =>
                      props.onFormChange("userId", props.form.userId.trim().toUpperCase())
                    }
                    autoComplete="off"
                    required
                    autoFocus
                  />
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
                  <span className="field-label">Employee type</span>
                  <select
                    value={props.form.employeeType}
                    onChange={(event) =>
                      props.onFormChange(
                        "employeeType",
                        event.target.value === "EMPLOYEE"
                          ? "EMPLOYEE"
                          : "INTERN",
                      )
                    }
                  >
                    <option value="INTERN">Intern</option>
                    <option value="EMPLOYEE">Regular Employee</option>
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
                {props.form.employeeType === "EMPLOYEE" && (
                  <label>
                    <span className="field-label">Daily rate (PHP)</span>
                    <input
                      type="number"
                      min="1"
                      step="0.01"
                      placeholder="e.g. 610.00"
                      value={props.form.dailyRate}
                      onChange={(event) =>
                        props.onFormChange("dailyRate", event.target.value)
                      }
                      required
                    />
                  </label>
                )}
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
            {props.error && (
              <p
                className={
                  props.error.includes("successfully")
                    ? "setup-success"
                    : "setup-error"
                }
                role="status"
              >
                {props.error}
              </p>
            )}
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
                      !props.form.fullName.trim() ||
                      (props.form.employeeType === "EMPLOYEE" &&
                        Number(props.form.dailyRate) <= 0)))
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
  }, [onClose]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

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
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
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
              />
            </div>
            <div className="employee-picker-list" role="listbox" aria-label="Active employees">
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
                      role="option"
                      aria-selected={isSelected}
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

function formatTime(value: string, timezone: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

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

function LiveAttendance() {
  useScannerPause(true);
  const office = useOfficeIdentity();
  const [rows, setRows] = useState<AttendanceListItem[]>([]);
  const [stale, setStale] = useState(false);
  const [fetchedAt, setFetchedAt] = useState("");
  const [error, setError] = useState("");
  const [lan, setLan] = useState<LanStatusResponse | null>(null);
  const [lanBusy, setLanBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const response = await loadAttendance();
      if (response.success) {
        setRows(response.attendance);
        setFetchedAt(response.fetchedAt);
        setStale(false);
        setError("");
      } else throw new Error("Unable to load attendance");
    } catch {
      setStale(true);
      setError("Live attendance is temporarily unavailable.");
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
  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <div>
          <DashboardBrand />
          <p className="section-kicker">Live attendance</p>
          <h1>Today’s timing</h1>
          <p className="section-description">
            {resolveOfficeDisplay(office, "short")} · {localDate()} · Realtime Live Updates
          </p>
        </div>
        <nav>
          <a href="/">Scanner</a>
          <a href="/admin">Admin</a>
        </nav>
      </header>
      {error && <p className="dashboard-alert">{error}</p>}
      <div className="dashboard-status">
        {stale
          ? "Showing last successful update"
          : `Last updated ${fetchedAt ? formatTime(fetchedAt, "Asia/Manila") : "just now"}`}
      </div>
      <LanViewerPanel
        status={lan}
        busy={lanBusy}
        onStart={() => void startNow()}
        onStop={() => void stopNow()}
        onRefresh={() => void refreshLan()}
      />
      <AttendanceTable rows={rows} timezone="Asia/Manila" />
    </main>
  );
}

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
  const stateLabel = {
    starting: "Starting",
    running: "Running",
    stopped: "Stopped",
    disabled: "Disabled",
    error: "Needs attention",
  } satisfies Record<LanStatusResponse["state"], string>;
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
          {stateLabel[status.state]}
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
            {status.state === "disabled"
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

/** Read-only scanner diagnostics for the admin panel: status and focus guidance. */
export function ScannerDiagnostics() {
  const [status, setStatus] = useState<ScannerStatus | null>(null);
  const [lastActivity, setLastActivity] = useState<string | null>(null);

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

  if (!status)
    return (
      <div className="scanner-diag" role="status" aria-live="polite">
        <LoaderCircle className="spin" size={15} /> Checking sensor connection...
      </div>
    );

  const stateLabel = {
    connected: "Waiting for card",
    scanning: "Scan received",
    offline: "Scanner unavailable",
    error: "Scan error",
  } satisfies Record<ScannerStatus["state"], string>;

  return (
    <div className="scanner-diag" role="status">
      <span className={`scanner-diag-state is-${status.state}`}>
        <i aria-hidden="true" />
        {status.paused
          ? "Paused — this screen is typing"
          : stateLabel[status.state]}
      </span>
      <span className="scanner-diag-mode">Reader: Keyboard-mode RFID reader</span>
      <span className="scanner-diag-activity">
        Last activity: {lastActivity ? formatTime(lastActivity, "Asia/Manila") : "Not yet recorded"}
      </span>
      <span className="scanner-diag-detail">Keep the attendance window focused before scanning.</span>
      {status.detail && status.detail !== "Keep the attendance window focused before scanning" && (
        <span className="scanner-diag-detail">{status.detail}</span>
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
      <span className="dashboard-brand-name">ALPHA PREMIER</span>
    </div>
  );
}

function AttendanceTable({
  rows,
  timezone,
}: {
  rows: AttendanceListItem[];
  timezone: string;
}) {
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
            <th>Time in</th>
            <th>Time out</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const late = row.status === "LATE_TIMEOUT";
            return (
              <tr key={row.attendanceId}>
                <td>
                  <strong>{row.fullName}</strong>
                  <small>{row.userId}</small>
                </td>
                <td>{row.department || "—"}</td>
                <td>{row.timeIn ? formatTime(row.timeIn, timezone) : "—"}</td>
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

function AdminPanel() {
  const [unlocked, setUnlocked] = useState(false);
  useScannerPause(unlocked);
  const office = useOfficeIdentity();
  const [sessionExpiresAt, setSessionExpiresAt] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [adminMode, setAdminMode] = useState<"attendance" | "bathroom">("attendance");
  const [tab, setTab] = useState<"users" | "attendance" | "payroll" | "data" | "voice">(
    "users",
  );
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [rows, setRows] = useState<AttendanceListItem[]>([]);
  const [profiles, setProfiles] = useState<PayrollCalculationProfile[]>([]);
  const [cutoffs, setCutoffs] = useState<PayrollCutoffRecord[]>([]);
  const [date, setDate] = useState(localDate());
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [busy, setBusy] = useState(false);
  const [nuking, setNuking] = useState(false);
  const [nukeConfirmOpen, setNukeConfirmOpen] = useState(false);
  const [manualUpdateCheck, setManualUpdateCheck] = useState<number>(0);

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
      if (isTextEntry) return;
      if (event.key === "1") {
        setAdminMode("attendance");
      } else if (event.key === "2") {
        setAdminMode("bathroom");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [unlocked]);

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
      setError("Google Sheets wiped; re-export queued from SQLite.");
    } else {
      setError(response.error?.message ?? "Unable to reset Google Sheets.");
    }
  };
  const load = useCallback(async () => {
    try {
      const [
        userResponse,
        attendanceResponse,
        profileResponse,
        cutoffResponse,
      ] = await Promise.all([
        loadAdminUsers(),
        loadAdminAttendance(date),
        loadPayrollProfiles(),
        loadPayrollCutoffs(),
      ]);
      if (userResponse.success) setUsers(userResponse.users);
      if (attendanceResponse.success) setRows(attendanceResponse.attendance);
      if (profileResponse.success) setProfiles(profileResponse.profiles);
      if (cutoffResponse.success) setCutoffs(cutoffResponse.payroll);
    } catch {
      setError("Unable to load administrator data.");
    }
  }, [date]);
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
  useEffect(() => {
    if (unlocked) void load();
  }, [unlocked, load]);
  if (!unlocked)
    return (
      <main className="dashboard-shell admin-login">
        <a href="/">← Scanner</a>
        <form onSubmit={unlock}>
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
              onChange={(event) => setPin(event.target.value)}
            />
          </label>
          {error && <p className="dashboard-alert">{error}</p>}
          <button className="submit-button" disabled={busy || !pin.trim()}>
            Unlock admin
          </button>
        </form>
      </main>
    );
  return (
    <main
      className={`dashboard-shell ${adminMode === "attendance" && tab === "payroll" ? "dashboard-shell-payroll" : ""}`}
    >
      <header className="dashboard-header">
        <div>
          <DashboardBrand />
          <p className="section-kicker">Administrator access</p>
          <h1>Manage attendance</h1>
          <p className="section-description">
            {resolveOfficeDisplay(office, "short")}
          </p>
          <div className="admin-mode-switcher" role="tablist" aria-label="Administrator mode switcher">
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
              onClick={() => setAdminMode("bathroom")}
            >
              <span className="admin-mode-key-badge" aria-hidden="true">2</span>
              <span>Bathroom Key Log</span>
            </button>
          </div>
        </div>
        <nav>
          <a href="/">Scanner</a>
          <a href="/attendance">Live view</a>
          {import.meta.env.DEV && (
            <button
              className="text-button"
              type="button"
              disabled={nuking}
              onClick={() => setNukeConfirmOpen(true)}
            >
              {nuking ? "Nuking…" : "Nuke & resync Sheets"}
            </button>
          )}
          <button
            className="text-button"
            type="button"
            onClick={() => {
              void lockAdmin();
              setUnlocked(false);
              setSessionExpiresAt("");
            }}
          >
            Lock
          </button>
        </nav>
      </header>
      {adminMode === "bathroom" ? (
        <BathroomKeyLogPanel users={users} />
      ) : (
        <>
          <div className="admin-tabs">
            <button
              className={tab === "users" ? "is-active" : ""}
              onClick={() => setTab("users")}
            >
              Users and RFID
            </button>
            <button
              className={tab === "attendance" ? "is-active" : ""}
              onClick={() => setTab("attendance")}
            >
              Attendance corrections
            </button>
            <button
              className={tab === "payroll" ? "is-active" : ""}
              onClick={() => setTab("payroll")}
            >
              Payroll
            </button>
            <button
              className={tab === "data" ? "is-active" : ""}
              onClick={() => setTab("data")}
            >
              Data and backup
            </button>
            <button
              className={tab === "voice" ? "is-active" : ""}
              onClick={() => setTab("voice")}
            >
              Voice announcements
            </button>
          </div>
          <ScannerDiagnostics />
          {error && <p className="dashboard-alert">{error}</p>}
          {tab === "users" ? (
            <UserEditor
              users={users}
              profiles={profiles}
              editing={editing}
              setEditing={setEditing}
              onSaved={load}
            />
          ) : tab === "attendance" ? (
            <AdminAttendance
              rows={rows}
              date={date}
              setDate={setDate}
              users={users}
              onSaved={load}
            />
          ) : tab === "payroll" ? (
            <PayrollWorkspace
              users={users}
              profiles={profiles}
              records={cutoffs}
              onSaved={load}
            />
          ) : tab === "voice" ? (
            <VoiceSettingsPanel />
          ) : (
            <DatabasePanel onManualUpdateCheck={() => setManualUpdateCheck(Date.now())} />
          )}
        </>
      )}
      <ConfirmDialog
        open={nukeConfirmOpen}
        busy={nuking}
        title="Wipe Google Sheets?"
        message="This will wipe all Google Sheets data and re-export everything from SQLite. This cannot be undone."
        onCancel={() => setNukeConfirmOpen(false)}
        onConfirm={() => void nukeSheets()}
      />
      <UpdateBanner manualCheckTrigger={manualUpdateCheck} />
    </main>
  );
}

type AdminUser = {
  userId: string;
  rfidUid: string;
  fullName: string;
  department: string | null;
  status: "ACTIVE" | "INACTIVE";
  employeeType: "INTERN" | "EMPLOYEE";
  gender: UserGender | null;
  dailyRate: number | null;
  payrollProfileId?: string | null;
  photoUrl?: string | null;
  cardType?: CardType;
  label?: string | null;
};

/** Data & backup panel: configurable DB location, safe backups, and the PC-switch restore flow. */
export function DatabasePanel(props: { onManualUpdateCheck?: () => void } = {}) {
  const [info, setInfo] = useState<DatabaseInfoResponse | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [backupResult, setBackupResult] = useState<GeneratedFileResult | null>(
    null,
  );
  const [restoreFile, setRestoreFile] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const response = await loadDatabaseInfo();
    if (response.success) {
      setInfo(response);
      setError("");
    } else setError(response.error.message);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createBackup = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    const response = await createDatabaseBackup();
    setBusy(false);
    if (response.success) {
      setNotice(
        `Backup created: ${response.fileName}. Copy this file to the new computer.`,
      );
      setBackupResult({
        filePath: null,
        directoryPath: response.directoryPath,
        fileName: response.fileName,
        fileKind: response.fileKind,
        isPortableMode: response.isPortableMode,
      });
      void refresh();
    } else setError(response.error.message);
  };

  const restore = async () => {
    if (!("__TAURI_INTERNALS__" in window)) {
      setError("Restore is available in the desktop application.");
      return;
    }
    try {
      const selected = await pickRestoreBackupFile();
      if (!selected) return;
      setRestoreFile(selected);
    } catch {
      setError("Unable to open the file picker.");
    }
  };

  const confirmRestore = async () => {
    if (!restoreFile) return;
    const file = restoreFile;
    setRestoreFile(null);
    setBusy(true);
    setError("");
    setNotice("");
    const response = await requestDatabaseRestore(file);
    setBusy(false);
    if (response.success) setNotice(response.message);
    else setError(response.error.message);
  };

  const openBackups = async () => {
    const outcome = await openDatabaseBackupsFolder();
    if (!outcome.ok) setError(outcome.message);
  };

  const formatSize = (bytes: number) =>
    bytes > 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const formatWhen = (value: string | null) => {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? value
      : date.toLocaleString("en-PH", {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });
  };

  return (
    <section className="lan-panel" aria-label="Database and backup">
      <div className="lan-panel-head">
        <div>
          <p className="section-kicker">Data and backup</p>
          <h2>Move the attendance database to a new computer</h2>
        </div>
      </div>
      <div className="lan-facts db-facts">
        <span>
          Database file{" "}
          <strong title={info?.dbPath}>{info?.dbPath ?? "—"}</strong>
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
      {info?.restoreFailed && (
        <div className="warning-banner" role="alert">
          <ShieldAlert size={20} />
          <div>
            <strong>Scheduled database restore failed</strong>
            <p>{info.restoreFailed}</p>
          </div>
        </div>
      )}
      <div className="lan-actions">
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
      {notice && (
        <p className="dashboard-alert db-notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="dashboard-alert" role="alert">
          {error}
        </p>
      )}
      <AdminUpdatesCard onManualCheck={props.onManualUpdateCheck ?? (() => {})} />
      <GeneratedFileActions result={backupResult} label="Latest backup" />
      <div className="lan-guidance">
        <p>
          <strong>Moving to the new front-desk PC</strong> (no data loss, no
          manual SQL):
        </p>
        <ol className="db-steps">
          <li>
            On the <strong>old PC</strong>: open Admin → Data and backup and
            press <strong>Create backup now</strong>. The app writes a
            consistent copy of the entire database (SQLite online backup — safe
            even while the app is running) and keeps the newest 10.
          </li>
          <li>
            Copy the <code>attendance-backup-*.apbackup</code> file to a USB drive (or
            the office network) and plug it into the <strong>new PC</strong>.
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
      </div>
      {info && info.backups.length > 0 && (
        <div className="db-backup-list">
          <h3>Existing backups</h3>
          <ul>
            {info.backups.map((backup) => (
              <li key={backup.filePath}>
                <code>{backup.fileName}</code>
                <span>{formatSize(backup.sizeBytes)}</span>
                <span>{formatWhen(backup.modifiedAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <ConfirmDialog
        open={Boolean(restoreFile)}
        busy={busy}
        title="Restore database from backup?"
        message="The app will close and restore the database from the selected file on the next launch. Any data on this device will be replaced."
        onCancel={() => setRestoreFile(null)}
        onConfirm={() => void confirmRestore()}
      />
    </section>
  );
}
function UserEditor({
  users,
  profiles,
  editing,
  setEditing,
  onSaved,
}: {
  users: AdminUser[];
  profiles: PayrollCalculationProfile[];
  editing: AdminUser | null;
  setEditing: (user: AdminUser | null) => void;
  onSaved: () => void;
}) {
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
  };
  const [form, setForm] = useState<AdminUser>(editing ?? blankUser);
  const [message, setMessage] = useState("");
  const [deletingUserId, setDeletingUserId] = useState("");
  const [deleteUserTarget, setDeleteUserTarget] = useState<AdminUser | null>(null);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [batchDeleteUsersOpen, setBatchDeleteUsersOpen] = useState(false);
  const [batchUpdatingUsers, setBatchUpdatingUsers] = useState(false);
  const masterUserCheckboxRef = useRef<HTMLInputElement>(null);

  const allUsersSelected = users.length > 0 && selectedUserIds.size === users.length;
  const someUsersSelected = selectedUserIds.size > 0 && selectedUserIds.size < users.length;

  useEffect(() => {
    if (masterUserCheckboxRef.current) {
      masterUserCheckboxRef.current.indeterminate = someUsersSelected;
    }
  }, [someUsersSelected]);

  useEffect(() => {
    setSelectedUserIds((prev) => {
      const valid = new Set(users.map((u) => u.userId));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (valid.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [users]);

  const toggleSelectAllUsers = () => {
    if (allUsersSelected) {
      setSelectedUserIds(new Set());
    } else {
      setSelectedUserIds(new Set(users.map((u) => u.userId)));
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
    if (selectedUserIds.size === 0) return;
    setBatchDeleteUsersOpen(false);
    setBatchUpdatingUsers(true);
    const ids = Array.from(selectedUserIds);
    let count = 0;
    for (const id of ids) {
      const res = await deleteAdminUser(id);
      if (res.success) {
        count++;
        if (editing?.userId === id) setEditing(null);
      }
    }
    setBatchUpdatingUsers(false);
    setSelectedUserIds(new Set());
    setMessage(`Deleted ${count} user(s).`);
    onSaved();
  };

  const setStatusBatchUsers = async (status: "ACTIVE" | "INACTIVE") => {
    if (selectedUserIds.size === 0) return;
    setBatchUpdatingUsers(true);
    const targetUsers = users.filter((u) => selectedUserIds.has(u.userId));
    let count = 0;
    for (const u of targetUsers) {
      const res = await saveAdminUser({ ...u, status }, u.userId);
      if (res.success) count++;
    }
    setBatchUpdatingUsers(false);
    setSelectedUserIds(new Set());
    setMessage(`Updated ${count} user(s) to ${status.toLowerCase()}.`);
    onSaved();
  };

  useEffect(() => {
    setForm(editing ?? blankUser);
    setMessage("");
  }, [editing]);
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
        dailyRate: form.employeeType === "EMPLOYEE" ? form.dailyRate : null,
        payrollProfileId:
          form.employeeType === "EMPLOYEE" ? form.payrollProfileId : null,
      };
      const response = await saveAdminUser(payload, editing?.userId);
      if (response.success) {
        setMessage("Saved.");
        setEditing(null);
        onSaved();
      } else {
        setMessage(response.error?.message ?? "Unable to save user.");
      }
    } catch (err) {
      const errMsg = toErrorMessage(err, "Unable to save user.");
      if (errMsg.includes("USER_CONFLICT")) {
        setMessage("This RFID card or User ID is already assigned to another user.");
      } else {
        setMessage(errMsg);
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
        setMessage(`Deleted ${user.fullName}.`);
        if (editing?.userId === user.userId) setEditing(null);
        onSaved();
      } else {
        setMessage(response.error?.message ?? "Unable to delete user.");
      }
    } catch (err) {
      setMessage(toErrorMessage(err, "Unable to delete user."));
    } finally {
      setDeletingUserId("");
    }
  };
  return (
    <div className="admin-grid">
      <section className="admin-form">
        <div className="editor-heading">
          <div>
            <p className="section-kicker">User registration</p>
            <h2>{editing ? `Editing ${editing.fullName}` : "Add user"}</h2>
          </div>
          {editing && (
            <button className="text-button" type="button" onClick={() => setEditing(null)}>
              Cancel edit
            </button>
          )}
        </div>
        {editing && (
          <p className="edit-context" role="status">
            Active record: <strong>{editing.userId}</strong> · RFID {editing.rfidUid}
          </p>
        )}
        {message && (
          <p
            className={`form-message ${
              message.includes("already") ||
              message.includes("Unable") ||
              message.includes("conflict") ||
              message.includes("Error")
                ? "is-error"
                : "is-success"
            }`}
            role="status"
          >
            {message}
          </p>
        )}
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
                Employee card
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
                <ShieldCheck size={14} /> Admin RFID card
              </label>
            </div>
          </div>

          {form.cardType === "ADMIN_ASSIST" ? (
            <>
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
            </>
          ) : (
            <>
              <label>
                User ID
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
                Employee type
                <select
                  value={form.employeeType}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      employeeType: e.target.value === "EMPLOYEE" ? "EMPLOYEE" : "INTERN",
                      dailyRate:
                        e.target.value === "INTERN" ? null : form.dailyRate,
                      payrollProfileId:
                        e.target.value === "INTERN"
                          ? (form.payrollProfileId ?? "BEA_STANDARD")
                          : null,
                    })
                  }
                >
                  <option value="INTERN">Intern</option>
                  <option value="EMPLOYEE">Employee</option>
                </select>
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
              {form.employeeType === "EMPLOYEE" && (
                <>
                  <label>
                    Daily rate (PHP)
                    <input
                      required
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={form.dailyRate ?? ""}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          dailyRate: Number(e.target.value) || null,
                        })
                      }
                    />
                  </label>
                  <label>
                    Payroll calculation
                    <select
                      value={form.payrollProfileId ?? "BEA_STANDARD"}
                      onChange={(e) =>
                        setForm({ ...form, payrollProfileId: e.target.value })
                      }
                    >
                      {profiles.map((profile) => (
                        <option key={profile.profileId} value={profile.profileId}>
                          {profile.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
            </>
          )}
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
          {message && <p className="dashboard-alert">{message}</p>}
          <button className="submit-button" type="submit">
            Save user
          </button>
        </form>
      </section>
      <section className="table-with-bar">
        <div className="table-header-bar">
          <div className="table-selection-count">
            {selectedUserIds.size > 0 ? (
              <span className="table-selection-badge">{selectedUserIds.size} of {users.length} user(s) selected</span>
            ) : (
              <span>Total users: {users.length}</span>
            )}
          </div>
          <div className="table-batch-actions">
            {selectedUserIds.size > 0 ? (
              <>
                {selectedUserIds.size < users.length && (
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => setSelectedUserIds(new Set(users.map((u) => u.userId)))}
                  >
                    Select all ({users.length})
                  </button>
                )}
                <button
                  className="text-button"
                  type="button"
                  onClick={() => setSelectedUserIds(new Set())}
                >
                  Clear selection
                </button>
                <button
                  className="admin-button"
                  type="button"
                  disabled={batchUpdatingUsers}
                  onClick={() => void setStatusBatchUsers("ACTIVE")}
                >
                  Set Active ({selectedUserIds.size})
                </button>
                <button
                  className="admin-button"
                  type="button"
                  disabled={batchUpdatingUsers}
                  onClick={() => void setStatusBatchUsers("INACTIVE")}
                >
                  Set Inactive ({selectedUserIds.size})
                </button>
                <button
                  className="admin-button danger-button"
                  type="button"
                  disabled={batchUpdatingUsers}
                  onClick={() => setBatchDeleteUsersOpen(true)}
                >
                  Delete selected ({selectedUserIds.size})
                </button>
              </>
            ) : (
              <button
                className="text-button"
                type="button"
                onClick={() => setSelectedUserIds(new Set(users.map((u) => u.userId)))}
              >
                Select all
              </button>
            )}
          </div>
        </div>
        <div className="table-wrap">
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
                <th>Payroll profile</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
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
                  <td>{user.rfidUid}</td>
                  <td>
                    {user.cardType === "ADMIN_ASSIST"
                      ? "Not applicable"
                      : user.employeeType === "EMPLOYEE"
                        ? (profiles.find(
                            (profile) =>
                              profile.profileId === user.payrollProfileId,
                          )?.label ??
                          user.payrollProfileId ??
                          "None")
                        : "Not applicable"}
                  </td>
                  <td>{user.status}</td>
                  <td>
                    <button
                      className="text-button"
                      onClick={() => setEditing(user)}
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
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <ConfirmDialog
        open={Boolean(deleteUserTarget)}
        busy={Boolean(deletingUserId)}
        title="Delete user?"
        message={deleteUserTarget ? `Are you sure you want to delete ${deleteUserTarget.fullName} (${deleteUserTarget.userId})? This cannot be undone.` : ""}
        onCancel={() => setDeleteUserTarget(null)}
        onConfirm={() => void remove()}
      />
      <ConfirmDialog
        open={batchDeleteUsersOpen}
        busy={batchUpdatingUsers}
        title="Delete selected users?"
        message={`Are you sure you want to delete ${selectedUserIds.size} selected user(s)? This will remove them from the roster.`}
        onCancel={() => setBatchDeleteUsersOpen(false)}
        onConfirm={() => void removeBatchUsers()}
      />
    </div>
  );
}

function UserPhoto({ photoUrl, name }: { photoUrl?: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  if (!photoUrl || failed) {
    return <span className="user-photo-fallback" aria-label={`${name} has no available photo`}><UserRound size={16} /></span>;
  }
  return (
    <img
      className="user-photo"
      src={photoSource(photoUrl)}
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
}: {
  users: AdminUser[];
  profiles: PayrollCalculationProfile[];
  records: PayrollCutoffRecord[];
  onSaved: () => void;
}) {
  const [form, setForm] = useState<PayrollForm>(emptyPayrollForm);
  const [message, setMessage] = useState("");
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
      setMessage("Select a cutoff period first.");
      return;
    }
    if (form.cutoffStart > form.cutoffEnd) {
      setMessage("Cutoff start must be on or before cutoff end.");
      return;
    }
    setMessage("");
    setConfirmOpen(true);
  };

  const confirmGenerate = async () => {
    if (saving) return;
    setSaving(true);
    try {
      if (existingCutoffRecords.length > 0) {
        for (const r of existingCutoffRecords) {
          await deletePayrollCutoff(r.payrollId);
        }
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
        setMessage(
          existingCutoffRecords.length > 0
            ? "Existing cutoff was replaced and regenerated from attendance."
            : "Payroll drafts were generated from completed attendance.",
        );
        onSaved();
        setConfirmOpen(false);
      } else {
        setMessage(response.error?.message ?? "Unable to save payroll.");
      }
    } catch (error) {
      setMessage(toErrorMessage(error, "Unable to save payroll."));
    } finally {
      setSaving(false);
    }
  };

  const clearCutoffRecords = async () => {
    if (clearingCutoff || existingCutoffRecords.length === 0) return;
    setClearingCutoff(true);
    let count = 0;
    for (const r of existingCutoffRecords) {
      const res = await deletePayrollCutoff(r.payrollId);
      if (res.success) count++;
    }
    setClearingCutoff(false);
    setClearCutoffOpen(false);
    setMessage(`Deleted ${count} payroll record(s) for cutoff ${form.cutoffStart} to ${form.cutoffEnd}.`);
    onSaved();
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

  const [pdfMessage, setPdfMessage] = useState("");
  const [generating, setGenerating] = useState<null | "employee" | "intern">(null);
  const [payrollPdfs, setPayrollPdfs] = useState<PayrollPdfRecord[]>([]);

  useEffect(() => {
    void loadPayrollPdfs().then((response) => {
      if (response.success) setPayrollPdfs(response.payrollPdfs);
    });
  }, []);

  const generatePdf = async (workerType: "employee" | "intern") => {
    if (generating) return;
    if (!selectedCutoff) {
      setPdfMessage(
        "No payroll records to generate. Create and save a payroll first.",
      );
      return;
    }
    setGenerating(workerType);
    setPdfMessage("");
    try {
      const response = await generatePayrollPdf({
        cutoffStart: selectedCutoff.cutoffStart,
        cutoffEnd: selectedCutoff.cutoffEnd,
        payrollCutoffLabel: selectedCutoff.label,
        workerType,
      });
      if (response.success) {
        setPayrollPdfs((current) => [
          response.pdf,
          ...current.filter(
            (item) => item.payrollPdfId !== response.pdf.payrollPdfId,
          ),
        ]);
        setPdfMessage(`Payroll PDF generated for ${selectedCutoff.label}.`);
      } else setPdfMessage(response.error.message);
    } catch (error) {
      setPdfMessage(
        error instanceof Error
          ? error.message
          : "Unable to generate the payroll PDF.",
      );
    } finally {
      setGenerating(null);
    }
  };

  return (
    <section className="payroll-workspace">
      <div className="payroll-toolbar">
        <form className="payroll-generate-panel" onSubmit={save}>
          <div className="payroll-panel-heading">
            <h2>Generate cutoff payroll</h2>
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
            <label>
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
            <button
              className="submit-button payroll-generate-submit"
              type="submit"
              disabled={saving || !form.cutoffStart || !form.cutoffEnd}
            >
              {saving ? "Generating..." : "Generate from attendance"}
            </button>
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
              onClick={() => void generatePdf("employee")}
              disabled={generating !== null}
            >
              {generating === "employee" ? "Generating..." : "Generate Employee Payroll PDF"}
            </button>
            <button
              className="admin-button"
              type="button"
              onClick={() => void generatePdf("intern")}
              disabled={generating !== null}
            >
              {generating === "intern" ? "Generating..." : "Generate Intern Payroll PDF"}
            </button>
          </div>
        </div>
      </div>

      {existingCutoffRecords.length > 0 && (
        <div className="cutoff-existing-banner" role="status">
          <span>
            Payroll already exists for this cutoff ({existingCutoffRecords.length} record(s)). Generating from attendance will replace existing records.
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

      {message && <p className="dashboard-alert">{message}</p>}
      {pdfMessage && <p className="dashboard-alert">{pdfMessage}</p>}

      <section className="payroll-table">
        <PayrollTable records={records} onFinalized={onSaved} />
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
            ? `Payroll already exists for ${form.cutoffStart} through ${form.cutoffEnd} (${existingCutoffRecords.length} record(s)). Generating new payroll will replace these existing records with fresh calculations from latest attendance. Continue?`
            : `This will generate payroll records for ${form.cutoffStart} through ${form.cutoffEnd} from completed attendance. Incomplete or late-timeout attendance will not be paid. Continue?`
        }
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void confirmGenerate()}
      />
      <ConfirmDialog
        open={clearCutoffOpen}
        busy={clearingCutoff}
        title="Delete cutoff records?"
        message={`This will permanently delete all ${existingCutoffRecords.length} payroll record(s) for cutoff ${form.cutoffStart} through ${form.cutoffEnd}. Continue?`}
        onCancel={() => setClearCutoffOpen(false)}
        onConfirm={() => void clearCutoffRecords()}
      />
    </section>
  );
}

function ConfirmDialog({
  open,
  busy,
  title,
  message,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  title: string;
  message: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;
  return (
    <div className="confirm-backdrop" role="presentation">
      <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-heading">
        <CircleAlert size={22} aria-hidden="true" />
        <h2 id="confirm-heading">{title}</h2>
        <p>{message}</p>
        <div className="confirm-actions">
          <button className="text-button" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
          <button className="submit-button" type="button" disabled={busy} onClick={onConfirm}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} Confirm
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
  const dailyRate = isIntern ? INTERN_DAILY_RATE_PHP : record.dailyRate;
  const actualDays = record.actualWorkingDays;
  const absentDays = Math.max(0, nStdDays - actualDays);
  const basicPay = dailyRate * nStdDays;
  const absenceDeduction = dailyRate * absentDays;

  const nHra = isIntern ? 0 : Number(hra) || 0;
  const nInc = isIntern ? 0 : Number(incentivesAllowance) || 0;
  const nSpecAllow = isIntern ? 0 : Number(specialAllowance) || 0;
  const nOt = isIntern ? 0 : Number(overtimePay) || 0;
  const nAdj = Number(manualAdjustment) || 0;

  const nSss = isIntern ? 0 : Number(sss) || 0;
  const nPhic = isIntern ? 0 : Number(phic) || 0;
  const nHdmf = isIntern ? 0 : Number(hdmf) || 0;
  const nAdvance = isIntern ? 0 : Number(salaryAdvance) || 0;

  const autoEarnings = basicPay + (isIntern ? 0 : record.regularHolidayPay + record.specialHolidayPay);
  const autoDeductions = record.lateDeduction + absenceDeduction + record.halfDayDeduction;

  const totalAllowance = isIntern ? 0 : nInc + nSpecAllow + nHra;
  const totalEarnings = isIntern
    ? Math.max(0, basicPay + nAdj)
    : autoEarnings + totalAllowance + nOt + nAdj;
  const manualDeductions = isIntern ? 0 : nSss + nPhic + nHdmf + nAdvance;
  const totalDeductions = autoDeductions + manualDeductions;
  const netPay = isIntern
    ? Math.max(0, totalEarnings - totalDeductions)
    : totalEarnings - totalDeductions;

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
        basicPay,
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
        absentDays,
        absenceDeduction,
        halfDayCount: record.halfDayCount,
        halfDayDeduction: record.halfDayDeduction,
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
          {record.payrollCutoffLabel} ({record.cutoffStart} to {record.cutoffEnd}) • {record.employeeId}
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
            <span className="attendance-value" style={{ color: record.lateDeduction > 0 ? "#dc2626" : undefined }}>
              {php(record.lateDeduction)} ({record.lateUnits} hrs)
            </span>
          </div>
          <div className="attendance-stat">
            <span className="attendance-label">Absent / Halfday</span>
            <span className="attendance-value" style={{ color: (absenceDeduction + record.halfDayDeduction) > 0 ? "#dc2626" : undefined }}>
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
                <span className="summary-value" style={{ color: "#dc2626" }}>
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
                <span className="summary-value" style={{ color: "#dc2626" }}>
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

function PayrollTable({
  records,
  onFinalized,
}: {
  records: PayrollCutoffRecord[];
  onFinalized: () => void;
}) {
  const [message, setMessage] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [editTarget, setEditTarget] = useState<PayrollCutoffRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PayrollCutoffRecord | null>(null);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [finalizeTarget, setFinalizeTarget] = useState<PayrollCutoffRecord | null>(null);
  const [batchFinalizeOpen, setBatchFinalizeOpen] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [deletingBatch, setDeletingBatch] = useState(false);
  const masterCheckboxRef = useRef<HTMLInputElement>(null);

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
    const response = await finalizePayrollCutoff(target.payrollId);
    setFinalizing(false);
    if (response.success) {
      setMessage("Payroll finalized.");
      onFinalized();
    } else {
      setMessage(response.error?.message ?? "Unable to finalize payroll.");
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    const response = await deletePayrollCutoff(target.payrollId);
    if (response.success) {
      setMessage("Payroll deleted.");
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(target.payrollId);
        return next;
      });
      onFinalized();
    } else {
      setMessage(response.error?.message ?? "Unable to delete payroll.");
    }
  };

  const selectedDraftsCount = records.filter(
    (r) => selectedIds.has(r.payrollId) && r.status === "DRAFT",
  ).length;

  const removeBatch = async () => {
    if (selectedIds.size === 0) return;
    setBatchDeleteOpen(false);
    setDeletingBatch(true);
    const ids = Array.from(selectedIds);
    let successCount = 0;
    for (const id of ids) {
      const response = await deletePayrollCutoff(id);
      if (response.success) successCount++;
    }
    setDeletingBatch(false);
    setSelectedIds(new Set());
    setMessage(`Deleted ${successCount} payroll record(s).`);
    onFinalized();
  };

  const finalizeBatch = async () => {
    const draftIds = records
      .filter((r) => selectedIds.has(r.payrollId) && r.status === "DRAFT")
      .map((r) => r.payrollId);
    if (draftIds.length === 0) return;
    setBatchFinalizeOpen(false);
    setFinalizing(true);
    let successCount = 0;
    for (const id of draftIds) {
      const response = await finalizePayrollCutoff(id);
      if (response.success) successCount++;
    }
    setFinalizing(false);
    setSelectedIds(new Set());
    setMessage(`Finalized ${successCount} payroll record(s).`);
    onFinalized();
  };

  if (!records.length)
    return (
      <div className="empty-state">No cutoff payroll has been created.</div>
    );

  return (
    <div className="payroll-table-with-bar">
      <div className="payroll-table-header-bar">
        <div className="payroll-selection-count">
          {selectedIds.size > 0 ? (
            <span className="table-selection-badge">{selectedIds.size} of {records.length} payroll record(s) selected</span>
          ) : (
            <span>Total records: {records.length}</span>
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

      <div className="table-wrap">
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
              <th>Dept / Role</th>
              <th>Bank / A/C</th>
              <th>TIN #</th>
              <th>Standard</th>
              <th>Paid Days</th>
              <th>LWOP</th>
              <th>Daily Rate</th>
              <th>Basic Pay</th>
              <th>HRA</th>
              <th>Incentives</th>
              <th>Special Allow.</th>
              <th>Total Allow.</th>
              <th>Reg. Hol.</th>
              <th>Spec. Hol.</th>
              <th>Overtime</th>
              <th>Total Earnings</th>
              <th>SSS</th>
              <th>PhilHealth</th>
              <th>HDMF</th>
              <th>Advance</th>
              <th>Absent</th>
              <th>Late / Halfday</th>
              <th>Total Deductions</th>
              <th>Net Pay</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {records.map((row) => {
              const sss = row.sss ?? 0;
              const phic = row.phic ?? 0;
              const hdmf = row.hdmf ?? 0;
              const advance = row.salaryAdvance ?? 0;
              const totalDeductions =
                row.totalDeductions ??
                row.lateDeduction +
                  row.halfDayDeduction +
                  row.absenceDeduction +
                  sss +
                  phic +
                  hdmf +
                  advance;

              return (
                <Fragment key={row.payrollId}>
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
                    <td>
                      {row.department || row.designation
                        ? `${row.department ?? ""}${row.department && row.designation ? " — " : ""}${row.designation ?? ""}`
                        : "—"}
                    </td>
                    <td>
                      {row.bankName || row.accountNumber
                        ? `${row.bankName ?? "CASH"} / ${row.accountNumber ?? "0000"}`
                        : "CASH / 0000"}
                    </td>
                    <td>{row.tin || "—"}</td>
                    <td>{row.standardWorkingDays}</td>
                    <td>{row.actualWorkingDays}</td>
                    <td>{row.absentDays}</td>
                    <td>{php(row.dailyRate)}</td>
                    <td>{php(row.basicPay)}</td>
                    <td>{php(row.hra ?? 0)}</td>
                    <td>{php(row.incentivesAllowance)}</td>
                    <td>{php(row.specialAllowance)}</td>
                    <td>{php(row.totalAllowance)}</td>
                    <td>{php(row.regularHolidayPay)}</td>
                    <td>{php(row.specialHolidayPay)}</td>
                    <td>{php(row.overtimePay)}</td>
                    <td>
                      <strong>{php(row.grossCompensation)}</strong>
                    </td>
                    <td>{php(sss)}</td>
                    <td>{php(phic)}</td>
                    <td>{php(hdmf)}</td>
                    <td>{php(advance)}</td>
                    <td>{php(row.absenceDeduction)}</td>
                    <td>{php(row.lateDeduction + row.halfDayDeduction)}</td>
                    <td>
                      <strong style={{ color: "#dc2626" }}>{php(totalDeductions)}</strong>
                    </td>
                    <td style={{ backgroundColor: "#fef08a" }}>
                      <strong style={{ color: "#854d0e" }}>{php(row.netPay)}</strong>
                    </td>
                    <td className="payroll-actions-cell">
                      {row.status === "DRAFT" ? (
                        <span className="payroll-row-actions">
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
                  <tr key={`${row.payrollId}-details`} className="payroll-detail">
                    <td colSpan={28}>
                      <details>
                        <summary>Calculation breakdown & payslip detail</summary>
                        {row.employeeType === "INTERN" ? (
                          <p>
                            {php(row.totalCompensation || row.basicPay)} cutoff rate ({row.standardWorkingDays} std days at {php(INTERN_DAILY_RATE_PHP)}/day)
                            {row.absenceDeduction > 0
                              ? ` - ${php(row.absenceDeduction)} absent deduction (${row.absentDays} day(s))`
                              : ""}
                            {row.manualAdjustment !== 0
                              ? ` + ${php(row.manualAdjustment)} manual adjustment (${row.adjustmentReason})`
                              : ""}{" "}
                            - {php(row.lateDeduction)} late deduction (
                            {row.lateUnits} hr(s) at{" "}
                            {php(INTERN_LATE_DEDUCTION_PER_HOUR_PHP)}/hr)
                            {row.halfDayDeduction > 0
                              ? ` - ${php(row.halfDayDeduction)} half-day deduction (${row.halfDayCount} half-day(s))`
                              : ""} ={" "}
                            <strong>{php(row.grossCompensation)}</strong>.
                          </p>
                        ) : (
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
                            <strong>{php(totalDeductions)}</strong> (Total Deductions).
                            <br />
                            <strong>Net Pay:</strong> {php(row.grossCompensation)} - {php(totalDeductions)} ={" "}
                            <strong style={{ color: "#854d0e", backgroundColor: "#fef08a", padding: "2px 6px", borderRadius: "3px" }}>
                              {php(row.netPay)}
                            </strong>
                          </p>
                        )}
                        <p>
                          Status: {row.status}. Cutoff: {row.payrollCutoffLabel} ({row.cutoffStart} to {row.cutoffEnd}).
                        </p>
                      </details>
                    </td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {message && <p className="dashboard-alert">{message}</p>}
      <EditPayrollDialog
        record={editTarget}
        open={Boolean(editTarget)}
        onClose={() => setEditTarget(null)}
        onSaved={() => {
          setMessage("Payroll updated.");
          onFinalized();
        }}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        busy={false}
        title={deleteTarget?.status === "FINALIZED" ? "Delete finalized payroll?" : "Delete saved payroll?"}
        message={
          deleteTarget
            ? deleteTarget.status === "FINALIZED"
              ? `This will delete the finalized payroll for ${deleteTarget.employeeName} (${deleteTarget.payrollCutoffLabel}). Use this if the employee left, was promoted, or needs their cutoff regenerated. Continue?`
              : `This will permanently delete the draft payroll for ${deleteTarget.employeeName} (${deleteTarget.payrollCutoffLabel}). Continue?`
            : ""
        }
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void remove()}
      />
      <ConfirmDialog
        open={batchDeleteOpen}
        busy={deletingBatch}
        title="Delete selected payrolls?"
        message={`Are you sure you want to delete ${selectedIds.size} selected payroll record(s)? This will permanently remove them from the cutoff.`}
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
        onCancel={() => setFinalizeTarget(null)}
        onConfirm={() => void finalize()}
      />
      <ConfirmDialog
        open={batchFinalizeOpen}
        busy={finalizing}
        title="Finalize selected payrolls?"
        message={`This will finalize ${selectedDraftsCount} selected draft payroll record(s). Values will be locked from further edits.`}
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

/**
 * Formats the Manila ISO timestamp of a generated payroll PDF for the history
 * list (e.g. "Aug 14, 2026, 10:30 AM"). Falls back to the raw value when the
 * timestamp cannot be parsed.
 */
function formatGeneratedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-PH", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * History of generated payroll PDFs produced by the Tauri backend. Each row
 * offers Open PDF (system default viewer) and Show in Folder actions backed by
 * the existing opener commands; nothing is ever printed from the browser.
 */
function PayrollPdfList({ pdfs }: { pdfs: PayrollPdfRecord[] }) {
  const [actionMessage, setActionMessage] = useState("");
  const runAction = async (
    action: (filePath: string) => Promise<FileActionResult>,
    filePath: string,
  ) => {
    const result = await action(filePath);
    setActionMessage(result.ok ? "" : result.message);
  };
  const sorted = [...pdfs].sort((a, b) =>
    b.generatedAt.localeCompare(a.generatedAt),
  );
  if (!sorted.length)
    return (
      <div className="empty-state">No payroll PDFs have been generated yet.</div>
    );
  return (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Period</th>
              <th>Type</th>
              <th>Generated</th>
              <th>Employees</th>
              <th>Total</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((pdf) => (
              <tr key={pdf.payrollPdfId}>
                <td>
                  <strong>{pdf.payrollCutoffLabel}</strong>
                  <small>
                    {pdf.cutoffStart} to {pdf.cutoffEnd}
                  </small>
                </td>
                <td>{pdf.workerType === "employee" ? "Employee" : "Intern"}</td>
                <td>{formatGeneratedAt(pdf.generatedAt)}</td>
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
        </table>
      </div>
      {actionMessage && <p className="dashboard-alert">{actionMessage}</p>}
    </>
  );
}

function getDatesInRange(startDate: string, endDate: string): string[] {
  let start = startDate;
  let end = endDate;
  if (start > end) {
    [start, end] = [end, start];
  }
  const dates: string[] = [];
  const current = new Date(`${start}T00:00:00Z`);
  const stop = new Date(`${end}T00:00:00Z`);
  let count = 0;
  while (current <= stop && count < 62) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
    count++;
  }
  return dates;
}

interface DateRangePreset {
  start: string;
  end: string;
}

function getPresetRange(
  preset: "today" | "week" | "month",
  baseDate: string,
): DateRangePreset {
  const d = new Date(`${baseDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    const today = new Date().toISOString().slice(0, 10);
    return { start: today, end: today };
  }
  const dateStr = d.toISOString().slice(0, 10);
  if (preset === "today") {
    return { start: dateStr, end: dateStr };
  }
  if (preset === "week") {
    const day = d.getUTCDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() + diffToMonday);
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    return {
      start: monday.toISOString().slice(0, 10),
      end: sunday.toISOString().slice(0, 10),
    };
  }
  if (preset === "month") {
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, "0");
    const start = `${year}-${month}-01`;
    const lastDay = new Date(
      Date.UTC(year, d.getUTCMonth() + 1, 0),
    ).getUTCDate();
    const end = `${year}-${month}-${String(lastDay).padStart(2, "0")}`;
    return { start, end };
  }
  return { start: dateStr, end: dateStr };
}

function AdminAttendance({
  rows: initialRows,
  date,
  setDate,
  users = [],
  onSaved,
}: {
  rows: AttendanceListItem[];
  date: string;
  setDate: (value: string) => void;
  users?: AdminUser[];
  onSaved: () => void;
}) {
  const [startDate, setStartDate] = useState(date);
  const [endDate, setEndDate] = useState(date);
  const [preset, setPreset] = useState<"today" | "week" | "month" | "custom">(
    "today",
  );
  const [rangeRows, setRangeRows] = useState<AttendanceListItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [exporting, setExporting] = useState(false);
  const [fileResult, setFileResult] = useState<GeneratedFileResult | null>(
    null,
  );
  const [employeeFilter, setEmployeeFilter] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [backdatedModalOpen, setBackdatedModalOpen] = useState(false);

  const activeRows = rangeRows ?? initialRows;

  const loadRange = useCallback(
    async (start: string, end: string) => {
      if (start === end) {
        setDate(start);
        setRangeRows(null);
        return;
      }
      const dates = getDatesInRange(start, end);
      try {
        setLoading(true);
        const responses = await Promise.all(
          dates.map((d) => loadAdminAttendance(d)),
        );
        const combined = responses.flatMap((r) =>
          r.success ? r.attendance : [],
        );
        const map = new Map<string, AttendanceListItem>();
        for (const row of combined) {
          map.set(row.attendanceId, row);
        }
        const unique = Array.from(map.values()).sort((a, b) => {
          const dateComp = b.attendanceDate.localeCompare(a.attendanceDate);
          if (dateComp !== 0) return dateComp;
          return (b.timeIn ?? "").localeCompare(a.timeIn ?? "");
        });
        setRangeRows(unique);
      } catch {
        setMessage("Unable to load attendance for selected date range.");
      } finally {
        setLoading(false);
      }
    },
    [setDate],
  );

  const applyPreset = (p: "today" | "week" | "month") => {
    setPreset(p);
    const range = getPresetRange(p, date);
    setStartDate(range.start);
    setEndDate(range.end);
    void loadRange(range.start, range.end);
  };

  const handleCustomDateChange = (type: "start" | "end", val: string) => {
    setPreset("custom");
    const newStart = type === "start" ? val : startDate;
    const newEnd = type === "end" ? val : endDate;
    if (type === "start") setStartDate(val);
    if (type === "end") setEndDate(val);
    if (newStart && newEnd) {
      void loadRange(newStart, newEnd);
    }
  };

  const arrivalMap = useMemo(
    () => evaluateAttendanceArrivals(activeRows),
    [activeRows],
  );

  const counts = useMemo(() => {
    let gpCount = 0;
    let lateCount = 0;
    for (const info of arrivalMap.values()) {
      if (info.arrivalStatus === "GRACE_PERIOD") gpCount++;
      else if (info.arrivalStatus === "LATE") lateCount++;
    }
    return {
      all: activeRows.length,
      gracePeriod: gpCount,
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
    if (statusFilter === "GRACE_PERIOD") {
      return arrivalMap.get(row.attendanceId)?.arrivalStatus === "GRACE_PERIOD";
    }
    if (statusFilter === "LATE") {
      return arrivalMap.get(row.attendanceId)?.arrivalStatus === "LATE";
    }
    return row.status === statusFilter;
  });

  const departments = [
    ...new Set(
      activeRows
        .map((row) => row.department)
        .filter((d): d is string => Boolean(d)),
    ),
  ];

  const [selectedAttendanceIds, setSelectedAttendanceIds] = useState<Set<string>>(new Set());
  const [batchDeleteAttendanceOpen, setBatchDeleteAttendanceOpen] = useState(false);
  const [batchDeletingAttendance, setBatchDeletingAttendance] = useState(false);
  const masterAttendanceCheckboxRef = useRef<HTMLInputElement>(null);

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
    const result = exportAttendanceCsv(selectedRows, arrivalMap, startDate, endDate !== startDate ? endDate : undefined);
    if (result.success) {
      setMessage(`Generated ${result.fileName} (${selectedRows.length} rows).`);
      setFileResult({
        filePath: result.filePath,
        directoryPath: result.directoryPath,
        fileName: result.fileName,
        fileKind: "csv",
        isPortableMode: false,
      });
    } else setMessage(result.message);
  };

  const removeBatchAttendance = async () => {
    if (selectedAttendanceIds.size === 0) return;
    setBatchDeleteAttendanceOpen(false);
    setBatchDeletingAttendance(true);
    const targetRows = filteredRows.filter((r) => selectedAttendanceIds.has(r.attendanceId));
    let count = 0;
    for (const r of targetRows) {
      const res = await deleteAdminAttendance(r.attendanceId, r.attendanceDate);
      if (res.success) count++;
    }
    setBatchDeletingAttendance(false);
    setSelectedAttendanceIds(new Set());
    setMessage(`Deleted ${count} attendance record(s).`);
    onSaved();
    if (startDate !== endDate) {
      void loadRange(startDate, endDate);
    }
  };

  const exportWorkbook = async () => {
    setExporting(true);
    const result = exportAttendanceCsv(
      filteredRows,
      arrivalMap,
      startDate,
      endDate !== startDate ? endDate : undefined,
    );
    setExporting(false);
    if (result.success) {
      setMessage(`Generated ${result.fileName} (${filteredRows.length} rows).`);
      setFileResult({
        filePath: result.filePath,
        directoryPath: result.directoryPath,
        fileName: result.fileName,
        fileKind: "csv",
        isPortableMode: false,
      });
    } else setMessage(result.message);
  };

  return (
    <section className="table-with-bar">
      <div className="attendance-filter-bar">
        <div className="attendance-filter-top">
          <div className="filter-presets">
            <span className="field-label" style={{ marginRight: 4 }}>
              Period:
            </span>
            <button
              className={`filter-preset-btn ${preset === "today" ? "is-active" : ""}`}
              type="button"
              onClick={() => applyPreset("today")}
            >
              Today
            </button>
            <button
              className={`filter-preset-btn ${preset === "week" ? "is-active" : ""}`}
              type="button"
              onClick={() => applyPreset("week")}
            >
              This Week
            </button>
            <button
              className={`filter-preset-btn ${preset === "month" ? "is-active" : ""}`}
              type="button"
              onClick={() => applyPreset("month")}
            >
              This Month
            </button>
          </div>
          <div className="attendance-pills">
            <button
              className={`filter-pill ${!statusFilter ? "is-active" : ""}`}
              type="button"
              onClick={() => setStatusFilter("")}
            >
              All <span className="filter-pill-count">{counts.all}</span>
            </button>
            <button
              className={`filter-pill ${statusFilter === "GRACE_PERIOD" ? "is-active" : ""}`}
              type="button"
              onClick={() =>
                setStatusFilter(
                  statusFilter === "GRACE_PERIOD" ? "" : "GRACE_PERIOD",
                )
              }
            >
              Grace Period (GP){" "}
              <span className="filter-pill-count">{counts.gracePeriod}</span>
            </button>
            <button
              className={`filter-pill ${statusFilter === "LATE" ? "is-active" : ""}`}
              type="button"
              onClick={() =>
                setStatusFilter(statusFilter === "LATE" ? "" : "LATE")
              }
            >
              Late <span className="filter-pill-count">{counts.late}</span>
            </button>
            <button
              className={`filter-pill ${statusFilter === "LATE_TIMEOUT" ? "is-active" : ""}`}
              type="button"
              onClick={() =>
                setStatusFilter(
                  statusFilter === "LATE_TIMEOUT" ? "" : "LATE_TIMEOUT",
                )
              }
            >
              Late Time-out{" "}
              <span className="filter-pill-count">{counts.lateTimeout}</span>
            </button>
            <button
              className={`filter-pill ${statusFilter === "WORKING" ? "is-active" : ""}`}
              type="button"
              onClick={() =>
                setStatusFilter(statusFilter === "WORKING" ? "" : "WORKING")
              }
            >
              Working <span className="filter-pill-count">{counts.working}</span>
            </button>
            <button
              className={`filter-pill ${statusFilter === "COMPLETED" ? "is-active" : ""}`}
              type="button"
              onClick={() =>
                setStatusFilter(
                  statusFilter === "COMPLETED" ? "" : "COMPLETED",
                )
              }
            >
              Completed{" "}
              <span className="filter-pill-count">{counts.completed}</span>
            </button>
            <button
              className={`filter-pill ${statusFilter === "MISSED" ? "is-active" : ""}`}
              type="button"
              onClick={() =>
                setStatusFilter(statusFilter === "MISSED" ? "" : "MISSED")
              }
            >
              Missed <span className="filter-pill-count">{counts.missed}</span>
            </button>
            <div className="filter-pills-divider" role="separator" />
            <button
              className={`filter-pill is-assisted ${sourceFilter === "ADMIN_ASSISTED_SCAN" ? "is-active" : ""}`}
              type="button"
              title="Show only kiosk scans assisted by an administrator"
              onClick={() =>
                setSourceFilter(
                  sourceFilter === "ADMIN_ASSISTED_SCAN" ? "" : "ADMIN_ASSISTED_SCAN",
                )
              }
            >
              <UserCheck size={12} style={{ marginRight: 4, verticalAlign: "-1px" }} />
              Assisted <span className="filter-pill-count">{counts.assisted}</span>
            </button>
            <button
              className={`filter-pill is-backdated ${sourceFilter === "ADMIN_BACKDATED_ENTRY" ? "is-active" : ""}`}
              type="button"
              title="Show only backdated attendance manually entered by an administrator"
              onClick={() =>
                setSourceFilter(
                  sourceFilter === "ADMIN_BACKDATED_ENTRY" ? "" : "ADMIN_BACKDATED_ENTRY",
                )
              }
            >
              <History size={12} style={{ marginRight: 4, verticalAlign: "-1px" }} />
              Backdated <span className="filter-pill-count">{counts.backdated}</span>
            </button>
          </div>
        </div>
        <div className="date-filter">
          <label>
            From date
            <input
              type="date"
              value={startDate}
              onChange={(event) =>
                handleCustomDateChange("start", event.target.value)
              }
            />
          </label>
          <label>
            To date
            <input
              type="date"
              value={endDate}
              onChange={(event) =>
                handleCustomDateChange("end", event.target.value)
              }
            />
          </label>
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
            disabled={exporting || loading}
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
          {loading && <small role="status">Loading records…</small>}
          {message && <small role="status">{message}</small>}
        </div>
      </div>
      <GeneratedFileActions result={fileResult} label="Attendance export" />

      <div className="table-header-bar">
        <div className="table-selection-count">
          {selectedAttendanceIds.size > 0 ? (
            <span className="table-selection-badge">{selectedAttendanceIds.size} of {filteredRows.length} attendance record(s) selected</span>
          ) : (
            <span>Total records: {filteredRows.length}</span>
          )}
        </div>
        <div className="table-batch-actions">
          {selectedAttendanceIds.size > 0 ? (
            <>
              {selectedAttendanceIds.size < filteredRows.length && (
                <button
                  className="text-button"
                  type="button"
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
                onClick={exportSelectedAttendance}
              >
                <Download size={14} /> Export selected CSV ({selectedAttendanceIds.size})
              </button>
              <button
                className="admin-button danger-button"
                type="button"
                disabled={batchDeletingAttendance}
                onClick={() => setBatchDeleteAttendanceOpen(true)}
              >
                Delete selected ({selectedAttendanceIds.size})
              </button>
            </>
          ) : (
            <button
              className="text-button"
              type="button"
              onClick={() => setSelectedAttendanceIds(new Set(filteredRows.map((r) => r.attendanceId)))}
            >
              Select all
            </button>
          )}
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="table-select-col">
                <input
                  type="checkbox"
                  ref={masterAttendanceCheckboxRef}
                  checked={allAttendanceSelected}
                  onChange={toggleSelectAllAttendance}
                  aria-label="Select all attendance records"
                />
              </th>
              <th>Date</th>
              <th>Employee</th>
              <th>Time in</th>
              <th>Arrival</th>
              <th>Time out</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filteredRows.length === 0 ? (
              <tr>
                <td colSpan={8} className="table-empty-cell">
                  <div className="empty-state">
                    No attendance records found for{" "}
                    {startDate === endDate
                      ? startDate
                      : `${startDate} to ${endDate}`}
                    {employeeFilter || departmentFilter || statusFilter
                      ? " matching the selected filters"
                      : ""}
                    .
                  </div>
                </td>
              </tr>
            ) : (
              filteredRows.map((row) => (
                <AttendanceEditRow
                  key={row.attendanceId}
                  row={row}
                  selected={selectedAttendanceIds.has(row.attendanceId)}
                  onToggleSelect={() => toggleSelectAttendance(row.attendanceId)}
                  arrivalInfo={arrivalMap.get(row.attendanceId)}
                  onSaved={() => {
                    onSaved();
                    if (startDate !== endDate) {
                      void loadRange(startDate, endDate);
                    }
                  }}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
      <ConfirmDialog
        open={batchDeleteAttendanceOpen}
        busy={batchDeletingAttendance}
        title="Delete selected attendance records?"
        message={`Are you sure you want to delete ${selectedAttendanceIds.size} selected attendance record(s)? This will remove them from the logs.`}
        onCancel={() => setBatchDeleteAttendanceOpen(false)}
        onConfirm={() => void removeBatchAttendance()}
      />
      {backdatedModalOpen && (
        <BackdatedAttendanceModal
          activeEmployees={users.filter(
            (u) => u.status === "ACTIVE" && u.cardType !== "ADMIN_ASSIST",
          )}
          onClose={() => setBackdatedModalOpen(false)}
          onSaved={() => {
            onSaved();
            if (startDate !== endDate) {
              void loadRange(startDate, endDate);
            }
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
  onSaved: () => void;
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
        onSaved();
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
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
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
  ];
  const csvCell = (value: string | number | null) =>
    `"${String(value ?? "").replace(/"/g, '""')}"`;
  const totalHours = (row: AttendanceListItem) => {
    if (!row.timeIn || !row.timeOut) return "";
    const hours =
      (new Date(row.timeOut).getTime() - new Date(row.timeIn).getTime()) /
      3_600_000;
    return Number.isFinite(hours) && hours >= 0 ? hours.toFixed(2) : "";
  };
  const getArrivalText = (row: AttendanceListItem) => {
    const info = arrivalMap.get(row.attendanceId);
    if (!info || info.arrivalStatus === "NONE") return "";
    if (info.arrivalStatus === "ON_TIME") return "On time";
    if (info.arrivalStatus === "GRACE_PERIOD") return "Grace Period (GP)";
    return `Late (${info.minutesLate}m)`;
  };
  const content = [
    headers,
    ...rows.map((row) => [
      row.fullName,
      row.userId,
      row.department,
      row.attendanceDate,
      row.timeIn,
      getArrivalText(row),
      row.timeOut,
      row.status,
      totalHours(row),
      row.source ?? "",
      row.recordedBy ?? "",
      row.recordedReason ?? "",
      row.recordedAt ?? "",
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

function AttendanceEditRow({
  row,
  selected,
  onToggleSelect,
  arrivalInfo,
  onSaved,
}: {
  row: AttendanceListItem;
  selected?: boolean;
  onToggleSelect?: () => void;
  arrivalInfo?: { arrivalStatus: ArrivalStatus; minutesLate: number };
  onSaved: () => void;
}) {
  const [timeIn, setTimeIn] = useState(
    row.timeIn ? row.timeIn.slice(11, 16) : "",
  );
  const [timeOut, setTimeOut] = useState(
    row.timeOut ? row.timeOut.slice(11, 16) : "",
  );
  const [message, setMessage] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteAttendanceConfirm, setDeleteAttendanceConfirm] = useState(false);

  useEffect(() => {
    setTimeIn(row.timeIn ? row.timeIn.slice(11, 16) : "");
    setTimeOut(row.timeOut ? row.timeOut.slice(11, 16) : "");
  }, [row.timeIn, row.timeOut]);

  const late = row.status === "LATE_TIMEOUT";
  const save = async () => {
    const toIsoWithRollover = (inVal: string, outVal: string, baseDate: string) => {
      const inIso = inVal ? `${baseDate}T${inVal}:00+08:00` : null;
      if (!outVal) return { timeInIso: inIso, timeOutIso: null };
      // Check if overnight rollover occurred: if timeOut < timeIn lexicographically
      let outDate = baseDate;
      if (inVal && outVal < inVal) {
        const d = new Date(`${baseDate}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 1);
        outDate = d.toISOString().slice(0, 10);
      }
      const outIso = `${outDate}T${outVal}:00+08:00`;
      return { timeInIso: inIso, timeOutIso: outIso };
    };
    const { timeInIso, timeOutIso } = toIsoWithRollover(timeIn, timeOut, row.attendanceDate);
    const response = await saveAdminAttendance(row.attendanceId, {
      attendanceDate: row.attendanceDate,
      timeIn: timeInIso,
      timeOut: timeOutIso,
      expectedTimeIn: row.timeIn || null,
      expectedTimeOut: row.timeOut || null,
    });
    if (response.success) {
      setMessage(
        timeOutIso && isLateTimeout(timeOutIso)
          ? "Saved — time-out is still after office hours, correction remains required."
          : "Saved",
      );
      onSaved();
    } else {
      setMessage(response.error?.message ?? "Conflict");
    }
  };
  const remove = async () => {
    setDeleteAttendanceConfirm(false);
    setDeleting(true);
    const response = await deleteAdminAttendance(
      row.attendanceId,
      row.attendanceDate,
    );
    setDeleting(false);
    if (response.success) {
      setMessage("Record deleted");
      onSaved();
    } else {
      setMessage(response.error?.message ?? "Unable to delete record.");
    }
  };

  const renderArrival = () => {
    if (!arrivalInfo || arrivalInfo.arrivalStatus === "NONE") {
      return <span className="arrival-badge badge-none">—</span>;
    }
    if (arrivalInfo.arrivalStatus === "ON_TIME") {
      return <span className="arrival-badge badge-ontime">On time</span>;
    }
    if (arrivalInfo.arrivalStatus === "GRACE_PERIOD") {
      return (
        <span
          className="arrival-badge badge-gp"
          title="8:00 - 8:15 AM (1 weekly grace period applied)"
        >
          Grace Period (GP)
        </span>
      );
    }
    return (
      <span
        className="arrival-badge badge-late"
        title={`Late arrival (${arrivalInfo.minutesLate} minutes)`}
      >
        Late ({arrivalInfo.minutesLate}m)
      </span>
    );
  };

  return (
    <>
      {late && (
        <tr className="admin-attention-row">
          <td colSpan={8} className="admin-attention">
            <strong>Late time-out — manual correction required.</strong> This
            time-out was recorded after office hours ({OFFICE_HOURS_END}); the
            office does not allow overtime. Re-enter the official time-out below
            to complete the shift.
          </td>
        </tr>
      )}
      <tr className={selected ? "selected-row" : ""}>
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
          <span style={{ fontSize: ".82rem", color: "var(--muted)" }}>
            {row.attendanceDate}
          </span>
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
        </td>
        <td>
          <div className="time-input-group">
            <input
              aria-label={`Time in for ${row.fullName}`}
              type="time"
              value={timeIn}
              onChange={(e) => setTimeIn(e.target.value)}
            />
            {timeIn ? (
              <button
                type="button"
                className="time-clear-btn"
                title="Clear time in"
                aria-label={`Clear time in for ${row.fullName}`}
                onClick={() => setTimeIn("")}
              >
                <X size={13} />
              </button>
            ) : null}
          </div>
        </td>
        <td>{renderArrival()}</td>
        <td>
          <div className="time-input-group">
            <input
              aria-label={`Time out for ${row.fullName}`}
              type="time"
              value={timeOut}
              onChange={(e) => setTimeOut(e.target.value)}
            />
            {timeOut ? (
              <button
                type="button"
                className="time-clear-btn"
                title="Clear time out"
                aria-label={`Clear time out for ${row.fullName}`}
                onClick={() => setTimeOut("")}
              >
                <X size={13} />
              </button>
            ) : null}
          </div>
        </td>
        <td>
          <span className={`status-pill status-${row.status.toLowerCase()}`}>
            {late ? "LATE TIMEOUT" : row.status}
          </span>
        </td>
        <td>
          <button className="text-button" onClick={() => void save()}>
            Save
          </button>
          <button
            className="text-button danger-button"
            disabled={deleting}
            onClick={() => setDeleteAttendanceConfirm(true)}
          >
            {deleting ? "Deleting..." : "Delete"}
          </button>
          {message && <small>{message}</small>}
        </td>
      </tr>
      {deleteAttendanceConfirm && (
        <tr>
          <td colSpan={7} style={{ padding: 0 }}>
            <ConfirmDialog
              open={true}
              busy={deleting}
              title="Delete attendance record?"
              message={`This will permanently delete ${row.fullName}'s time-in/time-out record for ${row.attendanceDate}. This cannot be undone.`}
              onCancel={() => setDeleteAttendanceConfirm(false)}
              onConfirm={() => void remove()}
            />
          </td>
        </tr>
      )}
    </>
  );
}
