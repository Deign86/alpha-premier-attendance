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

describe("PayrollWorkspace", () => {
  let generatePayrollCutoffSpy: MockInstance;
  let generatePayrollPdfSpy: MockInstance;
  let generateInternPayslipImagesSpy: MockInstance;
  let openGeneratedDirectorySpy: MockInstance;
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

    // A one-day cutoff is allowed.
    fireEvent.change(screen.getByLabelText("Cutoff end"), { target: { value: "2026-08-01" } });
    expect(generate).toBeEnabled();
    expect(generate).not.toHaveAccessibleDescription();
    expect(screen.queryByText("End date must be on or after the start date.")).not.toBeInTheDocument();
  });

  it("moves the chosen half-month with the cutoff month", () => {
    renderWorkspace([]);
    fireEvent.change(screen.getByLabelText("Cutoff month"), { target: { value: "2026-09" } });
    expect(screen.getByLabelText("Cutoff start")).toHaveValue("2026-09-01");
    expect(screen.getByLabelText("Cutoff end")).toHaveValue("2026-09-15");
    expect(screen.getByRole("button", { name: /1st.*15th/i })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows the payroll steps for the chosen cutoff, the current one marked", async () => {
    // "Cutoff:done", "Review:current", …: done steps read "(done)", the current one has aria-current="step".
    const steps = () =>
      within(screen.getByRole("list", { name: "Payroll steps" }))
        .getAllByRole("listitem")
        .map((step) => {
          const text = step.textContent ?? "";
          const state = step.getAttribute("aria-current") === "step" ? "current" : text.includes("(done)") ? "done" : "upcoming";
          return `${text.replace(/\d| \(done\)/g, "")}:${state}`;
        });
    const draft = (id: string) => internRecord({ payrollId: id, status: "DRAFT" });
    const final = (id: string) => internRecord({ payrollId: id, status: "FINALIZED" });
    const julyDraft = internRecord({ payrollId: "JUL", status: "DRAFT", cutoffStart: "2026-07-16", cutoffEnd: "2026-07-31" });
    const cases: [PayrollCutoffRecord[], PayrollPdfRecord[], string[]][] = [
      // Not generated yet, or any draft left (even with some finalized): Review.
      [[], [], ["Cutoff:done", "Review:current", "Finalize:upcoming", "Export:upcoming"]],
      [[draft("A"), draft("B")], [], ["Cutoff:done", "Review:current", "Finalize:upcoming", "Export:upcoming"]],
      [[final("A"), draft("B")], [], ["Cutoff:done", "Review:current", "Finalize:upcoming", "Export:upcoming"]],
      // A PDF made while drafts remain doesn't tick Export: steps after the current one stay upcoming.
      [[final("A"), draft("B")], [pdfRecord()], ["Cutoff:done", "Review:current", "Finalize:upcoming", "Export:upcoming"]],
      // All finalized: Export. A draft of another cutoff doesn't count.
      [[final("A"), final("B"), julyDraft], [], ["Cutoff:done", "Review:done", "Finalize:done", "Export:current"]],
    ];
    for (const [records, pdfs, expected] of cases) {
      loadPayrollPdfsSpy.mockResolvedValue({ success: true, payrollPdfs: pdfs });
      const { unmount } = renderWorkspace(records);
      // The PDF list has loaded once the cutoff's PDFs (if any) are listed beside the export buttons.
      await (pdfs.length ? screen.findByRole("list", { name: "PDFs for Aug 1–15, 2026" }) : screen.findByText("No PDF for this cutoff yet."));
      expect(steps()).toEqual(expected);
      unmount();
    }
    // Empty dates: Cutoff is the current step.
    renderWorkspace([final("A")]);
    fireEvent.change(screen.getByLabelText("Cutoff start"), { target: { value: "" } });
    expect(steps()).toEqual(["Cutoff:current", "Review:upcoming", "Finalize:upcoming", "Export:upcoming"]);
  });

  it("ticks Export once a PDF exists for the chosen cutoff, leaving no step current when all are done", async () => {
    loadPayrollPdfsSpy.mockResolvedValue({ success: true, payrollPdfs: [pdfRecord()] });
    renderWorkspace([internRecord({ status: "FINALIZED" })]);
    const list = screen.getByRole("list", { name: "Payroll steps" });
    await waitFor(() => expect(within(list).getAllByText("(done)", { exact: false })).toHaveLength(4));
    expect(within(list).queryByRole("listitem", { current: "step" })).not.toBeInTheDocument();
  });

  it("shows the intern payroll PDF and payslip actions and no print/export actions", () => {
    renderWorkspace([record()]);
    expect(screen.getByRole("button", { name: "Download payroll PDF" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate Employee Payroll PDF" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate from attendance" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download payslips" })).toBeInTheDocument();
    // No register, CSV/XLSX, or browser print actions.
    expect(screen.queryByRole("button", { name: /export/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /register/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /print payroll$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /csv|xlsx|excel/i })).not.toBeInTheDocument();
  });

  it("generates an intern payroll PDF for the selected cutoff and shows the link list", async () => {
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
    await user.click(screen.getByRole("button", { name: "Download payroll PDF" }));

    await waitFor(() =>
      expect(generatePayrollPdfSpy).toHaveBeenCalledWith({
        cutoffStart: "2026-08-01",
        cutoffEnd: "2026-08-15",
        payrollCutoffLabel: "August 1-15, 2026",
        workerType: "intern",
      }),
    );
    // A routine result: a toast with the cutoff in the shared date style.
    expect(
      await screen.findByText("Payroll PDF generated for Aug 1–15, 2026."),
    ).toBeInTheDocument();
    // The new PDF shows beside the export buttons and in the history.
    const cutoffList = screen.getByRole("list", { name: "PDFs for Aug 1–15, 2026" });
    expect(within(cutoffList).getByRole("button", { name: "Open PDF" })).toBeInTheDocument();
    expect(within(cutoffList).getByRole("button", { name: "Show in Folder" })).toBeInTheDocument();
    const history = screen.getByRole("region", { name: "Generated payroll PDFs" });
    expect(within(history).getByText("August 1-15, 2026")).toBeInTheDocument();
    expect(within(history).getByRole("button", { name: "Open PDF" })).toBeInTheDocument();
    expect(within(history).getByRole("button", { name: "Show in Folder" })).toBeInTheDocument();
    expect(screen.getAllByText("PHP 770.00").length).toBeGreaterThan(0);
    expect(window.print).not.toHaveBeenCalled();
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
    await user.click(screen.getByRole("button", { name: "Download payroll PDF" }));

    await waitFor(() =>
      expect(generatePayrollPdfSpy).toHaveBeenCalledWith({
        cutoffStart: "2026-08-01",
        cutoffEnd: "2026-08-15",
        payrollCutoffLabel: "August 1-15, 2026",
        workerType: "intern",
      }),
    );
    expect(
      await screen.findByText("Payroll PDF generated for Aug 1–15, 2026."),
    ).toBeInTheDocument();
  });

  it("shows backend errors and never opens the browser print dialog", async () => {
    generatePayrollPdfSpy.mockResolvedValue({
      success: false,
      error: { message: "Unable to generate the payroll PDF." },
    });
    const user = userEvent.setup();
    renderWorkspace([internRecord()]);
    await user.click(screen.getByRole("button", { name: "Download payroll PDF" }));
    expect(
      await screen.findByText("Unable to generate the payroll PDF."),
    ).toBeInTheDocument();
    expect(window.print).not.toHaveBeenCalled();
  });

  it("keeps Download payroll PDF and Download payslips off, with the reason, until the chosen cutoff has payroll", async () => {
    const user = userEvent.setup();
    // Only another cutoff (Jul 16–31) has payroll: the pre-filled Aug 1–15 has none.
    const { unmount } = renderWorkspace([internRecord({ cutoffStart: "2026-07-16", cutoffEnd: "2026-07-31", payrollCutoffLabel: "July 16-31, 2026" })]);
    for (const name of ["Download payroll PDF", "Download payslips"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription("Generate payroll for this cutoff first.");
      await user.click(button);
    }
    expect(generatePayrollPdfSpy).not.toHaveBeenCalled();
    expect(generateInternPayslipImagesSpy).not.toHaveBeenCalled();
    expect(window.print).not.toHaveBeenCalled();

    // Picking that cutoff turns them on, with no reason line.
    await user.click(screen.getByRole("button", { name: /16th.*last day/i }));
    fireEvent.change(screen.getByLabelText("Cutoff month"), { target: { value: "2026-07" } });
    expect(screen.getByRole("button", { name: "Download payroll PDF" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Download payslips" })).toBeEnabled();
    expect(screen.queryByText("Generate payroll for this cutoff first.")).not.toBeInTheDocument();
    unmount();

    // With no cutoff dates the reason says so.
    renderWorkspace([internRecord()]);
    fireEvent.change(screen.getByLabelText("Cutoff start"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Download payroll PDF" })).toHaveAccessibleDescription("Pick a cutoff start and end date.");
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
    await user.click(screen.getByRole("button", { name: "Download payslips" }));

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
    await user.click(screen.getByRole("button", { name: "Download payslips" }));
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
    await user.click(screen.getByRole("button", { name: "Download payslips" }));
    expect(await screen.findByText("Unable to generate the payslips.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open payslip folder" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download payslips" })).toBeEnabled();
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
    await user.click(screen.getByRole("button", { name: "Download payslips" }));

    const busyButton = screen.getByRole("button", { name: "Generating payslips..." });
    expect(busyButton).toBeDisabled();
    await user.click(busyButton);
    expect(generateInternPayslipImagesSpy).toHaveBeenCalledTimes(1);

    finish({ success: false, error: { message: "Unable to generate the payslips." } });
    expect(await screen.findByRole("button", { name: "Download payslips" })).toBeEnabled();
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

    const history = screen.getByRole("region", { name: "Generated payroll PDFs" });
    expect(await within(history).findByText("August 1-15, 2026")).toBeInTheDocument();
    expect(within(history).getAllByRole("button", { name: "Open PDF" })).toHaveLength(1);
    expect(within(history).getAllByRole("button", { name: "Show in Folder" })).toHaveLength(1);
    expect(screen.queryByText("Employee")).not.toBeInTheDocument();
    expect(screen.getAllByText("Intern")).toHaveLength(1);
    expect(window.print).not.toHaveBeenCalled();
  });

  it("says the next step when there is no payroll and no PDF yet", async () => {
    renderWorkspace([]);
    expect(
      await screen.findByText("No PDFs yet. Finalize the cutoff, then Download payroll PDF."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No payroll for this cutoff yet. Pick a cutoff above, then select Generate from attendance."),
    ).toBeInTheDocument();
    expect(screen.getByText("No PDF for this cutoff yet.")).toBeInTheDocument();
    expect(screen.queryByText(/No cutoff payroll has been created/)).not.toBeInTheDocument();
  });

  it("lists the chosen cutoff's PDFs beside the export buttons, newest first, and keeps the full history", async () => {
    const openSpy = vi.spyOn(api, "openGeneratedFile").mockResolvedValue({ ok: false, message: "The file could not be found." });
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
    renderWorkspace([internRecord()]);

    const cutoffList = await screen.findByRole("list", { name: "PDFs for Aug 1–15, 2026" });
    const rows = within(cutoffList).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Aug 17, 2026, 8:40 AMOpen PDFShow in Folder",
      "Aug 16, 2026, 9:05 AMOpen PDFShow in Folder",
    ]);
    await user.click(within(rows[0]).getByRole("button", { name: "Open PDF" }));
    expect(openSpy).toHaveBeenCalledWith("C:\\data\\exports\\aug-late.pdf");
    expect(await screen.findByText("The file could not be found.")).toBeInTheDocument();

    // The history at the bottom still has every PDF, grouped by month.
    const history = screen.getByRole("region", { name: "Generated payroll PDFs" });
    expect(within(history).getByRole("button", { name: /August 2026\s*2/ })).toHaveAttribute("aria-expanded", "true");
    expect(within(history).getByRole("button", { name: /July 2026\s*1/ })).toBeInTheDocument();

    // Another cutoff with no PDF says so.
    await user.click(screen.getByRole("button", { name: /16th.*last day/i }));
    expect(screen.queryByRole("list", { name: /PDFs for/ })).not.toBeInTheDocument();
    expect(screen.getByText("PDFs for Aug 16–31, 2026")).toBeInTheDocument();
    expect(screen.getByText("No PDF for this cutoff yet.")).toBeInTheDocument();
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
    const stdDaysInput = screen.getByLabelText(/Standard days/i);
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

    expect(screen.getByText(/Total records: 2/i)).toBeInTheDocument();
    const masterCheckbox = screen.getByRole("checkbox", { name: /Select all payroll records/i });
    expect(masterCheckbox).not.toBeChecked();

    // Select all via master checkbox
    await user.click(masterCheckbox);
    expect(masterCheckbox).toBeChecked();
    expect(await screen.findByText(/2 of 2 payroll record\(s\) selected/i)).toBeInTheDocument();

    // Trigger batch delete
    const batchDeleteBtn = screen.getByRole("button", { name: /Delete selected \(2\)/i });
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
    expect(await screen.findByText(/1 of 2 payroll record\(s\) selected/i)).toBeInTheDocument();

    const finalizeSelectedBtn = screen.getByRole("button", { name: /Finalize selected \(1\)/i });
    await user.click(finalizeSelectedBtn);

    expect(screen.getByRole("dialog", { name: "Finalize selected payrolls?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Finalize payrolls" }));
    await waitFor(() => {
      expect(finalizePayrollCutoffSpy).toHaveBeenCalledWith("P-001");
    });
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
    await user.click(screen.getByRole("button", { name: /Finalize selected \(2\)/i }));
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

  it("shows cutoff duplicate banner and allows clearing all records for that cutoff", async () => {
    const deletePayrollCutoffSpy = vi.spyOn(api, "deletePayrollCutoff").mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderWorkspace([
      record({ payrollId: "P-001", cutoffStart: "2026-08-01", cutoffEnd: "2026-08-15", status: "DRAFT" }),
    ]);

    await user.click(screen.getByRole("button", { name: /1st.*15th/i }));

    const clearCutoffBtn = await screen.findByRole("button", { name: /Delete all records for this cutoff \(1\)/i });
    expect(clearCutoffBtn).toBeInTheDocument();

    await user.click(clearCutoffBtn);
    expect(screen.getByRole("dialog", { name: "Delete cutoff records?" })).toBeInTheDocument();
    expect(screen.getByText(/This will permanently delete all 1 payroll record\(s\) for Aug 1–15, 2026/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete cutoff records" }));
    await waitFor(() => {
      expect(deletePayrollCutoffSpy).toHaveBeenCalledWith("P-001");
    });
  });

  it("shows the regenerate banner only while drafts exist, and a calm line once every record is finalized", async () => {
    const deletePayrollCutoffSpy = vi.spyOn(api, "deletePayrollCutoff").mockResolvedValue({ success: true });
    const user = userEvent.setup();

    // No payroll for the cutoff: neither.
    let view = renderWorkspace([]);
    expect(screen.queryByText(/Payroll already exists for this cutoff/)).not.toBeInTheDocument();
    expect(screen.queryByText(/for this cutoff (is|are) finalized/)).not.toBeInTheDocument();
    view.unmount();

    // Drafts (one finalized too): the banner with Delete all.
    view = renderWorkspace([internRecord({ payrollId: "A", status: "DRAFT" }), internRecord({ payrollId: "B", status: "FINALIZED" })]);
    expect(screen.getByText(/Payroll already exists for this cutoff \(2 record\(s\)\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete all records for this cutoff (2)" })).toBeInTheDocument();
    expect(screen.queryByText(/for this cutoff (is|are) finalized/)).not.toBeInTheDocument();
    view.unmount();

    // All finalized: one calm line; deleting says approved pay goes too and asks for DELETE.
    renderWorkspace([internRecord({ payrollId: "A" }), internRecord({ payrollId: "B" })]);
    expect(screen.queryByText(/Payroll already exists for this cutoff/)).not.toBeInTheDocument();
    expect(screen.getByText("All 2 records for this cutoff are finalized.")).toBeInTheDocument();
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
    /** Generate (as a regenerate, so nothing is deleted), then both exports, for the dates on screen. */
    const runAll = async () => {
      await user.click(screen.getByRole("button", { name: "Generate from attendance" }));
      await user.click(screen.getByRole("button", { name: "Regenerate payroll" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await user.click(screen.getByRole("button", { name: "Download payroll PDF" }));
      await user.click(screen.getByRole("button", { name: "Download payslips" }));
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

  it("keeps Generate and the exports off with a reason while the payroll list loads or after it failed", () => {
    const { rerender } = render(<PayrollWorkspace records={[]} onSaved={vi.fn()} loadStatus="loading" onRetry={vi.fn()} />);
    for (const name of ["Generate from attendance", "Download payroll PDF", "Download payslips"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
      expect(screen.getByRole("button", { name })).toHaveAccessibleDescription("Loading payroll…");
    }
    rerender(<PayrollWorkspace records={[]} onSaved={vi.fn()} loadStatus="failed" onRetry={vi.fn()} />);
    for (const name of ["Generate from attendance", "Download payroll PDF", "Download payslips"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
      expect(screen.getByRole("button", { name })).toHaveAccessibleDescription("Payroll didn't load. Select Retry below.");
    }
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
    // The dates themselves are fine: Cutoff stays done.
    expect(within(screen.getByRole("list", { name: "Payroll steps" })).getAllByRole("listitem")[0]).toHaveTextContent("(done)");
  });

  it("shows the chosen cutoff's records, or every cutoff's with a Period column, and acts on the rows shown", async () => {
    const deletePayrollCutoffSpy = vi.spyOn(api, "deletePayrollCutoff").mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderWorkspace([
      internRecord({ payrollId: "AUG", employeeName: "Maria Santos", status: "DRAFT" }),
      internRecord({ payrollId: "JUL", employeeName: "Jose Reyes", status: "DRAFT", cutoffStart: "2026-07-16", cutoffEnd: "2026-07-31", payrollCutoffLabel: "July 16-31, 2026" }),
    ]);

    // Aug 1–15 only: Jose's July row is hidden and there is no Period column.
    expect(screen.getByText("Total records: 1")).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Maria Santos/ })).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /Jose Reyes/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Period" })).not.toBeInTheDocument();

    // Every cutoff: both rows, each with its period.
    await user.click(screen.getByRole("button", { name: "Show all cutoffs (2)" }));
    expect(screen.getByText("Total records: 2")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Period" })).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /Jose Reyes/ })).getByText("Jul 16–31, 2026")).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /Maria Santos/ })).getByText("Aug 1–15, 2026")).toBeInTheDocument();

    // Select all picks the rows shown; going back to this cutoff drops the hidden July row from the selection.
    await user.click(screen.getByRole("checkbox", { name: /Select all payroll records/i }));
    expect(screen.getByText(/2 of 2 payroll record\(s\) selected/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show this cutoff only" }));
    expect(screen.queryByRole("row", { name: /Jose Reyes/ })).not.toBeInTheDocument();
    expect(await screen.findByText(/1 of 1 payroll record\(s\) selected/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Delete selected \(1\)/ }));
    await user.click(screen.getByRole("button", { name: "Delete payrolls" }));
    await waitFor(() => expect(deletePayrollCutoffSpy).toHaveBeenCalledWith("AUG"));
    expect(deletePayrollCutoffSpy).not.toHaveBeenCalledWith("JUL");
  });

  it("offers every cutoff from the empty table when the chosen cutoff has no payroll", async () => {
    const user = userEvent.setup();
    renderWorkspace([internRecord({ cutoffStart: "2026-07-16", cutoffEnd: "2026-07-31", payrollCutoffLabel: "July 16-31, 2026" })]);
    expect(screen.getByText("No payroll for this cutoff yet. Pick a cutoff above, then select Generate from attendance.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show all cutoffs (1)" }));
    expect(screen.getByRole("row", { name: /Maria Santos/ })).toBeInTheDocument();
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
    for (const heading of ["Employee Name", "Paid Days", "Basic Pay", "Absent", "Net Pay"]) {
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

      await user.click(screen.getByRole("button", { name: "See all (2)" }));
      expect(tableBox).toHaveClass("is-expanded");

      await user.click(screen.getByRole("button", { name: "Show less" }));
      expect(tableBox).not.toHaveClass("is-expanded");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
