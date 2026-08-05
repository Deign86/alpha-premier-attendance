/** Resolve browser-facing API and realtime endpoints without assuming localhost. */
export function resolveApiBaseUrl(currentOrigin: string, configured?: string): string {
  const override = configured?.trim();
  return (override || currentOrigin).replace(/\/$/, '');
}

export function apiBaseUrl(): string {
  const currentOrigin = typeof window === 'undefined' ? '' : window.location.origin;
  const configured = import.meta.env.VITE_API_BASE_URL?.trim();
  return configured ? resolveApiBaseUrl(currentOrigin, configured) : '';
}

export function apiUrl(path: string): string {
  const base = apiBaseUrl();
  if (!base) return path;
  return new URL(path, `${base}/`).toString();
}

export function sseUrl(path: string): string {
  return apiUrl(path);
}

export function websocketUrl(path: string): string {
  const url = new URL(apiUrl(path), typeof window === 'undefined' ? 'http://localhost' : window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}
