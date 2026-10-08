// Admin PIN reset rules, runnable on Windows without loading Tauri/WebView2.
mod services {
    #[allow(dead_code)] // mailer helpers are exercised only by the app
    pub mod admin_pin {
        include!("../src/services/admin_pin.rs");
    }
}

use chrono::{Duration, TimeZone, Utc};
use services::admin_pin::*;
use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};

const CONFIG_PIN: &str = "2468";

async fn pool() -> SqlitePool {
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap()
}

fn t0() -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 8, 1, 0, 0).unwrap()
}

/// begin + commit, as the request command does after a sent email.
async fn sent_code(db: &SqlitePool, at: chrono::DateTime<Utc>) -> String {
    let reset = begin_reset(db, at).await.unwrap();
    commit_reset(db, &reset, at).await.unwrap();
    reset.code
}

fn wrong(code: &str) -> &'static str {
    if code == "000000" { "111111" } else { "000000" }
}

#[test]
fn hash_round_trips_and_rejects_wrong_or_malformed_input() {
    let stored = hash_secret("482915").unwrap();
    assert!(stored.starts_with("pbkdf2-sha256$100000$"));
    assert!(!stored.contains("482915"));
    assert!(verify_secret(&stored, "482915"));
    assert!(!verify_secret(&stored, "482916"));
    assert!(!verify_secret("482915", "482915"));
    assert!(!verify_secret("pbkdf2-sha256$0$AA$AA", "482915"));
    assert_ne!(hash_secret("482915").unwrap(), stored, "salt must differ per hash");
}

#[test]
fn new_pin_must_be_6_to_12_digits_and_not_the_public_default() {
    assert!(validate_new_pin("482915").is_ok());
    assert!(validate_new_pin("123456789012").is_ok());
    for bad in ["12345", "1234567890123", "48a915", " 482915", "", "000000", "777777", "123456", "234567", "654321", "9876543"] {
        assert_eq!(validate_new_pin(bad).unwrap_err(), "INVALID_NEW_PIN", "{bad:?}");
    }
}

#[tokio::test]
async fn correct_code_stores_new_pin_hash_and_clears_the_code() {
    let db = pool().await;
    assert_eq!(effective_pin_hash(&db, Some(CONFIG_PIN)).await.unwrap(), None);
    let reset = begin_reset(&db, t0()).await.unwrap();
    assert_eq!(reset.code.len(), 6);
    assert!(reset.code.bytes().all(|b| b.is_ascii_digit()));
    assert_eq!(reset.request_id.len(), 6);
    commit_reset(&db, &reset, t0()).await.unwrap();

    complete_reset(&db, &reset.code, "482915", Some(CONFIG_PIN), t0() + Duration::minutes(5)).await.unwrap();
    let stored = effective_pin_hash(&db, Some(CONFIG_PIN)).await.unwrap().expect("pin hash stored");
    assert!(verify_secret(&stored, "482915"));
    assert!(!verify_secret(&stored, "482916"));
    // The code is single-use.
    assert_eq!(
        complete_reset(&db, &reset.code, "597531", Some(CONFIG_PIN), t0() + Duration::minutes(6)).await.unwrap_err(),
        "RESET_CODE_EXPIRED"
    );
}

#[tokio::test]
async fn changing_the_config_pin_after_a_reset_makes_the_config_pin_win() {
    let db = pool().await;
    let code = sent_code(&db, t0()).await;
    complete_reset(&db, &code, "482915", Some(CONFIG_PIN), t0()).await.unwrap();
    assert!(effective_pin_hash(&db, Some(CONFIG_PIN)).await.unwrap().is_some());
    assert_eq!(effective_pin_hash(&db, Some("135790")).await.unwrap(), None);
    // The stale emailed PIN is gone for good, even if the old config value returns.
    assert_eq!(effective_pin_hash(&db, Some(CONFIG_PIN)).await.unwrap(), None);
}

#[tokio::test]
async fn unsent_code_does_not_replace_the_code_already_emailed() {
    let db = pool().await;
    let first = sent_code(&db, t0()).await;
    // Second request whose email failed: begin_reset ran, commit_reset did not.
    let _unsent = begin_reset(&db, t0() + Duration::seconds(61)).await.unwrap();
    complete_reset(&db, &first, "482915", Some(CONFIG_PIN), t0() + Duration::seconds(62)).await.unwrap();
}

#[tokio::test]
async fn invalid_new_pin_does_not_spend_an_attempt() {
    let db = pool().await;
    let code = sent_code(&db, t0()).await;
    for _ in 0..10 {
        assert_eq!(complete_reset(&db, &code, "123456", Some(CONFIG_PIN), t0()).await.unwrap_err(), "INVALID_NEW_PIN");
    }
    complete_reset(&db, &code, "482915", Some(CONFIG_PIN), t0()).await.unwrap();
}

#[tokio::test]
async fn fifth_wrong_code_voids_the_code() {
    let db = pool().await;
    let code = sent_code(&db, t0()).await;
    for _ in 0..4 {
        assert_eq!(complete_reset(&db, wrong(&code), "482915", Some(CONFIG_PIN), t0()).await.unwrap_err(), "RESET_CODE_INVALID");
    }
    assert_eq!(complete_reset(&db, wrong(&code), "482915", Some(CONFIG_PIN), t0()).await.unwrap_err(), "RESET_CODE_EXPIRED");
    assert_eq!(complete_reset(&db, &code, "482915", Some(CONFIG_PIN), t0()).await.unwrap_err(), "RESET_CODE_EXPIRED");
    assert_eq!(effective_pin_hash(&db, Some(CONFIG_PIN)).await.unwrap(), None);
}

#[tokio::test]
async fn code_expires_after_fifteen_minutes() {
    let db = pool().await;
    let code = sent_code(&db, t0()).await;
    let late = t0() + Duration::minutes(CODE_TTL_MINUTES) + Duration::seconds(1);
    assert_eq!(complete_reset(&db, &code, "482915", Some(CONFIG_PIN), late).await.unwrap_err(), "RESET_CODE_EXPIRED");
    assert_eq!(effective_pin_hash(&db, Some(CONFIG_PIN)).await.unwrap(), None);
}

#[tokio::test]
async fn resend_waits_sixty_seconds_even_after_a_code_is_voided() {
    let db = pool().await;
    let code = sent_code(&db, t0()).await;
    for _ in 0..5 {
        let _ = complete_reset(&db, wrong(&code), "482915", Some(CONFIG_PIN), t0()).await;
    }
    assert_eq!(begin_reset(&db, t0() + Duration::seconds(59)).await.err().unwrap(), "RESET_RATE_LIMITED");
    let second = sent_code(&db, t0() + Duration::seconds(60)).await;
    complete_reset(&db, &second, "482915", Some(CONFIG_PIN), t0() + Duration::seconds(61)).await.unwrap();
}

#[tokio::test]
async fn ten_wrong_codes_in_a_day_block_new_requests_until_the_window_ends() {
    let db = pool().await;
    let mut at = t0();
    for _ in 0..2 {
        let code = sent_code(&db, at).await;
        for _ in 0..5 {
            let _ = complete_reset(&db, wrong(&code), "482915", Some(CONFIG_PIN), at).await;
        }
        at += Duration::seconds(61);
    }
    assert_eq!(begin_reset(&db, at).await.err().unwrap(), "RESET_LOCKED");
    assert_eq!(begin_reset(&db, t0() + Duration::hours(23)).await.err().unwrap(), "RESET_LOCKED");
    let code = sent_code(&db, t0() + Duration::hours(24)).await;
    complete_reset(&db, &code, "482915", Some(CONFIG_PIN), t0() + Duration::hours(24)).await.unwrap();
}

#[tokio::test]
async fn an_unset_config_pin_never_overrides_an_emailed_pin() {
    let db = pool().await;
    let code = sent_code(&db, t0()).await;
    // Reset on a kiosk whose config.toml has no admin_pin.
    complete_reset(&db, &code, "482915", None, t0()).await.unwrap();
    for config_pin in [None, Some("")] {
        let stored = effective_pin_hash(&db, config_pin).await.unwrap().expect("pin hash kept");
        assert!(verify_secret(&stored, "482915"));
    }
    // An explicit config.toml PIN added later does take over.
    assert_eq!(effective_pin_hash(&db, Some("135790")).await.unwrap(), None);
}
