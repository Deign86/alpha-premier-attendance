import { useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";

/** Which way a list sorted by a time runs: latest first (the default) or earliest first. */
export type TimeOrder = "newest" | "oldest";

const ORDER_LABEL = { newest: "Newest first", oldest: "Oldest first" } satisfies Record<TimeOrder, string>;

function otherOrder(order: TimeOrder): TimeOrder {
  return order === "newest" ? "oldest" : "newest";
}

/**
 * Rows sorted by a time stamp, for the screen only. Rows without a readable time go last in both orders;
 * rows with the same time keep their order.
 */
export function sortByTime<T>(rows: readonly T[], stampOf: (row: T) => string | null, order: TimeOrder): T[] {
  const timed = rows.map((row) => {
    const stamp = stampOf(row);
    const ms = stamp ? Date.parse(stamp) : Number.NaN;
    return { row, ms: Number.isNaN(ms) ? null : ms };
  });
  timed.sort((a, b) => {
    if (a.ms === null || b.ms === null) return (a.ms === null ? 1 : 0) - (b.ms === null ? 1 : 0);
    return order === "newest" ? b.ms - a.ms : a.ms - b.ms;
  });
  return timed.map(({ row }) => row);
}

/**
 * One page's sort order and its toggle. The viewer's choice is remembered in this browser when storage works;
 * without storage the page starts newest first and the choice lasts until it closes.
 */
export function useTimeOrder(storageKey: string): [TimeOrder, () => void] {
  const [order, setOrder] = useState<TimeOrder>(() => {
    try {
      return localStorage.getItem(storageKey) === "oldest" ? "oldest" : "newest";
    } catch {
      return "newest";
    }
  });
  const toggle = () => {
    const next = otherOrder(order);
    setOrder(next);
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      // Storage is blocked: the choice still applies until the page closes.
    }
  };
  return [order, toggle];
}

/** "Sort by time in, oldest first": what a click does (aria-sort and the arrow show the current order). */
function sortAction(column: string, order: TimeOrder): string {
  return `Sort by ${column.toLowerCase()}, ${ORDER_LABEL[otherOrder(order)].toLowerCase()}`;
}

/**
 * A column heading that sorts by its time: the heading itself is a quiet button with a small arrow. Its name stays
 * the column's ("Time in"); aria-sort gives the order and the tooltip says what a click does. A plain copy of the
 * label stands in where a page hides the button on phones (its cards get a toggle instead).
 */
export function TimeSortHeading({ label, order, onToggle }: { label: string; order: TimeOrder; onToggle: () => void }) {
  const Arrow = order === "newest" ? ArrowDown : ArrowUp;
  return (
    <th aria-sort={order === "newest" ? "descending" : "ascending"}>
      <button type="button" className="time-sort-button" title={sortAction(label, order)} onClick={onToggle}>
        {label}
        <Arrow size={12} aria-hidden="true" />
      </button>
      <span className="time-sort-label">{label}</span>
    </th>
  );
}

/** The same choice as a small text button, for card layouts on phones that have no heading row. */
export function TimeOrderToggle({ column, order, onToggle }: { column: string; order: TimeOrder; onToggle: () => void }) {
  const Arrow = order === "newest" ? ArrowDown : ArrowUp;
  return (
    <button type="button" className="time-order-toggle" title={sortAction(column, order)} onClick={onToggle}>
      {ORDER_LABEL[order]}
      <Arrow size={12} aria-hidden="true" />
    </button>
  );
}
