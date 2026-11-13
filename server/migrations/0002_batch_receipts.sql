CREATE TABLE IF NOT EXISTS batch_receipts (
  owner TEXT NOT NULL,
  key TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reserved INTEGER NOT NULL DEFAULT 0,
  units TEXT,
  settled INTEGER NOT NULL DEFAULT 0,
  http_status INTEGER,
  body TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner, key)
);
