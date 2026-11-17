import type { Env } from "../types";
import { messageEditSql, messageReadSql } from "../workspace-access";

/** Priority remains author-owned metadata. Documents additionally need current
 * edit access, and composed messages retain their source read requirements. */
export async function updateMessagePriority(env: Env, userId: string, messageId: string,
  priority: "normal" | "urgent"): Promise<boolean> {
  const result = await env.DB.prepare(`UPDATE messages SET priority = ?
    WHERE id = ? AND user_id = ? AND ${messageReadSql("messages")}
      AND (type <> 'document' OR ${messageEditSql("messages")})
      AND (team_id IS NULL OR EXISTS (SELECT 1 FROM team_memberships membership
        WHERE membership.team_id=messages.team_id AND membership.user_id=?
          AND membership.role IN ('owner','admin','member')))`)
    .bind(priority, messageId, userId, userId, userId, userId, userId, userId).run();
  return (result.meta.changes ?? 0) > 0;
}
