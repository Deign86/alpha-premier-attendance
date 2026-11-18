use chrono::Datelike;
use crate::services::intern_payroll::INTERN_DAILY_RATE_PHP;
use crate::services::intern_payroll::INTERN_PAYROLL_PROFILE_ID;
use crate::state::AppState;
use sha2::{Digest, Sha256};
use sqlx::Row;
use sqlx::sqlite::SqliteRow;
use std::collections::HashMap;
use crate::services::attendance::reconcile_attendance_payroll_range;
use super::session::Admin;
use crate::services::sync_queue::enqueue_sync_on;
use tauri::State;

#[tauri::command]
pub(crate) async fn payroll_list_profiles(
    state: State<'_, AppState>,
    token: String,
) -> Result<serde_json::Value, String> {
    Admin::check(&state, &token).await?;
    let rows = sqlx::query("SELECT profile_id,label,payroll_frequency,standard_working_days_per_cutoff,incentives_allowance_centavos,special_allowance_centavos,special_holiday_multiplier,regular_holiday_multiplier,half_day_fraction,overtime_rate_centavos FROM payroll_profiles ORDER BY profile_id").fetch_all(&state.db).await.map_err(|e| e.to_string())?;
    Ok(
        serde_json::json!({"success":true,"profiles":rows.into_iter().map(|r| serde_json::json!({"profileId":r.get::<String,_>("profile_id"),"label":r.get::<String,_>("label"),"payrollFrequency":r.get::<String,_>("payroll_frequency"),"standardWorkingDaysPerCutoff":r.get::<f64,_>("standard_working_days_per_cutoff"),"incentivesAllowance":r.get::<i64,_>("incentives_allowance_centavos") as f64 / 100.0,"specialAllowance":r.get::<i64,_>("special_allowance_centavos") as f64 / 100.0,"specialHolidayMultiplier":r.get::<f64,_>("special_holiday_multiplier"),"regularHolidayMultiplier":r.get::<f64,_>("regular_holiday_multiplier"),"halfDayFraction":r.get::<f64,_>("half_day_fraction"),"overtimeRate":r.get::<i64,_>("overtime_rate_centavos") as f64 / 100.0})).collect::<Vec<_>>() }),
    )
}

#[tauri::command]
pub(crate) async fn payroll_upsert_profile(
    state: State<'_, AppState>,
    token: String,
    profile: serde_json::Value,
) -> Result<serde_json::Value, String> {
    Admin::check(&state, &token).await?;
    let id = profile
        .get("profileId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let label = profile
        .get("label")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if id.is_empty() || label.is_empty() {
        return Err("ADMIN_VALIDATION_ERROR".into());
    }
    let numeric_fields = [
        "standardWorkingDaysPerCutoff",
        "incentivesAllowance",
        "specialAllowance",
        "specialHolidayMultiplier",
        "regularHolidayMultiplier",
        "halfDayFraction",
        "overtimeRate",
    ];
    if profile.get("payrollFrequency").and_then(|value| value.as_str()) != Some("SEMI_MONTHLY")
        || numeric_fields.iter().any(|field| {
            profile
                .get(*field)
                .and_then(|value| value.as_f64())
                .is_none_or(|value| !value.is_finite() || value < 0.0)
        })
    {
        return Err("ADMIN_VALIDATION_ERROR".into());
    }
    let incentives_allowance = profile
        .get("incentivesAllowance")
        .and_then(|v| v.as_f64())
        .map(php_to_centavos)
        .unwrap_or(0);
    let special_allowance = profile
        .get("specialAllowance")
        .and_then(|v| v.as_f64())
        .map(php_to_centavos)
        .unwrap_or(0);
    let overtime_rate = profile
        .get("overtimeRate")
        .and_then(|v| v.as_f64())
        .map(php_to_centavos)
        .unwrap_or(0);
    let now = chrono::Utc::now().to_rfc3339();
    // The profile and its sync row commit together (O4).
    let mut tx = state.db.begin().await.map_err(|e| e.to_string())?;
    sqlx::query("INSERT INTO payroll_profiles (profile_id,label,payroll_frequency,standard_working_days_per_cutoff,incentives_allowance_centavos,special_allowance_centavos,special_holiday_multiplier,regular_holiday_multiplier,half_day_fraction,overtime_rate_centavos,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET label=excluded.label,standard_working_days_per_cutoff=excluded.standard_working_days_per_cutoff,incentives_allowance_centavos=excluded.incentives_allowance_centavos,special_allowance_centavos=excluded.special_allowance_centavos,special_holiday_multiplier=excluded.special_holiday_multiplier,regular_holiday_multiplier=excluded.regular_holiday_multiplier,half_day_fraction=excluded.half_day_fraction,overtime_rate_centavos=excluded.overtime_rate_centavos,revision=payroll_profiles.revision+1,updated_at=excluded.updated_at")
        .bind(id).bind(label).bind("SEMI_MONTHLY").bind(profile.get("standardWorkingDaysPerCutoff").and_then(|v| v.as_f64()).unwrap_or(11.0)).bind(incentives_allowance).bind(special_allowance).bind(profile.get("specialHolidayMultiplier").and_then(|v| v.as_f64()).unwrap_or(0.3)).bind(profile.get("regularHolidayMultiplier").and_then(|v| v.as_f64()).unwrap_or(1.0)).bind(profile.get("halfDayFraction").and_then(|v| v.as_f64()).unwrap_or(0.5)).bind(overtime_rate).bind(&now).bind(&now).execute(&mut *tx).await.map_err(|e| e.to_string())?;
    enqueue_sync_on(&state, &mut tx, "PayrollProfiles", id, "UPSERT", &profile).await;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(serde_json::json!({"success":true,"profileId":id}))
}

#[tauri::command]
pub(crate) async fn payroll_delete_profile(
    state: State<'_, AppState>,
    token: String,
    profile_id: String,
) -> Result<serde_json::Value, String> {
    Admin::check(&state, &token).await?;
    let profile_id = profile_id.trim();
    if profile_id.is_empty() {
        return Err("ADMIN_VALIDATION_ERROR".into());
    }
    let assigned: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE payroll_profile_id = ?")
        .bind(profile_id)
        .fetch_one(&state.db)
        .await
        .map_err(|error| error.to_string())?;
    if assigned > 0 {
        return Err("PAYROLL_PROFILE_ASSIGNED".into());
    }
    // The delete and its sync row commit together (O4).
    let mut tx = state.db.begin().await.map_err(|e| e.to_string())?;
    let result = sqlx::query("DELETE FROM payroll_profiles WHERE profile_id = ?")
        .bind(profile_id)
        .execute(&mut *tx)
        .await
        .map_err(|error| error.to_string())?;
    if result.rows_affected() == 0 {
        return Err("PAYROLL_PROFILE_NOT_FOUND".into());
    }
    enqueue_sync_on(&state, &mut tx, "PayrollProfiles", profile_id, "DELETE", &serde_json::json!({"profileId": profile_id})).await;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(serde_json::json!({"success":true}))
}

/// The cutoff list as `payroll_cutoff_json` reads it.
const CUTOFF_LIST_SQL: &str = "SELECT pc.payroll_id, pc.employee_id, pc.employee_name, pc.payroll_profile_id, pc.payroll_cutoff_label, \
     pc.cutoff_start, pc.cutoff_end, pc.daily_rate_centavos, pc.standard_working_days, pc.actual_working_days, \
     pc.basic_pay_centavos, pc.special_holiday_days, pc.special_holiday_multiplier, pc.special_holiday_pay_centavos, \
     pc.regular_holiday_days, pc.regular_holiday_multiplier, pc.regular_holiday_pay_centavos, \
     pc.incentives_allowance_centavos, pc.special_allowance_centavos, pc.total_compensation_centavos, \
     pc.total_allowance_centavos, pc.late_units, pc.late_deduction_centavos, pc.half_day_count, \
     pc.half_day_deduction_centavos, pc.absent_days, pc.absence_deduction_centavos, pc.overtime_hours, \
     pc.overtime_rate_centavos, pc.overtime_pay_centavos, pc.manual_adjustment_centavos, pc.adjustment_reason, \
     pc.gross_compensation_centavos, pc.net_pay_centavos, pc.signature_placeholder, pc.calculation_breakdown, \
     pc.approved_working_day_overage, pc.status, pc.finalized_at, pc.revision, \
     pc.hra_centavos, pc.sss_centavos, pc.phic_centavos, pc.hdmf_centavos, pc.salary_advance_centavos, \
     COALESCE(NULLIF(pc.tin, ''), u.tin, '') AS tin, \
     COALESCE(NULLIF(pc.bank_name, ''), u.bank_name, 'CASH') AS bank_name, \
     COALESCE(NULLIF(pc.account_number, ''), u.account_number, '0000') AS account_number, \
     COALESCE(NULLIF(pc.department, ''), u.department, '') AS department, \
     COALESCE(NULLIF(pc.designation, ''), u.designation, u.employee_type, 'EMPLOYEE') AS designation \
     FROM payroll_cutoffs pc LEFT JOIN users u ON u.user_id = pc.employee_id \
     ORDER BY pc.cutoff_start DESC, pc.employee_name";

#[tauri::command]
pub(crate) async fn payroll_list_cutoffs(
    state: State<'_, AppState>,
    token: String,
) -> Result<serde_json::Value, String> {
    Admin::check(&state, &token).await?;
    let mut rows = sqlx::query(CUTOFF_LIST_SQL)
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    // Newest cutoff first; within a cutoff, last-name alphabetical (the
    // displayed employeeName stays as stored).
    rows.sort_by_cached_key(|row| {
        crate::reporting::payroll_row_order_key(
            &row.get::<String, _>("cutoff_start"),
            &row.get::<String, _>("employee_name"),
            &row.get::<String, _>("employee_id"),
        )
    });
    // Payroll cutoff rows do not store an employee type; derive intern vs
    // employee classification from the Users register so the printable
    // worksheet can apply the intern layout and labels.
    let employee_types: HashMap<String, String> =
        sqlx::query("SELECT user_id, employee_type FROM users")
            .fetch_all(&state.db)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|row| {
                (
                    row.get::<String, _>("user_id"),
                    row.get::<String, _>("employee_type"),
                )
            })
            .collect();
    Ok(
        serde_json::json!({"success":true,"payroll":rows.iter().map(|row| payroll_cutoff_json(row, employee_types.get(&row.get::<String,_>("employee_id")).map(String::as_str))).collect::<Vec<_>>() }),
    )
}

pub(crate) fn payroll_cutoff_json(row: &SqliteRow, employee_type: Option<&str>) -> serde_json::Value {
    // Built as an explicit map so the value never depends on the json! macro
    // recursion budget (the record is large and frequently extended).
    let mut map = serde_json::Map::new();
    let mut insert = |key: &str, value: serde_json::Value| {
        map.insert(key.into(), value);
    };
    insert(
        "payrollId",
        serde_json::json!(row.get::<String, _>("payroll_id")),
    );
    insert(
        "employeeId",
        serde_json::json!(row.get::<String, _>("employee_id")),
    );
    insert(
        "employeeName",
        serde_json::json!(row.get::<String, _>("employee_name")),
    );
    insert(
        "employeeType",
        serde_json::json!(if employee_type == Some("EMPLOYEE") {
            "EMPLOYEE"
        } else {
            "INTERN"
        }),
    );
    insert(
        "payrollProfileId",
        serde_json::json!(row.get::<String, _>("payroll_profile_id")),
    );
    insert(
        "payrollCutoffLabel",
        serde_json::json!(row.get::<String, _>("payroll_cutoff_label")),
    );
    insert(
        "cutoffStart",
        serde_json::json!(row.get::<String, _>("cutoff_start")),
    );
    insert(
        "cutoffEnd",
        serde_json::json!(row.get::<String, _>("cutoff_end")),
    );
    insert("payrollFrequency", serde_json::json!("SEMI_MONTHLY"));
    insert(
        "dailyRate",
        serde_json::json!(row.get::<i64, _>("daily_rate_centavos") as f64 / 100.0),
    );
    insert(
        "standardWorkingDays",
        serde_json::json!(row.get::<f64, _>("standard_working_days")),
    );
    insert(
        "actualWorkingDays",
        serde_json::json!(row.get::<f64, _>("actual_working_days")),
    );
    insert(
        "basicPay",
        serde_json::json!(row.get::<i64, _>("basic_pay_centavos") as f64 / 100.0),
    );
    insert(
        "specialHolidayDays",
        serde_json::json!(row.get::<f64, _>("special_holiday_days")),
    );
    insert(
        "specialHolidayMultiplier",
        serde_json::json!(row.get::<f64, _>("special_holiday_multiplier")),
    );
    insert(
        "specialHolidayPay",
        serde_json::json!(row.get::<i64, _>("special_holiday_pay_centavos") as f64 / 100.0),
    );
    insert(
        "regularHolidayDays",
        serde_json::json!(row.get::<f64, _>("regular_holiday_days")),
    );
    insert(
        "regularHolidayMultiplier",
        serde_json::json!(row.get::<f64, _>("regular_holiday_multiplier")),
    );
    insert(
        "regularHolidayPay",
        serde_json::json!(row.get::<i64, _>("regular_holiday_pay_centavos") as f64 / 100.0),
    );
    let hra = row.get::<i64, _>("hra_centavos") as f64 / 100.0;
    let incentives = row.get::<i64, _>("incentives_allowance_centavos") as f64 / 100.0;
    let special_allowance = row.get::<i64, _>("special_allowance_centavos") as f64 / 100.0;
    let late_ded = row.get::<i64, _>("late_deduction_centavos") as f64 / 100.0;
    let half_ded = row.get::<i64, _>("half_day_deduction_centavos") as f64 / 100.0;
    let abs_ded = row.get::<i64, _>("absence_deduction_centavos") as f64 / 100.0;
    let sss = row.get::<i64, _>("sss_centavos") as f64 / 100.0;
    let phic = row.get::<i64, _>("phic_centavos") as f64 / 100.0;
    let hdmf = row.get::<i64, _>("hdmf_centavos") as f64 / 100.0;
    let salary_advance = row.get::<i64, _>("salary_advance_centavos") as f64 / 100.0;
    let total_deductions = late_ded + half_ded + abs_ded + sss + phic + hdmf + salary_advance;

    insert("hra", serde_json::json!(hra));
    insert("incentivesAllowance", serde_json::json!(incentives));
    insert("specialAllowance", serde_json::json!(special_allowance));
    insert(
        "totalCompensation",
        serde_json::json!(row.get::<i64, _>("total_compensation_centavos") as f64 / 100.0),
    );
    insert(
        "totalAllowance",
        serde_json::json!(row.get::<i64, _>("total_allowance_centavos") as f64 / 100.0),
    );
    insert(
        "lateUnits",
        serde_json::json!(row.get::<f64, _>("late_units")),
    );
    insert("lateDeduction", serde_json::json!(late_ded));
    insert(
        "halfDayCount",
        serde_json::json!(row.get::<f64, _>("half_day_count")),
    );
    insert("halfDayDeduction", serde_json::json!(half_ded));
    insert(
        "absentDays",
        serde_json::json!(row.get::<f64, _>("absent_days")),
    );
    insert("absenceDeduction", serde_json::json!(abs_ded));
    insert(
        "overtimeHours",
        serde_json::json!(row.get::<f64, _>("overtime_hours")),
    );
    insert(
        "overtimeRate",
        serde_json::json!(row.get::<i64, _>("overtime_rate_centavos") as f64 / 100.0),
    );
    insert(
        "overtimePay",
        serde_json::json!(row.get::<i64, _>("overtime_pay_centavos") as f64 / 100.0),
    );
    insert("sss", serde_json::json!(sss));
    insert("phic", serde_json::json!(phic));
    insert("hdmf", serde_json::json!(hdmf));
    insert("salaryAdvance", serde_json::json!(salary_advance));
    insert("totalDeductions", serde_json::json!(total_deductions));
    insert(
        "tin",
        serde_json::json!(row.get::<String, _>("tin")),
    );
    insert(
        "bankName",
        serde_json::json!(row.get::<String, _>("bank_name")),
    );
    insert(
        "accountNumber",
        serde_json::json!(row.get::<String, _>("account_number")),
    );
    insert(
        "department",
        serde_json::json!(row.get::<String, _>("department")),
    );
    insert(
        "designation",
        serde_json::json!(row.get::<String, _>("designation")),
    );
    insert(
        "manualAdjustment",
        serde_json::json!(row.get::<i64, _>("manual_adjustment_centavos") as f64 / 100.0),
    );
    insert(
        "adjustmentReason",
        serde_json::json!(row.get::<Option<String>, _>("adjustment_reason")),
    );
    insert(
        "grossCompensation",
        serde_json::json!(row.get::<i64, _>("gross_compensation_centavos") as f64 / 100.0),
    );
    insert(
        "netPay",
        serde_json::json!(row.get::<i64, _>("net_pay_centavos") as f64 / 100.0),
    );
    // The clamped time-in is an intern rule; an employee's breakdown is given as stored.
    let stored_breakdown = row.get::<String, _>("calculation_breakdown");
    insert(
        "calculationBreakdown",
        serde_json::json!(if employee_type == Some("EMPLOYEE") {
            stored_breakdown
        } else {
            crate::services::intern_payroll::breakdown_with_payable_time_in(&stored_breakdown)
        }),
    );
    insert(
        "approvedWorkingDayOverage",
        serde_json::json!(row.get::<i64, _>("approved_working_day_overage") != 0),
    );
    insert("status", serde_json::json!(row.get::<String, _>("status")));
    insert(
        "finalizedAt",
        serde_json::json!(row.get::<Option<String>, _>("finalized_at")),
    );
    insert("revision", serde_json::json!(row.get::<i64, _>("revision")));
    serde_json::Value::Object(map)
}

#[tauri::command]
pub(crate) async fn payroll_intern_report(
    state: State<'_, AppState>,
    token: String,
    cutoff_start: String,
    cutoff_end: String,
    payroll_cutoff_label: String,
) -> Result<serde_json::Value, String> {
    Admin::check(&state, &token).await?;
    chrono::NaiveDate::parse_from_str(&cutoff_start, "%Y-%m-%d")
        .map_err(|_| "INVALID_CUTOFF_DATES".to_string())?;
    chrono::NaiveDate::parse_from_str(&cutoff_end, "%Y-%m-%d")
        .map_err(|_| "INVALID_CUTOFF_DATES".to_string())?;
    if cutoff_end < cutoff_start {
        return Err("INVALID_CUTOFF_DATES".into());
    }
    let finalized_employee_ids = sqlx::query_scalar::<_, String>(
        "SELECT employee_id FROM payroll_cutoffs WHERE cutoff_start=? AND cutoff_end=? AND status='FINALIZED'",
    )
    .bind(&cutoff_start)
    .bind(&cutoff_end)
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?
    .into_iter()
    .collect::<std::collections::HashSet<_>>();
    // Rows that cannot be priced are logged and skipped, not fatal for the report.
    let _skipped = reconcile_attendance_payroll_range(
        &state,
        &cutoff_start,
        &cutoff_end,
        &finalized_employee_ids,
    )
    .await?;
    let rows = sqlx::query(
        "SELECT u.user_id, u.full_name, \
         COALESCE(COUNT(p.payroll_id), 0) AS actual_days, \
         COALESCE(SUM(CASE WHEN p.is_half_day = 1 THEN 1 ELSE 0 END), 0) AS half_day_count, \
         COALESCE(SUM(p.half_day_deduction_centavos), 0) AS half_day_deduction_centavos, \
         COALESCE(SUM(p.base_pay_centavos), 0) AS basic_pay, \
         COALESCE(SUM(p.late_hours), 0) AS late_units, \
         COALESCE(SUM(p.late_deduction_centavos), 0) AS late_deduction \
         FROM users u \
         LEFT JOIN payroll p ON p.user_id = u.user_id AND p.attendance_date >= ? AND p.attendance_date <= ? \
         WHERE u.employee_type = 'INTERN' \
         GROUP BY u.user_id, u.full_name \
         ORDER BY u.full_name",
    )
    .bind(&cutoff_start)
    .bind(&cutoff_end)
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    let payroll = rows
        .into_iter()
        .map(|row| {
            let actual_days = row.get::<i64, _>("actual_days") as f64;
            let daily_rate = 80.0;
            let half_day_deduction = row.get::<i64, _>("half_day_deduction_centavos") as f64 / 100.0;
            let half_day_count = if daily_rate * 0.5 > 0.0 {
                half_day_deduction / (daily_rate * 0.5)
            } else {
                row.get::<i64, _>("half_day_count") as f64
            };
            let standard_days = 11.0;
            let absent_days = (standard_days - actual_days).max(0.0);
            let total_comp = standard_days * daily_rate;
            let absence_deduction = absent_days * daily_rate;
            let late_units = row.get::<i64, _>("late_units") as f64;
            let late_deduction = row.get::<i64, _>("late_deduction") as f64 / 100.0;
            let total_deductions = late_deduction + half_day_deduction + absence_deduction;
            let gross = (total_comp - total_deductions).max(0.0);
            let user_id = row.get::<String, _>("user_id");
            serde_json::json!({
                "payrollId": format!("INTERN-{}-{}-{}", user_id, cutoff_start, cutoff_end),
                "employeeId": user_id,
                "employeeName": row.get::<String, _>("full_name"),
                "employeeType": "INTERN",
                "payrollProfileId": "INTERN_STANDARD",
                "payrollCutoffLabel": payroll_cutoff_label,
                "cutoffStart": cutoff_start,
                "cutoffEnd": cutoff_end,
                "payrollFrequency": "SEMI_MONTHLY",
                "dailyRate": daily_rate,
                "standardWorkingDays": standard_days,
                "actualWorkingDays": actual_days,
                "basicPay": total_comp,
                "specialHolidayDays": 0,
                "specialHolidayMultiplier": 0,
                "specialHolidayPay": 0,
                "regularHolidayDays": 0,
                "regularHolidayMultiplier": 0,
                "regularHolidayPay": 0,
                "incentivesAllowance": 0,
                "specialAllowance": 0,
                "totalCompensation": total_comp,
                "totalAllowance": 0,
                "lateUnits": late_units,
                "lateDeduction": late_deduction,
                "halfDayCount": half_day_count,
                "halfDayDeduction": half_day_deduction,
                "absentDays": absent_days,
                "absenceDeduction": absence_deduction,
                "overtimeHours": 0,
                "overtimeRate": 0,
                "overtimePay": 0,
                "manualAdjustment": 0,
                "adjustmentReason": null,
                "grossCompensation": gross,
                "netPay": gross,
                "calculationBreakdown": "attendance report",
                "approvedWorkingDayOverage": true,
                "status": "REPORT",
                "finalizedAt": null,
                "revision": 1
            })
        })
        .collect::<Vec<_>>();
    Ok(serde_json::json!({"success":true,"payroll":payroll}))
}

pub(crate) fn count_workdays(start_str: &str, end_str: &str) -> f64 {
    if let (Ok(start), Ok(end)) = (
        chrono::NaiveDate::parse_from_str(start_str, "%Y-%m-%d"),
        chrono::NaiveDate::parse_from_str(end_str, "%Y-%m-%d"),
    ) {
        if end >= start {
            use chrono::Datelike;
            let mut current = start;
            let mut workdays = 0.0;
            while current <= end {
                if current.weekday().number_from_monday() <= 5 {
                    workdays += 1.0;
                }
                current += chrono::Duration::days(1);
            }
            return workdays;
        }
    }
    11.0
}

/// Build the printable payroll register from completed attendance payroll rows.
/// Drafts are replaceable so a later time-out is reflected on regeneration;
/// finalized payroll remains an immutable approved record.
#[tauri::command]
pub(crate) async fn payroll_generate_cutoff(
    state: State<'_, AppState>,
    token: String,
    cutoff_start: String,
    cutoff_end: String,
    payroll_cutoff_label: String,
    customization: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let admin = Admin::check(&state, &token).await?;
    payroll_generate_cutoff_impl(
        &state,
        &admin,
        cutoff_start,
        cutoff_end,
        payroll_cutoff_label,
        customization,
    )
    .await
}

pub(crate) async fn payroll_generate_cutoff_impl(
    state: &AppState,
    _admin: &Admin,
    cutoff_start: String,
    cutoff_end: String,
    payroll_cutoff_label: String,
    customization: serde_json::Value,
) -> Result<serde_json::Value, String> {
    chrono::NaiveDate::parse_from_str(&cutoff_start, "%Y-%m-%d")
        .map_err(|_| "INVALID_CUTOFF_DATES".to_string())?;
    chrono::NaiveDate::parse_from_str(&cutoff_end, "%Y-%m-%d")
        .map_err(|_| "INVALID_CUTOFF_DATES".to_string())?;
    if cutoff_end < cutoff_start {
        return Err("INVALID_CUTOFF_DATES".into());
    }

    let finalized_employee_ids = sqlx::query_scalar::<_, String>(
        "SELECT employee_id FROM payroll_cutoffs WHERE cutoff_start=? AND cutoff_end=? AND status='FINALIZED'",
    )
    .bind(&cutoff_start)
    .bind(&cutoff_end)
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?
    .into_iter()
    .collect::<std::collections::HashSet<_>>();
    let reconcile_warnings = reconcile_attendance_payroll_range(
        state,
        &cutoff_start,
        &cutoff_end,
        &finalized_employee_ids,
    )
    .await?;

    // A draft is a live view of attendance. Remove the prior generated draft
    // before rebuilding it, while preserving approved cutoff records.
    // One transaction from here (O5): a failure part-way used to leave the
    // old drafts deleted and only some rebuilt. The replaced drafts are
    // deleted on the sheet too (their ids are not reused), and every sync
    // row commits with the drafts it mirrors.
    let mut tx = state.db.begin().await.map_err(|e| e.to_string())?;
    let replaced: Vec<(String, String, String, String)> =
        if let Some(selected_id) = customization.get("employeeId").and_then(|v| v.as_str()) {
            sqlx::query_as("DELETE FROM payroll_cutoffs WHERE employee_id=? AND cutoff_start=? AND cutoff_end=? AND status='DRAFT' AND employee_id NOT IN (SELECT employee_id FROM payroll_cutoffs WHERE cutoff_start=? AND cutoff_end=? AND status='FINALIZED') RETURNING payroll_id, employee_id, employee_name, payroll_cutoff_label")
                .bind(selected_id).bind(&cutoff_start).bind(&cutoff_end).bind(&cutoff_start).bind(&cutoff_end).fetch_all(&mut *tx).await.map_err(|e| e.to_string())?
        } else {
            sqlx::query_as(
                "DELETE FROM payroll_cutoffs WHERE cutoff_start=? AND cutoff_end=? AND status='DRAFT' AND employee_id NOT IN (SELECT employee_id FROM payroll_cutoffs WHERE cutoff_start=? AND cutoff_end=? AND status='FINALIZED') RETURNING payroll_id, employee_id, employee_name, payroll_cutoff_label",
            )
            .bind(&cutoff_start)
            .bind(&cutoff_end)
            .bind(&cutoff_start)
            .bind(&cutoff_end)
            .fetch_all(&mut *tx)
            .await
            .map_err(|e| e.to_string())?
        };
    for (payroll_id, employee_id, employee_name, label) in replaced {
        enqueue_sync_on(
            state,
            &mut tx,
            "PayrollCutoffs",
            &payroll_id,
            "DELETE",
            &serde_json::json!({"payrollId": payroll_id, "employeeId": employee_id, "employeeName": employee_name, "payrollCutoffLabel": label, "cutoffStart": cutoff_start, "cutoffEnd": cutoff_end}),
        )
        .await;
    }

    let rows = sqlx::query(
        "SELECT p.user_id, MAX(p.full_name) AS full_name, MAX(p.employee_type) AS employee_type, \
         COALESCE(MAX(u.daily_rate_centavos), MAX(p.base_pay_centavos), 0) AS daily_rate_centavos, \
         COUNT(*) AS actual_days, \
         SUM(CASE WHEN p.is_half_day = 1 THEN 1 ELSE 0 END) AS half_day_count, \
         COALESCE(SUM(p.half_day_deduction_centavos), 0) AS half_day_deduction_centavos, \
         SUM(p.late_hours) AS late_units, \
         u.payroll_profile_id \
         FROM payroll p JOIN users u ON u.user_id=p.user_id \
         WHERE p.attendance_date >= ? AND p.attendance_date <= ? \
         GROUP BY p.user_id, u.payroll_profile_id \
         ORDER BY full_name"
    ).bind(&cutoff_start).bind(&cutoff_end).fetch_all(&mut *tx).await.map_err(|e| e.to_string())?;

    let now = chrono::Utc::now().to_rfc3339();
    let mut generated = 0usize;
    for row in rows {
        let employee_id: String = row.get("user_id");
        if let Some(selected_id) = customization.get("employeeId").and_then(|v| v.as_str()) {
            if selected_id != employee_id {
                continue;
            }
        }
        let employee_name: String = row.get("full_name");
        let employee_type: String = row.get("employee_type");
        let is_intern = employee_type != "EMPLOYEE";
        if finalized_employee_ids.contains(&employee_id) {
            continue;
        }
        let profile_id = if is_intern {
            INTERN_PAYROLL_PROFILE_ID.to_string()
        } else {
            customization
                .get("payrollProfileId")
                .and_then(|v| v.as_str())
                .map(String::from)
                .or_else(|| row.get::<Option<String>, _>("payroll_profile_id"))
                .unwrap_or_else(|| "BEA_STANDARD".into())
        };
        let profile = sqlx::query("SELECT standard_working_days_per_cutoff,incentives_allowance_centavos,special_allowance_centavos,special_holiday_multiplier,regular_holiday_multiplier,half_day_fraction,overtime_rate_centavos FROM payroll_profiles WHERE profile_id=?")
            .bind(&profile_id).fetch_optional(&mut *tx).await.map_err(|e| e.to_string())?;
        let custom_number = |name: &str| customization.get(name).and_then(|v| v.as_f64());
        let calculated_workdays = count_workdays(&cutoff_start, &cutoff_end);
        let standard_days = custom_number("standardWorkingDays").unwrap_or(calculated_workdays);
        let daily_rate_centavos = if is_intern {
            INTERN_DAILY_RATE_PHP * 100
        } else {
            row.get::<i64, _>("daily_rate_centavos")
        };
        let actual_days = row.get::<i64, _>("actual_days") as f64;
        let late_units = row.get::<i64, _>("late_units") as f64;
        let incentives_centavos = if is_intern {
            0
        } else {
            custom_number("incentivesAllowance")
                .map(|v| (v * 100.0).round() as i64)
                .or_else(|| {
                    profile
                        .as_ref()
                        .map(|p| p.get::<i64, _>("incentives_allowance_centavos"))
                })
                .unwrap_or(0)
        };
        let special_allowance_centavos = if is_intern {
            0
        } else {
            custom_number("specialAllowance")
                .map(|v| (v * 100.0).round() as i64)
                .or_else(|| {
                    profile
                        .as_ref()
                        .map(|p| p.get::<i64, _>("special_allowance_centavos"))
                })
                .unwrap_or(0)
        };
        let special_multiplier = if is_intern {
            0.0
        } else {
            custom_number("specialHolidayMultiplier")
                .or_else(|| {
                    profile
                        .as_ref()
                        .map(|p| p.get::<f64, _>("special_holiday_multiplier"))
                })
                .unwrap_or(0.3)
        };
        let regular_multiplier = if is_intern {
            0.0
        } else {
            custom_number("regularHolidayMultiplier")
                .or_else(|| {
                    profile
                        .as_ref()
                        .map(|p| p.get::<f64, _>("regular_holiday_multiplier"))
                })
                .unwrap_or(1.0)
        };
        let half_day_fraction = profile
            .as_ref()
            .map(|p| p.get::<f64, _>("half_day_fraction"))
            .unwrap_or(0.5);
        let overtime_rate_centavos = if is_intern {
            0
        } else {
            custom_number("overtimeRate")
                .map(|v| (v * 100.0).round() as i64)
                .or_else(|| {
                    profile
                        .as_ref()
                        .map(|p| p.get::<i64, _>("overtime_rate_centavos"))
                })
                .unwrap_or(0)
        };
        let special_holiday_days = if is_intern {
            0.0
        } else {
            custom_number("specialHolidayDays").unwrap_or(0.0)
        };
        let regular_holiday_days = if is_intern {
            0.0
        } else {
            custom_number("regularHolidayDays").unwrap_or(0.0)
        };
        let half_day_deduction_from_db = row.get::<i64, _>("half_day_deduction_centavos") as f64 / 100.0;
        let half_day_count = custom_number("halfDayCount")
            .unwrap_or_else(|| row.get::<i64, _>("half_day_count") as f64);
        let half_day_deduction_opt = custom_number("halfDayDeduction")
            .filter(|&d| d > 0.0)
            .or_else(|| {
                if half_day_deduction_from_db > 0.0 {
                    Some(half_day_deduction_from_db)
                } else {
                    None
                }
            });
        let overtime_hours = if is_intern {
            0.0
        } else {
            custom_number("overtimeHours").unwrap_or(0.0)
        };
        let late_rate = custom_number("lateDeductionRate").unwrap_or(0.0);
        let late_deduction = if is_intern {
            late_units * (crate::services::intern_payroll::INTERN_DAILY_RATE_PHP as f64 / 8.0)
        } else {
            late_units * late_rate
        };
        let absent_days = custom_number("absentDays").unwrap_or_else(|| (standard_days - actual_days).max(0.0));
        let manual_adjustment = custom_number("manualAdjustment").unwrap_or(0.0);
        let input = crate::services::cutoff_payroll::CutoffInput {
            employee_id: employee_id.clone(),
            employee_name: employee_name.clone(),
            cutoff_start: cutoff_start.clone(),
            cutoff_end: cutoff_end.clone(),
            daily_rate: daily_rate_centavos as f64 / 100.0,
            standard_working_days: standard_days,
            actual_working_days: actual_days,
            basic_pay: None,
            special_holiday_days,
            special_holiday_multiplier: special_multiplier,
            special_holiday_pay: None,
            regular_holiday_days,
            regular_holiday_multiplier: regular_multiplier,
            regular_holiday_pay: None,
            hra: 0.0,
            incentives_allowance: incentives_centavos as f64 / 100.0,
            special_allowance: special_allowance_centavos as f64 / 100.0,
            late_deduction,
            half_day_count,
            half_day_fraction,
            half_day_deduction: half_day_deduction_opt,
            absent_days,
            absence_deduction: None,
            overtime_hours,
            overtime_rate: overtime_rate_centavos as f64 / 100.0,
            overtime_pay: None,
            sss_employee_share: 0.0,
            phic_employee_share: 0.0,
            hdmf_employee_share: 0.0,
            salary_advance: 0.0,
            manual_adjustment,
            adjustment_reason: customization
                .get("adjustmentReason")
                .and_then(|v| v.as_str())
                .map(String::from),
            approved_working_day_overage: true,
        };
        let calculated = crate::services::cutoff_payroll::calculate(&input)?;
        let gross_amount = calculated.gross_compensation;

        let daily_records = sqlx::query(
            "SELECT attendance_date, actual_time_in, actual_time_out, late_hours, late_deduction_centavos, \
             is_half_day, half_day_deduction_centavos, grace_used \
             FROM payroll \
             WHERE user_id=? AND attendance_date >= ? AND attendance_date <= ? \
             ORDER BY attendance_date ASC"
        )
        .bind(&employee_id)
        .bind(&cutoff_start)
        .bind(&cutoff_end)
        .fetch_all(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

        let mut attended_dates = std::collections::HashSet::new();
        for rec in &daily_records {
            let date_str: String = rec.get("attendance_date");
            attended_dates.insert(date_str);
        }

        let mut deduction_items: Vec<serde_json::Value> = Vec::new();

        // 1. Absences: Weekdays in the cutoff without attendance
        if let (Ok(start), Ok(end)) = (
            chrono::NaiveDate::parse_from_str(&cutoff_start, "%Y-%m-%d"),
            chrono::NaiveDate::parse_from_str(&cutoff_end, "%Y-%m-%d"),
        ) {
            let mut current = start;
            while current <= end {
                if current.weekday().number_from_monday() <= 5 {
                    let cur_str = current.format("%Y-%m-%d").to_string();
                    if !attended_dates.contains(&cur_str) {
                        deduction_items.push(serde_json::json!({
                            "date": cur_str,
                            "category": "ABSENCE",
                            "label": "Absence",
                            "details": "No attendance logged for standard workday",
                            "timeIn": null,
                            "timeOut": null,
                            "workedHours": null,
                            "hoursShort": null,
                            "lateHours": null,
                            "amount": daily_rate_centavos as f64 / 100.0,
                        }));
                    }
                }
                current += chrono::Duration::days(1);
            }
        }

        // 2 & 3. Weekly grace, late and undertime / half-day lines come from the payroll engine.
        for rec in &daily_records {
            let date_str: String = rec.get("attendance_date");
            let actual_in: Option<String> = rec.get("actual_time_in");
            let actual_out: Option<String> = rec.get("actual_time_out");
            deduction_items.extend(crate::services::intern_payroll::explain_day(
                &crate::services::intern_payroll::PricedDay {
                    date: &date_str,
                    actual_time_in: actual_in.as_deref(),
                    actual_time_out: actual_out.as_deref(),
                    late_hours: rec.get("late_hours"),
                    is_half_day: rec.get::<i64, _>("is_half_day") == 1,
                    half_day_deduction_centavos: rec.get("half_day_deduction_centavos"),
                    grace_used: rec.get::<Option<i64>, _>("grace_used") == Some(1),
                },
                if is_intern {
                    crate::services::intern_payroll::INTERN_DAILY_RATE_PHP as f64 / 8.0
                } else {
                    late_rate
                },
            ));
        }

        deduction_items.sort_by(|a, b| {
            let d_a = a.get("date").and_then(|v| v.as_str()).unwrap_or("");
            let d_b = b.get("date").and_then(|v| v.as_str()).unwrap_or("");
            d_a.cmp(d_b)
        });

        // Net pay is the engine's; the per-day list only explains it.
        let deduction_items = crate::services::cutoff_payroll::reconcile_deduction_items(
            deduction_items,
            calculated.total_deductions,
            &cutoff_end,
        );
        let net_amount = calculated.net_pay;

        let calculation_breakdown_json = transparent_cutoff_breakdown(
            &input,
            &calculated,
            late_units,
            deduction_items,
        )
        .to_string();

        let payroll_id = uuid::Uuid::new_v4().to_string();
        let query = format!("INSERT INTO payroll_cutoffs (payroll_id,employee_id,employee_name,payroll_profile_id,payroll_cutoff_label,cutoff_start,cutoff_end,payroll_frequency,daily_rate_centavos,standard_working_days,actual_working_days,basic_pay_centavos,special_holiday_days,special_holiday_multiplier,special_holiday_pay_centavos,regular_holiday_days,regular_holiday_multiplier,regular_holiday_pay_centavos,incentives_allowance_centavos,special_allowance_centavos,total_compensation_centavos,total_allowance_centavos,late_units,late_deduction_centavos,half_day_count,half_day_deduction_centavos,absent_days,absence_deduction_centavos,overtime_hours,overtime_rate_centavos,overtime_pay_centavos,manual_adjustment_centavos,adjustment_reason,gross_compensation_centavos,net_pay_centavos,signature_placeholder,calculation_breakdown,approved_working_day_overage,status,hra_centavos,sss_centavos,phic_centavos,hdmf_centavos,salary_advance_centavos,created_at,updated_at) VALUES ({})", std::iter::repeat("?").take(46).collect::<Vec<_>>().join(","));
        sqlx::query(&query)
            .bind(&payroll_id).bind(&employee_id).bind(&employee_name).bind(&profile_id).bind(&payroll_cutoff_label).bind(&cutoff_start).bind(&cutoff_end).bind("SEMI_MONTHLY")
            .bind(daily_rate_centavos).bind(standard_days).bind(actual_days).bind(calculated.basic_pay).bind(special_holiday_days).bind(special_multiplier).bind(calculated.special_holiday_pay).bind(regular_holiday_days).bind(regular_multiplier).bind(calculated.regular_holiday_pay)
            .bind(calculated.incentives_allowance).bind(calculated.special_allowance).bind(calculated.total_compensation).bind(calculated.total_allowance).bind(late_units).bind(calculated.late_deduction)
            .bind(half_day_count).bind(calculated.half_day_deduction).bind(absent_days).bind(calculated.absence_deduction).bind(overtime_hours).bind(overtime_rate_centavos).bind(calculated.overtime_pay)
            .bind(php_to_centavos(manual_adjustment)).bind(input.adjustment_reason.clone()).bind(gross_amount).bind(net_amount).bind("")
            .bind(&calculation_breakdown_json).bind(1_i64).bind("DRAFT")
            .bind(calculated.hra).bind(calculated.sss_employee_share).bind(calculated.phic_employee_share).bind(calculated.hdmf_employee_share).bind(calculated.salary_advance)
            .bind(&now).bind(&now)
            .execute(&mut *tx).await.map_err(|e| e.to_string())?;
        enqueue_sync_on(state, &mut tx, "PayrollCutoffs", &payroll_id, "UPSERT", &serde_json::json!({"payrollId":payroll_id,"employeeId":employee_id,"payrollCutoffLabel":payroll_cutoff_label,"cutoffStart":cutoff_start,"cutoffEnd":cutoff_end,"basicPay":calculated.basic_pay as f64 / 100.0,"lateDeduction":calculated.late_deduction as f64 / 100.0,"grossCompensation":gross_amount as f64 / 100.0,"netPay":net_amount as f64 / 100.0})).await;
        generated += 1;
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(serde_json::json!({"success":true,"generated":generated,"warnings":reconcile_warnings}))
}

#[tauri::command]
pub(crate) async fn payroll_create_cutoff(
    state: State<'_, AppState>,
    token: String,
    input: serde_json::Value,
) -> Result<serde_json::Value, String> {
    Admin::check(&state, &token).await?;
    let mut input = enrich_cutoff_input(&state.db, &input).await?;
    apply_intern_rules(&state.db, &mut input).await?;
    let parsed = cutoff_input(&input);
    let result = crate::services::cutoff_payroll::calculate(&parsed)?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    // Engine owns the intern floor; persist its gross/net unchanged.
    let gross = result.gross_compensation;
    let net = result.net_pay;
    // Total late hours are fillable for employees (rate-based deduction) and
    // computed from late units for interns; persist the units on the record.
    let late_units = input
        .get("lateUnits")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0)
        .max(0.0);
    let profile = input
        .get("payrollProfileId")
        .and_then(|v| v.as_str())
        .unwrap_or("BEA_STANDARD");
    let label = input
        .get("payrollCutoffLabel")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let breakdown = transparent_cutoff_breakdown(&parsed, &result, late_units, Vec::new());
    let insert_query = format!("INSERT INTO payroll_cutoffs (payroll_id,employee_id,employee_name,payroll_profile_id,payroll_cutoff_label,cutoff_start,cutoff_end,payroll_frequency,daily_rate_centavos,standard_working_days,actual_working_days,basic_pay_centavos,special_holiday_days,special_holiday_multiplier,special_holiday_pay_centavos,regular_holiday_days,regular_holiday_multiplier,regular_holiday_pay_centavos,incentives_allowance_centavos,special_allowance_centavos,total_compensation_centavos,total_allowance_centavos,late_units,late_deduction_centavos,half_day_count,half_day_deduction_centavos,absent_days,absence_deduction_centavos,overtime_hours,overtime_rate_centavos,overtime_pay_centavos,manual_adjustment_centavos,adjustment_reason,gross_compensation_centavos,net_pay_centavos,signature_placeholder,calculation_breakdown,approved_working_day_overage,status,hra_centavos,sss_centavos,phic_centavos,hdmf_centavos,salary_advance_centavos,created_at,updated_at) VALUES ({})", std::iter::repeat("?").take(46).collect::<Vec<_>>().join(","));
    // The cutoff and its sync row commit together (O4).
    let mut tx = state.db.begin().await.map_err(|e| e.to_string())?;
    sqlx::query(&insert_query)
        .bind(&id)
        .bind(&parsed.employee_id)
        .bind(&parsed.employee_name)
        .bind(profile)
        .bind(label)
        .bind(&parsed.cutoff_start)
        .bind(&parsed.cutoff_end)
        .bind("SEMI_MONTHLY")
        .bind((parsed.daily_rate * 100.0).round() as i64)
        .bind(parsed.standard_working_days)
        .bind(parsed.actual_working_days)
        .bind(result.basic_pay)
        .bind(parsed.special_holiday_days)
        .bind(parsed.special_holiday_multiplier)
        .bind(result.special_holiday_pay)
        .bind(parsed.regular_holiday_days)
        .bind(parsed.regular_holiday_multiplier)
        .bind(result.regular_holiday_pay)
        .bind(result.incentives_allowance)
        .bind(result.special_allowance)
        .bind(result.total_compensation)
        .bind(result.total_allowance)
        .bind(late_units)
        .bind(result.late_deduction)
        .bind(parsed.half_day_count)
        .bind(result.half_day_deduction)
        .bind(parsed.absent_days)
        .bind(result.absence_deduction)
        .bind(parsed.overtime_hours)
        .bind(php_to_centavos(parsed.overtime_rate))
        .bind(result.overtime_pay)
        .bind((parsed.manual_adjustment * 100.0).round() as i64)
        .bind(parsed.adjustment_reason.clone())
        .bind(gross)
        .bind(net)
        .bind("")
        .bind(breakdown.to_string())
        .bind(if parsed.approved_working_day_overage {
            1
        } else {
            0
        })
        .bind("DRAFT")
        .bind(result.hra)
        .bind(result.sss_employee_share)
        .bind(result.phic_employee_share)
        .bind(result.hdmf_employee_share)
        .bind(result.salary_advance)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    enqueue_sync_on(&state, &mut tx, "PayrollCutoffs", &id, "UPSERT", &input).await;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(serde_json::json!({"success":true,"payrollId":id,"netPay":net as f64 / 100.0}))
}

#[tauri::command]
pub(crate) async fn payroll_update_cutoff(
    state: State<'_, AppState>,
    token: String,
    input: serde_json::Value,
) -> Result<serde_json::Value, String> {
    Admin::check(&state, &token).await?;
    let id = input
        .get("payrollId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "PAYROLL_NOT_FOUND".to_string())?;
    let mut input = enrich_cutoff_input(&state.db, &input).await?;
    apply_intern_rules(&state.db, &mut input).await?;
    let parsed = cutoff_input(&input);
    let result = crate::services::cutoff_payroll::calculate(&parsed)?;
    let now = chrono::Utc::now().to_rfc3339();
    let late_units = input
        .get("lateUnits")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0)
        .max(0.0);
    let previous_breakdown = sqlx::query_scalar::<_, Option<String>>("SELECT calculation_breakdown FROM payroll_cutoffs WHERE payroll_id=?")
        .bind(id)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| e.to_string())?
        .flatten();
    // Net pay is the engine's, so admin edits (late units, absences, half-days,
    // adjustments) change it; the kept per-day list is rebalanced to match.
    let deduction_items = crate::services::cutoff_payroll::reconcile_deduction_items(
        preserved_deduction_items(previous_breakdown),
        result.total_deductions,
        &parsed.cutoff_end,
    );
    let gross = result.gross_compensation;
    let net = result.net_pay;
    let breakdown = transparent_cutoff_breakdown(&parsed, &result, late_units, deduction_items).to_string();
    // The edit and its sync row commit together (O4).
    let mut tx = state.db.begin().await.map_err(|e| e.to_string())?;
    let updated = sqlx::query("UPDATE payroll_cutoffs SET employee_id=?,employee_name=?,payroll_profile_id=?,payroll_cutoff_label=?,cutoff_start=?,cutoff_end=?,daily_rate_centavos=?,standard_working_days=?,actual_working_days=?,basic_pay_centavos=?,special_holiday_days=?,special_holiday_multiplier=?,special_holiday_pay_centavos=?,regular_holiday_days=?,regular_holiday_multiplier=?,regular_holiday_pay_centavos=?,incentives_allowance_centavos=?,special_allowance_centavos=?,total_compensation_centavos=?,total_allowance_centavos=?,late_units=?,late_deduction_centavos=?,half_day_count=?,half_day_deduction_centavos=?,absent_days=?,absence_deduction_centavos=?,overtime_hours=?,overtime_rate_centavos=?,overtime_pay_centavos=?,manual_adjustment_centavos=?,adjustment_reason=?,gross_compensation_centavos=?,net_pay_centavos=?,hra_centavos=?,sss_centavos=?,phic_centavos=?,hdmf_centavos=?,salary_advance_centavos=?,calculation_breakdown=?,revision=revision+1,updated_at=? WHERE payroll_id=? AND status != 'FINALIZED'")
        .bind(&parsed.employee_id).bind(&parsed.employee_name).bind(input.get("payrollProfileId").and_then(|v| v.as_str()).unwrap_or("BEA_STANDARD")).bind(input.get("payrollCutoffLabel").and_then(|v| v.as_str()).unwrap_or(""))
        .bind(&parsed.cutoff_start).bind(&parsed.cutoff_end).bind((parsed.daily_rate * 100.0).round() as i64).bind(parsed.standard_working_days).bind(parsed.actual_working_days).bind(result.basic_pay)
        .bind(parsed.special_holiday_days).bind(parsed.special_holiday_multiplier).bind(result.special_holiday_pay)
        .bind(parsed.regular_holiday_days).bind(parsed.regular_holiday_multiplier).bind(result.regular_holiday_pay)
        .bind(result.incentives_allowance).bind(result.special_allowance).bind(result.total_compensation).bind(result.total_allowance).bind(late_units).bind(result.late_deduction)
        .bind(parsed.half_day_count).bind(result.half_day_deduction).bind(parsed.absent_days).bind(result.absence_deduction).bind(parsed.overtime_hours).bind(php_to_centavos(parsed.overtime_rate)).bind(result.overtime_pay)
        .bind((parsed.manual_adjustment * 100.0).round() as i64).bind(parsed.adjustment_reason).bind(gross).bind(net)
        .bind(result.hra).bind(result.sss_employee_share).bind(result.phic_employee_share).bind(result.hdmf_employee_share).bind(result.salary_advance)
        .bind(breakdown).bind(&now).bind(id).execute(&mut *tx).await.map_err(|e| e.to_string())?;
    if updated.rows_affected() != 1 {
        return Err("PAYROLL_NOT_FOUND_OR_FINALIZED".into());
    }
    enqueue_sync_on(&state, &mut tx, "PayrollCutoffs", id, "UPSERT", &input).await;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(serde_json::json!({"success":true,"payrollId":id,"netPay":net as f64 / 100.0}))
}

#[tauri::command]
pub(crate) async fn payroll_finalize_cutoff(
    state: State<'_, AppState>,
    token: String,
    payroll_id: String,
) -> Result<serde_json::Value, String> {
    let admin = Admin::check(&state, &token).await?;
    payroll_finalize_cutoff_impl(&state, &admin, &payroll_id).await
}

pub(crate) async fn payroll_finalize_cutoff_impl(
    state: &AppState,
    _admin: &Admin,
    payroll_id: &str,
) -> Result<serde_json::Value, String> {
    let now = chrono::Utc::now().to_rfc3339();
    // Status flip + snapshot commit together: never FINALIZED without a snapshot.
    let mut tx = state.db.begin().await.map_err(|e| e.to_string())?;
    // A day may sit in at most one FINALIZED cutoff per person: an
    // overlapping draft re-counts frozen days and would pay them twice.
    let overlaps: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM payroll_cutoffs d JOIN payroll_cutoffs f ON f.employee_id=d.employee_id AND f.payroll_id<>d.payroll_id AND f.status='FINALIZED' AND f.cutoff_start<=d.cutoff_end AND f.cutoff_end>=d.cutoff_start WHERE d.payroll_id=?").bind(payroll_id).fetch_one(&mut *tx).await.map_err(|e| e.to_string())?;
    if overlaps > 0 {
        return Err("PAYROLL_PERIOD_ALREADY_FINALIZED".into());
    }
    let result = sqlx::query("UPDATE payroll_cutoffs SET status='FINALIZED', finalized_at=?, revision=revision+1, updated_at=? WHERE payroll_id=? AND status='DRAFT'").bind(&now).bind(&now).bind(payroll_id).execute(&mut *tx).await.map_err(|e| e.to_string())?;
    if result.rows_affected() == 0 {
        return Err("PAYROLL_NOT_FOUND_OR_FINALIZED".into());
    }
    let snapshot = sqlx::query("SELECT payroll_id,employee_id,employee_name,payroll_profile_id,payroll_cutoff_label,cutoff_start,cutoff_end,basic_pay_centavos,total_allowance_centavos,incentives_allowance_centavos,late_deduction_centavos,manual_adjustment_centavos,gross_compensation_centavos,net_pay_centavos,status,revision FROM payroll_cutoffs WHERE payroll_id=?").bind(&payroll_id).fetch_one(&mut *tx).await.map_err(|e| e.to_string())?;
    let snapshot_json = serde_json::json!({"payrollId":snapshot.get::<String,_>("payroll_id"),"employeeId":snapshot.get::<String,_>("employee_id"),"employeeName":snapshot.get::<String,_>("employee_name"),"profile":snapshot.get::<String,_>("payroll_profile_id"),"cutoffLabel":snapshot.get::<String,_>("payroll_cutoff_label"),"cutoffStart":snapshot.get::<String,_>("cutoff_start"),"cutoffEnd":snapshot.get::<String,_>("cutoff_end"),"basicPayCentavos":snapshot.get::<i64,_>("basic_pay_centavos"),"allowancesCentavos":snapshot.get::<i64,_>("total_allowance_centavos"),"incentivesCentavos":snapshot.get::<i64,_>("incentives_allowance_centavos"),"lateDeductionCentavos":snapshot.get::<i64,_>("late_deduction_centavos"),"manualAdjustmentCentavos":snapshot.get::<i64,_>("manual_adjustment_centavos"),"grossCentavos":snapshot.get::<i64,_>("gross_compensation_centavos"),"netCentavos":snapshot.get::<i64,_>("net_pay_centavos"),"status":"FINALIZED"});
    let snapshot_text = snapshot_json.to_string();
    let snapshot_hash = format!("{:x}", Sha256::digest(snapshot_text.as_bytes()));
    sqlx::query("INSERT INTO payroll_snapshots (snapshot_id,payroll_id,revision,status,snapshot_json,snapshot_sha256,created_at) VALUES (?,?,?,?,?,?,?)").bind(uuid::Uuid::new_v4().to_string()).bind(&payroll_id).bind(snapshot.get::<i64,_>("revision")).bind("FINALIZED").bind(snapshot_text).bind(snapshot_hash).bind(&now).execute(&mut *tx).await.map_err(|e| e.to_string())?;
    // The sync row commits with the change (O4).
    enqueue_sync_on(
        &state,
        &mut tx,
        "PayrollCutoffs",
        &payroll_id,
        "UPSERT",
        &serde_json::json!({"payrollId":payroll_id,"status":"FINALIZED","finalizedAt":now}),
    )
    .await;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(
        serde_json::json!({"success":true,"payrollId":payroll_id,"status":"FINALIZED","finalizedAt":now}),
    )
}

pub(crate) async fn delete_cutoff_record(
    state: &AppState,
    payroll_id: String,
) -> Result<serde_json::Value, String> {
    let row = sqlx::query("SELECT status,employee_id,employee_name,payroll_cutoff_label,cutoff_start,cutoff_end FROM payroll_cutoffs WHERE payroll_id=?")
        .bind(&payroll_id).fetch_optional(&state.db).await.map_err(|e| e.to_string())?
        .ok_or_else(|| "PAYROLL_NOT_FOUND".to_string())?;
    // Finalized cutoffs can be deleted by authorized admin with confirmation.
    // Snapshot and cutoff go together: never a FINALIZED cutoff without one.
    let mut tx = state.db.begin().await.map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM payroll_snapshots WHERE payroll_id=?")
        .bind(&payroll_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM payroll_cutoffs WHERE payroll_id=?")
        .bind(&payroll_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    // The sync row commits with the change (O4).
    enqueue_sync_on(
        &state,
        &mut tx,
        "PayrollCutoffs",
        &payroll_id,
        "DELETE",
        &serde_json::json!({
            "payrollId": payroll_id,
            "employeeId": row.get::<String, _>("employee_id"),
            "employeeName": row.get::<String, _>("employee_name"),
            "payrollCutoffLabel": row.get::<String, _>("payroll_cutoff_label"),
            "cutoffStart": row.get::<String, _>("cutoff_start"),
            "cutoffEnd": row.get::<String, _>("cutoff_end")
        }),
    )
    .await;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(serde_json::json!({"success":true,"payrollId":payroll_id}))
}

#[tauri::command]
pub(crate) async fn payroll_delete_cutoff(
    state: State<'_, AppState>,
    token: String,
    payroll_id: String,
) -> Result<serde_json::Value, String> {
    Admin::check(&state, &token).await?;
    delete_cutoff_record(&state, payroll_id).await
}

pub(crate) async fn enrich_cutoff_input(
    db: &sqlx::SqlitePool,
    input: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let employee_id = input
        .get("employeeId")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim();
    let needs_name = input
        .get("employeeName")
        .and_then(|value| value.as_str())
        .is_none_or(|value| value.trim().is_empty());
    let needs_rate = input
        .get("dailyRate")
        .and_then(|value| value.as_f64())
        .is_none_or(|value| value <= 0.0);
    let needs_half_day_fraction = input
        .get("halfDayFraction")
        .and_then(|value| value.as_f64())
        .is_none_or(|value| value <= 0.0);
    if employee_id.is_empty() || (!needs_name && !needs_rate && !needs_half_day_fraction) {
        return Ok(input.clone());
    }
    let employee =
        sqlx::query("SELECT full_name, daily_rate_centavos FROM users WHERE user_id = ?")
            .bind(employee_id)
            .fetch_optional(db)
            .await
            .map_err(|error| error.to_string())?;
    let mut enriched = input.clone();
    let Some(object) = enriched.as_object_mut() else {
        return Ok(input.clone());
    };
    if let Some(employee) = employee {
        if needs_name {
            object.insert(
                "employeeName".into(),
                serde_json::Value::String(employee.get("full_name")),
            );
        }
        if needs_rate {
            if let Some(daily_rate_centavos) = employee.get::<Option<i64>, _>("daily_rate_centavos") {
                object.insert(
                    "dailyRate".into(),
                    serde_json::json!(daily_rate_centavos as f64 / 100.0),
                );
            }
        }
    }
    if needs_half_day_fraction {
        let input_profile_id = input
            .get("payrollProfileId")
            .and_then(|value| value.as_str())
            .filter(|value| !value.trim().is_empty());
        let user_profile_id = if input_profile_id.is_none() {
            sqlx::query("SELECT payroll_profile_id FROM users WHERE user_id = ?")
                .bind(employee_id)
                .fetch_optional(db)
                .await
                .ok()
                .flatten()
                .and_then(|row| row.get::<Option<String>, _>("payroll_profile_id"))
        } else {
            None
        };
        let profile_id = input_profile_id.or(user_profile_id.as_deref());
        let profile_fraction = if let Some(profile_id) = profile_id {
            sqlx::query("SELECT half_day_fraction FROM payroll_profiles WHERE profile_id = ?")
                .bind(profile_id)
                .fetch_optional(db)
                .await
                .map_err(|error| error.to_string())?
                .and_then(|row| row.get::<Option<f64>, _>("half_day_fraction"))
                .filter(|fraction| *fraction > 0.0)
        } else {
            None
        };
        object.insert(
            "halfDayFraction".into(),
            serde_json::json!(profile_fraction.unwrap_or(0.5)),
        );
    }
    Ok(enriched)
}

/// Enforces the fixed intern payroll policy on a cutoff input before the
/// generic cutoff calculator runs: PHP 80.00/day, PHP 10.00/hour late
/// deduction, and no holiday premium, allowances, or overtime. Absences are
/// derived from standard less actual working days; half-days remain inputtable.
pub(crate) async fn apply_intern_rules(
    db: &sqlx::SqlitePool,
    input: &mut serde_json::Value,
) -> Result<(), String> {
    let employee_id = input
        .get("employeeId")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim();
    if employee_id.is_empty() {
        return Ok(());
    }
    let employee_type: Option<String> =
        sqlx::query("SELECT employee_type FROM users WHERE user_id = ?")
            .bind(employee_id)
            .fetch_optional(db)
            .await
            .map_err(|error| error.to_string())?
            .map(|row| row.get("employee_type"));
    if employee_type.as_deref() != Some("INTERN") {
        return Ok(());
    }
    let late_units = input
        .get("lateUnits")
        .and_then(|value| value.as_f64())
        .unwrap_or(0.0)
        .max(0.0);
    let Some(object) = input.as_object_mut() else {
        return Err("ADMIN_VALIDATION_ERROR".into());
    };
    // Fixed intern rate; any submitted rate is ignored for interns.
    object.insert(
        "dailyRate".into(),
        serde_json::json!(INTERN_DAILY_RATE_PHP as f64),
    );
    object.insert(
        "payrollProfileId".into(),
        serde_json::json!(INTERN_PAYROLL_PROFILE_ID),
    );
    object.insert("employeeType".into(), serde_json::json!("INTERN"));
    object.insert("lateUnits".into(), serde_json::json!(late_units));
    // QA payroll rules charge the late-hour rate separately from the recorded
    // worked-hour shortfall; preserve both components in cutoff totals.
    object.insert(
        "lateDeduction".into(),
        serde_json::json!(late_units * (INTERN_DAILY_RATE_PHP as f64 / 8.0)),
    );
    for field in [
        "hra",
        "incentivesAllowance",
        "specialAllowance",
        "specialHolidayDays",
        "specialHolidayPay",
        "regularHolidayDays",
        "regularHolidayPay",
        "overtimeHours",
        "overtimeRate",
        "overtimePay",
        "sss",
        "sssEmployeeShare",
        "phic",
        "phicEmployeeShare",
        "hdmf",
        "hdmfEmployeeShare",
        "salaryAdvance",
    ] {
        object.insert(field.into(), serde_json::json!(0.0));
    }
    object.remove("basicPay");
    object.remove("specialHolidayPay");
    object.remove("regularHolidayPay");
    object.remove("overtimePay");
    object.remove("absenceDeduction");
    let standard_working_days = object
        .get("standardWorkingDays")
        .and_then(|v| v.as_f64())
        .unwrap_or(11.0);
    let actual_working_days = object
        .get("actualWorkingDays")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let absent_days = (standard_working_days - actual_working_days).max(0.0);
    let half_day_count = object
        .get("halfDayCount")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    object.insert("standardWorkingDays".into(), serde_json::json!(standard_working_days));
    object.insert("absentDays".into(), serde_json::json!(absent_days));
    object.insert("halfDayCount".into(), serde_json::json!(half_day_count));
    object.insert("halfDayFraction".into(), serde_json::json!(0.5));
    Ok(())
}

pub(crate) fn cutoff_input(value: &serde_json::Value) -> crate::services::cutoff_payroll::CutoffInput {
    let n = |name: &str| value.get(name).and_then(|v| v.as_f64()).unwrap_or(0.0);
    let opt_n = |name: &str| value.get(name).and_then(|v| v.as_f64());
    crate::services::cutoff_payroll::CutoffInput {
        employee_id: value
            .get("employeeId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .into(),
        employee_name: value
            .get("employeeName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .into(),
        cutoff_start: value
            .get("cutoffStart")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .into(),
        cutoff_end: value
            .get("cutoffEnd")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .into(),
        daily_rate: n("dailyRate"),
        standard_working_days: n("standardWorkingDays"),
        actual_working_days: n("actualWorkingDays"),
        basic_pay: opt_n("basicPay"),
        special_holiday_days: n("specialHolidayDays"),
        special_holiday_multiplier: n("specialHolidayMultiplier"),
        special_holiday_pay: opt_n("specialHolidayPay"),
        regular_holiday_days: n("regularHolidayDays"),
        regular_holiday_multiplier: n("regularHolidayMultiplier"),
        regular_holiday_pay: opt_n("regularHolidayPay"),
        hra: opt_n("hra").unwrap_or(0.0),
        incentives_allowance: n("incentivesAllowance"),
        special_allowance: n("specialAllowance"),
        late_deduction: n("lateDeduction"),
        half_day_count: n("halfDayCount"),
        half_day_fraction: n("halfDayFraction"),
        half_day_deduction: opt_n("halfDayDeduction"),
        absent_days: n("absentDays"),
        absence_deduction: opt_n("absenceDeduction"),
        overtime_hours: n("overtimeHours"),
        overtime_rate: n("overtimeRate"),
        overtime_pay: opt_n("overtimePay"),
        sss_employee_share: opt_n("sss").or_else(|| opt_n("sssEmployeeShare")).unwrap_or(0.0),
        phic_employee_share: opt_n("phic").or_else(|| opt_n("phicEmployeeShare")).unwrap_or(0.0),
        hdmf_employee_share: opt_n("hdmf").or_else(|| opt_n("hdmfEmployeeShare")).unwrap_or(0.0),
        salary_advance: opt_n("salaryAdvance").unwrap_or(0.0),
        manual_adjustment: n("manualAdjustment"),
        adjustment_reason: value
            .get("adjustmentReason")
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        approved_working_day_overage: value
            .get("approvedWorkingDayOverage")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    }
}

/// Per-day deduction rows stored in a previous breakdown. An edit-save keeps
/// this row detail so the transparent table stays visible; every monetary
/// total is still recomputed from the fresh calculation result.
pub(crate) fn preserved_deduction_items(existing_breakdown: Option<String>) -> Vec<serde_json::Value> {
    existing_breakdown
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|json| json.get("deductions").cloned())
        .and_then(|deductions| deductions.as_array().cloned())
        .unwrap_or_default()
}

pub(crate) fn transparent_cutoff_breakdown(
    input: &crate::services::cutoff_payroll::CutoffInput,
    result: &crate::services::cutoff_payroll::CutoffResult,
    late_units: f64,
    deductions: Vec<serde_json::Value>,
) -> serde_json::Value {
    serde_json::json!({
        "source": "attendance",
        "actualWorkingDays": input.actual_working_days,
        "standardWorkingDays": input.standard_working_days,
        "dailyRate": input.daily_rate,
        "lateUnits": late_units,
        "deductions": deductions,
        "basicPayCentavos": result.basic_pay,
        "incentivesAllowanceCentavos": result.incentives_allowance,
        "hraCentavos": result.hra,
        "incentivesCentavos": result.incentives_allowance,
        "specialAllowanceCentavos": result.special_allowance,
        "specialHolidayCentavos": result.special_holiday_pay,
        "specialHolidayPayCentavos": result.special_holiday_pay,
        "regularHolidayCentavos": result.regular_holiday_pay,
        "regularHolidayPayCentavos": result.regular_holiday_pay,
        "overtimeCentavos": result.overtime_pay,
        "overtimePayCentavos": result.overtime_pay,
        "totalCompensationCentavos": result.total_compensation,
        "totalAllowanceCentavos": result.total_allowance,
        "grossCentavos": result.gross_compensation,
        "grossCompensationCentavos": result.gross_compensation,
        "sssCentavos": result.sss_employee_share,
        "phicCentavos": result.phic_employee_share,
        "hdmfCentavos": result.hdmf_employee_share,
        "salaryAdvanceCentavos": result.salary_advance,
        "lateCentavos": result.late_deduction,
        "lateDeductionCentavos": result.late_deduction,
        "halfDayCentavos": result.half_day_deduction,
        "halfDayDeductionCentavos": result.half_day_deduction,
        "absenceCentavos": result.absence_deduction,
        "absenceDeductionCentavos": result.absence_deduction,
        "totalDeductionsCentavos": result.total_deductions,
        "netPayCentavos": result.net_pay,
    })
}

pub(crate) fn php_to_centavos(value: f64) -> i64 {
    (value * 100.0).round() as i64
}

pub(crate) fn valid_cutoff_date(value: &str) -> bool {
    // P7: shape checks alone accepted Feb-30 and month 99 — parse a real
    // calendar day instead.
    chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::*;
    use crate::commands::attendance::attendance_rows_json;
    use crate::services::attendance::ensure_payroll;
    use crate::commands::session::setup_unlock_impl;
    use crate::services::users::upsert_user_record;
    

    /// MAJOR-1 of the round 2 review: a cutoff stored before v0.2.56 has late
    /// lines without `payableTimeIn`. Reading it fills the key with the hour
    /// the day was paid from; the expected values are what the old client
    /// derived from the same stored line (21b9891 App.tsx:7426-7431).
    #[tokio::test]
    async fn a_cutoff_stored_before_the_payable_key_is_read_with_the_clamped_time_in() {
        let (state, temp, _token) = admin_test_state("stored-cutoff").await;
        let stored = include_str!("fixtures/stored_cutoff_breakdown_2026_08.json");
        insert_cutoff_row(&state.db, "PAY-OLD", "FINALIZED").await;
        sqlx::query("UPDATE payroll_cutoffs SET calculation_breakdown=? WHERE payroll_id='PAY-OLD'")
            .bind(stored)
            .execute(&state.db)
            .await
            .unwrap();
        let row = sqlx::query(CUTOFF_LIST_SQL).fetch_one(&state.db).await.unwrap();
        let chips = |employee_type: Option<&str>| -> Vec<Option<String>> {
            let json = payroll_cutoff_json(&row, employee_type);
            let breakdown: serde_json::Value =
                serde_json::from_str(json["calculationBreakdown"].as_str().unwrap()).unwrap();
            breakdown["deductions"]
                .as_array()
                .unwrap()
                .iter()
                .map(|line| line["payableTimeIn"].as_str().map(str::to_string))
                .collect()
        };
        let chip = |label: &str| Some(label.to_string());
        assert_eq!(
            chips(Some("INTERN")),
            vec![
                chip("10:00 AM"), // 2026-08-04 late 09:20
                None,             // 2026-08-05 weekly grace 08:10
                chip("9:00 AM"),  // 2026-08-06 late 08:16
                None,             // 2026-08-07 late 08:10, grace already used: paid from the scan
                None,             // 2026-08-10 late 09:15: not past the quarter hour
                None,             // 2026-08-11 undertime line of a late day
                chip("11:00 AM"), // 2026-08-11 its late line, 10:45
                None,             // 2026-08-12 late line with no amount
            ]
        );
        // A person the register does not list is shown as an intern, as before.
        assert_eq!(chips(None), chips(Some("INTERN")));
        // The old client showed the chip on intern rows only.
        assert!(chips(Some("EMPLOYEE")).iter().all(Option::is_none));
        // The stored column is not rewritten.
        let kept: String = sqlx::query_scalar("SELECT calculation_breakdown FROM payroll_cutoffs WHERE payroll_id='PAY-OLD'")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(kept, stored);
        state.db.close().await;
        let _ = std::fs::remove_dir_all(temp);
    }

    #[tokio::test]
    async fn reconciles_attendance_and_recomputes_cutoff_without_migrations() {
        let temp = std::env::temp_dir().join(format!("alpha-cutoff-reconcile-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        let db_path = temp.join("attendance.db");
        let exports_path = temp.join("exports");
        let state = AppState::new(
            temp.clone(),
            db_path,
            exports_path,
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

        // 1. Create an intern user
        upsert_user_record(
            &state.db,
            "INT_TEST_1",
            "RFID-INT-1",
            "Test Intern",
            Some("IT"),
            "ACTIVE",
            "INTERN",
            Some("MALE"),
            Some(0),
            Some("INTERN_STANDARD"),
            None,
            "EMPLOYEE",
            "2026-08-01T00:00:00Z",
        )
        .await
        .unwrap();

        // 2. Insert attendance record: 8:00 AM to 12:30 PM (4.5 hours worked)
        sqlx::query(
            "INSERT INTO attendance (attendance_id, attendance_date, user_id, rfid_uid, full_name, department, time_in, time_out, status, source, created_at, updated_at) \
             VALUES ('ATT-TEST-1', '2026-08-01', 'INT_TEST_1', 'RFID-INT-1', 'Test Intern', 'IT', '2026-08-01T08:00:00+08:00', '2026-08-01T12:30:00+08:00', 'COMPLETED', 'KIOSK', '2026-08-01T08:00:00+08:00', '2026-08-01T12:30:00+08:00')"
        )
        .execute(&state.db)
        .await
        .unwrap();

        // 3. Simulate pre-existing stale payroll record calculated under previous ceiling logic (50 pesos, is_half_day = 0)
        sqlx::query(
            "INSERT INTO payroll (payroll_id, attendance_id, user_id, full_name, employee_type, attendance_date, actual_time_in, actual_time_out, computed_time_in, computed_time_out, grace_used, late_hours, late_deduction_centavos, base_pay_centavos, daily_pay_centavos, is_half_day, half_day_deduction_centavos, created_at, updated_at) \
             VALUES ('PAY-STALE-1', 'ATT-TEST-1', 'INT_TEST_1', 'Test Intern', 'INTERN', '2026-08-01', '2026-08-01T08:00:00+08:00', '2026-08-01T12:30:00+08:00', '2026-08-01T08:00:00+08:00', '2026-08-01T12:30:00+08:00', 0, 0, 0, 8000, 5000, 0, 3000, '2026-08-01T12:30:00+08:00', '2026-08-01T12:30:00+08:00')"
        )
        .execute(&state.db)
        .await
        .unwrap();

        // 4. Generate a one-day cutoff for this fixture so unrelated weekdays
        // do not add absences to the expected half-day net pay.
        let gen_result = payroll_generate_cutoff_impl(
            &state,
            &admin(&state, &token).await,
            "2026-08-01".to_string(),
            "2026-08-01".to_string(),
            "August 1, 2026".to_string(),
            serde_json::json!({ "standardWorkingDays": 1.0 }),
        )
        .await
        .unwrap();

        assert_eq!(gen_result["success"], true);
        assert_eq!(gen_result["generated"], 1);

        // 5. Verify the payroll table row was recomputed: daily_pay_centavos is now 4000 (40 pesos), is_half_day is 1
        let updated_payroll = sqlx::query(
            "SELECT daily_pay_centavos, is_half_day, half_day_deduction_centavos FROM payroll WHERE attendance_id = 'ATT-TEST-1'"
        )
        .fetch_one(&state.db)
        .await
        .unwrap();

        let daily_pay: i64 = updated_payroll.get("daily_pay_centavos");
        let is_half_day: i64 = updated_payroll.get("is_half_day");
        let half_day_ded: i64 = updated_payroll.get("half_day_deduction_centavos");
        assert_eq!(daily_pay, 4000, "Daily pay must recompute to 40 pesos (4 hours)");
        assert_eq!(is_half_day, 1, "Must be classified as half day");
        assert_eq!(half_day_ded, 4000, "Half day deduction must be 40 pesos");

        // 6. Verify the generated cutoff record reflects 40 pesos net pay
        let cutoff_row = sqlx::query(
            "SELECT actual_working_days, half_day_count, basic_pay_centavos, half_day_deduction_centavos, net_pay_centavos FROM payroll_cutoffs WHERE employee_id = 'INT_TEST_1'"
        )
        .fetch_one(&state.db)
        .await
        .unwrap();

        let cutoff_half_days: f64 = cutoff_row.get("half_day_count");
        let cutoff_net: i64 = cutoff_row.get("net_pay_centavos");
        assert_eq!(cutoff_half_days, 1.0, "Cutoff must have half_day_count = 1.0");
        assert_eq!(cutoff_net, 4000, "Cutoff net pay must be 40 pesos (4000 centavos)");

        // 7. B1: a LATE_TIMEOUT clock-out (>= 18:00) must still be reconciled
        // into payroll. The engines cap it to 17:00 (cap_late_timeout_out), so
        // the day is a full capped shift rather than a silently unpaid absence.
        sqlx::query(
            "INSERT INTO attendance (attendance_id, attendance_date, user_id, rfid_uid, full_name, department, time_in, time_out, status, source, created_at, updated_at) \
             VALUES ('ATT-TEST-LATE', '2026-08-03', 'INT_TEST_1', 'RFID-INT-1', 'Test Intern', 'IT', '2026-08-03T08:00:00+08:00', '2026-08-03T18:05:00+08:00', 'LATE_TIMEOUT', 'KIOSK', '2026-08-03T18:05:00+08:00', '2026-08-03T18:05:00+08:00')"
        )
        .execute(&state.db)
        .await
        .unwrap();

        reconcile_attendance_payroll_range(
            &state,
            "2026-08-01",
            "2026-08-15",
            &std::collections::HashSet::new(),
        )
            .await
            .unwrap();

        let late_payroll = sqlx::query(
            "SELECT computed_time_out, late_hours, daily_pay_centavos, is_half_day, half_day_deduction_centavos FROM payroll WHERE attendance_id = 'ATT-TEST-LATE'",
        )
        .fetch_optional(&state.db)
        .await
        .unwrap();
        let late_payroll = late_payroll.expect("reconcile must not drop a LATE_TIMEOUT day");
        assert_eq!(
            late_payroll.get::<String, _>("computed_time_out"),
            "2026-08-03T17:00:00+08:00",
            "A LATE_TIMEOUT clock-out caps to the 17:00 office close"
        );
        assert_eq!(late_payroll.get::<i64, _>("late_hours"), 0);
        assert_eq!(
            late_payroll.get::<i64, _>("daily_pay_centavos"),
            8000,
            "The capped day pays the intern's full 8h (PHP 80)"
        );
        assert_eq!(late_payroll.get::<i64, _>("is_half_day"), 0);
        assert_eq!(late_payroll.get::<i64, _>("half_day_deduction_centavos"), 0);

        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[tokio::test]
    async fn graced_undertime_day_lands_in_deductions_not_earnings() {
        let temp = std::env::temp_dir().join(format!("alpha-undertime-{}", uuid::Uuid::new_v4()));
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
            &state.db, "INT_UT", "RFID-UT", "Under Time", Some("IT"), "ACTIVE", "INTERN",
            Some("MALE"), Some(0), Some("INTERN_STANDARD"), None, "EMPLOYEE", "2026-08-01T00:00:00Z",
        )
        .await
        .unwrap();
        // Nov 16-30, 2026 has 11 weekdays. Mon the 16th: 08:01-15:00 (weekly
        // grace, two undertime hours). Tue the 17th: 08:05, grace already used.
        for day in [16, 17, 18, 19, 20, 23, 24, 25, 26, 27, 30] {
            let (time_in, time_out) = match day {
                16 => ("08:01:00", "15:00:00"),
                17 => ("08:05:00", "17:00:00"),
                _ => ("08:00:00", "17:00:00"),
            };
            let date = format!("2026-11-{day}");
            sqlx::query(
                "INSERT INTO attendance (attendance_id, attendance_date, user_id, rfid_uid, full_name, department, time_in, time_out, status, source, created_at, updated_at) \
                 VALUES (?, ?, 'INT_UT', 'RFID-UT', 'Under Time', 'IT', ?, ?, 'COMPLETED', 'KIOSK', ?, ?)",
            )
            .bind(format!("ATT-UT-{day}"))
            .bind(&date)
            .bind(format!("{date}T{time_in}+08:00"))
            .bind(format!("{date}T{time_out}+08:00"))
            .bind(&date)
            .bind(&date)
            .execute(&state.db)
            .await
            .unwrap();
        }
        payroll_generate_cutoff_impl(
            &state,
            &admin(&state, &token).await,
            "2026-11-16".into(),
            "2026-11-30".into(),
            "November 16-30, 2026".into(),
            serde_json::json!({}),
        )
        .await
        .unwrap();

        let day = |attendance_id: &'static str| {
            let db = state.db.clone();
            async move {
                let row = sqlx::query(
                    "SELECT grace_used, late_deduction_centavos, half_day_deduction_centavos, daily_pay_centavos, policy_version \
                     FROM payroll WHERE attendance_id=?",
                )
                .bind(attendance_id)
                .fetch_one(&db)
                .await
                .unwrap();
                (
                    row.get::<Option<i64>, _>(0),
                    row.get::<i64, _>(1),
                    row.get::<i64, _>(2),
                    row.get::<i64, _>(3),
                    row.get::<String, _>(4),
                )
            }
        };
        assert_eq!(day("ATT-UT-16").await, (Some(1), 0, 2_000, 6_000, "V3_WEEKLY_GRACE".to_string()));
        assert_eq!(day("ATT-UT-17").await, (Some(0), 1_000, 0, 7_000, "V3_WEEKLY_GRACE".to_string()));
        let claims: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM intern_grace WHERE user_id='INT_UT' AND week_start='2026-11-16'")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(claims, 1, "one weekly grace claim");

        let cutoff = sqlx::query(
            "SELECT basic_pay_centavos, gross_compensation_centavos, late_deduction_centavos, half_day_deduction_centavos, net_pay_centavos FROM payroll_cutoffs",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        // Earnings stay the full cutoff rate; undertime only reduces net through deductions.
        assert_eq!(
            (0..5).map(|i| cutoff.get::<i64, _>(i)).collect::<Vec<_>>(),
            [88_000, 88_000, 1_000, 2_000, 85_000]
        );
        // The Breakdown names the graced day; the attendance list shows the same decision.
        let breakdown: String = sqlx::query_scalar("SELECT calculation_breakdown FROM payroll_cutoffs")
            .fetch_one(&state.db)
            .await
            .unwrap();
        let breakdown: serde_json::Value = serde_json::from_str(&breakdown).unwrap();
        let lines = breakdown["deductions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| (item["date"].as_str().unwrap(), item["category"].as_str().unwrap(), item["amount"].as_f64().unwrap()))
            .collect::<Vec<_>>();
        assert_eq!(
            lines,
            [
                ("2026-11-16", "GRACE", 0.0),
                ("2026-11-16", "UNDERTIME", 20.0),
                ("2026-11-17", "LATE", 10.0),
            ]
        );
        // An open (not yet priced) 08:10 arrival the next week can still take that week's claim.
        sqlx::query(
            "INSERT INTO attendance (attendance_id, attendance_date, user_id, rfid_uid, full_name, department, time_in, status, source, created_at, updated_at) \
             VALUES ('ATT-UT-OPEN', '2026-12-01', 'INT_UT', 'RFID-UT', 'Under Time', 'IT', '2026-12-01T08:10:00+08:00', 'WORKING', 'KIOSK', '2026-12-01', '2026-12-01')",
        )
        .execute(&state.db)
        .await
        .unwrap();
        let mut statuses = Vec::new();
        for date in ["2026-11-16", "2026-11-17", "2026-11-18", "2026-12-01"] {
            let rows = attendance_rows_json(&state.db, date).await.unwrap();
            statuses.push((rows[0]["arrivalStatus"].as_str().unwrap().to_string(), rows[0]["minutesLate"].as_i64().unwrap()));
        }
        assert_eq!(
            statuses,
            [
                ("GRACE_PERIOD".to_string(), 0),
                ("LATE".to_string(), 5),
                ("ON_TIME".to_string(), 0),
                ("GRACE_PERIOD".to_string(), 0),
            ]
        );

        let slips = crate::reporting::load_intern_payslips(&state.db, "2026-11-16", "2026-11-30")
            .await
            .unwrap();
        let slip = &slips[0];
        assert_eq!(slip.total_earnings_centavos, 88_000);
        assert_eq!(slip.adjustment_centavos, 0);
        assert_eq!((slip.late_centavos, slip.halfday_centavos, slip.undertime_centavos), (1_000, 0, 2_000));
        assert_eq!(slip.total_deductions_centavos, 3_000);
        assert_eq!(slip.net_pay_centavos, 85_000);

        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    /// MOCK FIRST CUTOFF (Dec 1-15, 2026; 11 weekdays; weekly-grace rules).
    /// Eight interns with different time-in/time-out patterns; every expected
    /// figure below is worked out by hand from docs/payroll-policy.md, in pesos
    /// x 100. Weeks: Nov 30-Dec 6, Dec 7-13, Dec 14-20.
    #[tokio::test]
    async fn mock_first_cutoff_with_varied_days_matches_hand_computed_pay() {
        let temp = std::env::temp_dir().join(format!("alpha-mock-cutoff-{}", uuid::Uuid::new_v4()));
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

        const WORKDAYS: [u32; 11] = [1, 2, 3, 4, 7, 8, 9, 10, 11, 14, 15];
        const FULL: (&str, &str) = ("08:00:00", "17:00:00");
        struct Intern {
            id: &'static str,
            /// (day, time in, time out); a workday not listed is a full 08:00-17:00 day.
            days: &'static [(u32, &'static str, &'static str)],
            absent: &'static [u32],
            /// Expected cutoff centavos: late, half-day + undertime, absence, net.
            expected: (i64, i64, i64, i64),
            grace_claims: i64,
        }
        let interns = [
            // A: perfect attendance.
            Intern { id: "A", days: &[], absent: &[], expected: (0, 0, 0, 88_000), grace_claims: 0 },
            // B: in the grace window twice a week; the first is free, the second is one late hour.
            //    Dec 14 08:01 is graced, Dec 15 08:00:59 is on time.
            Intern {
                id: "B",
                days: &[
                    (1, "08:10:00", "17:00:00"), (2, "08:10:00", "17:00:00"),
                    (7, "08:15:00", "17:00:00"), (8, "08:15:01", "17:00:00"),
                    (14, "08:01:00", "17:00:00"), (15, "08:00:59", "17:00:00"),
                ],
                absent: &[],
                expected: (2_000, 0, 0, 86_000),
                grace_claims: 3,
            },
            // C: early time-outs. Dec 1 out 15:00 = 2h; Dec 2 out 16:59 = 1h; Dec 3 08:01-15:30
            //    graced = 2h; Dec 4 08:05-15:30 grace used = 1 late hour + 2h. Staying to 17:30,
            //    18:30 (capped) or arriving 07:30 changes nothing.
            Intern {
                id: "C",
                days: &[
                    (1, "08:00:00", "15:00:00"), (2, "08:00:00", "16:59:00"),
                    (3, "08:01:00", "15:30:00"), (4, "08:05:00", "15:30:00"),
                    (7, "08:00:00", "17:30:00"), (8, "08:00:00", "18:30:00"), (9, "07:30:00", "17:00:00"),
                ],
                absent: &[],
                expected: (1_000, 7_000, 0, 80_000),
                grace_claims: 1,
            },
            // D: half-days and absences. Dec 1 morning half (40); Dec 2 13:00 afternoon half (40);
            //    Dec 7 12:00 sharp (40); Dec 8 09:01 = 2 late hours; Dec 9 11:59 = 4 late hours;
            //    Dec 10 08:20-12:30 = 1 late hour + 4 short hours; Dec 3-4 absent.
            Intern {
                id: "D",
                days: &[
                    (1, "08:00:00", "12:00:00"), (2, "13:00:00", "17:00:00"),
                    (7, "12:00:00", "17:00:00"), (8, "09:01:00", "17:00:00"),
                    (9, "11:59:00", "17:00:00"), (10, "08:20:00", "12:30:00"),
                ],
                absent: &[3, 4],
                expected: (7_000, 16_000, 16_000, 49_000),
                grace_claims: 0,
            },
            // E: the week's grace was already used on Mon Nov 30 (previous cutoff), so
            //    Tue Dec 1 08:05 is late; Dec 7 08:14 is a new week and is graced.
            Intern {
                id: "E",
                days: &[(1, "08:05:00", "17:00:00"), (7, "08:14:00", "17:00:00")],
                absent: &[],
                expected: (1_000, 0, 0, 87_000),
                grace_claims: 2,
            },
            // F: Dec 7 08:05 graced, Dec 9 08:07 late. (Corrected further down.)
            Intern {
                id: "F",
                days: &[(7, "08:05:00", "17:00:00"), (9, "08:07:00", "17:00:00")],
                absent: &[],
                expected: (1_000, 0, 0, 87_000),
                grace_claims: 1,
            },
            // G: two near-empty days and nine absences: nothing left, never negative.
            //    Dec 1 16:30-16:45 = 8 short hours; Dec 2 08:01-08:30 graced = 8 short hours.
            Intern {
                id: "G",
                days: &[(1, "16:30:00", "16:45:00"), (2, "08:01:00", "08:30:00")],
                absent: &[3, 4, 7, 8, 9, 10, 11, 14, 15],
                expected: (0, 16_000, 72_000, 0),
                grace_claims: 1,
            },
            // H: second-level boundaries. Dec 1 08:00:59 on time; Dec 2 08:01:00 graced;
            //    Dec 3 08:14:59-16:00 grace used = 1 late hour + 1h; Dec 4 08:59:59 = 1 late hour;
            //    Dec 7 09:00:00 = 1 late hour; Dec 8 09:00:01 = 2 late hours.
            Intern {
                id: "H",
                days: &[
                    (1, "08:00:59", "17:00:00"), (2, "08:01:00", "17:00:00"),
                    (3, "08:14:59", "16:00:00"), (4, "08:59:59", "17:00:00"),
                    (7, "09:00:00", "17:00:00"), (8, "09:00:01", "17:00:00"),
                ],
                absent: &[],
                expected: (5_000, 1_000, 0, 82_000),
                grace_claims: 1,
            },
        ];

        for intern in &interns {
            let user_id = format!("INT_{}", intern.id);
            upsert_user_record(
                &state.db, &user_id, &format!("RFID-{}", intern.id), &format!("Mock {}", intern.id), Some("IT"),
                "ACTIVE", "INTERN", Some("MALE"), Some(0), Some("INTERN_STANDARD"), None, "EMPLOYEE", "2026-08-01T00:00:00Z",
            )
            .await
            .unwrap();
            for day in WORKDAYS.iter().copied().filter(|day| !intern.absent.contains(day)) {
                let (time_in, time_out) = intern.days.iter().find(|d| d.0 == day).map_or(FULL, |d| (d.1, d.2));
                let date = format!("2026-12-{day:02}");
                sqlx::query(
                    "INSERT INTO attendance (attendance_id, attendance_date, user_id, rfid_uid, full_name, department, time_in, time_out, status, source, created_at, updated_at) \
                     VALUES (?, ?, ?, ?, ?, 'IT', ?, ?, 'COMPLETED', 'KIOSK', ?, ?)",
                )
                .bind(format!("ATT-{}-{day}", intern.id))
                .bind(&date)
                .bind(&user_id)
                .bind(format!("RFID-{}", intern.id))
                .bind(format!("Mock {}", intern.id))
                .bind(format!("{date}T{time_in}+08:00"))
                .bind(format!("{date}T{time_out}+08:00"))
                .bind(&date)
                .bind(&date)
                .execute(&state.db)
                .await
                .unwrap();
            }
        }
        // E's Monday of the straddling week, priced when it happened (previous cutoff).
        sqlx::query(
            "INSERT INTO attendance (attendance_id, attendance_date, user_id, rfid_uid, full_name, department, time_in, time_out, status, source, created_at, updated_at) \
             VALUES ('ATT-E-NOV30', '2026-11-30', 'INT_E', 'RFID-E', 'Mock E', 'IT', '2026-11-30T08:05:00+08:00', '2026-11-30T17:00:00+08:00', 'COMPLETED', 'KIOSK', '2026-11-30', '2026-11-30')",
        )
        .execute(&state.db)
        .await
        .unwrap();
        ensure_payroll(&state, "ATT-E-NOV30", "INT_E", "Mock E".into(), "2026-11-30", "2026-11-30T08:05:00+08:00", "2026-11-30T17:00:00+08:00")
            .await
            .unwrap();

        let generate = || async {
            payroll_generate_cutoff_impl(
                &state,
                &admin(&state, &token).await,
                "2026-12-01".into(),
                "2026-12-15".into(),
                "December 1-15, 2026".into(),
                serde_json::json!({}),
            )
            .await
        };
        let cutoff_rows = || async {
            sqlx::query(
                "SELECT employee_id, late_deduction_centavos, half_day_deduction_centavos, absence_deduction_centavos, \
                 net_pay_centavos, gross_compensation_centavos, calculation_breakdown FROM payroll_cutoffs ORDER BY employee_id",
            )
            .fetch_all(&state.db)
            .await
            .unwrap()
        };
        let figures = |rows: &[sqlx::sqlite::SqliteRow]| {
            rows.iter()
                .map(|row| (row.get::<String, _>(0), (row.get::<i64, _>(1), row.get::<i64, _>(2), row.get::<i64, _>(3), row.get::<i64, _>(4))))
                .collect::<Vec<_>>()
        };

        assert_eq!(generate().await.unwrap()["generated"], 8);
        let rows = cutoff_rows().await;
        let expected = interns.iter().map(|intern| (format!("INT_{}", intern.id), intern.expected)).collect::<Vec<_>>();
        assert_eq!(figures(&rows), expected, "(late, half-day + undertime, absence, net) per intern");

        let slips = crate::reporting::load_intern_payslips(&state.db, "2026-12-01", "2026-12-15").await.unwrap();
        for (row, intern) in rows.iter().zip(&interns) {
            let user_id = format!("INT_{}", intern.id);
            let (late, short, absence, net) = intern.expected;
            // Earnings are never touched: the full cutoff rate, 11 x 80.
            assert_eq!(row.get::<i64, _>("gross_compensation_centavos"), 88_000, "{user_id} gross");
            // The Breakdown lines add up to the deductions exactly, with no balancing line.
            let breakdown: serde_json::Value = serde_json::from_str(&row.get::<String, _>("calculation_breakdown")).unwrap();
            let lines = breakdown["deductions"].as_array().unwrap();
            assert!(lines.iter().all(|line| line["category"] != "RECONCILIATION"), "{user_id} has a balancing line");
            let line_total: i64 = lines.iter().map(|line| (line["amount"].as_f64().unwrap() * 100.0).round() as i64).sum();
            assert_eq!(line_total, late + short + absence, "{user_id} breakdown total");
            let grace_lines = lines.iter().filter(|line| line["category"] == "GRACE").count() as i64;
            // Payslip: earnings whole, no adjustment on either side, totals consistent.
            let slip = slips.iter().find(|slip| slip.employee_id == user_id).unwrap();
            assert_eq!((slip.total_earnings_centavos, slip.adjustment_centavos, slip.deduction_adjustment_centavos), (88_000, 0, 0), "{user_id} payslip earnings");
            assert_eq!(slip.late_centavos + slip.halfday_centavos + slip.undertime_centavos + slip.absent_centavos, slip.total_deductions_centavos, "{user_id} payslip deductions");
            assert_eq!((slip.total_deductions_centavos, slip.net_pay_centavos), ((late + short + absence).min(88_000), net), "{user_id} payslip totals");
            // One grace claim per week at most, and as many as expected.
            let claims: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM intern_grace WHERE user_id = ?").bind(&user_id).fetch_one(&state.db).await.unwrap();
            assert_eq!(claims, intern.grace_claims, "{user_id} grace claims");
            let in_cutoff = if intern.id == "E" { intern.grace_claims - 1 } else { intern.grace_claims };
            assert_eq!(grace_lines, in_cutoff, "{user_id} grace lines in the Breakdown");
            let most_per_week: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(n), 0) FROM (SELECT COUNT(*) AS n FROM intern_grace WHERE user_id = ? GROUP BY week_start)")
                .bind(&user_id)
                .fetch_one(&state.db)
                .await
                .unwrap();
            assert!(most_per_week <= 1, "{user_id} claimed grace twice in one week");
            // Every day's pay is within 0..=80 and equals 80 less its deductions.
            let bad_days: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM payroll WHERE user_id = ? AND (daily_pay_centavos < 0 OR daily_pay_centavos > 8000 \
                 OR daily_pay_centavos != 8000 - late_deduction_centavos - half_day_deduction_centavos OR policy_version != 'V3_WEEKLY_GRACE')",
            )
            .bind(&user_id)
            .fetch_one(&state.db)
            .await
            .unwrap();
            assert_eq!(bad_days, 0, "{user_id} has an inconsistent day");
        }

        // The attendance list agrees with the pay for the boundary seconds (intern H).
        let mut statuses = Vec::new();
        for day in [1, 2, 3, 4, 7, 8] {
            let rows = attendance_rows_json(&state.db, &format!("2026-12-{day:02}")).await.unwrap();
            let row = rows.iter().find(|row| row["userId"] == "INT_H").unwrap();
            statuses.push((row["arrivalStatus"].as_str().unwrap().to_string(), row["minutesLate"].as_i64().unwrap()));
        }
        assert_eq!(
            statuses,
            [("ON_TIME", 0), ("GRACE_PERIOD", 0), ("LATE", 15), ("LATE", 60), ("LATE", 60), ("LATE", 61)]
                .map(|(status, minutes)| (status.to_string(), minutes))
        );

        // Generating again changes nothing: same figures, same grace claims.
        let claims_before: Vec<(String, String)> = sqlx::query_as("SELECT user_id, attendance_id FROM intern_grace ORDER BY 1, 2").fetch_all(&state.db).await.unwrap();
        sqlx::query("DELETE FROM payroll_cutoffs").execute(&state.db).await.unwrap();
        generate().await.unwrap();
        assert_eq!(figures(&cutoff_rows().await), expected, "regenerating changed the payroll");
        let claims_after: Vec<(String, String)> = sqlx::query_as("SELECT user_id, attendance_id FROM intern_grace ORDER BY 1, 2").fetch_all(&state.db).await.unwrap();
        assert_eq!(claims_after, claims_before, "regenerating moved a grace claim");

        // Correction: F's graced Dec 7 arrival is fixed to 08:00. The claim is released and
        // the Dec 9 08:07 arrival of the same week takes it; nobody else's pay moves.
        sqlx::query("UPDATE attendance SET time_in = '2026-12-07T08:00:00+08:00' WHERE attendance_id = 'ATT-F-7'").execute(&state.db).await.unwrap();
        sqlx::query("DELETE FROM payroll_cutoffs").execute(&state.db).await.unwrap();
        generate().await.unwrap();
        let corrected = figures(&cutoff_rows().await);
        for ((user_id, got), (_, before)) in corrected.iter().zip(&expected) {
            let want = if user_id == "INT_F" { (0, 0, 0, 88_000) } else { *before };
            assert_eq!(*got, want, "{user_id} after F's correction");
        }
        let f_claim: Vec<String> = sqlx::query_scalar("SELECT attendance_id FROM intern_grace WHERE user_id = 'INT_F'").fetch_all(&state.db).await.unwrap();
        assert_eq!(f_claim, ["ATT-F-9"]);

        // Out of order: intern I forgot to time out on Mon Dec 7 (08:05), so Tue Dec 8 (08:06)
        // was priced first and took the week's grace. The admin then completes Monday.
        // Exactly one of the two days is graced and one is a late hour, and it stays that way.
        upsert_user_record(
            &state.db, "INT_I", "RFID-I", "Mock I", Some("IT"), "ACTIVE", "INTERN", Some("MALE"), Some(0),
            Some("INTERN_STANDARD"), None, "EMPLOYEE", "2026-08-01T00:00:00Z",
        )
        .await
        .unwrap();
        for (day, time_in, time_out, status) in [(7, "08:05:00", None, "MISSED"), (8, "08:06:00", Some("17:00:00"), "COMPLETED")] {
            let date = format!("2026-12-{day:02}");
            sqlx::query(
                "INSERT INTO attendance (attendance_id, attendance_date, user_id, rfid_uid, full_name, department, time_in, time_out, status, source, created_at, updated_at) \
                 VALUES (?, ?, 'INT_I', 'RFID-I', 'Mock I', 'IT', ?, ?, ?, 'KIOSK', ?, ?)",
            )
            .bind(format!("ATT-I-{day}"))
            .bind(&date)
            .bind(format!("{date}T{time_in}+08:00"))
            .bind(time_out.map(|out| format!("{date}T{out}+08:00")))
            .bind(status)
            .bind(&date)
            .bind(&date)
            .execute(&state.db)
            .await
            .unwrap();
        }
        ensure_payroll(&state, "ATT-I-8", "INT_I", "Mock I".into(), "2026-12-08", "2026-12-08T08:06:00+08:00", "2026-12-08T17:00:00+08:00")
            .await
            .unwrap();
        sqlx::query("UPDATE attendance SET time_out = '2026-12-07T17:00:00+08:00', status = 'COMPLETED' WHERE attendance_id = 'ATT-I-7'").execute(&state.db).await.unwrap();
        for round in 0..2 {
            sqlx::query("DELETE FROM payroll_cutoffs").execute(&state.db).await.unwrap();
            generate().await.unwrap();
            let days: Vec<(String, i64, i64)> = sqlx::query_as(
                "SELECT attendance_id, grace_used, late_deduction_centavos FROM payroll WHERE user_id = 'INT_I' ORDER BY attendance_date",
            )
            .fetch_all(&state.db)
            .await
            .unwrap();
            assert_eq!(days, [("ATT-I-7".to_string(), 0, 1_000), ("ATT-I-8".to_string(), 1, 0)], "round {round}");
            // 2 days worked, 9 absent: 880 - 720 absent - 10 late.
            let net: i64 = sqlx::query_scalar("SELECT net_pay_centavos FROM payroll_cutoffs WHERE employee_id = 'INT_I'").fetch_one(&state.db).await.unwrap();
            assert_eq!(net, 15_000, "round {round}");
        }

        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn cutoff_dates_require_real_calendar_days() {
        // P7: shape checks alone accepted Feb-30 and month 99.
        assert!(valid_cutoff_date("2026-08-01"));
        assert!(valid_cutoff_date("2026-8-1")); // unpadded but a real day
        assert!(!valid_cutoff_date("2026-02-30"));
        assert!(!valid_cutoff_date("2026-13-01"));
        assert!(!valid_cutoff_date("2026-99-99"));
        assert!(!valid_cutoff_date(""));
    }

    #[tokio::test]
    async fn enriches_cutoff_input_from_the_selected_employee() {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory database");
        sqlx::query("CREATE TABLE users (user_id TEXT PRIMARY KEY, full_name TEXT NOT NULL, daily_rate_centavos INTEGER)")
            .execute(&db)
            .await
            .expect("users table");
        sqlx::query("INSERT INTO users (user_id, full_name, daily_rate_centavos) VALUES (?, ?, ?)")
            .bind("EMP-1")
            .bind("Ada Lovelace")
            .bind(50_000_i64)
            .execute(&db)
            .await
            .expect("employee row");

        let input = serde_json::json!({"employeeId":"EMP-1","cutoffStart":"2026-08-01","cutoffEnd":"2026-08-15"});
        let enriched = enrich_cutoff_input(&db, &input)
            .await
            .expect("enriched input");

        assert_eq!(enriched["employeeName"], "Ada Lovelace");
        assert_eq!(enriched["dailyRate"], 500.0);
    }

    #[tokio::test]
    async fn finalize_refuses_overlapping_finalized_cutoff() {
        // Double pay: Aug 1-15 is FINALIZED; a custom Aug 1-31 draft for the
        // same intern re-counts those frozen days and must never finalize.
        let temp = std::env::temp_dir().join(format!("alpha-cutoff-overlap-{}", uuid::Uuid::new_v4()));
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
        let token = setup_unlock_impl(&state, "1234".to_string()).await.unwrap()["token"]
            .as_str()
            .unwrap()
            .to_string();
        insert_cutoff_row(&state.db, "PAY-FIN", "FINALIZED").await;
        insert_cutoff_row(&state.db, "PAY-OVERLAP", "DRAFT").await;
        insert_cutoff_row(&state.db, "PAY-NEXT", "DRAFT").await;
        sqlx::query("UPDATE payroll_cutoffs SET cutoff_end='2026-08-31' WHERE payroll_id='PAY-OVERLAP'")
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query("UPDATE payroll_cutoffs SET cutoff_start='2026-08-16', cutoff_end='2026-08-31' WHERE payroll_id='PAY-NEXT'")
            .execute(&state.db)
            .await
            .unwrap();

        let refused = payroll_finalize_cutoff_impl(&state, &admin(&state, &token).await, "PAY-OVERLAP").await;
        assert_eq!(refused.unwrap_err(), "PAYROLL_PERIOD_ALREADY_FINALIZED");
        let status: String = sqlx::query_scalar("SELECT status FROM payroll_cutoffs WHERE payroll_id='PAY-OVERLAP'")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(status, "DRAFT");
        let snapshots: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM payroll_snapshots WHERE payroll_id='PAY-OVERLAP'")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(snapshots, 0);

        let adjacent = payroll_finalize_cutoff_impl(&state, &admin(&state, &token).await, "PAY-NEXT").await.unwrap();
        assert_eq!(adjacent["status"], "FINALIZED");

        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[tokio::test]
    async fn cutoff_delete_never_leaves_a_finalized_cutoff_without_its_snapshot() {
        let temp = std::env::temp_dir().join(format!("alpha-cutoff-del-atomic-{}", uuid::Uuid::new_v4()));
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
        insert_cutoff_row(&state.db, "PAY-FIN", "FINALIZED").await;
        sqlx::query("INSERT INTO payroll_snapshots (snapshot_id,payroll_id,revision,status,snapshot_json,snapshot_sha256,created_at) VALUES ('snap-1','PAY-FIN',1,'FINALIZED','{}','x','2026-08-16T00:00:00Z')")
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query("CREATE TRIGGER block_cutoff_delete BEFORE DELETE ON payroll_cutoffs BEGIN SELECT RAISE(ABORT, 'forced cutoff delete failure'); END")
            .execute(&state.db)
            .await
            .unwrap();
        assert!(delete_cutoff_record(&state, "PAY-FIN".to_string()).await.is_err());
        let snapshots: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM payroll_snapshots WHERE payroll_id='PAY-FIN'")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(snapshots, 1, "approved-pay snapshot kept while its cutoff stays");
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[tokio::test]
    async fn finalized_cutoff_can_be_deleted() {
        // Finalized and draft cutoffs can both be deleted with confirmation.
        let temp = std::env::temp_dir().join(format!("alpha-cutoff-delete-{}", uuid::Uuid::new_v4()));
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
        insert_cutoff_row(&state.db, "PAY-FIN", "FINALIZED").await;
        insert_cutoff_row(&state.db, "PAY-DRAFT", "DRAFT").await;
        delete_cutoff_record(&state, "PAY-FIN".to_string())
            .await
            .expect("finalized deletes");
        delete_cutoff_record(&state, "PAY-DRAFT".to_string())
            .await
            .expect("draft deletes");
        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM payroll_cutoffs")
            .fetch_one(&state.db)
            .await
            .expect("count");
        assert_eq!(remaining, 0);
    }

    #[tokio::test]
    async fn applies_fixed_intern_rules_to_intern_cutoff_input() {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory database");
        sqlx::query("CREATE TABLE users (user_id TEXT PRIMARY KEY, full_name TEXT NOT NULL, daily_rate_centavos INTEGER, employee_type TEXT NOT NULL)")
            .execute(&db)
            .await
            .expect("users table");
        sqlx::query("INSERT INTO users (user_id, full_name, daily_rate_centavos, employee_type) VALUES (?, ?, ?, ?)")
            .bind("INT-1")
            .bind("Maria Santos")
            .bind(0_i64)
            .bind("INTERN")
            .execute(&db)
            .await
            .expect("intern row");

        // Submitted rate/allowances are ignored; the fixed PHP 80/day rate is
        // enforced for interns, and the late shortfall is charged through
        // late-hours amount is separate from the shortfall amount.
        let mut input = serde_json::json!({
            "employeeId": "INT-1", "dailyRate": 500.0, "lateUnits": 3.0,
            "incentivesAllowance": 100.0, "specialHolidayDays": 1.0,
        });
        apply_intern_rules(&db, &mut input)
            .await
            .expect("intern rules applied");

        assert_eq!(input["dailyRate"], 80.0);
        assert_eq!(input["lateUnits"], 3.0);
        assert_eq!(input["lateDeduction"], 30.0);
        assert_eq!(input["payrollProfileId"], "INTERN_STANDARD");
        assert_eq!(input["incentivesAllowance"], 0.0);
        assert_eq!(input["specialHolidayDays"], 0.0);
        assert_eq!(input["absentDays"], 11.0);
        assert_eq!(input["halfDayCount"], 0.0);

        // Employees keep their own values untouched.
        sqlx::query("INSERT INTO users (user_id, full_name, daily_rate_centavos, employee_type) VALUES (?, ?, ?, ?)")
            .bind("EMP-1")
            .bind("Ada Lovelace")
            .bind(50_000_i64)
            .bind("EMPLOYEE")
            .execute(&db)
            .await
            .expect("employee row");
        let mut employee_input =
            serde_json::json!({"employeeId": "EMP-1", "dailyRate": 500.0, "lateUnits": 1.0});
        apply_intern_rules(&db, &mut employee_input)
            .await
            .expect("employee rules pass through");
        assert_eq!(employee_input["dailyRate"], 500.0);
        assert_eq!(employee_input.get("lateDeduction"), None);
    }

    #[tokio::test]
    async fn intern_late_deduction_uses_fixed_hourly_rate() {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory database");
        sqlx::query("CREATE TABLE users (user_id TEXT PRIMARY KEY, full_name TEXT NOT NULL, daily_rate_centavos INTEGER, employee_type TEXT NOT NULL)")
            .execute(&db)
            .await
            .expect("users table");
        sqlx::query("INSERT INTO users (user_id, full_name, daily_rate_centavos, employee_type) VALUES (?, ?, ?, ?)")
            .bind("INT-LATE-0")
            .bind("Late Intern")
            .bind(8_000_i64)
            .bind("INTERN")
            .execute(&db)
            .await
            .expect("intern row");

        let mut input = serde_json::json!({
            "employeeId": "INT-LATE-0",
            "lateUnits": 99.0,
            "lateDeduction": 999.0,
        });
        apply_intern_rules(&db, &mut input)
            .await
            .expect("intern rules applied");

        assert_eq!(input["lateUnits"], 99.0);
        assert_eq!(input["lateDeduction"], 990.0);
    }

    #[test]
    fn updated_cutoff_breakdown_contains_deductions_and_half_day_centavos() {
        let parsed = cutoff_input(&serde_json::json!({
            "employeeId": "EMP-BREAKDOWN",
            "employeeName": "Breakdown Employee",
            "employeeType": "EMPLOYEE",
            "cutoffStart": "2026-08-01",
            "cutoffEnd": "2026-08-15",
            "dailyRate": 500.0,
            "standardWorkingDays": 11.0,
            "actualWorkingDays": 11.0,
            "halfDayCount": 1.0,
            "halfDayFraction": 0.5,
            "halfDayDeduction": 250.0,
        }));
        let result = crate::services::cutoff_payroll::calculate(&parsed).expect("cutoff calculation");
        let breakdown = &transparent_cutoff_breakdown(&parsed, &result, 0.0, Vec::new());

        assert!(breakdown["deductions"].is_array());
        assert_eq!(breakdown["halfDayCentavos"], 25_000);
    }

    #[test]
    fn update_preserves_prior_deduction_rows() {
        let items = preserved_deduction_items(Some(
            r#"{"deductions":[{"category":"UNDERTIME","amount":40}]}"#.into(),
        ));
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["category"], "UNDERTIME");
    }

    #[test]
    fn update_handles_missing_or_invalid_breakdown() {
        assert!(preserved_deduction_items(None).is_empty());
        assert!(preserved_deduction_items(Some("not json".into())).is_empty());
        assert!(preserved_deduction_items(Some(r#"{"deductions":{}}"#.into())).is_empty());
    }

    #[tokio::test]
    async fn intern_editor_json_flows_through_one_discriminator_to_floored_gross() {
        // N1: the editor payload carries no `employeeType`; the single source is
        // `apply_intern_rules` keyed off the users row. The engine must see INTERN
        // and floor gross separately from net, matching the TS engine parity case
        // (grossCompensation 880 / netPay 0) instead of net-as-gross.
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory database");
        sqlx::query("CREATE TABLE users (user_id TEXT PRIMARY KEY, full_name TEXT NOT NULL, daily_rate_centavos INTEGER, employee_type TEXT NOT NULL)")
            .execute(&db)
            .await
            .expect("users table");
        sqlx::query("INSERT INTO users (user_id, full_name, daily_rate_centavos, employee_type) VALUES (?, ?, ?, ?)")
            .bind("INT-1")
            .bind("Maria Santos")
            .bind(0_i64)
            .bind("INTERN")
            .execute(&db)
            .await
            .expect("intern row");
        let mut input = serde_json::json!({
            "employeeId": "INT-1", "employeeName": "Maria Santos",
            "cutoffStart": "2026-09-01", "cutoffEnd": "2026-09-15",
            "standardWorkingDays": 11.0, "actualWorkingDays": 1.0, "lateUnits": 20.0,
        });
        assert_eq!(input.get("employeeType"), None);
        apply_intern_rules(&db, &mut input)
            .await
            .expect("intern rules applied");
        // One derivation, stored where the engine reads it.
        assert_eq!(input["employeeType"], "INTERN");
        let parsed = cutoff_input(&input);
        // basic = 80/day x (1 actual + 10 absent) = 880; late=200 and absence=800
        // are separate deductions, while gross stays 880 (not net).
        let result = crate::services::cutoff_payroll::calculate(&parsed).expect("engine");
        assert_eq!(result.gross_compensation, 88_000);
        assert_eq!(result.late_deduction, 20_000);
        assert_eq!(result.net_pay, 0);
    }

    #[test]
    fn php_to_centavos_preserves_fractional_pesos() {
        assert_eq!(php_to_centavos(123.45), 12_345);
        assert_eq!(php_to_centavos(0.01), 1);
    }

    #[test]
    fn php_to_centavos_rounds_fractional_centavos() {
        assert_eq!(php_to_centavos(12.344), 1_234);
        assert_eq!(php_to_centavos(12.345), 1_235);
        assert_eq!(php_to_centavos(12.346), 1_235);
    }

    #[test]
    fn calculates_single_day_attendance_cutoff_for_employee_and_intern() {
        let employee_input = crate::services::cutoff_payroll::CutoffInput {
            employee_id: "EMP-1".into(),
            employee_name: "John Doe".into(),
            cutoff_start: "2026-08-18".into(),
            cutoff_end: "2026-08-18".into(),
            daily_rate: 500.0,
            standard_working_days: 11.0,
            actual_working_days: 1.0,
            basic_pay: None,
            special_holiday_days: 0.0,
            special_holiday_multiplier: 0.3,
            special_holiday_pay: None,
            regular_holiday_days: 0.0,
            regular_holiday_multiplier: 1.0,
            regular_holiday_pay: None,
            hra: 0.0,
            incentives_allowance: 0.0,
            special_allowance: 0.0,
            late_deduction: 0.0,
            half_day_count: 0.0,
            half_day_fraction: 0.5,
            half_day_deduction: None,
            absent_days: 0.0,
            absence_deduction: None,
            overtime_hours: 0.0,
            overtime_rate: 0.0,
            overtime_pay: None,
            sss_employee_share: 0.0,
            phic_employee_share: 0.0,
            hdmf_employee_share: 0.0,
            salary_advance: 0.0,
            manual_adjustment: 0.0,
            adjustment_reason: None,
            approved_working_day_overage: true,
        };
        let emp_calc = crate::services::cutoff_payroll::calculate(&employee_input).unwrap();
        assert_eq!(emp_calc.basic_pay, 50_000);
        assert_eq!(emp_calc.net_pay, 50_000);

        let intern_input = crate::services::cutoff_payroll::CutoffInput {
            employee_id: "INT-1".into(),
            employee_name: "Deign Grey O. Lazaro".into(),
            cutoff_start: "2026-08-18".into(),
            cutoff_end: "2026-08-18".into(),
            daily_rate: 80.0,
            standard_working_days: 11.0,
            actual_working_days: 1.0,
            basic_pay: None,
            special_holiday_days: 0.0,
            special_holiday_multiplier: 0.0,
            special_holiday_pay: None,
            regular_holiday_days: 0.0,
            regular_holiday_multiplier: 0.0,
            regular_holiday_pay: None,
            hra: 0.0,
            incentives_allowance: 0.0,
            special_allowance: 0.0,
            late_deduction: 0.0,
            half_day_count: 0.0,
            half_day_fraction: 0.5,
            half_day_deduction: None,
            absent_days: 0.0,
            absence_deduction: None,
            overtime_hours: 0.0,
            overtime_rate: 0.0,
            overtime_pay: None,
            sss_employee_share: 0.0,
            phic_employee_share: 0.0,
            hdmf_employee_share: 0.0,
            salary_advance: 0.0,
            manual_adjustment: 0.0,
            adjustment_reason: None,
            approved_working_day_overage: true,
        };
        let intern_calc = crate::services::cutoff_payroll::calculate(&intern_input).unwrap();
        assert_eq!(intern_calc.basic_pay, 8_000);
        assert_eq!(intern_calc.net_pay, 8_000);
    }
}
