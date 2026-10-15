-- Query selections are not chronological samples or source checkpoints.
CREATE TABLE scout_message_queries (
 id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id),
 campaign_id TEXT NOT NULL REFERENCES scout_campaigns(id),
 candidate_id TEXT NOT NULL REFERENCES scout_candidates(id),
 grant_id TEXT NOT NULL REFERENCES scout_grants(id),
 job_id TEXT NOT NULL UNIQUE REFERENCES scout_jobs(id),
 definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
 definition_hash TEXT NOT NULL CHECK(length(definition_hash)=64), created_at TEXT NOT NULL
);
CREATE INDEX scout_message_query_campaign ON scout_message_queries(campaign_id,created_at,id);
CREATE TRIGGER scout_message_query_immutable BEFORE UPDATE ON scout_message_queries
 BEGIN SELECT RAISE(ABORT,'SCOUT_QUERY_IMMUTABLE'); END;
CREATE TRIGGER scout_message_query_no_delete BEFORE DELETE ON scout_message_queries
 BEGIN SELECT RAISE(ABORT,'SCOUT_QUERY_IMMUTABLE'); END;

CREATE TABLE scout_query_receipts (
 id TEXT PRIMARY KEY, query_request_id TEXT NOT NULL REFERENCES scout_message_queries(id),
 attempt_call_id TEXT NOT NULL UNIQUE REFERENCES scout_calls(id),
 source_cursor INTEGER NOT NULL CHECK(source_cursor>=0),
 content_json TEXT NOT NULL CHECK(json_valid(content_json)),
 content_hash TEXT NOT NULL CHECK(length(content_hash)=64), created_at TEXT NOT NULL
);
CREATE INDEX scout_query_receipt_request ON scout_query_receipts(query_request_id,created_at,id);
CREATE TRIGGER scout_query_receipt_immutable BEFORE UPDATE ON scout_query_receipts
 BEGIN SELECT RAISE(ABORT,'SCOUT_QUERY_RECEIPT_IMMUTABLE'); END;
CREATE TRIGGER scout_query_receipt_no_delete BEFORE DELETE ON scout_query_receipts
 BEGIN SELECT RAISE(ABORT,'SCOUT_QUERY_RECEIPT_IMMUTABLE'); END;

CREATE TABLE scout_query_proposals (
 id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id),
 campaign_id TEXT NOT NULL REFERENCES scout_campaigns(id), campaign_revision INTEGER NOT NULL,
 candidate_id TEXT NOT NULL REFERENCES scout_candidates(id),
 receipt_id TEXT NOT NULL REFERENCES scout_query_receipts(id),
 receipt_digest TEXT NOT NULL CHECK(length(receipt_digest)=64),
 model_request_id TEXT NOT NULL REFERENCES scout_model_requests(id),
 request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64),
 run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
 output_json TEXT NOT NULL CHECK(json_valid(output_json)),
 output_digest TEXT NOT NULL CHECK(length(output_digest)=64),
 status TEXT NOT NULL CHECK(status IN ('proposed','approved','rejected','stale')),
 note TEXT, created_at TEXT NOT NULL
);
CREATE INDEX scout_query_proposal_campaign ON scout_query_proposals(campaign_id,created_at,id);
CREATE TRIGGER scout_query_proposal_immutable BEFORE UPDATE OF
 id,partner_id,campaign_id,campaign_revision,candidate_id,receipt_id,receipt_digest,
 model_request_id,request_fingerprint,run_id,output_json,output_digest,created_at ON scout_query_proposals
 BEGIN SELECT RAISE(ABORT,'SCOUT_QUERY_PROPOSAL_IMMUTABLE'); END;
CREATE TRIGGER scout_query_proposal_no_delete BEFORE DELETE ON scout_query_proposals
 BEGIN SELECT RAISE(ABORT,'SCOUT_QUERY_PROPOSAL_IMMUTABLE'); END;
CREATE TRIGGER scout_query_proposal_state BEFORE UPDATE ON scout_query_proposals
 WHEN NOT (NEW.status=OLD.status AND NEW.note IS OLD.note
   OR OLD.status='proposed' AND NEW.status IN ('approved','rejected','stale')
   OR OLD.status IN ('approved','rejected') AND NEW.status='stale' AND NEW.note IS OLD.note)
 BEGIN SELECT RAISE(ABORT,'SCOUT_QUERY_PROPOSAL_STATE_INVALID'); END;
