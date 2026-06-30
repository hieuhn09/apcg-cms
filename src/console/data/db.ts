/**
 * Read-only Drizzle client over the Payload Postgres database, used by the
 * console dashboards for fast aggregation queries. WRITES never go through here —
 * they go through the Payload Local API (see `./payload.ts`) so hooks, access
 * control, versions and localization all run.
 *
 * A singleton guarded on globalThis avoids exhausting connections across Next.js
 * dev hot-reloads.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for the console read layer.");
}

type DbGlobal = {
  __consoleSql?: ReturnType<typeof postgres>;
  __consoleDb?: ReturnType<typeof drizzle<typeof schema>>;
};
const g = globalThis as unknown as DbGlobal;

const sql = g.__consoleSql ?? postgres(databaseUrl, { prepare: false, max: 5 });
if (!g.__consoleSql) g.__consoleSql = sql;

export const db = g.__consoleDb ?? drizzle(sql, { schema });
if (!g.__consoleDb) g.__consoleDb = db;
