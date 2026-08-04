use crate::{config::LanConfig, error::AppError, state::AppState};
use axum::{
    extract::{ConnectInfo, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{sse::{Event, KeepAlive, Sse}, Html, IntoResponse},
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
    AttendanceUpdated { event_id: String, server_instance_id: String, sequence: u64, occurred_at: DateTime<Utc>, request_id: String, attendance_date: String, attendance_id: String, cause: String, mutation: String, attendance: Option<LanAttendanceRow> },
    #[serde(rename = "connection-status")]
    ConnectionStatus { event_id: String, server_instance_id: String, sequence: u64, occurred_at: DateTime<Utc>, status: String, connection_id: String },
    #[serde(rename = "stale-data")]
    StaleData { event_id: String, server_instance_id: String, sequence: u64, occurred_at: DateTime<Utc>, reason: String, should_refetch: bool },
}

#[derive(Debug, Deserialize)]
pub struct DateQuery { pub date: Option<String>, pub token: Option<String> }

/// Why the LAN viewer cannot serve, mapped to the shared client contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LanIssue {
    #[default]
    None,
    ConfigInvalid,
    PortInUse,
    NoLanIp,
    BindFailed,
}

impl LanIssue {
    pub fn as_str(self) -> &'static str {
        match self {
            LanIssue::None => "none",
            LanIssue::ConfigInvalid => "config_invalid",
            LanIssue::PortInUse => "port_in_use",
            LanIssue::NoLanIp => "no_lan_ip",
            LanIssue::BindFailed => "bind_failed",
        }
    }
}

/// Structured failure from starting the LAN viewer, used to set the runtime
/// phase and the diagnostic issue shown by the Live Attendance panel.
#[derive(Debug, Clone)]
pub enum LanStartError {
    Config(String),
    NoLanIp,
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
            return Err(LanStartError::NoLanIp);
        }
        return Ok(SocketAddr::new(address, lan.port));
    }
    let ip = crate::lan_net::pick_active_lan_ip().ok_or(LanStartError::NoLanIp)?;
    Ok(SocketAddr::new(ip, lan.port))
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
            _ => LanStartError::Bind(error.to_string()),
        })?;
    let actual = listener
        .local_addr()
        .map_err(|error| LanStartError::Bind(error.to_string()))?;
    let task = tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, router(state).into_make_service_with_connect_info::<SocketAddr>())
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
        display_ip.as_ref().map(|ip| format!("http://{ip}:{}/attendance", state.lan.port))
    } else {
        None
    };

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
        network_scope: "Accessible to devices on the same office Wi-Fi / LAN (private network only)."
            .into(),
        network_profile: network_profile.as_str().into(),
        config_valid,
        config_error,
        issue,
        connected_sse_clients: state
            .connected_sse_clients
            .load(std::sync::atomic::Ordering::Relaxed),
        started_at: runtime.started_at,
        last_error: runtime.last_error,
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

async fn attendance_page(State(state): State<AppState>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, Query(query): Query<DateQuery>) -> impl IntoResponse {
    if !source_allowed(&state.lan, peer.ip()) || !viewer_allowed(&state, &headers, query.token.as_deref()) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"success":false,"error":{"code":"VIEWER_AUTH_REQUIRED","message":"Viewer authentication is required."}}))).into_response();
    }
    let company = html_escape(&state.office.company_name);
    let office_line = html_escape(&format!("{} · {}", state.office.company_name, state.office.display_short()));
    Html(r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Live Attendance</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Segoe UI", Arial, Helvetica, sans-serif; background: #f2f4f7; color: #16202b; }
  header { background: #10304f; color: #ffffff; padding: 16px 22px; display: flex; align-items: center; justify-content: space-between; gap: 18px; flex-wrap: wrap; }
  .brand h1 { margin: 0; font-size: 21px; letter-spacing: .4px; }
  .brand p { margin: 2px 0 0; opacity: .85; font-size: 13px; }
  .clock { text-align: right; }
  .clock .time { font-size: 27px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; }
  .clock .date { font-size: 13px; opacity: .85; }
  main { max-width: 980px; margin: 0 auto; padding: 20px 20px 48px; }
  .status-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; padding: 10px 14px; border-radius: 8px; background: #ffffff; border: 1px solid #d8dee6; font-size: 14px; }
  .dot { width: 11px; height: 11px; border-radius: 50%; display: inline-block; flex: 0 0 auto; }
  .dot.live { background: #1e9e50; box-shadow: 0 0 0 4px rgba(30, 158, 80, .16); }
  .dot.reconnecting { background: #d99a06; }
  .dot.offline { background: #d64545; }
  .status-bar .state { font-weight: 700; }
  .status-bar .last-update { margin-left: auto; color: #5a6572; font-size: 13px; }
  .list { display: grid; gap: 10px; }
  .card { display: flex; align-items: center; gap: 14px; background: #ffffff; border: 1px solid #d8dee6; border-left: 5px solid #8b97a5; border-radius: 8px; padding: 13px 16px; }
  .card.in { border-left-color: #1e9e50; }
  .card.out { border-left-color: #2f6fd6; }
  .card .who { min-width: 0; }
  .card .who .name { font-size: 19px; font-weight: 700; }
  .card .who .id { font-size: 13px; color: #5a6572; }
  .card .badge { margin-left: auto; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; padding: 6px 13px; border-radius: 999px; white-space: nowrap; }
  .card.in .badge { background: #e2f5e9; color: #12612f; }
  .card.out .badge { background: #e4ecfb; color: #1d4fae; }
  .card .when { text-align: right; font-size: 15px; font-variant-numeric: tabular-nums; }
  .card .when small { display: block; color: #5a6572; font-size: 12px; }
  .empty { text-align: center; color: #5a6572; padding: 56px 20px; background: #ffffff; border: 1px dashed #c2cad4; border-radius: 8px; font-size: 16px; }
  footer { text-align: center; color: #7c8794; font-size: 12px; padding: 0 0 26px; }
  @media (max-width: 620px) {
    header { flex-direction: column; align-items: flex-start; }
    .clock { text-align: left; }
    .card { flex-wrap: wrap; }
    .card .badge { margin-left: 0; }
  }
</style>
</head>
<body>
<header>
  <div class="brand"><h1>__COMPANY__</h1><p>Live Attendance · __OFFICE_LINE__</p></div>
  <div class="clock"><div class="time" id="clock">--:--:--</div><div class="date" id="clockDate">—</div></div>
</header>
<main>
  <div class="status-bar"><span class="dot" id="dot"></span><span class="state" id="state">Connecting…</span><span class="last-update" id="lastUpdate">Waiting for data</span></div>
  <div id="list" class="list"></div>
  <div id="empty" class="empty" hidden>No time-ins or time-outs recorded yet today.</div>
</main>
<footer>Read-only live attendance · Refresh or open this page again if it ever stops updating.</footer>
<script>
const tz = 'Asia/Manila';
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

function tick() {
  const now = new Date();
  document.getElementById('clock').textContent = now.toLocaleTimeString('en-PH', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  document.getElementById('clockDate').textContent = now.toLocaleDateString('en-PH', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}
function today() { return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date()); }
function escapeHtml(v) { return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function setStatus(label, cls) { stateEl.textContent = label; dotEl.className = 'dot ' + cls; }
function latestTime(row) { return row.timeOut || row.timeIn || ''; }
function card(row) {
  const isOut = Boolean(row.timeOut);
  const time = isOut ? row.timeOut : row.timeIn;
  const when = time ? new Date(time).toLocaleString('en-PH', { timeZone: tz, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';
  const dept = row.department ? ' · ' + escapeHtml(row.department) : '';
  return '<div class="card ' + (isOut ? 'out' : 'in') + '">' +
    '<div class="who"><div class="name">' + escapeHtml(row.fullName) + '</div><div class="id">' + escapeHtml(row.userId || '') + dept + '</div></div>' +
    '<div class="badge">' + (isOut ? 'Time Out' : 'Time In') + '</div>' +
    '<div class="when">' + escapeHtml(when) + '<small>' + escapeHtml(row.attendanceDate || '') + '</small></div>' +
    '</div>';
}
function render(rows) {
  const sorted = rows.slice().sort((a, b) => latestTime(b).localeCompare(latestTime(a)));
  listEl.innerHTML = sorted.map(card).join('');
  emptyEl.hidden = sorted.length > 0;
}
async function refresh() {
  try {
    const r = await fetch('/api/attendance/today?date=' + today() + auth, { cache: 'no-store' });
    if (!r.ok) throw new Error('bad status ' + r.status);
    const data = await r.json();
    render(data.attendance || []);
    everLoaded = true;
    const now = new Date();
    lastEl.textContent = 'Updated ' + now.toLocaleTimeString('en-PH', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    if (stateEl.dataset.conn !== 'live') setStatus('Live — polling fallback', 'live');
  } catch (err) {
    if (!everLoaded) setStatus('Offline — cannot reach the viewer service', 'offline');
  }
}
function startPolling() { if (!pollTimer) pollTimer = setInterval(refresh, 4000); }
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
function connect() {
  if (es) { es.close(); es = null; }
  let opened = false;
  try { es = new EventSource('/api/events/attendance' + esAuth); } catch (err) { startPolling(); return; }
  es.onopen = () => { opened = true; stateEl.dataset.conn = 'live'; setStatus('Live — streaming', 'live'); stopPolling(); refresh(); };
  es.addEventListener('attendance-updated', () => refresh());
  es.addEventListener('stale-data', () => refresh());
  es.onerror = () => {
    if (es) { es.close(); es = null; }
    stateEl.dataset.conn = 'reconnect';
    setStatus('Reconnecting…', 'reconnecting');
    startPolling();
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
    setTimeout(connect, reconnectDelay);
  };
}
tick();
setInterval(tick, 1000);
refresh();
connect();
setTimeout(() => { if (!everLoaded) setStatus('Offline — no connection received', 'offline'); }, 8000);
</script>
</body>
</html>"#
        .replace("__COMPANY__", &company)
        .replace("__OFFICE_LINE__", &office_line))
        .into_response()
}

async fn attendance_today(State(state): State<AppState>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, Query(query): Query<DateQuery>) -> impl IntoResponse {
    if !viewer_allowed(&state, &headers, query.token.as_deref()) { return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"success":false,"error":{"code":"VIEWER_AUTH_REQUIRED","message":"Viewer authentication is required."}}))).into_response(); }
    if !source_allowed(&state.lan, peer.ip()) { return (StatusCode::FORBIDDEN, Json(serde_json::json!({"success":false,"error":{"code":"SOURCE_NOT_ALLOWED","message":"Viewer is outside the configured private network."}}))).into_response(); }
    let date = query.date.unwrap_or_else(|| Utc::now().with_timezone(&Manila).date_naive().to_string());
    if date.len() != 10 { return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success":false,"error":{"code":"INVALID_DATE","message":"date must be YYYY-MM-DD"}}))).into_response(); }
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
struct SseClientGuard { clients: std::sync::Arc<std::sync::atomic::AtomicU64> }
impl Drop for SseClientGuard { fn drop(&mut self) { self.clients.fetch_sub(1, std::sync::atomic::Ordering::Relaxed); } }

async fn attendance_events(State(state): State<AppState>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, Query(query): Query<DateQuery>) -> impl IntoResponse {
    if !viewer_allowed(&state, &headers, query.token.as_deref()) { return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"success":false,"error":{"code":"VIEWER_AUTH_REQUIRED","message":"Viewer authentication is required."}}))).into_response(); }
    if !source_allowed(&state.lan, peer.ip()) { return (StatusCode::FORBIDDEN, Json(serde_json::json!({"success":false,"error":{"code":"SOURCE_NOT_ALLOWED","message":"Viewer is outside the configured private network."}}))).into_response(); }
    state.connected_sse_clients.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let guard = SseClientGuard { clients: state.connected_sse_clients.clone() };
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
            let event_id = match &value { LanAttendanceEvent::AttendanceUpdated { event_id, .. } | LanAttendanceEvent::ConnectionStatus { event_id, .. } | LanAttendanceEvent::StaleData { event_id, .. } => event_id.clone() };
            Some(Ok::<Event, Infallible>(Event::default().id(event_id)
                .retry(Duration::from_millis(2000)).event(event_name)
                .data(serde_json::to_string(&value).unwrap_or_default())))
        }
        Err(_) => Some(Ok(Event::default().event("stale-data").data(
            r#"{"type":"stale-data","reason":"event-gap","shouldRefetch":true}"#,
        ))),
    });
    let stream = tokio_stream::once(Ok(initial)).chain(stream).map(move |item| { let _keep_guard_alive = &guard; item });
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(state.lan.sse_keep_alive_seconds.max(1))).text("keep-alive")).into_response()
}

fn source_allowed(config: &LanConfig, address: std::net::IpAddr) -> bool {
    if config.allowed_subnets.is_empty() { return match address { std::net::IpAddr::V4(ip) => ip.is_private() || ip.is_loopback(), std::net::IpAddr::V6(ip) => ip.is_loopback(), }; }
    config.allowed_subnets.iter().any(|subnet| subnet.contains(&address))
}

fn viewer_allowed(state: &AppState, headers: &HeaderMap, query_token: Option<&str>) -> bool {
    if !matches!(state.lan.auth_mode, crate::config::ViewerAuthMode::Password) { return true; }
    let Some(expected) = state.lan.viewer_password_hash.as_deref() else { return false; };
    let token = headers.get("x-viewer-token").and_then(|v| v.to_str().ok()).or(query_token);
    let Some(token) = token else { return false; };
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(token.as_bytes())) == expected
}

async fn health(State(state): State<AppState>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, Query(query): Query<DateQuery>) -> impl IntoResponse {
    if !viewer_allowed(&state, &headers, query.token.as_deref()) { return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"success":false,"error":{"code":"VIEWER_AUTH_REQUIRED","message":"Viewer authentication is required."}}))).into_response(); }
    if !source_allowed(&state.lan, peer.ip()) { return (StatusCode::FORBIDDEN, Json(serde_json::json!({"success":false,"error":{"code":"SOURCE_NOT_ALLOWED","message":"Viewer is outside the configured private network."}}))).into_response(); }
    let active_lan_ip = crate::lan_net::pick_active_lan_ip().map(|ip| ip.to_string());
    let viewer_url = active_lan_ip.as_ref().map(|ip| format!("http://{ip}:{}/attendance", state.lan.port));
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
        assert!(source_allowed(&config, IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20))));
        assert!(!source_allowed(&config, IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
    }

    #[test]
    fn loopback_bind_is_rejected_for_the_shareable_viewer() {
        let config = LanConfig { bind_address: Some(IpAddr::V4(Ipv4Addr::LOCALHOST)), ..Default::default() };
        assert!(matches!(resolve_bind_address(&config), Err(LanStartError::NoLanIp)));
    }

    #[test]
    fn configured_private_bind_is_used_verbatim() {
        let config = LanConfig { bind_address: Some(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 25))), ..Default::default() };
        match resolve_bind_address(&config) {
            Ok(addr) => assert_eq!(addr.to_string(), "192.168.1.25:4173"),
            Err(other) => panic!("unexpected error: {other:?}"),
        }
    }

    #[tokio::test]
    async fn router_serves_snapshot_and_health_without_mutation_routes() {
        let data_dir = std::env::temp_dir().join(format!("alpha-lan-test-{}", uuid::Uuid::new_v4()));
        let state = AppState::new(data_dir.clone(), data_dir.join("exports"), false, LanConfig::default(), crate::config::OfficeConfig::default()).await.unwrap();
        sqlx::query("INSERT INTO attendance (attendance_id,attendance_date,user_id,rfid_uid,full_name,department,time_in,time_out,status,source,created_at,updated_at) VALUES ('a1','2026-08-01','u1','ABCD1234','Ada','Ops','2026-08-01T08:00:00+08:00',NULL,'OPEN','RFID','2026-08-01T08:00:00Z','2026-08-01T08:00:00Z')").execute(&state.db).await.unwrap();
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let app_router = router(state.clone());
        let task = tokio::spawn(async move { let _ = axum::serve(listener, app_router.into_make_service_with_connect_info::<SocketAddr>()).await; });
        let snapshot = reqwest::get(format!("http://{address}/api/attendance/today?date=2026-08-01")).await.unwrap();
        assert_eq!(snapshot.status(), StatusCode::OK);
        assert!(snapshot.text().await.unwrap().contains("Ada"));
        let mutation = reqwest::Client::new().post(format!("http://{address}/api/attendance/today")).send().await.unwrap();
        assert_eq!(mutation.status(), StatusCode::METHOD_NOT_ALLOWED);
        let page = reqwest::get(format!("http://{address}/attendance")).await.unwrap();
        assert_eq!(page.status(), StatusCode::OK);
        let page_text = page.text().await.unwrap();
        assert!(page_text.contains("Live Attendance"));
        assert!(page_text.contains("Read-only live attendance"));
        assert!(page_text.contains("EventSource"));
        assert!(!page_text.contains("admin"), "viewer page must not expose admin UI");
        task.abort();
        state.db.close().await;
        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[tokio::test]
    async fn lan_status_reports_stopped_when_never_started() {
        let data_dir = std::env::temp_dir().join(format!("alpha-lan-status-{}", uuid::Uuid::new_v4()));
        let state = AppState::new(data_dir.clone(), data_dir.join("exports"), false, LanConfig::default(), crate::config::OfficeConfig::default()).await.unwrap();
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
        let data_dir = std::env::temp_dir().join(format!("alpha-lan-disabled-{}", uuid::Uuid::new_v4()));
        let lan = LanConfig { enabled: false, allow_runtime_start: false, ..Default::default() };
        let state = AppState::new(data_dir.clone(), data_dir.join("exports"), false, lan, crate::config::OfficeConfig::default()).await.unwrap();
        let status = build_lan_status(&state).await;
        assert_eq!(status.state, "disabled");
        assert_eq!(status.allow_runtime_start, false);
        state.db.close().await;
        let _ = std::fs::remove_dir_all(data_dir);
    }
}
