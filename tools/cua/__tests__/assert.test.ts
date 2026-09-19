import { describe, expect, it } from 'vitest';
import { assertFreshSurface, assertSurface, captureSurface } from '../assert.js';
import type { SurfaceBridge } from '../assert.js';
import type { CuaTarget } from '../target.js';

const TARGET: CuaTarget = {
  pid: 4242,
  windowId: 'main',
  elementToken: 'kiosk-record-submit',
  geometry: { width: 1280, height: 800, x: 0, y: 0 },
};

function fakeBridge(calls: string[], domText = 'kiosk-result-success Ada'): SurfaceBridge {
  return {
    send: (command: string): Promise<unknown> => {
      calls.push(command);
      if (command === 'dom_snapshot') return Promise.resolve(domText);
      if (command === 'ipc_read') return Promise.resolve('attendance-updated uid=42');
      return Promise.resolve({ ok: true });
    },
  };
}

describe('assertSurface fresh-capture rule', () => {
  it('fresh pre/post captures get different snapshot ids and pass binary', async () => {
    const calls: string[] = [];
    const bridge = fakeBridge(calls);
    const pre = await captureSurface(bridge, TARGET);
    const post = await captureSurface(bridge, TARGET);
    expect(post.snapshotId).not.toBe(pre.snapshotId);
    expect(calls.filter((c) => c === 'get_window_state')).toHaveLength(2);
    const result = assertSurface(post, { domIncludes: ['kiosk-result-success'], ipcIncludes: ['attendance-updated'] });
    expect(result.pass).toBe(true);
    expect(result.excerpt).toContain('kiosk-result-success');
    expect(result.snapshotId).toBe(post.snapshotId);
  });

  it('rejects stale-capture reuse on second assert', async () => {
    const bridge = fakeBridge([]);
    const capture = await captureSurface(bridge, TARGET);
    expect(assertSurface(capture, { domIncludes: ['kiosk-result-success'] }).pass).toBe(true);
    expect(() => assertSurface(capture, { domIncludes: ['kiosk-result-success'] })).toThrow(/stale surface reuse/);
  });

  it('rejects click-return captures and returns binary fail on mismatch', async () => {
    const bridge = fakeBridge([]);
    const capture = await captureSurface(bridge, TARGET);
    expect(() => assertSurface({ ...capture, fromClickReturn: true }, { domIncludes: ['x'] })).toThrow(/fresh-snapshot/);
    const miss = await assertFreshSurface(bridge, TARGET, { domIncludes: ['no-such-element'] });
    expect(miss.pass).toBe(false);
    expect(typeof miss.excerpt).toBe('string');
  });
});
