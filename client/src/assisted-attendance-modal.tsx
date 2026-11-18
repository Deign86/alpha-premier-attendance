import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Clock, LoaderCircle, Search, ShieldAlert, ShieldCheck, UserCheck } from "lucide-react";
import type { ScanAdminAssistResponse } from "@rfid-attendance/shared";
import { useDialogKeys } from "./use-dialog-keys";

export function AssistedAttendanceModal({
  data,
  onClose,
  onConfirm,
  busy,
  error,
}: {
  data: ScanAdminAssistResponse;
  onClose: () => void;
  onConfirm: (targetUserId: string, reason: string) => Promise<void>;
  busy: boolean;
  error: string;
}) {
  const [timeLeft, setTimeLeft] = useState(25);
  const [search, setSearch] = useState("");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [reasonType, setReasonType] = useState<"Forgot RFID card" | "Defective RFID card" | "Other">("Forgot RFID card");
  const [customReason, setCustomReason] = useState("");

  useEffect(() => {
    // Pause the auto-close countdown while a confirm is in flight so the
    // modal can never close under an awaiting post.
    if (busy) return;
    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          onClose();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [onClose, busy]);

  const dialogRef = useRef<HTMLElement>(null);
  useDialogKeys(dialogRef, onClose, { busy });

  const filteredEmployees = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return data.activeEmployees;
    return data.activeEmployees.filter(
      (e) =>
        e.fullName.toLowerCase().includes(q) ||
        (e.department && e.department.toLowerCase().includes(q)) ||
        e.userId.toLowerCase().includes(q),
    );
  }, [data.activeEmployees, search]);

  const effectiveReason = reasonType === "Other" ? customReason.trim() : reasonType;
  const canConfirm = Boolean(selectedUserId) && Boolean(effectiveReason) && !busy;

  const handleConfirm = () => {
    if (!selectedUserId || !canConfirm) return;
    void onConfirm(selectedUserId, effectiveReason);
  };

  const selectedEmployee = data.activeEmployees.find((e) => e.userId === selectedUserId);

  return (
    <div
      className="assisted-modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="assisted-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="assisted-heading"
      >
        <div className="assisted-modal-header">
          <div className="assisted-modal-title-wrap">
            <div className="assisted-modal-icon" aria-hidden="true">
              <ShieldCheck size={22} />
            </div>
            <div>
              <p className="section-kicker">Kiosk assist mode</p>
              <h3 id="assisted-heading">Assisted Attendance</h3>
              <p className="assisted-modal-subtitle">
                Admin Card: <span className="assisted-admin-card-tag">{data.adminCard.label || "Admin Card"}</span>
              </p>
            </div>
          </div>
          <div className="assisted-timer-pill" aria-live="polite" title="Auto-closes if no action is taken">
            <Clock size={13} /> Auto-cancels in {timeLeft}s
          </div>
        </div>

        <div className="assisted-modal-body">
          {error && <p className="dashboard-alert">{error}</p>}

          <div className="modal-audit-callout">
            <ShieldAlert size={16} />
            <span>Select the employee to record attendance for. This scan will be signed in the audit log under this admin card.</span>
          </div>

          <div className="modal-section-group">
            <label className="field-label" htmlFor="assisted-search">
              <span>Select Employee</span>
              {selectedEmployee && (
                <span style={{ color: "var(--gold-bright)", fontWeight: 400, fontSize: "var(--fs-12)" }}>
                  Selected: {selectedEmployee.fullName}
                </span>
              )}
            </label>
            <div className="search-input-wrap">
              <Search size={16} />
              <input
                id="assisted-search"
                type="text"
                className="input"
                placeholder="Search employee by name, ID, or department…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
                data-autofocus
              />
            </div>
            <div className="employee-picker-list" role="group" aria-label="Active employees">
              {filteredEmployees.length === 0 ? (
                <div style={{ padding: "20px 12px", textAlign: "center", color: "var(--muted)", fontSize: "var(--fs-12)" }}>
                  No active employees found matching &ldquo;{search}&rdquo;.
                </div>
              ) : (
                filteredEmployees.map((emp) => {
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
                      aria-pressed={isSelected}
                      className={`employee-picker-item ${isSelected ? "is-selected" : ""}`}
                      onClick={() => setSelectedUserId(emp.userId)}
                    >
                      <div style={{ display: "flex", alignItems: "center" }}>
                        <div className="employee-picker-avatar" aria-hidden="true">
                          {initials}
                        </div>
                        <div className="employee-picker-meta">
                          <strong>{emp.fullName}</strong>
                          <small>
                            {emp.userId} {emp.department ? `· ${emp.department}` : ""}
                          </small>
                        </div>
                      </div>
                      {isSelected && (
                        <div style={{ display: "grid", placeItems: "center", width: 24, height: 24, borderRadius: "50%", background: "var(--gold)", color: "#11100c" }}>
                          <Check size={14} strokeWidth={3} />
                        </div>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <div className="modal-section-group">
            <span className="field-label">Reason for assisted scan:</span>
            <div className="reason-pill-group" role="radiogroup" aria-label="Reason for assisted scan">
              <button
                type="button"
                className={`reason-pill-btn ${reasonType === "Forgot RFID card" ? "is-active" : ""}`}
                onClick={() => setReasonType("Forgot RFID card")}
              >
                Forgot RFID card
              </button>
              <button
                type="button"
                className={`reason-pill-btn ${reasonType === "Defective RFID card" ? "is-active" : ""}`}
                onClick={() => setReasonType("Defective RFID card")}
              >
                Defective RFID card
              </button>
              <button
                type="button"
                className={`reason-pill-btn ${reasonType === "Other" ? "is-active" : ""}`}
                onClick={() => setReasonType("Other")}
              >
                Other reason…
              </button>
            </div>
          </div>

          {reasonType === "Other" && (
            <div className="modal-section-group">
              <label className="field-label" htmlFor="assisted-custom-reason">
                Custom reason (mandatory for audit trail):
              </label>
              <input
                id="assisted-custom-reason"
                type="text"
                className="input"
                placeholder="Explain why assisted attendance was required…"
                value={customReason}
                onChange={(e) => setCustomReason(e.target.value)}
                autoFocus
              />
            </div>
          )}
        </div>

        <div className="assisted-modal-footer">
          <button className="modal-btn-cancel" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="modal-btn-primary"
            type="button"
            onClick={handleConfirm}
            disabled={!canConfirm}
          >
            {busy ? (
              <>
                <LoaderCircle className="spin" size={16} /> Recording…
              </>
            ) : (
              <>
                <UserCheck size={16} /> Confirm attendance
              </>
            )}
          </button>
        </div>
      </section>
    </div>
  );
}
