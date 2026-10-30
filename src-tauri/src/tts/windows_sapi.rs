use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};

/// Returns true if a system voice is supported on the current platform
/// (Windows SAPI via PowerShell, or the macOS `say` command).
pub fn is_sapi_available() -> bool {
    cfg!(any(target_os = "windows", target_os = "macos"))
}

/// Spawns a background system speech process: Windows SAPI (PowerShell) or
/// macOS `say`.
pub async fn spawn_sapi_speech(
    text: &str,
    rate: Option<f32>,
    volume: Option<f32>,
    voice_name: Option<&str>,
) -> Result<Child, String> {
    if !is_sapi_available() {
        return Err("System voice fallback is only supported on Windows and macOS".to_string());
    }
    if cfg!(target_os = "macos") {
        return spawn_macos_say(text, rate, volume, voice_name).await;
    }
    spawn_windows_sapi(text, rate, volume, voice_name).await
}

/// Spawns a background Windows SAPI speech synthesizer process via PowerShell.
///
/// Text is passed securely through standard input (`[Console]::In.ReadToEnd()`),
/// preventing any command injection or shell interpolation vulnerabilities.
async fn spawn_windows_sapi(
    text: &str,
    rate: Option<f32>,
    volume: Option<f32>,
    voice_name: Option<&str>,
) -> Result<Child, String> {

    // SAPI Rate is integer from -10 to 10 (0 = normal)
    let sapi_rate = rate.map(|r| {
        let mapped = ((r - 1.0) * 10.0).round();
        (mapped as i32).clamp(-10, 10)
    });

    // SAPI Volume is integer from 0 to 100 (100 = full)
    let sapi_volume = volume.map(|v| {
        let mapped = (v * 100.0).round();
        (mapped as i32).clamp(0, 100)
    });

    let mut cmd = Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        r#"$rate = $env:TTS_RATE; $vol = $env:TTS_VOL; $voice = $env:TTS_VOICE; $text = [Console]::In.ReadToEnd(); if ($text) { Add-Type -AssemblyName System.Speech; $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; if ($rate -ne $null -and $rate -ne '') { $synth.Rate = [int]$rate }; if ($vol -ne $null -and $vol -ne '') { $synth.Volume = [int]$vol }; if ($voice -ne $null -and $voice -ne '') { try { $synth.SelectVoice($voice) } catch {} }; $synth.Speak($text) }"#,
    ]);

    if let Some(r) = sapi_rate {
        cmd.env("TTS_RATE", r.to_string());
    }
    if let Some(v) = sapi_volume {
        cmd.env("TTS_VOL", v.to_string());
    }
    if let Some(v) = voice_name.filter(|s| !s.trim().is_empty()) {
        cmd.env("TTS_VOICE", v.trim());
    }

    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(0x08000000);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn PowerShell SAPI speech process: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(text.as_bytes())
            .await
            .map_err(|e| format!("Failed to write text to SAPI stdin: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("Failed to flush SAPI stdin: {e}"))?;
        drop(stdin);
    }

    Ok(child)
}

/// macOS counterpart of the SAPI fallback using the built-in `say` command.
/// Text goes through stdin (`-f -`), so nothing is shell-interpolated.
async fn spawn_macos_say(
    text: &str,
    rate: Option<f32>,
    volume: Option<f32>,
    voice_name: Option<&str>,
) -> Result<Child, String> {
    let mut cmd = Command::new("/usr/bin/say");
    cmd.args(["-f", "-"]);
    // `say` default is ~175 words per minute; scale by the requested rate.
    if let Some(r) = rate {
        let wpm = (175.0 * r).round().clamp(80.0, 400.0) as i32;
        cmd.args(["-r", &wpm.to_string()]);
    }
    // Only pass voices macOS actually has; Piper model names (e.g.
    // `en_US-amy-medium`) would otherwise make `say` exit with an error,
    // matching SAPI's ignore-unknown-voice behaviour.
    if let Some(v) = voice_name.map(str::trim).filter(|s| !s.is_empty()) {
        if macos_voices().await.iter().any(|known| known.eq_ignore_ascii_case(v)) {
            cmd.args(["-v", v]);
        }
    }
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn macOS say process: {e}"))?;

    // `[[volm x]]` is the speech-synthesis embedded volume command (0.0–1.0).
    let body = match volume {
        Some(v) => format!("[[volm {:.2}]] {text}", v.clamp(0.0, 1.0)),
        None => text.to_string(),
    };
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(body.as_bytes())
            .await
            .map_err(|e| format!("Failed to write text to say stdin: {e}"))?;
        drop(stdin);
    }
    Ok(child)
}

/// Installed macOS voice names, read once from `say -v ?`.
async fn macos_voices() -> &'static Vec<String> {
    static VOICES: tokio::sync::OnceCell<Vec<String>> = tokio::sync::OnceCell::const_new();
    VOICES
        .get_or_init(|| async {
            let Ok(output) = Command::new("/usr/bin/say").args(["-v", "?"]).output().await else {
                return Vec::new();
            };
            // Each line: "<name (may contain spaces)>   <locale>   # sample".
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(|line| line.split('#').next())
                .filter_map(|left| {
                    let left = left.trim_end();
                    left.rsplit_once(char::is_whitespace)
                        .map(|(name, _locale)| name.trim().to_string())
                })
                .filter(|name| !name.is_empty())
                .collect()
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sapi_availability_reflects_os() {
        assert_eq!(
            is_sapi_available(),
            cfg!(any(target_os = "windows", target_os = "macos"))
        );
    }

    #[tokio::test]
    async fn sapi_spawns_and_exits_cleanly() {
        if !is_sapi_available() {
            return;
        }
        let child = spawn_sapi_speech("Test speech", Some(1.0), Some(1.0), None).await;
        assert!(child.is_ok());
        if let Ok(mut c) = child {
            let status = c.wait().await;
            assert!(status.is_ok());
        }
    }
}
