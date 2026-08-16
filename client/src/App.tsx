import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  CircleAlert,
  CreditCard,
  Download,
  ImagePlus,
  Keyboard,
  LoaderCircle,
  LockKeyhole,
  Nfc,
  ShieldCheck,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import type {
  ScanErrorResponse,
  ScanSuccessResponse,
  SetupUser,
  UserGender,
  AttendanceListItem,
  PayrollCalculationProfile,
  PayrollCutoffRecord,
  OfficeIdentity,
  LanStatusResponse,
  DatabaseInfoResponse,
  PayrollPdfRecord,
} from "@rfid-attendance/shared";
import {
  DEFAULT_OFFICE_IDENTITY,
  resolveOfficeDisplay,
  INTERN_DAILY_RATE_PHP,
  INTERN_LATE_DEDUCTION_PER_HOUR_PHP,
  OFFICE_HOURS_END,
  isLateTimeout,
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
} from "./api";
import { sseUrl } from "./network";
import type { FileActionResult } from "./api";
import "./styles.css";
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
import { announceTimeIn, announceTimeOut } from "./speech";
import { pickRestoreBackupFile } from "./api";
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
  const setupInputRef = useRef<HTMLInputElement>(null);
  const setupIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setupSessionTimer = useRef<number | null>(null);

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

  const handleUnlock = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!adminPin.trim() || setupBusy) return;
    setSetupBusy(true);
    setSetupError("");
    const response = await unlockSetup(adminPin.trim());
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
    if (
      !setupToken ||
      !setupUid.trim() ||
      !setupForm.userId.trim() ||
      !setupForm.fullName.trim() ||
      setupBusy
    )
      return;
    setSetupBusy(true);
    setSetupError("");
    const response = await upsertSetupUser(
      {
        rfidUid: setupUid.trim(),
        userId: setupForm.userId.trim(),
        fullName: setupForm.fullName.trim(),
        department: setupForm.department.trim() || undefined,
        status: setupForm.status,
        employeeType: setupForm.employeeType,
        gender: setupForm.gender || null,
        dailyRate:
          setupForm.employeeType === "EMPLOYEE"
            ? Number(setupForm.dailyRate)
            : null,
        photoUrl: setupForm.photoUrl || null,
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
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
      file.size > PHOTO_UPLOAD_MAX_BYTES
    ) {
      setSetupError("Choose a JPEG, PNG, or WebP photo up to 500 KB.");
      return;
    }
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
    setSetupBusy(true);
    setSetupError("Uploading photo…");
    const response = await uploadSetupPhoto(
      setupForm.userId.trim(),
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
      processingRef.current = false;
      setResult(response);
      const nextState = response.success ? "success" : "error";
      setState(nextState);
      // Voice announcement: greet the employee by name on time-in, say goodbye on time-out.
      if (response.success) {
        if (document.visibilityState === "hidden" || !document.hasFocus()) void notifyScanSuccess(response.user.fullName).catch(() => undefined);
        if (response.action === "TIME_IN")
          announceTimeIn(
            greetingForDate(new Date(), config.timezone),
            response.user.fullName,
            response.user.gender,
          );
        else announceTimeOut(response.user.fullName);
      }
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(resetToReady, config.resultResetDelayMs);
    },
    [config.resultResetDelayMs, config.timezone, resetToReady],
  );

  const handleManualKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void submit(manualUid, "MANUAL_TEST");
  };

  // Latest scan-routing closure, re-assigned every render so the single native
  // listener always uses fresh state without re-registering (which would risk
  // duplicate listeners while config/setup state settles).
  const scanHandlerRef = useRef<(value: string) => void>(() => {});
  scanHandlerRef.current = (value) => {
    if (shouldRouteGlobalRfidToSetup(setupDialogOpen, setupToken, setupStep)) {
      handleSetupInput(value);
    } else if (!setupDialogOpen || !setupToken) {
      void submit(value, "RFID");
    }
  };

  // Keyboard-mode RFID reader scan handling.
  // The reader acts as a keyboard wedge emitting a rapid sequence of keypresses
  // terminated with Enter. Scans are captured only while the kiosk window is focused.
  useEffect(() => {
    let buffer = "";
    let lastKeyAt = 0;

    const resetBuffer = () => {
      buffer = "";
      lastKeyAt = 0;
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
      if (shouldRouteGlobalRfidToSetup(setupDialogOpen, setupToken, setupStep)) {
        handleSetupInput(normalized);
      } else if (!manualMode && !setupDialogOpen) {
        void submit(normalized, "RFID");
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
            (target.matches("input") && target.id !== "scanner-uid" && target.id !== "setup-card-uid")),
      );
      if (isTextEntry || manualMode || (setupDialogOpen && !shouldRouteGlobalRfidToSetup(setupDialogOpen, setupToken, setupStep))) {
        resetBuffer();
        return;
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
  }, [config, handleSetupInput, manualMode, setupDialogOpen, setupStep, setupToken, submit]);

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
      (setupDialogOpen &&
        !shouldRouteGlobalRfidToSetup(setupDialogOpen, setupToken, setupStep));
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
    state === "processing"
      ? "Reading card…"
      : greetingForDate(now, config.timezone);
  const heroSub =
    state === "processing"
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
        {state === "success" && success ? (
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
              <span>{formatAction(success.action)}</span>
              <span>
                {formatTime(
                  success.attendance.timeOut ?? success.attendance.timeIn,
                  config.timezone,
                )}
              </span>
            </div>
          </div>
        ) : state === "error" && error ? (
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
        ) : (
          <div className="kiosk-hero">
            <div className={`hero-icon icon-${state}`} aria-hidden="true">
              {state === "processing" ? (
                <LoaderCircle className="spin" size={46} />
              ) : (
                <CreditCard size={48} />
              )}
            </div>
            <h1 id="kiosk-heading">{heroTitle}</h1>
            <p className="hero-sub">{heroSub}</p>
          </div>
        )}

        {(state === "ready" || state === "processing") && (
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
                value={manualMode ? manualUid : uid}
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
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        props.onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
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
              Enter the administrator PIN to associate a card with an employee.
              Example: Deign Lazaro, IT / Admin.
            </p>
            <label htmlFor="admin-pin">Administrator PIN</label>
            <input
              id="admin-pin"
              type="password"
              inputMode="numeric"
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
            <div className="setup-fields">
              <label>
                <span className="field-label">User ID</span>
                <input
                  value={props.form.userId}
                  onChange={(event) =>
                    props.onFormChange("userId", event.target.value)
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
                  autoComplete="organization"
                />
              </label>
              <label>
                <span className="field-label">Status</span>
                <select
                  value={props.form.status}
                  onChange={(event) =>
                    props.onFormChange("status", event.target.value)
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
                    props.onFormChange("employeeType", event.target.value)
                  }
                >
                  <option value="INTERN">Intern</option>
                  <option value="EMPLOYEE">Employee</option>
                </select>
              </label>
              <label>
                <span className="field-label">Gender</span>
                <select
                  value={props.form.gender}
                  onChange={(event) =>
                    props.onFormChange("gender", event.target.value)
                  }
                >
                  <option value="">Not set</option>
                  <option value="MALE">Male</option>
                  <option value="FEMALE">Female</option>
                </select>
              </label>
              {props.form.employeeType === "EMPLOYEE" && (
                <label>
                  <span className="field-label">Daily rate (PHP)</span>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    required
                    value={props.form.dailyRate}
                    onChange={(event) =>
                      props.onFormChange("dailyRate", event.target.value)
                    }
                  />
                </label>
              )}
              <div className="photo-field">
                <span className="field-label">
                  ID photo <span className="optional">optional</span>
                </span>
                <label
                  className={`photo-dropzone${props.form.photoUrl ? " has-photo" : ""}`}
                  htmlFor="setup-photo"
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
                  !props.form.userId.trim() ||
                  !props.form.fullName.trim() ||
                  (props.form.employeeType === "EMPLOYEE" &&
                    Number(props.form.dailyRate) <= 0)
                }
              >
                {props.busy ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <Check size={17} />
                )}{" "}
                Save user
              </button>
            </div>
          </form>
        )}
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
  useScannerPause(true);
  const office = useOfficeIdentity();
  const [unlocked, setUnlocked] = useState(false);
  const [sessionExpiresAt, setSessionExpiresAt] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"users" | "attendance" | "payroll" | "data">(
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
  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const response = await unlockAdmin(pin);
    setBusy(false);
    if (!response.success) {
      setError(response.error.message);
      return;
    }
    setUnlocked(true);
    setSessionExpiresAt(response.expiresAt);
    setError("");
  };
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
          <label>
            Administrator PIN
            <input
              autoFocus
              type="password"
              value={pin}
              onChange={(event) => setPin(event.target.value)}
            />
          </label>
          {error && <p className="dashboard-alert">{error}</p>}
          <button className="submit-button" disabled={busy || !pin}>
            Unlock admin
          </button>
        </form>
      </main>
    );
  return (
    <main
      className={`dashboard-shell ${tab === "payroll" ? "dashboard-shell-payroll" : ""}`}
    >
      <header className="dashboard-header">
        <div>
          <DashboardBrand />
          <p className="section-kicker">Administrator access</p>
          <h1>Manage attendance</h1>
          <p className="section-description">
            {resolveOfficeDisplay(office, "short")}
          </p>
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
          onSaved={load}
        />
      ) : tab === "payroll" ? (
        <PayrollWorkspace
          users={users}
          profiles={profiles}
          records={cutoffs}
          onSaved={load}
        />
      ) : (
        <DatabasePanel />
      )}
      <ConfirmDialog
        open={nukeConfirmOpen}
        busy={nuking}
        title="Wipe Google Sheets?"
        message="This will wipe all Google Sheets data and re-export everything from SQLite. This cannot be undone."
        onCancel={() => setNukeConfirmOpen(false)}
        onConfirm={() => void nukeSheets()}
      />
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
};

/** Data & backup panel: configurable DB location, safe backups, and the PC-switch restore flow. */
export function DatabasePanel() {
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
  const formatWhen = (value: string | null) =>
    value ? new Date(value).toLocaleString() : "—";

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
  useEffect(() => {
    setForm(editing ?? blankUser);
    setMessage("");
  }, [editing]);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const payload = {
        ...form,
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
          <label>
            User ID
            <input
              required
              disabled={Boolean(editing)}
              value={form.userId}
              onChange={(e) => setForm({ ...form, userId: e.target.value })}
            />
          </label>
          <label>
            RFID UID
            <input
              required
              value={form.rfidUid}
              onChange={(e) => setForm({ ...form, rfidUid: e.target.value })}
            />
          </label>
          <label>
            Full name
            <input
              required
              value={form.fullName}
              onChange={(e) => setForm({ ...form, fullName: e.target.value })}
            />
          </label>
          <label>
            Department
            <input
              value={form.department ?? ""}
              onChange={(e) => setForm({ ...form, department: e.target.value })}
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
      <section>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>RFID</th>
                <th>Payroll profile</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.userId} className={editing?.userId === user.userId ? "is-editing" : ""}>
                  <td>
                    <UserPhoto photoUrl={user.photoUrl} name={user.fullName} />
                    <strong>{user.fullName}</strong>
                    <small>{user.userId}</small>
                  </td>
                  <td>{user.rfidUid}</td>
                  <td>
                    {user.employeeType === "EMPLOYEE"
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
    setForm((current) => ({
      ...current,
      cutoffStart: range.cutoffStart,
      cutoffEnd: range.cutoffEnd,
      payrollCutoffLabel: range.payrollCutoffLabel,
    }));
  };

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
    if (
      records.some(
        (record) =>
          record.status === "DRAFT" &&
          record.cutoffStart === form.cutoffStart &&
          record.cutoffEnd === form.cutoffEnd,
      )
    ) {
      setMessage(
        "Payroll already exists for this cutoff. Duplicate generation was blocked.",
      );
      return;
    }
    setMessage("");
    setConfirmOpen(true);
  };

  const confirmGenerate = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const response = await generatePayrollCutoff(
        form.cutoffStart,
        form.cutoffEnd,
        form.payrollCutoffLabel || `${form.cutoffStart} to ${form.cutoffEnd}`,
      );
      if (response.success) {
        setMessage("Payroll drafts were generated from completed attendance.");
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
                onChange={(event) => update("cutoffStart", event.target.value)}
              />
            </label>
            <label>
              Cutoff end
              <input
                required
                type="date"
                value={form.cutoffEnd}
                onChange={(event) => update("cutoffEnd", event.target.value)}
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
        title="Generate payroll drafts?"
        message={`This will generate payroll records for ${form.cutoffStart} through ${form.cutoffEnd} from completed attendance. Incomplete or late-timeout attendance will not be paid. Continue?`}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void confirmGenerate()}
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

function PayrollTable({
  records,
  onFinalized,
}: {
  records: PayrollCutoffRecord[];
  onFinalized: () => void;
}) {
  const [message, setMessage] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<PayrollCutoffRecord | null>(null);
  const [finalizeTarget, setFinalizeTarget] = useState<PayrollCutoffRecord | null>(null);
  const [finalizing, setFinalizing] = useState(false);
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
      onFinalized();
    } else {
      setMessage(response.error?.message ?? "Unable to delete payroll.");
    }
  };
  if (!records.length)
    return (
      <div className="empty-state">No cutoff payroll has been created.</div>
    );
  return (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
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
                  <tr key={row.payrollId}>
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
                        <span className="payroll-finalized-label">Finalized</span>
                      )}
                    </td>
                  </tr>
                  <tr key={`${row.payrollId}-details`} className="payroll-detail">
                    <td colSpan={27}>
                      <details>
                        <summary>Calculation breakdown & payslip detail</summary>
                        {row.employeeType === "INTERN" ? (
                          <p>
                            {php(row.basicPay)} basic ({row.actualWorkingDays}{" "}
                            day(s) at {php(INTERN_DAILY_RATE_PHP)} per day)
                            {row.manualAdjustment !== 0
                              ? ` + ${php(row.manualAdjustment)} manual adjustment (${row.adjustmentReason})`
                              : ""}{" "}
                            - {php(row.lateDeduction)} late deduction (
                            {row.lateUnits} hour(s) at{" "}
                            {php(INTERN_LATE_DEDUCTION_PER_HOUR_PHP)} per hour)
                            {row.halfDayDeduction > 0
                              ? ` - ${php(row.halfDayDeduction)} half-day deduction`
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
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        busy={false}
        title="Delete saved payroll?"
        message={deleteTarget ? `This will permanently delete the draft payroll for ${deleteTarget.employeeName} (${deleteTarget.payrollCutoffLabel}). Finalized payrolls cannot be deleted.` : ""}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void remove()}
      />
      <ConfirmDialog
        open={Boolean(finalizeTarget)}
        busy={finalizing}
        title="Finalize payroll?"
        message={finalizeTarget ? `This will finalize the payroll for ${finalizeTarget.employeeName} (${finalizeTarget.payrollCutoffLabel}). Finalized payrolls cannot be edited or deleted.` : ""}
        onCancel={() => setFinalizeTarget(null)}
        onConfirm={() => void finalize()}
      />
    </>
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
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
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

function AdminAttendance({
  rows,
  date,
  setDate,
  onSaved,
}: {
  rows: AttendanceListItem[];
  date: string;
  setDate: (value: string) => void;
  onSaved: () => void;
}) {
  const [message, setMessage] = useState("");
  const [exporting, setExporting] = useState(false);
  const [fileResult, setFileResult] = useState<GeneratedFileResult | null>(
    null,
  );
  const [employeeFilter, setEmployeeFilter] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const filteredRows = rows.filter((row) =>
    (!employeeFilter || `${row.fullName} ${row.userId}`.toLowerCase().includes(employeeFilter.toLowerCase())) &&
    (!departmentFilter || row.department === departmentFilter) &&
    (!statusFilter || row.status === statusFilter),
  );
  const departments = [...new Set(rows.map((row) => row.department).filter((d): d is string => Boolean(d)))];
  const exportWorkbook = async () => {
    setExporting(true);
    const result = exportAttendanceCsv(filteredRows, date);
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
    <section>
      <div className="date-filter">
        <label>
          Attendance date
          <input
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </label>
        <label>
          Employee
          <input placeholder="Name or ID" value={employeeFilter} onChange={(event) => setEmployeeFilter(event.target.value)} />
        </label>
        <label>
          Department
          <select value={departmentFilter} onChange={(event) => setDepartmentFilter(event.target.value)}>
            <option value="">All departments</option>
            {departments.map((department) => <option key={department} value={department}>{department}</option>)}
          </select>
        </label>
        <label>
          Status
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="">All statuses</option>
            {['WORKING', 'COMPLETED', 'MISSED', 'LATE_TIMEOUT'].map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
        </label>
        <button
          className="admin-button"
          type="button"
          disabled={exporting}
          onClick={() => void exportWorkbook()}
        >
          {exporting ? "Preparing..." : <><Download size={15} /> Export CSV</>}
        </button>
        {message && <small role="status">{message}</small>}
      </div>
      <GeneratedFileActions result={fileResult} label="Attendance export" />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Employee</th>
              <th>Time in</th>
              <th>Time out</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filteredRows.length === 0 ? (
              <tr>
                <td colSpan={5} className="table-empty-cell">
                  <div className="empty-state">
                    No attendance records found for {date}
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
                  onSaved={onSaved}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function exportAttendanceCsv(rows: AttendanceListItem[], date: string): { success: true; fileName: string; content: string; filePath: null; directoryPath: null } | { success: false; message: string } {
  const fileName = `attendance-export-${date}-to-${date}.csv`;
  const headers = ["Employee name", "Employee ID", "Department", "Date", "Time in", "Time out", "Status", "Total hours"];
  const csvCell = (value: string | number | null) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const totalHours = (row: AttendanceListItem) => {
    if (!row.timeIn || !row.timeOut) return "";
    const hours = (new Date(row.timeOut).getTime() - new Date(row.timeIn).getTime()) / 3_600_000;
    return Number.isFinite(hours) && hours >= 0 ? hours.toFixed(2) : "";
  };
  const content = [headers, ...rows.map((row) => [row.fullName, row.userId, row.department, row.attendanceDate, row.timeIn, row.timeOut, row.status, totalHours(row)])]
    .map((line) => line.map(csvCell).join(","))
    .join("\r\n");
  if (!rows.length) return { success: false, message: "No attendance matches the active filters; nothing was exported." };
  const url = URL.createObjectURL(new Blob([`\ufeff${content}\r\n`], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return { success: true, fileName, content, filePath: null, directoryPath: null };
}

function AttendanceEditRow({
  row,
  onSaved,
}: {
  row: AttendanceListItem;
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
  const late = row.status === "LATE_TIMEOUT";
  const save = async () => {
    const toIso = (value: string) =>
      value ? `${row.attendanceDate}T${value}:00+08:00` : null;
    const timeOutIso = toIso(timeOut);
    const response = await saveAdminAttendance(row.attendanceId, {
      attendanceDate: row.attendanceDate,
      timeIn: toIso(timeIn),
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
  return (
    <>
      {late && (
        <tr className="admin-attention-row">
          <td colSpan={5} className="admin-attention">
            <strong>Late time-out — manual correction required.</strong> This
            time-out was recorded after office hours ({OFFICE_HOURS_END}); the
            office does not allow overtime. Re-enter the official time-out below
            to complete the shift.
          </td>
        </tr>
      )}
      <tr>
        <td>
          <strong>{row.fullName}</strong>
          <small>{row.userId}</small>
        </td>
        <td>
          <input
            aria-label={`Time in for ${row.fullName}`}
            type="time"
            value={timeIn}
            onChange={(e) => setTimeIn(e.target.value)}
          />
        </td>
        <td>
          <input
            aria-label={`Time out for ${row.fullName}`}
            type="time"
            value={timeOut}
            onChange={(e) => setTimeOut(e.target.value)}
          />
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
          <td colSpan={5} style={{ padding: 0 }}>
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
