import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/push/apns", () => ({
  sendPushNotification: vi.fn(async () => {}),
}));

import {
  handleDeleteArtifact,
  handleGetArtifactMeta,
  handleListArtifacts,
  handlePatchArtifact,
  handlePublishArtifact,
  handleServeArtifact,
  handleShareArtifact,
  handleArtifactTelemetry,
  handleArtifactRuntimeComplete,
  handleArtifactRuntimeStorage,
} from "../core/routes/artifacts";
import {
  boubaKikiPath,
  boubaKikiSeedForId,
  BOUBA_KIKI_GLYPH_COUNT,
} from "../core/artifacts/identicon";
import {
  extractHtmlTitle,
  renderArtifactMarkdown,
  wrapArtifactHtml,
} from "../core/artifacts/render";
import { signArtifactEmbedToken } from "../core/artifacts/store";
import { resolveTier } from "../core/ai/tiers";
import { sendPushNotification } from "../core/push/apns";
import type { Env } from "../core/types";
import { installEditionHooks } from "../core/edition-hooks";
import { artifactEditSql, artifactReadSql, messageReadSql } from "../core/workspace-access";

// --- Mocks -----------------------------------------------------------------

class MockR2Bucket {
  readonly objects = new Map<string, string>();

  async put(key: string, value: string): Promise<void> {
    this.objects.set(key, value);
  }

  async get(key: string) {
    const value = this.objects.get(key);
    if (value === undefined) return null;
    return { async text() { return value; } };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

class MockKV {
  private readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) || null;
  }

  async getWithMetadata(key: string): Promise<{ value: string | null; metadata: unknown }> {
    return { value: this.store.get(key) || null, metadata: null };
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

interface ArtifactRecord {
  [key: string]: unknown;
  id: string;
  user_id: string;
  updated_at: string;
}

function nowSql(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// Stateful mock D1 covering the exact statements the artifacts store issues.
class MockDB {
  readonly artifacts = new Map<string, ArtifactRecord>();
  versions: Array<Record<string, unknown>> = [];
  storage: Array<Record<string, unknown>> = [];
  designSystems: Array<Record<string, unknown>> = [];
  messageBlocks: Array<{ message_id: string; artifact_id: string; artifact_version: number }> = [];
  messages: Array<{ id: string; user_id: string; team_id?: string | null; sharing?: string; type?: string }> = [];
  memberships: Array<{ team_id: string; user_id: string; role: string }> = [];
  readonly cleanup = new Map<string, Record<string, unknown>>();
  readonly uploads = new Map<string, Record<string, unknown>>();
  private lastChanges = 0;
  embedEvents: Array<Record<string, unknown>> = [];
  private clock = 0;

  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  // Monotonic timestamps so ORDER BY updated_at is deterministic in tests.
  tick(): string {
    this.clock += 1;
    return `2026-07-17 00:00:${String(this.clock).padStart(2, "0")}`;
  }

  // These fixtures model personal and legacy-team access. Governed policies
  // are exercised against real D1 in governed-document-access-d1.test.ts.
  canAccess(row: { user_id: string; team_id?: unknown; sharing?: unknown; type?: unknown } | undefined,
    userId: unknown, edit = false): boolean {
    if (!row || typeof userId !== "string") return false;
    if (!row.team_id) return row.user_id === userId;
    const membership = this.memberships.find(m => m.team_id === row.team_id && m.user_id === userId);
    if (!membership) return false;
    if (edit) return row.user_id === userId && ["owner", "admin", "member"].includes(membership.role);
    return row.user_id === userId || row.sharing === "shared" || (row.type != null && row.type !== "document");
  }

  prepare(sql: string) {
    const db = this;
    return {
      bind(...binds: unknown[]) {
        return {
          async first<T>(): Promise<T | null> {
            if (sql.includes("FROM users WHERE email")) {
              // Second identity for cross-user isolation tests below — every
              // other test only ever authenticates as test@example.com, so
              // this branch is inert for them.
              if (binds[0] === "attacker@example.com") {
                return { id: "attacker-id", email: "attacker@example.com" } as T;
              }
              return { id: "owner-id", email: "test@example.com" } as T;
            }
            if (sql.includes("FROM api_keys")) return null;
            if (sql.includes("FROM design_systems WHERE user_id = ? AND name = ?")) {
              const row = db.designSystems.find(
                (r) => r.user_id === binds[0] && r.name === binds[1]
              );
              return (row ?? null) as T | null;
            }
            if (sql.includes("SELECT * FROM artifacts WHERE id = ?")) {
              const row = db.artifacts.get(binds[0] as string);
              return (row ? { ...row } : null) as T | null;
            }
            if (sql.startsWith("SELECT id FROM artifacts WHERE id=? AND")) {
              expect(sql).toContain(artifactEditSql("artifacts"));
              expect(binds).toHaveLength(3);
              expect(binds[1]).toBe(binds[2]);
              const row = db.artifacts.get(binds[0] as string);
              return (db.canAccess(row, binds[1], true) ? { id: row!.id } : null) as T | null;
            }
            if (sql === "SELECT r2_key FROM artifact_versions WHERE artifact_id=? AND version=?") {
              const row = db.versions.find(v => v.artifact_id === binds[0] && v.version === binds[1]);
              return (row ? { r2_key: row.r2_key } : null) as T | null;
            }
            if (sql.includes("SELECT role FROM team_memberships WHERE team_id = ? AND user_id = ?")) {
              const row = db.memberships.find(m => m.team_id === binds[0] && m.user_id === binds[1]);
              return (row ? { role: row.role } : null) as T | null;
            }
            if (sql === "SELECT id, user_id, team_id, sharing, type FROM messages WHERE id = ?") {
              const row = db.messages.find(m => m.id === binds[0]);
              return (row ? { ...row, team_id: row.team_id ?? null, sharing: row.sharing ?? "private", type: row.type ?? "message" } : null) as T | null;
            }
            if (sql.includes("FROM artifacts WHERE user_id = ? AND source_path = ?")) {
              const wantSession = sql.includes("instance_session_id = ?");
              const rows = [...db.artifacts.values()]
                .filter(
                  (a) =>
                    a.user_id === binds[0] &&
                    a.source_path === binds[1] &&
                    (!wantSession || a.instance_session_id === binds[2])
                )
                .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
              return (rows[0] ?? null) as T | null;
            }
            if (sql.includes("COALESCE(SUM(LENGTH(CAST(value AS BLOB))), 0)")) {
              const total = db.storage
                .filter(
                  (r) =>
                    r.artifact_id === binds[0] && !(r.scope === binds[1] && r.key === binds[2])
                )
                .reduce((sum, r) => sum + new TextEncoder().encode(String(r.value)).byteLength, 0);
              return { total } as T;
            }
            if (sql.includes("SELECT LENGTH(CAST(value AS BLOB)) AS bytes FROM artifact_storage")) {
              const row = db.storage.find(r => r.artifact_id === binds[0] && r.scope === binds[1] && r.key === binds[2]);
              return (row ? { bytes: new TextEncoder().encode(String(row.value)).byteLength } : null) as T | null;
            }
            if (sql.includes("storage_artifact") && sql.endsWith(" AS allowed")) {
              expect(binds).toHaveLength(3);
              expect(binds[1]).toBe(binds[2]);
              // All team fixtures here are legacy: governed shared storage has
              // separate real-D1 tests. The canonical artifact must still exist.
              return { allowed: db.artifacts.has(String(binds[0])) ? 1 : 0 } as T;
            }
            if (sql.includes("SELECT value FROM artifact_storage")) {
              const row = db.storage.find(
                (r) => r.artifact_id === binds[0] && r.scope === binds[1] && r.key === binds[2]
              );
              return (row ?? null) as T | null;
            }
            if (sql.includes("FROM message_blocks b") && sql.includes("JOIN artifacts a")) {
              const block = db.messageBlocks.find(
                (entry) =>
                  entry.message_id === binds[0] &&
                  entry.artifact_id === binds[1] &&
                  entry.artifact_version === binds[2]
              );
              const message = db.messages.find((entry) => entry.id === block?.message_id);
              const artifact = block ? db.artifacts.get(block.artifact_id) : null;
              return (artifact && message?.user_id === artifact.user_id ? artifact : null) as T | null;
            }
            if (sql.includes("SELECT 1 AS found FROM message_blocks b")) {
              const block = db.messageBlocks.find(
                (entry) => entry.message_id === binds[0] && entry.artifact_id === binds[1]
              );
              const message = db.messages.find((entry) => entry.id === block?.message_id);
              expect(sql).toContain(messageReadSql("m"));
              expect(binds).toHaveLength(4);
              expect(binds[2]).toBe(binds[3]);
              return (block && db.canAccess(message, binds[2]) ? { found: 1 } : null) as T | null;
            }
            return null;
          },
          async all<T>(): Promise<{ results: T[] }> {
            if (sql.includes(" AS allowed FROM messages WHERE id=? AND team_id IS ?") &&
                sql.includes(" AS allowed FROM artifacts WHERE id=? AND team_id IS ?")) {
              expect(sql).toContain(messageReadSql("messages"));
              expect(sql).toContain(artifactReadSql("artifacts"));
              expect(binds).toHaveLength(8);
              expect([binds[1], binds[4], binds[5]]).toEqual([binds[0], binds[0], binds[0]]);
              expect(binds[6]).toBe(binds[2]);
              expect(binds[7]).toBe(binds[3]);
              const candidates = [db.messages.find(m => m.id === binds[2]), db.artifacts.get(String(binds[6]))];
              const rows = candidates.filter(row => row && (row.team_id ?? null) === binds[3])
                .map(row => ({ id: row!.id, allowed: db.canAccess(row, binds[0]) ? 1 : 0 }));
              return { results: rows as T[] };
            }
            if (sql.includes("FROM governed_content_cleanup")) {
              const row = db.cleanup.get(String(binds[0]));
              return { results: (row ? [{ ...row }] : []) as T[] };
            }
            if (sql.includes("SELECT DISTINCT artifact_version FROM message_blocks")) {
              const versions = [
                ...new Set(
                  db.messageBlocks
                    .filter((entry) => entry.artifact_id === binds[0])
                    .map((entry) => entry.artifact_version)
                ),
              ];
              return { results: versions.map((artifact_version) => ({ artifact_version })) as T[] };
            }
            if (sql.includes("FROM artifact_versions WHERE artifact_id = ?")) {
              const results = db.versions
                .filter((v) => v.artifact_id === binds[0])
                .sort((a, b) => (b.version as number) - (a.version as number));
              return { results: results as T[] };
            }
            if (
              sql.includes("FROM artifacts WHERE") &&
              sql.includes("ORDER BY updated_at DESC, id DESC")
            ) {
              let i = 0;
              const userId = binds[i++] as string;
              if (sql.includes("access_member")) {
                expect(binds[i++]).toBe(userId); // repeated ACL user ID
                if (sql.includes("AND user_id = ?")) expect(binds[i++]).toBe(userId); // mine scope
              }
              let role: string | null = null;
              if (sql.includes("role = ?")) {
                role = binds[i++] as string;
              }
              let q: string | null = null;
              if (sql.includes("LIKE")) {
                q = (binds[i] as string).replace(/%/g, "");
                i += 2;
              }
              let cursor: { updatedAt: string; id: string } | null = null;
              if (sql.includes("updated_at < ?")) {
                cursor = { updatedAt: binds[i] as string, id: binds[i + 2] as string };
                i += 3;
              }
              const limit = binds[i] as number;
              let rows = [...db.artifacts.values()].filter((a) => db.canAccess(a, userId));
              if (sql.includes("AND user_id = ?")) rows = rows.filter(a => a.user_id === userId);
              if (role) rows = rows.filter((a) => (a.role ?? "page") === role);
              if (q) {
                rows = rows.filter(
                  (a) =>
                    String(a.title).toLowerCase().includes(q!) ||
                    String(a.description ?? "").toLowerCase().includes(q!)
                );
              }
              rows.sort((a, b) => {
                const t = String(b.updated_at).localeCompare(String(a.updated_at));
                return t !== 0 ? t : String(b.id).localeCompare(String(a.id));
              });
              if (cursor) {
                rows = rows.filter(
                  (a) =>
                    String(a.updated_at) < cursor!.updatedAt ||
                    (String(a.updated_at) === cursor!.updatedAt && String(a.id) < cursor!.id)
                );
              }
              return { results: rows.slice(0, limit) as T[] };
            }
            if (sql.includes("SELECT key, updated_at FROM artifact_storage")) {
              const results = db.storage
                .filter((r) => r.artifact_id === binds[0] && r.scope === binds[1])
                .sort((a, b) => String(a.key).localeCompare(String(b.key)));
              return { results: results as T[] };
            }
            return { results: [] };
          },
          async run() {
            const result = (changes: number) => {
              db.lastChanges = changes;
              return { success: true, meta: { changes } };
            };
            if (sql.includes("WHERE changes() = 1") && db.lastChanges !== 1) return result(0);
            if (sql.includes("storage_artifact") && (sql.includes("INSERT INTO artifact_storage") || sql.includes("DELETE FROM artifact_storage"))) {
              const offset = sql.includes("INSERT INTO artifact_storage") ? 4 : 3;
              expect(binds).toHaveLength(offset + 3);
              expect(binds[offset]).toBe(binds[0]);
              expect(binds[offset + 1]).toBe(binds[offset + 2]);
              if (!db.artifacts.has(String(binds[0]))) return result(0);
            }
            if (sql.startsWith("INSERT INTO governed_content_cleanup")) {
              const [id, artifactId, ownerId, version, teamId, projectId, caller, repeatedCaller] = binds;
              expect(caller).toBe(repeatedCaller);
              expect(sql).toContain(artifactEditSql("artifacts"));
              const row = db.artifacts.get(String(artifactId));
              if (!row || row.user_id !== ownerId || row.current_version !== version || (row.team_id??null)!==teamId || (row.project_id??null)!==projectId || !db.canAccess(row, caller, true)) return result(0);
              const versions = db.versions.filter(v=>v.artifact_id===artifactId);
              const object_keys = JSON.stringify(versions.flatMap(v=>[v.r2_key,String(v.r2_key).replace(/\.html$/,'.md')]));
              const storage_bytes = versions.reduce((sum,v)=>sum+Number(v.size||0)+Number(v.source_size||0),0);
              db.cleanup.set(String(id), { id, resource_type: "artifact", user_id: row.user_id, object_keys, storage_bytes });
              return result(1);
            }
            if (sql.startsWith("INSERT INTO artifact_upload_attempts")) {
              if (sql.includes("FROM artifact_versions v JOIN artifacts")) {
                const [id,owner,_time,artifact_id,version,r2_key]=binds, a=db.artifacts.get(String(artifact_id));
                const v=db.versions.find(row=>row.artifact_id===artifact_id && row.version===version && row.r2_key===r2_key);
                if(!v||!a||a.current_version===version||a.shared_version===version||db.uploads.has(String(id))||db.messageBlocks.some(b=>b.artifact_id===artifact_id&&b.artifact_version===version))return result(0);
                db.uploads.set(String(id),{id,owner,artifact_id,version,r2_key,state:'retired'});
              } else {
                const [id,owner,artifact_id,version,r2_key]=binds;
                db.uploads.set(String(id),{id,owner,artifact_id,version,r2_key,state:'staging'});
              }
              return result(1);
            }
            if(sql.startsWith("UPDATE artifact_upload_attempts")){
              const row=db.uploads.get(String(binds[0]));if(!row)return result(0);row.state='retired';return result(1);
            }
            if(sql.startsWith("DELETE FROM artifact_upload_attempts")){
              if(sql.includes("EXISTS(SELECT 1 FROM artifact_versions")&&!db.versions.some(v=>v.artifact_id===binds[1]&&v.version===binds[2]&&v.r2_key===binds[3]))return result(0);
              return result(db.uploads.delete(String(binds[0]))?1:0);
            }
            if(sql.startsWith("DELETE FROM artifact_versions WHERE artifact_id=? AND version=? AND r2_key=?")){
              if(!db.uploads.has(String(binds[3])))return result(0);
              const count=db.versions.length;db.versions=db.versions.filter(v=>!(v.artifact_id===binds[0]&&v.version===binds[1]&&v.r2_key===binds[2]));
              return result(count-db.versions.length);
            }
            if (sql.includes("WHERE id=?)") && sql.includes("FROM governed_content_cleanup") && !db.cleanup.has(String(binds.at(-1)))) return result(0);
            if (sql.startsWith("DELETE FROM governed_content_cleanup")) return result(db.cleanup.delete(String(binds[0])) ? 1 : 0);
            if (sql.includes("INSERT INTO artifacts")) {
              const [
                id, user_id, title, description, favicon, source_path, source_kind,
                role, visibility, current_version, capabilities, design_system,
                instance_session_id, instance_project, team_id, project_id, sharing,
              ] = binds as string[];
              const stamp = db.tick();
              db.artifacts.set(id, {
                id, user_id, title, description, favicon, source_path, source_kind, role,
                visibility, shared_version: null, current_version, capabilities, design_system,
                instance_session_id, instance_project, sharing, team_id: team_id ?? null, project_id: project_id ?? null,
                created_at: stamp, updated_at: stamp,
              } as ArtifactRecord);
            } else if (sql.includes("UPDATE artifacts SET title = ?, description = COALESCE")) {
              const [
                title, description, favicon, source_path, source_kind, role, visibility,
                capabilities, design_system, current_version, session, project, teamId, projectId, id,
              ] = binds as (string | number | null)[];
              expect(sql).toContain(artifactEditSql("artifacts"));
              expect(binds).toHaveLength(20);
              expect(binds[18]).toBe(binds[19]);
              const row = db.artifacts.get(id as string);
              if (!row || (row.team_id ?? null) !== binds[15] || (row.project_id ?? null) !== binds[16] ||
                  row.current_version !== binds[17] || !db.canAccess(row, binds[18], true)) return result(0);
              Object.assign(row, {
                title,
                description: description ?? row.description,
                favicon,
                source_path: source_path ?? row.source_path,
                source_kind,
                role,
                visibility,
                capabilities,
                design_system,
                current_version,
                instance_session_id: session ?? row.instance_session_id,
                instance_project: project ?? row.instance_project,
                team_id: teamId ?? row.team_id,
                project_id: projectId ?? row.project_id,
                updated_at: db.tick(),
              });
            } else if (sql.includes("UPDATE artifacts SET title = ?, description = ?, visibility = ?")) {
              const [title, description, visibility, shared_version, design_system, id] =
                binds as (string | number | null)[];
              expect(sql).toContain(artifactEditSql("artifacts"));
              expect(binds).toHaveLength(14);
              expect(binds[12]).toBe(binds[13]);
              const row = db.artifacts.get(id as string);
              if (!row || row.current_version !== binds[6] || (row.team_id??null)!==binds[7] || (row.project_id??null)!==binds[8] || !db.canAccess(row, binds[12], true)) return result(0);
              if(binds[9]!==null&&!db.versions.some(v=>v.artifact_id===binds[10]&&v.version===binds[11]))return result(0);
              Object.assign(row, {
                title, description, visibility, shared_version, design_system,
                updated_at: db.tick(),
              });
            } else if (sql.includes("INSERT INTO artifact_versions")) {
              const [artifact_id, version, label, r2_key, size, created_by_session, source_size] = binds;
              db.versions.push({ artifact_id, version, label, r2_key, size, created_by_session, source_size, created_at: nowSql() });
            } else if (sql.includes("DELETE FROM artifact_versions WHERE artifact_id = ? AND version = ?")) {
              db.versions = db.versions.filter(
                (v) => !(v.artifact_id === binds[0] && v.version === binds[1])
              );
            } else if (/DELETE FROM artifact_versions WHERE artifact_id\s*=\s*\?/.test(sql)) {
              db.versions = db.versions.filter((v) => v.artifact_id !== binds[0]);
            } else if (sql.includes("DELETE FROM artifact_storage WHERE artifact_id = ? AND scope")) {
              db.storage = db.storage.filter(
                (r) => !(r.artifact_id === binds[0] && r.scope === binds[1] && r.key === binds[2])
              );
            } else if (/DELETE FROM artifact_storage WHERE artifact_id\s*=\s*\?/.test(sql)) {
              db.storage = db.storage.filter((r) => r.artifact_id !== binds[0]);
            } else if (/DELETE FROM artifacts WHERE id\s*=\s*\?/.test(sql)) {
              db.artifacts.delete(binds[0] as string);
            } else if (sql.includes("INSERT INTO artifact_storage")) {
              const [artifact_id, scope, key, value] = binds;
              const existing = db.storage.find(
                (r) => r.artifact_id === artifact_id && r.scope === scope && r.key === key
              );
              if (existing) existing.value = value;
              else db.storage.push({ artifact_id, scope, key, value, updated_at: nowSql() });
            } else if (sql.includes("INSERT INTO artifact_embed_events")) {
              const [user_id, message_id, artifact_id, event, duration_ms] = binds;
              db.embedEvents.push({ user_id, message_id, artifact_id, event, duration_ms });
            }
            // audit_log inserts: no-op
            return result(1);
          },
        };
      },
    };
  }
}

function makeEnv(): Env & { __db: MockDB; __r2: MockR2Bucket } {
  const db = new MockDB();
  const r2 = new MockR2Bucket();
  const sessions = new MockKV();
  sessions.put("session:test-session", "test@example.com");
  // Second identity for cross-user isolation tests — unused by every other
  // test in this file, so seeding it here is inert for them.
  sessions.put("session:attacker-session", "attacker@example.com");

  return {
    __db: db,
    __r2: r2,
    DB: db as unknown as D1Database,
    DOCS: r2 as unknown as R2Bucket,
    SESSIONS: sessions as unknown as KVNamespace,
    ENHANCE_QUEUE: { send: async () => {} } as unknown as Env["ENHANCE_QUEUE"],
    API_KEY: "test-key",
    OWNER_EMAIL: "test@example.com",
    APNS_KEY_ID: "",
    APNS_TEAM_ID: "",
    APNS_PRIVATE_KEY: "",
    WORKER_URL: "https://pidgin.example.com",
    ARTIFACT_EMBED_ORIGIN: "https://api.pidgin.example.com",
    ENVIRONMENT: "test",
  };
}

const fakeCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const AUTH = { Authorization: "Session test-session" };
const ATTACKER_AUTH = { Authorization: "Session attacker-session" };

function publishRequest(body: Record<string, unknown>): Request {
  return new Request("https://pidgin.example.com/api/artifacts", {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function publish(env: Env, body: Record<string, unknown>) {
  const response = await handlePublishArtifact(publishRequest(body), env, fakeCtx);
  const json = (await response.json()) as { ok: boolean; data?: any; error?: string };
  return { response, json };
}

// --- Publish + versions -----------------------------------------------------

describe("publishArtifact", () => {
  beforeEach(() => {
    vi.mocked(sendPushNotification).mockClear();
  });

  it("publishes a markdown artifact as v1 with stored html + source", async () => {
    const env = makeEnv();
    const { response, json } = await publish(env, {
      markdown: "# Hello\n\nWorld",
      title: "Hello",
      favicon: "🦉",
      description: "greeting page",
    });

    expect(response.status).toBe(201);
    expect(json.ok).toBe(true);
    expect(json.data.version).toBe(1);
    expect(json.data.url).toBe(`https://pidgin.example.com/a/${json.data.id}`);
    expect(json.data.artifact.visibility).toBe("private");
    const key = String(env.__db.versions.find(v => v.artifact_id === json.data.id && v.version === 1)!.r2_key);
    expect(key).toMatch(new RegExp(`^artifacts/${json.data.id}/v1-[0-9a-f-]{36}\\.html$`));
    expect(env.__r2.objects.has(key)).toBe(true);
    expect(env.__r2.objects.has(key.replace(/\.html$/, ".md"))).toBe(true);
  });

  it("republishing with artifact_id creates v2 at the same id", async () => {
    const env = makeEnv();
    const first = await publish(env, { html: "<p>one</p>", title: "Page", favicon: "📊" });
    const second = await publish(env, {
      html: "<p>two</p>",
      artifact_id: first.json.data.id,
      label: "second-draft",
    });

    expect(second.response.status).toBe(200);
    expect(second.json.data.id).toBe(first.json.data.id);
    expect(second.json.data.version).toBe(2);
    const key = String(env.__db.versions.find(v => v.artifact_id === first.json.data.id && v.version === 2)!.r2_key);
    expect(env.__r2.objects.get(key)).toBe("<p>two</p>");
  });

  it("matches identity by source_path", async () => {
    const env = makeEnv();
    const first = await publish(env, {
      html: "<p>a</p>",
      favicon: "🧭",
      source_path: "/tmp/report.html",
    });
    const second = await publish(env, { html: "<p>b</p>", source_path: "/tmp/report.html" });

    expect(second.json.data.id).toBe(first.json.data.id);
    expect(second.json.data.version).toBe(2);
  });

  it("409s on a stale base_version and succeeds with force", async () => {
    const env = makeEnv();
    const first = await publish(env, { html: "<p>a</p>", title: "T", favicon: "🌀" });
    const id = first.json.data.id;
    await publish(env, { html: "<p>b</p>", artifact_id: id });

    const stale = await publish(env, { html: "<p>c</p>", artifact_id: id, base_version: 1 });
    expect(stale.response.status).toBe(409);
    expect(stale.json.ok).toBe(false);

    const forced = await publish(env, {
      html: "<p>c</p>",
      artifact_id: id,
      base_version: 1,
      force: true,
    });
    expect(forced.response.status).toBe(200);
    expect(forced.json.data.version).toBe(3);
  });

  it("requires a favicon on create and rejects non-emoji", async () => {
    const env = makeEnv();
    const missing = await publish(env, { html: "<p>x</p>", title: "X" });
    expect(missing.response.status).toBe(400);

    const text = await publish(env, { html: "<p>x</p>", title: "X", favicon: "ab" });
    expect(text.response.status).toBe(400);
  });

  it("prefers an authored <title> tag over the title param", async () => {
    const env = makeEnv();
    const { json } = await publish(env, {
      html: "<html><head><title>Authored Title</title></head><body>hi</body></html>",
      title: "Param Title",
      favicon: "📝",
    });
    expect(json.data.title).toBe("Authored Title");
  });

  it("rejects public visibility on capability-declaring artifacts", async () => {
    const env = makeEnv();
    const { response } = await publish(env, {
      html: "<p>app</p>",
      title: "App",
      favicon: "⚙️",
      visibility: "public",
      capabilities: { complete: true },
    });
    expect(response.status).toBe(400);
  });

  it("prunes history to the newest 20 versions", async () => {
    const env = makeEnv();
    const first = await publish(env, { html: "<p>v1</p>", title: "P", favicon: "🌊" });
    const id = first.json.data.id;
    const oldKey = String(env.__db.versions.find(v => v.artifact_id === id && v.version === 1)!.r2_key);
    for (let i = 2; i <= 22; i++) {
      await publish(env, { html: `<p>v${i}</p>`, artifact_id: id });
    }

    expect(env.__db.versions.filter((v) => v.artifact_id === id)).toHaveLength(20);
    expect(env.__r2.objects.has(oldKey)).toBe(false);
    expect(env.__r2.objects.has(String(env.__db.versions.find(v => v.artifact_id === id && v.version === 22)!.r2_key))).toBe(true);
  });

  it("retains an older version while a message block pins it", async () => {
    const env = makeEnv();
    const first = await publish(env, { html: "<p>v1</p>", title: "Pinned", favicon: "📌" });
    const id = first.json.data.id;
    env.__db.messages.push({ id: "message-1", user_id: "owner-id" });
    env.__db.messageBlocks.push({ message_id: "message-1", artifact_id: id, artifact_version: 1 });

    for (let i = 2; i <= 22; i++) {
      await publish(env, { html: `<p>v${i}</p>`, artifact_id: id });
    }

    const kept = env.__db.versions
      .filter((entry) => entry.artifact_id === id)
      .map((entry) => entry.version);
    expect(kept).toContain(1);
    expect(kept).not.toContain(2);
    expect(env.__r2.objects.has(String(env.__db.versions.find(v => v.artifact_id === id && v.version === 1)!.r2_key))).toBe(true);
  });

  it("supports quiet widget creation while preserving legacy page notifications", async () => {
    const env = makeEnv();
    const quiet = await publish(env, {
      html: "<p>inline</p>",
      title: "Inline",
      favicon: "📈",
      role: "widget",
      notify: false,
    });
    expect(quiet.json.data.artifact.role).toBe("widget");
    expect(sendPushNotification).not.toHaveBeenCalled();

    await publish(env, { html: "<p>page</p>", title: "Page", favicon: "📄" });
    expect(sendPushNotification).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-boolean notify value instead of accidentally notifying", async () => {
    const env = makeEnv();
    const { response, json } = await publish(env, {
      html: "<p>inline</p>",
      title: "Inline",
      favicon: "📈",
      role: "widget",
      notify: "false",
    });
    expect(response.status).toBe(400);
    expect(json.error).toContain("notify");
    expect(sendPushNotification).not.toHaveBeenCalled();
  });
});

// --- Serving -----------------------------------------------------------------

describe("handleServeArtifact", () => {
  it("serves the wrapped page with the strict CSP and version header", async () => {
    const env = makeEnv();
    const { json } = await publish(env, { html: "<p>hi</p>", title: "Wrapped", favicon: "🎯" });

    const response = await handleServeArtifact(
      new Request(`https://pidgin.example.com/a/${json.data.id}`, { headers: AUTH }),
      env,
      json.data.id
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(response.headers.get("Content-Security-Policy")).toContain("connect-src 'none'");
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("X-Artifact-Version")).toBe("1");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>Wrapped</title>");
    expect(html).toContain("data:image/svg+xml");
    expect(html).toContain("data-theme");
  });

  it("blocks anonymous access to private artifacts but serves public ones", async () => {
    const env = makeEnv();
    const priv = await publish(env, { html: "<p>secret</p>", title: "S", favicon: "🔒" });
    const anonymous = await handleServeArtifact(
      new Request(`https://pidgin.example.com/a/${priv.json.data.id}`),
      env,
      priv.json.data.id
    );
    expect(anonymous.status).toBe(401);

    const pub = await publish(env, {
      html: "<p>open</p>",
      title: "O",
      favicon: "🌍",
      visibility: "public",
    });
    const open = await handleServeArtifact(
      new Request(`https://pidgin.example.com/a/${pub.json.data.id}`),
      env,
      pub.json.data.id
    );
    expect(open.status).toBe(200);
  });

  it("pins non-owners to shared_version while the owner sees any version", async () => {
    const env = makeEnv();
    const first = await publish(env, {
      html: "<p>v1</p>",
      title: "Pinned",
      favicon: "📌",
      visibility: "public",
    });
    const id = first.json.data.id;
    await publish(env, { html: "<p>v2</p>", artifact_id: id });

    const patch = await handlePatchArtifact(
      new Request(`https://pidgin.example.com/api/artifacts/${id}`, {
        method: "PATCH",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ shared_version: 1 }),
      }),
      env,
      id
    );
    expect(patch.status).toBe(200);

    const anonymous = await handleServeArtifact(
      new Request(`https://pidgin.example.com/a/${id}`),
      env,
      id
    );
    expect(anonymous.headers.get("X-Artifact-Version")).toBe("1");

    const anonymousV2 = await handleServeArtifact(
      new Request(`https://pidgin.example.com/a/${id}?v=2`),
      env,
      id
    );
    expect(anonymousV2.status).toBe(404);

    const ownerV2 = await handleServeArtifact(
      new Request(`https://pidgin.example.com/a/${id}?v=2`, { headers: AUTH }),
      env,
      id
    );
    expect(ownerV2.headers.get("X-Artifact-Version")).toBe("2");
  });

  it("magic share tokens grant access to private artifacts", async () => {
    const env = makeEnv();
    const { json } = await publish(env, { html: "<p>x</p>", title: "Tok", favicon: "🔑" });
    const id = json.data.id;

    const share = await handleShareArtifact(
      new Request(`https://pidgin.example.com/api/artifacts/${id}/share`, {
        method: "POST",
        headers: AUTH,
      }),
      env,
      id
    );
    const shareJson = (await share.json()) as { ok: boolean; data: { url: string } };
    expect(shareJson.ok).toBe(true);

    const viewer = await handleServeArtifact(new Request(shareJson.data.url), env, id);
    expect(viewer.status).toBe(200);
  });

  it("wires up mermaid when the content declares a diagram", async () => {
    const env = makeEnv();
    const { json } = await publish(env, {
      markdown: "# Flow\n\n```mermaid\ngraph TD; A-->B;\n```",
      title: "Flow",
      favicon: "🧜",
    });
    const response = await handleServeArtifact(
      new Request(`https://pidgin.example.com/a/${json.data.id}`, { headers: AUTH }),
      env,
      json.data.id
    );
    const html = await response.text();
    expect(html).toContain('<pre class="mermaid">');
    expect(html).toContain("/a/assets/mermaid.js");
  });

  it("serves a message-bound pinned embed only on the configured artifact origin", async () => {
    const env = makeEnv();
    const { json } = await publish(env, {
      html: "<button>Interactive</button>",
      title: "Bound",
      favicon: "🧭",
      role: "widget",
      notify: false,
      capabilities: { complete: true },
    });
    const id = json.data.id;
    env.__db.messages.push({ id: "message-embed", user_id: "owner-id" });
    env.__db.messageBlocks.push({
      message_id: "message-embed",
      artifact_id: id,
      artifact_version: 1,
    });
    const expires = Date.now() + 60_000;
    const token = await signArtifactEmbedToken(id, 1, "message-embed", expires, "test-key");
    const query = `v=1&embed=1&message=message-embed&expires=${expires}&token=${token}&nonce=n-1`;

    const response = await handleServeArtifact(
      new Request(`https://api.pidgin.example.com/a/${id}?${query}`),
      env,
      id
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors https://pidgin.example.com"
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(html).toContain("pidgin:artifact-size");
    expect(html).toContain('"n-1"');
    expect(html).not.toContain("/api/artifacts/runtime/");

    const wrongOrigin = await handleServeArtifact(
      new Request(`https://pidgin.example.com/a/${id}?${query}`),
      env,
      id
    );
    expect(wrongOrigin.status).toBe(404);
  });
});

describe("artifact telemetry", () => {
  it("accepts only owner-scoped message/artifact associations and clamps duration", async () => {
    const env = makeEnv();
    env.__db.messages.push({ id: "message-event", user_id: "owner-id" });
    env.__db.messageBlocks.push({
      message_id: "message-event",
      artifact_id: "artifact-event",
      artifact_version: 1,
    });

    const response = await handleArtifactTelemetry(
      new Request("https://pidgin.example.com/api/artifacts/telemetry", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({
          message_id: "message-event",
          artifact_id: "artifact-event",
          event: "loaded",
          duration_ms: 999_999,
        }),
      }),
      env
    );
    expect(response.status).toBe(202);
    expect(env.__db.embedEvents[0]).toMatchObject({ event: "loaded", duration_ms: 300_000 });

    const missing = await handleArtifactTelemetry(
      new Request("https://pidgin.example.com/api/artifacts/telemetry", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({
          message_id: "other",
          artifact_id: "artifact-event",
          event: "loaded",
        }),
      }),
      env
    );
    expect(missing.status).toBe(404);
  });
});

// --- List / meta / delete ----------------------------------------------------

describe("artifact listing and lifecycle", () => {
  it("lists newest-first with cursor pagination", async () => {
    const env = makeEnv();
    const a = await publish(env, { html: "<p>1</p>", title: "First", favicon: "1️⃣" });
    const b = await publish(env, { html: "<p>2</p>", title: "Second", favicon: "2️⃣" });
    const c = await publish(env, { html: "<p>3</p>", title: "Third", favicon: "3️⃣" });

    const page1 = await handleListArtifacts(
      new Request("https://pidgin.example.com/api/artifacts?limit=2", { headers: AUTH }),
      env
    );
    const json1 = (await page1.json()) as { data: { artifacts: any[]; next_cursor: string | null } };
    expect(json1.data.artifacts.map((x) => x.id)).toEqual([c.json.data.id, b.json.data.id]);
    expect(json1.data.next_cursor).toBeTruthy();

    const page2 = await handleListArtifacts(
      new Request(
        `https://pidgin.example.com/api/artifacts?limit=2&cursor=${json1.data.next_cursor}`,
        { headers: AUTH }
      ),
      env
    );
    const json2 = (await page2.json()) as { data: { artifacts: any[]; next_cursor: string | null } };
    expect(json2.data.artifacts.map((x) => x.id)).toEqual([a.json.data.id]);
    expect(json2.data.next_cursor).toBeNull();
  });

  it("returns metadata with version history", async () => {
    const env = makeEnv();
    const first = await publish(env, { html: "<p>1</p>", title: "Meta", favicon: "🗂️" });
    await publish(env, { html: "<p>2</p>", artifact_id: first.json.data.id, label: "round-two" });

    const meta = await handleGetArtifactMeta(
      new Request(`https://pidgin.example.com/api/artifacts/${first.json.data.id}`, { headers: AUTH }),
      env,
      first.json.data.id
    );
    const json = (await meta.json()) as { data: { artifact: any; versions: any[] } };
    expect(json.data.artifact.current_version).toBe(2);
    expect(json.data.versions).toHaveLength(2);
    expect(json.data.versions[0].label).toBe("round-two");
  });

  it("keeps legacy-team reads separate from author edits and defers deletion after membership removal", async () => {
    const env = makeEnv();
    env.__db.memberships.push(
      { team_id: "legacy-team", user_id: "owner-id", role: "owner" },
      { team_id: "legacy-team", user_id: "attacker-id", role: "member" },
    );
    const created = await publish(env, { html: "<p>Shared</p>", title: "Team page", favicon: "📄", team_id: "legacy-team", sharing: "shared" });
    expect(created.response.status).toBe(201);
    const id = created.json.data.id as string;
    const keys = [...env.__r2.objects.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(new RegExp(`^artifacts/${id}/v1-.+\\.html$`));
    const meta = (headers: Record<string, string>) => handleGetArtifactMeta(new Request(`https://pidgin.example.com/api/artifacts/${id}`, { headers }), env, id);
    expect((await meta(ATTACKER_AUTH)).status).toBe(200);
    const snapshot = { ...env.__db.artifacts.get(id)! };
    const patch = await handlePatchArtifact(new Request(`https://pidgin.example.com/api/artifacts/${id}`, {
      method: "PATCH", headers: { ...ATTACKER_AUTH, "Content-Type": "application/json" }, body: JSON.stringify({ title: "Unauthorized" }),
    }), env, id);
    expect(patch.status).toBe(404);
    expect(env.__db.artifacts.get(id)).toEqual(snapshot);
    env.__db.memberships = env.__db.memberships.filter(m => m.user_id !== "owner-id");
    const remove = () => handleDeleteArtifact(new Request(`https://pidgin.example.com/api/artifacts/${id}`, { method: "DELETE", headers: AUTH }), env, id);
    expect((await remove()).status).toBe(404);
    expect(env.__db.artifacts.get(id)).toEqual(snapshot);
    expect([...env.__r2.objects.keys()]).toEqual(keys);
    expect(env.__db.cleanup.size).toBe(0);
    env.__db.memberships.push({ team_id: "legacy-team", user_id: "owner-id", role: "owner" });
    expect((await remove()).status).toBe(200);
    expect(env.__db.artifacts.has(id)).toBe(false);
    expect(env.__db.versions.filter(v => v.artifact_id === id)).toEqual([]);
    expect(env.__r2.objects.size).toBe(0);
    expect(env.__db.cleanup.size).toBe(0);
  });

  it("deletes an artifact with all versions and stored pages", async () => {
    const env = makeEnv();
    const { json } = await publish(env, { html: "<p>x</p>", title: "Gone", favicon: "🗑️" });
    const id = json.data.id;
    const key = String(env.__db.versions.find(v => v.artifact_id === id && v.version === 1)!.r2_key);

    const del = await handleDeleteArtifact(
      new Request(`https://pidgin.example.com/api/artifacts/${id}`, { method: "DELETE", headers: AUTH }),
      env,
      id
    );
    expect(del.status).toBe(200);
    expect(env.__r2.objects.has(key)).toBe(false);

    const meta = await handleGetArtifactMeta(
      new Request(`https://pidgin.example.com/api/artifacts/${id}`, { headers: AUTH }),
      env,
      id
    );
    expect(meta.status).toBe(404);
  });
});

// --- Pure helpers ------------------------------------------------------------

describe("bouba/kiki identicons", () => {
  it("is deterministic and covers 100 glyphs", async () => {
    expect(boubaKikiPath(7)).toBe(boubaKikiPath(7));
    expect(boubaKikiPath(7)).not.toBe(boubaKikiPath(8));
    expect(BOUBA_KIKI_GLYPH_COUNT).toBe(100);
  });

  it("renders smooth curves for even seeds and straight spikes for odd", () => {
    expect(boubaKikiPath(0)).toContain("C ");
    expect(boubaKikiPath(0)).not.toContain("L ");
    expect(boubaKikiPath(1)).toContain("L ");
    expect(boubaKikiPath(1)).not.toContain("C ");
  });

  it("maps artifact ids to stable seeds", () => {
    const seed = boubaKikiSeedForId("4f2c1a9e-0000-4000-8000-123456789abc");
    expect(seed).toBe(boubaKikiSeedForId("4f2c1a9e-0000-4000-8000-123456789abc"));
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThan(100);
  });
});

describe("render helpers", () => {
  it("extracts authored titles", () => {
    expect(extractHtmlTitle("<html><head><title> Hi &amp; Bye </title></head></html>")).toBe("Hi & Bye");
    expect(extractHtmlTitle("<p>no title</p>")).toBeNull();
  });

  it("converts mermaid fences to renderable pre blocks", () => {
    const html = renderArtifactMarkdown("```mermaid\ngraph TD; A-->B;\n```");
    expect(html).toContain('<pre class="mermaid">');
    expect(html).toContain("A-->B");
    expect(html).not.toContain("language-mermaid");
  });

  it("injects the reset into authored complete documents without clobbering them", () => {
    const wrapped = wrapArtifactHtml({
      content: "<html><head><title>Mine</title><style>body{background:red}</style></head><body>x</body></html>",
      title: "Fallback",
      favicon: "🧩",
      artifactId: "abc",
      sourceKind: "html",
      hasCapabilities: false,
    });
    expect(wrapped).toContain("<title>Mine</title>");
    expect(wrapped).toContain("background:red");
    // Reset injected at head start so the authored style wins.
    expect(wrapped.indexOf("data-theme")).toBeLessThan(wrapped.indexOf("background:red"));
  });

  it("adds the runtime script only for capability-declaring artifacts", () => {
    const withCaps = wrapArtifactHtml({
      content: "<p>app</p>",
      title: "App",
      favicon: "⚙️",
      artifactId: "abc",
      sourceKind: "html",
      hasCapabilities: true,
    });
    const without = wrapArtifactHtml({
      content: "<p>page</p>",
      title: "Page",
      favicon: "📄",
      artifactId: "abc",
      sourceKind: "html",
      hasCapabilities: false,
    });
    expect(withCaps).toContain("/a/assets/runtime.js");
    expect(without).not.toContain("/a/assets/runtime.js");
  });
});

// --- Design systems ---------------------------------------------------------

describe("artifact design systems", () => {
  it("persists a builtin design_system on publish and serializes it", async () => {
    const env = makeEnv();
    const { response, json } = await publish(env, {
      markdown: "# Styled",
      title: "Styled",
      favicon: "🎨",
      design_system: "boardroom",
    });
    expect(response.status).toBe(201);
    expect(json.data.artifact.design_system).toBe("boardroom");
  });

  it("rejects an unknown design system", async () => {
    const env = makeEnv();
    const { response, json } = await publish(env, {
      html: "<p>x</p>",
      title: "X",
      favicon: "🎨",
      design_system: "no-such-style",
    });
    expect(response.status).toBe(400);
    expect(json.error).toContain("unknown design system");
  });

  it("carries design_system forward on republish and clears on null", async () => {
    const env = makeEnv();
    const first = await publish(env, {
      html: "<p>a</p>",
      title: "T",
      favicon: "🎨",
      design_system: "sumi",
    });
    const second = await publish(env, { html: "<p>b</p>", artifact_id: first.json.data.id });
    expect(second.json.data.artifact.design_system).toBe("sumi");

    const cleared = await publish(env, {
      html: "<p>c</p>",
      artifact_id: first.json.data.id,
      design_system: null,
    });
    expect(cleared.json.data.artifact.design_system).toBeNull();
  });

  it("injects the style's --ds-* overrides at serve time, after the house reset", async () => {
    const env = makeEnv();
    const { json } = await publish(env, {
      markdown: "# Doc",
      title: "Doc",
      favicon: "🎨",
      design_system: "boardroom",
    });
    const response = await handleServeArtifact(
      new Request(`https://pidgin.example.com/a/${json.data.id}`, { headers: AUTH }),
      env,
      json.data.id
    );
    const html = await response.text();
    const houseBg = html.indexOf("--ds-bg: #FEFCF7");
    const boardroomBg = html.indexOf("--ds-bg: #F8F9FB");
    expect(houseBg).toBeGreaterThan(-1);
    expect(boardroomBg).toBeGreaterThan(houseBg);
  });

  it("serves the house defaults when no design system is declared", async () => {
    const env = makeEnv();
    const { json } = await publish(env, { html: "<p>hi</p>", title: "Plain", favicon: "🎨" });
    const response = await handleServeArtifact(
      new Request(`https://pidgin.example.com/a/${json.data.id}`, { headers: AUTH }),
      env,
      json.data.id
    );
    const html = await response.text();
    expect(html).toContain("--ds-bg: #FEFCF7;");
    expect(html).toContain("background: var(--ds-bg)");
    expect(html).not.toContain("--ds-bg: #F8F9FB");
  });

  it("rejects a non-string design_system with 400, not 500", async () => {
    const env = makeEnv();
    const { response, json } = await publish(env, {
      html: "<p>x</p>",
      title: "X",
      favicon: "🎨",
      design_system: 42,
    });
    expect(response.status).toBe(400);
    expect(json.error).toContain('"design_system"');
  });

  it("clears back to house on an empty-string design_system", async () => {
    const env = makeEnv();
    const first = await publish(env, {
      html: "<p>a</p>",
      title: "T",
      favicon: "🎨",
      design_system: "riso",
    });
    const cleared = await publish(env, {
      html: "<p>b</p>",
      artifact_id: first.json.data.id,
      design_system: "",
    });
    expect(cleared.json.data.artifact.design_system).toBeNull();
  });

  it("resolves a user-stored style at serve time and degrades when corrupt or deleted", async () => {
    const env = makeEnv();
    env.__db.designSystems.push({
      user_id: "owner-id",
      name: "my-zine",
      display_name: "My Zine",
      description: "",
      tokens_json: JSON.stringify({
        color: { background: { $value: "#FFEE00" }, text: { $value: "#101010" } },
        font: { body: { $value: ["Arial"] }, heading: { $value: ["Georgia"] } },
      }),
      css: null,
      source: "custom",
    });

    const { json } = await publish(env, {
      markdown: "# Z",
      title: "Z",
      favicon: "🎨",
      design_system: "my-zine",
    });
    expect(json.data.artifact.design_system).toBe("my-zine");

    const serve = () =>
      handleServeArtifact(
        new Request(`https://pidgin.example.com/a/${json.data.id}`, { headers: AUTH }),
        env,
        json.data.id
      );

    expect(await (await serve()).text()).toContain("--ds-bg: #FFEE00;");

    // Corrupt stored tokens: degrade to house rendering, never 500.
    env.__db.designSystems[0].tokens_json = "{not json";
    const corrupt = await serve();
    expect(corrupt.status).toBe(200);
    expect(await corrupt.text()).not.toContain("--ds-bg: #FFEE00;");

    // Style deleted after being declared: same degrade.
    env.__db.designSystems.length = 0;
    const deleted = await serve();
    expect(deleted.status).toBe(200);
    expect(await deleted.text()).toContain("--ds-bg: #FEFCF7;");
  });

  it("PATCH restyles or clears without republishing", async () => {
    const env = makeEnv();
    const { json } = await publish(env, { html: "<p>x</p>", title: "P", favicon: "🎨" });
    const id = json.data.id;

    const patchRequest = (body: Record<string, unknown>) =>
      new Request(`https://pidgin.example.com/api/artifacts/${id}`, {
        method: "PATCH",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const styled = await handlePatchArtifact(patchRequest({ design_system: "teletype" }), env, id);
    const styledJson = (await styled.json()) as { data: { artifact: { design_system: string | null } } };
    expect(styledJson.data.artifact.design_system).toBe("teletype");

    const unknown = await handlePatchArtifact(patchRequest({ design_system: "nope" }), env, id);
    expect(unknown.status).toBe(400);

    const cleared = await handlePatchArtifact(patchRequest({ design_system: null }), env, id);
    const clearedJson = (await cleared.json()) as { data: { artifact: { design_system: string | null } } };
    expect(clearedJson.data.artifact.design_system).toBeNull();
  });
});

// --- Runtime endpoints — cross-user isolation --------------------------------
//
// rt/storage and rt/complete only require *some* signed-in caller
// (resolveCallerUserId), so unlike every other by-id artifact route they used
// to skip the row.user_id / visibility check entirely. A second authenticated
// user of the same deployment who merely knew (or guessed) a private,
// capability-declaring artifact's id could read/write its storage — "shared"
// scope included — and spend the owner's ANTHROPIC_API_KEY budget through
// rt/complete. Both handlers now 404 for a non-owner, non-public caller,
// exactly like handleGetArtifactMeta does.
describe("runtime endpoints (rt/storage, rt/complete) reject non-owner callers", () => {
  async function publishCapabilityArtifact(env: Env) {
    const { json } = await publish(env, {
      html: "<p>secret</p>",
      title: "Capability artifact",
      favicon: "🔒",
      capabilities: { storage: true, complete: true },
    });
    expect(json.data.artifact.visibility).toBe("private");
    return json.data.id as string;
  }

  function storageRequest(id: string, auth: Record<string, string>, body: Record<string, unknown>): Request {
    return new Request(`https://pidgin.example.com/api/artifacts/${id}/rt/storage`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function completeRequest(id: string, auth: Record<string, string>, body: Record<string, unknown>): Request {
    return new Request(`https://pidgin.example.com/api/artifacts/${id}/rt/complete`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("rt/storage 404s a foreign user and writes nothing (shared scope included)", async () => {
    const env = makeEnv();
    const id = await publishCapabilityArtifact(env);

    const attackerSet = await handleArtifactRuntimeStorage(
      storageRequest(id, ATTACKER_AUTH, { op: "set", key: "pwned", value: "attacker-was-here", mode: "shared" }),
      env,
      id
    );
    expect(attackerSet.status).toBe(404);
    expect(((await attackerSet.json()) as { ok: boolean }).ok).toBe(false);
    expect(env.__db.storage.length).toBe(0);

    const attackerGet = await handleArtifactRuntimeStorage(
      storageRequest(id, ATTACKER_AUTH, { op: "get", key: "pwned", mode: "shared" }),
      env,
      id
    );
    expect(attackerGet.status).toBe(404);

    // Owner's own use of the same endpoint is unaffected.
    const ownerSet = await handleArtifactRuntimeStorage(
      storageRequest(id, AUTH, { op: "set", key: "note", value: "owner-write", mode: "personal" }),
      env,
      id
    );
    expect(ownerSet.status).toBe(200);
    expect(env.__db.storage.some((r) => r.value === "owner-write")).toBe(true);
  });

  it("rt/complete 404s a foreign user before ever touching the completion API", async () => {
    const env = makeEnv();
    const id = await publishCapabilityArtifact(env);

    const res = await handleArtifactRuntimeComplete(
      completeRequest(id, ATTACKER_AUTH, { prompt: "spend the owner's API budget" }),
      env,
      id
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });

  it("rt/complete answers on the claude-fast tier by default", async () => {
    const env = { ...makeEnv(), ANTHROPIC_API_KEY: "sk-test" };
    const id = await publishCapabilityArtifact(env);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: [{ type: "text", text: "done" }], usage: { input_tokens: 3, output_tokens: 1 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = await handleArtifactRuntimeComplete(completeRequest(id, AUTH, { prompt: "hello" }), env, id);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: { completion: string; tier: string; fell_back: boolean } }).data).toEqual({ completion: "done", tier: "claude-fast", fell_back: false });
      expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).model).toBe(resolveTier("claude-fast").model);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rt/complete without an Anthropic key answers from workers-fast, says so, and meters its price", async () => {
    const recorded: Array<[string, number, number]> = [];
    installEditionHooks({
      aiBudgetLeft: async () => 1_000_000,
      recordAiUsage: async (_env, _ctx, model, inTok, outTok) => { recorded.push([model, inTok, outTok]); },
    });
    try {
      const run = vi.fn().mockResolvedValue({ response: "from workers", usage: { prompt_tokens: 12, completion_tokens: 4 } });
      const env = { ...makeEnv(), AI: { run } } as unknown as Env;
      const id = await publishCapabilityArtifact(env);
      const res = await handleArtifactRuntimeComplete(completeRequest(id, AUTH, { prompt: "hello" }), env, id);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: unknown }).data).toEqual({ completion: "from workers", tier: "workers-fast", fell_back: true });
      expect(recorded).toEqual([[resolveTier("workers-fast").model, 12, 4]]);
    } finally {
      installEditionHooks({});
    }
  });

  it("rt/complete answers 502 with a clean message when Workers AI rejects and nothing else can answer", async () => {
    const run = vi.fn().mockRejectedValue(new Error("model overloaded"));
    const env = { ...makeEnv(), AI: { run } } as unknown as Env;
    const id = await publishCapabilityArtifact(env);
    const res = await handleArtifactRuntimeComplete(completeRequest(id, AUTH, { prompt: "hello" }), env, id);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/^completion failed \(503\): No AI tier could answer/);
  });

  describe("a model the artifact declares", () => {
    const declared = async (env: Env) => {
      const { json } = await publish(env, { html: "<p>x</p>", title: "Own model", favicon: "🔒", capabilities: { complete: true, model: "claude-opus-5-5" } });
      return json.data.id as string;
    };
    const hooks = (budget: number, recorded: Array<[string, number, number]>) => installEditionHooks({
      aiBudgetLeft: async () => budget,
      recordAiUsage: async (_env, _ctx, model, inTok, outTok) => { recorded.push([model, inTok, outTok]); },
    });
    afterEach(() => { vi.unstubAllGlobals(); installEditionHooks({}); });

    it("is metered at the declared model with the reply's token counts", async () => {
      const recorded: Array<[string, number, number]> = [];
      hooks(1_000_000, recorded);
      const env = { ...makeEnv(), ANTHROPIC_API_KEY: "sk-test" };
      const id = await declared(env);
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: [{ type: "text", text: "done" }], usage: { input_tokens: 9, output_tokens: 2 } }), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const res = await handleArtifactRuntimeComplete(completeRequest(id, AUTH, { prompt: "hello" }), env, id);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: { completion: string } }).data.completion).toBe("done");
      expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).model).toBe("claude-opus-5-5");
      expect(recorded).toEqual([["claude-opus-5-5", 9, 2]]);
    });

    it("answers 429 on a spent allowance and never calls fetch", async () => {
      hooks(0, []);
      const env = { ...makeEnv(), ANTHROPIC_API_KEY: "sk-test" };
      const id = await declared(env);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const res = await handleArtifactRuntimeComplete(completeRequest(id, AUTH, { prompt: "hello" }), env, id);
      expect(res.status).toBe(429);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("still answers 503 without an Anthropic key", async () => {
      const env = makeEnv();
      const id = await declared(env);
      const res = await handleArtifactRuntimeComplete(completeRequest(id, AUTH, { prompt: "hello" }), env, id);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe("ANTHROPIC_API_KEY is not configured on the server");
    });

    it("answers 502 with the provider status for a provider error", async () => {
      hooks(1, []);
      const env = { ...makeEnv(), ANTHROPIC_API_KEY: "sk-test" };
      const id = await declared(env);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "bad model" } }), { status: 400 })));
      const res = await handleArtifactRuntimeComplete(completeRequest(id, AUTH, { prompt: "hello" }), env, id);
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: string }).error).toBe("completion failed (400): bad model");
    });
  });

  it("rt/storage still 404s a made-up id for any caller (no existence leak)", async () => {
    const env = makeEnv();
    const res = await handleArtifactRuntimeStorage(
      storageRequest("does-not-exist", ATTACKER_AUTH, { op: "list", mode: "shared" }),
      env,
      "does-not-exist"
    );
    expect(res.status).toBe(404);
  });
});
