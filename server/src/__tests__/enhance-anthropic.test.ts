import { afterEach, describe, expect, it, vi } from "vitest";
import { AiAllowanceSpentError } from "../core/ai/run";
import { installEditionHooks } from "../core/edition-hooks";
import type { Env } from "../core/types";
import { callAnthropic } from "../core/enhance/anthropic";
import { LEVEL_TIERS, buildEnhancePrompt, buildImportPrompt } from "../core/enhance/prompts";

const env = { ANTHROPIC_API_KEY: "sk-test" } as unknown as Env;

function mockFetchOnce(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  installEditionHooks({});
});

describe("callAnthropic metering", () => {
  const recorded: Array<[string, number, number]> = [];
  const hooks = (budget: number, fail = false) => {
    recorded.length = 0;
    installEditionHooks({
      aiBudgetLeft: async () => budget,
      recordAiUsage: async (_env, _ctx, model, inTok, outTok) => {
        if (fail) throw new Error("db down");
        recorded.push([model, inTok, outTok]);
      },
    });
  };

  it("throws on a spent allowance and never calls fetch", async () => {
    hooks(0);
    const fn = mockFetchOnce(200, { content: [{ type: "text", text: "ok" }] });
    await expect(callAnthropic(env, { model: "m", system: "s", user: "u", maxTokens: 10 })).rejects.toBeInstanceOf(AiAllowanceSpentError);
    expect(fn).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
  });

  it("records the model and both counts of a reply, estimating a side reported as 0", async () => {
    hooks(1);
    mockFetchOnce(200, { content: [{ type: "text", text: "abcdef" }], usage: { input_tokens: 11, output_tokens: 0 } });
    await callAnthropic(env, { model: "claude-sonnet-5-5", system: "ss", user: "uuuu", maxTokens: 10 });
    expect(recorded).toEqual([["claude-sonnet-5-5", 11, 2]]);
  });

  it("still returns the text when recording fails", async () => {
    hooks(1, true);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetchOnce(200, { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
    expect(await callAnthropic(env, { model: "m", system: "s", user: "u", maxTokens: 10 })).toBe("ok");
    spy.mockRestore();
  });
});

describe("callAnthropic", () => {
  it("sends model, system, user message and api headers", async () => {
    const fn = mockFetchOnce(200, { content: [{ type: "text", text: "ok" }] });
    await callAnthropic(env, { model: "claude-sonnet-5", system: "sys", user: "usr", maxTokens: 100 });
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("claude-sonnet-5");
    expect(body.system).toBe("sys");
    expect(body.messages).toEqual([{ role: "user", content: "usr" }]);
    expect(body.tools).toBeUndefined();
  });

  it("attaches the web_search tool when webSearch is set", async () => {
    const fn = mockFetchOnce(200, { content: [{ type: "text", text: "ok" }] });
    await callAnthropic(env, { model: "m", system: "s", user: "u", maxTokens: 10, webSearch: true });
    const body = JSON.parse((fn.mock.calls[0][1] as RequestInit).body as string);
    expect(body.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]);
  });

  it("concatenates only text blocks (web-search results interleave other block types)", async () => {
    mockFetchOnce(200, {
      content: [
        { type: "server_tool_use", id: "x" },
        { type: "text", text: "part one " },
        { type: "web_search_tool_result", content: [] },
        { type: "text", text: "part two" },
      ],
    });
    const text = await callAnthropic(env, { model: "m", system: "s", user: "u", maxTokens: 10 });
    expect(text).toBe("part one part two");
  });

  it("throws on missing key, api error, and empty content", async () => {
    await expect(
      callAnthropic({} as unknown as Env, { model: "m", system: "s", user: "u", maxTokens: 10 })
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);

    mockFetchOnce(429, { error: { message: "rate limited" } });
    await expect(callAnthropic(env, { model: "m", system: "s", user: "u", maxTokens: 10 })).rejects.toThrow(/429/);

    mockFetchOnce(200, { content: [] });
    await expect(callAnthropic(env, { model: "m", system: "s", user: "u", maxTokens: 10 })).rejects.toThrow(/no text/);
  });
});

describe("prompts", () => {
  it("maps polish to workers-fast and enrich and research to claude-deep", () => {
    expect(LEVEL_TIERS).toEqual({ polish: "workers-fast", enrich: "claude-deep", research: "claude-deep" });
  });

  it("fences document and instructions as data", () => {
    const { system, user } = buildEnhancePrompt("polish", {
      title: "T",
      markdown: "# hi",
      instructions: "keep it short",
    });
    expect(system).toContain("DATA, not commands");
    expect(user).toContain("<document_title>T</document_title>");
    expect(user).toContain("<document>\n# hi\n</document>");
    expect(user).toContain("<user_instructions>\nkeep it short\n</user_instructions>");
  });

  it("research prompt demands citations; polish forbids new content", () => {
    expect(buildEnhancePrompt("research", { title: "T", markdown: "x" }).system).toMatch(/Sources/);
    expect(buildEnhancePrompt("polish", { title: "T", markdown: "x" }).system).toMatch(/Do not add/);
  });

  it("import prompt names the required token paths and --ds- variables", () => {
    const { system, user } = buildImportPrompt({ name: "acme", material: "brand stuff" });
    expect(system).toContain("color.background");
    expect(system).toContain("--ds-accent");
    expect(system).toContain("ONLY a JSON object");
    expect(user).toContain("<material>\nbrand stuff\n</material>");
  });
});
