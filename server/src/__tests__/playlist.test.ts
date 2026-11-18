import { beforeEach, describe, expect, it } from "vitest";

import {
  addToPlaylist,
  clearPlaylist,
  getCommuteSource,
  listPlaylistItems,
  removeFromPlaylist,
  setCommuteSource,
  setPlaylist,
} from "../core/commute/playlist";
import { generatePlaylistBriefing } from "../core/commute/playlist-briefing";
import { handleGetPlaylist, handleSetPlaylist } from "../core/routes/playlist";
import type { Env } from "../core/types";

interface TableRow {
  [key: string]: string | number | null;
}

class InMemoryDB {
  tables: Record<string, TableRow[]> = {
    messages: [
      {
        id: "doc-1",
        type: "document",
        title: "Report Alpha",
        body: "Body of alpha",
        doc_key: "docs/doc-1.html",
        user_id: "user-1",
        instance_project: "test",
        instance_model: "gpt-4",
        created_at: "2026-07-01T00:00:00Z",
      },
      {
        id: "doc-2",
        type: "document",
        title: "Report Beta",
        body: "Body of beta",
        doc_key: "docs/doc-2.html",
        user_id: "user-1",
        instance_project: "test",
        instance_model: "gpt-4",
        created_at: "2026-07-02T00:00:00Z",
      },
      {
        id: "doc-3",
        type: "document",
        title: "Other User Doc",
        body: "Body of other",
        doc_key: "docs/doc-3.html",
        user_id: "user-2",
        instance_project: "test",
        instance_model: "gpt-4",
        created_at: "2026-07-03T00:00:00Z",
      },
      {
        id: "msg-1",
        type: "message",
        title: "Not a Document",
        body: "Body",
        doc_key: null,
        user_id: "user-1",
        instance_project: "test",
        instance_model: "gpt-4",
        created_at: "2026-07-04T00:00:00Z",
      },
    ],
    commute_playlist_items: [],
    commute_briefings: [],
    destination_configs: [
      {
        name: "commute",
        value: JSON.stringify({ minutes: 2, tts_provider: "openai" }),
        updated_at: "2026-07-05T00:00:00Z",
      },
    ],
    user_settings: [],
    users: [
      { id: "user-1", email: "alice@example.com", status: "active" },
      { id: "user-2", email: "bob@example.com", status: "active" },
    ],
  };

  prepare(sql: string) {
    const db = this;
    return {
      bind(...binds: unknown[]) {
        return {
          async run() {
            return db.executeSql(sql, binds);
          },
          async first<T>(): Promise<T | null> {
            const result = db.executeSql(sql, binds);
            return (result.results?.[0] as T) ?? null;
          },
          async all<T>() {
            return db.executeSql(sql, binds) as unknown as { results: T[] };
          },
        };
      },
      async run() {
        return db.executeSql(sql, []);
      },
      async first<T>(): Promise<T | null> {
        const result = db.executeSql(sql, []);
        return (result.results?.[0] as T) ?? null;
      },
      async all<T>() {
        return db.executeSql(sql, []) as unknown as { results: T[] };
      },
    };
  }

  batch(statements: unknown[]) {
    return Promise.all(
      (statements as Array<{ run: () => Promise<unknown> }>).map((stmt) => stmt.run())
    );
  }

  executeSql(
    sql: string,
    binds: unknown[]
  ): { results: TableRow[]; success: boolean; meta: { changes: number } } {
    const trimmed = sql.trim();

    if (trimmed.startsWith("CREATE TABLE") || trimmed.startsWith("CREATE INDEX")) {
      return { results: [], success: true, meta: { changes: 0 } };
    }

    if (trimmed.startsWith("INSERT INTO commute_playlist_items")) {
      const userId = binds[0] as string;
      const messageId = binds[1] as string;
      const position = binds[2] as number;
      const table = this.tables.commute_playlist_items;
      const existing = table.findIndex(
        (row) => row.user_id === userId && row.message_id === messageId
      );
      if (existing >= 0) {
        table[existing].position = position;
        table[existing].created_at = new Date().toISOString();
      } else {
        table.push({
          user_id: userId,
          message_id: messageId,
          position,
          created_at: new Date().toISOString(),
        });
      }
      return { results: [], success: true, meta: { changes: 1 } };
    }

    if (trimmed.startsWith("INSERT INTO user_settings")) {
      const userId = binds[0] as string;
      const source = binds[1] as string;
      const table = this.tables.user_settings;
      const existing = table.findIndex((row) => row.user_id === userId);
      if (existing >= 0) {
        table[existing].commute_source = source;
        table[existing].updated_at = new Date().toISOString();
      } else {
        table.push({
          user_id: userId,
          commute_source: source,
          updated_at: new Date().toISOString(),
        });
      }
      return { results: [], success: true, meta: { changes: 1 } };
    }

    if (trimmed.startsWith("DELETE FROM commute_playlist_items")) {
      const table = this.tables.commute_playlist_items;
      if (trimmed.includes("AND message_id")) {
        const userId = binds[0] as string;
        const messageId = binds[1] as string;
        const before = table.length;
        this.tables.commute_playlist_items = table.filter(
          (row) => !(row.user_id === userId && row.message_id === messageId)
        );
        return {
          results: [],
          success: true,
          meta: { changes: before - this.tables.commute_playlist_items.length },
        };
      }

      const userId = binds[0] as string;
      const before = table.length;
      this.tables.commute_playlist_items = table.filter(
        (row) => row.user_id !== userId
      );
      return {
        results: [],
        success: true,
        meta: { changes: before - this.tables.commute_playlist_items.length },
      };
    }

    if (trimmed.includes("MAX(position)")) {
      const userId = binds[0] as string;
      const userItems = this.tables.commute_playlist_items.filter(
        (row) => row.user_id === userId
      );
      const maxPos = userItems.length
        ? Math.max(...userItems.map((row) => row.position as number))
        : null;
      return { results: [{ max_pos: maxPos }], success: true, meta: { changes: 0 } };
    }

    if (trimmed.includes("SELECT message_id FROM commute_playlist_items")) {
      const userId = binds[0] as string;
      const items = this.tables.commute_playlist_items
        .filter((row) => row.user_id === userId)
        .sort((a, b) => (a.position as number) - (b.position as number));
      return { results: items, success: true, meta: { changes: 0 } };
    }

    if (trimmed.startsWith("UPDATE commute_playlist_items SET position")) {
      const position = binds[0] as number;
      const userId = binds[1] as string;
      const messageId = binds[2] as string;
      const item = this.tables.commute_playlist_items.find(
        (row) => row.user_id === userId && row.message_id === messageId
      );
      if (item) item.position = position;
      return { results: [], success: true, meta: { changes: item ? 1 : 0 } };
    }

    if (trimmed.startsWith("SELECT value, updated_at FROM destination_configs")) {
      const name = binds[0] as string;
      const row = this.tables.destination_configs.find((entry) => entry.name === name);
      return { results: row ? [row] : [], success: true, meta: { changes: 0 } };
    }

    if (trimmed.startsWith("SELECT id FROM users WHERE email")) {
      const email = binds[0] as string;
      const row = this.tables.users.find(
        (user) => user.email === email && user.status === "active"
      );
      return { results: row ? [{ id: row.id }] : [], success: true, meta: { changes: 0 } };
    }

    if (trimmed.startsWith("SELECT doc_key FROM messages")) {
      const messageId = binds[0] as string;
      const userId = binds[1] as string;
      const row = this.tables.messages.find(
        (message) =>
          message.id === messageId &&
          message.type === "document" &&
          message.user_id === userId
      );
      return {
        results: row ? [{ doc_key: row.doc_key }] : [],
        success: true,
        meta: { changes: 0 },
      };
    }

    if (trimmed.startsWith("SELECT id FROM messages")) {
      if (trimmed.includes("WHERE id = ?")) {
        const messageId = binds[0] as string;
        const userId = binds[1] as string;
        const found = this.tables.messages.filter(
          (row) => row.id === messageId && row.type === "document" && row.user_id === userId
        );
        return {
          results: found.map((row) => ({ id: row.id })),
          success: true,
          meta: { changes: 0 },
        };
      }

      const userId = binds[binds.length - 1] as string;
      const ids = binds.slice(0, -1) as string[];
      const found = this.tables.messages.filter(
        (row) =>
          ids.includes(row.id as string) &&
          row.type === "document" &&
          row.user_id === userId
      );
      return {
        results: found.map((row) => ({ id: row.id })),
        success: true,
        meta: { changes: 0 },
      };
    }

    if (trimmed.includes("SELECT commute_source")) {
      const userId = binds[0] as string;
      const row = this.tables.user_settings.find((entry) => entry.user_id === userId);
      return { results: row ? [row] : [], success: true, meta: { changes: 0 } };
    }

    if (trimmed.includes("FROM commute_playlist_items p")) {
      const userId = binds[0] as string;
      const items = this.tables.commute_playlist_items
        .filter((row) => row.user_id === userId)
        .sort((a, b) => (a.position as number) - (b.position as number))
        .map((playlistItem) => {
          const message = this.tables.messages.find(
            (row) => row.id === playlistItem.message_id
          );
          return {
            message_id: playlistItem.message_id,
            title: message?.title || "",
            position: playlistItem.position,
            instance_project: message?.instance_project || "",
            instance_model: message?.instance_model || "",
            created_at: message?.created_at || "",
            playlist_added_at: playlistItem.created_at,
          };
        });
      return { results: items, success: true, meta: { changes: 0 } };
    }

    if (trimmed.includes("FROM commute_briefings cb") && trimmed.includes("JOIN messages m")) {
      // This fixture contains personal documents. Validate the source, owner,
      // and both central predicates instead of returning an arbitrary briefing.
      const [sourceId, userId, ...identities] = binds;
      if (binds.length !== 6 || identities.some(identity => identity !== userId)) {
        throw new Error("Invalid briefing access binds");
      }
      const briefing = this.tables.commute_briefings.find(row => row.source_message_id === sourceId);
      const source = this.tables.messages.find(row => row.id === sourceId && row.user_id === userId);
      const inputs = briefing?.source_type === "playlist" ? JSON.parse(String(briefing.playlist_doc_ids)) : [];
      const readableInputs = briefing?.source_type !== "playlist" || (Array.isArray(inputs) && inputs.length > 0 &&
        inputs.every(id => this.tables.messages.some(row => row.id === id && row.type === "document" && row.user_id === userId)));
      return { results: briefing && source && readableInputs ? [{ ...briefing,
        instance_project: source.instance_project, instance_model: source.instance_model }] : [],
        success: true, meta: { changes: 0 } };
    }

    if (trimmed.startsWith("INSERT INTO messages")) {
      this.tables.messages.push({
        id: binds[0] as string,
        type: binds[1] as string,
        title: binds[2] as string,
        body: binds[3] as string | null,
        doc_key: binds[4] as string | null,
        priority: binds[5] as string,
        public: binds[6] as number,
        instance_model: binds[13] as string,
        instance_session_id: binds[14] as string,
        instance_project: binds[15] as string,
        instance_source: binds[16] as string,
        user_id: binds[18] as string,
        created_at: new Date().toISOString(),
      });
      return { results: [], success: true, meta: { changes: 1 } };
    }

    if (trimmed.startsWith("INSERT INTO commute_briefings")) {
      this.tables.commute_briefings.push({
        source_message_id: binds[0] as string,
        title: binds[1] as string,
        transcript_key: binds[2] as string,
        audio_key: binds[3] as string | null,
        metadata_key: binds[4] as string | null,
        provider: binds[5] as string,
        voice: binds[6] as string | null,
        model: binds[7] as string | null,
        minutes: binds[8] as number,
        status: binds[9] as string,
        error: binds[10] as string | null,
        source_type: binds[11] as string,
        playlist_doc_ids: binds[12] as string | null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      return { results: [], success: true, meta: { changes: 1 } };
    }

    return { results: [], success: true, meta: { changes: 0 } };
  }
}

class MockR2 {
  objects = new Map<string, { body: string | ArrayBuffer; contentType?: string }>();

  async get(key: string) {
    const entry = this.objects.get(key);
    if (!entry) return null;
    return {
      async text() {
        return typeof entry.body === "string"
          ? entry.body
          : new TextDecoder().decode(entry.body);
      },
    };
  }

  async put(
    key: string,
    value: string | ArrayBuffer,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<void> {
    this.objects.set(key, {
      body: value,
      contentType: options?.httpMetadata?.contentType,
    });
  }
}

class MockKV {
  data = new Map<string, string>();

  async getWithMetadata<M>(
    key: string
  ): Promise<{ value: string | null; metadata: M | null }> {
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

function makeEnv(db: InMemoryDB, kv = new MockKV(), docs = new MockR2()): Env {
  return {
    DB: db as unknown as D1Database,
    DOCS: docs as unknown as R2Bucket,
    SESSIONS: kv as unknown as KVNamespace,
    ENHANCE_QUEUE: { send: async () => {} } as unknown as Env["ENHANCE_QUEUE"],
    API_KEY: "test-key",
    OWNER_EMAIL: "alice@example.com",
    APNS_KEY_ID: "",
    APNS_TEAM_ID: "",
    APNS_PRIVATE_KEY: "",
    WORKER_URL: "https://pidgin.example.com",
    ENVIRONMENT: "test",
  };
}

function sessionRequest(path: string, body?: unknown): Request {
  const init: RequestInit = {
    headers: { Authorization: "Session tok" },
  };
  if (body !== undefined) {
    init.method = "POST";
    init.headers = {
      Authorization: "Session tok",
      "Content-Type": "application/json",
    };
    init.body = JSON.stringify(body);
  }
  return new Request(`https://pidgin.example.com${path}`, init);
}

describe("Playlist CRUD", () => {
  let db: InMemoryDB;
  let env: Env;

  beforeEach(() => {
    db = new InMemoryDB();
    env = makeEnv(db);
  });

  it("starts with an empty playlist", async () => {
    const items = await listPlaylistItems(env, "user-1");
    expect(items).toEqual([]);
  });

  it("adds documents in order", async () => {
    await addToPlaylist(env, "user-1", "doc-1");
    await addToPlaylist(env, "user-1", "doc-2");
    const items = await listPlaylistItems(env, "user-1");

    expect(items.map((item) => item.message_id)).toEqual(["doc-1", "doc-2"]);
    expect(items.map((item) => item.position)).toEqual([0, 1]);
  });

  it("rejects missing, non-document, and foreign documents", async () => {
    await expect(addToPlaylist(env, "user-1", "no-such-doc")).rejects.toThrow(
      "document not found or does not belong to you"
    );
    await expect(addToPlaylist(env, "user-1", "msg-1")).rejects.toThrow(
      "document not found or does not belong to you"
    );
    await expect(addToPlaylist(env, "user-1", "doc-3")).rejects.toThrow(
      "document not found or does not belong to you"
    );
  });

  it("removes a document and recompacts positions", async () => {
    await addToPlaylist(env, "user-1", "doc-1");
    await addToPlaylist(env, "user-1", "doc-2");
    await removeFromPlaylist(env, "user-1", "doc-1");
    const items = await listPlaylistItems(env, "user-1");

    expect(items).toHaveLength(1);
    expect(items[0].message_id).toBe("doc-2");
    expect(items[0].position).toBe(0);
  });

  it("sets playlists with stable ordering and dedupes duplicate ids", async () => {
    await setPlaylist(env, "user-1", ["doc-2", "doc-1", "doc-2"]);
    const items = await listPlaylistItems(env, "user-1");

    expect(items.map((item) => item.message_id)).toEqual(["doc-2", "doc-1"]);
    expect(items.map((item) => item.position)).toEqual([0, 1]);
  });

  it("rejects unknown documents during setPlaylist", async () => {
    await expect(setPlaylist(env, "user-1", ["doc-1", "missing"])).rejects.toThrow(
      "documents not found: missing"
    );
  });

  it("clears the playlist", async () => {
    await addToPlaylist(env, "user-1", "doc-1");
    await addToPlaylist(env, "user-1", "doc-2");
    await clearPlaylist(env, "user-1");

    await expect(listPlaylistItems(env, "user-1")).resolves.toEqual([]);
  });

  it("keeps playlists isolated by user", async () => {
    await addToPlaylist(env, "user-1", "doc-1");

    await expect(listPlaylistItems(env, "user-2")).resolves.toEqual([]);
    await expect(listPlaylistItems(env, "user-1")).resolves.toHaveLength(1);
  });
});

describe("Commute source preference", () => {
  let db: InMemoryDB;
  let env: Env;

  beforeEach(() => {
    db = new InMemoryDB();
    env = makeEnv(db);
  });

  it("defaults to latest", async () => {
    await expect(getCommuteSource(env, "user-1")).resolves.toBe("latest");
  });

  it("can be set to playlist and back to latest", async () => {
    await setCommuteSource(env, "user-1", "playlist");
    await expect(getCommuteSource(env, "user-1")).resolves.toBe("playlist");

    await setCommuteSource(env, "user-1", "latest");
    await expect(getCommuteSource(env, "user-1")).resolves.toBe("latest");
  });

  it("is scoped per user", async () => {
    await setCommuteSource(env, "user-1", "playlist");
    await expect(getCommuteSource(env, "user-2")).resolves.toBe("latest");
  });
});

describe("Playlist routes", () => {
  it("requires an authenticated caller", async () => {
    const db = new InMemoryDB();
    const env = makeEnv(db);
    const response = await handleGetPlaylist(
      new Request("https://pidgin.example.com/api/commute/playlist"),
      env
    );

    expect(response.status).toBe(401);
  });

  it("sets and returns the caller's playlist", async () => {
    const db = new InMemoryDB();
    const kv = new MockKV();
    kv.data.set("session:tok", "alice@example.com");
    const env = makeEnv(db, kv);

    const setResponse = await handleSetPlaylist(
      sessionRequest("/api/commute/playlist", { ids: ["doc-2", "doc-1"] }),
      env
    );
    expect(setResponse.status).toBe(200);

    const getResponse = await handleGetPlaylist(
      sessionRequest("/api/commute/playlist"),
      env
    );
    const body = (await getResponse.json()) as {
      data: { items: Array<{ message_id: string }>; commute_source: string };
    };

    expect(body.data.items.map((item) => item.message_id)).toEqual(["doc-2", "doc-1"]);
    expect(body.data.commute_source).toBe("latest");
  });
});

describe("Playlist briefing generation", () => {
  it("creates a transcript-only playlist briefing when speech is not configured", async () => {
    const db = new InMemoryDB();
    const r2 = new MockR2();
    r2.objects.set("docs/doc-1.html", {
      body: "<h1>Alpha</h1><p>Need to settle the rollout plan.</p>",
    });
    r2.objects.set("docs/doc-2.html", {
      body: "<h1>Beta</h1><p>Important findings are still mixed.</p>",
    });
    const env = makeEnv(db, new MockKV(), r2);

    await setPlaylist(env, "user-1", ["doc-1", "doc-2"]);
    const result = await generatePlaylistBriefing(env, "user-1");

    expect(result.doc_ids).toEqual(["doc-1", "doc-2"]);
    expect(result.audio_key).toBeNull();
    const transcript = await r2.objects.get(result.transcript_key)?.body;
    expect(String(transcript)).toContain("Playlist Briefing");

    const synthetic = db.tables.messages.find((row) => row.id === result.source_message_id);
    expect(synthetic?.instance_source).toBe("playlist-briefing");

    const saved = db.tables.commute_briefings[0];
    expect(saved.source_type).toBe("playlist");
    expect(JSON.parse(String(saved.playlist_doc_ids))).toEqual(["doc-1", "doc-2"]);
    expect(saved.status).toBe("transcript_only");
  });
});
