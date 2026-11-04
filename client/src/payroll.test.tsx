import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  InternPayslipSaveResponse,
  PayrollCutoffRecord,
  PayrollPdfRecord,
} from "@rfid-attendance/shared";

import * as api from "./api";
import { PayrollWorkspace } from "./App";
import { Toasts } from "./toasts";

function record(overrides: Partial<PayrollCutoffRecord> = {}): PayrollCutoffRecord {
  return {
    payrollId: "P-001", employeeId: "EMP-001", employeeName: "Ada Lovelace", employeeType: "INTERN",
    payrollProfileId: "BEA_STANDARD", payrollCutoffLabel: "August 1-15, 2026", cutoffStart: "2026-08-01", cutoffEnd: "2026-08-15",
    payrollFrequency: "SEMI_MONTHLY", dailyRate: 500, standardWorkingDays: 11, actualWorkingDays: 11, basicPay: 5500,
    specialHolidayDays: 0, specialHolidayMultiplier: 0.3, specialHolidayPay: 0, regularHolidayDays: 0, regularHolidayMultiplier: 1, regularHolidayPay: 0,
    incentivesAllowance: 0, specialAllowance: 0, totalCompensation: 5500, totalAllowance: 0, lateUnits: 0, lateDeduction: 0,
    halfDayCount: 0, halfDayDeduction: 0, absentDays: 0, absenceDeduction: 0, overtimeHours: 0, overtimeRate: 0, overtimePay: 0,
    manualAdjustment: 0, adjustmentReason: null, grossCompensation: 5500, netPay: 5500,
    calculationBreakdown: "PHP 5,500.00 basic = PHP 5,500.00", approvedWorkingDayOverage: false, status: "FINALIZED", finalizedAt: null,
    ...overrides,
  };
}

/** A saved intern record in the same August 1-15, 2026 cutoff. */
function internRecord(overrides: Partial<PayrollCutoffRecord> = {}): PayrollCutoffRecord {
  return {
    payrollId: "P-INT-001", employeeId: "INT-001", employeeName: "Maria Santos", employeeType: "INTERN",
    payrollProfileId: "INTERN_STANDARD", dailyRate: 80, basicPay: 800, totalCompensation: 800,
    standardWorkingDays: 10, actualWorkingDays: 10, absentDays: 0, absenceDeduction: 0,
    lateUnits: 0, lateDeduction: 0, halfDayCount: 0, halfDayDeduction: 0,
    specialHolidayDays: 0, specialHolidayMultiplier: 0, specialHolidayPay: 0,
    regularHolidayDays: 0, regularHolidayMultiplier: 0, regularHolidayPay: 0,
    incentivesAllowance: 0, specialAllowance: 0, totalAllowance: 0,
    overtimeHours: 0, overtimeRate: 0, overtimePay: 0,
    manualAdjustment: 0, adjustmentReason: null, grossCompensation: 800, netPay: 800,
    payrollCutoffLabel: "August 1-15, 2026", cutoffStart: "2026-08-01", cutoffEnd: "2026-08-15",
    payrollFrequency: "SEMI_MONTHLY", calculationBreakdown: "PHP 800.00 basic",
    approvedWorkingDayOverage: false, status: "FINALIZED", finalizedAt: null,
    ...overrides,
  };
}

/** A generated payroll PDF as returned by the Tauri backend. */
function pdfRecord(overrides: Partial<PayrollPdfRecord> = {}): PayrollPdfRecord {
  return {
    payrollPdfId: "payroll-2026-08-14_10-30-00_employee",
    fileName: "payroll-2026-08-14_10-30-00_employee.pdf",
    filePath: "C:\\data\\exports\\payroll-2026-08-14_10-30-00_employee.pdf",
    directoryPath: "C:\\data\\exports",
    cutoffStart: "2026-08-01",
    cutoffEnd: "2026-08-15",
    payrollCutoffLabel: "August 1-15, 2026",
    workerType: "intern",
    generatedAt: "2026-08-14T10:30:00+08:00",
    employeeCount: 1,
    totalAmount: 5500,
    sizeBytes: 1024,
    ...overrides,
  };
}

/** The workspace with the toast corner Admin renders, so routine results ("Payroll PDF generated") can be read. */
function renderWorkspace(records: PayrollCutoffRecord[]) {
  return render(
    <>
      <PayrollWorkspace
        records={records}
        onSaved={vi.fn()}
      />
      <Toasts />
    </>,
  );
}

/** The left panel: the cutoff fields and the page's gold Generate button. */
function generatePanel(): HTMLElement {
  return screen.getByRole("form", { name: "Generate cutoff payroll" });
}

/** The right panel: the two exports and the line under them. */
function exportPanel(): HTMLElement {
  return screen.getByRole("region", { name: "Export payroll" });
}

/** The line under the export buttons: why they are off, or where the cutoff's PDF stands ("" when there is none). */
function exportLine(): string {
  return exportPanel().querySelector("p")?.textContent ?? "";
}

/** The two export buttons: the payroll PDF, then the payslips. */
function exportButtons(): HTMLElement[] {
  return within(exportPanel()).getAllByRole("button").slice(0, 2);
}

/** Opens the folded "Past payroll PDFs" history and returns its region. */
function openHistory(): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: /^Past payroll PDFs/ }));
  return screen.getByRole("region", { name: /^Past payroll PDFs/ });
}

describe("PayrollWorkspace", () => {
  let generatePayrollCutoffSpy: MockInstance;
  let generatePayrollPdfSpy: MockInstance;
  let generateInternPayslipImagesSpy: MockInstance;
  let openGeneratedDirectorySpy: MockInstance;
  let openGeneratedFileSpy: MockInstance;
  let loadPayrollPdfsSpy: MockInstance;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // Mon, Aug 17, 2026 in Manila: the cutoff that ended last (and opens pre-filled) is Aug 1–15, the fixtures' cutoff.
    vi.setSystemTime(new Date("2026-08-17T10:00:00+08:00"));
    window.print = vi.fn();
    generatePayrollCutoffSpy = vi.spyOn(api, "generatePayrollCutoff");
    generatePayrollPdfSpy = vi.spyOn(api, "generatePayrollPdf");
    generateInternPayslipImagesSpy = vi.spyOn(api, "generateInternPayslipImages");
    openGeneratedDirectorySpy = vi.spyOn(api, "openGeneratedDirectory");
    // A made PDF opens straight away; in tests that open succeeds unless a test says otherwise.
    openGeneratedFileSpy = vi.spyOn(api, "openGeneratedFile").mockResolvedValue({ ok: true, message: "" });
    loadPayrollPdfsSpy = vi.spyOn(api, "loadPayrollPdfs").mockResolvedValue({ success: true, payrollPdfs: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("generates payroll from a selected cutoff and shows backend errors", async () => {
    generatePayrollCutoffSpy.mockRejectedValueOnce("Unable to generate payroll.");
    const user = userEvent.setup();
    render(<PayrollWorkspace records={[]} onSaved={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /1st.*15th/i }));
    await user.click(screen.getByRole("button", { name: "Generate from attendance" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Generate payroll" }));
    expect(await screen.findByText("Unable to generate payroll.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate from attendance" })).toBeEnabled();
    expect(generatePayrollCutoffSpy).toHaveBeenCalledWith("2026-08-01", "2026-08-15", "August 1-15, 2026", { standardWorkingDays: 10 });
  });

  it("opens on the cutoff that ended last in Manila, with its month and half-month preset", () => {
    const opensOn = (now: string, start: string, end: string, month: string, preset: RegExp) => {
      vi.setSystemTime(new Date(now));
      const { unmount } = renderWorkspace([]);
      expect(screen.getByLabelText("Cutoff start")).toHaveValue(start);
      expect(screen.getByLabelText("Cutoff end")).toHaveValue(end);
      expect(screen.getByLabelText("Cutoff month")).toHaveValue(month);
      for (const button of [screen.getByRole("button", { name: /1st.*15th/i }), screen.getByRole("button", { name: /16th.*last day/i })]) {
        expect(button).toHaveAttribute("aria-pressed", String(preset.test(button.textContent ?? "")));
      }
      // Ready to generate: no reason line under the button.
      expect(screen.getByRole("button", { name: "Generate from attendance" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Generate from attendance" })).not.toHaveAccessibleDescription();
      unmount();
    };
    // From the 16th: this month's 1st–15th.
    opensOn("2026-08-17T10:00:00+08:00", "2026-08-01", "2026-08-15", "2026-08", /1st/);
    // On the 1st–15th: last month's 16th–last day (the 15th itself hasn't ended), across the new year too.
    opensOn("2026-08-15T18:00:00+08:00", "2026-07-16", "2026-07-31", "2026-07", /16th/);
    opensOn("2027-01-10T10:00:00+08:00", "2026-12-16", "2026-12-31", "2026-12", /16th/);
    opensOn("2026-03-01T09:00:00+08:00", "2026-02-16", "2026-02-28", "2026-02", /16th/);
    // Manila time decides: 1:30 AM on Aug 16 in Manila is still Aug 15 in UTC.
    opensOn("2026-08-15T17:30:00Z", "2026-08-01", "2026-08-15", "2026-08", /1st/);
  });

  it("says under a disabled Generate button what is missing", () => {
    renderWorkspace([]);
    const generate = screen.getByRole("button", { name: "Generate from attendance" });

    fireEvent.change(screen.getByLabelText("Cutoff end"), { target: { value: "" } });
    expect(generate).toBeDisabled();
    expect(generate).toHaveAccessibleDescription("Pick a cutoff start and end date.");
    // Typed dates match no preset, so neither shows pressed.
    expect(screen.getByRole("button", { name: /1st.*15th/i })).toHaveAttribute("aria-pressed", "false");

    fireEvent.change(screen.getByLabelText("Cutoff end"), { target: { value: "2026-07-31" } });
    expect(generate).toBeDisabled();
    expect(generate).toHaveAccessibleDescription("End date must be on or after the start date.");
    // The three fields are marked and say what is wrong, in the coral line that is read out.
    for (const field of ["Cutoff start", "Cutoff end", "Standard days"]) {
      expect(screen.getByLabelText(field)).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByLabelText(field)).toHaveAccessibleDescription("End date must be on or after the start date.");
    }
    const reason = screen.getAllByRole("status").find((line) => line.id === "payroll-generate-reason");
    expect(reason).toHaveTextContent("End date must be on or after the start date.");
    expect(reason).toHaveClass("is-problem");

    // A one-day cutoff is allowed.
    fireEvent.change(screen.getByLabelText("Cutoff end"), { target: { value: "2026-08-01" } });
    expect(generate).toBeEnabled();
    expect(generate).not.toHaveAccessibleDescription();
    expect(screen.queryByText("End date must be on or after the start date.")).not.toBeInTheDocument();
    for (const field of ["Cutoff start", "Cutoff end", "Standard days"]) {
      expect(screen.getByLabelText(field)).toHaveAttribute("aria-invalid", "false");
      expect(screen.getByLabelText(field)).not.toHaveAccessibleDescription();
    }
  });

  it("moves the chosen half-month with the cutoff month", () => {
    renderWorkspace([]);
    fireEvent.change(screen.getByLabelText("Cutoff month"), { target: { value: "2026-09" } });
    expect(screen.getByLabelText("Cutoff start")).toHaveValue("2026-09-01");
    expect(screen.getByLabelText("Cutoff end")).toHaveValue("2026-09-15");
    expect(screen.getByRole("button", { name: /1st.*15th/i })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows the two panels with their old labels, every cutoff field in view", () => {
    renderWorkspace([]);
    const generate = generatePanel();
    expect(within(generate).getByRole("heading", { name: "Generate cutoff payroll" })).toBeInTheDocument();
    expect(within(generate).getByRole("button", { name: "Generate from attendance" })).toHaveClass("submit-button");
    for (const field of ["Cutoff month", "Cutoff start", "Cutoff end", "Standard days"]) {
      expect(within(generate).getByLabelText(field)).toBeVisible();
    }
    expect(within(generate).getByRole("button", { name: /1st.*15th/i })).toBeInTheDocument();
    expect(within(generate).getByRole("button", { name: /16th.*last day/i })).toBeInTheDocument();
    const exports = exportPanel();
    expect(within(exports).getByRole("heading", { name: "Export payroll" })).toBeInTheDocument();
    expect(within(exports).getAllByRole("button").map((button) => button.textContent)).toEqual(["Generate Intern Payroll PDF", "Generate Intern Payslips"]);
    // No steps, no Next line and no dates fold any more.
    expect(screen.queryByRole("list", { name: "Payroll steps" })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Next:/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change dates" })).not.toBeInTheDocument();
  });

  it("keeps the cutoff header to one row: the fields, then Generate; the exports show short words but keep their full names", () => {
    renderWorkspace([]);
    const generate = within(generatePanel()).getByRole("button", { name: "Generate from attendance" });
    // Generate ends the fields' row, so it also comes after them in the tab order.
    expect(generate.parentElement).toHaveClass("payroll-generate-controls");
    expect(screen.getByLabelText("Standard days").compareDocumentPosition(generate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // No heading row: the panel's heading is for screen readers only.
    expect(screen.getByRole("heading", { name: "Generate cutoff payroll" })).toHaveClass("visually-hidden");
    expect(exportButtons().map((button) => button.querySelector(".visually-hidden")?.textContent)).toEqual(["Generate Intern ", "Generate Intern "]);
  });

  it("says under the exports why they are off, or where the cutoff's PDF stands", async () => {
    const draft = (id: string) => internRecord({ payrollId: id, status: "DRAFT" });
    const final = (id: string) => internRecord({ payrollId: id, status: "FINALIZED" });
    const julyDraft = internRecord({ payrollId: "JUL", status: "DRAFT", cutoffStart: "2026-07-16", cutoffEnd: "2026-07-31" });
    const made = "PDF made Aug 14, 2026, 10:30 AM";
    const changed = "The last PDF is out of date.";
    // [records, PDFs, the line under the exports, whether the exports are on]
    const cases: [PayrollCutoffRecord[], PayrollPdfRecord[], string, boolean][] = [
      // No payroll yet.
      [[], [], "Generate payroll first.", false],
      // Drafts left, even with some finalized and a PDF made from them.
      [[draft("A"), draft("B")], [], "Finalize all drafts first.", false],
      [[final("A"), draft("B")], [pdfRecord()], "Finalize all drafts first.", false],
      // All finalized, no PDF yet: both on, no line. A draft of another cutoff doesn't count.
      [[final("A"), final("B"), julyDraft], [], "", true],
      // A PDF of this finalized pay.
      [[final("A"), final("B")], [pdfRecord({ employeeCount: 2 })], made, true],
      // A PDF made before the last finalize (finalizedAt is UTC, generatedAt Manila: 10:30 Manila is 02:30 UTC), or for
      // another headcount, is out of date.
      [[final("A"), internRecord({ payrollId: "B", finalizedAt: "2026-08-14T03:00:00Z" })], [pdfRecord({ employeeCount: 2 })], changed, true],
      [[final("A"), final("B")], [pdfRecord({ employeeCount: 1 })], changed, true],
      // Finalized before the PDF was made (02:00 UTC is 10:00 Manila): still current.
      [[internRecord({ payrollId: "A", finalizedAt: "2026-08-14T02:00:00Z" })], [pdfRecord()], made, true],
    ];
    for (const [records, pdfs, line, on] of cases) {
      loadPayrollPdfsSpy.mockResolvedValue({ success: true, payrollPdfs: pdfs });
      const { unmount } = renderWorkspace(records);
      // The PDF list has loaded once the history heading counts it.
      await screen.findByRole("button", { name: `Past payroll PDFs ${pdfs.length}` });
      await waitFor(() => expect(exportLine()).toBe(line));
      for (const button of exportButtons()) {
        if (on) {
          expect(button).toBeEnabled();
          expect(button).not.toHaveAccessibleDescription();
        } else {
          expect(button).toBeDisabled();
          expect(button).toHaveAccessibleDescription(line);
        }
      }
      unmount();
    }
  });

  it("says why Generate and the exports wait while payroll loads or after it failed", () => {
    const { rerender } = render(<PayrollWorkspace records={[]} onSaved={vi.fn()} loadStatus="loading" onRetry={vi.fn()} />);
    const buttons = () => [screen.getByRole("button", { name: "Generate from attendance" }), ...exportButtons()];
    for (const button of buttons()) {
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription("Loading payroll…");
    }
    // Muted, not coral: nothing is wrong with the dates, so the fields aren't marked either. Both lines are read out.
    expect(document.getElementById("payroll-generate-reason")).not.toHaveClass("is-problem");
    expect(document.getElementById("payroll-generate-reason")).toHaveAttribute("role", "status");
    expect(document.getElementById("payroll-export-reason")).toHaveAttribute("role", "status");
    expect(screen.getByLabelText("Cutoff start")).toHaveAttribute("aria-invalid", "false");
    rerender(<PayrollWorkspace records={[]} onSaved={vi.fn()} loadStatus="failed" onRetry={vi.fn()} />);
    for (const button of buttons()) expect(button).toHaveAccessibleDescription("Payroll didn't load. Select Retry below.");
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
    // Loaded (empty): Generate is ready and the exports wait for payroll.
    rerender(<PayrollWorkspace records={[]} onSaved={vi.fn()} loadStatus="ready" onRetry={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Generate from attendance" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Generate from attendance" })).not.toHaveAccessibleDescription();
    expect(exportLine()).toBe("Generate payroll first.");
  });

  it("leaves the focus alone when drafts or records go while it is on a field or a pop-up is open", async () => {
    const user = userEvent.setup();
    const drafts = [internRecord({ payrollId: "A", status: "DRAFT" }), internRecord({ payrollId: "B", status: "DRAFT" })];
    const { rerender } = render(<PayrollWorkspace records={drafts} onSaved={vi.fn()} />);
    // On a field: a reload that brings the drafts back finalized, then an empty cutoff, never takes the focus away.
    const days = screen.getByLabelText("Standard days");
    days.focus();
    rerender(<PayrollWorkspace records={drafts} onSaved={vi.fn()} loadStatus="loading" />);
    rerender(<PayrollWorkspace records={drafts.map((record) => ({ ...record, status: "FINALIZED" }))} onSaved={vi.fn()} />);
    expect(days).toHaveFocus();
    rerender(<PayrollWorkspace records={[]} onSaved={vi.fn()} />);
    expect(days).toHaveFocus();

    // A pop-up open with the focus fallen to the page: the records go, and nothing behind the pop-up takes the focus.
    rerender(<PayrollWorkspace records={drafts} onSaved={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Delete all records" }));
    expect(screen.getByRole("dialog", { name: "Delete cutoff records?" })).toBeInTheDocument();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    rerender(<PayrollWorkspace records={[]} onSaved={vi.fn()} />);
    expect(document.body).toHaveFocus();
    expect(screen.getByRole("button", { name: "Generate from attendance" })).not.toHaveFocus();
  });

  it("keeps one gold button, Generate from attendance, in every state; the rest are outline or quiet text", async () => {
    const gold = () => Array.from(document.querySelectorAll(".payroll-workspace .submit-button")).map((button) => button.textContent);
    const quiet = () => Array.from(document.querySelectorAll(".payroll-toolbar .text-button")).map((button) => button.textContent);

    // No payroll yet.
    let view = renderWorkspace([]);
    expect(gold()).toEqual(["Generate from attendance"]);
    expect(quiet()).toEqual([]);
    view.unmount();

    // Drafts: the same button generates again (no "Generate again"); Delete all records stays quiet text.
    view = renderWorkspace([internRecord({ payrollId: "A", status: "DRAFT" }), internRecord({ payrollId: "B", status: "DRAFT" }), internRecord({ payrollId: "C" })]);
    expect(gold()).toEqual(["Generate from attendance"]);
    expect(quiet()).toEqual(["Delete all records"]);
    expect(screen.queryByRole("button", { name: "Generate again" })).not.toBeInTheDocument();
    view.unmount();

    // All finalized, no PDF: both exports on, as outline buttons.
    view = renderWorkspace([internRecord({ payrollId: "A" }), internRecord({ payrollId: "B" })]);
    expect(gold()).toEqual(["Generate from attendance"]);
    for (const button of exportButtons()) {
      expect(button).toBeEnabled();
      expect(button).toHaveClass("admin-button");
    }
    expect(quiet()).toEqual(["Delete all records"]);
    view.unmount();

    // A current PDF: Open PDF and Show in folder as quiet text under its line.
    loadPayrollPdfsSpy.mockResolvedValue({ success: true, payrollPdfs: [pdfRecord()] });
    renderWorkspace([internRecord({ payrollId: "A" })]);
    await waitFor(() => expect(exportLine()).toBe("PDF made Aug 14, 2026, 10:30 AM"));
    expect(gold()).toEqual(["Generate from attendance"]);
    expect(quiet()).toEqual(["Delete all records", "Open PDF", "Show in folder"]);
    await userEvent.setup().click(screen.getByRole("button", { name: "Open PDF" }));
    expect(openGeneratedFileSpy).toHaveBeenCalledWith(pdfRecord().filePath);
  });

  it("asks for a new PDF when the latest one is older than the finalized pay or for another headcount", async () => {
    const staleCases: [PayrollCutoffRecord[], PayrollPdfRecord][] = [
      // Finalized at 11:00 Manila (03:00 UTC), after the 10:30 PDF.
      [[internRecord({ payrollId: "A", finalizedAt: "2026-08-14T03:00:00Z" })], pdfRecord()],
      // Someone was added (Generate again) or deleted since: 2 records, a PDF of 1.
      [[internRecord({ payrollId: "A" }), internRecord({ payrollId: "B" })], pdfRecord({ employeeCount: 1 })],
    ];
    for (const [records, pdf] of staleCases) {
      loadPayrollPdfsSpy.mockResolvedValue({ success: true, payrollPdfs: [pdf] });
      const { unmount } = renderWorkspace(records);
      await screen.findByRole("button", { name: "Past payroll PDFs 1" });
      await waitFor(() => expect(exportLine()).toBe("The last PDF is out of date."));
      expect(screen.getByRole("button", { name: "Generate Intern Payroll PDF" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: "Open PDF" })).not.toBeInTheDocument();
      // The stale copy keeps its place in the history, without "Latest".
      const history = openHistory();
      expect(within(history).getByText("August 1-15, 2026")).toBeInTheDocument();
      expect(within(history).queryByText("Latest")).not.toBeInTheDocument();
      unmount();
    }
  });

  it("finalizes every draft of the chosen cutoff from Finalize all, after the batch confirmation", async () => {
    const finalizeSpy = vi.spyOn(api, "finalizePayrollCutoff").mockResolvedValue({ success: true });
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(
      <>
        <PayrollWorkspace
          records={[
            internRecord({ payrollId: "A", status: "DRAFT" }),
            internRecord({ payrollId: "B", status: "DRAFT" }),
            internRecord({ payrollId: "C", status: "FINALIZED" }),
            internRecord({ payrollId: "JUL", status: "DRAFT", cutoffStart: "2026-07-16", cutoffEnd: "2026-07-31" }),
          ]}
          onSaved={onSaved}
        />
        <Toasts />
      </>,
    );
    // On the table bar, an outline button beside the This cutoff | All cutoffs switch.
    const finalizeAll = screen.getByRole("button", { name: "Finalize all (2)" });
    expect(finalizeAll.closest(".payroll-list-bar")).not.toBeNull();
    expect(finalizeAll).toHaveClass("admin-button");
    await user.click(finalizeAll);
    const dialog = screen.getByRole("dialog", { name: "Finalize all drafts?" });
    expect(dialog).toHaveTextContent("This will finalize all 2 draft payroll record(s) for Aug 1–15, 2026. Values will be locked from further edits.");
    await user.click(within(dialog).getByRole("button", { name: "Finalize payrolls" }));
    expect(await screen.findByText("Finalized 2 payroll record(s).")).toBeInTheDocument();
    // Only this cutoff's drafts: never the finalized record or another cutoff's draft.
    expect(finalizeSpy.mock.calls.map(([id]) => id)).toEqual(["A", "B"]);
    expect(onSaved).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows Finalize all on the table bar while the chosen cutoff has drafts, naming that cutoff under All cutoffs", async () => {
    const finalizeSpy = vi.spyOn(api, "finalizePayrollCutoff").mockResolvedValue({ success: true });
    const user = userEvent.setup();
    const july = internRecord({ payrollId: "JUL", status: "DRAFT", cutoffStart: "2026-07-16", cutoffEnd: "2026-07-31", payrollCutoffLabel: "July 16-31, 2026" });
    const { rerender } = render(<PayrollWorkspace records={[internRecord({ payrollId: "A", status: "DRAFT" }), july]} onSaved={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Finalize all (1)" }).closest(".payroll-list-bar")).not.toBeNull();
    // Every cutoff's rows: it stays, and says which cutoff it finalizes (July's draft is left alone).
    await user.click(screen.getByRole("button", { name: "All cutoffs" }));
    expect(screen.queryByRole("button", { name: "Finalize all (1)" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Finalize all for Aug 1–15, 2026 (1)" }));
    const dialog = screen.getByRole("dialog", { name: "Finalize all drafts?" });
    expect(dialog).toHaveTextContent("This will finalize all 1 draft payroll record(s) for Aug 1–15, 2026.");
    await user.click(within(dialog).getByRole("button", { name: "Finalize payrolls" }));
    await waitFor(() => expect(finalizeSpy).toHaveBeenCalledTimes(1));
    expect(finalizeSpy).toHaveBeenCalledWith("A");
    await user.click(screen.getByRole("button", { name: "This cutoff" }));
    expect(screen.getByRole("button", { name: "Finalize all (1)" })).toBeInTheDocument();
    // No drafts left in this cutoff (July's draft doesn't count): gone.
    rerender(<PayrollWorkspace records={[internRecord({ payrollId: "A" }), july]} onSaved={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /^Finalize all/ })).not.toBeInTheDocument();
  });

  it("reports a partly failed Finalize all on the page", async () => {
    vi.spyOn(api, "finalizePayrollCutoff").mockImplementation(async (id: string) => (id === "A" ? { success: true } : { success: false, error: { message: "Locked." } }));
    const user = userEvent.setup();
    renderWorkspace([internRecord({ payrollId: "A", status: "DRAFT" }), internRecord({ payrollId: "B", status: "DRAFT" })]);
    await user.click(screen.getByRole("button", { name: "Finalize all (2)" }));
    await user.click(screen.getByRole("button", { name: "Finalize payrolls" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Finalized 1 of 2 payroll record(s). 1 could not be finalized.");
  });

  it("shows the intern payroll PDF and payslip actions and no print/export actions", () => {
    renderWorkspace([record()]);
    expect(screen.getByRole("button", { name: "Generate Intern Payroll PDF" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate Employee Payroll PDF" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate from attendance" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate Intern Payslips" })).toBeInTheDocument();
    // No register, CSV/XLSX, or browser print actions.
    expect(screen.queryByRole("button", { name: /export/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /register/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /print payroll$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /csv|xlsx|excel/i })).not.toBeInTheDocument();
  });

  it("makes an intern payroll PDF for the selected cutoff, opens it and offers it under the exports", async () => {
    const pdf = pdfRecord({ totalAmount: 770 });
    generatePayrollPdfSpy.mockResolvedValue({
      success: true,
      pdf,
      filePath: pdf.filePath,
      directoryPath: pdf.directoryPath,
      fileName: pdf.fileName,
      fileKind: "pdf",
      isPortableMode: false,
    });
    const user = userEvent.setup();
    renderWorkspace([internRecord({ netPay: 770 })]);
    await user.click(screen.getByRole("button", { name: "Generate Intern Payroll PDF" }));

    await waitFor(() =>
      expect(generatePayrollPdfSpy).toHaveBeenCalledWith({
        cutoffStart: "2026-08-01",
        cutoffEnd: "2026-08-15",
        payrollCutoffLabel: "August 1-15, 2026",
        workerType: "intern",
      }),
    );
    // A routine result: a toast with the cutoff in the shared date style, and the new PDF opens straight away.
    expect(
      await screen.findByText("Payroll PDF made for Aug 1–15, 2026."),
    ).toBeInTheDocument();
    expect(openGeneratedFileSpy).toHaveBeenCalledWith(pdf.filePath);
    // The line under the exports offers it again; the history (folded) lists it too.
    expect(exportLine()).toBe("PDF made Aug 14, 2026, 10:30 AM");
    expect(within(exportPanel()).getByRole("button", { name: "Show in folder" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate Intern Payroll PDF" })).toBeEnabled();
    const history = openHistory();
    expect(within(history).getByText("August 1-15, 2026")).toBeInTheDocument();
    expect(within(history).getByRole("button", { name: "Open PDF" })).toBeInTheDocument();
    expect(within(history).getByRole("button", { name: "Show in folder" })).toBeInTheDocument();
    expect(screen.getAllByText("PHP 770.00").length).toBeGreaterThan(0);
    expect(window.print).not.toHaveBeenCalled();
  });

  it("says so when a made PDF can't be opened", async () => {
    const pdf = pdfRecord();
    generatePayrollPdfSpy.mockResolvedValue({ success: true, pdf, filePath: pdf.filePath, directoryPath: pdf.directoryPath, fileName: pdf.fileName, fileKind: "pdf", isPortableMode: false });
    openGeneratedFileSpy.mockResolvedValue({ ok: false, message: "No app is set to open PDF files." });
    const user = userEvent.setup();
    renderWorkspace([internRecord()]);
    await user.click(screen.getByRole("button", { name: "Generate Intern Payroll PDF" }));
    expect(await screen.findByText("No app is set to open PDF files.")).toBeInTheDocument();
    expect(exportLine()).toBe("PDF made Aug 14, 2026, 10:30 AM");
  });

  it("generates an intern payroll PDF with the intern worker type", async () => {
    const pdf = pdfRecord({
      payrollPdfId: "payroll-2026-08-14_10-31-00_intern",
      fileName: "payroll-2026-08-14_10-31-00_intern.pdf",
      filePath: "C:\\data\\exports\\payroll-2026-08-14_10-31-00_intern.pdf",
      workerType: "intern",
      totalAmount: 770,
    });
    generatePayrollPdfSpy.mockResolvedValue({
      success: true,
      pdf,
      filePath: pdf.filePath,
      directoryPath: pdf.directoryPath,
      fileName: pdf.fileName,
      fileKind: "pdf",
      isPortableMode: false,
    });
    const user = userEvent.setup();
    renderWorkspace([record(), internRecord()]);
    await user.click(screen.getByRole("button", { name: "Generate Intern Payroll PDF" }));

    await waitFor(() =>
      expect(generatePayrollPdfSpy).toHaveBeenCalledWith({
        cutoffStart: "2026-08-01",
        cutoffEnd: "2026-08-15",
        payrollCutoffLabel: "August 1-15, 2026",
        workerType: "intern",
      }),
    );
    expect(
      await screen.findByText("Payroll PDF made for Aug 1–15, 2026."),
    ).toBeInTheDocument();
  });

  it("shows backend errors and never opens the browser print dialog", async () => {
    generatePayrollPdfSpy.mockResolvedValue({
      success: false,
      error: { message: "Unable to generate the payroll PDF." },
    });
    const user = userEvent.setup();
    renderWorkspace([internRecord()]);
    await user.click(screen.getByRole("button", { name: "Generate Intern Payroll PDF" }));
    expect(
      await screen.findByText("Unable to generate the payroll PDF."),
    ).toBeInTheDocument();
    expect(openGeneratedFileSpy).not.toHaveBeenCalled();
    expect(window.print).not.toHaveBeenCalled();
  });

  it("blocks the payroll PDF and payslips until the cutoff has payroll and every draft of it is finalized", async () => {
    const user = userEvent.setup();
    // Only another cutoff (Jul 16–31) has payroll: the pre-filled Aug 1–15 has none, so nothing to export yet.
    let view = renderWorkspace([internRecord({ cutoffStart: "2026-07-16", cutoffEnd: "2026-07-31", payrollCutoffLabel: "July 16-31, 2026" })]);
    for (const button of exportButtons()) {
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription("Generate payroll first.");
    }
    view.unmount();

    // Drafts left: both off with one short reason; Finalize all waits on the table bar.
    view = renderWorkspace([internRecord({ payrollId: "A", status: "DRAFT" }), internRecord({ payrollId: "B" })]);
    for (const button of exportButtons()) {
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription("Finalize all drafts first.");
    }
    expect(exportLine()).toBe("Finalize all drafts first.");
    expect(screen.getByRole("button", { name: "Finalize all (1)" })).toBeInTheDocument();
    view.unmount();

    // Every record finalized: both exports on, with no reason line.
    renderWorkspace([internRecord({ payrollId: "A" }), internRecord({ payrollId: "B" })]);
    for (const button of exportButtons()) {
      expect(button).toBeEnabled();
      expect(button).not.toHaveAccessibleDescription();
    }
    expect(exportLine()).toBe("");
    await user.click(screen.getByRole("button", { name: "Generate Intern Payslips" }));
    expect(generateInternPayslipImagesSpy).toHaveBeenCalledTimes(1);
    expect(generatePayrollPdfSpy).not.toHaveBeenCalled();
    expect(window.print).not.toHaveBeenCalled();
  });

  it("keeps the exports off with the reason while payroll reloads", () => {
    render(<PayrollWorkspace records={[internRecord()]} onSaved={vi.fn()} loadStatus="loading" onRetry={vi.fn()} />);
    for (const name of ["Generate Intern Payroll PDF", "Generate Intern Payslips", "Generate from attendance"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
      expect(screen.getByRole("button", { name })).toHaveAccessibleDescription("Loading payroll…");
    }
  });

  it("generates intern payslip images for the selected cutoff and opens the saved folder", async () => {
    const directoryPath = "C:\\data\\exports\\payslips\\August 1-15, 2026 20260814-103000";
    generateInternPayslipImagesSpy.mockResolvedValue({
      success: true,
      directoryPath,
      fileCount: 2,
      fileNames: ["Maria Santos.png", "Ada Lovelace.png"],
      message: "Saved 2 payslips.",
    });
    openGeneratedDirectorySpy.mockResolvedValue({ ok: true, message: "" });
    const user = userEvent.setup();
    renderWorkspace([internRecord()]);
    expect(screen.queryByRole("button", { name: "Open payslip folder" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Generate Intern Payslips" }));

    await waitFor(() =>
      expect(generateInternPayslipImagesSpy).toHaveBeenCalledWith({
        cutoffStart: "2026-08-01",
        cutoffEnd: "2026-08-15",
        payrollCutoffLabel: "August 1-15, 2026",
      }),
    );
    expect(
      await screen.findByText("Saved 2 payslip image(s) for Aug 1–15, 2026."),
    ).toBeInTheDocument();
    expect(generatePayrollPdfSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Open payslip folder" }));
    expect(openGeneratedDirectorySpy).toHaveBeenCalledWith(directoryPath);
  });

  it("shows why the payslip folder could not be opened", async () => {
    generateInternPayslipImagesSpy.mockResolvedValue({
      success: true,
      directoryPath: "C:\\data\\exports\\payslips\\gone",
      fileCount: 1,
      fileNames: ["Maria Santos.png"],
      message: "Saved 1 payslip.",
    });
    openGeneratedDirectorySpy.mockResolvedValue({
      ok: false,
      message: "The folder could not be found. It may have been moved or deleted.",
    });
    const user = userEvent.setup();
    renderWorkspace([internRecord()]);
    await user.click(screen.getByRole("button", { name: "Generate Intern Payslips" }));
    await user.click(await screen.findByRole("button", { name: "Open payslip folder" }));
    expect(
      await screen.findByText("The folder could not be found. It may have been moved or deleted."),
    ).toBeInTheDocument();
  });

  it("shows payslip generation errors and offers no folder button", async () => {
    generateInternPayslipImagesSpy.mockResolvedValue({
      success: false,
      error: { message: "Unable to generate the payslips." },
    });
    const user = userEvent.setup();
    renderWorkspace([internRecord()]);
    await user.click(screen.getByRole("button", { name: "Generate Intern Payslips" }));
    expect(await screen.findByText("Unable to generate the payslips.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open payslip folder" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate Intern Payslips" })).toBeEnabled();
  });

  it("disables the payslip button and shows progress while generating", async () => {
    let finish: (value: InternPayslipSaveResponse) => void = () => {};
    generateInternPayslipImagesSpy.mockReturnValue(
      new Promise<InternPayslipSaveResponse>((resolve) => {
        finish = resolve;
      }),
    );
    const user = userEvent.setup();
    renderWorkspace([internRecord()]);
    await user.click(screen.getByRole("button", { name: "Generate Intern Payslips" }));

    const busyButton = screen.getByRole("button", { name: "Saving…" });
    expect(busyButton).toBeDisabled();
    await user.click(busyButton);
    expect(generateInternPayslipImagesSpy).toHaveBeenCalledTimes(1);

    finish({ success: false, error: { message: "Unable to generate the payslips." } });
    expect(await screen.findByRole("button", { name: "Generate Intern Payslips" })).toBeEnabled();
  });

  it("lists previously generated payroll PDFs with open and reveal actions", async () => {
    const internPdf = pdfRecord({
      payrollPdfId: "payroll-2026-08-14_10-31-00_intern",
      fileName: "payroll-2026-08-14_10-31-00_intern.pdf",
      filePath: "C:\\data\\exports\\payroll-2026-08-14_10-31-00_intern.pdf",
      workerType: "intern",
      totalAmount: 770,
    });
    loadPayrollPdfsSpy.mockResolvedValue({
      success: true,
      payrollPdfs: [internPdf],
    });
    renderWorkspace([internRecord()]);

    await screen.findByRole("button", { name: "Past payroll PDFs 1" });
    const history = openHistory();
    expect(within(history).getByText("August 1-15, 2026")).toBeInTheDocument();
    expect(within(history).getAllByRole("button", { name: "Open PDF" })).toHaveLength(1);
    expect(within(history).getAllByRole("button", { name: "Show in folder" })).toHaveLength(1);
    // One period line, no Type column, and the money column says what it is.
    expect(within(history).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Period", "Generated", "Interns", "Total earnings", "Actions"]);
    expect(within(history).queryByText("Aug 1–15, 2026")).not.toBeInTheDocument();
    expect(screen.queryByText("Intern")).not.toBeInTheDocument();
    expect(window.print).not.toHaveBeenCalled();
  });

  it("says what comes first when there is no payroll and no PDF yet", async () => {
    renderWorkspace([]);
    expect(exportLine()).toBe("Generate payroll first.");
    expect(
      screen.getByText("No payroll for this cutoff yet. Pick a cutoff above, then select Generate from attendance."),
    ).toBeInTheDocument();
    openHistory();
    expect(
      await screen.findByText("No PDFs yet. Finalize the cutoff, then select Payroll PDF."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No cutoff payroll has been created/)).not.toBeInTheDocument();
  });

  it("offers only the cutoff's latest PDF under the exports and folds every copy into Past payroll PDFs, newest tagged Latest", async () => {
    openGeneratedFileSpy.mockResolvedValue({ ok: false, message: "The file could not be found." });
    const pdf = (id: string, cutoffStart: string, cutoffEnd: string, label: string, generatedAt: string) =>
      pdfRecord({ payrollPdfId: id, fileName: `${id}.pdf`, filePath: `C:\\data\\exports\\${id}.pdf`, cutoffStart, cutoffEnd, payrollCutoffLabel: label, generatedAt });
    loadPayrollPdfsSpy.mockResolvedValue({
      success: true,
      payrollPdfs: [
        pdf("aug-early", "2026-08-01", "2026-08-15", "August 1-15, 2026", "2026-08-16T09:05:00+08:00"),
        pdf("jul-late", "2026-07-16", "2026-07-31", "July 16-31, 2026", "2026-08-01T10:00:00+08:00"),
        pdf("aug-late", "2026-08-01", "2026-08-15", "August 1-15, 2026", "2026-08-17T08:40:00+08:00"),
      ],
    });
    const user = userEvent.setup();
    renderWorkspace([
      internRecord(),
      internRecord({ payrollId: "JUL", cutoffStart: "2026-07-16", cutoffEnd: "2026-07-31", payrollCutoffLabel: "July 16-31, 2026" }),
    ]);

    // The line under the exports names and opens the newest copy only.
    await waitFor(() => expect(exportLine()).toBe("PDF made Aug 17, 2026, 8:40 AM"));
    expect(screen.getAllByRole("button", { name: "Open PDF" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Open PDF" }));
    expect(openGeneratedFileSpy).toHaveBeenCalledWith("C:\\data\\exports\\aug-late.pdf");
    expect(await screen.findByText("The file could not be found.")).toBeInTheDocument();

    // The history starts closed; open, it has every PDF by month, the newest copy per cutoff tagged Latest.
    const toggle = screen.getByRole("button", { name: "Past payroll PDFs 3" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /August 2026/ })).not.toBeInTheDocument();
    const history = openHistory();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(history).getByRole("button", { name: /August 2026\s*2/ })).toHaveAttribute("aria-expanded", "true");
    const augustRows = within(history).getAllByRole("row").filter((row) => row.textContent?.includes("August 1-15, 2026"));
    expect(augustRows.map((row) => within(row).queryByText("Latest") !== null)).toEqual([true, false]);
    expect(augustRows[0]).toHaveTextContent("Aug 17, 2026, 8:40 AM");
    await user.click(within(history).getByRole("button", { name: /July 2026\s*1/ }));
    expect(within(within(history).getAllByRole("row").find((row) => row.textContent?.includes("July 16-31, 2026")) ?? history).getByText("Latest")).toBeInTheDocument();

    // Another cutoff with no payroll and no PDF: nothing to export yet.
    await user.click(screen.getByRole("button", { name: /16th.*last day/i }));
    expect(exportLine()).toBe("Generate payroll first.");
  });

  it("groups generated payroll PDFs by cutoff month, latest month open", async () => {
    const pdf = (id: string, cutoffStart: string, cutoffEnd: string, label: string, generatedAt: string) =>
      pdfRecord({ payrollPdfId: id, fileName: `${id}.pdf`, filePath: `C:\\data\\exports\\${id}.pdf`, cutoffStart, cutoffEnd, payrollCutoffLabel: label, generatedAt });
    loadPayrollPdfsSpy.mockResolvedValue({
      success: true,
      payrollPdfs: [
        // A September PDF regenerated after the October ones still files under September.
        pdf("sep-late", "2026-09-16", "2026-09-30", "September 16-30, 2026", "2026-11-02T09:00:00+08:00"),
        pdf("oct-2", "2026-10-16", "2026-10-31", "October 16-31, 2026", "2026-11-01T09:00:00+08:00"),
        pdf("oct-1", "2026-10-01", "2026-10-15", "October 1-15, 2026", "2026-10-16T09:00:00+08:00"),
      ],
    });
    const user = userEvent.setup();
    renderWorkspace([]);

    await screen.findByRole("button", { name: "Past payroll PDFs 3" });
    openHistory();
    const october = await screen.findByRole("button", { name: /October 2026\s*2/ });
    const september = screen.getByRole("button", { name: /September 2026\s*1/ });
    expect(october).toHaveAttribute("aria-expanded", "true");
    expect(september).toHaveAttribute("aria-expanded", "false");
    expect(screen.getAllByRole("button", { name: "Open PDF" })).toHaveLength(2);
    expect(screen.queryByText("September 16-30, 2026")).not.toBeInTheDocument();

    await user.click(september);
    expect(screen.getByText("September 16-30, 2026")).toBeInTheDocument();
    await user.click(october);
    expect(screen.getAllByRole("button", { name: "Open PDF" })).toHaveLength(1);
  });

  it("does not expose manual payroll entry fields", () => {
    renderWorkspace([]);
    expect(screen.queryByRole("combobox", { name: "Personnel" })).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: "Actual days" })).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: "Manual adjustment (PHP)" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate from attendance" })).toBeInTheDocument();
  });

  it("allows payroll generation to be cancelled before the backend is called", async () => {
    const user = userEvent.setup();
    renderWorkspace([]);
    await user.click(screen.getByRole("button", { name: /1st.*15th/i }));
    await user.click(screen.getByRole("button", { name: "Generate from attendance" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(generatePayrollCutoffSpy).not.toHaveBeenCalled();
  });

  it("prompts for replacement confirmation when generating for an existing cutoff", async () => {
    const deletePayrollCutoffSpy = vi.spyOn(api, "deletePayrollCutoff").mockResolvedValue({ success: true });
    generatePayrollCutoffSpy.mockResolvedValueOnce({ success: true });
    const user = userEvent.setup();
    renderWorkspace([
      record({ payrollId: "P-001", status: "DRAFT" }),
      record({ payrollId: "P-002", employeeId: "EMP-002", status: "FINALIZED" }),
    ]);
    await user.click(screen.getByRole("button", { name: /1st.*15th/i }));
    await user.click(screen.getByRole("button", { name: "Generate from attendance" }));
    expect(screen.getByRole("dialog", { name: "Regenerate cutoff payroll?" })).toBeInTheDocument();
    expect(screen.getByText(/replace the draft records with fresh calculations from latest attendance; finalized records are kept/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Regenerate payroll" }));
    await waitFor(() => {
      expect(deletePayrollCutoffSpy).toHaveBeenCalledWith("P-001");
      expect(generatePayrollCutoffSpy).toHaveBeenCalledWith("2026-08-01", "2026-08-15", "August 1-15, 2026", { standardWorkingDays: 10 });
    });
    // Approved pay is never deleted by a regenerate.
    expect(deletePayrollCutoffSpy).not.toHaveBeenCalledWith("P-002");
  });

  it("never talks about replacing drafts when every record is finalized", async () => {
    const deletePayrollCutoffSpy = vi.spyOn(api, "deletePayrollCutoff").mockResolvedValue({ success: true });
    generatePayrollCutoffSpy.mockResolvedValueOnce({ success: true });
    const user = userEvent.setup();
    renderWorkspace([internRecord({ payrollId: "A" }), internRecord({ payrollId: "B" })]);
    await user.click(screen.getByRole("button", { name: "Generate from attendance" }));
    const dialog = screen.getByRole("dialog", { name: "Generate again?" });
    expect(dialog).toHaveTextContent(
      "All 2 record(s) for Aug 1–15, 2026 are finalized and stay as they are. Generating again only adds payroll, from completed attendance, for people not in this cutoff yet. Continue?",
    );
    expect(dialog).not.toHaveTextContent(/draft/i);
    await user.click(within(dialog).getByRole("button", { name: "Generate again" }));
    await waitFor(() => expect(generatePayrollCutoffSpy).toHaveBeenCalledWith("2026-08-01", "2026-08-15", "August 1-15, 2026", { standardWorkingDays: 10 }));
    expect(deletePayrollCutoffSpy).not.toHaveBeenCalled();
  });

  it("states that late time-outs are paid up to 17:00 when generating new drafts", async () => {
    const user = userEvent.setup();
    renderWorkspace([]);
    await user.click(screen.getByRole("button", { name: /1st.*15th/i }));
    await user.click(screen.getByRole("button", { name: "Generate from attendance" }));
    expect(screen.getByText(/late time-outs are paid up to 17:00/i)).toBeInTheDocument();
    expect(screen.queryByText(/will not be paid/i)).not.toBeInTheDocument();
  });

  it("opens the edit dialog on a draft intern record and saves the manual adjustment", async () => {
    const savePayrollCutoffSpy = vi.spyOn(api, "savePayrollCutoff").mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderWorkspace([internRecord({ status: "DRAFT", standardWorkingDays: 11 })]);

    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("dialog", { name: /Edit Payroll — Maria Santos \(Intern\)/i })).toBeInTheDocument();

    const adjustmentInput = screen.getByLabelText(/Manual Adjustment/i);
    await user.clear(adjustmentInput);
    await user.type(adjustmentInput, "50");
    await user.type(screen.getByLabelText(/Adjustment Reason/i), "Attendance correction");

    await user.click(screen.getByRole("button", { name: /Save Changes/i }));
    await waitFor(() => {
      expect(savePayrollCutoffSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          payrollId: "P-INT-001",
          manualAdjustment: 50,
          adjustmentReason: "Attendance correction",
        }),
        "P-INT-001",
      );
    });
  });

  it("allows setting standard working days in the generate panel to customize cutoff generation", async () => {
    generatePayrollCutoffSpy.mockResolvedValueOnce({ success: true });
    const user = userEvent.setup();
    render(<PayrollWorkspace records={[]} onSaved={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /1st.*15th/i }));
    // Always in view beside the dates, filled from the preset (Aug 1–15, 2026 has 10 weekdays).
    const stdDaysInput = within(generatePanel()).getByLabelText(/Standard days/i);
    expect(stdDaysInput).toHaveValue(10);
    await user.clear(stdDaysInput);
    await user.type(stdDaysInput, "12");

    await user.click(screen.getByRole("button", { name: "Generate from attendance" }));
    await user.click(screen.getByRole("button", { name: "Generate payroll" }));

    expect(generatePayrollCutoffSpy).toHaveBeenCalledWith(
      "2026-08-01",
      "2026-08-15",
      "August 1-15, 2026",
      { standardWorkingDays: 12 },
    );
  });

  it("shows manual adjustment as editable and hides standard working days, allowances, and statutory deductions when editing an intern record", async () => {
    const user = userEvent.setup();
    renderWorkspace([internRecord({ status: "DRAFT", standardWorkingDays: 11 })]);

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: /Edit Payroll — Maria Santos \(Intern\)/i });
    expect(dialog).toBeInTheDocument();

    // Auto-computed attendance stats ARE displayed:
    expect(within(dialog).getByText("Attendance Basic")).toBeInTheDocument();
    expect(within(dialog).getByText("Late Deduction")).toBeInTheDocument();

    // Intern editable fields:
    expect(within(dialog).getByLabelText(/Manual Adjustment/i)).toBeInTheDocument();

    // Standard working days is global, not per-person editable in modal:
    expect(within(dialog).queryByLabelText(/Standard Working Days/i)).not.toBeInTheDocument();

    // Non-intern fields are NOT visible:
    expect(within(dialog).queryByLabelText("HRA")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Incentives Allowance")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Special Allowance")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Regular Holiday Pay")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Special Holiday Pay")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Overtime Pay")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("SSS Employee Share")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Phic (PhilHealth) Employee Share")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("HDMF (Pag-IBIG) Employee Share")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Salary Advance")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Total Allowance")).not.toBeInTheDocument();
  });

  it("allows deleting a finalized payroll record with confirmation", async () => {
    const deletePayrollCutoffSpy = vi.spyOn(api, "deletePayrollCutoff").mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderWorkspace([record({ status: "FINALIZED" })]);

    expect(screen.getByText("Finalized")).toBeInTheDocument();
    const deleteBtn = screen.getByRole("button", { name: "Delete" });
    expect(deleteBtn).toBeInTheDocument();

    await user.click(deleteBtn);
    expect(screen.getByRole("dialog", { name: "Delete finalized payroll?" })).toBeInTheDocument();
    expect(screen.getByText(/This will delete the finalized payroll for Ada Lovelace/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete payroll" }));
    await waitFor(() => {
      expect(deletePayrollCutoffSpy).toHaveBeenCalledWith("P-001");
    });
  });

  it("supports master select-all checkbox to select and batch delete multiple payroll records", async () => {
    const deletePayrollCutoffSpy = vi.spyOn(api, "deletePayrollCutoff").mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderWorkspace([
      record({ payrollId: "P-001", employeeName: "Ada Lovelace", status: "DRAFT" }),
      internRecord({ payrollId: "P-INT-001", employeeName: "Maria Santos", status: "DRAFT" }),
    ]);

    expect(screen.getByText("Aug 1–15, 2026 · 2 records")).toBeInTheDocument();
    // The header tick box is the only select-all.
    expect(screen.queryByRole("button", { name: /Select all/ })).not.toBeInTheDocument();
    const masterCheckbox = screen.getByRole("checkbox", { name: /Select all payroll records/i });
    expect(masterCheckbox).not.toBeChecked();

    // Select all via master checkbox: the selection bar takes the list bar's place.
    await user.click(masterCheckbox);
    expect(masterCheckbox).toBeChecked();
    const selectionBar = screen.getByRole("group", { name: "Selected payroll records" });
    expect(within(selectionBar).getByText("2 selected")).toBeInTheDocument();
    expect(within(selectionBar).getAllByRole("button").map((button) => button.textContent)).toEqual(["Clear", "Finalize selected", "Delete selected"]);

    // Trigger batch delete
    const batchDeleteBtn = screen.getByRole("button", { name: "Delete selected" });
    await user.click(batchDeleteBtn);

    expect(screen.getByRole("dialog", { name: "Delete selected payrolls?" })).toBeInTheDocument();
    expect(screen.getByText(/Are you sure you want to delete 2 selected payroll record\(s\)\?/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete payrolls" }));
    await waitFor(() => {
      expect(deletePayrollCutoffSpy).toHaveBeenCalledWith("P-001");
      expect(deletePayrollCutoffSpy).toHaveBeenCalledWith("P-INT-001");
    });
  });

  it("supports batch finalizing selected draft payroll records", async () => {
    const finalizePayrollCutoffSpy = vi.spyOn(api, "finalizePayrollCutoff").mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderWorkspace([
      record({ payrollId: "P-001", employeeName: "Ada Lovelace", status: "DRAFT" }),
      internRecord({ payrollId: "P-INT-001", employeeName: "Maria Santos", status: "DRAFT" }),
    ]);

    const selectAdaCheckbox = screen.getByRole("checkbox", { name: /Select payroll for Ada Lovelace/i });
    await user.click(selectAdaCheckbox);
    expect(selectAdaCheckbox).toBeChecked();
    expect(await screen.findByText("1 selected")).toBeInTheDocument();

    const finalizeSelectedBtn = screen.getByRole("button", { name: "Finalize selected" });
    await user.click(finalizeSelectedBtn);

    expect(screen.getByRole("dialog", { name: "Finalize selected payrolls?" })).toHaveTextContent("This will finalize 1 selected draft payroll record(s).");
    await user.click(screen.getByRole("button", { name: "Finalize payrolls" }));
    await waitFor(() => {
      expect(finalizePayrollCutoffSpy).toHaveBeenCalledWith("P-001");
    });
    expect(finalizePayrollCutoffSpy).toHaveBeenCalledTimes(1);
  });

  it("swaps the list bar for the selection bar without moving, and Clear hands the focus to the header tick box", async () => {
    const user = userEvent.setup();
    renderWorkspace([internRecord({ payrollId: "A", status: "DRAFT" }), internRecord({ payrollId: "B", employeeName: "Jose Reyes" })]);
    const listLayer = screen.getByText("Aug 1–15, 2026 · 2 records").closest(".payroll-bar-layer");
    // Hidden from the accessibility tree while nothing is ticked, so found by its label.
    const selectionBar = document.querySelector<HTMLElement>('[role="group"][aria-label="Selected payroll records"]') ?? document.body;
    // Both layers stay in the page; the one not showing is hidden and can't be tabbed into.
    expect(selectionBar).toHaveAttribute("aria-hidden", "true");
    expect(selectionBar).toHaveAttribute("inert");
    await user.click(screen.getByRole("checkbox", { name: /Select payroll for Maria Santos/ }));
    expect(listLayer).toHaveAttribute("aria-hidden", "true");
    expect(listLayer).toHaveAttribute("inert");
    expect(selectionBar).not.toHaveAttribute("inert");
    expect(within(selectionBar).getByRole("button", { name: "Finalize selected" })).toBeInTheDocument();
    await user.click(within(selectionBar).getByRole("button", { name: "Clear" }));
    expect(screen.getByRole("checkbox", { name: /Select all payroll records/ })).toHaveFocus();
    expect(selectionBar).toHaveAttribute("inert");
    // Only a finalized row ticked: nothing to finalize, so no Finalize selected.
    await user.click(screen.getByRole("checkbox", { name: /Select payroll for Jose Reyes/ }));
    expect(within(selectionBar).queryByRole("button", { name: "Finalize selected" })).not.toBeInTheDocument();
    expect(within(selectionBar).getByRole("button", { name: "Delete selected" })).toBeInTheDocument();
  });

  it("reports a partly failed batch finalize inline and keeps the failed record selected", async () => {
    vi.spyOn(api, "finalizePayrollCutoff").mockImplementation(async (id: string) =>
      id === "P-001" ? { success: true } : { success: false, error: { message: "Locked." } },
    );
    const user = userEvent.setup();
    renderWorkspace([
      record({ payrollId: "P-001", employeeName: "Ada Lovelace", status: "DRAFT" }),
      internRecord({ payrollId: "P-INT-001", employeeName: "Maria Santos", status: "DRAFT" }),
    ]);

    await user.click(screen.getByRole("checkbox", { name: /Select all payroll records/i }));
    await user.click(screen.getByRole("button", { name: "Finalize selected" }));
    await user.click(screen.getByRole("button", { name: "Finalize payrolls" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Finalized 1 of 2 payroll record(s). 1 could not be finalized.");
    expect(screen.queryByText(/^Finalized 2 payroll/)).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Select payroll for Maria Santos/i })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Select payroll for Ada Lovelace/i })).not.toBeChecked();
  });

  it("clears an earlier error when a later action succeeds", async () => {
    vi.spyOn(api, "finalizePayrollCutoff").mockResolvedValue({ success: false, error: { message: "Payroll is locked by another admin." } });
    vi.spyOn(api, "deletePayrollCutoff").mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderWorkspace([record({ payrollId: "P-001", status: "DRAFT" })]);

    await user.click(screen.getByRole("button", { name: "Finalize" }));
    await user.click(screen.getByRole("button", { name: "Finalize payroll" }));
    expect(await screen.findByText("Payroll is locked by another admin.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete payroll" }));
    expect(await screen.findByText("Payroll deleted.")).toBeInTheDocument();
    expect(screen.queryByText("Payroll is locked by another admin.")).not.toBeInTheDocument();
  });

  it("deletes every record of the chosen cutoff from Delete all records", async () => {
    const deletePayrollCutoffSpy = vi.spyOn(api, "deletePayrollCutoff").mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderWorkspace([
      record({ payrollId: "P-001", cutoffStart: "2026-08-01", cutoffEnd: "2026-08-15", status: "DRAFT" }),
    ]);

    await user.click(screen.getByRole("button", { name: /1st.*15th/i }));

    expect(within(generatePanel()).getByText(/^This cutoff has 1 record\./)).toBeInTheDocument();
    const clearCutoffBtn = await screen.findByRole("button", { name: "Delete all records" });
    expect(clearCutoffBtn).toHaveClass("danger-button");

    await user.click(clearCutoffBtn);
    expect(screen.getByRole("dialog", { name: "Delete cutoff records?" })).toBeInTheDocument();
    expect(screen.getByText(/This will permanently delete all 1 payroll record\(s\) for Aug 1–15, 2026/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete cutoff records" }));
    await waitFor(() => {
      expect(deletePayrollCutoffSpy).toHaveBeenCalledWith("P-001");
    });
  });

  it("says how many records the cutoff has, with Delete all records as quiet coral text that asks for DELETE once pay is finalized", async () => {
    const deletePayrollCutoffSpy = vi.spyOn(api, "deletePayrollCutoff").mockResolvedValue({ success: true });
    const user = userEvent.setup();

    // No payroll for the cutoff: no line, nothing to delete.
    let view = renderWorkspace([]);
    expect(screen.queryByText(/^This cutoff has/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete all records" })).not.toBeInTheDocument();
    view.unmount();

    // Drafts (one finalized too): one quiet line under the fields instead of the old "already exists" banner.
    view = renderWorkspace([internRecord({ payrollId: "A", status: "DRAFT" }), internRecord({ payrollId: "B", status: "FINALIZED" })]);
    expect(screen.queryByText(/Payroll already exists for this cutoff/)).not.toBeInTheDocument();
    expect(within(generatePanel()).getByText("This cutoff has 2 records. Generating again replaces drafts; finalized pay is kept.")).toBeInTheDocument();
    expect(within(generatePanel()).getByRole("button", { name: "Delete all records" })).toHaveClass("text-button", "danger-button");
    view.unmount();

    // All finalized: no finalized line; deleting says approved pay goes too and asks for DELETE.
    renderWorkspace([internRecord({ payrollId: "A" }), internRecord({ payrollId: "B" })]);
    expect(screen.queryByText(/for this cutoff (is|are) finalized/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete all records" }));
    const dialog = screen.getByRole("dialog", { name: "Delete cutoff records?" });
    expect(dialog).toHaveTextContent(
      "This will permanently delete all 2 payroll record(s) for Aug 1–15, 2026, including 2 finalized (approved) record(s). This cannot be undone.",
    );
    const confirm = within(dialog).getByRole("button", { name: "Delete cutoff records" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Type DELETE to confirm/), "DELETE");
    await user.click(confirm);
    await waitFor(() => expect(deletePayrollCutoffSpy).toHaveBeenCalledTimes(2));
    expect(deletePayrollCutoffSpy).toHaveBeenCalledWith("A");
    expect(deletePayrollCutoffSpy).toHaveBeenCalledWith("B");
  });

  it("saves the label that matches the dates: typed dates send '<start> to <end>', a preset sends its own label", async () => {
    generatePayrollCutoffSpy.mockResolvedValue({ success: true });
    generatePayrollPdfSpy.mockResolvedValue({ success: false, error: { message: "Not now." } });
    generateInternPayslipImagesSpy.mockResolvedValue({ success: false, error: { message: "Not now." } });
    const user = userEvent.setup();
    /** Generate again (every record is finalized, so nothing is deleted), then both exports, for the dates on screen. */
    const runAll = async () => {
      await user.click(screen.getByRole("button", { name: "Generate from attendance" }));
      await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Generate again" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await user.click(screen.getByRole("button", { name: "Generate Intern Payroll PDF" }));
      await user.click(screen.getByRole("button", { name: "Generate Intern Payslips" }));
    };
    const custom = internRecord({ payrollId: "C", cutoffStart: "2026-08-03", cutoffEnd: "2026-08-14", payrollCutoffLabel: "2026-08-03 to 2026-08-14" });
    const lateAug = internRecord({ payrollId: "L", cutoffStart: "2026-08-16", cutoffEnd: "2026-08-31", payrollCutoffLabel: "August 16-31, 2026" });
    renderWorkspace([custom, lateAug]);

    // Dates typed after the pre-fill: the pre-filled "August 1-15, 2026" must not stick.
    fireEvent.change(screen.getByLabelText("Cutoff start"), { target: { value: "2026-08-03" } });
    fireEvent.change(screen.getByLabelText("Cutoff end"), { target: { value: "2026-08-14" } });
    await runAll();
    expect(generatePayrollCutoffSpy).toHaveBeenLastCalledWith("2026-08-03", "2026-08-14", "2026-08-03 to 2026-08-14", { standardWorkingDays: 10 });
    expect(generatePayrollPdfSpy).toHaveBeenLastCalledWith({ cutoffStart: "2026-08-03", cutoffEnd: "2026-08-14", payrollCutoffLabel: "2026-08-03 to 2026-08-14", workerType: "intern" });
    expect(generateInternPayslipImagesSpy).toHaveBeenLastCalledWith({ cutoffStart: "2026-08-03", cutoffEnd: "2026-08-14", payrollCutoffLabel: "2026-08-03 to 2026-08-14" });

    // The other preset: its own label and working days (Aug 16–31, 2026 has 11 weekdays).
    await user.click(screen.getByRole("button", { name: /16th.*last day/i }));
    expect(screen.getByLabelText("Standard days")).toHaveValue(11);
    await runAll();
    expect(generatePayrollCutoffSpy).toHaveBeenLastCalledWith("2026-08-16", "2026-08-31", "August 16-31, 2026", { standardWorkingDays: 11 });
    expect(generatePayrollPdfSpy).toHaveBeenLastCalledWith({ cutoffStart: "2026-08-16", cutoffEnd: "2026-08-31", payrollCutoffLabel: "August 16-31, 2026", workerType: "intern" });
    expect(generateInternPayslipImagesSpy).toHaveBeenLastCalledWith({ cutoffStart: "2026-08-16", cutoffEnd: "2026-08-31", payrollCutoffLabel: "August 16-31, 2026" });
  });

  it("refuses standard days outside 0 to 31 before generating, with the reason under the fields", async () => {
    const user = userEvent.setup();
    renderWorkspace([]);
    const days = screen.getByLabelText("Standard days");
    await user.clear(days);
    await user.type(days, "45");
    const generate = screen.getByRole("button", { name: "Generate from attendance" });
    expect(generate).toBeDisabled();
    expect(generate).toHaveAccessibleDescription("Standard days must be 0 to 31 (whole or half days).");
    // A date problem is the one coral line, under the fields.
    expect(document.getElementById("payroll-generate-reason")).toHaveClass("payroll-reason", "is-problem");
    // Enter in the field doesn't get past it either.
    fireEvent.submit(days.closest("form") ?? days);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(generatePayrollCutoffSpy).not.toHaveBeenCalled();
    // Half days are fine.
    await user.clear(days);
    await user.type(days, "10.5");
    expect(generate).toBeEnabled();
  });

  it("drops another cutoff's payslip folder and messages when the dates change", async () => {
    generateInternPayslipImagesSpy.mockResolvedValue({ success: true, directoryPath: "C:\\exports\\payslips\\aug", fileCount: 1, fileNames: ["Maria Santos.png"], message: "Saved 1 payslip." });
    generatePayrollPdfSpy.mockResolvedValue({ success: false, error: { message: "Unable to generate the payroll PDF." } });
    const user = userEvent.setup();
    renderWorkspace([internRecord()]);
    await user.click(screen.getByRole("button", { name: "Generate Intern Payslips" }));
    await user.click(screen.getByRole("button", { name: "Generate Intern Payroll PDF" }));
    expect(await screen.findByRole("button", { name: "Open payslip folder" })).toBeInTheDocument();
    expect(await screen.findByText("Unable to generate the payroll PDF.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /16th.*last day/i }));
    expect(screen.queryByRole("button", { name: "Open payslip folder" })).not.toBeInTheDocument();
    expect(screen.queryByText("Unable to generate the payroll PDF.")).not.toBeInTheDocument();
  });

  it("hands the focus to the payroll PDF once Finalize all has finalized the last draft", async () => {
    vi.spyOn(api, "finalizePayrollCutoff").mockResolvedValue({ success: true });
    const user = userEvent.setup();
    const drafts = [internRecord({ payrollId: "A", status: "DRAFT" }), internRecord({ payrollId: "B", status: "DRAFT" })];
    const { rerender } = render(<PayrollWorkspace records={drafts} onSaved={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Generate Intern Payroll PDF" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Finalize all (2)" }));
    await user.click(screen.getByRole("button", { name: "Finalize payrolls" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // The refreshed list arrives finalized: Finalize all leaves the bar, the exports turn on and the focus goes on to
    // the payroll PDF.
    rerender(<PayrollWorkspace records={drafts.map((record) => ({ ...record, status: "FINALIZED" }))} onSaved={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /^Finalize all/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate Intern Payroll PDF" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Generate Intern Payroll PDF" })).toHaveFocus();
  });

  it("hands the focus to Generate from attendance once Delete all records has emptied the cutoff", async () => {
    vi.spyOn(api, "deletePayrollCutoff").mockResolvedValue({ success: true });
    const user = userEvent.setup();
    for (const status of ["DRAFT", "FINALIZED"] as const) {
      const records = [internRecord({ payrollId: "A", status }), internRecord({ payrollId: "B", status })];
      const { rerender, unmount } = render(<PayrollWorkspace records={records} onSaved={vi.fn()} />);
      await user.click(screen.getByRole("button", { name: "Delete all records" }));
      const dialog = screen.getByRole("dialog", { name: "Delete cutoff records?" });
      // Finalized pay asks for DELETE first.
      if (status === "FINALIZED") await user.type(within(dialog).getByLabelText(/Type DELETE to confirm/), "DELETE");
      await user.click(within(dialog).getByRole("button", { name: "Delete cutoff records" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      // The refreshed list arrives empty: Delete all records leaves, the exports are off, so Generate takes the focus.
      rerender(<PayrollWorkspace records={[]} onSaved={vi.fn()} />);
      expect(screen.queryByRole("button", { name: "Delete all records" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Generate from attendance" })).toHaveFocus();
      unmount();
    }
  });

  it("hands the focus to Generate from attendance once a row's Delete has removed the cutoff's only record", async () => {
    vi.spyOn(api, "deletePayrollCutoff").mockResolvedValue({ success: true });
    const user = userEvent.setup();
    for (const status of ["DRAFT", "FINALIZED"] as const) {
      const { rerender, unmount } = render(<PayrollWorkspace records={[internRecord({ payrollId: "A", status })]} onSaved={vi.fn()} />);
      await user.click(within(screen.getByRole("row", { name: /Maria Santos/ })).getByRole("button", { name: "Delete" }));
      await user.click(screen.getByRole("button", { name: "Delete payroll" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      rerender(<PayrollWorkspace records={[]} onSaved={vi.fn()} />);
      expect(screen.queryByRole("row", { name: /Maria Santos/ })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Generate from attendance" })).toHaveFocus();
      unmount();
    }
  });

  it("shows the chosen cutoff's records, or every cutoff's with a Period column, and acts on the rows shown", async () => {
    const deletePayrollCutoffSpy = vi.spyOn(api, "deletePayrollCutoff").mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderWorkspace([
      internRecord({ payrollId: "AUG", employeeName: "Maria Santos", status: "DRAFT" }),
      internRecord({ payrollId: "JUL", employeeName: "Jose Reyes", status: "DRAFT", cutoffStart: "2026-07-16", cutoffEnd: "2026-07-31", payrollCutoffLabel: "July 16-31, 2026" }),
    ]);

    // Aug 1–15 only: Jose's July row is hidden and there is no Period column.
    const thisCutoff = screen.getByRole("button", { name: "This cutoff" });
    const allCutoffs = screen.getByRole("button", { name: "All cutoffs" });
    expect(thisCutoff).toHaveAttribute("aria-pressed", "true");
    expect(allCutoffs).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Aug 1–15, 2026 · 1 record")).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Maria Santos/ })).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /Jose Reyes/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Period" })).not.toBeInTheDocument();

    // Every cutoff: both rows, each with its period.
    await user.click(allCutoffs);
    expect(allCutoffs).toHaveAttribute("aria-pressed", "true");
    expect(thisCutoff).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("All cutoffs · 2 records")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Period" })).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /Jose Reyes/ })).getByText("Jul 16–31, 2026")).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /Maria Santos/ })).getByText("Aug 1–15, 2026")).toBeInTheDocument();

    // The header tick box picks the rows shown: both here, only August after going back to this cutoff.
    await user.click(screen.getByRole("checkbox", { name: /Select all payroll records/i }));
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear" }));
    await user.click(screen.getByRole("button", { name: "This cutoff" }));
    expect(screen.queryByRole("row", { name: /Jose Reyes/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /Select all payroll records/i }));
    expect(await screen.findByText("1 selected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete selected" }));
    await user.click(screen.getByRole("button", { name: "Delete payrolls" }));
    await waitFor(() => expect(deletePayrollCutoffSpy).toHaveBeenCalledWith("AUG"));
    expect(deletePayrollCutoffSpy).not.toHaveBeenCalledWith("JUL");
  });

  it("shows the This cutoff | All cutoffs switch only when another cutoff has payroll", () => {
    renderWorkspace([internRecord({ payrollId: "A" }), internRecord({ payrollId: "B" })]);
    expect(screen.getByText("Aug 1–15, 2026 · 2 records")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Cutoffs shown" })).not.toBeInTheDocument();
  });

  it("offers every cutoff from the empty table when the chosen cutoff has no payroll", async () => {
    const user = userEvent.setup();
    renderWorkspace([internRecord({ cutoffStart: "2026-07-16", cutoffEnd: "2026-07-31", payrollCutoffLabel: "July 16-31, 2026" })]);
    expect(screen.getByText("No payroll for this cutoff yet. Pick a cutoff above, then select Generate from attendance.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "All cutoffs" }));
    expect(screen.getByRole("row", { name: /Maria Santos/ })).toBeInTheDocument();
  });

  it("shows calm rows: the name with the ID under it, a status word, money right-aligned and actions on one line", () => {
    renderWorkspace([
      internRecord({ payrollId: "A", employeeId: "APG-2026-001", employeeName: "Juan Dela Cruz", status: "DRAFT", netPay: 780, totalDeductions: 100 }),
      internRecord({ payrollId: "B", employeeId: "APG-2026-002", employeeName: "Maria Santos" }),
    ]);
    const headings = screen.getAllByRole("columnheader").map((cell) => cell.textContent);
    // One Employee column (no separate Employee #), then Status; every money column kept.
    expect(headings.slice(1, 3)).toEqual(["Employee", "Status"]);
    expect(headings).not.toContain("Employee #");
    for (const heading of ["Standard", "Paid Days", "LWOP", "Daily Rate", "Basic Pay", "Total Earnings", "Absent", "Late / Halfday", "Total Deductions", "Net Pay"]) {
      expect(headings).toContain(heading);
    }

    const draftRow = screen.getByRole("row", { name: /Juan Dela Cruz/ });
    const cells = within(draftRow).getAllByRole("cell");
    expect(cells[1]).toHaveTextContent(/^Juan Dela CruzAPG-2026-001$/);
    expect(cells[1]).not.toHaveTextContent("(Intern)");
    expect(cells[2]).toHaveTextContent(/^Draft$/);
    // Amounts right-aligned in their own cells, Net Pay and Total Deductions with no inline colours.
    const net = cells[headings.indexOf("Net Pay")];
    const deductions = cells[headings.indexOf("Total Deductions")];
    expect(net).toHaveTextContent("PHP 780.00");
    expect(net).toHaveClass("payroll-num", "payroll-net-cell");
    expect(net.querySelector("[style]")).toBeNull();
    expect(net).not.toHaveAttribute("style");
    expect(deductions).toHaveTextContent("PHP 100.00");
    expect(deductions.querySelector("[style]")).toBeNull();
    // Its amount in coral, by class; Net Pay stays gold.
    expect(deductions.querySelector("strong")).toHaveClass("money-deduction");
    expect(net.querySelector(".money-deduction")).toBeNull();
    // Drafts: Breakdown, Edit, Finalize, then Delete last; finalized rows: Breakdown and Delete.
    expect(within(draftRow).getAllByRole("button").map((button) => button.textContent)).toEqual(["Breakdown", "Edit", "Finalize", "Delete"]);
    const finalRow = screen.getByRole("row", { name: /Maria Santos/ });
    expect(within(finalRow).getAllByRole("cell")[2]).toHaveTextContent(/^Finalized$/);
    // Nothing deducted: muted, not coral.
    const zero = within(finalRow).getAllByRole("cell")[headings.indexOf("Total Deductions")];
    expect(zero).toHaveTextContent("PHP 0.00");
    expect(zero.querySelector("strong")).toHaveClass("money-zero");
    expect(zero.querySelector(".money-deduction")).toBeNull();
    expect(within(finalRow).getAllByRole("button").map((button) => button.textContent)).toEqual(["Breakdown", "Delete"]);
  });

  it("shows Total Deductions in coral in Edit payroll and Breakdown, muted when nothing was deducted", async () => {
    const user = userEvent.setup();
    renderWorkspace([
      internRecord({ payrollId: "A", employeeId: "APG-2026-001", employeeName: "Juan Dela Cruz", status: "DRAFT", lateUnits: 2, lateDeduction: 20, totalDeductions: 20, netPay: 780 }),
      internRecord({ payrollId: "B", employeeId: "APG-2026-002", employeeName: "Jose Reyes" }),
    ]);
    const juan = screen.getByRole("row", { name: /Juan Dela Cruz/ });
    await user.click(within(juan).getByRole("button", { name: "Edit" }));
    const edit = screen.getByRole("dialog", { name: /Edit Payroll — Juan Dela Cruz/ });
    expect(within(edit).getByText("Total Deductions").nextElementSibling).toHaveClass("summary-value", "money-deduction");
    await user.click(within(edit).getByRole("button", { name: "Cancel" }));

    await user.click(within(juan).getByRole("button", { name: "Breakdown" }));
    let breakdown = screen.getByRole("dialog", { name: /Calculation breakdown — Juan Dela Cruz/ });
    expect(within(breakdown).getByText("Total deductions", { selector: "dt" }).nextElementSibling).toHaveClass("money-deduction");
    expect(breakdown.querySelector(".payroll-deductions-total")).toHaveClass("money-deduction");
    await user.click(within(breakdown).getByRole("button", { name: /Close/ }));

    await user.click(within(screen.getByRole("row", { name: /Jose Reyes/ })).getByRole("button", { name: "Breakdown" }));
    breakdown = screen.getByRole("dialog", { name: /Calculation breakdown — Jose Reyes/ });
    expect(within(breakdown).getByText("Total deductions", { selector: "dt" }).nextElementSibling).toHaveClass("money-zero");
    expect(breakdown.querySelector(".payroll-deductions-total")).toHaveClass("money-zero");
    expect(breakdown.querySelector(".money-deduction")).toBeNull();
  });

  it("displays transparent deductions breakdown table with dates, causes, and amounts when available", async () => {
    const user = userEvent.setup();
    const deductionBreakdownJson = JSON.stringify({
      source: "attendance",
      actualWorkingDays: 9,
      standardWorkingDays: 11,
      dailyRate: 80,
      deductions: [
        {
          date: "2026-09-03",
          category: "ABSENCE",
          label: "Absence",
          details: "No attendance logged for standard workday",
          amount: 80,
        },
        {
          date: "2026-09-04",
          category: "UNDERTIME",
          label: "Half-day",
          details: "Incomplete hours: 4 hrs worked of 8 hrs (4 hrs short), 08:00 AM – 12:00 PM",
          timeIn: "08:00 AM",
          timeOut: "12:00 PM",
          workedHours: 4,
          hoursShort: 4,
          amount: 40,
        },
      ],
    });

    const internWithDeductions = internRecord({
      standardWorkingDays: 11,
      actualWorkingDays: 9,
      dailyRate: 80,
      basicPay: 880,
      totalCompensation: 880,
      absentDays: 1,
      absenceDeduction: 80,
      halfDayCount: 1,
      halfDayDeduction: 40,
      grossCompensation: 880,
      netPay: 760,
      calculationBreakdown: deductionBreakdownJson,
    });

    renderWorkspace([internWithDeductions]);

    // Open the calculation breakdown popup
    await user.click(screen.getByRole("button", { name: "Breakdown" }));
    const breakdown = screen.getByRole("dialog", { name: /Calculation breakdown — Maria Santos/i });

    // Verify transparent deduction table heading and contents
    expect(screen.getByText(/Transparent Deductions Breakdown \(2 items\):/i)).toBeInTheDocument();
    expect(screen.getByText(/Thu, Sep 3, 2026/i)).toBeInTheDocument();
    expect(screen.getByText(/No attendance logged for standard workday/i)).toBeInTheDocument();
    expect(screen.getByText(/Fri, Sep 4, 2026/i)).toBeInTheDocument();
    expect(screen.getByText(/Incomplete hours: 4 hrs worked of 8 hrs \(4 hrs short\), 08:00 AM – 12:00 PM/i)).toBeInTheDocument();

    // Verify formula renders net pay correctly: 880 - 120 = 760 (not = 880),
    // once in the popup header and once in the formula; the table keeps its Net Pay cell.
    expect(within(breakdown).getAllByText(/PHP 760.00/i)).toHaveLength(2);
    expect(within(screen.getByRole("row", { name: /Maria Santos/ })).getByText("PHP 760.00")).toBeInTheDocument();

    await user.click(within(breakdown).getByRole("button", { name: /Close/i }));
    expect(screen.queryByRole("dialog", { name: /Calculation breakdown/i })).not.toBeInTheDocument();
  });

  it("renders backend payroll total deductions and net pay without recomputing them", () => {
    const backendRecord = record({
      grossCompensation: 1_000,
      totalDeductions: 420,
      netPay: 17,
      lateDeduction: 10,
      halfDayDeduction: 20,
      absenceDeduction: 30,
      sss: 40,
      phic: 50,
      hdmf: 60,
      salaryAdvance: 70,
    });

    renderWorkspace([backendRecord]);

    const payrollRow = screen.getByRole("row", { name: /Ada Lovelace/ });
    expect(within(payrollRow).getByText("PHP 420.00")).toBeInTheDocument();
    expect(within(payrollRow).getByText("PHP 17.00")).toBeInTheDocument();
  });

  it("sends halfDayFraction alongside halfDayCount and halfDayDeduction when EditPayrollDialog saves cutoff changes", async () => {
    const savePayrollCutoffSpy = vi.spyOn(api, "savePayrollCutoff").mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderWorkspace([
      record({
        status: "DRAFT",
        standardWorkingDays: 11,
        halfDayCount: 1,
        halfDayDeduction: 40,
      }),
    ]);

    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("dialog", { name: /Edit Payroll — Ada Lovelace/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Save Changes/i }));
    await waitFor(() => {
      expect(savePayrollCutoffSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          payrollId: "P-001",
          halfDayCount: 1,
          halfDayDeduction: 40,
          halfDayFraction: 0.5,
        }),
        "P-001",
      );
    });
  });

  it("shows zero deductions indicator when no attendance deductions exist", async () => {
    const user = userEvent.setup();
    const cleanIntern = internRecord({
      absenceDeduction: 0,
      lateDeduction: 0,
      halfDayDeduction: 0,
      grossCompensation: 880,
      netPay: 880,
      calculationBreakdown: JSON.stringify({ source: "attendance", deductions: [] }),
    });

    renderWorkspace([cleanIntern]);

    await user.click(screen.getByRole("button", { name: "Breakdown" }));

    expect(screen.getByText(/No attendance deductions incurred for this cutoff period/i)).toBeInTheDocument();
  });

  it("hides all-zero columns in the table but always lists every field in the Breakdown popup", async () => {
    const user = userEvent.setup();
    const { unmount } = renderWorkspace([
      internRecord(),
      internRecord({ payrollId: "P-INT-002", employeeId: "INT-002", employeeName: "Jose Reyes" }),
    ]);

    for (const heading of ["HRA", "Incentives", "Overtime", "SSS", "PhilHealth", "HDMF", "Advance", "TIN #", "Bank / A/C", "Dept / Role"]) {
      expect(screen.queryByRole("columnheader", { name: heading })).not.toBeInTheDocument();
    }
    for (const heading of ["Employee", "Paid Days", "Basic Pay", "Absent", "Net Pay"]) {
      expect(screen.getByRole("columnheader", { name: heading })).toBeInTheDocument();
    }

    await user.click(screen.getAllByRole("button", { name: "Breakdown" })[0]);
    const breakdown = screen.getByRole("dialog", { name: /Calculation breakdown — Maria Santos/i });
    for (const field of ["HRA", "Incentives", "Overtime", "SSS", "PhilHealth", "HDMF", "Advance", "TIN #", "Bank / A/C", "Dept / Role"]) {
      expect(within(breakdown).getByText(field, { selector: "dt" })).toBeInTheDocument();
    }
    unmount();

    // No See all while every row fits (jsdom has no layout, so nothing overflows).
    expect(screen.queryByRole("button", { name: /See all/ })).not.toBeInTheDocument();

    // One row with an SSS amount brings back just the SSS column.
    renderWorkspace([internRecord(), internRecord({ payrollId: "P-INT-003", employeeId: "INT-003", sss: 450 })]);
    expect(screen.getByRole("columnheader", { name: "SSS" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "PhilHealth" })).not.toBeInTheDocument();
  });

  it("shows See all when payroll rows overflow the capped table, and lifts the cap", async () => {
    class FakeResizeObserver {
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(1200);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(560);
    try {
      const user = userEvent.setup();
      renderWorkspace([
        internRecord(),
        internRecord({ payrollId: "P-INT-002", employeeId: "INT-002", employeeName: "Jose Reyes" }),
      ]);
      const tableBox = screen.getByRole("table").closest(".table-wrap");
      expect(tableBox).not.toHaveClass("is-expanded");

      await user.click(screen.getByRole("button", { name: "See all" }));
      expect(tableBox).toHaveClass("is-expanded");

      await user.click(screen.getByRole("button", { name: "Show less" }));
      expect(tableBox).not.toHaveClass("is-expanded");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
