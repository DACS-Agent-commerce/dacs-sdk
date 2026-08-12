import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  canonicalize,
  commitFixedPriceAgreement,
  contentHash,
  deriveFixedPriceAgreement,
  ed25519Sign,
  ed25519Verify,
  FINALITY_COMMITMENT_SEPARATOR,
  finalityCommitmentAddress,
  isAnchorReceipt,
  isAgreementCommitmentRecord,
  isCommitmentRecord,
  isFinalityCommitmentRecord,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
  signComponentArtifact,
  signFixedPriceAgreement,
  sha256Hex,
  type AgreementArtifact,
  type AnchoredFinalityCommitment,
  type ProtocolAnchorReceipt,
  type CommitmentSignatureVerifier,
  type FinalityCommitmentProvider,
  type FinalityCommitmentRecord,
  type IdentityBundle,
  type Listing,
  type PaymentRailRef,
} from "../../src/index.js";

const NOW = 1_785_232_799_000;
const COMMITTED_AT = NOW + 2_000;
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7E";
const BUYER_SEED = Uint8Array.from(Buffer.alloc(32, 41));
const SELLER_SEED = Uint8Array.from(Buffer.alloc(32, 42));
const ORCHESTRATOR_SEED = Uint8Array.from(Buffer.alloc(32, 43));
const claim = (seed: Uint8Array) =>
  `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const BUYER = claim(BUYER_SEED);
const SELLER = claim(SELLER_SEED);
const ORCHESTRATOR = claim(ORCHESTRATOR_SEED);

const rail: PaymentRailRef = {
  railId: "x402:default",
  railVersion: 1,
  parameters: { network: "eip155:8453" },
};

function identity(primaryClaim: string): IdentityBundle {
  return {
    bundleVersion: "1",
    presentedBy: primaryClaim,
    presentedAt: NOW - 10_000,
    claims: [{ ref: primaryClaim }],
    presentation: {
      kind: "per-claim",
      signatures: [{ ref: primaryClaim, signature: "identity-proof" }],
    },
  };
}

function listing(
  commitment: "commit-agreement" | "commit-payee-bound-agreement" =
    "commit-agreement",
): Listing {
  return {
    dacsVersion: "1",
    listingVersion: 4,
    listingId: "commitment-service",
    seller: {
      identity: identity(SELLER),
      displayName: "Commitment Service",
      publicEndpoint: "https://seller.example/dacs",
    },
    offering: {
      title: "Committed payload",
      description: "A finalized-agreement test payload",
      category: "data.test",
      tags: ["commitment"],
      deliverable: {
        kind: "attested-payload",
        payloadFormat: "application/json",
        verificationMethod: { kind: "self-signed" },
      },
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: commitment },
      { kind: "pay-x402", parameters: { rail: rail.railId } },
      { kind: "deliver-attested-payload" },
    ],
    pricing: { kind: "fixed", price: { amount: "1", currency: "USDC" } },
    acceptedRails: [rail],
    terms: { deadlineSecAfterCommit: 600 },
    validity: { notBefore: NOW - 60_000, notAfter: NOW + 60_000 },
    signature: {
      algorithm: "ed25519",
      signer: SELLER,
      value: Buffer.alloc(64, 7).toString("base64url"),
    },
  };
}

async function agreementFixture(
  commitment: "commit-agreement" | "commit-payee-bound-agreement" =
    "commit-agreement",
): Promise<{
  listing: Listing;
  agreement: AgreementArtifact;
  verifiedListing: {
    disposition: "verified";
    listing: Listing;
    pin: { listingId: string; version: number; contentHash: string };
  };
}> {
  const value = listing(commitment);
  const verifiedListing = {
    disposition: "verified" as const,
    listing: value,
    pin: {
      listingId: value.listingId,
      version: value.listingVersion,
      contentHash: contentHash(value as unknown as Record<string, unknown>),
    },
  };
  const draft = deriveFixedPriceAgreement({
    jobId: JOB_ID,
    verifiedListing,
    buyer: {
      identityBundle: identity(BUYER),
      vetRecordRef: {
        anchor: { kind: "storage-program", locator: "buyer-vet" },
        contentHash: "a".repeat(64),
      },
    },
    seller: {
      identityBundle: identity(SELLER),
      vetRecordRef: {
        anchor: { kind: "storage-program", locator: "seller-vet" },
        contentHash: "b".repeat(64),
      },
    },
    selectedRail: rail,
    ...(commitment === "commit-payee-bound-agreement"
      ? {
          payoutBindings: [
            {
              railId: rail.railId,
              phaseIndex: 2,
              payeeAddress: "0x1111111111111111111111111111111111111111",
            },
          ],
        }
      : {}),
    generatedAt: NOW,
  });
  const agreement = await signFixedPriceAgreement(
    draft,
    {
      party: BUYER,
      algorithm: "ed25519",
      sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(BUYER_SEED)),
    },
    {
      party: SELLER,
      algorithm: "ed25519",
      sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)),
    },
  );
  return { listing: value, agreement, verifiedListing };
}

async function signAgreementDraft(
  draft: Parameters<typeof signFixedPriceAgreement>[0],
): Promise<AgreementArtifact> {
  return signFixedPriceAgreement(
    draft,
    {
      party: BUYER,
      algorithm: "ed25519",
      sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(BUYER_SEED)),
    },
    {
      party: SELLER,
      algorithm: "ed25519",
      sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)),
    },
  );
}

async function meteredAgreementFixture(options: {
  unitPrice?: { amount: string; currency: string };
  unit?: string;
  minTotal?: { amount: string; currency: string };
  total: { amount: string; currency: string };
  quantity?: string;
  quantityUnit?: string;
}): Promise<Awaited<ReturnType<typeof agreementFixture>>> {
  const base = await agreementFixture();
  const value = structuredClone(base.listing);
  const unit = options.unit ?? "request";
  value.pricing = {
    kind: "metered",
    unitPrice: options.unitPrice ?? { amount: "1.25", currency: "USDC" },
    unit,
    ...(options.minTotal === undefined ? {} : { minTotal: options.minTotal }),
  };
  const pin = {
    listingId: value.listingId,
    version: value.listingVersion,
    contentHash: contentHash(value as unknown as Record<string, unknown>),
  };
  const { signatures: _signatures, ...draft } = structuredClone(base.agreement);
  draft.listingRef = pin;
  draft.terms.price = options.total;
  if (options.quantity === undefined) {
    delete draft.terms.meteredQuantity;
  } else {
    draft.terms.meteredQuantity = {
      quantity: options.quantity,
      unit: options.quantityUnit ?? unit,
    };
  }
  const agreement = await signAgreementDraft(draft);
  return {
    listing: value,
    agreement,
    verifiedListing: { disposition: "verified", listing: value, pin },
  };
}

const keys = new Map([
  [BUYER, publicKeyFromSeed(BUYER_SEED)],
  [SELLER, publicKeyFromSeed(SELLER_SEED)],
  [ORCHESTRATOR, publicKeyFromSeed(ORCHESTRATOR_SEED)],
]);

const verifySignature: CommitmentSignatureVerifier = (input) => {
  const key = keys.get(input.signer);
  if (!key || input.algorithm !== "ed25519") return "indeterminate";
  return ed25519Verify(
    input.signedBytes,
    Uint8Array.from(Buffer.from(input.value, "base64url")),
    key,
  )
    ? "valid"
    : "invalid";
};

function anchored(
  record: FinalityCommitmentRecord,
  overrides: Partial<ProtocolAnchorReceipt> = {},
): AnchoredFinalityCommitment {
  const nativeAddress = "stor-finality-commitment";
  const receipt: ProtocolAnchorReceipt = {
    receiptVersion: "1",
    substrate: "demos:testnet",
    finalityProfile: "demos-bft-final",
    logicalAddress: finalityCommitmentAddress(record.jobId),
    nativeAddress,
    contentHash: contentHash(record as unknown as Record<string, unknown>),
    transactionRef: { kind: "demos", value: "commitment-write-tx" },
    writer: "demos-writer",
    nonce: "17",
    state: "finalized",
    observationDisposition: "established",
    observedAt: COMMITTED_AT + 1_000,
    blockRef: { id: "block-100", height: "100", timestamp: COMMITTED_AT },
    evidence: { kind: "demos-finality-proof", value: "proof-100" },
    ...overrides,
  };
  return {
    record,
    nativeAddress,
    anchorTxRef: {
      kind: "storage-program",
      address: nativeAddress,
      writeTxHash: "c".repeat(64),
    },
    anchorReceipt: receipt,
  };
}

function provider(options: {
  present?: AnchoredFinalityCommitment;
  lookup?: "absent" | "indeterminate";
  receiptDisposition?: "valid" | "invalid" | "indeterminate" | "error";
  onSubmit?: (record: FinalityCommitmentRecord) => void;
} = {}): FinalityCommitmentProvider {
  return {
    resolve: async () =>
      options.present
        ? { disposition: "present", anchored: options.present }
        : options.lookup === "indeterminate"
          ? { disposition: "indeterminate", reason: "read quorum unavailable" }
          : { disposition: "absent" },
    submit: async (_logicalAddress, record) => {
      options.onSubmit?.(record);
      return anchored(record);
    },
    verifyAnchorReceipt: async () => options.receiptDisposition ?? "valid",
  };
}

function commitmentInput(
  fixture: Awaited<ReturnType<typeof agreementFixture>>,
  sign = (bytes: Uint8Array) =>
    ed25519Sign(bytes, privateKeyFromSeed(ORCHESTRATOR_SEED)),
) {
  return {
    agreement: fixture.agreement,
    verifiedListing: fixture.verifiedListing,
    orchestrator: ORCHESTRATOR,
    createdAt: NOW + 1_000,
    commitmentSigner: {
      algorithm: "ed25519" as const,
      signer: ORCHESTRATOR,
      sign,
    },
  };
}

describe("DACS-3 §8.6 finalized fixed-price commitment", () => {
  test("emits the new record and derives committedAt only from the finalized receipt", async () => {
    const fixture = await agreementFixture();
    let submitted: FinalityCommitmentRecord | undefined;
    const result = await commitFixedPriceAgreement(
      commitmentInput(fixture),
      provider({ onSubmit: (record) => (submitted = record) }),
      verifySignature,
    );

    expect(submitted).toBeDefined();
    expect(isFinalityCommitmentRecord(submitted)).toBe(true);
    expect(submitted).not.toHaveProperty("dacsVersion");
    expect(submitted).not.toHaveProperty("committedAt");
    expect(submitted).toMatchObject({
      finalityCommitmentVersion: "1",
      jobId: JOB_ID,
      parties: [BUYER, SELLER],
      pattern: "fixed-price",
      createdAt: NOW + 1_000,
      signature: { signer: ORCHESTRATOR, algorithm: "ed25519" },
    });
    expect(result.committedAt).toBe(COMMITTED_AT);
    expect(result.resumed).toBe(false);
    expect(result.logicalAddress).toBe(`dacs3:commit:${JOB_ID}`);
    expect(fixture.agreement.terms.deliverable.hash).toBe(
      sha256Hex(canonicalize(fixture.listing.offering.deliverable)),
    );
  });

  test("commits the payee-bound artifact only with exact pay-phase coverage", async () => {
    const fixture = await agreementFixture("commit-payee-bound-agreement");
    const result = await commitFixedPriceAgreement(
      commitmentInput(fixture),
      provider(),
      verifySignature,
    );
    expect(result.record.agreementHash).toBe(
      contentHash(fixture.agreement as unknown as Record<string, unknown>),
    );

    const wrongTuple = structuredClone(fixture.agreement);
    if ("payeeBoundAgreementVersion" in wrongTuple) {
      wrongTuple.terms.payoutBindings[0]!.phaseIndex = 3;
    }
    const { signatures: _signatures, ...wrongTupleDraft } = wrongTuple;
    const signedWrongTuple = await signFixedPriceAgreement(
      wrongTupleDraft,
      {
        party: BUYER,
        algorithm: "ed25519",
        sign: (bytes) =>
          ed25519Sign(bytes, privateKeyFromSeed(BUYER_SEED)),
      },
      {
        party: SELLER,
        algorithm: "ed25519",
        sign: (bytes) =>
          ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)),
      },
    );
    await expect(
      commitFixedPriceAgreement(
        { ...commitmentInput(fixture), agreement: signedWrongTuple },
        provider(),
        verifySignature,
      ),
    ).rejects.toThrow(/does not exactly cover/);
  });

  test("resumes a matching finalized record without signing or submitting again", async () => {
    const fixture = await agreementFixture();
    const first = await commitFixedPriceAgreement(
      commitmentInput(fixture),
      provider(),
      verifySignature,
    );
    let signerCalls = 0;
    let submits = 0;
    const resumed = await commitFixedPriceAgreement(
      commitmentInput(fixture, () => {
        signerCalls += 1;
        return new Uint8Array(64);
      }),
      provider({
        present: anchored(first.record),
        onSubmit: () => {
          submits += 1;
        },
      }),
      verifySignature,
    );
    expect(resumed.resumed).toBe(true);
    expect(signerCalls).toBe(0);
    expect(submits).toBe(0);
  });

  test("rejects a validly signed resumed record with buyer and seller positions swapped", async () => {
    const fixture = await agreementFixture();
    const first = await commitFixedPriceAgreement(
      commitmentInput(fixture),
      provider(),
      verifySignature,
    );
    const { signature: _signature, ...unsigned } = first.record;
    const swapped = await signComponentArtifact(
      { ...unsigned, parties: [SELLER, BUYER] },
      FINALITY_COMMITMENT_SEPARATOR,
      {
        algorithm: "ed25519",
        signer: ORCHESTRATOR,
        sign: (bytes) =>
          ed25519Sign(bytes, privateKeyFromSeed(ORCHESTRATOR_SEED)),
      },
    );

    await expect(
      commitFixedPriceAgreement(
        commitmentInput(fixture),
        provider({ present: anchored(swapped) }),
        verifySignature,
      ),
    ).rejects.toThrow(/binds different session content/);
  });

  test("records the MTR-5 reason for an unrecognized pricing kind", async () => {
    const fixture = await agreementFixture();
    const unknownPricing = structuredClone(
      fixture.verifiedListing.listing,
    ) as unknown as { pricing: { kind: string } };
    unknownPricing.pricing = { kind: "future-pricing" };

    await expect(
      commitFixedPriceAgreement(
        {
          ...commitmentInput(fixture),
          verifiedListing: {
            ...fixture.verifiedListing,
            listing: unknownPricing as unknown as Listing,
          },
        },
        provider(),
        verifySignature,
      ),
    ).rejects.toThrow(/^unrecognized-pricing-kind: future-pricing$/);
  });

  test("treats unresolved absence and ambiguous submission as fail-closed", async () => {
    const fixture = await agreementFixture();
    let signerCalls = 0;
    await expect(
      commitFixedPriceAgreement(
        commitmentInput(fixture, () => {
          signerCalls += 1;
          return new Uint8Array(64);
        }),
        provider({ lookup: "indeterminate" }),
        verifySignature,
      ),
    ).rejects.toThrow(/lookup is indeterminate/);
    expect(signerCalls).toBe(0);

    await expect(
      commitFixedPriceAgreement(
        commitmentInput(fixture),
        {
          ...provider(),
          submit: async () => {
            throw new Error("response stalled after broadcast");
          },
        },
        verifySignature,
      ),
    ).rejects.toThrow(/outcome is ambiguous; resolve before any retry/);
  });

  test("does not replace a legacy, malformed, or differently-bound existing record", async () => {
    const fixture = await agreementFixture();
    let submits = 0;
    const legacy = {
      dacsVersion: "1",
      jobId: JOB_ID,
      agreementHash: contentHash(
        fixture.agreement as unknown as Record<string, unknown>,
      ),
      listingRef: fixture.agreement.listingRef,
      parties: [BUYER, SELLER],
      pattern: "fixed-price",
      committedAt: COMMITTED_AT,
    };
    await expect(
      commitFixedPriceAgreement(
        commitmentInput(fixture),
        provider({
          present: anchored(legacy as never),
          onSubmit: () => {
            submits += 1;
          },
        }),
        verifySignature,
      ),
    ).rejects.toThrow(/legacy, malformed, or binds different/);
    expect(submits).toBe(0);
  });

  test("rejects non-final, indeterminate, or mismatched receipt bindings", async () => {
    const fixture = await agreementFixture();
    const first = await commitFixedPriceAgreement(
      commitmentInput(fixture),
      provider(),
      verifySignature,
    );
    for (const receipt of [
      { state: "included" as const },
      {
        observationDisposition: "indeterminate" as const,
        preservedReceiptHash: "d".repeat(64),
      },
      { logicalAddress: "dacs3:commit:other-job" },
      { contentHash: "e".repeat(64) },
      { blockRef: { id: "block-without-time", height: "100" } },
    ]) {
      await expect(
        commitFixedPriceAgreement(
          commitmentInput(fixture),
          provider({ present: anchored(first.record, receipt) }),
          verifySignature,
        ),
        JSON.stringify(receipt),
      ).rejects.toThrow(/not an exact finalized SR-2 binding/);
    }
  });

  test("keeps receipt proof indeterminate distinct from invalid", async () => {
    const fixture = await agreementFixture();
    for (const receiptDisposition of ["indeterminate", "error"] as const) {
      await expect(
        commitFixedPriceAgreement(
          commitmentInput(fixture),
          provider({ receiptDisposition }),
          verifySignature,
        ),
      ).rejects.toMatchObject({ category: "substrate" });
    }
    await expect(
      commitFixedPriceAgreement(
        commitmentInput(fixture),
        provider({ receiptDisposition: "invalid" }),
        verifySignature,
      ),
    ).rejects.toThrow(/receipt proof is invalid/);
  });

  test("verifies both agreement parties before resolving or submitting commitment", async () => {
    const fixture = await agreementFixture();
    let resolves = 0;
    await expect(
      commitFixedPriceAgreement(
        commitmentInput(fixture),
        {
          ...provider(),
          resolve: async () => {
            resolves += 1;
            return { disposition: "absent" };
          },
        },
        (request) =>
          request.purpose === "agreement" && request.signer === SELLER
            ? "invalid"
            : verifySignature(request),
      ),
    ).rejects.toThrow(/agreement signature is not verified/);
    expect(resolves).toBe(0);
  });

  test("checks valid party signatures before rejecting Listing-term mutation", async () => {
    const fixture = await agreementFixture();
    const mutated = structuredClone(fixture.agreement);
    mutated.terms.price.amount = "2";
    const { signatures: _signatures, ...mutatedDraft } = mutated;
    const resigned = await signFixedPriceAgreement(
      mutatedDraft,
      {
        party: BUYER,
        algorithm: "ed25519",
        sign: (bytes) =>
          ed25519Sign(bytes, privateKeyFromSeed(BUYER_SEED)),
      },
      {
        party: SELLER,
        algorithm: "ed25519",
        sign: (bytes) =>
          ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)),
      },
    );
    let agreementVerifications = 0;
    let commitmentSignatures = 0;
    let resolves = 0;
    await expect(
      commitFixedPriceAgreement(
        {
          ...commitmentInput(fixture, () => {
            commitmentSignatures += 1;
            return new Uint8Array(64);
          }),
          agreement: resigned,
        },
        {
          ...provider(),
          resolve: async () => {
            resolves += 1;
            return { disposition: "absent" };
          },
        },
        (request) => {
          if (request.purpose === "agreement") agreementVerifications += 1;
          return verifySignature(request);
        },
      ),
    ).rejects.toThrow(/price is not the exact/);
    expect(agreementVerifications).toBe(2);
    expect(commitmentSignatures).toBe(0);
    expect(resolves).toBe(0);
  });

  test("uses receipt time for authoritative deadline and Listing expiry checks", async () => {
    const fixture = await agreementFixture();
    const first = await commitFixedPriceAgreement(
      commitmentInput(fixture),
      provider(),
      verifySignature,
    );
    const late = fixture.agreement.terms.deadline + 1;
    await expect(
      commitFixedPriceAgreement(
        commitmentInput(fixture),
        provider({
          present: anchored(first.record, {
            blockRef: { id: "late-block", height: "101", timestamp: late },
          }),
        }),
        verifySignature,
      ),
    ).rejects.toThrow(/authoritative agreement\/Listing checks/);
  });

  test("resumes an in-time finalized commitment after local Listing expiry", async () => {
    const fixture = await agreementFixture();
    const first = await commitFixedPriceAgreement(
      commitmentInput(fixture),
      provider(),
      verifySignature,
    );
    const retryInput = {
      ...commitmentInput(fixture, () => {
        throw new Error("a resumed commitment must not sign again");
      }),
      createdAt: fixture.listing.validity.notAfter! + 1,
    };

    const resumed = await commitFixedPriceAgreement(
      retryInput,
      provider({ present: anchored(first.record) }),
      verifySignature,
    );
    expect(resumed.resumed).toBe(true);
    expect(resumed.record.createdAt).toBe(first.record.createdAt);

    await expect(
      commitFixedPriceAgreement(
        retryInput,
        provider(),
        verifySignature,
      ),
    ).rejects.toThrow(/provisional time checks/);
  });

  test("requires the canonical uppercase ULID address spelling before callbacks", async () => {
    expect(finalityCommitmentAddress(JOB_ID)).toBe(
      `dacs3:commit:${JOB_ID}`,
    );
    for (const invalid of [
      JOB_ID.toLowerCase(),
      `8${JOB_ID.slice(1)}`,
      `${JOB_ID.slice(0, -1)}I`,
      JOB_ID.slice(1),
      `${JOB_ID}0`,
      "job-finality-1",
    ]) {
      expect(() => finalityCommitmentAddress(invalid), invalid).toThrow(
        /canonical uppercase ULID/,
      );
    }

    const fixture = await agreementFixture();
    const nonCanonicalAgreement = structuredClone(fixture.agreement);
    nonCanonicalAgreement.jobId = JOB_ID.toLowerCase();
    let verifications = 0;
    let resolves = 0;
    await expect(
      commitFixedPriceAgreement(
        {
          ...commitmentInput(fixture),
          agreement: nonCanonicalAgreement,
        },
        {
          ...provider(),
          resolve: async () => {
            resolves += 1;
            return { disposition: "absent" };
          },
        },
        (request) => {
          verifications += 1;
          return verifySignature(request);
        },
      ),
    ).rejects.toThrow(/canonical uppercase ULID/);
    expect(verifications).toBe(0);
    expect(resolves).toBe(0);
  });

  test("owns caller artifacts and dependency choices before the first await", async () => {
    const fixture = await agreementFixture();
    const input = commitmentInput(fixture);
    const expectedAgreementHash = contentHash(
      input.agreement as unknown as Record<string, unknown>,
    );
    const selectedProvider = provider();
    let mutated = false;

    const result = await commitFixedPriceAgreement(
      input,
      selectedProvider,
      async (request) => {
        if (!mutated) {
          mutated = true;
          input.agreement.terms.price.amount = "999";
          input.verifiedListing.listing.pricing = {
            kind: "fixed",
            price: { amount: "999", currency: "USDC" },
          };
          input.commitmentSigner.signer = BUYER;
          selectedProvider.resolve = async () => ({
            disposition: "indeterminate",
            reason: "swapped after verification began",
          });
          await Promise.resolve();
        }
        return verifySignature(request);
      },
    );

    expect(result.agreementHash).toBe(expectedAgreementHash);
    expect(result.record.signature.signer).toBe(ORCHESTRATOR);
    expect(result.resumed).toBe(false);
  });

  test("rejects accessor-backed input without invoking it or external work", async () => {
    const fixture = await agreementFixture();
    const input = commitmentInput(fixture);
    let getterCalls = 0;
    let resolves = 0;
    let verifications = 0;
    Object.defineProperty(input, "agreement", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return fixture.agreement;
      },
    });

    await expect(
      commitFixedPriceAgreement(
        input,
        {
          ...provider(),
          resolve: async () => {
            resolves += 1;
            return { disposition: "absent" };
          },
        },
        (request) => {
          verifications += 1;
          return verifySignature(request);
        },
      ),
    ).rejects.toThrow(/agreement must be an enumerable data property/);
    expect(getterCalls).toBe(0);
    expect(resolves).toBe(0);
    expect(verifications).toBe(0);
  });

  test("captures only stable provider data methods without invoking getters", async () => {
    const fixture = await agreementFixture();
    const selectedProvider = provider();
    let getterCalls = 0;
    Object.defineProperty(selectedProvider, "resolve", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return async () => ({ disposition: "absent" as const });
      },
    });
    await expect(
      commitFixedPriceAgreement(
        commitmentInput(fixture),
        selectedProvider,
        verifySignature,
      ),
    ).rejects.toThrow(/resolve must be a data method/);
    expect(getterCalls).toBe(0);

    const proxyProvider = provider();
    proxyProvider.resolve = new Proxy(proxyProvider.resolve, {});
    await expect(
      commitFixedPriceAgreement(
        commitmentInput(fixture),
        proxyProvider,
        verifySignature,
      ),
    ).rejects.toThrow(/resolve must be a data method/);
  });

  test("rejects non-exact lookup and present-result envelopes", async () => {
    const fixture = await agreementFixture();
    const first = await commitFixedPriceAgreement(
      commitmentInput(fixture),
      provider(),
      verifySignature,
    );
    const malformedLookups: unknown[] = [
      { disposition: "absent", reason: "extra" },
      { disposition: "indeterminate", reason: "" },
      {
        disposition: "present",
        anchored: anchored(first.record),
        extra: true,
      },
    ];
    for (const lookup of malformedLookups) {
      await expect(
        commitFixedPriceAgreement(
          commitmentInput(fixture),
          {
            ...provider(),
            resolve: async () => lookup as never,
          },
          verifySignature,
        ),
        JSON.stringify(lookup),
      ).rejects.toThrow(/malformed lookup envelope/);
    }

    await expect(
      commitFixedPriceAgreement(
        commitmentInput(fixture),
        {
          ...provider(),
          resolve: async () => ({
            disposition: "present",
            anchored: { ...anchored(first.record), extra: true } as never,
          }),
        },
        verifySignature,
      ),
    ).rejects.toThrow(/malformed anchor result/);

    let getterCalls = 0;
    const accessorLookup = Object.defineProperty({}, "disposition", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "absent";
      },
    });
    await expect(
      commitFixedPriceAgreement(
        commitmentInput(fixture),
        {
          ...provider(),
          resolve: async () => accessorLookup as never,
        },
        verifySignature,
      ),
    ).rejects.toThrow(/unstable or non-wire result/);
    expect(getterCalls).toBe(0);
  });

  test("requires a fresh anchor to return the exact submitted record", async () => {
    const fixture = await agreementFixture();
    await expect(
      commitFixedPriceAgreement(
        commitmentInput(fixture),
        {
          ...provider(),
          submit: async (_logicalAddress, record) =>
            anchored({ ...record, createdAt: record.createdAt + 1 }),
        },
        verifySignature,
      ),
    ).rejects.toThrow(/exact submitted record/);
  });

  test("rejects a receipt verifier that mutates its isolated proof input", async () => {
    const fixture = await agreementFixture();
    await expect(
      commitFixedPriceAgreement(
        commitmentInput(fixture),
        {
          ...provider(),
          verifyAnchorReceipt: async (candidate) => {
            (
              candidate.anchorReceipt as ProtocolAnchorReceipt
            ).writer = "mutated-writer";
            return "valid" as const;
          },
        },
        verifySignature,
      ),
    ).rejects.toThrow(/proof verifier mutated its input/);
  });

  test("fails closed for auto-accept until its typed proof path exists", async () => {
    const fixture = await agreementFixture();
    const value = structuredClone(fixture.listing);
    value.terms.acceptanceModel = "auto-accept";
    const input = commitmentInput(fixture);
    input.verifiedListing = {
      disposition: "verified",
      listing: value,
      pin: {
        listingId: value.listingId,
        version: value.listingVersion,
        contentHash: contentHash(value as unknown as Record<string, unknown>),
      },
    };
    let resolves = 0;
    let verifications = 0;

    await expect(
      commitFixedPriceAgreement(
        input,
        {
          ...provider(),
          resolve: async () => {
            resolves += 1;
            return { disposition: "absent" };
          },
        },
        (request) => {
          verifications += 1;
          return verifySignature(request);
        },
      ),
    ).rejects.toThrow(/auto-accept requires a verified commitment/);
    expect(resolves).toBe(0);
    expect(verifications).toBe(0);
  });

  test("accepts exact metered products and minimum-total floors", async () => {
    const cases = [
      await meteredAgreementFixture({
        total: { amount: "5", currency: "USDC" },
        quantity: "4",
      }),
      await meteredAgreementFixture({
        unitPrice: { amount: "0.25", currency: "USDC" },
        minTotal: { amount: "2", currency: "USDC" },
        total: { amount: "2", currency: "USDC" },
        quantity: "2",
      }),
      await meteredAgreementFixture({
        unitPrice: { amount: "0.5", currency: "USDC" },
        minTotal: { amount: "1", currency: "USDC" },
        total: { amount: "1", currency: "USDC" },
        quantity: "0",
      }),
      await meteredAgreementFixture({
        unitPrice: { amount: "0.000001", currency: "USDC" },
        unit: "token",
        total: { amount: "123.456789", currency: "USDC" },
        quantity: "123456789",
      }),
    ];
    for (const fixture of cases) {
      const result = await commitFixedPriceAgreement(
        commitmentInput(fixture),
        provider(),
        verifySignature,
      );
      expect(result.resumed).toBe(false);
    }
  });

  test("rejects incomplete or incorrectly recomputed metered terms before lookup", async () => {
    const cases = [
      {
        fixture: await meteredAgreementFixture({
          total: { amount: "5.01", currency: "USDC" },
          quantity: "4",
        }),
        reason: /metered-total-mismatch/,
      },
      {
        fixture: await meteredAgreementFixture({
          total: { amount: "5", currency: "USDC" },
          quantity: "4",
          quantityUnit: "token",
        }),
        reason: /metered-unit-mismatch/,
      },
      {
        fixture: await meteredAgreementFixture({
          total: { amount: "5", currency: "USDC" },
        }),
        reason: /missing-metered-quantity/,
      },
    ];
    for (const { fixture, reason } of cases) {
      let resolves = 0;
      await expect(
        commitFixedPriceAgreement(
          commitmentInput(fixture),
          {
            ...provider(),
            resolve: async () => {
              resolves += 1;
              return { disposition: "absent" };
            },
          },
          verifySignature,
        ),
      ).rejects.toThrow(reason);
      expect(resolves).toBe(0);
    }

    const fixed = await agreementFixture();
    const { signatures: _signatures, ...draft } = structuredClone(
      fixed.agreement,
    );
    draft.terms.meteredQuantity = { quantity: "1", unit: "request" };
    const agreement = await signAgreementDraft(draft);
    await expect(
      commitFixedPriceAgreement(
        { ...commitmentInput(fixed), agreement },
        provider(),
        verifySignature,
      ),
    ).rejects.toThrow(/unexpected-metered-quantity/);
  });

  test("rejects a finality record signed under the legacy domain", async () => {
    const fixture = await agreementFixture();
    const first = await commitFixedPriceAgreement(
      commitmentInput(fixture),
      provider(),
      verifySignature,
    );
    const { signature: _signature, ...unsigned } = first.record;
    const wrongDomain = await signComponentArtifact(
      unsigned,
      "dacs-commitment:v1:",
      {
        algorithm: "ed25519",
        signer: ORCHESTRATOR,
        sign: (bytes) =>
          ed25519Sign(bytes, privateKeyFromSeed(ORCHESTRATOR_SEED)),
      },
    );
    await expect(
      commitFixedPriceAgreement(
        commitmentInput(fixture),
        provider({ present: anchored(wrongDomain) }),
        verifySignature,
      ),
    ).rejects.toThrow(/finality-commitment signature is not verified \(invalid\)/);
  });
});

describe("pinned commitment-record compatibility vectors", () => {
  const vector = JSON.parse(
    readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../vendor/DACS-Standard/conformance/vectors/security/commitment-record-compatibility-v0.1.json",
      ),
      "utf8",
    ),
  ) as {
    fixture: {
      legacyRecord: Record<string, unknown>;
      finalityRecord: Record<string, unknown>;
      finalizedReceipt: { blockTimestamp: number };
    };
    vectors: Array<{
      name: string;
      record: string;
      signatureDomain: string;
      usedCommittedAt: number;
      expected: "pass" | "fail";
    }>;
  };

  test("selects exact legacy/finality arms and rejects discriminator coercion", () => {
    const { legacyRecord, finalityRecord } = vector.fixture;
    expect(isCommitmentRecord(legacyRecord)).toBe(true);
    expect(isFinalityCommitmentRecord(finalityRecord)).toBe(true);
    expect(isAgreementCommitmentRecord(legacyRecord)).toBe(true);
    expect(isAgreementCommitmentRecord(finalityRecord)).toBe(true);

    const both = { ...finalityRecord, dacsVersion: "1" };
    const { finalityCommitmentVersion: _version, ...neither } = finalityRecord;
    const { signature: _signature, ...missingSignature } = finalityRecord;
    for (const invalid of [
      both,
      neither,
      missingSignature,
      { ...finalityRecord, finalityCommitmentVersion: "2" },
    ]) {
      expect(isAgreementCommitmentRecord(invalid)).toBe(false);
    }
  });

  test("matches every compatibility-vector decision", () => {
    const recordFor = (kind: string): Record<string, unknown> => {
      if (kind === "legacy") return structuredClone(vector.fixture.legacyRecord);
      const finality = structuredClone(vector.fixture.finalityRecord);
      if (kind === "both-discriminators") return { ...finality, dacsVersion: "1" };
      if (kind === "neither-discriminator") {
        delete finality.finalityCommitmentVersion;
        return finality;
      }
      if (kind === "finality-no-signature") {
        delete finality.signature;
        return finality;
      }
      if (kind === "unsupported-finality-version") {
        finality.finalityCommitmentVersion = "2";
      }
      return finality;
    };

    for (const entry of vector.vectors) {
      const record = recordFor(entry.record);
      const legacy = isCommitmentRecord(record);
      const finality = isFinalityCommitmentRecord(record);
      const correctDomain = legacy
        ? entry.signatureDomain === "dacs-commitment:v1:"
        : finality &&
          entry.signatureDomain === "dacs-finality-commitment:v1:";
      const correctTime = legacy
        ? entry.usedCommittedAt === record.committedAt
        : finality &&
          entry.usedCommittedAt === vector.fixture.finalizedReceipt.blockTimestamp;
      const decision =
        (legacy || finality) && correctDomain && correctTime ? "pass" : "fail";
      expect(decision, entry.name).toBe(entry.expected);
    }
  });

  test("validates the complete portable finalized receipt shape", () => {
    const record = vector.fixture.finalityRecord as unknown as FinalityCommitmentRecord;
    expect(isAnchorReceipt(anchored(record).anchorReceipt)).toBe(true);
  });
});
