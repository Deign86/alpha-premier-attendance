import { useSyncExternalStore } from "react";

export interface DtrSyncHealthSnapshot {
  activity: "idle" | "queued" | "syncing" | "throttled" | "retrying" | "disabled" | "offline" | "unavailable";
  queued: number;
  retryablePending: number;
  needsAttention: number;
  dead: number;
  persistenceFailure: boolean;
  emittedAt: string;
  stale: boolean;
}

export type DtrSyncHealthSnapshotInput = Omit<DtrSyncHealthSnapshot, "emittedAt" | "stale"> & {
  emittedAt?: string;
};

export function dtrSyncHealthCopy(snapshot: DtrSyncHealthSnapshot): string {
  if (snapshot.stale) return "DTR status update delayed";
  if (snapshot.activity === "unavailable") return "DTR status unavailable";
  if (snapshot.persistenceFailure) return "Attendance could not be queued for DTR sync; notify an administrator.";
  if (snapshot.dead > 0 || snapshot.needsAttention > 0) return "Attendance needs admin attention for DTR sync.";
  if (snapshot.activity === "disabled") return "Sheet syncing paused; attendance recording continues.";
  if (snapshot.retryablePending > 0) return `${snapshot.retryablePending} punches are waiting for retry; attempts are bounded.`;
  if (snapshot.activity === "throttled") return "DTR sync is throttled; pending punches are waiting.";
  if (snapshot.activity === "retrying") return "DTR retries are in progress; attempts are bounded.";
  if (snapshot.activity === "syncing") return "Syncing";
  if (snapshot.activity === "offline") return "Sync unavailable";
  if (snapshot.queued > 0) return `${snapshot.queued} queued`;
  return "No DTR items queued";
}

let dtrSyncActive = false;
let dtrSyncHealthSnapshot: DtrSyncHealthSnapshot | null = null;
const dtrSyncListeners = new Set<() => void>();
const healthPollSubscribers = new Set<() => void | Promise<void>>();
let healthReadInFlight: Promise<void> | null = null;
let healthPollTimer: number | null = null;
let snapshotStaleTimer: number | null = null;
let visibilityListenerInstalled = false;

function notifyDtrSyncListeners(): void {
  for (const listener of dtrSyncListeners) listener();
  rescheduleDtrHealthPoll();
}

export function getDtrSyncActive(): boolean {
  return dtrSyncActive;
}

export function setDtrSyncActive(value: boolean): void {
  if (dtrSyncActive === value) return;
  dtrSyncActive = value;
  notifyDtrSyncListeners();
}

export function getDtrSyncHealthSnapshot(): DtrSyncHealthSnapshot | null {
  return dtrSyncHealthSnapshot;
}

export function setDtrSyncHealthSnapshot(snapshot: DtrSyncHealthSnapshotInput | null): void {
  if (snapshotStaleTimer !== null) {
    window.clearTimeout(snapshotStaleTimer);
    snapshotStaleTimer = null;
  }
  if (!snapshot) {
    dtrSyncHealthSnapshot = null;
    notifyDtrSyncListeners();
    return;
  }
  const emittedAt = snapshot.emittedAt ?? new Date().toISOString();
  const timestamp = Date.parse(emittedAt);
  const stale = Number.isFinite(timestamp) && Date.now() - timestamp > 60_000;
  const persistenceFailure = snapshot.persistenceFailure || dtrSyncHealthSnapshot?.persistenceFailure === true;
  dtrSyncHealthSnapshot = {
    ...snapshot,
    persistenceFailure,
    emittedAt,
    stale,
  };
  if (Number.isFinite(timestamp) && !stale) {
    snapshotStaleTimer = window.setTimeout(() => {
      snapshotStaleTimer = null;
      if (!dtrSyncHealthSnapshot || dtrSyncHealthSnapshot.emittedAt !== emittedAt) return;
      dtrSyncHealthSnapshot = { ...dtrSyncHealthSnapshot, stale: true };
      notifyDtrSyncListeners();
    }, Math.max(0, 60_001 - (Date.now() - timestamp)));
  }
  notifyDtrSyncListeners();
}

export function refreshDtrSyncHealth(refresh: () => void | Promise<void>): Promise<void> {
  if (healthReadInFlight) return healthReadInFlight;
  healthReadInFlight = Promise.resolve().then(refresh).finally(() => {
    healthReadInFlight = null;
  });
  return healthReadInFlight;
}

function pollIntervalMs(): number {
  const activity = dtrSyncHealthSnapshot?.activity;
  return dtrSyncActive || activity === "syncing" || activity === "retrying" || activity === "throttled" ? 5000 : 30000;
}

function clearHealthPollTimer(): void {
  if (healthPollTimer === null) return;
  window.clearTimeout(healthPollTimer);
  healthPollTimer = null;
}

function scheduleHealthPoll(): void {
  clearHealthPollTimer();
  if (healthPollSubscribers.size === 0 || document.hidden) return;
  healthPollTimer = window.setTimeout(() => {
    healthPollTimer = null;
    if (!document.hidden) {
      const refresh = healthPollSubscribers.values().next().value;
      if (refresh) void refreshDtrSyncHealth(refresh);
    }
    scheduleHealthPoll();
  }, pollIntervalMs());
}

function onHealthPollVisibilityChange(): void {
  if (document.hidden) {
    clearHealthPollTimer();
    return;
  }
  const refresh = healthPollSubscribers.values().next().value;
  if (refresh) void refreshDtrSyncHealth(refresh);
  scheduleHealthPoll();
}

function rescheduleDtrHealthPoll(): void {
  if (healthPollSubscribers.size > 0) scheduleHealthPoll();
}

export function startDtrSyncHealthPolling(refresh: () => void | Promise<void>): () => void {
  const wasStopped = healthPollSubscribers.size === 0;
  healthPollSubscribers.add(refresh);
  if (wasStopped) {
    document.addEventListener("visibilitychange", onHealthPollVisibilityChange);
    visibilityListenerInstalled = true;
    if (!document.hidden) void refreshDtrSyncHealth(refresh);
  }
  scheduleHealthPoll();
  return () => {
    healthPollSubscribers.delete(refresh);
    if (healthPollSubscribers.size === 0) {
      clearHealthPollTimer();
      if (visibilityListenerInstalled) {
        document.removeEventListener("visibilitychange", onHealthPollVisibilityChange);
        visibilityListenerInstalled = false;
      }
    }
  };
}

export function isDtrSyncAlreadyRunning(message: string): boolean {
  return message.includes("DTR_SYNC_IN_PROGRESS");
}

export function useDtrSyncHealthSnapshot(): DtrSyncHealthSnapshot | null {
  return useSyncExternalStore(subscribeDtrSyncActive, getDtrSyncHealthSnapshot);
}

export function subscribeDtrSyncActive(listener: () => void): () => void {
  dtrSyncListeners.add(listener);
  return () => {
    dtrSyncListeners.delete(listener);
  };
}

export function useDtrSyncActive(): boolean {
  return useSyncExternalStore(subscribeDtrSyncActive, getDtrSyncActive);
}

export function resetDtrSyncGuardForTests(): void {
  healthPollSubscribers.clear();
  clearHealthPollTimer();
  if (snapshotStaleTimer !== null) {
    window.clearTimeout(snapshotStaleTimer);
    snapshotStaleTimer = null;
  }
  if (visibilityListenerInstalled) {
    document.removeEventListener("visibilitychange", onHealthPollVisibilityChange);
    visibilityListenerInstalled = false;
  }
  healthReadInFlight = null;
  setDtrSyncActive(false);
  setDtrSyncHealthSnapshot(null);
}
