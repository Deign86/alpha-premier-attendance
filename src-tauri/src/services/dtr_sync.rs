//! Auto-push of kiosk time-in/out rows to the human `INTERN DTR 2026`
//! spreadsheet (one tab per intern, monthly blocks).
//!
//! Design notes (mirrors `server/src/intern-dtr-sync.ts`, validated live):
//! - Tab resolution is order-free subset matching with fail-closed
//!   ambiguity handling; `COPY OF TEMPLATE` is always skipped.
//! - Only `B:E` data cells are ever written (`USER_ENTERED`); column `F`
//!   (`TOTAL HOURS`) and the `H:J` counters are formula territory.
//! - Writes are idempotent: identical `B:E` cells are skipped (all four
//!   cells are compared, so a WORKING → completed rewrite fills `E`).
//! - DTR rows carry actual stamps only; payroll half-day (payroll.rs
//!   `is_half_day`) is derived separately from the same raw punches and
//!   never feeds this row builder.
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
// Retained for sheet-contract readability (owner template labels). DTR rows
// carry actual stamps only since the DTR/payroll decoupling; nothing
// substitutes these into B:E anymore.
#[allow(dead_code)]
pub const DTR_LUNCH_OUT: &str = "12:00:00 PM";
#[allow(dead_code)]
pub const DTR_LUNCH_IN: &str = "1:00:00 PM";

/// Per-device kill switch for intern-DTR pushes, stored in the LOCAL
/// SQLite `app_settings` table (key below, `"1"`/`"0"`). Local DB =
/// per-device, so switching one PC off never affects the other.
/// Default ON (historical behavior); env `ALPHA_PREMIER_DTR_SYNC_ENABLED`
/// (`0`/`false`/`off` → off, `1`/`true`/`on` → on) wins when set.
pub const DTR_SYNC_ENABLED_KEY: &str = "intern_dtr_sync_enabled";
pub const ENV_DTR_SYNC_ENABLED: &str = "ALPHA_PREMIER_DTR_SYNC_ENABLED";

/// True when this device may push to the human DTR sheet. Env override
/// first, then the local `app_settings` row, defaulting to ON when the
/// table/row is absent (fresh DBs keep syncing until an admin opts out).
pub async fn is_dtr_sync_enabled(db: &sqlx::SqlitePool) -> bool {
    if let Ok(raw) = std::env::var(ENV_DTR_SYNC_ENABLED) {
        match raw.trim().to_lowercase().as_str() {
            "0" | "false" | "no" | "off" => return false,
            "1" | "true" | "yes" | "on" => return true,
            _ => {}
        }
    }
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL)",
    )
    .execute(db)
    .await;
    let value: Option<String> = sqlx::query_scalar("SELECT value FROM app_settings WHERE key = ?")
        .bind(DTR_SYNC_ENABLED_KEY)
        .fetch_optional(db)
        .await
        .unwrap_or(None);
    !matches!(
        value.as_deref().map(str::trim),
        Some("0") | Some("false") | Some("no") | Some("off")
    )
}

/// Persist the per-device toggle from the Admin UI. Missing table is
/// created inline so the very first toggle never fails on older DBs.
pub async fn set_dtr_sync_enabled(db: &sqlx::SqlitePool, enabled: bool) -> Result<(), String> {
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL)",
    )
    .execute(db)
    .await;
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(DTR_SYNC_ENABLED_KEY)
    .bind(if enabled { "1" } else { "0" })
    .bind(&now)
    .execute(db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}


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
    pub(crate) y: i32,
    pub(crate) m: u32,
    pub(crate) d: u32,
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

/// Where a month block lives on a DTR tab. Three distinct facts, one value:
/// the previous `Option` return meant both "this tab has no month headers at
/// all" and "headers exist but none matches", which forced callers to
/// re-derive the difference and let the two callers read it differently.
/// The set of cells a caller writes is unchanged by this split.
#[derive(Debug, PartialEq, Eq)]
pub enum MonthBlock {
    /// 0-based exclusive bounds of the matching block.
    Range(usize, usize),
    /// The tab carries no month headers anywhere in column A.
    NoHeaders,
    /// The tab has month headers, but none matches the requested month.
    NoMatch,
}

/// Locate the 0-based exclusive bounds of `month`'s block in column A.
pub fn month_block_range(rows: &[Vec<String>], month: u32) -> MonthBlock {
    let mut saw_header = false;
    let mut block_start: Option<usize> = None;
    for (i, row) in rows.iter().enumerate() {
        let cell = row.first().map(String::as_str).unwrap_or("");
        if parse_month_header(cell).is_none() {
            continue;
        }
        saw_header = true;
        if block_start.is_some() {
            return block_start.map(|s| MonthBlock::Range(s, i)).unwrap_or(MonthBlock::NoMatch);
        }
        if parse_month_header(cell) == Some(month) {
            block_start = Some(i + 1);
        }
    }
    if !saw_header {
        return MonthBlock::NoHeaders;
    }
    block_start.map(|s| MonthBlock::Range(s, rows.len())).unwrap_or(MonthBlock::NoMatch)
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

/// Half-day cutoffs (Manila wall clock), DTR display only — system
/// payroll keeps its own half-day logic:
/// - time-out strictly before 16:59:00 with a morning clock-in renders
///   the classic half-day `[in, 12PM, '', '']`;
/// - a clock-out before 13:00 never earns the fixed 12PM convention:
///   sub-half-day morning fragments render actual stamps
///   `[in, out, '', '']` so accidental taps read as what they are;
/// - a clock-in at/after 12:00 with an early time-out renders
///   afternoon-only actuals `['', '', in, out]`.
const HALF_DAY_CUTOFF_HOUR: u32 = 16;
const HALF_DAY_CUTOFF_MINUTE: u32 = 59;
/// Clock-in at/after this Manila hour renders afternoon-only.
const AFTERNOON_ARRIVAL_HOUR: u32 = 12;
/// Below this Manila hour a time-out is a morning fragment (actual
/// stamps), never the fixed-lunch half-day form.
const LUNCH_OUT_HOUR: u32 = 13;

fn is_before_lunch_out(time_out: &str) -> Result<bool, String> {
    let dt = chrono::DateTime::parse_from_rfc3339(time_out.trim())
        .map_err(|_| format!("invalid timestamp: {time_out}"))?;
    let t = dt.with_timezone(&Manila).time();
    Ok(t.hour() < LUNCH_OUT_HOUR)
}

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

fn is_afternoon_arrival(time_in: &str) -> Result<bool, String> {
    let dt = chrono::DateTime::parse_from_rfc3339(time_in.trim())
        .map_err(|_| format!("invalid timestamp: {time_in}"))?;
    let t = dt.with_timezone(&Manila).time();
    Ok(t.hour() >= AFTERNOON_ARRIVAL_HOUR)
}

/// One normalized view of a raw DTR pair — the single source both the
/// display row (`build_dtr_row`) and the paint classifier
/// (`classify_record_row`) agree on (audit A1). Mirrors the TS sibling
/// `NormalizedRecord` / `normalizeRecord` in server/src/intern-dtr-sync.ts.
enum NormalizedRecord {
    /// No usable time-in (missing or blank).
    Empty,
    /// Time-in present, no usable time-out. Carries the raw time-in string
    /// (not a parsed instant): callers that render it validate/parse via
    /// `format_sheet_time`, and the classifier never parses it — matching
    /// the TS reference, which returns `working` before parsing.
    Working { time_in: String },
    /// Both stamps present and ordered after capping; ready to render.
    Completed {
        time_in: chrono::DateTime<chrono_tz::Tz>,
        time_out: chrono::DateTime<chrono_tz::Tz>,
        time_out_iso: String,
    },
}

/// Own parse + Manila conversion + late-cap + ordering validation exactly
/// once, so both consumers normalize identically (audit A1).
///
/// Missing/blank time-in → `Empty`; missing/blank time-out → `Working`.
/// Invalid stamps keep the `invalid timestamp: <value>` message. The 18:00+
/// → 17:00 auto-cap is applied to the time-out BEFORE the ordering check, so
/// a `Completed` record always has its capped time-out at or after the
/// time-in. A cap that pulls the time-out before the time-in (e.g. in 17:30,
/// out 18:00 → out 17:00) fails closed with the inverted-time error instead
/// of rendering/classifying an inverted interval.
fn normalize_record(
    time_in: Option<&str>,
    time_out: Option<&str>,
) -> Result<NormalizedRecord, String> {
    let Some(tin) = time_in.filter(|s| !s.trim().is_empty()) else {
        return Ok(NormalizedRecord::Empty);
    };
    let Some(tout_raw) = time_out.filter(|s| !s.trim().is_empty()) else {
        return Ok(NormalizedRecord::Working {
            time_in: tin.to_string(),
        });
    };
    let tin_dt = chrono::DateTime::parse_from_rfc3339(tin.trim())
        .map_err(|_| format!("invalid timestamp: {tin}"))?
        .with_timezone(&Manila);
    let tout_dt = chrono::DateTime::parse_from_rfc3339(tout_raw.trim())
        .map_err(|_| format!("invalid timestamp: {tout_raw}"))?
        .with_timezone(&Manila);
    // Late time-out auto-cap (overtime forbidden): 18:00+ → 17:00 same-day.
    let capped_out = crate::services::payroll::cap_late_timeout_out(tout_dt);
    if capped_out < tin_dt {
        // Raw stamp in the message (TS reference parity); the interval that
        // actually fails is the capped one, which is why this is checked
        // after the cap.
        return Err(format!(
            "Time-out cannot be earlier than time-in: {tout_raw} < {tin}"
        ));
    }
    Ok(NormalizedRecord::Completed {
        time_in: tin_dt,
        time_out: capped_out,
        time_out_iso: capped_out.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    })
}

/// Build `[B, C, D, E]` — DTR SOURCE OF TRUTH (actual stamps only).
///
/// Decoupled from payroll half-day logic: this function NEVER fabricates,
/// truncates, or substitutes fixed-lunch/half-day conventions. Every
/// completed shift renders actual stamps grouped by morning/afternoon
/// columns (`[in,out,'','']` if out<13:00, `['','',in,out]` if in>=12:00,
/// else `[in,'','',out]`); working (no time-out) renders `[in,'','','']`.
/// Payroll half-day (`is_half_day` in payroll.rs) is derived separately
/// from the same raw punches and must never feed this row builder.
/// Late time-out auto-cap only: a clock-out at/after 18:00 Manila renders
/// as 5:00 PM (overtime forbidden); everything before 18:00 renders actual.
/// - a time-out earlier than the time-in is rejected (mirrors the P4
///   inverted-log rule in payroll): overnight shifts are outside the
///   kiosk same-day model, so failing closed beats rendering nonsense.
/// - records without a time-out (WORKING, MISSED, LATE_TIMEOUT) render
///   like WORKING; the DTR assumes nothing about payroll for them.
///
/// BEHAVIOR CHANGE (audit A1): the ordering check now runs AFTER the cap
/// (via `normalize_record`), so a pair whose capped time-out precedes the
/// time-in (in 17:30 / out 18:00 → capped out 17:00) is REJECTED instead
/// of rendering an inverted row. This is the fail-closed behavior
/// `classify_record_row` already had; both now share it.
pub fn build_dtr_row(
    time_in: Option<&str>,
    time_out: Option<&str>,
    _attendance_date: &str,
) -> Result<[String; 4], String> {
    match normalize_record(time_in, time_out)? {
        NormalizedRecord::Empty => Ok([String::new(), String::new(), String::new(), String::new()]),
        NormalizedRecord::Working { time_in } => {
            // `format_sheet_time` validates/parses the raw stamp (keeps the
            // existing invalid-timestamp error for a working record).
            let started = format_sheet_time(&time_in)?;
            Ok([started, String::new(), String::new(), String::new()])
        }
        NormalizedRecord::Completed {
            time_in,
            time_out_iso,
            ..
        } => {
            let tin_iso = time_in.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
            let started = format_sheet_time(&tin_iso)?;
            let ended = format_sheet_time(&time_out_iso)?;
            // Actual-stamps only, grouped by morning/afternoon columns:
            // out before 13:00 -> morning pair; in at/after noon -> afternoon
            // pair; otherwise the span crosses lunch (unknown split) -> ends only.
            // Payroll half-day classification must never alter these cells.
            if is_before_lunch_out(&time_out_iso)? {
                return Ok([started, ended, String::new(), String::new()]);
            }
            if is_afternoon_arrival(&tin_iso)? {
                return Ok([String::new(), String::new(), started, ended]);
            }
            Ok([started, String::new(), String::new(), ended])
        }
    }
}

/// Display kind of one DTR row (DTR rules, not payroll). `Absent` is
/// only produced by the sweep over sheet rows, never by record planning
/// (a record-less push is `Unresolvable("empty-values")` upstream).
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum DtrRowKind {
    Absent,
    HalfDay,
    HalfDayPm,
    MorningFragment,
    AfternoonFragment,
    LunchSpanFragment,
    FullDay,
    Working,
}

/// Classify one attendance record for paint purposes. Half-day uses the
/// same Manila wall-clock cutoffs as `build_dtr_row`.
pub fn classify_record_row(
    time_in: Option<&str>,
    time_out: Option<&str>,
) -> Result<DtrRowKind, String> {
    match normalize_record(time_in, time_out)? {
        NormalizedRecord::Empty => Ok(DtrRowKind::Absent),
        NormalizedRecord::Working { .. } => Ok(DtrRowKind::Working),
        NormalizedRecord::Completed {
            time_in,
            time_out,
            time_out_iso,
        } => {
            let tin_iso = time_in.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
            // Tier order mirrors build_dtr_row exactly (duration-first).
            if is_before_lunch_out(&time_out_iso)? {
                return Ok(DtrRowKind::MorningFragment);
            }
            let short_stint = time_out - time_in < chrono::Duration::hours(4);
            if is_afternoon_arrival(&tin_iso)? {
                if short_stint || is_half_day_timeout(&time_out_iso)? {
                    return Ok(DtrRowKind::AfternoonFragment);
                }
                return Ok(DtrRowKind::HalfDayPm);
            }
            if short_stint {
                return Ok(DtrRowKind::LunchSpanFragment);
            }
            if is_half_day_timeout(&time_out_iso)? {
                return Ok(DtrRowKind::HalfDay);
            }
            Ok(DtrRowKind::FullDay)
        }
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
/// B:C white and paints the empty remainder D:E red; half-day-pm paints
/// the empty morning B:C red and keeps D:E white; morning fragments
/// (actual stamps) white B:C and red D:E like half-day; afternoon
/// fragments white D:E and red B:C like half-day-pm; full-day whites
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
        DtrRowKind::HalfDayPm => vec![
            one(1, 3, DtrCellColor::Red),
            one(3, 5, DtrCellColor::White),
        ],
        DtrRowKind::MorningFragment => vec![
            one(1, 3, DtrCellColor::White),
            one(3, 5, DtrCellColor::Red),
        ],
        DtrRowKind::AfternoonFragment => vec![
            one(1, 3, DtrCellColor::Red),
            one(3, 5, DtrCellColor::White),
        ],
        // Lunch-spanning short stint: actual stamps at both ends (B, E
        // white), unknown lunch middle (C:D red).
        DtrRowKind::LunchSpanFragment => vec![
            one(1, 2, DtrCellColor::White),
            one(2, 4, DtrCellColor::Red),
            one(4, 5, DtrCellColor::White),
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
    // Single-character tokens (e.g. middle initials like "C" or "E") are not
    // distinctive name words and must never trigger a false-positive overlap.
    let meaningful_core: Vec<&String> = core.iter().filter(|t| t.len() > 1).collect();
    if meaningful_core.is_empty() {
        return true;
    }
    tab_titles.iter().any(|title| {
        if is_skippable_title(title) {
            return false;
        }
        split_tokens(title)
            .iter()
            .filter(|t| t.len() > 1)
            .any(|t| meaningful_core.contains(&t))
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
    // tab carries no month headers at all — exactly the previous behaviour,
    // now read off one return value instead of a second column-A scan.
    let (start, end) = match month_block_range(&rows, want_month) {
        MonthBlock::Range(start, end) => (start, end),
        MonthBlock::NoHeaders => (0, rows.len()),
        MonthBlock::NoMatch => {
            return Ok(DtrPlanOutcome::Unresolvable("no-month-block"));
        }
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
    // System-is-source-of-truth (owner decision 2026-09-12): any difference
    // from the DB-derived values is written; sheet cells are output, never
    // input. Manual sheet typing is wiped on the next sync for that day.
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

/// Clear one date's B:E cells after an admin attendance delete (values
/// emptied, row kept so the template grid survives; the absent sweep
/// repaints past weekdays red on the same pass). Missing tab/row or an
/// already-empty row is a silent no-op (`Ok(false)`); transport errors
/// propagate to retry. Never auto-creates a tab and never touches F/J.
pub async fn clear_dtr_row(
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
    let month: u32 = attendance_date
        .get(5..7)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| format!("invalid attendanceDate: {attendance_date}"))?;
    let roster = active_roster(state).await?;
    let meta = fetch_tab_meta(client, token, spreadsheet_id).await?;
    let titles = titles_of(&meta);
    let Some(tab) = resolve_user_tab(&titles, &user_id, &full_name, &roster) else {
        log::info!("dtr clear skip for {full_name} ({user_id}) on {attendance_date}: no tab");
        return Ok(false);
    };
    let Some(sheet_id) = sheet_id_for_tab(&meta, &tab) else {
        log::info!("dtr clear skip for {full_name} ({user_id}) on {attendance_date}: no tab id");
        return Ok(false);
    };
    let range = urlencoding::encode(&format!("{}!A:F", quote_tab(&tab))).into_owned();
    let tab_values = dtr_get_json(
        client,
        token,
        format!("https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{range}"),
    )
    .await?;
    let rows = rows_from_values(&tab_values);
    // Both absence arms keep the pre-existing skip: a clear never falls back
    // to the whole tab.
    let (start, end) = match month_block_range(&rows, month) {
        MonthBlock::Range(start, end) => (start, end),
        MonthBlock::NoHeaders | MonthBlock::NoMatch => {
            log::info!("dtr clear skip for {full_name} ({user_id}) on {attendance_date}: no month block");
            return Ok(false);
        }
    };
    let Some(idx) = find_date_row_in(&rows, &attendance_date, start, end)? else {
        log::info!("dtr clear skip for {full_name} ({user_id}) on {attendance_date}: no date row");
        return Ok(false);
    };
    let row_number = idx + 1;
    let existing = [
        rows[idx].get(1).cloned().unwrap_or_default(),
        rows[idx].get(2).cloned().unwrap_or_default(),
        rows[idx].get(3).cloned().unwrap_or_default(),
        rows[idx].get(4).cloned().unwrap_or_default(),
    ];
    if existing.iter().all(|c| c.is_empty()) {
        return Ok(false);
    }
    let range = urlencoding::encode(&format!("{}!B{}:E{}", quote_tab(&tab), row_number, row_number)).into_owned();
    let body = serde_json::json!({ "values": [["", "", "", ""]] });
    client
        .put(format!(
            "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{range}?valueInputOption=USER_ENTERED"
        ))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|_| GOOGLE_REQUEST_FAILED.to_string())?
        .error_for_status()
        .map(|_| ())
        .map_err(|_| GOOGLE_REQUEST_FAILED.to_string())?;
    // P1 rule: paint is cosmetic — log-only so a batchUpdate failure
    // after cleared values never fails the pass.
    let white = DtrFormatOp {
        sheet_id,
        start_row_1based: row_number,
        end_row_1based_excl: row_number + 1,
        start_col_0: 1,
        end_col_0_excl: 5,
        color: DtrCellColor::White,
    };
    if let Err(error) =
        paint_tab_formats(client, token, spreadsheet_id, sheet_id, &tab, vec![white]).await
    {
        log::warn!("dtr clear paint failed for {full_name} ({user_id}) on {attendance_date} (values cleared): {error}");
    }
    Ok(true)
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
            let now = chrono::Utc::now().to_rfc3339();
            note_dtr_pending(state, &user_id, &full_name, &now).await?;
            log::warn!("dtr unresolvable for {full_name} ({user_id}) on {attendance_date}: {reason}; noted in dtr_pending");
            Err(format!("{GOOGLE_REQUEST_FAILED}: Unresolvable({reason})"))
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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InternSyncDetail {
    pub user_id: String,
    pub full_name: String,
    pub tab: Option<String>,
    pub tab_created: bool,
    pub rows_synced: usize,
    pub status: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualSyncReport {
    pub success: bool,
    pub interns_checked: usize,
    pub tabs_created: Vec<String>,
    pub rows_synced: usize,
    pub details: Vec<InternSyncDetail>,
    pub errors: Vec<String>,
}

/// Manually synchronize active interns onto the human DTR Google Sheets.
///
/// For each intern (or a specific targeted intern):
/// 1. Checks if their tab exists; if missing, auto-creates it from the template.
/// 2. Backfills all attendance history from SQLite into their tab.
/// 3. Clears the intern from `dtr_pending` when completely synced.
pub async fn manual_sync_intern_dtr(
    state: &AppState,
    target_user_id: Option<&str>,
) -> Result<ManualSyncReport, String> {
    use sqlx::Row;
    if !is_dtr_sync_enabled(&state.db).await {
        return Err("Intern DTR sync is disabled on this device (Admin → Data → DTR sync toggle)".to_string());
    }
    let spreadsheet_id = crate::config::dtr_spreadsheet_id_resolved(&state.lan)
        .ok_or_else(|| "DTR spreadsheet ID is not configured".to_string())?;
    let path = state.lan.google_service_account_json_path.as_deref()
        .ok_or_else(|| "Google service account JSON path is not configured".to_string())?;
    let token = crate::services::sheets_sync::google_access_token(path)
        .await
        .map_err(|e| format!("Google Sheets auth failed: {e}"))?;
    let client = crate::services::sheets_sync::sheets_client();

    let mut meta = fetch_tab_meta(&client, &token, &spreadsheet_id).await?;
    let roster = active_roster(state).await?;

    let interns: Vec<(String, String)> = if let Some(target_id) = target_user_id {
        sqlx::query("SELECT user_id, full_name FROM users WHERE user_id = ? AND employee_type = 'INTERN' AND status = 'ACTIVE'")
            .bind(target_id)
            .fetch_all(&state.db)
            .await
            .map_err(|e| e.to_string())?
            .iter()
            .map(|r| (r.get("user_id"), r.get("full_name")))
            .collect()
    } else {
        sqlx::query("SELECT user_id, full_name FROM users WHERE employee_type = 'INTERN' AND status = 'ACTIVE' ORDER BY full_name ASC")
            .fetch_all(&state.db)
            .await
            .map_err(|e| e.to_string())?
            .iter()
            .map(|r| (r.get("user_id"), r.get("full_name")))
            .collect()
    };

    if interns.is_empty() {
        if let Some(target_id) = target_user_id {
            return Err(format!("Active intern {target_id} not found in database"));
        }
    }

    let mut tabs_created = Vec::new();
    let mut rows_synced = 0;
    let mut details = Vec::with_capacity(interns.len());
    let mut errors = Vec::new();

    for (user_id, full_name) in &interns {
        let mut tab_created = false;
        let tab_opt = match ensure_person_tab(
            state, &client, &token, &spreadsheet_id, &meta, user_id, full_name, &roster,
        )
        .await
        {
            Ok(Some((resolved_tab, _sheet_id, fresh_meta, created))) => {
                meta = fresh_meta;
                if created {
                    tab_created = true;
                    tabs_created.push(full_name.clone());
                }
                Some(resolved_tab)
            }
            Ok(None) => {
                // If ensure_person_tab returned None (e.g. initial collision edge-case),
                // manual sync explicitly provisions the tab using their roster name.
                if dtr_tab_name_valid(full_name) {
                    if let Some(template_id) = pick_template_sheet_id(&meta) {
                        match duplicate_template_tab(&client, &token, &spreadsheet_id, template_id, full_name).await {
                            Ok(Some(_)) => {
                                tab_created = true;
                                tabs_created.push(full_name.clone());
                                if let Ok(fresh_meta) = fetch_tab_meta(&client, &token, &spreadsheet_id).await {
                                    meta = fresh_meta;
                                }
                                let titles = titles_of(&meta);
                                resolve_user_tab(&titles, user_id, full_name, &roster)
                            }
                            Ok(None) => {
                                if let Ok(fresh_meta) = fetch_tab_meta(&client, &token, &spreadsheet_id).await {
                                    meta = fresh_meta;
                                }
                                let titles = titles_of(&meta);
                                resolve_user_tab(&titles, user_id, full_name, &roster)
                            }
                            Err(e) => {
                                errors.push(format!("{full_name}: Failed to duplicate template tab: {e}"));
                                None
                            }
                        }
                    } else {
                        errors.push(format!("{full_name}: Template tab not found in DTR spreadsheet"));
                        None
                    }
                } else {
                    errors.push(format!("{full_name}: Roster name is not a valid sheet tab title"));
                    None
                }
            }
            Err(e) => {
                errors.push(format!("{full_name}: {e}"));
                None
            }
        };

        let Some(tab) = tab_opt else {
            details.push(InternSyncDetail {
                user_id: user_id.clone(),
                full_name: full_name.clone(),
                tab: None,
                tab_created: false,
                rows_synced: 0,
                status: "MISSING_TAB".to_string(),
            });
            continue;
        };

        // Backfill history
        match backfill_user_history(
            state, &client, &token, &spreadsheet_id, user_id, full_name, &roster, &meta,
        )
        .await
        {
            Ok((wrote, complete)) => {
                rows_synced += wrote;
                if complete {
                    let _ = clear_dtr_pending(state, user_id).await;
                }
                details.push(InternSyncDetail {
                    user_id: user_id.clone(),
                    full_name: full_name.clone(),
                    tab: Some(tab),
                    tab_created,
                    rows_synced: wrote,
                    status: if tab_created {
                        "TAB_CREATED_AND_SYNCED".to_string()
                    } else if wrote > 0 {
                        "SYNCED".to_string()
                    } else {
                        "IN_SYNC".to_string()
                    },
                });
            }
            Err(e) => {
                errors.push(format!("{full_name}: Backfill failed: {e}"));
                details.push(InternSyncDetail {
                    user_id: user_id.clone(),
                    full_name: full_name.clone(),
                    tab: Some(tab),
                    tab_created,
                    rows_synced: 0,
                    status: "BACKFILL_FAILED".to_string(),
                });
            }
        }
    }

    Ok(ManualSyncReport {
        success: true,
        interns_checked: interns.len(),
        tabs_created,
        rows_synced,
        details,
        errors,
    })
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


    #[tokio::test]
    async fn dtr_sync_toggle_defaults_on_and_persists() {
        // Takes the env-test guard too: env-mutating tests in this process can
        // otherwise flip `is_dtr_sync_enabled` mid-assert (same class as the
        // DTR_SHEET_ID leak the shared guard exists for).
        let _env_guard = crate::config::dtr_env_test_guard();
        let db = sqlx::SqlitePool::connect(":memory:").await.unwrap();
        assert!(is_dtr_sync_enabled(&db).await);
        set_dtr_sync_enabled(&db, false).await.unwrap();
        assert!(!is_dtr_sync_enabled(&db).await);
        set_dtr_sync_enabled(&db, true).await.unwrap();
        assert!(is_dtr_sync_enabled(&db).await);
    }

    #[tokio::test]
    async fn dtr_sync_env_override_wins_over_stored_row() {
        // N11: the env override is layered over the DB row, so a set(true) followed
        // by a read can legitimately return false — which is exactly why the command
        // must report the effective value, not the requested one.
        let _env_guard = crate::config::dtr_env_test_guard();
        let db = sqlx::SqlitePool::connect(":memory:").await.unwrap();
        set_dtr_sync_enabled(&db, true).await.unwrap();
        std::env::set_var(ENV_DTR_SYNC_ENABLED, "0");
        let effective_while_overridden = is_dtr_sync_enabled(&db).await;
        // Drop the override BEFORE asserting, so a failure cannot leak it into
        // other tests sharing this process.
        std::env::remove_var(ENV_DTR_SYNC_ENABLED);
        assert!(!effective_while_overridden);
        assert!(is_dtr_sync_enabled(&db).await);
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
        assert_eq!(month_block_range(&rows, 9), MonthBlock::Range(4, 7));
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
        // DTR SOURCE OF TRUTH: working (no time-out) renders actuals only,
        // never the fixed-lunch pair.
        assert_eq!(
            build_dtr_row(
                Some("2026-09-05T09:46:23+08:00"),
                None,
                "2026-09-05"
            ),
            Ok([
                "9:46:23 AM".to_string(),
                String::new(),
                String::new(),
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
    fn half_day_timeout_renders_actual_stamps() {
        // DTR/PAYROLL DECOUPLING: 08:04-15:00 is payroll half-day (out <
        // 17:00) but the DTR row keeps the actual stamps at both ends.
        assert_eq!(
            build_dtr_row(
                Some("2026-09-05T08:04:00+08:00"),
                Some("2026-09-05T15:00:00+08:00"),
                "2026-09-05"
            ),
            Ok([
                "8:04:00 AM".to_string(),
                String::new(),
                String::new(),
                "3:00:00 PM".to_string()
            ])
        );
    }

    #[test]
    fn dtr_row_is_identical_across_payroll_cutoff_boundary() {
        // GUARDRAIL: DTR output is identical regardless of payroll
        // classification (half-day <17:00 vs full-day >=17:00).
        let tin = Some("2026-09-05T08:00:00+08:00");
        for tout in [
            "2026-09-05T16:58:59+08:00",
            "2026-09-05T16:59:00+08:00",
            "2026-09-05T17:00:00+08:00",
        ] {
            let row = build_dtr_row(tin, Some(tout), "2026-09-05").unwrap();
            assert_eq!(row[0], "8:00:00 AM".to_string());
            assert_eq!(row[1], String::new());
            assert_eq!(row[2], String::new());
        }
        assert_eq!(
            build_dtr_row(tin, Some("2026-09-05T16:59:00+08:00"), "2026-09-05").unwrap()[3],
            "4:59:00 PM"
        );
        assert_eq!(
            build_dtr_row(tin, Some("2026-09-05T17:00:00+08:00"), "2026-09-05").unwrap()[3],
            "5:00:00 PM"
        );
    }

    #[test]
    fn afternoon_arrival_renders_afternoon_only() {
        // Actual 12:00 in-stamp (never the fixed 1PM convention).
        assert_eq!(
            build_dtr_row(
                Some("2026-09-05T12:00:00+08:00"),
                Some("2026-09-05T17:00:00+08:00"),
                "2026-09-05"
            )
            .unwrap(),
            [
                String::new(),
                String::new(),
                "12:00:00 PM".to_string(),
                "5:00:00 PM".to_string()
            ]
        );
        assert_eq!(
            classify_record_row(
                Some("2026-09-05T12:00:00+08:00"),
                Some("2026-09-05T17:00:00+08:00")
            ),
            Ok(DtrRowKind::HalfDayPm)
        );
        let ops = plan_row_format(7, 107, DtrRowKind::HalfDayPm);
        assert_eq!(ops.len(), 2);
        assert_eq!(ops[0].start_col_0, 1);
        assert_eq!(ops[0].color, DtrCellColor::Red);
        assert_eq!(ops[1].color, DtrCellColor::White);
    }

    #[test]
    fn working_to_completed_rewrite_carries_actual_out() {
        // WORKING row holds the in-stamp only…
        let working =
            build_dtr_row(Some("2026-09-05T08:00:00+08:00"), None, "2026-09-05").unwrap();
        assert_eq!(
            working,
            [
                "8:00:00 AM".to_string(),
                String::new(),
                String::new(),
                String::new()
            ]
        );
        // …and completion fills the actual out-stamp, so skip-identical
        // (which compares all four) issues the rewrite.
        let done = build_dtr_row(
            Some("2026-09-05T08:00:00+08:00"),
            Some("2026-09-05T12:30:00+08:00"),
            "2026-09-05"
        )
        .unwrap();
        assert_ne!(working, done);
        // 12:30 out is before 13:00 → morning pair [in, out, '', ''].
        assert_eq!(done[1], "12:30:00 PM".to_string());
    }

    #[test]
    fn eight_to_three_keeps_actuals_while_payroll_is_half_day() {
        // The reported case: 08:00-15:00 renders actual stamps on the DTR…
        let row = build_dtr_row(
            Some("2026-09-05T08:00:00+08:00"),
            Some("2026-09-05T15:00:00+08:00"),
            "2026-09-05",
        )
        .unwrap();
        assert_eq!(
            row,
            [
                "8:00:00 AM".to_string(),
                String::new(),
                String::new(),
                "3:00:00 PM".to_string()
            ]
        );
        // …while payroll classifies the same punches as half-day with an
        // effective 08:00-12:00 pay window (pay math only, never DTR).
        let pay = crate::services::intern_payroll::calculate(
            "2026-09-05",
            "2026-09-05T08:00:00+08:00",
            "2026-09-05T15:00:00+08:00",
            true,
        )
        .unwrap();
        assert!(pay.is_half_day);
        assert_eq!(pay.half_day_deduction_centavos, 4000);
        assert_eq!(pay.daily_pay_centavos, 4000);
        assert!(pay.computed_time_out.contains("T12:00:00+08:00"));
    }

    #[test]
    fn eight_to_five_is_full_day_with_actuals() {
        let row = build_dtr_row(
            Some("2026-09-05T08:00:00+08:00"),
            Some("2026-09-05T17:00:00+08:00"),
            "2026-09-05",
        )
        .unwrap();
        assert_eq!(row[0], "8:00:00 AM".to_string());
        assert_eq!(row[3], "5:00:00 PM".to_string());
        let pay = crate::services::intern_payroll::calculate(
            "2026-09-05",
            "2026-09-05T08:00:00+08:00",
            "2026-09-05T17:00:00+08:00",
            true,
        )
        .unwrap();
        assert!(!pay.is_half_day);
        assert_eq!(pay.daily_pay_centavos, 8000);
    }

    #[test]
    fn late_timeout_caps_to_five_pm() {
        // Overtime forbidden: 08:00-19:30 renders 5:00 PM, classified full.
        let row = build_dtr_row(
            Some("2026-09-05T08:00:00+08:00"),
            Some("2026-09-05T19:30:00+08:00"),
            "2026-09-05",
        )
        .unwrap();
        assert_eq!(
            row,
            [
                "8:00:00 AM".to_string(),
                String::new(),
                String::new(),
                "5:00:00 PM".to_string()
            ]
        );
        assert_eq!(
            classify_record_row(
                Some("2026-09-05T08:00:00+08:00"),
                Some("2026-09-05T19:30:00+08:00")
            ),
            Ok(DtrRowKind::FullDay)
        );
        // Boundary: 18:00:00 caps, 17:59:59 stays actual.
        assert_eq!(
            build_dtr_row(
                Some("2026-09-05T08:00:00+08:00"),
                Some("2026-09-05T18:00:00+08:00"),
                "2026-09-05",
            )
            .unwrap()[3],
            "5:00:00 PM"
        );
        assert_eq!(
            build_dtr_row(
                Some("2026-09-05T08:00:00+08:00"),
                Some("2026-09-05T17:59:59+08:00"),
                "2026-09-05",
            )
            .unwrap()[3],
            "5:59:59 PM"
        );
        // DTR+payroll consistent: capped shift pays full-day at 17:00.
        let pay = crate::services::intern_payroll::calculate(
            "2026-09-05",
            "2026-09-05T08:00:00+08:00",
            "2026-09-05T19:30:00+08:00",
            true,
        )
        .unwrap();
        assert!(!pay.is_half_day);
        assert_eq!(pay.daily_pay_centavos, 8000);
        assert!(pay.computed_time_out.contains("T17:00:00+08:00"));
    }

    #[test]
    fn sub_four_hour_shift_keeps_actuals_and_half_day_pay() {
        let row = build_dtr_row(
            Some("2026-09-05T08:00:00+08:00"),
            Some("2026-09-05T10:30:00+08:00"),
            "2026-09-05",
        )
        .unwrap();
        assert_eq!(row[0], "8:00:00 AM".to_string());
        assert_eq!(row[1], "10:30:00 AM".to_string());
        let pay = crate::services::intern_payroll::calculate(
            "2026-09-05",
            "2026-09-05T08:00:00+08:00",
            "2026-09-05T10:30:00+08:00",
            true,
        )
        .unwrap();
        assert!(pay.is_half_day);
    }

    #[test]
    fn afternoon_arrival_keeps_actual_in_with_half_day_pay() {
        let row = build_dtr_row(
            Some("2026-09-05T12:30:00+08:00"),
            Some("2026-09-05T17:00:00+08:00"),
            "2026-09-05",
        )
        .unwrap();
        assert_eq!(
            row,
            [
                String::new(),
                String::new(),
                "12:30:00 PM".to_string(),
                "5:00:00 PM".to_string()
            ]
        );
        let pay = crate::services::intern_payroll::calculate(
            "2026-09-05",
            "2026-09-05T12:30:00+08:00",
            "2026-09-05T17:00:00+08:00",
            false,
        )
        .unwrap();
        assert!(pay.is_half_day);
        // Late deduction also applies (12:30 vs 08:00 start), so only assert
        // the half-day flag + deduction, not the floored net pay.
        assert_eq!(pay.half_day_deduction_centavos, 4000);
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
        assert_eq!(month_block_range(&rows, 9), MonthBlock::Range(1, 3));
        assert_eq!(find_date_row_in(&rows, "2026-09-05", 1, 3), Ok(Some(1)));
        assert_eq!(month_block_range(&rows, 10), MonthBlock::Range(4, 7));
        assert_eq!(find_date_row_in(&rows, "2026-10-05", 4, 7), Ok(Some(5)));
    }

    #[test]
    fn month_block_range_names_absence_per_arm() {
        // No month header anywhere in column A -> NoHeaders.
        let bare = vec![vec!["9/5/2026".to_string()], vec!["TOTAL HOURS".to_string()]];
        assert_eq!(month_block_range(&bare, 9), MonthBlock::NoHeaders);
        // Headers exist but none matches -> NoMatch.
        let headed = vec![
            vec!["DATE-October".to_string()],
            vec!["10/5/2026".to_string()],
            vec!["TOTAL HOURS".to_string()],
        ];
        assert_eq!(month_block_range(&headed, 9), MonthBlock::NoMatch);
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
    fn cap_before_ordering_rejects_inverted_pair_in_both_paths() {
        // AUDIT A1: 18:00 caps to 17:00, which precedes the 17:30 time-in.
        // Both consumers must fail closed with the same error instead of
        // build_dtr_row rendering an end stamp earlier than the start.
        let expected = "Time-out cannot be earlier than time-in: \
                       2026-09-05T18:00:00+08:00 < 2026-09-05T17:30:00+08:00";
        assert_eq!(
            build_dtr_row(
                Some("2026-09-05T17:30:00+08:00"),
                Some("2026-09-05T18:00:00+08:00"),
                "2026-09-05"
            ),
            Err(expected.to_string())
        );
        assert_eq!(
            classify_record_row(
                Some("2026-09-05T17:30:00+08:00"),
                Some("2026-09-05T18:00:00+08:00")
            ),
            Err(expected.to_string())
        );
    }

    #[test]
    fn completed_record_cap_and_ordering_agree_across_paths() {
        // Regression: 19:30 caps to 17:00 (>= 08:00 in), so the pair is
        // valid in both consumers.
        assert_eq!(
            build_dtr_row(
                Some("2026-09-05T08:00:00+08:00"),
                Some("2026-09-05T19:30:00+08:00"),
                "2026-09-05"
            ),
            Ok([
                "8:00:00 AM".to_string(),
                String::new(),
                String::new(),
                "5:00:00 PM".to_string()
            ])
        );
        assert_eq!(
            classify_record_row(
                Some("2026-09-05T08:00:00+08:00"),
                Some("2026-09-05T19:30:00+08:00")
            ),
            Ok(DtrRowKind::FullDay)
        );
    }

    #[test]
    fn blank_and_missing_stamps_keep_existing_outputs() {
        let blank_row = Ok([String::new(), String::new(), String::new(), String::new()]);
        assert_eq!(build_dtr_row(None, None, "2026-09-05"), blank_row);
        assert_eq!(build_dtr_row(Some("   "), None, "2026-09-05"), blank_row);
        // Blank time-in is Empty regardless of a present time-out.
        assert_eq!(
            build_dtr_row(Some(""), Some("2026-09-05T17:00:00+08:00"), "2026-09-05"),
            blank_row
        );
        assert_eq!(classify_record_row(None, None), Ok(DtrRowKind::Absent));
        assert_eq!(
            classify_record_row(Some("   "), Some("2026-09-05T17:00:00+08:00")),
            Ok(DtrRowKind::Absent)
        );
        // Blank/whitespace time-out is Working.
        assert_eq!(
            build_dtr_row(Some("2026-09-05T09:00:00+08:00"), Some("  "), "2026-09-05"),
            Ok([
                "9:00:00 AM".to_string(),
                String::new(),
                String::new(),
                String::new()
            ])
        );
        assert_eq!(
            classify_record_row(Some("2026-09-05T09:00:00+08:00"), None),
            Ok(DtrRowKind::Working)
        );
        assert_eq!(
            classify_record_row(Some("2026-09-05T09:00:00+08:00"), Some("")),
            Ok(DtrRowKind::Working)
        );
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
        // Single-character tokens (e.g. middle initials like "C.") do not trigger false-positive overlap.
        let titles_with_initial = vec!["Raineer C. Rosado".to_string()];
        assert!(!tab_name_overlaps_user(&titles_with_initial, "Maricon C. Danao"));
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
        // P1: 09:30:00Z is 17:30 Manila → actual stamps at both ends (was
        // misclassified when the raw UTC hour was compared).
        let full = build_dtr_row(
            Some("2026-09-05T01:00:00Z"),
            Some("2026-09-05T09:30:00Z"),
            "2026-09-05",
        )
        .unwrap();
        assert_eq!(full[0], "9:00:00 AM");
        assert_eq!(full[1], String::new());
        assert_eq!(full[2], String::new());
        assert_eq!(full[3], "5:30:00 PM");
        // 08:30:00Z is 16:30 Manila → actual stamps (payroll half-day does
        // not alter the DTR row).
        let half = build_dtr_row(
            Some("2026-09-05T00:04:00Z"),
            Some("2026-09-05T08:30:00Z"),
            "2026-09-05",
        )
        .unwrap();
        assert_eq!(half[0], "8:04:00 AM");
        assert_eq!(half[1], String::new());
        assert_eq!(half[2], String::new());
        assert_eq!(half[3], "4:30:00 PM");
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
    fn fragment_rows_render_actual_stamps() {
        // minutes-long morning stint: actual times, never fixed 12PM.
        assert_eq!(
            build_dtr_row(
                Some("2026-09-05T11:06:00+08:00"),
                Some("2026-09-05T11:10:00+08:00"),
                "2026-09-05"
            ),
            Ok([
                "11:06:00 AM".to_string(),
                "11:10:00 AM".to_string(),
                String::new(),
                String::new()
            ])
        );
        // Afternoon-only fragment: actual stamps in D:E.
        assert_eq!(
            build_dtr_row(
                Some("2026-09-05T14:00:00+08:00"),
                Some("2026-09-05T16:00:00+08:00"),
                "2026-09-05"
            ),
            Ok([
                String::new(),
                String::new(),
                "2:00:00 PM".to_string(),
                "4:00:00 PM".to_string()
            ])
        );
        let ops = plan_row_format(7, 107, DtrRowKind::MorningFragment);
        assert_eq!(ops.len(), 2);
        assert_eq!((ops[0].start_col_0, ops[0].end_col_0_excl), (1, 3));
        assert_eq!(ops[0].color, DtrCellColor::White);
        assert_eq!((ops[1].start_col_0, ops[1].end_col_0_excl), (3, 5));
        assert_eq!(ops[1].color, DtrCellColor::Red);
        let ops = plan_row_format(7, 107, DtrRowKind::AfternoonFragment);
        assert_eq!(ops.len(), 2);
        assert_eq!((ops[0].start_col_0, ops[0].end_col_0_excl), (1, 3));
        assert_eq!(ops[0].color, DtrCellColor::Red);
        assert_eq!((ops[1].start_col_0, ops[1].end_col_0_excl), (3, 5));
        assert_eq!(ops[1].color, DtrCellColor::White);
        // Sub-4h lunch-spanning stint: actual stamps at both ends.
        assert_eq!(
            build_dtr_row(
                Some("2026-09-05T11:30:00+08:00"),
                Some("2026-09-05T14:30:00+08:00"),
                "2026-09-05"
            ),
            Ok([
                "11:30:00 AM".to_string(),
                String::new(),
                String::new(),
                "2:30:00 PM".to_string()
            ])
        );
        assert_eq!(
            classify_record_row(
                Some("2026-09-05T11:30:00+08:00"),
                Some("2026-09-05T14:30:00+08:00")
            ),
            Ok(DtrRowKind::LunchSpanFragment)
        );
        // 4h+ morning span closing early: actual stamps (payroll half-day
        // does not alter the DTR row).
        assert_eq!(
            build_dtr_row(
                Some("2026-09-05T08:00:00+08:00"),
                Some("2026-09-05T15:00:00+08:00"),
                "2026-09-05"
            ),
            Ok([
                "8:00:00 AM".to_string(),
                String::new(),
                String::new(),
                "3:00:00 PM".to_string()
            ])
        );
        let ops = plan_row_format(7, 107, DtrRowKind::LunchSpanFragment);
        assert_eq!(ops.len(), 3);
        assert_eq!((ops[0].start_col_0, ops[0].end_col_0_excl), (1, 2));
        assert_eq!(ops[0].color, DtrCellColor::White);
        assert_eq!((ops[1].start_col_0, ops[1].end_col_0_excl), (2, 4));
        assert_eq!(ops[1].color, DtrCellColor::Red);
        assert_eq!((ops[2].start_col_0, ops[2].end_col_0_excl), (4, 5));
        assert_eq!(ops[2].color, DtrCellColor::White);
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
            Ok(DtrRowKind::MorningFragment)
        );
        // Classic half-day: morning clock-in, afternoon-early time-out.
        assert_eq!(
            classify_record_row(
                Some("2026-09-05T08:00:00+08:00"),
                Some("2026-09-05T15:00:00+08:00")
            ),
            Ok(DtrRowKind::HalfDay)
        );
        // Afternoon-only fragment: clock-in at/after noon, early out.
        assert_eq!(
            classify_record_row(
                Some("2026-09-05T14:00:00+08:00"),
                Some("2026-09-05T16:00:00+08:00")
            ),
            Ok(DtrRowKind::AfternoonFragment)
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
