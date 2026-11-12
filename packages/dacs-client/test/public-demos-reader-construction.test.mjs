// The public Demos reader exists only for testnet with a usable pinned chain identity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OperationError } from '../src/client-errors.mjs';
import { fakeNode, TESTNET_IDENTITY } from './helpers/public-demos-reader-node.mjs';

const refused = (error) => error instanceof OperationError && error.code === 'invalid_configuration';

for (const [name, options] of [['missing', { pinnedIdentity: undefined }], ['null', { pinnedIdentity: null }], ['empty', { pinnedIdentity: '' }],
  ['short hex', { pinnedIdentity: 'e'.repeat(63) }], ['non-hex', { pinnedIdentity: 'g'.repeat(64) }], ['number', { pinnedIdentity: 7 }],
  ['object', { pinnedIdentity: { identity: TESTNET_IDENTITY } }]]) {
  test(`construction without a usable pinned identity throws before any request (${name})`, () => {
    const node = fakeNode();
    assert.throws(() => node.reader(options), refused);
    assert.deepEqual(node.requests, []);
  });
}

for (const network of [undefined, null, 'mainnet', 'demos-testnet', 'TESTNET', 'devnet']) {
  test(`construction for a network other than testnet throws (${String(network)})`, () => {
    const node = fakeNode();
    assert.throws(() => node.reader({ network }), refused);
    assert.deepEqual(node.requests, []);
  });
}

test('construction with testnet and a 0x-prefixed identity keeps the bare lowercase pin and sends nothing', () => {
  const node = fakeNode();
  const reader = node.reader({ pinnedIdentity: '0x' + TESTNET_IDENTITY.toUpperCase() });
  assert.equal(reader.pinnedIdentity, TESTNET_IDENTITY);
  assert.equal(reader.network, 'testnet');
  assert.deepEqual(node.requests, []);
});
