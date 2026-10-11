import { describe, expect, it } from "vitest";
import { handleDismissMessage, handlePinMessage, handleUnarchiveMessage } from "../routes/messages";
import type { Env } from "../types";

class ScopedDB {
  queries: Array<{ sql: string; binds: unknown[] }> = [];

  prepare(sql: string) {
    const db = this;
    let binds: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) { binds = values; return statement; },
      async first<T>(): Promise<T | null> {
        db.queries.push({ sql, binds });
        if (sql === "SELECT id FROM users WHERE email = ?") return { id: "customer-a" } as T;
        return null;
      },
      async run() {
        db.queries.push({ sql, binds });
        // The target row belongs to customer B, so customer A changes no rows.
        return { success: true, meta: { changes: 0 } };
      },
    };
    return statement;
  }
}

function env(db: ScopedDB): Env {
  return {
    DB: db as unknown as D1Database,
    SESSIONS: {
      getWithMetadata: async () => ({ value: "a@example.com", metadata: { exp: 9_999_999_999 } }),
    } as unknown as KVNamespace,
  } as Env;
}

function request(method: string, body?: unknown): Request {
  return new Request("https://pidgindocs.example.workers.dev/api/messages/foreign", {
    method,
    headers: { Cookie: "session=customer-a", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("PidginDocs message tenant isolation", () => {
  it.each([
    ["unarchive", (db: ScopedDB) => handleUnarchiveMessage(request("POST"), env(db), "foreign")],
    ["dismiss", (db: ScopedDB) => handleDismissMessage(request("POST", { action: "archive" }), env(db), "foreign")],
    ["pin", (db: ScopedDB) => handlePinMessage(request("POST", { pinned: true }), env(db), "foreign")],
  ])("%s cannot change a foreign or unowned row", async (_name, run) => {
    const db = new ScopedDB();
    const response = await run(db);
    expect(response.status).toBe(404);
    const messageQueries = db.queries.filter(q => /(?:UPDATE|SELECT).*messages/i.test(q.sql));
    expect(messageQueries.length).toBeGreaterThan(0);
    for (const { sql, binds } of messageQueries) {
      expect(sql).toContain("user_id = ?");
      expect(sql).not.toContain("user_id IS NULL");
      expect(binds).toContain("customer-a");
    }
  });
});
