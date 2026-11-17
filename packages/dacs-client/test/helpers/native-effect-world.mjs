// Test-only world for the native transport's effect paths: the real transport
// and durable journal in this process against a scripted TEST node. With
// `bound` (a tp1 binding fixture) the transport also gets a real effect
// boundary over the same journal and a first-come owner fence. No network,
// chain or funds.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNativeTransferPayload } from '../../src/dacs/wallet-transactions.mjs';
import { createDevnetNativeTransport, nativeWalletLaneKey } from '../../src/wallet/devnet-native-transport.mjs';
import { openDurableWalletJournal } from '../../src/wallet/durable-journal.mjs';
import { createEffectFence } from '../../src/wallet/effect-fence.mjs';
import { createEffectHistory } from '../../src/wallet/effect-history.mjs';
import { contextGate } from './context-gate.mjs';
import { controlledClock, createEffectBoundary, digest, setPurchaseAdmission } from './effect-boundary-fixture.mjs';

const OWNER = 'TEST-native-owner', PAYEE = '0x' + '7'.repeat(64);
export const IDENTITY = 'c'.repeat(64);
export const CURRENT_PIN = 'TEST-native-pins-current', RETIRED_PIN = 'TEST-native-pins-retired';
export const PINS = { network: 'testnet', chainIdentity: IDENTITY, pinVersion: CURRENT_PIN, endpoint: 'https://rpc.invalid/', transportAuthority: OWNER };
const CONTEXT = { network: PINS.network, endpoint: PINS.endpoint, transportAuthority: OWNER, connectionId: 'TEST-connection' };
export const LANE_PREFIX = 'devnet/native-wallet/';
const sha = value => createHash('sha256').update(value).digest('hex');
const ok = response => ({ result: 200, response, require_reply: false, extra: null });

/** Accepts every confirmation and broadcast and counts them. Set `gas` to answer confirmations with gas, `failConfirm` to make them throw, `confirmGate` to a promise to hold them, `invalid` to refuse them, `altered` to change the transaction in the answer. */
function testNode() {
  const node = { nonce: 0, confirms: 0, broadcasts: [], genesisHash: IDENTITY, applied: new Map(), gas: null, failConfirm: null, confirmGate: null, invalid: false, altered: false };
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
      if (node.confirmGate) await node.confirmGate;
      if (node.failConfirm) throw node.failConfirm;
      answer = ok({ data: { valid: !node.invalid, gas_operation: node.gas, transaction: node.altered ? { ...call.data, status: 'TEST-altered' } : call.data } });
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

/** The transport owner's connection fence: one holder at a time, in arrival order, counted in `fence`; `fence.onAcquire` runs as each acquisition starts. */
function firstComeOwner(fence, gate) {
  const waiters = [];
  let held = false;
  const grant = () => { if (!held && waiters.length) { held = true; waiters.shift()(); } };
  const acquire = () => { fence.acquired++; fence.onAcquire?.(); return new Promise(resolve => { waiters.push(() => resolve({ context: { ...CONTEXT }, release() { held = false; fence.released++; grant(); } })); grant(); }); };
  return { getContext: async () => { await gate.pass(); return { ...CONTEXT }; }, acquireConnectionFence: acquire };
}

export function nativeWorld(t, { bound } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'native-effect-paths-')), path = join(dir, 'journal.sqlite');
  const node = testNode(), fence = { acquired: 0, released: 0 };
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const address = '0x' + Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
  const signText = message => sign(null, Buffer.from(message, 'utf8'), privateKey).toString('hex');
  let stamp = Date.now() + 60000, journal = openDurableWalletJournal({ path, mode: 'create' }), transport = null, owner = null;
  const auth = () => { const identity = `ed25519:${address}`, timestamp = String(stamp++); return { identity, timestamp, signature: signText(sha(`${identity}:${timestamp}`)) }; };
  const gate = contextGate();
  const world = { node, fence, address, clock: controlledClock(), stopped: false, bound, feeCeilingOs: '50000000000' };
  /** `gate.hold()` makes the next getContext call of the transport owner wait until `release()`; `reached` tells when it was called. */
  world.gate = gate;
  if (bound) setPurchaseAdmission('testnet-tp1');
  const buildBoundary = () => {
    world.history = createEffectHistory({ journal });
    world.effectFence = createEffectFence({ acquire: () => owner.acquireConnectionFence({ address }), currentLocal: () => digest(bound.currentLocal()),
      setTimer: world.clock.setTimer, clearTimer: world.clock.clearTimer });
    world.boundary = createEffectBoundary({ binding: bound.binding, currentLocal: bound.currentLocal, stopped: async () => world.stopped, feeCeilingOs: world.feeCeilingOs,
      history: world.history, fence: world.effectFence, clock: world.clock });
  };
  const open = (pins, extra = {}) => {
    owner = firstComeOwner(fence, gate);
    if (bound) buildBoundary();
    transport = createDevnetNativeTransport({ expected: { ...PINS, ...(bound ? { pinVersion: bound.binding.profile.pinVersion } : {}), ...pins }, journal, fetchImpl: node.fetch, inclusionWaitMs: 0, inclusionPollMs: 1, sleep: async () => {},
      ...(bound ? { boundary: world.boundary } : {}), ...extra, transportOwner: owner });
    return transport;
  };
  t.after(async () => { await transport?.close(); journal.close(); rmSync(dir, { recursive: true, force: true }); if (bound) setPurchaseAdmission('held'); });
  const signedTransfer = (nonce, amountOs = '2500000000') => {
    const payload = buildNativeTransferPayload({ from: address, to: PAYEE, amountOs, nonce, timestamp: Date.now(), encoding: 'os-string' });
    const content = structuredClone(payload.content), edit = (type, operation, account, amount) => ({ type, operation, isRollback: false, account, txhash: '', amount });
    Object.assign(content, { from: address, from_ed25519_address: address, nonce, transaction_fee: { network_fee: '1000000000', rpc_fee: '1000000000', additional_fee: '0', rpc_address: null },
      gcr_edits: [edit('balance', 'remove', address, content.amount), edit('balance', 'add', content.to, content.amount), edit('balance', 'remove', address, '1000000000'), edit('nonce', 'add', address, 1)] });
    const hash = sha(JSON.stringify(content));
    return { content, signature: { type: 'ed25519', data: signText(hash) }, hash, status: '', blockNumber: null };
  };
  Object.assign(world, { open, signedTransfer, authHeaders: auth,
    transport: () => transport,
    journal: () => journal,
    /** The journal as the transport sees it with a write failing: pass it as `open(pins, { journal })`. `fails(key, value)` picks the write. */
    faultyJournal: fails => ({ get: key => journal.get(key), entries: () => journal.entries(), withWalletLock: (key, work) => journal.withWalletLock(key, work),
      put: (key, value) => { if (fails(key, value)) throw new Error('TEST-journal-cut'); return journal.put(key, value); } }),
    journalEntries: async () => await journal.entries(),
    plant: (key, record) => journal.put(key, record),
    bind: async (who = address) => (await transport.binding({ phase: 'bind', address: who })).binding,
    signature: (binding, who = address) => transport.binding({ phase: 'signature', address: who, binding }),
    lease: async () => { const binding = await world.bind(); return { ...await world.signature(binding), binding }; },
    release: leaseId => transport.binding({ phase: 'release', address, leaseId }),
    confirm: tx => transport.rpc({ method: 'execute', params: [{ extra: 'confirmTx', data: tx }] }, auth()),
    prepareBroadcast: (leaseId, hash) => transport.binding({ phase: 'broadcast', address, leaseId, hash }),
    broadcast: confirmation => transport.rpc({ method: 'execute', params: [{ extra: 'broadcastTx', data: confirmation }] }, auth()),
    /** The history records of a signed transaction, in commit order, read through a fresh history over the journal. */
    records: async tx => {
      return createEffectHistory({ journal }).read({ lane: nativeWalletLaneKey(PINS, address), artifactHash: sha(JSON.stringify(tx)) });
    },
    restart: async (pins, extra) => { await transport.close(); journal.close(); journal = openDurableWalletJournal({ path, mode: 'open' }); return open(pins, extra); } });
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
