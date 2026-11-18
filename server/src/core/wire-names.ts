// Helpers that build wire names from the edition's settings (edition-hooks.ts, WireFormat).
// Everything here reads the hook at each call, so a later install takes effect.
import { editionProductIdentity, editionProductName, editionWireFormat } from "./edition-hooks";

// Each token and code that core issues starts with the edition's token prefix and a short kind.
// One function per kind keeps the kind marks here, out of the route files that the web label
// extractor reads.

/** The start of an OAuth authorization code, for example `pidgin_c_`. */
export const authCodeStart = (): string => `${editionWireFormat().tokenPrefix}c_`;
/** The start of an OAuth access token, for example `pidgin_at_`. */
export const accessTokenStart = (): string => `${editionWireFormat().tokenPrefix}at_`;
/** The start of an OAuth refresh token, for example `pidgin_r_`. */
export const refreshTokenStart = (): string => `${editionWireFormat().tokenPrefix}r_`;
/** The start of a device login code, for example `pidgin_dc_`. */
export const deviceCodeStart = (): string => `${editionWireFormat().tokenPrefix}dc_`;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches a device code: the edition's device prefix, then two UUIDs. */
export const deviceCodePattern = (): RegExp => new RegExp(`^${escapeRegExp(deviceCodeStart())}[a-f0-9-]{72}$`);

/** Core names every MCP tool with this prefix; clients see the edition's prefix instead when it differs. */
const SOURCE_TOOL_PREFIX = "pidgin_";

/** The name clients see for a tool that core names `pidgin_*`. */
export function clientToolName(sourceName: string): string {
  const prefix = editionWireFormat().mcpToolPrefix;
  return prefix !== SOURCE_TOOL_PREFIX && sourceName.startsWith(SOURCE_TOOL_PREFIX) ? prefix + sourceName.slice(SOURCE_TOOL_PREFIX.length) : sourceName;
}

/** The core name of a tool that a client called by its edition name; a core `pidgin_*` name passes through. */
export function sourceToolName(clientName: string): string {
  const prefix = editionWireFormat().mcpToolPrefix;
  return prefix !== SOURCE_TOOL_PREFIX && clientName.startsWith(prefix) ? SOURCE_TOOL_PREFIX + clientName.slice(prefix.length) : clientName;
}

/** The mark in fixed text where the edition's product name goes. It is a constant, never a name. */
export const PRODUCT_PLACEHOLDER = "__PRODUCT__";

/** Fixed text in which every `__PRODUCT__` mark shows the edition's product name (and `__HOUSE_COLORS__` and `__SLUG__` show the edition's house colors and slug), read at each call. Never use it on text that holds a person's input. */
export function productText(sourceText: string): string {
  if (!sourceText.includes("__")) return sourceText;
  return sourceText.split(PRODUCT_PLACEHOLDER).join(editionProductName())
    .split("__HOUSE_COLORS__").join(editionProductIdentity().houseColors)
    .split("__SLUG__").join(editionWireFormat().slug);
}

/** Fixed text (a tool description or an instruction) in which every `pidgin_*` tool name shows the edition prefix and every `__PRODUCT__` mark shows the product name. Never use it on text that holds a person's input. */
export function clientToolText(sourceText: string): string {
  const prefix = editionWireFormat().mcpToolPrefix;
  return productText(prefix === SOURCE_TOOL_PREFIX ? sourceText : sourceText.split(SOURCE_TOOL_PREFIX).join(prefix));
}

/** A tool's input schema with the product name in every `description` text. Other texts in the schema stay as they are. */
export function productSchemaText<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map(productSchemaText) as T;
  if (schema === null || typeof schema !== "object") return schema;
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, key === "description" && typeof value === "string" ? productText(value) : productSchemaText(value)])) as T;
}

const capitalize = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** The lowercase word the edition builds its stored and logged names from. */
export const editionSlug = (): string => editionWireFormat().slug;
/** The parts of the internal headers. Named constants keep them out of the web label extractor, which reads string literals in route files. */
export const HeaderPart = { Stream: "Stream", Viewer: "Viewer", Filter: "Filter", After: "After", TimeoutMs: "Timeout-Ms", Limit: "Limit", ExpiresAt: "Expires-At" } as const;
export type InternalHeaderPart = typeof HeaderPart[keyof typeof HeaderPart];
/** An internal request header between the Worker and its Durable Object, for example `X-Pidgin-Stream`. */
export const internalHeader = (name: InternalHeaderPart): string => `X-${capitalize(editionSlug())}-${name}`;
/** A log event name, for example `pidgin.event_dispatch_paused`. */
export const logEventName = (name: string): string => `${editionSlug()}.${name}`;
/** The HTML attribute that marks authored prose for the content translation API, for example `data-pidgin-content`. */
export const contentAttribute = (): string => `data-${editionSlug()}-content`;
/** The session id of a person's post made from the web workspace, for example `pidgin-user-<id>`. */
export const workspaceUserSessionId = (userId: string): string => `${editionSlug()}-user-${userId}`;
/** The DOM id of the document version banner, for example `pidgin-version-banner`. */
export const versionBannerId = (): string => `${editionSlug()}-version-banner`;
