//! The audit log has one writer. Every row in `audit_logs` written by the app goes through [`log`].

/// One audit row. `rfid_uid` and `user_id` are filled only by the events that have them.
pub struct Entry<'a> {
    event_type: &'a str,
    timestamp: &'a str,
    rfid_uid: Option<&'a str>,
    user_id: Option<&'a str>,
    message: &'a str,
    request_id: &'a str,
}

impl<'a> Entry<'a> {
    pub fn new(event_type: &'a str, timestamp: &'a str, message: &'a str, request_id: &'a str) -> Self {
        Self { event_type, timestamp, rfid_uid: None, user_id: None, message, request_id }
    }

    pub fn card(self, rfid_uid: Option<&'a str>) -> Self {
        Self { rfid_uid, ..self }
    }

    pub fn user(self, user_id: Option<&'a str>) -> Self {
        Self { user_id, ..self }
    }
}

/// The request id of an action an administrator took at the kiosk.
pub fn admin_request_id() -> String {
    format!("admin-{}", uuid::Uuid::new_v4())
}

/// Writes the row. One that cannot be written is dropped: no action has ever failed because its audit row did.
pub async fn log(db: &sqlx::SqlitePool, entry: Entry<'_>) {
    let _ = sqlx::query("INSERT INTO audit_logs (log_id, timestamp, event_type, rfid_uid, user_id, message, request_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(entry.timestamp)
        .bind(entry.event_type)
        .bind(entry.rfid_uid)
        .bind(entry.user_id)
        .bind(entry.message)
        .bind(entry.request_id)
        .execute(db)
        .await;
}
