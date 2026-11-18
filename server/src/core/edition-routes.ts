// Route blocks and hooks that an edition adds to the shared router (app.ts), at
// fixed points so that route order stays as it was. An edition's entry installs its
// blocks once, when its Worker module loads, and different entries install different
// sets. Each deployment serves one customer, so this module state never mixes customers.
import type { Env } from "./types";
import type { NavCommand } from "./web/nav-shell";

export interface RouteContext {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  url: URL;
  path: string;
  method: string;
  base: string;
}

/**
 * Returns a response when the block handles the request, or null to continue.
 * The router awaits each block inside its try, so an error that a block throws
 * gets the router's catch: a write-gate error keeps its 402 or 503 body, and
 * any other error is a 500 with its message. Before the move some of these
 * routes returned a handler's promise without await; their errors skipped that
 * catch and became the generic 500 of handleRequest.
 */
export type RouteBlock = (c: RouteContext) => Promise<Response | null>;

/** Dedicated triggers are dispatched before the general daily work. */
export const HOURLY_CRON = "17 * * * *";
export const WORKSPACE_BACKUP_CRON = "43 3 * * *";

/** A request that the edition rewrote before routing, and an optional change to the router's response. */
export interface ShortLinkRewrite {
  request: Request;
  finish?: (response: Response) => Response;
}

export interface EditionRoutes {
  teamAdministration?: RouteBlock;
  navigation?: readonly NavCommand[];
  controlFirst?: RouteBlock;
  controlBeforeOwner?: RouteBlock;
  controlOnboarding?: RouteBlock;
  controlPublic?: RouteBlock;

  // Hosting-edge route blocks and page blocks of an edition, which every entry of that edition installs. Each runs where its routes were in app.ts.
  /** Right after `controlFirst`. */
  hostingFirst?: RouteBlock;
  /** After `teamsTranslation`: static legal pages and the commercial proxy. */
  hostingPublic?: RouteBlock;
  /** After `controlBeforeOwner`, before the owner is ensured. */
  hostingBeforeOwner?: RouteBlock;
  /** After `controlOnboarding`: the managed-tenant sign-in routes. */
  hostingManaged?: RouteBlock;
  /** After `teamAdministration`: hosted-account provisioning and usage. */
  hostingAccounts?: RouteBlock;
  /** After `teamsSignIn`: account emails and the workspace sign-in-only policy. */
  hostingIdentity?: RouteBlock;
  /** Web pages: after the setup routes, before the inbox. */
  hostingPages?: RouteBlock;
  /** Web pages: after the table of contents, before the registry. */
  hostingWorkspacePages?: RouteBlock;

  // Team route blocks, installed by the entry that serves teams. Each runs where its routes were in app.ts.
  teamsTranslation?: RouteBlock;
  teamsSignIn?: RouteBlock;
  teamsApi?: RouteBlock;
  teamsProjects?: RouteBlock;
  teamsWorkspaceApi?: RouteBlock;
  teamsSettings?: RouteBlock;
  teamsPages?: RouteBlock;

  /** True when a bare visit to /workspace must go to the Get started page first. */
  needsWelcome?: (env: Env, teamId: string, userId: string) => Promise<boolean>;
  /** Current short names by project ID, for the team the workspace page shows. */
  projectNames?: (env: Env, teamId: string) => Promise<Record<string, string>>;
  /** Replaces a short code in the path with the item's id. A response here is the answer; null leaves the request as it is. */
  rewriteRequest?: (request: Request, env: Env) => Promise<ShortLinkRewrite | Response | null>;
  /** True when the team has Microsoft Teams inclusions (the workspace page links to them). */
  hasTeamsInclusions?: (env: Env, teamId: string) => boolean;
  /** The Microsoft Teams channels that the setup page lists for this person. */
  teamsChannels?: (env: Env, userId: string) => Promise<{ name: string; connected: boolean }[]>;
  /** Sign-out work in addition to the core session: other sessions to revoke, cookies to clear. */
  signOut?: (request: Request, env: Env, userId: string | null, headers: Headers) => Promise<void>;
  /** Returns true when an edition handled its own dedicated trigger. */
  scheduled?: (event: ScheduledController, env: Env) => Promise<boolean>;
  /** The work of the hourly cron trigger. */
  hourly?: (event: ScheduledController, env: Env) => Promise<void>;
  /** Runs before the router. A response here is the answer, and the router does not run. */
  beforeApp?: (request: Request, env: Env, path: string) => Promise<Response | null>;
  /** Changes the router's response before it is logged and sent. */
  afterApp?: (request: Request, response: Response, env: Env, requestID: string) => Promise<Response>;
}

let routes: EditionRoutes = {};

export function installEditionRoutes(edition: EditionRoutes): void {
  routes = { ...edition };
}

export const editionRoutes = (): EditionRoutes => routes;
