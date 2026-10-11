import type { Env } from "../types";
import {
  destinationConfigured,
  getDestinationConfigValue,
} from "../destinations/store";
import type { Microsoft365Config } from "../destinations/types";

export type SetupStep = "microsoft365" | "commute" | "done";

export interface SetupStatus {
  ready: boolean;
  currentStep: SetupStep;
  microsoft365: {
    configured: boolean;
    updated_at?: string;
    outputs?: Array<"teams" | "sharepoint" | "onedrive">;
    legacy?: boolean;
  };
  onedrive: { configured: boolean; updated_at?: string }; // deprecated alias
  commute: { configured: boolean; updated_at?: string };
  gchat: {
    configured: boolean;
    updated_at?: string;
    // false until the owner has messaged the PidginDocs app once in Google Chat
    // (apps can't create the DM themselves).
    dm_space_bound?: boolean;
  };
  matrix: {
    configured: boolean;
    updated_at?: string;
    // Set when the sync loop stopped on a fatal error (dead bot token);
    // cleared on the next successful sync or config re-save.
    last_error?: string | null;
  };
  push: {
    apns_configured: boolean;
    device_count: number;
  };
}

export async function getSetupStatus(env: Env): Promise<SetupStatus> {
  const [m365, legacyOnedrive, commute, gchat, matrix, deviceCountRow] = await Promise.all([
    destinationConfigured(env, "microsoft365"),
    destinationConfigured(env, "onedrive"),
    destinationConfigured(env, "commute"),
    destinationConfigured(env, "gchat_chat"),
    destinationConfigured(env, "matrix_chat"),
    env.DB.prepare("SELECT COUNT(*) as count FROM device_tokens WHERE platform = 'ios'").first<{ count: number }>(),
  ]);
  const apnsConfigured = Boolean(env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_PRIVATE_KEY);

  const m365configured = m365.configured || legacyOnedrive.configured;
  const isLegacy = !m365.configured && legacyOnedrive.configured;

  // Determine enabled outputs
  let outputs: Array<"teams" | "sharepoint" | "onedrive"> | undefined;
  if (m365.configured) {
    const config = await getDestinationConfigValue<Microsoft365Config>(
      env,
      "microsoft365",
    );
    if (config) {
      outputs = [];
      if (config.teams_enabled) outputs.push("teams");
      if (config.sharepoint_enabled) outputs.push("sharepoint");
      if (config.onedrive_enabled) outputs.push("onedrive");
    }
  } else if (isLegacy) {
    outputs = ["onedrive"];
  }

  const ready = m365configured && commute.configured;
  let currentStep: SetupStep = "microsoft365";
  if (!m365configured) {
    currentStep = "microsoft365";
  } else if (!commute.configured) {
    currentStep = "commute";
  } else {
    currentStep = "done";
  }

  const m365UpdatedAt = m365.configured
    ? m365.updated_at
    : legacyOnedrive.updated_at;

  let gchatDmSpaceBound: boolean | undefined;
  if (gchat.configured) {
    const gchatConfig = await getDestinationConfigValue<{ dm_space?: string | null }>(
      env,
      "gchat_chat",
    );
    gchatDmSpaceBound = Boolean(gchatConfig?.dm_space);
  }

  let matrixLastError: string | null | undefined;
  if (matrix.configured) {
    const matrixConfig = await getDestinationConfigValue<{ last_error?: string | null }>(
      env,
      "matrix_chat",
    );
    matrixLastError = matrixConfig?.last_error ?? null;
  }

  return {
    ready,
    currentStep,
    microsoft365: {
      configured: m365configured,
      updated_at: m365UpdatedAt,
      outputs,
      legacy: isLegacy || undefined,
    },
    onedrive: { configured: m365configured, updated_at: m365UpdatedAt },
    commute,
    gchat: {
      configured: gchat.configured,
      updated_at: gchat.updated_at,
      dm_space_bound: gchatDmSpaceBound,
    },
    matrix: {
      configured: matrix.configured,
      updated_at: matrix.updated_at,
      last_error: matrixLastError,
    },
    push: {
      apns_configured: apnsConfigured,
      device_count: deviceCountRow?.count ?? 0,
    },
  };
}
