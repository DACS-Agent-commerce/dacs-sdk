// A payment or delivery request continues a purchase only on commitment
// evidence the wire checks itself, at the buyer and at the seller: the
// Agreement both parties signed (CA-7), the orchestrator's finality record for
// it (CA-6) and its finalized receipt. An effect is reserved only in the SDK's
// durable journal, once per job and route, with its outcome kept.
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isPayeeBoundAgreementDocument, isReadableAnchorReceipt } from "../../src/artifacts/validators.js";
import { canonicalize, contentHash, sha256Hex } from "../../src/canonical/index.js";
import { FINALITY_COMMITMENT_SEPARATOR } from "../../src/negotiate/commitment.js";
import { verifySellerPaymentIntake, type SellerPaymentIntakeDeps } from "../../src/seller/paymentIntake.js";
import { FINALITY_COMMITMENT_DOMAIN } from "../../src/wire/commitment.js";
import { CONTINUING_PATHS } from "../../src/wire/discovery.js";
import { admitOutgoingBody } from "../../src/wire/envelope.js";
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
async function world(l: ReturnType<typeof tp1Listing> = { listing: LISTING, pin: PIN },
  options: { terms?: Record<string, unknown>; patch?: Record<string, unknown>; generatedAt?: number; deriveFrom?: ReturnType<typeof tp1Listing> } = {}) {
  const buyer = party(), seller = SELLER, session = party();
  const PIN = l.pin;
  const binding = await bindTp1Fixture({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local: LOCAL });
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
  const direct = async (payload: wire.WireRequestPayload) => await wire.openWireEnvelope(header(signed(payload, buyer, wire.DACS_SELLER_HTTP_DOMAINS.request)), "request", context);
  const delegated = async (payload: wire.WireRequestPayload) => {
    const delegation = signed({ version: "1", kind: "seller-session-delegation", buyer: buyer.claim, seller: seller.claim,
      sessionPublicKey: session.key, listingPin: PIN, jobId: JOB, notBefore: NOW - 1000, expiresAt: NOW + 60_000,
      profile: binding.profile }, buyer, wire.DACS_SELLER_HTTP_DOMAINS.delegation);
    return await wire.openWireEnvelope(header({ ...signed(payload, session, wire.DACS_SELLER_HTTP_DOMAINS.request), delegation }), "request", { ...context, requireDelegation: true });
  };
  const artifact = { jobId: JOB, listingRef: PIN, parties: [{ role: "buyer", primaryClaim: buyer.claim }, { role: "seller", primaryClaim: seller.claim }], terms: { deadline: NOW + 60_000 } };
  const retained = { jobId: JOB, agreementHash, buyer: buyer.claim, seller: seller.claim };
  const commitment = (options: Partial<Parameters<typeof wireCommitment>[0]> = {}) =>
    wireCommitment({ seller, buyer: buyer.claim, jobId: JOB, agreementHash, listingPin: PIN, committedAt: NOW - 5000, ...options });
  const check = (path: string, body = "{}") => ({ ...context, seller: seller.claim, listingPin: PIN, method: "POST", path, rawBody: Buffer.from(body), now: NOW, retained,
    ready: true, readCommitmentReceipt: Object.assign(validReceipt, { chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity }), commitment: received(commitment()), agreement: received(agreement), signedListing: received(l.listing) });
  return { buyer, seller, binding, context, agreement, agreementHash, request, direct, delegated, artifact, retained, commitment, check, pin: PIN, listing: l.listing };
}

/** A commitment whose record signature is changed after the seller signed it; the receipt still names the record (its hash omits the signature). */
function resigned(x: Awaited<ReturnType<typeof world>>, signature: Record<string, unknown>) {
  const c = x.commitment();
  return { ...c, record: { ...c.record, signature: { ...c.record.signature, ...signature } } };
}

// Each case opens isolated journals that qualify publication in fresh processes: load-sensitive under the 5 s default.
describe("the seller checks the job's finalized commitment on every payment and delivery route", { timeout: 60_000 }, () => {
  const modes = (x: Awaited<ReturnType<typeof world>>, path: string) => [
    ["direct", async () => await x.direct(x.request(path)), {}],
    ["delegated", async () => await x.delegated(x.request(path)), { requireDelegation: true, artifacts: [x.artifact] }],
  ] as const;

  /** Every way the commitment evidence is refused, with its own code. */
  function refusals(x: Awaited<ReturnType<typeof world>>): Array<[string, Record<string, unknown>, string, number]> {
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
      ["the reader finds it invalid", { readCommitmentReceipt: Object.assign(() => "invalid", { chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity }) }, "continuation_commitment_invalid", 500],
      ["the reader cannot tell", { readCommitmentReceipt: Object.assign(() => "indeterminate", { chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity }) }, "commitment_unverified", 503],
      ["the reader errs", { readCommitmentReceipt: Object.assign(() => "error", { chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity }) }, "commitment_unverified", 503],
    ];
  }

  it.each(CONTINUING)("%s refuses missing, pending, forged or foreign evidence before any reservation, direct and delegated", async (path) => {
    const x = await world();
    const journals = testJournals();
    const journal = await journals.open();
    for (const [mode, open, extra] of modes(x, path)) {
      for (const [name, change, code, status] of refusals(x)) {
        const retained = (change.retained ?? x.retained) as typeof x.retained;
        const opened = change.retained ? await (mode === "direct" ? x.direct : x.delegated)({ ...x.request(path), agreementHash: retained.agreementHash }) : await open();
        // Each refusal is given as received bytes, so it is refused for its own fault, never for not being admitted.
        const given = { ...change, ..."commitment" in change ? { commitment: received(change.commitment) } : {}, ..."agreement" in change ? { agreement: received(change.agreement) } : {} };
        await expect(Promise.resolve().then(async () => await wire.checkWireRequest(opened, { ...await x.check(path), ...extra, requestJournal: journal, ...given } as wire.RequestCheck)), `${mode}: ${name}`).rejects
          .toThrowError(expect.objectContaining({ code, status }));
      }
      // The reader's own failure keeps its cause.
      const timeout = new Error("receipt lookup timed out");
      await expect(Promise.resolve().then(async () => await wire.checkWireRequest(await open(), { ...await x.check(path), ...extra, requestJournal: journal, readCommitmentReceipt: Object.assign(() => { throw timeout; }, { chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity }) } as wire.RequestCheck))).rejects.toThrow(timeout);
    }
    expect(journals.reservations()).toHaveLength(0);
    // The seller's own records, read again as bytes, continue the purchase; so do the values the wire admitted from them.
    for (const [mode, open, extra] of modes(x, path)) {
      const given = mode === "direct" ? { commitment: received(x.commitment()), agreement: received(x.agreement) }
        : { commitment: wire.admitWireArtifact(received(x.commitment()) as Buffer), agreement: wire.admitWireArtifact(received(x.agreement) as Buffer) };
      expect((await wire.checkWireRequest(await open(), { ...await x.check(path), ...extra, requestJournal: await journals.open(), ...given } as wire.RequestCheck)).readbackOnly).toBe(false);
    }
    expect(journals.reservations()).toHaveLength(2);
  });

  it("asks the receipt reader every time, with an owned frozen copy of the anchored commitment", async () => {
    const x = await world();
    const seen: unknown[] = [];
    const reader = (anchored: unknown) => { seen.push(anchored); return "valid"; };
    for (const path of CONTINUING) await wire.checkWireRequest(await x.direct(x.request(path)), { ...await x.check(path), requestJournal: testJournal(), readCommitmentReceipt: Object.assign(reader, { chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity }) });
    expect(seen).toHaveLength(3);
    for (const anchored of seen) {
      expect(Object.keys(anchored as object).sort()).toEqual(["anchorReceipt", "anchorTxRef", "nativeAddress", "record"]);
      expect(Object.isFrozen((anchored as { record: object }).record)).toBe(true);
    }
  });

  it("routes that start a purchase and read routes need no commitment", async () => {
    const x = await world();
    for (const path of [P.proposals, P.commitments, P.commitmentSignature, P.context, P.state, P.bundleBuyerCopy]) {
      expect((await wire.checkWireRequest(await x.direct(x.request(path)), { ...await x.check(path), commitment: undefined, agreement: undefined, readCommitmentReceipt: undefined, requestJournal: testJournal() })).readbackOnly).toBe(false);
    }
  });

  it("selects only the payee-bound Agreement from the pinned Listing's commit phase before any signature", async () => {
    const x = await world();
    const plainListing = tp1Listing({ seller: SELLER, listingId: "plain", patch: { pipeline: [
      { kind: "negotiate-fixed-price" }, { kind: "commit-agreement" },
      { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } }, { kind: "deliver-storage-program" },
    ] } });
    const plain = await world(plainListing);
    const { payeeBoundAgreementVersion: _version, signatures: _signatures, terms, ...rest } = x.agreement as unknown as Record<string, unknown>;
    const { payoutBindings: _payout, ...plainTerms } = terms as Record<string, unknown>;
    const unsigned = { ...rest, agreementVersion: "1", terms: plainTerms };
    const hash = contentHash(unsigned);
    const document = { ...unsigned, signatures: [x.buyer, x.seller].map((p) => ({ party: p.claim, algorithm: "ed25519",
      value: p.sign(Buffer.from(`dacs-agreement:v1:${hash}`)).toString("base64url") })) };
    let reads = 0;
    const reader = () => { reads++; return "valid"; };
    for (const path of CONTINUING) {
      for (const mode of ["direct", "delegated"] as const) {
        const extra = mode === "delegated" ? { requireDelegation: true, artifacts: [x.artifact] } : {};
        expect((await wire.checkWireRequest(await x[mode](x.request(path)), { ...await x.check(path), ...extra,
          requestJournal: testJournal(), readCommitmentReceipt: Object.assign(reader, { chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity }) })).effect).toMatchObject({ state: "new" });
        // A plain artifact is refused even when signed under its own domain and anchored by the seller.
        await expect(Promise.resolve().then(async () => await wire.checkWireRequest(await x[mode]({ ...x.request(path), agreementHash: hash }), { ...await x.check(path), ...extra,
          requestJournal: testJournal(), retained: { ...x.retained, agreementHash: hash }, agreement: received(document),
          commitment: received(x.commitment({ agreementHash: hash })), readCommitmentReceipt: Object.assign(reader, { chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity }) }))).rejects
          .toThrowError(expect.objectContaining({ code: "continuation_agreement_invalid" }));
      }
      // The pinned Listing selects the artifact before any signature, regardless of a host's phase label.
      await expect(Promise.resolve().then(async () => await wire.checkWireRequest(await plain.direct(plain.request(path)), { ...await plain.check(path),
        requestJournal: testJournal(), commitment: received(resigned(plain, { value: "A".repeat(86) })),
        commitPhase: "commit-payee-bound-agreement" } as wire.RequestCheck))).rejects
        .toThrowError(expect.objectContaining({ code: "continuation_phase_unsupported" }));
    }
    expect(reads).toBe(6);
  }, 60_000); // Each isolated journal qualifies publication in fresh processes.

  it("a wire-accepted TP-1 purchase passes seller payment intake's Agreement-type check", async () => {
    const x = await world();
    const committed = x.commitment();
    expect((await wire.checkWireRequest(await x.direct(x.request(P.payments)), { ...await x.check(P.payments), requestJournal: testJournal() })).effect)
      .toMatchObject({ state: "new" });
    let listingReads = 0;
    const unexpected = async (): Promise<never> => { throw new Error("unexpected downstream intake call"); };
    const deps: SellerPaymentIntakeDeps = {
      resolveCommittedAgreement: async () => ({ disposition: "verified", agreement: x.agreement as unknown as Record<string, unknown>,
        agreementHash: x.agreementHash, railRegistryVersion: 1, commitment: { finality: "finalized", ref: committed.logicalAddress,
          contentHash: contentHash(committed.record), jobId: JOB, agreementHash: x.agreementHash, listingRef: x.pin,
          committedAt: committed.committedAt, signer: x.seller.claim } }),
      // Stop at the next boundary: reaching it proves the actual intake accepted the artifact and commitment.
      resolveListingAtCommit: async () => { listingReads++; throw new Error("stop after Agreement check"); },
      resolveRail: unexpected, resolveIdentityBundle: unexpected, resolvePayerAddress: unexpected,
      resolvePayeeDestination: unexpected, observeDemosTransfer: unexpected, observeX402Transfer: unexpected,
      verifyX402ReceiptExtensions: unexpected, classifyX402SettlementChain: unexpected,
      receiptStore: { claim: unexpected, consumePermit: unexpected },
    };
    const result = await verifySellerPaymentIntake({ jobId: JOB, phaseIndex: 2, railId: "demos-native:DEM",
      payerPayingKey: x.buyer.key, receipt: { kind: "pay-dem", txHash: "a".repeat(64) } }, deps);
    expect(result).toMatchObject({ disposition: "indeterminate", reason: "listing-resolution-unavailable" });
    expect(listingReads).toBe(1);
  });

  it("reads the Listing from its own bytes: it must be the one the request, record and Agreement pin, the seller's, and select one fixed-price commitment", async () => {
    const x = await world();
    const listingRefused = (detail?: string) => expect.objectContaining({ code: "continuation_listing_invalid", status: 500, ...detail ? { detail } : {} });
    const check = (w: Awaited<ReturnType<typeof world>>, signedListing: unknown, path: string = P.payments) => async () =>
      await wire.checkWireRequest(await w.direct(w.request(path)), { ...await w.check(path), requestJournal: testJournal(), signedListing });
    const other = party();
    const cases: Array<[string, Awaited<ReturnType<typeof world>>, unknown]> = [
      ["no Listing", x, undefined],
      ["the seller's other Listing", x, received(tp1Listing({ seller: SELLER, listingId: "other-report" }).listing)],
      ["the Listing with one member changed after it was pinned", x, received({ ...LISTING, offering: { ...LISTING.offering, title: "Another report" } })],
      ["the Listing as another version", x, received({ ...LISTING, listingVersion: 2 })],
      ["not a Listing", x, received({ ...LISTING, pipeline: "commit-payee-bound-agreement" })],
      // Pinned by the request, the record and the Agreement, but not the seller's: another party presents it.
      ["a Listing another party presents", await world(tp1Listing({ seller: other, listingId: "not-the-sellers" }), { deriveFrom: tp1Listing({ seller: SELLER, listingId: "not-the-sellers" }) }),
        received(tp1Listing({ seller: other, listingId: "not-the-sellers" }).listing)],
    ];
    for (const [name, w, given] of cases) for (const path of CONTINUING) await expect(Promise.resolve().then(await check(w, given, path)), `${name} ${path}`).rejects.toThrowError(listingRefused());
    // Pinned, the seller's, but outside what the SDK gate commits.
    // The Agreement is derived from the seller's valid Listing of the same id, then pins this one.
    const pinned = async (listingId: string, patch: Record<string, unknown>) => {
      const l = tp1Listing({ seller: SELLER, listingId, patch });
      return [await world(l, { deriveFrom: tp1Listing({ seller: SELLER, listingId }) }), received(l.listing)] as const;
    };
    for (const [name, [w, given], code] of [
      ["no deadlineSecAfterCommit", await pinned("no-deadline", { terms: {} }), "continuation_listing_invalid"],
      ["a zero deadlineSecAfterCommit", await pinned("zero-deadline", { terms: { deadlineSecAfterCommit: 0 } }), "continuation_listing_invalid"],
      ["auto-accept", await pinned("auto-accept", { terms: { deadlineSecAfterCommit: 600, acceptanceModel: "auto-accept" } }), "continuation_listing_invalid"],
      // A fixed-price Listing that negotiates by RFQ is not a coherent DACS-1 Listing.
      ["an RFQ negotiation", await pinned("rfq", { pipeline: [{ kind: "negotiate-rfq" }, { kind: "commit-payee-bound-agreement" }, { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } }, { kind: "deliver-storage-program" }] }), "continuation_listing_invalid"],
    ] as const) {
      await expect(Promise.resolve().then(await check(w, given)), name).rejects.toThrowError(expect.objectContaining({ code, status: 500 }));
    }
    // A caller's object, or a copy of an admitted one, is not admitted.
    const admitted = wire.admitWireArtifact(received(LISTING) as Buffer);
    for (const given of [LISTING, structuredClone(admitted), JSON.stringify(LISTING)]) await expect(Promise.resolve().then(await check(x, given))).rejects.toThrowError(listingRefused("ARTIFACT-NOT-ADMITTED"));
    await expect(Promise.resolve().then(await check(x, Buffer.from(JSON.stringify(LISTING).replace('"dacsVersion":"1"', '"dacsVersion":"1","dacsVersion":"1"'))))).rejects.toThrowError(listingRefused("DUPLICATE-MEMBER"));
    // Its exact bytes, or the value admitWireArtifact returned, continue.
    for (const given of [received(LISTING), admitted]) expect((await await check(x, given)()).effect).toMatchObject({ state: "new" });
  }, 60_000); // several cases on every route, direct and delegated, each with its own journal: load-sensitive under the 5 s default

  it("verifies the pinned Listing's own signature under the seller's key (DACS-1 §6.3.4) on every continuing route, direct and delegated: the pin omits the signature", async () => {
    const x = await world();
    const other = party();
    const journals = testJournals();
    let receipts = 0;
    const refused = expect.objectContaining({ code: "continuation_listing_invalid", status: 500, detail: "LISTING-SIGNATURE" });
    const { signature } = LISTING;
    const resign = (value: Record<string, unknown>) => ({ ...LISTING, signature: { ...signature, ...value } });
    // The seller's key signs another Listing's hash, and another key signs this one's.
    const forged = (signer: { sign(bytes: Uint8Array): Uint8Array | Buffer }, hash: string) =>
      Buffer.from(signer.sign(Buffer.from(`dacs-listing:v1:${hash}`, "utf8"))).toString("base64url");
    const otherListing = tp1Listing({ seller: SELLER, listingId: "other-report" }).pin.contentHash;
    // DACS-1 §6.3.4 permits this second carried claim to sign with its own key.
    const coSigned = tp1Listing({ seller: other, listingId: "co-signed", patch: { seller: { ...LISTING.seller, identity: { ...LISTING.seller.identity, claims: [{ ref: SELLER.claim }, { ref: other.claim }] } } } });
    const cases: Array<[string, unknown, Awaited<ReturnType<typeof world>>]> = [
      ["a signature with one bit changed", resign({ value: flipped(signature.value) }), x],
      ["the seller's signature over another Listing", resign({ value: forged(SELLER, otherListing) }), x],
      ["another key's signature naming the seller", resign({ value: forged(other, x.pin.contentHash) }), x],
      ["another algorithm", resign({ algorithm: "ecdsa-secp256k1" }), x],
      ["seller bytes falsely attributed to a carried key", { ...coSigned.listing, signature: { ...coSigned.listing.signature, value: forged(SELLER, coSigned.pin.contentHash) } }, await world(coSigned)],
    ];
    for (const [name, listing, w] of cases) {
      const given = received(listing);
      // The tampered Listing keeps its pin: only the signature differs.
      expect(contentHash(listing as never), name).toBe(w.pin.contentHash);
      for (const path of CONTINUING) {
        for (const [mode, open, extra] of [["direct", async () => await w.direct(w.request(path)), {}], ["delegated", async () => await w.delegated(w.request(path)), { requireDelegation: true, artifacts: [w.artifact] }]] as const) {
          await expect(Promise.resolve().then(async () => await wire.checkWireRequest(await open(), { ...await w.check(path), ...extra, requestJournal: await journals.open(), signedListing: given, readCommitmentReceipt: Object.assign(() => { receipts++; return "valid"; }, { chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity }) })), `${name} ${mode} ${path}`).rejects.toThrowError(refused);
        }
      }
    }
    expect(journals.reservations()).toEqual([]);
    expect(receipts).toBe(0);
    const authorized = await world(coSigned);
    for (const path of CONTINUING) {
      for (const [open, extra] of [[async () => await authorized.direct(authorized.request(path)), {}],
        [async () => await authorized.delegated(authorized.request(path)), { requireDelegation: true, artifacts: [authorized.artifact] }]] as const) {
        expect((await wire.checkWireRequest(await open(), { ...await authorized.check(path), ...extra, requestJournal: testJournal() })).effect).toMatchObject({ state: "new" });
      }
    }
    // The primary key remains valid too.
    expect(journals.reservations()).toEqual([]);
    expect((await wire.checkWireRequest(await x.direct(x.request(P.payments)), { ...await x.check(P.payments), requestJournal: await journals.open() })).effect).toMatchObject({ state: "new" });
    expect(journals.reservations()).toHaveLength(1);
  }, 60_000); // several cases on every route, direct and delegated, each with its own journal: load-sensitive under the 5 s default

  it("refuses an Agreement both parties signed that carries a second discriminator (DACS-3 §8.5) or a priorPaymentDispositionRef under a Listing with no pay-alternative phase (§8.5.2 check 10), on every continuing route", async () => {
    const journals = testJournals();
    const prior = { anchor: { kind: "storage-program", locator: "prior-disposition" }, contentHash: "d".repeat(64) };
    const cases: Array<[string, Parameters<typeof world>[1], string]> = [
      ["the plain discriminator beside the payee-bound one", { patch: { agreementVersion: "1" } }, "continuation_agreement_invalid"],
      ["the identity-bound payee discriminator", { patch: { identityBoundPayeeAgreementVersion: "1" } }, "DISCRIMINATOR"],
      ["the identity-bound discriminator", { patch: { identityBoundAgreementVersion: "1" } }, "DISCRIMINATOR"],
      ["a priorPaymentDispositionRef", { terms: { priorPaymentDispositionRef: prior } }, "PRIOR-DISPOSITION"],
    ];
    for (const [name, options, want] of cases) {
      const w = await world(undefined, options);
      for (const path of CONTINUING) {
        await expect(Promise.resolve().then(async () => await wire.checkWireRequest(await w.direct(w.request(path)), { ...await w.check(path), requestJournal: await journals.open() })), `${name} ${path}`).rejects
          .toThrowError(expect.objectContaining({ code: "continuation_agreement_invalid", status: 500, ...(want === "continuation_agreement_invalid" ? {} : { detail: want }) }));
      }
    }
    expect(journals.reservations()).toEqual([]);
  });

  it("signs, opens and admits a request only for a route in the table, never another spelling of one that would skip the commitment check", async () => {
    const x = await world();
    const journals = testJournals();
    for (const alias of ["/dacs/v1/payments/", "/dacs/v1//payments", "/dacs/v1/Payments", "/dacs/v1/payments?x=1", "/dacs/v1/bundles/request/", "/dacs/v1/unknown", "/dacs/v1/agreements/state/"]) {
      // A buyer signs it, and the seller opens it, nowhere.
      await expect(Promise.resolve().then(async () => await x.direct(x.request(alias))), alias).rejects.toThrowError(expect.objectContaining({ code: "peer_envelope_invalid" }));
      await expect(wire.signWireEnvelope(x.request(alias), { signer: x.buyer, binding: x.binding, local: LOCAL, purchaseProfile: x.binding.profile, now: NOW }), alias)
        .rejects.toMatchObject({ code: "peer_envelope_invalid" });
      // A host that serves the alias and passes its raw path is refused for the signed route's path.
      for (const route of CONTINUING) {
        await expect(Promise.resolve().then(async () => await wire.checkWireRequest(await x.direct(x.request(route)), { ...await x.check(alias), requestJournal: await journals.open(), commitment: undefined })), `${alias} for ${route}`).rejects
          .toThrowError(expect.objectContaining({ code: "peer_request_mismatch" }));
      }
    }
    expect(journals.reservations()).toEqual([]);
  });

  it("checks the signed Agreement's terms against the pinned Listing (DACS-3 §8.5.2 checks 1-4) on every continuing route, direct and delegated", async () => {
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
      const w = await world({ listing: LISTING, pin: PIN }, change);
      for (const path of CONTINUING) {
        const journals = testJournals();
        const direct = async () => await wire.checkWireRequest(await w.direct(w.request(path)), { ...await w.check(path), requestJournal: await journals.open() });
        const delegated = async () => await wire.checkWireRequest(await w.delegated(w.request(path)), { ...await w.check(path), requireDelegation: true, artifacts: [w.artifact], requestJournal: await journals.open() } as wire.RequestCheck);
        await expect(Promise.resolve().then(direct), `${name} ${path} direct`).rejects.toThrowError(termsRefused);
        await expect(Promise.resolve().then(delegated), `${name} ${path} delegated`).rejects.toThrowError(termsRefused);
        expect(journals.reservations(), `${name} ${path}`).toHaveLength(0);
      }
    }
    // The SDK verifier's own reason is kept as the cause.
    const w = await world({ listing: LISTING, pin: PIN }, cases[0]![1]);
    let thrown: unknown;
    try { await wire.checkWireRequest(await w.direct(w.request(P.payments)), { ...await w.check(P.payments), requestJournal: testJournal() }); } catch (error) { thrown = error; }
    expect((thrown as Error).cause).toEqual(expect.objectContaining({ message: expect.stringMatching(/price/) }));
    // The Agreement derived from the Listing continues.
    const derived = await world();
    expect((await wire.checkWireRequest(await derived.direct(derived.request(P.payments)), { ...await derived.check(P.payments), requestJournal: testJournal() })).effect).toMatchObject({ state: "new" });
  }, 60_000); // several cases on every route, direct and delegated, each with its own journal: load-sensitive under the 5 s default

  it("continues only a TP-1 Listing: fixed DEM pricing, one pay-dem phase, and deliver-storage-program with a storage-program deliverable (DACS-4 §9.6.1)", async () => {
    const pipeline = (pay: Array<Record<string, unknown>>, deliver: Array<Record<string, unknown>>) =>
      [{ kind: "negotiate-fixed-price" }, { kind: "commit-payee-bound-agreement" }, ...pay, ...deliver];
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
      const w = await world(l);
      for (const path of CONTINUING) {
        const journals = testJournals();
        await expect(Promise.resolve().then(async () => await wire.checkWireRequest(await w.direct(w.request(path)), { ...await w.check(path), requestJournal: await journals.open() })), `${name} ${path} direct`).rejects
          .toThrowError(expect.objectContaining({ code, status: 500, detail }));
        await expect(Promise.resolve().then(async () => await wire.checkWireRequest(await w.delegated(w.request(path)), { ...await w.check(path), requireDelegation: true, artifacts: [w.artifact], requestJournal: await journals.open() } as wire.RequestCheck)),
          `${name} ${path} delegated`).rejects.toThrowError(expect.objectContaining({ code, status: 500, detail }));
        expect(journals.reservations(), `${name} ${path}`).toHaveLength(0);
      }
    }
    // The canonical TP-1 Listing is this shape, and continues.
    expect(LISTING.offering.deliverable.kind).toBe("storage-program");
    expect(LISTING.pipeline.map((phase) => phase.kind)).toEqual(["negotiate-fixed-price", "commit-payee-bound-agreement", "pay-dem", "deliver-storage-program"]);
  }, 60_000); // several cases on every route, direct and delegated, each with its own journal: load-sensitive under the 5 s default

  it("re-evaluates DACS-3 §8.5.2 checks 5 and 6 at the receipt time from the seller's own Listing, on every continuing route, direct and delegated", async () => {
    // A Listing that ended ten minutes ago: a purchase committed while it was valid continues; one committed after it ended does not (check 6).
    const notBefore = NOW - 3_600_000, notAfter = NOW - 600_000;
    const ended = tp1Listing({ seller: SELLER, listingId: "ended", validity: { notBefore, notAfter } });
    const w = await world(ended, { generatedAt: notBefore });
    const generatedAt = (w.agreement as unknown as { generatedAt: number }).generatedAt;
    const deadline = (w.agreement as unknown as { terms: { deadline: number } }).terms.deadline;
    expect(deadline).toBe(generatedAt + 600_000);
    const invalid = expect.objectContaining({ code: "continuation_commitment_invalid", status: 500 });
    const modes = (x: Awaited<ReturnType<typeof world>>, path: string) => [
      ["direct", async () => await x.direct(x.request(path)), {}],
      ["delegated", async () => await x.delegated(x.request(path)), { requireDelegation: true, artifacts: [{ ...x.artifact, listingRef: x.pin }] }],
    ] as const;
    const run = (x: Awaited<ReturnType<typeof world>>, path: string, committedAt: number) => modes(x, path).map(([mode, open, extra]) => [mode, async () =>
      await wire.checkWireRequest(await open(), { ...await x.check(path), ...extra, requestJournal: testJournal(), commitment: received(x.commitment({ committedAt })) } as wire.RequestCheck)] as const);
    // An Agreement generated before the Listing opened (a hand-built one): its commitment before notBefore is refused.
    // Its deadline is within the limit, so only notBefore refuses it.
    const early = await world(ended, { generatedAt: notBefore, patch: { generatedAt: notBefore - 2000 }, terms: { deadline: notBefore + 590_000 } });
    // Its deadline at the limit committedAt + deadlineSecAfterCommit, and one millisecond past it (check 5).
    const atLimit = await world(ended, { generatedAt: notBefore, terms: { deadline: notBefore + 1000 + 600_000 } });
    const pastLimit = await world(ended, { generatedAt: notBefore, terms: { deadline: notBefore + 1000 + 600_001 } });
    // Committed at the Agreement's own deadline, and one millisecond after it.
    const atDeadline = await world(ended, { generatedAt: notBefore, terms: { deadline: notBefore + 1000 } });
    const pastDeadline = await world(ended, { generatedAt: notBefore, terms: { deadline: notBefore + 999 } });
    // Its deadline is after notAfter, so only notAfter decides there.
    const late = await world(ended, { generatedAt: notBefore, terms: { deadline: notAfter + 1000 } });
    for (const path of CONTINUING) {
      for (const [mode, check] of run(late, path, notAfter)) expect((await check()).effect, `${path} ${mode}: at notAfter`).toMatchObject({ state: "new" });
      for (const [mode, check] of run(late, path, notAfter + 1)) await expect(Promise.resolve().then(check), `${path} ${mode}: after notAfter`).rejects.toThrowError(invalid);
      for (const [mode, check] of run(w, path, notBefore)) expect((await check()).effect, `${path} ${mode}: at notBefore`).toMatchObject({ state: "new" });
      for (const [mode, check] of run(early, path, notBefore - 1)) await expect(Promise.resolve().then(check), `${path} ${mode}: before notBefore`).rejects.toThrowError(invalid);
      for (const [mode, check] of run(atLimit, path, notBefore + 1000)) expect((await check()).effect, `${path} ${mode}: deadline at the limit`).toMatchObject({ state: "new" });
      for (const [mode, check] of run(pastLimit, path, notBefore + 1000)) await expect(Promise.resolve().then(check), `${path} ${mode}: deadline past the limit`).rejects.toThrowError(invalid);
      for (const [mode, check] of run(atDeadline, path, notBefore + 1000)) expect((await check()).effect, `${path} ${mode}: committed at the deadline`).toMatchObject({ state: "new" });
      for (const [mode, check] of run(pastDeadline, path, notBefore + 1000)) await expect(Promise.resolve().then(check), `${path} ${mode}: committed after the deadline`).rejects.toThrowError(invalid);
      // A deadline ten years out, as a seller-signed record could commit after the gate refused it.
      for (const [mode, check] of run(await world(ended, { generatedAt: notBefore, terms: { deadline: NOW + 10 * 365 * 86_400_000 } }), path, notBefore + 1000)) {
        await expect(Promise.resolve().then(check), `${path} ${mode}: deadline ten years out`).rejects.toThrowError(invalid);
      }
    }
  }, 60_000); // several cases on every route, direct and delegated, each with its own journal: load-sensitive under the 5 s default

  it("refuses the record the SDK's own gate anchored and then refused after finality, when the seller reads it back", async () => {
    const purchase = await acceptedPurchase({ jobId: JOB, generatedAt: NOW, validity: { notBefore: NOW - 600_000, notAfter: NOW + 10_000 }, publicEndpoint: ENDPOINT });
    await expect(commitPurchase(purchase, NOW + 20_000)).rejects.toThrow(/authoritative agreement\/Listing checks/);
    // The same seller-signed, finalized record, as the seller's host reads it back from the chain after a restart.
    const record = wireCommitment({ seller: purchase.seller, buyer: purchase.buyer.claim, jobId: JOB, agreementHash: purchase.agreementHash, listingPin: purchase.pin, committedAt: NOW + 20_000 });
    const binding = await bindTp1Fixture({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local: LOCAL });
    const at = NOW + 25_000;
    for (const path of CONTINUING) {
      const payload: wire.WireRequestPayload = { version: "1", kind: "request", method: "POST", path, bodyHash: sha256Hex("{}"), jobId: JOB, buyer: purchase.buyer.claim,
        seller: purchase.seller.claim, listingPin: purchase.pin, agreementHash: purchase.agreementHash, nonce: nonce(), expiresAt: at + 30_000, profile: binding.profile };
      const signature = Buffer.from(purchase.buyer.signBytes(Buffer.from(wire.DACS_SELLER_HTTP_DOMAINS.request + canonicalize(payload)))).toString("base64url");
      const opened = await wire.openWireEnvelope(header({ payload, signature }), "request", { binding, local: LOCAL, purchaseProfile: binding.profile });
      await expect(Promise.resolve().then(async () => await wire.checkWireRequest(opened, { binding, local: LOCAL, purchaseProfile: binding.profile, seller: purchase.seller.claim, listingPin: purchase.pin, method: "POST", path,
        rawBody: Buffer.from("{}"), now: at, retained: { jobId: JOB, agreementHash: purchase.agreementHash, buyer: purchase.buyer.claim, seller: purchase.seller.claim },
        requestJournal: testJournal(), commitment: received(record), agreement: received(purchase.agreement), signedListing: received(purchase.listing), readCommitmentReceipt: Object.assign(validReceipt, { chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity }) })), path).rejects
        .toThrowError(expect.objectContaining({ code: "continuation_commitment_invalid", status: 500 }));
    }
  });

  it("admits the commitment and Agreement from their exact received bytes (CF-5): a caller's object or a copy is refused", async () => {
    const x = await world();
    const journals = testJournals();
    const check = (given: Record<string, unknown>) => async () => await wire.checkWireRequest(await x.direct(x.request(P.payments)), { ...await x.check(P.payments), requestJournal: await journals.open(), ...given });
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
      await expect(Promise.resolve().then(await check({ commitment: bytes })), name).rejects.toThrowError(refused("continuation_commitment_invalid", detail));
      await expect(Promise.resolve().then(await check({ agreement: Buffer.from(agreementText.replace('"payeeBoundAgreementVersion":"1"', '"payeeBoundAgreementVersion":"1","payeeBoundAgreementVersion":"1"')) })), name).rejects
        .toThrowError(refused("continuation_agreement_invalid", "DUPLICATE-MEMBER"));
    }
    // The same evidence as a caller's object, a decoded string, or a copy of an admitted value: nothing shows its bytes were admitted.
    const admitted = wire.admitWireArtifact(Buffer.from(commitmentText));
    for (const given of [x.commitment(), commitmentText, JSON.parse(JSON.stringify(admitted)), structuredClone(admitted)]) {
      await expect(Promise.resolve().then(await check({ commitment: given }))).rejects.toThrowError(refused("continuation_commitment_invalid", "ARTIFACT-NOT-ADMITTED"));
    }
    await expect(Promise.resolve().then(await check({ agreement: x.agreement }))).rejects.toThrowError(refused("continuation_agreement_invalid", "ARTIFACT-NOT-ADMITTED"));
    expect(journals.reservations()).toHaveLength(0);
    // Exact bytes, a value admitWireArtifact returned, or part of an admitted body continue.
    const sent = Buffer.from(JSON.stringify({ commitment: x.commitment(), agreement: x.agreement }));
    const body = wire.admitWireRequestBody(sent), answer = wire.admitWireResponseBody(sent);
    expect(Object.isFrozen(body.commitment)).toBe(true);
    expect(Object.isFrozen(answer.agreement)).toBe(true);
    for (const given of [{}, { commitment: admitted, agreement: wire.admitWireArtifact(Buffer.from(agreementText)) }, { commitment: body.commitment, agreement: body.agreement },
      { commitment: answer.commitment, agreement: answer.agreement }]) {
      expect((await await check(given)()).effect).toMatchObject({ state: "new" });
    }
    // admitWireArtifact keeps admission's own refusal.
    expect(() => wire.admitWireArtifact(malformed[0]![1])).toThrowError(expect.objectContaining({ code: "wire_artifact_rejected", status: 500, detail: "DUPLICATE-MEMBER" }));
    expect(() => wire.admitWireArtifact(commitmentText as never)).toThrowError(expect.objectContaining({ code: "wire_input_invalid", status: 500 }));
  });

  it("checks the receipt as a CORE §5.1 AnchorReceipt, its transaction as a ChainTxRef, and a receipt time no earlier than the Agreement", async () => {
    const x = await world();
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
      await expect(Promise.resolve().then(async () => await wire.checkWireRequest(await x.direct(x.request(P.payments)), { ...await x.check(P.payments), requestJournal: testJournal(), commitment: received(commitment) })), name).rejects
        .toThrowError(expect.objectContaining({ code: "continuation_commitment_invalid", status: 500 }));
    }
    // At the Agreement's own time, it continues.
    expect((await wire.checkWireRequest(await x.direct(x.request(P.payments)), { ...await x.check(P.payments), requestJournal: testJournal(), commitment: received(x.commitment({ committedAt: generatedAt })) })).effect)
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
    const binding = (await bindTp1Fixture({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local: LOCAL }));
    const discoveryAt = (issuedAt: number) => wire.signDiscoveryDocument({ format: "dacs-seller-discovery/v1", profile: binding.profile, seller: seller.claim, publicEndpoint: ENDPOINT,
      transport: ["dacs-seller-http/v1"], listings: [pin], capabilities: wire.TP1_CAPABILITIES, ready: false, issuedAt, expiresAt: issuedAt + 60_000 }, seller, binding, LOCAL);
    const discovery = await discoveryAt(ENDED - 1000), early = await discoveryAt(NOW + 20_000);
    const listing = { seller: seller.claim, publicEndpoint: ENDPOINT, listingPin: pin };
    const input = (commitment: unknown, agreement: unknown, endpointProof: wire.EndpointProof, path: string = P.payments) => ({ signer: buyer, binding, local: LOCAL, seller: seller.claim, jobId: JOB, path, text: "{}",
      job: { listingPin: pin, agreementHash: purchase.agreementHash, profile: binding.profile }, now: ENDED, publicEndpoint: ENDPOINT, endpointProof, commitment, agreement, signedListing: received(purchase.listing) });
    return { purchase, buyer, seller, pin, sellerResult, sent: Buffer.from(JSON.stringify({ commitment: sellerResult, agreement: purchase.agreement })), binding, discovery, early, listing, input };
  }

  it("requires the buyer's own current receipt reader before continuing a purchase", async () => {
    const { purchase, buyer, sent, binding, discovery, early, listing, input } = await committed();
    // Without its own receipt reader, the buyer continues nothing: the seller's word is not evidence.
    const got = wire.admitWireArtifact(sent) as { commitment: unknown; agreement: unknown };
    await expect(Promise.resolve().then(async () => (await wire.verifyEndpointProof(discovery, { request: { path: P.payments, jobId: JOB, buyer: buyer.claim, agreementHash: purchase.agreementHash }, readListingEligibility: windowed, listing, binding, local: LOCAL, now: ENDED, commitment: got.commitment, agreement: got.agreement, signedListing: received(purchase.listing) })))).rejects
      .toThrowError(expect.objectContaining({ code: "commitment_reader_required", status: 500 }));
    const unread = (await wire.verifyEndpointProof(early, { readListingEligibility: windowed, listing, binding, local: LOCAL, now: NOW + 30_000 }));
    await expect(wire.signWireRequest({ ...input(got.commitment, got.agreement, unread), now: NOW + 30_000 })).rejects.toMatchObject({ code: "commitment_reader_required" });
    expect(buyer.calls).toBe(0);
    // A reader that cannot establish the receipt leaves the purchase undecided: never final.
    await expect(Promise.resolve().then(async () => (await wire.verifyEndpointProof(discovery, { request: { path: P.payments, jobId: JOB, buyer: buyer.claim, agreementHash: purchase.agreementHash }, readListingEligibility: windowed, readCommitmentReceipt: Object.assign(() => "indeterminate", { chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity }), listing, binding, local: LOCAL, now: ENDED, commitment: got.commitment, agreement: got.agreement, signedListing: received(purchase.listing) })))).rejects
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
      await expect(Promise.resolve().then(async () => (await wire.verifyEndpointProof(discovery, { request: { path: P.payments, jobId: JOB, buyer: buyer.claim, agreementHash: forged.agreementHash }, readListingEligibility: windowed, readCommitmentReceipt: Object.assign(validReceipt, { chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity }), listing, binding, local: LOCAL, now: ENDED, commitment: received(record), agreement: received(agreement), signedListing: received(purchase.listing) })))).rejects
        .toThrowError(expect.objectContaining({ code: "continuation_agreement_invalid", status: 500 }));
    }
    // The buyer's kept proof is for its genuine purchase; signing the forged one is refused at signWireRequest and at signWireEnvelope.
    const proof = (await wire.verifyEndpointProof(discovery, { request: { path: P.payments, jobId: JOB, buyer: buyer.claim, agreementHash: purchase.agreementHash }, readListingEligibility: windowed, readCommitmentReceipt: Object.assign(validReceipt, { chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity }), listing, binding, local: LOCAL, now: ENDED,
      commitment: received(await commitPurchase(purchase, NOW + 1000)), agreement: received(purchase.agreement), signedListing: received(purchase.listing) }));
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
    const prove = (e: ReturnType<typeof evidence>) => async () => (await wire.verifyEndpointProof(discovery, { request: { path: P.payments, jobId: JOB, buyer: buyer.claim, agreementHash: e.agreementHash }, readListingEligibility: windowed, readCommitmentReceipt: Object.assign(validReceipt, { chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity }), listing, binding, local: LOCAL,
      now: ENDED, commitment: e.commitment, agreement: received(e.agreement), signedListing: received(purchase.listing) }));
    const proof = await (await prove(evidence(NOW + 1000)))();
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
      if (continues) await expect(prove(e)(), name).resolves.toMatchObject({ ready: false });
      else await expect(Promise.resolve().then((await prove(e))), name).rejects.toThrowError(expect.objectContaining(invalid));
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
      await expect(Promise.resolve().then(async () => (await wire.verifyEndpointProof(discovery, { request: { path: P.payments, jobId: JOB, buyer: buyer.claim, agreementHash: purchase.agreementHash }, readListingEligibility: windowed, readCommitmentReceipt: Object.assign(validReceipt, { chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity }), listing, binding, local: LOCAL, now: ENDED,
        commitment: evidence(NOW + 1000).commitment, agreement: received(purchase.agreement), signedListing })))).rejects.toThrowError(expect.objectContaining({ code: "continuation_listing_invalid", status: 500 }));
    }
  });

  it("refuses, at both signers, a seller-anchored Agreement both parties signed whose terms are not the pinned Listing's (DACS-3 §8.5.2 checks 1-4)", async () => {
    const { purchase, buyer, seller, pin, binding, discovery, listing, input } = await committed();
    const terms = (purchase.agreement as unknown as { terms: Record<string, unknown> }).terms;
    const deliverable = terms.deliverable as Record<string, unknown>;
    const proof = (await wire.verifyEndpointProof(discovery, { request: { path: P.payments, jobId: JOB, buyer: buyer.claim, agreementHash: purchase.agreementHash }, readListingEligibility: windowed, readCommitmentReceipt: Object.assign(validReceipt, { chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity }), listing, binding, local: LOCAL, now: ENDED,
      commitment: received(await commitPurchase(purchase, NOW + 1000)), agreement: received(purchase.agreement), signedListing: received(purchase.listing) }));
    const refused = { code: "continuation_agreement_invalid", status: 500, detail: "LISTING-TERMS" };
    for (const [name, changed] of [
      ["2 DEM under the 1 DEM Listing", { price: { amount: "2", currency: "DEM" } }],
      ["another rail version", { rail: { railId: "demos-native:DEM", railVersion: 2 } }],
      ["another deliverable hash", { deliverable: { ...deliverable, hash: "e".repeat(64) } }],
    ] as const) {
      // Both parties signed it and the seller anchored a finalized record for it; the SDK's own gate would never have committed it.
      const forged = signedAgreement({ buyer, seller, jobId: JOB, listingPin: pin, listing: { listing: purchase.listing, pin }, generatedAt: NOW, patch: { terms: { ...terms, ...changed } } });
      const record = received(wireCommitment({ seller, buyer: buyer.claim, jobId: JOB, agreementHash: forged.agreementHash, listingPin: pin, committedAt: NOW + 1000 }));
      await expect(Promise.resolve().then(async () => (await wire.verifyEndpointProof(discovery, { request: { path: P.payments, jobId: JOB, buyer: buyer.claim, agreementHash: forged.agreementHash }, readListingEligibility: windowed, readCommitmentReceipt: Object.assign(validReceipt, { chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity }), listing, binding, local: LOCAL, now: ENDED,
        commitment: record, agreement: received(forged.agreement), signedListing: received(purchase.listing) }))), name).rejects.toThrowError(expect.objectContaining(refused));
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

  it("refuses, at both signers, a continuation under a Listing whose signature is not the seller's over the pinned Listing (DACS-1 §6.3.4)", async () => {
    const { purchase, buyer, seller, pin, sellerResult, binding, discovery, listing, input } = await committed();
    const proof = (await wire.verifyEndpointProof(discovery, { request: { path: P.payments, jobId: JOB, buyer: buyer.claim, agreementHash: purchase.agreementHash }, readListingEligibility: windowed, readCommitmentReceipt: Object.assign(validReceipt, { chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity }), listing, binding, local: LOCAL, now: ENDED,
      commitment: received(sellerResult), agreement: received(purchase.agreement), signedListing: received(purchase.listing) }));
    const refusedAs = (detail?: string) => ({ code: "continuation_listing_invalid", status: 500, ...(detail === undefined ? {} : { detail }) });
    const { signature } = purchase.listing;
    // The signature is not part of the pin, so the Listing, Agreement and finality record are all still the ones the parties signed.
    for (const [name, changed, detail] of [
      ["a signature with one bit changed", { value: flipped(signature.value) }, "LISTING-SIGNATURE"],
      ["another algorithm", { algorithm: "ecdsa-secp256k1" }, "LISTING-SIGNATURE"],
      // Not among the seller's claims, so not even a well-formed Listing (isListing).
      ["another signer", { signer: buyer.claim }, undefined],
    ] as const) {
      const refused = refusedAs(detail);
      const tampered = { ...purchase.listing, signature: { ...signature, ...changed } };
      expect(contentHash(tampered as never), name).toBe(pin.contentHash);
      await expect(Promise.resolve().then(async () => (await wire.verifyEndpointProof(discovery, { request: { path: P.payments, jobId: JOB, buyer: buyer.claim, agreementHash: purchase.agreementHash }, readListingEligibility: windowed, readCommitmentReceipt: Object.assign(validReceipt, { chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity }), listing, binding, local: LOCAL, now: ENDED,
        commitment: received(sellerResult), agreement: received(purchase.agreement), signedListing: received(tampered) }))), name).rejects.toThrowError(expect.objectContaining(refused));
      for (const path of CONTINUING) {
        await expect(wire.signWireRequest({ ...input(received(sellerResult), received(purchase.agreement), proof, path), signedListing: received(tampered) }), `${name} ${path}`).rejects.toMatchObject(refused);
        const payload: wire.WireRequestPayload = { version: "1", kind: "request", method: "POST", path, bodyHash: sha256Hex("{}"), jobId: JOB, buyer: buyer.claim, seller: seller.claim,
          listingPin: pin, agreementHash: purchase.agreementHash, nonce: nonce(), expiresAt: ENDED + 30_000, profile: binding.profile };
        await expect(wire.signWireEnvelope(payload, { signer: buyer, binding, local: LOCAL, purchaseProfile: binding.profile, endpointProof: proof, publicEndpoint: ENDPOINT, now: ENDED,
          commitment: received(sellerResult), agreement: received(purchase.agreement), signedListing: received(tampered) }), `${name} ${path}`).rejects.toMatchObject(refused);
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
    await expect(Promise.resolve().then(async () => (await wire.verifyEndpointProof(document, { request: { path: P.payments, jobId: JOB, buyer: buyer.claim, agreementHash: a.agreementHash }, readListingEligibility: open, readCommitmentReceipt: Object.assign(validReceipt, { chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity }), listing, binding, local: LOCAL, now: ENDED,
      commitment: record, agreement: received(a.agreement), signedListing: received(l.listing) })))).rejects.toThrowError(expect.objectContaining(refused));
    const proof = (await wire.verifyEndpointProof(document, { readListingEligibility: open, readCommitmentReceipt: Object.assign(validReceipt, { chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity }), listing, binding, local: LOCAL, now: ENDED }));
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

describe("an effect is reserved only in the SDK's durable journal", { timeout: 60_000 }, () => {
  it("refuses any journal openWireRequestJournal did not return, a host's own durable or shared one included, before anything is reserved", async () => {
    const x = (await world());
    const held = new Set<string>();
    const reserve = (r: { key: string }) => (held.has(r.key) ? false : (held.add(r.key), true));
    const directory = journalDirectory();
    const opened = wire.openWireRequestJournal(directory);
    for (const journal of [{ durable: true, reserve }, { qualified: true }, { directory }, { ...opened }, Object.freeze({ directory }), () => true, null, undefined]) {
      for (const path of [P.proposals, ...CONTINUING]) {
        await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await x.direct(x.request(path))), { ...x.check(path), requestJournal: journal as never })))).rejects
          .toThrowError(expect.objectContaining({ code: "seller_replay_guard_required", status: 500 }));
      }
    }
    expect(held.size).toBe(0);
    expect((await wire.checkWireRequest((await x.direct(x.request(P.payments))), { ...x.check(P.payments), requestJournal: opened })).effect).toMatchObject({ state: "new", attempt: 0 });
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

  it("gives each job and route one operation, whatever the nonce or the body", async () => {
    const x = (await world());
    const journals = testJournals();
    const journal = (await journals.open());
    const at = async (path: string, body: string) => (await wire.checkWireRequest((await x.direct(x.request(path, body))), { ...x.check(path, body), requestJournal: journal }));
    const payload = x.request(P.payments);
    const { seller, jobId, path } = payload;
    // Only the seller, job and route: no body, nonce, Agreement hash, buyer or tuple.
    expect(wire.wireOperationId(payload)).toBe(sha256Hex(canonicalize({ seller, jobId, path })));
    expect(wire.wireOperationId({ ...payload, agreementHash: "b".repeat(64), buyer: party().claim, bodyHash: "d".repeat(64) } as never)).toBe(wire.wireOperationId(payload));
    for (const route of [P.proposals, ...CONTINUING]) {
      const first = (await at(route, '{"amount":"1","note":"x"}'));
      expect(first.effect).toMatchObject({ state: "new", attempt: 0, operationId: wire.wireOperationId({ ...payload, path: route }) });
      // Another nonce, another encoding, other incidental fields: the same operation, still held by the first attempt.
      for (const repeat of ['{"amount":"1","note":"x"}', '{ "note": "x", "amount": "1" }', '{"amount":"1","note":"y"}']) {
        await expect(Promise.resolve().then(async () => (await at(route, repeat))), `${route} ${repeat}`).rejects.toThrowError(expect.objectContaining({ code: "seller_effect_pending", status: 503 }));
      }
    }
    // The same signed request again is a replay.
    const once = x.request(P.payments);
    const opened = async () => (await x.direct(once));
    await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await opened()), { ...x.check(P.payments), requestJournal: journal })))).rejects.toThrowError(expect.objectContaining({ code: "seller_effect_pending" }));
    await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await opened()), { ...x.check(P.payments), requestJournal: journal })))).rejects.toThrowError(expect.objectContaining({ code: "peer_request_replayed", status: 409 }));
    expect(new Set(journals.reservations().map((r) => r.operationId)).size).toBe(4);
  }, 60_000); // several cases on every route, direct and delegated, each with its own journal: load-sensitive under the 5 s default

  it("never gives a job and route a second effect when the retained Agreement changes: before and after completion, and across a reopen", async () => {
    const x = (await world());
    const directory = journalDirectory();
    const another = signedAgreement({ buyer: x.buyer, seller: x.seller, jobId: JOB, listingPin: PIN, generatedAt: NOW - 30_000 });
    expect(another.agreementHash).not.toBe(x.agreementHash);
    /** The same job and route under the Agreement the host retained first, or under another one it retained later. */
    const at = async (path: string, journal: wire.WireRequestJournal, changed: boolean) => (await wire.checkWireRequest(
      (await x.direct({ ...x.request(path), ...(changed ? { agreementHash: another.agreementHash } : {}) })),
      { ...x.check(path), requestJournal: journal, ...(changed ? {
        retained: { ...x.retained, agreementHash: another.agreementHash }, agreement: received(another.agreement),
        commitment: received(x.commitment({ agreementHash: another.agreementHash })),
      } : {}) }));
    const mismatch = expect.objectContaining({ code: "peer_operation_mismatch", status: 409 });
    for (const path of [P.proposals, ...CONTINUING]) {
      const journal = wire.openWireRequestJournal(directory);
      const first = (await at(path, journal, false)).effect!;
      expect(first.state, path).toBe("new");
      // Held by the first attempt: another Agreement is refused, not told to wait or given its own operation.
      await expect(Promise.resolve().then(async () => (await at(path, journal, true))), path).rejects.toThrowError(mismatch);
      wire.completeWireEffect(journal, first, { status: 200, text: `{"path":"${path}"}` });
      await expect(Promise.resolve().then(async () => (await at(path, journal, true))), path).rejects.toThrowError(mismatch);
      // A restarted worker reads the same binding from the directory.
      const reopened = wire.openWireRequestJournal(directory);
      await expect(Promise.resolve().then(async () => (await at(path, reopened, true))), path).rejects.toThrowError(mismatch);
      expect((await at(path, reopened, false)).effect, path).toMatchObject({ state: "completed", operationId: first.operationId, outcome: { status: 200, text: `{"path":"${path}"}` } });
    }
    // Each refused request spent its nonce and nothing else: four operations, one attempt each.
    expect(readdirSync(directory).filter((name) => /^o-[0-9a-f]{64}-0$/.test(name))).toHaveLength(4);
    expect(readdirSync(directory).filter((name) => /^o-[0-9a-f]{64}-[1-9]/.test(name))).toEqual([]);
  }, 60_000); // several cases on every route, direct and delegated, each with its own journal: load-sensitive under the 5 s default

  it("refuses an attempt record the journal did not write as a corrupt store, never as a lapsed lease", async () => {
    const x = (await world());
    const directory = journalDirectory();
    const journal = wire.openWireRequestJournal(directory);
    const at = async () => (await wire.checkWireRequest((await x.direct(x.request(P.payments))), { ...x.check(P.payments), requestJournal: journal }));
    const first = (await at()).effect!;
    const file = join(directory, `o-${first.operationId}-0`);
    const kept = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(kept).sort()).toEqual(["attempt", "binding", "leaseUntil", "operationId", "requestHash", "superseded"]);
    for (const contents of ["not json", "{}", JSON.stringify({ ...kept, leaseUntil: "later" }), JSON.stringify({ ...kept, attempt: 1 }), JSON.stringify({ ...kept, binding: undefined })]) {
      writeFileSync(file, contents);
      await expect(Promise.resolve().then(async () => (await at())), contents).rejects.toThrowError(expect.objectContaining({ code: "seller_replay_guard_invalid", status: 500, detail: "STORE-ATTEMPT-INVALID" }));
    }
    writeFileSync(file, JSON.stringify(kept));
    await expect(Promise.resolve().then(async () => (await at()))).rejects.toThrowError(expect.objectContaining({ code: "seller_effect_pending", status: 503 }));
  });

  it("answers a repeat of a completed operation with its outcome and runs no second effect", async () => {
    const x = (await world());
    const journal = testJournal();
    const at = async (body: string) => (await wire.checkWireRequest((await x.direct(x.request(P.payments, body))), { ...x.check(P.payments, body), requestJournal: journal }));
    const first = (await at('{"tx":"1"}'));
    expect(first.effect?.state).toBe("new");
    const outcome = { status: 200, text: '{"paid":true}' };
    wire.completeWireEffect(journal, first.effect!, outcome);
    // Completing again with the same outcome is a no-op; another outcome is refused.
    wire.completeWireEffect(journal, first.effect!, { ...outcome });
    expect(() => wire.completeWireEffect(journal, first.effect!, { status: 200, text: '{"paid":false}' })).toThrowError(expect.objectContaining({ code: "seller_effect_conflict" }));
    expect(() => wire.completeWireEffect(journal, first.effect!, null)).toThrowError(expect.objectContaining({ code: "seller_effect_conflict" }));
    for (const body of ['{"tx":"1"}', '{"tx":"2"}']) expect((await at(body)).effect).toEqual({ state: "completed", operationId: first.effect!.operationId, outcome });
  });

  it.each(['{"réport": "linéx \\u00e9 \u{1F600}",  "a":[1, 2]}', '{"a":"e\u0301"}', '{"a":"e\\u0301"}'])("keeps outcome text byte for byte across completion, repeats and restart (%#)", async (text) => {
    const x = (await world());
    const directory = journalDirectory();
    const journal = wire.openWireRequestJournal(directory);
    const at = async (j: wire.WireRequestJournal, body: string) => (await wire.checkWireRequest((await x.direct(x.request(P.payments, body))), { ...x.check(P.payments, body), requestJournal: j }));
    // CF-5 preserves received values; canonical JSON would rewrite these body bytes.
    expect(Buffer.from(text).toString("utf8")).toBe(text);
    expect(canonicalize(JSON.parse(text))).not.toBe(text);
    expect(() => admitOutgoingBody(text, 512 * 1024)).not.toThrow();
    const outcome = { status: 200, text };
    const first = (await at(journal, '{"tx":"1"}'));
    wire.completeWireEffect(journal, first.effect!, outcome);
    const done = { state: "completed", operationId: first.effect!.operationId, outcome };
    expect((await at(journal, '{"tx":"2"}')).effect).toEqual(done);
    // Completing again with the same text is a no-op; a restart (another handle on the directory) reads it back unchanged.
    wire.completeWireEffect(journal, first.effect!, { ...outcome });
    const restarted = (await at(wire.openWireRequestJournal(directory), '{"tx":"3"}')).effect as { outcome: { text: string } };
    expect(restarted).toEqual(done);
    expect(Buffer.from(restarted.outcome.text, "utf8").equals(Buffer.from(text, "utf8"))).toBe(true);
    // Another spelling of the same JSON is another text: it conflicts with the stored one.
    expect(() => wire.completeWireEffect(journal, first.effect!, { status: 200, text: canonicalize(JSON.parse(text)) })).toThrowError(expect.objectContaining({ code: "seller_effect_conflict" }));
  });

  it("refuses an outcome whose text is not well-formed UTF-8 (a lone surrogate would be stored as another character) before anything is published", async () => {
    const x = (await world());
    const journal = testJournal();
    const { effect } = (await wire.checkWireRequest((await x.direct(x.request(P.payments))), { ...x.check(P.payments), requestJournal: journal }));
    for (const text of ["\ud800", '{"a":"\udc00"}', "ok\ud83d"]) {
      expect(() => wire.completeWireEffect(journal, effect!, { status: 200, text }), text).toThrowError(expect.objectContaining({ code: "wire_input_invalid", detail: "OUTCOME-INVALID" }));
    }
    expect(() => wire.completeWireEffect(journal, effect!, { status: 200, text: '{"smile":"\u{1F600}"}' })).not.toThrow();
  });

  it("refuses an outcome whose text the wire could never sign (CF-5 admission of a response body), before anything is published: no answer is left unanswerable", async () => {
    const x = (await world());
    const journal = testJournal();
    const at = async (body: string) => (await wire.checkWireRequest((await x.direct(x.request(P.payments, body))), { ...x.check(P.payments, body), requestJournal: journal }));
    const { effect } = (await at('{"tx":"1"}'));
    const refused = expect.objectContaining({ code: "wire_input_invalid", status: 500, detail: "OUTCOME-INVALID" });
    const unsignable: Array<[string, string]> = [
      ["a duplicate member", '{"a":1,"a":2}'],
      ["a body that is not an object", "0"],
      ["an array", "[]"],
      ["null", "null"],
      ["text that is not JSON", "paid"],
      ["the empty text", ""],
    ];
    for (const [name, text] of unsignable) {
      // The refusal is the wire's own rule: signing the same text is refused by CF-5 admission.
      expect(() => admitOutgoingBody(text, 512 * 1024), name).toThrowError(expect.objectContaining({ code: "outgoing_body_rejected" }));
      expect(() => wire.completeWireEffect(journal, effect!, { status: 200, text }), name).toThrowError(refused);
    }
    // No refusal published anything: the attempt is still open, and a text the wire signs completes it.
    await expect(Promise.resolve().then(async () => (await at('{"tx":"2"}')))).rejects.toThrowError(expect.objectContaining({ code: "seller_effect_pending" }));
    const signable = '{"paid":true,"note":"NFC cafeé \u{1F600}"}';
    expect(() => admitOutgoingBody(signable, 512 * 1024)).not.toThrow();
    wire.completeWireEffect(journal, effect!, { status: 200, text: signable });
    expect((await at('{"tx":"3"}')).effect).toMatchObject({ state: "completed", outcome: { status: 200, text: signable } });
  });

  it("refuses to complete an effect it did not issue, on another journal, or with a malformed outcome", async () => {
    const x = (await world());
    const journal = testJournal(), other = testJournal();
    const { effect } = (await wire.checkWireRequest((await x.direct(x.request(P.payments))), { ...x.check(P.payments), requestJournal: journal }));
    const code = (f: () => void) => { try { f(); return "ok"; } catch (error) { return (error as wire.WireError).detail ?? (error as wire.WireError).code; } };
    expect(code(() => wire.completeWireEffect(journal, { ...effect! }, null))).toBe("EFFECT-NOT-ISSUED");
    expect(code(() => wire.completeWireEffect(other, effect!, null))).toBe("EFFECT-NOT-ISSUED");
    expect(code(() => wire.completeWireEffect({ directory: journal.directory }, effect!, null))).toBe("seller_replay_guard_required");
    for (const outcome of [{ status: 199, text: "{}" }, { status: 600, text: "{}" }, { status: 200 }, { status: 200, text: 7 }, { status: 200, text: "x".repeat(512 * 1024 + 1) }]) {
      expect(code(() => wire.completeWireEffect(journal, effect!, outcome as never))).toBe("OUTCOME-INVALID");
    }
    expect(code(() => wire.completeWireEffect(journal, effect!, { status: 200, text: "{}" }))).toBe("ok");
  });

  it("recovers an attempt whose lease ended with no outcome: exactly one worker holds the recovery, and the outcome is kept once", async () => {
    const x = (await world());
    let clock = NOW;
    const directory = journalDirectory();
    const worker = () => wire.openWireRequestJournal(directory, { leaseMs: 1000, clock: () => clock });
    const a = worker(), b = worker();
    const at = async (journal: wire.WireRequestJournal, body = "{}") => (await wire.checkWireRequest((await x.direct(x.request(P.bundleRequest, body))), { ...x.check(P.bundleRequest, body), requestJournal: journal }));
    const first = (await at(a)).effect!;
    expect(first).toMatchObject({ state: "new", attempt: 0, leaseUntil: NOW + 1000 });
    clock = NOW + 999;
    await expect(Promise.resolve().then(async () => (await at(b)))).rejects.toThrowError(expect.objectContaining({ code: "seller_effect_pending", status: 503 }));
    // The first worker died without an outcome; its lease ends.
    clock = NOW + 1000;
    const recovered = (await at(b, '{"retry":true}')).effect!;
    expect(recovered).toMatchObject({ state: "recover", attempt: 1, operationId: first.operationId });
    await expect(Promise.resolve().then(async () => (await at(a)))).rejects.toThrowError(expect.objectContaining({ code: "seller_effect_pending" }));
    // The first attempt, superseded, cannot record anything; the recovering one does.
    expect(() => wire.completeWireEffect(a, first, { status: 200, text: "{}" })).toThrowError(expect.objectContaining({ code: "seller_effect_superseded" }));
    wire.completeWireEffect(b, recovered, { status: 200, text: '{"delivered":1}' });
    expect((await at(a)).effect).toMatchObject({ state: "completed", outcome: { status: 200, text: '{"delivered":1}' } });
  });

  it("more than 16 clean null ends still recover and retain a later payment outcome after restart", async () => {
    const x = (await world());
    const directory = journalDirectory();
    const open = () => wire.openWireRequestJournal(directory, { leaseMs: 600_000 });
    const at = async (journal: wire.WireRequestJournal) => (await wire.checkWireRequest((await x.direct(x.request(P.payments))), { ...x.check(P.payments), requestJournal: journal })).effect!;
    for (let attempt = 0; attempt < wire.MAX_EFFECT_ATTEMPTS + 4; attempt++) {
      const journal = (await open());
      const effect = (await at(journal));
      expect(effect).toMatchObject({ state: attempt === 0 ? "new" : "recover", attempt });
      await expect(Promise.resolve().then(async () => (await at(journal)))).rejects.toThrowError(expect.objectContaining({ code: "seller_effect_pending" }));
      wire.completeWireEffect(journal, effect, null);
    }
    const journal = (await open());
    const effect = (await at(journal));
    wire.completeWireEffect(journal, effect, { status: 200, text: '{"paid":true}' });
    expect((await at((await open())))).toMatchObject({ state: "completed", outcome: { status: 200, text: '{"paid":true}' } });
  });

  it.each([0, 2])("16 superseded attempts stop recovery with %i clean null ends between crashes", async (cleanRetries) => {
    const x = (await world());
    let clock = NOW;
    const directory = journalDirectory();
    const open = () => wire.openWireRequestJournal(directory, { leaseMs: 1000, clock: () => clock });
    const at = async (journal: wire.WireRequestJournal) => (await wire.checkWireRequest((await x.direct(x.request(P.payments))), { ...x.check(P.payments), requestJournal: journal })).effect!;
    let attempt = 0;
    for (let crashes = 0; crashes < wire.MAX_EFFECT_ATTEMPTS; crashes++) {
      // Interleave clean retries, advancing the fencing token without consuming the crash budget.
      for (let clean = 0; clean < cleanRetries; clean++) {
        const journal = (await open());
        const effect = (await at(journal));
        expect(effect).toMatchObject({ attempt: attempt++ });
        wire.completeWireEffect(journal, effect, null);
      }
      const journal = (await open());
      const effect = (await at(journal));
      expect(effect).toMatchObject({ attempt: attempt++ });
      clock += 1000;
      if (crashes === wire.MAX_EFFECT_ATTEMPTS - 1) {
        await expect(Promise.resolve().then(async () => (await at((await open()))))).rejects.toThrowError(expect.objectContaining({ code: "seller_effect_unresolved", status: 500 }));
        expect(() => wire.completeWireEffect(journal, effect, { status: 200, text: "{}" }))
          .toThrowError(expect.objectContaining({ code: "seller_effect_superseded" }));
      }
    }
    await expect(Promise.resolve().then(async () => (await at((await open()))))).rejects.toThrowError(expect.objectContaining({ code: "seller_effect_unresolved" }));
  }, 60_000); // about 48 fsync-heavy journal opens: load-sensitive under the 5 s default
});

describe("a response is opened only against its principal", { timeout: 60_000 }, () => {
  it("refuses to open a response without the seller it must be signed by", async () => {
    const x = (await world());
    const request = x.request(P.payments);
    const answer = await wire.signWireResponse(request, 200, "{}", { ...x.context, signer: x.seller, now: NOW });
    for (const principal of [undefined, null, "", "seller"]) {
      await expect(Promise.resolve().then(async () => (await wire.openWireEnvelope(answer, "response", { ...x.context, purchaseProfile: request.profile, ...(principal === undefined ? {} : { principal }) } as wire.OpenEnvelopeOptions)))).rejects
        .toThrowError(expect.objectContaining({ code: "wire_input_invalid", status: 500 }));
    }
    // An impostor's answer naming itself the seller: refused against the principal, and unopenable without one.
    const impostor = party();
    const forged = await wire.signWireResponse({ ...request, seller: impostor.claim }, 200, "{}", { ...x.context, signer: impostor, now: NOW });
    await expect(Promise.resolve().then(async () => (await wire.openWireEnvelope(forged, "response", { ...x.context, purchaseProfile: request.profile } as wire.OpenEnvelopeOptions)))).rejects
      .toThrowError(expect.objectContaining({ code: "wire_input_invalid" }));
    await expect(Promise.resolve().then(async () => (await wire.openWireEnvelope(forged, "response", { ...x.context, purchaseProfile: request.profile, principal: x.seller.claim })))).rejects
      .toThrowError(expect.objectContaining({ code: "peer_signer_wrong" }));
    expect((await wire.openWireEnvelope(answer, "response", { ...x.context, purchaseProfile: request.profile, principal: x.seller.claim })).payload.seller).toBe(x.seller.claim);
  });
});

it("signed Agreement job, buyer and signature algorithm are independent of the recomputed hash; party order is unrestricted", async () => {
  const x = (await world()), other = party();
  const make = (patch: Record<string, unknown>) => signedAgreement({ buyer: x.buyer, seller: x.seller, jobId: JOB, listingPin: PIN, patch });
  const reversed = make({ parties: [...x.agreement.parties].reverse() });
  const anotherBuyer = signedAgreement({ buyer: other, seller: x.seller, jobId: JOB, listingPin: PIN });
  const algorithm = { ...x.agreement, signatures: x.agreement.signatures.map((s) => ({ ...s, algorithm: "ecdsa-secp256k1" })) };
  expect(isPayeeBoundAgreementDocument(algorithm)).toBe(true);
  const cases = [
    [make({ jobId: OTHER_JOB }), false], [anotherBuyer, false],
    [{ agreement: algorithm, agreementHash: x.agreementHash }, false], [reversed, true],
  ] as const;
  for (const [a, allowed] of cases) for (const path of CONTINUING) {
    let reads = 0;
    const journals = testJournals();
    const request = { ...x.request(path), agreementHash: a.agreementHash };
    const invoke = async () => (await wire.checkWireRequest((await x.direct(request)), { ...x.check(path),
      retained: { ...x.retained, agreementHash: a.agreementHash }, agreement: received(a.agreement),
      commitment: received(x.commitment({ agreementHash: a.agreementHash })),
      readCommitmentReceipt: Object.assign(() => { reads++; return "valid"; }, { chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity }), requestJournal: (await journals.open()) }));
    if (allowed) { expect((await invoke()).effect).toMatchObject({ state: "new" }); expect(reads).toBe(1); }
    else { await expect(Promise.resolve().then(invoke)).rejects.toThrowError(expect.objectContaining({ code: "continuation_agreement_invalid" })); expect(reads).toBe(0); expect(journals.reservations()).toEqual([]); }
  }
}, 60_000); // 8 cases, each with its own journal: load-sensitive under the 5 s default
it("non-DEM payment phase fails PAY-PHASE with otherwise coherent signed terms", async () => {
  const l = tp1Listing({ seller: SELLER, patch: { pipeline: [
    { kind: "negotiate-fixed-price" }, { kind: "commit-payee-bound-agreement" },
    { kind: "pay-x402", parameters: { rail: "demos-native:DEM" } }, { kind: "deliver-storage-program" },
  ] } });
  const x = (await world(l));
  for (const path of CONTINUING) await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await x.direct(x.request(path))), { ...x.check(path), requestJournal: testJournal() })))).rejects
    .toThrowError(expect.objectContaining({ code: "continuation_phase_unsupported", detail: "PAY-PHASE" }));
}, 60_000);
it("a fully signed open-ended Listing continues at seller and buyer", async () => {
  const l = tp1Listing({ seller: SELLER, publicEndpoint: ENDPOINT, validity: { notBefore: NOW - 600_000 } }), x = (await world(l));
  expect(l.listing.validity).not.toHaveProperty("notAfter");
  const discovery = await wire.signDiscoveryDocument({ format: "dacs-seller-discovery/v1", profile: x.binding.profile,
    seller: SELLER.claim, publicEndpoint: ENDPOINT, transport: ["dacs-seller-http/v1"], listings: [l.pin], capabilities: wire.TP1_CAPABILITIES,
    ready: false, issuedAt: NOW, expiresAt: NOW + 60_000 }, SELLER, x.binding, LOCAL);
  const proof = (await wire.verifyEndpointProof(discovery, { ...x.context, request: x.request(P.payments), now: NOW, listing: { seller: SELLER.claim, publicEndpoint: ENDPOINT, listingPin: l.pin },
    readListingEligibility: readFixtureListingEligibility, readCommitmentReceipt: Object.assign(validReceipt, { chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity }),
    commitment: received(x.commitment()), agreement: received(x.agreement), signedListing: received(l.listing) }));
  for (const path of CONTINUING) {
    const signed = await wire.signWireRequest({ ...x.context, signer: x.buyer, endpointProof: proof, publicEndpoint: ENDPOINT, path,
      jobId: JOB, text: "{}", seller: SELLER.claim, now: NOW, job: { listingPin: l.pin, agreementHash: x.agreementHash, profile: x.binding.profile },
      commitment: received(x.commitment()), agreement: received(x.agreement), signedListing: received(l.listing) });
    expect((await wire.checkWireRequest((await wire.openWireEnvelope(signed.header, "request", x.context)), { ...x.check(path), requestJournal: testJournal() })).effect).toMatchObject({ state: "new" });
  }
}, 60_000);
it("a structurally complete indeterminate finalized receipt never authorizes continuation", async () => {
  const x = (await world());
  const c = x.commitment({ receipt: { observationDisposition: "indeterminate", preservedReceiptHash: "e".repeat(64) } });
  expect(isReadableAnchorReceipt(c.anchorReceipt)).toBe(true);
  const journals = testJournals();
  for (const path of CONTINUING) await expect(Promise.resolve().then(async () => (await wire.checkWireRequest((await x.direct(x.request(path))), { ...x.check(path), commitment: received(c), requestJournal: (await journals.open()) })))).rejects
    .toThrowError(expect.objectContaining({ code: "continuation_commitment_invalid" }));
  expect(journals.reservations()).toEqual([]);
}, 60_000);
