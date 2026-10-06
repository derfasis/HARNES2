-- Immutable transport cutovers. An acknowledged gap never constitutes coverage.
CREATE TABLE source_observation_epochs (
 id TEXT PRIMARY KEY,
 partner_id TEXT NOT NULL REFERENCES partners(id),
 source_ref TEXT NOT NULL,
 account_id TEXT NOT NULL,
 channel_id TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 128),
 authorization_event_id INTEGER NOT NULL UNIQUE REFERENCES events(id),
 baseline_event_id INTEGER NOT NULL UNIQUE REFERENCES events(id),
 previous_epoch_id TEXT REFERENCES source_observation_epochs(id),
 policy_json TEXT NOT NULL,
 previous_checkpoint_json TEXT NOT NULL,
 baseline_pts INTEGER NOT NULL CHECK(baseline_pts BETWEEN 1 AND 2147483647),
 baseline_hash TEXT NOT NULL,
 observation_floor INTEGER NOT NULL CHECK(observation_floor = baseline_event_id),
 created_at TEXT NOT NULL,
 transition_sha256 TEXT NOT NULL,
 UNIQUE(partner_id, source_ref, generation)
);
