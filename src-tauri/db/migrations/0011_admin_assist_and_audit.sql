-- Migration 0010: Add admin assist card type, audit trail columns, and schema triggers

ALTER TABLE users ADD COLUMN card_type TEXT NOT NULL DEFAULT 'EMPLOYEE' CHECK (card_type IN ('EMPLOYEE', 'ADMIN_ASSIST'));

ALTER TABLE attendance ADD COLUMN recorded_by TEXT;
ALTER TABLE attendance ADD COLUMN recorded_reason TEXT;
ALTER TABLE attendance ADD COLUMN recorded_at TEXT;

CREATE TRIGGER IF NOT EXISTS trg_prevent_admin_card_attendance
BEFORE INSERT ON attendance
FOR EACH ROW
WHEN EXISTS (
    SELECT 1 FROM users
    WHERE users.user_id = NEW.user_id
      AND users.card_type = 'ADMIN_ASSIST'
)
BEGIN
    SELECT RAISE(ABORT, 'Cannot record attendance for admin assist card');
END;

CREATE TRIGGER IF NOT EXISTS trg_prevent_admin_card_attendance_update
BEFORE UPDATE OF user_id ON attendance
FOR EACH ROW
WHEN EXISTS (
    SELECT 1 FROM users
    WHERE users.user_id = NEW.user_id
      AND users.card_type = 'ADMIN_ASSIST'
)
BEGIN
    SELECT RAISE(ABORT, 'Cannot record attendance for admin assist card');
END;
