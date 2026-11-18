import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, CircleAlert, LayoutDashboard, LogIn, LogOut, Nfc, Search, Users, Wifi } from "lucide-react";
import type { AttendanceListItem, AttendanceStatus, LanStatusResponse } from "@rfid-attendance/shared";
import { resolveOfficeDisplay } from "@rfid-attendance/shared";
import { getLanStatus, loadAttendance, loadAdminUsers, openViewerUrl, startLanViewer, stopLanViewer } from "./api";
import { apiUrl } from "./network";
import { listenForAttendanceUpdates, detachWhenDone } from "./tauri-api";
import { formatTime } from "./format";
import { sortByTime, TimeOrderToggle, TimeSortHeading, useTimeOrder } from "./time-sort";
import type { TimeOrder } from "./time-sort";
import { DashboardBrand, clampedPayableTimeIn, localDate, useOfficeIdentity } from "./app-shared";
import { formatDeductionDate } from "./payroll-tables";
import { useScannerPause } from "./scanner-status";
import type { AdminUser } from "./user-editor";

type LiveAttendanceState =
  | { kind: "loading" }
  | { kind: "ready"; rows: AttendanceListItem[]; fetchedAt: string }
  | { kind: "stale"; rows: AttendanceListItem[]; fetchedAt: string; message: string };

export function LiveAttendance() {
  useScannerPause(true);
  const office = useOfficeIdentity();
  const [attendance, setAttendance] = useState<LiveAttendanceState>({ kind: "loading" });
  const [lan, setLan] = useState<LanStatusResponse | null>(null);
  const [lanBusy, setLanBusy] = useState(false);
  const [lanOpen, setLanOpen] = useState(false);
  // On-screen filters only: the counts and the refresh cycle always cover the whole day.
  const [search, setSearch] = useState("");
  const [department, setDepartment] = useState("");
  const [timeOrder, toggleTimeOrder] = useTimeOrder("alpha_premier_sort_live_attendance");
  const searchRef = useRef<HTMLInputElement>(null);
  const [tableUsers, setTableUsers] = useState<AdminUser[]>([]);
  const liveAttendanceSeq = useRef(0);
  const refresh = useCallback(async () => {
    const seq = liveAttendanceSeq.current + 1;
    liveAttendanceSeq.current = seq;
    try {
      const response = await loadAttendance();
      if (liveAttendanceSeq.current !== seq) return;
      if (response.success) {
        setAttendance({ kind: "ready", rows: response.attendance, fetchedAt: response.fetchedAt });
      } else throw new Error("Unable to load attendance");
    } catch {
      if (liveAttendanceSeq.current !== seq) return;
      setAttendance((prev) =>
        prev.kind === "loading"
          ? { kind: "stale", rows: [], fetchedAt: "", message: "Live attendance is temporarily unavailable." }
          : { kind: "stale", rows: prev.rows, fetchedAt: prev.fetchedAt, message: "Live attendance is temporarily unavailable." },
      );
    }
  }, []);

  useEffect(() => {
    void refresh();

    // 1. Listen for native desktop Tauri events
    const stopUpdated = detachWhenDone(listenForAttendanceUpdates(() => {
      void refresh();
    }));

    // 2. Connect to LAN SSE stream for remote browser viewer
    let sse: EventSource | null = null;
    try {
      sse = new EventSource(apiUrl("/api/events/attendance"));
      sse.addEventListener("attendance-updated", () => {
        void refresh();
      });
      sse.addEventListener("message", () => {
        void refresh();
      });
      sse.onerror = () => {
        /* fallback gracefully to polling */
      };
    } catch {
      /* SSE unavailable */
    }

    // 3. Fallback polling timer (every 5 seconds)
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 5_000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);

    return () => {
      stopUpdated();
      sse?.close();
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  useEffect(() => {
    // The payable (clamped) time-in is shown to an administrator only: the roster loads
    // only with an admin session, and without one the actual times stay visible.
    void loadAdminUsers()
      .then((response) => {
        // SAFETY: Error-shaped 401 bodies cast as AdminUsersResponse can omit users
        setTableUsers(response.success ? response.users ?? [] : []);
      })
      .catch(() => setTableUsers([]));
  }, []);

  const refreshLan = useCallback(async () => {
    setLan(await getLanStatus());
  }, []);
  useEffect(() => {
    // Opening Live Attendance starts (or verifies) the LAN viewer server.
    void startLanViewer().then(setLan);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshLan();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [refreshLan]);
  const startNow = async () => {
    setLanBusy(true);
    setLan(await startLanViewer());
    setLanBusy(false);
  };
  const stopNow = async () => {
    setLanBusy(true);
    setLan(await stopLanViewer());
    setLanBusy(false);
  };
  const liveRows: AttendanceListItem[] = attendance.kind === "loading" ? [] : attendance.rows;
  const inOffice = liveRows.filter((row) => row.status === "WORKING").length;
  // Same truthiness checks as AttendanceTable's cells (a MISSED row can lack a valid time in).
  const timedIn = liveRows.filter((row) => Boolean(row.timeIn)).length;
  const timedOut = liveRows.filter((row) => Boolean(row.timeOut)).length;
  const lateTimeouts = liveRows.filter((row) => row.status === "LATE_TIMEOUT").length;
  // Departments in today's rows (plus the chosen one, so the dropdown never loses it after a refresh).
  const departments = [...new Set([...liveRows.map((row) => row.department?.trim() ?? ""), department].filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const query = search.trim().toLowerCase();
  const shownRows = liveRows.filter(
    (row) =>
      (!department || row.department?.trim() === department) &&
      (!query || row.fullName.toLowerCase().includes(query) || row.userId.toLowerCase().includes(query)),
  );
  // Focus goes back to the search box, since the Clear filters button disappears with the empty message.
  const clearFilters = () => {
    setSearch("");
    setDepartment("");
    searchRef.current?.focus();
  };
  // Running but likely unreachable from other devices: flag it on the collapsed LAN toggle.
  const lanNeedsCheck = lan !== null && lan.state === "running" && (lan.networkProfile === "public" || lan.localHealthOk === false);
  return (
    <main className="dashboard-shell live-shell">
      <header className="dashboard-header">
        <div>
          <DashboardBrand realty />
          <p className="section-kicker">Live attendance</p>
          <h1>Today’s timing</h1>
          <p className="section-description">
            {resolveOfficeDisplay(office, "short")} · {formatDeductionDate(localDate())}
          </p>
        </div>
        <nav>
          <a href="/"><Nfc size={16} aria-hidden="true" /> Scanner</a>
          <a href="/admin"><LayoutDashboard size={16} aria-hidden="true" /> Admin</a>
        </nav>
      </header>
      {attendance.kind === "stale" && <p className="dashboard-alert">{attendance.message}</p>}
      <div className="live-bar">
        {liveRows.length > 0 && (
          <ul className="live-counts" aria-label="Today at a glance">
            <li className="office-count"><Users size={16} aria-hidden="true" /><strong>{inOffice}</strong> in office</li>
            <li className="office-count"><LogOut size={16} aria-hidden="true" /><strong>{timedOut}</strong> timed out</li>
            <li className="office-count"><LogIn size={16} aria-hidden="true" /><strong>{timedIn}</strong> timed in</li>
            {lateTimeouts > 0 && (
              <li className="office-count is-alert"><CircleAlert size={16} aria-hidden="true" /><strong>{lateTimeouts}</strong> late time-out{lateTimeouts === 1 ? "" : "s"}</li>
            )}
          </ul>
        )}
        <div className="dashboard-status" data-state={attendance.kind}>
          {attendance.kind === "stale"
            ? "Showing last successful update"
            : attendance.kind === "ready"
              ? `Last updated ${attendance.fetchedAt ? formatTime(attendance.fetchedAt, "Asia/Manila") : "just now"}`
              : "Loading live attendance…"}
        </div>
        <button
          type="button"
          className={lanNeedsCheck ? "live-lan-toggle is-attention" : "live-lan-toggle"}
          aria-expanded={lanOpen}
          aria-controls="live-lan-drawer"
          onClick={() => setLanOpen((open) => !open)}
        >
          <Wifi size={16} aria-hidden="true" />
          LAN viewer
          <span className={`lan-state lan-state-${lan ? lan.state : "starting"}`}><i />{lan ? LAN_STATE_LABEL[lan.state] : "Checking…"}</span>
          {lanNeedsCheck && <span className="live-lan-flag"><CircleAlert size={14} aria-hidden="true" />Check setup</span>}
          <ChevronDown className="live-lan-chevron" size={16} aria-hidden="true" />
        </button>
      </div>
      {/* `hidden` keeps the panel mounted, so its copy state and the auto-start above are unaffected. */}
      <div id="live-lan-drawer" className="live-lan-drawer" hidden={!lanOpen}>
        <LanViewerPanel
          status={lan}
          busy={lanBusy}
          onStart={() => void startNow()}
          onStop={() => void stopNow()}
          onRefresh={() => void refreshLan()}
        />
      </div>
      {liveRows.length > 0 && (
        <div className="live-filters">
          <div className="search-input-wrap">
            <Search size={15} aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              className="input"
              aria-label="Search name or ID"
              placeholder="Search name or ID"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <select
            className="select"
            aria-label="Department"
            value={department}
            onChange={(event) => setDepartment(event.target.value)}
          >
            <option value="">All departments</option>
            {departments.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
          {/* Phones: the cards have no Time in heading, so the order gets a small toggle here. */}
          <TimeOrderToggle column="Time in" order={timeOrder} onToggle={toggleTimeOrder} />
        </div>
      )}
      {attendance.kind === "loading" ? null : liveRows.length > 0 && shownRows.length === 0 ? (
        <div className="empty-state live-no-match">
          <p>No one matches</p>
          <button type="button" className="text-button" onClick={clearFilters}>Clear filters</button>
        </div>
      ) : (
        <AttendanceTable
          rows={shownRows}
          timezone="Asia/Manila"
          showPayable={tableUsers.some((user) => user.employeeType === "INTERN")}
          order={timeOrder}
          onToggleOrder={toggleTimeOrder}
        />
      )}
    </main>
  );
}

const LAN_STATE_LABEL = {
  starting: "Starting",
  running: "Running",
  stopped: "Stopped",
  disabled: "Disabled",
  error: "Needs attention",
} satisfies Record<LanStatusResponse["state"], string>;

function lanProfileLabel(profile: LanStatusResponse["networkProfile"]): string {
  switch (profile) {
    case "public":
      return "Public — inbound blocked by default";
    case "private":
      return "Private — office-ready";
    case "domain":
      return "Domain";
    default:
      return "Unknown";
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through */
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    el.remove();
    return ok;
  } catch {
    return false;
  }
}

/** In-app Live Attendance panel: LAN viewer status, URL, and operator guidance. */
function LanViewerPanel({
  status,
  busy,
  onStart,
  onStop,
  onRefresh,
}: {
  status: LanStatusResponse | null;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  onRefresh: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (!status)
    return (
      <section className="lan-panel" aria-label="LAN viewer">
        <p className="lan-note">Checking the LAN viewer…</p>
      </section>
    );
  const running = status.state === "running";
  const copyUrl = async () => {
    if (!status.viewerUrl) return;
    setCopied(await copyText(status.viewerUrl));
    window.setTimeout(() => setCopied(false), 2000);
  };
  const openUrl = async () => {
    if (status.viewerUrl) await openViewerUrl(status.viewerUrl);
  };
  const firewallCommand = `netsh advfirewall firewall add rule name="Alpha Premier Live Attendance" dir=in action=allow protocol=TCP localport=${status.port} profile=private`;
  const subnetLabel = status.allowedSubnets.length
    ? status.allowedSubnets.join(", ")
    : "Any private (same LAN)";
  const healthLabel =
    status.localHealthOk === true
      ? "Reachable locally"
      : status.localHealthOk === false
        ? "Not reachable locally"
        : "Not checked";
  const firewallLabel =
    status.firewallAllowRule === "present"
      ? "Allow rule found"
      : status.firewallAllowRule === "missing"
        ? "No allow rule found"
        : "Unknown";
  return (
    <section className="lan-panel" aria-label="LAN viewer">
      <div className="lan-panel-head">
        <div>
          <p className="section-kicker">Live Attendance LAN viewer</p>
          <h2>Share today’s timing with the office</h2>
        </div>
        <span className={`lan-state lan-state-${status.state}`}>
          <i />
          {LAN_STATE_LABEL[status.state]}
        </span>
      </div>
      {running && status.viewerUrl ? (
        <>
          <div className="lan-url-row">
            <code className="lan-url">{status.viewerUrl}</code>
            <button
              className="admin-button"
              type="button"
              onClick={() => void copyUrl()}
            >
              {copied ? "Copied" : "Copy URL"}
            </button>
            <button
              className="admin-button file-action-primary"
              type="button"
              onClick={() => void openUrl()}
            >
              Open Local Viewer
            </button>
          </div>
          <p className="lan-note">
            Open this link on any device connected to the same office Wi‑Fi.{" "}
            {status.networkScope}
          </p>
          {status.networkProfile === "public" && (
            <div className="lan-guidance">
              <p>
                <strong>This laptop’s network profile is Public.</strong>{" "}
                Windows blocks most inbound traffic on Public networks. Set the
                Wi‑Fi/LAN profile to <em>Private</em> so other devices can reach
                the viewer, then try opening the link again.
              </p>
              <p className="lan-code">{firewallCommand}</p>
            </div>
          )}
          {status.guidance.length > 0 && (
            <div className="lan-guidance">
              {status.guidance.map((line) => (
                <p key={line}>{line}</p>
              ))}
              {status.firewallAllowRule === "missing" && (
                <p className="lan-code">{firewallCommand}</p>
              )}
            </div>
          )}
          <div className="lan-actions">
            <button
              className="text-button"
              type="button"
              disabled={busy}
              onClick={onStop}
            >
              Stop viewer
            </button>
            <button className="text-button" type="button" onClick={onRefresh}>
              Refresh status
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="lan-note">
            {status.issue === "not_tauri" && status.configError
              ? status.configError
              : status.state === "disabled"
              ? "The LAN viewer is disabled by configuration."
              : status.state === "starting"
                ? "The LAN viewer is starting…"
                : status.state === "error"
                  ? "The LAN viewer could not start."
                  : "The LAN viewer is not running yet."}
          </p>
          {status.state === "stopped" && (
            <p className="lan-note">
              Start it to let any device on the same office Wi‑Fi open a
              read-only live attendance screen. {status.networkScope}
            </p>
          )}
          {status.issue === "no_lan_ip" && (
            <div className="lan-guidance">
              <p>
                <strong>No reachable office LAN IP was detected.</strong>{" "}
                Connect this laptop to the office Wi‑Fi/LAN, or set{" "}
                <code>lan.bind_address</code> to the office LAN IP in
                config.toml (loopback/localhost is never shareable).
              </p>
            </div>
          )}
          {status.issue === "loopback_bind" && (
            <div className="lan-guidance">
              <p>
                <strong>
                  Live Attendance is bound to localhost and cannot be reached by
                  other devices.
                </strong>{" "}
                Set <code>lan.bind_address</code> to the office LAN IP in
                config.toml, or leave it unset so the app auto-detects the Wi‑Fi
                address.
              </p>
            </div>
          )}
          {status.issue === "bind_address_not_present" && (
            <div className="lan-guidance">
              <p>
                <strong>
                  The configured bind address does not match an active network
                  adapter.
                </strong>{" "}
                The laptop’s current IP changed. Set{" "}
                <code>lan.bind_address</code> to the current office LAN IP (
                {status.activeLanIp || "unknown"}), or leave it unset to
                auto-detect.
              </p>
            </div>
          )}
          {status.issue === "port_in_use" && (
            <div className="lan-guidance">
              <p>
                <strong>Port {status.port} is already in use.</strong> Close the
                other program or change <code>lan.port</code> in config.toml,
                then start the viewer again.
              </p>
            </div>
          )}
          {status.issue === "config_invalid" && status.configError && (
            <div className="lan-guidance">
              <p>
                <strong>Invalid LAN configuration:</strong> {status.configError}
              </p>
            </div>
          )}
          {status.lastError && <p className="lan-error">{status.lastError}</p>}
          {status.state !== "disabled" && status.state !== "starting" && (
            <div className="lan-actions">
              <button
                className="admin-button file-action-primary"
                type="button"
                disabled={busy}
                onClick={onStart}
              >
                {busy ? "Starting…" : "Start LAN viewer"}
              </button>
              <button className="text-button" type="button" onClick={onRefresh}>
                Refresh status
              </button>
            </div>
          )}
        </>
      )}
      <div className="lan-facts">
        <span>
          Port <strong>{status.port}</strong>
        </span>
        <span>
          LAN IP{" "}
          <strong>{status.activeLanIp || status.bindAddress || "—"}</strong>
        </span>
        <span>
          Allowed subnets <strong>{subnetLabel}</strong>
        </span>
        <span>
          Firewall rule <strong>{firewallLabel}</strong>
        </span>
        <span>
          Local /api/health <strong>{healthLabel}</strong>
        </span>
        <span>
          Network profile{" "}
          <strong>{lanProfileLabel(status.networkProfile)}</strong>
        </span>
        <span>
          Connected viewers <strong>{status.connectedSseClients}</strong>
        </span>
        {status.configuredBindPresent ? (
          <span>
            Bind address <strong>On an active adapter</strong>
          </span>
        ) : (
          <span>
            Bind address <strong>Not on any adapter</strong>
          </span>
        )}
      </div>
    </section>
  );
}

/** Attendance statuses in plain words. A late time-out keeps its familiar name, the same everywhere it shows. */
export const STATUS_WORD = {
  WORKING: "Working",
  COMPLETED: "Completed",
  MISSED: "Missed",
  LATE_TIMEOUT: "Late time-out",
} satisfies Record<AttendanceStatus, string>;

/** A record's status as a small coloured dot and a word (Live attendance and Attendance corrections). */
export function StatusWord({ status }: { status: AttendanceStatus }) {
  return (
    <span
      className={`status-word is-${status.toLowerCase()}`}
      title={status === "LATE_TIMEOUT" ? "Timed out after office hours; the time-out needs correcting" : undefined}
    >
      {STATUS_WORD[status]}
    </span>
  );
}

export function AttendanceTable({
  rows,
  timezone,
  showPayable = false,
  order,
  onToggleOrder,
}: {
  rows: AttendanceListItem[];
  timezone: string;
  /** Show the payable time-in the payroll engine clamped, with the actual scan in the tooltip. */
  showPayable?: boolean;
  /** Time in order on screen (LiveAttendance keeps the viewer's choice). */
  order: TimeOrder;
  onToggleOrder: () => void;
}) {
  const payable = (row: AttendanceListItem) => (showPayable ? clampedPayableTimeIn(row) : null);
  if (!rows.length)
    return (
      <div className="empty-state">No attendance has been recorded today.</div>
    );
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Employee</th>
            <th>Department</th>
            <TimeSortHeading label="Time in" order={order} onToggle={onToggleOrder} />
            <th>Time out</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {/* Sorted by the time shown: a clamped time-in sorts as its payable hour. */}
          {sortByTime(rows, (row) => payable(row) ?? row.timeIn, order).map((row) => (
            <tr key={row.attendanceId}>
              <td>
                <strong>{row.fullName}</strong>
                <small>{row.userId}</small>
              </td>
              <td>{row.department || "—"}</td>
              <td>
                {payable(row) && row.timeIn ? (
                  <span
                    className="clamped-time-in-chip clamped-time-in-static"
                    data-testid="clamped-time-in"
                    title={`Actual scan: ${formatTime(row.timeIn, timezone)} (payable time clamped)`}
                  >
                    {formatTime(payable(row) ?? row.timeIn)}
                  </span>
                ) : (
                  row.timeIn ? formatTime(row.timeIn, timezone) : "—"
                )}
              </td>
              <td>{row.timeOut ? formatTime(row.timeOut, timezone) : "—"}</td>
              <td>
                <StatusWord status={row.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
