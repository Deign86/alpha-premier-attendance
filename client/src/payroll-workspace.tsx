import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, LoaderCircle } from "lucide-react";
import type { PayrollCutoffRecord, PayrollPdfRecord } from "@rfid-attendance/shared";
import { countWorkdays } from "@rfid-attendance/shared";
import { deletePayrollCutoff, finalizePayrollCutoff, savePayrollCutoff, generatePayrollCutoff, generateInternPayslipImages, generatePayrollPdf, loadPayrollPdfs, openGeneratedDirectory, openGeneratedFile, revealGeneratedFile } from "./api";
import { isOnline } from "./network";
import type { FileActionResult } from "./api";
import { formatCutoffRange, formatDateTime, formatMonth } from "./format";
import { useDialogKeys } from "./use-dialog-keys";
import { NoticeLine } from "./notice";
import type { Notice } from "./notice";
import { showToast } from "./toasts";
import type { LoadStatus } from "./list-load";
import { localDate, toErrorMessage } from "./app-shared";
import { ConfirmDialog } from "./confirm-dialog";
import { recordCount } from "./database-panel";
import { PayrollTable, deductionClass, payrollTotalDeductions, payrollTotalEarnings, php } from "./payroll-tables";

type PayrollForm = {
  employeeId: string;
  payrollProfileId: string;
  cutoffStart: string;
  cutoffEnd: string;
  standardWorkingDays: string;
  actualWorkingDays: string;
  specialHolidayDays: string;
  regularHolidayDays: string;
  incentivesAllowance: string;
  specialAllowance: string;
  lateUnits: string;
  lateDeductionRate: string;
  lateDeduction: string;
  halfDayCount: string;
  absentDays: string;
  overtimeHours: string;
  overtimeRate: string;
  manualAdjustment: string;
  adjustmentReason: string;
  approvedWorkingDayOverage: boolean;
};

const emptyPayrollForm: PayrollForm = {
  employeeId: "",
  payrollProfileId: "BEA_STANDARD",
  cutoffStart: "",
  cutoffEnd: "",
  standardWorkingDays: "11",
  actualWorkingDays: "11",
  specialHolidayDays: "0",
  regularHolidayDays: "0",
  incentivesAllowance: "0",
  specialAllowance: "0",
  lateUnits: "0",
  lateDeductionRate: "0",
  lateDeduction: "0",
  halfDayCount: "0",
  absentDays: "0",
  overtimeHours: "0",
  overtimeRate: "0",
  manualAdjustment: "0",
  adjustmentReason: "",
  approvedWorkingDayOverage: false,
};

const monthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

interface SemiMonthlyCutoffRange {
  cutoffStart: string;
  cutoffEnd: string;
  payrollCutoffLabel: string;
}

function computeSemiMonthlyCutoff(
  month: string,
  half: "first" | "second",
): SemiMonthlyCutoffRange {
  const [yearText, monthText] = month.split("-");
  const year = Number(yearText);
  const monthNumber = Number(monthText);
  const pad = (value: number) => String(value).padStart(2, "0");
  const monthName = monthNames[(monthNumber - 1 + 12) % 12];
  if (half === "first") {
    return {
      cutoffStart: `${year}-${pad(monthNumber)}-01`,
      cutoffEnd: `${year}-${pad(monthNumber)}-15`,
      payrollCutoffLabel: `${monthName} 1-15, ${year}`,
    };
  }
  const lastDay = new Date(year, monthNumber, 0).getDate();
  return {
    cutoffStart: `${year}-${pad(monthNumber)}-16`,
    cutoffEnd: `${year}-${pad(monthNumber)}-${pad(lastDay)}`,
    payrollCutoffLabel: `${monthName} 16-${lastDay}, ${year}`,
  };
}

/** The form fields one half-month preset fills: its dates and its working days. */
function cutoffFields(month: string, half: "first" | "second"): Pick<PayrollForm, "cutoffStart" | "cutoffEnd" | "standardWorkingDays"> {
  const { cutoffStart, cutoffEnd } = computeSemiMonthlyCutoff(month, half);
  return { cutoffStart, cutoffEnd, standardWorkingDays: String(countWorkdays(cutoffStart, cutoffEnd) || 11) };
}

/** A half-month cutoff by its month ("2026-08") and half. */
interface HalfMonthCutoff {
  month: string;
  half: "first" | "second";
}

/**
 * The most recently ended half-month cutoff on office (Manila) time, which is the one payroll is usually run for:
 * on the 1st–15th the 16th–last day of last month, from the 16th the 1st–15th of this month.
 */
function lastEndedCutoff(): HalfMonthCutoff {
  const today = localDate();
  const [year, month, day] = today.split("-").map(Number);
  if (day >= 16) return { month: today.slice(0, 7), half: "first" };
  return { month: month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`, half: "second" };
}

/**
 * Whether a payroll PDF still matches its cutoff's approved pay: every record finalized, the same headcount, and made
 * after the last finalize (Date.parse, since finalizedAt is UTC and generatedAt Manila time). A PDF made from drafts,
 * or before a regenerate or a delete, is out of date.
 */
function pdfMatchesPayroll(pdf: PayrollPdfRecord, records: readonly PayrollCutoffRecord[]): boolean {
  const cutoff = records.filter((record) => record.cutoffStart === pdf.cutoffStart && record.cutoffEnd === pdf.cutoffEnd);
  if (cutoff.length === 0 || cutoff.length !== pdf.employeeCount || cutoff.some((record) => record.status !== "FINALIZED")) return false;
  const made = Date.parse(pdf.generatedAt);
  return cutoff.every((record) => !record.finalizedAt || made >= Date.parse(record.finalizedAt));
}

/** Finalizes the payroll records one by one; returns the ids that could not be finalized. */
export async function finalizeEach(ids: readonly string[]): Promise<string[]> {
  const failed: string[] = [];
  for (const id of ids) {
    const finalized = await finalizePayrollCutoff(id).then((response) => response.success, () => false);
    if (!finalized) failed.push(id);
  }
  return failed;
}

export function PayrollWorkspace({
  records,
  onSaved,
  loadStatus = "ready",
  onRetry,
}: {
  records: PayrollCutoffRecord[];
  onSaved: () => void;
  /** Where the payroll records load stands (Admin loads them). */
  loadStatus?: LoadStatus;
  onRetry?: () => void;
}) {
  // Opens on the cutoff that ended last, so Generate is ready without picking dates.
  const [form, setForm] = useState<PayrollForm>(() => {
    const { month, half } = lastEndedCutoff();
    return { ...emptyPayrollForm, ...cutoffFields(month, half) };
  });
  // Problems stay on the page; generated, deleted and saved results show as toasts.
  const [message, setMessage] = useState<Notice | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cutoffMonth, setCutoffMonth] = useState(() => form.cutoffStart.slice(0, 7));

  // Keep the browser print header (if any) on-brand instead of the generic kiosk title.
  useEffect(() => {
    const previous = document.title;
    document.title = "Alpha Premier Attendance — Payroll Worksheet";
    return () => {
      document.title = previous;
    };
  }, []);

  const update = (field: keyof PayrollForm, value: string | boolean) =>
    setForm((current) => ({ ...current, [field]: value }));

  const applyCutoffHalf = (half: "first" | "second", month = cutoffMonth) =>
    setForm((current) => ({ ...current, ...cutoffFields(month, half) }));
  // The half-month of the cutoff month the dates match, shown pressed; none once the dates are typed by hand.
  const preset = (["first", "second"] as const)
    .map((half) => ({ half, ...computeSemiMonthlyCutoff(cutoffMonth, half) }))
    .find((range) => range.cutoffStart === form.cutoffStart && range.cutoffEnd === form.cutoffEnd);
  const activeHalf = preset?.half;
  const changeCutoffMonth = (month: string) => {
    setCutoffMonth(month);
    // A chosen half moves with the month, so the dates and the pressed preset keep matching.
    if (month && activeHalf) applyCutoffHalf(activeHalf, month);
  };

  const handleCutoffDateChange = (field: "cutoffStart" | "cutoffEnd", value: string) => {
    setForm((current) => {
      const next = { ...current, [field]: value };
      const start = field === "cutoffStart" ? value : current.cutoffStart;
      const end = field === "cutoffEnd" ? value : current.cutoffEnd;
      if (start && end && start <= end) {
        const days = countWorkdays(start, end);
        next.standardWorkingDays = String(days || 11);
      }
      return next;
    });
  };

  const [clearCutoffOpen, setClearCutoffOpen] = useState(false);
  const [clearingCutoff, setClearingCutoff] = useState(false);
  const [finalizeAllOpen, setFinalizeAllOpen] = useState(false);
  const [finalizingAll, setFinalizingAll] = useState(false);
  // The table shows the chosen cutoff's records unless every cutoff is asked for.
  const [showAllCutoffs, setShowAllCutoffs] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // The picked cutoff as people read it ("Aug 1–15, 2026"); the label saved with the payroll is unchanged.
  const cutoffRange = formatCutoffRange(form.cutoffStart, form.cutoffEnd);

  const existingCutoffRecords = useMemo(() => {
    if (!form.cutoffStart || !form.cutoffEnd) return [];
    return records.filter(
      (record) =>
        record.cutoffStart === form.cutoffStart &&
        record.cutoffEnd === form.cutoffEnd,
    );
  }, [records, form.cutoffStart, form.cutoffEnd]);

  // Why Generate is off, in one line under the fields: the dates or standard days (the button is off, so the browser's
  // own check never shows), or the payroll list not loaded (its confirmation must know whether payroll exists).
  const standardDays = Number(form.standardWorkingDays);
  const datesReason =
    !form.cutoffStart || !form.cutoffEnd
      ? "Pick a cutoff start and end date."
      : form.cutoffStart > form.cutoffEnd
        ? "End date must be on or after the start date."
        : !form.standardWorkingDays.trim() || !(standardDays >= 0 && standardDays <= 31) || !Number.isInteger(standardDays * 2)
          ? "Standard days must be 0 to 31 (whole or half days)."
          : null;
  const listReason = loadStatus === "loading" ? "Loading payroll…" : loadStatus === "failed" ? "Payroll didn't load. Select Retry below." : null;
  const generateReason = datesReason ?? listReason;
  const recordCount = existingCutoffRecords.length;
  const draftCount = existingCutoffRecords.filter((record) => record.status !== "FINALIZED").length;
  const finalizedCount = recordCount - draftCount;
  // Why the exports are off, in one line under them: they wait for the payroll list, then for this cutoff's payroll
  // with no drafts left (a cutoff with a date problem has no payroll, so its exports wait too).
  const exportReason =
    listReason ?? (recordCount === 0 ? "Generate payroll first." : draftCount > 0 ? "Finalize all drafts first." : null);
  // The label saved with the payroll: the preset's ("August 1-15, 2026") when the dates are a half-month of the
  // cutoff month, otherwise "<start> to <end>". PDFs and payslips keep the label their payroll was saved with.
  const cutoffLabel = preset?.payrollCutoffLabel ?? `${form.cutoffStart} to ${form.cutoffEnd}`;
  const exportLabel = existingCutoffRecords[0]?.payrollCutoffLabel || cutoffLabel;

  // Generate from attendance, or Enter in a field, asks first; while a reason keeps the button off, Enter does nothing.
  const save = (event: React.FormEvent) => {
    event.preventDefault();
    if (generateReason) return;
    setMessage(null);
    setConfirmOpen(true);
  };

  const confirmGenerate = async () => {
    if (saving) return;
    setSaving(true);
    try {
      // Finalized rows are approved pay: regenerating rebuilds drafts only.
      for (const r of existingCutoffRecords) {
        if (r.status !== "FINALIZED") await deletePayrollCutoff(r.payrollId);
      }
      const stdDays = Number(form.standardWorkingDays);
      const customization = !Number.isNaN(stdDays) && stdDays > 0 ? { standardWorkingDays: stdDays } : undefined;
      const response = await generatePayrollCutoff(form.cutoffStart, form.cutoffEnd, cutoffLabel, customization);
      if (response.success) {
        const skipped = response.warnings ?? [];
        showToast(
          existingCutoffRecords.length > 0
            ? `Payroll regenerated for ${cutoffRange}; finalized records were kept.`
            : `Payroll generated for ${cutoffRange}.`,
        );
        // Records left out need fixing, so that part stays on the page.
        setMessage(
          skipped.length > 0
            ? { tone: "error", text: `${skipped.length} attendance record(s) could not be priced and were left out: ${skipped.slice(0, 3).join("; ")}${skipped.length > 3 ? "…" : ""}. Fix them in Attendance, then regenerate.` }
            : null,
        );
        onSaved();
        setConfirmOpen(false);
      } else {
        setMessage({ tone: "error", text: response.error?.message ?? "Unable to save payroll." });
      }
    } catch (error) {
      setMessage({ tone: "error", text: toErrorMessage(error, "Unable to save payroll.") });
    } finally {
      setSaving(false);
    }
  };

  const clearCutoffRecords = async () => {
    if (clearingCutoff || existingCutoffRecords.length === 0) return;
    setClearingCutoff(true);
    try {
      let count = 0;
      let failCount = 0;
      for (const r of existingCutoffRecords) {
        const res = await deletePayrollCutoff(r.payrollId);
        if (res.success) {
          count++;
        } else {
          failCount++;
        }
      }
      if (failCount > 0) {
        setMessage({ tone: "error", text: `Deleted ${count} payroll record(s) for ${cutoffRange}. ${failCount} record(s) could not be deleted.` });
      } else {
        showResult({ tone: "success", text: `Deleted ${count} payroll record(s) for ${cutoffRange}.` }, setMessage);
      }
      onSaved();
    } catch (error) {
      setMessage({ tone: "error", text: toErrorMessage(error, "Unable to delete payroll records.") });
    } finally {
      setClearingCutoff(false);
      setClearCutoffOpen(false);
    }
  };

  // Finalize all: every draft of the chosen cutoff, the same way as Finalize selected.
  const finalizeAll = async () => {
    const draftIds = existingCutoffRecords.filter((record) => record.status !== "FINALIZED").map((record) => record.payrollId);
    if (finalizingAll || draftIds.length === 0) return;
    setFinalizingAll(true);
    try {
      const failed = await finalizeEach(draftIds);
      showResult(batchOutcome(draftIds.length - failed.length, draftIds.length, "Finalized", "payroll record(s)"), setMessage);
      onSaved();
    } finally {
      setFinalizingAll(false);
      setFinalizeAllOpen(false);
    }
  };

  const [pdfMessage, setPdfMessage] = useState<Notice | null>(null);
  const [generating, setGenerating] = useState(false);
  const [payrollPdfs, setPayrollPdfs] = useState<PayrollPdfRecord[]>([]);
  const [payslipMessage, setPayslipMessage] = useState<Notice | null>(null);
  const [payslipDirectory, setPayslipDirectory] = useState<string | null>(null);
  const [payslipOpenMessage, setPayslipOpenMessage] = useState<Notice | null>(null);
  const [generatingPayslips, setGeneratingPayslips] = useState(false);

  useEffect(() => {
    void loadPayrollPdfs().then((response) => {
      if (response.success) setPayrollPdfs(response.payrollPdfs);
    });
  }, []);

  // Notes and the payslip folder belong to the cutoff they were made for, so another cutoff starts without them.
  useEffect(() => {
    setMessage(null);
    setPdfMessage(null);
    setPayslipMessage(null);
    setPayslipOpenMessage(null);
    setPayslipDirectory(null);
  }, [form.cutoffStart, form.cutoffEnd]);

  // The chosen cutoff's newest PDF, and whether it still matches the approved pay (it may predate a regenerate, a
  // delete or the last finalize). Only a current one is offered under the export buttons, while they are on.
  const latestPdf = useMemo(
    () =>
      payrollPdfs
        .filter((pdf) => pdf.cutoffStart === form.cutoffStart && pdf.cutoffEnd === form.cutoffEnd)
        .reduce<PayrollPdfRecord | null>((newest, pdf) => (!newest || Date.parse(pdf.generatedAt) > Date.parse(newest.generatedAt) ? pdf : newest), null),
    [payrollPdfs, form.cutoffStart, form.cutoffEnd],
  );
  const currentPdf = !exportReason && latestPdf && pdfMatchesPayroll(latestPdf, existingCutoffRecords) ? latestPdf : null;

  // The button that had the focus can leave with the last draft (Finalize all) or the last record (Delete all records,
  // a row's Delete): the focus then goes on to the payroll PDF when it is on, otherwise to Generate from attendance,
  // instead of the page; but only when it fell to the page and no pop-up is open.
  const generateButtonRef = useRef<HTMLButtonElement>(null);
  const pdfButtonRef = useRef<HTMLButtonElement>(null);
  const shownCounts = useRef({ drafts: draftCount, records: recordCount });
  useLayoutEffect(() => {
    const before = shownCounts.current;
    shownCounts.current = { drafts: draftCount, records: recordCount };
    const lastGone = (before.drafts > 0 && draftCount === 0) || (before.records > 0 && recordCount === 0);
    if (!lastGone || document.activeElement !== document.body || document.querySelector("[aria-modal='true']")) return;
    const pdf = pdfButtonRef.current;
    (pdf && !pdf.disabled ? pdf : generateButtonRef.current)?.focus();
  }, [draftCount, recordCount]);

  const generatePdf = async () => {
    if (generating || exportReason) return;
    setGenerating(true);
    setPdfMessage(null);
    try {
      const response = await generatePayrollPdf({
        cutoffStart: form.cutoffStart,
        cutoffEnd: form.cutoffEnd,
        payrollCutoffLabel: exportLabel,
        workerType: "intern",
      });
      if (response.success) {
        setPayrollPdfs((current) => [
          response.pdf,
          ...current.filter(
            (item) => item.payrollPdfId !== response.pdf.payrollPdfId,
          ),
        ]);
        showToast(`Payroll PDF made for ${cutoffRange}.`);
        // The new PDF opens straight away; the line under the export buttons keeps Open PDF and Show in folder.
        const opened = await openGeneratedFile(response.pdf.filePath);
        if (!opened.ok) setPdfMessage({ tone: "error", text: opened.message });
      } else setPdfMessage({ tone: "error", text: response.error.message });
    } catch (error) {
      setPdfMessage({ tone: "error", text: error instanceof Error ? error.message : "Unable to generate the payroll PDF." });
    } finally {
      setGenerating(false);
    }
  };

  const generatePayslips = async () => {
    if (generatingPayslips || exportReason) return;
    setPayslipDirectory(null);
    setPayslipOpenMessage(null);
    setGeneratingPayslips(true);
    setPayslipMessage(null);
    try {
      const response = await generateInternPayslipImages({
        cutoffStart: form.cutoffStart,
        cutoffEnd: form.cutoffEnd,
        payrollCutoffLabel: exportLabel,
      });
      if (response.success) {
        setPayslipDirectory(response.directoryPath);
        showToast(`Saved ${response.fileCount} payslip image(s) for ${cutoffRange}.`);
      } else setPayslipMessage({ tone: "error", text: response.error.message });
    } catch (error) {
      setPayslipMessage({ tone: "error", text: error instanceof Error ? error.message : "Unable to generate the payslips." });
    } finally {
      setGeneratingPayslips(false);
    }
  };

  const openPayslipFolder = async (directoryPath: string) => {
    const result = await openGeneratedDirectory(directoryPath);
    setPayslipOpenMessage(result.ok ? null : { tone: "error", text: result.message });
  };

  return (
    <section className="payroll-workspace">
      {/* One row: make the cutoff's payroll (the page's one gold button ends the fields) and export it. */}
      <div className="payroll-toolbar">
        <form className="payroll-generate-panel" onSubmit={save} aria-labelledby="payroll-generate-heading">
          <h2 className="visually-hidden" id="payroll-generate-heading">Generate cutoff payroll</h2>
          <div className="payroll-generate-controls">
            <div className="cutoff-period">
              <label>
                Cutoff month
                <input
                  type="month"
                  value={cutoffMonth}
                  onChange={(event) => changeCutoffMonth(event.target.value)}
                />
              </label>
              <div className="cutoff-fill-buttons">
                <button
                  className="admin-button"
                  type="button"
                  aria-pressed={activeHalf === "first"}
                  disabled={!cutoffMonth}
                  onClick={() => applyCutoffHalf("first")}
                >
                  1st&ndash;15th
                </button>
                <button
                  className="admin-button"
                  type="button"
                  aria-pressed={activeHalf === "second"}
                  disabled={!cutoffMonth}
                  onClick={() => applyCutoffHalf("second")}
                >
                  16th&ndash;last day
                </button>
              </div>
            </div>
            {/* A date problem marks all three fields and points them at the line that says what is wrong. */}
            <label>
              Cutoff start
              <input
                required
                type="date"
                value={form.cutoffStart}
                aria-invalid={Boolean(datesReason)}
                aria-describedby={datesReason ? "payroll-generate-reason" : undefined}
                onChange={(event) => handleCutoffDateChange("cutoffStart", event.target.value)}
              />
            </label>
            <label>
              Cutoff end
              <input
                required
                type="date"
                value={form.cutoffEnd}
                aria-invalid={Boolean(datesReason)}
                aria-describedby={datesReason ? "payroll-generate-reason" : undefined}
                onChange={(event) => handleCutoffDateChange("cutoffEnd", event.target.value)}
              />
            </label>
            <label className="payroll-standard-days">
              Standard days
              <input
                required
                type="number"
                min="0"
                max="31"
                step="0.5"
                value={form.standardWorkingDays}
                aria-invalid={Boolean(datesReason)}
                aria-describedby={datesReason ? "payroll-generate-reason" : undefined}
                onChange={(event) => update("standardWorkingDays", event.target.value)}
              />
            </label>
            {/* Also how to generate again: only drafts are replaced, and the pop-up says so. */}
            <button
              ref={generateButtonRef}
              className="submit-button payroll-generate-submit"
              type="submit"
              disabled={saving || Boolean(generateReason)}
              aria-describedby={generateReason ? "payroll-generate-reason" : undefined}
            >
              {saving ? "Generating…" : "Generate from attendance"}
            </button>
          </div>
          {/* A date problem in coral; "Loading payroll…" and the like stay muted. Read out when it appears or changes. */}
          {generateReason && (
            <p className={datesReason ? "payroll-reason is-problem" : "payroll-reason"} id="payroll-generate-reason" role="status">
              {generateReason}
            </p>
          )}
          {recordCount > 0 && (
            <p className="payroll-existing">
              <span>
                This cutoff has {recordCount} {recordCount === 1 ? "record" : "records"}. Generating again replaces drafts; finalized pay is kept.
              </span>
              <button
                className="text-button danger-button"
                type="button"
                disabled={clearingCutoff || saving}
                onClick={() => setClearCutoffOpen(true)}
              >
                Delete all records
              </button>
            </p>
          )}
        </form>

        <section className="payroll-export-panel" aria-labelledby="payroll-export-heading">
          {/* A small label like the fields' labels; the buttons keep their full names for screen readers. */}
          <h2 id="payroll-export-heading">Export payroll</h2>
          <div className="payroll-actions">
            <button
              ref={pdfButtonRef}
              className="admin-button"
              type="button"
              disabled={generating || Boolean(exportReason)}
              aria-describedby={exportReason ? "payroll-export-reason" : undefined}
              onClick={() => void generatePdf()}
            >
              {generating ? "Saving…" : <><span className="visually-hidden">Generate Intern </span>Payroll PDF</>}
            </button>
            <button
              className="admin-button"
              type="button"
              disabled={generatingPayslips || Boolean(exportReason)}
              aria-describedby={exportReason ? "payroll-export-reason" : undefined}
              onClick={() => void generatePayslips()}
            >
              {generatingPayslips ? "Saving…" : <><span className="visually-hidden">Generate Intern </span>Payslips</>}
            </button>
          </div>
          {/* One quiet line: why the exports are off, or where this cutoff's PDF stands; its links under it. */}
          {exportReason ? (
            <p className="payroll-reason" id="payroll-export-reason" role="status">
              {exportReason}
            </p>
          ) : (
            latestPdf && (
              <p className="payroll-export-status">
                {currentPdf ? `PDF made ${formatDateTime(currentPdf.generatedAt)}` : "The last PDF is out of date."}
              </p>
            )
          )}
          {(currentPdf || payslipDirectory) && (
            <div className="payroll-export-links">
              {currentPdf && <PayrollPdfButtons filePath={currentPdf.filePath} onResult={setPdfMessage} />}
              {payslipDirectory && (
                <button className="text-button" type="button" onClick={() => void openPayslipFolder(payslipDirectory)}>
                  Open payslip folder
                </button>
              )}
            </div>
          )}
        </section>
      </div>

      <NoticeLine notice={message} />
      <NoticeLine notice={pdfMessage} />
      <NoticeLine notice={payslipMessage} />
      <NoticeLine notice={payslipOpenMessage} />

      <section className="payroll-table">
        <PayrollTable
          records={showAllCutoffs ? records : existingCutoffRecords}
          allCount={records.length}
          scopeLabel={cutoffRange}
          showingAll={showAllCutoffs}
          onShowAllChange={setShowAllCutoffs}
          onFinalized={onSaved}
          loadStatus={loadStatus}
          onRetry={onRetry}
          finalizeAll={
            // The chosen cutoff's drafts only: under All cutoffs it names that cutoff, so it never reads as every cutoff.
            draftCount > 0 && (
              <button className="admin-button payroll-finalize-all" type="button" disabled={finalizingAll} onClick={() => setFinalizeAllOpen(true)}>
                {showAllCutoffs ? `Finalize all for ${cutoffRange} (${draftCount})` : `Finalize all (${draftCount})`}
              </button>
            )
          }
        />
      </section>

      {/* Every PDF made, by month, folded away: the chosen cutoff's latest is under the export buttons. */}
      <section className="payroll-pdf-section" aria-labelledby="payroll-pdf-history-heading">
        <h2 id="payroll-pdf-history-heading">
          <button type="button" aria-expanded={historyOpen} onClick={() => setHistoryOpen((open) => !open)}>
            Past payroll PDFs <span className="db-backup-count">{payrollPdfs.length}</span>
          </button>
        </h2>
        {historyOpen && <PayrollPdfList pdfs={payrollPdfs} records={records} />}
      </section>

      {/* Only drafts are replaced, so the pop-up mentions them only when there are drafts. */}
      <ConfirmDialog
        open={confirmOpen}
        busy={saving}
        title={draftCount > 0 ? "Regenerate cutoff payroll?" : recordCount > 0 ? "Generate again?" : "Generate payroll drafts?"}
        message={
          draftCount > 0
            ? `Payroll already exists for ${cutoffRange} (${recordCount} record(s)). Generating new payroll will replace the draft records with fresh calculations from latest attendance; finalized records are kept. Continue?`
            : recordCount > 0
              ? `All ${recordCount} record(s) for ${cutoffRange} are finalized and stay as they are. Generating again only adds payroll, from completed attendance, for people not in this cutoff yet. Continue?`
              : `This will generate payroll records for ${cutoffRange} from completed attendance. Days without a time-out are not paid; late time-outs are paid up to 17:00. Continue?`
        }
        confirmLabel={draftCount > 0 ? "Regenerate payroll" : recordCount > 0 ? "Generate again" : "Generate payroll"}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void confirmGenerate()}
      />
      <ConfirmDialog
        open={finalizeAllOpen}
        busy={finalizingAll}
        title="Finalize all drafts?"
        message={`This will finalize all ${draftCount} draft payroll record(s) for ${cutoffRange}. Values will be locked from further edits.`}
        confirmLabel="Finalize payrolls"
        onCancel={() => setFinalizeAllOpen(false)}
        onConfirm={() => void finalizeAll()}
      />
      <ConfirmDialog
        open={clearCutoffOpen}
        busy={clearingCutoff}
        tone="danger"
        title="Delete cutoff records?"
        message={
          finalizedCount > 0
            ? `This will permanently delete all ${recordCount} payroll record(s) for ${cutoffRange}, including ${finalizedCount} finalized (approved) record(s). This cannot be undone.`
            : `This will permanently delete all ${recordCount} payroll record(s) for ${cutoffRange}. Continue?`
        }
        confirmLabel="Delete cutoff records"
        requireText={finalizedCount > 0 ? "DELETE" : undefined}
        onCancel={() => setClearCutoffOpen(false)}
        onConfirm={() => void clearCutoffRecords()}
      />
    </section>
  );
}

/** Shows a result: a routine success as a toast (clearing any older problem left on the page), anything else inline. */
export function showResult(notice: Notice, setMessage: (notice: Notice | null) => void): void {
  if (notice.tone === "success") {
    setMessage(null);
    showToast(notice.text);
  } else setMessage(notice);
}

/** A batch action's result: success when every item worked, otherwise a problem saying how many did not. */
export function batchOutcome(done: number, total: number, verb: string, noun: string): Notice {
  return done === total
    ? { tone: "success", text: `${verb} ${done} ${noun}.` }
    : { tone: "error", text: `${verb} ${done} of ${total} ${noun}. ${total - done} could not be ${verb.toLowerCase()}.` };
}

export function EditPayrollDialog({
  record,
  open,
  onClose,
  onSaved,
}: {
  record: PayrollCutoffRecord | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isIntern = record?.employeeType === "INTERN";
  const [hra, setHra] = useState("0");
  const [incentivesAllowance, setIncentivesAllowance] = useState("0");
  const [specialAllowance, setSpecialAllowance] = useState("0");
  const [overtimePay, setOvertimePay] = useState("0");
  const [manualAdjustment, setManualAdjustment] = useState("0");
  const [adjustmentReason, setAdjustmentReason] = useState("");

  const [sss, setSss] = useState("0");
  const [phic, setPhic] = useState("0");
  const [hdmf, setHdmf] = useState("0");
  const [salaryAdvance, setSalaryAdvance] = useState("0");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  useDialogKeys(dialogRef, onClose, { busy: saving, open: open && Boolean(record) });

  useEffect(() => {
    if (record) {
      setHra(String(record.hra ?? 0));
      setIncentivesAllowance(String(record.incentivesAllowance ?? 0));
      setSpecialAllowance(String(record.specialAllowance ?? 0));
      setOvertimePay(String(record.overtimePay ?? 0));
      setManualAdjustment(String(record.manualAdjustment ?? 0));
      setAdjustmentReason(record.adjustmentReason ?? "");

      setSss(String(record.sss ?? 0));
      setPhic(String(record.phic ?? 0));
      setHdmf(String(record.hdmf ?? 0));
      setSalaryAdvance(String(record.salaryAdvance ?? 0));
      setError("");
    }
  }, [record]);

  if (!open || !record) return null;

  const nStdDays = Math.max(0, record.standardWorkingDays ?? 11);
  const actualDays = record.actualWorkingDays;
  const absentDays = record.absentDays;
  const basicPay = record.basicPay;
  const absenceDeduction = record.absenceDeduction;

  const nHra = isIntern ? 0 : Number(hra) || 0;
  const nInc = isIntern ? 0 : Number(incentivesAllowance) || 0;
  const nSpecAllow = isIntern ? 0 : Number(specialAllowance) || 0;
  const nOt = isIntern ? 0 : Number(overtimePay) || 0;
  const nAdj = Number(manualAdjustment) || 0;

  const nSss = isIntern ? 0 : Number(sss) || 0;
  const nPhic = isIntern ? 0 : Number(phic) || 0;
  const nHdmf = isIntern ? 0 : Number(hdmf) || 0;
  const nAdvance = isIntern ? 0 : Number(salaryAdvance) || 0;

  const halfDayDeduction = record.halfDayDeduction;
  const totalAllowance = record.totalAllowance;
  const totalEarnings = payrollTotalEarnings(record);
  const totalDeductions = payrollTotalDeductions(record);

  const netPay = record.netPay;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (nAdj !== 0 && !adjustmentReason.trim()) {
      setError("A reason is required when setting a manual adjustment.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const payload = {
        payrollId: record.payrollId,
        employeeId: record.employeeId,
        employeeName: record.employeeName,
        payrollProfileId: record.payrollProfileId,
        payrollCutoffLabel: record.payrollCutoffLabel,
        cutoffStart: record.cutoffStart,
        cutoffEnd: record.cutoffEnd,
        dailyRate: record.dailyRate,
        standardWorkingDays: nStdDays,
        actualWorkingDays: record.actualWorkingDays,
        basicPay: record.basicPay,
        hra: nHra,
        incentivesAllowance: nInc,
        specialAllowance: nSpecAllow,
        regularHolidayPay: isIntern ? 0 : record.regularHolidayPay,
        specialHolidayPay: isIntern ? 0 : record.specialHolidayPay,
        overtimePay: nOt,
        sss: nSss,
        phic: nPhic,
        hdmf: nHdmf,
        salaryAdvance: nAdvance,
        absentDays: record.absentDays,
        absenceDeduction: record.absenceDeduction,
        halfDayCount: record.halfDayCount,
        halfDayDeduction,
        // Backend defaults a missing fraction to 0.0, which zeroes the
        // EMPLOYEE half-day recompute (daily * count * fraction).
        halfDayFraction: 0.5,
        lateUnits: record.lateUnits,
        lateDeduction: record.lateDeduction,
        manualAdjustment: nAdj,
        adjustmentReason: adjustmentReason.trim() || undefined,
        approvedWorkingDayOverage: nStdDays < record.actualWorkingDays ? true : record.approvedWorkingDayOverage,
      };
      const response = await savePayrollCutoff(payload, record.payrollId);
      setSaving(false);
      if (response.success) {
        onSaved();
        onClose();
      } else {
        setError("Failed to save payroll changes.");
      }
    } catch (err) {
      setSaving(false);
      setError(err instanceof Error ? err.message : "Error saving payroll changes.");
    }
  };

  return (
    <div className="confirm-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="edit-payroll-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-payroll-heading"
      >
        <h2 id="edit-payroll-heading">
          Edit Payroll — {record.employeeName}
          {isIntern ? " (Intern)" : ""}
        </h2>
        <p className="modal-subtitle">
          {record.payrollCutoffLabel} ({formatCutoffRange(record.cutoffStart, record.cutoffEnd)}) • {record.employeeId}
        </p>

        <div className="edit-payroll-attendance-box">
          <div className="attendance-stat">
            <span className="attendance-label">Attendance Basic</span>
            <span className="attendance-value">{php(basicPay)} ({actualDays} worked / {nStdDays} std days)</span>
          </div>
          {!isIntern && (record.regularHolidayPay > 0 || record.specialHolidayPay > 0) && (
            <div className="attendance-stat">
              <span className="attendance-label">Holiday Pay</span>
              <span className="attendance-value">{php(record.regularHolidayPay + record.specialHolidayPay)}</span>
            </div>
          )}
          <div className="attendance-stat">
            <span className="attendance-label">Late Deduction</span>
            <span className="attendance-value" style={{ color: record.lateDeduction > 0 ? "var(--danger)" : undefined }}>
              {php(record.lateDeduction)} ({record.lateUnits} hrs)
            </span>
          </div>
          <div className="attendance-stat">
            <span className="attendance-label">Absent / Halfday</span>
            <span className="attendance-value" style={{ color: (absenceDeduction + record.halfDayDeduction) > 0 ? "var(--danger)" : undefined }}>
              {php(absenceDeduction + record.halfDayDeduction)} ({absentDays} absent)
            </span>
          </div>
        </div>

        {isIntern ? (
          <form onSubmit={handleSubmit}>
            <div className="edit-payroll-notice">
              Intern stipend (PHP 80.00/day) and late deductions (PHP 10.00/hr) are automatically calculated from RFID attendance scans. Standard working days ({nStdDays} days) are set globally for the cutoff. You can apply manual adjustments below.
            </div>

            <div className="edit-payroll-section" style={{ marginTop: "12px" }}>
              <h3>Manual Adjustment</h3>
              <label>
                Manual Adjustment (PHP)
                <input
                  type="number"
                  step="0.01"
                  value={manualAdjustment}
                  onChange={(e) => setManualAdjustment(e.target.value)}
                />
              </label>
              {nAdj !== 0 && (
                <label>
                  Adjustment Reason
                  <input
                    type="text"
                    required
                    value={adjustmentReason}
                    onChange={(e) => setAdjustmentReason(e.target.value)}
                    placeholder="Reason for adjustment"
                  />
                </label>
              )}
            </div>

            <div className="edit-payroll-summary">
              <div className="summary-item">
                <span className="summary-label">Total Earnings</span>
                <span className="summary-value">{php(totalEarnings)}</span>
              </div>
              <div className="summary-item">
                <span className="summary-label">Total Deductions</span>
                <span className={`summary-value ${deductionClass(totalDeductions)}`}>{php(totalDeductions)}</span>
              </div>
              <div className="summary-item">
                <span className="summary-label">Net Pay</span>
                <span className="net-pay-box">{php(netPay)}</span>
              </div>
            </div>

            {error && <p className="dashboard-alert" style={{ marginTop: "12px" }}>{error}</p>}

            <div className="confirm-actions">
              <button
                className="text-button"
                type="button"
                disabled={saving}
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                className="submit-button"
                type="submit"
                disabled={saving || !isOnline()}
              >
                {saving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} {!isOnline() ? "Offline" : "Save Changes"}
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="edit-payroll-grid">
              <div className="edit-payroll-section">
                <h3>Allowances & Adjustments (PHP)</h3>
                <label>
                  HRA
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={hra}
                    onChange={(e) => setHra(e.target.value)}
                  />
                </label>
                <label>
                  Incentives Allowance
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={incentivesAllowance}
                    onChange={(e) => setIncentivesAllowance(e.target.value)}
                  />
                </label>
                <label>
                  Special Allowance
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={specialAllowance}
                    onChange={(e) => setSpecialAllowance(e.target.value)}
                  />
                </label>
                <label>
                  Overtime Pay
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={overtimePay}
                    onChange={(e) => setOvertimePay(e.target.value)}
                  />
                </label>
                <label>
                  Manual Adjustment
                  <input
                    type="number"
                    step="0.01"
                    value={manualAdjustment}
                    onChange={(e) => setManualAdjustment(e.target.value)}
                  />
                </label>
                {nAdj !== 0 && (
                  <label>
                    Adjustment Reason
                    <input
                      type="text"
                      required
                      value={adjustmentReason}
                      onChange={(e) => setAdjustmentReason(e.target.value)}
                      placeholder="Reason for adjustment"
                    />
                  </label>
                )}
              </div>

              <div className="edit-payroll-section">
                <h3>Statutory & Other Deductions (PHP)</h3>
                <label>
                  SSS Employee Share
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={sss}
                    onChange={(e) => setSss(e.target.value)}
                  />
                </label>
                <label>
                  Phic (PhilHealth) Employee Share
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={phic}
                    onChange={(e) => setPhic(e.target.value)}
                  />
                </label>
                <label>
                  HDMF (Pag-IBIG) Employee Share
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={hdmf}
                    onChange={(e) => setHdmf(e.target.value)}
                  />
                </label>
                <label>
                  Salary Advance
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={salaryAdvance}
                    onChange={(e) => setSalaryAdvance(e.target.value)}
                  />
                </label>
              </div>
            </div>

            <div className="edit-payroll-summary">
              <div className="summary-item">
                <span className="summary-label">Total Allowance</span>
                <span className="summary-value">{php(totalAllowance)}</span>
              </div>
              <div className="summary-item">
                <span className="summary-label">Total Earnings</span>
                <span className="summary-value">{php(totalEarnings)}</span>
              </div>
              <div className="summary-item">
                <span className="summary-label">Total Deductions</span>
                <span className={`summary-value ${deductionClass(totalDeductions)}`}>{php(totalDeductions)}</span>
              </div>
              <div className="summary-item">
                <span className="summary-label">Net Pay</span>
                <span className="net-pay-box">{php(netPay)}</span>
              </div>
            </div>

            {error && <p className="dashboard-alert" style={{ marginTop: "12px" }}>{error}</p>}

            <div className="confirm-actions">
              <button
                className="text-button"
                type="button"
                disabled={saving}
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                className="submit-button"
                type="submit"
                disabled={saving || !isOnline()}
              >
                {saving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} {!isOnline() ? "Offline" : "Save Changes"}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}

/**
 * History of generated payroll PDFs produced by the Tauri backend. Each row
 * offers Open PDF (system default viewer) and Show in Folder actions backed by
 * the existing opener commands; nothing is ever printed from the browser.
 */
function PayrollPdfList({ pdfs, records }: { pdfs: PayrollPdfRecord[]; records: readonly PayrollCutoffRecord[] }) {
  const [actionMessage, setActionMessage] = useState<Notice | null>(null);
  // Months opened or closed by hand; the latest month starts open and older months start closed.
  const [toggledMonths, setToggledMonths] = useState<ReadonlySet<string>>(new Set());
  const sorted = [...pdfs].sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt));
  if (!sorted.length)
    return (
      <div className="empty-state">No PDFs yet. Finalize the cutoff, then select Payroll PDF.</div>
    );
  // "Latest" marks each cutoff's newest copy, and only while it still matches that cutoff's approved pay.
  const latestIds = new Set<string>();
  const seenCutoffs = new Set<string>();
  for (const pdf of sorted) {
    const cutoff = `${pdf.cutoffStart}|${pdf.cutoffEnd}`;
    if (!seenCutoffs.has(cutoff) && pdfMatchesPayroll(pdf, records)) latestIds.add(pdf.payrollPdfId);
    seenCutoffs.add(cutoff);
  }
  // One fold per cutoff month, newest month first; PDFs inside stay newest-generated first.
  const months: { key: string; label: string; pdfs: PayrollPdfRecord[] }[] = [];
  for (const pdf of sorted) {
    const key = /^\d{4}-\d{2}/.test(pdf.cutoffStart) ? pdf.cutoffStart.slice(0, 7) : "";
    const month = months.find((group) => group.key === key);
    if (month) month.pdfs.push(pdf);
    else
      months.push({
        key,
        label: key ? formatMonth(`${key}-01`) : "Other",
        pdfs: [pdf],
      });
  }
  months.sort((a, b) => b.key.localeCompare(a.key));
  const toggleMonth = (key: string) =>
    setToggledMonths((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Period</th>
              <th>Generated</th>
              <th>Interns</th>
              <th>Total earnings</th>
              <th>
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          {months.map((month, index) => {
            const open = (index === 0) !== toggledMonths.has(month.key);
            return (
              <tbody key={month.key} className="payroll-pdf-month">
                <tr>
                  <th colSpan={5} scope="rowgroup">
                    <button type="button" aria-expanded={open} onClick={() => toggleMonth(month.key)}>
                      {month.label} <span className="db-backup-count">{month.pdfs.length}</span>
                    </button>
                  </th>
                </tr>
                {open && month.pdfs.map((pdf) => (
                  <tr key={pdf.payrollPdfId}>
                    <td>
                      <span className="payroll-pdf-period">{pdf.payrollCutoffLabel}</span>
                      {latestIds.has(pdf.payrollPdfId) && <span className="payroll-pdf-latest">Latest</span>}
                    </td>
                    <td>{formatDateTime(pdf.generatedAt)}</td>
                    <td>{pdf.employeeCount}</td>
                    <td>
                      <strong>{php(pdf.totalAmount)}</strong>
                    </td>
                    <td className="payroll-pdf-actions">
                      <PayrollPdfButtons filePath={pdf.filePath} onResult={setActionMessage} />
                    </td>
                  </tr>
                ))}
              </tbody>
            );
          })}
        </table>
      </div>
      <NoticeLine notice={actionMessage} />
    </>
  );
}

/** Open PDF and Show in folder for one generated payroll PDF; a file that can't be opened reports why. */
function PayrollPdfButtons({ filePath, onResult }: { filePath: string; onResult: (notice: Notice | null) => void }) {
  const run = async (action: (filePath: string) => Promise<FileActionResult>) => {
    const result = await action(filePath);
    onResult(result.ok ? null : { tone: "error", text: result.message });
  };
  return (
    <>
      <button className="text-button" type="button" onClick={() => void run(openGeneratedFile)}>
        Open PDF
      </button>
      <button className="text-button" type="button" onClick={() => void run(revealGeneratedFile)}>
        Show in folder
      </button>
    </>
  );
}
