// The keystore buyer's read-only paid-write preview: the complete approval request and the content demosdk 4.0.17 finalizes, made from
// keyless source observations outside any effect pass. Real keystore compositions over the scripted TP-1 node; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { agreementRequest, ok, scriptedNode, setPurchaseAdmission, T0 } from './helpers/tp1-node-fixture.mjs';
import { finalizedWorld } from './helpers/finalized-node-world.mjs';
import { buildCountingSigns, inPlainPass, keystoreDir, keystoreWorld } from './helpers/keystore-world.mjs';
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
async function previewWorld(t, input) {
  const w = await keystoreWorld(t, keystoreDir(t).file(), input);
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
  const viewKeys = ['actionsAdmitted', 'getPublicAccount', 'getWriteProfile', 'isLocked', 'lock', 'preparePaidWrite', 'request'];
  assert.deepEqual(Object.keys(w.session).sort(), ['binding', 'close', 'effectBoundary', 'effectPass', 'internalCauseOf', 'preparePaidWrite', 'runInEffectPass', 'transport', 'wallet', 'walletFactory', 'withheldReopen']);
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
      readRpc: async (_path, body) => ({ result: 200, response: answers[body.params[0].message] }) } }).previewFor(w.journal);
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
