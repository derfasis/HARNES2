CREATE TABLE channel_posts (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partners(id),
  account_id TEXT NOT NULL,
  channel_chat_id TEXT NOT NULL,
  bot_username TEXT NOT NULL,
  payload TEXT NOT NULL UNIQUE,
  current_version INTEGER NOT NULL DEFAULT 1,
  approved_version INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
CREATE TABLE channel_post_versions (
  post_id TEXT NOT NULL REFERENCES channel_posts(id),
  version INTEGER NOT NULL,
  text TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(post_id, version)
);
CREATE TABLE channel_post_attempts (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES channel_posts(id),
  post_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  external_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE channel_post_starts (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  post_id TEXT NOT NULL REFERENCES channel_posts(id),
  person_id TEXT NOT NULL REFERENCES persons(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(conversation_id, post_id)
);
