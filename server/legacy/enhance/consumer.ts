import type { Env, EnhanceJob } from "../types";
import {
  loadDocumentText,
  renderMarkdownDocument,
  sourceMarkdownKey,
  storeSourceMarkdown,
  summarizeDocumentHtml,
} from "../documents";
import { validateDesignSystem } from "../documents/design-system";
import { putDesignSystem, resolveDesignSystem } from "../design-systems";
import { sendPushNotification } from "../push/apns";
import { callAnthropic } from "./anthropic";
import { callEnhancementModel, utf8ByteLength } from "./provider";
import {
  IMPORT_MAX_TOKENS,
  IMPORT_MODEL,
  LEVEL_MAX_TOKENS,
  LEVEL_MODELS,
  buildEnhancePrompt,
  buildImportPrompt,
} from "./prompts";

// Terminal failure is recorded on the 3rd delivery (attempts is 1-based) —
// one delivery BEFORE wrangler.toml's max_retries = 3 cap is exhausted (that
// cap allows 4 deliveries total: 1 initial + 3 retries). Recording failure
// early and acking leaves one retry in reserve: if the terminal write itself
// (markJobFailed) throws before the message is acked, Cloudflare redelivers
// once more, and that 4th delivery acts as a backstop that re-attempts
// markJobFailed instead of the job being silently dropped.
const MAX_ATTEMPTS = 3;

type EnhanceKind = Extract<EnhanceJob, { kind: "enhance" }>;
type ImportKind = Extract<EnhanceJob, { kind: "import" }>;

interface V1Row {
  id: string;
  title: string;
  doc_key: string | null;
  doc_slug: string | null;
  public: number;
  priority: string;
  user_id: string | null;
  instance_model: string;
  instance_project: string;
  instance_source: string;
}

export async function handleEnhanceQueueBatch(
  batch: MessageBatch<EnhanceJob>,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    const job = message.body;
    try {
      if (job.kind === "import") {
        await processImportJob(env, job);
      } else {
        await processEnhanceJob(env, job);
      }
      message.ack();
    } catch (err) {
      const reason = err instanceof Error ? err.message : "enhancement failed";
      if (message.attempts >= MAX_ATTEMPTS) {
        await markJobFailed(env, job, reason);
        message.ack();
      } else {
        message.retry();
      }
    }
  }
}

async function processEnhanceJob(env: Env, job: EnhanceKind): Promise<void> {
  const scope = job.userId ? " AND user_id = ?" : "";
  const binds: unknown[] = job.userId ? [job.docId, job.userId] : [job.docId];
  const v1 = await env.DB.prepare(
    `SELECT id, title, doc_key, doc_slug, public, priority, user_id,
            instance_model, instance_project, instance_source
     FROM messages WHERE id = ?${scope}`
  )
    .bind(...binds)
    .first<V1Row>();
  if (!v1) return; // document deleted since queueing — nothing to enhance

  const slug = v1.doc_slug || v1.id;
  const existing = await env.DB.prepare(
    "SELECT id FROM messages WHERE doc_slug = ? AND doc_version = 2"
  )
    .bind(slug)
    .first<{ id: string }>();
  if (existing) {
    // Redelivery after a partially-acked success: record completion, publish nothing.
    await env.DB.prepare("UPDATE messages SET enhance_status = 'done' WHERE id = ?").bind(v1.id).run();
    return;
  }

  await env.DB.prepare("UPDATE messages SET enhance_status = 'running' WHERE id = ?").bind(v1.id).run();

  const source = await loadDocumentText(env, sourceMarkdownKey(v1.doc_key));
  if (!source) {
    throw new Error("source markdown is missing from R2 — cannot enhance");
  }

  // Fail fast instead of burning a paid Anthropic call: if the design system
  // was deleted after this job was queued, every retry would otherwise pay
  // for a completion it can never render.
  const designSystem = await resolveDesignSystem(env, v1.user_id, job.designSystemName);
  if (!designSystem) {
    throw new Error(`design system "${job.designSystemName}" no longer exists`);
  }

  const { system, user } = buildEnhancePrompt(job.level, {
    title: v1.title,
    markdown: source,
    instructions: job.instructions,
    voice: designSystem.voice,
  });
  const enhanced = await callEnhancementModel(env, {
    level: job.level,
    anthropicModel: LEVEL_MODELS[job.level],
    system,
    user,
    sourceMarkdownBytes: utf8ByteLength(source),
    maxTokens: LEVEL_MAX_TOKENS[job.level],
  });

  const newId = crypto.randomUUID();
  const { html } = await renderMarkdownDocument(env, {
    title: v1.title,
    markdown: enhanced,
    project: v1.instance_project,
    createdAt: new Date().toISOString(),
    userId: v1.user_id,
    designSystemName: job.designSystemName,
  });
  const newDocKey = `docs/${newId}.html`;
  const docSize = new TextEncoder().encode(html).byteLength;
  const sourceSize = utf8ByteLength(enhanced);
  try {
    await storeSourceMarkdown(env, newId, enhanced, v1.title);
    await env.DOCS.put(newDocKey, html, {
      httpMetadata: { contentType: "text/html" },
      customMetadata: { title: v1.title, project: v1.instance_project, source: "enhance" },
    });

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO messages (id, type, title, body, doc_key, priority, public,
          doc_slug, doc_version, is_latest, design_system, enhance_status, enhance_level,
          instance_model, instance_session_id, instance_project, instance_source, user_id,
          doc_size, source_size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        newId,
        "document",
        v1.title,
        summarizeDocumentHtml(html, v1.title),
        newDocKey,
        v1.priority,
        v1.public,
        slug,
        2,
        1,
        job.designSystemName,
        "done",
        job.level,
        v1.instance_model,
        `enhance-${newId}`,
        v1.instance_project,
        v1.instance_source,
        v1.user_id,
        docSize,
        sourceSize
      ),
      env.DB.prepare(
        "UPDATE messages SET is_latest = 0, enhance_status = 'done' WHERE id = ?"
      ).bind(v1.id),
      env.DB.prepare(
        "INSERT INTO audit_log (action, instance_id, details, user_id) VALUES (?, ?, ?, ?)"
      ).bind("enhance_document", `enhance-${newId}`, `Enhanced "${v1.title}" (${job.level}) as v2`, v1.user_id),
    ]);
  } catch (error) {
    await env.DOCS.delete(newDocKey).catch(() => {});
    const sourceKey = sourceMarkdownKey(newDocKey);
    if (sourceKey) await env.DOCS.delete(sourceKey).catch(() => {});
    throw error;
  }

  await sendPushNotification(
    env,
    "Document enhanced",
    `${v1.title} — enhanced version ready`,
    newId,
    "document",
    v1.user_id ?? ""
  ).catch((err) => console.error("enhance push failed", err));
}

// Import notices ride the normal message inbox so push deep-links resolve to a
// real message row.
async function insertNotice(env: Env, userId: string, title: string, body: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO messages (id, type, title, body, priority,
      instance_model, instance_session_id, instance_project, instance_source, user_id)
     VALUES (?, 'message', ?, ?, 'normal', 'pidgin-enhance', ?, 'pidgin', 'enhance', ?)`
  )
    .bind(id, title, body, `enhance-${id}`, userId)
    .run();
  return id;
}

function parseJsonBlock(raw: string): Record<string, unknown> {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(stripped) as Record<string, unknown>;
}

async function processImportJob(env: Env, job: ImportKind): Promise<void> {
  const { system, user } = buildImportPrompt({ name: job.name, material: job.material });
  const raw = await callAnthropic(env, {
    model: IMPORT_MODEL,
    system,
    user,
    maxTokens: IMPORT_MAX_TOKENS,
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonBlock(raw);
  } catch {
    throw new Error("import translation did not return valid JSON");
  }
  const css = typeof parsed.css === "string" ? parsed.css : "";
  const errors = validateDesignSystem({ tokens: parsed.tokens, css });
  if (errors.length) {
    throw new Error(`imported design system failed validation: ${errors.join("; ")}`);
  }

  await putDesignSystem(env, job.userId, {
    name: job.name,
    displayName: typeof parsed.display_name === "string" ? parsed.display_name : job.name,
    description: typeof parsed.description === "string" ? parsed.description : "",
    tokens: parsed.tokens as Record<string, unknown>,
    css,
    source: "imported",
  });

  const noticeId = await insertNotice(
    env,
    job.userId,
    "Design system ready",
    `"${job.name}" was imported and is ready to use with design_system: "${job.name}".`
  );
  await sendPushNotification(
    env,
    "Design system ready",
    `"${job.name}" imported successfully`,
    noticeId,
    "message",
    job.userId
  ).catch((err) => console.error("import push failed", err));
}

async function markJobFailed(env: Env, job: EnhanceJob, reason: string): Promise<void> {
  const trimmed = reason.slice(0, 500);
  if (job.kind === "enhance") {
    await env.DB.prepare(
      "UPDATE messages SET enhance_status = 'failed', enhance_error = ? WHERE id = ?"
    )
      .bind(trimmed, job.docId)
      .run();
    return;
  }
  const noticeId = await insertNotice(
    env,
    job.userId,
    "Design system import failed",
    `"${job.name}" could not be imported: ${trimmed}`
  );
  await sendPushNotification(
    env,
    "Design system import failed",
    `"${job.name}": ${trimmed.slice(0, 80)}`,
    noticeId,
    "message",
    job.userId
  ).catch((err) => console.error("import failure push failed", err));
}
