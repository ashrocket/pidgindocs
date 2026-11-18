import { describe, expect, it } from "vitest";
import { runExpiry } from "../core/cron";
import type { Env } from "../core/types";

class MockDB {
  candidates: Array<{ id: string; doc_key: string | null }> = [];
  deletedIds: string[] = [];

  prepare(sql: string) {
    const db = this;
    return {
      bind(..._args: unknown[]) {
        return {
          async run() {
            db.deletedIds.push(..._args as string[]);
            return { success: true, meta: { changes: db.candidates.length } };
          },
        };
      },
      async all() {
        return { results: db.candidates };
      },
    };
  }
}

class MockR2 {
  deleted: string[] = [];
  failKey: string | null = null;
  async delete(key: string) {
    if (key === this.failKey) throw new Error("R2 unavailable");
    this.deleted.push(key);
  }
  async put() {}
  async get() { return null; }
}

function makeEnv(db: MockDB, r2: MockR2): Env {
  return {
    DB: db as unknown as D1Database,
    DOCS: r2 as unknown as R2Bucket,
    SESSIONS: {} as KVNamespace,
    ENHANCE_QUEUE: { send: async () => {} } as unknown as Env["ENHANCE_QUEUE"],
    API_KEY: "test-key",
    OWNER_EMAIL: "test@example.com",
    APNS_KEY_ID: "",
    APNS_TEAM_ID: "",
    APNS_PRIVATE_KEY: "",
    WORKER_URL: "https://example.com",
    ENVIRONMENT: "test",
  };
}

describe("runExpiry", () => {
  it("returns deleted=0 when no expired rows", async () => {
    const db = new MockDB();
    db.candidates = [];
    const r2 = new MockR2();
    const result = await runExpiry(makeEnv(db, r2));
    expect(result.deleted).toBe(0);
    expect(r2.deleted).toHaveLength(0);
  });

  it("hard-deletes expired rows and their R2 objects", async () => {
    const db = new MockDB();
    db.candidates = [
      { id: "msg-1", doc_key: "docs/msg-1.html" },
      { id: "msg-2", doc_key: null },
    ];
    const r2 = new MockR2();
    const result = await runExpiry(makeEnv(db, r2));
    expect(result.deleted).toBe(2);
    expect(r2.deleted).toContain("docs/msg-1.html");
    expect(r2.deleted).not.toContain(null);
  });

  it("does not delete pinned rows (SQL WHERE pinned=0 enforced by mock returning only non-pinned candidates)", async () => {
    const db = new MockDB();
    // Simulate: the query only returns non-pinned rows (pinned=0 is in the WHERE clause)
    db.candidates = [{ id: "msg-3", doc_key: null }];
    const r2 = new MockR2();
    const result = await runExpiry(makeEnv(db, r2));
    expect(result.deleted).toBe(1);
    expect(db.deletedIds).toContain("msg-3");
  });

  it("keeps the D1 ownership row when an R2 delete fails", async () => {
    const db = new MockDB();
    db.candidates = [{ id: "msg-4", doc_key: "docs/msg-4.html" }];
    const r2 = new MockR2();
    r2.failKey = "docs/msg-4.html";

    const result = await runExpiry(makeEnv(db, r2));

    expect(result).toEqual({ deleted: 0 });
    expect(db.deletedIds).not.toContain("msg-4");
  });
});
