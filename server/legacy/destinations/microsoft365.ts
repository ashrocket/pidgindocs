import type { Env } from "../types";
import { decryptValue } from "../crypto";
import type {
  MessageDestination,
  MessageEnvelope,
  Microsoft365Config,
  OneDriveConfig,
  ResolvedMicrosoft365Config,
} from "./types";
import { getDestinationConfigValue } from "./store";

async function loadAndDecryptConfig(
  env: Env,
): Promise<ResolvedMicrosoft365Config | null> {
  const config = await getDestinationConfigValue<Microsoft365Config>(
    env,
    "microsoft365",
  );

  if (config) {
    if (!env.M365_ENCRYPTION_KEY) {
      console.error(
        "[destination:microsoft365] M365_ENCRYPTION_KEY not set — cannot decrypt credentials",
      );
      return null;
    }
    if (!config.teams_enabled && !config.sharepoint_enabled && !config.onedrive_enabled) {
      return null;
    }
    try {
      const client_secret = await decryptValue(
        config.client_secret,
        env.M365_ENCRYPTION_KEY,
        "M365_ENCRYPTION_KEY",
      );
      const refresh_token = await decryptValue(
        config.refresh_token,
        env.M365_ENCRYPTION_KEY,
        "M365_ENCRYPTION_KEY",
      );
      return { ...config, client_secret, refresh_token };
    } catch (err) {
      console.error("[destination:microsoft365] unable to decrypt credentials", err);
      return null;
    }
  }

  // Legacy fallback: read old onedrive row
  const legacy = await getDestinationConfigValue<OneDriveConfig>(env, "onedrive");
  if (!legacy) return null;

  console.warn(
    "[microsoft365] running on legacy onedrive config — visit /setup to enable Teams and SharePoint",
  );
  return {
    tenant_id: legacy.tenant_id,
    client_id: legacy.client_id,
    client_secret: legacy.client_secret,
    refresh_token: legacy.refresh_token,
    teams_enabled: false,
    teams_team_id: "",
    teams_channel_id: "",
    sharepoint_enabled: false,
    sharepoint_site_id: "",
    sharepoint_drive_id: "",
    onedrive_enabled: true,
    onedrive_drive_id: legacy.drive_id,
    onedrive_folder: legacy.folder,
  };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "message";
}

function encodePath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function markdownBody(env: Env, envelope: MessageEnvelope): string {
  const instance = envelope.payload.instance;
  const lines = [
    `# ${envelope.payload.title}`,
    "",
    `- Type: ${envelope.payload.type}`,
    `- Project: ${instance.project}`,
    `- Session: ${instance.session_id}`,
    `- Model: ${instance.model}`,
    `- Priority: ${envelope.payload.priority || "normal"}`,
    `- Created: ${envelope.createdAt}`,
    "",
  ];
  if (envelope.payload.body) {
    lines.push(envelope.payload.body);
  } else {
    lines.push("(no body provided)");
  }
  const workerUrl = (env.WORKER_URL || "").replace(/\/+$/, "");
  if (workerUrl) {
    lines.push("", `PidginDocs message ID: ${envelope.id}`, `Inbox: ${workerUrl}/`);
    if (envelope.payload.type === "document") {
      lines.push(`Document: ${workerUrl}/docs/${envelope.id}`);
    }
  }
  return lines.join("\n");
}

async function getDocHtml(env: Env, docKey: string | null): Promise<string | null> {
  if (!docKey) return null;
  const obj = await env.DOCS.get(docKey);
  if (!obj) return null;
  return obj.text();
}

async function exchangeToken(config: ResolvedMicrosoft365Config): Promise<string> {
  const params = new URLSearchParams({
    client_id: config.client_id,
    client_secret: config.client_secret,
    refresh_token: config.refresh_token,
    grant_type: "refresh_token",
    scope: "https://graph.microsoft.com/.default offline_access",
  });
  const resp = await fetch(
    `https://login.microsoftonline.com/${config.tenant_id}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    },
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`graph token ${resp.status}: ${text.slice(0, 120)}`);
  }
  const data = (await resp.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("graph token missing access_token");
  return data.access_token;
}

function makeFilename(envelope: MessageEnvelope, ext: string): string {
  const timestamp = envelope.createdAt
    .replace(/:/g, "-")
    .replace(/\..+$/, "")
    .replace(/T/, "-");
  const slug = slugify(
    `${envelope.payload.instance.project}-${envelope.payload.title}`,
  );
  return `${timestamp}-${slug}.${ext}`;
}

async function uploadToDrive(
  token: string,
  driveId: string,
  folder: string | undefined,
  fileName: string,
  contentType: string,
  body: string,
): Promise<void> {
  const folderPath = folder ? folder.replace(/\/+$/, "") : "";
  const fullPath = encodePath(folderPath ? `${folderPath}/${fileName}` : fileName);
  const url = `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${fullPath}:/content`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`upload ${resp.status}: ${text.slice(0, 120)}`);
  }
}

async function deliverToOneDrive(
  env: Env,
  token: string,
  envelope: MessageEnvelope,
  config: ResolvedMicrosoft365Config,
): Promise<string> {
  const isDoc = envelope.payload.type === "document";
  let contentType = "text/markdown; charset=utf-8";
  let body = markdownBody(env, envelope);
  let ext = "md";

  if (isDoc) {
    const html = await getDocHtml(env, envelope.docKey);
    if (html) {
      contentType = "text/html; charset=utf-8";
      body = html;
      ext = "html";
    }
  }

  const fileName = makeFilename(envelope, ext);
  await uploadToDrive(token, config.onedrive_drive_id, config.onedrive_folder, fileName, contentType, body);
  return `onedrive: uploaded ${fileName}`;
}

function buildAdaptiveCard(env: Env, envelope: MessageEnvelope): string {
  const instance = envelope.payload.instance;
  const workerUrl = (env.WORKER_URL || "").replace(/\/+$/, "");

  const body: Array<Record<string, unknown>> = [
    {
      type: "TextBlock",
      text: truncate(envelope.payload.title, 200),
      weight: "Bolder",
      size: "Medium",
      wrap: true,
    },
    {
      type: "FactSet",
      facts: [
        { title: "Project", value: instance.project },
        { title: "Model", value: instance.model },
        { title: "Priority", value: envelope.payload.priority || "normal" },
        { title: "Type", value: envelope.payload.type },
      ],
    },
  ];

  if (envelope.payload.body?.trim()) {
    body.push({
      type: "TextBlock",
      text: truncate(envelope.payload.body.trim(), 500),
      wrap: true,
    });
  }

  const actions: Array<Record<string, unknown>> = [];
  if (workerUrl) {
    actions.push({
      type: "Action.OpenUrl",
      title: "View in PidginDocs",
      url: `${workerUrl}/`,
    });
    if (envelope.payload.type === "document") {
      actions.push({
        type: "Action.OpenUrl",
        title: "View Doc",
        url: `${workerUrl}/docs/${envelope.id}`,
      });
    }
  }
  if (envelope.payload.source_url) {
    actions.push({
      type: "Action.OpenUrl",
      title: "View context",
      url: envelope.payload.source_url,
    });
  }

  body.push({
    type: "TextBlock",
    text: `${envelope.createdAt} · ${instance.session_id}`,
    size: "Small",
    isSubtle: true,
    wrap: true,
  });

  const card: Record<string, unknown> = {
    type: "AdaptiveCard",
    version: "1.4",
    body,
  };
  if (actions.length > 0) {
    card.actions = actions;
  }

  return JSON.stringify(card);
}

async function deliverToTeams(
  env: Env,
  token: string,
  envelope: MessageEnvelope,
  config: ResolvedMicrosoft365Config,
): Promise<string> {
  const cardJson = buildAdaptiveCard(env, envelope);
  const attachmentId = "pidgin-card";

  const messagePayload = {
    body: {
      contentType: "html",
      content: `<attachment id="${attachmentId}"></attachment>`,
    },
    attachments: [
      {
        id: attachmentId,
        contentType: "application/vnd.microsoft.card.adaptive",
        content: cardJson,
      },
    ],
  };

  const url = `https://graph.microsoft.com/v1.0/teams/${config.teams_team_id}/channels/${config.teams_channel_id}/messages`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(messagePayload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`teams ${resp.status}: ${text.slice(0, 120)}`);
  }

  return "teams: posted";
}

async function deliverToSharePoint(
  env: Env,
  token: string,
  envelope: MessageEnvelope,
  config: ResolvedMicrosoft365Config,
): Promise<string | null> {
  if (envelope.payload.type !== "document") return null;

  const html = await getDocHtml(env, envelope.docKey);
  if (!html) return null;

  const fileName = makeFilename(envelope, "html");
  await uploadToDrive(
    token,
    config.sharepoint_drive_id,
    config.sharepoint_folder,
    fileName,
    "text/html; charset=utf-8",
    html,
  );
  return `sharepoint: uploaded ${fileName}`;
}

export const microsoft365Destination: MessageDestination<ResolvedMicrosoft365Config> = {
  name: "microsoft365",

  async loadConfig(env: Env) {
    return loadAndDecryptConfig(env);
  },

  supports(envelope: MessageEnvelope): boolean {
    return envelope.payload.type !== "status";
  },

  async deliver(
    env: Env,
    envelope: MessageEnvelope,
    config: ResolvedMicrosoft365Config,
  ) {
    const token = await exchangeToken(config);
    const outputs: Array<Promise<string>> = [];

    if (config.teams_enabled) {
      outputs.push(deliverToTeams(env, token, envelope, config));
    }

    if (config.sharepoint_enabled && envelope.payload.type === "document") {
      outputs.push(
        deliverToSharePoint(env, token, envelope, config).then(
          (r) => r || "",
        ),
      );
    }

    if (config.onedrive_enabled) {
      outputs.push(deliverToOneDrive(env, token, envelope, config));
    }

    const settled = await Promise.allSettled(outputs);
    const results: string[] = [];
    for (const s of settled) {
      if (s.status === "fulfilled") {
        results.push(s.value);
      } else {
        results.push(`error: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`);
      }
    }
    return results.filter(Boolean).join("; ");
  },
};
