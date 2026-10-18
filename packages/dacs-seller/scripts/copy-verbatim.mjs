#!/usr/bin/env node
// WS-3 step 1: the scripted verbatim copy of the seller files into
// packages/dacs-seller (PLAN §0.3 seller row, §0.12 "Verbatim commits come from
// a script"). Every byte comes from `git cat-file blob <commit>:<path>` in the
// frontend repository; nothing is edited. The script writes src/, test/,
// port-sources/ and PROVENANCE.json; check-provenance.mjs verifies them.
//
//   node packages/dacs-seller/scripts/copy-verbatim.mjs --source <frontend repo> [--replace]
//   node packages/dacs-seller/scripts/copy-verbatim.mjs --source <frontend repo> --print-sets
//
// --print-sets prints both packages' computed sets (the shared ownership
// rule, lib/source-graph.mjs) and writes nothing.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSource, INTEGRATION_BASE, PORT_SOURCES, SOURCE_REPOSITORY } from './lib/source-graph.mjs';
import { plan } from './lib/plan.mjs';

const PKG = 'dacs-seller';
const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PKG_DIR = join(SDK_ROOT, 'packages', PKG);

function parseArgs(argv) {
  const args = { source: null, replace: false, printSets: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--source') args.source = argv[++i];
    else if (argv[i] === '--replace') args.replace = true;
    else if (argv[i] === '--print-sets') args.printSets = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!args.source) throw new Error('--source <frontend repository> is required');
  return args;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const lines = (bytes) => { let n = 0; for (const b of bytes) if (b === 10) n += 1; return n; };

function verifyCommits(source) {
  const fail = (m) => { throw new Error(`source check failed: ${m}`); };
  for (const c of [INTEGRATION_BASE, ...PORT_SOURCES.flatMap((p) => [p.inspectedHead, p.planNamedHead])]) {
    if (source.resolveCommit(c) !== c) fail(`${c} is not present as that exact commit`);
  }
  for (const p of PORT_SOURCES) {
    if (!source.isAncestor(INTEGRATION_BASE, p.inspectedHead)) fail(`#${p.pr}: ${INTEGRATION_BASE} is not an ancestor of ${p.inspectedHead}`);
    if (!source.isAncestor(p.planNamedHead, p.inspectedHead)) fail(`#${p.pr}: ${p.planNamedHead} is not an ancestor of ${p.inspectedHead}`);
  }
}

function modeOf(source, commit, path) {
  const out = source.git(['ls-tree', commit, '--', path]).toString();
  const mode = out.split(' ')[0];
  if (mode !== '100644' && mode !== '100755') throw new Error(`${commit}:${path} has mode ${mode}; only regular files are copied`);
  return mode;
}

function printSets({ sets, tests, entries, ports }) {
  const view = {
    integrationBase: INTEGRATION_BASE,
    client: [...sets.client.files].sort().map(([p, v]) => ({ sourcePath: p, via: v.via, named: sets.clientNamed.find((n) => n.path === p)?.namedAs ?? null })),
    seller: [...sets.seller.files].sort().map(([p]) => ({ sourcePath: p, alsoClient: sets.client.files.has(p) })),
    sellerStops: sets.seller.references.filter((r) => r.stop && r.stop !== 'external').map((r) => ({ from: r.from, line: r.line, kind: r.kind, specifier: r.specifier, target: r.target, stop: r.stop })),
    clientStops: sets.client.references.filter((r) => r.stop && r.stop !== 'external').map((r) => ({ from: r.from, line: r.line, kind: r.kind, specifier: r.specifier, target: r.target, stop: r.stop })),
    testsSelected: tests.selected,
    testsLeftOut: tests.considered,
    counts: Object.fromEntries(['src', 'test', 'port-source'].map((role) => [role, entries.filter((e) => e.role === role).length])),
    ports: ports.map(({ port, portedFiles, notPorted }) => ({ pr: port.pr, ported: portedFiles, notPorted })),
  };
  process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = createSource(resolve(args.source));
  verifyCommits(source);
  const planned = plan(source);
  if (args.printSets) { printSets(planned); return; }

  const outputs = ['src', 'test', 'port-sources'].map((d) => join(PKG_DIR, d));
  const present = outputs.filter((d) => existsSync(d));
  if (present.length && !args.replace) throw new Error(`refusing to overwrite ${present.join(', ')} without --replace`);
  for (const d of present) rmSync(d, { recursive: true });

  const totals = {};
  for (const entry of planned.entries) {
    const bytes = source.blob(entry.sourceCommit, entry.sourcePath);
    const target = join(SDK_ROOT, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    if (modeOf(source, entry.sourceCommit, entry.sourcePath) === '100755') chmodSync(target, 0o755);
    entry.sha256 = sha256(bytes);
    const t = (totals[entry.role] ??= { files: 0, lines: 0, bytes: 0 });
    t.files += 1; t.lines += lines(bytes); t.bytes += bytes.length;
  }

  const manifest = {
    format: 'dacs-provenance/v1',
    package: '@kynesyslabs/dacs-seller',
    step: 'WS-3 step 1: verbatim copy, no changes',
    sourceRepository: SOURCE_REPOSITORY,
    integrationBase: INTEGRATION_BASE,
    generatedBy: 'packages/dacs-seller/scripts/copy-verbatim.mjs',
    pathMapping: {
      'http-mcp/src/X': 'packages/dacs-seller/src/X',
      'http-mcp/public/Y': 'packages/dacs-seller/src/public/Y',
      'http-mcp/test/Z': 'packages/dacs-seller/test/Z',
      'PR port source P': 'packages/dacs-seller/port-sources/pr<N>-<7-character inspected head>/P',
    },
    portSources: planned.ports.map(({ port, notPorted }) => ({
      pr: port.pr, topic: port.topic, inspectedHead: port.inspectedHead, planNamedHead: port.planNamedHead, relation: port.relation,
      directory: `packages/dacs-seller/port-sources/pr${port.pr}-${port.inspectedHead.slice(0, 7)}`, notPorted,
    })),
    counts: totals,
    files: planned.entries
      .map(({ path, sourcePath, sourceCommit, sha256: hash, role, note, ...rest }) => ({ path, sourcePath, sourceCommit, sha256: hash, role, ...rest, ...(note ? { note } : {}) }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
  writeFileSync(join(PKG_DIR, 'PROVENANCE.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [role, t] of Object.entries(totals)) process.stdout.write(`${role}: ${t.files} files, ${t.lines} lines, ${t.bytes} bytes\n`);
  process.stdout.write(`wrote ${planned.entries.length} files and PROVENANCE.json under packages/${PKG}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`copy-verbatim: ${error.message}\n`);
  process.exit(1);
}
