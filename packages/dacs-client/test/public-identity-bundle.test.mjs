// The buyer identity-presentation builder and the Demos address normalizer on the client's public root: the same
// functions the buyer protocol uses, reached from the checkout and from a packed archive installed outside it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installPackedPair } from './helpers/packed-install.mjs';
import { bootstrapThroughChallenge, bootstrapWorld } from './helpers/kit-bootstrap-world.mjs';

// Client source loads after the admission hook the bootstrap world installs.
const client = await import('@kynesyslabs/dacs-client');
const { buildUnsignedIdentityBundle: internalBuilder } = await import('../src/dacs/listing.mjs');
const { normalizeDemosAddress: internalNormalizer } = await import('../src/signatures.mjs');

const PRESENTATION_PREFIX = 'dacs-bundle-presentation:v1:';
const ADDRESS = '0x' + 'ab'.repeat(32);
const OTHER_ADDRESS = '0x' + 'cd'.repeat(32);
const PRESENTED_AT = 1_700_000_000_000;
const NONCE = 'e'.repeat(64);
const INPUTS = { address: ADDRESS, presentedAt: PRESENTED_AT, sessionNonce: NONCE };
const ADDRESS_FORMS = ['0x' + 'aB'.repeat(32), 'ab'.repeat(32), '  0x' + 'ab'.repeat(32) + '\n', '0X' + 'CD'.repeat(32)];
const MALFORMED_ADDRESSES = [42, null, '0x' + 'ab'.repeat(31), '0x' + 'zz'.repeat(32)];

let installed;
const cleanups = [];
test.before(() => { installed = installPackedPair({ after: (cleanup) => cleanups.push(cleanup) }); });
test.after(() => { for (const cleanup of cleanups) cleanup(); });

// Runs `body` as a module in the installed app and returns what it prints as JSON.
function runInstalled(name, body) {
  const { app, run } = installed;
  writeFileSync(join(app, name), `
    import assert from 'node:assert/strict';
    assert.match(import.meta.resolve('@kynesyslabs/dacs-client'), /\\/node_modules\\/@kynesyslabs\\/dacs-client\\//, 'the package is the installed copy');
    const client = await import('@kynesyslabs/dacs-client');
    ${body}
    assert.equal(process.moduleLoadList.includes('NativeModule sqlite'), false, 'SQLite was never loaded');
  `);
  return JSON.parse(run(process.execPath, [name], app));
}

test('the packed client root exports the buyer identity builder without an internal-path import', () => {
  const result = runInstalled('identity-builder.mjs', `
    assert.equal(typeof client.buildUnsignedIdentityBundle, 'function');
    await assert.rejects(import('@kynesyslabs/dacs-client/src/dacs/listing.mjs'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    process.stdout.write(JSON.stringify(client.buildUnsignedIdentityBundle(${JSON.stringify(INPUTS)})));
  `);
  assert.deepEqual(result, internalBuilder(INPUTS));
  assert.ok(result.message.startsWith(PRESENTATION_PREFIX));
});

test('the public identity builder reproduces the saved buyer presentation bundle hash and wallet message byte for byte', async (t) => {
  const w = await bootstrapWorld(t), purchase = w.purchase();
  const { presentation } = await bootstrapThroughChallenge(w, purchase);
  const saved = purchase.get();
  const { identity } = saved.state.protocol;
  assert.equal(presentation.message, identity.message, 'the wallet was asked to sign the saved message');
  const rebuilt = client.buildUnsignedIdentityBundle({ address: saved.terms.buyer.wallet, presentedAt: identity.bundle.presentedAt, sessionNonce: identity.bundle.sessionNonce });
  assert.deepEqual(rebuilt.bundle, identity.bundle);
  assert.equal(rebuilt.bundleHash, identity.bundleHash);
  assert.deepEqual(Buffer.from(rebuilt.message, 'utf8'), Buffer.from(identity.message, 'utf8'));
  assert.deepEqual(Buffer.from(rebuilt.message, 'utf8'), Buffer.from(PRESENTATION_PREFIX + identity.bundleHash, 'utf8'));
});

test('changing the buyer address presentation time or seller nonce changes the public presentation message', () => {
  const base = client.buildUnsignedIdentityBundle(INPUTS);
  const variants = { address: OTHER_ADDRESS, presentedAt: PRESENTED_AT + 1, sessionNonce: 'f'.repeat(64) };
  for (const [input, value] of Object.entries(variants)) {
    const changed = client.buildUnsignedIdentityBundle({ ...INPUTS, [input]: value });
    assert.notEqual(changed.message, base.message, input);
    assert.notEqual(changed.bundleHash, base.bundleHash, input);
  }
  const otherBuyer = client.buildUnsignedIdentityBundle({ ...INPUTS, address: OTHER_ADDRESS }).bundle;
  assert.notEqual(otherBuyer.presentedBy, base.bundle.presentedBy);
  assert.notEqual(otherBuyer.claims[0].ref, base.bundle.claims[0].ref);
  assert.equal(otherBuyer.claims[0].ref, otherBuyer.presentedBy);
});

test('the public identity builder refuses a missing or malformed seller nonce before returning a message', () => {
  for (const sessionNonce of [undefined, NONCE.toUpperCase(), NONCE.slice(1), NONCE + 'e', 7, Buffer.from(NONCE)]) {
    assert.throws(() => client.buildUnsignedIdentityBundle({ ...INPUTS, sessionNonce }),
      { name: 'TypeError', message: /^the session nonce must be the seller challenge nonce/ }, String(sessionNonce));
  }
});

test('the packed client root exports the public address normalizer unchanged', () => {
  const result = runInstalled('address-normalizer.mjs', `
    const own = await import(new URL('./signatures.mjs', import.meta.resolve('@kynesyslabs/dacs-client')));
    assert.equal(client.normalizeDemosAddress, own.normalizeDemosAddress, 'the root export is the installed signatures module normalizer');
    const refusals = ${JSON.stringify(MALFORMED_ADDRESSES)}.map((value) => {
      try { client.normalizeDemosAddress(value); return 'accepted'; }
      catch (error) { return error instanceof client.WalletFormatError ? 'WalletFormatError' : error.name; }
    });
    process.stdout.write(JSON.stringify({ outputs: ${JSON.stringify(ADDRESS_FORMS)}.map(client.normalizeDemosAddress), refusals }));
  `);
  assert.deepEqual(result.outputs, ADDRESS_FORMS.map(internalNormalizer));
  assert.deepEqual(result.outputs, [ADDRESS, ADDRESS, ADDRESS, OTHER_ADDRESS]);
  assert.deepEqual(result.refusals, MALFORMED_ADDRESSES.map(() => 'WalletFormatError'));
});
