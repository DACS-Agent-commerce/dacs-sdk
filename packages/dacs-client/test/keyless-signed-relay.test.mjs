// The keyless signed relay: a held SDK transport that confirms and broadcasts a buyer wallet's own signed TP-1 payment
// or claimed Agreement CREATE with no buyer key on the server. The real relay, transport, effect boundary and durable
// journal run in this process against a scripted TEST node, and the buyer wallet is a test key pair. No network, chain or funds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { bindTp1Profile, TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { api, ok, world, setPurchaseAdmission, T0 } from './helpers/tp1-node-fixture.mjs';
import { createAuthorityFixture } from './fixtures/tp1-authority-reader.mjs';
const { JOURNAL_METHODS } = await import('../src/wallet/keystore-wallet-opener.mjs');
const { nativePayloadDigest } = await import('../src/wallet/payload-helpers.mjs');
const { buildNativeTransferPayload, deriveStorageAddress } = await import('../src/dacs/wallet-transactions.mjs');
const { createEffectHistory } = await import('../src/wallet/effect-history.mjs');
const { nativeWalletLaneKey } = await import('../src/wallet/devnet-native-transport.mjs');
const { passContext, runInPassContext } = await import('../src/wallet/pass-context.mjs');

const CEILING = '50000000000';
const AMOUNT_OS = '2500000000';
// Three signed fees summing to 2.3 DEM.
const SIGNED_FEE = Object.freeze({ network_fee: '1000000000', rpc_fee: '1000000000', additional_fee: '300000000', rpc_address: null });
const FEE_SUM_OS = '2300000000';
const PAYEE = '0x' + '7'.repeat(64);
const REFUSED = 'keyless_relay_write_refused';
const OWNER_MEMBERS = ['currentLocal', 'getContext', 'acquireConnectionFence', 'fetchImpl'];
const RELAY_MEMBERS = ['binding', 'close', 'rpc', 'walletBinding'];
const JSON_TYPE = { 'content-type': 'application/json' };

const sha = value => createHash('sha256').update(value).digest('hex');
const isCode = code => error => error.code === code;
const isTypeError = code => error => error instanceof TypeError && error.message === code;
const allow = () => ({ currentAuthorization: () => true });
const execute = (extra, data) => ({ method: 'execute', params: [{ extra, data }] });
const nodeCall = (message, data = {}) => ({ method: 'nodeCall', params: [{ message, data }] });
const settles = promise => Promise.race([promise.then(() => true, () => true), new Promise(resolve => setImmediate(() => resolve(false)))]);
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
// The confirm and broadcast requests the node received.
const posted = (w, extra) => w.node.calls.filter(row => row.body?.params?.[0]?.extra === extra).length;
const posts = w => [posted(w, 'confirmTx'), posted(w, 'broadcastTx')];
const journalRows = async w => JSON.stringify(await w.journal().entries());

// A buyer wallet outside the server: its own ed25519 key signs its transactions and its RPC authentication.
function buyerWallet() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const address = '0x' + Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
  const signText = message => sign(null, Buffer.from(message, 'utf8'), privateKey).toString('hex');
  let stamp = Date.now();
  return {
    address,
    headers() { const identity = `ed25519:${address}`, timestamp = String(stamp++); return { identity, timestamp, signature: signText(sha(`${identity}:${timestamp}`)) }; },
    // The wallet's signature over the content's hash, or over `signedOver(hash)` for a test that signs other text.
    signed(content, { signedOver = hash => hash } = {}) {
      const hash = sha(JSON.stringify(content));
      return { content, signature: { type: 'ed25519', data: signText(signedOver(hash)) }, hash, status: '', blockNumber: null };
    },
    transferContent(nonce, { amountOs = AMOUNT_OS, fee = SIGNED_FEE, from = address } = {}) {
      const { content } = buildNativeTransferPayload({ from, to: PAYEE, amountOs, nonce, timestamp: T0, encoding: 'os-string' });
      return { ...content, from_ed25519_address: from, transaction_fee: structuredClone(fee) };
    },
  };
}

// The transfer a wallet names in its signature-phase request for `content`.
const declared = async content => ({ nonce: content.nonce, to: content.to, amountOs: content.data[1].args[1], payloadDigest: await nativePayloadDigest(content) });

// An Agreement CREATE of `wallet` at `nonce`, on the pins of the keyed session's transport (the relay's own pins).
function agreementCreate(w, wallet, nonce, { artifactKind = 'Agreement', network, networkBinding = w.session.wallet.getWriteProfile().transportBinding } = {}) {
  const jobId = '01M5YKPJG0248H248H248H248H', logicalAddress = 'dacs3:agreement:' + jobId, programName = logicalAddress.replace(/:/g, '%3A');
  const storageAddress = deriveStorageAddress(wallet.address, programName, nonce, ''), contentHash = sha(`TEST-agreement-${nonce}`);
  const operation = { operation: 'CREATE_STORAGE_PROGRAM', programName, storageAddress, salt: '', encoding: 'json', storageLocation: 'onchain', acl: { mode: 'public' },
    data: { jobId, terms: { price: { currency: 'DEM', amount: '1' } } }, metadata: { logicalAddress, contentHash, envelopeHash: contentHash, artifactKind, networkBinding } };
  return { type: 'storageProgram', from: wallet.address, to: storageAddress, amount: 0, data: ['storageProgram', operation], nonce, timestamp: T0,
    transaction_fee: { ...SIGNED_FEE }, network: network ?? networkBinding.network, chainIdentity: networkBinding.chainIdentity };
}

// A journal that forwards each of its six methods, with `hooks[name]` (when set) run first.
function hookedJournal(w, hooks = {}) {
  return Object.fromEntries(JOURNAL_METHODS.map(name => [name, async (...args) => { await hooks[name]?.(...args); return w.journal()[name](...args); }]));
}

// The owner's and journal's members, each logging its name before it runs, so a test can assert none was called.
function watched(w) {
  const calls = { owner: [], journal: [] };
  const spy = (target, names, log) => Object.fromEntries(names.map(name => [name, (...args) => { log.push(name); return target()[name](...args); }]));
  return { calls, owner: spy(() => w.owner, OWNER_MEMBERS, calls.owner), journal: spy(() => w.journal(), JOURNAL_METHODS, calls.journal) };
}

// A gate a hook awaits once armed: `reached` resolves when the hook runs, `release()` lets it go on.
function oneShotGate() {
  let release, reached;
  const gate = { armed: false, reached: new Promise(resolve => { reached = resolve; }), held: new Promise(resolve => { release = resolve; }) };
  gate.release = () => release();
  gate.pass = async () => { if (!gate.armed) return; gate.armed = false; reached(); await gate.held; };
  return gate;
}

async function relayWorld(t) {
  const w = await world(t);
  const wallet = buyerWallet(), state = { stop: () => false };
  const options = (extra = {}) => ({ admission: w.admission, owner: w.owner, journal: w.journal(), stopped: () => state.stop(), feeCeilingOs: CEILING, ...extra });
  const open = async (extra) => {
    const { nativeTransport } = await api.createKeylessSignedRelayTransport(options(extra));
    t.after(() => nativeTransport.close());
    return nativeTransport;
  };
  // A nonce no earlier transfer of this test used and the scripted node has not consumed, so each transfer has bytes of its own.
  let used = 0;
  const nonce = () => { used = Math.max(used, w.node.nonce) + 1; return used; };
  return { w, wallet, state, options, open, nonce };
}

// The buyer wallet's requests through one relay, as the plugin relays them.
function walletFlow(relay, wallet) {
  const { address } = wallet;
  const flow = {
    bind: async () => (await relay.walletBinding({ phase: 'bind', address }, wallet.headers())).binding,
    lease: async (transfer) => relay.walletBinding({ phase: 'signature', address, binding: await flow.bind(), ...(transfer ? { transfer } : {}) }, wallet.headers()),
    confirm: (tx, relayAuth = allow()) => relay.rpc(execute('confirmTx', tx), wallet.headers(), relayAuth),
    claim: (leaseId, hash) => relay.walletBinding({ phase: 'broadcast', address, leaseId, hash }, wallet.headers()),
    broadcast: (confirmation, relayAuth = allow()) => relay.rpc(execute('broadcastTx', confirmation), wallet.headers(), relayAuth),
    release: leaseId => relay.walletBinding({ phase: 'release', address, leaseId }, wallet.headers()),
    readback: hash => relay.binding({ phase: 'readback', address, hash }),
    // The wallet's whole send: lease, confirmation, broadcast claim, broadcast, then the readback that finishes the lane.
    async send(tx, transfer) {
      const lease = await flow.lease(transfer), confirmation = await flow.confirm(tx);
      await flow.claim(lease.leaseId, tx.hash);
      const answer = await flow.broadcast(confirmation);
      await flow.release(lease.leaseId);
      const read = await flow.readback(tx.hash);
      return { lease, confirmation, answer, read };
    },
  };
  return flow;
}

const laneOf = (w, address) => nativeWalletLaneKey({ network: TP1_APPROVED_IDENTITY_RECORD.network, chainIdentity: w.admission.binding.profile.chainIdentity }, address);
const historyStates = async (w, wallet, tx) => (await createEffectHistory({ journal: w.journal() }).read({ lane: laneOf(w, wallet.address), artifactHash: sha(JSON.stringify(tx)) })).map(record => record.state);

test('a keyless signed relay rejects every secret-bearing option and exposes no signer', async t => {
  const { w, options } = await relayWorld(t);
  const watch = watched(w), before = w.node.calls.length;
  const watchedOptions = () => ({ ...options(), owner: watch.owner, journal: watch.journal });
  const construct = extra => api.createKeylessSignedRelayTransport({ ...watchedOptions(), ...extra });
  const secrets = { key: new Uint8Array(32), mnemonic: 'TEST words', signer: () => {}, signRpc: () => {}, fetchImpl: () => {}, expected: {}, boundary: {}, secondOwner: watch.owner };
  for (const [name, value] of Object.entries(secrets)) await assert.rejects(construct({ [name]: value }), isTypeError('keyless_relay_options_invalid'), name);
  for (const name of ['owner', 'journal', 'stopped', 'feeCeilingOs']) {
    const without = watchedOptions();
    delete without[name];
    await assert.rejects(api.createKeylessSignedRelayTransport(without), isTypeError('keyless_relay_options_invalid'), `without ${name}`);
  }
  for (const name of OWNER_MEMBERS) await assert.rejects(construct({ owner: { ...watch.owner, [name]: undefined } }), isTypeError('keyless_relay_owner_invalid'), name);
  for (const name of JOURNAL_METHODS) await assert.rejects(construct({ journal: { ...watch.journal, [name]: undefined } }), isTypeError('keyless_relay_journal_invalid'), name);
  // The checks run in order: admission shape, option names, ceiling, stop, owner, journal.
  const withoutAdmission = watchedOptions();
  delete withoutAdmission.admission;
  await assert.rejects(api.createKeylessSignedRelayTransport(withoutAdmission), isTypeError('admission_required'));
  await assert.rejects(construct({ record: {}, key: new Uint8Array(32) }), isTypeError('admission_input_untrusted'));
  await assert.rejects(construct({ key: new Uint8Array(32), feeCeilingOs: '0' }), isTypeError('keyless_relay_options_invalid'));
  await assert.rejects(construct({ feeCeilingOs: '0', stopped: true }), isTypeError('keyless_relay_fee_ceiling_invalid'));
  await assert.rejects(construct({ stopped: true, owner: {} }), isTypeError('keyless_relay_stop_invalid'));
  await assert.rejects(construct({ owner: {}, journal: {} }), isTypeError('keyless_relay_owner_invalid'));
  assert.deepEqual(watch.calls, { owner: [], journal: [] }, 'no owner or journal member was called');
  assert.equal(w.node.calls.length, before, 'no node request was sent');

  const built = await api.createKeylessSignedRelayTransport(options());
  t.after(() => built.nativeTransport.close());
  assert.deepEqual(Object.keys(built), ['nativeTransport']);
  assert.equal(Object.isFrozen(built), true);
  const relay = built.nativeTransport;
  assert.equal(Object.isFrozen(relay), true);
  assert.deepEqual(Object.keys(relay).sort(), RELAY_MEMBERS);
  for (const name of ['key', 'sign', 'signer', 'signRpc', 'boundary', 'journal', 'owner', 'pins', 'profile', 'recoverStorageWrite', 'reopenWithheldBroadcast', 'cancelNativeTransfer', 'withWalletNonceLock']) {
    assert.equal(relay[name], undefined, name);
  }
});

test('binding admission stop and network fee ceiling each refuse before a keyless relay send', async t => {
  const { w, wallet, state, options, open, nonce } = await relayWorld(t);
  const watch = watched(w);
  const construct = extra => api.createKeylessSignedRelayTransport({ ...options(), owner: watch.owner, journal: watch.journal, ...extra });
  for (const feeCeilingOs of [50000000000, '0', '01', '1.5']) await assert.rejects(construct({ feeCeilingOs }), isTypeError('keyless_relay_fee_ceiling_invalid'), String(feeCeilingOs));
  for (const stopped of [false, 'no', undefined]) await assert.rejects(construct({ stopped }), isTypeError('keyless_relay_stop_invalid'), String(stopped));
  assert.deepEqual(watch.calls, { owner: [], journal: [] }, 'refused before the binding check reads the owner');
  const otherLocal = { ...w.owner.currentLocal(), endpoint: 'https://other.example.invalid/' };
  const foreign = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: otherLocal, readAuthority: createAuthorityFixture().read });
  await assert.rejects(construct({ admission: { binding: foreign, currentLocal: w.owner.currentLocal } }), error => error.code === 'profile_not_admitted' && error.cause !== undefined);
  await assert.rejects(construct({ admission: { binding: { ...w.admission.binding, recordDigest: '0'.repeat(64) }, currentLocal: w.owner.currentLocal } }), isCode('profile_not_admitted'));
  await assert.rejects(construct({ admission: { binding: w.admission.binding, currentLocal: () => otherLocal } }), isCode('tp1_local_binding_changed'));
  assert.deepEqual(watch.calls.journal, [], 'a refused construction reads no journal');

  const relay = await open(), flow = walletFlow(relay, wallet);
  // A stop at the lease hold grants no lease and leaves the owner's fence free.
  state.stop = () => true;
  await assert.rejects(flow.lease(), isCode('writes_stopped'));
  state.stop = () => false;
  const running = () => { state.stop = () => false; setPurchaseAdmission('testnet-tp1'); };
  const refusals = [
    [() => { state.stop = () => true; }, 'writes_stopped'],
    [() => { state.stop = () => { throw new Error('TEST-stop-read-failed'); }; }, 'stop_check_failed'],
    // The boundary's own stop read awaits this answer; the relay's last synchronous check does not accept it.
    [() => { state.stop = async () => false; }, 'stop_check_invalid'],
    [() => { state.stop = () => 'no'; }, 'stop_check_invalid'],
    [() => setPurchaseAdmission('held'), 'profile_not_admitted'],
  ];
  for (const [change, expected] of refusals) {
    const lease = await flow.lease(), tx = wallet.signed(wallet.transferContent(nonce())), before = posts(w);
    change();
    await assert.rejects(flow.confirm(tx), isCode(expected), expected);
    running();
    assert.deepEqual(posts(w), before, `${expected}: nothing sent`);
    await flow.release(lease.leaseId);
  }
  const sent = await flow.send(wallet.signed(wallet.transferContent(nonce())));
  assert.equal(sent.answer.result, 200, 'the same relay sends once nothing refuses');
  assert.deepEqual(posts(w), [1, 1]);
  await relay.close();

  const capped = await open({ feeCeilingOs: String(BigInt(FEE_SUM_OS) - 1n) }), cappedFlow = walletFlow(capped, wallet);
  const lease = await cappedFlow.lease(), tx = wallet.signed(wallet.transferContent(nonce()));
  await assert.rejects(cappedFlow.confirm(tx), isCode('write-fee-cap'));
  assert.deepEqual(posts(w), [1, 1], 'a fee over the ceiling sends nothing');
  await cappedFlow.release(lease.leaseId);
});

test('a held keyless signed relay refuses effects and requires a synchronous per-send authorization', async t => {
  const { w, wallet, open, nonce } = await relayWorld(t);
  const relay = await open(), flow = walletFlow(relay, wallet), { address } = wallet;
  const sent = wallet.signed(wallet.transferContent(nonce()));
  await flow.send(sent);
  setPurchaseAdmission('held');
  const before = w.node.calls.length;
  const requests = [{ phase: 'bind', address }, { phase: 'signature', address, binding: {} }, { phase: 'release', address, leaseId: 'TEST-lease' },
    { phase: 'broadcast', address, leaseId: 'TEST-lease', hash: sent.hash }, { phase: 'readback', address, hash: sent.hash }];
  for (const request of requests) await assert.rejects(relay.walletBinding(request, wallet.headers()), isCode('profile_not_admitted'), request.phase);
  for (const message of ['getNetworkInfo', 'getNetworkParameters', 'getAddressNonce']) await assert.rejects(relay.rpc(nodeCall(message, { address }), {}), isCode('profile_not_admitted'), message);
  await assert.rejects(flow.confirm(sent), isCode('profile_not_admitted'));
  assert.equal(w.node.calls.length, before, 'no node request while held');
  assert.equal((await flow.readback(sent.hash)).disposition, 'included', 'the binding readback still runs while held');
  setPurchaseAdmission('testnet-tp1');

  const lease = await flow.lease(), tx = wallet.signed(wallet.transferContent(nonce())), unsent = posts(w);
  await assert.rejects(relay.rpc(execute('confirmTx', tx), wallet.headers()), isTypeError('relay_authorization_invalid'), 'missing');
  const malformed = [null, {}, { currentAuthorization: true }, { currentAuthorization: () => true, extra: 1 }, Object.assign(Object.create({ inherited: true }), { currentAuthorization: () => true })];
  for (const relayAuth of malformed) await assert.rejects(flow.confirm(tx, relayAuth), isTypeError('relay_authorization_invalid'), JSON.stringify(relayAuth));
  await assert.rejects(flow.confirm(tx, { currentAuthorization: () => false }), isCode('context_authorization_refused'));
  await assert.rejects(flow.confirm(tx, { currentAuthorization: async () => true }), isCode('context_authorization_refused'));
  const withdrawn = new Error('TEST-grant-withdrawn');
  await assert.rejects(flow.confirm(tx, { currentAuthorization: () => { throw withdrawn; } }), error => error === withdrawn);
  const job = passContext({ operationClass: 'job-create', currentAuthorization: () => true });
  await assert.rejects(runInPassContext(job, () => flow.confirm(tx)), isCode('relay_authorization_nested'));
  for (const phase of ['sign', 'execute', 'cancel']) await assert.rejects(relay.walletBinding({ phase, address }, wallet.headers()), isCode(REFUSED), phase);
  assert.deepEqual(posts(w), unsent, 'no execute request was sent');
  await flow.confirm(tx);
  assert.deepEqual(posts(w), [unsent[0] + 1, unsent[1]], 'a refused pass leaves the bytes free for one authorized confirmation');
  await flow.release(lease.leaseId);
});

test("a keyless relay accepts only the buyer wallet's signed payment and claimed Agreement CREATE", async t => {
  const { w, wallet, open, nonce } = await relayWorld(t);
  const relay = await open(), flow = walletFlow(relay, wallet);
  const content = wallet.transferContent(nonce()), payment = await flow.send(wallet.signed(content), await declared(content));
  assert.equal(payment.answer.result, 200);
  assert.deepEqual(posts(w), [1, 1]);
  const create = await flow.send(wallet.signed(agreementCreate(w, wallet, nonce())));
  assert.equal(create.answer.result, 200);
  assert.deepEqual(posts(w), [2, 2]);

  // Each row alters one signed input of a transaction the wallet would otherwise send; the inner refuses it before its confirmation.
  const other = buyerWallet(), otherFlow = walletFlow(relay, other);
  const rows = [
    ['sender', otherFlow, () => wallet.signed(other.transferContent(nonce()))],
    ['hash', flow, () => ({ ...wallet.signed(wallet.transferContent(nonce())), hash: sha('TEST-other-content') })],
    ['signature', flow, () => wallet.signed(wallet.transferContent(nonce()), { signedOver: () => 'TEST-other-text' })],
    ['network', flow, () => wallet.signed(agreementCreate(w, wallet, nonce(), { network: 'TEST-other-network' }))],
    ['seller artifact', flow, () => wallet.signed(agreementCreate(w, wallet, nonce(), { artifactKind: 'Listing' }))],
    ['create claim', flow, () => wallet.signed(agreementCreate(w, wallet, nonce(), { networkBinding: { ...w.session.wallet.getWriteProfile().transportBinding, bindingId: 'TEST-other-binding' } }))],
  ];
  for (const [name, rowFlow, build] of rows) {
    const lease = await rowFlow.lease();
    await assert.rejects(rowFlow.confirm(build()), isCode('native_only'), name);
    assert.deepEqual(posts(w), [2, 2], `${name}: no confirmation and no broadcast`);
    await rowFlow.release(lease.leaseId);
  }

  // Altered confirmation bytes, and a node fee view other than the signed fees, arise after the one confirmation: no broadcast.
  const altered = wallet.signed(wallet.transferContent(nonce())), lease = await flow.lease(), confirmation = await flow.confirm(altered);
  await flow.claim(lease.leaseId, altered.hash);
  await assert.rejects(flow.broadcast({ ...confirmation, extra: 'TEST-altered' }), isCode('native_confirmation_required'));
  assert.deepEqual(posts(w), [3, 2]);
  await flow.release(lease.leaseId);
  w.node.intercept = row => row.body?.params?.[0]?.extra !== 'confirmTx' ? undefined
    : new Response(JSON.stringify(ok({ data: { valid: true, gas_operation: { fees: { network_fee: '0', rpc_fee: '0', additional_fee: '0' } }, transaction: row.body.params[0].data } })), { headers: JSON_TYPE });
  const viewed = wallet.signed(wallet.transferContent(nonce())), viewLease = await flow.lease(), viewedConfirmation = await flow.confirm(viewed);
  w.node.intercept = null;
  await flow.claim(viewLease.leaseId, viewed.hash);
  await assert.rejects(flow.broadcast(viewedConfirmation), isCode('fee_view_mismatch'));
  assert.deepEqual(posts(w), [4, 2]);
});

test('an uncertain keyless relay outcome is durable and readback only after restart', async t => {
  const rw = await relayWorld(t), { w, wallet, nonce } = rw;
  let relay = await rw.open(), flow = walletFlow(relay, wallet);
  const unsure = [];
  // Leaves one confirmation of a fresh transfer uncertain with `produce`, then repeats it in the same lease: refused, nothing sent, nothing written.
  async function uncertain(name, produce, viaFlow = flow) {
    const tx = wallet.signed(wallet.transferContent(nonce())), lease = await viaFlow.lease();
    await produce(viaFlow, tx);
    const sent = posts(w), rows = await journalRows(w);
    await assert.rejects(viaFlow.confirm(tx), isCode('eb_readback_required'), name);
    assert.deepEqual(posts(w), sent, `${name}: no second confirmation`);
    assert.equal(await journalRows(w), rows, `${name}: the journal is unchanged`);
    await viaFlow.release(lease.leaseId);
    unsure.push([name, tx]);
  }
  const cutOn = state => hookedJournal(w, { appendUnderLock: (_lane, key) => { if (key.endsWith(`/${state}`)) throw new Error('TEST-journal-cut'); } });
  await uncertain('answer lost', async (viaFlow, tx) => { w.node.mode = 'confirm-lost'; await assert.rejects(viaFlow.confirm(tx)); w.node.mode = 'accept'; });
  await uncertain('not a valid confirmation', async (viaFlow, tx) => {
    w.node.mode = 'confirm-refuse';
    assert.equal((await viaFlow.confirm(tx)).response.data.valid, false);
    w.node.mode = 'accept';
    assert.deepEqual(await historyStates(w, wallet, tx), ['signed', 'confirm-started', 'confirm-unknown']);
  });
  const ackCut = await rw.open({ journal: cutOn('confirm-acknowledged') });
  await uncertain('acknowledgement not persisted', async (viaFlow, tx) => { await assert.rejects(viaFlow.confirm(tx), isCode('eb_ack_not_persisted')); }, walletFlow(ackCut, wallet));
  await ackCut.close();
  // The process stops after confirm-started: the pass was refused, and its withheld record never written.
  const withheldCut = await rw.open({ journal: cutOn('confirm-withheld') });
  await uncertain('stopped after confirm-started', async (viaFlow, tx) => {
    await assert.rejects(viaFlow.confirm(tx, { currentAuthorization: () => false }), isCode('context_authorization_refused'));
    assert.deepEqual(await historyStates(w, wallet, tx), ['signed', 'confirm-started']);
  }, walletFlow(withheldCut, wallet));
  await withheldCut.close();
  assert.deepEqual(posts(w), [3, 0], 'three confirmations reached the node, one was refused before it');
  await assert.rejects(flow.readback(unsure[0][1].hash), isCode('not_issued'), 'a confirmation alone is not issued; that proves nothing about a send');

  // A cut at the signed record leaves nothing uncertain: the same bytes confirm once through a new lease.
  const signedCut = await rw.open({ journal: cutOn('confirm-started') }), signedFlow = walletFlow(signedCut, wallet);
  const signedOnly = wallet.signed(wallet.transferContent(nonce())), cutLease = await signedFlow.lease();
  await assert.rejects(signedFlow.confirm(signedOnly));
  await signedFlow.release(cutLease.leaseId);
  await signedCut.close();
  const retry = await flow.lease();
  assert.equal((await flow.confirm(signedOnly)).response.data.valid, true);
  assert.deepEqual(posts(w), [4, 0]);
  await flow.release(retry.leaseId);

  // Issued broadcasts of two wallets: one the node applied before its answer was lost, one the node never saw. Neither is broadcast again.
  const broadcastLost = async (lostFlow, tx, intercept) => {
    const lease = await lostFlow.lease(), confirmation = await lostFlow.confirm(tx);
    await lostFlow.claim(lease.leaseId, tx.hash);
    w.node.intercept = intercept;
    await assert.rejects(lostFlow.broadcast(confirmation));
    w.node.intercept = null; w.node.mode = 'accept';
    await assert.rejects(lostFlow.broadcast(confirmation), 'a repeat in the same lease');
    await lostFlow.release(lease.leaseId);
  };
  const otherWallet = buyerWallet();
  const applied = wallet.signed(wallet.transferContent(nonce()));
  w.node.mode = 'drop';
  await broadcastLost(flow, applied, null);
  const unseen = otherWallet.signed(otherWallet.transferContent(nonce()));
  await broadcastLost(walletFlow(relay, otherWallet), unseen, row => { if (row.body?.params?.[0]?.extra === 'broadcastTx') throw new Error('TEST-broadcast-timeout'); });
  const broadcasts = posted(w, 'broadcastTx');

  // After a restart, a new relay over the same journal refuses every uncertain confirmation and reads the broadcasts back.
  const restarted = await w.restart();
  relay = await rw.open({ owner: restarted.owner, admission: restarted.admission, journal: w.journal() });
  flow = walletFlow(relay, wallet);
  const otherFlow = walletFlow(relay, otherWallet);
  assert.equal((await flow.readback(applied.hash)).disposition, 'included');
  assert.equal((await otherFlow.readback(unseen.hash)).disposition, 'pending');
  await assert.rejects(otherFlow.lease(), isCode('outcome_unknown'), 'the pending lane is read back, never signed over');
  for (const [name, tx] of unsure) {
    const lease = await flow.lease(), sent = posts(w), rows = await journalRows(w);
    await assert.rejects(flow.confirm(tx), isCode('eb_readback_required'), `${name} after restart`);
    assert.deepEqual(posts(w), sent, `${name}: nothing sent after restart`);
    assert.equal(await journalRows(w), rows, `${name}: the journal is unchanged after restart`);
    await flow.release(lease.leaseId);
  }
  assert.equal(posted(w, 'broadcastTx'), broadcasts, 'no second broadcast');

  // An unreadable or corrupt history refuses; it is never read as empty.
  await relay.close();
  const corruptWallet = buyerWallet(), unreadable = { on: false };
  const shaky = await rw.open({ owner: restarted.owner, admission: restarted.admission, journal: hookedJournal(w, { entries: () => { if (unreadable.on) throw new Error('TEST-journal-unreadable'); } }) });
  const shakyFlow = walletFlow(shaky, corruptWallet), corrupt = corruptWallet.signed(corruptWallet.transferContent(nonce()));
  const lease = await shakyFlow.lease(), sent = posts(w);
  unreadable.on = true;
  await assert.rejects(shakyFlow.confirm(corrupt), isCode('eb_history_unavailable'));
  unreadable.on = false;
  await assert.rejects(shakyFlow.confirm(corrupt, { currentAuthorization: () => false }), isCode('context_authorization_refused'));
  await w.journal().put(`eb/${encodeURIComponent(laneOf(w, corruptWallet.address))}/${sha(JSON.stringify(corrupt))}/TEST-pass/confirm-unknown`, { TEST: 'not a record' });
  await assert.rejects(shakyFlow.confirm(corrupt), isCode('eb_history_unavailable'));
  assert.deepEqual(posts(w), sent);
  await shakyFlow.release(lease.leaseId);
});

test('a keyless relay bounds source replies and leaves keyed and passive transports unchanged', async t => {
  const { w, wallet, open, nonce } = await relayWorld(t);
  const relay = await open(), flow = walletFlow(relay, wallet);
  const LIMIT = 4 * 1024 * 1024;
  const reply = size => { const head = '{"result":200,"response":"', tail = '","require_reply":false,"extra":null}'; return head + 'a'.repeat(size - head.length - tail.length) + tail; };
  const answerWith = text => { w.node.intercept = row => (row.body?.params?.[0]?.message === 'getNetworkParameters' ? new Response(text, { headers: JSON_TYPE }) : undefined); };
  answerWith(reply(LIMIT));
  assert.equal((await relay.rpc(nodeCall('getNetworkParameters'), {})).result, 200, 'a reply of exactly 4 MiB is read');
  answerWith(reply(LIMIT + 1));
  await assert.rejects(relay.rpc(nodeCall('getNetworkParameters'), {}), error => error.kind === 'invalid' && /byte limit/.test(error.message));
  answerWith('TEST-not-json');
  await assert.rejects(relay.rpc(nodeCall('getNetworkParameters'), {}), error => error.kind === 'invalid');
  w.node.intercept = null;

  // A saved acceptance the node cannot show is not reported as included.
  const saved = wallet.signed(wallet.transferContent(nonce())), binding = await flow.bind();
  const accepted = { stage: 'broadcast-accepted', hash: saved.hash, nonce: saved.content.nonce, signedTransaction: saved, networkBinding: binding };
  await w.journal().put(`devnet/native-transfer/${saved.hash}`, accepted);
  await w.journal().put(laneOf(w, wallet.address), accepted);
  assert.equal((await flow.readback(saved.hash)).disposition, 'pending');

  // close() waits for a read in flight; later calls reject transport_closed and the owner and journal stay open.
  const gate = oneShotGate();
  gate.armed = true;
  w.node.intercept = async row => { if (row.body?.params?.[0]?.message === 'getNetworkInfo') await gate.pass(); };
  const read = relay.rpc(nodeCall('getNetworkInfo'), {});
  await gate.reached;
  const closing = relay.close();
  assert.equal(await settles(closing), false, 'close waits for the read');
  gate.release();
  assert.equal((await read).result, 200);
  await closing;
  await relay.close();
  w.node.intercept = null;
  await assert.rejects(relay.rpc(nodeCall('getNetworkInfo'), {}), isCode('transport_closed'));
  await assert.rejects(relay.walletBinding({ phase: 'bind', address: wallet.address }, wallet.headers()), isCode('transport_closed'));
  assert.equal(await w.journal().get('TEST-absent-key'), undefined);
  assert.equal((await w.owner.getContext()).endpoint, w.owner.currentLocal().endpoint);

  // The passive keyless view still refuses execute, and the keyed session still signs and sends.
  const passive = await api.createKeylessAgreementTransport({ admission: w.admission, owner: w.owner, journal: w.journal(), walletAddress: wallet.address });
  t.after(() => passive.close());
  await assert.rejects(passive.rpc(execute('confirmTx', saved), {}), isCode('keyless_transport_write_refused'));
  const keyed = await w.send();
  assert.equal(keyed.success, true, JSON.stringify(keyed));
});

test('a keyless relay rechecks authorization after waits at every execute byte', async t => {
  const rw = await relayWorld(t), { w, wallet, state, nonce } = rw;
  // The owner's context read and the journal's writes can each be held once a record of `armedAfter` is appended.
  const hooks = { armedAfter: null, contextGate: null, local: null, putGate: null };
  const owner = { currentLocal: () => hooks.local ?? w.owner.currentLocal(), acquireConnectionFence: (...args) => w.owner.acquireConnectionFence(...args),
    fetchImpl: (...args) => w.owner.fetchImpl(...args),
    getContext: async () => { await hooks.contextGate?.pass(); return w.owner.getContext(); } };
  const journal = hookedJournal(w, {
    appendUnderLock: (_lane, key) => { if (hooks.armedAfter && key.endsWith(`/${hooks.armedAfter}`)) { hooks.contextGate.armed = true; hooks.armedAfter = null; } },
    put: async key => { if (key.startsWith('devnet/native-transfer/')) await hooks.putGate?.pass(); },
  });
  const relay = await rw.open({ owner, journal, admission: { binding: w.admission.binding, currentLocal: () => owner.currentLocal() } });
  const flow = walletFlow(relay, wallet);
  let grant = true;
  const granted = { currentAuthorization: () => grant };
  const otherLocal = { ...w.owner.currentLocal(), endpoint: 'https://other.example.invalid/' };
  const changes = [['grant', () => { grant = false; }, 'context_authorization_refused'], ['stop', () => { state.stop = () => true; }, 'writes_stopped'],
    ['binding', () => { hooks.local = otherLocal; }, 'tp1_local_binding_changed']];
  const restore = () => { grant = true; state.stop = () => false; hooks.local = null; };
  // Holds the context read right before the request, applies `change`, then lets the request go on.
  async function changedDuringWait(armedAfter, change, run) {
    hooks.contextGate = oneShotGate(); hooks.armedAfter = armedAfter;
    const outcome = run().then(value => ({ value }), error => ({ error }));
    await hooks.contextGate.reached;
    change();
    hooks.contextGate.release();
    const settled = await outcome;
    restore();
    return settled;
  }
  for (const [name, change, expected] of changes) {
    const tx = wallet.signed(wallet.transferContent(nonce())), lease = await flow.lease(), before = posts(w);
    const { error, value } = await changedDuringWait('confirm-started', change, () => flow.confirm(tx, granted));
    assert.equal(error?.code, expected, `${name} at confirmation: ${JSON.stringify(value)}`);
    assert.deepEqual(posts(w), before, `${name}: no confirmation was sent`);
    assert.deepEqual((await historyStates(w, wallet, tx)).slice(-2), ['confirm-started', 'confirm-withheld'], name);
    await flow.release(lease.leaseId);
  }
  // At broadcast: a context wait after dispatch-started, and the journal's intent write.
  const prepared = async () => {
    const tx = wallet.signed(wallet.transferContent(nonce())), lease = await flow.lease(), confirmation = await flow.confirm(tx, granted);
    await flow.claim(lease.leaseId, tx.hash);
    return { tx, lease, confirmation };
  };
  for (const [name, change, expected] of changes) {
    const { tx, lease, confirmation } = await prepared(), before = posts(w);
    const { error } = await changedDuringWait('dispatch-started', change, () => flow.broadcast(confirmation, granted));
    assert.equal(error?.code, expected, `${name} at broadcast`);
    assert.deepEqual(posts(w), before, `${name}: no broadcast was sent`);
    assert.deepEqual((await historyStates(w, wallet, tx)).slice(-2), ['dispatch-started', 'dispatch-withheld'], name);
    await flow.release(lease.leaseId);
    assert.equal((await flow.readback(tx.hash)).disposition, 'failed', `${name}: read back as never sent`);
  }
  const journalWait = await prepared(), beforeJournal = posts(w);
  hooks.putGate = oneShotGate(); hooks.putGate.armed = true;
  const held = flow.broadcast(journalWait.confirmation, granted).then(value => ({ value }), error => ({ error }));
  await hooks.putGate.reached;
  grant = false;
  hooks.putGate.release();
  assert.equal((await held).error?.code, 'context_authorization_refused');
  restore();
  assert.deepEqual(posts(w), beforeJournal, 'a grant withdrawn during the intent write sends nothing');
  await flow.release(journalWait.lease.leaseId);

  // A send that already began stays sent: its answer returns and readback shows it.
  const began = await prepared(), requestGate = oneShotGate();
  requestGate.armed = true;
  w.node.intercept = async row => { if (row.body?.params?.[0]?.extra === 'broadcastTx') await requestGate.pass(); };
  const sending = flow.broadcast(began.confirmation, granted);
  await requestGate.reached;
  grant = false;
  requestGate.release();
  assert.equal((await sending).result, 200);
  w.node.intercept = null;
  restore();
  await flow.release(began.lease.leaseId);
  assert.equal((await flow.readback(began.tx.hash)).disposition, 'included');
});

test('a keyless relay keeps the signature lease and broadcast claim on the actual owner', async t => {
  const rw = await relayWorld(t), { w, wallet, nonce } = rw;
  const fences = { acquired: 0 }, context = { other: false };
  const owner = { currentLocal: () => w.owner.currentLocal(), fetchImpl: (...args) => w.owner.fetchImpl(...args),
    acquireConnectionFence: (...args) => { fences.acquired++; return w.owner.acquireConnectionFence(...args); },
    getContext: async () => ({ ...await w.owner.getContext(), ...(context.other ? { endpoint: 'https://other.example.invalid/' } : {}) }) };
  const relay = await rw.open({ owner }), flow = walletFlow(relay, wallet);

  const unsent = async (name, run, expected) => { const before = posts(w); await assert.rejects(run(), isCode(expected), name); assert.deepEqual(posts(w), before, `${name}: nothing sent`); };
  let tx = wallet.signed(wallet.transferContent(nonce())), lease = await flow.lease();
  const secondLease = () => relay.walletBinding({ phase: 'signature', address: wallet.address, binding: lease.binding }, wallet.headers());
  await unsent('second lease of the wallet', secondLease, 'wallet_fenced');
  context.other = true;
  await unsent('another owner context', () => flow.confirm(tx), 'transport_mismatch');
  context.other = false;
  const confirmation = await flow.confirm(tx);
  await unsent('a foreign lease id', () => flow.claim('TEST-foreign-lease', tx.hash), 'native_confirmation_required');
  await unsent('no broadcast claim', () => flow.broadcast(confirmation), 'native_confirmation_required');
  await flow.release(lease.leaseId);

  // An expired lease confirms and claims nothing.
  tx = wallet.signed(wallet.transferContent(nonce()));
  lease = await flow.lease();
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(31_000);
  await unsent('an expired lease', () => flow.confirm(tx), 'network_binding_required');
  t.mock.timers.reset();
  await flow.release(lease.leaseId);

  // A valid claim keeps the one fence its lease took; a lane with an issued broadcast refuses the next lease.
  tx = wallet.signed(wallet.transferContent(nonce()));
  const acquiredBefore = fences.acquired;
  lease = await flow.lease();
  const leased = fences.acquired;
  const valid = await flow.confirm(tx);
  await flow.claim(lease.leaseId, tx.hash);
  w.node.mode = 'drop';
  await assert.rejects(flow.broadcast(valid));
  w.node.mode = 'accept';
  assert.equal(fences.acquired - leased, 0, 'confirm, claim and broadcast run on the lease fence');
  assert.ok(leased - acquiredBefore >= 1);
  await flow.release(lease.leaseId);
  await unsent('a pending lane of the same wallet', () => flow.lease(), 'outcome_unknown');
});

test('a keyless relay refuses non-native execute and server proof overrides', async t => {
  const { w, wallet, options } = await relayWorld(t);
  const watch = watched(w), { address } = wallet;
  const { nativeTransport: relay } = await api.createKeylessSignedRelayTransport({ ...options(), owner: watch.owner, journal: watch.journal });
  t.after(() => relay.close());
  const reset = () => { watch.calls.owner.length = 0; watch.calls.journal.length = 0; return w.node.calls.length; };
  const hash = 'a'.repeat(64);
  let before = reset();
  const nonNative = [execute('confirmTx', { content: { type: 'web2', from: address }, hash, signature: { type: 'ed25519', data: 'TEST' } }),
    execute('broadcastTx', { response: { data: { transaction: { content: { type: 'l2ps', from: address }, hash } } } })];
  for (const body of nonNative) await assert.rejects(relay.rpc(body, wallet.headers(), allow()), isCode('native_only'), body.params[0].extra);
  assert.deepEqual(watch.calls.journal, [], 'no journal access');
  assert.equal(w.node.calls.length, before, 'no node request');

  before = reset();
  const bodies = [{ method: 'execute', params: [{ extra: 'confirmTx', data: {} }, { extra: 'confirmTx', data: {} }] }, { method: 'execute', params: [] },
    execute('sendTx', {}), { method: 'execute', params: { extra: 'confirmTx' } }, nodeCall('getTxByHash', { hash }), nodeCall('getTweet'),
    { method: 'nodeCall', params: [{ message: 'getNetworkInfo' }, { message: 'getNetworkInfo' }] }, null, 'getNetworkInfo'];
  for (const body of bodies) await assert.rejects(relay.rpc(body, {}, allow()), isCode(REFUSED), JSON.stringify(body));
  await assert.rejects(relay.rpc(nodeCall('getNetworkInfo'), {}, allow()), isCode(REFUSED), 'a read takes no relay authorization');
  await assert.rejects(relay.rpc(execute('confirmTx', {}), {}, allow(), allow()), isCode(REFUSED), 'one relay authorization only');
  const transfer = { nonce: 1, to: '0x' + '2'.repeat(64), amountOs: '1', payloadDigest: hash };
  const requests = [{ phase: 'readback', address, hash, writeProof: {} }, { phase: 'readback', address, hash, failedNonceFence: 1 }, { phase: 'readback', address, hash, consumedByHash: hash },
    { phase: 'release', address, leaseId: 'TEST-lease', failedNonceFence: 1 }, { phase: 'bind', address, extra: true }, { phase: 'bind' },
    { phase: 'signature', address, binding: {}, transfer: { ...transfer, extra: 1 } }, { phase: 'signature', address, binding: {}, transfer: [] },
    { phase: 'signature', address, binding: {}, transfer: undefined }, { phase: 'release', address, leaseId: 1 }, { phase: 'readback', address, hash: 1 },
    { phase: 'broadcast', address, leaseId: 'TEST-lease', hash, transfer }, { phase: 'sign', address }, null, 'readback'];
  for (const request of requests) await assert.rejects(relay.walletBinding(request, wallet.headers()), isCode(REFUSED), `walletBinding ${JSON.stringify(request)}`);
  for (const request of [{ phase: 'release', address, leaseId: 'TEST-lease' }, { phase: 'bind', address }, ...requests]) {
    await assert.rejects(relay.binding(request), isCode(REFUSED), `binding ${JSON.stringify(request)}`);
  }
  assert.deepEqual(watch.calls, { owner: [], journal: [] }, 'refused before the owner or the journal');
  assert.equal(w.node.calls.length, before, 'no node request');
});

test('two keyless relay facades serialize confirmation of the same signed bytes', async t => {
  const rw = await relayWorld(t), { w, wallet, nonce } = rw;
  // A second owner on the same node, bound on its own; each facade holds its own lease of the same wallet.
  const secondOwner = api.createNodeTransportOwner({ endpoint: 'https://rpc.example.invalid/', transportAuthority: 'vector-authority', fetchImpl: w.node.fetch });
  t.after(() => secondOwner.close());
  const secondBinding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: secondOwner.currentLocal(), readAuthority: w.authority.read });
  // Each facade's journal holds its first lane acquisition, the confirmation's, until both have passed their first history read.
  const gates = [oneShotGate(), oneShotGate()];
  const journalFor = gate => hookedJournal(w, { withOwnedOrAcquiredLane: () => gate.pass() });
  const first = await rw.open({ journal: journalFor(gates[0]) });
  const second = await rw.open({ journal: journalFor(gates[1]), owner: secondOwner, admission: { binding: secondBinding, currentLocal: secondOwner.currentLocal } });
  const flows = [walletFlow(first, wallet), walletFlow(second, wallet)];
  const tx = wallet.signed(wallet.transferContent(nonce()));
  const leases = [await flows[0].lease(), await flows[1].lease()];
  for (const gate of gates) gate.armed = true;
  const outcomes = flows.map(flow => flow.confirm(tx).then(value => ({ value }), error => ({ error })));
  await Promise.all(gates.map(gate => gate.reached));
  for (const gate of gates) gate.release();
  const settled = await Promise.all(outcomes);
  assert.equal(posted(w, 'confirmTx'), 1, 'one confirmation request');
  assert.equal(settled.filter(({ value }) => value?.response?.data?.valid === true).length, 1);
  assert.deepEqual(settled.filter(({ error }) => error).map(({ error }) => error.code), ['eb_readback_required']);
  const states = await historyStates(w, wallet, tx);
  assert.deepEqual(states.filter(state => state === 'signed'), ['signed'], 'one signed record');
  assert.deepEqual(states.filter(state => state === 'confirm-acknowledged'), ['confirm-acknowledged']);
  await flush();
  for (const [index, lease] of leases.entries()) await flows[index].release(lease.leaseId);
});

test('a keyless relay fee ceiling bounds the signed network fee only and the price stays bound to the approved amount', async t => {
  const { w, wallet, open, nonce } = await relayWorld(t);
  // One relay per ceiling; each sends or refuses one transfer and is closed before the next takes the owner's fence.
  async function underCeiling(feeCeilingOs, run) {
    const relay = await open({ feeCeilingOs });
    try { return await run(walletFlow(relay, wallet)); } finally { await relay.close(); }
  }
  const refusedAtSigning = async (feeCeilingOs, fee) => underCeiling(feeCeilingOs, async flow => {
    const tx = wallet.signed(wallet.transferContent(nonce(), { fee })), before = posts(w);
    await flow.lease();
    await assert.rejects(flow.confirm(tx), isCode('write-fee-cap'), feeCeilingOs);
    assert.deepEqual(posts(w), before, `${feeCeilingOs}: nothing sent`);
    assert.equal((await historyStates(w, wallet, tx)).includes('signed'), false, `${feeCeilingOs}: no signed record`);
  });
  // (a) The ceiling equal to the fee sum sends; one unit under it refuses at signing.
  await underCeiling(FEE_SUM_OS, async flow => { assert.equal((await flow.send(wallet.signed(wallet.transferContent(nonce())))).answer.result, 200); });
  assert.deepEqual(posts(w), [1, 1]);
  await refusedAtSigning(String(BigInt(FEE_SUM_OS) - 1n), SIGNED_FEE);
  // (b) An amount far above the ceiling passes the hold, a takeover's re-hold, signing, confirmation and broadcast.
  await underCeiling(FEE_SUM_OS, async flow => {
    const tx = wallet.signed(wallet.transferContent(nonce(), { amountOs: '90000000000' }));
    const withheld = await flow.lease();
    await assert.rejects(flow.confirm(tx, { currentAuthorization: () => false }), isCode('context_authorization_refused'));
    await flow.release(withheld.leaseId);
    const lease = await flow.lease(), confirmation = await flow.confirm(tx);
    await flow.claim(lease.leaseId, tx.hash);
    assert.equal((await flow.broadcast(confirmation)).result, 200);
    await flow.release(lease.leaseId);
    assert.equal((await flow.readback(tx.hash)).disposition, 'included');
  });
  assert.deepEqual(posts(w), [2, 2]);
  // (c) A signed transfer one unit above the transfer the wallet declared is refused.
  await underCeiling(CEILING, async flow => {
    const at = nonce(), declaredContent = wallet.transferContent(at), signedContent = wallet.transferContent(at, { amountOs: String(BigInt(AMOUNT_OS) + 1n) });
    await flow.lease(await declared(declaredContent));
    await assert.rejects(flow.confirm(wallet.signed(signedContent)), isCode('transfer_mismatch'));
  });
  assert.deepEqual(posts(w), [2, 2]);
  // (d) The amount plus the fees over the ceiling, each within it, sends: the price is not added to the fee.
  await underCeiling(AMOUNT_OS, async flow => { assert.equal((await flow.send(wallet.signed(wallet.transferContent(nonce())))).answer.result, 200); });
  assert.deepEqual(posts(w), [3, 3]);
  // (e) Each fee under the ceiling but their sum over it refuses: the sum is bounded, not each fee.
  await refusedAtSigning('1500000000', SIGNED_FEE);
  assert.deepEqual(posts(w), [3, 3]);
});

test('a keyless relay refuses a signed payment whose fee field is missing or not a decimal before any node request', async t => {
  const { w, wallet, open, nonce } = await relayWorld(t);
  const relay = await open({ feeCeilingOs: FEE_SUM_OS }), flow = walletFlow(relay, wallet);
  const refused = async (name, content) => {
    const tx = wallet.signed(content), lease = await flow.lease(), before = posts(w);
    await assert.rejects(flow.confirm(tx), isCode('write-fee-cap'), name);
    assert.deepEqual(posts(w), before, `${name}: nothing sent`);
    assert.equal((await historyStates(w, wallet, tx)).includes('signed'), false, `${name}: no signed record`);
    await flow.release(lease.leaseId);
  };
  const withoutFee = wallet.transferContent(nonce());
  delete withoutFee.transaction_fee;
  await refused('no transaction_fee', withoutFee);
  const malformed = [null, '', '01', '-1', '1.5', '1e9', '0x1', 'abc', 1.5, -1, {}, []];
  for (const member of ['network_fee', 'rpc_fee', 'additional_fee']) {
    const withoutMember = { ...SIGNED_FEE };
    delete withoutMember[member];
    await refused(`${member} missing`, wallet.transferContent(nonce(), { fee: withoutMember }));
    for (const value of malformed) await refused(`${member} ${JSON.stringify(value)}`, wallet.transferContent(nonce(), { fee: { ...SIGNED_FEE, [member]: value } }));
  }
  // A whole-DEM number reads as that many DEM, as the signed fees always are.
  const sent = await flow.send(wallet.signed(wallet.transferContent(nonce(), { fee: { ...SIGNED_FEE, network_fee: 1 } })));
  assert.equal(sent.answer.result, 200);
  assert.deepEqual(posts(w), [1, 1]);
});

test('a keyless relay refuses a wallet request with a hidden, symbol or accessor member before any node request', async t => {
  const { w, wallet, open } = await relayWorld(t);
  const relay = await open(), { address } = wallet, hash = 'a'.repeat(64);
  const transfer = { nonce: 1, to: PAYEE, amountOs: AMOUNT_OS, payloadDigest: 'b'.repeat(64) };
  const wallets = [{ phase: 'bind', address }, { phase: 'signature', address, binding: {} }, { phase: 'signature', address, binding: {}, transfer },
    { phase: 'broadcast', address, leaseId: 'TEST-lease', hash }, { phase: 'release', address, leaseId: 'TEST-lease' }, { phase: 'readback', address, hash }];
  // Each disguise leaves the request's enumerable string members exactly as a valid request has them.
  const disguises = [
    ['hidden proof', base => Object.defineProperty({ ...base }, 'writeProof', { value: { disposition: 'included' }, enumerable: false })],
    ['hidden proof on the transfer', base => (base.transfer ? { ...base, transfer: Object.defineProperty({ ...base.transfer }, 'writeProof', { value: {}, enumerable: false }) } : null)],
    ['symbol member', base => ({ ...base, [Symbol('TEST-member')]: 1 })],
    ['symbol member on the transfer', base => (base.transfer ? { ...base, transfer: { ...base.transfer, [Symbol('TEST-member')]: 1 } } : null)],
    ['accessor phase', base => Object.defineProperty({ ...base }, 'phase', { get: () => base.phase, enumerable: true })],
    ['accessor transfer member', base => (base.transfer ? { ...base, transfer: Object.defineProperty({ ...base.transfer }, 'amountOs', { get: () => AMOUNT_OS, enumerable: true }) } : null)],
  ];
  const before = w.node.calls.length;
  for (const base of wallets) {
    for (const [name, disguise] of disguises) {
      const request = disguise(base);
      if (request === null) continue;
      const row = `${base.phase} ${base.transfer ? 'with transfer ' : ''}${name}`;
      await assert.rejects(relay.walletBinding(request, wallet.headers()), isCode(REFUSED), row);
      if (base.phase === 'readback') await assert.rejects(relay.binding(request), isCode(REFUSED), `binding ${row}`);
    }
  }
  assert.equal(w.node.calls.length, before, 'no node request for a refused request');
});

test('a keyless relay refuses a preparation read that gets no reply at the 10 second deadline', async t => {
  const { w, open } = await relayWorld(t);
  const relay = await open();
  // Each deadline the client sets is recorded and held by the test, so the wait is not real time.
  const deadlines = [];
  t.mock.method(AbortSignal, 'timeout', ms => { const controller = new AbortController(); deadlines.push({ ms, controller }); return controller.signal; });
  const hung = oneShotGate();
  hung.armed = true;
  w.node.intercept = async row => {
    if (row.body?.params?.[0]?.message !== 'getNetworkParameters') return undefined;
    deadlines.at(-1).controller.abort(new DOMException('TEST-deadline', 'TimeoutError'));
    await hung.pass();
    return undefined;
  };
  await assert.rejects(relay.rpc(nodeCall('getNetworkParameters'), {}), error => error.kind === 'timeout' && error.message === 'request timed out');
  assert.equal(deadlines.at(-1).ms, 10_000, 'the preparation read has a 10 second deadline');
  hung.release();
});
