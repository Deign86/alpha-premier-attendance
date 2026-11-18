// The wrong-tries pause and the password hash, runnable on Windows without loading Tauri/WebView2.
// The shared PIN and its emailed reset code are gone (2026-11-18); their tests went with them.
// include!d app sources: items only the app (not this harness) uses are expected to be unused here.
#[allow(dead_code)]
mod services {
    #[allow(dead_code)]
    pub mod settings {
        include!("../src/services/settings.rs");
    }
    #[allow(dead_code)]
    pub mod unlock_guard {
        include!("../src/services/unlock_guard.rs");
    }
}

use chrono::{Duration, TimeZone, Utc};
use services::unlock_guard::*;
use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};

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

#[tokio::test]
async fn the_fifth_wrong_try_pauses_unlocking_for_five_minutes_on_a_bare_database() {
    let db = pool().await;
    assert!(!unlock_locked(&db, t0()).await.unwrap());
    for _ in 0..4 {
        assert!(!record_unlock_failure(&db, t0()).await.unwrap());
    }
    assert!(!unlock_locked(&db, t0()).await.unwrap(), "four wrong tries do not pause");
    assert!(record_unlock_failure(&db, t0()).await.unwrap(), "the fifth does");
    assert!(unlock_locked(&db, t0() + Duration::minutes(4)).await.unwrap());
    assert!(!unlock_locked(&db, t0() + Duration::minutes(5) + Duration::seconds(1)).await.unwrap());
}

#[tokio::test]
async fn getting_in_starts_the_count_again() {
    let db = pool().await;
    for _ in 0..4 {
        record_unlock_failure(&db, t0()).await.unwrap();
    }
    clear_unlock_failures(&db).await.unwrap();
    for _ in 0..4 {
        assert!(!record_unlock_failure(&db, t0()).await.unwrap());
    }
    assert!(record_unlock_failure(&db, t0()).await.unwrap());
}
