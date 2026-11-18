import { useId, useRef, useState } from "react";
import { Check, CircleAlert, LoaderCircle } from "lucide-react";
import { useDialogKeys } from "./use-dialog-keys";

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

export function ConfirmDialog(props: ConfirmDialogProps) {
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
