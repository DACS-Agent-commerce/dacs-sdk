import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageUrl = new URL('../', import.meta.url);
const readme = readFileSync(new URL('README.md', packageUrl), 'utf8');

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
