// The native transport keys and compares its lane on one canonical chain identity,
// and a lane stamped by another pin version stays readback-only. The real
// transport and durable journal run in this process against a scripted TEST node;
// a TEST key signs the transactions. No network, chain or funds.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildNativeTransferPayload } from '../src/dacs/wallet-transactions.mjs';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';
import { createDevnetNativeTransport, nativeWalletLaneKey } from '../src/wallet/devnet-native-transport.mjs';

const CHAIN = 'c'.repeat(64), PAYEE = '0x' + '7'.repeat(64), LANE_PREFIX = 'devnet/native-wallet/';
const pinsFor = (chainIdentity, pinVersion = 'TEST-native-pins') => ({ network:'testnet', chainIdentity, pinVersion, endpoint:'https://rpc.invalid/', transportAuthority:'TEST-native-owner' });
const CONTEXT = { network:'testnet', endpoint:'https://rpc.invalid/', transportAuthority:'TEST-native-owner', connectionId:'TEST-connection' };
const sha = (value) => createHash('sha256').update(value).digest('hex');
const ok = (response) => ({ result:200, response, require_reply:false, extra:null });

// A node that confirms and accepts every send, then reports it included in block 1.
function scriptedNode() {
  const node = { nonce:0, confirms:0, broadcasts:[], applied:new Map() };
  node.fetch = async (url, init) => {
    const call = JSON.parse(init.body).params[0];
    let answer;
    if (call.message === 'getBlockByNumber') answer = ok(call.data.blockNumber === 0 ? { number:0, status:'confirmed', hash:CHAIN, content:{} }
      : { number:call.data.blockNumber, status:'confirmed', hash:'b'.repeat(64), content:{ ordered_transactions:[...node.applied.keys()] } });
    else if (call.message === 'getAddressNonce') answer = ok(node.nonce);
    else if (call.message === 'getNetworkParameters') answer = ok({ networkFee:1, rpcFee:1, additionalFee:0 });
    else if (call.message === 'getTransactionStatus') answer = ok(node.applied.has(call.data.hash) ? { state:'included', blockNumber:1 } : { state:'unknown' });
    else if (call.message === 'getTxByHash') answer = ok({ ...structuredClone(node.applied.get(call.data.hash)), status:'confirmed', blockNumber:1 });
    else if (call.extra === 'confirmTx') { node.confirms++; answer = ok({ data:{ valid:true, gas_operation:null, transaction:call.data } }); }
    else if (call.extra === 'broadcastTx') {
      const tx = call.data.response.data.transaction;
      node.broadcasts.push(tx.hash); node.applied.set(tx.hash, structuredClone(tx)); node.nonce = tx.content.nonce;
      answer = ok({ message:'TEST accepted' });
    } else throw new Error(`unexpected TEST node call ${JSON.stringify(call)}`);
    return new Response(JSON.stringify(answer), { headers:{ 'content-type':'application/json' } });
  };
  return node;
}

function world(t) {
  const dir = mkdtempSync(join(tmpdir(), 'native-effect-paths-')), path = join(dir, 'journal.sqlite');
  const node = scriptedNode(), { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const address = '0x' + Buffer.from(publicKey.export({ format:'jwk' }).x, 'base64url').toString('hex');
  const signText = (message) => sign(null, Buffer.from(message, 'utf8'), privateKey).toString('hex');
  let stamp = Date.now() + 60000, journal = openDurableWalletJournal({ path, mode:'create' }), transport = null;
  const sdkAuth = () => { const identity = `ed25519:${address}`, timestamp = String(stamp++); return { identity, timestamp, signature:signText(sha(`${identity}:${timestamp}`)) }; };
  const open = (pins) => {
    transport = createDevnetNativeTransport({ expected:pins, journal, fetchImpl:node.fetch, inclusionWaitMs:0,
      transportOwner:{ getContext:() => ({ ...CONTEXT }), acquireConnectionFence:() => ({ context:{ ...CONTEXT }, release() {} }) } });
    return transport;
  };
  const w = { node, address, open, sdkAuth, journal:() => journal, transport:() => transport,
    async restart(pins) { await transport.close(); journal.close(); journal = openDurableWalletJournal({ path, mode:'open' }); return open(pins); },
    lanes:async () => (await journal.entries()).filter(([key]) => key.startsWith(LANE_PREFIX)),
    // The wallet's signature: native send content with its fees and edits, signed over the content hash.
    sign(nonce) {
      const content = structuredClone(buildNativeTransferPayload({ from:address, to:PAYEE, amountOs:'2500000000', nonce, timestamp:Date.now(), encoding:'os-string' }).content);
      const edit = (type, operation, account, amount) => ({ type, operation, isRollback:false, account, txhash:'', amount });
      Object.assign(content, { from:address, from_ed25519_address:address, nonce, transaction_fee:{ network_fee:'1000000000', rpc_fee:'1000000000', additional_fee:'0', rpc_address:null },
        gcr_edits:[edit('balance', 'remove', address, content.amount), edit('balance', 'add', content.to, content.amount), edit('balance', 'remove', address, '1000000000'), edit('nonce', 'add', address, 1)] });
      const hash = sha(JSON.stringify(content));
      return { content, signature:{ type:'ed25519', data:signText(hash) }, hash, status:'', blockNumber:null };
    },
    async lease() {
      const { binding } = await transport.binding({ phase:'bind', address });
      return transport.binding({ phase:'signature', address, binding });
    },
    confirm: (signed) => transport.rpc({ method:'execute', params:[{ extra:'confirmTx', data:signed }] }, w.sdkAuth()),
    broadcast: (confirmed) => transport.rpc({ method:'execute', params:[{ extra:'broadcastTx', data:confirmed }] }, w.sdkAuth()),
    async send(nonce) {
      const { leaseId } = await w.lease(), signed = w.sign(nonce), confirmed = await w.confirm(signed);
      await transport.binding({ phase:'broadcast', address, leaseId, hash:signed.hash });
      await w.broadcast(confirmed);
      return signed;
    },
  };
  t.after(async () => { await transport?.close(); journal.close(); rmSync(dir, { recursive:true, force:true }); });
  return w;
}

test('lower-case chain identities, with or without 0x, canonicalise once; upper-case or padded identities refuse at the observation boundary, with their cause; stored signed bytes are never normalized and retired lanes are never re-keyed', async (t) => {
  const keys = [];
  for (const spelling of [CHAIN, '0x' + CHAIN]) {
    const w = world(t);
    w.open(pinsFor(spelling));
    const signed = await w.send(1);
    const lanes = await w.lanes();
    assert.deepEqual(lanes.map(([key]) => key), [nativeWalletLaneKey(pinsFor(CHAIN), w.address)], `lane key for ${spelling.slice(0, 4)}`);
    keys.push(lanes[0][0].replace(w.address, ''));
    assert.equal(lanes[0][1].networkBinding.chainIdentity, CHAIN);
    assert.equal(JSON.stringify(lanes[0][1].signedTransaction), JSON.stringify(signed), 'signed bytes are stored as signed');
    const read = await w.transport().binding({ phase:'readback', address:w.address, hash:signed.hash });
    assert.equal(read.disposition, 'included', `readback of ${spelling.slice(0, 4)} pins`);
    assert.equal(nativeWalletLaneKey(pinsFor('0x' + CHAIN), w.address), nativeWalletLaneKey(pinsFor(CHAIN), w.address));
  }
  assert.equal(keys[0], keys[1], 'both spellings key one lane');
  for (const bad of [CHAIN.toUpperCase(), ` ${CHAIN}`, `${CHAIN} `, '0X' + CHAIN, '0x0x' + CHAIN, CHAIN.slice(1)]) {
    const w = world(t);
    assert.throws(() => w.open(pinsFor(bad)), { name:'NetworkBindingError', code:'unpinned_network' }, JSON.stringify(bad));
    assert.equal(w.node.confirms + w.node.broadcasts.length, 0);
  }
  // A lane an earlier spelling stored under its own key is neither read nor rewritten.
  const w = world(t), earlierKey = `${LANE_PREFIX}${JSON.stringify(['testnet', '0x' + CHAIN, w.address])}`;
  const earlier = { stage:'broadcast-accepted', hash:'e'.repeat(64), nonce:1, signedTransaction:{ content:{ from:w.address } }, networkBinding:{ network:'testnet', chainIdentity:'0x' + CHAIN } };
  await w.journal().put(earlierKey, earlier);
  w.open(pinsFor('0x' + CHAIN));
  await w.send(1);
  assert.deepEqual(await w.journal().get(earlierKey), earlier);
  assert.deepEqual((await w.lanes()).map(([key]) => key).sort(), [earlierKey, nativeWalletLaneKey(pinsFor(CHAIN), w.address)].sort());
});

test('a native lane stamped with the revision-1 pin version after restart is readback-only, never resent or re-keyed', async (t) => {
  const w = world(t), revision1 = pinsFor(CHAIN, 'TEST-native-pins-r1'), revision2 = pinsFor(CHAIN, 'TEST-native-pins-r2');
  const laneKey = nativeWalletLaneKey(revision1, w.address);
  w.open(revision1);
  const first = await w.send(1);
  const retained = await w.journal().get(laneKey);
  assert.equal(retained.networkBinding.pinVersion, 'TEST-native-pins-r1');

  await w.restart(revision2);
  await assert.rejects(w.lease(), { code:'pin_version_retired' });
  assert.deepEqual(await w.journal().get(laneKey), retained, 'the lane keeps its key and bytes');
  assert.deepEqual([w.node.confirms, w.node.broadcasts], [1, [first.hash]], 'nothing is resent');

  // The binder refuses the saved binding of another version, so a read-back changes nothing either.
  await assert.rejects(w.transport().binding({ phase:'readback', address:w.address, hash:first.hash }), { code:'binding_mismatch' });
  assert.deepEqual(await w.journal().get(laneKey), retained);
  assert.deepEqual((await w.lanes()).map(([key]) => key), [laneKey]);

  // A retained transfer that is already read back holds nothing unread, so a stamp of another version does not refuse.
  await w.journal().put(laneKey, { ...retained, stage:'observed' });
  const { leaseId } = await w.lease();

  // An intent or lane that appears stamped with the retired version while the lease is held refuses confirmation and broadcast.
  const second = w.sign(2);
  await w.journal().put(`devnet/native-transfer/${second.hash}`, { ...retained, hash:second.hash, nonce:2, stage:'broadcast-started' });
  await assert.rejects(w.confirm(second), { code:'pin_version_retired' });
  const third = w.sign(3), confirmed = await w.confirm(third);
  await w.transport().binding({ phase:'broadcast', address:w.address, leaseId, hash:third.hash });
  await w.journal().put(laneKey, { ...retained, hash:'d'.repeat(64), nonce:2, stage:'broadcast-started' });
  await assert.rejects(w.broadcast(confirmed), { code:'pin_version_retired' });
  assert.deepEqual([w.node.confirms, w.node.broadcasts], [2, [first.hash]], 'no confirmation of the retired intent and no second broadcast');
});
