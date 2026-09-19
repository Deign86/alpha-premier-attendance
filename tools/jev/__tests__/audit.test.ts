import { describe, expect, it } from 'vitest';
import {
  clearAuditEvents,
  getAuditEvents,
  recordAuditEvent,
  subscribeToAuditEvents,
} from '../audit.js';
import type { JevAuditEvent } from '../types.js';

describe('JEV audit logger', () => {
  it('records and retrieves events, and notifies subscribers', () => {
    clearAuditEvents();
    expect(getAuditEvents()).toHaveLength(0);

    const received: JevAuditEvent[] = [];
    const unsubscribe = subscribeToAuditEvents((ev) => received.push(ev));

    const testEvent: JevAuditEvent = {
      eventId: 'evt-1',
      timestamp: new Date().toISOString(),
      evaluator: 'attendance_anomaly',
      targetRef: 'att_123',
      decision: 'normal',
      confidence: 0.98,
      status: 'evaluated',
      latencyMs: 150,
      model: 'jev-latest',
    };

    recordAuditEvent(testEvent);

    const logs = getAuditEvents();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.targetRef).toBe('att_123');
    expect(received).toHaveLength(1);
    expect(received[0]?.eventId).toBe('evt-1');

    unsubscribe();
    clearAuditEvents();
    expect(getAuditEvents()).toHaveLength(0);
  });
});
