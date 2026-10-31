import * as fixtureWire from "../../src/wire/index.js";
import { fixtureBinder } from "./authorityFixture.js";
import { journalFixture } from "./requestJournalFixture.js";
import { agreementFixture, retainedFixture } from "./agreementFixture.js";
import { acceptedPurchase, commitPurchase, ed25519KeyPair, received, seededParty, signedAgreement, tp1Listing, validReceipt, wireCommitment, type AcceptedPurchase } from "./commitmentFixture.js";

/** A commitment or Agreement in `extra`, as the bytes it is received as (CF-5). */
const asReceived = (extra: object): object => ({ ...extra, ..."commitment" in extra ? { commitment: received(extra.commitment) } : {}, ..."agreement" in extra ? { agreement: received(extra.agreement) } : {} });
import { readFixtureListingEligibility } from "./listingEligibilityFixture.js";
import { createHash, createPublicKey, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical/index.js";
import * as w from "../../src/wire/index.js";
import { isListingPin } from "../../src/wire/validate.js";
import { isContinuingRoute } from "../../src/wire/discovery.js";

const bindTp1Fixture = fixtureBinder(fixtureWire);
const { testJournal, testJournals } = journalFixture(fixtureWire);

const NOW = Date.UTC(2026, 9, 18);
const JOB = "01K7FZ8Q9W3V5T2R1N0M8K6J4H";
// The seller's key is fixed, so its signed Listing, and the pin every request names, is a constant.
const SELLER_SEED = 56;
const ENDPOINT = "https://seller.admission.invalid";
const { listing: LISTING, pin: PIN } = tp1Listing({ seller: party(SELLER_SEED), listingId: "report", publicEndpoint: ENDPOINT });
const LOCAL = { endpoint: "https://rpc.admission.invalid/", transportAuthority: "test", connectionId: "1" };
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
function party(seed?: number) {
  const { publicKey, privateKey } = ed25519KeyPair(seed);
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  return { raw, claim: `did:demos:agent:${raw}`, calls: 0, sign(bytes: Uint8Array) { this.calls++; return sign(null, Buffer.from(bytes), privateKey); } };
}
/** Fresh parties and an Agreement they signed for the literal pin, or the parties, pin and Agreement of a purchase both parties signed. */
async function world(purchase?: AcceptedPurchase) {
  const buyer = purchase?.buyer ?? party(), seller = purchase?.seller ?? party(SELLER_SEED), session = party();
  const pin = purchase?.pin ?? PIN, listing = purchase?.listing ?? LISTING;
  const signedHere = purchase ? undefined : signedAgreement({ buyer, seller, jobId: JOB, listingPin: PIN, listing: { listing, pin } });
  // Signing that Agreement is no wire signature: the tests count those.
  buyer.calls = 0; seller.calls = 0;
  const agreement = purchase?.agreement ?? signedHere!.agreement;
  const binding = (await bindTp1Fixture({ record: w.TP1_APPROVED_IDENTITY_RECORD, local: LOCAL }));
  const request: w.WireRequestPayload = {
    version: "1", kind: "request", method: "POST", path: "/dacs/v1/commitments", bodyHash: sha("{}"), jobId: JOB,
    buyer: buyer.claim, seller: seller.claim, listingPin: pin, agreementHash: purchase?.agreementHash ?? signedHere!.agreementHash, nonce: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYX", expiresAt: NOW + 30_000, profile: binding.profile,
  };
  const delegation: w.SellerSessionDelegationPayload = {
    version: "1", kind: "seller-session-delegation", buyer: buyer.claim, seller: seller.claim, sessionPublicKey: session.raw,
    listingPin: pin, jobId: JOB, notBefore: NOW - 1000, expiresAt: NOW + 60_000, profile: binding.profile,
  };
  const discovery: w.DiscoveryPayload = {
    format: "dacs-seller-discovery/v1", profile: binding.profile, seller: seller.claim, publicEndpoint: ENDPOINT,
    transport: ["dacs-seller-http/v1"], listings: [pin], capabilities: w.TP1_CAPABILITIES, ready: true, issuedAt: NOW, expiresAt: NOW + 60_000,
  };
  const context = { binding, local: LOCAL, purchaseProfile: binding.profile };
  const input = { signer: buyer, binding, local: LOCAL, seller: seller.claim, jobId: JOB, path: request.path, text: "{}", job: { listingPin: pin, agreementHash: request.agreementHash, profile: binding.profile }, now: NOW, publicEndpoint: ENDPOINT };
  const delegationScope = { binding, local: LOCAL, seller: seller.claim, listingPin: pin, jobId: JOB, time: NOW };
  return { buyer, seller, session, binding, pin, listing, agreement, request, delegation, discovery, context, delegationScope, input };
}
// Independent wire encoders intentionally do not call the SDK's shape/signing helpers.
function signed<T>(payload: T, domain: string, signer: w.WireSigner) {
  const signature = Buffer.from(signer.sign(Buffer.from(domain + canonicalize(payload))) as Uint8Array).toString("base64url");
  return { payload, signature };
}
const header = (v: unknown) => Buffer.from(canonicalize(v)).toString("base64url");
/** The same base64url signature with its first byte's low bit flipped. */
const flip = (value: string) => { const bytes = Buffer.from(value, "base64url"); bytes[0]! ^= 1; return bytes.toString("base64url"); };
const missing = Symbol("missing");
const invalidIds: Array<[string, unknown]> = [
  ["missing", missing], ["null", null], ["number", 42], ["object", {}], ["empty", ""], ["garbage", "garbage"],
  ["lowercase", JOB.toLowerCase()], ...["I", "L", "O", "U"].map((c): [string, string] => [`excluded-${c}`, JOB.slice(0, -1) + c]),
  ["overflow", "8" + JOB.slice(1)], ["short", JOB.slice(1)], ["long", JOB + "0"],
  ["space", " " + JOB], ["trailing-space", JOB + " "], ["newline", JOB + "\n"], ["unicode-space", JOB + "\u2028"],
];
function replaceId<T extends { jobId: string }>(p: T, value: unknown): T {
  const copy = { ...p, jobId: value } as T;
  if (value === missing) delete (copy as Partial<T>).jobId;
  return copy;
}
const refuses = async (fn: () => unknown, code: string, status?: number) => {
  await expect(Promise.resolve().then(fn)).rejects.toMatchObject({ code, ...(status === undefined ? {} : { status }) });
};
/** A binding whose trusted reader records every authority scope. */
async function countingBinding() {
  const record = w.TP1_APPROVED_IDENTITY_RECORD;
  const profile = { id: w.TP1_PROFILE_ID, revision: w.TP1_PROFILE_REVISION, base: w.TP1_BASE_REVISION, chainIdentity: record.chainIdentity, pinVersion: record.pinVersion };
  const scopes: w.Tp1AuthorityScope[] = [];
  const readAuthority: w.Tp1AuthorityReader = (scope) => {
    scopes.push(scope);
    return { local: { ...scope.local }, chainIdentity: profile.chainIdentity, provenance: "test-only-independent-authority/v1",
      sessionId: scope.sessionId, participants: scope.participants.map((claim) => ({ claim, profile, modules: w.TESTNET_PROFILE_TP1.tuple })) };
  };
  return { binding: (await w.bindTp1Profile({ record, local: LOCAL, readAuthority })), scopes, readAuthority };
}

describe("wire canonical job-ID admission", () => {
  it("observes participant reads even without a session", async () => {
    const counted = (await countingBinding());
    counted.scopes.length = 0;
    await counted.readAuthority({ local: LOCAL, sessionId: null, participants: [party().claim] });
    expect(counted.scopes).toHaveLength(1);
  });
  it.each(invalidIds)("rejects %s before signing, hashing or seller effects", async (_name, id) => {
    const x = (await world());
    const responseHeader = await w.signWireResponse(x.request, 200, "{}", { ...x.context, signer: x.seller, now: NOW });
    const request = replaceId(x.request, id), delegation = replaceId(x.delegation, id);
    const requestHeader = header(signed(request, w.DACS_SELLER_HTTP_DOMAINS.request, x.buyer));
    const delegated = signed(delegation, w.DACS_SELLER_HTTP_DOMAINS.delegation, x.buyer);
    x.buyer.calls = x.seller.calls = 0;
    let effects = 0;
    await refuses(async () => { (await w.openWireEnvelope(requestHeader, "request", x.context)); effects++; }, "peer_envelope_invalid");
    await refuses(async () => (await w.verifySellerSessionDelegation(Buffer.from(JSON.stringify(delegated)), x.delegationScope)), "peer_delegation_invalid");
    await refuses(() => w.signSellerSessionDelegation(delegation, x.buyer, x.binding, LOCAL), "peer_delegation_invalid");
    await refuses(async () => (await w.sellerSessionDelegationSigningBytes(delegation, x.binding, LOCAL)), "peer_delegation_invalid");
    await refuses(() => w.wireRequestHash(request), "peer_envelope_invalid");
    await refuses(() => w.wireEnvelopeSigningBytes(request), "peer_envelope_invalid");
    await refuses(() => w.signWireEnvelope(request, { ...x.context, signer: x.buyer }), "peer_envelope_invalid");
    await refuses(() => w.signWireRequest({ ...x.input, jobId: id } as unknown as w.WireRequestInput), "peer_envelope_invalid");
    await refuses(() => w.signWireResponse(request, 200, "{}", { ...x.context, signer: x.seller, now: NOW }), "peer_envelope_invalid", 500);
    await refuses(async () => (await w.verifyWireResponse(request, { ...x.context, header: responseHeader, status: 200, body: Buffer.from("{}"), now: NOW })), "peer_envelope_invalid", 500);
    expect(effects + x.buyer.calls + x.seller.calls).toBe(0);
  });
  it.each(invalidIds)("refuses %s before any participant or session read, direct or delegated", async (_name, id) => {
    const x = (await world()), counted = (await countingBinding());
    const context = { binding: counted.binding, local: LOCAL, purchaseProfile: counted.binding.profile };
    const request = replaceId(x.request, id), delegation = replaceId(x.delegation, id);
    const requestHeader = header(signed(request, w.DACS_SELLER_HTTP_DOMAINS.request, x.buyer));
    const delegated = signed(delegation, w.DACS_SELLER_HTTP_DOMAINS.delegation, x.buyer);
    // A canonical delegation for the canonical job: without signWireRequest's own job-ID check, its scope check would read the session and refuse as a mismatch.
    const canonicalDelegation = signed(x.delegation, w.DACS_SELLER_HTTP_DOMAINS.delegation, x.buyer);
    const input = { ...x.input, binding: counted.binding, job: { ...x.input.job, profile: counted.binding.profile }, jobId: id } as unknown as w.WireRequestInput;
    counted.scopes.length = 0;
    x.buyer.calls = x.session.calls = 0;
    await refuses(async () => (await w.openWireEnvelope(requestHeader, "request", context)), "peer_envelope_invalid", 401);
    await refuses(async () => (await w.verifySellerSessionDelegation(Buffer.from(JSON.stringify(delegated)), { ...x.delegationScope, binding: counted.binding })), "peer_delegation_invalid", 401);
    await refuses(() => w.signSellerSessionDelegation(delegation, x.buyer, counted.binding, LOCAL), "peer_delegation_invalid", 500);
    await refuses(() => w.signWireRequest(input), "peer_envelope_invalid", 500);
    await refuses(() => w.signWireRequest({ ...input, signer: x.session, delegation: canonicalDelegation }), "peer_envelope_invalid", 500);
    expect(counted.scopes.filter(scope => scope.sessionId !== null || scope.participants.length > 0)).toEqual([]);
    expect(x.buyer.calls + x.session.calls).toBe(0);
  });
  it.each(["kind", "version", "bodyHash", "seller", "nonce", "listingPin"])("response boundaries refuse malformed retained %s before signing or reading the answer", async (field) => {
    const x = (await world());
    const responseHeader = await w.signWireResponse(x.request, 200, "{}", { ...x.context, signer: x.seller, now: NOW });
    expect((await w.verifyWireResponse(x.request, { ...x.context, header: responseHeader, status: 200, body: Buffer.from("{}"), now: NOW })).principal).toBe(x.seller.claim);
    x.seller.calls = 0;
    const absent = { ...x.request }; delete (absent as any)[field];
    for (const request of [{ ...x.request, [field]: field === "kind" ? "response" : "wrong" }, absent]) {
      await refuses(() => w.signWireResponse(request as w.WireRequestPayload, 200, "{}", { ...x.context, signer: x.seller, now: NOW }), "peer_envelope_invalid", 500);
      await refuses(async () => (await w.verifyWireResponse(request as w.WireRequestPayload, { ...x.context, header: responseHeader, status: 200, body: Buffer.from("{}"), now: NOW })), "peer_envelope_invalid", 500);
    }
    expect(x.seller.calls).toBe(0);
  });
  it.each(["kind", "version", "bodyHash", "seller", "nonce", "listingPin"])("request hash rejects invalid %s", async (field) => {
    const x = (await world());
    await refuses(() => w.wireRequestHash({ ...x.request, [field]: "wrong" } as never), "peer_envelope_invalid");
    const copy = { ...x.request }; delete (copy as any)[field];
    await refuses(() => w.wireRequestHash(copy), "peer_envelope_invalid");
  });
});

describe("wire Listing pins and producer bounds", () => {
  it.each(["x".repeat(129), "漢", "with space", "slash/id", "query?id", "frag#id", "percent%20", "line\n", ""])("refuses non-Standard Listing ID %j", async (listingId) => {
    const x = (await world()), pin = { ...PIN, listingId };
    expect(isListingPin(pin)).toBe(false);
    const requestHeader = header(signed({ ...x.request, listingPin: pin }, w.DACS_SELLER_HTTP_DOMAINS.request, x.buyer));
    const delegated = signed({ ...x.delegation, listingPin: pin }, w.DACS_SELLER_HTTP_DOMAINS.delegation, x.buyer);
    const discoveryBytes = Buffer.from(canonicalize(signed({ ...x.discovery, listings: [pin] }, w.DACS_SELLER_HTTP_DOMAINS.discovery, x.seller)));
    x.buyer.calls = 0; x.seller.calls = 0;
    await refuses(async () => (await w.openWireEnvelope(requestHeader, "request", x.context)), "peer_envelope_invalid");
    await refuses(async () => (await w.verifySellerSessionDelegation(Buffer.from(JSON.stringify(delegated)), x.delegationScope)), "peer_delegation_invalid");
    await refuses(async () => (await w.verifyEndpointProof(discoveryBytes, { readListingEligibility: readFixtureListingEligibility, listing: { seller: x.seller.claim, publicEndpoint: ENDPOINT, listingPin: PIN }, binding: x.binding, local: LOCAL, now: NOW })), "discovery_invalid");
    await refuses(() => w.signWireEnvelope({ ...x.request, listingPin: pin }, { ...x.context, signer: x.buyer }), "peer_envelope_invalid");
    await refuses(() => w.signSellerSessionDelegation({ ...x.delegation, listingPin: pin }, x.buyer, x.binding, LOCAL), "peer_delegation_invalid");
    await refuses(() => w.signDiscoveryDocument({ ...x.discovery, listings: [pin] }, x.seller, x.binding, LOCAL), "discovery_invalid");
    expect(x.buyer.calls + x.seller.calls).toBe(0);
  });
  it("accepts 128 URL-safe ASCII characters at producer and receiver boundaries", async () => {
    const x = (await world()), pin = { ...PIN, listingId: "A._~-0123".repeat(16).slice(0, 128) };
    expect(isListingPin(pin)).toBe(true);
    const request = { ...x.request, listingPin: pin };
    const bytes = await w.signDiscoveryDocument({ ...x.discovery, listings: [pin] }, x.seller, x.binding, LOCAL);
    const endpointProof = (await w.verifyEndpointProof(bytes, { readListingEligibility: readFixtureListingEligibility, listing: { seller: x.seller.claim, publicEndpoint: ENDPOINT, listingPin: pin }, binding: x.binding, local: LOCAL, now: NOW }));
    const h = await w.signWireEnvelope(request, { ...x.context, signer: x.buyer, endpointProof, publicEndpoint: ENDPOINT, now: NOW });
    expect((await w.openWireEnvelope(h, "request", x.context)).payload.listingPin).toEqual(pin);
    expect(endpointProof.ready).toBe(true);
  });
  it("bounds the entire encoded header and discovery document before calling signers", async () => {
    const x = (await world());
    const oversized = { payload: x.delegation, signature: "A".repeat(4000) };
    await refuses(() => w.signWireEnvelope(x.request, { ...x.context, signer: x.buyer }, oversized), "peer_envelope_too_large");
    expect(x.buyer.calls + x.seller.calls).toBe(0);
    // A publicEndpoint is an origin, so the largest document a seller can sign (32 maximal pins and a 2,048-character
    // origin of 3-byte characters) still fits the buyer's 16 KiB bound: the buyer admits every document a seller signs.
    const host = Array.from({ length: 40 }, () => "中".repeat(60)).join(".").slice(0, 2048 - 16);
    const discovery = { ...x.discovery, publicEndpoint: `https://${host}.invalid`, listings: Array.from({ length: 32 }, (_, i) => ({ ...PIN, listingId: "x".repeat(126) + String(i).padStart(2, "0") })) };
    expect(discovery.publicEndpoint).toHaveLength(2048);
    const bytes = await w.signDiscoveryDocument(discovery, x.seller, x.binding, LOCAL);
    expect(bytes.length).toBeGreaterThan(14_000);
    expect(bytes.length).toBeLessThanOrEqual(w.DACS_SELLER_HTTP_LIMITS.maxDiscoveryBytes);
  });
});

describe("endpoint proof purchase gate", () => {
  async function proof(x: Awaited<ReturnType<typeof world>>, patch: Partial<w.DiscoveryPayload> = {}) {
    const payload = { ...x.discovery, ...patch };
    const bytes = await w.signDiscoveryDocument(payload, x.seller, x.binding, LOCAL);
    return { bytes, proof: (await w.verifyEndpointProof(bytes, { readListingEligibility: readFixtureListingEligibility, listing: { seller: x.seller.claim, publicEndpoint: payload.publicEndpoint, listingPin: PIN }, binding: x.binding, local: LOCAL, now: NOW })) };
  }
  it("requires a verified proof, bound to seller, pin, exact endpoint, profile and validity", async () => {
    const x = (await world()), { proof: p } = await proof(x);
    for (const endpointProof of [undefined, null, {}, { ...p }, structuredClone(p)]) {
      await refuses(() => w.signWireRequest({ ...x.input, endpointProof } as w.WireRequestInput), "endpoint_proof_required");
      await refuses(() => w.signWireEnvelope(x.request, { ...x.context, signer: x.buyer, endpointProof: endpointProof as w.EndpointProof, publicEndpoint: ENDPOINT, now: NOW }), "endpoint_proof_required");
    }
    for (const patch of [{ seller: party().claim }, { publicEndpoint: ENDPOINT + "/" }, { job: { ...x.input.job, listingPin: { ...PIN, version: 2 } } }]) {
      await refuses(() => w.signWireRequest({ ...x.input, endpointProof: p, ...patch }), "endpoint_proof_mismatch");
    }
    const otherBinding = (await bindTp1Fixture({ record: w.TP1_APPROVED_IDENTITY_RECORD, local: LOCAL }));
    await refuses(() => w.signWireRequest({ ...x.input, endpointProof: p, binding: otherBinding }), "endpoint_proof_required");
    await refuses(() => w.signWireRequest({ ...x.input, endpointProof: p, now: NOW + 60_000 }), "discovery_expired");
    // The buyer's own kept proof lapsed: fetching discovery again clears it, so it is transient, not the seller's fault.
    await expect(w.signWireRequest({ ...x.input, endpointProof: p, now: NOW + 60_000 })).rejects.toMatchObject({ code: "discovery_expired", status: 503, category: "transient" });
    const notReady = await proof(x, { ready: false });
    await refuses(() => w.signWireRequest({ ...x.input, endpointProof: notReady.proof }), "seller_not_ready");
    expect(x.buyer.calls).toBe(0);
    expect(Object.isFrozen(p) && Object.isFrozen(p.payload)).toBe(true);
    expect((await w.signWireRequest({ ...x.input, endpointProof: p })).payload.seller).toBe(x.seller.claim);
    expect(x.buyer.calls).toBe(1);
    await w.signWireEnvelope(x.request, { ...x.context, signer: x.buyer, endpointProof: p, publicEndpoint: ENDPOINT, now: NOW });
    expect(x.buyer.calls).toBe(2);
  });
  it("binds an endpoint the URL parser would normalize by its exact bytes, never by its parsed form", async () => {
    const x = (await world()), written = "https://SELLER.admission.invalid:443", parsed = new URL(written).href;
    expect(parsed).toBe("https://seller.admission.invalid/");
    const { bytes, proof: p } = await proof(x, { publicEndpoint: written });
    expect(p.payload.publicEndpoint).toBe(written);
    await refuses(async () => (await w.verifyEndpointProof(bytes, { readListingEligibility: readFixtureListingEligibility, listing: { seller: x.seller.claim, publicEndpoint: parsed, listingPin: PIN }, binding: x.binding, local: LOCAL, now: NOW })), "discovery_endpoint_mismatch");
  });
  it("preserves the verified Listing endpoint bytes: NFC never matches NFD", async () => {
    const x = (await world()), nfc = "https://caf\u00e9.admission.invalid", nfd = "https://cafe\u0301.admission.invalid";
    const { bytes } = await proof(x, { publicEndpoint: nfc });
    await refuses(async () => (await w.verifyEndpointProof(bytes, { readListingEligibility: readFixtureListingEligibility, listing: { seller: x.seller.claim, publicEndpoint: nfd, listingPin: PIN }, binding: x.binding, local: LOCAL, now: NOW })), "discovery_endpoint_mismatch");
    const getter = Object.defineProperty({ seller: x.seller.claim, listingPin: PIN }, "publicEndpoint", { enumerable: true, get() { throw new Error("must not run"); } });
    await refuses(async () => (await w.verifyEndpointProof(bytes, { readListingEligibility: readFixtureListingEligibility, listing: getter as never, binding: x.binding, local: LOCAL, now: NOW })), "wire_input_invalid");
  });
  it("refuses uppercase DID claims at each receiver without rewriting signed bytes", async () => {
    const x = (await world());
    for (const role of ["buyer", "seller"] as const) {
      const request = { ...x.request, [role]: x.request[role].replace(/^did:/, "DID:") };
      await refuses(async () => (await w.openWireEnvelope(header(signed(request, w.DACS_SELLER_HTTP_DOMAINS.request, x.buyer)), "request", x.context)), "peer_envelope_invalid");
      const delegation = { ...x.delegation, [role]: x.delegation[role].replace(/^did:/, "DID:") };
      await refuses(async () => (await w.verifySellerSessionDelegation(Buffer.from(JSON.stringify(signed(delegation, w.DACS_SELLER_HTTP_DOMAINS.delegation, x.buyer))), x.delegationScope)), "peer_delegation_invalid");
    }
    const document = signed({ ...x.discovery, seller: x.seller.claim.replace(/^did:/, "DID:") }, w.DACS_SELLER_HTTP_DOMAINS.discovery, x.seller);
    await refuses(async () => (await w.verifyEndpointProof(Buffer.from(canonicalize(document)), { readListingEligibility: readFixtureListingEligibility, listing: { seller: x.seller.claim, publicEndpoint: ENDPOINT, listingPin: PIN }, binding: x.binding, local: LOCAL, now: NOW })), "discovery_invalid");
    const { bytes } = await proof(x);
    await refuses(async () => (await w.verifyEndpointProof(bytes, { readListingEligibility: readFixtureListingEligibility, listing: { seller: x.seller.claim.replace(/^did:/, "DID:"), publicEndpoint: ENDPOINT, listingPin: PIN }, binding: x.binding, local: LOCAL, now: NOW })), "wire_input_invalid");
  });
  it("declares canonical lowercase DID-only admission and refuses uppercase wire claims before signing", async () => {
    const x = (await world());
    for (const role of ["buyer", "seller"] as const) {
      await refuses(() => w.signWireEnvelope({ ...x.request, [role]: x.request[role].replace(/^did:/, "DID:") }, { ...x.context, signer: x.buyer }), "peer_envelope_invalid");
    }
    expect(x.buyer.calls).toBe(0);
  });
  it("refuses correctly signed uppercase key components at every wire boundary and before producer signatures", async () => {
    const x = (await world());
    const uppercaseKey = (claim: string) => claim.slice(0, -64) + claim.slice(-64).toUpperCase();
    for (const role of ["buyer", "seller"] as const) {
      const claim = uppercaseKey(x.request[role]);
      expect(claim).not.toBe(x.request[role]);
      const request = { ...x.request, [role]: claim };
      const delegation = { ...x.delegation, [role]: claim };
      const envelope = signed(request, w.DACS_SELLER_HTTP_DOMAINS.request, x.buyer);
      const delegated = signed(delegation, w.DACS_SELLER_HTTP_DOMAINS.delegation, x.buyer);
      const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(x.buyer.raw, "hex")]), format: "der", type: "spki" });
      for (const [message, domain] of [[envelope, w.DACS_SELLER_HTTP_DOMAINS.request], [delegated, w.DACS_SELLER_HTTP_DOMAINS.delegation]] as const) {
        expect(verify(null, Buffer.from(domain + canonicalize(message.payload)), key, Buffer.from(message.signature, "base64url"))).toBe(true);
      }
      x.buyer.calls = x.seller.calls = 0;
      await refuses(async () => (await w.openWireEnvelope(header(envelope), "request", x.context)), "peer_envelope_invalid");
      await refuses(async () => (await w.verifySellerSessionDelegation(Buffer.from(JSON.stringify(delegated)), x.delegationScope)), "peer_delegation_invalid");
      await refuses(() => w.signWireEnvelope(request, { ...x.context, signer: x.buyer }), "peer_envelope_invalid");
      await refuses(() => w.signSellerSessionDelegation(delegation, x.buyer, x.binding, LOCAL), "peer_delegation_invalid");
      await refuses(async () => (await w.sellerSessionDelegationSigningBytes(delegation, x.binding, LOCAL)), "peer_delegation_invalid");
      expect(x.buyer.calls + x.seller.calls).toBe(0);
    }
    const discovery = { ...x.discovery, seller: uppercaseKey(x.seller.claim) };
    const document = signed(discovery, w.DACS_SELLER_HTTP_DOMAINS.discovery, x.seller);
    const sellerKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(x.seller.raw, "hex")]), format: "der", type: "spki" });
    expect(verify(null, Buffer.from(w.DACS_SELLER_HTTP_DOMAINS.discovery + canonicalize(discovery)), sellerKey, Buffer.from(document.signature, "base64url"))).toBe(true);
    x.seller.calls = 0;
    await refuses(async () => (await w.verifyEndpointProof(Buffer.from(canonicalize(document)), { readListingEligibility: readFixtureListingEligibility, listing: { seller: x.seller.claim, publicEndpoint: ENDPOINT, listingPin: PIN }, binding: x.binding, local: LOCAL, now: NOW })), "discovery_invalid");
    await refuses(() => w.signDiscoveryDocument(discovery, { ...x.seller, claim: discovery.seller }, x.binding, LOCAL), "discovery_invalid");
    expect(x.seller.calls).toBe(0);
  });
});

describe("a purchase the buyer already committed continues while the seller drains or its Listing ends", { timeout: 60_000 }, () => {
  // The signed Listing and the new-purchase reader have the same one-minute window from NOW - 1 s;
  // discovery lasts ten. Continuation checks the signed window at the receipt's COMMITTED time.
  const COMMITTED = NOW + 1000, ENDED = NOW + 120_000;
  const VALIDITY = { notBefore: NOW - 1000, notAfter: NOW + 60_000 };
  const CONTINUING = ["/dacs/v1/payments", "/dacs/v1/bundles/request", "/dacs/v1/bundles/countersignature", "/dacs/v1/agreements/state", "/dacs/v1/bundles/buyer-copy"] as const;
  /** The routes among them that need the job's commitment to be signed at all; the others are readback. */
  const EVIDENCE_ROUTES = CONTINUING.filter(isContinuingRoute), READBACK = CONTINUING.filter((path) => !isContinuingRoute(path));
  /** Routes that start or commit a purchase: never continued, with or without the job's commitment. */
  const STARTING = ["/dacs/v1/agreements/proposals", "/dacs/v1/commitments", "/dacs/v1/commitments/signature", "/dacs/v1/agreements/context"] as const;
  const windowed: w.ListingEligibilityReader = (scope) => ({ ...(readFixtureListingEligibility(scope) as object), notBefore: VALIDITY.notBefore, expiresAt: VALIDITY.notAfter });
  const accepted = (generatedAt = NOW, jobId = JOB, listingId?: string) =>
    acceptedPurchase({ jobId, generatedAt, validity: VALIDITY, publicEndpoint: ENDPOINT, ...(listingId ? { listingId } : {}) });
  /** Independently signed evidence: the normal producer refuses off-window receipts before the wire sees them. */
  function signedCommitment(purchase: AcceptedPurchase, committedAt: number) {
    return wireCommitment({ seller: { claim: purchase.seller.claim, sign: purchase.seller.signBytes }, buyer: purchase.buyer.claim,
      jobId: purchase.agreement.jobId, agreementHash: purchase.agreementHash, listingPin: purchase.pin, committedAt,
      patch: { createdAt: purchase.agreement.generatedAt } });
  }
  /** An Agreement both parties signed, and its finality commitment from commitFixedPriceAgreement. */
  async function committed(committedAt = COMMITTED) {
    const purchase = await accepted();
    return { x: (await world(purchase)), purchase, commitment: await commitPurchase(purchase, committedAt) };
  }
  async function proof(x: Awaited<ReturnType<typeof world>>, ready: boolean, now = NOW, extra: object = {}) {
    const bytes = await w.signDiscoveryDocument({ ...x.discovery, ready, expiresAt: NOW + 600_000 }, x.seller, x.binding, LOCAL);
    return (await w.verifyEndpointProof(bytes, { readListingEligibility: windowed, readCommitmentReceipt: validReceipt, listing: { seller: x.seller.claim, publicEndpoint: ENDPOINT, listingPin: x.pin }, binding: x.binding, local: LOCAL, now, request: { ...x.request, path: "commitment" in extra ? w.DACS_SELLER_HTTP_PATHS.payments : w.DACS_SELLER_HTTP_PATHS.proposals }, agreement: received(x.agreement), signedListing: received(x.listing), ...asReceived(extra) }));
  }
  /** Both buyer signers, for a payment. */
  const signers = (x: Awaited<ReturnType<typeof world>>, extra: object, endpointProof: w.EndpointProof, now: number) => [
    () => w.signWireRequest({ ...x.input, path: "/dacs/v1/payments", endpointProof, now, request: { ...x.request, path: w.DACS_SELLER_HTTP_PATHS.payments }, agreement: received(x.agreement), signedListing: received(x.listing), ...asReceived(extra) } as w.WireRequestInput),
    () => w.signWireEnvelope({ ...x.request, path: "/dacs/v1/payments" }, { ...x.context, signer: x.buyer, endpointProof, publicEndpoint: ENDPOINT, now, request: { ...x.request, path: w.DACS_SELLER_HTTP_PATHS.payments }, agreement: received(x.agreement), signedListing: received(x.listing), ...asReceived(extra) } as w.EnvelopeSigningContext),
  ] as const;
  /** The seller opens and checks the request against its own copy of the commitment and answers it; the buyer verifies the answer. */
  async function reachesSeller(x: Awaited<ReturnType<typeof world>>, sent: { payload: w.WireRequestPayload; header: string }, now: number, commitment: unknown) {
    const opened = (await w.openWireEnvelope(sent.header, "request", x.context));
    expect((await w.checkWireRequest(opened, { requestJournal: testJournal(), retained: retainedFixture(opened), ...x.context, seller: x.seller.claim, listingPin: x.pin, method: "POST", path: sent.payload.path, rawBody: Buffer.from("{}"), now,
      commitment: received(commitment), agreement: received(x.agreement), readCommitmentReceipt: validReceipt, signedListing: received(x.listing) })).readbackOnly).toBe(false);
    const answer = await w.signWireResponse(sent.payload, 200, "{}", { ...x.context, signer: x.seller, now });
    expect((await w.verifyWireResponse(sent.payload, { ...x.context, header: answer, status: 200, body: Buffer.from("{}"), now })).principal).toBe(x.seller.claim);
  }
  it("ready: false refuses a new purchase as before, and a committed one is signed on every continuing route, checked and answered", async () => {
    const { x, commitment } = await committed(), endpointProof = await proof(x, false), now = NOW + 5000;
    for (const path of [...STARTING, ...READBACK]) {
      await expect(w.signWireRequest({ ...x.input, path, endpointProof, now })).rejects.toMatchObject({ code: "seller_not_ready", status: 503, category: "transient" });
    }
    // A payment or delivery request without the commitment is refused for it, before readiness is looked at.
    for (const path of EVIDENCE_ROUTES) await refuses(() => w.signWireRequest({ ...x.input, path, endpointProof, now }), "continuation_commitment_invalid", 500);
    // A proposal, commitment or context request is a new purchase even with the job's commitment.
    for (const path of STARTING) {
      await refuses(() => w.signWireRequest({ ...x.input, path, endpointProof, commitment: received(commitment), agreement: received(x.agreement), signedListing: received(x.listing), now }), "seller_not_ready", 503);
      await refuses(() => w.signWireEnvelope({ ...x.request, path }, { ...x.context, signer: x.buyer, endpointProof, publicEndpoint: ENDPOINT, now, commitment: received(commitment), agreement: received(x.agreement), signedListing: received(x.listing) }), "seller_not_ready", 503);
    }
    await refuses(() => w.signWireEnvelope({ ...x.request, path: STARTING[0] }, { ...x.context, signer: x.buyer, endpointProof, publicEndpoint: ENDPOINT, now }), "seller_not_ready", 503);
    expect(x.buyer.calls).toBe(0);
    for (const path of CONTINUING) await reachesSeller(x, await w.signWireRequest({ ...x.input, path, endpointProof, commitment: received(commitment), agreement: received(x.agreement), signedListing: received(x.listing), now }), now, commitment);
    await w.signWireEnvelope({ ...x.request, path: CONTINUING[0] }, { ...x.context, signer: x.buyer, endpointProof, publicEndpoint: ENDPOINT, now, commitment: received(commitment), agreement: received(x.agreement), signedListing: received(x.listing) });
    expect(x.buyer.calls).toBe(CONTINUING.length + 1);
  });
  it("an ended Listing window refuses a new purchase as before, and one committed inside it is signed, checked and answered", async () => {
    const { x, commitment } = await committed(), kept = await proof(x, true);
    for (const path of [...STARTING, ...READBACK]) {
      await refuses(() => w.signWireRequest({ ...x.input, path, endpointProof: kept, now: ENDED }), "listing_unsupported", 500);
    }
    for (const path of EVIDENCE_ROUTES) await refuses(() => w.signWireRequest({ ...x.input, path, endpointProof: kept, now: ENDED }), "continuation_commitment_invalid", 500);
    for (const path of STARTING) await refuses(() => w.signWireRequest({ ...x.input, path, endpointProof: kept, commitment: received(commitment), agreement: received(x.agreement), signedListing: received(x.listing), now: ENDED }), "listing_unsupported", 500);
    await refuses(() => w.signWireEnvelope({ ...x.request, path: STARTING[0] }, { ...x.context, signer: x.buyer, endpointProof: kept, publicEndpoint: ENDPOINT, now: ENDED }), "listing_unsupported", 500);
    // Verifying discovery again, as after the ten-minute document lapses.
    await refuses(async () => (await proof(x, true, ENDED)), "listing_unsupported", 500);
    expect(x.buyer.calls).toBe(0);
    const again = await proof(x, true, ENDED, { commitment }), drained = await proof(x, false, ENDED, { commitment });
    for (const endpointProof of [kept, again, drained]) {
      for (const path of CONTINUING) await reachesSeller(x, await w.signWireRequest({ ...x.input, path, endpointProof, commitment: received(commitment), agreement: received(x.agreement), signedListing: received(x.listing), now: ENDED }), ENDED, commitment);
    }
    await w.signWireEnvelope({ ...x.request, path: CONTINUING[0] }, { ...x.context, signer: x.buyer, endpointProof: again, publicEndpoint: ENDPOINT, now: ENDED, commitment: received(commitment), agreement: received(x.agreement), signedListing: received(x.listing) });
    expect(x.buyer.calls).toBe(3 * CONTINUING.length + 1);
    // A proof verified for the committed job is no proof for a new purchase.
    await refuses(() => w.signWireRequest({ ...x.input, path: STARTING[0], endpointProof: again, now: ENDED }), "listing_unsupported", 500);
    await refuses(() => w.signWireRequest({ ...x.input, path: STARTING[0], endpointProof: drained, now: ENDED }), "seller_not_ready", 503);
    expect(x.buyer.calls).toBe(3 * CONTINUING.length + 1);
  });
  it("a committed purchase still needs a commitment time inside the window, and every other proof check", async () => {
    const purchase = await accepted(VALIDITY.notBefore), x = (await world(purchase)), endpointProof = await proof(x, false);
    const pay = async (committedAt: number, patch: Partial<w.WireRequestInput> = {}) =>
      w.signWireRequest({ ...x.input, path: "/dacs/v1/payments", endpointProof, commitment: received(signedCommitment(purchase, committedAt)), agreement: received(x.agreement), signedListing: received(x.listing), now: ENDED, ...patch });
    // Committed before the Listing's window opened, or after it ended; its first and last instants hold (notAfter >= committedAt).
    for (const committedAt of [NOW - 1001, NOW + 60_001]) await refuses(() => pay(committedAt), "continuation_commitment_invalid", 500);
    expect(x.buyer.calls).toBe(0);
    for (const committedAt of [NOW - 1000, NOW + 60_000]) await pay(committedAt);
    expect(x.buyer.calls).toBe(2);
    x.buyer.calls = 0;
    await refuses(() => pay(COMMITTED, { now: NOW + 600_000 }), "discovery_expired", 503);
    await refuses(() => pay(COMMITTED, { seller: party().claim }), "endpoint_proof_mismatch", 500);
    // A committed purchase uses its pinned Listing; only new purchases consult the live eligibility reader.
    const revoked = new Error("Listing revoked");
    let reads = 0;
    const bytes = await w.signDiscoveryDocument({ ...x.discovery, expiresAt: NOW + 600_000 }, x.seller, x.binding, LOCAL);
    const read = (await w.verifyEndpointProof(bytes, { readListingEligibility: (scope) => { if (reads++) throw revoked; return windowed(scope); }, readCommitmentReceipt: validReceipt, listing: { seller: x.seller.claim, publicEndpoint: ENDPOINT, listingPin: x.pin }, binding: x.binding, local: LOCAL, now: NOW }));
    await pay(COMMITTED, { endpointProof: read });
    expect(reads).toBe(1);
    expect(x.buyer.calls).toBe(1);
    await expect(w.signWireRequest({ ...x.input, path: STARTING[0], endpointProof: read, now: ENDED })).rejects.toBe(revoked);
    expect(reads).toBe(2);
    expect(x.buyer.calls).toBe(1);
  });
  it("refuses forged, future and backdated times at both signers and at proof refresh", async () => {
    const { x, purchase, commitment } = await committed(), drained = await proof(x, false), kept = await proof(x, true), now = NOW + 5000;
    // Forged: a time the caller states (the removed agreedAt) leaves a new purchase.
    await refuses(() => w.signWireRequest({ ...x.input, path: "/dacs/v1/payments", job: { ...x.input.job, agreedAt: COMMITTED } as w.WireJobContext, endpointProof: drained, now }), "continuation_commitment_invalid", 500);
    await refuses(() => w.signWireRequest({ ...x.input, path: "/dacs/v1/payments", job: { ...x.input.job, agreedAt: COMMITTED } as w.WireJobContext, endpointProof: kept, now: ENDED }), "continuation_commitment_invalid", 500);
    await refuses(signers(x, { agreedAt: COMMITTED }, drained, now)[1], "continuation_commitment_invalid", 500);
    await refuses(signers(x, { agreedAt: COMMITTED }, kept, ENDED)[1], "continuation_commitment_invalid", 500);
    await refuses(async () => (await proof(x, true, ENDED, { agreedAt: COMMITTED })), "listing_unsupported", 500);
    // Forged: no evidence, a stated time, or the gate's result with a member changed (its record, receipt or stated facts).
    const receipt = commitment.anchorReceipt, block = receipt.blockRef!, record = commitment.record as { signature: unknown; createdAt: number };
    const forgeries = [COMMITTED, null, {}, { committedAt: COMMITTED }, { ...commitment, committedAt: COMMITTED - 1 },
      { ...commitment, recordKind: "legacy" }, { ...commitment, legacySignature: record.signature },
      { ...commitment, record: { ...record, createdAt: record.createdAt + 1 } },
      // The seller's signature itself: one bit flipped, or all A, with every other member right.
      { ...commitment, record: { ...record, signature: { ...(record.signature as object), value: flip((record.signature as { value: string }).value) } } },
      { ...commitment, record: { ...record, signature: { ...(record.signature as object), value: "A".repeat(86) } } },
      { ...commitment, anchorReceipt: { ...receipt, state: "included" } }, { ...commitment, anchorReceipt: { ...receipt, observationDisposition: "indeterminate" } },
      { ...commitment, anchorReceipt: { ...receipt, blockRef: { ...block, timestamp: COMMITTED - 1 } } }];
    for (const forged of forgeries) {
      for (const sign of [...signers(x, { commitment: forged }, drained, now), ...signers(x, { commitment: forged }, kept, ENDED)]) {
        await refuses(sign, "continuation_commitment_invalid", 500);
      }
      await refuses(async () => (await proof(x, true, ENDED, { commitment: forged })), "continuation_commitment_invalid", 500);
    }
    // A commitment signed by anyone but the seller, TP-1's orchestrator, continues nothing.
    const notSeller = wireCommitment({ seller: { claim: x.buyer.claim, sign: purchase.buyer.signBytes }, buyer: x.buyer.claim, jobId: JOB, agreementHash: purchase.agreementHash, listingPin: x.pin, committedAt: COMMITTED, signer: x.seller.claim });
    for (const sign of signers(x, { commitment: notSeller }, drained, now)) await refuses(sign, "continuation_commitment_invalid", 500);
    // A real commitment for another job and Agreement continues neither this job's payment nor its readback.
    const otherCommitment = await commitPurchase(await accepted(NOW, "01K7FZ8Q9W3V5T2R1N0M8K6J4J"), COMMITTED);
    for (const sign of signers(x, { commitment: otherCommitment }, drained, now)) await refuses(sign, "continuation_commitment_invalid", 500);
    await refuses(() => w.signWireRequest({ ...x.input, path: "/dacs/v1/agreements/state", endpointProof: kept, commitment: received(otherCommitment), agreement: received(x.agreement), signedListing: received(x.listing), now: ENDED }), "continuation_commitment_invalid", 500);
    // Nor does one for another of the seller's Listings refresh this proof, or this one a proof whose Listing names another seller.
    const foreign = await commitPurchase(await accepted(NOW, JOB, "other-report"), COMMITTED);
    await refuses(async () => (await proof(x, true, ENDED, { commitment: foreign })), "continuation_commitment_invalid", 500);
    // The Listing it pins is presented by the seller, not by the proof's: refused at the Listing, before the record's signer is read.
    await refuses(async () => (await proof((await world({ ...purchase, seller: seededParty(44) })), true, ENDED, { commitment })), "continuation_listing_invalid", 500);
    // Future: a receipt time after the signer's clock, beyond the 30 s skew, has not finalized by it.
    const future = await commitPurchase(purchase, now + 30_001), skewed = await commitPurchase(purchase, now + 30_000);
    for (const sign of signers(x, { commitment: future }, drained, now)) await refuses(sign, "continuation_commitment_invalid", 500);
    await refuses(async () => (await proof(x, true, now, { commitment: future })), "continuation_commitment_invalid", 500);
    expect(x.buyer.calls).toBe(0);
    for (const sign of signers(x, { commitment: skewed }, drained, now)) await sign();
    expect(x.buyer.calls).toBe(2);
    // Backdated: an Agreement generated inside the window whose commitment finalized after it ended. Only the
    // receipt's committedAt is compared, so the Agreement's own generatedAt extends nothing.
    const late = await accepted(NOW + 1000), lx = (await world(late)), lateCommitment = signedCommitment(late, NOW + 60_001);
    expect(late.agreement.generatedAt).toBe(NOW + 1000);
    const lateKept = await proof(lx, true), lateDrained = await proof(lx, false);
    for (const sign of [...signers(lx, { commitment: lateCommitment }, lateKept, ENDED), ...signers(lx, { commitment: lateCommitment }, lateDrained, NOW + 61_000)]) {
      await refuses(sign, "continuation_commitment_invalid", 500);
    }
    await refuses(async () => (await proof(lx, true, ENDED, { commitment: lateCommitment })), "continuation_commitment_invalid", 500);
    expect(lx.buyer.calls).toBe(0);
  });
});

describe("the seller's own drain state at a new purchase", { timeout: 60_000 }, () => {
  const P = w.DACS_SELLER_HTTP_PATHS;
  /** A buyer that verified discovery while the seller was ready, and the seller's check of what it signs, by the seller's own `ready`. */
  async function drained() {
    const x = (await world()), now = NOW + 5000;
    const bytes = await w.signDiscoveryDocument(x.discovery, x.seller, x.binding, LOCAL);
    const endpointProof = (await w.verifyEndpointProof(bytes, { readListingEligibility: readFixtureListingEligibility, readCommitmentReceipt: validReceipt, listing: { seller: x.seller.claim, publicEndpoint: ENDPOINT, listingPin: PIN }, binding: x.binding, local: LOCAL, now: NOW }));
    expect(endpointProof.ready).toBe(true);
    // The seller drains after the buyer verified discovery; the buyer's proof still says ready, so it signs.
    const journals = testJournals();
    const counter = { get reservations() { return journals.reservations().length; } };
    const atSeller = async (sent: { payload: w.WireRequestPayload; header: string }, extra: object) => {
      const opened = (await w.openWireEnvelope(sent.header, "request", x.context));
      return async (ready: unknown) => (await w.checkWireRequest(opened, { requestJournal: journals.open(), artifacts: agreementFixture(opened), retained: retainedFixture(opened),
        ...x.context, seller: x.seller.claim, listingPin: PIN, method: "POST", path: sent.payload.path, rawBody: Buffer.from("{}"), now, ...extra, ...(ready === missing ? {} : { ready }) } as w.RequestCheck));
    };
    const delegation = signed(x.delegation, w.DACS_SELLER_HTTP_DOMAINS.delegation, x.buyer);
    // The buyer signs with the same commitment evidence the seller then checks against its own copy.
    const checks = async (path: string, extra: { commitment?: unknown; agreement?: unknown; signedListing?: unknown; readCommitmentReceipt?: unknown } = {}) => {
      const { commitment, agreement, signedListing } = extra;
      const evidence = { commitment, agreement, signedListing };
      return [
        (await atSeller(await w.signWireRequest({ ...x.input, path, endpointProof, now, ...evidence }), extra)),
        (await atSeller(await w.signWireRequest({ ...x.input, signer: x.session, delegation, path, endpointProof, now, ...evidence }), { requireDelegation: true, ...extra })),
      ];
    };
    return { x, checks, counter };
  }
  // Every route the buyer signs as a new purchase (discovery.ts CONTINUING_PATHS names the others).
  it.each([P.proposals, P.commitments, P.commitmentSignature, P.context])("a ready: true proof kept after the seller drains is refused at the seller on %s, direct and delegated, with the same code", async (path) => {
    const { checks, counter } = await drained();
    const [direct, delegated] = await checks(path);
    for (const check of [direct!, delegated!]) {
      await expect(Promise.resolve().then(async () => (await check(false)))).rejects.toMatchObject({ code: "seller_not_ready", status: 503, category: "transient" });
      // The seller's own state is required for a new purchase.
      for (const ready of [missing, null, "false", 0]) await refuses(async () => (await check(ready)), "seller_readiness_required", 500);
    }
    // Refused before any reservation.
    expect(counter.reservations).toBe(0);
    expect((await direct!(true)).readbackOnly).toBe(false);
    expect((await delegated!(true)).readbackOnly).toBe(false);
    expect(counter.reservations).toBe(2);
  });
  it("other routes do not read it: a drained seller still takes a committed purchase's payment, delivery and readback", async () => {
    const { x, checks } = await drained();
    const commitment = wireCommitment({ seller: x.seller, buyer: x.buyer.claim, jobId: JOB, agreementHash: x.request.agreementHash, listingPin: PIN, committedAt: NOW });
    for (const path of [P.payments, P.bundleRequest, P.bundleCountersignature, P.state, P.bundleBuyerCopy]) {
      for (const check of await checks(path, { commitment: received(commitment), agreement: received(x.agreement), readCommitmentReceipt: validReceipt, signedListing: received(x.listing) })) for (const ready of [false, missing]) expect((await check(ready)).readbackOnly).toBe(false);
    }
  });
});

describe("wire format discriminators", () => {
  // Each refused message is correctly signed by its own party under its own domain (checked here without the SDK)
  // and differs from the accepted control only in its discriminator, so the refusal is the discriminator's.
  const D = w.DACS_SELLER_HTTP_DOMAINS;
  const rawKey = (claim: string) => createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(claim.slice(-64), "hex")]), format: "der", type: "spki" });
  const signedBy = (message: { payload: unknown; signature: string }, domain: string, key: string) =>
    verify(null, Buffer.from(domain + canonicalize(message.payload)), rawKey(key), Buffer.from(message.signature, "base64url"));
  const listing = { seller: "", publicEndpoint: ENDPOINT, listingPin: PIN };
  const verifyProof = async (x: Awaited<ReturnType<typeof world>>, bytes: Uint8Array) =>
    (await w.verifyEndpointProof(bytes, { readListingEligibility: readFixtureListingEligibility, listing: { ...listing, seller: x.seller.claim }, binding: x.binding, local: LOCAL, now: NOW }));
  const answer = (x: Awaited<ReturnType<typeof world>>) => ({ ...x.request, kind: "response", bodyHash: sha("{}"), expiresAt: NOW + 30_000, requestHash: w.wireRequestHash(x.request), status: 200 });

  it("accepts each control: delegation, delegated request, discovery, request and response", async () => {
    const x = (await world());
    const delegation = signed(x.delegation, D.delegation, x.buyer);
    expect((await w.verifySellerSessionDelegation(Buffer.from(JSON.stringify(delegation)), x.delegationScope)).kind).toBe("seller-session-delegation");
    expect((await w.openWireEnvelope(header({ ...signed(x.request, D.request, x.session), delegation }), "request", { ...x.context, requireDelegation: true })).delegation).toEqual(delegation);
    const endpointProof = (await verifyProof(x, Buffer.from(canonicalize(signed(x.discovery, D.discovery, x.seller)))));
    x.session.calls = 0;
    expect((await w.signWireRequest({ ...x.input, signer: x.session, delegation, endpointProof })).payload.buyer).toBe(x.buyer.claim);
    expect(x.session.calls).toBe(1);
    expect((await w.openWireEnvelope(header(signed(x.request, D.request, x.buyer)), "request", x.context)).payload.kind).toBe("request");
    expect((await w.verifyWireResponse(x.request, { ...x.context, header: header(signed(answer(x), D.response, x.seller)), status: 200, body: Buffer.from("{}"), now: NOW })).principal).toBe(x.seller.claim);
  });

  it.each<[string, Record<string, unknown>]>([
    ["version 2", { version: "2" }], ["numeric version 1", { version: 1 }], ["empty version", { version: "" }], ["null version", { version: null }],
    ["version with a trailing space", { version: "1 " }], ["another kind", { kind: "seller-session-delegation/v2" }], ["request kind", { kind: "request" }],
    ["mixed-case kind", { kind: "Seller-Session-Delegation" }], ["array kind", { kind: ["seller-session-delegation"] }],
  ])("refuses a correctly signed delegation with %s at every receiver and before every signer", async (_name, patch) => {
    const x = (await world());
    const payload = { ...x.delegation, ...patch } as w.SellerSessionDelegationPayload;
    const delegation = signed(payload, D.delegation, x.buyer);
    expect(signedBy(delegation, D.delegation, x.buyer.claim)).toBe(true);
    const delegatedHeader = header({ ...signed(x.request, D.request, x.session), delegation });
    const endpointProof = (await verifyProof(x, Buffer.from(canonicalize(signed(x.discovery, D.discovery, x.seller)))));
    x.buyer.calls = x.session.calls = x.seller.calls = 0;
    let effects = 0;
    await refuses(async () => (await w.verifySellerSessionDelegation(Buffer.from(JSON.stringify(delegation)), x.delegationScope)), "peer_delegation_invalid");
    await refuses(async () => { (await w.openWireEnvelope(delegatedHeader, "request", { ...x.context, requireDelegation: true })); effects++; }, "peer_delegation_invalid");
    await refuses(() => w.signWireRequest({ ...x.input, signer: x.session, delegation, endpointProof }), "peer_delegation_invalid");
    await refuses(() => w.signSellerSessionDelegation(payload, x.buyer, x.binding, LOCAL), "peer_delegation_invalid");
    await refuses(async () => (await w.sellerSessionDelegationSigningBytes(payload, x.binding, LOCAL)), "peer_delegation_invalid");
    expect(effects + x.buyer.calls + x.session.calls + x.seller.calls).toBe(0);
  });

  it.each<[string, Record<string, unknown>]>([
    ["format v2", { format: "dacs-seller-discovery/v2" }], ["upper-case format", { format: "DACS-SELLER-DISCOVERY/V1" }], ["numeric format", { format: 1 }],
    ["null format", { format: null }], ["transport v2", { transport: ["dacs-seller-http/v2"] }], ["repeated transport", { transport: ["dacs-seller-http/v1", "dacs-seller-http/v1"] }],
    ["an extra transport", { transport: ["dacs-seller-http/v1", "dacs-seller-http/v2"] }], ["no transport", { transport: [] }],
    ["string transport", { transport: "dacs-seller-http/v1" }], ["array-like transport object", { transport: { 0: "dacs-seller-http/v1", length: 1 } }],
    ["nested transport", { transport: [["dacs-seller-http/v1"]] }],
  ])("refuses a correctly signed discovery document with %s before any purchase signature, and before its signer", async (_name, patch) => {
    const x = (await world());
    const payload = { ...x.discovery, ...patch } as w.DiscoveryPayload;
    const document = signed(payload, D.discovery, x.seller);
    expect(signedBy(document, D.discovery, x.seller.claim)).toBe(true);
    x.seller.calls = 0;
    await refuses(async () => w.signWireRequest({ ...x.input, endpointProof: (await verifyProof(x, Buffer.from(canonicalize(document)))) }), "discovery_invalid", 502);
    // The signer's own document is its own fault (500); the same bytes received are the seller's (502).
    await refuses(() => w.signDiscoveryDocument(payload, x.seller, x.binding, LOCAL), "discovery_invalid", 500);
    await refuses(() => w.discoverySigningBytes(payload), "discovery_invalid", 502);
    expect(x.buyer.calls + x.seller.calls).toBe(0);
  });

  it.each<[string, Record<string, unknown>]>([
    ["version 2", { version: "2" }], ["numeric version 1", { version: 1 }], ["the other kind", { kind: "response" }], ["method GET", { method: "GET" }],
  ])("refuses a correctly signed request with %s at the seller and before the buyer's signer", async (_name, patch) => {
    const x = (await world());
    const request = { ...x.request, ...patch } as unknown as w.WireRequestPayload;
    const envelope = signed(request, D.request, x.buyer);
    expect(signedBy(envelope, D.request, x.buyer.claim)).toBe(true);
    x.buyer.calls = 0;
    let effects = 0;
    await refuses(async () => { (await w.openWireEnvelope(header(envelope), "request", x.context)); effects++; }, "peer_envelope_invalid");
    await refuses(() => w.signWireEnvelope(request, { ...x.context, signer: x.buyer }), "peer_envelope_invalid");
    expect(effects + x.buyer.calls).toBe(0);
  });

  it.each<[string, Record<string, unknown>]>([
    ["version 2", { version: "2" }], ["numeric version 1", { version: 1 }], ["the other kind", { kind: "request" }], ["method GET", { method: "GET" }],
  ])("refuses a correctly signed response with %s at the buyer and before the seller's signer", async (_name, patch) => {
    const x = (await world());
    const response = { ...answer(x), ...patch };
    const envelope = signed(response, D.response, x.seller);
    expect(signedBy(envelope, D.response, x.seller.claim)).toBe(true);
    x.seller.calls = 0;
    await refuses(async () => (await w.verifyWireResponse(x.request, { ...x.context, header: header(envelope), status: 200, body: Buffer.from("{}"), now: NOW })), "peer_envelope_invalid");
    await refuses(() => w.signWireEnvelope(response as unknown as w.WirePayload, { ...x.context, signer: x.seller }), "peer_envelope_invalid");
    expect(x.seller.calls).toBe(0);
  });
});

describe("request and response byte budgets and the discovery Listing count", () => {
  const { maxRequestBodyBytes, maxResponseBodyBytes } = w.DACS_SELLER_HTTP_LIMITS;
  /** A JSON object of exactly n UTF-8 bytes. */
  const body = (n: number) => `{"p":"${"x".repeat(n - 8)}"}`;
  const proofFor = async (x: Awaited<ReturnType<typeof world>>) => (await w.verifyEndpointProof(await w.signDiscoveryDocument(x.discovery, x.seller, x.binding, LOCAL), { readListingEligibility: readFixtureListingEligibility, listing: { seller: x.seller.claim, publicEndpoint: ENDPOINT, listingPin: PIN }, binding: x.binding, local: LOCAL, now: NOW }));

  it("signs and admits a 64 KiB request body and refuses one more byte at the buyer's signer and at the seller", async () => {
    const x = (await world()), endpointProof = await proofFor(x);
    expect(Buffer.byteLength(body(maxRequestBodyBytes))).toBe(65_536);
    x.buyer.calls = 0;
    await w.signWireRequest({ ...x.input, text: body(maxRequestBodyBytes), endpointProof });
    expect(x.buyer.calls).toBe(1);
    await refuses(() => w.signWireRequest({ ...x.input, text: body(maxRequestBodyBytes + 1), endpointProof }), "body_too_large", 500);
    expect(x.buyer.calls).toBe(1);
    let effects = 0;
    for (const n of [maxRequestBodyBytes, maxRequestBodyBytes + 1]) {
      const text = body(n);
      const opened = (await w.openWireEnvelope(header(signed({ ...x.request, bodyHash: sha(text) }, w.DACS_SELLER_HTTP_DOMAINS.request, x.buyer)), "request", x.context));
      const check = async () => (await w.checkWireRequest(opened, { requestJournal: testJournal(), ready: true, artifacts: agreementFixture(opened), retained: retainedFixture(opened), ...x.context, seller: x.seller.claim, listingPin: PIN, method: "POST", path: x.request.path, rawBody: Buffer.from(text), now: NOW }));
      if (n === maxRequestBodyBytes) expect(Object.keys((await check()).body)).toEqual(["p"]);
      else await expect(Promise.resolve().then(async () => { (await check()); effects++; })).rejects.toMatchObject({ code: "bad_json", status: 400, detail: "BYTE-LIMIT-EXCEEDED" });
    }
    expect(effects).toBe(0);
  });

  it("signs and admits a 512 KiB response body and refuses one more byte at the seller's signer and at the buyer", async () => {
    const x = (await world());
    expect(Buffer.byteLength(body(maxResponseBodyBytes))).toBe(524_288);
    const ctx = { ...x.context, signer: x.seller, now: NOW };
    const exact = await w.signWireResponse(x.request, 200, body(maxResponseBodyBytes), ctx);
    expect(x.seller.calls).toBe(1);
    await refuses(() => w.signWireResponse(x.request, 200, body(maxResponseBodyBytes + 1), ctx), "peer_response_too_large", 500);
    expect(x.seller.calls).toBe(1);
    const received = (h: string, text: string) => ({ ...x.context, header: h, status: 200, body: Buffer.from(text), now: NOW });
    expect((await w.verifyWireResponse(x.request, received(exact, body(maxResponseBodyBytes)))).body).toEqual({ p: "x".repeat(maxResponseBodyBytes - 8) });
    // One byte over, correctly signed outside the SDK's signer: the buyer refuses it before reading the answer.
    const over = body(maxResponseBodyBytes + 1);
    const answer = { ...x.request, kind: "response", bodyHash: sha(over), expiresAt: NOW + 30_000, requestHash: w.wireRequestHash(x.request), status: 200 };
    await expect(Promise.resolve().then(async () => (await w.verifyWireResponse(x.request, received(header(signed(answer, w.DACS_SELLER_HTTP_DOMAINS.response, x.seller)), over)))))
      .rejects.toMatchObject({ code: "response_json_rejected", status: 502, detail: "BYTE-LIMIT-EXCEEDED" });
  });

  it("refuses a received body over its limit by the view's own length, before copying it or checking anything else", async () => {
    const x = (await world());
    const overRequest = Buffer.from(body(maxRequestBodyBytes + 1)), overResponse = Buffer.from(body(maxResponseBodyBytes + 1));
    // Not an opened envelope, and not a signed header: the size is refused first, so neither is examined.
    const seller = (rawBody: Uint8Array) => async () => (await w.checkWireRequest({} as never, { requestJournal: testJournal(), ...x.context, seller: x.seller.claim, listingPin: PIN, method: "POST", path: x.request.path, rawBody, now: NOW, retained: { jobId: JOB, agreementHash: x.request.agreementHash, buyer: x.buyer.claim, seller: x.seller.claim } }));
    const buyer = (b: Uint8Array) => async () => (await w.verifyWireResponse(x.request, { ...x.context, header: "not a header", status: 200, body: b, now: NOW }));
    const overRequestError = { code: "bad_json", status: 400, detail: "BYTE-LIMIT-EXCEEDED" };
    const overResponseError = { code: "response_json_rejected", status: 502, detail: "BYTE-LIMIT-EXCEEDED" };
    await expect(Promise.resolve().then(seller(overRequest))).rejects.toMatchObject(overRequestError);
    await expect(Promise.resolve().then(buyer(overResponse))).rejects.toMatchObject(overResponseError);
    // A view that declares a smaller byteLength of its own is measured by its internal length.
    const lying = (bytes: Buffer) => Object.defineProperty(new Uint8Array(bytes), "byteLength", { value: 2 });
    await expect(Promise.resolve().then(seller(lying(overRequest)))).rejects.toMatchObject(overRequestError);
    await expect(Promise.resolve().then(buyer(lying(overResponse)))).rejects.toMatchObject(overResponseError);
    // A small view of a larger allocation is charged its own length only.
    const view = Buffer.concat([Buffer.from("{}"), overResponse]).subarray(0, 2);
    await refuses(seller(view), "peer_request_unverified", 500);
    await refuses(buyer(view), "peer_envelope_invalid", 401);
  });

  it.each([[0, "refused"], [1, "accepted"], [32, "accepted"], [33, "refused"]] as const)("a discovery document listing %i pins is %s at its signer and at the buyer", async (count, outcome) => {
    const x = (await world()), accepted = outcome === "accepted";
    const listings = Array.from({ length: count }, (_, i) => (i === 0 ? PIN : { ...PIN, listingId: `report-${i}` }));
    const payload = { ...x.discovery, listings };
    const bytes = Buffer.from(canonicalize(signed(payload, w.DACS_SELLER_HTTP_DOMAINS.discovery, x.seller)));
    x.seller.calls = 0;
    const verifyIt = async () => (await w.verifyEndpointProof(bytes, { readListingEligibility: readFixtureListingEligibility, listing: { seller: x.seller.claim, publicEndpoint: ENDPOINT, listingPin: PIN }, binding: x.binding, local: LOCAL, now: NOW }));
    if (accepted) {
      expect((await verifyIt()).payload.listings).toHaveLength(count);
      await w.signDiscoveryDocument(payload, x.seller, x.binding, LOCAL);
      expect(x.seller.calls).toBe(1);
    } else {
      await refuses(verifyIt, "discovery_invalid", 502);
      await refuses(() => w.signDiscoveryDocument(payload, x.seller, x.binding, LOCAL), "discovery_invalid", 500);
      expect(x.seller.calls).toBe(0);
    }
  });
});

describe("signer-side refusals", () => {
  it("refuses a widened capability set or another signer's claim before the discovery signer is called", async () => {
    const x = (await world());
    const widened = { ...x.discovery, capabilities: { ...w.TP1_CAPABILITIES, output: { ...w.TP1_CAPABILITIES.output, maxCharacters: 16385 } } } as unknown as w.DiscoveryPayload;
    x.buyer.calls = x.seller.calls = 0;
    await refuses(() => w.signDiscoveryDocument(widened, x.seller, x.binding, LOCAL), "discovery_capabilities_unsupported", 500);
    await refuses(() => w.signDiscoveryDocument(x.discovery, x.buyer, x.binding, LOCAL), "discovery_signer_wrong", 500);
    expect(x.buyer.calls + x.seller.calls).toBe(0);
  });
  it("refuses an answer signer that is not the request's seller before it is called", async () => {
    const x = (await world());
    x.buyer.calls = x.seller.calls = 0;
    await refuses(() => w.signWireResponse(x.request, 200, "{}", { ...x.context, signer: x.buyer, now: NOW }), "peer_signer_wrong", 500);
    expect(x.buyer.calls + x.seller.calls).toBe(0);
  });
  it("blames a refusal of the buyer's own delegation on the buyer (500), keeping its code; the seller keeps the peer status", async () => {
    const x = (await world());
    const D = w.DACS_SELLER_HTTP_DOMAINS;
    const own = (d: unknown) => w.signWireRequest({ ...x.input, signer: x.session, delegation: d } as unknown as w.WireRequestInput);
    const sessionSigned = signed(x.request, D.request, x.session);
    const atSeller = async (d: unknown) => (await w.openWireEnvelope(header({ ...sessionSigned, delegation: d }), "request", x.context));
    const cases: Array<[unknown, string, number]> = [
      [signed({ ...x.delegation, seller: party().claim }, D.delegation, x.buyer), "peer_delegation_mismatch", 409],
      [signed({ ...x.delegation, jobId: "01K7FZ8Q9W3V5T2R1N0M8K6J4J" }, D.delegation, x.buyer), "peer_delegation_mismatch", 409],
      [signed({ ...x.delegation, notBefore: NOW + 1000, expiresAt: NOW + 60_000 }, D.delegation, x.buyer), "peer_delegation_expired", 408],
      [{ ...signed(x.delegation, D.delegation, x.buyer), signature: `0x${"0".repeat(128)}` }, "peer_delegation_signature_invalid", 401],
      [signed({ ...x.delegation, profile: { ...x.binding.profile, pinVersion: "other" } }, D.delegation, x.buyer), "tp1_profile_mismatch", 409],
      [{ payload: x.delegation }, "peer_delegation_invalid", 401],
    ];
    x.session.calls = 0;
    for (const [delegation, code, peerStatus] of cases) {
      await expect(Promise.resolve().then(() => own(delegation))).rejects.toMatchObject({ code, status: 500, category: "permanent" });
      // Only the job and session scope differ between the buyer's call and the seller's; the seller's own refusal keeps the peer's status.
      if (code !== "peer_delegation_mismatch" && code !== "peer_delegation_expired") {
        await expect(Promise.resolve().then(async () => (await atSeller(delegation)))).rejects.toMatchObject({ code, status: peerStatus, category: "counterparty" });
      }
    }
    const getter = Object.defineProperty({ payload: x.delegation }, "signature", { enumerable: true, get() { throw new Error("must not run"); } });
    await expect(Promise.resolve().then(() => own(getter))).rejects.toMatchObject({ code: "peer_delegation_invalid", status: 500 });
    expect(x.session.calls).toBe(0);
  });
});

describe("received signature encodings", () => {
  it("accepts hex, with or without 0x, as well as base64url, and producers write canonical base64url", async () => {
    const x = (await world());
    const request = signed(x.request, w.DACS_SELLER_HTTP_DOMAINS.request, x.buyer);
    const discovery = signed(x.discovery, w.DACS_SELLER_HTTP_DOMAINS.discovery, x.seller);
    const hex = (s: string) => Buffer.from(s, "base64url").toString("hex");
    for (const encode of [(s: string) => s, hex, (s: string) => `0x${hex(s)}`, (s: string) => hex(s).toUpperCase()]) {
      expect((await w.openWireEnvelope(header({ ...request, signature: encode(request.signature) }), "request", x.context)).payload).toEqual(x.request);
      const bytes = Buffer.from(canonicalize({ ...discovery, signature: encode(discovery.signature) }));
      expect((await w.verifyEndpointProof(bytes, { readListingEligibility: readFixtureListingEligibility, listing: { seller: x.seller.claim, publicEndpoint: ENDPOINT, listingPin: PIN }, binding: x.binding, local: LOCAL, now: NOW })).ready).toBe(true);
    }
    for (const signature of [`0x0x${hex(request.signature)}`, hex(request.signature).slice(2), `${request.signature}=`]) {
      await refuses(async () => (await w.openWireEnvelope(header({ ...request, signature }), "request", x.context)), "peer_signature_invalid");
    }
    const produced = JSON.parse(Buffer.from(await w.signDiscoveryDocument(x.discovery, x.seller, x.binding, LOCAL)).toString("utf8"));
    expect(produced.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
  });
});

describe("expired session authority at every seller route", () => {
  it.each(w.DACS_SELLER_HTTP_ROUTES.filter((r) => r.auth === "signed"))("$path cannot create an effect under an expired delegation", async (route) => {
    const x = (await world());
    const delegation = signed({ ...x.delegation, notBefore: NOW - 60_000, expiresAt: NOW - 1 }, w.DACS_SELLER_HTTP_DOMAINS.delegation, x.buyer);
    const request = { ...x.request, path: route.path };
    const h = header({ ...signed(request, w.DACS_SELLER_HTTP_DOMAINS.request, x.session), delegation });
    const opened = (await w.openWireEnvelope(h, "request", { ...x.context, requireDelegation: true }));
    const check = async () => (await w.checkWireRequest(opened, { requestJournal: testJournal(), artifacts: agreementFixture(opened), retained: retainedFixture(opened), ...x.context, seller: x.seller.claim, listingPin: PIN, method: "POST", path: route.path, rawBody: Buffer.from("{}"), now: NOW, requireDelegation: true }));
    let effects = 0;
    if (route.effect === "effect") await refuses(async () => { (await check()); effects++; }, "peer_delegation_expired");
    else expect((await check())).toMatchObject({ readbackOnly: true, body: {} });
    expect(effects).toBe(0);
  });
});
