export interface Env {
  WEB_OBSERVABILITY?: string;
  DB: D1Database;
  DOCS: R2Bucket;
  // Separate, tenant-local governance evidence bucket; never use DOCS as a fallback.
  GOVERNANCE_EVIDENCE?: R2Bucket;
  SESSIONS: KVNamespace;
  ENHANCE_QUEUE: Queue<EnhanceJob>;
  MAIL?: {
    send(message: unknown): Promise<void>;
  };
  API_KEY: string;
  OWNER_EMAIL: string;
  // Super-admin key for /api/admin/* (owner-only). Unset = admin API disabled.
  ADMIN_API_KEY?: string;
  MAIL_FROM?: string;
  RESEND_FROM?: string;
  RESEND_API_KEY?: string;
  // Anthropic API key for server-side document enhancement + design-system
  // import. Unset = enhancement features are rejected with a clear error.
  ANTHROPIC_API_KEY?: string;
  // Optional override for web text translation; uses the existing server key.
  TRANSLATION_MODEL?: string;
  // Comma-separated tenant allowlist for UI and content translation.
  WEB_LANGUAGES?: string;
  // ElevenLabs text-to-speech for audio narration. All optional. Without a key
  // here or one in the Setup commute config, a narration keeps its transcript
  // only. Key order: this secret, then the commute config key.
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_VOICE_ID?: string;
  ELEVENLABS_MODEL_ID?: string;
  APNS_KEY_ID: string;
  APNS_TEAM_ID: string;
  APNS_PRIVATE_KEY: string;
  APNS_TOPIC?: string;
  APNS_IOS_TOPIC?: string;
  APNS_MACOS_TOPIC?: string;
  // Web Push (VAPID) — optional; unconfigured = web push disabled
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  WORKER_URL: string;
  // Optional URL path prefix such as "/alice" for a Solo deployment served at
  // https://example.com/alice. Unset or empty means the app lives at the origin root
  // (Teams tenants, self-hosted). See core/base-path.ts.
  BASE_PATH?: string;
  // Separate browser origin used for scripted artifact iframes. Production
  // uses a dedicated worker domain.
  ARTIFACT_EMBED_ORIGIN?: string;
  ENVIRONMENT: string;
  // External notification providers (all optional — unconfigured = disabled)
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
  WHATSAPP_TOKEN?: string;
  WHATSAPP_PHONE_ID?: string;
  WHATSAPP_TO?: string;
  TELNYX_API_KEY?: string;
  TELNYX_FROM_NUMBER?: string;
  TELNYX_TO_NUMBER?: string;
  M365_ENCRYPTION_KEY?: string;
  // Per-person delegated Microsoft Teams read inclusion (separate from the
  // older owner-wide Microsoft 365 posting destination). IDs are non-secret;
  // client credentials and the 32-byte token key are Worker secrets.
  TEAMS_INCLUSIONS?: string;
  /** Per-tenant Bulletin closing and ticket-link rules (JSON; see core/bulletin-lifecycle.ts). */
  BULLETIN_RULES?: string;
  /** Tenant-local JSON {team_id, users: {verified_user_id: inline_chars}}; capped at 6000. */
  AGENT_BOARD_INLINE_LIMITS?: string;
  TEAMS_INCLUSION_CLIENT_ID?: string;
  TEAMS_INCLUSION_CLIENT_SECRET?: string;
  TEAMS_INCLUSION_ENCRYPTION_KEY?: string;
  COMMUTE_ENCRYPTION_KEY?: string;
  // Encrypts the Google Chat service-account key at rest (chat channel).
  GCHAT_ENCRYPTION_KEY?: string;
  // Encrypts the Matrix bot access token at rest (chat channel).
  MATRIX_ENCRYPTION_KEY?: string;
  // Durable Object running the Matrix /v3/sync long-poll loop (inbound chat).
  // Optional so hand-built test Envs stay valid; code must guard absence.
  MATRIX_SYNC?: DurableObjectNamespace;
  // Durable Object holding team event sockets and waiting requests, one per
  // team (idFromName(team_id)) plus one per person for their own inbox's
  // events (idFromName("user:<id>")); see src/events/team-events-do.ts.
  // Optional so hand-built test Envs stay valid; code must guard absence.
  TEAM_EVENTS?: DurableObjectNamespace;
  // Maximum age of one team event socket in seconds (default 900). Tests only.
  EVENTS_SOCKET_TTL_SECONDS?: string;
  DOC_SHARE_SECRET?: string;
  // SSO sign-in (optional — unset = that provider disabled)
  // Apple: comma-separated bundle IDs to accept as the token audience.
  // Defaults to the iOS + macOS bundle IDs when unset.
  APPLE_AUDIENCES?: string;
  // Google: the OAuth client ID that issued the id_token (its audience).
  GOOGLE_CLIENT_ID?: string;
  // Web SSO buttons on the /oauth/authorize login page (unset = button
  // hidden). These are DIFFERENT credential types than the native-app ones
  // above: a Google "Web application" OAuth client, and an Apple "Services ID"
  // with Sign in with Apple enabled — not the app bundle IDs / iOS client ID.
  // Accepted as a token audience automatically alongside GOOGLE_CLIENT_ID.
  GOOGLE_WEB_CLIENT_ID?: string;
  // Apple's web Services ID. Its value must ALSO be appended to the
  // comma-separated APPLE_AUDIENCES above — that's what actually authorizes
  // the token audience; this var only controls what's rendered client-side.
  APPLE_WEB_SERVICE_ID?: string;
  ENTRA_CLIENT_ID?: string;
  ENTRA_CLIENT_SECRET?: string;
  ENTRA_DEFAULT_TEAM_ID?: string;
  // Absolute lifetime of an Entra browser/native session. A tenant may set seven days.
  ENTRA_SESSION_TTL_SECONDS?: string;
  // Explicit migration from a known Entra tenant:object to a legacy user ID.
  ENTRA_ACCOUNT_BINDINGS?: string;
  // Help assistant (server/src/core/help/assistant.ts). Workers AI binding;
  // absent = answers fall back to the best-matching help articles.
  AI?: Ai;
  // Overrides for the generation and embedding models.
  HELP_AI_MODEL?: string;
  HELP_EMBED_MODEL?: string;
  // "false" turns off every AI call for help (lexical article matches only).
  HELP_ASK_ENABLED?: string;
}

export type EnhanceLevel = "polish" | "enrich" | "research";
export type DocumentKind = "doc" | "decision_memo" | "meeting_note" | "spec" | "runbook";
export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";
export type WorkspaceResourceType = "message" | "artifact" | "document" | "decision_memo";
export type AgentProjectPermission = "read" | "write";
export type AgentBoardKind = "s" | "c" | "h" | "d" | "b" | "n";

// Jobs on the pidgin-enhance queue. "enhance" rewrites a published document
// as version 2 of its doc_slug; "import" translates raw design material into
// a stored design system.
export type EnhanceJob =
  | {
      kind: "enhance";
      docId: string;
      level: EnhanceLevel;
      instructions?: string;
      designSystemName: string;
      userId: string | null;
    }
  | {
      kind: "import";
      name: string;
      material: string;
      userId: string;
    }
  | {
      kind: "audio";
      audioId: string;
      userId: string;
    };

export interface NotifyPayload {
  source: "personal" | "work";
  context: string;
  repo?: string;
  session_name?: string;
}

export interface Provider {
  name: string;
  isConfigured(env: Env): boolean;
  send(message: string, payload: NotifyPayload, env: Env): Promise<string>;
}

export interface MessagePayload {
  sharing?: "private" | "shared";
  type: "message" | "question" | "status" | "document";
  title: string;
  body?: string;
  html?: string;
  markdown?: string;
  doc_kind?: DocumentKind;
  team_id?: string;
  project_id?: string;
  public?: boolean;
  priority?: "normal" | "urgent";
  source_url?: string;
  slug?: string;
  design_system?: string;
  enhance?: string;
  instructions?: string;
  // Serve via /idoc/:id with scripts executable (strict no-network CSP, no
  // protection wrapper). Requires raw html input.
  interactive?: boolean;
  blocks?: MessageBlockInput[];
  // Publish a new version of an existing document: doc_id is any version's id,
  // base_version the version the caller last saw (409 on mismatch unless force).
  doc_id?: string;
  base_version?: number;
  force?: boolean;
  // Status only: fold this update into the open status item, then close it.
  final?: boolean;
  instance: InstanceIdentity;
}

export type MessageBlockInput =
  | {
      type: "markdown";
      markdown: string;
    }
  | {
      type: "artifact";
      artifact_id: string;
      version?: number;
      label?: string;
      producer?: string;
      producer_action?: string;
      summary: string;
      collapsed?: boolean;
    };

export interface InstanceIdentity {
  model: string;
  session_id: string;
  project: string;
  source: string;
}

export interface ReplyPayload {
  message_id: string;
  reply: string;
}

export type ApiResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export interface User {
  id: string;
  email: string;
  invited_by: string | null;
  created_at: string;
  status: "active" | "pending";
}

export interface Team {
  id: string;
  slug: string;
  name: string;
  owner_user_id: string;
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: string;
  team_id: string;
  slug: string;
  name: string;
  description: string | null;
  board_kind?: "project" | "commons" | "work";
  pinned: number;
  archived_at: string | null;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
}

export interface TeamMembership {
  team_id: string;
  user_id: string;
  role: WorkspaceRole;
  created_at: string;
}

export interface WorkspaceComment {
  id: string;
  team_id: string;
  project_id: string | null;
  resource_type: WorkspaceResourceType;
  resource_id: string;
  parent_id: string | null;
  body: string;
  status: "open" | "resolved";
  author_user_id: string;
  created_at: string;
  updated_at: string;
}

export interface AgentIdentity {
  id: string;
  team_id: string;
  slug: string;
  name: string;
  provider: string | null;
  status: "active" | "revoked";
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

export interface AgentProjectGrant {
  agent_id: string;
  project_id: string;
  permission: AgentProjectPermission;
  created_by_user_id: string;
  created_at: string;
}

export interface AgentBoardPrincipal {
  agentId: string;
  teamId: string;
  slug: string;
  name: string;
  projectId: string;
  permission: AgentProjectPermission;
  keyHash: string;
  userId: string;
}

export interface AgentSessionMetadata {
  session_id: string;
  session_name: string | null;
  model: string | null;
  model_version: string | null;
  origin: string;
  origin_version: string | null;
}

export interface AgentBoardEntry {
  seq: number;
  id: string;
  team_id: string;
  project_id: string;
  project_slug: string;
  project_name: string;
  agent_id: string;
  agent_slug: string;
  agent_name: string;
  kind: AgentBoardKind;
  topic: string;
  body: string;
  reference: string | null;
  client_message_id: string;
  created_at: string;
  user_id: string | null;
  session_id: string | null;
  session_name: string | null;
  model: string | null;
  model_version: string | null;
  origin: string | null;
  origin_version: string | null;
}

export interface AuthedApiUser {
  userId: string;
  email: string;
}
