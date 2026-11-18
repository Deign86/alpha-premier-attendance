import { httpApi } from './http-api';
import { tauriApi } from './tauri-api';

export type Transport = typeof tauriApi;

export const runningInTauri = (): boolean => globalThis.window !== undefined && '__TAURI_INTERNALS__' in globalThis.window;

/** The one place the transport is chosen: the desktop app talks to Rust, a browser tab to the legacy Node server. */
export const transport = (): Transport => (runningInTauri() ? tauriApi : httpApi);
