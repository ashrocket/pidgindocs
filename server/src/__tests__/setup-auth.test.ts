import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Env } from "../core/types";
import { handleSetupApi, handleSetupForm, canEditSetup } from "../core/routes/setup";
import { saveDestinationConfig } from "../core/destinations/store";

vi.mock("../core/destinations/store", () => ({
  saveDestinationConfig: vi.fn(async () => {}),
  destinationConfigured: vi.fn(async () => ({ configured: false })),
  getDestinationConfigValue: vi.fn(async () => null),
}));

let sessionEmail: string | null = "member@example.com";
vi.mock("../core/edition-hooks", async (orig) => ({
  ...(await orig<typeof import("../core/edition-hooks")>()),
  editionPublicSite: (env: Env) => (env as Env & { TEST_PUBLIC_SITE?: string }).TEST_PUBLIC_SITE === "true",
}));

vi.mock("../core/middleware", () => ({
  verifySession: vi.fn(async () => sessionEmail),
  unauthorized: () => new Response("unauthorized", { status: 401 }),
}));

function makeEnv(opts: { companyRoleEmails?: string[]; publicSite?: boolean } = {}): Env {
  const admins = (opts.companyRoleEmails ?? []).map((e) => e.toLowerCase());
  return {
    OWNER_EMAIL: "Owner@Example.com",
    TEST_PUBLIC_SITE: opts.publicSite ? "true" : undefined,
    DB: {
      prepare: () => ({
        bind: (email: string) => ({
          first: async () => (admins.includes(email) ? { role: "admin" } : null),
          all: async () => ({ results: [] }),
        }),
        first: async () => ({ count: 0 }),
      }),
    },
  } as unknown as Env;
}

const commuteBody = { type: "commute", openai_api_key: "sk-test", minutes: 3 };
function post(body: unknown) {
  return new Request("https://x.test/api/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionEmail = "member@example.com";
});

describe("canEditSetup", () => {
  it("allows the instance owner case-insensitively", async () => {
    expect(await canEditSetup(makeEnv(), "OWNER@example.COM")).toBe(true);
  });
  it("allows a company team owner/admin", async () => {
    expect(await canEditSetup(makeEnv({ companyRoleEmails: ["admin@example.com"] }), "Admin@example.com")).toBe(true);
  });
  it("refuses a plain member", async () => {
    expect(await canEditSetup(makeEnv(), "member@example.com")).toBe(false);
  });
  it("refuses everyone on the public site, even the owner", async () => {
    expect(await canEditSetup(makeEnv({ publicSite: true }), "owner@example.com")).toBe(false);
  });
});

describe("POST /api/setup authorization", () => {
  it("saves for the owner", async () => {
    sessionEmail = "owner@example.com";
    const res = await handleSetupApi(post(commuteBody), makeEnv());
    expect(res.status).toBe(200);
    expect(saveDestinationConfig).toHaveBeenCalledTimes(1);
  });
  it("refuses a plain member with 403 and saves nothing", async () => {
    const res = await handleSetupApi(post(commuteBody), makeEnv());
    expect(res.status).toBe(403);
    expect(saveDestinationConfig).not.toHaveBeenCalled();
  });
  it("refuses on the public site", async () => {
    sessionEmail = "owner@example.com";
    const res = await handleSetupApi(post(commuteBody), makeEnv({ publicSite: true }));
    expect(res.status).toBe(403);
    expect(saveDestinationConfig).not.toHaveBeenCalled();
  });
  it("refuses a plain member on the HTML form handler", async () => {
    const form = new FormData();
    form.set("type", "commute");
    form.set("openai_api_key", "sk-test");
    form.set("minutes", "3");
    const res = await handleSetupForm(new Request("https://x.test/setup", { method: "POST", body: form }), makeEnv());
    expect(res.status).toBe(403);
    expect(saveDestinationConfig).not.toHaveBeenCalled();
  });
});
