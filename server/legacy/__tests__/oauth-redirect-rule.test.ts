import { env as bindings } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { isAllowedRedirectUri } from "../routes/oauth";
import type { Env } from "../types";

// The redirect URI rule: https anywhere, or http on the loopback host only.
// Checked as a unit, and through the registration and consent routes.

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

async function send(path: string, init: RequestInit = {}) {
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx);
}

async function makeUser(label: string) {
  const id = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const email = `${id}@example.com`;
  await env.DB.prepare("INSERT INTO users (id, email, status) VALUES (?, ?, 'active')").bind(id, email).run();
  return { id, email };
}

describe("redirect URI rule: accepted", () => {
  it("accepts the callbacks real MCP clients use", () => {
    for (const uri of [
      "http://localhost:8787/callback",
      "http://localhost:54321/callback",
      "http://127.0.0.1/",
      "http://127.0.0.1:33418/",
      "http://[::1]:3000/callback",
      "https://claude.ai/api/mcp/auth_callback",
      "https://www.cursor.com/agents/mcp/oauth/callback",
      "https://chatgpt.com/connector_platform_oauth_redirect",
      "https://vscode.dev/redirect",
      "https://example.com/cb?x=1",
    ]) {
      expect(isAllowedRedirectUri(uri), uri).toBe(true);
    }
  });

  it("reports the IPv6 loopback hostname with brackets", () => {
    expect(new URL("http://[::1]:3000/callback").hostname).toBe("[::1]");
  });
});

describe("redirect URI rule: refused", () => {
  it("refuses private app schemes", () => {
    for (const uri of [
      "cursor://anysphere.cursor-mcp/oauth/callback",
      "pidgin://auth/session",
      "com.example.app:/oauth",
      "myapp://callback",
    ]) {
      expect(isAllowedRedirectUri(uri), uri).toBe(false);
    }
  });

  it("refuses http to any host but loopback", () => {
    for (const uri of [
      "http://example.com/cb",
      "http://localhost.evil.example/cb",
      "http://127.0.0.1.evil.example/cb",
      "http://127.0.0.2/cb",
      "http://0.0.0.0:3000/cb",
      "http://192.168.1.10/cb",
      "http://localhost./cb",
    ]) {
      expect(isAllowedRedirectUri(uri), uri).toBe(false);
    }
  });

  it("refuses userinfo", () => {
    for (const uri of [
      "http://localhost@evil.example/cb",
      "https://user:pass@example.com/cb",
      "https://user@example.com/cb",
      "http://user@localhost:3000/cb",
    ]) {
      expect(isAllowedRedirectUri(uri), uri).toBe(false);
    }
  });

  it("refuses fragments, relative and non-string values", () => {
    for (const value of [
      "https://example.com/cb#frag",
      "https://example.com/cb#",
      "/relative/callback",
      "not a uri",
      "",
      null,
      undefined,
      42,
      {},
      [],
      "https://example.com/" + "a".repeat(2048),
    ]) {
      expect(isAllowedRedirectUri(value), String(value)).toBe(false);
    }
  });

  it("still refuses schemes that run in the browser", () => {
    for (const uri of [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "data:text/html,x",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "blob:https://example.com/x",
      "about:blank",
    ]) {
      expect(isAllowedRedirectUri(uri), uri).toBe(false);
    }
  });
});

describe("redirect URI rule: routes", () => {
  it("registration refuses a custom scheme", async () => {
    const register = (redirectUris: unknown) => send("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.9" },
      body: JSON.stringify({ client_name: "Rule check", redirect_uris: redirectUris }),
    });
    const refused = await register(["cursor://anysphere.cursor-mcp/oauth/callback"]);
    expect(refused.status).toBe(400);
    const refusedBody = (await refused.json()) as { error?: string; error_description?: string };
    expect(refusedBody.error).toBe("invalid_redirect_uri");
    expect(refusedBody.error_description).toEqual(expect.stringContaining("https"));
    expect(refusedBody.error_description).toEqual(expect.stringContaining("localhost"));
    expect((await register(["http://localhost:8787/callback"])).status).toBe(201);
  });

  it("the consent decision refuses a stored request whose redirect is no longer allowed", async () => {
    const u = await makeUser("consent-rule-stored");
    const { requestId } = await seedStoredRequest(u);
    const res = await send("/oauth/consent", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: requestId, decision: "allow" }).toString(),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
    expect(((await res.json()) as { error?: string }).error).toBe("unauthorized_client");
  });

  it("the consent page refuses a stored request whose redirect is no longer allowed", async () => {
    const u = await makeUser("consent-rule-page");
    const { requestId } = await seedStoredRequest(u);
    const page = await send(`/oauth/consent?request_id=${requestId}`, { headers: { "Sec-Fetch-Dest": "document" } });
    const unknown = await send(`/oauth/consent?request_id=${crypto.randomUUID()}`, { headers: { "Sec-Fetch-Dest": "document" } });
    expect(page.status).toBe(unknown.status);
    expect(page.headers.get("Location")).toBeNull();
    const body = await page.text();
    expect(body).toContain("This sign-in request expired");
    expect(body).toBe(await unknown.text());
    expect(body).not.toContain("myapp://");
  });

  it("authorize refuses a client registered earlier with a custom scheme", async () => {
    const clientId = await seedClient("myapp://callback");
    const verifier = "v".repeat(20) + crypto.randomUUID();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const query = new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: "myapp://callback", scope: "mcp",
      state: "st-authorize", code_challenge: challenge, code_challenge_method: "S256",
    });
    const u = await makeUser("authorize-rule");
    const token = `tok-${crypto.randomUUID()}`;
    await env.SESSIONS.put(`session:${token}`, u.email, { expirationTtl: 600 });
    const res = await send(`/oauth/authorize?${query}`, { headers: { Cookie: `session=${token}` } });
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
    expect(((await res.json()) as { error?: string }).error).toBe("invalid_request");
  });
});

// A client record as it was stored before the rule changed.
async function seedClient(redirectUri: string): Promise<string> {
  const clientId = `client-${crypto.randomUUID()}`;
  await env.SESSIONS.put(`oauth:client:${clientId}`, JSON.stringify({
    client_id: clientId,
    client_name: "Stored custom scheme",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    created_at: Date.now(),
  }));
  return clientId;
}

// A pending consent request, with the client record it points at.
async function seedStoredRequest(u: { id: string; email: string }): Promise<{ requestId: string }> {
  const redirectUri = "myapp://callback";
  const clientId = await seedClient(redirectUri);
  const requestId = crypto.randomUUID();
  await env.SESSIONS.put(`oauth:consent-request:${requestId}`, JSON.stringify({
    user_id: u.id,
    email: u.email,
    params: {
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "mcp",
      state: "st-rule",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
    },
    session: null,
  }), { expirationTtl: 600 });
  return { requestId };
}
