import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { PIN_RESET_SUCCESS, PinResetPanel } from './pin-reset';
import * as tauriApi from './tauri-api';

const RECIPIENT = 'thealphapremiergroup@gmail.com';
const SENT = { success: true, recipient: RECIPIENT, requestId: 'A1B2C3', expiresAt: '2026-10-08T01:15:00Z' } as const;

function enableTauri() {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
}

function mockConfigFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (String(input).includes('/api/config')) {
      // SAFETY: Fetch mock config
      return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, resultResetDelayMs: 500, enableAdmin: true, enableCardSetup: true }) } as Response;
    }
    // SAFETY: Fetch mock: no admin session, so the login form shows
    return { ok: false, json: async () => ({ success: false, error: { message: 'Locked' } }) } as Response;
  });
}

async function fillCodeAndPins(user: ReturnType<typeof userEvent.setup>, code: string, pin: string, confirm = pin) {
  await user.type(await screen.findByLabelText(/reset code/i), code);
  await user.type(screen.getByLabelText(/^new pin/i), pin);
  await user.type(screen.getByLabelText(/confirm new pin/i), confirm);
  await user.click(screen.getByRole('button', { name: /set new pin/i }));
}

afterEach(() => {
  // SAFETY: Removing test mock property from window
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
  window.history.pushState({}, '', '/');
});

describe('PinResetPanel', () => {
  beforeEach(enableTauri);

  it('emails a code with a request ID, then sets the new PIN and returns to unlock', async () => {
    const request = vi.spyOn(tauriApi.tauriApi, 'adminPinResetRequest').mockResolvedValue(SENT);
    const confirm = vi.spyOn(tauriApi.tauriApi, 'adminPinResetConfirm').mockResolvedValue({ success: true });
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<PinResetPanel onDone={onDone} />);

    await user.click(screen.getByRole('button', { name: /email reset code/i }));
    expect(request).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(RECIPIENT)).toBeInTheDocument();
    expect(screen.getByText('A1B2C3')).toBeInTheDocument();

    await fillCodeAndPins(user, ' 123456 ', '482915');
    expect(confirm).toHaveBeenCalledWith('123456', '482915');
    expect(onDone).toHaveBeenCalledWith(PIN_RESET_SUCCESS);
  });

  it('lets an admin enter a code they already received without sending a new one', async () => {
    const request = vi.spyOn(tauriApi.tauriApi, 'adminPinResetRequest').mockResolvedValue(SENT);
    const confirm = vi.spyOn(tauriApi.tauriApi, 'adminPinResetConfirm').mockResolvedValue({ success: true });
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<PinResetPanel onDone={onDone} />);

    await user.click(screen.getByRole('button', { name: /already have a code/i }));
    expect(screen.getByText(/newest reset code/i)).toBeInTheDocument();
    await fillCodeAndPins(user, '654321', '482915');
    expect(request).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledWith('654321', '482915');
    expect(onDone).toHaveBeenCalledWith(PIN_RESET_SUCCESS);
  });

  it('confirms a resend and says earlier codes no longer work', async () => {
    const request = vi.spyOn(tauriApi.tauriApi, 'adminPinResetRequest').mockResolvedValue(SENT);
    const user = userEvent.setup();
    render(<PinResetPanel onDone={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /email reset code/i }));
    await user.click(await screen.findByRole('button', { name: /send a new code/i }));

    expect(request).toHaveBeenCalledTimes(2);
    expect(await screen.findByText(/earlier codes no longer work/i)).toBeInTheDocument();
  });

  it('blocks mismatched PIN entries without calling the backend', async () => {
    vi.spyOn(tauriApi.tauriApi, 'adminPinResetRequest').mockResolvedValue(SENT);
    const confirm = vi.spyOn(tauriApi.tauriApi, 'adminPinResetConfirm').mockResolvedValue({ success: true });
    const user = userEvent.setup();
    render(<PinResetPanel onDone={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /email reset code/i }));
    await fillCodeAndPins(user, '123456', '482915', '482916');

    expect(await screen.findByRole('alert')).toHaveTextContent(/do not match/i);
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each([
    ['RESET_CODE_INVALID', /code is incorrect/i],
    ['RESET_CODE_EXPIRED', /request a new code/i],
    ['INVALID_NEW_PIN', /6 to 12 digits/i],
    ['ADMIN_DISABLED', /turned off/i],
  ])('shows a clear message when confirming fails with %s', async (code, message) => {
    vi.spyOn(tauriApi.tauriApi, 'adminPinResetRequest').mockResolvedValue(SENT);
    vi.spyOn(tauriApi.tauriApi, 'adminPinResetConfirm').mockRejectedValue(code);
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<PinResetPanel onDone={onDone} />);
    await user.click(screen.getByRole('button', { name: /email reset code/i }));
    await fillCodeAndPins(user, '123456', '482915');

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(onDone).not.toHaveBeenCalled();
  });

  it.each([
    ['RESET_EMAIL_FAILED', /could not be sent/i],
    ['RESET_EMAIL_NOT_CONFIGURED', /not set up/i],
    ['RESET_EMAIL_RATE_LIMITED', /too many reset emails/i],
    ['RESET_RATE_LIMITED', /less than a minute ago/i],
    ['RESET_LOCKED', /too many wrong codes/i],
    ['SOMETHING_NEW', /reset failed/i],
  ])('stays on step one with a clear message when requesting fails with %s', async (code, message) => {
    vi.spyOn(tauriApi.tauriApi, 'adminPinResetRequest').mockRejectedValue(code);
    const user = userEvent.setup();
    render(<PinResetPanel onDone={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /email reset code/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.queryByLabelText(/reset code/i)).toBeNull();
  });
});

describe('Forgot PIN entry points', () => {
  it('opens from the /admin login, clears the typed PIN, and goes back to unlock', async () => {
    window.history.pushState({}, '', '/admin');
    mockConfigFetch();
    const user = userEvent.setup();
    render(<App />);

    await user.type(await screen.findByPlaceholderText(/enter pin or scan admin card/i), '999');
    await user.click(screen.getByRole('button', { name: /forgot pin/i }));
    expect(screen.getByRole('button', { name: /email reset code/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /back to unlock/i }));
    expect(await screen.findByRole('button', { name: /unlock admin/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/enter pin or scan admin card/i)).toHaveValue('');
  });

  it('opens from the kiosk card-setup unlock and shows the success notice after a reset', async () => {
    mockConfigFetch();
    vi.spyOn(tauriApi.tauriApi, 'adminPinResetRequest').mockResolvedValue(SENT);
    vi.spyOn(tauriApi.tauriApi, 'adminPinResetConfirm').mockResolvedValue({ success: true });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: /admin setup/i }));
    // Kiosk config loads over fetch above; the reset itself runs through native commands.
    enableTauri();
    await user.click(screen.getByRole('button', { name: /forgot pin/i }));
    await user.click(screen.getByRole('button', { name: /email reset code/i }));
    await fillCodeAndPins(user, '123456', '482915');

    expect(await screen.findByText(PIN_RESET_SUCCESS)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /unlock setup/i })).toBeInTheDocument();
  });
});
