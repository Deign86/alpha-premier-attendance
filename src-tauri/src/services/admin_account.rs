//! Opening the admin screens with a person's own Keystone account.
//!
//! Keystone is where accounts are made, turned off, reset and marked
//! "attendance admin" (apg-keystone, docs/adr/0030). This asks Firebase
//! whether the email and password are right, then reads the person's own
//! member document: the CEO (`role: owner`) and staff the CEO has ticked
//! (`attendanceAdmin: true`) get in. Admin RFID cards are a separate way in
//! (`setup_unlock_impl`) and are not touched here.
//!
//! - A sign-in that worked is remembered for seven days, as a slow hash of
//!   the password in `app_settings`, so an admin can get in while the
//!   internet is down. Settings never leave this computer.
//! - Anything Firebase or Keystone refuses forgets that memory at once.
//! - Wrong passwords count toward the same five-tries pause as wrong PINs.

use crate::services::admin_pin::{clear_unlock_failures, hash_secret, record_unlock_failure, unlock_locked, verify_secret};
use crate::services::id_register::{ask, http, Answer, Endpoints};
use crate::services::voice_pull::{read_setting, store_setting};
use chrono::{DateTime, Duration, Utc};
use sqlx::SqlitePool;
use std::collections::BTreeMap;

const REMEMBERED_KEY: &str = "admin_accounts";
/// How long a sign-in that worked online still opens with no internet.
pub const OFFLINE_DAYS: i64 = 7;

/// Why an account did not open the admin screens. `code` is what the screen maps to its sentence.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    /// This build has no Firebase project, so there are no accounts to ask about.
    NotAvailable,
    WrongEmailOrPassword,
    TurnedOff,
    /// A real account that the CEO has not made an attendance admin.
    NotAnAdmin,
    /// No internet, and this account has not signed in here in the last seven days.
    NeedsInternet,
    TooManyTries,
    /// Five wrong tries: paused, with the PIN, for five minutes.
    Paused,
    Other(String),
}

impl Refusal {
    pub fn code(&self) -> String {
        match self {
            Refusal::NotAvailable => "ACCOUNT_SIGN_IN_UNAVAILABLE".into(),
            Refusal::WrongEmailOrPassword => "INVALID_ACCOUNT".into(),
            Refusal::TurnedOff => "ACCOUNT_TURNED_OFF".into(),
            Refusal::NotAnAdmin => "NOT_ATTENDANCE_ADMIN".into(),
            Refusal::NeedsInternet => "ACCOUNT_NEEDS_INTERNET".into(),
            Refusal::TooManyTries => "ACCOUNT_TRY_LATER".into(),
            Refusal::Paused => "ADMIN_PIN_LOCKED".into(),
            Refusal::Other(detail) => detail.clone(),
        }
    }
}

/// Who got in, for the audit log.
#[derive(Debug, PartialEq, Eq)]
pub struct Opened {
    pub email: String,
    pub name: String,
    /// True when Firebase could not be reached and the remembered sign-in was used.
    pub offline: bool,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Remembered {
    password_hash: String,
    name: String,
    verified_at: DateTime<Utc>,
}

async fn remembered(db: &SqlitePool) -> BTreeMap<String, Remembered> {
    read_setting(db, REMEMBERED_KEY).await.and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

async fn keep(db: &SqlitePool, all: &BTreeMap<String, Remembered>, now: DateTime<Utc>) -> Result<(), String> {
    let text = serde_json::to_string(all).map_err(|e| e.to_string())?;
    store_setting(db, REMEMBERED_KEY, &text, &now.to_rfc3339()).await
}

async fn forget(db: &SqlitePool, email: &str, now: DateTime<Utc>) -> Result<(), String> {
    let mut all = remembered(db).await;
    if all.remove(email).is_some() {
        keep(db, &all, now).await?;
    }
    Ok(())
}

async fn wrong(db: &SqlitePool, now: DateTime<Utc>) -> Refusal {
    match record_unlock_failure(db, now).await {
        Ok(true) => Refusal::Paused,
        _ => Refusal::WrongEmailOrPassword,
    }
}

/// The remembered sign-in, when Firebase cannot be reached.
async fn open_offline(db: &SqlitePool, email: &str, password: &str, now: DateTime<Utc>) -> Result<Opened, Refusal> {
    let Some(known) = remembered(db).await.remove(email) else {
        return Err(Refusal::NeedsInternet);
    };
    if now - known.verified_at > Duration::days(OFFLINE_DAYS) || now < known.verified_at {
        return Err(Refusal::NeedsInternet);
    }
    if !verify_secret(&known.password_hash, password) {
        return Err(wrong(db, now).await);
    }
    Ok(Opened { email: email.to_string(), name: known.name, offline: true })
}

/// Checks an email and password and whether that person may open the admin screens.
pub async fn open(db: &SqlitePool, endpoints: Option<&Endpoints>, email: &str, password: &str, now: DateTime<Utc>) -> Result<Opened, Refusal> {
    let endpoints = endpoints.ok_or(Refusal::NotAvailable)?;
    let email = email.trim().to_lowercase();
    if email.is_empty() || password.is_empty() {
        return Err(Refusal::WrongEmailOrPassword);
    }
    let other = |e: String| Refusal::Other(e);
    // While paused nothing is checked, so a guess cannot be confirmed.
    if unlock_locked(db, now).await.map_err(other)? {
        return Err(Refusal::Paused);
    }
    let client = http().map_err(other)?;
    let signed = ask(client.post(&endpoints.sign_in).json(&serde_json::json!({
        "email": email, "password": password, "returnSecureToken": true,
    })))
    .await;
    let opened = match signed {
        Answer::Unreachable => open_offline(db, &email, password, now).await?,
        Answer::Refused(_, code) => {
            // Firebase puts detail after the code: "TOO_MANY_ATTEMPTS_TRY_LATER : Access to this account…".
            return Err(match code.split(' ').next().unwrap_or("") {
                "TOO_MANY_ATTEMPTS_TRY_LATER" => Refusal::TooManyTries,
                "USER_DISABLED" => {
                    forget(db, &email, now).await.map_err(other)?;
                    Refusal::TurnedOff
                }
                _ => {
                    // A password changed in Keystone must stop the old one here too.
                    forget(db, &email, now).await.map_err(other)?;
                    wrong(db, now).await
                }
            });
        }
        Answer::Ok(body) => {
            let text = |name: &str| body.get(name).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let (uid, id_token) = (text("localId"), text("idToken"));
            if uid.is_empty() || id_token.is_empty() {
                return Err(Refusal::Other("The sign-in gave an answer the kiosk could not read.".into()));
            }
            // The person's own member document, read as them: Keystone's rules let a member read members.
            match ask(client.get(format!("{}/members/{uid}", endpoints.register)).bearer_auth(&id_token)).await {
                Answer::Unreachable => open_offline(db, &email, password, now).await?,
                Answer::Refused(..) => {
                    // Signed in, but not a member of Keystone (or removed from it).
                    forget(db, &email, now).await.map_err(other)?;
                    return Err(Refusal::NotAnAdmin);
                }
                Answer::Ok(member) => {
                    let field = |name: &str, kind: &str| member.pointer(&format!("/fields/{name}/{kind}")).cloned();
                    let owner = field("role", "stringValue").and_then(|v| v.as_str().map(|s| s == "owner")).unwrap_or(false);
                    let ticked = field("attendanceAdmin", "booleanValue").and_then(|v| v.as_bool()).unwrap_or(false);
                    if !owner && !ticked {
                        forget(db, &email, now).await.map_err(other)?;
                        return Err(Refusal::NotAnAdmin);
                    }
                    let name = field("name", "stringValue").and_then(|v| v.as_str().map(str::to_string)).filter(|n| !n.trim().is_empty()).unwrap_or_else(|| email.clone());
                    let mut all = remembered(db).await;
                    all.insert(email.clone(), Remembered { password_hash: hash_secret(password).map_err(other)?, name: name.clone(), verified_at: now });
                    keep(db, &all, now).await.map_err(other)?;
                    Opened { email: email.clone(), name, offline: false }
                }
            }
        }
    };
    clear_unlock_failures(db).await.map_err(other)?;
    Ok(opened)
}

/// Asks Firebase to email the password reset link. Says nothing about whether the address has an account.
pub async fn send_reset(endpoints: Option<&Endpoints>, email: &str) -> Result<(), Refusal> {
    let endpoints = endpoints.ok_or(Refusal::NotAvailable)?;
    let email = email.trim();
    if email.is_empty() || !email.contains('@') {
        return Err(Refusal::WrongEmailOrPassword);
    }
    let client = http().map_err(Refusal::Other)?;
    match ask(client.post(&endpoints.send_code).json(&serde_json::json!({"requestType": "PASSWORD_RESET", "email": email}))).await {
        Answer::Unreachable => Err(Refusal::NeedsInternet),
        Answer::Refused(_, code) if code.starts_with("RESET_PASSWORD_EXCEED_LIMIT") || code.starts_with("TOO_MANY_ATTEMPTS_TRY_LATER") => Err(Refusal::TooManyTries),
        // An address with no account is answered like one that has: the email is simply never sent.
        Answer::Ok(_) | Answer::Refused(..) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::id_register::tests::{close, kiosk, nowhere, register, serve};

    const CEO: &str = "mark@example.test";
    const ANA: &str = "ana@example.test";
    const LIZA: &str = "liza@example.test";

    /// The CEO, Ana (staff the CEO ticked), Liza (staff, not ticked), and Sam, who has a sign-in but is no member.
    fn keystone() -> std::sync::Arc<std::sync::Mutex<crate::services::id_register::tests::Fake>> {
        let fake = register(vec![]);
        {
            let mut f = fake.lock().unwrap();
            f.people.insert(CEO, ("u-ceo", "ceo-password", None));
            f.people.insert(ANA, ("u-ana", "ana-password", None));
            f.people.insert(LIZA, ("u-liza", "liza-password", None));
            f.people.insert("sam@example.test", ("u-sam", "sam-password", None));
            f.members.insert("u-ceo", ("owner", "Mark Reyes", false));
            f.members.insert("u-ana", ("staff", "Ana Cruz", true));
            f.members.insert("u-liza", ("staff", "Liza Bautista", false));
        }
        fake
    }

    #[tokio::test]
    async fn admin_account_opens_for_the_ceo_and_ticked_staff_and_for_nobody_else() {
        let (state, temp) = kiosk("account-open").await;
        let (endpoints, server) = serve(keystone()).await;
        let (db, e, now) = (&state.db, Some(&endpoints), Utc::now());

        assert_eq!(open(db, e, CEO, "ceo-password", now).await, Ok(Opened { email: CEO.into(), name: "Mark Reyes".into(), offline: false }));
        // Typed with capitals and spaces, as people do.
        assert_eq!(open(db, e, "  Ana@Example.test ", "ana-password", now).await, Ok(Opened { email: ANA.into(), name: "Ana Cruz".into(), offline: false }));

        assert_eq!(open(db, e, LIZA, "liza-password", now).await, Err(Refusal::NotAnAdmin), "staff the CEO has not ticked");
        assert_eq!(open(db, e, "sam@example.test", "sam-password", now).await, Err(Refusal::NotAnAdmin), "a sign-in that is no member of Keystone");
        assert_eq!(open(db, e, ANA, "not-her-password", now).await, Err(Refusal::WrongEmailOrPassword));
        assert_eq!(open(db, e, "nobody@example.test", "x", now).await, Err(Refusal::WrongEmailOrPassword));
        assert_eq!(open(db, e, ANA, "", now).await, Err(Refusal::WrongEmailOrPassword));
        assert_eq!(open(db, None, ANA, "ana-password", now).await, Err(Refusal::NotAvailable), "a build with no Firebase project");

        // The password itself is nowhere in the database: only a slow hash, in settings.
        let kept = read_setting(db, REMEMBERED_KEY).await.unwrap();
        assert!(!kept.contains("ceo-password") && !kept.contains("ana-password"), "{kept}");
        assert!(kept.contains("pbkdf2") || kept.contains('$') || kept.len() > 100);
        assert!(!kept.contains(LIZA), "nothing is remembered for someone who did not get in");
        close(state, temp, server).await;
    }

    #[tokio::test]
    async fn admin_account_opens_offline_for_seven_days_after_a_sign_in_that_worked() {
        let (state, temp) = kiosk("account-offline").await;
        let (endpoints, server) = serve(keystone()).await;
        let offline = nowhere().await;
        let (db, day0) = (&state.db, Utc::now());

        // Never seen here: the internet is needed first.
        assert_eq!(open(db, Some(&offline), ANA, "ana-password", day0).await, Err(Refusal::NeedsInternet));
        open(db, Some(&endpoints), ANA, "ana-password", day0).await.unwrap();

        let day6 = day0 + Duration::days(6);
        assert_eq!(open(db, Some(&offline), ANA, "ana-password", day6).await, Ok(Opened { email: ANA.into(), name: "Ana Cruz".into(), offline: true }));
        assert_eq!(open(db, Some(&offline), ANA, "a-guess", day6).await, Err(Refusal::WrongEmailOrPassword));
        assert_eq!(open(db, Some(&offline), CEO, "ceo-password", day6).await, Err(Refusal::NeedsInternet), "the CEO never signed in on this kiosk");

        let day8 = day0 + Duration::days(8);
        assert_eq!(open(db, Some(&offline), ANA, "ana-password", day8).await, Err(Refusal::NeedsInternet), "seven days, not eight");
        // A clock set back does not stretch the seven days.
        assert_eq!(open(db, Some(&offline), ANA, "ana-password", day0 - Duration::days(1)).await, Err(Refusal::NeedsInternet));

        // Online again on day 8: the seven days start over.
        open(db, Some(&endpoints), ANA, "ana-password", day8).await.unwrap();
        assert!(open(db, Some(&offline), ANA, "ana-password", day8 + Duration::days(6)).await.is_ok());
        close(state, temp, server).await;
    }

    #[tokio::test]
    async fn admin_account_taken_away_in_keystone_stops_opening_here_online_and_offline() {
        let (state, temp) = kiosk("account-removed").await;
        let fake = keystone();
        let (endpoints, server) = serve(fake.clone()).await;
        let offline = nowhere().await;
        let (db, now) = (&state.db, Utc::now());

        // The tick is taken away.
        open(db, Some(&endpoints), ANA, "ana-password", now).await.unwrap();
        fake.lock().unwrap().members.insert("u-ana", ("staff", "Ana Cruz", false));
        assert_eq!(open(db, Some(&endpoints), ANA, "ana-password", now).await, Err(Refusal::NotAnAdmin));
        assert_eq!(open(db, Some(&offline), ANA, "ana-password", now).await, Err(Refusal::NeedsInternet), "and the remembered sign-in is gone");

        // The account is removed from Keystone's members.
        fake.lock().unwrap().members.insert("u-ana", ("staff", "Ana Cruz", true));
        open(db, Some(&endpoints), ANA, "ana-password", now).await.unwrap();
        fake.lock().unwrap().members.remove("u-ana");
        assert_eq!(open(db, Some(&endpoints), ANA, "ana-password", now).await, Err(Refusal::NotAnAdmin));
        assert_eq!(open(db, Some(&offline), ANA, "ana-password", now).await, Err(Refusal::NeedsInternet));

        // The account is turned off in Firebase.
        open(db, Some(&endpoints), CEO, "ceo-password", now).await.unwrap();
        fake.lock().unwrap().people.insert(CEO, ("u-ceo", "ceo-password", Some("USER_DISABLED")));
        assert_eq!(open(db, Some(&endpoints), CEO, "ceo-password", now).await, Err(Refusal::TurnedOff));
        assert_eq!(open(db, Some(&offline), CEO, "ceo-password", now).await, Err(Refusal::NeedsInternet));

        // The password is changed in Keystone: the old one stops here too, even offline.
        fake.lock().unwrap().members.insert("u-ana", ("staff", "Ana Cruz", true));
        open(db, Some(&endpoints), ANA, "ana-password", now).await.unwrap();
        fake.lock().unwrap().people.insert(ANA, ("u-ana", "a-new-password", None));
        assert_eq!(open(db, Some(&endpoints), ANA, "ana-password", now).await, Err(Refusal::WrongEmailOrPassword));
        assert_eq!(open(db, Some(&offline), ANA, "ana-password", now).await, Err(Refusal::NeedsInternet));
        assert!(open(db, Some(&endpoints), ANA, "a-new-password", now).await.is_ok());

        // Firebase asking to slow down forgets nothing.
        fake.lock().unwrap().people.insert(ANA, ("u-ana", "a-new-password", Some("TOO_MANY_ATTEMPTS_TRY_LATER : Access to this account has been temporarily disabled.")));
        assert_eq!(open(db, Some(&endpoints), ANA, "a-new-password", now).await, Err(Refusal::TooManyTries));
        assert!(open(db, Some(&offline), ANA, "a-new-password", now).await.is_ok());
        close(state, temp, server).await;
    }

    #[tokio::test]
    async fn admin_account_five_wrong_passwords_pause_it_for_five_minutes() {
        let (state, temp) = kiosk("account-paused").await;
        let fake = keystone();
        let (endpoints, server) = serve(fake.clone()).await;
        let (db, e, now) = (&state.db, Some(&endpoints), Utc::now());

        for _ in 0..4 {
            assert_eq!(open(db, e, ANA, "a-guess", now).await, Err(Refusal::WrongEmailOrPassword));
        }
        assert_eq!(open(db, e, ANA, "a-guess", now).await, Err(Refusal::Paused), "the fifth");
        // Paused: even the right password is not checked, and Firebase is not asked.
        fake.lock().unwrap().asked.clear();
        assert_eq!(open(db, e, ANA, "ana-password", now + Duration::minutes(4)).await, Err(Refusal::Paused));
        assert!(fake.lock().unwrap().asked.is_empty());
        // The PIN is paused with it: it is one guard.
        assert!(unlock_locked(db, now + Duration::minutes(4)).await.unwrap());

        assert!(open(db, e, ANA, "ana-password", now + Duration::minutes(6)).await.is_ok());
        // Getting in clears the count.
        for _ in 0..4 {
            assert_eq!(open(db, e, ANA, "a-guess", now + Duration::minutes(7)).await, Err(Refusal::WrongEmailOrPassword));
        }
        close(state, temp, server).await;
    }

    #[tokio::test]
    async fn admin_account_forgot_password_asks_firebase_and_tells_nothing_about_the_address() {
        let (state, temp) = kiosk("account-reset").await;
        let fake = keystone();
        let (endpoints, server) = serve(fake.clone()).await;

        assert_eq!(send_reset(Some(&endpoints), " ana@example.test ").await, Ok(()));
        assert_eq!(send_reset(Some(&endpoints), "nobody@example.test").await, Ok(()), "the same answer for an address with no account");
        assert_eq!(fake.lock().unwrap().reset_asked, vec!["ana@example.test", "nobody@example.test"]);

        assert_eq!(send_reset(Some(&endpoints), "not an address").await, Err(Refusal::WrongEmailOrPassword));
        assert_eq!(send_reset(Some(&nowhere().await), ANA).await, Err(Refusal::NeedsInternet));
        assert_eq!(send_reset(None, ANA).await, Err(Refusal::NotAvailable));
        assert_eq!(fake.lock().unwrap().reset_asked.len(), 2, "nothing more was asked");
        close(state, temp, server).await;
    }
}
