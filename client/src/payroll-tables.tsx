import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import type { PayrollCutoffRecord, CutoffCalculationBreakdownData, AttendanceDeductionItem } from "@rfid-attendance/shared";
import { INTERN_DAILY_RATE_PHP, INTERN_LATE_DEDUCTION_PER_HOUR_PHP } from "@rfid-attendance/shared";
import { deletePayrollCutoff, finalizePayrollCutoff } from "./api";
import { formatCutoffRange, formatDate } from "./format";
import { useDialogKeys } from "./use-dialog-keys";
import { NoticeLine } from "./notice";
import type { Notice } from "./notice";
import { LoadFailed, LoadingRows } from "./list-load";
import type { LoadStatus } from "./list-load";
import { useActiveThumb } from "./admin-panel";
import { toErrorMessage, useVerticalOverflow } from "./app-shared";
import { ConfirmDialog } from "./confirm-dialog";
import { EditPayrollDialog, batchOutcome, finalizeEach, showResult } from "./payroll-workspace";

type PayrollAmountColumn = { label: string; value: (row: PayrollCutoffRecord) => number };

// Money fields that are ₱0 for interns. The table hides each one while every row is ₱0;
// the Breakdown popup always lists them.
const PAYROLL_OPTIONAL_EARNINGS: PayrollAmountColumn[] = [
  { label: "HRA", value: (row) => row.hra ?? 0 },
  { label: "Incentives", value: (row) => row.incentivesAllowance },
  { label: "Special Allow.", value: (row) => row.specialAllowance },
  { label: "Total Allow.", value: (row) => row.totalAllowance },
  { label: "Reg. Hol.", value: (row) => row.regularHolidayPay },
  { label: "Spec. Hol.", value: (row) => row.specialHolidayPay },
  { label: "Overtime", value: (row) => row.overtimePay },
];

const PAYROLL_OPTIONAL_DEDUCTIONS: PayrollAmountColumn[] = [
  { label: "SSS", value: (row) => row.sss ?? 0 },
  { label: "PhilHealth", value: (row) => row.phic ?? 0 },
  { label: "HDMF", value: (row) => row.hdmf ?? 0 },
  { label: "Advance", value: (row) => row.salaryAdvance ?? 0 },
  { label: "Adjustment", value: negativeAdjustment },
];

function payrollDeptRole(row: PayrollCutoffRecord): string {
  return row.department || row.designation
    ? `${row.department ?? ""}${row.department && row.designation ? " — " : ""}${row.designation ?? ""}`
    : "—";
}

function payrollBankAccount(row: PayrollCutoffRecord): string {
  return row.bankName || row.accountNumber
    ? `${row.bankName ?? "CASH"} / ${row.accountNumber ?? "0000"}`
    : "CASH / 0000";
}

/** The full calculation and payslip detail for one payroll row, shown in the Breakdown popup. */
function PayrollBreakdownDetail({ row }: { row: PayrollCutoffRecord }) {
  const sss = row.sss ?? 0;
  const phic = row.phic ?? 0;
  const hdmf = row.hdmf ?? 0;
  const advance = row.salaryAdvance ?? 0;
  const parsedBreakdown = parseCalculationBreakdown(row.calculationBreakdown);
  const graceDays = parsedBreakdown?.deductions?.filter((item) => item.category === "GRACE").length ?? 0;
  const totalDeductions = payrollTotalDeductions(row);
  const netPay = row.netPay;
  // Every payslip field, including the ones the table hides while they are ₱0.
  // [label, value, class]: the class marks Total deductions (coral unless nothing was deducted).
  const fieldGroups: { title: string; fields: [string, string, string?][] }[] = [
    {
      title: "Employee",
      fields: [
        ["Employee #", row.employeeId],
        ["Dept / Role", payrollDeptRole(row)],
        ["Bank / A/C", payrollBankAccount(row)],
        ["TIN #", row.tin || "—"],
        ["Standard days", String(row.standardWorkingDays)],
        ["Paid days", String(row.actualWorkingDays)],
        ["LWOP", String(row.absentDays)],
        ["Daily rate", php(row.dailyRate)],
      ],
    },
    {
      title: "Earnings",
      fields: [
        ["Basic pay", php(row.basicPay)],
        ...PAYROLL_OPTIONAL_EARNINGS.map((column): [string, string] => [column.label, php(column.value(row))]),
        ["Total earnings", php(payrollTotalEarnings(row))],
      ],
    },
    {
      title: "Deductions",
      fields: [
        ...PAYROLL_OPTIONAL_DEDUCTIONS.map((column): [string, string] => [column.label, php(column.value(row))]),
        ["Absent", php(row.absenceDeduction)],
        ["Late / Halfday", php(row.lateDeduction + row.halfDayDeduction)],
        ["Total deductions", php(totalDeductions), deductionClass(totalDeductions)],
      ],
    },
  ];
  return (
    <>
      <div className="payroll-breakdown-fields">
        {fieldGroups.map((group) => (
          <section key={group.title}>
            <h3>{group.title}</h3>
            <dl>
              {group.fields.map(([label, value, className]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd className={className}>{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      {row.employeeType === "INTERN" ? (
        <div className="payroll-breakdown-formula">
          <p>
            <strong>Cutoff Rate:</strong> {php(row.totalCompensation || row.basicPay)} ({row.standardWorkingDays} std days at {php(INTERN_DAILY_RATE_PHP)}/day)
            {row.manualAdjustment > 0
              ? ` + ${php(row.manualAdjustment)} manual adjustment (${row.adjustmentReason})`
              : ""}
            {" = "}
            <strong>{php(payrollTotalEarnings(row))}</strong> (Gross Earnings).
            <br />
            <strong>Total Deductions:</strong>{" "}
            {php(row.absenceDeduction)} absent ({row.absentDays} day(s))
            {row.lateDeduction > 0 ? ` + ${php(row.lateDeduction)} late (${row.lateUnits} hr(s) at ${php(INTERN_LATE_DEDUCTION_PER_HOUR_PHP)}/hr)` : ""}
            {row.halfDayDeduction > 0 ? ` + ${php(row.halfDayDeduction)} half-day / undertime (${row.halfDayCount} day(s))` : ""}
            {graceDays > 0 ? ` + ${php(0)} for ${graceDays} weekly grace arrival(s)` : ""}
            {row.manualAdjustment < 0 ? ` + ${php(-row.manualAdjustment)} manual adjustment (${row.adjustmentReason})` : ""}
            {row.absenceDeduction === 0 && row.lateDeduction === 0 && row.halfDayDeduction === 0 && row.manualAdjustment >= 0 ? "None" : ""}
            {" = "}
            <strong className={`payroll-deductions-total ${deductionClass(totalDeductions)}`}>{php(totalDeductions)}</strong>.
            <br />
            <strong>Net Pay:</strong> {php(payrollTotalEarnings(row))} - {php(totalDeductions)} ={" "}
            <strong className="payroll-net-pay-pill">
              {php(netPay)}
            </strong>
          </p>
        </div>
      ) : (
        <div className="payroll-breakdown-formula">
          <p>
            <strong>Earnings:</strong> {php(row.basicPay)} basic +{" "}
            {php(row.hra ?? 0)} HRA +{" "}
            {php(row.incentivesAllowance)} incentives +{" "}
            {php(row.specialAllowance)} special allow. +{" "}
            {php(row.regularHolidayPay)} reg. hol. +{" "}
            {php(row.specialHolidayPay)} spec. hol. +{" "}
            {php(row.overtimePay)} overtime ={" "}
            <strong>{php(payrollTotalEarnings(row))}</strong> (Total Earnings).
            <br />
            <strong>Deductions:</strong> SSS {php(sss)} + Phic {php(phic)} + HDMF {php(hdmf)} + Advance {php(advance)} + Absent {php(row.absenceDeduction)} + Late/Halfday {php(row.lateDeduction + row.halfDayDeduction)} ={" "}
            <strong className={`payroll-deductions-total ${deductionClass(totalDeductions)}`}>{php(totalDeductions)}</strong> (Total Deductions).
            <br />
            <strong>Net Pay:</strong> {php(payrollTotalEarnings(row))} - {php(totalDeductions)} ={" "}
            <strong className="payroll-net-pay-pill">
              {php(netPay)}
            </strong>
          </p>
        </div>
      )}

      {parsedBreakdown?.deductions && parsedBreakdown.deductions.length > 0 ? (
        <div className="payroll-deductions-container">
          <div className="payroll-deductions-header">
            <h4 className="payroll-deductions-heading">
              Transparent Deductions Breakdown ({parsedBreakdown.deductions.length} item{parsedBreakdown.deductions.length === 1 ? "" : "s"}):
            </h4>
          </div>
          <div className="payroll-deductions-table-wrap">
            <table className="payroll-deductions-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Attendance Time</th>
                  <th>Cause / Details</th>
                  <th className="payroll-col-amount">Deduction</th>
                </tr>
              </thead>
              <tbody>
                {parsedBreakdown.deductions.map((item: AttendanceDeductionItem, idx: number) => {
                  const clampedPayrollTimeIn = item.payableTimeIn;
                  return (
                  <tr key={`${item.date}-${item.category}-${idx}`}>
                    <td className="payroll-deduction-date">
                      {formatDeductionDate(item.date)}
                    </td>
                    <td>
                      <span className={`deduction-badge badge-${item.category.toLowerCase()}`}>
                        {item.label}
                      </span>
                    </td>
                    <td className="payroll-deduction-time">
                      {item.timeIn || item.timeOut ? (
                        <>
                          {clampedPayrollTimeIn ? (
                            <span
                              className="clamped-time-in-chip clamped-time-in-static"
                              data-testid="clamped-payroll-time-in"
                              title={`Actual scan: ${item.timeIn} (payable time clamped)`}
                            >
                              {clampedPayrollTimeIn}
                            </span>
                          ) : (
                            item.timeIn ?? "—"
                          )}
                          {" – "}
                          {item.timeOut ?? "—"}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="payroll-deduction-details">{item.details}</td>
                    <td className="payroll-deduction-amount">
                      {php(item.amount)}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        (row.absenceDeduction > 0 || row.lateDeduction > 0 || row.halfDayDeduction > 0) ? (
          <p className="payroll-deductions-note">
            Summary of deductions: {row.absenceDeduction > 0 ? `${row.absentDays} day(s) absent (${php(row.absenceDeduction)}). ` : ""}
            {row.lateDeduction > 0 ? `${row.lateUnits} hr(s) late (${php(row.lateDeduction)}). ` : ""}
            {row.halfDayDeduction > 0 ? `${row.halfDayCount} half-day / undertime day(s) (${php(row.halfDayDeduction)}). ` : ""}
            <em>(Full date-by-date breakdown will be shown on next generation from attendance).</em>
          </p>
        ) : (
          <p className="payroll-deductions-none">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span>No attendance deductions incurred for this cutoff period.</span>
          </p>
        )
      )}

      <p className="payroll-cutoff-status">
        Status: {row.status}. Cutoff: {row.payrollCutoffLabel} ({formatCutoffRange(row.cutoffStart, row.cutoffEnd)}).
      </p>
    </>
  );
}

export function PayrollTable({
  records,
  allCount,
  scopeLabel,
  showingAll,
  onShowAllChange,
  onFinalized,
  loadStatus = "ready",
  onRetry,
  finalizeAll,
}: {
  /** The rows shown: the chosen cutoff's, or every cutoff's. Selection and batch actions apply to these. */
  records: PayrollCutoffRecord[];
  /** How many records every cutoff has together: the This cutoff | All cutoffs switch shows only when it matters. */
  allCount: number;
  /** The chosen cutoff as people read it ("Oct 16–31, 2026"), for the bar above the rows. */
  scopeLabel: string;
  showingAll: boolean;
  onShowAllChange: (showAll: boolean) => void;
  onFinalized: () => void;
  loadStatus?: LoadStatus;
  onRetry?: () => void;
  /** The chosen cutoff's Finalize all button, at the right of the bar while it has drafts. */
  finalizeAll?: React.ReactNode;
}) {
  // Problems stay under the table; finalized, deleted and updated results show as toasts.
  const [message, setMessage] = useState<Notice | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [editTarget, setEditTarget] = useState<PayrollCutoffRecord | null>(null);
  const [breakdownTarget, setBreakdownTarget] = useState<PayrollCutoffRecord | null>(null);
  const breakdownRef = useRef<HTMLElement>(null);
  useDialogKeys(breakdownRef, () => setBreakdownTarget(null), { open: Boolean(breakdownTarget) });
  const [deleteTarget, setDeleteTarget] = useState<PayrollCutoffRecord | null>(null);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [finalizeTarget, setFinalizeTarget] = useState<PayrollCutoffRecord | null>(null);
  const [batchFinalizeOpen, setBatchFinalizeOpen] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [deletingBatch, setDeletingBatch] = useState(false);
  const masterCheckboxRef = useRef<HTMLInputElement>(null);
  const payrollWrapRef = useRef<HTMLDivElement>(null);
  const [showAllPayroll, setShowAllPayroll] = useState(false);
  const payrollOverflowing = useVerticalOverflow(payrollWrapRef, loadStatus !== "loading" && records.length > 0);
  // Net Pay is pinned just left of the pinned actions when the amounts scroll sideways, so it needs their width.
  const actionsHeadRef = useRef<HTMLTableCellElement>(null);
  useLayoutEffect(() => {
    const head = actionsHeadRef.current;
    const wrap = payrollWrapRef.current;
    if (!head || !wrap) return;
    const place = () => wrap.style.setProperty("--payroll-actions-width", `${head.offsetWidth}px`);
    place();
    if (!("ResizeObserver" in window)) return;
    const observer = new ResizeObserver(place);
    observer.observe(head);
    return () => observer.disconnect();
  }, [records.length, loadStatus]);

  const allSelected = records.length > 0 && selectedIds.size === records.length;
  const someSelected = selectedIds.size > 0 && selectedIds.size < records.length;
  const selecting = selectedIds.size > 0;
  const listBarRef = useRef<HTMLDivElement>(null);
  const selectionBarRef = useRef<HTMLDivElement>(null);
  // The selection-bar button that started the last action, so the focus can come back after the bar hides.
  const barActionFrom = useRef<HTMLButtonElement | null>(null);
  // The switch shows only when it would change the rows; it moves into the empty message when the cutoff has none.
  const showScopeSwitch = showingAll || allCount > records.length;
  const scopeRef = useRef<HTMLDivElement>(null);
  const scopeThumb = useActiveThumb(scopeRef, `${showingAll}:${showScopeSwitch}:${records.length > 0}:${loadStatus}`);

  useEffect(() => {
    if (masterCheckboxRef.current) {
      masterCheckboxRef.current.indeterminate = someSelected;
    }
  }, [someSelected]);

  // The bar that isn't showing can't be clicked or tabbed into (React 18 has no inert prop).
  useLayoutEffect(() => {
    listBarRef.current?.toggleAttribute("inert", selecting);
    selectionBarRef.current?.toggleAttribute("inert", !selecting);
  }, [selecting, records.length, loadStatus]);

  // When an action from the selection bar ends with the bar hidden, the focus goes to the header tick box instead of
  // the page (only if it fell to the page or is still in the hidden bar, and never while a pop-up is open).
  useLayoutEffect(() => {
    if (!barActionFrom.current || selecting || finalizing || deletingBatch || document.querySelector("[aria-modal='true']")) return;
    barActionFrom.current = null;
    const focus = document.activeElement;
    if (focus === document.body || selectionBarRef.current?.contains(focus)) masterCheckboxRef.current?.focus({ preventScroll: true });
  }, [selecting, finalizing, deletingBatch]);

  // Clean up selectedIds when records change
  useEffect(() => {
    setSelectedIds((prev) => {
      const validIds = new Set(records.map((r) => r.payrollId));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (validIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [records]);

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(records.map((r) => r.payrollId)));
    }
  };

  const toggleSelectRow = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const finalize = async () => {
    if (!finalizeTarget) return;
    const target = finalizeTarget;
    setFinalizeTarget(null);
    setFinalizing(true);
    try {
      const response = await finalizePayrollCutoff(target.payrollId);
      if (response.success) {
        showResult({ tone: "success", text: "Payroll finalized." }, setMessage);
        onFinalized();
      } else {
        setMessage({ tone: "error", text: response.error?.message ?? "Unable to finalize payroll." });
      }
    } catch (error) {
      setMessage({ tone: "error", text: toErrorMessage(error, "Unable to finalize payroll.") });
    } finally {
      setFinalizing(false);
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    try {
      const response = await deletePayrollCutoff(target.payrollId);
      if (response.success) {
        showResult({ tone: "success", text: "Payroll deleted." }, setMessage);
        setSelectedIds((prev) => {
          const next = new Set(prev);
          next.delete(target.payrollId);
          return next;
        });
        onFinalized();
      } else {
        setMessage({ tone: "error", text: response.error?.message ?? "Unable to delete payroll." });
      }
    } catch (error) {
      setMessage({ tone: "error", text: toErrorMessage(error, "Unable to delete payroll.") });
    }
  };

  const selectedDraftsCount = records.filter(
    (r) => selectedIds.has(r.payrollId) && r.status === "DRAFT",
  ).length;

  const removeBatch = async () => {
    if (selectedIds.size === 0) return;
    setBatchDeleteOpen(false);
    setDeletingBatch(true);
    try {
      const ids = Array.from(selectedIds);
      const failed: string[] = [];
      for (const id of ids) {
        const deleted = await deletePayrollCutoff(id).then((response) => response.success, () => false);
        if (!deleted) failed.push(id);
      }
      // Records that could not be deleted stay selected, ready for another try.
      setSelectedIds(new Set(failed));
      showResult(batchOutcome(ids.length - failed.length, ids.length, "Deleted", "payroll record(s)"), setMessage);
      onFinalized();
    } catch (error) {
      setMessage({ tone: "error", text: toErrorMessage(error, "Unable to complete batch deletion.") });
    } finally {
      setDeletingBatch(false);
    }
  };

  const finalizeBatch = async () => {
    const draftIds = records
      .filter((r) => selectedIds.has(r.payrollId) && r.status === "DRAFT")
      .map((r) => r.payrollId);
    if (draftIds.length === 0) return;
    setBatchFinalizeOpen(false);
    setFinalizing(true);
    try {
      const failed = await finalizeEach(draftIds);
      setSelectedIds(new Set(failed));
      showResult(batchOutcome(draftIds.length - failed.length, draftIds.length, "Finalized", "payroll record(s)"), setMessage);
      onFinalized();
    } catch (error) {
      setMessage({ tone: "error", text: toErrorMessage(error, "Unable to complete batch finalization.") });
    } finally {
      setFinalizing(false);
    }
  };

  if (loadStatus === "loading")
    return (
      <div className="table-wrap">
        <table>
          <tbody>
            <LoadingRows columns={8} label="Loading payroll…" />
          </tbody>
        </table>
      </div>
    );
  const failedLine = loadStatus === "failed" && onRetry ? <LoadFailed what="payroll" onRetry={onRetry} /> : null;
  // This cutoff | All cutoffs: two options and a soft gold thumb that slides between them, like the admin tabs'.
  const scopeSwitch = showScopeSwitch && (
    <div className="payroll-scope-switch" role="group" aria-label="Cutoffs shown" ref={scopeRef}>
      {scopeThumb && (
        <span
          className="payroll-scope-thumb"
          aria-hidden="true"
          style={{ width: scopeThumb.width, height: scopeThumb.height, transform: `translate(${scopeThumb.x}px, ${scopeThumb.y}px)` }}
        />
      )}
      <button type="button" className={showingAll ? "" : "is-active"} aria-pressed={!showingAll} onClick={() => onShowAllChange(false)}>
        This cutoff
      </button>
      <button type="button" className={showingAll ? "is-active" : ""} aria-pressed={showingAll} onClick={() => onShowAllChange(true)}>
        All cutoffs
      </button>
    </div>
  );
  if (!records.length)
    return (
      failedLine ?? (
        <div className="empty-state payroll-empty">
          <span>
            {showingAll ? "No payroll yet." : "No payroll for this cutoff yet. Pick a cutoff above, then select Generate from attendance."}
          </span>
          {scopeSwitch}
        </div>
      )
    );

  // Hide columns that are blank or ₱0 on every row; they reappear once any row has a value,
  // and the Breakdown popup always shows them.
  const showDept = records.some((r) => r.department || r.designation);
  const showBank = records.some((r) => (r.bankName && r.bankName !== "CASH") || (r.accountNumber && r.accountNumber !== "0000"));
  const showTin = records.some((r) => r.tin);
  const visibleEarnings = PAYROLL_OPTIONAL_EARNINGS.filter((column) => records.some((r) => column.value(r) !== 0));
  const visibleDeductions = PAYROLL_OPTIONAL_DEDUCTIONS.filter((column) => records.some((r) => column.value(r) !== 0));

  return (
    <div className="payroll-table-with-bar">
      {failedLine}
      {/* While rows are ticked the selection bar takes the list bar's place. Both stay in one grid cell (the bar keeps
          the taller one's height, so the rows never move); the one not showing is hidden and inert, and they cross-fade. */}
      <div className="table-header-bar payroll-list-bar">
        <div className="payroll-bar-layer" ref={listBarRef} aria-hidden={selecting}>
          <div className="table-selection-count">
            <span>{`${showingAll ? "All cutoffs" : scopeLabel} · ${records.length} ${records.length === 1 ? "record" : "records"}`}</span>
            {(showAllPayroll || payrollOverflowing) && (
              <button
                className="text-button see-all-toggle"
                type="button"
                aria-expanded={showAllPayroll}
                onClick={() => setShowAllPayroll((current) => !current)}
              >
                {showAllPayroll ? "Show less" : "See all"}
              </button>
            )}
          </div>
          <div className="payroll-bar-actions">
            {scopeSwitch}
            {finalizeAll}
          </div>
        </div>
        <div
          className="payroll-bar-layer payroll-selection-bar"
          role="group"
          aria-label="Selected payroll records"
          ref={selectionBarRef}
          aria-hidden={!selecting}
        >
          <div className="table-selection-count">
            <span className="table-selection-badge">{selectedIds.size} selected</span>
            <button
              className="text-button"
              type="button"
              onClick={(event) => {
                barActionFrom.current = event.currentTarget;
                setSelectedIds(new Set());
              }}
            >
              Clear
            </button>
          </div>
          <div className="table-batch-actions">
            {selectedDraftsCount > 0 && (
              <button
                className="admin-button"
                type="button"
                disabled={finalizing}
                onClick={(event) => {
                  barActionFrom.current = event.currentTarget;
                  setBatchFinalizeOpen(true);
                }}
              >
                Finalize selected
              </button>
            )}
            <button
              className="admin-button danger-button"
              type="button"
              disabled={deletingBatch}
              onClick={(event) => {
                barActionFrom.current = event.currentTarget;
                setBatchDeleteOpen(true);
              }}
            >
              Delete selected
            </button>
          </div>
        </div>
      </div>

      <div className={`table-wrap ${showAllPayroll ? "is-expanded" : ""}`} ref={payrollWrapRef}>
        {/* "is-wide" when extra columns show (Period or non-zero optional amounts): on narrower laptops the "payroll-
            extra" columns, which Breakdown also lists, step aside so Net Pay stays in view beside the actions. */}
        <table className={showingAll || showDept || showBank || showTin || visibleEarnings.length + visibleDeductions.length > 0 ? "is-wide" : undefined}>
          <thead>
            <tr>
              <th className="payroll-select-col">
                <input
                  type="checkbox"
                  ref={masterCheckboxRef}
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  aria-label="Select all payroll records"
                />
              </th>
              <th>Employee</th>
              <th>Status</th>
              {showingAll && <th>Period</th>}
              {showDept && <th>Dept / Role</th>}
              {showBank && <th>Bank / A/C</th>}
              {showTin && <th>TIN #</th>}
              <th className="payroll-num payroll-extra">Standard</th>
              <th className="payroll-num">Paid Days</th>
              <th className="payroll-num">LWOP</th>
              <th className="payroll-num payroll-extra">Daily Rate</th>
              <th className="payroll-num payroll-extra">Basic Pay</th>
              {visibleEarnings.map((column) => <th key={column.label} className="payroll-num">{column.label}</th>)}
              <th className="payroll-num">Total Earnings</th>
              {visibleDeductions.map((column) => <th key={column.label} className="payroll-num">{column.label}</th>)}
              <th className="payroll-num payroll-extra">Absent</th>
              <th className="payroll-num payroll-extra">Late / Halfday</th>
              <th className="payroll-num">Total Deductions</th>
              <th className="payroll-num payroll-net-cell">Net Pay</th>
              <th ref={actionsHeadRef}>
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {/* Calm rows like Attendance corrections: the name with the ID under it, a dot and a word for the status,
                numbers right-aligned, and the actions as quiet text on one line (Delete last). */}
            {records.map((row) => {
              const draft = row.status === "DRAFT";
              const totalDeductions = payrollTotalDeductions(row);
              return (
                <tr key={row.payrollId} className={selectedIds.has(row.payrollId) ? "selected-row" : ""}>
                  <td className="payroll-select-cell">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(row.payrollId)}
                      onChange={() => toggleSelectRow(row.payrollId)}
                      aria-label={`Select payroll for ${row.employeeName}`}
                    />
                  </td>
                  <td className="payroll-employee-cell">
                    <strong>{row.employeeName}</strong>
                    <small>{row.employeeId}</small>
                  </td>
                  <td className="payroll-status-cell">
                    <span className={`payroll-status ${draft ? "is-draft" : "is-finalized"}`}>{draft ? "Draft" : "Finalized"}</span>
                  </td>
                  {showingAll && <td className="payroll-period-cell">{formatCutoffRange(row.cutoffStart, row.cutoffEnd)}</td>}
                  {showDept && <td>{payrollDeptRole(row)}</td>}
                  {showBank && <td>{payrollBankAccount(row)}</td>}
                  {showTin && <td>{row.tin || "—"}</td>}
                  <td className="payroll-num payroll-extra">{row.standardWorkingDays}</td>
                  <td className="payroll-num payroll-paid-cell">{row.actualWorkingDays}</td>
                  <td className="payroll-num">{row.absentDays}</td>
                  <td className="payroll-num payroll-extra">{php(row.dailyRate)}</td>
                  <td className="payroll-num payroll-extra">{php(row.basicPay)}</td>
                  {visibleEarnings.map((column) => <td key={column.label} className="payroll-num">{php(column.value(row))}</td>)}
                  <td className="payroll-num">
                    <strong>{php(payrollTotalEarnings(row))}</strong>
                  </td>
                  {visibleDeductions.map((column) => <td key={column.label} className="payroll-num">{php(column.value(row))}</td>)}
                  <td className="payroll-num payroll-extra">{php(row.absenceDeduction)}</td>
                  <td className="payroll-num payroll-extra">{php(row.lateDeduction + row.halfDayDeduction)}</td>
                  <td className="payroll-num">
                    <strong className={deductionClass(totalDeductions)}>{php(totalDeductions)}</strong>
                  </td>
                  <td className="payroll-num payroll-net-cell">
                    <strong>{php(row.netPay)}</strong>
                  </td>
                  <td className="payroll-actions-cell">
                    <span className="payroll-row-actions">
                      <button className="text-button" type="button" onClick={() => setBreakdownTarget(row)}>
                        Breakdown
                      </button>
                      {draft && (
                        <>
                          <button className="text-button" type="button" onClick={() => setEditTarget(row)}>
                            Edit
                          </button>
                          <button className="text-button" type="button" disabled={finalizing} onClick={() => setFinalizeTarget(row)}>
                            Finalize
                          </button>
                        </>
                      )}
                      <button className="text-button danger-button" type="button" onClick={() => setDeleteTarget(row)}>
                        Delete
                      </button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <NoticeLine notice={message} />
      {breakdownTarget && (
        <div className="confirm-backdrop" role="presentation">
          <section
            ref={breakdownRef}
            className="confirm-dialog payroll-breakdown-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="payroll-breakdown-heading"
          >
            <div className="payroll-breakdown-head">
              <h2 id="payroll-breakdown-heading">Calculation breakdown — {breakdownTarget.employeeName}</h2>
              <p className="payroll-breakdown-net">
                Net pay <strong>{php(breakdownTarget.netPay)}</strong>
              </p>
            </div>
            <PayrollBreakdownDetail row={breakdownTarget} />
            <div className="confirm-actions">
              <button className="submit-button" type="button" onClick={() => setBreakdownTarget(null)}>
                <Check size={16} /> Close
              </button>
            </div>
          </section>
        </div>
      )}
      <EditPayrollDialog
        record={editTarget}
        open={Boolean(editTarget)}
        onClose={() => setEditTarget(null)}
        onSaved={() => {
          showResult({ tone: "success", text: "Payroll updated." }, setMessage);
          onFinalized();
        }}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        busy={false}
        tone="danger"
        title={deleteTarget?.status === "FINALIZED" ? "Delete finalized payroll?" : "Delete saved payroll?"}
        message={
          deleteTarget
            ? deleteTarget.status === "FINALIZED"
              ? `This will delete the finalized payroll for ${deleteTarget.employeeName} (${deleteTarget.payrollCutoffLabel}). Use this if the employee left, was promoted, or needs their cutoff regenerated. Continue?`
              : `This will permanently delete the draft payroll for ${deleteTarget.employeeName} (${deleteTarget.payrollCutoffLabel}). Continue?`
            : ""
        }
        confirmLabel="Delete payroll"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void remove()}
      />
      <ConfirmDialog
        open={batchDeleteOpen}
        busy={deletingBatch}
        tone="danger"
        title="Delete selected payrolls?"
        message={`Are you sure you want to delete ${selectedIds.size} selected payroll record(s)? This will permanently remove them from the cutoff.`}
        confirmLabel="Delete payrolls"
        onCancel={() => setBatchDeleteOpen(false)}
        onConfirm={() => void removeBatch()}
      />
      <ConfirmDialog
        open={Boolean(finalizeTarget)}
        busy={finalizing}
        title="Finalize payroll?"
        message={
          finalizeTarget
            ? `This will finalize the payroll for ${finalizeTarget.employeeName} (${finalizeTarget.payrollCutoffLabel}). Values will be locked from further edits.`
            : ""
        }
        confirmLabel="Finalize payroll"
        onCancel={() => setFinalizeTarget(null)}
        onConfirm={() => void finalize()}
      />
      <ConfirmDialog
        open={batchFinalizeOpen}
        busy={finalizing}
        title="Finalize selected payrolls?"
        message={`This will finalize ${selectedDraftsCount} selected draft payroll record(s). Values will be locked from further edits.`}
        confirmLabel="Finalize payrolls"
        onCancel={() => setBatchFinalizeOpen(false)}
        onConfirm={() => void finalizeBatch()}
      />
    </div>
  );
}

export function php(value: number): string {
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
    .format(Number.isFinite(value) ? value : 0)
    .replace("₱", "PHP ");
}

export function formatDeductionDate(dateStr: string | null | undefined): string {
  return dateStr ? formatDate(dateStr) : "—";
}

/** Total Deductions amounts in coral, so they stand out; nothing deducted stays muted. */
export function deductionClass(amount: number): string {
  return amount > 0 ? "money-deduction" : "money-zero";
}

/**
 * Total deductions for display: the backend-authoritative value wins when
 * present; legacy Sheets cutoff rows omit `totalDeductions`, so derive it
 * from its components instead of showing ₱0 beside a reduced net pay.
 */
export function payrollTotalDeductions(record: PayrollCutoffRecord): number {
  const deductions = record.totalDeductions ?? (
    record.lateDeduction +
    record.halfDayDeduction +
    record.absenceDeduction +
    (record.sss ?? 0) +
    (record.phic ?? 0) +
    (record.hdmf ?? 0) +
    (record.salaryAdvance ?? 0)
  );
  return deductions + negativeAdjustment(record);
}

/** A negative manual adjustment, as a positive amount: shown with the deductions, never as lower earnings. */
function negativeAdjustment(record: PayrollCutoffRecord): number {
  return Math.max(0, -record.manualAdjustment);
}

/** Total earnings for display: stored gross with a negative manual adjustment added back (it is a deduction). */
export function payrollTotalEarnings(record: PayrollCutoffRecord): number {
  return record.grossCompensation + negativeAdjustment(record);
}

function parseCalculationBreakdown(
  breakdownStr: string | null | undefined,
): CutoffCalculationBreakdownData | null {
  if (!breakdownStr || !breakdownStr.trim()) return null;
  try {
    // SAFETY: Input is a verified JSON string produced by payroll calculation stored in SQLite
    const parsed = JSON.parse(breakdownStr) as CutoffCalculationBreakdownData;
    return parsed && parsed.deductions ? parsed : null;
  } catch {
    return null;
  }
}
