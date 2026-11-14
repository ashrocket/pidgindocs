import { env as bindings } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { sha256Hex } from "../auth-utils";
import { publishArtifact } from "../artifacts/store";
import { artifactCsp } from "../artifacts/render";
import { messageDetailPage } from "../web/message-detail";
import type { SerializedMessageBlock } from "../messages/store";
import type { Env } from "../types";

// Stored artifact HTML is author-controlled. Every response that serves it must
// run in an opaque origin, and the server-backed runtime must authenticate with
// a narrow per-artifact token instead of the viewer's session cookie.

const origin = "https://pidgindocs.example.workers.dev";
const env = {
  ...bindings,
  API_KEY: "artifact-sandbox-test",
  OWNER_EMAIL: "owner@example.com",
  WORKER_URL: origin,
  ENVIRONMENT: "production",
} as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const FORBIDDEN = ["allow-same-origin", "allow-top-navigation", "allow-popups", "allow-forms", "allow-modals"];

function expectOpaque(csp: string) {
  const sandbox = csp.split(";").map((part) => part.trim()).find((part) => part.startsWith("sandbox"));
  expect(sandbox, csp).toBeTruthy();
  for (const token of FORBIDDEN) expect(csp, token).not.toContain(token);
  expect(csp).toMatch(/form-action 'none'/);
  expect(csp).toMatch(/base-uri 'none'/);
}

async function user() {
  const id = crypto.randomUUID();
  const email = `${id}@example.com`;
  const apiKey = crypto.randomUUID().replace(/-/g, "");
  const session = crypto.randomUUID().replace(/-/g, "");
  await env.DB.prepare("INSERT INTO users(id,email,status) VALUES(?,?,'active')").bind(id, email).run();
  await env.DB.prepare("INSERT INTO api_keys(key_hash,key_prefix,user_id) VALUES(?,?,?)")
    .bind(await sha256Hex(apiKey), "test", id).run();
  await env.SESSIONS.put(`session:${session}`, email);
  const get = (path: string) =>
    worker.fetch(new Request(origin + path, { headers: { Authorization: `Bearer ${apiKey}` } }), env, ctx);
  return { id, email, apiKey, session, get };
}

async function capabilityArtifact(owner: { id: string }) {
  const published = await publishArtifact(env, {
    userId: owner.id,
    html: "<p>runtime</p>",
    favicon: "📄",
    capabilities: { storage: true, complete: true },
  });
  return published.artifact.id;
}

async function runtimeTokenFor(viewer: { get(path: string): Promise<Response> }, artifactId: string) {
  const response = await viewer.get(`/a/${artifactId}`);
  expect(response.status).toBe(200);
  const html = await response.text();
  return { html, response, token: html.match(/data-runtime-token="([^"]*)"/)?.[1] ?? "" };
}

function rt(artifactId: string, kind: "storage" | "complete", headers: Record<string, string>, body: unknown) {
  return worker.fetch(
    new Request(`${origin}/api/artifacts/${artifactId}/rt/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    env,
    ctx
  );
}

const setItem = { op: "set", key: "k", value: "v", mode: "personal" };
const bearer = (token: string) => ({ Authorization: `PidginArtifact ${token}` });

describe("artifact pages run in an opaque origin", () => {
  it("the policy on /a/:id starts with the sandbox directive", async () => {
    const u = await user();
    for (const capabilities of [undefined, { storage: true }]) {
      const published = await publishArtifact(env, { userId: u.id, html: "<p>page</p>", favicon: "📄", capabilities });
      const response = await u.get(`/a/${published.artifact.id}`);
      expect(response.status).toBe(200);
      const csp = response.headers.get("Content-Security-Policy")!;
      expect(csp.startsWith("sandbox allow-scripts allow-downloads;"), csp).toBe(true);
      expectOpaque(csp);
    }
  });

  it("artifactCsp is opaque with and without capabilities, framed or not", () => {
    for (const capabilities of [false, true])
      for (const frame of ["'none'", origin]) expectOpaque(artifactCsp(capabilities, frame, origin, "a1"));
  });

  it("connect-src is closed unless the artifact has capabilities, then only its own runtime path", () => {
    expect(artifactCsp(false, "'none'", origin, "a1")).toContain("connect-src 'none';");
    const csp = artifactCsp(true, "'none'", origin, "a1");
    expect(csp).toContain(`connect-src ${origin}/api/artifacts/a1/rt/;`);
    expect(csp).toContain(`script-src ${origin}/a/assets/ 'unsafe-inline';`);
    expect(csp).not.toContain("'self'");
  });

  it("a capability page carries a runtime token, a plain page does not, and the page sends the opener policy", async () => {
    const u = await user();
    const withCaps = await runtimeTokenFor(u, await capabilityArtifact(u));
    expect(withCaps.token).toMatch(/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/);
    expect(withCaps.html).toContain(`data-runtime-origin="${origin}"`);
    expect(withCaps.response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    const plain = await publishArtifact(env, { userId: u.id, html: "<p>plain</p>", favicon: "📄" });
    expect((await runtimeTokenFor(u, plain.artifact.id)).html).not.toContain("data-runtime-token");
  });

  it("never lets a cache store a capability page", async () => {
    const u = await user();
    const id = await capabilityArtifact(u);
    const latest = await u.get(`/a/${id}`);
    expect(latest.status).toBe(200);
    expect(latest.headers.get("Cache-Control")).toBe("private, no-store");
    const version = latest.headers.get("X-Artifact-Version");
    const pinned = await u.get(`/a/${id}?v=${version}`);
    expect(pinned.status).toBe(200);
    expect(pinned.headers.get("Cache-Control")).toBe("private, no-store");

    const plainId = (await publishArtifact(env, { userId: u.id, html: "<p>plain</p>", favicon: "📄" })).artifact.id;
    const plain = await u.get(`/a/${plainId}`);
    expect(plain.status).toBe(200);
    expect(plain.headers.get("Cache-Control")).not.toBe("private, no-store");
  });

  it("the runtime script sends the token and no cookie", async () => {
    const script = await (await worker.fetch(new Request(`${origin}/a/assets/runtime.js`), env, ctx)).text();
    expect(script).toContain("credentials: 'omit'");
    expect(script).toContain("PidginArtifact");
    expect(script).not.toContain("credentials: 'include'");
  });
});

describe("the message embed iframe", () => {
  const message = {
    id: "message-1",
    type: "message",
    title: "Two observations",
    body: "fallback",
    reply: null,
    created_at: "2026-08-05 12:00:00",
    priority: "normal",
    instance_project: "pidgin",
    instance_model: "codex",
  };
  const blocks: SerializedMessageBlock[] = [
    {
      type: "artifact",
      artifact_id: "artifact-1",
      version: 2,
      label: "Latency",
      producer: "visualize",
      producer_action: "show_widget",
      summary: "Latency remained stable.",
      artifact_title: "Latency chart",
      artifact_favicon: "📊",
      artifact_available: true,
      latest_version: 2,
      has_capabilities: false,
    },
  ];

  it("has no allow-same-origin and the listener expects the opaque origin, the nonce and its own frame", async () => {
    const host = { ...env, ARTIFACT_EMBED_ORIGIN: "https://api.pidgindocs.example.com" } as Env;
    const html = await (await messageDetailPage(host, message, blocks)).text();
    expect(html).toContain('sandbox="allow-scripts allow-downloads"');
    expect(html).not.toContain("allow-same-origin");
    expect(html).toContain("event.origin!=='null'");
    expect(html).toContain("el.dataset.nonce!==d.nonce");
    expect(html).toContain("event.source!==frame.contentWindow");
  });
});

describe("runtime endpoints authenticate with the runtime token", () => {
  it("refuses a session cookie, an API key and no credential at all", async () => {
    const u = await user();
    const id = await capabilityArtifact(u);
    for (const kind of ["storage", "complete"] as const) {
      const body = kind === "storage" ? setItem : { prompt: "hi" };
      expect((await rt(id, kind, { Cookie: `session=${u.session}` }, body)).status).toBe(401);
      expect((await rt(id, kind, { Authorization: `Bearer ${u.apiKey}` }, body)).status).toBe(401);
      expect((await rt(id, kind, {}, body)).status).toBe(401);
    }
  });

  it("accepts a valid token", async () => {
    const u = await user();
    const id = await capabilityArtifact(u);
    const { token } = await runtimeTokenFor(u, id);
    expect(token).not.toBe("");
    expect((await rt(id, "storage", bearer(token), setItem)).status).toBe(200);
    const read = await rt(id, "storage", bearer(token), { op: "get", key: "k", mode: "personal" });
    expect((await read.json() as any).data.value).toBe("v");
    // Authentication passed: the deployment has no completion key, which answers 503, not 401.
    expect((await rt(id, "complete", bearer(token), { prompt: "hi" })).status).toBe(503);
  });

  it("refuses a token issued for another artifact", async () => {
    const u = await user();
    const first = await capabilityArtifact(u);
    const second = await capabilityArtifact(u);
    const { token } = await runtimeTokenFor(u, second);
    expect(token).not.toBe("");
    expect((await rt(first, "storage", bearer(token), setItem)).status).toBe(401);
    expect((await rt(first, "complete", bearer(token), { prompt: "hi" })).status).toBe(401);
  });

  it("refuses a token issued for another viewer, and a payload edited after signing", async () => {
    const owner = await user();
    const other = await user();
    const id = await capabilityArtifact(owner);
    const { issueArtifactRuntimeToken } = await import("../artifacts/runtime-auth");
    // Bound to a different, active user: authenticates, then the ordinary owner check refuses it.
    const foreign = await issueArtifactRuntimeToken(env, id, other.id);
    expect((await rt(id, "storage", bearer(foreign), setItem)).status).toBe(404);
    // Swapping the viewer inside the payload invalidates the signature.
    const ownerToken = (await runtimeTokenFor(owner, id)).token;
    const [, signature] = ownerToken.split(".");
    const edited = btoa(JSON.stringify({ artifact: id, viewer: other.id, expires: Date.now() + 60_000 }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect((await rt(id, "storage", bearer(`${edited}.${signature}`), setItem)).status).toBe(401);
  });

  it("refuses an expired token and a token for a deactivated user", async () => {
    const u = await user();
    const id = await capabilityArtifact(u);
    const { issueArtifactRuntimeToken } = await import("../artifacts/runtime-auth");
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow - 60 * 60 * 1000);
    const old = await issueArtifactRuntimeToken(env, id, u.id);
    vi.restoreAllMocks();
    expect((await rt(id, "storage", bearer(old), setItem)).status).toBe(401);

    const fresh = await issueArtifactRuntimeToken(env, id, u.id);
    expect((await rt(id, "storage", bearer(fresh), setItem)).status).toBe(200);
    await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(u.id).run();
    expect((await rt(id, "storage", bearer(fresh), setItem)).status).toBe(401);
  });

  it("refuses malformed credentials", async () => {
    const u = await user();
    const id = await capabilityArtifact(u);
    for (const value of ["PidginArtifact ", "PidginArtifact abc", "PidginArtifact a.b", `PidginArtifact ${"a".repeat(3000)}`])
      expect((await rt(id, "storage", { Authorization: value }, setItem)).status).toBe(401);
  });
});
