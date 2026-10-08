import { useState } from 'react';
import type { FormEvent } from 'react';
import { KeyRound, LoaderCircle, Mail } from 'lucide-react';
import { confirmAdminPinReset, requestAdminPinReset } from './api';

export const PIN_RESET_SUCCESS =
  'Admin PIN updated. Unlock with the new PIN. Registered admin RFID cards still work.';

interface PinResetPanelProps {
  /** Leave the reset flow; `notice` is shown on the PIN screen after a successful reset. */
  onDone: (notice?: string) => void;
}

interface SentCode {
  recipient: string;
  requestId: string;
}

/** Forgot-PIN flow: email a one-time code, then set a new PIN with it. */
export function PinResetPanel({ onDone }: PinResetPanelProps) {
  const [step, setStep] = useState<'request' | 'confirm'>('request');
  const [sent, setSent] = useState<SentCode | null>(null);
  const [code, setCode] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const sendCode = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    const response = await requestAdminPinReset();
    setBusy(false);
    if (!response.success) {
      setError(response.error.message);
      return;
    }
    if (step === 'confirm') setNotice('A new code was sent. Earlier codes no longer work.');
    setCode('');
    setSent({ recipient: response.recipient, requestId: response.requestId });
    setStep('confirm');
  };

  const resetPin = async (event: FormEvent) => {
    event.preventDefault();
    if (newPin !== confirmPin) {
      setError('The two new PIN entries do not match.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    const response = await confirmAdminPinReset(code, newPin);
    setBusy(false);
    if (!response.success) {
      setError(response.error.message);
      return;
    }
    onDone(PIN_RESET_SUCCESS);
  };

  const errorLine = error && (
    <p className="setup-error" role="alert">
      {error}
    </p>
  );
  const backButton = (
    <button className="text-button" type="button" onClick={() => onDone()} disabled={busy}>
      Back to unlock
    </button>
  );

  if (step === 'request') {
    return (
      <form
        className="setup-form"
        aria-label="Reset admin PIN"
        onSubmit={(event) => {
          event.preventDefault();
          void sendCode();
        }}
      >
        <p className="setup-copy">
          Forgot the administrator PIN? We will email a one-time reset code to the company inbox.
          The code works for 15 minutes.
        </p>
        {errorLine}
        <button className="submit-button setup-submit" type="submit" disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={17} /> : <Mail size={17} />} Email reset code
        </button>
        <button
          className="text-button"
          type="button"
          onClick={() => {
            setError('');
            setStep('confirm');
          }}
          disabled={busy}
        >
          I already have a code
        </button>
        {backButton}
      </form>
    );
  }

  return (
    <form className="setup-form" onSubmit={resetPin} aria-label="Set new admin PIN">
      <p className="setup-copy">
        {sent ? (
          <>
            A reset code was sent to <strong>{sent.recipient}</strong>. Use the email with request ID{' '}
            <strong>{sent.requestId}</strong>.
          </>
        ) : (
          'Enter the newest reset code from the company inbox.'
        )}
      </p>
      <label>
        Reset code
        <input
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
      </label>
      <label>
        New PIN (6 to 12 digits)
        <input
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          maxLength={12}
          value={newPin}
          onChange={(event) => setNewPin(event.target.value)}
        />
      </label>
      <label>
        Confirm new PIN
        <input
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          maxLength={12}
          value={confirmPin}
          onChange={(event) => setConfirmPin(event.target.value)}
        />
      </label>
      {notice && <p className="setup-success">{notice}</p>}
      {errorLine}
      <button
        className="submit-button setup-submit"
        type="submit"
        disabled={busy || !code.trim() || !newPin || !confirmPin}
      >
        {busy ? <LoaderCircle className="spin" size={17} /> : <KeyRound size={17} />} Set new PIN
      </button>
      <button className="text-button" type="button" onClick={() => void sendCode()} disabled={busy}>
        Send a new code
      </button>
      {backButton}
    </form>
  );
}
