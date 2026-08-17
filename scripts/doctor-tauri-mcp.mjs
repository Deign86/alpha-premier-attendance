#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');

async function checkTcpPort(port, host = '127.0.0.1', timeoutMs = 1000) {
  return new Promise((res) => {
    const socket = new net.Socket();
    let isConnected = false;

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      isConnected = true;
      socket.destroy();
      res(true);
    });

    socket.once('timeout', () => {
      socket.destroy();
      res(false);
    });

    socket.once('error', () => {
      socket.destroy();
      res(false);
    });

    socket.connect(port, host);
  });
}

async function runDoctor() {
  const issues = [];
  const checks = [];

  // 1. Check tauri.conf.json
  const tauriConfPath = resolve(rootDir, 'src-tauri/tauri.conf.json');
  if (!existsSync(tauriConfPath)) {
    issues.push('Missing src-tauri/tauri.conf.json');
  } else {
    try {
      const conf = JSON.parse(readFileSync(tauriConfPath, 'utf8'));
      if (conf?.app?.withGlobalTauri === true) {
        checks.push('✓ tauri.conf.json has withGlobalTauri: true');
      } else {
        issues.push('tauri.conf.json is missing app.withGlobalTauri: true');
      }
    } catch (e) {
      issues.push(`Failed to parse tauri.conf.json: ${e.message}`);
    }
  }

  // 2. Check capabilities
  const capPath = resolve(rootDir, 'src-tauri/capabilities/default.json');
  if (!existsSync(capPath)) {
    issues.push('Missing src-tauri/capabilities/default.json');
  } else {
    try {
      const cap = JSON.parse(readFileSync(capPath, 'utf8'));
      if (Array.isArray(cap.permissions) && cap.permissions.includes('mcp-bridge:default')) {
        checks.push('✓ src-tauri/capabilities/default.json grants mcp-bridge:default');
      } else {
        issues.push('src-tauri/capabilities/default.json missing mcp-bridge:default permission');
      }
    } catch (e) {
      issues.push(`Failed to parse default.json: ${e.message}`);
    }
  }

  // 3. Check Cargo.toml
  const cargoPath = resolve(rootDir, 'src-tauri/Cargo.toml');
  if (!existsSync(cargoPath)) {
    issues.push('Missing src-tauri/Cargo.toml');
  } else {
    const cargo = readFileSync(cargoPath, 'utf8');
    if (cargo.includes('tauri-plugin-mcp-bridge')) {
      checks.push('✓ src-tauri/Cargo.toml includes tauri-plugin-mcp-bridge');
    } else {
      issues.push('src-tauri/Cargo.toml missing tauri-plugin-mcp-bridge dependency');
    }
  }

  // 4. Check MCP Bridge port (9223)
  const isPortOpen = await checkTcpPort(9223);
  if (isPortOpen) {
    checks.push('✓ Tauri MCP Bridge active on port 9223 (ready to drive)');
  } else {
    checks.push('ℹ Tauri MCP Bridge port 9223 is not currently listening (start app with `npm run tauri:dev` to drive)');
  }

  console.log('=== Tauri MCP Verification Doctor ===');
  for (const c of checks) {
    console.log(`  ${c}`);
  }
  if (issues.length > 0) {
    console.error('\nIssues found:');
    for (const issue of issues) {
      console.error(`  ✗ ${issue}`);
    }
    process.exit(1);
  } else {
    console.log('\nTauri MCP setup is healthy and valid.');
  }
}

runDoctor();
