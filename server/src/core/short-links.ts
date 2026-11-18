import { editionProjectName, editionResolveShortCode, editionShortCodes } from "./edition-hooks";
import type { Env } from "./types";

/**
 * Short link code form shared by the core and hosting layers: six characters
 * from 0-9A-Za-z, at least one digit, and at least one character outside
 * 0-9a-f. The non-hex requirement keeps codes from being mistaken for item IDs.
 */
export const SHORT_CODE = /^(?=[0-9A-Za-z]*[0-9])(?=[0-9A-Za-z]*[g-zA-Z])[0-9A-Za-z]{6}$/;

/** Returns true when `value` is a well-formed short link code. Codes are case-sensitive. */
export function isShortCode(value: string): boolean {
  return SHORT_CODE.test(value);
}

/** The kinds of item a short link can resolve to. */
export type ShortLinkKind = "document" | "document_version" | "artifact" | "message" | "audio";

/** A resolved short link target: the item kind and its UUID. */
export interface ShortLinkRef {
  kind: ShortLinkKind;
  id: string;
}

export const SHORT_LINK_CODE_HEADER = "X-Short-Link-Code";
export const SHORT_LINK_KIND_HEADER = "X-Short-Link-Kind";

/**
 * The map key for an item in `linkSegments` results. Built by concatenation so the
 * web label extractor does not mistake these lookup keys for interface text.
 */
export const segmentKey = (kind: ShortLinkKind, id: string): string => kind + ":" + id;
const refKey = (ref: ShortLinkRef): string => segmentKey(ref.kind, ref.id);
const logFailure = (): void => console.error(JSON.stringify({ event: "short_link_failed" }));

/** The URL segment for one item: its short code, or its UUID when the edition has none or fails. */
export async function linkSegment(env: Env, ref: ShortLinkRef, mint = true): Promise<string> {
  try {
    return (await editionShortCodes(env, [ref], mint)).get(refKey(ref)) ?? encodeURIComponent(ref.id);
  } catch {
    logFailure();
    return encodeURIComponent(ref.id);
  }
}

/** URL segments for many items, keyed `${kind}:${id}`, with an entry for every ref. Reads codes by default. */
export async function linkSegments(env: Env, refs: readonly ShortLinkRef[], mint = false): Promise<Map<string, string>> {
  let codes = new Map<string, string>();
  try {
    codes = await editionShortCodes(env, refs, mint);
  } catch {
    logFailure();
  }
  const out = new Map<string, string>();
  for (const ref of refs) out.set(refKey(ref), codes.get(refKey(ref)) ?? encodeURIComponent(ref.id));
  return out;
}

/** The path to a project, before the caller adds the base path. */
export async function projectHref(env: Env, projectId: string, mint = true): Promise<string> {
  try {
    const name = await editionProjectName(env, projectId, mint);
    if (name) return `/prj/${name}/`;
  } catch {
    logFailure();
  }
  return `/workspace?project=${encodeURIComponent(projectId)}`;
}

const ITEM_ARG_KEYS = ["id", "doc_id", "artifact_id", "message_id", "resource_id"] as const;

/**
 * A stable, UUID-shaped stand-in for a code that doesn't resolve, so the
 * handler answers as for any unknown ID. HMAC-SHA-256 of `short-link:<code>`
 * under the share secret, formatted as a v4 UUID.
 */
export async function standInUuid(env: Env, code: string): Promise<string> {
  const secret = env.DOC_SHARE_SECRET ?? env.API_KEY;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`short-link:${code}`)));
  const bytes = mac.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const ALL_KINDS: readonly ShortLinkKind[] = ["document", "document_version", "artifact", "message", "audio"];

/**
 * The item UUID a caller-supplied id stands for. A value that isn't code-form comes back
 * unchanged. A code of an allowed kind that the viewer can read gives the item's UUID. Any
 * other code (unknown, unreadable or the wrong kind) gives its stand-in UUID, so the
 * handler answers as for any unknown ID and never learns the real one.
 */
export async function resolveItemId(
  env: Env, value: string, viewerId: string | null, kinds: readonly ShortLinkKind[] = ALL_KINDS,
): Promise<string> {
  if (!isShortCode(value)) return value;
  // The real UUID goes on only when the viewer can read the item; a handler's
  // error text would otherwise hand it to a caller who may not.
  let target: { kind: ShortLinkKind; id: string } | null = null;
  try {
    target = await editionResolveShortCode(env, value, viewerId, { readableBy: viewerId ?? "" });
  } catch {
    logFailure();
  }
  return target && kinds.includes(target.kind) ? target.id : standInUuid(env, value);
}

/**
 * Replaces short codes in the item ID arguments of an MCP tool call with UUIDs.
 * A code that doesn't resolve, or a family code on a delete tool, becomes its stand-in UUID.
 */
export async function resolveItemArgs(
  env: Env, toolName: string, args: Record<string, unknown>, viewerId: string | null,
): Promise<Record<string, unknown>> {
  const kinds = toolName.includes("delete") ? ALL_KINDS.filter((kind) => kind !== "document") : ALL_KINDS;
  let out = args;
  for (const key of ITEM_ARG_KEYS) {
    const value = args[key];
    if (typeof value !== "string" || !isShortCode(value)) continue;
    if (out === args) out = { ...args };
    out[key] = await resolveItemId(env, value, viewerId, kinds);
  }
  return out;
}

/** The segment a handler should use in links: the code that the router saw in the request, else the UUID. */
export function requestLinkSegment(request: Request, id: string): string {
  const code = request.headers.get(SHORT_LINK_CODE_HEADER);
  return code !== null && isShortCode(code) ? code : encodeURIComponent(id);
}
