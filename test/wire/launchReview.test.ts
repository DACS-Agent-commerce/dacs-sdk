import * as fixtureWire from "../../src/wire/index.js";
import { fixtureBinder } from "./authorityFixture.js";
import { journalDirectory, journalFixture, reservationsIn } from "./requestJournalFixture.js";
import { ed25519KeyPair, received, signedAgreement, tp1Listing, validReceipt, wireCommitment } from "./commitmentFixture.js";
import { sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import * as wire from "../../src/wire/index.js";
import { walletSignatureBytes } from "../../src/wire/validate.js";

vi.setConfig({ testTimeout: 60_000 });
afterAll(() => vi.resetConfig());

const bindTp1Fixture = fixtureBinder(fixtureWire);
const { openJournal, testJournals } = journalFixture(fixtureWire);

const NOW = Date.UTC(2026, 9, 18);
const LOCAL = { endpoint: "https://rpc.review.invalid/", transportAuthority: "test", connectionId: "1" };
// The seller's key is fixed, so its signed Listing, and the pin every request names, is a constant.
const SELLER_SEED = 53;
const { listing: LISTING, pin: PIN } = tp1Listing({ seller: party(SELLER_SEED), listingId: "report" });
function party(seed?: number) {
  const { privateKey, publicKey } = ed25519KeyPair(seed);
  const key = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  return { claim: `did:demos:agent:${key}`, key, sign: (bytes: Uint8Array) => sign(null, Buffer.from(bytes), privateKey) };
}
const header = (value: unknown) => Buffer.from(canonicalize(value)).toString("base64url");
/** Well-formed claims for retained records that are refused before their parties are compared. */
const CLAIM_A = `did:demos:agent:${"1".repeat(64)}`, CLAIM_B = `did:demos:agent:${"2".repeat(64)}`;
async function world(path = "/dacs/v1/payments") {
  const buyer = party(), seller = party(SELLER_SEED), session = party();
  const binding = (await bindTp1Fixture({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local: LOCAL }));
  const context = { binding, local: LOCAL, purchaseProfile: binding.profile };
  const { agreement, agreementHash } = signedAgreement({ buyer, seller, jobId: "01K7FZ8Q9W3V5T2R1N0M8K6J4H", listingPin: PIN });
  const request: wire.WireRequestPayload = {
    version: "1", kind: "request", method: "POST", path, jobId: "01K7FZ8Q9W3V5T2R1N0M8K6J4H",
    buyer: buyer.claim, seller: seller.claim, bodyHash: sha256Hex("{}"), listingPin: PIN, agreementHash,
    nonce: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYX", expiresAt: NOW + 30_000, profile: binding.profile,
  };
  const signed = (payload: unknown, signer: ReturnType<typeof party>, domain: string) => ({ payload, signature: signer.sign(Buffer.from(domain + canonicalize(payload))).toString("base64url") });
  const open = async (payload = request) => (await wire.openWireEnvelope(header(signed(payload, buyer, wire.DACS_SELLER_HTTP_DOMAINS.request)), "request", context));
  const artifact = { jobId: request.jobId, listingRef: PIN, parties: [{ role: "buyer", primaryClaim: buyer.claim }, { role: "seller", primaryClaim: seller.claim }], terms: { deadline: NOW + 60_000 } };
  const delegated = async (payload = request) => {
    const delegation = signed({ version: "1", kind: "seller-session-delegation", buyer: buyer.claim, seller: seller.claim,
      sessionPublicKey: session.key, listingPin: PIN, jobId: request.jobId, notBefore: NOW - 1000, expiresAt: NOW + 60_000,
      profile: binding.profile }, buyer, wire.DACS_SELLER_HTTP_DOMAINS.delegation);
    return (await wire.openWireEnvelope(header({ ...signed(payload, session, wire.DACS_SELLER_HTTP_DOMAINS.request), delegation }), "request", { ...context, requireDelegation: true }));
  };
  /** The buyer-signed (undelegated) request header. */
  const direct = () => header(signed(request, buyer, wire.DACS_SELLER_HTTP_DOMAINS.request));
  /** What the seller host retained for the job: its own record, not read from the request. */
  const retained = { jobId: "01K7FZ8Q9W3V5T2R1N0M8K6J4H", agreementHash, buyer: buyer.claim, seller: seller.claim };
  // The job's finalized commitment, which the seller read itself: payment and delivery routes need it.
  const commitment = wireCommitment({ seller, buyer: buyer.claim, jobId: retained.jobId, agreementHash: retained.agreementHash, listingPin: PIN, committedAt: NOW - 5000 });
  const check = { ...context, seller: seller.claim, listingPin: PIN, method: "POST", path, rawBody: Buffer.from("{}"), now: NOW, retained, ready: true,
    commitment: received(commitment), agreement: received(agreement), readCommitmentReceipt: validReceipt, signedListing: received(LISTING) };
  return { buyer, seller, request, open, delegated, direct, artifact, check, context, signed, retained };
}

describe("effect request replay reservations", () => {
  it.each(["/dacs/v1/payments", "/dacs/v1/commitments"])("%s requires the SDK's journal and refuses replays across reopen and nonce reuse", async (path) => {
    const x = (await world(path));
    await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await x.open()), x.check)))).rejects.toThrowError(expect.objectContaining({ code: "seller_replay_guard_required" }));
    const directory = journalDirectory();
    const check = { ...x.check, requestJournal: openJournal(directory) };
    expect((await wire.checkWireRequest((await x.open()), check))).toEqual({ body: {}, readbackOnly: false, effect: expect.objectContaining({ state: "new", attempt: 0 }) });
    const { profile, buyer, agreementHash } = x.request;
    expect(reservationsIn(directory)).toEqual([{ key: expect.any(String), operationId: wire.wireOperationId(x.request),
      binding: sha256Hex(canonicalize({ profile, buyer, agreementHash })), requestHash: wire.wireRequestHash(x.request) }]);
    await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await x.open()), check)))).rejects.toThrowError(expect.objectContaining({ code: "peer_request_replayed" }));
    // Another worker opening another request under the same nonce uses the same journal directory.
    await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await x.open({ ...x.request, expiresAt: NOW + 20_000 })), { ...check, requestJournal: openJournal(directory) })))).rejects.toThrowError(expect.objectContaining({ code: "peer_request_replayed" }));
    // A fresh nonce is the same operation, still held by its first attempt.
    await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await x.open({ ...x.request, nonce: "FxYVFBMSERAPDg0MCwoJCAcGBQQDAgEA" })), check)))).rejects.toThrowError(expect.objectContaining({ code: "seller_effect_pending", status: 503 }));
  });

  it("does not reserve invalid requests or require reservations for read routes", async () => {
    const x = (await world()), reserveRequest = testJournals();
    await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await x.open()), { ...x.check, rawBody: Buffer.from('{"changed":true}'), requestJournal: (await reserveRequest.open()) })))).rejects.toThrow();
    expect(reserveRequest.reservations()).toHaveLength(0);
    const read = (await world("/dacs/v1/agreements/state"));
    expect((await wire.checkWireRequest((await read.open()), read.check)).readbackOnly).toBe(false);
  });

  it("reserves a live delegated effect request once and refuses its replay", async () => {
    const x = (await world());
    await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await x.delegated()), { ...x.check, artifacts: [x.artifact] })))).rejects.toThrowError(expect.objectContaining({ code: "seller_replay_guard_required" }));
    const directory = journalDirectory();
    const check = { ...x.check, artifacts: [x.artifact], requestJournal: openJournal(directory) };
    expect((await wire.checkWireRequest((await x.delegated()), check))).toEqual({ body: {}, readbackOnly: false, effect: expect.objectContaining({ state: "new" }) });
    const { profile, jobId, agreementHash, path } = x.request;
    expect(reservationsIn(directory)).toEqual([{
      key: sha256Hex(canonicalize({ buyer: x.buyer.claim, seller: x.seller.claim, profile: x.request.profile, nonce: x.request.nonce })),
      operationId: sha256Hex(canonicalize({ seller: x.seller.claim, jobId, path })),
      binding: sha256Hex(canonicalize({ profile, buyer: x.buyer.claim, agreementHash })),
      requestHash: wire.wireRequestHash(x.request),
    }]);
    await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await x.delegated()), check)))).rejects.toThrowError(expect.objectContaining({ code: "peer_request_replayed" }));
    expect(reservationsIn(directory)).toHaveLength(1);
  });

  it("names the shipped journal, and the host's effect handling around it, in the register and the guide", () => {
    const text = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
    const gate = JSON.parse(text("conformance/tp1-register.json")).qualification
      .filter((q: { subject: string }) => q.subject.startsWith("consumer: seller host request journal"));
    expect(gate).toHaveLength(1);
    expect(gate[0].result).toBe("not checked");
    expect(gate[0].subject).toContain("openWireRequestJournal");
    expect(gate[0].subject).toContain("completeWireEffect");
    expect(gate[0].subject).not.toContain("qualifyWireRequestJournal");
    const guide = text("docs/dacs-seller-http-v1.md").replace(/\s+/g, " ");
    expect(guide).toContain("the only journal `checkWireRequest` accepts");
    expect(guide).not.toContain("qualifyWireRequestJournal");
    expect(guide).not.toContain("Host duty");
  });

  // The journal never drops a key, and the seller refuses a request from the instant now === expiresAt.
  it.each(["direct", "delegated"] as const)("a %s replay is refused while it is live and expired from expiresAt", async (mode) => {
    // Hold admission latency constant to isolate the last live millisecond from machine speed.
    const monotonic = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const x = (await world());
      const directory = journalDirectory();
      const at = (now: number) => ({ ...x.check, now, requestJournal: openJournal(directory), ...(mode === "delegated" ? { artifacts: [x.artifact] } : {}) });
      const opened = async () => (mode === "delegated" ? (await x.delegated()) : (await x.open()));
      expect((await wire.checkWireRequest((await opened()), at(NOW))).readbackOnly).toBe(false);
      await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await opened()), at(x.request.expiresAt - 1))))).rejects.toThrowError(expect.objectContaining({ code: "peer_request_replayed", status: 409 }));
      await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await opened()), at(x.request.expiresAt))))).rejects.toThrowError(expect.objectContaining({ code: "peer_expired", status: 408 }));
      expect(reservationsIn(directory)).toHaveLength(1);
    } finally {
      monotonic.mockRestore();
    }
  });

  it("fails closed on a journal entry it did not write: not a file, too large, or a malformed outcome", async () => {
    const x = (await world());
    const key = sha256Hex(canonicalize({ buyer: x.buyer.claim, seller: x.seller.claim, profile: x.request.profile, nonce: x.request.nonce }));
    const operationId = wire.wireOperationId(x.request);
    const cases: Array<[string, (directory: string) => void, string]> = [
      ["a directory where an attempt belongs", (d) => mkdirSync(join(d, `o-${operationId}-0`)), "STORE-ENTRY-NOT-FILE"],
      ["a malformed outcome", (d) => writeFileSync(join(d, `o-${operationId}.done`), '{"outcome":"paid"}'), "STORE-OUTCOME-INVALID"],
      ["an outcome for another operation", (d) => writeFileSync(join(d, `o-${operationId}.done`), JSON.stringify({ operationId: "f".repeat(64), attempt: 0, outcome: { status: 200, text: "{}" } })), "STORE-OUTCOME-INVALID"],
      ["an oversized outcome", (d) => writeFileSync(join(d, `o-${operationId}.done`), "x".repeat(2 * 512 * 1024 + 4097)), "STORE-ENTRY-TOO-LARGE"],
      ["an oversized attempt", (d) => writeFileSync(join(d, `o-${operationId}-0`), "x".repeat(4097)), "STORE-ENTRY-TOO-LARGE"],
      // An attempt file the journal cannot read is not a lapsed lease: nothing is recovered from it.
      ["an attempt that does not parse", (d) => writeFileSync(join(d, `o-${operationId}-0`), "{"), "STORE-ATTEMPT-INVALID"],
      ["an attempt for another operation", (d) => writeFileSync(join(d, `o-${operationId}-0`), JSON.stringify({ operationId: "f".repeat(64), attempt: 0, requestHash: "a".repeat(64), leaseUntil: 0, binding: "b".repeat(64) })), "STORE-ATTEMPT-INVALID"],
      ["an outcome with no attempt", (d) => writeFileSync(join(d, `o-${operationId}.done`), JSON.stringify({ operationId, attempt: 0, outcome: { status: 200, textBytes: Buffer.from("{}").toString("base64url") } })), "STORE-ATTEMPT-MISSING"],
      // The outcome's text is stored as its UTF-8 bytes; plain text there, or bytes that are not canonical base64url, was not written by this journal.
      ["an outcome with its text stored plain", (d) => writeFileSync(join(d, `o-${operationId}.done`), JSON.stringify({ operationId, attempt: 0, outcome: { status: 200, text: "{}" } })), "STORE-OUTCOME-INVALID"],
      // Damaged bytes must not decode to U+FFFD and be signed as another answer; text the wire could never sign is no outcome either.
      ["an outcome whose bytes are not well-formed UTF-8", (d) => writeFileSync(join(d, `o-${operationId}.done`), JSON.stringify({ operationId, attempt: 0, outcome: { status: 200, textBytes: Buffer.from([0x7b, 0xff, 0x7d]).toString("base64url") } })), "STORE-OUTCOME-INVALID"],
      ["an outcome whose bytes are a lone 0xff", (d) => writeFileSync(join(d, `o-${operationId}.done`), JSON.stringify({ operationId, attempt: 0, outcome: { status: 200, textBytes: "_w" } })), "STORE-OUTCOME-INVALID"],
      ["an outcome whose text is not a JSON object", (d) => writeFileSync(join(d, `o-${operationId}.done`), JSON.stringify({ operationId, attempt: 0, outcome: { status: 200, textBytes: Buffer.from("paid").toString("base64url") } })), "STORE-OUTCOME-INVALID"],
      ["an outcome whose bytes are not canonical base64url", (d) => writeFileSync(join(d, `o-${operationId}.done`), JSON.stringify({ operationId, attempt: 0, outcome: { status: 200, textBytes: "e30=" } })), "STORE-OUTCOME-INVALID"],
    ];
    for (const [name, plant, detail] of cases) {
      const directory = journalDirectory();
      plant(directory);
      await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await x.open()), { ...x.check, requestJournal: openJournal(directory) }))), name).rejects
        .toThrowError(expect.objectContaining({ code: "seller_replay_guard_invalid", status: 500, detail }));
      expect(existsSync(join(directory, `k-${key}`)), name).toBe(true);
      expect(existsSync(join(directory, `o-${operationId}-1`)), name).toBe(false);
    }
  });
});

describe("exchange and delegation scope bindings", () => {
  it.each([
    ["path", { path: "/dacs/v1/payments" }],
    ["method", { method: "GET" }],
  ])("refuses a request signed for another %s before reservation", async (_name, change) => {
    const x = (await world("/dacs/v1/agreements/state")), reserveRequest = testJournals();
    expect((await wire.checkWireRequest((await x.open()), { ...x.check, requestJournal: (await reserveRequest.open()) })).readbackOnly).toBe(false);
    await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await x.open()), { ...x.check, ...change, requestJournal: (await reserveRequest.open()) })))).rejects.toThrowError(expect.objectContaining({ code: "peer_request_mismatch" }));
    expect(reserveRequest.reservations()).toHaveLength(0);
  });

  // A host may require the delegation at one entry point only: each must refuse a buyer-signed request on its own.
  it("openWireEnvelope alone refuses a buyer-signed request when it requires a delegation", async () => {
    const x = (await world());
    expect((await wire.openWireEnvelope(x.direct(), "request", x.context)).delegation).toBeNull();
    await expect(Promise.resolve().then(async () => (await wire.openWireEnvelope(x.direct(), "request", { ...x.context, requireDelegation: true })))).rejects
      .toThrowError(expect.objectContaining({ code: "peer_delegation_required", status: 401 }));
  });

  it("checkWireRequest alone refuses a buyer-signed request when it requires a delegation, before reservation", async () => {
    const x = (await world()), reserveRequest = testJournals();
    await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await x.open()), { ...x.check, requireDelegation: true, requestJournal: (await reserveRequest.open()) })))).rejects
      .toThrowError(expect.objectContaining({ code: "peer_delegation_required", status: 401 }));
    expect(reserveRequest.reservations()).toHaveLength(0);
    // Controls: the same request without the requirement, and a delegated one with it, each reserve once.
    expect((await wire.checkWireRequest((await x.open()), { ...x.check, requestJournal: (await reserveRequest.open()) })).readbackOnly).toBe(false);
    expect((await wire.checkWireRequest((await x.delegated()), { ...x.check, requireDelegation: true, artifacts: [x.artifact], requestJournal: (await reserveRequest.open()) })).readbackOnly).toBe(false);
    expect(reserveRequest.reservations()).toHaveLength(2);
  });

  it("refuses a delegation another wallet signed, under a request naming the buyer", async () => {
    const x = (await world()), wallet = party(), session = party();
    const delegation = x.signed({ version: "1", kind: "seller-session-delegation", buyer: wallet.claim, seller: x.seller.claim,
      sessionPublicKey: session.key, listingPin: PIN, jobId: x.request.jobId, notBefore: NOW - 1000, expiresAt: NOW + 60_000,
      profile: x.request.profile }, wallet, wire.DACS_SELLER_HTTP_DOMAINS.delegation);
    const signed = header({ ...x.signed(x.request, session, wire.DACS_SELLER_HTTP_DOMAINS.request), delegation });
    await expect(Promise.resolve().then(async () => (await wire.openWireEnvelope(signed, "request", { ...x.context, requireDelegation: true })))).rejects.toThrowError(expect.objectContaining({ code: "peer_delegation_mismatch" }));
    await expect(Promise.resolve().then(async () => (await wire.verifySellerSessionDelegation(Buffer.from(JSON.stringify(delegation)), { binding: x.context.binding, local: LOCAL, buyer: x.buyer.claim, seller: x.seller.claim, listingPin: PIN, jobId: x.request.jobId, time: NOW })))).rejects.toThrowError(expect.objectContaining({ code: "peer_delegation_mismatch" }));
    expect((await wire.verifySellerSessionDelegation(Buffer.from(JSON.stringify(delegation)), { binding: x.context.binding, local: LOCAL, buyer: wallet.claim, seller: x.seller.claim, listingPin: PIN, jobId: x.request.jobId, time: NOW })).buyer).toBe(wallet.claim);
  });
});

describe("delegated Agreement context", () => {
  it.each([[undefined], [[]], [[null]]])("refuses missing Agreement context %j before reserving an effect", async (artifacts) => {
    const x = (await world()), reserveRequest = testJournals();
    await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await x.delegated()), { ...x.check, artifacts, requestJournal: (await reserveRequest.open()) })))).rejects.toThrowError(expect.objectContaining({ code: "peer_delegation_agreement_required" }));
    expect(reserveRequest.reservations()).toHaveLength(0);
  });

  it("binds a delegated request to the host's retained parties and deadline before reservation", async () => {
    const x = (await world()), reserveRequest = testJournals(), opened = (await x.delegated());
    await expect(Promise.resolve().then(async () => (await wire.checkWireRequest(opened, { ...x.check, artifacts: [{ ...x.artifact, terms: { deadline: NOW + 59_999 } }], requestJournal: (await reserveRequest.open()) })))).rejects.toThrowError(expect.objectContaining({ code: "peer_delegation_deadline" }));
    await expect(Promise.resolve().then(async () => (await wire.checkWireRequest(opened, { ...x.check, artifacts: [{ ...x.artifact, jobId: "01K7FZ8Q9W3V5T2R1N0M8K6J4J" }], requestJournal: (await reserveRequest.open()) })))).rejects.toThrowError(expect.objectContaining({ code: "peer_delegation_agreement_mismatch" }));
    expect(reserveRequest.reservations()).toHaveLength(0);
    expect((await wire.checkWireRequest(opened, { ...x.check, artifacts: [x.artifact], requestJournal: (await reserveRequest.open()) })).readbackOnly).toBe(false);
  });

  it.each([
    ["another buyer", (b: unknown, s: unknown) => [{ role: "buyer", primaryClaim: party().claim }, s]],
    ["another seller", (b: unknown) => [b, { role: "seller", primaryClaim: party().claim }]],
    ["no buyer party", (_b: unknown, s: unknown) => [s]],
    ["no seller party", (b: unknown) => [b]],
    ["the parties' roles swapped", (b: any, s: any) => [{ ...b, role: "seller" }, { ...s, role: "buyer" }]],
  ])("refuses a retained Agreement naming %s before reservation", async (_name, parties) => {
    const x = (await world()), reserveRequest = testJournals(), [b, s] = x.artifact.parties;
    await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await x.delegated()), { ...x.check, artifacts: [{ ...x.artifact, parties: parties(b, s) }], requestJournal: (await reserveRequest.open()) })))).rejects
      .toThrowError(expect.objectContaining({ code: "peer_delegation_agreement_mismatch" }));
    expect(reserveRequest.reservations()).toHaveLength(0);
  });

  it("accepts a delegated request expiring exactly at its delegation only when it names the retained Agreement", async () => {
    const x = (await world()), reserveRequest = testJournals(), artifacts = [x.artifact];
    const signed = { ...x.request, expiresAt: NOW + 60_000 };
    await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await x.delegated({ ...signed, agreementHash: "b".repeat(64) })), { ...x.check, artifacts, requestJournal: (await reserveRequest.open()) })))).rejects
      .toThrowError(expect.objectContaining({ code: "peer_agreement_mismatch", status: 409 }));
    expect(reserveRequest.reservations()).toHaveLength(0);
    expect((await wire.checkWireRequest((await x.delegated(signed)), { ...x.check, artifacts, requestJournal: (await reserveRequest.open()) })).readbackOnly).toBe(false);
  });

  it.each([
    ["seller first", (b: unknown, s: unknown) => [s, b]],
    ["a null entry first", (b: unknown, s: unknown) => [null, b, s]],
  ])("finds each party by role, not by position (%s)", async (_name, parties) => {
    const x = (await world()), [b, s] = x.artifact.parties;
    expect((await wire.checkWireRequest((await x.delegated()), { ...x.check, artifacts: [{ ...x.artifact, parties: parties(b, s) }], requestJournal: (await testJournals().open()) })).readbackOnly).toBe(false);
  });

  it("refuses a retained Agreement without terms with its own code, before reservation", async () => {
    const x = (await world()), reserveRequest = testJournals(), { terms: _terms, ...withoutTerms } = x.artifact;
    await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await x.delegated()), { ...x.check, artifacts: [withoutTerms], requestJournal: (await reserveRequest.open()) })))).rejects
      .toThrowError(expect.objectContaining({ code: "peer_delegation_deadline", status: 409 }));
    expect(reserveRequest.reservations()).toHaveLength(0);
  });

  it("accepts a delegated request that expires exactly when its delegation does", async () => {
    // world()'s delegation expires at NOW + 60 000; a request outliving it is refused (request/delegated-outlives-delegation).
    const x = (await world()), reserveRequest = testJournals(), artifacts = [x.artifact];
    expect((await wire.checkWireRequest((await x.delegated({ ...x.request, expiresAt: NOW + 60_000 })), { ...x.check, artifacts, requestJournal: (await reserveRequest.open()) })).readbackOnly).toBe(false);
    expect(reserveRequest.reservations()).toHaveLength(1);
  });
});

describe("the job and Agreement the host retained", () => {
  const OTHER_JOB = "01K7FZ8Q9W3V5T2R1N0M8K6J4J";
  const effects = ["/dacs/v1/payments", "/dacs/v1/commitments"];

  // Agreements are public on testnet (G1): another key that knows the job and its hash signs a direct request as buyer.
  it.each([...effects, "/dacs/v1/bundles/request", "/dacs/v1/agreements/state", "/dacs/v1/bundles/buyer-copy"])(
    "%s: a non-party's correctly signed direct request is refused by the retained parties alone, with no artifacts and no reservation", async (path) => {
      const x = (await world(path)), mallory = party(), reserveRequest = testJournals();
      const signedHeader = x.signed({ ...x.request, buyer: mallory.claim }, mallory, wire.DACS_SELLER_HTTP_DOMAINS.request);
      const opened = (await wire.openWireEnvelope(Buffer.from(canonicalize(signedHeader)).toString("base64url"), "request", x.context));
      await expect(Promise.resolve().then(async () => (await wire.checkWireRequest(opened, { ...x.check, requestJournal: (await reserveRequest.open()) })))).rejects
        .toThrowError(expect.objectContaining({ code: "peer_agreement_party_mismatch", status: 409 }));
      // The host's record is what is compared: the job's own buyer is refused under another retained buyer or seller.
      await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await x.open()), { ...x.check, retained: { ...x.retained, buyer: mallory.claim }, requestJournal: (await reserveRequest.open()) })))).rejects
        .toThrowError(expect.objectContaining({ code: "peer_agreement_party_mismatch", status: 409 }));
      await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await x.open()), { ...x.check, retained: { ...x.retained, seller: mallory.claim }, requestJournal: (await reserveRequest.open()) })))).rejects
        .toThrowError(expect.objectContaining({ code: "peer_agreement_party_mismatch", status: 409 }));
      await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await x.delegated()), { ...x.check, artifacts: [x.artifact], retained: { ...x.retained, buyer: mallory.claim }, requestJournal: (await reserveRequest.open()) })))).rejects
        .toThrowError(expect.objectContaining({ code: "peer_agreement_party_mismatch", status: 409 }));
      expect(reserveRequest.reservations()).toHaveLength(0);
      expect((await wire.checkWireRequest((await x.open()), { ...x.check, requestJournal: (await reserveRequest.open()) })).readbackOnly).toBe(false);
    });

  it.each(effects)("%s: a correctly signed direct request naming another Agreement or job makes no reservation", async (path) => {
    const x = (await world(path)), reserveRequest = testJournals(), check = { ...x.check, requestJournal: (await reserveRequest.open()) };
    await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await x.open({ ...x.request, agreementHash: "b".repeat(64) })), check)))).rejects
      .toThrowError(expect.objectContaining({ code: "peer_agreement_mismatch", status: 409 }));
    await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await x.open({ ...x.request, jobId: OTHER_JOB })), check)))).rejects
      .toThrowError(expect.objectContaining({ code: "peer_job_mismatch", status: 409 }));
    // The host's record is what is compared: the same signed request is refused under another retained hash.
    await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await x.open()), { ...check, retained: { ...x.retained, agreementHash: "b".repeat(64) } })))).rejects
      .toThrowError(expect.objectContaining({ code: "peer_agreement_mismatch", status: 409 }));
    expect(reserveRequest.reservations()).toHaveLength(0);
    expect((await wire.checkWireRequest((await x.open()), check))).toEqual({ body: {}, readbackOnly: false, effect: expect.objectContaining({ state: "new" }) });
    expect(reserveRequest.reservations()).toHaveLength(1);
  });

  it.each(effects)("%s: a delegated request naming another Agreement or job makes no reservation", async (path) => {
    const x = (await world(path)), reserveRequest = testJournals(), check = { ...x.check, artifacts: [x.artifact], requestJournal: (await reserveRequest.open()) };
    await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await x.delegated({ ...x.request, agreementHash: "b".repeat(64) })), check)))).rejects
      .toThrowError(expect.objectContaining({ code: "peer_agreement_mismatch", status: 409 }));
    await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await x.delegated({ ...x.request, jobId: OTHER_JOB })), check)))).rejects
      .toThrowError(expect.objectContaining({ code: "peer_delegation_mismatch", status: 409 }));
    expect(reserveRequest.reservations()).toHaveLength(0);
    expect((await wire.checkWireRequest((await x.delegated()), check)).readbackOnly).toBe(false);
    expect(reserveRequest.reservations()).toHaveLength(1);
  });

  it.each(["/dacs/v1/agreements/state", "/dacs/v1/bundles/buyer-copy"])("%s: read routes compare it too, including expired-delegation readback", async (path) => {
    const x = (await world(path)), later = { ...x.check, artifacts: [x.artifact], now: NOW + 60_000 };
    await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await x.open({ ...x.request, agreementHash: "b".repeat(64) })), x.check)))).rejects
      .toThrowError(expect.objectContaining({ code: "peer_agreement_mismatch" }));
    const readback = { ...x.request, expiresAt: NOW + 90_000 };
    await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await x.delegated({ ...readback, agreementHash: "b".repeat(64) })), later)))).rejects
      .toThrowError(expect.objectContaining({ code: "peer_agreement_mismatch" }));
    expect((await wire.checkWireRequest((await x.delegated(readback)), later)).readbackOnly).toBe(true);
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
  ])("refuses a retained Agreement %s, on effect and read routes, before reservation", async (_name, retained) => {
    for (const path of [...effects, "/dacs/v1/agreements/state"]) {
      const x = (await world(path)), reserveRequest = testJournals();
      await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await x.open()), { ...x.check, retained: retained as never, requestJournal: (await reserveRequest.open()) })))).rejects
        .toThrowError(expect.objectContaining({ code: "seller_retained_agreement_required", status: 500 }));
      await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await x.delegated()), { ...x.check, artifacts: [x.artifact], retained: retained as never, requestJournal: (await reserveRequest.open()) })))).rejects
        .toThrowError(expect.objectContaining({ code: "seller_retained_agreement_required", status: 500 }));
      expect(reserveRequest.reservations()).toHaveLength(0);
    }
  });

  it("reads the retained Agreement once, as data", async () => {
    const x = (await world()), reserveRequest = testJournals();
    let reads = 0;
    const retained = { jobId: x.retained.jobId, buyer: x.retained.buyer, seller: x.retained.seller, get agreementHash() { return ++reads === 1 ? x.retained.agreementHash : "b".repeat(64); } };
    await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await x.open()), { ...x.check, retained, requestJournal: (await reserveRequest.open()) })))).rejects
      .toThrowError(expect.objectContaining({ code: "seller_retained_agreement_required", status: 500 }));
    expect(reserveRequest.reservations()).toHaveLength(0);
  });
});

describe("body admission refuses JSON that is not an object", () => {
  it.each(["null", "[]", "1", '"text"', "true"])("%s, at the seller, the buyer and the response signer", async (text) => {
    const x = (await world()), bytes = Buffer.from(text), sign = vi.fn(x.seller.sign);
    expect(() => wire.admitWireRequestBody(bytes)).toThrowError(expect.objectContaining({ code: "bad_request", status: 400 }));
    expect(() => wire.admitWireResponseBody(bytes)).toThrowError(expect.objectContaining({ code: "response_json_rejected", status: 502, detail: "NOT-AN-OBJECT" }));
    await expect(wire.signWireResponse(x.request, 200, text, { ...x.context, signer: { claim: x.seller.claim, sign }, now: NOW }))
      .rejects.toMatchObject({ code: "outgoing_body_rejected", status: 500, detail: "NOT-AN-OBJECT" });
    expect(sign).not.toHaveBeenCalled();
  });

  it("refuses a correctly signed non-object request body before reservation", async () => {
    const x = (await world()), reserveRequest = testJournals();
    await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await x.open({ ...x.request, bodyHash: sha256Hex("[]") })), { ...x.check, rawBody: Buffer.from("[]"), requestJournal: (await reserveRequest.open()) })))).rejects
      .toThrowError(expect.objectContaining({ code: "bad_request", status: 400 }));
    expect(reserveRequest.reservations()).toHaveLength(0);
  });

  it("names an outgoing admission failure as the signer's own, with zero signatures", async () => {
    const x = (await world()), sign = vi.fn(x.seller.sign), context = { ...x.context, signer: { claim: x.seller.claim, sign }, now: NOW };
    await expect(wire.signWireResponse(x.request, 200, '{"a":1,"a":1}', context))
      .rejects.toMatchObject({ code: "outgoing_body_rejected", status: 500, detail: "DUPLICATE-MEMBER" });
    expect(sign).not.toHaveBeenCalled();
    expect(typeof await wire.signWireResponse(x.request, 200, "{}", context)).toBe("string");
    expect(sign).toHaveBeenCalledTimes(1);
  });
});

it("the receipt authentication hash is stable across accepted signature and JSON encodings", async () => {
  const x = (await world());
  const answer = { ...x.request, kind: "response", requestHash: wire.wireRequestHash(x.request), status: 200 };
  const envelope = x.signed(answer, x.seller, wire.DACS_SELLER_HTTP_DOMAINS.response);
  const hex = Buffer.from(envelope.signature, "base64url").toString("hex");
  const receipts = [];
  for (const signature of [envelope.signature, hex, hex.toUpperCase(), `0x${hex}`]) {
    for (const text of [canonicalize({ ...envelope, signature }), JSON.stringify({ signature, payload: answer }, null, 2)]) {
      receipts.push((await wire.verifyWireResponse(x.request, { ...x.context, header: Buffer.from(text).toString("base64url"), body: Buffer.from("{}"), status: 200, now: NOW })).authenticationHash);
    }
  }
  expect(new Set(receipts).size).toBe(1);
  expect(receipts[0]).toBe(sha256Hex(header(envelope)));
});

it("wallet base64url signatures round-trip after wallet prefix removal", () => {
  const signature = party(58).sign(Buffer.from("wallet encoding")).toString("base64url");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const alias = signature.slice(0, -1) + alphabet[alphabet.indexOf(signature.at(-1)!) + 1];
  expect(Buffer.from(alias, "base64url")).toEqual(Buffer.from(signature, "base64url"));
  expect(walletSignatureBytes(`0x${signature}`)).toEqual(Buffer.from(signature, "base64url"));
  expect(() => walletSignatureBytes(`0x${alias}`)).toThrowError(expect.objectContaining({ code: "peer_delegation_signature_invalid" }));
});

describe("wallet signatures on the delegation path", () => {
  const delegationFor = (x: Awaited<ReturnType<typeof world>>, wallet: ReturnType<typeof party>, notBefore = NOW - 1000): wire.SellerSessionDelegationPayload => ({
    version: "1", kind: "seller-session-delegation", buyer: wallet.claim, seller: x.seller.claim, sessionPublicKey: party().key,
    listingPin: PIN, jobId: x.request.jobId, notBefore, expiresAt: NOW + 60_000, profile: x.context.binding.profile,
  });
  const verifyAt = async (x: Awaited<ReturnType<typeof world>>, delegation: unknown, buyer: string) => (await wire.verifySellerSessionDelegation(Buffer.from(JSON.stringify(delegation)),
    { binding: x.context.binding, local: LOCAL, buyer, seller: x.seller.claim, listingPin: PIN, jobId: x.request.jobId, time: NOW }));

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
    const x = (await world()), wallet = party(), payload = delegationFor(x, wallet);
    let raw: Buffer | undefined;
    const sign = vi.fn((bytes: Uint8Array) => {
      raw = wallet.sign(bytes);
      return async ? Promise.resolve(form(raw)) : form(raw);
    });
    const delegation = await wire.signSellerSessionDelegation(payload, { claim: wallet.claim, sign }, x.context.binding, LOCAL);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledWith((await wire.sellerSessionDelegationSigningBytes(payload, x.context.binding, LOCAL)));
    expect(delegation.signature).toBe(raw!.toString("base64url"));
    expect((await verifyAt(x, delegation, wallet.claim))).toEqual(payload);
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
    const x = (await world()), wallet = party(58);
    const payload = { ...delegationFor(x, wallet, NOW - 1000 - 1160), sessionPublicKey: party(59).key };
    const raw = wallet.sign(Buffer.from(wire.DACS_SELLER_HTTP_DOMAINS.delegation + canonicalize(payload)));
    expect(raw.toString("base64url")).toBe("0XbSePmE6hvYBe1T1BNCStjdCj_ESwpSugXiezimsTxgzQ7Xl2wdxiaLk38tarYlgVxLO8ouEmxB_4kw2pD3Dw");
    expect(walletSignatureBytes(raw.toString("base64url"))).toEqual(raw);
    const delegation = await wire.signSellerSessionDelegation(payload, { claim: wallet.claim, sign: () => raw.toString("base64url") }, x.context.binding, LOCAL);
    expect(delegation.signature).toBe(raw.toString("base64url"));
    expect((await verifyAt(x, delegation, wallet.claim))).toEqual(payload);
  });
});
