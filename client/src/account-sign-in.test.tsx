import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { AccountSignInPanel, RESET_SENT } from './account-sign-in';
import * as tauriApi from './tauri-api';

function enableTauri() {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
}

async function typeAndSignIn(user: ReturnType<typeof userEvent.setup>, email: string, password: string) {
  await user.clear(screen.getByLabelText('Email'));
  await user.type(screen.getByLabelText('Email'), email);
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

afterEach(() => {
  // SAFETY: Removing test mock property from window
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
  window.history.pushState({}, '', '/');
});

describe('AccountSignInPanel', () => {
  it('opens the admin screens for an account that may, and hands back when the session ends', async () => {
    enableTauri();
    const unlock = vi.spyOn(tauriApi.tauriApi, 'adminAccountUnlock').mockResolvedValue({ success: true, token: 't-1', expiresAt: '2026-11-18T09:00:00Z', name: 'Ana Cruz' });
    const onUnlocked = vi.fn();
    const user = userEvent.setup();
    render(<AccountSignInPanel onUnlocked={onUnlocked} onBack={() => {}} />);

    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
    await typeAndSignIn(user, 'ana@alphapremiergroup.com', 'ana-password');

    expect(unlock).toHaveBeenCalledWith('ana@alphapremiergroup.com', 'ana-password');
    expect(onUnlocked).toHaveBeenCalledWith('2026-11-18T09:00:00Z');
  });

  it.each([
    ['INVALID_ACCOUNT', 'The email or password is not right.'],
    ['NOT_ATTENDANCE_ADMIN', 'This account is not an attendance admin. The CEO sets that in Keystone, under User Accounts.'],
    ['ACCOUNT_TURNED_OFF', 'This account has been turned off. Ask the CEO.'],
    ['ACCOUNT_NEEDS_INTERNET', 'There is no internet, and this account has not signed in on this kiosk in the last 7 days. Use an admin card, or try again when the internet is back.'],
    ['ADMIN_PIN_LOCKED', 'Too many wrong tries. Signing in is paused for 5 minutes; an admin card still works.'],
    ['ACCOUNT_TRY_LATER', 'Too many tries. Wait a few minutes and try again.'],
    ['ACCOUNT_SIGN_IN_UNAVAILABLE', 'Account sign-in is not set up in this app build. Use an admin card, or contact IT.'],
    ['ADMIN_DISABLED', 'Administrator access is turned off on this kiosk.'],
  ])('says why %s did not open, in plain words, and keeps no typed password', async (code, sentence) => {
    enableTauri();
    vi.spyOn(tauriApi.tauriApi, 'adminAccountUnlock').mockRejectedValue(code);
    const onUnlocked = vi.fn();
    const user = userEvent.setup();
    render(<AccountSignInPanel onUnlocked={onUnlocked} onBack={() => {}} />);

    await typeAndSignIn(user, 'ana@alphapremiergroup.com', 'a-guess');

    expect(await screen.findByRole('alert')).toHaveTextContent(sentence);
    expect(onUnlocked).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(screen.getByLabelText('Email')).toHaveValue('ana@alphapremiergroup.com');
  });

  it('asks for the reset email for the address typed, and says the same whoever it is', async () => {
    enableTauri();
    const reset = vi.spyOn(tauriApi.tauriApi, 'adminAccountReset').mockResolvedValue({ success: true });
    const user = userEvent.setup();
    render(<AccountSignInPanel onUnlocked={() => {}} onBack={() => {}} />);

    await user.type(screen.getByLabelText('Email'), 'ana@alphapremiergroup.com');
    await user.type(screen.getByLabelText('Password'), 'half-typed');
    await user.click(screen.getByRole('button', { name: 'Forgot password?' }));

    expect(reset).toHaveBeenCalledWith('ana@alphapremiergroup.com');
    expect(await screen.findByText(RESET_SENT)).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  it('asks for an address before a reset, and says when there is no internet', async () => {
    enableTauri();
    const reset = vi.spyOn(tauriApi.tauriApi, 'adminAccountReset').mockRejectedValueOnce('INVALID_ACCOUNT').mockRejectedValueOnce('ACCOUNT_NEEDS_INTERNET');
    const user = userEvent.setup();
    render(<AccountSignInPanel onUnlocked={() => {}} onBack={() => {}} />);

    await user.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Type your email address first.');

    await user.type(screen.getByLabelText('Email'), 'ana@alphapremiergroup.com');
    await user.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('There is no internet');
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it('outside the desktop app it says so, and goes back when asked', async () => {
    const onBack = vi.fn();
    const user = userEvent.setup();
    render(<AccountSignInPanel onUnlocked={() => {}} onBack={onBack} />);

    await typeAndSignIn(user, 'ana@alphapremiergroup.com', 'ana-password');
    expect(await screen.findByRole('alert')).toHaveTextContent('Signing in with an account is only available in the desktop app.');

    await user.click(screen.getByRole('button', { name: 'Back to admin card or PIN' }));
    expect(onBack).toHaveBeenCalled();
  });
});

describe('the admin sign-in screen', () => {
  it('offers the account beside the card and PIN, clears a typed PIN on the way, and comes back', async () => {
    window.history.pushState({}, '', '/admin');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('/api/config')) {
        // SAFETY: Fetch mock config
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, resultResetDelayMs: 500, enableAdmin: true, enableCardSetup: true }) } as Response;
      }
      // SAFETY: Fetch mock: no admin session, so the sign-in screen shows
      return { ok: false, json: async () => ({ success: false, error: { message: 'Locked' } }) } as Response;
    });
    const user = userEvent.setup();
    render(<App />);

    await user.type(await screen.findByPlaceholderText(/enter pin or scan admin card/i), '999');
    await user.click(screen.getByRole('button', { name: 'Sign in with your Keystone account' }));

    expect(screen.getByRole('form', { name: 'Sign in with your Keystone account' })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/enter pin or scan admin card/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back to admin card or PIN' }));
    // The card and PIN are as they were, with nothing left typed.
    expect(await screen.findByRole('button', { name: /unlock admin/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/enter pin or scan admin card/i)).toHaveValue('');
    expect(screen.getByRole('button', { name: /forgot pin/i })).toBeInTheDocument();
  });
});
