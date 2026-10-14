// Source graph for the WS-3/WS-4 step-1 verbatim copies (PLAN §0.3, §8 briefs
// 3 and 4). It reads the frontend repository through `git cat-file` only, so
// the copies come from immutable commits, never from a working tree.
//
// One rule computes both packages' sets, so @kynesyslabs/dacs-client and
// @kynesyslabs/dacs-seller fit together:
//   - a file named in §0.3's client row, or reached from those files'
//     import closure, belongs to dacs-client;
//   - a file named in §0.3's seller row belongs to dacs-seller; if the client
//     set holds it too, it is copied whole into both packages;
//   - any other file the seller closure reaches that the client set holds is
//     not copied into the seller ("from @kynesyslabs/dacs-client (shared)").
// The closure follows every reference of every copied file: static
// import/export-from, dynamic import() with a literal specifier, and
// new URL(<literal>, import.meta.url). It stops at the classes in STOPS.
//
// The path mapping is in paths.mjs.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { posix } from 'node:path';

export { mapPath, portSourcePath } from './paths.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');

export const SOURCE_REPOSITORY = 'DACS-Agent-commerce/frontend';
export const INTEGRATION_BASE = '82bf8c4dabb2332a72f618f6cc29950e48d6feb6';
export const PORT_SOURCES = [
  {
    pr: 58,
    topic: "seller-sourced lookup, manual hold of pre-payment writes (purchaseSource: \"seller\")",
    inspectedHead: '786aa1d9d6b6393190a6f388a4b92cb921af1fc6',
    planNamedHead: '5274f18541ac0e8c77e3e71463bb6c811f048922',
    relation: 'the plan names 5274f18; the ported head 786aa1d is its descendant and also merges main 82bf8c4, so git diff 82bf8c4 786aa1d is exactly the PR change',
  },
  {
    pr: 59,
    topic: 'Vet and Agreement context route, per-buyer and global unpaid-start limits (DACS_SELLER_CONTEXT=route)',
    inspectedHead: 'ffef873a58a1e71f3a91ae159d92a549992c3857',
    planNamedHead: 'febba6cc2e732a59124eb39f33a50f017d4e3d4c',
    relation: 'the plan names febba6c; the ported head ffef873 is its descendant and also merges main 82bf8c4, so git diff 82bf8c4 ffef873 is exactly the PR change',
  },
];

const ROOT = 'http-mcp/';
const DACS = 'http-mcp/src/dacs/';
const DEMO = 'http-mcp/src/devnet-demo/';

// §0.3 seller row, at 82bf8c4: http-mcp/src/dacs/seller-{agent,durable-state,
// http,transport-auth}.mjs, commit-on-signature.mjs, src/devnet-demo/{...}.mjs.
export const SELLER_NAMED = [
  ...['seller-agent', 'seller-durable-state', 'seller-http', 'seller-transport-auth', 'commit-on-signature'].map((n) => `${DACS}${n}.mjs`),
  ...['agreement-context', 'artifact-anchor', 'operator-approval', 'party-vet-store', 'deliverable', 'native-delivery', 'storage-write-recovery',
    'issued-readback', 'seller-write-batch', 'listing', 'seller-tls', 'public-signed-creates', 'operator-custody'].map((n) => `${DEMO}${n}.mjs`),
];

// §0.3 client row. Bare names resolve under http-mcp/src/dacs/ (the client's
// listing.mjs is src/dacs/listing.mjs); globs expand under the same directory.
export const CLIENT_NAMED = [
  `${DACS}purchase-protocol.mjs`,
  `${DACS}protocol-purchases.mjs`,
  'http-mcp/src/purchases.mjs',
  `${DACS}wallet-transactions.mjs`,
  `${DACS}buyer-chain-readback.mjs`,
  `${DACS}demos-sr2-adapter.mjs`,
  `${DACS}demos-sr2-wallet-bridge.mjs`,
  { glob: `${DACS}*-consumer.mjs` },
  { glob: `${DACS}delivery-*.mjs` },
  `${DACS}completion-readiness.mjs`,
  `${DACS}listing.mjs`,
  `${DACS}verification.mjs`,
  `${DACS}directory.mjs`,
  `${DACS}network-binding.mjs`,
  `${DACS}seller-http.mjs`,
  `${DACS}seller-transport-auth.mjs`,
  `${DACS}seller-session-lifecycle.mjs`,
  'http-mcp/src/wallet/devnet-native-transport.mjs',
  'http-mcp/public/portal/embedded-wallet/sdk-provider.mjs',
  'http-mcp/public/portal/seller-session-delegation.mjs',
  'http-mcp/public/portal/seller-session-limits.mjs',
  'http-mcp/public/portal-intent/intent.mjs',
  // Named in §0.3 as an example of the closure; nothing in the computed
  // closure imports it at 82bf8c4 (only the in-process operator and
  // ops/health.mjs do), so it is a root here and flagged.
  'http-mcp/src/wallet/durable-journal.mjs',
];

// Files §0.3 names only in part. Step 1 copies them whole; the split is a
// later delta.
export const PARTIAL_NOTES = {
  [`${DACS}seller-http.mjs`]: '§0.3 splits this file: the client half (seller-http.mjs:146-286 at 82bf8c4) goes to @kynesyslabs/dacs-client, :20-36 is ported to @kynesyslabs/dacs/wire, the server half stays in the seller; copied whole into both packages in step 1, the split is a later delta',
  [`${DACS}seller-transport-auth.mjs`]: '§0.3 splits this file: the client half goes to @kynesyslabs/dacs-client, :41-129 and :340-378 are ported to @kynesyslabs/dacs/wire, the server half stays in the seller; copied whole into both packages in step 1, the split is a later delta',
  [`${DACS}protocol-purchases.mjs`]: '§0.3 names only the native path of this file; copied whole, the split is a later delta',
  'http-mcp/src/purchases.mjs': '§0.3 names only the payment-state parts of this file; copied whole, the split is a later delta',
  [`${DACS}wallet-transactions.mjs`]: '§0.3 names only the payment-state parts of this file; copied whole, the split is a later delta',
  'http-mcp/public/portal/embedded-wallet/sdk-provider.mjs': '§0.3 names only createSdkWalletSession from this file; copied whole, the split is a later delta',
  'http-mcp/public/portal/seller-session-delegation.mjs': '§0.3 names only the protocol portions of this file (D17); copied whole, the split is a later delta',
  'http-mcp/public/portal/seller-session-limits.mjs': '§0.3 names only the protocol portions of this file (D17); copied whole, the split is a later delta',
  'http-mcp/public/portal-intent/intent.mjs': '§0.3 names only the protocol portions of this file (D17); copied whole, the split is a later delta',
};

// Files the closure keeps but flags for review (copy-and-flag rule).
export const FLAGS = {
  [`${DACS}fixture-anchors.mjs`]: 'mostly the simulated loopback fixture substrate (D10), but fixtureRef (the generic storage-program AttestationRef) and canonicalSignature are used on live paths (for example seller-agent.mjs:1159, :1189); copied and flagged rather than stopped',
  [`${DEMO}stop-request.mjs`]: "the compose CLI's SIGINT/SIGTERM stop flag (10 lines, import-free); operator-approval.mjs:7 and devnet-demo/listing.mjs:2 read it; kept, not treated as the in-process operator",
  [`${DACS}source-demo-seller-transport.mjs`]: 'composition-only capability for the bounded source demo (TEST- authority); a D10 candidate, copied and flagged',
  [`${DACS}devnet-purchase-consumer.mjs`]: 'simulated-loopback devnet purchase profile; a D10 candidate, named by the *-consumer.mjs glob, copied and flagged',
  'http-mcp/src/config.mjs': "the plugin's app configuration, reached only through purchases.mjs:42; not on any stop list, copied and flagged",
};

// D1's cut list, with the files §0.3 names explicitly as exceptions.
const D1_EXCEPTIONS = new Set([
  'http-mcp/src/wallet/devnet-native-transport.mjs',
  'http-mcp/src/wallet/durable-journal.mjs',
  'http-mcp/public/portal/embedded-wallet/sdk-provider.mjs',
  'http-mcp/public/portal/seller-session-delegation.mjs',
  'http-mcp/public/portal/seller-session-limits.mjs',
  'http-mcp/public/portal-intent/intent.mjs',
]);
const IN_PROCESS_OPERATOR = new Set(['operator.mjs', 'operator-buyer.mjs', 'operator-buyer-approval.mjs', 'operator-buyer-run.mjs', 'operator-sessions.mjs',
  'operator-network.mjs', 'seller-relay.mjs', 'composition.mjs', 'stop.mjs'].map((n) => `${DEMO}${n}`));

// Closure stop classes, in the order they are tested.
export const STOPS = {
  external: 'external package or Node built-in',
  'served-asset': 'absolute served-asset URL (browser runtime path, not a file reference)',
  'node-modules-path': 'relative node_modules/dist path into a private package build (D1)',
  'outside-http-mcp': 'resolves outside http-mcp/',
  missing: 'resolves to no file at the source commit',
  directory: 'directory reference, not expanded',
  'd1-cut': "D1's cut list: src/wallet/*, public/portal/*, buyer-access.mjs, operations.mjs",
  'd11-seam': "D11's seams: the app database and the plugin's portal handoffs",
  'in-process-operator': 'the in-process operator (replaced by the seller host, not moved)',
  'shared-client': 'from @kynesyslabs/dacs-client (shared)',
};

export function classifyTarget(target, tree) {
  if (target.includes('/node_modules/')) return 'node-modules-path';
  if (!target.startsWith(ROOT)) return 'outside-http-mcp';
  if (target.endsWith('/')) return 'directory';
  if (!tree.has(target)) return tree.hasDir(target) ? 'directory' : 'missing';
  if (!D1_EXCEPTIONS.has(target) && (target.startsWith('http-mcp/src/wallet/') || target.startsWith('http-mcp/public/portal/')
    || target === `${DEMO}buyer-access.mjs` || target === 'http-mcp/src/operations.mjs')) return 'd1-cut';
  if (target === 'http-mcp/src/store/database.mjs' || target.startsWith('http-mcp/src/portal/')) return 'd11-seam';
  if (IN_PROCESS_OPERATOR.has(target)) return 'in-process-operator';
  return null;
}

export function createSource(repo) {
  const git = (args, options = {}) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 1 << 30, ...options });
  const trees = new Map();
  return {
    repo,
    git,
    resolveCommit(commit) {
      return git(['rev-parse', '--verify', '--end-of-options', `${commit}^{commit}`]).toString().trim();
    },
    isAncestor(a, b) {
      try { git(['merge-base', '--is-ancestor', a, b], { stdio: 'ignore' }); return true; } catch (error) { if (error.status === 1) return false; throw error; }
    },
    tree(commit) {
      if (!trees.has(commit)) {
        const files = new Set(git(['ls-tree', '-r', '-z', '--name-only', commit, '--', 'http-mcp']).toString().split('\0').filter(Boolean));
        const dirs = new Set();
        for (const f of files) for (let d = posix.dirname(f); d !== '.' && !dirs.has(d); d = posix.dirname(d)) dirs.add(d);
        trees.set(commit, { has: (p) => files.has(p), hasDir: (p) => dirs.has(p.replace(/\/$/, '')), files });
      }
      return trees.get(commit);
    },
    blob(commit, path) {
      return git(['cat-file', 'blob', `${commit}:${path}`]);
    },
    blobOrNull(commit, path) {
      try { return git(['cat-file', 'blob', `${commit}:${path}`], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
    },
    changedFiles(base, head) {
      const out = git(['diff', '--name-status', '-z', '--no-renames', base, head, '--', 'http-mcp']).toString().split('\0').filter(Boolean);
      const changes = [];
      for (let i = 0; i < out.length; i += 2) changes.push({ status: out[i], path: out[i + 1] });
      return changes;
    },
  };
}

export function expandNamed(named, tree) {
  const out = [];
  for (const entry of named) {
    if (typeof entry === 'string') {
      if (!tree.has(entry)) throw new Error(`named file missing at the source commit: ${entry}`);
      out.push({ path: entry, namedAs: entry });
      continue;
    }
    const dir = posix.dirname(entry.glob);
    const re = new RegExp(`^${posix.basename(entry.glob).replace(/[.]/g, '\\.').replace(/\*/g, '[^/]*')}$`);
    const hits = [...tree.files].filter((f) => posix.dirname(f) === dir && re.test(posix.basename(f))).sort();
    if (hits.length === 0) throw new Error(`glob matched nothing: ${entry.glob}`);
    for (const hit of hits) out.push({ path: hit, namedAs: entry.glob });
  }
  return out;
}

const PATH_STRING = /^\.{1,2}\/[^\s'"`]*\.(?:mjs|js|cjs|json|py|exp|txt|pem|md)$/;

// Every file reference in one JavaScript module. kind is one of import,
// export-from, dynamic-import, dynamic-import-nonliteral, url,
// url-nonliteral, and, for test files only, path-string (a relative path
// literal not already counted, such as a child-process script).
export function scanReferences(path, text, { pathStrings = false } = {}) {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const refs = [];
  const counted = new Set();
  const line = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      refs.push({ kind: ts.isImportDeclaration(node) ? 'import' : 'export-from', specifier: node.moduleSpecifier.text, line: line(node) });
      counted.add(node.moduleSpecifier);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) { refs.push({ kind: 'dynamic-import', specifier: arg.text, line: line(node) }); counted.add(arg); }
      else refs.push({ kind: 'dynamic-import-nonliteral', specifier: arg ? arg.getText(sf) : '', line: line(node) });
    } else if (ts.isNewExpression(node) && node.expression.getText(sf) === 'URL' && node.arguments?.length >= 2 && node.arguments[1].getText(sf) === 'import.meta.url') {
      const arg = node.arguments[0];
      if (ts.isStringLiteralLike(arg)) { refs.push({ kind: 'url', specifier: arg.text, line: line(node) }); counted.add(arg); }
      else refs.push({ kind: 'url-nonliteral', specifier: arg.getText(sf), line: line(node) });
    } else if (pathStrings && ts.isStringLiteralLike(node) && !counted.has(node) && PATH_STRING.test(node.text)) {
      refs.push({ kind: 'path-string', specifier: node.text, line: line(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return refs;
}

export function resolveSpecifier(from, specifier) {
  if (specifier.startsWith('./') || specifier.startsWith('../')) return posix.join(posix.dirname(from), specifier);
  if (specifier.startsWith('/')) return { stop: 'served-asset' };
  return { stop: 'external' };
}

const isModule = (p) => /\.(?:mjs|js|cjs)$/.test(p);
const FOLLOW_KINDS = new Set(['import', 'export-from', 'dynamic-import', 'url']);
// A relative path literal that names no file is not a file reference.
const NOT_A_FILE = new Set(['missing', 'outside-http-mcp', 'node-modules-path', 'directory']);

// One reference resolved and classified against a tree. stop is null when
// the closure follows it.
export function resolveReference(from, ref, tree) {
  if (ref.kind.endsWith('-nonliteral')) return { ...ref, from, target: null, stop: 'nonliteral' };
  const r = resolveSpecifier(from, ref.specifier);
  if (typeof r === 'object') return { ...ref, from, target: null, stop: r.stop };
  return { ...ref, from, target: r, stop: classifyTarget(r, tree) };
}

// Breadth-first closure from roots. accept(target) may turn a followed target
// into a stop (the ownership rule); it is not applied to roots.
export function closure(source, commit, roots, { accept = () => null, pathStrings = () => false } = {}) {
  const tree = source.tree(commit);
  const files = new Map();
  const references = [];
  const queue = roots.map((p) => ({ path: p, via: null }));
  while (queue.length) {
    const { path, via } = queue.shift();
    if (files.has(path)) continue;
    files.set(path, { via });
    if (!isModule(path)) continue;
    const refs = scanReferences(path, source.blob(commit, path).toString('utf8'), { pathStrings: pathStrings(path) });
    for (const ref of refs) {
      const r = resolveReference(path, ref, tree);
      if (r.kind === 'path-string' && NOT_A_FILE.has(r.stop)) continue;
      if (r.stop === null) {
        const own = accept(r.target);
        if (own) r.stop = own;
      }
      references.push(r);
      if (r.stop === null) queue.push({ path: r.target, via: path });
    }
  }
  return { files, references };
}

// Both packages' sets at the integration base.
export function computeSets(source, commit = INTEGRATION_BASE) {
  const tree = source.tree(commit);
  const clientNamed = expandNamed(CLIENT_NAMED, tree);
  const sellerNamed = expandNamed(SELLER_NAMED, tree);
  const client = closure(source, commit, clientNamed.map((n) => n.path));
  const sellerRoots = new Set(sellerNamed.map((n) => n.path));
  const seller = closure(source, commit, [...sellerRoots], {
    accept: (target) => (!sellerRoots.has(target) && client.files.has(target) ? 'shared-client' : null),
  });
  return { tree, clientNamed, sellerNamed, client, seller, sellerRoots };
}

// Tests for a set of copied source files: every http-mcp/test/**/*.test.mjs
// with a direct import of one of them, plus the helpers and fixtures those
// tests reach under http-mcp/test/ (same stops; relative path literals are
// followed inside http-mcp/test/ only).
export function computeTests(source, commit, copied) {
  const tree = source.tree(commit);
  const candidates = [...tree.files].filter((f) => f.startsWith('http-mcp/test/') && f.endsWith('.test.mjs')).sort();
  const selected = [];
  const considered = [];
  for (const test of candidates) {
    const refs = scanReferences(test, source.blob(commit, test).toString('utf8')).map((ref) => resolveReference(test, ref, tree));
    const direct = refs.filter((r) => FOLLOW_KINDS.has(r.kind) && r.target && copied.has(r.target)).map((r) => r.target);
    if (direct.length) selected.push({ test, direct: [...new Set(direct)] });
    else considered.push({ test, reaches: [...new Set(refs.filter((r) => r.target && (r.target.startsWith('http-mcp/src/') || r.target.startsWith('http-mcp/public/'))).map((r) => r.target))] });
  }
  const inTest = (p) => p.startsWith('http-mcp/test/');
  const result = closure(source, commit, selected.map((s) => s.test), {
    accept: (target) => (inTest(target) ? null : copied.has(target) ? 'copied-src' : 'outside-test'),
    pathStrings: inTest,
  });
  return { selected, considered, files: result.files, references: result.references };
}
