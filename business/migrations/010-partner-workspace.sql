-- Work is a durable association, never a person, contact grant, or causal claim.
CREATE TABLE work_cases (
 id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id), thread_id TEXT NOT NULL REFERENCES partner_threads(id),
 title TEXT NOT NULL, turn_id TEXT NOT NULL REFERENCES partner_turns(id), basis_fingerprint TEXT NOT NULL,
 packet_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','stale','closed')), revision INTEGER NOT NULL DEFAULT 1,
 material_id TEXT, action_id TEXT REFERENCES action_proposals(id), reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(thread_id,turn_id)
);
CREATE TABLE work_materials (
 id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES work_cases(id), version INTEGER NOT NULL,
 title TEXT NOT NULL, format TEXT NOT NULL CHECK(format='text/markdown'), content TEXT NOT NULL, sha256 TEXT NOT NULL,
 evidence_json TEXT NOT NULL, turn_id TEXT NOT NULL REFERENCES partner_turns(id), basis_fingerprint TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('proposed','approved','rejected','superseded','stale')),
 producer TEXT NOT NULL CHECK(producer IN ('operator','model')), run_id TEXT REFERENCES runs(id),
 review_note TEXT, reviewed_at TEXT, created_at TEXT NOT NULL, UNIQUE(case_id,version)
);
CREATE TRIGGER work_material_immutable BEFORE UPDATE OF case_id,version,title,format,content,sha256,evidence_json,turn_id,basis_fingerprint,producer,run_id,created_at ON work_materials
BEGIN SELECT RAISE(ABORT,'WORK_MATERIAL_IMMUTABLE'); END;
CREATE TABLE work_material_requests (
 id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES work_cases(id), basis_fingerprint TEXT NOT NULL, case_revision INTEGER NOT NULL,
 packet_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','stale','interrupted')),
 run_id TEXT REFERENCES runs(id), material_id TEXT REFERENCES work_materials(id), reason TEXT, created_at TEXT NOT NULL, finished_at TEXT,
 UNIQUE(case_id,basis_fingerprint)
);
CREATE TABLE work_expectations (
 id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES work_cases(id), action_id TEXT NOT NULL REFERENCES action_proposals(id),
 source_ref TEXT NOT NULL, question TEXT NOT NULL, opened_at TEXT NOT NULL, deadline TEXT NOT NULL, cursor INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','evidence_observed','unknown','revoked')), observations_json TEXT NOT NULL DEFAULT '[]',
 reason TEXT, updated_at TEXT NOT NULL, UNIQUE(case_id,action_id)
);
CREATE INDEX work_cases_partner ON work_cases(partner_id,id);
CREATE INDEX work_requests_pending ON work_material_requests(status,id);
CREATE TABLE control_tickets (
 id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id), plane TEXT NOT NULL CHECK(plane IN ('public','private','work')),
 operation TEXT NOT NULL, owner_id TEXT NOT NULL, run_id TEXT UNIQUE REFERENCES runs(id),
 status TEXT NOT NULL CHECK(status IN ('reserved','running','completed','failed','expired','interrupted')),
 reserved_usd REAL NOT NULL CHECK(reserved_usd>=0), expires_at TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT, reason TEXT
);
CREATE INDEX control_active ON control_tickets(partner_id,status,plane);
CREATE TABLE control_owners (
 partner_id TEXT PRIMARY KEY REFERENCES partners(id), owner_id TEXT NOT NULL, pid INTEGER NOT NULL, expires_at TEXT NOT NULL
);
