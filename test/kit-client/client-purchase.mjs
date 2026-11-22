// The client's public purchase entries (createProtocolPurchases, createPurchaseService) composed over a kit host.
// Stand-ins are limited to what the client takes as inputs: Listing verifier, chain reads, native source, the seller
// transport's resolvers, the payment evidence source and the operator context resolver. The resolver posts the context request to the host through the kit's HTTP client under
// the client's own request signer, because the client has no context-route caller yet.
import { contentHash } from '@kynesyslabs/dacs';
import { TESTNET_PROFILE_TP1 } from '@kynesyslabs/dacs/wire';
import { OFFLINE_AGREEMENT_MODE } from '../../packages/dacs-client/src/dacs/protocol-purchases.mjs';
import { createCoordinateStore, createNativePaymentEvidenceConsumer, createProtocolPurchases, createPurchaseService, createSourceDemoSellerTransport,
  createSqlitePurchaseStore } from '../../packages/dacs-client/src/index.mjs';
import { createDevnetNativeCommitmentCapability } from '../../packages/dacs-client/src/devnet-demo/commitment-consumer.mjs';
import { createDevnetSettlementTransport, DEVNET_SETTLEMENT_POLICY } from '../../packages/dacs-client/src/wallet/devnet-native-transport.mjs';
import { openDatabase } from '../../packages/dacs-client/test/helpers/purchase-integrity-database.mjs';
import { createOperationStore } from '../../packages/dacs-client/test/helpers/purchase-integrity-operations.mjs';
import { IDENTITY, NOW as CLIENT_NOW, passiveNativeWorld } from '../../packages/dacs-client/test/helpers/passive-native-world.mjs';
import { readOnlyBoundary } from '../../packages/dacs-client/test/helpers/read-only-boundary.mjs';
import { bindFixture, createAuthorityFixture } from '../../packages/dacs-client/test/fixtures/tp1-authority-reader.mjs';
import { createEphemeralWallet } from '../../packages/dacs-client/test/fixtures/wallet.mjs';
import { buyer, seller } from '../../packages/dacs-seller/test/helpers/protocol-fixture.mjs';
import { createSellerAgentClient } from '../../packages/dacs-seller/src/dacs/seller-http.mjs';
import { clientAuthFor } from './kit-host.mjs';
import { FIXTURE_ENDPOINT } from '../../packages/dacs-seller/test/helpers/wire-buyer.mjs';
import { fetchAsHost } from '../../packages/dacs-seller/test/helpers/listener-host.mjs';

// The client's portal capability compares each purchase link's expiry with the real clock as well as its own, so the client's
// clock must lie after real time (it is the client's own tests' clock). The kit fixture's clock cannot move: its Listing validity
// is fixed around the kit's NOW. A later change that needs one shared clock for both sides must re-base the kit fixture first.
export { CLIENT_NOW };
const ACCOUNT_ID = 'TEST-buyer';
const COMMITMENT_AUTHORITY = 'TEST-RUN-kitclient0';
const CONTEXT_AUTHORITY = 'test:kit-client-operator';
const HANDOFF_SECRET = 'TEST-'.repeat(8);
const IDEMPOTENCY_KEY = 'TEST-idempotency';

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
  const now = () => CLIENT_NOW;
  const ops = createOperationStore({ db, handoffSecret: HANDOFF_SECRET, now });
  const coordinates = createCoordinateStore({ db, now });
  db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run(ACCOUNT_ID, 'TEST', ACCOUNT_ID, new Date(CLIENT_NOW).toISOString());
  const native = passiveNativeWorld();
  const commitment = createDevnetNativeCommitmentCapability({ authority: COMMITMENT_AUTHORITY,
    anchor: { authority: COMMITMENT_AUTHORITY, readRetained() { throw new Error('TEST not used'); }, verifyReceipt() { throw new Error('TEST not used'); } } });
  const chain = { network: 'testnet', pinnedIdentity: IDENTITY, networkIdentity: async () => ({ identity: IDENTITY, mode: 'public-chain-read' }),
    getAddressBalance: async () => 10n ** 20n, getTransactionFees: async () => 1n, broadcasts: 0,
    observePassiveTransfer: async () => ({ status: 'not-found' }), broadcastTransaction: async () => { chain.broadcasts++; } };
  const verifier = { verify: async () => ({ transactable: true, payee: seller.address, price: { amount: '2.5', amountOs: '2500000000' }, contentHash: contentHash(listing),
    anchor: { kind: 'storage-program', locator: 'TEST-locator' }, listing, checks: [], evidence: {} }) };
  // Every request this client sends to the host, by path.
  const sellerRequests = [];
  const sellerClient = createSellerAgentClient({ url: host.url, authentication: clientAuthFor(host),
    fetchImpl: (url, init) => { sellerRequests.push(new URL(url).pathname); return fetchAsHost()(url, init); } });
  // What the seller client reported for each failed context exchange: its error class and transport cause label.
  const contextFailures = [];
  const agreementContext = { authority: CONTEXT_AUTHORITY, resolve: async (request) => {
    try { return await sellerClient.agreementContext({ jobId: request.scope.jobId, ...request }); }
    catch (error) { contextFailures.push({ failureClass: error.constructor.name, layer: sellerClient.failureCause }); throw error; }
  } };
  // Prepare admits only terms that declare a seller transport, which needs native payment and its evidence. The purchase
  // stops before any seller call of its own or any payment evidence read, so the session never signs and the endpoint
  // proof and evidence source never run.
  const unused = (what) => () => { throw new Error(`TEST ${what} not in scope`); };
  const session = createEphemeralWallet();
  const sellerTransport = createSourceDemoSellerTransport({ authority: COMMITMENT_AUTHORITY, sessionSignerFor: () => ({ claim: session.claim, sign: unused('session signing') }),
    sessionPolicyFor: () => ({ expiresAt: CLIENT_NOW + 1_800_000 }), endpointProofFor: unused('endpoint proof'), effectBoundary: readOnlyBoundary });
  const evidenceSource = createDevnetSettlementTransport({ boundary: readOnlyBoundary, journal: native.journal,
    settlementPublication: { policy: DEVNET_SETTLEMENT_POLICY, artifactKind: 'SettlementEvidence', phase: 'pay-dem', railId: 'demos-native:DEM', phaseIndex: 2, authority: COMMITMENT_AUTHORITY },
    expected: { network: 'testnet', chainIdentity: IDENTITY, pinVersion: 'TEST-pin', endpoint: native.source.pins.endpoint, transportAuthority: 'TEST-owner' },
    transportOwner: { getContext: unused('evidence context'), acquireConnectionFence: unused('evidence fence') } });
  const protocol = createProtocolPurchases({ db, ops, coordinates, store, admission, now, buyerAccess: { assertWallet() {} },
    dacsProtocol: { walletAgreement: { sourceCapability: native.source, network: 'testnet', rpcUrl: native.source.pins.endpoint, journal: native.journal, bridgeFor: () => ({}) },
      nativeSellerCommitment: commitment, nativeAgreementPayment: native.source, sellerTransport,
      nativePaymentEvidence: createNativePaymentEvidenceConsumer({ rpcUrl: native.source.pins.endpoint, sourceCapability: evidenceSource }),
      agreementContext, sellerEndpoint: () => FIXTURE_ENDPOINT } });
  const service = createPurchaseService({ db, ops, coordinates, store, accounts: { listWallets: () => [{ address: buyer.address }] }, verifier, chain, protocol,
    challenges: {}, config: { demAmountEncoding: 'os-string', publicOrigin: 'https://portal.example.invalid' }, now, purposes: { APPROVE_PURCHASE: 'TEST-approve' }, admission });
  const prepare = () => service.prepare({ accountId: ACCOUNT_ID, listingId: listing.listingId, version: listing.listingVersion, seller: seller.claim,
    idempotencyKey: IDEMPOTENCY_KEY, walletAddress: buyer.address, protocol: OFFLINE_AGREEMENT_MODE });
  return { service, ops, prepare, sellerRequests, contextFailures, native, chain };
}

/**
 * Drives one purchase through the public service until a step fails: prepare, the identity presentation, then the Agreement plan
 * (whose context read is the first call to the seller). Returns the retained identity state and the first failure, or null.
 * A change that moves the first failure later adds the next step here, with its counters, in the same change (K12, OP-11).
 */
export async function drivePurchase(world) {
  const { operation } = await world.prepare();
  const token = world.ops.handoffTokenFor(operation.id);
  const identity = await world.service.agreementIdentity({ operationId: operation.id, token, address: buyer.address });
  const retained = world.ops.get(ACCOUNT_ID, operation.id);
  const signText = (text) => `0x${buyer.signBytes(Buffer.from(text, 'utf8')).toString('hex')}`;
  const signature = signText(identity.message), delegationSignature = signText(identity.delegation.message);
  const failure = await world.service.agreementPlan({ operationId: operation.id, token, signature, delegationSignature }).then(() => null, (error) => ({ step: 'plan', error }));
  return { operation, identity, retained, failure };
}
