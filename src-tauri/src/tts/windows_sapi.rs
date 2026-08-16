use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};

/// Returns true if Windows SAPI is supported on the current platform.
pub fn is_sapi_available() -> bool {
    cfg!(target_os = "windows")
}

/// Spawns a background Windows SAPI speech synthesizer process via PowerShell.
///
/// Text is passed securely through standard input (`[Console]::In.ReadToEnd()`),
/// preventing any command injection or shell interpolation vulnerabilities.
pub async fn spawn_sapi_speech(
    text: &str,
    rate: Option<f32>,
    volume: Option<f32>,
    voice_name: Option<&str>,
) -> Result<Child, String> {
    if !is_sapi_available() {
        return Err("Windows SAPI fallback is only supported on Windows".to_string());
    }

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
