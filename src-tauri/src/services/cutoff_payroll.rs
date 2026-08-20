#[derive(Debug, Clone)]
pub struct CutoffInput {
    pub employee_id: String,
    pub employee_name: String,
    pub cutoff_start: String,
    pub cutoff_end: String,
    pub daily_rate: f64,
    pub standard_working_days: f64,
    pub actual_working_days: f64,
    pub special_holiday_days: f64,
    pub special_holiday_multiplier: f64,
    pub regular_holiday_days: f64,
    pub regular_holiday_multiplier: f64,
    pub incentives_allowance: f64,
    pub special_allowance: f64,
    pub late_deduction: f64,
    pub half_day_count: f64,
    pub half_day_fraction: f64,
    pub absent_days: f64,
    pub overtime_hours: f64,
    pub overtime_rate: f64,
    pub manual_adjustment: f64,
    pub adjustment_reason: Option<String>,
    pub approved_working_day_overage: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CutoffResult {
    pub basic_pay: i64,
    pub total_compensation: i64,
    pub total_allowance: i64,
    pub late_deduction: i64,
    pub half_day_deduction: i64,
    pub absence_deduction: i64,
    pub overtime_pay: i64,
    pub gross_compensation: i64,
    pub net_pay: i64,
}

fn cents(value: f64) -> i64 {
    (value * 100.0).round() as i64
}
fn multiply(value: i64, factor: f64) -> i64 {
    ((value as f64) * factor).round() as i64
}

pub fn calculate(input: &CutoffInput) -> Result<CutoffResult, String> {
    if input.employee_id.trim().is_empty()
        || input.employee_name.trim().is_empty()
        || input.cutoff_start.len() != 10
        || input.cutoff_end.len() != 10
        || input.cutoff_end < input.cutoff_start
    {
        return Err("Employee and valid cutoff dates are required.".into());
    }
    let values = [
        input.daily_rate,
        input.standard_working_days,
        input.actual_working_days,
        input.special_holiday_days,
        input.regular_holiday_days,
        input.incentives_allowance,
        input.special_allowance,
        input.late_deduction,
        input.half_day_count,
        input.half_day_fraction,
        input.absent_days,
        input.overtime_hours,
        input.overtime_rate,
    ];
    if values.iter().any(|v| !v.is_finite() || *v < 0.0)
        || (!input.approved_working_day_overage
            && input.actual_working_days > input.standard_working_days)
    {
        return Err("Payroll values are invalid or require working-day approval.".into());
    }
    if input.manual_adjustment != 0.0
        && input
            .adjustment_reason
            .as_deref()
            .unwrap_or("")
            .trim()
            .is_empty()
    {
        return Err("A manual adjustment reason is required.".into());
    }
    let daily = cents(input.daily_rate);
    let base_days = if input.absent_days > 0.0 {
        input.actual_working_days + input.absent_days
    } else {
        input.actual_working_days
    };
    let basic = (daily as f64 * base_days).round() as i64;
    let special = multiply(
        (daily as f64 * input.special_holiday_days).round() as i64,
        input.special_holiday_multiplier,
    );
    let regular = multiply(
        (daily as f64 * input.regular_holiday_days).round() as i64,
        input.regular_holiday_multiplier,
    );
    let allowance = cents(input.incentives_allowance) + cents(input.special_allowance);
    let half = multiply(
        (daily as f64 * input.half_day_count).round() as i64,
        input.half_day_fraction,
    );
    let absence = (daily as f64 * input.absent_days).round() as i64;
    let overtime = multiply(cents(input.overtime_rate), input.overtime_hours);
    let late = cents(input.late_deduction);
    let gross = basic + special + regular + allowance + overtime + cents(input.manual_adjustment)
        - late
        - half
        - absence;
    Ok(CutoffResult {
        basic_pay: basic,
        total_compensation: basic + special + regular,
        total_allowance: allowance,
        late_deduction: late,
        half_day_deduction: half,
        absence_deduction: absence,
        overtime_pay: overtime,
        gross_compensation: gross,
        net_pay: gross,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn computes_cutoff_in_centavos() {
        let result = calculate(&CutoffInput {
            employee_id: "e".into(),
            employee_name: "A".into(),
            cutoff_start: "2026-07-01".into(),
            cutoff_end: "2026-07-15".into(),
            daily_rate: 1000.0,
            standard_working_days: 11.0,
            actual_working_days: 10.0,
            special_holiday_days: 0.0,
            special_holiday_multiplier: 0.3,
            regular_holiday_days: 0.0,
            regular_holiday_multiplier: 1.0,
            incentives_allowance: 100.0,
            special_allowance: 0.0,
            late_deduction: 50.0,
            half_day_count: 0.0,
            half_day_fraction: 0.5,
            absent_days: 0.0,
            overtime_hours: 0.0,
            overtime_rate: 0.0,
            manual_adjustment: 0.0,
            adjustment_reason: None,
            approved_working_day_overage: false,
        })
        .unwrap();
        assert_eq!(result.net_pay, 1000000 + 10000 - 5000);
    }

    #[test]
    fn computes_partial_intern_cutoff_with_absent_days() {
        let result = calculate(&CutoffInput {
            employee_id: "APG-2026-102".into(),
            employee_name: "Deign Grey O. Lazaro".into(),
            cutoff_start: "2026-08-16".into(),
            cutoff_end: "2026-08-31".into(),
            daily_rate: 80.0,
            standard_working_days: 11.0,
            actual_working_days: 1.0,
            special_holiday_days: 0.0,
            special_holiday_multiplier: 0.0,
            regular_holiday_days: 0.0,
            regular_holiday_multiplier: 0.0,
            incentives_allowance: 0.0,
            special_allowance: 0.0,
            late_deduction: 0.0,
            half_day_count: 0.0,
            half_day_fraction: 0.5,
            absent_days: 10.0,
            overtime_hours: 0.0,
            overtime_rate: 0.0,
            manual_adjustment: 0.0,
            adjustment_reason: None,
            approved_working_day_overage: false,
        })
        .unwrap();
        assert_eq!(result.basic_pay, 88_000);
        assert_eq!(result.total_compensation, 88_000);
        assert_eq!(result.absence_deduction, 80_000);
        assert_eq!(result.gross_compensation, 8_000);
        assert_eq!(result.net_pay, 8_000);
    }
}
