import type { Env, MessagePayload } from "../types";
import type { EncryptedValue } from "../crypto";

export interface DocumentContext {
  id: string;
  docKey: string | null;
}

export interface MessageEnvelope {
  id: string;
  payload: MessagePayload;
  docKey: string | null;
  createdAt: string;
}

export interface DestinationResult {
  name: string;
  status: string;
}

export interface MessageDestination<T = unknown> {
  name: string;
  loadConfig(env: Env): Promise<T | null>;
  supports(envelope: MessageEnvelope): boolean;
  deliver(env: Env, envelope: MessageEnvelope, config: T): Promise<string>;
}

export interface OneDriveConfig {
  tenant_id: string;
  client_id: string;
  client_secret: string;
  refresh_token: string;
  drive_id: string;
  folder?: string;
}

export interface CommuteConfig {
  openai_api_key: string | EncryptedValue;
  tts_provider?: "openai" | "elevenlabs" | "gemini";
  voice?: string;
  model?: string;
  script_model?: string;
  speech_instructions?: string;
  elevenlabs_api_key?: string | EncryptedValue;
  elevenlabs_voice_id?: string;
  elevenlabs_model?: string;
  gemini_api_key?: string | EncryptedValue;
  gemini_voice?: string;
  gemini_model?: string;
  gemini_language_code?: string;
  minutes?: number;
}

export interface Microsoft365Config {
  tenant_id: string;
  client_id: string;
  client_secret: EncryptedValue;
  refresh_token: EncryptedValue;

  teams_enabled: boolean;
  teams_team_id: string;
  teams_channel_id: string;

  sharepoint_enabled: boolean;
  sharepoint_site_id: string;
  sharepoint_drive_id: string;
  sharepoint_folder?: string;

  onedrive_enabled: boolean;
  onedrive_drive_id: string;
  onedrive_folder?: string;
}

export interface ResolvedMicrosoft365Config
  extends Omit<Microsoft365Config, "client_secret" | "refresh_token"> {
  client_secret: string;
  refresh_token: string;
}
