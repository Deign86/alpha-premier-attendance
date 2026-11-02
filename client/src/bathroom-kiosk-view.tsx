import {
  KeyRound,
  LogOut,
} from "lucide-react";
import type {
  BathroomActiveHolder,
  BathroomGenderKey,
  BathroomScanSuccessResponse,
  BathroomStatusResponse,
} from "@rfid-attendance/shared";
import { photoSource } from "./api";
import { formatTime } from "./format";

export function getAvatarInitials(name: string): string {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "??";
  return tokens.slice(0, 2).map((token) => Array.from(token)[0] ?? "").join("").toUpperCase();
}

/** The ID photo when there is one; otherwise the initials in the same gold frame (scan result and key cards). */
export function ResultPortrait({ photoUrl, fullName }: { photoUrl?: string | null; fullName: string }) {
  return photoUrl ? (
    <img className="result-photo result-photo-full" src={photoSource(photoUrl)} alt={`${fullName} ID`} />
  ) : (
    <div className="result-avatar" aria-label="ID photo unavailable">
      {getAvatarInitials(fullName)}
    </div>
  );
}

function formatLiveElapsed(timeOutIso: string, nowMs: number): string {
  try {
    const outMs = new Date(timeOutIso).getTime();
    if (!Number.isFinite(outMs)) return "0s";
    const diffSec = Math.max(0, Math.floor((nowMs - outMs) / 1000));
    const mins = Math.floor(diffSec / 60);
    const secs = diffSec % 60;
    if (mins === 0) return `${secs}s`;
    return `${mins}m ${secs.toString().padStart(2, "0")}s`;
  } catch {
    return "0s";
  }
}

export interface BathroomKioskViewProps {
  status: BathroomStatusResponse | null;
  /** Holder photos (userId to photo) remembered from scans on this kiosk; the status feed carries none. */
  photos: ReadonlyMap<string, string>;
  /** The scan that just went through on this kiosk: its key card flashes for a moment (null when none). */
  flash: BathroomScanSuccessResponse | null;
  timezone: string;
  nowMs: number;
}

export function BathroomKioskView({
  status,
  photos,
  flash,
  timezone,
  nowMs,
}: BathroomKioskViewProps) {
  return (
    <div className="bathroom-kiosk-wrapper" data-testid="bathroom-kiosk-view">
      <div className="bathroom-kiosk-keys-grid">
        <KeyCard genderKey="MALE" holder={status?.maleActive ?? null} photos={photos} flash={flash} timezone={timezone} nowMs={nowMs} />
        <KeyCard genderKey="FEMALE" holder={status?.femaleActive ?? null} photos={photos} flash={flash} timezone={timezone} nowMs={nowMs} />
      </div>
    </div>
  );
}

interface KeyCardProps {
  genderKey: BathroomGenderKey;
  holder: BathroomActiveHolder | null;
  photos: ReadonlyMap<string, string>;
  flash: BathroomScanSuccessResponse | null;
  timezone: string;
  nowMs: number;
}

/**
 * One key, laid out like the time-in ID card: who has it (photo, name, ID, since when), or that it is free. Right
 * after a scan of this key the card flashes; a return says who brought it back until the flash ends.
 */
function KeyCard({ genderKey, holder, photos, flash, timezone, nowMs }: KeyCardProps) {
  const key = genderKey === "MALE" ? "male" : "female";
  const flashing = flash?.genderKey === genderKey ? flash : null;
  const returnedBy = flashing?.action === "RETURN"
    ? `Returned by ${flashing.user.fullName} · ${formatTime(flashing.timeIn ?? flashing.timestamp, timezone)}`
    : null;
  return (
    <div
      className={`bathroom-kiosk-card ${holder ? "is-in-use" : "is-available"}${flashing ? " is-flashing" : ""}`}
      data-testid={`bathroom-kiosk-card-${key}`}
    >
      {/* Keyed per scan, so a second scan of the same key flashes again. */}
      {flashing && <span className="bathroom-kiosk-flash" key={flashing.timestamp} aria-hidden="true" />}
      <div className="bathroom-card-header">
        <div className="bathroom-card-title-group">
          <KeyRound size={18} aria-hidden="true" />
          <div>
            <h3 className="bathroom-card-title">{genderKey === "MALE" ? "Male Key" : "Female Key"}</h3>
            <p className="bathroom-card-subtitle">Floor Restroom Key 1</p>
          </div>
        </div>
        <span className={`status-word ${holder ? "is-in-use" : "is-available"}`} data-testid={`bathroom-kiosk-status-${key}`}>
          {holder ? "In use" : "Available"}
        </span>
      </div>

      {holder ? (
        <div className="bathroom-kiosk-body">
          <ResultPortrait photoUrl={photos.get(holder.userId)} fullName={holder.fullName} />
          <div className="result-body">
            <span className="result-status">
              <LogOut size={15} aria-hidden="true" /> Key taken
            </span>
            <h4 className="result-name" data-testid={`bathroom-kiosk-holder-${key}`}>{holder.fullName}</h4>
            <p className="result-user-id">
              {holder.userId}
              {holder.department ? ` · ${holder.department}` : ""}
            </p>
            <div className="result-times">
              <dl className="result-time">
                <dt>Taken</dt>
                <dd>{formatTime(holder.timeOut, timezone)}</dd>
              </dl>
              <p className="bathroom-kiosk-elapsed">
                Out for <strong>{formatLiveElapsed(holder.timeOut, nowMs)}</strong>
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="bathroom-kiosk-body">
          <div className="result-avatar is-empty" aria-hidden="true">
            <KeyRound size={28} />
          </div>
          <div className="result-body">
            <p className="result-name">Ready to take</p>
            <p className={`result-user-id${returnedBy ? " is-returned" : ""}`}>{returnedBy ?? "Tap your ID to take this key"}</p>
          </div>
        </div>
      )}
    </div>
  );
}
