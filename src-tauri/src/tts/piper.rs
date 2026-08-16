use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tauri::Manager;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

pub const DEFAULT_VOICE_MODEL: &str = "en_US-lessac-medium";

/// Locates the Piper executable on disk.
pub fn find_piper_binary(app_handle: &tauri::AppHandle, custom_path: Option<&str>) -> Option<PathBuf> {
    let exe_name = if cfg!(windows) { "piper.exe" } else { "piper" };

    // 1. Custom path override from config/options
    if let Some(custom) = custom_path {
        let path = PathBuf::from(custom.trim());
        if !custom.trim().is_empty() {
            if path.is_file() {
                return Some(path);
            }
            let candidate = path.join(exe_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    // 2. Tauri resource directory (packaged builds & dev mode)
    if let Ok(res_dir) = app_handle.path().resource_dir() {
        let candidates = [
            res_dir.join("piper").join(exe_name),
            res_dir.join("resources").join("piper").join(exe_name),
            res_dir.join("bin").join(exe_name),
            res_dir.join(exe_name),
        ];
        for candidate in candidates {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    // 3. Current executable directory (portable mode)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(parent) = exe_path.parent() {
            let candidates = [
                parent.join("piper").join(exe_name),
                parent.join("resources").join("piper").join(exe_name),
                parent.join(exe_name),
            ];
            for candidate in candidates {
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    // 4. Standard relative development paths
    let dev_candidates = [
        PathBuf::from("resources").join("piper").join(exe_name),
        PathBuf::from("src-tauri").join("resources").join("piper").join(exe_name),
        PathBuf::from("..").join("resources").join("piper").join(exe_name),
    ];
    for candidate in dev_candidates {
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
}

/// Locates the requested Piper `.onnx` model and its `.onnx.json` config.
pub fn find_voice_model(
    app_handle: &tauri::AppHandle,
    model_name_or_path: &str,
) -> Option<(PathBuf, Option<PathBuf>)> {
    let raw = model_name_or_path.trim();
    let model_str = if raw.is_empty() { DEFAULT_VOICE_MODEL } else { raw };
    let model_path = PathBuf::from(model_str);

    // 1. Absolute / direct path to .onnx file
    if model_path.is_file() {
        let config_path = find_companion_json(&model_path);
        return Some((model_path, config_path));
    }

    let onnx_filename = if model_str.ends_with(".onnx") {
        model_str.to_string()
    } else {
        format!("{model_str}.onnx")
    };

    // 2. Search resource directory
    if let Ok(res_dir) = app_handle.path().resource_dir() {
        let candidates = [
            res_dir.join("piper").join("models").join(&onnx_filename),
            res_dir.join("resources").join("piper").join("models").join(&onnx_filename),
            res_dir.join("models").join(&onnx_filename),
        ];
        for candidate in candidates {
            if candidate.is_file() {
                let config = find_companion_json(&candidate);
                return Some((candidate, config));
            }
        }
    }

    // 3. Search exe directory
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(parent) = exe_path.parent() {
            let candidates = [
                parent.join("piper").join("models").join(&onnx_filename),
                parent.join("resources").join("piper").join("models").join(&onnx_filename),
                parent.join("models").join(&onnx_filename),
            ];
            for candidate in candidates {
                if candidate.is_file() {
                    let config = find_companion_json(&candidate);
                    return Some((candidate, config));
                }
            }
        }
    }

    // 4. Search dev relative paths
    let dev_candidates = [
        PathBuf::from("resources").join("piper").join("models").join(&onnx_filename),
        PathBuf::from("src-tauri").join("resources").join("piper").join("models").join(&onnx_filename),
        PathBuf::from("..").join("resources").join("piper").join("models").join(&onnx_filename),
    ];
    for candidate in dev_candidates {
        if candidate.is_file() {
            let config = find_companion_json(&candidate);
            return Some((candidate, config));
        }
    }

    None
}

fn find_companion_json(onnx_path: &Path) -> Option<PathBuf> {
    let with_json_ext = onnx_path.with_extension("onnx.json");
    if with_json_ext.is_file() {
        return Some(with_json_ext);
    }
    let alt_json = onnx_path.with_extension("json");
    if alt_json.is_file() {
        return Some(alt_json);
    }
    None
}

/// Synthesizes text using Piper TTS by passing text via stdin and outputting a WAV file.
pub async fn synthesize_to_wav(
    piper_exe: &Path,
    model_path: &Path,
    config_path: Option<&Path>,
    text: &str,
    output_wav: &Path,
    rate: Option<f32>,
) -> Result<(), String> {
    let mut cmd = Command::new(piper_exe);
    cmd.arg("--model").arg(model_path);

    if let Some(cfg) = config_path {
        cmd.arg("--config").arg(cfg);
    }

    cmd.arg("--output_file").arg(output_wav);

    // Piper uses --length_scale for speech speed (inverse of rate)
    if let Some(r) = rate {
        if r > 0.1 && r < 5.0 {
            let length_scale = 1.0 / r;
            cmd.arg("--length_scale").arg(format!("{length_scale:.2}"));
        }
    }

    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // Spawn child
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Piper binary at {}: {e}", piper_exe.display()))?;

    // Write text to stdin
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(text.as_bytes())
            .await
            .map_err(|e| format!("Failed to write text to Piper stdin: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("Failed to flush Piper stdin: {e}"))?;
        drop(stdin); // Close stdin so Piper knows input is complete
    }

    // Wait for Piper with timeout
    let status = match tokio::time::timeout(Duration::from_secs(10), child.wait()).await {
        Ok(res) => res.map_err(|e| format!("Piper process error: {e}"))?,
        Err(_) => {
            let _ = child.kill().await;
            return Err("Piper speech synthesis timed out (10s limit)".to_string());
        }
    };

    if !status.success() {
        return Err(format!("Piper exited with status code {:?}", status.code()));
    }

    if !output_wav.is_file() {
        return Err(format!("Piper did not produce output WAV at {}", output_wav.display()));
    }

    let meta = std::fs::metadata(output_wav)
        .map_err(|e| format!("Failed to read generated WAV metadata: {e}"))?;
    if meta.len() < 44 {
        return Err("Piper produced an empty or corrupted WAV file".to_string());
    }

    Ok(())
}
