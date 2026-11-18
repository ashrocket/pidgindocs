import { describe, it, expect } from "vitest";
import { generateApiKey, sha256Hex } from "../core/auth-utils";

describe("generateApiKey", () => {
  it("starts with pidgin_sk_", () => {
    const key = generateApiKey();
    expect(key.startsWith("pidgin_sk_")).toBe(true);
  });

  it("has 50 characters total", () => {
    const key = generateApiKey();
    expect(key).toHaveLength(50);
  });

  it("generates unique keys", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a).not.toBe(b);
  });
});

describe("sha256Hex", () => {
  it("returns consistent hex digest", async () => {
    const hash = await sha256Hex("hello");
    expect(hash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("returns 64 hex chars", async () => {
    const hash = await sha256Hex("test");
    expect(hash).toHaveLength(64);
  });
});
