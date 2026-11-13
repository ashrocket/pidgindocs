import { Env } from "./types";
import { flushArtifactUploadCleanup } from "./artifacts/store";
import { runWorkspaceBackup } from "./workspace-backup";
import { sourceMarkdownKey } from "./documents";
import { sweepBatchReceipts } from "./routes/batch";
import { commitStaleDrafts, deleteOldDrafts, DRAFT_IDLE_MS } from "./drafts";

export async function runExpiry(env: Env): Promise<{ deleted: number }> {
  // Find all rows where expires_at has passed and they are not pinned.
  const candidates = await env.DB.prepare(
    `SELECT m.id, m.doc_key, m.user_id, m.doc_size, m.source_size,
            cb.transcript_key, cb.audio_key, cb.metadata_key,
            cb.transcript_size, cb.audio_size, cb.metadata_size
     FROM messages m
     LEFT JOIN commute_briefings cb ON cb.source_message_id = m.id
     WHERE m.expires_at IS NOT NULL
       AND m.expires_at < datetime('now')
       AND m.pinned = 0
     LIMIT 500`
  ).all<{
    id: string;
    doc_key: string | null;
    user_id: string | null;
    doc_size: number;
    source_size: number;
    transcript_key: string | null;
    audio_key: string | null;
    metadata_key: string | null;
    transcript_size: number;
    audio_size: number;
    metadata_size: number;
  }>();

  if (candidates.results.length === 0) return { deleted: 0 };

  // Delete each row's R2 family before deleting its ownership rows. A failed
  // object delete leaves that message in D1 for the next sweep instead of
  // creating an unaccountable orphan.
  const cleanup = await Promise.all(candidates.results.map(async (row) => {
    const keys: string[] = [];
    if (row.doc_key) {
      keys.push(row.doc_key);
      const sourceKey = sourceMarkdownKey(row.doc_key);
      if (sourceKey) keys.push(sourceKey);
    }
    if (row.transcript_key) keys.push(row.transcript_key);
    if (row.audio_key) keys.push(row.audio_key);
    if (row.metadata_key) keys.push(row.metadata_key);
    try {
      await Promise.all(keys.map((key) => env.DOCS.delete(key)));
      return { row, ok: true as const };
    } catch (error) {
      console.error(`R2 delete failed for expired message ${row.id}`, error);
      return { row, ok: false as const };
    }
  }));
  const deletable = cleanup.filter((item) => item.ok).map((item) => item.row);
  if (deletable.length === 0) return { deleted: 0 };

  // Hard-delete the D1 rows in batches.
  const ids = deletable.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(",");
  await env.DB.prepare(
    `DELETE FROM commute_briefings WHERE source_message_id IN (${placeholders})`
  ).bind(...ids).run();
  const result = await env.DB.prepare(
    `DELETE FROM messages WHERE id IN (${placeholders})`
  ).bind(...ids).run();


  return { deleted: result.meta.changes };
}

// Closed conversations expire 30 days after close (stamped by
// closeConversation); sweep them with their messages and channel bindings.
export async function runChatExpiry(env: Env): Promise<{ deleted: number }> {
  const candidates = await env.DB.prepare(
    `SELECT id FROM conversations
     WHERE status = 'closed'
       AND expires_at IS NOT NULL
       AND expires_at < datetime('now')
     LIMIT 500`
  ).all<{ id: string }>();

  if (candidates.results.length === 0) return { deleted: 0 };

  const ids = candidates.results.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(",");
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM chat_messages WHERE conversation_id IN (${placeholders})`
    ).bind(...ids),
    env.DB.prepare(
      `DELETE FROM conversation_channels WHERE conversation_id IN (${placeholders})`
    ).bind(...ids),
    env.DB.prepare(`DELETE FROM conversations WHERE id IN (${placeholders})`).bind(...ids),
  ]);
  return { deleted: ids.length };
}

export const DRAFT_CRON = "*/5 * * * *";

export async function scheduled(
  controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext
): Promise<void> {
  // The five-minute trigger only commits idle drafts; the daily one does the rest.
  if (controller.cron === DRAFT_CRON) {
    try {
      const drafts = await commitStaleDrafts(env, DRAFT_IDLE_MS, controller.scheduledTime);
      console.log(`Draft cron: committed ${drafts.committed}, failed ${drafts.failed}, skipped ${drafts.skipped}`);
    } catch (err) {
      console.error("Draft cron failed", err);
    }
    return;
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM login_challenges WHERE id IN (SELECT id FROM login_challenges WHERE expires_at <= ? LIMIT 1000)").bind(Math.floor(controller.scheduledTime/1000)),
    env.DB.prepare("DELETE FROM oauth_login_states WHERE id IN (SELECT id FROM oauth_login_states WHERE expires_at <= ? LIMIT 1000)").bind(Math.floor(controller.scheduledTime/1000)),
    env.DB.prepare("DELETE FROM login_proof_uses WHERE id IN (SELECT id FROM login_proof_uses WHERE expires_at <= ? LIMIT 1000)").bind(Math.floor(controller.scheduledTime/1000)),
  ]);
  await flushArtifactUploadCleanup(env);
  try {
    const dropped = await deleteOldDrafts(env, controller.scheduledTime);
    if (dropped) console.log(`Draft cron: deleted ${dropped} drafts over 7 days old`);
  } catch (err) {
    console.error("Draft cleanup failed", err);
  }
  try {
    const result = await runExpiry(env);
    console.log(`Expiry cron: deleted ${result.deleted} messages`);
    try {
      const batch = await sweepBatchReceipts(env);
      console.log(`Batch sweep: abandoned ${batch.abandoned}, settled ${batch.settled}, deleted ${batch.deleted}`);
    } catch (err) {
      console.error("Batch sweep failed", err);
    }
    const chat = await runChatExpiry(env);
    console.log(`Expiry cron: deleted ${chat.deleted} conversations`);
    const backup = await runWorkspaceBackup(env);
    console.log(
      `Workspace backup: wrote ${backup.key} (${backup.size} bytes, ${backup.counts.documents} docs, ${backup.counts.artifacts} artifacts)`
    );
  } catch (err) {
    console.error("Expiry/backup cron failed", err);
    throw err;
  }
}
