pub fn floor_zero(value: i64) -> i64 {
    value.max(0)
}

pub fn ceiling_hours(seconds: i64) -> i64 {
    ((seconds.max(0) + 3599) / 3600).max(0)
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
/// Paid-hours threshold at or below which a shift is always a half-day.
pub const HALF_DAY_MAX_HOURS: i64 = 4;

/// 17:00:00 Manila on the same calendar day as the given clock-out.
pub fn office_close_for(clock_out: chrono::DateTime<chrono_tz::Tz>) -> chrono::DateTime<chrono_tz::Tz> {
    use chrono::{Datelike, TimeZone, Timelike};
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

/// Shared half-day rule: short shifts, early clock-out, or afternoon arrival (>=12:00 Manila).
pub fn is_half_day(
    worked_hours: i64,
    clock_out: chrono::DateTime<chrono_tz::Tz>,
    clock_in: chrono::DateTime<chrono_tz::Tz>,
) -> bool {
    use chrono::Timelike;
    if !(worked_hours > 0) {
        return false;
    }
    if worked_hours <= HALF_DAY_MAX_HOURS {
        return true;
    }
    if clock_out < office_close_for(clock_out) {
        return true;
    }
    clock_in.hour() >= HALF_DAY_LATE_ARRIVAL_HOUR
}

/// Round a Manila timestamp up to the next whole hour (exact hours stay put).
/// Truncates sub-second residue first so 08:00:00.500 counts exact-hour (TS parity, P5).
pub fn ceil_hour(value: chrono::DateTime<chrono_tz::Tz>) -> chrono::DateTime<chrono_tz::Tz> {
    use chrono::{Datelike, TimeZone, Timelike};
    let truncated = value.with_nanosecond(0).unwrap_or(value);
    if truncated.minute() == 0 && truncated.second() == 0 {
        truncated
    } else {
        chrono_tz::Asia::Manila
            .with_ymd_and_hms(
                truncated.year(),
                truncated.month(),
                truncated.day(),
                truncated.hour(),
                0,
                0,
            )
            .single()
            .expect("truncated hour is always valid")
            + chrono::Duration::hours(1)
    }
}
