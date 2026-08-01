import { Pool } from "pg";
import { env } from "./env.js";

/**
 * Single shared connection pool. Every query goes through this — no
 * per-request `new Client()` — so the app doesn't exhaust Postgres
 * connections under load.
 */
export const pool = new Pool({ connectionString: env.databaseUrl });//connects to the database

// const result = await pool.query("SELECT NOW()");
// console.log(result.rows);

pool.on("error", (err) => {
  // A background client crashed (idle connection dropped etc.) — log and
  // let the pool recover rather than crashing the process.
  console.error("Unexpected error on idle Postgres client", err);
});
