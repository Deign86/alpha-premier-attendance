-- Migration 0009: Add employee payslip detail fields, statutory deductions, and intern half-day tracking

ALTER TABLE users ADD COLUMN tin TEXT;
ALTER TABLE users ADD COLUMN bank_name TEXT NOT NULL DEFAULT 'CASH';
ALTER TABLE users ADD COLUMN account_number TEXT NOT NULL DEFAULT '0000';
ALTER TABLE users ADD COLUMN designation TEXT;

ALTER TABLE payroll ADD COLUMN is_half_day INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payroll ADD COLUMN half_day_deduction_centavos INTEGER NOT NULL DEFAULT 0;

ALTER TABLE payroll_cutoffs ADD COLUMN hra_centavos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payroll_cutoffs ADD COLUMN sss_centavos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payroll_cutoffs ADD COLUMN phic_centavos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payroll_cutoffs ADD COLUMN hdmf_centavos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payroll_cutoffs ADD COLUMN salary_advance_centavos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payroll_cutoffs ADD COLUMN tin TEXT NOT NULL DEFAULT '';
ALTER TABLE payroll_cutoffs ADD COLUMN bank_name TEXT NOT NULL DEFAULT 'CASH';
ALTER TABLE payroll_cutoffs ADD COLUMN account_number TEXT NOT NULL DEFAULT '0000';
ALTER TABLE payroll_cutoffs ADD COLUMN department TEXT NOT NULL DEFAULT '';
ALTER TABLE payroll_cutoffs ADD COLUMN designation TEXT NOT NULL DEFAULT '';
