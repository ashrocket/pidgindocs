import { Env } from "../types";
import { json } from "../utils";
import { loginEmailHtml, mailDeliveryErrorMessage, sendOwnerEmail } from "../email";
import { resolveApiKeyUser, unauthorized, SESSION_TTL_SECONDS, sessionMetadata } from "../middleware";
import { checkRateLimit } from "../ratelimit";
import { loginPage } from "../web/index";
import { verifyProviderIdToken, rateLimitScope, type OAuthProvider } from "../auth/oauth-login";
import { decodeOAuthWebState, findActiveUserByEmail } from "../auth-utils";
import { ensurePersonalWorkspace } from "../workspace";

// Only follow a `next` redirect target when it resolves to our own origin —
// otherwise a crafted magic-link/SSO payload could bounce a freshly-minted
// session cookie's carrier request to an attacker-controlled host.
function safeSameOriginNext(next: string | undefined, requestUrl: string): string | undefined {
  if (!next) return undefined;
  try {
    const target = new URL(next, requestUrl);
    return target.origin === new URL(requestUrl).origin ? target.toString() : undefined;
  } catch {
    return undefined;
  }
}

export async function handleLogin(
  request: Request,
  env: Env
): Promise<Response> {
  let body: { email?: string; next?: string };
  try {
    body = (await request.json()) as { email?: string; next?: string };
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const { email, next } = body;

  if (!email) {
    return json({ ok: false, error: "email required" }, 400);
  }

  // Rate limit: 5 login requests per email per 10 minutes
  const allowed = await checkRateLimit(env, `login:${email.toLowerCase()}`, 5, 600);
  if (!allowed) {
    return json({ ok: false, error: "Too many login attempts. Try again in 10 minutes." }, 429);
  }

  if (!env.OWNER_EMAIL) {
    console.error("login misconfigured: OWNER_EMAIL is not configured");
    return json({ ok: false, error: "OWNER_EMAIL is not configured" }, 500);
  }

  // Only registered active users get a link. The typed email may be the
  // canonical users.email or a linked identity (user_identities) — either way
  // the magic token carries the CANONICAL email so the minted session lands on
  // the one shared account.
  const user = await findActiveUserByEmail(env, email);

  if (!user) {
    return json({ ok: true, data: { message: "If this email is registered, a login link has been sent." } });
  }

  // Generate one-time token
  const token = crypto.randomUUID();

  // Store in KV with 5-minute expiry
  await env.SESSIONS.put(
    `magic:${token}`,
    JSON.stringify({ email: user.email, next }),
    { expirationTtl: 300 }
  );

  // Build magic link
  const workerUrl = env.WORKER_URL || new URL(request.url).origin;
  const magicLink = `${workerUrl}/auth/verify?token=${token}`;

  try {
    await sendOwnerEmail(
      env,
      "PidginDocs Login",
      loginEmailHtml(magicLink),
      email
    );
  } catch (err) {
    const message = mailDeliveryErrorMessage(env, err);
    console.error(`login email failed: ${message}`);
    return json({ ok: false, error: `login email delivery failed: ${message}` }, 502);
  }

  return json({ ok: true, data: { message: "If this email is registered, a login link has been sent." } });
}

export async function handleVerify(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) {
    return new Response("Missing token", { status: 400 });
  }

  // Look up magic link token
  const raw = await env.SESSIONS.get(`magic:${token}`);
  if (!raw) {
    return new Response("Invalid or expired link", { status: 401 });
  }

  let email: string;
  let next: string | undefined;
  let activate: boolean = false;
  try {
    const parsed = JSON.parse(raw) as { email?: string; next?: string; activate?: boolean };
    email = parsed.email || "";
    next = parsed.next;
    activate = parsed.activate === true;
  } catch {
    email = raw;
  }
  if (!email) {
    return new Response("Invalid or expired link", { status: 401 });
  }

  // Activate pending users on first link click (invite-code flow)
  if (activate) {
    await env.DB.prepare("UPDATE users SET status = 'active' WHERE email = ? AND status = 'pending'")
      .bind(email.toLowerCase())
      .run();
  }

  const active = await env.DB.prepare(
    `SELECT id, email FROM users WHERE email = ? AND status = 'active'`
  )
    .bind(email.toLowerCase())
    .first<{ id: string; email: string }>();
  if (!active) return new Response("Invalid or expired link", { status: 401 });
  email = active.email;
  if (activate) await ensurePersonalWorkspace(env, active.id);

  // Consume only after activation and workspace creation succeed. A temporary
  // D1 failure should leave the short-lived link retryable.
  await env.SESSIONS.delete(`magic:${token}`);

  // Create session token (48h sliding expiry — renews on active use)
  const sessionToken = crypto.randomUUID();
  await env.SESSIONS.put(`session:${sessionToken}`, email, {
    expirationTtl: SESSION_TTL_SECONDS,
    metadata: sessionMetadata(),
  });

  // For browser: redirect with cookie
  // For app: return the token in JSON
  const accept = request.headers.get("Accept") || "";
  if (accept.includes("application/json")) {
    return json({ ok: true, data: { session_token: sessionToken, email } });
  }

  const cookieHeader = `session=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;

  // A same-origin `next` (the /oauth/authorize URL an MCP client sent the user
  // here from, or an invite's /toc) means the click-through should land there
  // directly instead of bouncing through the "Opening PidginDocs…" deep-link page —
  // that page exists for the plain magic-link login case, where there's
  // nowhere else useful to send the browser.
  const safeNext = safeSameOriginNext(next, request.url);
  if (safeNext) {
    return new Response(null, {
      status: 302,
      headers: { Location: safeNext, "Set-Cookie": cookieHeader },
    });
  }

  // Browser: serve an HTML page that immediately hands control back to the native app
  // via the pidgin:// custom URL scheme, then falls back to a success message.
  const deepLink = `pidgin://auth/session?token=${encodeURIComponent(sessionToken)}&email=${encodeURIComponent(email)}`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Signed in — PidginDocs</title>
  <style>
    body { font-family: -apple-system, sans-serif; background: #f5efe8; color: #1a1a1a;
           display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #fff; border-radius: 16px; padding: 40px 32px; max-width: 360px;
            text-align: center; box-shadow: 0 2px 16px rgba(0,0,0,.08); }
    h1 { font-size: 22px; font-weight: 600; margin: 16px 0 8px; }
    p  { color: #666; font-size: 15px; margin: 0 0 24px; }
    a  { display: inline-block; background: #5a7c5a; color: #fff; text-decoration: none;
         padding: 12px 28px; border-radius: 10px; font-size: 16px; font-weight: 600; }
  </style>
  <script>window.location = ${JSON.stringify(deepLink)};</script>
</head>
<body>
  <div class="card">
    <div style="font-size:48px">🐦</div>
    <h1>Signed in</h1>
    <p>Opening PidginDocs&hellip;</p>
    <a href="${deepLink}">Open PidginDocs</a>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": cookieHeader,
    },
  });
}

// Browser-side counterpart to handleOAuthLogin (auth/oauth-login.ts), which is
// JSON-only and used by the native apps. This one is posted to directly by the
// SSO widgets rendered in loginPage() (web/index.ts) — Apple's web JS posts
// `id_token` with next/nonce packed into `state` (Apple only round-trips a
// single opaque state string). Google's redirect-mode button can't carry a
// custom state field, and its login_uri must byte-for-byte match a registered
// redirect URI (no query string), so next/nonce instead ride in a short-lived
// cookie set when loginPage() rendered the button.
// On success it sets the session cookie and 302s straight into `next` — for the
// MCP flow that's the original /oauth/authorize URL, which then completes the
// authorization-code exchange and redirects on to the MCP client.
export async function handleOAuthLoginWeb(
  request: Request,
  env: Env,
  provider: OAuthProvider
): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return await loginPage(env, "Sign-in failed: invalid request.");
  }

  let idToken: string | undefined;
  let next: string | undefined;
  let nonce: string | undefined;

  if (provider === "google") {
    idToken = (form.get("credential") as string) || undefined;
    const cookieMatch = (request.headers.get("Cookie") || "").match(/pidgin_g_oauth=([^;]+)/);
    const decoded = cookieMatch ? decodeOAuthWebState(cookieMatch[1]) : null;
    next = decoded?.next;
    nonce = decoded?.nonce;
  } else {
    idToken = (form.get("id_token") as string) || undefined;
    const decoded = decodeOAuthWebState((form.get("state") as string) || "");
    next = decoded?.next;
    nonce = decoded?.nonce;
  }

  const safeNext = safeSameOriginNext(next, request.url);

  const result = await verifyProviderIdToken(env, provider, idToken, nonce, {
    rateLimitScope: rateLimitScope(request),
  });
  if (!result.ok) {
    return await loginPage(env, result.error, safeNext);
  }

  const cookieHeader = `session=${result.sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
  return new Response(null, {
    status: 302,
    headers: { Location: safeNext || "/toc", "Set-Cookie": cookieHeader },
  });
}

export async function handleRegisterDevice(
  request: Request,
  env: Env
): Promise<Response> {
  const email = await verifySessionFromHeaders(request.headers, env.SESSIONS);
  if (!email) return json({ ok: false, error: "unauthorized" }, 401);

  // Look up user record
  const u = await env.DB.prepare(
    `SELECT id FROM users WHERE email = ? AND status = 'active'`
  ).bind(email.toLowerCase()).first<{ id: string }>();
  if (!u) return json({ ok: false, error: "unauthorized" }, 401);

  let body: { device_token?: string; token?: string; platform?: string };
  try {
    body = (await request.json()) as { device_token?: string; token?: string; platform?: string };
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const device_token = body.device_token || body.token;
  if (!device_token) {
    return json({ ok: false, error: "device_token required" }, 400);
  }
  const platform = normalizeDevicePlatform(body.platform);
  if (!platform) {
    return json({ ok: false, error: "platform must be one of: ios, macos" }, 400);
  }

  await env.DB.prepare(
    "INSERT OR REPLACE INTO device_tokens (token, platform, user_id) VALUES (?, ?, ?)"
  )
    .bind(device_token, platform, u.id)
    .run();

  return json({ ok: true, data: { registered: true, platform } });
}

function normalizeDevicePlatform(platform: string | undefined): "ios" | "macos" | null {
  const value = (platform || "ios").toLowerCase();
  if (value === "ios") return "ios";
  if (value === "macos" || value === "mac") return "macos";
  return null;
}

const DEFAULT_IOS_BUNDLE_ID = "org.pidgindocs.ios";

export function handleAppleAppSiteAssociation(env: Env): Response {
  const teamId = env.APNS_TEAM_ID;
  const iosBundleId = env.APNS_IOS_TOPIC || DEFAULT_IOS_BUNDLE_ID;
  const aasa = {
    applinks: {
      apps: [],
      details: teamId
        ? [{ appID: `${teamId}.${iosBundleId}`, paths: ["/auth/verify*", "/oauth/authorize*", "/a/*"] }]
        : [],
    },
  };
  return new Response(JSON.stringify(aasa), {
    headers: { "Content-Type": "application/json" },
  });
}

// Helper (duplicated from middleware to avoid circular import)
async function verifySessionFromHeaders(
  headers: Headers,
  sessions: KVNamespace
): Promise<string | null> {
  const auth = headers.get("Authorization");
  if (auth?.startsWith("Session ")) {
    const token = auth.slice(8);
    return sessions.get(`session:${token}`);
  }
  const cookie = headers.get("Cookie");
  if (!cookie) return null;
  const match = cookie.match(/session=([^;]+)/);
  if (!match) return null;
  return sessions.get(`session:${match[1]}`);
}

export async function handleInviteUser(
  request: Request,
  env: Env
): Promise<Response> {
  const authedUser = await resolveApiKeyUser(request.headers, env);
  if (!authedUser) return unauthorized();

  if (authedUser.email.toLowerCase() !== env.OWNER_EMAIL?.toLowerCase()) {
    return json({ ok: false, error: "only the owner can invite users" }, 403);
  }

  let body: { email?: string; label?: string };
  try {
    body = (await request.json()) as { email?: string; label?: string };
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }

  const inviteEmail = body.email?.toLowerCase().trim();
  if (!inviteEmail || !inviteEmail.includes("@")) {
    return json({ ok: false, error: "valid email required" }, 400);
  }

  const existing = await env.DB.prepare(
    "SELECT id, status FROM users WHERE email = ?"
  )
    .bind(inviteEmail)
    .first<{ id: string; status: string }>();

  if (existing?.status === "active") {
    return json({ ok: false, error: "user already registered" }, 409);
  }

  const userId = crypto.randomUUID().replace(/-/g, "");
  await env.DB.prepare(
    `INSERT INTO users (id, email, invited_by, status)
     VALUES (?, ?, ?, 'pending')
     ON CONFLICT(email) DO UPDATE SET invited_by = excluded.invited_by, status = 'pending'`
  )
    .bind(userId, inviteEmail, authedUser.email)
    .run();

  const token = crypto.randomUUID();
  await env.SESSIONS.put(
    `invite:${token}`,
    JSON.stringify({ email: inviteEmail, invited_by: authedUser.email }),
    { expirationTtl: 7 * 24 * 60 * 60 }
  );

  const workerUrl = env.WORKER_URL || new URL(request.url).origin;
  const inviteLink = `${workerUrl}/join?token=${token}`;

  try {
    await sendOwnerEmail(
      env,
      `You're invited to PidginDocs`,
      `<p>You've been invited by ${authedUser.email} to join PidginDocs.</p>
       <p><a href="${inviteLink}">Click here to get started</a></p>
       <p>This link expires in 7 days.</p>`,
      inviteEmail
    );
  } catch (err) {
    const message = mailDeliveryErrorMessage(env, err);
    return json({ ok: false, error: `failed to send invite email: ${message}` }, 502);
  }

  return json({ ok: true, data: { email: inviteEmail, expires_in: "7 days" } }, 201);
}

export async function handleAcceptInvite(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) return new Response("Missing token", { status: 400 });

  const raw = await env.SESSIONS.get(`invite:${token}`);
  if (!raw) {
    return new Response(
      "<!DOCTYPE html><html><body><p>This invite link has expired or already been used.</p></body></html>",
      { status: 410, headers: { "Content-Type": "text/html" } }
    );
  }

  const { email } = JSON.parse(raw) as { email: string; invited_by: string };

  await env.DB.prepare(
    "UPDATE users SET status = 'active' WHERE email = ?"
  )
    .bind(email)
    .run();

  const invited = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  if (!invited) return new Response("Invite could not be activated", { status: 500 });
  await ensurePersonalWorkspace(env, invited.id);

  await env.SESSIONS.delete(`invite:${token}`);

  const workerUrl = env.WORKER_URL || new URL(request.url).origin;
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${workerUrl}/auth/login-form?next=/toc&email=${encodeURIComponent(email)}`,
    },
  });
}
