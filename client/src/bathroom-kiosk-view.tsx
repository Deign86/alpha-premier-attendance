import {
  Clock,
  KeyRound,
  LoaderCircle,
} from "lucide-react";
import type {
  BathroomStatusResponse,
} from "@rfid-attendance/shared";

export function getAvatarInitials(name: string): string {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "??";
  return tokens.slice(0, 2).map((token) => Array.from(token)[0] ?? "").join("").toUpperCase();
}

function formatTime(isoString: string, timezone: string): string {
  try {
    const d = new Date(isoString);
    if (!Number.isFinite(d.getTime())) return isoString;
    return new Intl.DateTimeFormat("en-PH", {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    }).format(d);
  } catch {
    return isoString;
  }
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
  timezone: string;
  nowMs: number;
}

export function BathroomKioskView({
  status,
  timezone,
  nowMs,
}: BathroomKioskViewProps) {
  const maleActive = status?.maleActive ?? null;
  const femaleActive = status?.femaleActive ?? null;

  return (
    <div className="bathroom-kiosk-wrapper" data-testid="bathroom-kiosk-view">
      <div className="bathroom-kiosk-keys-grid">
        {/* MALE KEY CARD */}
        <div
          className={`bathroom-kiosk-card gender-male ${maleActive ? "is-in-use" : "is-available"}`}
          data-testid="bathroom-kiosk-card-male"
        >
          <div className="bathroom-card-header">
            <div className="bathroom-card-title-group">
              <div className="gender-icon-bubble male">
                <KeyRound size={22} />
              </div>
              <div>
                <h3 className="bathroom-card-title">Male Key</h3>
                <p className="bathroom-card-subtitle">Floor Restroom Key 1</p>
              </div>
            </div>
            <span className={`status-pill ${maleActive ? "status-in-use" : "status-available"}`}>
              {maleActive ? "IN USE" : "AVAILABLE"}
            </span>
          </div>

          <div className="bathroom-card-body">
            {maleActive ? (
              <div className="active-holder-box">
                <div className="active-holder-header">
                  <div className="holder-avatar">
                    {getAvatarInitials(maleActive.fullName)}
                  </div>
                  <div>
                    <p className="holder-label">Currently with</p>
                    <h4 className="holder-name">{maleActive.fullName}</h4>
                    <p className="holder-dept">
                      {maleActive.department ?? "General Staff"} · {maleActive.userId}
                    </p>
                  </div>
                </div>
                <div className="elapsed-timer-container">
                  <div className="elapsed-stat">
                    <Clock size={16} />
                    <span>Time Out:</span>
                    <strong>{formatTime(maleActive.timeOut, timezone)}</strong>
                  </div>
                  <div className="elapsed-stat">
                    <LoaderCircle size={16} className="spin-slow" />
                    <span>Elapsed:</span>
                    <strong className="elapsed-counter">
                      {formatLiveElapsed(maleActive.timeOut, nowMs)}
                    </strong>
                  </div>
                </div>
              </div>
            ) : (
              <div className="available-prompt-box">
                <KeyRound size={36} className="available-icon" />
                <p className="available-main">Key is Available</p>
                <p className="available-sub">Tap male employee RFID card to check out</p>
              </div>
            )}
          </div>
        </div>

        {/* FEMALE KEY CARD */}
        <div
          className={`bathroom-kiosk-card gender-female ${femaleActive ? "is-in-use" : "is-available"}`}
          data-testid="bathroom-kiosk-card-female"
        >
          <div className="bathroom-card-header">
            <div className="bathroom-card-title-group">
              <div className="gender-icon-bubble female">
                <KeyRound size={22} />
              </div>
              <div>
                <h3 className="bathroom-card-title">Female Key</h3>
                <p className="bathroom-card-subtitle">Floor Restroom Key 1</p>
              </div>
            </div>
            <span className={`status-pill ${femaleActive ? "status-in-use" : "status-available"}`}>
              {femaleActive ? "IN USE" : "AVAILABLE"}
            </span>
          </div>

          <div className="bathroom-card-body">
            {femaleActive ? (
              <div className="active-holder-box">
                <div className="active-holder-header">
                  <div className="holder-avatar female">
                    {getAvatarInitials(femaleActive.fullName)}
                  </div>
                  <div>
                    <p className="holder-label">Currently with</p>
                    <h4 className="holder-name">{femaleActive.fullName}</h4>
                    <p className="holder-dept">
                      {femaleActive.department ?? "General Staff"} · {femaleActive.userId}
                    </p>
                  </div>
                </div>
                <div className="elapsed-timer-container">
                  <div className="elapsed-stat">
                    <Clock size={16} />
                    <span>Time Out:</span>
                    <strong>{formatTime(femaleActive.timeOut, timezone)}</strong>
                  </div>
                  <div className="elapsed-stat">
                    <LoaderCircle size={16} className="spin-slow" />
                    <span>Elapsed:</span>
                    <strong className="elapsed-counter">
                      {formatLiveElapsed(femaleActive.timeOut, nowMs)}
                    </strong>
                  </div>
                </div>
              </div>
            ) : (
              <div className="available-prompt-box">
                <KeyRound size={36} className="available-icon" />
                <p className="available-main">Key is Available</p>
                <p className="available-sub">Tap female employee RFID card to check out</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
