import { useEffect, useId, useRef, useState } from "react";
import { listenForScannerStatus, getScannerStatus, setScannerPaused, detachWhenDone } from "./tauri-api";
import { formatTime } from "./format";

export type ScannerStatus = {
  state: "connected";
  message: string;
  detail: string | null;
  mode: string;
  paused: boolean;
};

export function useScannerPause(paused: boolean) {
  useEffect(() => {
    void setScannerPaused(paused).catch(() => {
      /* web mode */
    });
    return () => {
      void setScannerPaused(false).catch(() => {
        /* web mode */
      });
    };
  }, [paused]);
}

type ReaderState = {
  status: ScannerStatus | null;
  browserMode: boolean;
  /** The dot's colour, the header's word and the System tab's shorter word. */
  reader: { tone: string; word: string; short: string };
};

/** The card reader's live status, shared by the header dot and the System tab. */
function useReaderStatus(): ReaderState {
  const [status, setStatus] = useState<ScannerStatus | null>(null);
  // The browser build has no desktop layer, so no reader status ever arrives there.
  const browserMode = !("__TAURI_INTERNALS__" in window);

  useEffect(() => {
    const stop = detachWhenDone(listenForScannerStatus((nextStatus) => setStatus(nextStatus)));
    void getScannerStatus()
      .then((nextStatus) => setStatus(nextStatus))
      .catch(() => {
        /* web mode */
      });
    return stop;
  }, []);

  const reader = !status
    ? browserMode
      ? { tone: "browser", word: "Browser mode", short: "Only in the desktop app" }
      : { tone: "checking", word: "Checking…", short: "Checking…" }
    : { tone: "ready", word: "Reader ready", short: "Ready" };
  return { status, browserMode, reader };
}

/**
 * Card reader status for the admin header: a coloured dot and a short word; the details open on click.
 * `lastScanAt` is the newest time-in or time-out in today's attendance (the reader itself reports no scan times).
 */
export function ScannerDiagnostics({ lastScanAt = null }: { lastScanAt?: string | null }) {
  const { status, browserMode, reader } = useReaderStatus();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const detailsId = useId();

  // Escape, or a click or keyboard focus anywhere else, closes the details. Escape only brings focus back to the
  // button when focus was on it, so an Escape typed elsewhere on the page never pulls focus up to the header.
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent | FocusEvent) => {
      if (event.target instanceof Node && !boxRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const focusInside = boxRef.current?.contains(document.activeElement) ?? false;
      setOpen(false);
      if (focusInside) buttonRef.current?.focus();
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const stateLabel = {
    connected: "Waiting for card",
  } satisfies Record<ScannerStatus["state"], string>;

  return (
    <div className="reader-status" ref={boxRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`reader-status-button is-${reader.tone}`}
        aria-expanded={open}
        aria-controls={open ? detailsId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <i aria-hidden="true" />
        <span className="reader-status-word">{reader.word}</span>
      </button>
      {open && (
        <div id={detailsId} className="reader-status-details">
          {status ? (
            <>
              <p className="reader-status-headline">
                {status.paused ? "Paused — this screen is typing" : stateLabel[status.state]}
              </p>
              <p>Reader: Keyboard-mode RFID reader</p>
              {lastScanAt && <p>Last scan: {formatTime(lastScanAt)}</p>}
              <p>Keep the attendance window focused before scanning.</p>
              {status.detail && status.detail !== "Keep the attendance window focused before scanning" && (
                <p>{status.detail}</p>
              )}
            </>
          ) : browserMode ? (
            <>
              <p className="reader-status-headline">Opened in a web browser</p>
              <p>The card reader is checked only in the desktop app on the attendance PC.</p>
            </>
          ) : (
            <p className="reader-status-headline">Checking the card reader connection…</p>
          )}
        </div>
      )}
    </div>
  );
}

/** System's card reader line: "Card reader: ● Ready · Last scan 4:52 PM" (the newest time in today's attendance). */
export function ReaderStatusLine({ lastScanAt }: { lastScanAt: string | null }) {
  const { browserMode, reader } = useReaderStatus();
  return (
    <p className={`system-reader is-${reader.tone}`}>
      Card reader: <i aria-hidden="true" />
      <strong>{reader.short}</strong>
      {!browserMode && lastScanAt && <span>{` · Last scan ${formatTime(lastScanAt)}`}</span>}
    </p>
  );
}
