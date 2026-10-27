#!/usr/bin/env node
// Generates IMPORT-CUT-MAP.md for the verbatim copy (client package step 1).
//
//   node packages/dacs-client/scripts/import-cut-map.mjs --source <frontend repo> > packages/dacs-client/IMPORT-CUT-MAP.md
//
// Uses the copy script's graph and ownership rule. For every import edge of a
// copied file that leaves the package or no longer resolves to the same copied
// file after the path mapping, it records file:line, the specifier, the source
// target, why it is cut and the delta that resolves it. The "Held" section
// comes from HOLD.json; each held blob must be the source blob at its commit.
import { publicationText } from './publication-text.mjs';
import { importAudit } from "./check-imports.mjs";
import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRecord } from "./check-hold.mjs";
import { computePlan, loadSource, readBlob, SELLER_NAMED, servedAsset, SOURCE_COMMIT, STOP_REASONS, stopCategory } from "./copy-verbatim.mjs";
import { CLIENT_PACKAGE_DIR, mapSourcePath } from "./path-mapping.mjs";
import { sourceGit } from "./source-git.mjs";

const RESOLUTION = {
  "http-mcp/src/wallet/demos-signature.mjs": "D1: replace with a supported signature and claim helper (a core `@kynesyslabs/dacs` export or a dacs-client module); the D1 sub-run records which",
  "http-mcp/src/wallet/challenges.mjs": "D1/D11: the plugin's wallet challenge store stays in http-mcp behind `WalletActions`/`PurchaseStore`",
  "http-mcp/src/operations.mjs": "D1: replace `OperationError` and the operation helpers with a dacs-client error type",
  "http-mcp/src/devnet-demo/buyer-access.mjs": "D1: the operator buyer-access capability is removed with the in-process operator (D10/D11)",
  "http-mcp/src/wallet/write-batch.mjs": "D1: the plugin wallet write batch stays in http-mcp; the seller's batch moves with dacs-seller",
};
const CATEGORY_RESOLUTION = {
  "d1-cut": "D1: cut the plugin import (portal assets stay in http-mcp, WF-2; D17 extracts protocol portions)",
  "d11-store": "D11: the `PurchaseStore` seam replaces the plugin app database",
  "d11-portal": "D11: the `WalletActions` seam replaces the plugin portal handoff",
  "d10-fixture": "D10: the fixture/simulated mode is deleted with the importer's fixture branch",
  "in-process-operator": "D10/WF-2: the in-process operator is deleted, not moved; the test stays in http-mcp or is rewritten against the seams",
  "node-modules-path": "D1: import from the package's public export instead of a relative node_modules/dist path",
  "directory-reference": "D9/D11: the plugin switch directory is not moved; flagged `config.mjs` is reduced or cut",
  "outside-src": "stays in http-mcp (plugin repository file); the test drops the dependency or stays in http-mcp",
  "seller-only": "from @kynesyslabs/dacs-seller (seller-only file); the test moves to dacs-seller or uses the packed seller",
  "plugin-app": "plugin application module (stays in http-mcp, WF-2); the test stays in http-mcp or is rewritten against the seams",
  "served-asset": "D17/WF-2: a portal asset the plugin serves; WF-2 serves the packed browser assets and switches the caller, and the test loads the packed asset or stays in http-mcp",
  "missing": "does not resolve at the source either (generated at test time or stale); review in D1",
  "non-literal": "non-literal file reference (computed path or `import.meta.url` use); manual review in D1",
  "mapping": "path mapping: http-mcp/public/ moves under src/public/, so the relative specifier no longer reaches the copied file; D1 rewrites it",
};
const DEMOS_WRITE_EVIDENCE = "D1: import `demosTransactionContentMatches` from the core public export added to `src/index.ts` next to the other `demosWriteEvidence` exports (`src/substrate/demosWriteEvidence.ts:178`); no duplicate implementation";

const code = (text) => `\`${String(text).replace(/`/g, "'")}\``;

function resolution(target, category) {
  if (target && /node_modules\/@kynesyslabs\/dacs\/dist\/substrate\/demosWriteEvidence\.js$/.test(target)) return DEMOS_WRITE_EVIDENCE;
  return RESOLUTION[target] ?? CATEGORY_RESOLUTION[category] ?? category;
}

// The holds of HOLD.json: lines, rule, what lifts them, the gate and the probe.
function heldSection(source, p) {
  const record = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "HOLD.json"), "utf8"));
  const mismatches = checkRecord(record);
  if (mismatches.length > 0) throw new Error(`HOLD.json is not the record check-hold.mjs pins; the map is not generated from it:\n${mismatches.join("\n")}`);
  const dest = (path) => mapSourcePath(path).slice(CLIENT_PACKAGE_DIR.length + 1);
  for (const hold of record.holds) {
    if (hold.sourceCommit !== source.commit) throw new Error(`HOLD.json ${hold.id}: sourceCommit ${hold.sourceCommit} is not ${source.commit}`);
    p(`## ${hold.title}`);
    p();
    p(`Status: **${hold.status}** (\`HOLD.json\`, id \`${hold.id}\`). ${hold.reason}`);
    p();
    p("| File:line | Source text at the source commit | What |");
    p("|---|---|---|");
    for (const file of hold.files) {
      const blob = sourceGit(["-C", source.repo, "rev-parse", `${source.commit}:${file.sourcePath}`], { encoding: "utf8" }).trim();
      if (blob !== file.heldBlob) throw new Error(`HOLD.json ${hold.id}: heldBlob of ${file.path} is ${file.heldBlob}, the source blob is ${blob}`);
      const lines = readBlob(source, file.sourcePath).toString("utf8").split("\n");
      for (const { line, what } of file.lines) {
        const text = line.split("-").map((n) => `${n}: ${lines[Number(n) - 1].trim().slice(0, 140)}`).join(" … ");
        p(`| ${code(`${dest(file.sourcePath)}:${line}`)} | ${code(text).replace(/\|/g, "\\|")} | ${what} |`);
      }
    }
    p();
    p(`Held blobs (git blob ids at \`${hold.sourceCommit}\`): ${hold.files.map((file) => `${code(dest(file.sourcePath))} ${code(file.heldBlob)}`).join(", ")}.`);
    p();
    p(`Rule: ${hold.rule}`);
    p();
    p(`Lifting the hold requires: ${hold.liftRequires.sourceFix} Regressions:`);
    p();
    for (const regression of hold.liftRequires.regressions) p(`- \`${regression.id}\`: ${regression.case}`);
    p();
    p(`Condition: ${hold.liftRequires.condition}`);
    p();
    p(`Historical source probe (archived as text): ${code(hold.liftRequires.probe)} (requires the separate source repository to reproduce its historical run). ${hold.liftRequires.probeResult}`);
    p();
    p("Gate: `packages/dacs-client/scripts/check-hold.mjs` runs from the package test script and provenance regressions. The record and gate pin the complete private package and change together for reviewed package updates. Package exports remain empty; package HEAD, index and working bytes and regular-file modes are checked. Other SDK files and unrelated commits are unrestricted, including PR merge commits after main advances. This check imports no package entry point and does not establish absence of external callers or grant live admission.");
    p();
    const repins = record.step1Freeze.plannedRepins;
    p(`Planned re-pins: ${repins.what} ${repins.changes.map((change) => `${code(change.id)}: ${change.what}`).join(" ")} ${repins.mergePolicy}`);
    p();
    p(`Blocked prerequisites: ${hold.blockedPrerequisites.map((item) => `${item.what} ${item.why}`).join(" ")}`);
    p();
  }
}

function parseArgs(argv) {
  const index = argv.indexOf("--source");
  if (index < 0 || !argv[index + 1]) throw new Error("usage: import-cut-map.mjs --source <frontend repo>");
  return { source: argv[index + 1] };
}

async function main() {
  const source = loadSource(parseArgs(process.argv.slice(2)).source, SOURCE_COMMIT);
  const plan = await computePlan(source);
  const copied = new Set([...plan.client.members.keys(), ...plan.clientTests.members.keys()]);
  const sellerOnly = new Set([...plan.sellerCopy.keys()].filter((path) => !plan.client.members.has(path)));
  const lineText = (path, line) => readBlob(source, path).toString("utf8").split("\n")[line - 1].trim();
  const classify = (edge) => {
    if (edge.kind === "import-meta-url" || edge.spec == null) return "non-literal";
    if (!edge.target) return servedAsset(edge) ? "served-asset" : null; // otherwise an external package
    if (copied.has(edge.target)) {
      const fromDest = mapSourcePath(edge.from);
      const reached = posix.normalize(posix.join(posix.dirname(fromDest), edge.spec.split(/[?#]/)[0]));
      return reached === mapSourcePath(edge.target) ? null : "mapping";
    }
    const category = stopCategory(edge.target, source.tree);
    if (category) return category;
    if (sellerOnly.has(edge.target)) return "seller-only";
    return "plugin-app";
  };

  const rows = { src: [], test: [] };
  const externals = { src: new Map(), test: new Map() };
  for (const path of [...copied].sort()) {
    const role = plan.client.members.has(path) ? "src" : "test";
    for (const edge of plan.graph.get(path) ?? []) {
      const full = { ...edge, from: path };
      const category = classify(full);
      if (category === null && !edge.target && edge.spec) {
        const name = edge.spec.startsWith("node:") ? edge.spec : edge.spec.split("/").slice(0, edge.spec.startsWith("@") ? 2 : 1).join("/");
        if (!externals[role].has(name)) externals[role].set(name, []);
        externals[role].get(name).push(`${mapSourcePath(path).slice(CLIENT_PACKAGE_DIR.length + 1)}:${edge.line}`);
      }
      if (category) rows[role].push({ ...full, category });
    }
  }

  const out = [];
  const p = (line = "") => out.push(line);
  const dest = (path) => mapSourcePath(path).slice(CLIENT_PACKAGE_DIR.length + 1);
  p("# Import-cut map: `@kynesyslabs/dacs-client` verbatim copy");
  p();
  p(`Generated by \`${CLIENT_PACKAGE_DIR}/scripts/import-cut-map.mjs --source <frontend repo>\` from frontend \`${source.commit}\` (http-mcp). Do not edit by hand; regenerate.`);
  p();
  p("Paths in the first column are destinations relative to `packages/dacs-client/` with the source line number (the copies are byte-identical, so the line is the same at the source). Mapping: `http-mcp/src/X` → `src/X`, `http-mcp/public/Y` → `src/public/Y`, `http-mcp/test/Z` → `test/Z`.");
  p();
  p("Historical source test paths are now archived as text under `evidence/source-tests/`; `INDEX.json` records their current locations. Sections 1–9 describe the original source copies. Current publication edits are recorded in the delta ledger. Publication approved 2026-10-18.");
  p();
  heldSection(source, p);
  p("## Summary");
  p();
  const count = (list, cat) => list.filter((row) => row.category === cat).length;
  p("| Reason | Source modules | Tests, helpers, fixtures |");
  p("|---|---|---|");
  for (const cat of Object.keys(CATEGORY_RESOLUTION)) {
    const a = count(rows.src, cat);
    const b = count(rows.test, cat);
    if (a + b > 0) p(`| ${cat} | ${a} | ${b} |`);
  }
  p();
  p("Reasons: " + Object.entries({ ...STOP_REASONS, "seller-only": "file of the seller set only", "plugin-app": "http-mcp module outside both package sets", "mapping": CATEGORY_RESOLUTION.mapping, "non-literal": CATEGORY_RESOLUTION["non-literal"] })
    .filter(([key]) => key !== "external").map(([key, text]) => `\`${key}\`: ${text}`).join("; ") + ".");
  p();

  p("## 1. Source modules: imports cut or broken by the mapping");
  p();
  p("| File:line | Specifier | Resolves to at the source | Why cut | Resolving delta |");
  p("|---|---|---|---|---|");
  for (const row of rows.src) {
    p(`| ${code(`${dest(row.from)}:${row.line}`)} | ${row.spec ? code(row.spec) : `(${row.kind})`} | ${row.target ? code(row.target) : "—"} | ${row.category} | ${resolution(row.target, row.category)} |`);
  }
  p();

  p("## 2. Closure stops");
  p();
  p("The source closure stopped at these targets (external packages are listed in §5). Importers are the copied files that reach each one.");
  p();
  p("| Target at the source | Reason | Importers |");
  p("|---|---|---|");
  const stopTargets = new Map();
  for (const row of rows.src.filter((r) => r.category !== "mapping")) {
    const key = row.target ?? `(${row.kind}) ${dest(row.from)}:${row.line}`;
    if (!stopTargets.has(key)) stopTargets.set(key, { category: row.category, importers: [] });
    stopTargets.get(key).importers.push(`${dest(row.from)}:${row.line}`);
  }
  for (const [target, info] of [...stopTargets].sort()) p(`| ${code(target)} | ${info.category} | ${info.importers.map(code).join(", ")} |`);
  p();

  p("## 3. Files copied whole whose split or removal is a later delta");
  p();
  p("| File | Selection | Note |");
  p("|---|---|---|");
  for (const [path, info] of [...plan.client.members].sort()) {
    if (info.note && (/later delta|FLAG|also copied/.test(info.note))) p(`| ${code(dest(path))} | ${info.selection} | ${info.note} |`);
  }
  p();
  const sellerRows = SELLER_NAMED.map((entry) => entry.path).filter((path) => plan.client.members.has(path));
  p(`Seller-row files also copied into this package (${sellerRows.length}): ${sellerRows.map((path) => code(dest(path))).join(", ")}. The seller package copies them too; the split decides which half each package keeps.`);
  p();

  p("## 4. D17 browser files: imports, browser-only references and callers");
  p();
  const browserFiles = ["http-mcp/public/portal/seller-session-delegation.mjs", "http-mcp/public/portal/seller-session-limits.mjs",
    "http-mcp/public/portal-intent/intent.mjs", "http-mcp/public/portal/embedded-wallet/sdk-provider.mjs"];
  const browserGlobals = /\b(window|document|navigator|localStorage|sessionStorage|indexedDB|location|HTMLElement|customElements|requestAnimationFrame|alert|confirm)\b/;
  for (const path of browserFiles) {
    const text = readBlob(source, path).toString("utf8").split("\n");
    p(`### ${code(dest(path))}`);
    p();
    const edges = plan.graph.get(path) ?? [];
    p(`- Imports: ${edges.length === 0 ? "none (self-contained module)" : edges.map((e) => `${code(`${e.line}: ${e.spec}`)} → ${e.target && copied.has(e.target) ? `copied (${code(dest(e.target))}), protocol` : "cut"}`).join("; ")}.`);
    const globals = [];
    text.forEach((line, i) => {
      const stripped = line.replace(/\/\/.*$/, "");
      const match = stripped.match(browserGlobals);
      if (match) globals.push(`${i + 1} (${match[1]})`);
    });
    p(`- Browser-global matches (window/document/storage/DOM names outside line comments; candidates): ${globals.length === 0 ? "none" : globals.join(", ")}.`);
    const exports = [];
    text.forEach((line, i) => {
      const match = /^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z0-9_$]+)/.exec(line);
      if (match) exports.push(`${match[1]}:${i + 1}`);
    });
    p(`- Exports (protocol candidates for D17's browser-safe exports): ${exports.length === 0 ? "none" : exports.map(code).join(", ")}.`);
    const callers = [];
    for (const [from, list] of plan.graph) {
      for (const edge of list) if (edge.target === path && !from.startsWith("http-mcp/test/")) callers.push(`${from}:${edge.line} (${edge.kind})`);
    }
    p(`- Importers at the source outside tests (static graph): ${callers.length === 0 ? "none" : callers.map(code).join(", ")}.`);
    const name = posix.basename(path);
    const mentions = [];
    for (const other of source.tree.keys()) {
      if (other === path || other.startsWith("http-mcp/test/") || other.startsWith("http-mcp/vendor/") || other.startsWith("http-mcp/docs/") || !/\.(mjs|js|cjs|html|json)$/.test(other)) continue;
      readBlob(source, other).toString("utf8").split("\n").forEach((line, i) => {
        if (line.includes(name) && !callers.includes(`${other}:${i + 1} (import)`)) mentions.push(`${other}:${i + 1}`);
      });
    }
    p(`- Other mentions of ${code(name)} outside tests and docs (served-asset URLs, asset lists, packaging): ${mentions.length === 0 ? "none" : mentions.map(code).join(", ")}.`);
    p();
  }
  p("Browser-global matches are a regex over non-comment text (property names such as `confirm` in a list can match); they are candidates for D17's review, not a verdict. PLAN §0.3 D17 also cites `public/portal/portal.js:626`, where the portal runs `checkSellerSessionDelegation` before every ordinary-purchase signature (a call site, not an import).");
  p();

  p("## 5. External dependencies");
  p();
  for (const role of ["src", "test"]) {
    p(`### ${role === "src" ? "Source modules" : "Tests, helpers, fixtures"}`);
    p();
    p("| Specifier | Importers |");
    p("|---|---|");
    for (const [name, list] of [...externals[role]].sort()) {
      p(`| ${code(name)} | ${list.length > 12 ? `${list.length} imports, e.g. ${list.slice(0, 6).map(code).join(", ")}` : list.map(code).join(", ")} |`);
    }
    p();
  }
  p("`node:sqlite` in a source module means that module cannot be loaded by the client root under the SQLite exclusion; the split deltas move it behind a subpath or out of the client.");
  p();

  p("## 6. Tests, helpers and fixtures: imports cut or broken");
  p();
  p("Grouped by target. The copied tests do not run in the package until D1 (\"not run in the package: imports cut pending D1\"). `served-asset` rows are module imports of `/portal/assets/…` URLs; the many `/portal/assets/…` mentions inside test strings (HTTP request paths and browser-page scripts) are not module imports and are not listed, so D17/WF-2's served-asset inventory must cover them separately.");
  p();
  p("| Target at the source | Reason | Resolving delta | Importers (file:line `specifier`) |");
  p("|---|---|---|---|");
  const testTargets = new Map();
  for (const row of rows.test) {
    const key = row.category === "non-literal" ? `(non-literal) ${row.kind}` : `${row.target ?? row.spec}${row.category === "mapping" ? " (mapping)" : ""}`;
    if (!testTargets.has(key)) testTargets.set(key, { target: row.target, category: row.category, importers: [] });
    testTargets.get(key).importers.push(`${dest(row.from)}:${row.line}${row.spec ? ` ${row.spec}` : ""}`);
  }
  for (const [key, info] of [...testTargets].sort()) {
    p(`| ${code(key)} | ${info.category} | ${resolution(info.target, info.category)} | ${info.importers.map(code).join(", ")} |`);
  }
  p();
  const nodeModuleRows = [...rows.src, ...rows.test].filter((row) => row.category === "node-modules-path");
  p("Relative `node_modules` imports, with the imported names:");
  p();
  for (const row of nodeModuleRows) p(`- ${code(`${dest(row.from)}:${row.line}`)}: ${code(lineText(row.from, row.line).slice(0, 200))}`);
  p();

  p("## 7. Tests considered and left out");
  p();
  p(`${plan.clientTests.considered} files match \`http-mcp/test/**/*.test.mjs\`; ${plan.clientTests.considered - plan.clientTests.excluded.length} import a file of the client set directly and are copied; ${plan.clientTests.excluded.length} are left out because they import no file of the client set directly. \`http-mcp/deploy/test/*.test.mjs\` is outside the brief's \`http-mcp/test/**\` scope and was not considered.`);
  p();
  p(plan.clientTests.excluded.map((entry) => code(entry.test.replace(/^http-mcp\//, ""))).join(", "));
  p();

  p("## 8. Later source heads touching the client set (not copied in step 1)");
  p();
  p("Files of this package's set (src and tests) that each head changes relative to the source commit. These heads are not ported here.");
  p();
  const heads = [
    ["the source change inspected head (merge of main into the source change), D15", "02f7070ddff7bf9e94ffd9a953ccc2f0af56caba"],
    ["the source change frozen head, context route (seller step ports it)", "ffef873a58a1e71f3a91ae159d92a549992c3857"],
    ["the source change frozen head, seller-sourced lookup (seller step ports it)", "786aa1d9d6b6393190a6f388a4b92cb921af1fc6"],
  ];
  for (const [label, head] of heads) {
    let changed;
    try {
      changed = sourceGit(["-C", source.repo, "diff-tree", "-r", "--numstat", source.commit, head, "--", "http-mcp"], { encoding: "utf8" })
        .trim().split("\n").filter(Boolean).map((line) => line.split("\t"));
    } catch {
      p(`- ${label} \`${head}\`: head not available in the source repository.`);
      continue;
    }
    const inSet = changed.filter(([, , path]) => copied.has(path));
    const newTests = changed.filter(([, , path]) => /^http-mcp\/test\//.test(path) && !source.tree.has(path));
    p(`- ${label} \`${head}\`: ${inSet.length} copied files changed: ${inSet.map(([add, del, path]) => `${code(dest(path))} (+${add}/-${del})`).join(", ") || "none"}.${newTests.length ? ` New test files at that head: ${newTests.map(([, , path]) => code(path.replace(/^http-mcp\//, ""))).join(", ")}.` : ""}`);
  }
  p();

  p("## 9. Local paths in copied text (not imports)");
  p();
  p("Copied lines that contain an absolute local home path. Step 1 does not edit the copies, and the path text is not reproduced here. The test-port delta replaces each with a provisioned or neutral path.");
  p();
  const homePath = /\/(home|Users)\/[^/\s'"`]+\//;
  const localPathNotes = {
    "http-mcp/test/v\u0070s-hosting.test.mjs": "a rejected `networkAdmissionPath` value in a preflight negative case",
    "http-mcp/test/helpers/agreement-context-integration.mjs": "the default of `DACS_SELLER_INTEROP_REFERENCE`, an external reference tree that is not provisioned",
  };
  const localPaths = [];
  for (const path of [...copied].sort()) {
    readBlob(source, path).toString("utf8").split("\n").forEach((line, i) => {
      if (homePath.test(line)) localPaths.push(`- ${code(`${dest(path)}:${i + 1}`)}: ${localPathNotes[path] ?? "review in the test-port delta"}.`);
    });
  }
  p(localPaths.length === 0 ? "None." : localPaths.join("\n"));
  p();
  p('## 10. Current destination import audit (D1)');
  p();
  p('Sections 1–9 record the original copy and source graph. This section scans the current destination source. Test harness cuts remain listed above.');
  const audit = importAudit();
  p();
  p(`Relative source imports: ${audit.rows.length}; unresolved or forbidden source imports: ${audit.failures.length}.`);
  for (const failure of audit.failures) p(`- FAIL ${failure}`);
  p();
  p('| Current file:line | Specifier | Current target |');
  p('|---|---|---|');
  for (const row of audit.rows) p(`| ${code(row.where)} | ${code(row.spec)} | ${code(row.target)} |`);
  // One final newline: console.log adds it.
  console.log(publicationText(out.join("\n")));
}

main().catch((error) => {
  console.error(`[import-cut-map] ${error.message}`);
  process.exitCode = 1;
});
