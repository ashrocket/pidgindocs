import { Env } from "../types";
import { json } from "../utils";
import { verifySession, unauthorized } from "../middleware";
import { getSetupStatus } from "../setup/status";
import { saveDestinationConfig } from "../destinations/store";
import { encryptValue } from "../crypto";
import type {
  CommuteConfig,
  Microsoft365Config,
} from "../destinations/types";
import { setupPage } from "../web/index";

interface BasePayload {
  type: "microsoft365" | "commute";
}

interface Microsoft365Payload extends BasePayload {
  type: "microsoft365";
  tenant_id: string;
  client_id: string;
  client_secret: string;
  refresh_token: string;
  teams_enabled: boolean;
  teams_team_id?: string;
  teams_channel_id?: string;
  sharepoint_enabled: boolean;
  sharepoint_site_id?: string;
  sharepoint_drive_id?: string;
  sharepoint_folder?: string;
  onedrive_enabled: boolean;
  onedrive_drive_id?: string;
  onedrive_folder?: string;
}

interface CommutePayload extends BasePayload {
  type: "commute";
  openai_api_key: string;
  tts_provider?: "openai" | "elevenlabs" | "gemini";
  voice?: string;
  model?: string;
  script_model?: string;
  speech_instructions?: string;
  elevenlabs_api_key?: string;
  elevenlabs_voice_id?: string;
  elevenlabs_model?: string;
  gemini_api_key?: string;
  gemini_voice?: string;
  gemini_model?: string;
  gemini_language_code?: string;
  minutes?: number;
}

type SetupPayload = Microsoft365Payload | CommutePayload;

function normalizeFolder(input?: string | null): string | undefined {
  if (!input) return undefined;
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^\/+/, "");
}

function requireField(value: string | null, label: string): string {
  if (!value || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function normalizeMinutes(value: string | number | null | undefined): number {
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 10) {
    throw new Error("minutes must be between 1 and 10");
  }
  return parsed;
}

function normalizeTtsProvider(value: string | null | undefined): "openai" | "elevenlabs" | "gemini" {
  return value === "elevenlabs" || value === "gemini" ? value : "openai";
}

async function persistPayload(env: Env, payload: SetupPayload): Promise<void> {
  if (payload.type === "commute") {
    const ttsProvider = normalizeTtsProvider(payload.tts_provider);
    if (ttsProvider === "elevenlabs") {
      requireField(payload.elevenlabs_api_key ?? null, "elevenlabs_api_key");
      requireField(payload.elevenlabs_voice_id ?? null, "elevenlabs_voice_id");
    }
    if (ttsProvider === "gemini") {
      requireField(payload.gemini_api_key ?? null, "gemini_api_key");
      requireField(payload.gemini_voice ?? null, "gemini_voice");
    }

    const encKey = env.COMMUTE_ENCRYPTION_KEY;
    const openai_api_key = encKey
      ? await encryptValue(payload.openai_api_key.trim(), encKey, "COMMUTE_ENCRYPTION_KEY")
      : payload.openai_api_key.trim();
    const elevenlabs_api_key = encKey && payload.elevenlabs_api_key?.trim()
      ? await encryptValue(payload.elevenlabs_api_key.trim(), encKey, "COMMUTE_ENCRYPTION_KEY")
      : payload.elevenlabs_api_key?.trim() || undefined;
    const gemini_api_key = encKey && payload.gemini_api_key?.trim()
      ? await encryptValue(payload.gemini_api_key.trim(), encKey, "COMMUTE_ENCRYPTION_KEY")
      : payload.gemini_api_key?.trim() || undefined;

    const config: CommuteConfig = {
      openai_api_key,
      tts_provider: ttsProvider,
      voice: payload.voice?.trim() || undefined,
      model: payload.model?.trim() || undefined,
      script_model: payload.script_model?.trim() || undefined,
      speech_instructions: payload.speech_instructions?.trim() || undefined,
      elevenlabs_api_key,
      elevenlabs_voice_id: payload.elevenlabs_voice_id?.trim() || undefined,
      elevenlabs_model: payload.elevenlabs_model?.trim() || undefined,
      gemini_api_key,
      gemini_voice: payload.gemini_voice?.trim() || undefined,
      gemini_model: payload.gemini_model?.trim() || undefined,
      gemini_language_code: payload.gemini_language_code?.trim() || undefined,
      minutes: normalizeMinutes(payload.minutes ?? 3),
    };
    await saveDestinationConfig(env, "commute", config);
    return;
  }

  if (payload.type === "microsoft365") {
    if (!env.M365_ENCRYPTION_KEY) {
      throw new Error("M365_ENCRYPTION_KEY is not configured");
    }
    // Validate required IDs for enabled outputs
    if (payload.teams_enabled) {
      requireField(payload.teams_team_id ?? null, "Team ID (required when Teams is enabled)");
      requireField(payload.teams_channel_id ?? null, "Channel ID (required when Teams is enabled)");
    }
    if (payload.sharepoint_enabled) {
      requireField(payload.sharepoint_drive_id ?? null, "SharePoint Drive ID (required when SharePoint is enabled)");
    }
    if (payload.onedrive_enabled) {
      requireField(payload.onedrive_drive_id ?? null, "OneDrive Drive ID (required when OneDrive is enabled)");
    }
    if (
      payload.sharepoint_enabled &&
      payload.onedrive_enabled &&
      payload.sharepoint_drive_id &&
      payload.onedrive_drive_id &&
      payload.sharepoint_drive_id.trim() === payload.onedrive_drive_id.trim()
    ) {
      throw new Error("SharePoint and OneDrive drive IDs must be different");
    }
    const client_secret = await encryptValue(
      payload.client_secret.trim(),
      env.M365_ENCRYPTION_KEY,
      "M365_ENCRYPTION_KEY",
    );
    const refresh_token = await encryptValue(
      payload.refresh_token.trim(),
      env.M365_ENCRYPTION_KEY,
      "M365_ENCRYPTION_KEY",
    );
    const config: Microsoft365Config = {
      tenant_id: payload.tenant_id.trim(),
      client_id: payload.client_id.trim(),
      client_secret,
      refresh_token,
      teams_enabled: payload.teams_enabled,
      teams_team_id: payload.teams_team_id?.trim() || "",
      teams_channel_id: payload.teams_channel_id?.trim() || "",
      sharepoint_enabled: payload.sharepoint_enabled,
      sharepoint_site_id: payload.sharepoint_site_id?.trim() || "",
      sharepoint_drive_id: payload.sharepoint_drive_id?.trim() || "",
      sharepoint_folder: normalizeFolder(payload.sharepoint_folder),
      onedrive_enabled: payload.onedrive_enabled,
      onedrive_drive_id: payload.onedrive_drive_id?.trim() || "",
      onedrive_folder: normalizeFolder(payload.onedrive_folder),
    };
    await saveDestinationConfig(env, "microsoft365", config);
    return;
  }
}

function payloadFromJson(body: any): SetupPayload {
  if (!body || typeof body !== "object" || typeof body.type !== "string") {
    throw new Error("invalid setup payload");
  }

  if (body.type === "microsoft365") {
    return {
      type: "microsoft365",
      tenant_id: requireField(body.tenant_id ?? null, "tenant_id"),
      client_id: requireField(body.client_id ?? null, "client_id"),
      client_secret: requireField(body.client_secret ?? null, "client_secret"),
      refresh_token: requireField(body.refresh_token ?? null, "refresh_token"),
      teams_enabled: body.teams_enabled !== false,
      teams_team_id: body.teams_team_id ? String(body.teams_team_id) : undefined,
      teams_channel_id: body.teams_channel_id ? String(body.teams_channel_id) : undefined,
      sharepoint_enabled: body.sharepoint_enabled !== false,
      sharepoint_site_id: body.sharepoint_site_id ? String(body.sharepoint_site_id) : undefined,
      sharepoint_drive_id: body.sharepoint_drive_id ? String(body.sharepoint_drive_id) : undefined,
      sharepoint_folder: body.sharepoint_folder ? String(body.sharepoint_folder) : undefined,
      onedrive_enabled: body.onedrive_enabled !== false,
      onedrive_drive_id: body.onedrive_drive_id ? String(body.onedrive_drive_id) : undefined,
      onedrive_folder: body.onedrive_folder ? String(body.onedrive_folder) : undefined,
    };
  }

  if (body.type === "commute") {
    return {
      type: "commute",
      openai_api_key: requireField(body.openai_api_key ?? null, "openai_api_key"),
      tts_provider: normalizeTtsProvider(body.tts_provider ? String(body.tts_provider) : undefined),
      voice: body.voice ? String(body.voice) : undefined,
      model: body.model ? String(body.model) : undefined,
      script_model: body.script_model ? String(body.script_model) : undefined,
      speech_instructions: body.speech_instructions
        ? String(body.speech_instructions)
        : undefined,
      elevenlabs_api_key: body.elevenlabs_api_key
        ? String(body.elevenlabs_api_key)
        : undefined,
      elevenlabs_voice_id: body.elevenlabs_voice_id
        ? String(body.elevenlabs_voice_id)
        : undefined,
      elevenlabs_model: body.elevenlabs_model
        ? String(body.elevenlabs_model)
        : undefined,
      gemini_api_key: body.gemini_api_key
        ? String(body.gemini_api_key)
        : undefined,
      gemini_voice: body.gemini_voice
        ? String(body.gemini_voice)
        : undefined,
      gemini_model: body.gemini_model
        ? String(body.gemini_model)
        : undefined,
      gemini_language_code: body.gemini_language_code
        ? String(body.gemini_language_code)
        : undefined,
      minutes: normalizeMinutes(body.minutes ?? 3),
    };
  }

  throw new Error("unknown setup type");
}

function payloadFromForm(form: FormData): SetupPayload {
  const type = form.get("type");
  if (type !== "microsoft365" && type !== "commute") {
    throw new Error("invalid setup type");
  }

  if (type === "commute") {
    return {
      type,
      openai_api_key: requireField(
        form.get("openai_api_key") as string | null,
        "OpenAI API key"
      ),
      tts_provider: normalizeTtsProvider(form.get("tts_provider") as string | null),
      voice: (form.get("voice") as string | null)?.trim() || undefined,
      model: (form.get("model") as string | null)?.trim() || undefined,
      script_model:
        (form.get("script_model") as string | null)?.trim() || undefined,
      speech_instructions:
        (form.get("speech_instructions") as string | null)?.trim() || undefined,
      elevenlabs_api_key:
        (form.get("elevenlabs_api_key") as string | null)?.trim() || undefined,
      elevenlabs_voice_id:
        (form.get("elevenlabs_voice_id") as string | null)?.trim() || undefined,
      elevenlabs_model:
        (form.get("elevenlabs_model") as string | null)?.trim() || undefined,
      gemini_api_key:
        (form.get("gemini_api_key") as string | null)?.trim() || undefined,
      gemini_voice:
        (form.get("gemini_voice") as string | null)?.trim() || undefined,
      gemini_model:
        (form.get("gemini_model") as string | null)?.trim() || undefined,
      gemini_language_code:
        (form.get("gemini_language_code") as string | null)?.trim() || undefined,
      minutes: normalizeMinutes(form.get("minutes") as string | null),
    };
  }

  return {
    type: type as "microsoft365",
    tenant_id: requireField(form.get("tenant_id") as string | null, "Tenant ID"),
    client_id: requireField(form.get("client_id") as string | null, "Client ID"),
    client_secret: requireField(form.get("client_secret") as string | null, "Client secret"),
    refresh_token: requireField(form.get("refresh_token") as string | null, "Refresh token"),
    teams_enabled: form.get("teams_enabled") === "on",
    teams_team_id: (form.get("teams_team_id") as string | null)?.trim() || undefined,
    teams_channel_id: (form.get("teams_channel_id") as string | null)?.trim() || undefined,
    sharepoint_enabled: form.get("sharepoint_enabled") === "on",
    sharepoint_site_id: (form.get("sharepoint_site_id") as string | null)?.trim() || undefined,
    sharepoint_drive_id: (form.get("sharepoint_drive_id") as string | null)?.trim() || undefined,
    sharepoint_folder: (form.get("sharepoint_folder") as string | null)?.trim() || undefined,
    onedrive_enabled: form.get("onedrive_enabled") === "on",
    onedrive_drive_id: (form.get("onedrive_drive_id") as string | null)?.trim() || undefined,
    onedrive_folder: (form.get("onedrive_folder") as string | null)?.trim() || undefined,
  };
}

export async function handleSetupApi(
  request: Request,
  env: Env
): Promise<Response> {
  const email = await verifySession(request.headers, env.SESSIONS);
  if (!email) {
    return unauthorized();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid JSON" }, 400);
  }

  try {
    const payload = payloadFromJson(body);
    await persistPayload(env, payload);
    const status = await getSetupStatus(env);
    return json({ ok: true, data: status });
  } catch (err) {
    const message = err instanceof Error ? err.message : "setup error";
    return json({ ok: false, error: message }, 400);
  }
}

export async function handleSetupForm(
  request: Request,
  env: Env
): Promise<Response> {
  const email = await verifySession(request.headers, env.SESSIONS);
  if (!email) {
    return unauthorized();
  }

  const form = await request.formData();

  try {
    const payload = payloadFromForm(form);
    await persistPayload(env, payload);
    const flash = payload.type === "microsoft365" ? "microsoft365" : "commute";
    return new Response(null, {
      status: 303,
      headers: { Location: `/setup?saved=${flash}` },
    });
  } catch (err) {
    const status = await getSetupStatus(env);
    const message = err instanceof Error ? err.message : "setup error";
    return setupPage(status, { error: message });
  }
}
