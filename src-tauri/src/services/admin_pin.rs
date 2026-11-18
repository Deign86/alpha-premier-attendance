// The wrong-tries pause for the admin screens, and the slow hash used to check a remembered account password.
//
// There is no shared administrator PIN any more (owner decision, 2026-11-18): the admin screens open with an admin
// RFID card or with a person's own Keystone account (`admin_account.rs`). What is left of the PIN is IT's way back:
// an explicit `admin_pin = "…"` in config.toml on the kiosk still opens them, and `admin_pin = ""` there still turns
// admin off. That is checked in `setup_unlock_impl`; nothing here stores, emails or resets a PIN.
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
use sqlx::SqlitePool;
use std::num::NonZeroU32;

const UNLOCK_GUARD_KEY: &str = "admin_unlock_guard";
/// Owner decision D1 (2026-11-06): five wrong tries in a row pause unlocking by
/// anything typed for five minutes. Admin cards still unlock.
const UNLOCK_MAX_FAILURES: u32 = 5;
const UNLOCK_LOCK_MINUTES: i64 = 5;
const ITERATIONS: NonZeroU32 = match NonZeroU32::new(100_000) {
    Some(value) => value,
    None => panic!("PBKDF2 iterations must be non-zero"),
};

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

fn fill_random(bytes: &mut [u8]) -> Result<(), String> {
    SystemRandom::new().fill(bytes).map_err(|_| "RNG_UNAVAILABLE".to_string())
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
