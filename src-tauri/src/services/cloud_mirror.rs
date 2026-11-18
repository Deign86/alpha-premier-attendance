//! The kiosk's copy of its own records in the shared backend.
//!
//! The SQLite database on this computer stays the source of truth. This
//! sends a copy of each business record to Keystone's Firebase project
//! (`keystone/apg/att_<table>/<id>`), so the other Alpha Premier programs can
//! read attendance and payroll from one place, and a lost kiosk is not lost
//! records.
//!
//! - One way only. Nothing is ever read back into the database from here.
//! - It runs after the ID register pass, with the same kiosk sign-in. A
//!   failure is a line in Admin → System and a retry; it never blocks a tap.
//! - A row is sent when its content differs from what was last sent, and
//!   removed there when it is gone here. What was last sent is remembered by
//!   hash in `cloud-backup.json` beside the database; deleting that file sends
//!   everything again, which is harmless.
//! - Left out on purpose: settings (they hold the admin PIN hash and
//!   sign-in tokens), the Sheets queue, export jobs, and every TIN and bank
//!   account number. Photos are files on this computer and are never sent.

use crate::services::id_register::{ask, Answer, Endpoints};
use crate::services::voice_pull::{read_setting, store_setting};
use crate::state::AppState;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// The records that are copied: table, its key column, and columns left out.
const TABLES: &[(&str, &str, &[&str])] = &[
    ("users", "user_id", &["tin", "account_number"]),
    ("attendance", "attendance_id", &[]),
    ("intern_grace", "grace_id", &[]),
    ("payroll", "payroll_id", &[]),
    ("payroll_profiles", "profile_id", &[]),
    ("payroll_cutoffs", "payroll_id", &["tin", "account_number"]),
    ("payroll_snapshots", "snapshot_id", &[]),
    ("bathroom_log", "log_id", &[]),
    ("audit_logs", "log_id", &[]),
];

const AT_KEY: &str = "cloud_backup_at";
const PROBLEM_KEY: &str = "cloud_backup_problem";
/// Keystone's rules look the kiosk up once for each write, and Firestore
/// allows a batch 20 such lookups. A larger batch could be refused whole.
const WRITES_A_REQUEST: usize = 20;
/// A pass sends at most this many requests, so a first backup takes a few
/// passes instead of holding one for minutes.
const REQUESTS_A_PASS: usize = 60;

const NOT_ALLOWED: &str = "This kiosk's account may not write the backup. Ask the owner to publish Keystone's rules for the kiosk backup.";
const UNREACHABLE: &str = "Could not reach the shared backend. The backup will try again.";

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStatus {
    /// Records on this computer that the backup covers.
    pub records: i64,
    /// How many of them the shared backend has as they are now.
    pub backed_up: i64,
    pub last_complete_at: Option<String>,
    pub problem: Option<String>,
}

/// What was last sent: table → key → hash of the row as sent.
type Sent = BTreeMap<String, BTreeMap<String, String>>;

struct Change {
    table: &'static str,
    key: String,
    /// The row's hash and fields; none when the row is gone and its copy is to be removed.
    row: Option<(String, serde_json::Value)>,
}

fn sent_file(state: &AppState) -> std::path::PathBuf {
    state.data_dir.join("cloud-backup.json")
}

fn load_sent(state: &AppState) -> Sent {
    std::fs::read_to_string(sent_file(state))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_sent(state: &AppState, sent: &Sent) -> Result<(), String> {
    let path = sent_file(state);
    let partial = path.with_extension("json.partial");
    let text = serde_json::to_string(sent).map_err(|e| e.to_string())?;
    std::fs::write(&partial, text).map_err(|e| format!("the backup's progress could not be kept: {e}"))?;
    std::fs::rename(&partial, &path).map_err(|e| format!("the backup's progress could not be kept: {e}"))
}

/// A Firestore document name cannot hold a slash and has a few reserved
/// shapes, so anything outside plain letters, digits and `-_.:@` is written
/// as `~` and its hex. The same key always gives the same name, and two
/// keys never share one (`~` itself is written out).
fn document_id(key: &str) -> String {
    let mut id = String::with_capacity(key.len() + 2);
    for byte in key.bytes() {
        // A leading dot or underscore is written out too: `.`, `..` and `__x__` are reserved names.
        let plain = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b':' | b'@') || (matches!(byte, b'.' | b'_') && !id.is_empty());
        if plain {
            id.push(char::from(byte));
        } else {
            id.push_str(&format!("~{byte:02X}"));
        }
    }
    if id.is_empty() { "~".into() } else { id }
}

fn firestore_value(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Null => serde_json::json!({"nullValue": null}),
        serde_json::Value::Bool(flag) => serde_json::json!({"booleanValue": flag}),
        // Firestore writes whole numbers as strings.
        serde_json::Value::Number(n) if n.is_i64() || n.is_u64() => serde_json::json!({"integerValue": n.to_string()}),
        serde_json::Value::Number(n) => serde_json::json!({"doubleValue": n}),
        serde_json::Value::String(text) => serde_json::json!({"stringValue": text}),
        // SQLite's json_object gives none of these for a column; kept as text rather than dropped.
        other => serde_json::json!({"stringValue": other.to_string()}),
    }
}

/// Every covered row as it is now, against what was last sent.
async fn changes(state: &AppState, sent: &Sent) -> Result<(Vec<Change>, i64, i64), String> {
    let mut pending = Vec::new();
    let (mut records, mut same) = (0i64, 0i64);
    for &(table, key_column, left_out) in TABLES {
        let columns: Vec<String> = sqlx::query_scalar(&format!("SELECT name FROM pragma_table_info('{table}')"))
            .fetch_all(&state.db)
            .await
            .map_err(|e| e.to_string())?;
        let pairs: Vec<String> = columns
            .iter()
            .filter(|column| !left_out.contains(&column.as_str()))
            .map(|column| format!("'{column}', \"{column}\""))
            .collect();
        // SQLite builds the row as JSON, so each value keeps its own type.
        let rows: Vec<(String, String)> = sqlx::query_as(&format!(
            "SELECT CAST(\"{key_column}\" AS TEXT), json_object({}) FROM \"{table}\"",
            pairs.join(", ")
        ))
        .fetch_all(&state.db)
        .await
        .map_err(|e| e.to_string())?;
        let before = sent.get(table);
        let mut here = std::collections::BTreeSet::new();
        for (key, json) in rows {
            records += 1;
            let hash = format!("{:x}", Sha256::digest(json.as_bytes()));
            if before.and_then(|rows| rows.get(&key)) == Some(&hash) {
                same += 1;
            } else {
                let fields: serde_json::Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
                pending.push(Change { table, key: key.clone(), row: Some((hash, fields)) });
            }
            here.insert(key);
        }
        for gone in before.into_iter().flat_map(|rows| rows.keys()).filter(|key| !here.contains(*key)) {
            pending.push(Change { table, key: gone.clone(), row: None });
        }
    }
    Ok((pending, records, same))
}

fn write_for(change: &Change, names: &str) -> serde_json::Value {
    let name = format!("{names}/att_{}/{}", change.table, document_id(&change.key));
    match &change.row {
        None => serde_json::json!({"delete": name}),
        Some((_, fields)) => {
            let fields: serde_json::Map<String, serde_json::Value> = fields
                .as_object()
                .into_iter()
                .flatten()
                .map(|(column, value)| (column.clone(), firestore_value(value)))
                .collect();
            serde_json::json!({"update": {"name": name, "fields": fields}})
        }
    }
}

async fn problem(state: &AppState, text: &str) -> String {
    let now = chrono::Utc::now().to_rfc3339();
    let _ = store_setting(&state.db, PROBLEM_KEY, text, &now).await;
    text.to_string()
}

/// One pass of the backup. Gives how many records are still to send.
pub(crate) async fn push(
    state: &AppState,
    client: &reqwest::Client,
    endpoints: &Endpoints,
    id_token: &str,
) -> Result<usize, String> {
    let mut sent = load_sent(state);
    let (pending, _, _) = changes(state, &sent).await?;
    let mut left = pending.len();
    for batch in pending.chunks(WRITES_A_REQUEST).take(REQUESTS_A_PASS) {
        let writes: Vec<serde_json::Value> = batch.iter().map(|change| write_for(change, &endpoints.names)).collect();
        let answer = ask(client.post(&endpoints.commit).bearer_auth(id_token).json(&serde_json::json!({"writes": writes}))).await;
        match answer {
            Answer::Ok(_) => {}
            Answer::Refused(401 | 403, _) => return Err(problem(state, NOT_ALLOWED).await),
            Answer::Refused(code, message) => {
                let first = batch.first().map(|change| format!("{} {}", change.table, change.key)).unwrap_or_default();
                return Err(problem(state, &format!("The shared backend refused part of the backup ({code} {message}), starting at {first}.")).await);
            }
            Answer::Unreachable => return Err(problem(state, UNREACHABLE).await),
        }
        for change in batch {
            let rows = sent.entry(change.table.to_string()).or_default();
            match &change.row {
                Some((hash, _)) => rows.insert(change.key.clone(), hash.clone()),
                None => rows.remove(&change.key),
            };
        }
        save_sent(state, &sent)?;
        left -= batch.len();
    }
    let now = chrono::Utc::now().to_rfc3339();
    if left == 0 {
        store_setting(&state.db, AT_KEY, &now, &now).await?;
    }
    let _ = sqlx::query("DELETE FROM app_settings WHERE key = ?").bind(PROBLEM_KEY).execute(&state.db).await;
    Ok(left)
}

pub async fn status(state: &AppState) -> BackupStatus {
    let (records, backed_up) = match changes(state, &load_sent(state)).await {
        Ok((_, records, same)) => (records, same),
        Err(_) => (0, 0),
    };
    BackupStatus {
        records,
        backed_up,
        last_complete_at: read_setting(&state.db, AT_KEY).await,
        problem: read_setting(&state.db, PROBLEM_KEY).await.filter(|p| !p.is_empty()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::id_register::tests::{close, kiosk, nowhere, register, serve, PASSWORD};
    use crate::services::id_register::{run_once, sign_in};

    async fn add_user(state: &AppState, user_id: &str, card: &str, name: &str) {
        crate::upsert_user_record(
            &state.db, user_id, card, name, Some("IT"), "ACTIVE", "INTERN", None, Some(50000), None, None, "EMPLOYEE", "2026-08-01T00:00:00Z",
        )
        .await
        .unwrap();
    }

    fn named(write: &serde_json::Value) -> String {
        let name = write["update"]["name"].as_str().or(write["delete"].as_str()).unwrap();
        name.strip_prefix("projects/p/databases/(default)/documents/keystone/apg/").unwrap().to_string()
    }

    #[tokio::test]
    async fn cloud_backup_sends_each_record_once_then_only_what_changed() {
        let (state, temp) = kiosk("backup").await;
        add_user(&state, "APG-2026-101", "ABCD1234", "Juan Dela Cruz").await;
        sqlx::query("UPDATE users SET tin = '123-456-789' WHERE user_id = 'APG-2026-101'").execute(&state.db).await.unwrap();
        let tap = crate::scan_rfid_impl(None, &state, serde_json::json!({"rfidUid": "ABCD1234", "source": "RFID"})).await.unwrap();
        assert_eq!(tap["success"], true, "{tap}");
        let fake = register(vec![]);
        let (endpoints, server) = serve(fake.clone()).await;
        sign_in(&state, Some(&endpoints), "kiosk@example.test", PASSWORD).await.unwrap();

        let before = status(&state).await;
        assert!(before.records >= 2 && before.backed_up == 0, "{before:?}");
        run_once(&state, Some(&endpoints)).await.unwrap();

        let written: Vec<serde_json::Value> = fake.lock().unwrap().written.concat();
        assert_eq!(written.len() as i64, before.records, "one write for each covered record");
        let user = written.iter().find(|write| named(write) == "att_users/APG-2026-101").expect("the user is sent");
        let fields = &user["update"]["fields"];
        assert_eq!(fields["full_name"], serde_json::json!({"stringValue": "Juan Dela Cruz"}));
        assert_eq!(fields["daily_rate_centavos"], serde_json::json!({"integerValue": "50000"}), "a number stays a number");
        assert_eq!(fields["gender"], serde_json::json!({"nullValue": null}), "an empty value stays empty");
        assert!(fields.get("tin").is_none() && fields.get("account_number").is_none(), "a TIN or an account number never leaves the computer");
        assert!(written.iter().any(|write| named(write).starts_with("att_attendance/")), "the tap is sent");
        assert!(written.iter().any(|write| named(write).starts_with("att_audit_logs/")));
        let everything = serde_json::to_string(&written).unwrap();
        for kept_here in ["admin_pin_hash", "refresh-1", "id_register_refresh_token", "123-456-789", "app_settings", "sync_queue"] {
            assert!(!everything.contains(kept_here), "{kept_here} is not part of the backup");
        }
        let after = status(&state).await;
        assert_eq!((after.backed_up, after.problem.clone()), (after.records, None));
        assert!(after.last_complete_at.is_some());

        // Nothing changed: nothing is sent.
        fake.lock().unwrap().written.clear();
        run_once(&state, Some(&endpoints)).await.unwrap();
        assert!(fake.lock().unwrap().written.is_empty());

        // One record changes: that record is sent again, with the audit line the change wrote.
        crate::admin_upsert_user_inner(
            &state,
            serde_json::json!({"userId": "APG-2026-101", "rfidUid": "ABCD1234", "fullName": "Juan Santos Dela Cruz", "status": "ACTIVE", "employeeType": "INTERN"}),
        )
        .await
        .unwrap();
        run_once(&state, Some(&endpoints)).await.unwrap();
        let mut changed: Vec<String> = fake.lock().unwrap().written.concat().iter().map(named).collect();
        changed.sort();
        assert_eq!(changed.iter().filter(|name| name.starts_with("att_users/")).count(), 1);
        assert!(changed.iter().all(|name| name == "att_users/APG-2026-101" || name.starts_with("att_audit_logs/")), "{changed:?}");

        // A record removed here is removed there.
        fake.lock().unwrap().written.clear();
        crate::delete_user_and_cascade(&state, "APG-2026-101").await.unwrap();
        run_once(&state, Some(&endpoints)).await.unwrap();
        let removed = fake.lock().unwrap().written.concat();
        assert!(removed.iter().any(|write| write["delete"].as_str().is_some_and(|name| name.ends_with("/att_users/APG-2026-101"))), "{removed:?}");
        let last = status(&state).await;
        assert_eq!(last.backed_up, last.records);
        close(state, temp, server).await;
    }

    #[tokio::test]
    async fn cloud_backup_problems_keep_nothing_marked_sent() {
        let (state, temp) = kiosk("backup-refused").await;
        add_user(&state, "APG-2026-101", "ABCD1234", "Juan Dela Cruz").await;
        let fake = register(vec![]);
        let (endpoints, server) = serve(fake.clone()).await;
        sign_in(&state, Some(&endpoints), "kiosk@example.test", PASSWORD).await.unwrap();

        // The rules do not let this account write: said so, and nothing counts as sent.
        fake.lock().unwrap().refuse_backup = Some(403);
        run_once(&state, Some(&endpoints)).await.unwrap();
        let refused = status(&state).await;
        assert_eq!(refused.problem.as_deref(), Some(NOT_ALLOWED));
        assert_eq!(refused.backed_up, 0);
        assert_eq!(refused.last_complete_at, None);

        // A bad request names where it stopped.
        fake.lock().unwrap().refuse_backup = Some(400);
        run_once(&state, Some(&endpoints)).await.unwrap();
        let bad = status(&state).await.problem.unwrap();
        assert!(bad.contains("400") && bad.contains("users APG-2026-101"), "{bad}");

        // Unreachable: the same, and the register's own pass is what reports it.
        assert!(run_once(&state, Some(&nowhere().await)).await.is_err());
        assert_eq!(status(&state).await.backed_up, 0);

        // Allowed again: everything goes, and the problem is gone.
        fake.lock().unwrap().refuse_backup = None;
        run_once(&state, Some(&endpoints)).await.unwrap();
        let done = status(&state).await;
        assert_eq!((done.backed_up, done.problem), (done.records, None));
        close(state, temp, server).await;
    }

    #[tokio::test]
    async fn cloud_backup_sends_a_large_history_in_bounded_requests_without_repeats() {
        let (state, temp) = kiosk("backup-large").await;
        let rows = WRITES_A_REQUEST * REQUESTS_A_PASS + 950;
        let mut tx = state.db.begin().await.unwrap();
        for n in 0..rows {
            sqlx::query("INSERT INTO audit_logs (log_id, timestamp, event_type, message, request_id) VALUES (?, '2026-11-01T00:00:00Z', 'TEST', 'history', ?)")
                .bind(format!("log/{n}"))
                .bind(format!("request-{n}"))
                .execute(&mut *tx)
                .await
                .unwrap();
        }
        tx.commit().await.unwrap();
        let fake = register(vec![]);
        let (endpoints, server) = serve(fake.clone()).await;
        sign_in(&state, Some(&endpoints), "kiosk@example.test", PASSWORD).await.unwrap();

        run_once(&state, Some(&endpoints)).await.unwrap();
        let first = status(&state).await;
        assert_eq!(first.backed_up as usize, WRITES_A_REQUEST * REQUESTS_A_PASS, "a pass stops at its limit");
        assert_eq!(first.last_complete_at, None, "and does not call a part the whole");
        run_once(&state, Some(&endpoints)).await.unwrap();
        run_once(&state, Some(&endpoints)).await.unwrap();

        let done = status(&state).await;
        assert_eq!(done.backed_up, done.records);
        assert!(done.last_complete_at.is_some());
        let fake = fake.lock().unwrap();
        assert!(fake.written.iter().all(|request| request.len() <= WRITES_A_REQUEST));
        let mut names: Vec<String> = fake.written.concat().iter().map(named).collect();
        let sent = names.len();
        names.sort();
        names.dedup();
        assert_eq!(sent, names.len(), "no record is sent twice");
        assert_eq!(names.len() as i64, done.records);
        assert!(names.contains(&"att_audit_logs/log~2F0".to_string()), "a key with a slash is still one document");
        drop(fake);
        close(state, temp, server).await;
    }

    /// Holds for the schema as it is and as it grows: a migration that adds a column with one of these names to a
    /// covered table fails here until the column is left out of the backup.
    #[tokio::test]
    async fn cloud_backup_never_covers_an_identity_number_or_a_secret() {
        let (state, temp) = kiosk("backup-columns").await;
        for &(table, key_column, left_out) in TABLES {
            let columns: Vec<String> = sqlx::query_scalar(&format!("SELECT name FROM pragma_table_info('{table}')")).fetch_all(&state.db).await.unwrap();
            assert!(columns.iter().any(|column| column == key_column), "{table} has no {key_column}");
            for column in &columns {
                let name = column.to_ascii_lowercase();
                let private = ["tin", "sss_number", "account_number", "password", "pin", "token", "secret", "hash"]
                    .iter()
                    .any(|word| name == *word || name.ends_with(&format!("_{word}")) && name != "snapshot_sha256");
                assert!(!private || left_out.contains(&column.as_str()), "{table}.{column} would be sent");
            }
            for column in left_out {
                assert!(columns.iter().any(|c| c == column), "{table}.{column} is left out but does not exist");
            }
        }
        for kept_here in ["app_settings", "sync_queue", "sync_state", "export_jobs", "voice_jobs"] {
            assert!(TABLES.iter().all(|(table, _, _)| *table != kept_here));
        }
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn cloud_backup_document_names_are_safe_and_distinct() {
        assert_eq!(document_id("APG-2026-101"), "APG-2026-101");
        assert_eq!(document_id("a/b c"), "a~2Fb~20c");
        assert_eq!(document_id("."), "~2E");
        assert_eq!(document_id(".."), "~2E.");
        assert_eq!(document_id("__name__"), "~5F_name__");
        assert_eq!(document_id(""), "~");
        assert_eq!(document_id("~"), "~7E");
        assert_ne!(document_id("a~2Fb"), document_id("a/b"));
        assert_eq!(firestore_value(&serde_json::json!(1.5)), serde_json::json!({"doubleValue": 1.5}));
        assert_eq!(firestore_value(&serde_json::json!(-7)), serde_json::json!({"integerValue": "-7"}));
    }
}
