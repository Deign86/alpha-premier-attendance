import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { IdRegisterStatus } from '@rfid-attendance/shared';
import { IdRegisterPanel } from './id-register-panel';
import { tauriApi } from './tauri-api';

const signedOut: IdRegisterStatus = { builtIn: true, signedInAs: null, lastCheckedAt: null, problem: null, waiting: 0 };
const signedIn: IdRegisterStatus = {
  builtIn: true,
  signedInAs: 'kiosk@example.test',
  lastCheckedAt: '2026-11-17T06:30:00Z',
  problem: null,
  waiting: 2,
};

describe('IdRegisterPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it('says so outside the desktop app and asks nothing', () => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    const statusSpy = vi.spyOn(tauriApi, 'idRegisterStatus');
    render(<IdRegisterPanel />);
    expect(screen.getByRole('region', { name: 'ID register' })).toHaveTextContent('Only in the desktop app.');
    expect(statusSpy).not.toHaveBeenCalled();
  });

  it('says so when the register is not built into this copy', async () => {
    vi.spyOn(tauriApi, 'idRegisterStatus').mockResolvedValue({ ...signedOut, builtIn: false });
    render(<IdRegisterPanel />);
    expect(await screen.findByText('The ID register is not built into this copy of the app.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  it('signs in with the kiosk account, then shows who is signed in and who is waiting', async () => {
    vi.spyOn(tauriApi, 'idRegisterStatus').mockResolvedValue(signedOut);
    const signInSpy = vi.spyOn(tauriApi, 'idRegisterSignIn').mockResolvedValue(signedIn);
    const user = userEvent.setup();
    render(<IdRegisterPanel />);

    const button = await screen.findByRole('button', { name: 'Sign in' });
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText('Kiosk account email'), ' kiosk@example.test ');
    await user.type(screen.getByLabelText('Password'), 'the-kiosk-password');
    await user.click(button);

    await waitFor(() => expect(signInSpy).toHaveBeenCalledWith('', 'kiosk@example.test', 'the-kiosk-password'));
    expect(await screen.findByText(/Signed in as kiosk@example\.test · last checked/)).toBeInTheDocument();
    expect(screen.getByText(/2 people are waiting for a card/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('shows why a sign-in was refused, clears the password and keeps the email', async () => {
    vi.spyOn(tauriApi, 'idRegisterStatus').mockResolvedValue(signedOut);
    vi.spyOn(tauriApi, 'idRegisterSignIn').mockRejectedValue('The email or password is not right.');
    const user = userEvent.setup();
    render(<IdRegisterPanel />);

    await user.type(await screen.findByLabelText('Kiosk account email'), 'kiosk@example.test');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The email or password is not right.');
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(screen.getByLabelText('Kiosk account email')).toHaveValue('kiosk@example.test');
  });

  it('checks now and shows the problem the register reports', async () => {
    vi.spyOn(tauriApi, 'idRegisterStatus').mockResolvedValue({ ...signedIn, waiting: 1 });
    const problem = 'Could not reach the ID register. The kiosk will try again.';
    const checkSpy = vi.spyOn(tauriApi, 'idRegisterCheck').mockResolvedValue({ ...signedIn, waiting: 0, problem });
    const user = userEvent.setup();
    render(<IdRegisterPanel />);

    expect(await screen.findByText(/1 person is waiting for a card/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(checkSpy).toHaveBeenCalledWith(''));
    expect(await screen.findByRole('alert')).toHaveTextContent(problem);
    expect(screen.queryByText(/waiting for a card/)).not.toBeInTheDocument();
  });

  it('signs out, and says when the administrator session has ended', async () => {
    vi.spyOn(tauriApi, 'idRegisterStatus').mockResolvedValue(signedIn);
    const signOutSpy = vi.spyOn(tauriApi, 'idRegisterSignOut').mockRejectedValueOnce('ADMIN_AUTH_REQUIRED').mockResolvedValue(signedOut);
    const user = userEvent.setup();
    render(<IdRegisterPanel />);

    await user.click(await screen.findByRole('button', { name: 'Sign out of the ID register' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The administrator session ended. Unlock Admin again.');
    await user.click(screen.getByRole('button', { name: 'Sign out of the ID register' }));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(signOutSpy).toHaveBeenCalledTimes(2);
  });
});
