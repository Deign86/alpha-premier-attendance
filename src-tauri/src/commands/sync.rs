use crate::state::AppState;
use super::session::Admin;
use tauri::State;

#[derive(serde::Serialize)]
pub(crate) struct SyncHealthTableRow {
    #[serde(rename = "tableName")]
    table_name: String,
    pending: i64,
}

#[derive(serde::Serialize)]
pub(crate) struct SyncHealthPendingPerson {
    #[serde(rename = "userId")]
    user_id: String,
    #[serde(rename = "fullName")]
    full_name: String,
    attempts: i64,
    #[serde(rename = "lastChecked")]
    last_checked: Option<String>,
    #[serde(rename = "reasonCode")]
    reason_code: String,
}

#[derive(serde::Serialize)]
pub(crate) struct SyncHealthDtrPending {
    count: i64,
    items: Vec<SyncHealthPendingPerson>,
}

#[derive(serde::Serialize)]
pub(crate) struct SyncHealthInProgress {
    owner: String,
    #[serde(rename = "startedAt")]
    started_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DtrCurrentIssue {
    None,
    Transport,
    AuthConfig,
    Quota,
    UnresolvedLayout,
    Persistence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DtrSyncActivity {
    Idle,
    Queued,
    Syncing,
    Throttled,
    Retrying,
    Disabled,
    Offline,
    Unavailable,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DtrSyncHealth {
    enabled: bool,
    queued: i64,
    retrying: i64,
    processing: i64,
    dead: i64,
    retryable_pending: i64,
    needs_attention: i64,
    next_retry_eligible_at: Option<String>,
    oldest_outstanding_age_sec: Option<i64>,
    current_issue: DtrCurrentIssue,
    current_issue_since: Option<String>,
    persistence_failure: bool,
    emitted_at: String,
    last_successful_write_at: Option<String>,
    activity: DtrSyncActivity,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DtrSyncHealthEvent {
    activity: DtrSyncActivity,
    queued: i64,
    retryable_pending: i64,
    needs_attention: i64,
    dead: i64,
    persistence_failure: bool,
    emitted_at: String,
}

pub(crate) fn dtr_sync_health_event(health: &DtrSyncHealth) -> DtrSyncHealthEvent {
    DtrSyncHealthEvent {
        activity: health.activity,
        queued: health.queued,
        retryable_pending: health.retryable_pending,
        needs_attention: health.needs_attention + health.dead,
        dead: health.dead,
        persistence_failure: health.current_issue == DtrCurrentIssue::Persistence,
        emitted_at: chrono::Utc::now().to_rfc3339(),
    }
}

pub(crate) async fn emit_dtr_sync_health(app: &tauri::AppHandle, state: &AppState) {
    use tauri::Emitter;
    let health = dtr_sync_health_summary(state).await;
    let _ = app.emit("dtr-sync-health", dtr_sync_health_event(&health));
}

pub(crate) fn dtr_queue_issue(
    status: &str,
    error: &str,
    error_code: &str,
) -> Option<DtrCurrentIssue> {
    if error_code == crate::services::sync_retry::GOOGLE_RATE_LIMITED
        || error_code == crate::services::sync_retry::GOOGLE_DAILY_LIMIT
        || error.contains("GOOGLE_RATE_LIMITED")
        || error.contains("dailyLimitExceeded")
    {
        return Some(DtrCurrentIssue::Quota);
    }
    if status == "DEAD"
        && (error_code == crate::services::sheets_sync::GOOGLE_AUTH_FAILED
            || error_code == crate::services::sync_retry::GOOGLE_PERMISSION_DENIED
            || error.to_ascii_lowercase().contains("service account")
            || error.to_ascii_lowercase().contains("credential"))
    {
        return Some(DtrCurrentIssue::AuthConfig);
    }
    if error_code == crate::services::sync_retry::GOOGLE_TRANSPORT_FAILED
        || error_code == crate::services::sync_retry::GOOGLE_SERVER_ERROR
        || error.contains("timeout-after-connect")
        || error.to_ascii_lowercase().contains("connection")
        || error.to_ascii_lowercase().contains("transport")
    {
        return Some(DtrCurrentIssue::Transport);
    }
    None
}

pub(crate) fn dtr_pending_issue(reason_code: &str) -> Option<DtrCurrentIssue> {
    match reason_code {
        "transport" | "backfill_failed" => Some(DtrCurrentIssue::Transport),
        "missing_tab" => Some(DtrCurrentIssue::UnresolvedLayout),
        code if code.starts_with("unresolvable:") => Some(DtrCurrentIssue::UnresolvedLayout),
        _ => None,
    }
}

pub(crate) fn dtr_sync_activity(
    enabled: bool,
    offline: bool,
    throttled: bool,
    syncing: bool,
    retrying: i64,
    queued: i64,
) -> DtrSyncActivity {
    if !enabled {
        DtrSyncActivity::Disabled
    } else if offline {
        DtrSyncActivity::Offline
    } else if throttled {
        DtrSyncActivity::Throttled
    } else if syncing {
        DtrSyncActivity::Syncing
    } else if retrying > 0 {
        DtrSyncActivity::Retrying
    } else if queued > 0 {
        DtrSyncActivity::Queued
    } else {
        DtrSyncActivity::Idle
    }
}

pub(crate) async fn dtr_sync_health_query(state: &AppState) -> Result<DtrSyncHealth, sqlx::Error> {
    let status_rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT status, COUNT(*) FROM sync_queue WHERE table_name='InternDtr' GROUP BY status",
    )
    .fetch_all(&state.db)
    .await?;
    let mut queued = 0;
    let mut retrying = 0;
    let mut processing = 0;
    let mut dead = 0;
    for (status, count) in status_rows {
        match status.as_str() {
            "PENDING" => queued = count,
            "RETRY" => retrying = count,
            "PROCESSING" => processing = count,
            "DEAD" => dead = count,
            _ => {}
        }
    }
    let needs_attention: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM dtr_pending WHERE reason_code GLOB 'unresolvable:?*'",
    )
    .fetch_one(&state.db)
    .await?;
    let retryable_pending: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM dtr_pending WHERE reason_code NOT GLOB 'unresolvable:?*'",
    )
    .fetch_one(&state.db)
    .await?;
    let next_retry_eligible_at: Option<String> = sqlx::query_scalar(
        "SELECT MIN(next_attempt_at) FROM sync_queue WHERE table_name='InternDtr' AND status='RETRY'",
    )
    .fetch_one(&state.db)
    .await?;
    let oldest_outstanding_at: Option<String> = sqlx::query_scalar(
        "SELECT MIN(created_at) FROM sync_queue WHERE table_name='InternDtr' AND status IN ('PENDING','RETRY')",
    )
    .fetch_one(&state.db)
    .await?;
    let oldest_outstanding_age_sec = oldest_outstanding_at
        .as_deref()
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|instant| {
            chrono::Utc::now()
                .signed_duration_since(instant.with_timezone(&chrono::Utc))
                .num_seconds()
                .max(0)
        });
    let pending_rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT reason_code, first_seen, last_checked FROM dtr_pending ORDER BY last_checked DESC",
    )
    .fetch_all(&state.db)
    .await?;
    let issue_rows: Vec<(String, Option<String>, Option<String>, String)> = sqlx::query_as(
        "SELECT status, last_error, last_error_code, updated_at FROM sync_queue WHERE table_name='InternDtr' AND status IN ('RETRY','DEAD') AND last_error IS NOT NULL ORDER BY updated_at DESC",
    )
    .fetch_all(&state.db)
    .await?;
    let queue_issue = issue_rows.into_iter().find_map(
        |(status, error, error_code, updated_at)| {
            let issue = dtr_queue_issue(
                &status,
                error.as_deref().unwrap_or_default(),
                error_code.as_deref().unwrap_or_default(),
            )?;
            Some((issue, updated_at))
        },
    );
    let mut current_issue = DtrCurrentIssue::None;
    let mut current_issue_since = None;
    let pending_signal = pending_rows
        .iter()
        .find(|(reason, _, _)| matches!(reason.as_str(), "transport" | "backfill_failed"))
        .map(|(reason, first_seen, last_checked)| {
            (
                dtr_pending_issue(reason).unwrap_or(DtrCurrentIssue::Transport),
                last_checked.clone().unwrap_or_else(|| first_seen.clone()),
            )
        })
        .or_else(|| {
            pending_rows.iter().find_map(|(reason, first_seen, _)| {
                dtr_pending_issue(reason).map(|issue| (issue, first_seen.clone()))
            })
        });
    if let Some((pending_issue, pending_since)) = pending_signal {
        let signal_is_newer = queue_issue.as_ref().is_some_and(|(_, signal_since)| {
            chrono::DateTime::parse_from_rfc3339(signal_since).ok()
                > chrono::DateTime::parse_from_rfc3339(&pending_since).ok()
        });
        if signal_is_newer {
            if let Some((issue, since)) = queue_issue {
                current_issue = issue;
                current_issue_since = Some(since);
            }
        } else {
            current_issue = pending_issue;
            current_issue_since = Some(pending_since);
        }
    } else if let Some((issue, since)) = queue_issue {
        current_issue = issue;
        current_issue_since = Some(since);
    }
    if state.dtr_offline.load(std::sync::atomic::Ordering::Relaxed) {
        current_issue = if state
            .dtr_auth_config_failed
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            DtrCurrentIssue::AuthConfig
        } else {
            DtrCurrentIssue::Transport
        };
        current_issue_since = state.dtr_token_failure_since.lock().await.clone();
    }
    if let Some(persistence_since) = state
        .dtr_persistence_failure_since
        .lock()
        .await
        .clone()
    {
        current_issue = DtrCurrentIssue::Persistence;
        current_issue_since = Some(persistence_since);
    }
    let last_successful_write_at = state.dtr_last_successful_write_at.lock().await.clone();
    let enabled = crate::services::dtr_sync::is_dtr_sync_enabled(&state.db).await
        && crate::config::dtr_spreadsheet_id_resolved(&state.lan).is_some();
    let now_ms = crate::services::sync_retry::wall_now_ms();
    let throttled = state
        .dtr_throttle_denied_until_ms
        .load(std::sync::atomic::Ordering::Relaxed)
        > now_ms;
    let syncing = processing > 0 || crate::state::sync_guard_status(&state.db).await.is_some();
    let activity = dtr_sync_activity(
        enabled,
        state.dtr_offline.load(std::sync::atomic::Ordering::Relaxed),
        throttled,
        syncing,
        retrying,
        queued,
    );
    Ok(DtrSyncHealth {
        enabled,
        queued,
        retrying,
        processing,
        dead,
        retryable_pending,
        needs_attention,
        next_retry_eligible_at,
        oldest_outstanding_age_sec,
        current_issue,
        current_issue_since,
        persistence_failure: current_issue == DtrCurrentIssue::Persistence,
        emitted_at: chrono::Utc::now().to_rfc3339(),
        last_successful_write_at,
        activity,
    })
}

pub(crate) async fn dtr_sync_health_summary(state: &AppState) -> DtrSyncHealth {
    dtr_sync_health_query(state).await.unwrap_or(DtrSyncHealth {
        enabled: false,
        queued: 0,
        retrying: 0,
        processing: 0,
        dead: 0,
        retryable_pending: 0,
        needs_attention: 0,
        next_retry_eligible_at: None,
        oldest_outstanding_age_sec: None,
        current_issue: DtrCurrentIssue::None,
        current_issue_since: None,
        persistence_failure: false,
        emitted_at: chrono::Utc::now().to_rfc3339(),
        last_successful_write_at: None,
        activity: DtrSyncActivity::Unavailable,
    })
}

/// Plan todo 10: admin-only sync-health contract. New fields are explicit
/// serde types (no untyped JSON): throttle state, guard owner, lease
/// recoveries, and retryable-queue age. Idle reads are all nulls/zero/false.
#[derive(serde::Serialize)]
pub(crate) struct SyncHealthResponse {
    success: bool,
    pending: i64,
    #[serde(rename = "deadLetter")]
    dead_letter: i64,
    #[serde(rename = "byTable")]
    by_table: Vec<SyncHealthTableRow>,
    #[serde(rename = "dtrPending")]
    dtr_pending: SyncHealthDtrPending,
    dtr: DtrSyncHealth,
    #[serde(rename = "lastSyncedAt")]
    last_synced_at: Option<String>,
    #[serde(rename = "lastError")]
    last_error: Option<String>,
    #[serde(rename = "throttledUntil")]
    throttled_until: Option<String>,
    #[serde(rename = "lastThrottleReason")]
    last_throttle_reason: Option<String>,
    #[serde(rename = "inProgress")]
    in_progress: Option<SyncHealthInProgress>,
    #[serde(rename = "leaseRecovered")]
    lease_recovered: u64,
    #[serde(rename = "oldestRetryableAgeSec")]
    oldest_retryable_age_sec: Option<i64>,
    #[serde(rename = "pendingAgeAlert")]
    pending_age_alert: bool,
}

pub(crate) async fn admin_pending_summary(state: &AppState) -> Result<SyncHealthDtrPending, sqlx::Error> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM dtr_pending")
        .fetch_one(&state.db)
        .await?;
    let rows: Vec<(String, String, i64, Option<String>, String)> = sqlx::query_as(
        "SELECT user_id, full_name, attempts, last_checked, reason_code FROM dtr_pending ORDER BY full_name ASC LIMIT 50",
    )
    .fetch_all(&state.db)
    .await?;
    let items = rows
        .into_iter()
        .map(|(user_id, full_name, attempts, last_checked, reason_code)| {
            SyncHealthPendingPerson { user_id, full_name, attempts, last_checked, reason_code }
        })
        .collect();
    Ok(SyncHealthDtrPending { count, items })
}

#[tauri::command]
pub(crate) async fn admin_get_sync_status(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    token: String,
) -> Result<SyncHealthResponse, String> {
    Admin::check(&state, &token).await?;
    let pending: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sync_queue WHERE status IN ('PENDING','RETRY','PROCESSING')",
    )
    .fetch_one(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    let dead: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_queue WHERE status='DEAD'")
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);
    // Per-table pending breakdown for the Admin Data-and-backup sync-health card.
    // All follow-up queries degrade to empty/None so a missing table (older
    // database) never breaks the status read; no schema migration here.
    let by_table_rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT table_name, COUNT(*) FROM sync_queue WHERE status IN ('PENDING','RETRY','PROCESSING') GROUP BY table_name ORDER BY table_name ASC",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    let by_table: Vec<SyncHealthTableRow> = by_table_rows
        .into_iter()
        .map(|(table_name, pending)| SyncHealthTableRow {
            table_name,
            pending,
        })
        .collect();
    let dtr_pending = admin_pending_summary(&state)
        .await
        .unwrap_or(SyncHealthDtrPending { count: 0, items: Vec::new() });
    let last_synced_at: Option<String> = sqlx::query_scalar("SELECT MAX(last_synced_at) FROM sync_state")
        .fetch_one(&state.db)
        .await
        .unwrap_or(None);
    let last_error: Option<String> = sqlx::query_scalar(
        "SELECT last_error FROM sync_queue WHERE last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
    )
    .fetch_one(&state.db)
    .await
    .unwrap_or(None);
    // Plan todo 10: current DTR throttle window. Some(window-end RFC3339) +
    // reason only while a further write would be denied; idle reads are nulls.
    let now_throttle_ms = crate::services::sync_retry::wall_now_ms();
    let throttled_until: Option<String> = state
        .dtr_throttle
        .lock()
        .await
        .throttled_until_ms(now_throttle_ms)
        .and_then(|window_end_ms| {
            chrono::DateTime::<chrono::Utc>::from_timestamp_millis(
                i64::try_from(window_end_ms).unwrap_or(i64::MAX),
            )
        })
        .map(|instant| instant.to_rfc3339());
    let last_throttle_reason: Option<String> = throttled_until.as_ref().map(|_| {
        crate::services::sync_retry::DTR_THROTTLE_REASON.to_string()
    });
    // Plan todo 10: live guard holder from the todo-8 persisted sync_state
    // row; None on idle, completed, stale, or corrupt rows.
    let in_progress: Option<SyncHealthInProgress> =
        crate::state::sync_guard_status(&state.db)
            .await
            .map(|(owner, started_at)| SyncHealthInProgress { owner, started_at });
    let lease_recovered: u64 = state
        .lease_recovered
        .load(std::sync::atomic::Ordering::Relaxed);
    // Plan todo 10: age of the oldest PENDING/RETRY row bounds
    // infinite-RETRY growth visibility; alert past 6h.
    let oldest_retryable_at: Option<String> = sqlx::query_scalar(
        "SELECT MIN(created_at) FROM sync_queue WHERE status IN ('PENDING','RETRY')",
    )
    .fetch_one(&state.db)
    .await
    .unwrap_or(None);
    let oldest_retryable_age_sec: Option<i64> = oldest_retryable_at
        .as_deref()
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|instant| {
            chrono::Utc::now()
                .signed_duration_since(instant.with_timezone(&chrono::Utc))
                .num_seconds()
                .max(0)
        });
    let pending_age_alert: bool = oldest_retryable_age_sec
        .is_some_and(|age| age > crate::services::sync_retry::PENDING_AGE_ALERT_SECS);
    let dtr = dtr_sync_health_summary(&state).await;
    use tauri::Emitter;
    let _ = app.emit("dtr-sync-health", dtr_sync_health_event(&dtr));
    Ok(SyncHealthResponse {
        success: true,
        pending,
        dead_letter: dead,
        by_table,
        dtr,
        dtr_pending,
        last_synced_at,
        last_error,
        throttled_until,
        last_throttle_reason,
        in_progress,
        lease_recovered,
        oldest_retryable_age_sec,
        pending_age_alert,
    })
}

#[tauri::command]
pub(crate) async fn dtr_recon_get_latest_report(
    state: State<'_, AppState>,
) -> Result<Option<serde_json::Value>, String> {
    crate::services::dtr_recon::get_latest_report(&state).await
}

#[tauri::command]
pub(crate) async fn dtr_recon_run_manual(
    state: State<'_, AppState>,
    token: String,
    report_only: Option<bool>,
) -> Result<serde_json::Value, String> {
    Admin::check(&state, &token).await?;
    let is_report_only = report_only.unwrap_or(true);
    let run_id = crate::services::dtr_recon::run_reconciliation(&state, is_report_only).await?;
    let report = crate::services::dtr_recon::get_latest_report(&state).await?;
    Ok(serde_json::json!({
        "success": true,
        "runId": run_id,
        "report": report
    }))
}

#[tauri::command]
pub(crate) async fn admin_sync_intern_dtr(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    token: String,
    user_id: Option<String>,
    start_from_user_id: Option<String>,
) -> Result<serde_json::Value, String> {
    Admin::check(&state, &token).await?;
    // Plan todo 8: kill-switch still blocks manual entry before the guard
    // is touched, so a disabled device never holds the guard. Per-row sync
    // routes through this same command (user_id Some) — one owner per scope.
    if !crate::services::dtr_sync::is_dtr_sync_enabled(&state.db).await {
        return Err(
            "Intern DTR sync is disabled on this device (Admin → Data → DTR sync toggle)"
                .to_string(),
        );
    }
    let owner = match user_id.as_deref() {
        Some(id) => format!("admin_sync_intern_dtr:user:{id}"),
        None => "admin_sync_intern_dtr:bulk".to_string(),
    };
    if let Err(busy) = crate::state::sync_guard_try_acquire(
        &state.db,
        state.sync_in_progress.as_ref(),
        &owner,
    )
    .await
    {
        return Err(busy);
    }
    let report =
        crate::services::dtr_sync::manual_sync_intern_dtr(
            &state,
            Some(&app),
            user_id.as_deref(),
            start_from_user_id.as_deref(),
        )
        .await;
    crate::state::sync_guard_release(&state.db, state.sync_in_progress.as_ref()).await;
    emit_dtr_sync_health(&app, &state).await;
    let report = report?;
    serde_json::to_value(report).map_err(|e| e.to_string())
}

/// Per-device intern-DTR kill switch state (Admin → Data toggle).
/// Read is admin-gated like every other admin command so the toggle
/// state never leaks to unauthenticated viewers.
#[tauri::command]
pub(crate) async fn admin_get_intern_dtr_sync(
    state: State<'_, AppState>,
    token: String,
) -> Result<serde_json::Value, String> {
    Admin::check(&state, &token).await?;
    let enabled = crate::services::dtr_sync::is_dtr_sync_enabled(&state.db).await;
    Ok(serde_json::json!({ "success": true, "enabled": enabled }))
}

/// Persist the per-device toggle. Stored in LOCAL SQLite, so flipping
/// one PC never affects the other. Audited like other admin mutations.
#[tauri::command]
pub(crate) async fn admin_set_intern_dtr_sync(
    state: State<'_, AppState>,
    token: String,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    Admin::check(&state, &token).await?;
    crate::services::dtr_sync::set_dtr_sync_enabled(&state.db, enabled).await?;
    // Report the effective state: the env override wins over the stored row.
    let effective = crate::services::dtr_sync::is_dtr_sync_enabled(&state.db).await;
    crate::services::audit::log(
        &state.db,
        crate::services::audit::Entry::new("ADMIN", &chrono::Utc::now().to_rfc3339(), &format!("intern DTR sync {} on this device", if effective { "enabled" } else { "disabled" }), &uuid::Uuid::new_v4().to_string()),
    )
    .await;
    Ok(serde_json::json!({ "success": true, "enabled": effective }))
}

/// Dev/test utility (hidden admin action): wipes every managed Google Sheets
/// tab and re-enqueues the current SQLite state for a from-scratch re-export.
/// Gated behind the admin session and an explicit confirmation flag.
#[tauri::command]
pub(crate) async fn admin_sheets_nuke_resync(
    state: State<'_, AppState>,
    token: String,
    confirm: bool,
) -> Result<serde_json::Value, String> {
    admin_sheets_nuke_resync_impl(&state, &token, confirm).await
}

pub(crate) async fn admin_sheets_nuke_resync_impl(
    state: &AppState,
    token: &str,
    confirm: bool,
) -> Result<serde_json::Value, String> {
    Admin::check(state, token).await?;
    if !confirm {
        return Err("RESYNC_CONFIRMATION_REQUIRED".into());
    }
    // Same guard as every other sync: a push already in flight would land
    // after the wipe (its queued DELETE just dropped) and orphan a row.
    crate::state::sync_guard_try_acquire(
        &state.db,
        state.sync_in_progress.as_ref(),
        "admin_sheets_nuke_resync",
    )
    .await?;
    let result = crate::services::sheets_sync::nuke_and_resync(state).await;
    crate::state::sync_guard_release(&state.db, state.sync_in_progress.as_ref()).await;
    let result = result?;
    crate::services::audit::log(
        &state.db,
        crate::services::audit::Entry::new("SHEETS_RESYNC", &chrono::Utc::now().to_rfc3339(), "Google Sheets wiped and re-exported from SQLite by administrator", &crate::services::audit::admin_request_id()),
    )
    .await;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::*;
    use crate::services::sync_queue::enqueue_sync_on;
    

    #[tokio::test]
    async fn dtr_sync_health_counts_only_intern_dtr_and_reports_issue_and_activity() {
        let _env_guard = crate::config::dtr_env_test_guard();
        let temp = std::env::temp_dir().join(format!("alpha-dtr-health-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        let state = AppState::new(
            temp.clone(),
            temp.join("attendance.db"),
            temp.join("exports"),
            false,
            LanConfig::default(),
            OfficeConfig::default(),
            crate::config::ScannerConfig::default(),
            crate::config::TtsConfig::default(),
            crate::config::UpdaterConfig::default(),
        )
        .await
        .unwrap();
        let now = chrono::Utc::now();
        let now_text = now.to_rfc3339();
        let retry_at = (now + chrono::Duration::seconds(45)).to_rfc3339();
        for (table, id, status, created, updated, error, code) in [
            (
                "InternDtr",
                "dtr-pending",
                "PENDING",
                (now - chrono::Duration::seconds(40)).to_rfc3339(),
                now_text.clone(),
                None,
                None,
            ),
            (
                "InternDtr",
                "dtr-retry",
                "RETRY",
                (now - chrono::Duration::seconds(90)).to_rfc3339(),
                now_text.clone(),
                Some("GOOGLE_TRANSPORT_FAILED"),
                Some("GOOGLE_REQUEST_FAILED"),
            ),
            (
                "InternDtr",
                "dtr-processing",
                "PROCESSING",
                now_text.clone(),
                now_text.clone(),
                None,
                None,
            ),
            (
                "InternDtr",
                "dtr-dead",
                "DEAD",
                now_text.clone(),
                now_text.clone(),
                Some("400 invalid DTR payload"),
                Some("GOOGLE_SYNC_FAILED"),
            ),
            (
                "Users",
                "ops-pending",
                "PENDING",
                now_text.clone(),
                now_text.clone(),
                None,
                None,
            ),
        ] {
            sqlx::query("INSERT INTO sync_queue (table_name,row_id,operation,payload_json,attempts,last_error,last_error_code,status,next_attempt_at,created_at,updated_at,idempotency_key,locked_at) VALUES (?,?, 'UPSERT','{}',0,?,?,?,?,?,?,?,NULL)")
                .bind(table)
                .bind(id)
                .bind(error)
                .bind(code)
                .bind(status)
                .bind(&retry_at)
                .bind(created)
                .bind(updated)
                .bind(format!("{table}:{id}:UPSERT"))
                .execute(&state.db)
                .await
                .unwrap();
        }
        sqlx::query("UPDATE sync_queue SET updated_at=? WHERE row_id='dtr-retry'")
            .bind(&now_text)
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query("UPDATE sync_queue SET next_attempt_at=? WHERE row_id='dtr-retry'")
            .bind(&retry_at)
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sync_queue (table_name,row_id,operation,payload_json,attempts,status,next_attempt_at,created_at,updated_at,idempotency_key) VALUES ('InternDtr','dtr-synced','UPSERT','{}',0,'SYNCED',?,?,?,'InternDtr:dtr-synced:UPSERT')")
            .bind(&now_text)
            .bind(&now_text)
            .bind("2026-10-02T12:00:00Z")
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO dtr_pending (user_id,full_name,first_seen,last_checked,attempts,reason_code) VALUES ('pending-user','Pending User',?,?,1,'missing_tab')")
            .bind((now - chrono::Duration::seconds(120)).to_rfc3339())
            .bind(&now_text)
            .execute(&state.db)
            .await
            .unwrap();
        for (user_id, reason) in [
            ("pending-transport", "transport"),
            ("pending-backfill", "backfill_failed"),
            ("pending-layout", "unresolvable:no_month_block"),
        ] {
            sqlx::query("INSERT INTO dtr_pending (user_id,full_name,first_seen,last_checked,attempts,reason_code) VALUES (?, ?, ?, ?, 0, ?)")
                .bind(user_id)
                .bind(user_id)
                .bind(&now_text)
                .bind(&now_text)
                .bind(reason)
                .execute(&state.db)
                .await
                .unwrap();
        }
        assert_eq!(
            dtr_sync_health_summary(&state)
                .await
                .last_successful_write_at,
            None,
            "a SYNCED queue row can represent a skip and is not proof of a Sheets write"
        );
        *state.dtr_last_successful_write_at.lock().await =
            Some("2026-10-02T12:00:00Z".to_string());

        let health = dtr_sync_health_summary(&state).await;
        assert!(health.enabled);
        assert_eq!((health.queued, health.retrying, health.processing, health.dead), (1, 1, 1, 1));
        assert_eq!(health.needs_attention, 1);
        assert_eq!(health.retryable_pending, 3);
        assert_eq!(health.next_retry_eligible_at.as_deref(), Some(retry_at.as_str()));
        assert!(health.oldest_outstanding_age_sec.is_some_and(|age| (90..=120).contains(&age)));
        assert_eq!(health.current_issue, DtrCurrentIssue::Transport);
        assert_eq!(health.current_issue_since.as_deref(), Some(now_text.as_str()));
        assert_eq!(health.last_successful_write_at.as_deref(), Some("2026-10-02T12:00:00Z"));
        assert_eq!(health.activity, DtrSyncActivity::Syncing);
        let event = serde_json::to_value(dtr_sync_health_event(&health)).unwrap();
        assert_eq!(event["activity"], "syncing");
        assert_eq!(event["queued"], 1);
        assert_eq!(event["needsAttention"], 2);
        assert_eq!(event["dead"], 1);
        assert_eq!(event["persistenceFailure"], false);
        assert!(chrono::DateTime::parse_from_rfc3339(event["emittedAt"].as_str().unwrap()).is_ok());

        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[tokio::test]
    async fn admin_pending_items_include_reason_code() {
        let _env_guard = crate::config::dtr_env_test_guard();
        let temp = std::env::temp_dir().join(format!("alpha-dtr-pending-reason-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        let state = AppState::new(
            temp.clone(), temp.join("attendance.db"), temp.join("exports"), false,
            LanConfig::default(), OfficeConfig::default(), crate::config::ScannerConfig::default(),
            crate::config::TtsConfig::default(), crate::config::UpdaterConfig::default(),
        ).await.unwrap();
        sqlx::query("INSERT INTO dtr_pending (user_id,full_name,first_seen,last_checked,attempts,reason_code) VALUES ('u-reason','Reason User','2026-10-03T00:00:00Z',NULL,0,'backfill_failed')")
            .execute(&state.db).await.unwrap();
        let response = admin_pending_summary(&state).await.unwrap();
        assert_eq!(response.items[0].reason_code, "backfill_failed");
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn dtr_health_event_has_timestamp_and_dead_and_persistence_attention() {
        let health = DtrSyncHealth {
            enabled: true,
            queued: 0,
            retrying: 0,
            processing: 0,
            dead: 2,
            retryable_pending: 0,
            needs_attention: 1,
            next_retry_eligible_at: None,
            oldest_outstanding_age_sec: None,
            current_issue: DtrCurrentIssue::Persistence,
            current_issue_since: None,
            persistence_failure: true,
            emitted_at: "2026-10-03T00:00:00Z".to_string(),
            last_successful_write_at: None,
            activity: DtrSyncActivity::Idle,
        };
        let event = serde_json::to_value(dtr_sync_health_event(&health)).unwrap();
        assert_eq!(event["dead"], 2);
        assert_eq!(event["needsAttention"], 3);
        assert_eq!(event["persistenceFailure"], true);
        assert!(event["emittedAt"].as_str().is_some());
        // The admin payload carries the same attention signals (gate: admin
        // refresh must not erase a persistence warning).
        let admin = serde_json::to_value(&health).unwrap();
        assert_eq!(admin["persistenceFailure"], true);
        assert_eq!(admin["emittedAt"], "2026-10-03T00:00:00Z");
    }

    #[test]
    fn dtr_pending_reason_classification_preserves_transport_failures() {
        assert_eq!(
            dtr_pending_issue("transport"),
            Some(DtrCurrentIssue::Transport)
        );
        assert_eq!(
            dtr_pending_issue("backfill_failed"),
            Some(DtrCurrentIssue::Transport)
        );
        assert_eq!(
            dtr_pending_issue("missing_tab"),
            Some(DtrCurrentIssue::UnresolvedLayout)
        );
    }

    #[tokio::test]
    async fn nuke_and_resync_waits_for_a_running_sync() {
        let temp = std::env::temp_dir().join(format!("alpha-nuke-guard-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        let state = AppState::new(
            temp.clone(),
            temp.join("attendance.db"),
            temp.join("exports"),
            false,
            LanConfig::default(),
            OfficeConfig::default(),
            crate::config::ScannerConfig::default(),
            crate::config::TtsConfig::default(),
            crate::config::UpdaterConfig::default(),
        )
        .await
        .unwrap();
        let token = "test-admin-token".to_string();
        *state.admin_session.lock().await = Some(crate::state::AdminSession {
            token: token.clone(),
            expires_at: std::time::Instant::now() + std::time::Duration::from_secs(3600),
        });
        // A background pass is mid-push.
        crate::state::sync_guard_try_acquire(&state.db, state.sync_in_progress.as_ref(), "background_sync")
            .await
            .unwrap();
        let err = admin_sheets_nuke_resync_impl(&state, &token, true).await.unwrap_err();
        assert!(err.starts_with("DTR_SYNC_IN_PROGRESS"), "{err}");
        // The refused wipe left the running pass's guard alone.
        assert!(state.sync_in_progress.load(std::sync::atomic::Ordering::SeqCst));
        crate::state::sync_guard_release(&state.db, state.sync_in_progress.as_ref()).await;
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[tokio::test]
    async fn grace_deletes_for_one_person_do_not_collapse() {
        // O3: InternGrace DELETE rows key on the person, so two of them
        // shared an idempotency key and the second overwrote the first.
        let (state, temp, _token) = admin_test_state("grace-keys").await;
        let mut conn = state.db.acquire().await.unwrap();
        for grace_id in ["g-1", "g-2"] {
            enqueue_sync_on(&state, &mut conn, "InternGrace", "INT_G", "DELETE", &serde_json::json!({"userId": "INT_G", "graceId": grace_id})).await;
        }
        drop(conn);
        let deletes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_queue WHERE table_name='InternGrace' AND operation='DELETE'")
            .fetch_one(&state.db).await.unwrap();
        assert_eq!(deletes, 2, "each grace row is deleted on the sheet");
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn dtr_token_config_failures_are_not_generic_offline_failures() {
        assert_eq!(
            crate::services::dtr_sync::token_failure_is_auth_config(
                "service account credentials file not found"
            ),
            true
        );
        assert_eq!(
            crate::services::dtr_sync::token_failure_is_auth_config("connect timeout"),
            false
        );
    }
}
