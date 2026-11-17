import { describe, expect, it } from "vitest";
import type { Env } from "../core/types";
import {
  deleteDesignSystem,
  getDesignSystem,
  isReservedDesignSystemName,
  isValidDesignSystemName,
  listDesignSystems,
  putDesignSystem,
  resolveDesignSystem,
} from "../core/design-systems";
import { BUILTIN_DESIGN_SYSTEMS } from "../core/documents/styles";

type DsRow = {
  id: string; user_id: string; name: string; display_name: string;
  description: string | null; tokens_json: string; css: string | null; source: string;
};

class MockDB {
  rows: DsRow[] = [];
  prepare(sql: string) {
    const db = this;
    let binds: unknown[] = [];
    const statement = {
      bind(...args: unknown[]) { binds = args; return statement; },
      async all<T>() {
        // list: SELECT ... WHERE user_id = ? ORDER BY name
        const userId = binds[0] as string;
        const results = db.rows
          .filter((r) => r.user_id === userId)
          .sort((a, b) => a.name.localeCompare(b.name));
        return { results: results as unknown as T[] };
      },
      async first<T>() {
        // get: SELECT ... WHERE user_id = ? AND name = ?
        const [userId, name] = binds as [string, string];
        return (db.rows.find((r) => r.user_id === userId && r.name === name) ?? null) as T | null;
      },
      async run() {
        if (sql.startsWith("DELETE")) {
          const [userId, name] = binds as [string, string];
          const before = db.rows.length;
          db.rows = db.rows.filter((r) => !(r.user_id === userId && r.name === name));
          return { meta: { changes: before - db.rows.length } };
        }
        // upsert INSERT ... ON CONFLICT(user_id, name) DO UPDATE
        const [id, userId, name, displayName, description, tokensJson, css, source] =
          binds as [string, string, string, string, string, string, string | null, string];
        const existing = db.rows.find((r) => r.user_id === userId && r.name === name);
        if (existing) {
          Object.assign(existing, { display_name: displayName, description, tokens_json: tokensJson, css, source });
        } else {
          db.rows.push({ id, user_id: userId, name, display_name: displayName, description, tokens_json: tokensJson, css, source });
        }
        return { meta: { changes: 1 } };
      },
    };
    return statement;
  }
}

function makeEnv(db: MockDB): Env {
  return { DB: db } as unknown as Env;
}

const tokens = {
  color: { background: { $value: "#FFFFFF" }, text: { $value: "#111111" } },
  font: { body: { $value: ["Georgia", "serif"] }, heading: { $value: ["Arial", "sans-serif"] } },
};

describe("name rules", () => {
  it("validates kebab-case names", () => {
    expect(isValidDesignSystemName("my-brand-2")).toBe(true);
    expect(isValidDesignSystemName("My Brand")).toBe(false);
    expect(isValidDesignSystemName("-nope")).toBe(false);
    expect(isValidDesignSystemName("a")).toBe(false);
  });
  it("reserves builtin names and 'import'", () => {
    expect(isReservedDesignSystemName("pidgin-editorial")).toBe(true);
    expect(isReservedDesignSystemName("import")).toBe(true);
    expect(isReservedDesignSystemName("my-brand")).toBe(false);
  });
});

describe("storage", () => {
  it("lists builtins plus the caller's own systems only", async () => {
    const db = new MockDB();
    const env = makeEnv(db);
    await putDesignSystem(env, "user-a", { name: "brand-a", tokens });
    await putDesignSystem(env, "user-b", { name: "brand-b", tokens });

    const names = (await listDesignSystems(env, "user-a")).map((d) => d.name);
    // every builtin style first (in stack order), then the caller's own —
    // and never user-b's.
    const builtinNames = BUILTIN_DESIGN_SYSTEMS.map((d) => d.name);
    expect(names).toEqual([...builtinNames, "brand-a"]);
  });

  it("gets builtins for any user and user systems scoped by user_id", async () => {
    const db = new MockDB();
    const env = makeEnv(db);
    await putDesignSystem(env, "user-a", { name: "brand-a", tokens });

    expect((await getDesignSystem(env, "user-b", "pidgin-editorial"))?.source).toBe("builtin");
    expect(await getDesignSystem(env, "user-b", "brand-a")).toBeNull();
    expect((await getDesignSystem(env, "user-a", "brand-a"))?.tokens).toEqual(tokens);
  });

  it("upserts on repeated put", async () => {
    const db = new MockDB();
    const env = makeEnv(db);
    await putDesignSystem(env, "user-a", { name: "brand-a", tokens, description: "v1" });
    await putDesignSystem(env, "user-a", { name: "brand-a", tokens, description: "v2" });
    expect(db.rows.length).toBe(1);
    expect(db.rows[0].description).toBe("v2");
  });

  it("rejects reserved and invalid names", async () => {
    const env = makeEnv(new MockDB());
    await expect(putDesignSystem(env, "u", { name: "pidgin-editorial", tokens })).rejects.toThrow(/reserved/);
    await expect(putDesignSystem(env, "u", { name: "import", tokens })).rejects.toThrow(/reserved/);
    await expect(putDesignSystem(env, "u", { name: "Bad Name", tokens })).rejects.toThrow(/name/);
  });

  it("deletes own systems, never builtins, never other users'", async () => {
    const db = new MockDB();
    const env = makeEnv(db);
    await putDesignSystem(env, "user-a", { name: "brand-a", tokens });

    expect(await deleteDesignSystem(env, "user-a", "pidgin-editorial")).toBe(false);
    expect(await deleteDesignSystem(env, "user-b", "brand-a")).toBe(false);
    expect(await deleteDesignSystem(env, "user-a", "brand-a")).toBe(true);
    expect(db.rows.length).toBe(0);
  });

  it("resolve defaults to pidgin-editorial and returns null for unknown names", async () => {
    const env = makeEnv(new MockDB());
    expect((await resolveDesignSystem(env, "u"))?.name).toBe("pidgin-editorial");
    expect(await resolveDesignSystem(env, "u", "ghost")).toBeNull();
  });
});
