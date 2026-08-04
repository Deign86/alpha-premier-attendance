use crate::{error::AppError, state::AppState};
use axum::{extract::{ConnectInfo, Query, State}, http::{header, HeaderMap, StatusCode}, response::{sse::{Event, KeepAlive, Sse}, Html, IntoResponse}, routing::get, Json, Router};
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

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/attendance", get(attendance_page))
        .route("/api/attendance/today", get(attendance_today))
        .route("/api/events/attendance", get(attendance_events))
        .route("/api/health", get(health))
        .with_state(state)
}

pub async fn start(state: AppState) -> Result<(), AppError> {
    if !state.lan.enabled { return Ok(()); }
    state.lan.validate().map_err(AppError::Configuration)?;
    let address = state.lan.bind_address.unwrap();
    let listener = tokio::net::TcpListener::bind(SocketAddr::new(address, state.lan.port)).await.map_err(|e| AppError::Lan(e.to_string()))?;
    axum::serve(listener, router(state).into_make_service_with_connect_info::<SocketAddr>()).await.map_err(|e| AppError::Lan(e.to_string()))
}

async fn attendance_page(State(state): State<AppState>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, Query(query): Query<DateQuery>) -> impl IntoResponse {
    if !source_allowed(&state.lan, peer.ip()) || !viewer_allowed(&state, &headers, query.token.as_deref()) { return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"success":false,"error":{"code":"VIEWER_AUTH_REQUIRED","message":"Viewer authentication is required."}}))).into_response(); }
    let office_line = format!("{} · {}", state.office.company_name, state.office.display_short());
    Html(r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Live Attendance</title><style>body{font-family:system-ui;margin:2rem;color:#1b1b1b}table{border-collapse:collapse;width:100%}th,td{padding:.6rem;border-bottom:1px solid #ddd;text-align:left}.status{font-weight:600}.state{margin-bottom:1rem}.office{color:#555;font-size:1rem;margin:0 0 1.5rem}</style></head><body><h1>Live Attendance</h1><p class="office">__OFFICE_LINE__</p><div id="state" class="state">Connecting...</div><table><thead><tr><th>Employee</th><th>Department</th><th>Time in</th><th>Time out</th><th>Status</th></tr></thead><tbody id="rows"></tbody></table><script>const state=document.querySelector('#state'),rows=document.querySelector('#rows');const token=new URLSearchParams(location.search).get('token');const auth=token?'&token='+encodeURIComponent(token):'';let date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila'}).format(new Date()),pollTimer=null;function render(data){rows.innerHTML=data.attendance.map(r=>`<tr><td>${escapeHtml(r.fullName)}</td><td>${escapeHtml(r.department||'')}</td><td>${r.timeIn||''}</td><td>${r.timeOut||''}</td><td class="status">${r.status}</td></tr>`).join('')}function escapeHtml(v){return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}async function refresh(){try{const r=await fetch('/api/attendance/today?date='+date+auth,{cache:'no-store'});if(!r.ok)throw Error();render(await r.json());state.textContent='Live dashboard available';}catch{state.textContent='Dashboard offline; retrying...'}}function startPolling(){if(!pollTimer)pollTimer=setInterval(refresh,5000)}function connect(){const es=new EventSource('/api/events/attendance?token='+encodeURIComponent(token||''));es.onopen=()=>{state.textContent='Live';if(pollTimer){clearInterval(pollTimer);pollTimer=null}refresh()};es.addEventListener('attendance-updated',refresh);es.addEventListener('stale-data',refresh);es.onerror=()=>{state.textContent='Reconnecting; polling fallback active';startPolling();setTimeout(connect,2000);es.close()}}refresh();connect();</script></body></html>"#
        .replace("__OFFICE_LINE__", &office_line))
        .into_response()
}

async fn attendance_today(State(state): State<AppState>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, Query(query): Query<DateQuery>) -> impl IntoResponse {
    if !viewer_allowed(&state, &headers, query.token.as_deref()) { return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"success":false,"error":{"code":"VIEWER_AUTH_REQUIRED","message":"Viewer authentication is required."}}))).into_response(); }
    if !source_allowed(&state.lan, peer.ip()) { return (StatusCode::FORBIDDEN, Json(serde_json::json!({"success":false,"error":{"code":"SOURCE_NOT_ALLOWED","message":"Viewer is outside the configured private network."}}))).into_response(); }
    let date = query.date.unwrap_or_else(|| Utc::now().with_timezone(&Manila).date_naive().to_string());
    if date.len() != 10 { return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success":false,"error":{"code":"INVALID_DATE","message":"date must be YYYY-MM-DD"}}))).into_response(); }
    let rows = sqlx::query("SELECT attendance_id, attendance_date, user_id, full_name, department, time_in, time_out, status FROM attendance WHERE attendance_date = ? ORDER BY time_in, full_name")
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

fn source_allowed(config: &crate::config::LanConfig, address: std::net::IpAddr) -> bool {
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
        task.abort();
        state.db.close().await;
        let _ = std::fs::remove_dir_all(data_dir);
    }
}

async fn health(State(state): State<AppState>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, Query(query): Query<DateQuery>) -> impl IntoResponse {
    if !viewer_allowed(&state, &headers, query.token.as_deref()) { return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"success":false,"error":{"code":"VIEWER_AUTH_REQUIRED","message":"Viewer authentication is required."}}))).into_response(); }
    if !source_allowed(&state.lan, peer.ip()) { return (StatusCode::FORBIDDEN, Json(serde_json::json!({"success":false,"error":{"code":"SOURCE_NOT_ALLOWED","message":"Viewer is outside the configured private network."}}))).into_response(); }
    (
        StatusCode::OK,
        [(header::CACHE_CONTROL, "no-store")],
        Json(serde_json::json!({"success":true,"service":"alpha-premier-attendance-lan","status":"healthy","serverInstanceId":state.server_instance_id,"timestamp":Utc::now(),"timezone":"Asia/Manila","sqlite":"connected","lan":{"bindAddress":state.lan.bind_address.map(|v|v.to_string()).unwrap_or_default(),"port":state.lan.port,"viewerMode":"read-only","viewerSessionMinutes":state.lan.viewer_session_minutes,"connectedSseClients":state.connected_sse_clients.load(std::sync::atomic::Ordering::Relaxed),"uptimeSeconds":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs().saturating_sub(state.started_at)},"googleSheetsExport":if state.lan.sheets_sync_endpoint.is_some() || state.lan.google_spreadsheet_id.is_some() { "offline" } else { "disabled" }})),
    ).into_response()
}
