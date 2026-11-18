import { useEffect } from "react";
import type { SafeConfigResponse } from "@rfid-attendance/shared";

/**
 * Reads cards from a keyboard-wedge RFID reader: a rapid run of key presses ended by Enter, captured only while the
 * window is focused. It knows what a card read is (the character set, the length, the gap between keys) and
 * nothing about where a card goes: the screen says which keys are not the reader's and what to do with a read.
 */
export type CardReaderOptions = {
  /** The reader's format from the configuration: character set and expected length. */
  scanner: SafeConfigResponse["scanner"] | undefined;
  /** Runs first for every key, before any of the reader's own tests. */
  beforeKey: (event: KeyboardEvent) => void;
  /** True when the key belongs to something else (a text field, a dialog): the read in progress is dropped. */
  keyIsNotTheReaders: (target: HTMLElement | null) => boolean;
  /** A complete read in the configured format, upper-cased. */
  onCard: (uid: string) => void;
  /** A read ended by Enter that is not in the configured format. */
  onRefused: () => void;
  /** A manual entry box is open: Enter is left to the focused control unless a read is in progress, and a lone 1 or 2 is not a shortcut. */
  manualEntryOpen: boolean;
  /** A lone `1` or `2` with nothing after it for 200 ms: the kiosk's mode shortcut, not a card. */
  onLoneDigit: (digit: "1" | "2") => void;
  /** Runs when the reader stops listening (the screen's state changed or it unmounted). */
  onStop: () => void;
};

/** Keys further apart than this are not one card. */
const INTER_KEY_TIMEOUT_MS = 250;
const LONE_DIGIT_WAIT_MS = 200;

export function useCardReader({ scanner, beforeKey, keyIsNotTheReaders, onCard, onRefused, manualEntryOpen, onLoneDigit, onStop }: CardReaderOptions): void {
  useEffect(() => {
    let buffer = "";
    let lastKeyAt = 0;
    let modeSwitchTimer: ReturnType<typeof setTimeout> | null = null;

    const resetBuffer = () => {
      buffer = "";
      lastKeyAt = 0;
      if (modeSwitchTimer) {
        clearTimeout(modeSwitchTimer);
        modeSwitchTimer = null;
      }
    };

    const flush = () => {
      const candidate = buffer;
      resetBuffer();
      if (!candidate) return;
      const rawExpectedLength = Number(scanner?.expectedLength ?? 10);
      const expectedLength = Number.isFinite(rawExpectedLength) && rawExpectedLength >= 0 ? rawExpectedLength : 10;
      const characterSet = scanner?.characterSet ?? "decimal";
      const allowedRegex = characterSet === "hex" ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/;

      if (!allowedRegex.test(candidate) || candidate.length < 4 || candidate.length > 64 || (expectedLength > 0 && candidate.length !== expectedLength)) {
        onRefused();
        return;
      }
      onCard(candidate.toUpperCase());
    };

    const onKeyDown = (event: KeyboardEvent) => {
      beforeKey(event);
      if (!document.hasFocus()) {
        resetBuffer();
        return;
      }
      if (event.key === "Escape") {
        resetBuffer();
        return;
      }
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (keyIsNotTheReaders(target)) {
        resetBuffer();
        return;
      }

      if (modeSwitchTimer) {
        clearTimeout(modeSwitchTimer);
        modeSwitchTimer = null;
      }

      const now = Date.now();
      if (lastKeyAt > 0 && now - lastKeyAt > INTER_KEY_TIMEOUT_MS) {
        resetBuffer();
      }
      lastKeyAt = now;

      if (event.key === "Enter") {
        // The Enter that ends a card tap is the reader's, not the focused button's (with a manual entry box open, a
        // lone Enter still presses the button it is on).
        if (buffer || !manualEntryOpen) event.preventDefault();
        flush();
        return;
      }

      const characterSet = scanner?.characterSet ?? "decimal";
      const allowedCharRegex = characterSet === "hex" ? /^[0-9a-fA-F]$/ : /^[0-9]$/;
      if (allowedCharRegex.test(event.key)) {
        buffer += event.key;
        if (!manualEntryOpen && (buffer === "1" || buffer === "2")) {
          const modeKey = buffer;
          modeSwitchTimer = setTimeout(() => {
            if (buffer === modeKey) {
              onLoneDigit(modeKey);
              resetBuffer();
            }
          }, LONE_DIGIT_WAIT_MS);
        }
      } else {
        // Any character outside the configured character set invalidates the buffer immediately.
        resetBuffer();
      }
    };

    const onBlur = () => {
      resetBuffer();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
      onStop();
      resetBuffer();
    };
  }, [scanner, beforeKey, keyIsNotTheReaders, onCard, onRefused, manualEntryOpen, onLoneDigit, onStop]);
}
