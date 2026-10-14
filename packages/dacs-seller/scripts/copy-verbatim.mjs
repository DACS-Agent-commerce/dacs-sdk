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
import {
  computeSets, computeTests, createSource, FLAGS, INTEGRATION_BASE, mapPath, PARTIAL_NOTES, PORT_SOURCES, portSourcePath, SOURCE_REPOSITORY,
} from './lib/source-graph.mjs';

const PKG = 'dacs-seller';
const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PKG_DIR = join(SDK_ROOT, 'packages', PKG);

// PR files that are not in the 82bf8c4 seller set but are new seller-side
// code, ported as port sources.
const NEW_SELLER_SIDE = {
  58: {
    'http-mcp/src/devnet-demo/seller-purchase-source.mjs': "#58's seller-sourced purchase lookup (purchaseSource: \"seller\")",
    'http-mcp/src/devnet-demo/seller-state-lock.mjs': "#58's process-lifetime seller state-directory lock",
    'http-mcp/src/devnet-demo/seller-issuance.mjs': "#58's seller issuance-journal binding for the approval ledger; imported only by operator.mjs and ops/health.mjs at 786aa1d, flagged: new seller-side code outside the named list",
  },
  59: {
    'http-mcp/src/dacs/seller-context-route.mjs': "#59's Vet and Agreement-context route; it also holds the route client (createSellerContextClient), which the buyer side uses",
    'http-mcp/src/switches/DACS_SELLER_CONTEXT.switch': "#59's switch file for DACS_SELLER_CONTEXT (in-process | route)",
  },
};

// Every other file each PR changes, with the reason it is not ported in step 1.
const NOT_PORTED = {
  58: {
    'http-mcp/deploy/vps/README.md': 'plugin VPS deployment doc (plugin-side; outside src/ and test/)',
    'http-mcp/deploy/vps/dacs.env.example': 'plugin VPS environment template (plugin-side; outside src/ and test/)',
    'http-mcp/deploy/vps/preflight.mjs': 'plugin VPS preflight (plugin-side; outside src/ and test/)',
    'http-mcp/docs/OPS-HEALTH.md': "plugin ops-health doc (plugin-side)",
    'http-mcp/docs/SELLER-POLICY-AND-DELIVERY-EVIDENCE.md': 'seller policy doc; outside src/ and not a test; D5 and the README delta read it at 786aa1d',
    'http-mcp/scripts/devnet-demo-seller-release.mjs': "operator script that releases a held seller attempt; outside src/; input to D12's `approvals` command",
    'http-mcp/src/devnet-demo/operator.mjs': "the in-process operator (plugin-side, replaced by the seller host); its seller-mode wiring (journal binding, state lock, purchase resolver) is D5/D12 input",
    'http-mcp/src/ops/health.mjs': 'plugin ops health (plugin-side)',
  },
  59: {
    'http-mcp/deploy/vps/README.md': 'plugin VPS deployment doc (plugin-side; outside src/ and test/)',
    'http-mcp/deploy/vps/preflight.mjs': 'plugin VPS preflight (plugin-side; outside src/ and test/)',
    'http-mcp/docs/OPS-HEALTH.md': 'plugin ops-health doc (plugin-side)',
    'http-mcp/docs/SWITCHES.md': 'plugin switch registry doc (plugin-side)',
    'http-mcp/docs/seller-context-route.md': 'context-route design doc; outside src/ and not a test; D5 reads it at ffef873',
    'http-mcp/scripts/print-seller-context-digests.mjs': "operator script; outside src/; input to D12's `approvals` command",
    'http-mcp/scripts/release-seller-context-hold.mjs': "operator script that releases a held context step; outside src/; input to D12's `approvals` command",
    'http-mcp/src/dacs/dem-delivery-context-consumer.mjs': 'client-side: @kynesyslabs/dacs-client open item',
    'http-mcp/src/dacs/protocol-purchases.mjs': 'client-side: @kynesyslabs/dacs-client open item',
    'http-mcp/src/devnet-demo/composition.mjs': 'the in-process operator composition (plugin-side, replaced by the seller host)',
    'http-mcp/src/devnet-demo/operator-sessions.mjs': "the in-process operator's buyer-side seller session keys (plugin-side)",
    'http-mcp/src/devnet-demo/operator.mjs': 'the in-process operator (plugin-side, replaced by the seller host)',
    'http-mcp/src/mcp/seller-content.mjs': "plugin MCP untrusted-text envelope (plugin-side)",
    'http-mcp/src/ops/health.mjs': 'plugin ops health (plugin-side)',
  },
};

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

function plan(source) {
  const sets = computeSets(source);
  const sellerSrc = [...sets.seller.files.keys()].sort();
  const copied = new Set(sellerSrc);
  const tests = computeTests(source, INTEGRATION_BASE, copied);
  const entries = [];
  const portTests = new Map();
  const ports = PORT_SOURCES.map((port) => {
    const changes = source.changedFiles(INTEGRATION_BASE, port.inspectedHead);
    const portedFiles = [];
    const notPorted = [];
    for (const { status, path } of changes) {
      if (status !== 'A' && status !== 'M') throw new Error(`#${port.pr}: ${path} has status ${status}; only added or modified files are expected`);
      const isTest = path.startsWith('http-mcp/test/');
      const isSellerSrc = copied.has(path);
      const isNew = Object.hasOwn(NEW_SELLER_SIDE[port.pr], path);
      if (isTest || isSellerSrc || isNew) {
        portedFiles.push({ status, path, why: isTest ? 'a test or test helper the PR adds or changes' : isSellerSrc ? 'in the 82bf8c4 seller set' : NEW_SELLER_SIDE[port.pr][path] });
        if (isTest) portTests.set(path, [...(portTests.get(path) ?? []), port.pr]);
      } else if (Object.hasOwn(NOT_PORTED[port.pr], path)) {
        notPorted.push({ sourcePath: path, change: status === 'A' ? 'added' : 'modified', reason: NOT_PORTED[port.pr][path] });
      } else {
        throw new Error(`#${port.pr}: changed file ${path} is neither ported nor listed with a reason`);
      }
    }
    for (const key of [...Object.keys(NOT_PORTED[port.pr]), ...Object.keys(NEW_SELLER_SIDE[port.pr])]) {
      if (!changes.some((c) => c.path === key)) throw new Error(`#${port.pr}: listed file ${key} is not changed by the PR`);
    }
    return { port, portedFiles, notPorted };
  });

  const clientVia = (p) => {
    const hit = sets.client.files.get(p);
    if (!hit) return null;
    return hit.via ? `reached from ${hit.via}` : 'named in the client row';
  };
  for (const p of sellerSrc) {
    const notes = [];
    if (PARTIAL_NOTES[p]) notes.push(PARTIAL_NOTES[p]);
    else if (clientVia(p)) notes.push(`also in the @kynesyslabs/dacs-client set (${clientVia(p)}); copied whole into both packages in step 1`);
    if (FLAGS[p]) notes.push(`flagged: ${FLAGS[p]}`);
    entries.push({ path: mapPath(PKG, p), sourcePath: p, sourceCommit: INTEGRATION_BASE, role: 'src', ...(notes.length ? { note: notes.join('; ') } : {}) });
  }
  for (const p of [...tests.files.keys()].sort()) {
    const notes = [];
    if (portTests.has(p)) notes.push(`changed by ${portTests.get(p).map((n) => `#${n}`).join(' and ')}; the PR version${portTests.get(p).length > 1 ? 's are' : ' is'} under port-sources/`);
    entries.push({ path: mapPath(PKG, p), sourcePath: p, sourceCommit: INTEGRATION_BASE, role: 'test', ...(notes.length ? { note: notes.join('; ') } : {}) });
  }
  for (const { port, portedFiles } of ports) {
    for (const { status, path, why } of portedFiles) {
      const plan = source.blobOrNull(port.planNamedHead, path);
      entries.push({
        path: portSourcePath(PKG, port, path), sourcePath: path, sourceCommit: port.inspectedHead, role: 'port-source',
        pr: port.pr, prChange: status === 'A' ? 'added' : 'modified', planNamedCommit: port.planNamedHead,
        planNamedSha256: plan ? sha256(plan) : null,
        note: why,
      });
    }
  }
  return { sets, tests, entries, ports };
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
