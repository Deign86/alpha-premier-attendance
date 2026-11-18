import { useState } from 'react';
import type { FormEvent } from 'react';
import { LoaderCircle, LockKeyhole } from 'lucide-react';
import { requestAccountPasswordReset, unlockAdminWithAccount } from './api';
import { NoticeLine } from './notice';

export const RESET_SENT =
  'If that address has a Keystone account, a reset email is on its way. Open it on any device, choose a new password, then sign in here.';

interface AccountSignInPanelProps {
  /** The admin screens are open until `expiresAt`; `token` is the session's, for the card-setup pop-up. */
  onUnlocked: (expiresAt: string, token: string) => void;
  /** Back to the admin card. */
  onBack: () => void;
}

/** Opens the admin screens with the person's own Keystone account, and asks for a reset email for a forgotten password. */
export function AccountSignInPanel({ onUnlocked, onBack }: AccountSignInPanelProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const signIn = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    const response = await unlockAdminWithAccount(email, password);
    // A typed password is never kept past the try it was typed for.
    setPassword('');
    setBusy(false);
    if (!response.success) {
      setError(response.error.message);
      return;
    }
    onUnlocked(response.expiresAt, response.token);
  };

  const forgot = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    setPassword('');
    const response = await requestAccountPasswordReset(email);
    setBusy(false);
    if (!response.success) {
      setError(response.error.message);
      return;
    }
    setNotice(RESET_SENT);
  };

  return (
    <form className="setup-form" aria-label="Sign in with your Keystone account" onSubmit={signIn}>
      <p className="setup-copy">
        Sign in with your own Keystone email and password. The CEO decides in Keystone who is an attendance admin.
      </p>
      <label>
        Email
        <input autoFocus type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} />
      </label>
      <label>
        Password
        <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
      </label>
      <NoticeLine notice={error ? { tone: 'error', text: error } : null} />
      <button className="submit-button setup-submit" type="submit" disabled={busy || !email.trim() || !password}>
        {busy ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : <LockKeyhole size={17} aria-hidden="true" />} Sign in
      </button>
      <NoticeLine notice={notice ? { tone: 'success', text: notice } : null} />
      <button className="text-button" type="button" onClick={() => void forgot()} disabled={busy}>
        Forgot password?
      </button>
      <button className="text-button" type="button" onClick={onBack} disabled={busy}>
        Back to admin card
      </button>
    </form>
  );
}
