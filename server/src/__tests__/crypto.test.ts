import { describe, expect, it } from "vitest";
import { encryptValue, decryptValue } from "../core/crypto";

describe("crypto", () => {
  const validKey = btoa("01234567890123456789012345678901"); // 32 bytes

  it("encrypts and decrypts a round-trip value", async () => {
    const encrypted = await encryptValue("hello world", validKey);
    expect(encrypted.iv).toBeTruthy();
    expect(encrypted.ciphertext).toBeTruthy();
    const decrypted = await decryptValue(encrypted, validKey);
    expect(decrypted).toBe("hello world");
  });

  it("throws with key name in error when key is wrong length", async () => {
    const shortKey = btoa("tooshort");
    await expect(encryptValue("test", shortKey, "MY_KEY")).rejects.toThrow(
      "MY_KEY must decode to exactly 32 bytes"
    );
  });

  it("defaults error to generic message when no key name provided", async () => {
    const shortKey = btoa("tooshort");
    await expect(encryptValue("test", shortKey)).rejects.toThrow(
      "encryption key must decode to exactly 32 bytes"
    );
  });
});
