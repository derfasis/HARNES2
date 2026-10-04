-- Inference authority is separate from source read permission and business review.
CREATE TABLE audience_attention_grants (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partners(id),
  goal_id TEXT NOT NULL REFERENCES audience_goals(id),
  goal_revision INTEGER NOT NULL CHECK(goal_revision > 0),
  scope_fingerprint TEXT NOT NULL,
  max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 50),
  expires_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  grant_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  revoked_at TEXT,
  revocation_reason TEXT
);
CREATE INDEX audience_attention_goal ON audience_attention_grants(goal_id,status,expires_at);
CREATE TABLE audience_attention_attempts (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  grant_id TEXT NOT NULL REFERENCES audience_attention_grants(id),
  assessment_id TEXT NOT NULL UNIQUE REFERENCES audience_assessments(id),
  goal_id TEXT NOT NULL REFERENCES audience_goals(id),
  grant_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX audience_attention_usage ON audience_attention_attempts(grant_id);
