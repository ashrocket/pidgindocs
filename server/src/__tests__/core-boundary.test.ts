// PidginCore boundary: files in core/
// must not import hosting/, teams/, control/, web/ pages or the hosted edition entry. An
// edition reaches core through core/edition-hooks.ts instead.
import { describe, expect, it } from "vitest";

const CORE = import.meta.glob<string>("../core/**/*.ts", { query: "?raw", import: "default", eager: true });
const SPEC = /(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;
const OUTSIDE = new Set(["hosting", "teams", "control", "web", "index", "app", "edition-routes"]);

function normalize(parts: string[]): string {
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part !== "." && part !== "") out.push(part);
  }
  return out.join("/");
}

function crossings(): string[] {
  const found = new Set<string>();
  for (const [key, source] of Object.entries(CORE)) {
    const file = key.replace(/^\.\.\//, "");
    const dir = file.split("/").slice(0, -1);
    for (const match of source.matchAll(SPEC)) {
      const target = normalize([...dir, ...match[1].split("/")]);
      if (OUTSIDE.has(target.split("/")[0])) found.add(`${file} -> ${target}`);
    }
  }
  return [...found].sort();
}

describe("PidginCore boundary", () => {
  it("finds the core modules", () => {
    expect(Object.keys(CORE).length).toBeGreaterThan(100);
  });

  it("imports nothing from an edition, the control plane, web pages or the hosted edition entry", () => {
    expect(crossings()).toEqual([]);
  });
});
