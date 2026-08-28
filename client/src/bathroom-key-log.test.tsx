import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AdminUser, BathroomStatusResponse } from "@rfid-attendance/shared";
import { BathroomKeyLogPanel } from "./bathroom-key-log";
import * as api from "./api";

const mockUsers: AdminUser[] = [
  {
    userId: "EMP-01",
    rfidUid: "RFID-01",
    fullName: "John Doe",
    department: "Engineering",
    status: "ACTIVE",
    employeeType: "EMPLOYEE",
    gender: "MALE",
    dailyRate: 1500,
    payrollProfileId: "BEA_STANDARD",
    photoUrl: null,
    cardType: "EMPLOYEE",
  },
  {
    userId: "EMP-02",
    rfidUid: "RFID-02",
    fullName: "Jane Smith",
    department: "Human Resources",
    status: "ACTIVE",
    employeeType: "EMPLOYEE",
    gender: "FEMALE",
    dailyRate: 1500,
    payrollProfileId: "BEA_STANDARD",
    photoUrl: null,
    cardType: "EMPLOYEE",
  },
  {
    userId: "ADMIN-01",
    rfidUid: "RFID-ADMIN",
    fullName: "Front Desk Admin",
    department: "Admin",
    status: "ACTIVE",
    employeeType: "EMPLOYEE",
    gender: null,
    dailyRate: null,
    payrollProfileId: null,
    photoUrl: null,
    cardType: "ADMIN_ASSIST",
  },
];

describe("BathroomKeyLogPanel", () => {
  it("renders Male and Female panels with available status by default", async () => {
    const mockStatus: BathroomStatusResponse = {
      success: true,
      date: "2026-08-27",
      maleActive: null,
      femaleActive: null,
      maleLogs: [],
      femaleLogs: [],
      fetchedAt: "2026-08-27T10:00:00Z",
    };
    vi.spyOn(api, "loadBathroomStatus").mockResolvedValue(mockStatus);

    render(<BathroomKeyLogPanel users={mockUsers} />);

    expect(await screen.findByRole("heading", { name: "Bathroom Key Log" })).toBeInTheDocument();
    expect(screen.getByTestId("bathroom-card-male")).toBeInTheDocument();
    expect(screen.getByTestId("bathroom-card-female")).toBeInTheDocument();

    const availablePills = screen.getAllByText("AVAILABLE");
    expect(availablePills).toHaveLength(2);
  });

  it("checks out the Male bathroom key to a selected employee", async () => {
    const mockStatus: BathroomStatusResponse = {
      success: true,
      date: "2026-08-27",
      maleActive: null,
      femaleActive: null,
      maleLogs: [],
      femaleLogs: [],
      fetchedAt: "2026-08-27T10:00:00Z",
    };
    vi.spyOn(api, "loadBathroomStatus").mockResolvedValue(mockStatus);
    const checkoutSpy = vi.spyOn(api, "bathroomTimeOut").mockResolvedValue({
      success: true,
      entry: {
        logId: "log-123",
        logDate: "2026-08-27",
        userId: "EMP-01",
        fullName: "John Doe",
        department: "Engineering",
        genderKey: "MALE",
        timeOut: "2026-08-27T10:00:00+08:00",
        timeIn: null,
        durationSeconds: null,
        status: "OUT",
        notes: "",
        createdAt: "2026-08-27T10:00:00+08:00",
        updatedAt: "2026-08-27T10:00:00+08:00",
      },
    });

    const user = userEvent.setup();
    render(<BathroomKeyLogPanel users={mockUsers} />);

    await screen.findByRole("heading", { name: "Bathroom Key Log" });

    // Select John Doe in the male picker
    const malePicker = screen.getByRole("listbox", { name: /select male employee/i });
    const johnOption = withinList(malePicker, "John Doe");
    expect(johnOption).toBeInTheDocument();
    await user.click(johnOption!);

    // Click checkout button
    const checkoutBtn = screen.getAllByRole("button", { name: /time out \(check out key\)/i })[0];
    expect(checkoutBtn).not.toBeDisabled();
    await user.click(checkoutBtn);

    expect(checkoutSpy).toHaveBeenCalledWith("EMP-01", "MALE");
  });

  it("displays in-use holder info and returns the key when Time In is clicked", async () => {
    const mockStatus: BathroomStatusResponse = {
      success: true,
      date: "2026-08-27",
      maleActive: {
        logId: "log-456",
        userId: "EMP-01",
        fullName: "John Doe",
        department: "Engineering",
        genderKey: "MALE",
        timeOut: new Date(Date.now() - 120_000).toISOString(),
      },
      femaleActive: null,
      maleLogs: [],
      femaleLogs: [],
      fetchedAt: "2026-08-27T10:00:00Z",
    };
    vi.spyOn(api, "loadBathroomStatus").mockResolvedValue(mockStatus);
    const returnSpy = vi.spyOn(api, "bathroomTimeIn").mockResolvedValue({
      success: true,
      entry: {
        logId: "log-456",
        logDate: "2026-08-27",
        userId: "EMP-01",
        fullName: "John Doe",
        department: "Engineering",
        genderKey: "MALE",
        timeOut: "2026-08-27T10:00:00+08:00",
        timeIn: "2026-08-27T10:02:00+08:00",
        durationSeconds: 120,
        status: "RETURNED",
        notes: "",
        createdAt: "2026-08-27T10:00:00+08:00",
        updatedAt: "2026-08-27T10:02:00+08:00",
      },
    });

    const user = userEvent.setup();
    render(<BathroomKeyLogPanel users={mockUsers} />);

    expect(await screen.findByText("IN USE")).toBeInTheDocument();
    expect(screen.getByText("Currently with")).toBeInTheDocument();
    expect(screen.getAllByText("John Doe").length).toBeGreaterThan(0);

    const returnBtn = screen.getByRole("button", { name: /time in \(return key\)/i });
    await user.click(returnBtn);

    expect(returnSpy).toHaveBeenCalledWith("log-456");
  });

  it("filters staff list by search query", async () => {
    const mockStatus: BathroomStatusResponse = {
      success: true,
      date: "2026-08-27",
      maleActive: null,
      femaleActive: null,
      maleLogs: [],
      femaleLogs: [],
      fetchedAt: "2026-08-27T10:00:00Z",
    };
    vi.spyOn(api, "loadBathroomStatus").mockResolvedValue(mockStatus);

    const user = userEvent.setup();
    render(<BathroomKeyLogPanel users={mockUsers} />);

    await screen.findByRole("heading", { name: "Bathroom Key Log" });

    const searchInput = screen.getAllByPlaceholderText(/search staff by name or id…/i)[0];
    await user.type(searchInput, "John");

    const malePicker = screen.getByRole("listbox", { name: /select male employee/i });
    expect(withinList(malePicker, "John Doe")).toBeInTheDocument();
    expect(withinList(malePicker, "Jane Smith")).toBeNull();
  });
});

function withinList(element: HTMLElement, text: string): HTMLElement | null {
  const items = element.querySelectorAll(".employee-picker-item");
  for (const item of Array.from(items)) {
    if (item.textContent?.includes(text)) {
      // SAFETY: Element queried from DOM is HTMLElement
      return item as HTMLElement;
    }
  }
  return null;
}
