-- Research is work on a question, never contact or delivery authority.
CREATE TABLE research_intents (
 id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id), thread_id TEXT NOT NULL REFERENCES partner_threads(id),
 motivating_turn_id TEXT REFERENCES partner_turns(id), plan_key TEXT UNIQUE,
 question TEXT, decision_to_inform TEXT, completion_criterion TEXT,
 selection_json TEXT NOT NULL CHECK(json_valid(selection_json)), refresh_sources_json TEXT NOT NULL CHECK(json_valid(refresh_sources_json)),
 authority_hash TEXT NOT NULL, proposal_basis_fingerprint TEXT NOT NULL,
 plan_packet_json TEXT NOT NULL CHECK(json_valid(plan_packet_json)), packet_json TEXT CHECK(packet_json IS NULL OR json_valid(packet_json)),
 status TEXT NOT NULL CHECK(status IN ('plan_requested','planning','proposed','waiting_sources','ready','reasoning','brief_proposed','completed','rejected','cancelled','superseded','failed','interrupted_unknown','no_research')),
 revision INTEGER NOT NULL DEFAULT 1, grant_version INTEGER NOT NULL DEFAULT 0, allow_model INTEGER NOT NULL DEFAULT 0 CHECK(allow_model IN (0,1)),
 authorized_at TEXT, deadline TEXT, turn_id TEXT REFERENCES partner_turns(id),
 producer TEXT NOT NULL CHECK(producer IN ('operator','model')), reason TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX research_one_active ON research_intents(thread_id)
 WHERE status IN ('plan_requested','planning','proposed','waiting_sources','ready','reasoning','brief_proposed');
CREATE INDEX research_queue ON research_intents(partner_id,status,id);
CREATE TABLE research_attempts (
 id TEXT PRIMARY KEY, intent_id TEXT NOT NULL REFERENCES research_intents(id),
 capability_id TEXT NOT NULL CHECK(capability_id IN ('research.plan','research.refresh_source','research.read_evidence','research.submit_brief')),
 capability_version TEXT NOT NULL, slot TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','cancelled','interrupted_unknown')),
 grant_version INTEGER NOT NULL, run_id TEXT REFERENCES runs(id),
 receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)), created_at TEXT NOT NULL, finished_at TEXT,
 UNIQUE(intent_id,slot)
);
CREATE INDEX research_attempt_queue ON research_attempts(capability_id,status,slot,intent_id);
CREATE INDEX research_donor_records ON events(partner_id,(payload_json->>'$.record_key'),id)
 WHERE kind='executive.donor_candidate';
