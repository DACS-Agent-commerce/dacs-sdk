import * as fixtureWire from "../../src/wire/index.js";
import { fixtureBinder } from "./authorityFixture.js";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
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
/** Well-formed claims for retained records that are refused before their parties are compared. */
const CLAIM_A = `did:demos:agent:${"1".repeat(64)}`, CLAIM_B = `did:demos:agent:${"2".repeat(64)}`;
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
  /** What the seller host retained for the job: its own record, not read from the request. */
  const retained = { jobId: "01K7FZ8Q9W3V5T2R1N0M8K6J4H", agreementHash: "a".repeat(64), buyer: buyer.claim, seller: seller.claim };
  const check = { ...context, seller: seller.claim, listingPin: PIN, method: "POST", path, rawBody: Buffer.from("{}"), now: NOW, retained };
  return { buyer, seller, request, open, delegated, direct, artifact, check, context, signed, retained };
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
    // A new validator opening another request under the same nonce uses the host's same journal.
    expect(() => wire.checkWireRequest(x.open({ ...x.request, expiresAt: NOW + 20_000 }), { ...check, reserveRequest: ({ key }) => !journal.has(key) })).toThrowError(expect.objectContaining({ code: "peer_request_replayed" }));
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
      retainUntil: x.request.expiresAt + wire.DACS_SELLER_HTTP_LIMITS.maxClockSkewMs,
    });
    expect(() => wire.checkWireRequest(x.delegated(), check)).toThrowError(expect.objectContaining({ code: "peer_request_replayed" }));
    expect(reserveRequest).toHaveBeenCalledTimes(2);
  });

  it("names the host journal's restart and concurrent-worker tests as the gate for any effect", () => {
    // The wire has no journal; its effect verdict counts only once the composed host's journal is qualified.
    const text = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
    const gate = JSON.parse(text("conformance/tp1-register.json")).qualification
      .filter((q: { subject: string }) => q.subject.startsWith("consumer: seller host request reservation journal"));
    expect(gate).toHaveLength(1);
    expect(gate[0].result).toBe("not checked");
    expect(gate[0].subject).toContain("authorizes no effect until restart and concurrent-worker tests pass");
    const guide = text("docs/dacs-seller-http-v1.md").replace(/\s+/g, " ");
    expect(guide).toContain("authorizes no effect until the composed host's journal passes restart and concurrent-worker tests");
    expect(guide).not.toContain("Host duty");
  });

  // The seller refuses a request from the instant now === expiresAt, so a journal that drops each key at its
  // expiresAt (TTL semantics) never sees the replay that would otherwise land in that millisecond.
  it.each(["direct", "delegated"] as const)("a %s replay at exactly expiresAt is expired, not re-reserved, under a journal that drops keys at expiresAt", (mode) => {
    const x = world(), journal = new Map<string, number>();
    let clock = NOW;
    const reserveRequest = vi.fn(({ key, expiresAt }: wire.WireRequestReservation) => {
      for (const [held, until] of journal) if (until <= clock) journal.delete(held);
      if (journal.has(key)) return false;
      journal.set(key, expiresAt); return true;
    });
    const at = (now: number) => ({ ...x.check, now, reserveRequest, ...(mode === "delegated" ? { artifacts: [x.artifact] } : {}) });
    const opened = () => (mode === "delegated" ? x.delegated() : x.open());
    expect(wire.checkWireRequest(opened(), at(clock))).toEqual({ body: {}, readbackOnly: false });
    expect(reserveRequest).toHaveBeenCalledTimes(1);
    clock = x.request.expiresAt - 1;
    expect(() => wire.checkWireRequest(opened(), at(clock))).toThrowError(expect.objectContaining({ code: "peer_request_replayed", status: 409 }));
    expect(reserveRequest).toHaveBeenCalledTimes(2);
    clock = x.request.expiresAt;
    expect(() => wire.checkWireRequest(opened(), at(clock))).toThrowError(expect.objectContaining({ code: "peer_expired", status: 408 }));
    expect(reserveRequest).toHaveBeenCalledTimes(2);
    // At that instant the journal drops every key it holds, so it alone would accept the replay: the expiry check refuses it.
    expect([...journal.values()].every((until) => until <= clock)).toBe(true);
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

  it("accepts a delegated request expiring exactly at its delegation only when it names the retained Agreement", () => {
    const x = world(), reserveRequest = vi.fn(() => true), artifacts = [x.artifact];
    const signed = { ...x.request, expiresAt: NOW + 60_000 };
    expect(() => wire.checkWireRequest(x.delegated({ ...signed, agreementHash: "b".repeat(64) }), { ...x.check, artifacts, reserveRequest }))
      .toThrowError(expect.objectContaining({ code: "peer_agreement_mismatch", status: 409 }));
    expect(reserveRequest).not.toHaveBeenCalled();
    expect(wire.checkWireRequest(x.delegated(signed), { ...x.check, artifacts, reserveRequest }).readbackOnly).toBe(false);
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

describe("the job and Agreement the host retained", () => {
  const OTHER_JOB = "01K7FZ8Q9W3V5T2R1N0M8K6J4J";
  const effects = ["/dacs/v1/payments", "/dacs/v1/commitments"];

  // Agreements are public on testnet (G1): another key that knows the job and its hash signs a direct request as buyer.
  it.each([...effects, "/dacs/v1/bundles/request", "/dacs/v1/agreements/state", "/dacs/v1/bundles/buyer-copy"])(
    "%s: a non-party's correctly signed direct request is refused by the retained parties alone, with no artifacts and no reservation", (path) => {
      const x = world(path), mallory = party(), reserveRequest = vi.fn(() => true);
      const signedHeader = x.signed({ ...x.request, buyer: mallory.claim }, mallory, wire.DACS_SELLER_HTTP_DOMAINS.request);
      const opened = wire.openWireEnvelope(Buffer.from(canonicalize(signedHeader)).toString("base64url"), "request", x.context);
      expect(() => wire.checkWireRequest(opened, { ...x.check, reserveRequest }))
        .toThrowError(expect.objectContaining({ code: "peer_agreement_party_mismatch", status: 409 }));
      // The host's record is what is compared: the job's own buyer is refused under another retained buyer or seller.
      expect(() => wire.checkWireRequest(x.open(), { ...x.check, retained: { ...x.retained, buyer: mallory.claim }, reserveRequest }))
        .toThrowError(expect.objectContaining({ code: "peer_agreement_party_mismatch", status: 409 }));
      expect(() => wire.checkWireRequest(x.open(), { ...x.check, retained: { ...x.retained, seller: mallory.claim }, reserveRequest }))
        .toThrowError(expect.objectContaining({ code: "peer_agreement_party_mismatch", status: 409 }));
      expect(() => wire.checkWireRequest(x.delegated(), { ...x.check, artifacts: [x.artifact], retained: { ...x.retained, buyer: mallory.claim }, reserveRequest }))
        .toThrowError(expect.objectContaining({ code: "peer_agreement_party_mismatch", status: 409 }));
      expect(reserveRequest).not.toHaveBeenCalled();
      expect(wire.checkWireRequest(x.open(), { ...x.check, reserveRequest }).readbackOnly).toBe(false);
    });

  it.each(effects)("%s: a correctly signed direct request naming another Agreement or job makes no reservation", (path) => {
    const x = world(path), reserveRequest = vi.fn(() => true), check = { ...x.check, reserveRequest };
    expect(() => wire.checkWireRequest(x.open({ ...x.request, agreementHash: "b".repeat(64) }), check))
      .toThrowError(expect.objectContaining({ code: "peer_agreement_mismatch", status: 409 }));
    expect(() => wire.checkWireRequest(x.open({ ...x.request, jobId: OTHER_JOB }), check))
      .toThrowError(expect.objectContaining({ code: "peer_job_mismatch", status: 409 }));
    // The host's record is what is compared: the same signed request is refused under another retained hash.
    expect(() => wire.checkWireRequest(x.open(), { ...check, retained: { ...x.retained, agreementHash: "b".repeat(64) } }))
      .toThrowError(expect.objectContaining({ code: "peer_agreement_mismatch", status: 409 }));
    expect(reserveRequest).not.toHaveBeenCalled();
    expect(wire.checkWireRequest(x.open(), check)).toEqual({ body: {}, readbackOnly: false });
    expect(reserveRequest).toHaveBeenCalledTimes(1);
  });

  it.each(effects)("%s: a delegated request naming another Agreement or job makes no reservation", (path) => {
    const x = world(path), reserveRequest = vi.fn(() => true), check = { ...x.check, artifacts: [x.artifact], reserveRequest };
    expect(() => wire.checkWireRequest(x.delegated({ ...x.request, agreementHash: "b".repeat(64) }), check))
      .toThrowError(expect.objectContaining({ code: "peer_agreement_mismatch", status: 409 }));
    expect(() => wire.checkWireRequest(x.delegated({ ...x.request, jobId: OTHER_JOB }), check))
      .toThrowError(expect.objectContaining({ code: "peer_job_mismatch", status: 409 }));
    expect(reserveRequest).not.toHaveBeenCalled();
    expect(wire.checkWireRequest(x.delegated(), check).readbackOnly).toBe(false);
    expect(reserveRequest).toHaveBeenCalledTimes(1);
  });

  it.each(["/dacs/v1/agreements/state", "/dacs/v1/bundles/buyer-copy"])("%s: read routes compare it too, including expired-delegation readback", (path) => {
    const x = world(path), later = { ...x.check, artifacts: [x.artifact], now: NOW + 60_000 };
    expect(() => wire.checkWireRequest(x.open({ ...x.request, agreementHash: "b".repeat(64) }), x.check))
      .toThrowError(expect.objectContaining({ code: "peer_agreement_mismatch" }));
    const readback = { ...x.request, expiresAt: NOW + 90_000 };
    expect(() => wire.checkWireRequest(x.delegated({ ...readback, agreementHash: "b".repeat(64) }), later))
      .toThrowError(expect.objectContaining({ code: "peer_agreement_mismatch" }));
    expect(wire.checkWireRequest(x.delegated(readback), later).readbackOnly).toBe(true);
  });

  it.each([
    ["omitted", undefined],
    ["null", null],
    ["empty", {}],
    ["without agreementHash", { jobId: "01K7FZ8Q9W3V5T2R1N0M8K6J4H", buyer: CLAIM_A, seller: CLAIM_B }],
    ["with an extra member", { jobId: "01K7FZ8Q9W3V5T2R1N0M8K6J4H", agreementHash: "a".repeat(64), buyer: CLAIM_A, seller: CLAIM_B, listingId: "report" }],
    ["with an uppercase hash", { jobId: "01K7FZ8Q9W3V5T2R1N0M8K6J4H", agreementHash: "A".repeat(64), buyer: CLAIM_A, seller: CLAIM_B }],
    ["with a non-canonical job id", { jobId: "01k7fz8q9w3v5t2r1n0m8k6j4h", agreementHash: "a".repeat(64), buyer: CLAIM_A, seller: CLAIM_B }],
    // The parties are part of the host's record: without them only the optional artifacts could bind the buyer.
    ["without parties (the job and hash only)", { jobId: "01K7FZ8Q9W3V5T2R1N0M8K6J4H", agreementHash: "a".repeat(64) }],
    ["without buyer", { jobId: "01K7FZ8Q9W3V5T2R1N0M8K6J4H", agreementHash: "a".repeat(64), seller: CLAIM_B }],
    ["without seller", { jobId: "01K7FZ8Q9W3V5T2R1N0M8K6J4H", agreementHash: "a".repeat(64), buyer: CLAIM_A }],
    ["with a buyer that is not a claim", { jobId: "01K7FZ8Q9W3V5T2R1N0M8K6J4H", agreementHash: "a".repeat(64), buyer: "a".repeat(64), seller: CLAIM_B }],
    ["with a seller that is not a claim", { jobId: "01K7FZ8Q9W3V5T2R1N0M8K6J4H", agreementHash: "a".repeat(64), buyer: CLAIM_A, seller: null }],
    ["a string", "a".repeat(64)],
  ])("refuses a retained Agreement %s, on effect and read routes, before reservation", (_name, retained) => {
    for (const path of [...effects, "/dacs/v1/agreements/state"]) {
      const x = world(path), reserveRequest = vi.fn(() => true);
      expect(() => wire.checkWireRequest(x.open(), { ...x.check, retained: retained as never, reserveRequest }))
        .toThrowError(expect.objectContaining({ code: "seller_retained_agreement_required", status: 500 }));
      expect(() => wire.checkWireRequest(x.delegated(), { ...x.check, artifacts: [x.artifact], retained: retained as never, reserveRequest }))
        .toThrowError(expect.objectContaining({ code: "seller_retained_agreement_required", status: 500 }));
      expect(reserveRequest).not.toHaveBeenCalled();
    }
  });

  it("reads the retained Agreement once, as data", () => {
    const x = world(), reserveRequest = vi.fn(() => true);
    let reads = 0;
    const retained = { jobId: x.retained.jobId, buyer: x.retained.buyer, seller: x.retained.seller, get agreementHash() { return ++reads === 1 ? x.retained.agreementHash : "b".repeat(64); } };
    expect(() => wire.checkWireRequest(x.open(), { ...x.check, retained, reserveRequest }))
      .toThrowError(expect.objectContaining({ code: "seller_retained_agreement_required", status: 500 }));
    expect(reserveRequest).not.toHaveBeenCalled();
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

describe("wallet signatures on the delegation path", () => {
  const delegationFor = (x: ReturnType<typeof world>, wallet: ReturnType<typeof party>, notBefore = NOW - 1000): wire.SellerSessionDelegationPayload => ({
    version: "1", kind: "seller-session-delegation", buyer: wallet.claim, seller: x.seller.claim, sessionPublicKey: party().key,
    listingPin: PIN, jobId: x.request.jobId, notBefore, expiresAt: NOW + 60_000, profile: x.context.binding.profile,
  });
  const verifyAt = (x: ReturnType<typeof world>, delegation: unknown, buyer: string) => wire.verifySellerSessionDelegation(delegation,
    { binding: x.context.binding, local: LOCAL, buyer, seller: x.seller.claim, listingPin: PIN, jobId: x.request.jobId, time: NOW });

  // Every form the guide names: raw bytes, hex with zero, one or two 0x/0X prefixes, surrounding whitespace, base64url.
  const forms: [string, (raw: Buffer) => Uint8Array | string, boolean][] = [
    ["raw bytes", (raw) => new Uint8Array(raw), false],
    ["hex", (raw) => raw.toString("hex"), false],
    ["uppercase hex", (raw) => raw.toString("hex").toUpperCase(), false],
    ["0x hex", (raw) => `0x${raw.toString("hex")}`, false],
    ["0x0x hex", (raw) => `0x0x${raw.toString("hex")}`, false],
    ["padded 0X0x hex", (raw) => ` 0X0x${raw.toString("hex")}\n`, false],
    ["base64url", (raw) => raw.toString("base64url"), false],
    ["padded base64url", (raw) => `\t${raw.toString("base64url")} `, false],
    ["base64url from an async wallet", (raw) => raw.toString("base64url"), true],
  ];
  it.each(forms)("a wallet returning %s signs a delegation the seller accepts, re-emitted as canonical base64url", async (_name, form, async) => {
    const x = world(), wallet = party(), payload = delegationFor(x, wallet);
    let raw: Buffer | undefined;
    const sign = vi.fn((bytes: Uint8Array) => {
      raw = wallet.sign(bytes);
      return async ? Promise.resolve(form(raw)) : form(raw);
    });
    const delegation = await wire.signSellerSessionDelegation(payload, { claim: wallet.claim, sign }, x.context.binding, LOCAL);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledWith(wire.sellerSessionDelegationSigningBytes(payload, x.context.binding, LOCAL));
    expect(delegation.signature).toBe(raw!.toString("base64url"));
    expect(verifyAt(x, delegation, wallet.claim)).toEqual(payload);
  });

  it("decodes repeated prefixes and surrounding whitespace to the raw bytes", () => {
    const raw = party().sign(Buffer.from("wallet encoding")), hex = raw.toString("hex");
    expect(walletSignatureBytes(`0x0x${hex}`)).toEqual(raw);
    expect(walletSignatureBytes(` ${hex}\n`)).toEqual(raw);
    expect(walletSignatureBytes(`0X0x0X${hex.toUpperCase()}`)).toEqual(raw);
    expect(() => walletSignatureBytes(`0x0x${hex.slice(2)}`)).toThrowError(expect.objectContaining({ code: "peer_delegation_signature_invalid" }));
    expect(() => walletSignatureBytes(raw)).toThrowError(expect.objectContaining({ code: "peer_delegation_signature_invalid" }));
  });

  // About one canonical base64url signature in 2,048 begins with "0x" or "0X": it is read as written, never stripped.
  it("keeps a canonical base64url wallet signature that begins with 0x", async () => {
    const x = world(), wallet = party();
    let payload: wire.SellerSessionDelegationPayload | undefined, raw: Buffer | undefined;
    for (let offset = 0; offset < 200_000 && raw === undefined; offset += 1) {
      const candidate = delegationFor(x, wallet, NOW - 1000 - offset);
      const signature = wallet.sign(Buffer.from(wire.DACS_SELLER_HTTP_DOMAINS.delegation + canonicalize(candidate)));
      if (/^0x/i.test(signature.toString("base64url"))) { payload = candidate; raw = signature; }
    }
    expect(raw).toBeDefined();
    expect(walletSignatureBytes(raw!.toString("base64url"))).toEqual(raw);
    const delegation = await wire.signSellerSessionDelegation(payload!, { claim: wallet.claim, sign: () => raw!.toString("base64url") }, x.context.binding, LOCAL);
    expect(delegation.signature).toBe(raw!.toString("base64url"));
    expect(verifyAt(x, delegation, wallet.claim)).toEqual(payload);
  });
});
