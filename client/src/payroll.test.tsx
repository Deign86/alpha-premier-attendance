import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  PayrollCalculationProfile,
  PayrollCutoffRecord,
  PayrollPdfRecord,
} from "@rfid-attendance/shared";

import * as api from "./api";
import { PayrollWorkspace } from "./App";

const profiles: PayrollCalculationProfile[] = [{
  profileId: "BEA_STANDARD",
  label: "Bea standard",
  payrollFrequency: "SEMI_MONTHLY",
  standardWorkingDaysPerCutoff: 11,
  incentivesAllowance: 0,
  specialAllowance: 0,
  specialHolidayMultiplier: 0.3,
  regularHolidayMultiplier: 1,
  halfDayFraction: 0.5,
  overtimeRate: 0,
}];

function record(overrides: Partial<PayrollCutoffRecord> = {}): PayrollCutoffRecord {
  return {
    payrollId: "P-001", employeeId: "EMP-001", employeeName: "Ada Lovelace", employeeType: "EMPLOYEE",
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
  return record({
    payrollId: "P-INT-001", employeeId: "INT-001", employeeName: "Maria Santos", employeeType: "INTERN",
    payrollProfileId: "INTERN_STANDARD", dailyRate: 80, basicPay: 800, totalCompensation: 800,
    lateUnits: 3, lateDeduction: 30, grossCompensation: 770, netPay: 770,
    ...overrides,
  });
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
    workerType: "employee",
    generatedAt: "2026-08-14T10:30:00+08:00",
    employeeCount: 1,
    totalAmount: 5500,
    sizeBytes: 1024,
    ...overrides,
  };
}

function renderWorkspace(records: PayrollCutoffRecord[]) {
  return render(
    <PayrollWorkspace users={[]} profiles={profiles} records={records} onSaved={vi.fn()} />,
  );
}

describe("PayrollWorkspace", () => {
  let generatePayrollCutoffSpy: MockInstance;
  let generatePayrollPdfSpy: MockInstance;
  let loadPayrollPdfsSpy: MockInstance;

  beforeEach(() => {
    window.print = vi.fn();
    generatePayrollCutoffSpy = vi.spyOn(api, 'generatePayrollCutoff');
    generatePayrollPdfSpy = vi.spyOn(api, 'generatePayrollPdf');
    loadPayrollPdfsSpy = vi.spyOn(api, 'loadPayrollPdfs').mockResolvedValue({ success: true, payrollPdfs: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("generates payroll from a selected cutoff and shows backend errors", async () => {
    generatePayrollCutoffSpy.mockRejectedValueOnce("Unable to generate payroll.");
    const user = userEvent.setup();
    render(<PayrollWorkspace users={[{
      userId: "EMP-1", rfidUid: "ABCD1234", fullName: "Ada Lovelace", department: null, status: "ACTIVE",
      employeeType: "EMPLOYEE", gender: null, dailyRate: 500, payrollProfileId: "BEA_STANDARD", photoUrl: null,
    }]} profiles={profiles} records={[]} onSaved={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /1st.*15th/i }));
    await user.click(screen.getByRole("button", { name: "Generate from attendance" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /confirm/i }));
    expect(await screen.findByText("Unable to generate payroll.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate from attendance" })).toBeEnabled();
    expect(generatePayrollCutoffSpy).toHaveBeenCalledWith("2026-08-01", "2026-08-15", "August 1-15, 2026");
  });

  it("shows exactly the two generate payroll PDF buttons and no print/export actions", () => {
    renderWorkspace([record()]);
    expect(screen.getByRole("button", { name: "Generate Employee Payroll PDF" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate Intern Payroll PDF" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate from attendance" })).toBeInTheDocument();
    // No payslip, register, CSV/XLSX, or browser print actions.
    expect(screen.queryByRole("button", { name: /payslip/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /export/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /register/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /print payroll$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /csv|xlsx|excel/i })).not.toBeInTheDocument();
  });

  it("generates an employee payroll PDF for the selected cutoff and shows the link list", async () => {
    const pdf = pdfRecord();
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
    await user.click(screen.getByRole("button", { name: "Generate Employee Payroll PDF" }));

    await waitFor(() =>
      expect(generatePayrollPdfSpy).toHaveBeenCalledWith({
        cutoffStart: "2026-08-01",
        cutoffEnd: "2026-08-15",
        payrollCutoffLabel: "August 1-15, 2026",
        workerType: "employee",
      }),
    );
    expect(
      await screen.findByText("Payroll PDF generated for August 1-15, 2026."),
    ).toBeInTheDocument();
    // The period appears both in the saved payroll table and the PDF history.
    expect(screen.getAllByText("August 1-15, 2026").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Open PDF" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show in Folder" })).toBeInTheDocument();
    // The employee PDF total is the employee gross only (appears in the PDF
    // history list alongside the saved payroll table values).
    expect(screen.getAllByText("PHP 5,500.00").length).toBeGreaterThan(0);
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
      await screen.findByText("Payroll PDF generated for August 1-15, 2026."),
    ).toBeInTheDocument();
  });

  it("shows backend errors and never opens the browser print dialog", async () => {
    generatePayrollPdfSpy.mockResolvedValue({
      success: false,
      error: { message: "Unable to generate the payroll PDF." },
    });
    const user = userEvent.setup();
    renderWorkspace([record()]);
    await user.click(screen.getByRole("button", { name: "Generate Employee Payroll PDF" }));
    expect(
      await screen.findByText("Unable to generate the payroll PDF."),
    ).toBeInTheDocument();
    expect(window.print).not.toHaveBeenCalled();
  });

  it("shows a message instead of generating when there are no records", async () => {
    const user = userEvent.setup();
    renderWorkspace([]);
    await user.click(screen.getByRole("button", { name: "Generate Employee Payroll PDF" }));
    expect(
      screen.getByText("No payroll records to generate. Create and save a payroll first."),
    ).toBeInTheDocument();
    expect(generatePayrollPdfSpy).not.toHaveBeenCalled();
    expect(window.print).not.toHaveBeenCalled();
  });

  it("lists previously generated payroll PDFs with open and reveal actions", async () => {
    const employeePdf = pdfRecord();
    const internPdf = pdfRecord({
      payrollPdfId: "payroll-2026-08-14_10-31-00_intern",
      fileName: "payroll-2026-08-14_10-31-00_intern.pdf",
      filePath: "C:\\data\\exports\\payroll-2026-08-14_10-31-00_intern.pdf",
      workerType: "intern",
      totalAmount: 770,
    });
    loadPayrollPdfsSpy.mockResolvedValue({
      success: true,
      payrollPdfs: [employeePdf, internPdf],
    });
    renderWorkspace([record(), internRecord()]);

    // The period label appears in the PDF history rows (the saved payroll
    // table renders it too, so exact-match queries would be ambiguous).
    expect(await screen.findAllByText("August 1-15, 2026")).not.toHaveLength(0);
    expect(screen.getAllByRole("button", { name: "Open PDF" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Show in Folder" })).toHaveLength(2);
    expect(screen.getAllByText("Employee")).toHaveLength(1);
    expect(screen.getAllByText("Intern")).toHaveLength(1);
    expect(window.print).not.toHaveBeenCalled();
  });

  it("shows an empty state when no payroll PDFs exist", async () => {
    renderWorkspace([]);
    expect(
      await screen.findByText("No payroll PDFs have been generated yet."),
    ).toBeInTheDocument();
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

  it("blocks duplicate cutoff generation", async () => {
    const user = userEvent.setup();
    renderWorkspace([record({ status: "DRAFT" })]);
    await user.click(screen.getByRole("button", { name: /1st.*15th/i }));
    await user.click(screen.getByRole("button", { name: "Generate from attendance" }));
    expect(screen.getByText(/Duplicate generation was blocked/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(generatePayrollCutoffSpy).not.toHaveBeenCalled();
  });

  it("opens the edit dialog on a draft record and saves updated earnings and deductions", async () => {
    const savePayrollCutoffSpy = vi.spyOn(api, "savePayrollCutoff").mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderWorkspace([record({ status: "DRAFT" })]);

    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("dialog", { name: /Edit Payroll — Ada Lovelace/i })).toBeInTheDocument();

    const hraInput = screen.getByLabelText("HRA");
    const sssInput = screen.getByLabelText("SSS Employee Share");
    await user.clear(hraInput);
    await user.type(hraInput, "500");
    await user.clear(sssInput);
    await user.type(sssInput, "450");

    await user.click(screen.getByRole("button", { name: /Save Changes/i }));
    await waitFor(() => {
      expect(savePayrollCutoffSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          payrollId: "P-001",
          hra: 500,
          sss: 450,
        }),
        "P-001",
      );
    });
  });
});
