import type { Env } from "./types";
import { runWorkspaceBackup } from "./workspace-backup";
import { editionPublicSite } from "./edition-hooks";

/** Log metadata only. A rejected run also marks the platform cron invocation failed. */
export async function runScheduledWorkspaceBackup(env: Env, scheduledTime: number): Promise<void> {
  if (editionPublicSite(env)) return;
  const started = Date.now();
  try {
    const result = await runWorkspaceBackup(env);
    console.log(JSON.stringify({ event: "workspace_backup", status: "success", scheduled_at: scheduledTime,
      key: result.key, bytes: result.size, counts: result.counts, elapsed_ms: Date.now() - started }));
  } catch {
    // Provider exceptions may contain SQL or object content. Keep them out of logs.
    console.error(JSON.stringify({ event: "workspace_backup", status: "failure", scheduled_at: scheduledTime,
      elapsed_ms: Date.now() - started }));
    throw new Error("Workspace backup failed; no successful backup receipt was emitted");
  }
}
