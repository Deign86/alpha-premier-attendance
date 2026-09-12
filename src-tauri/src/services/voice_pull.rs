//! Automatic Ma'am Bea name-clip pull worker (kiosk side only).
//!
//! Flow: registration saves enqueue a [`PENDING`](voice_jobs) row; [`run_once`]
//! claims the oldest due job, asks the configured LAN VoiceStudio host to
//! synthesize it (`POST /v1/audio/speech`, Bea voice profile, mp3), and stores
//! the bytes under `<data_dir>/voices/bea/names/<person_id>.mp3`.
//!
//! Nothing is installed on the VoiceStudio host — its built-in HTTP API is the
//! only remote surface. Failures re-queue with exponential backoff and are
//! log-only: a missing clip falls back to live Piper speech (Tier 2), so the
//! kiosk scan path can never break because of voice generation.

use sqlx::{Row, SqlitePool};
use std::path::PathBuf;

pub const DEFAULT_VOICESTUDIO_BASE_URL: &str = "http://127.0.0.1:3900";
const SETTINGS_HOST_KEY: &str = "voicestudio_base_url";
const SETTINGS_PIN_KEY: &str = "voicestudio_pin";
const PIN_HEADER: &str = "X-OmniVoice-Pin";
const VOICE_MODEL: &str = "tts-1";
const MAX_BACKOFF_SECS: i64 = 6 * 3600;

/// Port of `normalizePronunciation` in `scripts/generate_existing_intern_names.ts`
/// (minus per-person overrides, which stay a batch-script concern): expand the
/// `Ma.` prefix, drop middle-initial tokens (`O.`), and dehyphenate `Ar-jee`.
pub fn spoken_text_for_voice(full_name: &str) -> String {
    let clean = full_name.trim();
    if clean.is_empty() || clean.starts_with("Admin Rfid") {
        return clean.to_string();
    }
    let expanded = if let Some(rest) = clean.strip_prefix("Ma. ") {
        format!("Maria {rest}")
    } else if let Some(rest) = clean.strip_prefix("Ma ") {
        format!("Maria {rest}")
    } else {
        clean.to_string()
    };
    let parts: Vec<&str> = expanded
        .split_whitespace()
        .filter(|p| {
            let chars: Vec<char> = p.chars().collect();
            !(chars.len() == 2 && chars[1] == '.' && chars[0].is_ascii_alphabetic())
        })
        .collect();
    parts.join(" ").replace("Ar-jee", "Arjee")
}

/// Trim, drop trailing slashes, accept only `http(s)` URLs; else the default.
/// Bare `host:port` / `host` gets a plain-LAN `http://` prefix.
pub fn normalize_host(raw: &str) -> String {
    let trimmed = raw.trim();
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let cleaned = with_scheme.trim_end_matches('/').to_string();
    let lower = cleaned.to_ascii_lowercase();
    let has_scheme = lower.starts_with("http://") || lower.starts_with("https://");
    // Bare words without a dot, port, or localhost are not addresses ("junk").
    let authority = cleaned
        .split("://")
        .nth(1)
        .unwrap_or("")
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("");
    let plausible =
        authority.contains('.') || authority.contains(':') || authority.eq_ignore_ascii_case("localhost");
    if has_scheme && cleaned.len() > 10 && plausible && !cleaned.chars().any(|c| c.is_whitespace()) {
        cleaned
    } else {
        DEFAULT_VOICESTUDIO_BASE_URL.to_string()
    }
}

/// Backoff after `attempts` failures: 1m, 2m, 4m … capped at 6h.
pub fn backoff_secs(attempts: i64) -> i64 {
    let shift = attempts.clamp(0, 12) as u32;
    (60_i64.saturating_mul(2_i64.saturating_pow(shift))).min(MAX_BACKOFF_SECS)
}

/// Enqueue (or re-queue after a rename) a generation job. Fire-and-forget.
pub async fn enqueue_voice_job(db: &SqlitePool, person_id: &str, full_name: &str, now: &str) {
    let spoken = spoken_text_for_voice(full_name);
    if spoken.is_empty() {
        return;
    }
    let _ = sqlx::query(
        "INSERT INTO voice_jobs (person_id, spoken_text, status, attempts, last_error, next_attempt_at, created_at, updated_at) \
         VALUES (?, ?, 'PENDING', 0, NULL, ?, ?, ?) \
         ON CONFLICT(person_id) DO UPDATE SET spoken_text = excluded.spoken_text, status = 'PENDING', attempts = 0, last_error = NULL, next_attempt_at = excluded.next_attempt_at, updated_at = excluded.updated_at",
    )
    .bind(person_id)
    .bind(&spoken)
    .bind(now)
    .bind(now)
    .bind(now)
    .execute(db)
    .await;
}

/// Read the configured VoiceStudio host (UI-persisted), else the default.
pub async fn get_host(db: &SqlitePool) -> String {
    read_setting(db, SETTINGS_HOST_KEY)
        .await
        .map(|v| normalize_host(&v))
        .unwrap_or_else(|| DEFAULT_VOICESTUDIO_BASE_URL.to_string())
}

async fn store_setting(db: &SqlitePool, key: &str, value: &str, now: &str) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(key)
    .bind(value)
    .bind(now)
    .execute(db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Persist the UI-provided host; returns the normalized value.
pub async fn set_host(db: &SqlitePool, raw: &str, now: &str) -> Result<String, String> {
    let host = normalize_host(raw);
    store_setting(db, SETTINGS_HOST_KEY, &host, now).await?;
    Ok(host)
}

/// Read the configured share PIN (empty when the host needs none).
pub async fn get_pin(db: &SqlitePool) -> String {
    read_setting(db, SETTINGS_PIN_KEY).await.unwrap_or_default()
}

/// Persist the UI-provided share PIN (trimmed; empty clears it).
pub async fn set_pin(db: &SqlitePool, raw: &str, now: &str) -> Result<(), String> {
    store_setting(db, SETTINGS_PIN_KEY, raw.trim(), now).await
}

async fn read_setting(db: &SqlitePool, key: &str) -> Option<String> {
    sqlx::query_scalar("SELECT value FROM app_settings WHERE key = ?")
        .bind(key)
        .fetch_optional(db)
        .await
        .unwrap_or(None)
}

/// Absolute path of a worker-generated clip, when present on disk.
pub fn clip_path(data_dir: &std::path::Path, person_id: &str) -> PathBuf {
    data_dir
        .join("voices")
        .join("bea")
        .join("names")
        .join(format!("{person_id}.mp3"))
}

async fn discover_bea_profile(client: &reqwest::Client, host: &str, pin: &str) -> Result<String, String> {
    let mut request = client.get(format!("{host}/profiles"));
    if !pin.is_empty() {
        request = request.header(PIN_HEADER, pin);
    }
    let profiles: serde_json::Value = request
        .send()
        .await
        .map_err(|e| format!("profiles request failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("profiles request failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("profiles parse failed: {e}"))?;
    let found = profiles
        .as_array()
        .map(|list| {
            list.iter().find_map(|p| {
                let name = p.get("name").and_then(|n| n.as_str()).unwrap_or("");
                let id = p.get("id").and_then(|i| i.as_str()).unwrap_or("");
                if !id.is_empty() && name.to_ascii_lowercase().contains("bea") {
                    Some(id.to_string())
                } else {
                    None
                }
            })
        })
        .flatten();
    found.ok_or_else(|| "no voice profile named like 'Bea' on VoiceStudio host".to_string())
}

/// Reachability probe result for the Test Connection button.
#[derive(Debug, Clone, serde::Serialize)]
pub struct VoiceConnectionStatus {
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct VoiceClipState {
    pub personId: String,
    pub workerClip: bool,
    pub jobStatus: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct VoiceWorkerStatus {
    pub active: i64,
    pub retry: i64,
    pub lastPersonId: Option<String>,
    pub lastCompletedAt: Option<String>,
    pub lastSpokenText: Option<String>,
    pub lastError: Option<String>,
}

#[derive(Debug)]
pub struct VoicePullSummary {
    pub attemptedPersonId: Option<String>,
    pub completed: bool,
}

pub async fn check_connection(db: &SqlitePool) -> VoiceConnectionStatus {
    let host = get_host(db).await;
    let pin = get_pin(db).await;
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
    {
        Ok(client) => client,
        Err(e) => return VoiceConnectionStatus { ok: false, message: format!("HTTP client failed: {e}") },
    };
    let mut request = client.get(format!("{host}/profiles"));
    if !pin.is_empty() {
        request = request.header(PIN_HEADER, pin);
    }
    match request.send().await {
        Err(_) => VoiceConnectionStatus {
            ok: false,
            message: format!("Cannot reach VoiceStudio at {host}. Check the address and that VoiceStudio is running."),
        },
        Ok(response) => {
            let status = response.status();
            if status.is_success() {
                VoiceConnectionStatus { ok: true, message: format!("Connected to VoiceStudio at {host}.") }
            } else if status.as_u16() == 401 {
                VoiceConnectionStatus { ok: false, message: format!("VoiceStudio at {host} needs its share PIN — enter it below.") }
            } else {
                VoiceConnectionStatus { ok: false, message: format!("VoiceStudio at {host} replied with HTTP {status}.") }
            }
        }
    }
}

/// Live worker snapshot for the admin Voice panel: queue depth plus the most
/// recent completion and failure (all derived from `voice_jobs`, no new table).
pub async fn worker_status(db: &SqlitePool) -> Result<VoiceWorkerStatus, String> {
    let active: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM voice_jobs WHERE status IN ('PENDING','PROCESSING')",
    )
    .fetch_one(db)
    .await
    .map_err(|e| e.to_string())?;
    let retry: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM voice_jobs WHERE status = 'RETRY'")
            .fetch_one(db)
            .await
            .map_err(|e| e.to_string())?;
    let last_done: Option<(String, String, String)> = sqlx::query_as(
        "SELECT person_id, spoken_text, updated_at FROM voice_jobs WHERE status = 'DONE' ORDER BY updated_at DESC LIMIT 1",
    )
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?;
    let last_error: Option<String> = sqlx::query_scalar(
        "SELECT last_error FROM voice_jobs WHERE last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
    )
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(VoiceWorkerStatus {
        active,
        retry,
        lastPersonId: last_done.as_ref().map(|(id, _, _)| id.clone()),
        lastSpokenText: last_done.as_ref().map(|(_, text, _)| text.clone()),
        lastCompletedAt: last_done.map(|(_, _, at)| at),
        lastError: last_error,
    })
}

/// Snapshot every roster member's clip state in one call for the Users table:
/// worker mp3 on disk wins, else the live queue row, else bundled-manifest fallback.
pub async fn clip_states(db: &SqlitePool, data_dir: &std::path::Path) -> Result<Vec<VoiceClipState>, String> {
    let users: Vec<(String,)> = sqlx::query_as(
        "SELECT user_id FROM users WHERE status = 'ACTIVE' AND employee_type IN ('INTERN', 'EMPLOYEE') AND (card_type IS NULL OR card_type != 'ADMIN_ASSIST') ORDER BY user_id ASC",
    )
    .fetch_all(db)
    .await
    .map_err(|e| e.to_string())?;
    let mut states = Vec::with_capacity(users.len());
    for (person_id,) in users {
        let job_status: Option<String> =
            sqlx::query_scalar("SELECT status FROM voice_jobs WHERE person_id = ?")
                .bind(&person_id)
                .fetch_optional(db)
                .await
                .map_err(|e| e.to_string())?;
        states.push(VoiceClipState {
            workerClip: clip_path(data_dir, &person_id).is_file(),
            jobStatus: job_status,
            personId: person_id,
        });
    }
    Ok(states)
}

/// Re-queue a fresh pull for one person (Regenerate button). Returns spoken text.
pub async fn regenerate(db: &SqlitePool, person_id: &str) -> Result<String, String> {
    let clean = person_id.trim();
    if clean.is_empty() {
        return Err("PERSON_REQUIRED".to_string());
    }
    let full_name: Option<String> =
        sqlx::query_scalar("SELECT full_name FROM users WHERE user_id = ?")
            .bind(clean)
            .fetch_optional(db)
            .await
            .map_err(|e| e.to_string())?;
    let Some(full_name) = full_name else {
        return Err("USER_NOT_FOUND".to_string());
    };
    let now = chrono::Utc::now().to_rfc3339();
    enqueue_voice_job(db, clean, &full_name, &now).await;
    Ok(spoken_text_for_voice(&full_name))
}

/// Claim the oldest due job and pull its clip. No due job is a no-op success.
pub async fn run_once(
    db: &SqlitePool,
    data_dir: &std::path::Path,
) -> Result<VoicePullSummary, String> {
    let now = chrono::Utc::now().to_rfc3339();
    let row = sqlx::query(
        "SELECT person_id, spoken_text, attempts FROM voice_jobs WHERE status IN ('PENDING','RETRY') AND next_attempt_at <= ? ORDER BY next_attempt_at ASC, person_id ASC LIMIT 1",
    )
    .bind(&now)
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?;
    let Some(row) = row else {
        return Ok(VoicePullSummary { attemptedPersonId: None, completed: false });
    };
    let person_id: String = row.get("person_id");
    let spoken_text: String = row.get("spoken_text");
    let attempts: i64 = row.get("attempts");

    let claimed = sqlx::query(
        "UPDATE voice_jobs SET status = 'PROCESSING', updated_at = ? WHERE person_id = ? AND status IN ('PENDING','RETRY')",
    )
    .bind(&now)
    .bind(&person_id)
    .execute(db)
    .await
    .map_err(|e| e.to_string())?;
    if claimed.rows_affected() != 1 {
        return Ok(VoicePullSummary { attemptedPersonId: None, completed: false });
    }

    match pull_clip(db, data_dir, &person_id, &spoken_text).await {
        Ok(()) => {
            let done_at = chrono::Utc::now().to_rfc3339();
            sqlx::query(
                "UPDATE voice_jobs SET status = 'DONE', last_error = NULL, updated_at = ? WHERE person_id = ?",
            )
            .bind(&done_at)
            .bind(&person_id)
            .execute(db)
            .await
            .map_err(|e| e.to_string())?;
            Ok(VoicePullSummary { attemptedPersonId: Some(person_id), completed: true })
        }
        Err(error) => {
            let retry_at = chrono::Utc::now() + chrono::Duration::seconds(backoff_secs(attempts));
            sqlx::query(
                "UPDATE voice_jobs SET status = 'RETRY', attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE person_id = ?",
            )
            .bind(attempts + 1)
            .bind(&error)
            .bind(retry_at.to_rfc3339())
            .bind(&now)
            .bind(&person_id)
            .execute(db)
            .await
            .map_err(|e| e.to_string())?;
            Err(error)
        }
    }
}

async fn pull_clip(
    db: &SqlitePool,
    data_dir: &std::path::Path,
    person_id: &str,
    spoken_text: &str,
) -> Result<(), String> {
    let host = get_host(db).await;
    let pin = get_pin(db).await;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| format!("http client failed: {e}"))?;
    let profile_id = discover_bea_profile(&client, &host, &pin).await?;
    let mut request = client
        .post(format!("{host}/v1/audio/speech"))
        .json(&serde_json::json!({
            "model": VOICE_MODEL,
            "input": spoken_text,
            "voice": profile_id,
            "response_format": "mp3",
        }));
    if !pin.is_empty() {
        request = request.header(PIN_HEADER, pin);
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("speech request failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("speech request failed: {e}"))?;
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    // Repo audio standard is mp3; VoiceStudio answers wav when its host lacks
    // ffmpeg — refuse it loudly instead of storing a non-standard clip.
    if !content_type.contains("mpeg") && !content_type.contains("mp3") {
        return Err(format!("host returned {content_type}, not mp3 (install ffmpeg on the VoiceStudio PC)"));
    }
    let bytes = response.bytes().await.map_err(|e| format!("read audio failed: {e}"))?;
    if bytes.len() < 100 {
        return Err("host returned an empty clip".to_string());
    }
    let path = clip_path(data_dir, person_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create voices dir failed: {e}"))?;
    }
    std::fs::write(&path, &bytes).map_err(|e| format!("save clip failed: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spoken_text_expands_ma_prefix() {
        assert_eq!(spoken_text_for_voice("Ma. Teresa Carandang"), "Maria Teresa Carandang");
        assert_eq!(spoken_text_for_voice("Ma Ellaine Zapico"), "Maria Ellaine Zapico");
    }

    #[test]
    fn spoken_text_drops_middle_initials_and_dehyphenates() {
        assert_eq!(spoken_text_for_voice("Deign Grey O. Lazaro"), "Deign Grey Lazaro");
        assert_eq!(spoken_text_for_voice("Ar-jee Felizarte"), "Arjee Felizarte");
    }

    #[test]
    fn spoken_text_passes_admin_rfid_through() {
        assert_eq!(spoken_text_for_voice("Admin Rfid Tester"), "Admin Rfid Tester");
        assert_eq!(spoken_text_for_voice("   "), "");
    }

    #[test]
    fn host_normalization_accepts_lan_hosts_and_rejects_junk() {
        assert_eq!(normalize_host("http://192.168.1.50:3900"), "http://192.168.1.50:3900");
        assert_eq!(normalize_host("http://192.168.1.50:3900/"), "http://192.168.1.50:3900");
        assert_eq!(normalize_host("  https://gaming-pc:3900  "), "https://gaming-pc:3900");
        assert_eq!(normalize_host(""), DEFAULT_VOICESTUDIO_BASE_URL);
        assert_eq!(normalize_host("not a url"), DEFAULT_VOICESTUDIO_BASE_URL);
        assert_eq!(normalize_host("ftp://host/voices"), DEFAULT_VOICESTUDIO_BASE_URL);
    }

    #[test]
    fn backoff_grows_exponentially_and_caps() {
        assert_eq!(backoff_secs(0), 60);
        assert_eq!(backoff_secs(1), 120);
        assert_eq!(backoff_secs(3), 480);
        assert_eq!(backoff_secs(100), MAX_BACKOFF_SECS);
    }

    async fn memory_db() -> SqlitePool {
        let db = SqlitePool::connect(":memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE voice_jobs (person_id TEXT PRIMARY KEY NOT NULL, spoken_text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
        )
        .execute(&db)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE app_settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL)",
        )
        .execute(&db)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE users (user_id TEXT PRIMARY KEY NOT NULL, full_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE', employee_type TEXT NOT NULL DEFAULT 'INTERN', card_type TEXT)",
        )
        .execute(&db)
        .await
        .unwrap();
        db
    }

    #[tokio::test]
    async fn enqueue_upserts_and_resets_on_rename() {
        let db = memory_db().await;
        let now = "2026-09-12T00:00:00Z";
        enqueue_voice_job(&db, "APG-1", "Ma. Teresa Carandang", now).await;
        let text: String = sqlx::query_scalar("SELECT spoken_text FROM voice_jobs WHERE person_id = 'APG-1'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(text, "Maria Teresa Carandang");
        enqueue_voice_job(&db, "APG-1", "Teresa Carandang-Dela Cruz", now).await;
        let (status, attempts): (String, i64) =
            sqlx::query_as("SELECT status, attempts FROM voice_jobs WHERE person_id = 'APG-1'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(status, "PENDING");
        assert_eq!(attempts, 0);
    }

    #[tokio::test]
    async fn host_round_trips_through_settings() {
        let db = memory_db().await;
        assert_eq!(get_host(&db).await, DEFAULT_VOICESTUDIO_BASE_URL);
        let saved = set_host(&db, "http://192.168.1.50:3900/", "2026-09-12T00:00:00Z").await.unwrap();
        assert_eq!(saved, "http://192.168.1.50:3900");
        assert_eq!(get_host(&db).await, "http://192.168.1.50:3900");
        let fallback = set_host(&db, "junk", "2026-09-12T00:00:00Z").await.unwrap();
        assert_eq!(fallback, DEFAULT_VOICESTUDIO_BASE_URL);
    }

    #[tokio::test]
    async fn pin_round_trips_trimmed_through_settings() {
        let db = memory_db().await;
        assert_eq!(get_pin(&db).await, "");
        set_pin(&db, "  166387  ", "2026-09-12T00:00:00Z").await.unwrap();
        assert_eq!(get_pin(&db).await, "166387");
        set_pin(&db, "", "2026-09-12T00:00:00Z").await.unwrap();
        assert_eq!(get_pin(&db).await, "");
    }

    #[tokio::test]
    async fn regenerate_requeues_from_roster_name() {
        let db = memory_db().await;
        sqlx::query("INSERT INTO users (user_id, full_name, status, employee_type) VALUES ('APG-7', 'Ma. Teresa Carandang', 'ACTIVE', 'INTERN')")
            .execute(&db)
            .await
            .unwrap();
        let spoken = regenerate(&db, "APG-7").await.unwrap();
        assert_eq!(spoken, "Maria Teresa Carandang");
        let status: String =
            sqlx::query_scalar("SELECT status FROM voice_jobs WHERE person_id = 'APG-7'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(status, "PENDING");
        assert!(regenerate(&db, "NOPE").await.is_err());
    }

    #[tokio::test]
    async fn clip_states_cover_roster_only() {
        let db = memory_db().await;
        for (id, name, status, kind) in [
            ("APG-7", "Ada", "ACTIVE", "INTERN"),
            ("APG-8", "Bob", "INACTIVE", "INTERN"),
            ("ADM-1", "Root", "ACTIVE", "INTERN"),
        ] {
            let card: Option<&str> = if id == "ADM-1" { Some("ADMIN_ASSIST") } else { None };
            sqlx::query("INSERT INTO users (user_id, full_name, status, employee_type, card_type) VALUES (?, ?, ?, ?, ?)")
                .bind(id)
                .bind(name)
                .bind(status)
                .bind(kind)
                .bind(card)
                .execute(&db)
                .await
                .unwrap();
        }
        enqueue_voice_job(&db, "APG-7", "Ada", "2026-09-12T00:00:00Z").await;
        let dir = std::env::temp_dir().join(format!("alpha-voice-{}", uuid::Uuid::new_v4()));
        let states = clip_states(&db, &dir).await.unwrap();
        assert_eq!(states.len(), 1);
        assert_eq!(states[0].personId, "APG-7");
        assert!(!states[0].workerClip);
        assert_eq!(states[0].jobStatus.as_deref(), Some("PENDING"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn worker_status_reports_depth_and_latest() {
        let db = memory_db().await;
        let empty = worker_status(&db).await.unwrap();
        assert_eq!(empty.active, 0);
        assert_eq!(empty.retry, 0);
        assert!(empty.lastPersonId.is_none());
        enqueue_voice_job(&db, "APG-7", "Ada", "2026-09-12T00:00:00Z").await;
        sqlx::query("UPDATE voice_jobs SET status = 'DONE', updated_at = '2026-09-12T01:00:00Z' WHERE person_id = 'APG-7'")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("UPDATE voice_jobs SET status = 'RETRY', last_error = 'boom', updated_at = '2026-09-12T02:00:00Z' WHERE person_id = 'APG-7'")
            .execute(&db)
            .await
            .unwrap();
        let status = worker_status(&db).await.unwrap();
        assert_eq!(status.active, 0);
        assert_eq!(status.retry, 1);
        assert_eq!(status.lastError.as_deref(), Some("boom"));
    }

    #[tokio::test]
    async fn run_once_is_noop_without_due_jobs() {
        let db = memory_db().await;
        let summary = run_once(&db, std::path::Path::new("/tmp")).await.unwrap();
        assert!(summary.attemptedPersonId.is_none());
        assert!(!summary.completed);
    }

    #[tokio::test]
    async fn embedded_migrations_create_voice_tables() {
        let db = SqlitePool::connect(":memory:").await.unwrap();
        crate::state::MIGRATOR.run(&db).await.unwrap();
        let jobs: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('voice_jobs', 'app_settings')",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(jobs, 2);
    }

    /// Minimal loopback VoiceStudio: answers `/profiles` and `/v1/audio/speech`.
    async fn loopback_host(mp3_bytes: Vec<u8>) -> (String, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            for _ in 0..2 {
                let Ok((mut stream, _)) = listener.accept().await else { break };
                let mut buf = vec![0u8; 65536];
                let Ok(n) = stream.read(&mut buf).await else { break };
                let request = String::from_utf8_lossy(&buf[..n]).into_owned();
                let (content_type, body) = if request.starts_with("GET /profiles") {
                    ("application/json", b"[{\"id\":\"bea-1\",\"name\":\"Ma'am Bea\"}]".to_vec())
                } else {
                    ("audio/mpeg", mp3_bytes.clone())
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.write_all(&body).await;
            }
        });
        (format!("http://{addr}"), handle)
    }

    #[tokio::test]
    async fn run_once_pulls_clip_from_loopback_host() {
        let db = memory_db().await;
        let (host, server) = loopback_host(vec![0xFFu8; 512]).await;
        set_host(&db, &host, "2026-09-12T00:00:00Z").await.unwrap();
        enqueue_voice_job(&db, "APG-9", "Ma. Teresa Carandang", "2026-09-12T00:00:00Z").await;
        let dir = std::env::temp_dir().join(format!("alpha-voice-{}", uuid::Uuid::new_v4()));
        let summary = run_once(&db, &dir).await.unwrap();
        assert_eq!(summary.attemptedPersonId.as_deref(), Some("APG-9"));
        assert!(summary.completed);
        let saved = std::fs::read(dir.join("voices").join("bea").join("names").join("APG-9.mp3")).unwrap();
        assert_eq!(saved.len(), 512);
        let status: String =
            sqlx::query_scalar("SELECT status FROM voice_jobs WHERE person_id = 'APG-9'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(status, "DONE");
        let _ = std::fs::remove_dir_all(&dir);
        server.abort();
    }

    #[tokio::test]
    async fn run_once_retries_when_host_answers_wav() {
        let db = memory_db().await;
        // Serve a wav content-type: strict mp3 policy must fail loudly, not store.
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let Ok((mut stream, _)) = listener.accept().await else { break };
                let mut buf = vec![0u8; 65536];
                let Ok(n) = stream.read(&mut buf).await else { break };
                let request = String::from_utf8_lossy(&buf[..n]).into_owned();
                let (content_type, body): (&str, Vec<u8>) = if request.starts_with("GET /profiles") {
                    ("application/json", b"[{\"id\":\"bea-1\",\"name\":\"Ma'am Bea\"}]".to_vec())
                } else {
                    ("audio/wav", vec![0u8; 256])
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.write_all(&body).await;
            }
        });
        set_host(&db, &format!("http://{addr}"), "2026-09-12T00:00:00Z").await.unwrap();
        enqueue_voice_job(&db, "APG-8", "Ada Lovelace", "2026-09-12T00:00:00Z").await;
        let dir = std::env::temp_dir().join(format!("alpha-voice-{}", uuid::Uuid::new_v4()));
        let error = run_once(&db, &dir).await.unwrap_err();
        assert!(error.contains("not mp3"), "unexpected error: {error}");
        let (status, attempts): (String, i64) =
            sqlx::query_as("SELECT status, attempts FROM voice_jobs WHERE person_id = 'APG-8'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(status, "RETRY");
        assert_eq!(attempts, 1);
        assert!(!dir.join("voices").exists());
        let _ = std::fs::remove_dir_all(&dir);
        server.abort();
    }
}
