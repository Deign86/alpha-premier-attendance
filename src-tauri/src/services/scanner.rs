//! Native RFID scanner pipeline.
//!
//! The scanner interaction is the product: a card tap must be captured at the
//! native layer and turned into one clean scan event for the UI, without
//! depending on a focused webview text input.
//!
//! Two hardware modes are supported and normalized into one pipeline:
//! - `keyboard`: legacy keyboard-wedge configuration is recognized but not
//!   started by the background service because a generic hook cannot isolate
//!   the reader from ordinary foreground typing.
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
        let (state, message, detail) = if config.background_capture_allowed() {
            (ScannerState::Offline, "Scanner starting", None)
        } else {
            (
                ScannerState::Offline,
                "Keyboard wedge disabled for background scanning",
                Some("Configure a serial, vendor SDK, or uniquely addressed raw HID reader".into()),
            )
        };
        Self {
            config,
            status: Mutex::new(ScannerStatus {
                state,
                message: message.into(),
                detail,
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
        ScannerMode::Serial => "serial",
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

impl ScanBuffer {
    fn take_if_idle(&mut self, now: Instant, idle_timeout: Duration) -> Option<String> {
        if self.data.is_empty()
            || now.saturating_duration_since(self.last_at) < idle_timeout
        {
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
                buffer.take_if_idle(Instant::now(), idle_timeout)
            };
            if let Some(value) = value {
                emit_scan(&runtime, value);
            }
        });
    }

    match config.mode {
        ScannerMode::Keyboard => spawn_keyboard(&runtime, config),
        ScannerMode::Hid => spawn_hid(&runtime, config),
        ScannerMode::Serial => spawn_serial(&runtime, config),
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

/// Keyboard-wedge capture is handled by the foreground kiosk webview. The
/// native layer reports it as ready so the UI can enable that protected path;
/// it does not install a process-wide keyboard hook.
fn spawn_keyboard(runtime: &Arc<Runtime>, _config: ScannerConfig) {
    let _ = _config.enter_suffix;
    set_status(
        runtime,
        ScannerState::Connected,
        "Keyboard-wedge reader ready",
        Some("Scans are captured only while the kiosk window is active".into()),
    );
}

/// Serial source: reads ASCII bytes from a configured COM/tty device. This is
/// a device-specific transport and therefore does not touch foreground input.
fn spawn_serial(runtime: &Arc<Runtime>, config: ScannerConfig) {
    let runtime = Arc::clone(runtime);
    std::thread::spawn(move || {
        let Some(port_name) = config.serial_port.clone().filter(|value| !value.trim().is_empty()) else {
            set_status(
                &runtime,
                ScannerState::Error,
                "Scanner unavailable",
                Some("Serial mode requires scanner.serial_port".into()),
            );
            return;
        };
        let mut port = match serialport::new(&port_name, config.serial_baud_rate)
            .timeout(Duration::from_millis(100))
            .open()
        {
            Ok(port) => port,
            Err(error) => {
                set_status(
                    &runtime,
                    ScannerState::Offline,
                    "Scanner unavailable",
                    Some(format!("open serial device {port_name} failed: {error}")),
                );
                return;
            }
        };
        set_status(
            &runtime,
            ScannerState::Connected,
            "Scanner connected",
            Some(format!("serial {port_name}")),
        );
        let mut bytes = [0u8; 256];
        loop {
            match std::io::Read::read(&mut *port, &mut bytes) {
                Ok(0) => continue,
                Ok(length) => feed_bytes(&runtime, &bytes[..length]),
                Err(error) if error.kind() == std::io::ErrorKind::TimedOut => continue,
                Err(error) => {
                    set_status(
                        &runtime,
                        ScannerState::Offline,
                        "Scanner unavailable",
                        Some(format!("serial read failed: {error}")),
                    );
                    break;
                }
            }
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
    use super::{normalize, ScanBuffer, ScanParse};
    use std::time::{Duration, Instant};

    fn valid(raw: &str) -> String {
        match normalize(raw) {
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
