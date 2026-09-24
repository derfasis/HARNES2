-- Discovery transfers responsibility; it does not confer authority or create CRM evidence.
CREATE TABLE discovery_origins (
 id TEXT PRIMARY KEY,
 situation_id TEXT NOT NULL UNIQUE REFERENCES discovery_situations(id),
 decision_id TEXT NOT NULL REFERENCES discovery_decisions(id),
 conversation_id TEXT NOT NULL REFERENCES conversations(id),
 engagement_id TEXT NOT NULL REFERENCES engagements(id),
 inbound_message_id TEXT NOT NULL REFERENCES messages(id),
 permission_id TEXT NOT NULL REFERENCES contact_permissions(id),
 source_fingerprint TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX discovery_origin_engagement ON discovery_origins(engagement_id);
CREATE TABLE discovery_assessments (
 id TEXT PRIMARY KEY, situation_id TEXT NOT NULL REFERENCES discovery_situations(id),
 decision_id TEXT NOT NULL REFERENCES discovery_decisions(id),
 classification TEXT NOT NULL CHECK(classification IN ('supported','refuted','missed_existing_evidence','later_need_only','unknown')),
 reason TEXT NOT NULL,
 source_event_ids_json TEXT NOT NULL CHECK(json_valid(source_event_ids_json)),
 outcome_ids_json TEXT NOT NULL CHECK(json_valid(outcome_ids_json)),
 attribution TEXT NOT NULL CHECK(attribution IN ('observed_association','human_assisted','unknown')),
 author TEXT NOT NULL CHECK(author='operator'), created_at TEXT NOT NULL,
 forgotten_at TEXT
);
CREATE INDEX discovery_assessment_situation ON discovery_assessments(situation_id,created_at);
-- Reviewed means a reviewed candidate, never an activated strategy or runtime instruction.
CREATE TABLE discovery_lessons (
 id TEXT PRIMARY KEY, assessment_id TEXT NOT NULL UNIQUE REFERENCES discovery_assessments(id),
 situation_id TEXT NOT NULL REFERENCES discovery_situations(id),
 text TEXT NOT NULL, limitations TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate','reviewed','rejected','forgotten')),
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
 created_at TEXT NOT NULL, reviewed_at TEXT
);
CREATE TABLE discovery_lesson_reviews (
 id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL REFERENCES discovery_lessons(id),
 revision INTEGER NOT NULL CHECK(revision>0),
 decision TEXT NOT NULL CHECK(decision IN ('approve','reject')),
 evaluation TEXT NOT NULL, limitations TEXT NOT NULL,
 reviewer TEXT NOT NULL CHECK(reviewer='operator'), created_at TEXT NOT NULL,
 UNIQUE(lesson_id,revision)
);
