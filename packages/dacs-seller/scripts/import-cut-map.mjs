#!/usr/bin/env node
// Generates the tables of packages/dacs-seller/IMPORT-CUT-MAP.md, between its
// BEGIN GENERATED and END GENERATED markers, from the copied files and
// PROVENANCE.json. Every reference of a copied file that leaves the package or
// no longer resolves after the path mapping gets a row: file:line, specifier,
// imported names, what it resolves to at the source commit, why it is cut, and
// the delta that resolves it.
//
//   node packages/dacs-seller/scripts/import-cut-map.mjs --source <frontend repo> [--check]
//
// --check exits 1 when the document is not current.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closure, computeSets, computeTests, createSource, FLAGS, INTEGRATION_BASE, mapPath, NOT_A_FILE, PARTIAL_NOTES, resolveReference, scanReferences, STOPS,
} from './lib/source-graph.mjs';

const PKG = 'dacs-seller';
const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PKG_DIR = join(SDK_ROOT, 'packages', PKG);
const DOC = join(PKG_DIR, 'IMPORT-CUT-MAP.md');
const BEGIN = '<!-- BEGIN GENERATED: scripts/import-cut-map.mjs -->';
const END = '<!-- END GENERATED -->';

const CLASS_WHY = {
  ...STOPS,
  'shared-client': 'in the @kynesyslabs/dacs-client set; not copied into the seller (ownership rule)',
  'not-moved': 'a plugin-side module in neither package',
  nonliteral: 'non-literal specifier; not resolved statically',
};

// The delta that resolves a cut, and how. Target-specific first.
const TARGET_DELTA = {
  'http-mcp/src/wallet/demos-signature.mjs': 'D1: the package must not import plugin wallet modules. The helpers imported here (claim and address conversion, signature decoding and verification) need a supported home, an existing SDK identity export or a shared @kynesyslabs/dacs-client module; D1 records which (question for Hayk)',
  'http-mcp/src/wallet/write-batch.mjs': 'D1: the wallet write-batch primitive behind DACS_SELLER_WRITE_BATCHES needs a supported home (a shared @kynesyslabs/dacs-client module or a seller-owned module); D1 records which',
  'http-mcp/src/devnet-demo/buyer-access.mjs': "D1 with D5 (K1): the operator's buyer-access check reads the plugin's operation store; seller-owned admission (D5) replaces it and the import goes",
  'http-mcp/src/operations.mjs': "D1 with D5 (K1): the plugin's operation store and OperationError; seller-owned state and errors (D5) replace them",
  'http-mcp/public/portal/embedded-wallet/demos-runtime.mjs': "D2: the browser demosdk bundle loaded under window/document shims; inject Node's @kynesyslabs/demosdk into createSdkWalletSession and delete the shim",
  'http-mcp/src/devnet-demo/stop-request.mjs': "D1, D12: shared from @kynesyslabs/dacs-client under the ownership rule (the client reaches it through operator-approval.mjs); the seller CLI's `start` (D12) owns the stop flag. If dacs-client does not take this file, the seller copies it instead",
  'http-mcp/src/dacs/fixture-anchors.mjs': 'D1 with D10 on the seller side: the simulated fixture substrate goes; fixtureRef and canonicalSignature, which live paths use, need a supported home before the import is removed',
  'http-mcp/node_modules/@kynesyslabs/dacs/dist/substrate/demosWriteEvidence.js': 'D1: import demosTransactionContentMatches from the core public export (src/index.ts); no private dist path',
  'http-mcp/node_modules/@kynesyslabs/dacs/dist/index.js': 'D1: import the core by its package name, not a private dist path',
  'http-mcp/public/portal/embedded-wallet/sdk-provider.mjs': 'D1, D2: createSdkWalletSession from the @kynesyslabs/dacs-client wallet-session export (WS-4 moves it), with the Node demosdk injected (D2)',
  'http-mcp/public/portal/seller-session-limits.mjs': "D1, D17: the session-lifetime limits from @kynesyslabs/dacs-client's browser-safe protocol export (WS-4)",
};
const CLASS_DELTA = {
  'shared-client': 'D1: import from @kynesyslabs/dacs-client once WS-4 exports it',
  'd1-cut': 'D1: replace the plugin module with a package export or a test double; the test change goes in DELTA-MAP',
  'd11-seam': 'D11 (WS-4): the plugin app database or portal seam; a seller test that needs it is rewritten against the seller host or dropped, recorded in DELTA-MAP',
  'in-process-operator': "D12: the seller host (`start`) replaces the in-process operator; a test that drives the operator is re-hosted or dropped, recorded in DELTA-MAP",
  'not-moved': 'none in WS-3/WS-4: the test is rewritten without the plugin module or stays in http-mcp, recorded in DELTA-MAP',
  'node-modules-path': 'D1: import by package name, no private dist path',
  missing: 'review: resolves to no file at the source (a frozen or templated copy)',
  directory: 'review: a directory reference, resolved by the test at run time',
  nonliteral: 'review: resolved at run time',
  'outside-http-mcp': 'review: leaves http-mcp',
  'served-asset': 'review: a served browser asset path',
};
const deltaFor = (cls, target) => TARGET_DELTA[target] ?? CLASS_DELTA[cls] ?? 'review';

function parseArgs(argv) {
  const args = { source: null, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--source') args.source = argv[++i];
    else if (argv[i] === '--check') args.check = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!args.source) throw new Error('--source <frontend repository> is required');
  return args;
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const code = (s) => `\`${String(s).replace(/`/g, "'")}\``;
const rel = (p) => p.replace(`packages/${PKG}/`, '');
const short = (p) => (p ? p.replace(/^http-mcp\//, '') : '');

function classify(entry, ref, r, inPkg, clientSet) {
  if (r.stop === 'external') return null;
  if (r.target && !r.target.endsWith('/') && r.stop === null) {
    let mapped = null;
    try { mapped = mapPath(PKG, r.target); } catch { /* unmappable */ }
    const fromCopy = posix.join(posix.dirname(entry.path), ref.specifier);
    if (mapped && inPkg.has(mapped) && fromCopy === mapped) return null;
    if (clientSet.has(r.target)) return 'shared-client';
    return mapped && inPkg.has(mapped) ? 'mapping-moves' : 'not-moved';
  }
  return r.stop;
}

function analyse(source, manifest) {
  const sets = computeSets(source);
  const clientSet = new Set(sets.client.files.keys());
  const inPkg = new Set(manifest.files.map((e) => e.path));
  const rows = { src: [], test: [] };
  const externals = new Map();
  for (const entry of manifest.files.filter((e) => e.role === 'src' || e.role === 'test')) {
    const tree = source.tree(entry.sourceCommit);
    const text = readFileSync(join(SDK_ROOT, entry.path), 'utf8');
    if (!/\.(?:mjs|js|cjs)$/.test(entry.path)) continue;
    for (const ref of scanReferences(entry.sourcePath, text, { pathStrings: entry.role === 'test' })) {
      const r = resolveReference(entry.sourcePath, ref, tree);
      if (r.kind === 'path-string' && NOT_A_FILE.has(r.stop)) continue;
      if (r.stop === 'external') {
        const name = ref.specifier.startsWith('node:') ? ref.specifier : ref.specifier.split('/').slice(0, ref.specifier.startsWith('@') ? 2 : 1).join('/');
        const ex = externals.get(ref.specifier) ?? { root: name, src: new Set(), test: new Set() };
        ex[entry.role].add(rel(entry.path));
        externals.set(ref.specifier, ex);
        continue;
      }
      const cls = classify(entry, ref, r, inPkg, clientSet);
      if (!cls) continue;
      rows[entry.role].push({ file: rel(entry.path), line: ref.line, kind: ref.kind, specifier: ref.specifier, names: ref.names ?? null, target: r.target, cls });
    }
  }
  return { sets, clientSet, rows, externals };
}

// Left-out tests that reach a copied seller src file without importing it:
// through test helpers, or only through another *.test.mjs file. Same accept
// rule as computeTests.
function indirectReach(source, considered, sellerSet, copiedTests) {
  const inTest = (p) => p.startsWith('http-mcp/test/');
  const out = new Map();
  for (const { test } of considered) {
    const c = closure(source, INTEGRATION_BASE, [test], {
      accept: (target) => (inTest(target) ? null : sellerSet.has(target) ? 'copied-src' : 'outside-test'),
      pathStrings: inTest,
    });
    const hits = c.references.filter((r) => r.target && sellerSet.has(r.target));
    if (!hits.length) continue;
    const viaHelper = hits.filter((r) => !r.from.endsWith('.test.mjs'));
    const used = viaHelper.length ? viaHelper : hits;
    const through = [...new Set(used.map((r) => r.from))].sort();
    out.set(test, {
      seller: [...new Set(used.map((r) => r.target))].sort(),
      through,
      viaTestFile: viaHelper.length === 0,
      uncopied: through.filter((p) => !copiedTests.has(p)),
      operator: c.references.some((r) => r.stop === 'in-process-operator'),
    });
  }
  return out;
}

function reachDecision(r) {
  if (r.operator) return 'map: it also drives the in-process operator, which D12 replaces; DELTA-MAP records whether it is re-hosted on the seller host or stays in http-mcp';
  if (r.viaTestFile) return `map: it reaches seller code only through the copied test file ${r.through.map(short).join(', ')}; DELTA-MAP records it with that file`;
  if (r.uncopied.length === 0) return 'map: candidate moved test; its helpers are already copied, so moving it in D1 adds only this file';
  return `map: candidate moved test; moving it in D1 also copies ${r.uncopied.map(short).join(', ')}`;
}

function portSourceRows(source, manifest, clientSet) {
  const sellerSrc = new Set(manifest.files.filter((e) => e.role === 'src').map((e) => e.sourcePath));
  const out = [];
  for (const entry of manifest.files.filter((e) => e.role === 'port-source' && /\.(?:mjs|js)$/.test(e.path))) {
    const tree = source.tree(entry.sourceCommit);
    const text = readFileSync(join(SDK_ROOT, entry.path), 'utf8');
    const isTest = entry.sourcePath.startsWith('http-mcp/test/');
    for (const ref of scanReferences(entry.sourcePath, text, { pathStrings: isTest })) {
      const r = resolveReference(entry.sourcePath, ref, tree);
      if (r.stop === 'external' || (r.kind === 'path-string' && NOT_A_FILE.has(r.stop))) continue;
      const t = r.target;
      const portedSame = t && manifest.files.some((e) => e.role === 'port-source' && e.sourceCommit === entry.sourceCommit && e.sourcePath === t);
      let where;
      if (r.stop) where = r.stop;
      else if (portedSame) where = 'ported (same PR)';
      else if (sellerSrc.has(t)) where = 'seller src/ (82bf8c4 version)';
      else if (t.startsWith('http-mcp/test/')) where = manifest.files.some((e) => e.role === 'test' && e.sourcePath === t) ? 'seller test/ (82bf8c4 version)' : 'test support not copied';
      else if (clientSet.has(t)) where = 'shared-client';
      else where = 'not-moved';
      if (isTest && (where === 'ported (same PR)' || where.startsWith('seller '))) continue;
      out.push({ pr: entry.pr, file: entry.sourcePath, isTest, line: ref.line, specifier: ref.specifier, names: ref.names ?? null, target: t, where });
    }
  }
  return out;
}

function render(source, manifest) {
  const { sets, clientSet, rows, externals } = analyse(source, manifest);
  const L = [];
  const counts = manifest.counts;
  L.push(`Generated from PROVENANCE.json (integration base ${INTEGRATION_BASE.slice(0, 7)}; ${manifest.files.length} files: src ${counts.src.files}, test ${counts.test.files}, port-source ${counts['port-source'].files}).`, '');

  L.push('### G1. The two computed sets', '');
  L.push(`The client set (${clientSet.size} files) is computed with the same rule, for ownership only; prep-ws4-step1 owns the client package. "named" means named in §0.3's client row; otherwise the file that first reaches it.`, '');
  L.push('| Client-set file | Named or reached from |', '|---|---|');
  for (const [p, v] of [...sets.client.files].sort()) {
    const named = sets.clientNamed.find((n) => n.path === p);
    L.push(`| ${code(short(p))} | ${named ? `named (${code(short(named.namedAs))})` : `reached from ${code(short(v.via))}`} |`);
  }
  L.push('', `The seller set (${sets.seller.files.size} files, all named in §0.3's seller row; the closure adds no file the client set lacks):`, '');
  L.push('| Seller src file | Also in the client set | Note |', '|---|---|---|');
  for (const p of [...sets.seller.files.keys()].sort()) {
    const via = sets.client.files.get(p);
    L.push(`| ${code(short(p))} | ${via ? (via.via ? `yes, reached from ${code(short(via.via))}` : 'yes, named') : 'no'} | ${cell([PARTIAL_NOTES[p] ? 'split later (see §3)' : '', FLAGS[p] ? 'flagged (see §4)' : ''].filter(Boolean).join('; '))} |`);
  }

  L.push('', '### G2. Seller src imports that leave the package', '');
  L.push('Every import in `src/` whose target is not a copied seller file. Paths are relative to `packages/dacs-seller/` (file) and `http-mcp/` (target).', '');
  L.push('| File:line | Specifier | Imports | Resolves to at 82bf8c4 | Why cut | Resolved by |', '|---|---|---|---|---|---|');
  for (const r of rows.src) {
    L.push(`| ${code(`${r.file}:${r.line}`)} | ${code(r.specifier)}${r.kind === 'import' ? '' : ` (${r.kind})`} | ${cell(r.names ? r.names.join(', ') : '(dynamic)')} | ${code(short(r.target) || r.specifier)} | ${cell(CLASS_WHY[r.cls] ?? r.cls)} | ${cell(deltaFor(r.cls, r.target))} |`);
  }

  L.push('', '### G3. Closure stops of the seller src set', '');
  L.push('| Target (http-mcp/) | Stop | Imported by |', '|---|---|---|');
  const stops = new Map();
  for (const r of rows.src) { const k = `${r.target}\u0000${r.cls}`; (stops.get(k) ?? stops.set(k, []).get(k)).push(`${r.file}:${r.line}`); }
  for (const [k, list] of [...stops].sort()) { const [t, c] = k.split('\u0000'); L.push(`| ${code(short(t))} | ${cell(c)} | ${cell(list.map(code).join(', '))} |`); }

  L.push('', '### G4. External imports', '');
  L.push('Not cuts, but the package must declare them. The moved code ran against http-mcp\'s vendored core archive (`vendor/kynesyslabs-dacs-0.1.0-alpha.0.tgz`); in the SDK, `@kynesyslabs/dacs` resolves to the SDK core instead, which R-1 qualifies. `node:sqlite` needs Node ≥22.13 (DEC-38).', '');
  L.push('| Specifier | src files | test files |', '|---|---|---|');
  for (const [s, ex] of [...externals].sort()) L.push(`| ${code(s)} | ${ex.src.size} | ${ex.test.size} |`);

  L.push('', '### G5. Test imports that leave the package', '');
  L.push('Grouped by target. Every listed occurrence is one reference in a copied test, helper or fixture (`path-string` = a relative path literal such as a child-process script). The copied tests cannot run in the package until these are resolved: "not run in the package: imports cut pending D1".', '');
  L.push('| Target (http-mcp/) | Why cut | Resolved by | Occurrences (file:line) |', '|---|---|---|---|');
  const groups = new Map();
  for (const r of rows.test) { const k = `${r.target ?? r.specifier}\u0000${r.cls}`; (groups.get(k) ?? groups.set(k, []).get(k)).push(r); }
  for (const [k, list] of [...groups].sort()) {
    const [t, c] = k.split('\u0000');
    L.push(`| ${code(short(t))} | ${cell(CLASS_WHY[c] ?? c)} | ${cell(deltaFor(c, t))} | ${cell(list.map((r) => code(`${r.file}:${r.line}${r.kind === 'import' ? '' : ` ${r.kind}`}`)).join(', '))} |`);
  }

  const sellerSet = new Set(sets.seller.files.keys());
  const tests = computeTests(source, INTEGRATION_BASE, sellerSet);
  const indirect = indirectReach(source, tests.considered, sellerSet, new Set(tests.files.keys()));
  const viaHelper = [...indirect.values()].filter((r) => !r.viaTestFile);
  const sellerOnly = viaHelper.filter((r) => r.seller.some((p) => !clientSet.has(p))).length;
  L.push('', '### G6. Tests considered and left out', '');
  L.push(`${tests.considered.length} of the ${tests.considered.length + tests.selected.length} \`http-mcp/test/**/*.test.mjs\` files import no copied seller file directly, so step 1 leaves them out (the brief's selection rule). The reason says what each one imports directly from \`src/\` or \`public/\`; that alone does not mean the test leaves seller code alone. ${indirect.size} of them drive copied seller files without importing them: ${viaHelper.length} through test helpers (${sellerOnly} of these reach a seller-only file, one not in the client set) and ${indirect.size - viaHelper.length} only through another test file. G8 lists those ${indirect.size} with a decision for each.`, '');
  L.push('| Test | Reason |', '|---|---|');
  for (const t of tests.considered) {
    const reach = t.reaches;
    const client = reach.filter((p) => clientSet.has(p));
    let reason = reach.length === 0 ? 'imports no src/ or public/ file directly'
      : client.length === reach.length ? `client-side direct imports only (${client.map(short).join(', ')})`
        : client.length ? `imports client-set files (${client.map(short).join(', ')}) and plugin-side files (${reach.filter((p) => !clientSet.has(p)).map(short).join(', ')}) directly`
          : `plugin-side direct imports only (${reach.map(short).join(', ')})`;
    const r = indirect.get(t.test);
    if (r) reason += `; drives seller ${r.seller.map(short).join(', ')} through ${r.through.map(short).join(', ')} (G8)`;
    L.push(`| ${code(short(t.test))} | ${cell(reason)} |`);
  }

  const ports = portSourceRows(source, manifest, clientSet);
  L.push('', '### G7. Port-source imports', '');
  L.push('Nothing imports `port-sources/`. For D5, this lists what each ported file imports at its PR head, except references to other files of the same PR and, for tests, to files already in the seller package.', '');
  L.push('| PR | File:line | Specifier | Imports | Target at the PR head | Where it is |', '|---|---|---|---|---|---|');
  for (const r of ports) L.push(`| #${r.pr} | ${code(`${short(r.file)}:${r.line}`)} | ${code(r.specifier)} | ${cell(r.names ? r.names.join(', ') : '')} | ${code(short(r.target) || r.specifier)} | ${cell(r.where)} |`);

  L.push('', '### G8. Left-out tests that drive seller code without importing it', '');
  L.push(`The ${indirect.size} tests of G6 whose closure (test helpers and fixtures under \`http-mcp/test/\`, same stops) reaches a copied seller file. None is copied in step 1, because the brief selects tests by direct import. Each one is mapped: \`DELTA-MAP.md\` records whether it moves into the package or stays in \`http-mcp\`, so "moved tests pass or are mapped" accounts for it. "Through" names the files that import the seller file; "seller-only" means at least one reached file is not in the client set.`, '');
  L.push('| Test | Seller src reached | Through | Seller-only | Decision |', '|---|---|---|---|---|');
  for (const [test, r] of [...indirect].sort()) {
    L.push(`| ${code(short(test))} | ${cell(r.seller.map((p) => code(short(p))).join(', '))} | ${cell(r.through.map((p) => code(short(p))).join(', '))} | ${r.seller.some((p) => !clientSet.has(p)) ? 'yes' : 'no'} | ${cell(reachDecision(r))} |`);
  }
  return L.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = createSource(resolve(args.source));
  const manifest = JSON.parse(readFileSync(join(PKG_DIR, 'PROVENANCE.json'), 'utf8'));
  const doc = readFileSync(DOC, 'utf8');
  const a = doc.indexOf(BEGIN), b = doc.indexOf(END);
  if (a < 0 || b < a) throw new Error('IMPORT-CUT-MAP.md lacks the generated markers');
  const next = `${doc.slice(0, a + BEGIN.length)}\n\n${render(source, manifest)}\n\n${doc.slice(b)}`;
  if (args.check) {
    if (next !== doc) { process.stderr.write('import-cut-map: IMPORT-CUT-MAP.md is not current\n'); process.exit(1); }
    process.stdout.write('import-cut-map: current\n');
    return;
  }
  writeFileSync(DOC, next);
  process.stdout.write('import-cut-map: wrote IMPORT-CUT-MAP.md\n');
}

try {
  main();
} catch (error) {
  process.stderr.write(`import-cut-map: ${error.message}\n`);
  process.exit(1);
}
