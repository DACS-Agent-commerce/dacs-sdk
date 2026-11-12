// Every public read keeps the client reader's own error, cause and cancellation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemosChainReader } from '../src/dacs/chain.mjs';
import { OutboundError } from '../src/util/http.mjs';
import { fakeNode, RPC_URL, TESTNET_IDENTITY } from './helpers/public-demos-reader-node.mjs';

const WALLET = '0x' + 'a'.repeat(64), HASH = '1'.repeat(64), LOCATOR = 'stor-' + 'b'.repeat(40);
const READS = {
  readStorageProgram: { args: [LOCATOR], request: `GET /storage-program/${LOCATOR}` },
  getAddressBalance: { args: [WALLET], request: 'getAddressInfo' },
  getTransactionFees: { args: [], request: 'getNetworkParameters' },
  networkIdentity: { args: [], request: 'getBlockByNumber', signal: true },
  getAddressNonce: { args: [WALLET], request: 'getAddressNonce' },
  observePurchaseTransfer: { args: [HASH], request: 'getTransactionStatus', signal: true },
  observeTransfer: { args: [HASH], request: 'getTransactionStatus', signal: true },
  getTransaction: { args: [HASH], request: 'getTxByHash', signal: true },
  findTransferAtNonce: { args: [WALLET, 7], request: 'getTransactionHistory', signal: true },
};
const requestOf = ({ message, path }) => (path ? `GET ${path}` : message);
const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
// The parts of an outcome a caller can tell apart: value, or error class, kind, status, message and cause.
const outcome = ({ value, error }) => (error ? { type: error.constructor.name, kind: error.kind, status: error.status, message: error.message, cause: error.cause } : { value });

// A node that refuses `request`. Unless that request is the identity read
// itself, the first identity read is answered so the read reaches its own request.
function refusingNode(request, cause) {
  let identityAnswered = request === 'getBlockByNumber';
  return fakeNode({ answer: (call) => {
    if (call.data?.blockNumber === 0 && !identityAnswered) { identityAnswered = true; return undefined; }
    if (requestOf(call) === request) throw cause;
    return undefined;
  } });
}

for (const [name, { args, request }] of Object.entries(READS)) {
  test(`${name} keeps the client reader's own outcome and cause when its request is refused`, async () => {
    const cause = new Error('TEST-connection-refused');
    const internalNode = refusingNode(request, cause), publicNode = refusingNode(request, cause);
    const internal = createDemosChainReader({ rpcUrl: RPC_URL, network: 'testnet', pinnedIdentity: TESTNET_IDENTITY, fetchImpl: internalNode.fetchImpl });
    if (name !== 'networkIdentity') await internal.networkIdentity();
    const expected = await settle(internal[name === 'observePurchaseTransfer' ? 'observeTransfer' : name](...args));
    const actual = await settle(publicNode.reader()[name](...args));
    assert.deepEqual(outcome(actual), outcome(expected));
  });
}

for (const name of ['getAddressNonce', 'observeTransfer', 'readStorageProgram']) {
  test(`${name} keeps the identity read's unavailable error and cause and sends no request of its own`, async () => {
    const cause = new Error('TEST-identity-read-refused');
    const node = fakeNode({ answer: (call) => { if (call.message === 'getBlockByNumber') throw cause; } });
    await assert.rejects(node.reader()[name](...READS[name].args), (error) => error instanceof OutboundError && error.kind === 'unavailable' && error.cause === cause);
    assert.deepEqual(node.requests, ['getBlockByNumber']);
  });
}

// A request that stays open until its signal aborts, then rejects with the signal's reason.
const held = (signal, onHeld) => new Promise((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  onHeld();
});

// The reads that take a caller's signal; for networkIdentity its own request is the identity read.
const CANCELLABLE = Object.entries(READS).filter(([, read]) => read.signal);

for (const [name, { args, request }] of CANCELLABLE.filter(([name]) => name !== 'networkIdentity')) {
  test(`${name} rejects with the caller's abort reason while its own request is open`, async () => {
    const controller = new AbortController(), reason = new Error('TEST-caller-abort');
    const node = fakeNode({ answer: (call) => (requestOf(call) === request ? held(call.signal, () => controller.abort(reason)) : undefined) });
    await assert.rejects(node.reader()[name](...args, { signal: controller.signal }), (error) => error === reason);
    assert.deepEqual(node.requests, ['getBlockByNumber', request]);
  });
}

for (const [name, { args }] of CANCELLABLE) {
  test(`${name} rejects with the caller's abort reason during the identity check and sends no request of its own`, async () => {
    const controller = new AbortController(), reason = new Error('TEST-caller-abort');
    const node = fakeNode({ answer: (call) => (call.message === 'getBlockByNumber' ? held(call.signal, () => controller.abort(reason)) : undefined) });
    await assert.rejects(node.reader()[name](...args, { signal: controller.signal }), (error) => error === reason);
    assert.deepEqual(node.requests, ['getBlockByNumber']);
  });
}
