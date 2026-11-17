import { describe, expect, it } from "vitest";
import { handlePostReply } from "../core/routes/reply";
import type { Env } from "../core/types";

class MockDB {
  changes = 0;
  capturedSql: string[] = [];
  capturedBinds: unknown[][] = [];

  // The reply and its question.replied event are one batch; each statement runs in order.
  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  prepare(sql: string) {
    const db = this;
    return {
      async run() { return { success: true, meta: { changes: 0 } }; },
      bind(...binds: unknown[]) {
        db.capturedSql.push(sql);
        db.capturedBinds.push(binds);
        return {
          async run() {
            return { success: true, meta: { changes: db.changes } };
          },
          async all() {
            return { success: true, results: [], meta: { changes: 0 } };
          },
          async first() {
            // Auth: resolveCallerUserId looks up the session email -> user id.
            if (sql.includes("FROM users WHERE email")) {
              return { id: "owner-id" };
            }
            // Existence/idempotency check: only msg-abc exists, with no reply yet
            if (sql.includes("SELECT id, reply FROM messages")) {
              const id = binds[0] as string;
              return id === "msg-abc" ? { id, reply: null } : null;
            }
            return null;
          },
        };
      },
    };
  }
}

class MockSessions {
  async get(key: string): Promise<string | null> {
    return key === "session:valid-token" ? "owner@example.com" : null;
  }

  async getWithMetadata(key: string) {
    return {
      value: key === "session:valid-token" ? "owner@example.com" : null,
      metadata: { exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60 },
    };
  }

  async put(_key: string, _value: string, _opts?: unknown) {}
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

describe("handlePostReply", () => {
  it("returns 401 without session auth", async () => {
    const db = new MockDB();
    const request = new Request("https://pidgin.example.com/api/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message_id: "msg-1", reply: "yes" }),
    });
    const response = await handlePostReply(request, makeEnv(db));
    expect(response.status).toBe(401);
  });

  it("returns 400 for missing fields", async () => {
    const db = new MockDB();
    const request = new Request("https://pidgin.example.com/api/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: "session=valid-token",
      },
      body: JSON.stringify({ message_id: "msg-1" }),
    });
    const response = await handlePostReply(request, makeEnv(db));
    expect(response.status).toBe(400);
  });

  it("returns 404 when message not found or already replied", async () => {
    const db = new MockDB();
    db.changes = 0;
    const request = new Request("https://pidgin.example.com/api/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: "session=valid-token",
      },
      body: JSON.stringify({ message_id: "missing-id", reply: "yes" }),
    });
    const response = await handlePostReply(request, makeEnv(db));
    expect(response.status).toBe(404);
  });

  it("marks message read=1 when reply is stored", async () => {
    const db = new MockDB();
    db.changes = 1;
    const request = new Request("https://pidgin.example.com/api/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: "session=valid-token",
      },
      body: JSON.stringify({ message_id: "msg-abc", reply: "Proceed" }),
    });
    await handlePostReply(request, makeEnv(db));
    const updateSql = db.capturedSql.find((s) => s.startsWith("UPDATE messages"));
    expect(updateSql).toContain("read = 1");
    expect(updateSql).toContain("read_at = datetime('now')");
  });
});
