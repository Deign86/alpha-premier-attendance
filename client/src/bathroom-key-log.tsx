import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Clock,
  Key,
  KeyRound,
  LoaderCircle,
  LogOut,
  LogIn,
  Search,
} from "lucide-react";
import type {
  BathroomActiveHolder,
  BathroomGenderKey,
  BathroomLogItem,
  BathroomStatusResponse,
} from "@rfid-attendance/shared";
import { bathroomTimeIn, bathroomTimeOut, loadBathroomStatus } from "./api";

function formatTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    if (!Number.isFinite(d.getTime())) return isoString;
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    }).format(d);
  } catch {
    return isoString;
  }
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds === undefined || seconds < 0) return "—";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs.toString().padStart(2, "0")}s`;
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

function todayManila(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
  }).format(new Date());
}

export interface BathroomKeyUser {
  userId: string;
  fullName: string;
  department?: string | null;
  status: "ACTIVE" | "INACTIVE";
  cardType?: "EMPLOYEE" | "ADMIN_ASSIST" | null;
}

export function BathroomKeyLogPanel({
  users,
}: {
  users: BathroomKeyUser[];
}) {
  const [date, setDate] = useState(todayManila);
  const [status, setStatus] = useState<BathroomStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState<BathroomGenderKey | null>(null);
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const [nowMs, setNowMs] = useState(Date.now);

  const [maleSearch, setMaleSearch] = useState("");
  const [femaleSearch, setFemaleSearch] = useState("");
  const [selectedMaleUserId, setSelectedMaleUserId] = useState<string | null>(null);
  const [selectedFemaleUserId, setSelectedFemaleUserId] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const refreshStatus = useCallback(async (targetDate: string) => {
    setLoading(true);
    try {
      const res = await loadBathroomStatus(targetDate);
      if (res.success) {
        setStatus(res);
      }
    } catch {
      setError("Unable to load bathroom key log status.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshStatus(date);
  }, [date, refreshStatus]);

  const activeEmployees = useMemo(() => {
    return users.filter((u) => u.status === "ACTIVE" && u.cardType !== "ADMIN_ASSIST");
  }, [users]);

  const filteredMaleEmployees = useMemo(() => {
    const q = maleSearch.toLowerCase().trim();
    if (!q) return activeEmployees;
    return activeEmployees.filter(
      (e) =>
        e.fullName.toLowerCase().includes(q) ||
        (e.department && e.department.toLowerCase().includes(q)) ||
        e.userId.toLowerCase().includes(q),
    );
  }, [activeEmployees, maleSearch]);

  const filteredFemaleEmployees = useMemo(() => {
    const q = femaleSearch.toLowerCase().trim();
    if (!q) return activeEmployees;
    return activeEmployees.filter(
      (e) =>
        e.fullName.toLowerCase().includes(q) ||
        (e.department && e.department.toLowerCase().includes(q)) ||
        e.userId.toLowerCase().includes(q),
    );
  }, [activeEmployees, femaleSearch]);

  const handleCheckout = async (genderKey: BathroomGenderKey, userId: string | null) => {
    if (!userId || actionBusy) return;
    setError("");
    setSuccessMsg("");
    setActionBusy(genderKey);
    try {
      const res = await bathroomTimeOut(userId, genderKey);
      if (res.success) {
        setSuccessMsg(`Checked out ${genderKey.toLowerCase()} key.`);
        if (genderKey === "MALE") {
          setSelectedMaleUserId(null);
          setMaleSearch("");
        } else {
          setSelectedFemaleUserId(null);
          setFemaleSearch("");
        }
        await refreshStatus(date);
      } else {
        setError(res.error?.message ?? "Failed to check out key.");
      }
    } catch {
      setError("Network or server error checking out bathroom key.");
    } finally {
      setActionBusy(null);
    }
  };

  const handleReturn = async (genderKey: BathroomGenderKey, logId: string) => {
    if (!logId || actionBusy) return;
    setError("");
    setSuccessMsg("");
    setActionBusy(genderKey);
    try {
      const res = await bathroomTimeIn(logId);
      if (res.success) {
        setSuccessMsg(`Returned ${genderKey.toLowerCase()} key.`);
        await refreshStatus(date);
      } else {
        setError(res.error?.message ?? "Failed to return key.");
      }
    } catch {
      setError("Network or server error returning bathroom key.");
    } finally {
      setActionBusy(null);
    }
  };

  const renderKeyPanel = (
    genderKey: BathroomGenderKey,
    activeHolder: BathroomActiveHolder | null,
    logs: BathroomLogItem[],
    searchTerm: string,
    onSearchChange: (v: string) => void,
    selectedUserId: string | null,
    onSelectUser: (id: string) => void,
    filteredList: BathroomKeyUser[],
  ) => {
    const isBusy = actionBusy === genderKey;
    const isOut = Boolean(activeHolder);
    const selectedEmployee = activeEmployees.find((e) => e.userId === selectedUserId);

    return (
      <div className="bathroom-key-card" data-testid={`bathroom-card-${genderKey.toLowerCase()}`}>
        <div className="bathroom-card-header">
          <div className="bathroom-card-title-group">
            <div className={`bathroom-key-avatar ${isOut ? "is-in-use" : "is-available"}`}>
              {isOut ? <KeyRound size={20} /> : <Key size={20} />}
            </div>
            <div>
              <h3>{genderKey === "MALE" ? "Male Key" : "Female Key"}</h3>
              <p className="bathroom-card-subtitle">Floor Restroom Key 1</p>
            </div>
          </div>
          <span className={`status-pill ${isOut ? "status-working" : "status-completed"}`}>
            {isOut ? "IN USE" : "AVAILABLE"}
          </span>
        </div>

        <div className="bathroom-card-body">
          {isOut && activeHolder ? (
            <div className="bathroom-active-holder-box">
              <div className="bathroom-holder-meta">
                <div className="employee-picker-avatar" style={{ width: 44, height: 44, fontSize: "1rem" }}>
                  {activeHolder.fullName
                    .split(" ")
                    .map((n) => n[0])
                    .filter(Boolean)
                    .slice(0, 2)
                    .join("")
                    .toUpperCase()}
                </div>
                <div className="bathroom-holder-info">
                  <span className="bathroom-holder-label">Currently with</span>
                  <strong className="bathroom-holder-name">{activeHolder.fullName}</strong>
                  <span className="bathroom-holder-dept">
                    {activeHolder.department ?? "General"} • {activeHolder.userId}
                  </span>
                </div>
              </div>

              <div className="bathroom-elapsed-banner">
                <Clock size={16} />
                <span>
                  Time Out: <strong>{formatTime(activeHolder.timeOut)}</strong>
                </span>
                <span className="bathroom-elapsed-counter">
                  Elapsed: <strong>{formatLiveElapsed(activeHolder.timeOut, nowMs)}</strong>
                </span>
              </div>

              <button
                className="submit-button bathroom-action-button button-return"
                type="button"
                disabled={isBusy}
                onClick={() => void handleReturn(genderKey, activeHolder.logId)}
              >
                {isBusy ? <LoaderCircle size={16} className="spin" /> : <LogIn size={16} />}
                Time In (Return Key)
              </button>
            </div>
          ) : (
            <div className="bathroom-checkout-box">
              <label className="field-label" htmlFor={`search-${genderKey.toLowerCase()}`}>
                <span>Assign Key to Staff</span>
                {selectedEmployee && (
                  <span style={{ color: "var(--gold-bright)", fontWeight: 400, fontSize: "0.75rem" }}>
                    Selected: {selectedEmployee.fullName}
                  </span>
                )}
              </label>
              <div className="search-input-wrap">
                <Search size={15} />
                <input
                  id={`search-${genderKey.toLowerCase()}`}
                  type="text"
                  className="input"
                  placeholder="Search staff by name or ID…"
                  value={searchTerm}
                  onChange={(e) => onSearchChange(e.target.value)}
                />
              </div>

              <div
                className="employee-picker-list bathroom-picker-list"
                role="listbox"
                aria-label={`Select ${genderKey.toLowerCase()} employee`}
              >
                {filteredList.length === 0 ? (
                  <div style={{ padding: "16px 12px", textAlign: "center", color: "var(--muted)", fontSize: "0.82rem" }}>
                    No staff found matching &ldquo;{searchTerm}&rdquo;.
                  </div>
                ) : (
                  filteredList.map((emp) => {
                    const isSelected = selectedUserId === emp.userId;
                    const initials = emp.fullName
                      .split(" ")
                      .map((n) => n[0])
                      .filter(Boolean)
                      .slice(0, 2)
                      .join("")
                      .toUpperCase();
                    return (
                      <button
                        key={emp.userId}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        className={`employee-picker-item ${isSelected ? "is-selected" : ""}`}
                        onClick={() => onSelectUser(emp.userId)}
                      >
                        <div style={{ display: "flex", alignItems: "center" }}>
                          <div className="employee-picker-avatar">{initials}</div>
                          <div className="employee-picker-meta">
                            <strong>{emp.fullName}</strong>
                            <small>{emp.department ?? "General"} • {emp.userId}</small>
                          </div>
                        </div>
                        {isSelected && <Check size={16} color="var(--gold-bright)" />}
                      </button>
                    );
                  })
                )}
              </div>

              <button
                className="submit-button bathroom-action-button button-checkout"
                type="button"
                disabled={!selectedUserId || isBusy}
                onClick={() => void handleCheckout(genderKey, selectedUserId)}
              >
                {isBusy ? <LoaderCircle size={16} className="spin" /> : <LogOut size={16} />}
                Time Out (Check Out Key)
              </button>
            </div>
          )}
        </div>

        <div className="bathroom-log-history-section">
          <h4>{genderKey === "MALE" ? "Male" : "Female"} Key Log ({date})</h4>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Time Out</th>
                  <th>Time In</th>
                  <th>Duration</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {logs.length === 0 ? (
                  <tr>
                    <td colSpan={5} style={{ textAlign: "center", color: "var(--muted)", padding: "20px" }}>
                      No {genderKey.toLowerCase()} key activity recorded for {date}.
                    </td>
                  </tr>
                ) : (
                  logs.map((log) => (
                    <tr key={log.logId}>
                      <td>
                        <strong>{log.fullName}</strong>
                        {log.department && <small style={{ display: "block", color: "var(--muted)" }}>{log.department}</small>}
                      </td>
                      <td>{formatTime(log.timeOut)}</td>
                      <td>{log.timeIn ? formatTime(log.timeIn) : "—"}</td>
                      <td>{log.durationSeconds !== null ? formatDuration(log.durationSeconds) : "In Use"}</td>
                      <td>
                        <span className={`status-pill ${log.status === "OUT" ? "status-working" : "status-completed"}`}>
                          {log.status === "OUT" ? "OUT" : "RETURNED"}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  };

  return (
    <section className="bathroom-key-log-workspace" data-testid="bathroom-key-log-panel">
      <div className="bathroom-header-controls">
        <div>
          <h2>Bathroom Key Log</h2>
          <p className="section-description">
            Digitized time-in / time-out sign-out sheet for physical bathroom keys
          </p>
        </div>
        <div className="bathroom-date-filter">
          <label htmlFor="bathroom-log-date" className="field-label" style={{ marginBottom: 0, marginRight: 8 }}>
            Date:
          </label>
          <input
            id="bathroom-log-date"
            type="date"
            className="input"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <button
            type="button"
            className="text-button"
            onClick={() => setDate(todayManila())}
            disabled={date === todayManila()}
          >
            Today
          </button>
        </div>
      </div>

      {error && <p className="dashboard-alert" role="alert">{error}</p>}
      {successMsg && <p className="dashboard-alert" style={{ borderColor: "var(--gold-soft)", color: "var(--gold-bright)" }} role="status">{successMsg}</p>}

      {loading && !status ? (
        <div style={{ textAlign: "center", padding: "40px", color: "var(--muted)" }}>
          <LoaderCircle className="spin" size={24} style={{ margin: "0 auto 8px" }} />
          Loading bathroom key log...
        </div>
      ) : (
        <div className="bathroom-panels-grid">
          {renderKeyPanel(
            "MALE",
            status?.maleActive ?? null,
            status?.maleLogs ?? [],
            maleSearch,
            setMaleSearch,
            selectedMaleUserId,
            setSelectedMaleUserId,
            filteredMaleEmployees,
          )}
          {renderKeyPanel(
            "FEMALE",
            status?.femaleActive ?? null,
            status?.femaleLogs ?? [],
            femaleSearch,
            setFemaleSearch,
            selectedFemaleUserId,
            setSelectedFemaleUserId,
            filteredFemaleEmployees,
          )}
        </div>
      )}
    </section>
  );
}
