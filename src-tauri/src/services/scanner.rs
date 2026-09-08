//! Keyboard-mode RFID scanner pipeline.
//!
//! Supported operation:
//! The RFID reader operates as a USB keyboard-wedge device. Keystrokes are
//! received while the attendance window is focused. The pipeline normalizes
//! UIDs (uppercase hex/decimal, separator stripping, bounds checking),
//! deduplicates rapid reads, and emits valid completed scans to the webview
//! as `rfid-scan` events.

use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

use crate::config::{ScannerCharacterSet, ScannerConfig};

#[allow(dead_code)]
pub const SCAN_EVENT: &str = "rfid-scan";
pub const STATUS_EVENT: &str = "scanner-status";

/// Machine-readable scanner lifecycle state surfaced to the UI.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScannerState {
    /// Reader ready and listening for card input.
    Connected,
    /// A card read is in progress or was just received.
    Scanning,
    /// Scanner listener offline.
    Offline,
    /// A scan was received but could not be interpreted.
    Error,
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

/// Initialize the native scanner pipeline.
pub fn start(app: AppHandle, handle: Arc<ScannerHandle>) {
    set_status(
        &app,
        &handle,
        ScannerState::Connected,
        "Keyboard-mode RFID reader ready",
        Some("Keep the attendance window focused before scanning".into()),
    );
}

#[allow(dead_code)]
#[derive(Debug, PartialEq, Eq)]
pub enum ScanParse {
    Valid(String),
    Invalid(String),
    /// Not a scan attempt (too short / separators only): ignore silently.
    Ignored,
}

/// Sanitize and normalize a raw reader string into a card UID.
///
/// Rules mirror the backend exactly (uppercase hex/decimal, 4..=64 characters)
/// so the native layer never accepts something the attendance writer would reject,
/// and never drops something it would accept. Separators (`:`, `-`, space) are
/// stripped so formatted UIDs still work.
#[allow(dead_code)]
pub fn normalize(raw: &str, profile: &ScannerConfig) -> ScanParse {
    let mut value = String::with_capacity(raw.len());
    let mut saw_content = false;
    for ch in raw.chars() {
        if matches!(ch, ':' | '-' | ' ' | '\r' | '\n' | '\t') {
            continue;
        }
        saw_content = true;
        let accepted = match profile.character_set {
            ScannerCharacterSet::Decimal => ch.is_ascii_digit(),
            ScannerCharacterSet::Hex => ch.is_ascii_hexdigit(),
        };
        if !accepted {
            return ScanParse::Invalid(format!("invalid character in reader input: {raw:?}"));
        }
        value.push(ch.to_ascii_uppercase());
    }
    if !saw_content || value.is_empty() {
        return ScanParse::Ignored;
    }
    if value.len() < 4 {
        return ScanParse::Invalid(format!("card ID too short ({} digits)", value.len()));
    }
    if value.len() > 64 {
        return ScanParse::Invalid(format!("card ID too long ({} digits)", value.len()));
    }
    if profile.expected_length > 0 && value.len() != profile.expected_length as usize {
        return ScanParse::Invalid(format!(
            "card ID must be exactly {} characters",
            profile.expected_length
        ));
    }
    ScanParse::Valid(value)
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
    use super::{normalize, ScanParse};
    use crate::config::{ScannerCharacterSet, ScannerConfig};

    fn valid(raw: &str) -> String {
        let profile = ScannerConfig {
            expected_length: 0,
            character_set: ScannerCharacterSet::Hex,
            ..ScannerConfig::default()
        };
        match normalize(raw, &profile) {
            ScanParse::Valid(uid) => uid,
            other => panic!("expected valid scan for {raw:?}, got {other:?}"),
        }
    }

    #[test]
    fn normalizes_lowercase_and_strips_separators() {
        assert_eq!(valid("04a1b2c3"), "04A1B2C3");
        assert_eq!(valid("04:A1:B2:C3"), "04A1B2C3");
        assert_eq!(valid("04 A1 B2 C3"), "04A1B2C3");
        assert_eq!(valid("04a1-b2c3\r\n"), "04A1B2C3");
        assert_eq!(valid("1234567890"), "1234567890");
    }

    #[test]
    fn accepts_default_decimal_and_rejects_letters() {
        assert_eq!(
            normalize("0123456789", &ScannerConfig::default()),
            ScanParse::Valid("0123456789".into())
        );
        assert!(matches!(
            normalize("04A1B2C3", &ScannerConfig::default()),
            ScanParse::Invalid(_)
        ));
        assert!(matches!(
            normalize("1234", &ScannerConfig::default()),
            ScanParse::Invalid(_)
        ));
    }

    #[test]
    fn accepts_variable_length_when_expected_length_zero() {
        let variable_decimal = ScannerConfig {
            expected_length: 0,
            character_set: ScannerCharacterSet::Decimal,
            ..ScannerConfig::default()
        };
        assert_eq!(
            normalize("1234", &variable_decimal),
            ScanParse::Valid("1234".into())
        );
        assert_eq!(
            normalize("123456789012345", &variable_decimal),
            ScanParse::Valid("123456789012345".into())
        );
    }

    #[test]
    fn enforces_fixed_expected_length() {
        let fixed_eight_hex = ScannerConfig {
            expected_length: 8,
            character_set: ScannerCharacterSet::Hex,
            ..ScannerConfig::default()
        };
        assert_eq!(
            normalize("04A1B2C3", &fixed_eight_hex),
            ScanParse::Valid("04A1B2C3".into())
        );
        assert!(matches!(
            normalize("04A1B2", &fixed_eight_hex),
            ScanParse::Invalid(_)
        ));
        assert!(matches!(
            normalize("04A1B2C3D4", &fixed_eight_hex),
            ScanParse::Invalid(_)
        ));
    }

    #[test]
    fn rejects_non_hex_content() {
        assert!(matches!(
            normalize(
                "CARD1234",
                &ScannerConfig {
                    expected_length: 0,
                    character_set: ScannerCharacterSet::Hex,
                    ..ScannerConfig::default()
                }
            ),
            ScanParse::Invalid(_)
        ));
        assert!(matches!(
            normalize(
                "hello",
                &ScannerConfig {
                    expected_length: 0,
                    character_set: ScannerCharacterSet::Hex,
                    ..ScannerConfig::default()
                }
            ),
            ScanParse::Invalid(_)
        ));
    }

    #[test]
    fn ignores_separator_only_or_too_short_input() {
        assert_eq!(normalize("", &ScannerConfig::default()), ScanParse::Ignored);
        assert_eq!(
            normalize("--::  ", &ScannerConfig::default()),
            ScanParse::Ignored
        );
        assert!(matches!(
            normalize("12", &ScannerConfig::default()),
            ScanParse::Invalid(_)
        ));
    }

    #[test]
    fn rejects_overlong_input() {
        assert!(matches!(
            normalize(
                &"A".repeat(65),
                &ScannerConfig {
                    expected_length: 0,
                    character_set: ScannerCharacterSet::Hex,
                    ..ScannerConfig::default()
                }
            ),
            ScanParse::Invalid(_)
        ));
    }

    #[test]
    fn test_scanner_handle_paused_state() {
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
