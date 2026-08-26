#[derive(Debug, Clone)]
pub struct CutoffInput {
    pub employee_id: String,
    pub employee_name: String,
    pub cutoff_start: String,
    pub cutoff_end: String,
    pub daily_rate: f64,
    pub standard_working_days: f64,
    pub actual_working_days: f64,
    pub basic_pay: Option<f64>,
    pub special_holiday_days: f64,
    pub special_holiday_multiplier: f64,
    pub special_holiday_pay: Option<f64>,
    pub regular_holiday_days: f64,
    pub regular_holiday_multiplier: f64,
    pub regular_holiday_pay: Option<f64>,
    pub hra: f64,
    pub incentives_allowance: f64,
    pub special_allowance: f64,
    pub late_deduction: f64,
    pub half_day_count: f64,
    pub half_day_fraction: f64,
    pub absent_days: f64,
    pub absence_deduction: Option<f64>,
    pub overtime_hours: f64,
    pub overtime_rate: f64,
    pub overtime_pay: Option<f64>,
    pub sss_employee_share: f64,
    pub phic_employee_share: f64,
    pub hdmf_employee_share: f64,
    pub salary_advance: f64,
    pub manual_adjustment: f64,
    pub adjustment_reason: Option<String>,
    pub approved_working_day_overage: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CutoffResult {
    pub basic_pay: i64,
    pub hra: i64,
    pub incentives_allowance: i64,
    pub special_allowance: i64,
    pub special_holiday_pay: i64,
    pub regular_holiday_pay: i64,
    pub total_compensation: i64,
    pub total_allowance: i64,
    pub late_deduction: i64,
    pub half_day_deduction: i64,
    pub absence_deduction: i64,
    pub overtime_pay: i64,
    pub sss_employee_share: i64,
    pub phic_employee_share: i64,
    pub hdmf_employee_share: i64,
    pub salary_advance: i64,
    pub total_deductions: i64,
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
    let mut values = vec![
        input.daily_rate,
        input.standard_working_days,
        input.actual_working_days,
        input.special_holiday_days,
        input.regular_holiday_days,
        input.hra,
        input.incentives_allowance,
        input.special_allowance,
        input.late_deduction,
        input.half_day_count,
        input.half_day_fraction,
        input.absent_days,
        input.overtime_hours,
        input.overtime_rate,
        input.sss_employee_share,
        input.phic_employee_share,
        input.hdmf_employee_share,
        input.salary_advance,
    ];
    if let Some(bp) = input.basic_pay {
        values.push(bp);
    }
    if let Some(shp) = input.special_holiday_pay {
        values.push(shp);
    }
    if let Some(rhp) = input.regular_holiday_pay {
        values.push(rhp);
    }
    if let Some(ad) = input.absence_deduction {
        values.push(ad);
    }
    if let Some(op) = input.overtime_pay {
        values.push(op);
    }
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
    let basic = input
        .basic_pay
        .map(cents)
        .unwrap_or_else(|| (daily as f64 * base_days).round() as i64);
    let special = input.special_holiday_pay.map(cents).unwrap_or_else(|| {
        multiply(
            (daily as f64 * input.special_holiday_days).round() as i64,
            input.special_holiday_multiplier,
        )
    });
    let regular = input.regular_holiday_pay.map(cents).unwrap_or_else(|| {
        multiply(
            (daily as f64 * input.regular_holiday_days).round() as i64,
            input.regular_holiday_multiplier,
        )
    });
    let hra = cents(input.hra);
    let incentives = cents(input.incentives_allowance);
    let special_allowance = cents(input.special_allowance);
    let allowance = incentives + special_allowance + hra;
    let half = multiply(
        (daily as f64 * input.half_day_count).round() as i64,
        input.half_day_fraction,
    );
    let absence = input
        .absence_deduction
        .map(cents)
        .unwrap_or_else(|| (daily as f64 * input.absent_days).round() as i64);
    let overtime = input
        .overtime_pay
        .map(cents)
        .unwrap_or_else(|| multiply(cents(input.overtime_rate), input.overtime_hours));
    let late = cents(input.late_deduction);
    let sss = cents(input.sss_employee_share);
    let phic = cents(input.phic_employee_share);
    let hdmf = cents(input.hdmf_employee_share);
    let salary_advance = cents(input.salary_advance);

    let gross = basic
        + special
        + regular
        + allowance
        + overtime
        + cents(input.manual_adjustment);
    let total_deductions = late + half + absence + sss + phic + hdmf + salary_advance;
    let net = gross - total_deductions;

    Ok(CutoffResult {
        basic_pay: basic,
        hra,
        incentives_allowance: incentives,
        special_allowance,
        special_holiday_pay: special,
        regular_holiday_pay: regular,
        total_compensation: basic + special + regular,
        total_allowance: allowance,
        late_deduction: late,
        half_day_deduction: half,
        absence_deduction: absence,
        overtime_pay: overtime,
        sss_employee_share: sss,
        phic_employee_share: phic,
        hdmf_employee_share: hdmf,
        salary_advance,
        total_deductions,
        gross_compensation: gross,
        net_pay: net,
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
            basic_pay: None,
            special_holiday_days: 0.0,
            special_holiday_multiplier: 0.3,
            special_holiday_pay: None,
            regular_holiday_days: 0.0,
            regular_holiday_multiplier: 1.0,
            regular_holiday_pay: None,
            hra: 0.0,
            incentives_allowance: 100.0,
            special_allowance: 0.0,
            late_deduction: 50.0,
            half_day_count: 0.0,
            half_day_fraction: 0.5,
            absent_days: 0.0,
            absence_deduction: None,
            overtime_hours: 0.0,
            overtime_rate: 0.0,
            overtime_pay: None,
            sss_employee_share: 0.0,
            phic_employee_share: 0.0,
            hdmf_employee_share: 0.0,
            salary_advance: 0.0,
            manual_adjustment: 0.0,
            adjustment_reason: None,
            approved_working_day_overage: false,
        })
        .unwrap();
        assert_eq!(result.gross_compensation, 1000000 + 10000);
        assert_eq!(result.total_deductions, 5000);
        assert_eq!(result.net_pay, 1000000 + 10000 - 5000);
    }

    #[test]
    fn computes_cutoff_with_all_editable_earnings_and_deductions() {
        let result = calculate(&CutoffInput {
            employee_id: "APGCO-25-013".into(),
            employee_name: "CHICO, JEAN ASHLEY".into(),
            cutoff_start: "2026-06-01".into(),
            cutoff_end: "2026-06-15".into(),
            daily_rate: 705.0,
            standard_working_days: 11.0,
            actual_working_days: 11.0,
            basic_pay: Some(7755.0),
            special_holiday_days: 1.0,
            special_holiday_multiplier: 0.3,
            special_holiday_pay: Some(211.50),
            regular_holiday_days: 0.0,
            regular_holiday_multiplier: 1.0,
            regular_holiday_pay: None,
            hra: 500.0,
            incentives_allowance: 6600.0,
            special_allowance: 150.0,
            late_deduction: 100.0,
            half_day_count: 0.0,
            half_day_fraction: 0.5,
            absent_days: 0.0,
            absence_deduction: None,
            overtime_hours: 2.0,
            overtime_rate: 100.0,
            overtime_pay: Some(200.0),
            sss_employee_share: 450.0,
            phic_employee_share: 200.0,
            hdmf_employee_share: 100.0,
            salary_advance: 1000.0,
            manual_adjustment: 0.0,
            adjustment_reason: None,
            approved_working_day_overage: true,
        })
        .unwrap();

        // Basic (7755) + HRA (500) + Inc (6600) + Spec Allow (150) + Spec Hol (211.50) + OT (200) = 15416.50
        assert_eq!(result.basic_pay, 775_500);
        assert_eq!(result.hra, 50_000);
        assert_eq!(result.incentives_allowance, 660_000);
        assert_eq!(result.special_allowance, 15_000);
        assert_eq!(result.total_allowance, 725_000);
        assert_eq!(result.special_holiday_pay, 21_150);
        assert_eq!(result.overtime_pay, 20_000);
        assert_eq!(result.gross_compensation, 1_541_650);

        // Deductions: Late (100) + SSS (450) + PHIC (200) + HDMF (100) + Advance (1000) = 1850.00
        assert_eq!(result.total_deductions, 185_000);

        // Net: 15416.50 - 1850.00 = 13566.50
        assert_eq!(result.net_pay, 1_356_650);
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
            basic_pay: None,
            special_holiday_days: 0.0,
            special_holiday_multiplier: 0.0,
            special_holiday_pay: None,
            regular_holiday_days: 0.0,
            regular_holiday_multiplier: 0.0,
            regular_holiday_pay: None,
            hra: 0.0,
            incentives_allowance: 0.0,
            special_allowance: 0.0,
            late_deduction: 0.0,
            half_day_count: 0.0,
            half_day_fraction: 0.5,
            absent_days: 10.0,
            absence_deduction: None,
            overtime_hours: 0.0,
            overtime_rate: 0.0,
            overtime_pay: None,
            sss_employee_share: 0.0,
            phic_employee_share: 0.0,
            hdmf_employee_share: 0.0,
            salary_advance: 0.0,
            manual_adjustment: 0.0,
            adjustment_reason: None,
            approved_working_day_overage: false,
        })
        .unwrap();
        assert_eq!(result.basic_pay, 88_000);
        assert_eq!(result.total_compensation, 88_000);
        assert_eq!(result.absence_deduction, 80_000);
        assert_eq!(result.gross_compensation, 88_000);
        assert_eq!(result.total_deductions, 80_000);
        assert_eq!(result.net_pay, 8_000);
    }

    #[test]
    fn computes_intern_cutoff_with_half_day_and_absent_days() {
        let result = calculate(&CutoffInput {
            employee_id: "APG-2026-103".into(),
            employee_name: "Alex Cruz".into(),
            cutoff_start: "2026-08-16".into(),
            cutoff_end: "2026-08-31".into(),
            daily_rate: 80.0,
            standard_working_days: 11.0,
            actual_working_days: 3.0,
            basic_pay: None,
            special_holiday_days: 0.0,
            special_holiday_multiplier: 0.0,
            special_holiday_pay: None,
            regular_holiday_days: 0.0,
            regular_holiday_multiplier: 0.0,
            regular_holiday_pay: None,
            hra: 0.0,
            incentives_allowance: 0.0,
            special_allowance: 0.0,
            late_deduction: 0.0,
            half_day_count: 1.0,
            half_day_fraction: 0.5,
            absent_days: 8.0,
            absence_deduction: None,
            overtime_hours: 0.0,
            overtime_rate: 0.0,
            overtime_pay: None,
            sss_employee_share: 0.0,
            phic_employee_share: 0.0,
            hdmf_employee_share: 0.0,
            salary_advance: 0.0,
            manual_adjustment: 0.0,
            adjustment_reason: None,
            approved_working_day_overage: false,
        })
        .unwrap();
        assert_eq!(result.basic_pay, 88_000);
        assert_eq!(result.total_compensation, 88_000);
        assert_eq!(result.half_day_deduction, 4_000);
        assert_eq!(result.absence_deduction, 64_000);
        assert_eq!(result.total_deductions, 68_000);
        assert_eq!(result.net_pay, 20_000);
    }
}
