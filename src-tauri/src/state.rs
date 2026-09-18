use crate::{
    config::{LanConfig, OfficeConfig, ScannerConfig, TtsConfig, UpdaterConfig},
    error::AppError,
    lan_server::{self, LanIssue},
    services::sheets_sync::GoogleSheetsTarget,
    services::sync_retry::{DtrThrottleBucket, wall_now_ms},
    tts::TtsManager,
};
use sqlx::{sqlite::SqliteConnectOptions, SqlitePool};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::broadcast;
use uuid::Uuid;

pub const MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./db/migrations");

pub async fn run_migrations(db: &SqlitePool) -> Result<(), sqlx::migrate::MigrateError> {
    let mut result = MIGRATOR.run(db).await;
    if let Err(sqlx::migrate::MigrateError::VersionMismatch(v)) = &result {
        log::warn!("Migration version mismatch detected for version {v}; syncing checksums with compiled migrations");
        for migration in MIGRATOR.iter() {
            let _ = sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = ?")
                .bind(migration.checksum.as_ref())
                .bind(migration.version)
                .execute(db)
                .await;
        }
        result = MIGRATOR.run(db).await;
    }
    if let Err(sqlx::migrate::MigrateError::VersionMissing(v)) = &result {
        log::warn!("Migration version {v} missing from compiled migrations; removing orphaned migration record and syncing");
        let compiled_versions: Vec<i64> = MIGRATOR.iter().map(|m| m.version).collect();
        for missing_ver in sqlx::query_scalar::<_, i64>("SELECT version FROM _sqlx_migrations")
            .fetch_all(db)
            .await
            .unwrap_or_default()
        {
            if !compiled_versions.contains(&missing_ver) {
                let _ = sqlx::query("DELETE FROM _sqlx_migrations WHERE version = ?")
                    .bind(missing_ver)
                    .execute(db)
                    .await;
            }
        }
        result = MIGRATOR.run(db).await;
    }
    result
}

#[derive(Clone)]
pub struct AttendanceEventBus {
    pub sender: broadcast::Sender<crate::lan_server::LanAttendanceEvent>,
    pub sequence: Arc<AtomicU64>,
}

impl AttendanceEventBus {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(256);
        Self {
            sender,
            sequence: Arc::new(AtomicU64::new(0)),
        }
    }
}

/// Lifecycle phase of the LAN attendance viewer server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LanPhase {
    #[default]
    Stopped,
    Starting,
    Running,
    Error,
}

/// Snapshot of the LAN viewer runtime (phase, bound socket, diagnostics).
#[derive(Debug, Clone, Default)]
pub struct LanRuntimeStatus {
    pub phase: LanPhase,
    pub bind_address: Option<std::net::SocketAddr>,
    pub started_at: Option<u64>,
    pub last_error: Option<String>,
    pub issue: LanIssue,
}

struct LanRuntimeInner {
    status: LanRuntimeStatus,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}

/// Owns the running LAN viewer task so the Live Attendance panel can start,
/// verify, and stop the server at runtime (in addition to config-driven
/// auto-start at boot).
#[derive(Clone)]
pub struct LanRuntime {
    inner: std::sync::Arc<tokio::sync::Mutex<LanRuntimeInner>>,
}

impl LanRuntime {
    pub fn new() -> Self {
        Self {
            inner: std::sync::Arc::new(tokio::sync::Mutex::new(LanRuntimeInner {
                status: LanRuntimeStatus::default(),
                task: None,
            })),
        }
    }

    pub async fn phase(&self) -> LanPhase {
        self.inner.lock().await.status.phase
    }

    pub async fn snapshot(&self) -> LanRuntimeStatus {
        self.inner.lock().await.status.clone()
    }

    /// Bind the viewer to the configured/detected LAN address and serve until
    /// stopped. Idempotent: returns immediately when already running.
    pub async fn start(&self, state: &AppState) -> Result<(), String> {
        {
            let mut guard = self.inner.lock().await;
            if guard.status.phase == LanPhase::Running
                || guard.status.phase == LanPhase::Starting
            {
                return Ok(());
            }
            guard.status.phase = LanPhase::Starting;
            guard.status.last_error = None;
            guard.status.issue = LanIssue::None;
        }

        match lan_server::bind_and_serve(state.clone()).await {
            Ok((address, task)) => {
                let mut guard = self.inner.lock().await;
                guard.status.phase = LanPhase::Running;
                guard.status.bind_address = Some(address);
                guard.status.started_at = Some(
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs(),
                );
                guard.task = Some(task);
                Ok(())
            }
            Err(error) => {
                let mut guard = self.inner.lock().await;
                guard.status.phase = LanPhase::Error;
                guard.status.bind_address = None;
                guard.status.started_at = None;
                guard.status.last_error = Some(error.to_string());
                guard.status.issue = error.issue();
                guard.task = None;
                Err(error.to_string())
            }
        }
    }

    /// Abort the serving task and reset to the stopped state.
    pub async fn stop(&self) {
        let mut guard = self.inner.lock().await;
        if let Some(task) = guard.task.take() {
            task.abort();
        }
        guard.status = LanRuntimeStatus::default();
    }
}

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    /// Absolute path of the live `attendance.db` file (configurable).
    pub db_path: PathBuf,
    /// Directory holding timestamped SQLite backups (`data_dir/backups`).
    pub backups_dir: PathBuf,
    pub lan: LanConfig,
    pub office: OfficeConfig,
    pub bus: AttendanceEventBus,
    pub server_instance_id: Uuid,
    pub data_dir: PathBuf,
    pub exports_dir: PathBuf,
    pub is_portable: bool,
    pub scan_debounce: Arc<tokio::sync::Mutex<HashMap<String, ScanDebounce>>>,
    pub connected_sse_clients: Arc<AtomicU64>,
    pub started_at: u64,
    pub admin_session: Arc<tokio::sync::Mutex<Option<AdminSession>>>,
    pub lan_runtime: std::sync::Arc<LanRuntime>,
    /// Native RFID scanner control surface (status + pause) shared with the
    /// scanner worker threads.
    pub scanner: Arc<crate::services::scanner::ScannerHandle>,
    /// Cached resolved Google Sheets/Drive target from the provisioning step.
    /// Kept in-process so the periodic sync worker reuses the same IDs instead
    /// of re-provisioning on every pass; the authoritative IDs are persisted
    /// in `data_dir/google-sheets-state.json`.
    pub google_sheets_target: Arc<tokio::sync::RwLock<Option<GoogleSheetsTarget>>>,
    /// Plan todo 8: DTR-spreadsheet-only dispatch throttle (50 writes/min
    /// + ≤10 batch calls/min). Lives here so the quota survives across
    /// 30s ticks; short lock-take-unlock admissions keep it contention-free
    /// under the single queue loop (concurrency 1, mutex as backstop).
    pub dtr_throttle: Arc<tokio::sync::Mutex<DtrThrottleBucket>>,
    /// Plan todo 8 (frozen): in-memory half of the shared in-progress guard.
    /// Fast mutual exclusion across admin_sync_now + admin_sync_intern_dtr +
    /// per-row sync; the persisted half is the sync_state row
    /// (__sync_guard__/manual_dtr_sync). Fresh false on every boot — a
    /// restart can never inherit a held flag.
    pub sync_in_progress: Arc<AtomicBool>,
    /// Plan todo 10: cumulative PROCESSING-lease recoveries since boot,
    /// surfaced as `leaseRecovered` in the admin health contract.
    pub lease_recovered: Arc<AtomicU64>,
    pub tts: Arc<TtsManager>,
    pub updater: UpdaterConfig,
}

/// Single debounce record per card: `fast` stamps every scan attempt up front
/// (500 ms duplicate guard, fires even when the DB write later fails) while
/// `slow` stamps only successful writes (10 s physical cooldown). One map and
/// one lock replace the former parallel `scan_guard` + `physical_cooldown`
/// collections so the two windows can never disagree on the key.
#[derive(Clone, Copy)]
pub struct ScanDebounce {
    pub fast: Instant,
    pub slow: Option<Instant>,
}

#[derive(Clone)]
pub struct AdminSession {
    pub token: String,
    pub expires_at: Instant,
}

impl AppState {
    pub async fn new(
        data_dir: PathBuf,
        db_path: PathBuf,
        exports_dir: PathBuf,
        is_portable: bool,
        lan: LanConfig,
        office: OfficeConfig,
        scanner: ScannerConfig,
        tts: TtsConfig,
        updater: UpdaterConfig,
    ) -> Result<Self, AppError> {
        std::fs::create_dir_all(&data_dir).map_err(|e| AppError::Configuration(e.to_string()))?;
        std::fs::create_dir_all(&exports_dir)
            .map_err(|e| AppError::Configuration(e.to_string()))?;
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                AppError::Configuration(format!("create database folder {}: {e}", parent.display()))
            })?;
        }
        let backups_dir = data_dir.join("backups");
        std::fs::create_dir_all(&backups_dir)
            .map_err(|e| AppError::Configuration(e.to_string()))?;
        let options = SqliteConnectOptions::new()
            .filename(&db_path)
            .create_if_missing(true);
        let db = SqlitePool::connect_with(options).await?;
        sqlx::query("PRAGMA journal_mode = WAL")
            .execute(&db)
            .await?;
        sqlx::query("PRAGMA foreign_keys = ON").execute(&db).await?;
        run_migrations(&db).await?;
        // Plan todo 8: clean restart always marks the persisted guard row
        // completed (in-memory starts false by construction above). A
        // kill-mid-sync therefore auto-clears on next boot; only a live
        // fresh row blocks, and only for its 5-min stale horizon.
        sync_guard_clear_on_boot(&db).await;
        Ok(Self {
            db,
            db_path,
            backups_dir,
            lan,
            office,
            bus: AttendanceEventBus::new(),
            server_instance_id: Uuid::new_v4(),
            data_dir,
            exports_dir,
            is_portable,
            scan_debounce: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            connected_sse_clients: Arc::new(AtomicU64::new(0)),
            started_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            admin_session: Arc::new(tokio::sync::Mutex::new(None)),
            lan_runtime: Arc::new(LanRuntime::new()),
            scanner: Arc::new(crate::services::scanner::ScannerHandle::new(scanner)),
            google_sheets_target: Arc::new(tokio::sync::RwLock::new(None)),
            dtr_throttle: Arc::new(tokio::sync::Mutex::new(DtrThrottleBucket::new(
                wall_now_ms(),
            ))),
            sync_in_progress: Arc::new(AtomicBool::new(false)),
            lease_recovered: Arc::new(AtomicU64::new(0)),
            tts: Arc::new(TtsManager::new(tts)),
            updater,
        })
    }

    pub fn next_sequence(&self) -> u64 {
        self.bus.sequence.fetch_add(1, Ordering::Relaxed) + 1
    }
}

/// Plan todo 8 (frozen guard API — todos 9-10 build UI on it): the DB half
/// of the shared in-progress guard. Owner strings: "admin_sync_now",
/// "admin_sync_intern_dtr:bulk", "admin_sync_intern_dtr:user:<id>".
fn sync_guard_epoch_secs(started_at: &str) -> Option<u64> {
    chrono::DateTime::parse_from_rfc3339(started_at)
        .ok()
        .and_then(|value| u64::try_from(value.timestamp()).ok())
}

fn sync_guard_now_epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

async fn sync_guard_read_row(db: &SqlitePool) -> (Option<String>, Option<String>) {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT last_synced_hash, last_synced_at FROM sync_state WHERE table_name = ? AND row_id = ?",
    )
    .bind(crate::services::sync_retry::SYNC_GUARD_TABLE)
    .bind(crate::services::sync_retry::SYNC_GUARD_ROW)
    .fetch_optional(db)
    .await
    .unwrap_or(None);
    match row {
        Some((owner, started_at)) => (Some(owner), Some(started_at)),
        None => (None, None),
    }
}

async fn sync_guard_write_row(db: &SqlitePool, owner: &str, started_at: &str) {
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS sync_state (table_name TEXT NOT NULL, row_id TEXT NOT NULL, last_synced_hash TEXT NOT NULL, sheet_row_number INTEGER, last_synced_at TEXT NOT NULL, PRIMARY KEY (table_name, row_id))",
    )
    .execute(db)
    .await;
    let _ = sqlx::query(
        "INSERT INTO sync_state (table_name, row_id, last_synced_hash, sheet_row_number, last_synced_at) VALUES (?, ?, ?, NULL, ?) \
         ON CONFLICT(table_name, row_id) DO UPDATE SET last_synced_hash = excluded.last_synced_hash, last_synced_at = excluded.last_synced_at",
    )
    .bind(crate::services::sync_retry::SYNC_GUARD_TABLE)
    .bind(crate::services::sync_retry::SYNC_GUARD_ROW)
    .bind(owner)
    .bind(started_at)
    .execute(db)
    .await;
}

/// Acquire the shared guard. In-memory AtomicBool first (fast path); then
/// the persisted row with 5-min stale release. The second caller gets
/// DTR_SYNC_IN_PROGRESS and the flag is rolled back so a denial never
/// leaves the guard held. Stale/corrupt/completed rows are claimed by
/// overwriting owner/startedAt.
pub async fn sync_guard_try_acquire(
    db: &SqlitePool,
    flag: &AtomicBool,
    owner: &str,
) -> Result<(), String> {
    use crate::services::sync_retry::{sync_guard_busy_error, sync_guard_row_releasable};
    if flag
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        let (holder, started) = sync_guard_read_row(db).await;
        return Err(sync_guard_busy_error(
            holder.as_deref().unwrap_or("unknown"),
            started.as_deref().unwrap_or("unknown"),
        ));
    }
    let now_secs = sync_guard_now_epoch_secs();
    let (stored_owner, stored_started) = sync_guard_read_row(db).await;
    let stored_secs = stored_started
        .as_deref()
        .and_then(sync_guard_epoch_secs);
    if !sync_guard_row_releasable(stored_owner.as_deref(), stored_secs, now_secs) {
        flag.store(false, Ordering::SeqCst);
        return Err(sync_guard_busy_error(
            stored_owner.as_deref().unwrap_or("unknown"),
            stored_started.as_deref().unwrap_or("unknown"),
        ));
    }
    sync_guard_write_row(db, owner, &chrono::Utc::now().to_rfc3339()).await;
    Ok(())
}

/// Release the guard: persisted row back to completed, then the flag.
/// DB errors are log-only — the flag must never stay held after release.
pub async fn sync_guard_release(db: &SqlitePool, flag: &AtomicBool) {
    sync_guard_write_row(
        db,
        crate::services::sync_retry::SYNC_GUARD_COMPLETED,
        &chrono::Utc::now().to_rfc3339(),
    )
    .await;
    flag.store(false, Ordering::SeqCst);
}

/// Boot clear: a restart (clean or kill-mid-sync) always marks the row
/// completed. Log-only by contract — startup must survive DB errors.
pub async fn sync_guard_clear_on_boot(db: &SqlitePool) {
    sync_guard_write_row(
        db,
        crate::services::sync_retry::SYNC_GUARD_COMPLETED,
        &chrono::Utc::now().to_rfc3339(),
    )
    .await;
}

/// Active holder for the todo-10 health contract: Some((owner, startedAt))
/// only while a fresh (non-stale, non-completed) row is held.
pub async fn sync_guard_status(db: &SqlitePool) -> Option<(String, String)> {
    use crate::services::sync_retry::{SYNC_GUARD_COMPLETED, sync_guard_row_releasable};
    let (owner, started) = sync_guard_read_row(db).await;
    let owner = owner?;
    let started_at = started?;
    if owner == SYNC_GUARD_COMPLETED {
        return None;
    }
    let stored_secs = sync_guard_epoch_secs(&started_at);
    if sync_guard_row_releasable(Some(&owner), stored_secs, sync_guard_now_epoch_secs()) {
        return None;
    }
    Some((owner, started_at))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{LanConfig, ScannerConfig};

    #[tokio::test]
    async fn migrations_create_required_indexes_and_queue() {
        let data_dir = std::env::temp_dir().join(format!("alpha-data-{}", Uuid::new_v4()));
        let exports_dir = data_dir.join("exports");
        let state = AppState::new(
            data_dir.clone(),
            data_dir.join("attendance.db"),
            exports_dir,
            false,
            LanConfig::default(),
            OfficeConfig::default(),
            ScannerConfig::default(),
            TtsConfig::default(),
            UpdaterConfig::default(),
        )
        .await
        .unwrap();
        let names: Vec<String> =
            sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='index'")
                .fetch_all(&state.db)
                .await
                .unwrap();
        assert!(names.iter().any(|name| name == "ux_attendance_user_date"));
        assert!(names.iter().any(|name| name == "ux_grace_user_week"));
        assert!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sync_queue")
                .fetch_one(&state.db)
                .await
                .unwrap()
                == 0
        );
        assert!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='export_jobs'"
            )
            .fetch_one(&state.db)
            .await
            .unwrap()
                == 1
        );
        assert!(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='payroll_snapshots'").fetch_one(&state.db).await.unwrap() == 1);
        assert!(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='ux_sync_queue_idempotency'").fetch_one(&state.db).await.unwrap() == 1);
        assert!(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='trg_prevent_admin_card_attendance'").fetch_one(&state.db).await.unwrap() == 1);

        // Verify trigger aborts attendance insert for admin assist card
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query("INSERT INTO users (user_id, rfid_uid, full_name, status, card_type, created_at, updated_at) VALUES ('ADMIN-CARD-1', 'ADM123', 'Front Desk Admin', 'ACTIVE', 'ADMIN_ASSIST', ?, ?)")
            .bind(&now).bind(&now).execute(&state.db).await.unwrap();
        let att_result = sqlx::query("INSERT INTO attendance (attendance_id, attendance_date, user_id, rfid_uid, full_name, status, source, created_at, updated_at) VALUES ('att-admin-1', '2026-08-27', 'ADMIN-CARD-1', 'ADM123', 'Front Desk Admin', 'WORKING', 'RFID', ?, ?)")
            .bind(&now).bind(&now).execute(&state.db).await;
        assert!(att_result.is_err());
        assert!(att_result.unwrap_err().to_string().contains("Cannot record attendance for admin assist card"));

        state.db.close().await;
        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[tokio::test]
    async fn creates_a_configurable_database_path_in_a_new_directory() {
        let temp = std::env::temp_dir().join(format!("alpha-dbpath-{}", Uuid::new_v4()));
        let data_dir = temp.join("data");
        // The configured database path points into a directory that does not
        // exist yet; AppState::new must create it.
        let db_path = temp.join("shared").join("attendance.db");
        let state = AppState::new(
            data_dir.clone(),
            db_path.clone(),
            data_dir.join("exports"),
            false,
            LanConfig::default(),
            OfficeConfig::default(),
            ScannerConfig::default(),
            TtsConfig::default(),
            UpdaterConfig::default(),
        )
        .await
        .unwrap();
        assert!(
            db_path.is_file(),
            "database file must be created at the configured path"
        );
        let names: Vec<String> =
            sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='table'")
                .fetch_all(&state.db)
                .await
                .unwrap();
        assert!(names.iter().any(|name| name == "users"));
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }
}
