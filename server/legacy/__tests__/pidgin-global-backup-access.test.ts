import { describe, expect, it } from "vitest";
import { canListGlobalWorkspaceBackups } from "../workspace-backup";
import type { Env } from "../types";

describe("PidginDocs global backup access", () => {
  const queries: Array<{ sql: string; email: string }> = [];
  const env = {
    OWNER_EMAIL: " Owner@Example.com ",
    DB: {
      prepare(sql: string) {
        return {
          bind(email: string) {
            queries.push({ sql, email });
            return {
              async first() { return { id: "platform-owner" }; },
            };
          },
        };
      },
    } as unknown as D1Database,
  } as Env;

  it("permits only the active platform owner's user ID", async () => {
    queries.length = 0;
    expect(await canListGlobalWorkspaceBackups(env, "platform-owner")).toBe(true);
    expect(await canListGlobalWorkspaceBackups(env, "customer-owner")).toBe(false);
    expect(queries).toHaveLength(2);
    expect(queries[0].email).toBe("owner@example.com");
    expect(queries[0].sql).toContain("status = 'active'");
  });

  it("fails closed if the platform owner is unconfigured", async () => {
    queries.length = 0;
    expect(await canListGlobalWorkspaceBackups({ ...env, OWNER_EMAIL: " " }, "platform-owner")).toBe(false);
    expect(queries).toHaveLength(0);
  });
});
