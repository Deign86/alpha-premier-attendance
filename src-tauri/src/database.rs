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
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

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
const PORTABLE_BACKUP_VERSION: u32 = 1;

pub fn backups_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("backups")
}

pub fn restore_request_path(data_dir: &Path) -> PathBuf {
    data_dir.join(RESTORE_REQUEST_FILE)
}

pub fn restore_failed_path(data_dir: &Path) -> PathBuf {
    data_dir.join(RESTORE_FAILED_FILE)
}

/// Timestamped backup file name, e.g. `attendance-backup-20260805-143000.apbackup`.
/// Names sort lexicographically newest-first, which backup rotation relies on.
pub fn backup_file_name(now: &chrono::DateTime<chrono::Utc>) -> String {
    format!("attendance-backup-{}.apbackup", now.format("%Y%m%d-%H%M%S"))
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
/// schema (the `users` and `attendance` tables). Runs `PRAGMA quick_check` and `PRAGMA foreign_key_check`.
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
    let fk_violations: Vec<(String, Option<i64>, String, i64)> =
        sqlx::query_as("PRAGMA foreign_key_check")
            .fetch_all(&pool)
            .await
            .map_err(|e| format!("database foreign key check failed: {e}"))?;
    if !fk_violations.is_empty() {
        pool.close().await;
        return Err(format!(
            "database failed foreign key integrity check: {} violation(s)",
            fk_violations.len()
        ));
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
        std::fs::remove_file(dest)
            .map_err(|e| format!("cannot replace {}: {e}", dest.display()))?;
    }
    std::fs::rename(&temp, dest).map_err(|e| format!("cannot finalize {}: {e}", dest.display()))?;
    Ok(())
}

pub fn validate_portable_backup(path: &Path) -> Result<(), String> {
    let file = std::fs::File::open(path).map_err(|e| format!("cannot open backup: {e}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("not a portable backup archive: {e}"))?;
    let mut manifest = String::new();
    archive
        .by_name("manifest.json")
        .map_err(|_| "portable backup manifest is missing".to_string())?
        .read_to_string(&mut manifest)
        .map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&manifest)
        .map_err(|e| format!("invalid portable backup manifest: {e}"))?;
    if value.get("format").and_then(|v| v.as_str()) != Some("alpha-premier-application-backup")
        || value.get("version").and_then(|v| v.as_u64()) != Some(PORTABLE_BACKUP_VERSION as u64)
    {
        return Err("unsupported Alpha Premier portable backup format".into());
    }
    if archive.by_name("database/attendance.db").is_err() {
        return Err("portable backup database is missing".into());
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupFormat {
    PortableArchive,
    SqliteDatabase,
}

/// Detect whether a backup file is a portable zip archive or a raw SQLite database
/// by inspecting its magic bytes.
pub fn detect_backup_format(path: &Path) -> Result<BackupFormat, String> {
    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("cannot open {}: {e}", path.display()))?;
    let mut header = [0u8; 16];
    let n = file
        .read(&mut header)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    if n >= 4
        && (header[0..4] == [0x50, 0x4B, 0x03, 0x04]
            || header[0..4] == [0x50, 0x4B, 0x05, 0x06]
            || header[0..4] == [0x50, 0x4B, 0x07, 0x08])
    {
        return Ok(BackupFormat::PortableArchive);
    }
    if n >= 16 && &header[0..16] == b"SQLite format 3\0" {
        return Ok(BackupFormat::SqliteDatabase);
    }
    if path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("apbackup"))
    {
        return Ok(BackupFormat::PortableArchive);
    }
    if path.extension().is_some_and(|ext| {
        ext.eq_ignore_ascii_case("db") || ext.eq_ignore_ascii_case("sqlite")
    }) {
        return Ok(BackupFormat::SqliteDatabase);
    }
    Err(format!(
        "unrecognized backup file format for {}",
        path.display()
    ))
}

pub fn is_excluded_data_entry(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == "backups"
        || lower == "ebwebview"
        || lower == "logs"
        || lower == RESTORE_REQUEST_FILE
        || lower == RESTORE_FAILED_FILE
        || lower == "attendance.db"
        || lower == "attendance.db-wal"
        || lower == "attendance.db-shm"
        || lower.starts_with(".restore-")
        || lower.starts_with('.')
        || lower.ends_with(".tmp")
        || lower.ends_with(".db.tmp")
        || lower.ends_with(".tmp-backup")
        || lower.ends_with(".tmp-apbackup")
        || lower.ends_with(".lock")
}

/// Create a self-contained application backup. It includes the database,
/// photos, generated files, sync state, and config so it can be moved between PCs.
pub async fn create_portable_backup(
    db: &SqlitePool,
    data_dir: &Path,
    config_dir: &Path,
    _db_path: &Path,
) -> Result<PathBuf, String> {
    let dir = backups_dir(data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create backup folder: {e}"))?;
    let file_name = backup_file_name(&chrono::Utc::now());
    let dest = dir.join(&file_name);
    let temp_db = dir.join(format!("{}.db.tmp", uuid::Uuid::new_v4()));
    if let Err(e) = snapshot_database_from_pool(db, &temp_db).await {
        let _ = std::fs::remove_file(&temp_db);
        return Err(e);
    }
    let temp_archive = dest.with_extension("tmp-apbackup");
    let create_result = (|| -> Result<(), String> {
        let archive_file = std::fs::File::create(&temp_archive)
            .map_err(|e| format!("cannot create backup: {e}"))?;
        let mut writer = ZipWriter::new(archive_file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let manifest = serde_json::json!({
            "format": "alpha-premier-application-backup",
            "version": PORTABLE_BACKUP_VERSION,
            "database": "database/attendance.db"
        });
        writer
            .start_file("manifest.json", options)
            .map_err(|e| e.to_string())?;
        writer
            .write_all(manifest.to_string().as_bytes())
            .map_err(|e| e.to_string())?;
        add_file_to_archive(&mut writer, &temp_db, "database/attendance.db", options)?;
        add_directory_to_archive(&mut writer, data_dir, data_dir, options)?;
        let config = config_dir.join("config.toml");
        if config.is_file() {
            add_file_to_archive(&mut writer, &config, "config/config.toml", options)?;
        }
        writer
            .finish()
            .map_err(|e| format!("cannot finalize backup: {e}"))?;
        Ok(())
    })();

    let _ = std::fs::remove_file(&temp_db);

    if let Err(err) = create_result {
        let _ = std::fs::remove_file(&temp_archive);
        return Err(err);
    }

    if dest.exists() {
        let _ = std::fs::remove_file(&dest);
    }
    if let Err(e) = std::fs::rename(&temp_archive, &dest) {
        let _ = std::fs::remove_file(&temp_archive);
        return Err(format!("cannot finalize backup: {e}"));
    }
    let _ = prune_backups(&dir, BACKUP_KEEP_COUNT).await;
    Ok(dest)
}

async fn snapshot_database_from_pool(db: &SqlitePool, dest: &Path) -> Result<(), String> {
    if dest.exists() {
        std::fs::remove_file(dest).ok();
    }
    let sql = format!(
        "VACUUM INTO '{}'",
        sql_quote(&dest.to_string_lossy().replace('\\', "/"))
    );
    sqlx::query(&sql)
        .execute(db)
        .await
        .map_err(|e| format!("online backup failed: {e}"))?;
    if dest.is_file() {
        Ok(())
    } else {
        Err("backup did not produce a database snapshot".into())
    }
}

fn add_file_to_archive(
    writer: &mut ZipWriter<std::fs::File>,
    source: &Path,
    name: &str,
    options: SimpleFileOptions,
) -> Result<(), String> {
    let mut file = match std::fs::File::open(source) {
        Ok(f) => f,
        Err(e) => {
            log::warn!(
                "skipping unreadable or locked file {}: {e}",
                source.display()
            );
            return Ok(());
        }
    };
    writer
        .start_file(name.replace('\\', "/"), options)
        .map_err(|e| e.to_string())?;
    std::io::copy(&mut file, writer).map_err(|e| e.to_string())?;
    Ok(())
}

fn add_directory_to_archive(
    writer: &mut ZipWriter<std::fs::File>,
    root: &Path,
    current: &Path,
    options: SimpleFileOptions,
) -> Result<(), String> {
    for entry in
        std::fs::read_dir(current).map_err(|e| format!("cannot read {}: {e}", current.display()))?
    {
        let path = entry.map_err(|e| e.to_string())?.path();
        let relative = path.strip_prefix(root).map_err(|e| e.to_string())?;
        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if is_excluded_data_entry(file_name) {
            continue;
        }
        if relative.components().any(|component| {
            let comp_str = component.as_os_str().to_string_lossy();
            is_excluded_data_entry(&comp_str)
        }) {
            continue;
        }
        if path.is_dir() {
            add_directory_to_archive(writer, root, &path, options)?;
        } else if path.is_file() {
            add_file_to_archive(
                writer,
                &path,
                &format!("data/{}", relative.to_string_lossy()),
                options,
            )?;
        }
    }
    Ok(())
}

/// Delete backups beyond `keep` newest (names are timestamped and sort
/// lexicographically). Also cleans up stale temporary backup files.
/// Returns the deleted backup file paths.
pub async fn prune_backups(dir: &Path, keep: usize) -> Result<Vec<PathBuf>, String> {
    let mut entries: Vec<PathBuf> = Vec::new();
    if let Ok(read_dir) = std::fs::read_dir(dir) {
        for entry in read_dir.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            if name.ends_with(".db.tmp")
                || name.ends_with(".tmp-backup")
                || name.ends_with(".tmp-apbackup")
            {
                let _ = std::fs::remove_file(&path);
                continue;
            }
            if path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| {
                    ext.eq_ignore_ascii_case("apbackup") || ext.eq_ignore_ascii_case("db")
                })
            {
                entries.push(path);
            }
        }
    }
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
                    .is_some_and(|ext| {
                        ext.eq_ignore_ascii_case("apbackup") || ext.eq_ignore_ascii_case("db")
                    })
        })
        .map(|path| {
            let size = std::fs::metadata(&path)
                .map(|metadata| metadata.len())
                .unwrap_or(0);
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
pub async fn process_restore_request(
    data_dir: &Path,
    config_dir: &Path,
    db_path: &Path,
) -> RestoreOutcome {
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
        let outcome = RestoreOutcome::SkippedMissingSource {
            source: source.clone(),
        };
        if marker.is_file() {
            let _ = std::fs::rename(&marker, restore_failed_path(data_dir));
        }
        log::warn!(
            "restore source {} missing; keeping current database",
            source.display()
        );
        return outcome;
    }
    let format = match detect_backup_format(&source) {
        Ok(f) => f,
        Err(error) => {
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
    };
    let validation = match format {
        BackupFormat::PortableArchive => validate_portable_backup(&source),
        BackupFormat::SqliteDatabase => validate_database_file(&source).await,
    };
    if let Err(error) = validation {
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
            Ok(()) => log::info!(
                "pre-restore safety snapshot saved to {}",
                snapshot.display()
            ),
            Err(error) => log::warn!("pre-restore safety snapshot failed: {error}"),
        }
    }
    if let Some(parent) = db_path.parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            log::error!(
                "cannot create database folder {}: {error}",
                parent.display()
            );
        }
    }
    let restore_result = match format {
        BackupFormat::PortableArchive => {
            restore_portable_backup(&source, data_dir, config_dir, db_path).await
        }
        BackupFormat::SqliteDatabase => snapshot_database(&source, db_path).await,
    };
    if let Err(error) = restore_result {
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
    cleanup_sidecars(db_path);
    log::info!("database restored from {}", source.display());
    RestoreOutcome::Restored { source }
}

fn cleanup_sidecars(db_path: &Path) {
    let wal = PathBuf::from(format!("{}-wal", db_path.to_string_lossy()));
    let shm = PathBuf::from(format!("{}-shm", db_path.to_string_lossy()));
    let _ = std::fs::remove_file(wal);
    let _ = std::fs::remove_file(shm);
}

async fn restore_portable_backup(
    source: &Path,
    data_dir: &Path,
    config_dir: &Path,
    db_path: &Path,
) -> Result<(), String> {
    let staging = std::env::temp_dir().join(format!("alpha-restore-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let file = std::fs::File::open(source).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
        let name = entry
            .enclosed_name()
            .ok_or_else(|| "portable backup contains an unsafe path".to_string())?
            .to_path_buf();
        let target = staging.join(name);
        if entry.is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = std::fs::File::create(&target).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    }
    let staging_db = staging.join("database/attendance.db");
    validate_database_file(&staging_db).await?;

    let temp_restore = db_path.with_extension("tmp-restore");
    if temp_restore.is_file() {
        let _ = std::fs::remove_file(&temp_restore);
    }
    std::fs::copy(&staging_db, &temp_restore)
        .map_err(|e| format!("cannot copy staging database: {e}"))?;

    // Re-align photo URLs in the restored database to the local machine data_dir
    if let Ok(pool) = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&format!("sqlite://{}", temp_restore.to_string_lossy()))
        .await
    {
        let photos_dir_str = data_dir.join("photos").to_string_lossy().replace('\\', "/");
        let _ = sqlx::query(
            "UPDATE users 
             SET photo_url = 'asset://localhost/' || ? || '/' || substr(photo_url, instr(photo_url, '/photos/') + 8)
             WHERE photo_url IS NOT NULL AND instr(photo_url, '/photos/') > 0"
        )
        .bind(&photos_dir_str)
        .execute(&pool)
        .await;
        pool.close().await;
    }

    if db_path.is_file() {
        let _ = std::fs::remove_file(db_path);
    }
    std::fs::rename(&temp_restore, db_path)
        .map_err(|e| format!("cannot finalize restored database: {e}"))?;

    if staging.join("data").is_dir() {
        clear_restorable_data(data_dir)?;
        copy_directory_contents(&staging.join("data"), data_dir)?;
    }
    let restored_config = staging.join("config/config.toml");
    if restored_config.is_file() {
        std::fs::create_dir_all(config_dir).map_err(|e| e.to_string())?;
        std::fs::copy(restored_config, config_dir.join("config.toml"))
            .map_err(|e| format!("cannot restore config: {e}"))?;
    }
    std::fs::remove_dir_all(&staging).ok();
    Ok(())
}

fn clear_restorable_data(data_dir: &Path) -> Result<(), String> {
    for entry in std::fs::read_dir(data_dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if is_excluded_data_entry(name) {
            continue;
        }
        if path.is_dir() {
            if let Err(e) = std::fs::remove_dir_all(&path) {
                log::warn!(
                    "could not remove directory {} during restore: {e}",
                    path.display()
                );
            }
        } else if let Err(e) = std::fs::remove_file(&path) {
            log::warn!(
                "could not remove file {} during restore: {e}",
                path.display()
            );
        }
    }
    Ok(())
}

fn copy_directory_contents(source: &Path, target: &Path) -> Result<(), String> {
    for entry in std::fs::read_dir(source).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        let relative = path.strip_prefix(source).map_err(|e| e.to_string())?;
        let name = path
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or_default();
        if is_excluded_data_entry(name) {
            continue;
        }
        let destination = target.join(relative);
        if path.is_dir() {
            std::fs::create_dir_all(&destination).map_err(|e| e.to_string())?;
            copy_directory_contents(&path, &destination)?;
        } else {
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            if let Err(e) = std::fs::copy(&path, &destination) {
                log::warn!("could not restore file to {}: {e}", destination.display());
            }
        }
    }
    Ok(())
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
            crate::config::TtsConfig::default(),
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
        let backup = create_portable_backup(&state.db, &dir, &dir, &state.db_path)
            .await
            .expect("backup");
        assert!(backup.is_file());
        assert!(backup
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("attendance-backup-"));
        validate_portable_backup(&backup).expect("backup is a valid portable archive");
        let file = std::fs::File::open(&backup).unwrap();
        let mut archive = ZipArchive::new(file).unwrap();
        let embedded = dir.join("embedded.db");
        std::io::copy(
            &mut archive.by_name("database/attendance.db").unwrap(),
            &mut std::fs::File::create(&embedded).unwrap(),
        )
        .unwrap();
        let pool = open_readonly(&embedded).await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
        pool.close().await;
        let _ = std::fs::remove_file(embedded);
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn prune_backups_keeps_only_the_newest() {
        let dir = std::env::temp_dir().join(format!("alpha-prune-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        for name in [
            "attendance-backup-20260801-000000.apbackup",
            "attendance-backup-20260802-000000.apbackup",
            "attendance-backup-20260803-000000.apbackup",
        ] {
            std::fs::write(dir.join(name), "x").unwrap();
        }
        let removed = prune_backups(&dir, 2).await.expect("prune");
        assert_eq!(removed.len(), 1);
        assert_eq!(
            removed[0].file_name().unwrap(),
            "attendance-backup-20260801-000000.apbackup"
        );
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
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&db)
                    .create_if_missing(true),
            )
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
        snapshot_database(&state.db_path, &snapshot)
            .await
            .expect("snapshot");
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
        snapshot_database(&source_file, &backup)
            .await
            .expect("source backup");

        // Simulate the admin flow: marker written, app exited.
        let marker = restore_request_path(&dir);
        std::fs::write(&marker, backup.to_string_lossy().into_owned()).unwrap();

        let db_path = dir.join("attendance.db");
        let outcome = process_restore_request(&dir, &dir, &db_path).await;
        assert_eq!(
            outcome,
            RestoreOutcome::Restored {
                source: backup.clone()
            }
        );
        assert!(
            !marker.exists(),
            "marker must be removed after a successful restore"
        );
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
            crate::config::TtsConfig::default(),
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
            list_backups(&dir)
                .await
                .unwrap()
                .iter()
                .any(|(path, _)| path
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
        let dir =
            std::env::temp_dir().join(format!("alpha-restore-missing-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let current = seed_database(&dir).await;
        current.db.close().await;
        let marker = restore_request_path(&dir);
        std::fs::write(&marker, dir.join("gone.db").to_string_lossy().into_owned()).unwrap();
        let db_path = dir.join("attendance.db");
        let outcome = process_restore_request(&dir, &dir, &db_path).await;
        assert!(matches!(
            outcome,
            RestoreOutcome::SkippedMissingSource { .. }
        ));
        assert!(restore_failed_path(&dir).exists());
        assert!(db_path.exists(), "current database must be kept");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Seed every important table with recognizable test data including interns,
    /// employees, cards, attendance, cutoffs, profiles, snapshots, export jobs, and artifacts.
    async fn seed_full_test_database(path: &Path) -> AppState {
        let state = AppState::new(
            path.to_path_buf(),
            path.join("attendance.db"),
            path.join("exports"),
            false,
            crate::config::LanConfig::default(),
            crate::config::OfficeConfig::default(),
            ScannerConfig::default(),
            crate::config::TtsConfig::default(),
        )
        .await
        .expect("database initialization");

        let now = chrono::Utc::now().to_rfc3339();

        // 1. Intern user
        sqlx::query(
            "INSERT INTO users (user_id, rfid_uid, full_name, department, status, employee_type, daily_rate_centavos, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'ACTIVE', 'INTERN', 30000, ?, ?)",
        )
        .bind("INTERN-PORT-001")
        .bind("CARD-PORTABILITY-001")
        .bind("PORTABILITY_TEST_INTERN_001")
        .bind(Some("Engineering"))
        .bind(&now)
        .bind(&now)
        .execute(&state.db)
        .await
        .expect("seed intern user");

        // 2. Second user (employee) with second card
        sqlx::query(
            "INSERT INTO users (user_id, rfid_uid, full_name, department, status, employee_type, daily_rate_centavos, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'ACTIVE', 'EMPLOYEE', 60000, ?, ?)",
        )
        .bind("EMP-PORT-002")
        .bind("CARD-PORTABILITY-002")
        .bind("PORTABILITY_TEST_EMP_002")
        .bind(Some("Operations"))
        .bind(&now)
        .bind(&now)
        .execute(&state.db)
        .await
        .expect("seed employee user");

        // 3. Attendance records associated with the test intern (at least two)
        sqlx::query(
            "INSERT INTO attendance (attendance_id, attendance_date, user_id, rfid_uid, full_name, department, time_in, time_out, status, source, notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'RFID', '', ?, ?)",
        )
        .bind("ATT-PORT-001")
        .bind("2026-08-10")
        .bind("INTERN-PORT-001")
        .bind("CARD-PORTABILITY-001")
        .bind("PORTABILITY_TEST_INTERN_001")
        .bind(Some("Engineering"))
        .bind(Some("2026-08-10T08:00:00+08:00"))
        .bind(Some("2026-08-10T17:00:00+08:00"))
        .bind("PRESENT")
        .bind(&now)
        .bind(&now)
        .execute(&state.db)
        .await
        .expect("seed attendance 1");

        sqlx::query(
            "INSERT INTO attendance (attendance_id, attendance_date, user_id, rfid_uid, full_name, department, time_in, time_out, status, source, notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'RFID', '', ?, ?)",
        )
        .bind("ATT-PORT-002")
        .bind("2026-08-11")
        .bind("INTERN-PORT-001")
        .bind("CARD-PORTABILITY-001")
        .bind("PORTABILITY_TEST_INTERN_001")
        .bind(Some("Engineering"))
        .bind(Some("2026-08-11T08:15:00+08:00"))
        .bind(Some("2026-08-11T17:05:00+08:00"))
        .bind("WORKING")
        .bind(&now)
        .bind(&now)
        .execute(&state.db)
        .await
        .expect("seed attendance 2");

        // 4. Audit log
        sqlx::query(
            "INSERT INTO audit_logs (log_id, timestamp, event_type, rfid_uid, user_id, message, request_id)
             VALUES (?, ?, 'SCAN_SUCCESS', ?, ?, 'Time-in recorded', ?)",
        )
        .bind("LOG-PORT-001")
        .bind(&now)
        .bind(Some("CARD-PORTABILITY-001"))
        .bind(Some("INTERN-PORT-001"))
        .bind("REQ-PORT-001")
        .execute(&state.db)
        .await
        .expect("seed audit log");

        // 5. Intern grace
        sqlx::query(
            "INSERT INTO intern_grace (grace_id, user_id, week_start, attendance_id, used_at)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind("GRACE-PORT-001")
        .bind("INTERN-PORT-001")
        .bind("2026-08-10")
        .bind("ATT-PORT-001")
        .bind(&now)
        .execute(&state.db)
        .await
        .expect("seed intern grace");

        // 6. Payroll profile
        sqlx::query(
            "INSERT INTO payroll_profiles (profile_id, label, payroll_frequency, standard_working_days_per_cutoff, incentives_allowance_centavos, special_allowance_centavos, special_holiday_multiplier, regular_holiday_multiplier, half_day_fraction, overtime_rate_centavos, created_at, updated_at)
             VALUES (?, 'Semi-Monthly Standard', 'SEMI_MONTHLY', 11.0, 50000, 20000, 1.3, 2.0, 0.5, 10000, ?, ?)",
        )
        .bind("PROF-PORT-001")
        .bind(&now)
        .bind(&now)
        .execute(&state.db)
        .await
        .expect("seed payroll profile");

        // 7. Payroll cutoff
        sqlx::query(
            "INSERT INTO payroll_cutoffs (payroll_id, employee_id, employee_name, payroll_profile_id, payroll_cutoff_label, cutoff_start, cutoff_end, payroll_frequency, daily_rate_centavos, standard_working_days, actual_working_days, basic_pay_centavos, special_holiday_days, special_holiday_multiplier, special_holiday_pay_centavos, regular_holiday_days, regular_holiday_multiplier, regular_holiday_pay_centavos, incentives_allowance_centavos, special_allowance_centavos, total_compensation_centavos, total_allowance_centavos, late_units, late_deduction_centavos, half_day_count, half_day_deduction_centavos, absent_days, absence_deduction_centavos, overtime_hours, overtime_rate_centavos, overtime_pay_centavos, manual_adjustment_centavos, gross_compensation_centavos, net_pay_centavos, calculation_breakdown, approved_working_day_overage, status, created_at, updated_at)
             VALUES (?, ?, ?, 'PROF-PORT-001', 'August 1-15 2026', '2026-08-01', '2026-08-15', 'SEMI_MONTHLY', 30000, 11.0, 10.0, 300000, 0.0, 1.3, 0, 0.0, 2.0, 0, 0, 0, 300000, 0, 0.0, 0, 0.0, 0, 1.0, 30000, 0.0, 0, 0, 0, 300000, 270000, '{}', 0, 'FINALIZED', ?, ?)",
        )
        .bind("CUTOFF-PORT-001")
        .bind("INTERN-PORT-001")
        .bind("PORTABILITY_TEST_INTERN_001")
        .bind(&now)
        .bind(&now)
        .execute(&state.db)
        .await
        .expect("seed payroll cutoff");

        // 8. Payroll snapshot
        sqlx::query(
            "INSERT INTO payroll_snapshots (snapshot_id, payroll_id, revision, status, snapshot_json, snapshot_sha256, created_at)
             VALUES (?, 'CUTOFF-PORT-001', 1, 'FINALIZED', '{\"net\":270000}', 'dummy-sha', ?)",
        )
        .bind("SNAP-PORT-001")
        .bind(&now)
        .execute(&state.db)
        .await
        .expect("seed payroll snapshot");

        // 9. Export job
        sqlx::query(
            "INSERT INTO export_jobs (job_id, kind, scope_json, format, status, requested_by, requested_at, app_version)
             VALUES (?, 'ATTENDANCE_XLSX', '{}', 'XLSX', 'SUCCEEDED', 'LOCAL_ADMIN', ?, '0.1.0')",
        )
        .bind("JOB-PORT-001")
        .bind(&now)
        .execute(&state.db)
        .await
        .expect("seed export job");

        // 10. Generated artifact
        sqlx::query(
            "INSERT INTO generated_artifacts (artifact_id, job_id, document_id, kind, format, file_name, managed_relative_path, sha256, size_bytes, state, created_at)
             VALUES (?, 'JOB-PORT-001', 'DOC-1', 'ATTENDANCE_XLSX', 'XLSX', 'attendance.xlsx', 'exports/attendance.xlsx', 'dummy-sha256', 1024, 'AVAILABLE', ?)",
        )
        .bind("ART-PORT-001")
        .bind(&now)
        .execute(&state.db)
        .await
        .expect("seed generated artifact");

        // 11. Payroll PDF
        sqlx::query(
            "INSERT INTO payroll_pdfs (payroll_pdf_id, file_name, managed_relative_path, cutoff_start, cutoff_end, payroll_cutoff_label, worker_type, employee_count, total_amount_centavos, sha256, size_bytes, created_at)
             VALUES (?, 'payroll.pdf', 'exports/payroll.pdf', '2026-08-01', '2026-08-15', 'August 1-15 2026', 'INTERN', 1, 270000, 'dummy-sha256', 2048, ?)",
        )
        .bind("PDF-PORT-001")
        .bind(&now)
        .execute(&state.db)
        .await
        .expect("seed payroll pdf");

        // 12. Sync queue & sync state
        sqlx::query(
            "INSERT INTO sync_queue (table_name, row_id, operation, payload_json, next_attempt_at, created_at, updated_at)
             VALUES ('users', 'INTERN-PORT-001', 'UPSERT', '{}', ?, ?, ?)",
        )
        .bind(&now)
        .bind(&now)
        .bind(&now)
        .execute(&state.db)
        .await
        .expect("seed sync queue");

        sqlx::query(
            "INSERT INTO sync_state (table_name, row_id, last_synced_hash, sheet_row_number, last_synced_at)
             VALUES ('users', 'INTERN-PORT-001', 'synchash', 2, ?)",
        )
        .bind(&now)
        .execute(&state.db)
        .await
        .expect("seed sync state");

        state
    }

    #[tokio::test]
    async fn portable_backup_and_restore_full_roundtrip_test() {
        let source_dir =
            std::env::temp_dir().join(format!("alpha-source-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&source_dir).unwrap();

        // 1. Seed full database
        let source_state = seed_full_test_database(&source_dir).await;

        // Verify source DB integrity
        validate_database_file(&source_state.db_path)
            .await
            .expect("source database integrity check");

        // 2. Create portable backup
        let backup_path = create_portable_backup(
            &source_state.db,
            &source_dir,
            &source_dir,
            &source_state.db_path,
        )
        .await
        .expect("create portable backup");

        assert!(backup_path.is_file());
        validate_portable_backup(&backup_path).expect("validate portable backup archive");

        // Close source
        source_state.db.close().await;

        // 3. Create target clean directory
        let target_dir =
            std::env::temp_dir().join(format!("alpha-target-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&target_dir).unwrap();
        let target_db_path = target_dir.join("attendance.db");

        // 4. Request restore into clean target directory
        let marker = restore_request_path(&target_dir);
        std::fs::write(&marker, backup_path.to_string_lossy().into_owned()).unwrap();

        let outcome = process_restore_request(&target_dir, &target_dir, &target_db_path).await;
        assert_eq!(
            outcome,
            RestoreOutcome::Restored {
                source: backup_path.clone()
            }
        );
        assert!(!marker.exists());

        // 5. Open target database and verify integrity & data
        validate_database_file(&target_db_path)
            .await
            .expect("restored database integrity check");

        let target_state = AppState::new(
            target_dir.clone(),
            target_db_path.clone(),
            target_dir.join("exports"),
            false,
            crate::config::LanConfig::default(),
            crate::config::OfficeConfig::default(),
            ScannerConfig::default(),
            crate::config::TtsConfig::default(),
        )
        .await
        .expect("open restored database");

        // Check user counts and specific records
        let users_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&target_state.db)
            .await
            .unwrap();
        assert_eq!(users_count, 2);

        let intern_name: String =
            sqlx::query_scalar("SELECT full_name FROM users WHERE user_id = 'INTERN-PORT-001'")
                .fetch_one(&target_state.db)
                .await
                .unwrap();
        assert_eq!(intern_name, "PORTABILITY_TEST_INTERN_001");

        let intern_card: String =
            sqlx::query_scalar("SELECT rfid_uid FROM users WHERE user_id = 'INTERN-PORT-001'")
                .fetch_one(&target_state.db)
                .await
                .unwrap();
        assert_eq!(intern_card, "CARD-PORTABILITY-001");

        let emp_card: String =
            sqlx::query_scalar("SELECT rfid_uid FROM users WHERE user_id = 'EMP-PORT-002'")
                .fetch_one(&target_state.db)
                .await
                .unwrap();
        assert_eq!(emp_card, "CARD-PORTABILITY-002");

        // Check attendance records
        let attendance_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attendance")
            .fetch_one(&target_state.db)
            .await
            .unwrap();
        assert_eq!(attendance_count, 2);

        let att_dates: Vec<String> =
            sqlx::query_scalar("SELECT attendance_date FROM attendance ORDER BY attendance_date")
                .fetch_all(&target_state.db)
                .await
                .unwrap();
        assert_eq!(att_dates, vec!["2026-08-10", "2026-08-11"]);

        // Check all other tables
        let audit_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_logs")
            .fetch_one(&target_state.db)
            .await
            .unwrap();
        assert_eq!(audit_count, 1);

        let grace_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM intern_grace")
            .fetch_one(&target_state.db)
            .await
            .unwrap();
        assert_eq!(grace_count, 1);

        let profile_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM payroll_profiles")
            .fetch_one(&target_state.db)
            .await
            .unwrap();
        assert_eq!(profile_count, 3); // 2 default seed profiles + 1 custom

        let profile_label: String = sqlx::query_scalar(
            "SELECT label FROM payroll_profiles WHERE profile_id = 'PROF-PORT-001'",
        )
        .fetch_one(&target_state.db)
        .await
        .unwrap();
        assert_eq!(profile_label, "Semi-Monthly Standard");

        let cutoff_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM payroll_cutoffs")
            .fetch_one(&target_state.db)
            .await
            .unwrap();
        assert_eq!(cutoff_count, 1);

        let snap_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM payroll_snapshots")
            .fetch_one(&target_state.db)
            .await
            .unwrap();
        assert_eq!(snap_count, 1);

        let job_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM export_jobs")
            .fetch_one(&target_state.db)
            .await
            .unwrap();
        assert_eq!(job_count, 1);

        let art_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM generated_artifacts")
            .fetch_one(&target_state.db)
            .await
            .unwrap();
        assert_eq!(art_count, 1);

        let pdf_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM payroll_pdfs")
            .fetch_one(&target_state.db)
            .await
            .unwrap();
        assert_eq!(pdf_count, 1);

        let queue_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_queue")
            .fetch_one(&target_state.db)
            .await
            .unwrap();
        assert_eq!(queue_count, 1);

        let sync_state_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_state")
            .fetch_one(&target_state.db)
            .await
            .unwrap();
        assert_eq!(sync_state_count, 1);

        // 6. Test post-restore write capability
        let now_str = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO attendance (attendance_id, attendance_date, user_id, rfid_uid, full_name, department, time_in, time_out, status, source, notes, created_at, updated_at)
             VALUES ('ATT-PORT-POST-RESTORE', '2026-08-12', 'INTERN-PORT-001', 'CARD-PORTABILITY-001', 'PORTABILITY_TEST_INTERN_001', 'Engineering', '2026-08-12T08:00:00+08:00', NULL, 'WORKING', 'RFID', '', ?, ?)",
        )
        .bind(&now_str)
        .bind(&now_str)
        .execute(&target_state.db)
        .await
        .expect("write post-restore attendance record");

        let updated_att_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attendance")
            .fetch_one(&target_state.db)
            .await
            .unwrap();
        assert_eq!(updated_att_count, 3);

        target_state.db.close().await;

        let _ = std::fs::remove_dir_all(&source_dir);
        let _ = std::fs::remove_dir_all(&target_dir);
    }

    #[tokio::test]
    async fn validate_portable_backup_rejects_corrupted_archive() {
        let temp_dir = std::env::temp_dir().join(format!("alpha-corrupt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();

        // Non-zip file
        let bad_zip = temp_dir.join("bad.apbackup");
        std::fs::write(&bad_zip, b"This is not a zip file").unwrap();
        assert!(validate_portable_backup(&bad_zip).is_err());

        // Zip missing manifest.json
        let missing_manifest = temp_dir.join("no_manifest.apbackup");
        {
            let file = std::fs::File::create(&missing_manifest).unwrap();
            let mut zip = ZipWriter::new(file);
            zip.start_file("some_file.txt", SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"hello").unwrap();
            zip.finish().unwrap();
        }
        assert!(validate_portable_backup(&missing_manifest).is_err());

        // Zip missing database/attendance.db
        let missing_db = temp_dir.join("no_db.apbackup");
        {
            let file = std::fs::File::create(&missing_db).unwrap();
            let mut zip = ZipWriter::new(file);
            zip.start_file("manifest.json", SimpleFileOptions::default())
                .unwrap();
            zip.write_all(br#"{"format":"alpha-premier-application-backup","version":1}"#)
                .unwrap();
            zip.finish().unwrap();
        }
        assert!(validate_portable_backup(&missing_db).is_err());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn restore_rejects_corrupted_or_non_sqlite_file_and_preserves_active_db() {
        let dir =
            std::env::temp_dir().join(format!("alpha-corrupt-restore-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let current = seed_database(&dir).await;
        current.db.close().await;

        let bad_backup = dir.join("fake_backup.apbackup");
        std::fs::write(&bad_backup, b"CORRUPTED_DATA").unwrap();

        let marker = restore_request_path(&dir);
        std::fs::write(&marker, bad_backup.to_string_lossy().into_owned()).unwrap();

        let db_path = dir.join("attendance.db");
        let outcome = process_restore_request(&dir, &dir, &db_path).await;

        assert!(matches!(outcome, RestoreOutcome::Failed { .. }));
        assert!(restore_failed_path(&dir).exists());
        assert!(!marker.exists());

        // Verify active database was preserved and remains intact
        validate_database_file(&db_path)
            .await
            .expect("active database preserved and valid");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn two_isolated_data_directories_remain_isolated() {
        let dir1 = std::env::temp_dir().join(format!("alpha-iso-1-{}", uuid::Uuid::new_v4()));
        let dir2 = std::env::temp_dir().join(format!("alpha-iso-2-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir1).unwrap();
        std::fs::create_dir_all(&dir2).unwrap();

        let state1 = seed_database(&dir1).await;
        let state2 = AppState::new(
            dir2.clone(),
            dir2.join("attendance.db"),
            dir2.join("exports"),
            false,
            crate::config::LanConfig::default(),
            crate::config::OfficeConfig::default(),
            ScannerConfig::default(),
            crate::config::TtsConfig::default(),
        )
        .await
        .unwrap();

        // Mutate dir1
        sqlx::query("INSERT INTO users (user_id, rfid_uid, full_name, status, created_at, updated_at) VALUES ('U2', 'C2', 'Bob', 'ACTIVE', 'now', 'now')")
            .execute(&state1.db)
            .await
            .unwrap();

        let count1: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&state1.db)
            .await
            .unwrap();
        let count2: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&state2.db)
            .await
            .unwrap();

        assert_eq!(count1, 2);
        assert_eq!(count2, 0);

        state1.db.close().await;
        state2.db.close().await;

        let _ = std::fs::remove_dir_all(&dir1);
        let _ = std::fs::remove_dir_all(&dir2);
    }

    #[tokio::test]
    async fn multi_generation_backup_restore_parity_roundtrip() {
        // App 1: Source directory with database, photos, exports, config, and runtime folders (logs, EBWebView)
        let dir1 = std::env::temp_dir().join(format!("alpha-gen1-{}", uuid::Uuid::new_v4()));
        let dir2 = std::env::temp_dir().join(format!("alpha-gen2-{}", uuid::Uuid::new_v4()));
        let dir3 = std::env::temp_dir().join(format!("alpha-gen3-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir1).unwrap();
        std::fs::create_dir_all(&dir2).unwrap();
        std::fs::create_dir_all(&dir3).unwrap();

        // 1. Seed App 1
        let state1 = seed_full_test_database(&dir1).await;
        // Create photos and dummy export files in dir1
        let photos_dir1 = dir1.join("photos");
        std::fs::create_dir_all(&photos_dir1).unwrap();
        std::fs::write(photos_dir1.join("user1.webp"), b"photo-bytes-1").unwrap();
        let logs_dir1 = dir1.join("logs");
        std::fs::create_dir_all(&logs_dir1).unwrap();
        std::fs::write(logs_dir1.join("app.log"), b"runtime log content").unwrap();

        // Create Backup 1 from App 1
        let backup1 = create_portable_backup(&state1.db, &dir1, &dir1, &state1.db_path)
            .await
            .expect("create backup 1");
        assert!(backup1.is_file());
        assert_eq!(
            detect_backup_format(&backup1).unwrap(),
            BackupFormat::PortableArchive
        );
        state1.db.close().await;

        // 2. Set up App 2 with existing runtime logs and EBWebView directories (which would be locked)
        let logs_dir2 = dir2.join("logs");
        std::fs::create_dir_all(&logs_dir2).unwrap();
        std::fs::write(logs_dir2.join("Alpha Premier Attendance.log"), b"active log").unwrap();
        let ebwebview_dir2 = dir2.join("EBWebView");
        std::fs::create_dir_all(&ebwebview_dir2).unwrap();
        std::fs::write(ebwebview_dir2.join("cache.dat"), b"webview cache").unwrap();

        // Restore Backup 1 into App 2
        let marker2 = restore_request_path(&dir2);
        std::fs::write(&marker2, backup1.to_string_lossy().into_owned()).unwrap();
        let db2_path = dir2.join("attendance.db");
        let outcome2 = process_restore_request(&dir2, &dir2, &db2_path).await;
        assert_eq!(outcome2, RestoreOutcome::Restored { source: backup1 });
        assert!(!marker2.exists());

        // Open App 2
        let state2 = AppState::new(
            dir2.clone(),
            db2_path.clone(),
            dir2.join("exports"),
            false,
            crate::config::LanConfig::default(),
            crate::config::OfficeConfig::default(),
            ScannerConfig::default(),
            crate::config::TtsConfig::default(),
        )
        .await
        .expect("open app 2");

        let users2_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&state2.db)
            .await
            .unwrap();
        assert_eq!(users2_count, 2);
        assert!(dir2.join("photos/user1.webp").is_file());

        // 3. Create Backup 2 from App 2 (the restored system!)
        let backup2 = create_portable_backup(&state2.db, &dir2, &dir2, &state2.db_path)
            .await
            .expect("create backup 2 from restored app");
        assert!(backup2.is_file());
        state2.db.close().await;

        // 4. Restore Backup 2 into a fresh App 3
        let marker3 = restore_request_path(&dir3);
        std::fs::write(&marker3, backup2.to_string_lossy().into_owned()).unwrap();
        let db3_path = dir3.join("attendance.db");
        let outcome3 = process_restore_request(&dir3, &dir3, &db3_path).await;
        assert_eq!(outcome3, RestoreOutcome::Restored { source: backup2 });

        // Open App 3 and verify 100% parity with original data
        let state3 = AppState::new(
            dir3.clone(),
            db3_path.clone(),
            dir3.join("exports"),
            false,
            crate::config::LanConfig::default(),
            crate::config::OfficeConfig::default(),
            ScannerConfig::default(),
            crate::config::TtsConfig::default(),
        )
        .await
        .expect("open app 3");

        let users3_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&state3.db)
            .await
            .unwrap();
        assert_eq!(users3_count, 2);

        let att3_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attendance")
            .fetch_one(&state3.db)
            .await
            .unwrap();
        assert_eq!(att3_count, 2);

        assert!(dir3.join("photos/user1.webp").is_file());
        assert_eq!(
            std::fs::read(dir3.join("photos/user1.webp")).unwrap(),
            b"photo-bytes-1"
        );

        state3.db.close().await;

        let _ = std::fs::remove_dir_all(&dir1);
        let _ = std::fs::remove_dir_all(&dir2);
        let _ = std::fs::remove_dir_all(&dir3);
    }
}
