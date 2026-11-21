//! The Sheets sync queue as the rest of the app writes to it: a queue row commits with the change it mirrors.

use crate::state::AppState;

/// Idempotency key of a queued sync row. InternGrace DELETE rows key on the
/// person (the sheet's key column), so the grace id keeps two of them
/// apart: with one shared key the second delete overwrote the first (O3).
pub(crate) fn sync_idempotency_key(
    table_name: &str,
    row_id: &str,
    operation: &str,
    payload: &serde_json::Value,
) -> String {
    match payload.get("graceId").and_then(|v| v.as_str()) {
        Some(grace_id) if table_name == "InternGrace" && operation == "DELETE" => {
            format!("{table_name}:{row_id}:{operation}:{grace_id}")
        }
        _ => format!("{table_name}:{row_id}:{operation}"),
    }
}

/// Queue a Sheets sync row on the caller's connection: inside its
/// transaction the row commits with the change it mirrors (O4). A failed
/// queue write still never fails the caller.
pub(crate) async fn enqueue_sync_on(
    state: &AppState,
    conn: &mut sqlx::SqliteConnection,
    table_name: &str,
    row_id: &str,
    operation: &str,
    payload: &serde_json::Value,
) {
    let now = chrono::Utc::now().to_rfc3339();
    let idempotency_key = sync_idempotency_key(table_name, row_id, operation, payload);
    let persisted = crate::services::sheets_sync::requeue_sync_row_on(
        conn,
        table_name,
        row_id,
        operation,
        &payload.to_string(),
        &now,
        &idempotency_key,
    )
    .await;
    if !persisted && table_name == crate::services::dtr_sync::DTR_TABLE_NAME {
        state.mark_dtr_persistence_failure().await;
    }
}

/// Sync rows (table, row id, operation, payload) produced inside a transaction;
/// flush them with `flush_pending_sync` on that same transaction before it
/// commits, so they commit together (O4).
pub(crate) type PendingSync = (&'static str, String, &'static str, serde_json::Value);

pub(crate) async fn flush_pending_sync(
    state: &AppState,
    conn: &mut sqlx::SqliteConnection,
    pending: Vec<PendingSync>,
) {
    for (table, row_id, operation, payload) in pending {
        enqueue_sync_on(state, &mut *conn, table, &row_id, operation, &payload).await;
    }
}
