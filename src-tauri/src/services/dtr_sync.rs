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
    GOOGLE_AUTH_FAILED, GOOGLE_DAILY_LIMIT, GOOGLE_NOT_FOUND, GOOGLE_PERMISSION_DENIED,
    GOOGLE_RATE_LIMITED, GOOGLE_REQUEST_FAILED, GOOGLE_SERVER_ERROR, PER_CALL_MAX_ATTEMPTS,
    classify_403_body, parse_retry_after_secs, per_call_budget_actual, per_call_should_retry,
    per_call_sleep_ms,
};
use crate::services::sync_retry::{DtrThrottleBucket, split_dtr_batch};
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

/// Pre-tokenized tab + roster snapshot for one resolve run. Tab titles and
/// roster names are tokenized ONCE here instead of once per candidate ×
/// roster comparison inside the match loops. Pure memo: every field
/// derives from `split_tokens` / `is_skippable_title`, so results are
/// identical to the uncached path. Never shared across a tab mutation —
/// rebuild after any `fetch_tab_meta` / duplicate refresh.
struct DtrMatchIndex {
    tabs: Vec<DtrTabEntry>,
    roster: Vec<DtrRosterEntry>,
}

struct DtrTabEntry {
    title: String,
    toks: Vec<String>,
    skippable: bool,
}

struct DtrRosterEntry {
    id: String,
    toks: Vec<String>,
}

impl DtrMatchIndex {
    fn build(tab_titles: &[String], all_users: &[(String, String)]) -> Self {
        Self {
            tabs: tab_titles
                .iter()
                .map(|title| {
                    let toks = split_tokens(title);
                    DtrTabEntry {
                        skippable: is_skippable_title(title),
                        title: title.clone(),
                        toks,
                    }
                })
                .collect(),
            roster: all_users
                .iter()
                .map(|(id, name)| DtrRosterEntry {
                    id: id.clone(),
                    toks: split_tokens(name),
                })
                .collect(),
        }
    }

    /// Indexed resolve: same semantics as `resolve_user_tab` — the target
    /// name is still tokenized fresh per call (the pending table can hold
    /// a stale spelling), only tabs + other roster names come from cache.
    fn resolve(&self, user_id: &str, full_name: &str) -> Option<String> {
        let user_toks = split_tokens(full_name);
        // Suffix-stripped core drives last-token and coverage; a name that
        // is nothing but suffixes cannot resolve.
        let core_toks: Vec<String> = strip_name_suffix(&user_toks).to_vec();
        let last = core_toks.last()?.clone();
        let mut candidates: Vec<String> = Vec::new();
        for tab in &self.tabs {
            if tab.skippable {
                continue;
            }
            if tab.toks.len() == 1 {
                if !user_toks.contains(&tab.toks[0]) {
                    continue;
                }
                let collides = self
                    .roster
                    .iter()
                    .any(|other| other.id != user_id && other.toks.contains(&tab.toks[0]));
                if collides {
                    return None;
                }
                candidates.push(tab.title.clone());
                continue;
            }
            if !tab.toks.contains(&last) {
                continue;
            }
            if !tab_covered_by_user(&tab.toks, &core_toks) {
                continue;
            }
            let collides = self.roster.iter().any(|other| {
                if other.id == user_id {
                    return false;
                }
                tab_covered_by_user(&tab.toks, strip_name_suffix(&other.toks))
            });
            if collides {
                return None;
            }
            candidates.push(tab.title.clone());
        }
        if candidates.len() == 1 {
            candidates.into_iter().next()
        } else {
            None
        }
    }

    /// Indexed overlap: same semantics as `tab_name_overlaps_user`.
    fn overlaps(&self, full_name: &str) -> bool {
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
        self.tabs.iter().any(|tab| {
            if tab.skippable {
                return false;
            }
            tab.toks
                .iter()
                .filter(|t| t.len() > 1)
                .any(|t| meaningful_core.contains(&t))
        })
    }
}

/// Resolve the DTR tab for one roster user. Returns the tab title on a
/// unique match, `None` on AMBIGUOUS / NO_MATCH / SKIP (caller skips).
pub fn resolve_user_tab(
    tab_titles: &[String],
    user_id: &str,
    full_name: &str,
    all_users: &[(String, String)],
) -> Option<String> {
    DtrMatchIndex::build(tab_titles, all_users).resolve(user_id, full_name)
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
            Ok([
                started,
                DTR_LUNCH_OUT.to_string(),
                DTR_LUNCH_IN.to_string(),
                String::new(),
            ])
        }
        NormalizedRecord::Completed {
            time_in,
            time_out_iso,
            ..
        } => {
            let tin_iso = time_in.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
            let started = format_sheet_time(&tin_iso)?;
            let ended = format_sheet_time(&time_out_iso)?;
            // Actual-stamps grouped by morning/afternoon columns:
            // out before 13:00 -> morning pair only
            if is_before_lunch_out(&time_out_iso)? {
                return Ok([started, ended, String::new(), String::new()]);
            }
            // in at/after noon -> afternoon pair only
            if is_afternoon_arrival(&tin_iso)? {
                return Ok([String::new(), String::new(), started, ended]);
            }
            // shift crosses lunch -> populate standard lunch out/in
            Ok([
                started,
                DTR_LUNCH_OUT.to_string(),
                DTR_LUNCH_IN.to_string(),
                ended,
            ])
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
        DtrRowKind::HalfDay => vec![one(1, 5, DtrCellColor::White)],
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
/// Determine the effective start date for absent sweeping directly from tab content.
///
/// Tab month headers and punch history represent the true internship period,
/// whereas local DB `created_at` timestamps only record when the local SQLite
/// row or RFID card was enrolled.
/// - If the tab begins with JUNE: effective start is the earliest punch on the tab
///   (e.g. 2026-06-26 or 2026-06-29), protecting pre-enrollment days (June 1-25)
///   while allowing July and August absences to paint.
/// - If the tab begins with AUGUST: effective start is 2026-08-01 (Aug 3 first working day).
/// - If the tab begins with SEPTEMBER: effective start is 2026-09-01.
pub fn get_sheet_effective_start_date(rows: &[Vec<String>]) -> Option<NaiveDate> {
    let mut first_month: Option<u32> = None;
    let mut earliest_punch: Option<NaiveDate> = None;

    for row in rows {
        let cell = row.first().map(String::as_str).unwrap_or("");
        if first_month.is_none() {
            if let Some(m) = parse_month_header(cell) {
                first_month = Some(m);
            }
        }
        if let Some(parts) = parse_sheet_date(cell) {
            if let Some(d) = NaiveDate::from_ymd_opt(parts.y, parts.m, parts.d) {
                let has_punch = row.iter().skip(1).take(4).any(|c| !c.trim().is_empty());
                if has_punch && (earliest_punch.is_none() || Some(d) < earliest_punch) {
                    earliest_punch = Some(d);
                }
            }
        }
    }

    match first_month {
        Some(6) => earliest_punch.or_else(|| NaiveDate::from_ymd_opt(2026, 6, 29)),
        Some(m) => {
            let month_start = NaiveDate::from_ymd_opt(2026, m, 1);
            match (earliest_punch, month_start) {
                (Some(p), Some(ms)) => Some(if p < ms { p } else { ms }),
                (Some(p), None) => Some(p),
                (None, Some(ms)) => Some(ms),
                (None, None) => None,
            }
        }
        None => earliest_punch,
    }
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
    start_ymd: Option<&str>,
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
    let start_date = start_ymd
        .and_then(|s| parse_ymd(s).ok().and_then(|p| NaiveDate::from_ymd_opt(p.y, p.m, p.d)))
        .or_else(|| get_sheet_effective_start_date(rows));
    let mut runs: Vec<(usize, usize)> = Vec::new();
    for (i, row) in rows.iter().enumerate() {
        let cell = row.first().map(String::as_str).unwrap_or("");
        let Some(parts) = parse_sheet_date(cell) else {
            continue;
        };
        let Some(date) = NaiveDate::from_ymd_opt(parts.y, parts.m, parts.d) else {
            continue;
        };
        if let Some(start) = start_date {
            if date < start {
                continue;
            }
        }
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

fn dtr_retry_after_secs(response: &reqwest::Response) -> Option<u64> {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_retry_after_secs)
}

/// Sleeps at most the remaining 19.5s budget; returns the new slept total.
async fn sleep_within_budget(already_slept_ms: u64, want_ms: u64) -> u64 {
    let actual_ms = per_call_budget_actual(already_slept_ms, want_ms);
    if actual_ms > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(actual_ms)).await;
    }
    already_slept_ms.saturating_add(actual_ms)
}

/// Runs one Google call with the shared bound above. Returns the last
/// response (success, non-retryable, or attempts exhausted) so the caller maps
/// it to the transient code; transport exhaustion returns the generic code.
async fn dtr_call_with_retry(
    build: impl Fn() -> reqwest::RequestBuilder,
) -> Result<reqwest::Response, String> {
    let mut slept_ms: u64 = 0;
    let mut attempt: u32 = 0;
    loop {
        match build().send().await {
            Ok(response) => {
                let status = response.status();
                if status.is_success() || !per_call_should_retry(status.as_u16(), attempt) {
                    return Ok(response);
                }
                let retry_after = dtr_retry_after_secs(&response);
                drop(response);
                slept_ms =
                    sleep_within_budget(slept_ms, per_call_sleep_ms(attempt, retry_after)).await;
                attempt += 1;
            }
            Err(_) => {
                if attempt + 1 >= PER_CALL_MAX_ATTEMPTS {
                    return Err(GOOGLE_REQUEST_FAILED.to_string());
                }
                slept_ms =
                    sleep_within_budget(slept_ms, per_call_sleep_ms(attempt, None)).await;
                attempt += 1;
            }
        }
    }
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
    let url = format!("https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}:batchUpdate");
    let body = build_format_requests(ops);
    let response = dtr_call_with_retry(|| {
        client.post(&url).bearer_auth(token).json(&body)
    })
    .await?;
    let status = response.status();
    if status.is_success() {
        return Ok(true);
    }
    Err(dtr_error_for_response(response).await)
}

/// Paint format ops using already-fetched `rows` without an extra network GET.
async fn paint_tab_formats_with_rows(
    client: &reqwest::Client,
    token: &str,
    spreadsheet_id: &str,
    sheet_id: i64,
    rows: &[Vec<String>],
    mut ops: Vec<DtrFormatOp>,
    start_ymd: Option<&str>,
) -> Result<bool, String> {
    let today = manila_today_ymd();
    ops.extend(plan_absent_sweep(sheet_id, rows, start_ymd, &today));
    execute_format_ops(client, token, spreadsheet_id, &ops).await
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
    ops: Vec<DtrFormatOp>,
    start_ymd: Option<&str>,
) -> Result<bool, String> {
    let range = urlencoding::encode(&format!("{}!A:F", quote_tab(tab))).into_owned();
    let tab_values = dtr_get_json(
        client,
        token,
        format!("https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{range}"),
    )
    .await?;
    let rows = rows_from_values(&tab_values);
    paint_tab_formats_with_rows(client, token, spreadsheet_id, sheet_id, &rows, ops, start_ymd).await
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
        code if (500..=599).contains(&code) => GOOGLE_SERVER_ERROR,
        _ => GOOGLE_REQUEST_FAILED,
    }
}

/// 403-aware mapper sharing the Sheets reason classifier: rate/quota 403s
/// route transient-forever, daily-limit 403s keep their finite DAILY code.
fn dtr_status_error_with_body(status: reqwest::StatusCode, body: &str) -> String {
    if status.as_u16() == 403 {
        let mapped = classify_403_body(body);
        if mapped.contains(GOOGLE_DAILY_LIMIT) {
            log::warn!("DTR push hit Google daily quota (operator action required; ~24h block)");
        }
        return mapped;
    }
    dtr_status_error(status).to_string()
}

/// Maps a failed DTR response to its queue error string, consuming the
/// body only on 403 (the one status whose reason changes the verdict).
async fn dtr_error_for_response(response: reqwest::Response) -> String {
    let status = response.status();
    if status.as_u16() == 403 {
        let body = response.text().await.unwrap_or_default();
        return dtr_status_error_with_body(status, &body);
    }
    dtr_status_error(status).to_string()
}

async fn dtr_get_json(
    client: &reqwest::Client,
    token: &str,
    url: String,
) -> Result<serde_json::Value, String> {
    let response = dtr_call_with_retry(|| client.get(&url).bearer_auth(token)).await?;
    let status = response.status();
    if status.is_success() {
        return response
            .json()
            .await
            .map_err(|_| GOOGLE_REQUEST_FAILED.to_string());
    }
    Err(dtr_error_for_response(response).await)
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
// Test-only wrapper: production paths resolve through `DtrMatchIndex`
// (built per run, rebuilt after tab mutations); unit tests pin this name.
#[allow(dead_code)]
fn tab_name_overlaps_user(tab_titles: &[String], full_name: &str) -> bool {
    DtrMatchIndex::build(tab_titles, &[]).overlaps(full_name)
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
        return Err(dtr_status_error_with_body(status, &body));
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
    let index = DtrMatchIndex::build(&titles, roster);
    if let Some(tab) = index.resolve(user_id, full_name) {
        let Some(sheet_id) = sheet_id_for_tab(meta, &tab) else {
            return Err(format!("DTR tab id missing for resolved tab {tab}"));
        };
        return Ok(Some((tab, sheet_id, meta.to_vec(), false)));
    }
    if index.overlaps(full_name) {
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
    match DtrMatchIndex::build(&titles, roster).resolve(user_id, full_name) {
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
pub(crate) enum DtrPlanOutcome {
    Write(DtrPushPlan),
    InSync { row_1based: usize },
    Unresolvable(&'static str),
}

/// Plan one attendance day against a known title list. `Err` = corrupt
/// or unreachable state (queue retries, then DEAD). Tab resolution
/// happens in the caller so a miss can be recorded in `dtr_pending`
/// instead of vanishing.
/// Pure in-memory plan of an attendance day against a pre-fetched `rows` grid.
pub fn plan_dtr_push_in_rows(
    tab: &str,
    rows: &[Vec<String>],
    attendance_date: &str,
    time_in: Option<&str>,
    time_out: Option<&str>,
) -> Result<DtrPlanOutcome, String> {
    let values = build_dtr_row(time_in, time_out, attendance_date)?;
    if values.iter().all(String::is_empty) {
        return Ok(DtrPlanOutcome::Unresolvable("empty-values"));
    }
    let want_month: u32 = attendance_date
        .get(5..7)
        .and_then(|m| m.parse::<u32>().ok())
        .filter(|m| (1..=12).contains(m))
        .ok_or_else(|| format!("attendanceDate must be YYYY-MM-DD, got {attendance_date}"))?;
    let (start, end) = match month_block_range(rows, want_month) {
        MonthBlock::Range(start, end) => (start, end),
        MonthBlock::NoHeaders => (0, rows.len()),
        MonthBlock::NoMatch => {
            return Ok(DtrPlanOutcome::Unresolvable("no-month-block"));
        }
    };
    let Some(idx) = find_date_row_in(rows, attendance_date, start, end)? else {
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
        tab: tab.to_string(),
        row_1based: idx + 1,
        values,
    }))
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
    let Some(tab) = DtrMatchIndex::build(titles, all_users).resolve(user_id, full_name) else {
        return Ok(DtrPlanOutcome::Unresolvable("no-tab"));
    };
    let range = urlencoding::encode(&format!("{}!A:F", quote_tab(&tab))).into_owned();
    let tab_values = dtr_get_json(
        client,
        token,
        format!("https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{range}"),
    )
    .await?;
    let rows = rows_from_values(&tab_values);
    plan_dtr_push_in_rows(&tab, &rows, attendance_date, time_in, time_out)
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
    let url = format!(
        "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{range}?valueInputOption=USER_ENTERED"
    );
    let response = dtr_call_with_retry(|| {
        client.put(&url).bearer_auth(token).json(&body)
    })
    .await?;
    let status = response.status();
    if status.is_success() {
        return Ok(true);
    }
    Err(dtr_error_for_response(response).await)
}

/// Batch-write multiple DTR rows with values-only coalescing: plans are
/// chunked at 50 ranges OR 2MB serialized payload (whichever first, see
/// `sync_retry::split_dtr_batch`), one spreadsheet per call, one
/// values:batchUpdate per chunk. Paint never rides these calls — it stays
/// in `paint_tab_formats_with_rows`, and the absent sweep is untouched.
///
/// Whole-call 400 (data error, deterministic per range) falls back to
/// per-range isolation: each range of the failed chunk is retried singly,
/// good ranges apply, bad ones collect into the returned error. Other
/// failures return immediately: transient codes (429/5xx/403-rateLimit via
/// `dtr_error_for_response`, todo 5) belong to the todo-1 queue fail arm,
/// and transport exhaustion replays the chunk wholesale.
///
/// Values-overwrite idempotency: every write is a full `B:E` range+values
/// overwrite, so replaying the same range+values (retry, resume, or
/// isolation re-probe) converges instead of duplicating — safe to retry.
pub async fn execute_dtr_batch_push(
    client: &reqwest::Client,
    token: &str,
    spreadsheet_id: &str,
    plans: &[DtrPushPlan],
) -> Result<usize, String> {
    if plans.is_empty() {
        return Ok(0);
    }
    let url = format!(
        "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values:batchUpdate"
    );
    execute_dtr_batch_push_to_url(client, token, &url, plans).await
}

/// URL-injectable core of `execute_dtr_batch_push` (loopback seam for the
/// `batch_coalesce` tests; production passes the Google URL above).
async fn execute_dtr_batch_push_to_url(
    client: &reqwest::Client,
    token: &str,
    url: &str,
    plans: &[DtrPushPlan],
) -> Result<usize, String> {
    let sizes: Vec<usize> = plans.iter().map(dtr_batch_entry_bytes).collect();
    let mut applied_total = 0_usize;
    let mut bad: Vec<(String, String)> = Vec::new();
    for (start, end) in split_dtr_batch(&sizes) {
        let entries: Vec<serde_json::Value> =
            plans[start..end].iter().map(dtr_batch_entry).collect();
        let body = dtr_values_batch_body(&entries);
        match post_dtr_values_batch(client, token, url, &body).await {
            Ok(response) => {
                let status = response.status();
                if status.is_success() {
                    applied_total += end - start;
                } else if status.as_u16() == 400 {
                    drop(response);
                    isolate_dtr_chunk(client, token, url, &plans[start..end], &mut applied_total, &mut bad).await;
                } else {
                    return Err(dtr_error_for_response(response).await);
                }
            }
            Err(error) => return Err(error),
        }
    }
    if bad.is_empty() {
        Ok(applied_total)
    } else {
        Err(dtr_isolation_error(applied_total, plans.len(), &bad))
    }
}

/// Per-range isolation for one whole-call-400 chunk: retry each range
/// singly through the same bounded helper (todo 2). Sheets answers 200
/// with per-range responses and no per-range error field, so a single that
/// succeeds is a good range applied, and a single that fails is the bad
/// range isolated with its own error.
async fn isolate_dtr_chunk(
    client: &reqwest::Client,
    token: &str,
    url: &str,
    chunk: &[DtrPushPlan],
    applied_total: &mut usize,
    bad: &mut Vec<(String, String)>,
) {
    for plan in chunk {
        let range = dtr_plan_range(plan);
        let single = dtr_values_batch_body(&[dtr_batch_entry(plan)]);
        match post_dtr_values_batch(client, token, url, &single).await {
            Ok(response) => {
                if response.status().is_success() {
                    *applied_total += 1;
                } else {
                    bad.push((range, dtr_error_for_response(response).await));
                }
            }
            Err(error) => bad.push((range, error)),
        }
    }
}

/// One values:batchUpdate POST through the shared bounded retry (todo 2:
/// max 3 attempts, jitter, Retry-After ≤15s). Returns the last response so
/// the caller maps it (todo 5: 403 reason routing inside
/// `dtr_error_for_response`); transport exhaustion returns the generic
/// transient code for the todo-1 queue fail arm.
async fn post_dtr_values_batch(
    client: &reqwest::Client,
    token: &str,
    url: &str,
    body: &serde_json::Value,
) -> Result<reqwest::Response, String> {
    dtr_call_with_retry(|| client.post(url).bearer_auth(token).json(body)).await
}

/// Canonical `B:E` range string for one plan (single source for entries
/// and isolation errors).
fn dtr_plan_range(plan: &DtrPushPlan) -> String {
    format!(
        "{}!B{}:E{}",
        quote_tab(&plan.tab),
        plan.row_1based,
        plan.row_1based
    )
}

/// One values-only range entry for values:batchUpdate.
fn dtr_batch_entry(plan: &DtrPushPlan) -> serde_json::Value {
    serde_json::json!({
        "range": dtr_plan_range(plan),
        "values": [[plan.values[0], plan.values[1], plan.values[2], plan.values[3]]]
    })
}

/// Serialized bytes of one entry — the 2MB payload budget input.
fn dtr_batch_entry_bytes(plan: &DtrPushPlan) -> usize {
    serde_json::to_string(&dtr_batch_entry(plan)).map_or(0, |s| s.len())
}

/// values:batchUpdate body for one chunk (pure: 10 plans in ⇒ 10 ranges).
fn dtr_values_batch_body(entries: &[serde_json::Value]) -> serde_json::Value {
    serde_json::json!({
        "valueInputOption": "USER_ENTERED",
        "data": entries
    })
}

/// Aggregate error after isolation: good ranges applied, bad ones named.
fn dtr_isolation_error(applied: usize, total: usize, bad: &[(String, String)]) -> String {
    let detail = bad
        .iter()
        .map(|(range, error)| format!("{range}: {error}"))
        .collect::<Vec<_>>()
        .join("; ");
    format!("dtr batch: applied {applied} of {total}, isolated bad range(s): {detail}")
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
    let Some(tab) = DtrMatchIndex::build(&titles, &roster).resolve(&user_id, &full_name) else {
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
        paint_tab_formats(client, token, spreadsheet_id, sheet_id, &tab, vec![white], None).await
    {
        log::warn!("dtr clear paint failed for {full_name} ({user_id}) on {attendance_date} (values cleared): {error}");
    }
    Ok(true)
}

/// Todo 3 -- ONE skip path for unresolvable DTR plans (no-tab,
/// no-month-block, no-date-row, empty-values): note `dtr_pending` so the
/// rescan re-drives the row, and return `Ok(false)` so the queue marks it
/// SYNCED-with-skip. No attempts increment, never `Err`, hence never
/// RETRY and never DEAD. DEAD stays reserved for corrupt payloads (the
/// payload-validation `Err`s at the top of `push_dtr_row`).
async fn skip_unresolvable_row(
    state: &AppState,
    user_id: &str,
    full_name: &str,
    attendance_date: &str,
    reason: &'static str,
) -> Result<bool, String> {
    let now = chrono::Utc::now().to_rfc3339();
    note_dtr_pending(state, user_id, full_name, &now).await?;
    log::warn!(
        "dtr skip: unresolvable for {full_name} ({user_id}) on {attendance_date}: {reason}; SYNCED-with-skip, noted in dtr_pending"
    );
    Ok(false)
}

/// Handle one `InternDtr` queue row. `Ok(false)` = already in sync, no
/// tab yet, or an unresolvable plan (no-tab/no-month/no-date-row/
/// empty-values) -- all tracked in `dtr_pending`, never DEAD. Transport
/// and corrupt-payload errors propagate to the standard claim/retry/
/// backoff path in run_once (corrupt ages into DEAD, transient never).
pub async fn push_dtr_row(
    state: &AppState,
    client: &reqwest::Client,
    token: &str,
    spreadsheet_id: &str,
    payload: &serde_json::Value,
    throttle: Option<std::sync::Arc<tokio::sync::Mutex<DtrThrottleBucket>>>,
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
            backfill_user_history(state, client, token, spreadsheet_id, &user_id, &full_name, &roster, &meta, throttle)
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
                paint_tab_formats(client, token, spreadsheet_id, sheet_id, &tab, ops, None).await
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
                paint_tab_formats(client, token, spreadsheet_id, sheet_id, &tab, ops, None).await
            {
                log::warn!(
                    "dtr paint failed for {full_name} ({user_id}) on {attendance_date} (row in sync): {error}"
                );
            }
            clear_dtr_pending(state, &user_id).await?;
            Ok(false)
        }
        DtrPlanOutcome::Unresolvable(reason) => {
            skip_unresolvable_row(state, &user_id, &full_name, &attendance_date, reason).await
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
    throttle: Option<std::sync::Arc<tokio::sync::Mutex<DtrThrottleBucket>>>,
) -> Result<(usize, bool), String> {
    let titles = titles_of(meta);
    let Some(tab) = DtrMatchIndex::build(&titles, roster).resolve(user_id, full_name) else {
        return Ok((0, false));
    };
    let Some(sheet_id) = sheet_id_for_tab(meta, &tab) else {
        return Err(format!("DTR tab id missing for resolved tab {tab}"));
    };

    // Fetch A:F ONCE for this intern's tab
    let range = urlencoding::encode(&format!("{}!A:F", quote_tab(&tab))).into_owned();
    let tab_values = dtr_get_json(
        client,
        token,
        format!("https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{range}"),
    )
    .await?;
    let mut rows = rows_from_values(&tab_values);

    let mut wrote_total = 0;
    let mut complete = true;
    let mut offset: i64 = 0;
    let mut row_ops: Vec<DtrFormatOp> = Vec::new();
    let mut pending_writes: Vec<DtrPushPlan> = Vec::new();

    loop {
        let days = fetch_attendance_page(state, user_id, DTR_BACKFILL_PAGE, offset).await?;
        let full_page = days.len() as i64 == DTR_BACKFILL_PAGE;
        let mut page_results = Vec::with_capacity(days.len());
        for (date, tin, tout) in &days {
            let kind = classify_record_row(tin.as_deref(), tout.as_deref())?;
            match plan_dtr_push_in_rows(&tab, &rows, date, tin.as_deref(), tout.as_deref())? {
                DtrPlanOutcome::Write(plan) => {
                    let idx = plan.row_1based - 1;
                    if idx < rows.len() {
                        if rows[idx].len() < 5 {
                            rows[idx].resize(5, String::new());
                        }
                        rows[idx][1] = plan.values[0].clone();
                        rows[idx][2] = plan.values[1].clone();
                        rows[idx][3] = plan.values[2].clone();
                        rows[idx][4] = plan.values[3].clone();
                    }
                    row_ops.extend(plan_row_format(sheet_id, plan.row_1based, kind));
                    pending_writes.push(plan);
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

    if !pending_writes.is_empty() {
        // Plan todo 7: queue path admits the exact batch cost (writes +
        // todo-6 chunk count) before the values:batchUpdate calls. Denial
        // writes nothing — (0, false) keeps the user pending for the next
        // tick instead of sleeping or busy-looping. Manual path (None)
        // skips the bucket and keeps its 1000ms pacing floor.
        if let Some(throttle) = throttle.as_ref() {
            let sizes: Vec<usize> = pending_writes.iter().map(dtr_batch_entry_bytes).collect();
            let calls = split_dtr_batch(&sizes).len() as u32;
            let wait_ms = throttle
                .lock()
                .await
                .take(pending_writes.len() as u32, calls, crate::services::sync_retry::wall_now_ms());
            if wait_ms > 0 {
                log::warn!(
                    "DTR throttle: deferring backfill of {} writes + {calls} calls for {full_name} ({user_id}) for {wait_ms}ms",
                    pending_writes.len()
                );
                return Ok((0, false));
            }
        }
        execute_dtr_batch_push(client, token, spreadsheet_id, &pending_writes).await?;
    }

    // P1: final paint is cosmetic — log-only so a batchUpdate failure
    // after successful value writes never drops pending or fails the pass.
    if let Err(error) = paint_tab_formats_with_rows(
        client,
        token,
        spreadsheet_id,
        sheet_id,
        &rows,
        row_ops,
        None,
    )
    .await
    {
        log::warn!("dtr backfill paint failed for {full_name} ({user_id}) (values written): {error}");
    }
    Ok((wrote_total, complete))
}

/// Recheck every tracked user against one shared title fetch (one Sheets
/// metadata GET per run at most, only when pending rows exist). When a
/// tab has appeared, backfill the user's full history and clear pending.
/// Re-drive triggers (todo 3): the 30s tick rescan in run_once while
/// pending rows exist (covers owner-added month blocks too — planning
/// re-reads live tabs every pass), plus one immediate rescan after
/// manual_sync mints tabs. Per-user failures are logged and skipped;
/// the row stays pending.
pub async fn process_dtr_pending(
    state: &AppState,
    client: &reqwest::Client,
    token: &str,
    spreadsheet_id: &str,
    throttle: Option<std::sync::Arc<tokio::sync::Mutex<DtrThrottleBucket>>>,
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
        // Plan todo 7: queue path (throttle present) is bucket-exclusive —
        // batch admissions inside backfill own the pacing, so no fixed
        // sleep here. Manual path (None) keeps the 1000ms pacing floor.
        if throttle.is_none() {
            tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        }
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
            throttle.clone(),
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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DtrSyncProgressEvent {
    pub current: usize,
    pub total: usize,
    pub user_id: String,
    pub full_name: String,
    pub status: String,
}

/// Manually synchronize active interns onto the human DTR Google Sheets.
///
/// For each intern (or a specific targeted intern):
/// 1. Checks if their tab exists; if missing, auto-creates it from the template.
/// 2. Backfills all attendance history from SQLite into their tab.
/// 3. Clears the intern from `dtr_pending` when completely synced.
pub async fn manual_sync_intern_dtr(
    state: &AppState,
    app: Option<&tauri::AppHandle>,
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

    if let Some(app) = app {
        use tauri::Emitter;
        let _ = app.emit(
            "dtr-sync-progress",
            &DtrSyncProgressEvent {
                current: 0,
                total: interns.len(),
                user_id: String::new(),
                full_name: String::new(),
                status: "starting".to_string(),
            },
        );
    }

    let mut tabs_created = Vec::new();
    let mut rows_synced = 0;
    let mut details = Vec::with_capacity(interns.len());
    let mut errors = Vec::new();

    for (idx, (user_id, full_name)) in interns.iter().enumerate() {
        if let Some(app) = app {
            use tauri::Emitter;
            let _ = app.emit(
                "dtr-sync-progress",
                &DtrSyncProgressEvent {
                    current: idx + 1,
                    total: interns.len(),
                    user_id: user_id.clone(),
                    full_name: full_name.clone(),
                    status: "syncing".to_string(),
                },
            );
        }
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
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
                                DtrMatchIndex::build(&titles, &roster).resolve(user_id, full_name)
                            }
                            Ok(None) => {
                                if let Ok(fresh_meta) = fetch_tab_meta(&client, &token, &spreadsheet_id).await {
                                    meta = fresh_meta;
                                }
                                let titles = titles_of(&meta);
                                DtrMatchIndex::build(&titles, &roster).resolve(user_id, full_name)
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
            // Todo 3: a manually-synced intern with no tab yet stays visible
            // (MISSING_TAB) AND tracked, so the pending rescan re-drives
            // them once the owner creates the tab.
            let now = chrono::Utc::now().to_rfc3339();
            note_dtr_pending(state, user_id, full_name, &now).await?;
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
            state, &client, &token, &spreadsheet_id, user_id, full_name, &roster, &meta, None,
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

    // Todo 3 re-drive: tabs minted above unblock pending queue rows now --
    // rescan once instead of waiting for the next 30s tick (which also
    // covers owner-added month blocks: planning re-reads live tabs every
    // pass). Log-only: the report below already reflects this pass.
    if !tabs_created.is_empty() {
        if let Err(error) = process_dtr_pending(state, &client, &token, &spreadsheet_id, None).await {
            log::warn!("dtr pending rescan after tab-create failed: {error}");
        }
    }

    if let Some(app) = app {
        use tauri::Emitter;
        let _ = app.emit(
            "dtr-sync-progress",
            &DtrSyncProgressEvent {
                current: interns.len(),
                total: interns.len(),
                user_id: String::new(),
                full_name: String::new(),
                status: "completed".to_string(),
            },
        );
    }

    Ok(ManualSyncReport {
        success: errors.is_empty(),
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
    use crate::services::sync_retry::{PER_CALL_SLEEP_BUDGET_MS, is_per_call_retryable};

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

    #[tokio::test]
    async fn per_call_retry_bounded() {
        // Todo 2 acceptance: per-call attempts capped at 3 with full-jitter
        // backoff (base 1500ms doubling) + Retry-After honored and clamped to
        // 15s; worst-case added in-call sleep 1.5+3+15 = 19.5s so one row
        // never overruns the 30s tick. Exhaustion returns the transient code
        // upward (queue-row infiniteness lives in todo 1's fail arm, never
        // in an in-call loop).
        assert_eq!(PER_CALL_MAX_ATTEMPTS, 3);
        assert!(is_per_call_retryable(429));
        assert!(is_per_call_retryable(503));
        assert!(!is_per_call_retryable(400));
        assert!(!is_per_call_retryable(404));
        assert!(per_call_should_retry(429, 0));
        assert!(per_call_should_retry(503, 1));
        assert!(!per_call_should_retry(429, 2));
        assert!(!per_call_should_retry(400, 0));
        assert_eq!(parse_retry_after_secs("120"), Some(120));
        assert_eq!(parse_retry_after_secs("2"), Some(2));
        assert_eq!(parse_retry_after_secs("junk"), None);
        assert_eq!(per_call_sleep_ms(0, Some(120)), 15_000);
        assert_eq!(per_call_sleep_ms(0, Some(2)), 2_000);
        assert!(per_call_sleep_ms(0, None) <= 1_500);
        assert!(per_call_sleep_ms(1, None) <= 3_000);
        assert_eq!(per_call_budget_actual(18_000, 15_000), 1_500);
        assert_eq!(
            PER_CALL_SLEEP_BUDGET_MS,
            1_500 + 3_000 + 15_000,
            "worst-case in-call sleep (1.5s jitter + 3s jitter + 15s Retry-After cap) must stay inside the 19.5s budget"
        );
        assert_eq!(
            dtr_status_error(reqwest::StatusCode::TOO_MANY_REQUESTS),
            GOOGLE_RATE_LIMITED
        );

        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};

        // Persistent 429 with Retry-After: 0 (zero real sleep): exactly 3
        // attempts, then the transient code returns upward.
        let hits = Arc::new(AtomicUsize::new(0));
        let url = serve_scripted(
            vec![rate_limited_response(); 3],
            Arc::clone(&hits),
        );
        let client = test_client();
        let err = dtr_get_json(&client, "token", url).await.unwrap_err();
        assert_eq!(err, GOOGLE_RATE_LIMITED);
        assert_eq!(hits.load(Ordering::SeqCst), 3);

        // Single 429 then 200: success within the bound (2 calls).
        let hits = Arc::new(AtomicUsize::new(0));
        let url = serve_scripted(
            vec![rate_limited_response(), ok_values_response()],
            Arc::clone(&hits),
        );
        let value = dtr_get_json(&client, "token", url).await.unwrap();
        assert_eq!(
            value.get("values").and_then(|v| v.as_array()).map(Vec::len),
            Some(1)
        );
        assert_eq!(hits.load(Ordering::SeqCst), 2);

        // Retry-After honored: 429 carrying Retry-After: 1 then 200 sleeps ~1s.
        let hits = Arc::new(AtomicUsize::new(0));
        let url = serve_scripted(
            vec![rate_limited_response_after(1), ok_values_response()],
            Arc::clone(&hits),
        );
        let started = std::time::Instant::now();
        dtr_get_json(&client, "token", url).await.unwrap();
        assert!(started.elapsed() >= std::time::Duration::from_millis(900));
        assert_eq!(hits.load(Ordering::SeqCst), 2);
    }

    fn test_client() -> reqwest::Client {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(25))
            .build()
            .expect("loopback test client builds")
    }

    fn rate_limited_response_after(secs: u64) -> String {
        format!(
            "HTTP/1.1 429 Too Many Requests\r\nRetry-After: {secs}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
    }

    fn rate_limited_response() -> String {
        rate_limited_response_after(0)
    }

    fn ok_values_response() -> String {
        let body = "{\"values\":[[\"a\"]]}";
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
    }

    fn find_header_end(buf: &[u8]) -> Option<usize> {
        buf.windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|pos| pos + 4)
    }

    fn header_content_length(header: &[u8]) -> usize {
        String::from_utf8_lossy(header)
            .to_lowercase()
            .split("\r\n")
            .find_map(|line| {
                line.trim()
                    .strip_prefix("content-length:")
                    .and_then(|value| value.trim().parse::<usize>().ok())
            })
            .unwrap_or(0)
    }

    /// Loopback fixture: serves the scripted responses in order on fresh
    /// connections and counts hits, so the test proves the attempt bound with
    /// real HTTP and zero real sleep (Retry-After: 0). Returns a URL for
    /// `dtr_get_json`.
    fn serve_scripted(
        responses: Vec<String>,
        hits: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    ) -> String {
        use std::io::{Read, Write};
        let listener =
            std::net::TcpListener::bind("127.0.0.1:0").expect("loopback fixture binds");
        let addr = listener.local_addr().expect("fixture addr").to_string();
        listener
            .set_nonblocking(true)
            .expect("fixture nonblocking");
        std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(25);
            let mut served = 0_usize;
            while served < responses.len() && std::time::Instant::now() < deadline {
                let (mut stream, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(_) => {
                        std::thread::sleep(std::time::Duration::from_millis(1));
                        continue;
                    }
                };
                // Accepted sockets may inherit the listener's nonblocking
                // mode; force blocking reads so a not-yet-arrived request
                // waits instead of WouldBlock-abandoning the connection.
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));
                let mut buf = vec![0_u8; 65536];
                let mut got = 0_usize;
                let mut header_end = None;
                while header_end.is_none() && got < buf.len() {
                    match stream.read(&mut buf[got..]) {
                        Ok(0) => break,
                        Ok(n) => {
                            got += n;
                            header_end = find_header_end(&buf[..got]);
                        }
                        Err(_) => break,
                    }
                }
                let Some(end) = header_end else {
                    continue;
                };
                let mut body_needed = header_content_length(&buf[..end])
                    .saturating_sub(got.saturating_sub(end));
                let mut drain = [0_u8; 4096];
                while body_needed > 0 {
                    let want = drain.len().min(body_needed);
                    match stream.read(&mut drain[..want]) {
                        Ok(0) => break,
                        Ok(n) => body_needed = body_needed.saturating_sub(n),
                        Err(_) => break,
                    }
                }
                let _ = stream.write_all(responses[served].as_bytes());
                let _ = stream.flush();
                drop(stream);
                hits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                served += 1;
            }
        });
        format!("http://{addr}/values/Fake!A:F")
    }

    fn batch_plan(tab: &str, row_1based: usize, fill: &str) -> DtrPushPlan {
        DtrPushPlan {
            tab: tab.to_string(),
            row_1based,
            values: [
                fill.to_string(),
                "12:00:00 PM".to_string(),
                "1:00:00 PM".to_string(),
                "5:00:00 PM".to_string(),
            ],
        }
    }

    fn ok_batch_response() -> String {
        let body = "{\"spreadsheetId\":\"scratch\",\"totalUpdatedCells\":4,\"responses\":[{\"spreadsheetId\":\"scratch\",\"updatedRange\":\"'TAB'!B2:E2\"}]}";
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
    }

    fn bad_request_response() -> String {
        let body =
            "{\"error\":{\"code\":400,\"message\":\"Invalid values\",\"status\":\"INVALID_ARGUMENT\"}}";
        format!(
            "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
    }

    /// Loopback fixture for values:batchUpdate: records each POST body so the
    /// test proves range coalescing, and serves scripted statuses in order.
    fn serve_batch_scripted(
        responses: Vec<String>,
        hits: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        bodies: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    ) -> String {
        use std::io::{Read, Write};
        let listener =
            std::net::TcpListener::bind("127.0.0.1:0").expect("loopback batch fixture binds");
        let addr = listener.local_addr().expect("fixture addr").to_string();
        listener
            .set_nonblocking(true)
            .expect("fixture nonblocking");
        std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(25);
            let mut served = 0_usize;
            while served < responses.len() && std::time::Instant::now() < deadline {
                let (mut stream, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(_) => {
                        std::thread::sleep(std::time::Duration::from_millis(1));
                        continue;
                    }
                };
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));
                let mut buf = vec![0_u8; 65536];
                let mut got = 0_usize;
                let mut header_end = None;
                while header_end.is_none() && got < buf.len() {
                    match stream.read(&mut buf[got..]) {
                        Ok(0) => break,
                        Ok(n) => {
                            got += n;
                            header_end = find_header_end(&buf[..got]);
                        }
                        Err(_) => break,
                    }
                }
                let Some(end) = header_end else {
                    continue;
                };
                let content_len = header_content_length(&buf[..end]);
                let mut body: Vec<u8> = buf[end..got].to_vec();
                body.truncate(content_len.min(body.len()));
                while body.len() < content_len {
                    let mut chunk = vec![0_u8; content_len - body.len()];
                    match stream.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => body.extend_from_slice(&chunk[..n]),
                        Err(_) => break,
                    }
                }
                if let Ok(text) = String::from_utf8(body) {
                    bodies.lock().expect("bodies lock").push(text);
                }
                let _ = stream.write_all(responses[served].as_bytes());
                let _ = stream.flush();
                drop(stream);
                hits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                served += 1;
            }
        });
        format!("http://{addr}/values:batchUpdate")
    }

    #[test]
    fn batch_coalesce_splits_at_50_ranges_or_2mb() {
        // 10 small plans ride one call; the body carries all 10 ranges.
        let plans: Vec<DtrPushPlan> = (2..12)
            .map(|row| batch_plan("TAB", row, "9:46:23 AM"))
            .collect();
        let sizes: Vec<usize> = plans.iter().map(dtr_batch_entry_bytes).collect();
        assert_eq!(split_dtr_batch(&sizes), vec![(0, 10)]);
        let entries: Vec<serde_json::Value> =
            plans.iter().map(dtr_batch_entry).collect();
        let body = dtr_values_batch_body(&entries);
        assert_eq!(
            body.get("valueInputOption").and_then(|v| v.as_str()),
            Some("USER_ENTERED")
        );
        assert_eq!(
            body.get("data").and_then(|v| v.as_array()).map(Vec::len),
            Some(10)
        );

        // 55 plans split 50 + 5 (single spreadsheet per call preserved).
        let plans55: Vec<DtrPushPlan> = (2..57)
            .map(|row| batch_plan("TAB", row, "9:46:23 AM"))
            .collect();
        let sizes55: Vec<usize> = plans55.iter().map(dtr_batch_entry_bytes).collect();
        assert_eq!(split_dtr_batch(&sizes55), vec![(0, 50), (50, 55)]);

        // 2MB payload bound splits first: 3 x ~0.8MB entries -> 2 + 1.
        let big = "x".repeat(800_000);
        let big_plans: Vec<DtrPushPlan> = (2..5)
            .map(|row| batch_plan("TAB", row, &big))
            .collect();
        let big_sizes: Vec<usize> = big_plans.iter().map(dtr_batch_entry_bytes).collect();
        assert_eq!(split_dtr_batch(&big_sizes), vec![(0, 2), (2, 3)]);

        // Isolation error names the applied count plus the bad range.
        let err = dtr_isolation_error(
            9,
            10,
            &[("'TAB'!B4:E4".to_string(), "400 invalid".to_string())],
        );
        assert!(err.contains("applied 9 of 10"), "{err}");
        assert!(err.contains("'TAB'!B4:E4"), "{err}");
    }

    #[tokio::test]
    async fn batch_coalesce_happy_coalesces_ten_rows_into_one_call() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let plans: Vec<DtrPushPlan> = (2..12)
            .map(|row| batch_plan("TAB", row, "9:46:23 AM"))
            .collect();
        let hits = std::sync::Arc::new(AtomicUsize::new(0));
        let bodies = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let url = serve_batch_scripted(
            vec![ok_batch_response()],
            std::sync::Arc::clone(&hits),
            std::sync::Arc::clone(&bodies),
        );
        let client = test_client();
        let applied = execute_dtr_batch_push_to_url(&client, "token", &url, &plans)
            .await
            .expect("happy batch applies");
        assert_eq!(applied, 10);
        assert_eq!(
            hits.load(Ordering::SeqCst),
            1,
            "10 plans drain as 1 values:batchUpdate"
        );
        let captured = bodies.lock().expect("bodies lock");
        assert_eq!(captured.len(), 1);
        let parsed: serde_json::Value =
            serde_json::from_str(&captured[0]).expect("batch body is JSON");
        assert_eq!(
            parsed.get("data").and_then(|v| v.as_array()).map(Vec::len),
            Some(10)
        );
    }

    #[tokio::test]
    async fn batch_coalesce_bad_range_isolates_with_good_applied() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let plans: Vec<DtrPushPlan> = (2..12)
            .map(|row| batch_plan("TAB", row, "9:46:23 AM"))
            .collect();
        // Whole-call 400, then per-range singles: every row OK except row 4.
        let mut scripted = vec![bad_request_response()];
        for row in 2..12 {
            scripted.push(if row == 4 {
                bad_request_response()
            } else {
                ok_batch_response()
            });
        }
        let hits = std::sync::Arc::new(AtomicUsize::new(0));
        let bodies = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let url = serve_batch_scripted(
            scripted,
            std::sync::Arc::clone(&hits),
            std::sync::Arc::clone(&bodies),
        );
        let client = test_client();
        let err = execute_dtr_batch_push_to_url(&client, "token", &url, &plans)
            .await
            .expect_err("bad range isolates with error");
        assert!(err.contains("applied 9 of 10"), "{err}");
        assert!(err.contains("'TAB'!B4:E4"), "{err}");
        assert_eq!(
            hits.load(Ordering::SeqCst),
            11,
            "1 batch + 10 single-range probes"
        );
        let captured = bodies.lock().expect("bodies lock");
        assert_eq!(captured.len(), 11);
        let first: serde_json::Value =
            serde_json::from_str(&captured[0]).expect("batch body is JSON");
        assert_eq!(
            first.get("data").and_then(|v| v.as_array()).map(Vec::len),
            Some(10)
        );
        for single in captured.iter().skip(1) {
            let parsed: serde_json::Value =
                serde_json::from_str(single).expect("single body is JSON");
            assert_eq!(
                parsed.get("data").and_then(|v| v.as_array()).map(Vec::len),
                Some(1)
            );
        }
    }

    #[test]
    fn duplicate_date_rows_fail_closed() {        let rows = vec![
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
    fn half_day_timeout_renders_actual_stamps() {
        // DTR/PAYROLL DECOUPLING: 08:04-15:00 is payroll half-day (out <
        // 17:00) but the DTR row keeps the actual stamps at both ends and standard lunch in columns C & D.
        assert_eq!(
            build_dtr_row(
                Some("2026-09-05T08:04:00+08:00"),
                Some("2026-09-05T15:00:00+08:00"),
                "2026-09-05"
            ),
            Ok([
                "8:04:00 AM".to_string(),
                "12:00:00 PM".to_string(),
                "1:00:00 PM".to_string(),
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
            assert_eq!(row[1], "12:00:00 PM".to_string());
            assert_eq!(row[2], "1:00:00 PM".to_string());
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
        // WORKING row holds the in-stamp and standard lunch stamps…
        let working =
            build_dtr_row(Some("2026-09-05T08:00:00+08:00"), None, "2026-09-05").unwrap();
        assert_eq!(
            working,
            [
                "8:00:00 AM".to_string(),
                "12:00:00 PM".to_string(),
                "1:00:00 PM".to_string(),
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
    fn eight_to_three_keeps_actuals_while_payroll_has_undertime() {
        // The reported case: 08:00-15:00 renders actual stamps and standard lunch on the DTR…
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
                "12:00:00 PM".to_string(),
                "1:00:00 PM".to_string(),
                "3:00:00 PM".to_string()
            ]
        );
        // …while payroll classifies the same punches as 6 worked hours with 2h undertime deduction (not half-day).
        let pay = crate::services::intern_payroll::calculate(
            "2026-09-05",
            "2026-09-05T08:00:00+08:00",
            "2026-09-05T15:00:00+08:00",
            true,
        )
        .unwrap();
        assert!(!pay.is_half_day);
        assert_eq!(pay.worked_hours, 6);
        assert_eq!(pay.half_day_deduction_centavos, 2000);
        assert_eq!(pay.daily_pay_centavos, 6000);
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
        assert_eq!(row[1], "12:00:00 PM".to_string());
        assert_eq!(row[2], "1:00:00 PM".to_string());
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
                "12:00:00 PM".to_string(),
                "1:00:00 PM".to_string(),
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
        // Post-0.1.75: 12:30–17:00 (4.5h elapsed, floored) pays 4h with no
        // 12:00–13:00 subtraction.
        assert_eq!(pay.worked_hours, 4);
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
        let ops = plan_absent_sweep(9, &rows, None, "2026-09-05");
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
                "12:00:00 PM".to_string(),
                "1:00:00 PM".to_string(),
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
                "12:00:00 PM".to_string(),
                "1:00:00 PM".to_string(),
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
        assert_eq!(full[1], "12:00:00 PM");
        assert_eq!(full[2], "1:00:00 PM");
        assert_eq!(full[3], "5:30:00 PM");
        // 08:30:00Z is 16:30 Manila → actual stamps and standard lunch (payroll half-day does
        // not alter the DTR row).
        let half = build_dtr_row(
            Some("2026-09-05T00:04:00Z"),
            Some("2026-09-05T08:30:00Z"),
            "2026-09-05",
        )
        .unwrap();
        assert_eq!(half[0], "8:04:00 AM");
        assert_eq!(half[1], "12:00:00 PM");
        assert_eq!(half[2], "1:00:00 PM");
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

    #[tokio::test]
    async fn unresolvable_never_dead() {
        // Todo 3: no-tab / no-month-block / no-date-row / empty-values take
        // ONE skip path -- Ok(false) = SYNCED-with-skip + dtr_pending note,
        // never Err, so never RETRY and never DEAD. Corrupt payloads keep
        // the Err path and still age into DEAD (contrast at the end).
        let tin = Some("2026-09-05T00:00:00+08:00");
        let tout = Some("2026-09-05T09:00:00+08:00");
        // empty-values: a record-less day plans Unresolvable, not Err.
        assert_eq!(
            plan_dtr_push_in_rows("Tab", &[], "2026-09-05", None, None),
            Ok(DtrPlanOutcome::Unresolvable("empty-values"))
        );
        // no-month-block: headers exist but none matches September.
        let headed = vec![
            vec!["DATE-October".to_string()],
            vec!["10/5/2026".to_string()],
        ];
        assert_eq!(
            plan_dtr_push_in_rows("Tab", &headed, "2026-09-05", tin, tout),
            Ok(DtrPlanOutcome::Unresolvable("no-month-block"))
        );
        // no-date-row: September block without the wanted date.
        let no_date = vec![
            vec!["SEPTEMBER".to_string()],
            vec!["9/4/2026".to_string()],
            vec!["TOTAL HOURS".to_string()],
        ];
        assert_eq!(
            plan_dtr_push_in_rows("Tab", &no_date, "2026-09-05", tin, tout),
            Ok(DtrPlanOutcome::Unresolvable("no-date-row"))
        );
        // no-tab: unknown intern resolves to no tab.
        let titles = vec!["Somebody Else".to_string()];
        let roster = vec![("u1".to_string(), "New Intern".to_string())];
        assert_eq!(
            DtrMatchIndex::build(&titles, &roster).resolve("u1", "New Intern"),
            None
        );
        // ONE skip path: every reason above returns Ok(false) with a
        // dtr_pending note and creates no queue debt (no attempts anywhere
        // near the sync_queue DEAD budget).
        let state = pending_test_state().await;
        for reason in ["no-tab", "no-month-block", "no-date-row", "empty-values"] {
            let skipped =
                skip_unresolvable_row(&state, "u-skip", "Skip Intern", "2026-09-05", reason)
                    .await
                    .unwrap();
            assert!(!skipped, "reason={reason}");
        }
        let pending: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM dtr_pending WHERE user_id = 'u-skip'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(pending, 1);
        let queued: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_queue")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(queued, 0);
        // Failure contrast: a corrupt payload (empty userId) still errors
        // before any I/O, so the queue fail arm ages it toward DEAD.
        let corrupt = serde_json::json!({
            "userId": "",
            "fullName": "Skip Intern",
            "attendanceDate": "2026-09-05",
        });
        let client = crate::services::sheets_sync::sheets_client();
        let err = push_dtr_row(&state, &client, "tok", "sheet", &corrupt, None)
            .await
            .unwrap_err();
        assert!(err.contains("userId"), "unexpected error: {err}");
        let (_, status, _) = crate::services::sync_retry::calculate_retry_backoff(4, &err);
        assert_eq!(status, "DEAD");
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
    fn row_format_half_day_whites_all_stamped_columns() {
        let ops = plan_row_format(7, 107, DtrRowKind::HalfDay);
        assert_eq!(ops.len(), 1);
        assert_eq!((ops[0].start_col_0, ops[0].end_col_0_excl), (1, 5));
        assert_eq!(ops[0].color, DtrCellColor::White);
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
        // Sub-4h lunch-spanning stint: actual stamps and lunch stamps.
        assert_eq!(
            build_dtr_row(
                Some("2026-09-05T11:30:00+08:00"),
                Some("2026-09-05T14:30:00+08:00"),
                "2026-09-05"
            ),
            Ok([
                "11:30:00 AM".to_string(),
                "12:00:00 PM".to_string(),
                "1:00:00 PM".to_string(),
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
        // 4h+ morning span closing early: actual stamps and lunch stamps (payroll half-day
        // does not alter the DTR row).
        assert_eq!(
            build_dtr_row(
                Some("2026-09-05T08:00:00+08:00"),
                Some("2026-09-05T15:00:00+08:00"),
                "2026-09-05"
            ),
            Ok([
                "8:00:00 AM".to_string(),
                "12:00:00 PM".to_string(),
                "1:00:00 PM".to_string(),
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
        let ops = plan_absent_sweep(9, &rows, None, "2026-09-05");
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
    fn absent_sweep_skips_dates_prior_to_start_date() {
        let rows = vec![
            fmt_row(&["SEPTEMBER"]),
            fmt_row(&["9/1/2026", "", "", "", ""]),
            fmt_row(&["9/2/2026", "", "", "", ""]),
            fmt_row(&["9/3/2026", "", "", "", ""]),
            fmt_row(&["9/4/2026", "", "", "", ""]),
            fmt_row(&["9/5/2026", "", "", "", ""]),
        ];
        // Start date is 2026-09-03. 9/1 and 9/2 must be skipped!
        let ops = plan_absent_sweep(9, &rows, Some("2026-09-03"), "2026-09-05");
        assert_eq!(ops.len(), 1);
        // 9/3 (row 4) and 9/4 (row 5) merged: rows 4..6
        assert_eq!((ops[0].start_row_1based, ops[0].end_row_1based_excl), (4, 6));
        assert_eq!(ops[0].color, DtrCellColor::Red);
    }

    #[test]
    fn absent_sweep_never_paints_on_bad_today() {
        let rows = vec![fmt_row(&["9/1/2026", "", "", "", ""])];
        assert!(plan_absent_sweep(9, &rows, None, "not-a-date").is_empty());
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

    #[test]
    fn sheet_effective_start_date_resolves_accurately() {
        // June tab with late June punch starts at the punch date (protecting early June)
        let june_rows = vec![
            fmt_row(&["JUNE"]),
            fmt_row(&["6/1/2026", "", "", "", ""]),
            fmt_row(&["6/29/2026", "8:00:00 AM", "12:00:00 PM", "1:00:00 PM", "5:00:00 PM"]),
        ];
        assert_eq!(
            get_sheet_effective_start_date(&june_rows),
            Some(chrono::NaiveDate::from_ymd_opt(2026, 6, 29).unwrap())
        );

        // August tab starts at 2026-08-01
        let aug_rows = vec![
            fmt_row(&["DATE-AUGUST"]),
            fmt_row(&["8/1/2026", "", "", "", ""]),
            fmt_row(&["8/3/2026", "", "", "", ""]),
        ];
        assert_eq!(
            get_sheet_effective_start_date(&aug_rows),
            Some(chrono::NaiveDate::from_ymd_opt(2026, 8, 1).unwrap())
        );

        // September tab starts at 2026-09-01
        let sep_rows = vec![
            fmt_row(&["DATE-September"]),
            fmt_row(&["9/1/2026", "", "", "", ""]),
        ];
        assert_eq!(
            get_sheet_effective_start_date(&sep_rows),
            Some(chrono::NaiveDate::from_ymd_opt(2026, 9, 1).unwrap())
        );
    }

    #[tokio::test]
    async fn resume_idempotent() {
        // Todo 11 failing-first: kill-mid-PROCESSING must flip to RETRY on
        // the next run_once; dtr_pending must survive the restart tick; a
        // replayed manual batch must write B:E once (overwrite, missing
        // ranges only). Pre-fix this FAILS: the 5-min prod lease treats a
        // 3s-old lock as fresh, so the victim row stays stuck in PROCESSING.
        let _env_guard = crate::config::dtr_env_test_guard();
        let state = pending_test_state().await;
        let now = chrono::Utc::now();
        let now_text = now.to_rfc3339();
        // 5 PENDING rows: a normal backlog present at crash time.
        for index in 0..5 {
            let row_id = format!("resume-u{index}");
            let payload =
                format!("{{\"userId\":\"{row_id}\",\"fullName\":\"Resume {index}\"}}");
            let key = format!("Users:{row_id}:UPSERT");
            sqlx::query("INSERT INTO sync_queue (table_name,row_id,operation,payload_json,attempts,status,next_attempt_at,created_at,updated_at,idempotency_key) VALUES ('Users',?,?,?,0,'PENDING',?,?,?,?)")
                .bind(&row_id).bind("UPSERT").bind(&payload).bind(&now_text).bind(&now_text).bind(&now_text).bind(&key)
                .execute(&state.db).await.unwrap();
        }
        // 1 PROCESSING row locked 3s ago: the crash victim (the claim wrote
        // locked_at, the process died before the terminal update).
        let stale_lock = (now - chrono::Duration::seconds(3)).to_rfc3339();
        sqlx::query("INSERT INTO sync_queue (table_name,row_id,operation,payload_json,attempts,status,locked_at,next_attempt_at,created_at,updated_at,idempotency_key) VALUES ('Users','resume-victim','UPSERT','{\"userId\":\"resume-victim\"}',0,'PROCESSING',?,?,?,?,?)")
            .bind(&stale_lock).bind(&now_text).bind(&now_text).bind(&now_text).bind("Users:resume-victim:UPSERT")
            .execute(&state.db).await.unwrap();
        // 1 dtr_pending row: must survive the restart tick untouched.
        note_dtr_pending(&state, "u-pending", "Pending Intern", &now_text)
            .await
            .unwrap();
        // Restart tick against a dead endpoint: every claim fails finite
        // (connection refused), so the drain cannot mask the recovery step.
        let completed =
            crate::services::sheets_sync::run_once(&state, Some("http://127.0.0.1:9/sync"))
                .await
                .unwrap();
        assert_eq!(completed, 0);
        // CHECK: the stale PROCESSING row flipped to RETRY (not stuck, not DEAD).
        let victim: (String, i64) =
            sqlx::query_as("SELECT status, attempts FROM sync_queue WHERE row_id='resume-victim'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(
            victim.0, "RETRY",
            "kill-mid-PROCESSING must resume as RETRY"
        );
        // No lease left stuck, nothing synced or dead-lettered by the refused endpoint.
        let stuck: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM sync_queue WHERE status='PROCESSING'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        let synced: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM sync_queue WHERE status='SYNCED'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        let dead: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM sync_queue WHERE status='DEAD'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!((stuck, synced, dead), (0, 0, 0));
        // The recovery counter backing health `leaseRecovered` fired exactly once.
        assert_eq!(
            state
                .lease_recovered
                .load(std::sync::atomic::Ordering::Relaxed),
            1
        );
        // dtr_pending survived the restart tick.
        let pending: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM dtr_pending WHERE user_id='u-pending'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(pending, 1);
        // --- manual batch replay idempotency (todo-6 overwrite, pure) ---
        let tab = "LAZARO DEIGN";
        let rows = vec![
            vec!["SEPTEMBER".to_string()],
            vec![
                "9/4/2026".to_string(),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
            ],
            vec![
                "9/5/2026".to_string(),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
            ],
            vec!["TOTAL HOURS".to_string()],
        ];
        let day5_in = Some("2026-09-05T01:00:00Z");
        let day5_out = Some("2026-09-05T09:30:00Z");
        let plan = match plan_dtr_push_in_rows(tab, &rows, "2026-09-05", day5_in, day5_out).unwrap()
        {
            DtrPlanOutcome::Write(plan) => plan,
            other => panic!("expected Write for empty day, got {other:?}"),
        };
        // Same range+values replays to byte-identical bodies: values
        // overwrite B:E in place, so a retry can never duplicate cells.
        let body_a = dtr_values_batch_body(&[dtr_batch_entry(&plan)]);
        let body_b = dtr_values_batch_body(&[dtr_batch_entry(&plan)]);
        assert_eq!(body_a, body_b);
        assert_eq!(
            body_a
                .get("valueInputOption")
                .and_then(|v| v.as_str()),
            Some("USER_ENTERED")
        );
        assert_eq!(
            body_a
                .get("data")
                .and_then(|v| v.as_array())
                .map(|a| a.len()),
            Some(1)
        );
        // Kill-mid-batchUpdate: only 9/5 landed. Retry re-plans from live
        // reads — the landed day is InSync (no second B:E write), the
        // missing day still Writes (missing ranges only).
        let mut landed = rows.clone();
        let idx = plan.row_1based - 1;
        for (offset, value) in plan.values.iter().enumerate() {
            landed[idx][1 + offset] = value.clone();
        }
        assert_eq!(
            plan_dtr_push_in_rows(tab, &landed, "2026-09-05", day5_in, day5_out).unwrap(),
            DtrPlanOutcome::InSync {
                row_1based: plan.row_1based
            }
        );
        assert!(matches!(
            plan_dtr_push_in_rows(
                tab,
                &landed,
                "2026-09-04",
                Some("2026-09-04T01:00:00Z"),
                Some("2026-09-04T09:30:00Z")
            )
            .unwrap(),
            DtrPlanOutcome::Write(_)
        ));
    }
}
