function normalizeBase64(input: string): string {
  const trimmed = input.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padding = trimmed.length % 4;
  return padding === 0 ? trimmed : `${trimmed}${"=".repeat(4 - padding)}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(input: string): Uint8Array {
  const binary = atob(normalizeBase64(input));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function importAesKey(base64Key: string, keyName?: string): Promise<CryptoKey> {
  const keyBytes = base64ToBytes(base64Key);
  if (keyBytes.byteLength !== 32) {
    throw new Error(
      `${keyName || "encryption key"} must decode to exactly 32 bytes`
    );
  }

  return crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export interface EncryptedValue {
  iv: string;
  ciphertext: string;
}

export async function encryptValue(
  plaintext: string,
  base64Key: string,
  keyName?: string,
): Promise<EncryptedValue> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importAesKey(base64Key, keyName);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );

  return {
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptValue(
  encrypted: EncryptedValue,
  base64Key: string,
  keyName?: string,
): Promise<string> {
  const key = await importAesKey(base64Key, keyName);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(encrypted.iv) },
    key,
    base64ToBytes(encrypted.ciphertext)
  );
  return new TextDecoder().decode(decrypted);
}
