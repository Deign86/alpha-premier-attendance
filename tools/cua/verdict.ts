import { subscribeToAuditEvents } from '../jev/audit.js';
import { JevClient, type JevClientResult } from '../jev/client.js';
import { resolvePolicyConfig } from '../jev/policy.js';
import { sanitizeReasonText } from '../jev/redaction.js';
import type { FallbackReason, JevAuditEvent, JevPolicyConfig } from '../jev/types.js';

/**
 * CUA case verdict over JEV-judged UI evidence.
 *
 * Reuses tools/jev/* without changing it: redaction before any JEV call,
 * policy override with the wave's 0.8 threshold, JevClient for the Choice
 * call, audit subscription into a local ledger. JEV is text-only: callers
 * pass OCR/DOM text plus the logs tail, never screenshot pixels, and the
 * API key travels via process.env only (no frontend imports, no frontend-env key).
 */

export const CUA_VERDICTS = ['pass', 'fail', 'needs_review'] as const;

export type CuaVerdict = (typeof CUA_VERDICTS)[number];

export const CUA_JEV_DECISIONS = [
  'success',
  'edge_handled',
  'returned',
  'evaluation_unavailable',
] as const;

export type CuaJevDecision = (typeof CUA_JEV_DECISIONS)[number];

export const CUA_CONFIDENCE_THRESHOLD = 0.8;

const CUA_JEV_RUBRIC: Record<CuaJevDecision, string> = {
  success: 'Kiosk shows the success state with employee name and a recorded attendance row',
  edge_handled: 'Unknown card or duplicate cooldown handled with no extra attendance row',
  returned: 'Bathroom key returned, holder cleared, and a duration-carrying log row shown',
  evaluation_unavailable: 'Cannot evaluate or service offline',
};

const EXPECTED_DECISION_BY_SCENARIO: Record<string, string> = {
  'CUA-JEV-01': 'success',
  'CUA-JEV-02': 'edge_handled',
  'CUA-JEV-03': 'returned',
};

export interface CuaJevInput {
  decision: string;
  confidence: number;
  status: string;
}

export interface CuaJevState {
  decision: string;
  confidence: number;
  probabilities: Record<string, number>;
  status: 'ok' | 'fallback';
  fallbackReason?: FallbackReason;
  model: string;
  latencyMs: number;
}

export interface CuaScenarioVerdict {
  choice: CuaVerdict;
  passRequiresConfidenceAtLeast: number;
  jevState: CuaJevState;
}

export interface CuaCaseExpected {
  scenarioId: string;
  decision: CuaJevDecision;
}

export interface VerdictCaseResult {
  verdict: CuaVerdict;
  confidence: number;
  jevDecision: string;
  latencyMs: number;
  status: 'ok' | 'fallback';
  fallbackReason?: FallbackReason;
  model: string;
}

const cuaVerdictLedger: JevAuditEvent[] = [];

subscribeToAuditEvents((event: JevAuditEvent): void => {
  cuaVerdictLedger.push(event);
});

export function getCuaVerdictLedger(): readonly JevAuditEvent[] {
  return cuaVerdictLedger;
}

export function resolveCuaPolicy(): JevPolicyConfig {
  return resolvePolicyConfig({
    enabled: globalThis.process?.env?.['JEV_ENABLED'] === 'true',
    minConfidenceThreshold: CUA_CONFIDENCE_THRESHOLD,
    model: 'jev-latest',
  });
}

function readTypesafeApiKey(): string | null {
  const key = globalThis.process?.env?.['TYPESAFE_API_KEY'];
  if (!key || key.trim().length === 0) {
    return null;
  }
  return key;
}

function buildProbabilities(decision: string, confidence: number): Record<string, number> {
  // SAFETY: single-key map over the observed decision keeps jevState free of raw snapshot text
  const probabilities = {} as Record<string, number>;
  probabilities[decision] = confidence;
  return probabilities;
}

/**
 * Deterministic sync mapper pinned by the CUA-JEV RED test. No network,
 * no raw snapshot text in the returned state.
 */
export function judgeCuaScenario(scenarioId: string, input: CuaJevInput): CuaScenarioVerdict {
  const baseState = {
    decision: input.decision,
    confidence: input.confidence,
    probabilities: buildProbabilities(input.decision, input.confidence),
    model: 'cua-deterministic-rules',
    latencyMs: 0,
  };

  if (input.status !== 'ok') {
    return {
      choice: 'needs_review',
      passRequiresConfidenceAtLeast: CUA_CONFIDENCE_THRESHOLD,
      jevState: { ...baseState, status: 'fallback' },
    };
  }

  if (!(input.confidence >= CUA_CONFIDENCE_THRESHOLD)) {
    return {
      choice: 'needs_review',
      passRequiresConfidenceAtLeast: CUA_CONFIDENCE_THRESHOLD,
      jevState: {
        ...baseState,
        status: 'fallback',
        fallbackReason: 'confidence_below_threshold',
      },
    };
  }

  const expected = EXPECTED_DECISION_BY_SCENARIO[scenarioId];
  if (expected === undefined || input.decision !== expected) {
    return {
      choice: 'fail',
      passRequiresConfidenceAtLeast: CUA_CONFIDENCE_THRESHOLD,
      jevState: { ...baseState, status: 'ok' },
    };
  }

  return {
    choice: 'pass',
    passRequiresConfidenceAtLeast: CUA_CONFIDENCE_THRESHOLD,
    jevState: { ...baseState, status: 'ok' },
  };
}

/**
 * Async JEV-backed case verdict. Redacts snapshot/logs text first, then
 * judges via JevClient. Disabled JEV or a missing key returns
 * needs_review/fallback without touching the network.
 */
export async function verdictCase(
  snapshotText: string,
  logsTail: string,
  expected: CuaCaseExpected,
): Promise<VerdictCaseResult> {
  const startTime = Date.now();
  const redactedSnapshot = sanitizeReasonText(snapshotText) ?? '';
  const redactedLogs = sanitizeReasonText(logsTail) ?? '';
  const policy = resolveCuaPolicy();

  if (!policy.enabled) {
    return {
      verdict: 'needs_review',
      confidence: 0,
      jevDecision: 'evaluation_unavailable',
      latencyMs: Date.now() - startTime,
      status: 'fallback',
      fallbackReason: 'disabled_by_policy',
      model: 'none',
    };
  }

  const apiKey = readTypesafeApiKey();
  if (apiKey === null) {
    return {
      verdict: 'needs_review',
      confidence: 0,
      jevDecision: 'evaluation_unavailable',
      latencyMs: Date.now() - startTime,
      status: 'fallback',
      fallbackReason: 'missing_api_key',
      model: 'none',
    };
  }

  const client = new JevClient({ policy, apiKey });
  const state = {
    scenario: expected.scenarioId,
    expected_decision: expected.decision,
    snapshot_text: redactedSnapshot,
    logs_tail: redactedLogs,
    choices: [...CUA_JEV_DECISIONS],
  };

  let response: JevClientResult<CuaJevDecision>;
  try {
    response = await client.evaluateChoice(
      state,
      'cua_case_verdict',
      'Judge the fresh kiosk snapshot text plus logs tail into exactly one predefined choice.',
      CUA_JEV_RUBRIC,
      CUA_JEV_DECISIONS,
    );
  } catch {
    return {
      verdict: 'needs_review',
      confidence: 0,
      jevDecision: 'evaluation_unavailable',
      latencyMs: Date.now() - startTime,
      status: 'fallback',
      fallbackReason: 'network_error',
      model: policy.model,
    };
  }

  if (!response.success) {
    return {
      verdict: 'needs_review',
      confidence: 0,
      jevDecision: 'evaluation_unavailable',
      latencyMs: response.latencyMs,
      status: 'fallback',
      fallbackReason: response.reason,
      model: 'none',
    };
  }

  if (response.answer.confidence < CUA_CONFIDENCE_THRESHOLD) {
    return {
      verdict: 'needs_review',
      confidence: response.answer.confidence,
      jevDecision: response.answer.choice,
      latencyMs: response.latencyMs,
      status: 'fallback',
      fallbackReason: 'confidence_below_threshold',
      model: response.answer.model,
    };
  }

  if (response.answer.choice !== expected.decision) {
    return {
      verdict: 'fail',
      confidence: response.answer.confidence,
      jevDecision: response.answer.choice,
      latencyMs: response.latencyMs,
      status: 'ok',
      model: response.answer.model,
    };
  }

  return {
    verdict: 'pass',
    confidence: response.answer.confidence,
    jevDecision: response.answer.choice,
    latencyMs: response.latencyMs,
    status: 'ok',
    model: response.answer.model,
  };
}
