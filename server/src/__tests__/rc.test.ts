import { beforeEach, describe, expect, it } from "vitest";

import {
  handleRcCommand,
  handleRcPoll,
  handleRcGetResult,
  handleRcStatus,
  handleRcSubmitResult,
} from "../core/routes/rc";
import type { RcCommand } from "../core/routes/rc";
import { __clearApiKeyCache } from "../core/middleware";
import type { Env } from "../core/types";

const OWNER_EMAIL = "test@example.com";

// ---------------------------------------------------------------------------
// Mocks. The rc queue lives entirely in KV (SESSIONS); D1 is only touched by
// the auth fallbacks (per-user api_keys lookup, owner lookup, session→user).

class MockKV {
  data = new Map<string, string>();
  ttls = new Map<string, number | undefined>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async getWithMetadata<M>(key: string): Promise<{ value: string | null; metadata: M | null }> {
    const value = this.data.get(key) ?? null;
    return {
      value,
      metadata: value ? ({ exp: Math.floor(Date.now() / 1000) + 100_000 } as unknown as M) : null,
    };
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.data.set(key, value);
    this.ttls.set(key, opts?.expirationTtl);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

class MockDB {
  // Set to simulate a per-user API key row (api_keys JOIN users).
  apiKeyRow: { user_id: string; email: string } | null = null;

  prepare(sql: string) {
    const db = this;
    return {
      bind: () => ({
        async run() {
          return { success: true, meta: { changes: 1 } };
        },
        async first() {
          if (sql.includes("FROM api_keys")) return db.apiKeyRow;
          if (sql.includes("FROM users WHERE email")) {
            return { id: "owner-id", email: OWNER_EMAIL };
          }
          return null;
        },
        async all() {
          return { results: [] };
        },
      }),
      async run() {
        return { success: true, meta: { changes: 0 } };
      },
      async first() {
        if (sql.includes("COUNT(*) as c FROM users")) return { c: 1 };
        return null;
      },
      async all() {
        return { results: [] };
      },
    };
  }
}

function makeEnv(): { env: Env; kv: MockKV; db: MockDB } {
  const kv = new MockKV();
  const db = new MockDB();
  const env = {
    DB: db as unknown as D1Database,
    DOCS: {} as R2Bucket,
    SESSIONS: kv as unknown as KVNamespace,
    ENHANCE_QUEUE: {} as Env["ENHANCE_QUEUE"],
    API_KEY: "master-key",
    OWNER_EMAIL,
    APNS_KEY_ID: "",
    APNS_TEAM_ID: "",
    APNS_PRIVATE_KEY: "",
    WORKER_URL: "https://pidgin.example.com",
    ENVIRONMENT: "test",
  } as Env;
  return { env, kv, db };
}

function rcRequest(
  path: string,
  opts: { method?: string; body?: unknown; token?: string | null; session?: string } = {}
): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token !== null) {
    headers.Authorization = opts.session
      ? `Session ${opts.session}`
      : `Bearer ${opts.token ?? "master-key"}`;
  }
  return new Request(`https://pidgin.example.com${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function enqueue(env: Env, action = "navigate", extra: Record<string, unknown> = {}): Promise<string> {
  const response = await handleRcCommand(
    rcRequest("/rc/command", { method: "POST", body: { action, ...extra } }),
    env
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { ok: boolean; data: { id: string } };
  return body.data.id;
}

beforeEach(() => {
  __clearApiKeyCache();
});

// ---------------------------------------------------------------------------

describe("rc auth", () => {
  it("1. rejects all rc endpoints without credentials", async () => {
    const { env } = makeEnv();
    for (const [handler, req] of [
      [handleRcCommand, rcRequest("/rc/command", { method: "POST", body: { action: "x" }, token: null })],
      [handleRcPoll, rcRequest("/rc/poll", { token: null })],
      [handleRcStatus, rcRequest("/rc/status", { token: null })],
    ] as const) {
      const response = await (handler as (r: Request, e: Env) => Promise<Response>)(req, env);
      expect(response.status).toBe(401);
    }
  });

  it("2. accepts the owner's per-user API key", async () => {
    const { env, db } = makeEnv();
    db.apiKeyRow = { user_id: "owner-id", email: OWNER_EMAIL };
    const response = await handleRcPoll(rcRequest("/rc/poll", { token: "pidgin_sk_owner" }), env);
    expect(response.status).toBe(200);
  });

  it("3. rejects another user's per-user API key (queue is owner-global)", async () => {
    const { env, db } = makeEnv();
    db.apiKeyRow = { user_id: "intruder-id", email: "intruder@example.com" };
    const response = await handleRcPoll(rcRequest("/rc/poll", { token: "pidgin_sk_intruder" }), env);
    expect(response.status).toBe(401);
  });

  it("4. accepts a web/app session token", async () => {
    const { env, kv } = makeEnv();
    kv.data.set("session:sess-token", OWNER_EMAIL);
    const response = await handleRcPoll(rcRequest("/rc/poll", { session: "sess-token" }), env);
    expect(response.status).toBe(200);
  });

  // Regression: the session fallback used to accept ANY valid session
  // (`return !!session`), so a second, non-owner active user's own web/app
  // session could poll and submit into the owner's remote-control relay even
  // though the code comment (and the API-key branch just above it) explicitly
  // documents this queue as owner-only ("scoped to the owner because the rc
  // queue is a single global KV key"). Must mirror test 3's rejection for the
  // API-key path.
  it("5. rejects another user's session (queue is owner-global)", async () => {
    const { env, kv } = makeEnv();
    kv.data.set("session:intruder-session", "intruder@example.com");
    const response = await handleRcPoll(rcRequest("/rc/poll", { session: "intruder-session" }), env);
    expect(response.status).toBe(401);
  });
});

describe("handleRcCommand", () => {
  it("5. stores the command in KV with a TTL and appends it to the queue", async () => {
    const { env, kv } = makeEnv();
    const id = await enqueue(env, "navigate", { type: "eval", params: { url: "https://x.test" } });

    const stored = JSON.parse(kv.data.get(`rc:cmd:${id}`)!) as RcCommand;
    expect(stored).toMatchObject({
      id,
      action: "navigate",
      type: "eval",
      status: "pending",
      params: { url: "https://x.test" },
    });
    expect(kv.ttls.get(`rc:cmd:${id}`)).toBe(600);
    expect(JSON.parse(kv.data.get("rc:queue")!)).toEqual([id]);
  });

  it("6. rejects invalid JSON and a missing action", async () => {
    const { env } = makeEnv();
    const badJson = await handleRcCommand(
      new Request("https://pidgin.example.com/rc/command", {
        method: "POST",
        headers: { Authorization: "Bearer master-key" },
        body: "{nope",
      }),
      env
    );
    expect(badJson.status).toBe(400);

    const noAction = await handleRcCommand(
      rcRequest("/rc/command", { method: "POST", body: { action: "   " } }),
      env
    );
    expect(noAction.status).toBe(400);
  });

  it("7. coerces unknown types to 'browser' and drops non-object params", async () => {
    const { env, kv } = makeEnv();
    const id = await enqueue(env, "screenshot", { type: "nonsense", params: [1, 2] });
    const stored = JSON.parse(kv.data.get(`rc:cmd:${id}`)!) as RcCommand;
    expect(stored.type).toBe("browser");
    expect(stored.params).toBeUndefined();
  });
});

describe("handleRcPoll", () => {
  it("8. returns null on an empty queue", async () => {
    const { env } = makeEnv();
    const response = await handleRcPoll(rcRequest("/rc/poll"), env);
    const body = (await response.json()) as { data: { command: RcCommand | null } };
    expect(body.data.command).toBeNull();
  });

  it("9. dequeues FIFO, marks running, and a second poll finds nothing", async () => {
    const { env, kv } = makeEnv();
    const first = await enqueue(env, "navigate");
    const second = await enqueue(env, "screenshot");

    const poll1 = await handleRcPoll(rcRequest("/rc/poll"), env);
    const body1 = (await poll1.json()) as { data: { command: RcCommand } };
    expect(body1.data.command.id).toBe(first);
    expect(body1.data.command.status).toBe("running");
    // Marked running in KV, removed from queue.
    expect((JSON.parse(kv.data.get(`rc:cmd:${first}`)!) as RcCommand).status).toBe("running");
    expect(JSON.parse(kv.data.get("rc:queue")!)).toEqual([second]);

    const poll2 = await handleRcPoll(rcRequest("/rc/poll"), env);
    const body2 = (await poll2.json()) as { data: { command: RcCommand } };
    expect(body2.data.command.id).toBe(second);

    const poll3 = await handleRcPoll(rcRequest("/rc/poll"), env);
    const body3 = (await poll3.json()) as { data: { command: RcCommand | null } };
    expect(body3.data.command).toBeNull();
  });

  it("10. skips expired (KV-evicted) and non-pending queue entries", async () => {
    const { env, kv } = makeEnv();
    const gone = await enqueue(env, "navigate");
    const done = await enqueue(env, "eval");
    const live = await enqueue(env, "get_text");

    kv.data.delete(`rc:cmd:${gone}`); // TTL eviction
    const doneCmd = JSON.parse(kv.data.get(`rc:cmd:${done}`)!) as RcCommand;
    doneCmd.status = "done";
    kv.data.set(`rc:cmd:${done}`, JSON.stringify(doneCmd));

    const poll = await handleRcPoll(rcRequest("/rc/poll"), env);
    const body = (await poll.json()) as { data: { command: RcCommand } };
    expect(body.data.command.id).toBe(live);
    // Documented behavior: only the DEQUEUED entry leaves the queue — skipped
    // dead entries linger (harmless: non-pending never re-dispatches, and the
    // 600s queue TTL clears them) and cost one KV get per poll until then.
    expect(JSON.parse(kv.data.get("rc:queue")!)).toEqual([gone, done]);
  });
});

describe("results", () => {
  it("11. stores a success result and flips the command to done", async () => {
    const { env, kv } = makeEnv();
    const id = await enqueue(env);
    await handleRcPoll(rcRequest("/rc/poll"), env);

    const submit = await handleRcSubmitResult(
      rcRequest(`/rc/result/${id}`, { method: "POST", body: { result: { doc_id: "d1" } } }),
      env,
      id
    );
    expect(submit.status).toBe(200);

    const get = await handleRcGetResult(rcRequest(`/rc/result/${id}`), env, id);
    const body = (await get.json()) as { data: { status: string; result: { doc_id: string } } };
    expect(body.data.status).toBe("done");
    expect(body.data.result.doc_id).toBe("d1");
    expect((JSON.parse(kv.data.get(`rc:cmd:${id}`)!) as RcCommand).status).toBe("done");
  });

  it("12. stores an error result as status 'error'", async () => {
    const { env } = makeEnv();
    const id = await enqueue(env);

    await handleRcSubmitResult(
      rcRequest(`/rc/result/${id}`, { method: "POST", body: { error: "chrome not connected" } }),
      env,
      id
    );
    const get = await handleRcGetResult(rcRequest(`/rc/result/${id}`), env, id);
    const body = (await get.json()) as { data: { status: string; error: string } };
    expect(body.data.status).toBe("error");
    expect(body.data.error).toBe("chrome not connected");
  });

  it("13. reports in-flight status before a result exists and 404s for unknown ids", async () => {
    const { env } = makeEnv();
    const id = await enqueue(env);

    const pending = await handleRcGetResult(rcRequest(`/rc/result/${id}`), env, id);
    const pendingBody = (await pending.json()) as { data: { status: string } };
    expect(pendingBody.data.status).toBe("pending");

    const missing = await handleRcGetResult(rcRequest("/rc/result/nope"), env, "nope");
    expect(missing.status).toBe(404);
  });
});

describe("handleRcStatus", () => {
  it("14. reports the queue depth", async () => {
    const { env } = makeEnv();
    await enqueue(env);
    await enqueue(env);

    const response = await handleRcStatus(rcRequest("/rc/status"), env);
    const body = (await response.json()) as { data: { pending: number; queue: string[] } };
    expect(body.data.pending).toBe(2);
    expect(body.data.queue).toHaveLength(2);
  });
});
