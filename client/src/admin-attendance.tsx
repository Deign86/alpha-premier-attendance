import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CalendarPlus, Clock, Download, History, LoaderCircle, Plus, PlusCircle, Search, UserCheck, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { AttendanceListItem, ArrivalStatus } from "@rfid-attendance/shared";
import { ATTENDANCE_TIMEZONE, isLateTimeout } from "@rfid-attendance/shared";
import { deleteAdminAttendance, saveAdminAttendance, createAdminBackdatedAttendance } from "./api";
import { GeneratedFileActions } from "./file-actions";
import type { GeneratedFileResult } from "./file-actions";
import { formatDate, formatLateMinutes, formatTime } from "./format";
import { useDialogKeys } from "./use-dialog-keys";
import { NoticeLine } from "./notice";
import type { Notice } from "./notice";
import { showToast } from "./toasts";
import { LoadFailed, LoadingRows } from "./list-load";
import type { LoadStatus } from "./list-load";
import { sortByTime, TimeOrderToggle, TimeSortHeading, useTimeOrder } from "./time-sort";
import { useActiveThumb } from "./admin-panel";
import { clampedPayableTimeIn, localDate, useVerticalOverflow } from "./app-shared";
import { ConfirmDialog } from "./confirm-dialog";
import { recordCount } from "./database-panel";
import { STATUS_WORD, StatusWord } from "./live-attendance";
import { batchOutcome, showResult } from "./payroll-workspace";
import type { AdminUser } from "./user-editor";

/** No rows: what the attendance page counts, selects and exports until a date's rows have loaded. */
const NO_ATTENDANCE_ROWS: AttendanceListItem[] = [];

/**
 * A row open for editing: the times typed (HH:MM, "" when cleared), the record's stamps when it opened, and
 * whether typed changes were cleared because the record changed on the server meanwhile.
 */
type AttendanceDraft = { timeIn: string; timeOut: string; fromIn: string; fromOut: string | null; changedOnServer: boolean };

/** "2026-10-30T08:12:00+08:00" → "08:12", the value a time input shows. */
function clockOf(stamp: string | null): string {
  return stamp ? stamp.slice(11, 16) : "";
}

function draftFor(row: AttendanceListItem): AttendanceDraft {
  return { timeIn: clockOf(row.timeIn), timeOut: clockOf(row.timeOut), fromIn: row.timeIn, fromOut: row.timeOut, changedOnServer: false };
}

const RECORD_CHANGED_NOTICE: Notice = {
  tone: "error",
  text: "This record changed (for example a new scan). Your typed times were cleared; check and edit again.",
};

function draftChanged(draft: AttendanceDraft): boolean {
  return draft.timeIn !== clockOf(draft.fromIn) || draft.timeOut !== clockOf(draft.fromOut);
}

export function AdminAttendance({
  rows,
  date,
  setDate,
  users = [],
  onSaved,
  onDirtyChange,
  loadStatus = "ready",
  onRetry,
}: {
  rows: AttendanceListItem[];
  date: string;
  setDate: (value: string) => void;
  users?: AdminUser[];
  /** Refreshes the lists; a saved row stays on "Saving…" until it resolves. */
  onSaved: () => void | Promise<void>;
  /** Reports whether any open row has unsaved times, so Admin can ask before leaving the tab or page. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Where this date's attendance load stands (Admin loads it). */
  loadStatus?: LoadStatus;
  onRetry?: () => void;
}) {
  // Problems stay in the filter bar; exports and deletes show as toasts.
  const [message, setMessage] = useState<Notice | null>(null);
  const [exporting, setExporting] = useState(false);
  const [fileResult, setFileResult] = useState<GeneratedFileResult | null>(
    null,
  );
  const [employeeFilter, setEmployeeFilter] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  // Late is an arrival flag, not a status: it narrows the rows together with the status and the source.
  const [lateOnly, setLateOnly] = useState(false);
  const statusFilterRef = useRef<HTMLDivElement>(null);
  const statusThumb = useActiveThumb(statusFilterRef, statusFilter);
  const [backdatedModalOpen, setBackdatedModalOpen] = useState(false);

  // Until this date's rows have loaded (or after they failed to), nothing is counted, selected or exported.
  const ready = loadStatus === "ready";
  const activeRows = ready ? rows : NO_ATTENDANCE_ROWS;

  // Rows open for editing, by record. Kept here, above the filters, so searching or filtering never loses typing.
  const [drafts, setDrafts] = useState<Map<string, AttendanceDraft>>(() => new Map());
  const setDraft = (id: string, draft: AttendanceDraft | null) =>
    setDrafts((current) => {
      const next = new Map(current);
      if (draft) next.set(id, draft);
      else next.delete(id);
      return next;
    });
  // Rows saving or deleting: the date stays put until they finish, so their refresh lands on their own date.
  const busyRowIds = useRef(new Set<string>());
  const [rowsBusy, setRowsBusy] = useState(false);
  const setRowBusy = (id: string, busy: boolean) => {
    if (busy) busyRowIds.current.add(id);
    else busyRowIds.current.delete(id);
    setRowsBusy(busyRowIds.current.size > 0);
  };
  // A record that changed on the server (say, a new scan or a save conflict) shows its current times again, with a
  // note on the row when typed changes were cleared; a record that is gone drops its draft.
  useEffect(() => {
    if (!ready) return;
    setDrafts((current) => {
      let changed = false;
      const next = new Map<string, AttendanceDraft>();
      for (const [id, draft] of current) {
        const row = rows.find((candidate) => candidate.attendanceId === id);
        if (!row) changed = true;
        else if (row.timeIn !== draft.fromIn || row.timeOut !== draft.fromOut) {
          // A row's own save changes its record too; that is not news to the admin.
          next.set(id, { ...draftFor(row), changedOnServer: draftChanged(draft) && !busyRowIds.current.has(id) });
          changed = true;
        } else next.set(id, draft);
      }
      return changed ? next : current;
    });
  }, [rows, ready]);
  const hasUnsaved = [...drafts.values()].some(draftChanged);
  useEffect(() => {
    onDirtyChange?.(hasUnsaved);
  }, [hasUnsaved, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  // Another date shows other records: unsaved times are discarded first, after asking.
  const [pendingDate, setPendingDate] = useState<string | null>(null);
  const changeDate = (next: string) => {
    if (next === date || busyRowIds.current.size > 0 || batchDeletingAttendance) return;
    if (hasUnsaved) {
      setPendingDate(next);
      return;
    }
    setDrafts(new Map());
    setDate(next);
  };
  // A date typed into the field while rows are unsaved, held until Enter or leaving the field.
  const [typedDate, setTypedDate] = useState<string | null>(null);
  const typingDate = useRef(false);
  const commitTypedDate = () => {
    if (typedDate) changeDate(typedDate);
    setTypedDate(null);
  };

  // Arrival status, grace and the payable time-in all come from the payroll engine, row by row.
  const arrivalMap = useMemo(
    () => new Map(activeRows.map((row) => [row.attendanceId, { arrivalStatus: row.arrivalStatus ?? "NONE", minutesLate: row.minutesLate ?? 0 }])),
    [activeRows],
  );

  const clampedTimeInIds = useMemo(
    () => new Set(activeRows.filter((row) => clampedPayableTimeIn(row)).map((row) => row.attendanceId)),
    [activeRows],
  );

  const isLate = (row: AttendanceListItem) => arrivalMap.get(row.attendanceId)?.arrivalStatus === "LATE";
  const employeeQuery = employeeFilter.toLowerCase();
  /** Whether a row passes every filter but `skip`: a button's count leaves out its own filter, so it is what a click shows. */
  const passesFilters = (row: AttendanceListItem, skip: "status" | "late" | "source" | null) =>
    (!employeeQuery || `${row.fullName} ${row.userId}`.toLowerCase().includes(employeeQuery)) &&
    (!departmentFilter || row.department === departmentFilter) &&
    (skip === "source" || !sourceFilter || row.source === sourceFilter) &&
    (skip === "late" || !lateOnly || isLate(row)) &&
    (skip === "status" || !statusFilter || row.status === statusFilter);
  const filteredRows = activeRows.filter((row) => passesFilters(row, null));
  const filtering = Boolean(employeeFilter || departmentFilter || statusFilter || sourceFilter || lateOnly);
  // The statuses count the rows every other filter lets through, so with no status chosen All matches the rows shown;
  // each record has one status, so they add up to All.
  const statusRows = activeRows.filter((row) => passesFilters(row, "status"));
  const sourceRows = activeRows.filter((row) => passesFilters(row, "source"));
  const counts = {
    all: statusRows.length,
    lateTimeout: statusRows.filter((r) => r.status === "LATE_TIMEOUT").length,
    working: statusRows.filter((r) => r.status === "WORKING").length,
    completed: statusRows.filter((r) => r.status === "COMPLETED").length,
    missed: statusRows.filter((r) => r.status === "MISSED").length,
    late: activeRows.filter((row) => passesFilters(row, "late") && isLate(row)).length,
    assisted: sourceRows.filter((r) => r.source === "ADMIN_ASSISTED_SCAN").length,
    backdated: sourceRows.filter((r) => r.source === "ADMIN_BACKDATED_ENTRY").length,
  };

  // On screen only: counts, selection and the CSV export keep using filteredRows in the server's order. Rows sort
  // by the time they show, so a clamped time-in sorts as its payable 9:00 AM.
  const [timeOrder, toggleTimeOrder] = useTimeOrder("alpha_premier_sort_attendance_corrections");
  const shownRows = sortByTime(
    filteredRows,
    (row) => clampedPayableTimeIn(row) ?? row.timeIn,
    timeOrder,
  );
  // Unsaved rows that the filters hide get a note by the count, with a way to show them again.
  const shownIds = new Set(filteredRows.map((row) => row.attendanceId));
  const hiddenUnsaved = activeRows.filter((row) => {
    const draft = drafts.get(row.attendanceId);
    return draft !== undefined && draftChanged(draft) && !shownIds.has(row.attendanceId);
  }).length;
  const clearFilters = () => {
    setStatusFilter("");
    setSourceFilter("");
    setLateOnly(false);
    setEmployeeFilter("");
    setDepartmentFilter("");
  };

  const departments = [
    ...new Set(
      activeRows
        .map((row) => row.department)
        .filter((d): d is string => Boolean(d)),
    ),
  ];

  const [selectedAttendanceIds, setSelectedAttendanceIds] = useState<Set<string>>(new Set());
  // A selection belongs to one date's rows.
  useEffect(() => {
    setSelectedAttendanceIds(new Set());
  }, [date]);
  const [batchDeleteAttendanceOpen, setBatchDeleteAttendanceOpen] = useState(false);
  const [batchDeletingAttendance, setBatchDeletingAttendance] = useState(false);
  // No other date while rows are saving or deleting: their refresh must land on this date.
  const dateLocked = rowsBusy || batchDeletingAttendance;
  const masterAttendanceCheckboxRef = useRef<HTMLInputElement>(null);
  const attendanceWrapRef = useRef<HTMLDivElement>(null);
  const [showAllAttendance, setShowAllAttendance] = useState(false);
  const attendanceOverflowing = useVerticalOverflow(attendanceWrapRef, true);

  const allAttendanceSelected = filteredRows.length > 0 && selectedAttendanceIds.size === filteredRows.length;
  const someAttendanceSelected = selectedAttendanceIds.size > 0 && selectedAttendanceIds.size < filteredRows.length;
  const attendanceSelecting = selectedAttendanceIds.size > 0;
  const listBarRef = useRef<HTMLDivElement>(null);
  const selectionBarRef = useRef<HTMLDivElement>(null);
  // The selection-bar button that started the last action, so the focus can come back after the bar hides.
  const barActionFrom = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (masterAttendanceCheckboxRef.current) {
      masterAttendanceCheckboxRef.current.indeterminate = someAttendanceSelected;
    }
  }, [someAttendanceSelected]);

  // The bar that isn't showing can't be clicked or tabbed into (React 18 has no inert prop).
  useLayoutEffect(() => {
    listBarRef.current?.toggleAttribute("inert", attendanceSelecting);
    selectionBarRef.current?.toggleAttribute("inert", !attendanceSelecting);
  }, [attendanceSelecting]);

  // When an action started from the selection bar ends, put the focus somewhere sensible if the bar dropped it: the
  // header tick box once the bar hides, else back on the button (it was disabled while the action ran). Only when the
  // focus fell to the page or is still in the hidden bar, and never while a pop-up is open.
  useLayoutEffect(() => {
    const from = barActionFrom.current;
    if (!from || batchDeletingAttendance || document.querySelector("[aria-modal='true']")) return;
    barActionFrom.current = null;
    const focus = document.activeElement;
    if (!attendanceSelecting) {
      if (focus === document.body || selectionBarRef.current?.contains(focus)) masterAttendanceCheckboxRef.current?.focus({ preventScroll: true });
    } else if (focus === document.body) {
      const target = from.disabled || !from.isConnected
        ? selectionBarRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        : from;
      target?.focus({ preventScroll: true });
    }
  }, [attendanceSelecting, batchDeletingAttendance]);

  useEffect(() => {
    setSelectedAttendanceIds((prev) => {
      const valid = new Set(filteredRows.map((r) => r.attendanceId));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (valid.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [filteredRows]);

  const toggleSelectAllAttendance = () => {
    if (allAttendanceSelected) {
      setSelectedAttendanceIds(new Set());
    } else {
      setSelectedAttendanceIds(new Set(filteredRows.map((r) => r.attendanceId)));
    }
  };

  const toggleSelectAttendance = (id: string) => {
    setSelectedAttendanceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exportSelectedAttendance = () => {
    const selectedRows = filteredRows.filter((r) => selectedAttendanceIds.has(r.attendanceId));
    if (selectedRows.length === 0) return;
    const result = exportAttendanceCsv(
      selectedRows,
      arrivalMap,
      clampedTimeInIds,
      date,
    );
    if (result.success) {
      setMessage(null);
      showToast(`Generated ${result.fileName} (${selectedRows.length} rows).`);
      setFileResult({
        filePath: result.filePath,
        directoryPath: result.directoryPath,
        fileName: result.fileName,
        fileKind: "csv",
        isPortableMode: false,
      });
    } else setMessage({ tone: "error", text: result.message });
  };

  const removeBatchAttendance = async () => {
    if (selectedAttendanceIds.size === 0) return;
    setBatchDeleteAttendanceOpen(false);
    setBatchDeletingAttendance(true);
    const targetRows = filteredRows.filter((r) => selectedAttendanceIds.has(r.attendanceId));
    const failed: string[] = [];
    for (const r of targetRows) {
      const deleted = await deleteAdminAttendance(r.attendanceId, r.attendanceDate).then((res) => res.success, () => false);
      if (!deleted) failed.push(r.attendanceId);
    }
    setBatchDeletingAttendance(false);
    // Records that could not be deleted stay selected, ready for another try.
    setSelectedAttendanceIds(new Set(failed));
    showResult(batchOutcome(targetRows.length - failed.length, targetRows.length, "Deleted", "attendance record(s)"), setMessage);
    onSaved();
  };

  const exportWorkbook = async () => {
    setExporting(true);
    const result = exportAttendanceCsv(
      filteredRows,
      arrivalMap,
      clampedTimeInIds,
      date,
    );
    setExporting(false);
    if (result.success) {
      setMessage(null);
      showToast(`Generated ${result.fileName} (${filteredRows.length} rows).`);
      setFileResult({
        filePath: result.filePath,
        directoryPath: result.directoryPath,
        fileName: result.fileName,
        fileKind: "csv",
        isPortableMode: false,
      });
    } else setMessage({ tone: "error", text: result.message });
  };

  // Each record has exactly one status, so the counts add up to All. The late time-out problem comes right after All.
  const statusOptions = [
    ["", "All", counts.all],
    ["LATE_TIMEOUT", STATUS_WORD.LATE_TIMEOUT, counts.lateTimeout],
    ["WORKING", STATUS_WORD.WORKING, counts.working],
    ["COMPLETED", STATUS_WORD.COMPLETED, counts.completed],
    ["MISSED", STATUS_WORD.MISSED, counts.missed],
  ] as const;
  // Show only: Late (an arrival flag) combines with everything; Assisted and Backdated are one source at a time.
  const toggleSource = (source: string) => setSourceFilter((current) => (current === source ? "" : source));
  const showOnly = [
    { label: "Late", Icon: Clock, count: counts.late, on: lateOnly, title: "Show only late arrivals", toggle: () => setLateOnly((on) => !on) },
    { label: "Assisted", Icon: UserCheck, count: counts.assisted, on: sourceFilter === "ADMIN_ASSISTED_SCAN", title: "Show only kiosk scans assisted by an administrator", toggle: () => toggleSource("ADMIN_ASSISTED_SCAN") },
    { label: "Backdated", Icon: History, count: counts.backdated, on: sourceFilter === "ADMIN_BACKDATED_ENTRY", title: "Show only backdated attendance manually entered by an administrator", toggle: () => toggleSource("ADMIN_BACKDATED_ENTRY") },
  ] satisfies { label: string; Icon: LucideIcon; count: number; on: boolean; title: string; toggle: () => void }[];
  // In both bar layers, so they stay reachable while rows are ticked: unsaved rows the filters hide, the phone sort
  // toggle and See all.
  const barNotes = (
    <>
      {hiddenUnsaved > 0 && (
        <span className="attendance-hidden-unsaved">
          {hiddenUnsaved === 1 ? "1 unsaved row" : `${hiddenUnsaved} unsaved rows`} hidden by filters ·{" "}
          <button type="button" className="text-button" onClick={clearFilters}>
            Show
          </button>
        </span>
      )}
      {/* Phones: the cards have no Time in heading, so the order gets a small toggle here. */}
      <TimeOrderToggle column="Time in" order={timeOrder} onToggle={toggleTimeOrder} />
      {(showAllAttendance || attendanceOverflowing) && (
        <button
          className="text-button see-all-toggle"
          type="button"
          aria-expanded={showAllAttendance}
          onClick={() => setShowAllAttendance((current) => !current)}
        >
          {showAllAttendance ? "Show less" : "See all"}
        </button>
      )}
    </>
  );

  return (
    <section className="table-with-bar">
      <div className="attendance-filter-bar">
        <div className="attendance-filter-top">
          {/* Status: one choice at a time, marked by a gold underline that slides to it. */}
          <div className="attendance-status-filter" role="group" aria-label="Filter by status" ref={statusFilterRef}>
            {statusThumb && (
              <span
                className="attendance-status-thumb"
                aria-hidden="true"
                style={{ width: statusThumb.width, transform: `translate(${statusThumb.x}px, ${statusThumb.y + statusThumb.height - 2}px)` }}
              />
            )}
            {statusOptions.map(([id, label, count]) => (
              <button
                key={label}
                type="button"
                className={`${statusFilter === id ? "is-active" : ""}${count ? "" : " is-empty"}`}
                aria-pressed={statusFilter === id}
                onClick={() => setStatusFilter(id && statusFilter === id ? "" : id)}
              >
                {label} <span className={`filter-count${id === "LATE_TIMEOUT" && count > 0 ? " is-alert" : ""}`}>{count}</span>
              </button>
            ))}
          </div>
          {/* Toggles that switch on and off on their own and combine with the status; dimmed with nothing to show. */}
          <div className="attendance-source-filter" role="group" aria-label="Show only">
            {showOnly.map(({ label, Icon, count, on, title, toggle }) => (
              <button
                key={label}
                className={`source-toggle${on ? " is-active" : ""}${count ? "" : " is-empty"}`}
                type="button"
                aria-pressed={on}
                title={title}
                onClick={toggle}
              >
                <Icon size={14} aria-hidden="true" />
                {label} <span className="filter-count">{count}</span>
              </button>
            ))}
          </div>
        </div>
        {/* One compact row like Live attendance's filters: the day, Today, a name search and the department. */}
        <div className="attendance-filters">
          <input
            type="date"
            className="input"
            aria-label="Filter attendance date"
            value={typedDate ?? date}
            disabled={dateLocked}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitTypedDate();
              else typingDate.current = true;
            }}
            onPointerDown={() => {
              typingDate.current = false;
            }}
            onBlur={commitTypedDate}
            onChange={(event) => {
              const val = event.target.value;
              if (!val) return;
              // With unsaved rows, a date typed segment by segment waits for Enter or leaving the field, so the
              // discard question never opens on a half-typed date. A date picked from the calendar applies at once.
              if (hasUnsaved && typingDate.current) setTypedDate(val);
              else {
                setTypedDate(null);
                changeDate(val);
              }
            }}
          />
          <button
            type="button"
            className="filter-preset-btn"
            onClick={() => changeDate(localDate())}
            disabled={date === localDate() || dateLocked}
          >
            Today
          </button>
          <div className="search-input-wrap">
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              className="input"
              aria-label="Employee"
              placeholder="Name or ID"
              value={employeeFilter}
              onChange={(event) => setEmployeeFilter(event.target.value)}
            />
          </div>
          <select
            className="select"
            aria-label="Department"
            value={departmentFilter}
            onChange={(event) => setDepartmentFilter(event.target.value)}
          >
            <option value="">All departments</option>
            {departments.map((department) => (
              <option key={department} value={department}>
                {department}
              </option>
            ))}
          </select>
          <NoticeLine notice={message} className="attendance-filter-message" />
        </div>
      </div>
      <GeneratedFileActions result={fileResult} label="Attendance export" />
      {loadStatus === "failed" && onRetry && <LoadFailed what="attendance for this date" onRetry={onRetry} />}

      {/* While rows are ticked the selection bar takes the list bar's place. Both stay in one grid cell (the bar keeps
          the taller one's height, so the rows never move); the one not showing is hidden and inert, and they cross-fade. */}
      <div className="table-header-bar attendance-list-bar">
        <div className="attendance-bar-layer" ref={listBarRef} aria-hidden={attendanceSelecting}>
          <div className="table-selection-count">
            {/* The chosen day, once for the whole table, and one count. */}
            <span className="attendance-day">{formatDate(date)}</span>
            <span>{filtering ? `${filteredRows.length} of ${recordCount(activeRows.length)}` : recordCount(filteredRows.length)}</span>
            {barNotes}
          </div>
          <div className="table-batch-actions">
            <button className="admin-button" type="button" onClick={() => setBackdatedModalOpen(true)}>
              <Plus size={15} aria-hidden="true" /> Add missed attendance
            </button>
            <button className="admin-button" type="button" disabled={exporting || !ready} onClick={() => void exportWorkbook()}>
              <Download size={15} aria-hidden="true" /> {exporting ? "Preparing..." : "Export CSV"}
            </button>
          </div>
        </div>
        <div
          className="attendance-bar-layer attendance-selection-bar"
          role="group"
          aria-label="Selected attendance records"
          ref={selectionBarRef}
          aria-hidden={!attendanceSelecting}
        >
          <div className="table-selection-count">
            <span className="table-selection-badge">{selectedAttendanceIds.size} selected</span>
            <button
              className="text-button"
              type="button"
              onClick={(event) => {
                barActionFrom.current = event.currentTarget;
                setSelectedAttendanceIds(new Set());
              }}
            >
              Clear
            </button>
            {barNotes}
          </div>
          <div className="table-batch-actions">
            <button className="admin-button" type="button" disabled={!ready} onClick={exportSelectedAttendance}>
              Export selected
            </button>
            <button
              className="admin-button danger-button"
              type="button"
              disabled={batchDeletingAttendance || !ready}
              onClick={(event) => {
                barActionFrom.current = event.currentTarget;
                setBatchDeleteAttendanceOpen(true);
              }}
            >
              Delete selected
            </button>
          </div>
        </div>
      </div>

      <div
        className={`table-wrap attendance-table-wrap ${showAllAttendance ? "is-expanded" : ""}`}
        ref={attendanceWrapRef}
      >
        <table>
          <thead>
            <tr>
              <th className="table-select-col">
                <input
                  type="checkbox"
                  ref={masterAttendanceCheckboxRef}
                  checked={allAttendanceSelected}
                  disabled={!ready}
                  onChange={toggleSelectAllAttendance}
                  aria-label="Select all attendance records"
                />
              </th>
              <th>Employee</th>
              <TimeSortHeading label="Time in" order={timeOrder} onToggle={toggleTimeOrder} />
              <th>Arrival</th>
              <th>Time out</th>
              <th>Status</th>
              <th>
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {loadStatus === "loading" ? (
              <LoadingRows columns={7} label="Loading attendance…" />
            ) : filteredRows.length === 0 ? (
              loadStatus === "failed" ? null : (
              <tr>
                <td colSpan={7} className="table-empty-cell">
                  <div className="empty-state">
                    No attendance records found for this day
                    {filtering ? " matching the selected filters" : ""}
                    .
                  </div>
                </td>
              </tr>
              )
            ) : (
              shownRows.map((row) => (
                <AttendanceEditRow
                  key={row.attendanceId}
                  row={row}
                  draft={drafts.get(row.attendanceId)}
                  onDraftChange={(draft) => setDraft(row.attendanceId, draft)}
                  onBusyChange={(busy) => setRowBusy(row.attendanceId, busy)}
                  selected={selectedAttendanceIds.has(row.attendanceId)}
                  onToggleSelect={() => toggleSelectAttendance(row.attendanceId)}
                  arrivalInfo={arrivalMap.get(row.attendanceId)}
                  timeInClamped={clampedTimeInIds.has(row.attendanceId)}
                  onSaved={onSaved}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
      <ConfirmDialog
        open={batchDeleteAttendanceOpen}
        busy={batchDeletingAttendance}
        tone="danger"
        title="Delete selected attendance records?"
        message={`Are you sure you want to delete ${selectedAttendanceIds.size} selected attendance record(s)? This will remove them from the logs.`}
        confirmLabel="Delete records"
        onCancel={() => setBatchDeleteAttendanceOpen(false)}
        onConfirm={() => void removeBatchAttendance()}
      />
      <ConfirmDialog
        open={pendingDate !== null}
        busy={false}
        tone="danger"
        title="Discard unsaved changes?"
        message={`Some times on ${formatDate(date)} are not saved yet. Showing ${pendingDate ? formatDate(pendingDate) : "another day"} discards them.`}
        cancelLabel="Keep editing"
        confirmLabel="Discard changes"
        onCancel={() => setPendingDate(null)}
        onConfirm={() => {
          if (pendingDate) setDate(pendingDate);
          setDrafts(new Map());
          setPendingDate(null);
        }}
      />
      {backdatedModalOpen && (
        <BackdatedAttendanceModal
          activeEmployees={users.filter(
            (u) => u.status === "ACTIVE" && u.cardType !== "ADMIN_ASSIST",
          )}
          onClose={() => setBackdatedModalOpen(false)}
          onSaved={(createdDate?: string) => {
            if (createdDate) {
              changeDate(createdDate);
            }
            void onSaved();
          }}
        />
      )}
    </section>
  );
}

function BackdatedAttendanceModal({
  activeEmployees,
  onClose,
  onSaved,
}: {
  activeEmployees: AdminUser[];
  onClose: () => void;
  onSaved: (createdDate?: string) => void;
}) {
  const yesterday = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
  }, []);

  const [userId, setUserId] = useState(activeEmployees[0]?.userId ?? "");
  const [attendanceDate, setAttendanceDate] = useState(yesterday);
  const [timeIn, setTimeIn] = useState("08:00");
  const [timeOut, setTimeOut] = useState("17:00");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  useDialogKeys(dialogRef, onClose, { busy });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId || !attendanceDate || !timeIn || !reason.trim()) {
      setError("Employee, attendance date, time-in, and reason are required.");
      return;
    }
    if (attendanceDate > yesterday) {
      setError("Backdated attendance date must be strictly in the past.");
      return;
    }
    if (timeOut && timeOut < timeIn) {
      setError("Time-out cannot precede time-in.");
      return;
    }

    setBusy(true);
    setError("");
    const timeInIso = `${attendanceDate}T${timeIn}:00+08:00`;
    const timeOutIso = timeOut ? `${attendanceDate}T${timeOut}:00+08:00` : null;

    try {
      const response = await createAdminBackdatedAttendance({
        userId,
        attendanceDate,
        timeIn: timeInIso,
        timeOut: timeOutIso,
        reason: reason.trim(),
      });
      setBusy(false);
      if (response.success) {
        showToast("Missed attendance added.");
        onSaved(attendanceDate);
        onClose();
      } else {
        setError(response.error?.message ?? "Failed to add backdated attendance.");
      }
    } catch {
      setBusy(false);
      setError("Network or server error while adding backdated attendance.");
    }
  };

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
        aria-labelledby="backdated-heading"
      >
        <div className="assisted-modal-header">
          <div className="assisted-modal-title-wrap">
            <div className="assisted-modal-icon icon-purple" aria-hidden="true">
              <CalendarPlus size={22} />
            </div>
            <div>
              <p className="section-kicker">Attendance override</p>
              <h3 id="backdated-heading">Add Missed Attendance</h3>
              <p className="assisted-modal-subtitle">
                Create a past-date entry with verified time-in and audit record
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
            {error && <p className="dashboard-alert">{error}</p>}

            <div className="modal-audit-callout purple-callout">
              <History size={16} />
              <span>Backdated attendance entries are permanently tagged with an audit badge and linked to your administrator session in reports and sync logs.</span>
            </div>

            <div className="modal-section-group">
              <label className="field-label" htmlFor="backdated-employee">
                Employee:
              </label>
              <select
                id="backdated-employee"
                className="select"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                required
              >
                {activeEmployees.map((emp) => (
                  <option key={emp.userId} value={emp.userId}>
                    {emp.fullName} ({emp.userId}){emp.department ? ` — ${emp.department}` : ""}
                  </option>
                ))}
              </select>
            </div>

            <div className="modal-section-group">
              <label className="field-label" htmlFor="backdated-date">
                Attendance Date (past date only):
              </label>
              <input
                id="backdated-date"
                type="date"
                className="input"
                max={yesterday}
                value={attendanceDate}
                onChange={(e) => setAttendanceDate(e.target.value)}
                required
              />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
              <div className="modal-section-group">
                <label className="field-label" htmlFor="backdated-time-in">
                  Time In
                </label>
                <input
                  id="backdated-time-in"
                  type="time"
                  className="input"
                  value={timeIn}
                  onChange={(e) => setTimeIn(e.target.value)}
                  required
                />
              </div>
              <div className="modal-section-group">
                <label className="field-label" htmlFor="backdated-time-out">
                  Time Out <span style={{ color: "var(--quiet)", fontWeight: 400 }}>(optional)</span>
                </label>
                <input
                  id="backdated-time-out"
                  type="time"
                  className="input"
                  value={timeOut}
                  onChange={(e) => setTimeOut(e.target.value)}
                />
              </div>
            </div>

            <div className="modal-section-group">
              <label className="field-label" htmlFor="backdated-reason">
                Reason (mandatory audit trail):
              </label>
              <textarea
                id="backdated-reason"
                className="input"
                placeholder="e.g. Employee forgot RFID card at home and reported in person to supervisor at 8:00 AM…"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="assisted-modal-footer">
            <button className="modal-btn-cancel" type="button" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              className="modal-btn-primary"
              type="submit"
              disabled={busy || !userId || !attendanceDate || !timeIn || !reason.trim()}
            >
              {busy ? (
                <>
                  <LoaderCircle className="spin" size={16} /> Saving…
                </>
              ) : (
                <>
                  <PlusCircle size={16} /> Add missed attendance
                </>
              )}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function exportAttendanceCsv(
  rows: AttendanceListItem[],
  arrivalMap: Map<string, { arrivalStatus: ArrivalStatus; minutesLate: number }>,
  clampedTimeInIds: Set<string>,
  startDate: string,
  endDate?: string,
):
  | {
      success: true;
      fileName: string;
      content: string;
      filePath: null;
      directoryPath: null;
    }
  | { success: false; message: string } {
  const fileName =
    endDate && endDate !== startDate
      ? `attendance-export-${startDate}-to-${endDate}.csv`
      : `attendance-export-${startDate}.csv`;
  const headers = [
    "Employee name",
    "Employee ID",
    "Department",
    "Date",
    "Time in",
    "Arrival",
    "Time out",
    "Status",
    "Total hours",
    "Source",
    "Recorded By",
    "Recorded Reason",
    "Recorded At",
    // Audit column appended last so every pre-existing column keeps its index.
    "Actual time-in",
  ];
  const csvCell = (value: string | number | null) =>
    `"${String(value ?? "").replace(/"/g, '""')}"`;
  const totalHours = (row: AttendanceListItem) => {
    if (!row.timeIn || !row.timeOut) return "";
    const hours =
      (new Date(row.timeOut).getTime() - new Date(row.timeIn).getTime()) /
      3_600_000;
    return Number.isFinite(hours) && hours >= 0
      ? Math.min(8, Math.round(hours)).toString()
      : "";
  };
  const getArrivalText = (row: AttendanceListItem) => {
    const info = arrivalMap.get(row.attendanceId);
    if (!info || info.arrivalStatus === "NONE") return "";
    if (info.arrivalStatus === "GRACE_PERIOD") return "Grace (weekly)";
    if (info.arrivalStatus === "ON_TIME") return "On time";
    return `Late (${info.minutesLate}m)`;
  };
  // Clamped rows export their hourly payable Manila time-in in the
  // Time in column (same ISO shape as every other row); the real scan keeps
  // its own audit column because a CSV cell cannot carry the table tooltip.
  const payableTimeIn = (row: AttendanceListItem) =>
    (clampedTimeInIds.has(row.attendanceId) ? clampedPayableTimeIn(row) : null) ?? row.timeIn;
  const content = [
    headers,
    ...rows.map((row) => [
      row.fullName,
      row.userId,
      row.department,
      row.attendanceDate,
      payableTimeIn(row),
      getArrivalText(row),
      row.timeOut,
      row.status,
      totalHours(row),
      row.source ?? "",
      row.recordedBy ?? "",
      row.recordedReason ?? "",
      row.recordedAt ?? "",
      row.timeIn,
    ]),
  ]
    .map((line) => line.map(csvCell).join(","))
    .join("\r\n");
  if (!rows.length)
    return {
      success: false,
      message: "No attendance matches the active filters; nothing was exported.",
    };
  const url = URL.createObjectURL(
    new Blob([`\ufeff${content}\r\n`], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return {
    success: true,
    fileName,
    content,
    filePath: null,
    directoryPath: null,
  };
}

/** Edited HH:MM becomes HH:MM:00+08:00; an unchanged HH:MM keeps the original stamp. */
export function keepOrBuildManilaIso(date: string, hhmm: string, original: string | null | undefined): string | null {
  if (!hhmm) return null;
  if (original && original.slice(11, 16) === hhmm) return original;
  return `${date}T${hhmm}:00+08:00`;
}

function AttendanceEditRow({
  row,
  draft,
  onDraftChange,
  onBusyChange,
  selected,
  onToggleSelect,
  arrivalInfo,
  timeInClamped,
  onSaved,
}: {
  row: AttendanceListItem;
  /** Present while the row is open for editing. */
  draft?: AttendanceDraft;
  /** Opens or updates the row's editor (a draft) or closes it (null). */
  onDraftChange: (draft: AttendanceDraft | null) => void;
  /** Reports while the row is saving or deleting, so the date can't change under it. */
  onBusyChange: (busy: boolean) => void;
  selected?: boolean;
  onToggleSelect?: () => void;
  arrivalInfo?: { arrivalStatus: ArrivalStatus; minutesLate: number };
  timeInClamped?: boolean;
  onSaved: () => void | Promise<void>;
}) {
  // A note that needs acting on stays on the row; a plain save or delete shows as a toast.
  const [message, setMessage] = useState<Notice | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteAttendanceConfirm, setDeleteAttendanceConfirm] = useState(false);
  const rowRef = useRef<HTMLTableRowElement>(null);
  const timeInInputRef = useRef<HTMLInputElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const editing = draft !== undefined;
  const unsaved = draft ? draftChanged(draft) : false;
  const notice = message ?? (draft?.changedOnServer ? RECORD_CHANGED_NOTICE : null);
  // Opening the editor moves focus to its time-in field. Closing it moves focus back to Edit: always after Cancel,
  // after a save only when focus is still in this row (or nowhere), never away from typing elsewhere.
  const moveFocus = useRef<"always" | "if-here" | null>(null);
  useEffect(() => {
    const mode = moveFocus.current;
    moveFocus.current = null;
    if (!mode) return;
    if (editing) {
      timeInInputRef.current?.focus();
      return;
    }
    const active = document.activeElement;
    if (mode === "always" || !active || active === document.body || rowRef.current?.contains(active)) editButtonRef.current?.focus();
  }, [editing]);
  const openEditor = () => {
    moveFocus.current = "always";
    onDraftChange(draftFor(row));
  };
  const closeEditor = (focus: "always" | "if-here") => {
    moveFocus.current = focus;
    onDraftChange(null);
  };

  const late = row.status === "LATE_TIMEOUT";
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    onBusyChange(true);
    try {
      // An untouched time keeps its exact stamp: rebuilding it as HH:MM:00 would drop
      // the seconds and can change late hours and grace use.
      const timeInIso = keepOrBuildManilaIso(row.attendanceDate, draft.timeIn, row.timeIn);
      const timeOutIso = keepOrBuildManilaIso(row.attendanceDate, draft.timeOut, row.timeOut);
      const response = await saveAdminAttendance(row.attendanceId, {
        attendanceDate: row.attendanceDate,
        timeIn: timeInIso,
        timeOut: timeOutIso,
        expectedTimeIn: row.timeIn || null,
        expectedTimeOut: row.timeOut || null,
      });
      if (response.success) {
        if (timeOutIso && isLateTimeout(timeOutIso)) {
          setMessage({ tone: "info", text: "Saved. Still a late time-out: enter the real time-out." });
        } else {
          setMessage(null);
          showToast(`Saved ${row.fullName}'s times.`);
        }
        // Back to read-only once the list shows the new times.
        await onSaved();
        closeEditor("if-here");
      } else {
        setMessage({ tone: "error", text: response.error?.message ?? "Unable to save attendance." });
        // A stale row cannot be saved again as-is; reload it so the admin sees the current times.
        if (response.error?.code === "ATTENDANCE_CONFLICT" || response.error?.code === "ATTENDANCE_NOT_FOUND") await onSaved();
      }
    } finally {
      setSaving(false);
      onBusyChange(false);
    }
  };
  const remove = async () => {
    setDeleteAttendanceConfirm(false);
    setDeleting(true);
    onBusyChange(true);
    try {
      const response = await deleteAdminAttendance(
        row.attendanceId,
        row.attendanceDate,
      );
      if (response.success) {
        showResult({ tone: "success", text: `Deleted ${row.fullName}'s record.` }, setMessage);
        await onSaved();
      } else {
        setMessage({ tone: "error", text: response.error?.message ?? "Unable to delete record." });
      }
    } finally {
      setDeleting(false);
      onBusyChange(false);
    }
  };

  const renderArrival = () => {
    if (!arrivalInfo || arrivalInfo.arrivalStatus === "NONE") {
      return <span className="arrival-badge badge-none">—</span>;
    }
    if (arrivalInfo.arrivalStatus === "GRACE_PERIOD") {
      return (
        <span className="arrival-badge badge-grace" title="Weekly grace used: arrived by 8:15 AM, no late deduction (once per week)">
          Grace
        </span>
      );
    }
    if (arrivalInfo.arrivalStatus === "ON_TIME") {
      return <span className="arrival-badge badge-ontime">On time</span>;
    }
    return (
      <span
        className="arrival-badge badge-late"
        title={`Late arrival (${arrivalInfo.minutesLate} minutes)`}
      >
        Late {formatLateMinutes(arrivalInfo.minutesLate)}
      </span>
    );
  };

  /** The editor's time field with its clear button. */
  const timeField = (which: "in" | "out") => {
    if (!draft) return null;
    const value = which === "in" ? draft.timeIn : draft.timeOut;
    // Typing again answers the "record changed" note.
    const setValue = (next: string) =>
      onDraftChange(which === "in" ? { ...draft, timeIn: next, changedOnServer: false } : { ...draft, timeOut: next, changedOnServer: false });
    const label = `time ${which}`;
    return (
      <div className="time-input-group">
        <input
          ref={which === "in" ? timeInInputRef : undefined}
          aria-label={`Time ${which} for ${row.fullName}`}
          type="time"
          value={value}
          disabled={saving}
          onChange={(e) => setValue(e.target.value)}
        />
        {value && !saving ? (
          <button
            type="button"
            className="time-clear-btn"
            title={`Clear ${label}`}
            aria-label={`Clear ${label} for ${row.fullName}`}
            onMouseDown={(e) => {
              e.preventDefault();
              setValue("");
            }}
            onClick={(e) => {
              e.preventDefault();
              setValue("");
            }}
          >
            <X size={13} />
          </button>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <tr ref={rowRef} className={`attendance-row${selected ? " selected-row" : ""}${editing ? " is-open" : ""}${unsaved ? " is-unsaved" : ""}`}>
        <td className="table-select-cell">
          {onToggleSelect && (
            <input
              type="checkbox"
              checked={Boolean(selected)}
              onChange={onToggleSelect}
              aria-label={`Select attendance for ${row.fullName}`}
            />
          )}
        </td>
        <td>
          <strong>{row.fullName}</strong>
          <small>{row.userId}</small>
          {row.source === "ADMIN_ASSISTED_SCAN" && (
            <span
              className="badge badge-assisted"
              title={`Kiosk scan assisted by: ${row.recordedBy || "Admin"}${row.recordedReason ? ` (${row.recordedReason})` : ""}`}
            >
              <UserCheck size={11} /> Assisted by {row.recordedBy || "Admin"}
            </span>
          )}
          {row.source === "ADMIN_BACKDATED_ENTRY" && (
            <span
              className="badge badge-backdated"
              title={`Backdated manual entry by: ${row.recordedBy || "Admin"}${row.recordedReason ? ` — Reason: ${row.recordedReason}` : ""}`}
            >
              <History size={11} /> Backdated by {row.recordedBy || "Admin"}{row.recordedReason ? ` — ${row.recordedReason}` : ""}
            </span>
          )}
          {unsaved && <span className="unsaved-tag">Unsaved</span>}
        </td>
        <td>
          {editing ? (
            timeField("in")
          ) : timeInClamped && row.timeIn ? (
            // The payable (clamped) time; the actual scan is in the tooltip, and a click opens it for editing.
            <button
              type="button"
              className="clamped-time-in-chip clamped-time-in-static"
              data-testid="clamped-time-in"
              title={`Actual scan: ${formatTime(row.timeIn, ATTENDANCE_TIMEZONE)} (payable time clamped)`}
              aria-label={`Shown as ${formatTime(clampedPayableTimeIn(row) ?? row.timeIn)} for ${row.fullName}; actual scan ${formatTime(row.timeIn, ATTENDANCE_TIMEZONE)}. Click to edit.`}
              onClick={openEditor}
            >
              {formatTime(clampedPayableTimeIn(row) ?? row.timeIn)}
            </button>
          ) : row.timeIn ? (
            formatTime(row.timeIn)
          ) : (
            "—"
          )}
        </td>
        <td>{renderArrival()}</td>
        <td>{editing ? timeField("out") : row.timeOut ? formatTime(row.timeOut) : "—"}</td>
        <td>
          <StatusWord status={row.status} />
        </td>
        <td className="attendance-row-actions">
          {editing ? (
            <>
              <button className="attendance-save-button" type="button" disabled={saving} onClick={() => void save()}>
                {saving ? "Saving…" : "Save"}
              </button>
              <button
                className="text-button"
                type="button"
                disabled={saving}
                onClick={() => {
                  setMessage(null);
                  closeEditor("always");
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                ref={editButtonRef}
                className="text-button"
                type="button"
                aria-label={`Edit times for ${row.fullName}`}
                disabled={deleting}
                onClick={openEditor}
              >
                Edit
              </button>
              <button
                className="text-button danger-button"
                type="button"
                aria-label={`Delete ${row.fullName}'s record`}
                disabled={deleting}
                onClick={() => setDeleteAttendanceConfirm(true)}
              >
                {deleting ? "Deleting..." : "Delete"}
              </button>
            </>
          )}
        </td>
      </tr>
      {/* A note for this record on its own full-width line under it: a save problem, or else for a late time-out one
          short line saying what to do. */}
      {(notice || late) && (
        <tr className="attendance-row-note">
          <td colSpan={7}>
            {notice ? (
              <NoticeLine notice={notice} className="row-message" />
            ) : (
              <p className="row-message attendance-late-note">
                Timed out after office hours. {editing ? "Enter the real time-out and click Save." : "Click Edit and enter the real time-out."}
              </p>
            )}
          </td>
        </tr>
      )}
      {deleteAttendanceConfirm && (
        <tr>
          <td colSpan={7} style={{ padding: 0 }}>
            <ConfirmDialog
              open={true}
              busy={deleting}
              tone="danger"
              title="Delete attendance record?"
              message={`This will permanently delete ${row.fullName}'s time-in/time-out record for ${formatDate(row.attendanceDate)}. This cannot be undone.`}
              confirmLabel="Delete record"
              onCancel={() => setDeleteAttendanceConfirm(false)}
              onConfirm={() => void remove()}
            />
          </td>
        </tr>
      )}
    </>
  );
}
