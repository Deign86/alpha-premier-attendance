fn main() {
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        println!("cargo:rustc-link-arg-bin=alpha-premier-attendance=/SUBSYSTEM:WINDOWS");
    }
    embed_service_account_key();
    tauri_build::build()
}

/// Copy the service-account JSON into OUT_DIR as `embedded-sheets-key.json`
/// when a local key is available, otherwise emit an empty marker so clean
/// local builds still compile with the fallback disabled. Sources (first
/// hit wins): `ALPHA_PREMIER_EMBED_KEY_JSON` (raw JSON, used by GitHub
/// Releases), `ALPHA_PREMIER_EMBED_KEY_PATH` (file path),
/// `%APPDATA%/com.alphapremier.attendance/attendance-sheets-key.json`,
/// `$HOME/.rfid-attendance/attendance-sheets-key.json`.
/// Release builds (`ALPHA_PREMIER_REQUIRE_EMBED_KEY=1`) fail closed when no
/// key is found so a release can never ship silently disconnected.
/// Ordinary CI (`ci.yml`) leaves the flag unset so `cargo test` runs
/// with the fallback DISABLED. Never prints key material.
fn embed_service_account_key() {
    println!("cargo:rerun-if-env-changed=ALPHA_PREMIER_EMBED_KEY_JSON");
    println!("cargo:rerun-if-env-changed=ALPHA_PREMIER_EMBED_KEY_PATH");
    println!("cargo:rerun-if-env-changed=ALPHA_PREMIER_REQUIRE_EMBED_KEY");
    let mut embedded: Option<String> = None;
    if let Ok(raw) = std::env::var("ALPHA_PREMIER_EMBED_KEY_JSON") {
        if raw.contains("client_email") && raw.contains("private_key") {
            embedded = Some(raw);
        }
    }
    if embedded.is_none() {
        let mut candidates: Vec<std::path::PathBuf> = Vec::new();
        if let Some(path) = std::env::var_os("ALPHA_PREMIER_EMBED_KEY_PATH") {
            candidates.push(std::path::PathBuf::from(path));
        }
        if let Some(appdata) = std::env::var_os("APPDATA") {
            candidates.push(
                std::path::Path::new(&appdata)
                    .join("com.alphapremier.attendance")
                    .join("attendance-sheets-key.json"),
            );
        }
        if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
            candidates.push(
                std::path::Path::new(&home)
                    .join(".rfid-attendance")
                    .join("attendance-sheets-key.json"),
            );
        }
        for path in &candidates {
            println!("cargo:rerun-if-changed={}", path.display());
            let Ok(raw) = std::fs::read_to_string(path) else {
                continue;
            };
            if raw.contains("client_email") && raw.contains("private_key") {
                embedded = Some(raw);
                break;
            }
        }
    }
    let out =
        std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR is set by cargo"))
            .join("embedded-sheets-key.json");
    if let Some(raw) = embedded {
        if std::fs::write(&out, raw).is_ok() {
            println!("cargo:warning=embedded service-account fallback ENABLED");
        } else {
            let _ = std::fs::write(&out, "");
            println!("cargo:warning=embedded service-account fallback DISABLED");
        }
    } else {
        if std::env::var("ALPHA_PREMIER_REQUIRE_EMBED_KEY").as_deref() == Ok("1") {
            panic!("missing embedded sheets key: set ALPHA_PREMIER_EMBED_KEY_JSON repo secret (full service-account JSON) so GitHub Releases ship DTR-connected");
        }
        let _ = std::fs::write(&out, "");
        println!("cargo:warning=embedded service-account fallback DISABLED");
    }
}
