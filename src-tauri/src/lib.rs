mod commands;
mod config;
mod database;
mod error;
mod lan_net;
mod lan_server;
mod lifecycle;
mod paths;
pub mod reporting;
mod services;
mod state;
mod tts;

use commands::sync::emit_dtr_sync_health;
use crate::state::AppState;
use tauri::Manager;

pub fn run() {
    std::panic::set_hook(Box::new(|info| {
        log::error!("CRITICAL PANIC: {:?}", info);
        eprintln!("CRITICAL PANIC: {:?}", info);
    }));

    log::info!("Starting Alpha Premier Attendance application...");

    let single_instance_listener = match lifecycle::check_single_instance() {
        lifecycle::SingleInstanceStatus::Primary(listener) => listener,
        lifecycle::SingleInstanceStatus::SecondaryExited => {
            log::info!("Secondary instance detected and signaled; exiting gracefully.");
            return;
        }
    };

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                // Keep stdout plus a capped file target under the app log dir
                // so Windows-login failures leave evidence; current + 3 rotated
                // files at 5 MB each bounds total log disk use near 20 MB.
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: None,
                    }),
                ])
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(3))
                .max_file_size(5_000_000)
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ));

    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_mcp_bridge::init());

    builder
        .setup(|app| {
            log::info!("Tauri app setup starting...");
            lifecycle::start_single_instance_listener(app.handle().clone(), single_instance_listener);
            lifecycle::install_tray(app).expect("install system tray");
            log::info!("System tray installed successfully");
            let paths = crate::paths::resolve(app.handle()).expect("resolve application paths");
            log::info!("Application paths resolved: config={:?}, data={:?}", paths.config_dir, paths.data_dir);
            std::fs::create_dir_all(&paths.config_dir)
                .expect("create application config directory");
            lifecycle::ensure_default_autostart(app.handle(), &paths.config_dir);
            let (lan, office, scanner_config, database_config, tts_config, updater_config) =
                config::load_config(&paths.config_dir).expect("valid config.toml");
            let db_path =
                crate::paths::resolve_db_path(&paths.config_dir, &paths.data_dir, &database_config);
            // Apply any pending database restore (admin flow marker or
            // ALPHA_PREMIER_RESTORE_FROM) before the database is opened, so
            // the live file is never touched by two processes. A failed
            // restore never blocks startup: the app keeps its current DB and
            // records the problem in `restore.failed`.
            let restore_outcome = tauri::async_runtime::block_on(crate::database::process_restore_request(
                &paths.data_dir,
                &paths.config_dir,
                &db_path,
            ));
            let (lan, office, scanner_config, _database_config, tts_config, updater_config, db_path) =
                match restore_outcome {
                    crate::database::RestoreOutcome::Restored { source } => {
                        log::info!("startup restore applied from {}", source.display());
                        let (lan, office, scanner_config, database_config, tts_config, updater_config) =
                            config::load_config(&paths.config_dir)
                                .expect("valid config.toml after restore");
                        let db_path = crate::paths::resolve_db_path(
                            &paths.config_dir,
                            &paths.data_dir,
                            &database_config,
                        );
                        (lan, office, scanner_config, database_config, tts_config, updater_config, db_path)
                    }
                    crate::database::RestoreOutcome::None => {
                        (lan, office, scanner_config, database_config, tts_config, updater_config, db_path)
                    }
                    crate::database::RestoreOutcome::SkippedMissingSource { source } => {
                        log::warn!(
                            "startup restore skipped: source {} was missing",
                            source.display()
                        );
                        (lan, office, scanner_config, database_config, tts_config, updater_config, db_path)
                    }
                    crate::database::RestoreOutcome::Failed { source, error } => {
                        log::error!(
                            "startup restore failed (source {}): {}; keeping current database",
                            source.display(),
                            error
                        );
                        (lan, office, scanner_config, database_config, tts_config, updater_config, db_path)
                    }
                };
            let state = match tauri::async_runtime::block_on(AppState::new(
                paths.data_dir.clone(),
                db_path,
                paths.exports_dir.clone(),
                paths.is_portable,
                lan,
                office,
                scanner_config,
                tts_config,
                updater_config,
            )) {
                Ok(s) => s,
                Err(err) => {
                    log::error!("SQLite/AppState initialization failed: {err:?}");
                    panic!("SQLite/AppState initialization failed: {err:?}");
                }
            };
            log::info!("AppState initialized successfully");
            let health_app = app.handle().clone();
            let health_state = state.clone();
            tauri::async_runtime::spawn(async move {
                emit_dtr_sync_health(&health_app, &health_state).await;
            });
            if state.lan.enabled || state.lan.allow_runtime_start {
                let runtime = state.lan_runtime.clone();
                let server_state = state.clone();
                tauri::async_runtime::spawn(async move {
                    match runtime.start(&server_state).await {
                        Ok(()) => {
                            let status = runtime.snapshot().await;
                            log::info!(
                                "LAN viewer auto-started at boot: {:?}",
                                status.bind_address
                            );
                        }
                        Err(error) => {
                            log::warn!("LAN viewer auto-start failed (kiosk unaffected): {error}");
                        }
                    }
                });
            }
            let sync_state = state.clone();
            let sync_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // A newly bundled Bea name set replaces older worker clips before the
                // first scan; log-only, a failure just leaves the old clips playing.
                let name_manifest = crate::tts::paths::first_existing(
                    &crate::tts::paths::search_roots(&sync_app),
                    std::path::Path::new("voices/bea/bea-name-manifest.json"),
                );
                if let Some(manifest) = name_manifest {
                    let _ = crate::services::voice_pull::BUNDLED_NAME_MANIFEST.set(manifest.clone());
                    let now = chrono::Utc::now().to_rfc3339();
                    match crate::services::voice_pull::retire_superseded_clips(
                        &sync_state.db,
                        &sync_state.data_dir,
                        &manifest,
                        &now,
                    )
                    .await
                    {
                        Ok(removed) => log::info!("bundled Bea names checked; {removed} worker clips retired"),
                        Err(error) => log::warn!("retiring superseded voice clips failed: {error}"),
                    }
                }
                // Initial 5-second grace period on cold boot prevents network contention
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                let register = crate::services::firebase::built_in();
                let mut pass: u32 = 0;
                loop {
                    let endpoint = sync_state.lan.sheets_sync_endpoint.as_deref();
                    match crate::state::sync_guard_try_acquire(
                        &sync_state.db,
                        sync_state.sync_in_progress.as_ref(),
                        "background_sync",
                    )
                    .await
                    {
                        Ok(()) => {
                            if let Err(error) =
                                crate::services::sheets_sync::run_once(&sync_state, endpoint).await
                            {
                                // Log-only: a failed sync pass must never disturb the kiosk.
                                log::warn!("sheets sync pass failed: {error}");
                            }
                            crate::state::sync_guard_release(
                                &sync_state.db,
                                sync_state.sync_in_progress.as_ref(),
                            )
                            .await;
                            emit_dtr_sync_health(&sync_app, &sync_state).await;
                        }
                        Err(busy) => {
                            log::info!("background sheets sync skipped: {busy}");
                        }
                    }
                    if let Err(error) =
                        crate::services::dtr_recon::check_and_run_scheduled(&sync_state).await
                    {
                        log::warn!("dtr recon scheduled check failed: {error}");
                    }
                    match crate::services::voice_pull::run_once(
                        &sync_state.db,
                        &sync_state.data_dir,
                    )
                    .await
                    {
                        // Log-only: missing clips fall back to Piper speech.
                        Err(error) => log::warn!("voice pull pass failed: {error}"),
                        Ok(summary) => {
                            if let Some(person_id) = summary.attempted_person_id {
                                if summary.completed {
                                    log::info!("voice pull completed clip for {person_id}");
                                }
                            }
                        }
                    }
                    // New interns from the ID register, every fourth pass (two minutes).
                    // Log-only: the problem is also kept for Admin → Settings.
                    if pass % 4 == 0 {
                        match crate::services::id_register::run_once(&sync_state, register.as_ref()).await {
                            Err(error) => log::warn!("id register pass failed: {error}"),
                            Ok(summary) => {
                                if !summary.added.is_empty() {
                                    log::info!("id register added {:?}, waiting for a card", summary.added);
                                }
                            }
                        }
                    }
                    pass = pass.wrapping_add(1);
                    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                }
            });
            // The reader's status for the screens; the webview reads the card keys itself.
            let scanner_handle = state.scanner.clone();
            app.manage(state);
            // Best-effort automatic database backup on clean exit. The backup
            // uses SQLite's online engine, so it is consistent even while the
            // app has been recording scans, and a failed backup never blocks
            // closing the app.
            let webview_windows = app.webview_windows();
            log::info!("Registered webview windows at setup: {:?}", webview_windows.keys().collect::<Vec<_>>());
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
                let handle = app.handle().clone();
                let config_dir = paths.config_dir.clone();
                let window_for_events = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        if lifecycle::exit_requested() {
                            return;
                        }
                        api.prevent_close();
                        let _ = window_for_events.hide();
                        let handle = handle.clone();
                        if let Some(state) = handle.try_state::<AppState>() {
                            let data_dir = state.data_dir.clone();
                            let db_path = state.db_path.clone();
                            let db = state.db.clone();
                            let config_dir = config_dir.clone();
                            let _ = tauri::async_runtime::block_on(async move {
                                match crate::database::create_portable_backup(
                                    &db,
                                    &data_dir,
                                    &config_dir,
                                    &db_path,
                                )
                                .await
                                {
                                    Ok(path) => log::info!(
                                        "automatic backup on exit saved to {}",
                                        path.display()
                                    ),
                                    Err(error) => {
                                        log::warn!("automatic backup on exit skipped: {error}")
                                    }
                                }
                            });
                        }
                    }
                });
            }
            crate::services::scanner::start(app.handle().clone(), scanner_handle);
            log::info!("Tauri app setup completed successfully");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::kiosk::get_health,
            commands::kiosk::get_config,
            commands::attendance::get_attendance,
            commands::kiosk::scan_rfid,
            commands::kiosk::scanner_status,
            commands::kiosk::scanner_pause,
            commands::kiosk::notify_scan_success,
            commands::users::upload_photo,
            commands::users::admin_users,
            commands::users::admin_list_users,
            commands::users::admin_upsert_user,
            commands::users::admin_create_user,
            commands::users::admin_delete_user,
            commands::attendance::admin_attendance,
            commands::attendance::admin_list_attendance,
            commands::attendance::admin_update_attendance,
            commands::attendance::admin_create_backdated_attendance,
            commands::attendance::admin_delete_attendance,
            commands::payroll::payroll_list_profiles,
            commands::payroll::payroll_upsert_profile,
            commands::payroll::payroll_delete_profile,
            commands::payroll::payroll_list_cutoffs,
            commands::payroll::payroll_intern_report,
            commands::payroll::payroll_generate_cutoff,
            commands::payroll::payroll_create_cutoff,
            commands::payroll::payroll_update_cutoff,
            commands::payroll::payroll_finalize_cutoff,
            commands::payroll::payroll_delete_cutoff,
            commands::exports::export_attendance_xlsx,
            commands::exports::generate_payroll_pdf,
            commands::exports::list_payroll_pdfs,
            commands::exports::payroll_intern_payslips,
            commands::exports::save_intern_payslip_images,
            commands::exports::open_generated_file,
            commands::exports::reveal_generated_file,
            commands::exports::open_generated_directory,
            commands::backup::db_info,
            commands::backup::db_backup,
            commands::backup::db_restore_request,
            commands::backup::db_dismiss_restore_failure,
            commands::backup::db_open_backups_dir,
            commands::backup::db_save_backup_copy,
            commands::session::setup_unlock,
            commands::session::setup_lock,
            commands::session::admin_account_unlock,
            commands::session::admin_account_reset,
            commands::users::setup_lookup_card,
            commands::users::setup_upsert_user,
            commands::session::admin_get_session,
            commands::sync::admin_get_sync_status,
            commands::sync::admin_sheets_nuke_resync,
            commands::sync::admin_sync_intern_dtr,
            commands::sync::dtr_recon_get_latest_report,
            commands::sync::dtr_recon_run_manual,
            commands::sync::admin_get_intern_dtr_sync,
            commands::sync::admin_set_intern_dtr_sync,
            commands::lan::lan_status,
            commands::lan::lan_start,
            commands::lan::lan_stop,
            commands::lan::open_viewer_url,
            commands::voice::tts_speak,
            commands::voice::tts_stop,
            commands::voice::tts_status,
            commands::voice::get_voicestudio_host,
            commands::voice::set_voicestudio_host,
            commands::voice::get_voicestudio_pin,
            commands::voice::set_voicestudio_pin,
            commands::voice::check_voicestudio,
            commands::id_register::id_register_status,
            commands::id_register::id_register_sign_in,
            commands::id_register::id_register_sign_out,
            commands::id_register::id_register_check,
            commands::voice::voice_clip_states,
            commands::voice::voice_regenerate,
            commands::voice::voice_worker_status,
            commands::voice::voice_name_audio_url,
            commands::kiosk::autostart_status,
            commands::kiosk::autostart_set,
            commands::bathroom::bathroom_get_status,
            commands::bathroom::bathroom_time_out,
            commands::bathroom::bathroom_time_in,
            commands::bathroom::bathroom_update_log,
            commands::bathroom::bathroom_scan_rfid
        ])
        .run(tauri::generate_context!())
        .expect("error while running Alpha Premier Attendance");
}
