import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

// Lazily resolve the encryption key so missing/invalid config fails loudly at
// use time (not at import time). The key MUST be a 32-byte base64 string.
function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("ENCRYPTION_KEY is missing or not a 32-byte base64 key");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY is missing or not a 32-byte base64 key");
  }
  return key;
}

// Returns base64(iv).base64(tag).base64(ciphertext). Never logs its inputs.
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

// Reverses encrypt(). Throws "Invalid ciphertext format" on malformed input and
// throws (via decipher.final) when the payload has been tampered with. Never logs.
export function decrypt(payload: string): string {
  const segments = payload.split(".");
  if (segments.length !== 3) {
    throw new Error("Invalid ciphertext format");
  }
  const key = getKey();
  const [ivB64, tagB64, ciphertextB64] = segments;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
