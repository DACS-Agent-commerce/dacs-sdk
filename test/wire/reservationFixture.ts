// A seller's view of one purchase for the request-journal tests: signed requests (direct and delegated), what the host retained, and the
// commitment evidence payment and delivery routes need. Shared by the journal, deferred-reservation and retained-stage suites.
import { randomBytes, sign } from "node:crypto";
import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import * as wire from "../../src/wire/index.js";
import { fixtureBinder } from "./authorityFixture.js";
import { ed25519KeyPair, received, signedAgreement, tp1Listing, validReceipt, wireCommitment } from "./commitmentFixture.js";

export const NOW = Date.UTC(2026, 9, 18);
export const JOB = "01K7FZ8Q9W3V5T2R1N0M8K6J4H";
export const LOCAL = { endpoint: "https://rpc.journal.invalid/", transportAuthority: "test", connectionId: "1" };
export const P = wire.DACS_SELLER_HTTP_PATHS;
/** The endpoint the seller's Listing names. */
export const ENDPOINT = "https://seller.agreement.invalid";
/** The routes whose first request starts or commits a purchase: they carry `retained.allocated`. */
export const STAGE_ROUTES: readonly string[] = [P.proposals, P.commitments, P.commitmentSignature];
// The seller's key is fixed, so its signed Listing, and the pin every request names, is a constant.
const SELLER_SEED = 52;
export function party(seed?: number) {
  const { privateKey, publicKey } = ed25519KeyPair(seed);
  const key = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  return { claim: `did:demos:agent:${key}`, key, sign: (bytes: Uint8Array) => sign(null, Buffer.from(bytes), privateKey) };
}
export const { listing: LISTING, pin: PIN } = tp1Listing({ seller: party(SELLER_SEED), listingId: "report", publicEndpoint: ENDPOINT });
export const header = (value: unknown) => Buffer.from(canonicalize(value)).toString("base64url");
/** A fresh request nonce: the reservation key is shared across routes, so each request needs its own. */
export const nonce = () => randomBytes(24).toString("base64url");
const bindTp1Fixture = fixtureBinder(wire);

/** `readAuthority` replaces the fixture's authority reader, for tests that withdraw authority. */
export async function world(options: { readAuthority?: wire.Tp1AuthorityReader } = {}) {
  const buyer = party(), seller = party(SELLER_SEED), session = party();
  const binding = (await bindTp1Fixture({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local: LOCAL, ...(options.readAuthority === undefined ? {} : { readAuthority: options.readAuthority }) }));
  const context = { binding, local: LOCAL, purchaseProfile: binding.profile };
  const { agreement, agreementHash } = signedAgreement({ buyer, seller, jobId: JOB, listingPin: PIN });
  const request = (path: string, nonce = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYX", body = "{}"): wire.WireRequestPayload => ({
    version: "1", kind: "request", method: "POST", path, jobId: JOB, buyer: buyer.claim, seller: seller.claim, bodyHash: sha256Hex(body),
    listingPin: PIN, agreementHash, nonce, expiresAt: NOW + 30_000, profile: binding.profile,
  });
  const signed = (payload: unknown, signer: ReturnType<typeof party>, domain: string) => ({ payload, signature: signer.sign(Buffer.from(domain + canonicalize(payload))).toString("base64url") });
  /** The buyer-signed (undelegated) request header. */
  const direct = (payload: wire.WireRequestPayload) => header(signed(payload, buyer, wire.DACS_SELLER_HTTP_DOMAINS.request));
  const delegated = async (payload: wire.WireRequestPayload) => {
    const delegation = signed({ version: "1", kind: "seller-session-delegation", buyer: buyer.claim, seller: seller.claim,
      sessionPublicKey: session.key, listingPin: PIN, jobId: JOB, notBefore: NOW - 1000, expiresAt: NOW + 60_000,
      profile: binding.profile }, buyer, wire.DACS_SELLER_HTTP_DOMAINS.delegation);
    return (await wire.openWireEnvelope(header({ ...signed(payload, session, wire.DACS_SELLER_HTTP_DOMAINS.request), delegation }), "request", { ...context, requireDelegation: true }));
  };
  /** The buyer-signed request, opened. */
  const open = async (path: string, body = "{}", n = nonce()) => wire.openWireEnvelope(direct(request(path, n, body)), "request", context);
  const artifact = { jobId: JOB, listingRef: PIN, parties: [{ role: "buyer", primaryClaim: buyer.claim }, { role: "seller", primaryClaim: seller.claim }], terms: { deadline: NOW + 60_000 } };
  /** What the seller host retained for the job: its own record, not read from the request. */
  const retained = { jobId: JOB, agreementHash, buyer: buyer.claim, seller: seller.claim };
  /** The retained record a route takes: the three starting routes also carry the host's `allocated`. */
  const retainedFor = (path: string, allocated = false) => STAGE_ROUTES.includes(path) ? { ...retained, allocated } : retained;
  /** The job's finalized commitment and its signed Agreement, which the seller read itself: payment and delivery routes need them. */
  const commitment = wireCommitment({ seller, buyer: buyer.claim, jobId: JOB, agreementHash, listingPin: PIN, committedAt: NOW - 5000 });
  // The seller is ready, so a route that starts a purchase reaches its reservation.
  const check = (path: string) => ({ ...context, seller: seller.claim, listingPin: PIN, method: "POST", path, rawBody: Buffer.from("{}"), now: NOW, retained: retainedFor(path), ready: true,
    commitment: received(commitment), agreement: received(agreement), readCommitmentReceipt: validReceipt, signedListing: received(LISTING) });
  return { buyer, seller, binding, context, agreement, agreementHash, request, direct, open, delegated, artifact, retained, retainedFor, commitment, check };
}
export type World = Awaited<ReturnType<typeof world>>;
