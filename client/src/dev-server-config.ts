declare const process: { env: Record<string, string | undefined> };

export const attendanceApiProxy = {
  target: process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3001',
  changeOrigin: true,
};
