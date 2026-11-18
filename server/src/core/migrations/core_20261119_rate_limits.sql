-- Self-hosted rate-limit counters. Each bucket's window is fixed at its first hit.
CREATE TABLE rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_rate_limits_expires ON rate_limits(expires_at);
