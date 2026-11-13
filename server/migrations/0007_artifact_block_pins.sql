-- Resolve block pins at transaction time, after application prechecks. ABORT
-- makes D1 roll back the entire message/audit batch if pruning already won.
-- Existing rows are left untouched; only new artifact-kind tuples are checked.
CREATE TRIGGER message_artifact_pin_insert
BEFORE INSERT ON message_blocks
WHEN NEW.kind = 'artifact' AND NOT EXISTS (
  SELECT 1 FROM artifact_versions
  WHERE artifact_id = NEW.artifact_id AND version = NEW.artifact_version
)
BEGIN
  SELECT RAISE(ABORT, 'artifact block version unavailable');
END;

CREATE TRIGGER message_artifact_pin_update
BEFORE UPDATE OF message_id,kind,artifact_id,artifact_version ON message_blocks
WHEN NEW.kind = 'artifact' AND NOT EXISTS (
  SELECT 1 FROM artifact_versions
  WHERE artifact_id = NEW.artifact_id AND version = NEW.artifact_version
)
BEGIN
  SELECT RAISE(ABORT, 'artifact block version unavailable');
END;
