import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { IdRegisterStatus } from '@rfid-attendance/shared';
import { IdRegisterPanel } from './id-register-panel';
import { tauriApi } from './tauri-api';

const noBackup = { records: 7120, backedUp: 0, lastCompleteAt: null, problem: null };
const connecting: IdRegisterStatus = { builtIn: true, signedInAs: null, lastCheckedAt: null, problem: null, waiting: 0, backup: noBackup };
const connected: IdRegisterStatus = {
  builtIn: true,
  signedInAs: 'kiosk@example.test',
  lastCheckedAt: '2026-11-17T06:30:00Z',
  problem: null,
  waiting: 2,
  backup: { records: 7120, backedUp: 7120, lastCompleteAt: '2026-11-17T06:31:00Z', problem: null },
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
    vi.spyOn(tauriApi, 'idRegisterStatus').mockResolvedValue({ ...connecting, builtIn: false });
    render(<IdRegisterPanel />);
    expect(await screen.findByText('The ID register is not built into this copy of the app.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check now' })).not.toBeInTheDocument();
  });

  it('asks for nothing: no email, no password, no sign-in', async () => {
    vi.spyOn(tauriApi, 'idRegisterStatus').mockResolvedValue(connecting);
    render(<IdRegisterPanel />);

    expect(await screen.findByText('Connecting…')).toBeInTheDocument();
    expect(screen.getByText(/Nothing to set up here\./)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign/i })).not.toBeInTheDocument();
    // Before it is connected there is no backup to speak of.
    expect(screen.queryByText(/Backup:/)).not.toBeInTheDocument();
  });

  it('shows that it is connected, who is waiting for a card, and that the backup is complete', async () => {
    vi.spyOn(tauriApi, 'idRegisterStatus').mockResolvedValue(connected);
    render(<IdRegisterPanel />);

    expect(await screen.findByText(/^Connected · last checked /)).toBeInTheDocument();
    expect(screen.getByText(/2 people are waiting for a card/)).toBeInTheDocument();
    expect(screen.getByText(/Backup: 7,120 of 7,120 records are in the shared backend, complete as of /)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('checks now and shows the problem the register reports', async () => {
    vi.spyOn(tauriApi, 'idRegisterStatus').mockResolvedValue({ ...connected, waiting: 1 });
    const problem = 'Could not reach the ID register. The kiosk will try again.';
    const checkSpy = vi.spyOn(tauriApi, 'idRegisterCheck').mockResolvedValue({ ...connected, waiting: 0, problem });
    const user = userEvent.setup();
    render(<IdRegisterPanel />);

    expect(await screen.findByText(/1 person is waiting for a card/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(checkSpy).toHaveBeenCalledWith(''));
    expect(await screen.findByRole('alert')).toHaveTextContent(problem);
    expect(screen.queryByText(/waiting for a card\. Give/)).not.toBeInTheDocument();
  });

  it('says why it is not connected, and lets an administrator try again', async () => {
    const problem = 'The email or password is not right.';
    vi.spyOn(tauriApi, 'idRegisterStatus').mockResolvedValue({ ...connecting, problem });
    const checkSpy = vi.spyOn(tauriApi, 'idRegisterCheck').mockRejectedValueOnce('ADMIN_AUTH_REQUIRED').mockResolvedValue(connected);
    const user = userEvent.setup();
    render(<IdRegisterPanel />);

    expect(await screen.findByText('Not connected')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(problem);
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('The administrator session ended. Unlock Admin again.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText(/^Connected · last checked /)).toBeInTheDocument();
    expect(checkSpy).toHaveBeenCalledTimes(2);
  });

  it('says how far the backup has got, and why when it cannot go on', async () => {
    const problem = "This kiosk's account may not write the backup. Ask the owner to publish Keystone's rules for the kiosk backup.";
    vi.spyOn(tauriApi, 'idRegisterStatus').mockResolvedValue({ ...connected, waiting: 0, backup: { ...noBackup, backedUp: 4800, problem } });
    render(<IdRegisterPanel />);

    expect(await screen.findByText(/Backup: 4,800 of 7,120 records are in the shared backend\. This computer keeps the originals\./)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(problem);
  });
});
