import { useEffect, useState } from "react";
import type { AttendanceListItem, OfficeIdentity } from "@rfid-attendance/shared";
import { DEFAULT_OFFICE_IDENTITY } from "@rfid-attendance/shared";
import { loadConfig } from "./api";
import logoPhoenix from "./assets/branding/logo-phoenix.png";

export function toErrorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error) return cause.message;
  if (cause && Object.prototype.toString.call(cause) === "[object String]") {
    // SAFETY: Verified cause is string primitive
    return cause as string;
  }
  return fallback;
}

/** The time-in a row is paid from when the payroll engine clamped it (it then differs from the scan); else null. */
export function clampedPayableTimeIn(row: Pick<AttendanceListItem, "timeIn" | "payableTimeIn">): string | null {
  return row.timeIn && row.payableTimeIn && row.payableTimeIn !== row.timeIn ? row.payableTimeIn : null;
}

export async function preparePhotoDataUrl(file: File): Promise<string> {
  const source = await createImageBitmap(file);
  const scale = Math.min(1, 4096 / Math.max(source.width, source.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const context = canvas.getContext("2d");
  if (!context)
    throw new Error("Photo preparation is unavailable in this browser.");
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close();
  for (const quality of [0.82, 0.68, 0.55, 0.42]) {
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    if (dataUrl.length * 0.75 <= PHOTO_UPLOAD_MAX_BYTES) return dataUrl;
  }
  throw new Error(
    "This photo could not be compressed below the 500 KB upload limit.",
  );
}

const PHOTO_UPLOAD_MAX_BYTES = 500 * 1024;

export function localDate(timezone = "Asia/Manila") {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(
    new Date(),
  );
}

/**
 * Pauses the native scanner listener while a screen with text input is open
 * (admin, live attendance) and resumes it when the kiosk comes back, so
 * operator keystrokes are never misread as card scans.
 */
/**
 * True while a capped, scrolling list holds more than fits in its box, so a
 * "See all" toggle is worth showing. `enabled` re-arms it once the box renders.
 */
export function useVerticalOverflow(ref: React.RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const box = ref.current;
    if (!enabled || !box || !("ResizeObserver" in window)) return;
    const measure = () => setOverflowing(box.scrollHeight > box.clientHeight + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    if (box.firstElementChild) observer.observe(box.firstElementChild);
    measure();
    return () => observer.disconnect();
  }, [ref, enabled]);
  return overflowing;
}

/** Loads the canonical office identity with a safe fallback to defaults. */
export function useOfficeIdentity(): OfficeIdentity {
  const [office, setOffice] = useState<OfficeIdentity>(DEFAULT_OFFICE_IDENTITY);
  useEffect(() => {
    const controller = new AbortController();
    void loadConfig(controller.signal).then((config) =>
      setOffice(config.office ?? DEFAULT_OFFICE_IDENTITY),
    );
    return () => controller.abort();
  }, []);
  return office;
}

/** Compact brand lockup for the shared dashboard header (live + admin screens). "ALPHA PREMIER", as on the kiosk;
    Live attendance passes `realty` to keep its longer name until its own overhaul stage. */
export function DashboardBrand({ realty = false }: { realty?: boolean }) {
  return (
    <div className="dashboard-brand">
      <img
        className="dashboard-brand-mark"
        src={logoPhoenix}
        alt=""
        aria-hidden="true"
      />
      <span className="dashboard-brand-name">{realty ? "ALPHA PREMIER REALTY" : "ALPHA PREMIER"}</span>
    </div>
  );
}
