-- Convert Ma'am Bea before removing the legacy employee scope.
-- BEA_STANDARD is the historical payroll profile assigned to her employee row.
-- The name fallback is only used when there is exactly one employee row whose
-- name contains "bea", avoiding a broad accidental conversion.
UPDATE users
SET employee_type = 'INTERN',
    daily_rate_centavos = NULL,
    payroll_profile_id = NULL,
    revision = revision + 1,
    updated_at = datetime('now')
WHERE employee_type = 'EMPLOYEE'
  AND (
    payroll_profile_id = 'BEA_STANDARD'
    OR (
      lower(full_name) LIKE '%bea%'
      AND 1 = (
        SELECT COUNT(*)
        FROM users
        WHERE employee_type = 'EMPLOYEE'
          AND lower(full_name) LIKE '%bea%'
      )
    )
  );

-- Remove payroll generated under the employee-only rules.
DELETE FROM payroll_cutoffs
WHERE employee_id IN (SELECT user_id FROM users WHERE employee_type = 'EMPLOYEE');

DELETE FROM payroll
WHERE user_id IN (SELECT user_id FROM users WHERE employee_type = 'EMPLOYEE');

-- Remove dependent operational rows for remaining legacy employees before
-- deleting those user records. Bea is no longer matched because she is INTERN.
DELETE FROM bathroom_log
WHERE user_id IN (SELECT user_id FROM users WHERE employee_type = 'EMPLOYEE');

DELETE FROM intern_grace
WHERE user_id IN (SELECT user_id FROM users WHERE employee_type = 'EMPLOYEE');

DELETE FROM dtr_pending
WHERE user_id IN (SELECT user_id FROM users WHERE employee_type = 'EMPLOYEE');

DELETE FROM dtr_recon_discrepancies
WHERE user_id IN (SELECT user_id FROM users WHERE employee_type = 'EMPLOYEE');

DELETE FROM voice_jobs
WHERE person_id IN (SELECT user_id FROM users WHERE employee_type = 'EMPLOYEE');

DELETE FROM attendance
WHERE user_id IN (SELECT user_id FROM users WHERE employee_type = 'EMPLOYEE');

DELETE FROM users WHERE employee_type = 'EMPLOYEE';

-- Configurable employee payroll profiles no longer belong to the intern-only app.
DELETE FROM payroll_profiles;
