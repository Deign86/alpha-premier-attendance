use crate::state::AppState;
use std::path::Path;
use super::session::Admin;
use tauri::State;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
/// Status of the local SQLite database for the Data & backup admin panel:
/// live file path, mode, pending restore, and existing backups.
pub(crate) async fn db_info(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let backups = crate::database::list_backups(&state.data_dir).await?;
    let marker = crate::database::restore_request_path(&state.data_dir);
    let restore_pending = marker.is_file();
    let restore_source = if restore_pending {
        std::fs::read_to_string(&marker)
            .ok()
            .map(|text| text.trim().to_string())
    } else {
        None
    };
    // BUG-DB-01: surface a failed scheduled restore (restore.failed marker)
    // so the admin panel can warn the operator instead of staying silent.
    let restore_failed_marker = crate::database::restore_failed_path(&state.data_dir);
    let restore_failed = if restore_failed_marker.is_file() {
        std::fs::read_to_string(&restore_failed_marker)
            .ok()
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty())
    } else {
        None
    };
    let last_backup_at = backups
        .first()
        .and_then(|(path, _)| std::fs::metadata(path).ok())
        .and_then(|metadata| metadata.modified().ok())
        .map(|time| {
            let dt: chrono::DateTime<chrono::Utc> = time.into();
            dt.to_rfc3339()
        });
    let backup_items: Vec<serde_json::Value> = backups
        .iter()
        .map(|(path, size)| {
            let modified = std::fs::metadata(path)
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .map(|time| {
                    let dt: chrono::DateTime<chrono::Utc> = time.into();
                    dt.to_rfc3339()
                });
            serde_json::json!({
                "fileName": path.file_name().and_then(|name| name.to_str()).unwrap_or(""),
                "filePath": path.to_string_lossy(),
                "sizeBytes": size,
                "modifiedAt": modified,
            })
        })
        .collect();
    Ok(serde_json::json!({
        "success": true,
        "dbPath": state.db_path.to_string_lossy(),
        "dataDir": state.data_dir.to_string_lossy(),
        "backupDir": state.backups_dir.to_string_lossy(),
        "isPortableMode": state.is_portable,
        "restorePending": restore_pending,
        "restoreSourcePath": restore_source,
        "restoreFailed": restore_failed,
        "backups": backup_items,
        "lastBackupAt": last_backup_at,
    }))
}

#[tauri::command]
/// Create a consistent timestamped backup of the SQLite database into
/// `data_dir/backups` (keeps the newest 10). Safe while the app is running.
pub(crate) async fn db_backup(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    token: String,
) -> Result<serde_json::Value, String> {
    Admin::check(&state, &token).await?;
    let config_dir = crate::paths::resolve(&app)?.config_dir;
    let file_path = crate::database::create_portable_backup(
        &state.db,
        &state.data_dir,
        &config_dir,
        &state.db_path,
    )
    .await?;
    let file_name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("attendance.db")
        .to_string();
    Ok(serde_json::json!({
        "success": true,
        "filePath": file_path.to_string_lossy(),
        "directoryPath": state.backups_dir.to_string_lossy(),
        "fileName": file_name,
        "fileKind": "backup",
        "isPortableMode": state.is_portable,
        "message": "Backup created.",
    }))
}

#[tauri::command]
/// Schedule a database restore: validate the source file, write the
/// `restore.request` marker, then exit the app. The next launch restores the
/// database from the marker before opening it (see
/// `crate::database::process_restore_request`).
pub(crate) async fn db_restore_request(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    token: String,
    source_path: String,
) -> Result<serde_json::Value, String> {
    Admin::check(&state, &token).await?;
    let source = std::path::PathBuf::from(source_path.trim());
    if source.as_os_str().is_empty() {
        return Err("RESTORE_SOURCE_REQUIRED".into());
    }
    if !source.is_file() {
        return Err("RESTORE_SOURCE_NOT_FOUND".into());
    }
    let format = crate::database::detect_backup_format(&source)
        .map_err(|error| format!("RESTORE_SOURCE_INVALID: {error}"))?;
    let validation = match format {
        crate::database::BackupFormat::PortableArchive => {
            crate::database::validate_portable_backup(&source)
        }
        crate::database::BackupFormat::SqliteDatabase => {
            crate::database::validate_database_file(&source).await
        }
    };
    validation.map_err(|error| format!("RESTORE_SOURCE_INVALID: {error}"))?;
    let marker = crate::database::restore_request_path(&state.data_dir);
    std::fs::write(&marker, source.to_string_lossy().into_owned())
        .map_err(|error| format!("cannot write restore request: {error}"))?;
    // Drop any stale failure marker from a previous attempt.
    let _ = std::fs::remove_file(crate::database::restore_failed_path(&state.data_dir));
    // Restart cleanly so the next launch restores before opening the database.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        app.restart();
    });
    Ok(serde_json::json!({
        "success": true,
        "message": "Restore scheduled. The application is restarting to apply the backup."
    }))
}

#[tauri::command]
/// Dismiss the persisted restore-failure notice after the operator reviewed it.
pub(crate) async fn db_dismiss_restore_failure(
    state: State<'_, AppState>,
    token: String,
) -> Result<serde_json::Value, String> {
    Admin::check(&state, &token).await?;
    let marker = crate::database::restore_failed_path(&state.data_dir);
    let _ = std::fs::remove_file(&marker);
    Ok(serde_json::json!({"success": true, "message": "Restore failure notice dismissed."}))
}

#[tauri::command]
/// Open the backups folder in the OS file explorer.
pub(crate) async fn db_open_backups_dir(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    token: String,
) -> Result<serde_json::Value, String> {
    Admin::check(&state, &token).await?;
    let dir = state.backups_dir.clone();
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("cannot create backup folder: {error}"))?;
    app.opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| {
            log::error!("open backups dir failed: {error}");
            "OPEN_FAILED".to_string()
        })?;
    Ok(serde_json::json!({"success": true, "message": "Backup folder opened."}))
}

#[tauri::command]
/// Copy one saved backup (must live in the backups folder) to a destination
/// the operator picked in the save dialog, e.g. a USB drive for the new PC.
pub(crate) async fn db_save_backup_copy(
    state: State<'_, AppState>,
    token: String,
    source_path: String,
    destination_path: String,
) -> Result<serde_json::Value, String> {
    Admin::check(&state, &token).await?;
    let source = crate::paths::canonical_within(
        &state.backups_dir,
        Path::new(&source_path),
        "BACKUP_DIR_UNAVAILABLE",
        "FILE_NOT_FOUND",
        "PATH_OUTSIDE_BACKUPS",
    )?;
    if !source.is_file() {
        return Err("FILE_NOT_FOUND".into());
    }
    let destination = std::path::PathBuf::from(destination_path.trim());
    if destination.as_os_str().is_empty() {
        return Err("DESTINATION_REQUIRED".into());
    }
    // Saving onto the backup itself would truncate it before the copy reads it.
    if std::fs::canonicalize(&destination).is_ok_and(|existing| existing == source) {
        return Err("DESTINATION_IS_SOURCE".into());
    }
    std::fs::copy(&source, &destination)
        .map_err(|error| format!("BACKUP_COPY_FAILED: {error}"))?;
    Ok(serde_json::json!({"success": true, "message": "Backup copied."}))
}
