import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageUrl = new URL('../', import.meta.url);
const readme = readFileSync(new URL('README.md', packageUrl), 'utf8');
const rootPackage = JSON.parse(readFileSync(new URL('../../package.json', packageUrl), 'utf8'));

test('the fixture-only claim names the packaged readers and excludes operator-supplied callbacks', () => {
  // The host and createSellerAgent check agreementAnchor and artifactAnchor only
  // by shape (host.mjs:33-81, seller-agent.mjs:148,178), and the wallet journal's
  // broadcast is the operator's own callback (payment-evidence-wallet-journal.mjs).
  // A blanket claim that the kit cannot reach a real Demos node is therefore false.
  assert.doesNotMatch(readme, /cannot start against, or read from, a real Demos node/);
  assert.match(readme, /fixture-only kit[\s\S]{0,120}native DEM delivery capability and the DEM delivery context accept only a\s+`TEST-` authority/);
  assert.match(readme, /createNativePaymentEvidenceConsumer` accepts only a literal `127\.0\.0\.1` RPC\s+origin/);
  assert.match(readme, /`agreementAnchor` and `artifactAnchor` only by shape/);
  assert.match(readme, /`broadcast` is the operator's own callback/);
});

test('the absence proof is a contract for an operator-supplied anchor, not the unbuildable package anchor', () => {
  // createDevnetDemoArtifactAnchor refuses every input because
  // isDevnetDemoTransport is always false (devnet-source.mjs:13), and no part
  // in the stack changes either file.
  assert.doesNotMatch(readme, /The package's devnet artifact anchor returns it from `read`/);
  assert.match(readme, /An operator-supplied `artifactAnchor` must return it from `read`/);
  assert.match(readme, /createDevnetDemoArtifactAnchor[\s\S]{0,300}cannot be constructed/);
  assert.match(readme, /isDevnetDemoTransport[\s\S]{0,100}`false`/);
  assert.match(readme, /src\/dacs\/devnet-source\.mjs/);
});

test('the runtime requirement matches the repository engines and the sqlite module the code imports', () => {
  // The durable stores import better-sqlite3 (seller-durable-state.mjs:10,
  // seller-transport-auth.mjs:8, payment-evidence-wallet-journal.mjs:85,
  // party-vet-store.mjs:21), not node:sqlite, and CI runs the seller suite on
  // Node 20.19.
  assert.ok(readme.includes(rootPackage.engines.node), `the README states the engines range ${rootPackage.engines.node}`);
  assert.doesNotMatch(readme, /node:sqlite/);
  assert.match(readme, /better-sqlite3/);
});
