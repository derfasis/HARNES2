-- Durable, bounded discovery state exists before a CRM conversation is authorized.
-- Source text remains in the immutable source event log; this table stores only scoped references.
CREATE TABLE discovery_situations (
 id TEXT PRIMARY KEY,
 partner_id TEXT NOT NULL REFERENCES partners(id),
 source_ref TEXT NOT NULL,
 source_kind TEXT NOT NULL CHECK(source_kind IN ('sanitized_fixture','live_snapshot')),
 subject_ref TEXT NOT NULL,
 context_key TEXT NOT NULL,
 purpose TEXT NOT NULL,
 offer_fingerprint TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'OBSERVING' CHECK(status IN ('OBSERVING','CANDIDATE','DISMISSED','STALE','TRANSFERRED')),
 revision INTEGER NOT NULL DEFAULT 0,
 expires_at TEXT NOT NULL,
 transferred_engagement_id TEXT REFERENCES engagements(id),
 created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX discovery_one_live_scope ON discovery_situations(partner_id, source_ref, subject_ref, context_key, purpose, offer_fingerprint)
 WHERE status IN ('OBSERVING','CANDIDATE');
CREATE INDEX discovery_situation_live ON discovery_situations(partner_id, status, updated_at);
CREATE TABLE discovery_evidence (
 id TEXT PRIMARY KEY,
 situation_id TEXT NOT NULL REFERENCES discovery_situations(id),
 source_event_id INTEGER NOT NULL REFERENCES events(id),
 message_id TEXT NOT NULL,
 message_version INTEGER NOT NULL CHECK(message_version >= 1),
 created_at TEXT NOT NULL,
 UNIQUE(situation_id, source_event_id)
);
CREATE INDEX discovery_evidence_situation ON discovery_evidence(situation_id, created_at);
