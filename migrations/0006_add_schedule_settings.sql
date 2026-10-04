-- Per-account schedule settings: the frequency (preset or cron) and the active
-- hours window are evaluated in `timezone`; each post is delayed by a random
-- 0..jitter_minutes offset after its scheduled slot.
ALTER TABLE accounts ADD COLUMN timezone TEXT DEFAULT 'Europe/Istanbul';
ALTER TABLE accounts ADD COLUMN active_hours TEXT DEFAULT '07:00-23:00';
ALTER TABLE accounts ADD COLUMN jitter_minutes INTEGER DEFAULT 15;

-- Accounts with a custom cron expression were written against UTC: keep them on
-- UTC and without an active-hours window so their posting times do not move.
UPDATE accounts
SET timezone = 'UTC', active_hours = NULL
WHERE frequency IS NOT NULL
  AND TRIM(frequency) != ''
  AND frequency NOT IN ('hourly', 'every_2_hours', 'twice_a_day', 'daily');
