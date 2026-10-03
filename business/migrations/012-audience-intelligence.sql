-- Interpretations of bounded public exchanges. No person/contact/effect authority.
CREATE TABLE audience_goals (
 id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id), title TEXT NOT NULL,
 objective TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 status TEXT NOT NULL CHECK(status IN ('OPEN','PAUSED')),
 max_age_seconds INTEGER NOT NULL CHECK(max_age_seconds BETWEEN 60 AND 2592000),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE audience_watches (
 goal_id TEXT NOT NULL REFERENCES audience_goals(id), source_ref TEXT NOT NULL, policy_hash TEXT NOT NULL,
 cursor INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL CHECK(status IN ('active','revoked')),
 reason TEXT, PRIMARY KEY(goal_id,source_ref)
);
CREATE TABLE audience_exchanges (
 id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES audience_goals(id), source_ref TEXT NOT NULL,
 anchor_id TEXT NOT NULL, member_ids_json TEXT NOT NULL, fingerprint TEXT NOT NULL, state_json TEXT NOT NULL,
 last_event_id INTEGER NOT NULL, considered_fingerprint TEXT, overflow INTEGER NOT NULL DEFAULT 0 CHECK(overflow IN (0,1)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(goal_id,source_ref,anchor_id)
);
CREATE INDEX audience_exchange_queue ON audience_exchanges(goal_id,source_ref,last_event_id);
CREATE TABLE audience_assessments (
 id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES audience_goals(id), basis_fingerprint TEXT NOT NULL,
 packet_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('captured','running','proposed','stale','interrupted','invalid')),
 producer TEXT NOT NULL, run_id TEXT REFERENCES runs(id), output_json TEXT,
 created_at TEXT NOT NULL, UNIQUE(goal_id,basis_fingerprint)
);
CREATE TABLE audience_needs (
 id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES audience_goals(id), assessment_id TEXT NOT NULL REFERENCES audience_assessments(id),
 revision INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL CHECK(status IN ('proposed','accepted','rejected','stale')),
 output_json TEXT NOT NULL, basis_json TEXT NOT NULL, review_note TEXT, reviewed_at TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX audience_need_goal ON audience_needs(goal_id,status);
CREATE TABLE audience_work_links (
 thread_id TEXT PRIMARY KEY REFERENCES partner_threads(id), need_id TEXT NOT NULL UNIQUE REFERENCES audience_needs(id),
 need_revision INTEGER NOT NULL, basis_json TEXT NOT NULL, created_at TEXT NOT NULL
);
