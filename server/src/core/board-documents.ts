import type { AgentBoardPost, BoardAuthorKind } from "./agent-board";
import { agentSponsorAccessSql } from "./agent-access";
import { sha256Hex } from "./auth-utils";
import { boardDocumentAudienceStatements } from "./document-audience";
import { typesetDocument } from "./documents/typeset";
import { editionAccountLimits, reserveEditionUsage, UsageRefused } from "./edition-hooks";
import { runGovernedContentCleanup } from "./governed-content-cleanup";
import type { Env } from "./types";
import { appHref } from "./base-path";

export const BOARD_DOCUMENT_MAX_CHARS = 100_000;

/** Called only for an already-authorized, bounded board page. Keep full text
 * server-side for ticket detection; named responses expose only the link. */
export async function loadBoardDocumentDetails(env: Env, entryIds: string[]): Promise<Map<string, {
  body: string; original_reference: string | null; document_url: string;
}>> {
  if (!entryIds.length) return new Map();
  if (entryIds.length > 100) throw new Error("board document lookup exceeds page limit");
  const rows = (await env.DB.prepare(`SELECT d.entry_id,d.original_reference,m.id,m.body
    FROM agent_board_documents d JOIN messages m ON m.id=d.message_id
    WHERE d.entry_id IN (${entryIds.map(() => "?").join(",")})`)
    .bind(...entryIds).all<{ entry_id: string; original_reference: string | null; id: string; body: string }>()).results;
  return new Map((rows ?? []).map(row => [row.entry_id, {
    body: row.body, original_reference: row.original_reference,
    document_url: appHref(env, `/docs/${row.id}`),
  }]));
}

export interface PreparedBoardDocument {
  id: string;
  url: string;
  body: string;
  statements: D1PreparedStatement[];
  rollback(): Promise<void>;
}

/** Stage through the existing typesetter/R2 pipeline, then publish in the board's
 * D1 transaction. Every attempt owns a random object and reservation: a losing
 * retry cannot delete the winning retry's object or release its usage. */
export async function prepareBoardDocument(env: Env, input: {
  entryId: string; teamId: string; projectId: string; agentId: string;
  userId: string; authorKind: BoardAuthorKind; post: AgentBoardPost;
}): Promise<PreparedBoardDocument> {
  const id = crypto.randomUUID();
  const key = `docs/${id}.html`;
  const url = appHref(env, `/docs/${id}`);
  const fullText = input.post.body + (input.post.reference ? `\n\nReference: ${input.post.reference}` : "");
  const html = typesetDocument({ title: input.post.topic, body: fullText, project: input.projectId, createdAt: new Date().toISOString() });
  const size = new TextEncoder().encode(html).byteLength;
  const limits = await editionAccountLimits(env, input.userId);
  if (limits && size > limits.max_upload_bytes) throw new UsageRefused("The full board document exceeds the upload limit", 413, "storage_bytes");
  let storageReserved = false;
  let deliveryReserved = false;
  const rollback = async () => {
    const cleanupId = `board-document:${id}:rollback`;
    const releases = [
      ...(storageReserved ? [{ metric: "storage_bytes", amount: size, idempotencyKey: `board-document:${id}:storage:rollback` }] : []),
      ...(deliveryReserved ? [{ metric: "deliveries", amount: 1, idempotencyKey: `board-document:${id}:delivery:rollback` }] : []),
    ];
    // Persist before touching R2 or usage. A lost batch response must never
    // compensate a document whose metadata actually committed.
    await env.DB.prepare(`INSERT INTO governed_content_cleanup
      (id,resource_type,resource_id,user_id,object_keys,storage_bytes,usage_releases)
      SELECT ?,'document',?,?,?,0,? WHERE NOT EXISTS(SELECT 1 FROM messages WHERE id=?)
      ON CONFLICT(id) DO NOTHING`).bind(cleanupId, id, input.userId, JSON.stringify([key]), JSON.stringify(releases), id).run();
    await runGovernedContentCleanup(env, cleanupId);
  };
  try {
    deliveryReserved = (await reserveEditionUsage(env, input.userId, "deliveries", 1, `board-document:${id}:delivery:add`)).managed;
    storageReserved = (await reserveEditionUsage(env, input.userId, "storage_bytes", size, `board-document:${id}:storage:add`)).managed;
    await env.DOCS.put(key, html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
    // The CHECK is evaluated in the same batch as insertion. A removed sponsor,
    // revoked board grant, closed board, or removed reply aborts every write.
    const authorized = `EXISTS (SELECT 1 FROM agent_board_entries e
      JOIN projects p ON p.id=e.project_id AND p.team_id=e.team_id
      JOIN agent_identities a ON a.id=e.agent_id AND a.team_id=e.team_id
      JOIN team_memberships tm ON tm.team_id=e.team_id AND tm.user_id=e.user_id
      JOIN users owner ON owner.id=e.user_id AND owner.status='active'
      WHERE e.id=? AND e.team_id=? AND e.project_id=? AND e.agent_id=? AND e.user_id=?
        AND a.status='active' AND a.created_by_user_id=e.user_id
        AND tm.role IN ('owner','admin','member') AND p.archived_at IS NULL
        AND (p.board_kind IS NOT 'work' OR (datetime(p.expires_at)>datetime('now')
          AND EXISTS (SELECT 1 FROM projects parent WHERE parent.id=p.parent_project_id AND parent.archived_at IS NULL)))
        AND (e.reply_to_seq IS NULL OR EXISTS (SELECT 1 FROM agent_board_entries target
          WHERE target.project_id=e.project_id AND target.seq=e.reply_to_seq
            AND NOT EXISTS (SELECT 1 FROM agent_board_moderation moderation WHERE moderation.entry_id=target.id)))
        AND ${input.authorKind === "person" ? "a.kind='person'" : `a.kind='agent' AND ${agentSponsorAccessSql(env)}
          AND EXISTS (SELECT 1 FROM agent_project_grants g WHERE g.agent_id=a.id AND g.project_id=p.id AND g.permission='write')
          AND (p.board_kind IS NOT 'work' OR EXISTS (SELECT 1 FROM agent_project_grants pg
            WHERE pg.agent_id=a.id AND pg.project_id=p.parent_project_id AND pg.permission='write'))`})`;
    const statements = [
      env.DB.prepare(`INSERT INTO messages
        (id,type,title,body,doc_key,doc_slug,doc_version,is_latest,user_id,team_id,sharing,public,
         doc_kind,doc_size,source_size,instance_model,instance_session_id,instance_project,instance_source)
        VALUES (?,'document',?,?,?,?,1,1,?,?,'private',0,'doc',?,0,?,?,?,?)`)
        .bind(id, input.post.topic, input.post.body, key, id, input.userId, input.teamId, size,
          input.post.session?.model ?? "", input.post.session?.session_id ?? input.entryId,
          input.projectId, input.post.session?.origin ?? "board"),
      env.DB.prepare(`INSERT INTO agent_board_documents(entry_id,message_id,original_reference,body_hash,authorized)
        VALUES (?,?,?,?,${authorized})`).bind(input.entryId, id, input.post.reference, await sha256Hex(input.post.body),
          input.entryId, input.teamId, input.projectId, input.agentId, input.userId),
      ...await boardDocumentAudienceStatements(env, { documentId: id, teamId: input.teamId, projectId: input.projectId, userId: input.userId }),
      env.DB.prepare("INSERT INTO audit_log(action,instance_id,details,user_id) VALUES ('post_document',?,?,?)")
        .bind(input.post.session?.session_id ?? input.entryId, JSON.stringify({ document_id: id, board_entry_id: input.entryId, project_id: input.projectId }), input.userId),
    ];
    // Leave ample space for URLs and never split a UTF-16 surrogate pair.
    const excerpt = Array.from(input.post.body).slice(0, 450).join("");
    return { id, url, body: `${excerpt}…\n\n${url}`, statements, rollback };
  } catch (error) {
    await rollback();
    throw error;
  }
}
