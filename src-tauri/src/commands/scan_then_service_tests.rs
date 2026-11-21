//! Tests that tap a card through the scan command and then run a service on what the tap left: the ID register's
//! pass and the backup. They live with the commands because a service does not import the command layer.

use super::kiosk::scan_rfid_impl;
use crate::services::cloud_mirror::tests::{add_user, everything, named};
use crate::services::cloud_mirror::{status, DOCUMENTS_A_PAGE, NOT_READABLE};
use crate::services::firebase::fake::{close, intern, kiosk, register, serve, PASSWORD};
use crate::services::id_register::tests::card_of;
use crate::services::id_register::{self, run_once, sign_in};
use crate::services::users;

#[tokio::test]
async fn id_register_waiting_user_takes_a_card_and_scans() {
    let (state, temp) = kiosk("binds").await;
    let fake = register(vec![intern("APG-2026-126", "Juan Dela Cruz")]);
    let (endpoints, server) = serve(fake.clone()).await;
    sign_in(&state, Some(&endpoints), "kiosk@example.test", PASSWORD).await.unwrap();

    // No reader, and no typed scan, can stand in for a card that is not there yet.
    let placeholder = serde_json::json!({"rfidUid": "PENDING-APG-2026-126", "source": "RFID"});
    let refused = scan_rfid_impl(None, &state, placeholder).await.unwrap();
    assert_eq!(refused["error"]["code"], "INVALID_SCAN_INPUT");

    // Admin → Users: the same user saved with the card just tapped.
    users::save_user(
        &state,
        serde_json::json!({"userId": "APG-2026-126", "rfidUid": "a1b2c3d4", "fullName": "Juan Dela Cruz", "department": "IT Intern", "status": "ACTIVE", "employeeType": "INTERN"}),
        users::SaveOrigin::Administrator,
    )
    .await
    .unwrap();
    // One row: the waiting user is changed, not doubled.
    let cards: Vec<String> = sqlx::query_scalar("SELECT rfid_uid FROM users").fetch_all(&state.db).await.unwrap();
    assert_eq!(cards, vec!["A1B2C3D4".to_string()]);
    assert_eq!(id_register::status(&state).await.waiting, 0);

    let tap = scan_rfid_impl(None, &state, serde_json::json!({"rfidUid": "A1B2C3D4", "source": "RFID"})).await.unwrap();
    assert_eq!(tap["success"], true, "{tap}");
    // The next pass leaves the card alone.
    fake.lock().unwrap().cards.push(intern("APG-2026-127", "Ana Reyes"));
    run_once(&state, Some(&endpoints)).await.unwrap();
    assert_eq!(card_of(&state, "APG-2026-126").await.as_deref(), Some("A1B2C3D4"));
    close(state, temp, server).await;
}

#[tokio::test]
async fn cloud_backup_sends_each_record_once_then_only_what_changed() {
    let (state, temp) = kiosk("backup").await;
    add_user(&state, "APG-2026-101", "ABCD1234", "Juan Dela Cruz").await;
    sqlx::query("UPDATE users SET tin = '123-456-789' WHERE user_id = 'APG-2026-101'").execute(&state.db).await.unwrap();
    let tap = scan_rfid_impl(None, &state, serde_json::json!({"rfidUid": "ABCD1234", "source": "RFID"})).await.unwrap();
    assert_eq!(tap["success"], true, "{tap}");
    let fake = register(vec![]);
    let (endpoints, server) = serve(fake.clone()).await;
    sign_in(&state, Some(&endpoints), "kiosk@example.test", PASSWORD).await.unwrap();

    let before = status(&state).await;
    assert!(before.records >= 2 && before.backed_up == 0, "{before:?}");
    run_once(&state, Some(&endpoints)).await.unwrap();

    let written: Vec<serde_json::Value> = fake.lock().unwrap().written.concat();
    assert_eq!(written.len() as i64, before.records, "one write for each covered record");
    // The TIN goes apart, with the key it belongs to and nothing else.
    let apart = written.iter().find(|write| named(write) == "attprivate_users/APG-2026-101").expect("the TIN is sent apart");
    assert_eq!(apart["update"]["fields"], serde_json::json!({"user_id": {"stringValue": "APG-2026-101"}, "tin": {"stringValue": "123-456-789"}, "account_number": {"stringValue": "0000"}}), "0000 is what a person without a bank account has");
    let open_to_owner_screens: Vec<&serde_json::Value> = written.iter().filter(|write| named(write).starts_with("att_")).collect();
    assert!(!serde_json::to_string(&open_to_owner_screens).unwrap().contains("123-456-789"), "and never in att_…");
    let user = written.iter().find(|write| named(write) == "att_users/APG-2026-101").expect("the user is sent");
    let fields = &user["update"]["fields"];
    assert_eq!(fields["full_name"], serde_json::json!({"stringValue": "Juan Dela Cruz"}));
    assert_eq!(fields["daily_rate_centavos"], serde_json::json!({"integerValue": "50000"}), "a number stays a number");
    assert_eq!(fields["gender"], serde_json::json!({"nullValue": null}), "an empty value stays empty");
    assert!(fields.get("tin").is_none() && fields.get("account_number").is_none(), "a TIN or an account number is not in the person's own record");
    assert!(written.iter().any(|write| named(write).starts_with("att_attendance/")), "the tap is sent");
    assert!(written.iter().any(|write| named(write).starts_with("att_audit_logs/")));
    let everything = serde_json::to_string(&written).unwrap();
    for kept_here in ["refresh-1", "id_register_refresh_token", "app_settings", "sync_queue"] {
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
    users::save_user(
        &state,
        serde_json::json!({"userId": "APG-2026-101", "rfidUid": "ABCD1234", "fullName": "Juan Santos Dela Cruz", "status": "ACTIVE", "employeeType": "INTERN"}),
        users::SaveOrigin::Administrator,
    )
    .await
    .unwrap();
    run_once(&state, Some(&endpoints)).await.unwrap();
    let mut changed: Vec<String> = fake.lock().unwrap().written.concat().iter().map(named).collect();
    changed.sort();
    assert_eq!(changed.iter().filter(|name| name.starts_with("att_users/")).count(), 1);
    assert!(changed.iter().all(|name| name == "att_users/APG-2026-101" || name.starts_with("att_audit_logs/")), "{changed:?}");

    // A TIN and account number cleared here are removed there.
    fake.lock().unwrap().written.clear();
    sqlx::query("UPDATE users SET tin = NULL, account_number = '' WHERE user_id = 'APG-2026-101'").execute(&state.db).await.unwrap();
    run_once(&state, Some(&endpoints)).await.unwrap();
    let cleared = fake.lock().unwrap().written.concat();
    assert!(cleared.iter().any(|write| write["delete"].as_str().is_some_and(|name| name.ends_with("/attprivate_users/APG-2026-101"))), "{cleared:?}");

    // A record removed here is removed there.
    fake.lock().unwrap().written.clear();
    users::delete_user_and_cascade(&state, "APG-2026-101").await.unwrap();
    run_once(&state, Some(&endpoints)).await.unwrap();
    let removed = fake.lock().unwrap().written.concat();
    assert!(removed.iter().any(|write| write["delete"].as_str().is_some_and(|name| name.ends_with("/att_users/APG-2026-101"))), "{removed:?}");
    let last = status(&state).await;
    assert_eq!(last.backed_up, last.records);
    close(state, temp, server).await;
}

#[tokio::test]
async fn cloud_backup_rebuilds_a_new_kiosk_from_firebase_and_never_fills_one_that_has_people() {
    let (first, first_temp) = kiosk("rebuild-first").await;
    for n in 0..(DOCUMENTS_A_PAGE + 5) {
        add_user(&first, &format!("APG-2026-{:03}", 100 + n), &format!("{:08X}", 0xABCD_0000u32 + n as u32), &format!("Person {n}")).await;
    }
    sqlx::query("UPDATE users SET tin = '123-456-789', account_number = '0001-22' WHERE user_id = 'APG-2026-101'").execute(&first.db).await.unwrap();
    let tap = scan_rfid_impl(None, &first, serde_json::json!({"rfidUid": "ABCD0001", "source": "RFID"})).await.unwrap();
    assert_eq!(tap["success"], true, "{tap}");
    let fake = register(vec![]);
    let (endpoints, server) = serve(fake.clone()).await;
    sign_in(&first, Some(&endpoints), "kiosk@example.test", PASSWORD).await.unwrap();
    run_once(&first, Some(&endpoints)).await.unwrap();
    assert_eq!(status(&first).await.backed_up, status(&first).await.records);
    let original = everything(&first).await;
    assert!(original.len() > DOCUMENTS_A_PAGE, "more than one page of people");

    // A new computer, signed in with the kiosk's account: before the rules allow reading back, it says so and stays empty.
    let (second, second_temp) = kiosk("rebuild-second").await;
    sign_in(&second, Some(&endpoints), "kiosk@example.test", PASSWORD).await.unwrap();
    fake.lock().unwrap().refuse_reading_back = Some(403);
    run_once(&second, Some(&endpoints)).await.unwrap();
    assert_eq!(status(&second).await.problem.as_deref(), Some(NOT_READABLE));
    assert!(everything(&second).await.iter().all(|(name, _)| !name.starts_with("users/")));

    // Allowed: it fills itself, every value as the first kiosk has it, and sends nothing back.
    fake.lock().unwrap().refuse_reading_back = None;
    fake.lock().unwrap().written.clear();
    run_once(&second, Some(&endpoints)).await.unwrap();
    let rebuilt = everything(&second).await;
    // The second kiosk's own sign-in wrote audit lines of its own; everything the first had is there unchanged.
    for row in &original {
        assert!(rebuilt.contains(row), "{} did not arrive as it was", row.0);
    }
    let sent_back: Vec<String> = fake.lock().unwrap().written.concat().iter().map(named).collect();
    assert!(sent_back.iter().all(|name| name.starts_with("att_audit_logs/")), "only its own new audit lines go up: {sent_back:?}");
    let tap = scan_rfid_impl(None, &second, serde_json::json!({"rfidUid": "ABCD0002", "source": "RFID"})).await.unwrap();
    assert_eq!(tap["success"], true, "a rebuilt kiosk takes taps: {tap}");

    // A kiosk that has people is never filled, even with no progress file.
    let (third, third_temp) = kiosk("rebuild-third").await;
    add_user(&third, "APG-2026-900", "FFFF0000", "Someone Else").await;
    sign_in(&third, Some(&endpoints), "kiosk@example.test", PASSWORD).await.unwrap();
    fake.lock().unwrap().asked.clear();
    run_once(&third, Some(&endpoints)).await.unwrap();
    let people: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users").fetch_one(&third.db).await.unwrap();
    assert_eq!(people, 1);
    third.db.close().await;
    second.db.close().await;
    let _ = std::fs::remove_dir_all(&third_temp);
    let _ = std::fs::remove_dir_all(&second_temp);
    close(first, first_temp, server).await;
}
