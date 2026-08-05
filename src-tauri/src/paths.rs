use std::path::{Path, PathBuf};
use tauri::Manager;
use crate::config::DatabaseConfig;

/// Resolved application paths.
///
/// Installed mode: generated files live under the Tauri app local data
/// directory (never Program Files or the install directory).
///
/// Portable mode (explicit `portable.dat` marker next to the executable, or
/// `ALPHA_PREMIER_PORTABLE` set to a non-empty value other than "0"): the whole
/// data directory, including generated files, lives under `Data/` next to the
/// executable so the deployment can travel with the `.exe`.
pub struct ResolvedPaths {
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
    pub exports_dir: PathBuf,
    pub is_portable: bool,
}

/// Resolve config/data/export paths for the running app.
/// Never assumes the current working directory is a valid save location.
/// When portable detection fails, installed-mode resolution is the safe default.
pub fn resolve(app: &tauri::AppHandle) -> Result<ResolvedPaths, String> {
    if detect_portable() {
        let exe_dir = std::env::current_exe()
            .map_err(|e| format!("cannot resolve executable path: {e}"))?
            .parent()
            .ok_or_else(|| "cannot resolve executable directory".to_string())?
            .to_path_buf();
        let data_dir = exe_dir.join("Data");
        // A portable deployment may carry its own config.toml next to the exe;
        // fall back to the installed config location when absent.
        let config_dir = if exe_dir.join("config.toml").is_file() {
            exe_dir
        } else {
            app.path().app_config_dir().map_err(|e| e.to_string())?
        };
        Ok(ResolvedPaths {
            config_dir,
            data_dir: data_dir.clone(),
            exports_dir: data_dir.join("exports"),
            is_portable: true,
        })
    } else {
        let data_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
        let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
        Ok(ResolvedPaths {
            config_dir,
            data_dir: data_dir.clone(),
            exports_dir: data_dir.join("exports"),
            is_portable: false,
        })
    }
}

/// Portable mode is explicit and never assumed: a `portable.dat` marker next to
/// the executable, or the `ALPHA_PREMIER_PORTABLE` environment variable set to
/// a non-empty value other than "0".
pub fn detect_portable() -> bool {
    if let Some(value) = std::env::var_os("ALPHA_PREMIER_PORTABLE") {
        let text = value.to_string_lossy();
        if !text.is_empty() && text != "0" {
            return true;
        }
    }
    detect_portable_with_exe(std::env::current_exe().ok().as_deref())
}

fn detect_portable_with_exe(exe: Option<&Path>) -> bool {
    exe.and_then(Path::parent)
        .map(|dir| dir.join("portable.dat"))
        .is_some_and(|marker| marker.is_file())
}

/// Environment variable override for the SQLite database file location.
pub const ENV_DB_PATH: &str = "ALPHA_PREMIER_DB_PATH";

/// Resolve the live SQLite database file location.
///
/// Priority:
/// 1. `[database] path` in `config.toml` (relative paths resolve against the
///    config directory, so a portable deployment can carry the database next
///    to the executable and the path survives a move).
/// 2. `ALPHA_PREMIER_DB_PATH` environment variable (relative paths resolve
///    against the current working directory; for installers/scripting).
/// 3. Default: `attendance.db` inside the resolved data directory.
///
/// A value that points at an existing file, or that has a file extension, is
/// treated as the database file itself; anything else is treated as a
/// directory and `attendance.db` is appended.
pub fn resolve_db_path(config_dir: &Path, data_dir: &Path, database: &DatabaseConfig) -> PathBuf {
    let configured = database
        .path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let env_value = std::env::var_os(ENV_DB_PATH)
        .map(|value| value.to_string_lossy().into_owned())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let (value, base) = match configured {
        Some(value) => (value, config_dir),
        None => match env_value.as_deref() {
            Some(value) => (value, Path::new(".")),
            None => return data_dir.join("attendance.db"),
        },
    };
    let path = PathBuf::from(value);
    let path = if path.is_absolute() { path } else { base.join(path) };
    if path.extension().is_some() || path.is_file() {
        path
    } else {
        path.join("attendance.db")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portable_detection_requires_an_explicit_marker_next_to_the_exe() {
        let temp = std::env::temp_dir().join(format!("alpha-portable-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        let exe = temp.join("alpha-premier-attendance.exe");
        assert!(!detect_portable_with_exe(Some(&exe)));
        std::fs::write(temp.join("portable.dat"), "").unwrap();
        assert!(detect_portable_with_exe(Some(&exe)));
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn portable_detection_ignores_a_marker_elsewhere() {
        let temp = std::env::temp_dir().join(format!("alpha-portable-other-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        std::fs::write(temp.join("portable.dat"), "").unwrap();
        // A different exe directory without its own marker is not portable.
        let other = temp.join("elsewhere").join("app.exe");
        assert!(!detect_portable_with_exe(Some(&other)));
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn db_path_defaults_to_the_data_directory() {
        let database = DatabaseConfig::default();
        let resolved = resolve_db_path(Path::new("C:/cfg"), Path::new("C:/data"), &database);
        assert_eq!(resolved, PathBuf::from("C:/data/attendance.db"));
    }

    #[test]
    fn db_path_override_treats_a_dot_extension_as_a_file() {
        let database = DatabaseConfig { path: Some("D:/Attendance/attendance.db".into()) };
        let resolved = resolve_db_path(Path::new("C:/cfg"), Path::new("C:/data"), &database);
        assert_eq!(resolved, PathBuf::from("D:/Attendance/attendance.db"));
    }

    #[test]
    fn db_path_override_treats_a_directory_by_appending_attendance_db() {
        let database = DatabaseConfig { path: Some("D:/Attendance".into()) };
        let resolved = resolve_db_path(Path::new("C:/cfg"), Path::new("C:/data"), &database);
        assert_eq!(resolved, PathBuf::from("D:/Attendance/attendance.db"));
    }

    #[test]
    fn db_path_override_resolves_relative_paths_against_the_config_dir() {
        let database = DatabaseConfig { path: Some("data/attendance.db".into()) };
        let resolved = resolve_db_path(Path::new("C:/cfg"), Path::new("C:/data"), &database);
        assert_eq!(resolved, PathBuf::from("C:/cfg/data/attendance.db"));
    }
}
