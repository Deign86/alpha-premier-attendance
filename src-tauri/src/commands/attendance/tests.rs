use super::*;
use crate::commands::test_support::*;
use crate::commands::session::setup_unlock_impl;
use crate::services::users::delete_user_and_cascade;
use crate::services::users::upsert_user_record;


/// The boundary pin: `shared/arrival-fixtures.json` holds rows as this crate answers them, and the client has a
/// test that shows the same `expected` objects. A change to a field name or to the rule fails here or there.
#[test]
fn arrival_fields_match_the_fixture_the_client_renders() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!("../../../../shared/arrival-fixtures.json")).unwrap();
    let rows = fixture["rows"].as_array().unwrap();
    assert!(rows.len() >= 8);
    for row in rows {
        let input = &row["input"];
        let shown = arrival_fields(
            input["attendanceDate"].as_str().unwrap(),
            input["timeIn"].as_str(),
            input["graceAvailable"].as_bool().unwrap(),
            true,
        );
        let mut answered = serde_json::json!({});
        shown.insert_into(&mut answered);
        assert_eq!(answered, row["expected"], "{}", row["name"]);
    }
}

/// MINOR-1 of the round 2 review: the payable (clamped) time-in is an intern rule. The old client clamped only
/// rows whose person the register lists as an intern (21b9891 App.tsx:8322); Rust now withholds the field for
/// everyone else, so no screen has to know.
#[tokio::test]
async fn only_an_interns_row_carries_a_payable_time_in() {
    let (state, temp, _token) = admin_test_state("payable-intern-only").await;
    add_intern(&state, "INT-P", "RFID-INT-P").await;
    upsert_user_record(
        &state.db, "EMP-P", "RFID-EMP-P", "EMP-P", Some("IT"), "ACTIVE", "EMPLOYEE",
        Some("MALE"), Some(50000), Some("BEA_STANDARD"), None, "EMPLOYEE", "2026-07-01T00:00:00Z",
    )
    .await
    .unwrap();
    // GONE-P has attendance but is no longer in the register.
    for user in ["INT-P", "EMP-P", "GONE-P"] {
        sqlx::query(
            "INSERT INTO attendance (attendance_id, attendance_date, user_id, rfid_uid, full_name, department, time_in, status, source, created_at, updated_at) \
             VALUES (?, '2026-07-28', ?, ?, ?, 'IT', '2026-07-28T08:30:00+08:00', 'WORKING', 'RFID', '2026-07-28', '2026-07-28')",
        )
        .bind(format!("ATT-{user}"))
        .bind(user)
        .bind(format!("RFID-{user}"))
        .bind(user)
        .execute(&state.db)
        .await
        .unwrap();
    }
    let rows = attendance_rows_json(&state.db, "2026-07-28").await.unwrap();
    let listed = |user: &str| rows.iter().find(|row| row["userId"] == user).unwrap().clone();
    assert_eq!(listed("INT-P")["payableTimeIn"], "2026-07-28T09:00:00+08:00");
    for user in ["EMP-P", "GONE-P"] {
        assert_eq!(listed(user)["payableTimeIn"], serde_json::Value::Null, "{user}");
        // The arrival badge was Rust's for every row before and still is.
        assert_eq!(listed(user)["arrivalStatus"], "LATE", "{user}");
        assert_eq!(listed(user)["minutesLate"], 30, "{user}");
    }
    // The scan answer and the backdate answer read one row the same way.
    let one = |user: &'static str| {
        let db = state.db.clone();
        async move { attendance_arrival(&db, user, &format!("ATT-{user}"), "2026-07-28", Some("2026-07-28T08:30:00+08:00")).await }
    };
    assert_eq!(one("INT-P").await.payable_time_in.as_deref(), Some("2026-07-28T09:00:00+08:00"));
    assert_eq!(one("EMP-P").await.payable_time_in, None);
    assert_eq!(one("EMP-P").await.status, Some("LATE"));
    assert_eq!(one("GONE-P").await.payable_time_in, None);
    // One row's grace is read like the list's: free until another row of the person holds the week's claim.
    let grace_window = |attendance_id: &'static str| {
        let db = state.db.clone();
        async move { attendance_arrival(&db, "INT-P", attendance_id, "2026-07-29", Some("2026-07-29T08:10:00+08:00")).await.status }
    };
    assert_eq!(grace_window("ATT-NEXT").await, Some("GRACE_PERIOD"));
    sqlx::query("INSERT INTO intern_grace (grace_id, user_id, week_start, attendance_id, used_at) VALUES ('G-1', 'INT-P', '2026-07-27', 'ATT-INT-P', '2026-07-28')")
        .execute(&state.db)
        .await
        .unwrap();
    assert_eq!(grace_window("ATT-NEXT").await, Some("LATE"));
    assert_eq!(grace_window("ATT-INT-P").await, Some("GRACE_PERIOD"), "the row that holds the claim keeps it");
    state.db.close().await;
    let _ = std::fs::remove_dir_all(temp);
}

#[tokio::test]
async fn finalized_cutoff_freezes_its_days_and_outlives_the_user() {
    let temp = std::env::temp_dir().join(format!("alpha-cutoff-freeze-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp).unwrap();
    let state = AppState::new(
        temp.clone(),
        temp.join("attendance.db"),
        temp.join("exports"),
        false,
        LanConfig::default(),
        OfficeConfig::default(),
        crate::config::ScannerConfig::default(),
        crate::config::TtsConfig::default(),
        crate::config::UpdaterConfig::default(),
    )
    .await
    .unwrap();
    let token = "test-admin-token".to_string();
    *state.admin_session.lock().await = Some(crate::state::AdminSession {
        token: token.clone(),
        expires_at: std::time::Instant::now() + std::time::Duration::from_secs(3600),
    });
    upsert_user_record(
        &state.db, "EMP-1", "RFID-FREEZE", "Ada Lovelace", Some("QA"), "ACTIVE", "INTERN",
        Some("FEMALE"), None, Some("BEA_STANDARD"), None, "EMPLOYEE", "2026-08-01T00:00:00Z",
    )
    .await
    .unwrap();
    // Aug 1-15 is approved pay; Aug 20 is not.
    insert_cutoff_row(&state.db, "PAY-FIN", "FINALIZED").await;
    insert_cutoff_row(&state.db, "PAY-DRAFT", "DRAFT").await;
    sqlx::query("UPDATE payroll_cutoffs SET cutoff_start='2026-08-16', cutoff_end='2026-08-31' WHERE payroll_id='PAY-DRAFT'")
        .execute(&state.db).await.unwrap();
    sqlx::query("INSERT INTO payroll_snapshots (snapshot_id,payroll_id,revision,status,snapshot_json,snapshot_sha256,created_at) VALUES ('snap-1','PAY-FIN',1,'FINALIZED','{}','x','2026-08-16T00:00:00Z')")
        .execute(&state.db).await.unwrap();
    for (aid, date) in [("att-in", "2026-08-05"), ("att-out", "2026-08-20")] {
        sqlx::query("INSERT INTO attendance (attendance_id,attendance_date,user_id,rfid_uid,full_name,department,time_in,time_out,status,source,created_at,updated_at) VALUES (?,?,'EMP-1','RFID-FREEZE','Ada Lovelace','QA',?,?,'COMPLETED','RFID','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z')")
            .bind(aid).bind(date)
            .bind(format!("{date}T08:00:00+08:00")).bind(format!("{date}T17:00:00+08:00"))
            .execute(&state.db).await.unwrap();
    }

    let edit = admin_update_attendance_impl(&state, &admin(&state, &token).await, "att-in", &serde_json::json!({"timeOut": "2026-08-05T16:00:00+08:00"})).await;
    assert_eq!(edit.unwrap_err(), "ATTENDANCE_IN_FINALIZED_CUTOFF");
    let move_in = admin_update_attendance_impl(&state, &admin(&state, &token).await, "att-out", &serde_json::json!({"attendanceDate": "2026-08-06"})).await;
    assert_eq!(move_in.unwrap_err(), "ATTENDANCE_IN_FINALIZED_CUTOFF", "moving a day into approved pay");
    let delete = admin_delete_attendance_impl(&state, &admin(&state, &token).await, "att-in", "2026-08-05").await;
    assert_eq!(delete.unwrap_err(), "ATTENDANCE_IN_FINALIZED_CUTOFF");
    let frozen = sqlx::query("SELECT time_out, attendance_date FROM attendance WHERE attendance_id='att-in'")
        .fetch_one(&state.db).await.unwrap();
    assert_eq!(frozen.get::<Option<String>, _>("time_out").as_deref(), Some("2026-08-05T17:00:00+08:00"));
    // Days outside approved pay still correct normally.
    let open = admin_update_attendance_impl(&state, &admin(&state, &token).await, "att-out", &serde_json::json!({"timeOut": "2026-08-20T16:30:00+08:00"})).await.unwrap();
    assert_eq!(open["success"], true);

    // Deleting the person keeps the approved cutoff and its snapshot.
    delete_user_and_cascade(&state, "EMP-1").await.unwrap();
    let count = |sql: &'static str| {
        let db = state.db.clone();
        async move { sqlx::query_scalar::<_, i64>(sql).fetch_one(&db).await.unwrap() }
    };
    assert_eq!(count("SELECT COUNT(*) FROM payroll_cutoffs WHERE payroll_id='PAY-FIN'").await, 1);
    assert_eq!(count("SELECT COUNT(*) FROM payroll_snapshots WHERE payroll_id='PAY-FIN'").await, 1);
    assert_eq!(count("SELECT COUNT(*) FROM payroll_cutoffs WHERE payroll_id='PAY-DRAFT'").await, 0);
    assert_eq!(count("SELECT COUNT(*) FROM users WHERE user_id='EMP-1'").await, 0);
    state.db.close().await;
    let _ = std::fs::remove_dir_all(&temp);
}

#[tokio::test]
async fn test_admin_create_backdated_attendance() {
    let temp = std::env::temp_dir().join(format!("alpha-backdate-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp).unwrap();
    let db_path = temp.join("attendance.db");
    let exports_path = temp.join("exports");
    let mut lan = LanConfig::default();
    lan.admin_code = Some("1234".to_string());
    lan.admin_session_minutes = 30;
    let state = AppState::new(
        temp.clone(),
        db_path,
        exports_path,
        false,
        lan,
        OfficeConfig::default(),
        crate::config::ScannerConfig::default(),
        crate::config::TtsConfig::default(),
        crate::config::UpdaterConfig::default(),
    )
    .await
    .unwrap();

    // Unlock admin
    let unlock_res = setup_unlock_impl(&state, "1234".to_string()).await.unwrap();
    let token = unlock_res["token"].as_str().unwrap().to_string();

    upsert_user_record(
        &state.db,
        "EMP_01",
        "CARD_01",
        "Alice Cooper",
        Some("IT"),
        "ACTIVE",
        "EMPLOYEE",
        Some("FEMALE"),
        Some(50_000),
        Some("BEA_STANDARD"),
        None,
        "EMPLOYEE",
        "2026-08-01T00:00:00Z",
    )
    .await
    .unwrap();

    // 1. Success creating past backdated entry
    let payload = serde_json::json!({
        "userId": "EMP_01",
        "attendanceDate": "2026-08-15",
        "timeIn": "2026-08-15T08:00:00+08:00",
        "timeOut": "2026-08-15T17:00:00+08:00",
        "reason": "Missed scan physical log verified"
    });
    let res = admin_create_backdated_attendance_impl(None, &state, &admin(&state, &token).await, &payload).await.unwrap();
    assert_eq!(res["success"], true);
    assert_eq!(res["attendance"]["attendanceDate"], "2026-08-15");
    assert_eq!(res["attendance"]["userId"], "EMP_01");
    assert_eq!(res["attendance"]["source"], "ADMIN_BACKDATED_ENTRY");
    assert_eq!(res["attendance"]["status"], "COMPLETED");

    // 2. Reject duplicate date
    let dup_err = admin_create_backdated_attendance_impl(None, &state, &admin(&state, &token).await, &payload).await.unwrap_err();
    assert_eq!(dup_err, "ATTENDANCE_ALREADY_EXISTS_FOR_DATE");

    // 3. Reject future or today date
    let future_payload = serde_json::json!({
        "userId": "EMP_01",
        "attendanceDate": "2099-01-01",
        "timeIn": "2099-01-01T08:00:00+08:00",
        "reason": "Future date"
    });
    let future_err = admin_create_backdated_attendance_impl(None, &state, &admin(&state, &token).await, &future_payload).await.unwrap_err();
    assert_eq!(future_err, "ADMIN_VALIDATION_ERROR");

    // 4. B1: a backdated LATE_TIMEOUT entry (clock-out >= 18:00) must still
    // produce a payroll row, capped to the 17:00 office close, instead of
    // silently dropping the day. Same date as EMP_01 above, different user,
    // so the date-validation path is identical to the proven-success case.
    upsert_user_record(
        &state.db,
        "EMP_02",
        "CARD_02",
        "Bob Dylan",
        Some("IT"),
        "ACTIVE",
        "EMPLOYEE",
        Some("MALE"),
        Some(50_000),
        Some("BEA_STANDARD"),
        None,
        "EMPLOYEE",
        "2026-08-01T00:00:00Z",
    )
    .await
    .unwrap();
    let late_payload = serde_json::json!({
        "userId": "EMP_02",
        "attendanceDate": "2026-08-15",
        "timeIn": "2026-08-15T08:00:00+08:00",
        "timeOut": "2026-08-15T18:05:00+08:00",
        "reason": "Late clock-out verified against physical log"
    });
    let late_res = admin_create_backdated_attendance_impl(None, &state, &admin(&state, &token).await, &late_payload)
        .await
        .unwrap();
    assert_eq!(
        late_res["attendance"]["status"], "LATE_TIMEOUT",
        "18:05 clock-out must stay flagged for audit"
    );
    let late_payroll = sqlx::query(
        "SELECT computed_time_out, daily_pay_centavos FROM payroll WHERE attendance_id = ?",
    )
    .bind(late_res["attendance"]["attendanceId"].as_str().unwrap())
    .fetch_optional(&state.db)
    .await
    .unwrap();
    let late_payroll = late_payroll.expect("a LATE_TIMEOUT day must not be dropped from payroll");
    assert_eq!(
        late_payroll.get::<String, _>("computed_time_out"),
        "2026-08-15T17:00:00+08:00",
        "A LATE_TIMEOUT clock-out caps to the 17:00 office close"
    );
    assert_eq!(
        late_payroll.get::<i64, _>("daily_pay_centavos"),
        8_000,
        "The capped day pays the intern's full PHP 80 daily rate"
    );

    state.db.close().await;
    let _ = std::fs::remove_dir_all(&temp);
}

#[tokio::test]
async fn admin_update_keeps_a_time_in() {
    // Owner decision D7: a correction that leaves no time-in made the day
    // MISSED, and the scan then refused the person for the rest of it.
    let temp = std::env::temp_dir().join(format!("alpha-keep-time-in-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp).unwrap();
    let state = AppState::new(
        temp.clone(),
        temp.join("attendance.db"),
        temp.join("exports"),
        false,
        LanConfig::default(),
        OfficeConfig::default(),
        crate::config::ScannerConfig::default(),
        crate::config::TtsConfig::default(),
        crate::config::UpdaterConfig::default(),
    )
    .await
    .unwrap();
    let token = "test-admin-token".to_string();
    *state.admin_session.lock().await = Some(crate::state::AdminSession {
        token: token.clone(),
        expires_at: std::time::Instant::now() + std::time::Duration::from_secs(3600),
    });
    upsert_user_record(
        &state.db, "INT_KEEP", "C0FFEE0A", "Keep Intern", Some("IT"), "ACTIVE", "INTERN",
        Some("MALE"), None, Some("BEA_STANDARD"), None, "EMPLOYEE", "2026-08-01T00:00:00Z",
    )
    .await
    .unwrap();
    sqlx::query("INSERT INTO attendance (attendance_id,attendance_date,user_id,rfid_uid,full_name,department,time_in,time_out,status,source,created_at,updated_at) VALUES ('att-keep','2026-08-12','INT_KEEP','C0FFEE0A','Keep Intern','IT','2026-08-12T08:00:00+08:00','2026-08-12T17:00:00+08:00','COMPLETED','RFID','2026-08-12T00:00:00Z','2026-08-12T00:00:00Z')")
        .execute(&state.db).await.unwrap();
    for payload in [
        serde_json::json!({"timeIn": serde_json::Value::Null}),
        serde_json::json!({"timeIn": serde_json::Value::Null, "timeOut": serde_json::Value::Null}),
    ] {
        let err = admin_update_attendance_impl(&state, &admin(&state, &token).await, "att-keep", &payload).await.unwrap_err();
        assert_eq!(err, "ATTENDANCE_TIME_IN_REQUIRED", "{payload}");
    }
    let row = sqlx::query("SELECT time_in, status FROM attendance WHERE attendance_id='att-keep'")
        .fetch_one(&state.db).await.unwrap();
    assert_eq!(row.get::<Option<String>, _>("time_in").as_deref(), Some("2026-08-12T08:00:00+08:00"));
    assert_eq!(row.get::<String, _>("status"), "COMPLETED");
    state.db.close().await;
    let _ = std::fs::remove_dir_all(&temp);
}

#[tokio::test]
async fn admin_update_partial_payload_coalesces() {
    // Serialize DTR env access; a parallel blank-env test would otherwise
    // switch the resolver off mid-test and drop the InternDtr enqueue.
    let _env_guard = crate::config::dtr_env_test_guard();
    let saved_env = std::env::var(crate::config::ENV_DTR_SHEET_ID).ok();
    std::env::remove_var(crate::config::ENV_DTR_SHEET_ID);
    // P0 live data-loss 2026-09-05: a timeOut-only correction payload
    // wiped time_in to NULL and flipped COMPLETED to MISSED. Absent
    // (or explicit-null) fields must keep stored values.
    let temp = std::env::temp_dir().join(format!("alpha-admin-coalesce-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp).unwrap();
    let mut lan = LanConfig::default();
    lan.admin_code = Some("1234".to_string());
    lan.admin_session_minutes = 30;
    lan.google_dtr_spreadsheet_id = Some("sheet-test".to_string());
    let state = AppState::new(
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
    .unwrap();
    let unlock_res = setup_unlock_impl(&state, "1234".to_string()).await.unwrap();
    let token = unlock_res["token"].as_str().unwrap().to_string();
    upsert_user_record(
        &state.db, "INT_P0", "CARD_INT_P0", "Coalesce Intern", Some("QA"),
        "ACTIVE", "INTERN", Some("MALE"), None, Some("BEA_STANDARD"),
        None, "EMPLOYEE", "2026-08-01T00:00:00Z",
    )
    .await
    .unwrap();
    // Row A: COMPLETED day. Row B: WORKING day (time-out open).
    for (aid, tin, tout, status) in [
        ("aid-a", "2026-08-11T08:00:00+08:00", Some("2026-08-11T17:00:00+08:00"), "COMPLETED"),
        ("aid-b", "2026-08-12T08:05:00+08:00", None, "WORKING"),
    ] {
        let date = &tin[..10];
        sqlx::query("INSERT INTO attendance (attendance_id,attendance_date,user_id,rfid_uid,full_name,department,time_in,time_out,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
            .bind(aid).bind(date).bind("INT_P0").bind("CARD_INT_P0").bind("Coalesce Intern").bind("QA")
            .bind(tin).bind(tout).bind(status).bind("RFID").bind("2026-08-11T00:00:00Z").bind("2026-08-11T00:00:00Z")
            .execute(&state.db).await.unwrap();
    }
    // 1. Live repro: timeOut-only payload keeps time_in, stays COMPLETED.
    let r1 = admin_update_attendance_impl(&state, &admin(&state, &token).await, "aid-a", &serde_json::json!({"timeOut": "2026-08-11T17:05:00+08:00"})).await.unwrap();
    assert_eq!(r1["success"], true);
    assert_eq!(r1["timeIn"], "2026-08-11T08:00:00+08:00");
    assert_eq!(r1["timeOut"], "2026-08-11T17:05:00+08:00");
    assert_eq!(r1["status"], "COMPLETED");
    let row = sqlx::query("SELECT attendance_date,time_in,time_out,status,revision FROM attendance WHERE attendance_id='aid-a'")
        .fetch_one(&state.db).await.unwrap();
    assert_eq!(row.get::<Option<String>, _>("time_in").as_deref(), Some("2026-08-11T08:00:00+08:00"));
    assert_eq!(row.get::<String, _>("status"), "COMPLETED");
    // 2. timeIn-only on the WORKING row keeps the open time-out.
    let r2 = admin_update_attendance_impl(&state, &admin(&state, &token).await, "aid-b", &serde_json::json!({"timeIn": "2026-08-12T08:06:00+08:00"})).await.unwrap();
    assert_eq!(r2["status"], "WORKING");
    assert!(r2["timeOut"].is_null());
    // 3. Explicit JSON null clears the field (admins can remove an
    // inaccurate tap-out); status drops back to WORKING and the DTR
    // re-push carries the cleared row.
    let r3 = admin_update_attendance_impl(&state, &admin(&state, &token).await, "aid-a", &serde_json::json!({"timeOut": serde_json::Value::Null, "timeIn": "2026-08-11T08:01:00+08:00"})).await.unwrap();
    assert!(r3["timeOut"].is_null());
    assert_eq!(r3["timeIn"], "2026-08-11T08:01:00+08:00");
    assert_eq!(r3["status"], "WORKING");
    let cleared = sqlx::query("SELECT time_in,time_out,status FROM attendance WHERE attendance_id='aid-a'")
        .fetch_one(&state.db).await.unwrap();
    assert!(cleared.get::<Option<String>, _>("time_out").is_none());
    assert_eq!(cleared.get::<String, _>("status"), "WORKING");
    let dtr_payload: Option<String> = sqlx::query_scalar("SELECT payload_json FROM sync_queue WHERE table_name='InternDtr' AND row_id='aid-a' AND operation='UPSERT'")
        .fetch_optional(&state.db).await.unwrap();
    let dtr_payload: serde_json::Value = serde_json::from_str(&dtr_payload.expect("correction must re-push InternDtr")).unwrap();
    assert!(dtr_payload["timeOut"].is_null());
    assert_eq!(dtr_payload["timeIn"], "2026-08-11T08:01:00+08:00");
    // Restore the completed day for the no-op / conflict steps below.
    let restore = admin_update_attendance_impl(&state, &admin(&state, &token).await, "aid-a", &serde_json::json!({"timeOut": "2026-08-11T17:05:00+08:00"})).await.unwrap();
    assert_eq!(restore["status"], "COMPLETED");
    // 4. No-op full payload: revision untouched, no extra queue churn.
    let rev_before: i64 = sqlx::query_scalar("SELECT revision FROM attendance WHERE attendance_id='aid-a'").fetch_one(&state.db).await.unwrap();
    let q_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_queue WHERE row_id='aid-a'").fetch_one(&state.db).await.unwrap();
    let r4 = admin_update_attendance_impl(&state, &admin(&state, &token).await, "aid-a", &serde_json::json!({"attendanceDate": "2026-08-11", "timeIn": "2026-08-11T08:01:00+08:00", "timeOut": "2026-08-11T17:05:00+08:00"})).await.unwrap();
    assert_eq!(r4["success"], true);
    let rev_after: i64 = sqlx::query_scalar("SELECT revision FROM attendance WHERE attendance_id='aid-a'").fetch_one(&state.db).await.unwrap();
    let q_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_queue WHERE row_id='aid-a'").fetch_one(&state.db).await.unwrap();
    assert_eq!(rev_before, rev_after);
    assert_eq!(q_before, q_after);
    // 5. Invalid time still rejected; conflicting expectation still conflicts.
    let bad = admin_update_attendance_impl(&state, &admin(&state, &token).await, "aid-a", &serde_json::json!({"timeIn": "not-a-time"})).await.unwrap_err();
    assert_eq!(bad, "ADMIN_VALIDATION_ERROR");
    let conflict = admin_update_attendance_impl(&state, &admin(&state, &token).await, "aid-a", &serde_json::json!({"timeIn": "2026-08-11T08:01:00+08:00", "expectedTimeIn": "2026-08-11T00:00:00+08:00"})).await.unwrap_err();
    assert_eq!(conflict, "ATTENDANCE_CONFLICT");
    // Row survived all of the above with real times intact.
    let final_row = sqlx::query("SELECT attendance_date,time_in,time_out,status,revision FROM attendance WHERE attendance_id='aid-a'")
        .fetch_one(&state.db).await.unwrap();
    assert!(final_row.get::<Option<String>, _>("time_in").as_deref().is_some());
    // 6. Stale save: the admin loaded aid-b while WORKING (time-out empty),
    // then the intern's tap-out committed time-out + payroll. Saving the
    // stale draft sends timeOut:null with expectedTimeOut:null; that
    // expectation no longer holds, so it must conflict instead of wiping
    // the fresh time-out and deleting the day's payroll.
    let tapped = admin_update_attendance_impl(&state, &admin(&state, &token).await, "aid-b", &serde_json::json!({"timeOut": "2026-08-12T17:00:00+08:00"})).await.unwrap();
    assert_eq!(tapped["status"], "COMPLETED");
    let stale = admin_update_attendance_impl(&state, &admin(&state, &token).await, "aid-b", &serde_json::json!({
        "attendanceDate": "2026-08-12",
        "timeIn": "2026-08-12T08:07:00+08:00",
        "timeOut": serde_json::Value::Null,
        "expectedTimeIn": "2026-08-12T08:06:00+08:00",
        "expectedTimeOut": serde_json::Value::Null,
    })).await.unwrap_err();
    assert_eq!(stale, "ATTENDANCE_CONFLICT");
    let kept = sqlx::query("SELECT time_out,status FROM attendance WHERE attendance_id='aid-b'")
        .fetch_one(&state.db).await.unwrap();
    assert_eq!(kept.get::<Option<String>, _>("time_out").as_deref(), Some("2026-08-12T17:00:00+08:00"));
    assert_eq!(kept.get::<String, _>("status"), "COMPLETED");
    let payroll_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM payroll WHERE attendance_id='aid-b'")
        .fetch_one(&state.db).await.unwrap();
    assert_eq!(payroll_rows, 1);
    state.db.close().await;
    let _ = std::fs::remove_dir_all(&temp);
    match saved_env {
        Some(v) => std::env::set_var(crate::config::ENV_DTR_SHEET_ID, v),
        None => std::env::remove_var(crate::config::ENV_DTR_SHEET_ID),
    }
}

#[tokio::test]
async fn admin_update_rolls_back_attendance_when_payroll_write_fails() {
    let _env_guard = crate::config::dtr_env_test_guard();
    let temp = std::env::temp_dir().join(format!("alpha-admin-rollback-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp).unwrap();
    let mut lan = LanConfig::default();
    lan.admin_code = Some("1234".to_string());
    lan.admin_session_minutes = 30;
    let state = AppState::new(
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
    .unwrap();
    let unlock_res = setup_unlock_impl(&state, "1234".to_string()).await.unwrap();
    let token = unlock_res["token"].as_str().unwrap().to_string();
    upsert_user_record(
        &state.db, "INT_RB", "CARD_INT_RB", "Rollback Intern", Some("QA"),
        "ACTIVE", "INTERN", Some("MALE"), None, Some("BEA_STANDARD"),
        None, "EMPLOYEE", "2026-08-01T00:00:00Z",
    )
    .await
    .unwrap();
    // Late open day (pre grace cut-over): completing it claims a grace row
    // first, then writes payroll. The trigger makes the payroll write fail.
    sqlx::query("INSERT INTO attendance (attendance_id,attendance_date,user_id,rfid_uid,full_name,department,time_in,time_out,status,source,created_at,updated_at) VALUES ('aid-rb','2026-08-12','INT_RB','CARD_INT_RB','Rollback Intern','QA','2026-08-12T08:10:00+08:00',NULL,'WORKING','RFID','2026-08-12T00:00:00Z','2026-08-12T00:00:00Z')")
        .execute(&state.db).await.unwrap();
    let rev_before: i64 = sqlx::query_scalar("SELECT revision FROM attendance WHERE attendance_id='aid-rb'").fetch_one(&state.db).await.unwrap();
    sqlx::query("CREATE TRIGGER fail_payroll_insert BEFORE INSERT ON payroll BEGIN SELECT RAISE(ABORT, 'forced payroll failure'); END")
        .execute(&state.db).await.unwrap();
    let err = admin_update_attendance_impl(&state, &admin(&state, &token).await, "aid-rb", &serde_json::json!({"timeOut": "2026-08-12T17:00:00+08:00"})).await.unwrap_err();
    assert!(err.contains("forced payroll failure"), "unexpected error: {err}");
    let row = sqlx::query("SELECT time_out,status,revision FROM attendance WHERE attendance_id='aid-rb'")
        .fetch_one(&state.db).await.unwrap();
    assert!(row.get::<Option<String>, _>("time_out").is_none());
    assert_eq!(row.get::<String, _>("status"), "WORKING");
    assert_eq!(row.get::<i64, _>("revision"), rev_before);
    let grace: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM intern_grace WHERE attendance_id='aid-rb'").fetch_one(&state.db).await.unwrap();
    assert_eq!(grace, 0);
    let queued: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_queue WHERE row_id='aid-rb'").fetch_one(&state.db).await.unwrap();
    assert_eq!(queued, 0);
    let audited: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_logs WHERE event_type='ADMIN_ATTENDANCE_UPDATED'").fetch_one(&state.db).await.unwrap();
    assert_eq!(audited, 0);
    // The same edit succeeds once the failure is removed.
    sqlx::query("DROP TRIGGER fail_payroll_insert").execute(&state.db).await.unwrap();
    let ok = admin_update_attendance_impl(&state, &admin(&state, &token).await, "aid-rb", &serde_json::json!({"timeOut": "2026-08-12T17:00:00+08:00"})).await.unwrap();
    assert_eq!(ok["status"], "COMPLETED");
    let payroll: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM payroll WHERE attendance_id='aid-rb'").fetch_one(&state.db).await.unwrap();
    assert_eq!(payroll, 1);
    state.db.close().await;
    let _ = std::fs::remove_dir_all(&temp);
}

/// The differences between the admin tails that `AttendanceChange` keeps: a backdated entry and a correction
/// each write their own audit row (the entry names the person, the correction does not); a delete writes none.
#[tokio::test]
async fn each_admin_change_keeps_its_own_audit_row_and_a_delete_has_none() {
    let temp = std::env::temp_dir().join(format!("alpha-admin-tail-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp).unwrap();
    let mut lan = LanConfig::default();
    lan.admin_code = Some("1234".to_string());
    lan.admin_session_minutes = 30;
    let state = AppState::new(
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
    .unwrap();
    let token = setup_unlock_impl(&state, "1234".to_string()).await.unwrap()["token"].as_str().unwrap().to_string();
    upsert_user_record(&state.db, "INT_01", "CARD_INT_01", "Test Intern", Some("QA"), "ACTIVE", "INTERN", Some("MALE"), None, None, None, "EMPLOYEE", "2026-08-01T00:00:00Z").await.unwrap();
    let audit_rows = || async {
        sqlx::query_as::<_, (String, Option<String>, String)>(
            "SELECT event_type, user_id, request_id FROM audit_logs WHERE event_type LIKE 'ADMIN_ATTENDANCE_%' ORDER BY rowid",
        )
        .fetch_all(&state.db)
        .await
        .unwrap()
    };

    let created = admin_create_backdated_attendance_impl(None, &state, &admin(&state, &token).await, &serde_json::json!({
        "userId": "INT_01",
        "attendanceDate": "2026-08-11",
        "timeIn": "2026-08-11T08:00:00+08:00",
        "timeOut": "2026-08-11T17:00:00+08:00",
        "reason": "Missed scan physical log verified"
    }))
    .await
    .unwrap();
    let attendance_id = created["attendance"]["attendanceId"].as_str().unwrap().to_string();
    admin_update_attendance_impl(&state, &admin(&state, &token).await, &attendance_id, &serde_json::json!({
        "attendanceDate": "2026-08-11",
        "timeIn": "2026-08-11T07:30:00+08:00",
        "timeOut": "2026-08-11T17:00:00+08:00",
        "expectedTimeIn": "2026-08-11T08:00:00+08:00",
        "expectedTimeOut": "2026-08-11T17:00:00+08:00"
    }))
    .await
    .unwrap();
    let before_delete = audit_rows().await;
    assert_eq!(
        before_delete.iter().map(|(event, user, _)| (event.as_str(), user.as_deref())).collect::<Vec<_>>(),
        vec![("ADMIN_ATTENDANCE_CREATED", Some("INT_01")), ("ADMIN_ATTENDANCE_UPDATED", None)],
    );
    assert!(before_delete.iter().all(|(_, _, request_id)| request_id.starts_with("admin-")));

    admin_delete_attendance_impl(&state, &admin(&state, &token).await, &attendance_id, "2026-08-11").await.unwrap();
    assert_eq!(audit_rows().await.len(), 2, "a delete writes no audit row");
    let _ = std::fs::remove_dir_all(temp);
}

#[tokio::test]
async fn admin_corrections_mirror_intern_dtr() {
    // Serialize DTR env access; a parallel blank-env test would otherwise
    // switch the resolver off mid-test and drop the InternDtr enqueue.
    let _env_guard = crate::config::dtr_env_test_guard();
    let saved_env = std::env::var(crate::config::ENV_DTR_SHEET_ID).ok();
    std::env::remove_var(crate::config::ENV_DTR_SHEET_ID);
    let temp = std::env::temp_dir().join(format!("alpha-admin-dtr-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp).unwrap();
    let db_path = temp.join("attendance.db");
    let exports_path = temp.join("exports");
    let mut lan = LanConfig::default();
    lan.admin_code = Some("1234".to_string());
    lan.admin_session_minutes = 30;
    lan.google_dtr_spreadsheet_id = Some("sheet-test".to_string());
    let state = AppState::new(
        temp.clone(),
        db_path,
        exports_path,
        false,
        lan,
        OfficeConfig::default(),
        crate::config::ScannerConfig::default(),
        crate::config::TtsConfig::default(),
        crate::config::UpdaterConfig::default(),
    )
    .await
    .unwrap();
    let unlock_res = setup_unlock_impl(&state, "1234".to_string()).await.unwrap();
    let token = unlock_res["token"].as_str().unwrap().to_string();

    for (uid, card, name, etype, rate) in [
        ("INT_01", "CARD_INT_01", "Test Intern", "INTERN", None),
        ("EMP_02", "CARD_EMP_02", "Test Employee", "EMPLOYEE", Some(50_000)),
    ] {
        upsert_user_record(
            &state.db, uid, card, name, Some("QA"), "ACTIVE", etype,
            Some("MALE"), rate, Some("BEA_STANDARD"), None, "EMPLOYEE",
            "2026-08-01T00:00:00Z",
        )
        .await
        .unwrap();
    }

    // 1. Intern backdate → InternDtr UPSERT queued with exact times.
    let payload = serde_json::json!({
        "userId": "INT_01",
        "attendanceDate": "2026-08-11",
        "timeIn": "2026-08-11T08:00:00+08:00",
        "timeOut": "2026-08-11T17:00:00+08:00",
        "reason": "Missed scan physical log verified"
    });
    let res = admin_create_backdated_attendance_impl(None, &state, &admin(&state, &token).await, &payload).await.unwrap();
    let aid = res["attendance"]["attendanceId"].as_str().unwrap().to_string();
    let row: Option<String> = sqlx::query_scalar("SELECT payload_json FROM sync_queue WHERE table_name='InternDtr' AND row_id=?")
        .bind(&aid).fetch_optional(&state.db).await.unwrap();
    assert!(row.is_some(), "intern backdate must enqueue InternDtr");
    let queued: serde_json::Value = serde_json::from_str(&row.unwrap()).unwrap();
    assert_eq!(queued["userId"], "INT_01");
    assert_eq!(queued["timeIn"], "2026-08-11T08:00:00+08:00");
    assert_eq!(queued["timeOut"], "2026-08-11T17:00:00+08:00");

    // 2. Employee backdate → no InternDtr row (interns-only guard).
    let emp_payload = serde_json::json!({
        "userId": "EMP_02",
        "attendanceDate": "2026-08-12",
        "timeIn": "2026-08-12T08:00:00+08:00",
        "timeOut": "2026-08-12T17:00:00+08:00",
        "reason": "Missed scan physical log verified"
    });
    let emp_res = admin_create_backdated_attendance_impl(None, &state, &admin(&state, &token).await, &emp_payload).await.unwrap();
    let emp_aid = emp_res["attendance"]["attendanceId"].as_str().unwrap().to_string();
    let emp_row: Option<String> = sqlx::query_scalar("SELECT payload_json FROM sync_queue WHERE table_name='InternDtr' AND row_id=?")
        .bind(&emp_aid).fetch_optional(&state.db).await.unwrap();
    assert!(emp_row.is_none(), "employee backdate must not enqueue InternDtr");

    // 3. Admin corrects the intern time-in → payload rewritten (converges),
    // still exactly one InternDtr row (idempotent upsert, no duplicates).
    let upd = serde_json::json!({
        "attendanceDate": "2026-08-11",
        "timeIn": "2026-08-11T07:30:00+08:00",
        "timeOut": "2026-08-11T17:00:00+08:00",
        "expectedTimeIn": "2026-08-11T08:00:00+08:00",
        "expectedTimeOut": "2026-08-11T17:00:00+08:00"
    });
    let ures = admin_update_attendance_impl(&state, &admin(&state, &token).await, &aid, &upd).await.unwrap();
    assert_eq!(ures["success"], true);
    let row2: String = sqlx::query_scalar("SELECT payload_json FROM sync_queue WHERE table_name='InternDtr' AND row_id=?")
        .bind(&aid).fetch_one(&state.db).await.unwrap();
    let queued2: serde_json::Value = serde_json::from_str(&row2).unwrap();
    assert_eq!(queued2["timeIn"], "2026-08-11T07:30:00+08:00");
    // The corrected row renders differently, so the push rewrites it.
    let before = crate::services::dtr_sync::build_dtr_row(Some("2026-08-11T08:00:00+08:00"), Some("2026-08-11T17:00:00+08:00"), "2026-08-11").unwrap();
    let after = crate::services::dtr_sync::build_dtr_row(Some("2026-08-11T07:30:00+08:00"), Some("2026-08-11T17:00:00+08:00"), "2026-08-11").unwrap();
    assert_ne!(before[0], after[0]);
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_queue WHERE table_name='InternDtr' AND row_id=?")
        .bind(&aid).fetch_one(&state.db).await.unwrap();
    assert_eq!(n, 1);

    // 4. Delete → an InternDtr DELETE row (same attendance id, separate
    // idempotency key per operation) so the sheet date clears; the ops
    // Attendance DELETE is still enqueued too.
    admin_delete_attendance_impl(&state, &admin(&state, &token).await, &aid, "2026-08-11").await.unwrap();
    let del_row: Option<String> = sqlx::query_scalar("SELECT payload_json FROM sync_queue WHERE table_name='InternDtr' AND row_id=? AND operation='DELETE'")
        .bind(&aid).fetch_optional(&state.db).await.unwrap();
    assert!(del_row.is_some(), "delete must enqueue InternDtr DELETE");
    let del_payload: serde_json::Value = serde_json::from_str(&del_row.unwrap()).unwrap();
    assert_eq!(del_payload["userId"], "INT_01");
    assert_eq!(del_payload["attendanceDate"], "2026-08-11");
    let del_op: Option<String> = sqlx::query_scalar("SELECT operation FROM sync_queue WHERE table_name='Attendance' AND row_id=? AND operation='DELETE'")
        .bind(&aid).fetch_optional(&state.db).await.unwrap();
    assert_eq!(del_op.as_deref(), Some("DELETE"));

    state.db.close().await;
    let _ = std::fs::remove_dir_all(&temp);
    match saved_env {
        Some(v) => std::env::set_var(crate::config::ENV_DTR_SHEET_ID, v),
        None => std::env::remove_var(crate::config::ENV_DTR_SHEET_ID),
    }
}

#[tokio::test]
async fn admin_backdate_skips_dtr_when_explicitly_disabled() {
    // Serialize DTR env access; restored below.
    let _env_guard = crate::config::dtr_env_test_guard();
    // DTR is hard-wired on by default, so the off path needs the
    // explicit blank-env switch.
    let saved = std::env::var(crate::config::ENV_DTR_SHEET_ID).ok();
    std::env::set_var(crate::config::ENV_DTR_SHEET_ID, "");
    let temp = std::env::temp_dir().join(format!("alpha-admin-dtr-off-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp).unwrap();
    let mut lan = LanConfig::default();
    lan.admin_code = Some("1234".to_string());
    lan.admin_session_minutes = 30;
    let state = AppState::new(
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
    .unwrap();
    let unlock_res = setup_unlock_impl(&state, "1234".to_string()).await.unwrap();
    let token = unlock_res["token"].as_str().unwrap().to_string();
    upsert_user_record(
        &state.db, "INT_09", "CARD_INT_09", "Quiet Intern", Some("QA"),
        "ACTIVE", "INTERN", Some("MALE"), None, Some("BEA_STANDARD"),
        None, "EMPLOYEE", "2026-08-01T00:00:00Z",
    )
    .await
    .unwrap();
    let payload = serde_json::json!({
        "userId": "INT_09",
        "attendanceDate": "2026-08-11",
        "timeIn": "2026-08-11T08:00:00+08:00",
        "timeOut": "2026-08-11T17:00:00+08:00",
        "reason": "Missed scan physical log verified"
    });
    let res = admin_create_backdated_attendance_impl(None, &state, &admin(&state, &token).await, &payload).await.unwrap();
    let aid = res["attendance"]["attendanceId"].as_str().unwrap().to_string();
    let row: Option<String> = sqlx::query_scalar("SELECT payload_json FROM sync_queue WHERE table_name='InternDtr' AND row_id=?")
        .bind(&aid).fetch_optional(&state.db).await.unwrap();
    assert!(row.is_none(), "explicitly disabled DTR must not enqueue InternDtr");
    state.db.close().await;
    let _ = std::fs::remove_dir_all(&temp);
    match saved {
        Some(v) => std::env::set_var(crate::config::ENV_DTR_SHEET_ID, v),
        None => std::env::remove_var(crate::config::ENV_DTR_SHEET_ID),
    }
}

#[tokio::test]
async fn admin_changes_reach_lan_viewers() {
    // O11: only scans published to the LAN bus, so open viewers missed
    // admin corrections, deletes and backdated days until a refresh.
    let (state, temp, token) = admin_test_state("lan-admin").await;
    add_intern(&state, "INT_L", "C0FFEE16").await;
    sqlx::query("INSERT INTO attendance (attendance_id,attendance_date,user_id,rfid_uid,full_name,department,time_in,time_out,status,source,created_at,updated_at) VALUES ('att-l','2026-08-12','INT_L','C0FFEE16','INT_L','IT','2026-08-12T08:00:00+08:00',NULL,'WORKING','RFID','2026-08-12T00:00:00Z','2026-08-12T00:00:00Z')")
        .execute(&state.db).await.unwrap();
    let mut viewer = state.bus.sender.subscribe();
    let mut next_event = || match viewer.try_recv() {
        Ok(crate::lan_server::LanAttendanceEvent::AttendanceUpdated { attendance_id, mutation, .. }) => Some((attendance_id, mutation)),
        Err(_) => None,
    };
    admin_update_attendance_impl(&state, &admin(&state, &token).await, "att-l", &serde_json::json!({"timeOut": "2026-08-12T17:00:00+08:00"})).await.unwrap();
    assert_eq!(next_event(), Some(("att-l".to_string(), "upsert".to_string())));
    admin_delete_attendance_impl(&state, &admin(&state, &token).await, "att-l", "2026-08-12").await.unwrap();
    assert_eq!(next_event(), Some(("att-l".to_string(), "delete".to_string())));
    state.db.close().await;
    let _ = std::fs::remove_dir_all(&temp);
}

#[tokio::test]
async fn moving_a_day_clears_the_old_date_on_the_dtr_sheet() {
    // S6 (confirmed): the UPSERT only writes the new date, so the old
    // date's cells stayed filled.
    let _env_guard = crate::config::dtr_env_test_guard();
    let saved_env = std::env::var(crate::config::ENV_DTR_SHEET_ID).ok();
    std::env::remove_var(crate::config::ENV_DTR_SHEET_ID);
    let (mut state, temp, token) = admin_test_state("move-day").await;
    state.lan.google_dtr_spreadsheet_id = Some("sheet-test".to_string());
    add_intern(&state, "INT_M", "C0FFEE14").await;
    sqlx::query("INSERT INTO attendance (attendance_id,attendance_date,user_id,rfid_uid,full_name,department,time_in,time_out,status,source,created_at,updated_at) VALUES ('att-m','2026-08-12','INT_M','C0FFEE14','INT_M','IT','2026-08-12T08:00:00+08:00','2026-08-12T17:00:00+08:00','COMPLETED','RFID','2026-08-12T00:00:00Z','2026-08-12T00:00:00Z')")
        .execute(&state.db).await.unwrap();
    admin_update_attendance_impl(&state, &admin(&state, &token).await, "att-m", &serde_json::json!({
        "attendanceDate": "2026-08-13",
        "timeIn": "2026-08-13T08:00:00+08:00",
        "timeOut": "2026-08-13T17:00:00+08:00",
    })).await.unwrap();
    let clear: Option<String> = sqlx::query_scalar("SELECT payload_json FROM sync_queue WHERE table_name='InternDtr' AND operation='DELETE' AND status='PENDING'")
        .fetch_optional(&state.db).await.unwrap();
    let clear: serde_json::Value = serde_json::from_str(&clear.expect("old date is cleared on the DTR sheet")).unwrap();
    assert_eq!(clear["attendanceDate"], "2026-08-12");
    let upsert: String = sqlx::query_scalar("SELECT status FROM sync_queue WHERE table_name='InternDtr' AND row_id='att-m' AND operation='UPSERT'")
        .fetch_one(&state.db).await.unwrap();
    assert_eq!(upsert, "PENDING", "the clear must not supersede the new date's push");
    match saved_env {
        Some(value) => std::env::set_var(crate::config::ENV_DTR_SHEET_ID, value),
        None => std::env::remove_var(crate::config::ENV_DTR_SHEET_ID),
    }
    state.db.close().await;
    let _ = std::fs::remove_dir_all(&temp);
}
