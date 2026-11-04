import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDtrSyncActive,
  getDtrSyncHealthSnapshot,
  setDtrSyncHealthSnapshot,
  resetDtrSyncGuardForTests,
  setDtrSyncActive,
  subscribeDtrSyncActive,
  useDtrSyncActive,
  dtrSyncHealthCopy,
  dtrSyncNoticeKind,
  isDtrSyncAlreadyRunning,
  refreshDtrSyncHealth,
  startDtrSyncHealthPolling,
} from "./dtr-sync-guard";

describe("DTR sync guard", () => {
  beforeEach(() => {
    resetDtrSyncGuardForTests();
  });

  it("starts inactive", () => {
    expect(getDtrSyncActive()).toBe(false);
  });

  it("notifies subscribers once when set to true", () => {
    const listener = vi.fn();
    subscribeDtrSyncActive(listener);

    setDtrSyncActive(true);

    expect(getDtrSyncActive()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not notify when set to the current value", () => {
    const listener = vi.fn();
    subscribeDtrSyncActive(listener);

    setDtrSyncActive(false);

    expect(listener).not.toHaveBeenCalled();
  });

  it("stops notifying after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDtrSyncActive(listener);
    unsubscribe();

    setDtrSyncActive(true);

    expect(listener).not.toHaveBeenCalled();
  });

  it("notifies multiple subscribers", () => {
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    subscribeDtrSyncActive(firstListener);
    subscribeDtrSyncActive(secondListener);

    setDtrSyncActive(true);

    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(secondListener).toHaveBeenCalledTimes(1);
  });

  it("reset restores the inactive state", () => {
    setDtrSyncActive(true);

    resetDtrSyncGuardForTests();

    expect(getDtrSyncActive()).toBe(false);
  });

  it("hook reflects store updates", () => {
    const { result } = renderHook(() => useDtrSyncActive());
    expect(result.current).toBe(false);

    act(() => {
      setDtrSyncActive(true);
    });

    expect(result.current).toBe(true);

    act(() => {
      setDtrSyncActive(false);
    });

    expect(result.current).toBe(false);
  });

  it("shares the latest health snapshot between consumers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDtrSyncActive(listener);
    const snapshot = {
      activity: "queued",
      queued: 2,
      retryablePending: 0,
      needsAttention: 0,
      dead: 0,
      persistenceFailure: false,
      emittedAt: new Date().toISOString(),
    } as const;

    setDtrSyncHealthSnapshot(snapshot);

    expect(getDtrSyncHealthSnapshot()).toEqual({ ...snapshot, stale: false });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("preserves timestamp, DTR DEAD, and persistence failure in a normalized snapshot", () => {
    const timestamp = new Date().toISOString();
    setDtrSyncHealthSnapshot({
      activity: "idle",
      queued: 0,
      retryablePending: 0,
      needsAttention: 0,
      dead: 2,
      persistenceFailure: true,
      emittedAt: timestamp,
    });

    expect(getDtrSyncHealthSnapshot()).toEqual({
      activity: "idle",
      queued: 0,
      retryablePending: 0,
      needsAttention: 0,
      dead: 2,
      persistenceFailure: true,
      emittedAt: timestamp,
      stale: false,
    });
  });

  it("preserves event retryable work and shows waiting copy", () => {
    const emittedAt = new Date().toISOString();
    setDtrSyncHealthSnapshot({
      activity: "retrying",
      queued: 0,
      retryablePending: 3,
      needsAttention: 0,
      dead: 0,
      persistenceFailure: false,
      emittedAt,
    });

    expect(getDtrSyncHealthSnapshot()).toMatchObject({ retryablePending: 3, emittedAt });
    expect(getDtrSyncHealthSnapshot()).not.toBeNull();
    expect(dtrSyncHealthCopy(getDtrSyncHealthSnapshot()!)).toContain("3 punches are waiting for retry");
  });

  it("does not erase an earlier queue-persistence warning on a later refresh", () => {
    const emittedAt = new Date().toISOString();
    setDtrSyncHealthSnapshot({
      activity: "idle",
      queued: 0,
      retryablePending: 0,
      needsAttention: 0,
      dead: 0,
      persistenceFailure: true,
      emittedAt,
    });
    setDtrSyncHealthSnapshot({
      activity: "idle",
      queued: 0,
      retryablePending: 0,
      needsAttention: 0,
      dead: 0,
      persistenceFailure: false,
      emittedAt,
    });

    expect(getDtrSyncHealthSnapshot()?.persistenceFailure).toBe(true);
    expect(dtrSyncHealthCopy(getDtrSyncHealthSnapshot()!)).toContain("could not be queued");
  });

  it("resets the shared health snapshot", () => {
    setDtrSyncHealthSnapshot({
      activity: "queued",
      queued: 2,
      retryablePending: 0,
      needsAttention: 0,
      dead: 0,
      persistenceFailure: false,
    });
    resetDtrSyncGuardForTests();
    expect(getDtrSyncHealthSnapshot()).toBeNull();
  });

  const baseCopySnapshot = {
    activity: "idle" as const,
    queued: 0,
    retryablePending: 0,
    needsAttention: 0,
    dead: 0,
    persistenceFailure: false,
    emittedAt: new Date().toISOString(),
    stale: false,
  };
  it.each([
    [{ ...baseCopySnapshot, activity: "queued", queued: 2 }, "2 queued"],
    [{ ...baseCopySnapshot, activity: "throttled", queued: 2 }, "DTR sync is throttled; pending punches are waiting."],
    [{ ...baseCopySnapshot, activity: "retrying" }, "DTR retries are in progress; attempts are bounded."],
    [{ ...baseCopySnapshot, activity: "queued", needsAttention: 3 }, "Attendance needs admin attention for DTR sync."],
    [{ ...baseCopySnapshot, activity: "disabled", queued: 2 }, "Sheet syncing paused; attendance recording continues."],
    [{ ...baseCopySnapshot, activity: "disabled", needsAttention: 2 }, "Attendance needs admin attention for DTR sync."],
    [{ ...baseCopySnapshot, activity: "unavailable" }, "DTR status unavailable"],
    [{ ...baseCopySnapshot }, "No DTR items queued"],
    [{ ...baseCopySnapshot, stale: true }, "DTR status update delayed"],
    [{ ...baseCopySnapshot, persistenceFailure: true }, "Attendance could not be queued for DTR sync; notify an administrator."],
    [{ ...baseCopySnapshot, retryablePending: 2 }, "2 punches are waiting for retry; attempts are bounded."],
  ] as const)("maps health state to kiosk copy", (snapshot, expected) => {
    expect(dtrSyncHealthCopy(snapshot)).toBe(expected);
  });

  it.each([
    [{ ...baseCopySnapshot }, null],
    [{ ...baseCopySnapshot, activity: "syncing", queued: 2 }, null],
    [{ ...baseCopySnapshot, activity: "queued", queued: 2 }, null],
    [{ ...baseCopySnapshot, queued: 2 }, null],
    [{ ...baseCopySnapshot, activity: "unavailable" }, "unavailable"],
    [{ ...baseCopySnapshot, persistenceFailure: true }, "persistence"],
    [{ ...baseCopySnapshot, dead: 1 }, "attention"],
    [{ ...baseCopySnapshot, activity: "syncing", needsAttention: 1 }, "attention"],
    [{ ...baseCopySnapshot, activity: "disabled" }, "paused"],
    [{ ...baseCopySnapshot, activity: "syncing", retryablePending: 2 }, "retry"],
    [{ ...baseCopySnapshot, activity: "throttled", queued: 2 }, "throttled"],
    [{ ...baseCopySnapshot, activity: "retrying" }, "retrying"],
    [{ ...baseCopySnapshot, activity: "offline" }, "offline"],
  ] as const)("names the kind of DTR problem the kiosk card shows (%o)", (snapshot, expected) => {
    expect(dtrSyncNoticeKind(snapshot)).toBe(expected);
  });

  it("shows no kiosk card for a late heartbeat alone (the kiosk doesn't poll; pushes can be 30s or more apart)", () => {
    expect(dtrSyncNoticeKind({ ...baseCopySnapshot, stale: true })).toBeNull();
    expect(dtrSyncNoticeKind({ ...baseCopySnapshot, activity: "syncing", queued: 4, stale: true })).toBeNull();
  });

  it("keeps a real problem when its heartbeat is late, so the kiosk card keeps that problem's sentence", () => {
    expect(dtrSyncNoticeKind({ ...baseCopySnapshot, dead: 1, stale: true })).toBe("attention");
    expect(dtrSyncNoticeKind({ ...baseCopySnapshot, needsAttention: 2, stale: true })).toBe("attention");
    expect(dtrSyncNoticeKind({ ...baseCopySnapshot, persistenceFailure: true, stale: true })).toBe("persistence");
    // The guard's own copy says "delayed" for any late snapshot; the kiosk reads it as fresh to get the real sentence.
    expect(dtrSyncHealthCopy({ ...baseCopySnapshot, dead: 1, stale: true })).toBe("DTR status update delayed");
    expect(dtrSyncHealthCopy({ ...baseCopySnapshot, dead: 1, stale: false })).toBe("Attendance needs admin attention for DTR sync.");
  });

  it("detects the backend-owned in-progress result", () => {
    expect(isDtrSyncAlreadyRunning("DTR_SYNC_IN_PROGRESS: another sync is active")).toBe(true);
    expect(isDtrSyncAlreadyRunning("Google Sheets unavailable")).toBe(false);
  });

  it("deduplicates concurrent health reads", async () => {
    let resolveRead: (() => void) | undefined;
    const read = vi.fn(() => new Promise<void>((resolve) => { resolveRead = resolve; }));
    const first = refreshDtrSyncHealth(read);
    const second = refreshDtrSyncHealth(read);
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    resolveRead?.();
    await Promise.all([first, second]);
  });

  it("owns one visibility-aware active/idle poller in the store", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => {});
    const stopFirst = startDtrSyncHealthPolling(refresh);
    const stopSecond = startDtrSyncHealthPolling(refresh);
    await Promise.resolve();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(refresh).toHaveBeenCalledTimes(2);
    setDtrSyncActive(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(refresh).toHaveBeenCalledTimes(3);
    stopFirst();
    stopSecond();
    vi.useRealTimers();
  });
});
