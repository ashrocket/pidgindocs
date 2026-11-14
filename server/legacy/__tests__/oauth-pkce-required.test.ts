import { env as bindings } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import type { Env } from "../types";

// PKCE with S256 is required at /oauth/authorize and /oauth/token, through the
// real router, against migrated D1.

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


async function consentPageId(u: Awaited<ReturnType<typeof makeUser>>, path: string) {
  const res = await send(path, { headers: { ...u.cookie, "Sec-Fetch-Dest": "document" } });
  expect(res.status).toBe(200);
  return requestIdFrom(await res.text());
}

async function storedCount() {
  let n = 0;
  for (const prefix of ["oauth:consent-request:", "oauth:code:", "oauth:consent:"]) {
    n += (await env.SESSIONS.list({ prefix })).keys.length;
  }
  return n;
}

async function stripChallenge(code: string) {
  const key = `oauth:code:${code}`;
  const raw = await env.SESSIONS.get(key);
  if (!raw) return false;
  const record = JSON.parse(raw) as Record<string, unknown>;
  delete record.code_challenge;
  delete record.code_challenge_method;
  await env.SESSIONS.put(key, JSON.stringify(record), { expirationTtl: 600 });
  return true;
}

const B64URL43 = /^[A-Za-z0-9_-]{43}$/;

async function tokenForm(fields: Record<string, string>) {
  return send("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

function withoutParam(path: string, name: string) {
  const u = new URL(`${ORIGIN}${path}`);
  u.searchParams.delete(name);
  return `${u.pathname}${u.search}`;
}

async function expectRefused(res: Response, description?: RegExp) {
  expect(res.status).toBe(400);
  expect(res.headers.get("Location")).toBeNull();
  const body = (await res.json()) as { error?: string; error_description?: string; code?: string };
  expect(body.error).toBe("invalid_request");
  if (description) expect(body.error_description).toMatch(description);
  expect(JSON.stringify(body)).not.toContain("request_id");
}

describe("OAuth PKCE is required at authorize", () => {
  it("refuses a request with no code_challenge, shows no consent page and stores nothing", async () => {
    const u = await makeUser("pkce-none");
    const clientId = await registerClient("No challenge client");
    const before = await storedCount();
    const { challenge } = await pkce();
    const path = withoutParam(withoutParam(authorizePath(clientId, challenge), "code_challenge"), "code_challenge_method");
    for (const headers of [{ ...u.cookie, "Sec-Fetch-Dest": "document" }, u.app]) {
      const res = await send(path, { headers });
      await expectRefused(res, /code_challenge is required/);
      expect(res.headers.get("Content-Type") ?? "").not.toContain("text/html");
    }
    // Method alone, with no challenge, is refused too.
    await expectRefused(await send(withoutParam(authorizePath(clientId, challenge), "code_challenge"), { headers: u.cookie }), /code_challenge is required/);
    // An empty challenge counts as missing.
    await expectRefused(await send(authorizePath(clientId, "", {}), { headers: u.cookie }), /code_challenge is required/);
    // Nothing was stored: no consent request or code exists.
    expect(await storedCount()).toBe(before);
    // A decision with a made-up id has nothing to act on.
    const post = await decide("does-not-exist", "allow", { ...u.cookie, "Sec-Fetch-Site": "same-origin" });
    expect(post.status).toBeGreaterThanOrEqual(400);
    expect(post.headers.get("Location")).toBeNull();
  });

  it("refuses a challenge with no code_challenge_method", async () => {
    const u = await makeUser("pkce-nomethod");
    const clientId = await registerClient("No method client");
    const { challenge } = await pkce();
    const path = withoutParam(authorizePath(clientId, challenge), "code_challenge_method");
    await expectRefused(await send(path, { headers: u.cookie }), /code_challenge_method/);
    await expectRefused(await send(path, { headers: u.app }), /code_challenge_method/);
  });

  it("refuses code_challenge_method plain", async () => {
    const u = await makeUser("pkce-plain");
    const clientId = await registerClient("Plain client");
    const { challenge } = await pkce();
    for (const method of ["plain", "s256", "S512"]) {
      await expectRefused(await send(authorizePath(clientId, challenge, { code_challenge_method: method }), { headers: u.cookie }), /code_challenge_method/);
    }
  });

  it("refuses a challenge that is not 43 base64url characters", async () => {
    const u = await makeUser("pkce-shape");
    const clientId = await registerClient("Shape client");
    const { challenge } = await pkce();
    expect(challenge).toMatch(B64URL43);
    const bad = [
      challenge.slice(0, 42),
      `${challenge}A`,
      `+${challenge.slice(1)}`,
      `${challenge.slice(0, 42)}=`,
      `${challenge.slice(0, 20)}/${challenge.slice(21)}`,
    ];
    for (const value of bad) {
      await expectRefused(await send(authorizePath(clientId, value), { headers: u.cookie }), /code_challenge/);
    }
    // The 43-character form still gets the consent page.
    expect((await send(authorizePath(clientId, challenge), { headers: { ...u.cookie, "Sec-Fetch-Dest": "document" } })).status).toBe(200);
  });

  it("does not let a remembered Allow bypass the rule", async () => {
    const u = await makeUser("pkce-remembered");
    const clientId = await registerClient("Remembered PKCE client");
    const { challenge } = await pkce();
    const id = await consentPageId(u, authorizePath(clientId, challenge));
    expect((await decide(id, "allow", u.cookie)).status).toBe(302);
    // With a challenge the remembered Allow gives a code.
    expect((await send(authorizePath(clientId, challenge, { state: "st-2" }), { headers: u.cookie })).status).toBe(302);
    // Without one it is refused, not answered with a code.
    const bare = withoutParam(withoutParam(authorizePath(clientId, challenge), "code_challenge"), "code_challenge_method");
    const res = await send(bare, { headers: u.cookie });
    await expectRefused(res, /code_challenge is required/);
    await expectRefused(await send(bare, { headers: u.app }), /code_challenge is required/);
  });
});

describe("OAuth PKCE is required at the token endpoint", () => {
  async function codeFor(u: Awaited<ReturnType<typeof makeUser>>, clientId: string, challenge: string, state: string, firstTime = false) {
    if (firstTime) {
      const id = await consentPageId(u, authorizePath(clientId, challenge, { state }));
      expect((await decide(id, "allow", u.cookie)).status).toBe(302);
    }
    const res = await send(authorizePath(clientId, challenge, { state }), { headers: u.cookie });
    expect(res.status).toBe(302);
    return new URL(res.headers.get("Location") ?? "").searchParams.get("code") ?? "";
  }
  const form = (clientId: string, code: string, extra: Record<string, string> = {}) =>
    tokenForm({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, ...extra });

  it("refuses no verifier and a wrong verifier, and accepts the right one", async () => {
    const u = await makeUser("pkce-token");
    const clientId = await registerClient("Token client");
    const { verifier, challenge } = await pkce();
    await codeFor(u, clientId, challenge, "st-0", true);

    const none = await form(clientId, await codeFor(u, clientId, challenge, "st-a"));
    expect(none.status).toBe(400);
    expect(((await none.json()) as { error?: string }).error).toBe("invalid_grant");

    const wrong = await form(clientId, await codeFor(u, clientId, challenge, "st-b"), { code_verifier: `wrong-${verifier}` });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error?: string }).error).toBe("invalid_grant");

    const right = await form(clientId, await codeFor(u, clientId, challenge, "st-c"), { code_verifier: verifier });
    expect(right.status).toBe(200);
    expect(((await right.json()) as { access_token?: string }).access_token).toBeTruthy();
  });

  it("refuses a stored code that has no challenge", async () => {
    const clientId = await registerClient("Old code client");
    const { verifier } = await pkce();
    const u = await makeUser("pkce-old");
    const { challenge } = await pkce();
    await codeFor(u, clientId, challenge, "st-0", true);
    const issued = await codeFor(u, clientId, challenge, "st-1");
    // A code that an earlier version issued carries no challenge.
    // Strip the challenge from the stored record, where it lives in KV or D1.
    const stripped = await stripChallenge(issued);
    expect(stripped, "found the stored code").toBe(true);
    const res = await form(clientId, issued, { code_verifier: verifier });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe("invalid_grant");
  });

  it("still refreshes after a PKCE exchange", async () => {
    const u = await makeUser("pkce-refresh");
    const clientId = await registerClient("Refresh client");
    const { verifier, challenge } = await pkce();
    const code = await codeFor(u, clientId, challenge, "st-0", true);
    const first = await form(clientId, code, { code_verifier: verifier });
    expect(first.status).toBe(200);
    const refreshToken = ((await first.json()) as { refresh_token?: string }).refresh_token ?? "";
    expect(refreshToken).toBeTruthy();
    const next = await tokenForm({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
    expect(next.status).toBe(200);
    const body = (await next.json()) as { access_token?: string; refresh_token?: string };
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
  });
});
