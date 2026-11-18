import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ImagePlus, LoaderCircle, Plus, Search, ShieldAlert, ShieldCheck, Upload, UserRound, X } from "lucide-react";
import type { CardType, UserGender } from "@rfid-attendance/shared";
import { normalizeName } from "@rfid-attendance/shared";
import { deleteAdminUser, syncInternDtr, photoSource, saveAdminUser, uploadAdminPhoto, loadVoiceClipStates, loadVoiceWorkerStatus, pollVoiceClipReady, regenerateVoiceClip } from "./api";
import type { VoiceClipState, VoiceWorkerStatus } from "@rfid-attendance/shared";
import { WAITING_FOR_CARD_PREFIX } from "@rfid-attendance/shared";
import { listenForDtrSyncProgress, detachWhenDone } from "./tauri-api";
import type { DtrSyncProgress } from "./tauri-api";
import { isDtrSyncAlreadyRunning, setDtrSyncActive, useDtrSyncActive } from "./dtr-sync-guard";
import { getClonedBeaNameAudioUrl, getWorkerNameAudioUrl, previewVoiceClip, resolveVoiceSlot } from "./services/ttsService";
import { useDialogKeys } from "./use-dialog-keys";
import { NoticeLine } from "./notice";
import type { Notice } from "./notice";
import { showToast } from "./toasts";
import { LoadFailed, LoadingRows } from "./list-load";
import type { LoadStatus } from "./list-load";
import { preparePhotoDataUrl, toErrorMessage, useVerticalOverflow } from "./app-shared";
import { ConfirmDialog } from "./confirm-dialog";
import { applyDtrProgressToGuard, dtrSyncSourceLabel } from "./database-panel";
import { batchOutcome, showResult } from "./payroll-workspace";
import { UserIdFormatHint, unusualUserId } from "./setup-dialog";

export type AdminUser = {
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

/** Added from the ID register and not yet given a card: the stored UID is a placeholder no reader can produce. */
function isWaitingForCard(user: Pick<AdminUser, "rfidUid">): boolean {
  return user.rfidUid.startsWith(WAITING_FOR_CARD_PREFIX);
}

/** The form a record opens with: a user waiting for a card opens with the RFID field empty, ready for the tap. */
function formFor(user: AdminUser): AdminUser {
  return isWaitingForCard(user) ? { ...user, rfidUid: "" } : user;
}

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
  const [form, setForm] = useState<AdminUser>(editing ? formFor(editing) : blankUser);
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

  useEffect(() => detachWhenDone(listenForDtrSyncProgress((progress) => {
    setDtrProgress(progress);
    applyDtrProgressToGuard(progress);
    if (progress.status === "syncing") {
      setMessage({ tone: "info", text: `Syncing intern ${progress.current} of ${progress.total}: ${progress.fullName}…` });
    }
  })), []);

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
    setForm(editing ? formFor(editing) : blankUser);
    setPhotoBuster(Date.now());
  }, [editing]);

  // The registration form opens on demand ("+ Add user" or Edit) in a pop-up, and closes after Save.
  const userFormRef = useRef<HTMLElement>(null);
  const [formOpen, setFormOpen] = useState(Boolean(editing));
  const formDirty = formOpen && (photoUploading || userFormChanged(form, editing ? formFor(editing) : blankUser));
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
            Active record: <strong>{editing.userId}</strong> · {isWaitingForCard(editing) ? "waiting for a card: tap it in the RFID UID field" : `RFID ${editing.rfidUid}`}
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
                  <td className="user-status-cell">
                    {isWaitingForCard(user) ? <span className="status-pill status-inactive">Waiting for a card</span> : user.rfidUid}
                  </td>
                  <td className="user-status-cell">
                    <span className={`status-pill status-${user.status.toLowerCase()}`}>{user.status === "ACTIVE" ? "Active" : "Inactive"}</span>
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
