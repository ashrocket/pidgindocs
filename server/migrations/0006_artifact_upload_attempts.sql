-- Register bytes before R2 receives them. Active version metadata replaces this
-- row in the publication transaction. Uncertain staging uploads never auto-expire.
CREATE TABLE artifact_upload_attempts (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  source_size INTEGER NOT NULL DEFAULT 0 CHECK(source_size >= 0),
  state TEXT NOT NULL CHECK(state IN ('staging','retired')),
  created_ms INTEGER NOT NULL
);
CREATE INDEX artifact_upload_cleanup ON artifact_upload_attempts(state,created_ms);
