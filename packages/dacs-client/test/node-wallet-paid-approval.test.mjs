// The keystore buyer's read-only paid-write preview: the complete approval request and the content demosdk 4.0.17 finalizes, made from
// keyless source observations outside any effect pass; and its one-use approval, spent by one request inside the pass. Real keystore
// compositions over the scripted TP-1 node; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { agreementRequest, ok, scriptedNode, setPurchaseAdmission, T0 } from './helpers/tp1-node-fixture.mjs';
import { finalizedWorld } from './helpers/finalized-node-world.mjs';
import { buildCountingSigns, inPlainPass, keystoreDir, keystoreWorld } from './helpers/keystore-world.mjs';
const { loadNodeDemos } = await import('../src/wallet/node-demos-loading.mjs');
import { createWorld, queuingFenceOwner } from './helpers/native-create-world.mjs';
const { openDurableWalletJournal } = await import('../src/wallet/durable-journal.mjs');
const { buildNativeTransferPayload } = await import('../src/dacs/wallet-transactions.mjs');
const { nativeWalletLaneKey } = await import('../src/wallet/devnet-native-transport.mjs');
const { passContext, runInPassContext } = await import('../src/wallet/pass-context.mjs');
const { createPaidApproval } = await import('../src/wallet/paid-approval.mjs');
const { createDevnetAgreementWalletTransport, projectPaidWrite } = await import('../src/public/portal/embedded-wallet/sdk-provider.mjs');

const SENDER = '0xc6daef40e1d433c82885c850e5cd8fe321654d8625eac544aa49ca767c2f23be';
const PAYEE = '0x' + '2'.repeat(64);
const CHAIN = 'd59b54c2f70305e03d3a7e4d469f38295ffe4e4a62cb59b9f887057d0e5ca4bc';
const STORAGE = 'stor-448b405b04e6c154584fb88bde19fc3bf32512be';
const JOB = '01M5YKPJG0248H248H248H248H';
const FEE = Object.freeze({ feeCeilingOs: '50000000000' });
const DEBIT_NOTE = 'Everything this transaction commits to taking from this wallet: the seller amount, the SDK gas edit and the node fees. The wallet does not send if the signed or node-confirmed transaction differs.';
const CREATE_NOTE = 'Complete debit: storage fee, SDK gas, network fee, RPC fee and zero additional fee. Exact CREATE bytes, signed fields and every edit are checked before one broadcast.';
const SENDING = 'Signed in this page, validated by the node, then broadcast exactly once. Never retried automatically; the server confirms the result from its own chain readback.';
const KEYSTORE_ONLY = (nonceSource) => ({ nonceSource, observedNonce: 1, feeCeilingOs: '50000000000' });
const hasCode = code => error => { assert.equal(error?.code, code, error?.stack); return true; };

/** The scripted node answers that the denomination fork is not active yet. */
function preFork(node) {
  node.intercept = row => (row.body?.params?.[0]?.message === 'getNetworkInfo'
    ? new Response(JSON.stringify(ok({ forks: { osDenomination: { activated: false }, signatureDomain: { activated: false } }, chainId: 1 })), { headers: { 'content-type': 'application/json' } }) : null);
  return node;
}
const demRequest = () => ({ method: 'sendTransaction', params: [buildNativeTransferPayload({ from: SENDER, to: PAYEE, amountOs: '2000000000', nonce: 1, timestamp: T0, encoding: 'dem-number' })] });

/** A built keystore composition with its key signatures counted. */
async function previewWorld(t, input, file = keystoreDir(t).file()) {
  const w = await keystoreWorld(t, file, input);
  const counts = await buildCountingSigns(t, w);
  assert.equal(w.session.wallet.getPublicAccount().address, SENDER);
  return Object.assign(w, { counts });
}
const records = async w => JSON.stringify(await w.journal.entries());
const readsOf = (w, messages) => w.node.calls.filter(row => messages.includes(row.body?.params?.[0]?.message)).length;
const snapshot = async w => ({ signs: w.counts.inner, effects: w.effects().length, records: await records(w),
  stateReads: readsOf(w, ['getAddressNonce', 'getNetworkParameters', 'getNetworkInfo']), identityReads: readsOf(w, ['getBlockByNumber']) });
/**
 * Nothing was signed, executed or recorded since `before`. Unless `readsAllowed`, the preview read nothing either: the node saw no state read and
 * only the admission check's one identity read for each of `admittedCalls` (a binding observation would add its own).
 */
async function assertUntouched(w, before, { admittedCalls = 0, readsAllowed = false } = {}) {
  const after = await snapshot(w);
  const reads = readsAllowed ? { stateReads: after.stateReads, identityReads: after.identityReads } : { identityReads: before.identityReads + admittedCalls };
  assert.deepEqual(after, { ...before, effects: 0, ...reads });
}

const edit = (type, operation, account, amount) => ({ type, operation, isRollback: false, account, txhash: '', amount });
const wire = (postFork, os, dem) => (postFork ? os : dem);

function nativeVector(postFork) {
  const amount = wire(postFork, '2500000000', 2);
  return { type: 'native', from: SENDER, to: PAYEE, amount, data: ['native', { nativeOperation: 'send', args: [PAYEE, amount] }], nonce: 1, timestamp: T0,
    transaction_fee: { network_fee: wire(postFork, '1000000000', 1), rpc_fee: wire(postFork, '0', 0), additional_fee: wire(postFork, '0', 0), rpc_address: null },
    from_ed25519_address: SENDER,
    gcr_edits: [edit('balance', 'remove', SENDER, amount), edit('balance', 'add', PAYEE, amount), edit('balance', 'remove', SENDER, wire(postFork, '1000000000', 1)), edit('nonce', 'add', SENDER, 1)] };
}

function createVector(request, postFork) {
  const { content } = request.params[0].transaction, op = content.data[1];
  return { type: 'storageProgram', from: SENDER, to: STORAGE, amount: wire(postFork, '0', 0), data: content.data, nonce: 1, timestamp: T0,
    transaction_fee: { network_fee: wire(postFork, '1000000000', 1), rpc_fee: wire(postFork, '0', 0), additional_fee: wire(postFork, '0', 0), rpc_address: null },
    network: 'demos-testnet', chainIdentity: CHAIN, from_ed25519_address: SENDER,
    gcr_edits: [edit('balance', 'remove', SENDER, wire(postFork, '1000000000', 1)),
      { type: 'storageProgram', target: STORAGE, isRollback: false, txhash: '', context: { operation: 'CREATE_STORAGE_PROGRAM', sender: SENDER, data: { variables: op, metadata: op.metadata } } },
      edit('balance', 'remove', SENDER, wire(postFork, '1000000000', 1)), edit('nonce', 'add', SENDER, 1)] };
}

// The approval request, in the provider's member order; the keystore preview adds its three members at the end of the content.
const nativeApproval = (connectionId, extra = {}) => ({ method: 'sendTransaction', address: SENDER,
  purpose: `Send 2.5 DEM from this embedded wallet to ${PAYEE}. Total debit 4.5 DEM: the amount, the SDK's 1 DEM gas and the node fees (explicit independently supplied transport pin; single node, not finality).`,
  content: { action: 'native DEM transfer', from: SENDER, to: PAYEE, amountOs: '2500000000', amountDem: '2.5', nonce: 1,
    debit: { sellerAmountDem: '2.5', sdkGasDem: '1', networkFeeDem: '1', rpcFeeDem: '0', additionalFeeDem: '0', totalDem: '4.5', totalOs: '4500000000', note: DEBIT_NOTE },
    network: 'demos-testnet', evidence: 'Explicit source-supplied network pin; native signature is NOT chain/purchase-bound; single-node readback is not finality.',
    networkBinding: { network: 'demos-testnet', chainIdentity: CHAIN, pinVersion: 'dacs-demos-testnet-identity/2026-10-21', endpoint: 'https://rpc.example.invalid/', transportAuthority: 'vector-authority', connectionId },
    sending: SENDING, ...extra } });

function createApproval(request, declaration, extra = {}) {
  const anchor = request.params[0], op = anchor.transaction.content.data[1];
  return { method: 'sendTransaction', address: SENDER,
    purpose: `Create immutable Agreement for job ${JOB}. Total debit 3 DEM (explicit independently supplied source pin; single node, finality not established).`,
    content: { kind: 'devnet-agreement-storage-create', action: 'immutable DACS storage anchor CREATE', artifactKind: 'Agreement', jobId: JOB,
      owner: 'did:demos:agent:' + SENDER.slice(2), wallet: SENDER, logicalAddress: 'dacs3:agreement:' + JOB, storageAddress: STORAGE, programName: 'dacs3%3Aagreement%3A' + JOB,
      contentHash: anchor.contentHash, contentHashProfile: 'SDK CF-1 signed scope (top-level signature/signatures omitted)', envelopeHash: anchor.envelopeHash,
      storageBytes: Buffer.byteLength(canonicalize(op.data)), exactStorageBytes: canonicalize(op.data), exactCreate: canonicalize(op),
      nonce: 1, timestamp: T0, debit: { storageFeeDem: '1', sellerAmountDem: '0', sdkGasDem: '1', networkFeeDem: '1', rpcFeeDem: '0', additionalFeeDem: '0', totalDem: '3', totalOs: '3000000000', note: CREATE_NOTE },
      network: 'demos-testnet', chainIdentity: CHAIN, networkBinding: declaration, evidence: 'Explicit TEST/source pin; not independent review or consensus finality', sending: SENDING, ...extra } };
}

const isDeeplyFrozen = value => value === null || typeof value !== 'object' || (Object.isFrozen(value) && Object.values(value).every(isDeeplyFrozen));

test('native and CREATE previews freeze every finalized Demos signed-content field from independent reference vectors', async t => {
  for (const postFork of [true, false]) {
    const w = await previewWorld(t);
    if (!postFork) preFork(w.node);
    const nativeRequest = postFork ? w.request() : demRequest();
    const native = await w.session.preparePaidWrite(nativeRequest, FEE);
    assert.deepEqual(native.signedContent, nativeVector(postFork), `native, post-fork ${postFork}`);
    const createRequest = await agreementRequest(w);
    const create = await w.session.preparePaidWrite(createRequest, FEE);
    assert.deepEqual(create.signedContent, createVector(createRequest, postFork), `CREATE, post-fork ${postFork}`);
    assert.ok(isDeeplyFrozen(native.signedContent) && isDeeplyFrozen(create.signedContent));
    // An additional parity check: the content Demos signed for the same requests in a non-keystore composition.
    for (const [request, preview] of [[() => nativeRequest, native], [world => agreementRequest(world), create]]) {
      const other = await finalizedWorld(t, { node: postFork ? scriptedNode() : preFork(scriptedNode()) });
      await other.build();
      assert.equal((await other.session.wallet.request(await request(other))).success, true);
      assert.equal(canonicalize(other.node.broadcasts[0].content), canonicalize(preview.signedContent), `Demos parity, post-fork ${postFork}`);
    }
  }
});

test('native and CREATE previews match independent complete approval-content vectors before authorization exists', async t => {
  const w = await previewWorld(t);
  const { connectionId } = await w.session.transport.observeBinding(), declaration = w.session.wallet.getWriteProfile().transportBinding;
  const request = w.request(), first = await w.session.preparePaidWrite(request, FEE);
  assert.deepEqual(first.content, nativeApproval(connectionId, KEYSTORE_ONLY('prepared-native-plus-chain')));
  // The same source facts at a later observation time give the same bytes; no observation time or provenance enters either projection.
  w.clock.advance(1000);
  const later = await w.session.preparePaidWrite(w.request(), FEE);
  assert.equal(canonicalize(later.content), canonicalize(first.content));
  assert.doesNotMatch(JSON.stringify([first, later]), /observedAt|expiresAt|block-zero-hash|confirmed-block-one-predecessor/);
  assert.equal('source' in first.content.content.networkBinding, false);
  const createRequest = await agreementRequest(w), create = await w.session.preparePaidWrite(createRequest, FEE);
  assert.deepEqual(create.content, createApproval(createRequest, declaration, KEYSTORE_ONLY('anchor-plan-plus-chain')));
  assert.equal(create.content.content.networkBinding.source, 'devnet-agreement-transport/v1', 'the static declaration keeps its source');
  // Deeply frozen public data; the handle is an empty frozen object; a caller's later change reaches neither projection.
  for (const preview of [first, create]) {
    assert.deepEqual(Object.keys(preview).sort(), ['content', 'prepared', 'signedContent']);
    assert.ok(isDeeplyFrozen(preview));
    assert.deepEqual([Reflect.ownKeys(preview.prepared), Object.getPrototypeOf(preview.prepared)], [[], Object.prototype]);
  }
  const before = canonicalize([first.content, first.signedContent]);
  Object.assign(request.params[0].content, { to: '0x' + '3'.repeat(64), amount: '1' });
  request.params[0].content.data[1].args[1] = '1';
  assert.equal(canonicalize([first.content, first.signedContent]), before);
  // A non-keystore composition's approval callback keeps its member order and every byte, native and CREATE.
  for (const send of [world => world.request(), world => agreementRequest(world)]) {
    const seen = [], other = await finalizedWorld(t, { input: { approve: async callback => { if (callback.method === 'sendTransaction') seen.push(JSON.stringify(callback)); return true; } } });
    await other.build();
    const { connectionId: otherConnection } = await other.session.transport.observeBinding(), otherRequest = await send(other);
    assert.equal((await other.session.wallet.request(otherRequest)).success, true);
    const expected = otherRequest.params[0].kind ? createApproval(otherRequest, other.session.wallet.getWriteProfile().transportBinding) : nativeApproval(otherConnection);
    assert.deepEqual(seen, [JSON.stringify(expected)]);
  }
});

test('unsupported malformed or not-admitted preview requests refuse without a handle key call node read journal write or execute', async t => {
  const w = await previewWorld(t);
  const viewKeys = ['actionsAdmitted', 'authorizePaidWrite', 'getPublicAccount', 'getWriteProfile', 'isLocked', 'lock', 'preparePaidWrite', 'request'];
  assert.deepEqual(Object.keys(w.session).sort(), ['authorizePaidWrite', 'binding', 'close', 'effectBoundary', 'effectPass', 'internalCauseOf', 'preparePaidWrite', 'runInEffectPass', 'transport', 'wallet', 'walletFactory', 'withheldReopen']);
  const selected = w.session.walletFactory({ anchorJournal: w.journal });
  for (const view of [w.session.wallet, selected]) assert.deepEqual(Object.keys(view).sort(), viewKeys);
  const before = await snapshot(w);
  // Held: refused before the handle exists or the node is read, through the composition and through a view.
  setPurchaseAdmission('held');
  for (const prepare of [() => w.session.preparePaidWrite(w.request(), FEE), () => selected.preparePaidWrite(w.request(), FEE)]) await assert.rejects(prepare(), hasCode('profile_not_admitted'));
  setPurchaseAdmission('testnet-tp1');
  const base = w.request(), tx = base.params[0];
  const accessor = Object.defineProperty({ ...base }, 'note', { get: () => 'TEST-note', enumerable: true });
  const cycle = { ...base }; cycle.self = cycle;
  const rows = [
    ['an own undefined member', { ...base, note: undefined }], ['a symbol key', { ...base, [Symbol('TEST')]: 1 }], ['a symbol value', { ...base, note: Symbol('TEST') }],
    ['a function', { ...base, note: () => 1 }], ['an accessor', accessor], ['a sparse array', { method: 'sendTransaction', params: new Array(1) }],
    ['a sparse nested array', { method: 'sendTransaction', params: [{ ...tx, content: { ...tx.content, data: Object.assign([], { 0: 'native', 2: 1 }) } }] }],
    ['a Map', { ...base, note: new Map() }], ['a Date', { ...base, note: new Date(T0) }], ['a class instance', { ...base, note: new (class TestNote {})() }],
    ['a cycle', cycle], ['a non-NFC string', { ...base, note: 'é' }], ['a non-finite number', { ...base, note: Number.NaN }],
    ['the sign method', { method: 'sign', params: ['TEST-message'] }], ['the connect method', { method: 'connect', params: [] }],
    ['two transactions', { method: 'sendTransaction', params: [tx, tx] }], ['no params', { method: 'sendTransaction' }], ['null', null],
  ];
  for (const [name, request] of rows) {
    for (const prepare of [w.session.preparePaidWrite, selected.preparePaidWrite]) await assert.rejects(prepare(request, FEE), hasCode('invalid_params'), name);
  }
  await assertUntouched(w, before, { admittedCalls: rows.length * 2 });
  // Control: the same composition prepares the well-formed request.
  assert.equal(typeof (await selected.preparePaidWrite(base, FEE)).prepared, 'object');
});

test('unqualified or non-testnet bindings refuse preview without a handle key call journal write or execute', async t => {
  const w = await previewWorld(t);
  const native = w.request(), create = await agreementRequest(w), observed = await w.session.transport.observeBinding();
  const before = await snapshot(w);
  const relayOrigin = 'https://node-wallet.invalid', transactionTransport = createDevnetAgreementWalletTransport(w.session.transport.profile(relayOrigin), { relayOrigin });
  const answers = { getAddressNonce: 0, getNetworkParameters: { networkFee: 1, rpcFee: 0 }, getNetworkInfo: { forks: { osDenomination: { activated: true } } } };
  const seen = { keyCalls: 0 };
  const preview = binding => createPaidApproval({ projectPaidWrite, transactionTransport, relayOrigin, feeCeilingOs: FEE.feeCeilingOs,
    session: { getPublicAccount: () => ({ address: SENDER }), isLocked: () => false, request: async () => { seen.keyCalls += 1; } },
    transport: { pins: { network: 'demos-testnet', chainIdentity: CHAIN }, inspectWalletNonceLane: async () => null, observeBinding: async () => binding,
      readRpc: async (_path, body) => ({ result: 200, response: answers[body.params[0].message] }) } }).viewFor(w.journal, async () => { seen.keyCalls += 1; }).preparePaidWrite;
  const rows = [
    ['another binding version', { ...observed, bindingVersion: 'TEST-binding/v0' }], ['a mainnet network', { ...observed, network: 'demos-mainnet' }],
    ['another chain', { ...observed, chainIdentity: 'e'.repeat(64) }], ['an unreadable chain identity', { ...observed, chainIdentity: 'TEST-chain' }],
    ['another binding id', { ...observed, bindingId: 'f'.repeat(64) }], ['no binding', null],
  ];
  for (const [name, binding] of rows) {
    await assert.rejects(preview(binding)(native, FEE), hasCode('network_binding_unavailable'), `native: ${name}`);
    await assert.rejects(preview(binding)(create, FEE), hasCode('network_binding_required'), `CREATE: ${name}`);
  }
  assert.equal(seen.keyCalls, 0);
  await assertUntouched(w, before);
  // Control: the authenticated pinned binding prepares both.
  for (const request of [native, create]) assert.equal(typeof (await preview(observed)(request, FEE)).prepared, 'object');
});

test('native and CREATE invalid timestamps refuse preview without a handle key call journal write or execute', async t => {
  const w = await previewWorld(t);
  const create = await agreementRequest(w), before = await snapshot(w);
  const withTimestamp = (request, contentOf, timestamp) => {
    const changed = structuredClone(request), content = contentOf(changed);
    if (timestamp === undefined) delete content.timestamp; else content.timestamp = timestamp;
    return changed;
  };
  const invalid = [undefined, 0, -1, 1.5, 2 ** 53, String(T0)];
  for (const timestamp of invalid) {
    await assert.rejects(w.session.preparePaidWrite(withTimestamp(w.request(), r => r.params[0].content, timestamp), FEE), hasCode('invalid_params'), `native ${timestamp}`);
    await assert.rejects(w.session.preparePaidWrite(withTimestamp(create, r => r.params[0].transaction.content, timestamp), FEE), hasCode('invalid_params'), `CREATE ${timestamp}`);
  }
  await assertUntouched(w, before, { readsAllowed: true });
});

test('nonce-lane inspection refuses wrong scope effect-pass entry and closed transport', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'paid-approval-lane-'));
  const journal = openDurableWalletJournal({ path: join(dir, 'journal.sqlite'), mode: 'create' });
  t.after(() => { journal.close(); rmSync(dir, { recursive: true, force: true }); });
  const { capability, wallet } = createWorld({ journal, owner: queuingFenceOwner() });
  const scope = { owner: wallet.address, network: capability.pins.network, chainIdentity: capability.pins.chainIdentity };
  assert.equal(await capability.inspectWalletNonceLane(scope), null);
  await journal.put(nativeWalletLaneKey(capability.pins, wallet.address), { stage: 'broadcast-started', hash: 'a'.repeat(64), nonce: 1 });
  const read = await capability.inspectWalletNonceLane(scope);
  assert.deepEqual([read, Object.isFrozen(read)], [{ stage: 'broadcast-started' }, true]);
  const records = JSON.stringify(await journal.entries());
  const wrong = [['an extra key', { ...scope, extra: 1 }], ['a symbol key', { ...scope, [Symbol('TEST')]: 1 }], ['a missing key', { owner: scope.owner, network: scope.network }],
    ['another network', { ...scope, network: 'demos-mainnet' }], ['another chain', { ...scope, chainIdentity: 'e'.repeat(64) }], ['an upper-case owner', { ...scope, owner: scope.owner.toUpperCase() }], ['no scope', null]];
  for (const [name, bad] of wrong) await assert.rejects(capability.inspectWalletNonceLane(bad), hasCode('invalid_params'), name);
  await assert.rejects(runInPassContext(passContext(), () => capability.inspectWalletNonceLane(scope)), hasCode('nonce_lane_order'));
  await capability.close();
  await assert.rejects(capability.inspectWalletNonceLane(scope), hasCode('transport_closed'));
  assert.equal(JSON.stringify(await journal.entries()), records, 'no record was written');
});

test('uncertain native and CREATE retained rows refuse preview without a nonce claim', async t => {
  const w = await previewWorld(t);
  const create = await agreementRequest(w);
  const nativeLane = nativeWalletLaneKey({ network: 'demos-testnet', chainIdentity: CHAIN }, SENDER), anchorLane = JSON.stringify(['demos-testnet', CHAIN, SENDER]);
  const nonceReads = () => w.node.calls.filter(row => row.body?.params?.[0]?.message === 'getAddressNonce').length;
  const cases = [
    ['a native broadcast-started row', nativeLane, { stage: 'broadcast-started', hash: 'a'.repeat(64), nonce: 1 }, [w.request(), create]],
    ['a native signed row', nativeLane, { stage: 'signed', nonce: 1 }, [w.request(), create]], ['a native row without a stage', nativeLane, { nonce: 1 }, [w.request(), create]],
    ['a CREATE broadcast-started row', anchorLane, { lane: anchorLane, stage: 'broadcast-started', nonce: 1, hash: 'b'.repeat(64) }, [create]],
    ['a CREATE row without a stage', anchorLane, { lane: anchorLane, nonce: 1 }, [create]],
  ];
  for (const [name, key, row, requests] of cases) {
    await w.journal.put(key, row);
    const before = await snapshot(w), nonces = nonceReads();
    for (const request of requests) await assert.rejects(w.session.preparePaidWrite(request, FEE), hasCode('outcome_unknown'), name);
    assert.equal(nonceReads(), nonces, `${name}: no nonce was read or claimed`);
    await assertUntouched(w, before, { admittedCalls: requests.length });
    await w.journal.put(key, key === nativeLane ? { stage: 'failed', nonce: 1 } : { lane: anchorLane, stage: 'broadcast-accepted', nonce: 1 });
  }
});

test('preview never signs confirms broadcasts executes or changes the wallet journal', async t => {
  const w = await previewWorld(t);
  const create = await agreementRequest(w), before = await snapshot(w);
  for (const request of [w.request(), create]) assert.equal(typeof (await w.session.preparePaidWrite(request, FEE)).prepared, 'object');
  await assertUntouched(w, before, { readsAllowed: true });
  assert.deepEqual({ confirms: w.node.confirms.length, broadcasts: w.node.broadcasts.length, authenticated: w.node.calls.filter(row => 'identity' in row.headers).length },
    { confirms: 0, broadcasts: 0, authenticated: 0 });
  // Inside an effect pass the lane inspection refuses, so a preview is made only before a pass.
  await assert.rejects(inPlainPass(w, () => w.session.preparePaidWrite(w.request(), FEE)), hasCode('nonce_lane_order'));
});

test('CREATE preview constructs the Base anchor plan and rejects altered envelope signed-scope and derived-address hashes', async t => {
  const w = await previewWorld(t);
  const create = await agreementRequest(w), anchor = create.params[0], op = anchor.transaction.content.data[1];
  // Independent values: the hashes of the artifact and of its signed scope, and the address derived from the owner, encoded name and nonce.
  const { signatures, ...scope } = op.data;
  assert.ok(signatures.length === 2 && anchor.envelopeHash === sha256Hex(canonicalize(op.data)) && anchor.contentHash === sha256Hex(canonicalize(scope)));
  assert.equal(op.storageAddress, STORAGE);
  assert.equal(STORAGE, 'stor-' + sha256Hex(`${SENDER}:${op.programName}:1:`).slice(0, 40));
  const before = await snapshot(w);
  const altered = change => { const request = structuredClone(create); change(request.params[0], request.params[0].transaction.content.data[1]); return request; };
  const rows = [
    ['the envelope hash', (r, o) => { r.envelopeHash = o.metadata.envelopeHash = 'a'.repeat(64); }],
    ['the signed-scope hash', (r, o) => { r.contentHash = o.metadata.contentHash = 'a'.repeat(64); }],
    ['the derived address', (r, o) => { o.storageAddress = r.transaction.content.to = 'stor-' + '0'.repeat(40); }],
  ];
  for (const [name, change] of rows) await assert.rejects(w.session.preparePaidWrite(altered(change), FEE), hasCode('invalid_params'), name);
  await assertUntouched(w, before, { readsAllowed: true });
});

const BASE_KEYS = ['binding', 'close', 'effectBoundary', 'effectPass', 'internalCauseOf', 'runInEffectPass', 'transport', 'wallet', 'walletFactory', 'withheldReopen'];
const VIEW_KEYS = ['actionsAdmitted', 'getPublicAccount', 'getWriteProfile', 'isLocked', 'lock', 'request'];
const PAID_KEYS = ['authorizePaidWrite', 'preparePaidWrite'];
const sorted = names => [...names].sort();
const messageOf = row => row.body?.params?.[0]?.message;

/** A built keystore composition with its key signatures and its host `approve` calls counted. */
async function paidWorld(t, file) {
  const approvals = [];
  const w = await previewWorld(t, { approve: async request => { approvals.push(request.method); return true; } }, file);
  return Object.assign(w, { approvals });
}
/** Prepares `request` on `view` and authorizes its complete preview content. */
async function permitFor(view, request, options = FEE) {
  const preview = await view.preparePaidWrite(request, options);
  return { ...preview, permit: await view.authorizePaidWrite(preview.prepared, preview.content) };
}
/** Key signatures (source authentication included), signatures inside the SDK's transaction sign, execute calls and broadcasts so far. */
const marks = w => ({ keys: w.counts.inner, signed: w.counts.inSign, effects: w.effects().length, broadcasts: w.node.broadcasts.length });
/** The request `view` sends with `option` inside a plain effect pass whose fee ceiling is `passCeiling`. */
const sendInPass = (w, view, request, option, passCeiling) => inPlainPass(w, () => view.request(request, option), passCeiling);
/** A non-keystore buyer whose approve callback records each request's method. */
async function approvingControl(t) {
  const approvals = [], control = await finalizedWorld(t, { input: { approve: async request => { approvals.push(request.method); return true; } } });
  await control.build();
  return Object.assign(control, { approvals });
}
/** Changes the network binding in the next source answer the wallet reads that carries one. */
function changeNextBinding(t, change) {
  const json = Response.prototype.json;
  const spy = t.mock.method(Response.prototype, 'json', async function changedBinding() {
    const value = await Reflect.apply(json, this, []);
    if (!value?.binding) return value;
    spy.mock.restore();
    return { ...value, binding: change(value.binding) };
  });
}

/** createPaidApproval over stand-in reads and a stand-in planner whose approval content is `content`; `send` stands for the wallet provider. */
function standInApproval(content, send) {
  const answers = { getAddressNonce: 0, getNetworkParameters: { networkFee: 1, rpcFee: 0 }, getNetworkInfo: { forks: { osDenomination: { activated: true } } } };
  const approval = createPaidApproval({ feeCeilingOs: FEE.feeCeilingOs, transactionTransport: null, relayOrigin: null, session: { getPublicAccount: () => ({ address: SENDER }) },
    transport: { pins: { network: 'demos-testnet', chainIdentity: CHAIN }, inspectWalletNonceLane: async () => null, observeBinding: async () => ({}),
      readRpc: async (_path, body) => ({ result: 200, response: answers[body.params[0].message] }) },
    projectPaidWrite: async () => ({ callback: { method: 'sendTransaction', address: SENDER, purpose: 'TEST-purpose', content }, signedContent: { nonce: 1 } }) });
  return { approval, view: approval.viewFor(null, request => send(approval, request)) };
}
const standInRequest = () => ({ method: 'sendTransaction', params: [{ content: { type: 'native', nonce: 1 } }] });

/** Every leaf path of a JSON value. */
const leafPaths = (value, path = []) => (value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([key, member]) => leafPaths(member, [...path, key])) : [path]);
/** A copy of `value` whose leaf at `path` holds another valid value of its type; a decimal amount becomes smaller. */
function changedLeaf(value, path) {
  const copy = structuredClone(value), parent = path.slice(0, -1).reduce((node, key) => node[key], copy), key = path.at(-1), leaf = parent[key];
  if (typeof leaf === 'number') parent[key] = leaf + 1;
  else if (typeof leaf === 'boolean') parent[key] = !leaf;
  else if (leaf === null) parent[key] = 'TEST-changed';
  else parent[key] = /^\d+$/.test(leaf) ? String(BigInt(leaf) > 0n ? BigInt(leaf) - 1n : 1n) : `${leaf}X`;
  return copy;
}

test('a complete native paid-write preview approved before the pass signs and broadcasts exactly once', async t => {
  const w = await paidWorld(t);
  assert.deepEqual(Object.keys(w.session).sort(), sorted([...BASE_KEYS, ...PAID_KEYS]));
  for (const view of [w.session.wallet, w.session.walletFactory({ anchorJournal: w.journal })]) assert.deepEqual(Object.keys(view).sort(), sorted([...VIEW_KEYS, ...PAID_KEYS]));
  // The composition's members are its default view's: the composition prepares, the default view authorizes and spends.
  const request = w.request(), preview = await w.session.preparePaidWrite(request, FEE), before = marks(w);
  const permit = await w.session.wallet.authorizePaidWrite(preview.prepared, preview.content);
  assert.deepEqual([Reflect.ownKeys(permit), Object.isFrozen(permit)], [[], true]);
  // An extra option member is refused before the provider is entered and leaves the permit usable.
  assert.equal((await sendInPass(w, w.session.wallet, request, { paidApproval: permit, retry: true })).error?.code, 'invalid_params');
  assert.deepEqual(marks(w), before);
  const sent = await sendInPass(w, w.session.wallet, request, { paidApproval: permit });
  assert.equal(sent.success, true, JSON.stringify(sent));
  assert.deepEqual({ signed: w.counts.inSign, effects: w.effects(), broadcasts: w.node.broadcasts.length }, { signed: 1, effects: ['confirmTx', 'broadcastTx'], broadcasts: 1 });
  assert.equal(w.node.broadcasts[0].content.from, SENDER);
  assert.equal(canonicalize(w.node.broadcasts[0].content), canonicalize(preview.signedContent));
  assert.deepEqual(w.approvals, [], 'the host approve callback is not asked for a scoped paid write');
  // A non-keystore buyer keeps its members and asks its approve callback once.
  const control = await approvingControl(t);
  assert.deepEqual([Object.keys(control.session).sort(), Object.keys(control.session.wallet).sort()], [BASE_KEYS, VIEW_KEYS]);
  assert.equal((await control.send()).success, true);
  assert.deepEqual(control.approvals, ['sendTransaction']);
});

test('a complete storage CREATE preview approved before the pass signs and broadcasts exactly once', async t => {
  const w = await paidWorld(t);
  const create = await agreementRequest(w), { timestamp } = create.params[0].transaction.content;
  assert.ok(Number.isSafeInteger(timestamp) && timestamp > 0);
  const preview = await w.session.wallet.preparePaidWrite(create, FEE), permit = await w.session.authorizePaidWrite(preview.prepared, preview.content);
  const sent = await sendInPass(w, w.session.wallet, create, { paidApproval: permit });
  assert.equal(sent.success, true, JSON.stringify(sent));
  // The host approved the Agreement's own signature (a write with no paid scope) once, and was not asked for the scoped CREATE.
  assert.deepEqual({ signed: w.counts.inSign, broadcasts: w.node.broadcasts.length, approvals: w.approvals }, { signed: 1, broadcasts: 1, approvals: ['sign'] });
  assert.equal(canonicalize(w.node.broadcasts[0].content), canonicalize(preview.signedContent));
  // The planner takes no caller plan: a forged anchorPlan beside a valid CREATE gives the projection of the call without it.
  const relayOrigin = 'https://node-wallet.invalid', transactionTransport = createDevnetAgreementWalletTransport(w.session.transport.profile(relayOrigin), { relayOrigin });
  const input = { request: create, transaction: create.params[0], address: SENDER, binding: await w.session.transport.observeBinding(), fee: { networkFee: 1, rpcFee: 0 },
    postFork: true, chainNonce: 1, transactionTransport, relayOrigin, scopedPaidWrite: true };
  const anchorPlan = { nonce: 7, transaction: { content: { ...create.params[0].transaction.content, to: 'stor-' + '0'.repeat(40), nonce: 7 } } };
  assert.deepEqual(await projectPaidWrite({ ...input, anchorPlan }), await projectPaidWrite(input));
  const control = await approvingControl(t);
  assert.equal((await control.session.wallet.request(await agreementRequest(control))).success, true);
  assert.deepEqual(control.approvals, ['sign', 'sendTransaction']);
});

test('a params-only approval refuses before a native signature or execute call', async t => {
  const w = await paidWorld(t);
  const request = w.request(), preview = await w.session.preparePaidWrite(request, FEE), before = marks(w);
  const partials = [['the params', request.params], ['the transaction', request.params[0]], ['a params digest', sha256Hex(canonicalize(request.params))],
    ['the content member alone', preview.content.content], ['the fee ceiling alone', FEE]];
  for (const [name, partial] of partials) {
    await assert.rejects(w.session.authorizePaidWrite(preview.prepared, partial), hasCode('paid_approval_mismatch'), name);
    assert.equal((await sendInPass(w, w.session.wallet, request, { paidApproval: partial })).error?.code, 'paid_approval_required', name);
  }
  assert.deepEqual({ ...marks(w), approvals: w.approvals }, { ...before, approvals: [] });
});

test('an approval handle from another session or wallet view refuses before a key call', async t => {
  const files = keystoreDir(t), w = await paidWorld(t, files.file()), v = await keystoreWorld(t, files.file());
  await v.build();
  const request = w.request(), selected = w.session.walletFactory({ anchorJournal: w.journal }), second = w.session.walletFactory({ anchorJournal: w.journal });
  const foreign = await permitFor(v.session.wallet, request), own = await selected.preparePaidWrite(request, FEE), before = marks(w);
  await assert.rejects(w.session.authorizePaidWrite(foreign.prepared, foreign.content), hasCode('paid_approval_mismatch'), 'another session\'s handle');
  assert.equal((await sendInPass(w, w.session.wallet, request, { paidApproval: foreign.permit })).error?.code, 'paid_approval_required', 'another session\'s permit');
  for (const view of [w.session.wallet, second]) await assert.rejects(view.authorizePaidWrite(own.prepared, own.content), hasCode('paid_approval_mismatch'), 'another view\'s handle');
  const permit = await selected.authorizePaidWrite(own.prepared, own.content);
  for (const view of [w.session.wallet, second]) assert.equal((await sendInPass(w, view, request, { paidApproval: permit })).error?.code, 'paid_approval_mismatch', 'another view\'s permit');
  assert.deepEqual({ ...marks(w), other: v.effects().length + v.node.broadcasts.length }, { ...before, other: 0 });
  // The permit refused on the other views is still good once on its own.
  assert.equal((await sendInPass(w, selected, request, { paidApproval: permit })).success, true);
});

test('each changed native or CREATE approval field refuses with zero inner signatures and zero execute calls', async t => {
  const w = await paidWorld(t);
  const native = w.request(), authorized = [];
  for (const [name, request] of [['native', native], ['CREATE', await agreementRequest(w)]]) {
    const preview = await w.session.preparePaidWrite(request, FEE), before = marks(w), removed = { ...preview.content };
    delete removed.purpose;
    const changes = [...leafPaths(preview.content).map(path => [path.join('.'), changedLeaf(preview.content, path)]), ['an added member', { ...preview.content, extra: 1 }],
      ['an added content member', { ...preview.content, content: { ...preview.content.content, extra: 1 } }], ['a removed member', removed]];
    assert.ok(changes.length > 30, `${name}: ${changes.length} changes`);
    for (const [field, changed] of changes) await assert.rejects(w.session.authorizePaidWrite(preview.prepared, changed), hasCode('paid_approval_mismatch'), `${name} ${field}`);
    assert.deepEqual(marks(w), before, name);
    // Still prepared: its own content authorizes it.
    authorized.push(await w.session.authorizePaidWrite(preview.prepared, preview.content));
  }
  assert.equal((await sendInPass(w, w.session.wallet, native, { paidApproval: authorized[0] })).success, true);
  assert.deepEqual(w.approvals, ['sign'], 'only the Agreement\'s own signature asked the host');
  // A spelling that differs only by Unicode normalization is other content.
  const { view } = standInApproval({ memo: 'café' }, () => assert.fail('nothing is sent'));
  const preview = await view.preparePaidWrite(standInRequest(), FEE), decomposed = structuredClone(preview.content);
  decomposed.content.memo = 'café';
  await assert.rejects(view.authorizePaidWrite(preview.prepared, decomposed), hasCode('paid_approval_mismatch'));
  assert.equal(typeof await view.authorizePaidWrite(preview.prepared, preview.content), 'object');
});

test('a changed binding fee fork or nonce after preview refuses before the inner signature', async t => {
  const w = await paidWorld(t);
  const answer = response => new Response(JSON.stringify(ok(response)), { headers: { 'content-type': 'application/json' } });
  const changes = [
    ['the binding', 'paid_approval_mismatch', () => changeNextBinding(t, binding => ({ ...binding, connectionId: 'TEST-other-connection' }))],
    ['the fee', 'paid_approval_mismatch', () => { w.node.intercept = row => (messageOf(row) === 'getNetworkParameters' ? answer({ networkFee: 2, rpcFee: 0, additionalFee: 0 }) : null); }],
    // The finalized amounts no longer match the prepared send's encoding, which the existing final-content check refuses first.
    ['the denomination fork', 'payload_mismatch', () => preFork(w.node)],
    ['the nonce', 'stale_plan', () => { w.node.nonce = 4; }],
  ];
  for (const [name, code, change] of changes) {
    const request = w.request(), { permit } = await permitFor(w.session.wallet, request);
    change();
    const refused = await sendInPass(w, w.session.wallet, request, { paidApproval: permit });
    Object.assign(w.node, { intercept: null, nonce: 0 });
    assert.equal(refused.error?.code, code, `${name}: ${JSON.stringify(refused)}`);
    assert.deepEqual({ signed: w.counts.inSign, effects: w.effects().length, approvals: w.approvals }, { signed: 0, effects: 0, approvals: [] }, name);
  }
});

test('an unsupported request member at preview or entry refuses before any key call', async t => {
  const w = await paidWorld(t);
  const create = await agreementRequest(w), decomposed = structuredClone(create), before = marks(w);
  decomposed.params[0].transaction.content.data[1].programName += 'é';
  await assert.rejects(w.session.preparePaidWrite(decomposed, FEE), hasCode('invalid_params'), 'a CREATE request with a non-NFC string');
  await assert.rejects(w.session.preparePaidWrite({ ...w.request(), note: undefined }, FEE), hasCode('invalid_params'), 'an own undefined member at preview');
  const request = w.request(), { permit } = await permitFor(w.session.wallet, request);
  request.note = undefined;
  assert.equal((await sendInPass(w, w.session.wallet, request, { paidApproval: permit })).error?.code, 'invalid_params', 'an own undefined member at entry');
  assert.deepEqual(marks(w), before);
  delete request.note;
  assert.equal((await sendInPass(w, w.session.wallet, request, { paidApproval: permit })).success, true);
  assert.equal((await sendInPass(w, w.session.wallet, request, { paidApproval: permit })).error?.code, 'paid_approval_used');
  assert.equal(w.node.broadcasts.length, 1);
});

test('a consumed permit cannot approve a retry concurrent request or second wallet view', async t => {
  const w = await paidWorld(t);
  const request = w.request(), selected = w.session.walletFactory({ anchorJournal: w.journal }), { prepared, content, permit } = await permitFor(w.session.wallet, request);
  await assert.rejects(w.session.authorizePaidWrite(prepared, content), hasCode('paid_approval_used'), 'a second authorization before any request');
  // A request nested inside the entered one, and a concurrent one, cannot borrow its permit.
  let nested;
  w.node.intercept = row => { if (!nested && messageOf(row) === 'getNetworkParameters') nested = w.session.wallet.request(request, { paidApproval: permit }); return null; };
  const [first, concurrent] = await inPlainPass(w, () => Promise.all([w.session.wallet.request(request, { paidApproval: permit }), w.session.wallet.request(request, { paidApproval: permit })]));
  w.node.intercept = null;
  assert.equal(first.success, true, JSON.stringify(first));
  assert.deepEqual([concurrent.error?.code, (await nested).error?.code], ['paid_approval_used', 'paid_approval_used']);
  const after = marks(w);
  for (const view of [w.session.wallet, selected]) assert.equal((await sendInPass(w, view, request, { paidApproval: permit })).error?.code, 'paid_approval_used');
  await assert.rejects(w.session.authorizePaidWrite(prepared, content), hasCode('paid_approval_used'), 'a second authorization after a completed request');
  assert.deepEqual(marks(w), { ...after, broadcasts: 1 });
  // An entered request that fails before the approval callback (after the source authentication) still spends its permit.
  const f = await paidWorld(t);
  const failures = [['an unanswered fee read', row => { if (messageOf(row) === 'getNetworkParameters') throw new Error('TEST-read-timeout'); return null; }],
    ['a refused nonce read', row => (messageOf(row) === 'getAddressNonce' ? new Response('TEST-unavailable', { status: 503 }) : null)]];
  for (const [name, failure] of failures) {
    const failedRequest = f.request(), entered = await permitFor(f.session.wallet, failedRequest);
    f.node.intercept = failure;
    const failed = await sendInPass(f, f.session.wallet, failedRequest, { paidApproval: entered.permit });
    f.node.intercept = null;
    assert.equal(failed.success, false, name);
    const spent = marks(f);
    assert.deepEqual({ signed: spent.signed, effects: spent.effects }, { signed: 0, effects: 0 }, name);
    assert.equal((await sendInPass(f, f.session.wallet, failedRequest, { paidApproval: entered.permit })).error?.code, 'paid_approval_used', name);
    await assert.rejects(f.session.authorizePaidWrite(entered.prepared, entered.content), hasCode('paid_approval_used'), `${name}: a second authorization`);
    assert.deepEqual(marks(f), spent, `${name}: the retry made no key call or execute call`);
  }
});

test('the signer refuses a changed finalized field after the approval callback with zero inner signatures', async t => {
  const w = await paidWorld(t);
  const { Demos } = await loadNodeDemos(), request = w.request(), { permit } = await permitFor(w.session.wallet, request);
  // Demos finalizes another time; its hash and signed message stay self-consistent and the debit is unchanged, so only the approved-content equality sees it.
  const sign = Demos.prototype.sign;
  t.mock.method(Demos.prototype, 'sign', function laterTime(transaction, options) { transaction.content.timestamp = T0 + 1; return Reflect.apply(sign, this, [transaction, options]); });
  const refused = await sendInPass(w, w.session.wallet, request, { paidApproval: permit });
  assert.equal(refused.error?.code, 'paid_approval_mismatch', JSON.stringify(refused));
  assert.deepEqual({ signed: w.counts.inSign, effects: w.effects().length, approvals: w.approvals }, { signed: 0, effects: 0, approvals: [] });
});

test('a second approval callback in one request refuses before another inner signature', async () => {
  const callback = { method: 'sendTransaction', address: SENDER, purpose: 'TEST-purpose', content: { amountOs: '1' } }, signatures = [];
  const { view } = standInApproval(callback.content, async approval => {
    for (let call = 0; call < 2; call += 1) {
      try { approval.approvalCheck(callback); } catch (error) { return { refused: error.code, signatures: signatures.length }; }
      signatures.push(approval.signedContentCheck({ nonce: 1 }, { totalDebitOs: '1', feeDebitOs: '1' }));
    }
    return { refused: null };
  });
  const request = standInRequest(), preview = await view.preparePaidWrite(request, FEE);
  const permit = await view.authorizePaidWrite(preview.prepared, preview.content);
  assert.deepEqual(await view.request(request, { paidApproval: permit }), { refused: 'paid_approval_used', signatures: 1 });
  assert.deepEqual(signatures, [{ totalDebitOs: '1', feeDebitOs: '1', requiredCeilingOs: FEE.feeCeilingOs }]);
});

test('a spent permit is lost on close and cannot authorize a new session', async t => {
  const file = keystoreDir(t).file(), w = await paidWorld(t, file);
  const request = w.request(), { prepared, content, permit } = await permitFor(w.session.wallet, request);
  assert.equal((await sendInPass(w, w.session.wallet, request, { paidApproval: permit })).success, true);
  await w.close();
  const reopened = await keystoreWorld(t, file);
  await reopened.build();
  const keys = w.counts.inner;
  assert.equal((await sendInPass(reopened, reopened.session.wallet, request, { paidApproval: permit })).error?.code, 'paid_approval_required');
  await assert.rejects(reopened.session.authorizePaidWrite(prepared, content), hasCode('paid_approval_mismatch'));
  assert.deepEqual({ keys: w.counts.inner, effects: reopened.effects().length }, { keys, effects: 0 });
});

test('a changed callback-only binding field refuses before an inner transaction signature or execute call', async t => {
  const w = await paidWorld(t);
  const request = w.request(), { signedContent, permit } = await permitFor(w.session.wallet, request);
  assert.equal(JSON.stringify(signedContent).includes('transportAuthority'), false, 'Demos does not sign the binding');
  changeNextBinding(t, binding => ({ ...binding, transportAuthority: 'TEST-other-authority' }));
  const refused = await sendInPass(w, w.session.wallet, request, { paidApproval: permit });
  assert.equal(refused.error?.code, 'paid_approval_mismatch', JSON.stringify(refused));
  assert.deepEqual({ signed: w.counts.inSign, effects: w.effects().length, approvals: w.approvals }, { signed: 0, effects: 0, approvals: [] });
});

test('higher and lower valid pass ceilings than the prepared ceiling refuse before an inner transaction signature', async t => {
  const w = await paidWorld(t), prepared = { feeCeilingOs: '30000000000' };
  for (const passCeiling of ['40000000000', '20000000000']) {
    const request = w.request(), { content, permit } = await permitFor(w.session.wallet, request, prepared);
    assert.ok(BigInt(content.content.debit.totalOs) <= 20000000000n, 'the finalized fee is below both pass ceilings');
    const refused = await sendInPass(w, w.session.wallet, request, { paidApproval: permit }, passCeiling);
    assert.equal(refused.error?.code, 'paid_approval_mismatch', `${passCeiling}: ${JSON.stringify(refused)}`);
    assert.deepEqual({ signed: w.counts.inSign, effects: w.effects().length }, { signed: 0, effects: 0 }, passCeiling);
  }
  const request = w.request(), { permit } = await permitFor(w.session.wallet, request, prepared);
  assert.equal((await sendInPass(w, w.session.wallet, request, { paidApproval: permit }, prepared.feeCeilingOs)).success, true);
});
