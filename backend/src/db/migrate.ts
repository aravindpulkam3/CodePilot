import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pool } from "../config/db.js";

/**
 * Minimal migration runner for this milestone: applies schema.sql
 * idempotently (every statement in it is CREATE ... IF NOT EXISTS).
 * Once the schema grows past a single file, swap this for a proper
 * migration tool (node-pg-migrate, Prisma Migrate, etc.) — the shape of
 * `app_users` here is designed to survive that switch unchanged.
 */
async function main() {
  const schemaPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "schema.sql"
  );
  const sql = readFileSync(schemaPath, "utf-8");
  await pool.query(sql);
  console.log("Schema applied.");
  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
