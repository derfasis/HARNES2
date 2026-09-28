-- Working questions are independent of people, conversations and contact authority.
CREATE TABLE partner_threads (
 id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id),
 title TEXT NOT NULL, objective TEXT NOT NULL, success_condition TEXT NOT NULL,
 business_basis TEXT NOT NULL, max_age_seconds INTEGER NOT NULL CHECK(max_age_seconds BETWEEN 60 AND 2592000),
 status TEXT NOT NULL CHECK(status IN ('OPEN','PAUSED','CLOSED')), pause_reason TEXT,
 revision INTEGER NOT NULL DEFAULT 1, attention INTEGER NOT NULL DEFAULT 1 CHECK(attention IN (0,1)),
 attention_reasons_json TEXT NOT NULL CHECK(json_valid(attention_reasons_json)), attention_at TEXT NOT NULL,
 dependency_hash TEXT NOT NULL DEFAULT '', memory_turn_id TEXT REFERENCES partner_turns(id) DEFERRABLE INITIALLY DEFERRED,
 wake_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX partner_threads_attention ON partner_threads(partner_id,status,attention,attention_at,id);
CREATE TABLE partner_watches (
 thread_id TEXT NOT NULL REFERENCES partner_threads(id), source_ref TEXT NOT NULL,
 policy_hash TEXT NOT NULL, cursor INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','revoked')),
 reason TEXT, PRIMARY KEY(thread_id,source_ref)
);
CREATE TABLE partner_observations (
 thread_id TEXT NOT NULL, source_ref TEXT NOT NULL, message_id TEXT NOT NULL,
 source_event_id INTEGER NOT NULL REFERENCES events(id),
 origin TEXT NOT NULL CHECK(origin IN ('owner_selected_history','watched_change')),
 PRIMARY KEY(thread_id,source_ref,message_id),
 FOREIGN KEY(thread_id,source_ref) REFERENCES partner_watches(thread_id,source_ref)
);
CREATE INDEX partner_observations_window ON partner_observations(thread_id,source_ref,source_event_id);
CREATE TABLE partner_turns (
 id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES partner_threads(id),
 basis_revision INTEGER NOT NULL, basis_fingerprint TEXT NOT NULL,
 packet_json TEXT NOT NULL CHECK(json_valid(packet_json)), output_json TEXT CHECK(output_json IS NULL OR json_valid(output_json)),
 status TEXT NOT NULL CHECK(status IN ('captured','running','proposed','accepted','rejected','stale','failed','interrupted')),
 producer TEXT NOT NULL CHECK(producer IN ('operator','model')), run_id TEXT REFERENCES runs(id),
 review_note TEXT, created_at TEXT NOT NULL, reviewed_at TEXT,
 UNIQUE(thread_id,basis_revision)
);
CREATE UNIQUE INDEX partner_one_pending_turn ON partner_turns(thread_id) WHERE status IN ('captured','running','proposed');
CREATE INDEX partner_source_event_cursor ON events(partner_id,(payload_json->>'$.source_id'),id)
 WHERE kind='source.message' AND actor='system';
