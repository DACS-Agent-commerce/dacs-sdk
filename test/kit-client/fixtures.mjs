// C0 fixtures for the kit-client harness: keys derive from one-byte seeds at test time, so no key literal is committed.
// Wallet, listing and agreement-input builders are the kit's own, reused by import.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARTIFACT_SEPARATORS, canonicalize, compositeVerificationAddress, generateCanonicalJobId, identityBundleHash, sha256Hex, signComponentArtifact, signedBytes } from '@kynesyslabs/dacs';
import { TESTNET_PROFILE_TP1, TP1_APPROVED_IDENTITY_RECORD, TP1_BASE_REVISION, TP1_PROFILE_ID, TP1_PROFILE_REVISION, bindTp1Profile } from '@kynesyslabs/dacs/wire';
import { LOCAL } from '../../packages/dacs-client/test/fixtures/tp1-authority-reader.mjs';
import { testWallet } from '../../packages/dacs-seller/test/helpers/protocol-fixture.mjs';
import { fixtureListing } from '../../packages/dacs-seller/test/fixtures/listings.mjs';
import { agreementInput } from '../../packages/dacs-seller/src/dacs/purchase-protocol.mjs';
import { createSellerTransportServerAuth, createSellerTransportStore, sellerContextScopeHash } from '../../packages/dacs-seller/src/dacs/seller-transport-auth.mjs';
import { createSellerTransportClientAuth } from '../../packages/dacs-client/src/dacs/seller-transport-auth.mjs';

export const T0 = Date.UTC(2026, 9, 27, 12);
export const BUYER = testWallet(0x01);
export const SELLER = testWallet(0x02);
export const SESSION = testWallet(0x03);

const DID_PREFIX = 'did:demos:agent:';
/** The raw public key (hex) a wallet's claim names. */
export const publicKeyHex = (wallet) => wallet.claim.slice(DID_PREFIX.length);
export const JOB = generateCanonicalJobId({ timestamp: T0, entropy: new Uint8Array(10).fill(0x11) });

const PRESENTATION_DOMAIN = 'dacs-bundle-presentation:v1:';
const LISTING_PUBLICATION_AGE_MS = 86_400_000;

/** A per-claim identity bundle for `wallet`, signed by `wallet` over the bundle's own hash (the presentation signature). */
function presentedBundle(wallet, { presentedAt, nonceText }) {
  const unsigned = { bundleVersion: '1', presentedBy: wallet.claim, presentedAt, sessionNonce: sha256Hex(nonceText), claims: [{ ref: wallet.claim }] };
  const signature = wallet.signBytes(signedBytes(PRESENTATION_DOMAIN, identityBundleHash(unsigned))).toString('base64url');
  return { ...unsigned, presentation: { kind: 'per-claim', signatures: [{ ref: wallet.claim, signature }] } };
}

/** K4-B1: the seller identity exactly as the Listing carries it. */
export const listingSellerBundle = () => presentedBundle(SELLER, { presentedAt: T0 - LISTING_PUBLICATION_AGE_MS, nonceText: 'listing-publication' });
/** K4-B2: the seller's fresh presentation on a buyer-issued challenge (today's kit-default form). */
export const freshSellerBundle = () => presentedBundle(SELLER, { presentedAt: T0, nonceText: 'buyer-issued-challenge' });
/** The buyer's presentation bundle for `JOB`. */
export const buyerBundle = () => presentedBundle(BUYER, { presentedAt: T0, nonceText: 'buyer-presentation' });

/** A Listing signed by SELLER whose seller identity is K4-B1. */
export async function k4Listing() {
  const draft = { ...fixtureListing(SELLER, { now: T0 }) };
  delete draft.signature;
  draft.seller.identity = listingSellerBundle();
  return signComponentArtifact(draft, ARTIFACT_SEPARATORS.Listing, { signer: SELLER.claim, algorithm: 'ed25519', sign: SELLER.signBytes });
}

/** A Vet reference to `party`'s composite record at its canonical address, naming `signer`; `contentHash` defaults to a derived value. */
export const vetRef = (party, signer, contentHash = sha256Hex(`vet-record:${party.claim}`)) => ({
  anchor: { kind: 'storage-program', locator: compositeVerificationAddress(JOB, party.claim) },
  contentHash,
  signer: signer.claim,
});

/** The exact SDK Agreement derive input of the seller context; both Vet refs are seller-signed unless `sellerRef` replaces the seller's. */
export function contextInput({ listing, seller = listing.seller.identity, sellerRef = vetRef(SELLER, SELLER) }) {
  const input = agreementInput({ jobId: JOB, listing, buyerBundle: buyerBundle(), generatedAt: T0 });
  return { ...input,
    buyer: { identityBundle: input.buyer.identityBundle, vetRecordRef: vetRef(BUYER, SELLER) },
    seller: { identityBundle: seller, vetRecordRef: sellerRef } };
}

export const sameBytes = (left, right) => canonicalize(left) === canonicalize(right);

export const LISTING_PIN = Object.freeze({ listingId: 'tp1-vector-listing', version: 1, contentHash: sha256Hex('contracts-vector-listing') });
/** K1-S1: the context scope of JOB, and its hash (the retained `agreementHash` of a context request). */
export const contextScope = Object.freeze({
  source: 'dacs-chatgpt-plugin/operator-agreement-context/v1', wallet: BUYER.address, jobId: JOB, buyer: BUYER.claim, buyerBundleHash: sha256Hex('contracts-vector-buyer-bundle'),
  seller: SELLER.claim, listingPin: LISTING_PIN, rail: { railId: 'demos-native:DEM', railVersion: 1 }, payee: SELLER.address,
  price: { amount: '1', currency: 'DEM', amountOs: '1000000000' }, generatedAt: T0,
});
export const contextScopeHash = sellerContextScopeHash(contextScope);

/** K7-BIND-1 on C0's LOCAL, over a test-only authority reader that vouches for every claim it is asked about (the wire's own fixture, in JavaScript). */
export function bindWireProfile() {
  const record = TP1_APPROVED_IDENTITY_RECORD;
  const profile = { id: TP1_PROFILE_ID, revision: TP1_PROFILE_REVISION, base: TP1_BASE_REVISION, chainIdentity: record.chainIdentity, pinVersion: record.pinVersion };
  const readAuthority = (scope) => ({ local: { ...scope.local }, chainIdentity: record.chainIdentity, provenance: 'test-only-independent-authority/v1', sessionId: scope.sessionId,
    participants: scope.participants.map((claim) => ({ claim, profile, modules: TESTNET_PROFILE_TP1.tuple })) });
  return bindTp1Profile({ record, local: { ...LOCAL }, readAuthority });
}

const REQUEST_NONCE = Buffer.alloc(24, 0x6e).toString('base64url');
const STATE_PATH = '/dacs/v1/agreements/state';

/**
 * The client's request signer (BUYER) and the kit's server-side auth (SELLER) over one Listing pin, on the fixed clock T0.
 * The kit's transport store is a real one in a temporary directory, closed when the test ends.
 */
export async function sellerTransportPair(t) {
  const directory = await mkdtemp(join(tmpdir(), 'TEST-kit-client-transport-'));
  const store = createSellerTransportStore({ path: join(directory, 'transport.sqlite'), now: () => T0 });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const serverAuth = createSellerTransportServerAuth({ sellerSigner: { claim: SELLER.claim, sign: SELLER.signBytes }, listingPin: LISTING_PIN, store, now: () => T0 });
  const clientAuth = createSellerTransportClientAuth({ buyerSigner: { claim: BUYER.claim, sign: BUYER.signBytes }, seller: SELLER.claim,
    resolveJob: () => ({ listingPin: LISTING_PIN, agreementHash: sha256Hex('kit-client-agreement') }), now: () => T0, nonce: () => REQUEST_NONCE });
  /** A signed state request from the client's real signer: its payload and header. */
  const stateRequest = () => {
    const body = { transportIdentity: { jobId: JOB } };
    return clientAuth.request(STATE_PATH, body, JSON.stringify(body));
  };
  return { serverAuth, clientAuth, stateRequest };
}
