//! Auto-push of kiosk time-in/out rows to the human `INTERN DTR 2026`
//! spreadsheet (one tab per intern, monthly blocks).
//!
//! Design notes (mirrors `server/src/intern-dtr-sync.ts`, validated live):
//! - Tab resolution is order-free subset matching with fail-closed
//!   ambiguity handling; `COPY OF TEMPLATE` is always skipped.
//! - Only `B:E` data cells are ever written (`USER_ENTERED`); column `F`
//!   (`TOTAL HOURS`) and the `H:J` counters are formula territory.
//! - Writes are idempotent: identical `B:E` cells are skipped (all four
//!   cells are compared, so a WORKING → half-day timeout rewrites `D`).
//! - DTR display half-day: time-out before 16:59 Manila renders
//!   morning-only `[in, 12PM, '', '']`; system payroll is untouched.
//! - Interns with no tab yet are tracked in `dtr_pending`; the next
//!   interaction (or 30s loop) re-searches titles and backfills the full
//!   history once the owner creates the tab.
//! - Queue rows use `table_name = "InternDtr"` and are dispatched from
//!   `sheets_sync::run_once`, which owns claim/retry/backoff. This module
//!   never touches the ops spreadsheet tabs.
//!
//! Accepted limitations (deliberate, not gaps):
//! - Only ACTIVE INTERN scan targets are ever enqueued (gated at the
//!   scan site in `lib.rs`; ADMIN_ASSIST card holders can never be DTR
//!   targets, and INACTIVE users produce no scan events). Name matching
//!   itself only sees the active roster.
//! - Tab titles are fetched live on every push (no cache): kiosk event
//!   volume is trivial against Sheets quota (300 writes/min), and fresh
//!   titles are exactly what the rename/create-tab flows need. The
//!   pending recheck shares one fetch per run.
//! - A tab renamed or deleted between the title fetch and the write
//!   surfaces as a transport error and rides the standard queue
//!   retry/backoff (then DEAD with the error preserved) — the Sheets
//!   API offers no transactions, and neither do plan+execute.
//! - Duplicate attendance rows for one user+date cannot exist
//!   (`ux_attendance_user_date`) and queue rows are idempotent
//!   (`InternDtr:{attendance_id}:UPSERT`), so two kiosks racing the
//!   same tap converge instead of duplicating.

use crate::services::sheets_sync::{
    GOOGLE_AUTH_FAILED, GOOGLE_NOT_FOUND, GOOGLE_PERMISSION_DENIED, GOOGLE_RATE_LIMITED,
    GOOGLE_REQUEST_FAILED,
};
use crate::state::AppState;
use chrono::{Datelike, NaiveDate, Timelike, Weekday};
use chrono_tz::Asia::Manila;

pub const DTR_TABLE_NAME: &str = "InternDtr";
pub const DTR_LUNCH_OUT: &str = "12:00:00 PM";
pub const DTR_LUNCH_IN: &str = "1:00:00 PM";

/// DTR data-cell paint (B:E only — F TOTAL and H:J counters are formula
/// territory and never enter a format range).
/// Measured 2026-09-05 from the live INTERN DTR 2026 sheet via
/// spreadsheets.get on `LAZARO DEIGN ` D103:E103
/// (userEnteredFormat.backgroundColor of the owner-painted half-day
/// cells): pure red. White clears stale paint.
const DTR_RED: (f64, f64, f64) = (1.0, 0.0, 0.0);
const DTR_WHITE: (f64, f64, f64) = (1.0, 1.0, 1.0);

const TEMPLATE_TITLES: [&str; 2] = ["copy of template", "template"];

/// Trailing generational suffixes are not name content: without this,
/// `Juan Dela Cruz Jr` would end in `jr` and no `LAST FIRST` tab could
/// ever satisfy the last-token rule. Stripped for last-token and
/// coverage checks (both sides of collision checks); single-token
/// containment still uses the full token list.

/// Fold common Latin diacritics to ASCII before filtering, so roster
/// `Peña` still matches tab `PENA` (both normalize to `pena`).
/// No unicode-folding crate is used (no new deps); characters outside
/// this table that are not ASCII alphanumeric are dropped on both
/// sides, which keeps matching consistent but means e.g. `Nguyễn`
/// (→`nguyn`) only matches a tab spelled the same folded way — an
/// accepted limitation, documented here rather than silent.
fn fold_diacritic(c: char) -> char {
    match c {
        'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' | 'ā' | 'ă' | 'ą' => 'a',
        'é' | 'è' | 'ê' | 'ë' | 'ē' | 'ę' => 'e',
        'í' | 'ì' | 'î' | 'ï' | 'ī' => 'i',
        'ó' | 'ò' | 'ô' | 'ö' | 'õ' | 'ō' => 'o',
        'ú' | 'ù' | 'û' | 'ü' | 'ū' => 'u',
        'ñ' | 'ń' => 'n',
        'ç' | 'ć' | 'č' => 'c',
        'ý' | 'ÿ' => 'y',
        'ß' => 's',
        'ø' => 'o',
        'æ' => 'a',
        'œ' => 'o',
        'ð' => 'd',
        'þ' => 't',
        'ł' => 'l',
        'š' => 's',
        'ž' => 'z',
        other => other,
    }
}

fn normalize_token(token: &str) -> String {
    token
        .trim()
        .to_lowercase()
        .chars()
        .map(fold_diacritic)
        .filter(|c| c.is_ascii_alphanumeric())
        .collect()
}

fn split_tokens(name: &str) -> Vec<String> {
    name.split_whitespace()
        .map(normalize_token)
        .filter(|t| !t.is_empty())
        .collect()
}

fn is_skippable_title(title: &str) -> bool {
    let toks = split_tokens(title);
    if toks.is_empty() {
        return true;
    }
    TEMPLATE_TITLES.contains(&toks.join(" ").as_str())
}

const NAME_SUFFIXES: [&str; 6] = ["jr", "sr", "ii", "iii", "iv", "v"];

fn strip_name_suffix(toks: &[String]) -> &[String] {
    let mut end = toks.len();
    while end > 0 && NAME_SUFFIXES.contains(&toks[end - 1].as_str()) {
        end -= 1;
    }
    &toks[..end]
}

fn tab_covered_by_user(tab_toks: &[String], user_toks: &[String]) -> bool {
    !tab_toks.is_empty() && tab_toks.iter().all(|t| user_toks.contains(t))
}

/// Resolve the DTR tab for one roster user. Returns the tab title on a
/// unique match, `None` on AMBIGUOUS / NO_MATCH / SKIP (caller skips).
pub fn resolve_user_tab(
    tab_titles: &[String],
    user_id: &str,
    full_name: &str,
    all_users: &[(String, String)],
) -> Option<String> {
    let user_toks = split_tokens(full_name);
    // Suffix-stripped core drives last-token and coverage; a name that
    // is nothing but suffixes cannot resolve.
    let core_toks: Vec<String> = strip_name_suffix(&user_toks).to_vec();
    let last = core_toks.last()?.clone();
    let mut candidates: Vec<String> = Vec::new();
    for title in tab_titles {
        if is_skippable_title(title) {
            continue;
        }
        let tab_toks = split_tokens(title);
        if tab_toks.len() == 1 {
            if !user_toks.contains(&tab_toks[0]) {
                continue;
            }
            let collides = all_users.iter().any(|(id, name)| {
                id != user_id && split_tokens(name).contains(&tab_toks[0])
            });
            if collides {
                return None;
            }
            candidates.push(title.clone());
            continue;
        }
        if !tab_toks.contains(&last) {
            continue;
        }
        if !tab_covered_by_user(&tab_toks, &core_toks) {
            continue;
        }
        let collides = all_users.iter().any(|(id, name)| {
            if id == user_id {
                return false;
            }
            let other_toks = split_tokens(name);
            tab_covered_by_user(&tab_toks, strip_name_suffix(&other_toks))
        });
        if collides {
            return None;
        }
        candidates.push(title.clone());
    }
    if candidates.len() == 1 {
        candidates.into_iter().next()
    } else {
        None
    }
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) struct DateParts {
    y: i32,
    m: u32,
    d: u32,
}

fn to_parts(y: i32, m: u32, d: u32) -> Option<DateParts> {
    // Range check only, not calendar validity (`2/30/2026` parses):
    // `attendance_date` comes from validated DB rows, sheet-side
    // comparisons are equality-based, and the absent sweep re-validates
    // with `NaiveDate::from_ymd_opt`, so an impossible cell can never
    // match or paint.
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(DateParts { y, m, d })
}

/// Parse a sheet date cell (`M/D/YYYY`, `MM/DD/YYYY`, `YYYY-MM-DD`).
pub fn parse_sheet_date(cell: &str) -> Option<DateParts> {
    let text = cell.trim();
    let slash: Vec<&str> = text.split('/').collect();
    if slash.len() == 3 {
        if let (Ok(m), Ok(d), Ok(y)) = (
            slash[0].parse::<u32>(),
            slash[1].parse::<u32>(),
            slash[2].parse::<i32>(),
        ) {
            if slash[2].len() == 4 {
                return to_parts(y, m, d);
            }
        }
        return None;
    }
    let dash: Vec<&str> = text.split('-').collect();
    if dash.len() == 3 && dash[0].len() == 4 {
        if let (Ok(y), Ok(m), Ok(d)) = (
            dash[0].parse::<i32>(),
            dash[1].parse::<u32>(),
            dash[2].parse::<u32>(),
        ) {
            return to_parts(y, m, d);
        }
    }
    None
}

/// Parse a month-block header (`JUNE`, `DATE-September`) into 1-12.
pub fn parse_month_header(cell: &str) -> Option<u32> {
    let text = cell.trim();
    let stripped = text
        .strip_prefix("DATE-")
        .or_else(|| text.strip_prefix("date-"))
        .or_else(|| text.strip_prefix("Date-"))
        .unwrap_or(text);
    let lower = stripped.trim().to_lowercase();
    const FULL: [&str; 12] = [
        "january", "february", "march", "april", "may", "june", "july", "august", "september",
        "october", "november", "december",
    ];
    if let Some(i) = FULL.iter().position(|m| *m == lower) {
        return Some(i as u32 + 1);
    }
    Some(match lower.as_str() {
        "jan" => 1,
        "feb" => 2,
        "mar" => 3,
        "apr" => 4,
        "may" => 5,
        "jun" => 6,
        "jul" => 7,
        "aug" => 8,
        "sep" | "sept" => 9,
        "oct" => 10,
        "nov" => 11,
        "dec" => 12,
        _ => return None,
    })
}

/// 0-based `[start, end)` search bounds for one month block: rows strictly
/// between this month's header and the next month header (or sheet end).
/// Returns `None` when the tab carries month headers but none matches
/// `month`. The caller falls back to the whole tab only when the tab has
/// no month headers at all (checked separately).
pub fn month_block_range(rows: &[Vec<String>], month: u32) -> Option<(usize, usize)> {
    let mut saw_header = false;
    let mut block_start: Option<usize> = None;
    for (i, row) in rows.iter().enumerate() {
        let cell = row.first().map(String::as_str).unwrap_or("");
        if parse_month_header(cell).is_none() {
            continue;
        }
        saw_header = true;
        if block_start.is_some() {
            return block_start.map(|s| (s, i));
        }
        if parse_month_header(cell) == Some(month) {
            block_start = Some(i + 1);
        }
    }
    if !saw_header {
        return None;
    }
    block_start.map(|s| (s, rows.len()))
}

/// Find the 0-based row index of `ymd` (`YYYY-MM-DD`) in column A within
/// `rows[start, end)`. Returns `None` when absent; `Err` on duplicates.
pub fn find_date_row_in(
    rows: &[Vec<String>],
    ymd: &str,
    start: usize,
    end: usize,
) -> Result<Option<usize>, String> {
    let want = parse_ymd(ymd)?;
    let mut found: Option<usize> = None;
    for i in start..end.min(rows.len()) {
        let cell = rows[i].first().map(String::as_str).unwrap_or("");
        let Some(parts) = parse_sheet_date(cell) else {
            continue;
        };
        if parts == want {
            if found.is_some() {
                return Err(format!(
                    "duplicate date rows for {ymd} at rows {} and {}",
                    found.map(|f| f + 1).unwrap_or(0),
                    i + 1
                ));
            }
            found = Some(i);
        }
    }
    Ok(found)
}

fn parse_ymd(ymd: &str) -> Result<DateParts, String> {
    let text = ymd.trim();
    let dash: Vec<&str> = text.split('-').collect();
    if dash.len() == 3 && dash[0].len() == 4 {
        if let (Ok(y), Ok(m), Ok(d)) = (
            dash[0].parse::<i32>(),
            dash[1].parse::<u32>(),
            dash[2].parse::<u32>(),
        ) {
            if let Some(p) = to_parts(y, m, d) {
                return Ok(p);
            }
        }
    }
    Err(format!("attendanceDate must be YYYY-MM-DD, got {ymd}"))
}

/// ISO-8601 timestamp with offset → sheet `h:mm:ss AM/PM` (`9:46:23 AM`).
/// Always rendered in Manila wall time: stamps may carry any offset
/// (admin backdates, UTC test fixtures), so convert before formatting.
pub fn format_sheet_time(iso: &str) -> Result<String, String> {
    let dt = chrono::DateTime::parse_from_rfc3339(iso.trim())
        .map_err(|_| format!("invalid timestamp: {iso}"))?;
    let local = dt.with_timezone(&Manila);
    Ok(local.format("%-I:%M:%S %p").to_string().to_uppercase())
}

/// Half-day cutoff (Manila wall clock): a time-out strictly before
/// 16:59:00 renders the DTR row morning-only. DTR display rule only —
/// system payroll keeps its own half-day logic.
const HALF_DAY_CUTOFF_HOUR: u32 = 16;
const HALF_DAY_CUTOFF_MINUTE: u32 = 59;

fn is_half_day_timeout(time_out: &str) -> Result<bool, String> {
    let dt = chrono::DateTime::parse_from_rfc3339(time_out.trim())
        .map_err(|_| format!("invalid timestamp: {time_out}"))?;
    // P1: classify on Manila wall time, not the stamp's raw offset.
    let t = dt.with_timezone(&Manila).time();
    Ok(
        t.hour() < HALF_DAY_CUTOFF_HOUR
            || (t.hour() == HALF_DAY_CUTOFF_HOUR && t.minute() < HALF_DAY_CUTOFF_MINUTE),
    )
}

/// Build `[B, C, D, E]` (DTR display rule, not payroll):
/// - time-in is always written as-is once present;
/// - still WORKING (no time-out): `[in, 12PM, 1PM, '']` intraday;
/// - timed out before 16:59 Manila: morning-only `[in, 12PM, '', '']` —
///   the actual tap-out time is discarded, `C` is always 12:00 PM;
/// - timed out at/after 16:59: full `[in, 12PM, 1PM, out]`.
/// - a time-out earlier than the time-in is rejected (mirrors the P4
///   inverted-log rule in payroll): overnight shifts are outside the
///   kiosk same-day model, so failing closed beats rendering nonsense.
/// - records without a time-out (WORKING, MISSED, LATE_TIMEOUT) render
///   like WORKING; the DTR assumes nothing about payroll for them.
pub fn build_dtr_row(
    time_in: Option<&str>,
    time_out: Option<&str>,
    _attendance_date: &str,
) -> Result<[String; 4], String> {
    let Some(tin) = time_in.filter(|s| !s.trim().is_empty()) else {
        return Ok([String::new(), String::new(), String::new(), String::new()]);
    };
    let started = format_sheet_time(tin)?;
    let Some(tout_raw) = time_out.filter(|s| !s.trim().is_empty()) else {
        return Ok([
            started,
            DTR_LUNCH_OUT.to_string(),
            DTR_LUNCH_IN.to_string(),
            String::new(),
        ]);
    };
    let tin_dt = chrono::DateTime::parse_from_rfc3339(tin.trim())
        .map_err(|_| format!("invalid timestamp: {tin}"))?;
    let tout_dt = chrono::DateTime::parse_from_rfc3339(tout_raw.trim())
        .map_err(|_| format!("invalid timestamp: {tout_raw}"))?;
    if tout_dt < tin_dt {
        return Err(format!("Time-out cannot be earlier than time-in: {tout_raw} < {tin}"));
    }
    if is_half_day_timeout(tout_raw)? {
        return Ok([
            started,
            DTR_LUNCH_OUT.to_string(),
            String::new(),
            String::new(),
        ]);
    }
    Ok([
        started,
        DTR_LUNCH_OUT.to_string(),
        DTR_LUNCH_IN.to_string(),
        format_sheet_time(tout_raw)?,
    ])
}

/// Display kind of one DTR row (DTR rules, not payroll). `Absent` is
/// only produced by the sweep over sheet rows, never by record planning
/// (a record-less push is `Unresolvable("empty-values")` upstream).
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum DtrRowKind {
    Absent,
    HalfDay,
    FullDay,
    Working,
}

/// Classify one attendance record for paint purposes. Half-day uses the
/// same Manila wall-clock cutoff as `build_dtr_row`.
pub fn classify_record_row(
    time_in: Option<&str>,
    time_out: Option<&str>,
) -> Result<DtrRowKind, String> {
    let has_in = time_in.map(|s| !s.trim().is_empty()).unwrap_or(false);
    if !has_in {
        return Ok(DtrRowKind::Absent);
    }
    let has_out = time_out.map(|s| !s.trim().is_empty()).unwrap_or(false);
    if !has_out {
        return Ok(DtrRowKind::Working);
    }
    // SAFETY: has_out guard above ensures Some (possibly blank-checked).
    let out = time_out.unwrap_or("");
    if is_half_day_timeout(out)? {
        Ok(DtrRowKind::HalfDay)
    } else {
        Ok(DtrRowKind::FullDay)
    }
}

fn dtr_rgb(color: DtrCellColor) -> (f64, f64, f64) {
    match color {
        DtrCellColor::Red => DTR_RED,
        DtrCellColor::White => DTR_WHITE,
    }
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum DtrCellColor {
    Red,
    White,
}

/// One paint rectangle: rows `[start_row_1based, end_row_1based_excl)`,
/// columns `[start_col_0, end_col_0_excl)` (B:E = cols 1..5).
#[derive(Debug, PartialEq, Eq)]
pub struct DtrFormatOp {
    pub sheet_id: i64,
    pub start_row_1based: usize,
    pub end_row_1based_excl: usize,
    pub start_col_0: usize,
    pub end_col_0_excl: usize,
    pub color: DtrCellColor,
}

/// Format ops for one pushed row: absent paints B:E red; half-day keeps
/// B:C white and paints the empty remainder D:E red; full-day whites
/// B:E (clears stale red, e.g. absent → backdated entry); WORKING
/// whites B:D (cells holding values) and leaves E untouched.
pub fn plan_row_format(
    sheet_id: i64,
    row_1based: usize,
    kind: DtrRowKind,
) -> Vec<DtrFormatOp> {
    let one = |s: usize, e: usize, color: DtrCellColor| DtrFormatOp {
        sheet_id,
        start_row_1based: row_1based,
        end_row_1based_excl: row_1based + 1,
        start_col_0: s,
        end_col_0_excl: e,
        color,
    };
    match kind {
        DtrRowKind::Absent => vec![one(1, 5, DtrCellColor::Red)],
        DtrRowKind::HalfDay => vec![
            one(1, 3, DtrCellColor::White),
            one(3, 5, DtrCellColor::Red),
        ],
        DtrRowKind::FullDay => vec![one(1, 5, DtrCellColor::White)],
        DtrRowKind::Working => vec![one(1, 4, DtrCellColor::White)],
    }
}

/// Manila calendar day (`YYYY-MM-DD`) for absent comparisons. Derived
/// from the machine clock: kiosk clock skew shifts the boundary, which
/// is an accepted deployment concern (same clock drives the stamps).
pub fn manila_today_ymd() -> String {
    chrono::Utc::now()
        .with_timezone(&Manila)
        .format("%Y-%m-%d")
        .to_string()
}

/// Absent sweep over already-fetched A:F: every date row strictly
/// before `today_ymd` (Manila) that falls Mon–Fri and has empty B:E
/// gets one red op; consecutive rows merge into a single range.
/// Weekends (owner greens them), today/future, and non-date rows are
/// never touched. F/J formula columns are never in a range.
/// A Mon–Fri public holiday with no record paints red like an absence;
/// the owner clears it — the kiosk cannot distinguish holidays.
pub fn plan_absent_sweep(
    sheet_id: i64,
    rows: &[Vec<String>],
    today_ymd: &str,
) -> Vec<DtrFormatOp> {
    let Ok(today_parts) = parse_ymd(today_ymd) else {
        return Vec::new();
    };
    let Some(today) =
        NaiveDate::from_ymd_opt(today_parts.y, today_parts.m, today_parts.d)
    else {
        return Vec::new();
    };
    let mut runs: Vec<(usize, usize)> = Vec::new();
    for (i, row) in rows.iter().enumerate() {
        let cell = row.first().map(String::as_str).unwrap_or("");
        let Some(parts) = parse_sheet_date(cell) else {
            continue;
        };
        let Some(date) = NaiveDate::from_ymd_opt(parts.y, parts.m, parts.d) else {
            continue;
        };
        if date >= today {
            continue;
        }
        if matches!(date.weekday(), Weekday::Sat | Weekday::Sun) {
            continue;
        }
        let empty = (1..=4)
            .all(|c| row.get(c).map(|s| s.trim().is_empty()).unwrap_or(true));
        if !empty {
            continue;
        }
        match runs.last_mut() {
            Some((_, end)) if *end == i => *end = i + 1,
            _ => runs.push((i, i + 1)),
        }
    }
    runs
        .into_iter()
        .map(|(s, e)| DtrFormatOp {
            sheet_id,
            start_row_1based: s + 1,
            end_row_1based_excl: e + 1,
            start_col_0: 1,
            end_col_0_excl: 5,
            color: DtrCellColor::Red,
        })
        .collect()
}

/// Build the spreadsheets.batchUpdate body for paint ops (pure, tested
/// without network). One repeatCell per op; F/J never addressable here
/// because callers only emit columns 1..5.
pub fn build_format_requests(ops: &[DtrFormatOp]) -> serde_json::Value {
    let requests: Vec<serde_json::Value> = ops
        .iter()
        .map(|op| {
            let (red, green, blue) = dtr_rgb(op.color);
            serde_json::json!({
                "repeatCell": {
                    "range": {
                        "sheetId": op.sheet_id,
                        "startRowIndex": op.start_row_1based - 1,
                        "endRowIndex": op.end_row_1based_excl - 1,
                        "startColumnIndex": op.start_col_0,
                        "endColumnIndex": op.end_col_0_excl
                    },
                    "cell": { "userEnteredFormat": { "backgroundColor": { "red": red, "green": green, "blue": blue } } },
                    "fields": "userEnteredFormat.backgroundColor"
                }
            })
        })
        .collect();
    serde_json::json!({ "requests": requests })
}

/// Execute paint ops in ONE spreadsheets.batchUpdate. Skips the call
/// when there is nothing to paint. Returns whether a call was issued.
pub async fn execute_format_ops(
    client: &reqwest::Client,
    token: &str,
    spreadsheet_id: &str,
    ops: &[DtrFormatOp],
) -> Result<bool, String> {
    if ops.is_empty() {
        return Ok(false);
    }
    let response = client
        .post(format!(
            "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}:batchUpdate"
        ))
        .bearer_auth(token)
        .json(&build_format_requests(ops))
        .send()
        .await
        .map_err(|_| GOOGLE_REQUEST_FAILED.to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(dtr_status_error(status).to_string());
    }
    Ok(true)
}

/// Paint one tab: fetch A:F once, run the absent sweep, merge with the
/// caller-supplied row ops, and send a single batchUpdate. Log-only
/// callers must not fail scans over paint.
async fn paint_tab_formats(
    client: &reqwest::Client,
    token: &str,
    spreadsheet_id: &str,
    sheet_id: i64,
    tab: &str,
    mut ops: Vec<DtrFormatOp>,
) -> Result<bool, String> {
    let range = urlencoding::encode(&format!("{}!A:F", quote_tab(tab))).into_owned();
    let tab_values = dtr_get_json(
        client,
        token,
        format!("https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{range}"),
    )
    .await?;
    let rows = rows_from_values(&tab_values);
    let today = manila_today_ymd();
    ops.extend(plan_absent_sweep(sheet_id, &rows, &today));
    execute_format_ops(client, token, spreadsheet_id, &ops).await
}

fn quote_tab(tab: &str) -> String {
    format!("'{}'", tab.replace('\'', "''"))
}

fn dtr_status_error(status: reqwest::StatusCode) -> &'static str {
    match status.as_u16() {
        401 => GOOGLE_AUTH_FAILED,
        403 => GOOGLE_PERMISSION_DENIED,
        404 => GOOGLE_NOT_FOUND,
        429 => GOOGLE_RATE_LIMITED,
        _ => GOOGLE_REQUEST_FAILED,
    }
}

async fn dtr_get_json(
    client: &reqwest::Client,
    token: &str,
    url: String,
) -> Result<serde_json::Value, String> {
    let response = client
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| GOOGLE_REQUEST_FAILED.to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(dtr_status_error(status).to_string());
    }
    response
        .json()
        .await
        .map_err(|_| GOOGLE_REQUEST_FAILED.to_string())
}

fn rows_from_values(value: &serde_json::Value) -> Vec<Vec<String>> {
    value
        .get("values")
        .and_then(|v| v.as_array())
        .map(|rows| {
            rows.iter()
                .map(|row| {
                    row.as_array()
                        .map(|cells| {
                            cells
                                .iter()
                                .map(|c| {
                                    if let Some(s) = c.as_str() {
                                        s.to_string()
                                    } else if let Some(n) = c.as_f64() {
                                        if n.fract() == 0.0 {
                                            format!("{}", n as i64)
                                        } else {
                                            n.to_string()
                                        }
                                    } else {
                                        String::new()
                                    }
                                })
                                .collect()
                        })
                        .unwrap_or_default()
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Debug, PartialEq, Eq)]
pub struct DtrPushPlan {
    pub tab: String,
    pub row_1based: usize,
    pub values: [String; 4],
}

/// gid of the operator "COPY OF TEMPLATE" tab used to auto-create intern
/// tabs. Tab titles are aligned to roster names; prefer the live template
/// tab found by title and fall back to this id when it is missing.
const DTR_TEMPLATE_SHEET_ID: i64 = 1417402751;

/// Pick the template tab to duplicate for auto-created intern tabs:
/// a live tab whose title mentions "template" (case-insensitive),
/// else the known template gid (the duplicate then fails closed and the
/// user stays pending if that gid is gone too).
fn pick_template_sheet_id(meta: &[DtrTabMeta]) -> Option<i64> {
    meta.iter()
        .find(|m| m.title.to_lowercase().contains("template"))
        .map(|m| m.sheet_id)
        .or(Some(DTR_TEMPLATE_SHEET_ID))
}

/// Sheets forbids these characters in tab titles and caps titles at 100
/// chars. Roster names outside this never become tabs (user stays
/// pending for the owner instead of producing an API error loop).
fn dtr_tab_name_valid(name: &str) -> bool {
    let trimmed = name.trim();
    !trimmed.is_empty()
        && trimmed.len() <= 100
        && !trimmed
            .chars()
            .any(|c| matches!(c, ':' | '\\' | '/' | '?' | '*' | '[' | ']'))
}

/// True when the duplicateSheet failure means "name already taken" (the
/// tab appeared concurrently): the caller re-resolves next pass instead
/// of erroring into retry.
fn is_duplicate_sheet_error(status: u16, body: &str) -> bool {
    status == 400 && body.contains("already exists")
}

/// Parse the new numeric sheet id from a duplicateSheet response.
fn parse_duplicate_sheet_id(body: &serde_json::Value) -> Option<i64> {
    body.get("replies")?
        .as_array()?
        .first()?
        .get("duplicateSheet")?
        .get("properties")?
        .get("sheetId")?
        .as_i64()
}

/// True when some live (non-template) tab already shares a normalized
/// token with the user. Auto-create fires only on a clean miss — never
/// when another tab overlaps the name (that is ambiguity for the owner,
/// not a second tab). Tabs are aligned to roster names, so a genuinely
/// new intern never overlaps.
fn tab_name_overlaps_user(tab_titles: &[String], full_name: &str) -> bool {
    let user_toks = split_tokens(full_name);
    let core = strip_name_suffix(&user_toks);
    let core = if core.is_empty() { &user_toks } else { core };
    if core.is_empty() {
        return true;
    }
    tab_titles.iter().any(|title| {
        if is_skippable_title(title) {
            return false;
        }
        split_tokens(title)
            .iter()
            .any(|t| core.contains(t))
    })
}

/// True when `user_id` is an ACTIVE INTERN right now. Auto-create must
/// never mint tabs for employees or ex-roster users (enqueue already
/// gates on interns; this re-checks live truth before spending API
/// calls, since roster state can change between enqueue and push).
async fn user_is_active_intern(state: &AppState, user_id: &str) -> Result<bool, String> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT status, employee_type FROM users WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(matches!(row, Some((status, kind))
        if status.to_uppercase() == "ACTIVE" && kind.to_uppercase() == "INTERN"))
}

/// Duplicate the template tab as the intern's roster name (tabs are
/// aligned to roster names verbatim). Ok(Some(id)) on success;
/// Ok(None) when the name was taken concurrently (caller re-resolves
/// next pass); Err on transport/auth so the queue retries.
async fn duplicate_template_tab(
    client: &reqwest::Client,
    token: &str,
    spreadsheet_id: &str,
    template_id: i64,
    full_name: &str,
) -> Result<Option<i64>, String> {
    let title = full_name.trim();
    let response = client
        .post(format!(
            "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}:batchUpdate"
        ))
        .bearer_auth(token)
        .json(&serde_json::json!({ "requests": [{ "duplicateSheet": { "sourceSheetId": template_id, "newSheetName": title } }] }))
        .send()
        .await
        .map_err(|_| GOOGLE_REQUEST_FAILED.to_string())?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        if is_duplicate_sheet_error(status.as_u16(), &body) {
            log::info!("dtr auto-create: tab already exists for {title}; will re-resolve");
            return Ok(None);
        }
        return Err(dtr_status_error(status).to_string());
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|_| GOOGLE_REQUEST_FAILED.to_string())?;
    Ok(parse_duplicate_sheet_id(&body))
}

/// Resolve the user's tab, auto-creating it from the template when an
/// active intern genuinely has none. Returns the tab, its numeric id,
/// (possibly refreshed) meta, and whether the tab was just created (the
/// caller then backfills full history instead of a single day).
/// Ok(None) = still pending: not an intern, invalid name, no template,
/// duplicate race, or a still-missing tab after creation (re-resolve
/// next pass).
async fn ensure_person_tab(
    state: &AppState,
    client: &reqwest::Client,
    token: &str,
    spreadsheet_id: &str,
    meta: &[DtrTabMeta],
    user_id: &str,
    full_name: &str,
    roster: &[(String, String)],
) -> Result<Option<(String, i64, Vec<DtrTabMeta>, bool)>, String> {
    let titles = titles_of(meta);
    if let Some(tab) = resolve_user_tab(&titles, user_id, full_name, roster) {
        let Some(sheet_id) = sheet_id_for_tab(meta, &tab) else {
            return Err(format!("DTR tab id missing for resolved tab {tab}"));
        };
        return Ok(Some((tab, sheet_id, meta.to_vec(), false)));
    }
    if tab_name_overlaps_user(&titles, full_name) {
        return Ok(None);
    }
    if !user_is_active_intern(state, user_id).await? {
        return Ok(None);
    }
    if !dtr_tab_name_valid(full_name) {
        log::warn!("dtr auto-create refused for {full_name} ({user_id}): roster name is not a valid tab title");
        return Ok(None);
    }
    let Some(template_id) = pick_template_sheet_id(meta) else {
        return Ok(None);
    };
    if duplicate_template_tab(client, token, spreadsheet_id, template_id, full_name)
        .await?
        .is_none()
    {
        return Ok(None);
    }
    log::info!("dtr auto-created tab for {full_name} ({user_id})");
    let meta = fetch_tab_meta(client, token, spreadsheet_id).await?;
    let titles = titles_of(&meta);
    match resolve_user_tab(&titles, user_id, full_name, roster) {
        Some(tab) => match sheet_id_for_tab(&meta, &tab) {
            Some(sheet_id) => Ok(Some((tab, sheet_id, meta, true))),
            None => Err(format!("DTR tab id missing for resolved tab {tab}")),
        },
        None => Ok(None),
    }
}

/// Live tab metadata for the human DTR spreadsheet. `sheet_id` is the
/// numeric id the Sheets API needs for GridRange format requests.
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct DtrTabMeta {
    pub title: String,
    pub sheet_id: i64,
}

/// Fetch live tab titles + numeric ids for the human DTR spreadsheet.
pub async fn fetch_tab_meta(
    client: &reqwest::Client,
    token: &str,
    spreadsheet_id: &str,
) -> Result<Vec<DtrTabMeta>, String> {
    let meta_value = dtr_get_json(
        client,
        token,
        format!(
            "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}?fields=sheets.properties(title,sheetId)"
        ),
    )
    .await?;
    Ok(meta_value
        .get("sheets")
        .and_then(|s| s.as_array())
        .map(|sheets| {
            sheets
                .iter()
                .filter_map(|s| {
                    let props = s.get("properties")?;
                    Some(DtrTabMeta {
                        title: props.get("title")?.as_str()?.to_string(),
                        sheet_id: props.get("sheetId")?.as_i64()?,
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

fn titles_of(meta: &[DtrTabMeta]) -> Vec<String> {
    meta.iter().map(|m| m.title.clone()).collect()
}

fn sheet_id_for_tab(meta: &[DtrTabMeta], tab: &str) -> Option<i64> {
    meta.iter()
        .find(|m| m.title == tab)
        .map(|m| m.sheet_id)
}

/// Rich plan outcome so backfill can tell "already in sync" apart from
/// "can never sync" (missing tab/date row/empty values). `Err` = corrupt
/// or unreachable state (queue retries, then DEAD).
#[derive(Debug, PartialEq, Eq)]
enum DtrPlanOutcome {
    Write(DtrPushPlan),
    InSync { row_1based: usize },
    Unresolvable(&'static str),
}

/// Plan one attendance day against a known title list. `Err` = corrupt
/// or unreachable state (queue retries, then DEAD). Tab resolution
/// happens in the caller so a miss can be recorded in `dtr_pending`
/// instead of vanishing.
async fn plan_dtr_push_outcome(
    client: &reqwest::Client,
    token: &str,
    spreadsheet_id: &str,
    user_id: &str,
    full_name: &str,
    attendance_date: &str,
    time_in: Option<&str>,
    time_out: Option<&str>,
    all_users: &[(String, String)],
    titles: &[String],
) -> Result<DtrPlanOutcome, String> {
    let Some(tab) = resolve_user_tab(titles, user_id, full_name, all_users) else {
        return Ok(DtrPlanOutcome::Unresolvable("no-tab"));
    };
    let values = build_dtr_row(time_in, time_out, attendance_date)?;
    if values.iter().all(String::is_empty) {
        return Ok(DtrPlanOutcome::Unresolvable("empty-values"));
    }
    let range = urlencoding::encode(&format!("{}!A:F", quote_tab(&tab))).into_owned();
    let tab_values = dtr_get_json(
        client,
        token,
        format!("https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{range}"),
    )
    .await?;
    let rows = rows_from_values(&tab_values);
    let want_month: u32 = attendance_date
        .get(5..7)
        .and_then(|m| m.parse::<u32>().ok())
        .filter(|m| (1..=12).contains(m))
        .ok_or_else(|| format!("attendanceDate must be YYYY-MM-DD, got {attendance_date}"))?;
    // Scope to the month block; fall back to the whole tab only when the
    // tab carries no month headers at all.
    let mut saw_header = false;
    for row in &rows {
        if parse_month_header(row.first().map(String::as_str).unwrap_or("")).is_some() {
            saw_header = true;
            break;
        }
    }
    let bounds = if saw_header {
        month_block_range(&rows, want_month)
    } else {
        Some((0, rows.len()))
    };
    let Some((start, end)) = bounds else {
        return Ok(DtrPlanOutcome::Unresolvable("no-month-block"));
    };
    let Some(idx) = find_date_row_in(&rows, attendance_date, start, end)? else {
        return Ok(DtrPlanOutcome::Unresolvable("no-date-row"));
    };
    let existing = [
        rows[idx].get(1).cloned().unwrap_or_default(),
        rows[idx].get(2).cloned().unwrap_or_default(),
        rows[idx].get(3).cloned().unwrap_or_default(),
        rows[idx].get(4).cloned().unwrap_or_default(),
    ];
    if existing == values {
        return Ok(DtrPlanOutcome::InSync { row_1based: idx + 1 });
    }
    Ok(DtrPlanOutcome::Write(DtrPushPlan {
        tab,
        row_1based: idx + 1,
        values,
    }))
}

/// Execute a plan: single `B:E` range write. Returns `false` when the row
/// was already in sync (no write issued). Plan and execute share one
/// A:F fetch, so an owner edit landing between them can at worst make
/// one pass skip or rewrite — the next event re-plans from fresh reads.
pub async fn execute_dtr_push(
    client: &reqwest::Client,
    token: &str,
    spreadsheet_id: &str,
    plan: &DtrPushPlan,
) -> Result<bool, String> {
    let range = urlencoding::encode(&format!(
        "{}!B{}:E{}",
        quote_tab(&plan.tab),
        plan.row_1based,
        plan.row_1based
    ))
    .into_owned();
    let body = serde_json::json!({ "values": [[plan.values[0], plan.values[1], plan.values[2], plan.values[3]]] });
    let response = client
        .put(format!(
            "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{range}?valueInputOption=USER_ENTERED"
        ))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|_| GOOGLE_REQUEST_FAILED.to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(dtr_status_error(status).to_string());
    }
    Ok(true)
}

fn str_field(payload: &serde_json::Value, name: &str) -> Option<String> {
    payload
        .get(name)
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

fn opt_field(payload: &serde_json::Value, name: &str) -> Option<String> {
    payload.get(name).and_then(|v| match v {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) => Some(s.clone()),
        _ => None,
    })
}

async fn active_roster(state: &AppState) -> Result<Vec<(String, String)>, String> {
    use sqlx::Row;
    Ok(sqlx::query("SELECT user_id, full_name FROM users WHERE status = 'ACTIVE'")
        .fetch_all(&state.db)
        .await
        .map_err(|e| e.to_string())?
        .iter()
        .map(|row| {
            (
                row.get::<String, _>("user_id"),
                row.get::<String, _>("full_name"),
            )
        })
        .collect())
}

/// True when `user_id` is still on the ACTIVE roster. A pending intern
/// who was deactivated (or deleted) keeps their `dtr_pending` row but
/// is skipped each pass with a log — pushing ex-roster data or silently
/// dropping history would both be wrong; the owner resolves it.
fn roster_has(roster: &[(String, String)], user_id: &str) -> bool {
    roster.iter().any(|(id, _)| id == user_id)
}

/// Remember an intern whose DTR tab does not exist yet. Upsert-only;
/// cleared once the tab appears and history backfills. If the roster
/// name changed since tracking began, the next scan event refreshes it
/// via this same upsert; a pass in between may use the stale name and
/// simply stay pending until then.
async fn note_dtr_pending(
    state: &AppState,
    user_id: &str,
    full_name: &str,
    now: &str,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO dtr_pending (user_id, full_name, first_seen, last_checked, attempts) VALUES (?, ?, ?, ?, 0) \
         ON CONFLICT(user_id) DO UPDATE SET full_name = excluded.full_name, last_checked = excluded.last_checked, attempts = dtr_pending.attempts + 1",
    )
    .bind(user_id)
    .bind(full_name)
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

async fn clear_dtr_pending(state: &AppState, user_id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM dtr_pending WHERE user_id = ?")
        .bind(user_id)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Handle one `InternDtr` queue row. `Ok(false)` = already in sync or no
/// tab yet (tracked in `dtr_pending`). Errors propagate to the standard
/// claim/retry/backoff path in run_once.
pub async fn push_dtr_row(
    state: &AppState,
    client: &reqwest::Client,
    token: &str,
    spreadsheet_id: &str,
    payload: &serde_json::Value,
) -> Result<bool, String> {
    let user_id = str_field(payload, "userId")
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "DTR payload missing userId".to_string())?;
    let full_name = str_field(payload, "fullName")
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "DTR payload missing fullName".to_string())?;
    let attendance_date = str_field(payload, "attendanceDate")
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "DTR payload missing attendanceDate".to_string())?;
    let time_in = opt_field(payload, "timeIn");
    let time_out = opt_field(payload, "timeOut");
    let roster = active_roster(state).await?;
    let meta = fetch_tab_meta(client, token, spreadsheet_id).await?;
    // Tabs are aligned to roster names; a genuinely new intern gets one
    // auto-created from the template (then backfilled below). Anything
    // else stays pending for the owner.
    let Some((tab, sheet_id, meta, just_created)) = ensure_person_tab(
        state, client, token, spreadsheet_id, &meta, &user_id, &full_name, &roster,
    )
    .await?
    else {
        let now = chrono::Utc::now().to_rfc3339();
        note_dtr_pending(state, &user_id, &full_name, &now).await?;
        log::info!("dtr pending: no tab yet for {full_name} ({user_id})");
        return Ok(false);
    };
    // A just-created tab starts empty: backfill the full history now so
    // no past day waits for a future scan that may never come.
    if just_created {
        let (wrote, complete) =
            backfill_user_history(state, client, token, spreadsheet_id, &user_id, &full_name, &roster, &meta)
                .await?;
        let now = chrono::Utc::now().to_rfc3339();
        if complete {
            clear_dtr_pending(state, &user_id).await?;
        } else {
            note_dtr_pending(state, &user_id, &full_name, &now).await?;
        }
        return Ok(wrote > 0);
    }
    let titles = titles_of(&meta);
    let kind = classify_record_row(time_in.as_deref(), time_out.as_deref())?;
    match plan_dtr_push_outcome(
        client,
        token,
        spreadsheet_id,
        &user_id,
        &full_name,
        &attendance_date,
        time_in.as_deref(),
        time_out.as_deref(),
        &roster,
        &titles,
    )
    .await?
    {
        DtrPlanOutcome::Write(plan) => {
            execute_dtr_push(client, token, spreadsheet_id, &plan).await?;
            let ops = plan_row_format(sheet_id, plan.row_1based, kind);
            // P1: paint is cosmetic — a batchUpdate 403/429 must not fail
            // a row whose values already landed. Log and continue.
            if let Err(error) =
                paint_tab_formats(client, token, spreadsheet_id, sheet_id, &tab, ops).await
            {
                log::warn!(
                    "dtr paint failed for {full_name} ({user_id}) on {attendance_date} (values written): {error}"
                );
            }
            clear_dtr_pending(state, &user_id).await?;
            Ok(true)
        }
        DtrPlanOutcome::InSync { row_1based } => {
            let ops = plan_row_format(sheet_id, row_1based, kind);
            // P1: same log-only rule as the Write branch above.
            if let Err(error) =
                paint_tab_formats(client, token, spreadsheet_id, sheet_id, &tab, ops).await
            {
                log::warn!(
                    "dtr paint failed for {full_name} ({user_id}) on {attendance_date} (row in sync): {error}"
                );
            }
            clear_dtr_pending(state, &user_id).await?;
            Ok(false)
        }
        DtrPlanOutcome::Unresolvable(reason) => {
            log::info!("dtr skip for {full_name} ({user_id}) on {attendance_date}: {reason}");
            Ok(false)
        }
    }
}

/// One attendance-history page for backfill, oldest first. OFFSET paging
/// over a read-only ordered scan is stable (backfill never writes here).
async fn fetch_attendance_page(
    state: &AppState,
    user_id: &str,
    limit: i64,
    offset: i64,
) -> Result<Vec<(String, Option<String>, Option<String>)>, String> {
    use sqlx::Row;
    Ok(sqlx::query(
        "SELECT attendance_date, time_in, time_out FROM attendance WHERE user_id = ? ORDER BY attendance_date ASC LIMIT ? OFFSET ?",
    )
    .bind(user_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?
    .iter()
    .map(|row| {
        (
            row.get::<String, _>("attendance_date"),
            row.get::<Option<String>, _>("time_in"),
            row.get::<Option<String>, _>("time_out"),
        )
    })
    .collect())
}

/// Per-day backfill result. `Wrote` and `InSync` both mean the day is now
/// in sync; `Unresolvable` means it can never sync as-is (missing date
/// row, vanished tab, empty values). `Err` (network/corrupt) propagates
/// so the queue keeps the user pending via existing backoff.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum BackfillDayResult {
    Wrote,
    InSync,
    Unresolvable,
}

/// Aggregate one backfill pass: `(wrote, complete)`. Complete only when
/// every visited day ended `Wrote` or `InSync`.
fn aggregate_backfill(results: &[BackfillDayResult]) -> (usize, bool) {
    let mut wrote = 0;
    let mut complete = true;
    for result in results {
        match result {
            BackfillDayResult::Wrote => wrote += 1,
            BackfillDayResult::InSync => {}
            BackfillDayResult::Unresolvable => complete = false,
        }
    }
    (wrote, complete)
}

/// Backfill every attendance day for one user, oldest first, paging until
/// a short page. Per-row skip-identical keeps reruns safe. Paint ops for
/// every resolved day ride one final batchUpdate (with the absent sweep).
/// Tab titles/meta are fixed for the pass: a tab created mid-backfill is
/// picked up by the next pending recheck, never mid-loop.
/// Returns `(wrote, complete)`; the caller clears `dtr_pending` only when
/// complete, so a >1-page history (or a mid-pass failure) never drops
/// the newest days. P1: the old single `LIMIT 200` + unconditional
/// clear silently abandoned everything past day 200.
const DTR_BACKFILL_PAGE: i64 = 200;

async fn backfill_user_history(
    state: &AppState,
    client: &reqwest::Client,
    token: &str,
    spreadsheet_id: &str,
    user_id: &str,
    full_name: &str,
    roster: &[(String, String)],
    meta: &[DtrTabMeta],
) -> Result<(usize, bool), String> {
    let titles = titles_of(meta);
    let mut wrote_total = 0;
    let mut complete = true;
    let mut offset: i64 = 0;
    let mut row_ops: Vec<DtrFormatOp> = Vec::new();
    let Some(tab) = resolve_user_tab(&titles, user_id, full_name, roster) else {
        return Ok((0, false));
    };
    let Some(sheet_id) = sheet_id_for_tab(meta, &tab) else {
        return Err(format!("DTR tab id missing for resolved tab {tab}"));
    };
    loop {
        let days = fetch_attendance_page(state, user_id, DTR_BACKFILL_PAGE, offset).await?;
        let full_page = days.len() as i64 == DTR_BACKFILL_PAGE;
        let mut page_results = Vec::with_capacity(days.len());
        for (date, tin, tout) in &days {
            let kind = classify_record_row(tin.as_deref(), tout.as_deref())?;
            match plan_dtr_push_outcome(
                client,
                token,
                spreadsheet_id,
                user_id,
                full_name,
                date,
                tin.as_deref(),
                tout.as_deref(),
                roster,
                &titles,
            )
            .await?
            {
                DtrPlanOutcome::Write(plan) => {
                    execute_dtr_push(client, token, spreadsheet_id, &plan).await?;
                    row_ops.extend(plan_row_format(sheet_id, plan.row_1based, kind));
                    page_results.push(BackfillDayResult::Wrote);
                }
                DtrPlanOutcome::InSync { row_1based } => {
                    row_ops.extend(plan_row_format(sheet_id, row_1based, kind));
                    page_results.push(BackfillDayResult::InSync);
                }
                DtrPlanOutcome::Unresolvable(reason) => {
                    log::warn!(
                        "dtr backfill unresolvable for {full_name} ({user_id}) on {date}: {reason}"
                    );
                    page_results.push(BackfillDayResult::Unresolvable);
                }
            }
        }
        let (page_wrote, page_complete) = aggregate_backfill(&page_results);
        wrote_total += page_wrote;
        complete = complete && page_complete;
        if !full_page {
            break;
        }
        offset += DTR_BACKFILL_PAGE;
    }
    // P1: final paint is cosmetic — log-only so a batchUpdate failure
    // after successful value writes never drops pending or fails the pass.
    if let Err(error) =
        paint_tab_formats(client, token, spreadsheet_id, sheet_id, &tab, row_ops).await
    {
        log::warn!("dtr backfill paint failed for {full_name} ({user_id}) (values written): {error}");
    }
    Ok((wrote_total, complete))
}

/// Recheck every tracked user against one shared title fetch (one Sheets
/// metadata GET per run at most, only when pending rows exist). When a
/// tab has appeared, backfill the user's full history and clear pending.
/// Per-user failures are logged and skipped; the row stays pending.
pub async fn process_dtr_pending(
    state: &AppState,
    client: &reqwest::Client,
    token: &str,
    spreadsheet_id: &str,
) -> Result<usize, String> {
    use sqlx::Row;
    let pending: Vec<(String, String)> =
        sqlx::query("SELECT user_id, full_name FROM dtr_pending ORDER BY first_seen ASC")
            .fetch_all(&state.db)
            .await
            .map_err(|e| e.to_string())?
            .iter()
            .map(|row| {
                (
                    row.get::<String, _>("user_id"),
                    row.get::<String, _>("full_name"),
                )
            })
            .collect();
    if pending.is_empty() {
        return Ok(0);
    }
    let meta = fetch_tab_meta(client, token, spreadsheet_id).await?;
    let roster = active_roster(state).await?;
    let now = chrono::Utc::now().to_rfc3339();
    let mut backfilled = 0;
    for (user_id, full_name) in &pending {
        // Deactivated (or deleted) while pending: keep the row, skip the
        // pass. See roster_has docs for the rationale.
        if !roster_has(&roster, user_id) {
            log::info!("dtr pending: {full_name} ({user_id}) left the active roster; stays pending");
            continue;
        }
        // Resolve (or auto-create) the tab first so a pending user whose
        // tab just appeared — or was just minted — backfills in this same
        // pass instead of waiting another cycle. Transport failures stay
        // pending with a warning and never abort the remaining users.
        let meta = match ensure_person_tab(
            state, client, token, spreadsheet_id, &meta, user_id, full_name, &roster,
        )
        .await
        {
            Ok(Some((_tab, _sheet_id, fresh, _created))) => fresh,
            Ok(None) => {
                note_dtr_pending(state, user_id, full_name, &now).await?;
                continue;
            }
            Err(error) => {
                log::warn!("dtr pending recheck failed for {full_name} ({user_id}): {error}");
                note_dtr_pending(state, user_id, full_name, &now).await?;
                continue;
            }
        };
        match backfill_user_history(
            state, client, token, spreadsheet_id, user_id, full_name, &roster, &meta,
        )
        .await
        {
            // P1: clear pending only when every history day is in sync;
            // a partial pass (or a transport error) stays pending for
            // retry via the existing queue backoff.
            Ok((wrote, true)) => {
                clear_dtr_pending(state, user_id).await?;
                log::info!(
                    "dtr backfilled: tab appeared for {full_name} ({user_id}), {wrote} rows written"
                );
                backfilled += 1;
            }
            Ok((wrote, false)) => {
                note_dtr_pending(state, user_id, full_name, &now).await?;
                log::warn!(
                    "dtr backfill incomplete for {full_name} ({user_id}), {wrote} rows written; stays pending"
                );
            }
            Err(error) => {
                log::warn!("dtr backfill failed for {full_name} ({user_id}): {error}");
            }
        }
    }
    Ok(backfilled)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn users() -> Vec<(String, String)> {
        vec![
            ("u1".to_string(), "Deign Grey O. Lazaro".to_string()),
            ("u2".to_string(), "Kyle Ricio".to_string()),
            ("u3".to_string(), "Elaizah Altiche".to_string()),
        ]
    }

    #[test]
    fn resolves_last_first_tab_with_trailing_space() {
        let titles = vec!["LAZARO DEIGN ".to_string(), "COPY OF TEMPLATE".to_string()];
        assert_eq!(
            resolve_user_tab(&titles, "u1", "Deign Grey O. Lazaro", &users()),
            Some("LAZARO DEIGN ".to_string())
        );
    }

    #[test]
    fn resolves_single_first_name_tab() {
        let titles = vec!["KYLE".to_string()];
        // "kyle" sits in exactly one roster user → match.
        assert_eq!(
            resolve_user_tab(&titles, "u2", "Kyle Ricio", &users()),
            Some("KYLE".to_string())
        );
    }

    #[test]
    fn ambiguous_single_name_fails_closed() {
        let titles = vec!["GREY".to_string()];
        let mut roster = users();
        roster.push(("u9".to_string(), "Grey Santos".to_string()));
        // "grey" sits in two roster users → None.
        assert_eq!(
            resolve_user_tab(&titles, "u1", "Deign Grey O. Lazaro", &roster),
            None
        );
    }

    #[test]
    fn skips_template_and_unmatched() {
        let titles = vec!["COPY OF TEMPLATE".to_string(), "SOMEONE ELSE".to_string()];
        assert_eq!(
            resolve_user_tab(&titles, "u1", "Deign Grey O. Lazaro", &users()),
            None
        );
    }

    #[test]
    fn parses_sheet_dates() {
        assert_eq!(
            parse_sheet_date("9/5/2026"),
            Some(DateParts { y: 2026, m: 9, d: 5 })
        );
        assert_eq!(
            parse_sheet_date("2026-09-05"),
            Some(DateParts { y: 2026, m: 9, d: 5 })
        );
        assert_eq!(parse_sheet_date("TOTAL HOURS"), None);
        assert_eq!(parse_sheet_date("9/2/2026 "), Some(DateParts { y: 2026, m: 9, d: 2 }));
    }

    #[test]
    fn parses_month_headers() {
        assert_eq!(parse_month_header("SEPTEMBER"), Some(9));
        assert_eq!(parse_month_header("DATE-September"), Some(9));
        assert_eq!(parse_month_header("DATE-AUGUST"), Some(8));
        assert_eq!(parse_month_header("TOTAL HOURS"), None);
        assert_eq!(parse_month_header("9/5/2026"), None);
    }

    #[test]
    fn scopes_month_block_and_finds_date_row() {
        let rows = vec![
            vec!["AUGUST".to_string()],
            vec!["8/31/2026".to_string()],
            vec!["TOTAL HOURS".to_string()],
            vec!["SEPTEMBER".to_string()],
            vec!["9/4/2026".to_string()],
            vec!["9/5/2026".to_string()],
            vec!["TOTAL HOURS".to_string()],
        ];
        assert_eq!(month_block_range(&rows, 9), Some((4, 7)));
        assert_eq!(find_date_row_in(&rows, "2026-09-05", 4, 7), Ok(Some(5)));
        // Whole-tab search would also find it, but scoped search must not
        // leak into other months.
        assert_eq!(find_date_row_in(&rows, "2026-08-31", 4, 7), Ok(None));
    }

    #[test]
    fn duplicate_date_rows_fail_closed() {
        let rows = vec![
            vec!["9/5/2026".to_string()],
            vec!["9/5/2026".to_string()],
        ];
        assert!(find_date_row_in(&rows, "2026-09-05", 0, 2).is_err());
    }

    #[test]
    fn builds_time_in_and_time_out_rows() {
        assert_eq!(
            build_dtr_row(
                Some("2026-09-05T09:46:23+08:00"),
                None,
                "2026-09-05"
            ),
            Ok([
                "9:46:23 AM".to_string(),
                "12:00:00 PM".to_string(),
                "1:00:00 PM".to_string(),
                String::new()
            ])
        );
        assert_eq!(
            build_dtr_row(
                Some("2026-09-05T09:46:23+08:00"),
                Some("2026-09-05T17:00:00+08:00"),
                "2026-09-05"
            )
            .unwrap()[3],
            "5:00:00 PM"
        );
        assert_eq!(
            build_dtr_row(None, None, "2026-09-05"),
            Ok([String::new(), String::new(), String::new(), String::new()])
        );
    }

    #[test]
    fn half_day_timeout_renders_morning_only() {
        // 15:00 tap-out is discarded; C is always 12:00 PM, D/E empty.
        assert_eq!(
            build_dtr_row(
                Some("2026-09-05T08:04:00+08:00"),
                Some("2026-09-05T15:00:00+08:00"),
                "2026-09-05"
            ),
            Ok([
                "8:04:00 AM".to_string(),
                "12:00:00 PM".to_string(),
                String::new(),
                String::new()
            ])
        );
    }

    #[test]
    fn half_day_cutoff_boundary() {
        let tin = Some("2026-09-05T08:00:00+08:00");
        // 16:58:59 is still before 16:59 → half-day.
        assert_eq!(
            build_dtr_row(tin, Some("2026-09-05T16:58:59+08:00"), "2026-09-05").unwrap()[2],
            String::new()
        );
        // 16:59:00 and later → full day.
        assert_eq!(
            build_dtr_row(tin, Some("2026-09-05T16:59:00+08:00"), "2026-09-05").unwrap(),
            [
                "8:00:00 AM".to_string(),
                "12:00:00 PM".to_string(),
                "1:00:00 PM".to_string(),
                "4:59:00 PM".to_string()
            ]
        );
        assert_eq!(
            build_dtr_row(tin, Some("2026-09-05T17:00:00+08:00"), "2026-09-05").unwrap()[3],
            "5:00:00 PM"
        );
    }

    #[test]
    fn working_to_half_day_rewrite_clears_afternoon_cells() {
        // Intraday WORKING row carries the lunch pair…
        let working =
            build_dtr_row(Some("2026-09-05T08:00:00+08:00"), None, "2026-09-05").unwrap();
        assert_eq!(working[2], "1:00:00 PM");
        // …and the half-day timeout overwrites D/E with empty cells, so
        // skip-identical (which compares all four) issues the rewrite.
        let half = build_dtr_row(
            Some("2026-09-05T08:00:00+08:00"),
            Some("2026-09-05T12:30:00+08:00"),
            "2026-09-05"
        )
        .unwrap();
        assert_ne!(working, half);
        assert_eq!(half[2], String::new());
        assert_eq!(half[3], String::new());
    }

    #[test]
    fn duplicate_tab_titles_fail_closed() {
        // Two tabs with the identical title: two candidates → None.
        let titles = vec!["LAZARO DEIGN".to_string(), "LAZARO DEIGN ".to_string()];
        assert_eq!(
            resolve_user_tab(&titles, "u1", "Deign Grey O. Lazaro", &users()),
            None
        );
    }

    #[test]
    fn copy_of_person_tab_does_not_match() {
        // "COPY OF …" of a person tab carries copy/of tokens the user
        // does not own → skipped, never resolved.
        let titles = vec!["COPY OF LAZARO DEIGN".to_string()];
        assert_eq!(
            resolve_user_tab(&titles, "u1", "Deign Grey O. Lazaro", &users()),
            None
        );
    }

    #[test]
    fn blank_user_name_resolves_to_none() {
        let titles = vec!["LAZARO DEIGN".to_string()];
        assert_eq!(resolve_user_tab(&titles, "u1", "   ", &users()), None);
    }

    #[test]
    fn suffix_and_diacritics_fold_into_match() {
        // Generational suffixes ride along via subset matching.
        let titles = vec!["DELA CRUZ".to_string()];
        let roster = vec![("u7".to_string(), "Juan Dela Cruz Jr".to_string())];
        assert_eq!(
            resolve_user_tab(&titles, "u7", "Juan Dela Cruz Jr", &roster),
            Some("DELA CRUZ".to_string())
        );
        // Diacritics fold to ASCII on both sides.
        let titles = vec!["PENA".to_string()];
        let roster = vec![("u8".to_string(), "María Peña".to_string())];
        assert_eq!(
            resolve_user_tab(&titles, "u8", "María Peña", &roster),
            Some("PENA".to_string())
        );
        // …but the folded form must be spelled the same: FREDERIK (k)
        // never matches Frederick (ck) — exact-token rule, fail closed.
        let titles = vec!["RUIZ FREDERIK".to_string()];
        let roster = vec![("u9".to_string(), "John Frederick Ruiz".to_string())];
        assert_eq!(
            resolve_user_tab(&titles, "u9", "John Frederick Ruiz", &roster),
            None
        );
    }

    #[test]
    fn dirty_october_block_does_not_leak_across_months() {
        // Live-sheet reality: the October block carries mistyped 9/xx
        // rows. Bounds always derive from the query date's own month, so
        // a September search never enters October bounds (and vice
        // versa) — the dirty rows are unreachable, not matched.
        let rows = vec![
            vec!["SEPTEMBER".to_string()],
            vec!["9/5/2026".to_string()],
            vec!["TOTAL HOURS".to_string()],
            vec!["DATE-October".to_string()],
            vec!["9/5/2026".to_string()],
            vec!["10/5/2026".to_string()],
            vec!["TOTAL HOURS".to_string()],
        ];
        assert_eq!(month_block_range(&rows, 9), Some((1, 3)));
        assert_eq!(find_date_row_in(&rows, "2026-09-05", 1, 3), Ok(Some(1)));
        assert_eq!(month_block_range(&rows, 10), Some((4, 7)));
        assert_eq!(find_date_row_in(&rows, "2026-10-05", 4, 7), Ok(Some(5)));
    }

    #[test]
    fn absent_sweep_skips_impossible_dates() {
        // 2/30/2026 parses as parts but is not a calendar day, so the
        // sweep (which re-validates via NaiveDate) skips it while the
        // neighbouring real Friday still paints.
        let rows = vec![
            fmt_row(&["2/27/2026", "", "", "", ""]),
            fmt_row(&["2/30/2026", "", "", "", ""]),
        ];
        let ops = plan_absent_sweep(9, &rows, "2026-09-05");
        assert_eq!(ops.len(), 1);
        assert_eq!((ops[0].start_row_1based, ops[0].end_row_1based_excl), (1, 2));
    }

    #[test]
    fn roster_membership_guards_pending_passes() {
        let roster = users();
        assert!(roster_has(&roster, "u1"));
        assert!(!roster_has(&roster, "u-gone"));
    }

    #[test]
    fn inverted_timestamps_are_rejected() {
        // Time-out before time-in (P4 precedent): fail closed, never
        // render a nonsense row.
        assert!(build_dtr_row(
            Some("2026-09-05T09:00:00+08:00"),
            Some("2026-09-05T08:00:00+08:00"),
            "2026-09-05"
        )
        .is_err());
    }

    #[test]
    fn quotes_tab_titles_for_a1() {
        assert_eq!(quote_tab("LAZARO DEIGN "), "'LAZARO DEIGN '");
        assert_eq!(quote_tab("O'Brien"), "'O''Brien'");
    }

    #[test]
    fn template_pick_prefers_live_template_tab() {
        let meta = vec![
            DtrTabMeta { title: "Deign Grey O. Lazaro".to_string(), sheet_id: 7 },
            DtrTabMeta { title: "COPY OF TEMPLATE".to_string(), sheet_id: 42 },
        ];
        assert_eq!(pick_template_sheet_id(&meta), Some(42));
    }

    #[test]
    fn template_pick_falls_back_to_known_gid() {
        let meta =
            vec![DtrTabMeta { title: "Deign Grey O. Lazaro".to_string(), sheet_id: 7 }];
        assert_eq!(pick_template_sheet_id(&meta), Some(DTR_TEMPLATE_SHEET_ID));
    }

    #[test]
    fn tab_name_validity_rejects_sheet_illegal_titles() {
        assert!(dtr_tab_name_valid("Deign Grey O. Lazaro"));
        assert!(dtr_tab_name_valid("Ma. Ellaine Zapico"));
        assert!(!dtr_tab_name_valid(""));
        assert!(!dtr_tab_name_valid("   "));
        assert!(!dtr_tab_name_valid("A:B"));
        assert!(!dtr_tab_name_valid("A/B"));
        assert!(!dtr_tab_name_valid("A?B"));
        assert!(!dtr_tab_name_valid("A[B"));
        assert!(!dtr_tab_name_valid(&"x".repeat(101)));
        assert!(dtr_tab_name_valid(&"x".repeat(100)));
    }

    #[test]
    fn duplicate_sheet_error_detects_name_taken() {
        assert!(is_duplicate_sheet_error(
            400,
            "A sheet with the name X already exists."
        ));
        assert!(!is_duplicate_sheet_error(403, "The caller does not have permission."));
        assert!(!is_duplicate_sheet_error(
            400,
            "Invalid requests[0].duplicateSheet: bad id."
        ));
        assert!(!is_duplicate_sheet_error(429, "Quota exceeded."));
    }

    #[test]
    fn duplicate_sheet_id_parses_reply_shape() {
        let body = serde_json::json!({"replies": [{"duplicateSheet": {"properties": {"sheetId": 909041946}}}]});
        assert_eq!(parse_duplicate_sheet_id(&body), Some(909041946));
        assert_eq!(parse_duplicate_sheet_id(&serde_json::json!({})), None);
        assert_eq!(
            parse_duplicate_sheet_id(&serde_json::json!({"replies": []})),
            None
        );
    }

    #[test]
    fn overlap_gate_blocks_ambiguous_creates_allows_clean_misses() {
        let titles = vec!["MARY".to_string(), "COPY OF TEMPLATE".to_string()];
        // Shares "mary" with a live tab: ambiguous, never auto-create.
        assert!(tab_name_overlaps_user(&titles, "Mary Jane Santos"));
        // No shared token: clean miss, auto-create may proceed.
        assert!(!tab_name_overlaps_user(
            &titles,
            "Rona Khristelle Angelique Pacada"
        ));
        // Template-only titles never count as overlap.
        assert!(!tab_name_overlaps_user(
            &["COPY OF TEMPLATE".to_string()],
            "Rona Khristelle Angelique Pacada"
        ));
        // Degenerate names never auto-create.
        assert!(tab_name_overlaps_user(&[], ""));
    }

    async fn pending_test_state() -> crate::state::AppState {
        use crate::config::{LanConfig, OfficeConfig, ScannerConfig, TtsConfig, UpdaterConfig};
        let data_dir = std::env::temp_dir().join(format!("alpha-dtr-{}", uuid::Uuid::new_v4()));
        crate::state::AppState::new(
            data_dir.clone(),
            data_dir.join("attendance.db"),
            data_dir.join("exports"),
            false,
            LanConfig::default(),
            OfficeConfig::default(),
            ScannerConfig::default(),
            TtsConfig::default(),
            UpdaterConfig::default(),
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn pending_lifecycle_tracks_and_clears() {
        let state = pending_test_state().await;
        // Migration 0013 created the table (full migration chain runs).
        let table: Option<String> = sqlx::query_scalar(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dtr_pending'",
        )
        .fetch_optional(&state.db)
        .await
        .unwrap();
        assert_eq!(table.as_deref(), Some("dtr_pending"));
        // First miss records the intern…
        note_dtr_pending(&state, "u-new", "New Intern", "2026-09-05T00:00:00+08:00").await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM dtr_pending")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(count, 1);
        // …repeat misses upsert (no duplicate rows), attempts grows…
        note_dtr_pending(&state, "u-new", "New Intern", "2026-09-05T00:01:00+08:00").await.unwrap();
        let (count, attempts): (i64, i64) =
            sqlx::query_as("SELECT COUNT(*), MAX(attempts) FROM dtr_pending")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!((count, attempts), (1, 1));
        // …and a backfilled tab clears tracking.
        clear_dtr_pending(&state, "u-new").await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM dtr_pending")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn non_manila_stamps_use_manila_wall_time() {
        // P1: 01:46:23Z is 09:46:23 Manila → morning render, not 1:46 AM.
        assert_eq!(
            format_sheet_time("2026-09-05T01:46:23Z"),
            Ok("9:46:23 AM".to_string())
        );
        // P1: 09:30:00Z is 17:30 Manila → FULL day (was misclassified
        // half-day when the raw UTC hour was compared).
        let full = build_dtr_row(
            Some("2026-09-05T01:00:00Z"),
            Some("2026-09-05T09:30:00Z"),
            "2026-09-05",
        )
        .unwrap();
        assert_eq!(full[0], "9:00:00 AM");
        assert_eq!(full[2], "1:00:00 PM");
        assert_eq!(full[3], "5:30:00 PM");
        // 08:30:00Z is 16:30 Manila → still half-day (morning-only).
        let half = build_dtr_row(
            Some("2026-09-05T00:04:00Z"),
            Some("2026-09-05T08:30:00Z"),
            "2026-09-05",
        )
        .unwrap();
        assert_eq!(half[0], "8:04:00 AM");
        assert_eq!(half[1], "12:00:00 PM");
        assert_eq!(half[2], String::new());
        assert_eq!(half[3], String::new());
    }

    #[tokio::test]
    async fn backfill_paging_reaches_newest_rows() {
        // P1: 205 history days must page as 200 + 5 with the newest day
        // present in the tail page (the old LIMIT 200 dropped it).
        let state = pending_test_state().await;
        // Seed 205 consecutive valid days starting 2025-01-01.
        let mut current = chrono::NaiveDate::from_ymd_opt(2025, 1, 1).unwrap();
        for _ in 0..205 {
            let date = current.format("%Y-%m-%d").to_string();
            sqlx::query(
                "INSERT INTO attendance (attendance_id, attendance_date, user_id, rfid_uid, full_name, time_in, status, source, created_at, updated_at) VALUES (?, ?, 'u-big', 'R1', 'Big History', ?, 'COMPLETED', 'RFID', ?, ?)",
            )
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(&date)
            .bind(format!("{date}T08:00:00+08:00"))
            .bind(format!("{date}T08:00:00+08:00"))
            .bind(format!("{date}T08:00:00+08:00"))
            .execute(&state.db)
            .await
            .unwrap();
            current = current.succ_opt().unwrap();
        }
        let page1 = fetch_attendance_page(&state, "u-big", 200, 0).await.unwrap();
        let page2 = fetch_attendance_page(&state, "u-big", 200, 200).await.unwrap();
        let page3 = fetch_attendance_page(&state, "u-big", 200, 400).await.unwrap();
        assert_eq!(page1.len(), 200);
        assert_eq!(page2.len(), 5);
        assert!(page3.is_empty());
        assert_eq!(page1[0].0, "2025-01-01");
        // Newest day (2025-07-24) rides in the tail page, oldest first.
        assert_eq!(page2.last().unwrap().0, "2025-07-24");
        assert!(page2.windows(2).all(|w| w[0].0 < w[1].0));
    }

    #[test]
    fn backfill_completion_gates_pending_clear() {
        use BackfillDayResult::*;
        // All in sync (or freshly written) → complete → pending clears.
        assert_eq!(
            aggregate_backfill(&[Wrote, InSync, Wrote]),
            (2, true)
        );
        assert_eq!(aggregate_backfill(&[]), (0, true));
        // One unresolvable day → incomplete → pending stays for retry.
        // P1: this is the >200-day / missing-date-row case that the old
        // unconditional clear turned into silent data loss.
        assert_eq!(
            aggregate_backfill(&[Wrote, InSync, Unresolvable]),
            (1, false)
        );
        assert_eq!(aggregate_backfill(&[Unresolvable]), (0, false));
    }

    fn fmt_row(cells: &[&str]) -> Vec<String> {
        cells.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn row_format_absent_paints_b_to_e_red() {
        let ops = plan_row_format(7, 107, DtrRowKind::Absent);
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].sheet_id, 7);
        assert_eq!(ops[0].start_row_1based, 107);
        assert_eq!(ops[0].end_row_1based_excl, 108);
        assert_eq!((ops[0].start_col_0, ops[0].end_col_0_excl), (1, 5));
        assert_eq!(ops[0].color, DtrCellColor::Red);
    }

    #[test]
    fn row_format_half_day_whites_morning_reds_remainder() {
        let ops = plan_row_format(7, 107, DtrRowKind::HalfDay);
        assert_eq!(ops.len(), 2);
        assert_eq!((ops[0].start_col_0, ops[0].end_col_0_excl), (1, 3));
        assert_eq!(ops[0].color, DtrCellColor::White);
        assert_eq!((ops[1].start_col_0, ops[1].end_col_0_excl), (3, 5));
        assert_eq!(ops[1].color, DtrCellColor::Red);
    }

    #[test]
    fn row_format_full_day_whites_everything() {
        // Clears stale red (absent → backdated entry, half → corrected).
        let ops = plan_row_format(7, 107, DtrRowKind::FullDay);
        assert_eq!(ops.len(), 1);
        assert_eq!((ops[0].start_col_0, ops[0].end_col_0_excl), (1, 5));
        assert_eq!(ops[0].color, DtrCellColor::White);
    }

    #[test]
    fn row_format_working_leaves_time_out_cell_untouched() {
        let ops = plan_row_format(7, 107, DtrRowKind::Working);
        assert_eq!(ops.len(), 1);
        assert_eq!((ops[0].start_col_0, ops[0].end_col_0_excl), (1, 4));
        assert_eq!(ops[0].color, DtrCellColor::White);
    }

    #[test]
    fn classify_record_row_matches_display_rule() {
        assert_eq!(
            classify_record_row(Some("2026-09-05T08:00:00+08:00"), None),
            Ok(DtrRowKind::Working)
        );
        assert_eq!(
            classify_record_row(
                Some("2026-09-05T08:00:00+08:00"),
                Some("2026-09-05T12:30:00+08:00")
            ),
            Ok(DtrRowKind::HalfDay)
        );
        assert_eq!(
            classify_record_row(
                Some("2026-09-05T08:00:00+08:00"),
                Some("2026-09-05T17:00:00+08:00")
            ),
            Ok(DtrRowKind::FullDay)
        );
    }

    #[test]
    fn absent_sweep_paints_only_past_weekdays() {
        // 2026-09-05 is a Saturday; 09-04 Friday, 09-03 Thursday,
        // 09-01 Tuesday, 08-30 Sunday, 09-06 future Sunday.
        let rows = vec![
            fmt_row(&["SEPTEMBER"]),
            fmt_row(&["9/1/2026", "", "", "", ""]),
            fmt_row(&["9/2/2026", "7:40:00 AM", "12:00:00 PM", "1:00:00 PM", "5:00:00 PM"]),
            fmt_row(&["9/3/2026", "", "", "", ""]),
            fmt_row(&["9/4/2026", "", "", "", ""]),
            fmt_row(&["9/5/2026", "", "", "", ""]),
            fmt_row(&["9/6/2026", "", "", "", ""]),
            fmt_row(&["8/30/2026", "", "", "", ""]),
            fmt_row(&["TOTAL HOURS"]),
        ];
        let ops = plan_absent_sweep(9, &rows, "2026-09-05");
        // 9/1 alone (1-based row 2), 9/3+9/4 merged (rows 4-5). 9/2 has
        // values, 9/5 is today, 9/6 future, 8/30 Sunday, header skipped.
        assert_eq!(ops.len(), 2);
        assert_eq!((ops[0].start_row_1based, ops[0].end_row_1based_excl), (2, 3));
        assert_eq!((ops[1].start_row_1based, ops[1].end_row_1based_excl), (4, 6));
        for op in &ops {
            assert_eq!(op.sheet_id, 9);
            assert_eq!((op.start_col_0, op.end_col_0_excl), (1, 5));
            assert_eq!(op.color, DtrCellColor::Red);
        }
    }

    #[test]
    fn absent_sweep_never_paints_on_bad_today() {
        let rows = vec![fmt_row(&["9/1/2026", "", "", "", ""])];
        assert!(plan_absent_sweep(9, &rows, "not-a-date").is_empty());
    }

    #[test]
    fn format_requests_use_repeat_cell_background_only() {
        let ops = vec![
            DtrFormatOp {
                sheet_id: 1880677918,
                start_row_1based: 107,
                end_row_1based_excl: 108,
                start_col_0: 3,
                end_col_0_excl: 5,
                color: DtrCellColor::Red,
            },
            DtrFormatOp {
                sheet_id: 1880677918,
                start_row_1based: 107,
                end_row_1based_excl: 108,
                start_col_0: 1,
                end_col_0_excl: 3,
                color: DtrCellColor::White,
            },
        ];
        let body = build_format_requests(&ops);
        let requests = body.get("requests").and_then(|r| r.as_array()).unwrap();
        assert_eq!(requests.len(), 2);
        let first = &requests[0]["repeatCell"];
        assert_eq!(first["range"]["sheetId"], 1880677918);
        assert_eq!(first["range"]["startRowIndex"], 106);
        assert_eq!(first["range"]["endRowIndex"], 107);
        assert_eq!(first["range"]["startColumnIndex"], 3);
        assert_eq!(first["range"]["endColumnIndex"], 5);
        assert_eq!(first["cell"]["userEnteredFormat"]["backgroundColor"]["red"], 1.0);
        assert_eq!(first["fields"], "userEnteredFormat.backgroundColor");
        let second = &requests[1]["repeatCell"];
        assert_eq!(
            second["cell"]["userEnteredFormat"]["backgroundColor"]["green"],
            1.0
        );
        // No request may address F (index 5) or beyond.
        for request in requests {
            let end = request["repeatCell"]["range"]["endColumnIndex"]
                .as_u64()
                .unwrap();
            assert!(end <= 5, "format range leaks past column E");
        }
    }
}
