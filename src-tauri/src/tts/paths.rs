use std::path::{Path, PathBuf};
use tauri::Manager;

/// Shared root search order for TTS asset lookup:
/// Tauri resource dir variants, exe-dir variants, then dev-relative variants.
pub fn search_roots(app_handle: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(res_dir) = app_handle.path().resource_dir() {
        roots.push(res_dir.clone());
        roots.push(res_dir.join("resources"));
        roots.push(res_dir.join("public"));
        roots.push(res_dir.join("client").join("public"));
    }
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(parent) = exe_path.parent() {
            roots.push(parent.to_path_buf());
            roots.push(parent.join("resources"));
            roots.push(parent.join("public"));
            roots.push(parent.join("client").join("public"));
        }
    }
    roots.push(PathBuf::from("client").join("public"));
    roots.push(PathBuf::from("..").join("client").join("public"));
    roots.push(PathBuf::from("public"));
    roots.push(PathBuf::from("resources"));
    roots.push(PathBuf::from("src-tauri").join("resources"));
    roots.push(PathBuf::from("..").join("src-tauri").join("resources"));
    roots
}

/// Returns the first `root.join(suffix)` that is an existing file.
pub fn first_existing(roots: &[PathBuf], suffix: &Path) -> Option<PathBuf> {
    for root in roots {
        let candidate = root.join(suffix);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}
