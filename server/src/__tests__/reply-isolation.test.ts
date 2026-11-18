import { describe, expect, it } from "vitest";
import { handlePostReply } from "../core/routes/reply";
import type { Env } from "../core/types";

// Multi-tenant isolation: a caller must only be able to reply to their OWN
// messages. The handler resolves the caller via resolveCallerUserId (session
// path here) and scopes the existence SELECT by user_id. This mock authenticates
// the caller (serves the user row) but returns null for the scoped message
// lookup — simulating "this message belongs to a different user".
class MockDB {
  capturedSql: string[] = [];
  capturedBinds: unknown[][] = [];

  prepare(sql: string) {
    const db = this;
    return {
      bind(...binds: unknown[]) {
        db.capturedSql.push(sql);
        db.capturedBinds.push(binds);
        return {
          async run() {
            return { success: true, meta: { changes: 0 } };
          },
          async first() {
            // Auth: resolve the caller's user id from their session email.
            if (sql.includes("FROM users WHERE email")) {
              return { id: "caller-id" };
            }
            // Scoped existence check: the message is NOT owned by this caller,
            // so the user_id-scoped SELECT finds no row.
            if (sql.includes("SELECT id, reply FROM messages")) {
              return null;
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
    return key === "session:valid-token" ? "caller@example.com" : null;
  }

  async getWithMetadata(key: string) {
    return {
      value: key === "session:valid-token" ? "caller@example.com" : null,
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

describe("handlePostReply multi-tenant isolation", () => {
  it("cannot reply to another user's message (404 + user_id-scoped existence check)", async () => {
    const db = new MockDB();
    const request = new Request("https://pidgin.example.com/api/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: "session=valid-token",
      },
      body: JSON.stringify({ message_id: "someone-elses-msg", reply: "yes" }),
    });

    const response = await handlePostReply(request, makeEnv(db));

    // Foreign message is invisible to this caller — same shape as not-found.
    expect(response.status).toBe(404);

    // The existence SELECT must be scoped to the caller's user_id. Without this
    // scope the endpoint would let any authenticated session reply to any id.
    const existenceSql = db.capturedSql.find((s) =>
      s.includes("SELECT id, reply FROM messages")
    );
    expect(existenceSql).toBeDefined();
    expect(existenceSql).toContain("user_id = ?");
  });
});
