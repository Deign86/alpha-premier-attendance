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
mod tests;
