-- Immutable R2 revisions keep concurrent writers and cleanup independent.
-- Retained rows include staged/retired blobs until deletion AND meter release succeed.
CREATE TABLE draft_revisions (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES users(id),
  draft_key TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  state TEXT NOT NULL CHECK(state IN ('staging','active','retired')),
  created_ms INTEGER NOT NULL,
  last_attempt_ms INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX draft_current ON draft_revisions(owner,draft_key) WHERE state = 'active';
CREATE INDEX draft_retained_owner ON draft_revisions(owner,state);
CREATE INDEX draft_cleanup ON draft_revisions(state,created_ms);
CREATE TABLE draft_commits (
  revision TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  draft_key TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','done','rejected','held')),
  http_status INTEGER,
  body TEXT,
  units TEXT NOT NULL DEFAULT '{}',
  settled INTEGER NOT NULL DEFAULT 0,
  created_ms INTEGER NOT NULL
);
CREATE INDEX draft_commit_cleanup ON draft_commits(status,settled,created_ms);
CREATE TABLE draft_commit_keys (
  owner TEXT NOT NULL,
  draft_key TEXT NOT NULL,
  key TEXT NOT NULL,
  revision TEXT NOT NULL,
  PRIMARY KEY(owner,draft_key,key)
);
