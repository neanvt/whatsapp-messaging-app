import { createClient } from "@libsql/client";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env");

// Parse .env manually
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

async function migrate() {
  try {
    // Check if column already exists
    const result = await client.execute("PRAGMA table_info(Template)");
    const columns = result.rows.map((r) => r[1]);
    if (columns.includes("mediaAttachments")) {
      console.log("Column 'mediaAttachments' already exists. Skipping.");
      return;
    }

    await client.execute(
      "ALTER TABLE Template ADD COLUMN mediaAttachments TEXT",
    );
    console.log(
      "Successfully added 'mediaAttachments' column to Template table.",
    );
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.close();
  }
}

migrate();
