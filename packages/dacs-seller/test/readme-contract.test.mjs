import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageUrl = new URL('../', import.meta.url);
const readme = readFileSync(new URL('README.md', packageUrl), 'utf8');
const rootPackage = JSON.parse(readFileSync(new URL('../../package.json', packageUrl), 'utf8'));
const profile = JSON.parse(readFileSync(new URL('PROFILE.json', packageUrl), 'utf8'));

test('the packaged readers\' authority claim names the TEST- label and the bound TP-1 token and excludes operator-supplied callbacks', () => {
  // The host and createSellerAgent check agreementAnchor and artifactAnchor only
  // by shape (host.mjs:33-81, seller-agent.mjs:148,178), and the wallet journal's
  // broadcast is the operator's own callback (payment-evidence-wallet-journal.mjs).
  // A blanket claim that the kit cannot reach a real Demos node is therefore false.
  assert.doesNotMatch(readme, /cannot start against, or read from, a real Demos node/);
  assert.match(readme, /native DEM delivery capability and the DEM delivery context accept a fixture\s+`TEST-` authority, or a TP-1 token admitted for the composition's own binding/);
  assert.match(readme, /createNativePaymentEvidenceConsumer` accepts only a literal `127\.0\.0\.1` RPC\s+origin/);
  assert.match(readme, /`agreementAnchor` and `artifactAnchor` only by shape/);
  assert.match(readme, /`broadcast` is the operator's own callback/);
});

test('the README and ADMISSION.md warn operators that a buyer with several enrollment entries for the seller and Listing is refused until re-enrollment is supported', () => {
  const admission = readFileSync(new URL('ADMISSION.md', packageUrl), 'utf8');
  for (const text of [readme, admission]) {
    assert.match(text, /A buyer with more than one enrollment entry for this seller\s+and Listing, for example a revoked\s+entry and a later re-enrollment, is refused; re-enrollment is planned for a later release\./);
  }
});

test('the required-capability bullet does not claim the host cannot start against a real node', () => {
  assert.doesNotMatch(readme, /so the host does not start against a real node/);
  const bullet = readme.match(/It starts only with the whole chain to delivery:[\s\S]*?\n- It signs no completed DACS-5 bundle/)?.[0] ?? '';
  assert.match(bullet, /accept a `TEST-` authority or a bound TP-1 token, and native payment\s+evidence only a loopback fixture node\./);
  assert.match(bullet, /`agreementAnchor` and `artifactAnchor` only by shape/);
  assert.match(bullet, /`broadcast`\s+is the operator's own callback/);
});

test('the absence proof is a contract for an operator-supplied anchor, and the package anchor needs the Node wallet source', () => {
  // createDevnetDemoArtifactAnchor accepts only the source capability the
  // client registered (devnet-source.mjs re-exports the client's check).
  assert.doesNotMatch(readme, /The package's devnet artifact anchor returns it from `read`/);
  assert.match(readme, /An operator-supplied `artifactAnchor` must return it from `read`/);
  assert.match(readme, /createDevnetDemoArtifactAnchor[\s\S]{0,300}is constructed only with the source capability/);
  assert.match(readme, /src\/dacs\/devnet-source\.mjs/);
});

test('the runtime requirement matches the repository engines and the sqlite module the code imports', () => {
  // The durable stores import better-sqlite3 (seller-durable-state.mjs:10,
  // seller-transport-auth.mjs:8, payment-evidence-wallet-journal.mjs:85,
  // party-vet-store.mjs:21), not node:sqlite.
  assert.ok(readme.includes(rootPackage.engines.node), `the README states the engines range ${rootPackage.engines.node}`);
  assert.doesNotMatch(readme, /node:sqlite/);
  assert.match(readme, /better-sqlite3/);
});

test('the README does not claim the host checks the data directory ancestors', () => {
  // host.mjs:40-46 and seller-durable-state.mjs:214 check the data directory
  // only. party-vet-store.mjs:145 and payment-evidence-wallet-journal.mjs:184
  // walk the ancestors of their own paths; neither is composed by the host.
  assert.doesNotMatch(readme, /check every ancestor of the data directory/);
  assert.doesNotMatch(readme, /does not start where `\/` belongs to another user/);
  assert.match(readme, /party\s+Vet store requires each ancestor to be owned by root or by this user/);
  assert.match(readme, /wallet journal refuses a non-sticky ancestor that others can write/);
  assert.match(readme, /host\s+checks only the data directory itself/);
});

test('the inline payload bound matches the storage CREATE cap the host enforces', () => {
  // seller-agent.mjs:197 refuses a native Listing whose expectedSizeBytes
  // exceeds MAX_STORAGE_ARTIFACT_BYTES (wallet-transactions.mjs:15), and
  // prepareDelivery applies the same bound to the produced report.
  const source = readFileSync(new URL('src/dacs/wallet-transactions.mjs', packageUrl), 'utf8');
  const max = Number(source.match(/export const MAX_STORAGE_ARTIFACT_BYTES = ([\d_]+)/)[1].replaceAll('_', ''));
  assert.ok(readme.includes(`must not exceed ${max} bytes`), `the README states the ${max}-byte storage CREATE bound`);
  assert.doesNotMatch(readme, /must not exceed 131072 bytes/);
});

test('the host option example documents every option the host accepts', () => {
  // host.mjs:33-35 is the authority for the accepted option names.
  const hostSource = readFileSync(new URL('src/host.mjs', packageUrl), 'utf8');
  const list = (name) => JSON.parse(hostSource.match(new RegExp(`const ${name} = Object\\.freeze\\((\\[[^\\]]*\\])\\)`))[1].replace(/'/g, '"'));
  const start = readme.indexOf('const host = await startSellerHost({');
  const block = readme.slice(start, readme.indexOf('```', start));
  for (const name of [...list('REQUIRED'), ...list('OPTIONAL')]) {
    assert.match(block, new RegExp(`\\b${name}\\b`), `the README option example documents ${name}`);
  }
});

test('the sessionAdmission option states the exact PROFILE.json revision and tuple', () => {
  // session-admission.mjs compares each participant's standardRevision and
  // documentVersions with SELLER_PROFILE, which PROFILE.json pins.
  const block = readme.slice(readme.indexOf('sessionAdmission,'));
  assert.match(block, /PROFILE\.json/);
  assert.ok(block.includes(profile.standardRevision), 'the README states the pinned standardRevision');
  for (const [document, version] of Object.entries(profile.documentVersions)) {
    assert.match(block, new RegExp(`${document.replace('-', '-')} ${version.replace('.', '\\.')}`), `the README states ${document} ${version}`);
  }
});
