import { describe, expect, it } from "vitest";

import { computeReplyStatus, handleBulkArchive } from "../core/routes/messages";
import type { Env } from "../core/types";

// Fixed clock: 2026-06-03T12:00:00Z
const NOW = Math.floor(Date.parse("2026-06-03T12:00:00Z") / 1000);
const iso = (offsetSeconds: number) =>
  new Date((NOW + offsetSeconds) * 1000).toISOString().replace("T", " ").slice(0, 19);

describe("computeReplyStatus", () => {
  it("returns null for non-question types (not replyable)", () => {
    for (const type of ["message", "status", "document"]) {
      expect(computeReplyStatus(type, null, iso(-1), NOW).reply_status).toBeNull();
    }
  });

  it("answered when a reply exists, regardless of polling", () => {
    expect(computeReplyStatus("question", "yes do it", iso(-1), NOW).reply_status).toBe("answered");
    expect(computeReplyStatus("question", "yes", null, NOW).reply_status).toBe("answered");
  });

  it("never when the agent has not polled yet", () => {
    expect(computeReplyStatus("question", null, null, NOW).reply_status).toBe("never");
  });

  it("live when polled within the 15s window", () => {
    const r = computeReplyStatus("question", null, iso(-5), NOW);
    expect(r.reply_status).toBe("live");
    expect(r.seconds_since_poll).toBe(5);
  });

  it("idle when the last poll is older than the live window", () => {
    const r = computeReplyStatus("question", null, iso(-120), NOW);
    expect(r.reply_status).toBe("idle");
    expect(r.seconds_since_poll).toBe(120);
  });

  it("treats the boundary (exactly 15s) as still live", () => {
    expect(computeReplyStatus("question", null, iso(-15), NOW).reply_status).toBe("live");
    expect(computeReplyStatus("question", null, iso(-16), NOW).reply_status).toBe("idle");
  });
});

// Minimal D1 mock that records UPDATEs and serves the owner user row.
class MockDB {
  lastUpdate: { sql: string; binds: any[] } | null = null;
  changes = 3;
  prepare(sql: string) {
    const db = this;
    return {
      bind(...binds: any[]) {
        return {
          async run() {
            if (sql.trim().startsWith("UPDATE messages")) {
              db.lastUpdate = { sql, binds };
              return { success: true, meta: { changes: db.changes } };
            }
            return { success: true, meta: { changes: 0 } };
          },
          async first() {
            if (sql.includes("FROM users WHERE email")) {
              return { id: "owner-id", email: "owner@example.com" };
            }
            return null;
          },
        };
      },
    };
  }
}

function makeEnv(db: MockDB): Env {
  return {
    DB: db as unknown as D1Database,
    DOCS: {} as R2Bucket,
    SESSIONS: {
      get: async () => "owner@example.com",
      getWithMetadata: async () => ({ value: "owner@example.com", metadata: null }),
      put: async () => {},
    } as unknown as KVNamespace,
    ENHANCE_QUEUE: { send: async () => {} } as unknown as Env["ENHANCE_QUEUE"],
    API_KEY: "test-key",
    OWNER_EMAIL: "owner@example.com",
    APNS_KEY_ID: "",
    APNS_TEAM_ID: "",
    APNS_PRIVATE_KEY: "",
    WORKER_URL: "https://example.test",
    ENVIRONMENT: "test",
  };
}

function bulkRequest(body: unknown): Request {
  return new Request("https://example.test/api/messages/bulk-archive", {
    method: "POST",
    headers: { Authorization: "Session token", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handleBulkArchive", () => {
  it("archives all inbox messages when all:true", async () => {
    const db = new MockDB();
    const res = await handleBulkArchive(bulkRequest({ all: true }), makeEnv(db));
    const json = (await res.json()) as { ok: boolean; data: { archived: number } };
    expect(json.ok).toBe(true);
    expect(json.data.archived).toBe(3);
    expect(db.lastUpdate?.sql).toContain("archived_at IS NULL");
    // owner scope is strictly user_id-bound; legacy null-owner rows were backfilled (migration 0012)
    expect(db.lastUpdate?.sql).not.toContain("user_id IS NULL");
    expect(db.lastUpdate?.sql).toContain("user_id = ?");
  });

  it("archives a specific list of ids", async () => {
    const db = new MockDB();
    const res = await handleBulkArchive(bulkRequest({ ids: ["a", "b"] }), makeEnv(db));
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
    expect(db.lastUpdate?.sql).toContain("id IN (?,?)");
    expect(db.lastUpdate?.binds).toEqual(["owner-id", "a", "b"]);
  });

  it("rejects an empty request with no ids and no all flag", async () => {
    const db = new MockDB();
    const res = await handleBulkArchive(bulkRequest({}), makeEnv(db));
    expect(res.status).toBe(400);
  });
});
