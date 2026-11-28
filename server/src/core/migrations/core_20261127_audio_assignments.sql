-- Replies are durable work, independent of an agent's current connection.
CREATE TABLE IF NOT EXISTS agent_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  target TEXT NOT NULL CHECK(target IN ('local','cloud')),
  execution_ref TEXT NOT NULL,
  context_notes TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id,target,execution_ref)
);

CREATE TABLE IF NOT EXISTS agent_runtimes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agent_identities(id) ON DELETE CASCADE,
  principal_ref TEXT NOT NULL,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  target TEXT NOT NULL CHECK(target IN ('local','cloud','interactive')),
  connection_id TEXT REFERENCES agent_connections(id),
  modalities TEXT NOT NULL CHECK(json_valid(modalities)),
  expires_at INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(principal_ref, session_id)
);
CREATE INDEX IF NOT EXISTS agent_runtimes_owner ON agent_runtimes(user_id, expires_at);

CREATE TABLE IF NOT EXISTS agent_assignments (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Keep a revoked/deleted target; never silently give its task to another agent.
  agent_id TEXT,
  client_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  audio_id TEXT NOT NULL,
  audio_title TEXT NOT NULL,
  source_message_id TEXT,
  context_text TEXT,
  context_truncated INTEGER NOT NULL DEFAULT 0,
  connection_id TEXT,
  connection_name TEXT,
  connection_context TEXT,
  playback_seconds REAL NOT NULL DEFAULT 0,
  text TEXT,
  voice_key TEXT,
  voice_mime TEXT,
  voice_size INTEGER,
  target TEXT NOT NULL CHECK(target IN ('auto','local','cloud','interactive')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','claimed','dispatched','completed','cancelled')),
  runtime_id TEXT,
  lease_token TEXT,
  lease_expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  result TEXT,
  session_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, audio_id, client_id),
  CHECK(text IS NOT NULL OR voice_key IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS agent_assignments_queue ON agent_assignments(user_id, status, seq);
CREATE INDEX IF NOT EXISTS agent_assignments_audio ON agent_assignments(user_id, audio_id, seq);
