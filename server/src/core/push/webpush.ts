import { Env } from "../types";

interface PushPayload {
  title: string;
  body: string;
  messageId: string;
  type: string;
}

export async function sendWebPushToAll(env: Env, payload: PushPayload): Promise<void> {
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY || !env.VAPID_SUBJECT) return;

  const subs = await env.DB.prepare(
    "SELECT * FROM web_push_subscriptions WHERE failure_count < 5"
  ).all();

  if (subs.results.length === 0) return;

  await Promise.allSettled(
    subs.results.map(async (row) => {
      try {
        await sendOne(env, row as any, payload);
        await env.DB.prepare(
          "UPDATE web_push_subscriptions SET last_used_at = ? WHERE id = ?"
        ).bind(Date.now(), row.id).run();
      } catch {
        await env.DB.prepare(
          "UPDATE web_push_subscriptions SET failure_count = failure_count + 1, failed_at = ? WHERE id = ?"
        ).bind(Date.now(), row.id).run();
      }
    })
  );
}

async function sendOne(
  env: Env,
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: PushPayload
): Promise<void> {
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const { ciphertext, salt, ephemeralPublicKey } = await encrypt(plaintext, sub.p256dh, sub.auth);

  // Build aes128gcm record: salt(16) + rs(4) + keyid_len(1) + keyid(65) + ciphertext
  const rs = ciphertext.length + 65 + 1 + 16 + 4 + 1;
  const record = new Uint8Array(16 + 4 + 1 + 65 + ciphertext.length);
  let offset = 0;
  record.set(salt, offset); offset += 16;
  new DataView(record.buffer).setUint32(offset, rs, false); offset += 4;
  record[offset++] = 65; // key_id length (uncompressed P-256 point)
  record.set(ephemeralPublicKey, offset); offset += 65;
  record.set(ciphertext, offset);

  const jwt = await buildVapidJwt(env, sub.endpoint);

  const resp = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      TTL: "86400",
      Urgency: "normal",
    },
    body: record,
  });

  if (!resp.ok && resp.status !== 201) {
    const text = await resp.text().catch(() => resp.status.toString());
    throw new Error(`web push ${resp.status}: ${text.slice(0, 200)}`);
  }
}

async function encrypt(
  plaintext: Uint8Array,
  p256dhB64: string,
  authB64: string
): Promise<{ ciphertext: Uint8Array; salt: Uint8Array; ephemeralPublicKey: Uint8Array }> {
  const receiverKey = await crypto.subtle.importKey(
    "raw", b64url(p256dhB64),
    { name: "ECDH", namedCurve: "P-256" },
    false, []
  );

  const ephemeral = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]
  )) as CryptoKeyPair;

  const sharedBits = await crypto.subtle.deriveBits(
    // Web Crypto names this `public`; the Workers type defs call it `$public`, so cast past them.
    { name: "ECDH", public: receiverKey } as any,
    ephemeral.privateKey, 256
  );

  const ephemeralPublicKey = new Uint8Array(
    (await crypto.subtle.exportKey("raw", ephemeral.publicKey)) as ArrayBuffer
  );
  const receiverPublicKey = b64url(p256dhB64);
  const authSecret = b64url(authB64);
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // IKM = HKDF-Extract then Expand: RFC 8291 §3.3
  // PRK from auth secret + shared ECDH bits
  const prkKey = await crypto.subtle.importKey(
    "raw", authSecret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const prk = await crypto.subtle.sign(
    "HMAC", prkKey, sharedBits
  );

  // info = "WebPush: info\0" || receiverPublicKey || ephemeralPublicKey
  const info = concat(
    new TextEncoder().encode("WebPush: info\0"),
    receiverPublicKey,
    ephemeralPublicKey
  );

  // IKM = HKDF-Expand(PRK, info, 32)
  const prkImport = await crypto.subtle.importKey(
    "raw", prk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const ikm = new Uint8Array(
    await crypto.subtle.sign("HMAC", prkImport, concat(info, new Uint8Array([1])))
  ).slice(0, 32);

  // Derive CEK and nonce per RFC 8188 §2.2: HKDF-Extract(salt, IKM) gives a
  // second PRK, then Expand with each info string. (An earlier version used
  // IKM directly as the HMAC key with the salt folded into the message —
  // browsers reject records encrypted that way; webpush.test.ts decrypts
  // per the RFC to keep this honest.)
  const saltKey = await crypto.subtle.importKey(
    "raw", salt, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const contentPrk = await crypto.subtle.sign("HMAC", saltKey, ikm);
  const contentPrkKey = await crypto.subtle.importKey(
    "raw", contentPrk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );

  const cekInfo = new TextEncoder().encode("Content-Encoding: aes128gcm\0");
  const nonceInfo = new TextEncoder().encode("Content-Encoding: nonce\0");

  const cek = new Uint8Array(
    await crypto.subtle.sign("HMAC", contentPrkKey, concat(cekInfo, new Uint8Array([1])))
  ).slice(0, 16);

  const nonce = new Uint8Array(
    await crypto.subtle.sign("HMAC", contentPrkKey, concat(nonceInfo, new Uint8Array([1])))
  ).slice(0, 12);

  // Encrypt: plaintext + \x02 (padding delimiter for last record)
  const padded = concat(plaintext, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, padded)
  );

  return { ciphertext, salt, ephemeralPublicKey };
}

async function buildVapidJwt(env: Env, endpoint: string): Promise<string> {
  const { protocol, host } = new URL(endpoint);
  const audience = `${protocol}//${host}`;

  const header = b64urlEncode(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64urlEncode(new TextEncoder().encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub: env.VAPID_SUBJECT,
  })));

  const signingInput = `${header}.${claims}`;

  // VAPID_PRIVATE_KEY is base64url-encoded raw 32-byte EC private key scalar.
  // Non-null: callers reach this only after sendWebPushToAll's VAPID guard.
  const rawPrivate = b64url(env.VAPID_PRIVATE_KEY!);
  const privateKey = await crypto.subtle.importKey(
    "pkcs8", rawToPkcs8(rawPrivate),
    { name: "ECDSA", namedCurve: "P-256" },
    false, ["sign"]
  );

  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      new TextEncoder().encode(signingInput)
    )
  );

  return `${signingInput}.${b64urlEncode(sig)}`;
}

// Wrap a raw 32-byte EC private key in minimal PKCS8 DER for P-256
function rawToPkcs8(raw: Uint8Array): ArrayBuffer {
  // PKCS8 wrapper for EC P-256 private key (OID 1.2.840.10045.2.1, curve OID 1.2.840.10045.3.1.7)
  const prefix = new Uint8Array([
    0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48,
    0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03,
    0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20,
  ]);
  const result = new Uint8Array(prefix.length + raw.length);
  result.set(prefix);
  result.set(raw, prefix.length);
  return result.buffer;
}

function b64url(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (padded.length % 4)) % 4;
  return Uint8Array.from(atob(padded + "=".repeat(pad)), (c) => c.charCodeAt(0));
}

function b64urlEncode(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}
