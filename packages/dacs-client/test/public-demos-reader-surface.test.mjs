// The public Demos reader is a closed, read-only object: nine reads and five metadata fields.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeNode, jsonResponse, TESTNET_IDENTITY, RPC_URL } from './helpers/public-demos-reader-node.mjs';

const READ_NAMES = ['readStorageProgram', 'getAddressBalance', 'getTransactionFees', 'networkIdentity', 'getAddressNonce',
  'observePurchaseTransfer', 'observeTransfer', 'getTransaction', 'findTransferAtNonce'];
const METADATA = ['network', 'pinnedIdentity', 'rpcOrigin', 'observer', 'evidenceMode'];
const FORBIDDEN = ['getIdentities', 'observePassiveTransfer', 'raw', 'inner', 'request', 'fetch', 'fetchImpl', 'rpc', 'readRpc', 'chainReader',
  'broadcastTransaction', 'broadcast', 'sign', 'signer', 'signTransaction', 'wallet', 'transport', 'capability', 'journal', 'reader'];
const WALLET = '0x' + 'a'.repeat(64), HASH = '1'.repeat(64);

test('the reader\'s own keys are exactly the nine reads and five metadata fields, with no symbols', () => {
  const reader = fakeNode().reader();
  assert.deepEqual(Object.keys(reader).sort(), [...READ_NAMES, ...METADATA].sort());
  assert.deepEqual(Reflect.ownKeys(reader).sort(), [...READ_NAMES, ...METADATA].sort());
  for (const name of READ_NAMES) assert.equal(typeof reader[name], 'function', name);
});

test('the reader is frozen and inherits only from Object.prototype', () => {
  const reader = fakeNode().reader();
  assert.ok(Object.isFrozen(reader));
  assert.equal(Object.getPrototypeOf(reader), Object.prototype);
  for (const name of FORBIDDEN) assert.equal(name in reader, false, name);
});

test('the metadata is inert text: evidenceMode is the only getter and it returns text', () => {
  const reader = fakeNode().reader();
  const descriptors = Object.getOwnPropertyDescriptors(reader);
  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (name === 'evidenceMode') {
      assert.equal(typeof descriptor.get, 'function');
      assert.equal(descriptor.set, undefined);
    } else assert.ok(Object.hasOwn(descriptor, 'value'), `${name} is a data field`);
  }
  assert.deepEqual(Object.fromEntries(METADATA.map((name) => [name, typeof reader[name]])), Object.fromEntries(METADATA.map((name) => [name, 'string'])));
  assert.equal(reader.pinnedIdentity, TESTNET_IDENTITY);
  assert.equal(reader.rpcOrigin, new URL(RPC_URL).origin);
  assert.equal(reader.evidenceMode, 'public-chain-read');
});

test('each read is a plain function carrying no extra properties', () => {
  const reader = fakeNode().reader();
  for (const name of READ_NAMES) {
    const own = Reflect.ownKeys(reader[name]).filter((key) => !['length', 'name', 'prototype'].includes(key));
    assert.deepEqual(own, [], name);
  }
});

// Throws if any function is reachable from `value`.
function assertNoFunction(value, path) {
  assert.notEqual(typeof value, 'function', path);
  if (value !== null && typeof value === 'object') {
    for (const key of Reflect.ownKeys(value)) assertNoFunction(value[key], `${path}.${String(key)}`);
  }
}

test('the values each read returns hold data only, with no function, signer or transport', async () => {
  const included = { state: 'included', blockNumber: 7 };
  const node = fakeNode({ answer: ({ message, data, path }) => {
    if (path) return jsonResponse({ success: true, data: { title: 'TEST' }, owner: WALLET, programName: 'TEST' });
    if (message === 'getBlockByNumber' && data.blockNumber === 7) return { number: 7, status: 'confirmed', content: { ordered_transactions: [HASH], timestamp: 1_900_000_000 } };
    return { getAddressInfo: { balance: '5' }, getNetworkParameters: { networkFee: 1, rpcFee: 1 }, getAddressNonce: 3, getTransactionStatus: included,
      getTxByHash: { hash: HASH, status: 'confirmed', blockNumber: 7, content: { type: 'native', from: WALLET, from_ed25519_address: WALLET, to: WALLET, amount: 1, nonce: 3,
        data: ['native', { nativeOperation: 'send', args: [WALLET, '1'] }] } },
      getTransactionHistory: [] }[message];
  } });
  const reader = node.reader();
  const calls = { readStorageProgram: ['stor-' + 'b'.repeat(40)], getAddressBalance: [WALLET], getTransactionFees: [], networkIdentity: [], getAddressNonce: [WALLET],
    observePurchaseTransfer: [HASH], observeTransfer: [HASH], getTransaction: [HASH], findTransferAtNonce: [WALLET, 3] };
  for (const name of READ_NAMES) assertNoFunction(await reader[name](...calls[name]), name);
  assert.equal((await reader.observeTransfer(HASH)).status, 'included', 'the observation answer was a full included transfer');
});
