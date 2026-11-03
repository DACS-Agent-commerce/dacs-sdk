import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical/index.js";
import * as w from "../../src/wire/index.js";
import * as wireJournal from "../../src/wire/journal.js";
import { journalDirectory, journalFixture, reservationsIn } from "./requestJournalFixture.js";
import { agreementFixture, retainedFixture } from "./agreementFixture.js";
import { fixtureBinder } from "./authorityFixture.js";
import { received, seededParty, signedAgreement, tp1Listing, wireCommitment } from "./commitmentFixture.js";
import { readFixtureListingEligibility } from "./listingEligibilityFixture.js";

// A22: the signed context-challenge route. Fixtures are CONTRACTS C0's (seeded keys, T0, JOB, PIN).
const CHALLENGE = "/dacs/v1/agreements/context/challenge";
const T0 = Date.UTC(2026, 9, 27, 12);
const JOB = "01M5YKPJG0248H248H248H248H";
const LOCAL = { endpoint: "https://rpc.example.invalid/", transportAuthority: "vector-authority", connectionId: "vector-conn-1" };
const ENDPOINT = "https://seller.example.invalid";
const PIN = { listingId: "tp1-vector-listing", version: 1, contentHash: "77647174c3ef5ffc6d2f65c7eacb687efb9be55e7483e4ab8d039fcb74f49441" };
const CHALLENGE_LIFETIME_MS = 600_000;
const REQUEST_LIFETIME_MS = 20_000;
const MAX_HEADER_LENGTH = 4096;
// K2-PRE-3 and K1-S2.
const SIGNING_BYTES_SHA256 = "502ef2d39ef3d639b5f44c5857fef4f0775dfca83abb32408241b8369fde8521";
const REQUEST_HASH = "e71970e3ebee24cef8f45eea8cb165ce541bb0bf63bb1c1c426c9525982d9caa";
const SCOPE_HASH = "8c4ebffd96aefd253af196f2ca782863951c19f7edd08baa27f8248455027a5f";
const REQUEST_NONCE = Buffer.alloc(16, 0x63).toString("base64url");

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const buyer = seededParty(1), seller = seededParty(2), session = seededParty(3);
const bindTp1Fixture = fixtureBinder(w);

/** The K1-S2 scope: the context scope's ten keys, without `buyerBundleHash`. */
const challengeScope = {
  source: "dacs-chatgpt-plugin/operator-agreement-context/v1", wallet: `0x${buyer.raw}`, jobId: JOB, buyer: buyer.claim, seller: seller.claim, listingPin: PIN,
  rail: { railId: "demos-native:DEM", railVersion: 1 }, payee: `0x${seller.raw}`, price: { amount: "1", currency: "DEM", amountOs: "1000000000" }, generatedAt: T0,
};
const challengeBody = canonicalize({ scope: challengeScope });

function signed<T>(payload: T, domain: string, signer: typeof buyer) {
  return { payload, signature: Buffer.from(signer.sign(Buffer.from(domain + canonicalize(payload)))).toString("base64url") };
}
const header = (envelope: unknown) => Buffer.from(canonicalize(envelope)).toString("base64url");
const refuses = async (fn: () => unknown, code: string, status: number) => {
  await expect(Promise.resolve().then(fn)).rejects.toMatchObject({ code, status });
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
  const binding = await w.bindTp1Profile({ record, local: LOCAL, readAuthority });
  /** Authority reads that named the request's participants. */
  const participantReads = () => scopes.filter((scope) => scope.participants.length > 0);
  const forgetReads = () => { scopes.length = 0; };
  return { binding, participantReads, forgetReads };
}

function requestPayload(binding: w.Tp1Binding, path: string, body: string, agreementHash: string): w.WireRequestPayload {
  return { version: "1", kind: "request", method: "POST", path, bodyHash: sha256(body), jobId: JOB, buyer: buyer.claim, seller: seller.claim,
    listingPin: PIN, agreementHash, nonce: REQUEST_NONCE, expiresAt: T0 + REQUEST_LIFETIME_MS, profile: binding.profile };
}

describe("A22 the context challenge route", () => {
  it("A22 the route table carries the signed, journal-free challenge route under the context-route option", () => {
    expect(w.DACS_SELLER_HTTP_PATHS.contextChallenge).toBe(CHALLENGE);
    const entry = w.DACS_SELLER_HTTP_ROUTES.find((r) => r.path === CHALLENGE);
    expect(entry).toEqual({ path: CHALLENGE, method: "POST", auth: "signed", effect: "read", option: "context-route" });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(w.DACS_SELLER_HTTP_ROUTES.map((r) => r.path).indexOf(CHALLENGE)).toBe(w.DACS_SELLER_HTTP_ROUTES.map((r) => r.path).indexOf(w.DACS_SELLER_HTTP_PATHS.context) + 1);
    // K2-PRE-4: the route is found.
    expect(w.findDacsSellerHttpRoute("POST", CHALLENGE)).toBe(entry);
  });

  it("A22 the challenge route matches only its exact method and raw target", async () => {
    for (const target of [`${CHALLENGE}/`, `${CHALLENGE}?x=1`, "/dacs/v1/agreements/context/%63hallenge", CHALLENGE.toUpperCase(), "/dacs/v1/agreements/context//challenge", `/${CHALLENGE}`]) {
      expect(w.findDacsSellerHttpRoute("POST", target), target).toBeNull();
    }
    expect(w.findDacsSellerHttpRoute("GET", CHALLENGE)).toBeNull();
    // A payload signed for an alias path is refused before the buyer's signer is called.
    const { binding } = await countingBinding();
    const proof = await readyProof(binding, true);
    for (const path of [`${CHALLENGE}/`, `${CHALLENGE}?x=1`, "/dacs/v1/agreements/context/%63hallenge", CHALLENGE.toUpperCase()]) {
      buyer.calls = 0;
      await refuses(() => w.signWireRequest(challengeSigningInput(binding, proof, { path })), "peer_envelope_invalid", 500);
      expect(buyer.calls, path).toBe(0);
    }
  });

  it("A22 the challenge route is never a readback route", () => {
    expect(w.DACS_SELLER_HTTP_ROUTES.find((r) => r.path === CHALLENGE)?.effect).toBe("read");
    expect(w.isReadRoute(CHALLENGE)).toBe(false);
    expect(w.DACS_SELLER_HTTP_ROUTES.filter((r) => w.isReadRoute(r.path)).map((r) => r.path)).toEqual(["/dacs/v1/agreements/state", "/dacs/v1/bundles/buyer-copy"]);
  });

  it("A22 the challenge request's signing bytes and request hash equal K2-PRE-3's target", async () => {
    const binding = await bindTp1Fixture({ record: w.TP1_APPROVED_IDENTITY_RECORD, local: LOCAL });
    const payload = requestPayload(binding, CHALLENGE, challengeBody, SCOPE_HASH);
    expect(sha256(canonicalize(challengeScope))).toBe(SCOPE_HASH);
    expect(sha256(w.DACS_SELLER_HTTP_DOMAINS.request + canonicalize(payload))).toBe(SIGNING_BYTES_SHA256);
    expect(w.wireRequestHash(payload)).toBe(REQUEST_HASH);
    // The seller opens the envelope signed over exactly those bytes.
    const opened = await w.openWireEnvelope(header(signed(payload, w.DACS_SELLER_HTTP_DOMAINS.request, buyer)), "request", { binding, local: LOCAL, purchaseProfile: binding.profile });
    expect(opened.payload).toEqual(payload);
  });

  describe("at the seller's check", () => {
    type Kind = "direct" | "delegated" | "expired delegation";
    const KINDS: readonly Kind[] = ["direct", "delegated", "expired delegation"];
    async function checking(kind: Kind, path: string, body: string, agreementHash: string) {
      const counted = await countingBinding();
      const { binding } = counted;
      const payload = requestPayload(binding, path, body, agreementHash);
      const delegationPayload = { version: "1", kind: "seller-session-delegation", buyer: buyer.claim, seller: seller.claim, sessionPublicKey: session.raw, listingPin: PIN, jobId: JOB,
        notBefore: kind === "expired delegation" ? T0 - 60_000 : T0 - 30_000, expiresAt: kind === "expired delegation" ? T0 - 1 : T0 + 3_600_000, profile: binding.profile };
      const envelope = kind === "direct" ? signed(payload, w.DACS_SELLER_HTTP_DOMAINS.request, buyer)
        : { ...signed(payload, w.DACS_SELLER_HTTP_DOMAINS.request, session), delegation: signed(delegationPayload, w.DACS_SELLER_HTTP_DOMAINS.delegation, buyer) };
      const context = { binding, local: LOCAL, purchaseProfile: binding.profile };
      const opened = await w.openWireEnvelope(header(envelope), "request", { ...context, requireDelegation: kind !== "direct" });
      const journals = journalFixture(w).testJournals();
      // Opening reads the authority too: only what the check itself reads is counted.
      counted.forgetReads();
      const check = (ready: unknown) => w.checkWireRequest(opened, { requestJournal: journals.open(), artifacts: agreementFixture(opened), retained: retainedFixture(opened), ...context,
        seller: seller.claim, listingPin: PIN, method: "POST", path, rawBody: Buffer.from(body), now: T0, requireDelegation: kind !== "direct", ...(ready === undefined ? {} : { ready }) } as w.RequestCheck);
      return { check, journals, reads: counted };
    }

    it.each(KINDS)("A22 checkWireRequest refuses the challenge path before the participant authority read, any reservation or a returned body (%s)", async (kind) => {
      const { check, journals, reads } = await checking(kind, CHALLENGE, challengeBody, SCOPE_HASH);
      for (const ready of [true, false, undefined]) {
        let returned: unknown;
        await expect(check(ready).then((result) => { returned = result; })).rejects.toMatchObject({ code: "wire_route_requires_preagreement", status: 500, category: "permanent" });
        expect(returned).toBeUndefined();
      }
      expect(reads.participantReads()).toHaveLength(0);
      expect(journals.reservations()).toHaveLength(0);
    });

    it("A22 checkWireRequest still admits an ordinary proposals request under the same binding and check fields", async () => {
      const { check, journals, reads } = await checking("direct", w.DACS_SELLER_HTTP_PATHS.proposals, "{}", SCOPE_HASH);
      await expect(check(true)).resolves.toMatchObject({ readbackOnly: false });
      // The reads the challenge refusal must precede.
      expect(reads.participantReads().map((scope) => scope.participants)).toContainEqual([buyer.claim, seller.claim]);
      expect(journals.reservations()).toHaveLength(1);
    });
  });

  it("A22 the challenge path cannot be reserved in the request journal (K5-J18)", () => {
    const directory = journalDirectory();
    const journal = w.openWireRequestJournal(directory);
    const reservation = { key: sha256("nonce key"), seller: seller.claim, jobId: JOB, path: CHALLENGE, binding: sha256("binding"), requestHash: REQUEST_HASH };
    expect(() => wireJournal.reserveEffect(wireJournal.journalStore(journal), reservation)).toThrow(expect.objectContaining({ code: "wire_input_invalid", status: 500 }));
    expect(reservationsIn(directory)).toHaveLength(0);
  });

  describe("at the buyer's signer", () => {
    async function signsUnder(ready: boolean, evidence: boolean) {
      const { binding } = await countingBinding();
      const proof = await readyProof(binding, ready);
      buyer.calls = 0;
      return { binding, attempt: () => w.signWireRequest({ ...challengeSigningInput(binding, proof), ...(evidence ? committedPurchase() : {}) }) };
    }

    it.each([false, true])("A22 a buyer signs a challenge request only under a ready proof; a commitment never makes it a continuation (commitment evidence %s)", async (evidence) => {
      const notReady = await signsUnder(false, evidence);
      await expect(notReady.attempt()).rejects.toMatchObject({ code: "seller_not_ready", status: 503 });
      expect(buyer.calls).toBe(0);
      const ready = await signsUnder(true, evidence);
      const sent = await ready.attempt();
      expect(buyer.calls).toBe(1);
      expect(sent.payload).toMatchObject({ path: CHALLENGE, agreementHash: SCOPE_HASH });
    });
  });

  it("A22 the seller signs and the buyer verifies a challenge answer and a refusal answer", async () => {
    const { binding } = await countingBinding();
    const payload = requestPayload(binding, CHALLENGE, challengeBody, SCOPE_HASH);
    const context = { binding, local: LOCAL, purchaseProfile: binding.profile };
    const answers: ReadonlyArray<[number, Record<string, unknown>]> = [
      [200, { sessionNonce: sha256("session nonce"), expiresAt: T0 + CHALLENGE_LIFETIME_MS }],
      [409, { error: "context_challenge_expired", message: "The context challenge has expired." }],
    ];
    for (const [status, body] of answers) {
      const text = canonicalize(body);
      const answer = await w.signWireResponse(payload, status, text, { ...context, signer: seller, now: T0 });
      const receipt = await w.verifyWireResponse(payload, { header: answer, status, body: Buffer.from(text), now: T0, binding, local: LOCAL });
      expect(receipt.principal).toBe(seller.claim);
      expect(receipt.body).toEqual(body);
    }
  });

  it("A22 a challenge request header over 4,096 characters is refused at opening (K2-T14)", async () => {
    const binding = await bindTp1Fixture({ record: w.TP1_APPROVED_IDENTITY_RECORD, local: LOCAL });
    const open = (listingId: string) => {
      const payload = { ...requestPayload(binding, CHALLENGE, challengeBody, SCOPE_HASH), listingPin: { ...PIN, listingId } };
      const sent = header(signed(payload, w.DACS_SELLER_HTTP_DOMAINS.request, buyer));
      return { sent, opening: () => w.openWireEnvelope(sent, "request", { binding, local: LOCAL, purchaseProfile: binding.profile }) };
    };
    expect(open("short").sent.length).toBeLessThanOrEqual(MAX_HEADER_LENGTH);
    await expect(open("short").opening()).resolves.toMatchObject({ payload: { path: CHALLENGE } });
    const oversized = open("x".repeat(MAX_HEADER_LENGTH));
    expect(oversized.sent.length).toBeGreaterThan(MAX_HEADER_LENGTH);
    await refuses(oversized.opening, "peer_envelope_invalid", 401);
  });
});

/** The buyer's kept endpoint proof for the seller's Listing; `ready` is the seller's state when it was fetched. */
async function readyProof(binding: w.Tp1Binding, ready: boolean) {
  const bytes = await w.signDiscoveryDocument({ format: "dacs-seller-discovery/v1", profile: binding.profile, seller: seller.claim, publicEndpoint: ENDPOINT,
    transport: ["dacs-seller-http/v1"], listings: [PIN], capabilities: w.TP1_CAPABILITIES, ready, issuedAt: T0, expiresAt: T0 + 60_000 }, seller, binding, LOCAL);
  return w.verifyEndpointProof(bytes, { readListingEligibility: readFixtureListingEligibility, listing: { seller: seller.claim, publicEndpoint: ENDPOINT, listingPin: PIN }, binding, local: LOCAL, now: T0 });
}

function challengeSigningInput(binding: w.Tp1Binding, endpointProof: w.EndpointProof, patch: Partial<w.WireRequestInput> = {}): w.WireRequestInput {
  return { signer: buyer, binding, local: LOCAL, seller: seller.claim, jobId: JOB, path: CHALLENGE, text: challengeBody, now: T0, publicEndpoint: ENDPOINT, endpointProof,
    job: { listingPin: PIN, agreementHash: SCOPE_HASH, profile: binding.profile }, ...patch };
}

/** A finalized commitment, its Agreement and Listing for the job: the evidence a payment request continues on. */
function committedPurchase() {
  const { listing, pin } = tp1Listing({ seller, listingId: PIN.listingId, publicEndpoint: ENDPOINT });
  const { agreement, agreementHash } = signedAgreement({ buyer, seller, jobId: JOB, listingPin: pin, listing: { listing, pin } });
  const commitment = wireCommitment({ seller, buyer: buyer.claim, jobId: JOB, agreementHash, listingPin: pin, committedAt: T0 });
  return { commitment: received(commitment), agreement: received(agreement), signedListing: received(listing) };
}
