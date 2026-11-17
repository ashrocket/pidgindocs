import { isAppleClientBundle } from "../apple-clients";
import { editionAppleApps } from "../edition-hooks";
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
  projectId?: string;
  inboxItemId?: string;
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
  // Agent board pushes carry a PROJECT id. The shipped Apple clients open any
  // messageId/msg_id as /api/messages/{id} (a 404 for a board) and attach an
  // inline reply to the QUESTION_REPLY category, so the id rides in projectId,
  // which they ignore, with no category: a tap just opens the app.
  if (type === "agent_board") {
    return {
      aps: {
        alert: { title, body },
        badge: 1,
        sound: PIDGIN_NOTIFICATION_SOUND,
      },
      projectId: messageId,
      type,
    };
  }
  // Inbox items (team events) carry an inbox item id, which is not a message
  // id either: like a board push it rides in its own key with no category,
  // so a tap opens the app.
  if (type === "inbox_item") {
    return {
      aps: {
        alert: { title, body },
        badge: 1,
        sound: PIDGIN_NOTIFICATION_SOUND,
      },
      inboxItemId: messageId,
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
  bundle_id?: string | null;
  apns_environment?: string | null;
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
    "SELECT token, platform, bundle_id, apns_environment FROM device_tokens WHERE platform IN ('ios', 'macos') AND user_id = ?"
  )
    .bind(userId)
    .all<DeviceTokenRow>();

  if (result.results.length === 0) return;

  const jwt = await signAPNsJWT(env);
  const payload = buildAPNsPayload(title, body, messageId, type);

  const promises = result.results.map(async (row) => {
    const deviceToken = row.token;
    const platform = normalizePlatform(row.platform);
    if (!platform) return;

    const topic = row.bundle_id ? (isAppleClientBundle(platform, row.bundle_id) ? row.bundle_id : undefined)
      : apnsTopicForPlatform(env, platform);
    const production = row.apns_environment ? row.apns_environment === 'production' : env.ENVIRONMENT === 'production';
    const host = production ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
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
      // A transient transport error does not invalidate a registered device.
    }
  });

  await Promise.allSettled(promises);
}

/** The APNs topic for a platform: an environment override first, then this deployment's app bundle ID. */
export function apnsTopicForPlatform(env: Env, platform: APNsPlatform): string | undefined {
  const apps = editionAppleApps();
  const legacyTopic = env.APNS_TOPIC;
  if (platform === "ios") return env.APNS_IOS_TOPIC || legacyTopic || apps.iosBundleId;
  return env.APNS_MACOS_TOPIC || apps.macosBundleId;
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
