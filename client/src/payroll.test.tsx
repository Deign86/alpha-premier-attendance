import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PayrollCalculationProfile, PayrollCutoffRecord } from "@rfid-attendance/shared";

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return { ...actual, savePayrollCutoff: vi.fn() };
});

import { savePayrollCutoff } from "./api";
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
    manualAdjustment: 0, adjustmentReason: null, grossCompensation: 5500, netPay: 5500, signaturePlaceholder: "",
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

/** Renders the PayrollWorkspace and returns the printed sheet table (if any). */
function renderWorkspace(records: PayrollCutoffRecord[]) {
  return render(
    <PayrollWorkspace users={[]} profiles={profiles} records={records} onSaved={vi.fn()} />,
  );
}

function sheetTable(container: HTMLElement): HTMLElement {
  const sheet = container.querySelector(".payroll-sheet-table");
  expect(sheet).not.toBeNull();
  return sheet as HTMLElement;
}

function sheetTotalRow(container: HTMLElement): HTMLElement {
  const row = container.querySelector(".payroll-sheet-total");
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

describe("PayrollWorkspace", () => {
  beforeEach(() => {
    window.print = vi.fn();
    vi.mocked(savePayrollCutoff).mockReset();
  });

  it("releases the save button and shows backend errors", async () => {
    vi.mocked(savePayrollCutoff).mockRejectedValueOnce("Employee and valid cutoff dates are required.");
    const user = userEvent.setup();
    render(<PayrollWorkspace users={[{
      userId: "EMP-1", rfidUid: "ABCD1234", fullName: "Ada Lovelace", department: null, status: "ACTIVE",
      employeeType: "EMPLOYEE", gender: null, dailyRate: 500, payrollProfileId: "BEA_STANDARD", photoUrl: null,
    }]} profiles={profiles} records={[]} onSaved={vi.fn()} />);
    await user.selectOptions(screen.getByLabelText("Personnel"), "EMP-1");
    await user.click(screen.getByRole("button", { name: /1st.*15th/i }));
    await user.click(screen.getByRole("button", { name: "Save cutoff payroll" }));
    expect(await screen.findByText("Employee and valid cutoff dates are required.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save cutoff payroll" })).toBeEnabled();
  });

  it("shows exactly the two required payroll print buttons and no payslip/export actions", () => {
    renderWorkspace([record()]);
    expect(screen.getByRole("button", { name: "Print Employee Payroll" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Print Intern Payroll" })).toBeInTheDocument();
    // No individual payslip, register, CSV/XLSX/PDF, or other payroll print actions.
    expect(screen.queryByRole("button", { name: /payslip/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /export/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /register/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /print payroll$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /pdf|csv|xlsx|excel/i })).not.toBeInTheDocument();
  });

  it("prints one employee payroll sheet excluding interns", async () => {
    const user = userEvent.setup();
    const { container } = renderWorkspace([record(), internRecord()]);
    await user.click(screen.getByRole("button", { name: "Print Employee Payroll" }));

    const sheet = sheetTable(container);
    expect(within(sheet).getByText("Ada Lovelace")).toBeInTheDocument();
    expect(within(sheet).queryByText("Maria Santos")).not.toBeInTheDocument();
    const employeeCells = sheet.querySelectorAll("tbody tr:not(.payroll-sheet-total) td");
    expect(employeeCells[2]).toHaveTextContent("PHP 5,500.00");
    // Exact reference column set, in order; no Holiday column.
    const headers = Array.from(sheet.querySelectorAll("thead th")).map((th) => th.textContent);
    expect(headers).toEqual([
      "Employee #", "Employee Name", "Cut Off Rate", "Daily Rate", "Actual Working Days",
      "Standard Working Days", "Basic Rate", "Total Compensation", "Late 10 /hr", "Halfday",
      "Absent", "Gross Compensation", "Signature",
    ]);
    // Grand total = sum of employee gross only (5,500.00).
    expect(within(sheetTotalRow(container)).getByText("Grand Total")).toBeInTheDocument();
    expect(within(sheetTotalRow(container)).getByText("PHP 5,500.00")).toBeInTheDocument();
    await waitFor(() => expect(window.print).toHaveBeenCalled());
  });

  it("prints one intern payroll sheet excluding employees", async () => {
    const user = userEvent.setup();
    const { container } = renderWorkspace([record(), internRecord()]);
    await user.click(screen.getByRole("button", { name: "Print Intern Payroll" }));

    const sheet = sheetTable(container);
    expect(within(sheet).getByText("Maria Santos")).toBeInTheDocument();
    expect(within(sheet).queryByText("Ada Lovelace")).not.toBeInTheDocument();
    // Grand total = sum of intern gross only (770.00).
    expect(within(sheetTotalRow(container)).getByText("Grand Total")).toBeInTheDocument();
    expect(within(sheetTotalRow(container)).getByText("PHP 770.00")).toBeInTheDocument();
    await waitFor(() => expect(window.print).toHaveBeenCalled());
  });

  it("sums the gross compensation grand total across every printed row", async () => {
    const user = userEvent.setup();
    const { container } = renderWorkspace([
      record(), // 5,500.00
      record({ payrollId: "P-002", employeeId: "EMP-002", employeeName: "Grace Hopper", grossCompensation: 6000, netPay: 6000 }),
      internRecord(), // 770.00 intern — excluded from the employee sheet
    ]);
    await user.click(screen.getByRole("button", { name: "Print Employee Payroll" }));

    const sheet = sheetTable(container);
    expect(within(sheet).getByText("Ada Lovelace")).toBeInTheDocument();
    expect(within(sheet).getByText("Grace Hopper")).toBeInTheDocument();
    expect(within(sheet).queryByText("Maria Santos")).not.toBeInTheDocument();
    // 5,500.00 + 6,000.00 = 11,500.00.
    expect(within(sheetTotalRow(container)).getByText("PHP 11,500.00")).toBeInTheDocument();
    await waitFor(() => expect(window.print).toHaveBeenCalled());
  });

  it("only prints records for the selected cutoff period", async () => {
    const user = userEvent.setup();
    const { container } = renderWorkspace([
      record(), // August 1-15, 2026
      record({
        payrollId: "P-SEP", cutoffStart: "2026-09-01", cutoffEnd: "2026-09-15",
        payrollCutoffLabel: "September 1-15, 2026", grossCompensation: 7000, netPay: 7000,
      }),
    ]);
    // No form cutoff has been chosen, so the most recent saved cutoff
    // (September 1-15, 2026) is the selected payroll cutoff.
    await user.click(screen.getByRole("button", { name: "Print Employee Payroll" }));

    const sheet = sheetTable(container);
    expect(within(container).getByText("SEPTEMBER 1-15, 2026")).toBeInTheDocument();
    const printedRows = sheet.querySelectorAll("tbody tr:not(.payroll-sheet-total)");
    expect(printedRows).toHaveLength(1);
    expect(printedRows[0].querySelectorAll("td")[2]).toHaveTextContent("PHP 5,500.00");
    expect(within(sheetTotalRow(container)).getByText("PHP 7,000.00")).toBeInTheDocument();
    await waitFor(() => expect(window.print).toHaveBeenCalled());
  });

  it("shows the header with company identity, cutoff range, and cutoff note", async () => {
    const user = userEvent.setup();
    const { container } = renderWorkspace([record()]);
    await user.click(screen.getByRole("button", { name: "Print Employee Payroll" }));

    const header = container.querySelector(".payroll-sheet-header");
    expect(header).not.toBeNull();
    expect(within(header as HTMLElement).getByText("Alpha Premier")).toBeInTheDocument();
    expect(within(header as HTMLElement).getByText("TIN: 010-871-213-0000")).toBeInTheDocument();
    expect(within(header as HTMLElement).getByText("AUGUST 1-15, 2026")).toBeInTheDocument();
    expect(within(header as HTMLElement).getByText("Note: Cut off")).toBeInTheDocument();
    expect(within(header as HTMLElement).getByText("1-15th of the month")).toBeInTheDocument();
    expect(within(header as HTMLElement).getByText("16-31st")).toBeInTheDocument();
    await waitFor(() => expect(window.print).toHaveBeenCalled());
  });

  it("shows a message instead of opening print when there are no records", async () => {
    const user = userEvent.setup();
    renderWorkspace([]);
    await user.click(screen.getByRole("button", { name: "Print Employee Payroll" }));
    expect(screen.getByText(/No payroll records to print/)).toBeInTheDocument();
    expect(window.print).not.toHaveBeenCalled();
  });

  it("shows a message when the selected cutoff has no records for the worker type", async () => {
    const user = userEvent.setup();
    renderWorkspace([record()]); // only an employee record
    await user.click(screen.getByRole("button", { name: "Print Intern Payroll" }));
    expect(screen.getByText(/No intern payroll records/)).toBeInTheDocument();
    expect(screen.queryByText("Grand Total")).not.toBeInTheDocument();
    expect(window.print).not.toHaveBeenCalled();
  });

  it("computes employee late deductions from hours times rate", async () => {
    vi.mocked(savePayrollCutoff).mockResolvedValueOnce({ success: true } as never);
    const user = userEvent.setup();
    render(<PayrollWorkspace users={[{
      userId: "EMP-1", rfidUid: "ABCD1234", fullName: "Ada Lovelace", department: null, status: "ACTIVE",
      employeeType: "EMPLOYEE", gender: null, dailyRate: 500, payrollProfileId: "BEA_STANDARD", photoUrl: null,
    }]} profiles={profiles} records={[]} onSaved={vi.fn()} />);
    await user.selectOptions(screen.getByLabelText("Personnel"), "EMP-1");
    await user.click(screen.getByRole("button", { name: /1st.*15th/i }));
    await user.clear(screen.getByLabelText("Total late hours"));
    await user.type(screen.getByLabelText("Total late hours"), "5");
    await user.clear(screen.getByLabelText("Late deduction rate (PHP/hr)"));
    await user.type(screen.getByLabelText("Late deduction rate (PHP/hr)"), "50");
    expect(screen.getByLabelText(/Late deduction \(PHP\)/)).toHaveValue(250);
  });

  it("derives intern absence deduction from standard minus actual days and keeps half-days", async () => {
    vi.mocked(savePayrollCutoff).mockResolvedValueOnce({ success: true } as never);
    const user = userEvent.setup();
    render(<PayrollWorkspace users={[{
      userId: "INT-1", rfidUid: "INT12345", fullName: "Maria Santos", department: null, status: "ACTIVE",
      employeeType: "INTERN", gender: null, dailyRate: null, payrollProfileId: null, photoUrl: null,
    }]} profiles={profiles} records={[]} onSaved={vi.fn()} />);
    await user.selectOptions(screen.getByLabelText("Personnel"), "INT-1");
    await user.click(screen.getByRole("button", { name: /1st.*15th/i }));
    await user.clear(screen.getByLabelText("Standard days"));
    await user.type(screen.getByLabelText("Standard days"), "12");
    await user.clear(screen.getByLabelText("Actual days"));
    await user.type(screen.getByLabelText("Actual days"), "10");
    await user.clear(screen.getByLabelText("Half-days"));
    await user.type(screen.getByLabelText("Half-days"), "1");
    expect(screen.getByDisplayValue("2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save cutoff payroll" }));
    await waitFor(() => expect(savePayrollCutoff).toHaveBeenCalled());
    const payload = vi.mocked(savePayrollCutoff).mock.calls[0][0] as Record<string, unknown>;
    expect(payload.absentDays).toBe(2);
    expect(payload.halfDayCount).toBe(1);
  });
});
