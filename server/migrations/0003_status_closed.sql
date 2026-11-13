-- A finished status item (final: true) stops folding. Distinct from archived_at
-- and dismiss_action, which mean the person put it away.
ALTER TABLE messages ADD COLUMN status_closed_at TEXT;
