export interface FreshSnapshotInput { fromClickReturn: boolean; }
export interface FreshSnapshotResult { fresh: boolean; }

export function assertFreshSnapshot(input: FreshSnapshotInput): FreshSnapshotResult {
  if (input.fromClickReturn) {
    throw new Error('CUA fresh-snapshot rule: never assert on a click return; capture a fresh snapshot first');
  }
  return { fresh: true };
}
