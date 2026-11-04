// C0 keys and real wire verification; no network or wall-clock dependency.
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize, contentHash, generateCanonicalJobId, sha256Hex } from '@kynesyslabs/dacs';
import * as wire from '@kynesyslabs/dacs/wire';
import { installPurchaseAdmissionHook, loadAdmissionDouble } from './purchase-admission-hook.mjs';
import { LOCAL } from '../fixtures/tp1-authority-reader.mjs';
import { fixtureListing } from '../fixtures/listings.mjs';
installPurchaseAdmissionHook();
export const { setPurchaseAdmission } = await loadAdmissionDouble();
const { openDatabase } = await import('./purchase-integrity-database.mjs');
const { createOperationStore } = await import('./purchase-integrity-operations.mjs');
const { createSqlitePurchaseStore } = await import('../../src/seams/purchase-store-not-wired.mjs');
export const T0 = 1793102400000;
export const JOB = generateCanonicalJobId({ timestamp: T0, entropy: Buffer.alloc(10, 0x11) });
export const OLD_REQUEST = 'dacs-chatgpt-plugin:loopback-seller-peer:v1:';
export const OLD_DELEGATION = 'dacs-chatgpt-plugin:seller-session-delegation:v1:';
export function party(seed) {
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, seed)]), format: 'der', type: 'pkcs8' });
  const raw = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  return { claim: `did:demos:agent:${raw}`, address: `0x${raw}`, raw, sign: (bytes) => sign(null, bytes, key), signBytes: (bytes) => sign(null, bytes, key) };
}
export const encode = (payload, signer, domain) => Buffer.from(canonicalize({ payload, signature: signer.sign(Buffer.from(domain + canonicalize(payload))).toString('base64url') })).toString('base64url');
export const code = (expected) => (error) => error.code === expected;
export const PUBLIC_ENDPOINT = 'https://127.0.0.1:19001';
export const validReceipt =Object.assign(async () => 'valid', { chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity });
// pin, agreementHash, ready and readCommitmentReceipt (null: a proof without a receipt reader) let a test commit a real purchase.
export async function world(t, { pin: committedPin, agreementHash = sha256Hex('agreement'), ready = true, readCommitmentReceipt = validReceipt } = {}) {
  setPurchaseAdmission('testnet-tp1');
  t.after(() => setPurchaseAdmission('held'));
  const buyer = party(1), seller = party(2), session = party(3), other = party(4), local = { ...LOCAL };
  const state = { time: T0, gate: null, failure: null, signs: [], listingReaderFailure: null, listingExpiresAt: Number.MAX_SAFE_INTEGER };
  const binding = await wire.bindTp1Profile({
    record: wire.TP1_APPROVED_IDENTITY_RECORD, local, readAuthority: async (scope) => {
      if (state.gate)
        await state.gate(scope);
      if (state.failure)
        throw state.failure;
      return {
        local: { ...scope.local }, chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity, provenance: 'TEST-C0', sessionId: scope.sessionId,
        participants: scope.participants.map(claim => ({ claim, profile: binding.profile, modules: wire.TESTNET_PROFILE_TP1.tuple }))
      };
    }
  });
  const admission = { binding, currentLocal: () => ({ ...local }) }, pin = committedPin ?? { listingId: 'tp1-vector-listing', version: 1, contentHash: sha256Hex('contracts-vector-listing') };
  const publicEndpoint = PUBLIC_ENDPOINT;
  const document = await wire.signDiscoveryDocument({
    format: 'dacs-seller-discovery/v1', profile: binding.profile, seller: seller.claim, publicEndpoint,
    transport: ['dacs-seller-http/v1'], listings: [pin], capabilities: wire.TP1_CAPABILITIES, ready, issuedAt: T0, expiresAt: T0 + 120000
  }, seller, binding, local);
  const endpointProof = await wire.verifyEndpointProof(document, {
    binding, local, now: T0, listing: { seller: seller.claim, publicEndpoint, listingPin: pin }, ...(readCommitmentReceipt ? { readCommitmentReceipt } : {}),
    readListingEligibility: async (scope) => {
      if (state.listingReaderFailure)
        throw state.listingReaderFailure;
      return {
        seller: scope.seller, publicEndpoint: scope.publicEndpoint, listingPin: scope.listingPin, pricingKind: 'fixed', negotiation: 'negotiate-fixed-price', commitPhase: 'commit-payee-bound-agreement', rail: 'pay-dem', delivery: { channel: 'demos-storage', address: 'dacs4:deliverable:{jobId}' }, service: { kind: 'fixed-text' }, output: { envelope: 'dacs-chatgpt-plugin/devnet-purchased-report', reportVersion: '1', mediaType: 'text/plain; charset=utf-8', maxCharacters: 16384, synchronous: true }, buyerRequestInput: false, notBefore: 0, expiresAt: state.listingExpiresAt
      };
    }
  });
  const payload = {
    version: '1', kind: 'seller-session-delegation', buyer: buyer.claim, sessionPublicKey: session.raw, seller: seller.claim, listingPin: pin, jobId: JOB, notBefore: T0 - 30000, expiresAt: T0 + 1800000, profile: binding.profile
  };
  const delegation = { payload, signature: buyer.sign(await wire.sellerSessionDelegationSigningBytes(payload, binding, local)).toString('base64url') };
  const job = { jobId: JOB, listingPin: pin, agreementHash, deadline: T0 + 3600000, profile: binding.profile };
  const sessionSigner = { claim: session.claim, sign(bytes) {
      state.signs.push(Buffer.from(bytes));
      return session.sign(bytes);
    } };
  const { createSellerWireAuthentication } = await import('../../src/dacs/seller-wire-authentication.mjs');
  const options = { admission, sessionSigner, delegation, seller: seller.claim, publicEndpoint, endpointProof, job, now: () => state.time };
  const auth = createSellerWireAuthentication(options);
  return { buyer, seller, session, other, local, state, binding, admission, pin, endpointProof, publicEndpoint, payload, delegation, job, options, auth, createSellerWireAuthentication };
}
export const request = (w, path = wire.DACS_SELLER_HTTP_PATHS.state) => w.auth.request(path, { transportIdentity: { jobId: JOB } }, JSON.stringify({ transportIdentity: { jobId: JOB } }));
export async function purchase(t, w, { policy = () => ({ expiresAt: T0 + 1800000 }), declaration, protocolPatch = {}, status = 'agreement_pending', paid = false, signedListing } = {}) {
  const { createSourceDemoSellerTransport } = await import('../../src/dacs/source-demo-seller-transport.mjs');
  const { createProtocolPurchases } = await import('../../src/index.mjs');
  let policies = 0;
  const transport = createSourceDemoSellerTransport({
    authority: 'TEST-wire', sessionSignerFor: () => w.options.sessionSigner, sessionPolicyFor: (op) => {
      policies++;
      return policy(op);
    }, endpointProofFor: () => w.endpointProof
  });
  const listing = signedListing ?? fixtureListing(w.seller, { now: T0 });
  const terms = {
    buyer: { wallet: w.buyer.address }, seller: { claim: w.seller.claim, payee: w.seller.address }, listing: { listingId: listing.listingId, version: listing.listingVersion, contentHash: contentHash(listing) }, price: { amount: '2.5', currency: 'DEM', amountOs: '2500000000' }, rail: 'demos-native:DEM', protocol: {
      jobId: JOB, profile: 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1', sellerAgent: w.publicEndpoint, sellerTransport: declaration ?? transport.declaration, wireProfile: w.binding.profile
    }
  };
  const config = { sellerTransport: transport, sellerEndpoint: () => w.publicEndpoint };
  let journalReads = 0;
  if (paid) {
    const { createDevnetSettlementTransport, DEVNET_SETTLEMENT_POLICY } = await import('../../src/wallet/devnet-native-transport.mjs');
    const { createDevnetNativeCommitmentCapability, DEVNET_NATIVE_COMMITMENT_MARKER } = await import('../../src/devnet-demo/commitment-consumer.mjs');
    const { NATIVE_AGREEMENT_PAYMENT } = await import('../../src/dacs/native-agreement-payment-consumer.mjs');
    const { createNativePaymentEvidenceConsumer, NATIVE_PAYMENT_EVIDENCE } = await import('../../src/dacs/native-payment-evidence-consumer.mjs');
    const journal = {
      get: async () => null, put: async () => {
        throw Error('unexpected wallet write');
      }, entries: async () => {
        journalReads++;
        return [];
      }, withWalletLock: (_key, work) => work()
    };
    const sourceCapability = createDevnetSettlementTransport({
      settlementPublication: { policy: DEVNET_SETTLEMENT_POLICY, artifactKind: 'SettlementEvidence', phase: 'pay-dem', railId: 'demos-native:DEM', phaseIndex: 2, authority: 'TEST-wire' },
      expected: {
        network: 'testnet', chainIdentity: w.binding.profile.chainIdentity, pinVersion: w.binding.profile.pinVersion, endpoint: w.local.endpoint, transportAuthority: w.local.transportAuthority
      },
      transportOwner: {
        getContext() {
          throw Error('unexpected wallet context');
        }, acquireConnectionFence() {
          throw Error('unexpected wallet fence');
        }
      }, journal
    });
    const authority = 'TEST-RUN-wire000000';
    config.nativeSellerCommitment = createDevnetNativeCommitmentCapability({
      authority, anchor: {
        authority, readRetained() {
          throw Error('unexpected commitment read');
        }, verifyReceipt() {
          throw Error('unexpected receipt');
        }
      }
    });
    config.walletAgreement = { sourceCapability, rpcUrl: w.local.endpoint, journal, bridgeFor: () => ({}) };
    config.nativeAgreementPayment = sourceCapability;
    config.nativePaymentEvidence = createNativePaymentEvidenceConsumer({ rpcUrl: w.local.endpoint, sourceCapability });
    Object.assign(terms.protocol, {
      sellerAgreementProjection: 'public-signed-create', nativePayment: NATIVE_AGREEMENT_PAYMENT, nativePaymentEvidence: NATIVE_PAYMENT_EVIDENCE, sellerCommitment: DEVNET_NATIVE_COMMITMENT_MARKER, transportBinding: sourceCapability.transportBinding
    });
  }
  const dir = mkdtempSync(join(tmpdir(), 'wire-purchase-')), path = join(dir, 'state.sqlite');
  let db, ops, service;
  const reopen = () => {
    if (db)
      db.close();
    db = openDatabase(path);
    ops = createOperationStore({ db, handoffSecret: 'TEST-wire-fixture-'.repeat(3), now: () => w.state.time });
    service = createProtocolPurchases({
      db, ops, admission: w.admission, now: () => w.state.time, store: createSqlitePurchaseStore(), coordinates: { unresolvedForSender: () => [] }, buyerAccess: { assertWallet() {
        } }, dacsProtocol: config
    });
  };
  reopen();
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('TEST-buyer', 'TEST', 'TEST-buyer', new Date(T0).toISOString());
  const op = ops.createIdempotent({
    accountId: 'TEST-buyer', kind: 'purchase', idempotencyKey: 'TEST-wire', request: {}, status, terms, termsHash: contentHash(terms), state: { protocol: { stage: 'identity', listing, ...protocolPatch } }, expiresAt: new Date(T0 + 3600000).toISOString()
  }).operation;
  return {
    get service() {
      return service;
    }, get ops() {
      return ops;
    }, get db() {
      return db;
    }, op, get: () => ops.get(op.accountId, op.id), reopen, policies: () => policies, transport, journalReads: () => journalReads
  };
}
