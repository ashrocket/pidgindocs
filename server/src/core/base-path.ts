/**
 * URL path prefix ("base path") for one deployment.
 *
 * Teams tenants and self-hosted installs live at the origin root and leave
 * BASE_PATH empty: nothing in this module changes their behavior. A Solo
 * deployment sets BASE_PATH=/<username> and WORKER_URL=https://example.com/<username>
 * (a hosted edition can serve one deployment under a path such as /<name>).
 *
 * How the prefix flows:
 *
 *   browser  --/alice/api/x-->  Worker fetch
 *     stripBasePath()   removes "/alice" so every route below sees "/api/x" and
 *                       route matching needs no change
 *     ...routes run...
 *     prefixBasePath()  adds "/alice" to relative Location headers and to the
 *                       Path of Set-Cookie headers on the way out
 *
 * Links the browser follows are made in exactly two ways, and nowhere else:
 *
 *   server side   appPath(env, "/workspace")   in templates, headers and JSON
 *   browser side  APP_BASE + "/api/x"         in inline scripts; APP_BASE is the one
 *                                              constant defined by clientBase()
 *
 * Two kinds of path are not browser links and must stay unprefixed: a path that
 * route matching compares with, and a `next` value that the server later turns
 * into a Location (the response adapter prefixes it then). Mark both routePath("/x").
 *
 * Never write a literal absolute app path ("/api/", "/workspace", ...) in
 * src/web/**. src/__tests__/base-path-literals.test.ts fails when one appears,
 * unless src/__tests__/base-path-allowlist.json justifies it.
 *
 * Absolute URLs (email, push, queue jobs, OAuth metadata) are made from
 * WORKER_URL, which carries the prefix itself: use appHref() when a path must
 * be resolved against it, because new URL("/x", "https://example.com/alice")
 * silently drops "/alice".
 */

import type { Env } from "./types";

/** The only Env field the path helpers read. Tests pass `{ BASE_PATH: "/alice" }`. */
export type BaseEnv = Pick<Env, "BASE_PATH">;
/** Either the environment or a base already returned by basePath(). */
export type BaseSource = BaseEnv | string;

/** One lowercase path segment, 3 to 31 characters, hyphens only inside. */
const BASE_PATH_PATTERN = /^\/[a-z][a-z0-9-]{1,29}[a-z0-9]$/;

export class BasePathError extends Error {
  constructor(message = "BASE_PATH is invalid: use an empty value or /name (lowercase letters, digits and hyphens, 3 to 31 characters)") {
    super(message);
    this.name = "BasePathError";
  }
}

function normalizeBase(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") throw new BasePathError();
  let value = raw.trim();
  if (value === "") return "";
  if (value.endsWith("/")) value = value.slice(0, -1);
  if (!BASE_PATH_PATTERN.test(value)) throw new BasePathError();
  return value;
}

/**
 * The validated base path: "" (app at the origin root) or "/name".
 * A bad value throws, so a misconfigured deployment fails closed instead of
 * serving pages with broken or foreign links.
 */
export function basePath(env: BaseEnv): string {
  return normalizeBase(env.BASE_PATH);
}

function resolveBase(source: BaseSource): string {
  return typeof source === "string" ? normalizeBase(source) : basePath(source);
}

function checkedPath(path: string): string {
  // "//host" is protocol-relative and "/\host" is read the same way by browsers.
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) {
    throw new RangeError("appPath expects an absolute app path such as /workspace");
  }
  return path;
}

/** An app path as the browser must request it: "/alice" + "/workspace". With no base it returns `path` unchanged. */
export function appPath(source: BaseSource, path: string): string {
  return resolveBase(source) + checkedPath(path);
}

/**
 * A path in the app's own route space: the one that route matching sees after
 * stripBasePath() and the one a `next` value carries until the server turns it into
 * a Location (prefixBasePath() adds the prefix there). It returns its argument. It is
 * NOT a link for the browser: never put it in an href, src, action or fetch().
 */
export function routePath(path: string): string {
  return checkedPath(path);
}

/**
 * An absolute URL for an app path, resolved against WORKER_URL. Replaces
 * `new URL(path, env.WORKER_URL).href`, which drops the prefix. With no base it
 * returns exactly what that expression returned.
 */
export function appHref(env: BaseEnv & Pick<Env, "WORKER_URL">, path: string, fallbackOrigin = ""): string {
  return new URL(appPath(env, path), env.WORKER_URL || fallbackOrigin).href;
}

/**
 * The deployment root as an absolute URL, without a trailing slash: WORKER_URL
 * as configured when there is no base, otherwise the WORKER_URL origin plus the
 * base (so it is right whether or not WORKER_URL already carries the prefix).
 */
export function appRootUrl(env: BaseEnv & Pick<Env, "WORKER_URL">, fallbackOrigin = ""): string {
  const base = basePath(env);
  const root = env.WORKER_URL || fallbackOrigin;
  return base ? new URL(root).origin + base : root;
}

/** JavaScript that defines the one browser constant, `APP_BASE` ("" or "/alice"). Safe inside an inline script. */
export function clientBase(source: BaseSource): string {
  return `window.APP_BASE=${JSON.stringify(resolveBase(source))};`;
}

/** The <script> element that defines APP_BASE. Put it before the first script that uses the constant. */
export function clientBaseScript(source: BaseSource, nonce?: string): string {
  const attribute = nonce ? ` nonce="${nonce.replace(/[^A-Za-z0-9+/_=-]/g, "")}"` : "";
  return `<script${attribute}>${clientBase(source)}</script>`;
}

/** Each Set-Cookie header on its own. Headers.get("Set-Cookie") joins them with commas, which corrupts Expires. */
function setCookies(headers: Headers): string[] {
  return (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
}

function isAppAbsolute(location: string): boolean {
  return location.startsWith("/") && !location.startsWith("//") && !location.startsWith("/\\");
}

/**
 * Request adapter. Returns the request with the base removed from its path, or
 * a Response when the request must not reach the app:
 *   /alice        -> 308 to /alice/ (query string kept)
 *   /alice/...    -> the request with path /...
 *   anything else -> 404, including /alicex and /
 * With no base the request is returned unchanged.
 */
export function stripBasePath(request: Request, source: BaseSource): Request | Response {
  const base = resolveBase(source);
  if (!base) return request;
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === base) {
    return new Response(null, { status: 308, headers: { Location: `${base}/${url.search}`, "Cache-Control": "private, no-store" } });
  }
  if (!path.startsWith(base + "/")) {
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store" } });
  }
  url.pathname = path.slice(base.length);
  return new Request(url.toString(), request);
}

/**
 * Adds the base to a Set-Cookie header's Path attribute. Every other attribute
 * (SameSite, Max-Age, ...) is kept as written. Path=/ becomes Path=/alice/ and
 * Path=/auth/google becomes Path=/alice/auth/google, so scoped login cookies
 * still come back to the prefixed callback. A cookie without Path is unchanged.
 */
export function prefixCookiePath(cookie: string, source: BaseSource): string {
  const base = resolveBase(source);
  if (!base) return cookie;
  const parts = cookie.split(";");
  for (let i = 1; i < parts.length; i++) {
    const match = /^(\s*path\s*=\s*)(.*?)(\s*)$/i.exec(parts[i]);
    if (match && isAppAbsolute(match[2])) parts[i] = match[1] + base + match[2] + match[3];
  }
  return parts.join(";");
}

/**
 * Response adapter. Adds the base to a Location header that starts with a single
 * "/" and to the Path of each Set-Cookie. Absolute URLs, other headers, the body
 * and WebSocket upgrades (101) pass through. With no base the response is
 * returned unchanged. A redirect from stripBasePath() must not go through this.
 */
export function prefixBasePath(response: Response, source: BaseSource): Response {
  const base = resolveBase(source);
  if (!base || response.status === 101) return response;
  const location = response.headers.get("Location");
  const cookies = setCookies(response.headers);
  const newLocation = location !== null && isAppAbsolute(location) ? base + location : null;
  const newCookies = cookies.map((cookie) => prefixCookiePath(cookie, base));
  if (newLocation === null && newCookies.every((cookie, index) => cookie === cookies[index])) return response;
  const headers = new Headers(response.headers);
  if (newLocation !== null) headers.set("Location", newLocation);
  if (cookies.length) {
    headers.delete("Set-Cookie");
    for (const cookie of newCookies) headers.append("Set-Cookie", cookie);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
