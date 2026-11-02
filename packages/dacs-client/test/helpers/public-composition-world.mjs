// The public protocol factory composed into the public purchase service, both
// admitted through a real binding. Only the verifier, chain reads, seller
// endpoint, native source and operator context are stand-ins; no protocol
// stand-in is used. Self-contained so a packed consumer can run it: it reaches
// the package only through ../../src (a symlink to the installed package there).
import { compositeVerificationAddress, contentHash } from '@kynesyslabs/dacs';
import { createCoordinateStore, createSqlitePurchaseStore, createProtocolPurchases, createPurchaseService, SellerTlsUnusableError } from '../../src/index.mjs';
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

const vetRef = (jobId, party) => ({ anchor: { kind: 'storage-program', locator: compositeVerificationAddress(jobId, party) }, contentHash: 'c'.repeat(64), signer: THIRD_PARTY_SIGNER });

// The operator's present answer for exactly the scope it was asked about.
function presentAnswer({ scope, buyerIdentityBundle }, listing) {
  return { disposition: 'present', value: { scope, input: { jobId: scope.jobId, generatedAt: scope.generatedAt, selectedRail: scope.rail,
    verifiedListing: { disposition: 'verified', listing, pin: scope.listingPin },
    buyer: { identityBundle: buyerIdentityBundle, vetRecordRef: vetRef(scope.jobId, scope.buyer) },
    seller: { identityBundle: listing.seller.identity, vetRecordRef: vetRef(scope.jobId, scope.seller) },
    payoutBindings: [{ railId: scope.rail.railId, phaseIndex: 2, payeeAddress: scope.payee }] } } };
}

/** Builds the composed world. `sellerEndpoint(claim, options)` answers the protocol's seller lookups; `contextGate` (a Promise) holds the operator's context read. */
export async function compositionWorld(t, { sellerEndpoint = () => SELLER_ENDPOINT, contextGate = Promise.resolve() } = {}) {
  const { binding, currentLocal, authority, current } = await bindFixture();
  const admission = { binding, currentLocal };
  const wallet = createEphemeralWallet(), seller = createEphemeralWallet();
  const db = openDatabase(':memory:'), store = createSqlitePurchaseStore();
  t.after(() => db.close());
  const ops = createOperationStore({ db, handoffSecret: 'TEST-'.repeat(8), now: () => NOW });
  const coordinates = createCoordinateStore({ db, now: () => NOW });
  db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run(ACCOUNT_ID, 'TEST', ACCOUNT_ID, new Date(NOW).toISOString());
  const native = passiveNativeWorld();
  const commitment = createDevnetNativeCommitmentCapability({ authority: AUTHORITY,
    anchor: { authority: AUTHORITY, readRetained() { throw new Error('not used'); }, verifyReceipt() { throw new Error('not used'); } } });
  // `observation` answers the passive transfer read; broadcast and signer counts stay at 0 in held tests.
  const chain = { network: 'testnet', pinnedIdentity: IDENTITY, networkIdentity: async () => ({ identity: IDENTITY, mode: 'public-chain-read' }),
    getAddressBalance: async () => 10n ** 20n, getTransactionFees: async () => 1n, broadcasts: 0,
    observePassiveTransfer: async () => ({ status: 'not-found' }), broadcastTransaction: async () => { chain.broadcasts++; } };
  const listing = fixtureListing(seller, { listingId: 'TEST-listing', now: NOW });
  const verifier = { verify: async () => ({ transactable: true, payee: seller.address, price: { amount: '2.5', amountOs: '2500000000' }, contentHash: contentHash(listing),
    anchor: { kind: 'storage-program', locator: 'TEST-locator' }, listing, checks: [], evidence: {} }) };
  const contextReads = { count: 0 };
  const agreementContext = { authority: OPERATOR_CONTEXT_AUTHORITY, resolve: async (request) => { contextReads.count++; await contextGate; return presentAnswer(request, listing); } };
  // Every protocol call that reaches a seller or the buyer-access seam is counted.
  const counters = { sellerLookups: 0, buyerAccess: 0 };
  const protocol = createProtocolPurchases({ db, ops, coordinates, store, admission, now: () => NOW, buyerAccess: { assertWallet() { counters.buyerAccess++; } },
    dacsProtocol: { walletAgreement: { sourceCapability: native.source, network: 'testnet', rpcUrl: native.source.pins.endpoint, journal: native.journal, bridgeFor: () => ({}) },
      nativeSellerCommitment: commitment, agreementContext, sellerEndpoint: (claim, options) => { counters.sellerLookups++; return sellerEndpoint(claim, options); } } });
  const service = createPurchaseService({ db, ops, coordinates, store, accounts: { listWallets: () => [{ address: wallet.address }] }, verifier, chain, protocol,
    challenges: {}, config: { demAmountEncoding: 'os-string', publicOrigin: 'https://portal.example.invalid' }, now: () => NOW, purposes: { APPROVE_PURCHASE: 'TEST-approve' }, admission });
  const prepare = (idempotencyKey = 'TEST-key') => service.prepare({ accountId: ACCOUNT_ID, listingId: 'TEST-listing', version: 1, seller: seller.claim,
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
  const seed = ({ status, key, expiresAt = new Date(NOW + 3_600_000).toISOString(), protocolTerms, state = { protocol: {} }, reportedTxHash, events = 0, eventData = {} }) => {
    const terms = { buyer: { accountId: ACCOUNT_ID, wallet: wallet.address }, seller: { claim: seller.claim, payee: seller.address }, price: { amount: '2.5', amountOs: '2500000000' },
      network: 'testnet', rail: 'demos-native:DEM', listing: { listingId: 'TEST-listing', version: 1, contentHash: IDENTITY },
      domain: { network: 'testnet', rail: 'demos-native:DEM', mode: 'public-chain-read', chainIdentity: IDENTITY }, ...(protocolTerms ? { protocol: protocolTerms } : {}) };
    const { operation } = ops.createIdempotent({ accountId: ACCOUNT_ID, kind: 'purchase', idempotencyKey: key, request: {}, status, terms, termsHash: IDENTITY, state, expiresAt });
    if (reportedTxHash) {
      coordinates.save({ operationId: operation.id, kind: 'native-dem-transfer', network: 'testnet', from: wallet.address, nonceFence: 6, expectedNonce: 7, target: seller.address, amountOs: '2500000000', payload: {} });
      coordinates.reportHash(operation.id, reportedTxHash);
    }
    for (let index = 0; index < events; index++) ops.record(operation.id, 'TEST-seeded-event', { index, ...eventData });
    return { operation, token: ops.handoffTokenFor(operation.id) };
  };
  const rows = () => JSON.stringify(['operations', 'operation_events', 'write_coordinates', 'wallet_nonce_consumptions', 'approvals']
    .map((name) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
  return { db, ops, coordinates, store, service, protocol, authority, current, native, chain, counters, prepare, preparedWithIdentity, seed, rows, tableCounts, contextReads, wallet };
}

/** Throws unless no object member, at any depth, is undefined. */
export function assertComplete(value, path = 'value') {
  if (value === undefined) throw new Error(`${path} is undefined`);
  if (value !== null && typeof value === 'object') for (const [key, member] of Object.entries(value)) assertComplete(member, `${path}.${key}`);
}
