import { expect, it } from "vitest";
import * as wire from "../../src/wire/index.js";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { FINALITY_COMMITMENT_SEPARATOR, validateFixedPriceAgreementBinding, type FinalityCommitmentReader, type FinalizedFinalityAgreementCommitment } from "../../src/negotiate/commitment.js";
import { isListing, isPayeeBoundAgreementDocument, isReadableAnchorReceipt, isChainTxRef, isReadableFinalityCommitmentRecord } from "../../src/artifacts/validators.js";
import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import { BUYER, BUYER_SEED, SELLER, NOW, COMMITTED_AT, bytes, hash, signature,
  committedPurchase, resignAgreement, resignRecord, type Purchase } from "./committedPurchaseFixture.js";

it("public raw JSON byte bounds, null artifacts and primitive shape predicates", () => {
  expect(wire.admitWireArtifact(Buffer.from("null"))).toBeNull();
  expect(() => wire.admitWireArtifact(Buffer.alloc(wire.DACS_SELLER_HTTP_LIMITS.maxResponseBodyBytes + 1))).toThrowError(expect.objectContaining({ code: "wire_artifact_rejected" }));
});


const readerFor = (purchase: Purchase, verify: (...args: unknown[]) => unknown = () => "valid") =>
  Object.assign(verify, { chainIdentity: purchase.scope.binding.profile.chainIdentity });
const check = (purchase: Purchase, reader: unknown = readerFor(purchase), scope: unknown = purchase.scope) =>
  wire.commitmentReceiptTime(bytes(purchase.anchored), bytes(purchase.agreement), bytes(purchase.listing), reader, scope as wire.CommitmentScope);

it("authenticates complete signed purchase evidence with sync and async readers", async () => {
  const purchase = await committedPurchase();
  expect(wire.FINALITY_COMMITMENT_DOMAIN).toBe(FINALITY_COMMITMENT_SEPARATOR);
  expect(await check(purchase)).toBe(COMMITTED_AT);
  const sdkVerifier: FinalityCommitmentReader["verifyAnchorReceipt"] = async (): Promise<"valid"> => "valid";
  const reader: wire.CommitmentReceiptReader = Object.assign(sdkVerifier, { chainIdentity: purchase.scope.binding.profile.chainIdentity });
  expect(await check(purchase, reader)).toBe(COMMITTED_AT);
});

it("accepts byte-admitted evidence and refuses a fabricated pre-parsed copy", async () => {
  const purchase = await committedPurchase();
  expect(await wire.commitmentReceiptTime(wire.admitWireArtifact(bytes(purchase.anchored)),
    wire.admitWireArtifact(bytes(purchase.agreement)), wire.admitWireArtifact(bytes(purchase.listing)), readerFor(purchase), purchase.scope)).toBe(COMMITTED_AT);
  await expect(Promise.resolve().then(() => wire.commitmentReceiptTime(purchase.anchored,
    bytes(purchase.agreement), bytes(purchase.listing), readerFor(purchase), purchase.scope)))
    .rejects.toMatchObject({ code: "continuation_commitment_invalid", detail: "ARTIFACT-NOT-ADMITTED" });
});

it.each(["missing", "jobId", "agreementHash", "buyer"])("requires the authenticated request's purchase identity: %s", async (field) => {
  const purchase = await committedPurchase();
  const scope = field === "missing" ? { ...purchase.scope, request: undefined } : { ...purchase.scope,
    request: { ...purchase.scope.request, [field]: field === "jobId" ? "01J8ME0SXKQ4T9V2RC5HJ6WX7F" : field === "buyer" ? SELLER : "0".repeat(64) } };
  await expect(Promise.resolve().then(() => check(purchase, undefined, scope))).rejects.toMatchObject({ code: "continuation_commitment_invalid" });
});

it("requires a genuine approved TP-1 binding for the receipt chain", async () => {
  const purchase = await committedPurchase();
  for (const binding of [undefined, { ...purchase.scope.binding }]) {
    await expect(Promise.resolve().then(() => check(purchase, undefined, { ...purchase.scope, binding })))
      .rejects.toMatchObject({ code: "tp1_binding_required" });
  }
});

it("supplies the approved chain to the reader on a frozen owned evidence copy", async () => {
  const purchase = await committedPurchase();
  const before = bytes(purchase.anchored).toString();
  const reader = readerFor(purchase, (anchored, chain) => {
    expect(anchored).toEqual(purchase.anchored);
    expect(anchored).not.toBe(purchase.anchored);
    expect(Object.isFrozen(anchored)).toBe(true);
    expect(chain).toEqual({ substrate: "demos", chainIdentity: purchase.scope.binding.profile.chainIdentity });
    expect(Object.isFrozen(chain)).toBe(true);
    return "valid";
  });
  expect(await check(purchase, reader)).toBe(COMMITTED_AT);
  expect(bytes(purchase.anchored).toString()).toBe(before);
});

it.each(["demos:mainnet", "demos:testnet", "other"])("refuses receipt substrate %s before calling the reader", async (substrate) => {
  const purchase = await committedPurchase();
  purchase.anchored.anchorReceipt.substrate = substrate;
  let calls = 0;
  await expect(Promise.resolve().then(() => check(purchase, readerFor(purchase, () => { calls++; return "valid"; }))))
    .rejects.toMatchObject({ code: "continuation_commitment_invalid" });
  expect(calls).toBe(0);
});

it("refuses a receipt reader pinned to a different chain or exposing a getter", async () => {
  const purchase = await committedPurchase();
  const wrongChain = Object.assign(() => "valid", { chainIdentity: "0".repeat(64) });
  const getter = Object.defineProperty(() => "valid", "chainIdentity", { get() { throw new Error("must not execute"); } });
  for (const reader of [wrongChain, getter]) {
    await expect(Promise.resolve().then(() => check(purchase, reader))).rejects.toMatchObject({ code: "commitment_reader_chain_mismatch" });
  }
});

it("preserves additive record fields in signatures, hashes and receipt readback", async () => {
  const purchase = await committedPurchase();
  Object.assign(purchase.anchored.record, { extension: { optional: "retained" } });
  resignRecord(purchase);
  expect(isReadableFinalityCommitmentRecord(purchase.anchored.record)).toBe(true);
  expect(await check(purchase, readerFor(purchase, (anchored) => {
    expect(anchored).toMatchObject({ record: { extension: { optional: "retained" } } });
    return "valid";
  }))).toBe(COMMITTED_AT);
  Object.assign(purchase.anchored.record, { extension: "tampered" });
  await expect(Promise.resolve().then(() => check(purchase))).rejects.toMatchObject({ code: "continuation_commitment_invalid" });
});

it.each(["dacsVersion", "signatures"])("refuses conflicting record discriminator %s", async (field) => {
  const purchase = await committedPurchase();
  Object.assign(purchase.anchored.record, { [field]: field === "signatures" ? [] : "1" });
  resignRecord(purchase);
  await expect(Promise.resolve().then(() => check(purchase))).rejects.toMatchObject({ code: "continuation_commitment_invalid" });
});

it("resolves an advisory-parameter Listing signer by canonical claim identity", async () => {
  const purchase = await committedPurchase((listing) => { listing.signature.signer = `${SELLER}?network=testnet`; });
  expect(await check(purchase)).toBe(COMMITTED_AT);
});

it("refuses an uncarried or invalid Listing signature even with a correct content pin", async () => {
  const purchase = await committedPurchase();
  purchase.listing.signature = signature(purchase.listing, ARTIFACT_SEPARATORS.Listing, BUYER_SEED, BUYER);
  await expect(Promise.resolve().then(() => check(purchase))).rejects.toMatchObject({ code: "continuation_listing_invalid" });
  purchase.listing.signature = signature(purchase.listing, ARTIFACT_SEPARATORS.Listing);
  purchase.listing.signature.value = Buffer.alloc(64).toString("base64url");
  await expect(Promise.resolve().then(() => check(purchase))).rejects.toMatchObject({ code: "continuation_listing_invalid", detail: "LISTING-SIGNATURE" });
});

it.each(["buyer", "seller"])("CA-7 independently verifies the %s Agreement signature", async (role) => {
  const purchase = await committedPurchase();
  const party = role === "buyer" ? BUYER : SELLER;
  const found = purchase.agreement.signatures.find((item) => item.party === party);
  if (!found) throw new Error("fixture signature missing");
  found.value = Buffer.alloc(64).toString("base64url");
  await expect(Promise.resolve().then(() => check(purchase))).rejects.toMatchObject({ code: "continuation_agreement_invalid" });
});

it.each([
  ["recomputed Agreement hash", (p: Purchase) => {
    const originalHash = p.anchored.record.agreementHash;
    Object.assign(p.agreement, { extension: "different-signed-agreement" });
    resignAgreement(p);
    p.anchored.record.agreementHash = originalHash;
    p.scope.request.agreementHash = originalHash;
    resignRecord(p);
  }, "continuation_agreement_invalid"],
  ["agreement hash", (p: Purchase) => { p.agreement.terms.price.amount = "2"; }, "continuation_agreement_invalid"],
  ["Agreement listing pin", (p: Purchase) => { p.agreement.listingRef.version++; resignAgreement(p); }, "continuation_agreement_invalid"],
  ["Agreement job", (p: Purchase) => { p.agreement.jobId = "01J8ME0SXKQ4T9V2RC5HJ6WX7F"; resignAgreement(p); }, "continuation_agreement_invalid"],
  ["record signer", (p: Purchase) => { p.anchored.record.signature = signature(p.anchored.record, FINALITY_COMMITMENT_SEPARATOR, BUYER_SEED, BUYER); }, "continuation_commitment_invalid"],
  ["record signature", (p: Purchase) => { p.anchored.record.signature.value = Buffer.alloc(64).toString("base64url"); }, "continuation_commitment_invalid"],
  ["listing content", (p: Purchase) => { p.listing.offering.title = "tampered"; }, "continuation_listing_invalid"],
  ["record listing pin", (p: Purchase) => { p.anchored.record.listingRef = { ...p.scope.listingPin, version: 2 }; resignRecord(p); }, "continuation_commitment_invalid"],
  ["record parties", (p: Purchase) => { p.anchored.record.parties.reverse(); resignRecord(p); }, "continuation_commitment_invalid"],
  ["Agreement party", (p: Purchase) => { const party = p.agreement.parties[0]; if (party) party.primaryClaim = SELLER; resignAgreement(p); }, "continuation_agreement_invalid"],
  ["Agreement discriminator", (p: Purchase) => { Object.assign(p.agreement, { agreementVersion: "1" }); resignAgreement(p); }, "continuation_agreement_invalid"],
] as const)("rejects changed %s", async (_name, mutate, code) => {
  const purchase = await committedPurchase();
  mutate(purchase);
  await expect(Promise.resolve().then(() => check(purchase))).rejects.toMatchObject({ code });
});

it.each([
  ["price", (p: Purchase) => { p.agreement.terms.price.amount = "2"; }],
  ["currency", (p: Purchase) => { p.agreement.terms.price.currency = "USDC"; }],
  ["rail", (p: Purchase) => { p.agreement.terms.rail = { railId: "other", railVersion: 1 }; }],
  ["deliverable", (p: Purchase) => { p.agreement.terms.deliverable.hash = "0".repeat(64); }],
] as const)("refuses genuinely signed Agreement terms outside the Listing: %s", async (_name, mutate) => {
  const purchase = await committedPurchase();
  mutate(purchase);
  resignAgreement(purchase);
  await expect(Promise.resolve().then(() => check(purchase)))
    .rejects.toMatchObject({ code: "continuation_agreement_invalid", detail: "LISTING-TERMS", cause: { name: "DacsError" } });
});

it.each([
  ["pending", (p: Purchase) => { p.anchored.anchorReceipt.state = "included"; }],
  ["uncertain", (p: Purchase) => { p.anchored.anchorReceipt.observationDisposition = "indeterminate"; }],
  ["content hash", (p: Purchase) => { p.anchored.anchorReceipt.contentHash = "0".repeat(64); }],
  ["logical address", (p: Purchase) => { p.anchored.anchorReceipt.logicalAddress = "other-job"; }],
  ["native address", (p: Purchase) => { p.anchored.anchorReceipt.nativeAddress = "other-anchor"; }],
  ["before Agreement", (p: Purchase) => { p.anchored.anchorReceipt.blockRef.timestamp = NOW - 1; }],
  ["future", (p: Purchase) => { p.anchored.anchorReceipt.blockRef.timestamp += wire.DACS_SELLER_HTTP_LIMITS.maxClockSkewMs + 1; }],
  ["before Listing validity", (p: Purchase) => { p.listing.validity.notBefore = COMMITTED_AT + 1; p.listing.signature = signature(p.listing, ARTIFACT_SEPARATORS.Listing); p.scope.listingPin.contentHash = hash(p.listing); p.agreement.listingRef = { ...p.scope.listingPin }; resignAgreement(p); }],
  ["after deadline", (p: Purchase) => { p.anchored.anchorReceipt.blockRef.timestamp = p.agreement.terms.deadline + 1; p.scope.now = p.anchored.anchorReceipt.blockRef.timestamp; }],
  ["invalid time", (p: Purchase) => { p.anchored.anchorReceipt.blockRef.timestamp = -1; }],
] as const)("refuses receipt %s", async (_name, mutate) => {
  const purchase = await committedPurchase();
  mutate(purchase);
  await expect(Promise.resolve().then(() => check(purchase))).rejects.toMatchObject({ code: "continuation_commitment_invalid" });
});

it("rechecks Listing validity and the relative Agreement deadline at finality", async () => {
  const purchase = await committedPurchase((listing) => { listing.validity.notAfter = NOW + 1_000; });
  await expect(Promise.resolve().then(() => check(purchase))).rejects.toMatchObject({ code: "continuation_commitment_invalid" });
  const deadline = await committedPurchase();
  deadline.agreement.terms.deadline = COMMITTED_AT + 600_001;
  resignAgreement(deadline);
  await expect(Promise.resolve().then(() => check(deadline))).rejects.toMatchObject({ code: "continuation_commitment_invalid" });
});

it.each([
  ["invalid", "continuation_commitment_invalid", 500], ["indeterminate", "commitment_unverified", 503],
  ["error", "commitment_unverified", 503], [true, "commitment_reader_invalid", 500],
] as const)("keeps async receipt verdict %s distinct", async (verdict, code, status) => {
  const purchase = await committedPurchase();
  await expect(Promise.resolve().then(() => check(purchase, readerFor(purchase, async () => verdict)))).rejects.toMatchObject({ code, status });
});

it("reads receipts again instead of trusting saved success", async () => {
  const purchase = await committedPurchase();
  let calls = 0;
  const reader = readerFor(purchase, async () => ++calls === 1 ? "valid" : "indeterminate");
  expect(await check(purchase, reader)).toBe(COMMITTED_AT);
  await expect(Promise.resolve().then(() => check(purchase, reader))).rejects.toMatchObject({ code: "commitment_unverified" });
  expect(calls).toBe(2);
});

it("preserves synchronous and rejected asynchronous lookup causes", async () => {
  const purchase = await committedPurchase();
  const cause = new Error("receipt lookup failed");
  for (const reader of [() => { throw cause; }, async () => { throw cause; }]) {
    await expect(Promise.resolve().then(() => check(purchase, readerFor(purchase, reader)))).rejects.toBe(cause);
  }
});

it("catches a rejected async receipt lookup without an unhandled rejection", async () => {
  const purchase = await committedPurchase();
  try { await check(purchase, readerFor(purchase, async () => { throw new Error("receipt lookup failed"); })); } catch { /* caller handles the lookup refusal */ }
  // Drain one event-loop turn, without a timer, so unhandled rejections surface.
  await new Promise<void>((done) => setImmediate(done));
});

it("caught receipt lookup failures keep a child process alive", () => {
  const child = spawnSync(process.execPath, [resolve("node_modules/vitest/vitest.mjs"), "run", "test/wire/artifact-admission.test.ts",
    "-t", "catches a rejected async receipt lookup"], { cwd: process.cwd(), encoding: "utf8" });
  expect(child.status, child.stdout + child.stderr).toBe(0);
});


it.each(["buyer", "seller"])("matches the %s Agreement signature by CF-3 identity", async (role) => {
  const purchase = await committedPurchase();
  const party = role === "buyer" ? BUYER : SELLER;
  const found = purchase.agreement.signatures.find((item) => item.party === party);
  if (!found) throw new Error("fixture signature missing");
  const before = hash(purchase.agreement);
  found.party = `${party}?network=testnet`;
  expect(isPayeeBoundAgreementDocument(purchase.agreement)).toBe(true);
  expect(hash(purchase.agreement)).toBe(before);
  expect(await check(purchase)).toBe(COMMITTED_AT);
});

// Re-sign every changed scope so refusals exercise local TP-1 restrictions,
// after the ordinary artifact and Agreement/Listing binding checks succeed.
function repinPurchase(purchase: Purchase) {
  const { listing, agreement, anchored, scope } = purchase;
  listing.signature = signature(listing, ARTIFACT_SEPARATORS.Listing);
  const pin = { listingId: listing.listingId, version: listing.listingVersion, contentHash: hash(listing) };
  scope.listingPin = pin;
  anchored.record.listingRef = pin;
  agreement.listingRef = pin;
  agreement.terms.deliverable = { deliverableType: listing.offering.deliverable.kind,
    hash: sha256Hex(canonicalize(listing.offering.deliverable)) };
  for (const payout of agreement.terms.payoutBindings) {
    payout.phaseIndex = listing.pipeline.findIndex((phase) => phase.kind.startsWith("pay-"));
    if (agreement.terms.rail) payout.railId = agreement.terms.rail.railId;
  }
  resignAgreement(purchase);
  expect(isListing(listing)).toBe(true);
  expect(isPayeeBoundAgreementDocument(agreement)).toBe(true);
  validateFixedPriceAgreementBinding({ agreement, verifiedListing: { disposition: "verified", listing, pin }, committedAt: COMMITTED_AT });
}

it.each([
  ["payment phase", (p: Purchase) => {
    const rail = { railId: "x402:test", railVersion: 1 };
    p.listing.pipeline[2] = { kind: "pay-x402", parameters: { rail: rail.railId } };
    p.listing.acceptedRails = [rail];
    p.agreement.terms.rail = rail;
  }, "continuation_phase_unsupported", "PAY-PHASE"],
  ["delivery phase", (p: Purchase) => {
    p.listing.pipeline[3] = { kind: "deliver-entitlement" };
    p.listing.offering.deliverable = { kind: "entitlement", durationSec: 60, renewable: false };
  }, "continuation_phase_unsupported", "DELIVERY-PHASE"],
  ["deliverable kind", (p: Purchase) => {
    p.listing.offering.deliverable = { kind: "external", description: "External delivery" };
  }, "continuation_listing_invalid", "DELIVERABLE-KIND"],
  ["pricing kind", (p: Purchase) => {
    p.listing.pricing = { kind: "negotiable", bandCenter: { amount: "1", currency: "DEM" }, minPct: 0, maxPct: 0 };
  }, "continuation_listing_invalid", "TP1-PRICING"],
  ["currency", (p: Purchase) => {
    p.listing.pricing = { kind: "fixed", price: { amount: "1", currency: "USDC" } };
    p.agreement.terms.price.currency = "USDC";
  }, "continuation_listing_invalid", "TP1-PRICING"],
] as const)("refuses signed non-TP-1 %s before receipt lookup", async (_name, mutate, code, detail) => {
  const purchase = await committedPurchase();
  mutate(purchase);
  repinPurchase(purchase);
  let calls = 0;
  await expect(check(purchase, readerFor(purchase, () => { calls++; return "valid"; })))
    .rejects.toMatchObject({ code, status: 500, detail });
  expect(calls).toBe(0);
});

it.each([
  ["extra vet suffix", (p: Purchase) => { p.listing.pipeline.push({ kind: "vet-credentials" }); }],
  ["extra vet prefix", (p: Purchase) => { p.listing.pipeline.unshift({ kind: "vet-credentials" }); }],
  ["extra rating suffix", (p: Purchase) => { p.listing.pipeline.push({ kind: "rate" }); }],
  ["delivery before payment", (p: Purchase) => {
    p.listing.pipeline = [{ kind: "negotiate-fixed-price" }, { kind: "commit-payee-bound-agreement" },
      { kind: "deliver-storage-program" }, { kind: "pay-dem", parameters: { rail: "dem:testnet" } }];
  }],
  ["payment before negotiation", (p: Purchase) => {
    p.listing.pipeline = [{ kind: "pay-dem", parameters: { rail: "dem:testnet" } },
      { kind: "negotiate-fixed-price" }, { kind: "commit-payee-bound-agreement" }, { kind: "deliver-storage-program" }];
  }],
] as const)("refuses the complete signed pipeline with %s", async (_name, mutate) => {
  const purchase = await committedPurchase();
  mutate(purchase);
  repinPurchase(purchase);
  let calls = 0;
  await expect(check(purchase, readerFor(purchase, () => { calls++; return "valid"; })))
    .rejects.toMatchObject({ code: "continuation_phase_unsupported", status: 500, detail: "PIPELINE" });
  expect(calls).toBe(0);
});

function finalizedResult(purchase: Purchase, resumed: boolean): FinalizedFinalityAgreementCommitment {
  const { record, nativeAddress, anchorTxRef, anchorReceipt } = purchase.anchored;
  if (!isReadableFinalityCommitmentRecord(record) || !isChainTxRef(anchorTxRef) || !isReadableAnchorReceipt(anchorReceipt)) {
    throw new Error("fixture must contain finalized evidence");
  }
  return { record, nativeAddress, anchorTxRef, anchorReceipt, recordKind: "finality", resumed,
    logicalAddress: anchorReceipt.logicalAddress, agreementHash: record.agreementHash, committedAt: COMMITTED_AT };
}

it.each([false, true])("accepts the exact finalized result shape (resumed=%s)", async (resumed) => {
  const purchase = await committedPurchase();
  expect(await wire.commitmentReceiptTime(bytes(finalizedResult(purchase, resumed)), bytes(purchase.agreement),
    bytes(purchase.listing), readerFor(purchase), purchase.scope)).toBe(COMMITTED_AT);
});

it.each([
  ["recordKind", "legacy"], ["logicalAddress", "dacs3:commit:other"], ["agreementHash", "0".repeat(64)],
  ["committedAt", COMMITTED_AT + 1], ["resumed", "true"],
] as const)("refuses a tampered finalized result %s before receipt lookup", async (field, value) => {
  const purchase = await committedPurchase();
  const result = { ...finalizedResult(purchase, false), [field]: value };
  let calls = 0;
  await expect(wire.commitmentReceiptTime(bytes(result), bytes(purchase.agreement), bytes(purchase.listing),
    readerFor(purchase, () => { calls++; return "valid"; }), purchase.scope))
    .rejects.toMatchObject({ code: "continuation_commitment_invalid", status: 500 });
  expect(calls).toBe(0);
});


it.each([
  ["Agreement buyer", (p: Purchase) => {
    const party = p.agreement.parties.find((item) => item.role === "buyer");
    if (!party) throw new Error("fixture buyer missing");
    party.primaryClaim = `${BUYER}?network=testnet`;
    resignAgreement(p);
  }],
  ["Agreement seller", (p: Purchase) => {
    const party = p.agreement.parties.find((item) => item.role === "seller");
    if (!party) throw new Error("fixture seller missing");
    party.primaryClaim = `${SELLER}?network=testnet`;
    resignAgreement(p);
  }],
  ["Listing seller", (p: Purchase) => {
    p.listing.seller.identity.presentedBy = `${SELLER}?network=testnet`;
    repinPurchase(p);
  }],
  ["record buyer", (p: Purchase) => { p.anchored.record.parties[0] = `${BUYER}?network=testnet`; resignRecord(p); }],
  ["record seller", (p: Purchase) => { p.anchored.record.parties[1] = `${SELLER}?network=testnet`; resignRecord(p); }],
  ["record signer", (p: Purchase) => { p.anchored.record.signature.signer = `${SELLER}?network=testnet`; }],
] as const)("matches the %s across signed artifacts by CF-3 identity", async (_name, mutate) => {
  const purchase = await committedPurchase();
  mutate(purchase);
  expect(isListing(purchase.listing)).toBe(true);
  expect(isPayeeBoundAgreementDocument(purchase.agreement)).toBe(true);
  expect(isReadableFinalityCommitmentRecord(purchase.anchored.record)).toBe(true);
  expect(await check(purchase)).toBe(COMMITTED_AT);
});


it("uses the same verified binding when the caller replaces scope during authority validation", async () => {
  const purchase = await committedPurchase();
  const otherChain = "f".repeat(64);
  const reader = Object.assign(() => "valid", { chainIdentity: otherChain });
  const pending = check(purchase, reader);
  purchase.scope.binding = { ...purchase.scope.binding,
    profile: { ...purchase.scope.binding.profile, chainIdentity: otherChain } };
  await expect(pending).rejects.toMatchObject({ code: "commitment_reader_chain_mismatch" });
});

it("accepts authenticated seller scope with advisory ClaimReference parameters", async () => {
  const purchase = await committedPurchase();
  purchase.scope.seller = `${SELLER}?network=testnet`;
  expect(await check(purchase)).toBe(COMMITTED_AT);
});
