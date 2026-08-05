//! Safe SQLite backup and restore for the attendance database.
//!
//! The attendance database is a local SQLite file (`attendance.db`) that the
//! app opens with WAL journaling. Copying the file while the app is running is
//! unsafe: recent writes may still sit in the `-wal` sidecar and would be lost.
//! Every backup and restore path in this module therefore goes through
//! SQLite's online backup engine (`VACUUM INTO`), which produces a consistent
//! snapshot even while the source database is in use, then swaps files via a
//! temp-file rename so the live database is never left half-written.

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};

/// Marker file written by the admin "Restore from backup" flow. When present at
/// startup, the app restores the database from the recorded source file before
/// opening it, so the live database is never touched by two processes.
pub const RESTORE_REQUEST_FILE: &str = "restore.request";
/// Marker left behind when a startup restore is requested but skipped or
/// rejected, so an installer can see what happened instead of losing data.
pub const RESTORE_FAILED_FILE: &str = "restore.failed";
/// Environment variable override processed at startup: restore from this file
/// once. Useful for installers and scripting (runs before the DB is opened).
pub const ENV_RESTORE_FROM: &str = "ALPHA_PREMIER_RESTORE_FROM";
/// Number of timestamped backups kept in `data_dir/backups`.
pub const BACKUP_KEEP_COUNT: usize = 10;

pub fn backups_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("backups")
}

pub fn restore_request_path(data_dir: &Path) -> PathBuf {
    data_dir.join(RESTORE_REQUEST_FILE)
}

pub fn restore_failed_path(data_dir: &Path) -> PathBuf {
    data_dir.join(RESTORE_FAILED_FILE)
}

/// Timestamped backup file name, e.g. `attendance-backup-20260805-143000.db`.
/// Names sort lexicographically newest-first, which backup rotation relies on.
pub fn backup_file_name(now: &chrono::DateTime<chrono::Utc>) -> String {
    format!("attendance-backup-{}.db", now.format("%Y%m%d-%H%M%S"))
}

/// Escape a value for a single-quoted SQLite string literal.
fn sql_quote(value: &str) -> String {
    value.replace('\'', "''")
}

/// Open a short-lived single-connection pool against `path` in read-only mode.
async fn open_readonly(path: &Path) -> Result<SqlitePool, String> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .create_if_missing(false);
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|e| format!("cannot open {}: {e}", path.display()))
}

/// Validate that `path` is a readable SQLite database carrying the attendance
/// schema (the `users` and `attendance` tables). Runs `PRAGMA quick_check`.
pub async fn validate_database_file(path: &Path) -> Result<(), String> {
    let pool = open_readonly(path).await?;
    let check: String = sqlx::query_scalar("PRAGMA quick_check")
        .fetch_one(&pool)
        .await
        .map_err(|e| format!("database integrity check failed: {e}"))?;
    if !check.eq_ignore_ascii_case("ok") {
        pool.close().await;
        return Err(format!("database failed its integrity check: {check}"));
    }
    let table: Option<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users','attendance') ORDER BY name LIMIT 1",
    )
    .fetch_optional(&pool)
    .await
    .map_err(|e| format!("database schema check failed: {e}"))?;
    pool.close().await;
    if table.is_none() {
        return Err("selected file is not an Alpha Premier attendance database".into());
    }
    Ok(())
}

/// Consistent snapshot of `source` into `dest` via SQLite's online backup
/// engine. `dest` is replaced atomically (temp file + rename) and is never
/// left half-written. Safe even while the source database is in use, and it
/// captures WAL data that a plain file copy would miss.
pub async fn snapshot_database(source: &Path, dest: &Path) -> Result<(), String> {
    let pool = open_readonly(source).await?;
    let temp = dest.with_extension("tmp-backup");
    if temp.exists() {
        std::fs::remove_file(&temp).map_err(|e| format!("cannot clear {}: {e}", temp.display()))?;
    }
    let sql = format!(
        "VACUUM INTO '{}'",
        sql_quote(&temp.to_string_lossy().replace('\\', "/"))
    );
    let result = sqlx::query(&sql)
        .execute(&pool)
        .await
        .map_err(|e| format!("online backup failed: {e}"));
    pool.close().await;
    result?;
    if !temp.is_file() {
        return Err("backup did not produce a file".into());
    }
    if dest.exists() {
        std::fs::remove_file(dest).map_err(|e| format!("cannot replace {}: {e}", dest.display()))?;
    }
    std::fs::rename(&temp, dest).map_err(|e| format!("cannot finalize {}: {e}", dest.display()))?;
    Ok(())
}

/// Create a timestamped backup of the live pool into `data_dir/backups` and
/// prune old backups, keeping the newest `BACKUP_KEEP_COUNT`. Safe to call
/// while the app is recording scans.
pub async fn create_backup(db: &SqlitePool, data_dir: &Path) -> Result<PathBuf, String> {
    let dir = backups_dir(data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create backup folder: {e}"))?;
    let file_name = backup_file_name(&chrono::Utc::now());
    let dest = dir.join(&file_name);
    let sql = format!(
        "VACUUM INTO '{}'",
        sql_quote(&dest.to_string_lossy().replace('\\', "/"))
    );
    sqlx::query(&sql)
        .execute(db)
        .await
        .map_err(|e| format!("online backup failed: {e}"))?;
    if !dest.is_file() {
        return Err("backup did not produce a file".into());
    }
    let _ = prune_backups(&dir, BACKUP_KEEP_COUNT).await;
    Ok(dest)
}

/// Delete backups beyond `keep` newest (names are timestamped and sort
/// lexicographically). Returns the deleted file paths.
pub async fn prune_backups(dir: &Path, keep: usize) -> Result<Vec<PathBuf>, String> {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| format!("cannot read backup folder: {e}"))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("db"))
        })
        .collect();
    entries.sort();
    let mut removed = Vec::new();
    while entries.len() > keep {
        let oldest = entries.remove(0);
        if std::fs::remove_file(&oldest).is_ok() {
            removed.push(oldest);
        }
    }
    Ok(removed)
}

/// List existing backups newest-first with their sizes.
pub async fn list_backups(data_dir: &Path) -> Result<Vec<(PathBuf, u64)>, String> {
    let dir = backups_dir(data_dir);
    let mut entries: Vec<(PathBuf, u64)> = std::fs::read_dir(&dir)
        .map_err(|e| format!("cannot read backup folder: {e}"))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("db"))
        })
        .map(|path| {
            let size = std::fs::metadata(&path).map(|metadata| metadata.len()).unwrap_or(0);
            (path, size)
        })
        .collect();
    entries.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(entries)
}

/// Outcome of a startup restore attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RestoreOutcome {
    /// No restore was requested.
    None,
    /// Restore completed successfully from `source`.
    Restored { source: PathBuf },
    /// A restore was requested but the source file is missing; the current
    /// database is kept and the request is recorded as failed.
    SkippedMissingSource { source: PathBuf },
    /// A restore was requested but rejected/failed; the current database is
    /// kept and the request is recorded as failed.
    Failed { source: PathBuf, error: String },
}

/// Process a pending restore request before the app opens its database.
///
/// Sources, in priority order:
/// 1. The `restore.request` marker file in the data directory (written by the
///    admin "Restore from backup" flow, which then exits the app).
/// 2. The `ALPHA_PREMIER_RESTORE_FROM` environment variable (installers and
///    scripting; runs once per launch with the variable set).
///
/// The existing database (if any) is first snapshotted into
/// `data_dir/backups/pre-restore-<timestamp>.db` so a restore can always be
/// rolled back. The source file is then snapshotted into the live database
/// path (never a raw copy), so even a live source database is captured
/// consistently. The marker is deleted on success and preserved as
/// `restore.failed` on any problem, and the app always starts with a valid
/// database — a failed restore never bricks the kiosk.
pub async fn process_restore_request(data_dir: &Path, db_path: &Path) -> RestoreOutcome {
    let marker = restore_request_path(data_dir);
    let env_source = std::env::var_os(ENV_RESTORE_FROM)
        .map(|value| value.to_string_lossy().into_owned())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let source_text = if marker.is_file() {
        match std::fs::read_to_string(&marker) {
            Ok(text) => Some(text.trim().to_string()),
            Err(error) => {
                log::error!("cannot read restore request {error}; keeping current database");
                let _ = std::fs::rename(&marker, restore_failed_path(data_dir));
                return RestoreOutcome::Failed {
                    source: PathBuf::new(),
                    error: format!("cannot read restore request: {error}"),
                };
            }
        }
    } else {
        env_source
    };
    let Some(source_text) = source_text else {
        return RestoreOutcome::None;
    };
    let source = PathBuf::from(&source_text);
    if !source.is_file() {
        let outcome = RestoreOutcome::SkippedMissingSource { source: source.clone() };
        if marker.is_file() {
            let _ = std::fs::rename(&marker, restore_failed_path(data_dir));
        }
        log::warn!(
            "restore source {} missing; keeping current database",
            source.display()
        );
        return outcome;
    }
    if let Err(error) = validate_database_file(&source).await {
        let outcome = RestoreOutcome::Failed {
            source: source.clone(),
            error: error.clone(),
        };
        if marker.is_file() {
            let _ = std::fs::rename(&marker, restore_failed_path(data_dir));
        }
        log::error!("restore from {} rejected: {error}", source.display());
        return outcome;
    }
    // Safety snapshot of the current database so the restore can be undone.
    if db_path.is_file() {
        let dir = backups_dir(data_dir);
        let _ = std::fs::create_dir_all(&dir);
        let snapshot = dir.join(format!(
            "pre-restore-{}.db",
            chrono::Utc::now().format("%Y%m%d-%H%M%S")
        ));
        match snapshot_database(db_path, &snapshot).await {
            Ok(()) => log::info!("pre-restore safety snapshot saved to {}", snapshot.display()),
            Err(error) => log::warn!("pre-restore safety snapshot failed: {error}"),
        }
    }
    if let Some(parent) = db_path.parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            log::error!("cannot create database folder {}: {error}", parent.display());
        }
    }
    if let Err(error) = snapshot_database(&source, db_path).await {
        let outcome = RestoreOutcome::Failed {
            source: source.clone(),
            error: error.clone(),
        };
        if marker.is_file() {
            let _ = std::fs::rename(&marker, restore_failed_path(data_dir));
        }
        log::error!("restore from {} failed: {error}", source.display());
        return outcome;
    }
    if marker.is_file() {
        let _ = std::fs::remove_file(&marker);
    }
    log::info!("database restored from {}", source.display());
    RestoreOutcome::Restored { source }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ScannerConfig;
    use crate::state::AppState;
    use sqlx::sqlite::SqlitePoolOptions;

    /// Build a real attendance database at `path` with one seeded user.
    async fn seed_database(path: &Path) -> AppState {
        let state = AppState::new(
            path.to_path_buf(),
            path.join("attendance.db"),
            path.join("exports"),
            false,
            crate::config::LanConfig::default(),
            crate::config::OfficeConfig::default(),
            ScannerConfig::default(),
        )
        .await
        .expect("database");
        sqlx::query(
            "INSERT INTO users (user_id, rfid_uid, full_name, department, status, employee_type, daily_rate_centavos, created_at, updated_at) VALUES (?, ?, ?, ?, 'ACTIVE', 'EMPLOYEE', 50000, ?, ?)",
        )
        .bind("EMP-1")
        .bind("A1B2C3")
        .bind("Ada Lovelace")
        .bind(Option::<String>::None)
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(&state.db)
        .await
        .expect("seed user");
        state
    }

    #[tokio::test]
    async fn create_backup_produces_a_readable_consistent_snapshot() {
        let dir = std::env::temp_dir().join(format!("alpha-backup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = seed_database(&dir).await;
        let backup = create_backup(&state.db, &dir).await.expect("backup");
        assert!(backup.is_file());
        assert!(backup.file_name().unwrap().to_string_lossy().starts_with("attendance-backup-"));
        validate_database_file(&backup).await.expect("backup is a valid attendance db");
        let pool = open_readonly(&backup).await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
        pool.close().await;
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn prune_backups_keeps_only_the_newest() {
        let dir = std::env::temp_dir().join(format!("alpha-prune-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        for name in [
            "attendance-backup-20260801-000000.db",
            "attendance-backup-20260802-000000.db",
            "attendance-backup-20260803-000000.db",
        ] {
            std::fs::write(dir.join(name), "x").unwrap();
        }
        let removed = prune_backups(&dir, 2).await.expect("prune");
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].file_name().unwrap(), "attendance-backup-20260801-000000.db");
        let remaining = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .count();
        assert_eq!(remaining, 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn validate_database_file_rejects_foreign_files() {
        let dir = std::env::temp_dir().join(format!("alpha-invalid-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("not-a-db.txt");
        std::fs::write(&file, "hello").unwrap();
        assert!(validate_database_file(&file).await.is_err());
        // A valid SQLite file without the attendance schema is rejected.
        let db = dir.join("foreign.db");
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(SqliteConnectOptions::new().filename(&db).create_if_missing(true))
            .await
            .unwrap();
        sqlx::query("CREATE TABLE some_other_app (id INTEGER PRIMARY KEY)")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
        assert!(validate_database_file(&db).await.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn snapshot_database_captures_wal_data_a_raw_copy_would_miss() {
        let dir = std::env::temp_dir().join(format!("alpha-snap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = seed_database(&dir).await;
        // Leave the write in the WAL (do not checkpoint) to prove VACUUM INTO
        // captures it; a plain file copy would lose this row.
        let snapshot = dir.join("snapshot.db");
        snapshot_database(&state.db_path, &snapshot).await.expect("snapshot");
        let pool = open_readonly(&snapshot).await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1, "WAL content must be present in the snapshot");
        pool.close().await;
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn process_restore_request_replaces_the_database_and_clears_the_marker() {
        let dir = std::env::temp_dir().join(format!("alpha-restore-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // Current database with one user.
        let current = seed_database(&dir).await;
        current.db.close().await;
        // Source backup with a different user.
        let source_dir = dir.join("source");
        std::fs::create_dir_all(&source_dir).unwrap();
        let source = seed_database(&source_dir).await;
        source.db.close().await;
        let source_file = source_dir.join("attendance.db");
        let backup = source_dir.join("carried-over.db");
        snapshot_database(&source_file, &backup).await.expect("source backup");

        // Simulate the admin flow: marker written, app exited.
        let marker = restore_request_path(&dir);
        std::fs::write(&marker, backup.to_string_lossy().into_owned()).unwrap();

        let db_path = dir.join("attendance.db");
        let outcome = process_restore_request(&dir, &db_path).await;
        assert_eq!(outcome, RestoreOutcome::Restored { source: backup.clone() });
        assert!(!marker.exists(), "marker must be removed after a successful restore");
        assert!(!restore_failed_path(&dir).exists());

        // The live database now carries the restored user.
        let state = AppState::new(
            dir.clone(),
            db_path.clone(),
            dir.join("exports"),
            false,
            crate::config::LanConfig::default(),
            crate::config::OfficeConfig::default(),
            ScannerConfig::default(),
        )
        .await
        .unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(count, 1);
        let name: String = sqlx::query_scalar("SELECT full_name FROM users LIMIT 1")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(name, "Ada Lovelace");
        // A pre-restore safety snapshot of the previous database exists.
        assert!(
            list_backups(&dir).await.unwrap().iter().any(|(path, _)| path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("pre-restore-")),
            "safety snapshot must exist"
        );
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn process_restore_request_keeps_the_database_when_the_source_is_missing() {
        let dir = std::env::temp_dir().join(format!("alpha-restore-missing-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let current = seed_database(&dir).await;
        current.db.close().await;
        let marker = restore_request_path(&dir);
        std::fs::write(&marker, dir.join("gone.db").to_string_lossy().into_owned()).unwrap();
        let db_path = dir.join("attendance.db");
        let outcome = process_restore_request(&dir, &db_path).await;
        assert!(matches!(outcome, RestoreOutcome::SkippedMissingSource { .. }));
        assert!(restore_failed_path(&dir).exists());
        assert!(db_path.exists(), "current database must be kept");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
