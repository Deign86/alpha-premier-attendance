import {
  ATTENDANCE_ANOMALY_CHOICES,
  ATTENDANCE_CORRECTION_CHOICES,
  PAYROLL_RECORD_REVIEW_CHOICES,
  type AttendanceAnomalyChoice,
  type AttendanceAnomalyInput,
  type AttendanceCorrectionChoice,
  type AttendanceCorrectionInput,
  type PayrollRecordReviewChoice,
  type PayrollRecordReviewInput,
} from './types.js';

export class JevValidationError extends Error {
  constructor(message: string, public readonly field?: string) {
    super(`JEV Validation Error: ${message}${field ? ` (field: ${field})` : ''}`);
    this.name = 'JevValidationError';
  }
}

export interface RawAttendanceAnomalyPayload {
  recordId?: string;
  employeeRef?: string;
  date?: string;
  scheduledStart?: string;
  scheduledEnd?: string;
  timeIn?: string | null;
  timeOut?: string | null;
  workedMinutes?: number;
  deterministicFlags?: string[];
  priorAnomalyCount?: number;
  source?: string;
  hasSupervisorCorrection?: boolean;
}

export interface RawPayrollRecordReviewPayload {
  payrollRef?: string;
  period?: string;
  regularMinutes?: number;
  overtimeMinutes?: number;
  lateMinutes?: number;
  undertimeMinutes?: number;
  absenceDays?: number;
  manualAdjustmentCount?: number;
  previousPeriodNetChangePercent?: number;
  calculationVersion?: string;
}

export interface RawAttendanceCorrectionPayload {
  correctionRef?: string;
  employeeRef?: string;
  date?: string;
  originalTimeIn?: string | null;
  originalTimeOut?: string | null;
  proposedTimeIn?: string | null;
  proposedTimeOut?: string | null;
  adjustmentMinutes?: number;
  reason?: string | null;
  supervisorRef?: string;
  priorCorrectionCount30Days?: number;
  hasConflictingRfidScan?: boolean;
}

export interface RawAnswerItemPayload {
  type?: string;
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface RawSystemOneResponsePayload {
  model?: string;
  answers?: Record<string, RawAnswerItemPayload>;
}

function isString<T>(value: T): value is T & string {
  return Object(value) !== value && Object.prototype.toString.call(value) === '[object String]';
}

function isNumber<T>(value: T): value is T & number {
  return Object(value) !== value && Object.prototype.toString.call(value) === '[object Number]' && Number.isFinite(value);
}

function isNonNullObject<T>(value: T): value is T & object {
  return value !== null && Object.prototype.toString.call(value) === '[object Object]';
}

function assertNonEmptyString<T>(value: T, field: string): string {
  if (!isString(value) || value.trim().length === 0) {
    throw new JevValidationError('must be a non-empty string', field);
  }
  return value.trim();
}

function assertFiniteNumber<T>(value: T, field: string): number {
  if (!isNumber(value)) {
    throw new JevValidationError('must be a finite number', field);
  }
  return value;
}

export function validateAttendanceAnomalyInput(input: RawAttendanceAnomalyPayload): AttendanceAnomalyInput {
  if (!isNonNullObject(input)) {
    throw new JevValidationError('input must be a valid object');
  }

  const recordId = assertNonEmptyString(input.recordId, 'recordId');
  const employeeRef = assertNonEmptyString(input.employeeRef, 'employeeRef');
  const date = assertNonEmptyString(input.date, 'date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new JevValidationError('date must match YYYY-MM-DD format', 'date');
  }

  const scheduledStart = assertNonEmptyString(input.scheduledStart, 'scheduledStart');
  const scheduledEnd = assertNonEmptyString(input.scheduledEnd, 'scheduledEnd');

  const rawTimeIn = input.timeIn;
  const timeIn = rawTimeIn === null || rawTimeIn === undefined ? null : assertNonEmptyString(rawTimeIn, 'timeIn');

  const rawTimeOut = input.timeOut;
  const timeOut = rawTimeOut === null || rawTimeOut === undefined ? null : assertNonEmptyString(rawTimeOut, 'timeOut');

  const workedMinutes = assertFiniteNumber(input.workedMinutes, 'workedMinutes');
  if (workedMinutes < 0) {
    throw new JevValidationError('workedMinutes must be non-negative', 'workedMinutes');
  }

  const rawFlags = input.deterministicFlags;
  if (!Array.isArray(rawFlags)) {
    throw new JevValidationError('deterministicFlags must be an array', 'deterministicFlags');
  }
  const deterministicFlags: string[] = [];
  for (let i = 0; i < rawFlags.length; i++) {
    const item = rawFlags[i];
    if (!isString(item)) {
      throw new JevValidationError(`flag item at index ${i} must be a string`, 'deterministicFlags');
    }
    deterministicFlags.push(item);
  }

  const rawPrior = input.priorAnomalyCount;
  const priorAnomalyCount = rawPrior === undefined ? undefined : assertFiniteNumber(rawPrior, 'priorAnomalyCount');

  const source = assertNonEmptyString(input.source, 'source');
  const rawSupervisor = input.hasSupervisorCorrection;
  const hasSupervisorCorrection = rawSupervisor === undefined ? undefined : Boolean(rawSupervisor);

  return {
    recordId,
    employeeRef,
    date,
    scheduledStart,
    scheduledEnd,
    timeIn,
    timeOut,
    workedMinutes,
    deterministicFlags,
    priorAnomalyCount,
    source,
    hasSupervisorCorrection,
  };
}

export function validatePayrollRecordReviewInput(input: RawPayrollRecordReviewPayload): PayrollRecordReviewInput {
  if (!isNonNullObject(input)) {
    throw new JevValidationError('input must be a valid object');
  }

  const payrollRef = assertNonEmptyString(input.payrollRef, 'payrollRef');
  const period = assertNonEmptyString(input.period, 'period');
  const regularMinutes = assertFiniteNumber(input.regularMinutes, 'regularMinutes');
  const overtimeMinutes = assertFiniteNumber(input.overtimeMinutes, 'overtimeMinutes');
  const lateMinutes = assertFiniteNumber(input.lateMinutes, 'lateMinutes');
  const undertimeMinutes = assertFiniteNumber(input.undertimeMinutes, 'undertimeMinutes');
  const absenceDays = assertFiniteNumber(input.absenceDays, 'absenceDays');
  const manualAdjustmentCount = assertFiniteNumber(input.manualAdjustmentCount, 'manualAdjustmentCount');
  const previousPeriodNetChangePercent = assertFiniteNumber(
    input.previousPeriodNetChangePercent,
    'previousPeriodNetChangePercent',
  );
  const calculationVersion = assertNonEmptyString(input.calculationVersion, 'calculationVersion');

  return {
    payrollRef,
    period,
    regularMinutes,
    overtimeMinutes,
    lateMinutes,
    undertimeMinutes,
    absenceDays,
    manualAdjustmentCount,
    previousPeriodNetChangePercent,
    calculationVersion,
  };
}

export function validateAttendanceCorrectionInput(input: RawAttendanceCorrectionPayload): AttendanceCorrectionInput {
  if (!isNonNullObject(input)) {
    throw new JevValidationError('input must be a valid object');
  }

  const correctionRef = assertNonEmptyString(input.correctionRef, 'correctionRef');
  const employeeRef = assertNonEmptyString(input.employeeRef, 'employeeRef');
  const date = assertNonEmptyString(input.date, 'date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new JevValidationError('date must match YYYY-MM-DD format', 'date');
  }

  const rawOrigIn = input.originalTimeIn;
  const originalTimeIn = rawOrigIn === null || rawOrigIn === undefined ? null : assertNonEmptyString(rawOrigIn, 'originalTimeIn');

  const rawOrigOut = input.originalTimeOut;
  const originalTimeOut = rawOrigOut === null || rawOrigOut === undefined ? null : assertNonEmptyString(rawOrigOut, 'originalTimeOut');

  const rawPropIn = input.proposedTimeIn;
  const proposedTimeIn = rawPropIn === null || rawPropIn === undefined ? null : assertNonEmptyString(rawPropIn, 'proposedTimeIn');

  const rawPropOut = input.proposedTimeOut;
  const proposedTimeOut = rawPropOut === null || rawPropOut === undefined ? null : assertNonEmptyString(rawPropOut, 'proposedTimeOut');

  const adjustmentMinutes = assertFiniteNumber(input.adjustmentMinutes, 'adjustmentMinutes');

  const rawReason = input.reason;
  const reason = rawReason === null || rawReason === undefined ? null : isString(rawReason) ? rawReason.trim() : null;

  const supervisorRef = assertNonEmptyString(input.supervisorRef, 'supervisorRef');

  const rawPrior = input.priorCorrectionCount30Days;
  const priorCorrectionCount30Days = rawPrior === undefined ? undefined : assertFiniteNumber(rawPrior, 'priorCorrectionCount30Days');

  const rawConflict = input.hasConflictingRfidScan;
  const hasConflictingRfidScan = rawConflict === undefined ? undefined : Boolean(rawConflict);

  return {
    correctionRef,
    employeeRef,
    date,
    originalTimeIn,
    originalTimeOut,
    proposedTimeIn,
    proposedTimeOut,
    adjustmentMinutes,
    reason,
    supervisorRef,
    priorCorrectionCount30Days,
    hasConflictingRfidScan,
  };
}

export interface ValidatedChoiceAnswer<TChoice extends string> {
  choice: TChoice;
  confidence: number;
  probabilities: Record<TChoice, number>;
  model: string;
}

export function validateChoiceAnswer<TChoice extends string>(
  rawResponse: RawSystemOneResponsePayload,
  questionId: string,
  allowedChoices: readonly TChoice[],
): ValidatedChoiceAnswer<TChoice> {
  if (!isNonNullObject(rawResponse)) {
    throw new JevValidationError('Response body must be a JSON object');
  }

  const model = assertNonEmptyString(rawResponse.model, 'model');
  const answers = rawResponse.answers;
  if (!isNonNullObject(answers)) {
    throw new JevValidationError('Response missing answers map', 'answers');
  }

  const answer = answers[questionId];
  if (!isNonNullObject(answer)) {
    throw new JevValidationError(`Missing answer for question id: ${questionId}`, questionId);
  }

  const type = answer.type;
  if (type !== 'choice') {
    throw new JevValidationError(`Answer type must be "choice", got "${String(type)}"`, 'type');
  }

  const rawChoice = answer.choice;
  if (!isString(rawChoice)) {
    throw new JevValidationError('Answer choice must be a string', 'choice');
  }

  // SAFETY: checked against allowedChoices set membership below
  const candidateChoice = rawChoice as TChoice;
  if (!allowedChoices.includes(candidateChoice)) {
    throw new JevValidationError(
      `Returned choice "${rawChoice}" is not one of the allowed choices: ${allowedChoices.join(', ')}`,
      'choice',
    );
  }

  const rawConfidence = answer.confidence;
  if (!isNumber(rawConfidence) || rawConfidence < 0 || rawConfidence > 1) {
    throw new JevValidationError('Answer confidence must be a number between 0 and 1', 'confidence');
  }

  const rawProbabilities = answer.probabilities;
  if (!isNonNullObject(rawProbabilities)) {
    throw new JevValidationError('Answer missing probabilities map', 'probabilities');
  }

  // Build validated typed probabilities map
  // SAFETY: allowedChoices are initialized to 0 then populated from valid entries
  const probabilities = {} as Record<TChoice, number>;
  for (const choice of allowedChoices) {
    probabilities[choice] = 0;
  }

  for (const choice of allowedChoices) {
    const p = rawProbabilities[choice];
    if (isNumber(p) && p >= 0) {
      probabilities[choice] = p;
    }
  }

  return {
    choice: candidateChoice,
    confidence: rawConfidence,
    probabilities,
    model,
  };
}

export function isAttendanceAnomalyChoice(choice: string): choice is AttendanceAnomalyChoice {
  // SAFETY: validated via Array.includes on readonly array
  return ATTENDANCE_ANOMALY_CHOICES.includes(choice as AttendanceAnomalyChoice);
}

export function isPayrollRecordReviewChoice(choice: string): choice is PayrollRecordReviewChoice {
  // SAFETY: validated via Array.includes on readonly array
  return PAYROLL_RECORD_REVIEW_CHOICES.includes(choice as PayrollRecordReviewChoice);
}

export function isAttendanceCorrectionChoice(choice: string): choice is AttendanceCorrectionChoice {
  // SAFETY: validated via Array.includes on readonly array
  return ATTENDANCE_CORRECTION_CHOICES.includes(choice as AttendanceCorrectionChoice);
}
