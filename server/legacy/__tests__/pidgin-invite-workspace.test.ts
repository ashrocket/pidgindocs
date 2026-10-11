import { describe, expect, it } from "vitest";
import { handleVerify } from "../routes/auth";
import type { Env } from "../types";

class InviteDB {
  user = { id: "invited-user", email: "invited@example.com", status: "pending" };
  teamOwner: string | null = null;
  membership: string | null = null;
  projectTeam: string | null = null;

  prepare(sql: string) {
    const db = this;
    let binds: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) { binds = values; return statement; },
      async first<T>(): Promise<T | null> {
        if (sql.includes("SELECT id, email FROM users")) {
          return (db.user.status === "active" ? { id: db.user.id, email: db.user.email } : null) as T | null;
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
      async run() {
        if (sql.startsWith("UPDATE users SET status = 'active'")) db.user.status = "active";
        else if (sql.startsWith("INSERT OR IGNORE INTO teams")) db.teamOwner = binds[3] as string;
        else if (sql.startsWith("INSERT OR IGNORE INTO team_memberships")) db.membership = binds[1] as string;
        else if (sql.startsWith("INSERT OR IGNORE INTO projects")) db.projectTeam = binds[1] as string;
        else throw new Error(`Unexpected mutation: ${sql}`);
        return { success: true };
      },
    };
    return statement;
  }

  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    for (const statement of statements) await statement.run();
    return [];
  }
}

describe("PidginDocs invitation activation", () => {
  it("creates the invited customer's own workspace before consuming the login link", async () => {
    const db = new InviteDB();
    const values = new Map<string, string>([
      ["magic:invite-token", JSON.stringify({ email: db.user.email, next: "/toc", activate: true })],
    ]);
    const env = {
      DB: db as unknown as D1Database,
      SESSIONS: {
        get: async (key: string) => values.get(key) ?? null,
        put: async (key: string, value: string) => { values.set(key, value); },
        delete: async (key: string) => { values.delete(key); },
      } as unknown as KVNamespace,
    } as Env;
    const response = await handleVerify(new Request("https://pidgindocs.example.workers.dev/auth/verify?token=invite-token", {
      headers: { Accept: "application/json" },
    }), env);
    expect(response.status).toBe(200);
    expect(db.user.status).toBe("active");
    expect(db.teamOwner).toBe(db.user.id);
    expect(db.membership).toBe(db.user.id);
    expect(db.projectTeam).toBe(`pidgin-${db.user.id}`);
    expect(values.has("magic:invite-token")).toBe(false);
  });
});
