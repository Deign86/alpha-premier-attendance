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

interface McpServerEntry {
  command?: string;
  args?: string[];
  url?: string;
}

interface McpJsonConfig {
  mcpServers?: {
    tauri?: McpServerEntry;
  };
}

interface RootPackageJson {
  devDependencies?: {
    '@hypothesi/tauri-mcp-server'?: string;
  };
}

// SAFETY: Parsed JSON from .mcp.json has expected mcpServers shape
const mcpConfig = JSON.parse(readFileSync('../.mcp.json', 'utf8')) as McpJsonConfig;

// SAFETY: Parsed JSON from root package.json has expected devDependencies shape
const rootPkg = JSON.parse(readFileSync('../package.json', 'utf8')) as RootPackageJson;

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

  it('registers the tauri MCP server in .mcp.json pointing to @hypothesi/tauri-mcp-server', () => {
    expect(mcpConfig.mcpServers?.tauri).toBeDefined();
    const server = mcpConfig.mcpServers?.tauri;
    const hasCommand = server?.command === 'npx' || server?.command?.includes('node');
    expect(hasCommand).toBe(true);
    expect(server?.args?.some((a) => a.includes('@hypothesi/tauri-mcp-server'))).toBe(true);
  });

  it('declares @hypothesi/tauri-mcp-server in root devDependencies', () => {
    expect(rootPkg.devDependencies?.['@hypothesi/tauri-mcp-server']).toBeDefined();
  });

  it('loads @hypothesi/tauri-mcp-server and exports required desktop automation tools', async () => {
    const tauriMcp = await import('@hypothesi/tauri-mcp-server');
    expect(Array.isArray(tauriMcp.TOOLS)).toBe(true);
    const toolNames = tauriMcp.TOOLS.map((t: { name: string }) => t.name);
    expect(toolNames).toContain('driver_session');
    expect(toolNames).toContain('webview_find_element');
    expect(toolNames).toContain('webview_interact');
    expect(toolNames).toContain('webview_screenshot');
    expect(toolNames).toContain('ipc_execute_command');
    expect(toolNames).toContain('ipc_monitor');
    expect(toolNames).toContain('manage_window');
  });
});

