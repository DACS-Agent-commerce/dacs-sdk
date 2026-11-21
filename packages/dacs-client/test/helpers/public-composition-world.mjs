// The public protocol factory composed into the public purchase service, both
// admitted through a real binding. Only the verifier, chain reads, seller
// endpoint, native source and operator context are stand-ins; no protocol
// stand-in is used. Self-contained so a packed consumer can run it: it reaches
// the package only through ../../src (a symlink to the installed package there).
import { DatabaseSync } from 'node:sqlite';
import { compositeVerificationAddress, contentHash } from '@kynesyslabs/dacs';
import { createCoordinateStore, createSqlitePurchaseStore, createProtocolPurchases, createPurchaseService, SellerTlsUnusableError, PURCHASE_STATE_SCHEMA,
  createPurchaseOperations, createPurchaseChallenges, createLocalPurchaseAccount } from '../../src/index.mjs';
import { createDevnetNativeCommitmentCapability } from '../../src/devnet-demo/commitment-consumer.mjs';
import { OFFLINE_AGREEMENT_MODE } from '../../src/dacs/protocol-purchases.mjs';
import { openDatabase } from './purchase-integrity-database.mjs';
import { createOperationStore } from './purchase-integrity-operations.mjs';
import { passiveNativeWorld, IDENTITY, NOW } from './passive-native-world.mjs';
import { fixtureListing } from '../fixtures/listings.mjs';
import { createEphemeralWallet } from '../fixtures/wallet.mjs';
import { bindFixture } from '../fixtures/tp1-authority-reader.mjs';

export { OFFLINE_AGREEMENT_MODE, NOW, SellerTlsUnusableError };
export const ACCOUNT_ID = 'TEST-buyer';
// The seller client accepts only a loopback endpoint; nothing here connects to it.
export const SELLER_ENDPOINT = 'http://127.0.0.1:9';
const AUTHORITY = 'TEST-RUN-composition0';
const OPERATOR_CONTEXT_AUTHORITY = 'test:composition-operator';
const THIRD_PARTY_SIGNER = 'did:demos:agent:' + 'd'.repeat(64);
const HANDOFF_NONCE_FENCE = 6;
const HANDOFF_SECRET = 'TEST-'.repeat(8);
export const HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;
const APPROVAL_ORIGIN = 'https://portal.example.invalid';
const APPROVAL_PURPOSE = 'approve-purchase';
const CHALLENGE_TTL_MS = 300_000;

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
 * operator's context read; `demDeliveryContext` (a capability) replaces the operator context. With `shippedAdapters`, the world runs on a
 * fresh schema with the package's own operations, accounts and challenges adapters under the local account, and `rebuild({ now })`
 * builds new adapters and both factories on the same database, as after a restart.
 */
export async function compositionWorld(t, { sellerEndpoint = () => SELLER_ENDPOINT, contextGate = Promise.resolve(), demDeliveryContext = null, stopped, shippedAdapters = false } = {}) {
  const { binding, currentLocal, authority, current } = await bindFixture();
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
  const native = passiveNativeWorld();
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
  const compose = ({ ops, accounts, challenges }, now) => {
    const protocol = createProtocolPurchases({ db, ops, coordinates, store, admission, stopped, now, buyerAccess: { assertWallet() { counters.buyerAccess++; } },
      dacsProtocol: { walletAgreement: { sourceCapability: native.source, network: 'testnet', rpcUrl: native.source.pins.endpoint, journal: native.journal, bridgeFor: () => ({}) },
        nativeSellerCommitment: commitment, ...(demDeliveryContext ? { demDeliveryContext } : { agreementContext }), sellerEndpoint: (claim, options) => { counters.sellerLookups++; return sellerEndpoint(claim, options); } } });
    const service = createPurchaseService({ db, ops, coordinates, store, accounts, verifier, chain, protocol,
      challenges, config: { demAmountEncoding: 'os-string', publicOrigin: APPROVAL_ORIGIN }, now, purposes, admission, stopped });
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
  // Prepares a purchase and has the buyer present their identity; returns what agreementPlan needs.
  const preparedWithIdentity = async () => {
    const { operation } = await prepare();
    const token = ops.handoffTokenFor(operation.id);
    const { message } = await service.agreementIdentity({ operationId: operation.id, token, address: wallet.address });
    return { operationId: operation.id, token, signature: wallet.signHex(message) };
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
