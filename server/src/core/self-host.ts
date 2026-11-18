// Fills in the two values a self-hosted install keeps in its own database: the public origin and the
// share-link secret. Only core/worker.ts wraps the app with this; an edition's entries never call it,
// so for an edition the SELF_HOST marker is always absent.
import { readInstanceSettings, setInstanceSetting, type InstanceSettingName } from "./instance-settings";
import { pruneRateLimits } from "./ratelimit";
import type { EnhanceJob, Env } from "./types";
import { logEventName } from "./wire-names";

/** Where a self-hosted request's public origin came from. */
export type OriginSource = "configured" | "stored" | "request" | "none";

/** Marks a self-hosted copy of env. Set only by core/worker.ts on a self-hosted install; never a Worker variable. */
export interface SelfHostContext {
  originSource: OriginSource;
}

/** The three handlers a Worker entry exports. */
export interface CoreHandlers {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void>;
  queue(batch: MessageBatch<EnhanceJob>, env: Env, ctx: ExecutionContext): Promise<void>;
}

type StoredValues = Partial<Record<InstanceSettingName, string>>;

function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// A set WORKER_URL wins, then the origin stored by the owner, then the origin of the first request.
function pickOrigin(configured: string | undefined, stored: string | undefined, requestOrigin: string | null): { url: string; source: OriginSource } {
  if (configured) return { url: configured, source: "configured" };
  if (stored) return { url: stored, source: "stored" };
  if (requestOrigin) return { url: requestOrigin, source: "request" };
  // An unset Worker variable is undefined at run time too; the type keeps WORKER_URL a string for the
  // ~48 existing reads.
  return { url: undefined as unknown as string, source: "none" };
}

/**
 * Returns a per-request copy of env with WORKER_URL, DOC_SHARE_SECRET and SELF_HOST filled in. Never
 * writes to env. If instance_settings cannot be read or written, the copy has no stored values and no
 * secret is generated, so requests are still served.
 */
export async function resolveSelfHostEnv(env: Env, requestOrigin: string | null, now = Date.now()): Promise<Env> {
  let stored: StoredValues = {};
  let secret = env.DOC_SHARE_SECRET || env.API_KEY;
  try {
    stored = await readInstanceSettings(env.DB, now);
    // A concurrent first request may generate its own value; "keep" makes both read back the stored one.
    secret = env.DOC_SHARE_SECRET || stored.share_secret || env.API_KEY
      || await setInstanceSetting(env.DB, "share_secret", generateSecret(), "keep");
  } catch {
    console.error(JSON.stringify({ event: logEventName("instance_settings_unavailable") }));
    stored = {};
    secret = env.DOC_SHARE_SECRET || env.API_KEY;
  }
  const origin = pickOrigin(env.WORKER_URL || undefined, stored.origin, requestOrigin);
  return { ...env, WORKER_URL: origin.url, DOC_SHARE_SECRET: secret, SELF_HOST: { originSource: origin.source } };
}

/** Wraps the app so each invocation runs with a self-host copy of env. fetch uses the request's origin; scheduled and queue have none. */
export function selfHostEntry(app: CoreHandlers): CoreHandlers {
  return {
    async fetch(request, env, ctx) {
      return app.fetch(request, await resolveSelfHostEnv(env, new URL(request.url).origin), ctx);
    },
    async scheduled(controller, env, ctx) {
      try {
        await pruneRateLimits(env.DB, Math.floor(Date.now() / 1000));
      } catch {
        console.error(JSON.stringify({ event: logEventName("rate_limit_prune_failed") }));
      }
      return app.scheduled(controller, await resolveSelfHostEnv(env, null), ctx);
    },
    async queue(batch, env, ctx) {
      return app.queue(batch, await resolveSelfHostEnv(env, null), ctx);
    },
  };
}
