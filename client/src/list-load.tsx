import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCcw } from "lucide-react";

/** Where one list's load stands: the first load (or a Retry) is running, it loaded, or it failed. */
export type LoadStatus = "loading" | "ready" | "failed";

export type ListLoad<T> = {
  data: T;
  status: LoadStatus;
  /** Why the last load failed (the service's own words), while status is "failed". */
  error: string | null;
  /** Loads again showing the loading rows: Retry. */
  reload: () => Promise<void>;
  /** Loads again keeping the current rows on screen: after a save or delete. */
  refresh: () => Promise<void>;
};

type LoadState<T> = { data: T; status: LoadStatus; error: string | null; source: () => Promise<T> };

/**
 * Loads one list on its own, so a slow or failed list never holds up the others. `load` throws (or rejects)
 * when the list couldn't be loaded. A new `load` (say, for another date) starts over: the old rows are dropped
 * at once, so nothing on screen (counts, selection, exports) ever uses another date's rows. Retry and refresh of
 * the same `load` keep the rows they have. Only the newest load may write, so a slow older answer is ignored.
 */
export function useListLoad<T>(load: () => Promise<T>, initial: T, enabled = true): ListLoad<T> {
  const [empty] = useState(() => initial);
  const [state, setState] = useState<LoadState<T>>({ data: initial, status: "loading", error: null, source: load });
  const latest = useRef(0);
  const run = useCallback(
    async (quiet: boolean) => {
      const id = ++latest.current;
      if (!quiet) {
        setState((current) =>
          current.source === load
            ? { ...current, status: "loading", error: null }
            : { data: empty, status: "loading", error: null, source: load },
        );
      }
      try {
        const data = await load();
        if (id === latest.current) setState({ data, status: "ready", error: null, source: load });
      } catch (cause) {
        if (id !== latest.current) return;
        const error = cause instanceof Error ? cause.message : null;
        setState((current) => ({ data: current.source === load ? current.data : empty, status: "failed", error, source: load }));
      }
    },
    [load, empty],
  );
  useEffect(() => {
    if (enabled) void run(false);
  }, [enabled, run]);
  const reload = useCallback(() => run(false), [run]);
  const refresh = useCallback(() => run(true), [run]);
  // Until the new `load` has answered, the list reads as empty and loading, never as the old rows.
  const current = state.source === load;
  return {
    data: current ? state.data : empty,
    status: current ? state.status : "loading",
    error: current ? state.error : null,
    reload,
    refresh,
  };
}

/** Placeholder rows with a soft shimmer while a table's first load runs, so it never looks like an empty list. */
export function LoadingRows({ columns, label, rows = 4 }: { columns: number; label: string; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, index) => (
        <tr key={index} className="loading-row" aria-hidden={index > 0 ? true : undefined}>
          <td colSpan={columns}>
            <span className="loading-bar" />
            {index === 0 && <span className="visually-hidden">{label}</span>}
          </td>
        </tr>
      ))}
    </>
  );
}

/** A failed load: one coral line naming the list (and why, when known), with Retry that loads only that list. */
export function LoadFailed({ what, onRetry, reason = null }: { what: string; onRetry: () => void; reason?: string | null }) {
  return (
    <p className="load-failed" role="alert">
      <span>
        Couldn&apos;t load {what}.{reason ? ` ${reason}` : ""}
      </span>
      <button className="text-button" type="button" onClick={onRetry}>
        <RefreshCcw size={13} aria-hidden="true" /> Retry
      </button>
    </p>
  );
}
