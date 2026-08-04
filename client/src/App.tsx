import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, CircleAlert, CreditCard, ImagePlus, Keyboard, LoaderCircle, LockKeyhole, ShieldCheck, Upload, UserRound, Volume2, VolumeX, X } from 'lucide-react';
import type { ScanErrorResponse, ScanSuccessResponse, SetupUser, AttendanceListItem, PayrollCalculationProfile, PayrollCutoffRecord, OfficeIdentity } from '@rfid-attendance/shared';
import { DEFAULT_OFFICE_IDENTITY, resolveOfficeDisplay } from '@rfid-attendance/shared';
import { DEFAULT_CONFIG, checkAdminSession, deleteAdminAttendance, deleteAdminUser, exportAttendanceXlsx, exportPayrollCsv, exportPayrollXlsx, finalizePayrollCutoff, generatePayrollPayslipPdf, generatePayrollRegisterPdf, loadConfig, loadAttendance, loadAdminAttendance, loadAdminUsers, loadPayrollCutoffs, loadPayrollProfiles, lockAdmin, lockSetup, lookupSetupCard, nukeSheetsResync, photoSource, saveAdminAttendance, saveAdminUser, savePayrollCutoff, submitScan, unlockAdmin, unlockSetup, uploadSetupPhoto, upsertSetupUser } from './api';
import './styles.css';
import { listenForGlobalRfid } from './tauri-api';
import { GeneratedFileActions, type GeneratedFileResult } from './file-actions';

type KioskState = 'ready' | 'processing' | 'success' | 'error';
type Result = ScanSuccessResponse | ScanErrorResponse;
type SetupStep = 'scan' | 'edit';
type SetupForm = { userId: string; fullName: string; department: string; status: SetupUser['status']; employeeType: SetupUser['employeeType']; dailyRate: string; photoUrl: string };
const emptySetupForm: SetupForm = { userId: '', fullName: '', department: '', status: 'ACTIVE', employeeType: 'INTERN', dailyRate: '', photoUrl: '' };

export function shouldRouteGlobalRfidToSetup(dialogOpen: boolean, token: string, step: SetupStep): boolean {
  return dialogOpen && Boolean(token) && step === 'scan';
}

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

  const lookupCardForSetup = useCallback(async (rawUid: string) => {
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
  }, [setupBusy, setupToken]);

  const handleSetupInput = useCallback((value: string) => {
    setSetupUid(value);
    if (setupIdleTimer.current) clearTimeout(setupIdleTimer.current);
    if (value.trim()) setupIdleTimer.current = setTimeout(() => void lookupCardForSetup(value), config.rfidAutoSubmitDelayMs);
  }, [config.rfidAutoSubmitDelayMs, lookupCardForSetup]);

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
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > PHOTO_UPLOAD_MAX_BYTES) { setSetupError('Choose a JPEG, PNG, or WebP photo up to 500 KB.'); return; }
    let dataUrl: string;
    try { dataUrl = await preparePhotoDataUrl(file); } catch (error) { setSetupBusy(false); setSetupError(error instanceof Error ? error.message : 'Unable to prepare this photo.'); return; }
    setSetupBusy(true); setSetupError('Uploading photo…');
    const response = await uploadSetupPhoto(setupForm.userId.trim(), dataUrl, setupToken);
    setSetupBusy(false);
    if (!response.success) { setSetupError(response.error.message); return; }
    setSetupForm((current) => ({ ...current, photoUrl: response.photoUrl })); setSetupError('Photo uploaded and ready to save.');
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

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    let unlisten: (() => void) | undefined;
    void listenForGlobalRfid((value) => {
      if (shouldRouteGlobalRfidToSetup(setupDialogOpen, setupToken, setupStep)) {
        handleSetupInput(value);
      } else if (!setupDialogOpen || !setupToken) {
        void submit(value, 'RFID');
      }
    }).then((cleanup) => { unlisten = cleanup; });
    return () => { unlisten?.(); };
  }, [handleSetupInput, setupDialogOpen, setupStep, setupToken, submit]);

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
              {success.user.photoUrl ? <img className="result-photo result-photo-full" src={photoSource(success.user.photoUrl)} alt={`${success.user.fullName} ID`} /> : <div className="result-photo result-photo-fallback" aria-label="ID photo unavailable"><UserRound size={72} /></div>}
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
            <div><span>OFFICE</span><strong className="office-location">{resolveOfficeDisplay(config.office, 'short')}</strong></div>
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
               <div className="photo-field"><span className="field-label">ID photo <span className="optional">optional</span></span><label className={`photo-dropzone${props.form.photoUrl ? ' has-photo' : ''}`} htmlFor="setup-photo"><input id="setup-photo" className="photo-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) props.onPhotoFile(file); event.currentTarget.value = ''; }} />{props.form.photoUrl ? <><img src={photoSource(props.form.photoUrl)} alt="Uploaded ID preview" /><span className="photo-overlay"><Check size={17} /> Photo ready</span></> : <><ImagePlus size={25} /><strong>Choose an ID photo</strong><small>JPG, PNG, or WebP - resized automatically</small><span className="photo-upload-link"><Upload size={14} /> Browse files</span></>}</label></div>
            </div>
            {props.error && <p className={props.error.includes('successfully') ? 'setup-success' : 'setup-error'} role="status">{props.error}</p>}
            <div className="setup-footer"><button className="text-button" type="button" onClick={props.onScanAnother}>Scan another card</button><button className="submit-button" type="submit" disabled={props.busy || !props.form.userId.trim() || !props.form.fullName.trim() || (props.form.employeeType === 'EMPLOYEE' && Number(props.form.dailyRate) <= 0)}>{props.busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />} Save user</button></div>
          </form>
        )}
      </section>
    </div>
  );
}

async function preparePhotoDataUrl(file: File): Promise<string> {
  const source = await createImageBitmap(file);
  const scale = Math.min(1, 4096 / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Photo preparation is unavailable in this browser.');
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close();
  for (const quality of [0.82, 0.68, 0.55, 0.42]) {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    if (dataUrl.length * 0.75 <= PHOTO_UPLOAD_MAX_BYTES) return dataUrl;
  }
  throw new Error('This photo could not be compressed below the 500 KB upload limit.');
}

const PHOTO_UPLOAD_MAX_BYTES = 500 * 1024;

function formatTime(value: string, timezone: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-PH', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true }).format(date);
}

function localDate(timezone = 'Asia/Manila') { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date()); }

/** Loads the canonical office identity with a safe fallback to defaults. */
function useOfficeIdentity(): OfficeIdentity {
  const [office, setOffice] = useState<OfficeIdentity>(DEFAULT_OFFICE_IDENTITY);
  useEffect(() => {
    const controller = new AbortController();
    void loadConfig(controller.signal).then((config) => setOffice(config.office ?? DEFAULT_OFFICE_IDENTITY));
    return () => controller.abort();
  }, []);
  return office;
}

function LiveAttendance() {
  const office = useOfficeIdentity();
  const [rows, setRows] = useState<AttendanceListItem[]>([]);
  const [stale, setStale] = useState(false);
  const [fetchedAt, setFetchedAt] = useState('');
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try { const response = await loadAttendance(); if (response.success) { setRows(response.attendance); setFetchedAt(response.fetchedAt); setStale(false); setError(''); } else throw new Error('Unable to load attendance'); } catch { setStale(true); setError('Live attendance is temporarily unavailable.'); }
  }, []);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 5_000); const onFocus = () => void refresh(); window.addEventListener('focus', onFocus); return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus); }; }, [refresh]);
  return <main className="dashboard-shell"><header className="dashboard-header"><div><p className="section-kicker">Live attendance</p><h1>Today’s timing</h1><p className="section-description">{resolveOfficeDisplay(office, 'short')} · {localDate()} · updates every five seconds</p></div><nav><a href="/">Scanner</a><a href="/admin">Admin</a></nav></header>{error && <p className="dashboard-alert">{error}</p>}<div className="dashboard-status">{stale ? 'Showing last successful update' : `Last updated ${fetchedAt ? formatTime(fetchedAt, 'Asia/Manila') : 'just now'}`}</div><AttendanceTable rows={rows} timezone="Asia/Manila" /></main>;
}

function AttendanceTable({ rows, timezone }: { rows: AttendanceListItem[]; timezone: string }) {
  if (!rows.length) return <div className="empty-state">No attendance has been recorded today.</div>;
  return <div className="table-wrap"><table><thead><tr><th>Employee</th><th>Department</th><th>Time in</th><th>Time out</th><th>Status</th></tr></thead><tbody>{rows.map((row) => <tr key={row.attendanceId}><td><strong>{row.fullName}</strong><small>{row.userId}</small></td><td>{row.department || '—'}</td><td>{row.timeIn ? formatTime(row.timeIn, timezone) : '—'}</td><td>{row.timeOut ? formatTime(row.timeOut, timezone) : '—'}</td><td><span className={`status-pill status-${row.status.toLowerCase()}`}>{row.status}</span></td></tr>)}</tbody></table></div>;
}

function AdminPanel() {
  const office = useOfficeIdentity();
  const [unlocked, setUnlocked] = useState(false); const [sessionExpiresAt, setSessionExpiresAt] = useState(''); const [pin, setPin] = useState(''); const [error, setError] = useState(''); const [tab, setTab] = useState<'users' | 'attendance' | 'payroll'>('users');
  const [users, setUsers] = useState<AdminUser[]>([]); const [rows, setRows] = useState<AttendanceListItem[]>([]); const [profiles, setProfiles] = useState<PayrollCalculationProfile[]>([]); const [cutoffs, setCutoffs] = useState<PayrollCutoffRecord[]>([]); const [date, setDate] = useState(localDate());
  const [editing, setEditing] = useState<AdminUser | null>(null); const [busy, setBusy] = useState(false);
  const [nuking, setNuking] = useState(false);
  const unlock = async (event: React.FormEvent) => { event.preventDefault(); setBusy(true); const response = await unlockAdmin(pin); setBusy(false); if (!response.success) { setError(response.error.message); return; } setUnlocked(true); setSessionExpiresAt(response.expiresAt); setError(''); };
  const nukeSheets = async () => { if (!window.confirm('This will wipe all Google Sheets data and re-export from SQLite. Continue?')) return; setNuking(true); setError(''); const response = await nukeSheetsResync(true); setNuking(false); if ((response as { success?: boolean }).success) setError('Google Sheets wiped; re-export queued from SQLite.'); else setError((response as { error?: { message?: string } }).error?.message ?? 'Unable to reset Google Sheets.'); };
  const load = useCallback(async () => { try { const [userResponse, attendanceResponse, profileResponse, cutoffResponse] = await Promise.all([loadAdminUsers(), loadAdminAttendance(date), loadPayrollProfiles(), loadPayrollCutoffs()]); if (userResponse.success) setUsers(userResponse.users); if (attendanceResponse.success) setRows(attendanceResponse.attendance); if (profileResponse.success) setProfiles(profileResponse.profiles); if (cutoffResponse.success) setCutoffs(cutoffResponse.payroll); } catch { setError('Unable to load administrator data.'); } }, [date]);
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
  return <main className="dashboard-shell"><header className="dashboard-header"><div><p className="section-kicker">Administrator access</p><h1>Manage attendance</h1><p className="section-description">{resolveOfficeDisplay(office, 'short')}</p></div><nav><a href="/">Scanner</a><a href="/attendance">Live view</a>{import.meta.env.DEV && <button className="text-button" type="button" disabled={nuking} onClick={() => void nukeSheets()}>{nuking ? 'Nuking…' : 'Nuke & resync Sheets'}</button>}<button className="text-button" type="button" onClick={() => { void lockAdmin(); setUnlocked(false); setSessionExpiresAt(''); }}>Lock</button></nav></header><div className="admin-tabs"><button className={tab === 'users' ? 'is-active' : ''} onClick={() => setTab('users')}>Users and RFID</button><button className={tab === 'attendance' ? 'is-active' : ''} onClick={() => setTab('attendance')}>Attendance corrections</button><button className={tab === 'payroll' ? 'is-active' : ''} onClick={() => setTab('payroll')}>Payroll</button></div>{error && <p className="dashboard-alert">{error}</p>}{tab === 'users' ? <UserEditor users={users} profiles={profiles} editing={editing} setEditing={setEditing} onSaved={load} /> : tab === 'attendance' ? <AdminAttendance rows={rows} date={date} setDate={setDate} onSaved={load} /> : <PayrollWorkspace users={users} profiles={profiles} records={cutoffs} onSaved={load} />}</main>;
}

type AdminUser = { userId: string; rfidUid: string; fullName: string; department: string | null; status: 'ACTIVE' | 'INACTIVE'; employeeType: 'INTERN' | 'EMPLOYEE'; dailyRate: number | null; payrollProfileId?: string | null; photoUrl?: string | null };
function UserEditor({ users, profiles, editing, setEditing, onSaved }: { users: AdminUser[]; profiles: PayrollCalculationProfile[]; editing: AdminUser | null; setEditing: (user: AdminUser | null) => void; onSaved: () => void }) {
  const blankUser: AdminUser = { userId: '', rfidUid: '', fullName: '', department: '', status: 'ACTIVE', employeeType: 'INTERN', dailyRate: null, payrollProfileId: null };
  const [form, setForm] = useState<AdminUser>(editing ?? blankUser);
  const [message, setMessage] = useState('');
  const [deletingUserId, setDeletingUserId] = useState('');
  useEffect(() => setForm(editing ?? blankUser), [editing]);
  const save = async (event: React.FormEvent) => { event.preventDefault(); const payload = { ...form, dailyRate: form.employeeType === 'EMPLOYEE' ? form.dailyRate : null, payrollProfileId: form.employeeType === 'EMPLOYEE' ? form.payrollProfileId : null }; const response = await saveAdminUser(payload, editing?.userId); if ((response as { success?: boolean }).success) { setMessage('Saved.'); setEditing(null); onSaved(); } else setMessage((response as { error?: { message?: string } }).error?.message ?? 'Unable to save user.'); };
  const remove = async (user: AdminUser) => { if (!window.confirm(`Delete ${user.fullName} and remove their RFID assignment? Existing attendance records will remain.`)) return; setDeletingUserId(user.userId); const response = await deleteAdminUser(user.userId); setDeletingUserId(''); if ((response as { success?: boolean }).success) { if (editing?.userId === user.userId) setEditing(null); setMessage('User deleted.'); onSaved(); } else setMessage((response as { error?: { message?: string } }).error?.message ?? 'Unable to delete user.'); };
  return <div className="admin-grid"><section className="admin-form"><h2>{editing ? 'Edit user' : 'Add user'}</h2><form onSubmit={save}><label>User ID<input required disabled={Boolean(editing)} value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })} /></label><label>RFID UID<input required value={form.rfidUid} onChange={(e) => setForm({ ...form, rfidUid: e.target.value })} /></label><label>Full name<input required value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} /></label><label>Department<input value={form.department ?? ''} onChange={(e) => setForm({ ...form, department: e.target.value })} /></label><label className="employee-type-toggle">Employee type <button type="button" role="switch" aria-checked={form.employeeType === 'EMPLOYEE'} onClick={() => setForm({ ...form, employeeType: form.employeeType === 'INTERN' ? 'EMPLOYEE' : 'INTERN', dailyRate: form.employeeType === 'INTERN' ? form.dailyRate : null, payrollProfileId: form.employeeType === 'INTERN' ? (form.payrollProfileId ?? 'BEA_STANDARD') : null })}><span>INTERN</span><strong>{form.employeeType}</strong></button></label>{form.employeeType === 'EMPLOYEE' && <><label>Daily rate (PHP)<input required type="number" min="0.01" step="0.01" value={form.dailyRate ?? ''} onChange={(e) => setForm({ ...form, dailyRate: Number(e.target.value) || null })} /></label><label>Payroll calculation<select value={form.payrollProfileId ?? 'BEA_STANDARD'} onChange={(e) => setForm({ ...form, payrollProfileId: e.target.value })}>{profiles.map((profile) => <option key={profile.profileId} value={profile.profileId}>{profile.label}</option>)}</select></label></>}<label>Status<select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as AdminUser['status'] })}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></select></label>{message && <p className="dashboard-alert">{message}</p>}<button className="submit-button" type="submit">Save user</button></form></section><section><div className="table-wrap"><table><thead><tr><th>User</th><th>RFID</th><th>Payroll profile</th><th>Status</th><th /></tr></thead><tbody>{users.map((user) => <tr key={user.userId}><td><strong>{user.fullName}</strong><small>{user.userId}</small></td><td>{user.rfidUid}</td><td>{user.employeeType === 'EMPLOYEE' ? profiles.find((profile) => profile.profileId === user.payrollProfileId)?.label ?? user.payrollProfileId ?? 'None' : 'Not applicable'}</td><td>{user.status}</td><td><button className="text-button" onClick={() => setEditing(user)}>Edit</button><button className="text-button danger-button" disabled={deletingUserId === user.userId} onClick={() => void remove(user)}>{deletingUserId === user.userId ? 'Deleting...' : 'Delete'}</button></td></tr>)}</tbody></table></div></section></div>;
}

type PayrollForm = { employeeId: string; payrollProfileId: string; cutoffStart: string; cutoffEnd: string; payrollCutoffLabel: string; standardWorkingDays: string; actualWorkingDays: string; specialHolidayDays: string; regularHolidayDays: string; incentivesAllowance: string; specialAllowance: string; lateDeduction: string; halfDayCount: string; absentDays: string; overtimeHours: string; overtimeRate: string; manualAdjustment: string; adjustmentReason: string; approvedWorkingDayOverage: boolean; signaturePlaceholder: string };
const emptyPayrollForm: PayrollForm = { employeeId: '', payrollProfileId: 'BEA_STANDARD', cutoffStart: '', cutoffEnd: '', payrollCutoffLabel: '', standardWorkingDays: '11', actualWorkingDays: '11', specialHolidayDays: '0', regularHolidayDays: '0', incentivesAllowance: '0', specialAllowance: '0', lateDeduction: '0', halfDayCount: '0', absentDays: '0', overtimeHours: '0', overtimeRate: '0', manualAdjustment: '0', adjustmentReason: '', approvedWorkingDayOverage: false, signaturePlaceholder: '' };

const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function computeSemiMonthlyCutoff(month: string, half: 'first' | 'second'): { cutoffStart: string; cutoffEnd: string; payrollCutoffLabel: string } {
  const [yearText, monthText] = month.split('-');
  const year = Number(yearText);
  const monthNumber = Number(monthText);
  const pad = (value: number) => String(value).padStart(2, '0');
  const monthName = monthNames[(monthNumber - 1 + 12) % 12];
  if (half === 'first') {
    return { cutoffStart: `${year}-${pad(monthNumber)}-01`, cutoffEnd: `${year}-${pad(monthNumber)}-15`, payrollCutoffLabel: `${monthName} 1-15, ${year}` };
  }
  const lastDay = new Date(year, monthNumber, 0).getDate();
  return { cutoffStart: `${year}-${pad(monthNumber)}-16`, cutoffEnd: `${year}-${pad(monthNumber)}-${pad(lastDay)}`, payrollCutoffLabel: `${monthName} 16-${lastDay}, ${year}` };
}

export function PayrollWorkspace({ users, profiles, records, onSaved }: { users: AdminUser[]; profiles: PayrollCalculationProfile[]; records: PayrollCutoffRecord[]; onSaved: () => void }) {
  const office = useOfficeIdentity();
  const employees = users.filter((user) => user.employeeType === 'EMPLOYEE');
  const [form, setForm] = useState<PayrollForm>(emptyPayrollForm); const [message, setMessage] = useState(''); const [saving, setSaving] = useState(false);
  const [fileResult, setFileResult] = useState<GeneratedFileResult | null>(null);
  const [cutoffMonth, setCutoffMonth] = useState(() => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`; });
  const [exporting, setExporting] = useState(false);
  const selectedProfile = profiles.find((profile) => profile.profileId === form.payrollProfileId);
  const applyProfile = (profileId: string) => { const profile = profiles.find((item) => item.profileId === profileId); setForm((current) => ({ ...current, payrollProfileId: profileId, standardWorkingDays: String(profile?.standardWorkingDaysPerCutoff ?? current.standardWorkingDays), incentivesAllowance: String(profile?.incentivesAllowance ?? 0), specialAllowance: String(profile?.specialAllowance ?? 0), overtimeRate: String(profile?.overtimeRate ?? 0) })); };
  const selectEmployee = (employeeId: string) => { const user = users.find((item) => item.userId === employeeId); const profile = profiles.find((item) => item.profileId === user?.payrollProfileId) ?? profiles.find((item) => item.profileId === 'BEA_STANDARD'); applyProfile(profile?.profileId ?? form.payrollProfileId); setForm((current) => ({ ...current, employeeId })); };
  const update = (field: keyof PayrollForm, value: string | boolean) => setForm((current) => ({ ...current, [field]: value }));
  const applyCutoffHalf = (half: 'first' | 'second') => { const range = computeSemiMonthlyCutoff(cutoffMonth, half); setForm((current) => ({ ...current, cutoffStart: range.cutoffStart, cutoffEnd: range.cutoffEnd, payrollCutoffLabel: range.payrollCutoffLabel })); };
  const save = async (event: React.FormEvent) => { event.preventDefault(); setSaving(true); const numberFields: Array<keyof PayrollForm> = ['standardWorkingDays', 'actualWorkingDays', 'specialHolidayDays', 'regularHolidayDays', 'incentivesAllowance', 'specialAllowance', 'lateDeduction', 'halfDayCount', 'absentDays', 'overtimeHours', 'overtimeRate', 'manualAdjustment']; const payload: Record<string, unknown> = { ...form }; numberFields.forEach((field) => { payload[field] = Number(form[field]); }); try { const response = await savePayrollCutoff(payload); if ((response as { success?: boolean }).success) { setMessage('Cutoff payroll saved as a draft.'); onSaved(); } else setMessage((response as { error?: { message?: string } }).error?.message ?? 'Unable to save payroll.'); } catch (error) { setMessage(error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unable to save payroll.'); } finally { setSaving(false); } };
  const exportCsv = async () => { setExporting(true); try { const result = await exportPayrollCsv(); if (result.success) { setMessage(`Generated ${result.fileName}.`); setFileResult({ filePath: result.filePath, directoryPath: result.directoryPath, fileName: result.fileName, fileKind: result.fileKind, isPortableMode: result.isPortableMode }); } else setMessage(result.error.message); } finally { setExporting(false); } };
  const exportWorkbook = async () => { setExporting(true); const result = await exportPayrollXlsx(); setExporting(false); if (result.success) { setMessage(`Generated ${result.fileName} (${result.rowCount ?? 0} rows).`); setFileResult({ filePath: result.filePath, directoryPath: result.directoryPath, fileName: result.fileName, fileKind: result.fileKind, isPortableMode: result.isPortableMode }); } else setMessage(result.error.message); };
  const registerPdf = async () => { setExporting(true); const result = await generatePayrollRegisterPdf(); setExporting(false); if (result.success) { setMessage(`Generated ${result.fileName} (${result.rowCount ?? 0} rows).`); setFileResult({ filePath: result.filePath, directoryPath: result.directoryPath, fileName: result.fileName, fileKind: result.fileKind, isPortableMode: result.isPortableMode }); } else setMessage(result.error.message); };
  return <section className="payroll-workspace"><div className="payroll-actions"><button className="admin-button" type="button" disabled={exporting} onClick={() => void exportCsv()}>{exporting ? 'Generating...' : 'Export CSV'}</button><button className="admin-button" type="button" disabled={exporting} onClick={() => void exportWorkbook()}>{exporting ? 'Generating...' : 'Export Excel'}</button><button className="admin-button" type="button" disabled={exporting} onClick={() => void registerPdf()}>{exporting ? 'Generating...' : 'Register PDF'}</button><button className="admin-button" type="button" onClick={() => window.print()}>Print payroll worksheet</button></div><GeneratedFileActions result={fileResult} label="Payroll export" /><div className="admin-grid"><section className="admin-form print-hidden"><h2>Create cutoff payroll</h2><form onSubmit={save}><label>Employee<select required value={form.employeeId} onChange={(event) => selectEmployee(event.target.value)}><option value="">Select employee</option>{employees.map((user) => <option key={user.userId} value={user.userId}>{user.userId} - {user.fullName}</option>)}</select></label><div className="profile-toggle" role="radiogroup" aria-label="Payroll calculation">{profiles.map((profile) => <button key={profile.profileId} type="button" role="radio" aria-checked={form.payrollProfileId === profile.profileId} className={form.payrollProfileId === profile.profileId ? 'is-active' : ''} onClick={() => applyProfile(profile.profileId)}>{profile.label}</button>)}</div><div className="setup-fields"><div className="cutoff-period"><label>Cutoff month<input type="month" value={cutoffMonth} onChange={(event) => setCutoffMonth(event.target.value)} /></label><div className="cutoff-fill-buttons"><button className="admin-button" type="button" onClick={() => applyCutoffHalf('first')}>1st&ndash;15th</button><button className="admin-button" type="button" onClick={() => applyCutoffHalf('second')}>16th&ndash;last day</button></div></div><label>Cutoff start<input required type="date" value={form.cutoffStart} onChange={(event) => update('cutoffStart', event.target.value)} /></label><label>Cutoff end<input required type="date" value={form.cutoffEnd} onChange={(event) => update('cutoffEnd', event.target.value)} /></label><label>Standard days<input type="number" min="0" value={form.standardWorkingDays} onChange={(event) => update('standardWorkingDays', event.target.value)} /></label><label>Actual days<input type="number" min="0" value={form.actualWorkingDays} onChange={(event) => update('actualWorkingDays', event.target.value)} /></label><label>Special holidays<input type="number" min="0" value={form.specialHolidayDays} onChange={(event) => update('specialHolidayDays', event.target.value)} /></label><label>Regular holidays<input type="number" min="0" value={form.regularHolidayDays} onChange={(event) => update('regularHolidayDays', event.target.value)} /></label><label>Incentives (PHP)<input type="number" min="0" step="0.01" value={form.incentivesAllowance} onChange={(event) => update('incentivesAllowance', event.target.value)} /></label><label>Special allowance (PHP)<input type="number" min="0" step="0.01" value={form.specialAllowance} onChange={(event) => update('specialAllowance', event.target.value)} /></label><label>Late deduction (PHP)<input type="number" min="0" step="0.01" value={form.lateDeduction} onChange={(event) => update('lateDeduction', event.target.value)} /></label><label>Half-days<input type="number" min="0" value={form.halfDayCount} onChange={(event) => update('halfDayCount', event.target.value)} /></label><label>Absent days<input type="number" min="0" value={form.absentDays} onChange={(event) => update('absentDays', event.target.value)} /></label><label>Overtime hours<input type="number" min="0" step="0.01" value={form.overtimeHours} onChange={(event) => update('overtimeHours', event.target.value)} /></label><label>Overtime rate (PHP/hr)<input type="number" min="0" step="0.01" value={form.overtimeRate} onChange={(event) => update('overtimeRate', event.target.value)} /></label><label>Manual adjustment (PHP)<input type="number" step="0.01" value={form.manualAdjustment} onChange={(event) => update('manualAdjustment', event.target.value)} /></label></div><label>Adjustment reason<input value={form.adjustmentReason} onChange={(event) => update('adjustmentReason', event.target.value)} placeholder="Required for a non-zero adjustment" /></label><label>Signature placeholder<input value={form.signaturePlaceholder} onChange={(event) => update('signaturePlaceholder', event.target.value)} placeholder="Employee signature" /></label><label className="checkbox-label"><input type="checkbox" checked={form.approvedWorkingDayOverage} onChange={(event) => update('approvedWorkingDayOverage', event.target.checked)} /> Approve actual days above standard</label>{selectedProfile && <p className="setup-copy">Holiday premiums: {selectedProfile.specialHolidayMultiplier * 100}% special, {selectedProfile.regularHolidayMultiplier * 100}% regular.</p>}{message && <p className="dashboard-alert">{message}</p>}<button className="submit-button" disabled={saving}>{saving ? 'Saving...' : 'Save cutoff payroll'}</button></form></section><section className="payroll-table"><PayrollTable records={records} onFinalized={onSaved} /></section></div><PayrollPrintView records={records} office={office} profiles={profiles} /></section>;
}

function PayrollTable({ records, onFinalized }: { records: PayrollCutoffRecord[]; onFinalized: () => void }) {
  const [message, setMessage] = useState(''); const [generatingId, setGeneratingId] = useState('');
  const [fileResult, setFileResult] = useState<GeneratedFileResult | null>(null);
  const finalize = async (payrollId: string) => { const response = await finalizePayrollCutoff(payrollId); if ((response as { success?: boolean }).success) { setMessage('Payroll finalized.'); onFinalized(); } else setMessage((response as { error?: { message?: string } }).error?.message ?? 'Unable to finalize payroll.'); };
  const payslip = async (payrollId: string) => { setGeneratingId(payrollId); const response = await generatePayrollPayslipPdf(payrollId); setGeneratingId(''); if (response.success) { setMessage(`Generated ${response.fileName}.`); setFileResult({ filePath: response.filePath, directoryPath: response.directoryPath, fileName: response.fileName, fileKind: response.fileKind, isPortableMode: response.isPortableMode }); } else setMessage(response.error.message); };
  if (!records.length) return <div className="empty-state">No cutoff payroll has been created.</div>;
  return <><div className="table-wrap payroll-print"><table><thead><tr><th>Employee #</th><th>Employee Name</th><th>Cut Off Rate</th><th>Daily Rate</th><th>Standard</th><th>Actual</th><th>Basic Rate</th><th>Special Holidays (30%)</th><th>Regular Holiday (100%)</th><th>Total Compensation</th><th>Incentives Allowance</th><th>Special Allowance</th><th>Total Allowance</th><th>Late</th><th>Halfday</th><th>Absent</th><th>Overtime</th><th>Gross Compensation</th><th>Signature</th></tr></thead><tbody>{records.map((row) => <><tr key={row.payrollId}><td>{row.employeeId}</td><td>{row.employeeName}</td><td>{row.payrollCutoffLabel}</td><td>{php(row.dailyRate)}</td><td>{row.standardWorkingDays}</td><td>{row.actualWorkingDays}</td><td>{php(row.basicPay)}</td><td>{php(row.specialHolidayPay)}</td><td>{php(row.regularHolidayPay)}</td><td>{php(row.totalCompensation)}</td><td>{php(row.incentivesAllowance)}</td><td>{php(row.specialAllowance)}</td><td>{php(row.totalAllowance)}</td><td>{php(row.lateDeduction)}</td><td>{php(row.halfDayDeduction)}</td><td>{php(row.absenceDeduction)}</td><td>{php(row.overtimePay)}</td><td><strong>{php(row.grossCompensation)}</strong></td><td>{row.signaturePlaceholder || '________________'}</td></tr><tr key={`${row.payrollId}-details`} className="payroll-detail"><td colSpan={19}><details><summary>Calculation breakdown</summary><p>{php(row.basicPay)} basic + {php(row.specialHolidayPay)} special holiday + {php(row.regularHolidayPay)} regular holiday + {php(row.totalAllowance)} allowances + {php(row.overtimePay)} overtime {row.manualAdjustment !== 0 ? `+ ${php(row.manualAdjustment)} manual adjustment (${row.adjustmentReason})` : ''} - {php(row.lateDeduction + row.halfDayDeduction + row.absenceDeduction)} deductions = <strong>{php(row.grossCompensation)}</strong>.</p><p>Status: {row.status}. Net pay: {php(row.netPay)}.</p><button className="text-button print-hidden" disabled={generatingId === row.payrollId} onClick={() => void payslip(row.payrollId)}>{generatingId === row.payrollId ? 'Generating...' : 'Generate payslip PDF'}</button>{row.status === 'DRAFT' && <button className="text-button print-hidden" onClick={() => void finalize(row.payrollId)}>Finalize</button>}</details></td></tr></>)}</tbody></table></div><GeneratedFileActions result={fileResult} label="Payslip PDF" />{message && <p className="dashboard-alert">{message}</p>}</>;
}

function php(value: number): string { return new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number.isFinite(value) ? value : 0).replace('₱', 'PHP '); }

/** Formats a YYYY-MM-DD date for printed worksheet labels (e.g. "Aug 4, 2026"). */
function formatPrintDate(value: string): string {
  if (!value) return '—';
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('en-PH', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(parsed);
}

/** Print-only payroll worksheet template. Hidden on screen; rendered on paper via @media print. */
function PayrollPrintView({ records, office, profiles }: { records: PayrollCutoffRecord[]; office: OfficeIdentity; profiles: PayrollCalculationProfile[] }) {
  if (!records.length) return <div className="print-payroll-view print-only"><p className="pw-empty-note">No cutoff payroll records are available to print. Create and save a cutoff payroll first.</p></div>;
  return (
    <div className="print-payroll-view print-only">
      {records.map((row) => <PayrollWorksheet key={row.payrollId} row={row} office={office} profiles={profiles} />)}
    </div>
  );
}

function PayrollWorksheet({ row, office, profiles }: { row: PayrollCutoffRecord; office: OfficeIdentity; profiles: PayrollCalculationProfile[] }) {
  const profile = profiles.find((item) => item.profileId === row.payrollProfileId);
  const profileLabel = profile?.label ?? row.payrollProfileId;
  const frequencyLabel = row.payrollFrequency === 'SEMI_MONTHLY' ? 'Semi-monthly' : row.payrollFrequency;
  const specialPercent = Math.round(row.specialHolidayMultiplier * 100);
  const regularPercent = Math.round(row.regularHolidayMultiplier * 100);
  const halfDayPercent = Math.round((profile?.halfDayFraction ?? 0.5) * 100);
  const totalDeductions = row.lateDeduction + row.halfDayDeduction + row.absenceDeduction;
  return (
    <article className="pw-sheet">
      <header className="pw-header">
        <p className="pw-company">{office.companyName}</p>
        <p className="pw-address">{office.officeDisplayFull}</p>
        <h1 className="pw-title">Payroll Worksheet</h1>
        <div className="pw-meta">
          <span>Pay period: <strong>{row.payrollCutoffLabel}</strong></span>
          <span>Cutoff: <strong>{formatPrintDate(row.cutoffStart)} – {formatPrintDate(row.cutoffEnd)}</strong></span>
          <span>Prepared: <strong>{formatPrintDate(localDate())}</strong></span>
          <span>Status: <strong>{row.status}</strong></span>
        </div>
      </header>

      <section className="pw-section">
        <h2 className="pw-section-title">Employee details</h2>
        <div className="pw-grid">
          <div className="pw-field"><span className="pw-label">Employee name</span><span className="pw-value">{row.employeeName}</span></div>
          <div className="pw-field"><span className="pw-label">Employee number</span><span className="pw-value">{row.employeeId}</span></div>
          <div className="pw-field"><span className="pw-label">Daily rate</span><span className="pw-value">{php(row.dailyRate)}</span></div>
          <div className="pw-field"><span className="pw-label">Payroll calculation</span><span className="pw-value">{profileLabel}</span></div>
          <div className="pw-field"><span className="pw-label">Pay frequency</span><span className="pw-value">{frequencyLabel}</span></div>
          <div className="pw-field"><span className="pw-label">Cutoff period</span><span className="pw-value">{row.payrollCutoffLabel}</span></div>
        </div>
      </section>

      <section className="pw-section">
        <h2 className="pw-section-title">Attendance and pay basis</h2>
        <table className="pw-table">
          <thead><tr><th className="pw-col-num">#</th><th>Item</th><th className="pw-col-num">Value</th><th>Remarks</th></tr></thead>
          <tbody>
            <tr><td className="pw-col-num">1</td><td>Standard working days</td><td className="pw-col-num">{row.standardWorkingDays}</td><td>Days expected in this cutoff</td></tr>
            <tr><td className="pw-col-num">2</td><td>Actual working days</td><td className="pw-col-num">{row.actualWorkingDays}</td><td>{row.approvedWorkingDayOverage ? 'Actual days approved above standard' : 'Days actually rendered'}</td></tr>
            <tr><td className="pw-col-num">3</td><td>Special holiday days</td><td className="pw-col-num">{row.specialHolidayDays}</td><td>Paid at {specialPercent}% premium</td></tr>
            <tr><td className="pw-col-num">4</td><td>Regular holiday days</td><td className="pw-col-num">{row.regularHolidayDays}</td><td>Paid at {regularPercent}% premium</td></tr>
            <tr><td className="pw-col-num">5</td><td>Half-days</td><td className="pw-col-num">{row.halfDayCount}</td><td>Each half-day counted at {halfDayPercent}% of a day</td></tr>
            <tr><td className="pw-col-num">6</td><td>Absent days</td><td className="pw-col-num">{row.absentDays}</td><td>Deducted from gross pay</td></tr>
            <tr><td className="pw-col-num">7</td><td>Overtime hours</td><td className="pw-col-num">{row.overtimeHours}</td><td>At {php(row.overtimeRate)} per hour</td></tr>
          </tbody>
        </table>
      </section>

      <section className="pw-section">
        <h2 className="pw-section-title">Earnings</h2>
        <table className="pw-table">
          <thead><tr><th className="pw-col-num">#</th><th>Description</th><th className="pw-col-amount">Amount</th></tr></thead>
          <tbody>
            <tr><td className="pw-col-num">1</td><td>Basic pay — {row.actualWorkingDays} day(s) at {php(row.dailyRate)} per day</td><td className="pw-col-amount">{php(row.basicPay)}</td></tr>
            <tr><td className="pw-col-num">2</td><td>Special holiday pay — {row.specialHolidayDays} day(s) at {specialPercent}%</td><td className="pw-col-amount">{php(row.specialHolidayPay)}</td></tr>
            <tr><td className="pw-col-num">3</td><td>Regular holiday pay — {row.regularHolidayDays} day(s) at {regularPercent}%</td><td className="pw-col-amount">{php(row.regularHolidayPay)}</td></tr>
            <tr className="pw-subtotal"><td className="pw-col-num" colSpan={2}>Total compensation</td><td className="pw-col-amount">{php(row.totalCompensation)}</td></tr>
            <tr><td className="pw-col-num">4</td><td>Incentives allowance</td><td className="pw-col-amount">{php(row.incentivesAllowance)}</td></tr>
            <tr><td className="pw-col-num">5</td><td>Special allowance</td><td className="pw-col-amount">{php(row.specialAllowance)}</td></tr>
            <tr className="pw-subtotal"><td className="pw-col-num" colSpan={2}>Total allowances</td><td className="pw-col-amount">{php(row.totalAllowance)}</td></tr>
            <tr><td className="pw-col-num">6</td><td>Overtime pay — {row.overtimeHours} hour(s) at {php(row.overtimeRate)} per hour</td><td className="pw-col-amount">{php(row.overtimePay)}</td></tr>
            {row.manualAdjustment !== 0 && <tr><td className="pw-col-num">7</td><td>Manual adjustment{row.adjustmentReason ? ` — ${row.adjustmentReason}` : ''}</td><td className="pw-col-amount">{php(row.manualAdjustment)}</td></tr>}
            <tr className="pw-grand"><td className="pw-col-num" colSpan={2}>Gross compensation</td><td className="pw-col-amount">{php(row.grossCompensation)}</td></tr>
          </tbody>
        </table>
      </section>

      <section className="pw-section">
        <h2 className="pw-section-title">Deductions</h2>
        <table className="pw-table">
          <thead><tr><th className="pw-col-num">#</th><th>Description</th><th className="pw-col-amount">Amount</th></tr></thead>
          <tbody>
            <tr><td className="pw-col-num">1</td><td>Late deduction{row.lateUnits ? ` — ${row.lateUnits} unit(s)` : ''}</td><td className="pw-col-amount">{php(row.lateDeduction)}</td></tr>
            <tr><td className="pw-col-num">2</td><td>Half-day deduction — {row.halfDayCount} half-day(s)</td><td className="pw-col-amount">{php(row.halfDayDeduction)}</td></tr>
            <tr><td className="pw-col-num">3</td><td>Absence deduction — {row.absentDays} absent day(s)</td><td className="pw-col-amount">{php(row.absenceDeduction)}</td></tr>
            <tr className="pw-grand"><td className="pw-col-num" colSpan={2}>Total deductions</td><td className="pw-col-amount">{php(totalDeductions)}</td></tr>
          </tbody>
        </table>
      </section>

      <section className="pw-section">
        <h2 className="pw-section-title">Pay summary</h2>
        <div className="pw-summary">
          <div className="pw-summary-cell"><span className="pw-label">Gross compensation</span><span className="pw-value">{php(row.grossCompensation)}</span></div>
          <div className="pw-summary-cell"><span className="pw-label">Total deductions</span><span className="pw-value">− {php(totalDeductions)}</span></div>
          <div className="pw-summary-cell pw-summary-net"><span className="pw-label">Net pay</span><span className="pw-value">{php(row.netPay)}</span></div>
          <div className="pw-summary-cell"><span className="pw-label">Status</span><span className="pw-value">{row.status}</span></div>
        </div>
      </section>

      <section className="pw-section">
        <h2 className="pw-section-title">Remarks</h2>
        <p className="pw-remarks">{row.calculationBreakdown || '—'}</p>
        {row.adjustmentReason && <p className="pw-remarks">Adjustment reason: {row.adjustmentReason}.</p>}
        {row.approvedWorkingDayOverage && <p className="pw-remarks">Actual working days above the standard were approved for this cutoff.</p>}
      </section>

      <section className="pw-section">
        <h2 className="pw-section-title">Signatures</h2>
        <div className="pw-signatures">
          <div className="pw-signature"><span className="pw-sign-line">{row.signaturePlaceholder || '____________________________'}</span><span className="pw-sign-caption">Prepared by</span></div>
          <div className="pw-signature"><span className="pw-sign-line">____________________________</span><span className="pw-sign-caption">Checked by</span></div>
          <div className="pw-signature"><span className="pw-sign-line">____________________________</span><span className="pw-sign-caption">Employee signature</span></div>
        </div>
      </section>

      <footer className="pw-footer">{office.companyName} · Confidential — for authorized payroll use only</footer>
    </article>
  );
}

function AdminAttendance({ rows, date, setDate, onSaved }: { rows: AttendanceListItem[]; date: string; setDate: (value: string) => void; onSaved: () => void }) {
  const [message, setMessage] = useState('');
  const [exporting, setExporting] = useState(false);
  const [fileResult, setFileResult] = useState<GeneratedFileResult | null>(null);
  const exportWorkbook = async () => { setExporting(true); const result = await exportAttendanceXlsx(date); setExporting(false); if (result.success) { setMessage(`Generated ${result.fileName} (${result.rowCount} rows).`); setFileResult({ filePath: result.filePath, directoryPath: result.directoryPath, fileName: result.fileName, fileKind: result.fileKind, isPortableMode: result.isPortableMode }); } else setMessage(result.error.message); };
  return <section><div className="date-filter"><label>Attendance date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label><button className="admin-button" type="button" disabled={exporting} onClick={() => void exportWorkbook()}>{exporting ? 'Generating...' : 'Export Excel'}</button>{message && <small>{message}</small>}</div><GeneratedFileActions result={fileResult} label="Attendance export" /><div className="table-wrap"><table><thead><tr><th>Employee</th><th>Time in</th><th>Time out</th><th>Status</th><th /></tr></thead><tbody>{rows.map((row) => <AttendanceEditRow key={row.attendanceId} row={row} onSaved={onSaved} />)}</tbody></table></div></section>;
}

function AttendanceEditRow({ row, onSaved }: { row: AttendanceListItem; onSaved: () => void }) {
  const [timeIn, setTimeIn] = useState(row.timeIn ? row.timeIn.slice(11, 16) : ''); const [timeOut, setTimeOut] = useState(row.timeOut ? row.timeOut.slice(11, 16) : ''); const [message, setMessage] = useState(''); const [deleting, setDeleting] = useState(false);
  const save = async () => { const toIso = (value: string) => value ? `${row.attendanceDate}T${value}:00+08:00` : null; const response = await saveAdminAttendance(row.attendanceId, { attendanceDate: row.attendanceDate, timeIn: toIso(timeIn), timeOut: toIso(timeOut), expectedTimeIn: row.timeIn || null, expectedTimeOut: row.timeOut || null }); if ((response as { success?: boolean }).success) { setMessage('Saved'); onSaved(); } else setMessage((response as { error?: { message?: string } }).error?.message ?? 'Conflict'); };
  const remove = async () => { if (!window.confirm(`Delete ${row.fullName}'s ${row.attendanceDate} time-in/time-out record?`)) return; setDeleting(true); const response = await deleteAdminAttendance(row.attendanceId, row.attendanceDate); setDeleting(false); if ((response as { success?: boolean }).success) { setMessage('Record deleted'); onSaved(); } else setMessage((response as { error?: { message?: string } }).error?.message ?? 'Unable to delete record.'); };
  return <tr><td><strong>{row.fullName}</strong><small>{row.userId}</small></td><td><input aria-label={`Time in for ${row.fullName}`} type="time" value={timeIn} onChange={(e) => setTimeIn(e.target.value)} /></td><td><input aria-label={`Time out for ${row.fullName}`} type="time" value={timeOut} onChange={(e) => setTimeOut(e.target.value)} /></td><td>{row.status}</td><td><button className="text-button" onClick={() => void save()}>Save</button><button className="text-button danger-button" disabled={deleting} onClick={() => void remove()}>{deleting ? 'Deleting...' : 'Delete'}</button>{message && <small>{message}</small>}</td></tr>;
}
