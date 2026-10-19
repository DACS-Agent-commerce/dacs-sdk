import * as fixtureWire from "../../src/wire/index.js";
import { fixtureBinder } from "./authorityFixture.js";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import * as wire from "../../src/wire/index.js";
import { walletSignatureBytes } from "../../src/wire/validate.js";

const bindTp1Fixture = fixtureBinder(fixtureWire);

const NOW = Date.UTC(2026, 9, 18);
const LOCAL = { endpoint: "https://rpc.review.invalid/", transportAuthority: "test", connectionId: "1" };
const PIN = { listingId: "report", version: 1, contentHash: "c".repeat(64) };
function party() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const key = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  return { claim: `did:demos:agent:${key}`, key, sign: (bytes: Uint8Array) => sign(null, Buffer.from(bytes), privateKey) };
}
const header = (value: unknown) => Buffer.from(canonicalize(value)).toString("base64url");
function world(path = "/dacs/v1/payments") {
  const buyer = party(), seller = party(), session = party();
  const binding = bindTp1Fixture({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local: LOCAL });
  const context = { binding, local: LOCAL, purchaseProfile: binding.profile };
  const request: wire.WireRequestPayload = {
    version: "1", kind: "request", method: "POST", path, jobId: "01K7FZ8Q9W3V5T2R1N0M8K6J4H",
    buyer: buyer.claim, seller: seller.claim, bodyHash: sha256Hex("{}"), listingPin: PIN, agreementHash: "a".repeat(64),
    nonce: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYX", expiresAt: NOW + 30_000, profile: binding.profile,
  };
  const signed = (payload: unknown, signer: ReturnType<typeof party>, domain: string) => ({ payload, signature: signer.sign(Buffer.from(domain + canonicalize(payload))).toString("base64url") });
  const open = (payload = request) => wire.openWireEnvelope(header(signed(payload, buyer, wire.DACS_SELLER_HTTP_DOMAINS.request)), "request", context);
  const artifact = { jobId: request.jobId, listingRef: PIN, parties: [{ role: "buyer", primaryClaim: buyer.claim }, { role: "seller", primaryClaim: seller.claim }], terms: { deadline: NOW + 60_000 } };
  const delegated = (payload = request) => {
    const delegation = signed({ version: "1", kind: "seller-session-delegation", buyer: buyer.claim, seller: seller.claim,
      sessionPublicKey: session.key, listingPin: PIN, jobId: request.jobId, notBefore: NOW - 1000, expiresAt: NOW + 60_000,
      profile: binding.profile }, buyer, wire.DACS_SELLER_HTTP_DOMAINS.delegation);
    return wire.openWireEnvelope(header({ ...signed(payload, session, wire.DACS_SELLER_HTTP_DOMAINS.request), delegation }), "request", { ...context, requireDelegation: true });
  };
  /** The buyer-signed (undelegated) request header. */
  const direct = () => header(signed(request, buyer, wire.DACS_SELLER_HTTP_DOMAINS.request));
  const check = { ...context, seller: seller.claim, listingPin: PIN, method: "POST", path, rawBody: Buffer.from("{}"), now: NOW };
  return { buyer, seller, request, open, delegated, direct, artifact, check, context, signed };
}

describe("effect request replay reservations", () => {
  it.each(["/dacs/v1/payments", "/dacs/v1/commitments"])("%s requires a durable reservation and refuses replays across reopen and nonce reuse", (path) => {
    const x = world(path);
    expect(() => wire.checkWireRequest(x.open(), x.check)).toThrowError(expect.objectContaining({ code: "seller_replay_guard_required" }));
    const journal = new Set<string>();
    const reserveRequest = vi.fn(({ key }: { key: string }) => {
      if (journal.has(key)) return false;
      journal.add(key); return true;
    });
    const check = { ...x.check, reserveRequest };
    expect(wire.checkWireRequest(x.open(), check)).toEqual({ body: {}, readbackOnly: false });
    expect(reserveRequest).toHaveBeenCalledWith(expect.objectContaining({ requestHash: wire.wireRequestHash(x.request), expiresAt: x.request.expiresAt }));
    expect(() => wire.checkWireRequest(x.open(), check)).toThrowError(expect.objectContaining({ code: "peer_request_replayed" }));
    // A new validator opening the same request uses the host's same journal.
    expect(() => wire.checkWireRequest(x.open({ ...x.request, agreementHash: "b".repeat(64) }), { ...check, reserveRequest: ({ key }) => !journal.has(key) })).toThrowError(expect.objectContaining({ code: "peer_request_replayed" }));
    expect(wire.checkWireRequest(x.open({ ...x.request, nonce: "FxYVFBMSERAPDg0MCwoJCAcGBQQDAgEA" }), check).readbackOnly).toBe(false);
  });

  it("does not reserve invalid requests or require reservations for read routes", () => {
    const x = world(), reserveRequest = vi.fn(() => true);
    expect(() => wire.checkWireRequest(x.open(), { ...x.check, rawBody: Buffer.from('{"changed":true}'), reserveRequest })).toThrow();
    expect(reserveRequest).not.toHaveBeenCalled();
    const read = world("/dacs/v1/agreements/state");
    expect(wire.checkWireRequest(read.open(), read.check).readbackOnly).toBe(false);
  });

  it("reserves a live delegated effect request once and refuses its replay", () => {
    const x = world(), journal = new Set<string>();
    expect(() => wire.checkWireRequest(x.delegated(), { ...x.check, artifacts: [x.artifact] })).toThrowError(expect.objectContaining({ code: "seller_replay_guard_required" }));
    const reserveRequest = vi.fn(({ key }: { key: string }) => {
      if (journal.has(key)) return false;
      journal.add(key); return true;
    });
    const check = { ...x.check, artifacts: [x.artifact], reserveRequest };
    expect(wire.checkWireRequest(x.delegated(), check)).toEqual({ body: {}, readbackOnly: false });
    expect(reserveRequest).toHaveBeenCalledTimes(1);
    expect(reserveRequest).toHaveBeenCalledWith({
      key: sha256Hex(canonicalize({ buyer: x.buyer.claim, seller: x.seller.claim, profile: x.request.profile, nonce: x.request.nonce })),
      requestHash: wire.wireRequestHash(x.request), expiresAt: x.request.expiresAt,
    });
    expect(() => wire.checkWireRequest(x.delegated(), check)).toThrowError(expect.objectContaining({ code: "peer_request_replayed" }));
    expect(reserveRequest).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, null, 1, "true", Promise.resolve(true)])("a reservation result of %s never grants an effect", (result) => {
    const x = world();
    expect(() => wire.checkWireRequest(x.open(), { ...x.check, reserveRequest: (() => result) as never })).toThrowError(expect.objectContaining({ code: "seller_replay_guard_invalid" }));
  });
});

describe("exchange and delegation scope bindings", () => {
  it.each([
    ["path", { path: "/dacs/v1/payments" }],
    ["method", { method: "GET" }],
  ])("refuses a request signed for another %s before reservation", (_name, change) => {
    const x = world("/dacs/v1/agreements/state"), reserveRequest = vi.fn(() => true);
    expect(wire.checkWireRequest(x.open(), { ...x.check, reserveRequest }).readbackOnly).toBe(false);
    expect(() => wire.checkWireRequest(x.open(), { ...x.check, ...change, reserveRequest })).toThrowError(expect.objectContaining({ code: "peer_request_mismatch" }));
    expect(reserveRequest).not.toHaveBeenCalled();
  });

  // A host may require the delegation at one entry point only: each must refuse a buyer-signed request on its own.
  it("openWireEnvelope alone refuses a buyer-signed request when it requires a delegation", () => {
    const x = world();
    expect(wire.openWireEnvelope(x.direct(), "request", x.context).delegation).toBeNull();
    expect(() => wire.openWireEnvelope(x.direct(), "request", { ...x.context, requireDelegation: true }))
      .toThrowError(expect.objectContaining({ code: "peer_delegation_required", status: 401 }));
  });

  it("checkWireRequest alone refuses a buyer-signed request when it requires a delegation, before reservation", () => {
    const x = world(), reserveRequest = vi.fn(() => true);
    expect(() => wire.checkWireRequest(x.open(), { ...x.check, requireDelegation: true, reserveRequest }))
      .toThrowError(expect.objectContaining({ code: "peer_delegation_required", status: 401 }));
    expect(reserveRequest).not.toHaveBeenCalled();
    // Controls: the same request without the requirement, and a delegated one with it, each reserve once.
    expect(wire.checkWireRequest(x.open(), { ...x.check, reserveRequest }).readbackOnly).toBe(false);
    expect(wire.checkWireRequest(x.delegated(), { ...x.check, requireDelegation: true, artifacts: [x.artifact], reserveRequest }).readbackOnly).toBe(false);
    expect(reserveRequest).toHaveBeenCalledTimes(2);
  });

  it("refuses a delegation another wallet signed, under a request naming the buyer", () => {
    const x = world(), wallet = party(), session = party();
    const delegation = x.signed({ version: "1", kind: "seller-session-delegation", buyer: wallet.claim, seller: x.seller.claim,
      sessionPublicKey: session.key, listingPin: PIN, jobId: x.request.jobId, notBefore: NOW - 1000, expiresAt: NOW + 60_000,
      profile: x.request.profile }, wallet, wire.DACS_SELLER_HTTP_DOMAINS.delegation);
    const signed = header({ ...x.signed(x.request, session, wire.DACS_SELLER_HTTP_DOMAINS.request), delegation });
    expect(() => wire.openWireEnvelope(signed, "request", { ...x.context, requireDelegation: true })).toThrowError(expect.objectContaining({ code: "peer_delegation_mismatch" }));
    expect(() => wire.verifySellerSessionDelegation(delegation, { binding: x.context.binding, local: LOCAL, buyer: x.buyer.claim })).toThrowError(expect.objectContaining({ code: "peer_delegation_mismatch" }));
    expect(wire.verifySellerSessionDelegation(delegation, { binding: x.context.binding, local: LOCAL, buyer: wallet.claim }).buyer).toBe(wallet.claim);
  });
});

describe("delegated Agreement context", () => {
  it.each([[undefined], [[]], [[null]]])("refuses missing Agreement context %j before reserving an effect", (artifacts) => {
    const x = world(), reserveRequest = vi.fn(() => true);
    expect(() => wire.checkWireRequest(x.delegated(), { ...x.check, artifacts, reserveRequest })).toThrowError(expect.objectContaining({ code: "peer_delegation_agreement_required" }));
    expect(reserveRequest).not.toHaveBeenCalled();
  });

  it("binds a delegated request to the host's retained parties and deadline before reservation", () => {
    const x = world(), reserveRequest = vi.fn(() => true), opened = x.delegated();
    expect(() => wire.checkWireRequest(opened, { ...x.check, artifacts: [{ ...x.artifact, terms: { deadline: NOW + 59_999 } }], reserveRequest })).toThrowError(expect.objectContaining({ code: "peer_delegation_deadline" }));
    expect(() => wire.checkWireRequest(opened, { ...x.check, artifacts: [{ ...x.artifact, jobId: "01K7FZ8Q9W3V5T2R1N0M8K6J4J" }], reserveRequest })).toThrowError(expect.objectContaining({ code: "peer_delegation_agreement_mismatch" }));
    expect(reserveRequest).not.toHaveBeenCalled();
    expect(wire.checkWireRequest(opened, { ...x.check, artifacts: [x.artifact], reserveRequest }).readbackOnly).toBe(false);
  });

  it.each([
    ["another buyer", (b: unknown, s: unknown) => [{ role: "buyer", primaryClaim: party().claim }, s]],
    ["another seller", (b: unknown) => [b, { role: "seller", primaryClaim: party().claim }]],
    ["no buyer party", (_b: unknown, s: unknown) => [s]],
    ["no seller party", (b: unknown) => [b]],
    ["the parties' roles swapped", (b: any, s: any) => [{ ...b, role: "seller" }, { ...s, role: "buyer" }]],
  ])("refuses a retained Agreement naming %s before reservation", (_name, parties) => {
    const x = world(), reserveRequest = vi.fn(() => true), [b, s] = x.artifact.parties;
    expect(() => wire.checkWireRequest(x.delegated(), { ...x.check, artifacts: [{ ...x.artifact, parties: parties(b, s) }], reserveRequest }))
      .toThrowError(expect.objectContaining({ code: "peer_delegation_agreement_mismatch" }));
    expect(reserveRequest).not.toHaveBeenCalled();
  });

  it("leaves the agreementHash comparison to the host", () => {
    // The wire binds job, Listing, parties and deadline only (the guide's "Host duty"). Follow-up: a required
    // host-retained {jobId, agreementHash} on effect routes, refused on mismatch before reservation; this case then flips.
    const x = world(), other = { ...x.request, agreementHash: "b".repeat(64), nonce: "FxYVFBMSERAPDg0MCwoJCAcGBQQDAgEA" };
    const opened = x.open(other);
    expect(wire.checkWireRequest(opened, { ...x.check, artifacts: [x.artifact], reserveRequest: () => true }).readbackOnly).toBe(false);
    expect(opened.payload.agreementHash).toBe("b".repeat(64));
  });

  it.each([
    ["seller first", (b: unknown, s: unknown) => [s, b]],
    ["a null entry first", (b: unknown, s: unknown) => [null, b, s]],
  ])("finds each party by role, not by position (%s)", (_name, parties) => {
    const x = world(), [b, s] = x.artifact.parties;
    expect(wire.checkWireRequest(x.delegated(), { ...x.check, artifacts: [{ ...x.artifact, parties: parties(b, s) }], reserveRequest: () => true }).readbackOnly).toBe(false);
  });

  it("refuses a retained Agreement without terms with its own code, before reservation", () => {
    const x = world(), reserveRequest = vi.fn(() => true), { terms: _terms, ...withoutTerms } = x.artifact;
    expect(() => wire.checkWireRequest(x.delegated(), { ...x.check, artifacts: [withoutTerms], reserveRequest }))
      .toThrowError(expect.objectContaining({ code: "peer_delegation_deadline", status: 409 }));
    expect(reserveRequest).not.toHaveBeenCalled();
  });

  it("accepts a delegated request that expires exactly when its delegation does", () => {
    // world()'s delegation expires at NOW + 60 000; a request outliving it is refused (request/delegated-outlives-delegation).
    const x = world(), reserveRequest = vi.fn(() => true), artifacts = [x.artifact];
    expect(wire.checkWireRequest(x.delegated({ ...x.request, expiresAt: NOW + 60_000 }), { ...x.check, artifacts, reserveRequest }).readbackOnly).toBe(false);
    expect(reserveRequest).toHaveBeenCalledTimes(1);
  });
});

describe("body admission refuses JSON that is not an object", () => {
  it.each(["null", "[]", "1", '"text"', "true"])("%s, at the seller, the buyer and the response signer", async (text) => {
    const x = world(), bytes = Buffer.from(text), sign = vi.fn(x.seller.sign);
    expect(() => wire.admitWireRequestBody(bytes)).toThrowError(expect.objectContaining({ code: "bad_request", status: 400 }));
    expect(() => wire.admitWireResponseBody(bytes)).toThrowError(expect.objectContaining({ code: "response_json_rejected", status: 502, detail: "NOT-AN-OBJECT" }));
    await expect(wire.signWireResponse(x.request, 200, text, { ...x.context, signer: { claim: x.seller.claim, sign }, now: NOW }))
      .rejects.toMatchObject({ code: "outgoing_body_rejected", status: 500, detail: "NOT-AN-OBJECT" });
    expect(sign).not.toHaveBeenCalled();
  });

  it("refuses a correctly signed non-object request body before reservation", () => {
    const x = world(), reserveRequest = vi.fn(() => true);
    expect(() => wire.checkWireRequest(x.open({ ...x.request, bodyHash: sha256Hex("[]") }), { ...x.check, rawBody: Buffer.from("[]"), reserveRequest }))
      .toThrowError(expect.objectContaining({ code: "bad_request", status: 400 }));
    expect(reserveRequest).not.toHaveBeenCalled();
  });

  it("names an outgoing admission failure as the signer's own, with zero signatures", async () => {
    const x = world(), sign = vi.fn(x.seller.sign), context = { ...x.context, signer: { claim: x.seller.claim, sign }, now: NOW };
    await expect(wire.signWireResponse(x.request, 200, '{"a":1,"a":1}', context))
      .rejects.toMatchObject({ code: "outgoing_body_rejected", status: 500, detail: "DUPLICATE-MEMBER" });
    expect(sign).not.toHaveBeenCalled();
    expect(typeof await wire.signWireResponse(x.request, 200, "{}", context)).toBe("string");
    expect(sign).toHaveBeenCalledTimes(1);
  });
});

it("the receipt authentication hash is stable across accepted signature and JSON encodings", () => {
  const x = world();
  const answer = { ...x.request, kind: "response", requestHash: wire.wireRequestHash(x.request), status: 200 };
  const envelope = x.signed(answer, x.seller, wire.DACS_SELLER_HTTP_DOMAINS.response);
  const hex = Buffer.from(envelope.signature, "base64url").toString("hex");
  const receipts = [];
  for (const signature of [envelope.signature, hex, hex.toUpperCase(), `0x${hex}`]) {
    for (const text of [canonicalize({ ...envelope, signature }), JSON.stringify({ signature, payload: answer }, null, 2)]) {
      receipts.push(wire.verifyWireResponse(x.request, { ...x.context, header: Buffer.from(text).toString("base64url"), body: Buffer.from("{}"), status: 200, now: NOW }).authenticationHash);
    }
  }
  expect(new Set(receipts).size).toBe(1);
  expect(receipts[0]).toBe(sha256Hex(header(envelope)));
});

it("wallet base64url signatures round-trip after wallet prefix removal", () => {
  const signature = party().sign(Buffer.from("wallet encoding")).toString("base64url");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const alias = signature.slice(0, -1) + alphabet[alphabet.indexOf(signature.at(-1)!) + 1];
  expect(Buffer.from(alias, "base64url")).toEqual(Buffer.from(signature, "base64url"));
  expect(walletSignatureBytes(`0x${signature}`)).toEqual(Buffer.from(signature, "base64url"));
  expect(() => walletSignatureBytes(`0x${alias}`)).toThrowError(expect.objectContaining({ code: "peer_delegation_signature_invalid" }));
});
