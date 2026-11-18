import { TenantWriteRefused, assertTenantWritable, editionAccountLimits, releaseEditionUsage, reserveEditionUsage } from "../edition-hooks";
import { canReadResource, canEditResource, messageEditSql } from "../workspace-access";
import type { Env, EnhanceJob } from "../types";
import {
  DOCUMENT_FAMILY_SQL,
  documentFamilyBinds,
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
import { runTier } from "../ai/run";
import { resolveTier } from "../ai/tiers";
import {
  IMPORT_MAX_TOKENS,
  IMPORT_TIER,
  LEVEL_MAX_TOKENS,
  LEVEL_TIERS,
  buildEnhancePrompt,
  buildImportPrompt,
} from "./prompts";
import { AudioJobError, markAudioAccessDenied, markAudioFailed, processAudioJob } from "../audio/narration";

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
  team_id: string | null;
  project_id: string | null;
  doc_kind: string | null;
  interactive: number | null;
  instance_model: string;
  instance_project: string;
  instance_source: string;
  sharing: string | null;
}

export async function handleEnhanceQueueBatch(
  batch: MessageBatch<EnhanceJob>,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    const job = message.body;
    try {
      await assertTenantWritable(env);
      if (job.kind === "import") {
        await processImportJob(env, job);
      } else if (job.kind === "audio") {
        await processAudioJob(env, job, message.attempts);
      } else {
        await processEnhanceJob(env, job);
      }
      message.ack();
    } catch (err) {
      let failure = err;
      // A provider can fail while billing changes. Failure notices are product
      // writes too; refresh before taking the ordinary failure path.
      if (!(failure instanceof TenantWriteRefused)) {
        try { await assertTenantWritable(env); }
        catch (billingError) { failure = billingError; }
      }
      if (failure instanceof TenantWriteRefused) {
        await settlePaidDenial(env, message, failure);
        continue;
      }
      const reason = failure instanceof Error ? failure.message : "enhancement failed";
      const permanent = failure instanceof AudioJobError;
      if (permanent || message.attempts >= MAX_ATTEMPTS) {
        try {
          await markJobFailed(env, job, reason);
          message.ack();
        } catch (error) {
          if (!(error instanceof TenantWriteRefused)) throw error;
          await settlePaidDenial(env, message, error);
        }
      } else {
        message.retry();
      }
    }
  }
}

async function settlePaidDenial(
  env: Env, message: Message<EnhanceJob>, error: TenantWriteRefused
): Promise<void> {
  if (error.status === 503 && message.attempts < MAX_ATTEMPTS) {
    message.retry({ delaySeconds: Math.min(300, 30 * 2 ** (message.attempts - 1)) });
    return;
  }
  const job = message.body;
  // Only safe, bounded existing-job metadata or an audit receipt is written.
  // In particular an import denial must never generate an inbox notice/push.
  if (job.kind === "audio") {
    await markAudioAccessDenied(env, job, error.message);
  } else if (job.kind === "enhance") {
    await env.DB.prepare(
      "UPDATE messages SET enhance_status = 'failed', enhance_error = ? WHERE id = ? AND COALESCE(enhance_status, '') <> 'done'"
    ).bind(error.message.slice(0, 500), job.docId).run();
  } else {
    await env.DB.prepare(
      "INSERT INTO audit_log (action, instance_id, details, user_id) VALUES (?, ?, ?, ?)"
    ).bind("paid_background_denied", "enhance-queue",
      JSON.stringify({ kind: job.kind, status: error.status }), job.userId).run();
  }
  message.ack();
}

async function processEnhanceJob(env: Env, job: EnhanceKind): Promise<void> {
  const scope = job.userId ? " AND user_id = ?" : "";
  const binds: unknown[] = job.userId ? [job.docId, job.userId] : [job.docId];
  const v1 = await env.DB.prepare(
    `SELECT id, title, doc_key, doc_slug, public, priority, user_id,
            team_id, project_id, doc_kind, interactive, sharing,
            instance_model, instance_project, instance_source
     FROM messages WHERE id = ?${scope}`
  )
    .bind(...binds)
    .first<V1Row>();
  if (!v1 || !await canReadResource(env, v1.user_id, v1)) return; // document deleted since queueing — nothing to enhance

  const refreshSourceAccess = async () => {
    const current = await env.DB.prepare("SELECT id, doc_slug, user_id, team_id, project_id, sharing FROM messages WHERE id=?").bind(v1.id).first<V1Row>();
    if (!current || !v1.user_id || current.team_id !== v1.team_id || current.project_id !== v1.project_id || !await canEditResource(env, v1.user_id, current, "document")) throw new Error("document is no longer available");
    // Owner unpublishing during a provider call must also unpublish the output.
    v1.sharing = current.sharing;
  };

  // The version family is the slug within v1's audience (its team, or its
  // author's private documents); another audience may reuse the slug.
  const slug = v1.doc_slug || v1.id;
  const family = documentFamilyBinds(v1);
  const laterVersionSql = `SELECT 1 FROM messages WHERE ${DOCUMENT_FAMILY_SQL} AND COALESCE(doc_version, 1) >= 2`;
  const existing = await env.DB.prepare(`${laterVersionSql} LIMIT 1`).bind(...family).first();
  if (existing) {
    // Redelivery after a partially-acked success: record completion, publish nothing.
    await assertTenantWritable(env);
    await env.DB.prepare("UPDATE messages SET enhance_status = 'done' WHERE id = ?").bind(v1.id).run();
    return;
  }

  await assertTenantWritable(env);
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
  await assertTenantWritable(env);
  await refreshSourceAccess();
  let enhanced: string;
  if (job.level === "research") {
    // Research needs web search, which only Anthropic offers: claude-deep alone, no fallback hop,
    // budget-checked and metered like every other tier call.
    const answer = await runTier(env, LEVEL_TIERS.research, {
      system,
      user,
      maxTokens: LEVEL_MAX_TOKENS.research,
      webSearch: true,
      timeoutMs: 120_000,
    }, { noFallback: true });
    enhanced = answer.text.trim();
    if (!enhanced) throw new Error("The AI returned no text content");
  } else {
    const answer = await runTier(env, LEVEL_TIERS[job.level], {
      system,
      user,
      maxTokens: LEVEL_MAX_TOKENS[job.level],
      timeoutMs: 120_000,
    });
    enhanced = answer.text.trim();
    if (!enhanced) throw new Error("The AI returned no text content");
    if (answer.fellBack) console.warn(`enhance ${job.level}: asked ${LEVEL_TIERS[job.level]}, served ${answer.tier}`);
  }

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
  const sourceSize = new TextEncoder().encode(enhanced).byteLength;
  const storedSize = docSize + sourceSize;
  let deliveryReserved = false;
  let storageReserved = false;
  const rollback = async () => {
    await env.DOCS.delete(newDocKey).catch(() => {});
    const sourceKey = sourceMarkdownKey(newDocKey);
    if (sourceKey) await env.DOCS.delete(sourceKey).catch(() => {});
    if (v1.user_id) {
      const releases: Promise<unknown>[] = [];
      if (storageReserved) releases.push(releaseEditionUsage(
        env, v1.user_id, "storage_bytes", storedSize, `enhance:${newId}:storage:rollback`
      ));
      if (deliveryReserved) releases.push(releaseEditionUsage(
        env, v1.user_id, "deliveries", 1, `enhance:${newId}:delivery:rollback`
      ));
      await Promise.allSettled(releases);
    }
  };
  let inserted: boolean;
  try {
    if (v1.user_id) {
      const hosted = await editionAccountLimits(env, v1.user_id);
      if (hosted && storedSize > hosted.max_upload_bytes) {
        throw new Error(
          `enhanced document is ${storedSize} bytes; hosted upload limit is ${hosted.max_upload_bytes}`
        );
      }
      const delivery = await reserveEditionUsage(
        env, v1.user_id, "deliveries", 1, `enhance:${newId}:delivery:add`
      );
      deliveryReserved = delivery.managed;
      const storage = await reserveEditionUsage(
        env, v1.user_id, "storage_bytes", storedSize, `enhance:${newId}:storage:add`
      );
      storageReserved = storage.managed;
    }

    await assertTenantWritable(env);
    await refreshSourceAccess();
    await storeSourceMarkdown(env, newId, enhanced, v1.title);
    await assertTenantWritable(env);
    await env.DOCS.put(newDocKey, html, {
      httpMetadata: { contentType: "text/html" },
      customMetadata: { title: v1.title, project: v1.instance_project, source: "enhance" },
    });

    // v2 joins v1's family: same team, channel and kind. The INSERT is
    // guarded so a redelivery (or any other v2) cannot add a second one, and
    // the rest of the batch only runs when this row was written.
    const written = "EXISTS (SELECT 1 FROM messages fresh WHERE fresh.id = ?)";
    await assertTenantWritable(env);
    await refreshSourceAccess();
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO messages (id, type, title, body, doc_key, priority, public,
          doc_slug, doc_version, is_latest, design_system, enhance_status, enhance_level,
          instance_model, instance_session_id, instance_project, instance_source, user_id,
          doc_size, source_size, team_id, project_id, doc_kind, interactive, sharing)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (${laterVersionSql})
           AND EXISTS (SELECT 1 FROM messages source WHERE source.id=? AND source.user_id IS ? AND source.team_id IS ? AND source.project_id IS ? AND source.sharing IS ?
             AND ${messageEditSql("source")})`
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
        sourceSize,
        v1.team_id,
        v1.project_id,
        v1.doc_kind || "doc",
        v1.interactive ? 1 : 0,
        v1.sharing,
        ...family, v1.id, v1.user_id, v1.team_id, v1.project_id, v1.sharing, v1.user_id, v1.user_id
      ),
      // Superseded like an edited version: out of every list and read.
      env.DB.prepare(
        `UPDATE messages SET is_latest = 0, enhance_status = 'done', read = 1, read_at = COALESCE(read_at, datetime('now'))
         WHERE id = ? AND ${written}`
      ).bind(v1.id, newId),
      env.DB.prepare(
        `INSERT INTO audit_log (action, instance_id, details, user_id) SELECT ?, ?, ?, ? WHERE ${written}`
      ).bind("enhance_document", `enhance-${newId}`, `Enhanced "${v1.title}" (${job.level}) as v2`, v1.user_id, newId),
    ]);
    inserted = (results[0]?.meta?.changes ?? 0) === 1;
  } catch (error) {
    await rollback();
    throw error;
  }
  if (!inserted) {
    // Another v2 landed first: keep it, record completion, publish nothing.
    await rollback();
    await assertTenantWritable(env);
    await env.DB.prepare("UPDATE messages SET enhance_status = 'done' WHERE id = ?").bind(v1.id).run();
    return;
  }

  await assertTenantWritable(env);
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
  await assertTenantWritable(env);
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
  await assertTenantWritable(env);
  const raw = await callAnthropic(env, {
    model: resolveTier(IMPORT_TIER).model,
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

  await assertTenantWritable(env);
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
  await assertTenantWritable(env);
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
  if (job.kind === "audio") {
    await markAudioFailed(env, job, trimmed);
    return;
  }
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
  await assertTenantWritable(env);
  await sendPushNotification(
    env,
    "Design system import failed",
    `"${job.name}": ${trimmed.slice(0, 80)}`,
    noticeId,
    "message",
    job.userId
  ).catch((err) => console.error("import failure push failed", err));
}
