//! What follows a change to an attendance row, and what a row says about its arrival: the rules the kiosk scan, the
//! admin attendance commands and payroll share.

use chrono::Datelike;
use crate::services::sync_queue::{enqueue_sync_on, flush_pending_sync, PendingSync};
use crate::state::AppState;
use sqlx::Row;
use tauri::Emitter;

/// A day inside one of the person's FINALIZED cutoffs is approved pay: no
/// admin create, edit or delete may change it (owner decision D2,
/// 2026-11-06). Kiosk scans are not blocked.
pub(crate) async fn day_in_finalized_cutoff<'c, E>(executor: E, user_id: &str, date: &str) -> Result<bool, String>
where
    E: sqlx::Executor<'c, Database = sqlx::Sqlite>,
{
    sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM payroll_cutoffs WHERE employee_id = ? AND status = 'FINALIZED' AND ? >= cutoff_start AND ? <= cutoff_end",
    )
    .bind(user_id)
    .bind(date)
    .bind(date)
    .fetch_one(executor)
    .await
    .map(|count| count > 0)
    .map_err(|e| e.to_string())
}

/// Whose line on the intern DTR sheet an attendance change touches.
pub(crate) struct DtrPerson {
    pub(crate) user_id: String,
    pub(crate) full_name: String,
    pub(crate) employee_type: String,
}

/// What an attendance change does to that person's day on the intern DTR sheet.
pub(crate) enum DtrLine<'a> {
    /// Nothing is queued for the DTR sheet.
    None,
    /// Write the day (interns only, and only when the sheet is configured).
    Write { time_in: Option<&'a str>, time_out: Option<&'a str> },
    /// Empty the day's cells; the row stays on the sheet.
    Clear,
}

/// A further queue step of one attendance change, after the row itself and its DTR line.
pub(crate) enum Follow<'a> {
    Queue { table: &'a str, row_id: String, operation: &'static str, payload: serde_json::Value },
    /// Re-queue the person's later days of the Manila week of `date`.
    LaterWeek { date: &'a str },
}

/// What LAN viewers are told. A scan sends the row itself under the scan's request id and time;
/// an administrator's change sends only that the day changed.
pub(crate) struct LanNotice<'a> {
    pub(crate) cause: &'a str,
    pub(crate) mutation: &'static str,
    pub(crate) from_scan: Option<(String, chrono::DateTime<chrono::Utc>, crate::lan_server::LanAttendanceRow)>,
}

/// The `attendance-updated` event for the app's own window.
pub(crate) struct WindowEvent<'a> {
    pub(crate) app: Option<&'a tauri::AppHandle>,
    pub(crate) user_id: &'a str,
    pub(crate) action: &'a str,
    pub(crate) time_in: serde_json::Value,
    pub(crate) time_out: serde_json::Value,
    pub(crate) status: &'a str,
    /// The backdate has always taken a second sequence number for this event; the scan reuses the LAN notice's.
    pub(crate) own_sequence: bool,
}

/// One change to one attendance row, and what its caller has always done about it. The four callers (scan,
/// correction, backdated entry, delete) differ; every difference is a field here, kept as it was found:
///
/// | step                                  | scan | correction | backdate | delete |
/// |---------------------------------------|------|------------|----------|--------|
/// | re-queue the later days of the week   | no   | yes        | yes      | yes    |
/// | `attendance-updated` window event     | yes  | no         | yes      | no     |
/// | audit row                             | yes  | yes        | yes      | no     |
/// | LAN notice carries the row            | yes  | no         | no       | no     |
/// | card debounce marked after the commit | yes  | no         | no       | no     |
pub(crate) struct AttendanceChange<'a> {
    pub(crate) attendance_id: &'a str,
    pub(crate) date: &'a str,
    /// Payroll rows priced in this transaction (`ensure_payroll_tx`); queued first.
    pub(crate) pending: Vec<PendingSync>,
    /// The row for the Attendance sheet. Each caller sends its own set of keys.
    pub(crate) sheet_operation: &'static str,
    pub(crate) sheet_row: serde_json::Value,
    pub(crate) person: Option<DtrPerson>,
    pub(crate) dtr: DtrLine<'a>,
    pub(crate) requeue_later_week: bool,
    pub(crate) follow: Vec<Follow<'a>>,
    /// Scan only: the card's debounce key, marked once the row is committed.
    pub(crate) tap: Option<String>,
    pub(crate) lan: LanNotice<'a>,
    pub(crate) window_event: Option<WindowEvent<'a>>,
    pub(crate) audit: Option<crate::services::audit::Entry<'a>>,
}

/// Everything that follows a change to an attendance row, in one order: queue the Sheets rows in the caller's
/// transaction, commit, then tell LAN viewers, the app window and the audit log. `Err` means the commit failed and
/// nothing was announced.
pub(crate) async fn attendance_changed(
    state: &AppState,
    mut tx: sqlx::Transaction<'_, sqlx::Sqlite>,
    change: AttendanceChange<'_>,
) -> Result<(), sqlx::Error> {
    // Queue rows commit with the change (O4).
    flush_pending_sync(state, &mut tx, change.pending).await;
    enqueue_sync_on(state, &mut tx, "Attendance", change.attendance_id, change.sheet_operation, &change.sheet_row).await;
    if let Some(person) = &change.person {
        match change.dtr {
            DtrLine::None => {}
            DtrLine::Write { time_in, time_out } => {
                enqueue_intern_dtr(state, &mut tx, change.attendance_id, &person.user_id, &person.full_name, &person.employee_type, change.date, time_in, time_out).await;
            }
            DtrLine::Clear => {
                enqueue_sync_on(
                    state,
                    &mut tx,
                    crate::services::dtr_sync::DTR_TABLE_NAME,
                    change.attendance_id,
                    "DELETE",
                    &serde_json::json!({"userId": person.user_id, "fullName": person.full_name, "attendanceDate": change.date}),
                )
                .await;
            }
        }
        if change.requeue_later_week {
            enqueue_later_weekly_intern_dtr(state, &mut tx, &person.user_id, &person.full_name, &person.employee_type, change.date).await;
        }
    }
    for step in change.follow {
        match step {
            Follow::Queue { table, row_id, operation, payload } => {
                enqueue_sync_on(state, &mut tx, table, &row_id, operation, &payload).await;
            }
            Follow::LaterWeek { date } => {
                if let Some(person) = &change.person {
                    enqueue_later_weekly_intern_dtr(state, &mut tx, &person.user_id, &person.full_name, &person.employee_type, date).await;
                }
            }
        }
    }
    tx.commit().await?;

    let sequence = state.next_sequence();
    if let Some(cooldown_key) = change.tap {
        let mut debounce = state.scan_debounce.lock().await;
        let now = std::time::Instant::now();
        match debounce.get_mut(&cooldown_key) {
            Some(entry) => entry.slow = Some(now),
            None => {
                debounce.insert(cooldown_key, crate::state::ScanDebounce { fast: now, slow: Some(now) });
            }
        }
    }
    lan_notice(state, sequence, change.attendance_id, change.date, change.lan);
    if let Some(event) = change.window_event {
        let event_sequence = if event.own_sequence { state.next_sequence() } else { sequence };
        let payload = serde_json::json!({
            "attendanceId": change.attendance_id,
            "attendanceDate": change.date,
            "userId": event.user_id,
            "action": event.action,
            "timeIn": event.time_in,
            "timeOut": event.time_out,
            "status": event.status,
            "sequence": event_sequence
        });
        if let Some(app) = event.app {
            let _ = app.emit("attendance-updated", &payload);
        }
    }
    if let Some(entry) = change.audit {
        crate::services::audit::log(&state.db, entry).await;
    }
    Ok(())
}

/// Tell open LAN viewers that an attendance day changed; they refetch.
/// Only scans used to publish, so admin changes reached viewers only on a
/// manual refresh (O11). The one place the notice is sent from: a scan's
/// carries its row, request id and time; any other is stamped here.
pub(crate) fn lan_notice(state: &AppState, sequence: u64, attendance_id: &str, attendance_date: &str, notice: LanNotice<'_>) {
    let (request_id, occurred_at, attendance) = match notice.from_scan {
        Some((request_id, occurred_at, row)) => (request_id, occurred_at, Some(row)),
        None => (crate::services::audit::admin_request_id(), chrono::Utc::now(), None),
    };
    let _ = state
        .bus
        .sender
        .send(crate::lan_server::LanAttendanceEvent::AttendanceUpdated {
            event_id: format!("{}:{}", state.server_instance_id, sequence),
            server_instance_id: state.server_instance_id.to_string(),
            sequence,
            occurred_at,
            request_id,
            attendance_date: attendance_date.to_string(),
            attendance_id: attendance_id.to_string(),
            cause: notice.cause.to_string(),
            mutation: notice.mutation.to_string(),
            attendance,
        });
}

/// Mirror an attendance mutation to the intern DTR sheet (enqueue-only).
/// Same contract as the scan path: interns-only, configured-only,
/// fire-and-forget — a DTR failure can never fail the caller. Corrections
/// converge through the existing idempotent re-push; deletes clear the
/// date's cells via a separate InternDtr DELETE row (rows are never
/// removed from the sheet).
pub(crate) async fn enqueue_intern_dtr(
    state: &AppState,
    conn: &mut sqlx::SqliteConnection,
    attendance_id: &str,
    user_id: &str,
    full_name: &str,
    employee_type: &str,
    date: &str,
    time_in: Option<&str>,
    time_out: Option<&str>,
) {
    // Queued even while upload is switched off (owner decision D5): the
    // sync tick leaves InternDtr rows waiting until it is switched back on.
    if employee_type.to_uppercase() != "INTERN"
        || crate::config::dtr_spreadsheet_id_resolved(&state.lan).is_none()
    {
        return;
    }
    enqueue_sync_on(
        state,
        conn,
        crate::services::dtr_sync::DTR_TABLE_NAME,
        attendance_id,
        "UPSERT",
        &serde_json::json!({
            "userId": user_id,
            "fullName": full_name,
            "attendanceDate": date,
            "timeIn": time_in,
            "timeOut": time_out,
        }),
    )
    .await;
}

pub(crate) async fn enqueue_later_weekly_intern_dtr(
    state: &AppState,
    conn: &mut sqlx::SqliteConnection,
    user_id: &str,
    full_name: &str,
    employee_type: &str,
    changed_date: &str,
) {
    let Ok(rows) = crate::services::dtr_sync::later_attendance_in_manila_week(
        &mut *conn,
        user_id,
        changed_date,
    )
    .await
    else {
        return;
    };
    for (attendance_id, date, time_in, time_out) in rows {
        enqueue_intern_dtr(
            state,
            &mut *conn,
            &attendance_id,
            user_id,
            full_name,
            employee_type,
            &date,
            time_in.as_deref(),
            time_out.as_deref(),
        )
        .await;
    }
}

/// Monday (`YYYY-MM-DD`) of the Manila week of `date`: the key of a weekly
/// grace claim. An unreadable date maps to itself, which matches no claim.
pub(crate) fn manila_week_start(date: &str) -> String {
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map(|day| (day - chrono::Duration::days(day.weekday().num_days_from_monday() as i64)).to_string())
        .unwrap_or_else(|_| date.to_string())
}

/// What every attendance row says about its arrival. The payroll engine decides all four; the screens only show them.
pub(crate) struct ArrivalFields {
    pub(crate) status: Option<&'static str>,
    pub(crate) minutes_late: Option<i64>,
    /// The arrival took the week's grace claim. `None` for a row without a readable time-in.
    pub(crate) grace_used: Option<bool>,
    /// The time-in an intern's day is paid from: the scan itself, or the next full hour when the day's policy
    /// clamps it. `None` for anyone who is not an intern: the clamp is an intern pay rule.
    pub(crate) payable_time_in: Option<String>,
}

pub(crate) fn arrival_fields(date: &str, time_in: Option<&str>, grace_available: bool, is_intern: bool) -> ArrivalFields {
    let arrival = time_in.and_then(|stamp| crate::services::intern_payroll::arrival(date, stamp, grace_available));
    ArrivalFields {
        status: arrival.map(|a| a.status.as_str()),
        minutes_late: arrival.map(|a| a.minutes_late),
        grace_used: arrival.map(|a| a.status == crate::services::intern_payroll::ArrivalStatus::GracePeriod),
        payable_time_in: time_in
            .filter(|_| is_intern)
            .and_then(|stamp| crate::services::intern_payroll::payable_time_in(date, stamp, grace_available)),
    }
}

/// Arrival fields of one attendance row, as the payroll engine decides them
/// (same rule as `attendance_rows_json`).
pub(crate) async fn attendance_arrival(
    db: &sqlx::SqlitePool,
    user_id: &str,
    attendance_id: &str,
    date: &str,
    time_in: Option<&str>,
) -> ArrivalFields {
    let read: Option<(bool, bool)> = sqlx::query_as(
        "SELECT COALESCE((SELECT grace_used = 1 FROM payroll WHERE attendance_id = ?), \
         NOT EXISTS (SELECT 1 FROM intern_grace WHERE user_id = ? AND week_start = ? AND attendance_id != ?)), \
         COALESCE((SELECT employee_type = 'INTERN' FROM users WHERE user_id = ?), 0)",
    )
    .bind(attendance_id)
    .bind(user_id)
    .bind(manila_week_start(date))
    .bind(attendance_id)
    .bind(user_id)
    .fetch_one(db)
    .await
    .ok();
    match read {
        Some((grace_available, is_intern)) => arrival_fields(date, time_in, grace_available, is_intern),
        None => arrival_fields(date, None, false, false),
    }
}

/// Atomic wrapper: grace claim + payroll upsert commit together or not at all.
pub(crate) async fn ensure_payroll(
    state: &AppState,
    attendance_id: &str,
    user_id: &str,
    full_name: String,
    date: &str,
    actual_in: &str,
    actual_out: &str,
) -> Result<(), String> {
    let mut tx = state.db.begin().await.map_err(|e| e.to_string())?;
    let pending = ensure_payroll_tx(&mut tx, attendance_id, user_id, full_name, date, actual_in, actual_out).await?;
    flush_pending_sync(state, &mut tx, pending).await;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Runs entirely on the caller's connection/transaction (never touches the pool).
pub(crate) async fn ensure_payroll_tx(
    conn: &mut sqlx::SqliteConnection,
    attendance_id: &str,
    user_id: &str,
    full_name: String,
    date: &str,
    actual_in: &str,
    actual_out: &str,
) -> Result<Vec<PendingSync>, String> {
    let mut pending: Vec<PendingSync> = Vec::new();
    let (computed_in, computed_out, grace_used, late_hours, deduction, is_half_day, half_day_deduction, base_pay, daily_pay) = {
        let date_value =
            chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|e| e.to_string())?;
        let week_start = date_value
            - chrono::Duration::days(date_value.weekday().num_days_from_monday() as i64);
        let no_grace_cutover = crate::services::intern_payroll::policy_for_date(date).rules().weekly_grace_window_minutes.is_none();
        // Post-cutover skips grace-claim INSERT/DELETE, preserving pre-cutover history.
        let grace_available = if no_grace_cutover {
            false
        } else {
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM intern_grace WHERE user_id=? AND week_start=? AND attendance_id != ?",
            )
            .bind(user_id)
            .bind(week_start.to_string())
            .bind(attendance_id)
            .fetch_one(&mut *conn)
            .await
            .map_err(|e| e.to_string())?
                == 0
        };
        let mut result = crate::services::intern_payroll::calculate(
            date,
            actual_in,
            actual_out,
            grace_available,
        )?;
        if result.grace_used && !no_grace_cutover {
            let grace_id = uuid::Uuid::new_v4().to_string();
            let used_at = chrono::Utc::now().to_rfc3339();
            let inserted = sqlx::query("INSERT OR IGNORE INTO intern_grace (grace_id,user_id,week_start,attendance_id,used_at) VALUES (?,?,?,?,?)").bind(&grace_id).bind(user_id).bind(week_start.to_string()).bind(attendance_id).bind(&used_at).execute(&mut *conn).await.map_err(|e| e.to_string())?.rows_affected() == 1;
            if inserted {
                pending.push(("InternGrace", grace_id.clone(), "UPSERT", serde_json::json!({"graceId":grace_id,"userId":user_id,"weekStart":week_start.to_string(),"attendanceId":attendance_id,"usedAt":used_at})));
            } else {
                let own_claim: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM intern_grace WHERE user_id=? AND week_start=? AND attendance_id=?",
                )
                .bind(user_id)
                .bind(week_start.to_string())
                .bind(attendance_id)
                .fetch_one(&mut *conn)
                .await
                .map_err(|e| e.to_string())?;
                if own_claim == 0 {
                    result = crate::services::intern_payroll::calculate(
                date,
                actual_in,
                actual_out,
                        false,
                    )?;
                }
            }
        } else if !no_grace_cutover {
            sqlx::query("DELETE FROM intern_grace WHERE attendance_id=?")
                .bind(attendance_id)
                .execute(&mut *conn)
                .await
                .map_err(|e| e.to_string())?;
        }
        (
            result.computed_time_in,
            result.computed_time_out,
            Some(result.grace_used),
            result.late_hours,
            result.late_deduction_centavos,
            result.is_half_day,
            result.half_day_deduction_centavos,
            result.base_pay_centavos,
            result.daily_pay_centavos,
        )
    };
    let now = chrono::Utc::now().to_rfc3339();
    let payroll_id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO payroll (payroll_id,attendance_id,user_id,full_name,employee_type,attendance_date,actual_time_in,actual_time_out,computed_time_in,computed_time_out,grace_used,late_hours,late_deduction_centavos,base_pay_centavos,daily_pay_centavos,is_half_day,half_day_deduction_centavos,created_at,updated_at,policy_version) \
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) \
         ON CONFLICT(attendance_id) DO UPDATE SET \
           user_id=excluded.user_id, \
           full_name=excluded.full_name, \
           employee_type=excluded.employee_type, \
           attendance_date=excluded.attendance_date, \
           actual_time_in=excluded.actual_time_in, \
           actual_time_out=excluded.actual_time_out, \
           computed_time_in=excluded.computed_time_in, \
           computed_time_out=excluded.computed_time_out, \
           grace_used=excluded.grace_used, \
           late_hours=excluded.late_hours, \
           late_deduction_centavos=excluded.late_deduction_centavos, \
           base_pay_centavos=excluded.base_pay_centavos, \
           daily_pay_centavos=excluded.daily_pay_centavos, \
           is_half_day=excluded.is_half_day, \
           half_day_deduction_centavos=excluded.half_day_deduction_centavos, \
           updated_at=excluded.updated_at, \
           policy_version=excluded.policy_version",
    )
    .bind(&payroll_id).bind(attendance_id).bind(user_id).bind(&full_name).bind("INTERN").bind(date).bind(actual_in).bind(actual_out).bind(&computed_in).bind(&computed_out).bind(grace_used.map(|v| if v {1} else {0})).bind(late_hours).bind(deduction).bind(base_pay).bind(daily_pay).bind(if is_half_day { 1 } else { 0 }).bind(half_day_deduction).bind(&now).bind(&now).bind(crate::services::intern_payroll::policy_for_date(date).as_str())
    .execute(&mut *conn).await.map_err(|e| e.to_string())?;

    let effective_payroll_id: String = sqlx::query_scalar(
        "SELECT payroll_id FROM payroll WHERE attendance_id=?"
    )
    .bind(attendance_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;

    pending.push(("Payroll", effective_payroll_id.clone(), "UPSERT", serde_json::json!({"payrollId":effective_payroll_id,"attendanceId":attendance_id,"userId":user_id,"employeeType":"INTERN","attendanceDate":date,"actualTimeIn":actual_in,"actualTimeOut":actual_out,"computedTimeIn":computed_in,"computedTimeOut":computed_out,"lateHours":late_hours,"lateDeductionCentavos":deduction,"isHalfDay":is_half_day,"halfDayDeductionCentavos":half_day_deduction,"dailyPayCentavos":daily_pay})));
    Ok(pending)
}

pub(crate) async fn reconcile_attendance_payroll_range(
    state: &AppState,
    start_date: &str,
    end_date: &str,
    excluded_employee_ids: &std::collections::HashSet<String>,
) -> Result<Vec<String>, String> {
    let rows = sqlx::query(
        "SELECT a.attendance_id, a.attendance_date, a.user_id, a.full_name, \
         COALESCE(u.employee_type, 'INTERN') AS employee_type, \
         u.daily_rate_centavos, a.time_in, a.time_out \
         FROM attendance a \
         LEFT JOIN users u ON u.user_id = a.user_id \
         WHERE a.attendance_date >= ? AND a.attendance_date <= ? \
           AND a.status IN ('COMPLETED', 'LATE_TIMEOUT') \
           AND a.time_in IS NOT NULL \
           AND a.time_out IS NOT NULL \
         ORDER BY a.attendance_date ASC, a.time_in ASC",
    )
    .bind(start_date)
    .bind(end_date)
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    // Days inside any finalized cutoff are frozen, even when this range only overlaps it.
    let frozen: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT employee_id, cutoff_start, cutoff_end FROM payroll_cutoffs 
         WHERE status='FINALIZED' AND cutoff_end >= ? AND cutoff_start <= ?",
    )
    .bind(start_date)
    .bind(end_date)
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    // One unpayable row must not block everyone else; report it instead.
    let mut warnings: Vec<String> = Vec::new();

    for row in rows {
        let attendance_id: String = row.get("attendance_id");
        let user_id: String = row.get("user_id");
        if excluded_employee_ids.contains(&user_id) {
            continue;
        }
        let full_name: String = row.get("full_name");
        let date: String = row.get("attendance_date");
        if frozen
            .iter()
            .any(|(id, from, to)| *id == user_id && from.as_str() <= date.as_str() && date.as_str() <= to.as_str())
        {
            continue;
        }
        let actual_in: String = row.get("time_in");
        let actual_out: String = row.get("time_out");

        if let Err(error) = ensure_payroll(
            state,
            &attendance_id,
            &user_id,
            full_name.clone(),
            &date,
            &actual_in,
            &actual_out,
        )
        .await
        {
            log::warn!("payroll skipped for {full_name} on {date}: {error}");
            warnings.push(format!("{full_name} {date}: {error}"));
        }
    }

    let _ = sqlx::query(
        "DELETE FROM payroll \
         WHERE attendance_date >= ? AND attendance_date <= ? \
           AND user_id NOT IN (SELECT employee_id FROM payroll_cutoffs WHERE cutoff_start=? AND cutoff_end=? AND status='FINALIZED') \
           AND attendance_id NOT IN ( \
             SELECT attendance_id FROM attendance \
             WHERE attendance_date >= ? AND attendance_date <= ? \
               AND status IN ('COMPLETED', 'LATE_TIMEOUT') \
               AND time_in IS NOT NULL \
               AND time_out IS NOT NULL \
           )",
    )
    .bind(start_date)
    .bind(end_date)
    .bind(start_date)
    .bind(end_date)
    .bind(start_date)
    .bind(end_date)
    .execute(&state.db)
    .await;

    Ok(warnings)
}
