import { useSyncExternalStore } from 'react';

/**
 * The admin session as the client knows it: the token the desktop app gave at unlock and when it runs out.
 * This is its one owner. `api.ts` writes it on unlock, lock and a failed session check and sends the token with
 * every admin command; screens read it through `useAdminSession`.
 */
export type AdminSession = { token: string | null; expiresAt: string | null };

const LOCKED: AdminSession = { token: null, expiresAt: null };
let session: AdminSession = LOCKED;
const listeners = new Set<() => void>();

function set(next: AdminSession): void {
  session = next;
  for (const listener of listeners) listener();
}

export const adminSession = {
  get: (): AdminSession => session,
  /** The token for admin-only commands (empty when locked). */
  token: (): string => session.token ?? '',
  open: (token: string, expiresAt: string): void => set({ token, expiresAt }),
  /** The kiosk setup dialog closing: the token goes, and the expiry time stays as it always has. */
  dropToken: (): void => set({ token: null, expiresAt: session.expiresAt }),
  close: (): void => set(LOCKED),
};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The admin session, for a component that shows or depends on it. */
export function useAdminSession(): AdminSession {
  return useSyncExternalStore(subscribe, adminSession.get);
}
