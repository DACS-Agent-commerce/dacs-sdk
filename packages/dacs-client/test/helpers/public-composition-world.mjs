// The public protocol factory composed into the public purchase service, both
// admitted through a real binding. Only the verifier, chain reads, seller
// endpoint, the seller transport's resolvers, native source and operator context
// are stand-ins; no protocol stand-in is used. Self-contained so a packed consumer can run it: it reaches
// the package only through ../../src (a symlink to the installed package there).
import { DatabaseSync } from 'node:sqlite';
import { compositeVerificationAddress, contentHash } from '@kynesyslabs/dacs';
import { TESTNET_PROFILE_TP1 } from '@kynesyslabs/dacs/wire';
import { createCoordinateStore, createSqlitePurchaseStore, createProtocolPurchases, createPurchaseService, SellerTlsUnusableError, PURCHASE_STATE_SCHEMA,
  createPurchaseOperations, createPurchaseChallenges, createLocalPurchaseAccount, createNativePaymentEvidenceConsumer, createSourceDemoSellerTransport, PAID_WRITE_FEE_CEILING_OS } from '../../src/index.mjs';
import { createDevnetNativeCommitmentCapability } from '../../src/devnet-demo/commitment-consumer.mjs';
import { OFFLINE_AGREEMENT_MODE } from '../../src/dacs/protocol-purchases.mjs';
import { buildUnsignedIdentityBundle } from '../../src/dacs/listing.mjs';
import { agreementChallengeScope } from '../../src/dacs/agreement-context-consumer.mjs';
import { createDevnetSettlementTransport, DEVNET_SETTLEMENT_POLICY } from '../../src/wallet/devnet-native-transport.mjs';
import { readOnlyBoundary } from './read-only-boundary.mjs';
import { openDatabase } from './purchase-integrity-database.mjs';
import { createOperationStore } from './purchase-integrity-operations.mjs';
import { passiveNativeWorld, IDENTITY, NOW } from './passive-native-world.mjs';
import { fixtureListing } from '../fixtures/listings.mjs';
import { createEphemeralWallet } from '../fixtures/wallet.mjs';
import { bindFixture, createAuthorityFixture } from '../fixtures/tp1-authority-reader.mjs';

export { OFFLINE_AGREEMENT_MODE, NOW, SellerTlsUnusableError };
export const ACCOUNT_ID = 'TEST-buyer';
// The seller client accepts only a public https origin; nothing here connects to it.
export const SELLER_ENDPOINT = 'https://seller.example.test';
const AUTHORITY = 'TEST-RUN-composition0';
const OPERATOR_CONTEXT_AUTHORITY = 'test:composition-operator';
const THIRD_PARTY_SIGNER = 'did:demos:agent:' + 'd'.repeat(64);
const HANDOFF_NONCE_FENCE = 6;
const SELLER_NONCE = 'e'.repeat(64);
const HANDOFF_SECRET = 'TEST-'.repeat(8);
export const HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;
const APPROVAL_ORIGIN = 'https://portal.example.invalid';
const APPROVAL_PURPOSE = 'approve-purchase';
const CHALLENGE_TTL_MS = 300_000;
// The explicit seller receipt inputs the native composition needs; no test here reaches a payment gate with a receipt.
const RECEIPT_LIMITS = { receiptFeeCeilings: { payFeeCeilingOs: '1000', anchorFeeCeilingOs: '2000' }, buyerMandateCapOs: '100000000000' };

// A fresh database with only the package schema.
function freshDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(PURCHASE_STATE_SCHEMA);
  return db;
}
// The three host objects the package ships, on one database and store.
function shippedHostAdapters({ db, store, wallet, now }) {
  return {
    accounts: createLocalPurchaseAccount({ db, store, wallet: wallet.address, now }),
    ops: createPurchaseOperations({ db, store, handoffSecret: HANDOFF_SECRET, handoffTtlMs: HANDOFF_TTL_MS, now }),
    challenges: createPurchaseChallenges({ db, store, origin: APPROVAL_ORIGIN, purpose: APPROVAL_PURPOSE, ttlMs: CHALLENGE_TTL_MS, now }),
  };
}

const vetRef = (jobId, party) => ({ anchor: { kind: 'storage-program', locator: compositeVerificationAddress(jobId, party) }, contentHash: 'c'.repeat(64), signer: THIRD_PARTY_SIGNER });

// The operator's present answer for exactly the scope it was asked about.
function presentAnswer({ scope, buyerIdentityBundle }, listing) {
  return { disposition: 'present', value: { scope, input: { jobId: scope.jobId, generatedAt: scope.generatedAt, selectedRail: scope.rail,
    verifiedListing: { disposition: 'verified', listing, pin: scope.listingPin },
    buyer: { identityBundle: buyerIdentityBundle, vetRecordRef: vetRef(scope.jobId, scope.buyer) },
    seller: { identityBundle: listing.seller.identity, vetRecordRef: vetRef(scope.jobId, scope.seller) },
    payoutBindings: [{ railId: scope.rail.railId, phaseIndex: 2, payeeAddress: scope.payee }] } } };
}

/**
 * Builds the composed world. `sellerEndpoint(claim, options)` answers the protocol's seller lookups; `contextGate` (a Promise) holds the
 * operator's context read; `demDeliveryContext` (a capability) replaces the operator context. `unpaid` composes the default
 * configuration instead: no native payment, no payment evidence and no seller transport. `passiveOnly` builds both factories
 * read-only; `native` replaces the native source world (a `passiveNativeWorld` over another journal, say). With `shippedAdapters`,
 * the world runs on a fresh schema with the package's own operations, accounts and challenges adapters under the local account,
 * and `rebuild({ now })` builds new adapters and both factories on the same database, as after a restart. `feeCeilingOs` is the
 * host's per-write fee ceiling (the exported testnet value by default); the chain double's fee is 1 OS.
 */
export async function compositionWorld(t, { sellerEndpoint = () => SELLER_ENDPOINT, contextGate = Promise.resolve(), demDeliveryContext = null, unpaid = false, stopped,
  passiveOnly = false, native = passiveNativeWorld(), shippedAdapters = false, feeCeilingOs = PAID_WRITE_FEE_CEILING_OS } = {}) {
  // The fixture authority's answer, with every participant it was asked about (the buyer and seller of the session
  // delegation) on the bound profile; its gate, failure and call count still apply.
  const authority = createAuthorityFixture();
  const { binding, currentLocal, current } = await bindFixture({ readAuthority: async (scope) => ({ ...await authority.read(scope),
    participants: scope.participants.map((claim) => ({ claim, profile: binding.profile, modules: TESTNET_PROFILE_TP1.tuple })) }) });
  const admission = { binding, currentLocal };
  const wallet = createEphemeralWallet(), seller = createEphemeralWallet();
  const db = shippedAdapters ? freshDatabase() : openDatabase(':memory:'), store = createSqlitePurchaseStore();
  t.after(() => db.close());
  // Every protocol call that reaches a seller or the buyer-access seam is counted.
  const counters = { sellerLookups: 0, buyerAccess: 0, challengesIssued: 0 };
  const stubAdapters = () => {
    db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run(ACCOUNT_ID, 'TEST', ACCOUNT_ID, new Date(NOW).toISOString());
    return { ops: createOperationStore({ db, handoffSecret: HANDOFF_SECRET, now: () => NOW }), accounts: { listWallets: () => [{ address: wallet.address }] },
      challenges: { issue: () => { counters.challengesIssued++; return { challengeId: 'TEST-challenge' }; } } };
  };
  const adapters = shippedAdapters ? shippedHostAdapters({ db, store, wallet, now: () => NOW }) : stubAdapters();
  const { ops } = adapters;
  const accountId = shippedAdapters ? adapters.accounts.accountId : ACCOUNT_ID;
  const purposes = { APPROVE_PURCHASE: shippedAdapters ? APPROVAL_PURPOSE : 'TEST-approve' };
  const coordinates = createCoordinateStore({ db, now: () => NOW });
  const commitment = createDevnetNativeCommitmentCapability({ authority: AUTHORITY,
    anchor: { authority: AUTHORITY, readRetained() { throw new Error('not used'); }, verifyReceipt() { throw new Error('not used'); } } });
  // `observation` answers the passive transfer read; broadcast and signer counts stay at 0 in held tests.
  const chain = { network: 'testnet', pinnedIdentity: IDENTITY, networkIdentity: async () => ({ identity: IDENTITY, mode: 'public-chain-read' }),
    getAddressBalance: async () => 10n ** 20n, getTransactionFees: async () => 1n, getAddressNonce: async () => HANDOFF_NONCE_FENCE, broadcasts: 0,
    observePassiveTransfer: async () => ({ status: 'not-found' }), broadcastTransaction: async () => { chain.broadcasts++; } };
  const listing = fixtureListing(seller, { listingId: 'TEST-listing', now: NOW });
  const verifier = { verify: async () => ({ transactable: true, payee: seller.address, price: { amount: '2.5', amountOs: '2500000000' }, contentHash: contentHash(listing),
    anchor: { kind: 'storage-program', locator: 'TEST-locator' }, listing, checks: [], evidence: {} }) };
  const contextReads = { count: 0 };
  const agreementContext = { authority: OPERATOR_CONTEXT_AUTHORITY, resolve: async (request) => { contextReads.count++; await contextGate; return presentAnswer(request, listing); } };
  // Prepare admits only terms that declare a seller transport, which needs native payment and its evidence. The buyer's
  // identity step names the session key and its expiry; no test here reaches a seller or reads payment evidence, so the
  // session never signs and the endpoint proof and evidence source never run.
  const unused = (what) => () => { throw new Error(`TEST ${what} not in scope`); };
  const session = createEphemeralWallet();
  const sellerTransport = createSourceDemoSellerTransport({ authority: AUTHORITY, sessionSignerFor: () => ({ claim: session.claim, sign: unused('session signing') }),
    sessionPolicyFor: () => ({ expiresAt: NOW + 1_800_000 }), endpointProofFor: unused('endpoint proof'), effectBoundary: readOnlyBoundary });
  const evidenceSource = createDevnetSettlementTransport({ boundary: readOnlyBoundary, journal: native.journal,
    settlementPublication: { policy: DEVNET_SETTLEMENT_POLICY, artifactKind: 'SettlementEvidence', phase: 'pay-dem', railId: 'demos-native:DEM', phaseIndex: 2, authority: AUTHORITY },
    expected: { network: 'testnet', chainIdentity: IDENTITY, pinVersion: 'TEST-pin', endpoint: native.source.pins.endpoint, transportAuthority: 'TEST-owner' },
    transportOwner: { getContext: unused('evidence context'), acquireConnectionFence: unused('evidence fence') } });
  const compose = ({ ops, accounts, challenges }, now) => {
    const protocol = createProtocolPurchases({ db, ops, coordinates, store, admission, stopped, chain, feeCeilingOs, ...(passiveOnly ? { passiveOnly } : {}), now, buyerAccess: { assertWallet() { counters.buyerAccess++; } }, ...RECEIPT_LIMITS,
      dacsProtocol: { walletAgreement: { sourceCapability: native.source, network: 'testnet', rpcUrl: native.source.pins.endpoint, journal: native.journal, bridgeFor: () => ({}) },
        nativeSellerCommitment: commitment,
        ...(unpaid ? {} : { nativeAgreementPayment: native.source, sellerTransport,
          nativePaymentEvidence: createNativePaymentEvidenceConsumer({ rpcUrl: native.source.pins.endpoint, sourceCapability: evidenceSource }) }),
        ...(demDeliveryContext ? { demDeliveryContext } : { agreementContext }), sellerEndpoint: (claim, options) => { counters.sellerLookups++; return sellerEndpoint(claim, options); } } });
    const service = createPurchaseService({ db, ops, coordinates, store, accounts, verifier, chain, protocol,
      challenges, config: { demAmountEncoding: 'os-string', publicOrigin: APPROVAL_ORIGIN }, now, purposes, admission, stopped, feeCeilingOs,
      ...(passiveOnly ? { passiveOnly } : {}) });
    return { protocol, service };
  };
  const { protocol, service } = compose(adapters, () => NOW);
  const rebuild = ({ now = () => NOW } = {}) => {
    if (!shippedAdapters) throw new Error('rebuild needs a world built with shippedAdapters');
    const rebuilt = shippedHostAdapters({ db, store, wallet, now });
    return { ops: rebuilt.ops, ...compose(rebuilt, now) };
  };
  const prepare = (idempotencyKey = 'TEST-key') => service.prepare({ accountId, listingId: 'TEST-listing', version: 1, seller: seller.claim,
    idempotencyKey, walletAddress: wallet.address, protocol: OFFLINE_AGREEMENT_MODE });
  // Prepares a purchase, has the buyer sign the seller session delegation, and saves the accepted delegation and the presentation
  // request the bootstrap leaves over a seller challenge (no test here reaches a seller, so none is asked); returns what
  // agreementPlan needs, with the buyer's presentation signature.
  const preparedWithIdentity = async () => {
    const { operation } = await prepare();
    const token = ops.handoffTokenFor(operation.id);
    const { operation: requested, delegation } = await service.agreementIdentity({ operationId: operation.id, token, address: wallet.address });
    const sessionDelegation = { payload: delegation.payload, signature: wallet.signBytes(Buffer.from(delegation.message, 'utf8')).toString('base64url') };
    const identity = buildUnsignedIdentityBundle({ address: wallet.address, presentedAt: NOW, sessionNonce: SELLER_NONCE });
    // The challenge scope the delegation step saves with the accepted delegation.
    const challengeScope = agreementChallengeScope({ operation: requested, buyer: identity.bundle.presentedBy, generatedAt: NOW });
    const protocol = requested.state.protocol;
    ops.transition(requested.id, requested.status, requested.status, { state: { ...requested.state, protocol: { ...protocol, sessionDelegation, challengeScope, identity, revision: (protocol.revision ?? 0) + 1,
      progressGeneration: (protocol.progressGeneration ?? protocol.revision ?? 0) + 1 } }, event: 'TEST-identity-requested', data: {} });
    return { operationId: operation.id, token, signature: wallet.signHex(identity.message) };
  };
  const tableCounts = () => Object.fromEntries(['operations', 'operation_events', 'write_coordinates'].map((name) => [name, db.prepare(`SELECT count(*) n FROM ${name}`).get().n]));
  // Seeds a saved purchase row directly, as a host database would hold it after earlier work.
  // `currentListing` makes the saved listing hash equal what the verifier answers; `handoff` saves unreported coordinates at the chain's nonce fence.
  const seed = ({ status, key, expiresAt = new Date(NOW + 3_600_000).toISOString(), protocolTerms, state = { protocol: {} }, reportedTxHash, events = 0, eventData = {}, currentListing = false, handoff = false }) => {
    const terms = { buyer: { accountId, wallet: wallet.address }, seller: { claim: seller.claim, payee: seller.address }, price: { amount: '2.5', amountOs: '2500000000' },
      network: 'testnet', rail: 'demos-native:DEM', listing: { listingId: 'TEST-listing', version: 1, contentHash: currentListing ? contentHash(listing) : IDENTITY },
      domain: { network: 'testnet', rail: 'demos-native:DEM', mode: 'public-chain-read', chainIdentity: IDENTITY }, ...(protocolTerms ? { protocol: protocolTerms } : {}) };
    const { operation } = ops.createIdempotent({ accountId, kind: 'purchase', idempotencyKey: key, request: {}, status, terms, termsHash: IDENTITY, state, expiresAt });
    if (reportedTxHash || handoff) {
      coordinates.save({ operationId: operation.id, kind: 'native-dem-transfer', network: 'testnet', from: wallet.address, nonceFence: HANDOFF_NONCE_FENCE, expectedNonce: 7, target: seller.address, amountOs: '2500000000', payload: {} });
      if (reportedTxHash) coordinates.reportHash(operation.id, reportedTxHash);
    }
    for (let index = 0; index < events; index++) ops.record(operation.id, 'TEST-seeded-event', { index, ...eventData });
    return { operation, token: ops.handoffTokenFor(operation.id) };
  };
  const rows = () => JSON.stringify(['operations', 'operation_events', 'write_coordinates', 'wallet_nonce_consumptions', 'approvals']
    .map((name) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
  return { db, ops, coordinates, store, service, protocol, admission, authority, current, native, chain, counters, prepare, preparedWithIdentity, seed, rows, tableCounts, contextReads, wallet,
    accountId, rebuild };
}

/** Throws unless no object member, at any depth, is undefined. */
export function assertComplete(value, path = 'value') {
  if (value === undefined) throw new Error(`${path} is undefined`);
  if (value !== null && typeof value === 'object') for (const [key, member] of Object.entries(value)) assertComplete(member, `${path}.${key}`);
}
