import type { ScanRequest } from '@rfid-attendance/shared';

export type QueuedScan = {
  id: string;
  request: ScanRequest;
  timestamp: string;
  retries: number;
};

const OFFLINE_QUEUE_KEY = 'alpha_premier_offline_scans';
let simulatedOffline = false;

/** Controls simulated offline state for development and testing */
export function setSimulatedOffline(offline: boolean): void {
  simulatedOffline = offline;
  if ('window' in globalThis) {
    window.dispatchEvent(new Event(offline ? 'offline' : 'online'));
  }
}

export function isSimulatedOffline(): boolean {
  return simulatedOffline;
}

/** Check if the browser or desktop shell currently has network connectivity */
export function isOnline(): boolean {
  if (simulatedOffline) return false;
  return 'navigator' in globalThis ? navigator.onLine : true;
}

/** Register a listener for network connectivity changes */
export function onNetworkStatusChange(callback: (online: boolean) => void): () => void {
  if (!('window' in globalThis)) return () => {};

  const handleOnline = () => callback(isOnline());
  const handleOffline = () => callback(false);

  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);

  return () => {
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', handleOffline);
  };
}

/** Retrieve pending offline scans */
export function getOfflineQueue(): QueuedScan[] {
  try {
    const raw = 'localStorage' in globalThis ? localStorage.getItem(OFFLINE_QUEUE_KEY) : null;
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** Enqueue a scan when offline */
export function enqueueOfflineScan(request: ScanRequest): QueuedScan {
  const queue = getOfflineQueue();
  const queuedItem: QueuedScan = {
    id: `queue-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    request,
    timestamp: new Date().toISOString(),
    retries: 0,
  };
  queue.push(queuedItem);
  try {
    if ('localStorage' in globalThis) {
      localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
    }
  } catch (err) {
    console.error('Failed to save scan to offline queue:', err);
  }
  return queuedItem;
}

/** Remove a successfully synced item from the queue */
export function removeQueuedScan(id: string): void {
  const queue = getOfflineQueue().filter((item) => item.id !== id);
  try {
    if ('localStorage' in globalThis) {
      localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
    }
  } catch {
    /* ignore */
  }
}

/** Clear all queued offline scans */
export function clearOfflineQueue(): void {
  try {
    if ('localStorage' in globalThis) {
      localStorage.removeItem(OFFLINE_QUEUE_KEY);
    }
  } catch {
    /* ignore */
  }
}

/** Resolve browser-facing API and realtime endpoints without assuming localhost. */
export function resolveApiBaseUrl(currentOrigin: string, configured?: string): string {
  const override = configured?.trim();
  return (override || currentOrigin).replace(/\/$/, '');
}

export function apiBaseUrl(): string {
  const currentOrigin = 'window' in globalThis ? window.location.origin : '';
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
  const url = new URL(apiUrl(path), 'window' in globalThis ? window.location.origin : 'http://localhost');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}
