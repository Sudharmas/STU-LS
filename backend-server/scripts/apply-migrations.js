import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "pg";

async function main() {
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    throw new Error("Missing SUPABASE_DB_URL in backend-server/.env");
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "../..");
  const migrationsDir = path.join(repoRoot, "supabase", "migrations");

  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found: ${migrationsDir}`);
  }

  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  if (migrationFiles.length === 0) {
    // eslint-disable-next-line no-console
    console.log("No migration files found.");
    return;
  }

  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    await client.query("BEGIN");
    for (const fileName of migrationFiles) {
      const sqlPath = path.join(migrationsDir, fileName);
      const sql = fs.readFileSync(sqlPath, "utf-8");
      // eslint-disable-next-line no-console
      console.log(`Applying migration: ${fileName}`);
      await client.query(sql);
    }
    await client.query("COMMIT");
    // eslint-disable-next-line no-console
    console.log(`Applied ${migrationFiles.length} migration file(s) successfully.`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Failed to apply migrations:", error.message);
  process.exit(1);
});
