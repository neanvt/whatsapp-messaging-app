// Pure, dependency-free key helpers (no DB, no request) — trivially unit-testable.
// Never log the plaintext, the hash, or the random bytes anywhere in this module.
import crypto from "crypto";

const PREFIX = "wa_live_";

// FR2.6 / A1 / NFR3: 32 random bytes (256 bits) base64url-encoded (no padding),
// prefixed with the human-readable, non-secret label. The full string is the secret.
export function generateApiKey(): { plaintext: string; hash: string; prefix: string } {
  const random = crypto.randomBytes(32).toString("base64url"); // ~43 url-safe chars
  const plaintext = PREFIX + random;
  const hash = hashKey(plaintext);
  // keyPrefix = non-secret display fragment: label + first 4 chars of the random part.
  const prefix = PREFIX + random.slice(0, 4);
  return { plaintext, hash, prefix };
}

// SHA-256 hex of the full presented key. Deterministic (A2): lookup is by this value.
export function hashKey(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext).digest("hex");
}

// Cheap shape gate so a malformed/foreign token never hits the DB (edge case: 401 w/o lookup).
// 32 random bytes base64url-encode (no padding) to exactly 43 chars, so a well-formed key is
// PREFIX + 43 chars. The floor is set to that real encoded length, not the raw byte count.
// This is only a shape filter: a token that passes still has to match the SHA-256 lookup,
// which is the real gate.
export function looksLikeApiKey(token: string): boolean {
  return token.startsWith(PREFIX) && token.length >= PREFIX.length + 43;
}

// Mirrors the superadmin rule in src/lib/auth.ts (JWT callback). Email override OR explicit role.
// Both fields are typed non-nullable to match the schema and the §5.1 `select`:
// User.email is `String @unique` (NOT NULL) and User.role is `String @default("admin")` (NOT NULL),
// so a persisted user never has a null email or role.
export function isSuperAdminUser(user: { email: string; role: string }): boolean {
  const superAdminEmail = process.env.SUPERADMIN_EMAIL || "neanvtech@gmail.com";
  return user.email === superAdminEmail || user.role === "superadmin";
}
