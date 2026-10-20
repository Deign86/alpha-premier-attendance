pub fn floor_zero(value: i64) -> i64 {
    value.max(0)
}

/// Official office close (17:00 Manila). Clock-out at exactly this instant counts a full day (T6 decision A).
pub const OFFICE_CLOSE_HOUR: u32 = 17;
/// Late time-out flag hour (18:00 Manila): overtime is forbidden, so a
/// clock-out at/after this hour auto-caps to OFFICE_CLOSE_HOUR (17:00)
/// BEFORE DTR row building and payroll math. 17:59:59 stays actual;
/// 18:00:00+ caps. Single normalization (mirrors TS `capLateTimeoutOut`
/// in server/src/lunch-break.ts); half-day rules apply after capping.
pub const LATE_TIMEOUT_HOUR: u32 = 18;

/// Auto-cap a Manila clock-out at/after 18:00 to 17:00 same-day (overtime
/// forbidden — avoids manual HR/IT correction). Returns the input unchanged
/// when before 18:00.
pub fn cap_late_timeout_out(
    clock_out: chrono::DateTime<chrono_tz::Tz>,
) -> chrono::DateTime<chrono_tz::Tz> {
    use chrono::{Datelike, TimeZone, Timelike};
    if clock_out.hour() >= LATE_TIMEOUT_HOUR {
        chrono_tz::Asia::Manila
            .with_ymd_and_hms(
                clock_out.year(),
                clock_out.month(),
                clock_out.day(),
                OFFICE_CLOSE_HOUR,
                0,
                0,
            )
            .single()
            .unwrap_or(clock_out)
    } else {
        clock_out
    }
}
/// Clock-in at/after this Manila hour misses the morning: afternoon half-day.
pub const HALF_DAY_LATE_ARRIVAL_HOUR: u32 = 12;

/// 17:00:00 Manila on the same calendar day as the given clock-out.
pub fn office_close_for(clock_out: chrono::DateTime<chrono_tz::Tz>) -> chrono::DateTime<chrono_tz::Tz> {
    use chrono::{Datelike, TimeZone};
    chrono_tz::Asia::Manila
        .with_ymd_and_hms(
            clock_out.year(),
            clock_out.month(),
            clock_out.day(),
            OFFICE_CLOSE_HOUR,
            0,
            0,
        )
        .single()
        .expect("17:00 is always a valid Manila time")
}

/// Shared morning-half-day rule: a half-day shift that clocked in before
/// 12:00 Manila but left before office close pays as an effective 08:00-12:00
/// window. Returns 12:00 same-day when that condition holds, otherwise `None`
/// so each caller keeps its own else-branch (employee floors to the hour,
/// intern passes the stamp through) instead of hiding that difference here.
///
/// `time_out` MUST already be the capped clock-out (`cap_late_timeout_out`
/// applied), matching the cap -> half-day -> window order used by both
/// payroll engines.
pub fn early_half_day_noon_out(
    is_half_day: bool,
    time_in: chrono::DateTime<chrono_tz::Tz>,
    time_out: chrono::DateTime<chrono_tz::Tz>,
) -> Option<chrono::DateTime<chrono_tz::Tz>> {
    use chrono::{Datelike, TimeZone, Timelike};
    if !is_half_day
        || time_in.hour() >= HALF_DAY_LATE_ARRIVAL_HOUR
        || time_out >= office_close_for(time_out)
    {
        return None;
    }
    chrono_tz::Asia::Manila
        .with_ymd_and_hms(time_out.year(), time_out.month(), time_out.day(), 12, 0, 0)
        .single()
}
