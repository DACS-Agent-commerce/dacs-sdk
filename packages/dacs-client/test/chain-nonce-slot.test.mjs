import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemosChainReader } from '../src/dacs/chain.mjs';
import { WalletFormatError } from '../src/signatures.mjs';

const WALLET = `0x${'a'.repeat(64)}`;
const OTHER = `0x${'5'.repeat(64)}`;
const ALT = `0x${'c'.repeat(64)}`;
// A history row as the node serves it: confirmed or failed, a bare 64-hex hash, a block number, content.nonce, and (as the
// SDK's sign() writes it for another key) `from` the signing key and `from_ed25519_address` the account.
const tx = (nonce, { signer = WALLET, payer = signer, status = 'confirmed', text = false } = {}) => ({
  hash: `${signer === WALLET ? 'a' : 'c'}${String(nonce).padStart(61, '0')}${status === 'failed' ? 'ff' : '00'}`, status, blockNumber: 10,
  content: { from: signer, from_ed25519_address: payer, nonce: text ? String(nonce) : nonce, to: OTHER, type: 'native' } });
const withContent = (row, fields) => ({ ...row, content: { ...row.content, ...fields } });
// The node lists every row whose `from` or `to` is the address, so a row that only pays the wallet is in its history too.
const inbound = (nonce) => withContent(tx(nonce, { signer: OTHER }), { to: WALLET });
// A sender whose payer the package cannot read (a post-quantum key, no owner field).
const unreadablePayer = (nonce, status = 'confirmed') => ({ hash: 'f'.repeat(64), status, blockNumber: 10, content: { from: `0x${'d'.repeat(2624)}`, nonce: String(nonce), to: WALLET, type: 'native' } });

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// The node: the history it serves. The reader asks for nothing else, so any other call is an error.
function reader(history, { requests = [], respond = () => json({ result: 200, response: history }) } = {}) {
  return createDemosChainReader({
    rpcUrl: 'https://rpc.invalid', network: 'test',
    fetchImpl: async (input, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      assert.equal(body.params[0].message, 'getTransactionHistory');
      return respond();
    },
  });
}
const read = (history, nonce = 7, options) => reader(history).findTransferAtNonce(WALLET, nonce, options);
const unknown = { status: 'unknown' };
const found = (row) => ({ status: 'found', hash: row.hash });

test('nonce slot: the wallet\'s own transaction at the nonce is found, and the one request names the address and the default page', async () => {
  const requests = [];
  assert.deepEqual(await reader([tx(9), tx(7), tx(6)], { requests }).findTransferAtNonce(WALLET, 7), found(tx(7)));
  assert.deepEqual(requests, [{ method: 'nodeCall', params: [{ message: 'getTransactionHistory', data: { address: WALLET, type: 'all', start: 0, limit: 100 } }] }]);
});

test('nonce slot: the caller\'s page size is the only request\'s limit', async () => {
  const requests = [];
  assert.deepEqual(await reader([tx(7), tx(6)], { requests }).findTransferAtNonce(WALLET, 7, { limit: 2 }), found(tx(7)));
  assert.deepEqual(requests.map((body) => body.params[0].data.limit), [2]);
});

test('nonce slot: the node\'s decimal-text nonce is read like a number', async () => {
  const text = (n) => tx(n, { text: true });
  assert.deepEqual(await read([text(9), text(7), text(6)]), found(tx(7)));
});

test('nonce slot: a page with no row at the nonce is unknown, whatever lower or higher rows it holds or where the page is cut', async () => {
  for (const history of [[], [tx(9), tx(6)], [tx(9)], [tx(8), tx(6)], [tx(9), tx(8), tx(6)]]) assert.deepEqual(await read(history), unknown, JSON.stringify(history.map((row) => row.content.nonce)));
  assert.deepEqual(await read([tx(9), tx(8)], 7, { limit: 2 }), unknown, 'the cut falls between the lower row and the slot\'s');
});

test('nonce slot: a history that is not a list, or is longer than the page, is refused', async () => {
  for (const history of [{ not: 'a list' }, null, 'rows']) await assert.rejects(read(history), (error) => error.kind === 'invalid', JSON.stringify(history));
  await assert.rejects(read([tx(9), tx(8), tx(6)], 7, { limit: 2 }), (error) => error.kind === 'invalid');
});

test('nonce slot: a nonce that is not a non-negative safe integer, or a page size outside 1 to 100, is refused before any request', async () => {
  const requests = [];
  const slot = reader([], { requests });
  for (const limit of [null, 0, -1, 101, 1.5, '5', NaN]) await assert.rejects(slot.findTransferAtNonce(WALLET, 7, { limit }), (error) => error.kind === 'invalid', String(limit));
  for (const nonce of [-1, 1.5, 2 ** 53, '7', NaN, Infinity, undefined]) await assert.rejects(slot.findTransferAtNonce(WALLET, nonce), (error) => error.kind === 'invalid', String(nonce));
  assert.deepEqual(requests, []);
});

test('nonce slot: a malformed address throws WalletFormatError before any request', async () => {
  const requests = [];
  const slot = reader([], { requests });
  for (const address of [undefined, 'zzz', `0x${'a'.repeat(63)}`]) await assert.rejects(slot.findTransferAtNonce(address, 7), WalletFormatError, String(address));
  assert.deepEqual(requests, []);
});

test('nonce slot: an already aborted signal rejects with its reason and makes no request', async () => {
  const requests = [];
  const controller = new AbortController();
  controller.abort(new Error('caller cancelled'));
  await assert.rejects(reader([tx(7)], { requests }).findTransferAtNonce(WALLET, 7, { signal: controller.signal }), /caller cancelled/);
  assert.deepEqual(requests, []);
});

test('nonce slot: a transport error keeps its own kind', async () => {
  for (const [respond, kind] of [[() => json({}, 404), 'not-found'], [() => json({}, 503), 'unavailable'], [() => json({ result: 500, response: [] }), 'unavailable']]) {
    await assert.rejects(reader([], { respond }).findTransferAtNonce(WALLET, 7), (error) => error.kind === kind, kind);
  }
});

test('nonce slot: another sender\'s row with the same nonce is not the wallet\'s', async () => {
  assert.deepEqual(await read([tx(9), tx(7, { signer: OTHER }), tx(6)]), unknown);
});

test('nonce slot: a readable other payer\'s row with a bad hash, no block number or the slot\'s nonce is skipped, with no order or target', async () => {
  const other = tx(12, { signer: OTHER });
  for (const row of [{ ...other, hash: '' }, { ...other, hash: undefined }, { ...other, blockNumber: undefined }, withContent(other, { nonce: '07' }), tx(7, { signer: OTHER })]) {
    assert.deepEqual(await read([tx(9), row, tx(7), tx(6)]), found(tx(7)), JSON.stringify(row));
  }
});

test('nonce slot: a row that only pays the wallet is never the wallet\'s: not the slot\'s, and its nonce is no order to check', async () => {
  assert.deepEqual(await read([inbound(12), tx(9), inbound(7), tx(6), inbound(2)]), unknown);
  assert.deepEqual(await read([inbound(7), tx(7), inbound(12), tx(6)]), found(tx(7)));
  assert.deepEqual(await read([tx(9), inbound(8), inbound(10), tx(7), tx(6)]), found(tx(7)));
});

test('nonce slot: a row whose status or content cannot be read makes the slot unknown', async () => {
  for (const status of [undefined, 'pending', 'reverted', 'Confirmed']) assert.deepEqual(await read([tx(9), { ...tx(7), status }, tx(6)]), unknown, String(status));
  for (const row of [null, 'row', 7, { ...tx(12, { signer: OTHER }), content: JSON.stringify(tx(7).content) }, { ...tx(7), content: [] }]) {
    assert.deepEqual(await read([tx(9), row, tx(7), tx(6)]), unknown, JSON.stringify(row));
  }
});

test('nonce slot: the wallet\'s own confirmed row with an unreadable nonce makes the slot unknown', async () => {
  for (const nonce of ['07', '7.0', '-1', '1e1', '', ' 7', null, undefined, 7.5, '9007199254740993']) {
    assert.deepEqual(await read([tx(9), withContent(tx(7), { nonce }), tx(6)]), unknown, String(nonce));
  }
});

// An unsafe block number such as 2 ** 53 never reaches the row: the RPC's JSON admission (util/http.mjs) refuses it as invalid.
test('nonce slot: the wallet\'s own confirmed row needs a non-negative safe integer block number', async () => {
  for (const blockNumber of [undefined, null, -1, 1.5, '10']) assert.deepEqual(await read([tx(9), { ...tx(7), blockNumber }, tx(6)]), unknown, String(blockNumber));
  assert.deepEqual(await read([tx(9), { ...tx(7), blockNumber: 0 }, tx(6)]), found(tx(7)));
  await assert.rejects(read([tx(9), { ...tx(7), blockNumber: 2 ** 53 }, tx(6)]), (error) => error.kind === 'invalid');
});

test('nonce slot: the wallet\'s own confirmed row needs a bare lowercase 64-hex hash', async () => {
  const hex = '0123456789abcdef'.repeat(4);
  for (const hash of [undefined, null, 7, '', '   ', 'z'.repeat(64), hex.toUpperCase(), hex.slice(1), `${hex}0`, `0x${hex}`, ` ${hex}`]) {
    assert.deepEqual(await read([tx(9), { ...tx(7), hash }, tx(6)]), unknown, String(hash));
  }
  assert.deepEqual(await read([tx(9), { ...tx(7), hash: hex }, tx(6)]), { status: 'found', hash: hex });
});

// The package reads the payer as observePayDemTransferCore does: from_ed25519_address when present, else from.
// Whether a payment signed by another key charged the wallet's nonce is not read here, so as a precaution it never counts.
test('nonce slot: a confirmed payment for the wallet signed by another key makes the slot unknown, wherever it is', async () => {
  const alt = (nonce) => tx(nonce, { signer: ALT, payer: WALLET });
  assert.deepEqual(await read([tx(9), alt(7), tx(6)]), unknown, 'alone at the slot');
  assert.deepEqual(await read([tx(9), alt(7), tx(7), tx(6)]), unknown, 'beside the slot\'s own row');
  assert.deepEqual(await read([tx(9), alt(8), tx(7), tx(6)]), unknown, 'off the slot');
  assert.deepEqual(await read([tx(9), alt(8), alt(7), tx(6)]), unknown, 'two of them');
});

test('nonce slot: a confirmed row the wallet pays whose signing key is missing or unreadable makes the slot unknown', async () => {
  for (const from of [undefined, null, 7, 'zzz']) assert.deepEqual(await read([tx(9), withContent(tx(7), { from }), tx(6)]), unknown, String(from));
});

test('nonce slot: a payer field that is present but unreadable is not replaced by from', async () => {
  assert.deepEqual(await read([tx(9), tx(7, { signer: WALLET, payer: null }), tx(6)]), unknown);
});

// Known fail-closed trade-off: a row whose payer cannot be read may be the wallet's, so anyone who pays the wallet from
// such a key keeps every slot on that page unknown.
test('nonce slot: fail-closed trade-off: an unreadable payer anywhere on the page makes the slot unknown beside a valid own row', async () => {
  assert.deepEqual(await read([tx(9), tx(7), tx(6)]), found(tx(7)), 'control');
  for (const at of [0, 2, 4]) {
    const history = [tx(9), tx(7), tx(6), tx(5)];
    history.splice(at, 0, unreadablePayer(3));
    assert.deepEqual(await read(history), unknown, String(at));
  }
});

test('nonce slot: a failed row is skipped before anything else in it is read and never blocks the slot\'s own row', async () => {
  const failed = tx(7, { status: 'failed' });
  for (const row of [failed, withContent(failed, { nonce: '07' }), unreadablePayer(7, 'failed'), { ...failed, hash: ' ' }, { ...failed, content: null }, tx(7, { signer: ALT, payer: WALLET, status: 'failed' }), tx(57, { status: 'failed' })]) {
    assert.deepEqual(await read([row, tx(9), tx(7), tx(6)]), found(tx(7)), JSON.stringify(row));
    assert.deepEqual(await read([tx(9), tx(7), row, tx(6)]), found(tx(7)), JSON.stringify(row));
  }
});

test('nonce slot: a failed row at the slot is never proof', async () => {
  assert.deepEqual(await read([tx(9), tx(7, { status: 'failed' }), tx(6)]), unknown);
});

// Live shapes (testnet, 2026-10-31): the page is ordered by signed timestamp, not nonce, so the two orders can disagree.
test('nonce slot: own rows not newest first by nonce make the slot unknown', async () => {
  for (const history of [[tx(6), tx(7), tx(9)], [tx(9), tx(6), tx(7)], [tx(8), tx(9), tx(7)]]) assert.deepEqual(await read(history), unknown, JSON.stringify(history.map((row) => row.content.nonce)));
});

test('nonce slot: two confirmed own rows at the slot make it unknown', async () => {
  assert.deepEqual(await read([tx(9), tx(7), { ...tx(7), hash: 'b'.repeat(64) }, tx(6)]), unknown);
});
