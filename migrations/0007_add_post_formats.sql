-- Post format rotation: the format each post was generated with, and optional
-- per-account format weights as JSON (NULL = default weights, {} = rotation off).
ALTER TABLE post_history ADD COLUMN format TEXT;
ALTER TABLE accounts ADD COLUMN post_formats TEXT;
