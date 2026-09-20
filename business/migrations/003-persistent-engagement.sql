-- Additive, opt-in engagement loop. Existing rows are never inferred as consent.
CREATE TABLE engagements (
 id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id),
 conversation_id TEXT NOT NULL REFERENCES conversations(id), topic TEXT NOT NULL,
 current_need TEXT NOT NULL, unknowns_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(unknowns_json)),
 close_condition TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','WAITING','HUMAN','CLOSED','STOPPED')),
 revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX engagement_one_live ON engagements(conversation_id) WHERE status NOT IN ('CLOSED','STOPPED');
CREATE TABLE contact_permissions (
 id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id), person_id TEXT NOT NULL REFERENCES persons(id),
 conversation_id TEXT NOT NULL REFERENCES conversations(id), channel TEXT NOT NULL, account_id TEXT,
 purpose TEXT NOT NULL CHECK(purpose IN ('reply','follow_up')), granted_by TEXT NOT NULL,
 evidence TEXT NOT NULL, valid_from TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX permission_scope ON contact_permissions(conversation_id,purpose,revoked_at);
CREATE TABLE engagement_beliefs (
 id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL REFERENCES engagements(id),
 kind TEXT NOT NULL CHECK(kind IN ('CLAIM','HYPOTHESIS','VERIFIED_FACT')), text TEXT NOT NULL,
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), counterevidence_json TEXT NOT NULL CHECK(json_valid(counterevidence_json)),
 verification TEXT, status TEXT NOT NULL CHECK(status IN ('current','superseded','stale','rejected')),
 supersedes_id TEXT REFERENCES engagement_beliefs(id), expires_at TEXT, author TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE engagement_decisions (
 id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL REFERENCES engagements(id), run_id TEXT REFERENCES runs(id),
 engagement_revision INTEGER NOT NULL, conversation_revision INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('ACT','WAIT','IGNORE','HANDOFF','STOP')),
 reason TEXT NOT NULL, evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
 expected_next TEXT NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 strategy_version_id TEXT REFERENCES engagement_strategies(id) DEFERRABLE INITIALLY DEFERRED, status TEXT NOT NULL CHECK(status IN ('current','stale','superseded')),
 author TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX decision_engagement ON engagement_decisions(engagement_id,created_at);
CREATE TABLE engagement_tasks (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id), engagement_id TEXT NOT NULL REFERENCES engagements(id),
 trigger_json TEXT NOT NULL CHECK(json_valid(trigger_json))
);
CREATE TABLE engagement_waits (
 decision_id TEXT PRIMARY KEY REFERENCES engagement_decisions(id), engagement_id TEXT NOT NULL REFERENCES engagements(id),
 events_json TEXT NOT NULL CHECK(json_valid(events_json)), due_at TEXT,
 status TEXT NOT NULL CHECK(status IN ('waiting','satisfied','cancelled')), satisfied_by TEXT, created_at TEXT NOT NULL
);
CREATE TABLE engagement_actions (
 draft_id TEXT PRIMARY KEY REFERENCES drafts(id), decision_id TEXT NOT NULL UNIQUE REFERENCES engagement_decisions(id),
 permission_id TEXT NOT NULL REFERENCES contact_permissions(id), purpose TEXT NOT NULL CHECK(purpose IN ('reply','follow_up')),
 explained_json TEXT NOT NULL CHECK(json_valid(explained_json)), created_at TEXT NOT NULL
);
CREATE TABLE engagement_commitments (
 id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL REFERENCES engagements(id), decision_id TEXT REFERENCES engagement_decisions(id),
 draft_id TEXT REFERENCES drafts(id), text TEXT NOT NULL, owner TEXT NOT NULL CHECK(owner IN ('AI','HUMAN')),
 status TEXT NOT NULL CHECK(status IN ('proposed','open','fulfilled','cancelled')), due_at TEXT,
 due_fired_at TEXT, source_message_id TEXT REFERENCES messages(id), resolution_evidence TEXT, created_at TEXT NOT NULL
);
CREATE TABLE engagement_explanations (
 id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL REFERENCES engagements(id), message_id TEXT NOT NULL REFERENCES messages(id),
 text TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE engagement_handoffs (
 id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL REFERENCES engagements(id), decision_id TEXT REFERENCES engagement_decisions(id),
 status TEXT NOT NULL CHECK(status IN ('requested','accepted','returned','resolved','cancelled')),
 owner TEXT NOT NULL, reason TEXT NOT NULL, packet_json TEXT NOT NULL CHECK(json_valid(packet_json)),
 resolution TEXT, created_at TEXT NOT NULL, accepted_at TEXT, resolved_at TEXT
);
CREATE UNIQUE INDEX handoff_one_live ON engagement_handoffs(engagement_id) WHERE status IN ('requested','accepted');
CREATE TABLE decision_outcomes (
 outcome_id TEXT PRIMARY KEY REFERENCES outcome_events(id), decision_id TEXT NOT NULL REFERENCES engagement_decisions(id),
 attribution TEXT NOT NULL CHECK(attribution IN ('observed_association','human_assisted','unknown')), created_at TEXT NOT NULL
);
CREATE TABLE learning_episodes (
 lesson_id TEXT NOT NULL REFERENCES lessons(id), outcome_id TEXT NOT NULL REFERENCES outcome_events(id),
 role TEXT NOT NULL CHECK(role IN ('evidence','counterexample')), PRIMARY KEY(lesson_id,outcome_id)
);
CREATE TABLE learning_reviews (
 id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL REFERENCES lessons(id), decision TEXT NOT NULL CHECK(decision IN ('activate','reject','retire')),
 evaluation TEXT NOT NULL, limitations TEXT NOT NULL, reviewer TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE engagement_strategies (
 id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL REFERENCES lessons(id), review_id TEXT NOT NULL REFERENCES learning_reviews(id),
 partner_id TEXT NOT NULL REFERENCES partners(id), conversation_id TEXT NOT NULL REFERENCES conversations(id),
 version INTEGER NOT NULL, guidance TEXT NOT NULL, applicability TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('active','retired')), created_at TEXT NOT NULL, UNIQUE(lesson_id,version)
);
