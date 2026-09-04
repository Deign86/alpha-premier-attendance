import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const credentialsPath = path.join(root, 'credentials', 'rfid-attendance-api.json');
const pinPath = path.join(root, 'credentials', 'rfid-attendance-admin-pin.txt');
const secretPath = path.join(root, 'credentials', 'rfid-attendance-admin-secret.txt');
const sheetsMode = process.env.SHEETS_MODE?.trim() || 'memory';

let credentials;
if (sheetsMode === 'google') {
  if (!fs.existsSync(credentialsPath)) {
    throw new Error(`Missing ${credentialsPath}. Provision the Google service account key before starting with SHEETS_MODE=google.`);
  }
  credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
}

fs.mkdirSync(path.dirname(pinPath), { recursive: true });
const adminPin = process.env.SETUP_ADMIN_PIN?.trim() || readOrCreatePin();
const adminSessionSecret = process.env.ADMIN_SESSION_SECRET?.trim() || readOrCreateSecret();

const nodeDir = path.dirname(process.execPath);
const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
const existingPath = process.env[pathKey] || '';
const mergedPath = existingPath.includes(nodeDir) ? existingPath : `${nodeDir}${path.delimiter}${existingPath}`;

const serverEnv = {
  ...process.env,
  [pathKey]: mergedPath,
  SHEETS_MODE: sheetsMode,
  ...(credentials ? {
    GOOGLE_SHEET_ID: process.env.GOOGLE_SHEET_ID || '1wWR9C9gzhsTj1ZLPc_1O-U4MBvb-q6lSd363GPvzvjM',
    GOOGLE_SERVICE_ACCOUNT_EMAIL: credentials.client_email,
    GOOGLE_PRIVATE_KEY: credentials.private_key,
  } : {}),
  TIMEZONE: 'Asia/Manila',
  HOST: process.env.HOST?.trim() || '0.0.0.0',
  PORT: '3001',
  CLIENT_ORIGIN: process.env.CLIENT_ORIGIN?.trim() || 'http://localhost:5173,http://127.0.0.1:5173',
  ENABLE_CARD_SETUP: 'true',
  SETUP_ADMIN_PIN: adminPin,
  SETUP_SESSION_MINUTES: '15',
  ENABLE_ADMIN: 'true',
  ADMIN_PIN: adminPin,
  ADMIN_SESSION_SECRET: adminSessionSecret,
  ADMIN_SESSION_MINUTES: '15',
};

const clientEnv = {
  ...process.env,
  [pathKey]: mergedPath,
};
delete clientEnv.PORT;

function resolveNpmTarget() {
  const cliCandidates = [
    process.env.npm_execpath,
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const cli of cliCandidates) {
    if (cli && fs.existsSync(cli)) {
      return { command: process.execPath, prefixArgs: [cli], shell: false };
    }
  }
  const siblingNpm = path.join(nodeDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
  if (fs.existsSync(siblingNpm)) {
    return { command: siblingNpm, prefixArgs: [], shell: process.platform === 'win32' };
  }
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefixArgs: [], shell: process.platform === 'win32' };
}

const serverDir = path.join(root, 'server');
const clientDir = path.join(root, 'client');

const npmTarget = resolveNpmTarget();
function spawnNpm(args, env, cwd = root) {
  const child = spawn(npmTarget.command, [...npmTarget.prefixArgs, ...args], {
    cwd,
    env,
    stdio: 'pipe',
    shell: npmTarget.shell,
  });
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
  return child;
}


const server = spawnNpm(['run', 'dev'], serverEnv, serverDir);
server.on('error', (err) => console.error('Server failed to spawn:', err));
await waitForPort(3001, server);
console.log('✓ API server is up on port 3001. Starting frontend client...');
const client = spawnNpm(['run', 'dev'], clientEnv, clientDir);
client.on('error', (err) => console.error('Client failed to spawn:', err));


const children = [server, client];

let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 250);
}

for (const child of children) child.on('exit', (code) => { if (!shuttingDown) shutdown(code ?? 1); });
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function waitForPort(port, child) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    if (child.exitCode !== null) {
      throw new Error(`API server exited before opening port ${port}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/config`);
      if (res.ok) {
        return;
      }
    } catch {
      // not yet listening
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`API server did not open port ${port} within 20 seconds`);
}



function readOrCreatePin() {
  if (fs.existsSync(pinPath)) return fs.readFileSync(pinPath, 'utf8').trim();
  const pin = String(crypto.randomInt(100000, 1000000));
  fs.writeFileSync(pinPath, `${pin}\n`, { encoding: 'utf8', mode: 0o600 });
  return pin;
}

function readOrCreateSecret() {
  if (fs.existsSync(secretPath)) return fs.readFileSync(secretPath, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretPath, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
  return secret;
}
