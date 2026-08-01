INSERT OR IGNORE INTO payroll_profiles (profile_id, label, payroll_frequency, standard_working_days_per_cutoff, incentives_allowance_centavos, special_allowance_centavos, special_holiday_multiplier, regular_holiday_multiplier, half_day_fraction, overtime_rate_centavos, created_at, updated_at)
VALUES
  ('JEAN_TENURED', 'Ma''am Jean payroll calculation', 'SEMI_MONTHLY', 11, 660000, 15000, 0.3, 1.0, 0.5, 0, datetime('now'), datetime('now')),
  ('BEA_STANDARD', 'Ma''am Bea payroll calculation', 'SEMI_MONTHLY', 11, 0, 0, 0.3, 1.0, 0.5, 0, datetime('now'), datetime('now'));
