CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('message', 'question', 'status', 'document')),
  title TEXT NOT NULL,
  body TEXT,
  doc_key TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  instance_model TEXT NOT NULL,
  instance_session_id TEXT NOT NULL,
  instance_project TEXT NOT NULL,
  instance_source TEXT NOT NULL,
  reply TEXT,
  replied_at TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, public INTEGER NOT NULL DEFAULT 0, archived_at TEXT, doc_slug TEXT, doc_version INTEGER, is_latest INTEGER NOT NULL DEFAULT 1, user_id TEXT REFERENCES users(id), last_poll_at TEXT, read_at TEXT, source_url TEXT, dismiss_action TEXT, expires_at TIMESTAMP, pinned INTEGER NOT NULL DEFAULT 0, enhance_status TEXT, enhance_level TEXT, enhance_error TEXT, design_system TEXT, interactive INTEGER NOT NULL DEFAULT 0, team_id TEXT REFERENCES teams(id), project_id TEXT REFERENCES projects(id), doc_kind TEXT NOT NULL DEFAULT 'doc'
  CHECK (doc_kind IN ('doc', 'decision_memo', 'meeting_note', 'spec', 'runbook')), doc_size INTEGER NOT NULL DEFAULT 0, source_size INTEGER NOT NULL DEFAULT 0, replied_by_user_id TEXT REFERENCES users(id));
CREATE TABLE instances (
  instance_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  project TEXT NOT NULL,
  working_on TEXT,
  source TEXT NOT NULL,
  registered_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_heartbeat TEXT NOT NULL DEFAULT (datetime('now'))
, user_id TEXT REFERENCES users(id));
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  instance_id TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, user_id TEXT REFERENCES users(id));
CREATE TABLE device_tokens (
  token TEXT PRIMARY KEY,
  platform TEXT NOT NULL DEFAULT 'ios',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, user_id TEXT REFERENCES users(id));
CREATE TABLE doc_access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL,
  event TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE destination_configs (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE commute_briefings (
  source_message_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  transcript_key TEXT NOT NULL,
  audio_key TEXT,
  metadata_key TEXT,
  provider TEXT NOT NULL DEFAULT 'openai',
  voice TEXT,
  model TEXT,
  minutes INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), source_type TEXT NOT NULL DEFAULT 'document', playlist_doc_ids TEXT, transcript_size INTEGER NOT NULL DEFAULT 0, audio_size INTEGER NOT NULL DEFAULT 0, metadata_size INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (source_message_id) REFERENCES messages(id)
);
CREATE TABLE users (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  email TEXT UNIQUE NOT NULL,
  invited_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE api_keys (
  key_hash TEXT PRIMARY KEY,
  key_prefix TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT
);
CREATE TABLE design_systems (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  tokens_json TEXT NOT NULL,
  css TEXT,
  source TEXT NOT NULL DEFAULT 'custom',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE user_identities (
  email TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_sub TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  instance_session_id TEXT,
  instance_project TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  last_poll_at TEXT,
  -- Stamped at close (+30 days); the daily expiry cron hard-deletes the
  -- conversation and its messages/bindings after that.
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at TEXT NOT NULL DEFAULT (datetime('now'))
, doc_id TEXT);
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  sender TEXT NOT NULL CHECK (sender IN ('agent', 'user', 'system')),
  channel TEXT,
  body TEXT NOT NULL,
  external_event_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE conversation_channels (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  channel TEXT NOT NULL,
  external_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (conversation_id, channel)
);
CREATE TABLE client_builds (
  platform TEXT PRIMARY KEY,
  latest_build INTEGER NOT NULL,
  latest_version TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT,
  favicon TEXT NOT NULL,
  source_path TEXT,
  source_kind TEXT NOT NULL DEFAULT 'html' CHECK (source_kind IN ('html', 'markdown')),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  shared_version INTEGER,
  current_version INTEGER NOT NULL DEFAULT 1,
  capabilities TEXT,
  instance_session_id TEXT,
  instance_project TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, role TEXT NOT NULL DEFAULT 'page'
  CHECK (role IN ('page', 'widget')), design_system TEXT, team_id TEXT REFERENCES teams(id), project_id TEXT REFERENCES projects(id));
CREATE TABLE artifact_versions (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  version INTEGER NOT NULL,
  label TEXT,
  r2_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by_session TEXT, source_size INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (artifact_id, version)
);
CREATE TABLE artifact_storage (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (artifact_id, scope, key)
);
CREATE TABLE message_blocks (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('markdown', 'artifact')),
  markdown TEXT,
  artifact_id TEXT,
  artifact_version INTEGER,
  label TEXT,
  producer TEXT,
  producer_action TEXT,
  summary TEXT,
  collapsed INTEGER NOT NULL DEFAULT 0,
  artifact_title_snapshot TEXT,
  artifact_favicon_snapshot TEXT,
  PRIMARY KEY (message_id, position),
  CHECK (
    (kind = 'markdown' AND markdown IS NOT NULL
      AND artifact_id IS NULL AND artifact_version IS NULL)
    OR
    (kind = 'artifact' AND markdown IS NULL
      AND artifact_id IS NOT NULL AND artifact_version IS NOT NULL)
  )
);
CREATE TABLE artifact_embed_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  message_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('loaded', 'failed', 'opened_fullscreen')),
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE team_memberships (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (team_id, user_id)
);
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)), archived_at TEXT,
  UNIQUE(team_id, slug)
);
CREATE TABLE resource_comments (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('message', 'artifact', 'document', 'decision_memo')),
  resource_id TEXT NOT NULL,
  parent_id TEXT REFERENCES resource_comments(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  author_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE agent_identities (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  provider TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  UNIQUE(team_id, slug)
);
CREATE TABLE agent_project_grants (
  agent_id TEXT NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK (permission IN ('read', 'write')),
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (agent_id, project_id)
);
CREATE TABLE agent_keys (
  key_hash TEXT PRIMARY KEY,
  key_prefix TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE TABLE agent_board_entries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agent_identities(id),
  kind TEXT NOT NULL CHECK (kind IN ('s', 'c', 'h', 'd', 'b', 'n')),
  topic TEXT NOT NULL,
  body TEXT NOT NULL,
  reference TEXT,
  client_message_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), user_id TEXT REFERENCES users(id), session_id TEXT, session_name TEXT, model TEXT, model_version TEXT, origin TEXT, origin_version TEXT,
  UNIQUE(agent_id, project_id, client_message_id)
);
CREATE TABLE agent_board_moderation (
  entry_id TEXT PRIMARY KEY REFERENCES agent_board_entries(id) ON DELETE CASCADE,
  action TEXT NOT NULL DEFAULT 'tombstone' CHECK (action = 'tombstone'),
  reason TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE commute_playlist_items (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, message_id)
);
CREATE TABLE user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  commute_source TEXT NOT NULL DEFAULT 'latest'
    CHECK (commute_source IN ('latest', 'playlist')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE message_user_state (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read INTEGER NOT NULL DEFAULT 0,
  read_at TEXT,
  archived_at TEXT,
  dismiss_action TEXT CHECK (dismiss_action IN ('archive', 'delete')),
  pinned INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, user_id)
);
CREATE TABLE workspace_tags (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'teal' CHECK (color IN ('teal','blue','amber','violet','rose')),
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(team_id, slug)
);
CREATE TABLE workspace_resource_tags (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES workspace_tags(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('message','artifact')),
  resource_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tag_id, resource_type, resource_id)
);
CREATE TABLE library_projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  color TEXT NOT NULL DEFAULT 'blue' CHECK (color IN (
    'blue','teal','green','mint','yellow','orange','red','pink','purple','indigo','brown','gray'
  )),
  symbol TEXT,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, slug)
);
CREATE TABLE library_project_sources (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_label TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES library_projects(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, source_label)
);
CREATE TABLE library_tags (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'gray' CHECK (color IN (
    'blue','teal','green','mint','yellow','orange','red','pink','purple','indigo','brown','gray'
  )),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, slug)
);
CREATE TABLE library_items (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('document', 'artifact')),
  resource_key TEXT NOT NULL,
  project_id TEXT REFERENCES library_projects(id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, resource_type, resource_key)
);
CREATE TABLE library_item_tags (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('document', 'artifact')),
  resource_key TEXT NOT NULL,
  tag_id TEXT NOT NULL REFERENCES library_tags(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, resource_type, resource_key, tag_id)
);
CREATE TABLE workspace_mentions (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_user_id TEXT NOT NULL REFERENCES users(id),
  resource_type TEXT NOT NULL CHECK (resource_type IN ('message','document','decision_memo','artifact')),
  resource_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('post','comment')),
  source_id TEXT NOT NULL,
  preview TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_kind, source_id, recipient_user_id),
  FOREIGN KEY (team_id, recipient_user_id)
    REFERENCES team_memberships(team_id, user_id) ON DELETE CASCADE
);
CREATE TABLE library_search_index (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('document', 'artifact')),
  resource_key TEXT NOT NULL,
  -- The indexed row: the latest document version id, or the artifact id.
  resource_id TEXT NOT NULL,
  signature TEXT NOT NULL,
  index_version INTEGER NOT NULL,
  outline TEXT NOT NULL DEFAULT '',
  r2_key TEXT,
  sections INTEGER NOT NULL DEFAULT 0,
  passages INTEGER NOT NULL DEFAULT 0,
  characters INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'empty', 'failed')),
  error TEXT,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, resource_type, resource_key)
);
DELETE FROM sqlite_sequence;
CREATE INDEX idx_messages_created ON messages(created_at DESC);
CREATE INDEX idx_messages_type ON messages(type);
CREATE INDEX idx_messages_read ON messages(read);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX idx_doc_access_doc ON doc_access_log(doc_id);
CREATE INDEX idx_doc_access_created ON doc_access_log(created_at DESC);
CREATE INDEX idx_commute_briefings_created
  ON commute_briefings(created_at DESC);
CREATE INDEX idx_messages_archived ON messages(archived_at);
CREATE INDEX idx_messages_doc_slug ON messages(doc_slug);
CREATE INDEX idx_device_tokens_platform ON device_tokens(platform);
CREATE INDEX idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX idx_messages_user_id ON messages(user_id);
CREATE INDEX idx_device_tokens_user_id ON device_tokens(user_id);
CREATE INDEX idx_messages_last_poll ON messages(last_poll_at);
CREATE INDEX idx_messages_priority ON messages(priority);
CREATE INDEX idx_messages_expires ON messages (expires_at) WHERE expires_at IS NOT NULL;
CREATE UNIQUE INDEX idx_design_systems_user_name ON design_systems(user_id, name);
CREATE INDEX idx_user_identities_user_id ON user_identities(user_id);
CREATE INDEX idx_conversations_user ON conversations(user_id, status, last_activity_at);
CREATE INDEX idx_chat_messages_conv ON chat_messages(conversation_id, created_at);
CREATE UNIQUE INDEX idx_chat_messages_ext
  ON chat_messages(channel, external_event_id)
  WHERE external_event_id IS NOT NULL;
CREATE UNIQUE INDEX idx_conversation_channels_ext ON conversation_channels(channel, external_id);
CREATE INDEX idx_artifacts_user_updated ON artifacts(user_id, updated_at DESC);
CREATE INDEX idx_conversations_doc ON conversations(doc_id) WHERE doc_id IS NOT NULL;
CREATE INDEX idx_message_blocks_artifact
  ON message_blocks(artifact_id, artifact_version);
CREATE INDEX idx_artifact_embed_events_created
  ON artifact_embed_events(user_id, created_at DESC);
CREATE INDEX idx_resource_comments_team_resource
  ON resource_comments(team_id, resource_type, resource_id, created_at);
CREATE INDEX idx_resource_comments_project
  ON resource_comments(project_id, created_at);
CREATE INDEX idx_messages_team_id ON messages(team_id);
CREATE INDEX idx_messages_project_id ON messages(project_id);
CREATE INDEX idx_messages_doc_kind ON messages(doc_kind);
CREATE INDEX idx_artifacts_team_id ON artifacts(team_id);
CREATE INDEX idx_artifacts_project_id ON artifacts(project_id);
CREATE INDEX idx_agent_identities_team ON agent_identities(team_id, status, slug);
CREATE INDEX idx_agent_project_grants_project ON agent_project_grants(project_id, permission);
CREATE INDEX idx_agent_keys_agent ON agent_keys(agent_id, revoked_at);
CREATE INDEX idx_agent_board_project_seq ON agent_board_entries(project_id, seq);
CREATE INDEX idx_agent_board_team_created ON agent_board_entries(team_id, created_at DESC);
CREATE INDEX idx_playlist_user_pos
  ON commute_playlist_items(user_id, position);
CREATE INDEX idx_commute_briefings_source_created
  ON commute_briefings(source_type, created_at DESC);
CREATE INDEX idx_agent_board_session
  ON agent_board_entries(project_id, agent_id, user_id, origin, session_id, seq);
CREATE INDEX idx_message_user_state_user ON message_user_state(user_id, archived_at);
CREATE INDEX idx_messages_team_channel_created ON messages(team_id, project_id, created_at);
CREATE INDEX idx_artifacts_team_channel_updated ON artifacts(team_id, project_id, updated_at);
CREATE INDEX idx_workspace_tags_team ON workspace_tags(team_id, name);
CREATE INDEX idx_workspace_resource_tags_resource ON workspace_resource_tags(team_id, resource_type, resource_id);
CREATE INDEX idx_library_project_sources_project ON library_project_sources(project_id);
CREATE INDEX idx_library_items_project ON library_items(project_id);
CREATE INDEX idx_library_item_tags_tag ON library_item_tags(tag_id);
CREATE INDEX idx_workspace_mentions_recipient
  ON workspace_mentions(recipient_user_id, created_at DESC, id DESC);
