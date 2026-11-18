//! The Tauri commands, one module per area of the app. `lib.rs` registers them and starts the app.

pub(crate) mod attendance;
pub(crate) mod backup;
pub(crate) mod bathroom;
pub(crate) mod exports;
pub(crate) mod id_register;
pub(crate) mod kiosk;
pub(crate) mod lan;
pub(crate) mod payroll;
pub(crate) mod session;
pub(crate) mod sync;
pub(crate) mod users;
pub(crate) mod voice;

#[cfg(test)]
pub(crate) mod test_support;

#[cfg(test)]
mod scan_then_service_tests;

#[cfg(test)]
mod tests {
    /// Commands anyone at the kiosk may call: they open no admin screen and change no record an administrator owns.
    /// A new command is either added here on purpose or starts with `Admin::check`.
    const PUBLIC_COMMANDS: &[&str] = &[
        "get_attendance", "db_info", "bathroom_get_status", "bathroom_scan_rfid", "get_health", "get_config",
        "notify_scan_success", "scanner_status", "scanner_pause", "scan_rfid", "autostart_status", "autostart_set",
        "lan_status", "lan_start", "lan_stop", "open_viewer_url", "admin_account_unlock", "admin_account_reset",
        "setup_unlock", "setup_lock", "dtr_recon_get_latest_report", "tts_speak", "tts_stop", "tts_status",
        "voice_clip_states", "voice_worker_status", "voice_name_audio_url",
    ];

    const SOURCES: &[&str] = &[
        include_str!("attendance.rs"), include_str!("backup.rs"), include_str!("bathroom.rs"), include_str!("exports.rs"),
        include_str!("id_register.rs"), include_str!("kiosk.rs"), include_str!("lan.rs"), include_str!("payroll.rs"),
        include_str!("session.rs"), include_str!("sync.rs"), include_str!("users.rs"), include_str!("voice.rs"),
    ];

    /// Name and body of every `#[tauri::command]` function in `source`.
    fn commands(source: &str) -> Vec<(&str, &str)> {
        let mut found = Vec::new();
        let mut rest = source;
        while let Some(at) = rest.find("#[tauri::command]") {
            rest = &rest[at + "#[tauri::command]".len()..];
            let Some(name_at) = rest.find("fn ") else { break };
            let name_end = name_at + 3 + rest[name_at + 3..].find('(').unwrap();
            let open = name_end + rest[name_end..].find(") -> ").or_else(|| rest[name_end..].find(") {")).unwrap();
            let body_at = open + rest[open..].find('{').unwrap();
            let mut depth = 0usize;
            let mut end = body_at;
            for (offset, ch) in rest[body_at..].char_indices() {
                match ch {
                    '{' => depth += 1,
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            end = body_at + offset;
                            break;
                        }
                    }
                    _ => {}
                }
            }
            found.push((&rest[name_at + 3..name_end], &rest[body_at..end]));
        }
        found
    }

    #[test]
    fn every_command_checks_the_admin_session_or_is_listed_as_public() {
        let mut seen = 0;
        for source in SOURCES {
            for (name, body) in commands(source) {
                seen += 1;
                let checks = body.contains("Admin::check");
                // A command may hand its token to the function that does the work, which checks it first.
                let hands_on = body.contains("token");
                let public = PUBLIC_COMMANDS.contains(&name);
                assert!(checks || hands_on || public, "{name} neither checks the admin session nor is listed as public");
                assert!(!(public && checks), "{name} is listed as public but checks the admin session");
            }
        }
        assert_eq!(seen, 83, "the command count changed: check the new command's guard, then update this number");
    }

    #[test]
    fn a_function_given_the_token_checks_it() {
        for source in SOURCES {
            for (head, body) in source.split("\n}\n").filter_map(|item| item.split_once(") -> Result<")) {
                if !head.contains("token: &str") || head.contains("fn check") || head.contains("fn admin_authorized") {
                    continue;
                }
                let name = head.rsplit("fn ").next().unwrap_or(head).split('(').next().unwrap_or("");
                assert!(body.contains("Admin::check"), "{name} takes the admin token but does not check it");
            }
        }
    }
}
