import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

  it("prints one landscape register containing interns and employees", async () => {
    const user = userEvent.setup();
    render(<PayrollWorkspace users={[]} profiles={profiles} records={[record(), record({
      payrollId: "P-INT-001", employeeId: "INT-001", employeeName: "Maria Santos", employeeType: "INTERN",
      payrollProfileId: "INTERN_STANDARD", dailyRate: 80, basicPay: 800, totalCompensation: 800, lateUnits: 3, lateDeduction: 30, grossCompensation: 770, netPay: 770,
    })]} onSaved={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Print Payroll" }));
    expect(document.querySelector(".payroll-register-table")).toBeInTheDocument();
    expect(screen.getByText("Employee")).toBeInTheDocument();
    expect(screen.getByText("Late 10 /Hr")).toBeInTheDocument();
    expect(screen.getAllByText("Ada Lovelace").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Maria Santos").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("PHP 6,270.00")).toBeInTheDocument();
    await waitFor(() => expect(window.print).toHaveBeenCalled());
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

  it("shows a message instead of opening print when there are no records", async () => {
    const user = userEvent.setup();
    render(<PayrollWorkspace users={[]} profiles={profiles} records={[]} onSaved={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Print Payroll" }));
    expect(screen.getByText(/No payroll records to print/)).toBeInTheDocument();
    expect(window.print).not.toHaveBeenCalled();
  });
});
