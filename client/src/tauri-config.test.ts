import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync('../src-tauri/tauri.conf.json', 'utf8')) as {
  app?: { withGlobalTauri?: boolean };
};

describe('Tauri MCP runtime configuration', () => {
  it('exposes the global Tauri API to the debug webview bridge', () => {
    expect(config.app?.withGlobalTauri).toBe(true);
  });
});
