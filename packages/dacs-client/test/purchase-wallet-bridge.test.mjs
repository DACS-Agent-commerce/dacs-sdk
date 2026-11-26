// The public purchase wallet bridge over the real storage-anchor bridge, the real Node wallet session, the durable
// wallet journal and a scripted node; the purchase service test replaces only its seller exchange and readers.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash } from '@kynesyslabs/dacs';
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

const SECOND_JOB = '01M5YKPJG0248H248H248H249A';
const walletRequired = error => error instanceof DemosSr2BridgeError && error.code === 'wallet-required';
const reply = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

// The scripted node plus what a full native readback needs: the name index, the block's validation data and the
// program's creating transaction. `unavailable` makes the transaction read fail.
function readableNode(node, chainIdentity) {
  const control = { unavailable: false };
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
    if (message === 'searchStoragePrograms') return reply(ok(created.filter(tx => tx.content.data[1].programName === data.query)
      .map(tx => ({ storageAddress: tx.content.to, programName: tx.content.data[1].programName }))));
    if (message === 'getBlockByNumber' && data.blockNumber > 0) return reply(ok({ number: data.blockNumber, status: 'confirmed', hash: 'b'.repeat(64),
      content: { timestamp: T0 / 1000, previousHash: chainIdentity, ordered_transactions: [...node.applied.keys()] }, validation_data: { TEST: 'single-node-observation', chainIdentity } }));
    return undefined;
  };
  return control;
}

async function walletWorld(t) {
  const w = await finalizedWorld(t); await w.build();
  const reads = readableNode(w.node, w.session.transport.pins.chainIdentity);
  const walletAgreement = { rpcUrl: w.owner.local.endpoint, network: w.session.wallet.getWriteProfile().network, journal: w.journal, sourceCapability: w.session.transport };
  return { w, reads, walletAgreement };
}

// One operation's bridge. Its wallet records each request, and with `loseAnswer` the node takes the CREATE but the answer is lost.
function operationBridge(w, walletAgreement, { loseAnswer = false, extra = {} } = {}) {
  const operation = { requests: [], configurations: [], wallets: [] };
  operation.bridge = createPurchaseWalletBridge({ walletFactory: () => {
    const configuration = { ...walletAgreement, ...extra, requestWallet: options => {
      const wallet = w.session.walletFactory(options);
      const own = { ...wallet, request: async input => {
        operation.requests.push(input);
        const answer = await wallet.request(input);
        return loseAnswer && answer.success ? { success: false, error: { code: 'outcome_unknown' } } : answer;
      } };
      operation.wallets.push(own);
      return own;
    } };
    operation.configurations.push(configuration);
    return configuration;
  } });
  return operation;
}

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
  await assert.rejects(never.bridge.resume(await agreementInput(w, SECOND_JOB)), { code: 'authorization-required' });
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
// anchors through the service's own anchor adapter and then reads the CREATE back through it.
function purchaseService(t, walletAgreement, input) {
  const directory = mkdtempSync(join(tmpdir(), 'purchase-wallet-bridge-'));
  const db = openDatabase(join(directory, 'state.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const ops = createOperationStore({ db, handoffSecret: 'TEST-only-wallet-bridge-secret-000000000', now: () => T0 });
  db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('TEST-buyer', 'TEST', 'TEST-buyer', new Date(T0).toISOString());
  const { artifact, logicalAddress } = input, agreementHash = contentHash(artifact);
  // The seller client is built but never sends: the exchange below stands in for the seller, and the commit request fails offline.
  const sessionKey = 'a'.repeat(64), sessionSigner = { claim: 'did:demos:agent:' + sessionKey, sign: () => assert.fail('nothing is signed') };
  const sellerTransport = createSourceDemoSellerTransport({ authority: 'TEST-wallet-bridge', sessionSignerFor: () => sessionSigner, sessionPolicyFor: () => ({}), endpointProofFor: () => ({}), effectBoundary: readOnlyBoundary });
  const seller = artifact.parties.find(party => party.role === 'seller').primaryClaim, payout = artifact.terms.payoutBindings[0];
  const terms = { buyer: { wallet: '0x' + input.writer.slice('did:demos:agent:'.length) }, seller: { claim: seller, payee: payout.payeeAddress },
    price: { amountOs: '1000000000' }, listing: { ...artifact.listingRef }, network: walletAgreement.network, rail: payout.railId,
    protocol: { transportBinding: walletAgreement.sourceCapability.transportBinding, jobId: artifact.jobId, profile: OFFLINE_AGREEMENT_PROFILE, wireProfile: 'TEST-wire-profile',
      sellerAgent: 'https://seller.invalid', sellerCommitment: DEVNET_NATIVE_COMMITMENT_MARKER, sellerAgreementProjection: 'public-signed-create', sellerTransport: sellerTransport.declaration } };
  const protocol = { stage: 'agreement-signing', signatures: { agreement: 'TEST-retained-signature' }, planned: { plan: { agreementHash }, draft: artifact, anchorAddress: logicalAddress },
    sessionDelegation: { payload: { sessionPublicKey: sessionKey }, signature: 'TEST-delegation' } };
  const op = ops.createIdempotent({ accountId: 'TEST-buyer', kind: 'purchase', idempotencyKey: 'TEST', request: {}, status: 'agreement_pending', terms, termsHash: agreementHash,
    state: { protocol }, expiresAt: new Date(T0 + 3600000).toISOString() }).operation;
  globalThis[Symbol.for('TEST-stored-request-flows')] = {
    payment: null, evidence: null, chain: { readCommitment: async () => ({ status: 'indeterminate', reason: 'TEST-readback-pending' }) },
    fetch: async () => { throw new Error('TEST-seller-offline'); },
    async exchange({ anchorAdapter }) {
      const anchorInput = { artifact, agreementHash, logicalAddress };
      assert.equal((await anchorAdapter.anchorAgreement(anchorInput)).disposition, 'submitted');
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
    store: { transaction, isUniqueViolation }, buyerAccess: { assertWallet() {} }, now: () => T0, feeCeilingOs: '50000000000', chain: { getTransactionFees: async () => 1n } });
  return { service, ops, get: () => ops.get(op.accountId, op.id) };
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
