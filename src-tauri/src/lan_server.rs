use crate::{config::LanConfig, state::AppState};
use axum::{
    extract::{ConnectInfo, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        Html, IntoResponse,
    },
    routing::get,
    Json, Router,
};
use chrono::{DateTime, Utc};
use chrono_tz::Asia::Manila;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::{convert::Infallible, net::SocketAddr, time::Duration};
use tokio_stream::{wrappers::BroadcastStream, StreamExt};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanAttendanceRow {
    pub attendance_id: String,
    pub attendance_date: String,
    pub user_id: String,
    pub full_name: String,
    pub department: Option<String>,
    pub time_in: Option<String>,
    pub time_out: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanAttendanceSnapshot {
    pub success: bool,
    pub server_instance_id: String,
    pub snapshot_version: u64,
    pub date: String,
    pub attendance: Vec<LanAttendanceRow>,
    pub fetched_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LanAttendanceEvent {
    #[serde(rename = "attendance-updated")]
    AttendanceUpdated {
        event_id: String,
        server_instance_id: String,
        sequence: u64,
        occurred_at: DateTime<Utc>,
        request_id: String,
        attendance_date: String,
        attendance_id: String,
        cause: String,
        mutation: String,
        attendance: Option<LanAttendanceRow>,
    },
    #[serde(rename = "connection-status")]
    #[allow(dead_code)]
    // protocol contract: the viewer HTML listens for this event; the server does not currently emit it
    ConnectionStatus {
        event_id: String,
        server_instance_id: String,
        sequence: u64,
        occurred_at: DateTime<Utc>,
        status: String,
        connection_id: String,
    },
    #[serde(rename = "stale-data")]
    #[allow(dead_code)]
    // protocol contract: the viewer HTML listens for this event; stream errors emit a raw stale-data SSE event instead
    StaleData {
        event_id: String,
        server_instance_id: String,
        sequence: u64,
        occurred_at: DateTime<Utc>,
        reason: String,
        should_refetch: bool,
    },
}

#[derive(Debug, Deserialize)]
pub struct DateQuery {
    pub date: Option<String>,
    pub token: Option<String>,
}

/// Why the LAN viewer cannot serve, mapped to the shared client contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LanIssue {
    #[default]
    None,
    ConfigInvalid,
    PortInUse,
    NoLanIp,
    LoopbackBind,
    BindAddressNotPresent,
    BindFailed,
}

impl LanIssue {
    pub fn as_str(self) -> &'static str {
        match self {
            LanIssue::None => "none",
            LanIssue::ConfigInvalid => "config_invalid",
            LanIssue::PortInUse => "port_in_use",
            LanIssue::NoLanIp => "no_lan_ip",
            LanIssue::LoopbackBind => "loopback_bind",
            LanIssue::BindAddressNotPresent => "bind_address_not_present",
            LanIssue::BindFailed => "bind_failed",
        }
    }
}

/// Structured failure from starting the LAN viewer, used to set the runtime
/// phase and the diagnostic issue shown by the Live Attendance panel.
#[derive(Debug, Clone)]
pub enum LanStartError {
    /// Maps to `LanIssue::ConfigInvalid` → the viewer's `config_invalid`
    /// guidance panel. Config validation currently runs at app startup, so
    /// this is never raised at runtime; kept for the frontend contract.
    #[allow(dead_code)]
    Config(String),
    #[allow(dead_code)]
    NoLanIp,
    LoopbackBind,
    BindAddressNotPresent,
    PortInUse,
    Bind(String),
}

impl std::fmt::Display for LanStartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LanStartError::Config(message) => write!(f, "{message}"),
            LanStartError::NoLanIp => write!(
                f,
                "no reachable office LAN IP was detected (check the Wi-Fi/LAN connection, or set lan.bind_address to the office LAN IP; loopback is not shareable)"
            ),
            LanStartError::LoopbackBind => write!(
                f,
                "Live Attendance is bound to localhost and cannot be reached by other devices (set lan.bind_address to the office LAN IP, or leave it unset to auto-detect)"
            ),
            LanStartError::BindAddressNotPresent => write!(
                f,
                "the configured bind address does not match an active network adapter on this laptop (the current office IP is different; set lan.bind_address to the current office LAN IP, or leave it unset to auto-detect)"
            ),
            LanStartError::PortInUse => write!(f, "the configured LAN viewer port is already in use"),
            LanStartError::Bind(error) => write!(f, "failed to bind the LAN viewer: {error}"),
        }
    }
}

impl LanStartError {
    pub fn issue(&self) -> LanIssue {
        match self {
            LanStartError::Config(_) => LanIssue::ConfigInvalid,
            LanStartError::NoLanIp => LanIssue::NoLanIp,
            LanStartError::LoopbackBind => LanIssue::LoopbackBind,
            LanStartError::BindAddressNotPresent => LanIssue::BindAddressNotPresent,
            LanStartError::PortInUse => LanIssue::PortInUse,
            LanStartError::Bind(_) => LanIssue::BindFailed,
        }
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/attendance", get(attendance_page))
        .route("/api/attendance/today", get(attendance_today))
        .route("/api/events/attendance", get(attendance_events))
        .route("/api/health", get(health))
        .with_state(state)
}

/// The socket the viewer binds to: the configured `lan.bind_address` (never
/// loopback for the shareable viewer) or the detected office LAN IP.
fn resolve_bind_address(lan: &LanConfig) -> Result<SocketAddr, LanStartError> {
    if let Some(address) = lan.bind_address {
        if address.is_loopback() {
            return Err(LanStartError::LoopbackBind);
        }
        return Ok(SocketAddr::new(address, lan.port));
    }
    Ok(SocketAddr::new(
        std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED),
        lan.port,
    ))
}

/// Bind the viewer to the resolved LAN address and serve until aborted.
/// Returns the actual bound socket plus a task handle the runtime aborts on
/// stop. The caller (LanRuntime) owns the handle.
pub async fn bind_and_serve(
    state: AppState,
) -> Result<(SocketAddr, tauri::async_runtime::JoinHandle<()>), LanStartError> {
    let address = resolve_bind_address(&state.lan)?;
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::AddrInUse => LanStartError::PortInUse,
            // EADDRNOTAVAIL on Windows: the configured IP is not assigned to
            // any adapter on this laptop, so it can never be reached.
            std::io::ErrorKind::AddrNotAvailable => LanStartError::BindAddressNotPresent,
            _ => LanStartError::Bind(error.to_string()),
        })?;
    let actual = listener
        .local_addr()
        .map_err(|error| LanStartError::Bind(error.to_string()))?;
    let task = tauri::async_runtime::spawn(async move {
        let _ = axum::serve(
            listener,
            router(state).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    Ok((actual, task))
}

/// Read-only status of the LAN attendance viewer, consumed by the in-app
/// Live Attendance panel. Never exposes secrets, admin state, or mutations.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanStatusResponse {
    pub success: bool,
    pub state: String,
    pub enabled: bool,
    pub allow_runtime_start: bool,
    pub port: u16,
    pub bind_address: Option<String>,
    pub viewer_url: Option<String>,
    pub lan_ips: Vec<String>,
    pub active_lan_ip: Option<String>,
    pub network_scope: String,
    pub network_profile: String,
    pub config_valid: bool,
    pub config_error: Option<String>,
    pub issue: String,
    pub connected_sse_clients: u64,
    pub started_at: Option<u64>,
    pub last_error: Option<String>,
    /// Allowed client subnets from `lan.allowed_subnets` (empty = any private
    /// RFC1918 address on the same LAN).
    pub allowed_subnets: Vec<String>,
    /// True when the configured `lan.bind_address` (if any) is assigned to an
    /// active adapter on this laptop, or when auto-detection is in use.
    pub configured_bind_present: bool,
    /// Local probe result against the bound viewer's `/api/health`.
    /// `Some(true)` = reachable, `Some(false)` = unreachable, `None` = not
    /// checked (viewer not running).
    pub local_health_ok: Option<bool>,
    pub local_health_error: Option<String>,
    /// "present" | "missing" | "unknown" — whether an inbound Windows
    /// Firewall allow rule covers the viewer port.
    pub firewall_allow_rule: String,
    /// Plain-language operator guidance in priority order.
    pub guidance: Vec<String>,
}

/// Probe the running viewer's `/api/health` over the actual bound address so
/// the operator can distinguish "server not reachable at all" from "server is
/// up but inbound access is blocked". Returns `(ok, error)`.
async fn probe_local_health(state: &AppState) -> (Option<bool>, Option<String>) {
    let Some(bind) = state.lan_runtime.snapshot().await.bind_address else {
        return (None, None);
    };
    let url = format!("http://{bind}/api/health");
    let Ok(client) = reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(1200))
        .timeout(Duration::from_millis(2200))
        .build()
    else {
        return (None, Some("health probe client unavailable".into()));
    };
    match client.get(&url).send().await {
        Ok(response) => (Some(response.status().is_success()), None),
        Err(error) => (Some(false), Some(error.to_string())),
    }
}

pub async fn build_lan_status(state: &AppState) -> LanStatusResponse {
    let runtime = state.lan_runtime.snapshot().await;
    let config_error = state.lan.validate_runtime().err();
    let config_valid = config_error.is_none();
    let lan_ips = crate::lan_net::detect_lan_interfaces()
        .into_iter()
        .map(|item| item.ip.to_string())
        .collect::<Vec<_>>();
    let active_lan_ip = crate::lan_net::pick_active_lan_ip().map(|ip| ip.to_string());
    let network_profile = crate::lan_net::detect_network_profile().await;
    let firewall_allow_rule = crate::lan_net::detect_firewall_allow_rule(state.lan.port).await;
    let running = runtime.phase == crate::state::LanPhase::Running;

    // The shareable URL must use the real LAN IP, not loopback. When the bind
    // is 0.0.0.0 (wildcard) we advertise the detected active office IP.
    let display_ip = runtime
        .bind_address
        .map(|addr| addr.ip())
        .filter(|ip| !ip.is_unspecified())
        .map(|ip| ip.to_string())
        .or_else(|| active_lan_ip.clone());
    let viewer_url = if running {
        display_ip
            .as_ref()
            .map(|ip| format!("http://{ip}:{}/attendance", state.lan.port))
    } else {
        None
    };

    let allowed_subnets = state
        .lan
        .allowed_subnets
        .iter()
        .map(|subnet| subnet.to_string())
        .collect::<Vec<_>>();
    // Auto-detection (None) has nothing to be stale about; loopback config is
    // already surfaced as its own diagnostic.
    let configured_bind_present = state
        .lan
        .bind_address
        .map(|ip| ip.is_unspecified() || crate::lan_net::is_address_on_active_adapter(ip))
        .unwrap_or(true);

    let (local_health_ok, local_health_error) = if running {
        probe_local_health(state).await
    } else {
        (None, None)
    };

    let firewall_rule_state = match firewall_allow_rule {
        Some(true) => crate::lan_net::FirewallRuleState::Present,
        Some(false) => crate::lan_net::FirewallRuleState::Missing,
        None => crate::lan_net::FirewallRuleState::Unknown,
    };

    // Plain-language operator guidance, highest priority first.
    let mut guidance: Vec<String> = Vec::new();
    if running {
        if network_profile.likely_blocks_inbound() {
            guidance.push(
                "Windows network profile appears to be Public. Switch to Private for office LAN access."
                    .into(),
            );
        }
        if let Some(bind) = state.lan.bind_address {
            if !bind.is_unspecified() && !crate::lan_net::is_address_on_active_adapter(bind) {
                guidance.push(
                    "The configured bind address does not match an active network adapter on this laptop."
                        .into(),
                );
            }
        }
        if firewall_rule_state == crate::lan_net::FirewallRuleState::Missing {
            guidance.push(format!(
                "No Windows Firewall allow rule was found for port {}. Devices may be blocked from opening the viewer.",
                state.lan.port
            ));
        }
        if local_health_ok == Some(false) {
            guidance.push(
                "The viewer service is running but /api/health is not reachable from this laptop. Check Windows Firewall or the network profile."
                    .into(),
            );
        }
        if allowed_subnets.is_empty() {
            guidance.push(
                "No allowed subnets are configured, so any private address on the same office Wi-Fi/LAN can open the viewer."
                    .into(),
            );
        }
        guidance.push(
            "If devices still cannot open the link, confirm they are on the same office Wi-Fi/LAN and that this network does not isolate clients from each other."
                .into(),
        );
    } else if matches!(state.lan.bind_address, Some(address) if address.is_loopback()) {
        guidance.push(
            "Live Attendance is bound to localhost and cannot be reached by other devices.".into(),
        );
    } else if let Some(error) = &runtime.last_error {
        guidance.push(error.clone());
    }

    let (state_name, issue) = match runtime.phase {
        crate::state::LanPhase::Starting => ("starting", "none".to_string()),
        crate::state::LanPhase::Running => (
            "running",
            if network_profile.likely_blocks_inbound() {
                "firewall_likely_blocked".to_string()
            } else {
                "none".to_string()
            },
        ),
        crate::state::LanPhase::Stopped => {
            if !state.lan.enabled && !state.lan.allow_runtime_start {
                ("disabled", "none".to_string())
            } else {
                ("stopped", "none".to_string())
            }
        }
        crate::state::LanPhase::Error => ("error", runtime.issue.as_str().to_string()),
    };

    LanStatusResponse {
        success: true,
        state: state_name.into(),
        enabled: state.lan.enabled,
        allow_runtime_start: state.lan.allow_runtime_start,
        port: state.lan.port,
        bind_address: runtime.bind_address.map(|addr| addr.to_string()),
        viewer_url,
        lan_ips,
        active_lan_ip,
        network_scope:
            "Accessible to devices on the same office Wi-Fi / LAN (private network only).".into(),
        network_profile: network_profile.as_str().into(),
        config_valid,
        config_error,
        issue,
        connected_sse_clients: state
            .connected_sse_clients
            .load(std::sync::atomic::Ordering::Relaxed),
        started_at: runtime.started_at,
        last_error: runtime.last_error,
        allowed_subnets,
        configured_bind_present,
        local_health_ok,
        local_health_error,
        firewall_allow_rule: firewall_rule_state.as_str().into(),
        guidance,
    }
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// Minimal branded page for browser access that is not allowed (device outside
/// the office subnet, or viewer auth required). API routes keep returning JSON;
/// this only improves the operator-facing browser experience.
fn viewer_error_page(title: &str, message: &str) -> axum::response::Response {
    let title = html_escape(title);
    let message = html_escape(message);
    Html(format!(
        r#"<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>{title} · Alpha Premier Attendance</title>
<style>
  body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; background: #090a09; color: #f6f2e9; font-family: 'Segoe UI', system-ui, sans-serif; padding: 24px; }}
  .panel {{ width: min(520px, 100%); padding: 30px; background: #151613; border: 1px solid #3a3426; border-top: 3px solid #c6a254; border-radius: 6px; text-align: center; }}
  .mark {{ display: grid; place-items: center; width: 44px; height: 44px; margin: 0 auto 14px; color: #e1c477; border: 1px solid #c6a254; background: #1d1c17; font-family: 'Orbitron', 'Segoe UI', sans-serif; font-size: .72rem; font-weight: 700; border-radius: 3px; }}
  h1 {{ margin: 0 0 8px; font-size: 1.25rem; }}
  p {{ margin: 0; color: #aaa79e; font-size: .86rem; line-height: 1.6; }}
</style>
</head>
<body><div class="panel"><div class="mark">AP</div><h1>{title}</h1><p>{message}</p></div></body>
</html>"#
    ))
    .into_response()
}

async fn attendance_page(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<DateQuery>,
) -> impl IntoResponse {
    if !source_allowed(&state.lan, peer.ip()) {
        return viewer_error_page(
            "Outside the office network",
            "This device is not within the office network allowed for Live Attendance. Open the link from a device on the same office Wi-Fi or LAN as the front-desk laptop.",
        );
    }
    if !viewer_allowed(&state, &headers, query.token.as_deref()) {
        return viewer_error_page(
            "Viewer access required",
            "This Live Attendance view is protected. Open the Live Attendance screen on the front-desk laptop and use the link shown there (append ?token=... when password mode is enabled).",
        );
    }
    let company = html_escape(&state.office.company_name);
    let office_line = html_escape(&format!(
        "{} · {}",
        state.office.company_name,
        state.office.display_short()
    ));
    Html(r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Live Attendance · __COMPANY__</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@500;600;700&family=Poppins:wght@400;500;600;700&display=swap');
  :root {
    --black: #090a09; --surface: #151613; --surface-raised: #1d1c17;
    --ink: #f6f2e9; --muted: #aaa79e; --quiet: #77746c;
    --gold: #c6a254; --gold-bright: #e1c477; --gold-soft: #8d753e;
    --line: #3a3426; --line-bright: #66532d;
    --success: #98d2a8; --danger: #efaa92;
    --radius-sm: 3px; --radius-md: 6px;
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: var(--black); color: var(--ink); font-family: 'Poppins', 'Segoe UI', system-ui, sans-serif; }
  .topbar { display: flex; align-items: center; justify-content: space-between; gap: 18px; width: min(980px, calc(100% - 48px)); min-height: 72px; margin: 0 auto; border-bottom: 1px solid var(--line); }
  .brand-lockup { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .brand-mark { display: grid; place-items: center; width: 40px; height: 40px; color: var(--gold-bright); border: 1px solid var(--gold); background: var(--surface); font-family: 'Orbitron', 'Segoe UI', sans-serif; font-size: .7rem; font-weight: 700; border-radius: var(--radius-sm); flex: 0 0 auto; }
  .brand-text { min-width: 0; }
  .brand-name { margin: 0; color: var(--ink); font-family: 'Orbitron', 'Segoe UI', sans-serif; font-size: .76rem; font-weight: 700; letter-spacing: .015em; white-space: nowrap; }
  .brand-subtitle { margin: 3px 0 0; color: var(--quiet); font-size: .64rem; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .clock { display: grid; gap: 2px; text-align: right; }
  .clock strong { color: var(--gold-bright); font-family: 'Orbitron', 'Segoe UI', sans-serif; font-size: 1.12rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .clock span { color: var(--quiet); font-size: .64rem; font-weight: 600; white-space: nowrap; }
  main { width: min(980px, calc(100% - 48px)); margin: 0 auto; padding: 22px 0 40px; }
  .status-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; padding: 11px 14px; background: var(--surface); border: 1px solid var(--line); border-top: 2px solid var(--gold); border-radius: var(--radius-md); }
  .chip { display: inline-flex; align-items: center; gap: 8px; color: var(--muted); font-size: .66rem; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; white-space: nowrap; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--quiet); flex: 0 0 auto; }
  .dot.live { background: var(--success); box-shadow: 0 0 0 4px rgba(152, 210, 168, .14); }
  .dot.polling { background: var(--gold-bright); box-shadow: 0 0 0 4px rgba(225, 196, 119, .14); }
  .dot.reconnecting { background: var(--gold); animation: pulse 1.1s ease-in-out infinite; }
  .dot.connecting { background: var(--gold-soft); animation: pulse 1.1s ease-in-out infinite; }
  .dot.offline { background: var(--danger); }
  @keyframes pulse { 50% { opacity: .35; } }
  .last-update { margin-left: auto; color: var(--quiet); font-size: .7rem; white-space: nowrap; }
  .list { display: grid; gap: 10px; }
  .card { display: flex; align-items: center; gap: 14px; padding: 14px 16px; background: var(--surface); border: 1px solid var(--line); border-left: 4px solid var(--gold-soft); border-radius: var(--radius-md); }
  .card.in { border-left-color: var(--success); }
  .card.out { border-left-color: var(--gold-bright); }
  .card.late { border-left-color: var(--danger); }
  .card .who { min-width: 0; }
  .card .who .name { color: var(--ink); font-size: 1rem; font-weight: 600; }
  .card .who .meta { color: var(--quiet); font-size: .7rem; margin-top: 2px; }
  .badge { margin-left: auto; font-size: .66rem; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; padding: 6px 12px; border-radius: 999px; white-space: nowrap; }
  .card.in .badge { color: var(--success); border: 1px solid #4e825d; background: rgba(152, 210, 168, .08); }
  .card.out .badge { color: var(--gold-bright); border: 1px solid var(--gold-soft); background: rgba(225, 196, 119, .08); }
  .card.late .badge { color: var(--danger); border: 1px solid #a8553d; background: rgba(239, 170, 146, .08); }
  .card.late .when { color: var(--danger); }
  .card .when { text-align: right; font-size: .86rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .card .when small { display: block; color: var(--quiet); font-size: .64rem; margin-top: 2px; }
  .empty { text-align: center; color: var(--muted); padding: 44px 20px; background: var(--surface); border: 1px dashed var(--line-bright); border-radius: var(--radius-md); font-size: .85rem; }
  footer { text-align: center; color: var(--quiet); font-size: .68rem; padding: 0 0 26px; }
  @media (max-width: 620px) {
    .topbar { width: min(100% - 32px, 980px); min-height: 64px; }
    main { width: min(100% - 32px, 980px); }
    .brand-name { font-size: .68rem; }
    .brand-subtitle { font-size: .58rem; max-width: 150px; }
    .clock strong { font-size: .95rem; }
    .card { flex-wrap: wrap; gap: 10px; }
    .badge { margin-left: 0; }
    .card .when { white-space: normal; text-align: left; }
  }
</style>
</head>
<body>
<header class="topbar">
  <div class="brand-lockup">
    <div class="brand-mark" aria-hidden="true">AP</div>
    <div class="brand-text">
      <p class="brand-name">ALPHA PREMIER</p>
      <p class="brand-subtitle">Live Attendance · __OFFICE_LINE__</p>
    </div>
  </div>
  <div class="clock" aria-label="Current time"><strong id="clock">--:--:--</strong><span id="clockDate">—</span></div>
</header>
<main>
  <div class="status-bar"><span class="chip"><i class="dot" id="dot"></i><span id="state">Connecting…</span></span><span class="last-update" id="lastUpdate">Waiting for data</span></div>
  <div id="list" class="list"></div>
  <div id="empty" class="empty" hidden>No time-ins or time-outs recorded yet today.</div>
</main>
<footer>Read-only live attendance · Refresh or open this page again if it ever stops updating.</footer>
<script>
const tz = 'Asia/Manila';
const SNAPSHOT_TIMEOUT_MS = 8000;
const POLL_MS = 5000;
const OFFLINE_MS = 12000;
const stateEl = document.getElementById('state');
const dotEl = document.getElementById('dot');
const lastEl = document.getElementById('lastUpdate');
const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const token = new URLSearchParams(location.search).get('token');
const auth = token ? '&token=' + encodeURIComponent(token) : '';
const esAuth = token ? '?token=' + encodeURIComponent(token) : '';
let pollTimer = null;
let es = null;
let reconnectDelay = 1000;
let everLoaded = false;
let connMode = 'connecting';
let lastEventAt = 0;

function tick() {
  const now = new Date();
  document.getElementById('clock').textContent = now.toLocaleTimeString('en-PH', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  document.getElementById('clockDate').textContent = now.toLocaleDateString('en-PH', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}
function today() { return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date()); }
function escapeHtml(v) { return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function setStatus(label, cls) { stateEl.textContent = label; dotEl.className = 'dot ' + cls; }
function updateChip() {
  if (!everLoaded) { setStatus('Connecting…', 'connecting'); return; }
  if (connMode === 'live') { setStatus('Live — streaming', 'live'); return; }
  if (connMode === 'reconnecting') { setStatus('Reconnecting…', 'reconnecting'); return; }
  if (connMode === 'polling') { setStatus('Live — polling fallback', 'polling'); return; }
  setStatus('Offline — cannot reach the viewer service', 'offline');
}
function latestTime(row) { return row.timeOut || row.timeIn || ''; }
function card(row) {
  const isLate = row.status === 'LATE_TIMEOUT';
  const isOut = Boolean(row.timeOut);
  const time = isOut ? row.timeOut : row.timeIn;
  const when = time ? new Date(time).toLocaleString('en-PH', { timeZone: tz, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';
  const dept = row.department ? ' · ' + escapeHtml(row.department) : '';
  return '<div class="card ' + (isLate ? 'late' : (isOut ? 'out' : 'in')) + '">' +
    '<div class="who"><div class="name">' + escapeHtml(row.fullName) + '</div><div class="meta">' + escapeHtml(row.userId || '') + dept + '</div></div>' +
    '<div class="badge">' + (isLate ? 'Late Timeout — Fix Needed' : (isOut ? 'Time Out' : 'Time In')) + '</div>' +
    '<div class="when">' + escapeHtml(when) + '<small>' + escapeHtml(row.attendanceDate || '') + '</small></div>' +
    '</div>';
}
function render(rows) {
  const sorted = rows.slice().sort((a, b) => latestTime(b).localeCompare(latestTime(a)));
  listEl.innerHTML = sorted.map(card).join('');
  emptyEl.hidden = sorted.length > 0;
}
function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { cache: 'no-store', signal: controller.signal }).finally(() => clearTimeout(timer));
}
async function refresh() {
  try {
    const r = await fetchWithTimeout('/api/attendance/today?date=' + today() + auth, SNAPSHOT_TIMEOUT_MS);
    if (!r.ok) throw new Error('bad status ' + r.status);
    const data = await r.json();
    render(data.attendance || []);
    everLoaded = true;
    const now = new Date();
    lastEl.textContent = 'Updated ' + now.toLocaleTimeString('en-PH', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    // Silent SSE stall detection: if the stream claims to be live but has
    // produced nothing for longer than the keep-alive window, reconnect it.
    if (connMode === 'live' && Date.now() - lastEventAt > 20000) {
      connMode = 'reconnecting';
      if (es) { es.close(); es = null; }
    }
    if (connMode !== 'live') { connMode = 'polling'; }
    updateChip();
  } catch (err) {
    if (connMode !== 'live') { connMode = 'offline'; }
    updateChip();
  }
}
function startPolling() { if (!pollTimer) pollTimer = setInterval(refresh, POLL_MS); }
function connect() {
  if (es) { es.close(); es = null; }
  try { es = new EventSource('/api/events/attendance' + esAuth); } catch (err) { connMode = 'polling'; startPolling(); updateChip(); return; }
  es.onopen = () => { connMode = 'live'; lastEventAt = Date.now(); updateChip(); refresh(); };
  es.addEventListener('attendance-updated', () => { lastEventAt = Date.now(); refresh(); });
  es.addEventListener('connection-status', () => { lastEventAt = Date.now(); if (connMode !== 'live') { connMode = 'live'; updateChip(); } });
  es.addEventListener('stale-data', () => { lastEventAt = Date.now(); refresh(); });
  es.onerror = () => {
    if (es) { es.close(); es = null; }
    connMode = 'reconnecting';
    updateChip();
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
    setTimeout(connect, reconnectDelay);
  };
}
tick();
setInterval(tick, 1000);
// Snapshot first: render immediately, then stream. A broken stream never
// blocks the page because polling keeps the snapshot fresh and the watchdog
// below reports Offline instead of hanging forever.
refresh();
startPolling();
connect();
setTimeout(() => { if (!everLoaded) { connMode = 'offline'; updateChip(); } }, OFFLINE_MS);
</script>
</body>
</html>"#
        .replace("__COMPANY__", &company)
        .replace("__OFFICE_LINE__", &office_line))
        .into_response()
}

async fn attendance_today(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<DateQuery>,
) -> impl IntoResponse {
    if !viewer_allowed(&state, &headers, query.token.as_deref()) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"success":false,"error":{"code":"VIEWER_AUTH_REQUIRED","message":"Viewer authentication is required."}}))).into_response();
    }
    if !source_allowed(&state.lan, peer.ip()) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"success":false,"error":{"code":"SOURCE_NOT_ALLOWED","message":"Viewer is outside the configured private network."}}))).into_response();
    }
    let date = query
        .date
        .unwrap_or_else(|| Utc::now().with_timezone(&Manila).date_naive().to_string());
    if date.len() != 10 {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success":false,"error":{"code":"INVALID_DATE","message":"date must be YYYY-MM-DD"}}))).into_response();
    }
    let rows = sqlx::query("SELECT attendance_id, attendance_date, user_id, full_name, department, time_in, time_out, status FROM attendance WHERE attendance_date = ? ORDER BY COALESCE(time_out, time_in) DESC, full_name")
        .bind(&date).fetch_all(&state.db).await;
    match rows {
        Ok(rows) => {
            let attendance = rows.into_iter().map(|row| LanAttendanceRow { attendance_id: row.get("attendance_id"), attendance_date: row.get("attendance_date"), user_id: row.get("user_id"), full_name: row.get("full_name"), department: row.get("department"), time_in: row.get("time_in"), time_out: row.get("time_out"), status: row.get("status") }).collect::<Vec<_>>();
            Json(LanAttendanceSnapshot { success: true, server_instance_id: state.server_instance_id.to_string(), snapshot_version: state.bus.sequence.load(std::sync::atomic::Ordering::Relaxed), date, attendance, fetched_at: Utc::now() }).into_response()
        }
        Err(_) => (StatusCode::SERVICE_UNAVAILABLE, Json(serde_json::json!({"success":false,"error":{"code":"DATABASE_UNAVAILABLE","message":"Attendance data is unavailable"}}))).into_response(),
    }
}

#[derive(Debug)]
struct SseClientGuard {
    clients: std::sync::Arc<std::sync::atomic::AtomicU64>,
}
impl Drop for SseClientGuard {
    fn drop(&mut self) {
        self.clients
            .fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
    }
}

async fn attendance_events(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<DateQuery>,
) -> impl IntoResponse {
    if !viewer_allowed(&state, &headers, query.token.as_deref()) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"success":false,"error":{"code":"VIEWER_AUTH_REQUIRED","message":"Viewer authentication is required."}}))).into_response();
    }
    if !source_allowed(&state.lan, peer.ip()) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"success":false,"error":{"code":"SOURCE_NOT_ALLOWED","message":"Viewer is outside the configured private network."}}))).into_response();
    }
    state
        .connected_sse_clients
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let guard = SseClientGuard {
        clients: state.connected_sse_clients.clone(),
    };
    let rx = state.bus.sender.subscribe();
    let connection_id = uuid::Uuid::new_v4().to_string();
    let initial = Event::default().id(format!("{}:0", state.server_instance_id)).event("connection-status").retry(Duration::from_millis(2000)).data(serde_json::json!({"type":"connection-status","status":"connected","serverInstanceId":state.server_instance_id,"connectionId":connection_id,"occurredAt":Utc::now()}).to_string());
    let stream = BroadcastStream::new(rx).filter_map(|item| match item {
        Ok(value) => {
            let event_name = match &value {
                LanAttendanceEvent::AttendanceUpdated { .. } => "attendance-updated",
                LanAttendanceEvent::ConnectionStatus { .. } => "connection-status",
                LanAttendanceEvent::StaleData { .. } => "stale-data",
            };
            let event_id = match &value {
                LanAttendanceEvent::AttendanceUpdated { event_id, .. }
                | LanAttendanceEvent::ConnectionStatus { event_id, .. }
                | LanAttendanceEvent::StaleData { event_id, .. } => event_id.clone(),
            };
            Some(Ok::<Event, Infallible>(
                Event::default()
                    .id(event_id)
                    .retry(Duration::from_millis(2000))
                    .event(event_name)
                    .data(serde_json::to_string(&value).unwrap_or_default()),
            ))
        }
        Err(_) => Some(Ok(Event::default().event("stale-data").data(
            r#"{"type":"stale-data","reason":"event-gap","shouldRefetch":true}"#,
        ))),
    });
    let stream = tokio_stream::once(Ok(initial))
        .chain(stream)
        .map(move |item| {
            let _keep_guard_alive = &guard;
            item
        });
    Sse::new(stream)
        .keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(state.lan.sse_keep_alive_seconds.max(1)))
                .text("keep-alive"),
        )
        .into_response()
}

fn source_allowed(config: &LanConfig, address: std::net::IpAddr) -> bool {
    // The laptop itself always has access (loopback), even when an allowed
    // subnet list is configured, so local health checks and troubleshooting
    // work without weakening the subnet restriction for other devices.
    if address.is_loopback() {
        return true;
    }
    if config.allowed_subnets.is_empty() {
        return match address {
            std::net::IpAddr::V4(ip) => ip.is_private(),
            std::net::IpAddr::V6(_) => false,
        };
    }
    config
        .allowed_subnets
        .iter()
        .any(|subnet| subnet.contains(&address))
}

fn viewer_allowed(state: &AppState, headers: &HeaderMap, query_token: Option<&str>) -> bool {
    if !matches!(state.lan.auth_mode, crate::config::ViewerAuthMode::Password) {
        return true;
    }
    let Some(expected) = state.lan.viewer_password_hash.as_deref() else {
        return false;
    };
    let token = headers
        .get("x-viewer-token")
        .and_then(|v| v.to_str().ok())
        .or(query_token);
    let Some(token) = token else {
        return false;
    };
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(token.as_bytes())) == expected
}

async fn health(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<DateQuery>,
) -> impl IntoResponse {
    if !viewer_allowed(&state, &headers, query.token.as_deref()) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"success":false,"error":{"code":"VIEWER_AUTH_REQUIRED","message":"Viewer authentication is required."}}))).into_response();
    }
    if !source_allowed(&state.lan, peer.ip()) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"success":false,"error":{"code":"SOURCE_NOT_ALLOWED","message":"Viewer is outside the configured private network."}}))).into_response();
    }
    let active_lan_ip = crate::lan_net::pick_active_lan_ip().map(|ip| ip.to_string());
    let viewer_url = active_lan_ip
        .as_ref()
        .map(|ip| format!("http://{ip}:{}/attendance", state.lan.port));
    (
        StatusCode::OK,
        [(header::CACHE_CONTROL, "no-store")],
        Json(serde_json::json!({"success":true,"service":"alpha-premier-attendance-lan","status":"healthy","serverInstanceId":state.server_instance_id,"timestamp":Utc::now(),"timezone":"Asia/Manila","sqlite":"connected","lan":{"bindAddress":state.lan.bind_address.map(|v|v.to_string()).unwrap_or_default(),"port":state.lan.port,"viewerMode":"read-only","viewerSessionMinutes":state.lan.viewer_session_minutes,"connectedSseClients":state.connected_sse_clients.load(std::sync::atomic::Ordering::Relaxed),"uptimeSeconds":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs().saturating_sub(state.started_at),"viewerUrl":viewer_url,"lanIps":active_lan_ip},"googleSheetsExport":if state.lan.sheets_sync_endpoint.is_some() || state.lan.google_spreadsheet_id.is_some() { "offline" } else { "disabled" }})),
    ).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::LanConfig;
    use std::net::{IpAddr, Ipv4Addr};

    #[test]
    fn default_viewer_policy_allows_only_private_sources() {
        let config = LanConfig::default();
        assert!(source_allowed(
            &config,
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20))
        ));
        assert!(!source_allowed(
            &config,
            IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))
        ));
    }

    #[test]
    fn loopback_is_always_allowed_even_with_configured_subnets() {
        let config = LanConfig {
            allowed_subnets: vec!["192.168.1.0/24".parse().unwrap()],
            ..Default::default()
        };
        assert!(source_allowed(&config, IpAddr::V4(Ipv4Addr::LOCALHOST)));
        assert!(source_allowed(
            &config,
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 42))
        ));
        assert!(!source_allowed(
            &config,
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 9))
        ));
    }

    #[test]
    fn error_messages_are_plain_language_for_operator_guidance() {
        assert!(LanStartError::LoopbackBind
            .to_string()
            .contains("localhost"));
        assert!(LanStartError::BindAddressNotPresent
            .to_string()
            .contains("does not match an active network adapter"));
    }

    #[test]
    fn loopback_bind_is_rejected_for_the_shareable_viewer() {
        let config = LanConfig {
            bind_address: Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
            ..Default::default()
        };
        assert!(matches!(
            resolve_bind_address(&config),
            Err(LanStartError::LoopbackBind)
        ));
    }

    #[test]
    fn configured_private_bind_is_used_verbatim() {
        let config = LanConfig {
            bind_address: Some(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 25))),
            ..Default::default()
        };
        match resolve_bind_address(&config) {
            Ok(addr) => assert_eq!(addr.to_string(), "192.168.1.25:4173"),
            Err(other) => panic!("unexpected error: {other:?}"),
        }
    }

    #[tokio::test]
    async fn router_serves_snapshot_and_health_without_mutation_routes() {
        let data_dir =
            std::env::temp_dir().join(format!("alpha-lan-test-{}", uuid::Uuid::new_v4()));
        let state = AppState::new(
            data_dir.clone(),
            data_dir.join("attendance.db"),
            data_dir.join("exports"),
            false,
            LanConfig::default(),
            crate::config::OfficeConfig::default(),
            crate::config::ScannerConfig::default(),
        )
        .await
        .unwrap();
        sqlx::query("INSERT INTO attendance (attendance_id,attendance_date,user_id,rfid_uid,full_name,department,time_in,time_out,status,source,created_at,updated_at) VALUES ('a1','2026-08-01','u1','ABCD1234','Ada','Ops','2026-08-01T08:00:00+08:00',NULL,'WORKING','RFID','2026-08-01T08:00:00Z','2026-08-01T08:00:00Z')").execute(&state.db).await.unwrap();
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let app_router = router(state.clone());
        let task = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                app_router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });
        let snapshot = reqwest::get(format!(
            "http://{address}/api/attendance/today?date=2026-08-01"
        ))
        .await
        .unwrap();
        assert_eq!(snapshot.status(), StatusCode::OK);
        assert!(snapshot.text().await.unwrap().contains("Ada"));
        let mutation = reqwest::Client::new()
            .post(format!("http://{address}/api/attendance/today"))
            .send()
            .await
            .unwrap();
        assert_eq!(mutation.status(), StatusCode::METHOD_NOT_ALLOWED);
        let page = reqwest::get(format!("http://{address}/attendance"))
            .await
            .unwrap();
        assert_eq!(page.status(), StatusCode::OK);
        let page_text = page.text().await.unwrap();
        assert!(page_text.contains("Live Attendance"));
        assert!(page_text.contains("Read-only live attendance"));
        assert!(page_text.contains("EventSource"));
        assert!(
            !page_text.contains("admin"),
            "viewer page must not expose admin UI"
        );
        task.abort();
        state.db.close().await;
        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[tokio::test]
    async fn lan_status_reports_stopped_when_never_started() {
        let data_dir =
            std::env::temp_dir().join(format!("alpha-lan-status-{}", uuid::Uuid::new_v4()));
        let state = AppState::new(
            data_dir.clone(),
            data_dir.join("attendance.db"),
            data_dir.join("exports"),
            false,
            LanConfig::default(),
            crate::config::OfficeConfig::default(),
            crate::config::ScannerConfig::default(),
        )
        .await
        .unwrap();
        let status = build_lan_status(&state).await;
        assert_eq!(status.state, "stopped");
        assert_eq!(status.viewer_url, None);
        assert_eq!(status.port, 4173);
        assert!(status.success);
        state.db.close().await;
        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[tokio::test]
    async fn lan_status_is_disabled_when_runtime_start_is_forbidden() {
        let data_dir =
            std::env::temp_dir().join(format!("alpha-lan-disabled-{}", uuid::Uuid::new_v4()));
        let lan = LanConfig {
            enabled: false,
            allow_runtime_start: false,
            ..Default::default()
        };
        let state = AppState::new(
            data_dir.clone(),
            data_dir.join("attendance.db"),
            data_dir.join("exports"),
            false,
            lan,
            crate::config::OfficeConfig::default(),
            crate::config::ScannerConfig::default(),
        )
        .await
        .unwrap();
        let status = build_lan_status(&state).await;
        assert_eq!(status.state, "disabled");
        assert_eq!(status.allow_runtime_start, false);
        state.db.close().await;
        let _ = std::fs::remove_dir_all(data_dir);
    }
}
