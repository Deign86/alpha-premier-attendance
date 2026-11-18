use chrono_tz::Asia::Manila;
use crate::state::AppState;
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::path::Path;
use std::path::PathBuf;
use super::payroll::valid_cutoff_date;
use super::session::Admin;
use tauri::State;
use tauri_plugin_opener::OpenerExt;

/// Structured file metadata returned by every file-generating action so the UI
/// can offer Open / Show in folder / Open folder actions.
pub(crate) fn generated_file_metadata(
    state: &AppState,
    file_name: &str,
    file_path: &Path,
    file_kind: &str,
    message: String,
) -> serde_json::Value {
    serde_json::json!({
        "success": true,
        "filePath": file_path.to_string_lossy(),
        "directoryPath": state.exports_dir.to_string_lossy(),
        "fileName": file_name,
        "fileKind": file_kind,
        "isPortableMode": state.is_portable,
        "message": message,
    })
}

/// Canonicalize a candidate path and require it to live inside the exports
/// directory. Rejects traversal and arbitrary paths outside the export root.
pub(crate) fn canonical_exports_path(state: &AppState, candidate: &Path) -> Result<PathBuf, String> {
    crate::paths::canonical_within(
        &state.exports_dir,
        candidate,
        "EXPORT_DIR_UNAVAILABLE",
        "FILE_NOT_FOUND",
        "PATH_OUTSIDE_EXPORTS",
    )
}

/// Canonicalize a directory path inside the application data root.
pub(crate) fn canonical_data_path(state: &AppState, candidate: &Path) -> Result<PathBuf, String> {
    crate::paths::canonical_within(
        &state.data_dir,
        candidate,
        "DATA_DIR_UNAVAILABLE",
        "DIRECTORY_NOT_FOUND",
        "PATH_OUTSIDE_DATA",
    )
}

#[tauri::command]
pub(crate) async fn open_generated_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    token: String,
    file_path: String,
) -> Result<serde_json::Value, String> {
    Admin::check(&state, &token).await?;
    let path = canonical_exports_path(&state, Path::new(&file_path))?;
    if !path.is_file() {
        return Err("FILE_NOT_FOUND".into());
    }
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| {
            log::error!("open file {} failed: {error}", path.display());
            "OPEN_FAILED".to_string()
        })?;
    Ok(serde_json::json!({"success":true,"message":"File opened."}))
}

#[tauri::command]
pub(crate) async fn reveal_generated_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    token: String,
    file_path: String,
) -> Result<serde_json::Value, String> {
    Admin::check(&state, &token).await?;
    let path = canonical_exports_path(&state, Path::new(&file_path))?;
    if !path.is_file() {
        return Err("FILE_NOT_FOUND".into());
    }
    match app.opener().reveal_item_in_dir(&path) {
        Ok(()) => Ok(serde_json::json!({"success":true,"message":"File revealed in folder."})),
        Err(reveal_error) => {
            log::warn!(
                "reveal file {} failed: {reveal_error}; falling back to opening the folder",
                path.display()
            );
            let directory = path.parent().ok_or_else(|| "PATH_ERROR".to_string())?;
            app.opener()
                .open_path(directory.to_string_lossy().into_owned(), None::<&str>)
                .map_err(|open_error| {
                    log::error!(
                        "fallback folder open {} failed: {open_error}",
                        directory.display()
                    );
                    "REVEAL_FAILED".to_string()
                })?;
            Ok(serde_json::json!({"success":true,"message":"Opened the containing folder."}))
        }
    }
}

#[tauri::command]
pub(crate) async fn open_generated_directory(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    token: String,
    directory_path: String,
) -> Result<serde_json::Value, String> {
    Admin::check(&state, &token).await?;
    let path = canonical_data_path(&state, Path::new(&directory_path))?;
    if !path.is_dir() {
        return Err("DIRECTORY_NOT_FOUND".into());
    }
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| {
            log::error!("open directory {} failed: {error}", path.display());
            "OPEN_FAILED".to_string()
        })?;
    Ok(serde_json::json!({"success":true,"message":"Folder opened."}))
}

#[tauri::command]
pub(crate) async fn export_attendance_xlsx(
    state: State<'_, AppState>,
    token: String,
    date: String,
) -> Result<serde_json::Value, String> {
    Admin::check(&state, &token).await?;
    chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d").map_err(|_| "INVALID_DATE".to_string())?;
    let rows = crate::reporting::load_attendance_rows(&state.db, &date)
        .await
        .map_err(|e| e.to_string())?;
    let job_id = uuid::Uuid::new_v4().to_string();
    let artifact_id = uuid::Uuid::new_v4().to_string();
    let file_name = crate::reporting::attendance_artifact_filename(&date, &job_id[..8]);
    let output_path = state.exports_dir.join(&file_name);
    let relative_path = std::path::PathBuf::from("exports").join(&file_name);
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO export_jobs (job_id,kind,scope_json,format,status,requested_at,app_version,row_count,progress_total) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(&job_id).bind("ATTENDANCE_XLSX").bind(serde_json::json!({"date":date}).to_string()).bind("XLSX").bind("RUNNING").bind(&now).bind(env!("CARGO_PKG_VERSION")).bind(rows.len() as i64).bind(rows.len() as i64)
        .execute(&state.db).await.map_err(|e| e.to_string())?;
    if let Err(error) = (|| {
        std::fs::create_dir_all(output_path.parent().ok_or("EXPORT_PATH_ERROR")?)
            .map_err(|e| e.to_string())?;
        crate::reporting::generate_attendance_workbook(&rows, &date, &state.office, &output_path)
            .map_err(|e| e.to_string())
    })() {
        let _ = sqlx::query("UPDATE export_jobs SET status='FAILED',completed_at=?,error_code='ARTIFACT_GENERATION_FAILED',error_message=? WHERE job_id=?").bind(chrono::Utc::now().to_rfc3339()).bind(&error).bind(&job_id).execute(&state.db).await;
        return Err(error);
    }
    let bytes = std::fs::read(&output_path).map_err(|e| e.to_string())?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let completed = chrono::Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO generated_artifacts (artifact_id,job_id,document_id,kind,format,file_name,managed_relative_path,sha256,size_bytes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .bind(&artifact_id).bind(&job_id).bind(&job_id).bind("ATTENDANCE_XLSX").bind("XLSX").bind(&file_name).bind(relative_path.to_string_lossy().replace('\\', "/")).bind(&hash).bind(bytes.len() as i64).bind(&completed)
        .execute(&state.db).await.map_err(|e| e.to_string())?;
    sqlx::query("UPDATE export_jobs SET status='SUCCEEDED',completed_at=?,progress_current=progress_total WHERE job_id=?").bind(&completed).bind(&job_id).execute(&state.db).await.map_err(|e| e.to_string())?;
    crate::services::audit::log(&state.db, crate::services::audit::Entry::new("EXPORT_GENERATED", &completed, &format!("Attendance XLSX generated for {date}"), &format!("export-{job_id}"))).await;
    let metadata = generated_file_metadata(
        &state,
        &file_name,
        &output_path,
        "xlsx",
        format!("Attendance workbook generated for {date}."),
    );
    let mut response = metadata.as_object().cloned().unwrap_or_default();
    response.insert("jobId".into(), serde_json::json!(job_id));
    response.insert("artifactId".into(), serde_json::json!(artifact_id));
    response.insert("sizeBytes".into(), serde_json::json!(bytes.len()));
    response.insert("sha256".into(), serde_json::json!(hash));
    response.insert("rowCount".into(), serde_json::json!(rows.len()));
    Ok(serde_json::Value::Object(response))
}

/// A payroll sheet PDF is self-registered in the `payroll_pdfs` table (the
/// Payroll tab history source) rather than `export_jobs`/`generated_artifacts`
/// because `export_jobs.kind` is CHECK-constrained to the workbook/payslip
/// kinds and has no sheet-PDF kind; rebuilding that table for one new kind is
/// not worth the migration risk. The file still lands in `exports_dir` so the
/// existing Open PDF / Show in folder commands work unchanged.
#[tauri::command]
pub(crate) async fn generate_payroll_pdf(
    state: State<'_, AppState>,
    token: String,
    cutoff_start: String,
    cutoff_end: String,
    payroll_cutoff_label: String,
    worker_type: String,
) -> Result<serde_json::Value, String> {
    Admin::check(&state, &token).await?;
    if !valid_cutoff_date(&cutoff_start) || !valid_cutoff_date(&cutoff_end) {
        return Err("INVALID_CUTOFF_PERIOD".into());
    }
    if cutoff_end < cutoff_start {
        return Err("INVALID_CUTOFF_PERIOD".into());
    }
    if worker_type != "INTERN" {
        return Err("INVALID_WORKER_TYPE".into());
    }
    let worker_upper = "INTERN";
    let worker_lower = "intern";
    let label = if payroll_cutoff_label.trim().is_empty() {
        format!("{cutoff_start} to {cutoff_end}")
    } else {
        payroll_cutoff_label.trim().to_string()
    };
    let manila_now = chrono::Utc::now().with_timezone(&Manila);
    let file_name = format!(
        "payroll_{}_{}.pdf",
        manila_now.format("%Y-%m-%d_%H-%M-%S"),
        worker_lower
    );
    let relative_path = std::path::PathBuf::from("exports").join(&file_name);
    let output_path = state.exports_dir.join(&file_name);
    let generated_at = manila_now.to_rfc3339();

    let (employee_count, total_amount_centavos) = {
        let rows = crate::reporting::load_payroll_sheet_rows(
            &state.db,
            &cutoff_start,
            &cutoff_end,
            worker_upper,
        )
        .await
        .map_err(|e| e.to_string())?;
        if rows.is_empty() {
            return Err(format!(
                "NO_PAYROLL_RECORDS: No intern payroll records for {label}. Create and save an intern payroll for this cutoff first."
            ));
        }
        if let Err(error) = (|| {
            std::fs::create_dir_all(output_path.parent().ok_or("EXPORT_PATH_ERROR")?)
                .map_err(|e| e.to_string())?;
            crate::reporting::generate_payroll_sheet_pdf(
                &rows,
                &label,
                worker_upper,
                &state.office,
                &output_path,
            )
        })() {
            log::error!("payroll sheet PDF generation failed: {error}");
            return Err(error);
        }
        let total: i64 = rows.iter().map(|r| r.gross_compensation_centavos).sum();
        (rows.len() as i64, total)
    };

    let bytes = std::fs::read(&output_path).map_err(|e| e.to_string())?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let payroll_pdf_id = file_name.trim_end_matches(".pdf").to_string();
    sqlx::query(
        "INSERT INTO payroll_pdfs (payroll_pdf_id,file_name,managed_relative_path,cutoff_start,cutoff_end,payroll_cutoff_label,worker_type,employee_count,total_amount_centavos,sha256,size_bytes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(&payroll_pdf_id)
    .bind(&file_name)
    .bind(relative_path.to_string_lossy().replace('\\', "/"))
    .bind(&cutoff_start)
    .bind(&cutoff_end)
    .bind(&label)
    .bind(worker_upper)
    .bind(employee_count)
    .bind(total_amount_centavos)
    .bind(&hash)
    .bind(bytes.len() as i64)
    .bind(&generated_at)
    .execute(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    let message = format!("Payroll PDF generated for {label} ({worker_lower}).");
    let metadata = generated_file_metadata(&state, &file_name, &output_path, "pdf", message);
    let mut response = metadata.as_object().cloned().unwrap_or_default();
    response.insert(
        "pdf".into(),
        serde_json::json!({
            "payrollPdfId": payroll_pdf_id,
            "fileName": file_name,
            "filePath": output_path.to_string_lossy(),
            "directoryPath": state.exports_dir.to_string_lossy(),
            "cutoffStart": cutoff_start,
            "cutoffEnd": cutoff_end,
            "payrollCutoffLabel": label,
            "workerType": worker_lower,
            "generatedAt": generated_at,
            "employeeCount": employee_count,
            "totalAmount": total_amount_centavos as f64 / 100.0,
            "sizeBytes": bytes.len(),
        }),
    );
    response.insert("sizeBytes".into(), serde_json::json!(bytes.len()));
    response.insert("sha256".into(), serde_json::json!(hash));
    Ok(serde_json::Value::Object(response))
}

#[tauri::command]
pub(crate) async fn list_payroll_pdfs(
    state: State<'_, AppState>,
    token: String,
) -> Result<serde_json::Value, String> {
    Admin::check(&state, &token).await?;
    let rows = sqlx::query(
        "SELECT payroll_pdf_id,file_name,managed_relative_path,cutoff_start,cutoff_end,payroll_cutoff_label,worker_type,employee_count,total_amount_centavos,sha256,size_bytes,created_at FROM payroll_pdfs ORDER BY created_at DESC",
    )
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    let payroll_pdfs = rows
        .into_iter()
        .map(|row| {
            let relative: String = row.get("managed_relative_path");
            let file_name: String = row.get("file_name");
            serde_json::json!({
                "payrollPdfId": row.get::<String, _>("payroll_pdf_id"),
                "fileName": file_name,
                "filePath": state.data_dir.join(relative).to_string_lossy(),
                "directoryPath": state.exports_dir.to_string_lossy(),
                "cutoffStart": row.get::<String, _>("cutoff_start"),
                "cutoffEnd": row.get::<String, _>("cutoff_end"),
                "payrollCutoffLabel": row.get::<String, _>("payroll_cutoff_label"),
                "workerType": "intern",
                "generatedAt": row.get::<String, _>("created_at"),
                "employeeCount": row.get::<i64, _>("employee_count"),
                "totalAmount": row.get::<i64, _>("total_amount_centavos") as f64 / 100.0,
                "sizeBytes": row.get::<i64, _>("size_bytes"),
            })
        })
        .collect::<Vec<_>>();
    Ok(serde_json::json!({"success": true, "payrollPdfs": payroll_pdfs}))
}

/// Payslip numbers for every intern in the cutoff, plus the letterhead the
/// WebView draws on each PNG. Amounts are the payroll-sheet amounts (centavos).
#[tauri::command]
pub(crate) async fn payroll_intern_payslips(
    state: State<'_, AppState>,
    token: String,
    cutoff_start: String,
    cutoff_end: String,
) -> Result<serde_json::Value, String> {
    Admin::check(&state, &token).await?;
    if !valid_cutoff_date(&cutoff_start)
        || !valid_cutoff_date(&cutoff_end)
        || cutoff_end < cutoff_start
    {
        return Err("INVALID_CUTOFF_PERIOD".into());
    }
    let payslips = crate::reporting::load_intern_payslips(&state.db, &cutoff_start, &cutoff_end)
        .await
        .map_err(|e| e.to_string())?;
    if payslips.is_empty() {
        return Err(format!(
            "NO_PAYROLL_RECORDS: No intern payroll records for {cutoff_start} to {cutoff_end}. Generate the cutoff payroll first."
        ));
    }
    Ok(serde_json::json!({
        "success": true,
        "companyName": state.office.company_name,
        "companyAddress": state.office.display_full(),
        "payslips": payslips,
    }))
}

/// Saves the rendered payslip PNGs into one timestamped folder under
/// `exports/payslips` (inside the data dir, so `open_generated_directory`
/// can open it).
#[tauri::command]
pub(crate) async fn save_intern_payslip_images(
    state: State<'_, AppState>,
    token: String,
    payroll_cutoff_label: String,
    images: Vec<crate::reporting::InternPayslipImage>,
) -> Result<serde_json::Value, String> {
    Admin::check(&state, &token).await?;
    let label = match payroll_cutoff_label.trim() {
        "" => "Payslips",
        trimmed => trimmed,
    };
    let manila_now = chrono::Utc::now().with_timezone(&Manila);
    let dir = state.exports_dir.join("payslips").join(format!(
        "{} {}",
        crate::reporting::payslip_display_file_stem(label),
        manila_now.format("%Y-%m-%d %H-%M-%S")
    ));
    let existed = dir.exists();
    let names = match crate::reporting::write_intern_payslip_images(&dir, &images) {
        Ok(names) => names,
        Err(error) => {
            log::error!("intern payslip image save failed: {error}");
            // Drop a half-written folder, never one that was already there.
            if !existed && dir.exists() {
                let _ = std::fs::remove_dir_all(&dir);
            }
            return Err(error);
        }
    };
    Ok(serde_json::json!({
        "success": true,
        "directoryPath": dir.to_string_lossy(),
        "fileCount": names.len(),
        "fileNames": names,
        "message": format!("Saved {} payslip image(s) for {label}.", names.len()),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::*;


    #[test]
    fn generated_file_metadata_is_structured_and_absolute() {
        let temp = std::env::temp_dir().join(format!("alpha-meta-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(temp.join("exports")).unwrap();
        let data_dir = temp.clone();
        let exports_dir = temp.join("exports");
        let state = tauri::async_runtime::block_on(AppState::new(
            data_dir.clone(),
            data_dir.join("attendance.db"),
            exports_dir.clone(),
            true,
            LanConfig::default(),
            OfficeConfig::default(),
            crate::config::ScannerConfig::default(),
            crate::config::TtsConfig::default(),
            crate::config::UpdaterConfig::default(),
        ))
        .unwrap();
        let file_path = exports_dir.join("payroll-2026-08-04.csv");
        let metadata = generated_file_metadata(
            &state,
            "payroll-2026-08-04.csv",
            &file_path,
            "csv",
            "Payroll CSV generated.".into(),
        );
        assert_eq!(metadata["success"], true);
        assert_eq!(metadata["fileKind"], "csv");
        assert_eq!(metadata["isPortableMode"], true);
        assert_eq!(metadata["fileName"], "payroll-2026-08-04.csv");
        assert_eq!(
            metadata["directoryPath"],
            exports_dir.to_string_lossy().as_ref()
        );
        assert_eq!(metadata["filePath"], file_path.to_string_lossy().as_ref());
        assert!(metadata["message"]
            .as_str()
            .unwrap()
            .contains("Payroll CSV generated"));
        tauri::async_runtime::block_on(state.db.close());
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[tokio::test]
    async fn export_path_validation_rejects_paths_outside_the_exports_root() {
        let temp = std::env::temp_dir().join(format!("alpha-paths-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(temp.join("exports")).unwrap();
        let data_dir = temp.clone();
        let exports_dir = temp.join("exports");
        let state = AppState::new(
            data_dir.clone(),
            data_dir.join("attendance.db"),
            exports_dir.clone(),
            false,
            LanConfig::default(),
            OfficeConfig::default(),
            crate::config::ScannerConfig::default(),
            crate::config::TtsConfig::default(),
            crate::config::UpdaterConfig::default(),
        )
        .await
        .unwrap();
        let inside = exports_dir.join("sample.csv");
        std::fs::write(&inside, "a,b\n").unwrap();
        assert!(canonical_exports_path(&state, &inside).is_ok());
        let outside = data_dir.join("outside.txt");
        std::fs::write(&outside, "secret").unwrap();
        assert!(canonical_exports_path(&state, &outside).is_err());
        assert!(canonical_exports_path(&state, &exports_dir.join("missing.csv")).is_err());
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }
}
