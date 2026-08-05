-- Adds an optional gender field to the users register so the kiosk can greet
-- employees with the right honorific (Sir/Ma'am). Existing rows stay NULL
-- (unset) and the kiosk falls back to "Sir" until an admin sets it.
ALTER TABLE users ADD COLUMN gender TEXT CHECK (gender IN ('MALE', 'FEMALE'));
