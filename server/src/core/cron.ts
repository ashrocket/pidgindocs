import { runGovernedContentCleanup } from "./governed-content-cleanup";
import { editionProductName, editionScheduledJobs, runEditionExpiry, runEditionMaintenance, settleEditionPlans, releaseEditionUsage } from "./edition-hooks";
import { Env } from "./types";
import { runScheduledWorkspaceBackup } from "./workspace-backup-scheduled";
import { promoteLatestVersion, sourceMarkdownKey } from "./documents";
import { runEventsLifecycle } from "./events/dispatch";

export async function runExpiry(env: Env): Promise<{ deleted: number }> {
  // Find all rows where expires_at has passed and they are not pinned.
  const candidates = await env.DB.prepare(
    `SELECT m.id, m.doc_key, m.user_id, m.doc_size, m.source_size,
            m.type, m.doc_slug, m.team_id, m.is_latest,
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
    type?: string;
    doc_slug?: string | null;
    team_id?: string | null;
    is_latest?: number | null;
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
  const remove = env.DB.prepare(
    `DELETE FROM messages WHERE id IN (${placeholders})`
  ).bind(...ids);
  // An expired latest version hands "latest" to the highest version left (one
  // kept by a pin, say), so the document does not vanish from every list.
  const promotions = deletable
    .filter((row) => row.type === "document" && row.is_latest !== 0)
    .map((row) => promoteLatestVersion(env, { id: row.id, doc_slug: row.doc_slug, team_id: row.team_id, user_id: row.user_id }));
  const result = promotions.length ? (await env.DB.batch([remove, ...promotions]))[0] : await remove.run();

  await Promise.allSettled(deletable.map(async (row) => {
    const storedBytes =
      Number(row.doc_size || 0) +
      Number(row.source_size || 0) +
      Number(row.transcript_size || 0) +
      Number(row.audio_size || 0) +
      Number(row.metadata_size || 0);
    if (!row.user_id || storedBytes <= 0) return;
    await releaseEditionUsage(
      env,
      row.user_id,
      "storage_bytes",
      storedBytes,
      `message:${row.id}:storage:expiry`
    );
  }));

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

export async function scheduled(
  _controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext
): Promise<void> {
  try { await runGovernedContentCleanup(env); }
  catch { console.warn("Governed content cleanup will retry next run"); }
  // Edition jobs (for example paid cancellations, security monitoring, board
  // lifecycle and trash, member invitations) each have their own failure boundary.
  for (const job of editionScheduledJobs()) {
    try {
      const line = await job.run(env, new Date(_controller.scheduledTime));
      if (line) console.log(line);
    } catch (err) {
      console.error(job.failure, err);
    }
  }
  // Also on its own: re-dispatches events left undispatched for over a minute and expires deferred actions.
  try {
    const events = await runEventsLifecycle(env);
    console.log(`Events: dispatched ${events.dispatched}, expired ${events.expired} deferred actions, pruned ${events.pruned} rows`);
  } catch (err) {
    console.error("Events lifecycle cron failed", err);
  }
  try {
    await runEditionMaintenance(env);
    const result = await runExpiry(env);
    console.log(`Expiry cron: deleted ${result.deleted} messages`);
    const chat = await runChatExpiry(env);
    console.log(`Expiry cron: deleted ${chat.deleted} conversations`);
    const edition = await runEditionExpiry(env);
    if (edition) console.log(edition);
    const plans = await settleEditionPlans(env);
    console.log(`${editionProductName()} team plans: ${plans.debited} cycles debited, ${plans.due} awaiting credits`);
  } catch (err) {
    console.error("Expiry cron failed", err);
    // Backup still runs when expiry or billing fails.
    await runScheduledWorkspaceBackup(env, _controller.scheduledTime);
    throw err;
  }
  await runScheduledWorkspaceBackup(env, _controller.scheduledTime);
}
