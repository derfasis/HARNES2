-- The current decision is an explicit durable head, not the newest parseable
-- audit event. Missing/corrupt later history must never revive an older approval.
CREATE TABLE audience_first_contact_heads (
  need_id TEXT PRIMARY KEY REFERENCES audience_needs(id),
  request_id TEXT UNIQUE,
  event_id INTEGER UNIQUE,
  review_id TEXT UNIQUE,
  CHECK ((request_id IS NULL AND event_id IS NULL AND review_id IS NULL)
    OR (request_id IS NOT NULL AND event_id IS NOT NULL AND review_id IS NOT NULL))
);
