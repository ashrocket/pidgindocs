-- Library: private, per-user Projects and Tags that organize a person's documents
-- and artifacts, and the search index over them. Both are the same columns as
-- before the Library moved into PidginCore, so a deployment that already has the
-- tables is unchanged (every statement is IF NOT EXISTS).
--
-- Library filing never changes who can read a resource: every row here is
-- scoped to one user_id. Resources are keyed by a stable key so filing survives
-- new versions:
--   document -> COALESCE(messages.doc_slug, messages.id)  (the version family)
--   artifact -> artifacts.id                              (versions are internal)

CREATE TABLE IF NOT EXISTS library_projects (
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

-- Auto-filing rules: an agent's instance project label (lowercased) files
-- every matching document/artifact into a project unless the user filed it
-- explicitly. Rules resolve at read time, so they cover past and future items.
CREATE TABLE IF NOT EXISTS library_project_sources (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_label TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES library_projects(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, source_label)
);
CREATE INDEX IF NOT EXISTS idx_library_project_sources_project ON library_project_sources(project_id);

CREATE TABLE IF NOT EXISTS library_tags (
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

-- Explicit filing. A row with project_id NULL means "explicitly unfiled" and
-- overrides any auto-filing rule; no row means the rule (if any) applies.
CREATE TABLE IF NOT EXISTS library_items (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('document', 'artifact')),
  resource_key TEXT NOT NULL,
  project_id TEXT REFERENCES library_projects(id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, resource_type, resource_key)
);
CREATE INDEX IF NOT EXISTS idx_library_items_project ON library_items(project_id);

CREATE TABLE IF NOT EXISTS library_item_tags (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('document', 'artifact')),
  resource_key TEXT NOT NULL,
  tag_id TEXT NOT NULL REFERENCES library_tags(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, resource_type, resource_key, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_library_item_tags_tag ON library_item_tags(tag_id);

-- Search index: one row per library item (same resource keys as library_items). A row
-- keeps only the small routing data; the full section tree and its source
-- passages live in R2 (DOCS bucket, r2_key). `signature` changes when the
-- item's content changes, so stale rows are re-indexed on demand.

CREATE TABLE IF NOT EXISTS library_search_index (
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
