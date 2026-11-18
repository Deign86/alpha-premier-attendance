//! Keystone's Firebase project, as this kiosk asks it: where to ask, how an
//! answer is read, signing in with an email and password, and counting a
//! collection. The ID register (`id_register.rs`), the kiosk's backup
//! (`cloud_mirror.rs`) and the admin account sign-in (`admin_account.rs`)
//! all ask through here.

/// Where Firebase is asked. Built from the project baked in at build time;
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

/// The project baked in at build time (GitHub secrets
/// `ALPHA_PREMIER_FIREBASE_PROJECT_ID` and `ALPHA_PREMIER_FIREBASE_API_KEY`).
/// A build without them has no project and asks nothing.
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
            log::warn!("firebase unreachable: {}", error.without_url());
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

/// What Firebase Auth answered a password sign-in with. A field it left out is empty.
pub(crate) struct SignedIn {
    pub id_token: String,
    pub refresh_token: String,
    pub email: String,
    pub uid: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SignInRefusal {
    WrongEmailOrPassword,
    TurnedOff,
    TooManyTries,
    /// A code this kiosk has no name for.
    Other(String),
    Unreachable,
    /// A sign-in that worked, with no ID token in the answer.
    Unreadable,
}

pub(crate) async fn sign_in_with_password(
    client: &reqwest::Client,
    endpoints: &Endpoints,
    email: &str,
    password: &str,
) -> Result<SignedIn, SignInRefusal> {
    let signed = ask(client.post(&endpoints.sign_in).json(&serde_json::json!({
        "email": email, "password": password, "returnSecureToken": true,
    })))
    .await;
    let body = match signed {
        Answer::Ok(body) => body,
        Answer::Unreachable => return Err(SignInRefusal::Unreachable),
        // Firebase puts detail after the code: "TOO_MANY_ATTEMPTS_TRY_LATER : Access to this account…".
        Answer::Refused(_, code) => return Err(match code.split(' ').next().unwrap_or("") {
            "INVALID_LOGIN_CREDENTIALS" | "INVALID_PASSWORD" | "EMAIL_NOT_FOUND" | "INVALID_EMAIL" | "MISSING_PASSWORD" => {
                SignInRefusal::WrongEmailOrPassword
            }
            "USER_DISABLED" => SignInRefusal::TurnedOff,
            "TOO_MANY_ATTEMPTS_TRY_LATER" => SignInRefusal::TooManyTries,
            other => SignInRefusal::Other(other.to_string()),
        }),
    };
    let text = |name: &str| body.get(name).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let signed = SignedIn { id_token: text("idToken"), refresh_token: text("refreshToken"), email: text("email"), uid: text("localId") };
    if signed.id_token.is_empty() {
        return Err(SignInRefusal::Unreadable);
    }
    Ok(signed)
}

pub(crate) enum CountRefusal {
    Refused,
    Unreachable,
    Unreadable,
}

/// How many documents a structured query under the company's document matches.
pub(crate) async fn count(
    client: &reqwest::Client,
    endpoints: &Endpoints,
    id_token: &str,
    structured_query: serde_json::Value,
) -> Result<i64, CountRefusal> {
    let counted = ask(client
        .post(format!("{}:runAggregationQuery", endpoints.register))
        .bearer_auth(id_token)
        .json(&serde_json::json!({"structuredAggregationQuery": {
            "structuredQuery": structured_query,
            "aggregations": [{"alias": "n", "count": {}}],
        }})))
    .await;
    match counted {
        Answer::Ok(body) => body
            .get(0)
            .and_then(|first| first.pointer("/result/aggregateFields/n/integerValue"))
            // Firestore writes whole numbers as strings.
            .and_then(|n| n.as_str().and_then(|s| s.parse().ok()).or_else(|| n.as_i64()))
            .ok_or(CountRefusal::Unreadable),
        Answer::Refused(..) => Err(CountRefusal::Refused),
        Answer::Unreachable => Err(CountRefusal::Unreachable),
    }
}

/// A stand-in for Firebase on a loopback port, and a kiosk in a temporary
/// folder to point at it. Tests never ask the real project.
#[cfg(test)]
pub(crate) mod fake {
    use super::Endpoints;
    use crate::state::AppState;
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
}
