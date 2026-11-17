// The same-origin renderers (/a/assets/mermaid.js, cuelume.js) come from
// jsDelivr once and are then served from R2. Every byte served must match the
// SHA-384 pinned in code: a bad download is refused and never stored, and a
// bad stored copy is replaced.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CUELUME_ASSET, MERMAID_ASSET, handleArtifactMermaid, handleCuelumeAsset } from "../core/routes/artifacts";
import type { Env } from "../core/types";

function memoryBucket(seed: Record<string, Uint8Array> = {}) {
  const objects = new Map<string, Uint8Array>(Object.entries(seed));
  return {
    objects,
    async get(key: string) {
      const value = objects.get(key);
      if (!value) return null;
      return { arrayBuffer: async () => value.slice().buffer, text: async () => new TextDecoder().decode(value) };
    },
    async put(key: string, value: ArrayBuffer | string) {
      objects.set(key, typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value));
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
}

function envWith(bucket: ReturnType<typeof memoryBucket>): Env {
  return { DOCS: bucket } as unknown as Env;
}

async function sha384(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-384", bytes));
  return btoa(String.fromCharCode(...digest));
}

/** Bytes whose digest is pinned: the test swaps the pin for this body's digest. */
const GOOD = new TextEncoder().encode("window.mermaid = {};");
const BAD = new TextEncoder().encode("window.mermaid = {}; stealEverything();");

const request = new Request("https://team.example.test/a/assets/mermaid.js");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pinned renderer assets", () => {
  it("serves and stores a download that matches the pinned digest", async () => {
    const original = MERMAID_ASSET.sha384;
    MERMAID_ASSET.sha384 = await sha384(GOOD);
    try {
      const fetchMock = vi.fn(async () => new Response(GOOD));
      vi.stubGlobal("fetch", fetchMock);
      const bucket = memoryBucket();
      const response = await handleArtifactMermaid(request, envWith(bucket));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("window.mermaid = {};");
      expect(bucket.objects.get(MERMAID_ASSET.r2Key)).toEqual(GOOD);
      // Served from R2 next time, without asking jsDelivr again.
      await handleArtifactMermaid(request, envWith(bucket));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      MERMAID_ASSET.sha384 = original;
    }
  });

  it("refuses a download that does not match, and stores nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response(BAD)));
    const bucket = memoryBucket();
    const response = await handleArtifactMermaid(request, envWith(bucket));
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).not.toContain("stealEverything");
    expect(bucket.objects.size).toBe(0);
  });

  it("replaces a stored copy that does not match", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const original = MERMAID_ASSET.sha384;
    MERMAID_ASSET.sha384 = await sha384(GOOD);
    try {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(GOOD)));
      const bucket = memoryBucket({ [MERMAID_ASSET.r2Key]: BAD });
      const response = await handleArtifactMermaid(request, envWith(bucket));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("window.mermaid = {};");
      expect(bucket.objects.get(MERMAID_ASSET.r2Key)).toEqual(GOOD);
    } finally {
      MERMAID_ASSET.sha384 = original;
    }
  });

  it("never serves a copy stored under the old, unpinned key", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response(BAD)));
    const bucket = memoryBucket({ "assets/mermaid-11.4.1.min.js": BAD, "assets/cuelume-0.1.2.esm.js": BAD });
    expect((await handleArtifactMermaid(request, envWith(bucket))).status).toBe(503);
    expect((await handleCuelumeAsset(request, envWith(bucket))).status).toBe(503);
  });

  it("keys each stored copy by version and digest", () => {
    expect(MERMAID_ASSET.r2Key).toMatch(/^assets\/mermaid-11\.4\.1-[A-Za-z0-9_-]{16}\.js$/);
    expect(CUELUME_ASSET.r2Key).toMatch(/^assets\/cuelume-0\.1\.2-[A-Za-z0-9_-]{16}\.js$/);
    expect(MERMAID_ASSET.sha384).toMatch(/^[A-Za-z0-9+/]{64}$/);
    expect(CUELUME_ASSET.sha384).toMatch(/^[A-Za-z0-9+/]{64}$/);
  });
});
