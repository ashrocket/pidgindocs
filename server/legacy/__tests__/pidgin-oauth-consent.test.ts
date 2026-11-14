import { env as bindings } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import type { Env } from "../types";

// The OAuth consent step (/oauth/authorize, /oauth/consent), through the real
// router, against migrated D1.

const ORIGIN = "https://pidgindocs.example.workers.dev";
const env = {
  ...bindings,
  API_KEY: "consent-test-key",
  OWNER_EMAIL: "owner@example.com",
  WORKER_URL: ORIGIN,
  ENVIRONMENT: "production",
  APNS_TEAM_ID: "TEAMID0000",
  // Never a real mail key. No test here sends mail.
  RESEND_API_KEY: "re_test_only",
} as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
// No test here calls an external host. A call that does fails the test.
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    throw new Error(`unexpected fetch: ${input instanceof Request ? input.url : String(input)}`);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const REDIRECT = "http://127.0.0.1:53111/callback";
const OTHER_REDIRECT = "http://127.0.0.1:53112/callback";

async function send(path: string, init: RequestInit = {}) {
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx);
}

async function makeUser(label: string) {
  const id = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const email = `${id}@example.com`;
  await env.DB.prepare("INSERT INTO users (id, email, status) VALUES (?, ?, 'active')").bind(id, email).run();
  const newSession = async () => {
    const token = `tok-${crypto.randomUUID()}`;
    await env.SESSIONS.put(`session:${token}`, email, { expirationTtl: 600 });
    return token;
  };
  const browserToken = await newSession();
  const appToken = await newSession();
  return {
    id,
    email,
    newSession,
    cookie: { Cookie: `session=${browserToken}` } as Record<string, string>,
    // The PidginDocs app sends its session in a header and no cookie.
    app: { Authorization: `Session ${appToken}` } as Record<string, string>,
  };
}

async function registerClient(name: string, redirectUris = [REDIRECT, OTHER_REDIRECT]) {
  const res = await send("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.7" },
    body: JSON.stringify({ client_name: name, redirect_uris: redirectUris, token_endpoint_auth_method: "none" }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

async function pkce() {
  const verifier = "v".repeat(20) + crypto.randomUUID();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { verifier, challenge };
}

function authorizePath(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  return `/oauth/authorize?${new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: REDIRECT, scope: "mcp offline_access",
    state: "st-1", code_challenge: challenge, code_challenge_method: "S256", ...extra,
  })}`;
}

function requestIdFrom(html: string): string {
  const match = html.match(/name="request_id" value="([^"]+)"/);
  expect(match, "the page has a request id").toBeTruthy();
  return match![1];
}

function decide(requestId: string, decision: string, headers: Record<string, string> = {}) {
  return send("/oauth/consent", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ request_id: requestId, decision }).toString(),
  });
}

async function exchange(clientId: string, code: string, verifier: string, redirectUri = REDIRECT) {
  return send("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }).toString(),
  });
}

// The consent page in a signed-in browser. Returns its request id.
async function consentPageId(u: Awaited<ReturnType<typeof makeUser>>, path: string) {
  const res = await send(path, { headers: { ...u.cookie, "Sec-Fetch-Dest": "document" } });
  expect(res.status).toBe(200);
  return requestIdFrom(await res.text());
}

describe("OAuth consent: a browser session", () => {
  it("shows a consent page instead of a code, and issues the code only on Allow", async () => {
    const u = await makeUser("consent-allow");
    const clientId = await registerClient('Claude <b>"Code"</b>');
    const { verifier, challenge } = await pkce();

    const page = await send(authorizePath(clientId, challenge), { headers: { ...u.cookie, "Sec-Fetch-Dest": "document" } });
    expect(page.status).toBe(200);
    expect(page.headers.get("Location")).toBeNull();
    expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("X-Frame-Options")).toBe("DENY");
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    // A page that opened this one keeps no window handle to it.
    expect(page.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin-allow-popups");
    const html = await page.text();
    // The client name (escaped), the redirect host, the scopes and the account.
    expect(html).toContain("Claude &lt;b&gt;&quot;Code&quot;&lt;/b&gt;");
    expect(html).not.toContain("<b>\"Code\"</b>");
    expect(html).toContain("a program on this computer (127.0.0.1:53111)");
    expect(html).toContain("agent tools");
    expect(html).toContain("refresh token");
    expect(html).toContain(u.email);
    expect(html).toContain('action="/oauth/consent"');

    const allow = await decide(requestIdFrom(html), "allow", { ...u.cookie, "Sec-Fetch-Site": "same-origin" });
    expect(allow.status).toBe(302);
    const location = new URL(allow.headers.get("Location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get("state")).toBe("st-1");
    const code = location.searchParams.get("code") ?? "";
    expect(code).toBeTruthy();

    const tokens = await exchange(clientId, code, verifier);
    expect(tokens.status).toBe(200);
    expect(((await tokens.json()) as { access_token?: string }).access_token).toBeTruthy();
  });

  it("redirects with error=access_denied and the state on Deny, and issues no code", async () => {
    const u = await makeUser("consent-deny");
    const clientId = await registerClient("Some client");
    const { challenge } = await pkce();
    const id = await consentPageId(u, authorizePath(clientId, challenge));

    const deny = await decide(id, "deny", u.cookie);
    expect(deny.status).toBe(302);
    const location = new URL(deny.headers.get("Location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("st-1");
    expect(location.searchParams.get("code")).toBeNull();

    // A Deny is not remembered: the next request asks again.
    const again = await send(authorizePath(clientId, challenge), { headers: u.cookie });
    expect(again.status).toBe(200);
  });

  it("remembers Allow per client and redirect URI, and asks again for a new redirect URI or scope", async () => {
    const u = await makeUser("consent-remember");
    const clientId = await registerClient("Remembered client");
    const { verifier, challenge } = await pkce();
    const id = await consentPageId(u, authorizePath(clientId, challenge));
    expect((await decide(id, "allow", u.cookie)).status).toBe(302);

    // The same client and redirect URI: a code with no page, in a new session too.
    const other = await u.newSession();
    const repeat = await send(authorizePath(clientId, challenge, { state: "st-2" }), { headers: { Cookie: `session=${other}` } });
    expect(repeat.status).toBe(302);
    const location = new URL(repeat.headers.get("Location") ?? "");
    expect(location.searchParams.get("state")).toBe("st-2");
    expect((await exchange(clientId, location.searchParams.get("code") ?? "", verifier)).status).toBe(200);
    // A request for fewer scopes is covered too.
    expect((await send(authorizePath(clientId, challenge, { scope: "mcp" }), { headers: u.cookie })).status).toBe(302);

    // Another registered redirect URI, a scope not allowed yet, another
    // client or another user: ask again.
    expect((await send(authorizePath(clientId, challenge, { redirect_uri: OTHER_REDIRECT }), { headers: u.cookie })).status).toBe(200);
    expect((await send(authorizePath(clientId, challenge, { scope: "mcp offline_access admin" }), { headers: u.cookie })).status).toBe(200);
    const otherClient = await registerClient("Remembered client");
    expect((await send(authorizePath(otherClient, challenge), { headers: u.cookie })).status).toBe(200);
    const v = await makeUser("consent-remember-other");
    expect((await send(authorizePath(clientId, challenge), { headers: v.cookie })).status).toBe(200);
  });
});

describe("OAuth consent: the request id stops forged decisions", () => {
  it("refuses a decision without the id, with an unknown id, or with a used id", async () => {
    const u = await makeUser("consent-nonce");
    const clientId = await registerClient("Nonce client");
    const { challenge } = await pkce();

    for (const res of [await decide("", "allow", u.cookie), await decide(crypto.randomUUID(), "allow", u.cookie)]) {
      expect(res.status).toBe(400);
      expect(res.headers.get("Location")).toBeNull();
    }

    const id = await consentPageId(u, authorizePath(clientId, challenge));
    expect((await decide(id, "allow", u.cookie)).status).toBe(302);
    const replay = await decide(id, "allow", u.cookie);
    expect(replay.status).toBe(400);
    expect(replay.headers.get("Location")).toBeNull();
  });

  it("accepts the decision only from the session that showed the page", async () => {
    const u = await makeUser("consent-bound");
    const attacker = await makeUser("consent-attacker");
    const clientId = await registerClient("Bound client");
    const { challenge } = await pkce();

    // Another user's session, another session of the same user, and no session.
    for (const headers of [attacker.cookie, { Cookie: `session=${await u.newSession()}` }, {}]) {
      const id = await consentPageId(u, authorizePath(clientId, challenge));
      const forged = await decide(id, "allow", headers);
      expect(forged.status).toBe(403);
      expect(forged.headers.get("Location")).toBeNull();
      // The forged try used the id up.
      expect((await decide(id, "allow", u.cookie)).status).toBe(400);
    }

    // A browser session's request does not open as an app request page.
    const id = await consentPageId(u, authorizePath(clientId, challenge));
    expect((await send(`/oauth/consent?request_id=${id}`)).status).toBe(400);
  });

  it("issues the code for the parameters that the page showed, not for form fields", async () => {
    const u = await makeUser("consent-params");
    const clientId = await registerClient("Params client");
    const { challenge } = await pkce();
    const id = await consentPageId(u, authorizePath(clientId, challenge));

    const res = await send("/oauth/consent", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...u.cookie },
      body: new URLSearchParams({
        request_id: id, decision: "allow", redirect_uri: OTHER_REDIRECT, state: "forged", scope: "admin",
      }).toString(),
    });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get("state")).toBe("st-1");
    // The remembered scope is the one on the page.
    expect((await send(authorizePath(clientId, challenge, { scope: "admin" }), { headers: u.cookie })).status).toBe(200);
  });

  it("refuses a cross-site post and a page load that script can read", async () => {
    const u = await makeUser("consent-fetch");
    const clientId = await registerClient("Fetch client");
    const { challenge } = await pkce();

    const id = await consentPageId(u, authorizePath(clientId, challenge));
    const crossSite = await decide(id, "allow", { ...u.cookie, "Sec-Fetch-Site": "cross-site" });
    expect(crossSite.status).toBe(403);
    expect(crossSite.headers.get("Location")).toBeNull();

    // fetch() (dest "empty") and a frame get no page and no request id.
    for (const dest of ["empty", "iframe"]) {
      const res = await send(authorizePath(clientId, challenge), { headers: { ...u.cookie, "Sec-Fetch-Dest": dest } });
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain("request_id");
    }
  });

  it("refuses the decision when the user is no longer active", async () => {
    const u = await makeUser("consent-suspended");
    const clientId = await registerClient("Suspended client");
    const { challenge } = await pkce();
    const id = await consentPageId(u, authorizePath(clientId, challenge));
    await env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").bind(u.id).run();
    const res = await decide(id, "allow", u.cookie);
    expect(res.status).toBe(403);
    expect(res.headers.get("Location")).toBeNull();
  });
});

describe("OAuth consent: the PidginDocs app's handoff", () => {
  it("gets a 302 to a browser consent page, then a 302 with the code once allowed", async () => {
    const u = await makeUser("consent-app");
    const clientId = await registerClient("Codex");
    const { verifier, challenge } = await pkce();

    // The app accepts only a 302. The Location is absolute (the app opens it
    // with the system) and is not an /oauth/authorize universal link path.
    const handoff = await send(authorizePath(clientId, challenge), { headers: u.app });
    expect(handoff.status).toBe(302);
    const consentUrl = new URL(handoff.headers.get("Location") ?? "");
    expect(consentUrl.origin).toBe(ORIGIN);
    expect(consentUrl.pathname).toBe("/oauth/consent");
    // No universal link path of the app matches it, so the system opens it
    // in the browser and not in the app again.
    const aasa = (await (await send("/.well-known/apple-app-site-association")).json()) as {
      applinks: { details: Array<{ paths: string[] }> };
    };
    const linkPaths = aasa.applinks.details.flatMap((d) => d.paths);
    const isAppLink = (path: string) => linkPaths.some((pattern) =>
      new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(path));
    expect(isAppLink("/oauth/authorize")).toBe(true);
    expect(isAppLink(consentUrl.pathname)).toBe(false);

    // The browser that opens it has no PidginDocs session.
    const page = await send(`${consentUrl.pathname}${consentUrl.search}`, { headers: { "Sec-Fetch-Dest": "document" } });
    expect(page.status).toBe(200);
    expect(page.headers.get("X-Frame-Options")).toBe("DENY");
    const html = await page.text();
    expect(html).toContain("Codex");
    expect(html).toContain(u.email);
    const id = requestIdFrom(html);
    expect(id).toBe(consentUrl.searchParams.get("request_id"));

    const allow = await decide(id, "allow", { "Sec-Fetch-Site": "same-origin" });
    expect(allow.status).toBe(302);
    const location = new URL(allow.headers.get("Location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get("state")).toBe("st-1");
    expect((await exchange(clientId, location.searchParams.get("code") ?? "", verifier)).status).toBe(200);

    // Now the app gets the code at once, as before this change.
    const repeat = await send(authorizePath(clientId, challenge, { state: "st-2" }), { headers: u.app });
    expect(repeat.status).toBe(302);
    const direct = new URL(repeat.headers.get("Location") ?? "");
    expect(`${direct.origin}${direct.pathname}`).toBe(REDIRECT);
    expect(direct.searchParams.get("code")).toBeTruthy();
  });

  it("redirects with access_denied when the user denies the app's request", async () => {
    const u = await makeUser("consent-app-deny");
    const clientId = await registerClient("Unknown client");
    const { challenge } = await pkce();
    const handoff = await send(authorizePath(clientId, challenge), { headers: u.app });
    const consentUrl = new URL(handoff.headers.get("Location") ?? "");
    const deny = await decide(consentUrl.searchParams.get("request_id") ?? "", "deny");
    expect(deny.status).toBe(302);
    const location = new URL(deny.headers.get("Location") ?? "");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("code")).toBeNull();
    // A guessed or used id shows the expired page.
    expect((await send(`/oauth/consent?request_id=${consentUrl.searchParams.get("request_id")}`)).status).toBe(400);
    expect((await send(`/oauth/consent?request_id=${crypto.randomUUID()}`)).status).toBe(400);
  });
});

describe("OAuth consent: redirect URIs and background posts", () => {
  it("registers only redirect URIs that reach a client", async () => {
    const register = (redirectUris: unknown) => send("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.8" },
      body: JSON.stringify({ client_name: "Redirects", redirect_uris: redirectUris }),
    });
    // Claude Code (loopback), claude.ai (https) and a native app scheme.
    for (const uri of ["http://localhost:33418/callback", "https://claude.ai/api/mcp/auth_callback", "cursor://anysphere.cursor-retrieval/oauth/callback"]) {
      expect((await register([uri])).status, uri).toBe(201);
    }
    for (const uri of [
      "javascript:alert(document.domain)//", "JAVASCRIPT:alert(1)", "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)", "file:///etc/passwd", "https://example.com/cb#frag", "/relative/callback", "not a uri", 42,
    ]) {
      const res = await register([REDIRECT, uri]);
      expect(res.status, String(uri)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_redirect_uri");
    }
  });

  it("refuses an unsafe redirect URI of a client that registered before the check", async () => {
    const u = await makeUser("consent-old-client");
    const clientId = `cp_${crypto.randomUUID()}`;
    const unsafe = "javascript:alert(1)";
    await env.SESSIONS.put(`oauth:client:${clientId}`, JSON.stringify({
      client_id: clientId, client_name: "Old", redirect_uris: [unsafe], grant_types: ["authorization_code"],
      response_types: ["code"], token_endpoint_auth_method: "none", scope: "mcp", created_at: 0,
    }));
    const { challenge } = await pkce();
    for (const headers of [u.cookie, u.app]) {
      const res = await send(authorizePath(clientId, challenge, { redirect_uri: unsafe }), { headers: { ...headers, "Sec-Fetch-Dest": "document" } });
      expect(res.status).toBe(400);
      expect(res.headers.get("Location")).toBeNull();
    }
  });

  it("refuses a decision that script sends with fetch()", async () => {
    const u = await makeUser("consent-fetch-post");
    const clientId = await registerClient("Fetch post client");
    const { challenge } = await pkce();
    const id = await consentPageId(u, authorizePath(clientId, challenge));
    const res = await decide(id, "allow", { ...u.cookie, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" });
    expect(res.status).toBe(403);
    expect(res.headers.get("Location")).toBeNull();
    // A form submit (a navigation) still works for a new request.
    const next = await consentPageId(u, authorizePath(clientId, challenge));
    const ok = await decide(next, "allow", { ...u.cookie, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate" });
    expect(ok.status).toBe(302);
  });

  it("arms the buttons after a short delay", async () => {
    const u = await makeUser("consent-arm");
    const clientId = await registerClient("Arm client");
    const { challenge } = await pkce();
    const page = await send(authorizePath(clientId, challenge), { headers: { ...u.cookie, "Sec-Fetch-Dest": "document" } });
    const html = await page.text();
    expect(html).toMatch(/\.actions\{[^}]*animation:arm/);
    expect(html).toContain("@keyframes arm{from{pointer-events:none}}");
  });
});
