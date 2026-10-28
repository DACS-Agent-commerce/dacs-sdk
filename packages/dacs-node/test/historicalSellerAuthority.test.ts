import { sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  deriveFixedPriceAgreement,
  signFixedPriceAgreement,
  commitFixedPriceAgreement,
  createInMemorySellerReceiptStore,
  verifySellerPaymentIntake,
  validateListingArtifact,
  isVerifiedListingAdmission,
  x402Eip3009Nonce,
  runFulfilmentCore,
  type SellerPaymentAuthorization,
  type SellerFulfilmentDeps,
  type SellerFulfilmentAuditSourceV1,
} from "@kynesyslabs/dacs";
import type { IdentityBundle, Listing } from "@kynesyslabs/dacs/artifacts";
import { canonicalize, contentHash, encodeAddressSegment, listingAddress, paymentEvidenceAddress, sha256Hex } from "@kynesyslabs/dacs/canonical";
import {
  FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE, FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
  FIXED_PRICE_PAY_DEM_STANDARD_REVISION, FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF, FIXED_PRICE_X402_STANDARD_REVISION,
} from "@kynesyslabs/dacs/commerce";
import { ed25519Verify, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { demosAgentClaimRef, identityBundleHash } from "@kynesyslabs/dacs/identity";
import { getListingReaderProvenance } from "../../../src/agent/listingValidation.js";
import { createDacsFixedPricePayDemSellerAuthorityV1 } from "../src/fixedPricePayDemSellerAuthority.js";
import { createDacsFixedPriceX402SellerAuthorityV1 } from "../src/fixedPriceX402SellerAuthority.js";
import { captureDacsHistoricalListingAdmissionV1, restoreDacsHistoricalListingAdmissionV1 } from "../src/historicalListingAdmission.js";

const dependencies = vi.hoisted(() => ({ rails: new WeakSet<object>() }));
let current: Awaited<ReturnType<typeof fixture>>;
// Isolate previously authenticated actor-local agreement/session checkpoints.
// The real host authorities, historical Listing reader and payment intake run.
vi.mock("@kynesyslabs/dacs", async (original) => ({
  ...(await original<typeof import("@kynesyslabs/dacs")>()),
  isAuthenticatedRailDefinition: (rail: object) => dependencies.rails.has(rail),
  getAuthenticatedRailProvenance: (rail: object) => dependencies.rails.has(rail)
    ? { registryVersion: 7, indexContentHash: "1".repeat(64), definitionContentHash: "2".repeat(64) }
    : null,
}));
vi.mock("../src/orderInput.js", async (original) => ({
  ...(await original<typeof import("../src/orderInput.js")>()),
  loadDacsLiveOrderInputV1: () => current.retained,
}));
vi.mock("../src/fixedPricePayDemProfile.js", async (original) => ({
  ...(await original<typeof import("../src/fixedPricePayDemProfile.js")>()),
  loadDacsFixedPricePayDemSellerAdmissionV1: () => structuredClone(current.admission),
  loadDacsFixedPricePayDemCommitmentResultV1: () => current.result,
}));
vi.mock("../src/fixedPriceX402Profile.js", async (original) => ({
  ...(await original<typeof import("../src/fixedPriceX402Profile.js")>()),
  loadDacsFixedPriceX402SellerAdmissionV1: () => structuredClone(current.admission),
  loadDacsFixedPriceX402CommitmentResultV1: () => current.result,
}));
vi.mock("../src/sessionBootstrapAgreementRuntime.js", async (original) => ({
  ...(await original<typeof import("../src/sessionBootstrapAgreementRuntime.js")>()),
  loadDacsPayDemSellerSessionAgreementFactsForOrderV1: () => current.session,
  loadDacsSellerSessionAgreementFactsForOrderV1: () => current.session,
}));
vi.mock("../src/sessionBootstrapTransportRuntime.js", async (original) => ({
  ...(await original<typeof import("../src/sessionBootstrapTransportRuntime.js")>()),
  authenticateDacsLiveSessionIdentityV1: async () => true,
  authenticateDacsX402SessionIdentityV1: async () => true,
}));

const JOB = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const SELLER_SEED = Buffer.alloc(32, 22);
const BUYER_SEED = Buffer.alloc(32, 11);
const SELLER_KEY = rawPublicKey(publicKeyFromSeed(SELLER_SEED));
const BUYER_KEY = rawPublicKey(publicKeyFromSeed(BUYER_SEED));
const SELLER = demosAgentClaimRef(SELLER_KEY);
const BUYER = demosAgentClaimRef(BUYER_KEY);
const PAYEE = `0x${"33".repeat(20)}`;
const PAYER = `0x${"44".repeat(20)}`;
const ASSET = `0x${"55".repeat(20)}`;
const EVM_TX = `0x${"66".repeat(32)}`;
const DEM_TX = "77".repeat(32);
const RESOURCE = "https://seller.example/dacs/x402";

function identity(seller: boolean, native: boolean): IdentityBundle {
  const primary = seller ? SELLER : BUYER;
  const value: IdentityBundle = {
    bundleVersion: "1", presentedBy: primary, presentedAt: 900,
    sessionNonce: "session-nonce",
    claims: [{ ref: primary }, ...(!seller && !native ? [{ ref: `cci-xm:evm:84532:${PAYER}` }] : [])],
    presentation: { kind: "per-claim", signatures: [{ ref: primary, signature: "c2ln" }] },
  };
  // The Listing identity is the generated profile's one primary Demos claim.
  if (seller && value.presentation.kind === "per-claim") {
    value.presentation.signatures[0]!.signature = sign(null,
      Buffer.from(`dacs-bundle-presentation:v1:${identityBundleHash(value)}`),
      privateKeyFromSeed(SELLER_SEED)).toString("base64url");
  }
  return value;
}

async function fixture(native: boolean) {
  const phase = native ? "pay-dem" : "pay-x402";
  const railId = native ? "demos-native:DEM" : "x402:test";
  const currency = native ? "DEM" : "USDC";
  const parameters = native
    ? { network: "demos", payTo: Buffer.from(SELLER_KEY).toString("hex") }
    : { network: "eip155:84532", payTo: PAYEE, asset: ASSET, httpResource: RESOURCE };
  const rail = {
    railVersion: 1, railId, railType: native ? "demos-native" : "x402", phaseHandler: phase,
    asset: native ? { kind: "native-dem", symbol: "DEM", decimals: 9 }
      : { kind: "erc20", chainId: 84532, contract: ASSET, symbol: "USDC", decimals: 6 },
    network: native ? { kind: "demos" } : { kind: "x402-resource", resourceBaseUrl: RESOURCE },
    availability: "live", parameters: {},
  };
  dependencies.rails.add(rail);
  const sellerIdentity = identity(true, native);
  const buyerIdentity = identity(false, native);
  const listing: Listing = {
    dacsVersion: "1", listingVersion: 1, listingId: "historical-seller",
    seller: { identity: sellerIdentity, displayName: "Seller", publicEndpoint: "https://seller.example" },
    offering: { title: "Result", description: "Result", category: "data", tags: [],
      deliverable: { kind: "storage-program", accessModel: "public" } },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-payee-bound-agreement" },
      { kind: phase, parameters: { rail: railId } }, { kind: "deliver-storage-program" }],
    pricing: { kind: "fixed", price: { amount: "1", currency } },
    acceptedRails: [{ railId, railVersion: 1, parameters }],
    terms: { deadlineSecAfterCommit: 60 }, validity: { notBefore: 0, notAfter: 10_000 },
    signature: { algorithm: "ed25519", signer: SELLER, value: "c2ln" },
  };
  listing.signature.value = sign(null,
    Buffer.from(`dacs-listing:v1:${contentHash(listing as unknown as Record<string, unknown>)}`),
    privateKeyFromSeed(SELLER_SEED)).toString("base64url");
  // Keep wire formatting distinct from canonicalized/restored object rendering.
  const bytes = Buffer.from(JSON.stringify(listing, null, 2).replace('"notBefore": 0', '"notBefore": -0.0'));
  const validation = await validateListingArtifact(bytes, {
    executionMode: "simulation", nowMs: () => 1_000,
    verifyListingSignature: ({ signedBytes, signature }) => ed25519Verify(signedBytes,
      Buffer.from(signature.value, "base64url"), publicKeyFromSeed(SELLER_SEED)),
    verifyIdentityPresentation: ({ bundle, signedBytes }) => bundle.presentation.kind === "per-claim" &&
      ed25519Verify(signedBytes, Buffer.from(bundle.presentation.signatures[0]!.signature, "base64url"),
        publicKeyFromSeed(SELLER_SEED)),
    verifySellerControl: ({ signer }) => signer === SELLER,
    revocation: { surfaces: [{ kind: "well-known", status: "active", integrity: "verified" }],
      readMarker: async () => null, verifyMarkerSignature: () => false },
    loadRailResolution: () => ({ trustPhase: "PA-2", registry: { state: "verified-finalized",
      entries: [{ railId, latestVersion: 1, versions: [1] }],
      definitions: [{ railId, railVersion: 1, phaseHandler: phase, state: "verified-finalized" }] } }),
  });
  const pin = { listingId: listing.listingId, version: 1,
    contentHash: contentHash(listing as unknown as Record<string, unknown>) };
  const vet = (seller: boolean) => ({ anchor: { kind: "storage-program" as const,
    locator: `dacs2:composite:${JOB}:${encodeAddressSegment(seller ? SELLER : BUYER)}` }, contentHash: (seller ? "a" : "b").repeat(64),
    signer: seller ? BUYER : SELLER });
  const draft = deriveFixedPriceAgreement({
    jobId: JOB,
    verifiedListing: { disposition: "verified", listing, pin },
    buyer: { identityBundle: buyerIdentity, vetRecordRef: vet(false) },
    seller: { identityBundle: sellerIdentity, vetRecordRef: vet(true) },
    selectedRail: listing.acceptedRails![0]!,
    payoutBindings: [{ railId, phaseIndex: 2, payeeAddress: parameters.payTo }],
    generatedAt: 1_000,
  });
  const agreement = await signFixedPriceAgreement(draft, {
    party: BUYER, algorithm: "ed25519",
    sign: (bytes) => sign(null, bytes, privateKeyFromSeed(BUYER_SEED)),
  }, {
    party: SELLER, algorithm: "ed25519",
    sign: (bytes) => sign(null, bytes, privateKeyFromSeed(SELLER_SEED)),
  });
  const protocol = {
    commerceProfile: native ? FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE : FIXED_PRICE_X402_COMMERCE_PROFILE,
    standardRevision: native ? FIXED_PRICE_PAY_DEM_STANDARD_REVISION : FIXED_PRICE_X402_STANDARD_REVISION,
    orchestratorTopology: "seller-as-phase-orchestrator-v1", orchestrator: SELLER,
    phase, rail: { railId, railVersion: 1, registryIndexHash: "1".repeat(64),
    railDefinitionHash: "2".repeat(64),
    registryIndexRef: native ? FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF : FIXED_PRICE_X402_REGISTRY_INDEX_REF,
    railDefinitionRef: `dacs4:rail:${encodeURIComponent(railId)}:1`,
    railType: native ? "demos-native" : "x402", phaseHandler: phase, availability: "live", network: native ? "demos" : "eip155:84532" } };
  const application = { applicationVersion: "1", listingRef: `stor-${"5".repeat(40)}`,
    listingContentHash: pin.contentHash, listingLogicalAddress: listingAddress(SELLER, listing.listingId, 1), listing,
    demosWriteFeeCeilings: { buyer: "2", seller: "2" }, request: {}, requestHash: sha256Hex("{}") };
  const order = { jobId: JOB, role: "seller", buyer: BUYER, seller: SELLER, protocol,
    localBindingHash: "8".repeat(64) };
  const commitment = await commitFixedPriceAgreement({
    agreement,
    verifiedListing: { disposition: "verified", listing, pin },
    session: { jobId: JOB, listingRef: pin, phaseKind: "commit-payee-bound-agreement",
      orchestrator: SELLER,
      buyer: { primaryClaim: BUYER, bundleHash: identityBundleHash(buyerIdentity), vetRecordRef: vet(false) },
      seller: { primaryClaim: SELLER, bundleHash: identityBundleHash(sellerIdentity), vetRecordRef: vet(true) } },
    createdAt: 1_000,
    commitmentSigner: { algorithm: "ed25519", signer: SELLER,
      sign: (bytes) => sign(null, bytes, privateKeyFromSeed(SELLER_SEED)) },
  }, {
    resolve: async () => ({ disposition: "absent" }),
    submit: async (logicalAddress, record) => ({ record,
      nativeAddress: `stor-${"9".repeat(40)}`,
      anchorTxRef: { kind: "storage-program", address: `stor-${"9".repeat(40)}`, writeTxHash: "tx:commitment" },
      anchorReceipt: { receiptVersion: "1", substrate: "demos",
        finalityProfile: "demos-bft-confirmed-native-read", logicalAddress,
        nativeAddress: `stor-${"9".repeat(40)}`,
        contentHash: contentHash(record as unknown as Record<string, unknown>),
        transactionRef: { kind: "demos-storage-program", value: "tx:commitment" },
        writer: SELLER, state: "finalized", observationDisposition: "established", observedAt: 1_001,
        blockRef: { id: "block:commitment", height: "42", timestamp: 1_001 },
        evidence: { kind: "demos-bft-write-proof-v1", value: "proof" } },
    }),
    verifyAnchorReceipt: async () => "valid" as const,
  }, ({ signer, algorithm, value, signedBytes }) => {
    const seed = signer === BUYER ? BUYER_SEED : signer === SELLER ? SELLER_SEED : null;
    return seed && algorithm === "ed25519" &&
      ed25519Verify(signedBytes, Buffer.from(value, "base64url"), publicKeyFromSeed(seed)) ? "valid" : "invalid";
  });
  if (commitment.recordKind !== "finality") throw new Error("expected finality commitment");
  return { native, rail, listing, bytes, pin, agreement, commitment, order,
    result: { agreement, commitment },
    retained: { application, localBindingHash: order.localBindingHash },
    admission: { application, protocol, admittedAt: 1_000,
      listingAdmission: captureDacsHistoricalListingAdmissionV1(listing, validation) as
        ReturnType<typeof captureDacsHistoricalListingAdmissionV1> | undefined },
    session: { buyerIdentity, sellerIdentity } };
}

function authority() {
  const store = { load: async () => ({ status: "ok", record: current.order }) };
  const context = { role: "seller", authority: SELLER, peerAuthority: BUYER,
    evm: { role: "seller", address: PAYEE },
    database: { createLiveCoordinatorStore: () => store, createPayDemCoordinatorStore: () => store },
    demos: { adapter: {
      verifyDemosAnchorReceipt: async () => true,
      readAnchor: async () => current.commitment.record,
    } } };
  const options = { executionMode: "simulation" as const, context: context as never,
    rail: current.rail as never, tokenDomain: { name: "USD Coin", version: "2" } };
  return current.native ? createDacsFixedPricePayDemSellerAuthorityV1(options)
    : createDacsFixedPriceX402SellerAuthorityV1(options);
}

async function intake(host: ReturnType<typeof authority>) {
  const receipt = { success: true, transaction: EVM_TX, network: "eip155:84532", payer: PAYER };
  const receiptStore = createInMemorySellerReceiptStore();
  const claim = vi.spyOn(receiptStore, "claim");
  const result = await verifySellerPaymentIntake({ jobId: JOB, phaseIndex: 2,
    railId: current.rail.railId,
    payerPayingKey: current.native ? BUYER : `cci-xm:evm:84532:${PAYER}`,
    receipt: current.native ? { kind: "pay-dem", txHash: DEM_TX } : {
      kind: "pay-x402", protocolVersion: "2",
      responseHeader: { name: "PAYMENT-RESPONSE", value: Buffer.from(JSON.stringify(receipt)).toString("base64") },
      httpResource: `${RESOURCE}/${JOB}`, paymentReceiptHash: sha256Hex(canonicalize(receipt)),
      settlementTxHash: EVM_TX, chainId: 84532,
    },
  }, {
    resolvePayerAddress: async () => ({ disposition: "verified", address: PAYER }),
    resolvePayeeDestination: async () => ({ disposition: "bound", address: PAYEE, tier: 3 }),
    ...host, executionMode: "simulation", receiptStore,
    observeDemosTransfer: async () => ({ status: "included", txHash: DEM_TX,
      payer: Buffer.from(BUYER_KEY).toString("hex"), payee: Buffer.from(SELLER_KEY).toString("hex"),
      amountOs: "1000000000", blockNumber: 42, includedAt: 2_000 }),
    observeX402Transfer: async () => ({ status: "finalized", chainId: 84532, txHash: EVM_TX,
      logIndex: 1, payer: PAYER, payee: PAYEE, amountBaseUnits: "1000000",
      asset: { contract: ASSET, symbol: "USDC", decimals: 6 }, confirmations: 3,
      includedAt: 2_000, finalityObservedAt: 3_000,
      sessionBinding: { kind: "eip3009", nonce: x402Eip3009Nonce(JOB, 2) } }),
    verifyX402ReceiptExtensions: async () => ({ disposition: "pass" }),
    classifyX402SettlementChain: async () => ({ disposition: "l2" }),
  });
  return { result, claim, receiptStore };
}

async function deliver(host: ReturnType<typeof authority>,
  receiptStore: ReturnType<typeof createInMemorySellerReceiptStore>, permitId: string,
  authorization: SellerPaymentAuthorization) {
  const ref = (locator: string, contentHash: string) => ({
    anchor: { kind: "storage-program" as const, locator }, contentHash,
  });
  const commitmentRef = ref(current.commitment.logicalAddress, authorization.commitment.contentHash);
  const paymentRef = ref(paymentEvidenceAddress(JOB, current.rail.railId, 2), authorization.evidenceHash);
  const parties = current.agreement.parties.map((party) => {
    if (party.role !== "buyer" && party.role !== "seller") throw new Error("unexpected party");
    return { ...party, role: party.role };
  });
  const commitmentDelta = { "commit-payee-bound-agreement": {
    agreementHash: authorization.agreementHash,
    anchorTxRef: current.commitment.anchorTxRef, anchorReceipt: current.commitment.anchorReceipt,
    committedAt: current.commitment.committedAt,
  } };
  const source: SellerFulfilmentAuditSourceV1 = {
    sourceVersion: "1", provenanceProfile: "dacs-sdk-operational-v1",
    session: {
      recordVersion: "1", jobId: JOB, state: "settle-pending", listingRef: current.pin,
      parties: [...parties, { role: "orchestrator", primaryClaim: SELLER,
        bundleHash: identityBundleHash(current.session.sellerIdentity) }],
      pipeline: current.listing.pipeline,
      phaseResults: current.listing.pipeline.slice(0, 3).map((step, index) => ({
        index, step, invokedAt: index === 2 ? 2_000 : 1_000,
        result: { ok: true, contextDelta: index === 1 ? commitmentDelta : {},
          ...(index === 1 ? { txRefs: [current.commitment.anchorTxRef], attestationRef: commitmentRef } :
            index === 2 ? { txRefs: authorization.evidenceInput.paymentTxRefs, attestationRef: paymentRef } : {}) },
        contextDelta: index === 1 ? commitmentDelta : {},
      })),
      startedAt: 1_000, lastUpdatedAt: 3_000, recipeRegistryVersion: 1, railRegistryVersion: 7,
    },
    artifacts: {
      agreementCommitment: commitmentRef,
      vetRecords: parties.map((party) => party.vetRecordRef),
      vetRequirements: parties.map((party) => ({
        vetRecordRef: party.vetRecordRef, evaluatedParty: party.primaryClaim,
        requirement: current.listing.buyerRequirement,
        verifier: party.role === "buyer" ? SELLER : BUYER, freshness: [], dealSpecific: [],
      })),
      settlementEvidence: [paymentRef],
    },
  };
  const artifact = { kind: "deliver-storage-program" as const,
    cleartextPayload: { answer: 42 }, anchoredValue: { answer: 42 }, access: { model: "public" as const } };
  const receipt = (logicalAddress: string, contentHash: string) => ({
    ...current.commitment.anchorReceipt, logicalAddress, contentHash,
    nativeAddress: `stor-${"a".repeat(40)}`, observedAt: 3_000,
    blockRef: { id: "block:delivery", height: "43", timestamp: 3_000 },
  });
  const signer = { algorithm: "ed25519" as const, signer: SELLER,
    sign: (bytes: Uint8Array) => sign(null, bytes, privateKeyFromSeed(SELLER_SEED)) };
  const verify = ({ signedBytes, signature, expectedSigner }: Pick<
    Parameters<SellerFulfilmentDeps["verifyEvidenceSignature"]>[0],
    "signedBytes" | "signature" | "expectedSigner"
  >): ReturnType<SellerFulfilmentDeps["verifyEvidenceSignature"]> =>
    expectedSigner === SELLER && signature.signer === SELLER && signature.algorithm === "ed25519" &&
      ed25519Verify(signedBytes, Buffer.from(signature.value, "base64url"), publicKeyFromSeed(SELLER_SEED))
      ? { disposition: "valid" } : { disposition: "invalid", reason: "signature mismatch" };
  let submitted = false;
  let evidence: unknown;
  const submitDelivery = vi.fn(async () => {
    submitted = true;
    return { status: "accepted" as const, reconciliationId: "delivery:historical" };
  });
  const deps: SellerFulfilmentDeps = {
    receiptStore, auditSourceProfile: "v2",
    resolveAgreement: host.resolveFulfilmentAgreement,
    resolveListing: host.resolveFulfilmentListing,
    resolveAuditSource: async () => ({ status: "verified", value: source }),
    prepareDelivery: async () => ({ status: "prepared", delivery: { artifact } }),
    submitDelivery,
    reconcileDelivery: async () => submitted
      ? { status: "complete", reconciliationId: "delivery:historical", observedAt: 3_000 }
      : { status: "absent", reason: "not submitted" },
    resolveDelivery: async ({ logicalAddress }) => ({ status: "verified", value: {
      artifact, anchorReceipt: receipt(logicalAddress, sha256Hex(canonicalize(artifact.anchoredValue))),
    } }),
    verifyAnchorReceipt: () => ({ disposition: "valid" }),
    evidenceSigner: signer, auditSourceCommitmentSigner: signer,
    verifyEvidenceSignature: verify, verifyAuditSourceCommitmentSignature: verify,
    anchorEvidence: async (input) => {
      evidence = input.evidence;
      const locator = "dacs4:evidence:historical";
      return { status: "anchored", ref: ref(locator, input.evidenceHash),
        anchorReceipt: receipt(locator, input.evidenceHash) };
    },
    resolveEvidence: async () => ({ status: "verified", value: evidence }),
    nowMs: () => 3_000,
  };
  const result = await runFulfilmentCore({ agreementRef: `dacs3:agreement:${JOB}`,
    agreementHash: authorization.agreementHash, commitmentRef: authorization.commitment.ref,
    deliveryPhaseIndex: 3, paymentPermitId: permitId }, deps);
  expect(result).toMatchObject({ decision: "completed", evidence: { outcome: "success" } });
  expect(submitDelivery).toHaveBeenCalledOnce();
}

for (const native of [true, false]) describe(native ? "native seller historical admission" : "x402 seller historical admission", () => {
  it("restores original bytes and reader identity through authority-to-intake composition", async () => {
    current = await fixture(native);
    // Simulate database deserialization and a new authority process.
    current.admission = JSON.parse(JSON.stringify(current.admission));
    for (let restart = 0; restart < 2; restart++) {
      const host = authority();
      const { result, claim, receiptStore } = await intake(host);
      expect(result).toMatchObject({ disposition: "verified", fulfilment: "claim" });
      expect(claim).toHaveBeenCalledOnce();
      if (result.disposition !== "verified" || !result.permitId) throw new Error(result.reason);
      await deliver(host, receiptStore, result.permitId, claim.mock.calls[0]![0].authorization);
      const restored = await host.resolveListingAtCommit(current.pin);
      expect(isVerifiedListingAdmission(restored.rawListing, restored.validation)).toBe(true);
      expect(getListingReaderProvenance(restored.validation)).not.toBeNull();
      expect(restored.validation.receivedJsonBase64).toBe(current.bytes.toString("base64"));
      expect(await host.resolveListingAtCommit(current.pin)).toBe(restored);
      expect(await host.resolveFulfilmentAgreement(`dacs3:agreement:${JOB}`)).toMatchObject({ status: "verified" });
      expect(await host.resolveFulfilmentListing(current.pin)).toMatchObject({ status: "verified" });
    }
  });

  it("retains the original reader's canonical Demos identity comparison", async () => {
    current = await fixture(native);
    const listing = structuredClone(current.listing);
    const bundle = listing.seller.identity;
    const alias = `${SELLER}?transport=https`;
    bundle.presentedBy = alias;
    bundle.claims[0]!.ref = alias;
    if (bundle.presentation.kind !== "per-claim") throw new Error("identity");
    bundle.presentation.signatures[0]!.ref = alias;
    bundle.presentation.signatures[0]!.signature = sign(null,
      Buffer.from(`dacs-bundle-presentation:v1:${identityBundleHash(bundle)}`),
      privateKeyFromSeed(SELLER_SEED)).toString("base64url");
    listing.signature.value = sign(null,
      Buffer.from(`dacs-listing:v1:${contentHash(listing as unknown as Record<string, unknown>)}`),
      privateKeyFromSeed(SELLER_SEED)).toString("base64url");
    const restored = await restoreDacsHistoricalListingAdmissionV1({
      listing, admittedAt: 1_000, seller: SELLER, rail: current.rail as never,
      executionMode: "simulation",
      admission: { receivedJsonBase64: Buffer.from(JSON.stringify(listing)).toString("base64"),
        revocation: "absent" },
    });
    expect(isVerifiedListingAdmission(restored.rawListing, restored.validation)).toBe(true);
    expect(getListingReaderProvenance(restored.validation)).not.toBeNull();
  });

  it("fails closed before receipt claim when the old checkpoint has no original bytes", async () => {
    current = await fixture(native);
    current.admission.listingAdmission = undefined;
    const { result, claim } = await intake(authority());
    expect(result).toMatchObject({ disposition: "indeterminate", fulfilment: "none" });
    expect(claim).not.toHaveBeenCalled();
  });

  it("requires retained historical revocation absence", async () => {
    current = await fixture(native);
    current.admission.listingAdmission = { ...current.admission.listingAdmission,
      revocation: "revoked" } as never;
    const { result, claim } = await intake(authority());
    expect(result).toMatchObject({ disposition: "indeterminate", fulfilment: "none" });
    expect(claim).not.toHaveBeenCalled();
  });

  it("rechecks the Listing signature before claiming a receipt", async () => {
    current = await fixture(native);
    const oldSignature = current.listing.signature.value;
    const invalid = Buffer.alloc(64, 9).toString("base64url");
    current.listing.signature.value = invalid;
    current.admission.listingAdmission = { revocation: "absent", receivedJsonBase64:
      Buffer.from(current.bytes.toString().replace(oldSignature, invalid)).toString("base64") };
    const { result, claim } = await intake(authority());
    expect(result).toMatchObject({ disposition: "indeterminate", fulfilment: "none" });
    expect(claim).not.toHaveBeenCalled();
  });

  it("rejects duplicate-member bytes that would parse to the same Listing", async () => {
    current = await fixture(native);
    current.admission.listingAdmission = { revocation: "absent", receivedJsonBase64: Buffer.from(
      current.bytes.toString().replace("{", '{"listingId":"ignored",')).toString("base64") };
    const { result, claim } = await intake(authority());
    expect(result).toMatchObject({ disposition: "indeterminate", fulfilment: "none" });
    expect(claim).not.toHaveBeenCalled();
  });
});
