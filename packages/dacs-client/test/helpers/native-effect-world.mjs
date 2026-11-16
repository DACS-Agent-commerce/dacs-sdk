// Test-only native transport world: the real transport, durable journal and effect boundary
// in this process, against a scripted TEST node. A TEST key signs the transactions. No
// network, chain or funds. The effect boundary comes from the shared fixture, which
// installs the purchase admission double before any module under src/ loads.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setPurchaseAdmission, createEffectBoundary, controlledClock, digest } from './effect-boundary-fixture.mjs';
import { bindFixture } from '../fixtures/tp1-authority-reader.mjs';
import { buildNativeTransferPayload } from '../../src/dacs/wallet-transactions.mjs';
import { openDurableWalletJournal } from '../../src/wallet/durable-journal.mjs';
import { createEffectFence } from '../../src/wallet/effect-fence.mjs';
import { createEffectHistory } from '../../src/wallet/effect-history.mjs';
import { createDevnetNativeTransport } from '../../src/wallet/devnet-native-transport.mjs';

export const CHAIN = 'c'.repeat(64), LANE_PREFIX = 'devnet/native-wallet/';
const PAYEE = '0x' + '7'.repeat(64), HISTORY_PREFIX = 'eb/', FEE_CEILING_OS = '50000000000';
export const pinsFor = (chainIdentity, pinVersion = 'TEST-native-pins') => ({ network:'testnet', chainIdentity, pinVersion, endpoint:'https://rpc.invalid/', transportAuthority:'TEST-native-owner' });
const CONTEXT = { network:'testnet', endpoint:'https://rpc.invalid/', transportAuthority:'TEST-native-owner', connectionId:'TEST-connection' };
const sha = (value) => createHash('sha256').update(value).digest('hex');
const ok = (response) => ({ result:200, response, require_reply:false, extra:null });

/** A node that confirms and accepts every send, then reports it included in block 1. `gas` is the confirmation's gas_operation; `invalid` makes it answer valid: false; `changed` makes it echo a changed transaction; `lose` makes each confirmation fail in transit. */
function scriptedNode() {
  const node = { nonce:0, confirms:0, broadcasts:[], applied:new Map(), gas:null, invalid:false, changed:false, lose:false };
  node.fetch = async (url, init) => {
    const call = JSON.parse(init.body).params[0];
    let answer;
    if (call.message === 'getBlockByNumber') answer = ok(call.data.blockNumber === 0 ? { number:0, status:'confirmed', hash:CHAIN, content:{} }
      : { number:call.data.blockNumber, status:'confirmed', hash:'b'.repeat(64), content:{ ordered_transactions:[...node.applied.keys()] } });
    else if (call.message === 'getAddressNonce') answer = ok(node.nonce);
    else if (call.message === 'getNetworkParameters') answer = ok({ networkFee:1, rpcFee:1, additionalFee:0 });
    else if (call.message === 'getTransactionStatus') answer = ok(node.applied.has(call.data.hash) ? { state:'included', blockNumber:1 } : { state:'unknown' });
    else if (call.message === 'getTxByHash') answer = ok({ ...structuredClone(node.applied.get(call.data.hash)), status:'confirmed', blockNumber:1 });
    else if (call.extra === 'confirmTx') {
      node.confirms++;
      if (node.lose) throw new Error('TEST confirmation answer lost');
      answer = ok({ data:{ valid:!node.invalid, gas_operation:node.gas, transaction:node.changed ? { ...call.data, hash:'f'.repeat(64) } : call.data } });
    } else if (call.extra === 'broadcastTx') {
      const tx = call.data.response.data.transaction;
      node.broadcasts.push(tx.hash); node.applied.set(tx.hash, structuredClone(tx)); node.nonce = tx.content.nonce;
      answer = ok({ message:'TEST accepted' });
    } else throw new Error(`unexpected TEST node call ${JSON.stringify(call)}`);
    return new Response(JSON.stringify(answer), { headers:{ 'content-type':'application/json' } });
  };
  return node;
}

// The transport owner's connection. `exclusive` makes it a real fence: one holder, waiters in order.
// `gate` is awaited at every acquisition, before it is granted, and `contextGate` at every
// context read, before it answers. `connectionId` is the connection the owner reports, and
// `fenceConnectionId` (when set) the one its fences claim to hold.
function connectionOwner(exclusive) {
  const owner = { acquired:0, released:0, gate:null, contextGate:null, held:false, waiters:[], connectionId:CONTEXT.connectionId, fenceConnectionId:null };
  const grant = () => { if (!owner.held && owner.waiters.length) { owner.held = true; owner.waiters.shift()(); } };
  owner.getContext = async () => { await owner.contextGate?.(); return { ...CONTEXT, connectionId:owner.connectionId }; };
  owner.acquireConnectionFence = async () => {
    owner.acquired++;
    await owner.gate?.();
    if (exclusive) await new Promise((resolve) => { owner.waiters.push(resolve); grant(); });
    let released = false;
    return { context:{ ...CONTEXT, connectionId:owner.fenceConnectionId ?? owner.connectionId }, release() { if (released) return; released = true; owner.released++; if (exclusive) { owner.held = false; grant(); } } };
  };
  return owner;
}

/** A wallet key: its address, the SDK's RPC authentication headers and signed native transfers. */
export function walletKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const address = '0x' + Buffer.from(publicKey.export({ format:'jwk' }).x, 'base64url').toString('hex');
  const signText = (message) => sign(null, Buffer.from(message, 'utf8'), privateKey).toString('hex');
  let stamp = Date.now() + 60000;
  return {
    address,
    sdkAuth() { const identity = `ed25519:${address}`, timestamp = String(stamp++); return { identity, timestamp, signature:signText(sha(`${identity}:${timestamp}`)) }; },
    // The wallet's signature: native send content with its fees and edits, signed over the content hash.
    sign(nonce) {
      const content = structuredClone(buildNativeTransferPayload({ from:address, to:PAYEE, amountOs:'2500000000', nonce, timestamp:Date.now(), encoding:'os-string' }).content);
      const edit = (type, operation, account, amount) => ({ type, operation, isRollback:false, account, txhash:'', amount });
      Object.assign(content, { from:address, from_ed25519_address:address, nonce, transaction_fee:{ network_fee:'1000000000', rpc_fee:'1000000000', additional_fee:'0', rpc_address:null },
        gcr_edits:[edit('balance', 'remove', address, content.amount), edit('balance', 'add', content.to, content.amount), edit('balance', 'remove', address, '1000000000'), edit('nonce', 'add', address, 1)] });
      const hash = sha(JSON.stringify(content));
      return { content, signature:{ type:'ed25519', data:signText(hash) }, hash, status:'', blockNumber:null };
    },
  };
}

/**
 * One native wallet against one transport. `open(pins, boundary?)` builds the transport;
 * `openGuarded()` composes a real effect boundary over the current journal and the owner's
 * fence and opens the transport with it; `restartGuarded()` does both again over the same
 * journal file. `history(operation)` lists a lane's dispatch history states.
 */
export function nativeWorld(t, { exclusive = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'native-effect-world-')), path = join(dir, 'journal.sqlite');
  const node = scriptedNode(), key = walletKey(), owner = connectionOwner(exclusive);
  let journal = openDurableWalletJournal({ path, mode:'create' }), transport = null, guard = null, bound = null, nowMs = Date.now();
  const open = (pins, boundary, options = {}) => {
    transport = createDevnetNativeTransport({ expected:pins, journal, fetchImpl:node.fetch, inclusionWaitMs:0, transportOwner:owner, ...(boundary ? { boundary } : {}), ...options });
    return transport;
  };
  const w = { node, owner, address:key.address, sdkAuth:key.sdkAuth, sign:key.sign, open, journal:() => journal, transport:() => transport, guard:() => guard,
    clock:{ now:() => nowMs, advance:(ms) => { nowMs += ms; } },
    async restart(pins) { await transport.close(); journal.close(); journal = openDurableWalletJournal({ path, mode:'open' }); return open(pins); },
    lanes:async () => (await journal.entries()).filter(([key]) => key.startsWith(LANE_PREFIX)),
    // Every dispatch history record on the journal, in commit order, as `passId/state`.
    async historyStates() { return (await journal.entries()).filter(([key]) => key.startsWith(HISTORY_PREFIX)).map(([, record]) => `${record.passId}/${record.state}`); },
    async historyRecords() { return (await journal.entries()).filter(([key]) => key.startsWith(HISTORY_PREFIX)).map(([, record]) => record); },
    async compose({ feeCeilingOs = FEE_CEILING_OS } = {}) {
      setPurchaseAdmission('testnet-tp1');
      bound ??= await bindFixture();
      const clock = controlledClock(), state = { stopped:false };
      const history = createEffectHistory({ journal });
      const fence = createEffectFence({ acquire:() => owner.acquireConnectionFence(), currentLocal:() => digest(bound.currentLocal()), setTimer:clock.setTimer, clearTimer:clock.clearTimer });
      guard = { bound, clock, state, history, fence, pinVersion:bound.binding.profile.pinVersion,
        boundary:createEffectBoundary({ binding:bound.binding, currentLocal:bound.currentLocal, stopped:async () => state.stopped, feeCeilingOs, history, fence, clock }) };
      return guard;
    },
    async openGuarded(options = {}) {
      const composed = await w.compose(options);
      open(pinsFor(CHAIN, composed.pinVersion), composed.boundary, options.transport);
      return composed;
    },
    async restartGuarded(options = {}) {
      await transport.close(); journal.close(); journal = openDurableWalletJournal({ path, mode:'open' });
      return w.openGuarded(options);
    },
    async bind() { return (await transport.binding({ phase:'bind', address:key.address })).binding; },
    async lease(binding) { return transport.binding({ phase:'signature', address:key.address, binding:binding ?? await w.bind() }); },
    confirm: (signed) => transport.rpc({ method:'execute', params:[{ extra:'confirmTx', data:signed }] }, key.sdkAuth()),
    broadcast: (confirmed) => transport.rpc({ method:'execute', params:[{ extra:'broadcastTx', data:confirmed }] }, key.sdkAuth()),
    async send(nonce) {
      const { leaseId } = await w.lease(), signed = w.sign(nonce), confirmed = await w.confirm(signed);
      await transport.binding({ phase:'broadcast', address:key.address, leaseId, hash:signed.hash });
      await w.broadcast(confirmed);
      return signed;
    },
    /** Opens the guarded transport, takes the lease, confirms a first transfer and asks for the broadcast phase: the state a broadcast request starts from. */
    async confirmedPayment(options) {
      const g = await w.openGuarded(options), { leaseId } = await w.lease(), signed = w.sign(1), confirmed = await w.confirm(signed);
      await transport.binding({ phase:'broadcast', address:key.address, leaseId, hash:signed.hash });
      return { g, leaseId, signed, confirmed };
    },
  };
  t.after(async () => { await transport?.close(); journal.close(); setPurchaseAdmission('held'); rmSync(dir, { recursive:true, force:true }); });
  return w;
}
