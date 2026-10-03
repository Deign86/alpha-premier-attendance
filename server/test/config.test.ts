import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('server LAN and Sheets configuration defaults', () => {
  it('binds to all interfaces on the default LAN port and keeps memory Sheets offline', () => {
    const config = loadConfig({});

    expect(config).toMatchObject({
      host: '0.0.0.0',
      port: 3001,
      sheetsMode: 'memory',
      corsOrigin: 'http://localhost:5173',
    });
  });

  it('honors HOST over BIND_HOST and accepts an explicit port and Sheets mode', () => {
    const config = loadConfig({
      HOST: '192.168.1.25',
      BIND_HOST: '127.0.0.1',
      PORT: '3010',
      SHEETS_MODE: 'memory',
    });

    expect(config.host).toBe('192.168.1.25');
    expect(config.port).toBe(3010);
    expect(config.sheetsMode).toBe('memory');
  });

  it('rejects Google Sheets mode without credentials instead of silently falling back', () => {
    expect(() => loadConfig({ SHEETS_MODE: 'google' })).toThrow(
      'Google Sheets mode requires GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY',
    );
  });
});
