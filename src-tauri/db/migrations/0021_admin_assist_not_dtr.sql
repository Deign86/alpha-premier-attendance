-- Admin assist cards are not interns; drop DTR pending rows queued for them.
DELETE FROM dtr_pending
WHERE user_id IN (SELECT user_id FROM users WHERE card_type = 'ADMIN_ASSIST');
