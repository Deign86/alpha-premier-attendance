//! New interns from the ID register.
//!
//! The Alpha Premier ID Maker records every card it issues in a shared
//! register: Keystone's Firebase project, `keystone/apg/idreg/{number}`, with
//! `kind` saying whether the card is an intern's or an employee's. This kiosk
//! reads that register with its own register-only account and adds each new
//! intern as a user waiting for a card.
//!
//! - The password is used once to sign in and never kept. The refresh token
//!   and the account's email live in `app_settings`.
//! - The register only grows, so one count request says whether there is
//!   anything new; the list is read only when the count has changed.
//! - A person the kiosk already has is never changed, and a number seen once
//!   is never added again, so deleting a user here is final.
//! - A waiting user's `rfid_uid` is `PENDING-<user id>`. Scans are hex only,
//!   so no reader can produce it; saving the user with a real card in
//!   Admin → Users puts the card in its place.

use crate::services::voice_pull::{read_setting, store_setting};
use crate::state::AppState;
use sqlx::SqlitePool;
use std::collections::BTreeSet;

const TOKEN_KEY: &str = "id_register_refresh_token";
const EMAIL_KEY: &str = "id_register_email";
const COUNT_KEY: &str = "id_register_count";
const SEEN_KEY: &str = "id_register_seen";
const CHECKED_KEY: &str = "id_register_checked_at";
const PROBLEM_KEY: &str = "id_register_problem";

/// What a waiting user's `rfid_uid` starts with.
pub const WAITING_PREFIX: &str = "PENDING-";

const NOT_BUILT_IN: &str = "The ID register is not built into this copy of the app.";
const UNREACHABLE: &str = "Could not reach the ID register. The kiosk will try again.";
const UNREADABLE: &str = "The ID register gave an answer the kiosk could not read. The kiosk will try again.";
const NOT_ALLOWED: &str = "This account may not read the ID register. Ask the owner to add it as a kiosk device.";

/// Where the register is asked. Built from the project baked in at build time;
/// tests point it at a loopback server.
pub struct Endpoints {
    pub sign_in: String,
    /// Where Firebase is asked to email a password reset link (`admin_account.rs`).
    pub send_code: String,
    pub token: String,
    /// The company's document; `:runAggregationQuery` and `:runQuery` go on the end.
    pub register: String,
    /// Where a batch of writes is sent (the kiosk's backup, `cloud_mirror.rs`).
    pub commit: String,
    /// What a document under the company's document is called in a write.
    pub names: String,
}

/// The register baked in at build time (GitHub secrets
/// `ALPHA_PREMIER_FIREBASE_PROJECT_ID` and `ALPHA_PREMIER_FIREBASE_API_KEY`).
/// A build without them has no register and asks nothing.
pub fn built_in() -> Option<Endpoints> {
    let filled = |value: Option<&'static str>| value.map(str::trim).filter(|v| !v.is_empty());
    let project = filled(option_env!("ALPHA_PREMIER_FIREBASE_PROJECT_ID"))?;
    let key = filled(option_env!("ALPHA_PREMIER_FIREBASE_API_KEY"))?;
    Some(Endpoints {
        sign_in: format!("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={key}"),
        send_code: format!("https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key={key}"),
        token: format!("https://securetoken.googleapis.com/v1/token?key={key}"),
        register: format!("https://firestore.googleapis.com/v1/projects/{project}/databases/(default)/documents/keystone/apg"),
        commit: format!("https://firestore.googleapis.com/v1/projects/{project}/databases/(default)/documents:commit"),
        names: format!("projects/{project}/databases/(default)/documents/keystone/apg"),
    })
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterStatus {
    pub built_in: bool,
    pub signed_in_as: Option<String>,
    pub last_checked_at: Option<String>,
    pub problem: Option<String>,
    /// Users added from the register who have no card yet.
    pub waiting: i64,
    /// The kiosk's copy of its records in the shared backend.
    pub backup: crate::services::cloud_mirror::BackupStatus,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct PullSummary {
    /// The register was listed (its count had changed).
    pub listed: bool,
    pub added: Vec<String>,
}

pub(crate) enum Answer {
    Ok(serde_json::Value),
    /// The HTTP status and the service's own message.
    Refused(u16, String),
    Unreachable,
}

pub(crate) async fn ask(request: reqwest::RequestBuilder) -> Answer {
    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            // The address carries the API key: keep it out of the log.
            log::warn!("id register unreachable: {}", error.without_url());
            return Answer::Unreachable;
        }
    };
    let status = response.status();
    let body: serde_json::Value = response.json().await.unwrap_or(serde_json::Value::Null);
    if status.is_success() {
        return Answer::Ok(body);
    }
    if status.is_server_error() || status.as_u16() == 429 {
        return Answer::Unreachable;
    }
    // Auth answers `{error}`; a Firestore query answers `[{error}]`.
    let error = body.get("error").or_else(|| body.get(0).and_then(|first| first.get("error")));
    let message = error.and_then(|e| e.get("message")).and_then(|m| m.as_str()).unwrap_or("").to_string();
    Answer::Refused(status.as_u16(), message)
}

pub(crate) fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("http client failed: {e}"))
}

async fn forget(db: &SqlitePool, key: &str) {
    let _ = sqlx::query("DELETE FROM app_settings WHERE key = ?").bind(key).execute(db).await;
}

async fn note_problem(db: &SqlitePool, problem: &str) -> String {
    let now = chrono::Utc::now().to_rfc3339();
    let _ = store_setting(db, PROBLEM_KEY, problem, &now).await;
    problem.to_string()
}

pub async fn status(state: &AppState) -> RegisterStatus {
    let db = &state.db;
    let waiting = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE rfid_uid LIKE ? || '%'")
        .bind(WAITING_PREFIX)
        .fetch_one(db)
        .await
        .unwrap_or(0);
    RegisterStatus {
        built_in: built_in().is_some(),
        signed_in_as: match read_setting(db, TOKEN_KEY).await {
            Some(_) => read_setting(db, EMAIL_KEY).await,
            None => None,
        },
        last_checked_at: read_setting(db, CHECKED_KEY).await,
        problem: read_setting(db, PROBLEM_KEY).await.filter(|p| !p.is_empty()),
        waiting,
        backup: crate::services::cloud_mirror::status(state).await,
    }
}

fn sign_in_refusal(code: &str) -> String {
    // Firebase puts detail after the code: "TOO_MANY_ATTEMPTS_TRY_LATER : Access to this account…".
    match code.split(' ').next().unwrap_or("") {
        "INVALID_LOGIN_CREDENTIALS" | "INVALID_PASSWORD" | "EMAIL_NOT_FOUND" | "INVALID_EMAIL" | "MISSING_PASSWORD" => {
            "The email or password is not right.".into()
        }
        "USER_DISABLED" => "This account has been turned off. Ask the owner.".into(),
        "TOO_MANY_ATTEMPTS_TRY_LATER" => "Too many tries. Wait a few minutes and try again.".into(),
        other => format!("The ID register refused the sign-in ({other})."),
    }
}

/// Sign the kiosk in with its register account, check that the account can
/// read the register, and pull once. Nothing is kept unless all of it worked.
pub async fn sign_in(
    state: &AppState,
    endpoints: Option<&Endpoints>,
    email: &str,
    password: &str,
) -> Result<PullSummary, String> {
    let endpoints = endpoints.ok_or(NOT_BUILT_IN)?;
    let email = email.trim();
    if email.is_empty() || password.is_empty() {
        return Err("Enter the kiosk account's email and password.".into());
    }
    let client = http()?;
    let signed = ask(client.post(&endpoints.sign_in).json(&serde_json::json!({
        "email": email, "password": password, "returnSecureToken": true,
    })))
    .await;
    let body = match signed {
        Answer::Ok(body) => body,
        Answer::Refused(_, code) => return Err(sign_in_refusal(&code)),
        Answer::Unreachable => return Err(UNREACHABLE.into()),
    };
    let text = |name: &str| body.get(name).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let (id_token, refresh_token) = (text("idToken"), text("refreshToken"));
    if id_token.is_empty() || refresh_token.is_empty() {
        return Err(UNREADABLE.into());
    }
    count_interns(&client, endpoints, &id_token).await?;
    let now = chrono::Utc::now().to_rfc3339();
    store_setting(&state.db, TOKEN_KEY, &refresh_token, &now).await?;
    let signed_email = text("email");
    store_setting(&state.db, EMAIL_KEY, if signed_email.is_empty() { email } else { &signed_email }, &now).await?;
    forget(&state.db, PROBLEM_KEY).await;
    // A different account may see a different register: read it in full once.
    forget(&state.db, COUNT_KEY).await;
    pull(state, &client, endpoints, &id_token).await
}

/// Forget the sign-in. The numbers already seen are kept, so signing in again
/// does not bring back anyone an administrator deleted.
pub async fn sign_out(db: &SqlitePool) {
    for key in [TOKEN_KEY, EMAIL_KEY, COUNT_KEY, PROBLEM_KEY] {
        forget(db, key).await;
    }
}

/// One pass: nothing when the kiosk has no register or is signed out.
pub async fn run_once(state: &AppState, endpoints: Option<&Endpoints>) -> Result<PullSummary, String> {
    let Some(endpoints) = endpoints else {
        return Ok(PullSummary::default());
    };
    let Some(refresh_token) = read_setting(&state.db, TOKEN_KEY).await else {
        return Ok(PullSummary::default());
    };
    let client = http()?;
    let refreshed = ask(client.post(&endpoints.token).form(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token.as_str()),
    ]))
    .await;
    let body = match refreshed {
        Answer::Ok(body) => body,
        Answer::Refused(_, code) => {
            // The account was removed, turned off or its password changed.
            forget(&state.db, TOKEN_KEY).await;
            forget(&state.db, COUNT_KEY).await;
            let problem = format!("The ID register no longer accepts this kiosk's sign-in ({code}). Sign in again.");
            return Err(note_problem(&state.db, &problem).await);
        }
        Answer::Unreachable => return Err(note_problem(&state.db, UNREACHABLE).await),
    };
    let text = |name: &str| body.get(name).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let id_token = text("id_token");
    if id_token.is_empty() {
        return Err(note_problem(&state.db, UNREADABLE).await);
    }
    let rotated = text("refresh_token");
    if !rotated.is_empty() && rotated != refresh_token {
        store_setting(&state.db, TOKEN_KEY, &rotated, &chrono::Utc::now().to_rfc3339()).await?;
    }
    let pulled = pull(state, &client, endpoints, &id_token).await;
    // The backup has its own problem line; a pull that failed does not stop it, nor the other way round.
    if let Err(problem) = crate::services::cloud_mirror::push(state, &client, endpoints, &id_token).await {
        log::warn!("cloud backup pass failed: {problem}");
    }
    match pulled {
        Ok(summary) => Ok(summary),
        Err(problem) => Err(note_problem(&state.db, &problem).await),
    }
}

fn register_query() -> serde_json::Value {
    serde_json::json!({
        "from": [{"collectionId": "idreg"}],
        "where": {"fieldFilter": {"field": {"fieldPath": "kind"}, "op": "EQUAL", "value": {"stringValue": "intern"}}},
    })
}

async fn count_interns(client: &reqwest::Client, endpoints: &Endpoints, id_token: &str) -> Result<i64, String> {
    let counted = ask(client
        .post(format!("{}:runAggregationQuery", endpoints.register))
        .bearer_auth(id_token)
        .json(&serde_json::json!({"structuredAggregationQuery": {
            "structuredQuery": register_query(),
            "aggregations": [{"alias": "n", "count": {}}],
        }})))
    .await;
    match counted {
        Answer::Ok(body) => body
            .get(0)
            .and_then(|first| first.pointer("/result/aggregateFields/n/integerValue"))
            // Firestore writes whole numbers as strings.
            .and_then(|n| n.as_str().and_then(|s| s.parse().ok()).or_else(|| n.as_i64()))
            .ok_or_else(|| UNREADABLE.to_string()),
        Answer::Refused(..) => Err(NOT_ALLOWED.into()),
        Answer::Unreachable => Err(UNREACHABLE.into()),
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Issued {
    number: String,
    name: String,
    title: String,
}

/// `APG-2026-126`: the same shape the register's rules hold a number to.
fn is_id_number(number: &str) -> bool {
    let mut parts = number.split('-');
    let digits = |part: Option<&str>, min: usize, max: usize| {
        part.is_some_and(|p| (min..=max).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()))
    };
    parts.next() == Some("APG") && digits(parts.next(), 4, 4) && digits(parts.next(), 3, 6) && parts.next().is_none()
}

/// The interns in a `runQuery` answer. Nothing about a document's shape is
/// taken on trust: one that does not read as an intern's card is left out.
fn issued_interns(body: &serde_json::Value) -> Vec<Issued> {
    let Some(rows) = body.as_array() else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|row| {
            let document = row.get("document")?;
            let field = |name: &str| {
                document.pointer(&format!("/fields/{name}/stringValue")).and_then(|v| v.as_str()).unwrap_or("").trim().to_string()
            };
            // The document's own name is the number, whatever its fields say.
            let number = document.get("name")?.as_str()?.rsplit('/').next()?.to_string();
            (is_id_number(&number) && field("kind") == "intern").then(|| Issued { number, name: field("name"), title: field("title") })
        })
        .collect()
}

async fn seen_numbers(db: &SqlitePool) -> BTreeSet<String> {
    read_setting(db, SEEN_KEY)
        .await
        .and_then(|stored| serde_json::from_str(&stored).ok())
        .unwrap_or_default()
}

async fn pull(
    state: &AppState,
    client: &reqwest::Client,
    endpoints: &Endpoints,
    id_token: &str,
) -> Result<PullSummary, String> {
    let count = count_interns(client, endpoints, id_token).await?;
    let now = chrono::Utc::now().to_rfc3339();
    if read_setting(&state.db, COUNT_KEY).await.as_deref() == Some(count.to_string().as_str()) {
        store_setting(&state.db, CHECKED_KEY, &now, &now).await?;
        forget(&state.db, PROBLEM_KEY).await;
        return Ok(PullSummary::default());
    }
    let listed = ask(client
        .post(format!("{}:runQuery", endpoints.register))
        .bearer_auth(id_token)
        .json(&serde_json::json!({"structuredQuery": register_query()})))
    .await;
    let interns = match listed {
        Answer::Ok(body) if body.is_array() => issued_interns(&body),
        Answer::Ok(_) => return Err(UNREADABLE.into()),
        Answer::Refused(..) => return Err(NOT_ALLOWED.into()),
        Answer::Unreachable => return Err(UNREACHABLE.into()),
    };
    let mut seen = seen_numbers(&state.db).await;
    let mut added = Vec::new();
    let mut unsaved = None;
    for intern in interns {
        if seen.contains(&intern.number) {
            continue;
        }
        let saved = crate::save_user(
            state,
            serde_json::json!({
                "userId": intern.number,
                "rfidUid": format!("{WAITING_PREFIX}{}", intern.number),
                "fullName": intern.name,
                "department": if intern.title.is_empty() { None } else { Some(&intern.title) },
                "status": "ACTIVE",
                "employeeType": "INTERN",
                "gender": null,
                "dailyRate": null,
                "payrollProfileId": null,
            }),
            crate::SaveOrigin::IdRegister,
        )
        .await;
        match saved {
            Ok(result) => {
                if result.get("created").and_then(|c| c.as_bool()) == Some(true) {
                    added.push(intern.number.clone());
                }
                seen.insert(intern.number);
            }
            // A card is never changed once issued, so one the kiosk cannot take now it never can.
            Err(error) if error == "ADMIN_VALIDATION_ERROR" => {
                log::warn!("id register: {} cannot be a user here (no usable name)", intern.number);
                seen.insert(intern.number);
            }
            Err(error) => {
                log::warn!("id register: {} not added: {error}", intern.number);
                unsaved = Some(intern.number);
            }
        }
    }
    let seen_text = serde_json::to_string(&seen).map_err(|e| e.to_string())?;
    store_setting(&state.db, SEEN_KEY, &seen_text, &now).await?;
    if let Some(number) = unsaved {
        // The count is not kept, so the next pass lists again.
        return Err(format!("{number} could not be added from the ID register. The kiosk will try again."));
    }
    store_setting(&state.db, COUNT_KEY, &count.to_string(), &now).await?;
    store_setting(&state.db, CHECKED_KEY, &now, &now).await?;
    forget(&state.db, PROBLEM_KEY).await;
    Ok(PullSummary { listed: true, added })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    pub(crate) const PASSWORD: &str = "the-kiosk-password";

    pub(crate) struct Card {
        pub(crate) number: &'static str,
        pub(crate) kind: Option<&'static str>,
        pub(crate) name: &'static str,
        pub(crate) title: &'static str,
    }

    /// A stand-in for Firebase Auth and the register on a loopback port. It
    /// answers the way the real services do and notes what it was asked.
    #[derive(Default)]
    pub(crate) struct Fake {
        pub(crate) cards: Vec<Card>,
        pub(crate) refuse_refresh: bool,
        pub(crate) refuse_register: bool,
        /// The status the backup's writes are refused with, when they are.
        pub(crate) refuse_backup: Option<u16>,
        pub(crate) asked: Vec<&'static str>,
        /// Every write the backup sent, in order, one list per request.
        pub(crate) written: Vec<Vec<serde_json::Value>>,
        /// What those writes left behind: `att_users/APG-2026-101` → its fields.
        pub(crate) stored: std::collections::BTreeMap<String, serde_json::Value>,
        /// The status reading the records back is refused with, when it is (the rules before Keystone's ADR 0028).
        pub(crate) refuse_reading_back: Option<u16>,
        /// Refuse a batch that writes under `attprivate_…`, as those same older rules do.
        pub(crate) refuse_apart: bool,
        /// People with their own sign-in: email → (uid, password, the code Firebase refuses them with, if any).
        pub(crate) people: std::collections::BTreeMap<&'static str, (&'static str, &'static str, Option<&'static str>)>,
        /// Keystone's members: uid → (role, name, attendanceAdmin).
        pub(crate) members: std::collections::BTreeMap<&'static str, (&'static str, &'static str, bool)>,
        /// The addresses a password reset email was asked for.
        pub(crate) reset_asked: Vec<String>,
    }

    impl Fake {
        fn interns(&self) -> Vec<&Card> {
            self.cards.iter().filter(|card| card.kind == Some("intern")).collect()
        }

        fn answer(&mut self, path: &str, head: &str, body: &str) -> (u16, serde_json::Value) {
            let refused = |code: u16, message: &str| (code, serde_json::json!({"error": {"code": code, "message": message}}));
            if path.starts_with("/signin") {
                self.asked.push("signin");
                let sent: serde_json::Value = serde_json::from_str(body).unwrap();
                if let Some((uid, password, refused_with)) = sent["email"].as_str().and_then(|email| self.people.get(email)) {
                    if let Some(code) = refused_with {
                        return refused(400, code);
                    }
                    if sent["password"] != *password {
                        return refused(400, "INVALID_LOGIN_CREDENTIALS");
                    }
                    return (200, serde_json::json!({"idToken": format!("id-of-{uid}"), "refreshToken": "r", "email": sent["email"], "localId": uid}));
                }
                if sent["password"] != PASSWORD {
                    return refused(400, "INVALID_LOGIN_CREDENTIALS");
                }
                return (200, serde_json::json!({"idToken": "id-1", "refreshToken": "refresh-1", "email": sent["email"]}));
            }
            if path.starts_with("/sendcode") {
                self.asked.push("sendcode");
                let sent: serde_json::Value = serde_json::from_str(body).unwrap();
                let email = sent["email"].as_str().unwrap_or("").to_string();
                assert_eq!(sent["requestType"], "PASSWORD_RESET");
                let known = self.people.contains_key(email.as_str());
                self.reset_asked.push(email);
                return if known { (200, serde_json::json!({"email": sent["email"]})) } else { refused(400, "EMAIL_NOT_FOUND") };
            }
            if let Some(uid) = path.strip_prefix("/reg/members/") {
                self.asked.push("member");
                // Keystone's rules: a member reads members; anyone else is refused.
                let asking = self.members.keys().find(|member| head.to_ascii_lowercase().contains(&format!("authorization: bearer id-of-{}", member.to_ascii_lowercase())));
                return match (asking, self.members.get(uid)) {
                    (Some(_), Some((role, name, ticked))) => (200, serde_json::json!({"name": "n", "fields": {
                        "role": {"stringValue": role}, "name": {"stringValue": name}, "attendanceAdmin": {"booleanValue": ticked},
                    }})),
                    _ => (403, serde_json::json!({"error": {"code": 403, "message": "Missing or insufficient permissions."}})),
                };
            }
            if path.starts_with("/token") {
                self.asked.push("token");
                if self.refuse_refresh || !body.contains("refresh_token=refresh-1") {
                    return refused(400, "TOKEN_EXPIRED");
                }
                return (200, serde_json::json!({"id_token": "id-1", "refresh_token": "refresh-1"}));
            }
            let counting = path.starts_with("/reg:runAggregationQuery");
            let backup = path.starts_with("/commit");
            // The kiosk's own records, read back: a page of a collection, or a count of one.
            let own = path.strip_prefix("/reg/").map(|rest| rest.split('?').next().unwrap_or("").to_string()).or_else(|| {
                let asked: serde_json::Value = serde_json::from_str(body).ok()?;
                let of = asked.pointer("/structuredAggregationQuery/structuredQuery/from/0/collectionId")?.as_str()?.to_string();
                (counting && of != "idreg").then_some(of)
            });
            self.asked.push(if backup { "backup" } else if own.is_some() { "own" } else if counting { "count" } else { "list" });
            if !head.to_ascii_lowercase().contains("authorization: bearer id-1") {
                return (401, serde_json::json!([{"error": {"code": 401, "message": "Missing or invalid authentication."}}]));
            }
            if backup {
                if let Some(code) = self.refuse_backup {
                    return refused(code, "Missing or insufficient permissions.");
                }
                let sent: serde_json::Value = serde_json::from_str(body).unwrap();
                let writes = sent["writes"].as_array().unwrap().clone();
                if self.refuse_apart && body.contains("/attprivate_") {
                    return refused(403, "Missing or insufficient permissions.");
                }
                let results: Vec<serde_json::Value> = writes.iter().map(|_| serde_json::json!({"updateTime": "t"})).collect();
                for write in &writes {
                    let short = |name: &serde_json::Value| name.as_str().unwrap().rsplit_once("/keystone/apg/").unwrap().1.to_string();
                    if write.get("delete").is_some() {
                        self.stored.remove(&short(&write["delete"]));
                    } else {
                        self.stored.insert(short(&write["update"]["name"]), write["update"]["fields"].clone());
                    }
                }
                self.written.push(writes);
                return (200, serde_json::json!({"writeResults": results, "commitTime": "t"}));
            }
            if let Some(collection) = own {
                if let Some(code) = self.refuse_reading_back {
                    return (code, serde_json::json!([{"error": {"code": code, "message": "Missing or insufficient permissions."}}]));
                }
                let held: Vec<&serde_json::Value> = self.stored.iter().filter(|(name, _)| name.split('/').next() == Some(collection.as_str())).map(|(_, fields)| fields).collect();
                if counting {
                    return (200, serde_json::json!([{"result": {"aggregateFields": {"n": {"integerValue": held.len().to_string()}}}, "readTime": "t"}]));
                }
                let query = path.split_once('?').map_or("", |(_, query)| query);
                let number = |name: &str| query.split('&').find_map(|pair| pair.strip_prefix(&format!("{name}="))).and_then(|v| v.parse::<usize>().ok());
                let (from, size) = (number("pageToken").unwrap_or(0), number("pageSize").unwrap_or(20));
                let page: Vec<serde_json::Value> = held.iter().skip(from).take(size).map(|fields| serde_json::json!({"name": "n", "fields": fields})).collect();
                let mut answer = serde_json::json!({"documents": page});
                if from + size < held.len() {
                    answer["nextPageToken"] = serde_json::json!((from + size).to_string());
                }
                return (200, answer);
            }
            if self.refuse_register {
                return (403, serde_json::json!([{"error": {"code": 403, "message": "Missing or insufficient permissions."}}]));
            }
            if counting {
                let n = self.interns().len().to_string();
                return (200, serde_json::json!([{"result": {"aggregateFields": {"n": {"integerValue": n}}}, "readTime": "t"}]));
            }
            let rows: Vec<serde_json::Value> = self
                .interns()
                .iter()
                .map(|card| {
                    serde_json::json!({"document": {
                        "name": format!("projects/p/databases/(default)/documents/keystone/apg/idreg/{}", card.number),
                        "fields": {"id": {"stringValue": card.number}, "kind": {"stringValue": "intern"},
                                   "name": {"stringValue": card.name}, "title": {"stringValue": card.title}},
                    }, "readTime": "t"})
                })
                .collect();
            (200, if rows.is_empty() { serde_json::json!([{"readTime": "t"}]) } else { serde_json::Value::Array(rows) })
        }
    }

    pub(crate) async fn serve(fake: Arc<Mutex<Fake>>) -> (Endpoints, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let at = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else { break };
                let mut request = Vec::new();
                let mut buffer = vec![0u8; 16384];
                // Read the head, then as much body as it says there is.
                let (head, body) = loop {
                    let Ok(n) = stream.read(&mut buffer).await else { break (String::new(), String::new()) };
                    request.extend_from_slice(&buffer[..n]);
                    let text = String::from_utf8_lossy(&request).into_owned();
                    if let Some((head, body)) = text.split_once("\r\n\r\n") {
                        let length = head
                            .lines()
                            .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                            .unwrap_or(0);
                        if body.len() >= length || n == 0 {
                            break (head.to_string(), body.to_string());
                        }
                    } else if n == 0 {
                        break (String::new(), String::new());
                    }
                };
                let path = head.split(' ').nth(1).unwrap_or("").to_string();
                let (status, answer) = fake.lock().unwrap().answer(&path, &head, &body);
                let answer = answer.to_string();
                let response = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{answer}",
                    answer.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });
        (Endpoints { sign_in: format!("{at}/signin?key=k"), send_code: format!("{at}/sendcode?key=k"), token: format!("{at}/token?key=k"), register: format!("{at}/reg"), commit: format!("{at}/commit"), names: "projects/p/databases/(default)/documents/keystone/apg".into() }, server)
    }

    /// Somewhere nothing answers.
    pub(crate) async fn nowhere() -> Endpoints {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let at = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        Endpoints { sign_in: format!("{at}/signin"), send_code: format!("{at}/sendcode"), token: format!("{at}/token"), register: format!("{at}/reg"), commit: format!("{at}/commit"), names: "projects/p/databases/(default)/documents/keystone/apg".into() }
    }

    pub(crate) async fn kiosk(tag: &str) -> (AppState, std::path::PathBuf) {
        let temp = std::env::temp_dir().join(format!("alpha-idreg-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        let state = AppState::new(
            temp.clone(),
            temp.join("attendance.db"),
            temp.join("exports"),
            false,
            crate::config::LanConfig::default(),
            crate::config::OfficeConfig::default(),
            crate::config::ScannerConfig::default(),
            crate::config::TtsConfig::default(),
            crate::config::UpdaterConfig::default(),
        )
        .await
        .unwrap();
        (state, temp)
    }

    pub(crate) async fn close(state: AppState, temp: std::path::PathBuf, server: tokio::task::JoinHandle<()>) {
        server.abort();
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    pub(crate) fn register(cards: Vec<Card>) -> Arc<Mutex<Fake>> {
        Arc::new(Mutex::new(Fake { cards, ..Fake::default() }))
    }

    pub(crate) fn intern(number: &'static str, name: &'static str) -> Card {
        Card { number, kind: Some("intern"), name, title: "IT Intern" }
    }

    async fn card_of(state: &AppState, user_id: &str) -> Option<String> {
        sqlx::query_scalar("SELECT rfid_uid FROM users WHERE user_id = ?").bind(user_id).fetch_optional(&state.db).await.unwrap()
    }

    #[tokio::test]
    async fn id_register_adds_new_interns_waiting_for_a_card() {
        let (state, temp) = kiosk("adds").await;
        let fake = register(vec![
            intern("APG-2026-126", "juan dela cruz"),
            Card { number: "APG-2026-127", kind: Some("employee"), name: "Maria Santos", title: "Accountant" },
            Card { number: "APG-2026-124", kind: None, name: "Issued Before Kinds", title: "" },
        ]);
        let (endpoints, server) = serve(fake.clone()).await;

        let summary = sign_in(&state, Some(&endpoints), " kiosk@example.test ", PASSWORD).await.unwrap();
        assert_eq!(summary, PullSummary { listed: true, added: vec!["APG-2026-126".to_string()] });

        let users: Vec<(String, String, String, Option<String>, String, String)> =
            sqlx::query_as("SELECT user_id, rfid_uid, full_name, department, status, employee_type FROM users")
                .fetch_all(&state.db)
                .await
                .unwrap();
        assert_eq!(
            users,
            vec![(
                "APG-2026-126".to_string(),
                "PENDING-APG-2026-126".to_string(),
                "Juan Dela Cruz".to_string(),
                Some("IT Intern".to_string()),
                "ACTIVE".to_string(),
                "INTERN".to_string(),
            )],
            "only the intern is added; the employee and the card with no kind are left out"
        );
        let queued: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_queue WHERE table_name = 'Users' AND row_id = 'APG-2026-126' AND operation = 'UPSERT'")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(queued, 1, "the Users sync row is queued with the save");
        let audit: Vec<String> = sqlx::query_scalar("SELECT event_type FROM audit_logs WHERE user_id = 'APG-2026-126'")
            .fetch_all(&state.db)
            .await
            .unwrap();
        assert_eq!(audit, vec!["ID_REGISTER_PULL".to_string()], "the audit line says where the user came from");

        let now = status(&state).await;
        assert_eq!(now.signed_in_as.as_deref(), Some("kiosk@example.test"));
        assert_eq!(now.waiting, 1);
        assert_eq!(now.problem, None);
        assert!(now.last_checked_at.is_some());
        let kept: Vec<String> = sqlx::query_scalar("SELECT value FROM app_settings").fetch_all(&state.db).await.unwrap();
        assert!(kept.iter().all(|value| !value.contains(PASSWORD)), "the password is never kept");
        assert!(kept.iter().any(|value| value == "refresh-1"), "the refresh token is what is kept");
        close(state, temp, server).await;
    }

    #[tokio::test]
    async fn id_register_never_changes_a_person_the_kiosk_has_and_never_returns_a_deleted_one() {
        let (state, temp) = kiosk("keeps").await;
        crate::upsert_user_record(
            &state.db, "APG-2026-126", "ABCD1234", "Juan Dela Cruz", Some("IT"), "ACTIVE", "INTERN",
            None, None, None, None, "EMPLOYEE", "2026-08-01T00:00:00Z",
        )
        .await
        .unwrap();
        let fake = register(vec![intern("APG-2026-126", "Someone Else Entirely"), intern("APG-2026-130", "Ana Reyes")]);
        let (endpoints, server) = serve(fake.clone()).await;

        let summary = sign_in(&state, Some(&endpoints), "kiosk@example.test", PASSWORD).await.unwrap();
        assert_eq!(summary.added, vec!["APG-2026-130".to_string()]);
        let kept: (String, String) = sqlx::query_as("SELECT rfid_uid, full_name FROM users WHERE user_id = 'APG-2026-126'")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(kept, ("ABCD1234".to_string(), "Juan Dela Cruz".to_string()), "a person with a card keeps it, and their name");

        crate::delete_user_and_cascade(&state, "APG-2026-130").await.unwrap();
        // An unchanged register is not listed, so nothing can come back.
        assert_eq!(run_once(&state, Some(&endpoints)).await.unwrap(), PullSummary::default());
        // The register grows: it is listed again, and the deleted person is in the list.
        fake.lock().unwrap().cards.push(intern("APG-2026-131", "Luis Garcia"));
        let grown = run_once(&state, Some(&endpoints)).await.unwrap();
        assert_eq!(grown, PullSummary { listed: true, added: vec!["APG-2026-131".to_string()] });
        assert_eq!(card_of(&state, "APG-2026-130").await, None, "a deleted user stays deleted");
        // Signing out and in again reads the register in full, and still does not bring them back.
        sign_out(&state.db).await;
        let again = sign_in(&state, Some(&endpoints), "kiosk@example.test", PASSWORD).await.unwrap();
        assert_eq!(again, PullSummary { listed: true, added: vec![] });
        assert_eq!(card_of(&state, "APG-2026-130").await, None);
        close(state, temp, server).await;
    }

    #[tokio::test]
    async fn id_register_is_listed_only_when_it_has_grown() {
        let (state, temp) = kiosk("count").await;
        let fake = register(vec![intern("APG-2026-126", "Juan Dela Cruz")]);
        let (endpoints, server) = serve(fake.clone()).await;
        sign_in(&state, Some(&endpoints), "kiosk@example.test", PASSWORD).await.unwrap();
        // Signing in: the sign-in, a count to prove the account can read, then the first pull.
        assert_eq!(std::mem::take(&mut fake.lock().unwrap().asked), vec!["signin", "count", "count", "list"]);

        // The first pass after signing in also sends the records, then counts each of the 11 collections once to
        // make Firebase the main record; with nothing changed, the next pass sends and counts nothing.
        run_once(&state, Some(&endpoints)).await.unwrap();
        run_once(&state, Some(&endpoints)).await.unwrap();
        // Two requests: the records, then what is kept apart (the intern's account number), on its own.
        let mut expected = vec!["token", "count", "backup", "backup"];
        expected.extend(["own"; 11]);
        expected.extend(["token", "count"]);
        assert_eq!(std::mem::take(&mut fake.lock().unwrap().asked), expected);

        fake.lock().unwrap().cards.push(intern("APG-2026-127", "Ana Reyes"));
        run_once(&state, Some(&endpoints)).await.unwrap();
        assert_eq!(std::mem::take(&mut fake.lock().unwrap().asked), vec!["token", "count", "list", "backup", "backup"]);
        close(state, temp, server).await;
    }

    #[tokio::test]
    async fn id_register_problems_are_told_apart() {
        let (state, temp) = kiosk("problems").await;
        let fake = register(vec![intern("APG-2026-126", "Juan Dela Cruz")]);
        let (endpoints, server) = serve(fake.clone()).await;

        // A wrong password, and an account the register refuses, keep nothing.
        let wrong = sign_in(&state, Some(&endpoints), "kiosk@example.test", "not-the-password").await;
        assert_eq!(wrong.unwrap_err(), "The email or password is not right.");
        fake.lock().unwrap().refuse_register = true;
        let outsider = sign_in(&state, Some(&endpoints), "kiosk@example.test", PASSWORD).await;
        assert_eq!(outsider.unwrap_err(), NOT_ALLOWED);
        let kept: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM app_settings WHERE key LIKE 'id_register_%'").fetch_one(&state.db).await.unwrap();
        assert_eq!(kept, 0, "a sign-in that did not work keeps nothing");
        assert_eq!(card_of(&state, "APG-2026-126").await, None);

        fake.lock().unwrap().refuse_register = false;
        sign_in(&state, Some(&endpoints), "kiosk@example.test", PASSWORD).await.unwrap();

        // Unreachable: nothing changes, and it is tried again.
        let unreachable = run_once(&state, Some(&nowhere().await)).await;
        assert_eq!(unreachable.unwrap_err(), UNREACHABLE);
        let now = status(&state).await;
        assert_eq!(now.problem.as_deref(), Some(UNREACHABLE));
        assert_eq!(now.signed_in_as.as_deref(), Some("kiosk@example.test"), "an unreachable register keeps the sign-in");
        run_once(&state, Some(&endpoints)).await.unwrap();
        assert_eq!(status(&state).await.problem, None, "a pass that works clears the problem");

        // The account loses the register: said so, sign-in kept for when it is given back.
        fake.lock().unwrap().refuse_register = true;
        assert_eq!(run_once(&state, Some(&endpoints)).await.unwrap_err(), NOT_ALLOWED);
        let now = status(&state).await;
        assert_eq!(now.problem.as_deref(), Some(NOT_ALLOWED));
        assert!(now.signed_in_as.is_some());
        fake.lock().unwrap().refuse_register = false;

        // The sign-in itself is refused: signed out, and told to sign in again.
        fake.lock().unwrap().refuse_refresh = true;
        let refused = run_once(&state, Some(&endpoints)).await.unwrap_err();
        assert!(refused.contains("TOKEN_EXPIRED") && refused.ends_with("Sign in again."), "{refused}");
        let now = status(&state).await;
        assert_eq!(now.signed_in_as, None);
        assert_eq!(now.problem.as_deref(), Some(refused.as_str()));
        // Signed out: later passes ask nothing.
        fake.lock().unwrap().asked.clear();
        assert_eq!(run_once(&state, Some(&endpoints)).await.unwrap(), PullSummary::default());
        assert!(fake.lock().unwrap().asked.is_empty());
        close(state, temp, server).await;
    }

    #[tokio::test]
    async fn id_register_not_built_in_asks_nothing() {
        let (state, temp) = kiosk("absent").await;
        let fake = register(vec![intern("APG-2026-126", "Juan Dela Cruz")]);
        let (endpoints, server) = serve(fake.clone()).await;
        sign_in(&state, Some(&endpoints), "kiosk@example.test", PASSWORD).await.unwrap();
        fake.lock().unwrap().asked.clear();

        assert_eq!(run_once(&state, None).await.unwrap(), PullSummary::default());
        assert_eq!(sign_in(&state, None, "kiosk@example.test", PASSWORD).await.unwrap_err(), NOT_BUILT_IN);
        assert!(fake.lock().unwrap().asked.is_empty());
        // Tests are built without the secrets, as a copy built by hand would be.
        assert!(built_in().is_none());
        assert!(!status(&state).await.built_in);
        close(state, temp, server).await;
    }

    #[tokio::test]
    async fn id_register_waiting_user_takes_a_card_and_scans() {
        let (state, temp) = kiosk("binds").await;
        let fake = register(vec![intern("APG-2026-126", "Juan Dela Cruz")]);
        let (endpoints, server) = serve(fake.clone()).await;
        sign_in(&state, Some(&endpoints), "kiosk@example.test", PASSWORD).await.unwrap();

        // No reader, and no typed scan, can stand in for a card that is not there yet.
        let placeholder = serde_json::json!({"rfidUid": "PENDING-APG-2026-126", "source": "RFID"});
        let refused = crate::scan_rfid_impl(None, &state, placeholder).await.unwrap();
        assert_eq!(refused["error"]["code"], "INVALID_SCAN_INPUT");

        // Admin → Users: the same user saved with the card just tapped.
        crate::admin_upsert_user_inner(
            &state,
            serde_json::json!({"userId": "APG-2026-126", "rfidUid": "a1b2c3d4", "fullName": "Juan Dela Cruz", "department": "IT Intern", "status": "ACTIVE", "employeeType": "INTERN"}),
        )
        .await
        .unwrap();
        // One row: the waiting user is changed, not doubled.
        let cards: Vec<String> = sqlx::query_scalar("SELECT rfid_uid FROM users").fetch_all(&state.db).await.unwrap();
        assert_eq!(cards, vec!["A1B2C3D4".to_string()]);
        assert_eq!(status(&state).await.waiting, 0);

        let tap = crate::scan_rfid_impl(None, &state, serde_json::json!({"rfidUid": "A1B2C3D4", "source": "RFID"})).await.unwrap();
        assert_eq!(tap["success"], true, "{tap}");
        // The next pass leaves the card alone.
        fake.lock().unwrap().cards.push(intern("APG-2026-127", "Ana Reyes"));
        run_once(&state, Some(&endpoints)).await.unwrap();
        assert_eq!(card_of(&state, "APG-2026-126").await.as_deref(), Some("A1B2C3D4"));
        close(state, temp, server).await;
    }

    #[test]
    fn id_register_reads_only_what_is_an_interns_card() {
        let doc = |number: &str, kind: &str| {
            serde_json::json!({"document": {
                "name": format!("projects/p/databases/(default)/documents/keystone/apg/idreg/{number}"),
                "fields": {"kind": {"stringValue": kind}, "name": {"stringValue": " Ana Reyes "}, "title": {"stringValue": "HR Intern"}},
            }})
        };
        let body = serde_json::json!([
            doc("APG-2026-126", "intern"),
            doc("APG-2026-127", "employee"),
            doc("../users/admin", "intern"),
            doc("APG-26-1", "intern"),
            {"readTime": "t"},
            {"document": {"name": 7}},
        ]);
        assert_eq!(
            issued_interns(&body),
            vec![Issued { number: "APG-2026-126".into(), name: "Ana Reyes".into(), title: "HR Intern".into() }]
        );
        assert!(issued_interns(&serde_json::json!({"error": "not a list"})).is_empty());
        for number in ["APG-2026-001", "APG-2027-123456"] {
            assert!(is_id_number(number), "{number}");
        }
        for number in ["", "APG-2026-12", "APG-2026-1234567", "apg-2026-126", "APG-2026-126-1", "APG-20x6-126", "PENDING-APG-2026-126"] {
            assert!(!is_id_number(number), "{number}");
        }
    }
}
