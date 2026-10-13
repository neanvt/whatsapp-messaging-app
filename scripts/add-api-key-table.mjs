// Additive, idempotent migration that creates the ApiKey table on the live
// Turso database. Mirrors the mechanics of
// scripts/add-tenant-meta-app-table.mjs (manual .env parse, createClient,
// try/catch -> non-secret error -> process.exit(1), client.close() in finally),
// because `prisma db push` cannot connect over the libsql:// protocol used here.
//
// By deliberate design (see design.md §1): no FOREIGN KEY (libSQL does not
// enforce FKs without PRAGMA foreign_keys=ON; onDelete:Cascade is enforced by
// the Prisma client), timestamps are plain TEXT with no DEFAULT CURRENT_TIMESTAMP
// (Prisma supplies @default(now()) and @updatedAt on every write), nullable
// columns (name, lastUsedAt, revokedAt) are TEXT without NOT NULL. The table and
// both indexes use IF NOT EXISTS so a second run is a clean no-op. A single
// PRAGMA table_info(ApiKey) probe is used only to choose the log line; all three
// DDL statements run unconditionally. Never log the plaintext key or keyHash.
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

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS ApiKey (
  id               TEXT PRIMARY KEY NOT NULL,
  userId           TEXT NOT NULL,
  whatsappNumberId TEXT NOT NULL,
  name             TEXT,
  keyPrefix        TEXT NOT NULL,
  keyHash          TEXT NOT NULL,
  lastUsedAt       TEXT,
  revokedAt        TEXT,
  createdAt        TEXT NOT NULL,
  updatedAt        TEXT NOT NULL
)`;

const CREATE_KEYHASH_INDEX =
  "CREATE UNIQUE INDEX IF NOT EXISTS ApiKey_keyHash_key ON ApiKey (keyHash)";

const CREATE_USERID_INDEX =
  "CREATE INDEX IF NOT EXISTS ApiKey_userId_idx ON ApiKey (userId)";

async function migrate() {
  try {
    const info = await client.execute("PRAGMA table_info(ApiKey)");
    const alreadyExists = info.rows.length > 0;

    await client.execute(CREATE_TABLE);
    await client.execute(CREATE_KEYHASH_INDEX);
    await client.execute(CREATE_USERID_INDEX);

    if (alreadyExists) {
      console.log("ApiKey table already exists. Skipping.");
    } else {
      console.log("ApiKey table created.");
    }

    console.log("ApiKey table migration complete.");
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.close();
  }
}

migrate();
