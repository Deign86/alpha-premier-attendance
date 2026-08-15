//! Keyboard-mode RFID scanner pipeline.
//!
//! Supported operation:
//! The RFID reader operates as a USB keyboard-wedge device. Keystrokes are
//! received while the attendance window is focused. The pipeline normalizes
//! UIDs (uppercase hex/decimal, separator stripping, bounds checking),
//! deduplicates rapid reads, and emits valid completed scans to the webview
//! as `rfid-scan` events.

use serde::Serialize;
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

use crate::config::{ScannerCharacterSet, ScannerConfig};

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
    paused: AtomicBool,
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
            paused: AtomicBool::new(false),
        }
    }

    pub fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::SeqCst);
    }

    pub fn paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    pub fn status(&self) -> ScannerStatus {
        let mut status = self.status.lock().expect("scanner status lock").clone();
        status.paused = self.paused.load(Ordering::SeqCst);
        status
    }
}

/// Buffer that accumulates characters until the scan is considered complete.
#[allow(dead_code)]
pub struct ScanBuffer {
    pub data: String,
    pub last_at: Instant,
}

impl Default for ScanBuffer {
    fn default() -> Self {
        Self {
            data: String::new(),
            last_at: Instant::now(),
        }
    }
}

#[allow(dead_code)]
impl ScanBuffer {
    pub fn take_if_idle(&mut self, now: Instant, idle_timeout: Duration) -> Option<String> {
        if self.data.is_empty() || now.saturating_duration_since(self.last_at) < idle_timeout {
            return None;
        }
        let value = std::mem::take(&mut self.data);
        self.last_at = now;
        Some(value)
    }
}

struct Runtime {
    app: AppHandle,
    handle: Arc<ScannerHandle>,
    recent: Mutex<VecDeque<(String, Instant)>>,
}

/// Initialize the native scanner pipeline.
pub fn start(app: AppHandle, handle: Arc<ScannerHandle>) {
    let runtime = Arc::new(Runtime {
        app,
        handle,
        recent: Mutex::new(VecDeque::new()),
    });

    set_status(
        &runtime,
        ScannerState::Connected,
        "Keyboard-mode RFID reader ready",
        Some("Keep the attendance window focused before scanning".into()),
    );
}

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

#[allow(dead_code)]
fn emit_scan(runtime: &Arc<Runtime>, raw: String) {
    if runtime.handle.paused() {
        return;
    }
    match normalize(&raw, &runtime.handle.config) {
        ScanParse::Valid(uid) => {
            if is_recent(runtime, &uid) {
                return;
            }
            let _ = runtime.app.emit(SCAN_EVENT, uid);
            set_status(runtime, ScannerState::Connected, "Waiting for card", None);
        }
        ScanParse::Invalid(detail) => {
            set_status(
                runtime,
                ScannerState::Error,
                "Invalid scan format",
                Some(detail),
            );
            let recovery_runtime = Arc::clone(runtime);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(2500));
                if recovery_runtime.handle.status().state == ScannerState::Error {
                    set_status(
                        &recovery_runtime,
                        ScannerState::Connected,
                        "Waiting for card",
                        None,
                    );
                }
            });
        }
        ScanParse::Ignored => {}
    }
}

/// Native dedup: identical UIDs within the configured window are swallowed so
/// one physical tap never produces two scan requests.
#[allow(dead_code)]
fn is_recent(runtime: &Arc<Runtime>, uid: &str) -> bool {
    let window = Duration::from_millis(runtime.handle.config.dedup_ms.max(50));
    let mut recent = runtime.recent.lock().expect("scanner recent lock");
    let now = Instant::now();
    while recent
        .front()
        .is_some_and(|(_, at)| now.duration_since(*at) > window)
    {
        recent.pop_front();
    }
    if recent.iter().any(|(known, _)| known == uid) {
        return true;
    }
    if recent.len() < 64 {
        recent.push_back((uid.to_string(), now));
    }
    false
}

fn set_status(runtime: &Arc<Runtime>, state: ScannerState, message: &str, detail: Option<String>) {
    let status = ScannerStatus {
        state,
        message: message.to_string(),
        detail,
        mode: "keyboard".to_string(),
        paused: runtime.handle.paused(),
    };
    {
        let mut current = runtime.handle.status.lock().expect("scanner status lock");
        if current.state == status.state
            && current.message == status.message
            && current.detail == status.detail
        {
            return;
        }
        *current = status.clone();
    }
    let _ = runtime.app.emit(STATUS_EVENT, status);
}

#[cfg(test)]
mod tests {
    use super::{normalize, ScanBuffer, ScanParse};
    use crate::config::{ScannerCharacterSet, ScannerConfig};
    use std::time::{Duration, Instant};

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
    fn idle_timeout_completes_a_scan_without_sleeping() {
        let started_at = Instant::now();
        let mut buffer = ScanBuffer {
            data: "04A1B2C3".into(),
            last_at: started_at,
        };
        let timeout = Duration::from_millis(150);

        assert_eq!(
            buffer.take_if_idle(started_at + Duration::from_millis(149), timeout),
            None
        );
        assert_eq!(
            buffer.take_if_idle(started_at + Duration::from_millis(150), timeout),
            Some("04A1B2C3".into())
        );
        assert!(buffer.data.is_empty());
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
}
