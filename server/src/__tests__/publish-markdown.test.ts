import { describe, expect, it, vi } from "vitest";
import type { Env } from "../core/types";
import { PublishInputError, parseEnhanceLevel, publishDocument, getDocumentContent } from "../core/documents";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

interface MockDocObject {
  text(): Promise<string>;
}

// Copied verbatim from mcp.test.ts.
class MockR2Bucket {
  private readonly objects = new Map<string, string>();

  async put(key: string, value: string): Promise<void> {
    this.objects.set(key, value);
  }

  async get(key: string): Promise<MockDocObject | null> {
    const value = this.objects.get(key);
    if (!value) return null;
    return {
      async text() {
        return value;
      },
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

type MessageRow = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  doc_key: string | null;
  priority: string;
  public: number;
  doc_slug: string | null;
  doc_version: number | null;
  is_latest: number | null;
  design_system: string | null;
  enhance_status: string | null;
  enhance_level: string | null;
  instance_model: string;
  instance_session_id: string;
  instance_project: string;
  instance_source: string;
  interactive: number;
  team_id: string | null;
  project_id: string | null;
  doc_kind: string;
  user_id: string | null;
  created_at: string;
};

// Records INSERTs into `messages` keyed by the column order of the exact
// publishDocument INSERT in documents.ts (now including team/project and
// doc_kind workspace columns).
// Also serves getDocumentRecord's SELECT (returns the inserted row) and the
// design_systems lookups used by resolveDesignSystem/listDesignSystems
// (returning no rows — builtin resolution happens entirely in code).
class MockDB {
  readonly messages: MessageRow[] = [];
  readonly auditLog: Array<{ action: string; instance_id: string; details: string; user_id: string | null }> = [];

  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    return Promise.all(statements.map((statement) => statement.run()));
  }

  prepare(sql: string) {
    const db = this;
    return {
      bind(...binds: unknown[]) {
        return {
          async run() {
            if (sql.startsWith("INSERT INTO messages")) {
              const [
                id,
                type,
                title,
                body,
                doc_key,
                priority,
                pub,
                doc_slug,
                doc_version,
                is_latest,
                design_system,
                enhance_status,
                enhance_level,
                instance_model,
                instance_session_id,
                instance_project,
                instance_source,
                user_id,
                interactive,
                team_id,
                project_id,
                doc_kind,
              ] = binds as [
                string,
                string,
                string,
                string | null,
                string | null,
                string,
                number,
                string | null,
                number,
                number,
                string | null,
                string | null,
                string | null,
                string,
                string,
                string,
                string,
                string | null,
                number,
                string | null,
                string | null,
                string
              ];
              db.messages.push({
                id,
                type,
                title,
                body,
                doc_key,
                priority,
                public: pub,
                doc_slug,
                doc_version,
                is_latest,
                design_system,
                enhance_status,
                enhance_level,
                instance_model,
                instance_session_id,
                instance_project,
                instance_source,
                team_id,
                project_id,
                doc_kind,
                user_id,
                interactive,
                created_at: new Date().toISOString(),
              });
              return { success: true };
            }
            if (sql.startsWith("INSERT INTO audit_log")) {
              const [action, instance_id, details, user_id] = binds as [string, string, string, string | null];
              db.auditLog.push({ action, instance_id, details, user_id });
              return { success: true };
            }
            if (sql.startsWith("UPDATE messages SET enhance_status = 'failed'")) {
              const [enhance_error, id] = binds as [string, string];
              const row = db.messages.find((m) => m.id === id);
              if (row) {
                row.enhance_status = "failed";
                (row as MessageRow & { enhance_error?: string }).enhance_error = enhance_error;
              }
              return { success: true };
            }
            throw new Error(`Unsupported run() query in test: ${sql}`);
          },
          async first<T>() {
            if (sql.includes("FROM hosted_accounts")) return null as T | null;
            if (sql.includes("FROM messages") && sql.includes("WHERE id = ? AND type = 'document'")) {
              const id = binds[0] as string;
              const row = db.messages.find((m) => m.id === id);
              return (row ?? null) as T | null;
            }
            if (sql.includes("FROM design_systems") && sql.includes("AND name = ?")) {
              // No user-owned design systems in these tests — builtin
              // resolution (pidgin-editorial) happens without touching the DB.
              return null as T | null;
            }
            throw new Error(`Unsupported first() query in test: ${sql}`);
          },
          async all<T>() {
            if (sql.includes("FROM design_systems") || sql.includes("FROM document_audience_preferences p")) {
              return { results: [] as T[] };
            }
            throw new Error(`Unsupported all() query in test: ${sql}`);
          },
        };
      },
    };
  }
}

function makeEnv(overrides: Partial<Env> = {}) {
  const DOCS = new MockR2Bucket();
  const DB = new MockDB();
  const queue = { send: vi.fn().mockResolvedValue(undefined) };
  const env = {
    DB: DB as unknown as Env["DB"],
    DOCS: DOCS as unknown as Env["DOCS"],
    SESSIONS: {} as Env["SESSIONS"],
    ENHANCE_QUEUE: queue as unknown as Env["ENHANCE_QUEUE"],
    API_KEY: "test-key",
    OWNER_EMAIL: "owner@example.com",
    ANTHROPIC_API_KEY: "test",
    APNS_KEY_ID: "",
    APNS_TEAM_ID: "",
    APNS_PRIVATE_KEY: "",
    WORKER_URL: "https://pidgin.example.com",
    ENVIRONMENT: "test",
    ...overrides,
  } satisfies Env;
  return { env, db: DB, docs: DOCS, queue };
}

const userId = "user-1";

// ---------------------------------------------------------------------------
// publishDocument
// ---------------------------------------------------------------------------

describe("publishDocument (markdown)", () => {
  it("1. typesets markdown with the default design system", async () => {
    const { env, db, docs, queue } = makeEnv();

    const result = await publishDocument(env, {
      title: "Hi Doc",
      markdown: "# Hi\n\nBody",
      userId,
    });

    const mdObject = await docs.get(`docs/${result.id}.md`);
    expect(mdObject).not.toBeNull();
    expect(await mdObject!.text()).toBe("# Hi\n\nBody");

    const htmlObject = await docs.get(`docs/${result.id}.html`);
    expect(htmlObject).not.toBeNull();
    expect(await htmlObject!.text()).toContain("--ds-bg: #F6EEDF");

    const row = db.messages.find((m) => m.id === result.id);
    expect(row).toBeDefined();
    expect(row!.doc_slug).toBe(result.id);
    expect(row!.doc_version).toBe(1);
    expect(row!.is_latest).toBe(1);
    expect(row!.design_system).toBe("pidgin-editorial");
    expect(row!.enhance_status).toBeNull();

    expect(queue.send).not.toHaveBeenCalled();
  });

  it("2. enqueues an enhance job and marks enhance_status queued", async () => {
    const { env, db, queue } = makeEnv();

    const result = await publishDocument(env, {
      title: "Research Doc",
      markdown: "# Research\n\nBody",
      enhance: "research",
      instructions: "short",
      userId,
    });

    const row = db.messages.find((m) => m.id === result.id);
    expect(row).toBeDefined();
    expect(row!.enhance_status).toBe("queued");
    expect(row!.enhance_level).toBe("research");

    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(queue.send).toHaveBeenCalledWith({
      kind: "enhance",
      docId: result.id,
      level: "research",
      instructions: "short",
      designSystemName: "pidgin-editorial",
      userId,
    });
  });

  it("2b. queue-send failure records enhance_status=failed instead of failing publish", async () => {
    const { env, db, queue } = makeEnv();
    queue.send.mockRejectedValue(new Error("queue down"));

    const result = await publishDocument(env, {
      title: "Doomed Queue Doc",
      markdown: "# Doomed\n\nBody",
      enhance: "polish",
      userId,
    });

    expect(result.enhance_status).toBe("failed");

    const row = db.messages.find((m) => m.id === result.id);
    expect(row).toBeDefined();
    expect(row!.enhance_status).toBe("failed");
  });

  it("3. rejects when both html and markdown are provided", async () => {
    const { env } = makeEnv();
    const promise = publishDocument(env, {
      title: "Both",
      html: "<p>x</p>",
      markdown: "y",
      userId,
    });
    await expect(promise).rejects.toThrow(PublishInputError);
    await expect(promise).rejects.toThrow(/exactly one/);
  });

  it("4. rejects when neither html nor markdown are provided", async () => {
    const { env } = makeEnv();
    const promise = publishDocument(env, { title: "Neither", userId });
    await expect(promise).rejects.toThrow(PublishInputError);
  });

  it("5. rejects enhance with html input", async () => {
    const { env } = makeEnv();
    const promise = publishDocument(env, {
      title: "Html Enhance",
      html: "<p>x</p>",
      enhance: "polish",
      userId,
    });
    await expect(promise).rejects.toThrow(PublishInputError);
    await expect(promise).rejects.toThrow(/require markdown/);
  });

  it("6. rejects an unknown design system and lists available names", async () => {
    const { env } = makeEnv();
    const promise = publishDocument(env, {
      title: "Ghost DS",
      markdown: "# Ghost\n\nBody",
      designSystem: "ghost",
      userId,
    });
    await expect(promise).rejects.toThrow(PublishInputError);
    await expect(promise).rejects.toThrow(/pidgin-editorial/);
  });

  it("7. rejects enhance when ANTHROPIC_API_KEY is not configured", async () => {
    const { env } = makeEnv({ ANTHROPIC_API_KEY: undefined });
    const promise = publishDocument(env, {
      title: "No Key",
      markdown: "# No Key\n\nBody",
      enhance: "polish",
      userId,
    });
    await expect(promise).rejects.toThrow(PublishInputError);
    await expect(promise).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("8. html passthrough still works (regression guard)", async () => {
    const { env, db, docs, queue } = makeEnv();

    const result = await publishDocument(env, {
      title: "Raw Html",
      html: "<p>x</p>",
      userId,
    });

    const htmlObject = await docs.get(`docs/${result.id}.html`);
    expect(htmlObject).not.toBeNull();
    expect(await htmlObject!.text()).toBe("<p>x</p>");

    const mdObject = await docs.get(`docs/${result.id}.md`);
    expect(mdObject).toBeNull();

    const row = db.messages.find((m) => m.id === result.id);
    expect(row).toBeDefined();
    expect(row!.design_system).toBeNull();
    expect(row!.enhance_status).toBeNull();

    expect(queue.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// parseEnhanceLevel
// ---------------------------------------------------------------------------

describe("parseEnhanceLevel", () => {
  it("9. undefined and 'none' map to null; valid levels pass through; invalid throws", () => {
    expect(parseEnhanceLevel(undefined)).toBeNull();
    expect(parseEnhanceLevel("none")).toBeNull();
    expect(parseEnhanceLevel("polish")).toBe("polish");
    expect(() => parseEnhanceLevel("mega")).toThrow(PublishInputError);
  });
});

// ---------------------------------------------------------------------------
// getDocumentContent with markdown mode
// ---------------------------------------------------------------------------

describe("getDocumentContent (markdown mode)", () => {

  it("10. after publishDocument({ markdown }), getDocumentContent(..., 'markdown', 2000) returns markdown_available + markdown + total_chars", async () => {
    const { env, docs } = makeEnv();

    const result = await publishDocument(env, {
      title: "Hi Doc",
      markdown: "# T\n\nHello **world**",
      userId,
    });

    const content = await getDocumentContent(env, result.id, "markdown", 2000, undefined, userId);
    expect(content).toBeDefined();
    expect(content!.markdown_available).toBe(true);
    expect(content!.markdown).toBe("# T\n\nHello **world**");
    expect(content!.total_chars).toBe(20);
  });

  it("11. after publishDocument({ html }), mode 'markdown' returns markdown_available: false with no markdown field", async () => {
    const { env, docs } = makeEnv();

    const result = await publishDocument(env, {
      title: "Raw Html",
      html: "<p>x</p>",
      userId,
    });

    const content = await getDocumentContent(env, result.id, "markdown", 2000, undefined, userId);
    expect(content).toBeDefined();
    expect(content!.markdown_available).toBe(false);
    expect(content!.markdown).toBeUndefined();
  });

  it("12. markdown mode respects max_chars (long markdown, request 200, expect content_truncated + returned_chars <= 203)", async () => {
    const { env } = makeEnv();

    const longMarkdown = "# Title\n\n" + "x".repeat(500);
    const result = await publishDocument(env, {
      title: "Long Doc",
      markdown: longMarkdown,
      userId,
    });

    const content = await getDocumentContent(env, result.id, "markdown", 200, undefined, userId);
    expect(content).toBeDefined();
    expect(content!.markdown_available).toBe(true);
    expect(content!.content_truncated).toBe(true);
    expect(content!.returned_chars).toBeLessThanOrEqual(203);
    expect(content!.total_chars).toBe(longMarkdown.length);
  });
});
