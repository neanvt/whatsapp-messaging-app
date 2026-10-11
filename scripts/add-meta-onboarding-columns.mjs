// Additive, idempotent migration that adds the Meta-onboarding columns to the
// live Turso WhatsAppNumber table. Mirrors scripts/add-media-attachments.mjs —
// the repo's established pattern for applying schema changes to Turso, because
// `prisma db push` cannot connect over the libsql:// protocol used here.
// All columns are nullable (or defaulted) — no column is ever dropped.
import { createClient } from "@libsql/client";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env");

// Parse .env manually (same approach as the existing migration script).
const envContent = readFileSync(envPath, "utf8");
const env = {};
for (const line of envContent.split("\n")) {
  const match = line.match(/^([^=]+)=["']?(.+?)["']?$/);
  if (match) env[match[1].trim()] = match[2].trim();
}

const client = createClient({
  url: env.TURSO_DATABASE_URL,
  authToken: env.TURSO_AUTH_TOKEN,
});

// name -> ALTER TABLE column definition. Additive & nullable/defaulted only.
const COLUMNS = [
  ["accessToken", "ALTER TABLE WhatsAppNumber ADD COLUMN accessToken TEXT"],
  ["tokenExpiresAt", "ALTER TABLE WhatsAppNumber ADD COLUMN tokenExpiresAt DATETIME"],
  ["displayPhoneNumber", "ALTER TABLE WhatsAppNumber ADD COLUMN displayPhoneNumber TEXT"],
  ["verifiedName", "ALTER TABLE WhatsAppNumber ADD COLUMN verifiedName TEXT"],
  ["qualityRating", "ALTER TABLE WhatsAppNumber ADD COLUMN qualityRating TEXT"],
  ["codeVerificationStatus", "ALTER TABLE WhatsAppNumber ADD COLUMN codeVerificationStatus TEXT"],
  ["platformType", "ALTER TABLE WhatsAppNumber ADD COLUMN platformType TEXT"],
  ["connectionType", "ALTER TABLE WhatsAppNumber ADD COLUMN connectionType TEXT NOT NULL DEFAULT 'manual'"],
];

async function migrate() {
  try {
    const info = await client.execute("PRAGMA table_info(WhatsAppNumber)");
    const existing = new Set(info.rows.map((r) => r[1]));

    for (const [name, ddl] of COLUMNS) {
      if (existing.has(name)) {
        console.log(`Column '${name}' already exists. Skipping.`);
        continue;
      }
      await client.execute(ddl);
      console.log(`Added column '${name}' to WhatsAppNumber.`);
    }

    console.log("Meta-onboarding columns migration complete.");
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.close();
  }
}

migrate();
