use csv::Reader;
use sqlx::{sqlite::SqliteConnectOptions, SqlitePool};
use std::{env, path::PathBuf};

const MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./db/migrations");

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    let execute = args.iter().any(|arg| arg == "--execute");
    let input = args.windows(2).find(|pair| pair[0] == "--input").map(|pair| PathBuf::from(&pair[1])).unwrap_or_else(|| PathBuf::from("."));
    let db_path = args.windows(2).find(|pair| pair[0] == "--db").map(|pair| PathBuf::from(&pair[1])).unwrap_or_else(|| PathBuf::from("attendance.db"));
    let users_path = input.join("Users.csv");
    let attendance_path = input.join("Attendance.csv");
    let files = ["Users.csv", "Attendance.csv", "AuditLogs.csv", "InternGrace.csv", "Payroll.csv", "PayrollProfiles.csv", "PayrollCutoffs.csv"];
    let mut counts = Vec::new();
    for file in files { let path = input.join(file); let count = inspect_csv(&path)?; counts.push((file, count)); }
    println!("Sheets import: {}", counts.iter().map(|(name, count)| format!("{name}={count}")).collect::<Vec<_>>().join(", "));
    println!("Mode: {}", if execute { "execute" } else { "dry-run" });
    if !execute { return Ok(()); }
    let db = SqlitePool::connect_with(SqliteConnectOptions::new().filename(db_path).create_if_missing(true)).await?;
    MIGRATOR.run(&db).await?;
    import_users(&db, &users_path).await?;
    import_attendance(&db, &attendance_path).await?;
    import_grace(&db, &input.join("InternGrace.csv")).await?;
    import_audit_logs(&db, &input.join("AuditLogs.csv")).await?;
    import_payroll(&db, &input.join("Payroll.csv")).await?;
    import_profiles(&db, &input.join("PayrollProfiles.csv")).await?;
    import_cutoffs(&db, &input.join("PayrollCutoffs.csv")).await?;
    verify_counts(&db, &counts).await?;
    println!("Import complete; source row counts verified for available core tables");
    Ok(())
}

fn inspect_csv(path: &PathBuf) -> Result<usize, Box<dyn std::error::Error>> {
    if !path.exists() { return Ok(0); }
    let mut reader = Reader::from_path(path)?;
    let headers = reader.headers()?.iter().map(normalize).collect::<Vec<_>>();
    if headers.is_empty() { return Err(format!("{} has no header row", path.display()).into()); }
    let required = match path.file_stem().and_then(|v| v.to_str()).unwrap_or_default() {
        "Users" => ["userid", "rfiduid", "fullname", "status"].as_slice(),
        "Attendance" => ["attendanceid", "attendancedate", "userid", "rfiduid", "fullname"].as_slice(),
        "AuditLogs" => ["logid", "timestamp", "eventtype", "message", "requestid"].as_slice(),
        "InternGrace" => ["graceid", "userid", "weekstart", "attendanceid", "usedat"].as_slice(),
        "Payroll" => ["payrollid", "attendanceid", "userid", "fullname", "attendancedate"].as_slice(),
        "PayrollProfiles" => ["profileid", "label", "payrollfrequency"].as_slice(),
        "PayrollCutoffs" => ["payrollid", "employeeid", "employeename", "cutoffstart", "cutoffend"].as_slice(),
        _ => [].as_slice(),
    };
    for field in required { if !headers.iter().any(|value| value == field) { return Err(format!("{} is missing required header {field}", path.display()).into()); } }
    Ok(reader.records().count())
}

fn normalize(value: &str) -> String { value.trim().to_ascii_lowercase().chars().filter(|ch| ch.is_ascii_alphanumeric()).collect() }

async fn import_users(db: &SqlitePool, path: &PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    if !path.exists() { return Ok(()); }
    for record in Reader::from_path(path)?.records() {
        let row = record?;
        if row.len() < 5 { continue; }
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query("INSERT OR IGNORE INTO users (user_id, rfid_uid, full_name, department, status, created_at, employee_type, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(&row[0]).bind(&row[1]).bind(&row[2]).bind(Some(&row[3])).bind(&row[4]).bind(&now).bind("INTERN").bind(&now).execute(db).await?;
    }
    Ok(())
}

async fn import_attendance(db: &SqlitePool, path: &PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    if !path.exists() { return Ok(()); }
    for record in Reader::from_path(path)?.records() {
        let row = record?;
        if row.len() < 8 { continue; }
        let now = chrono::Utc::now().to_rfc3339();
        // Legacy sheets use OPEN/INCOMPLETE; normalize to the current attendance statuses.
        // LATE_TIMEOUT (after-hours time-out pending correction) is preserved.
        let status: &str = match row.get(8).filter(|v| !v.is_empty()).unwrap_or("OPEN").to_ascii_uppercase().as_str() {
            "COMPLETED" => "COMPLETED",
            "LATE_TIMEOUT" => "LATE_TIMEOUT",
            "MISSED" | "INCOMPLETE" => "MISSED",
            _ => "WORKING",
        };
        sqlx::query("INSERT OR IGNORE INTO attendance (attendance_id, attendance_date, user_id, rfid_uid, full_name, department, time_in, time_out, status, source, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(&row[0]).bind(&row[1]).bind(&row[2]).bind(&row[3]).bind(&row[4]).bind(Some(&row[5])).bind(row.get(6).filter(|v| !v.is_empty())).bind(row.get(7).filter(|v| !v.is_empty())).bind(status).bind(row.get(9).filter(|v| !v.is_empty()).unwrap_or("RFID")).bind(row.get(10).unwrap_or("")).bind(&now).bind(&now).execute(db).await?;
    }
    Ok(())
}

async fn import_grace(db: &SqlitePool, path: &PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    if !path.exists() { return Ok(()); }
    for record in Reader::from_path(path)?.records() {
        let row = record?; if row.len() < 5 { continue; }
        sqlx::query("INSERT OR IGNORE INTO intern_grace (grace_id,user_id,week_start,attendance_id,used_at) VALUES (?,?,?,?,?)").bind(&row[0]).bind(&row[1]).bind(&row[2]).bind(&row[3]).bind(&row[4]).execute(db).await?;
    }
    Ok(())
}

async fn import_audit_logs(db: &SqlitePool, path: &PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    if !path.exists() { return Ok(()); }
    for record in Reader::from_path(path)?.records() {
        let row = record?; if row.len() < 7 { continue; }
        sqlx::query("INSERT OR IGNORE INTO audit_logs (log_id,timestamp,event_type,rfid_uid,user_id,message,request_id) VALUES (?,?,?,?,?,?,?)").bind(&row[0]).bind(&row[1]).bind(&row[2]).bind(Some(&row[3])).bind(Some(&row[4])).bind(&row[5]).bind(&row[6]).execute(db).await?;
    }
    Ok(())
}

fn number(row: &csv::StringRecord, index: usize) -> f64 { row.get(index).unwrap_or("0").trim().parse::<f64>().unwrap_or(0.0) }
fn cents(row: &csv::StringRecord, index: usize) -> i64 { (number(row, index) * 100.0).round() as i64 }

async fn import_payroll(db: &SqlitePool, path: &PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    if !path.exists() { return Ok(()); }
    for record in Reader::from_path(path)?.records() {
        let row = record?; if row.len() < 16 { continue; }
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query("INSERT OR IGNORE INTO payroll (payroll_id,attendance_id,user_id,full_name,employee_type,attendance_date,actual_time_in,actual_time_out,computed_time_in,computed_time_out,grace_used,late_hours,late_deduction_centavos,base_pay_centavos,daily_pay_centavos,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
            .bind(&row[0]).bind(&row[1]).bind(&row[2]).bind(&row[3]).bind(&row[4]).bind(&row[5]).bind(&row[6]).bind(&row[7]).bind(&row[8]).bind(&row[9]).bind(if row[10].trim().is_empty() { None } else if row[10].eq_ignore_ascii_case("TRUE") { Some(1_i64) } else { Some(0_i64) }).bind(number(&row, 11) as i64).bind(cents(&row, 12)).bind(cents(&row, 13)).bind(cents(&row, 14)).bind(&row[15]).bind(&now).bind(&now).execute(db).await?;
    }
    Ok(())
}

async fn import_profiles(db: &SqlitePool, path: &PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    if !path.exists() { return Ok(()); }
    for record in Reader::from_path(path)?.records() {
        let row = record?; if row.len() < 10 { continue; }
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query("INSERT OR REPLACE INTO payroll_profiles (profile_id,label,payroll_frequency,standard_working_days_per_cutoff,incentives_allowance_centavos,special_allowance_centavos,special_holiday_multiplier,regular_holiday_multiplier,half_day_fraction,overtime_rate_centavos,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
            .bind(&row[0]).bind(&row[1]).bind(&row[2]).bind(number(&row, 3)).bind(cents(&row, 4)).bind(cents(&row, 5)).bind(number(&row, 6)).bind(number(&row, 7)).bind(number(&row, 8)).bind(cents(&row, 9)).bind(&now).bind(&now).execute(db).await?;
    }
    Ok(())
}

async fn import_cutoffs(db: &SqlitePool, path: &PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    if !path.exists() { return Ok(()); }
    for record in Reader::from_path(path)?.records() {
        let row = record?; if row.len() < 40 { continue; }
        let now = chrono::Utc::now().to_rfc3339();
        let query = format!("INSERT OR REPLACE INTO payroll_cutoffs (payroll_id,employee_id,employee_name,payroll_profile_id,payroll_cutoff_label,cutoff_start,cutoff_end,payroll_frequency,daily_rate_centavos,standard_working_days,actual_working_days,basic_pay_centavos,special_holiday_days,special_holiday_multiplier,special_holiday_pay_centavos,regular_holiday_days,regular_holiday_multiplier,regular_holiday_pay_centavos,incentives_allowance_centavos,special_allowance_centavos,total_compensation_centavos,total_allowance_centavos,late_units,late_deduction_centavos,half_day_count,half_day_deduction_centavos,absent_days,absence_deduction_centavos,overtime_hours,overtime_rate_centavos,overtime_pay_centavos,manual_adjustment_centavos,adjustment_reason,gross_compensation_centavos,net_pay_centavos,signature_placeholder,calculation_breakdown,approved_working_day_overage,status,finalized_at,created_at,updated_at) VALUES ({})", std::iter::repeat("?").take(42).collect::<Vec<_>>().join(","));
        sqlx::query(&query)
            .bind(&row[0]).bind(&row[1]).bind(&row[2]).bind(&row[3]).bind(&row[4]).bind(&row[5]).bind(&row[6]).bind(&row[7]).bind(cents(&row, 8)).bind(number(&row, 9)).bind(number(&row, 10)).bind(cents(&row, 11)).bind(number(&row, 12)).bind(number(&row, 13)).bind(cents(&row, 14)).bind(number(&row, 15)).bind(number(&row, 16)).bind(cents(&row, 17)).bind(cents(&row, 18)).bind(cents(&row, 19)).bind(cents(&row, 20)).bind(cents(&row, 21)).bind(number(&row, 22)).bind(cents(&row, 23)).bind(number(&row, 24)).bind(cents(&row, 25)).bind(number(&row, 26)).bind(cents(&row, 27)).bind(number(&row, 28)).bind(cents(&row, 29)).bind(cents(&row, 30)).bind(cents(&row, 31)).bind(row.get(32).filter(|v| !v.is_empty())).bind(cents(&row, 33)).bind(cents(&row, 34)).bind(&row[35]).bind(&row[36]).bind(if row[37].eq_ignore_ascii_case("TRUE") { 1 } else { 0 }).bind(&row[38]).bind(row.get(39).filter(|v| !v.is_empty())).bind(&now).bind(&now).execute(db).await?;
    }
    Ok(())
}

async fn verify_counts(db: &SqlitePool, counts: &[(&str, usize)]) -> Result<(), Box<dyn std::error::Error>> {
    for (file, expected) in counts {
        let table = match *file { "Users.csv" => "users", "Attendance.csv" => "attendance", "AuditLogs.csv" => "audit_logs", "InternGrace.csv" => "intern_grace", "Payroll.csv" => "payroll", "PayrollProfiles.csv" => "payroll_profiles", "PayrollCutoffs.csv" => "payroll_cutoffs", _ => continue };
        let actual: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}")).fetch_one(db).await?;
        if actual < *expected as i64 { return Err(format!("{file}: imported {actual} rows but source contains {expected}").into()); }
    }
    Ok(())
}
