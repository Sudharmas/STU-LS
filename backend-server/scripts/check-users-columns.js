import "dotenv/config";
import { Client } from "pg";

const client = new Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false }
});

await client.connect();
const result = await client.query(
  "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' ORDER BY column_name"
);
console.log(result.rows.map((r) => r.column_name).join(","));
await client.end();
