/** Load .env.local then .env for tsx scripts (Payload config reads process.env). */
import { config as dotenv } from "dotenv";
import path from "node:path";

dotenv({ path: path.resolve(process.cwd(), ".env.local") });
dotenv({ path: path.resolve(process.cwd(), ".env") });

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const DRY_RUN = process.argv.includes("--dry-run");
