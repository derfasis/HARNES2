-- Finite model authority for one explicit assessment of one sealed Scout sample.
-- This does not change the independent Telegram audit grant.
CREATE TABLE scout_model_requests (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partners(id),
  job_id TEXT NOT NULL UNIQUE REFERENCES scout_jobs(id),
  run_id TEXT UNIQUE REFERENCES runs(id),
  model_profile_id TEXT NOT NULL REFERENCES model_profiles(id),
  definition_json TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64),
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  revoked_at TEXT,
  revocation_reason TEXT,
  CHECK((status='active' AND revoked_at IS NULL AND revocation_reason IS NULL)
    OR (status='revoked' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL))
);
CREATE INDEX scout_model_requests_pending ON scout_model_requests(partner_id,status,expires_at);
CREATE TRIGGER scout_model_request_immutable BEFORE UPDATE OF id,partner_id,job_id,model_profile_id,definition_json,request_fingerprint,expires_at ON scout_model_requests
 BEGIN SELECT RAISE(ABORT,'SCOUT_MODEL_REQUEST_IMMUTABLE'); END;
CREATE TRIGGER scout_model_request_update_guard BEFORE UPDATE ON scout_model_requests
 WHEN (OLD.run_id IS NOT NULL AND NEW.run_id IS NOT OLD.run_id)
   OR (OLD.run_id IS NULL AND NEW.run_id IS NOT NULL AND (length(NEW.run_id)<>36 OR OLD.status<>'active'))
   OR (OLD.status='revoked' AND NEW.status<>'revoked')
   OR (OLD.status='revoked' AND (NEW.revoked_at IS NOT OLD.revoked_at OR NEW.revocation_reason IS NOT OLD.revocation_reason))
   OR (NEW.status='revoked' AND (NEW.revoked_at IS NULL OR NEW.revocation_reason IS NULL))
 BEGIN SELECT RAISE(ABORT,'SCOUT_MODEL_REQUEST_STATE_INVALID'); END;
CREATE TRIGGER scout_model_request_no_delete BEFORE DELETE ON scout_model_requests
 BEGIN SELECT RAISE(ABORT,'SCOUT_MODEL_REQUEST_IMMUTABLE'); END;
