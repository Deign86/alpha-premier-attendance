import { describe, expect, it, vi } from "vitest";
import type { InternPayslip } from "@rfid-attendance/shared";

import {
  PAYSLIP_HEIGHT,
  PAYSLIP_SCALE,
  PAYSLIP_WIDTH,
  drawInternPayslip,
  formatPayslipAmount,
  formatPayslipDays,
  renderInternPayslipPng,
  type PayslipCanvas,
  type PayslipHeader,
} from "./intern-payslip-image";

const SECONDARY = "#5f5a4f";
const INK = "#151613";

type CanvasColor = string | CanvasGradient | CanvasPattern;
type DrawnText = { text: string; x: number; y: number; width: number; font: string; color: CanvasColor; align: CanvasTextAlign };
type DrawnRect = { x: number; y: number; width: number; height: number; color: CanvasColor };

function fontSize(font: string): number {
  const match = /(\d+(?:\.\d+)?)px/u.exec(font);
  return match === null ? 10 : Number(match[1]);
}

/** Records every draw call; measures text as 0.6em per character so fitting logic is deterministic. */
class RecordingCanvas implements PayslipCanvas {
  fillStyle: CanvasColor = "#000000";
  font = "10px sans-serif";
  textAlign: CanvasTextAlign = "start";
  textBaseline: CanvasTextBaseline = "alphabetic";
  readonly texts: DrawnText[] = [];
  readonly rects: DrawnRect[] = [];
  imagesDrawn = 0;

  fillRect(x: number, y: number, width: number, height: number): void {
    this.rects.push({ x, y, width, height, color: this.fillStyle });
  }

  fillText(text: string, x: number, y: number): void {
    const { width } = this.measureText(text);
    this.texts.push({ text, x, y, width, font: this.font, color: this.fillStyle, align: this.textAlign });
  }

  measureText(text: string) {
    return { width: text.length * fontSize(this.font) * 0.6 };
  }

  drawImage(): void {
    this.imagesDrawn += 1;
  }

  strings(): string[] {
    return this.texts.map((entry) => entry.text);
  }

  find(text: string): DrawnText {
    const entry = this.texts.find((candidate) => candidate.text === text);
    if (entry === undefined) throw new Error(`"${text}" was not drawn`);
    return entry;
  }

  findStarting(prefix: string): DrawnText {
    const entry = this.texts.find((candidate) => candidate.text.startsWith(prefix));
    if (entry === undefined) throw new Error(`nothing starting with "${prefix}" was drawn`);
    return entry;
  }

  /** The text drawn right after `label` — the value or amount in the same row. */
  after(label: string): DrawnText {
    const index = this.texts.findIndex((candidate) => candidate.text === label);
    const entry = this.texts[index + 1];
    if (index < 0 || entry === undefined) throw new Error(`nothing was drawn after "${label}"`);
    return entry;
  }
}

function leftEdge(entry: DrawnText): number {
  if (entry.align === "right") return entry.x - entry.width;
  if (entry.align === "center") return entry.x - entry.width / 2;
  return entry.x;
}

function rightEdge(entry: DrawnText): number {
  return leftEdge(entry) + entry.width;
}

const payslip: InternPayslip = {
  employeeId: "APG-2026-113",
  employeeName: "RUIZ, JOHN FREDERICK",
  department: "MARKETING",
  designation: "INTERN",
  tin: "",
  bankName: "CASH",
  accountNumber: "0000",
  standardWorkingDays: 11,
  actualWorkingDays: 10,
  dailyRateCentavos: 8000,
  basicCentavos: 80000,
  grossSalaryCentavos: 88000,
  adjustmentCentavos: 0,
  totalEarningsCentavos: 88000,
  absentCentavos: 8000,
  lateCentavos: 0,
  halfdayCentavos: 0,
  undertimeCentavos: 0,
  totalDeductionsCentavos: 8000,
  netPayCentavos: 80000,
};

const header: PayslipHeader = {
  companyName: "ALPHA PREMIER GROUP OF COMPANIES OPC.",
  companyAddress: "31F PSEC Tektite East Tower Ortigas Center Pasig City",
  periodLabel: "September 1-15 2026",
};

function draw(slip: InternPayslip, head: PayslipHeader = header, logo: CanvasImageSource | null = null): RecordingCanvas {
  const canvas = new RecordingCanvas();
  drawInternPayslip(canvas, slip, head, logo);
  return canvas;
}

describe("formatPayslipAmount", () => {
  it("formats centavos as grouped pesos with two decimals", () => {
    expect(formatPayslipAmount(80000)).toBe("800.00");
    expect(formatPayslipAmount(123456)).toBe("1,234.56");
    expect(formatPayslipAmount(-1200)).toBe("-12.00");
  });

  it("shows a dash for zero", () => {
    expect(formatPayslipAmount(0)).toBe("–");
  });
});

describe("formatPayslipDays", () => {
  it("drops trailing decimals for whole days and keeps half days", () => {
    expect(formatPayslipDays(11)).toBe("11");
    expect(formatPayslipDays(10.5)).toBe("10.5");
  });
});

describe("drawInternPayslip", () => {
  it("draws every HR template label", () => {
    const drawn = draw(payslip).strings();
    const labels = [
      "Employee ID", "Employee Name", "Department", "Designation", "TIN",
      "Bank Name", "A/C #", "Standard Working Days", "Actual Working Days", "Rate per Day",
      "Earnings", "Deductions", "Amount",
      "Basic", "HRA", "Special Allowance", "Gross Salary", "Other Earnings", "Reg. Holiday", "Special Holiday", "Overtime Pay",
      "SSS Employee Share", "PHIC Employee Share", "HDMF Employee Share", "Salary Advance", "Absent", "LWOP", "Late", "Halfday", "Undertime",
      "Total Earnings", "Total Deductions", "Net Pay", "Prepared by", "Employee signature", "Confidential", "PAYSLIP",
    ];
    expect(labels.filter((label) => !drawn.includes(label))).toEqual([]);
    expect(drawn.filter((text) => text === "Amount")).toHaveLength(2);
  });

  it("draws the header, employee values, and the given amounts", () => {
    const canvas = draw(payslip);
    expect(canvas.strings()).toEqual(expect.arrayContaining([
      "ALPHA PREMIER GROUP OF COMPANIES OPC.",
      "31F PSEC TEKTITE EAST TOWER ORTIGAS CENTER PASIG CITY",
      "SEPTEMBER 1-15 2026",
      "Payslip for the Month of SEPTEMBER 1-15 2026",
      "PHP 800.00",
    ]));
    expect(canvas.after("Employee ID").text).toBe("APG-2026-113");
    expect(canvas.after("Employee Name").text).toBe("RUIZ, JOHN FREDERICK");
    expect(canvas.after("Department").text).toBe("MARKETING");
    expect(canvas.after("Designation").text).toBe("INTERN");
    expect(canvas.after("Bank Name").text).toBe("CASH");
    expect(canvas.after("A/C #").text).toBe("0000");
    expect(canvas.after("Standard Working Days").text).toBe("11");
    expect(canvas.after("Actual Working Days").text).toBe("10");
    expect(canvas.after("Rate per Day").text).toBe("80.00");
    expect(canvas.after("Basic").text).toBe("800.00");
    expect(canvas.after("Gross Salary").text).toBe("880.00");
    expect(canvas.after("Absent").text).toBe("80.00");
    expect(canvas.after("Total Earnings").text).toBe("880.00");
    expect(canvas.after("Total Deductions").text).toBe("80.00");
  });

  it("prints the backend totals verbatim instead of recomputing them", () => {
    const canvas = draw({ ...payslip, totalEarningsCentavos: 12345, totalDeductionsCentavos: 678, netPayCentavos: 99999 });
    expect(canvas.after("Total Earnings").text).toBe("123.45");
    expect(canvas.after("Total Deductions").text).toBe("6.78");
    expect(canvas.strings()).toContain("PHP 999.99");
  });

  it("draws zero amounts and blank fields as a secondary-tone dash", () => {
    const canvas = draw(payslip);
    for (const label of ["TIN", "Late", "Halfday", "Undertime", "HRA", "SSS Employee Share", "LWOP"]) {
      expect(canvas.after(label)).toMatchObject({ text: "–", color: SECONDARY });
    }
    expect(canvas.after("Absent")).toMatchObject({ text: "80.00", color: INK });
  });

  it("shows the Adjustment row only when the adjustment is non-zero", () => {
    expect(draw(payslip).strings()).not.toContain("Adjustment");
    expect(draw({ ...payslip, adjustmentCentavos: 5000 }).after("Adjustment").text).toBe("50.00");
    expect(draw({ ...payslip, adjustmentCentavos: -1200 }).after("Adjustment").text).toBe("-12.00");
  });

  it("shows a zero net pay as PHP 0.00", () => {
    expect(draw({ ...payslip, netPayCentavos: 0 }).strings()).toContain("PHP 0.00");
  });

  it("keeps overlong company names and values clear of their neighbours", () => {
    const canvas = draw(
      { ...payslip, employeeName: "DELA CRUZ-SANTISTEBAN, MARIA ANGELICA CONCEPCION FRANCISCA DE LOS REYES" },
      { ...header, companyName: "ALPHA PREMIER GROUP OF COMPANIES AND ALLIED HOLDINGS INTERNATIONAL OPC." },
    );
    const company = canvas.findStarting("ALPHA PREMIER");
    const markLeft = Math.min(leftEdge(canvas.find("PAYSLIP")), leftEdge(canvas.find("SEPTEMBER 1-15 2026")));
    expect(fontSize(company.font)).toBeLessThan(24);
    expect(rightEdge(company)).toBeLessThan(markLeft);

    const name = canvas.after("Employee Name");
    expect(name.text.endsWith("…")).toBe(true);
    expect(leftEdge(name)).toBeGreaterThan(rightEdge(canvas.find("Employee Name")));
  });

  it("keeps every mark inside the page", () => {
    const canvas = draw(payslip);
    expect(canvas.rects[0]).toMatchObject({ x: 0, y: 0, width: PAYSLIP_WIDTH, height: PAYSLIP_HEIGHT, color: "#ffffff" });
    expect(canvas.rects.filter((rect) => rect.x < 0 || rect.y < 0 || rect.x + rect.width > PAYSLIP_WIDTH || rect.y + rect.height > PAYSLIP_HEIGHT)).toEqual([]);
    expect(canvas.texts.filter((entry) => leftEdge(entry) < 0 || rightEdge(entry) > PAYSLIP_WIDTH || entry.y > PAYSLIP_HEIGHT)).toEqual([]);
  });

  it("draws the logo only when one is available", () => {
    expect(draw(payslip, header, document.createElement("canvas")).imagesDrawn).toBe(1);
    expect(draw(payslip).imagesDrawn).toBe(0);
  });
});

describe("renderInternPayslipPng", () => {
  it("renders a portrait page at phone-ready scale", () => {
    expect(PAYSLIP_WIDTH * PAYSLIP_SCALE).toBe(2000);
    expect(PAYSLIP_HEIGHT).toBeGreaterThan(PAYSLIP_WIDTH);
  });

  it("rejects with PAYSLIP_RENDER_FAILED when no 2D context is available", async () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    try {
      await expect(renderInternPayslipPng(payslip, header)).rejects.toThrow("PAYSLIP_RENDER_FAILED");
      expect(getContext).toHaveBeenCalledWith("2d");
    } finally {
      getContext.mockRestore();
    }
  });
});
