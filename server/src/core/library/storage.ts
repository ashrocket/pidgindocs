import type { Env } from "../types";
import { recordEditionStorage } from "../edition-hooks";

/** Reserve before writing. A failed put releases its reservation; a committed
 * object remains counted even if the later index-row update fails. */
export async function writeIndexObject(env: Env, userId: string, key: string, body: string | null): Promise<void> {
  const previous = await env.DOCS.head(key);
  const bytes = body === null ? 0 : new TextEncoder().encode(body).byteLength;
  const delta = bytes - (previous?.size ?? 0);
  const operation = `library-index:${crypto.randomUUID()}`;
  const reserved = delta > 0 && await recordEditionStorage(env, userId, delta, operation);
  try {
    if (body === null) await env.DOCS.delete(key);
    else await env.DOCS.put(key, body, { httpMetadata: { contentType: "application/json" } });
  } catch (error) {
    if (reserved) await recordEditionStorage(env, userId, -delta, `${operation}:rollback`);
    throw error;
  }
  if (delta < 0) await recordEditionStorage(env, userId, delta, operation);
}
