// Admin PIN storage and the email reset code.
//
// The PIN lives as a PBKDF2 hash in `app_settings`, set through the email reset.
// config.toml stays in charge: `admin_pin = ""` turns admin off, and an explicit
// `admin_pin` there replaces an emailed PIN (IT's way back if the inbox is
// lost). With no PIN anywhere, only admin RFID cards unlock until a reset sets
// one. Admin RFID cards are checked separately in `setup_unlock_impl` and are
// never touched here.
//
// Kept free of Tauri/AppState so `tests/admin_pin_isolated.rs` can include
// it directly on Windows (see docs/testing/rust-test-parity.md).

use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use chrono::{DateTime, Duration, Utc};
use ring::{
    pbkdf2,
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::num::NonZeroU32;

/// Fixed recipient, also hard-coded in scripts/pin-reset-mailer/Code.gs.
pub const RESET_RECIPIENT: &str = "thealphapremiergroup@gmail.com";
pub const CODE_TTL_MINUTES: i64 = 15;
const RESEND_COOLDOWN_SECONDS: i64 = 60;
const MAX_CODE_ATTEMPTS: u32 = 5;
/// Wrong codes allowed per 24h across all codes before requests are refused.
const MAX_DAILY_FAILURES: u32 = 10;
const PIN_HASH_KEY: &str = "admin_pin_hash";
const CONFIG_FINGERPRINT_KEY: &str = "admin_pin_config_fingerprint";
const RESET_KEY: &str = "admin_pin_reset";
const GUARD_KEY: &str = "admin_pin_reset_guard";
const UNLOCK_GUARD_KEY: &str = "admin_unlock_guard";
/// Owner decision D1 (2026-11-06): five wrong PINs in a row pause PIN
/// unlock for five minutes. Admin cards still unlock.
const UNLOCK_MAX_FAILURES: u32 = 5;
const UNLOCK_LOCK_MINUTES: i64 = 5;
const ITERATIONS: NonZeroU32 = match NonZeroU32::new(100_000) {
    Some(value) => value,
    None => panic!("PBKDF2 iterations must be non-zero"),
};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingReset {
    code_hash: String,
    expires_at: DateTime<Utc>,
    attempts: u32,
}

/// Survives voided/expired codes so the cooldown and daily cap can't be reset
/// by burning a code.
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ResetGuard {
    last_request_at: Option<DateTime<Utc>>,
    failures: u32,
    failure_window_start: Option<DateTime<Utc>>,
}

/// Wrong-PIN counter and lockout, stored in `app_settings` so a restart
/// does not lift the lock.
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct UnlockGuard {
    failures: u32,
    locked_until: Option<DateTime<Utc>>,
}

/// True while a wrong-PIN lockout is running.
pub async fn unlock_locked(db: &SqlitePool, now: DateTime<Utc>) -> Result<bool, String> {
    let guard: UnlockGuard = load_json(db, UNLOCK_GUARD_KEY).await?.unwrap_or_default();
    Ok(guard.locked_until.is_some_and(|until| until > now))
}

/// Counts one wrong PIN. Returns true when this one started the lockout.
/// The count is one SQL statement, so concurrent wrong PINs each count
/// (a read-then-write let them overwrite each other's count).
pub async fn record_unlock_failure(db: &SqlitePool, now: DateTime<Utc>) -> Result<bool, String> {
    ensure_settings_table(db).await?;
    let failures: i64 = sqlx::query_scalar(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?, json_object('failures', 1), ?) \
         ON CONFLICT(key) DO UPDATE SET value = json_set(value, '$.failures', COALESCE(json_extract(value, '$.failures'), 0) + 1), updated_at = excluded.updated_at \
         RETURNING json_extract(value, '$.failures')",
    )
    .bind(UNLOCK_GUARD_KEY)
    .bind(now.to_rfc3339())
    .fetch_one(db)
    .await
    .map_err(|e| e.to_string())?;
    let locked = failures >= i64::from(UNLOCK_MAX_FAILURES);
    if locked {
        let guard = UnlockGuard {
            failures: 0,
            locked_until: Some(now + Duration::minutes(UNLOCK_LOCK_MINUTES)),
        };
        save_json(db, UNLOCK_GUARD_KEY, &guard, now).await?;
    }
    Ok(locked)
}

/// A successful unlock starts the count again.
pub async fn clear_unlock_failures(db: &SqlitePool) -> Result<(), String> {
    delete_setting(db, UNLOCK_GUARD_KEY).await
}

/// A code that has been generated but is only stored once the email is sent.
pub struct NewResetCode {
    pub code: String,
    /// Shown on the kiosk and in the email subject to tell real emails from fakes.
    pub request_id: String,
    pending: PendingReset,
}

#[derive(Deserialize)]
struct MailerReply {
    success: bool,
    error: Option<String>,
}

/// Mailer endpoint baked in at build time (GitHub secret
/// `ALPHA_PREMIER_PIN_RESET_URL`). It is readable from the shipped binary, so
/// the mailer script caps sends and the kiosk caps guesses.
pub fn reset_mail_url() -> Option<&'static str> {
    option_env!("ALPHA_PREMIER_PIN_RESET_URL")
        .map(str::trim)
        .filter(|url| url.starts_with("https://"))
}

pub fn hash_secret(secret: &str) -> Result<String, String> {
    let mut salt = [0u8; 16];
    fill_random(&mut salt)?;
    let mut derived = [0u8; 32];
    pbkdf2::derive(pbkdf2::PBKDF2_HMAC_SHA256, ITERATIONS, &salt, secret.as_bytes(), &mut derived);
    Ok(format!(
        "pbkdf2-sha256${}${}${}",
        ITERATIONS,
        STANDARD_NO_PAD.encode(salt),
        STANDARD_NO_PAD.encode(derived)
    ))
}

/// Constant-time check against a `hash_secret` string; malformed input is a mismatch.
pub fn verify_secret(stored: &str, secret: &str) -> bool {
    let mut parts = stored.split('$');
    let (Some("pbkdf2-sha256"), Some(iterations), Some(salt), Some(derived), None) =
        (parts.next(), parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    let (Some(iterations), Ok(salt), Ok(derived)) = (
        iterations.parse().ok().and_then(NonZeroU32::new),
        STANDARD_NO_PAD.decode(salt),
        STANDARD_NO_PAD.decode(derived),
    ) else {
        return false;
    };
    pbkdf2::verify(pbkdf2::PBKDF2_HMAC_SHA256, iterations, &salt, secret.as_bytes(), &derived).is_ok()
}

/// New PINs are 6-12 digits and not trivially guessable (one repeated digit or a run like 123456 / 654321).
pub fn validate_new_pin(pin: &str) -> Result<(), String> {
    let digits = pin.as_bytes();
    let numeric = (6..=12).contains(&digits.len()) && digits.iter().all(u8::is_ascii_digit);
    let repeated = digits.windows(2).all(|pair| pair[0] == pair[1]);
    let run = digits.windows(2).all(|pair| pair[1] == pair[0] + 1) || digits.windows(2).all(|pair| pair[0] == pair[1] + 1);
    if numeric && !repeated && !run {
        Ok(())
    } else {
        Err("INVALID_NEW_PIN".into())
    }
}

fn fill_random(bytes: &mut [u8]) -> Result<(), String> {
    SystemRandom::new().fill(bytes).map_err(|_| "RNG_UNAVAILABLE".to_string())
}

/// Detects a config.toml PIN edit; that file already holds the PIN in plain text.
fn config_fingerprint(config_pin: &str) -> String {
    STANDARD_NO_PAD.encode(Sha256::digest(config_pin.as_bytes()))
}

/// The settings table is created on first use (the module also runs on a
/// bare database in the isolated harness).
async fn ensure_settings_table(db: &SqlitePool) -> Result<(), String> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL)",
    )
    .execute(db)
    .await
    .map(|_| ())
    .map_err(|e| e.to_string())
}

async fn get_setting(db: &SqlitePool, key: &str) -> Result<Option<String>, String> {
    ensure_settings_table(db).await?;
    sqlx::query_scalar("SELECT value FROM app_settings WHERE key = ?")
        .bind(key)
        .fetch_optional(db)
        .await
        .map_err(|e| e.to_string())
}

async fn put_setting(db: &SqlitePool, key: &str, value: &str, now: DateTime<Utc>) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(key)
    .bind(value)
    .bind(now.to_rfc3339())
    .execute(db)
    .await
    .map(|_| ())
    .map_err(|e| e.to_string())
}

async fn delete_setting(db: &SqlitePool, key: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM app_settings WHERE key = ?")
        .bind(key)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

async fn load_json<T: serde::de::DeserializeOwned>(db: &SqlitePool, key: &str) -> Result<Option<T>, String> {
    Ok(get_setting(db, key).await?.and_then(|raw| serde_json::from_str(&raw).ok()))
}

async fn save_json<T: Serialize>(db: &SqlitePool, key: &str, value: &T, now: DateTime<Utc>) -> Result<(), String> {
    let raw = serde_json::to_string(value).map_err(|e| e.to_string())?;
    put_setting(db, key, &raw, now).await
}

/// The emailed PIN hash, unless config.toml's `admin_pin` changed since that
/// reset; then the config PIN wins and the stale hash is removed.
pub async fn effective_pin_hash(db: &SqlitePool, config_pin: Option<&str>) -> Result<Option<String>, String> {
    let Some(hash) = get_setting(db, PIN_HASH_KEY).await? else {
        return Ok(None);
    };
    let fingerprint = get_setting(db, CONFIG_FINGERPRINT_KEY).await?;
    // Only an explicit config.toml PIN can override; an unset one never does.
    let overridden = config_pin
        .filter(|pin| !pin.is_empty())
        .is_some_and(|pin| fingerprint.as_deref().is_some_and(|value| value != config_fingerprint(pin)));
    if overridden {
        delete_setting(db, PIN_HASH_KEY).await?;
        delete_setting(db, CONFIG_FINGERPRINT_KEY).await?;
        return Ok(None);
    }
    Ok(Some(hash))
}

/// Generate a reset code after the cooldown and daily-failure checks. Nothing
/// replaces the current code until `commit_reset` runs after a sent email.
pub async fn begin_reset(db: &SqlitePool, now: DateTime<Utc>) -> Result<NewResetCode, String> {
    ensure_settings_table(db).await?;
    // Claim the request in one statement: only when the resend cooldown has
    // passed and the daily cap is not hit, and touching only lastRequestAt.
    // The old read-check-write let two requests both pass (two codes
    // emailed) and wrote a stale failure count back over a newer one (O12).
    let now_text = now.to_rfc3339();
    let claimed: Option<i64> = sqlx::query_scalar(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?, json_object('lastRequestAt', ?, 'failures', 0), ?) \
         ON CONFLICT(key) DO UPDATE SET value = json_set(value, '$.lastRequestAt', ?), updated_at = excluded.updated_at \
         WHERE (json_extract(value, '$.lastRequestAt') IS NULL \
                OR julianday(?) >= julianday(json_extract(value, '$.lastRequestAt')) + ? / 86400.0) \
           AND NOT (COALESCE(json_extract(value, '$.failures'), 0) >= ? \
                AND json_extract(value, '$.failureWindowStart') IS NOT NULL \
                AND julianday(?) < julianday(json_extract(value, '$.failureWindowStart')) + 1.0) \
         RETURNING 1",
    )
    .bind(GUARD_KEY)
    .bind(&now_text)
    .bind(&now_text)
    .bind(&now_text)
    .bind(&now_text)
    .bind(RESEND_COOLDOWN_SECONDS)
    .bind(MAX_DAILY_FAILURES)
    .bind(&now_text)
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?;
    if claimed.is_none() {
        // Refused: say why from the record that refused it.
        let guard: ResetGuard = load_json(db, GUARD_KEY).await?.unwrap_or_default();
        let locked = guard.failures >= MAX_DAILY_FAILURES
            && guard.failure_window_start.is_some_and(|start| now < start + Duration::hours(24));
        return Err(if locked { "RESET_LOCKED" } else { "RESET_RATE_LIMITED" }.into());
    }

    let mut bytes = [0u8; 7];
    fill_random(&mut bytes)?;
    let code = format!("{:06}", u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) % 1_000_000);
    let request_id = format!("{:02X}{:02X}{:02X}", bytes[4], bytes[5], bytes[6]);
    let pending = PendingReset {
        code_hash: hash_secret(&code)?,
        expires_at: now + Duration::minutes(CODE_TTL_MINUTES),
        attempts: 0,
    };
    Ok(NewResetCode { code, request_id, pending })
}

/// Make a sent code the active one (replaces any earlier code).
pub async fn commit_reset(db: &SqlitePool, reset: &NewResetCode, now: DateTime<Utc>) -> Result<(), String> {
    save_json(db, RESET_KEY, &reset.pending, now).await
}

/// Counts one wrong code toward the daily cap in one statement (a fresh
/// 24-hour window starts at 1), so wrong codes sent at once all count (O12).
async fn record_failure(db: &SqlitePool, now: DateTime<Utc>) -> Result<(), String> {
    ensure_settings_table(db).await?;
    let now_text = now.to_rfc3339();
    sqlx::query(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?, json_object('failures', 1, 'failureWindowStart', ?), ?) \
         ON CONFLICT(key) DO UPDATE SET value = CASE \
             WHEN json_extract(value, '$.failureWindowStart') IS NULL \
               OR julianday(?) >= julianday(json_extract(value, '$.failureWindowStart')) + 1.0 \
             THEN json_set(value, '$.failures', 1, '$.failureWindowStart', ?) \
             ELSE json_set(value, '$.failures', COALESCE(json_extract(value, '$.failures'), 0) + 1) \
           END, updated_at = excluded.updated_at",
    )
    .bind(GUARD_KEY)
    .bind(&now_text)
    .bind(&now_text)
    .bind(&now_text)
    .bind(&now_text)
    .execute(db)
    .await
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Check the emailed code and replace the admin PIN. A bad new PIN does not
/// spend an attempt; the fifth wrong code (or expiry) voids the code.
pub async fn complete_reset(
    db: &SqlitePool,
    code: &str,
    new_pin: &str,
    config_pin: Option<&str>,
    now: DateTime<Utc>,
) -> Result<(), String> {
    validate_new_pin(new_pin)?;
    let Some(pending) = load_json::<PendingReset>(db, RESET_KEY).await? else {
        return Err("RESET_CODE_EXPIRED".into());
    };
    if now > pending.expires_at || pending.attempts >= MAX_CODE_ATTEMPTS {
        delete_setting(db, RESET_KEY).await?;
        return Err("RESET_CODE_EXPIRED".into());
    }
    // Spend the attempt before checking the code, in one SQL statement: a
    // read-check-write let concurrent wrong codes all write back the same
    // count and outrun the 5-attempt limit (S3).
    let spent: Option<i64> = sqlx::query_scalar(
        "UPDATE app_settings SET value = json_set(value, '$.attempts', COALESCE(json_extract(value, '$.attempts'), 0) + 1), updated_at = ? \
         WHERE key = ? RETURNING json_extract(value, '$.attempts')",
    )
    .bind(now.to_rfc3339())
    .bind(RESET_KEY)
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?;
    let Some(spent) = spent else {
        return Err("RESET_CODE_EXPIRED".into());
    };
    if spent > i64::from(MAX_CODE_ATTEMPTS) {
        delete_setting(db, RESET_KEY).await?;
        return Err("RESET_CODE_EXPIRED".into());
    }
    if !verify_secret(&pending.code_hash, code.trim()) {
        record_failure(db, now).await?;
        if spent >= i64::from(MAX_CODE_ATTEMPTS) {
            delete_setting(db, RESET_KEY).await?;
            return Err("RESET_CODE_EXPIRED".into());
        }
        return Err("RESET_CODE_INVALID".into());
    }
    put_setting(db, PIN_HASH_KEY, &hash_secret(new_pin)?, now).await?;
    put_setting(db, CONFIG_FINGERPRINT_KEY, &config_fingerprint(config_pin.unwrap_or("")), now).await?;
    delete_setting(db, RESET_KEY).await?;
    delete_setting(db, GUARD_KEY).await
}

/// POST the code to the Apps Script mailer, which emails RESET_RECIPIENT.
pub async fn send_reset_email(url: &str, reset: &NewResetCode, requested_at: DateTime<Utc>) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let reply: MailerReply = client
        .post(url)
        .json(&serde_json::json!({
            "code": reset.code,
            "requestId": reset.request_id,
            "requestedAt": requested_at.to_rfc3339(),
        }))
        .send()
        .await
        .map_err(|_| "RESET_EMAIL_FAILED".to_string())?
        .json()
        .await
        .map_err(|_| "RESET_EMAIL_FAILED".to_string())?;
    match (reply.success, reply.error.as_deref()) {
        (true, _) => Ok(()),
        (false, Some("RATE_LIMITED")) => Err("RESET_EMAIL_RATE_LIMITED".into()),
        (false, _) => Err("RESET_EMAIL_FAILED".into()),
    }
}
