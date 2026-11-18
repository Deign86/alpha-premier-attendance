// The `app_settings` table: one row per key, text values.
//
// Kept free of Tauri/AppState so `tests/unlock_guard_isolated.rs` can include
// it directly on Windows (see docs/testing/rust-test-parity.md).

use sqlx::SqlitePool;

/// Every key the app keeps in `app_settings`. A stored key is never renamed:
/// kiosks in the office already hold these rows.
pub mod key {
    pub const VOICESTUDIO_HOST: &str = "voicestudio_base_url";
    pub const VOICESTUDIO_PIN: &str = "voicestudio_pin";
    pub const BEA_NAME_BUNDLE: &str = "bea_name_bundle_generated_at";
    pub const ID_REGISTER_TOKEN: &str = "id_register_refresh_token";
    pub const ID_REGISTER_EMAIL: &str = "id_register_email";
    pub const ID_REGISTER_COUNT: &str = "id_register_count";
    pub const ID_REGISTER_SEEN: &str = "id_register_seen";
    pub const ID_REGISTER_CHECKED_AT: &str = "id_register_checked_at";
    pub const ID_REGISTER_PROBLEM: &str = "id_register_problem";
    pub const CLOUD_BACKUP_AT: &str = "cloud_backup_at";
    pub const CLOUD_BACKUP_PROBLEM: &str = "cloud_backup_problem";
    pub const CLOUD_MAIN_RECORD_SINCE: &str = "cloud_main_record_since";
    pub const ADMIN_UNLOCK_GUARD: &str = "admin_unlock_guard";
    pub const ADMIN_ACCOUNTS: &str = "admin_accounts";
    pub const DTR_SYNC_ENABLED: &str = "intern_dtr_sync_enabled";
}

/// Migration 0017 creates the table; a database older than that, or the bare
/// one in the isolated harness, gets it here.
pub async fn ensure_table(db: &SqlitePool) -> Result<(), String> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL)",
    )
    .execute(db)
    .await
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// A setting that cannot be read is answered as one that is not there.
/// Use `get_json` where a failed read must not pass for "nothing stored".
pub async fn get(db: &SqlitePool, key: &str) -> Option<String> {
    try_get(db, key).await.unwrap_or(None)
}

async fn try_get(db: &SqlitePool, key: &str) -> Result<Option<String>, String> {
    sqlx::query_scalar("SELECT value FROM app_settings WHERE key = ?")
        .bind(key)
        .fetch_optional(db)
        .await
        .map_err(|e| e.to_string())
}

/// `now` is an RFC 3339 time.
pub async fn put(db: &SqlitePool, key: &str, value: &str, now: &str) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(key)
    .bind(value)
    .bind(now)
    .execute(db)
    .await
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub async fn delete(db: &SqlitePool, key: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM app_settings WHERE key = ?")
        .bind(key)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// A failed read is an error; a value that is not this JSON reads as nothing stored.
pub async fn get_json<T: serde::de::DeserializeOwned>(db: &SqlitePool, key: &str) -> Result<Option<T>, String> {
    Ok(try_get(db, key).await?.and_then(|raw| serde_json::from_str(&raw).ok()))
}

pub async fn put_json<T: serde::Serialize>(db: &SqlitePool, key: &str, value: &T, now: &str) -> Result<(), String> {
    let raw = serde_json::to_string(value).map_err(|e| e.to_string())?;
    put(db, key, &raw, now).await
}
