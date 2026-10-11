import { describe, expect, it } from "vitest";
import { getDocumentRecord, listDocuments } from "../documents";
import type { Env } from "../types";

class CaptureDB {
  queries: Array<{ sql: string; binds: unknown[] }> = [];
  prepare(sql: string) {
    const db = this;
    return {
      bind(...binds: unknown[]) {
        db.queries.push({ sql, binds });
        return {
          async all() { return { results: [] }; },
          async first() { return null; },
        };
      },
    };
  }
}

describe("PidginDocs document tenant scope", () => {
  it("does not query private documents without a user or team scope", async () => {
    const db = new CaptureDB();
    const env = { DB: db as unknown as D1Database } as Env;
    await expect(listDocuments(env, {})).rejects.toThrow("document scope required");
    expect(await getDocumentRecord(env, "foreign-doc")).toBeNull();
    expect(db.queries).toEqual([]);
  });

  it("adds the owning user to an ordinary document read", async () => {
    const db = new CaptureDB();
    const env = { DB: db as unknown as D1Database } as Env;
    await getDocumentRecord(env, "doc-1", "customer-a");
    expect(db.queries[0].sql).toContain("user_id = ?");
    expect(db.queries[0].binds).toEqual(["doc-1", "customer-a"]);
  });
});
