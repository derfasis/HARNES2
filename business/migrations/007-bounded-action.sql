CREATE TABLE action_proposals (
 id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id), thread_id TEXT NOT NULL REFERENCES partner_threads(id),
 turn_id TEXT NOT NULL REFERENCES partner_turns(id), revision INTEGER NOT NULL DEFAULT 1,
 basis_fingerprint TEXT NOT NULL, authority_hash TEXT NOT NULL, packet_json TEXT NOT NULL CHECK(json_valid(packet_json)),
 proposal_json TEXT CHECK(proposal_json IS NULL OR json_valid(proposal_json)), proposal_hash TEXT UNIQUE,
 title TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN
 ('plan_requested','planning','proposed','authorized','verifying','completed','unknown','failed','revoked','rejected','stale','no_action')),
 run_id TEXT REFERENCES runs(id), task_id TEXT UNIQUE REFERENCES tasks(id), verify_requested INTEGER NOT NULL DEFAULT 0 CHECK(verify_requested IN (0,1)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX action_queue ON action_proposals(partner_id,status,id);
CREATE TABLE action_grants (
 id TEXT PRIMARY KEY, action_id TEXT NOT NULL REFERENCES action_proposals(id), version INTEGER NOT NULL,
 proposal_hash TEXT NOT NULL, authority_hash TEXT NOT NULL, basis_fingerprint TEXT NOT NULL,
 expires_at TEXT NOT NULL, max_attempts INTEGER NOT NULL DEFAULT 1 CHECK(max_attempts=1),
 status TEXT NOT NULL CHECK(status IN ('active','consumed','revoked','expired','stale')),
 reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(action_id,version)
);
CREATE UNIQUE INDEX action_one_grant ON action_grants(action_id) WHERE status='active';
CREATE TABLE action_attempts (
 id TEXT PRIMARY KEY, action_id TEXT NOT NULL REFERENCES action_proposals(id), grant_id TEXT NOT NULL UNIQUE REFERENCES action_grants(id),
 status TEXT NOT NULL CHECK(status IN ('prepared','dispatching','returned','unknown','not_executed')),
 receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
 verification_state TEXT NOT NULL DEFAULT 'unchecked' CHECK(verification_state IN ('unchecked','present','absent','mismatch','unavailable')),
 verification_json TEXT CHECK(verification_json IS NULL OR json_valid(verification_json)),
 created_at TEXT NOT NULL, finished_at TEXT, verified_at TEXT
);
CREATE INDEX action_attempt_queue ON action_attempts(action_id,created_at);
