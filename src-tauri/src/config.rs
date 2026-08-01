use ipnet::IpNet;
use serde::Deserialize;
use std::{fs, net::IpAddr, path::Path};

#[derive(Debug, Clone, Deserialize)]
pub struct LanConfig {
    #[serde(default)]
    pub sheets_sync_endpoint: Option<String>,
    #[serde(default)]
    pub google_service_account_json_path: Option<String>,
    #[serde(default)]
    pub google_spreadsheet_id: Option<String>,
    #[serde(default)]
    pub admin_pin: Option<String>,
    #[serde(default = "default_admin_session_minutes")]
    pub admin_session_minutes: u64,
    #[serde(default)]
    pub enabled: bool,
    pub bind_address: Option<IpAddr>,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub allow_wildcard_bind: bool,
    #[serde(default)]
    pub allowed_subnets: Vec<IpNet>,
    #[serde(default)]
    pub auth_mode: ViewerAuthMode,
    pub viewer_password_hash: Option<String>,
    #[serde(default = "default_session_minutes")]
    pub viewer_session_minutes: u64,
    #[serde(default = "default_keep_alive_seconds")]
    pub sse_keep_alive_seconds: u64,
}

impl Default for LanConfig {
    fn default() -> Self {
        Self { sheets_sync_endpoint: None, google_service_account_json_path: None, google_spreadsheet_id: None, admin_pin: None, admin_session_minutes: 15, enabled: false, bind_address: None, port: default_port(), allow_wildcard_bind: false, allowed_subnets: Vec::new(), auth_mode: ViewerAuthMode::None, viewer_password_hash: None, viewer_session_minutes: default_session_minutes(), sse_keep_alive_seconds: default_keep_alive_seconds() }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ViewerAuthMode {
    #[default]
    None,
    Password,
}

fn default_port() -> u16 { 4173 }
fn default_session_minutes() -> u64 { 480 }
fn default_keep_alive_seconds() -> u64 { 15 }
fn default_admin_session_minutes() -> u64 { 15 }

impl LanConfig {
    pub fn load(config_dir: &Path) -> Result<Self, String> {
        let path = config_dir.join("config.toml");
        if !path.exists() { return Ok(Self::default()); }
        let contents = fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
        #[derive(Deserialize, Default)] struct Root { #[serde(default)] lan: LanConfig }
        let root: Root = toml::from_str(&contents).map_err(|e| format!("parse {}: {e}", path.display()))?;
        let mut lan = root.lan;
        if lan.sheets_sync_endpoint.as_deref().is_some_and(str::is_empty) { lan.sheets_sync_endpoint = None; }
        if lan.google_service_account_json_path.as_deref().is_some_and(str::is_empty) { lan.google_service_account_json_path = None; }
        if lan.google_spreadsheet_id.as_deref().is_some_and(str::is_empty) { lan.google_spreadsheet_id = None; }
        if lan.admin_pin.as_deref().is_some_and(str::is_empty) { lan.admin_pin = None; }
        if lan.viewer_password_hash.as_deref().is_some_and(str::is_empty) { lan.viewer_password_hash = None; }
        lan.validate()?;
        if let Some(secret_path) = lan.google_service_account_json_path.clone() {
            let path_value = Path::new(&secret_path);
            if path_value.is_absolute() && !path_value.starts_with(config_dir) { return Err("google service-account path must remain under the application config directory".into()); }
            if path_value.is_relative() { lan.google_service_account_json_path = Some(config_dir.join(path_value).to_string_lossy().into_owned()); }
        }
        Ok(lan)
    }

    pub fn validate(&self) -> Result<(), String> {
        if !self.enabled { return Ok(()); }
        let address = self.bind_address.ok_or("lan.bind_address is required when LAN mode is enabled")?;
        if address.is_unspecified() && !self.allow_wildcard_bind {
            return Err("wildcard LAN bind requires lan.allow_wildcard_bind=true".into());
        }
        if !address.is_loopback() && !is_private(address) && !address.is_unspecified() {
            return Err("LAN bind address must be loopback or RFC1918 private IPv4".into());
        }
        if matches!(self.auth_mode, ViewerAuthMode::Password) && self.viewer_password_hash.is_none() {
            return Err("password viewer mode requires lan.viewer_password_hash".into());
        }
        if address.is_unspecified() && self.allowed_subnets.is_empty() {
            return Err("wildcard LAN bind requires at least one allowed subnet".into());
        }
        Ok(())
    }
}

fn is_private(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(value) => value.is_private(),
        IpAddr::V6(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    #[test]
    fn defaults_disable_lan() {
        let config = LanConfig::default();
        assert!(!config.enabled);
        assert_eq!(config.port, 4173);
    }

    #[test]
    fn wildcard_requires_explicit_subnet() {
        let config = LanConfig { enabled: true, bind_address: Some(IpAddr::V4(Ipv4Addr::UNSPECIFIED)), allow_wildcard_bind: true, ..Default::default() };
        assert!(config.validate().is_err());
    }
}
