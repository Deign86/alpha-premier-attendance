//! Native RFID scanner pipeline.
//!
//! The scanner interaction is the product: a card tap must be captured at the
//! native layer and turned into one clean scan event for the UI, without
//! depending on a focused webview text input.
//!
//! Two hardware modes are supported and normalized into one pipeline:
//! - `keyboard` (default): the reader behaves as a keyboard wedge and types the
//!   card UID followed by Enter. A global low-level keyboard hook (`rdev`)
//!   captures the stream even when the webview is not focused.
//! - `hid`: the reader exposes raw HID reports. With explicit
//!   `scanner.hid_vid` / `scanner.hid_pid` configuration the app opens the
//!   device directly and extracts the ASCII UID from its reports.
//!
//! Both sources feed the same buffer/completion logic (Enter suffix or idle
//! timeout), the same normalization (uppercase hex, separators stripped), the
//! same backend-parity validation, and a short native dedup window. Completed
//! scans are emitted to the webview as `rfid-scan` (string UID) and lifecycle /
//! diagnostic changes as `scanner-status`.

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

use crate::config::{ScannerConfig, ScannerMode};

pub const SCAN_EVENT: &str = "rfid-scan";
pub const STATUS_EVENT: &str = "scanner-status";

/// Machine-readable scanner lifecycle state surfaced to the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScannerState {
    /// Reader attached and listening for a card.
    Connected,
    /// A card read is in progress or was just completed.
    Scanning,
    /// No reader/listener is available (hook failed, device missing, ...).
    Offline,
    /// A scan was received but could not be interpreted.
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScannerStatus {
    pub state: ScannerState,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub mode: String,
    /// True while the operator types in admin/setup/manual-entry screens, so
    /// keystrokes are never misread as card taps.
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
        let mode = mode_label(config.mode);
        Self {
            config,
            status: Mutex::new(ScannerStatus {
                state: ScannerState::Connected,
                message: "Waiting for card".into(),
                detail: None,
                mode,
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

pub fn mode_label(mode: ScannerMode) -> String {
    match mode {
        ScannerMode::Keyboard => "keyboard",
        ScannerMode::Hid => "hid",
        ScannerMode::Auto => "auto",
    }
    .to_string()
}

/// Buffer that accumulates characters from any reader source until the scan is
/// considered complete (Enter suffix, CR/LF byte, or idle timeout).
struct ScanBuffer {
    data: String,
    last_at: Instant,
}

impl Default for ScanBuffer {
    fn default() -> Self {
        Self {
            data: String::new(),
            last_at: Instant::now(),
        }
    }
}

struct Runtime {
    app: AppHandle,
    handle: Arc<ScannerHandle>,
    buffer: Mutex<ScanBuffer>,
    recent: Mutex<VecDeque<(String, Instant)>>,
}

/// Spawn the scanner sources. The native listener owns the pipeline; the webview
/// only receives `rfid-scan` events for completed, valid scans.
pub fn start(app: AppHandle, handle: Arc<ScannerHandle>) {
    let config = handle.config.clone();
    let runtime = Arc::new(Runtime {
        app,
        handle,
        buffer: Mutex::new(ScanBuffer::default()),
        recent: Mutex::new(VecDeque::new()),
    });

    // Idle-timeout flusher: completes scans for readers without an Enter
    // suffix, separates consecutive taps, and guarantees the buffer never
    // lingers.
    {
        let runtime = Arc::clone(&runtime);
        let idle_timeout = Duration::from_millis(config.idle_timeout_ms.max(20));
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(20));
            let value = {
                let mut buffer = runtime.buffer.lock().expect("scanner buffer lock");
                if buffer.data.is_empty() || buffer.last_at.elapsed() < idle_timeout {
                    None
                } else {
                    let value = std::mem::take(&mut buffer.data);
                    buffer.last_at = Instant::now();
                    Some(value)
                }
            };
            if let Some(value) = value {
                emit_scan(&runtime, value);
            }
        });
    }

    match config.mode {
        ScannerMode::Keyboard => spawn_keyboard(&runtime, config),
        ScannerMode::Hid => spawn_hid(&runtime, config),
        ScannerMode::Auto => {
            if config.hid_vid.is_some() && config.hid_pid.is_some() {
                spawn_hid(&runtime, config);
            } else {
                spawn_keyboard(&runtime, config);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/// Keyboard-wedge source: global low-level keyboard hook. Works whether or not
/// the webview (or any other window) has focus.
fn spawn_keyboard(runtime: &Arc<Runtime>, config: ScannerConfig) {
    let hook_runtime = Arc::clone(runtime);
    let status_runtime = Arc::clone(runtime);
    let enter_suffix = config.enter_suffix;
    std::thread::spawn(move || {
        let result = rdev::listen(move |event| {
            let rdev::EventType::KeyPress(key) = event.event_type else {
                return;
            };
            if is_enter(key) && enter_suffix {
                flush_buffer(&hook_runtime);
                return;
            }
            // Deterministic VK-to-character mapping only. Card UIDs are hex, so
            // relying on the active keyboard layout (`Event.name` on Windows
            // runs AttachThreadInput + ToUnicodeEx for every keystroke) risks
            // wrong characters on non-US layouts and is slow enough to exceed
            // the low-level-hook timeout, after which Windows silently removes
            // the hook and the kiosk stops responding to card taps.
            if let Some(ch) = key_text(key) {
                push_char(&hook_runtime, ch);
            }
        });
        if let Err(error) = result {
            set_status(
                &status_runtime,
                ScannerState::Offline,
                "Scanner unavailable",
                Some(format!("keyboard hook failed: {error:?}")),
            );
        }
    });
}

/// Raw HID source: opens the configured device and extracts ASCII UIDs from its
/// input reports. Opt-in only (`scanner.mode = "hid"` plus vid/pid) so the app
/// never guesses which HID device is the reader.
fn spawn_hid(runtime: &Arc<Runtime>, config: ScannerConfig) {
    let runtime = Arc::clone(runtime);
    std::thread::spawn(move || {
        let api = match hidapi::HidApi::new() {
            Ok(api) => api,
            Err(error) => {
                set_status(
                    &runtime,
                    ScannerState::Offline,
                    "Scanner unavailable",
                    Some(format!("HID initialization failed: {error}")),
                );
                return;
            }
        };
        let (Some(vid), Some(pid)) = (config.hid_vid, config.hid_pid) else {
            set_status(
                &runtime,
                ScannerState::Error,
                "Scanner unavailable",
                Some("HID mode requires scanner.hid_vid and scanner.hid_pid in config.toml".into()),
            );
            return;
        };
        let device = match api.open(vid, pid) {
            Ok(device) => device,
            Err(error) => {
                set_status(
                    &runtime,
                    ScannerState::Offline,
                    "Scanner unavailable",
                    Some(format!("open HID {vid:04x}:{pid:04x} failed: {error}")),
                );
                return;
            }
        };
        set_status(
            &runtime,
            ScannerState::Connected,
            "Scanner connected",
            Some(format!("HID {vid:04x}:{pid:04x}")),
        );
        let mut report = [0u8; 256];
        loop {
            match device.read_timeout(&mut report, 100) {
                Ok(0) => continue,
                Ok(length) => feed_bytes(&runtime, &report[..length]),
                Err(error) => {
                    set_status(
                        &runtime,
                        ScannerState::Offline,
                        "Scanner unavailable",
                        Some(format!("HID read failed: {error}")),
                    );
                    break;
                }
            }
        }
    });
}

fn is_enter(key: rdev::Key) -> bool {
    matches!(key, rdev::Key::Return | rdev::Key::KpReturn)
}

/// Layout-independent fallback for drivers that do not populate `Event.name`.
/// Accepts only the characters keyboard-wedge readers actually send.
///
/// This is now the primary capture path: card UIDs are uppercase hex, so a
/// deterministic virtual-key mapping is always correct and never touches the
/// active keyboard layout or the slow Win32 name lookup.
fn key_text(key: rdev::Key) -> Option<char> {
    use rdev::Key::*;
    match key {
        Num0 | Kp0 => Some('0'),
        Num1 | Kp1 => Some('1'),
        Num2 | Kp2 => Some('2'),
        Num3 | Kp3 => Some('3'),
        Num4 | Kp4 => Some('4'),
        Num5 | Kp5 => Some('5'),
        Num6 | Kp6 => Some('6'),
        Num7 | Kp7 => Some('7'),
        Num8 | Kp8 => Some('8'),
        Num9 | Kp9 => Some('9'),
        KeyA => Some('A'),
        KeyB => Some('B'),
        KeyC => Some('C'),
        KeyD => Some('D'),
        KeyE => Some('E'),
        KeyF => Some('F'),
        KeyG => Some('G'),
        KeyH => Some('H'),
        KeyI => Some('I'),
        KeyJ => Some('J'),
        KeyK => Some('K'),
        KeyL => Some('L'),
        KeyM => Some('M'),
        KeyN => Some('N'),
        KeyO => Some('O'),
        KeyP => Some('P'),
        KeyQ => Some('Q'),
        KeyR => Some('R'),
        KeyS => Some('S'),
        KeyT => Some('T'),
        KeyU => Some('U'),
        KeyV => Some('V'),
        KeyW => Some('W'),
        KeyX => Some('X'),
        KeyY => Some('Y'),
        KeyZ => Some('Z'),
        _ => None,
    }
}

/// Feed raw report bytes from an HID reader into the shared scan buffer.
/// CR/LF finalizes the current scan; printable ASCII is accumulated.
fn feed_bytes(runtime: &Arc<Runtime>, bytes: &[u8]) {
    if runtime.handle.paused() {
        clear_buffer(runtime);
        return;
    }
    for &byte in bytes {
        if byte == b'\r' || byte == b'\n' {
            flush_buffer(runtime);
            continue;
        }
        if byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'-' | b' ') {
            push_char(runtime, byte as char);
        }
    }
}

// ---------------------------------------------------------------------------
// Shared pipeline
// ---------------------------------------------------------------------------

/// While paused (operator typing in admin/setup/manual entry) ignore the reader
/// stream and drop any partial buffer so it cannot flush as a false scan later.
fn clear_buffer(runtime: &Arc<Runtime>) {
    let mut buffer = runtime.buffer.lock().expect("scanner buffer lock");
    buffer.data.clear();
    buffer.last_at = Instant::now();
}

fn push_char(runtime: &Arc<Runtime>, ch: char) {
    if runtime.handle.paused() {
        clear_buffer(runtime);
        return;
    }
    let was_empty = {
        let mut buffer = runtime.buffer.lock().expect("scanner buffer lock");
        let was_empty = buffer.data.is_empty();
        if buffer.data.len() < 256 {
            buffer.data.push(ch);
        }
        buffer.last_at = Instant::now();
        was_empty
    };
    if was_empty {
        set_status(runtime, ScannerState::Scanning, "Scan received", None);
    }
}

fn flush_buffer(runtime: &Arc<Runtime>) {
    let value = {
        let mut buffer = runtime.buffer.lock().expect("scanner buffer lock");
        if buffer.data.is_empty() {
            return;
        }
        let value = std::mem::take(&mut buffer.data);
        buffer.last_at = Instant::now();
        value
    };
    emit_scan(runtime, value);
}

#[derive(Debug)]
enum ScanParse {
    Valid(String),
    Invalid(String),
    /// Not a scan attempt (too short / separators only): ignore silently.
    Ignored,
}

/// Sanitize and normalize a raw reader string into a card UID.
///
/// Rules mirror the backend exactly (uppercase hex, 4..=64 characters) so the
/// native layer never accepts something the attendance writer would reject, and
/// never drops something it would accept. Separators (`:`, `-`, space) are
/// stripped so formatted UIDs still work.
fn normalize(raw: &str) -> ScanParse {
    let mut hex = String::with_capacity(raw.len());
    let mut saw_non_hex_alnum = false;
    let mut saw_content = false;
    for ch in raw.chars() {
        if ch.is_ascii_hexdigit() {
            saw_content = true;
            hex.push(ch.to_ascii_uppercase());
        } else if ch.is_ascii_alphanumeric() {
            saw_content = true;
            saw_non_hex_alnum = true;
        }
        // whitespace and punctuation separators are skipped
    }
    if !saw_content || hex.is_empty() {
        return ScanParse::Ignored;
    }
    if saw_non_hex_alnum {
        return ScanParse::Invalid(format!("non-hex characters in reader input: {raw:?}"));
    }
    if hex.len() < 4 {
        return ScanParse::Invalid(format!("card ID too short ({} digits)", hex.len()));
    }
    if hex.len() > 64 {
        return ScanParse::Invalid(format!("card ID too long ({} digits)", hex.len()));
    }
    ScanParse::Valid(hex)
}

fn emit_scan(runtime: &Arc<Runtime>, raw: String) {
    if runtime.handle.paused() {
        return;
    }
    match normalize(&raw) {
        ScanParse::Valid(uid) => {
            if is_recent(runtime, &uid) {
                return;
            }
            let _ = runtime.app.emit(SCAN_EVENT, uid);
            set_status(runtime, ScannerState::Connected, "Waiting for card", None);
        }
        ScanParse::Invalid(detail) => {
            set_status(runtime, ScannerState::Error, "Invalid scan format", Some(detail));
            // Auto-recover to waiting shortly after a bad read so the kiosk
            // does not stay stuck in the error state after one bad tap.
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
/// one physical tap never becomes two scan requests. The backend's own guard
/// and 10 s physical cooldown remain the source of truth for the UI's
/// "already scanned" feedback.
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

fn set_status(
    runtime: &Arc<Runtime>,
    state: ScannerState,
    message: &str,
    detail: Option<String>,
) {
    let status = ScannerStatus {
        state,
        message: message.to_string(),
        detail,
        mode: mode_label(runtime.handle.config.mode),
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
    use super::{key_text, normalize, ScanParse};
    use rdev::Key;

    fn valid(raw: &str) -> String {
        match normalize(raw) {
            ScanParse::Valid(uid) => uid,
            other => panic!("expected valid scan for {raw:?}, got {other:?}"),
        }
    }

    #[test]
    fn key_text_covers_hex_digits_and_letters_layout_independently() {
        assert_eq!(key_text(Key::Num0), Some('0'));
        assert_eq!(key_text(Key::Num9), Some('9'));
        assert_eq!(key_text(Key::Kp5), Some('5'));
        assert_eq!(key_text(Key::KeyA), Some('A'));
        assert_eq!(key_text(Key::KeyF), Some('F'));
        assert_eq!(key_text(Key::KeyZ), Some('Z'));
        // Non-UID keys never enter the scan buffer.
        assert_eq!(key_text(Key::SemiColon), None);
        assert_eq!(key_text(Key::Space), None);
        assert_eq!(key_text(Key::Return), None);
        assert_eq!(key_text(Key::Tab), None);
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
    fn rejects_non_hex_content() {
        assert!(matches!(
            normalize("CARD1234"),
            ScanParse::Invalid(_)
        ));
        assert!(matches!(normalize("hello"), ScanParse::Invalid(_)));
    }

    #[test]
    fn ignores_separator_only_or_too_short_input() {
        assert!(matches!(normalize(""), ScanParse::Ignored));
        assert!(matches!(normalize("--::  "), ScanParse::Ignored));
        assert!(matches!(normalize("12"), ScanParse::Invalid(_)));
    }

    #[test]
    fn rejects_overlong_input() {
        assert!(matches!(
            normalize(&"A".repeat(65)),
            ScanParse::Invalid(_)
        ));
    }
}
