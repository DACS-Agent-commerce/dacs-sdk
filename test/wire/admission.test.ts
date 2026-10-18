import { readFixtureListingEligibility } from "./listingEligibilityFixture.js";
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical/index.js";
import * as w from "../../src/wire/index.js";
import { isListingPin } from "../../src/wire/validate.js";

const NOW = Date.UTC(2026, 9, 18);
const JOB = "01K7FZ8Q9W3V5T2R1N0M8K6J4H";
const PIN = { listingId: "report", version: 1, contentHash: "c".repeat(64) };
const ENDPOINT = "https://seller.admission.invalid";
const LOCAL = { endpoint: "https://rpc.admission.invalid/", transportAuthority: "test", connectionId: "1" };
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
function party() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  return { raw, claim: `did:demos:agent:${raw}`, calls: 0, sign(bytes: Uint8Array) { this.calls++; return sign(null, Buffer.from(bytes), privateKey); } };
}
function world() {
  const buyer = party(), seller = party(), session = party();
  const binding = w.bindTp1Profile({ record: w.TP1_APPROVED_IDENTITY_RECORD, local: LOCAL });
  const request: w.WireRequestPayload = {
    version: "1", kind: "request", method: "POST", path: "/dacs/v1/commitments", bodyHash: sha("{}"), jobId: JOB,
    buyer: buyer.claim, seller: seller.claim, listingPin: PIN, agreementHash: "a".repeat(64), nonce: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYX", expiresAt: NOW + 30_000, profile: binding.profile,
  };
  const delegation: w.SellerSessionDelegationPayload = {
    version: "1", kind: "seller-session-delegation", buyer: buyer.claim, seller: seller.claim, sessionPublicKey: session.raw,
    listingPin: PIN, jobId: JOB, notBefore: NOW - 1000, expiresAt: NOW + 60_000, profile: binding.profile,
  };
  const discovery: w.DiscoveryPayload = {
    format: "dacs-seller-discovery/v1", profile: binding.profile, seller: seller.claim, publicEndpoint: ENDPOINT,
    transport: ["dacs-seller-http/v1"], listings: [PIN], capabilities: w.TP1_CAPABILITIES, ready: true, issuedAt: NOW, expiresAt: NOW + 60_000,
  };
  const context = { binding, local: LOCAL, purchaseProfile: binding.profile };
  const input = { signer: buyer, binding, local: LOCAL, seller: seller.claim, jobId: JOB, path: request.path, text: "{}", job: { listingPin: PIN, agreementHash: request.agreementHash, profile: binding.profile }, now: NOW, publicEndpoint: ENDPOINT };
  return { buyer, seller, session, binding, request, delegation, discovery, context, input };
}
// Independent wire encoders intentionally do not call the SDK's shape/signing helpers.
function signed<T>(payload: T, domain: string, signer: w.WireSigner) {
  const signature = Buffer.from(signer.sign(Buffer.from(domain + canonicalize(payload))) as Uint8Array).toString("base64url");
  return { payload, signature };
}
const header = (v: unknown) => Buffer.from(canonicalize(v)).toString("base64url");
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

describe("wire canonical job-ID admission", () => {
  it.each(invalidIds)("rejects %s before signing, hashing or seller effects", async (_name, id) => {
    const x = world();
    const responseHeader = await w.signWireResponse(x.request, 200, "{}", { ...x.context, signer: x.seller, now: NOW });
    const request = replaceId(x.request, id), delegation = replaceId(x.delegation, id);
    const requestHeader = header(signed(request, w.DACS_SELLER_HTTP_DOMAINS.request, x.buyer));
    const delegated = signed(delegation, w.DACS_SELLER_HTTP_DOMAINS.delegation, x.buyer);
    x.buyer.calls = x.seller.calls = 0;
    let effects = 0;
    await refuses(() => { w.openWireEnvelope(requestHeader, "request", x.context); effects++; }, "peer_envelope_invalid");
    await refuses(() => w.verifySellerSessionDelegation(delegated, { binding: x.binding, local: LOCAL }), "peer_delegation_invalid");
    await refuses(() => w.signSellerSessionDelegation(delegation, x.buyer, x.binding, LOCAL), "peer_delegation_invalid");
    await refuses(() => w.sellerSessionDelegationSigningBytes(delegation, x.binding, LOCAL), "peer_delegation_invalid");
    await refuses(() => w.wireRequestHash(request), "peer_envelope_invalid");
    await refuses(() => w.wireEnvelopeSigningBytes(request), "peer_envelope_invalid");
    await refuses(() => w.signWireEnvelope(request, { ...x.context, signer: x.buyer }), "peer_envelope_invalid");
    await refuses(() => w.signWireRequest({ ...x.input, jobId: id } as unknown as w.WireRequestInput), "peer_envelope_invalid");
    await refuses(() => w.signWireResponse(request, 200, "{}", { ...x.context, signer: x.seller, now: NOW }), "peer_envelope_invalid", 500);
    await refuses(() => w.verifyWireResponse(request, { ...x.context, header: responseHeader, status: 200, body: Buffer.from("{}"), now: NOW }), "peer_envelope_invalid", 500);
    expect(effects + x.buyer.calls + x.seller.calls).toBe(0);
  });
  it.each(["kind", "version", "bodyHash", "seller", "nonce", "listingPin"])("response boundaries refuse malformed retained %s before signing or reading the answer", async (field) => {
    const x = world();
    const responseHeader = await w.signWireResponse(x.request, 200, "{}", { ...x.context, signer: x.seller, now: NOW });
    expect(w.verifyWireResponse(x.request, { ...x.context, header: responseHeader, status: 200, body: Buffer.from("{}"), now: NOW }).principal).toBe(x.seller.claim);
    x.seller.calls = 0;
    const absent = { ...x.request }; delete (absent as any)[field];
    for (const request of [{ ...x.request, [field]: field === "kind" ? "response" : "wrong" }, absent]) {
      await refuses(() => w.signWireResponse(request as w.WireRequestPayload, 200, "{}", { ...x.context, signer: x.seller, now: NOW }), "peer_envelope_invalid", 500);
      await refuses(() => w.verifyWireResponse(request as w.WireRequestPayload, { ...x.context, header: responseHeader, status: 200, body: Buffer.from("{}"), now: NOW }), "peer_envelope_invalid", 500);
    }
    expect(x.seller.calls).toBe(0);
  });
  it.each(["kind", "version", "bodyHash", "seller", "nonce", "listingPin"])("request hash rejects invalid %s", async (field) => {
    const x = world();
    await refuses(() => w.wireRequestHash({ ...x.request, [field]: "wrong" } as never), "peer_envelope_invalid");
    const copy = { ...x.request }; delete (copy as any)[field];
    await refuses(() => w.wireRequestHash(copy), "peer_envelope_invalid");
  });
});

describe("wire Listing pins and producer bounds", () => {
  it.each(["x".repeat(129), "漢", "with space", "slash/id", "query?id", "frag#id", "percent%20", "line\n", ""])("refuses non-Standard Listing ID %j", async (listingId) => {
    const x = world(), pin = { ...PIN, listingId };
    expect(isListingPin(pin)).toBe(false);
    const requestHeader = header(signed({ ...x.request, listingPin: pin }, w.DACS_SELLER_HTTP_DOMAINS.request, x.buyer));
    const delegated = signed({ ...x.delegation, listingPin: pin }, w.DACS_SELLER_HTTP_DOMAINS.delegation, x.buyer);
    const discoveryBytes = Buffer.from(canonicalize(signed({ ...x.discovery, listings: [pin] }, w.DACS_SELLER_HTTP_DOMAINS.discovery, x.seller)));
    x.buyer.calls = 0; x.seller.calls = 0;
    await refuses(() => w.openWireEnvelope(requestHeader, "request", x.context), "peer_envelope_invalid");
    await refuses(() => w.verifySellerSessionDelegation(delegated, { binding: x.binding, local: LOCAL }), "peer_delegation_invalid");
    await refuses(() => w.verifyEndpointProof(discoveryBytes, { readListingEligibility: readFixtureListingEligibility, listing: { seller: x.seller.claim, publicEndpoint: ENDPOINT, listingPin: PIN }, binding: x.binding, local: LOCAL, now: NOW }), "discovery_invalid");
    await refuses(() => w.signWireEnvelope({ ...x.request, listingPin: pin }, { ...x.context, signer: x.buyer }), "peer_envelope_invalid");
    await refuses(() => w.signSellerSessionDelegation({ ...x.delegation, listingPin: pin }, x.buyer, x.binding, LOCAL), "peer_delegation_invalid");
    await refuses(() => w.signDiscoveryDocument({ ...x.discovery, listings: [pin] }, x.seller, x.binding, LOCAL), "discovery_invalid");
    expect(x.buyer.calls + x.seller.calls).toBe(0);
  });
  it("accepts 128 URL-safe ASCII characters at producer and receiver boundaries", async () => {
    const x = world(), pin = { ...PIN, listingId: "A._~-0123".repeat(16).slice(0, 128) };
    expect(isListingPin(pin)).toBe(true);
    const request = { ...x.request, listingPin: pin };
    const bytes = await w.signDiscoveryDocument({ ...x.discovery, listings: [pin] }, x.seller, x.binding, LOCAL);
    const endpointProof = w.verifyEndpointProof(bytes, { readListingEligibility: readFixtureListingEligibility, listing: { seller: x.seller.claim, publicEndpoint: ENDPOINT, listingPin: pin }, binding: x.binding, local: LOCAL, now: NOW });
    const h = await w.signWireEnvelope(request, { ...x.context, signer: x.buyer, endpointProof, publicEndpoint: ENDPOINT, now: NOW });
    expect(w.openWireEnvelope(h, "request", x.context).payload.listingPin).toEqual(pin);
    expect(endpointProof.ready).toBe(true);
  });
  it("bounds the entire encoded header and discovery document before calling signers", async () => {
    const x = world();
    const oversized = { payload: x.delegation, signature: "A".repeat(4000) };
    await refuses(() => w.signWireEnvelope(x.request, { ...x.context, signer: x.buyer }, oversized), "peer_envelope_too_large");
    // Each pin and the endpoint are valid individually; the whole document exceeds 16 KiB in UTF-8.
    const discovery = { ...x.discovery, publicEndpoint: ENDPOINT + "/" + "\u0001".repeat(2000), listings: Array.from({ length: 32 }, (_, i) => ({ ...PIN, listingId: "x".repeat(126) + String(i).padStart(2, "0") })) };
    await refuses(() => w.signDiscoveryDocument(discovery, x.seller, x.binding, LOCAL), "discovery_too_large");
    expect(x.buyer.calls + x.seller.calls).toBe(0);
  });
});

describe("endpoint proof purchase gate", () => {
  async function proof(x: ReturnType<typeof world>, patch: Partial<w.DiscoveryPayload> = {}) {
    const payload = { ...x.discovery, ...patch };
    const bytes = await w.signDiscoveryDocument(payload, x.seller, x.binding, LOCAL);
    return { bytes, proof: w.verifyEndpointProof(bytes, { readListingEligibility: readFixtureListingEligibility, listing: { seller: x.seller.claim, publicEndpoint: payload.publicEndpoint, listingPin: PIN }, binding: x.binding, local: LOCAL, now: NOW }) };
  }
  it("requires a verified proof, bound to seller, pin, exact endpoint, profile and validity", async () => {
    const x = world(), { proof: p } = await proof(x);
    for (const endpointProof of [undefined, null, {}, { ...p }, structuredClone(p)]) {
      await refuses(() => w.signWireRequest({ ...x.input, endpointProof } as w.WireRequestInput), "endpoint_proof_required");
      await refuses(() => w.signWireEnvelope(x.request, { ...x.context, signer: x.buyer, endpointProof: endpointProof as w.EndpointProof, publicEndpoint: ENDPOINT, now: NOW }), "endpoint_proof_required");
    }
    for (const patch of [{ seller: party().claim }, { publicEndpoint: ENDPOINT + "/" }, { job: { ...x.input.job, listingPin: { ...PIN, version: 2 } } }]) {
      await refuses(() => w.signWireRequest({ ...x.input, endpointProof: p, ...patch }), "endpoint_proof_mismatch");
    }
    const otherBinding = w.bindTp1Profile({ record: w.TP1_APPROVED_IDENTITY_RECORD, local: LOCAL });
    await refuses(() => w.signWireRequest({ ...x.input, endpointProof: p, binding: otherBinding }), "endpoint_proof_required");
    await refuses(() => w.signWireRequest({ ...x.input, endpointProof: p, now: NOW + 60_000 }), "discovery_expired");
    const notReady = await proof(x, { ready: false });
    await refuses(() => w.signWireRequest({ ...x.input, endpointProof: notReady.proof }), "seller_not_ready");
    expect(x.buyer.calls).toBe(0);
    expect(Object.isFrozen(p) && Object.isFrozen(p.payload)).toBe(true);
    expect((await w.signWireRequest({ ...x.input, endpointProof: p })).payload.seller).toBe(x.seller.claim);
    expect(x.buyer.calls).toBe(1);
    await w.signWireEnvelope(x.request, { ...x.context, signer: x.buyer, endpointProof: p, publicEndpoint: ENDPOINT, now: NOW });
    expect(x.buyer.calls).toBe(2);
  });
  it("preserves the verified Listing endpoint bytes: NFC never matches NFD", async () => {
    const x = world(), nfc = ENDPOINT + "/caf\u00e9", nfd = ENDPOINT + "/cafe\u0301";
    const { bytes } = await proof(x, { publicEndpoint: nfc });
    await refuses(() => w.verifyEndpointProof(bytes, { readListingEligibility: readFixtureListingEligibility, listing: { seller: x.seller.claim, publicEndpoint: nfd, listingPin: PIN }, binding: x.binding, local: LOCAL, now: NOW }), "discovery_endpoint_mismatch");
    const getter = Object.defineProperty({ seller: x.seller.claim, listingPin: PIN }, "publicEndpoint", { enumerable: true, get() { throw new Error("must not run"); } });
    await refuses(() => w.verifyEndpointProof(bytes, { readListingEligibility: readFixtureListingEligibility, listing: getter as never, binding: x.binding, local: LOCAL, now: NOW }), "wire_input_invalid");
  });
  it("refuses uppercase DID claims at each receiver without rewriting signed bytes", async () => {
    const x = world();
    for (const role of ["buyer", "seller"] as const) {
      const request = { ...x.request, [role]: x.request[role].replace(/^did:/, "DID:") };
      await refuses(() => w.openWireEnvelope(header(signed(request, w.DACS_SELLER_HTTP_DOMAINS.request, x.buyer)), "request", x.context), "peer_envelope_invalid");
      const delegation = { ...x.delegation, [role]: x.delegation[role].replace(/^did:/, "DID:") };
      await refuses(() => w.verifySellerSessionDelegation(signed(delegation, w.DACS_SELLER_HTTP_DOMAINS.delegation, x.buyer), { binding: x.binding, local: LOCAL }), "peer_delegation_invalid");
    }
    const document = signed({ ...x.discovery, seller: x.seller.claim.replace(/^did:/, "DID:") }, w.DACS_SELLER_HTTP_DOMAINS.discovery, x.seller);
    await refuses(() => w.verifyEndpointProof(Buffer.from(canonicalize(document)), { readListingEligibility: readFixtureListingEligibility, listing: { seller: x.seller.claim, publicEndpoint: ENDPOINT, listingPin: PIN }, binding: x.binding, local: LOCAL, now: NOW }), "discovery_invalid");
    const { bytes } = await proof(x);
    await refuses(() => w.verifyEndpointProof(bytes, { readListingEligibility: readFixtureListingEligibility, listing: { seller: x.seller.claim.replace(/^did:/, "DID:"), publicEndpoint: ENDPOINT, listingPin: PIN }, binding: x.binding, local: LOCAL, now: NOW }), "wire_input_invalid");
  });
  it("declares canonical lowercase DID-only admission and refuses uppercase wire claims before signing", async () => {
    const x = world();
    for (const role of ["buyer", "seller"] as const) {
      await refuses(() => w.signWireEnvelope({ ...x.request, [role]: x.request[role].replace(/^did:/, "DID:") }, { ...x.context, signer: x.buyer }), "peer_envelope_invalid");
    }
    expect(x.buyer.calls).toBe(0);
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
  const verifyProof = (x: ReturnType<typeof world>, bytes: Uint8Array) =>
    w.verifyEndpointProof(bytes, { readListingEligibility: readFixtureListingEligibility, listing: { ...listing, seller: x.seller.claim }, binding: x.binding, local: LOCAL, now: NOW });
  const answer = (x: ReturnType<typeof world>) => ({ ...x.request, kind: "response", bodyHash: sha("{}"), expiresAt: NOW + 30_000, requestHash: w.wireRequestHash(x.request), status: 200 });

  it("accepts each control: delegation, delegated request, discovery, request and response", async () => {
    const x = world();
    const delegation = signed(x.delegation, D.delegation, x.buyer);
    expect(w.verifySellerSessionDelegation(delegation, { binding: x.binding, local: LOCAL }).kind).toBe("seller-session-delegation");
    expect(w.openWireEnvelope(header({ ...signed(x.request, D.request, x.session), delegation }), "request", { ...x.context, requireDelegation: true }).delegation).toEqual(delegation);
    const endpointProof = verifyProof(x, Buffer.from(canonicalize(signed(x.discovery, D.discovery, x.seller))));
    x.session.calls = 0;
    expect((await w.signWireRequest({ ...x.input, signer: x.session, delegation, endpointProof })).payload.buyer).toBe(x.buyer.claim);
    expect(x.session.calls).toBe(1);
    expect(w.openWireEnvelope(header(signed(x.request, D.request, x.buyer)), "request", x.context).payload.kind).toBe("request");
    expect(w.verifyWireResponse(x.request, { ...x.context, header: header(signed(answer(x), D.response, x.seller)), status: 200, body: Buffer.from("{}"), now: NOW }).principal).toBe(x.seller.claim);
  });

  it.each<[string, Record<string, unknown>]>([
    ["version 2", { version: "2" }], ["numeric version 1", { version: 1 }], ["empty version", { version: "" }], ["null version", { version: null }],
    ["version with a trailing space", { version: "1 " }], ["another kind", { kind: "seller-session-delegation/v2" }], ["request kind", { kind: "request" }],
    ["mixed-case kind", { kind: "Seller-Session-Delegation" }], ["array kind", { kind: ["seller-session-delegation"] }],
  ])("refuses a correctly signed delegation with %s at every receiver and before every signer", async (_name, patch) => {
    const x = world();
    const payload = { ...x.delegation, ...patch } as w.SellerSessionDelegationPayload;
    const delegation = signed(payload, D.delegation, x.buyer);
    expect(signedBy(delegation, D.delegation, x.buyer.claim)).toBe(true);
    const delegatedHeader = header({ ...signed(x.request, D.request, x.session), delegation });
    const endpointProof = verifyProof(x, Buffer.from(canonicalize(signed(x.discovery, D.discovery, x.seller))));
    x.buyer.calls = x.session.calls = x.seller.calls = 0;
    let effects = 0;
    await refuses(() => w.verifySellerSessionDelegation(delegation, { binding: x.binding, local: LOCAL }), "peer_delegation_invalid");
    await refuses(() => { w.openWireEnvelope(delegatedHeader, "request", { ...x.context, requireDelegation: true }); effects++; }, "peer_delegation_invalid");
    await refuses(() => w.signWireRequest({ ...x.input, signer: x.session, delegation, endpointProof }), "peer_delegation_invalid");
    await refuses(() => w.signSellerSessionDelegation(payload, x.buyer, x.binding, LOCAL), "peer_delegation_invalid");
    await refuses(() => w.sellerSessionDelegationSigningBytes(payload, x.binding, LOCAL), "peer_delegation_invalid");
    expect(effects + x.buyer.calls + x.session.calls + x.seller.calls).toBe(0);
  });

  it.each<[string, Record<string, unknown>]>([
    ["format v2", { format: "dacs-seller-discovery/v2" }], ["upper-case format", { format: "DACS-SELLER-DISCOVERY/V1" }], ["numeric format", { format: 1 }],
    ["null format", { format: null }], ["transport v2", { transport: ["dacs-seller-http/v2"] }], ["repeated transport", { transport: ["dacs-seller-http/v1", "dacs-seller-http/v1"] }],
    ["an extra transport", { transport: ["dacs-seller-http/v1", "dacs-seller-http/v2"] }], ["no transport", { transport: [] }],
    ["string transport", { transport: "dacs-seller-http/v1" }], ["array-like transport object", { transport: { 0: "dacs-seller-http/v1", length: 1 } }],
    ["nested transport", { transport: [["dacs-seller-http/v1"]] }],
  ])("refuses a correctly signed discovery document with %s before any purchase signature, and before its signer", async (_name, patch) => {
    const x = world();
    const payload = { ...x.discovery, ...patch } as w.DiscoveryPayload;
    const document = signed(payload, D.discovery, x.seller);
    expect(signedBy(document, D.discovery, x.seller.claim)).toBe(true);
    x.seller.calls = 0;
    await refuses(async () => w.signWireRequest({ ...x.input, endpointProof: verifyProof(x, Buffer.from(canonicalize(document))) }), "discovery_invalid", 502);
    await refuses(() => w.signDiscoveryDocument(payload, x.seller, x.binding, LOCAL), "discovery_invalid", 502);
    await refuses(() => w.discoverySigningBytes(payload), "discovery_invalid", 502);
    expect(x.buyer.calls + x.seller.calls).toBe(0);
  });

  it.each<[string, Record<string, unknown>]>([
    ["version 2", { version: "2" }], ["numeric version 1", { version: 1 }], ["the other kind", { kind: "response" }], ["method GET", { method: "GET" }],
  ])("refuses a correctly signed request with %s at the seller and before the buyer's signer", async (_name, patch) => {
    const x = world();
    const request = { ...x.request, ...patch } as unknown as w.WireRequestPayload;
    const envelope = signed(request, D.request, x.buyer);
    expect(signedBy(envelope, D.request, x.buyer.claim)).toBe(true);
    x.buyer.calls = 0;
    let effects = 0;
    await refuses(() => { w.openWireEnvelope(header(envelope), "request", x.context); effects++; }, "peer_envelope_invalid");
    await refuses(() => w.signWireEnvelope(request, { ...x.context, signer: x.buyer }), "peer_envelope_invalid");
    expect(effects + x.buyer.calls).toBe(0);
  });

  it.each<[string, Record<string, unknown>]>([
    ["version 2", { version: "2" }], ["numeric version 1", { version: 1 }], ["the other kind", { kind: "request" }], ["method GET", { method: "GET" }],
  ])("refuses a correctly signed response with %s at the buyer and before the seller's signer", async (_name, patch) => {
    const x = world();
    const response = { ...answer(x), ...patch };
    const envelope = signed(response, D.response, x.seller);
    expect(signedBy(envelope, D.response, x.seller.claim)).toBe(true);
    x.seller.calls = 0;
    await refuses(() => w.verifyWireResponse(x.request, { ...x.context, header: header(envelope), status: 200, body: Buffer.from("{}"), now: NOW }), "peer_envelope_invalid");
    await refuses(() => w.signWireEnvelope(response as unknown as w.WirePayload, { ...x.context, signer: x.seller }), "peer_envelope_invalid");
    expect(x.seller.calls).toBe(0);
  });
});

describe("request and response byte budgets and the discovery Listing count", () => {
  const { maxRequestBodyBytes, maxResponseBodyBytes } = w.DACS_SELLER_HTTP_LIMITS;
  /** A JSON object of exactly n UTF-8 bytes. */
  const body = (n: number) => `{"p":"${"x".repeat(n - 8)}"}`;
  const proofFor = async (x: ReturnType<typeof world>) => w.verifyEndpointProof(await w.signDiscoveryDocument(x.discovery, x.seller, x.binding, LOCAL), { readListingEligibility: readFixtureListingEligibility, listing: { seller: x.seller.claim, publicEndpoint: ENDPOINT, listingPin: PIN }, binding: x.binding, local: LOCAL, now: NOW });

  it("signs and admits a 64 KiB request body and refuses one more byte at the buyer's signer and at the seller", async () => {
    const x = world(), endpointProof = await proofFor(x);
    expect(Buffer.byteLength(body(maxRequestBodyBytes))).toBe(65_536);
    x.buyer.calls = 0;
    await w.signWireRequest({ ...x.input, text: body(maxRequestBodyBytes), endpointProof });
    expect(x.buyer.calls).toBe(1);
    await refuses(() => w.signWireRequest({ ...x.input, text: body(maxRequestBodyBytes + 1), endpointProof }), "body_too_large", 413);
    expect(x.buyer.calls).toBe(1);
    let effects = 0;
    for (const n of [maxRequestBodyBytes, maxRequestBodyBytes + 1]) {
      const text = body(n);
      const opened = w.openWireEnvelope(header(signed({ ...x.request, bodyHash: sha(text) }, w.DACS_SELLER_HTTP_DOMAINS.request, x.buyer)), "request", x.context);
      const check = () => w.checkWireRequest(opened, { ...x.context, seller: x.seller.claim, listingPin: PIN, method: "POST", path: x.request.path, rawBody: Buffer.from(text), now: NOW });
      if (n === maxRequestBodyBytes) expect(Object.keys(check().body)).toEqual(["p"]);
      else await expect(Promise.resolve().then(() => { check(); effects++; })).rejects.toMatchObject({ code: "bad_json", status: 400, detail: "BYTE-LIMIT-EXCEEDED" });
    }
    expect(effects).toBe(0);
  });

  it("signs and admits a 512 KiB response body and refuses one more byte at the seller's signer and at the buyer", async () => {
    const x = world();
    expect(Buffer.byteLength(body(maxResponseBodyBytes))).toBe(524_288);
    const ctx = { ...x.context, signer: x.seller, now: NOW };
    const exact = await w.signWireResponse(x.request, 200, body(maxResponseBodyBytes), ctx);
    expect(x.seller.calls).toBe(1);
    await refuses(() => w.signWireResponse(x.request, 200, body(maxResponseBodyBytes + 1), ctx), "peer_response_too_large", 503);
    expect(x.seller.calls).toBe(1);
    const received = (h: string, text: string) => ({ ...x.context, header: h, status: 200, body: Buffer.from(text), now: NOW });
    expect(w.verifyWireResponse(x.request, received(exact, body(maxResponseBodyBytes))).body).toEqual({ p: "x".repeat(maxResponseBodyBytes - 8) });
    // One byte over, correctly signed outside the SDK's signer: the buyer refuses it before reading the answer.
    const over = body(maxResponseBodyBytes + 1);
    const answer = { ...x.request, kind: "response", bodyHash: sha(over), expiresAt: NOW + 30_000, requestHash: w.wireRequestHash(x.request), status: 200 };
    await expect(Promise.resolve().then(() => w.verifyWireResponse(x.request, received(header(signed(answer, w.DACS_SELLER_HTTP_DOMAINS.response, x.seller)), over))))
      .rejects.toMatchObject({ code: "response_json_rejected", status: 502, detail: "BYTE-LIMIT-EXCEEDED" });
  });

  it.each([[0, "refused"], [1, "accepted"], [32, "accepted"], [33, "refused"]] as const)("a discovery document listing %i pins is %s at its signer and at the buyer", async (count, outcome) => {
    const x = world(), accepted = outcome === "accepted";
    const listings = Array.from({ length: count }, (_, i) => (i === 0 ? PIN : { ...PIN, listingId: `report-${i}` }));
    const payload = { ...x.discovery, listings };
    const bytes = Buffer.from(canonicalize(signed(payload, w.DACS_SELLER_HTTP_DOMAINS.discovery, x.seller)));
    x.seller.calls = 0;
    const verifyIt = () => w.verifyEndpointProof(bytes, { readListingEligibility: readFixtureListingEligibility, listing: { seller: x.seller.claim, publicEndpoint: ENDPOINT, listingPin: PIN }, binding: x.binding, local: LOCAL, now: NOW });
    if (accepted) {
      expect(verifyIt().payload.listings).toHaveLength(count);
      await w.signDiscoveryDocument(payload, x.seller, x.binding, LOCAL);
      expect(x.seller.calls).toBe(1);
    } else {
      await refuses(verifyIt, "discovery_invalid", 502);
      await refuses(() => w.signDiscoveryDocument(payload, x.seller, x.binding, LOCAL), "discovery_invalid", 502);
      expect(x.seller.calls).toBe(0);
    }
  });
});

describe("received signature encodings", () => {
  it("accepts hex, with or without 0x, as well as base64url, and producers write canonical base64url", async () => {
    const x = world();
    const request = signed(x.request, w.DACS_SELLER_HTTP_DOMAINS.request, x.buyer);
    const discovery = signed(x.discovery, w.DACS_SELLER_HTTP_DOMAINS.discovery, x.seller);
    const hex = (s: string) => Buffer.from(s, "base64url").toString("hex");
    for (const encode of [(s: string) => s, hex, (s: string) => `0x${hex(s)}`, (s: string) => hex(s).toUpperCase()]) {
      expect(w.openWireEnvelope(header({ ...request, signature: encode(request.signature) }), "request", x.context).payload).toEqual(x.request);
      const bytes = Buffer.from(canonicalize({ ...discovery, signature: encode(discovery.signature) }));
      expect(w.verifyEndpointProof(bytes, { readListingEligibility: readFixtureListingEligibility, listing: { seller: x.seller.claim, publicEndpoint: ENDPOINT, listingPin: PIN }, binding: x.binding, local: LOCAL, now: NOW }).ready).toBe(true);
    }
    for (const signature of [`0x0x${hex(request.signature)}`, hex(request.signature).slice(2), `${request.signature}=`]) {
      await refuses(() => w.openWireEnvelope(header({ ...request, signature }), "request", x.context), "peer_signature_invalid");
    }
    const produced = JSON.parse(Buffer.from(await w.signDiscoveryDocument(x.discovery, x.seller, x.binding, LOCAL)).toString("utf8"));
    expect(produced.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
  });
});

describe("expired session authority at every seller route", () => {
  it.each(w.DACS_SELLER_HTTP_ROUTES.filter((r) => r.auth === "signed"))("$path cannot create an effect under an expired delegation", async (route) => {
    const x = world();
    const delegation = signed({ ...x.delegation, notBefore: NOW - 60_000, expiresAt: NOW - 1 }, w.DACS_SELLER_HTTP_DOMAINS.delegation, x.buyer);
    const request = { ...x.request, path: route.path };
    const h = header({ ...signed(request, w.DACS_SELLER_HTTP_DOMAINS.request, x.session), delegation });
    const opened = w.openWireEnvelope(h, "request", { ...x.context, requireDelegation: true });
    const check = () => w.checkWireRequest(opened, { ...x.context, seller: x.seller.claim, listingPin: PIN, method: "POST", path: route.path, rawBody: Buffer.from("{}"), now: NOW, requireDelegation: true });
    let effects = 0;
    if (route.effect === "effect") await refuses(() => { check(); effects++; }, "peer_delegation_expired");
    else expect(check()).toMatchObject({ readbackOnly: true, body: {} });
    expect(effects).toBe(0);
  });
});
