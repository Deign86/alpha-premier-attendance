import { useEffect, useSyncExternalStore } from "react";
import { Check, X } from "lucide-react";

/** Short notes for routine results ("User saved", "Backup created"); problems that need action stay inline. */
type Toast = { id: number; text: string };

const TOAST_MS = 3500;
const MAX_TOASTS = 3;

let toasts: readonly Toast[] = [];
let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function publish(next: readonly Toast[]): void {
  toasts = next;
  listeners.forEach((listener) => listener());
}

export function dismissToast(id: number): void {
  clearTimeout(timers.get(id));
  timers.delete(id);
  publish(toasts.filter((toast) => toast.id !== id));
}

/** Shows a short success note that hides by itself; the oldest goes when a fourth arrives. */
export function showToast(text: string): void {
  const toast = { id: nextId++, text };
  const all = [...toasts, toast];
  for (const old of all.slice(0, -MAX_TOASTS)) {
    clearTimeout(timers.get(old.id));
    timers.delete(old.id);
  }
  timers.set(toast.id, setTimeout(() => dismissToast(toast.id), TOAST_MS));
  publish(all.slice(-MAX_TOASTS));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The corner where toasts appear; one per screen. When it goes away, notes still waiting go with it. */
export function Toasts() {
  const items = useSyncExternalStore(subscribe, () => toasts);
  useEffect(
    () => () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
      publish([]);
    },
    [],
  );
  return (
    // Polite and additions-only, so a screen reader reads each new note once and never re-reads the ones still shown.
    <div className="toast-region" aria-live="polite" aria-relevant="additions" aria-atomic="false">
      {items.map((toast) => (
        <div className="toast" key={toast.id}>
          <Check size={15} aria-hidden="true" />
          <span>{toast.text}</span>
          <button className="toast-close" type="button" aria-label={`Dismiss: ${toast.text}`} onClick={() => dismissToast(toast.id)}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
