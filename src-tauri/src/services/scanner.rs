//! The RFID reader's status as the app reports it.
//!
//! The reader is a USB keyboard wedge: it types the card ID into the focused attendance window, and the webview
//! reads those keys (`client/src/use-card-reader.ts`). Nothing here reads the device. This module holds the reader's
//! configured format, the status line the screens show, and the pause flag the client sets while someone types.

use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

use crate::config::ScannerConfig;

pub const STATUS_EVENT: &str = "scanner-status";

/// Machine-readable reader state surfaced to the UI. The app only ever reports `connected`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScannerState {
    /// Reader ready and listening for card input.
    Connected,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScannerStatus {
    pub state: ScannerState,
    pub message: String,
    pub detail: Option<String>,
    pub mode: String,
    pub paused: bool,
}

/// Shared scanner control surface stored in `AppState` so Tauri commands can
/// inspect status and pause the listener while the operator types (admin PIN,
/// manual entry, setup forms).
pub struct ScannerHandle {
    pub config: ScannerConfig,
    status: Mutex<ScannerStatus>,
}

impl ScannerHandle {
    pub fn new(config: ScannerConfig) -> Self {
        Self {
            config,
            status: Mutex::new(ScannerStatus {
                state: ScannerState::Connected,
                message: "Keyboard-mode RFID reader ready".into(),
                detail: Some("Keep the attendance window focused before scanning".into()),
                mode: "keyboard".into(),
                paused: false,
            }),
        }
    }

    pub fn set_paused(&self, paused: bool) {
        let mut status = self.status.lock().expect("scanner status lock");
        status.paused = paused;
    }

    pub fn paused(&self) -> bool {
        self.status.lock().expect("scanner status lock").paused
    }

    pub fn status(&self) -> ScannerStatus {
        self.status.lock().expect("scanner status lock").clone()
    }
}

/// Publishes the reader's first status once the app is up.
pub fn start(app: AppHandle, handle: Arc<ScannerHandle>) {
    set_status(
        &app,
        &handle,
        ScannerState::Connected,
        "Keyboard-mode RFID reader ready",
        Some("Keep the attendance window focused before scanning".into()),
    );
}

fn set_status(
    app: &AppHandle,
    handle: &ScannerHandle,
    state: ScannerState,
    message: &str,
    detail: Option<String>,
) {
    let mut current = handle.status.lock().expect("scanner status lock");
    if current.state == state
        && current.message == message
        && current.detail == detail
    {
        return;
    }
    current.state = state;
    current.message = message.to_string();
    current.detail = detail;
    let status = current.clone();
    drop(current);
    let _ = app.emit(STATUS_EVENT, status);
}

#[cfg(test)]
mod tests {
    use crate::config::ScannerConfig;

    #[test]
    fn pausing_shows_in_the_status_and_resuming_clears_it() {
        let handle = super::ScannerHandle::new(ScannerConfig::default());
        assert!(!handle.paused());
        assert!(!handle.status().paused);

        handle.set_paused(true);
        assert!(handle.paused());
        assert!(handle.status().paused);

        handle.set_paused(false);
        assert!(!handle.paused());
        assert!(!handle.status().paused);
    }
}
