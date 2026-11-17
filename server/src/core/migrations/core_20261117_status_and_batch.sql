-- Status folding: a status item from one session updates its open row until it is closed.
-- status_closed_at is set when a status says it is final. It is distinct from archived_at and
-- dismiss_action, which mean the person put the item away.
ALTER TABLE messages ADD COLUMN status_closed_at TEXT;
-- The fold lookup: the newest open status of a user's session. Closed, archived and dismissed rows
-- are not in the index.
CREATE INDEX idx_messages_open_status ON messages(user_id, instance_session_id, created_at DESC)
  WHERE type = 'status' AND archived_at IS NULL AND dismiss_action IS NULL AND status_closed_at IS NULL;
