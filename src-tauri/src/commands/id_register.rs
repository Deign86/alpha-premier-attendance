use crate::state::AppState;
use super::session::Admin;
use tauri::State;

/// What Admin → Settings asks of the ID register connection.
pub(crate) enum RegisterAsk<'a> {
    Status,
    SignIn { email: &'a str, password: &'a str },
    SignOut,
    Check,
}

/// What the ID register panel shows: the register's connection, and the kiosk's backup beside it.
#[derive(Debug, serde::Serialize)]
pub(crate) struct IdRegisterPanel {
    #[serde(flatten)]
    register: crate::services::id_register::RegisterStatus,
    backup: crate::services::cloud_mirror::BackupStatus,
}

/// Every register command: administrator only, and each answers with where
/// the connection now stands. A check that fails is not an error here: the
/// problem is in the status, in plain words.
pub(crate) async fn id_register_impl(
    state: &AppState,
    token: &str,
    endpoints: Option<&crate::services::firebase::Endpoints>,
    ask: RegisterAsk<'_>,
) -> Result<IdRegisterPanel, String> {
    use crate::services::id_register;
    Admin::check(state, token).await?;
    match ask {
        RegisterAsk::Status => {}
        RegisterAsk::SignIn { email, password } => {
            id_register::sign_in(state, endpoints, email, password).await?;
        }
        RegisterAsk::SignOut => id_register::sign_out(&state.db).await,
        RegisterAsk::Check => {
            let _ = id_register::run_once(state, endpoints).await;
        }
    }
    Ok(IdRegisterPanel {
        register: id_register::status(state).await,
        backup: crate::services::cloud_mirror::status(state).await,
    })
}

#[tauri::command]
pub(crate) async fn id_register_status(state: State<'_, AppState>, token: String) -> Result<IdRegisterPanel, String> {
    id_register_impl(&state, &token, crate::services::firebase::built_in().as_ref(), RegisterAsk::Status).await
}

#[tauri::command]
pub(crate) async fn id_register_sign_in(
    state: State<'_, AppState>,
    token: String,
    email: String,
    password: String,
) -> Result<IdRegisterPanel, String> {
    let ask = RegisterAsk::SignIn { email: &email, password: &password };
    id_register_impl(&state, &token, crate::services::firebase::built_in().as_ref(), ask).await
}

#[tauri::command]
pub(crate) async fn id_register_sign_out(state: State<'_, AppState>, token: String) -> Result<IdRegisterPanel, String> {
    id_register_impl(&state, &token, crate::services::firebase::built_in().as_ref(), RegisterAsk::SignOut).await
}

#[tauri::command]
pub(crate) async fn id_register_check(state: State<'_, AppState>, token: String) -> Result<IdRegisterPanel, String> {
    id_register_impl(&state, &token, crate::services::firebase::built_in().as_ref(), RegisterAsk::Check).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::*;


    #[tokio::test]
    async fn id_register_commands_need_admin() {
        use RegisterAsk;
        let (state, temp, token) = admin_test_state("idreg-admin").await;
        let now = chrono::Utc::now().to_rfc3339();
        crate::services::settings::put(&state.db, "id_register_refresh_token", "refresh-1", &now).await.unwrap();
        crate::services::settings::put(&state.db, "id_register_email", "kiosk@example.test", &now).await.unwrap();
        let asks = || [
            RegisterAsk::Status,
            RegisterAsk::SignIn { email: "kiosk@example.test", password: "anything" },
            RegisterAsk::Check,
            RegisterAsk::SignOut,
        ];
        for ask in asks() {
            let refused = id_register_impl(&state, "wrong-token", None, ask).await;
            assert_eq!(refused.unwrap_err(), "ADMIN_AUTH_REQUIRED");
        }
        let kept: Option<String> = sqlx::query_scalar("SELECT value FROM app_settings WHERE key = 'id_register_refresh_token'")
            .fetch_optional(&state.db).await.unwrap();
        assert_eq!(kept.as_deref(), Some("refresh-1"), "a refused sign-out leaves the sign-in");

        // With the administrator's session each answers with where the connection stands.
        let status = id_register_impl(&state, &token, None, RegisterAsk::Status).await.unwrap();
        assert_eq!(status.register.signed_in_as.as_deref(), Some("kiosk@example.test"));
        let no_register = id_register_impl(&state, &token, None, RegisterAsk::SignIn { email: "kiosk@example.test", password: "anything" }).await;
        assert!(no_register.unwrap_err().contains("not built into"));
        let out = id_register_impl(&state, &token, None, RegisterAsk::SignOut).await.unwrap();
        assert_eq!(out.register.signed_in_as, None);
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }
}
