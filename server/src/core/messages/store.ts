import { editionContentStoreStatements, editionProductName } from "../edition-hooks";
import { contentPolicy, restrictedContentTeams, type DocumentPublishPolicy } from "../content-policy";
import { DocumentAudienceError, documentDefaultStatements, resolveDocumentDefaultTeam } from "../document-audience";
import {
  assertWorkspacePublishScope, assertGovernedDraft, canReadResource, resolveSharingTeam, WorkspaceAccessError, type Sharing,
} from "../workspace-access";
import { sendPushNotification } from "../push/apns";
import type { Env, InstanceIdentity, MessageBlockInput } from "../types";
import { deferOrAwait } from "../utils";
import { DocumentSlugTakenError } from "../documents";
import { DOCUMENT_FAMILY_SQL, documentFamilyBinds } from "../documents/family";
import { scheduleDispatch } from "../events/dispatch";
import { emitEvent, eventIdFor, messageRef, userRef } from "../events/emit";

export const MAX_MESSAGE_BLOCKS = 20;
export const MAX_ARTIFACT_BLOCKS = 6;
export const MAX_MARKDOWN_BLOCK_LENGTH = 100_000;
export const MAX_BLOCK_METADATA_LENGTH = 240;

export class MessageBlockInputError extends Error {}

export interface PreparedMarkdownBlock {
  type: "markdown";
  markdown: string;
}

export interface PreparedArtifactBlock {
  type: "artifact";
  artifact_id: string;
  version: number;
  label: string | null;
  producer: string | null;
  producer_action: string | null;
  summary: string;
  collapsed: boolean;
  artifact_title_snapshot: string;
  artifact_favicon_snapshot: string;
}

export type PreparedMessageBlock = PreparedMarkdownBlock | PreparedArtifactBlock;

export interface StoredMessageBlockRow {
  message_id: string;
  position: number;
  kind: "markdown" | "artifact";
  markdown: string | null;
  artifact_id: string | null;
  artifact_version: number | null;
  label: string | null;
  producer: string | null;
  producer_action: string | null;
  summary: string | null;
  collapsed: number | boolean;
  artifact_title_snapshot: string | null;
  artifact_favicon_snapshot: string | null;
  artifact_current_version: number | null;
  artifact_capabilities: string | null;
  artifact_exists: number | boolean;
  version_exists: number | boolean;
}

export interface SerializedMessageBlock {
  type: "markdown" | "artifact";
  markdown?: string;
  artifact_id?: string;
  version?: number;
  label?: string | null;
  producer?: string | null;
  producer_action?: string | null;
  summary?: string;
  collapsed?: boolean;
  artifact_title?: string;
  artifact_favicon?: string;
  artifact_available?: boolean;
  latest_version?: number | null;
  has_capabilities?: boolean;
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new MessageBlockInputError(`"${field}" must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_BLOCK_METADATA_LENGTH) {
    throw new MessageBlockInputError(
      `"${field}" must be at most ${MAX_BLOCK_METADATA_LENGTH} characters`
    );
  }
  return trimmed;
}

export async function prepareMessageBlocks(
  env: Env,
  userId: string,
  input: MessageBlockInput[] | undefined,
  teamId?: string | null
): Promise<PreparedMessageBlock[]> {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_MESSAGE_BLOCKS) {
    throw new MessageBlockInputError(
      `"blocks" must contain 1-${MAX_MESSAGE_BLOCKS} items`
    );
  }

  const prepared: PreparedMessageBlock[] = [];
  let artifactCount = 0;

  for (let position = 0; position < input.length; position++) {
    const raw = input[position] as MessageBlockInput;
    if (!raw || typeof raw !== "object") {
      throw new MessageBlockInputError(`blocks[${position}] must be an object`);
    }

    if (raw.type === "markdown") {
      if (typeof raw.markdown !== "string" || !raw.markdown.trim()) {
        throw new MessageBlockInputError(`blocks[${position}].markdown is required`);
      }
      if (raw.markdown.length > MAX_MARKDOWN_BLOCK_LENGTH) {
        throw new MessageBlockInputError(
          `blocks[${position}].markdown exceeds ${MAX_MARKDOWN_BLOCK_LENGTH} characters`
        );
      }
      prepared.push({ type: "markdown", markdown: raw.markdown.trim() });
      continue;
    }

    if (raw.type !== "artifact") {
      throw new MessageBlockInputError(
        `blocks[${position}].type must be "markdown" or "artifact"`
      );
    }

    artifactCount += 1;
    if (artifactCount > MAX_ARTIFACT_BLOCKS) {
      throw new MessageBlockInputError(
        `"blocks" may contain at most ${MAX_ARTIFACT_BLOCKS} artifact items`
      );
    }
    if (typeof raw.artifact_id !== "string" || !raw.artifact_id.trim()) {
      throw new MessageBlockInputError(`blocks[${position}].artifact_id is required`);
    }
    if (typeof raw.summary !== "string" || !raw.summary.trim()) {
      throw new MessageBlockInputError(
        `blocks[${position}].summary is required for fallback and accessibility`
      );
    }
    if (raw.collapsed !== undefined && typeof raw.collapsed !== "boolean") {
      throw new MessageBlockInputError(`blocks[${position}].collapsed must be a boolean`);
    }
    if (raw.summary.trim().length > 2_000) {
      throw new MessageBlockInputError(`blocks[${position}].summary must be at most 2000 characters`);
    }

    const artifactId = raw.artifact_id.trim();
    const artifact = await env.DB.prepare(
      "SELECT id, user_id, title, favicon, current_version, team_id, sharing FROM artifacts WHERE id = ?"
    )
      .bind(artifactId)
      .first<{
        id: string;
        user_id: string;
        team_id: string | null;
        sharing: string;
        title: string;
        favicon: string;
        current_version: number;
      }>();
    if (!artifact || !await canReadResource(env, userId, artifact) || (teamId && (artifact.team_id !== teamId || artifact.sharing !== "shared"))) {
      throw new MessageBlockInputError(`blocks[${position}] artifact not found`);
    }
    // A block copies the title and summary into its parent. Its readers cannot
    // be narrowed later by denying the iframe, so restricted pages are linked
    // separately instead of being copied into a message.
    if (artifact.team_id && await restrictedContentTeams(env, artifact.team_id)) {
      throw new MessageBlockInputError(`blocks[${position}] cannot embed an artifact with document access controls; share its link instead`);
    }

    const version = raw.version === undefined ? artifact.current_version : raw.version;
    if (!Number.isInteger(version) || (version as number) < 1) {
      throw new MessageBlockInputError(`blocks[${position}].version must be a positive integer`);
    }
    const storedVersion = await env.DB.prepare(
      "SELECT version FROM artifact_versions WHERE artifact_id = ? AND version = ?"
    )
      .bind(artifactId, version)
      .first<{ version: number }>();
    if (!storedVersion) {
      throw new MessageBlockInputError(`blocks[${position}] artifact version not found`);
    }

    prepared.push({
      type: "artifact",
      artifact_id: artifactId,
      version: version as number,
      label: optionalText(raw.label, `blocks[${position}].label`),
      producer: optionalText(raw.producer, `blocks[${position}].producer`),
      producer_action: optionalText(
        raw.producer_action,
        `blocks[${position}].producer_action`
      ),
      summary: raw.summary.trim(),
      collapsed: raw.collapsed === true,
      artifact_title_snapshot: artifact.title,
      artifact_favicon_snapshot: artifact.favicon,
    });
  }

  return prepared;
}

export function deriveMessageBody(blocks: PreparedMessageBlock[]): string | null {
  if (blocks.length === 0) return null;
  const parts = blocks.map((block) =>
    block.type === "markdown"
      ? block.markdown
      : `${block.label || block.artifact_title_snapshot}: ${block.summary}`
  );
  const body = parts.join("\n\n").trim();
  return body || null;
}

export interface CreateMessageInput {
  id?: string;
  type: "message" | "question" | "status" | "document";
  title: string;
  body: string | null;
  docKey?: string | null;
  priority?: "normal" | "urgent";
  isPublic?: boolean;
  docSlug?: string | null;
  // The slug was chosen by the caller: refuse it (DocumentSlugTakenError)
  // when the document's audience already has a version family under it.
  exclusiveDocSlug?: boolean;
  docVersion?: number | null;
  isLatest?: boolean;
  designSystem?: string | null;
  enhanceStatus?: string | null;
  enhanceLevel?: string | null;
  sourceUrl?: string | null;
  interactive?: boolean;
  teamId?: string | null;
  projectId?: string | null;
  docKind?: string | null;
  docSize?: number;
  sourceSize?: number;
  instance: InstanceIdentity;
  userId: string;
  blocks?: MessageBlockInput[];
  // Documents only: undefined = private, or the version family's sharing.
  // Posts, questions and statuses in a team are always shared.
  sharing?: Sharing;
}

export interface CreateMessageResult {
  readAccess?: DocumentPublishPolicy["readAccess"];
  id: string;
  body: string | null;
  blocks: PreparedMessageBlock[];
  teamId: string | null;
  sharing: Sharing;
}

export async function createMessage(
  env: Env,
  input: CreateMessageInput,
  ctx?: ExecutionContext
): Promise<CreateMessageResult> {
  let sharing = input.type === "document" ? input.sharing ?? "private" : "shared";
  if (sharing !== "private" && sharing !== "shared") throw new MessageBlockInputError('"sharing" must be "private" or "shared"');
  let teamId = input.teamId;
  const id = input.id ?? crypto.randomUUID();
  let publishPolicy: DocumentPublishPolicy | undefined;
  try {
    if (input.type === "document") teamId = await resolveDocumentDefaultTeam(env,{userId:input.userId,teamId,projectId:input.projectId,sharing:input.sharing,isPublic:input.isPublic});
    if (input.type === "document" && sharing === "shared" && !teamId) teamId = await resolveSharingTeam(env, input.userId);
    await assertWorkspacePublishScope(env, input.userId, teamId, input.projectId);
    if (input.type === "document") {
      publishPolicy = await contentPolicy().documentPublish?.(env, {
        id, resourceKey: input.docSlug ?? id, userId: input.userId, teamId: teamId ?? null,
        projectId: input.projectId ?? undefined, sharing,
      });
      if (publishPolicy && input.enhanceLevel) throw new WorkspaceAccessError('Enhance a private draft before assigning team read access in Access controls.');
      if (publishPolicy) sharing = publishPolicy.sharing;
      else await assertGovernedDraft(env, teamId, sharing);
    }
  }
  catch (err) { if (err instanceof WorkspaceAccessError || err instanceof DocumentAudienceError) throw new MessageBlockInputError(err.message); throw err; }
  if (teamId && input.isPublic) throw new MessageBlockInputError("team documents must remain private");
  const blocks = await prepareMessageBlocks(env, input.userId, input.blocks, teamId);
  const body = input.body ?? deriveMessageBody(blocks);
  // Checked inside the INSERT so two posts racing for one slug cannot both land.
  const slugGuard = input.type === "document" && input.exclusiveDocSlug && input.docSlug
    ? documentFamilyBinds({ id, doc_slug: input.docSlug, team_id: teamId, user_id: input.userId }) : null;
  const values = "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?";
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO messages (id, type, title, body, doc_key, priority, public,
        doc_slug, doc_version, is_latest, design_system, enhance_status, enhance_level,
        instance_model, instance_session_id, instance_project, instance_source, source_url, user_id,
        interactive, team_id, project_id, doc_kind, doc_size, source_size, sharing, sharing_explicit)
       ${slugGuard ? `SELECT ${values} WHERE NOT EXISTS (SELECT 1 FROM messages WHERE ${DOCUMENT_FAMILY_SQL})` : `VALUES (${values})`}`
    ).bind(
      id,
      input.type,
      input.title,
      body,
      input.docKey ?? null,
      input.priority ?? "normal",
      input.type === "document" && input.isPublic ? 1 : 0,
      input.docSlug ?? null,
      input.docVersion ?? null,
      input.isLatest === false ? 0 : 1,
      input.designSystem ?? null,
      input.enhanceStatus ?? null,
      input.enhanceLevel ?? null,
      input.instance.model,
      input.instance.session_id,
      input.instance.project,
      input.instance.source,
      input.sourceUrl ?? null,
      input.userId,
      input.interactive ? 1 : 0,
      teamId ?? null,
      input.projectId ?? null,
      input.docKind ?? "doc",
      input.docSize ?? 0,
      input.sourceSize ?? 0,
      sharing,
      input.type === "document" && input.sharing !== undefined ? 1 : 0,
      ...(slugGuard ?? [])
    ),
    ...(publishPolicy?.statements ?? []),
  ];

  blocks.forEach((block, position) => {
    statements.push(
      env.DB.prepare(
        `INSERT INTO message_blocks (message_id, position, kind, markdown, artifact_id,
          artifact_version, label, producer, producer_action, summary, collapsed,
          artifact_title_snapshot, artifact_favicon_snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id,
        position,
        block.type,
        block.type === "markdown" ? block.markdown : null,
        block.type === "artifact" ? block.artifact_id : null,
        block.type === "artifact" ? block.version : null,
        block.type === "artifact" ? block.label : null,
        block.type === "artifact" ? block.producer : null,
        block.type === "artifact" ? block.producer_action : null,
        block.type === "artifact" ? block.summary : null,
        block.type === "artifact" && block.collapsed ? 1 : 0,
        block.type === "artifact" ? block.artifact_title_snapshot : null,
        block.type === "artifact" ? block.artifact_favicon_snapshot : null
      )
    );
  });

  // question.asked, in the message's own batch: a team question is a team
  // event; a question in someone's own inbox is a personal event, theirs only.
  // subject_ref is the person the question belongs to. Ids only.
  const asked = input.type === "question" ? emitEvent(env, {
    id: await eventIdFor("question.asked", id),
    type: "question.asked",
    ...(input.teamId ? { teamId: input.teamId } : { ownerUserId: input.userId }),
    actorRef: userRef(input.userId),
    subjectRef: userRef(input.userId),
    projectId: input.teamId ? input.projectId ?? null : null,
    payload: { message_id: id, asker_user_id: input.userId },
  }, { sql: "EXISTS (SELECT 1 FROM messages WHERE id = ?)", binds: [id] }) : null;
  if (asked) statements.push(asked.statement);

  statements.push(
    env.DB.prepare(
      `INSERT INTO audit_log (action, instance_id, details, user_id)
       ${slugGuard ? "SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM messages WHERE id = ?)" : "VALUES (?, ?, ?, ?)"}`
    ).bind(
      `post_${input.type}`,
      input.instance.session_id,
      `${input.instance.model} posted "${input.title}" from ${input.instance.project}`,
      input.userId,
      ...(slugGuard ? [id] : [])
    )
  );

  statements.push(...editionContentStoreStatements(env,{userId:input.userId,kind:input.type === "document" ? "document" : "message",id}));
  const defaults = input.type === "document" && input.sharing === undefined && teamId
    ? await documentDefaultStatements(env,{documentId:id,teamId,userId:input.userId,docSlug:input.docSlug}) : [];
  statements.push(...defaults);
  let results: D1Result[];
  try { results = await env.DB.batch(statements); }
  catch(error) {
    // Only this trigger's known atomic rollback is an input refusal. Preserve
    // unrelated/ambiguous storage errors and all existing edition statements.
    if (error instanceof Error && error.message.includes("artifact block version unavailable")) {
      throw new MessageBlockInputError("artifact version no longer available; refresh and retry");
    }
    // A guarded exclusive INSERT can intentionally write no row. Its policy
    // sentinel then aborts the batch; preserve the existing slug-conflict API.
    if(slugGuard && await env.DB.prepare(`SELECT 1 FROM messages WHERE ${DOCUMENT_FAMILY_SQL} LIMIT 1`).bind(...slugGuard).first()) {
      throw new DocumentSlugTakenError(input.docSlug as string);
    }
    const failure = publishPolicy && contentPolicy().documentPublishFailure?.(error);
    if(failure) throw new MessageBlockInputError(failure);
    throw error;
  }
  if (slugGuard && (results[0]?.meta?.changes ?? 0) !== 1) throw new DocumentSlugTakenError(input.docSlug as string);

  const pushBody =
    input.type === "question"
      ? `${input.instance.project}: ${input.title}`
      : body?.slice(0, 100) || input.title;
  const push = sendPushNotification(
    env,
    input.type === "question" ? `Question from ${editionProductName()}` : `New from ${editionProductName()}`,
    pushBody,
    id,
    input.type,
    input.userId
  ).catch((err) => console.error("push delivery failed", err));
  await deferOrAwait(ctx, push);
  if (asked) await scheduleDispatch(env, ctx, [asked.id]);

  if(defaults.length === 2 && results.at(-1)?.meta.changes) sharing = "shared";
  return { id, body, blocks, teamId: teamId ?? null, sharing,
    ...(publishPolicy ? { readAccess: publishPolicy.readAccess } : {}) };
}

export async function loadMessageBlocks(
  env: Env,
  messageIds: string[]
): Promise<Map<string, SerializedMessageBlock[]>> {
  const grouped = new Map<string, SerializedMessageBlock[]>();
  if (messageIds.length === 0) return grouped;

  const placeholders = messageIds.map(() => "?").join(",");
  const result = await env.DB.prepare(
    `SELECT b.*, a.current_version AS artifact_current_version,
      a.capabilities AS artifact_capabilities,
      CASE WHEN a.id IS NULL THEN 0 ELSE 1 END AS artifact_exists,
      CASE WHEN av.version IS NULL THEN 0 ELSE 1 END AS version_exists
     FROM message_blocks b
     LEFT JOIN artifacts a ON a.id = b.artifact_id
     LEFT JOIN artifact_versions av
       ON av.artifact_id = b.artifact_id AND av.version = b.artifact_version
     WHERE b.message_id IN (${placeholders})
     ORDER BY b.message_id, b.position`
  )
    .bind(...messageIds)
    .all<StoredMessageBlockRow>();

  for (const row of result.results ?? []) {
    const serialized: SerializedMessageBlock =
      row.kind === "markdown"
        ? { type: "markdown", markdown: row.markdown ?? "" }
        : {
            type: "artifact",
            artifact_id: row.artifact_id ?? "",
            version: row.artifact_version ?? 0,
            label: row.label,
            producer: row.producer,
            producer_action: row.producer_action,
            summary: row.summary ?? "",
            collapsed: row.collapsed === 1 || row.collapsed === true,
            artifact_title: row.artifact_title_snapshot ?? "Artifact",
            artifact_favicon: row.artifact_favicon_snapshot ?? "◻️",
            artifact_available:
              (row.artifact_exists === 1 || row.artifact_exists === true) &&
              (row.version_exists === 1 || row.version_exists === true),
            latest_version: row.artifact_current_version,
            has_capabilities: Boolean(row.artifact_capabilities),
          };
    const blocks = grouped.get(row.message_id) ?? [];
    blocks.push(serialized);
    grouped.set(row.message_id, blocks);
  }
  return grouped;
}
