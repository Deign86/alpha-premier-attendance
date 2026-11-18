import { useEffect, useId, useRef, useState } from "react";
import { Check, CreditCard, ImagePlus, LoaderCircle, LockKeyhole, ShieldCheck, Upload, UserRound, X } from "lucide-react";
import type { CardType, SetupUser, UserGender } from "@rfid-attendance/shared";
import { normalizeName } from "@rfid-attendance/shared";
import { photoSource } from "./api";
import { AdminUnlock } from './admin-unlock';
import { useDialogKeys } from "./use-dialog-keys";
import { NoticeLine } from "./notice";
import type { Notice } from "./notice";

export type SetupStep = "scan" | "edit";

export type SetupForm = {
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

export const emptySetupForm: SetupForm = {
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
  /** Clears the card field and a stale unlock error when the account sign-in opens. */
  onAccountStart: () => void;
  /** A Keystone account opened setup: the session's token and when it ends. */
  onAccountUnlocked: () => void;
  onUnlock: (event: React.FormEvent) => void;
  onUidChange: (value: string) => void;
  onScanAnother: () => void;
  onUidEnter: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onFormChange: (field: keyof SetupForm, value: string) => void;
  onPhotoFile: (file: File) => void;
  onUpsert: (event: React.FormEvent) => void;
  onClose: () => void;
};

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

export function unusualUserId(userId: string): boolean {
  const value = userId.trim();
  return value !== "" && !USUAL_USER_ID.test(value);
}

/** Under the User ID field. Kept out of the field's name (aria-hidden); the field reads it as its description. */
export function UserIdFormatHint({ id }: { id: string }) {
  return (
    <small id={id} className="user-id-hint" aria-hidden="true">
      Usual format: APG-YYYY-NNN
    </small>
  );
}

export function SetupDialog(props: SetupDialogProps) {
  const [isDraggingPhoto, setIsDraggingPhoto] = useState(false);
  // New cards only: an existing card keeps the ID it was saved with.
  const userIdHintId = useId();
  const showUserIdHint = !props.user && unusualUserId(props.form.userId);
  // The save step puts the cursor in its first field once, when it opens for a card (not on card-type switches).
  const saveFormRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (props.token && props.step === "edit") saveFormRef.current?.querySelector<HTMLInputElement>(".setup-fields input")?.focus({ preventScroll: true });
  }, [props.token, props.step, props.uid]);
  const [withAccount, setWithAccount] = useState(false);
  // An admin card tap can unlock while the account sign-in is open; a later expiry must land on the card, not on it.
  useEffect(() => {
    if (props.token) setWithAccount(false);
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
        data-step={!props.token ? (withAccount ? "account" : "unlock") : props.step === "scan" ? "scan" : "save"}
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
          <AdminUnlock
            cardOrCode={props.pin}
            onCardOrCodeChange={props.onPinChange}
            busy={props.busy}
            onSubmit={props.onUnlock}
            withAccount={withAccount}
            onWithAccountChange={setWithAccount}
            onAccountStart={props.onAccountStart}
            onAccountUnlocked={props.onAccountUnlocked}
            formClassName="setup-form"
            intro={
              <>
                <SetupSteps current={1} />
                <p className="setup-copy">
                  Tap an admin RFID card on the reader, or sign in with your Keystone account, to link a card to an employee.
                </p>
              </>
            }
            error={<NoticeLine notice={props.notice} />}
            submitClassName="submit-button setup-submit"
            submitLabel={
              <>
                {props.busy ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <LockKeyhole size={17} />
                )}{" "}
                Unlock setup
              </>
            }
            fieldId="admin-pin"
            fieldProps={{ autoComplete: "off", "data-autofocus": true }}
          />
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
