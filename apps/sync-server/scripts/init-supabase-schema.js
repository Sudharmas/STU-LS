import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "pg";

async function main() {
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    throw new Error("Missing SUPABASE_DB_URL in apps/sync-server/.env");
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const schemaCandidates = [
    path.resolve(scriptDir, "../../../supabase/schema.sql"),
    path.resolve(process.cwd(), "../../supabase/schema.sql"),
    path.resolve(process.cwd(), "supabase/schema.sql")
  ];

  const schemaPath = schemaCandidates.find((candidate) => fs.existsSync(candidate));
  if (!schemaPath) {
    throw new Error(`Schema file not found. Checked: ${schemaCandidates.join(" | ")}`);
  }

  const sql = fs.readFileSync(schemaPath, "utf-8");
  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

  await client.connect();
  try {
    await client.query(sql);
    // eslint-disable-next-line no-console
    console.log("Supabase schema initialization completed successfully.");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Failed to initialize Supabase schema:", error.message);
  process.exit(1);
});
