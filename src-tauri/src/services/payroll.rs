pub fn floor_zero(value: i64) -> i64 {
    value.max(0)
}

pub fn ceiling_hours(seconds: i64) -> i64 {
    ((seconds.max(0) + 3599) / 3600).max(0)
}
