import { describe, expect, it } from "vitest";

// Code names tiers, never model IDs: core/ai/tiers.ts is the only place that maps a tier to a model.
const SOURCES: Record<string, string> = {
  ...import.meta.glob<string>("../core/**/*.ts", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob<string>("../hosting/**/*.ts", { query: "?raw", import: "default", eager: true }),
};
const SERVER_SOURCES: Record<string, string> = {
  ...SOURCES,
  ...import.meta.glob<string>("../teams/**/*.ts", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob<string>("../web/**/*.ts", { query: "?raw", import: "default", eager: true }),
};
const CATALOGS: Record<string, string> = {
  ...import.meta.glob<string>("../web/i18n/{en,es,ru,sv}.json", { query: "?raw", import: "default", eager: true }),
};
// The stored interface catalogs belong to an edition's web pages; PidginCore alone has none.
const HAS_EDITION_PAGES = Object.keys(import.meta.glob("../web/**/*.ts")).length > 0;
const REGISTRY = "../core/ai/tiers.ts";
const MODEL_ID = /claude-(?:haiku|sonnet|opus)|@cf\/|gpt-oss|gpt-\d|glm-\d|qwen|gemma|bge-|\bhaiku\b|\bsonnet\b/i;
const isCode = (path: string) => !path.includes("__tests__") && !/\.test\.ts$/.test(path) && !/\.generated\.ts$/.test(path);

describe("model IDs", () => {
  it("appear only in core/ai/tiers.ts, outside tests", () => {
    const hits: string[] = [];
    for (const [path, text] of Object.entries(SOURCES)) {
      if (path === REGISTRY || !isCode(path)) continue;
      text.split("\n").forEach((line, i) => {
        if (MODEL_ID.test(line)) hits.push(`${path}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(Object.keys(SOURCES).length).toBeGreaterThan(50);
    expect(hits).toEqual([]);
  });

  it("leave no Qwen reference in the server source, whose model is deprecated on 2026-11-20", () => {
    const hits = Object.entries(SERVER_SOURCES).filter(([path, text]) => isCode(path) && /qwen/i.test(text)).map(([path]) => path);
    expect(hits).toEqual([]);
  });

  it("leave no model ID in the stored interface labels", () => {
    const hits: string[] = [];
    for (const [path, text] of Object.entries(CATALOGS)) {
      const walk = (value: unknown, key: string) => {
        if (typeof value === "string") { if (MODEL_ID.test(value)) hits.push(`${path}: ${key}`); }
        else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, `${key}.${k}`);
      };
      walk(JSON.parse(text), "");
    }
    expect(Object.keys(CATALOGS)).toHaveLength(HAS_EDITION_PAGES ? 4 : 0);
    expect(hits).toEqual([]);
  });
});
