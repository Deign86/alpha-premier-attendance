import { useCallback, useEffect, useRef, useState } from "react";
import type { ComponentProps, FormEvent } from "react";
import type { SetupUser } from "@rfid-attendance/shared";
import { normalizeName } from "@rfid-attendance/shared";
import { adminSession, useAdminSession } from "./admin-session";
import { lockSetup, lookupSetupCard, unlockSetup, uploadSetupPhoto, upsertSetupUser } from "./api";
import { preparePhotoDataUrl } from "./app-shared";
import type { Notice } from "./notice";
import { emptySetupForm } from "./setup-dialog";
import type { SetupDialog, SetupForm, SetupStep } from "./setup-dialog";

type SetupDialogProps = ComponentProps<typeof SetupDialog>;

/**
 * The kiosk's card-setup dialog: unlock with the admin card or code, look a card up, save its person, upload a
 * photo. The dialog is unlocked while the admin session has a token: the one session, not a copy of it.
 */
export function useCardSetup(rfidAutoSubmitDelayMs: number) {
  const session = useAdminSession();
  const setupToken = session.token ?? "";
  const setupExpiresAt = session.expiresAt ?? "";
  const [setupDialogOpen, setSetupDialogOpen] = useState(false);
  const [setupStep, setSetupStep] = useState<SetupStep>("scan");
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupNotice, setSetupNotice] = useState<Notice | null>(null);
  const [adminCardOrCode, setAdminCardOrCode] = useState("");
  const [setupUid, setSetupUid] = useState("");
  const [setupUser, setSetupUser] = useState<SetupUser | null>(null);
  const [setupForm, setSetupForm] = useState<SetupForm>(emptySetupForm);
  const setupInputRef = useRef<HTMLInputElement>(null);
  const setupIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped on close: an unlock that answers after the dialog was closed is stale.
  const setupAttempt = useRef(0);
  const setupSessionTimer = useRef<number | null>(null);

  const focusSetupInput = useCallback(() => {
    window.requestAnimationFrame(() => setupInputRef.current?.focus());
  }, []);

  useEffect(
    () => () => {
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
      adminSession.close();
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

  const openSetup = useCallback(
    (initialUid = "") => {
      setSetupDialogOpen(true);
      setSetupNotice(null);
      if (initialUid) setSetupUid(initialUid);
      setAdminCardOrCode("");
      if (setupToken) {
        setSetupStep("scan");
        window.setTimeout(focusSetupInput, 0);
      }
    },
    [focusSetupInput, setupToken],
  );

  const unlockSetupWithCardOrCode = useCallback(
    async (cardOrCode: string) => {
      const candidate = cardOrCode.trim();
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
        setAdminCardOrCode("");
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

  const handleUnlock = async (event: FormEvent) => {
    event.preventDefault();
    await unlockSetupWithCardOrCode(adminCardOrCode);
  };

  const closeSetup = async () => {
    setupAttempt.current += 1;
    if (setupToken) void lockSetup(setupToken);
    if (setupIdleTimer.current) clearTimeout(setupIdleTimer.current);
    adminSession.close();
    setSetupDialogOpen(false);
    setSetupStep("scan");
    setSetupUid("");
    setSetupUser(null);
    setSetupNotice(null);
    setAdminCardOrCode("");
    setSetupForm(emptySetupForm);
  };

  const setupSessionExpired = useCallback(() => {
    if (!setupToken || !setupExpiresAt) return false;
    if (Date.now() < new Date(setupExpiresAt).getTime()) return false;
    if (setupSessionTimer.current) {
      clearInterval(setupSessionTimer.current);
      setupSessionTimer.current = null;
    }
    adminSession.close();
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
          rfidAutoSubmitDelayMs,
        );
    },
    [rfidAutoSubmitDelayMs, lookupCardForSetup],
  );

  const submitSetupUser = async (event: FormEvent) => {
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

  const dialog: SetupDialogProps = {
    token: setupToken,
    step: setupStep,
    busy: setupBusy,
    notice: setupNotice,
    cardOrCode: adminCardOrCode,
    uid: setupUid,
    user: setupUser,
    form: setupForm,
    inputRef: setupInputRef,
    onCardOrCodeChange: setAdminCardOrCode,
    onAccountStart: () => {
      setSetupNotice(null);
      setAdminCardOrCode("");
    },
    onAccountUnlocked: () => {
      setAdminCardOrCode("");
      setSetupNotice(null);
      setSetupStep("scan");
      window.setTimeout(focusSetupInput, 0);
    },
    onUnlock: handleUnlock,
    onUidChange: handleSetupInput,
    onScanAnother: () => {
      setSetupStep("scan");
      setSetupUid("");
      setSetupUser(null);
      setSetupNotice(null);
      setSetupForm(emptySetupForm);
      window.setTimeout(focusSetupInput, 0);
    },
    onUidEnter: (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void lookupCardForSetup(setupUid);
      }
    },
    onFormChange: (field, value) =>
      setSetupForm((current) => ({ ...current, [field]: value })),
    onPhotoFile: (file) => void uploadSetupPhotoFile(file),
    onUpsert: submitSetupUser,
    onClose: closeSetup,
  };

  return {
    open: setupDialogOpen,
    token: setupToken,
    step: setupStep,
    openSetup,
    unlockWithCardOrCode: unlockSetupWithCardOrCode,
    handleInput: handleSetupInput,
    dialog,
  };
}
