// A payment or delivery request continues a purchase only on commitment
// evidence the wire checks itself, at the buyer and at the seller, and an
// effect is reserved only in a journal that passed the persistence probe,
// keyed by its nonce and by its operation.
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import { FINALITY_COMMITMENT_SEPARATOR } from "../../src/negotiate/commitment.js";
import { FINALITY_COMMITMENT_DOMAIN } from "../../src/wire/commitment.js";
import * as fixtureWire from "../../src/wire/index.js";
import * as wire from "../../src/wire/index.js";
import { fixtureBinder } from "./authorityFixture.js";
import { acceptedPurchase, commitPurchase, validReceipt, wireCommitment } from "./commitmentFixture.js";
import { readFixtureListingEligibility } from "./listingEligibilityFixture.js";
import { journalFixture, memoryJournalOpener } from "./requestJournalFixture.js";

const bindTp1Fixture = fixtureBinder(fixtureWire);
const { inMemoryJournalForTest } = journalFixture(fixtureWire);
const NOW = Date.UTC(2026, 9, 18);
const JOB = "01K7FZ8Q9W3V5T2R1N0M8K6J4H";
const OTHER_JOB = "01K7FZ8Q9W3V5T2R1N0M8K6J4J";
const LOCAL = { endpoint: "https://rpc.continuation.invalid/", transportAuthority: "test", connectionId: "1" };
const PIN = { listingId: "report", version: 1, contentHash: "c".repeat(64) };
const AGREEMENT = "a".repeat(64);
const ENDPOINT = "https://seller.continuation.invalid";
const P = wire.DACS_SELLER_HTTP_PATHS;
const CONTINUING = [P.payments, P.bundleRequest, P.bundleCountersignature] as const;

function party() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const key = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  return { claim: `did:demos:agent:${key}`, key, sign: (bytes: Uint8Array) => sign(null, Buffer.from(bytes), privateKey) };
}
const header = (value: unknown) => Buffer.from(canonicalize(value)).toString("base64url");
const nonce = () => randomBytes(24).toString("base64url");

function world() {
  const buyer = party(), seller = party(), session = party();
  const binding = bindTp1Fixture({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local: LOCAL });
  const context = { binding, local: LOCAL, purchaseProfile: binding.profile };
  const request = (path: string, body = "{}", n = nonce()): wire.WireRequestPayload => ({
    version: "1", kind: "request", method: "POST", path, jobId: JOB, buyer: buyer.claim, seller: seller.claim, bodyHash: sha256Hex(body),
    listingPin: PIN, agreementHash: AGREEMENT, nonce: n, expiresAt: NOW + 30_000, profile: binding.profile,
  });
  const signed = (payload: unknown, signer: ReturnType<typeof party>, domain: string) => ({ payload, signature: signer.sign(Buffer.from(domain + canonicalize(payload))).toString("base64url") });
  const direct = (payload: wire.WireRequestPayload) => wire.openWireEnvelope(header(signed(payload, buyer, wire.DACS_SELLER_HTTP_DOMAINS.request)), "request", context);
  const delegated = (payload: wire.WireRequestPayload) => {
    const delegation = signed({ version: "1", kind: "seller-session-delegation", buyer: buyer.claim, seller: seller.claim,
      sessionPublicKey: session.key, listingPin: PIN, jobId: JOB, notBefore: NOW - 1000, expiresAt: NOW + 60_000,
      profile: binding.profile }, buyer, wire.DACS_SELLER_HTTP_DOMAINS.delegation);
    return wire.openWireEnvelope(header({ ...signed(payload, session, wire.DACS_SELLER_HTTP_DOMAINS.request), delegation }), "request", { ...context, requireDelegation: true });
  };
  const artifact = { jobId: JOB, listingRef: PIN, parties: [{ role: "buyer", primaryClaim: buyer.claim }, { role: "seller", primaryClaim: seller.claim }], terms: { deadline: NOW + 60_000 } };
  const retained = { jobId: JOB, agreementHash: AGREEMENT, buyer: buyer.claim, seller: seller.claim };
  const commitment = (options: Partial<Parameters<typeof wireCommitment>[0]> = {}) =>
    wireCommitment({ seller, buyer: buyer.claim, jobId: JOB, agreementHash: AGREEMENT, listingPin: PIN, committedAt: NOW - 5000, ...options });
  const check = (path: string, body = "{}") => ({ ...context, seller: seller.claim, listingPin: PIN, method: "POST", path, rawBody: Buffer.from(body), now: NOW, retained,
    ready: true, readCommitmentReceipt: validReceipt, commitment: commitment() });
  return { buyer, seller, binding, context, request, direct, delegated, artifact, retained, commitment, check };
}

describe("the seller checks the job's finalized commitment on every payment and delivery route", () => {
  const modes = (x: ReturnType<typeof world>, path: string) => [
    ["direct", () => x.direct(x.request(path)), {}],
    ["delegated", () => x.delegated(x.request(path)), { requireDelegation: true, artifacts: [x.artifact] }],
  ] as const;

  it.each(CONTINUING)("%s refuses an absent, pending, legacy or foreign commitment before any reservation, direct and delegated", (path) => {
    const x = world();
    const reserve = vi.fn(() => true);
    const journal = inMemoryJournalForTest(reserve);
    const receipt = x.commitment().anchorReceipt;
    const refused: Array<[string, Record<string, unknown>, string, number]> = [
      ["omitted", { commitment: undefined }, "seller_commitment_required", 500],
      ["absent by the seller's reader", { commitment: null }, "peer_agreement_uncommitted", 409],
      ["pending (included, not finalized)", { commitment: x.commitment({ receipt: { state: "included" } }) }, "continuation_commitment_invalid", 500],
      ["unestablished", { commitment: x.commitment({ receipt: { observationDisposition: "indeterminate" } }) }, "continuation_commitment_invalid", 500],
      ["another job", { commitment: x.commitment({ jobId: OTHER_JOB }) }, "continuation_commitment_invalid", 500],
      ["another Agreement", { commitment: x.commitment({ agreementHash: "b".repeat(64) }) }, "continuation_commitment_invalid", 500],
      ["another buyer", { commitment: x.commitment({ buyer: party().claim }) }, "continuation_commitment_invalid", 500],
      ["another Listing", { commitment: x.commitment({ listingPin: { ...PIN, version: 2 } }) }, "continuation_commitment_invalid", 500],
      ["a legacy result", { commitment: { ...x.commitment(), recordKind: "legacy" } }, "continuation_commitment_invalid", 500],
      ["a legacy record", { commitment: x.commitment({ patch: { dacsVersion: "0.3" } }) }, "continuation_commitment_invalid", 500],
      ["signed by another orchestrator", { commitment: wireCommitment({ seller: x.buyer, buyer: x.buyer.claim, jobId: JOB, agreementHash: AGREEMENT, listingPin: PIN, committedAt: NOW - 5000, signer: x.seller.claim }) }, "continuation_commitment_invalid", 500],
      ["a stated time the receipt does not give", { commitment: { ...x.commitment(), committedAt: NOW - 4000 } }, "continuation_commitment_invalid", 500],
      ["a receipt for other content", { commitment: x.commitment({ receipt: { contentHash: "d".repeat(64) } }) }, "continuation_commitment_invalid", 500],
      ["a receipt for another address", { commitment: x.commitment({ receipt: { logicalAddress: `dacs3:commit:${OTHER_JOB}` } }) }, "continuation_commitment_invalid", 500],
      ["a receipt time past the skew", { commitment: x.commitment({ committedAt: NOW + 30_001 }) }, "continuation_commitment_invalid", 500],
      ["no receipt reader", { readCommitmentReceipt: undefined }, "commitment_reader_required", 500],
      ["the reader finds it invalid", { readCommitmentReceipt: () => "invalid" }, "continuation_commitment_invalid", 500],
      ["the reader cannot tell", { readCommitmentReceipt: () => "indeterminate" }, "commitment_unverified", 503],
      ["the reader errs", { readCommitmentReceipt: () => "error" }, "commitment_unverified", 503],
      ["the reader answers later", { readCommitmentReceipt: async () => "valid" }, "commitment_reader_invalid", 500],
    ];
    for (const [mode, open, extra] of modes(x, path)) {
      for (const [name, change, code, status] of refused) {
        expect(() => wire.checkWireRequest(open(), { ...x.check(path), ...extra, requestJournal: journal, ...change } as wire.RequestCheck), `${mode}: ${name}`)
          .toThrowError(expect.objectContaining({ code, status }));
      }
      // The reader's own failure keeps its cause.
      const timeout = new Error("receipt lookup timed out");
      expect(() => wire.checkWireRequest(open(), { ...x.check(path), ...extra, requestJournal: journal, readCommitmentReceipt: () => { throw timeout; } } as wire.RequestCheck)).toThrow(timeout);
    }
    expect(receipt.state).toBe("finalized");
    expect(reserve).not.toHaveBeenCalled();
    // The seller's own copy, as data, continues the purchase; a JSON copy is the same evidence.
    for (const [, open, extra] of modes(x, path)) {
      expect(wire.checkWireRequest(open(), { ...x.check(path), ...extra, requestJournal: journal, commitment: JSON.parse(JSON.stringify(x.commitment())) } as wire.RequestCheck).readbackOnly).toBe(false);
    }
    expect(reserve).toHaveBeenCalledTimes(2);
  });

  it("asks the receipt reader every time, with an owned frozen copy of the anchored commitment", () => {
    const x = world();
    const seen: unknown[] = [];
    const reader = (anchored: unknown) => { seen.push(anchored); return "valid"; };
    for (const path of CONTINUING) wire.checkWireRequest(x.direct(x.request(path)), { ...x.check(path), requestJournal: inMemoryJournalForTest(), readCommitmentReceipt: reader });
    expect(seen).toHaveLength(3);
    for (const anchored of seen) {
      expect(Object.keys(anchored as object).sort()).toEqual(["anchorReceipt", "anchorTxRef", "nativeAddress", "record"]);
      expect(Object.isFrozen((anchored as { record: object }).record)).toBe(true);
    }
  });

  it("routes that start a purchase and read routes need no commitment", () => {
    const x = world();
    for (const path of [P.proposals, P.commitments, P.commitmentSignature, P.context, P.state, P.bundleBuyerCopy]) {
      expect(wire.checkWireRequest(x.direct(x.request(path)), { ...x.check(path), commitment: undefined, readCommitmentReceipt: undefined, requestJournal: inMemoryJournalForTest() }).readbackOnly).toBe(false);
    }
  });

  it("pins the commitment domain to the SDK gate's", () => {
    expect(FINALITY_COMMITMENT_DOMAIN).toBe(FINALITY_COMMITMENT_SEPARATOR);
  });
});

describe("a TP-1 buyer continues a purchase whose commitment it received from the seller", () => {
  // The seller is the orchestrator (G3): only its process runs commitFixedPriceAgreement. The buyer gets the result as bytes.
  const windowed: wire.ListingEligibilityReader = (scope) => ({ ...(readFixtureListingEligibility(scope) as object), notBefore: NOW - 1000, expiresAt: NOW + 60_000 });
  const ENDED = NOW + 120_000;

  it("after the Listing ends and the seller drains, from the seller's bytes, and again after a restart", async () => {
    const purchase = await acceptedPurchase({ jobId: JOB, generatedAt: NOW, validity: { notBefore: NOW - 600_000, notAfter: NOW + 600_000 }, publicEndpoint: ENDPOINT });
    const { buyer, seller, pin } = purchase;
    const sellerResult = await commitPurchase(purchase, NOW + 1000);
    const sent = Buffer.from(JSON.stringify(sellerResult));
    const binding = bindTp1Fixture({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local: LOCAL });
    const discoveryAt = (issuedAt: number) => wire.signDiscoveryDocument({ format: "dacs-seller-discovery/v1", profile: binding.profile, seller: seller.claim, publicEndpoint: ENDPOINT,
      transport: ["dacs-seller-http/v1"], listings: [pin], capabilities: wire.TP1_CAPABILITIES, ready: false, issuedAt, expiresAt: issuedAt + 60_000 }, seller, binding, LOCAL);
    const discovery = await discoveryAt(ENDED - 1000), early = await discoveryAt(NOW + 20_000);
    const listing = { seller: seller.claim, publicEndpoint: ENDPOINT, listingPin: pin };
    const input = (commitment: unknown, endpointProof: wire.EndpointProof) => ({ signer: buyer, binding, local: LOCAL, seller: seller.claim, jobId: JOB, path: P.payments, text: "{}",
      job: { listingPin: pin, agreementHash: purchase.agreementHash, profile: binding.profile }, now: ENDED, publicEndpoint: ENDPOINT, endpointProof, commitment });
    // Each "process" of the buyer parses the seller's bytes on its own: no object is shared with the gate.
    for (const run of ["first", "after restart"]) {
      const received = JSON.parse(sent.toString("utf8"));
      const endpointProof = wire.verifyEndpointProof(discovery, { readListingEligibility: windowed, readCommitmentReceipt: validReceipt, listing, binding, local: LOCAL, now: ENDED, commitment: received });
      const request = await wire.signWireRequest(input(received, endpointProof));
      const opened = wire.openWireEnvelope(request.header, "request", { binding, local: LOCAL, purchaseProfile: binding.profile });
      expect(wire.checkWireRequest(opened, { binding, local: LOCAL, purchaseProfile: binding.profile, seller: seller.claim, listingPin: pin, method: "POST", path: P.payments,
        rawBody: Buffer.from("{}"), now: ENDED, retained: { jobId: JOB, agreementHash: purchase.agreementHash, buyer: buyer.claim, seller: seller.claim },
        requestJournal: inMemoryJournalForTest(), commitment: sellerResult, readCommitmentReceipt: validReceipt }).readbackOnly, run).toBe(false);
    }
    // Without its own receipt reader, the buyer continues nothing: the seller's word is not evidence.
    const received = JSON.parse(sent.toString("utf8"));
    expect(() => wire.verifyEndpointProof(discovery, { readListingEligibility: windowed, listing, binding, local: LOCAL, now: ENDED, commitment: received }))
      .toThrowError(expect.objectContaining({ code: "commitment_reader_required", status: 500 }));
    const unread = wire.verifyEndpointProof(early, { readListingEligibility: windowed, listing, binding, local: LOCAL, now: NOW + 30_000 });
    await expect(wire.signWireRequest({ ...input(received, unread), now: NOW + 30_000 })).rejects.toMatchObject({ code: "commitment_reader_required" });
    expect(buyer.calls).toBe(2);
    // A reader that cannot establish the receipt leaves the purchase undecided: never final.
    expect(() => wire.verifyEndpointProof(discovery, { readListingEligibility: windowed, readCommitmentReceipt: () => "indeterminate", listing, binding, local: LOCAL, now: ENDED, commitment: received }))
      .toThrowError(expect.objectContaining({ code: "commitment_unverified", status: 503 }));
  });
});

describe("no package file can vouch for a commitment", () => {
  it("ships no commitment registrar: the module is gone and no wire or negotiate module exports a record, vouch, register or mark helper", async () => {
    expect(existsSync(new URL("../../src/negotiate/verifiedCommitment.ts", import.meta.url))).toBe(false);
    const modules = await Promise.all(["../../src/wire/index.js", "../../src/wire/commitment.js", "../../src/wire/discovery.js", "../../src/wire/envelope.js",
      "../../src/negotiate/index.js", "../../src/negotiate/commitment.js"].map((path) => import(path)));
    for (const module of modules) {
      expect(Object.keys(module).filter((name) => /^(record|vouch|register|mark)/i.test(name) || /verifiedAgreementCommitment/i.test(name))).toEqual([]);
    }
  });
});

describe("the request journal must pass the persistence probe", () => {
  const sharedNonceOnly = () => { const held = new Set<string>(); return () => ({ durable: true as const, reserve: ({ key }: wire.WireRequestReservation) => (held.has(key) ? false : (held.add(key), true)) }); };
  const sharedOperationOnly = () => { const held = new Set<string>(); return () => ({ durable: true as const, reserve: ({ operationId }: wire.WireRequestReservation) => (held.has(operationId) ? false : (held.add(operationId), true)) }); };

  it("refuses a journal that only declares itself durable, as checkWireRequest at the reviewed head accepted", () => {
    const x = world();
    const reserve = vi.fn(() => true);
    for (const path of [P.proposals, ...CONTINUING]) {
      expect(() => wire.checkWireRequest(x.direct(x.request(path)), { ...x.check(path), requestJournal: { durable: true, reserve } as never }))
        .toThrowError(expect.objectContaining({ code: "seller_replay_guard_required", status: 500 }));
    }
    expect(reserve).not.toHaveBeenCalled();
  });

  it.each([
    ["a per-handle in-memory set declared durable", () => () => { const held = new Set<string>(); return { durable: true as const, reserve: ({ key }: wire.WireRequestReservation) => (held.has(key) ? false : (held.add(key), true)) }; }, "NOT-SHARED"],
    ["the same handle every time", () => { const one = memoryJournalOpener()(); return () => one; }, "SAME-HANDLE"],
    ["a store keyed only by nonce", sharedNonceOnly, "OPERATION-NOT-KEYED"],
    ["a store keyed only by operation", sharedOperationOnly, "NONCE-NOT-KEYED"],
    ["a reserve that answers something other than a boolean", () => () => ({ durable: true as const, reserve: () => "yes" as unknown as boolean }), "NOT-BOOLEAN"],
    ["a reserve that refuses everything", () => () => ({ durable: true as const, reserve: () => false }), "PROBE-NOT-RESERVED"],
  ])("refuses %s", (_name, make, detail) => {
    expect(() => wire.qualifyWireRequestJournal(make() as () => wire.WireRequestJournal, NOW))
      .toThrowError(expect.objectContaining({ code: "seller_replay_guard_invalid", status: 500, detail }));
  });

  it("refuses an undeclared journal before calling it, and accepts a class instance over a shared store", () => {
    const reserve = vi.fn(() => true);
    for (const journal of [{ reserve }, { durable: false, reserve }, { durable: "true", reserve }, { durable: true }, null]) {
      expect(() => wire.qualifyWireRequestJournal(() => journal as never, NOW)).toThrowError(expect.objectContaining({ code: "seller_replay_guard_required" }));
    }
    expect(reserve).not.toHaveBeenCalled();
    const open = memoryJournalOpener();
    class Journal { readonly durable = true as const; readonly store = open(); reserve(reservation: wire.WireRequestReservation) { return this.store.reserve(reservation); } }
    expect(wire.qualifyWireRequestJournal(() => new Journal(), NOW)).toEqual({ qualified: true });
  });

  it("a fresh nonce does not repeat an effect: the same operation is refused, however its body is encoded; another body is another operation", () => {
    const x = world();
    const journal = inMemoryJournalForTest();
    const at = (path: string, body: string) => wire.checkWireRequest(x.direct(x.request(path, body)), { ...x.check(path, body), requestJournal: journal });
    for (const path of [P.proposals, ...CONTINUING]) {
      expect(at(path, '{"amount":"1","note":"x"}').readbackOnly).toBe(false);
      for (const repeat of ['{"amount":"1","note":"x"}', '{ "note": "x", "amount": "1" }']) {
        expect(() => at(path, repeat), `${path} ${repeat}`).toThrowError(expect.objectContaining({ code: "peer_request_replayed", status: 409 }));
      }
      expect(at(path, '{"amount":"2","note":"x"}').readbackOnly).toBe(false);
    }
  });

  it("gives the journal an operationId bound to the job, Agreement, parties, route and canonical body", () => {
    const x = world();
    const seen: wire.WireRequestReservation[] = [];
    const journal = inMemoryJournalForTest((reservation) => { seen.push(reservation); return true; });
    const body = '{"amount":"1"}';
    const payload = x.request(P.payments, body);
    wire.checkWireRequest(x.direct(payload), { ...x.check(P.payments, body), requestJournal: journal });
    const { buyer, seller, profile, jobId, agreementHash, path } = payload;
    expect(seen).toEqual([expect.objectContaining({
      key: sha256Hex(canonicalize({ buyer, seller, profile, nonce: payload.nonce })),
      operationId: sha256Hex(canonicalize({ profile, seller, buyer, jobId, agreementHash, path, body: sha256Hex(canonicalize({ amount: "1" })) })),
    })]);
  });
});

describe("a response is opened only against its principal", () => {
  it("refuses to open a response without the seller it must be signed by", async () => {
    const x = world();
    const request = x.request(P.payments);
    const answer = await wire.signWireResponse(request, 200, "{}", { ...x.context, signer: x.seller, now: NOW });
    for (const principal of [undefined, null, "", "seller"]) {
      expect(() => wire.openWireEnvelope(answer, "response", { ...x.context, purchaseProfile: request.profile, ...(principal === undefined ? {} : { principal }) } as wire.OpenEnvelopeOptions))
        .toThrowError(expect.objectContaining({ code: "wire_input_invalid", status: 500 }));
    }
    // An impostor's answer naming itself the seller: refused against the principal, and unopenable without one.
    const impostor = party();
    const forged = await wire.signWireResponse({ ...request, seller: impostor.claim }, 200, "{}", { ...x.context, signer: impostor, now: NOW });
    expect(() => wire.openWireEnvelope(forged, "response", { ...x.context, purchaseProfile: request.profile } as wire.OpenEnvelopeOptions))
      .toThrowError(expect.objectContaining({ code: "wire_input_invalid" }));
    expect(() => wire.openWireEnvelope(forged, "response", { ...x.context, purchaseProfile: request.profile, principal: x.seller.claim }))
      .toThrowError(expect.objectContaining({ code: "peer_signer_wrong" }));
    expect(wire.openWireEnvelope(answer, "response", { ...x.context, purchaseProfile: request.profile, principal: x.seller.claim }).payload.seller).toBe(x.seller.claim);
  });
});
