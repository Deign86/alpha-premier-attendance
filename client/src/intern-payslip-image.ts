import type { InternPayslip } from "@rfid-attendance/shared";

import logoPhoenix from "./assets/branding/logo-phoenix.png";

/** Logical page size in CSS px (portrait). The PNG is rendered at PAYSLIP_SCALE so it stays crisp on phones. */
export const PAYSLIP_WIDTH = 1000;
export const PAYSLIP_SCALE = 2;

export type PayslipHeader = { companyName: string; companyAddress: string; periodLabel: string };

/** The slice of CanvasRenderingContext2D the payslip draws with; test fakes implement it directly. */
export interface PayslipCanvas {
  fillStyle: string | CanvasGradient | CanvasPattern;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  fillRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
}

// ---- Layout (logical px). Each section's top is chained from the one above, so tuning one gap shifts the rest.
const MARGIN = 48;
const CONTENT_RIGHT = PAYSLIP_WIDTH - MARGIN;
const CONTENT_WIDTH = CONTENT_RIGHT - MARGIN;
const COLUMN_GAP = 48;
const COLUMN_WIDTH = (CONTENT_WIDTH - COLUMN_GAP) / 2;

type Column = { x: number; width: number };
const LEFT_COLUMN: Column = { x: MARGIN, width: COLUMN_WIDTH };
const RIGHT_COLUMN: Column = { x: MARGIN + COLUMN_WIDTH + COLUMN_GAP, width: COLUMN_WIDTH };

const HEADER_HEIGHT = 176;
// logo-phoenix.png is a 500px square whose visible mark (measured alpha bbox) spans x 114-382, y 64-369.
// The draw box is sized so the mark is ~136px tall, its left edge sits on MARGIN, and it is centred in the band.
const LOGO_ART = { size: 500, left: 114, right: 382, top: 64, bottom: 369 } as const;
const LOGO_SIZE = 224;
const LOGO_SCALE = LOGO_SIZE / LOGO_ART.size;
const LOGO_X = Math.round(MARGIN - LOGO_ART.left * LOGO_SCALE);
const LOGO_Y = Math.round(HEADER_HEIGHT / 2 - ((LOGO_ART.top + LOGO_ART.bottom) / 2) * LOGO_SCALE);
const LOGO_TEXT_GAP = 28;
const BRAND_TEXT_X = Math.round(LOGO_X + LOGO_ART.right * LOGO_SCALE + LOGO_TEXT_GAP);
const HEADER_LINE_1_Y = 72;
const HEADER_LINE_2_Y = 106;
const HEADER_TEXT_GAP = 32;
const HEADER_MARK_MAX_WIDTH = 300;
const GOLD_RULE_HEIGHT = 6;

const PERIOD_TOP = HEADER_HEIGHT + GOLD_RULE_HEIGHT;
const PERIOD_HEIGHT = 56;

const GRID_TOP = PERIOD_TOP + PERIOD_HEIGHT + 24;
const GRID_ROWS = 5;
const GRID_ROW_HEIGHT = 40;
const GRID_VALUE_GAP = 24;

const LEDGER_TOP = GRID_TOP + GRID_ROWS * GRID_ROW_HEIGHT + 32;
const LEDGER_HEADER_HEIGHT = 40;
/** Fixed by the HR template: both tables always show nine aligned rows. */
const LEDGER_ROWS = 9;
const LEDGER_ROW_HEIGHT = 34;
const LEDGER_TOTAL_HEIGHT = 44;
const LEDGER_TOTAL_TOP = LEDGER_TOP + LEDGER_HEADER_HEIGHT + LEDGER_ROWS * LEDGER_ROW_HEIGHT;
const TOTAL_RULE_HEIGHT = 2;
const CELL_PADDING = 12;
const AMOUNT_WIDTH = 140;

const NET_TOP = LEDGER_TOTAL_TOP + LEDGER_TOTAL_HEIGHT + 28;
const NET_HEIGHT = 96;
const NET_ACCENT_WIDTH = 6;
const NET_PADDING = 28;
const NET_LINE_OFFSET = 14;
const NET_LABEL_WIDTH = 380;

const SIGNATURE_LINE_Y = NET_TOP + NET_HEIGHT + 84;
const SIGNATURE_WIDTH = 320;
const SIGNATURE_LABEL_GAP = 22;

const FOOTER_TOP = SIGNATURE_LINE_Y + SIGNATURE_LABEL_GAP + 44;
const FOOTER_HEIGHT = 56;

export const PAYSLIP_HEIGHT = FOOTER_TOP + FOOTER_HEIGHT;

// ---- Brand palette (client/src/styles.css) and paper tones. Gold is the only accent.
const COLOR = {
  black: "#090a09",
  inkOnDark: "#f6f2e9",
  mutedOnDark: "#aaa79e",
  gold: "#c6a254",
  goldBright: "#e1c477",
  paper: "#ffffff",
  ink: "#151613",
  secondary: "#5f5a4f",
  rule: "#e4dccb",
  tint: "#f6f1e6",
} as const;

const FONT_STACK = '"Poppins", "Segoe UI", Arial, sans-serif';
const POPPINS_WEIGHTS = [400, 500, 600, 700] as const;
type FontWeight = (typeof POPPINS_WEIGHTS)[number];
type TextStyle = { weight: FontWeight; size: number; color: string; align: CanvasTextAlign };

/** Body copy is 15px; 13px for fine print; 18px for section titles; the header and net pay get display sizes. */
const TEXT = {
  companyName: { weight: 600, size: 24, color: COLOR.inkOnDark, align: "left" },
  companyAddress: { weight: 400, size: 15, color: COLOR.mutedOnDark, align: "left" },
  payslipMark: { weight: 700, size: 34, color: COLOR.gold, align: "right" },
  headerPeriod: { weight: 500, size: 15, color: COLOR.goldBright, align: "right" },
  title: { weight: 600, size: 18, color: COLOR.ink, align: "center" },
  label: { weight: 400, size: 15, color: COLOR.secondary, align: "left" },
  bodyLeft: { weight: 400, size: 15, color: COLOR.ink, align: "left" },
  bodyRight: { weight: 500, size: 15, color: COLOR.ink, align: "right" },
  strongLeft: { weight: 600, size: 15, color: COLOR.ink, align: "left" },
  strongRight: { weight: 600, size: 15, color: COLOR.ink, align: "right" },
  fineLeft: { weight: 500, size: 13, color: COLOR.secondary, align: "left" },
  fineRight: { weight: 400, size: 13, color: COLOR.secondary, align: "right" },
  fineMark: { weight: 700, size: 13, color: COLOR.ink, align: "left" },
  netLabel: { weight: 600, size: 18, color: COLOR.inkOnDark, align: "left" },
  netNote: { weight: 400, size: 13, color: COLOR.mutedOnDark, align: "left" },
  netAmount: { weight: 700, size: 40, color: COLOR.goldBright, align: "right" },
} as const;

/** Text shrinks to this share of its size before it is ellipsized. */
const MIN_FIT_RATIO = 0.75;
const DASH = "–";
const ELLIPSIS = "…";
const PAYSLIP_MARK = "PAYSLIP";
const FOOTER_NOTE = "System-generated from Alpha Premier Attendance payroll records.";
const RENDER_FAILED = "PAYSLIP_RENDER_FAILED";
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

const MONEY = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function formatMoney(centavos: number): string {
  return MONEY.format(centavos / 100);
}

/** 80000 -> "800.00", 123456 -> "1,234.56", 0 -> "–", -1200 -> "-12.00". */
export function formatPayslipAmount(centavos: number): string {
  return centavos === 0 ? DASH : formatMoney(centavos);
}

/** 11 -> "11", 10.5 -> "10.5". */
export function formatPayslipDays(days: number): string {
  return String(Math.round(days * 100) / 100);
}

// ---- Drawing primitives
function paint(ctx: PayslipCanvas, color: string, x: number, y: number, width: number, height: number): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, width, height);
}

function setFont(ctx: PayslipCanvas, weight: FontWeight, size: number): void {
  ctx.font = `${weight} ${size}px ${FONT_STACK}`;
}

function textWidth(ctx: PayslipCanvas, text: string, style: TextStyle): number {
  setFont(ctx, style.weight, style.size);
  return ctx.measureText(text).width;
}

/** Sets the font, shrinking it (down to MIN_FIT_RATIO) and then ellipsizing so the text stays inside maxWidth. */
function fitText(ctx: PayslipCanvas, text: string, style: TextStyle, maxWidth: number): string {
  const minSize = Math.ceil(style.size * MIN_FIT_RATIO);
  for (let size = style.size; size >= minSize; size -= 1) {
    setFont(ctx, style.weight, size);
    if (ctx.measureText(text).width <= maxWidth) return text;
  }
  let fitted = text;
  while (fitted.length > 0 && ctx.measureText(`${fitted}${ELLIPSIS}`).width > maxWidth) {
    fitted = fitted.slice(0, -1);
  }
  return `${fitted.trimEnd()}${ELLIPSIS}`;
}

function drawText(ctx: PayslipCanvas, text: string, x: number, y: number, style: TextStyle, maxWidth: number): void {
  if (text === "") return;
  const fitted = fitText(ctx, text, style, maxWidth);
  ctx.fillStyle = style.color;
  ctx.textAlign = style.align;
  ctx.fillText(fitted, x, y);
}

/** Placeholder dashes recede into the secondary tone so real amounts carry the eye. */
function tone(style: TextStyle, text: string): TextStyle {
  return text === DASH ? { ...style, color: COLOR.secondary } : style;
}

// ---- Sections
function drawHeader(ctx: PayslipCanvas, header: PayslipHeader, period: string, logo: CanvasImageSource | null): void {
  paint(ctx, COLOR.black, 0, 0, PAYSLIP_WIDTH, HEADER_HEIGHT);
  if (logo !== null) ctx.drawImage(logo, LOGO_X, LOGO_Y, LOGO_SIZE, LOGO_SIZE);

  const markWidth = Math.min(
    HEADER_MARK_MAX_WIDTH,
    Math.max(textWidth(ctx, PAYSLIP_MARK, TEXT.payslipMark), textWidth(ctx, period, TEXT.headerPeriod)),
  );
  const brandWidth = CONTENT_RIGHT - markWidth - HEADER_TEXT_GAP - BRAND_TEXT_X;
  drawText(ctx, header.companyName.toUpperCase(), BRAND_TEXT_X, HEADER_LINE_1_Y, TEXT.companyName, brandWidth);
  drawText(ctx, header.companyAddress.toUpperCase(), BRAND_TEXT_X, HEADER_LINE_2_Y, TEXT.companyAddress, brandWidth);
  drawText(ctx, PAYSLIP_MARK, CONTENT_RIGHT, HEADER_LINE_1_Y, TEXT.payslipMark, markWidth);
  drawText(ctx, period, CONTENT_RIGHT, HEADER_LINE_2_Y, TEXT.headerPeriod, markWidth);

  paint(ctx, COLOR.gold, 0, HEADER_HEIGHT, PAYSLIP_WIDTH, GOLD_RULE_HEIGHT);
  paint(ctx, COLOR.tint, 0, PERIOD_TOP, PAYSLIP_WIDTH, PERIOD_HEIGHT);
  drawText(ctx, `Payslip for the Month of ${period}`, PAYSLIP_WIDTH / 2, PERIOD_TOP + PERIOD_HEIGHT / 2, TEXT.title, CONTENT_WIDTH);
}

type Field = readonly [label: string, value: string];

function drawFields(ctx: PayslipCanvas, column: Column, fields: readonly Field[]): void {
  fields.forEach(([label, value], index) => {
    const top = GRID_TOP + index * GRID_ROW_HEIGHT;
    const middle = top + GRID_ROW_HEIGHT / 2;
    const shown = value.trim() === "" ? DASH : value;
    const labelWidth = Math.min(textWidth(ctx, label, TEXT.label), column.width / 2);
    drawText(ctx, label, column.x, middle, TEXT.label, labelWidth);
    drawText(ctx, shown, column.x + column.width, middle, tone(TEXT.strongRight, shown), column.width - labelWidth - GRID_VALUE_GAP);
    paint(ctx, COLOR.rule, column.x, top + GRID_ROW_HEIGHT - 1, column.width, 1);
  });
}

function drawEmployeeGrid(ctx: PayslipCanvas, payslip: InternPayslip): void {
  drawFields(ctx, LEFT_COLUMN, [
    ["Employee ID", payslip.employeeId],
    ["Employee Name", payslip.employeeName],
    ["Department", payslip.department],
    ["Designation", payslip.designation],
    ["TIN", payslip.tin],
  ]);
  drawFields(ctx, RIGHT_COLUMN, [
    ["Bank Name", payslip.bankName],
    ["A/C #", payslip.accountNumber],
    ["Standard Working Days", formatPayslipDays(payslip.standardWorkingDays)],
    ["Actual Working Days", formatPayslipDays(payslip.actualWorkingDays)],
    ["Rate per Day", formatPayslipAmount(payslip.dailyRateCentavos)],
  ]);
}

type LedgerLine = { label: string; amount: string; strong: boolean };

function line(label: string, amount: string): LedgerLine {
  return { label, amount, strong: false };
}

function strongLine(label: string, amount: string): LedgerLine {
  return { label, amount, strong: true };
}

/** Interns have no HRA, allowances, holidays, or overtime fields, so those template rows always show a dash. */
function earningsLines(payslip: InternPayslip): LedgerLine[] {
  return [
    line("Basic", formatPayslipAmount(payslip.basicCentavos)),
    line("HRA", DASH),
    line("Special Allowance", DASH),
    strongLine("Gross Salary", formatPayslipAmount(payslip.grossSalaryCentavos)),
    strongLine("Other Earnings", ""),
    line("Reg. Holiday", DASH),
    line("Special Holiday", DASH),
    line("Overtime Pay", DASH),
    payslip.adjustmentCentavos === 0 ? line("", "") : line("Adjustment", formatPayslipAmount(payslip.adjustmentCentavos)),
  ];
}

/** Interns have no government shares, salary advances, or LWOP fields, so those template rows always show a dash. */
function deductionLines(payslip: InternPayslip): LedgerLine[] {
  return [
    line("SSS Employee Share", DASH),
    line("PHIC Employee Share", DASH),
    line("HDMF Employee Share", DASH),
    line("Salary Advance", DASH),
    line("Absent", formatPayslipAmount(payslip.absentCentavos)),
    line("LWOP", DASH),
    line("Late", formatPayslipAmount(payslip.lateCentavos)),
    line("Halfday", formatPayslipAmount(payslip.halfdayCentavos)),
    line("Undertime", formatPayslipAmount(payslip.undertimeCentavos)),
  ];
}

function drawLedgerLine(ctx: PayslipCanvas, column: Column, entry: LedgerLine, middle: number): void {
  const labelWidth = column.width - 2 * CELL_PADDING - AMOUNT_WIDTH;
  const amountStyle = entry.strong ? TEXT.strongRight : TEXT.bodyRight;
  drawText(ctx, entry.label, column.x + CELL_PADDING, middle, entry.strong ? TEXT.strongLeft : TEXT.bodyLeft, labelWidth);
  drawText(ctx, entry.amount, column.x + column.width - CELL_PADDING, middle, tone(amountStyle, entry.amount), AMOUNT_WIDTH);
}

function drawLedger(ctx: PayslipCanvas, column: Column, heading: string, lines: readonly LedgerLine[], total: LedgerLine): void {
  paint(ctx, COLOR.tint, column.x, LEDGER_TOP, column.width, LEDGER_HEADER_HEIGHT);
  drawLedgerLine(ctx, column, strongLine(heading, "Amount"), LEDGER_TOP + LEDGER_HEADER_HEIGHT / 2);

  lines.forEach((entry, index) => {
    const top = LEDGER_TOP + LEDGER_HEADER_HEIGHT + index * LEDGER_ROW_HEIGHT;
    if (index > 0) paint(ctx, COLOR.rule, column.x, top, column.width, 1);
    drawLedgerLine(ctx, column, entry, top + LEDGER_ROW_HEIGHT / 2);
  });

  paint(ctx, COLOR.tint, column.x, LEDGER_TOTAL_TOP, column.width, LEDGER_TOTAL_HEIGHT);
  paint(ctx, COLOR.ink, column.x, LEDGER_TOTAL_TOP, column.width, TOTAL_RULE_HEIGHT);
  drawLedgerLine(ctx, column, total, LEDGER_TOTAL_TOP + LEDGER_TOTAL_HEIGHT / 2);
}

function drawNetPay(ctx: PayslipCanvas, payslip: InternPayslip): void {
  paint(ctx, COLOR.black, MARGIN, NET_TOP, CONTENT_WIDTH, NET_HEIGHT);
  paint(ctx, COLOR.gold, MARGIN, NET_TOP, NET_ACCENT_WIDTH, NET_HEIGHT);
  const middle = NET_TOP + NET_HEIGHT / 2;
  const textX = MARGIN + NET_ACCENT_WIDTH + NET_PADDING;
  const amountWidth = CONTENT_RIGHT - NET_PADDING - textX - NET_LABEL_WIDTH;
  drawText(ctx, "Net Pay", textX, middle - NET_LINE_OFFSET, TEXT.netLabel, NET_LABEL_WIDTH);
  drawText(ctx, "Total earnings less total deductions", textX, middle + NET_LINE_OFFSET, TEXT.netNote, NET_LABEL_WIDTH);
  drawText(ctx, `PHP ${formatMoney(payslip.netPayCentavos)}`, CONTENT_RIGHT - NET_PADDING, middle, TEXT.netAmount, amountWidth);
}

function drawSignatures(ctx: PayslipCanvas): void {
  const signatures = [
    [LEFT_COLUMN, "Prepared by"],
    [RIGHT_COLUMN, "Employee signature"],
  ] as const;
  for (const [column, label] of signatures) {
    paint(ctx, COLOR.secondary, column.x, SIGNATURE_LINE_Y, SIGNATURE_WIDTH, 1);
    drawText(ctx, label, column.x, SIGNATURE_LINE_Y + SIGNATURE_LABEL_GAP, TEXT.fineLeft, SIGNATURE_WIDTH);
  }
}

function drawFooter(ctx: PayslipCanvas): void {
  paint(ctx, COLOR.tint, 0, FOOTER_TOP, PAYSLIP_WIDTH, FOOTER_HEIGHT);
  const middle = FOOTER_TOP + FOOTER_HEIGHT / 2;
  const markWidth = textWidth(ctx, "Confidential", TEXT.fineMark);
  drawText(ctx, "Confidential", MARGIN, middle, TEXT.fineMark, markWidth);
  drawText(ctx, FOOTER_NOTE, CONTENT_RIGHT, middle, TEXT.fineRight, CONTENT_WIDTH - markWidth - HEADER_TEXT_GAP);
}

/** Draws one payslip at logical size; callers scale the context for device pixels. Prints the given totals, never recomputes them. */
export function drawInternPayslip(
  ctx: PayslipCanvas,
  payslip: InternPayslip,
  header: PayslipHeader,
  logo: CanvasImageSource | null,
): void {
  const period = header.periodLabel.toUpperCase();
  ctx.textBaseline = "middle";
  paint(ctx, COLOR.paper, 0, 0, PAYSLIP_WIDTH, PAYSLIP_HEIGHT);
  drawHeader(ctx, header, period, logo);
  drawEmployeeGrid(ctx, payslip);
  drawLedger(ctx, LEFT_COLUMN, "Earnings", earningsLines(payslip), strongLine("Total Earnings", formatPayslipAmount(payslip.totalEarningsCentavos)));
  drawLedger(ctx, RIGHT_COLUMN, "Deductions", deductionLines(payslip), strongLine("Total Deductions", formatPayslipAmount(payslip.totalDeductionsCentavos)));
  drawNetPay(ctx, payslip);
  drawSignatures(ctx);
  drawFooter(ctx);
}

// ---- PNG rendering
let logoRequest: Promise<HTMLImageElement | null> | null = null;

/**
 * Waits for load/error rather than decode(): Chromium (WebView2) defers decode() while the window is
 * hidden or minimised, which would stall a batch. A missing logo resolves null so it never blocks payroll.
 */
function decodeLogo(): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = logoPhoenix;
  });
}

function loadLogo(): Promise<HTMLImageElement | null> {
  logoRequest ??= decodeLogo();
  return logoRequest;
}

async function loadPoppins(): Promise<void> {
  // jsdom ships no FontFaceSet.
  if (!("fonts" in document)) return;
  try {
    await Promise.all(POPPINS_WEIGHTS.map((weight) => document.fonts.load(`${weight} 16px Poppins`)));
  } catch {
    // The fallback faces in FONT_STACK still render a legible payslip.
  }
}

/** Renders one payslip to a PNG and returns its base64 payload (no data-URL prefix). */
export async function renderInternPayslipPng(payslip: InternPayslip, header: PayslipHeader): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = PAYSLIP_WIDTH * PAYSLIP_SCALE;
  canvas.height = PAYSLIP_HEIGHT * PAYSLIP_SCALE;
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error(RENDER_FAILED);

  const [logo] = await Promise.all([loadLogo(), loadPoppins()]);
  ctx.scale(PAYSLIP_SCALE, PAYSLIP_SCALE);
  drawInternPayslip(ctx, payslip, header, logo);

  const dataUrl = canvas.toDataURL("image/png");
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) throw new Error(RENDER_FAILED);
  return dataUrl.slice(PNG_DATA_URL_PREFIX.length);
}
