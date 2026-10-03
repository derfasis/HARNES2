-- Historical samples never establish a public-source checkpoint or contact authority.
CREATE TABLE scout_campaigns (
 id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id), title TEXT NOT NULL,
 topic TEXT NOT NULL, config_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 topic_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','paused')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE scout_candidates (
 id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES scout_campaigns(id), account_id TEXT NOT NULL,
 channel_id TEXT NOT NULL, username TEXT, title TEXT NOT NULL, kind TEXT NOT NULL,
 joined INTEGER NOT NULL DEFAULT 0, origin_json TEXT NOT NULL, sample_id TEXT, reason TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(campaign_id,account_id,channel_id)
);
CREATE TABLE scout_grants (
 id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES scout_campaigns(id), campaign_revision INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('audit','monitor')), account_id TEXT NOT NULL, candidate_id TEXT REFERENCES scout_candidates(id),
 sample_id TEXT, assessment_id TEXT, purpose TEXT NOT NULL, max_lag_seconds INTEGER,
 catchup_from_pts INTEGER CHECK(catchup_from_pts IS NULL OR catchup_from_pts>0),
 checkpoint_fingerprint TEXT CHECK(checkpoint_fingerprint IS NULL OR length(checkpoint_fingerprint)=64),
 accept_historical_gap INTEGER NOT NULL DEFAULT 0 CHECK(accept_historical_gap IN (0,1)),
 expires_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','revoked','expired','stale')),
 created_at TEXT NOT NULL, reason TEXT,
 CHECK((kind='monitor' AND catchup_from_pts IS NOT NULL AND checkpoint_fingerprint IS NOT NULL AND accept_historical_gap=1)
    OR (catchup_from_pts IS NULL AND checkpoint_fingerprint IS NULL AND accept_historical_gap=0))
);
CREATE TRIGGER scout_grant_immutable BEFORE UPDATE OF id,campaign_id,campaign_revision,kind,account_id,candidate_id,sample_id,assessment_id,purpose,max_lag_seconds,catchup_from_pts,checkpoint_fingerprint,accept_historical_gap,expires_at,created_at ON scout_grants
 BEGIN SELECT RAISE(ABORT,'SCOUT_GRANT_IMMUTABLE'); END;
CREATE TABLE scout_jobs (
 id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES scout_campaigns(id), campaign_revision INTEGER NOT NULL,
 grant_id TEXT NOT NULL REFERENCES scout_grants(id), candidate_id TEXT REFERENCES scout_candidates(id),
 kind TEXT NOT NULL CHECK(kind IN ('search','resolve','history','assessment')),
 status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','stale','interrupted')),
 cursor_json TEXT NOT NULL, sample_id TEXT, run_id TEXT, owner_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
 next_at TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX scout_ready_jobs ON scout_jobs(status,next_at,updated_at);
CREATE TABLE scout_samples (
 id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES scout_candidates(id), account_id TEXT NOT NULL,
 source_ref TEXT NOT NULL, requested_from TEXT NOT NULL, requested_until TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('collecting','sealed')), messages_json TEXT NOT NULL DEFAULT '[]',
 coverage TEXT NOT NULL DEFAULT 'unverified', metrics_json TEXT, digest TEXT,
 source_cursor INTEGER NOT NULL DEFAULT 0 CHECK(source_cursor>=0),
 created_at TEXT NOT NULL, finished_at TEXT
);
CREATE TRIGGER scout_sample_immutable BEFORE UPDATE ON scout_samples
 WHEN OLD.status='sealed'
 BEGIN SELECT RAISE(ABORT,'SCOUT_SAMPLE_IMMUTABLE'); END;
CREATE TABLE scout_assessments (
 id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES scout_campaigns(id), campaign_revision INTEGER NOT NULL,
 candidate_id TEXT NOT NULL REFERENCES scout_candidates(id), sample_id TEXT NOT NULL REFERENCES scout_samples(id),
 sample_digest TEXT NOT NULL, topic_hash TEXT NOT NULL, evaluator_version TEXT NOT NULL,
 output_json TEXT NOT NULL, run_id TEXT,
 status TEXT NOT NULL CHECK(status IN ('proposed','approved','rejected','stale')),
 note TEXT, created_at TEXT NOT NULL
);
CREATE TRIGGER scout_assessment_immutable BEFORE UPDATE OF campaign_id,campaign_revision,candidate_id,sample_id,sample_digest,topic_hash,evaluator_version,output_json,run_id,created_at ON scout_assessments
 BEGIN SELECT RAISE(ABORT,'SCOUT_ASSESSMENT_IMMUTABLE'); END;
CREATE TABLE scout_calls (
 id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id), account_id TEXT NOT NULL,
 job_id TEXT NOT NULL REFERENCES scout_jobs(id), source_ref TEXT, operation TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('started','completed','failed','unknown')),
 retry_at TEXT, reason TEXT, created_at TEXT NOT NULL, finished_at TEXT
);
CREATE INDEX scout_call_budget ON scout_calls(partner_id,account_id,created_at);
CREATE INDEX scout_source_revision ON events(partner_id,kind,id);
