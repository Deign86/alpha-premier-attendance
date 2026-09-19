import type { JevAuditEvent } from './types.js';

/**
 * In-memory audit buffer for JEV evaluation events.
 * Retains bounded history for diagnostics, logging, and audit inspection.
 * Contains strictly pseudonymized references, never credentials or personal data.
 */

const MAX_AUDIT_LOGS = 1000;
const auditBuffer: JevAuditEvent[] = [];
const subscribers: Array<(event: JevAuditEvent) => void> = [];

export function recordAuditEvent(event: JevAuditEvent): void {
  auditBuffer.push(event);
  if (auditBuffer.length > MAX_AUDIT_LOGS) {
    auditBuffer.shift();
  }
  for (const subscriber of subscribers) {
    try {
      subscriber(event);
    } catch {
      // Ignore subscriber errors to protect the evaluation pipeline
    }
  }
}

export function getAuditEvents(limit = 100): JevAuditEvent[] {
  const boundedLimit = Math.max(1, Math.min(limit, MAX_AUDIT_LOGS));
  return auditBuffer.slice(-boundedLimit);
}

export function clearAuditEvents(): void {
  auditBuffer.length = 0;
}

export function subscribeToAuditEvents(callback: (event: JevAuditEvent) => void): () => void {
  subscribers.push(callback);
  return () => {
    const idx = subscribers.indexOf(callback);
    if (idx !== -1) {
      subscribers.splice(idx, 1);
    }
  };
}
