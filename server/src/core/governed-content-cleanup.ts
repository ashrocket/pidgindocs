import type { Env } from "./types";
import { releaseEditionUsage, type UsageMetric } from "./edition-hooks";

async function attemptCompensation(action: () => Promise<unknown>): Promise<boolean> {
  try { await action(); return true; }
  catch { return false; }
}

/** Retryable cleanup after an authorized, atomic metadata deletion. The queue
 * is tenant-local and never accepts paths from a caller. */
export async function runGovernedContentCleanup(env: Env, id?: string): Promise<{ completed: number; pending: number }> {
  const query = env.DB.prepare(`SELECT id,resource_type,resource_id,user_id,object_keys,storage_bytes,usage_releases FROM governed_content_cleanup
    ${id ? "WHERE id=?" : ""} ORDER BY created_at LIMIT 25`);
  const rows = (await (id ? query.bind(id) : query).all<{
    id: string; resource_type: string; resource_id: string; user_id: string; object_keys: string; storage_bytes: number; usage_releases?: string | null;
  }>()).results;
  let completed = 0;
  for (const row of rows) {
    try {
      const keys = JSON.parse(row.object_keys) as string[];
      if (row.usage_releases) {
        if (!await env.DB.prepare("SELECT id FROM messages WHERE id=?").bind(row.resource_id).first()) {
          const releases = JSON.parse(row.usage_releases) as Array<{ metric: UsageMetric; amount: number; idempotencyKey: string }>;
          // All compensations run even while storage or one usage service fails.
          // Stable release keys make a subsequent cron attempt harmless.
          const outcomes = await Promise.all([
            ...keys.map(key => attemptCompensation(() => env.DOCS.delete(key))),
            ...releases.map(release => attemptCompensation(() => releaseEditionUsage(env, row.user_id, release.metric, release.amount, release.idempotencyKey))),
          ]);
          if (outcomes.some(completed => !completed)) throw new Error("board document compensation pending");
        }
        await env.DB.prepare("DELETE FROM governed_content_cleanup WHERE id=?").bind(row.id).run();
        completed++;
        continue;
      }
      for (const key of keys) await env.DOCS.delete(key);
      // Account expiry already ended the entitlement; do not release per-item
      // quota or artifact counts for its combined object manifest.
      if (row.resource_type !== "hosted_account" && row.storage_bytes > 0) await releaseEditionUsage(env, row.user_id, "storage_bytes", row.storage_bytes, `governed-cleanup:${row.id}:storage`);
      if (row.resource_type === "artifact") await releaseEditionUsage(env, row.user_id, "active_artifacts", 1, `governed-cleanup:${row.id}:artifact`);
      await env.DB.prepare("DELETE FROM governed_content_cleanup WHERE id=?").bind(row.id).run();
      completed++;
    } catch {
      // Preserve keys for the next scheduled attempt. Do not log content.
      console.warn("governed content cleanup pending", row.id);
    }
  }
  return { completed, pending: rows.length - completed };
}
