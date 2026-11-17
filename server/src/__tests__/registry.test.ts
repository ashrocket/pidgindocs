import { describe, expect, it } from "vitest";
import { handleRegister, handleGetRegistry, handleDeregister, handleHeartbeat, handleGetInstance } from "../core/routes/registry";
import type { Env } from "../core/types";

class MockDB {
  changes = 1;
  capturedSql: string[] = [];
  capturedBinds: unknown[][] = [];
  instances: Array<{ instance_id: string; model: string; project: string; working_on: string | null; source: string; registered_at: string; last_heartbeat: string }> = [];

  prepare(sql: string) {
    const db = this;
    return {
      async run() {
        return { success: true, meta: { changes: db.changes } };
      },
      async all() {
        if (sql.includes("FROM instances")) return { results: db.instances };
        return { results: [] };
      },
      bind(...binds: unknown[]) {
        db.capturedSql.push(sql);
        db.capturedBinds.push(binds);
        return {
          async run() {
            return { success: true, meta: { changes: db.changes } };
          },
          async first() {
            // resolveApiKeyUser: no DB-stored API keys in tests → env.API_KEY fallback
            if (sql.includes("FROM api_keys")) return null;
            if (sql.includes("FROM users WHERE email")) {
              return { id: "owner-id", email: "owner@example.com" };
            }
            if (sql.includes("WHERE instance_id = ?")) {
              const id = binds[0] as string;
              return db.instances.find((i) => i.instance_id === id) ?? null;
            }
            return null;
          },
          async all() {
            if (sql.includes("FROM instances")) return { results: db.instances };
            return { results: [] };
          },
        };
      },
    };
  }
}

class MockSessions {
  async get(key: string): Promise<string | null> {
    return key === "session:valid" ? "owner@example.com" : null;
  }
  // verifySession() uses getWithMetadata (for TTL-based renewal), so the dual-auth
  // get-instance path exercises this, not get().
  async getWithMetadata<T>(key: string): Promise<{ value: string | null; metadata: T | null }> {
    const value = key === "session:valid" ? "owner@example.com" : null;
    return { value, metadata: (value ? { exp: Math.floor(Date.now() / 1000) + 99999 } : null) as T | null };
  }
  async put(): Promise<void> {}
}

function makeEnv(db: MockDB): Env {
  return {
    DB: db as unknown as D1Database,
    DOCS: {} as R2Bucket,
    SESSIONS: new MockSessions() as unknown as KVNamespace,
    ENHANCE_QUEUE: { send: async () => {} } as unknown as Env["ENHANCE_QUEUE"],
    API_KEY: "test-key",
    OWNER_EMAIL: "owner@example.com",
    APNS_KEY_ID: "",
    APNS_TEAM_ID: "",
    APNS_PRIVATE_KEY: "",
    WORKER_URL: "https://pidgin.example.com",
    ENVIRONMENT: "test",
  };
}

describe("handleRegister", () => {
  it("returns 401 without API key", async () => {
    const db = new MockDB();
    const request = new Request("https://pidgin.example.com/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instance_id: "abc", model: "claude-opus-4-6", project: "test", source: "claude-code" }),
    });
    const response = await handleRegister(request, makeEnv(db));
    expect(response.status).toBe(401);
  });

  it("returns 400 for missing fields", async () => {
    const db = new MockDB();
    const request = new Request("https://pidgin.example.com/api/register", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ instance_id: "abc" }),
    });
    const response = await handleRegister(request, makeEnv(db));
    expect(response.status).toBe(400);
  });

  it("inserts instance and returns 201", async () => {
    const db = new MockDB();
    const request = new Request("https://pidgin.example.com/api/register", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        instance_id: "session-123",
        model: "claude-opus-4-6",
        project: "my-project",
        source: "claude-code",
        working_on: "building tests",
      }),
    });
    const response = await handleRegister(request, makeEnv(db));
    expect(response.status).toBe(201);
    const body = await response.json() as { ok: boolean; data: { instance_id: string } };
    expect(body.data.instance_id).toBe("session-123");
  });

  it("uses ON CONFLICT UPSERT to preserve registered_at on re-register", async () => {
    const db = new MockDB();
    const request = new Request("https://pidgin.example.com/api/register", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ instance_id: "s1", model: "claude-opus-4-6", project: "p", source: "claude-code" }),
    });
    await handleRegister(request, makeEnv(db));
    const insertSql = db.capturedSql.find((s) => s.startsWith("INSERT INTO instances"));
    expect(insertSql).toContain("ON CONFLICT(instance_id) DO UPDATE SET");
    expect(insertSql).not.toContain("OR REPLACE");
  });
});

describe("handleGetRegistry", () => {
  // Sessions are accepted since parity round 4 and scoped to the caller's own
  // instances; see registry-session-auth.test.ts for the cross-user cases.
  it("rejects requests with neither a valid session nor an API key", async () => {
    const db = new MockDB();
    const request = new Request("https://pidgin.example.com/api/registry", {
      headers: { Authorization: "Bearer not-a-key" },
    });
    const response = await handleGetRegistry(request, makeEnv(db));
    expect(response.status).toBe(401);
  });

  it("accepts API key auth", async () => {
    const db = new MockDB();
    const request = new Request("https://pidgin.example.com/api/registry", {
      headers: { Authorization: "Bearer test-key" },
    });
    const response = await handleGetRegistry(request, makeEnv(db));
    expect(response.status).toBe(200);
  });

  it("annotates instances with status=live or status=stale", async () => {
    const db = new MockDB();
    const liveTs = new Date(Date.now() - 60 * 1000).toISOString(); // 1m ago → live
    const staleTs = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10m ago → stale
    db.instances = [
      { instance_id: "a", model: "claude-opus-4-6", project: "p1", working_on: null, source: "claude-code", registered_at: liveTs, last_heartbeat: liveTs },
      { instance_id: "b", model: "claude-opus-4-6", project: "p2", working_on: null, source: "claude-code", registered_at: staleTs, last_heartbeat: staleTs },
    ];
    const request = new Request("https://pidgin.example.com/api/registry", {
      headers: { Authorization: "Bearer test-key" },
    });
    const response = await handleGetRegistry(request, makeEnv(db));
    const body = await response.json() as { ok: boolean; data: Array<{ instance_id: string; status: string }> };
    expect(body.ok).toBe(true);
    expect(body.data.find((i) => i.instance_id === "a")?.status).toBe("live");
    expect(body.data.find((i) => i.instance_id === "b")?.status).toBe("stale");
  });
});

describe("handleHeartbeat", () => {
  it("returns 401 without API key", async () => {
    const db = new MockDB();
    const request = new Request("https://pidgin.example.com/api/register/abc/heartbeat", {
      method: "POST",
    });
    const response = await handleHeartbeat(request, makeEnv(db), "abc");
    expect(response.status).toBe(401);
  });

  it("returns 404 when instance not found (changes=0)", async () => {
    const db = new MockDB();
    db.changes = 0;
    const request = new Request("https://pidgin.example.com/api/register/missing/heartbeat", {
      method: "POST",
      headers: { Authorization: "Bearer test-key" },
    });
    const response = await handleHeartbeat(request, makeEnv(db), "missing");
    expect(response.status).toBe(404);
  });

  it("updates last_heartbeat and returns instance_id", async () => {
    const db = new MockDB();
    db.changes = 1;
    const request = new Request("https://pidgin.example.com/api/register/session-abc/heartbeat", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ working_on: "running tests" }),
    });
    const response = await handleHeartbeat(request, makeEnv(db), "session-abc");
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; data: { instance_id: string; heartbeat: string } };
    expect(body.data.instance_id).toBe("session-abc");
    expect(body.data.heartbeat).toBeTruthy();
    const updateSql = db.capturedSql.find((s) => s.startsWith("UPDATE instances"));
    expect(updateSql).toContain("last_heartbeat = datetime('now')");
  });

  // Isolation (Task 3g): the heartbeat UPDATE must scope to the caller's user_id
  // so an agent can only heartbeat an instance registered under its own identity.
  // instance_id is globally unique and re-registrable across tenants, so without
  // this clause a foreign id could refresh another user's instance.
  it("scopes the UPDATE to the caller's user_id", async () => {
    const db = new MockDB();
    db.changes = 1;
    const request = new Request("https://pidgin.example.com/api/register/session-abc/heartbeat", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ working_on: "running tests" }),
    });
    await handleHeartbeat(request, makeEnv(db), "session-abc");
    const idx = db.capturedSql.findIndex((s) => s.startsWith("UPDATE instances"));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(db.capturedSql[idx]).toContain("user_id = ?");
    // Bind order: working_on, instance_id, user_id (owner-id from env.API_KEY fallback).
    expect(db.capturedBinds[idx]).toEqual(["running tests", "session-abc", "owner-id"]);
  });
});

describe("handleGetInstance", () => {
  it("returns 404 for unknown instance_id", async () => {
    const db = new MockDB();
    const request = new Request("https://pidgin.example.com/api/register/unknown", {
      headers: { Authorization: "Bearer test-key" },
    });
    const response = await handleGetInstance(request, makeEnv(db), "unknown");
    expect(response.status).toBe(404);
  });

  it("returns instance with status annotation", async () => {
    const db = new MockDB();
    const liveTs = new Date(Date.now() - 30 * 1000).toISOString();
    db.instances = [{
      instance_id: "s1", model: "claude-opus-4-6", project: "proj", working_on: null,
      source: "claude-code", registered_at: liveTs, last_heartbeat: liveTs,
    }];
    const request = new Request("https://pidgin.example.com/api/register/s1", {
      headers: { Authorization: "Bearer test-key" },
    });
    const response = await handleGetInstance(request, makeEnv(db), "s1");
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; data: { instance_id: string; status: string } };
    expect(body.data.instance_id).toBe("s1");
    expect(body.data.status).toBe("live");
  });

  // Isolation (Task 3g): the SELECT must scope to the caller's user_id so a
  // foreign id resolves to no row (404) rather than leaking another tenant's
  // instance metadata.
  it("scopes the SELECT to the caller's user_id", async () => {
    const db = new MockDB();
    const liveTs = new Date(Date.now() - 30 * 1000).toISOString();
    db.instances = [{
      instance_id: "s1", model: "claude-opus-4-6", project: "proj", working_on: null,
      source: "claude-code", registered_at: liveTs, last_heartbeat: liveTs,
    }];
    const request = new Request("https://pidgin.example.com/api/register/s1", {
      headers: { Authorization: "Bearer test-key" },
    });
    await handleGetInstance(request, makeEnv(db), "s1");
    const idx = db.capturedSql.findIndex(
      (s) => s.includes("FROM instances") && s.includes("WHERE instance_id = ?")
    );
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(db.capturedSql[idx]).toContain("user_id = ?");
    // Bind order: instance_id, user_id (owner-id from env.API_KEY fallback).
    expect(db.capturedBinds[idx]).toEqual(["s1", "owner-id"]);
  });

  it("accepts session auth (dual-auth handler)", async () => {
    const db = new MockDB();
    const liveTs = new Date(Date.now() - 30 * 1000).toISOString();
    db.instances = [{
      instance_id: "s1", model: "claude-opus-4-6", project: "proj", working_on: null,
      source: "claude-code", registered_at: liveTs, last_heartbeat: liveTs,
    }];
    const request = new Request("https://pidgin.example.com/api/register/s1", {
      headers: { Cookie: "session=valid" },
    });
    const response = await handleGetInstance(request, makeEnv(db), "s1");
    expect(response.status).toBe(200);
  });
});
