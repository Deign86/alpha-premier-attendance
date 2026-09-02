import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Clock,
  Key,
  KeyRound,
  LoaderCircle,
  LogOut,
  LogIn,
  Pencil,
  Search,
  X,
} from "lucide-react";
import type {
  BathroomActiveHolder,
  BathroomGenderKey,
  BathroomLogItem,
  BathroomStatusResponse,
} from "@rfid-attendance/shared";
import { bathroomTimeIn, bathroomTimeOut, loadBathroomStatus, updateBathroomLog } from "./api";
import { announceBathroom } from "./services/ttsService";

export function getAvatarInitials(name: string): string {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "??";
  return tokens.slice(0, 2).map((token) => Array.from(token)[0] ?? "").join("").toUpperCase();
}

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
  gender?: "MALE" | "FEMALE" | null;
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
  const [editingLog, setEditingLog] = useState<BathroomLogItem | null>(null);

  const handleLogUpdated = (updated: BathroomLogItem) => {
    setStatus((prev) => {
      if (!prev) return prev;
      const isMale = updated.genderKey === "MALE";
      const targetLogs = isMale ? prev.maleLogs : prev.femaleLogs;
      const newLogs = targetLogs.map((item) => (item.logId === updated.logId ? updated : item));

      let maleActive = prev.maleActive;
      let femaleActive = prev.femaleActive;
      if (isMale) {
        if (updated.status === "RETURNED" && maleActive?.logId === updated.logId) {
          maleActive = null;
        } else if (updated.status === "OUT") {
          maleActive = {
            logId: updated.logId,
            userId: updated.userId,
            fullName: updated.fullName,
            department: updated.department,
            genderKey: updated.genderKey,
            timeOut: updated.timeOut,
          };
        }
      } else {
        if (updated.status === "RETURNED" && femaleActive?.logId === updated.logId) {
          femaleActive = null;
        } else if (updated.status === "OUT") {
          femaleActive = {
            logId: updated.logId,
            userId: updated.userId,
            fullName: updated.fullName,
            department: updated.department,
            genderKey: updated.genderKey,
            timeOut: updated.timeOut,
          };
        }
      }

      return {
        ...prev,
        maleActive,
        femaleActive,
        maleLogs: isMale ? newLogs : prev.maleLogs,
        femaleLogs: isMale ? prev.femaleLogs : newLogs,
      };
    });
    setError("");
    setSuccessMsg("Saved — bathroom key times updated.");
  };

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
    const list = activeEmployees.filter((employee) => !employee.gender || employee.gender === "MALE");
    if (!q) return list;
    return list.filter(
      (e) =>
        e.fullName.toLowerCase().includes(q) ||
        (e.department && e.department.toLowerCase().includes(q)) ||
        e.userId.toLowerCase().includes(q),
    );
  }, [activeEmployees, maleSearch]);

  const filteredFemaleEmployees = useMemo(() => {
    const q = femaleSearch.toLowerCase().trim();
    const list = activeEmployees.filter((employee) => !employee.gender || employee.gender === "FEMALE");
    if (!q) return list;
    return list.filter(
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
      const selectedEmployee = activeEmployees.find((employee) => employee.userId === userId);
      const res = await bathroomTimeOut(userId, genderKey);
      if (res.success) {
        void announceBathroom({
          action: "CHECKOUT",
          genderKey,
          employeeName: selectedEmployee?.fullName,
          personId: selectedEmployee?.userId,
        });
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
        const message = res.error?.message ?? "Failed to check out key.";
        setError(message.includes("BATHROOM_KEY_ALREADY_IN_USE") || message.includes('status=OUT')
          ? "This key is currently in use. Please return it before checking out again."
          : message);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      setError(message.includes("BATHROOM_KEY_ALREADY_IN_USE")
        ? "This key is currently in use. Please return it before checking out again."
        : "Network or server error checking out bathroom key.");
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
      const activeHolder = genderKey === "MALE" ? status?.maleActive : status?.femaleActive;
      const res = await bathroomTimeIn(logId);
      if (res.success) {
        void announceBathroom({
          action: "RETURN",
          genderKey,
          employeeName: activeHolder?.fullName,
          personId: activeHolder?.userId,
        });
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
                  {getAvatarInitials(activeHolder.fullName)}
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
                disabled={isBusy || !navigator.onLine}
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
                    const initials = getAvatarInitials(emp.fullName);
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
                disabled={!selectedUserId || isBusy || !navigator.onLine}
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
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {logs.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ textAlign: "center", color: "var(--muted)", padding: "20px" }}>
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
                      <td className="payroll-actions-cell">
                        <button
                          className="text-button"
                          type="button"
                          onClick={() => setEditingLog(log)}
                          aria-label={`Edit key log for ${log.fullName}`}
                        >
                          <Pencil size={13} style={{ marginRight: 4, verticalAlign: -1 }} />
                          Edit
                        </button>
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

      {editingLog && (
        <EditBathroomLogModal
          log={editingLog}
          onClose={() => setEditingLog(null)}
          onSaved={(updated) => {
            handleLogUpdated(updated);
            setEditingLog(null);
          }}
        />
      )}
    </section>
  );
}

function EditBathroomLogModal({
  log,
  onClose,
  onSaved,
}: {
  log: BathroomLogItem;
  onClose: () => void;
  onSaved: (updated: BathroomLogItem) => void;
}) {
  const initialTimeOut = useMemo(() => {
    return log.timeOut ? log.timeOut.slice(11, 16) : "08:00";
  }, [log.timeOut]);

  const initialTimeIn = useMemo(() => {
    return log.timeIn ? log.timeIn.slice(11, 16) : "";
  }, [log.timeIn]);

  const [timeOut, setTimeOut] = useState(initialTimeOut);
  const [timeIn, setTimeIn] = useState(initialTimeIn);
  const [notes, setNotes] = useState(log.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!timeOut) {
      setError("Time-out is required.");
      return;
    }

    if (timeIn && timeIn < timeOut) {
      setError("Time-out cannot precede time-in. Return time cannot be earlier than checkout time.");
      return;
    }

    setBusy(true);
    setError("");

    const timeOutIso = `${log.logDate}T${timeOut}:00+08:00`;
    const timeInIso = timeIn ? `${log.logDate}T${timeIn}:00+08:00` : null;

    try {
      const response = await updateBathroomLog(log.logId, {
        timeOut: timeOutIso,
        timeIn: timeInIso,
        notes: notes.trim(),
      });
      setBusy(false);
      if (response.success && response.entry) {
        onSaved(response.entry);
      } else {
        setError(response.error?.message ?? "Failed to update bathroom key log.");
      }
    } catch {
      setBusy(false);
      setError("Network or server error while updating bathroom key log.");
    }
  };

  return (
    <div
      className="assisted-modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className="assisted-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-bathroom-log-title"
      >
        <div className="assisted-modal-header">
          <div className="assisted-modal-title-wrap">
            <div className="assisted-modal-icon icon-purple" aria-hidden="true">
              <KeyRound size={22} />
            </div>
            <div>
              <p className="section-kicker">Key Log Administration</p>
              <h3 id="edit-bathroom-log-title">Edit Bathroom Key Log</h3>
              <p className="assisted-modal-subtitle">
                {log.fullName} • {log.genderKey === "MALE" ? "Male Key" : "Female Key"}
                {log.department ? ` • ${log.department}` : ""}
              </p>
            </div>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="assisted-modal-body">
            {error && <p className="dashboard-alert" role="alert">{error}</p>}

            <div className="modal-section-group">
              <label className="field-label" htmlFor="edit-log-date">
                Date (read-only)
              </label>
              <input
                id="edit-log-date"
                type="text"
                className="input"
                value={`Date: ${log.logDate}`}
                readOnly
                disabled
              />
            </div>

            <div className="modal-section-group" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
              <div>
                <label className="field-label" htmlFor="edit-log-timeout">
                  Time Out (Checkout)
                </label>
                <input
                  id="edit-log-timeout"
                  aria-label="Time out"
                  type="time"
                  className="input"
                  value={timeOut}
                  onChange={(e) => setTimeOut(e.target.value)}
                  required
                />
              </div>
              <div>
                <label className="field-label" htmlFor="edit-log-timein">
                  Time In (Return)
                </label>
                <input
                  id="edit-log-timein"
                  aria-label="Time in"
                  type="time"
                  className="input"
                  value={timeIn}
                  onChange={(e) => setTimeIn(e.target.value)}
                  placeholder="Optional if key still out"
                />
              </div>
            </div>

            <div className="modal-section-group">
              <label className="field-label" htmlFor="edit-log-notes">
                Notes / Reason
              </label>
              <input
                id="edit-log-notes"
                aria-label="Notes"
                type="text"
                className="input"
                placeholder="Optional correction notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </div>

          <div className="assisted-modal-footer">
            <button
              className="modal-btn-cancel"
              type="button"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              className="modal-btn-primary"
              type="submit"
              disabled={busy}
            >
              {busy ? (
                <>
                  <LoaderCircle className="spin" size={16} /> Saving…
                </>
              ) : (
                "Save Changes"
              )}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
