//! The attendance records in the shared backend.
//!
//! Keystone's Firebase project holds the records
//! (`keystone/apg/att_<table>/<id>`); the SQLite database on this computer
//! is the kiosk's working copy of them. There is one kiosk and it is the only
//! writer, so nothing is ever merged.
//!
//! - Every change is written here first, so a tap never waits on the
//!   internet, and sent after the next ID register pass with the same kiosk
//!   sign-in. A failure is a line in Admin → System and a retry.
//! - A row is sent when its content differs from what was last sent, and
//!   removed there when it is gone here. What was last sent is remembered by
//!   hash in `cloud-backup.json` beside the database; deleting that file sends
//!   everything again, which is harmless.
//! - A kiosk with no people and no such file (a new or reinstalled computer)
//!   fills its database from Firebase before it sends anything.
//! - Firebase is called the main record only once every collection there has
//!   been counted equal to this database; a copy of the database as it was
//!   then is kept beside it.
//! - TINs and bank account numbers go apart, under `attprivate_<table>/<id>`.
//! - Left here on purpose: settings (they hold remembered password hashes
//!   and sign-in tokens), the Sheets queue and export jobs. Photos are files on
//!   this computer and are never sent.

use crate::services::firebase::{self, ask, Answer, CountRefusal, Endpoints};
use crate::services::settings::{self, key};
use crate::state::AppState;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// The records that are sent: table, its key column, and the columns that go apart under `attprivate_<table>`.
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

/// The database as it was when Firebase became the main record.
const KEPT_FILE: &str = "attendance-before-firebase.db";
pub(crate) const DOCUMENTS_A_PAGE: usize = 300;
/// Keystone's rules look the kiosk up once for each write, and Firestore
/// allows a batch 20 such lookups. A larger batch could be refused whole.
const WRITES_A_REQUEST: usize = 20;
/// A pass sends at most this many requests, so a first backup takes a few
/// passes instead of holding one for minutes.
const REQUESTS_A_PASS: usize = 60;

const NOT_ALLOWED: &str = "This kiosk's account may not write the backup. Ask the owner to publish Keystone's rules for the kiosk backup.";
const UNREACHABLE: &str = "Could not reach the shared backend. The backup will try again.";
pub(crate) const NOT_READABLE: &str = "This kiosk's account may not read its records back yet. Ask the owner to publish Keystone's rules for the attendance records.";

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStatus {
    /// Records on this computer that the backup covers.
    pub records: i64,
    /// How many of them the shared backend has as they are now.
    pub backed_up: i64,
    pub last_complete_at: Option<String>,
    /// Since when Firebase has been counted equal to this database and is the main record.
    pub main_record_since: Option<String>,
    pub problem: Option<String>,
}

/// What was last sent: table → key → hash of the row as sent.
type Sent = BTreeMap<String, BTreeMap<String, String>>;

struct Change {
    /// `users`, or `private_users` for the columns kept apart; see `collection`. `Sent` is keyed by it.
    set: String,
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
        let mut sets = vec![(table.to_string(), rows)];
        if !left_out.is_empty() {
            let pairs: Vec<String> = left_out.iter().map(|column| format!("'{column}', \"{column}\"")).collect();
            let filled: Vec<String> = left_out.iter().map(|column| format!("COALESCE(\"{column}\", '') <> ''")).collect();
            let rows: Vec<(String, String)> = sqlx::query_as(&format!(
                "SELECT CAST(\"{key_column}\" AS TEXT), json_object('{key_column}', \"{key_column}\", {}) FROM \"{table}\" WHERE {}",
                pairs.join(", "),
                filled.join(" OR ")
            ))
            .fetch_all(&state.db)
            .await
            .map_err(|e| e.to_string())?;
            sets.push((format!("private_{table}"), rows));
        }
        for (set, rows) in sets {
            let before = sent.get(&set);
            let mut here = std::collections::BTreeSet::new();
            for (key, json) in rows {
                records += 1;
                let hash = format!("{:x}", Sha256::digest(json.as_bytes()));
                if before.and_then(|rows| rows.get(&key)) == Some(&hash) {
                    same += 1;
                } else {
                    let fields: serde_json::Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
                    pending.push(Change { set: set.clone(), key: key.clone(), row: Some((hash, fields)) });
                }
                here.insert(key);
            }
            for gone in before.into_iter().flat_map(|rows| rows.keys()).filter(|key| !here.contains(*key)) {
                pending.push(Change { set: set.clone(), key: gone.clone(), row: None });
            }
        }
    }
    Ok((pending, records, same))
}

/// `users` is kept under `att_users`, `private_users` under `attprivate_users`.
fn collection(set: &str) -> String {
    if set.starts_with("private_") { format!("att{set}") } else { format!("att_{set}") }
}

fn write_for(change: &Change, names: &str) -> serde_json::Value {
    let name = format!("{names}/{}/{}", collection(&change.set), document_id(&change.key));
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
    let _ = settings::put(&state.db, key::CLOUD_BACKUP_PROBLEM, text, &now).await;
    text.to_string()
}

/// One pass of the backup. Gives how many records are still to send.
pub(crate) async fn push(
    state: &AppState,
    client: &reqwest::Client,
    endpoints: &Endpoints,
    id_token: &str,
) -> Result<usize, String> {
    rebuild_if_new(state, client, endpoints, id_token).await?;
    let mut sent = load_sent(state);
    let (pending, _, _) = changes(state, &sent).await?;
    let mut left = pending.len();
    // What is kept apart goes last and in requests of its own: until Keystone's rules for it are published it is
    // refused, and that must not hold up a tap's own record.
    let (apart, open): (Vec<Change>, Vec<Change>) = pending.into_iter().partition(|change| change.set.starts_with("private_"));
    for batch in open.chunks(WRITES_A_REQUEST).chain(apart.chunks(WRITES_A_REQUEST)).take(REQUESTS_A_PASS) {
        let writes: Vec<serde_json::Value> = batch.iter().map(|change| write_for(change, &endpoints.names)).collect();
        let answer = ask(client.post(&endpoints.commit).bearer_auth(id_token).json(&serde_json::json!({"writes": writes}))).await;
        match answer {
            Answer::Ok(_) => {}
            Answer::Refused(401 | 403, _) => return Err(problem(state, NOT_ALLOWED).await),
            Answer::Refused(code, message) => {
                let first = batch.first().map(|change| format!("{} {}", change.set, change.key)).unwrap_or_default();
                return Err(problem(state, &format!("The shared backend refused part of the backup ({code} {message}), starting at {first}.")).await);
            }
            Answer::Unreachable => return Err(problem(state, UNREACHABLE).await),
        }
        for change in batch {
            let rows = sent.entry(change.set.clone()).or_default();
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
        settings::put(&state.db, key::CLOUD_BACKUP_AT, &now, &now).await?;
    }
    let _ = settings::delete(&state.db, key::CLOUD_BACKUP_PROBLEM).await;
    if left == 0 && settings::get(&state.db, key::CLOUD_MAIN_RECORD_SINCE).await.is_none() {
        make_main_record(state, client, endpoints, id_token, sent).await?;
    }
    Ok(left)
}

fn every_set() -> Vec<String> {
    TABLES
        .iter()
        .flat_map(|(table, _, apart)| std::iter::once(table.to_string()).chain((!apart.is_empty()).then(|| format!("private_{table}"))))
        .collect()
}

async fn count_there(client: &reqwest::Client, endpoints: &Endpoints, id_token: &str, set: &str) -> Result<usize, CountRefusal> {
    let counted = firebase::count(client, endpoints, id_token, serde_json::json!({"from": [{"collectionId": collection(set)}]})).await?;
    usize::try_from(counted).map_err(|_| CountRefusal::Unreadable)
}

/// Called once everything has been sent: Firebase becomes the main record only when each collection there holds
/// as many records as this database. A short collection is sent again; nothing is marked until all are equal.
async fn make_main_record(state: &AppState, client: &reqwest::Client, endpoints: &Endpoints, id_token: &str, mut sent: Sent) -> Result<(), String> {
    for set in every_set() {
        let here = sent.get(&set).map_or(0, BTreeMap::len);
        let there = match count_there(client, endpoints, id_token, &set).await {
            Ok(there) => there,
            Err(CountRefusal::Unreachable) => return Err(problem(state, UNREACHABLE).await),
            Err(_) => return Err(problem(state, NOT_READABLE).await),
        };
        if there < here {
            sent.remove(&set);
            save_sent(state, &sent)?;
            return Err(problem(state, &format!("Firebase holds {there} of this kiosk's {here} {} records. They are being sent again.", collection(&set))).await);
        }
        if there > here {
            return Err(problem(state, &format!("Firebase holds {there} {} records and this kiosk {here}. Nothing was changed; tell IT.", collection(&set))).await);
        }
    }
    let kept = state.data_dir.join(KEPT_FILE);
    if !kept.exists() {
        crate::database::snapshot_database_from_pool(&state.db, &kept).await?;
    }
    let now = chrono::Utc::now().to_rfc3339();
    settings::put(&state.db, key::CLOUD_MAIN_RECORD_SINCE, &now, &now).await
}

async fn documents(client: &reqwest::Client, endpoints: &Endpoints, id_token: &str, set: &str) -> Result<Vec<serde_json::Value>, Answer> {
    let mut found = Vec::new();
    let mut page = String::new();
    loop {
        let mut request = client
            .get(format!("{}/{}", endpoints.register, collection(set)))
            .bearer_auth(id_token)
            .query(&[("pageSize", DOCUMENTS_A_PAGE.to_string())]);
        if !page.is_empty() {
            request = request.query(&[("pageToken", page.as_str())]);
        }
        let body = match ask(request).await {
            Answer::Ok(body) => body,
            other => return Err(other),
        };
        found.extend(body.get("documents").and_then(|d| d.as_array()).into_iter().flatten().filter_map(|d| d.get("fields").cloned()));
        match body.get("nextPageToken").and_then(|t| t.as_str()).filter(|t| !t.is_empty()) {
            Some(next) => page = next.to_string(),
            None => return Ok(found),
        }
    }
}

fn bind<'q>(query: sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>, value: &serde_json::Value) -> sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
    let text = |name: &str| value.get(name).and_then(|v| v.as_str()).map(str::to_string);
    if let Some(whole) = value.get("integerValue") {
        // Firestore writes whole numbers as strings.
        return query.bind(whole.as_str().and_then(|s| s.parse::<i64>().ok()).or_else(|| whole.as_i64()));
    }
    if let Some(number) = value.get("doubleValue") {
        return query.bind(number.as_f64());
    }
    if let Some(flag) = value.get("booleanValue") {
        return query.bind(flag.as_bool().map(i64::from));
    }
    query.bind(text("stringValue"))
}

/// A kiosk with no people and no record of ever having sent anything is a new or reinstalled computer: its database
/// is filled from Firebase, whole or not at all. A kiosk that has people is never touched.
async fn rebuild_if_new(state: &AppState, client: &reqwest::Client, endpoints: &Endpoints, id_token: &str) -> Result<(), String> {
    if sent_file(state).exists() {
        return Ok(());
    }
    let people: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users").fetch_one(&state.db).await.map_err(|e| e.to_string())?;
    if people > 0 {
        return Ok(());
    }
    let mut fetched = Vec::new();
    for set in every_set() {
        match documents(client, endpoints, id_token, &set).await {
            Ok(found) => fetched.push((set, found)),
            Err(Answer::Unreachable) => return Err(problem(state, UNREACHABLE).await),
            Err(_) => return Err(problem(state, NOT_READABLE).await),
        }
    }
    if fetched.iter().all(|(_, found)| found.is_empty()) {
        return Ok(());
    }
    let failed = |e: sqlx::Error| format!("this kiosk's database could not be filled from Firebase: {e}");
    let mut tx = state.db.begin().await.map_err(failed)?;
    // Rows arrive table by table; what they point to is checked once, at the end.
    sqlx::query("PRAGMA defer_foreign_keys = ON").execute(&mut *tx).await.map_err(failed)?;
    for (set, found) in &fetched {
        let table = set.strip_prefix("private_").unwrap_or(set);
        let key_column = TABLES.iter().find(|(name, _, _)| *name == table).map_or("", |(_, key, _)| *key);
        let columns: Vec<String> = sqlx::query_scalar(&format!("SELECT name FROM pragma_table_info('{table}')")).fetch_all(&mut *tx).await.map_err(failed)?;
        for fields in found {
            let given: Vec<&String> = columns.iter().filter(|column| fields.get(column.as_str()).is_some()).collect();
            let sql = if set.starts_with("private_") {
                let set_to: Vec<String> = given.iter().map(|column| format!("\"{column}\" = ?")).collect();
                format!("UPDATE \"{table}\" SET {} WHERE \"{key_column}\" = ?", set_to.join(", "))
            } else {
                let names: Vec<String> = given.iter().map(|column| format!("\"{column}\"")).collect();
                format!("INSERT OR REPLACE INTO \"{table}\" ({}) VALUES ({})", names.join(", "), vec!["?"; given.len()].join(", "))
            };
            let mut query = sqlx::query(&sql);
            for column in &given {
                query = bind(query, &fields[column.as_str()]);
            }
            if set.starts_with("private_") {
                query = bind(query, &fields[key_column]);
            }
            query.execute(&mut *tx).await.map_err(failed)?;
        }
    }
    tx.commit().await.map_err(failed)?;
    // What is here now is what Firebase has: nothing is to be sent back.
    let (arrived, _, _) = changes(state, &Sent::new()).await?;
    let mut sent = Sent::new();
    for change in arrived {
        if let Some((hash, _)) = change.row {
            sent.entry(change.set).or_default().insert(change.key, hash);
        }
    }
    save_sent(state, &sent)
}

pub async fn status(state: &AppState) -> BackupStatus {
    let (records, backed_up) = match changes(state, &load_sent(state)).await {
        Ok((_, records, same)) => (records, same),
        Err(_) => (0, 0),
    };
    BackupStatus {
        records,
        backed_up,
        last_complete_at: settings::get(&state.db, key::CLOUD_BACKUP_AT).await,
        main_record_since: settings::get(&state.db, key::CLOUD_MAIN_RECORD_SINCE).await,
        problem: settings::get(&state.db, key::CLOUD_BACKUP_PROBLEM).await.filter(|p| !p.is_empty()),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::services::firebase::fake::{close, kiosk, nowhere, register, serve, PASSWORD};
    use crate::services::id_register::{run_once, sign_in};
    use crate::services::users;

    pub(crate) async fn add_user(state: &AppState, user_id: &str, card: &str, name: &str) {
        users::upsert_user_record(
            &state.db, user_id, card, name, Some("IT"), "ACTIVE", "INTERN", None, Some(50000), None, None, "EMPLOYEE", "2026-08-01T00:00:00Z",
        )
        .await
        .unwrap();
    }

    pub(crate) fn named(write: &serde_json::Value) -> String {
        let name = write["update"]["name"].as_str().or(write["delete"].as_str()).unwrap();
        name.strip_prefix("projects/p/databases/(default)/documents/keystone/apg/").unwrap().to_string()
    }

    pub(crate) async fn everything(state: &AppState) -> Vec<(String, String)> {
        let mut rows = Vec::new();
        for &(table, key_column, _) in TABLES {
            let columns: Vec<String> = sqlx::query_scalar(&format!("SELECT name FROM pragma_table_info('{table}')")).fetch_all(&state.db).await.unwrap();
            let pairs: Vec<String> = columns.iter().map(|column| format!("'{column}', \"{column}\"")).collect();
            let found: Vec<(String, String)> = sqlx::query_as(&format!("SELECT '{table}/' || \"{key_column}\", json_object({}) FROM \"{table}\" ORDER BY 1", pairs.join(", ")))
                .fetch_all(&state.db)
                .await
                .unwrap();
            rows.extend(found);
        }
        rows
    }

    #[tokio::test]
    async fn cloud_backup_what_is_kept_apart_never_holds_up_the_rest() {
        let (state, temp) = kiosk("apart-refused").await;
        add_user(&state, "APG-2026-101", "ABCD1234", "Juan Dela Cruz").await;
        let fake = register(vec![]);
        let (endpoints, server) = serve(fake.clone()).await;
        sign_in(&state, Some(&endpoints), "kiosk@example.test", PASSWORD).await.unwrap();
        // Keystone's rules as they are before ADR 0028: att_… is written, attprivate_… is not.
        fake.lock().unwrap().refuse_apart = true;
        run_once(&state, Some(&endpoints)).await.unwrap();
        let held = fake.lock().unwrap().stored.keys().cloned().collect::<Vec<_>>();
        assert!(held.contains(&"att_users/APG-2026-101".to_string()), "{held:?}");
        assert!(held.iter().all(|name| name.starts_with("att_")), "{held:?}");
        let now = status(&state).await;
        assert_eq!(now.problem.as_deref(), Some(NOT_ALLOWED));
        assert_eq!(now.records - now.backed_up, 1, "only what is kept apart waits");
        close(state, temp, server).await;
    }

    #[tokio::test]
    async fn cloud_backup_cutover_is_marked_only_when_firebase_counts_equal() {
        let (state, temp) = kiosk("cutover").await;
        add_user(&state, "APG-2026-101", "ABCD1234", "Juan Dela Cruz").await;
        add_user(&state, "APG-2026-102", "ABCD1235", "Ana Reyes").await;
        let fake = register(vec![]);
        let (endpoints, server) = serve(fake.clone()).await;
        sign_in(&state, Some(&endpoints), "kiosk@example.test", PASSWORD).await.unwrap();

        // The rules do not let the kiosk count yet: everything is sent, nothing is marked.
        fake.lock().unwrap().refuse_reading_back = Some(403);
        run_once(&state, Some(&endpoints)).await.unwrap();
        let waiting = status(&state).await;
        assert_eq!((waiting.backed_up, waiting.main_record_since.clone(), waiting.problem.as_deref()), (waiting.records, None, Some(NOT_READABLE)));

        // (Reading back and writing what is kept apart are published together; refused, the rest still went.)
        // Firebase lost a record the kiosk believes it sent: not marked, and that collection goes again.
        fake.lock().unwrap().refuse_reading_back = None;
        fake.lock().unwrap().stored.remove("att_users/APG-2026-102");
        run_once(&state, Some(&endpoints)).await.unwrap();
        let short = status(&state).await;
        assert_eq!(short.main_record_since, None);
        assert!(short.problem.as_deref().is_some_and(|p| p.contains("1 of this kiosk's 2 att_users")), "{short:?}");
        assert!(!state.data_dir.join(KEPT_FILE).exists());

        run_once(&state, Some(&endpoints)).await.unwrap();
        let done = status(&state).await;
        assert!(done.main_record_since.is_some() && done.problem.is_none(), "{done:?}");
        assert!(fake.lock().unwrap().stored.contains_key("att_users/APG-2026-102"));
        // The database as it was at that moment is kept beside it, and opens.
        crate::database::validate_database_file(&state.data_dir.join(KEPT_FILE)).await.unwrap();

        // Once marked, it is not counted again.
        fake.lock().unwrap().asked.clear();
        run_once(&state, Some(&endpoints)).await.unwrap();
        assert!(!fake.lock().unwrap().asked.contains(&"own"));
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

    /// Round trip: any value SQLite can hold in a row goes to Firestore's form, through JSON text as it does over
    /// the wire, and back into SQLite as the same row text of the same type, so a rebuilt kiosk has nothing to send
    /// back. Whole numbers, text and empty values are exact; a real number is exact to 15 significant digits, which
    /// is how SQLite itself writes it out. 5,000 generated values.
    #[tokio::test]
    async fn property_cloud_backup_values_come_back_as_they_went() {
        let (state, temp) = kiosk("property-values").await;
        let mut seed: u64 = 0x5EED_F1BE;
        let mut next = move || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            seed >> 11
        };
        let pieces = ["", "a", "Ñ", "'", "\"", "\\", "/", " ", "\n", "0", "1.0", "007", "null", "true", "é", "日", "😀", "-", "~", "{", "APG-2026-101"];
        for round in 0..5_000 {
            let value = match next() % 6 {
                0 => serde_json::Value::Null,
                1 => serde_json::json!([i64::MIN, -1, 0, 1, 50000, i64::MAX][(next() % 6) as usize]),
                2 => serde_json::json!((next() as i64).wrapping_sub(1 << 52)),
                3 => serde_json::json!([8.0, 0.5, -0.1, 1e300, 1e-300, 7.999999999999999][(next() % 6) as usize]),
                4 => serde_json::json!((next() % 2_000_000) as f64 / 1000.0 - 1000.0),
                _ => serde_json::json!((0..next() % 6).map(|_| pieces[(next() % pieces.len() as u64) as usize]).collect::<String>()),
            };
            let as_held = |v: &serde_json::Value| match v {
                serde_json::Value::Null => serde_json::json!({"nullValue": null}),
                other => firestore_value(other),
            };
            // As `changes` reads it: SQLite writes the row as JSON (a real number to 15 significant digits), and that is what is sent.
            let direct = match &value {
                serde_json::Value::Null => sqlx::query("SELECT json_object('v', ?)").bind(None::<String>),
                serde_json::Value::Number(n) if n.is_i64() => sqlx::query("SELECT json_object('v', ?)").bind(n.as_i64()),
                serde_json::Value::Number(n) => sqlx::query("SELECT json_object('v', ?)").bind(n.as_f64()),
                other => sqlx::query("SELECT json_object('v', ?)").bind(other.as_str().map(str::to_string)),
            };
            let first = |row: sqlx::sqlite::SqliteRow| sqlx::Row::try_get::<String, _>(&row, 0);
            let here: String = direct.try_map(first).fetch_one(&state.db).await.unwrap();
            let read: serde_json::Value = serde_json::from_str(&here).unwrap();
            let over_the_wire: serde_json::Value = serde_json::from_str(&as_held(&read["v"]).to_string()).unwrap();
            let back: String = bind(sqlx::query("SELECT json_object('v', ?)"), &over_the_wire).try_map(first).fetch_one(&state.db).await.unwrap();
            assert_eq!(back, here, "round {round}: {value} went as {over_the_wire}");
            let (sent, kept): (serde_json::Value, serde_json::Value) = (serde_json::from_str(&back).unwrap(), serde_json::from_str(&here).unwrap());
            assert_eq!(sent["v"].is_f64(), kept["v"].is_f64(), "round {round}: {value} changed type");
            if !value.is_f64() {
                assert_eq!(sent["v"], value, "round {round}: only a real number may differ, past its 15th digit");
            }
        }
        // Firestore may answer a whole-valued double without its decimal point; it still comes back a real number.
        let whole: String = bind(sqlx::query("SELECT typeof(?)"), &serde_json::json!({"doubleValue": 8})).try_map(|row: sqlx::sqlite::SqliteRow| sqlx::Row::try_get(&row, 0)).fetch_one(&state.db).await.unwrap();
        assert_eq!(whole, "real");
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    /// No two keys share a document, and no document name can leave its collection. 20,000 generated keys.
    #[test]
    fn property_cloud_backup_document_names_never_collide_or_escape() {
        let mut seed: u64 = 0xD0C_1D;
        let mut next = move || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            seed >> 11
        };
        let pieces = ["a", "B", "7", "/", ".", "_", "~", "2F", " ", "-", ":", "@", "Ñ", "%", "__", ".."];
        let mut seen = std::collections::BTreeMap::new();
        for _ in 0..20_000 {
            let key: String = (0..next() % 5).map(|_| pieces[(next() % pieces.len() as u64) as usize]).collect();
            let id = document_id(&key);
            assert!(!id.is_empty() && !id.contains('/') && id != "." && id != ".." && !id.starts_with("__"), "{key:?} -> {id:?}");
            if let Some(other) = seen.insert(id.clone(), key.clone()) {
                assert_eq!(other, key, "{other:?} and {key:?} share {id:?}");
            }
        }
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
