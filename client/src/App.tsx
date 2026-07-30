import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, CircleAlert, CreditCard, Keyboard, LoaderCircle, LockKeyhole, ShieldCheck, UserRound, Volume2, VolumeX, X } from 'lucide-react';
import type { ScanErrorResponse, ScanSuccessResponse, SetupUser, AttendanceListItem } from '@rfid-attendance/shared';
import { DEFAULT_CONFIG, checkAdminSession, deleteAdminAttendance, deleteAdminUser, loadConfig, loadAttendance, loadAdminAttendance, loadAdminUsers, lockAdmin, lockSetup, lookupSetupCard, saveAdminAttendance, saveAdminUser, submitScan, unlockAdmin, unlockSetup, uploadSetupPhoto, upsertSetupUser } from './api';
import './styles.css';

type KioskState = 'ready' | 'processing' | 'success' | 'error';
type Result = ScanSuccessResponse | ScanErrorResponse;
type SetupStep = 'scan' | 'edit';
type SetupForm = { userId: string; fullName: string; department: string; status: SetupUser['status']; employeeType: SetupUser['employeeType']; dailyRate: string; photoUrl: string };
const emptySetupForm: SetupForm = { userId: '', fullName: '', department: '', status: 'ACTIVE', employeeType: 'INTERN', dailyRate: '', photoUrl: '' };

const stateCopy: Record<KioskState, { eyebrow: string; title: string }> = {
  ready: { eyebrow: 'Scanner ready', title: 'Tap your card to begin' },
  processing: { eyebrow: 'Reading card', title: 'Checking your attendance' },
  success: { eyebrow: 'Attendance recorded', title: 'You are all set' },
  error: { eyebrow: 'Could not record scan', title: 'Please try again' },
};

export default function App() {
  const path = window.location.pathname;
  if (path === '/attendance') return <LiveAttendance />;
  if (path === '/admin') return <AdminPanel />;
  const [state, setState] = useState<KioskState>('ready');
  const [uid, setUid] = useState('');
  const [manualMode, setManualMode] = useState(false);
  const [manualUid, setManualUid] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [now, setNow] = useState(() => new Date());
  const scannerRef = useRef<HTMLInputElement>(null);
  const manualRef = useRef<HTMLInputElement>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestController = useRef<AbortController | null>(null);
  const lastInputAt = useRef(0);
  const lastInputLength = useRef(0);
  const rapidCharacterCount = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const [setupToken, setSetupToken] = useState('');
  const [setupExpiresAt, setSetupExpiresAt] = useState('');
  const [setupDialogOpen, setSetupDialogOpen] = useState(false);
  const [setupStep, setSetupStep] = useState<SetupStep>('scan');
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupError, setSetupError] = useState('');
  const [adminPin, setAdminPin] = useState('');
  const [setupUid, setSetupUid] = useState('');
  const [setupUser, setSetupUser] = useState<SetupUser | null>(null);
  const [setupForm, setSetupForm] = useState<SetupForm>(emptySetupForm);
  const setupInputRef = useRef<HTMLInputElement>(null);
  const setupIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setupSessionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void loadConfig(controller.signal).then(setConfig);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const focusActiveInput = useCallback(() => {
    window.requestAnimationFrame(() => {
      (manualMode ? manualRef.current : scannerRef.current)?.focus();
    });
  }, [manualMode]);

  const focusSetupInput = useCallback(() => {
    window.requestAnimationFrame(() => setupInputRef.current?.focus());
  }, []);

  useEffect(() => {
    focusActiveInput();
  }, [focusActiveInput]);

  useEffect(() => {
    const reclaim = () => { if (!manualMode && document.visibilityState === 'visible' && stateRef.current === 'ready' && !setupDialogOpen) focusActiveInput(); };
    window.addEventListener('focus', reclaim); document.addEventListener('visibilitychange', reclaim);
    return () => { window.removeEventListener('focus', reclaim); document.removeEventListener('visibilitychange', reclaim); };
  }, [focusActiveInput, manualMode, setupDialogOpen]);

  useEffect(() => () => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    requestController.current?.abort();
    if (setupIdleTimer.current) clearTimeout(setupIdleTimer.current);
    if (setupSessionTimer.current) clearTimeout(setupSessionTimer.current);
  }, []);

  useEffect(() => {
    if (!setupToken || !setupExpiresAt) return;
    const remaining = new Date(setupExpiresAt).getTime() - Date.now();
    if (remaining <= 0) {
      setSetupToken('');
      setSetupExpiresAt('');
      setSetupDialogOpen(false);
      setSetupError('Setup session expired. Unlock again to continue.');
      return;
    }
    if (setupSessionTimer.current) clearTimeout(setupSessionTimer.current);
    setupSessionTimer.current = setTimeout(() => {
      setSetupToken('');
      setSetupExpiresAt('');
      setSetupDialogOpen(false);
      setSetupError('Setup session expired. Unlock again to continue.');
    }, remaining);
    return () => { if (setupSessionTimer.current) clearTimeout(setupSessionTimer.current); };
  }, [setupToken, setupExpiresAt]);

  const playTone = useCallback((kind: 'success' | 'error') => {
    if (!config.enableScanSounds || typeof window === 'undefined') return;
    const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;
    try {
      const context = new AudioContextCtor();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = kind === 'success' ? 880 : 220;
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.16);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.17);
      oscillator.addEventListener('ended', () => void context.close());
    } catch {
      // Audio is optional and can be blocked by kiosk browser policies.
    }
  }, [config.enableScanSounds]);

  const resetToReady = useCallback(() => {
    requestController.current?.abort();
    setState('ready');
    setResult(null);
    setUid('');
    setManualUid('');
    lastInputAt.current = 0;
    lastInputLength.current = 0;
    rapidCharacterCount.current = 0;
    focusActiveInput();
  }, [focusActiveInput]);

  const openSetup = useCallback((initialUid = '') => {
    setSetupDialogOpen(true);
    setSetupError('');
    if (initialUid) setSetupUid(initialUid);
    setAdminPin('');
    if (setupToken) {
      setSetupStep('scan');
      window.setTimeout(focusSetupInput, 0);
    }
  }, [focusSetupInput, setupToken]);

  const handleUnlock = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!adminPin.trim() || setupBusy) return;
    setSetupBusy(true);
    setSetupError('');
    const response = await unlockSetup(adminPin.trim());
    setSetupBusy(false);
    if (!response.success) {
      setSetupError(response.error.message);
      return;
    }
    setSetupToken(response.setupToken);
    setSetupExpiresAt(response.expiresAt);
    setAdminPin('');
    setSetupStep('scan');
    setSetupDialogOpen(true);
    window.setTimeout(focusSetupInput, 0);
  };

  const closeSetup = async () => {
    if (setupToken) void lockSetup(setupToken);
    if (setupIdleTimer.current) clearTimeout(setupIdleTimer.current);
    setSetupToken('');
    setSetupExpiresAt('');
    setSetupDialogOpen(false);
    setSetupStep('scan');
    setSetupUid('');
    setSetupUser(null);
    setSetupError('');
    setAdminPin('');
    setSetupForm(emptySetupForm);
    focusActiveInput();
  };

  const lookupCardForSetup = async (rawUid: string) => {
    const normalizedUid = rawUid.trim();
    if (!normalizedUid || !setupToken || setupBusy) return;
    if (setupIdleTimer.current) clearTimeout(setupIdleTimer.current);
    setSetupBusy(true);
    setSetupError('');
    const response = await lookupSetupCard(normalizedUid, setupToken);
    setSetupBusy(false);
    if (!response.success) {
      setSetupError(response.error.message);
      return;
    }
    setSetupUid(response.rfidUid);
    setSetupUser(response.user);
    setSetupForm(response.user ? {
      userId: response.user.userId,
      fullName: response.user.fullName,
      department: response.user.department ?? '',
      status: response.user.status,
      employeeType: response.user.employeeType ?? 'INTERN',
      dailyRate: response.user.dailyRate === null ? '' : String(response.user.dailyRate),
      photoUrl: response.user.photoUrl ?? '',
    } : emptySetupForm);
    setSetupStep('edit');
  };

  const handleSetupInput = (value: string) => {
    setSetupUid(value);
    if (setupIdleTimer.current) clearTimeout(setupIdleTimer.current);
    if (value.trim()) setupIdleTimer.current = setTimeout(() => void lookupCardForSetup(value), config.rfidAutoSubmitDelayMs);
  };

  const submitSetupUser = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!setupToken || !setupUid.trim() || !setupForm.userId.trim() || !setupForm.fullName.trim() || setupBusy) return;
    setSetupBusy(true);
    setSetupError('');
    const response = await upsertSetupUser({
      rfidUid: setupUid.trim(),
      userId: setupForm.userId.trim(),
      fullName: setupForm.fullName.trim(),
      department: setupForm.department.trim() || undefined,
      status: setupForm.status,
      employeeType: setupForm.employeeType,
      dailyRate: setupForm.employeeType === 'EMPLOYEE' ? Number(setupForm.dailyRate) : null,
      photoUrl: setupForm.photoUrl || null,
    }, setupToken);
    setSetupBusy(false);
    if (!response.success) {
      setSetupError(response.error.message);
      return;
    }
    setSetupUser(response.user);
    setSetupError(response.created ? 'Card enrolled successfully.' : 'Card configuration updated successfully.');
    setSetupStep('scan');
    setSetupUid('');
    setSetupForm(emptySetupForm);
    window.setTimeout(focusSetupInput, 0);
  };

  const uploadSetupPhotoFile = async (file: File) => {
    if (!setupToken || !setupForm.userId.trim()) { setSetupError('Enter the User ID before uploading a photo.'); return; }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5_000_000) { setSetupError('Choose a JPEG, PNG, or WebP photo up to 5 MB.'); return; }
    const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('Unable to read photo')); reader.readAsDataURL(file); });
    setSetupBusy(true); setSetupError('Uploading photo…');
    const response = await uploadSetupPhoto(setupForm.userId.trim(), dataUrl, setupToken);
    setSetupBusy(false);
    if (!response.success) { setSetupError(response.error.message); return; }
    setSetupForm((current) => ({ ...current, photoUrl: response.photoUrl })); setSetupError('Photo uploaded.');
  };

  const submit = useCallback(async (rawUid: string, source: 'RFID' | 'MANUAL_TEST') => {
    const normalizedUid = rawUid.trim();
    if (!normalizedUid || stateRef.current === 'processing') return;
    if (idleTimer.current) clearTimeout(idleTimer.current);
    setState('processing');
    setResult(null);
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    const response = await submitScan({ rfidUid: normalizedUid, source }, controller.signal);
    if (controller.signal.aborted) return;
    requestController.current = null;
    setResult(response);
    const nextState = response.success ? 'success' : 'error';
    setState(nextState);
    playTone(nextState);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(resetToReady, config.resultResetDelayMs);
  }, [config.resultResetDelayMs, playTone, resetToReady]);

  const handleScannerChange = (value: string) => {
    setUid(value);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    const now = performance.now();
    const gap = lastInputAt.current === 0 ? Number.POSITIVE_INFINITY : now - lastInputAt.current;
    const isAppend = value.length > lastInputLength.current;
    rapidCharacterCount.current = isAppend && gap <= 75 ? rapidCharacterCount.current + 1 : isAppend ? 1 : 0;
    lastInputAt.current = now;
    lastInputLength.current = value.length;
    if (value.trim() && rapidCharacterCount.current >= 4) idleTimer.current = setTimeout(() => void submit(value, 'RFID'), config.rfidAutoSubmitDelayMs);
  };

  const handleScannerKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void submit(uid, 'RFID');
  };

  const toggleManualMode = () => {
    if (state !== 'ready') return;
    setManualMode((current) => !current);
    setUid('');
    setManualUid('');
  };

  const displayDate = new Intl.DateTimeFormat('en-PH', {
    timeZone: config.timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(now);
  const displayTime = new Intl.DateTimeFormat('en-PH', {
    timeZone: config.timezone,
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(now);

  const success = result?.success ? result : null;
  const error = result && !result.success ? result : null;
  const copy = stateCopy[state];

  return (
    <main className={`kiosk-shell state-${state}`}>
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><span>AP</span></div>
          <div>
            <p className="brand-name">ALPHA PREMIER</p>
            <p className="brand-subtitle">GROUP OF COMPANIES</p>
          </div>
        </div>
        <div className="clock" aria-label={`Current time in ${config.timezone}`}>
          <span>MANILA TIME</span>
          <strong>{displayTime}</strong>
        </div>
      </header>

      <section className="kiosk-content" aria-labelledby="kiosk-heading">
        <div className="intro-copy">
          <p className="section-kicker">Workforce access</p>
          <h1 id="kiosk-heading">{copy.title}</h1>
          <p className="section-description">Secure attendance for the Alpha Premier Group of Companies.</p>
        </div>

        <div className="kiosk-grid">
        <div className="scanner-column">
        <div className="scanner-panel">
          <div className={`status-icon icon-${state}`} aria-hidden="true">
            {state === 'processing' && <LoaderCircle className="spin" size={34} />}
            {state === 'success' && <Check size={38} />}
            {state === 'error' && <CircleAlert size={38} />}
            {state === 'ready' && <CreditCard size={38} />}
          </div>
          <p className="status-eyebrow">{copy.eyebrow}</p>

          {state === 'success' && success ? (
            <div className="result-details" role="status" aria-live="polite">
              {success.user.photoUrl ? <img className="result-photo" src={success.user.photoUrl} alt={`${success.user.fullName} ID`} /> : <div className="result-photo result-photo-fallback" aria-label="ID photo unavailable"><UserRound size={72} /></div>}
              <h2>{success.user.fullName}</h2>
              <p>{success.message}</p>
              <p className="result-user-id">{success.user.userId}{success.user.department ? ` · ${success.user.department}` : ''}</p>
              <div className="result-meta"><span className="employee-badge">{success.user.employeeType}</span><span>{formatAction(success.action)}</span><span>{formatTime(success.attendance.timeOut ?? success.attendance.timeIn, config.timezone)}</span></div>
            </div>
          ) : state === 'error' && error ? (
            <div className="result-details" role="alert" aria-live="assertive">
              <h2>{error.error.message}</h2>
              <p className="error-code">{error.error.code.replaceAll('_', ' ')}</p>
              {error.error.code === 'UNKNOWN_RFID_CARD' && config.enableCardSetup && <button className="setup-card-button" type="button" onClick={() => openSetup(uid)}><ShieldCheck size={17} /> Setup this card</button>}
            </div>
          ) : (
            <div className="input-area">
              <label htmlFor={manualMode ? 'manual-uid' : 'scanner-uid'}>{manualMode ? 'Manual card ID' : 'Scanner card ID'}</label>
              <div className="input-row">
                <input
                  ref={manualMode ? manualRef : scannerRef}
                  id={manualMode ? 'manual-uid' : 'scanner-uid'}
                  className={manualMode ? undefined : 'rfid-capture-input'}
                  aria-label={manualMode ? 'Manual card ID' : 'Scanner card ID'}
                  value={manualMode ? manualUid : uid}
                  onChange={(event) => manualMode ? setManualUid(event.target.value) : handleScannerChange(event.target.value)}
                  onKeyDown={manualMode ? (event) => event.key === 'Enter' && (event.preventDefault(), void submit(manualUid, 'MANUAL_TEST')) : handleScannerKeyDown}
                  placeholder={manualMode ? 'Enter a UID to test' : 'Waiting for card reader…'}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={state !== 'ready'}
                  autoFocus={!manualMode}
                />
                {manualMode && <button className="submit-button" type="button" onClick={() => void submit(manualUid, 'MANUAL_TEST')} disabled={!manualUid.trim()}><ArrowRight size={18} /> Record attendance</button>}
              </div>
              {manualMode && <p className="input-hint"><Keyboard size={14} /> Press Enter or use the button to submit</p>}
            </div>
          )}

          {(state === 'success' || state === 'error') && <p className="reset-hint">Returning to ready mode in a few seconds…</p>}
        </div>

        <div className="panel-actions">
          <button className="mode-button" type="button" onClick={toggleManualMode} disabled={state !== 'ready'} aria-pressed={manualMode}>
            {manualMode ? <CreditCard size={17} /> : <Keyboard size={17} />}
            {manualMode ? 'Use card reader' : 'Manual UID'}
          </button>
          <span className="sound-indicator" title={config.enableScanSounds ? 'Scan sounds enabled' : 'Scan sounds disabled'}>
            {config.enableScanSounds ? <Volume2 size={16} /> : <VolumeX size={16} />}
            {config.enableScanSounds ? 'Sounds on' : 'Sounds off'}
          </span>
          <a className="admin-button" href="/attendance">Live attendance</a>
          {config.enableAdmin && <a className="admin-button" href="/admin">Admin panel</a>}
          {config.enableCardSetup && <button className="admin-button" type="button" onClick={() => openSetup()}><LockKeyhole size={15} /> Admin setup</button>}
        </div>
        </div>

        <aside className="terminal-aside" aria-label="Terminal controls">
          <p className="aside-kicker">Terminal control</p>
          <h2>People first.<br />Precision always.</h2>
          <p className="aside-copy">Each card is paired with one employee record before attendance can be recorded.</p>
          <div className="aside-facts">
            <div><span>LOCATION</span><strong>PH / MANILA</strong></div>
            <div><span>STATUS</span><strong className="status-live"><i /> ONLINE</strong></div>
          </div>
          <div className="aside-admin">
            <p className="aside-kicker">Employee mapping</p>
            <p className="aside-copy">Associate a new RFID card with its employee profile.</p>
            {config.enableCardSetup ? <span className="setup-ready"><ShieldCheck size={14} /> Setup available above</span> : <span className="setup-locked"><LockKeyhole size={14} /> Setup locked</span>}
          </div>
        </aside>
        </div>
      </section>

      <footer className="footer-note"><span className="online-dot" aria-hidden="true" /> Securely connected · {config.timezone}</footer>
      {setupDialogOpen && <SetupDialog
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
         onScanAnother={() => { setSetupStep('scan'); setSetupUid(''); setSetupUser(null); setSetupError(''); setSetupForm(emptySetupForm); window.setTimeout(focusSetupInput, 0); }}
        onUidEnter={(event) => { if (event.key === 'Enter') { event.preventDefault(); void lookupCardForSetup(setupUid); } }}
         onFormChange={(field, value) => setSetupForm((current) => ({ ...current, [field]: value }))}
         onPhotoFile={(file) => void uploadSetupPhotoFile(file)}
        onUpsert={submitSetupUser}
        onClose={closeSetup}
      />}
    </main>
  );
}

function formatAction(action: ScanSuccessResponse['action']) {
  return action === 'TIME_IN' ? 'Time in' : 'Time out';
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
  return (
    <div className="setup-backdrop" role="presentation">
      <section className="setup-dialog" role="dialog" aria-modal="true" aria-labelledby="setup-heading">
        <div className="setup-dialog-header">
          <div className="setup-title-wrap"><div className="setup-icon" aria-hidden="true"><ShieldCheck size={21} /></div><div><p className="section-kicker">Secure user mapping</p><h2 id="setup-heading">Associate RFID card</h2></div></div>
          <button className="icon-button" type="button" onClick={props.onClose} aria-label="Close card setup"><X size={19} /></button>
        </div>
        {!props.token ? (
          <form className="setup-form" onSubmit={props.onUnlock}>
            <div className="setup-steps" aria-label="Card association steps"><span className="is-active">01 Unlock</span><span>02 Scan card</span><span>03 Save user</span></div>
            <p className="setup-copy">Enter the administrator PIN to associate a card with an employee. Example: Deign Lazaro, IT / Admin.</p>
            <label htmlFor="admin-pin">Administrator PIN</label>
            <input id="admin-pin" type="password" inputMode="numeric" autoComplete="off" value={props.pin} onChange={(event) => props.onPinChange(event.target.value)} autoFocus />
            {props.error && <p className="setup-error" role="alert">{props.error}</p>}
            <button className="submit-button setup-submit" type="submit" disabled={props.busy || !props.pin.trim()}>{props.busy ? <LoaderCircle className="spin" size={17} /> : <LockKeyhole size={17} />} Unlock setup</button>
          </form>
        ) : props.step === 'scan' ? (
          <div className="setup-form">
            <p className="setup-copy">Scan the employee card now. Existing cards open with their current details; new cards start with a blank profile.</p>
            <label htmlFor="setup-card-uid">Card ID</label>
            <input ref={props.inputRef} id="setup-card-uid" aria-label="Setup card ID" value={props.uid} onChange={(event) => props.onUidChange(event.target.value)} onKeyDown={props.onUidEnter} placeholder="Waiting for card reader…" autoComplete="off" spellCheck={false} disabled={props.busy} />
            {props.busy && <p className="setup-progress"><LoaderCircle className="spin" size={15} /> Looking up card…</p>}
            {props.error && <p className={props.error.includes('successfully') ? 'setup-success' : 'setup-error'} role="status">{props.error}</p>}
            <div className="setup-footer"><span><UserRound size={15} /> {props.user ? 'Existing user' : 'New card enrollment'}</span><button className="text-button" type="button" onClick={props.onClose}>Lock setup</button></div>
          </div>
        ) : (
          <form className="setup-form" onSubmit={props.onUpsert}>
            <div className="card-badge"><CreditCard size={15} /> {props.uid}<span>{props.user ? 'Existing card' : 'New card'}</span></div>
            <p className="setup-copy">Review the profile before saving. Saving here changes the Users register only; it does not create attendance.</p>
            <div className="setup-fields">
              <label>User ID<input value={props.form.userId} onChange={(event) => props.onFormChange('userId', event.target.value)} autoComplete="off" required /></label>
              <label>Full name<input value={props.form.fullName} onChange={(event) => props.onFormChange('fullName', event.target.value)} autoComplete="name" required /></label>
              <label>Department / role <span className="optional">optional</span><input placeholder="IT / Admin" value={props.form.department} onChange={(event) => props.onFormChange('department', event.target.value)} autoComplete="organization" /></label>
               <label>Status<select value={props.form.status} onChange={(event) => props.onFormChange('status', event.target.value)}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></select></label>
               <label className="employee-type-toggle">Employee type <button type="button" role="switch" aria-checked={props.form.employeeType === 'EMPLOYEE'} onClick={() => props.onFormChange('employeeType', props.form.employeeType === 'INTERN' ? 'EMPLOYEE' : 'INTERN')}><span>INTERN</span><strong>{props.form.employeeType === 'EMPLOYEE' ? 'EMPLOYEE' : 'INTERN'}</strong></button></label>
               {props.form.employeeType === 'EMPLOYEE' && <label>Daily rate (PHP)<input type="number" min="0.01" step="0.01" required value={props.form.dailyRate} onChange={(event) => props.onFormChange('dailyRate', event.target.value)} /></label>}
               <label>ID photo<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) props.onPhotoFile(file); }} />{props.form.photoUrl && <small className="setup-success">Photo ready</small>}</label>
            </div>
            {props.error && <p className={props.error.includes('successfully') ? 'setup-success' : 'setup-error'} role="status">{props.error}</p>}
            <div className="setup-footer"><button className="text-button" type="button" onClick={props.onScanAnother}>Scan another card</button><button className="submit-button" type="submit" disabled={props.busy || !props.form.userId.trim() || !props.form.fullName.trim() || (props.form.employeeType === 'EMPLOYEE' && Number(props.form.dailyRate) <= 0)}>{props.busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />} Save user</button></div>
          </form>
        )}
      </section>
    </div>
  );
}

function formatTime(value: string, timezone: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-PH', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true }).format(date);
}

function localDate(timezone = 'Asia/Manila') { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date()); }

function LiveAttendance() {
  const [rows, setRows] = useState<AttendanceListItem[]>([]);
  const [stale, setStale] = useState(false);
  const [fetchedAt, setFetchedAt] = useState('');
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try { const response = await loadAttendance(); if (response.success) { setRows(response.attendance); setFetchedAt(response.fetchedAt); setStale(false); setError(''); } else throw new Error('Unable to load attendance'); } catch { setStale(true); setError('Live attendance is temporarily unavailable.'); }
  }, []);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 5_000); const onFocus = () => void refresh(); window.addEventListener('focus', onFocus); return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus); }; }, [refresh]);
  return <main className="dashboard-shell"><header className="dashboard-header"><div><p className="section-kicker">Live attendance</p><h1>Today’s timing</h1><p className="section-description">{localDate()} · updates every five seconds</p></div><nav><a href="/">Scanner</a><a href="/admin">Admin</a></nav></header>{error && <p className="dashboard-alert">{error}</p>}<div className="dashboard-status">{stale ? 'Showing last successful update' : `Last updated ${fetchedAt ? formatTime(fetchedAt, 'Asia/Manila') : 'just now'}`}</div><AttendanceTable rows={rows} timezone="Asia/Manila" /></main>;
}

function AttendanceTable({ rows, timezone }: { rows: AttendanceListItem[]; timezone: string }) {
  if (!rows.length) return <div className="empty-state">No attendance has been recorded today.</div>;
  return <div className="table-wrap"><table><thead><tr><th>Employee</th><th>Department</th><th>Time in</th><th>Time out</th><th>Status</th></tr></thead><tbody>{rows.map((row) => <tr key={row.attendanceId}><td><strong>{row.fullName}</strong><small>{row.userId}</small></td><td>{row.department || '—'}</td><td>{row.timeIn ? formatTime(row.timeIn, timezone) : '—'}</td><td>{row.timeOut ? formatTime(row.timeOut, timezone) : '—'}</td><td><span className={`status-pill status-${row.status.toLowerCase()}`}>{row.status}</span></td></tr>)}</tbody></table></div>;
}

function AdminPanel() {
  const [unlocked, setUnlocked] = useState(false); const [sessionExpiresAt, setSessionExpiresAt] = useState(''); const [pin, setPin] = useState(''); const [error, setError] = useState(''); const [tab, setTab] = useState<'users' | 'attendance'>('users');
  const [users, setUsers] = useState<AdminUser[]>([]); const [rows, setRows] = useState<AttendanceListItem[]>([]); const [date, setDate] = useState(localDate());
  const [editing, setEditing] = useState<AdminUser | null>(null); const [busy, setBusy] = useState(false);
  const unlock = async (event: React.FormEvent) => { event.preventDefault(); setBusy(true); const response = await unlockAdmin(pin); setBusy(false); if (!response.success) { setError(response.error.message); return; } setUnlocked(true); setSessionExpiresAt(response.expiresAt); setError(''); };
  const load = useCallback(async () => { try { const [userResponse, attendanceResponse] = await Promise.all([loadAdminUsers(), loadAdminAttendance(date)]); if (userResponse.success) setUsers(userResponse.users); if (attendanceResponse.success) setRows(attendanceResponse.attendance); } catch { setError('Unable to load administrator data.'); } }, [date]);
  useEffect(() => { void checkAdminSession().then((expiresAt) => { setSessionExpiresAt(expiresAt ?? ''); setUnlocked(Boolean(expiresAt)); }); }, []);
  useEffect(() => {
    if (!unlocked || !sessionExpiresAt) return;
    const remaining = new Date(sessionExpiresAt).getTime() - Date.now();
    if (remaining <= 0) { void lockAdmin(); setUnlocked(false); setSessionExpiresAt(''); setError('Admin session expired. Please unlock again.'); return; }
    const timer = window.setTimeout(() => { void lockAdmin(); setUnlocked(false); setSessionExpiresAt(''); setError('Admin session expired. Please unlock again.'); }, remaining);
    return () => window.clearTimeout(timer);
  }, [sessionExpiresAt, unlocked]);
  useEffect(() => { if (unlocked) void load(); }, [unlocked, load]);
  if (!unlocked) return <main className="dashboard-shell admin-login"><a href="/">← Scanner</a><form onSubmit={unlock}><p className="section-kicker">Administrator access</p><h1>Manage attendance</h1><label>Administrator PIN<input autoFocus type="password" value={pin} onChange={(event) => setPin(event.target.value)} /></label>{error && <p className="dashboard-alert">{error}</p>}<button className="submit-button" disabled={busy || !pin}>Unlock admin</button></form></main>;
  return <main className="dashboard-shell"><header className="dashboard-header"><div><p className="section-kicker">Administrator access</p><h1>Manage attendance</h1></div><nav><a href="/">Scanner</a><a href="/attendance">Live view</a><button className="text-button" type="button" onClick={() => { void lockAdmin(); setUnlocked(false); setSessionExpiresAt(''); }}>Lock</button></nav></header><div className="admin-tabs"><button className={tab === 'users' ? 'is-active' : ''} onClick={() => setTab('users')}>Users and RFID</button><button className={tab === 'attendance' ? 'is-active' : ''} onClick={() => setTab('attendance')}>Attendance corrections</button></div>{error && <p className="dashboard-alert">{error}</p>}{tab === 'users' ? <UserEditor users={users} editing={editing} setEditing={setEditing} onSaved={load} /> : <AdminAttendance rows={rows} date={date} setDate={setDate} onSaved={load} />}</main>;
}

type AdminUser = { userId: string; rfidUid: string; fullName: string; department: string | null; status: 'ACTIVE' | 'INACTIVE' };
function UserEditor({ users, editing, setEditing, onSaved }: { users: AdminUser[]; editing: AdminUser | null; setEditing: (user: AdminUser | null) => void; onSaved: () => void }) {
  const [form, setForm] = useState<AdminUser>(editing ?? { userId: '', rfidUid: '', fullName: '', department: '', status: 'ACTIVE' });
  const [message, setMessage] = useState('');
  const [deletingUserId, setDeletingUserId] = useState('');
  useEffect(() => setForm(editing ?? { userId: '', rfidUid: '', fullName: '', department: '', status: 'ACTIVE' }), [editing]);
  const save = async (event: React.FormEvent) => { event.preventDefault(); const response = await saveAdminUser(form, editing?.userId); if ((response as { success?: boolean }).success) { setMessage('Saved.'); setEditing(null); onSaved(); } else setMessage((response as { error?: { message?: string } }).error?.message ?? 'Unable to save user.'); };
  const remove = async (user: AdminUser) => { if (!window.confirm(`Delete ${user.fullName} and remove their RFID assignment? Existing attendance records will remain.`)) return; setDeletingUserId(user.userId); const response = await deleteAdminUser(user.userId); setDeletingUserId(''); if ((response as { success?: boolean }).success) { if (editing?.userId === user.userId) setEditing(null); setMessage('User deleted.'); onSaved(); } else setMessage((response as { error?: { message?: string } }).error?.message ?? 'Unable to delete user.'); };
  return <div className="admin-grid"><section className="admin-form"><h2>{editing ? 'Edit user' : 'Add user'}</h2><form onSubmit={save}><label>User ID<input required disabled={Boolean(editing)} value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })} /></label><label>RFID UID<input required value={form.rfidUid} onChange={(e) => setForm({ ...form, rfidUid: e.target.value })} /></label><label>Full name<input required value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} /></label><label>Department<input value={form.department ?? ''} onChange={(e) => setForm({ ...form, department: e.target.value })} /></label><label>Status<select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as AdminUser['status'] })}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></select></label>{message && <p className="dashboard-alert">{message}</p>}<button className="submit-button" type="submit">Save user</button></form></section><section><div className="table-wrap"><table><thead><tr><th>User</th><th>RFID</th><th>Status</th><th /></tr></thead><tbody>{users.map((user) => <tr key={user.userId}><td><strong>{user.fullName}</strong><small>{user.userId}</small></td><td>{user.rfidUid}</td><td>{user.status}</td><td><button className="text-button" onClick={() => setEditing(user)}>Edit</button><button className="text-button danger-button" disabled={deletingUserId === user.userId} onClick={() => void remove(user)}>{deletingUserId === user.userId ? 'Deleting...' : 'Delete'}</button></td></tr>)}</tbody></table></div></section></div>;
}

function AdminAttendance({ rows, date, setDate, onSaved }: { rows: AttendanceListItem[]; date: string; setDate: (value: string) => void; onSaved: () => void }) {
  return <section><label className="date-filter">Attendance date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label><div className="table-wrap"><table><thead><tr><th>Employee</th><th>Time in</th><th>Time out</th><th>Status</th><th /></tr></thead><tbody>{rows.map((row) => <AttendanceEditRow key={row.attendanceId} row={row} onSaved={onSaved} />)}</tbody></table></div></section>;
}

function AttendanceEditRow({ row, onSaved }: { row: AttendanceListItem; onSaved: () => void }) {
  const [timeIn, setTimeIn] = useState(row.timeIn ? row.timeIn.slice(11, 16) : ''); const [timeOut, setTimeOut] = useState(row.timeOut ? row.timeOut.slice(11, 16) : ''); const [message, setMessage] = useState(''); const [deleting, setDeleting] = useState(false);
  const save = async () => { const toIso = (value: string) => value ? `${row.attendanceDate}T${value}:00+08:00` : null; const response = await saveAdminAttendance(row.attendanceId, { attendanceDate: row.attendanceDate, timeIn: toIso(timeIn), timeOut: toIso(timeOut), expectedTimeIn: row.timeIn || null, expectedTimeOut: row.timeOut || null }); if ((response as { success?: boolean }).success) { setMessage('Saved'); onSaved(); } else setMessage((response as { error?: { message?: string } }).error?.message ?? 'Conflict'); };
  const remove = async () => { if (!window.confirm(`Delete ${row.fullName}'s ${row.attendanceDate} time-in/time-out record?`)) return; setDeleting(true); const response = await deleteAdminAttendance(row.attendanceId, row.attendanceDate); setDeleting(false); if ((response as { success?: boolean }).success) { setMessage('Record deleted'); onSaved(); } else setMessage((response as { error?: { message?: string } }).error?.message ?? 'Unable to delete record.'); };
  return <tr><td><strong>{row.fullName}</strong><small>{row.userId}</small></td><td><input aria-label={`Time in for ${row.fullName}`} type="time" value={timeIn} onChange={(e) => setTimeIn(e.target.value)} /></td><td><input aria-label={`Time out for ${row.fullName}`} type="time" value={timeOut} onChange={(e) => setTimeOut(e.target.value)} /></td><td>{row.status}</td><td><button className="text-button" onClick={() => void save()}>Save</button><button className="text-button danger-button" disabled={deleting} onClick={() => void remove()}>{deleting ? 'Deleting...' : 'Delete'}</button>{message && <small>{message}</small>}</td></tr>;
}
