import { afterEach, describe, expect, it, vi } from "vitest";
import { callEnhancementModel, isEnhancementProviderConfigured, utf8ByteLength } from "../enhance/provider";
import type { Env } from "../types";

const prompt = { system: "System instructions", user: "Document input" };

function anthropicStub(text = "# Anthropic result") {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ content: [{ type: "text", text }] })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("document enhancement provider routing", () => {
  it("counts UTF-8 bytes without allocating a second copy of the document", () => {
    const value = "Aé水😀\uD800";
    expect(utf8ByteLength(value)).toBe(new TextEncoder().encode(value).byteLength);
  });

  it("uses the configured Workers AI binding for polish and returns its markdown", async () => {
    const run = vi.fn(async () => "# Polished document\n");
    const fetchMock = anthropicStub();
    const env = { AI: { run }, ANTHROPIC_API_KEY: "anthropic-test" } as unknown as Env;

    await expect(callEnhancementModel(env, {
      ...prompt,
      level: "polish",
      sourceMarkdownBytes: utf8ByteLength(prompt.user),
      maxTokens: 8192,
      anthropicModel: "claude-haiku-test",
    })).resolves.toBe("# Polished document");

    expect(run).toHaveBeenCalledWith("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      max_tokens: 8192,
      temperature: 0.1,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses Workers AI for enrich without requiring Anthropic, but keeps research Anthropic-only", async () => {
    const run = vi.fn(async (_model: string, _input: Record<string, unknown>) => ({ response: "# Enriched document" }));
    const fetchMock = anthropicStub("# Researched document");
    const env = { AI: { run } } as unknown as Env;

    expect(isEnhancementProviderConfigured(env, "enrich")).toBe(true);
    expect(isEnhancementProviderConfigured(env, "research")).toBe(false);
    expect(isEnhancementProviderConfigured({} as Env, "enrich")).toBe(false);

    await expect(callEnhancementModel(env, {
      ...prompt,
      level: "enrich",
      sourceMarkdownBytes: utf8ByteLength(prompt.user),
      maxTokens: 16384,
      anthropicModel: "claude-sonnet-test",
    })).resolves.toBe("# Enriched document");
    const researchEnv = { ...env, ANTHROPIC_API_KEY: "anthropic-test" } as Env;
    await expect(callEnhancementModel(researchEnv, {
      ...prompt,
      level: "research",
      sourceMarkdownBytes: utf8ByteLength(prompt.user),
      maxTokens: 16384,
      anthropicModel: "claude-sonnet-test",
    })).resolves.toBe("# Researched document");

    expect(run).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
    const body = JSON.parse(String(init?.body));
    expect(body.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]);
  });

  it("keeps Anthropic as the polish/enrich fallback when AI is not configured", async () => {
    const fetchMock = anthropicStub("# Existing provider");
    const env = { ANTHROPIC_API_KEY: "anthropic-test" } as unknown as Env;

    expect(isEnhancementProviderConfigured(env, "polish")).toBe(true);
    await expect(callEnhancementModel(env, {
      ...prompt,
      level: "enrich",
      sourceMarkdownBytes: utf8ByteLength(prompt.user),
      maxTokens: 16384,
      anthropicModel: "claude-sonnet-test",
    })).resolves.toBe("# Existing provider");

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("claude-sonnet-test");
    expect(body.tools).toBeUndefined();
  });

  it("fails closed on an empty Workers AI response without calling Anthropic", async () => {
    const run = vi.fn(async () => ({ response: "  " }));
    const fetchMock = anthropicStub();
    const env = { AI: { run }, ANTHROPIC_API_KEY: "anthropic-test" } as unknown as Env;

    await expect(callEnhancementModel(env, {
      ...prompt,
      level: "polish",
      sourceMarkdownBytes: utf8ByteLength(prompt.user),
      maxTokens: 8192,
      anthropicModel: "claude-haiku-test",
    })).rejects.toThrow("Workers AI returned no text content");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reduces output tokens for long Markdown while reserving enough for the document", async () => {
    const source = "a".repeat(10_000);
    const user = `<document>\n${source}\n</document>`;
    const run = vi.fn(async (_model: string, _input: Record<string, unknown>) => ({ response: "# Enriched document" }));
    const env = { AI: { run } } as unknown as Env;

    await expect(callEnhancementModel(env, {
      system: prompt.system,
      user,
      sourceMarkdownBytes: utf8ByteLength(source),
      level: "enrich",
      maxTokens: 16_384,
      anthropicModel: "claude-sonnet-test",
    })).resolves.toBe("# Enriched document");

    const [, request] = run.mock.calls[0];
    const promptBytes = utf8ByteLength(prompt.system) + 1 + utf8ByteLength(user);
    expect(request.max_tokens).toBe(24_000 - promptBytes - 512);
    expect(request.max_tokens).toBeLessThan(16_384);
    expect(request.max_tokens).toBeGreaterThanOrEqual(12_500);
  });

  it("rejects an oversized document before inference instead of silently spending on fallback", async () => {
    const source = "a".repeat(20_000);
    const run = vi.fn(async () => ({ response: "unused" }));
    const fetchMock = anthropicStub();
    const env = { AI: { run }, ANTHROPIC_API_KEY: "anthropic-test" } as unknown as Env;

    await expect(callEnhancementModel(env, {
      system: prompt.system,
      user: `<document>\n${source}\n</document>`,
      sourceMarkdownBytes: utf8ByteLength(source),
      level: "enrich",
      maxTokens: 16_384,
      anthropicModel: "claude-sonnet-test",
    })).rejects.toThrow(/No Workers AI inference was sent/);

    expect(run).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
