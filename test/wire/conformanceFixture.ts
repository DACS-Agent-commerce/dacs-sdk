// Independent signatures and a reflecting, test-only authenticated authority.
import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import * as wire from "../../src/wire/index.js";
import { fixtureBinder } from "./authorityFixture.js";
import { seededParty } from "./commitmentFixture.js";
import { readFixtureListingEligibility } from "./listingEligibilityFixture.js";
export const NOW = Date.UTC(2026, 9, 18);
export const JOB = "01K7FZ8Q9W3V5T2R1N0M8K6J4H";
export async function wireWorld() {
  const buyer = seededParty(61), seller = seededParty(62), session = seededParty(63);
  const local = { endpoint: "https://rpc.sweep.invalid/", transportAuthority: "test", connectionId: "1" };
  let participantReads = 0, revoke = false;
  let authorityError: Error | undefined;
  const profile = { id: wire.TP1_PROFILE_ID, revision: wire.TP1_PROFILE_REVISION, base: wire.TP1_BASE_REVISION,
    chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity, pinVersion: wire.TP1_APPROVED_IDENTITY_RECORD.pinVersion };
  const readAuthority: wire.Tp1AuthorityReader = (scope) => {
    if (scope.participants.length) participantReads++;
    if (authorityError && scope.sessionId === JOB) throw authorityError;
    return { local: { ...scope.local }, chainIdentity: profile.chainIdentity, provenance: "independent-sweep-fixture/v1",
      sessionId: scope.sessionId, participants: scope.participants.map((claim) => ({ claim,
        profile: revoke && scope.sessionId === "dacs-seller-discovery/v1" ? { ...profile, revision: "revoked" } : profile,
        modules: wire.TESTNET_PROFILE_TP1.tuple })) };
  };
  const binding = await fixtureBinder(wire)({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local, readAuthority });
  const pin = { listingId: "sweep", version: 1, contentHash: "c".repeat(64) };
  const request: wire.WireRequestPayload = { version: "1", kind: "request", method: "POST", path: wire.DACS_SELLER_HTTP_PATHS.commitments,
    bodyHash: sha256Hex("{}"), jobId: JOB, buyer: buyer.claim, seller: seller.claim, listingPin: pin,
    agreementHash: "a".repeat(64), nonce: Buffer.alloc(16).toString("base64url"), expiresAt: NOW + 30_000, profile: binding.profile };
  const delegation: wire.SellerSessionDelegationPayload = { version: "1", kind: "seller-session-delegation", buyer: buyer.claim,
    seller: seller.claim, sessionPublicKey: session.raw, listingPin: pin, jobId: JOB, notBefore: NOW - 1000, expiresAt: NOW + 60_000, profile: binding.profile };
  const publicEndpoint = "https://seller.sweep.invalid";
  const discovery: wire.DiscoveryPayload = { format: "dacs-seller-discovery/v1", profile: binding.profile, seller: seller.claim,
    publicEndpoint, transport: ["dacs-seller-http/v1"], listings: [pin], capabilities: wire.TP1_CAPABILITIES, ready: true, issuedAt: NOW, expiresAt: NOW + 120_000 };
  const signed = (payload: unknown, who = buyer, domain: string = wire.DACS_SELLER_HTTP_DOMAINS.request) => ({ payload,
    signature: Buffer.from(who.signBytes(Buffer.from(domain + canonicalize(payload)))).toString("base64url") });
  const document = (payload: unknown = discovery) => Buffer.from(canonicalize(signed(payload, seller, wire.DACS_SELLER_HTTP_DOMAINS.discovery)));
  const options = { binding, local, now: NOW, listing: { seller: seller.claim, publicEndpoint, listingPin: pin }, readListingEligibility: readFixtureListingEligibility };
  const proof = await wire.verifyEndpointProof(document(), options);
  const context = { binding, local, purchaseProfile: binding.profile };
  const delegationScope = { binding, local, seller: seller.claim, listingPin: pin, jobId: JOB, time: NOW };
  const input = { signer: buyer, binding, local, now: NOW, endpointProof: proof, publicEndpoint, path: request.path,
    jobId: JOB, text: "{}", seller: seller.claim, job: { listingPin: pin, agreementHash: request.agreementHash, profile: binding.profile } };
  return { buyer, seller, session, binding, local, pin, request, delegation, discovery, signed, document, options, proof, context, delegationScope, input,
    failAuthority: (error: Error) => { authorityError = error; }, reads: () => participantReads, revoke: () => { revoke = true; } };
}
export const encodeHeader = (value: unknown) => Buffer.from(canonicalize(value)).toString("base64url");
export function alias(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  return value.slice(0, -1) + alphabet[alphabet.indexOf(value.at(-1)!) + 1];
}
