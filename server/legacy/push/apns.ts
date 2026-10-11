import { Env } from "../types";

export const PIDGIN_NOTIFICATION_SOUND = "rock-dove-coo.caf";

interface APNsPayload {
  aps: {
    alert: { title: string; body: string };
    badge?: number;
    sound?: string;
    category?: string;
    "mutable-content"?: number;
    "content-available"?: number;
  };
  messageId?: string;
  msg_id?: string;
  conversationId?: string;
  type?: string;
}

export function buildAPNsPayload(
  title: string,
  body: string,
  messageId: string,
  type: string
): APNsPayload {
  const isQuestion = type === "question";
  // Documents wake the app in the background (content-available) so it can
  // pull the doc into its local cache before the user even taps.
  const isDocument = type === "document";
  // Chat pushes carry a CONVERSATION id, not a message id. It rides in its
  // own conversationId key — deliberately NOT messageId/msg_id, because
  // today's Apple clients deep-link those to /api/messages/{id}, which would
  // 404 on a conversation id. Until the apps grow a chat UI, a tap just
  // opens the app; the CHAT_MESSAGE category is reserved for that UI.
  if (type === "chat") {
    return {
      aps: {
        alert: { title, body },
        badge: 1,
        sound: PIDGIN_NOTIFICATION_SOUND,
        category: "CHAT_MESSAGE",
      },
      conversationId: messageId,
      type,
    };
  }
  return {
    aps: {
      alert: { title, body },
      badge: 1,
      sound: PIDGIN_NOTIFICATION_SOUND,
      ...(isQuestion ? { category: "QUESTION_REPLY", "mutable-content": 1 } : {}),
      ...(isDocument ? { "content-available": 1 } : {}),
    },
    messageId,
    msg_id: messageId,
    type,
  };
}

export type APNsPlatform = "ios" | "macos";

interface DeviceTokenRow {
  token: string;
  platform: string | null;
}

export async function sendPushNotification(
  env: Env,
  title: string,
  body: string,
  messageId: string,
  type: string,
  userId: string
): Promise<void> {
  if (!env.APNS_PRIVATE_KEY || !env.APNS_KEY_ID || !env.APNS_TEAM_ID) {
    return; // APNs not configured, skip silently
  }

  const result = await env.DB.prepare(
    "SELECT token, platform FROM device_tokens WHERE platform IN ('ios', 'macos') AND user_id = ?"
  )
    .bind(userId)
    .all<DeviceTokenRow>();

  if (result.results.length === 0) return;

  const jwt = await signAPNsJWT(env);
  const topics = apnsTopics(env);
  const payload = buildAPNsPayload(title, body, messageId, type);

  const host =
    env.ENVIRONMENT === "production"
      ? "https://api.push.apple.com"
      : "https://api.sandbox.push.apple.com";

  const promises = result.results.map(async (row) => {
    const deviceToken = row.token;
    const platform = normalizePlatform(row.platform);
    if (!platform) return;

    const topic = topics[platform];
    if (!topic) return;

    try {
      const response = await fetch(`${host}/3/device/${deviceToken}`, {
        method: "POST",
        headers: {
          Authorization: `bearer ${jwt}`,
          "apns-topic": topic,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (await shouldDeleteDeviceToken(response)) {
        await deleteDeviceToken(env, deviceToken);
      }
    } catch {
      await deleteDeviceToken(env, deviceToken);
    }
  });

  await Promise.allSettled(promises);
}

export function apnsTopicForPlatform(env: Env, platform: APNsPlatform): string | undefined {
  const legacyTopic = env.APNS_TOPIC;
  if (platform === "ios") return env.APNS_IOS_TOPIC || legacyTopic || "org.pidgindocs.ios";
  return env.APNS_MACOS_TOPIC || "org.pidgindocs.mac";
}

function apnsTopics(env: Env): Record<APNsPlatform, string | undefined> {
  return {
    ios: apnsTopicForPlatform(env, "ios"),
    macos: apnsTopicForPlatform(env, "macos"),
  };
}

function normalizePlatform(platform: string | null): APNsPlatform | null {
  if (platform === "ios" || platform === "macos") return platform;
  return null;
}

async function deleteDeviceToken(env: Env, deviceToken: string): Promise<void> {
  await env.DB.prepare("DELETE FROM device_tokens WHERE token = ?")
    .bind(deviceToken)
    .run();
}

async function shouldDeleteDeviceToken(response: Response): Promise<boolean> {
  if (response.status === 410) return true;
  if (response.status !== 400) return false;

  const body = await response.clone().json().catch(() => null) as { reason?: string } | null;
  return body?.reason === "BadDeviceToken" || body?.reason === "DeviceTokenNotForTopic";
}

async function signAPNsJWT(env: Env): Promise<string> {
  const header = btoa(
    JSON.stringify({ alg: "ES256", kid: env.APNS_KEY_ID })
  ).replace(/=/g, "");

  const now = Math.floor(Date.now() / 1000);
  const claims = btoa(
    JSON.stringify({ iss: env.APNS_TEAM_ID, iat: now })
  ).replace(/=/g, "");

  const signingInput = `${header}.${claims}`;

  // Import the .p8 private key
  const pemContents = env.APNS_PRIVATE_KEY.replace(
    /-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n|\r/g,
    ""
  );
  const keyData = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput)
  );

  // Convert DER signature to raw r||s format for JWT
  const sigArray = new Uint8Array(signature);
  const sigBase64 = btoa(String.fromCharCode(...sigArray))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  return `${signingInput}.${sigBase64}`;
}
