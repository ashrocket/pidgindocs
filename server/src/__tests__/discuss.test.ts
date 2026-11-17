import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/enhance/anthropic", () => ({
  callAnthropic: vi.fn(async () => "Here is your answer."),
}));

vi.mock("../core/documents", () => ({
  getDocumentContent: vi.fn(),
}));

vi.mock("../core/chat/fanout", () => ({
  fanOutChatMessage: vi.fn(async () => {}),
}));

import { answerDocQuestion } from "../core/chat/discuss";
import { callAnthropic } from "../core/enhance/anthropic";
import { getDocumentContent } from "../core/documents";
import { fanOutChatMessage } from "../core/chat/fanout";
import type { Env } from "../core/types";
import type { Conversation } from "../core/chat/types";

const NOW = "2026-07-25T00:00:00.000Z";

interface MsgRow {
  id: string;
  seq: number;
  conversation_id: string;
  sender: string;
  channel: string | null;
  body: string;
  external_event_id: string | null;
  created_at: string;
}

// Minimal D1 stand-in for the three store calls discuss.ts makes:
// listMessagesAfter, insertChatMessage, touchConversation.
class MockDB {
  messages: MsgRow[] = [];
  nextSeq = 1;

  seedMessage(sender: "user" | "agent" | "system", body: string, conversationId = "conv-1") {
    this.messages.push({
      id: `m${this.nextSeq}`,
      seq: this.nextSeq++,
      conversation_id: conversationId,
      sender,
      channel: null,
      body,
      external_event_id: null,
      created_at: NOW,
    });
  }

  prepare(sql: string) {
    const db = this;
    return {
      bind(...binds: unknown[]) {
        return {
          async run() {
            if (sql.startsWith("INSERT OR IGNORE INTO chat_messages")) {
              const [id, conversationId, sender, channel, body, externalEventId] = binds as (
                | string
                | null
              )[];
              db.messages.push({
                id: id as string,
                seq: db.nextSeq++,
                conversation_id: conversationId as string,
                sender: sender as string,
                channel,
                body: body as string,
                external_event_id: externalEventId,
                created_at: NOW,
              });
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 1 } };
          },
          async first<T>() {
            if (sql.includes("FROM chat_messages WHERE id = ?")) {
              const [id] = binds as string[];
              return (db.messages.find((m) => m.id === id) ?? null) as T;
            }
            return null as T;
          },
          async all<T>() {
            if (sql.includes("FROM chat_messages") && sql.includes("rowid > ?")) {
              const [conversationId, after] = binds as [string, number];
              const limit = binds[binds.length - 1] as number;
              const rows = db.messages
                .filter((m) => m.conversation_id === conversationId && m.seq > after)
                .sort((a, b) => a.seq - b.seq)
                .slice(0, limit);
              return { results: rows } as { results: T[] };
            }
            return { results: [] } as { results: T[] };
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
    SESSIONS: {} as KVNamespace,
    ENHANCE_QUEUE: {} as Env["ENHANCE_QUEUE"],
    API_KEY: "test-key",
    OWNER_EMAIL: "test@example.com",
    APNS_KEY_ID: "",
    APNS_TEAM_ID: "",
    APNS_PRIVATE_KEY: "",
    WORKER_URL: "https://pidgin.example.com",
    ENVIRONMENT: "test",
    ANTHROPIC_API_KEY: "sk-ant-test",
  } as Env;
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-1",
    user_id: "user-1",
    instance_session_id: null,
    instance_project: "proj",
    doc_id: "doc-1",
    title: "Discuss: Q3 Report",
    status: "open",
    last_poll_at: null,
    created_at: NOW,
    last_activity_at: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(callAnthropic).mockReset();
  vi.mocked(callAnthropic).mockResolvedValue("Here is your answer.");
  vi.mocked(getDocumentContent).mockReset();
  vi.mocked(fanOutChatMessage).mockReset();
  vi.mocked(fanOutChatMessage).mockResolvedValue(undefined);
});

describe("answerDocQuestion", () => {
  it("1. answers from markdown source and posts an agent reply without push", async () => {
    const db = new MockDB();
    db.seedMessage("user", "What changed since Q2?");
    const env = makeEnv(db);

    vi.mocked(getDocumentContent).mockResolvedValueOnce({
      id: "doc-1",
      title: "Q3 Report",
      mode: "markdown",
      created_at: NOW,
      project: "proj",
      public: false,
      priority: "normal",
      doc_kind: "doc",
      markdown_available: true,
      markdown: "# Q3\nRevenue up 12%.",
    });

    await answerDocQuestion(env, makeConversation());

    const call = vi.mocked(callAnthropic).mock.calls[0][1];
    expect(call.user).toContain("Revenue up 12%");
    expect(call.user).toContain("User: What changed since Q2?");
    expect(call.system).toContain("document assistant");

    const reply = db.messages.find((m) => m.sender === "agent");
    expect(reply?.body).toBe("Here is your answer.");

    expect(fanOutChatMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fanOutChatMessage).mock.calls[0][3]).toEqual({ push: false });
  });

  it("2. falls back to extracted text when markdown is unavailable", async () => {
    const db = new MockDB();
    db.seedMessage("user", "Summarize this");
    const env = makeEnv(db);

    vi.mocked(getDocumentContent)
      .mockResolvedValueOnce({
        id: "doc-1",
        title: "Legacy Doc",
        mode: "markdown",
        created_at: NOW,
        project: "proj",
        public: false,
        priority: "normal",
        doc_kind: "doc",
        markdown_available: false,
      })
      .mockResolvedValueOnce({
        id: "doc-1",
        title: "Legacy Doc",
        mode: "full",
        created_at: NOW,
        project: "proj",
        public: false,
        priority: "normal",
        doc_kind: "doc",
        text: "Plain text from HTML.",
      });

    await answerDocQuestion(env, makeConversation());

    expect(vi.mocked(getDocumentContent).mock.calls[1][2]).toBe("full");
    expect(vi.mocked(callAnthropic).mock.calls[0][1].user).toContain("Plain text from HTML.");
    expect(db.messages.some((m) => m.sender === "agent")).toBe(true);
  });

  it("3. posts a system row when the model call fails (question is never silently dropped)", async () => {
    const db = new MockDB();
    db.seedMessage("user", "Anyone home?");
    const env = makeEnv(db);

    vi.mocked(getDocumentContent).mockResolvedValueOnce({
      id: "doc-1",
      title: "Q3 Report",
      mode: "markdown",
      created_at: NOW,
      project: "proj",
      public: false,
      priority: "normal",
      doc_kind: "doc",
      markdown_available: true,
      markdown: "content",
    });
    vi.mocked(callAnthropic).mockRejectedValueOnce(new Error("Anthropic API error 529"));

    await answerDocQuestion(env, makeConversation());

    const fallback = db.messages.find((m) => m.sender === "system");
    expect(fallback?.body).toContain("couldn't generate an answer");
    expect(db.messages.some((m) => m.sender === "agent")).toBe(false);
  });

  it("4. posts a system row when the document content is gone", async () => {
    const db = new MockDB();
    db.seedMessage("user", "Where did it go?");
    const env = makeEnv(db);

    vi.mocked(getDocumentContent).mockResolvedValue(null);

    await answerDocQuestion(env, makeConversation());

    expect(callAnthropic).not.toHaveBeenCalled();
    const fallback = db.messages.find((m) => m.sender === "system");
    expect(fallback?.body).toContain("no longer available");
  });

  it("5. is a no-op for conversations without a doc link", async () => {
    const db = new MockDB();
    const env = makeEnv(db);

    await answerDocQuestion(env, makeConversation({ doc_id: null }));

    expect(getDocumentContent).not.toHaveBeenCalled();
    expect(callAnthropic).not.toHaveBeenCalled();
    expect(db.messages).toHaveLength(0);
  });

  it("6. caps history at the last 20 non-system turns", async () => {
    const db = new MockDB();
    for (let i = 1; i <= 30; i++) db.seedMessage("user", `Question ${i}`);
    db.seedMessage("system", "noise");
    const env = makeEnv(db);

    vi.mocked(getDocumentContent).mockResolvedValueOnce({
      id: "doc-1",
      title: "Q3 Report",
      mode: "markdown",
      created_at: NOW,
      project: "proj",
      public: false,
      priority: "normal",
      doc_kind: "doc",
      markdown_available: true,
      markdown: "content",
    });

    await answerDocQuestion(env, makeConversation());

    const prompt = vi.mocked(callAnthropic).mock.calls[0][1].user;
    expect(prompt).not.toContain("Question 10");
    expect(prompt).toContain("Question 11");
    expect(prompt).toContain("Question 30");
    expect(prompt).not.toContain("noise");
  });
});
