import { useLayoutEffect, useRef, useState } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

/** Open pop-ups, newest last: only the top one answers Escape and Tab (a confirmation over a form, say). */
const openDialogs: symbol[] = [];

function focusablesIn(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
}

function focusedElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

type DialogKeyOptions = {
  /** While true, Escape does nothing (a save or delete is still running). */
  busy?: boolean;
  /** For pop-ups that stay mounted while closed; defaults to open. */
  open?: boolean;
};

/**
 * Keyboard behaviour shared by every pop-up: Escape closes it (unless busy), Tab and Shift+Tab cycle inside it,
 * focus moves in when it opens (to the element marked `data-autofocus`, else the first control) and goes back to
 * whatever opened it when it closes.
 */
export function useDialogKeys(
  ref: { readonly current: HTMLElement | null },
  onClose: () => void,
  { busy = false, open = true }: DialogKeyOptions = {},
): void {
  const latest = useRef({ onClose, busy });
  useLayoutEffect(() => {
    latest.current = { onClose, busy };
  });
  // Taken while the pop-up first renders, before a field inside it can take focus with autoFocus.
  const [focusAtMount] = useState(focusedElement);

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const id = Symbol("dialog");
    openDialogs.push(id);
    const active = focusedElement();
    const opener = active && !dialog.contains(active) ? active : focusAtMount;
    if (!dialog.contains(active)) {
      const target = dialog.querySelector<HTMLElement>("[data-autofocus]") ?? focusablesIn(dialog)[0] ?? dialog;
      if (target === dialog && !dialog.hasAttribute("tabindex")) dialog.tabIndex = -1;
      target.focus({ preventScroll: true });
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (openDialogs[openDialogs.length - 1] !== id || event.defaultPrevented) return;
      if (event.key === "Escape") {
        if (latest.current.busy) return;
        event.preventDefault();
        latest.current.onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusablesIn(dialog);
      const current = focusedElement();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      if (!current || !dialog.contains(current)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      openDialogs.splice(openDialogs.indexOf(id), 1);
      // Give focus back only if it was still in the pop-up (or dropped to the page when the pop-up went away).
      const now = focusedElement();
      const focusWasInside = !now || now === document.body || !now.isConnected || dialog.contains(now);
      if (opener?.isConnected && focusWasInside) opener.focus({ preventScroll: true });
    };
  }, [ref, open, focusAtMount]);
}
