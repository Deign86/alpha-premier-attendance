type QueueEntry = { tail: Promise<void>; waiters: number };

/** Per-key async mutex. A key is removed after the final queued operation settles. */
export class KeyedMutex {
  private readonly entries = new Map<string, QueueEntry>();

  async runExclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.entries.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    if (previous) {
      previous.waiters += 1;
      this.entries.set(key, { tail: current, waiters: previous.waiters });
      await previous.tail;
    } else {
      this.entries.set(key, { tail: current, waiters: 1 });
    }

    try {
      return await operation();
    } finally {
      release();
      const entry = this.entries.get(key);
      if (entry?.tail === current) this.entries.delete(key);
    }
  }
}
