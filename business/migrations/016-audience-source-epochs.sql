-- Immutable owner-approved watch history; executable authority stays in the watch projection.
CREATE TABLE audience_watch_epochs (
 id TEXT PRIMARY KEY,
 goal_id TEXT NOT NULL REFERENCES audience_goals(id),
 source_ref TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK(generation >= 1),
 prior_policy_hash TEXT NOT NULL,
 source_policy_hash TEXT NOT NULL,
 policy_hash TEXT NOT NULL UNIQUE,
 prior_cursor INTEGER NOT NULL CHECK(prior_cursor >= 0),
 observation_floor INTEGER NOT NULL CHECK(observation_floor >= prior_cursor),
 preview_sha256 TEXT NOT NULL,
 created_at TEXT NOT NULL,
 transition_sha256 TEXT NOT NULL,
 UNIQUE(goal_id, source_ref, generation),
 FOREIGN KEY(goal_id, source_ref) REFERENCES audience_watches(goal_id, source_ref)
);
