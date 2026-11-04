-- Pidgin core: bounded, single-use email and Microsoft sign-in challenges.
CREATE TABLE login_challenges (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  code_hash TEXT NOT NULL,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE oauth_login_states (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE oauth_login_identities (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (issuer, subject)
);
CREATE INDEX idx_oauth_login_identities_user ON oauth_login_identities(user_id);
CREATE INDEX idx_login_challenges_expiry ON login_challenges(expires_at);
CREATE INDEX idx_oauth_login_states_expiry ON oauth_login_states(expires_at);
