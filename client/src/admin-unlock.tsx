import type { FormEvent, InputHTMLAttributes, ReactNode } from "react";
import { AccountSignInPanel } from "./account-sign-in";

/**
 * A locked admin screen: tap an admin card on the reader (or type the code IT set), or sign in with a Keystone
 * account. The kiosk's card-setup dialog and the Admin page both show this; each passes its own words around the
 * same two ways in.
 */
export type AdminUnlockProps = {
  /** What was scanned or typed into the card field. */
  cardOrCode: string;
  onCardOrCodeChange: (value: string) => void;
  busy: boolean;
  onSubmit: (event: FormEvent) => void;
  /** Whether the Keystone account sign-in is showing instead of the card field. */
  withAccount: boolean;
  onWithAccountChange: (withAccount: boolean) => void;
  /** The screen's own tidy-up when the person switches to the account sign-in. */
  onAccountStart: () => void;
  onAccountUnlocked: (expiresAt: string) => void;
  formClassName?: string;
  /** What the screen says above the card field. */
  intro: ReactNode;
  /** The screen's error line, under the card field. */
  error: ReactNode;
  submitClassName: string;
  submitLabel: ReactNode;
  /** With an id the label points at the field (the kiosk's card reader knows the field by it); without, the label wraps it. */
  fieldId?: string;
  fieldProps?: InputHTMLAttributes<HTMLInputElement> & { "data-autofocus"?: boolean };
};

export function AdminUnlock(props: AdminUnlockProps) {
  if (props.withAccount) {
    return (
      <AccountSignInPanel
        onUnlocked={(expiresAt) => {
          props.onWithAccountChange(false);
          props.onAccountUnlocked(expiresAt);
        }}
        onBack={() => props.onWithAccountChange(false)}
      />
    );
  }
  const field = (
    <input
      id={props.fieldId}
      type="password"
      placeholder="Scan admin card…"
      value={props.cardOrCode}
      onChange={(event) => props.onCardOrCodeChange(event.target.value)}
      autoFocus
      {...props.fieldProps}
    />
  );
  return (
    <form className={props.formClassName} onSubmit={props.onSubmit}>
      {props.intro}
      {props.fieldId ? (
        <>
          <label htmlFor={props.fieldId}>Admin RFID card</label>
          {field}
        </>
      ) : (
        <label>
          Admin RFID card
          {field}
        </label>
      )}
      {props.error}
      <button className={props.submitClassName} type="submit" disabled={props.busy || !props.cardOrCode.trim()}>
        {props.submitLabel}
      </button>
      <button
        className="text-button"
        type="button"
        onClick={() => {
          props.onAccountStart();
          props.onWithAccountChange(true);
        }}
      >
        Sign in with your Keystone account
      </button>
    </form>
  );
}
