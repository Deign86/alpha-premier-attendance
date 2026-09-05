import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { attendanceApiProxy } from './src/dev-server-config';

export default defineConfig({
  plugins: [react()],
  build: {
    // Faster local/release frontend builds: skip gzip-size reporting and sourcemaps.
    reportCompressedSize: false,
    sourcemap: false,
    chunkSizeWarningLimit: 1000,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
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
