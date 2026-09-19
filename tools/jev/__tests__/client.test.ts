import { describe, expect, it } from 'vitest';
import { JevClient } from '../client.js';
import { resolvePolicyConfig } from '../policy.js';
import { ATTENDANCE_ANOMALY_CHOICES, type AttendanceAnomalyChoice } from '../types.js';

describe('JevClient', () => {
  const dummyCriteria = {
    normal: 'normal',
    late_arrival: 'late',
    early_departure: 'early',
    missing_time_in: 'no in',
    missing_time_out: 'no out',
    duplicate_scan: 'dup',
    overlapping_record: 'overlap',
    unusually_long_shift: 'long',
    unusually_short_shift: 'short',
    manual_review: 'manual',
    evaluation_unavailable: 'unavail',
  } satisfies Record<AttendanceAnomalyChoice, string>;

  it('returns disabled_by_policy when policy.enabled is false', async () => {
    const policy = resolvePolicyConfig({ enabled: false });
    const client = new JevClient({ policy, apiKey: 'test-key' });

    const result = await client.evaluateChoice(
      { test: 1 },
      'test_q',
      'instruction',
      dummyCriteria,
      ATTENDANCE_ANOMALY_CHOICES,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('disabled_by_policy');
    }
  });

  it('returns missing_api_key when apiKey is empty', async () => {
    const policy = resolvePolicyConfig({ enabled: true });
    const client = new JevClient({ policy, apiKey: '' });

    const result = await client.evaluateChoice(
      { test: 1 },
      'test_q',
      'instruction',
      dummyCriteria,
      ATTENDANCE_ANOMALY_CHOICES,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('missing_api_key');
    }
  });

  it('handles successful API response via custom fetch', async () => {
    const policy = resolvePolicyConfig({ enabled: true });
    const mockFetch = async () => {
      return new Response(
        JSON.stringify({
          model: 'jev-latest',
          answers: {
            test_q: {
              type: 'choice',
              choice: 'normal',
              confidence: 0.95,
              probabilities: { normal: 0.95, late_arrival: 0.05 },
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    const client = new JevClient({
      policy,
      apiKey: 'valid-test-key',
      // SAFETY: mockFetch test double implements standard fetch contract for tests
      customFetch: mockFetch as typeof fetch,
    });

    const result = await client.evaluateChoice(
      { test: 1 },
      'test_q',
      'instruction',
      dummyCriteria,
      ATTENDANCE_ANOMALY_CHOICES,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.answer.choice).toBe('normal');
      expect(result.answer.confidence).toBe(0.95);
    }
  });

  it('retries on HTTP 429 and returns rate_limited on persistent 429', async () => {
    let callCount = 0;
    const policy = resolvePolicyConfig({ enabled: true, maxRetries: 1 });
    const mockFetch = async () => {
      callCount++;
      return new Response(JSON.stringify({ error: 'rate limit' }), { status: 429 });
    };

    const client = new JevClient({
      policy,
      apiKey: 'valid-test-key',
      // SAFETY: mockFetch test double implements standard fetch contract for tests
      customFetch: mockFetch as typeof fetch,
    });

    const result = await client.evaluateChoice(
      { test: 1 },
      'test_q',
      'instruction',
      dummyCriteria,
      ATTENDANCE_ANOMALY_CHOICES,
    );

    expect(callCount).toBe(2); // Initial call + 1 retry
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('rate_limited');
    }
  });
});
