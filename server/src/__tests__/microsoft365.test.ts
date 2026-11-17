import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptValue } from "../core/crypto";
import type { Env } from "../core/types";

vi.mock("cloudflare:email", () => ({
  EmailMessage: class EmailMessage {
    constructor(public from: string, public to: string, public raw: string) {}
  },
}));

vi.mock("../core/preview/render", () => ({
  renderPreviewPng: vi.fn().mockResolvedValue(new Uint8Array()),
}));
import type { Microsoft365Config, OneDriveConfig, MessageEnvelope } from "../core/destinations/types";

class MockKV {
  readonly store = new Map<string, string>();
  async get(key: string) { return this.store.get(key) || null; }
  async getWithMetadata(key: string) { return { value: this.store.get(key) || null, metadata: null }; }
  async put(key: string, value: string) { this.store.set(key, value); }
  async delete(key: string) { this.store.delete(key); }
}

class MockDB {
  readonly configs = new Map<string, { value: string; updated_at: string }>();
  prepare(sql: string) {
    const db = this;
    return {
      async run() { return { success: true }; },
      bind(...binds: Array<string>) {
        return {
          async first<T>() {
            if (sql.includes("SELECT value, updated_at FROM destination_configs WHERE name = ?")) {
              return (db.configs.get(binds[0]) || null) as T | null;
            }
            return null;
          },
          async run() {
            if (sql.startsWith("CREATE TABLE") || sql.startsWith("INSERT INTO") || sql.startsWith("DELETE FROM")) {
              if (sql.startsWith("INSERT INTO")) {
                db.configs.set(binds[0], { value: binds[1], updated_at: new Date().toISOString() });
              }
              if (sql.startsWith("DELETE FROM")) {
                db.configs.delete(binds[0]);
              }
              return { success: true };
            }
            throw new Error(`Unsupported SQL: ${sql}`);
          },
        };
      },
    };
  }
}

function encKey(): string {
  return btoa("01234567890123456789012345678901");
}

function makeEnv(overrides: Partial<Env> = {}) {
  const db = new MockDB();
  return {
    env: {
      DB: db as unknown as D1Database,
      DOCS: {} as R2Bucket,
      SESSIONS: new MockKV() as unknown as KVNamespace,
      ENHANCE_QUEUE: { send: async () => {} } as unknown as Env["ENHANCE_QUEUE"],
      API_KEY: "test-key",
      OWNER_EMAIL: "owner@example.com",
      APNS_KEY_ID: "", APNS_TEAM_ID: "", APNS_PRIVATE_KEY: "",
      WORKER_URL: "https://pidgin.example.com",
      ENVIRONMENT: "test",
      M365_ENCRYPTION_KEY: encKey(),
      ...overrides,
    } satisfies Env,
    db,
  };
}

async function seedM365Config(db: MockDB, overrides: Partial<Record<string, boolean>> = {}) {
  const key = encKey();
  const config: Microsoft365Config = {
    tenant_id: "tenant-1",
    client_id: "client-1",
    client_secret: await encryptValue("secret-1", key, "M365_ENCRYPTION_KEY"),
    refresh_token: await encryptValue("refresh-1", key, "M365_ENCRYPTION_KEY"),
    teams_enabled: overrides.teams_enabled ?? true,
    teams_team_id: "team-1",
    teams_channel_id: "channel-1",
    sharepoint_enabled: overrides.sharepoint_enabled ?? true,
    sharepoint_site_id: "site-1",
    sharepoint_drive_id: "sp-drive-1",
    sharepoint_folder: "Pidgin",
    onedrive_enabled: overrides.onedrive_enabled ?? true,
    onedrive_drive_id: "od-drive-1",
    onedrive_folder: "Pidgin",
  };
  db.configs.set("microsoft365", {
    value: JSON.stringify(config),
    updated_at: new Date().toISOString(),
  });
}

function seedLegacyConfig(db: MockDB) {
  const config: OneDriveConfig = {
    tenant_id: "tenant-1",
    client_id: "client-1",
    client_secret: "secret-1",
    refresh_token: "refresh-1",
    drive_id: "od-drive-1",
    folder: "Pidgin",
  };
  db.configs.set("onedrive", {
    value: JSON.stringify(config),
    updated_at: new Date().toISOString(),
  });
}

afterEach(() => { vi.restoreAllMocks(); });

describe("microsoft365Destination.loadConfig", () => {
  it("returns null on cold start (no rows)", async () => {
    const { env } = makeEnv();
    const { microsoft365Destination } = await import("../core/destinations/microsoft365");
    const config = await microsoft365Destination.loadConfig(env);
    expect(config).toBeNull();
  });

  it("loads and decrypts a microsoft365 config row", async () => {
    const { env, db } = makeEnv();
    await seedM365Config(db);
    const { microsoft365Destination } = await import("../core/destinations/microsoft365");
    const config = await microsoft365Destination.loadConfig(env);
    expect(config).not.toBeNull();
    expect(config!.client_secret).toBe("secret-1");
    expect(config!.refresh_token).toBe("refresh-1");
    expect(config!.teams_enabled).toBe(true);
  });

  it("falls back to legacy onedrive row and wraps it", async () => {
    const { env, db } = makeEnv();
    seedLegacyConfig(db);
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { microsoft365Destination } = await import("../core/destinations/microsoft365");
    const config = await microsoft365Destination.loadConfig(env);
    expect(config).not.toBeNull();
    expect(config!.client_secret).toBe("secret-1");
    expect(config!.refresh_token).toBe("refresh-1");
    expect(config!.onedrive_enabled).toBe(true);
    expect(config!.teams_enabled).toBe(false);
    expect(config!.sharepoint_enabled).toBe(false);
    expect(config!.onedrive_drive_id).toBe("od-drive-1");
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("legacy onedrive config"),
    );
  });

  it("returns null when all outputs disabled", async () => {
    const { env, db } = makeEnv();
    await seedM365Config(db, {
      teams_enabled: false,
      sharepoint_enabled: false,
      onedrive_enabled: false,
    });
    const { microsoft365Destination } = await import("../core/destinations/microsoft365");
    const config = await microsoft365Destination.loadConfig(env);
    expect(config).toBeNull();
  });

  it("logs error and returns null when M365_ENCRYPTION_KEY is absent", async () => {
    const { env, db } = makeEnv({ M365_ENCRYPTION_KEY: undefined });
    await seedM365Config(db);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { microsoft365Destination } = await import("../core/destinations/microsoft365");
    const config = await microsoft365Destination.loadConfig(env);
    expect(config).toBeNull();
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("M365_ENCRYPTION_KEY not set")
    );
  });
});

describe("microsoft365Destination.supports", () => {
  it("returns false for status messages", async () => {
    const { microsoft365Destination } = await import("../core/destinations/microsoft365");
    const envelope: MessageEnvelope = {
      id: "msg-1",
      docKey: null,
      createdAt: "2026-03-16T10:00:00Z",
      payload: {
        type: "status",
        title: "heartbeat",
        instance: { model: "claude-opus-4-6", session_id: "s1", project: "test", source: "claude-code" },
      },
    };
    expect(microsoft365Destination.supports(envelope)).toBe(false);
  });

  it("returns true for message type", async () => {
    const { microsoft365Destination } = await import("../core/destinations/microsoft365");
    const envelope: MessageEnvelope = {
      id: "msg-2", docKey: null, createdAt: "2026-03-16T10:00:00Z",
      payload: { type: "message", title: "Update", instance: { model: "claude-opus-4-6", session_id: "s1", project: "test", source: "claude-code" } },
    };
    expect(microsoft365Destination.supports(envelope)).toBe(true);
  });

  it("returns true for document type", async () => {
    const { microsoft365Destination } = await import("../core/destinations/microsoft365");
    const envelope: MessageEnvelope = {
      id: "msg-3", docKey: "docs/msg-3.html", createdAt: "2026-03-16T10:00:00Z",
      payload: { type: "document", title: "Report", instance: { model: "claude-opus-4-6", session_id: "s1", project: "test", source: "claude-code" } },
    };
    expect(microsoft365Destination.supports(envelope)).toBe(true);
  });

  it("returns true for question type", async () => {
    const { microsoft365Destination } = await import("../core/destinations/microsoft365");
    const envelope: MessageEnvelope = {
      id: "msg-4", docKey: null, createdAt: "2026-03-16T10:00:00Z",
      payload: { type: "question", title: "Need input", instance: { model: "claude-opus-4-6", session_id: "s1", project: "test", source: "claude-code" } },
    };
    expect(microsoft365Destination.supports(envelope)).toBe(true);
  });
});

describe("microsoft365Destination.deliver — token exchange", () => {
  it("exchanges refresh token for access token", async () => {
    const { env, db } = makeEnv();
    await seedM365Config(db);
    const { microsoft365Destination } = await import("../core/destinations/microsoft365");
    const config = await microsoft365Destination.loadConfig(env);

    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (typeof url === "string" && url.includes("oauth2/v2.0/token")) {
        return new Response(JSON.stringify({ access_token: "at-123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // OneDrive upload
      return new Response(JSON.stringify({ id: "file-1" }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const envelope: MessageEnvelope = {
      id: "msg-1",
      docKey: null,
      createdAt: "2026-03-16T10:00:00Z",
      payload: {
        type: "message",
        title: "Test message",
        body: "Hello world",
        instance: { model: "claude-opus-4-6", session_id: "s1", project: "test", source: "claude-code" },
      },
    };

    await microsoft365Destination.deliver(env, envelope, config!);

    const tokenCall = fetchMock.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("oauth2/v2.0/token"),
    );
    expect(tokenCall).toBeTruthy();
    const body = String((tokenCall![1] as RequestInit).body);
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh-1");
  });
});

describe("microsoft365Destination.deliver — OneDrive output", () => {
  it("uploads markdown for message type", async () => {
    const { env, db } = makeEnv();
    await seedM365Config(db, { teams_enabled: false, sharepoint_enabled: false });
    const { microsoft365Destination } = await import("../core/destinations/microsoft365");
    const config = await microsoft365Destination.loadConfig(env);

    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (typeof url === "string" && url.includes("oauth2/v2.0/token")) {
        return new Response(JSON.stringify({ access_token: "at-123" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "file-1" }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const envelope: MessageEnvelope = {
      id: "msg-1",
      docKey: null,
      createdAt: "2026-03-16T10:00:00.000Z",
      payload: {
        type: "message",
        title: "Deploy notes",
        body: "Shipped v2.1",
        instance: { model: "claude-opus-4-6", session_id: "s1", project: "myapp", source: "claude-code" },
      },
    };

    const result = await microsoft365Destination.deliver(env, envelope, config!);

    expect(result).toContain("onedrive:");
    expect(result).toContain(".md");

    const uploadCall = fetchMock.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("graph.microsoft.com") && c[0].includes("/content"),
    );
    expect(uploadCall).toBeTruthy();
    const headers = (uploadCall![1] as RequestInit).headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("text/markdown; charset=utf-8");
  });

  it("uploads HTML for document type", async () => {
    const { env, db } = makeEnv();
    await seedM365Config(db, { teams_enabled: false, sharepoint_enabled: false });
    const { microsoft365Destination } = await import("../core/destinations/microsoft365");
    const config = await microsoft365Destination.loadConfig(env);

    const mockR2 = {
      async get(key: string) {
        return { text: async () => "<html><body>Report</body></html>" };
      },
    };
    const envWithR2 = { ...env, DOCS: mockR2 as unknown as R2Bucket };

    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (typeof url === "string" && url.includes("oauth2/v2.0/token")) {
        return new Response(JSON.stringify({ access_token: "at-123" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "file-1" }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const envelope: MessageEnvelope = {
      id: "msg-2",
      docKey: "docs/msg-2.html",
      createdAt: "2026-03-16T10:00:00.000Z",
      payload: {
        type: "document",
        title: "Quarterly report",
        instance: { model: "claude-opus-4-6", session_id: "s1", project: "myapp", source: "claude-code" },
      },
    };

    const result = await microsoft365Destination.deliver(envWithR2, envelope, config!);

    expect(result).toContain("onedrive:");
    expect(result).toContain(".html");

    const uploadCall = fetchMock.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("graph.microsoft.com") && c[0].includes("/content"),
    );
    const headers = (uploadCall![1] as RequestInit).headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("text/html; charset=utf-8");
  });
});

describe("microsoft365Destination.deliver — Teams output", () => {
  it("posts an Adaptive Card with correct attachment wrapping", async () => {
    const { env, db } = makeEnv();
    await seedM365Config(db, { sharepoint_enabled: false, onedrive_enabled: false });
    const { microsoft365Destination } = await import("../core/destinations/microsoft365");
    const config = await microsoft365Destination.loadConfig(env);

    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (typeof url === "string" && url.includes("oauth2/v2.0/token")) {
        return new Response(JSON.stringify({ access_token: "at-123" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "msg-graph-1" }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const envelope: MessageEnvelope = {
      id: "msg-1",
      docKey: null,
      createdAt: "2026-03-16T10:00:00Z",
      payload: {
        type: "message",
        title: "Deploy complete",
        body: "Shipped v2.1 to production",
        priority: "urgent",
        instance: { model: "claude-opus-4-6", session_id: "s1", project: "myapp", source: "claude-code" },
      },
    };

    const result = await microsoft365Destination.deliver(env, envelope, config!);
    expect(result).toContain("teams:");

    const teamsCall = fetchMock.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("/channels/") && c[0].includes("/messages"),
    );
    expect(teamsCall).toBeTruthy();

    const payload = JSON.parse(String((teamsCall![1] as RequestInit).body));

    // Verify attachment wrapping structure
    expect(payload.body.contentType).toBe("html");
    expect(payload.body.content).toContain("<attachment");
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0].contentType).toBe(
      "application/vnd.microsoft.card.adaptive",
    );

    // CRITICAL: content must be a JSON string, not an object
    expect(typeof payload.attachments[0].content).toBe("string");
    const card = JSON.parse(payload.attachments[0].content);
    expect(card.type).toBe("AdaptiveCard");
    expect(card.version).toBe("1.4");

    // Verify card contains expected data
    const cardJson = JSON.stringify(card);
    expect(cardJson).toContain("Deploy complete");
    expect(cardJson).toContain("myapp");
    expect(cardJson).toContain("urgent");
  });

  it("includes document link in card for document type", async () => {
    const { env, db } = makeEnv();
    await seedM365Config(db, { sharepoint_enabled: false, onedrive_enabled: false });
    const { microsoft365Destination } = await import("../core/destinations/microsoft365");
    const config = await microsoft365Destination.loadConfig(env);

    const fetchMock = vi.fn(async (_url?: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ access_token: "at-123", id: "x" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const envelope: MessageEnvelope = {
      id: "doc-1",
      docKey: "docs/doc-1.html",
      createdAt: "2026-03-16T10:00:00Z",
      payload: {
        type: "document",
        title: "Q1 Report",
        instance: { model: "claude-opus-4-6", session_id: "s1", project: "reports", source: "claude-code" },
      },
    };

    await microsoft365Destination.deliver(env, envelope, config!);

    const teamsCall = fetchMock.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("/messages"),
    );
    const payload = JSON.parse(String((teamsCall![1] as RequestInit).body));
    const card = JSON.parse(payload.attachments[0].content);
    const cardJson = JSON.stringify(card);
    expect(cardJson).toContain("pidgin.example.com/docs/doc-1");
  });
});

describe("microsoft365Destination.deliver — SharePoint output", () => {
  it("uploads HTML for document type only", async () => {
    const { env, db } = makeEnv();
    await seedM365Config(db, { teams_enabled: false, onedrive_enabled: false });
    const { microsoft365Destination } = await import("../core/destinations/microsoft365");
    const config = await microsoft365Destination.loadConfig(env);

    const mockR2 = {
      async get() { return { text: async () => "<html><body>Report</body></html>" }; },
    };
    const envWithR2 = { ...env, DOCS: mockR2 as unknown as R2Bucket };

    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (typeof url === "string" && url.includes("oauth2/v2.0/token")) {
        return new Response(JSON.stringify({ access_token: "at-123" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "file-1" }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const envelope: MessageEnvelope = {
      id: "doc-1",
      docKey: "docs/doc-1.html",
      createdAt: "2026-03-16T10:00:00.000Z",
      payload: {
        type: "document",
        title: "Q1 Report",
        instance: { model: "claude-opus-4-6", session_id: "s1", project: "reports", source: "claude-code" },
      },
    };

    const result = await microsoft365Destination.deliver(envWithR2, envelope, config!);
    expect(result).toContain("sharepoint:");
    expect(result).toContain(".html");

    const uploadCall = fetchMock.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("sp-drive-1") && c[0].includes("/content"),
    );
    expect(uploadCall).toBeTruthy();
    const headers = (uploadCall![1] as RequestInit).headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("text/html; charset=utf-8");
  });

  it("does not include SharePoint output for non-document messages", async () => {
    const { env, db } = makeEnv();
    await seedM365Config(db, { teams_enabled: false, onedrive_enabled: false });
    const { microsoft365Destination } = await import("../core/destinations/microsoft365");
    const config = await microsoft365Destination.loadConfig(env);

    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (typeof url === "string" && url.includes("oauth2/v2.0/token")) {
        return new Response(JSON.stringify({ access_token: "at-123" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "file-1" }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const envelope: MessageEnvelope = {
      id: "msg-1",
      docKey: null,
      createdAt: "2026-03-16T10:00:00.000Z",
      payload: {
        type: "message",
        title: "Update",
        body: "Hello",
        instance: { model: "claude-opus-4-6", session_id: "s1", project: "test", source: "claude-code" },
      },
    };

    const result = await microsoft365Destination.deliver(env, envelope, config!);
    expect(result).not.toContain("sharepoint");

    const spCall = fetchMock.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("sp-drive-1"),
    );
    expect(spCall).toBeUndefined();
  });
});

describe("setup validation", () => {
  it("rejects matching sharepoint and onedrive drive IDs", async () => {
    const { env } = makeEnv();

    // Need a valid session
    const sessions = env.SESSIONS as unknown as MockKV;
    await sessions.put("session:test-session", "owner@example.com");

    const body = {
      type: "microsoft365",
      tenant_id: "t1",
      client_id: "c1",
      client_secret: "s1",
      refresh_token: "r1",
      teams_enabled: true,
      teams_team_id: "team-1",
      teams_channel_id: "ch-1",
      sharepoint_enabled: true,
      sharepoint_site_id: "site-1",
      sharepoint_drive_id: "SAME-DRIVE",
      onedrive_enabled: true,
      onedrive_drive_id: "SAME-DRIVE",
    };

    const { handleSetupApi } = await import("../core/routes/setup");
    const request = new Request("https://pidgin.example.com/api/setup", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: "session=test-session",
      },
      body: JSON.stringify(body),
    });

    const response = await handleSetupApi(request, env);
    const data = await response.json() as { ok: boolean; error?: string };
    expect(data.ok).toBe(false);
    expect(data.error).toContain("drive IDs must be different");
  });
});

describe("microsoft365Destination.deliver — fan-out", () => {
  it("runs all three outputs in parallel and reports partial failure", async () => {
    const { env, db } = makeEnv();
    await seedM365Config(db);
    const { microsoft365Destination } = await import("../core/destinations/microsoft365");
    const config = await microsoft365Destination.loadConfig(env);

    const mockR2 = {
      async get() { return { text: async () => "<html>doc</html>" }; },
    };
    const envWithR2 = { ...env, DOCS: mockR2 as unknown as R2Bucket };

    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (typeof url === "string" && url.includes("oauth2/v2.0/token")) {
        return new Response(JSON.stringify({ access_token: "at-123" }), { status: 200 });
      }
      // Teams fails
      if (typeof url === "string" && url.includes("/channels/") && url.includes("/messages")) {
        return new Response("Forbidden", { status: 403 });
      }
      // SharePoint and OneDrive succeed
      return new Response(JSON.stringify({ id: "file-1" }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const envelope: MessageEnvelope = {
      id: "doc-1",
      docKey: "docs/doc-1.html",
      createdAt: "2026-03-16T10:00:00.000Z",
      payload: {
        type: "document",
        title: "Report",
        instance: { model: "claude-opus-4-6", session_id: "s1", project: "test", source: "claude-code" },
      },
    };

    const result = await microsoft365Destination.deliver(envWithR2, envelope, config!);

    // Teams error should be reported but not block others
    expect(result).toContain("error:");
    expect(result).toContain("teams 403");

    // SharePoint and OneDrive should succeed
    expect(result).toContain("sharepoint:");
    expect(result).toContain("onedrive:");
  });
});
