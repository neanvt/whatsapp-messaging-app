// Additive, idempotent migration that creates the TenantMetaApp table on the
// live Turso database. Mirrors the mechanics of
// scripts/add-meta-onboarding-columns.mjs (manual .env parse, createClient,
// try/catch -> non-secret error -> process.exit(1), client.close() in finally),
// because `prisma db push` cannot connect over the libsql:// protocol used here.
//
// Unlike the ALTER-TABLE scripts, this one introduces a CREATE TABLE. By
// deliberate design (see design-metaapp.md §1): no FOREIGN KEY (libSQL does not
// enforce FKs without PRAGMA foreign_keys=ON; onDelete:Cascade is enforced by
// the Prisma client), timestamps are plain TEXT with no DEFAULT CURRENT_TIMESTAMP
// (Prisma supplies @default(now()) and @updatedAt on every write). The table and
// unique index use IF NOT EXISTS so a second run is a clean no-op.
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

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS TenantMetaApp (
  id            TEXT PRIMARY KEY NOT NULL,
  userId        TEXT NOT NULL,
  metaAppId     TEXT NOT NULL,
  metaAppSecret TEXT NOT NULL,
  configId      TEXT,
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL
)`;

const CREATE_INDEX =
  "CREATE UNIQUE INDEX IF NOT EXISTS TenantMetaApp_userId_key ON TenantMetaApp (userId)";

async function migrate() {
  try {
    const info = await client.execute("PRAGMA table_info(TenantMetaApp)");
    const alreadyExists = info.rows.length > 0;

    await client.execute(CREATE_TABLE);
    await client.execute(CREATE_INDEX);

    if (alreadyExists) {
      console.log("TenantMetaApp table already exists. Skipping.");
    } else {
      console.log("TenantMetaApp table created.");
    }

    console.log("TenantMetaApp table migration complete.");
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.close();
  }
}

migrate();
