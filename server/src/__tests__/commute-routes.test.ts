import { describe, expect, it } from "vitest";

import {
  handleGetCommuteAudio,
  handleGetCommuteBriefings,
  handleGetCommuteTranscript,
  handleGetLatestCommute,
  handleOpenLatestCommute,
} from "../core/routes/commute";
import { COMMUTE_SOURCE_READ_SQL, type CommuteBriefingListItem } from "../core/commute/store";
import type { Env } from "../core/types";

type StoredBriefing = CommuteBriefingListItem & { user_id: string };

function briefing(overrides: Partial<StoredBriefing> = {}): StoredBriefing {
  return {
    source_message_id: "msg-1",
    title: "Morning Briefing",
    transcript_key: "commute/msg-1.txt",
    audio_key: "commute/msg-1.mp3",
    metadata_key: null,
    provider: "openai",
    voice: "alloy",
    model: "tts-1",
    minutes: 3,
    status: "ready",
    error: null,
    source_type: "document",
    playlist_doc_ids: null,
    transcript_size: 0,
    audio_size: 0,
    metadata_size: 0,
    created_at: "2026-07-25 07:00:00",
    updated_at: "2026-07-25 07:01:00",
    instance_project: "pidgin",
    instance_model: "claude-opus-5",
    user_id: "user-1",
    ...overrides,
  };
}

class MockDB {
  briefings: StoredBriefing[] = [];
  settings = new Map<string, "latest" | "playlist">();
  capturedBinds: unknown[][] = [];

  prepare(sql: string) {
    const db = this;
    return {
      bind: (...binds: unknown[]) => {
        db.capturedBinds.push(binds);
        return {
          async first<T>() {
            return db.first<T>(sql, binds);
          },
          async all<T>() {
            return db.all<T>(sql, binds);
          },
          async run() {
            return { success: true, meta: { changes: 0 } };
          },
        };
      },
      async run() {
        return { success: true, meta: { changes: 0 } };
      },
      async first<T>() {
        return db.first<T>(sql, []);
      },
      async all<T>() {
        return db.all<T>(sql, []);
      },
    };
  }

  async batch(statements: unknown[]) {
    return statements.map(() => ({ success: true, meta: { changes: 0 } }));
  }

  // Personal document ownership only; governed source revocation is covered
  // by real-D1 tests. Playlist fixtures must name readable original documents.
  visible(item: StoredBriefing, userId: string): boolean {
    if (item.user_id !== userId) return false;
    if (item.source_type !== "playlist") return true;
    try {
      const inputs: unknown = JSON.parse(item.playlist_doc_ids ?? "null");
      return Array.isArray(inputs) && inputs.length > 0 && inputs.every(id =>
        typeof id === "string" && this.briefings.some(source => source.source_message_id === id &&
          source.source_type === "document" && source.user_id === userId));
    } catch { return false; }
  }

  first<T>(sql: string, binds: unknown[]): T | null {
    if (sql.includes("FROM commute_briefings cb")) {
      const [id, userId] = binds as string[];
      expect(sql).toContain("m.user_id = ?");
      expect(sql).toContain(COMMUTE_SOURCE_READ_SQL());
      expect(binds).toEqual([id, userId, userId, userId, userId, userId]);
      const row = this.briefings.find(
        (item) => item.source_message_id === id && this.visible(item, userId)
      );
      return (row ?? null) as T | null;
    }

    if (sql.includes("SELECT commute_source FROM user_settings")) {
      const userId = binds[0] as string;
      const source = this.settings.get(userId);
      return (source ? { commute_source: source } : null) as T | null;
    }

    if (sql.includes("SELECT id FROM users WHERE email")) {
      const email = binds[0] as string;
      if (email === "test@example.com") return { id: "user-1" } as T;
      return null;
    }

    if (sql.includes("SELECT id, email FROM users WHERE email")) {
      const email = binds[0] as string;
      if (email === "test@example.com") {
        return { id: "user-1", email: "test@example.com" } as T;
      }
      return null;
    }

    return null;
  }

  all<T>(sql: string, binds: unknown[]): { results: T[] } {
    if (sql.includes("FROM commute_briefings cb")) {
      const userId = binds[0] as string;
      const hasSourceType = sql.includes("cb.source_type = ?");
      const sourceType = hasSourceType ? binds[5] as string : undefined;
      const limit = binds.at(-1) as number;
      expect(sql).toContain("m.user_id = ?");
      expect(sql).toContain(COMMUTE_SOURCE_READ_SQL());
      expect(binds.slice(0, 5)).toEqual([userId, userId, userId, userId, userId]);
      expect(binds).toHaveLength(hasSourceType ? 7 : 6);
      expect(typeof limit).toBe("number");
      const rows = this.briefings
        .filter((item) => this.visible(item, userId))
        .filter((item) => !sourceType || item.source_type === sourceType)
        .slice(0, limit);
      return { results: rows as T[] };
    }

    return { results: [] };
  }
}

class MockR2 {
  reads: string[] = [];
  objects = new Map<string, { body: string; contentType?: string }>();

  // The audio route streams through streamAudioObject: head() for size, get() for the body.
  async head(key: string) {
    this.reads.push(key);
    const entry = this.objects.get(key);
    if (!entry) return null;
    return {
      size: new TextEncoder().encode(entry.body).byteLength,
      httpMetadata: entry.contentType ? { contentType: entry.contentType } : undefined,
    };
  }

  async get(key: string) {
    this.reads.push(key);
    const entry = this.objects.get(key);
    if (!entry) return null;
    return {
      get body() {
        return new Response(entry.body).body;
      },
      async text() {
        return entry.body;
      },
      async arrayBuffer() {
        return new TextEncoder().encode(entry.body).buffer;
      },
      httpMetadata: entry.contentType ? { contentType: entry.contentType } : undefined,
    };
  }
}

class MockKV {
  data = new Map<string, string>();

  async getWithMetadata<M>(key: string): Promise<{ value: string | null; metadata: M | null }> {
    const value = this.data.get(key) ?? null;
    return {
      value,
      metadata: value ? ({ exp: Math.floor(Date.now() / 1000) + 100_000 } as M) : null,
    };
  }

  async put(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
}

function makeEnv(): { env: Env; db: MockDB; r2: MockR2; kv: MockKV } {
  const db = new MockDB();
  const r2 = new MockR2();
  const kv = new MockKV();
  const env = {
    DB: db as unknown as D1Database,
    DOCS: r2 as unknown as R2Bucket,
    SESSIONS: kv as unknown as KVNamespace,
    ENHANCE_QUEUE: {} as Env["ENHANCE_QUEUE"],
    API_KEY: "master-key",
    OWNER_EMAIL: "test@example.com",
    APNS_KEY_ID: "",
    APNS_TEAM_ID: "",
    APNS_PRIVATE_KEY: "",
    WORKER_URL: "https://pidgin.example.com",
    ENVIRONMENT: "test",
  } as Env;
  return { env, db, r2, kv };
}

function apiRequest(path: string, opts: { token?: string | null; accept?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.token !== null) headers.Authorization = `Bearer ${opts.token ?? "master-key"}`;
  if (opts.accept) headers.Accept = opts.accept;
  return new Request(`https://pidgin.example.com${path}`, { headers });
}

describe("commute auth", () => {
  it("1. every API handler rejects missing credentials", async () => {
    const { env } = makeEnv();
    const cases: Array<Promise<Response>> = [
      handleGetCommuteBriefings(apiRequest("/api/commute", { token: null }), env),
      handleGetCommuteTranscript(apiRequest("/api/commute/x/transcript", { token: null }), env, "x"),
      handleGetCommuteAudio(apiRequest("/api/commute/x/audio", { token: null }), env, "x"),
      handleGetLatestCommute(apiRequest("/api/commute/latest", { token: null }), env),
    ];
    for (const response of await Promise.all(cases)) {
      expect(response.status).toBe(401);
    }
  });

  it("2. accepts a session token as an alternative to the API key", async () => {
    const { env, kv, db } = makeEnv();
    kv.data.set("session:tok", "test@example.com");
    db.briefings = [briefing()];
    const response = await handleGetLatestCommute(
      new Request("https://pidgin.example.com/api/commute/latest", {
        headers: { Authorization: "Session tok" },
      }),
      env
    );
    expect(response.status).toBe(200);
  });
});

describe("handleGetCommuteBriefings", () => {
  it("3. clamps the limit param into [1, 100] with 25 as the NaN default", async () => {
    const { env, db } = makeEnv();
    const expectLimitBind = async (query: string, expected: number) => {
      db.capturedBinds = [];
      await handleGetCommuteBriefings(apiRequest(`/api/commute${query}`), env);
      const listBinds = db.capturedBinds.find((binds) => binds.includes(expected));
      expect(listBinds?.at(-1)).toBe(expected);
    };
    await expectLimitBind("", 25);
    await expectLimitBind("?limit=7", 7);
    await expectLimitBind("?limit=500", 100);
    await expectLimitBind("?limit=0", 1);
    await expectLimitBind("?limit=banana", 25);
  });

  it("4. returns briefing list items scoped to the caller", async () => {
    const { env, db } = makeEnv();
    db.briefings = [
      briefing(),
      briefing({ source_message_id: "msg-2", title: "Other User", user_id: "user-2" }),
    ];
    const response = await handleGetCommuteBriefings(apiRequest("/api/commute"), env);
    const body = (await response.json()) as { ok: boolean; data: CommuteBriefingListItem[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].title).toBe("Morning Briefing");
  });

  it("5. can filter by commute source type", async () => {
    const { env, db } = makeEnv();
    db.briefings = [
      briefing(),
      briefing({ source_message_id: "msg-2", title: "Playlist", source_type: "playlist", playlist_doc_ids: JSON.stringify(["msg-1"]) }),
    ];
    const response = await handleGetCommuteBriefings(
      apiRequest("/api/commute?source=playlist"),
      env
    );
    const body = (await response.json()) as { data: CommuteBriefingListItem[] };

    expect(body.data).toHaveLength(1);
    expect(body.data[0].source_type).toBe("playlist");
  });
});

describe("transcript + audio", () => {
  it("denies another user's cached briefing before reading transcript or audio objects", async () => {
    const { env, db, r2 } = makeEnv();
    db.briefings = [briefing({ user_id: "user-2" })];
    r2.objects.set("commute/msg-1.txt", { body: "Foreign transcript" });
    r2.objects.set("commute/msg-1.mp3", { body: "Foreign audio" });
    expect((await handleGetCommuteTranscript(apiRequest("/x"), env, "msg-1")).status).toBe(404);
    expect((await handleGetCommuteAudio(apiRequest("/x"), env, "msg-1")).status).toBe(404);
    expect(r2.reads).toEqual([]);
  });

  it("6. transcript: 404 for unknown briefing and for a missing R2 object; text/plain on hit", async () => {
    const { env, db, r2 } = makeEnv();
    expect(
      (await handleGetCommuteTranscript(apiRequest("/x"), env, "nope")).status
    ).toBe(404);

    db.briefings = [briefing()];
    expect(
      (await handleGetCommuteTranscript(apiRequest("/x"), env, "msg-1")).status
    ).toBe(404);

    r2.objects.set("commute/msg-1.txt", { body: "Good morning, Sam." });
    const hit = await handleGetCommuteTranscript(apiRequest("/x"), env, "msg-1");
    expect(hit.status).toBe(200);
    expect(hit.headers.get("Content-Type")).toContain("text/plain");
    expect(await hit.text()).toBe("Good morning, Sam.");
  });

  it("7. audio: 404 without an audio_key; serves bytes with stored or fallback content-type", async () => {
    const { env, db, r2 } = makeEnv();
    db.briefings = [briefing({ audio_key: null })];
    expect((await handleGetCommuteAudio(apiRequest("/x"), env, "msg-1")).status).toBe(404);

    db.briefings = [briefing()];
    r2.objects.set("commute/msg-1.mp3", { body: "MP3BYTES", contentType: "audio/mp4" });
    const typed = await handleGetCommuteAudio(apiRequest("/x"), env, "msg-1");
    expect(typed.status).toBe(200);
    expect(typed.headers.get("Content-Type")).toBe("audio/mp4");

    r2.objects.set("commute/msg-1.mp3", { body: "MP3BYTES" });
    const fallback = await handleGetCommuteAudio(apiRequest("/x"), env, "msg-1");
    expect(fallback.headers.get("Content-Type")).toBe("audio/mpeg");
  });
});

describe("latest + open-latest", () => {
  it("8. latest: 404 when empty, newest briefing when present", async () => {
    const { env, db } = makeEnv();
    expect((await handleGetLatestCommute(apiRequest("/x"), env)).status).toBe(404);

    db.briefings = [briefing()];
    const response = await handleGetLatestCommute(apiRequest("/x"), env);
    const body = (await response.json()) as { data: CommuteBriefingListItem };
    expect(body.data.source_message_id).toBe("msg-1");
  });

  it("9. latest uses playlist source when the caller prefers it", async () => {
    const { env, db } = makeEnv();
    db.settings.set("user-1", "playlist");
    db.briefings = [
      briefing(),
      briefing({ source_message_id: "msg-2", title: "Playlist", source_type: "playlist", playlist_doc_ids: JSON.stringify(["msg-1"]) }),
    ];

    const response = await handleGetLatestCommute(apiRequest("/x"), env);
    const body = (await response.json()) as { data: CommuteBriefingListItem };

    expect(body.data.source_message_id).toBe("msg-2");
    expect(body.data.source_type).toBe("playlist");
  });

  it("10. open-latest (JSON): 401 unauth, 404 empty, audio target when audio exists", async () => {
    const { env, db } = makeEnv();
    const accept = "application/json";
    expect(
      (await handleOpenLatestCommute(apiRequest("/commute/latest", { token: null, accept }), env))
        .status
    ).toBe(401);
    expect(
      (await handleOpenLatestCommute(apiRequest("/commute/latest", { accept }), env)).status
    ).toBe(404);

    db.briefings = [briefing()];
    const response = await handleOpenLatestCommute(apiRequest("/commute/latest", { accept }), env);
    const body = (await response.json()) as {
      data: {
        target: string;
        kind: string;
        source_message_id: string;
        source_type: string;
      };
    };
    expect(body.data).toEqual({
      source_message_id: "msg-1",
      target: "/api/commute/msg-1/audio",
      kind: "audio",
      source_type: "document",
    });
  });

  it("11. open-latest (JSON): falls back to the transcript target without audio", async () => {
    const { env, db } = makeEnv();
    db.briefings = [briefing({ audio_key: null })];
    const response = await handleOpenLatestCommute(
      apiRequest("/commute/latest", { accept: "application/json" }),
      env
    );
    const body = (await response.json()) as { data: { target: string; kind: string } };
    expect(body.data.kind).toBe("transcript");
    expect(body.data.target).toBe("/api/commute/msg-1/transcript");
  });

  it("12. open-latest (HTML): renders the briefing page with the transcript inlined", async () => {
    const { env, db, r2 } = makeEnv();
    db.briefings = [briefing()];
    r2.objects.set("commute/msg-1.txt", { body: "Trains are on time." });

    const response = await handleOpenLatestCommute(apiRequest("/commute/latest"), env);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(html).toContain("Morning Briefing");
    expect(html).toContain("Trains are on time.");
  });
});
