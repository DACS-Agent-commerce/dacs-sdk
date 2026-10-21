// A payment or delivery request continues a purchase only on commitment
// evidence the wire checks itself, at the buyer and at the seller: the
// Agreement both parties signed (CA-7), the orchestrator's finality record for
// it (CA-6) and its finalized receipt. An effect is reserved only in the SDK's
// durable journal, once per job and route, with its outcome kept.
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalize, contentHash, sha256Hex } from "../../src/canonical/index.js";
import { FINALITY_COMMITMENT_SEPARATOR } from "../../src/negotiate/commitment.js";
import { FINALITY_COMMITMENT_DOMAIN } from "../../src/wire/commitment.js";
import { CONTINUING_PATHS } from "../../src/wire/discovery.js";
import * as fixtureWire from "../../src/wire/index.js";
import * as wire from "../../src/wire/index.js";
import { fixtureBinder } from "./authorityFixture.js";
import { acceptedPurchase, commitPurchase, fixedParty, received, signedAgreement, tp1Listing, validReceipt, wireCommitment } from "./commitmentFixture.js";
import { readFixtureListingEligibility } from "./listingEligibilityFixture.js";
import { journalDirectory, journalFixture } from "./requestJournalFixture.js";

const bindTp1Fixture = fixtureBinder(fixtureWire);
const { testJournal, testJournals } = journalFixture(fixtureWire);
const NOW = Date.UTC(2026, 9, 18);
const JOB = "01K7FZ8Q9W3V5T2R1N0M8K6J4H";
const OTHER_JOB = "01K7FZ8Q9W3V5T2R1N0M8K6J4J";
const LOCAL = { endpoint: "https://rpc.continuation.invalid/", transportAuthority: "test", connectionId: "1" };
// The seller is fixed, so its signed Listing, and the pin every request names, is a constant.
const SELLER = fixedParty(51);
const { listing: LISTING, pin: PIN } = tp1Listing({ seller: SELLER });
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
/** The same 86-character signature with its first byte's low bit flipped. */
const flipped = (value: string) => { const bytes = Buffer.from(value, "base64url"); bytes[0]! ^= 1; return bytes.toString("base64url"); };
/** The same signature bytes, encoded with a non-zero padding bit in the last character (A, Q, g or w): not canonical. */
const uncanonical = (value: string) => value.slice(0, -1) + String.fromCharCode(value.charCodeAt(85) + 1);

/**
 * A purchase of the seller's Listing `l` (default: LISTING), its Agreement
 * generated at `generatedAt`; `terms` changes the Agreement's terms and `patch`
 * its other members before both parties sign it. `deriveFrom` is the Listing
 * the Agreement is derived from when `l` is one the SDK cannot derive from.
 */
function world(l: ReturnType<typeof tp1Listing> = { listing: LISTING, pin: PIN },
  options: { terms?: Record<string, unknown>; patch?: Record<string, unknown>; generatedAt?: number; deriveFrom?: ReturnType<typeof tp1Listing> } = {}) {
  const buyer = party(), seller = SELLER, session = party();
  const PIN = l.pin;
  const binding = bindTp1Fixture({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local: LOCAL });
  const context = { binding, local: LOCAL, purchaseProfile: binding.profile };
  const from = options.deriveFrom ?? l;
  const base = signedAgreement({ buyer, seller, jobId: JOB, listingPin: PIN, listing: from, generatedAt: options.generatedAt });
  const { agreement, agreementHash } = options.terms === undefined && options.patch === undefined ? base
    : signedAgreement({ buyer, seller, jobId: JOB, listingPin: PIN, listing: from, generatedAt: options.generatedAt,
      patch: { ...options.patch, ...options.terms ? { terms: { ...(base.agreement as unknown as { terms: object }).terms, ...options.terms } } : {} } });
  const request = (path: string, body = "{}", n = nonce()): wire.WireRequestPayload => ({
    version: "1", kind: "request", method: "POST", path, jobId: JOB, buyer: buyer.claim, seller: seller.claim, bodyHash: sha256Hex(body),
    listingPin: PIN, agreementHash, nonce: n, expiresAt: NOW + 30_000, profile: binding.profile,
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
  const retained = { jobId: JOB, agreementHash, buyer: buyer.claim, seller: seller.claim };
  const commitment = (options: Partial<Parameters<typeof wireCommitment>[0]> = {}) =>
    wireCommitment({ seller, buyer: buyer.claim, jobId: JOB, agreementHash, listingPin: PIN, committedAt: NOW - 5000, ...options });
  const check = (path: string, body = "{}") => ({ ...context, seller: seller.claim, listingPin: PIN, method: "POST", path, rawBody: Buffer.from(body), now: NOW, retained,
    ready: true, readCommitmentReceipt: validReceipt, commitment: received(commitment()), agreement: received(agreement), signedListing: received(l.listing) });
  return { buyer, seller, binding, context, agreement, agreementHash, request, direct, delegated, artifact, retained, commitment, check, pin: PIN, listing: l.listing };
}

/** A commitment whose record signature is changed after the seller signed it; the receipt still names the record (its hash omits the signature). */
function resigned(x: ReturnType<typeof world>, signature: Record<string, unknown>) {
  const c = x.commitment();
  return { ...c, record: { ...c.record, signature: { ...c.record.signature, ...signature } } };
}

describe("the seller checks the job's finalized commitment on every payment and delivery route", () => {
  const modes = (x: ReturnType<typeof world>, path: string) => [
    ["direct", () => x.direct(x.request(path)), {}],
    ["delegated", () => x.delegated(x.request(path)), { requireDelegation: true, artifacts: [x.artifact] }],
  ] as const;

  /** Every way the commitment evidence is refused, with its own code. */
  function refusals(x: ReturnType<typeof world>): Array<[string, Record<string, unknown>, string, number]> {
    const other = party();
    const value = x.commitment().record.signature.value;
    // The seller's key signs another record: its signature is valid, but not for this one.
    const otherRecord = x.commitment({ jobId: OTHER_JOB }).record.signature.value;
    const neverSignedByBuyer = signedAgreement({ buyer: x.buyer, seller: x.seller, jobId: JOB, listingPin: PIN, signers: { buyer: other, seller: x.seller } });
    const notSignedBySeller = signedAgreement({ buyer: x.buyer, seller: x.seller, jobId: JOB, listingPin: PIN, signers: { buyer: x.buyer, seller: other } });
    const anotherAgreement = signedAgreement({ buyer: x.buyer, seller: x.seller, jobId: JOB, listingPin: PIN, generatedAt: NOW + 1 });
    const sellerRecordFor = (a: { agreementHash: string }) => x.commitment({ agreementHash: a.agreementHash });
    return [
      ["omitted", { commitment: undefined }, "seller_commitment_required", 500],
      ["absent by the seller's reader", { commitment: null }, "peer_agreement_uncommitted", 409],
      ["pending (included, not finalized)", { commitment: x.commitment({ receipt: { state: "included" } }) }, "continuation_commitment_invalid", 500],
      ["unestablished", { commitment: x.commitment({ receipt: { observationDisposition: "indeterminate" } }) }, "continuation_commitment_invalid", 500],
      ["another job", { commitment: x.commitment({ jobId: OTHER_JOB }) }, "continuation_commitment_invalid", 500],
      ["another Agreement", { commitment: x.commitment({ agreementHash: "b".repeat(64) }) }, "continuation_commitment_invalid", 500],
      ["another buyer", { commitment: x.commitment({ buyer: other.claim }) }, "continuation_commitment_invalid", 500],
      ["another seller in the record, signed by the seller", { commitment: x.commitment({ patch: { parties: [x.buyer.claim, other.claim] } }) }, "continuation_commitment_invalid", 500],
      ["another Listing", { commitment: x.commitment({ listingPin: { ...PIN, version: 2 } }) }, "continuation_commitment_invalid", 500],
      ["a legacy result", { commitment: { ...x.commitment(), recordKind: "legacy" } }, "continuation_commitment_invalid", 500],
      ["a legacy record", { commitment: x.commitment({ patch: { dacsVersion: "0.3" } }) }, "continuation_commitment_invalid", 500],
      ["a record of another version", { commitment: x.commitment({ patch: { finalityCommitmentVersion: "2" } }) }, "continuation_commitment_invalid", 500],
      ["a record of another pattern", { commitment: x.commitment({ patch: { pattern: "rfq" } }) }, "continuation_commitment_invalid", 500],
      ["a record with no valid createdAt", { commitment: x.commitment({ patch: { createdAt: -1 } }) }, "continuation_commitment_invalid", 500],
      ["a record of three parties", { commitment: x.commitment({ patch: { parties: [x.buyer.claim, x.seller.claim, other.claim] } }) }, "continuation_commitment_invalid", 500],
      ["signed by another orchestrator", { commitment: wireCommitment({ seller: x.buyer, buyer: x.buyer.claim, jobId: JOB, agreementHash: x.agreementHash, listingPin: PIN, committedAt: NOW - 5000, signer: x.seller.claim }) }, "continuation_commitment_invalid", 500],
      // CA-6: everything else right, only the signature wrong.
      ["a record signature with one bit flipped", { commitment: resigned(x, { value: flipped(value) }) }, "continuation_commitment_invalid", 500],
      ["a record signature of all A", { commitment: resigned(x, { value: "A".repeat(86) }) }, "continuation_commitment_invalid", 500],
      ["the seller's signature of another record", { commitment: resigned(x, { value: otherRecord }) }, "continuation_commitment_invalid", 500],
      ["a non-canonical encoding of the seller's signature", { commitment: resigned(x, { value: uncanonical(value) }) }, "continuation_commitment_invalid", 500],
      ["a signature labelled with another signer", { commitment: x.commitment({ signer: other.claim }) }, "continuation_commitment_invalid", 500],
      ["a signature of another algorithm", { commitment: resigned(x, { algorithm: "ecdsa-secp256k1" }) }, "continuation_commitment_invalid", 500],
      ["a signature value that is not text", { commitment: resigned(x, { value: 7 }) }, "continuation_commitment_invalid", 500],
      ["a signature with an extra member", { commitment: resigned(x, { note: "x" }) }, "continuation_commitment_invalid", 500],
      ["a stated time the receipt does not give", { commitment: { ...x.commitment(), committedAt: NOW - 4000 } }, "continuation_commitment_invalid", 500],
      ["a stated address the receipt does not give", { commitment: { ...x.commitment(), logicalAddress: `dacs3:commit:${OTHER_JOB}` } }, "continuation_commitment_invalid", 500],
      ["a stated Agreement hash the record does not give", { commitment: { ...x.commitment(), agreementHash: "b".repeat(64) } }, "continuation_commitment_invalid", 500],
      ["a stated resumption that is not a boolean", { commitment: { ...x.commitment(), resumed: "no" } }, "continuation_commitment_invalid", 500],
      ["a receipt for other content", { commitment: x.commitment({ receipt: { contentHash: "d".repeat(64) } }) }, "continuation_commitment_invalid", 500],
      ["a receipt for another address", { commitment: x.commitment({ receipt: { logicalAddress: `dacs3:commit:${OTHER_JOB}` } }) }, "continuation_commitment_invalid", 500],
      ["a receipt for another native address", { commitment: x.commitment({ receipt: { nativeAddress: "stor-other" } }) }, "continuation_commitment_invalid", 500],
      ["a receipt with no block time", { commitment: x.commitment({ receipt: { blockRef: { id: "block-1", height: "1" } } }) }, "continuation_commitment_invalid", 500],
      ["no native address", { commitment: { ...x.commitment(), nativeAddress: "" } }, "continuation_commitment_invalid", 500],
      ["an empty native address, repeated by the receipt", { commitment: { ...x.commitment({ receipt: { nativeAddress: "" } }), nativeAddress: "" } }, "continuation_commitment_invalid", 500],
      ["a native address that is not text, repeated by the receipt", { commitment: { ...x.commitment({ receipt: { nativeAddress: 7 } }), nativeAddress: 7 } }, "continuation_commitment_invalid", 500],
      ["no receipt", { commitment: { ...x.commitment(), anchorReceipt: null } }, "continuation_commitment_invalid", 500],
      ["a receipt that is not a record", { commitment: { ...x.commitment(), anchorReceipt: "finalized" } }, "continuation_commitment_invalid", 500],
      ["no transaction reference", { commitment: { ...x.commitment(), anchorTxRef: "tx" } }, "continuation_commitment_invalid", 500],
      ["a receipt time past the skew", { commitment: x.commitment({ committedAt: NOW + 30_001 }) }, "continuation_commitment_invalid", 500],
      // CA-7: a correctly anchored seller record, for an Agreement the parties did not both sign.
      ["no Agreement", { agreement: undefined }, "continuation_agreement_invalid", 500],
      ["an Agreement the buyer never signed", { agreement: neverSignedByBuyer.agreement, commitment: sellerRecordFor(neverSignedByBuyer), retained: { ...x.retained, agreementHash: neverSignedByBuyer.agreementHash } }, "continuation_agreement_invalid", 500],
      ["an Agreement the seller never signed", { agreement: notSignedBySeller.agreement, commitment: sellerRecordFor(notSignedBySeller), retained: { ...x.retained, agreementHash: notSignedBySeller.agreementHash } }, "continuation_agreement_invalid", 500],
      ["another signed Agreement than the record commits", { agreement: anotherAgreement.agreement }, "continuation_agreement_invalid", 500],
      ["the Agreement with its buyer signature removed", { agreement: { ...x.agreement, signatures: [x.agreement.signatures[1]] } }, "continuation_agreement_invalid", 500],
      ["the Agreement with the seller's signature twice", { agreement: { ...x.agreement, signatures: [x.agreement.signatures[1], x.agreement.signatures[1]] } }, "continuation_agreement_invalid", 500],
      ["the Agreement with a flipped buyer signature", { agreement: { ...x.agreement, signatures: [{ ...x.agreement.signatures[0]!, value: flipped(x.agreement.signatures[0]!.value) }, x.agreement.signatures[1]] } }, "continuation_agreement_invalid", 500],
      // CORE §B.7 SIG-6: the buyer's own signature bytes, in a non-canonical encoding.
      ["the Agreement with a non-canonical buyer signature encoding", { agreement: { ...x.agreement, signatures: [{ ...x.agreement.signatures[0]!, value: uncanonical(x.agreement.signatures[0]!.value) }, x.agreement.signatures[1]] } }, "continuation_agreement_invalid", 500],
      ["no receipt reader", { readCommitmentReceipt: undefined }, "commitment_reader_required", 500],
      ["the reader finds it invalid", { readCommitmentReceipt: () => "invalid" }, "continuation_commitment_invalid", 500],
      ["the reader cannot tell", { readCommitmentReceipt: () => "indeterminate" }, "commitment_unverified", 503],
      ["the reader errs", { readCommitmentReceipt: () => "error" }, "commitment_unverified", 503],
      ["the reader answers later", { readCommitmentReceipt: async () => "valid" }, "commitment_reader_invalid", 500],
    ];
  }

  it.each(CONTINUING)("%s refuses missing, pending, forged or foreign evidence before any reservation, direct and delegated", (path) => {
    const x = world();
    const journals = testJournals();
    const journal = journals.open();
    for (const [mode, open, extra] of modes(x, path)) {
      for (const [name, change, code, status] of refusals(x)) {
        const retained = (change.retained ?? x.retained) as typeof x.retained;
        const opened = change.retained ? (mode === "direct" ? x.direct : x.delegated)({ ...x.request(path), agreementHash: retained.agreementHash }) : open();
        // Each refusal is given as received bytes, so it is refused for its own fault, never for not being admitted.
        const given = { ...change, ..."commitment" in change ? { commitment: received(change.commitment) } : {}, ..."agreement" in change ? { agreement: received(change.agreement) } : {} };
        expect(() => wire.checkWireRequest(opened, { ...x.check(path), ...extra, requestJournal: journal, ...given } as wire.RequestCheck), `${mode}: ${name}`)
          .toThrowError(expect.objectContaining({ code, status }));
      }
      // The reader's own failure keeps its cause.
      const timeout = new Error("receipt lookup timed out");
      expect(() => wire.checkWireRequest(open(), { ...x.check(path), ...extra, requestJournal: journal, readCommitmentReceipt: () => { throw timeout; } } as wire.RequestCheck)).toThrow(timeout);
    }
    expect(journals.reservations()).toHaveLength(0);
    // The seller's own records, read again as bytes, continue the purchase; so do the values the wire admitted from them.
    for (const [mode, open, extra] of modes(x, path)) {
      const given = mode === "direct" ? { commitment: received(x.commitment()), agreement: received(x.agreement) }
        : { commitment: wire.admitWireArtifact(received(x.commitment()) as Buffer), agreement: wire.admitWireArtifact(received(x.agreement) as Buffer) };
      expect(wire.checkWireRequest(open(), { ...x.check(path), ...extra, requestJournal: journals.open(), ...given } as wire.RequestCheck).readbackOnly).toBe(false);
    }
    expect(journals.reservations()).toHaveLength(2);
  });

  it("asks the receipt reader every time, with an owned frozen copy of the anchored commitment", () => {
    const x = world();
    const seen: unknown[] = [];
    const reader = (anchored: unknown) => { seen.push(anchored); return "valid"; };
    for (const path of CONTINUING) wire.checkWireRequest(x.direct(x.request(path)), { ...x.check(path), requestJournal: testJournal(), readCommitmentReceipt: reader });
    expect(seen).toHaveLength(3);
    for (const anchored of seen) {
      expect(Object.keys(anchored as object).sort()).toEqual(["anchorReceipt", "anchorTxRef", "nativeAddress", "record"]);
      expect(Object.isFrozen((anchored as { record: object }).record)).toBe(true);
    }
  });

  it("routes that start a purchase and read routes need no commitment", () => {
    const x = world();
    for (const path of [P.proposals, P.commitments, P.commitmentSignature, P.context, P.state, P.bundleBuyerCopy]) {
      expect(wire.checkWireRequest(x.direct(x.request(path)), { ...x.check(path), commitment: undefined, agreement: undefined, readCommitmentReceipt: undefined, requestJournal: testJournal() }).readbackOnly).toBe(false);
    }
  });

  it("selects the Agreement type from the pinned Listing's own commit phase before any signature: only commit-agreement with an AgreementDocument continues", () => {
    const x = world();
    // A payee-bound document both parties signed, committed by the seller: only its type is wrong for a commit-agreement Listing.
    const payeeBoundFor = (w: ReturnType<typeof world>) => {
      const { signatures: _signatures, agreementVersion: _version, ...rest } = w.agreement as unknown as Record<string, unknown>;
      void _signatures; void _version;
      const unsigned = { ...rest, payeeBoundAgreementVersion: "1" };
      const hash = contentHash(unsigned);
      const signedBytes = Buffer.from(`dacs-agreement:v1:${hash}`, "utf8");
      return { hash, document: { ...unsigned, signatures: [w.buyer, w.seller].map((p) => ({ party: p.claim, algorithm: "ed25519", value: p.sign(signedBytes).toString("base64url") })) } };
    };
    let reads = 0;
    const reader = () => { reads++; return "valid"; };
    const at = (w: ReturnType<typeof world>, path: string, document: "agreement" | "payee-bound", extra: Record<string, unknown> = {}) => {
      const payee = payeeBoundFor(w);
      const hash = document === "agreement" ? w.agreementHash : payee.hash;
      return () => wire.checkWireRequest(w.direct({ ...w.request(path), agreementHash: hash }), {
        ...w.check(path), requestJournal: testJournal(), readCommitmentReceipt: reader,
        retained: { ...w.retained, agreementHash: hash }, agreement: received(document === "agreement" ? w.agreement : payee.document),
        commitment: received(w.commitment({ agreementHash: hash })), ...extra,
      } as wire.RequestCheck);
    };
    const phaseRefused = expect.objectContaining({ code: "continuation_phase_unsupported", status: 500 });
    // The seller's own Listings whose commit phase is another kind: each is the Listing its request, Agreement and record pin.
    const pipeline = (commit: Record<string, unknown>) => [{ kind: "negotiate-fixed-price" }, commit, { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } }, { kind: "deliver-storage-program" }];
    const payeeBound = world(tp1Listing({ seller: SELLER, listingId: "payee-bound", patch: { pipeline: pipeline({ kind: "commit-payee-bound-agreement" }) } }),
      { deriveFrom: tp1Listing({ seller: SELLER, listingId: "payee-bound" }) });
    for (const path of CONTINUING) {
      // The diagonal TP-1 commits.
      expect(at(x, path, "agreement")().effect).toMatchObject({ state: "new" });
      // Off-diagonal: a commit-agreement Listing with a payee-bound document.
      expect(at(x, path, "payee-bound"), path).toThrowError(expect.objectContaining({ code: "continuation_agreement_invalid", status: 500 }));
      // A payee-bound Listing, with either document: refused before anything is read.
      for (const document of ["agreement", "payee-bound"] as const) expect(at(payeeBound, path, document), `${path} ${document}`).toThrowError(phaseRefused);
      // Before any signature: a forged record signature under a payee-bound Listing is still a phase refusal.
      expect(at(payeeBound, path, "agreement", { commitment: received(resigned(payeeBound, { value: "A".repeat(86) })) }), path).toThrowError(phaseRefused);
      // A host's phase label decides nothing: the label an earlier version took is ignored either way.
      expect(at(x, path, "agreement", { commitPhase: "commit-payee-bound-agreement" })().effect).toMatchObject({ state: "new" });
      expect(at(payeeBound, path, "agreement", { commitPhase: "commit-agreement" }), path).toThrowError(phaseRefused);
    }
    expect(reads).toBe(6);
  });

  it("reads the Listing from its own bytes: it must be the one the request, record and Agreement pin, the seller's, and select one fixed-price commitment", () => {
    const x = world();
    const listingRefused = (detail?: string) => expect.objectContaining({ code: "continuation_listing_invalid", status: 500, ...detail ? { detail } : {} });
    const check = (w: ReturnType<typeof world>, signedListing: unknown, path: string = P.payments) => () =>
      wire.checkWireRequest(w.direct(w.request(path)), { ...w.check(path), requestJournal: testJournal(), signedListing });
    const other = party();
    const cases: Array<[string, ReturnType<typeof world>, unknown]> = [
      ["no Listing", x, undefined],
      ["the seller's other Listing", x, received(tp1Listing({ seller: SELLER, listingId: "other-report" }).listing)],
      ["the Listing with one member changed after it was pinned", x, received({ ...LISTING, offering: { ...LISTING.offering, title: "Another report" } })],
      ["the Listing as another version", x, received({ ...LISTING, listingVersion: 2 })],
      ["not a Listing", x, received({ ...LISTING, pipeline: "commit-agreement" })],
      // Pinned by the request, the record and the Agreement, but not the seller's: another party presents it.
      ["a Listing another party presents", world(tp1Listing({ seller: other, listingId: "not-the-sellers" }), { deriveFrom: tp1Listing({ seller: SELLER, listingId: "not-the-sellers" }) }),
        received(tp1Listing({ seller: other, listingId: "not-the-sellers" }).listing)],
    ];
    for (const [name, w, given] of cases) for (const path of CONTINUING) expect(check(w, given, path), `${name} ${path}`).toThrowError(listingRefused());
    // Pinned, the seller's, but outside what the SDK gate commits.
    // The Agreement is derived from the seller's valid Listing of the same id, then pins this one.
    const pinned = (listingId: string, patch: Record<string, unknown>) => {
      const l = tp1Listing({ seller: SELLER, listingId, patch });
      return [world(l, { deriveFrom: tp1Listing({ seller: SELLER, listingId }) }), received(l.listing)] as const;
    };
    for (const [name, [w, given], code] of [
      ["no deadlineSecAfterCommit", pinned("no-deadline", { terms: {} }), "continuation_listing_invalid"],
      ["a zero deadlineSecAfterCommit", pinned("zero-deadline", { terms: { deadlineSecAfterCommit: 0 } }), "continuation_listing_invalid"],
      ["auto-accept", pinned("auto-accept", { terms: { deadlineSecAfterCommit: 600, acceptanceModel: "auto-accept" } }), "continuation_listing_invalid"],
      // A fixed-price Listing that negotiates by RFQ is not a coherent DACS-1 Listing.
      ["an RFQ negotiation", pinned("rfq", { pipeline: [{ kind: "negotiate-rfq" }, { kind: "commit-agreement" }, { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } }, { kind: "deliver-storage-program" }] }), "continuation_listing_invalid"],
    ] as const) {
      expect(check(w, given), name).toThrowError(expect.objectContaining({ code, status: 500 }));
    }
    // A caller's object, or a copy of an admitted one, is not admitted.
    const admitted = wire.admitWireArtifact(received(LISTING) as Buffer);
    for (const given of [LISTING, structuredClone(admitted), JSON.stringify(LISTING)]) expect(check(x, given)).toThrowError(listingRefused("ARTIFACT-NOT-ADMITTED"));
    expect(check(x, Buffer.from(JSON.stringify(LISTING).replace('"dacsVersion":"1"', '"dacsVersion":"1","dacsVersion":"1"')))).toThrowError(listingRefused("DUPLICATE-MEMBER"));
    // Its exact bytes, or the value admitWireArtifact returned, continue.
    for (const given of [received(LISTING), admitted]) expect(check(x, given)().effect).toMatchObject({ state: "new" });
  });

  it("checks the signed Agreement's terms against the pinned Listing (DACS-3 §8.5.2 checks 1-4) on every continuing route, direct and delegated", () => {
    // Each Agreement is signed by both parties and committed by the seller's own finalized record: only its terms differ from the Listing's.
    const terms = (signedAgreement({ buyer: party(), seller: SELLER, jobId: JOB, listingPin: PIN }).agreement as unknown as { terms: Record<string, unknown> }).terms;
    const deliverable = terms.deliverable as Record<string, unknown>;
    const { rail: _rail, ...noRail } = terms;
    void _rail;
    const termsRefused = expect.objectContaining({ code: "continuation_agreement_invalid", status: 500, detail: "LISTING-TERMS" });
    const cases: Array<[string, { terms?: Record<string, unknown>; patch?: Record<string, unknown> }]> = [
      ["a price of 2 DEM under the 1 DEM Listing (check 2)", { terms: { price: { amount: "2", currency: "DEM" } } }],
      ["the listed amount in another currency (check 1)", { terms: { price: { amount: "1", currency: "XDM" } } }],
      ["a rail of another version than the Listing accepts (check 3)", { terms: { rail: { railId: "demos-native:DEM", railVersion: 2 } } }],
      ["a rail with members the accepted reference lacks (check 3)", { terms: { rail: { railId: "demos-native:DEM", railVersion: 1, parameters: { memo: "x" } } } }],
      ["another rail (check 3)", { terms: { rail: { railId: "demos-native:OTHER", railVersion: 1 } } }],
      ["no rail under a pay-dem Listing (check 3)", { patch: { terms: noRail } }],
      ["another deliverable type (check 4)", { terms: { deliverable: { ...deliverable, deliverableType: "attested-payload" } } }],
      ["another deliverable hash (check 4)", { terms: { deliverable: { ...deliverable, hash: "e".repeat(64) } } }],
      ["a schemaUrl the Listing does not declare (check 4)", { terms: { deliverable: { ...deliverable, schemaUrl: "https://schema.continuation.invalid/report.json" } } }],
    ];
    for (const [name, change] of cases) {
      const w = world({ listing: LISTING, pin: PIN }, change);
      for (const path of CONTINUING) {
        const journals = testJournals();
        const direct = () => wire.checkWireRequest(w.direct(w.request(path)), { ...w.check(path), requestJournal: journals.open() });
        const delegated = () => wire.checkWireRequest(w.delegated(w.request(path)), { ...w.check(path), requireDelegation: true, artifacts: [w.artifact], requestJournal: journals.open() } as wire.RequestCheck);
        expect(direct, `${name} ${path} direct`).toThrowError(termsRefused);
        expect(delegated, `${name} ${path} delegated`).toThrowError(termsRefused);
        expect(journals.reservations(), `${name} ${path}`).toHaveLength(0);
      }
    }
    // The SDK verifier's own reason is kept as the cause.
    const w = world({ listing: LISTING, pin: PIN }, cases[0]![1]);
    let thrown: unknown;
    try { wire.checkWireRequest(w.direct(w.request(P.payments)), { ...w.check(P.payments), requestJournal: testJournal() }); } catch (error) { thrown = error; }
    expect((thrown as Error).cause).toEqual(expect.objectContaining({ message: expect.stringMatching(/price/) }));
    // The Agreement derived from the Listing continues.
    const derived = world();
    expect(wire.checkWireRequest(derived.direct(derived.request(P.payments)), { ...derived.check(P.payments), requestJournal: testJournal() }).effect).toMatchObject({ state: "new" });
  });

  it("continues only a TP-1 Listing: fixed DEM pricing, one pay-dem phase, and deliver-storage-program with a storage-program deliverable (DACS-4 §9.6.1)", () => {
    const pipeline = (pay: Array<Record<string, unknown>>, deliver: Array<Record<string, unknown>>) =>
      [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, ...pay, ...deliver];
    const PAY_DEM = { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } };
    const attested = { kind: "attested-payload", payloadFormat: "text/plain", verificationMethod: { kind: "self-signed" } };
    // Each Agreement is derived from its own Listing, so its terms match it: only the Listing's TP-1 shape is wrong.
    const cases: Array<[string, Record<string, unknown>, string, string]> = [
      ["deliver-storage-program with an attested-payload deliverable", { offering: { ...LISTING.offering, deliverable: attested } }, "continuation_listing_invalid", "DELIVERABLE-KIND"],
      ["deliver-attested-payload", { offering: { ...LISTING.offering, deliverable: attested }, pipeline: pipeline([PAY_DEM], [{ kind: "deliver-attested-payload" }]) }, "continuation_phase_unsupported", "DELIVERY-PHASE"],
      ["two delivery phases", { pipeline: pipeline([PAY_DEM], [{ kind: "deliver-storage-program" }, { kind: "deliver-storage-program" }]) }, "continuation_phase_unsupported", "DELIVERY-PHASE"],
      ["two pay-dem phases", { pipeline: pipeline([PAY_DEM, PAY_DEM], [{ kind: "deliver-storage-program" }]) }, "continuation_phase_unsupported", "PAY-PHASE"],
      ["negotiable pricing", { pricing: { kind: "negotiable", bandCenter: { amount: "1", currency: "DEM" }, minPct: 0, maxPct: 10 } }, "continuation_listing_invalid", "TP1-PRICING"],
      ["a fixed price in another currency", { pricing: { kind: "fixed", price: { amount: "1", currency: "XDM" } } }, "continuation_listing_invalid", "TP1-PRICING"],
    ];
    for (const [name, patch, code, detail] of cases) {
      const l = tp1Listing({ seller: SELLER, listingId: `shape-${cases.findIndex(([n]) => n === name)}`, patch });
      const w = world(l);
      for (const path of CONTINUING) {
        const journals = testJournals();
        expect(() => wire.checkWireRequest(w.direct(w.request(path)), { ...w.check(path), requestJournal: journals.open() }), `${name} ${path} direct`)
          .toThrowError(expect.objectContaining({ code, status: 500, detail }));
        expect(() => wire.checkWireRequest(w.delegated(w.request(path)), { ...w.check(path), requireDelegation: true, artifacts: [w.artifact], requestJournal: journals.open() } as wire.RequestCheck),
          `${name} ${path} delegated`).toThrowError(expect.objectContaining({ code, status: 500, detail }));
        expect(journals.reservations(), `${name} ${path}`).toHaveLength(0);
      }
    }
    // The canonical TP-1 Listing is this shape, and continues.
    expect(LISTING.offering.deliverable.kind).toBe("storage-program");
    expect(LISTING.pipeline.map((phase) => phase.kind)).toEqual(["negotiate-fixed-price", "commit-agreement", "pay-dem", "deliver-storage-program"]);
  });

  it("re-evaluates DACS-3 §8.5.2 checks 5 and 6 at the receipt time from the seller's own Listing, on every continuing route, direct and delegated", () => {
    // A Listing that ended ten minutes ago: a purchase committed while it was valid continues; one committed after it ended does not (check 6).
    const notBefore = NOW - 3_600_000, notAfter = NOW - 600_000;
    const ended = tp1Listing({ seller: SELLER, listingId: "ended", validity: { notBefore, notAfter } });
    const w = world(ended, { generatedAt: notBefore });
    const generatedAt = (w.agreement as unknown as { generatedAt: number }).generatedAt;
    const deadline = (w.agreement as unknown as { terms: { deadline: number } }).terms.deadline;
    expect(deadline).toBe(generatedAt + 600_000);
    const invalid = expect.objectContaining({ code: "continuation_commitment_invalid", status: 500 });
    const modes = (x: ReturnType<typeof world>, path: string) => [
      ["direct", () => x.direct(x.request(path)), {}],
      ["delegated", () => x.delegated(x.request(path)), { requireDelegation: true, artifacts: [{ ...x.artifact, listingRef: x.pin }] }],
    ] as const;
    const run = (x: ReturnType<typeof world>, path: string, committedAt: number) => modes(x, path).map(([mode, open, extra]) => [mode, () =>
      wire.checkWireRequest(open(), { ...x.check(path), ...extra, requestJournal: testJournal(), commitment: received(x.commitment({ committedAt })) } as wire.RequestCheck)] as const);
    // An Agreement generated before the Listing opened (a hand-built one): its commitment before notBefore is refused.
    // Its deadline is within the limit, so only notBefore refuses it.
    const early = world(ended, { generatedAt: notBefore, patch: { generatedAt: notBefore - 2000 }, terms: { deadline: notBefore + 590_000 } });
    // Its deadline at the limit committedAt + deadlineSecAfterCommit, and one millisecond past it (check 5).
    const atLimit = world(ended, { generatedAt: notBefore, terms: { deadline: notBefore + 1000 + 600_000 } });
    const pastLimit = world(ended, { generatedAt: notBefore, terms: { deadline: notBefore + 1000 + 600_001 } });
    // Committed at the Agreement's own deadline, and one millisecond after it.
    const atDeadline = world(ended, { generatedAt: notBefore, terms: { deadline: notBefore + 1000 } });
    const pastDeadline = world(ended, { generatedAt: notBefore, terms: { deadline: notBefore + 999 } });
    // Its deadline is after notAfter, so only notAfter decides there.
    const late = world(ended, { generatedAt: notBefore, terms: { deadline: notAfter + 1000 } });
    for (const path of CONTINUING) {
      for (const [mode, check] of run(late, path, notAfter)) expect(check().effect, `${path} ${mode}: at notAfter`).toMatchObject({ state: "new" });
      for (const [mode, check] of run(late, path, notAfter + 1)) expect(check, `${path} ${mode}: after notAfter`).toThrowError(invalid);
      for (const [mode, check] of run(w, path, notBefore)) expect(check().effect, `${path} ${mode}: at notBefore`).toMatchObject({ state: "new" });
      for (const [mode, check] of run(early, path, notBefore - 1)) expect(check, `${path} ${mode}: before notBefore`).toThrowError(invalid);
      for (const [mode, check] of run(atLimit, path, notBefore + 1000)) expect(check().effect, `${path} ${mode}: deadline at the limit`).toMatchObject({ state: "new" });
      for (const [mode, check] of run(pastLimit, path, notBefore + 1000)) expect(check, `${path} ${mode}: deadline past the limit`).toThrowError(invalid);
      for (const [mode, check] of run(atDeadline, path, notBefore + 1000)) expect(check().effect, `${path} ${mode}: committed at the deadline`).toMatchObject({ state: "new" });
      for (const [mode, check] of run(pastDeadline, path, notBefore + 1000)) expect(check, `${path} ${mode}: committed after the deadline`).toThrowError(invalid);
      // A deadline ten years out, as a seller-signed record could commit after the gate refused it.
      for (const [mode, check] of run(world(ended, { generatedAt: notBefore, terms: { deadline: NOW + 10 * 365 * 86_400_000 } }), path, notBefore + 1000)) {
        expect(check, `${path} ${mode}: deadline ten years out`).toThrowError(invalid);
      }
    }
  });

  it("refuses the record the SDK's own gate anchored and then refused after finality, when the seller reads it back", async () => {
    const purchase = await acceptedPurchase({ jobId: JOB, generatedAt: NOW, validity: { notBefore: NOW - 600_000, notAfter: NOW + 10_000 }, publicEndpoint: ENDPOINT });
    await expect(commitPurchase(purchase, NOW + 20_000)).rejects.toThrow(/authoritative agreement\/Listing checks/);
    // The same seller-signed, finalized record, as the seller's host reads it back from the chain after a restart.
    const record = wireCommitment({ seller: purchase.seller, buyer: purchase.buyer.claim, jobId: JOB, agreementHash: purchase.agreementHash, listingPin: purchase.pin, committedAt: NOW + 20_000 });
    const binding = bindTp1Fixture({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local: LOCAL });
    const at = NOW + 25_000;
    for (const path of CONTINUING) {
      const payload: wire.WireRequestPayload = { version: "1", kind: "request", method: "POST", path, bodyHash: sha256Hex("{}"), jobId: JOB, buyer: purchase.buyer.claim,
        seller: purchase.seller.claim, listingPin: purchase.pin, agreementHash: purchase.agreementHash, nonce: nonce(), expiresAt: at + 30_000, profile: binding.profile };
      const signature = Buffer.from(purchase.buyer.signBytes(Buffer.from(wire.DACS_SELLER_HTTP_DOMAINS.request + canonicalize(payload)))).toString("base64url");
      const opened = wire.openWireEnvelope(header({ payload, signature }), "request", { binding, local: LOCAL, purchaseProfile: binding.profile });
      expect(() => wire.checkWireRequest(opened, { binding, local: LOCAL, purchaseProfile: binding.profile, seller: purchase.seller.claim, listingPin: purchase.pin, method: "POST", path,
        rawBody: Buffer.from("{}"), now: at, retained: { jobId: JOB, agreementHash: purchase.agreementHash, buyer: purchase.buyer.claim, seller: purchase.seller.claim },
        requestJournal: testJournal(), commitment: received(record), agreement: received(purchase.agreement), signedListing: received(purchase.listing), readCommitmentReceipt: validReceipt }), path)
        .toThrowError(expect.objectContaining({ code: "continuation_commitment_invalid", status: 500 }));
    }
  });

  it("admits the commitment and Agreement from their exact received bytes (CF-5): a caller's object or a copy is refused", () => {
    const x = world();
    const journals = testJournals();
    const check = (given: Record<string, unknown>) => () => wire.checkWireRequest(x.direct(x.request(P.payments)), { ...x.check(P.payments), requestJournal: journals.open(), ...given });
    const refused = (code: string, detail: string) => expect.objectContaining({ code, status: 500, detail });
    const commitmentText = JSON.stringify(x.commitment()), agreementText = JSON.stringify(x.agreement);
    const record = x.commitment().record;
    const malformed: Array<[string, Buffer, string]> = [
      ["a duplicate member", Buffer.from(commitmentText.replace('"finalityCommitmentVersion":"1"', '"finalityCommitmentVersion":"1","finalityCommitmentVersion":"1"')), "DUPLICATE-MEMBER"],
      ["ill-formed UTF-8", Buffer.concat([Buffer.from(commitmentText.replace('"stor-commitment"', '"stor-')), Buffer.from([0xc3, 0x28]), Buffer.from('"' + commitmentText.slice(commitmentText.indexOf('"stor-commitment"') + 17))]), "INVALID-UTF8"],
      ["a number outside the profile", Buffer.from(commitmentText.replace(`"createdAt":${record.createdAt}`, '"createdAt":9007199254740993')), "NUMBER-OUTSIDE-DACS-MAGNITUDE"],
      ["nesting past 128", Buffer.from(commitmentText.replace('"resumed":false', `"resumed":false,"deep":${"[".repeat(128)}${"]".repeat(128)}`)), "JSON-NESTING-TOO-DEEP"],
    ];
    for (const [name, bytes, detail] of malformed) {
      expect(check({ commitment: bytes }), name).toThrowError(refused("continuation_commitment_invalid", detail));
      expect(check({ agreement: Buffer.from(agreementText.replace('"agreementVersion":"1"', '"agreementVersion":"1","agreementVersion":"1"')) }), name)
        .toThrowError(refused("continuation_agreement_invalid", "DUPLICATE-MEMBER"));
    }
    // The same evidence as a caller's object, a decoded string, or a copy of an admitted value: nothing shows its bytes were admitted.
    const admitted = wire.admitWireArtifact(Buffer.from(commitmentText));
    for (const given of [x.commitment(), commitmentText, JSON.parse(JSON.stringify(admitted)), structuredClone(admitted)]) {
      expect(check({ commitment: given })).toThrowError(refused("continuation_commitment_invalid", "ARTIFACT-NOT-ADMITTED"));
    }
    expect(check({ agreement: x.agreement })).toThrowError(refused("continuation_agreement_invalid", "ARTIFACT-NOT-ADMITTED"));
    expect(journals.reservations()).toHaveLength(0);
    // Exact bytes, a value admitWireArtifact returned, or part of an admitted body continue.
    const sent = Buffer.from(JSON.stringify({ commitment: x.commitment(), agreement: x.agreement }));
    const body = wire.admitWireRequestBody(sent), answer = wire.admitWireResponseBody(sent);
    expect(Object.isFrozen(body.commitment)).toBe(true);
    expect(Object.isFrozen(answer.agreement)).toBe(true);
    for (const given of [{}, { commitment: admitted, agreement: wire.admitWireArtifact(Buffer.from(agreementText)) }, { commitment: body.commitment, agreement: body.agreement },
      { commitment: answer.commitment, agreement: answer.agreement }]) {
      expect(check(given)().effect).toMatchObject({ state: "new" });
    }
    // admitWireArtifact keeps admission's own refusal.
    expect(() => wire.admitWireArtifact(malformed[0]![1])).toThrowError(expect.objectContaining({ code: "wire_artifact_rejected", status: 500, detail: "DUPLICATE-MEMBER" }));
    expect(() => wire.admitWireArtifact(commitmentText as never)).toThrowError(expect.objectContaining({ code: "wire_input_invalid", status: 500 }));
  });

  it("checks the receipt as a CORE §5.1 AnchorReceipt, its transaction as a ChainTxRef, and a receipt time no earlier than the Agreement", () => {
    const x = world();
    const full = x.commitment();
    const { receiptVersion: _v, substrate: _s, finalityProfile: _f, transactionRef: _t, writer: _w, observedAt: _o, evidence: _e, nonce: _n, ...six } = full.anchorReceipt;
    void _v; void _s; void _f; void _t; void _w; void _o; void _e; void _n;
    const generatedAt = (x.agreement as unknown as { generatedAt: number }).generatedAt;
    const cases: Array<[string, unknown]> = [
      ["a receipt with only the members the wire once read", { ...full, anchorReceipt: six }],
      ["an empty transaction reference", { ...full, anchorTxRef: {} }],
      ["a transaction reference of no known kind", { ...full, anchorTxRef: { kind: "other", value: "tx" } }],
      ["a receipt of another version with no finality profile", { ...full, anchorReceipt: (({ finalityProfile: _p, ...r }) => (void _p, { ...r, receiptVersion: "9" }))(full.anchorReceipt) }],
      ["a receipt time before the Agreement was generated", x.commitment({ committedAt: generatedAt - 1 })],
    ];
    for (const [name, commitment] of cases) {
      expect(() => wire.checkWireRequest(x.direct(x.request(P.payments)), { ...x.check(P.payments), requestJournal: testJournal(), commitment: received(commitment) }), name)
        .toThrowError(expect.objectContaining({ code: "continuation_commitment_invalid", status: 500 }));
    }
    // At the Agreement's own time, it continues.
    expect(wire.checkWireRequest(x.direct(x.request(P.payments)), { ...x.check(P.payments), requestJournal: testJournal(), commitment: received(x.commitment({ committedAt: generatedAt })) }).effect)
      .toMatchObject({ state: "new" });
  });

  it("pins the commitment domain to the SDK gate's, and the continuing routes cannot be changed", () => {
    expect(FINALITY_COMMITMENT_DOMAIN).toBe(FINALITY_COMMITMENT_SEPARATOR);
    expect(Object.isFrozen(CONTINUING_PATHS)).toBe(true);
    expect([...CONTINUING_PATHS]).toEqual([...CONTINUING]);
  });
});

describe("a TP-1 buyer continues a purchase whose commitment it received from the seller", () => {
  // The seller is the orchestrator (G3): only its process runs commitFixedPriceAgreement. The buyer gets the result as bytes.
  const windowed: wire.ListingEligibilityReader = (scope) => ({ ...(readFixtureListingEligibility(scope) as object), notBefore: NOW - 1000, expiresAt: NOW + 60_000 });
  const ENDED = NOW + 120_000;

  async function committed(validity = { notBefore: NOW - 600_000, notAfter: NOW + 600_000 }) {
    const purchase = await acceptedPurchase({ jobId: JOB, generatedAt: NOW, validity, publicEndpoint: ENDPOINT });
    const { buyer, seller, pin } = purchase;
    const sellerResult = await commitPurchase(purchase, NOW + 1000);
    const binding = bindTp1Fixture({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local: LOCAL });
    const discoveryAt = (issuedAt: number) => wire.signDiscoveryDocument({ format: "dacs-seller-discovery/v1", profile: binding.profile, seller: seller.claim, publicEndpoint: ENDPOINT,
      transport: ["dacs-seller-http/v1"], listings: [pin], capabilities: wire.TP1_CAPABILITIES, ready: false, issuedAt, expiresAt: issuedAt + 60_000 }, seller, binding, LOCAL);
    const discovery = await discoveryAt(ENDED - 1000), early = await discoveryAt(NOW + 20_000);
    const listing = { seller: seller.claim, publicEndpoint: ENDPOINT, listingPin: pin };
    const input = (commitment: unknown, agreement: unknown, endpointProof: wire.EndpointProof, path: string = P.payments) => ({ signer: buyer, binding, local: LOCAL, seller: seller.claim, jobId: JOB, path, text: "{}",
      job: { listingPin: pin, agreementHash: purchase.agreementHash, profile: binding.profile }, now: ENDED, publicEndpoint: ENDPOINT, endpointProof, commitment, agreement, signedListing: received(purchase.listing) });
    return { purchase, buyer, seller, pin, sellerResult, sent: Buffer.from(JSON.stringify({ commitment: sellerResult, agreement: purchase.agreement })), binding, discovery, early, listing, input };
  }

  it("after the Listing ends and the seller drains, from the seller's bytes, and again after a restart", async () => {
    const { purchase, buyer, seller, pin, sellerResult, sent, binding, discovery, early, listing, input } = await committed();
    // Each "process" of the buyer parses the seller's bytes on its own: no object is shared with the gate.
    for (const run of ["first", "after restart"]) {
      const got = wire.admitWireArtifact(sent) as { commitment: unknown; agreement: unknown };
      const endpointProof = wire.verifyEndpointProof(discovery, { readListingEligibility: windowed, readCommitmentReceipt: validReceipt, listing, binding, local: LOCAL, now: ENDED, commitment: got.commitment, agreement: got.agreement, signedListing: received(purchase.listing) });
      const request = await wire.signWireRequest(input(got.commitment, got.agreement, endpointProof));
      const opened = wire.openWireEnvelope(request.header, "request", { binding, local: LOCAL, purchaseProfile: binding.profile });
      expect(wire.checkWireRequest(opened, { binding, local: LOCAL, purchaseProfile: binding.profile, seller: seller.claim, listingPin: pin, method: "POST", path: P.payments,
        rawBody: Buffer.from("{}"), now: ENDED, retained: { jobId: JOB, agreementHash: purchase.agreementHash, buyer: buyer.claim, seller: seller.claim },
        requestJournal: testJournal(), commitment: received(sellerResult), agreement: received(purchase.agreement), readCommitmentReceipt: validReceipt, signedListing: received(purchase.listing) }).readbackOnly, run).toBe(false);
    }
    // Without its own receipt reader, the buyer continues nothing: the seller's word is not evidence.
    const got = wire.admitWireArtifact(sent) as { commitment: unknown; agreement: unknown };
    expect(() => wire.verifyEndpointProof(discovery, { readListingEligibility: windowed, listing, binding, local: LOCAL, now: ENDED, commitment: got.commitment, agreement: got.agreement, signedListing: received(purchase.listing) }))
      .toThrowError(expect.objectContaining({ code: "commitment_reader_required", status: 500 }));
    const unread = wire.verifyEndpointProof(early, { readListingEligibility: windowed, listing, binding, local: LOCAL, now: NOW + 30_000 });
    await expect(wire.signWireRequest({ ...input(got.commitment, got.agreement, unread), now: NOW + 30_000 })).rejects.toMatchObject({ code: "commitment_reader_required" });
    expect(buyer.calls).toBe(2);
    // A reader that cannot establish the receipt leaves the purchase undecided: never final.
    expect(() => wire.verifyEndpointProof(discovery, { readListingEligibility: windowed, readCommitmentReceipt: () => "indeterminate", listing, binding, local: LOCAL, now: ENDED, commitment: got.commitment, agreement: got.agreement, signedListing: received(purchase.listing) }))
      .toThrowError(expect.objectContaining({ code: "commitment_unverified", status: 503 }));
  });

  it("refuses, at both signers, a correctly anchored seller record for an Agreement the buyer never signed", async () => {
    const { purchase, buyer, seller, pin, binding, discovery, listing, input } = await committed();
    // A seller that signs and anchors a record for a forged Agreement: its own signature, a buyer signature by another key.
    const impostor = party();
    const forged = signedAgreement({ buyer, seller, jobId: JOB, listingPin: pin, listing: { listing: purchase.listing, pin }, signers: { buyer: impostor, seller } });
    const record = wireCommitment({ seller, buyer: buyer.claim, jobId: JOB, agreementHash: forged.agreementHash, listingPin: pin, committedAt: NOW + 1000 });
    const job = { listingPin: pin, agreementHash: forged.agreementHash, profile: binding.profile };
    for (const agreement of [forged.agreement, undefined, purchase.agreement]) {
      expect(() => wire.verifyEndpointProof(discovery, { readListingEligibility: windowed, readCommitmentReceipt: validReceipt, listing, binding, local: LOCAL, now: ENDED, commitment: received(record), agreement: received(agreement), signedListing: received(purchase.listing) }))
        .toThrowError(expect.objectContaining({ code: "continuation_agreement_invalid", status: 500 }));
    }
    // The buyer's kept proof is for its genuine purchase; signing the forged one is refused at signWireRequest and at signWireEnvelope.
    const proof = wire.verifyEndpointProof(discovery, { readListingEligibility: windowed, readCommitmentReceipt: validReceipt, listing, binding, local: LOCAL, now: ENDED,
      commitment: received(await commitPurchase(purchase, NOW + 1000)), agreement: received(purchase.agreement), signedListing: received(purchase.listing) });
    for (const path of CONTINUING) {
      await expect(wire.signWireRequest({ ...input(received(record), received(forged.agreement), proof, path), job })).rejects.toMatchObject({ code: "continuation_agreement_invalid", status: 500 });
      const payload: wire.WireRequestPayload = { version: "1", kind: "request", method: "POST", path, bodyHash: sha256Hex("{}"), jobId: JOB, buyer: buyer.claim, seller: seller.claim,
        listingPin: pin, agreementHash: forged.agreementHash, nonce: nonce(), expiresAt: ENDED + 30_000, profile: binding.profile };
      await expect(wire.signWireEnvelope(payload, { signer: buyer, binding, local: LOCAL, purchaseProfile: binding.profile, endpointProof: proof, publicEndpoint: ENDPOINT, now: ENDED,
        commitment: received(record), agreement: received(forged.agreement), signedListing: received(purchase.listing) })).rejects.toMatchObject({ code: "continuation_agreement_invalid", status: 500 });
    }
    expect(buyer.calls).toBe(0);
  });

  it("re-evaluates DACS-3 §8.5.2 checks 5 and 6 at the receipt time from the pinned Listing, at both signers", async () => {
    // The Listing ends a minute after NOW; the buyer signs at ENDED, after it ended and the seller drained.
    const notAfter = NOW + 60_000;
    const { purchase, buyer, seller, pin, binding, discovery, listing, input } = await committed({ notBefore: NOW - 600_000, notAfter });
    const terms = (purchase.agreement as unknown as { terms: object }).terms;
    // An Agreement of the purchase's Listing whose deadline is `deadline`, and the seller's record for it at `committedAt`.
    const evidence = (committedAt: number, deadline?: number) => {
      const a = deadline === undefined ? { agreement: purchase.agreement, agreementHash: purchase.agreementHash }
        : signedAgreement({ buyer, seller, jobId: JOB, listingPin: pin, listing: { listing: purchase.listing, pin }, generatedAt: NOW, patch: { terms: { ...terms, deadline } } });
      return { ...a, commitment: received(wireCommitment({ seller, buyer: buyer.claim, jobId: JOB, agreementHash: a.agreementHash, listingPin: pin, committedAt })) };
    };
    const prove = (e: ReturnType<typeof evidence>) => () => wire.verifyEndpointProof(discovery, { readListingEligibility: windowed, readCommitmentReceipt: validReceipt, listing, binding, local: LOCAL,
      now: ENDED, commitment: e.commitment, agreement: received(e.agreement), signedListing: received(purchase.listing) });
    const proof = prove(evidence(NOW + 1000))();
    const sign = (e: ReturnType<typeof evidence>, path: string) => wire.signWireRequest({ ...input(e.commitment, received(e.agreement), proof, path),
      job: { listingPin: pin, agreementHash: e.agreementHash, profile: binding.profile } });
    const invalid = { code: "continuation_commitment_invalid", status: 500 };
    const cases: Array<[string, ReturnType<typeof evidence>, boolean]> = [
      ["committed at notAfter (check 6)", evidence(notAfter), true],
      ["committed 1 ms after notAfter (check 6)", evidence(notAfter + 1), false],
      ["a deadline at committedAt + deadlineSecAfterCommit (check 5)", evidence(NOW + 1000, NOW + 1000 + 600_000), true],
      ["a deadline 1 ms past it (check 5)", evidence(NOW + 1000, NOW + 1000 + 600_001), false],
      ["committed at the Agreement's deadline", evidence(NOW + 1000, NOW + 1000), true],
      ["committed 1 ms after the Agreement's deadline", evidence(NOW + 1000, NOW + 999), false],
    ];
    for (const [name, e, continues] of cases) {
      if (continues) expect(prove(e), name).not.toThrow();
      else expect(prove(e), name).toThrowError(expect.objectContaining(invalid));
      for (const path of CONTINUING) {
        if (continues) await expect(sign(e, path), `${name} ${path}`).resolves.toMatchObject({ payload: { path } });
        else await expect(sign(e, path), `${name} ${path}`).rejects.toMatchObject(invalid);
        const payload: wire.WireRequestPayload = { version: "1", kind: "request", method: "POST", path, bodyHash: sha256Hex("{}"), jobId: JOB, buyer: buyer.claim, seller: seller.claim,
          listingPin: pin, agreementHash: e.agreementHash, nonce: nonce(), expiresAt: ENDED + 30_000, profile: binding.profile };
        const envelope = wire.signWireEnvelope(payload, { signer: buyer, binding, local: LOCAL, purchaseProfile: binding.profile, endpointProof: proof, publicEndpoint: ENDPOINT, now: ENDED,
          commitment: e.commitment, agreement: received(e.agreement), signedListing: received(purchase.listing) });
        if (continues) await expect(envelope, `${name} ${path}`).resolves.toEqual(expect.any(String));
        else await expect(envelope, `${name} ${path}`).rejects.toMatchObject(invalid);
      }
    }
    // Without the Listing, or with another one, nothing continues.
    for (const signedListing of [undefined, received(tp1Listing({ seller, listingId: pin.listingId }).listing)]) {
      expect(() => wire.verifyEndpointProof(discovery, { readListingEligibility: windowed, readCommitmentReceipt: validReceipt, listing, binding, local: LOCAL, now: ENDED,
        commitment: evidence(NOW + 1000).commitment, agreement: received(purchase.agreement), signedListing })).toThrowError(expect.objectContaining({ code: "continuation_listing_invalid", status: 500 }));
    }
  });

  it("refuses, at both signers, a seller-anchored Agreement both parties signed whose terms are not the pinned Listing's (DACS-3 §8.5.2 checks 1-4)", async () => {
    const { purchase, buyer, seller, pin, binding, discovery, listing, input } = await committed();
    const terms = (purchase.agreement as unknown as { terms: Record<string, unknown> }).terms;
    const deliverable = terms.deliverable as Record<string, unknown>;
    const proof = wire.verifyEndpointProof(discovery, { readListingEligibility: windowed, readCommitmentReceipt: validReceipt, listing, binding, local: LOCAL, now: ENDED,
      commitment: received(await commitPurchase(purchase, NOW + 1000)), agreement: received(purchase.agreement), signedListing: received(purchase.listing) });
    const refused = { code: "continuation_agreement_invalid", status: 500, detail: "LISTING-TERMS" };
    for (const [name, changed] of [
      ["2 DEM under the 1 DEM Listing", { price: { amount: "2", currency: "DEM" } }],
      ["another rail version", { rail: { railId: "demos-native:DEM", railVersion: 2 } }],
      ["another deliverable hash", { deliverable: { ...deliverable, hash: "e".repeat(64) } }],
    ] as const) {
      // Both parties signed it and the seller anchored a finalized record for it; the SDK's own gate would never have committed it.
      const forged = signedAgreement({ buyer, seller, jobId: JOB, listingPin: pin, listing: { listing: purchase.listing, pin }, generatedAt: NOW, patch: { terms: { ...terms, ...changed } } });
      const record = received(wireCommitment({ seller, buyer: buyer.claim, jobId: JOB, agreementHash: forged.agreementHash, listingPin: pin, committedAt: NOW + 1000 }));
      expect(() => wire.verifyEndpointProof(discovery, { readListingEligibility: windowed, readCommitmentReceipt: validReceipt, listing, binding, local: LOCAL, now: ENDED,
        commitment: record, agreement: received(forged.agreement), signedListing: received(purchase.listing) }), name).toThrowError(expect.objectContaining(refused));
      const job = { listingPin: pin, agreementHash: forged.agreementHash, profile: binding.profile };
      for (const path of CONTINUING) {
        await expect(wire.signWireRequest({ ...input(record, received(forged.agreement), proof, path), job }), `${name} ${path}`).rejects.toMatchObject(refused);
        const payload: wire.WireRequestPayload = { version: "1", kind: "request", method: "POST", path, bodyHash: sha256Hex("{}"), jobId: JOB, buyer: buyer.claim, seller: seller.claim,
          listingPin: pin, agreementHash: forged.agreementHash, nonce: nonce(), expiresAt: ENDED + 30_000, profile: binding.profile };
        await expect(wire.signWireEnvelope(payload, { signer: buyer, binding, local: LOCAL, purchaseProfile: binding.profile, endpointProof: proof, publicEndpoint: ENDPOINT, now: ENDED,
          commitment: record, agreement: received(forged.agreement), signedListing: received(purchase.listing) }), `${name} ${path}`).rejects.toMatchObject(refused);
      }
    }
    expect(buyer.calls).toBe(0);
  });

  it("refuses, at both signers, a continuation under a Listing whose delivery phase cannot deliver its deliverable (DACS-4 §9.6.1)", async () => {
    const { buyer, seller, binding, input } = await committed();
    // The seller's signed Listing pairs deliver-storage-program with an attested-payload deliverable; the Agreement is derived from it.
    const attested = { kind: "attested-payload", payloadFormat: "text/plain", verificationMethod: { kind: "self-signed" } };
    const l = tp1Listing({ seller, listingId: "attested-report", publicEndpoint: ENDPOINT, patch: { offering: { ...tp1Listing({ seller }).listing.offering, deliverable: attested } } });
    const a = signedAgreement({ buyer, seller, jobId: JOB, listingPin: l.pin, listing: l, generatedAt: NOW });
    const record = received(wireCommitment({ seller, buyer: buyer.claim, jobId: JOB, agreementHash: a.agreementHash, listingPin: l.pin, committedAt: NOW + 1000 }));
    const listing = { seller: seller.claim, publicEndpoint: ENDPOINT, listingPin: l.pin };
    const document = await wire.signDiscoveryDocument({ format: "dacs-seller-discovery/v1", profile: binding.profile, seller: seller.claim, publicEndpoint: ENDPOINT,
      transport: ["dacs-seller-http/v1"], listings: [l.pin], capabilities: wire.TP1_CAPABILITIES, ready: false, issuedAt: ENDED - 1000, expiresAt: ENDED + 59_000 }, seller, binding, LOCAL);
    const refused = { code: "continuation_listing_invalid", status: 500, detail: "DELIVERABLE-KIND" };
    // The Listing is still open at ENDED, so the buyer's proof stands and only the Listing's shape refuses the continuation.
    const open: wire.ListingEligibilityReader = (scope) => ({ ...(readFixtureListingEligibility(scope) as object), notBefore: NOW - 1000, expiresAt: ENDED + 60_000 });
    expect(() => wire.verifyEndpointProof(document, { readListingEligibility: open, readCommitmentReceipt: validReceipt, listing, binding, local: LOCAL, now: ENDED,
      commitment: record, agreement: received(a.agreement), signedListing: received(l.listing) })).toThrowError(expect.objectContaining(refused));
    const proof = wire.verifyEndpointProof(document, { readListingEligibility: open, readCommitmentReceipt: validReceipt, listing, binding, local: LOCAL, now: ENDED });
    for (const path of CONTINUING) {
      await expect(wire.signWireRequest({ ...input(record, received(a.agreement), proof, path), job: { listingPin: l.pin, agreementHash: a.agreementHash, profile: binding.profile },
        signedListing: received(l.listing) }), path).rejects.toMatchObject(refused);
    }
    expect(buyer.calls).toBe(0);
  });
});

describe("no package file can vouch for a commitment", () => {
  it("ships no commitment registrar: the module is gone and no wire or negotiate module exports a record, vouch, register or mark helper", async () => {
    expect(existsSync(new URL("../../src/negotiate/verifiedCommitment.ts", import.meta.url))).toBe(false);
    const modules = await Promise.all(["../../src/wire/index.js", "../../src/wire/commitment.js", "../../src/wire/discovery.js", "../../src/wire/envelope.js", "../../src/wire/journal.js",
      "../../src/negotiate/index.js", "../../src/negotiate/commitment.js"].map((path) => import(path)));
    for (const module of modules) {
      expect(Object.keys(module).filter((name) => /^(record|vouch|register|mark|qualify)/i.test(name) || /verifiedAgreementCommitment/i.test(name))).toEqual([]);
    }
  });
});

describe("an effect is reserved only in the SDK's durable journal", () => {
  it("refuses any journal openWireRequestJournal did not return, a host's own durable or shared one included, before anything is reserved", () => {
    const x = world();
    const held = new Set<string>();
    const reserve = (r: { key: string }) => (held.has(r.key) ? false : (held.add(r.key), true));
    const directory = journalDirectory();
    const opened = wire.openWireRequestJournal(directory);
    for (const journal of [{ durable: true, reserve }, { qualified: true }, { directory }, { ...opened }, Object.freeze({ directory }), () => true, null, undefined]) {
      for (const path of [P.proposals, ...CONTINUING]) {
        expect(() => wire.checkWireRequest(x.direct(x.request(path)), { ...x.check(path), requestJournal: journal as never }))
          .toThrowError(expect.objectContaining({ code: "seller_replay_guard_required", status: 500 }));
      }
    }
    expect(held.size).toBe(0);
    expect(wire.checkWireRequest(x.direct(x.request(P.payments)), { ...x.check(P.payments), requestJournal: opened }).effect).toMatchObject({ state: "new", attempt: 0 });
    expect("qualifyWireRequestJournal" in wire).toBe(false);
  });

  it("opens only an absolute directory this user owns and no one else can write, not through a link", () => {
    const refused = (directory: unknown, detail: string) => expect(() => wire.openWireRequestJournal(directory as string))
      .toThrowError(expect.objectContaining({ code: "seller_replay_guard_invalid", status: 500, detail }));
    refused("relative/journal", "DIRECTORY-NOT-ABSOLUTE");
    refused(7, "DIRECTORY-NOT-ABSOLUTE");
    const parent = journalDirectory();
    refused(join(parent, "missing"), "DIRECTORY-MISSING");
    const shared = join(parent, "shared");
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    refused(shared, "DIRECTORY-UNSAFE");
    chmodSync(shared, 0o770);
    refused(shared, "DIRECTORY-UNSAFE");
    const real = join(parent, "real"), link = join(parent, "link");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, link);
    refused(link, "DIRECTORY-MISSING");
    expect(wire.openWireRequestJournal(real).directory).toBe(real);
    for (const options of [{ leaseMs: 999 }, { leaseMs: 600_001 }, { leaseMs: "60000" }, { clock: 7 }]) {
      expect(() => wire.openWireRequestJournal(real, options as never)).toThrowError(expect.objectContaining({ code: "seller_configuration_invalid", status: 500 }));
    }
  });

  it("gives each job and route one operation, whatever the nonce or the body", () => {
    const x = world();
    const journals = testJournals();
    const journal = journals.open();
    const at = (path: string, body: string) => wire.checkWireRequest(x.direct(x.request(path, body)), { ...x.check(path, body), requestJournal: journal });
    const payload = x.request(P.payments);
    const { seller, jobId, path } = payload;
    // Only the seller, job and route: no body, nonce, Agreement hash, buyer or tuple.
    expect(wire.wireOperationId(payload)).toBe(sha256Hex(canonicalize({ seller, jobId, path })));
    expect(wire.wireOperationId({ ...payload, agreementHash: "b".repeat(64), buyer: party().claim, bodyHash: "d".repeat(64) } as never)).toBe(wire.wireOperationId(payload));
    for (const route of [P.proposals, ...CONTINUING]) {
      const first = at(route, '{"amount":"1","note":"x"}');
      expect(first.effect).toMatchObject({ state: "new", attempt: 0, operationId: wire.wireOperationId({ ...payload, path: route }) });
      // Another nonce, another encoding, other incidental fields: the same operation, still held by the first attempt.
      for (const repeat of ['{"amount":"1","note":"x"}', '{ "note": "x", "amount": "1" }', '{"amount":"1","note":"y"}']) {
        expect(() => at(route, repeat), `${route} ${repeat}`).toThrowError(expect.objectContaining({ code: "seller_effect_pending", status: 503 }));
      }
    }
    // The same signed request again is a replay.
    const once = x.request(P.payments);
    const opened = () => x.direct(once);
    expect(() => wire.checkWireRequest(opened(), { ...x.check(P.payments), requestJournal: journal })).toThrowError(expect.objectContaining({ code: "seller_effect_pending" }));
    expect(() => wire.checkWireRequest(opened(), { ...x.check(P.payments), requestJournal: journal })).toThrowError(expect.objectContaining({ code: "peer_request_replayed", status: 409 }));
    expect(new Set(journals.reservations().map((r) => r.operationId)).size).toBe(4);
  });

  it("never gives a job and route a second effect when the retained Agreement changes: before and after completion, and across a reopen", () => {
    const x = world();
    const directory = journalDirectory();
    const another = signedAgreement({ buyer: x.buyer, seller: x.seller, jobId: JOB, listingPin: PIN, generatedAt: NOW - 30_000 });
    expect(another.agreementHash).not.toBe(x.agreementHash);
    /** The same job and route under the Agreement the host retained first, or under another one it retained later. */
    const at = (path: string, journal: wire.WireRequestJournal, changed: boolean) => wire.checkWireRequest(
      x.direct({ ...x.request(path), ...(changed ? { agreementHash: another.agreementHash } : {}) }),
      { ...x.check(path), requestJournal: journal, ...(changed ? {
        retained: { ...x.retained, agreementHash: another.agreementHash }, agreement: received(another.agreement),
        commitment: received(x.commitment({ agreementHash: another.agreementHash })),
      } : {}) });
    const mismatch = expect.objectContaining({ code: "peer_operation_mismatch", status: 409 });
    for (const path of [P.proposals, ...CONTINUING]) {
      const journal = wire.openWireRequestJournal(directory);
      const first = at(path, journal, false).effect!;
      expect(first.state, path).toBe("new");
      // Held by the first attempt: another Agreement is refused, not told to wait or given its own operation.
      expect(() => at(path, journal, true), path).toThrowError(mismatch);
      wire.completeWireEffect(journal, first, { status: 200, text: `{"path":"${path}"}` });
      expect(() => at(path, journal, true), path).toThrowError(mismatch);
      // A restarted worker reads the same binding from the directory.
      const reopened = wire.openWireRequestJournal(directory);
      expect(() => at(path, reopened, true), path).toThrowError(mismatch);
      expect(at(path, reopened, false).effect, path).toMatchObject({ state: "completed", operationId: first.operationId, outcome: { status: 200, text: `{"path":"${path}"}` } });
    }
    // Each refused request spent its nonce and nothing else: four operations, one attempt each.
    expect(readdirSync(directory).filter((name) => /^o-[0-9a-f]{64}-0$/.test(name))).toHaveLength(4);
    expect(readdirSync(directory).filter((name) => /^o-[0-9a-f]{64}-[1-9]/.test(name))).toEqual([]);
  });

  it("refuses an attempt record the journal did not write as a corrupt store, never as a lapsed lease", () => {
    const x = world();
    const directory = journalDirectory();
    const journal = wire.openWireRequestJournal(directory);
    const at = () => wire.checkWireRequest(x.direct(x.request(P.payments)), { ...x.check(P.payments), requestJournal: journal });
    const first = at().effect!;
    const file = join(directory, `o-${first.operationId}-0`);
    const kept = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(kept).sort()).toEqual(["attempt", "binding", "leaseUntil", "operationId", "requestHash"]);
    for (const contents of ["not json", "{}", JSON.stringify({ ...kept, leaseUntil: "later" }), JSON.stringify({ ...kept, attempt: 1 }), JSON.stringify({ ...kept, binding: undefined })]) {
      writeFileSync(file, contents);
      expect(() => at(), contents).toThrowError(expect.objectContaining({ code: "seller_replay_guard_invalid", status: 500, detail: "STORE-ATTEMPT-INVALID" }));
    }
    writeFileSync(file, JSON.stringify(kept));
    expect(() => at()).toThrowError(expect.objectContaining({ code: "seller_effect_pending", status: 503 }));
  });

  it("answers a repeat of a completed operation with its outcome and runs no second effect", () => {
    const x = world();
    const journal = testJournal();
    const at = (body: string) => wire.checkWireRequest(x.direct(x.request(P.payments, body)), { ...x.check(P.payments, body), requestJournal: journal });
    const first = at('{"tx":"1"}');
    expect(first.effect?.state).toBe("new");
    const outcome = { status: 200, text: '{"paid":true}' };
    wire.completeWireEffect(journal, first.effect!, outcome);
    // Completing again with the same outcome is a no-op; another outcome is refused.
    wire.completeWireEffect(journal, first.effect!, { ...outcome });
    expect(() => wire.completeWireEffect(journal, first.effect!, { status: 200, text: '{"paid":false}' })).toThrowError(expect.objectContaining({ code: "seller_effect_conflict" }));
    expect(() => wire.completeWireEffect(journal, first.effect!, null)).toThrowError(expect.objectContaining({ code: "seller_effect_conflict" }));
    for (const body of ['{"tx":"1"}', '{"tx":"2"}']) expect(at(body).effect).toEqual({ state: "completed", operationId: first.effect!.operationId, outcome });
  });

  it("refuses to complete an effect it did not issue, on another journal, or with a malformed outcome", () => {
    const x = world();
    const journal = testJournal(), other = testJournal();
    const { effect } = wire.checkWireRequest(x.direct(x.request(P.payments)), { ...x.check(P.payments), requestJournal: journal });
    const code = (f: () => void) => { try { f(); return "ok"; } catch (error) { return (error as wire.WireError).detail ?? (error as wire.WireError).code; } };
    expect(code(() => wire.completeWireEffect(journal, { ...effect! }, null))).toBe("EFFECT-NOT-ISSUED");
    expect(code(() => wire.completeWireEffect(other, effect!, null))).toBe("EFFECT-NOT-ISSUED");
    expect(code(() => wire.completeWireEffect({ directory: journal.directory }, effect!, null))).toBe("seller_replay_guard_required");
    for (const outcome of [{ status: 199, text: "{}" }, { status: 600, text: "{}" }, { status: 200 }, { status: 200, text: 7 }, { status: 200, text: "x".repeat(512 * 1024 + 1) }]) {
      expect(code(() => wire.completeWireEffect(journal, effect!, outcome as never))).toBe("OUTCOME-INVALID");
    }
    expect(code(() => wire.completeWireEffect(journal, effect!, { status: 200, text: "{}" }))).toBe("ok");
  });

  it("recovers an attempt whose lease ended with no outcome: exactly one worker holds the recovery, and the outcome is kept once", () => {
    const x = world();
    let clock = NOW;
    const directory = journalDirectory();
    const worker = () => wire.openWireRequestJournal(directory, { leaseMs: 1000, clock: () => clock });
    const a = worker(), b = worker();
    const at = (journal: wire.WireRequestJournal, body = "{}") => wire.checkWireRequest(x.direct(x.request(P.bundleRequest, body)), { ...x.check(P.bundleRequest, body), requestJournal: journal });
    const first = at(a).effect!;
    expect(first).toMatchObject({ state: "new", attempt: 0, leaseUntil: NOW + 1000 });
    clock = NOW + 999;
    expect(() => at(b)).toThrowError(expect.objectContaining({ code: "seller_effect_pending", status: 503 }));
    // The first worker died without an outcome; its lease ends.
    clock = NOW + 1000;
    const recovered = at(b, '{"retry":true}').effect!;
    expect(recovered).toMatchObject({ state: "recover", attempt: 1, operationId: first.operationId });
    expect(() => at(a)).toThrowError(expect.objectContaining({ code: "seller_effect_pending" }));
    // The first attempt, superseded, cannot record anything; the recovering one does.
    expect(() => wire.completeWireEffect(a, first, { status: 200, text: "{}" })).toThrowError(expect.objectContaining({ code: "seller_effect_superseded" }));
    wire.completeWireEffect(b, recovered, { status: 200, text: '{"delivered":1}' });
    expect(at(a).effect).toMatchObject({ state: "completed", outcome: { status: 200, text: '{"delivered":1}' } });
  });

  it("an attempt ended with no outcome is recovered at once; an operation that never completes stops after its attempts", () => {
    const x = world();
    const journal = wire.openWireRequestJournal(journalDirectory(), { leaseMs: 600_000 });
    const at = () => wire.checkWireRequest(x.direct(x.request(P.payments)), { ...x.check(P.payments), requestJournal: journal }).effect!;
    for (let attempt = 0; attempt < wire.MAX_EFFECT_ATTEMPTS; attempt++) {
      const effect = at();
      expect(effect).toMatchObject({ state: attempt === 0 ? "new" : "recover", attempt });
      expect(() => at()).toThrowError(expect.objectContaining({ code: "seller_effect_pending" }));
      wire.completeWireEffect(journal, effect, null);
    }
    expect(() => at()).toThrowError(expect.objectContaining({ code: "seller_effect_unresolved", status: 500 }));
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
