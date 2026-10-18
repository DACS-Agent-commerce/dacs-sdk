#!/usr/bin/env node
// client package step 1: the scripted verbatim copy of the buyer-side protocol modules
// from the frontend repo's http-mcp plugin into @kynesyslabs/dacs-client.
//
//   node packages/dacs-client/scripts/copy-verbatim.mjs --source <frontend repo> --plan [--plan-out <file>]
//   node packages/dacs-client/scripts/copy-verbatim.mjs --source <frontend repo> --write
//
// Every byte comes from `git cat-file blob <commit>:<path>` in the source repo,
// read through source-git.mjs as the checker reads it, and is written
// unchanged; nothing is copied by hand. --plan computes the
// client set and the seller set with the same ownership rule and prints them
// with every closure stop. --write copies the client set and its tests and
// writes PROVENANCE.json; it refuses to run over an existing src/ or test/.
//
// Selection (PLAN §0.3 and the client package step-1 brief):
// - Roots are the files §0.3 names in the package's row, with the bare names
//   and globs resolved as recorded below.
// - The closure follows static imports and `export … from`, dynamic import()
//   with a literal specifier, require() with a literal specifier, and
//   `new URL(<literal>, import.meta.url)` file references, within
//   http-mcp/src and http-mcp/public. It stops at external packages, at
//   absolute served-asset URLs (`/portal/assets/…`), at the D1 cut list (except the files §0.3 names), at modules a delta replaces
//   (app database and portal handoffs: D11; fixture and simulated modes: D10;
//   the in-process operator), at paths outside the source tree and at
//   directory references. Every stop is reported.
// - Ownership: a file named in the client row or reached by the client
//   closure belongs to dacs-client. A file named in the seller row belongs to
//   dacs-seller and is copied whole into both packages when the client also
//   reaches it. Any other file of the seller closure that the client owns is
//   shared from dacs-client and not copied into the seller.
// - Tests: every http-mcp/test/**/*.test.mjs with a direct edge to a file of
//   the package set, plus the test/ helpers and fixtures those tests reach.
//   Edges from tests to anything else outside the set are reported as stops.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENT_PACKAGE_DIR, mapSourcePath } from "./path-mapping.mjs";
import { sourceGit } from "./source-git.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = join(SCRIPT_DIR, "..", "..", "..");

// frontend `main` at the plan's citation commit.
export const SOURCE_COMMIT = "82bf8c4dabb2332a72f618f6cc29950e48d6feb6";
export const SOURCE_REPOSITORY = "DACS-Agent-commerce/frontend";

// §0.3, client row: the named files, in the row's order.
export const CLIENT_NAMED = [
  { path: "http-mcp/src/dacs/purchase-protocol.mjs" },
  { path: "http-mcp/src/dacs/protocol-purchases.mjs", note: "§0.3 names the native path of protocol-purchases.mjs; copied whole, the split is a later delta (D10, D11)" },
  { path: "http-mcp/src/purchases.mjs", note: "§0.3 names the payment-state parts of src/purchases.mjs; copied whole, the split is a later delta (D11)" },
  { path: "http-mcp/src/dacs/wallet-transactions.mjs", note: "§0.3 names the payment-state parts of wallet-transactions.mjs; copied whole, the split is a later delta (D11, D15)" },
  { path: "http-mcp/src/dacs/buyer-chain-readback.mjs" },
  { path: "http-mcp/src/dacs/demos-sr2-adapter.mjs" },
  { path: "http-mcp/src/dacs/demos-sr2-wallet-bridge.mjs" },
  { glob: "*-consumer.mjs", note: "§0.3 names the *-consumer.mjs readers; glob expanded over http-mcp/src and http-mcp/public" },
  { glob: "delivery-*.mjs", note: "§0.3 names delivery-*.mjs; glob expanded over http-mcp/src and http-mcp/public" },
  { path: "http-mcp/src/dacs/completion-readiness.mjs" },
  { path: "http-mcp/src/dacs/listing.mjs", note: "bare name listing.mjs: the client's is src/dacs/listing.mjs; the seller row's is src/devnet-demo/listing.mjs" },
  { path: "http-mcp/src/dacs/verification.mjs" },
  { path: "http-mcp/src/dacs/directory.mjs", note: "bare name directory.mjs: src/dacs/directory.mjs; bin/offline-fixtures/directory.mjs is the offline fixture (D10) and is not copied. D16 adapts it to the source change's catalog schema" },
  { path: "http-mcp/src/dacs/network-binding.mjs" },
  { path: "http-mcp/src/dacs/seller-http.mjs", note: "§0.3 names seller-http.mjs:146-286 for the client and the whole file for the seller; copied whole into both packages, the split is a later delta" },
  { path: "http-mcp/src/dacs/seller-transport-auth.mjs", note: "§0.3 names the client half of seller-transport-auth.mjs and the whole file for the seller; copied whole into both packages, the split is a later delta" },
  { path: "http-mcp/src/dacs/seller-session-lifecycle.mjs" },
  { path: "http-mcp/src/wallet/devnet-native-transport.mjs" },
  { path: "http-mcp/public/portal/embedded-wallet/sdk-provider.mjs", note: "§0.3 names createSdkWalletSession from sdk-provider.mjs; copied whole, the split is a later delta (D2, D17)" },
  { path: "http-mcp/public/portal/seller-session-delegation.mjs", note: "D17: §0.3 names its protocol portions; copied whole, the extraction is a later delta" },
  { path: "http-mcp/public/portal/seller-session-limits.mjs", note: "D17: §0.3 names its protocol portions; copied whole, the extraction is a later delta" },
  { path: "http-mcp/public/portal-intent/intent.mjs", note: "D17: §0.3 names its protocol portions; copied whole, the extraction is a later delta" },
  { path: "http-mcp/src/wallet/durable-journal.mjs", note: "§0.3 names the durable wallet-journal subpath (src/wallet/durable-journal.mjs:11) and lists wallet/durable-journal.mjs in the closure; at the source commit no client file imports it statically (its importers are src/devnet-demo/operator.mjs and src/ops/health.mjs), so it is a named root" },
];

// §0.3, seller row (frontend main files only; the source change/the source change heads are the seller step's).
export const SELLER_NAMED = [
  "http-mcp/src/dacs/seller-agent.mjs",
  "http-mcp/src/dacs/seller-durable-state.mjs",
  "http-mcp/src/dacs/seller-http.mjs",
  "http-mcp/src/dacs/seller-transport-auth.mjs",
  "http-mcp/src/dacs/commit-on-signature.mjs",
  ...["agreement-context", "artifact-anchor", "operator-approval", "party-vet-store", "deliverable", "native-delivery",
    "storage-write-recovery", "issued-readback", "seller-write-batch", "listing", "seller-tls", "public-signed-creates",
    "operator-custody"].map((name) => `http-mcp/src/devnet-demo/${name}.mjs`),
].map((path) => ({ path }));

// Closure members copied under "if unsure, copy it and flag it".
export const FLAGGED = new Map([
  ["http-mcp/src/config.mjs", "FLAG: the plugin's environment configuration, reached because purchases.mjs imports PURCHASE_LIMITS; also holds PINNED_CHAIN_IDENTITIES. Kept or cut by D11 (PurchaseStore) and D6/DEC-16 (network identity)"],
  ["http-mcp/src/switch-files.mjs", "FLAG: the plugin's switch-file loader, reached only through config.mjs"],
  ["http-mcp/src/buyer-funding.mjs", "FLAG: plugin buyer-funding message helper, reached only through purchases.mjs"],
  ["http-mcp/src/dacs/source-demo-seller-transport.mjs", "FLAG: source-demo composition capability (TEST- authority) that selects the authenticated seller HTTP client; D3/D10 decide whether it survives"],
  ["http-mcp/src/dacs/seller-agent.mjs", "FLAG: reached only through seller-http.mjs:9 (the server half, outside the client's lines 146-286); expected to leave dacs-client when seller-http.mjs is split"],
  ["http-mcp/src/dacs/seller-durable-state.mjs", "FLAG: reached only through seller-agent.mjs:50; loads node:sqlite; expected to leave dacs-client with seller-agent.mjs"],
  ["http-mcp/src/dacs/devnet-purchase-consumer.mjs","FLAG: matched by the *-consumer.mjs glob, but it is the simulated-loopback devnet purchase profile, which D10 deletes"],
]);

// The D1 cut list's exceptions: files §0.3 names explicitly.
export const D1_EXCEPTIONS = new Set([
  "http-mcp/src/wallet/devnet-native-transport.mjs",
  "http-mcp/src/wallet/durable-journal.mjs",
  "http-mcp/public/portal/embedded-wallet/sdk-provider.mjs",
  "http-mcp/public/portal/seller-session-delegation.mjs",
  "http-mcp/public/portal/seller-session-limits.mjs",
  "http-mcp/public/portal-intent/intent.mjs",
]);

const IN_PROCESS_OPERATOR = /^http-mcp\/src\/devnet-demo\/(operator|operator-buyer|operator-buyer-approval|operator-buyer-run|operator-network|operator-sessions|composition|seller-relay|stop|recipient-balance)\.mjs$/;

// Why a closure stops at a target. `null` means the closure may follow it.
export const STOP_REASONS = {
  "external": "external package or Node built-in",
  "served-asset": "absolute URL path (`/portal/assets/…`) that only http-mcp's asset server resolves; leaves the package",
  "node-modules-path": "relative path into node_modules or a private dist build (not in the source tree)",
  "missing": "relative path with no file in the source tree",
  "directory-reference": "directory reference, not a file",
  "d1-cut": "D1 cut list: src/wallet/*, public/portal/*, buyer-access.mjs, operations.mjs (public/portal-intent/* treated as part of public/portal/*)",
  "d11-store": "D11 seam: the plugin's app database (PurchaseStore)",
  "d11-portal": "D11 seam: the plugin's portal handoffs (WalletActions)",
  "d10-fixture": "D10: fixture or simulated mode, deleted rather than moved",
  "in-process-operator": "the in-process operator, replaced rather than moved",
  "outside-src": "outside http-mcp/src and http-mcp/public (plugin repository file)",
};

export function stopCategory(target, tree) {
  if (target.endsWith("/")) return "directory-reference";
  if (!tree.has(target)) return /(^|\/)node_modules\//.test(target) ? "node-modules-path" : "missing";
  if (!/^http-mcp\/(src|public)\//.test(target)) return "outside-src";
  if (D1_EXCEPTIONS.has(target)) return null;
  if (/^http-mcp\/(src\/wallet|public\/portal|public\/portal-intent)\//.test(target)
    || /\/buyer-access\.mjs$/.test(target) || target === "http-mcp/src/operations.mjs") return "d1-cut";
  if (target.startsWith("http-mcp/src/store/")) return "d11-store";
  if (target.startsWith("http-mcp/src/portal/")) return "d11-portal";
  if (target === "http-mcp/src/dacs/fixture-anchors.mjs" || target.startsWith("http-mcp/bin/offline-fixtures/")) return "d10-fixture";
  if (IN_PROCESS_OPERATOR.test(target)) return "in-process-operator";
  return null;
}

function git(repo, args, encoding = "utf8") {
  return sourceGit(["-C", repo, ...args], { encoding, maxBuffer: 1 << 30 });
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function globToRegExp(glob) {
  return new RegExp(`^${glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
}

// Import edges of one JavaScript module, with 1-based line numbers.
function moduleEdges(ts, sourcePath, text) {
  const sf = ts.createSourceFile(sourcePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edges = [];
  const urlBases = new Set();
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const literal = (node) => (node && ts.isStringLiteralLike(node) ? node.text : null);
  const isImportMetaUrl = (node) => node && ts.isPropertyAccessExpression(node) && node.name.text === "url"
    && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword;
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      edges.push({ kind: ts.isImportDeclaration(node) ? "import" : "export-from", spec: literal(node.moduleSpecifier), line: lineOf(node) });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      edges.push({ kind: "dynamic-import", spec: literal(node.arguments[0]), line: lineOf(node) });
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length === 1) {
      edges.push({ kind: "require", spec: literal(node.arguments[0]), line: lineOf(node) });
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL"
      && node.arguments?.length === 2 && isImportMetaUrl(node.arguments[1])) {
      urlBases.add(node.arguments[1]);
      edges.push({ kind: "url", spec: literal(node.arguments[0]), line: lineOf(node) });
    } else if (isImportMetaUrl(node) && !urlBases.has(node)) {
      // import.meta.url outside `new URL(x, import.meta.url)`: a file reference
      // the closure cannot follow; reported for manual review.
      edges.push({ kind: "import-meta-url", spec: null, line: lineOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return edges;
}

// An absolute specifier such as import('/portal/assets/x.mjs') is a URL the
// plugin's asset server resolves in the browser, not a module in the tree.
export function servedAsset(edge) {
  return typeof edge.spec === "string" && edge.spec.startsWith("/");
}

function resolveEdge(from, edge) {
  if (edge.spec == null) return null;
  if (!edge.spec.startsWith("./") && !edge.spec.startsWith("../")) return null;
  const spec = edge.spec.split(/[?#]/)[0];
  const joined = posix.normalize(posix.join(posix.dirname(from), spec));
  return spec.endsWith("/") && !joined.endsWith("/") ? `${joined}/` : joined;
}

export function loadSource(repo, commitArg = SOURCE_COMMIT) {
  const commit = git(repo, ["rev-parse", "--verify", `${commitArg}^{commit}`]).trim();
  const listing = git(repo, ["ls-tree", "-r", "-z", "--full-tree", commit, "--", "http-mcp"]).split("\0").filter(Boolean);
  const tree = new Map();
  for (const line of listing) {
    const [meta, path] = line.split("\t");
    const [mode, type, oid] = meta.split(" ");
    if (type === "blob") tree.set(path, { mode, oid });
  }
  return { repo, commit, tree };
}

export function readBlob(source, path) {
  return sourceGit(["-C", source.repo, "cat-file", "blob", `${source.commit}:${path}`], { maxBuffer: 1 << 30 });
}

export async function buildGraph(source) {
  const require = createRequire(join(SDK_ROOT, "package.json"));
  const ts = require("typescript");
  const graph = new Map();
  for (const path of source.tree.keys()) {
    if (!/\.(mjs|js|cjs)$/.test(path) || path.startsWith("http-mcp/vendor/")) continue;
    const text = readBlob(source, path).toString("utf8");
    graph.set(path, moduleEdges(ts, path, text).map((edge) => ({ ...edge, target: resolveEdge(path, edge) })));
  }
  return graph;
}

function expandRoots(named, tree) {
  const roots = new Map();
  for (const entry of named) {
    if (entry.glob) {
      const pattern = globToRegExp(entry.glob);
      const matches = [...tree.keys()].filter((path) => /^http-mcp\/(src|public)\//.test(path) && pattern.test(posix.basename(path))).sort();
      if (matches.length === 0) throw new Error(`glob ${entry.glob} matched nothing`);
      for (const path of matches) roots.set(path, { selection: `named (glob ${entry.glob})`, note: entry.note });
    } else {
      if (!tree.has(entry.path)) throw new Error(`named file ${entry.path} is not in the source tree`);
      roots.set(entry.path, { selection: "named", ...(entry.note ? { note: entry.note } : {}) });
    }
  }
  return roots;
}

function closure(graph, tree, roots) {
  const members = new Map(roots);
  const stops = [];
  const pending = [...roots.keys()];
  while (pending.length > 0) {
    const from = pending.shift();
    for (const edge of graph.get(from) ?? []) {
      if (edge.kind === "import-meta-url" || edge.spec == null) {
        stops.push({ from, line: edge.line, kind: edge.kind, spec: edge.spec, target: null, category: "non-literal" });
        continue;
      }
      if (!edge.target) {
        stops.push({ from, line: edge.line, kind: edge.kind, spec: edge.spec, target: null, category: servedAsset(edge) ? "served-asset" : "external" });
        continue;
      }
      if (members.has(edge.target)) continue;
      const category = stopCategory(edge.target, tree);
      if (category) {
        stops.push({ from, line: edge.line, kind: edge.kind, spec: edge.spec, target: edge.target, category });
        continue;
      }
      members.set(edge.target, { selection: `closure (${from}:${edge.line})` });
      pending.push(edge.target);
    }
  }
  return { members, stops };
}

function selectTests(graph, tree, packageSet) {
  const tests = [...tree.keys()].filter((path) => /^http-mcp\/test\/.*\.test\.mjs$/.test(path)).sort();
  const selected = new Map();
  const excluded = [];
  for (const test of tests) {
    const hits = (graph.get(test) ?? []).filter((edge) => edge.target && packageSet.has(edge.target));
    if (hits.length > 0) selected.set(test, { selection: `test (imports ${hits[0].target} at line ${hits[0].line})` });
    else excluded.push({ test, reason: "imports no file of the package set directly" });
  }
  const members = new Map(selected);
  const stops = [];
  const pending = [...selected.keys()];
  while (pending.length > 0) {
    const from = pending.shift();
    for (const edge of graph.get(from) ?? []) {
      if (edge.kind === "import-meta-url" || edge.spec == null) {
        stops.push({ from, line: edge.line, kind: edge.kind, spec: edge.spec, target: null, category: "non-literal" });
        continue;
      }
      if (!edge.target) {
        if (servedAsset(edge)) stops.push({ from, line: edge.line, kind: edge.kind, spec: edge.spec, target: null, category: "served-asset" });
        continue; // external packages: recorded by the cut map, not stops of the test closure
      }
      if (members.has(edge.target) || packageSet.has(edge.target)) continue;
      if (edge.target.startsWith("http-mcp/test/") && tree.has(edge.target)) {
        members.set(edge.target, { selection: `test helper (${from}:${edge.line})` });
        if (graph.has(edge.target)) pending.push(edge.target);
        continue;
      }
      stops.push({ from, line: edge.line, kind: edge.kind, spec: edge.spec, target: edge.target, category: stopCategory(edge.target, tree) ?? "outside-package-set" });
    }
  }
  return { members, stops, excluded, considered: tests.length };
}

export async function computePlan(source) {
  const graph = await buildGraph(source);
  const clientRoots = expandRoots(CLIENT_NAMED, source.tree);
  const sellerRoots = expandRoots(SELLER_NAMED, source.tree);
  const client = closure(graph, source.tree, clientRoots);
  const seller = closure(graph, source.tree, sellerRoots);
  const sellerCopy = new Map();
  const sellerShared = [];
  for (const [path, info] of seller.members) {
    if (sellerRoots.has(path)) sellerCopy.set(path, client.members.has(path) ? { ...info, alsoInClient: true } : info);
    else if (client.members.has(path)) sellerShared.push(path);
    else sellerCopy.set(path, info);
  }
  for (const [path, info] of client.members) {
    if (FLAGGED.has(path)) info.note = [info.note, FLAGGED.get(path)].filter(Boolean).join("; ");
    if (sellerRoots.has(path)) {
      const why = clientRoots.has(path) ? "named in both rows" : `named in the seller row and reached by the client ${info.selection}`;
      info.note = [info.note, `also copied whole into @kynesyslabs/dacs-seller (${why}); the split is a later delta`].filter(Boolean).join("; ");
    }
  }
  const clientTests = selectTests(graph, source.tree, new Set(client.members.keys()));
  return { graph, clientRoots, sellerRoots, client, seller, sellerCopy, sellerShared, clientTests };
}

export function planSummary(source, plan) {
  const list = (map) => [...map.entries()].map(([path, info]) => ({ path, ...info })).sort((a, b) => a.path.localeCompare(b.path));
  return {
    sourceRepository: SOURCE_REPOSITORY,
    sourceCommit: source.commit,
    mapping: "http-mcp/src/X -> src/X; http-mcp/public/Y -> src/public/Y; http-mcp/test/Z -> test/Z",
    stopReasons: STOP_REASONS,
    client: {
      files: list(plan.client.members),
      stops: plan.client.stops,
      tests: list(plan.clientTests.members),
      testStops: plan.clientTests.stops,
      testsConsidered: plan.clientTests.considered,
      testsExcluded: plan.clientTests.excluded,
    },
    seller: {
      files: list(plan.sellerCopy),
      sharedFromClient: plan.sellerShared.sort(),
      stops: plan.seller.stops,
    },
  };
}

export function manifestEntries(source, plan) {
  const entries = [];
  const add = (path, info, role) => {
    if (source.tree.get(path).mode === "120000") throw new Error(`refusing symlink ${path}`);
    const bytes = readBlob(source, path);
    entries.push({ path: mapSourcePath(path), sourcePath: path, sourceCommit: source.commit, sha256: sha256(bytes), role,
      selection: info.selection, ...(info.note ? { note: info.note } : {}), bytes });
  };
  for (const [path, info] of plan.client.members) add(path, info, "src");
  for (const [path, info] of plan.clientTests.members) add(path, info, "test");
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const destinations = new Set();
  for (const entry of entries) {
    if (destinations.has(entry.path)) throw new Error(`two sources map to ${entry.path}`);
    destinations.add(entry.path);
  }
  return entries;
}

function parseArgs(argv) {
  const args = { source: null, commit: SOURCE_COMMIT, plan: false, planOut: null, write: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source") args.source = argv[++i];
    else if (arg === "--commit") args.commit = argv[++i];
    else if (arg === "--plan") args.plan = true;
    else if (arg === "--plan-out") args.planOut = argv[++i];
    else if (arg === "--write") args.write = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!args.source || args.plan === args.write) {
    throw new Error("usage: copy-verbatim.mjs --source <frontend repo> (--plan [--plan-out <file>] | --write) [--commit <rev>]");
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = loadSource(args.source, args.commit);
  if (source.commit !== SOURCE_COMMIT) throw new Error(`source commit ${source.commit} is not the pinned ${SOURCE_COMMIT}`);
  const plan = await computePlan(source);
  if (args.plan) {
    const text = `${JSON.stringify(planSummary(source, plan), null, 2)}\n`;
    if (args.planOut) writeFileSync(args.planOut, text);
    else process.stdout.write(text);
    return;
  }
  const packageRoot = join(SDK_ROOT, CLIENT_PACKAGE_DIR);
  for (const dir of ["src", "test"]) {
    const path = join(packageRoot, dir);
    if (existsSync(path) && readdirSync(path).length > 0) throw new Error(`${path} already exists; remove it before a fresh copy`);
  }
  const entries = manifestEntries(source, plan);
  for (const entry of entries) {
    const target = join(SDK_ROOT, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.bytes, { flag: "wx" });
  }
  const manifest = {
    package: "@kynesyslabs/dacs-client",
    generatedBy: `${CLIENT_PACKAGE_DIR}/scripts/copy-verbatim.mjs`,
    sourceRepository: SOURCE_REPOSITORY,
    sourceCommit: source.commit,
    mapping: planSummary(source, plan).mapping,
    files: entries.map(({ bytes, ...entry }) => entry),
  };
  writeFileSync(join(packageRoot, "PROVENANCE.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const count = (role) => entries.filter((entry) => entry.role === role).length;
  console.log(`[copy-verbatim] ${entries.length} files from ${source.commit} (src ${count("src")}, test ${count("test")})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`[copy-verbatim] ${error.message}`);
    process.exitCode = 1;
  });
}
