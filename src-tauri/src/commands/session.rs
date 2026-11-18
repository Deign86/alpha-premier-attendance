use crate::state::AdminSession;
use crate::state::AppState;
use tauri::State;

pub(crate) async fn setup_unlock_impl(
    state: &AppState,
    card_or_code: String,
) -> Result<serde_json::Value, String> {
    // config.toml `admin_pin = ""` stays the off switch.
    if state.lan.admin_code.as_deref() == Some("") {
        return Err("ADMIN_DISABLED".into());
    }
    let configured = state.lan.admin_code.as_deref();
    let typed = card_or_code.trim();
    let now = chrono::Utc::now();
    // While locked out nothing typed is checked, so a guess cannot be confirmed.
    let typing_paused = crate::services::unlock_guard::unlock_locked(&state.db, now).await?;
    // There is no shared PIN any more. What is typed opens the admin screens only when it is an admin card's number
    // or IT's way back: an explicit `admin_pin` in config.toml on this kiosk. A PIN once set by email is ignored.
    let is_code_match = !typing_paused && configured.is_some_and(|code| !typed.is_empty() && code == typed);
    let mut is_admin_card_match = false;
    if !is_code_match {
        let uid = typed.to_ascii_uppercase();
        let row = sqlx::query(
            "SELECT user_id FROM users WHERE (rfid_uid = ? OR user_id = ?) AND status = 'ACTIVE' AND card_type = 'ADMIN_ASSIST'",
        )
        .bind(&uid)
        .bind(typed)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| e.to_string())?;
        is_admin_card_match = row.is_some();
    }
    if !is_code_match && !is_admin_card_match {
        if typing_paused || crate::services::unlock_guard::record_unlock_failure(&state.db, now).await? {
            return Err("ADMIN_PIN_LOCKED".into());
        }
        return Err("INVALID_ADMIN_PIN".into());
    }
    crate::services::unlock_guard::clear_unlock_failures(&state.db).await?;
    Ok(open_admin_session(state).await)
}

/// Starts the admin session a card, IT's code or an account has just earned.
pub(crate) async fn open_admin_session(state: &AppState) -> serde_json::Value {
    let token = uuid::Uuid::new_v4().to_string();
    let expires = std::time::Instant::now()
        + std::time::Duration::from_secs(state.lan.admin_session_minutes * 60);
    *state.admin_session.lock().await = Some(AdminSession {
        token: token.clone(),
        expires_at: expires,
    });
    serde_json::json!({"success":true,"token":token,"expiresAt":chrono::Utc::now() + chrono::Duration::minutes(state.lan.admin_session_minutes as i64)})
}

/// Opens the admin screens with a person's own Keystone account (`services/admin_account.rs`).
pub(crate) async fn admin_account_unlock_impl(
    state: &AppState,
    endpoints: Option<&crate::services::firebase::Endpoints>,
    email: &str,
    password: &str,
) -> Result<serde_json::Value, String> {
    // config.toml `admin_pin = ""` stays the off switch for every way in but a card.
    if state.lan.admin_code.as_deref() == Some("") {
        return Err("ADMIN_DISABLED".into());
    }
    let opened = crate::services::admin_account::open(&state.db, endpoints, email, password, chrono::Utc::now())
        .await
        .map_err(|refusal| refusal.code())?;
    let how = if opened.offline { " (no internet: the sign-in remembered on this kiosk)" } else { "" };
    audit_session_event(state, "ADMIN_ACCOUNT_UNLOCK", &format!("Admin screens opened by {} <{}>{how}", opened.name, opened.email)).await;
    let mut session = open_admin_session(state).await;
    session["name"] = serde_json::json!(opened.name);
    Ok(session)
}

#[tauri::command]
pub(crate) async fn admin_account_unlock(state: State<'_, AppState>, email: String, password: String) -> Result<serde_json::Value, String> {
    admin_account_unlock_impl(&state, crate::services::firebase::built_in().as_ref(), &email, &password).await
}

#[tauri::command]
/// Forgot password: Firebase emails the reset link to the address, if it has an account.
pub(crate) async fn admin_account_reset(state: State<'_, AppState>, email: String) -> Result<serde_json::Value, String> {
    crate::services::admin_account::send_reset(crate::services::firebase::built_in().as_ref(), &email)
        .await
        .map_err(|refusal| refusal.code())?;
    audit_session_event(&state, "ADMIN_ACCOUNT_RESET_REQUESTED", "A password reset email was asked for from the admin sign-in screen").await;
    Ok(serde_json::json!({"success": true}))
}

#[tauri::command]
pub(crate) async fn setup_unlock(
    state: State<'_, AppState>,
    // The argument's name is what the client and the scripts send; it carries a card ID or IT's code.
    pin: String,
) -> Result<serde_json::Value, String> {
    setup_unlock_impl(&state, pin).await
}

#[tauri::command]
pub(crate) async fn setup_lock(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    *state.admin_session.lock().await = None;
    Ok(serde_json::json!({"success":true}))
}

pub(crate) async fn audit_session_event(state: &AppState, event_type: &str, message: &str) {
    crate::services::audit::log(&state.db, crate::services::audit::Entry::new(event_type, &chrono::Utc::now().to_rfc3339(), message, &uuid::Uuid::new_v4().to_string())).await;
}

#[tauri::command]
pub(crate) async fn admin_get_session(
    state: State<'_, AppState>,
    token: String,
) -> Result<serde_json::Value, String> {
    Admin::check_as(&state, &token, "ADMIN_SESSION_EXPIRED").await?;
    Ok(serde_json::json!({"success":true}))
}

/// Proof that the caller holds the live admin session: only [`Admin::check`] makes one. A function that does an
/// admin-only command's work takes `&Admin`, so calling it without the check does not compile. A command that
/// does its work in its own body is not covered by that: for those,
/// `commands::tests::every_command_checks_the_admin_session_or_is_listed_as_public` still fails for a command
/// that neither checks nor is on the public list.
pub(crate) struct Admin(());

impl Admin {
    /// `Err("ADMIN_AUTH_REQUIRED")` unless `token` is the live admin session.
    pub(crate) async fn check(state: &AppState, token: &str) -> Result<Admin, String> {
        Self::check_as(state, token, "ADMIN_AUTH_REQUIRED").await
    }

    /// The same check for the three commands that have always refused with another code.
    pub(crate) async fn check_as(state: &AppState, token: &str, refusal: &'static str) -> Result<Admin, String> {
        if admin_authorized(state, token).await {
            Ok(Admin(()))
        } else {
            Err(refusal.into())
        }
    }
}

/// Whether `token` is the live admin session. Commands go through [`Admin::check`].
pub(crate) async fn admin_authorized(state: &AppState, token: &str) -> bool {
    let mut session = state.admin_session.lock().await;
    let Some(value) = session.as_ref() else {
        return false;
    };
    // Only an expired session is cleared. A stale or empty token is just
    // refused: clearing on any mismatch let one request still carrying an
    // old token log out the admin who had just unlocked (S7).
    if value.expires_at <= std::time::Instant::now() {
        *session = None;
        return false;
    }
    value.token == token
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::*;
    use crate::services::users::upsert_user_record;

    #[tokio::test]
    async fn typing_is_paused_after_five_wrong_tries_and_the_pause_survives_a_restart() {
        let temp = std::env::temp_dir().join(format!("alpha-pin-lockout-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        let open = || {
            let temp = temp.clone();
            async move {
                let mut lan = LanConfig::default();
                lan.admin_code = Some("2468".to_string());
                lan.admin_session_minutes = 30;
                AppState::new(
                    temp.clone(),
                    temp.join("attendance.db"),
                    temp.join("exports"),
                    false,
                    lan,
                    OfficeConfig::default(),
                    crate::config::ScannerConfig::default(),
                    crate::config::TtsConfig::default(),
                    crate::config::UpdaterConfig::default(),
                )
                .await
                .unwrap()
            }
        };
        let state = open().await;
        for attempt in 1..=4 {
            let err = setup_unlock_impl(&state, "0000".to_string()).await.unwrap_err();
            assert_eq!(err, "INVALID_ADMIN_PIN", "attempt {attempt}");
        }
        // The fifth wrong PIN starts the lock, and then even the right PIN is refused.
        assert_eq!(setup_unlock_impl(&state, "0000".to_string()).await.unwrap_err(), "ADMIN_PIN_LOCKED");
        assert_eq!(setup_unlock_impl(&state, "2468".to_string()).await.unwrap_err(), "ADMIN_PIN_LOCKED");
        state.db.close().await;

        // Restarting the app does not lift it.
        let state = open().await;
        assert_eq!(setup_unlock_impl(&state, "2468".to_string()).await.unwrap_err(), "ADMIN_PIN_LOCKED");

        // Five minutes on (stored lock moved into the past), the right PIN works.
        sqlx::query("UPDATE app_settings SET value = json_set(value, '$.lockedUntil', '2000-01-01T00:00:00Z') WHERE key = 'admin_unlock_guard'")
            .execute(&state.db)
            .await
            .unwrap();
        assert_eq!(setup_unlock_impl(&state, "2468".to_string()).await.unwrap()["success"], true);
        // A success starts the count again: one wrong PIN is just wrong.
        assert_eq!(setup_unlock_impl(&state, "0000".to_string()).await.unwrap_err(), "INVALID_ADMIN_PIN");

        // An admin card is not a PIN guess and still unlocks during a lock.
        upsert_user_record(
            &state.db, "ADMIN_CARD", "ADC0DE01", "Front Desk", None, "ACTIVE", "INTERN",
            None, None, None, None, "ADMIN_ASSIST", "2026-08-01T00:00:00Z",
        )
        .await
        .unwrap();
        for _ in 0..5 {
            let _ = setup_unlock_impl(&state, "0000".to_string()).await;
        }
        assert_eq!(setup_unlock_impl(&state, "2468".to_string()).await.unwrap_err(), "ADMIN_PIN_LOCKED");
        assert_eq!(setup_unlock_impl(&state, "ADC0DE01".to_string()).await.unwrap()["success"], true);
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[tokio::test]
    async fn the_admin_screens_open_with_its_code_or_an_admin_card() {
        let temp = std::env::temp_dir().join(format!("alpha-admin-unlock-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(temp.join("exports")).unwrap();
        let data_dir = temp.clone();
        let exports_dir = temp.join("exports");
        let mut lan = LanConfig::default();
        lan.admin_code = Some("2468".to_string());
        lan.admin_session_minutes = 15;
        let state = AppState::new(
            data_dir.clone(),
            data_dir.join("attendance.db"),
            exports_dir.clone(),
            false,
            lan,
            OfficeConfig::default(),
            crate::config::ScannerConfig::default(),
            crate::config::TtsConfig::default(),
            crate::config::UpdaterConfig::default(),
        )
        .await
        .unwrap();

        // Insert an admin assist card and a regular employee card
        upsert_user_record(
            &state.db,
            "ADMIN_CARD_ADDE23",
            "ADDE23",
            "Front Desk Admin",
            Some("Admin"),
            "ACTIVE",
            "EMPLOYEE",
            None,
            None,
            None,
            None,
            "ADMIN_ASSIST",
            "2026-08-27T00:00:00Z",
        )
        .await
        .unwrap();

        upsert_user_record(
            &state.db,
            "EMP_REGULAR",
            "EEFF00",
            "Regular Employee",
            Some("Engineering"),
            "ACTIVE",
            "EMPLOYEE",
            Some("MALE"),
            Some(50_000),
            Some("BEA_STANDARD"),
            None,
            "EMPLOYEE",
            "2026-08-27T00:00:00Z",
        )
        .await
        .unwrap();

        // 1. PIN unlock works
        let res_pin = setup_unlock_impl(&state, "2468".to_string()).await;
        assert!(res_pin.is_ok(), "Configured PIN should unlock admin session");

        // 2. Admin RFID unlock works
        let res_rfid = setup_unlock_impl(&state, "ADDE23".to_string()).await;
        assert!(res_rfid.is_ok(), "Admin RFID card should unlock admin session");

        // 3. Regular employee RFID is rejected
        let res_emp = setup_unlock_impl(&state, "EEFF00".to_string()).await;
        assert_eq!(res_emp.unwrap_err(), "INVALID_ADMIN_PIN");

        // 4. Unknown string is rejected
        let res_wrong = setup_unlock_impl(&state, "WRONG_PASS".to_string()).await;
        assert_eq!(res_wrong.unwrap_err(), "INVALID_ADMIN_PIN");

        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[tokio::test]
    async fn a_pin_once_set_by_email_opens_nothing_and_cards_and_the_config_way_back_still_do() {
        let temp = std::env::temp_dir().join(format!("alpha-admin-pin-reset-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(temp.join("exports")).unwrap();
        async fn open(temp: &std::path::Path, admin_pin: Option<&str>) -> AppState {
            let mut lan = LanConfig::default();
            lan.admin_code = admin_pin.map(str::to_string);
            AppState::new(
                temp.to_path_buf(),
                temp.join("attendance.db"),
                temp.join("exports"),
                false,
                lan,
                OfficeConfig::default(),
                crate::config::ScannerConfig::default(),
                crate::config::TtsConfig::default(),
                crate::config::UpdaterConfig::default(),
            )
            .await
            .unwrap()
        }
        let state = open(&temp, Some("2468")).await;
        for (user_id, uid, card_type) in [("ADMIN_CARD_ADDE23", "ADDE23", "ADMIN_ASSIST"), ("INT_REGULAR", "EEFF00", "EMPLOYEE")] {
            upsert_user_record(
                &state.db, user_id, uid, "Card Holder", Some("Admin"), "ACTIVE", "INTERN",
                None, None, None, None, card_type, "2026-10-08T00:00:00Z",
            )
            .await
            .unwrap();
        }

        // A kiosk that once had a PIN set through the emailed code (v0.2.53 and before) still holds its hash. It is
        // left where it is and opens nothing: that PIN is gone.
        let emailed = crate::services::unlock_guard::hash_secret("482915").unwrap();
        for (key, value) in [("admin_pin_hash", emailed.as_str()), ("admin_pin_config_fingerprint", "anything")] {
            sqlx::query("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, '2026-10-08T00:00:00Z')").bind(key).bind(value).execute(&state.db).await.unwrap();
        }
        assert_eq!(setup_unlock_impl(&state, "482915".to_string()).await.unwrap_err(), "INVALID_ADMIN_PIN");
        let kept: Option<String> = sqlx::query_scalar("SELECT value FROM app_settings WHERE key = 'admin_pin_hash'").fetch_optional(&state.db).await.unwrap();
        assert_eq!(kept.as_deref(), Some(emailed.as_str()), "nothing on the kiosk is deleted by the update");

        // IT's way back, an explicit admin_pin in config.toml, and admin cards still open.
        assert!(setup_unlock_impl(&state, " 2468 ".to_string()).await.is_ok());
        assert!(state.admin_session.lock().await.is_some());
        assert!(setup_unlock_impl(&state, "ADDE23".to_string()).await.is_ok(), "admin card still unlocks");
        assert!(setup_unlock_impl(&state, "ADMIN_CARD_ADDE23".to_string()).await.is_ok());
        assert_eq!(setup_unlock_impl(&state, "EEFF00".to_string()).await.unwrap_err(), "INVALID_ADMIN_PIN", "an employee's card is not an admin card");
        state.db.close().await;

        // admin_pin = "" in config.toml still turns admin off, for cards and accounts alike.
        let state = open(&temp, Some("")).await;
        assert_eq!(setup_unlock_impl(&state, "ADDE23".to_string()).await.unwrap_err(), "ADMIN_DISABLED");
        assert_eq!(admin_account_unlock_impl(&state, None, "ana@example.test", "x").await.unwrap_err(), "ADMIN_DISABLED");
        state.db.close().await;

        // With no admin_pin in config.toml (as the kiosk ships) nothing typed opens: only a card, or an account.
        let state = open(&temp, None).await;
        for attempt in ["482915", "2468", ""] {
            assert_eq!(setup_unlock_impl(&state, attempt.to_string()).await.unwrap_err(), "INVALID_ADMIN_PIN", "{attempt:?}");
        }
        assert!(setup_unlock_impl(&state, "ADDE23".to_string()).await.is_ok(), "card unlocks with no PIN anywhere");
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[tokio::test]
    async fn admin_session_survives_a_request_with_a_stale_token() {
        // S7 (confirmed): a request with an old or empty token cleared the
        // live session, logging out whoever had just unlocked.
        let (state, temp, token) = admin_test_state("stale-token").await;
        assert!(!admin_authorized(&state, "old-token").await);
        assert!(!admin_authorized(&state, "").await);
        assert!(admin_authorized(&state, &token).await, "the live session must survive");
        // An expired session is still cleared.
        state.admin_session.lock().await.as_mut().unwrap().expires_at = std::time::Instant::now();
        assert!(!admin_authorized(&state, &token).await);
        assert!(state.admin_session.lock().await.is_none());
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    /// Through the command's own path: an account that may, gets a session the admin commands accept and a line in
    /// the audit log with their name; one that may not, gets neither; and a pause never stops an admin card.
    #[tokio::test]
    async fn admin_account_unlock_opens_a_named_session_and_a_card_still_works_while_paused() {
        use crate::services::firebase::fake::{close, kiosk, register, serve};
        let (state, temp) = kiosk("account-session").await;
        let fake = register(vec![]);
        {
            let mut f = fake.lock().unwrap();
            f.people.insert("ana@example.test", ("u-ana", "ana-password", None));
            f.people.insert("liza@example.test", ("u-liza", "liza-password", None));
            f.members.insert("u-ana", ("staff", "Ana Cruz", true));
            f.members.insert("u-liza", ("staff", "Liza Bautista", false));
        }
        let (endpoints, server) = serve(fake).await;

        let refused = admin_account_unlock_impl(&state, Some(&endpoints), "liza@example.test", "liza-password").await;
        assert_eq!(refused.unwrap_err(), "NOT_ATTENDANCE_ADMIN");
        assert!(state.admin_session.lock().await.is_none(), "a refusal opens nothing");

        let opened = admin_account_unlock_impl(&state, Some(&endpoints), "ana@example.test", "ana-password").await.unwrap();
        let token = opened["token"].as_str().unwrap().to_string();
        assert_eq!(opened["name"], "Ana Cruz");
        assert!(admin_authorized(&state, &token).await);
        assert!(!admin_authorized(&state, "another-token").await);
        let logged: Vec<String> = sqlx::query_scalar("SELECT message FROM audit_logs WHERE event_type = 'ADMIN_ACCOUNT_UNLOCK'").fetch_all(&state.db).await.unwrap();
        assert_eq!(logged, vec!["Admin screens opened by Ana Cruz <ana@example.test>".to_string()]);
        let everything: Vec<String> = sqlx::query_scalar("SELECT message FROM audit_logs").fetch_all(&state.db).await.unwrap();
        assert!(everything.iter().all(|line| !line.contains("ana-password")), "a password is never logged");

        // Five wrong passwords pause accounts and the PIN. An admin card is not a guess and still opens.
        upsert_user_record(&state.db, "ADMIN-1", "ADM1N001", "Front Desk", Some("HR"), "ACTIVE", "INTERN", None, None, None, None, "ADMIN_ASSIST", "2026-08-01T00:00:00Z").await.unwrap();
        for _ in 0..5 {
            let _ = admin_account_unlock_impl(&state, Some(&endpoints), "ana@example.test", "a-guess").await;
        }
        assert_eq!(admin_account_unlock_impl(&state, Some(&endpoints), "ana@example.test", "ana-password").await.unwrap_err(), "ADMIN_PIN_LOCKED");
        let by_card = setup_unlock_impl(&state, "ADM1N001".to_string()).await.unwrap();
        assert_eq!(by_card["success"], true);
        close(state, temp, server).await;
    }

    #[tokio::test]
    async fn concurrent_wrong_tries_still_reach_the_pause() {
        // Same race on the D1 wrong-PIN counter.
        let (state, temp, _token) = admin_test_state("pin-race").await;
        let now = chrono::Utc::now();
        let wrong: Vec<_> = (0..5)
            .map(|_| crate::services::unlock_guard::record_unlock_failure(&state.db, now))
            .collect();
        futures_util::future::join_all(wrong).await;
        assert!(crate::services::unlock_guard::unlock_locked(&state.db, now).await.unwrap(), "five wrong PINs lock, however they interleave");
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }
}
