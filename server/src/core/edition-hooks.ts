import type { OAuthTokenRecord } from "./oauth-tokens";
// PidginCore extension points. An
// edition installs its hooks once, when its Worker module loads
// (the hosted edition's installer, imported first by its Worker entry). Each deployment
// serves one customer, so these hooks never hold two customers' settings. Without
// an edition (self-hosted PidginCore) every check below allows the action.
import type { Env, WorkspaceResourceType } from "./types";
import { coreLoginPage } from "./web/login";
import { appPath } from "./base-path";
import type { ShellConfig } from "./web/app-shell";
import type { ReaderLabels } from "./documents/operator-reader";
import type { EditionTicketResolver } from "./bulletin-lifecycle";

/** The deployment may not take this write now, for example because access has ended. */
export class TenantWriteRefused extends Error {
  constructor(message: string, readonly status: number, readonly reason: string) {
    super(message);
    this.name = "TenantWriteRefused";
  }
}

/** A plan limit refuses this action, for example a seat or storage limit. */
export class PlanLimitRefused extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
  }
}

/** What a metered action counts. */
export type UsageMetric = "storage_bytes" | "deliveries" | "ai_actions" | "transfer_bytes" | "active_artifacts";

/** A metered action is refused: access has ended, a limit is reached, or the meter is unavailable. Editions extend it. */
export class UsageRefused extends Error {
  constructor(message: string, readonly status: number, readonly metric?: UsageMetric, readonly usage?: unknown) {
    super(message);
  }
}

/** The result of reserving or releasing metered usage. `managed` is true when the edition counted it. */
export interface UsageReservation { managed: boolean; replayed?: boolean; usage?: unknown }

/** The limits that an edition sets on one account. */
export interface AccountLimits { max_upload_bytes: number; versions_per_artifact: number }

/** SQL pieces for the API-key lookup (alias `ak` for the key, the user alias for the person); a hook returns bind-free text. */
export interface ApiKeyAccountSql {
  /** A JOIN clause, or an empty string. */
  join: string;
  /** A condition that is true when the account is active. */
  active: string;
  /** An expression for when access ends (a date-time), or NULL for never. */
  endsAt: string;
}

/** A mention in a post or comment was refused (for example, the person is not a team member). Editions extend it. */
export class MentionRejected extends Error {}

/** A mention to store once its resource exists. */
export interface MentionRecord {
  teamId: string; authorId: string; recipients: string[]; resourceType: WorkspaceResourceType;
  resourceId: string; sourceKind: "post" | "comment"; sourceId: string; text: string;
}

/** An MCP tool that an edition adds. */
export interface ContentStoredInput { userId: string; kind: "message" | "document" | "artifact"; id: string }

export interface EditionMcpTool { name: string; description: string; inputSchema: Record<string, unknown>; [key: string]: unknown }
/** The result of an edition tool call made through people's connections. */
export interface EditionToolResult { text: string; data?: unknown; isError?: boolean }
/** The result of an edition board tool: the API response it wraps, or a refusal message. */
export type EditionBoardToolOutcome = { response: Response } | { error: string };

/** A scheduled job that an edition adds. A failure is logged and does not stop the other jobs. */
export interface EditionScheduledJob {
  /** Logged with the error when the job throws. */
  failure: string;
  /** Returns a line to log, or null for nothing. */
  run(env: Env, scheduledAt: Date): Promise<string | null>;
}

/** The native Apple apps of this deployment. Each field is undefined or empty when the deployment has no such app. */
export interface AppleApps {
  /** The Apple developer team ID that signs the apps. */
  teamId?: string;
  /** The bundle ID of the iOS app. */
  iosBundleId?: string;
  /** The bundle ID of the macOS app. */
  macosBundleId?: string;
  /** Bundle IDs that may register devices and fetch client builds, per platform. */
  clientBundles: { ios: readonly string[]; macos: readonly string[] };
  /** Audiences that Apple sign-in tokens may carry for this deployment. */
  signInAudiences: readonly string[];
}

/** A sign-in identity shown on the profile page. */
export interface AccountIdentity { email: string; provider: string; primary: boolean; created_at?: string }

/** The product names of this deployment: the name people read in pages, emails and prompts, the User-Agent of outbound audio fetches, and the mark and footer of typeset documents. */
export interface ProductIdentity {
  /** The name of the product in text that people read: page titles, headings, messages and prompts. Use plain text without markup characters, because it goes into pages, emails and prompts without escaping. */
  name: string;
  /** The User-Agent header that outbound audio fetches send. */
  userAgent: string;
  /** The text of the mark at the top of each typeset document; empty for no mark. */
  documentMark: string;
  /** The footer lines of each typeset document, in order. */
  documentFooter: readonly string[];
  /** The colors that the artifact tool tells authors the default page layouts use, as a phrase such as `light teal, mint, sand, and white`. */
  houseColors: string;
  /** The default email From header, used only when neither RESEND_FROM nor MAIL_FROM is set. */
  mailFrom: string;
}

/**
 * The names an outside party sees on the wire: token prefixes, the sign-in realm, MCP names, the
 * artifact runtime credential and the live events subprotocol. A client that holds a token or a
 * published artifact keeps working only while these stay the same, so an edition sets the values
 * its clients already use. Every value is a constant of the edition and never comes from a request.
 * Use plain ASCII: some values go into a header, a regular expression or a script without escaping.
 */
export interface WireFormat {
  /** Starts every token and code the deployment issues: OAuth codes, access and refresh tokens and device codes add a short kind after it, such as `at_`. Ends with an underscore. */
  tokenPrefix: string;
  /** The realm in the WWW-Authenticate header of an OAuth 401. */
  authRealm: string;
  /** The server name that MCP clients see, and that agent setup snippets write. */
  mcpServerName: string;
  /** What starts each MCP tool name that clients see. Core names every tool `pidgin_*` and shows the edition prefix when it differs. Ends with an underscore. */
  mcpToolPrefix: string;
  /** The Authorization scheme of the short-lived credential that an artifact's scripts send to the runtime API. */
  artifactAuthScheme: string;
  /** Text added in front of the payload when that credential is signed. Changing it ends every credential in use. */
  artifactHmacContext: string;
  /** A second name for `window.pidgin` in artifact scripts, kept so published artifacts keep working; an empty string for none. */
  runtimeGlobalAlias: string;
  /** The WebSocket subprotocol of the live events socket. */
  eventsSubprotocol: string;
  /** A lowercase word, such as `pidgin`, that core uses to build internal and stored names: the live events internal headers (`X-<Slug>-Stream`), log event names (`<slug>.request_error`), stored source labels and audit ids, the document banner id, and the in-app link key of a ticket rule. Letters only. Changing it renames stored and logged names. */
  slug: string;
  /** Starts the environment variable names that agent setup snippets write: `<prefix>_AGENT_KEY` and `<prefix>_AGENT_AUTHORIZATION`. */
  agentEnvPrefix: string;
}

/** The names of the tables that hold OAuth connections, codes and device logins. They are constants of the edition. */
export interface TableNames {
  oauthConnections: string;
  oauthRefresh: string;
  oauthCodes: string;
  oauthConsents: string;
  oauthLegacyConsumed: string;
  deviceLogins: string;
}

export interface EditionHooks {
  /** Throws a TenantWriteRefused when the deployment may not write product content. */
  assertWritable(env: Env): Promise<void>;
  /** A refusal message when the plan of this user or team blocks access, or null. */
  accessError(env: Env, scope: { userId?: string; teamId?: string }): Promise<string | null>;
  /** Records stored bytes against a plan. True when the edition metered it. Throws PlanLimitRefused over a limit. */
  recordStorage(env: Env, userId: string, bytes: number, idempotencyKey: string): Promise<boolean>;
  /** Scheduled plan settlement. */
  settlePlans(env: Env): Promise<{ debited: number; due: number }>;
  /** Counts usage before an action that stores or delivers content. Throws UsageRefused over a limit or when access has ended. */
  reserveUsage(env: Env, userId: string, metric: UsageMetric, amount: number, idempotencyKey: string): Promise<UsageReservation>;
  /** Gives counted usage back, for example when an action fails or content is deleted. */
  releaseUsage(env: Env, userId: string, metric: UsageMetric, amount: number, idempotencyKey: string): Promise<UsageReservation>;
  /** The limits of this user's account, or null when it has none. Throws UsageRefused when access has ended. */
  accountLimits(env: Env, userId: string): Promise<AccountLimits | null>;
  /** SQL condition, true when the account of the user row with this alias may sign in and act. Bind-free. */
  accountActiveSql(userAlias: string): string;
  /** SQL pieces for the API-key lookup: join, active condition, and when access ends. */
  apiKeyAccountSql(userAlias: string): ApiKeyAccountSql;
  /** A user-facing refusal message when this error from changing a team member is a plan limit, or null. */
  memberLimitMessage(error: unknown): string | null;
  /** True when the edition provisions the owner and the default workspace, so core seeds neither. */
  ownerProvisioned(env: Env): boolean;
  /** Runs after core's message and conversation expiry, in the same failure boundary; returns a line to log, or null. */
  scheduledExpiry(env: Env): Promise<string | null>;
  /** True when writes need the edition's OAuth and MCP write checks. */
  writeProtected(env: Env): boolean;
  /** True when people sign in only through the workspace identity provider, so core serves no legacy session, share-code or public-link access. Core default: false. */
  workspaceSignInOnly(env: Env): boolean;
  /** True when this deployment is a public multi-account site, so core serves no team, help or device-code surface that needs one workspace. Core default: false. */
  publicSite(env: Env): boolean;
  /** True when this deployment is limited to one private hosted domain, so people cannot link other sign-in identities. Core default: false. */
  privateGoogleSite(env: Env): boolean;
  /** A refusal response for an OAuth client registration that writes, or null. */
  oauthWriteRefusal(env: Env): Promise<Response | null>;
  /** A refusal response for an MCP tool call that writes, or null. */
  mcpWriteRefusal(env: Env, toolName: string): Promise<Response | null>;
  /** A refusal message when this deployment may not create a team, or null. */
  teamCreationError(env: Env): string | null;
  /** A refusal message when this deployment may not create a second workspace, or null. */
  singleWorkspaceRefusal(env: Env): string | null;
  /** Scheduled jobs that run before core's own, each on its own. */
  scheduledJobs: readonly EditionScheduledJob[];
  /** Runs just before core's data expiry; a failure stops that scheduled run, as an expiry failure does. */
  scheduledMaintenance(env: Env): Promise<void>;
  /** Verifies an edition OAuth token; undefined keeps core token handling. A null result refuses it. */
  oauthAccessToken?(headers: Headers, env: Env): Promise<OAuthTokenRecord | null | undefined>;
  /** Looks up an edition session token; undefined when the edition does not handle it (core then looks up a plain session). */
  sessionLookup(env: Env | undefined, token: string): Promise<string | null> | undefined;
  /** Whether this active user may still sign in to this deployment. */
  signInIdentity(env: Env, userId: string): Promise<boolean>;
  /** SQL that an agent key's sponsor row (alias `owner`) must satisfy; undefined keeps core's own rule. */
  agentSponsorAccessSql?(env: Env, owner: string): string;
  /** Whether this person may be added to or kept in the team. */
  memberIdentityAllowed(env: Env, input: { teamId: string }, target: { id: string }, existing: unknown): Promise<boolean>;
  /** The sign-in identities that the profile page lists. */
  accountIdentities(env: Env, user: { id: string; email: string }): Promise<AccountIdentity[]>;
  /** Runs after an agent board post is stored (for example notifications). */
  onBoardPost(env: Env, entry: unknown): Promise<void>;
  /** True when the deployment serves the private Library (routes, MCP tools, list filters). Core default: true. */
  libraryEnabled(env: Env): boolean;
  /** Extra durable work committed in the same transaction as the content, with no network I/O. */
  contentStoreStatements(env: Env, input: ContentStoredInput): D1PreparedStatement[];
  replyStoreStatements(env: Env, input: { userId: string; messageId: string; guard: {sql:string;binds:unknown[]} }): D1PreparedStatement[];
  /** Runs after a person signs in through the edition sign-in; core does nothing. */
  afterSignIn(env: Env, input: { userId: string; email: string }): Promise<void>;
  /** The extra ticket links this team's posts can carry, beyond GitHub, Jira and Linear URLs; null for none. Core default: null. */
  ticketResolver(env: Env, teamId: string | undefined): Promise<EditionTicketResolver | null>;
  /** Text added to the ticket-links sentence of the Bulletin board help, such as `, or names an issue of a project connected to <product>`; empty for none. */
  ticketHelpText(): string;
  /** The help articles this edition ships: raw Markdown sources and a version that changes with them. Core default: none. */
  helpCorpus(): { version: string; sources: readonly { file: string; raw: string }[] };
  /** Runs when a person opens help in a team (for example a welcome checklist). */
  onHelpOpened(env: Env, input: { teamId: string; userId: string }): Promise<void>;
  /** The team that the person last chose, from the request; core takes the first team. */
  selectedSpace(request: Request, userId: string, teams: readonly { id: string }[]): Promise<{ id: string } | null>;
  /** Records the team that a page showed, so that the next page opens it too; core records nothing. */
  rememberSpace(response: Response, userId: string, team: { id: string } | null): Promise<Response>;
  /** The page brand for this deployment. */
  brand(env: Env): string;
  /** The shared page header's brand, place row and account menu for this deployment. */
  shell(env: Env, input: { base: string; canManagePeople?: boolean }): ShellConfig;
  /** The Apple apps (team, bundle IDs, sign-in audiences) of this deployment. */
  appleApps(): AppleApps;
  /** The product identity: the outbound User-Agent, and the document mark and footer. */
  productIdentity(): ProductIdentity;
  /** The names that clients see on the wire: token prefixes, realm, MCP names, artifact credential and events subprotocol. */
  wireFormat(): WireFormat;
  /** The names of the OAuth and device login tables. */
  tableNames(): TableNames;
  /** The user IDs mentioned in a team post or comment. Throws MentionRejected for a refused mention. */
  resolveMentions(env: Env, teamId: string, authorId: string, text: string): Promise<string[]>;
  /** Stores mentions once their post or comment exists. */
  recordMentions(env: Env, input: MentionRecord): Promise<void>;
  /** The sign-in page. */
  loginPage(env: Env, error?: string, next?: string): Promise<Response>;
  /** True when this edition does not serve the request: the path of a feature it does not have. Core default: false. */
  blocksRequest(env: Env, method: string, path: string): boolean;
  /** Cards for the setup page's account section (for example hosted usage). `userId` is null when no active person was found. Core default: none. */
  accountSections(env: Env, userId: string | null): Promise<string[]>;
  /** The labels in the document reader, translated; undefined for the reader's own English text. */
  readerLabels?: ReaderLabels;
  /** The response for an error that the edition throws (for example a write gate), or null to leave it to core. */
  errorResponse(error: unknown): Response | null;
  /** True when the deployment serves the document audience route. Core default: false. */
  documentAudienceEnabled(env: Env): boolean;
  /** MCP tools for agent board credentials and people (for example a security digest). */
  agentBoardTools: readonly EditionMcpTool[];
  /** Handles a tool from agentBoardTools; undefined for any other tool. */
  callAgentBoardTool(input: { env: Env; request: Request; userId?: string; name: string; args: Record<string, unknown> }): Promise<EditionBoardToolOutcome | undefined>;
  /** Extra MCP tools for people's connections in this deployment (for example Microsoft Teams inclusions). */
  workspaceTools(env: Env): readonly EditionMcpTool[];
  /** Handles a tool from workspaceTools; undefined for any other tool. */
  callWorkspaceTool(input: { env: Env; request: Request; name: string; args: Record<string, unknown> }): Promise<EditionToolResult | undefined>;
  /** Wraps the router for one request: may refuse it before `serve` runs, and meters it after. Core serves it unchanged. */
  meterRequest(request: Request, env: Env, ctx: ExecutionContext, serve: () => Promise<Response>): Promise<Response>;
  /** Counts bytes that arrived in a request that did not declare its size, once the handler knows how many it stored. */
  recordBytesUp(env: Env, bytes: number): Promise<void>;
  /** Micro-dollars of this month's AI allowance that remain; Infinity when the edition sets none. */
  aiBudgetLeft(env: Env): Promise<number>;
  /** Records the tokens of one AI call against the allowance. `ctx` is absent where the caller has none. */
  recordAiUsage(env: Env, ctx: ExecutionContext | undefined, model: string, promptTokens: number, completionTokens: number): Promise<void>;
}

const DEFAULT_PRODUCT_IDENTITY: ProductIdentity = { name: "Pidgin", userAgent: "PidginCore", documentMark: "", documentFooter: [], houseColors: "light teal, mint, sand, and white", mailFrom: "PidginCore <notifications@pidgincore.invalid>" };

const PIDGIN_CORE_DEFAULTS: EditionHooks = {
  assertWritable: async () => {},
  accessError: async () => null,
  recordStorage: async () => false,
  settlePlans: async () => ({ debited: 0, due: 0 }),
  reserveUsage: async () => ({ managed: false }),
  releaseUsage: async () => ({ managed: false }),
  accountLimits: async () => null,
  accountActiveSql: () => "1",
  apiKeyAccountSql: () => ({ join: "", active: "1", endsAt: "NULL" }),
  memberLimitMessage: error => error instanceof PlanLimitRefused ? error.message : null,
  ownerProvisioned: () => false,
  scheduledExpiry: async () => null,
  writeProtected: () => false,
  workspaceSignInOnly: () => false,
  publicSite: () => false,
  privateGoogleSite: () => false,
  oauthWriteRefusal: async () => null,
  mcpWriteRefusal: async () => null,
  teamCreationError: () => null,
  singleWorkspaceRefusal: () => null,
  scheduledJobs: [],
  scheduledMaintenance: async () => {},
  sessionLookup: () => undefined,
  signInIdentity: async () => true,
  memberIdentityAllowed: async () => true,
  accountIdentities: async (_env, user) => [{ email: user.email, provider: "primary", primary: true }],
  onBoardPost: async () => {},
  libraryEnabled: () => true,
  contentStoreStatements: () => [],
  replyStoreStatements: () => [],
  ticketResolver: async () => null,
  ticketHelpText: () => "",
  helpCorpus: () => ({ version: "none", sources: [] }),
  onHelpOpened: async () => {},
  afterSignIn: async () => {},
  selectedSpace: async (_request, _userId, teams) => teams[0] ?? null,
  rememberSpace: async response => response,
  brand: () => DEFAULT_PRODUCT_IDENTITY.name.toLowerCase(),
  shell: (_env, input) => ({
    brand: { name: DEFAULT_PRODUCT_IDENTITY.name },
    places: ["workspace", "inbox", "library"],
    menu: [
      { key: "audio", label: "Audio", href: appPath(input.base, "/audio") },
      { key: "instances", label: "Instances", href: appPath(input.base, "/registry") },
      { key: "stats", label: "Stats", href: appPath(input.base, "/stats") },
      { key: "profile", label: "Profile", href: appPath(input.base, "/profile") },
      { key: "setup", label: "Setup", href: appPath(input.base, "/setup") },
    ],
  }),
  appleApps: () => ({ clientBundles: { ios: [], macos: [] }, signInAudiences: [] }),
  productIdentity: () => DEFAULT_PRODUCT_IDENTITY,
  wireFormat: () => ({
    tokenPrefix: "pidgin_",
    authRealm: "pidgin",
    mcpServerName: "pidgin",
    mcpToolPrefix: "pidgin_",
    artifactAuthScheme: "PidginArtifact",
    artifactHmacContext: "pidgin-artifact-runtime:",
    runtimeGlobalAlias: "",
    eventsSubprotocol: "pidgin-events.v1",
    agentEnvPrefix: "PIDGIN",
    slug: "pidgin",
  }),
  tableNames: () => ({
    oauthConnections: "oauth_connections",
    oauthRefresh: "oauth_refresh",
    oauthCodes: "oauth_codes",
    oauthConsents: "oauth_consents",
    oauthLegacyConsumed: "oauth_legacy_consumed",
    deviceLogins: "device_logins",
  }),
  resolveMentions: async () => [],
  recordMentions: async () => {},
  loginPage: coreLoginPage,
  blocksRequest: () => false,
  accountSections: async () => [],
  errorResponse: () => null,
  documentAudienceEnabled: () => false,
  agentBoardTools: [],
  callAgentBoardTool: async () => undefined,
  workspaceTools: () => [],
  callWorkspaceTool: async () => undefined,
  meterRequest: (_request, _env, _ctx, serve) => serve(),
  recordBytesUp: async () => {},
  aiBudgetLeft: async () => Infinity,
  recordAiUsage: async () => {},
};

let hooks: EditionHooks = PIDGIN_CORE_DEFAULTS;

export function installEditionHooks(edition: Partial<EditionHooks>): void {
  hooks = { ...PIDGIN_CORE_DEFAULTS, ...edition };
}

export const assertTenantWritable = (env: Env): Promise<void> => hooks.assertWritable(env);

/** For a caller that skips the write instead of failing: false when the deployment may not write. */
export async function tenantWritable(env: Env): Promise<boolean> {
  try {
    await hooks.assertWritable(env);
    return true;
  } catch (error) {
    if (error instanceof TenantWriteRefused) return false;
    throw error;
  }
}

export const editionAccessError = (env: Env, scope: { userId?: string; teamId?: string }): Promise<string | null> =>
  hooks.accessError(env, scope);
export const recordEditionStorage = (env: Env, userId: string, bytes: number, idempotencyKey: string): Promise<boolean> =>
  hooks.recordStorage(env, userId, bytes, idempotencyKey);
export const settleEditionPlans = (env: Env): Promise<{ debited: number; due: number }> => hooks.settlePlans(env);
export const reserveEditionUsage = (env: Env, userId: string, metric: UsageMetric, amount: number, idempotencyKey: string): Promise<UsageReservation> =>
  hooks.reserveUsage(env, userId, metric, amount, idempotencyKey);
export const releaseEditionUsage = (env: Env, userId: string, metric: UsageMetric, amount: number, idempotencyKey: string): Promise<UsageReservation> =>
  hooks.releaseUsage(env, userId, metric, amount, idempotencyKey);
export const editionAccountLimits = (env: Env, userId: string): Promise<AccountLimits | null> => hooks.accountLimits(env, userId);
/**
 * SQL condition for an active account; read at each call, so a later install takes effect.
 * The default alias keeps a bare "users" literal out of route files, where the web label extractor would read it as interface text.
 */
export const editionAccountActiveSql = (userAlias = "users"): string => hooks.accountActiveSql(userAlias);
export const editionApiKeyAccountSql = (userAlias: string): ApiKeyAccountSql => hooks.apiKeyAccountSql(userAlias);
export const editionMemberLimitMessage = (error: unknown): string | null => hooks.memberLimitMessage(error);
export const editionOwnerProvisioned = (env: Env): boolean => hooks.ownerProvisioned(env);
export const runEditionExpiry = (env: Env): Promise<string | null> => hooks.scheduledExpiry(env);
export const editionWriteProtected = (env: Env): boolean => hooks.writeProtected(env);
export const editionWorkspaceSignInOnly = (env: Env): boolean => hooks.workspaceSignInOnly(env);
export const editionPublicSite = (env: Env): boolean => hooks.publicSite(env);
export const editionPrivateGoogleSite = (env: Env): boolean => hooks.privateGoogleSite(env);
export const editionOAuthWriteRefusal = (env: Env): Promise<Response | null> => hooks.oauthWriteRefusal(env);
export const editionMcpWriteRefusal = (env: Env, toolName: string): Promise<Response | null> => hooks.mcpWriteRefusal(env, toolName);
export const editionTeamCreationError = (env: Env): string | null => hooks.teamCreationError(env);
export const editionSingleWorkspaceRefusal = (env: Env): string | null => hooks.singleWorkspaceRefusal(env);
export const editionScheduledJobs = (): readonly EditionScheduledJob[] => hooks.scheduledJobs;
export const runEditionMaintenance = (env: Env): Promise<void> => hooks.scheduledMaintenance(env);
export const editionSessionLookup = (env: Env | undefined, token: string): Promise<string | null> | undefined => hooks.sessionLookup(env, token);
export const editionSignInIdentity = (env: Env, userId: string): Promise<boolean> => hooks.signInIdentity(env, userId);
export const editionAgentSponsorAccessSql = (env: Env, owner: string): string | undefined => hooks.agentSponsorAccessSql?.(env, owner);
export const editionMemberIdentityAllowed = (env: Env, input: { teamId: string }, target: { id: string }, existing: unknown): Promise<boolean> =>
  hooks.memberIdentityAllowed(env, input, target, existing);
export const editionAccountIdentities = (env: Env, user: { id: string; email: string }): Promise<AccountIdentity[]> => hooks.accountIdentities(env, user);
export const editionLibraryEnabled = (env: Env): boolean => hooks.libraryEnabled(env);
export const editionContentStoreStatements: EditionHooks["contentStoreStatements"] = (env,input) => hooks.contentStoreStatements(env,input);
export const editionReplyStoreStatements: EditionHooks["replyStoreStatements"] = (env,input) => hooks.replyStoreStatements(env,input);
export const editionOnBoardPost = (env: Env, entry: unknown): Promise<void> => hooks.onBoardPost(env, entry);
export const editionAfterSignIn = (env: Env, input: { userId: string; email: string }): Promise<void> => hooks.afterSignIn(env, input);
export const editionTicketResolver = (env: Env, teamId: string | undefined): Promise<EditionTicketResolver | null> => hooks.ticketResolver(env, teamId);
export const editionTicketHelpText = (): string => hooks.ticketHelpText();
export const editionHelpCorpus: EditionHooks["helpCorpus"] = () => hooks.helpCorpus();
export const editionOnHelpOpened = (env: Env, input: { teamId: string; userId: string }): Promise<void> => hooks.onHelpOpened(env, input);
export const editionSelectedSpace = <T extends { id: string }>(request: Request, userId: string, teams: T[]): Promise<T | null> =>
  hooks.selectedSpace(request, userId, teams) as Promise<T | null>;
export const editionRememberSpace = (response: Response, userId: string, team: { id: string } | null): Promise<Response> =>
  hooks.rememberSpace(response, userId, team);
export const editionBrand = (env: Env): string => hooks.brand(env);
export const editionShell = (env: Env, input: { base: string; canManagePeople?: boolean }): ShellConfig => hooks.shell(env, input);
/** The Apple apps of this deployment, read at each call. */
export const editionAppleApps = (): AppleApps => hooks.appleApps();
/** The product identity of this deployment, read at each call. */
export const editionProductIdentity = (): ProductIdentity => hooks.productIdentity();
/** The product name of this deployment, read at each call. Never read it at module load: the edition installs its hooks after imports. */
export const editionProductName = (): string => hooks.productIdentity().name;
/** The wire names of this deployment, read at each call so a later install takes effect. */
export const editionWireFormat = (): WireFormat => hooks.wireFormat();
/** The OAuth and device login table names of this deployment, read at each call. */
export const editionTableNames = (): TableNames => hooks.tableNames();
export const editionResolveMentions = (env: Env, teamId: string, authorId: string, text: string): Promise<string[]> =>
  hooks.resolveMentions(env, teamId, authorId, text);
export const editionRecordMentions = (env: Env, input: MentionRecord): Promise<void> => hooks.recordMentions(env, input);
export const editionBlocksRequest = (env: Env, method: string, path: string): boolean => hooks.blocksRequest(env, method, path);
export const editionAccountSections = (env: Env, userId: string | null): Promise<string[]> => hooks.accountSections(env, userId);
export const editionReaderLabels = (): ReaderLabels | undefined => hooks.readerLabels;
export const editionErrorResponse = (error: unknown): Response | null => hooks.errorResponse(error);
export const editionDocumentAudienceEnabled = (env: Env): boolean => hooks.documentAudienceEnabled(env);
export const editionLoginPage = (env: Env, error?: string, next?: string): Promise<Response> => hooks.loginPage(env, error, next);
export const editionAgentBoardTools = (): readonly EditionMcpTool[] => hooks.agentBoardTools;
export const editionCallAgentBoardTool = (input: { env: Env; request: Request; userId?: string; name: string; args: Record<string, unknown> }): Promise<EditionBoardToolOutcome | undefined> =>
  hooks.callAgentBoardTool(input);
export const editionWorkspaceTools = (env: Env): readonly EditionMcpTool[] => hooks.workspaceTools(env);
export const editionCallWorkspaceTool = (input: { env: Env; request: Request; name: string; args: Record<string, unknown> }): Promise<EditionToolResult | undefined> =>
  hooks.callWorkspaceTool(input);
export const editionMeterRequest = (request: Request, env: Env, ctx: ExecutionContext, serve: () => Promise<Response>): Promise<Response> =>
  hooks.meterRequest(request, env, ctx, serve);
export const editionAiBudgetLeft = (env: Env): Promise<number> => hooks.aiBudgetLeft(env);
export const editionRecordAiUsage = (env: Env, ctx: ExecutionContext | undefined, model: string, promptTokens: number, completionTokens: number): Promise<void> =>
  hooks.recordAiUsage(env, ctx, model, promptTokens, completionTokens);
export const editionRecordBytesUp = (env: Env, bytes: number): Promise<void> => hooks.recordBytesUp(env, bytes);

export const editionOAuthAccessToken = (headers: Headers, env: Env): Promise<OAuthTokenRecord | null | undefined> => hooks.oauthAccessToken?.(headers, env) ?? Promise.resolve(undefined);
