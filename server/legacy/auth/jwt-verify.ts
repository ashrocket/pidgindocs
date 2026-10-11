// Minimal, dependency-free OpenID Connect id_token (RS256 JWT) verification using
// Web Crypto. Used to verify Sign in with Apple / Google tokens server-side.
//
// verifyIdToken is PURE with respect to the network: it takes the provider's JWKS
// (public keys) directly so it can be unit-tested with a locally-generated keypair.
// Fetching/caching the JWKS lives in jwks.ts.

export interface Jwks {
  keys: JsonWebKey[];
}

export interface VerifyOptions {
  issuer: string | string[];
  audiences: string[];
  jwks: Jwks;
  now?: number; // unix seconds; defaults to current time
  clockSkewSeconds?: number; // tolerance for exp/iat skew
  requireEmailVerified?: boolean;
  // Raw client nonce. When supplied, the token's `nonce` claim must equal
  // SHA256(expectedNonce) in lowercase hex (Apple replay hardening). Omitted →
  // the nonce claim is ignored (backwards compatible with older clients).
  expectedNonce?: string;
}

// Thrown when the token's kid is absent from the JWKS we were given — the
// provider may have rotated keys since that set was cached, so callers can
// refetch and retry once before treating it as a bad token.
export class UnknownSigningKeyError extends Error {
  readonly kid: string | undefined;
  constructor(kid: string | undefined) {
    super(`no matching signing key for kid: ${safeTokenValue(kid)}`);
    this.name = "UnknownSigningKeyError";
    this.kid = kid;
  }
}

// Header/claim values come straight from an unauthenticated request; keep
// them from smuggling arbitrary text into error messages (which reach logs
// and audit rows).
function safeTokenValue(value: unknown): string {
  return String(value).replace(/[^A-Za-z0-9._:/@-]/g, "?").slice(0, 64);
}

export interface VerifiedToken {
  email: string;
  emailVerified: boolean;
  claims: Record<string, unknown>;
}

function b64urlToBytes(input: string): Uint8Array {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function decodeJson(segment: string): Record<string, unknown> {
  const text = new TextDecoder().decode(b64urlToBytes(segment));
  return JSON.parse(text) as Record<string, unknown>;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifyIdToken(
  idToken: string,
  options: VerifyOptions
): Promise<VerifiedToken> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("malformed token: expected 3 segments");
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = decodeJson(headerB64);
    claims = decodeJson(payloadB64);
  } catch {
    throw new Error("malformed token: invalid base64/JSON");
  }

  if (header.alg !== "RS256") {
    throw new Error(`unsupported signing alg: ${safeTokenValue(header.alg)}`);
  }

  // Find the signing key by kid (fall back to the sole key if no kid given).
  const kid = typeof header.kid === "string" ? header.kid : undefined;
  const jwk =
    options.jwks.keys.find((k) => (k as { kid?: string }).kid === kid) ??
    (options.jwks.keys.length === 1 && !kid ? options.jwks.keys[0] : undefined);
  if (!jwk) throw new UnknownSigningKeyError(kid);

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const signedInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const valid = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    b64urlToBytes(signatureB64),
    signedInput
  );
  if (!valid) throw new Error("invalid token signature");

  // --- claim validation (only after the signature is proven) ---
  const skew = options.clockSkewSeconds ?? 60;
  const now = options.now ?? Math.floor(Date.now() / 1000);

  const allowedIssuers = Array.isArray(options.issuer) ? options.issuer : [options.issuer];
  if (typeof claims.iss !== "string" || !allowedIssuers.includes(claims.iss)) {
    throw new Error(`unexpected token issuer: ${safeTokenValue(claims.iss)}`);
  }

  const audClaim = claims.aud;
  const tokenAudiences = Array.isArray(audClaim)
    ? (audClaim as unknown[]).filter((a): a is string => typeof a === "string")
    : typeof audClaim === "string"
    ? [audClaim]
    : [];
  if (!tokenAudiences.some((a) => options.audiences.includes(a))) {
    throw new Error("token audience not allowed");
  }

  if (typeof claims.exp !== "number" || claims.exp + skew < now) {
    throw new Error("token expired");
  }
  if (typeof claims.nbf === "number" && claims.nbf - skew > now) {
    throw new Error("token not yet valid");
  }

  const email = typeof claims.email === "string" ? claims.email : "";
  if (!email) throw new Error("token missing email claim");

  const emailVerified =
    claims.email_verified === true || claims.email_verified === "true";
  if (options.requireEmailVerified && !emailVerified) {
    throw new Error("token email is not verified");
  }

  // Nonce binding: the client sets request.nonce = SHA256(raw) and Apple echoes
  // that hash into the token. Re-deriving it here proves the token was minted for
  // this specific sign-in attempt, not replayed from elsewhere.
  if (options.expectedNonce !== undefined) {
    const expected = await sha256Hex(options.expectedNonce);
    if (typeof claims.nonce !== "string" || claims.nonce !== expected) {
      throw new Error("token nonce mismatch");
    }
  }

  return { email, emailVerified, claims };
}
