CREATE TABLE discovery_situations (
 id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id),
 source_id TEXT NOT NULL, subject_id TEXT NOT NULL, purpose_id TEXT NOT NULL,
 scope_key TEXT NOT NULL UNIQUE, policy_hash TEXT NOT NULL, purpose_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('active','transferred','stopped','expired','forgotten')),
 revision INTEGER NOT NULL CHECK(revision>0), observation_ids_json TEXT NOT NULL,
 observation_hash TEXT NOT NULL, first_seen_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 expires_at TEXT NOT NULL, not_before TEXT NOT NULL, current_decision_id TEXT,
 engagement_id TEXT REFERENCES engagements(id), closed_reason TEXT, purged_at TEXT
);
CREATE INDEX discovery_due ON discovery_situations(partner_id,status,not_before);
CREATE TABLE discovery_decisions (
 id TEXT PRIMARY KEY, situation_id TEXT NOT NULL REFERENCES discovery_situations(id),
 revision INTEGER NOT NULL, run_id TEXT UNIQUE REFERENCES runs(id),
 input_json TEXT NOT NULL CHECK(json_valid(input_json)), output_json TEXT NOT NULL CHECK(json_valid(output_json)),
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), created_at TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('current','superseded','expired')),
 review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','approved','rejected')),
 UNIQUE(situation_id,revision)
);
CREATE TABLE discovery_reviews (
 id TEXT PRIMARY KEY, situation_id TEXT NOT NULL REFERENCES discovery_situations(id),
 decision_id TEXT NOT NULL REFERENCES discovery_decisions(id), revision INTEGER NOT NULL,
 verdict TEXT NOT NULL CHECK(verdict IN ('approve','reject')), reason TEXT NOT NULL,
 reviewer TEXT NOT NULL CHECK(reviewer='operator'), created_at TEXT NOT NULL
);
CREATE TABLE discovery_suppressions (
 scope_hash TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id),
 reason TEXT NOT NULL, created_at TEXT NOT NULL
);
