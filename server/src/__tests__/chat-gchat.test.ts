import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  toGChatText,
  getGChatAccessToken,
  gchatChannel,
  verifyGChatBearer,
  normalizeGChatEvent,
  gchatSyncReply,
  GCHAT_SYSTEM_ISSUER,
} from "../core/chat/gchat";
import type {
  Conversation,
  ChatMessageRow,
  GServiceAccountKey,
  ResolvedGChatConfig,
} from "../core/chat/types";
import type { Env } from "../core/types";

// Mirrors the two JWKS endpoints gchat.ts hits for inbound bearer verification.
// Not exported from the module, so re-declared here from the source constants.
const GCHAT_SYSTEM_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/chat@system.gserviceaccount.com";
const GOOGLE_OAUTH_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

// ---------------------------------------------------------------------------
// Test doubles

class MockKV {
  store = new Map<string, string>();
  puts: Array<{ key: string; value: string; options?: { expirationTtl?: number } }> = [];

  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, value);
    this.puts.push({ key, value, options });
  }
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as unknown as D1Database,
    DOCS: {} as unknown as R2Bucket,
    SESSIONS: new MockKV() as unknown as KVNamespace,
    ENHANCE_QUEUE: { send: vi.fn() } as unknown as Env["ENHANCE_QUEUE"],
    API_KEY: "test-key",
    OWNER_EMAIL: "owner@example.com",
    APNS_KEY_ID: "",
    APNS_TEAM_ID: "",
    APNS_PRIVATE_KEY: "",
    WORKER_URL: "https://pidgin.example.com",
    ENVIRONMENT: "test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// RSA key helpers — real crypto.subtle keys so signing/verification actually run.

async function generateRsaKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function exportPkcs8Pem(key: CryptoKey): Promise<string> {
  const der = (await crypto.subtle.exportKey("pkcs8", key)) as ArrayBuffer;
  const b64 = bytesToBase64(new Uint8Array(der));
  const lines = b64.match(/.{1,64}/g) ?? [b64];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

function b64url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function signJwt(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  privateKey: CryptoKey
): Promise<string> {
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(claims));
  const signingInput = `${h}.${p}`;
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    privateKey,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// toGChatText

describe("toGChatText", () => {
  it("converts bold, italic, links, strikethrough and headings to Chat markup", () => {
    const input =
      "# Heading\n\nSome **bold** and *italic* and ~~strike~~ text with " +
      "[a link](https://example.com/page) plus __alsoBold__.";
    const result = toGChatText(input);
    expect(result).toBe(
      "*Heading*\n\nSome *bold* and _italic_ and ~strike~ text with " +
        "<https://example.com/page|a link> plus *alsoBold*."
    );
  });

  it("leaves code fences and inline code untouched", () => {
    const input =
      "Use `inline **code**` here.\n\n```\nconst x = **not bold** and _keep_;\n```\n\n" +
      "Done with [link](https://example.com).";
    const result = toGChatText(input);
    expect(result).toContain("`inline **code**`");
    expect(result).toContain("```\nconst x = **not bold** and _keep_;\n```");
    expect(result).toContain("<https://example.com|link>");
    expect(result).not.toContain("[link](https://example.com)");
  });

  it("truncates input over 31000 bytes with a trailing ellipsis", () => {
    const long = "a".repeat(32000);
    const result = toGChatText(long);
    expect(result.endsWith("...")).toBe(true);
    expect(new TextEncoder().encode(result).length).toBe(31000);
    expect(result).toBe("a".repeat(30997) + "...");
  });
});

// ---------------------------------------------------------------------------
// getGChatAccessToken

describe("getGChatAccessToken", () => {
  let saPem: string;

  beforeAll(async () => {
    const pair = await generateRsaKeyPair();
    saPem = await exportPkcs8Pem(pair.privateKey);
  });

  it("returns a cached token from KV without calling fetch", async () => {
    const kv = new MockKV();
    await kv.put("gchat-token:sa@proj.iam.gserviceaccount.com", "cached-token");
    const env = makeEnv({ SESSIONS: kv as unknown as KVNamespace });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const key: GServiceAccountKey = {
      client_email: "sa@proj.iam.gserviceaccount.com",
      private_key: "unused-pem",
    };
    const token = await getGChatAccessToken(env, key);

    expect(token).toBe("cached-token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("mints a token via a jwt-bearer POST on cache miss and caches it with ttl = expires_in - 60", async () => {
    const kv = new MockKV();
    const env = makeEnv({ SESSIONS: kv as unknown as KVNamespace });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://oauth2.googleapis.com/token");
      expect(init?.method).toBe("POST");
      const body = init?.body as URLSearchParams;
      expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
      const assertion = body.get("assertion");
      expect(assertion?.split(".").length).toBe(3);
      return new Response(JSON.stringify({ access_token: "minted-token", expires_in: 1000 }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const key: GServiceAccountKey = {
      client_email: "sa@proj.iam.gserviceaccount.com",
      private_key: saPem,
    };
    const token = await getGChatAccessToken(env, key);

    expect(token).toBe("minted-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(kv.puts).toHaveLength(1);
    expect(kv.puts[0].key).toBe("gchat-token:sa@proj.iam.gserviceaccount.com");
    expect(kv.puts[0].value).toBe("minted-token");
    expect(kv.puts[0].options?.expirationTtl).toBe(940);
  });
});

// ---------------------------------------------------------------------------
// gchatChannel.deliver

describe("gchatChannel.deliver", () => {
  let saPem: string;

  beforeAll(async () => {
    const pair = await generateRsaKeyPair();
    saPem = await exportPkcs8Pem(pair.privateKey);
  });

  const conversation: Conversation = {
    id: "conv-1",
    user_id: "user-1",
    instance_session_id: null,
    instance_project: null,
    doc_id: null,
    title: "My Conversation",
    status: "open",
    last_poll_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    last_activity_at: "2026-01-01T00:00:00.000Z",
  };

  const message: ChatMessageRow = {
    id: "msg-1",
    seq: 1,
    conversation_id: "conv-1",
    sender: "agent",
    channel: null,
    body: "Hello **world**",
    external_event_id: null,
    created_at: "2026-01-01T00:00:01.000Z",
  };

  function makeConfig(overrides: Partial<ResolvedGChatConfig> = {}): ResolvedGChatConfig {
    return {
      project_number: "999888777",
      service_account_key: { client_email: "sa@proj.iam.gserviceaccount.com", private_key: saPem },
      owner_email: "owner@example.com",
      owner_user_name: "users/123",
      dm_space: "spaces/AAAA",
      ...overrides,
    };
  }

  it("throws when config.dm_space is null", async () => {
    const env = makeEnv();
    const config = makeConfig({ dm_space: null });
    await expect(gchatChannel.deliver(env, conversation, message, config, null)).rejects.toThrow(
      /DM space not established/
    );
  });

  it("POSTs to the space messages endpoint with REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD and threadKey, returning the response thread name as binding", async () => {
    const env = makeEnv();
    const config = makeConfig();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "tok-1", expires_in: 3600 }), { status: 200 });
      }
      expect(url).toBe(
        "https://chat.googleapis.com/v1/spaces/AAAA/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD"
      );
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
      const parsedBody = JSON.parse(init!.body as string);
      expect(parsedBody.thread.threadKey).toBe("conv-1");
      expect(parsedBody.text).toBe("Hello *world*");
      return new Response(
        JSON.stringify({ name: "spaces/AAAA/messages/MSG1", thread: { name: "spaces/AAAA/threads/THREAD1" } }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await gchatChannel.deliver(env, conversation, message, config, "spaces/AAAA#conv-1");

    expect(result.eventId).toBe("spaces/AAAA/messages/MSG1");
    expect(result.binding).toBe("spaces/AAAA/threads/THREAD1");
  });

  it("falls back to a synthetic binding when the response carries no thread name", async () => {
    const env = makeEnv();
    const config = makeConfig();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "tok-1", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ name: "spaces/AAAA/messages/MSG2" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await gchatChannel.deliver(env, conversation, message, config, "spaces/AAAA#conv-1");

    expect(result.binding).toBe("spaces/AAAA#conv-1");
  });

  it("prefixes the conversation title on the first send (binding === null)", async () => {
    const env = makeEnv();
    const config = makeConfig();
    let capturedText = "";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "tok-1", expires_in: 3600 }), { status: 200 });
      }
      capturedText = JSON.parse(init!.body as string).text;
      return new Response(JSON.stringify({ name: "spaces/AAAA/messages/MSG3" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await gchatChannel.deliver(env, conversation, message, config, null);

    expect(capturedText).toBe("*My Conversation*\n\nHello *world*");
  });
});

// ---------------------------------------------------------------------------
// verifyGChatBearer

describe("verifyGChatBearer", () => {
  let chatKeyPair: CryptoKeyPair;
  let chatJwk: JsonWebKey & { kid: string };
  let wrongKeyPair: CryptoKeyPair;

  beforeAll(async () => {
    chatKeyPair = await generateRsaKeyPair();
    const jwk = (await crypto.subtle.exportKey("jwk", chatKeyPair.publicKey)) as JsonWebKey;
    chatJwk = { ...jwk, kid: "kid-1" };
    wrongKeyPair = await generateRsaKeyPair();
  });

  it("verifies a valid project-number-audience token from chat@system", async () => {
    const env = makeEnv();
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt(
      { alg: "RS256", typ: "JWT", kid: "kid-1" },
      { iss: GCHAT_SYSTEM_ISSUER, aud: "999888777", exp: now + 3600 },
      chatKeyPair.privateKey
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(GCHAT_SYSTEM_JWKS_URL);
      return new Response(JSON.stringify({ keys: [chatJwk] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const headers = new Headers({ Authorization: `Bearer ${token}` });
    const result = await verifyGChatBearer(headers, env, { project_number: "999888777" }, now);

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a token whose audience doesn't match project_number", async () => {
    const env = makeEnv();
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt(
      { alg: "RS256", typ: "JWT", kid: "kid-1" },
      { iss: GCHAT_SYSTEM_ISSUER, aud: "000000000", exp: now + 3600 },
      chatKeyPair.privateKey
    );
    const fetchMock = vi.fn(() => {
      throw new Error("should not fetch JWKS for a rejected audience");
    });
    vi.stubGlobal("fetch", fetchMock);

    const headers = new Headers({ Authorization: `Bearer ${token}` });
    const result = await verifyGChatBearer(headers, env, { project_number: "999888777" }, now);

    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an expired token", async () => {
    const env = makeEnv();
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt(
      { alg: "RS256", typ: "JWT", kid: "kid-1" },
      { iss: GCHAT_SYSTEM_ISSUER, aud: "999888777", exp: now - 1000 },
      chatKeyPair.privateKey
    );
    const fetchMock = vi.fn(() => {
      throw new Error("should not fetch JWKS for an expired token");
    });
    vi.stubGlobal("fetch", fetchMock);

    const headers = new Headers({ Authorization: `Bearer ${token}` });
    const result = await verifyGChatBearer(headers, env, { project_number: "999888777" }, now);

    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a tampered signature (token signed with the wrong key)", async () => {
    const env = makeEnv();
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt(
      { alg: "RS256", typ: "JWT", kid: "kid-1" },
      { iss: GCHAT_SYSTEM_ISSUER, aud: "999888777", exp: now + 3600 },
      wrongKeyPair.privateKey
    );
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ keys: [chatJwk] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const headers = new Headers({ Authorization: `Bearer ${token}` });
    const result = await verifyGChatBearer(headers, env, { project_number: "999888777" }, now);

    expect(result).toBe(false);
  });

  it("rejects a missing or non-Bearer Authorization header", async () => {
    const env = makeEnv();
    const fetchMock = vi.fn(() => {
      throw new Error("should not fetch JWKS without a bearer token");
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await verifyGChatBearer(new Headers(), env, { project_number: "999888777" })).toBe(false);
    expect(
      await verifyGChatBearer(new Headers({ Authorization: "Basic abc123" }), env, { project_number: "999888777" })
    ).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unrecognized issuer", async () => {
    const env = makeEnv();
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt(
      { alg: "RS256", typ: "JWT", kid: "kid-1" },
      { iss: "someone-else@example.com", aud: "999888777", exp: now + 3600 },
      chatKeyPair.privateKey
    );
    const fetchMock = vi.fn(() => {
      throw new Error("should not fetch JWKS for an unknown issuer");
    });
    vi.stubGlobal("fetch", fetchMock);

    const headers = new Headers({ Authorization: `Bearer ${token}` });
    const result = await verifyGChatBearer(headers, env, { project_number: "999888777" }, now);

    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("verifies a Google ID-token (HTTP endpoint URL audience mode) via oauth2/v3/certs", async () => {
    const env = makeEnv({ WORKER_URL: "https://pidgin.example.com" });
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt(
      { alg: "RS256", typ: "JWT", kid: "kid-1" },
      {
        iss: "https://accounts.google.com",
        email: GCHAT_SYSTEM_ISSUER,
        aud: "https://pidgin.example.com/api/chat/gchat/events",
        exp: now + 3600,
      },
      chatKeyPair.privateKey
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(GOOGLE_OAUTH_JWKS_URL);
      return new Response(JSON.stringify({ keys: [chatJwk] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const headers = new Headers({ Authorization: `Bearer ${token}` });
    const result = await verifyGChatBearer(headers, env, { project_number: "999888777" }, now);

    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// normalizeGChatEvent + gchatSyncReply

describe("normalizeGChatEvent / gchatSyncReply", () => {
  it("normalizes the legacy MESSAGE envelope (DM space type) and replies with plain text", () => {
    const body = {
      type: "MESSAGE",
      message: {
        name: "spaces/AAAA/messages/BBBB",
        text: "hello there",
        thread: { name: "spaces/AAAA/threads/CCCC" },
        sender: { name: "users/123", email: "user@example.com", displayName: "User", type: "HUMAN" },
        space: { name: "spaces/AAAA", type: "DM" },
      },
      space: { name: "spaces/AAAA", type: "DM" },
      user: { name: "users/123", email: "user@example.com", displayName: "User", type: "HUMAN" },
    };

    const event = normalizeGChatEvent(body);

    expect(event.kind).toBe("MESSAGE");
    expect(event.isAddonEnvelope).toBe(false);
    expect(event.space).toEqual({ name: "spaces/AAAA", spaceType: "DIRECT_MESSAGE" });
    expect(event.user).toEqual({
      name: "users/123",
      email: "user@example.com",
      displayName: "User",
      type: "HUMAN",
    });
    expect(event.message).toEqual({
      name: "spaces/AAAA/messages/BBBB",
      text: "hello there",
      threadName: "spaces/AAAA/threads/CCCC",
      threadKey: null,
    });
    expect(gchatSyncReply(event, "reply text")).toEqual({ text: "reply text" });
  });

  it("normalizes the add-on chat.messagePayload envelope and replies with the hostAppDataAction wrapper", () => {
    const body = {
      chat: {
        user: { name: "users/456", email: "user2@example.com", displayName: "User2", type: "HUMAN" },
        messagePayload: {
          space: { name: "spaces/DDDD", spaceType: "DIRECT_MESSAGE" },
          message: {
            name: "spaces/DDDD/messages/EEEE",
            text: "hi",
            thread: { name: "spaces/DDDD/threads/FFFF" },
          },
        },
      },
    };

    const event = normalizeGChatEvent(body);

    expect(event.kind).toBe("MESSAGE");
    expect(event.isAddonEnvelope).toBe(true);
    expect(event.space).toEqual({ name: "spaces/DDDD", spaceType: "DIRECT_MESSAGE" });
    expect(event.user).toEqual({
      name: "users/456",
      email: "user2@example.com",
      displayName: "User2",
      type: "HUMAN",
    });
    expect(event.message).toEqual({
      name: "spaces/DDDD/messages/EEEE",
      text: "hi",
      threadName: "spaces/DDDD/threads/FFFF",
      threadKey: null,
    });
    expect(gchatSyncReply(event, "reply text2")).toEqual({
      hostAppDataAction: { chatDataAction: { createMessageAction: { message: { text: "reply text2" } } } },
    });
  });
});
