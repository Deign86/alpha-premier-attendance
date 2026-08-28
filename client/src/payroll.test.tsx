import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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
    <PayrollWorkspace
      users={[
        {
          userId: "EMP-001",
          rfidUid: "E001",
          fullName: "Ada Lovelace",
          department: "Engineering",
          status: "ACTIVE",
          employeeType: "EMPLOYEE",
          gender: "FEMALE",
          dailyRate: 500,
          payrollProfileId: "BEA_STANDARD",
          photoUrl: null,
        },
        {
          userId: "INT-001",
          rfidUid: "I001",
          fullName: "Maria Santos",
          department: "Marketing",
          status: "ACTIVE",
          employeeType: "INTERN",
          gender: "FEMALE",
          dailyRate: null,
          payrollProfileId: "INTERN_STANDARD",
          photoUrl: null,
        },
      ]}
      profiles={profiles}
      records={records}
      onSaved={vi.fn()}
    />,
  );
}

describe("PayrollWorkspace", () => {
  let generatePayrollCutoffSpy: MockInstance;
  let generatePayrollPdfSpy: MockInstance;
  let loadPayrollPdfsSpy: MockInstance;

  beforeEach(() => {
    window.print = vi.fn();
    generatePayrollCutoffSpy = vi.spyOn(api, "generatePayrollCutoff");
    generatePayrollPdfSpy = vi.spyOn(api, "generatePayrollPdf");
    loadPayrollPdfsSpy = vi.spyOn(api, "loadPayrollPdfs").mockResolvedValue({ success: true, payrollPdfs: [] });
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
    expect(generatePayrollCutoffSpy).toHaveBeenCalledWith("2026-08-01", "2026-08-15", "August 1-15, 2026", { standardWorkingDays: 10 });
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

  it("prompts for replacement confirmation when generating for an existing cutoff", async () => {
    const deletePayrollCutoffSpy = vi.spyOn(api, "deletePayrollCutoff").mockResolvedValue({ success: true });
    generatePayrollCutoffSpy.mockResolvedValueOnce({ success: true });
    const user = userEvent.setup();
    renderWorkspace([record({ payrollId: "P-001", status: "DRAFT" })]);
    await user.click(screen.getByRole("button", { name: /1st.*15th/i }));
    await user.click(screen.getByRole("button", { name: "Generate from attendance" }));
    expect(screen.getByRole("dialog", { name: "Regenerate cutoff payroll?" })).toBeInTheDocument();
    expect(screen.getByText(/Generating new payroll will replace these existing records with fresh calculations/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Confirm/i }));
    await waitFor(() => {
      expect(deletePayrollCutoffSpy).toHaveBeenCalledWith("P-001");
      expect(generatePayrollCutoffSpy).toHaveBeenCalledWith("2026-08-01", "2026-08-15", "August 1-15, 2026", { standardWorkingDays: 10 });
    });
  });

  it("opens the edit dialog on a draft record and saves updated earnings and deductions", async () => {
    const savePayrollCutoffSpy = vi.spyOn(api, "savePayrollCutoff").mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderWorkspace([record({ status: "DRAFT", standardWorkingDays: 11 })]);

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
          standardWorkingDays: 11,
          hra: 500,
          sss: 450,
        }),
        "P-001",
      );
    });
  });

  it("allows globally editing standard working days to recalculate and batch update draft payroll records", async () => {
    const savePayrollCutoffSpy = vi.spyOn(api, "savePayrollCutoff").mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderWorkspace([
      record({
        payrollId: "P-001",
        status: "DRAFT",
        standardWorkingDays: 11,
        actualWorkingDays: 10,
        dailyRate: 500,
      }),
      internRecord({
        payrollId: "P-INT-001",
        status: "DRAFT",
        standardWorkingDays: 11,
        actualWorkingDays: 10,
        dailyRate: 80,
      }),
    ]);

    const globalStdDaysInput = screen.getByLabelText(/Cutoff standard working days/i);
    expect(globalStdDaysInput).toHaveValue(11);

    await user.clear(globalStdDaysInput);
    await user.type(globalStdDaysInput, "10");

    await user.click(screen.getByRole("button", { name: /Apply to All Drafts/i }));

    await waitFor(() => {
      expect(savePayrollCutoffSpy).toHaveBeenCalledTimes(2);
      expect(savePayrollCutoffSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          payrollId: "P-001",
          standardWorkingDays: 10,
          basicPay: 5000,
          absentDays: 0,
          absenceDeduction: 0,
        }),
        "P-001",
      );
      expect(savePayrollCutoffSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          payrollId: "P-INT-001",
          standardWorkingDays: 10,
          basicPay: 800,
          absentDays: 0,
          absenceDeduction: 0,
        }),
        "P-INT-001",
      );
    });
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

    await user.click(screen.getByRole("button", { name: /Confirm/i }));
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

    await user.click(screen.getByRole("button", { name: /Confirm/i }));
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
    await user.click(screen.getByRole("button", { name: /Confirm/i }));
    await waitFor(() => {
      expect(finalizePayrollCutoffSpy).toHaveBeenCalledWith("P-001");
    });
  });

  it("shows cutoff duplicate banner and allows clearing all records for that cutoff", async () => {
    const deletePayrollCutoffSpy = vi.spyOn(api, "deletePayrollCutoff").mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderWorkspace([
      record({ payrollId: "P-001", cutoffStart: "2026-08-01", cutoffEnd: "2026-08-15" }),
    ]);

    await user.click(screen.getByRole("button", { name: /1st.*15th/i }));

    const clearCutoffBtn = await screen.findByRole("button", { name: /Delete all records for this cutoff \(1\)/i });
    expect(clearCutoffBtn).toBeInTheDocument();

    await user.click(clearCutoffBtn);
    expect(screen.getByRole("dialog", { name: "Delete cutoff records?" })).toBeInTheDocument();
    expect(screen.getByText(/This will permanently delete all 1 payroll record\(s\) for cutoff 2026-08-01 through 2026-08-15/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Confirm/i }));
    await waitFor(() => {
      expect(deletePayrollCutoffSpy).toHaveBeenCalledWith("P-001");
    });
  });
});
