import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemosChainReader } from '../src/dacs/chain.mjs';

const WALLET = `0x${'a'.repeat(64)}`;
const OTHER = `0x${'5'.repeat(64)}`;
const ALT = `0x${'c'.repeat(64)}`;
// A history row as the node serves it: confirmed or failed, content.nonce, and (as the SDK's sign() writes it for another key)
// `from` the signing key and `from_ed25519_address` the account.
const tx = (nonce, { signer = WALLET, payer = signer, status = 'confirmed', text = false } = {}) => ({
  hash: `${signer === WALLET ? 'a' : 'c'}${String(nonce).padStart(61, '0')}${status === 'failed' ? 'ff' : '00'}`, status, blockNumber: 10,
  content: { from: signer, from_ed25519_address: payer, nonce: text ? String(nonce) : nonce, to: OTHER, type: 'native' } });
// The node lists every row whose `from` or `to` is the address, so a row that only pays the wallet is in its history too.
const inbound = (nonce) => ({ ...tx(nonce, { signer: OTHER }), content: { ...tx(nonce, { signer: OTHER }).content, to: WALLET } });

// The node: the history it serves. The reader asks for nothing else, so any other call is an error.
function reader(history, { requests = [] } = {}) {
  return createDemosChainReader({
    rpcUrl: 'https://rpc.invalid', network: 'test',
    fetchImpl: async (input, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      assert.equal(body.params[0].message, 'getTransactionHistory');
      return new Response(JSON.stringify({ result: 200, response: history }), { headers: { 'content-type': 'application/json' } });
    },
  });
}
const read = (history, nonce = 7, options) => reader(history, options).findTransferAtNonce(WALLET, nonce, options?.limit ? { limit: options.limit } : undefined);
const unknown = { status: 'unknown' };

test('nonce slot: the wallet\'s own transaction at the nonce is found, and the request names the address', async () => {
  const requests = [];
  assert.deepEqual(await reader([tx(9), tx(7), tx(6)], { requests }).findTransferAtNonce(WALLET, 7), { status: 'found', hash: tx(7).hash });
  assert.deepEqual(requests, [{ method: 'nodeCall', params: [{ message: 'getTransactionHistory', data: { address: WALLET, type: 'all', start: 0, limit: 100 } }] }]);
});

test('nonce slot: another sender\'s transaction with the same nonce is not the wallet\'s', async () => {
  assert.deepEqual(await read([tx(9), tx(7, { signer: OTHER }), tx(6)]), unknown);
});

test('nonce slot: a page with no row at the nonce is unknown, whatever lower or higher rows it holds, and only the history is read', async () => {
  for (const history of [[tx(9), tx(6)], [tx(9)], [tx(8), tx(6)], [tx(9), tx(8), tx(6)]]) assert.deepEqual(await read(history), unknown);
  assert.deepEqual(await read([tx(9), tx(8)], 7, { limit: 2 }), unknown, 'a cut page');
});

test('nonce slot: a history that is not a list, or is longer than the page, is refused', async () => {
  await assert.rejects(read({ not: 'a list' }), (error) => error.kind === 'invalid');
  await assert.rejects(read([tx(9), tx(8), tx(6)], 7, { limit: 2 }), (error) => error.kind === 'invalid');
});

test('nonce slot: a nonce that is not a non-negative safe integer, or a page size outside 1 to 100, is refused before any request', async () => {
  const requests = [];
  const slot = reader([], { requests });
  for (const limit of [0, -1, 101, 2.5, '5', NaN]) await assert.rejects(slot.findTransferAtNonce(WALLET, 7, { limit }), (error) => error.kind === 'invalid', String(limit));
  for (const nonce of [-1, 7.5, '7', NaN, Infinity, undefined]) await assert.rejects(slot.findTransferAtNonce(WALLET, nonce), (error) => error.kind === 'invalid', String(nonce));
  assert.deepEqual(requests, []);
});

test('nonce slot: a row at the slot with no usable hash makes the slot unknown, never found without one', async () => {
  for (const hash of [undefined, '', 7, null]) assert.deepEqual(await read([tx(9), { ...tx(7), hash }, tx(6)]), unknown, String(hash));
});

test('the slot read finds the wallet\'s transaction when the node serves the nonce as decimal text', async () => {
  const text = (n, o) => tx(n, { ...o, text: true });
  assert.deepEqual(await read([text(9), text(7), text(6)]), { status: 'found', hash: tx(7).hash });
  assert.deepEqual(await read([text(9), text(6)]), unknown);
  assert.deepEqual(await read([text(9), text(8)], 7, { limit: 2 }), unknown);
});

test('an entry the reader cannot read makes the slot unknown, never found past it', async () => {
  for (const nonce of ['07', '7.0', '-1', '1e1', '', ' 7', null, undefined, 7.5, '9007199254740993']) {
    const row = { ...tx(7), content: { ...tx(7).content, nonce } };
    assert.deepEqual(await read([tx(9), row, tx(6)]), unknown, String(nonce));
  }
  for (const status of [undefined, 'pending', 'reverted', 'Confirmed']) assert.deepEqual(await read([tx(9), { ...tx(7), status }, tx(6)]), unknown, String(status));
  assert.deepEqual(await read([tx(9), { hash: 'x', status: 'confirmed', content: JSON.stringify(tx(7).content) }, tx(6)]), unknown);
  // Another sender's entry with an unreadable nonce is not the wallet's and does not block the read.
  assert.deepEqual(await read([tx(9), { ...tx(7, { signer: OTHER }), content: { ...tx(7, { signer: OTHER }).content, nonce: '07' } }, tx(7), tx(6)]), { status: 'found', hash: tx(7).hash });
});

// The package reads the payer as observePayDemTransferCore does: from_ed25519_address when present, else from.
test('a payment signed by another key for the wallet is found, and marked as signed by another key', async () => {
  const slot = await read([tx(9), tx(7, { signer: ALT, payer: WALLET }), tx(6)]);
  assert.deepEqual(slot, { status: 'found', hash: tx(7, { signer: ALT }).hash, signedByAlternateKey: true });
});

test('an entry signed by another key for the wallet, off the slot or beside the slot\'s own row, makes the slot unknown', async () => {
  assert.equal((await read([tx(9), tx(8, { signer: ALT, payer: WALLET }), tx(6)])).status, 'unknown');
  assert.equal((await read([tx(9), tx(7, { signer: ALT, payer: WALLET }), tx(7), tx(6)])).status, 'unknown');
});

test('an entry whose payer cannot be read makes the slot unknown', async () => {
  const pqc = { hash: 'f'.repeat(64), status: 'confirmed', content: { from: `0x${'d'.repeat(2624)}`, nonce: '7', to: OTHER, type: 'native' } };
  assert.equal((await read([tx(9), pqc, tx(6)])).status, 'unknown');
  // A present from_ed25519_address that is unreadable is not replaced by from.
  assert.equal((await read([tx(9), tx(7, { payer: null }), tx(6)])).status, 'unknown');
});

test('a failed transaction is never proof: never the slot\'s, and at the slot unknown unless a confirmed one is beside it', async () => {
  assert.equal((await read([tx(9), tx(7, { status: 'failed' }), tx(6)])).status, 'unknown');
  assert.equal((await read([tx(9), tx(6, { status: 'failed' })])).status, 'unknown');
  assert.deepEqual(await read([tx(9), tx(7), tx(7, { status: 'failed' }), tx(6)]), { status: 'found', hash: tx(7).hash });
});

test('a history that is not newest first, or has two confirmed rows at the slot, is unknown', async () => {
  assert.equal((await read([tx(6), tx(7), tx(9)])).status, 'unknown');
  assert.equal((await read([tx(9), tx(7), { ...tx(7), hash: 'b'.repeat(64) }, tx(6)])).status, 'unknown');
});

// Live shapes (testnet, 2026-10-31): the history lists rows where the address is `from` or `to`; a transaction with a nonce far ahead ends
// `failed`, stays in the sender's history, and leaves the account's nonce where it was; the page is ordered by signed timestamp, not nonce.
test('a row that only pays the wallet is never the wallet\'s: not the slot\'s, and its nonce is no order to check', async () => {
  assert.deepEqual(await read([inbound(12), tx(9), inbound(7), tx(6), inbound(2)]), unknown);
  assert.deepEqual(await read([inbound(7), tx(7), inbound(12), tx(6)]), { status: 'found', hash: tx(7).hash });
  assert.deepEqual(await read([tx(9), inbound(8), inbound(10), tx(7), tx(6)]), { status: 'found', hash: tx(7).hash });
});

test('a failed row far above the slot counts for nothing, wherever the page puts it', async () => {
  const far = tx(57, { status: 'failed' });
  assert.deepEqual(await read([far, tx(9), tx(7), tx(6)]), { status: 'found', hash: tx(7).hash });
  assert.deepEqual(await read([tx(9), far, tx(7), tx(6)]), { status: 'found', hash: tx(7).hash });
  assert.deepEqual(await read([far, tx(6)]), unknown);
});

test('a page ordered by signed timestamp, not nonce, is unknown wherever the two orders disagree', async () => {
  assert.equal((await read([tx(9), tx(6), tx(7)])).status, 'unknown', 'the slot\'s row was signed before a lower one');
  assert.equal((await read([tx(8), tx(9), tx(6)])).status, 'unknown');
  assert.equal((await read([tx(9), tx(8)], 7, { limit: 2 })).status, 'unknown', 'the cut falls between the lower row and the slot\'s');
});
