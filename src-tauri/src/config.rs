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
    /// Preferred Google Drive folder (already created and shared with the
    /// service account). When unset, the app reuses a previously generated
    /// folder ID from the app data state file, or creates one when
    /// `google_create_folder_if_missing` is enabled.
    #[serde(default)]
    pub google_drive_folder_id: Option<String>,
    /// Name used when the app must create a Drive folder or spreadsheet.
    #[serde(default = "default_google_drive_folder_name")]
    pub google_drive_folder_name: String,
    /// Allow the app to create the Drive folder (and/or spreadsheet) when the
    /// configured/persisted IDs are missing or no longer accessible.
    #[serde(default)]
    pub google_create_folder_if_missing: bool,
    /// Title for a newly created Google Sheets spreadsheet.
    #[serde(default = "default_google_spreadsheet_title")]
    pub google_spreadsheet_title: String,
    #[serde(default = "default_admin_pin")]
    pub admin_pin: Option<String>,
    #[serde(default = "default_admin_session_minutes")]
    pub admin_session_minutes: u64,
    #[serde(default)]
    pub enabled: bool,
    /// When false, config.toml forbids starting the LAN viewer from the Live
    /// Attendance panel; `enabled` alone only controls auto-start at boot.
    #[serde(default = "default_allow_runtime_start")]
    pub allow_runtime_start: bool,
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
        Self {
            sheets_sync_endpoint: None,
            google_service_account_json_path: None,
            google_spreadsheet_id: None,
            google_drive_folder_id: None,
            google_drive_folder_name: default_google_drive_folder_name(),
            google_create_folder_if_missing: false,
            google_spreadsheet_title: default_google_spreadsheet_title(),
            admin_pin: Some("293906".into()),
            admin_session_minutes: 15,
            enabled: false,
            allow_runtime_start: true,
            bind_address: None,
            port: default_port(),
            allow_wildcard_bind: false,
            allowed_subnets: Vec::new(),
            auth_mode: ViewerAuthMode::None,
            viewer_password_hash: None,
            viewer_session_minutes: default_session_minutes(),
            sse_keep_alive_seconds: default_keep_alive_seconds(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ViewerAuthMode {
    #[default]
    None,
    Password,
}

fn default_port() -> u16 {
    4173
}
fn default_session_minutes() -> u64 {
    480
}
fn default_keep_alive_seconds() -> u64 {
    15
}
fn default_admin_pin() -> Option<String> {
    Some("293906".into())
}
fn default_admin_session_minutes() -> u64 {
    15
}
fn default_allow_runtime_start() -> bool {
    true
}
fn default_google_drive_folder_name() -> String {
    "Alpha Premier Attendance".into()
}
fn default_google_spreadsheet_title() -> String {
    "Alpha Premier Attendance".into()
}

/// How the RFID reader is attached to the front-desk laptop.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ScannerMode {
    /// The reader behaves as a keyboard wedge: it types the card UID followed
    /// by Enter.
    #[default]
    Keyboard,
}

/// Native RFID scanner configuration (`[scanner]` in config.toml).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ScannerCharacterSet {
    #[default]
    Decimal,
    Hex,
}

fn default_expected_length() -> u32 {
    10
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct ScannerConfig {
    #[serde(default)]
    pub mode: ScannerMode,
    #[serde(default = "default_expected_length")]
    pub expected_length: u32,
    #[serde(default)]
    pub character_set: ScannerCharacterSet,
    /// Most keyboard-wedge readers append Enter after the card UID. When true
    /// (default), an Enter key press finalizes the current input immediately.
    #[serde(default = "default_enter_suffix")]
    pub enter_suffix: bool,
    /// Fallback completion window (ms) when the reader does not send Enter:
    /// input is finalized after this much silence. Also the inter-character
    /// gap that separates two card taps.
    #[serde(default = "default_idle_timeout_ms")]
    pub idle_timeout_ms: u64,
    /// Native duplicate window (ms): identical UIDs read within this window are
    /// swallowed so one physical tap never produces two scan requests. The
    /// backend keeps its own 500 ms guard and 10 s physical cooldown.
    #[serde(default = "default_dedup_ms")]
    pub dedup_ms: u64,
}

fn default_enter_suffix() -> bool {
    true
}
fn default_idle_timeout_ms() -> u64 {
    150
}
fn default_dedup_ms() -> u64 {
    300
}

/// Local SQLite database location override (`[database]` in config.toml).
///
/// Default: `attendance.db` inside the resolved application data directory.
/// Set `path` to a database file (a value with a file extension, or an
/// existing file) or to a directory (the app then uses `<dir>/attendance.db`).
/// Relative paths resolve against the config directory, so a portable
/// deployment can carry the database next to the executable. The
/// `ALPHA_PREMIER_DB_PATH` environment variable is a lower-priority override
/// for installers and scripting.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct DatabaseConfig {
    #[serde(default)]
    pub path: Option<String>,
}

/// Voice announcement configuration (`[tts]` in config.toml).
#[derive(Debug, Clone, Deserialize)]
pub struct TtsConfig {
    #[serde(default = "default_tts_enabled")]
    pub enabled: bool,
    #[serde(default = "default_tts_engine")]
    pub engine: String,
    #[serde(default)]
    pub voice_model: Option<String>,
    #[serde(default)]
    pub piper_path: Option<String>,
    #[serde(default = "default_tts_rate")]
    pub rate: f32,
    #[serde(default = "default_tts_volume")]
    pub volume: f32,
}

fn default_tts_enabled() -> bool {
    true
}
fn default_tts_engine() -> String {
    "auto".into()
}
fn default_tts_rate() -> f32 {
    1.0
}
fn default_tts_volume() -> f32 {
    1.0
}

impl Default for TtsConfig {
    fn default() -> Self {
        Self {
            enabled: default_tts_enabled(),
            engine: default_tts_engine(),
            voice_model: None,
            piper_path: None,
            rate: default_tts_rate(),
            volume: default_tts_volume(),
        }
    }
}

impl Default for ScannerConfig {
    fn default() -> Self {
        Self {
            mode: ScannerMode::default(),
            expected_length: default_expected_length(),
            character_set: ScannerCharacterSet::default(),
            enter_suffix: default_enter_suffix(),
            idle_timeout_ms: default_idle_timeout_ms(),
            dedup_ms: default_dedup_ms(),
        }
    }
}

impl LanConfig {
    pub fn validate(&self) -> Result<(), String> {
        if !self.enabled {
            return Ok(());
        }
        self.validate_runtime()
    }

    /// Validation for runtime start from the Live Attendance panel: the bind
    /// address may be omitted (the app then auto-detects the office LAN IP),
    /// but every other safety constraint still applies even when `enabled` is
    /// false and the server is started on demand.
    pub fn validate_runtime(&self) -> Result<(), String> {
        if let Some(address) = self.bind_address {
            if address.is_unspecified() && !self.allow_wildcard_bind {
                return Err("wildcard LAN bind requires lan.allow_wildcard_bind=true".into());
            }
            if !address.is_loopback() && !is_private(address) && !address.is_unspecified() {
                return Err("LAN bind address must be loopback or RFC1918 private IPv4".into());
            }
            if address.is_unspecified() && self.allowed_subnets.is_empty() {
                return Err("wildcard LAN bind requires at least one allowed subnet".into());
            }
        }
        if matches!(self.auth_mode, ViewerAuthMode::Password) && self.viewer_password_hash.is_none()
        {
            return Err("password viewer mode requires lan.viewer_password_hash".into());
        }
        Ok(())
    }
}

/// Canonical company office identity shown across the kiosk, dashboard, exports,
/// and printed references. All fields are configurable through the `[office]`
/// section of `config.toml`; the defaults below are the real office.
///
/// The canonical address is:
///   Unit 3104C, Tektite East Tower, Ortigas Center, Pasig, Metro Manila
///
/// `office_postal_code` is optional and configurable only. It is intentionally
/// left unset because no verified postal code should be hardcoded.
#[derive(Debug, Clone, Deserialize)]
pub struct OfficeConfig {
    #[serde(default = "default_company_name")]
    pub company_name: String,
    #[serde(default = "default_office_label")]
    pub office_label: String,
    #[serde(default = "default_address_line_1")]
    pub office_address_line_1: String,
    #[serde(default = "default_building")]
    pub office_building: String,
    #[serde(default = "default_district")]
    pub office_district: String,
    #[serde(default = "default_city")]
    pub office_city: String,
    #[serde(default = "default_region")]
    pub office_region: String,
    #[serde(default = "default_country")]
    pub office_country: String,
    #[serde(default)]
    pub office_postal_code: String,
    /// Optional tax identifier shown on generated payroll PDFs when set.
    #[serde(default)]
    pub tax_identification_number: Option<String>,
    #[serde(default = "default_display_short")]
    pub office_display_short: String,
    #[serde(default = "default_display_full")]
    pub office_display_full: String,
}

const OFFICE_FALLBACK_DISPLAY: &str = "Alpha Premier Office";

fn default_company_name() -> String {
    "Alpha Premier Group of Companies OPC.".into()
}
fn default_tax_identification_number() -> Option<String> {
    Some("010-871-213-0000".into())
}
fn default_office_label() -> String {
    "Main Office".into()
}
fn default_address_line_1() -> String {
    "Unit 3104C".into()
}
fn default_building() -> String {
    "Tektite East Tower".into()
}
fn default_district() -> String {
    "Ortigas Center".into()
}
fn default_city() -> String {
    "Pasig".into()
}
fn default_region() -> String {
    "Metro Manila".into()
}
fn default_country() -> String {
    "Philippines".into()
}
fn default_display_short() -> String {
    "Tektite East Tower, Ortigas Center, Pasig".into()
}
fn default_display_full() -> String {
    "Unit 3104C, Tektite East Tower, Ortigas Center, Pasig, Metro Manila".into()
}

impl Default for OfficeConfig {
    fn default() -> Self {
        Self {
            company_name: default_company_name(),
            office_label: default_office_label(),
            office_address_line_1: default_address_line_1(),
            office_building: default_building(),
            office_district: default_district(),
            office_city: default_city(),
            office_region: default_region(),
            office_country: default_country(),
            office_postal_code: String::new(),
            tax_identification_number: default_tax_identification_number(),
            office_display_short: default_display_short(),
            office_display_full: default_display_full(),
        }
    }
}

/// Join non-empty, trimmed address parts; never emits broken comma chains.
fn join_address_parts(parts: Vec<String>) -> String {
    parts
        .into_iter()
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(", ")
}

impl OfficeConfig {
    pub fn load(config_dir: &Path) -> Result<Self, String> {
        load_config(config_dir).map(|(_, office, _, _, _)| office)
    }

    fn compose_short(&self) -> String {
        join_address_parts(vec![
            self.office_building.clone(),
            self.office_district.clone(),
            self.office_city.clone(),
        ])
    }

    fn compose_full(&self) -> String {
        let city = self.office_city.trim();
        let postal = self.office_postal_code.trim();
        let city_with_postal = if postal.is_empty() {
            city.to_string()
        } else if city.is_empty() {
            postal.to_string()
        } else {
            format!("{city} {postal}")
        };
        join_address_parts(vec![
            self.office_address_line_1.clone(),
            self.office_building.clone(),
            self.office_district.clone(),
            city_with_postal,
            self.office_region.clone(),
        ])
    }

    /// Short display for compact UI, badges, and narrow cards.
    pub fn display_short(&self) -> String {
        let configured = self.office_display_short.trim();
        if !configured.is_empty() {
            return configured.to_string();
        }
        let composed = self.compose_short();
        if !composed.is_empty() {
            return composed;
        }
        OFFICE_FALLBACK_DISPLAY.to_string()
    }

    /// Full display for settings, setup, exports, and printed headers.
    pub fn display_full(&self) -> String {
        let configured = self.office_display_full.trim();
        if !configured.is_empty() {
            return configured.to_string();
        }
        let composed = self.compose_full();
        if !composed.is_empty() {
            return composed;
        }
        OFFICE_FALLBACK_DISPLAY.to_string()
    }

    /// `Company: X` / `Office: Y` metadata lines used by exports and headers.
    pub fn metadata_lines(&self) -> Vec<String> {
        vec![
            format!("Company: {}", self.company_name.trim()),
            format!("Office: {}", self.display_full()),
        ]
    }
}

/// Load the LAN, office, scanner, database, and TTS sections from `config.toml`
/// (defaults when absent).
pub fn load_config(
    config_dir: &Path,
) -> Result<(LanConfig, OfficeConfig, ScannerConfig, DatabaseConfig, TtsConfig), String> {
    let path = config_dir.join("config.toml");
    if !path.exists() {
        return Ok((
            LanConfig::default(),
            OfficeConfig::default(),
            ScannerConfig::default(),
            DatabaseConfig::default(),
            TtsConfig::default(),
        ));
    }
    let contents =
        fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    #[derive(Deserialize, Default)]
    struct Root {
        #[serde(default)]
        lan: LanConfig,
        #[serde(default)]
        office: OfficeConfig,
        #[serde(default)]
        scanner: ScannerConfig,
        #[serde(default)]
        database: DatabaseConfig,
        #[serde(default)]
        tts: TtsConfig,
    }
    let root: Root =
        toml::from_str(&contents).map_err(|e| format!("parse {}: {e}", path.display()))?;
    let mut lan = root.lan;
    if lan
        .sheets_sync_endpoint
        .as_deref()
        .is_some_and(str::is_empty)
    {
        lan.sheets_sync_endpoint = None;
    }
    if lan
        .google_service_account_json_path
        .as_deref()
        .is_some_and(str::is_empty)
    {
        lan.google_service_account_json_path = None;
    }
    if lan
        .google_spreadsheet_id
        .as_deref()
        .is_some_and(str::is_empty)
    {
        lan.google_spreadsheet_id = None;
    }
    if lan
        .google_drive_folder_id
        .as_deref()
        .is_some_and(str::is_empty)
    {
        lan.google_drive_folder_id = None;
    }
    if lan.google_drive_folder_name.trim().is_empty() {
        lan.google_drive_folder_name = default_google_drive_folder_name();
    }
    if lan.google_spreadsheet_title.trim().is_empty() {
        lan.google_spreadsheet_title = default_google_spreadsheet_title();
    }
    if lan.admin_pin.as_deref().is_some_and(str::is_empty) {
        lan.admin_pin = None;
    }
    if lan
        .viewer_password_hash
        .as_deref()
        .is_some_and(str::is_empty)
    {
        lan.viewer_password_hash = None;
    }
    lan.validate()?;
    if let Some(secret_path) = lan.google_service_account_json_path.clone() {
        let path_value = Path::new(&secret_path);
        if path_value.is_absolute() && !path_value.starts_with(config_dir) {
            return Err(
                "google service-account path must remain under the application config directory"
                    .into(),
            );
        }
        if path_value.is_relative() {
            lan.google_service_account_json_path =
                Some(config_dir.join(path_value).to_string_lossy().into_owned());
        }
    }
    let mut database = root.database;
    if database.path.as_deref().is_some_and(str::is_empty) {
        database.path = None;
    }
    Ok((lan, root.office, root.scanner, database, root.tts))
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
        assert_eq!(config.admin_pin.as_deref(), Some("293906"));
    }

    #[test]
    fn defaults_keep_google_drive_provisioning_disabled() {
        let config = LanConfig::default();
        assert_eq!(config.google_spreadsheet_id, None);
        assert_eq!(config.google_drive_folder_id, None);
        assert!(!config.google_create_folder_if_missing);
        assert_eq!(config.google_drive_folder_name, "Alpha Premier Attendance");
        assert_eq!(config.google_spreadsheet_title, "Alpha Premier Attendance");
    }

    #[test]
    fn lan_parses_google_drive_provisioning_config() {
        #[derive(Deserialize)]
        struct Root {
            #[serde(default)]
            lan: LanConfig,
        }
        let root: Root = toml::from_str(
            "[lan]\ngoogle_drive_folder_id = \"folder-123\"\ngoogle_drive_folder_name = \"Payroll Sync\"\ngoogle_create_folder_if_missing = true\ngoogle_spreadsheet_title = \"Attendance Export\"\n",
        )
        .expect("lan provisioning toml");
        assert_eq!(
            root.lan.google_drive_folder_id.as_deref(),
            Some("folder-123")
        );
        assert_eq!(root.lan.google_drive_folder_name, "Payroll Sync");
        assert!(root.lan.google_create_folder_if_missing);
        assert_eq!(root.lan.google_spreadsheet_title, "Attendance Export");
    }

    #[test]
    fn lan_normalizes_empty_google_ids_to_none() {
        let temp =
            std::env::temp_dir().join(format!("alpha-config-google-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        std::fs::write(
            temp.join("config.toml"),
            "[lan]\ngoogle_drive_folder_id = \"\"\ngoogle_spreadsheet_id = \"\"\n",
        )
        .unwrap();
        let (lan, _, _, _, _) = load_config(&temp).expect("load config");
        assert_eq!(lan.google_drive_folder_id, None);
        assert_eq!(lan.google_spreadsheet_id, None);
        assert_eq!(lan.google_drive_folder_name, "Alpha Premier Attendance");
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn wildcard_requires_explicit_subnet() {
        let config = LanConfig {
            enabled: true,
            bind_address: Some(IpAddr::V4(Ipv4Addr::UNSPECIFIED)),
            allow_wildcard_bind: true,
            ..Default::default()
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn office_defaults_match_the_canonical_address() {
        let office = OfficeConfig::default();
        assert_eq!(office.company_name, "Alpha Premier Group of Companies OPC.");
        assert_eq!(
            office.display_full(),
            "Unit 3104C, Tektite East Tower, Ortigas Center, Pasig, Metro Manila"
        );
        assert_eq!(
            office.display_short(),
            "Tektite East Tower, Ortigas Center, Pasig"
        );
        assert!(
            office.office_postal_code.is_empty(),
            "postal code must stay unset until confirmed"
        );
        assert_eq!(
            office.tax_identification_number.as_deref(),
            Some("010-871-213-0000")
        );
    }

    #[test]
    fn office_parses_optional_tax_identification_number() {
        #[derive(Deserialize)]
        struct Root {
            #[serde(default)]
            office: OfficeConfig,
        }
        let root: Root =
            toml::from_str("[office]\ntax_identification_number = \"010-871-213-0000\"\n")
                .expect("office config");
        assert_eq!(
            root.office.tax_identification_number.as_deref(),
            Some("010-871-213-0000")
        );
    }

    #[test]
    fn office_composes_displays_from_structured_fields_when_unset() {
        let office = OfficeConfig {
            office_display_short: String::new(),
            office_display_full: String::new(),
            office_postal_code: "1600".into(),
            ..OfficeConfig::default()
        };
        assert_eq!(
            office.display_full(),
            "Unit 3104C, Tektite East Tower, Ortigas Center, Pasig 1600, Metro Manila"
        );
        assert_eq!(
            office.display_short(),
            "Tektite East Tower, Ortigas Center, Pasig"
        );
    }

    #[test]
    fn office_falls_back_without_broken_comma_chains() {
        let empty = OfficeConfig {
            office_address_line_1: String::new(),
            office_building: String::new(),
            office_district: String::new(),
            office_city: String::new(),
            office_region: String::new(),
            office_display_short: String::new(),
            office_display_full: String::new(),
            ..OfficeConfig::default()
        };
        assert_eq!(empty.display_full(), "Alpha Premier Office");
        assert_eq!(empty.display_short(), "Alpha Premier Office");
        let partial = OfficeConfig {
            office_address_line_1: String::new(),
            office_building: String::new(),
            office_district: String::new(),
            office_city: "Pasig".into(),
            office_region: "Metro Manila".into(),
            office_display_short: String::new(),
            office_display_full: String::new(),
            ..OfficeConfig::default()
        };
        assert_eq!(partial.display_full(), "Pasig, Metro Manila");
        assert_eq!(partial.display_short(), "Pasig");
    }

    #[test]
    fn office_metadata_lines_carry_company_and_full_address() {
        let office = OfficeConfig::default();
        assert_eq!(
            office.metadata_lines(),
            vec![
                "Company: Alpha Premier Group of Companies OPC.".to_string(),
                "Office: Unit 3104C, Tektite East Tower, Ortigas Center, Pasig, Metro Manila"
                    .to_string(),
            ]
        );
    }

    #[test]
    fn scanner_defaults_to_keyboard_wedge() {
        let scanner = ScannerConfig::default();
        assert_eq!(scanner.mode, ScannerMode::Keyboard);
        assert!(scanner.enter_suffix);
        assert_eq!(scanner.idle_timeout_ms, 150);
        assert_eq!(scanner.dedup_ms, 300);
        assert_eq!(scanner.expected_length, 10);
        assert_eq!(scanner.character_set, ScannerCharacterSet::Decimal);
    }

    #[test]
    fn scanner_parses_eight_character_hex_profile() {
        #[derive(Deserialize)]
        struct Root {
            #[serde(default)]
            scanner: ScannerConfig,
        }
        let root: Root =
            toml::from_str("[scanner]\ncharacter_set = \"hex\"\nexpected_length = 8\n")
                .expect("scanner profile");
        assert_eq!(root.scanner.character_set, ScannerCharacterSet::Hex);
        assert_eq!(root.scanner.expected_length, 8);
    }

    #[test]
    fn scanner_parses_variable_length_profile() {
        #[derive(Deserialize)]
        struct Root {
            #[serde(default)]
            scanner: ScannerConfig,
        }
        let root: Root = toml::from_str(
            "[scanner]\nexpected_length = 0\nenter_suffix = true\nidle_timeout_ms = 200\n",
        )
        .expect("scanner profile");
        assert_eq!(root.scanner.expected_length, 0);
        assert!(root.scanner.enter_suffix);
        assert_eq!(root.scanner.idle_timeout_ms, 200);
    }

    #[test]
    fn database_config_parses_path_and_defaults_when_absent() {
        #[derive(Deserialize)]
        struct Root {
            #[serde(default)]
            database: DatabaseConfig,
        }
        let root: Root = toml::from_str("[database]\npath = \"D:/Attendance/attendance.db\"\n")
            .expect("database toml");
        assert_eq!(
            root.database.path.as_deref(),
            Some("D:/Attendance/attendance.db")
        );
        let empty: Root = toml::from_str("").expect("empty toml");
        assert_eq!(empty.database.path, None);
    }

    #[test]
    fn load_config_round_trips_database_section() {
        let temp = std::env::temp_dir().join(format!("alpha-config-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        std::fs::write(
            temp.join("config.toml"),
            "[database]\npath = \"data/attendance.db\"\n",
        )
        .unwrap();
        let (_, _, _, database, _) = load_config(&temp).expect("load config");
        assert_eq!(database.path.as_deref(), Some("data/attendance.db"));
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn tts_config_parses_section_and_defaults() {
        let tts = TtsConfig::default();
        assert!(tts.enabled);
        assert_eq!(tts.engine, "auto");
        assert_eq!(tts.rate, 1.0);
        assert_eq!(tts.volume, 1.0);

        #[derive(Deserialize)]
        struct Root {
            #[serde(default)]
            tts: TtsConfig,
        }
        let root: Root = toml::from_str("[tts]\nenabled = false\nengine = \"piper\"\nrate = 1.2\nvolume = 0.8\nvoice_model = \"en_US-amy-medium\"\n")
            .expect("tts toml");
        assert!(!root.tts.enabled);
        assert_eq!(root.tts.engine, "piper");
        assert_eq!(root.tts.rate, 1.2);
        assert_eq!(root.tts.volume, 0.8);
        assert_eq!(root.tts.voice_model.as_deref(), Some("en_US-amy-medium"));
    }
}
