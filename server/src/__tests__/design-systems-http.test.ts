import { describe, expect, it, vi } from "vitest";
import {
  handleDeleteDesignSystem,
  handleGetDesignSystem,
  handleImportDesignSystem,
  handleListDesignSystems,
  handlePutDesignSystem,
} from "../core/routes/design-systems";
import type { Env } from "../core/types";

type DsRow = {
  id: string; user_id: string; name: string; display_name: string;
  description: string | null; tokens_json: string; css: string | null; source: string;
};

// Same MockDB shape as design-systems-mcp.test.ts: covers the auth-resolution
// queries (api_keys miss -> env.API_KEY owner fallback -> users lookup) plus
// the design_systems table CRUD used by src/design-systems.ts.
class MockDB {
  rows: DsRow[] = [];

  prepare(sql: string) {
    const db = this;
    let binds: unknown[] = [];
    const statement = {
      bind(...args: unknown[]) {
        binds = args;
        return statement;
      },
      async first<T>() {
        if (sql.includes("FROM api_keys ak")) {
          return null as T | null;
        }
        if (sql.includes("FROM users WHERE email = ?")) {
          return ({ id: "owner-user", email: "owner@example.com" }) as T;
        }
        if (sql.includes("FROM hosted_accounts")) {
          return null as T | null;
        }
        if (sql.includes("FROM design_systems") && sql.includes("AND name = ?")) {
          const [userId, name] = binds as [string, string];
          const row = db.rows.find((r) => r.user_id === userId && r.name === name);
          return (row ?? null) as T | null;
        }
        throw new Error(`Unsupported first() query in test: ${sql}`);
      },
      async all<T>() {
        if (sql.includes("FROM design_systems")) {
          const userId = binds[0] as string;
          const results = db.rows
            .filter((r) => r.user_id === userId)
            .sort((a, b) => a.name.localeCompare(b.name));
          return { results: results as unknown as T[] };
        }
        throw new Error(`Unsupported all() query in test: ${sql}`);
      },
      async run() {
        if (sql.startsWith("DELETE FROM design_systems")) {
          const [userId, name] = binds as [string, string];
          const before = db.rows.length;
          db.rows = db.rows.filter((r) => !(r.user_id === userId && r.name === name));
          return { meta: { changes: before - db.rows.length } };
        }
        if (sql.startsWith("INSERT INTO design_systems")) {
          const [id, userId, name, displayName, description, tokensJson, css, source] =
            binds as [string, string, string, string, string, string, string | null, string];
          const existing = db.rows.find((r) => r.user_id === userId && r.name === name);
          if (existing) {
            Object.assign(existing, { display_name: displayName, description, tokens_json: tokensJson, css, source });
          } else {
            db.rows.push({ id, user_id: userId, name, display_name: displayName, description, tokens_json: tokensJson, css, source });
          }
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("UPDATE api_keys SET last_used_at")) {
          return { success: true };
        }
        throw new Error(`Unsupported run() query in test: ${sql}`);
      },
    };
    return statement;
  }
}

function makeEnv(anthropicApiKey?: string) {
  const DB = new MockDB();
  const queue = { send: vi.fn().mockResolvedValue(undefined) };
  const env = {
    DB: DB as unknown as Env["DB"],
    DOCS: {} as Env["DOCS"],
    SESSIONS: {} as Env["SESSIONS"],
    ENHANCE_QUEUE: queue as unknown as Env["ENHANCE_QUEUE"],
    API_KEY: "test-key",
    OWNER_EMAIL: "owner@example.com",
    ANTHROPIC_API_KEY: anthropicApiKey,
    APNS_KEY_ID: "",
    APNS_TEAM_ID: "",
    APNS_PRIVATE_KEY: "",
    WORKER_URL: "https://pidgin.example.com",
    ENVIRONMENT: "test",
  } satisfies Env;
  return { env, db: DB, queue };
}

const authHeaders = { Authorization: "Bearer test-key" };

const validTokens = {
  color: { background: { $value: "#FFFFFF" }, text: { $value: "#111111" } },
  font: { body: { $value: ["Georgia", "serif"] }, heading: { $value: ["Arial", "sans-serif"] } },
};

describe("design-system HTTP routes", () => {
  it("1. GET list without auth returns 401 envelope", async () => {
    const { env } = makeEnv();
    const request = new Request("https://pidgin.test/api/design-systems", { method: "GET" });
    const response = await handleListDesignSystems(request, env);

    expect(response.status).toBe(401);
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("2. GET list with auth returns 200 and includes pidgin-editorial", async () => {
    const { env } = makeEnv();
    const request = new Request("https://pidgin.test/api/design-systems", {
      method: "GET",
      headers: authHeaders,
    });
    const response = await handleListDesignSystems(request, env);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; data: { design_systems: Array<{ name: string }> } };
    expect(body.ok).toBe(true);
    expect(body.data.design_systems.some((s) => s.name === "pidgin-editorial")).toBe(true);
  });

  it("3. PUT my-brand with valid body returns 200; GET my-brand returns tokens", async () => {
    const { env } = makeEnv();
    const putRequest = new Request("https://pidgin.test/api/design-systems/my-brand", {
      method: "PUT",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ tokens: validTokens, css: ".callout { color: var(--ds-accent); }" }),
    });
    const putResponse = await handlePutDesignSystem(putRequest, env, "my-brand");
    expect(putResponse.status).toBe(200);
    const putBody = (await putResponse.json()) as { ok: boolean; data: { design_system: { name: string } } };
    expect(putBody.ok).toBe(true);
    expect(putBody.data.design_system.name).toBe("my-brand");

    const getRequest = new Request("https://pidgin.test/api/design-systems/my-brand", {
      method: "GET",
      headers: authHeaders,
    });
    const getResponse = await handleGetDesignSystem(getRequest, env, "my-brand");
    expect(getResponse.status).toBe(200);
    const getBody = (await getResponse.json()) as {
      ok: boolean;
      data: { design_system: { tokens: unknown; css: string } };
    };
    expect(getBody.data.design_system.tokens).toEqual(validTokens);
    expect(getBody.data.design_system.css).toBe(".callout { color: var(--ds-accent); }");
  });

  it("4. PUT with invalid tokens returns 400, error lists missing paths", async () => {
    const { env } = makeEnv();
    const badTokens = {
      color: { text: { $value: "#111111" } },
      font: { body: { $value: ["Georgia"] }, heading: { $value: ["Arial"] } },
    };
    const request = new Request("https://pidgin.test/api/design-systems/broken-brand", {
      method: "PUT",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ tokens: badTokens }),
    });
    const response = await handlePutDesignSystem(request, env, "broken-brand");

    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("color.background");
  });

  it("5. PUT pidgin-editorial returns 400 (reserved)", async () => {
    const { env } = makeEnv();
    const request = new Request("https://pidgin.test/api/design-systems/pidgin-editorial", {
      method: "PUT",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ tokens: validTokens }),
    });
    const response = await handlePutDesignSystem(request, env, "pidgin-editorial");

    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
  });

  it("6. DELETE my-brand returns 200; second DELETE returns 404", async () => {
    const { env } = makeEnv();
    const putRequest = new Request("https://pidgin.test/api/design-systems/my-brand", {
      method: "PUT",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ tokens: validTokens }),
    });
    await handlePutDesignSystem(putRequest, env, "my-brand");

    const deleteRequest = new Request("https://pidgin.test/api/design-systems/my-brand", {
      method: "DELETE",
      headers: authHeaders,
    });
    const firstDelete = await handleDeleteDesignSystem(deleteRequest, env, "my-brand");
    expect(firstDelete.status).toBe(200);
    const firstBody = (await firstDelete.json()) as { ok: boolean; data: { name: string; deleted: boolean } };
    expect(firstBody.ok).toBe(true);
    expect(firstBody.data).toMatchObject({ name: "my-brand", deleted: true });

    const secondDelete = await handleDeleteDesignSystem(deleteRequest, env, "my-brand");
    expect(secondDelete.status).toBe(404);
    const secondBody = (await secondDelete.json()) as { ok: boolean };
    expect(secondBody.ok).toBe(false);
  });

  it("7a. POST import with ANTHROPIC_API_KEY returns 202 and queues the job", async () => {
    const { env, queue } = makeEnv("sk-test-anthropic-key");
    const request = new Request("https://pidgin.test/api/design-systems/import", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "acme-brand", material: "Primary color #123456, body font Georgia." }),
    });
    const response = await handleImportDesignSystem(request, env);

    expect(response.status).toBe(202);
    const body = (await response.json()) as { ok: boolean; data: { name: string; status: string } };
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({ name: "acme-brand", status: "queued" });
    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(queue.send).toHaveBeenCalledWith({
      kind: "import",
      name: "acme-brand",
      material: "Primary color #123456, body font Georgia.",
      userId: "owner-user",
    });
  });

  it("7b. POST import without ANTHROPIC_API_KEY returns 400 and never queues", async () => {
    const { env, queue } = makeEnv();
    const request = new Request("https://pidgin.test/api/design-systems/import", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "acme-brand", material: "Primary color #123456." }),
    });
    const response = await handleImportDesignSystem(request, env);

    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
    expect(queue.send).not.toHaveBeenCalled();
  });
});
