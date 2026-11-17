// The native transport's pinned chain identity and pin version.
// A lower-case chain identity written with or without 0x is the same pin: it is
// canonicalised once to its bare form, and every lane key and stored binding
// uses that form. Upper-case or padded identities are refused with the
// binder's own cause. A retained transfer stamped by another pin version stays
// readback-only: it is never reconfirmed, resent or re-keyed.
// The real transport and durable journal run in this process against a
// scripted TEST node. No network, chain or funds.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { NetworkBindingError } from '../src/dacs/network-binding.mjs';
import { buildNativeTransferPayload } from '../src/dacs/wallet-transactions.mjs';
import { createDevnetNativeTransport, nativeWalletLaneKey } from '../src/wallet/devnet-native-transport.mjs';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';

const OWNER = 'TEST-native-owner', PAYEE = '0x' + '7'.repeat(64);
const IDENTITY = 'c'.repeat(64);
const CURRENT_PIN = 'TEST-native-pins-current', RETIRED_PIN = 'TEST-native-pins-retired';
const PINS = { network: 'testnet', chainIdentity: IDENTITY, pinVersion: CURRENT_PIN, endpoint: 'https://rpc.invalid/', transportAuthority: OWNER };
const CONTEXT = { network: PINS.network, endpoint: PINS.endpoint, transportAuthority: OWNER, connectionId: 'TEST-connection' };
const LANE_PREFIX = 'devnet/native-wallet/';
const sha = value => createHash('sha256').update(value).digest('hex');
const ok = response => ({ result: 200, response, require_reply: false, extra: null });

// Accepts every confirmation and broadcast and counts them.
function testNode() {
  const node = { nonce: 0, confirms: 0, broadcasts: [], genesisHash: IDENTITY, applied: new Map() };
  node.fetch = async (url, init) => {
    const body = JSON.parse(init.body), call = body.params[0];
    let answer;
    if (body.method === 'nodeCall') {
      const { message, data } = call;
      if (message === 'getBlockByNumber') answer = ok(data.blockNumber === 0 ? { number: 0, status: 'confirmed', hash: node.genesisHash, content: {} }
        : { number: data.blockNumber, status: 'confirmed', hash: 'b'.repeat(64), content: { ordered_transactions: [...node.applied.keys()] } });
      else if (message === 'getAddressNonce') answer = ok(node.nonce);
      else if (message === 'getNetworkParameters') answer = ok({ networkFee: 1, rpcFee: 1, additionalFee: 0 });
      else if (message === 'getTransactionStatus') answer = ok(node.applied.has(data.hash) ? { state: 'included', blockNumber: 1 } : { state: 'unknown' });
      else if (message === 'getTxByHash') answer = ok({ ...structuredClone(node.applied.get(data.hash)), status: 'confirmed', blockNumber: 1 });
      else throw new Error(`unexpected TEST node read ${message}`);
    } else if (call.extra === 'confirmTx') {
      node.confirms++;
      answer = ok({ data: { valid: true, gas_operation: null, transaction: call.data } });
    } else {
      const tx = call.data.response.data.transaction;
      node.broadcasts.push(tx.hash);
      node.applied.set(tx.hash, structuredClone(tx));
      node.nonce = tx.content.nonce;
      answer = ok({ message: 'TEST accepted' });
    }
    return new Response(JSON.stringify(answer), { headers: { 'content-type': 'application/json' } });
  };
  return node;
}

function world(t) {
  const dir = mkdtempSync(join(tmpdir(), 'native-effect-paths-')), path = join(dir, 'journal.sqlite');
  const node = testNode(), fence = { acquired: 0, released: 0 };
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const address = '0x' + Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
  const signText = message => sign(null, Buffer.from(message, 'utf8'), privateKey).toString('hex');
  let stamp = Date.now() + 60000, journal = openDurableWalletJournal({ path, mode: 'create' }), transport = null;
  const auth = () => { const identity = `ed25519:${address}`, timestamp = String(stamp++); return { identity, timestamp, signature: signText(sha(`${identity}:${timestamp}`)) }; };
  const open = pins => {
    transport = createDevnetNativeTransport({ expected: { ...PINS, ...pins }, journal, fetchImpl: node.fetch, inclusionWaitMs: 0, inclusionPollMs: 1, sleep: async () => {},
      transportOwner: { getContext: () => ({ ...CONTEXT }), acquireConnectionFence: () => { fence.acquired++; return { context: { ...CONTEXT }, release() { fence.released++; } }; } } });
    return transport;
  };
  t.after(async () => { await transport?.close(); journal.close(); rmSync(dir, { recursive: true, force: true }); });
  const signedTransfer = nonce => {
    const payload = buildNativeTransferPayload({ from: address, to: PAYEE, amountOs: '2500000000', nonce, timestamp: Date.now(), encoding: 'os-string' });
    const content = structuredClone(payload.content), edit = (type, operation, account, amount) => ({ type, operation, isRollback: false, account, txhash: '', amount });
    Object.assign(content, { from: address, from_ed25519_address: address, nonce, transaction_fee: { network_fee: '1000000000', rpc_fee: '1000000000', additional_fee: '0', rpc_address: null },
      gcr_edits: [edit('balance', 'remove', address, content.amount), edit('balance', 'add', content.to, content.amount), edit('balance', 'remove', address, '1000000000'), edit('nonce', 'add', address, 1)] });
    const hash = sha(JSON.stringify(content));
    return { content, signature: { type: 'ed25519', data: signText(hash) }, hash, status: '', blockNumber: null };
  };
  const world = { node, fence, address, open, signedTransfer,
    transport: () => transport,
    journalEntries: async () => await journal.entries(),
    plant: (key, record) => journal.put(key, record),
    lease: async () => { const { binding } = await transport.binding({ phase: 'bind', address }); return { ...await transport.binding({ phase: 'signature', address, binding }), binding }; },
    confirm: tx => transport.rpc({ method: 'execute', params: [{ extra: 'confirmTx', data: tx }] }, auth()),
    prepareBroadcast: (leaseId, hash) => transport.binding({ phase: 'broadcast', address, leaseId, hash }),
    broadcast: confirmation => transport.rpc({ method: 'execute', params: [{ extra: 'broadcastTx', data: confirmation }] }, auth()),
    restart: async pins => { await transport.close(); journal.close(); journal = openDurableWalletJournal({ path, mode: 'open' }); return open(pins); } };
  // Signs, confirms and broadcasts one transfer through a fresh lease; the lane then holds an accepted broadcast.
  world.send = async nonce => {
    const lease = await world.lease(), tx = signedTransfer(nonce);
    const confirmation = await world.confirm(tx);
    await world.prepareBroadcast(lease.leaseId, tx.hash);
    const answer = await world.broadcast(confirmation);
    return { lease, tx, answer };
  };
  return world;
}

test('a 0x-prefixed lower-case chain identity binds and keys its lane the same as the bare form', async t => {
  const w = world(t), prefixed = '0x' + IDENTITY;
  assert.equal(nativeWalletLaneKey({ ...PINS, chainIdentity: prefixed }, w.address), nativeWalletLaneKey(PINS, w.address));
  w.open({ chainIdentity: prefixed });
  const { binding } = await w.transport().binding({ phase: 'bind', address: w.address });
  assert.equal(binding.chainIdentity, IDENTITY);
  const { tx, answer } = await w.send(1);
  assert.equal(answer.result, 200);
  const lanes = (await w.journalEntries()).filter(([key]) => key.startsWith(LANE_PREFIX));
  assert.deepEqual(lanes.map(([key]) => key), [nativeWalletLaneKey(PINS, w.address)]);
  assert.equal(lanes[0][1].networkBinding.chainIdentity, IDENTITY);
  assert.equal(JSON.stringify(lanes[0][1].signedTransaction), JSON.stringify(tx), 'the stored signed bytes are the signed bytes');
  // A transport pinned with the bare form finds the same lane and refuses to resend it.
  w.open({});
  await assert.rejects(w.lease(), { code: 'outcome_unknown' });
  // Readback under the prefixed pin reports the bare identity and accepts the stored binding.
  w.open({ chainIdentity: prefixed });
  const read = await w.transport().binding({ phase: 'readback', address: w.address, hash: tx.hash });
  assert.equal(read.disposition, 'included');
  assert.equal(read.receipt.chainIdentity, IDENTITY);
});

test('an upper-case or padded chain identity is refused with its cause and never normalised', async t => {
  const w = world(t);
  for (const chainIdentity of [IDENTITY.toUpperCase(), '0X' + IDENTITY, `0x${IDENTITY.toUpperCase().slice(0, 2)}${IDENTITY.slice(2)}`, ` ${IDENTITY}`, `${IDENTITY}\n`, `0x ${IDENTITY}`, IDENTITY.slice(1)]) {
    assert.throws(() => w.open({ chainIdentity }), error => error instanceof NetworkBindingError && error.code === 'unpinned_network' && /canonical lowercase 64-hex/.test(error.message), JSON.stringify(chainIdentity));
  }
  // An upper-case identity observed from the node is refused as well, with its own cause.
  w.node.genesisHash = IDENTITY.toUpperCase();
  w.open({});
  await assert.rejects(w.transport().binding({ phase: 'bind', address: w.address }), error => error instanceof NetworkBindingError && error.code === 'malformed_observation');
  assert.deepEqual((await w.journalEntries()).filter(([key]) => key.startsWith(LANE_PREFIX)), []);
});

test('a lane stamped with a retired pin version is readback-only: no lease, no resend, no re-key', async t => {
  const w = world(t);
  w.open({ pinVersion: RETIRED_PIN });
  const { tx } = await w.send(1);
  const retained = JSON.stringify(await w.journalEntries());
  assert.equal(w.node.confirms, 1);
  assert.deepEqual(w.node.broadcasts, [tx.hash]);
  for (const restart of [false, true]) {
    if (restart) await w.restart({ pinVersion: CURRENT_PIN });
    else w.open({ pinVersion: CURRENT_PIN });
    const acquired = w.fence.acquired;
    await assert.rejects(w.lease(), { code: 'pin_version_retired' });
    assert.equal(w.fence.released, w.fence.acquired, 'the connection fence is released after the refusal');
    assert.ok(w.fence.acquired >= acquired);
    assert.equal(JSON.stringify(await w.journalEntries()), retained, 'the retained lane keeps its key and bytes');
  }
  assert.equal(w.node.confirms, 1);
  assert.deepEqual(w.node.broadcasts, [tx.hash]);
  // The same lane under its own pin version keeps the unfinished-transfer refusal.
  await w.restart({ pinVersion: RETIRED_PIN });
  await assert.rejects(w.lease(), { code: 'outcome_unknown' });
});

test('confirm refuses a retained transfer stamped with a retired pin version and sends nothing', async t => {
  const w = world(t);
  w.open({});
  const lease = await w.lease(), tx = w.signedTransfer(1);
  await w.plant(`devnet/native-transfer/${tx.hash}`, { stage: 'broadcast-accepted', hash: tx.hash, nonce: 1, signedTransaction: tx, networkBinding: { ...lease.binding, pinVersion: RETIRED_PIN } });
  await assert.rejects(w.confirm(tx), { code: 'pin_version_retired' });
  assert.equal(w.node.confirms, 0);
  assert.deepEqual(w.node.broadcasts, []);
});

test('broadcast refuses a lane stamped with a retired pin version and sends nothing', async t => {
  const w = world(t);
  w.open({});
  const lease = await w.lease(), tx = w.signedTransfer(1), other = w.signedTransfer(2);
  const confirmation = await w.confirm(tx);
  await w.prepareBroadcast(lease.leaseId, tx.hash);
  const laneKey = nativeWalletLaneKey(PINS, w.address);
  await w.plant(laneKey, { stage: 'broadcast-accepted', hash: other.hash, nonce: 2, signedTransaction: other, networkBinding: { ...lease.binding, pinVersion: RETIRED_PIN } });
  const retained = JSON.stringify(await w.journalEntries());
  await assert.rejects(w.broadcast(confirmation), { code: 'pin_version_retired' });
  assert.deepEqual(w.node.broadcasts, []);
  assert.equal(JSON.stringify(await w.journalEntries()), retained, 'the retired lane is neither rewritten nor re-keyed');
});
