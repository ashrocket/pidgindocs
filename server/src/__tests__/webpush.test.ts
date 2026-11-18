import { afterEach, describe, expect, it, vi } from "vitest";

import { sendWebPushToAll } from "../core/push/webpush";
import type { Env } from "../core/types";

// The decryption below follows RFC 8291 (Message Encryption for Web Push) and
// RFC 8188 (aes128gcm) FROM THE SPEC, deliberately not mirroring the
// implementation — so a derivation that browsers would reject fails here too.

function b64uDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (padded.length % 4)) % 4;
  return Uint8Array.from(atob(padded + "=".repeat(pad)), (c) => c.charCodeAt(0));
}

function b64uEncode(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function hmac(key: BufferSource, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

interface Subscriber {
  privateKey: CryptoKey;
  publicRaw: Uint8Array;
  p256dh: string;
  authSecret: Uint8Array;
  auth: string;
}

async function makeSubscriber(): Promise<Subscriber> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const publicRaw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  return {
    privateKey: pair.privateKey,
    publicRaw,
    p256dh: b64uEncode(publicRaw),
    authSecret,
    auth: b64uEncode(authSecret),
  };
}

interface Vapid {
  publicRaw: Uint8Array;
  publicB64u: string;
  privateScalarB64u: string;
  verifyKey: CryptoKey;
}

async function makeVapid(): Promise<Vapid> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const publicRaw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return {
    publicRaw,
    publicB64u: b64uEncode(publicRaw),
    privateScalarB64u: jwk.d!, // base64url raw 32-byte scalar — the env-var format
    verifyKey: pair.publicKey,
  };
}

// RFC 8291 §3 + RFC 8188 §2: full receiver-side decryption.
async function decryptRecord(record: Uint8Array, sub: Subscriber): Promise<Uint8Array> {
  const salt = record.slice(0, 16);
  const idlen = record[20];
  expect(idlen).toBe(65);
  const asPublic = record.slice(21, 21 + 65);
  const ciphertext = record.slice(21 + 65);

  const asKey = await crypto.subtle.importKey(
    "raw",
    asPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      // Workers type defs lack EcdhKeyDeriveParams; same cast the source uses.
      { name: "ECDH", public: asKey } as any,
      sub.privateKey,
      256
    )
  );

  // RFC 8291 §3.3–3.4
  const prkCombine = await hmac(sub.authSecret, ecdhSecret);
  const keyInfo = concat(
    new TextEncoder().encode("WebPush: info\0"),
    sub.publicRaw,
    asPublic,
    new Uint8Array([1])
  );
  const ikm = (await hmac(prkCombine, keyInfo)).slice(0, 32);

  // RFC 8188 §2.2: HKDF-Extract(salt, IKM), then Expand for CEK and NONCE.
  const prk = await hmac(salt, ikm);
  const cek = (
    await hmac(prk, concat(new TextEncoder().encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))
  ).slice(0, 16);
  const nonce = (
    await hmac(prk, concat(new TextEncoder().encode("Content-Encoding: nonce\0"), new Uint8Array([1])))
  ).slice(0, 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aesKey, ciphertext)
  );

  // Strip the last-record padding delimiter (0x02) and any trailing zeros.
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0) end--;
  expect(padded[end - 1]).toBe(2);
  return padded.slice(0, end - 1);
}

interface SubRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

class MockDB {
  rows: SubRow[] = [];
  selects = 0;
  updates: Array<{ sql: string; binds: unknown[] }> = [];

  prepare(sql: string) {
    const db = this;
    return {
      async all() {
        db.selects++;
        return { results: db.rows };
      },
      bind: (...binds: unknown[]) => ({
        async run() {
          db.updates.push({ sql, binds });
          return { success: true, meta: { changes: 1 } };
        },
        async all() {
          db.selects++;
          return { results: db.rows };
        },
        async first() {
          return null;
        },
      }),
      async run() {
        return { success: true, meta: { changes: 0 } };
      },
      async first() {
        return null;
      },
    };
  }
}

function makeEnv(db: MockDB, vapid?: Vapid): Env {
  return {
    DB: db as unknown as D1Database,
    DOCS: {} as R2Bucket,
    SESSIONS: {} as KVNamespace,
    ENHANCE_QUEUE: {} as Env["ENHANCE_QUEUE"],
    API_KEY: "k",
    OWNER_EMAIL: "test@example.com",
    APNS_KEY_ID: "",
    APNS_TEAM_ID: "",
    APNS_PRIVATE_KEY: "",
    WORKER_URL: "https://pidgin.example.com",
    ENVIRONMENT: "test",
    ...(vapid
      ? {
          VAPID_PUBLIC_KEY: vapid.publicB64u,
          VAPID_PRIVATE_KEY: vapid.privateScalarB64u,
          VAPID_SUBJECT: "mailto:ash@example.test",
        }
      : {}),
  } as Env;
}

const PAYLOAD = { title: "Hello", body: "Night shift ping", messageId: "m-1", type: "message" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendWebPushToAll", () => {
  it("1. no-ops without VAPID configuration (no DB access)", async () => {
    const db = new MockDB();
    await sendWebPushToAll(makeEnv(db), PAYLOAD);
    expect(db.selects).toBe(0);
  });

  it("2. queries but sends nothing when there are no live subscriptions", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const db = new MockDB();
    await sendWebPushToAll(makeEnv(db, await makeVapid()), PAYLOAD);
    expect(db.selects).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("3. sends an RFC 8291-decryptable aes128gcm record with a verifiable VAPID JWT", async () => {
    const vapid = await makeVapid();
    const sub = await makeSubscriber();
    const db = new MockDB();
    db.rows = [{ id: 7, endpoint: "https://push.example.org/send/abc", p256dh: sub.p256dh, auth: sub.auth }];

    const fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendWebPushToAll(makeEnv(db, vapid), PAYLOAD);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://push.example.org/send/abc");

    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(headers.TTL).toBe("86400");

    // VAPID header: t=<jwt>, k=<public key>; signature must verify and the
    // claims must target the push service origin.
    const match = /^vapid t=(.+), k=(.+)$/.exec(headers.Authorization);
    expect(match).not.toBeNull();
    const [, jwt, k] = match!;
    expect(k).toBe(vapid.publicB64u);

    const [h, c, s] = jwt.split(".");
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      vapid.verifyKey,
      b64uDecode(s),
      new TextEncoder().encode(`${h}.${c}`)
    );
    expect(verified).toBe(true);
    const claims = JSON.parse(new TextDecoder().decode(b64uDecode(c))) as {
      aud: string;
      sub: string;
      exp: number;
    };
    expect(claims.aud).toBe("https://push.example.org");
    expect(claims.sub).toBe("mailto:ash@example.test");
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // The record must decrypt per the RFCs into the exact payload.
    const record = new Uint8Array(init.body as Uint8Array);
    const plaintext = await decryptRecord(record, sub);
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual(PAYLOAD);

    // Success stamps last_used_at for the row.
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].sql).toContain("last_used_at");
    expect(db.updates[0].binds[1]).toBe(7);
  });

  it("4. bumps failure_count when the push service rejects, isolating other sends", async () => {
    const vapid = await makeVapid();
    const good = await makeSubscriber();
    const bad = await makeSubscriber();
    const db = new MockDB();
    db.rows = [
      { id: 1, endpoint: "https://push.example.org/gone", p256dh: bad.p256dh, auth: bad.auth },
      { id: 2, endpoint: "https://push.example.org/ok", p256dh: good.p256dh, auth: good.auth },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/gone")
          ? new Response("expired", { status: 410 })
          : new Response(null, { status: 201 })
      )
    );

    await sendWebPushToAll(makeEnv(db, vapid), PAYLOAD);

    const failure = db.updates.find((u) => u.sql.includes("failure_count"));
    const success = db.updates.find((u) => u.sql.includes("last_used_at"));
    expect(failure?.binds[1]).toBe(1);
    expect(success?.binds[1]).toBe(2);
  });
});
