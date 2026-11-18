import { beforeEach, describe, expect, it, vi } from "vitest";

// ingest.ts's only external side-effect (besides D1) is the echo fan-out.
// Mocking the whole module keeps this file from pulling in push/apns,
// gchat.ts, and destinations/store — none of which matter for these tests.
vi.mock("../core/chat/fanout", () => ({
  fanOutChatMessage: vi.fn(async () => {}),
}));

import { ingestUserMessage } from "../core/chat/ingest";
import { listMessagesAfter } from "../core/chat/store";
import { fanOutChatMessage } from "../core/chat/fanout";
import type { Env } from "../core/types";
import type { ChatMessageRow, Conversation } from "../core/chat/types";

// ---------------------------------------------------------------------------
// MockDB — matches SQL substrings the way messages.test.ts / isolation.test.ts
// do. Keyed lookups (`conversationsById`, `channelBindings`) stand in for the
// conversations / conversation_channels tables; `insertChanges` controls
// chat_messages' INSERT OR IGNORE dedupe outcome.
// ---------------------------------------------------------------------------
class MockDB {
  capturedSql: string[] = [];
  capturedBinds: any[][] = [];

  conversationsById: Record<string, Conversation> = {};
  // key: `${channel}|${externalId}` -> conversation id
  channelBindings: Record<string, string> = {};

  insertChanges = 1;
  insertedMessage: ChatMessageRow | null = null;

  auditInserts: Array<{ sql: string; binds: any[] }> = [];
  touchCalls: Array<{ sql: string; binds: any[] }> = [];

  prepare(sql: string) {
    const db = this;
    return {
      bind(...binds: any[]) {
        db.capturedSql.push(sql);
        db.capturedBinds.push(binds);
        return {
          async run() {
            if (sql.startsWith("INSERT INTO chat_messages")) {
              return { success: true, meta: { changes: db.insertChanges } };
            }
            if (sql.startsWith("INSERT INTO audit_log")) {
              db.auditInserts.push({ sql, binds });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.startsWith("UPDATE conversations SET last_activity_at")) {
              db.touchCalls.push({ sql, binds });
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 1 } };
          },
          async first() {
            if (sql.includes("FROM conversations c") && sql.includes("JOIN conversation_channels")) {
              const [channel, externalId] = binds;
              const convId = db.channelBindings[`${channel}|${externalId}`];
              return convId ? db.conversationsById[convId] ?? null : null;
            }
            if (sql.includes("FROM conversations WHERE id = ?")) {
              const id = binds[0];
              return db.conversationsById[id] ?? null;
            }
            if (sql.includes("FROM chat_messages WHERE id = ?")) {
              return db.insertedMessage;
            }
            return null;
          },
          async all() {
            return { results: [] };
          },
        };
      },
      async run() {
        db.capturedSql.push(sql);
        db.capturedBinds.push([]);
        return { success: true, meta: { changes: 1 } };
      },
      async first() {
        return null;
      },
      async all() {
        return { results: [] };
      },
    };
  }
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: new MockDB() as unknown as D1Database,
    DOCS: {} as R2Bucket,
    SESSIONS: {} as KVNamespace,
    ENHANCE_QUEUE: { send: vi.fn() } as unknown as Env["ENHANCE_QUEUE"],
    API_KEY: "test-key",
    OWNER_EMAIL: "test@example.com",
    APNS_KEY_ID: "",
    APNS_TEAM_ID: "",
    APNS_PRIVATE_KEY: "",
    WORKER_URL: "https://pidgin.example.com",
    ENVIRONMENT: "test",
    ...overrides,
  };
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-1",
    user_id: "user-1",
    instance_session_id: "sess-1",
    instance_project: "proj",
    doc_id: null,
    title: "Test Conversation",
    status: "open",
    last_poll_at: null,
    created_at: "2026-07-01T00:00:00Z",
    last_activity_at: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

function makeMessageRow(overrides: Partial<ChatMessageRow> = {}): ChatMessageRow {
  return {
    id: "msg-1",
    seq: 1,
    conversation_id: "conv-1",
    sender: "user",
    channel: "ios",
    body: "hello",
    external_event_id: null,
    created_at: "2026-07-01T00:00:01Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(fanOutChatMessage).mockClear();
  vi.mocked(fanOutChatMessage).mockResolvedValue(undefined);
});

describe("ingestUserMessage — stored", () => {
  it("stores a user message into an open conversation located by conversationId", async () => {
    const db = new MockDB();
    const conversation = makeConversation();
    db.conversationsById[conversation.id] = conversation;
    const message = makeMessageRow();
    db.insertedMessage = message;
    const env = makeEnv({ DB: db as unknown as D1Database });

    const outcome = await ingestUserMessage(env, {
      channel: "ios",
      conversationId: "conv-1",
      senderIdentity: "user@example.com",
      body: "hi there",
    });

    expect(outcome.result).toBe("stored");
    expect(outcome.conversation).toEqual(conversation);
    expect(outcome.message).toEqual(message);

    // audit_log INSERT captured
    expect(db.auditInserts).toHaveLength(1);
    expect(db.auditInserts[0].sql).toContain("INSERT INTO audit_log");
    expect(db.auditInserts[0].binds).toEqual([
      "chat_ingest",
      conversation.instance_session_id,
      `user@example.com replied via ios in "${conversation.title}"`,
      conversation.user_id,
    ]);

    // last_activity touch captured
    expect(db.touchCalls).toHaveLength(1);
    expect(db.touchCalls[0].binds).toEqual([conversation.id]);
  });

  it("fans out the echo excluding the origin channel, without a push", async () => {
    const db = new MockDB();
    const conversation = makeConversation();
    db.conversationsById[conversation.id] = conversation;
    const message = makeMessageRow();
    db.insertedMessage = message;
    const env = makeEnv({ DB: db as unknown as D1Database });

    await ingestUserMessage(env, {
      channel: "ios",
      conversationId: "conv-1",
      senderIdentity: "user@example.com",
      body: "hi there",
    });

    expect(fanOutChatMessage).toHaveBeenCalledTimes(1);
    expect(fanOutChatMessage).toHaveBeenCalledWith(env, conversation, message, {
      excludeChannel: "ios",
      push: false,
    });
  });
});

describe("ingestUserMessage — dedupe", () => {
  it("returns duplicate when the chat_messages insert reports changes = 0, with no audit/echo", async () => {
    const db = new MockDB();
    const conversation = makeConversation();
    db.conversationsById[conversation.id] = conversation;
    db.insertChanges = 0; // simulate INSERT OR IGNORE no-op (redelivery)
    const env = makeEnv({ DB: db as unknown as D1Database });

    const outcome = await ingestUserMessage(env, {
      channel: "gchat",
      conversationId: "conv-1",
      externalEventId: "spaces/x/messages/dup-1",
      senderIdentity: "users/123",
      body: "hi again",
    });

    expect(outcome.result).toBe("duplicate");
    expect(outcome.conversation).toEqual(conversation);
    expect(outcome.message).toBeUndefined();

    expect(db.auditInserts).toHaveLength(0);
    expect(db.touchCalls).toHaveLength(0);
    expect(fanOutChatMessage).not.toHaveBeenCalled();
  });
});

describe("ingestUserMessage — unknown_conversation", () => {
  it("returns unknown_conversation when the conversationId lookup finds nothing", async () => {
    const db = new MockDB();
    const env = makeEnv({ DB: db as unknown as D1Database });

    const outcome = await ingestUserMessage(env, {
      channel: "ios",
      conversationId: "does-not-exist",
      senderIdentity: "user@example.com",
      body: "hi",
    });

    expect(outcome.result).toBe("unknown_conversation");
    expect(outcome.conversation).toBeUndefined();
    expect(fanOutChatMessage).not.toHaveBeenCalled();
    // No insert attempted against an unresolved conversation.
    expect(db.capturedSql.some((s) => s.startsWith("INSERT INTO chat_messages"))).toBe(false);
  });

  it("returns unknown_conversation when the externalConversationId JOIN lookup finds nothing", async () => {
    const db = new MockDB();
    // channelBindings intentionally left empty -> JOIN misses.
    const env = makeEnv({ DB: db as unknown as D1Database });

    const outcome = await ingestUserMessage(env, {
      channel: "gchat",
      externalConversationId: "spaces/unknown/threads/1",
      senderIdentity: "users/123",
      body: "hi",
    });

    expect(outcome.result).toBe("unknown_conversation");
    expect(fanOutChatMessage).not.toHaveBeenCalled();
    const joinSql = db.capturedSql.find(
      (s) => s.includes("FROM conversations c") && s.includes("JOIN conversation_channels")
    );
    expect(joinSql).toBeDefined();
  });
});

describe("ingestUserMessage — conversation_closed", () => {
  it("returns conversation_closed and never attempts the insert", async () => {
    const db = new MockDB();
    const conversation = makeConversation({ status: "closed" });
    db.conversationsById[conversation.id] = conversation;
    const env = makeEnv({ DB: db as unknown as D1Database });

    const outcome = await ingestUserMessage(env, {
      channel: "web",
      conversationId: conversation.id,
      senderIdentity: "user@example.com",
      body: "hi",
    });

    expect(outcome.result).toBe("conversation_closed");
    expect(outcome.conversation).toEqual(conversation);
    expect(db.capturedSql.some((s) => s.startsWith("INSERT INTO chat_messages"))).toBe(false);
    expect(db.auditInserts).toHaveLength(0);
    expect(db.touchCalls).toHaveLength(0);
    expect(fanOutChatMessage).not.toHaveBeenCalled();
  });
});

describe("store.listMessagesAfter", () => {
  it("builds SQL with rowid > ? and no sender filter when senders are omitted", async () => {
    const db = new MockDB();
    const env = makeEnv({ DB: db as unknown as D1Database });

    await listMessagesAfter(env, "conv-1", 42);

    const sql = db.capturedSql.find((s) => s.startsWith("SELECT") && s.includes("FROM chat_messages"));
    expect(sql).toContain("rowid > ?");
    expect(sql).not.toContain("sender IN");
    const binds = db.capturedBinds.find((_, i) => db.capturedSql[i] === sql);
    // conversationId, afterSeq, limit (default 100) — no senders spliced in.
    expect(binds).toEqual(["conv-1", 42, 100]);
  });

  it("adds a sender IN (...) filter and splices the sender binds when senders are passed", async () => {
    const db = new MockDB();
    const env = makeEnv({ DB: db as unknown as D1Database });

    await listMessagesAfter(env, "conv-1", 7, { senders: ["agent", "system"], limit: 25 });

    const sql = db.capturedSql.find((s) => s.startsWith("SELECT") && s.includes("FROM chat_messages"));
    expect(sql).toContain("rowid > ?");
    expect(sql).toContain("sender IN (?, ?)");
    const binds = db.capturedBinds.find((_, i) => db.capturedSql[i] === sql);
    expect(binds).toEqual(["conv-1", 7, "agent", "system", 25]);
  });
});
