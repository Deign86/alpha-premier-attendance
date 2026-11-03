import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Clock,
  KeyRound,
  Timer,
} from "lucide-react";
import type {
  BathroomActiveHolder,
  BathroomGenderKey,
  BathroomStatusResponse,
} from "@rfid-attendance/shared";
import { photoSource } from "./api";
import { formatTime } from "./format";

export function getAvatarInitials(name: string): string {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "??";
  return tokens.slice(0, 2).map((token) => Array.from(token)[0] ?? "").join("").toUpperCase();
}

/** The ID photo when there is one; otherwise the initials in the same gold frame (attendance and bathroom scan results). */
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

/** How long the old body takes to fade out when a key changes hands (key-body-out in styles.css). */
const KEY_CHANGE_MS = 300;

export interface BathroomKioskViewProps {
  status: BathroomStatusResponse | null;
  timezone: string;
  nowMs: number;
}

export function BathroomKioskView({
  status,
  timezone,
  nowMs,
}: BathroomKioskViewProps) {
  // The status the view opened with can be from an earlier visit to this mode: what changed while the kiosk was away
  // isn't a key changing hands now, so the cards animate changes only once a new answer has come in.
  const [openedWith] = useState(status);
  const fresh = status !== null && status !== openedWith;
  return (
    <div className="bathroom-kiosk-wrapper" data-testid="bathroom-kiosk-view">
      <div className="bathroom-kiosk-keys-grid">
        <KeyCard genderKey="MALE" holder={status?.maleActive ?? null} loaded={fresh} timezone={timezone} nowMs={nowMs} />
        <KeyCard genderKey="FEMALE" holder={status?.femaleActive ?? null} loaded={fresh} timezone={timezone} nowMs={nowMs} />
      </div>
    </div>
  );
}

interface KeyCardProps {
  genderKey: BathroomGenderKey;
  holder: BathroomActiveHolder | null;
  /** False until the first status answer of this visit, so neither the first load nor a change made while the kiosk
   * was in the other mode is shown as the key changing hands. */
  loaded: boolean;
  timezone: string;
  nowMs: number;
}

/**
 * One key: a header (key, name, status capsule), then who has it (initials, name, department and ID, when it was
 * taken and for how long) or that it is free. When the key changes hands the old body fades out under the new one
 * and the card's edge glows once.
 */
function KeyCard({ genderKey, holder, loaded, timezone, nowMs }: KeyCardProps) {
  const key = genderKey === "MALE" ? "male" : "female";
  const [changes, setChanges] = useState(0);
  const [outgoing, setOutgoing] = useState<{ holder: BathroomActiveHolder | null } | null>(null);
  // The holder shown last (undefined before the first status answer); the status refresh replaces the object every
  // few seconds, so a change is a different log, not a different object. Before paint, so the old body never blinks
  // out for a frame.
  const shownRef = useRef<BathroomActiveHolder | null | undefined>(loaded ? holder : undefined);
  useLayoutEffect(() => {
    const before = shownRef.current;
    shownRef.current = loaded ? holder : undefined;
    if (before === undefined || !loaded || (before?.logId ?? null) === (holder?.logId ?? null)) return;
    setOutgoing({ holder: before });
    setChanges((count) => count + 1);
  }, [holder, loaded]);
  useEffect(() => {
    if (!outgoing) return;
    const timer = window.setTimeout(() => setOutgoing(null), KEY_CHANGE_MS);
    return () => window.clearTimeout(timer);
  }, [outgoing]);

  return (
    <div
      className={`bathroom-kiosk-card gender-${key} ${holder ? "is-in-use" : "is-available"}`}
      data-testid={`bathroom-kiosk-card-${key}`}
    >
      {/* Keyed per change, so the edge glows again each time the key changes hands. */}
      {changes > 0 && <span className="bathroom-kiosk-glow" key={changes} aria-hidden="true" />}
      <div className="bathroom-card-header">
        <div className="bathroom-card-title-group">
          <div className={`gender-icon-bubble ${key}`} aria-hidden="true">
            <KeyRound size={20} />
          </div>
          <div>
            <h3 className="bathroom-card-title">{genderKey === "MALE" ? "Male Key" : "Female Key"}</h3>
            <p className="bathroom-card-subtitle">Floor Restroom Key 1</p>
          </div>
        </div>
        <span className={`status-pill ${holder ? "status-in-use" : "status-available"}`} data-testid={`bathroom-kiosk-status-${key}`}>
          {holder ? "IN USE" : "AVAILABLE"}
        </span>
      </div>

      <div className="bathroom-card-body">
        {outgoing && <KeyBody genderKey={genderKey} holder={outgoing.holder} timezone={timezone} nowMs={nowMs} leaving />}
        {/* Keyed by who has the key, so the new body fades in when it changes hands. */}
        <KeyBody key={holder?.logId ?? "free"} genderKey={genderKey} holder={holder} timezone={timezone} nowMs={nowMs} />
      </div>
    </div>
  );
}

interface KeyBodyProps {
  genderKey: BathroomGenderKey;
  holder: BathroomActiveHolder | null;
  timezone: string;
  nowMs: number;
  /** The body that was showing before the change, fading out: hidden from screen readers and tests' ids. */
  leaving?: boolean;
}

function KeyBody({ genderKey, holder, timezone, nowMs, leaving = false }: KeyBodyProps) {
  const key = genderKey === "MALE" ? "male" : "female";
  const state = leaving ? " is-leaving" : "";
  if (!holder) {
    return (
      <div className={`available-prompt-box${state}`} aria-hidden={leaving || undefined}>
        <span className="available-icon" aria-hidden="true">
          <KeyRound size={28} />
        </span>
        <p className="available-main">Key is Available</p>
        <p className="available-sub">Tap {key} employee RFID card to check out</p>
      </div>
    );
  }
  return (
    <div className={`active-holder-box${state}`} aria-hidden={leaving || undefined}>
      <div className="active-holder-header">
        <div className={`holder-avatar ${key}`} aria-hidden="true">
          {getAvatarInitials(holder.fullName)}
        </div>
        <div className="holder-text">
          <p className="holder-label">Currently with</p>
          <h4 className="holder-name" data-testid={leaving ? undefined : `bathroom-kiosk-holder-${key}`}>{holder.fullName}</h4>
          <p className="holder-dept">
            {holder.department ? `${holder.department} · ` : ""}
            {/* One piece, so a wrap goes before the ID, never inside it. */}
            <span className="holder-id">{holder.userId}</span>
          </p>
        </div>
      </div>
      <dl className="elapsed-timer-container">
        <div className="elapsed-stat">
          <dt><Clock size={14} aria-hidden="true" /> Time Out</dt>
          <dd>{formatTime(holder.timeOut, timezone)}</dd>
        </div>
        <div className="elapsed-stat">
          <dt><Timer size={14} aria-hidden="true" /> Elapsed</dt>
          <dd className="elapsed-counter">{formatLiveElapsed(holder.timeOut, nowMs)}</dd>
        </div>
      </dl>
    </div>
  );
}
