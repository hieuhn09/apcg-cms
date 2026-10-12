/**
 * Validate the GTP mapping (gtp-launch P4, A12-N01/N02, A13-R02). Opens no
 * database and writes nothing.
 *
 *   npm run migrate:gtp:validate-mapping -- --mapping <structural.json> [--mapping-overlay <overlay.json>] [--structural-only] [--require-final]
 *
 * Exit 0 = valid (PROVISIONAL owner-decision values are printed); exit 2 = invalid,
 * a literal "TODO" remains, the overlay is missing (without --structural-only), or
 * --require-final is set while provisional markers remain.
 */
import { parseCommand } from "./lib/cli-spec";
import { loadEffectiveMapping, runMain } from "./lib/cli-common";
import { formatProvisional } from "./lib/gtp-mapping";

async function main(): Promise<number> {
  const a = parseCommand("validate-mapping", process.argv.slice(2));
  const structuralOnly = a.has("structural-only");
  const v = loadEffectiveMapping(a, undefined, { requireFinal: a.has("require-final"), structuralOnly });
  console.log(`[validate-mapping] OK${structuralOnly ? " (structural only: overlay required for any run)" : ""}`);
  console.log(formatProvisional(v.provisional));
  const re = Object.keys(v.mapping.categories.map);
  console.log(`[validate-mapping] category overrides: ${re.length ? re.join(", ") : "none"}; status map: ${JSON.stringify(v.mapping.status.map)}; unknown status: ${v.mapping.status.unknown}`);
  return 0;
}

runMain("validate-mapping", main);
