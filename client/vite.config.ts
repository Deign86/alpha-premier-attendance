import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { attendanceApiProxy } from './src/dev-server-config';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': attendanceApiProxy,
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: true,
    globals: true,
  },
});
