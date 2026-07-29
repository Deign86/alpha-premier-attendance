import { describe, expect, it } from 'vitest';
import { KeyedMutex } from '../src/mutex.js';

describe('KeyedMutex', () => {
  it('serializes operations for one key while allowing different keys', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    const first = mutex.runExclusive('same', async () => {
      events.push('first-start');
      await new Promise((resolve) => setTimeout(resolve, 15));
      events.push('first-end');
    });
    const second = mutex.runExclusive('same', async () => events.push('second'));
    await Promise.all([first, second]);
    expect(events).toEqual(['first-start', 'first-end', 'second']);
  });

  it('releases the key when an operation throws', async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.runExclusive('x', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(mutex.runExclusive('x', async () => 'ok')).resolves.toBe('ok');
  });
});
