-- A bounded read-reference grant. It grants neither contact nor execution authority.
CREATE TABLE engagement_references (
 id TEXT PRIMARY KEY,
 partner_id TEXT NOT NULL REFERENCES partners(id),
 engagement_id TEXT NOT NULL REFERENCES engagements(id),
 material_id TEXT NOT NULL REFERENCES work_materials(id),
 material_sha256 TEXT NOT NULL,
 question_message_id TEXT NOT NULL REFERENCES messages(id),
 offer_id TEXT NOT NULL,
 market TEXT NOT NULL CHECK(length(market)=2 AND market GLOB '[A-Z][A-Z]'),
 excerpt TEXT NOT NULL CHECK(length(excerpt) BETWEEN 1 AND 8000),
 expires_at TEXT NOT NULL,
 note TEXT NOT NULL,
 packet_json TEXT NOT NULL,
 packet_sha256 TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('active','stale','revoked','quarantined')),
 reason TEXT,
 created_at TEXT NOT NULL,
 retired_at TEXT
);
CREATE INDEX engagement_reference_scope ON engagement_references(partner_id,engagement_id,status);
CREATE INDEX engagement_reference_maintenance ON engagement_references(partner_id,status,id);
