// POST /api/batch: up to 25 sends in one request, each run through the router as the single request
// it stands for. An item is a sub-request built from a fixed table of method and path, carrying the
// caller's own credentials, so every check of its single route (credential kind, scope, grants,
// team restrictions, edition route blocks and metering) applies to it exactly as it does to the
// route itself. Nothing here reimplements one. Items run one after another and fail on their own.
// An Idempotency-Key makes a retry return the first answer instead of sending everything again.
import type { Env } from "../types";
import { corsHeaders } from "../utils";
import { resolveCallerCredential, unauthorized } from "../middleware";
import { allowsCredentialWrite, boundedText, BodyTooLargeError } from "../bounded-body";
import { sha256Hex } from "../auth-utils";

export const BATCH_MAX_ITEMS = 25;
export const BATCH_MAX_BYTES = 2 * 1024 * 1024;
/** A claim with no answer after this long may have committed items: it is held, never replayed. */
export const BATCH_ABANDON_MS = 5 * 60 * 1000;
export const BATCH_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** Runs one sub-request through the router and everything an edition wraps around a request. */
export type BatchDispatch = (request: Request) => Promise<Response>;

type Item = Record<string, unknown>;
interface ItemResult {
  ref: string;
  ok: boolean;
  id?: string;
  version?: number;
  folded?: boolean;
  error?: { code: string; message: string };
}

// Each kind and the single route behind it. Method and path come from here, never from the item.
const ROUTES: Record<string, { method: string; path: string }> = {
  message: { method: "POST", path: "/api/messages" },
  status: { method: "POST", path: "/api/messages" },
  document: { method: "POST", path: "/api/messages" },
  artifact: { method: "POST", path: "/api/artifacts" },
  comment: { method: "POST", path: "/api/comments" },
  delete: { method: "DELETE", path: "/api/artifacts" },
};
const KIND_LIST = Object.keys(ROUTES).join(", ");
const ARTIFACT_ID = /^[a-f0-9-]+$/;

function reply(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

const fail = (ref: string, code: string, message: string): ItemResult => ({ ref, ok: false, error: { code, message } });

async function changed(statement: D1PreparedStatement): Promise<number> {
  return (await statement.run()).meta?.changes ?? 0;
}

function subRequest(original: Request, method: string, path: string, body?: unknown): Request {
  const headers = new Headers(original.headers);
  for (const name of ["content-length", "transfer-encoding", "content-encoding", "idempotency-key"]) headers.delete(name);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(new URL(path, original.url).toString(), {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function codeFor(status: number): string {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 413) return "too_large";
  if (status === 429) return "limit";
  return status >= 500 ? "internal" : "invalid";
}

async function runItem(request: Request, dispatch: BatchDispatch, item: unknown, index: number): Promise<ItemResult> {
  const record = item && typeof item === "object" && !Array.isArray(item) ? item as Item : null;
  const ref = record && typeof record.ref === "string" && record.ref ? record.ref : String(index);
  const kind = record?.kind;
  if (!record || typeof kind !== "string" || !Object.hasOwn(ROUTES, kind)) {
    return fail(ref, "invalid", `"kind" must be one of ${KIND_LIST}`);
  }
  const route = ROUTES[kind];
  const { kind: _kind, ref: _ref, ...fields } = record;
  let sub: Request;
  if (kind === "delete") {
    if (typeof record.id !== "string" || !ARTIFACT_ID.test(record.id)) return fail(ref, "invalid", '"id" is required');
    sub = subRequest(request, route.method, `${route.path}/${record.id}`);
  } else {
    if ((kind === "message" || kind === "status") && (record.html !== undefined || record.markdown !== undefined)) {
      return fail(ref, "invalid", `a ${kind} item takes no html or markdown`);
    }
    // The kind decides the type: a message item cannot be promoted to a document by its fields.
    sub = subRequest(request, route.method, route.path, kind === "message" || kind === "status" || kind === "document"
      ? { ...fields, type: kind } : fields);
  }
  let response: Response;
  try { response = await dispatch(sub); }
  catch (error) {
    console.error("batch item failed", error instanceof Error ? error.name : "error");
    return fail(ref, "internal", "item failed");
  }
  let data: any = null;
  try { data = await response.json(); } catch { /* an answer without a body */ }
  if (response.status >= 200 && response.status < 300) {
    const payload = data?.data ?? {};
    const id = kind === "comment" ? payload.comment?.id : kind === "delete" ? record.id : payload.id;
    return {
      ref, ok: true, ...(typeof id === "string" ? { id } : {}),
      ...(kind === "artifact" && typeof payload.version === "number" ? { version: payload.version } : {}),
      ...(payload.folded === true ? { folded: true } : {}),
    };
  }
  // A server error can carry exception text: the caller gets a fixed message.
  if (response.status >= 500) return fail(ref, "internal", "item failed");
  return fail(ref, codeFor(response.status), typeof data?.error === "string" ? data.error : "request refused");
}

/** A claim that is still pending and older than the abandon window becomes held. Fenced on claim_id. */
async function holdIfStale(env: Env, owner: string, key: string, claimId: string, now: number): Promise<boolean> {
  return await changed(env.DB.prepare(
    "UPDATE batch_receipts SET status = 'held' WHERE owner = ? AND key = ? AND claim_id = ? AND status = 'pending' AND created_ms < ?"
  ).bind(owner, key, claimId, now - BATCH_ABANDON_MS)) > 0;
}

export async function handleBatch(
  request: Request, env: Env, dispatch: BatchDispatch
): Promise<Response> {
  // A session cookie and a Bearer key together could name two accounts: the receipt would belong to
  // one while the item routes write as the other. Refuse before any receipt is claimed.
  if (/(?:^|;\s*)session=/.test(request.headers.get("Cookie") ?? "") && /^Bearer /.test(request.headers.get("Authorization") ?? "")) {
    return reply({ ok: false, error: "ambiguous_credentials" }, 400);
  }
  const caller = await resolveCallerCredential(request, env);
  if (!caller) return unauthorized();
  // Receipts belong to the account whose content the items write. The item routes resolve only the
  // account's own session or API key, so no other credential can write through them.
  const owner = caller.userId;
  if (!allowsCredentialWrite(request)) return reply({ ok: false, error: "forbidden" }, 403);

  const key = request.headers.get("Idempotency-Key")?.trim();
  if (!key || key.length > 128 || /[\x00-\x1f\x7f]/.test(key)) {
    return reply({ ok: false, error: "Idempotency-Key header is required" }, 400);
  }

  const limits = { max_items: BATCH_MAX_ITEMS, max_bytes: BATCH_MAX_BYTES };
  let text: string;
  try { text = await boundedText(request, BATCH_MAX_BYTES); }
  catch (error) {
    const tooLarge = error instanceof BodyTooLargeError;
    return reply({ ok: false, error: tooLarge ? "batch too large" : "invalid body", limits }, tooLarge ? 413 : 400);
  }
  let parsed: { items?: unknown } | null;
  try { parsed = JSON.parse(text); } catch { return reply({ ok: false, error: "invalid JSON body" }, 400); }
  const items = parsed && typeof parsed === "object" ? parsed.items : undefined;
  if (!Array.isArray(items) || items.length === 0) return reply({ ok: false, error: '"items" must be a non-empty array' }, 400);
  if (items.length > BATCH_MAX_ITEMS) return reply({ ok: false, error: "too many items", limits }, 413);

  // Claim before any work. The hash binds the key to this exact body.
  const hash = await sha256Hex(text);
  const claimId = crypto.randomUUID();
  const now = Date.now();
  const claimed = await changed(env.DB.prepare(
    `INSERT INTO batch_receipts (owner, key, request_hash, claim_id, status, created_ms)
     VALUES (?, ?, ?, ?, 'pending', ?) ON CONFLICT DO NOTHING`
  ).bind(owner, key, hash, claimId, now));
  if (!claimed) {
    const row = await env.DB.prepare(
      "SELECT claim_id, status, request_hash, http_status, body, created_ms FROM batch_receipts WHERE owner = ? AND key = ?"
    ).bind(owner, key).first<{ claim_id: string; status: string; request_hash: string; http_status: number | null; body: string | null; created_ms: number }>();
    if (!row) return reply({ ok: false, error: "batch_in_progress" }, 409); // removed between insert and read
    if (row.request_hash !== hash) return reply({ ok: false, error: "idempotency_key_reused" }, 409);
    if (row.status === "done") return reply(row.body ?? "{}", row.http_status ?? 200);
    if (row.status === "pending") {
      if (row.created_ms < now - BATCH_ABANDON_MS && await holdIfStale(env, owner, key, row.claim_id, now)) {
        return reply({ ok: false, error: "batch_abandoned" }, 409);
      }
      const current = await env.DB.prepare("SELECT status FROM batch_receipts WHERE owner = ? AND key = ?")
        .bind(owner, key).first<{ status: string }>();
      if (current?.status === "pending") return reply({ ok: false, error: "batch_in_progress" }, 409);
    }
    return reply({ ok: false, error: "batch_abandoned" }, 409);
  }

  try {
    const results: ItemResult[] = [];
    for (let index = 0; index < items.length; index++) results.push(await runItem(request, dispatch, items[index], index));
    const body = JSON.stringify({ ok: true, results });
    const done = await changed(env.DB.prepare(
      `UPDATE batch_receipts SET status = 'done', http_status = 200, body = ?
       WHERE owner = ? AND key = ? AND claim_id = ? AND status = 'pending'`
    ).bind(body, owner, key, claimId));
    // The claim was held while the items ran (a request that outlived the window): the work may
    // have committed, so the answer stays unreplayable.
    if (!done) return reply({ ok: false, error: "batch_abandoned" }, 409);
    return reply(body);
  } catch (error) {
    console.error("batch failed", error instanceof Error ? error.name : "error");
    // Items may have committed: hold the claim so a retry cannot send them again.
    await env.DB.prepare("UPDATE batch_receipts SET status = 'held' WHERE owner = ? AND key = ? AND claim_id = ? AND status = 'pending'")
      .bind(owner, key, claimId).run().catch(() => {});
    return reply({ ok: false, error: "internal" }, 500);
  }
}

/**
 * Holds claims that never finished and drops answered receipts older than a week. A held receipt stays: it
 * marks a batch whose items may have committed, and dropping it would let its key send them again.
 * Runs in the hourly and daily cleanups.
 */
export async function runBatchSweep(env: Env, now = Date.now()): Promise<{ held: number; deleted: number }> {
  try {
    const held = await changed(env.DB.prepare(
      "UPDATE batch_receipts SET status = 'held' WHERE status = 'pending' AND created_ms < ?"
    ).bind(now - BATCH_ABANDON_MS));
    const deleted = await changed(env.DB.prepare(
      `DELETE FROM batch_receipts WHERE (owner, key) IN
         (SELECT owner, key FROM batch_receipts WHERE status = 'done' AND created_ms < ? LIMIT 500)`
    ).bind(now - BATCH_KEEP_MS));
    return { held, deleted };
  } catch (error) {
    console.error("batch receipt sweep will retry", error instanceof Error ? error.name : "error");
    return { held: 0, deleted: 0 };
  }
}
