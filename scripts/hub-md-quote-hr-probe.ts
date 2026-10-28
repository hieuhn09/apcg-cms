/**
 * Spike A5 (APCGHub "docx AI import", phase A — content-engine plan
 * process/features/apcg-hub/active/hub-docx-ai-import-pa-cms-media_PLAN_28-10-26.md):
 * do a pull quote (`>`) and a horizontal rule (`---`) survive the hub body
 * converter of this CMS?
 *
 * DEV-ONLY. No database, no network: the Payload config is only SANITIZED (never
 * connected), exactly like `scripts/hub-probe.ts --only P-20..` (body-only probes).
 * For every fixture it runs the SAME path as `POST/PATCH /api/hub/articles`:
 *   validateBodyPure (the route's pure gate) → convertBodyGuarded (md → lex1 →
 *   checkLexicalTree → md1 → gate F: import(md1) → export must equal md1 → tree check)
 * and prints (i) tree accepted, (ii) export → import stable (gate F), (iii) the
 * exported Markdown. PASS needs (i) AND (ii).
 *
 *   npx tsx scripts/hub-md-quote-hr-probe.ts            # human-readable
 *   npx tsx scripts/hub-md-quote-hr-probe.ts --json     # one JSON line per fixture
 *
 * Exit code 0 always (a FAIL here is a phase-B input, not a phase-A error).
 */

process.env.DATABASE_URL ??= "postgres://a5-probe@127.0.0.1:1/a5_probe_no_db";
process.env.PAYLOAD_SECRET ??= "a5-probe-placeholder";

interface Fixture {
  name: string;
  md: string;
}

const FIXTURES: Fixture[] = [
  { name: "quote-attributed", md: 'Intro paragraph.\n\n> "The quoted sentence." - Jane Example\n\nClosing paragraph.' },
  { name: "quote-multiline", md: "Intro paragraph.\n\n> First quoted line\n> second quoted line\n\nClosing paragraph." },
  { name: "quote-multi-paragraph", md: "Intro paragraph.\n\n> First quoted paragraph.\n>\n> Second quoted paragraph.\n\nClosing paragraph." },
  { name: "hr-dashes-between-paragraphs", md: "First paragraph.\n\n---\n\nSecond paragraph." },
  { name: "hr-asterisks", md: "First paragraph.\n\n***\n\nSecond paragraph." },
  { name: "quote-nested", md: "Intro paragraph.\n\n> Outer quote\n>\n> > Inner quote\n\nClosing paragraph." },
  { name: "hr-right-under-heading", md: "## A heading\n---\n\nBody paragraph." },
  { name: "hr-after-heading-blank-line", md: "## A heading\n\n---\n\nBody paragraph." },
  { name: "quote-with-bold", md: "Intro paragraph.\n\n> **Bold** quoted words.\n\nClosing paragraph." },
];

async function main(): Promise<void> {
  const asJson = process.argv.includes("--json");
  const { default: configPromise } = await import("../payload.config");
  const { loadHubEditorConfig } = await import("../src/lib/hub-article-markdown");
  const body = await import("../src/lib/hub-author-body");
  const core = await import("../src/lib/hub-author-convert-core");
  const editorConfig = (await loadHubEditorConfig(await configPromise)) as Parameters<typeof body.convertBodyGuarded>[0];
  const conv = body.hubBodyConverters(editorConfig);

  let pass = 0;
  for (const f of FIXTURES) {
    const pure = body.validateBodyPure(f.md);
    let treeOk: boolean | null = null;
    let nodeTypes: string[] = [];
    let md1: string | null = null;
    let stable: boolean | null = null;
    try {
      const lex1 = conv.toLexical(f.md);
      const t = core.checkLexicalTree(lex1);
      treeOk = t.ok;
      const types = new Set<string>();
      const stack: unknown[] = [(lex1 as { root?: unknown }).root];
      while (stack.length) {
        const n = stack.pop() as { type?: unknown; children?: unknown } | null;
        if (!n || typeof n !== "object") continue;
        if (typeof n.type === "string") types.add(n.type);
        if (Array.isArray(n.children)) stack.push(...n.children);
      }
      nodeTypes = [...types].sort();
      md1 = conv.toMarkdown(lex1);
      const md2 = conv.toMarkdown(conv.toLexical(md1));
      stable = md2 === md1;
    } catch (err) {
      treeOk = false;
      md1 = `THROW ${(err as Error).name}`;
    }
    const g = pure.ok ? body.convertBodyGuarded(editorConfig, pure.body) : null;
    const guarded = !pure.ok ? `pure:${pure.code}` : g!.ok ? "ok" : `fail:${g!.reason}`;
    const verdict = treeOk === true && stable === true && guarded === "ok" ? "PASS" : "FAIL";
    if (verdict === "PASS") pass++;
    if (asJson) {
      console.log(JSON.stringify({ name: f.name, verdict, treeOk, stable, guarded, nodeTypes, input: f.md, exported: md1 }));
    } else {
      console.log(`${verdict}  ${f.name}  tree=${treeOk} stable=${stable} guarded=${guarded} nodes=[${nodeTypes.join(",")}]`);
      console.log(`   in : ${JSON.stringify(f.md)}`);
      console.log(`   out: ${JSON.stringify(md1)}`);
    }
  }
  console.log(`A5 summary: ${pass}/${FIXTURES.length} PASS`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`A5 probe crashed: ${(err as Error).name}`);
    process.exit(1);
  },
);
