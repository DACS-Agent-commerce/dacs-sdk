// The step-1 copy plan: every file copy-verbatim.mjs writes, with its source,
// and each PR's changed files that are not ported, with the reason. Shared by
// copy-verbatim.mjs (which writes the plan) and check-provenance.mjs --source
// (which requires PROVENANCE.json to list exactly the plan).
import { createHash } from 'node:crypto';
import { originalPath } from './publication-text.mjs';
import {
  computeSets, computeTests, FLAGS, INTEGRATION_BASE, mapPath, PARTIAL_NOTES, PORT_SOURCES, portSourcePath,
} from './source-graph.mjs';

const PKG = 'dacs-seller';

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
    'http-mcp/deploy/hosting/README.md': 'plugin hosting deployment doc (plugin-side; outside src/ and test/)',
    'http-mcp/deploy/hosting/dacs.env.example': 'plugin hosting environment template (plugin-side; outside src/ and test/)',
    'http-mcp/deploy/hosting/preflight.mjs': 'plugin hosting preflight (plugin-side; outside src/ and test/)',
    'http-mcp/docs/OPS-HEALTH.md': "plugin ops-health doc (plugin-side)",
    'http-mcp/docs/SELLER-POLICY-AND-DELIVERY-EVIDENCE.md': 'seller policy doc; outside src/ and not a test; D5 and the README delta read it at 786aa1d',
    'http-mcp/scripts/devnet-demo-seller-release.mjs': "operator script that releases a held seller attempt; outside src/; input to D12's `approvals` command",
    'http-mcp/src/devnet-demo/operator.mjs': "the in-process operator (plugin-side, replaced by the seller host); its seller-mode wiring (journal binding, state lock, purchase resolver) is D5/D12 input",
    'http-mcp/src/ops/health.mjs': 'plugin ops health (plugin-side)',
  },
  59: {
    'http-mcp/deploy/hosting/README.md': 'plugin hosting deployment doc (plugin-side; outside src/ and test/)',
    'http-mcp/deploy/hosting/preflight.mjs': 'plugin hosting preflight (plugin-side; outside src/ and test/)',
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

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function plan(source) {
  const notPortedRules = Object.fromEntries(Object.entries(NOT_PORTED).map(([pr, rules]) => [pr, Object.fromEntries(Object.entries(rules).map(([path, reason]) => [source.publication ? path : originalPath(path), reason]))]));
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
      } else if (Object.hasOwn(notPortedRules[port.pr], path)) {
        notPorted.push({ sourcePath: path, change: status === 'A' ? 'added' : 'modified', reason: notPortedRules[port.pr][path] });
      } else {
        throw new Error(`#${port.pr}: changed file ${path} is neither ported nor listed with a reason`);
      }
    }
    for (const key of [...Object.keys(notPortedRules[port.pr]), ...Object.keys(NEW_SELLER_SIDE[port.pr])]) {
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
