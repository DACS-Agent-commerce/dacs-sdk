// Builds, with the guard on, the capability each constructor in RETURNED_CLASSIFICATION returns, over fixtures that already build
// it, so kit-operation-guard.test.mjs can enumerate what each one hands out. Keys are '<file>#<constructor>', and
// '<file>#<constructor>.<method>()' for the capability a returned method resolves.
// The wallet-session world comes first: it installs the client's purchase-admission hook before any module reaches the client.
import { walletSessionWorld } from './seller-wallet-session-world.mjs';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { inspectWireOperation, TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { contextWireWorld } from './context-wire-world.mjs';
import { countedKeyRoles } from './counted-key-roles.mjs';
import { durableFixture } from './durable-state-fixture.mjs';
import { HOST_CONTEXT_CALLBACKS } from './host-context-callbacks.mjs';
import { contextHostFixture } from './host-context-client.mjs';
import { orchestratorFixture } from './vet-orchestrator-fixture.mjs';
import { anchorFixture } from './anchor-isolated-fixture.mjs';
import { agentFixture } from './seller-agent-isolated-fixture.mjs';
import { sellerWalletWorld } from './seller-node-wallet-world.mjs';
import { readOnlyRoleOf, TEST_BINDING, testEffectBoundary, testRunCreate } from './agent-signing.mjs';
import { world as wireWorld } from './wire-routes-world.mjs';
import { TEST_CONNECTION } from './wire-authority-fixture.mjs';
import { seller } from './protocol-fixture.mjs';
import { createAbandonedPurchaseState } from '../../src/dacs/abandoned-purchase.mjs';
import { createAccountingReconciler } from '../../src/dacs/accounting-reconciliation.mjs';
import { createAgentEffectSigner } from '../../src/dacs/agent-effect-signer.mjs';
import { createAnswerSigners } from '../../src/dacs/answer-signers.mjs';
import { createSellerAuthorityReader } from '../../src/dacs/authority-reader.mjs';
import { createBootstrapScopes } from '../../src/dacs/bootstrap-scope.mjs';
import { signatureCommitmentAnchor } from '../../src/dacs/commit-on-signature.mjs';
import { createContextEffectEvidence } from '../../src/dacs/compensation-proof.mjs';
import { createContextWorkRegistry } from '../../src/dacs/context-work-registry.mjs';
import { createCosignatureAnswer } from '../../src/dacs/cosignature-answer.mjs';
import { createDeliverableWalletJournal, deliverableJournalFor } from '../../src/dacs/deliverable-wallet-journal.mjs';
import { createDemDeliveryContext, demDeliveryContextHost } from '../../src/dacs/dem-delivery-context-consumer.mjs';
import { createDemosSr2Adapter, createInMemoryDemosSr2Journal } from '../../src/dacs/demos-sr2-adapter.mjs';
import { createEffectHistory } from '../../src/dacs/effect-history.mjs';
import { createFixtureSettlement } from '../../src/dacs/fixture-settlement.mjs';
import { createNativeDemDeliveryCapability } from '../../src/dacs/native-dem-delivery-consumer.mjs';
import { createNativePaymentEvidenceConsumer } from '../../src/dacs/native-payment-evidence-consumer.mjs';
import { createPaymentEvidenceWalletJournal, createSignedCreateJournal, paymentEvidenceWalletJournalOf } from '../../src/dacs/payment-evidence-wallet-journal.mjs';
import { takeLease } from '../../src/dacs/process-lease.mjs';
import { commitmentReader } from '../../src/dacs/purchase-protocol.mjs';
import { admissionTransactionInternals } from '../../src/dacs/seller-admission-transaction.mjs';
import { createSellerChallengeLedger } from '../../src/dacs/seller-challenge-ledger.mjs';
import { createCompletionRecords } from '../../src/dacs/seller-completion-records.mjs';
import { createContextAttempt } from '../../src/dacs/seller-context-attempt.mjs';
import { createAcceptedContinuation, createContextOutcomeRevalidation, createContinuationCheck } from '../../src/dacs/seller-context-continuation.mjs';
import { resumeContext } from '../../src/dacs/seller-context-recovery.mjs';
import { completedContextOutcome, contextOperationView, createSellerContextRecords, createSellerContextRoute } from '../../src/dacs/seller-context-route.mjs';
import { createSellerEffectRoutes } from '../../src/dacs/seller-effect-routes.mjs';
import { createCompletedOutcomeReader, createOrdinaryCompletionPort, createSellerAgentClient } from '../../src/dacs/seller-http.mjs';
import { createPlannedAgreementReader } from '../../src/dacs/seller-planned-agreement.mjs';
import { createPurchaseCapacity } from '../../src/dacs/seller-purchase-capacity.mjs';
import { createLiveAttemptGate, createReservationAccounting } from '../../src/dacs/seller-reservation-accounting.mjs';
import { createSellerTransportStore, sellerStoreInternals } from '../../src/dacs/seller-transport-auth.mjs';
import { openWireRequest, wireAuthenticator } from '../../src/dacs/seller-wire-requests.mjs';
import { createOperatorBuyerAccess } from '../../src/devnet-demo/buyer-access.mjs';
import { currentAuthorizationFor, lateSellerCreatePass } from '../../src/devnet-demo/create-pass.mjs';
import { createDevnetPurchasedReportProducer } from '../../src/devnet-demo/deliverable.mjs';
import { createDevnetDemoListingPublisher } from '../../src/devnet-demo/listing.mjs';
import { createDevnetDemoDeliveryCapability } from '../../src/devnet-demo/native-delivery.mjs';
import { composeSellerApproval, createExactOperatorApproval, createSellerContextAdmission } from '../../src/devnet-demo/operator-approval.mjs';
import { lateWriteWatchOpen } from '../../src/devnet-demo/late-write-watch.mjs';
import { createInMemoryPartyVetStore, openPartyVetStore } from '../../src/devnet-demo/party-vet-store.mjs';
import { openVerifiedEnrollmentReader } from '../../src/devnet-demo/seller-enrollment-reader.mjs';
import { sellerRecordsPurchaseResolver } from '../../src/devnet-demo/seller-purchase-source.mjs';
import { testOnlyNodeKey, trustedNodeFor } from './enrollment-signing.mjs';
import { storageWriteRpcSigner } from '../../src/devnet-demo/storage-write-recovery.mjs';
import { createWriteExclusionRule } from '../../src/devnet-demo/write-exclusion.mjs';
import { loadKeyFile } from '../../src/seller-key.mjs';
import { createImmutableReadbacks } from '../../src/util/immutable-readbacks.mjs';

const privateDirectory = (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-returned-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const POLICY = Object.freeze({ mode: 'policy' });
const never = (name) => () => { throw new Error(`TEST the inventory never calls ${name}`); };
const journalOptions = (directory, name) => ({ path: join(directory, name), signCreate: never('signCreate'), broadcast: never('broadcast'), readAccountNonce: never('readAccountNonce'),
  readTransactionState: never('readTransactionState'), readNetworkInfo: never('readNetworkInfo') });

/**
 * The builders, in order: `[key, build(worlds)]`. `worlds` holds the fixtures the builders share, made once by `returnedCapabilities`.
 * A builder answers the capability its constructor returned.
 */
export function capabilityBuilders(t) {
  const signer = { claim: seller.claim, sign: seller.signBytes };
  const directory = () => privateDirectory(t);
  const onClose = (value) => { t.after(() => value.close?.()); return value; };
  return [
    ['src/devnet-demo/agreement-context.mjs#createDevnetDemoAgreementContextProvider', (w) => w.provider],
    ['src/devnet-demo/seller-wallet-session.mjs#createSellerWalletSession', (w) => w.session.port],
    ['src/devnet-demo/seller-wallet-session.mjs#createSellerWalletSession.finalize()', async (w) => (await w.session.finalize()).session],
    ['src/devnet-demo/listing.mjs#createDevnetDemoListingPublisher', () => createDevnetDemoListingPublisher({ anchor: { publish: async () => {}, read: async () => {}, verifyReceipt: async () => {} },
      sign: signer.sign, scanOwnListings: async () => ({ status: 'ok', anchors: [] }), loadRailResolution: async () => null, runCreate: testRunCreate().runCreate })],
    ['src/devnet-demo/create-pass.mjs#createSellerCreatePass', () => testRunCreate()],
    ['src/devnet-demo/create-pass.mjs#lateSellerCreatePass', () => lateSellerCreatePass(() => testRunCreate().runCreate)],
    ['src/devnet-demo/create-pass.mjs#currentAuthorizationFor', () => currentAuthorizationFor({ held: () => true, revision: null })],
    ['src/seller-key.mjs#openSellerKey', (w) => w.key.key],
    ['src/seller-key.mjs#loadKeyFile', async () => {
      const keyDirectory = directory(), file = join(keyDirectory, 'seller.key');
      writeFileSync(file, JSON.stringify({ format: 'dacs-seller-key/v1', algorithm: 'ed25519', mnemonic: 'TEST mnemonic seed 2' }), { mode: 0o600 });
      return loadKeyFile(file);
    }],
    ['src/dacs/seller-http.mjs#createSellerAgentClient', () => createSellerAgentClient({ url: 'http://127.0.0.1:1', commitOnSignature: true })],
    ['src/dacs/seller-http.mjs#createSellerHttpHandler', (w) => w.context.handler],
    ['src/dacs/seller-http.mjs#createCompletedOutcomeReader', (w) => createCompletedOutcomeReader({ journal: w.context.wire.journal, seller: seller.claim })],
    ['src/dacs/seller-http.mjs#createOrdinaryCompletionPort', (w) => createOrdinaryCompletionPort({ journal: w.context.wire.journal, store: w.context.store, capacity: w.context.capacity })],
    ['src/dacs/answer-signers.mjs#createAnswerSigners', () => createAnswerSigners({ roles: { ...signer, readOnlyAnswerSigner: readOnlyRoleOf(signer) }, effectBoundary: testEffectBoundary().effectBoundary,
      binding: TEST_BINDING, local: () => ({ ...TEST_CONNECTION }) })],
    ['src/dacs/seller-wire-requests.mjs#wireAuthenticator', (w) => wireAuthenticator(w.wire.handle.wire, w.wire.agent)],
    ['src/dacs/seller-wire-requests.mjs#createWireContext', (w) => w.context.wire],
    ['src/dacs/seller-wire-requests.mjs#openWireRequest', async (w) => openWireRequest(w.context.wire, (await w.context.sign({})).header, () => {})],
    ['src/dacs/seller-context-route.mjs#createWireSellerContextRoute', (w) => w.context.route],
    ['src/dacs/seller-context-route.mjs#createSellerContextRoute', (w) => createSellerContextRoute({ listing: w.context.listing, assertBuyerAccess: async () => true })],
    ['src/dacs/seller-context-route.mjs#createSellerContextRecords', (w) => createSellerContextRecords({ listing: w.context.listing, admission: () => null, contextOutcome: () => null })],
    ['src/dacs/seller-context-route.mjs#contextOperationView', (w) => contextOperationView(w.context.wire.journal, seller.claim)],
    ['src/dacs/seller-context-route.mjs#completedContextOutcome', (w) => completedContextOutcome(w.context.wire.journal, seller.claim)],
    ['src/dacs/seller-context-recovery.mjs#resumeContext', (w) => resumeContext(w.provider, w.vet.input)],
    ['src/dacs/seller-context-continuation.mjs#createContextOutcomeRevalidation', (w) => createContextOutcomeRevalidation({ provider: w.provider, retainedBody: w.vet.input })],
    ['src/dacs/seller-context-continuation.mjs#createContinuationCheck', (w) => createContinuationCheck({ ledger: w.context.store.challenges, completedOutcomeOf: () => null })],
    ['src/dacs/seller-context-continuation.mjs#createAcceptedContinuation', (w) => createAcceptedContinuation({ wire: w.context.wire, seller: seller.claim, pin: w.context.pin, checkPolicy: async () => null,
      admissionRecord: () => null, revalidate: async () => null, assertLive: () => {} })],
    ['src/dacs/seller-context-attempt.mjs#createContextAttempt', (w) => createContextAttempt({ jobId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', effect: { leaseUntil: 1 }, capability: { attempt: 1, rev: 1 },
      admissionTransaction: w.context.admission, now: () => 0, monotonicNow: () => 0 })],
    ['src/dacs/seller-planned-agreement.mjs#createPlannedAgreementReader', (w) => createPlannedAgreementReader({ listing: w.context.listing, admissionRecord: () => null, completedOutcomeOf: () => null,
      records: createSellerContextRecords({ listing: w.context.listing, admission: () => null, contextOutcome: () => null }), revalidate: async () => null })],
    ['src/dacs/dem-delivery-context-consumer.mjs#demDeliveryContextHost', (w) => demDeliveryContextHost(w.demContext)],
    ['src/dacs/seller-admission-transaction.mjs#createContextAdmissionTransaction', (w) => w.context.admission],
    ['src/dacs/seller-admission-transaction.mjs#admissionTransactionInternals', (w) => admissionTransactionInternals(w.context.admission)],
    ['src/dacs/seller-reservation-accounting.mjs#createReservationCoordinator', (w) => w.context.coordinator],
    ['src/dacs/seller-reservation-accounting.mjs#createReservationAccounting', () => createReservationAccounting({ store: {}, now: () => 0,
      limits: { maxRecords: 1, maxJobs: 1, maxContextRecords: 1, maxNoncesPerBuyerPerWindow: 1 } })],
    ['src/dacs/seller-reservation-accounting.mjs#createLiveAttemptGate', (w) => createLiveAttemptGate({ accounting: w.context.store.reservationAccounting, now: () => 0 })],
    ['src/dacs/seller-transport-auth.mjs#createSellerTransportStore', (w) => w.context.store],
    ['src/dacs/seller-transport-auth.mjs#sellerStoreInternals', (w) => sellerStoreInternals(w.context.store)],
    ['src/dacs/seller-purchase-capacity.mjs#createPurchaseCapacity', () => {
      const store = onClose(createSellerTransportStore({ path: join(directory(), 'transport.sqlite') }));
      return createPurchaseCapacity({ store, now: () => 0, sessionState: sellerStoreInternals(store).sessionState });
    }],
    ['src/dacs/seller-completion-records.mjs#createCompletionRecords', (w) => createCompletionRecords({ store: w.context.store, capacity: w.context.capacity })],
    ['src/dacs/accounting-reconciliation.mjs#createAccountingReconciler', (w) => createAccountingReconciler({ store: w.context.store, capacity: w.context.capacity, journal: w.context.wire.journal,
      inspectOperation: (target) => inspectWireOperation(w.context.wire.journal, target) })],
    ['src/dacs/seller-challenge-ledger.mjs#createSellerChallengeLedger', () => {
      const db = new Database(':memory:');
      t.after(() => db.close());
      return createSellerChallengeLedger({ db, transaction: (work) => db.transaction(work)(), now: () => 0, generation: 'TEST-inventory', sessionState: () => null,
        admissionCounts: () => ({ challenges: 0 }), ready: () => true, stopped: () => false });
    }],
    ['src/dacs/closed-bootstrap-gate.mjs#createClosedBootstrapGate', (w) => w.context.closedBootstrapGate],
    ['src/dacs/bootstrap-scope.mjs#createBootstrapScopes', (w) => createBootstrapScopes({ sellerClaim: seller.claim, listingPin: w.context.pin, retainedJob: () => null, maxConcurrent: 1 })],
    ['src/dacs/abandoned-purchase.mjs#createAbandonedPurchaseState', () => createAbandonedPurchaseState({ admissionRecord: () => null, operationState: () => null, retainsCommitmentWork: () => false,
      holdsPayment: () => false, agreementDeadline: () => null, now: () => 0 })],
    ['src/dacs/context-work-registry.mjs#createContextWorkRegistry', () => createContextWorkRegistry()],
    ['src/dacs/compensation-proof.mjs#createContextEffectEvidence', () => createContextEffectEvidence({ readRetained: async () => ({ status: 'absent' }) })],
    ['src/dacs/cosignature-answer.mjs#createCosignatureAnswer', () => createCosignatureAnswer({ effectBoundary: testEffectBoundary().effectBoundary })],
    ['src/dacs/agent-effect-signer.mjs#createAgentEffectSigner', (w) => createAgentEffectSigner({ effectBoundary: testEffectBoundary().effectBoundary, effectSigner: signer, durable: w.durable.store,
      pinVersion: TEST_BINDING.profile.pinVersion })],
    ['src/dacs/effect-boundary.mjs#createEffectBoundary', () => testEffectBoundary().effectBoundary],
    ['src/dacs/effect-history.mjs#createEffectHistory', () => createEffectHistory({ dataDirectory: directory() })],
    ['src/dacs/seller-durable-state.mjs#createSellerDurableState', (w) => w.durable.store],
    ['src/dacs/seller-agent.mjs#createSellerAgent', (w) => w.agent.agent],
    // The agent's own settlement for a simulated fixture: its signer, anchors and durable state are the agent's, never called here.
    ['src/dacs/fixture-settlement.mjs#createFixtureSettlement', (w) => createFixtureSettlement({ listing: w.context.listing, anchors: w.agent.anchors, claim: seller.claim, sign: never('sign'),
      signEvidence: never('signEvidence'), commit: never('commit'), sessionFor: never('sessionFor'), now: () => 0 })],
    ['src/dacs/seller-effect-routes.mjs#createSellerEffectRoutes', () => createSellerEffectRoutes({ commitOnSignature: true })],
    ['src/dacs/commit-on-signature.mjs#signatureCommitmentAnchor', () => signatureCommitmentAnchor({ anchorAgreement: never('anchorAgreement'), onCreateAuthorized: never('onCreateAuthorized') }, signer, true)],
    ['src/dacs/purchase-protocol.mjs#commitmentReader', (w) => commitmentReader(w.agent.anchors, seller.claim)],
    ['src/dacs/payment-evidence-wallet-journal.mjs#createPaymentEvidenceWalletJournal', () => onClose(createPaymentEvidenceWalletJournal(journalOptions(directory(), 'evidence.sqlite')))],
    ['src/dacs/payment-evidence-wallet-journal.mjs#paymentEvidenceWalletJournalOf', () => {
      const journal = onClose(createPaymentEvidenceWalletJournal(journalOptions(directory(), 'evidence.sqlite')));
      return paymentEvidenceWalletJournalOf(journal.anchorEvidence);
    }],
    ['src/dacs/payment-evidence-wallet-journal.mjs#createSignedCreateJournal', () => onClose(createSignedCreateJournal({ ...journalOptions(directory(), 'creates.sqlite'), table: 'inventory_creates' }))],
    ['src/dacs/deliverable-wallet-journal.mjs#createDeliverableWalletJournal', () => onClose(createDeliverableWalletJournal(journalOptions(directory(), 'deliverable.sqlite')))],
    ['src/dacs/deliverable-wallet-journal.mjs#deliverableJournalFor', () => {
      const journal = onClose(createDeliverableWalletJournal(journalOptions(directory(), 'deliverable.sqlite')));
      const capability = createNativeDemDeliveryCapability({ authority: 'TEST-inventory', submitAuthorized: journal.submitAuthorized, reconcile: never('reconcile'), read: never('read'), verifyReceipt: never('verifyReceipt') });
      return deliverableJournalFor(capability, journal.resume);
    }],
    ['src/dacs/native-payment-evidence-consumer.mjs#createNativePaymentEvidenceConsumer', () => {
      const journal = onClose(createPaymentEvidenceWalletJournal(journalOptions(directory(), 'evidence.sqlite')));
      return createNativePaymentEvidenceConsumer({ rpcUrl: 'http://127.0.0.1:9/', fetchImpl: never('a fetch'), anchorEvidence: journal.anchorEvidence, readSignedProjection: journal.readSignedProjection });
    }],
    ['src/dacs/native-dem-delivery-consumer.mjs#createNativeDemDeliveryCapability', () => createNativeDemDeliveryCapability({ authority: 'TEST-inventory', submitAuthorized: never('submit'), reconcile: never('reconcile'),
      read: never('read'), verifyReceipt: never('verifyReceipt') })],
    ['src/dacs/dem-delivery-context-consumer.mjs#createDemDeliveryContext', (w) => w.demContext],
    ['src/devnet-demo/late-write-watch.mjs#lateWriteWatchOpen', () => lateWriteWatchOpen(0, 1)],
    ['src/dacs/demos-sr2-adapter.mjs#createInMemoryDemosSr2Journal', () => createInMemoryDemosSr2Journal()],
    ['src/dacs/demos-sr2-adapter.mjs#createDemosSr2Adapter', () => createDemosSr2Adapter({ rpcUrl: 'http://127.0.0.1:9/', journal: createInMemoryDemosSr2Journal(), fetchImpl: never('a fetch') })],
    ['src/dacs/authority-reader.mjs#createSellerAuthorityReader', (w) => createSellerAuthorityReader({ connectionAuthority: never('the connection reader'), identityRecord: TP1_APPROVED_IDENTITY_RECORD,
      claim: seller.claim, listingPin: w.context.pin, bootstrap: { current: () => null }, retainedJob: () => null, participantImplementations: { entriesFor: () => [] } })],
    ['src/dacs/process-lease.mjs#takeLease', () => onClose(takeLease(directory()))],
    ['src/dacs/host-stages.mjs#openSellerStages', (w) => w.session.stages],
    ['src/devnet-demo/artifact-anchor.mjs#createDevnetDemoArtifactAnchor', (w) => w.anchor.open()],
    ['src/devnet-demo/native-delivery.mjs#createDevnetDemoDeliveryCapability', (w) => w.delivery],
    ['src/devnet-demo/buyer-access.mjs#createOperatorBuyerAccess', () => createOperatorBuyerAccess({ openBuyerAccess: false, custodyBuyer: seller.claim })],
    ['src/devnet-demo/deliverable.mjs#createDevnetPurchasedReportProducer', () => createDevnetPurchasedReportProducer({ producer: seller.claim, produce: async () => ({}) })],
    ['src/devnet-demo/operator-approval.mjs#composeSellerApproval', (w) => composeSellerApproval({ mode: 'policy', policy: w.approval, manual: async () => true })],
    ['src/devnet-demo/operator-approval.mjs#createExactOperatorApproval', (w) => w.approval],
    ['src/devnet-demo/operator-approval.mjs#createSellerContextAdmission', () => createSellerContextAdmission({ evidencePath: join(directory(), 'approvals.jsonl'), sellerApproval: POLICY })],
    ['src/devnet-demo/party-vet-store.mjs#createInMemoryPartyVetStore', () => createInMemoryPartyVetStore()],
    ['src/devnet-demo/party-vet-store.mjs#openPartyVetStore', () => onClose(openPartyVetStore({ path: join(directory(), 'party.sqlite'), mode: 'create' }))],
    ['src/devnet-demo/seller-node-wallet.mjs#createSellerNodeWallet', (w) => w.nodeWallet.wallet],
    ['src/devnet-demo/seller-enrollment-reader.mjs#openVerifiedEnrollmentReader', (w) => onClose(openVerifiedEnrollmentReader({ endpoint: 'https://rpc.example.invalid/',
      transportAuthority: 'TEST-inventory', fetchImpl: never('a fetch'), claim: seller.claim, listingPin: w.context.pin, trustedNode: trustedNodeFor(testOnlyNodeKey()) }))],
    ['src/devnet-demo/seller-purchase-source.mjs#sellerRecordsPurchaseResolver', () => sellerRecordsPurchaseResolver({ sessionOf: () => null, buyerAccess: createOperatorBuyerAccess({ openBuyerAccess: false, custodyBuyer: seller.claim }),
      now: () => 0, observePayment: never('observePayment') })],
    ['src/devnet-demo/seller-state-lock.mjs#acquireSellerStateLock', (w) => w.nodeWallet.stateLock],
    ['src/devnet-demo/storage-write-recovery.mjs#storageWriteRpcSigner', () => storageWriteRpcSigner(signer, seller.claim)],
    ['src/devnet-demo/write-exclusion.mjs#createWriteExclusionRule', () => createWriteExclusionRule({ hash: 'a'.repeat(64), nonce: 1, readRpc: never('readRpc'), readAccountNonce: never('readAccountNonce') })],
    ['src/util/immutable-readbacks.mjs#createImmutableReadbacks', () => createImmutableReadbacks()],
    ['src/host.mjs#startSellerHost', (w) => w.host],
  ];
}

/** The fixtures the builders share. */
async function sharedWorlds(t) {
  const vet = await orchestratorFixture(t);
  const session = await walletSessionWorld(t);
  const key = await countedKeyRoles(t);
  const wire = await wireWorld(t);
  const context = await contextWireWorld(t);
  const durable = await durableFixture(t);
  const agent = await agentFixture();
  t.after(() => agent.close());
  const anchor = await anchorFixture();
  const nodeWallet = await sellerWalletWorld(t);
  const deliveryAnchor = { authority: 'TEST-inventory', writer: seller.claim, publish: never('publish'), read: async () => ({ status: 'absent' }), readRetained: async () => ({ status: 'absent' }), verifyReceipt: async () => 'valid' };
  const delivery = createDevnetDemoDeliveryCapability({ authority: deliveryAnchor.authority, anchor: deliveryAnchor });
  const demContext = createDemDeliveryContext({ authority: 'TEST-inventory', resolveBuyer: async () => null, resolveSeller: async () => null, ...HOST_CONTEXT_CALLBACKS });
  const hostWorld = await contextHostFixture(t);
  const host = await hostWorld.start();
  const approval = createExactOperatorApproval({ maxTotalOs: '10000000000', evidencePath: join(privateDirectory(t), 'approvals.jsonl'), now: () => 0, sellerApproval: { mode: 'manual' },
    authorize: never('the operator') });
  return { vet, provider: vet.provider(), session, key, wire, context, durable, agent, anchor, nodeWallet, delivery, demContext, host, approval };
}

/** Map of every builder's key to the capability its constructor returned; a builder that fails rejects with its key. */
export async function returnedCapabilities(t, { onFailure = null } = {}) {
  const worlds = await sharedWorlds(t);
  const built = new Map();
  for (const [key, build] of capabilityBuilders(t)) {
    try { built.set(key, await build(worlds)); } catch (error) {
      if (onFailure === null) throw new Error(`TEST could not build ${key}`, { cause: error });
      onFailure(key, error);
    }
  }
  return built;
}
