// The buyer's side of one purchase for the continuation suites: a signer that counts its signatures, endpoint proofs at either readiness, capabilities,
// and both signing entry points (signWireRequest, signWireEnvelope).
import { sha256Hex } from "../../src/canonical/index.js";
import * as wire from "../../src/wire/index.js";
import { received, validReceipt } from "./commitmentFixture.js";
import { readFixtureListingEligibility } from "./listingEligibilityFixture.js";
import { ENDPOINT, JOB, LISTING, LOCAL, NOW, P, PIN, world } from "./reservationFixture.js";

export const BODY = "{}";
export const PROOF_LIFETIME_MS = 60_000;

/** The buyer's side of one purchase: a signer that counts its signatures, proofs at either readiness, and both signing entry points. */
export async function buyerSide(options: { readAuthority?: wire.Tp1AuthorityReader; readListing?: wire.ListingEligibilityReader } = {}) {
  const x = await world({ readAuthority: options.readAuthority });
  const signatures = { count: 0 };
  const signer = { claim: x.buyer.claim, sign: (bytes: Uint8Array) => { signatures.count++; return x.buyer.sign(bytes); } };
  const evidence = { commitment: received(x.commitment), agreement: received(x.agreement), signedListing: received(LISTING) };
  const documentAt = (ready: boolean, issuedAt = NOW) => wire.signDiscoveryDocument({ format: "dacs-seller-discovery/v1", profile: x.binding.profile, seller: x.seller.claim,
    publicEndpoint: ENDPOINT, transport: ["dacs-seller-http/v1"], listings: [PIN], capabilities: wire.TP1_CAPABILITIES, ready, issuedAt, expiresAt: issuedAt + PROOF_LIFETIME_MS }, x.seller, x.binding, LOCAL);
  /** verifyEndpointProof over `document`, with `extra` (a request and its evidence) added to the buyer's own options. */
  const verify = (document: Uint8Array, extra: Record<string, unknown> = {}) => wire.verifyEndpointProof(document, { ...x.context, now: NOW,
    listing: { seller: x.seller.claim, publicEndpoint: ENDPOINT, listingPin: PIN }, readListingEligibility: options.readListing ?? readFixtureListingEligibility,
    readCommitmentReceipt: validReceipt, ...extra } as never);
  const proofAt = async (ready: boolean) => verify(await documentAt(ready));
  const scopeFor = (path: string, overrides: Record<string, unknown> = {}) => ({ seller: x.seller.claim, publicEndpoint: ENDPOINT, listingPin: PIN, buyer: x.buyer.claim,
    jobId: JOB, path, bodyHash: sha256Hex(BODY), kind: "retry", ...overrides });
  const mint = (path: string, overrides: Record<string, unknown> = {}) => wire.retainedPurchaseContinuation(x.binding, scopeFor(path, overrides) as never);
  const withEvidence = (path: string) => path === P.state ? {} : evidence;
  const signRequest = (path: string, proof: wire.EndpointProof, extra: Record<string, unknown> = {}, nonce = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYX") => wire.signWireRequest({ ...x.context, signer, endpointProof: proof,
    publicEndpoint: ENDPOINT, path, jobId: JOB, text: BODY, seller: x.seller.claim, now: NOW, nonce, job: { listingPin: PIN, agreementHash: x.agreementHash, profile: x.binding.profile },
    ...withEvidence(path), ...extra } as never);
  const signEnvelope = (path: string, proof: wire.EndpointProof, extra: Record<string, unknown> = {}) => wire.signWireEnvelope(x.request(path), { ...x.context, signer, endpointProof: proof,
    publicEndpoint: ENDPOINT, now: NOW, ...withEvidence(path), ...extra } as never);
  return { x, signatures, documentAt, verify, proofAt, mint, scopeFor, signRequest, signEnvelope, evidence, withEvidence };
}
export type Buyer = Awaited<ReturnType<typeof buyerSide>>;
export const header = (signed: { header: string } | string) => typeof signed === "string" ? signed : signed.header;
export type Sign = (path: string, proof: wire.EndpointProof, extra?: Record<string, unknown>) => Promise<unknown>;
export const entryPoints = (b: Buyer) => [["signWireRequest", b.signRequest], ["signWireEnvelope", b.signEnvelope]] as const satisfies ReadonlyArray<readonly [string, Sign]>;

