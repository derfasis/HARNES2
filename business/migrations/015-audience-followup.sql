-- Owner authority for one need revision and one fresh, displayed evidence packet.
CREATE TABLE audience_followup_requests (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partners(id),
  goal_id TEXT NOT NULL REFERENCES audience_goals(id),
  assessment_id TEXT NOT NULL UNIQUE REFERENCES audience_assessments(id),
  definition_json TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64),
  model_profile_id TEXT NOT NULL REFERENCES model_profiles(id),
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  revoked_at TEXT,
  revocation_reason TEXT,
  CHECK((status='active' AND revoked_at IS NULL AND revocation_reason IS NULL)
    OR (status='revoked' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL))
);
CREATE INDEX audience_followup_pending ON audience_followup_requests(partner_id,goal_id,status,expires_at);
CREATE TABLE audience_followup_attempts (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  request_id TEXT NOT NULL UNIQUE REFERENCES audience_followup_requests(id),
  assessment_id TEXT NOT NULL UNIQUE REFERENCES audience_assessments(id),
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64),
  created_at TEXT NOT NULL
);
