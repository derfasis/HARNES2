-- Outcome v2: source time, immutable delivery provenance, per-window identity.
-- The two published candidate versions of 008 are both upgraded conservatively:
-- their scalar coverage never proved a completed interval.
ALTER TABLE messages ADD COLUMN occurred_at TEXT;
ALTER TABLE messages ADD COLUMN time_basis TEXT NOT NULL DEFAULT 'recorded'
 CHECK(time_basis IN ('recorded','source','owner_attested'));
PRAGMA defer_foreign_keys=ON;
CREATE TABLE outcome_windows_v2 (
 id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id),
 conversation_id TEXT NOT NULL REFERENCES conversations(id), message_id TEXT NOT NULL REFERENCES messages(id),
 draft_id TEXT REFERENCES drafts(id), draft_version INTEGER, decision_id TEXT REFERENCES engagement_decisions(id),
 engagement_id TEXT REFERENCES engagements(id), delivery_attempt_id TEXT REFERENCES delivery_attempts(id),
 opened_at TEXT NOT NULL, closes_at TEXT NOT NULL,
 time_basis TEXT NOT NULL CHECK(time_basis IN ('recorded','source','owner_attested')),
 coverage TEXT NOT NULL DEFAULT 'unverified' CHECK(coverage IN ('continuous','gapped','unverified')),
 coverage_event_id INTEGER REFERENCES events(id),
 outcome TEXT NOT NULL CHECK(outcome IN ('pending','answered','expired_unanswered','superseded','unknown')),
 answered_at TEXT, candidate_id TEXT REFERENCES outcome_candidates_v2(id), created_at TEXT NOT NULL,
 UNIQUE(partner_id,message_id)
);
CREATE TABLE outcome_candidates_v2 (
 id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id), conversation_id TEXT NOT NULL REFERENCES conversations(id),
 engagement_id TEXT REFERENCES engagements(id),
 kind TEXT NOT NULL CHECK(kind IN ('reply_observed','reaction_observed','no_response_observed','engagement_closed','owner_booking_claimed','owner_outcome_stated')),
 detector TEXT NOT NULL, detector_version INTEGER NOT NULL, basis TEXT NOT NULL,
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), source_message_id TEXT REFERENCES messages(id),
 draft_id TEXT REFERENCES drafts(id), decision_id TEXT REFERENCES engagement_decisions(id),
 window_id TEXT REFERENCES outcome_windows_v2(id), draft_version INTEGER, basis_fingerprint TEXT,
 observed_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','rejected','superseded','unknown')),
 outcome_id TEXT REFERENCES outcome_events(id), resolution_note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1
);
INSERT INTO outcome_windows_v2
 SELECT w.id,w.partner_id,w.conversation_id,w.message_id,w.draft_id,d.current_version,a.decision_id,e.id,
 (SELECT da.id FROM delivery_attempts da WHERE da.draft_id=w.draft_id AND da.status='sent' ORDER BY da.created_at DESC,da.rowid DESC LIMIT 1),
 w.opened_at,w.closes_at,'recorded','unverified',NULL,
 CASE WHEN w.outcome='expired_unanswered' THEN 'unknown'
 WHEN w.outcome='answered' AND EXISTS(SELECT 1 FROM outcome_candidates c WHERE c.id=w.candidate_id AND c.status='pending') THEN 'pending'
 ELSE w.outcome END,
 CASE WHEN EXISTS(SELECT 1 FROM outcome_candidates c WHERE c.id=w.candidate_id AND c.status='pending') THEN NULL ELSE w.answered_at END,
 CASE WHEN EXISTS(SELECT 1 FROM outcome_candidates c WHERE c.id=w.candidate_id AND c.status='pending') THEN NULL ELSE w.candidate_id END,w.created_at
 FROM outcome_observation_windows w LEFT JOIN drafts d ON d.id=w.draft_id
 LEFT JOIN engagement_actions a ON a.draft_id=w.draft_id
 LEFT JOIN engagement_decisions ed ON ed.id=a.decision_id LEFT JOIN engagements e ON e.id=ed.engagement_id;
INSERT INTO outcome_candidates_v2
 SELECT c.id,c.partner_id,c.conversation_id,c.engagement_id,c.kind,c.detector,c.detector_version,c.basis,c.evidence_json,
 c.source_message_id,c.draft_id,c.decision_id,
 (SELECT w.id FROM outcome_observation_windows w WHERE w.candidate_id=c.id LIMIT 1),NULL,NULL,
 c.observed_at,CASE WHEN c.status='pending' THEN 'superseded' ELSE c.status END,c.outcome_id,
 CASE WHEN c.status='pending' THEN 'DETECTOR_VERSION_CHANGED' ELSE c.resolution_note END,c.created_at,c.updated_at,
 c.revision+CASE WHEN c.status='pending' THEN 1 ELSE 0 END FROM outcome_candidates c;
DROP TABLE outcome_observation_windows;
DROP TABLE outcome_candidates;
ALTER TABLE outcome_windows_v2 RENAME TO outcome_observation_windows;
ALTER TABLE outcome_candidates_v2 RENAME TO outcome_candidates;
CREATE UNIQUE INDEX outcome_candidate_window_identity ON outcome_candidates(partner_id,window_id,detector,detector_version,kind,basis_fingerprint) WHERE window_id IS NOT NULL;
CREATE UNIQUE INDEX outcome_candidate_message_identity ON outcome_candidates(partner_id,conversation_id,detector,detector_version,source_message_id,kind) WHERE window_id IS NULL AND source_message_id IS NOT NULL;
CREATE INDEX outcome_candidate_queue ON outcome_candidates(partner_id,status,id);
CREATE INDEX outcome_candidate_evidence ON outcome_candidates(partner_id,conversation_id,id);
CREATE INDEX outcome_window_queue ON outcome_observation_windows(partner_id,id) WHERE outcome IN ('pending','unknown','expired_unanswered');
CREATE INDEX outcome_reply_time ON messages(conversation_id,direction,COALESCE(occurred_at,created_at),id);
