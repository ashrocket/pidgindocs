// Bulletin posts close: by a person or agent (resolved, read), when every member of the
// post's audience has read it (audience_read), or at the tenant's age limit (expired).
// The rules come from the tenant's BULLETIN_RULES var, set in its server config file.
// Closed posts stay readable; they leave inboxes and open-question reads.
import type { Env } from "./types";
import { editionSlug } from "./wire-names";

export type BulletinCloseReason = "resolved" | "read" | "audience_read" | "expired";
export const MANUAL_CLOSE_REASONS = ["resolved", "read"] as const;
export type TicketSystem = "github" | "jira" | "linear";

export interface BulletinRules {
  /** Hours after which an open Bulletin post closes; 0 never closes by age. */
  autoCloseHours: number;
  closeWhenAudienceRead: boolean;
  manualClose: boolean;
  /** When true, a question closes by audience only once it has an answer. Off by default. */
  questionsWaitForAnswer: boolean;
  /** Ticket systems integrated into the app: an in-app path template with {key} and {url}. */
  tickets: Partial<Record<TicketSystem, { inAppPath: string }>>;
}

export const DEFAULT_BULLETIN_RULES: BulletinRules = Object.freeze({
  autoCloseHours: 48, closeWhenAudienceRead: true, manualClose: true, questionsWaitForAnswer: false, tickets: {},
}) as BulletinRules;

/** Systems a tenant can integrate through BULLETIN_RULES.tickets; an edition can add others through its ticket resolver hook. */
const TICKET_SYSTEMS: readonly TicketSystem[] = ["github", "jira", "linear"];
const MAX_AUTO_CLOSE_HOURS = 24 * 30;

/**
 * Reads BULLETIN_RULES, for example
 * {"auto_close_hours":48,"close_when_audience_read":true,"manual_close":true,
 *  "tickets":{"linear":{"<slug>_path":"/integrations/linear/{key}"}}}, where <slug> is the edition slug.
 * Missing keys keep the defaults. Invalid JSON or values throw, so a bad tenant file fails its tests.
 */
export function parseBulletinRules(value: string | undefined): BulletinRules {
  if (!value || !value.trim()) return { ...DEFAULT_BULLETIN_RULES, tickets: {} };
  const raw = JSON.parse(value) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("BULLETIN_RULES must be a JSON object");
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!["auto_close_hours", "close_when_audience_read", "manual_close", "questions_wait_for_answer", "tickets"].includes(key)) {
      throw new Error(`BULLETIN_RULES has an unknown key: ${key}`);
    }
  }
  const rules: BulletinRules = { ...DEFAULT_BULLETIN_RULES, tickets: {} };
  if (input.auto_close_hours !== undefined) {
    const hours = input.auto_close_hours;
    if (typeof hours !== "number" || !Number.isInteger(hours) || hours < 0 || hours > MAX_AUTO_CLOSE_HOURS) {
      throw new Error(`BULLETIN_RULES.auto_close_hours must be a whole number from 0 to ${MAX_AUTO_CLOSE_HOURS}`);
    }
    rules.autoCloseHours = hours;
  }
  for (const [key, field] of [["close_when_audience_read", "closeWhenAudienceRead"], ["manual_close", "manualClose"], ["questions_wait_for_answer", "questionsWaitForAnswer"]] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "boolean") throw new Error(`BULLETIN_RULES.${key} must be true or false`);
    rules[field] = input[key] as boolean;
  }
  if (input.tickets !== undefined) {
    if (!input.tickets || typeof input.tickets !== "object" || Array.isArray(input.tickets)) throw new Error("BULLETIN_RULES.tickets must be an object");
    for (const [system, config] of Object.entries(input.tickets as Record<string, unknown>)) {
      if (!(TICKET_SYSTEMS as readonly string[]).includes(system)) throw new Error(`BULLETIN_RULES.tickets has an unknown system: ${system}`);
      const pathKey = `${editionSlug()}_path`;
      const path = (config as Record<string, unknown> | null)?.[pathKey];
      if (typeof path !== "string" || !/^\/[A-Za-z0-9/_.{}-]*$/.test(path) || path.startsWith("//") || !/\{(key|url)\}/.test(path)) {
        throw new Error(`BULLETIN_RULES.tickets.${system}.${pathKey} must be an in-app path with {key} or {url}`);
      }
      rules.tickets[system as TicketSystem] = { inAppPath: path };
    }
  }
  return rules;
}

/** The tenant's rules; a malformed var falls back to the defaults at run time and says so. */
export function bulletinRules(env: Pick<Env, "BULLETIN_RULES">): BulletinRules {
  try {
    return parseBulletinRules(env.BULLETIN_RULES);
  } catch (error) {
    console.warn(`Ignoring BULLETIN_RULES: ${error instanceof Error ? error.message : "invalid"}`);
    return { ...DEFAULT_BULLETIN_RULES, tickets: {} };
  }
}

// ── Ticket links ────────────────────────────────────────────────────────────

export interface BoardTicket {
  /** A built-in system, or the name of one that an edition resolver supplies. */
  system: TicketSystem | (string & {});
  /** owner/repo#123 for GitHub, KEY-123 for Jira and Linear. */
  key: string;
  /** What the post heading shows: #123 or KEY-123. */
  label: string;
  url: string;
  /** In-app address when the system is integrated into the app; otherwise null and the link opens the web. */
  appUrl: string | null;
}

/** The ticket as clients read it: the in-app address sits under `<slug>_url`, the key that clients already use. */
export function ticketJson(ticket: BoardTicket | null): Record<string, unknown> | null {
  if (!ticket) return null;
  const { appUrl, ...rest } = ticket;
  return { ...rest, [`${editionSlug()}_url`]: appUrl };
}

const TICKET_PATTERNS: Array<{ system: TicketSystem; pattern: RegExp; key: (m: RegExpMatchArray) => string; label: (m: RegExpMatchArray) => string }> = [
  { system: "github", pattern: /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(?:issues|pull)\/(\d+)(?:[/?#]\S*)?$/,
    key: (m) => `${m[1]}/${m[2]}#${m[3]}`, label: (m) => `#${m[3]}` },
  { system: "linear", pattern: /^https:\/\/linear\.app\/[A-Za-z0-9_-]+\/issue\/([A-Z][A-Z0-9]*-\d+)(?:[/?#]\S*)?$/,
    key: (m) => m[1], label: (m) => m[1] },
  { system: "jira", pattern: /^https:\/\/[A-Za-z0-9.-]+\/browse\/([A-Z][A-Z0-9_]*-\d+)(?:[/?#]\S*)?$/,
    key: (m) => m[1], label: (m) => m[1] },
];

/** Finds a ticket that the edition recognizes in a post's reference and body; null when it finds none. */
export type EditionTicketResolver = (reference: string | null | undefined, body: string | null | undefined) => BoardTicket | null;

/**
 * The first ticket URL in a post (its reference, then its body); failing that, whatever ticket the
 * edition's resolver (see editionTicketResolver) finds. Core's default edition supplies none.
 */
export function boardTicket(reference: string | null | undefined, body: string | null | undefined, rules: BulletinRules = DEFAULT_BULLETIN_RULES,
  extra: EditionTicketResolver | null = null): BoardTicket | null {
  const candidates = [String(reference ?? "").trim(), ...(String(body ?? "").match(/https:\/\/[^\s<>()"'`]+/g) ?? [])]
    .map((url) => url.replace(/[.,;:!?]+$/, ""))
    .filter(Boolean);
  for (const url of candidates) {
    for (const { system, pattern, key, label } of TICKET_PATTERNS) {
      const match = url.match(pattern);
      if (!match) continue;
      const ticketKey = key(match);
      const path = rules.tickets[system]?.inAppPath;
      return {
        system, key: ticketKey, label: label(match), url,
        appUrl: path ? path.replace(/\{key\}/g, encodeURIComponent(ticketKey)).replace(/\{url\}/g, encodeURIComponent(url)) : null,
      };
    }
  }
  return extra ? extra(reference, body) : null;
}

// ── Audience ────────────────────────────────────────────────────────────────

const TAG = /^([ao]):(@[a-z0-9._+-]+(?:@[a-z0-9.-]+)?|[a-z0-9][a-z0-9-]*)$/;

export interface AudienceTag { mode: "a" | "o"; target: string }

/** The audience tags on a post's first line, or [] when that line is not all tags. */
export function bulletinAudienceTags(body: string): AudienceTag[] {
  const words = String(body ?? "").split("\n", 1)[0].trim().toLowerCase().split(/\s+/).filter(Boolean);
  const tags: AudienceTag[] = [];
  for (const word of words) {
    const match = word.match(TAG);
    if (!match) return [];
    tags.push({ mode: match[1] as "a" | "o", target: match[2] });
  }
  return tags;
}

/** One reader the audience waits for: a person, any agent a person sponsors, or one agent. */
type AudienceUnit = `user:${string}` | `agents-of:${string}` | `agent:${string}`;

export interface AudienceDirectory {
  members: Array<{ userId: string; names: Set<string> }>;
  /** Active agents with a grant on this Bulletin, by sponsor. */
  agentsBySponsor: Map<string, string[]>;
  sponsorOfAgent: Map<string, string>;
  /** Access role slug to member user IDs. */
  roles: Map<string, string[]>;
}

export interface AudienceEntry { body: string; to_ref: string | null; user_id: string | null; agent_id: string; author_kind?: string }

/** The readers a post waits for, or null when its audience cannot be known (then only age or a person closes it). */
export function audienceUnits(entry: AudienceEntry, directory: AudienceDirectory): Set<AudienceUnit> | null {
  const tags = bulletinAudienceTags(entry.body);
  const units = new Set<AudienceUnit>();
  if (!tags.length) {
    if (entry.to_ref?.startsWith("agent:") || entry.to_ref?.startsWith("user:")) units.add(entry.to_ref as AudienceUnit);
  }
  const memberIds = new Set(directory.members.map((member) => member.userId));
  for (const { mode, target } of tags) {
    let people: string[];
    let named = false;
    if (target.startsWith("@")) {
      const name = target.slice(1);
      people = directory.members.filter((member) => member.names.has(name)).map((member) => member.userId);
      if (people.length !== 1) return null;
      named = true;
    } else if (target === "all") {
      people = [...memberIds];
    } else {
      const role = directory.roles.get(target);
      if (!role) return null;
      people = role.filter((id) => memberIds.has(id));
    }
    if (mode === "o") {
      people.forEach((id) => units.add(`user:${id}`));
      continue;
    }
    const withAgents = people.filter((id) => (directory.agentsBySponsor.get(id) ?? []).length > 0);
    if (named && !withAgents.length) return null;
    withAgents.forEach((id) => units.add(`agents-of:${id}`));
  }
  // The author never waits for themselves.
  if (entry.user_id) { units.delete(`user:${entry.user_id}`); units.delete(`agents-of:${entry.user_id}`); }
  units.delete(`agent:${entry.agent_id}`);
  return units.size ? units : null;
}

export function audienceHasRead(units: Set<AudienceUnit>, readers: Set<string>, directory: AudienceDirectory): boolean {
  const sponsorsRead = new Set([...readers].filter((ref) => ref.startsWith("agent:"))
    .map((ref) => directory.sponsorOfAgent.get(ref.slice(6))).filter(Boolean));
  for (const unit of units) {
    if (unit.startsWith("agents-of:") ? !sponsorsRead.has(unit.slice(10)) : !readers.has(unit)) return false;
  }
  return true;
}

async function loadAudienceDirectory(env: Env, teamId: string, bulletinId: string): Promise<AudienceDirectory> {
  const [members, agents, roles] = await env.DB.batch([
    env.DB.prepare(`SELECT tm.user_id, u.email,
        (SELECT group_concat(principal_name, ' ') FROM entra_identities WHERE user_id = u.id) AS entra_names,
        (SELECT email FROM google_identities WHERE user_id = u.id) AS google_email,
        COALESCE((SELECT display_name FROM entra_identities WHERE user_id = u.id AND display_name <> '' LIMIT 1),
          (SELECT display_name FROM google_identities WHERE user_id = u.id)) AS display_name
      FROM team_memberships tm JOIN users u ON u.id = tm.user_id AND u.status = 'active'
      WHERE tm.team_id = ?`).bind(teamId),
    env.DB.prepare(`SELECT a.id, a.created_by_user_id FROM agent_identities a
      JOIN agent_project_grants g ON g.agent_id = a.id AND g.project_id = ?
      WHERE a.team_id = ? AND a.status = 'active' AND a.kind = 'agent'`).bind(bulletinId, teamId),
    env.DB.prepare(`SELECT r.slug, r.kind, rm.user_id FROM team_access_roles r
      LEFT JOIN team_access_role_members rm ON rm.role_id = r.id
      WHERE r.team_id = ?`).bind(teamId),
  ]);
  type MemberRow = { user_id: string; email: string | null; entra_names: string | null; google_email: string | null; display_name: string | null };
  const directory: AudienceDirectory = { members: [], agentsBySponsor: new Map(), sponsorOfAgent: new Map(), roles: new Map() };
  for (const row of (members.results ?? []) as MemberRow[]) {
    const names = new Set<string>();
    for (const address of [row.email, row.google_email, ...(row.entra_names ?? "").split(" ")]) {
      const local = String(address ?? "").trim().toLowerCase().split("@")[0];
      if (local) { names.add(local); names.add(String(address).trim().toLowerCase()); }
    }
    const first = String(row.display_name ?? "").trim().toLowerCase().split(/\s+/)[0];
    if (first) names.add(first);
    directory.members.push({ userId: row.user_id, names });
  }
  for (const row of (agents.results ?? []) as Array<{ id: string; created_by_user_id: string }>) {
    directory.sponsorOfAgent.set(row.id, row.created_by_user_id);
    directory.agentsBySponsor.set(row.created_by_user_id, [...(directory.agentsBySponsor.get(row.created_by_user_id) ?? []), row.id]);
  }
  const everyone = directory.members.map((member) => member.userId);
  for (const row of (roles.results ?? []) as Array<{ slug: string; kind: string; user_id: string | null }>) {
    const slug = row.slug.toLowerCase();
    if (row.kind !== "custom") { directory.roles.set(slug, everyone); continue; }
    const list = directory.roles.get(slug) ?? [];
    if (row.user_id) list.push(row.user_id);
    directory.roles.set(slug, list);
  }
  return directory;
}

// ── Reads and closing ───────────────────────────────────────────────────────

/** D1 binds at most 100 values per statement. */
function chunks<T>(items: T[], size = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const OPEN_ENTRY = `NOT EXISTS (SELECT 1 FROM agent_board_closures c WHERE c.entry_id = e.id)
  AND NOT EXISTS (SELECT 1 FROM agent_board_moderation m WHERE m.entry_id = e.id)`;

// With questions_wait_for_answer, reading a question is not enough: it waits for an answer before its audience closes it.
const ANSWERED_OR_NOT_QUESTION = `(e.intent IS NOT 'question' OR EXISTS (SELECT 1 FROM agent_board_entries answer
  LEFT JOIN agent_board_moderation am ON am.entry_id = answer.id
  WHERE answer.project_id = e.project_id AND answer.reply_to_seq = e.seq AND answer.intent = 'answer' AND am.entry_id IS NULL))`;

export async function bulletinBoardId(env: Env, projectId: string): Promise<{ id: string; team_id: string } | null> {
  return await env.DB.prepare("SELECT id, team_id FROM projects WHERE id = ? AND board_kind = 'commons'")
    .bind(projectId).first<{ id: string; team_id: string }>();
}

/** Records that a reader (agent:<id> or user:<id>) has read open Bulletin posts, then closes any whose audience has all read. */
export async function recordBulletinReads(env: Env, input: { projectId: string; readerRef: string; entryIds: string[] }): Promise<number> {
  const ids = [...new Set(input.entryIds)];
  if (!ids.length) return 0;
  const board = await bulletinBoardId(env, input.projectId);
  if (!board) return 0;
  const statements = chunks(ids).map((part) => env.DB.prepare(`INSERT OR IGNORE INTO agent_board_reads(entry_id, reader_ref)
    SELECT e.id, ? FROM agent_board_entries e
    WHERE e.project_id = ? AND e.id IN (${part.map(() => "?").join(",")}) AND ${OPEN_ENTRY}`)
    .bind(input.readerRef, board.id, ...part));
  await env.DB.batch(statements);
  return await closeBulletinPostsReadByAudience(env, board, ids);
}

/** Closes open posts on a Bulletin board whose whole audience has read them. Without entryIds it checks recent open posts. */
export async function closeBulletinPostsReadByAudience(env: Env, board: { id: string; team_id: string }, entryIds?: string[]): Promise<number> {
  const rules = bulletinRules(env);
  if (!rules.closeWhenAudienceRead) return 0;
  const answered = rules.questionsWaitForAnswer ? `AND ${ANSWERED_OR_NOT_QUESTION}` : "";
  type Row = AudienceEntry & { id: string };
  const rows: Row[] = [];
  if (entryIds) {
    for (const part of chunks(entryIds)) {
      const { results } = await env.DB.prepare(`SELECT e.id, e.body, e.to_ref, e.user_id, e.agent_id FROM agent_board_entries e
        WHERE e.project_id = ? AND e.id IN (${part.map(() => "?").join(",")}) AND ${OPEN_ENTRY} ${answered}`).bind(board.id, ...part).all<Row>();
      rows.push(...(results ?? []));
    }
  } else {
    const { results } = await env.DB.prepare(`SELECT e.id, e.body, e.to_ref, e.user_id, e.agent_id FROM agent_board_entries e
      WHERE e.project_id = ? AND ${OPEN_ENTRY} ${answered} ORDER BY e.seq DESC LIMIT 500`).bind(board.id).all<Row>();
    rows.push(...(results ?? []));
  }
  if (!rows.length) return 0;
  const directory = await loadAudienceDirectory(env, board.team_id, board.id);
  const waiting = rows.map((row) => ({ row, units: audienceUnits(row, directory) })).filter((item) => item.units);
  if (!waiting.length) return 0;
  const readers = new Map<string, Set<string>>();
  for (const part of chunks(waiting.map((item) => item.row.id))) {
    const { results } = await env.DB.prepare(`SELECT entry_id, reader_ref FROM agent_board_reads
      WHERE entry_id IN (${part.map(() => "?").join(",")})`).bind(...part).all<{ entry_id: string; reader_ref: string }>();
    for (const read of results ?? []) readers.set(read.entry_id, (readers.get(read.entry_id) ?? new Set()).add(read.reader_ref));
  }
  const done = waiting.filter(({ row, units }) => audienceHasRead(units!, readers.get(row.id) ?? new Set(), directory)).map(({ row }) => row.id);
  if (!done.length) return 0;
  await env.DB.batch(done.map((id) => env.DB.prepare(`INSERT OR IGNORE INTO agent_board_closures(entry_id, team_id, reason, closed_by_ref)
    VALUES (?, ?, 'audience_read', NULL)`).bind(id, board.team_id)));
  return done.length;
}

/** Closes open Bulletin posts older than the tenant's limit. Runs hourly. */
export async function closeExpiredBulletinPosts(env: Env, now: Date = new Date()): Promise<number> {
  const { autoCloseHours } = bulletinRules(env);
  if (!autoCloseHours) return 0;
  const cutoff = new Date(now.getTime() - autoCloseHours * 3_600_000).toISOString();
  const result = await env.DB.prepare(`INSERT OR IGNORE INTO agent_board_closures(entry_id, team_id, reason, closed_by_ref)
    SELECT e.id, e.team_id, 'expired', NULL FROM agent_board_entries e
    JOIN projects p ON p.id = e.project_id AND p.board_kind = 'commons'
    WHERE datetime(e.created_at) <= datetime(?) AND ${OPEN_ENTRY}
    LIMIT 1000`).bind(cutoff).run();
  return result.meta?.changes ?? 0;
}

/** The hourly sweep: posts past the age limit, then posts whose audience has read them. */
export async function runBulletinLifecycle(env: Env, now: Date = new Date()): Promise<{ expired: number; audience_read: number }> {
  const expired = await closeExpiredBulletinPosts(env, now);
  let audienceRead = 0;
  if (bulletinRules(env).closeWhenAudienceRead) {
    const { results } = await env.DB.prepare(`SELECT p.id, p.team_id FROM projects p
      WHERE p.board_kind = 'commons' AND p.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM agent_board_entries e WHERE e.project_id = p.id AND ${OPEN_ENTRY})`).all<{ id: string; team_id: string }>();
    for (const board of results ?? []) audienceRead += await closeBulletinPostsReadByAudience(env, board);
  }
  return { expired, audience_read: audienceRead };
}

export class BulletinCloseError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Closes one Bulletin post by hand. Closing an already closed post returns its existing closure. */
export async function closeBulletinPost(env: Env, input: { projectId: string; seq: number; reason?: unknown; actorRef: string }) {
  const reason = input.reason === undefined ? "resolved" : input.reason;
  if (typeof reason !== "string" || !(MANUAL_CLOSE_REASONS as readonly string[]).includes(reason)) throw new BulletinCloseError("reason must be resolved or read", 400);
  if (!bulletinRules(env).manualClose) throw new BulletinCloseError("closing Bulletin posts by hand is turned off on this site", 403);
  const entry = await bulletinEntry(env, input.projectId, input.seq);
  await env.DB.prepare(`INSERT OR IGNORE INTO agent_board_closures(entry_id, team_id, reason, closed_by_ref) VALUES (?, ?, ?, ?)`)
    .bind(entry.id, entry.team_id, reason, input.actorRef).run();
  return entry;
}

/** Owners and admins reopen a post; the caller checks the role. */
export async function reopenBulletinPost(env: Env, input: { projectId: string; seq: number }) {
  const entry = await bulletinEntry(env, input.projectId, input.seq);
  await env.DB.prepare("DELETE FROM agent_board_closures WHERE entry_id = ?").bind(entry.id).run();
  await env.DB.prepare("DELETE FROM agent_board_reads WHERE entry_id = ?").bind(entry.id).run();
  return entry;
}

/** A person or agent marks one Bulletin post read; the post closes if its whole audience has now read it. */
export async function markBulletinPostRead(env: Env, input: { projectId: string; seq: number; readerRef: string }) {
  const entry = await bulletinEntry(env, input.projectId, input.seq);
  await recordBulletinReads(env, { projectId: input.projectId, readerRef: input.readerRef, entryIds: [entry.id] });
  return entry;
}

async function bulletinEntry(env: Env, projectId: string, seq: number): Promise<{ id: string; team_id: string }> {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new BulletinCloseError("seq must be a post number", 400);
  const board = await bulletinBoardId(env, projectId);
  if (!board) throw new BulletinCloseError("only Bulletin board posts can be closed", 400);
  const entry = await env.DB.prepare(`SELECT e.id, e.team_id FROM agent_board_entries e WHERE e.project_id = ? AND e.seq = ?
    AND NOT EXISTS (SELECT 1 FROM agent_board_moderation m WHERE m.entry_id = e.id)`).bind(projectId, seq).first<{ id: string; team_id: string }>();
  if (!entry) throw new BulletinCloseError("post not found", 404);
  return entry;
}

/** Which of these posts a reader has marked or recorded as read. */
export async function readEntryIds(env: Env, readerRef: string, entryIds: string[]): Promise<Set<string>> {
  const read = new Set<string>();
  for (const part of chunks([...new Set(entryIds)])) {
    const { results } = await env.DB.prepare(`SELECT entry_id FROM agent_board_reads WHERE reader_ref = ? AND entry_id IN (${part.map(() => "?").join(",")})`)
      .bind(readerRef, ...part).all<{ entry_id: string }>();
    (results ?? []).forEach((row) => read.add(row.entry_id));
  }
  return read;
}

type BoardReader = { agentId: string } | { userId: string };

/** After an agent's board read: record the returned Bulletin posts as read by it. Never fails the read. */
export async function recordAgentBoardRead(env: Env, projectId: string, reader: BoardReader, entryIds: string[]): Promise<void> {
  if (!("agentId" in reader) || !entryIds.length) return;
  try {
    await recordBulletinReads(env, { projectId, readerRef: `agent:${reader.agentId}`, entryIds });
  } catch (error) {
    console.error("Bulletin read tracking failed", error instanceof Error ? error.message : String(error));
  }
}

/** For a person's board read: which of these posts they marked read; null for an agent. */
export async function personReadEntryIds(env: Env, reader: BoardReader, entryIds: string[]): Promise<Set<string> | null> {
  return "userId" in reader ? await readEntryIds(env, `user:${reader.userId}`, entryIds) : null;
}
