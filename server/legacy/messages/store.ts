import { sendPushNotification } from "../push/apns";
import type { Env, InstanceIdentity, MessageBlockInput } from "../types";
import { deferOrAwait } from "../utils";

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
  input: MessageBlockInput[] | undefined
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
      "SELECT id, user_id, title, favicon, current_version FROM artifacts WHERE id = ?"
    )
      .bind(artifactId)
      .first<{
        id: string;
        user_id: string;
        title: string;
        favicon: string;
        current_version: number;
      }>();
    if (!artifact || artifact.user_id !== userId) {
      throw new MessageBlockInputError(`blocks[${position}] artifact not found`);
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
}

export interface CreateMessageResult {
  id: string;
  body: string | null;
  blocks: PreparedMessageBlock[];
}

export async function createMessage(
  env: Env,
  input: CreateMessageInput,
  ctx?: ExecutionContext
): Promise<CreateMessageResult> {
  if (!input.userId) throw new Error("authenticated user required");
  const id = input.id ?? crypto.randomUUID();
  const blocks = await prepareMessageBlocks(env, input.userId, input.blocks);
  const body = input.body ?? deriveMessageBody(blocks);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO messages (id, type, title, body, doc_key, priority, public,
        doc_slug, doc_version, is_latest, design_system, enhance_status, enhance_level,
        instance_model, instance_session_id, instance_project, instance_source, source_url, user_id,
        interactive, team_id, project_id, doc_kind, doc_size, source_size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      input.teamId ?? null,
      input.projectId ?? null,
      input.docKind ?? "doc",
      input.docSize ?? 0,
      input.sourceSize ?? 0
    ),
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

  statements.push(
    env.DB.prepare(
      `INSERT INTO audit_log (action, instance_id, details, user_id)
       VALUES (?, ?, ?, ?)`
    ).bind(
      `post_${input.type}`,
      input.instance.session_id,
      `${input.instance.model} posted "${input.title}" from ${input.instance.project}`,
      input.userId
    )
  );

  await env.DB.batch(statements);

  const pushBody =
    input.type === "question"
      ? `${input.instance.project}: ${input.title}`
      : body?.slice(0, 100) || input.title;
  const push = sendPushNotification(
    env,
    input.type === "question" ? "Question from PidginDocs" : "New from PidginDocs",
    pushBody,
    id,
    input.type,
    input.userId
  ).catch((err) => console.error("push delivery failed", err));
  await deferOrAwait(ctx, push);

  return { id, body, blocks };
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
