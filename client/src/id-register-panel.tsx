import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import type { IdRegisterStatus } from '@rfid-attendance/shared';
import { tauriApi } from './tauri-api';
import { nativeAdminSessionToken } from './api';
import { formatDateTime } from './format';
import { NoticeLine } from './notice';

/** What the kiosk says when a register command itself fails (the register's own problems come in plain words). */
function problemText<T>(error: T): string {
  const text = error instanceof Error ? error.message : String(error);
  if (text.includes('ADMIN_AUTH_REQUIRED')) return 'The administrator session ended. Unlock Admin again.';
  return text || 'The ID register could not be asked.';
}

/**
 * System: the kiosk's connection to the ID register. New interns issued a card by the ID Maker arrive in Users on
 * their own, waiting for a card. The kiosk signs in once with its own account; the password is not kept. While signed
 * in, the kiosk also keeps a copy of its records in the shared backend, and says here how far that has got.
 */
export function IdRegisterPanel() {
  // The register is read by the desktop app only.
  const desktop = '__TAURI_INTERNALS__' in window;
  const [status, setStatus] = useState<IdRegisterStatus | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (ask: (token: string) => Promise<IdRegisterStatus>) => {
    setBusy(true);
    setError('');
    try {
      setStatus(await ask(nativeAdminSessionToken()));
      return true;
    } catch (failure) {
      setError(problemText(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void tauriApi
      .idRegisterStatus(nativeAdminSessionToken())
      .then((loaded) => {
        if (active) setStatus(loaded);
      })
      .catch((failure) => {
        if (active) setError(problemText(failure));
      });
    return () => {
      active = false;
    };
  }, [desktop]);

  const signIn = async (event: FormEvent) => {
    event.preventDefault();
    const signedIn = await run((token) => tauriApi.idRegisterSignIn(token, email.trim(), password));
    // The password is cleared either way; the email stays for another try.
    setPassword('');
    if (signedIn) setEmail('');
  };

  const heading = <h2 id="id-register-heading">ID register</h2>;
  const errorLine = <NoticeLine notice={error ? { tone: 'error', text: error } : null} />;

  if (!desktop || (status && !status.builtIn)) {
    return (
      <section className="lan-panel system-panel" aria-labelledby="id-register-heading">
        {heading}
        <p className="reset-hint">
          {desktop ? 'The ID register is not built into this copy of the app.' : 'Only in the desktop app.'}
        </p>
      </section>
    );
  }

  if (!status) {
    return (
      <section className="lan-panel system-panel" aria-labelledby="id-register-heading">
        {heading}
        {error ? errorLine : <p className="reset-hint">Checking…</p>}
      </section>
    );
  }

  const waitingLine =
    status.waiting > 0 ? (
      <p className="reset-hint">
        {status.waiting === 1 ? '1 person is' : `${status.waiting} people are`} waiting for a card. Give each a card in
        Users.
      </p>
    ) : null;

  if (!status.signedInAs) {
    return (
      <section className="lan-panel system-panel" aria-labelledby="id-register-heading">
        {heading}
        <p className="reset-hint">
          Sign in once with this kiosk&apos;s register account. New interns given an ID then appear in Users on their
          own, waiting for a card. The password is not kept.
        </p>
        <NoticeLine notice={status.problem ? { tone: 'error', text: status.problem } : null} />
        <form className="setup-form" aria-label="Sign in to the ID register" onSubmit={(event) => void signIn(event)}>
          <label>
            Kiosk account email
            <input
              type="email"
              autoComplete="off"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {errorLine}
          <button className="admin-button" type="submit" disabled={busy || !email.trim() || !password}>
            {busy && <LoaderCircle className="spin" size={15} aria-hidden="true" />} Sign in
          </button>
        </form>
        {waitingLine}
      </section>
    );
  }

  return (
    <section className="lan-panel system-panel" aria-labelledby="id-register-heading">
      {heading}
      <div className="system-row">
        <span className="system-version">
          Signed in as {status.signedInAs}
          {status.lastCheckedAt ? ` · last checked ${formatDateTime(status.lastCheckedAt)}` : ''}
        </span>
        <button className="admin-button" type="button" disabled={busy} onClick={() => void run(tauriApi.idRegisterCheck)}>
          {busy ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
          Check now
        </button>
      </div>
      <NoticeLine notice={status.problem ? { tone: 'error', text: status.problem } : null} />
      {errorLine}
      {waitingLine}
      <p className="reset-hint">
        Backup: {status.backup.backedUp.toLocaleString('en-PH')} of {status.backup.records.toLocaleString('en-PH')}{' '}
        records are in the shared backend
        {status.backup.lastCompleteAt ? `, complete as of ${formatDateTime(status.backup.lastCompleteAt)}` : ''}.{' '}
        {status.backup.mainRecordSince
          ? `Firebase has been the main record since ${formatDateTime(status.backup.mainRecordSince)}; this computer keeps a working copy.`
          : 'This computer keeps the originals until Firebase has been counted equal.'}
      </p>
      <NoticeLine notice={status.backup.problem ? { tone: 'error', text: status.backup.problem } : null} />
      <button className="text-button" type="button" disabled={busy} onClick={() => void run(tauriApi.idRegisterSignOut)}>
        Sign out of the ID register
      </button>
    </section>
  );
}
