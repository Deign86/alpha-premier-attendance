import {
  type FallbackReason,
  type JevPolicyConfig,
} from './types.js';
import { validateChoiceAnswer, type ValidatedChoiceAnswer } from './schemas.js';

export interface SystemOneChoiceQuestionPayload {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface SystemOneRequestPayload<TState> {
  state: TState;
  model: string;
  questions: Record<string, SystemOneChoiceQuestionPayload>;
}

export type JevClientResult<TChoice extends string> =
  | { success: true; answer: ValidatedChoiceAnswer<TChoice>; latencyMs: number }
  | { success: false; reason: FallbackReason; errorMessage: string; latencyMs: number };

export interface JevClientOptions {
  apiKey?: string;
  policy: JevPolicyConfig;
  customFetch?: typeof fetch;
}

export class JevClient {
  private readonly apiKey: string | null;
  private readonly policy: JevPolicyConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(options: JevClientOptions) {
    this.policy = options.policy;
    this.apiKey = options.apiKey ?? (globalThis.process?.env?.['TYPESAFE_API_KEY'] ?? null);
    this.fetchImpl = options.customFetch ?? fetch;
  }

  async evaluateChoice<TState, TChoice extends string>(
    state: TState,
    questionId: string,
    instructions: string,
    criteria: Record<TChoice, string | null>,
    allowedChoices: readonly TChoice[],
  ): Promise<JevClientResult<TChoice>> {
    const startTime = Date.now();

    if (!this.policy.enabled) {
      return {
        success: false,
        reason: 'disabled_by_policy',
        errorMessage: 'JEV evaluation is disabled by policy',
        latencyMs: Date.now() - startTime,
      };
    }

    if (!this.apiKey || this.apiKey.trim().length === 0) {
      return {
        success: false,
        reason: 'missing_api_key',
        errorMessage: 'No TypeSafe API key provided or found in environment',
        latencyMs: Date.now() - startTime,
      };
    }

    // SAFETY: Criteria options are mapped to string description rubrics as required by TypeSafe API
    const mappedCriteria = criteria as Record<string, string | null>;

    const payload: SystemOneRequestPayload<TState> = {
      state,
      model: this.policy.model,
      questions: {
        [questionId]: {
          type: 'choice',
          instructions,
          criteria: mappedCriteria,
        },
      },
    };

    let attempt = 0;
    const maxRetries = Math.max(0, this.policy.maxRetries);

    while (attempt <= maxRetries) {
      attempt++;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.policy.timeoutMs);

        let response: Response;
        try {
          response = await this.fetchImpl(this.policy.apiBaseUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }

        if (response.status === 429 || response.status === 529) {
          if (attempt <= maxRetries) {
            const backoffMs = Math.min(1000, 150 * Math.pow(2, attempt - 1));
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            continue;
          }
          return {
            success: false,
            reason: 'rate_limited',
            errorMessage: `TypeSafe API rate limited or overloaded (status ${response.status})`,
            latencyMs: Date.now() - startTime,
          };
        }

        if (!response.ok) {
          return {
            success: false,
            reason: 'network_error',
            errorMessage: `TypeSafe API HTTP error ${response.status}: ${response.statusText}`,
            latencyMs: Date.now() - startTime,
          };
        }

        const rawBody: ResponseBodyPayload = await response.json();
        const validated = validateChoiceAnswer(rawBody, questionId, allowedChoices);

        return {
          success: true,
          answer: validated,
          latencyMs: Date.now() - startTime,
        };
      } catch (err: unknown) {
        const errorName = err instanceof Error ? err.name : '';
        const errorMessage = err instanceof Error ? err.message : String(err);

        if (errorName === 'AbortError' || errorMessage.includes('aborted') || errorMessage.includes('timeout')) {
          return {
            success: false,
            reason: 'request_timeout',
            errorMessage: `Request timed out after ${this.policy.timeoutMs}ms`,
            latencyMs: Date.now() - startTime,
          };
        }

        if (attempt <= maxRetries) {
          const backoffMs = 150 * Math.pow(2, attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }

        return {
          success: false,
          reason: 'network_error',
          errorMessage,
          latencyMs: Date.now() - startTime,
        };
      }
    }

    return {
      success: false,
      reason: 'network_error',
      errorMessage: 'Exceeded maximum retry attempts',
      latencyMs: Date.now() - startTime,
    };
  }
}

export interface ResponseBodyPayload {
  model?: string;
  answers?: Record<string, ResponseAnswerPayload>;
}

export interface ResponseAnswerPayload {
  type?: string;
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}
