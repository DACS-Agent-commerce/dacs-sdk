// The public purchase wallet bridge over the real storage-anchor bridge, the real Node wallet session, the durable
// wallet journal and a scripted node; the purchase service test replaces only its seller exchange and readers.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize, contentHash } from '@kynesyslabs/dacs';
import { finalizedWorld } from './helpers/finalized-node-world.mjs';
import { agreementRequest, ok, T0 } from './helpers/tp1-node-fixture.mjs';
import { installPackedPair } from './helpers/packed-install.mjs';
import { resolve } from './helpers/stored-request-flow-loader.mjs';

// The purchase-admission test hook (installed by the fixtures above) must see every src module, so these load after it.
registerHooks({ resolve });
const { openDatabase, transaction, isUniqueViolation } = await import('./helpers/purchase-integrity-database.mjs');
const { createOperationStore } = await import('./helpers/purchase-integrity-operations.mjs');
const { createPurchaseWalletBridge } = await import('@kynesyslabs/dacs-client/purchase/wallet-bridge');
const { DemosSr2BridgeError } = await import('../src/dacs/demos-sr2-wallet-bridge.mjs');
const { createDevnetNativeCommitmentCapability, DEVNET_NATIVE_COMMITMENT_MARKER } = await import('../src/devnet-demo/commitment-consumer.mjs');
const { createProtocolPurchases, OFFLINE_AGREEMENT_PROFILE } = await import('../src/dacs/protocol-purchases.mjs?stored-flow');
const { createSourceDemoSellerTransport } = await import('../src/dacs/source-demo-seller-transport.mjs');
const { readOnlyBoundary } = await import('./helpers/read-only-boundary.mjs');
const { buildCountingSigns, inPlainPass, keystoreDir, keystoreWorld } = await import('./helpers/keystore-world.mjs');
const { PAID_WRITE_FEE_CEILING_OS } = await import('../src/index.mjs');

const SECOND_JOB = '01M5YKPJG0248H248H248H249A';
const bridgeCode = code => error => error instanceof DemosSr2BridgeError && error.code === code;
const walletRequired = bridgeCode('wallet-required');
const reply = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const isDeeplyFrozen = value => value === null || typeof value !== 'object' || (Object.isFrozen(value) && Object.values(value).every(isDeeplyFrozen));

// The scripted node plus what a full native readback needs: the name index, the block's validation data and the
// program's creating transaction. `unavailable` makes the transaction read fail; `networkFee` replaces the node's network fee.
function readableNode(node, chainIdentity) {
  const control = { unavailable: false, networkFee: undefined };
  node.intercept = async row => {
    const created = [...node.applied.values()].filter(tx => tx.content.data?.[0] === 'storageProgram');
    if (row.body === null) {
      const address = new URL(row.url).pathname.split('/storage-program/')[1], tx = created.find(c => c.content.to === address);
      if (!tx) return undefined;
      const op = tx.content.data[1];
      return reply({ success: true, data: op.data, owner: tx.content.from, programName: op.programName, storageAddress: address, metadata: op.metadata, createdByTx: tx.hash, interactionTxs: [tx.hash] });
    }
    const { message, data } = row.body.params[0];
    if (message === 'getTxByHash' && control.unavailable) throw new Error('TEST-node-unavailable');
    if (message === 'getNetworkParameters' && control.networkFee !== undefined) return reply(ok({ networkFee: control.networkFee, rpcFee: 0, additionalFee: 0 }));
    if (message === 'searchStoragePrograms') return reply(ok(created.filter(tx => tx.content.data[1].programName === data.query)
      .map(tx => ({ storageAddress: tx.content.to, programName: tx.content.data[1].programName }))));
    if (message === 'getBlockByNumber' && data.blockNumber > 0) return reply(ok({ number: data.blockNumber, status: 'confirmed', hash: 'b'.repeat(64),
      content: { timestamp: T0 / 1000, previousHash: chainIdentity, ordered_transactions: [...node.applied.keys()] }, validation_data: { TEST: 'single-node-observation', chainIdentity } }));
    return undefined;
  };
  return control;
}

const agreementConfiguration = w => ({ rpcUrl: w.owner.local.endpoint, network: w.session.wallet.getWriteProfile().network, journal: w.journal, sourceCapability: w.session.transport });

async function walletWorld(t) {
  const w = await finalizedWorld(t); await w.build();
  const reads = readableNode(w.node, w.session.transport.pins.chainIdentity);
  return { w, reads, walletAgreement: agreementConfiguration(w) };
}

// A buyer whose wallet session is opened from a keystore, so its views carry the paid-write members. Key signatures and the
// host's approve calls are counted.
async function paidWalletWorld(t) {
  const approvals = [];
  const w = await keystoreWorld(t, keystoreDir(t).file(), { approve: async request => { approvals.push(request.method); return true; } });
  const counts = await buildCountingSigns(t, w);
  const reads = readableNode(w.node, w.session.transport.pins.chainIdentity);
  return { w, counts, approvals, reads, walletAgreement: agreementConfiguration(w) };
}

// The packaged wallet one operation's bridge requests. It records each request with the options passed beside it and forwards
// every argument. With `loseAnswer` the node takes the CREATE but the answer is lost; with `withholdSend` the answer is unknown
// and nothing reaches the wallet; with `inPass` the request runs in a plain effect pass at the exported paid-write ceiling.
function recordingWallet(w, operation, { loseAnswer = false, withholdSend = false, inPass = false } = {}) {
  return options => {
    const wallet = w.session.walletFactory(options);
    const own = { ...wallet, request: async (input, ...rest) => {
      operation.requests.push(input);
      operation.options.push(rest);
      if (withholdSend) return { success: false, error: { code: 'outcome_unknown' } };
      const send = () => wallet.request(input, ...rest);
      const answer = await (inPass ? inPlainPass(w, send, PAID_WRITE_FEE_CEILING_OS) : send());
      return loseAnswer && answer.success ? { success: false, error: { code: 'outcome_unknown' } } : answer;
    } };
    operation.wallets.push(own);
    return own;
  };
}

const newOperation = () => ({ requests: [], options: [], configurations: [], wallets: [] });

// One operation's bridge over a recording wallet; `extra` adds members to the configuration its factory returns.
function operationBridge(w, walletAgreement, { extra = {}, ...sending } = {}) {
  const operation = newOperation();
  operation.bridge = createPurchaseWalletBridge({ walletFactory: () => {
    const configuration = { ...walletAgreement, ...extra, requestWallet: recordingWallet(w, operation, sending) };
    operation.configurations.push(configuration);
    return configuration;
  } });
  return operation;
}

// A host paid-write callback. `answer(approve, request, members)` decides what it returns; `approve(approved = request)` previews
// `approved` through the given members at the exported paid-write ceiling and authorizes the complete preview content.
function paidHost(answer = approve => approve()) {
  const host = { calls: [], previews: [], permits: [] };
  host.obtain = (request, members) => {
    host.calls.push({ request, members });
    const approve = async (approved = request) => {
      const preview = await members.preparePaidWrite(approved, { feeCeilingOs: PAID_WRITE_FEE_CEILING_OS });
      host.previews.push(preview);
      const permit = await members.authorizePaidWrite(preview.prepared, preview.content);
      host.permits.push(permit);
      return permit;
    };
    return answer(approve, request, members);
  };
  return host;
}

const paidBridge = (w, walletAgreement, host, sending = {}) => operationBridge(w, walletAgreement, { inPass: true, ...sending, ...(host ? { extra: { obtainPaidWritePermit: host.obtain } } : {}) });
const planOf = async (w, input) => (await w.journal.entries()).find(([key, value]) => key.startsWith('sr2/adapter/') && value.logicalAddress === input.logicalAddress)?.[1];
// The execute effects the node saw; the readback's storage-program reads carry no body.
const executed = w => w.node.calls.filter(row => row.body?.method === 'execute').map(row => row.body.params[0].extra);
const sendMarks = (w, counts, operation) => ({ requests: operation.requests.length, signed: counts.inSign, effects: executed(w), broadcasts: w.node.broadcasts.length });
const NOTHING_SENT = Object.freeze({ requests: 0, signed: 0, effects: [], broadcasts: 0 });

async function agreementInput(w, jobId) {
  const raw = (await agreementRequest(w, { complete: true, ...(jobId ? { jobId } : {}) })).params[0];
  return { writer: raw.owner, artifactKind: 'Agreement', logicalAddress: raw.logicalAddress, artifact: raw.transaction.content.data[1].data };
}

const receiptCheck = (input, receipt, changes = {}) => ({ receipt, logicalAddress: input.logicalAddress, artifact: input.artifact, expectedWriter: input.writer, artifactKind: 'Agreement', ...changes });

test('the installed purchase wallet bridge subpath exports createPurchaseWalletBridge', t => {
  const { app, run } = installPackedPair(t);
  writeFileSync(join(app, 'pins.json'), JSON.stringify(JSON.parse(readFileSync(new URL('./fixtures/sr2-public-creates.json', import.meta.url))).pins));
  writeFileSync(join(app, 'bridge.mjs'), `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    const entry = await import('@kynesyslabs/dacs-client/purchase/wallet-bridge');
    assert.deepEqual(Object.keys(entry), ['createPurchaseWalletBridge']);
    assert.throws(() => entry.createPurchaseWalletBridge({}), { code: 'wallet-required' });
    const { createDevnetAgreementTransport } = await import('./node_modules/@kynesyslabs/dacs-client/src/wallet/devnet-native-transport.mjs');
    const pins = JSON.parse(readFileSync('pins.json', 'utf8')), refuse = () => { throw new Error('TEST-offline'); };
    const journal = { get: async () => null, put: refuse, entries: async () => [], withWalletLock: (_key, work) => work() };
    const sourceCapability = createDevnetAgreementTransport({ expected: pins, journal, now: () => 1, fetchImpl: refuse,
      boundary: { holdFence: refuse, withOperation: refuse, signPass: refuse, dispatchPass: refuse, signAuthentication: refuse, signerFor: refuse },
      transportOwner: { getContext: refuse, acquireConnectionFence: refuse } });
    const wallet = { request: refuse, getPublicAccount: refuse, getWriteProfile: refuse };
    const bridge = entry.createPurchaseWalletBridge({ walletFactory: () => ({ rpcUrl: pins.endpoint, network: pins.network, journal, sourceCapability, requestWallet: () => wallet }) });
    assert.deepEqual(Object.keys(bridge), ['anchor', 'resume', 'verifyReceipt']);
    assert.ok(Object.isFrozen(bridge));
  `);
  run(process.execPath, ['bridge.mjs'], app);
});

test('two purchases construct separate wallet bridges over one shared wallet journal', async t => {
  const { w, walletAgreement } = await walletWorld(t);
  const first = operationBridge(w, walletAgreement, { loseAnswer: true }), second = operationBridge(w, walletAgreement);
  const firstInput = await agreementInput(w), secondInput = await agreementInput(w, SECOND_JOB);
  assert.equal((await first.bridge.anchor(firstInput)).status, 'indeterminate');
  await assert.rejects(second.bridge.anchor(secondInput), { code: 'wallet-fenced' });
  assert.deepEqual([first.requests.length, second.requests.length], [1, 0], 'the unresolved first request fences the second on the same buyer lane');
  const firstResult = await first.bridge.resume(firstInput), secondResult = await second.bridge.anchor(secondInput);
  assert.deepEqual([firstResult.status, secondResult.status], ['native-read-visible', 'native-read-visible']);
  assert.deepEqual([first.requests.length, second.requests.length], [1, 1], 'each bridge reached only its own wallet');
  assert.equal(second.requests[0].params[0].jobId, SECOND_JOB);
  for (const operation of [first, second]) {
    assert.equal(operation.configurations.length, 1);
    assert.equal(operation.configurations[0].journal, walletAgreement.journal);
    assert.equal(operation.configurations[0].sourceCapability, walletAgreement.sourceCapability);
  }
  assert.notEqual(first.bridge, second.bridge);
  assert.notEqual(first.wallets[0], second.wallets[0]);
  assert.notEqual(firstResult.plan.planId, secondResult.plan.planId);
});

test('a missing or nonfunction wallet factory refuses wallet-required before any wallet call', () => {
  let touched = 0;
  const configuration = { get requestWallet() { touched += 1; return () => null; } };
  for (const options of [undefined, {}, { walletFactory: undefined }, { walletFactory: null }, { walletFactory: configuration }, { walletFactory: 'TEST-factory' }]) {
    assert.throws(() => createPurchaseWalletBridge(options), walletRequired);
  }
  assert.equal(touched, 0);
});

test('a factory without a configured SDK wallet bridge refuses wallet-required before delegation', async t => {
  const { w, walletAgreement } = await walletWorld(t);
  const calls = w.node.calls.length, entries = (await w.journal.entries()).length;
  let requested = 0;
  const requestOnly = { request: () => { requested += 1; } };
  for (const result of [null, undefined, 'TEST-configuration', requestOnly, { ...walletAgreement }, { ...walletAgreement, requestWallet: requestOnly }]) {
    assert.throws(() => createPurchaseWalletBridge({ walletFactory: () => result }), walletRequired);
  }
  assert.throws(() => createPurchaseWalletBridge({ walletFactory: () => ({ ...walletAgreement, requestWallet: () => { requested += 1; return null; } }) }), walletRequired);
  assert.throws(() => createPurchaseWalletBridge({ walletFactory: () => ({ ...walletAgreement, requestWallet: () => requestOnly }) }), walletRequired);
  assert.equal(requested, 1, 'only the configured request factory ran, once');
  assert.throws(() => createPurchaseWalletBridge({ walletFactory: () => ({ ...walletAgreement, sourceCapability: {}, requestWallet: () => requestOnly }) }), { code: 'profile-held' });
  assert.throws(() => createPurchaseWalletBridge({ walletFactory: () => ({ ...walletAgreement, journal: {}, requestWallet: () => requestOnly }) }), { code: 'journal-required' });
  const cause = new Error('TEST-configuration-cause'), sentinel = new Error('TEST-configuration-failed', { cause });
  assert.throws(() => createPurchaseWalletBridge({ walletFactory: () => { throw sentinel; } }), error => error === sentinel && error.cause === cause);
  assert.deepEqual([w.node.calls.length, (await w.journal.entries()).length], [calls, entries], 'no node read and no journal write');
});

test('anchor delegates the exact Agreement input only to its operation wallet', async t => {
  const { w, walletAgreement } = await walletWorld(t);
  const operation = operationBridge(w, walletAgreement), input = await agreementInput(w);
  await assert.rejects(operation.bridge.anchor({ ...input, logicalAddress: 'dacs3:agreement:' + SECOND_JOB }), error => error instanceof DemosSr2BridgeError && error.code === 'invalid');
  assert.equal(operation.requests.length, 0);
  const result = await operation.bridge.anchor(input);
  assert.equal(result.status, 'native-read-visible');
  assert.deepEqual([result.plan.logicalAddress, result.receipt.logicalAddress, result.receipt.contentHash], [input.logicalAddress, input.logicalAddress, contentHash(input.artifact)]);
  assert.equal(operation.requests.length, 1);
  const { method, params: [request] } = operation.requests[0];
  assert.equal(method, 'sendTransaction');
  assert.deepEqual([request.owner, request.artifactKind, request.jobId, request.logicalAddress, request.contentHash],
    [input.writer, 'Agreement', input.artifact.jobId, input.logicalAddress, contentHash(input.artifact)]);
  const keys = (await w.journal.entries()).map(([key]) => key);
  assert.deepEqual(keys.filter(key => !/^(?:sr2\/adapter\/|sr2\/wallet\/|eb\/|devnet\/native-)/.test(key)), [], 'only the inner bridge and the wallet wrote');
});

test('resume of a retained Agreement performs readback without a second wallet request', async t => {
  const { w, walletAgreement } = await walletWorld(t);
  const input = await agreementInput(w), lost = operationBridge(w, walletAgreement, { loseAnswer: true });
  const first = await lost.bridge.anchor(input);
  assert.equal(first.status, 'indeterminate');
  assert.equal(w.node.broadcasts.length, 1);
  const repeat = operationBridge(w, walletAgreement), result = await repeat.bridge.resume(input);
  assert.equal(result.status, 'native-read-visible');
  assert.equal(result.plan.planId, first.plan.planId);
  assert.deepEqual([lost.requests.length, repeat.requests.length, w.node.broadcasts.length], [1, 0, 1]);
  const never = operationBridge(w, walletAgreement);
  await assert.rejects(never.bridge.resume(await agreementInput(w, SECOND_JOB)), { code: 'handoff-not-issued' });
  assert.deepEqual([never.requests.length, w.node.broadcasts.length], [0, 1], 'resume never issues a wallet request');
});

test('verifyReceipt preserves valid invalid and indeterminate from the SDK verifier', async t => {
  const { w, reads, walletAgreement } = await walletWorld(t);
  const hostile = { verifyReceipt: () => 'valid', anchor: () => assert.fail('a host-supplied anchor must not run'), resume: () => assert.fail('a host-supplied resume must not run') };
  const operation = operationBridge(w, walletAgreement, { extra: hostile }), input = await agreementInput(w);
  const { receipt } = await operation.bridge.anchor(input);
  assert.equal(await operation.bridge.verifyReceipt(receiptCheck(input, receipt)), 'valid');
  assert.equal(await operation.bridge.verifyReceipt(receiptCheck(input, receipt, { artifactKind: 'SettlementEvidence' })), 'invalid', 'the authenticated CREATE binds another kind');
  assert.equal(await operation.bridge.verifyReceipt(receiptCheck(input, { ...receipt, contentHash: 'b'.repeat(64) })), 'invalid');
  reads.unavailable = true;
  assert.equal(await operation.bridge.verifyReceipt(receiptCheck(input, receipt)), 'indeterminate');
});

// A purchase row for the Agreement in `input`, and the purchase service over `walletAgreement` whose seller exchange
// anchors through the service's own anchor adapter and then reads the CREATE back through it. `share` (the `share` of an
// earlier call) reads that call's row instead of creating one. `allowRefusal` hands an anchor answer other than `submitted`
// back to the service; `reconcileFirst` reads the anchor back before anchoring, as the SDK exchange does, and hands any answer
// other than `absent` back. `feeReads()` counts the service's fee reads.
function purchaseService(t, walletAgreement, input, { share, allowRefusal = false, reconcileFirst = false } = {}) {
  const { artifact, logicalAddress } = input, agreementHash = contentHash(artifact);
  // The seller client is built but never sends: the exchange below stands in for the seller, and the commit request fails offline.
  const sessionKey = 'a'.repeat(64), sessionSigner = { claim: 'did:demos:agent:' + sessionKey, sign: () => assert.fail('nothing is signed') };
  const sellerTransport = createSourceDemoSellerTransport({ authority: 'TEST-wallet-bridge', sessionSignerFor: () => sessionSigner, sessionPolicyFor: () => ({}), endpointProofFor: () => ({}), effectBoundary: readOnlyBoundary });
  const { db, ops, op } = share ?? purchaseRow(t, walletAgreement, input, sellerTransport, sessionKey);
  const handBack = (answer, stage) => ({ disposition: answer.disposition, stage, reason: answer.reason });
  let feeReads = 0;
  globalThis[Symbol.for('TEST-stored-request-flows')] = {
    payment: null, evidence: null, chain: { readCommitment: async () => ({ status: 'indeterminate', reason: 'TEST-readback-pending' }) },
    fetch: async () => { throw new Error('TEST-seller-offline'); },
    async exchange({ anchorAdapter }) {
      const anchorInput = { artifact, agreementHash, logicalAddress };
      if (reconcileFirst) {
        const seen = await anchorAdapter.reconcileAgreementAnchor(anchorInput);
        if (seen.disposition !== 'absent') return handBack(seen, 'reconcile');
      }
      const submitted = await anchorAdapter.anchorAgreement(anchorInput);
      if (allowRefusal && submitted.disposition !== 'submitted') return handBack(submitted, 'anchor');
      assert.equal(submitted.disposition, 'submitted');
      const anchored = await anchorAdapter.reconcileAgreementAnchor(anchorInput);
      assert.equal(anchored.disposition, 'present');
      return { disposition: 'anchored', result: { agreement: artifact, agreementHash, agreementRef: anchored.value.ref, anchorReceipt: anchored.value.anchorReceipt } };
    },
  };
  const authority = 'TEST-RUN-bridge00000';
  const nativeSellerCommitment = createDevnetNativeCommitmentCapability({ authority, anchor: { authority, readRetained: () => assert.fail('no commitment read'), verifyReceipt: () => assert.fail('no commitment receipt') } });
  // The seller session delegation this admission would scope is never reached: the exchange above stands in for the seller.
  const admission = { binding: {}, currentLocal: () => ({}) };
  const service = createProtocolPurchases({ db, ops, admission, coordinates: { unresolvedForSender: () => [] }, dacsProtocol: { walletAgreement, nativeSellerCommitment, sellerTransport, sellerEndpoint: () => 'https://seller.invalid' },
    store: { transaction, isUniqueViolation }, buyerAccess: { assertWallet() {} }, now: () => T0, feeCeilingOs: '50000000000', chain: { getTransactionFees: async () => { feeReads += 1; return 1n; } } });
  return { service, ops, share: { db, ops, op }, feeReads: () => feeReads, get: () => ops.get(op.accountId, op.id) };
}

// The purchase row for `input` in a new database, which closes when the test ends.
function purchaseRow(t, walletAgreement, input, sellerTransport, sessionKey) {
  const directory = mkdtempSync(join(tmpdir(), 'purchase-wallet-bridge-'));
  const db = openDatabase(join(directory, 'state.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const ops = createOperationStore({ db, handoffSecret: 'TEST-only-wallet-bridge-secret-000000000', now: () => T0 });
  db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('TEST-buyer', 'TEST', 'TEST-buyer', new Date(T0).toISOString());
  const { artifact, logicalAddress } = input, agreementHash = contentHash(artifact);
  const seller = artifact.parties.find(party => party.role === 'seller').primaryClaim, payout = artifact.terms.payoutBindings[0];
  const terms = { buyer: { wallet: '0x' + input.writer.slice('did:demos:agent:'.length) }, seller: { claim: seller, payee: payout.payeeAddress },
    price: { amountOs: '1000000000' }, listing: { ...artifact.listingRef }, network: walletAgreement.network, rail: payout.railId,
    protocol: { transportBinding: walletAgreement.sourceCapability.transportBinding, jobId: artifact.jobId, profile: OFFLINE_AGREEMENT_PROFILE, wireProfile: 'TEST-wire-profile',
      sellerAgent: 'https://seller.invalid', sellerCommitment: DEVNET_NATIVE_COMMITMENT_MARKER, sellerAgreementProjection: 'public-signed-create', sellerTransport: sellerTransport.declaration } };
  const protocol = { stage: 'agreement-signing', signatures: { agreement: 'TEST-retained-signature' }, planned: { plan: { agreementHash }, draft: artifact, anchorAddress: logicalAddress },
    sessionDelegation: { payload: { sessionPublicKey: sessionKey }, signature: 'TEST-delegation' } };
  const op = ops.createIdempotent({ accountId: 'TEST-buyer', kind: 'purchase', idempotencyKey: 'TEST', request: {}, status: 'agreement_pending', terms, termsHash: agreementHash,
    state: { protocol }, expiresAt: new Date(T0 + 3600000).toISOString() }).operation;
  return { db, ops, op };
}

test("protocol projection reads the verified CREATE from the bridge's shared walletAgreement journal", async t => {
  for (const shared of [true, false]) {
    const { w, walletAgreement } = await walletWorld(t);
    const input = await agreementInput(w), operation = operationBridge(w, walletAgreement);
    const otherJournal = { get: async () => undefined, put: () => assert.fail('no write'), entries: async () => [], withWalletLock: (_key, work) => work() };
    const purchase = purchaseService(t, { ...walletAgreement, ...(shared ? {} : { journal: otherJournal }), bridgeFor: () => operation.bridge }, input);
    await purchase.service.submitAgreement(purchase.get());
    const current = purchase.get(), events = purchase.ops.history(current.id).map(event => event.type);
    assert.equal(operation.requests.length, 1);
    assert.equal(current.status, 'agreement_pending', 'payment stays held');
    if (shared) {
      assert.ok(events.includes('protocol_agreement_public_projection_retained'));
      assert.equal(current.state.protocol.agreement.signedProjection.hash, current.state.protocol.agreement.anchorReceipt.transactionRef.value);
    } else {
      assert.ok(!events.includes('protocol_agreement_public_projection_retained'));
      assert.match(JSON.stringify(current.state.protocol), /the exact public signed CREATE is unavailable; payment remains held/);
    }
  }
});

test('an Agreement send through a paid-approval wallet reaches the host callback as the exact request that is sent, once', async t => {
  assert.equal(PAID_WRITE_FEE_CEILING_OS, '18000000000');
  const { w, counts, approvals, walletAgreement } = await paidWalletWorld(t);
  const input = await agreementInput(w), asked = approvals.length, host = paidHost(), operation = paidBridge(w, walletAgreement, host);
  const result = await operation.bridge.anchor(input);
  assert.equal(result.status, 'native-read-visible', JSON.stringify(result));
  assert.equal(result.plan.stage, 'verified');
  assert.deepEqual({ calls: host.calls.length, previews: host.previews.length, ...sendMarks(w, counts, operation) },
    { calls: 1, previews: 1, requests: 1, signed: 1, effects: ['confirmTx', 'broadcastTx'], broadcasts: 1 });
  const [{ request, members }] = host.calls;
  assert.equal(request, operation.requests[0], 'the callback is handed the object that is sent');
  assert.ok(isDeeplyFrozen(request));
  assert.equal(request.method, 'sendTransaction');
  assert.ok(Object.isFrozen(members));
  assert.deepEqual(members, { preparePaidWrite: operation.wallets[0].preparePaidWrite, authorizePaidWrite: operation.wallets[0].authorizePaidWrite });
  const [[option, ...more]] = operation.options;
  assert.deepEqual([Reflect.ownKeys(option), more], [['paidApproval'], []]);
  assert.equal(option.paidApproval, host.permits[0]);
  assert.equal(canonicalize(w.node.broadcasts[0].content), canonicalize(host.previews[0].signedContent));
  assert.equal(host.previews[0].content.content.feeCeilingOs, PAID_WRITE_FEE_CEILING_OS, 'the host approved the pass ceiling the send runs under');
  assert.equal(approvals.length, asked, 'the host approve callback is not asked for the scoped CREATE');
});

test('a wallet without a host callback refuses before the handoff, any signature or any send', async t => {
  const { w, counts, walletAgreement } = await paidWalletWorld(t);
  const input = await agreementInput(w), bare = paidBridge(w, walletAgreement);
  await assert.rejects(bare.bridge.anchor(input), bridgeCode('paid-write-callback-required'));
  assert.deepEqual(sendMarks(w, counts, bare), NOTHING_SENT);
  assert.equal((await planOf(w, input)).stage, 'prepared');
  // A plan an approving bridge completed is read back by a bridge with no callback, with no refusal and no request.
  assert.equal((await paidBridge(w, walletAgreement, paidHost()).bridge.anchor(input)).status, 'native-read-visible');
  const later = paidBridge(w, walletAgreement), readback = await later.bridge.anchor(input);
  assert.equal(readback.status, 'native-read-visible');
  assert.deepEqual([later.requests.length, w.node.broadcasts.length], [0, 1]);
});

test('a callback that throws or returns no permit refuses before the handoff, any signature or any send', async t => {
  const { w, counts, walletAgreement } = await paidWalletWorld(t);
  const input = await agreementInput(w), declined = new Error('TEST-host-declined');
  const rows = [
    ['throws', () => { throw declined; }, cause => cause === declined],
    ['returns undefined', () => undefined, cause => cause === undefined],
    ['returns null', () => null, cause => cause === undefined],
    ['returns a string', () => 'TEST-permit', cause => cause === undefined],
    ['returns a number', () => 7, cause => cause === undefined],
    ['has its own preview refused', (_approve, request, members) => members.preparePaidWrite(request, { feeCeilingOs: '50000000001' }), cause => cause?.code === 'fee_ceiling_above_session'],
  ];
  for (const [label, answer, causeKept] of rows) {
    const operation = paidBridge(w, walletAgreement, paidHost(answer));
    await assert.rejects(operation.bridge.anchor(input), error => bridgeCode('paid-write-permit-required')(error) && causeKept(error.cause), label);
    assert.deepEqual(sendMarks(w, counts, operation), NOTHING_SENT, label);
    assert.equal((await planOf(w, input)).stage, 'prepared', label);
  }
});

test('a refused permit leaves the plan unissued so a fresh preview and a fresh approval send once', async t => {
  const { w, counts, walletAgreement } = await paidWalletWorld(t);
  const input = await agreementInput(w);
  const host = paidHost(approve => (host.calls.length === 1 ? undefined : approve()));
  const refused = paidBridge(w, walletAgreement, host);
  await assert.rejects(refused.bridge.anchor(input), bridgeCode('paid-write-permit-required'));
  const fresh = paidBridge(w, walletAgreement, host), result = await fresh.bridge.anchor(input);
  assert.equal(result.status, 'native-read-visible', JSON.stringify(result));
  assert.deepEqual({ calls: host.calls.length, requests: refused.requests.length + fresh.requests.length, signed: counts.inSign, broadcasts: w.node.broadcasts.length },
    { calls: 2, requests: 1, signed: 1, broadcasts: 1 });
  assert.deepEqual(host.calls[1].request, host.calls[0].request, 'the fresh preview asks for the same request');
  assert.equal(fresh.requests[0], host.calls[1].request);
});

test('a request changed between the host\'s approval and the send is refused with zero signatures and zero sends', async t => {
  // Each row's host approves, then the named thing changes before the bridge sends.
  const laterTimestamp = request => { const copy = structuredClone(request); copy.params[0].transaction.content.timestamp += 1; return copy; };
  const rows = [
    ['an approval of a request with another timestamp', () => (approve, request) => approve(laterTimestamp(request)), { status: 'rejected', code: 'paid_approval_mismatch' }, 1],
    ['a network fee raised after the approval', ({ reads }) => async approve => { const permit = await approve(); reads.networkFee = 2; return permit; }, { status: 'rejected', code: 'paid_approval_mismatch' }, 1],
    ['a nonce moved while the host decided', ({ w }) => async approve => { const permit = await approve(); w.node.nonce += 1; return permit; }, { thrown: 'stale-plan' }, 0],
    ['a plan record altered while the host decided', ({ w }) => async (approve, request) => {
      const permit = await approve(), [key, plan] = (await w.journal.entries()).find(([name]) => name.startsWith('sr2/adapter/'));
      assert.equal(plan.logicalAddress, request.params[0].logicalAddress);
      plan.payload.content.timestamp += 1;
      await w.journal.put(key, plan);
      return permit;
    }, { thrown: 'paid-write-request-changed' }, 0],
  ];
  for (const [label, answerFor, expected, requests] of rows) {
    const world = await paidWalletWorld(t), { w, counts, walletAgreement } = world;
    const input = await agreementInput(w), operation = paidBridge(w, walletAgreement, paidHost(answerFor(world)));
    const outcome = await operation.bridge.anchor(input).then(result => ({ status: result.status, code: result.code }), error => ({ thrown: error.code }));
    assert.deepEqual(outcome, expected, label);
    assert.deepEqual(sendMarks(w, counts, operation), { ...NOTHING_SENT, requests }, label);
    if (expected.thrown === 'stale-plan') assert.equal((await planOf(w, input)).stage, 'prepared', label);
  }
});

test('an unknown send outcome is read back and never sent again without a new permit', async t => {
  const rows = [
    ['the answer is lost after the node took the CREATE', { loseAnswer: true }, { status: 'native-read-visible', code: undefined }, { signed: 1, broadcasts: 1 }],
    ['the answer is unknown and nothing was sent', { withholdSend: true }, { status: 'rejected', code: 'authorization-required' }, { signed: 0, broadcasts: 0 }],
  ];
  for (const [label, sending, readback, sent] of rows) {
    const { w, counts, walletAgreement } = await paidWalletWorld(t);
    const input = await agreementInput(w), first = paidHost(), unknown = paidBridge(w, walletAgreement, first, sending);
    const result = await unknown.bridge.anchor(input);
    assert.deepEqual([result.status, result.code], ['indeterminate', 'outcome_unknown'], label);
    const later = paidHost(), repeat = paidBridge(w, walletAgreement, later);
    for (const step of ['anchor', 'resume']) {
      const again = await repeat.bridge[step](input);
      assert.deepEqual({ status: again.status, code: again.code }, readback, `${label}: ${step}`);
    }
    assert.deepEqual({ calls: first.calls.length + later.calls.length, requests: unknown.requests.length + repeat.requests.length, signed: counts.inSign, broadcasts: w.node.broadcasts.length },
      { calls: 1, requests: 1, ...sent }, label);
  }
});

test('a wallet session without paid approval sends with one argument and needs no callback', async t => {
  const { w, walletAgreement } = await walletWorld(t);
  const nonceReads = () => w.node.calls.filter(row => row.body?.params?.[0]?.message === 'getAddressNonce').length;
  const input = await agreementInput(w), operation = operationBridge(w, walletAgreement), before = nonceReads();
  assert.equal((await operation.bridge.anchor(input)).status, 'native-read-visible');
  assert.deepEqual([operation.requests.length, operation.options], [1, [[]]], 'one request, passed alone');
  const keys = (await w.journal.entries()).map(([key]) => key);
  assert.deepEqual(keys.filter(key => !/^(?:sr2\/adapter\/|sr2\/wallet\/|eb\/|devnet\/native-)/.test(key)), [], 'only the inner bridge and the wallet wrote');
  // The same anchor with a callback configured previews the handoff first, one more nonce read; this view has no paid members.
  const plainReads = nonceReads() - before, host = paidHost(() => Object.freeze({}));
  const configured = operationBridge(w, walletAgreement, { extra: { obtainPaidWritePermit: host.obtain } }), second = await agreementInput(w, SECOND_JOB), mark = nonceReads();
  assert.equal((await configured.bridge.anchor(second)).status, 'native-read-visible');
  assert.equal(nonceReads() - mark, plainReads + 1, 'only the bridge with a callback previews');
  assert.deepEqual(host.calls[0].members, { preparePaidWrite: undefined, authorizePaidWrite: undefined });
});

// The events that dropped this purchase's retained CREATE intent, by reason.
const droppedIntents = (purchase, row) => purchase.ops.history(row.id).filter(event => event.type === 'protocol_wallet_anchor_not_issued').map(event => event.data.reason);

test('a purchase refused for a missing permit keeps no intent and a later submission anchors once', async t => {
  const { w, counts, walletAgreement } = await paidWalletWorld(t);
  const input = await agreementInput(w), declining = paidBridge(w, walletAgreement, paidHost(() => null));
  let current = declining;
  const purchase = purchaseService(t, { ...walletAgreement, bridgeFor: () => current.bridge }, input, { allowRefusal: true });
  await purchase.service.submitAgreement(purchase.get());
  const refused = purchase.get();
  assert.equal(refused.status, 'agreement_pending');
  assert.equal(refused.state.protocol.walletAnchor, null);
  assert.deepEqual(droppedIntents(purchase, refused), ['paid-write-permit-required']);
  assert.deepEqual(sendMarks(w, counts, declining), NOTHING_SENT);
  const host = paidHost();
  current = paidBridge(w, walletAgreement, host);
  await purchase.service.submitAgreement(purchase.get());
  assert.deepEqual({ calls: host.calls.length, ...sendMarks(w, counts, current) }, { calls: 1, requests: 1, signed: 1, effects: ['confirmTx', 'broadcastTx'], broadcasts: 1 });
  assert.equal((await planOf(w, input)).stage, 'verified');
});

test('the purchase service passes the callback in its wallet configuration to the bridge it builds', async t => {
  const { w, counts, walletAgreement } = await paidWalletWorld(t);
  const input = await agreementInput(w), host = paidHost(), operation = newOperation();
  const purchase = purchaseService(t, { ...walletAgreement, walletFactory: recordingWallet(w, operation, { inPass: true }), obtainPaidWritePermit: host.obtain }, input);
  await purchase.service.submitAgreement(purchase.get());
  assert.deepEqual({ calls: host.calls.length, ...sendMarks(w, counts, operation) }, { calls: 1, requests: 1, signed: 1, effects: ['confirmTx', 'broadcastTx'], broadcasts: 1 });
  assert.equal(host.calls[0].request, operation.requests[0]);
});

test('a host callback that is not a function is refused at construction before any wallet call', async t => {
  const { w, walletAgreement } = await walletWorld(t);
  const entries = (await w.journal.entries()).length;
  let requested = 0;
  const configured = obtainPaidWritePermit => createPurchaseWalletBridge({ walletFactory: () => ({ ...walletAgreement, obtainPaidWritePermit,
    requestWallet: options => { requested += 1; return w.session.walletFactory(options); } }) });
  for (const value of [null, 'TEST-callback', {}, 7]) assert.throws(() => configured(value), bridgeCode('invalid'), String(value));
  assert.deepEqual([requested, (await w.journal.entries()).length], [0, entries], 'no wallet call and no journal write');
  configured(undefined);
  assert.equal(requested, 1);
});

// The wallet journal with a lock that holds nothing: the purchase lock of a call that never returns is not waited on.
const withoutLocks = journal => ({ get: key => journal.get(key), put: (key, value) => journal.put(key, value), entries: () => journal.entries(), withWalletLock: (_key, work) => work() });

// A host whose approval prompt never settles, as when its process is killed while the prompt is open. `asked` resolves once it is entered.
function openPrompt() {
  let entered;
  const asked = new Promise(resolve => { entered = resolve; });
  return { asked, obtain: () => { entered(); return new Promise(() => {}); } };
}

test('a purchase restarted while the host was approving drops its stale intent and then anchors once with a fresh approval', async t => {
  for (const reconcileFirst of [false, true]) {
    const label = reconcileFirst ? 'entered through reconcileAgreementAnchor' : 'entered through anchorAgreement';
    const { w, counts, walletAgreement } = await paidWalletWorld(t);
    const input = await agreementInput(w), prompt = openPrompt(), killed = paidBridge(w, walletAgreement, prompt);
    const first = purchaseService(t, { ...walletAgreement, journal: withoutLocks(w.journal), bridgeFor: () => killed.bridge }, input);
    // Never settles: the killed host's prompt never answers, and nothing releases it.
    void first.service.submitAgreement(first.get());
    await prompt.asked;
    assert.notEqual(first.get().state.protocol.walletAnchor, null, label);
    assert.deepEqual({ stage: (await planOf(w, input)).stage, requests: killed.requests.length, signed: counts.inSign }, { stage: 'prepared', requests: 0, signed: 0 }, label);
    // The restarted host: the same row, a new bridge and a working callback.
    const host = paidHost(), restarted = paidBridge(w, walletAgreement, host);
    const second = purchaseService(t, { ...walletAgreement, journal: withoutLocks(w.journal), bridgeFor: () => restarted.bridge }, input, { share: first.share, allowRefusal: true, reconcileFirst });
    const progress = async () => ({ calls: host.calls.length, requests: restarted.requests.length, signed: counts.inSign, broadcasts: w.node.broadcasts.length,
      stage: (await planOf(w, input)).stage, feeReads: second.feeReads() });
    await second.service.submitAgreement(second.get());
    const dropped = second.get();
    assert.equal(dropped.status, 'agreement_pending', label);
    assert.equal(dropped.state.protocol.walletAnchor, null, label);
    assert.deepEqual(droppedIntents(second, dropped), ['handoff-not-issued'], label);
    assert.deepEqual(await progress(), { calls: 0, requests: 0, signed: 0, broadcasts: 0, stage: 'prepared', feeReads: 0 }, label);
    await second.service.submitAgreement(second.get());
    assert.deepEqual(await progress(), { calls: 1, requests: 1, signed: 1, broadcasts: 1, stage: 'verified', feeReads: 1 }, label);
  }
});
