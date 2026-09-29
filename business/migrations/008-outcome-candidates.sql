-- An outcome candidate is a claim that something happened, not a business outcome.
--
-- The distinction is the whole point of this layer. A reply, a reaction, or the words "I signed
-- up" are observations: they are evidence that *something* occurred, not proof of a business
-- result. Recording either as an `outcome_events` row would make `cost_per_qualified` a measure of
-- how diligently the owner types into a form, so candidates live in their own table and only an
-- operator or a trusted source may promote one.
--
-- `detector_version` is stored rather than assumed: a candidate is a product of a specific rule,
-- and a rule that later changes must not be able to explain away what an old one claimed. The
-- unique key is the candidate's *identity* — what was observed, where, by which rule — so a
-- re-scan of the same evidence is a no-op rather than a second row.
CREATE TABLE outcome_candidates (
 id TEXT PRIMARY KEY,
 partner_id TEXT NOT NULL REFERENCES partners(id),
 conversation_id TEXT NOT NULL REFERENCES conversations(id),
 engagement_id TEXT REFERENCES engagements(id),
 kind TEXT NOT NULL CHECK(kind IN (
   'reply_observed','reaction_observed','no_response_observed','engagement_closed',
   'owner_booking_claimed','owner_outcome_stated')),
 detector TEXT NOT NULL,
 detector_version INTEGER NOT NULL,
 basis TEXT NOT NULL,
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
 source_message_id TEXT REFERENCES messages(id),
 draft_id TEXT REFERENCES drafts(id),
 decision_id TEXT REFERENCES engagement_decisions(id),
 observed_at TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
   'pending','confirmed','rejected','superseded','unknown')),
 outcome_id TEXT REFERENCES outcome_events(id),
 resolution_note TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 UNIQUE(partner_id, conversation_id, detector, source_message_id, kind)
);
CREATE INDEX outcome_candidate_queue ON outcome_candidates(partner_id, status, observed_at, id);
CREATE INDEX outcome_candidate_evidence ON outcome_candidates(partner_id, conversation_id, id);

-- Which conversations have no answer yet.
--
-- "Unknown" is a measurement, not an absence: a reply that arrived after the window closed is
-- still an answer, and a reply that never arrived is evidence about the message, not about the
-- person. Without this the only way to report a rate is to divide confirmed outcomes by
-- conversations, which silently counts every unanswered conversation as a success.
CREATE TABLE outcome_observation_windows (
 id TEXT PRIMARY KEY,
 partner_id TEXT NOT NULL REFERENCES partners(id),
 conversation_id TEXT NOT NULL REFERENCES conversations(id),
 message_id TEXT NOT NULL REFERENCES messages(id),
 opened_at TEXT NOT NULL,
 closes_at TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('pending','answered','expired_unanswered','superseded')),
 answered_at TEXT,
 candidate_id TEXT REFERENCES outcome_candidates(id),
 created_at TEXT NOT NULL,
 UNIQUE(partner_id, message_id)
);
CREATE INDEX outcome_window_queue ON outcome_observation_windows(partner_id, outcome, closes_at, id);
