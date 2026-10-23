import { trustedSessionProfile } from "./helpers/sessionProfile.js";
import {
  ARTIFACT_SEPARATORS,
  BUNDLE_BINDING_SEPARATOR,
  DacsError,
  IndeterminateSubstrateError,
  verifyCompletedTwoSidedSession,
  attestationBundleHash,
  type BundleBinding,
  type FaultAttestationBundle,
} from "@kynesyslabs/dacs";
import { bundleAddress, canonicalize, contentHash, sha256Hex } from
  "@kynesyslabs/dacs/canonical";
import {
  ed25519Sign,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
  signedBytes,
} from "@kynesyslabs/dacs/crypto";
import { describe, expect, it, vi } from "vitest";

// Explicitly non-live harness: the live paths here run against a released
// profile record; the real record at the pin refuses every admission.
vi.mock("../../../src/discovery/standardProfileRelease.js", () => ({ DACS_STANDARD_PROFILE_STATUS: "released" }));

import {
  DACS_BUNDLE_BINDING_DISCOVERY_TIMEOUT_MS,
  DACS_BUNDLE_BINDING_INDEX_MAX_RECORDS,
  createCatalogBundleBindingSurfaceV1,
  createWellKnownBundleBindingSurfaceV1,
  type DacsBundleBindingDiscoverySurfaceV1,
} from "../src/bundleBindingDiscovery.js";
import { readDacsPublicJsonV1 } from "../src/publicJson.js";
import { createDacsDemosBundlePublicationV1 } from "../src/demosBundlePublication.js";
import type { DacsLiveRoleOperationContextV1 } from "../src/roleRuntime.js";

vi.mock("../src/publicJson.js", () => ({ readDacsPublicJsonV1: vi.fn() }));

// The fee-budget grant lives in the role database; these tests stub the
// adapter and need only the write's options to pass through.
vi.mock("../src/purchaseDemosBudget.js", () => ({
  dacsFixedPricePurchaseAnchorOptionsV1: vi.fn(() => ({ metadata: {} })),
}));

// Isolate the public completion boundary; the seller verifier has its own
// cryptographic closure suite. Bundle signatures, candidate resolution and
// native publication reads below use the real implementations.
vi.mock("../../../src/seller/bundleFinalization.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/seller/bundleFinalization.js")>()),
  verifyFinalizedSellerBundleReadOnly: async (_input: unknown, result: unknown) => result,
}));

const NOW = 1_786_000_000_000;
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER_SEED = Uint8Array.from(Buffer.alloc(32, 51));
const SELLER_SEED = Uint8Array.from(Buffer.alloc(32, 52));
const BUYER = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(BUYER_SEED))).toString("hex")}`;
const SELLER = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(SELLER_SEED))).toString("hex")}`;
type Role = "buyer" | "seller";

function seed(party: string) {
  return privateKeyFromSeed(party === BUYER ? BUYER_SEED : SELLER_SEED);
}

function bundle(role: Role, note = "listing-completion"): FaultAttestationBundle {
  const unsigned = {
    faultBundleVersion: "1",
    jobId: JOB_ID,
    outcome: "completed",
    faultedParty: "none",
    listingRef: { listingId: note, version: 1, contentHash: "e".repeat(64) },
    parties: [
      { role: "buyer", bundleHash: "1".repeat(64), primaryClaim: BUYER },
      { role: "seller", bundleHash: "2".repeat(64), primaryClaim: SELLER },
    ],
    phaseSummary: [],
    vetRecords: [],
    settlementEvidence: [],
    recipeRegistryVersion: 1,
    railRegistryVersion: 1,
    finalisedAt: NOW,
  };
  const sign = (party: string) => ({
    party,
    algorithm: "ed25519",
    value: Buffer.from(ed25519Sign(
      signedBytes(ARTIFACT_SEPARATORS.FaultAttestationBundle, contentHash(unsigned)),
      seed(party),
    )).toString("base64url"),
  });
  return { ...unsigned, anchoredByRole: role, signatures: [sign(BUYER), sign(SELLER)] } as never;
}

function binding(role: Role, nativeAddress: string, copy: FaultAttestationBundle): BundleBinding {
  const signer = role === "buyer" ? BUYER : SELLER;
  const unsigned = {
    bindingVersion: "1",
    jobId: JOB_ID,
    role,
    logicalAddress: bundleAddress(JOB_ID, role),
    nativeAddress,
    bundleContentHash: attestationBundleHash(copy),
    signer,
  };
  return {
    ...unsigned,
    signature: {
      algorithm: "ed25519",
      signer,
      value: Buffer.from(ed25519Sign(
        signedBytes(BUNDLE_BINDING_SEPARATOR, contentHash(unsigned)),
        seed(signer),
      )).toString("base64url"),
    },
  } as BundleBinding;
}

// A Demos stub: write-once programs keyed by native address, a name index that
// can lag, and receipts that authenticate whatever was written.
function harness(role: Role, discovery: DacsBundleBindingDiscoverySurfaceV1[] = [], admittedSeller = SELLER) {
  const programs = new Map<string, unknown>();
  const names = new Map<string, string>();
  const writers = new Map<string, string>();
  let next = 0;
  let indexLags = false;
  const adapter = {
    anchorWriteOnce: vi.fn(async (name: string, value: unknown) => {
      next += 1;
      const address = `stor-${String(next).padStart(40, "0")}`;
      programs.set(address, structuredClone(value));
      writers.set(address, role === "buyer" ? BUYER : SELLER);
      if (!indexLags) names.set(name, address);
      return { address };
    }),
    resolveAnchorByName: vi.fn(async (name: string) => {
      const address = names.get(name);
      return address === undefined ? { status: "absent" as const }
        : { status: "present" as const, address };
    }),
    readAnchor: vi.fn(async (address: string) =>
      structuredClone(programs.get(address) ?? null)),
    resolveDemosAnchorReceipt: vi.fn(async (input: {
      logicalAddress: string; nativeAddress: string; contentHash: string; writer: string;
    }) => programs.has(input.nativeAddress) ? {
      receiptVersion: "1",
      substrate: "demos",
      finalityProfile: "demos-bft-confirmed-native-read",
      logicalAddress: input.logicalAddress,
      nativeAddress: input.nativeAddress,
      contentHash: input.contentHash,
      // The only kind DemosAdapter builds or decodes (demosWriteEvidence.ts).
      transactionRef: { kind: "demos-storage-program", value: `tx-${input.nativeAddress}` },
      writer: writers.get(input.nativeAddress) ?? input.writer,
      state: "finalized",
      observationDisposition: "established",
      observedAt: NOW,
      blockRef: { id: "block", height: "1", timestamp: NOW },
      evidence: { kind: "demos-bft-write-proof-v1", value: "proof" },
    } : null),
    verifyDemosAnchorReceipt: vi.fn(async () => true),
  };
  const context = {
    authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, admittedSeller),
    role,
    authority: role === "buyer" ? BUYER : SELLER,
    config: { role },
    demos: { adapter },
  } as unknown as DacsLiveRoleOperationContextV1;
  const publication = createDacsDemosBundlePublicationV1({
    context, jobId: JOB_ID, buyer: BUYER, seller: SELLER, discovery,
  });
  // Seed a counterparty's program directly, as if it had written it.
  const seedProgram = (address: string, value: unknown, writer: string, name?: string) => {
    programs.set(address, structuredClone(value));
    writers.set(address, writer);
    if (name !== undefined) names.set(name, address);
  };
  return {
    adapter, publication, programs, names, seedProgram,
    lagIndex() { indexLags = true; },
  };
}

describe("Demos role-bundle submission (BB-1 producer path)", () => {
  it.each([
    ["another role", "buyer", bundleAddress(JOB_ID, "buyer")],
    ["another logical address", "seller", bundleAddress(JOB_ID, "buyer")],
  ] as const)("refuses %s before any write", async (_label, role, logical) => {
    const h = harness("seller");
    await expect(h.publication.submitRoleBundle(role, logical, bundle("seller")))
      .rejects.toMatchObject({ reasonCode: "bundle-submission-invalid" });
    expect(h.adapter.anchorWriteOnce).not.toHaveBeenCalled();
  });

  it("refuses content that is not a bundle before any write", async () => {
    const h = harness("seller");
    await expect(h.publication.submitRoleBundle("seller", bundleAddress(JOB_ID, "seller"),
      { not: "a bundle" } as never)).rejects.toMatchObject({ reasonCode: "bundle-submission-invalid" });
    expect(h.adapter.anchorWriteOnce).not.toHaveBeenCalled();
  });

  it("reads its own copy back where the write landed while the name index lags", async () => {
    const h = harness("seller");
    h.lagIndex();
    const copy = bundle("seller");
    await h.publication.submitRoleBundle("seller", bundleAddress(JOB_ID, "seller"), copy);
    expect(h.adapter.anchorWriteOnce).toHaveBeenCalledWith(
      bundleAddress(JOB_ID, "seller"), copy, expect.anything());
    expect(h.adapter.resolveAnchorByName).not.toHaveBeenCalled();
    // Later reads of its own copy use that native address, not the name.
    const own = await h.publication.resolveRoleBundle("seller");
    expect(own).toMatchObject({ nativeAddress: `stor-${"1".padStart(40, "0")}`, bundle: copy });
    expect(h.adapter.resolveAnchorByName).not.toHaveBeenCalled();
  });

  it("resolves an ambiguous write by its own name and refuses one it cannot find", async () => {
    const found = harness("seller");
    const copy = bundle("seller");
    found.seedProgram("stor-" + "a".repeat(40), copy, SELLER, bundleAddress(JOB_ID, "seller"));
    found.adapter.anchorWriteOnce.mockRejectedValueOnce(new Error("timeout"));
    await expect(found.publication.submitRoleBundle("seller", bundleAddress(JOB_ID, "seller"), copy))
      .resolves.toBeUndefined();
    const lost = harness("seller");
    lost.adapter.anchorWriteOnce.mockRejectedValueOnce(new Error("timeout"));
    await expect(lost.publication.submitRoleBundle("seller", bundleAddress(JOB_ID, "seller"), copy))
      .rejects.toMatchObject({ reasonCode: "bundle-submission-ambiguous" });
  });

  it.each([
    ["holds another bundle", (h: ReturnType<typeof harness>) => {
      h.adapter.anchorWriteOnce.mockImplementationOnce(async () => {
        h.seedProgram("stor-" + "b".repeat(40), bundle("seller", "other"), SELLER);
        return { address: "stor-" + "b".repeat(40) };
      });
    }],
    ["is not readable yet", (h: ReturnType<typeof harness>) => {
      h.adapter.anchorWriteOnce.mockResolvedValueOnce({ address: "stor-" + "c".repeat(40) });
    }],
  ] as const)("refuses a write whose native address %s", async (_label, arrange) => {
    const h = harness("seller");
    arrange(h);
    const outcome = h.publication.submitRoleBundle("seller", bundleAddress(JOB_ID, "seller"),
      bundle("seller"));
    await expect(outcome).rejects.toMatchObject({
      reasonCode: expect.stringMatching(/^bundle-(submission-ambiguous|resolution-indeterminate)$/),
    });
  });
});

describe("Demos BundleBinding publication (BB-1 producer path)", () => {
  async function submitted(role: Role = "seller") {
    const h = harness(role);
    const copy = bundle(role);
    await h.publication.submitRoleBundle(role, bundleAddress(JOB_ID, role), copy);
    const own = (await h.publication.resolveRoleBundle(role))!;
    return { h, copy, signed: binding(role, own.nativeAddress, copy) };
  }

  it.each([
    ["another role", (b: BundleBinding) => b, "buyer" as Role],
    ["a binding for another role", (b: BundleBinding) => ({ ...b, role: "buyer" }) as never, "seller" as Role],
    ["a signer other than this role", (b: BundleBinding) => ({ ...b, signer: BUYER,
      signature: { ...b.signature, signer: BUYER } }) as never, "seller" as Role],
    ["a bad signature", (b: BundleBinding) => ({ ...b,
      signature: { ...b.signature, value: Buffer.alloc(64, 9).toString("base64url") } }) as never,
    "seller" as Role],
    ["a binding naming other content", (b: BundleBinding) => ({ ...b,
      bundleContentHash: "f".repeat(64) }) as never, "seller" as Role],
  ])("rejects %s before any write", async (_label, mutate, role) => {
    const { h, signed } = await submitted();
    const writes = h.adapter.anchorWriteOnce.mock.calls.length;
    await expect(h.publication.publishRoleBundleBinding(role, mutate(signed))).resolves.toEqual({
      disposition: "rejected", reason: "bundle-binding-publication-invalid" });
    expect(h.adapter.anchorWriteOnce).toHaveBeenCalledTimes(writes);
  });

  it("publishes, reads back where the write landed, and resolves it while the name index lags", async () => {
    const { h, signed } = await submitted();
    h.lagIndex();
    await expect(h.publication.publishRoleBundleBinding("seller", signed)).resolves.toEqual({
      disposition: "published" });
    expect(h.adapter.anchorWriteOnce).toHaveBeenLastCalledWith(
      `dacs5:bundle-binding:${JOB_ID}:seller`, signed, expect.anything());
    await expect(h.publication.resolveBundleBinding(bundleAddress(JOB_ID, "seller"), SELLER))
      .resolves.toEqual({ disposition: "present", binding: signed });
  });

  it("confirms an ambiguous write only by the exact binding", async () => {
    const found = await submitted();
    found.h.seedProgram("stor-" + "d".repeat(40), found.signed, SELLER,
      `dacs5:bundle-binding:${JOB_ID}:seller`);
    found.h.adapter.anchorWriteOnce.mockRejectedValueOnce(new Error("timeout"));
    await expect(found.h.publication.publishRoleBundleBinding("seller", found.signed))
      .resolves.toEqual({ disposition: "published" });

    const lost = await submitted();
    lost.h.adapter.anchorWriteOnce.mockRejectedValueOnce(new Error("timeout"));
    await expect(lost.h.publication.publishRoleBundleBinding("seller", lost.signed))
      .resolves.toEqual({ disposition: "indeterminate",
        reason: "bundle-binding-publication-ambiguous" });
  });

  it.each([
    ["holds something else", { other: true }],
    ["is not readable yet", undefined],
  ])("reports a write whose native address %s as ambiguous", async (_label, stored) => {
    const { h, signed } = await submitted();
    h.adapter.anchorWriteOnce.mockImplementationOnce(async () => {
      if (stored !== undefined) h.seedProgram("stor-" + "e".repeat(40), stored, SELLER);
      return { address: "stor-" + "e".repeat(40) };
    });
    await expect(h.publication.publishRoleBundleBinding("seller", signed)).resolves.toEqual({
      disposition: "indeterminate", reason: "bundle-binding-publication-ambiguous" });
  });

  it("reports its own discovered binding as indeterminate while the copy it names is unreadable", async () => {
    const { h, signed } = await submitted();
    await h.publication.publishRoleBundleBinding("seller", signed);
    const read = h.adapter.readAnchor.getMockImplementation()!;
    h.adapter.readAnchor.mockImplementation(async (address: string) =>
      address === signed.nativeAddress ? null : read(address));
    await expect(h.publication.resolveBundleBinding(bundleAddress(JOB_ID, "seller"), SELLER))
      .resolves.toEqual({ disposition: "indeterminate",
        reason: "bundle-binding-candidates-unfetched" });
  });

  // The seller's signed binding re-signed with an `anchorTx`.
  function withAnchorTx(signed: BundleBinding, anchorTx: string): BundleBinding {
    const unsigned = { ...signed, anchorTx } as Record<string, unknown>;
    delete unsigned.signature;
    return {
      ...unsigned,
      signature: { ...signed.signature, value: Buffer.from(ed25519Sign(
        signedBytes(BUNDLE_BINDING_SEPARATOR, contentHash(unsigned)), seed(SELLER),
      )).toString("base64url") },
    } as unknown as BundleBinding;
  }

  it("refuses a binding whose anchorTx is not the copy's anchor transaction", async () => {
    const { copy, signed } = await submitted();
    const forged = withAnchorTx(signed, "tx-other");
    const catalog: DacsBundleBindingDiscoverySurfaceV1 = {
      kind: "catalog", discover: async () => [forged] };
    const consumer = harness("buyer", [catalog]);
    consumer.seedProgram(signed.nativeAddress, copy, SELLER);
    await expect(consumer.publication.resolveBoundRoleBundle("seller")).resolves.toEqual({
      disposition: "indeterminate", reason: "bundle-binding-candidates-rejected" });
    await expect(consumer.publication.verifyBundleBinding(forged)).resolves.toBe("invalid");
  });

  it.each([false, true])("discards invalid anchorTx before equal-copy collapse (invalid first: %s)", async (invalidFirst) => {
    const { copy, signed } = await submitted();
    const valid = withAnchorTx(signed, `tx-${signed.nativeAddress}`);
    const invalid = withAnchorTx(signed, "tx-other");
    const catalog: DacsBundleBindingDiscoverySurfaceV1 = { kind: "catalog",
      discover: async () => invalidFirst ? [invalid, valid] : [valid, invalid] };
    const consumer = harness("buyer", [catalog]);
    consumer.seedProgram(signed.nativeAddress, copy, SELLER);
    await expect(consumer.publication.resolveBoundRoleBundle("seller"))
      .resolves.toMatchObject({ disposition: "present", binding: valid });
  });

  it("accepts a binding whose anchorTx is the receipt's demos-storage-program transaction", async () => {
    const { copy, signed } = await submitted();
    const carried = withAnchorTx(signed, `tx-${signed.nativeAddress}`);
    const catalog: DacsBundleBindingDiscoverySurfaceV1 = {
      kind: "catalog", discover: async () => [carried] };
    const consumer = harness("buyer", [catalog]);
    consumer.seedProgram(signed.nativeAddress, copy, SELLER);
    await expect(consumer.publication.verifyBundleBinding(carried)).resolves.toBe("valid");
    await expect(consumer.publication.resolveBoundRoleBundle("seller")).resolves.toMatchObject({
      disposition: "present", binding: carried,
      anchored: { nativeAddress: signed.nativeAddress,
        anchorReceipt: { transactionRef: { kind: "demos-storage-program",
          value: `tx-${signed.nativeAddress}` } } },
    });
  });

  it("adds a carried binding to the BB-6 candidates and keeps an equivocating side indeterminate", async () => {
    const { copy, signed } = await submitted();
    // No surface shows the seller's binding: only the one the copy carries.
    const consumer = harness("buyer");
    consumer.seedProgram(signed.nativeAddress, copy, SELLER);
    await expect(consumer.publication.resolveBundleBinding(bundleAddress(JOB_ID, "seller"), SELLER))
      .resolves.toEqual({ disposition: "indeterminate", reason: "bundle-binding-undiscovered" });
    await expect(consumer.publication.resolveBundleBinding(bundleAddress(JOB_ID, "seller"), SELLER, signed))
      .resolves.toEqual({ disposition: "present", binding: signed });

    // A second, equally co-signed seller copy that a catalog shows.
    const other = bundle("seller", "other");
    const otherNative = "stor-" + "f".repeat(40);
    const catalog: DacsBundleBindingDiscoverySurfaceV1 = {
      kind: "catalog", discover: async () => [binding("seller", otherNative, other)] };
    const equivocating = harness("buyer", [catalog]);
    equivocating.seedProgram(signed.nativeAddress, copy, SELLER);
    equivocating.seedProgram(otherNative, other, SELLER);
    await expect(equivocating.publication.resolveBundleBinding(bundleAddress(JOB_ID, "seller"), SELLER, signed))
      .resolves.toEqual({ disposition: "indeterminate", reason: "bundle-binding-equivocation" });
  });

  // CORE B.1 CF-3: deployment admission may name the seller with advisory
  // parameters. A binding signed under the plain key is still that party's.
  it("resolves the seller's binding when admission or lookup qualifies the holder with parameters", async () => {
    const { copy, signed } = await submitted();
    const qualified = `${SELLER}?jurisdiction=GB`;
    const consumer = harness("buyer", [], qualified);
    consumer.seedProgram(signed.nativeAddress, copy, SELLER);
    for (const signer of [SELLER, qualified]) {
      await expect(consumer.publication.resolveBundleBinding(bundleAddress(JOB_ID, "seller"), signer, signed))
        .resolves.toEqual({ disposition: "present", binding: signed });
    }
    // The same key signing under a qualified spelling is the same role holder.
    const { signature: _signature, ...unsigned } = signed;
    const payload = { ...unsigned, signer: qualified };
    const requalified = { ...payload, signature: { algorithm: "ed25519", signer: qualified,
      value: Buffer.from(ed25519Sign(signedBytes(BUNDLE_BINDING_SEPARATOR, contentHash(payload)),
        seed(SELLER))).toString("base64url") } } as BundleBinding;
    await expect(consumer.publication.verifyBundleBinding(requalified)).resolves.toBe("valid");
    await expect(consumer.publication.resolveBundleBinding(bundleAddress(JOB_ID, "seller"), SELLER, requalified))
      .resolves.toEqual({ disposition: "present", binding: requalified });
  });

  it.each((["present", "equivocation", "budget-exhausted", "candidates-unfetched"] as const)
    .flatMap((reason) => (["unsigned", "other address", "other role", "other signer", "unrelated"] as const)
      .map((noise) => [reason, noise] as const)))(
    "preserves %s through the wrapper and completion beside malformed discovery (%s)",
    async (reason, noise) => {
      let malformed = false;
      const buyerCopy = bundle("buyer");
      const sellerCopy = bundle("seller");
      const buyerNative = "stor-" + "1".repeat(40);
      const sellerNative = "stor-" + "2".repeat(40);
      const buyerBinding = binding("buyer", buyerNative, buyerCopy);
      const sellerBinding = binding("seller", sellerNative, sellerCopy);
      const outsiderSeed = Uint8Array.from(Buffer.alloc(32, 53));
      const outsider = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(outsiderSeed))).toString("hex")}`;
      const foreignSigner = noise === "other signer" || noise === "unrelated";
      const { signature: _signature, ...unsigned } = buyerBinding;
      const payload = { ...unsigned, jobId: "malformed",
        ...(noise === "other address" || noise === "unrelated"
          ? { logicalAddress: bundleAddress("01J8ME0SXKQ4T9V2RC5HJ6WX7E", "buyer") } : {}),
        ...(noise === "other role" ? { role: "seller" } : {}),
        ...(foreignSigner ? { signer: outsider } : {}),
      };
      const signedNoise = { ...payload, signature: {
        algorithm: "ed25519", signer: payload.signer,
        value: Buffer.from(ed25519Sign(
          signedBytes(BUNDLE_BINDING_SEPARATOR, contentHash(payload)),
          foreignSigner ? privateKeyFromSeed(outsiderSeed) : seed(BUYER),
        )).toString("base64url"),
      } };
      const noisyRows = noise === "unsigned"
        ? [{ jobId: "malformed" }, { ...buyerBinding, jobId: "malformed" }]
        : [signedNoise];
      const additional = reason === "equivocation" || reason === "candidates-unfetched"
        ? [{ address: "stor-" + "3".repeat(40), copy: bundle("buyer", "divergent") }]
        : reason === "budget-exhausted" ? Array.from({ length: 8 }, (_, i) => ({
            address: `stor-${String(i + 4).padStart(40, "0")}`, copy: buyerCopy,
          })) : [];
      const candidates = [buyerBinding, sellerBinding,
        ...additional.map(({ address, copy }) => binding("buyer", address, copy))];
      const h = harness("seller", [{ kind: "catalog", discover: async () =>
        malformed ? [...candidates, ...noisyRows] : candidates }]);
      h.seedProgram(buyerNative, buyerCopy, BUYER);
      h.seedProgram(sellerNative, sellerCopy, SELLER);
      if (reason !== "candidates-unfetched") {
        for (const { address, copy } of additional) h.seedProgram(address, copy, BUYER);
      }
      const resolve = () => h.publication.resolveBundleBinding(
        bundleAddress(JOB_ID, "buyer"), BUYER, buyerBinding);
      const expectedResolution = reason === "present"
        ? { disposition: "present", binding: buyerBinding }
        : { disposition: "indeterminate", reason: `bundle-binding-${reason}` };
      await expect(resolve()).resolves.toEqual(expectedResolution);
      // Fetch exact receipts independently of the unresolved candidate set.
      const buyerReceipt = await h.adapter.resolveDemosAnchorReceipt({
        logicalAddress: buyerBinding.logicalAddress, nativeAddress: buyerNative,
        contentHash: buyerBinding.bundleContentHash, writer: BUYER,
      });
      const sellerReceipt = await h.adapter.resolveDemosAnchorReceipt({
        logicalAddress: sellerBinding.logicalAddress, nativeAddress: sellerNative,
        contentHash: sellerBinding.bundleContentHash, writer: SELLER,
      });
      const verify = () => verifyCompletedTwoSidedSession({
        jobId: JOB_ID, buyer: BUYER, seller: SELLER,
        sellerClosure: { verificationInput: {} as never, result: {
          state: "finalised", nativeAddress: sellerNative, anchorReceipt: sellerReceipt,
          sellerBundle: sellerCopy, buyerBundle: buyerCopy, binding: sellerBinding,
          bundleContentHash: sellerBinding.bundleContentHash,
        } as never },
        copies: {
          buyer: { role: "buyer", nativeAddress: buyerNative, bundle: buyerCopy,
            anchorReceipt: buyerReceipt! as never, binding: buyerBinding },
          seller: { role: "seller", nativeAddress: sellerNative, bundle: sellerCopy,
            anchorReceipt: sellerReceipt! as never, binding: sellerBinding },
        },
      }, {
        authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER),
        sellerFinalizationProvider: { mapping: "write-input",
          bundleCopyVerifier: h.publication.bundleCopyVerifier } as never,
        readBundleCopy: (address) => h.publication.readBundleAt(address),
        verifyBundleAnchor: () => ({ disposition: "valid", mapping: "write-input" }),
        verifyBundleBinding: async (candidate) => ({
          disposition: await h.publication.verifyBundleBinding(candidate),
        }) as never,
        resolveBundleBinding: (logical, signer, _role, carried) =>
          h.publication.resolveBundleBinding(logical, signer, carried),
      });
      for (const noisy of [false, true]) {
        malformed = noisy;
        // Unsigned noise and authentic rows outside the requested scope
        // cannot alter resolution or the post-settlement completion gate.
        await expect(resolve()).resolves.toEqual(expectedResolution);
        if (reason === "present") {
          await expect(verify()).resolves.toMatchObject({ state: "audit-complete" });
        } else {
          await expect(verify()).rejects.toBeInstanceOf(IndeterminateSubstrateError);
        }
      }
    },
  );

  it.each(["malformed", "", null, 42])(
    "preserves a permanent error for an authenticated malformed signed job id (%s)", async (jobId) => {
      const { signed } = await submitted();
      const unsigned = { ...signed, jobId } as Record<string, unknown>;
      delete unsigned.signature;
      const authenticated = { ...unsigned, signature: { ...signed.signature,
        value: Buffer.from(ed25519Sign(
          signedBytes(BUNDLE_BINDING_SEPARATOR, contentHash(unsigned)), seed(SELLER),
        )).toString("base64url") } };
      const h = harness("buyer", [{ kind: "catalog", discover: async () => [authenticated] }]);
      const error = await h.publication.resolveBundleBinding(bundleAddress(JOB_ID, "seller"), SELLER)
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(DacsError);
      expect(error).not.toBeInstanceOf(IndeterminateSubstrateError);
      expect(String(error)).toMatch(/signed jobId.*canonical uppercase ULID/);
      expect(h.adapter.readAnchor).not.toHaveBeenCalled();
    },
  );

  it("verifies a binding whose native address holds nothing readable yet as indeterminate", async () => {
    const { signed } = await submitted();
    // A consumer whose node has not caught up: no program at the address yet.
    const consumer = harness("buyer");
    await expect(consumer.publication.verifyBundleBinding(signed)).resolves.toBe("indeterminate");
    expect(consumer.adapter.readAnchor).toHaveBeenCalledWith(signed.nativeAddress);
  });

  it("reports its own undiscovered binding as absent so it publishes it, and a counterparty's as indeterminate", async () => {
    const { h } = await submitted();
    await expect(h.publication.resolveBundleBinding(bundleAddress(JOB_ID, "seller"), SELLER))
      .resolves.toEqual({ disposition: "absent" });
    await expect(h.publication.resolveBundleBinding(bundleAddress(JOB_ID, "buyer"), BUYER))
      .resolves.toEqual({ disposition: "indeterminate", reason: "bundle-binding-undiscovered" });
  });
});

describe("BundleBinding discovery surfaces (DACS-1 §6.3.5, §6.3.6)", () => {
  const sellerCopy = bundle("seller");
  const sellerNative = "stor-" + "5".repeat(40);
  const sellerBinding = binding("seller", sellerNative, sellerCopy);
  const index = { bindings: [sellerBinding] };
  const card = (block: unknown) => ({
    name: "seller agent",
    dacs: { dacsVersion: "1", ...(block === undefined ? {} : { bundleBindings: block }) },
  });
  const goodBlock = {
    indexUrl: "https://seller.example/.well-known/dacs/bundle-bindings.json",
    indexHash: `sha256-${sha256Hex(canonicalize(index))}`,
  };

  function reader(documents: Record<string, unknown>) {
    return vi.fn(async (url: string) => {
      if (!(url in documents)) throw new Error(`unreachable ${url}`);
      return structuredClone(documents[url]);
    });
  }

  it("treats an A2A card without optional DACS metadata as an answered empty surface", async () => {
    const readJson = vi.fn(async () => ({ name: "A2A-only agent" }));
    const surface = createWellKnownBundleBindingSurfaceV1({ endpoint: "https://seller.example", readJson });
    await expect(surface.discover({ jobId: JOB_ID, role: "seller", signer: SELLER })).resolves.toEqual([]);
    expect(readJson).toHaveBeenCalledExactlyOnceWith("https://seller.example/.well-known/agent.json");
    for (const dacs of [null, {}, { dacsVersion: "2" }]) {
      readJson.mockResolvedValueOnce({ name: "invalid", dacs } as never);
      await expect(surface.discover({ jobId: JOB_ID, role: "seller", signer: SELLER })).rejects.toThrow();
    }
  });

  it("reads the well-known bundleBindings index and checks its indexHash", async () => {
    const ok = reader({
      "https://seller.example/.well-known/agent.json": card(goodBlock),
      [goodBlock.indexUrl]: index,
    });
    const surface = createWellKnownBundleBindingSurfaceV1({
      endpoint: "https://seller.example", readJson: ok });
    await expect(surface.discover({ jobId: JOB_ID, role: "seller", signer: SELLER }))
      .resolves.toEqual([sellerBinding]);

    const stale = createWellKnownBundleBindingSurfaceV1({ endpoint: "https://seller.example",
      readJson: reader({
        "https://seller.example/.well-known/agent.json": card(goodBlock),
        [goodBlock.indexUrl]: { bindings: [] },
      }) });
    await expect(stale.discover({ jobId: JOB_ID, role: "seller", signer: SELLER }))
      .rejects.toThrow(/indexHash/);

    const foreign = createWellKnownBundleBindingSurfaceV1({ endpoint: "https://seller.example",
      readJson: reader({ "https://seller.example/.well-known/agent.json": card({
        ...goodBlock, indexUrl: "https://elsewhere.example/index.json" }),
        "https://elsewhere.example/index.json": index }) });
    await expect(foreign.discover({ jobId: JOB_ID, role: "seller", signer: SELLER }))
      .resolves.toEqual([sellerBinding]);

    for (const indexUrl of ["http://elsewhere.example/index.json",
      "https://user@elsewhere.example/index.json", "https://:password@elsewhere.example/index.json"]) {
      const unsafe = createWellKnownBundleBindingSurfaceV1({ endpoint: "https://seller.example",
        readJson: reader({ "https://seller.example/.well-known/agent.json": card({
          ...goodBlock, indexUrl }) }) });
      await expect(unsafe.discover({ jobId: JOB_ID, role: "seller", signer: SELLER }))
        .rejects.toThrow(/credential-free https URL/);
    }

    const none = createWellKnownBundleBindingSurfaceV1({ endpoint: "https://seller.example",
      readJson: reader({ "https://seller.example/.well-known/agent.json": card(undefined) }) });
    await expect(none.discover({ jobId: JOB_ID, role: "seller", signer: SELLER }))
      .resolves.toEqual([]);

    for (const block of [{ indexUrl: goodBlock.indexUrl }, { ...goodBlock, indexHash: "sha256-xyz" }, "block",
      { ...goodBlock, indexHash: goodBlock.indexHash.toUpperCase() }, { ...goodBlock, indexHash: `x${goodBlock.indexHash}` },
      { ...goodBlock, indexHash: `${goodBlock.indexHash}0` }, { ...goodBlock, indexHash: [goodBlock.indexHash] }]) {
      const malformed = createWellKnownBundleBindingSurfaceV1({ endpoint: "https://seller.example",
        readJson: reader({ "https://seller.example/.well-known/agent.json": card(block) }) });
      await expect(malformed.discover({ jobId: JOB_ID, role: "seller", signer: SELLER }))
        .rejects.toThrow(/malformed/);
    }
    for (const endpoint of ["http://seller.example", "https://a@seller.example", "https://:b@seller.example"]) {
      expect(() => createWellKnownBundleBindingSurfaceV1({ endpoint, readJson: ok }))
        .toThrow(/credential-free https URL/);
    }
  });

  it.each(["well-known", "catalog"] as const)("bounds decoded %s index lists", async (kind) => {
    const oversized = { bindings: Array(DACS_BUNDLE_BINDING_INDEX_MAX_RECORDS + 1).fill(sellerBinding) };
    const readJson = reader({
      "https://seller.example/.well-known/agent.json": card({ ...goodBlock,
        indexHash: `sha256-${sha256Hex(canonicalize(oversized))}` }),
      [goodBlock.indexUrl]: oversized,
      [`https://seller.example/api/dacs/bundles/${JOB_ID}`]: oversized,
    });
    const surface = kind === "well-known"
      ? createWellKnownBundleBindingSurfaceV1({ endpoint: "https://seller.example", readJson })
      : createCatalogBundleBindingSurfaceV1({ catalogUrl: "https://seller.example", readJson });
    await expect(surface.discover({ jobId: JOB_ID, role: "seller", signer: SELLER }))
      .rejects.toThrow(/record limit/);
  });

  it.each(["well-known", "catalog"] as const)("uses the bounded public HTTPS reader by default for %s", async (kind) => {
    const readJson = vi.mocked(readDacsPublicJsonV1);
    readJson.mockReset();
    readJson.mockImplementation(reader({
      "https://seller.example/.well-known/agent.json": card(goodBlock),
      [goodBlock.indexUrl]: index,
      [`https://seller.example/api/dacs/bundles/${JOB_ID}`]: index,
    }));
    const surface = kind === "well-known"
      ? createWellKnownBundleBindingSurfaceV1({ endpoint: "https://seller.example" })
      : createCatalogBundleBindingSurfaceV1({ catalogUrl: "https://seller.example" });
    await expect(surface.discover({ jobId: JOB_ID, role: "seller", signer: SELLER }))
      .resolves.toEqual([sellerBinding]);
    expect(readJson).toHaveBeenCalled();
  });

  it.each(["well-known", "catalog"] as const)("gives an unanswered %s read a deadline", async (kind) => {
    vi.useFakeTimers();
    try {
      const readJson = vi.fn(() => new Promise<never>(() => {}));
      const surface = kind === "well-known"
        ? createWellKnownBundleBindingSurfaceV1({ endpoint: "https://seller.example", readJson })
        : createCatalogBundleBindingSurfaceV1({ catalogUrl: "https://seller.example", readJson });
      const result = expect(surface.discover({ jobId: JOB_ID, role: "seller", signer: SELLER }))
        .rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(DACS_BUNDLE_BINDING_DISCOVERY_TIMEOUT_MS);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a default network read at its discovery deadline", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      vi.mocked(readDacsPublicJsonV1).mockImplementation((_url, options) => {
        signal = options?.signal;
        return new Promise<never>(() => {});
      });
      const surface = createCatalogBundleBindingSurfaceV1({ catalogUrl: "https://seller.example" });
      const result = expect(surface.discover({ jobId: JOB_ID, role: "seller", signer: SELLER }))
        .rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(DACS_BUNDLE_BINDING_DISCOVERY_TIMEOUT_MS);
      await result;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads a catalog's bundles endpoint for the job", async () => {
    // DACS-1 §6.3.6: the route is absolute on the catalog's origin.
    const readJson = reader({ [`https://catalog.example/api/dacs/bundles/${JOB_ID}`]: index });
    const surface = createCatalogBundleBindingSurfaceV1({
      catalogUrl: "https://catalog.example/", readJson });
    await expect(surface.discover({ jobId: JOB_ID, role: "seller", signer: SELLER }))
      .resolves.toEqual([sellerBinding]);
    const malformed = createCatalogBundleBindingSurfaceV1({ catalogUrl: "https://catalog.example",
      readJson: reader({ [`https://catalog.example/api/dacs/bundles/${JOB_ID}`]: { bindings: 1 } }) });
    await expect(malformed.discover({ jobId: JOB_ID, role: "seller", signer: SELLER }))
      .rejects.toThrow(/malformed/);
    // A path would move the Standard's endpoint (to /v1/api/...): refuse it.
    for (const catalogUrl of ["https://catalog.example/v1", "https://catalog.example/v1/",
      "https://catalog.example/?x=1", "https://catalog.example/#f"]) {
      expect(() => createCatalogBundleBindingSurfaceV1({ catalogUrl, readJson }))
        .toThrow(/origin without a path/);
    }
  });

  it("finds the seller's copy through a catalog when no binding program shows it", async () => {
    const catalog = createCatalogBundleBindingSurfaceV1({ catalogUrl: "https://catalog.example",
      readJson: reader({ [`https://catalog.example/api/dacs/bundles/${JOB_ID}`]: index }) });
    const h = harness("buyer", [catalog]);
    h.seedProgram(sellerNative, sellerCopy, SELLER);
    await expect(h.publication.resolveBoundRoleBundle("seller")).resolves.toMatchObject({
      disposition: "present", binding: sellerBinding,
      anchored: { nativeAddress: sellerNative, bundle: sellerCopy },
    });
  });

  // BB-8: nothing discovered is no evidence either way, but a surface that did
  // not answer is not every surface answering without a binding.
  it("stays indeterminate when no surface answers, never absent", async () => {
    const down: DacsBundleBindingDiscoverySurfaceV1 = {
      kind: "catalog", discover: vi.fn(async () => { throw new Error("catalog down"); }),
    };
    const h = harness("buyer", [down]);
    h.seedProgram(sellerNative, sellerCopy, SELLER);
    await expect(h.publication.resolveBoundRoleBundle("seller")).resolves.toEqual({
      disposition: "indeterminate", reason: "bundle-binding-unanswered" });
    await expect(h.publication.resolveBundleBinding(bundleAddress(JOB_ID, "seller"), SELLER))
      .resolves.toEqual({ disposition: "indeterminate", reason: "bundle-binding-unanswered" });
    // A binding another source supplies still resolves past the silent surface.
    await expect(h.publication.resolveBundleBinding(bundleAddress(JOB_ID, "seller"), SELLER,
      sellerBinding)).resolves.toEqual({ disposition: "present", binding: sellerBinding });
    // Its own role publishes either way: the write is idempotent.
    const own = harness("seller", [down]);
    await expect(own.publication.resolveBundleBinding(bundleAddress(JOB_ID, "seller"), SELLER))
      .resolves.toEqual({ disposition: "absent" });
  });

  it("refuses invalid discovery surfaces", () => {
    expect(() => harness("buyer", [{ kind: "catalog" } as never])).toThrow(/discovery surfaces/);
  });
});
