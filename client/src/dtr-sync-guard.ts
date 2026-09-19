import { useSyncExternalStore } from "react";

let dtrSyncActive = false;
const dtrSyncListeners = new Set<() => void>();

export function getDtrSyncActive(): boolean {
  return dtrSyncActive;
}

export function setDtrSyncActive(value: boolean): void {
  if (dtrSyncActive === value) return;
  dtrSyncActive = value;
  for (const listener of dtrSyncListeners) listener();
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
  setDtrSyncActive(false);
}
