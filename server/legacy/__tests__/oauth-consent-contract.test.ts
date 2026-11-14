import { env as bindings } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import type { Env } from "../types";

// Contract cases for the OAuth consent step that pidgin-oauth-consent.test.ts
// does not cover: redirect URI shapes, unregistered redirect URIs, the binding
// of a request to its session, and PKCE on the token request.

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
const UNREGISTERED_REDIRECT = "http://127.0.0.1:53113/callback";

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
  return {
    id,
    email,
    newSession,
    cookie: { Cookie: `session=${browserToken}` } as Record<string, string>,
  };
}

async function registerRaw(redirectUris: unknown, ip = "198.51.100.9") {
  return send("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify({ client_name: "Contract client", redirect_uris: redirectUris }),
  });
}

async function registerClient(name: string, redirectUris = [REDIRECT, OTHER_REDIRECT]) {
  const res = await send("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.9" },
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

async function tokenRequest(clientId: string, code: string, redirectUri: string, verifier?: string) {
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId });
  if (verifier !== undefined) body.set("code_verifier", verifier);
  return send("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

// The consent page in a signed-in browser. Returns its request id.
async function consentPageId(u: Awaited<ReturnType<typeof makeUser>>, path: string) {
  const res = await send(path, { headers: { ...u.cookie, "Sec-Fetch-Dest": "document" } });
  expect(res.status).toBe(200);
  return requestIdFrom(await res.text());
}

// True when the response is the 302 that carries an authorization code.
function issuesCode(res: Response): boolean {
  const location = res.headers.get("Location");
  return res.status === 302 && location !== null && new URL(location).searchParams.has("code");
}

describe("OAuth consent contract: redirect URI registration", () => {
  it("refuses redirect URIs that the existing cases do not reach (about, blob, protocol-relative, backslash)", async () => {
    for (const uri of ["about:blank", "blob:https://a.example/b", "//evil.example/cb", "/\\evil.example/cb"]) {
      const res = await registerRaw([uri]);
      expect(res.status, uri).toBe(400);
    }
  });

  it("refuses a list of 11 valid https redirect URIs", async () => {
    const uris = Array.from({ length: 11 }, (_, i) => `https://ok.example/cb${i}`);
    const res = await registerRaw(uris);
    expect(res.status).toBe(400);
  });

  it("accepts an https redirect URI and a loopback IPv4 redirect URI", async () => {
    for (const uri of ["https://ok.example/cb", "http://127.0.0.1:8123/callback"]) {
      const res = await registerRaw([uri]);
      expect(res.status, uri).toBe(201);
    }
  });
});

describe("OAuth consent contract: authorize and decision", () => {
  it("refuses an authorize request for a redirect URI the client did not register", async () => {
    const u = await makeUser("contract-unregistered");
    const clientId = await registerClient("Unregistered redirect client");
    const { challenge } = await pkce();

    const res = await send(authorizePath(clientId, challenge, { redirect_uri: UNREGISTERED_REDIRECT }), {
      headers: { ...u.cookie, "Sec-Fetch-Dest": "document" },
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
    expect(await res.text()).not.toContain("request_id");
  });

  it("issues no code for a request created by another user's session, or with no session", async () => {
    const owner = await makeUser("contract-owner");
    const other = await makeUser("contract-other");
    const clientId = await registerClient("Binding client");
    const { challenge } = await pkce();

    // Control: the owner's own session can allow the request.
    const control = await consentPageId(owner, authorizePath(clientId, challenge));
    expect(issuesCode(await decide(control, "allow", owner.cookie))).toBe(true);

    // A new client each time: the control's Allow is remembered for its client.
    const otherClient = await registerClient("Binding client two");
    const fromOther = await consentPageId(owner, authorizePath(otherClient, challenge));
    expect(issuesCode(await decide(fromOther, "allow", other.cookie))).toBe(false);

    const noClient = await registerClient("Binding client three");
    const noCookie = await consentPageId(owner, authorizePath(noClient, challenge));
    expect(issuesCode(await decide(noCookie, "allow", {}))).toBe(false);
  });

  it("issues no code when the same request id is posted again after an Allow", async () => {
    const u = await makeUser("contract-single-use");
    const clientId = await registerClient("Single use client");
    const { challenge } = await pkce();
    const id = await consentPageId(u, authorizePath(clientId, challenge));

    expect(issuesCode(await decide(id, "allow", u.cookie))).toBe(true);
    expect(issuesCode(await decide(id, "allow", u.cookie))).toBe(false);
  });

  it("gives a 302 with an access_denied error, the state and no code on Deny", async () => {
    const u = await makeUser("contract-deny");
    const clientId = await registerClient("Deny client");
    const { challenge } = await pkce();
    const id = await consentPageId(u, authorizePath(clientId, challenge));

    const res = await decide(id, "deny", u.cookie);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("st-1");
    expect(location.searchParams.has("code")).toBe(false);
  });
});

describe("OAuth consent contract: PKCE on the token request", () => {
  it("refuses a token request with no verifier or a wrong one, and accepts the right one", async () => {
    const u = await makeUser("contract-pkce");
    const clientId = await registerClient("PKCE client");
    const { verifier, challenge } = await pkce();
    const first = await consentPageId(u, authorizePath(clientId, challenge));
    expect((await decide(first, "allow", u.cookie)).status).toBe(302);

    // A remembered Allow issues a fresh code for each attempt; a code is single use.
    const freshCode = async (state: string) => {
      const res = await send(authorizePath(clientId, challenge, { state }), { headers: u.cookie });
      expect(res.status).toBe(302);
      return new URL(res.headers.get("Location") ?? "").searchParams.get("code") ?? "";
    };

    const missing = await tokenRequest(clientId, await freshCode("st-a"), REDIRECT);
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { access_token?: string }).access_token).toBeUndefined();

    const wrong = await tokenRequest(clientId, await freshCode("st-b"), REDIRECT, `wrong-${verifier}`);
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { access_token?: string }).access_token).toBeUndefined();

    const right = await tokenRequest(clientId, await freshCode("st-c"), REDIRECT, verifier);
    expect(right.status).toBe(200);
    expect(((await right.json()) as { access_token?: string }).access_token).toBeTruthy();
  });
});
