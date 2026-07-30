import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const credentialsPath = path.join(root, 'credentials', 'rfid-attendance-api.json');
const pinPath = path.join(root, 'credentials', 'rfid-attendance-admin-pin.txt');
const secretPath = path.join(root, 'credentials', 'rfid-attendance-admin-secret.txt');

if (!fs.existsSync(credentialsPath)) {
  throw new Error(`Missing ${credentialsPath}. Provision the Google service account key before starting the kiosk.`);
}

const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
const adminPin = process.env.SETUP_ADMIN_PIN?.trim() || readOrCreatePin();
const adminSessionSecret = process.env.ADMIN_SESSION_SECRET?.trim() || readOrCreateSecret();

const environment = {
  ...process.env,
  SHEETS_MODE: process.env.SHEETS_MODE?.trim() || 'memory',
  GOOGLE_SHEET_ID: '1wWR9C9gzhsTj1ZLPc_1O-U4MBvb-q6lSd363GPvzvjM',
  GOOGLE_SERVICE_ACCOUNT_EMAIL: credentials.client_email,
  GOOGLE_PRIVATE_KEY: credentials.private_key,
  TIMEZONE: 'Asia/Manila',
  PORT: '3001',
  CLIENT_ORIGIN: 'http://localhost:5173',
  ENABLE_CARD_SETUP: 'true',
  SETUP_ADMIN_PIN: adminPin,
  SETUP_SESSION_MINUTES: '15',
  ENABLE_ADMIN: 'true',
  ADMIN_PIN: adminPin,
  ADMIN_SESSION_SECRET: adminSessionSecret,
  ADMIN_SESSION_MINUTES: '15',
};

const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const server = spawn(command, ['run', 'dev', '-w', 'server'], { cwd: root, env: environment, stdio: 'inherit', shell: process.platform === 'win32' });
await waitForPort(3001, server);
const children = [server, spawn(command, ['run', 'dev', '-w', 'client'], { cwd: root, env: environment, stdio: 'inherit', shell: process.platform === 'win32' })];
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

function waitForPort(port, child) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = () => {
      if (child.exitCode !== null) { reject(new Error(`API server exited before opening port ${port}`)); return; }
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - startedAt > 15_000) reject(new Error(`API server did not open port ${port} within 15 seconds`));
        else setTimeout(check, 100);
      });
    };
    check();
  });
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
