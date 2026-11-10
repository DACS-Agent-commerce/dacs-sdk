// Each of the nine reads checks the pinned chain identity before its first answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OperationError } from '../src/client-errors.mjs';
import { OutboundError } from '../src/util/http.mjs';
import { fakeNode, jsonResponse, nodeAnswer, OTHER_IDENTITY, TESTNET_IDENTITY } from './helpers/public-demos-reader-node.mjs';

const WALLET = '0x' + 'a'.repeat(64), HASH = '1'.repeat(64), LOCATOR = 'stor-' + 'b'.repeat(40);
const SIMULATED = { 'x-dacs-simulation': 'fixture' };

// Each read with its arguments, and the node answers its own requests get.
const READS = {
  readStorageProgram: { args: [LOCATOR], request: `GET /storage-program/${LOCATOR}` },
  getAddressBalance: { args: [WALLET], request: 'getAddressInfo' },
  getTransactionFees: { args: [], request: 'getNetworkParameters' },
  networkIdentity: { args: [], request: null },
  getAddressNonce: { args: [WALLET], request: 'getAddressNonce' },
  observePurchaseTransfer: { args: [HASH], request: 'getTransactionStatus' },
  observeTransfer: { args: [HASH], request: 'getTransactionStatus' },
  getTransaction: { args: [HASH], request: 'getTxByHash' },
  findTransferAtNonce: { args: [WALLET, 7], request: 'getTransactionHistory' },
};
function readAnswers({ message, path }) {
  if (path) return jsonResponse({ success: true, data: { title: 'TEST' }, owner: WALLET, programName: 'TEST' });
  return { getAddressInfo: { balance: '5' }, getNetworkParameters: { networkFee: 1, rpcFee: 1 }, getAddressNonce: 3,
    getTransactionStatus: { state: 'pending' }, getTxByHash: { hash: HASH, status: 'confirmed' }, getTransactionHistory: [] }[message];
}
const mismatch = (error) => error instanceof OperationError && error.code === 'network_identity_mismatch';

for (const [name, { args, request }] of Object.entries(READS)) {
  test(`${name} makes a fresh identity read before its first request, and none before a later one`, async () => {
    const node = fakeNode({ answer: readAnswers });
    const reader = node.reader();
    await reader[name](...args);
    assert.deepEqual(node.requests, ['getBlockByNumber', ...(request ? [request] : [])]);
    node.requests.length = 0;
    await reader[name](...args);
    assert.deepEqual(node.requests, [request ?? 'getBlockByNumber'], 'only networkIdentity reads the identity again');
  });

  test(`${name} refuses a mismatched chain with network_identity_mismatch before its own request`, async () => {
    const node = fakeNode({ genesis: OTHER_IDENTITY, answer: readAnswers });
    await assert.rejects(node.reader()[name](...args), (error) => mismatch(error) && error.details.observed === OTHER_IDENTITY && error.details.pinned === TESTNET_IDENTITY);
    assert.deepEqual(node.requests, ['getBlockByNumber']);
  });

  test(`${name} refuses a simulated loopback chain before its own request`, async () => {
    const node = fakeNode({ answer: (call) => (call.data?.blockNumber === 0 ? nodeAnswer({ number: 0, hash: TESTNET_IDENTITY }, SIMULATED) : readAnswers(call)) });
    await assert.rejects(node.reader({ rpcUrl: 'http://127.0.0.1:8545' })[name](...args), mismatch);
    assert.deepEqual(node.requests, ['getBlockByNumber']);
  });

  test(`${name} refuses a public RPC that marks its answers simulated, before its own request`, async () => {
    const node = fakeNode({ answer: (call) => (call.data?.blockNumber === 0 ? nodeAnswer({ number: 0, hash: TESTNET_IDENTITY }, SIMULATED) : readAnswers(call)) });
    await assert.rejects(node.reader()[name](...args), mismatch);
    assert.deepEqual(node.requests, ['getBlockByNumber']);
  });

  test(`${name} refuses a chain that reports no identity, keeping the reader's invalid error and sending no request of its own`, async () => {
    const node = fakeNode({ answer: (call) => (call.message === 'getBlockByNumber' ? null : readAnswers(call)) });
    await assert.rejects(node.reader()[name](...args), (error) => error instanceof OutboundError && error.kind === 'invalid');
    assert.deepEqual(node.requests, ['getBlockByNumber', 'getBlockByNumber']);
  });
}

test('concurrent first reads do not share a failed identity check', async () => {
  let identityReads = 0;
  const node = fakeNode({ answer: (call) => {
    if (call.data?.blockNumber === 0) return { number: 0, status: 'confirmed', hash: ++identityReads === 1 ? OTHER_IDENTITY : TESTNET_IDENTITY };
    return readAnswers(call);
  } });
  const reader = node.reader();
  const [first, second] = await Promise.allSettled([reader.getAddressNonce(WALLET), reader.getAddressNonce(WALLET)]);
  assert.ok(mismatch(first.reason), 'the first check saw the other chain');
  assert.deepEqual(second, { status: 'fulfilled', value: 3 }, 'the second read made its own check');
  assert.equal(identityReads, 2);
});

test('a failed identity check is not remembered: the next read checks again', async () => {
  let genesis = OTHER_IDENTITY;
  const node = fakeNode({ answer: (call) => (call.data?.blockNumber === 0 ? { number: 0, status: 'confirmed', hash: genesis } : readAnswers(call)) });
  const reader = node.reader();
  await assert.rejects(reader.getAddressNonce(WALLET), mismatch);
  genesis = TESTNET_IDENTITY;
  assert.equal(await reader.getAddressNonce(WALLET), 3);
  assert.deepEqual(node.requests, ['getBlockByNumber', 'getBlockByNumber', 'getAddressNonce']);
});

test('networkIdentity observes afresh on every call and a later mismatch makes the next read check again', async () => {
  let genesis = TESTNET_IDENTITY;
  const node = fakeNode({ answer: (call) => (call.data?.blockNumber === 0 ? { number: 0, status: 'confirmed', hash: genesis } : readAnswers(call)) });
  const reader = node.reader();
  assert.deepEqual(await reader.networkIdentity(), { mode: 'public-chain-read', identity: TESTNET_IDENTITY });
  genesis = OTHER_IDENTITY;
  await assert.rejects(reader.networkIdentity(), mismatch);
  node.requests.length = 0;
  await assert.rejects(reader.getAddressNonce(WALLET), mismatch);
  assert.deepEqual(node.requests, ['getBlockByNumber']);
});
