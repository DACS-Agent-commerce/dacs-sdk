// The client's public purchase entries (createProtocolPurchases, createPurchaseService) composed over a kit host.
// Stand-ins are limited to what the client takes as inputs: Listing verifier, chain reads, native source, the seller
// transport's resolvers, the payment evidence source and the operator context resolver. The service's own seller requests reach the
// host through the client's seller HTTPS client over a fetch stand-in. The resolver posts the context request to the host through the
// kit's HTTP client under the older seller-transport request signer (`clientAuthFor`), because the client has no context-route caller yet.
import { contentHash } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_HEADER, DACS_SELLER_HTTP_PATHS, TESTNET_PROFILE_TP1 } from '@kynesyslabs/dacs/wire';
import { OFFLINE_AGREEMENT_MODE } from '../../packages/dacs-client/src/dacs/protocol-purchases.mjs';
import { createCoordinateStore, createNativePaymentEvidenceConsumer, createProtocolPurchases, createPurchaseService, createSourceDemoSellerTransport,
  createSqlitePurchaseStore, PAID_WRITE_FEE_CEILING_OS } from '../../packages/dacs-client/src/index.mjs';
import { createDevnetNativeCommitmentCapability } from '../../packages/dacs-client/src/devnet-demo/commitment-consumer.mjs';
import { createDevnetSettlementTransport, DEVNET_SETTLEMENT_POLICY } from '../../packages/dacs-client/src/wallet/devnet-native-transport.mjs';
import { openDatabase } from '../../packages/dacs-client/test/helpers/purchase-integrity-database.mjs';
import { createOperationStore } from '../../packages/dacs-client/test/helpers/purchase-integrity-operations.mjs';
import { IDENTITY, passiveNativeWorld } from '../../packages/dacs-client/test/helpers/passive-native-world.mjs';
import { readOnlyBoundary } from '../../packages/dacs-client/test/helpers/read-only-boundary.mjs';
import { requestBoundary } from '../../packages/dacs-client/test/helpers/request-boundary.mjs';
import { kitEndpointProof } from '../../packages/dacs-client/test/helpers/kit-endpoint-proof.mjs';
import { withSeller } from '../../packages/dacs-client/test/helpers/seller-stand-in.mjs';
import { bindFixture, createAuthorityFixture } from '../../packages/dacs-client/test/fixtures/tp1-authority-reader.mjs';
import { createEphemeralWallet } from '../../packages/dacs-client/test/fixtures/wallet.mjs';
import { NOW, buyer, seller, RECEIPT_FEE_CEILINGS } from '../../packages/dacs-seller/test/helpers/protocol-fixture.mjs';
import { signedBuyerClient } from '../../packages/dacs-seller/test/helpers/signed-buyer-driver.mjs';
import { clientAuthFor } from './kit-host.mjs';
import { FIXTURE_ENDPOINT } from '../../packages/dacs-seller/test/helpers/wire-buyer.mjs';
import { fetchAsHost } from '../../packages/dacs-seller/test/helpers/listener-host.mjs';

// The client runs on the kit fixture's clock, since the kit's Listing validity is fixed around the kit's NOW. The client's portal
// capability also compares each purchase link's expiry with the real clock, so a test that drives this world pins Date.now to NOW.
export { NOW };
const ACCOUNT_ID = 'TEST-buyer';
const COMMITMENT_AUTHORITY = 'TEST-RUN-kitclient0';
const CONTEXT_AUTHORITY = 'test:kit-client-operator';
const HANDOFF_SECRET = 'TEST-'.repeat(8);
const IDEMPOTENCY_KEY = 'TEST-idempotency';
// The buyer's mandate cap: the native composition needs one, and this purchase stops before any payment gate.
const MANDATE_CAP_OS = '100000000000';

/** The purchase world: the public service, the stores it writes and a count of everything it sends or does. */
export async function purchaseWorld(t, { host, listing }) {
  // The fixture authority's answer, with every participant it was asked about (the buyer and seller of the session
  // delegation) on the bound profile.
  const authority = createAuthorityFixture();
  const { binding, currentLocal } = await bindFixture({ readAuthority: async (scope) => ({ ...await authority.read(scope),
    participants: scope.participants.map((claim) => ({ claim, profile: binding.profile, modules: TESTNET_PROFILE_TP1.tuple })) }) });
  const admission = { binding, currentLocal };
  const db = openDatabase(':memory:'), store = createSqlitePurchaseStore();
  t.after(() => db.close());
  const now = () => NOW;
  const ops = createOperationStore({ db, handoffSecret: HANDOFF_SECRET, now });
  const coordinates = createCoordinateStore({ db, now });
  db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run(ACCOUNT_ID, 'TEST', ACCOUNT_ID, new Date(NOW).toISOString());
  const native = passiveNativeWorld();
  const commitment = createDevnetNativeCommitmentCapability({ authority: COMMITMENT_AUTHORITY,
    anchor: { authority: COMMITMENT_AUTHORITY, readRetained() { throw new Error('TEST not used'); }, verifyReceipt() { throw new Error('TEST not used'); } } });
  const chain = { network: 'testnet', pinnedIdentity: IDENTITY, networkIdentity: async () => ({ identity: IDENTITY, mode: 'public-chain-read' }),
    getAddressBalance: async () => 10n ** 20n, getTransactionFees: async () => 1n, broadcasts: 0,
    observePassiveTransfer: async () => ({ status: 'not-found' }), broadcastTransaction: async () => { chain.broadcasts++; } };
  const verifier = { verify: async () => ({ transactable: true, payee: seller.address, price: { amount: '2.5', currency: 'DEM', amountOs: '2500000000' }, contentHash: contentHash(listing),
    anchor: { kind: 'storage-program', locator: 'TEST-locator' }, listing, checks: [], evidence: {} }) };
  // Every request this client sends to the host, by path; the host's raw answers to the challenge and context requests.
  const sellerRequests = [], challengeAnswers = [], contextAnswers = [];
  const rawAnswer = async (response) => ({ status: response.status, signed: response.headers.has(DACS_SELLER_HTTP_HEADER), text: await response.clone().text() });
  const sellerClient = signedBuyerClient({ url: host.url, authentication: clientAuthFor(host),
    fetchImpl: async (url, init) => {
      sellerRequests.push(new URL(url).pathname);
      const response = await fetchAsHost()(url, init);
      if (new URL(url).pathname === DACS_SELLER_HTTP_PATHS.context) contextAnswers.push(await rawAnswer(response));
      return response;
    } });
  // What the seller client reported for each failed context exchange: its error class and transport cause label.
  const contextFailures = [];
  const agreementContext = { authority: CONTEXT_AUTHORITY, resolve: async (request) => {
    try { return await sellerClient.agreementContext({ jobId: request.scope.jobId, ...request }); }
    catch (error) { contextFailures.push({ failureClass: error.constructor.name, layer: sellerClient.failureCause }); throw error; }
  } };
  // Prepare admits only terms that declare a seller transport, which needs native payment and its evidence. The purchase
  // stops before any payment evidence read, so the evidence source never runs.
  const unused = (what) => () => { throw new Error(`TEST ${what} not in scope`); };
  const session = createEphemeralWallet();
  const proof = await kitEndpointProof({ binding, local: currentLocal(), listingPin: host.listingPin, now: NOW });
  const sellerTransport = createSourceDemoSellerTransport({ authority: COMMITMENT_AUTHORITY, sessionSignerFor: () => ({ claim: session.claim, sign: (bytes) => session.signBytes(bytes) }),
    sessionPolicyFor: () => ({ expiresAt: NOW + 1_800_000 }), endpointProofFor: () => proof, effectBoundary: requestBoundary(t, { binding, currentLocal }).boundary });
  // The service's own seller requests, answered by the host.
  const reachHost = async (url, init) => {
    const path = new URL(url).pathname;
    sellerRequests.push(path);
    const response = await fetchAsHost()(url.replace(FIXTURE_ENDPOINT, host.url), init);
    if (path === DACS_SELLER_HTTP_PATHS.contextChallenge) challengeAnswers.push(await rawAnswer(response));
    return response;
  };
  const evidenceSource = createDevnetSettlementTransport({ boundary: readOnlyBoundary, journal: native.journal,
    settlementPublication: { policy: DEVNET_SETTLEMENT_POLICY, artifactKind: 'SettlementEvidence', phase: 'pay-dem', railId: 'demos-native:DEM', phaseIndex: 2, authority: COMMITMENT_AUTHORITY },
    expected: { network: 'testnet', chainIdentity: IDENTITY, pinVersion: 'TEST-pin', endpoint: native.source.pins.endpoint, transportAuthority: 'TEST-owner' },
    transportOwner: { getContext: unused('evidence context'), acquireConnectionFence: unused('evidence fence') } });
  // The testnet host's per-write fee ceiling, passed explicitly to both factories.
  const feeCeilingOs = PAID_WRITE_FEE_CEILING_OS;
  const protocol = withSeller(reachHost, () => createProtocolPurchases({ db, ops, coordinates, store, admission, chain, feeCeilingOs, now, buyerAccess: { assertWallet() {} },
    receiptFeeCeilings: RECEIPT_FEE_CEILINGS, buyerMandateCapOs: MANDATE_CAP_OS,
    dacsProtocol: { walletAgreement: { sourceCapability: native.source, network: 'testnet', rpcUrl: native.source.pins.endpoint, journal: native.journal, bridgeFor: () => ({}) },
      nativeSellerCommitment: commitment, nativeAgreementPayment: native.source, sellerTransport,
      nativePaymentEvidence: createNativePaymentEvidenceConsumer({ rpcUrl: native.source.pins.endpoint, sourceCapability: evidenceSource }),
      agreementContext, sellerEndpoint: () => FIXTURE_ENDPOINT } }));
  const service = createPurchaseService({ db, ops, coordinates, store, accounts: { listWallets: () => [{ address: buyer.address }] }, verifier, chain, protocol,
    challenges: {}, config: { demAmountEncoding: 'os-string', publicOrigin: 'https://portal.example.invalid' }, now, purposes: { APPROVE_PURCHASE: 'TEST-approve' }, feeCeilingOs, admission });
  const prepare = () => service.prepare({ accountId: ACCOUNT_ID, listingId: listing.listingId, version: listing.listingVersion, seller: seller.claim,
    idempotencyKey: IDEMPOTENCY_KEY, walletAddress: buyer.address, protocol: OFFLINE_AGREEMENT_MODE });
  return { service, ops, prepare, sellerRequests, challengeAnswers, contextAnswers, contextFailures, native, chain };
}

/**
 * Drives one purchase through the public service until a step fails: prepare, then the start's wallet steps (the seller session
 * delegation; its acceptance with the seller's challenge, which returns the identity presentation; the Agreement plan over that
 * presentation). An earlier step that fails throws. Returns each step's answer, the retained state and the plan's failure, or null.
 * A change that moves the first failure later adds the next step here, with its counters, in the same change (K12, OP-11).
 */
export async function drivePurchase(world) {
  const { operation } = await world.prepare();
  const token = world.ops.handoffTokenFor(operation.id);
  const signText = (text) => `0x${buyer.signBytes(Buffer.from(text, 'utf8')).toString('hex')}`;
  const identity = await world.service.agreementIdentity({ operationId: operation.id, token, address: buyer.address });
  const presentation = await world.service.agreementDelegation({ operationId: operation.id, token, delegationSignature: signText(identity.delegation.message) });
  const failure = await world.service.agreementPlan({ operationId: operation.id, token, signature: signText(presentation.message) })
    .then(() => null, (error) => ({ step: 'plan', error }));
  return { operation, identity, presentation, retained: world.ops.get(ACCOUNT_ID, operation.id), failure };
}
