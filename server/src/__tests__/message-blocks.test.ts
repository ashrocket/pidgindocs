import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/push/apns", () => ({
  sendPushNotification: vi.fn(async () => {}),
}));

import {
  createMessage,
  deriveMessageBody,
  loadMessageBlocks,
  MessageBlockInputError,
  prepareMessageBlocks,
  type StoredMessageBlockRow,
} from "../core/messages/store";
import { sendPushNotification } from "../core/push/apns";
import type { Env } from "../core/types";

interface ArtifactFixture {
  id: string;
  user_id: string;
  title: string;
  favicon: string;
  current_version: number;
  team_id: null;
  sharing: "private";
}

class MockDB {
  artifacts = new Map<string, ArtifactFixture>();
  versions = new Set<string>();
  loadedRows: StoredMessageBlockRow[] = [];
  batches: Array<Array<{ sql: string; binds: unknown[] }>> = [];
  queries: Array<{ sql: string; binds: unknown[] }> = [];

  prepare(sql: string) {
    const db = this;
    return {
      bind(...binds: unknown[]) {
        db.queries.push({ sql, binds });
        const statement = {
          sql,
          binds,
          async first<T>(): Promise<T | null> {
            if (sql.includes("FROM artifacts WHERE id = ?")) {
              return (db.artifacts.get(String(binds[0])) ?? null) as T | null;
            }
            if (sql.includes("FROM artifact_versions")) {
              const key = `${binds[0]}:${binds[1]}`;
              return (db.versions.has(key) ? { version: binds[1] } : null) as T | null;
            }
            return null;
          },
          async all<T>(): Promise<{ results: T[] }> {
            if (sql.includes("AS allowed FROM messages WHERE id=? AND team_id IS ?") && sql.includes("UNION ALL SELECT id,")) {
              if (binds.length !== 8 || binds[0] !== binds[1] || binds[0] !== binds[4] || binds[4] !== binds[5]
                || binds[2] !== binds[6] || binds[3] !== null || binds[7] !== null) throw new Error("Invalid personal artifact access binds");
              // No messages exist at preparation time; only the canonical
              // artifact branch can grant access to this private source.
              const artifact = db.artifacts.get(String(binds[6]));
              return { results: (artifact ? [{ id: artifact.id, allowed: Number(artifact.user_id === binds[4]) }] : []) as T[] };
            }
            if (sql.includes("FROM message_blocks b")) {
              const ids = new Set(binds.map(String));
              return {
                results: db.loadedRows.filter((row) => ids.has(row.message_id)) as T[],
              };
            }
            return { results: [] };
          },
          async run() {
            return { success: true, meta: { changes: 1 } };
          },
        };
        return statement;
      },
    };
  }

  async batch(statements: Array<{ sql: string; binds: unknown[] }>) {
    this.batches.push(statements.map((statement) => ({
      sql: statement.sql,
      binds: statement.binds,
    })));
    return statements.map(() => ({ success: true, meta: { changes: 1 } }));
  }
}

function makeEnv(): Env & { __db: MockDB } {
  const db = new MockDB();
  db.artifacts.set("artifact-1", {
    id: "artifact-1",
    user_id: "owner-1",
    title: "Latency chart",
    favicon: "📊",
    current_version: 4,
    team_id: null,
    sharing: "private",
  });
  db.versions.add("artifact-1:2");
  db.versions.add("artifact-1:4");
  return {
    __db: db,
    DB: db as unknown as D1Database,
    DOCS: {} as R2Bucket,
    SESSIONS: {} as KVNamespace,
    ENHANCE_QUEUE: {} as Queue,
    API_KEY: "test-key",
    OWNER_EMAIL: "owner@example.com",
    APNS_KEY_ID: "",
    APNS_TEAM_ID: "",
    APNS_PRIVATE_KEY: "",
    WORKER_URL: "https://pidgin.example.com",
    ENVIRONMENT: "test",
  };
}

describe("message block preparation", () => {
  it("preserves order, resolves latest once, and derives a readable fallback body", async () => {
    const env = makeEnv();
    const blocks = await prepareMessageBlocks(env, "owner-1", [
      { type: "markdown", markdown: "  First observation.  " },
      {
        type: "artifact",
        artifact_id: "artifact-1",
        label: "P95 latency",
        producer: "visualize",
        producer_action: "show_widget",
        summary: "Latency rises after the deploy.",
      },
      { type: "markdown", markdown: "Second observation." },
    ]);

    expect(env.__db.queries.filter(query => query.sql.includes("AS allowed FROM messages WHERE id=? AND team_id IS ?")))
      .toEqual([{ sql: expect.any(String), binds: ["owner-1", "owner-1", "artifact-1", null, "owner-1", "owner-1", "artifact-1", null] }]);
    expect(blocks.map((block) => block.type)).toEqual(["markdown", "artifact", "markdown"]);
    expect(blocks[1]).toMatchObject({
      artifact_id: "artifact-1",
      version: 4,
      artifact_title_snapshot: "Latency chart",
      artifact_favicon_snapshot: "📊",
    });
    expect(deriveMessageBody(blocks)).toBe(
      "First observation.\n\nP95 latency: Latency rises after the deploy.\n\nSecond observation."
    );
  });

  it("rejects foreign artifacts and missing accessible summaries", async () => {
    const env = makeEnv();
    await expect(
      prepareMessageBlocks(env, "other-owner", [
        { type: "artifact", artifact_id: "artifact-1", summary: "Chart" },
      ])
    ).rejects.toThrow(MessageBlockInputError);
    expect(env.__db.queries).toContainEqual({ sql: expect.stringContaining("AS allowed FROM messages WHERE id=? AND team_id IS ?"),
      binds: ["other-owner", "other-owner", "artifact-1", null, "other-owner", "other-owner", "artifact-1", null] });
    expect(env.__db.batches).toEqual([]);

    await expect(
      prepareMessageBlocks(env, "owner-1", [
        { type: "artifact", artifact_id: "artifact-1", summary: "" },
      ])
    ).rejects.toThrow("summary is required");

    await expect(
      prepareMessageBlocks(env, "owner-1", [
        {
          type: "artifact",
          artifact_id: "artifact-1",
          summary: "Chart",
          collapsed: "true" as unknown as boolean,
        },
      ])
    ).rejects.toThrow("collapsed must be a boolean");
  });
});

describe("composed message persistence", () => {
  beforeEach(() => {
    vi.mocked(sendPushNotification).mockClear();
  });

  it("batches the message, ordered blocks, and audit row before one push", async () => {
    const env = makeEnv();
    const deferred: Promise<unknown>[] = [];
    const result = await createMessage(
      env,
      {
        id: "message-1",
        type: "message",
        title: "Deployment review",
        body: null,
        instance: {
          model: "codex",
          session_id: "session-1",
          project: "pidgin",
          source: "codex",
        },
        userId: "owner-1",
        blocks: [
          { type: "markdown", markdown: "The rollout is healthy." },
          {
            type: "artifact",
            artifact_id: "artifact-1",
            version: 2,
            summary: "A stable error-rate chart.",
          },
        ],
      },
      {
        waitUntil(promise: Promise<unknown>) { deferred.push(promise); },
        passThroughOnException() {},
      } as unknown as ExecutionContext
    );

    expect(result.body).toContain("Latency chart: A stable error-rate chart.");
    expect(env.__db.batches).toHaveLength(1);
    expect(env.__db.batches[0].map((statement) => statement.sql.trim().split(" ")[0])).toEqual([
      "INSERT",
      "INSERT",
      "INSERT",
      "INSERT",
    ]);
    const blockStatements = env.__db.batches[0].filter((statement) =>
      statement.sql.includes("INSERT INTO message_blocks")
    );
    expect(blockStatements.map((statement) => statement.binds[1])).toEqual([0, 1]);
    expect(sendPushNotification).toHaveBeenCalledTimes(1);
    await Promise.allSettled(deferred);
  });
});

describe("message block serialization", () => {
  it("keeps immutable snapshots usable after deletion and reports newer versions", async () => {
    const env = makeEnv();
    env.__db.loadedRows = [
      {
        message_id: "message-1",
        position: 0,
        kind: "artifact",
        markdown: null,
        artifact_id: "artifact-1",
        artifact_version: 2,
        label: null,
        producer: "visualize",
        producer_action: "show_widget",
        summary: "A pinned chart.",
        collapsed: 0,
        artifact_title_snapshot: "Latency chart",
        artifact_favicon_snapshot: "📊",
        artifact_current_version: 4,
        artifact_capabilities: null,
        artifact_exists: 1,
        version_exists: 1,
      },
      {
        message_id: "message-2",
        position: 0,
        kind: "artifact",
        markdown: null,
        artifact_id: "deleted-artifact",
        artifact_version: 1,
        label: null,
        producer: null,
        producer_action: null,
        summary: "The original chart summary remains readable.",
        collapsed: 1,
        artifact_title_snapshot: "Deleted chart",
        artifact_favicon_snapshot: "📉",
        artifact_current_version: null,
        artifact_capabilities: null,
        artifact_exists: 0,
        version_exists: 0,
      },
    ];

    const loaded = await loadMessageBlocks(env, ["message-1", "message-2"]);
    expect(loaded.get("message-1")?.[0]).toMatchObject({
      version: 2,
      latest_version: 4,
      artifact_available: true,
      has_capabilities: false,
    });
    expect(loaded.get("message-2")?.[0]).toMatchObject({
      artifact_title: "Deleted chart",
      artifact_available: false,
      summary: "The original chart summary remains readable.",
    });
  });
});
