import { describe, expect, it, beforeAll } from "vitest";

import { verifyIdToken } from "../core/auth/jwt-verify";

// --- helpers: real RS256 signing with a locally-generated keypair ---

function b64url(data: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array;
  if (typeof data === "string") bytes = new TextEncoder().encode(data);
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else bytes = data;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let privateKey: CryptoKey;
let publicJwk: any;
const KID = "test-key-1";
const ISS = "https://issuer.example.com";
const AUD = "com.example.pidgin";

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  privateKey = pair.privateKey;
  publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  publicJwk.kid = KID;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
});

async function signJwt(
  payload: Record<string, unknown>,
  opts: { kid?: string } = {}
): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid: opts.kid ?? KID };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    privateKey,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${b64url(sig)}`;
}

const NOW = Math.floor(Date.parse("2026-06-03T12:00:00Z") / 1000);
function basePayload(over: Record<string, unknown> = {}) {
  return {
    iss: ISS,
    aud: AUD,
    exp: NOW + 600,
    iat: NOW - 10,
    email: "owner@example.com",
    email_verified: true,
    ...over,
  };
}
function jwks() {
  return { keys: [publicJwk] };
}
function opts(over: Record<string, unknown> = {}) {
  return { issuer: ISS, audiences: [AUD], jwks: jwks(), now: NOW, ...over };
}

describe("verifyIdToken", () => {
  it("accepts a valid token and returns email + claims", async () => {
    const token = await signJwt(basePayload());
    const result = await verifyIdToken(token, opts());
    expect(result.email).toBe("owner@example.com");
    expect(result.emailVerified).toBe(true);
    expect(result.claims.aud).toBe(AUD);
  });

  it("rejects a tampered signature", async () => {
    const token = await signJwt(basePayload());
    const tampered = token.slice(0, -4) + (token.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
    await expect(verifyIdToken(tampered, opts())).rejects.toThrow();
  });

  it("rejects a token re-signed payload but same signature (forged claim)", async () => {
    const token = await signJwt(basePayload());
    const [h, , s] = token.split(".");
    const forgedPayload = b64url(JSON.stringify(basePayload({ email: "attacker@evil.com" })));
    const forged = `${h}.${forgedPayload}.${s}`;
    await expect(verifyIdToken(forged, opts())).rejects.toThrow();
  });

  it("rejects a wrong audience", async () => {
    const token = await signJwt(basePayload({ aud: "com.someone.else" }));
    await expect(verifyIdToken(token, opts())).rejects.toThrow(/audience/i);
  });

  it("accepts when aud is an array containing an allowed audience", async () => {
    const token = await signJwt(basePayload({ aud: ["com.other", AUD] }));
    const result = await verifyIdToken(token, opts());
    expect(result.email).toBe("owner@example.com");
  });

  it("rejects a wrong issuer", async () => {
    const token = await signJwt(basePayload({ iss: "https://evil.example.com" }));
    await expect(verifyIdToken(token, opts())).rejects.toThrow(/issuer/i);
  });

  it("accepts an issuer from a list of allowed issuers", async () => {
    const token = await signJwt(basePayload({ iss: "accounts.google.com" }));
    const result = await verifyIdToken(
      token,
      opts({ issuer: ["https://accounts.google.com", "accounts.google.com"] })
    );
    expect(result.email).toBe("owner@example.com");
  });

  it("rejects an expired token (beyond clock-skew tolerance)", async () => {
    const token = await signJwt(basePayload({ exp: NOW - 600 }));
    await expect(verifyIdToken(token, opts())).rejects.toThrow(/expired/i);
  });

  it("tolerates a token just-expired within the clock-skew window", async () => {
    const token = await signJwt(basePayload({ exp: NOW - 30 }));
    const result = await verifyIdToken(token, opts());
    expect(result.email).toBe("owner@example.com");
  });

  it("rejects an unknown signing key (kid not in JWKS)", async () => {
    const token = await signJwt(basePayload(), { kid: "unknown-kid" });
    await expect(verifyIdToken(token, opts())).rejects.toThrow(/key/i);
  });

  it("rejects email_verified=false when required", async () => {
    const token = await signJwt(basePayload({ email_verified: false }));
    await expect(
      verifyIdToken(token, opts({ requireEmailVerified: true }))
    ).rejects.toThrow(/verified/i);
  });

  it("rejects a token with no email claim", async () => {
    const token = await signJwt(basePayload({ email: undefined }));
    await expect(verifyIdToken(token, opts())).rejects.toThrow(/email/i);
  });

  // --- nonce binding (Apple replay hardening) ---

  async function sha256Hex(input: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  it("accepts a token whose nonce claim matches SHA256(expectedNonce)", async () => {
    const raw = "raw-nonce-abc";
    const token = await signJwt(basePayload({ nonce: await sha256Hex(raw) }));
    const result = await verifyIdToken(token, opts({ expectedNonce: raw }));
    expect(result.email).toBe("owner@example.com");
  });

  it("rejects a token whose nonce claim does not match SHA256(expectedNonce)", async () => {
    const token = await signJwt(basePayload({ nonce: await sha256Hex("a-different-nonce") }));
    await expect(verifyIdToken(token, opts({ expectedNonce: "raw-nonce-abc" }))).rejects.toThrow(
      /nonce/i
    );
  });

  it("rejects when expectedNonce is supplied but the token has no nonce claim", async () => {
    const token = await signJwt(basePayload());
    await expect(verifyIdToken(token, opts({ expectedNonce: "raw-nonce-abc" }))).rejects.toThrow(
      /nonce/i
    );
  });

  it("ignores the nonce claim when no expectedNonce is supplied (backwards compatible)", async () => {
    const token = await signJwt(basePayload({ nonce: await sha256Hex("whatever") }));
    const result = await verifyIdToken(token, opts());
    expect(result.email).toBe("owner@example.com");
  });
});
