import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// SAFETY: Parsed JSON from tauri.conf.json has the expected app configuration shape
const tauriConfig = JSON.parse(readFileSync('../src-tauri/tauri.conf.json', 'utf8')) as {
  app?: { withGlobalTauri?: boolean };
  plugins?: {
    updater?: {
      pubkey?: string;
      endpoints?: string[];
    };
  };
};

// SAFETY: Parsed JSON from default.json capabilities has the expected permission list shape
const capabilities = JSON.parse(readFileSync('../src-tauri/capabilities/default.json', 'utf8')) as {
  permissions?: string[];
};

const cargoToml = readFileSync('../src-tauri/Cargo.toml', 'utf8');
const libRs = readFileSync('../src-tauri/src/lib.rs', 'utf8');

describe('Tauri MCP runtime configuration and verification harness', () => {
  it('exposes the global Tauri API to the debug webview bridge in tauri.conf.json', () => {
    expect(tauriConfig.app?.withGlobalTauri).toBe(true);
  });

  it('grants mcp-bridge:default permission in capabilities/default.json', () => {
    expect(capabilities.permissions).toContain('mcp-bridge:default');
  });

  it('declares tauri-plugin-mcp-bridge in Cargo.toml', () => {
    expect(cargoToml).toContain('tauri-plugin-mcp-bridge');
  });

  it('registers the mcp-bridge plugin in lib.rs under debug assertions', () => {
    expect(libRs).toContain('tauri_plugin_mcp_bridge::init()');
  });

  it('configures native updater endpoints and public signing key in tauri.conf.json', () => {
    expect(tauriConfig.plugins?.updater?.endpoints).toEqual([
      'https://github.com/Deign86/alpha-premier-attendance/releases/latest/download/latest.json',
    ]);
    expect(tauriConfig.plugins?.updater?.pubkey).toBeTruthy();
  });

  it('grants updater:default and process:default permissions in default.json', () => {
    expect(capabilities.permissions).toContain('updater:default');
    expect(capabilities.permissions).toContain('process:default');
  });

  it('declares tauri-plugin-updater and tauri-plugin-process in Cargo.toml', () => {
    expect(cargoToml).toContain('tauri-plugin-updater');
    expect(cargoToml).toContain('tauri-plugin-process');
  });

  it('registers updater and process plugins in lib.rs', () => {
    expect(libRs).toContain('tauri_plugin_updater::Builder::new().build()');
    expect(libRs).toContain('tauri_plugin_process::init()');
  });
});
