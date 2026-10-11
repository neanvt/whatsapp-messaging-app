// Standalone AES-256-GCM round-trip / tamper / key test harness.
// Re-implements the same base64(iv).base64(tag).base64(ciphertext) format inline
// using only Node's built-in crypto — NO import from src/lib/crypto.ts, no compile,
// no new dependency. Run with: ENCRYPTION_KEY=$(openssl rand -base64 32) node scripts/test-crypto.mjs
import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function getKey() {
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

function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(".");
}

function decrypt(payload) {
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
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

let failures = 0;
function pass(msg) {
  console.log(`PASS: ${msg}`);
}
function fail(msg) {
  failures += 1;
  console.error(`FAIL: ${msg}`);
}

// Assertion 1: decrypt(encrypt(x)) === x
try {
  const original = "EAAG-super-secret-token-1234567890";
  const roundTrip = decrypt(encrypt(original));
  if (roundTrip === original) {
    pass("round-trip decrypt(encrypt(x)) === x");
  } else {
    fail("round-trip mismatch");
  }
} catch (err) {
  fail(`round-trip threw unexpectedly: ${err.message}`);
}

// Assertion 2: tampering one char of the ciphertext makes decrypt throw
try {
  const payload = encrypt("another-secret-value");
  const segments = payload.split(".");
  // Flip one character in the ciphertext segment.
  const ct = segments[2];
  const idx = 0;
  const flipped = (ct[idx] === "A" ? "B" : "A") + ct.slice(1);
  segments[2] = flipped;
  const tampered = segments.join(".");
  let threw = false;
  try {
    decrypt(tampered);
  } catch {
    threw = true;
  }
  if (threw) {
    pass("tampered ciphertext causes decrypt to throw");
  } else {
    fail("tampered ciphertext did not throw");
  }
} catch (err) {
  fail(`tamper test setup threw unexpectedly: ${err.message}`);
}

// Assertion 3: absent / short ENCRYPTION_KEY throws a clear error
{
  const saved = process.env.ENCRYPTION_KEY;
  try {
    // Absent key
    delete process.env.ENCRYPTION_KEY;
    let threwAbsent = false;
    try {
      encrypt("x");
    } catch (err) {
      threwAbsent = /32-byte base64 key/.test(err.message);
    }

    // Short key
    process.env.ENCRYPTION_KEY = Buffer.from("too-short").toString("base64");
    let threwShort = false;
    try {
      encrypt("x");
    } catch (err) {
      threwShort = /32-byte base64 key/.test(err.message);
    }

    if (threwAbsent && threwShort) {
      pass("absent/short ENCRYPTION_KEY throws a clear error");
    } else {
      fail(
        `key validation incomplete (absent=${threwAbsent}, short=${threwShort})`
      );
    }
  } finally {
    if (saved === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = saved;
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll crypto assertions passed.");
