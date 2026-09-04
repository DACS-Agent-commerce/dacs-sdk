import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  canonicalize,
  contentHash,
  sha256Hex,
  stripSignature,
} from "../../src/canonical/index.js";
import {
  ed25519Verify,
  publicKeyFromRaw,
  signedBytes,
} from "../../src/crypto/index.js";
import {
  signFixedPriceAgreement,
  type UnsignedAgreementArtifact,
} from "../../src/negotiate/fixedPrice.js";
import { validateFixedPriceAgreementBinding } from "../../src/negotiate/commitment.js";
import type {
  AttestationRef,
  IdentityBundle,
  Listing,
  PaymentPhaseType,
  PaymentRailRef,
  PriorPaymentDisposition,
} from "../../src/artifacts/types.js";
import {
  authorizeAlternativePayment,
  buildPriorPaymentDisposition,
  deriveAlternativeFixedPriceAgreement,
  projectAlternativePaymentPipeline,
  validateAlternativePaymentListing,
  validateAlternativePaymentRetry,
  verifyAlternativePaymentAudit,
  verifyPriorPaymentReplacement,
  type AlternativePaymentAgreementLike,
  type AlternativePaymentAuditBundleLike,
  type AlternativePaymentDecision,
  type AlternativePaymentListingAdmission,
  type AlternativePaymentListingLike,
  type AlternativePaymentProjection,
  type AlternativeRailDefinition,
  type PriorPaymentReplacementAdmission,
} from "../../src/rails/payAlternative.js";

interface PatchOperation {
  op: "add" | "remove" | "replace";
  path: Array<string | number>;
  value?: unknown;
}

interface CompactVector {
  name: string;
  expected: "pass" | "fail" | "indeterminate" | "error";
  expectedReason?: string;
  operation: string;
  base: string;
  patch: PatchOperation[];
  [key: string]: unknown;
}

interface Fixture {
  set: string;
  count: number;
  hash: string;
  fixtures: Record<string, Record<string, unknown>>;
  vectors: CompactVector[];
}

type MaterializedVector = Record<string, unknown> & {
  name: string;
  expected: CompactVector["expected"];
  expectedReason?: string;
  operation: string;
  listing: AlternativePaymentListingLike;
  agreement: AlternativePaymentAgreementLike;
  registry: Record<string, unknown>;
  runtime: Record<string, unknown>;
  bundle: AlternativePaymentAuditBundleLike;
  keys: Record<string, string>;
};

const fixtureBytes = readFileSync(
  new URL(
    "../fixtures/standard-next/alternative-payment-projection-v0.1.json",
    import.meta.url,
  ),
);
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as Fixture;

function applyPatch(root: unknown, operation: PatchOperation): unknown {
  if (operation.path.length === 0) {
    if (operation.op === "remove") throw new Error("cannot remove root");
    return structuredClone(operation.value);
  }
  let parent = root as Record<string | number, unknown> | unknown[];
  for (const segment of operation.path.slice(0, -1)) {
    parent = (parent as Record<string | number, unknown>)[segment] as
      | Record<string | number, unknown>
      | unknown[];
  }
  const leaf = operation.path.at(-1)!;
  if (Array.isArray(parent) && typeof leaf === "number") {
    if (operation.op === "remove") parent.splice(leaf, 1);
    else if (operation.op === "add") parent.splice(leaf, 0, structuredClone(operation.value));
    else parent[leaf] = structuredClone(operation.value);
  } else if (operation.op === "remove") {
    delete (parent as Record<string | number, unknown>)[leaf];
  } else {
    (parent as Record<string | number, unknown>)[leaf] = structuredClone(
      operation.value,
    );
  }
  return root;
}

function materialize(compact: CompactVector): MaterializedVector {
  let value: unknown = structuredClone(fixture.fixtures[compact.base]);
  for (const operation of compact.patch) value = applyPatch(value, operation);
  return Object.assign(value as Record<string, unknown>, {
    name: compact.name,
    expected: compact.expected,
    ...(compact.expectedReason ? { expectedReason: compact.expectedReason } : {}),
    operation: compact.operation,
  }) as MaterializedVector;
}

const vectors = fixture.vectors.map(materialize);

function verifySignature(
  artifact: Record<string, unknown>,
  signature: unknown,
  publicKey: string,
  domain: string,
  expectedSigner?: string,
  omit: readonly string[] = [],
): boolean {
  if (
    signature === null ||
    typeof signature !== "object" ||
    Array.isArray(signature)
  ) {
    return false;
  }
  const envelope = signature as Record<string, unknown>;
  if (
    envelope.algorithm !== "ed25519" ||
    typeof envelope.value !== "string" ||
    (expectedSigner !== undefined && envelope.signer !== expectedSigner)
  ) {
    return false;
  }
  try {
    const base = stripSignature(artifact);
    const scope = Object.fromEntries(
      Object.entries(base).filter(([key]) => !omit.includes(key)),
    );
    const hash = sha256Hex(canonicalize(scope));
    return ed25519Verify(
      signedBytes(domain, hash),
      Buffer.from(envelope.value, "base64url"),
      publicKeyFromRaw(Buffer.from(publicKey, "base64url")),
    );
  } catch {
    return false;
  }
}

function verifyAgreement(
  vector: MaterializedVector,
  agreement: AlternativePaymentAgreementLike,
): boolean {
  const parties = agreement.parties;
  const signatures = agreement.signatures;
  if (!Array.isArray(parties) || !Array.isArray(signatures) || signatures.length !== 2) {
    return false;
  }
  const claims = Object.fromEntries(
    parties
      .filter((party): party is Record<string, unknown> =>
        party !== null && typeof party === "object" && !Array.isArray(party),
      )
      .map((party) => [party.role, party.primaryClaim]),
  );
  if (typeof claims.buyer !== "string" || typeof claims.seller !== "string") {
    return false;
  }
  return (["buyer", "seller"] as const).every((role) => {
    const signature = signatures.find(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        (entry as Record<string, unknown>).party === claims[role],
    );
    return verifySignature(
      agreement as unknown as Record<string, unknown>,
      signature,
      vector.keys[role]!,
      "dacs-payee-bound-agreement:v1:",
    );
  });
}

function listingDeps(vector: MaterializedVector) {
  const registry = vector.registry;
  const runtime = vector.runtime;
  return {
    authenticateListing: (listing: Readonly<AlternativePaymentListingLike>) =>
      verifySignature(
        listing as Record<string, unknown>,
        listing.signature,
        vector.keys.seller!,
        "dacs-listing:v1:",
        runtime.listingPublisherClaim as string,
      )
        ? ({ status: "authenticated" } as const)
        : ({ status: "invalid", reason: "signature" } as const),
    resolveRegistry: () => {
      if (registry.authorityAuthenticated !== true) {
        return { status: "indeterminate" as const, reason: "authority" };
      }
      const snapshotId = registry.snapshotId as string;
      const source = registry.resolutions as Array<Record<string, unknown>>;
      return {
        status: "authenticated" as const,
        snapshotId,
        resolutions: source.map((resolution) => {
          const common = {
            snapshotId: resolution.snapshotId as string,
            ref: structuredClone(resolution.ref) as PaymentRailRef,
          };
          if (resolution.status === "verified") {
            return {
              ...common,
              status: "verified" as const,
              definition: structuredClone(
                resolution.definition,
              ) as AlternativeRailDefinition,
            };
          }
          return {
            ...common,
            status: resolution.status as "unavailable" | "absent" | "invalid",
            reason: "not verified",
          };
        }),
      };
    },
    authenticateDefinition: (definition: Readonly<AlternativeRailDefinition>) =>
      verifySignature(
        definition,
        definition.signature,
        vector.keys.steward!,
        "dacs-rail:v1:",
        registry.stewardClaim as string,
      )
        ? ({ status: "authenticated" } as const)
        : ({ status: "invalid", reason: "signature" } as const),
    supportedHandlers: structuredClone(
      runtime.supportedHandlers,
    ) as PaymentPhaseType[],
    supportsPayAlternative: runtime.readerSupportsPayAlternative !== false,
  };
}

function priorDeps(vector: MaterializedVector) {
  const context = vector.runtime.priorPaymentContext as
    | Record<string, unknown>
    | null;
  const resolution = context?.resolution as Record<string, unknown> | undefined;
  return {
    replacementClaimed: false,
    resolveDisposition: (_ref: Readonly<AttestationRef>) => {
      if (!context || resolution?.authorityAuthenticated !== true) {
        return { status: "indeterminate" as const, reason: "unavailable" };
      }
      return {
        status: "authenticated" as const,
        disposition: structuredClone(
          context.disposition,
        ) as PriorPaymentDisposition,
        receipt: {
          status: resolution.status as "finalized" | "included" | "unavailable",
          logicalAddress: resolution.logicalAddress as string,
          contentHash: resolution.contentHash as string,
          writer: resolution.writer as string,
          authorizationJournalClosed:
            resolution.authorizationJournalClosed as boolean,
        },
      };
    },
    resolvePriorAgreement: (_ref: Readonly<AttestationRef>) =>
      context
        ? {
            status: "authenticated" as const,
            agreement: structuredClone(
              context.agreement,
            ) as AlternativePaymentAgreementLike,
          }
        : { status: "indeterminate" as const, reason: "unavailable" },
    authenticatePriorAgreement: (
      agreement: Readonly<AlternativePaymentAgreementLike>,
    ) =>
      verifyAgreement(vector, agreement as AlternativePaymentAgreementLike)
        ? ({ status: "authenticated" } as const)
        : ({ status: "invalid", reason: "signature" } as const),
    authenticateDispositionSignature: (input: Readonly<{
      disposition: PriorPaymentDisposition;
      signedBytes: Uint8Array;
    }>) => {
      const signature = input.disposition.signature;
      try {
        return ed25519Verify(
          input.signedBytes,
          Buffer.from(signature.value, "base64url"),
          publicKeyFromRaw(Buffer.from(vector.keys.orchestrator!, "base64url")),
        );
      } catch {
        return false;
      }
    },
    resolvePriorExecutionAuthority: () => {
      const authority = context?.executionAuthority as
        | Record<string, unknown>
        | undefined;
      return authority?.status === "verified"
        ? {
            status: "authenticated" as const,
            phaseOrchestratorClaim: authority.phaseOrchestratorClaim as string,
          }
        : { status: "indeterminate" as const, reason: "unavailable" };
    },
    verifyTerminalReconciliation: () =>
      resolution?.reconciliationEvidenceVerified === true,
  };
}

function sessionProjectionDeps(vector: MaterializedVector) {
  return {
    productionMode: true,
    pinSelectedDefinition: (ref: Readonly<PaymentRailRef>) => {
      const resolutions = vector.registry.resolutions as Array<
        Record<string, unknown>
      >;
      const match = resolutions.find(
        (entry) => canonicalize(entry.ref) === canonicalize(ref),
      );
      if (!match || match.status !== "verified") {
        return { status: "indeterminate" as const, reason: "unavailable" };
      }
      return {
        status: "authenticated" as const,
        ref: structuredClone(match.ref) as PaymentRailRef,
        definition: structuredClone(
          match.definition,
        ) as AlternativeRailDefinition,
      };
    },
  };
}

async function evaluate(
  vector: MaterializedVector,
  effects = { walletAuthorizations: 0 },
): Promise<AlternativePaymentDecision> {
  const listing = await validateAlternativePaymentListing(
    vector.listing,
    listingDeps(vector),
  );
  if (listing.verdict !== "pass") return listing;
  if (vector.operation === "validate-listing") return { verdict: "pass" };

  const draft = vector.operation === "select-draft";
  const projected = await projectAlternativePaymentPipeline(
    listing,
    vector.agreement,
    {
      ...sessionProjectionDeps(vector),
      agreementState: draft ? "draft" : "signed",
      authenticateAgreement: (agreement) =>
        verifyAgreement(vector, agreement)
          ? { status: "authenticated" as const }
          : { status: "invalid" as const, reason: "signature" },
      claimedProjectedStep: vector.runtime.projectedStep,
      operatorPreflight: () => vector.runtime.operatorPreflightOk === true,
    },
  );
  if (projected.verdict !== "pass") return projected;
  if (draft) return { verdict: "pass" };

  if (vector.operation === "retry") {
    return validateAlternativePaymentRetry(projected, {
      ...(vector.runtime.requestedAlternative === null
        ? {}
        : {
            requestedAlternative: structuredClone(
              vector.runtime.requestedAlternative,
            ) as PaymentRailRef,
          }),
      authorizationState: vector.runtime.authorizationState as
        | "not-requested"
        | "submitted"
        | "indeterminate",
      reconciliation: structuredClone(vector.runtime.reconciliation) as {
        jobId: string;
        railRefHash: string;
        phaseIndex: number;
      },
    });
  }

  const replacement = await verifyPriorPaymentReplacement(
    projected,
    priorDeps(vector),
  );
  if (replacement.verdict !== "pass") return replacement;
  if (vector.operation === "validate-pipeline") return { verdict: "pass" };
  if (vector.operation === "verify-bundle") {
    return verifyAlternativePaymentAudit(projected, vector.bundle, {
      authenticateBundle: (bundle) => {
        const signatures = bundle.signatures;
        const parties = vector.agreement.parties as Array<Record<string, unknown>>;
        if (!Array.isArray(signatures) || !Array.isArray(parties)) {
          return { status: "invalid" as const, reason: "shape" };
        }
        const claims = Object.fromEntries(
          parties.map((party) => [party.role, party.primaryClaim]),
        );
        const valid = (["buyer", "seller"] as const).every((role) => {
          const signature = signatures.find(
            (entry) =>
              entry !== null &&
              typeof entry === "object" &&
              !Array.isArray(entry) &&
              (entry as Record<string, unknown>).party === claims[role],
          );
          return verifySignature(
            bundle,
            signature,
            vector.keys[role]!,
            "dacs-evidence-bound-fault-bundle:v1:",
            undefined,
            ["anchoredByRole"],
          );
        });
        return valid
          ? { status: "authenticated" as const }
          : { status: "invalid" as const, reason: "signature" };
      },
    });
  }
  if (vector.operation === "execute") {
    await authorizeAlternativePayment(
      {
        projection: projected,
        replacement,
      },
      () => {
        effects.walletAuthorizations += 1;
      },
    );
    return { verdict: "pass" };
  }
  return { verdict: "error", reason: "unsupported-operation" };
}

async function authenticatedGates(vector: MaterializedVector): Promise<{
  projection: AlternativePaymentProjection;
  replacement: PriorPaymentReplacementAdmission;
}> {
  const listing = await validateAlternativePaymentListing(
    vector.listing,
    listingDeps(vector),
  );
  if (listing.verdict !== "pass") throw new Error(listing.reason);
  const projection = await projectAlternativePaymentPipeline(
    listing,
    vector.agreement,
    {
      ...sessionProjectionDeps(vector),
      agreementState: "signed",
      authenticateAgreement: (agreement) =>
        verifyAgreement(vector, agreement)
          ? { status: "authenticated" as const }
          : { status: "invalid" as const, reason: "signature" },
      claimedProjectedStep: vector.runtime.projectedStep,
      operatorPreflight: () => vector.runtime.operatorPreflightOk === true,
    },
  );
  if (projection.verdict !== "pass") throw new Error(projection.reason);
  const replacement = await verifyPriorPaymentReplacement(
    projection,
    priorDeps(vector),
  );
  if (replacement.verdict !== "pass") throw new Error(replacement.reason);
  return { projection, replacement };
}

describe("DACS-4 APR-1..APR-8 alternative payment projection", () => {
  test("pins the exact merged Standard #344 fixture", () => {
    expect(fixture.set).toBe("alternative-payment-projection-v0.1");
    expect(fixture.count).toBe(45);
    expect(fixture.vectors).toHaveLength(45);
    expect(fixture.hash).toBe(
      createHash("sha256").update(canonicalize(fixture.vectors)).digest("hex"),
    );
    expect(createHash("sha256").update(fixtureBytes).digest("hex")).toBe(
      "73be437c15210ae57c0ad62a8e02fc70f37bface5da15cf207f9b88964aa5ca3",
    );
  });

  for (const vector of vectors) {
    test(`replays ${vector.name}`, async () => {
      const result = await evaluate(vector);
      expect(result.verdict, `${vector.name}: ${result.reason ?? "no reason"}`).toBe(
        vector.expected,
      );
      if (vector.expectedReason) expect(result.reason).toBe(vector.expectedReason);
    });
  }

  test("all non-pass paths make zero wallet authorization calls", async () => {
    for (const vector of vectors) {
      const effects = { walletAuthorizations: 0 };
      const result = await evaluate(vector, effects);
      if (result.verdict !== "pass") {
        expect(effects.walletAuthorizations, vector.name).toBe(0);
      }
    }
  });

  test("rejects dependency accessors before inspecting caller Listing accessors", async () => {
    let dependencyGetterCalls = 0;
    let listingGetterCalls = 0;
    const listing = structuredClone(vectors[0]!.listing) as unknown as Record<
      string,
      unknown
    >;
    Object.defineProperty(listing, "listingId", {
      enumerable: true,
      get() {
        listingGetterCalls += 1;
        return "apr-340";
      },
    });
    const deps = listingDeps(vectors[0]!);
    Object.defineProperty(deps, "authenticateListing", {
      enumerable: true,
      get() {
        dependencyGetterCalls += 1;
        return () => ({ status: "authenticated" as const });
      },
    });
    await expect(
      validateAlternativePaymentListing(
        listing as unknown as AlternativePaymentListingLike,
        deps,
      ),
    ).resolves.toMatchObject({
      verdict: "error",
      reason: "listing-dependencies-malformed",
    });
    expect(dependencyGetterCalls).toBe(0);
    expect(listingGetterCalls).toBe(0);
  });

  test("only successful execute cases authorize exactly once", async () => {
    for (const vector of vectors) {
      const effects = { walletAuthorizations: 0 };
      const result = await evaluate(vector, effects);
      const expected = Number(
        result.verdict === "pass" && vector.operation === "execute",
      );
      expect(effects.walletAuthorizations, vector.name).toBe(expected);
    }
  });

  test("derives an unsigned payee-bound Agreement against the original signed Listing pin", async () => {
    const now = 1_780_000_000_000;
    const buyerClaim = `did:demos:agent:${"1".repeat(64)}`;
    const sellerClaim = `did:demos:agent:${"2".repeat(64)}`;
    const identity = (presentedBy: string): IdentityBundle => ({
      bundleVersion: "1",
      presentedBy,
      presentedAt: now - 1_000,
      claims: [{ ref: presentedBy }],
      presentation: {
        kind: "per-claim",
        signatures: [{ ref: presentedBy, signature: "identity-proof" }],
      },
    });
    const dem: PaymentRailRef = {
      railId: "demos-native:DEM",
      railVersion: 1,
    };
    const x402: PaymentRailRef = {
      railId: "x402:default",
      railVersion: 1,
      parameters: { resource: "https://seller.example/pay" },
    };
    const listing: Listing = {
      dacsVersion: "1",
      listingVersion: 1,
      listingId: "alternative-producer",
      seller: {
        identity: identity(sellerClaim),
        displayName: "Alternative seller",
        publicEndpoint: "https://seller.example/dacs",
      },
      offering: {
        title: "Alternative product",
        description: "One product with two payment options",
        category: "data.test",
        tags: ["alternative-payment"],
        deliverable: {
          kind: "storage-program",
        },
      },
      buyerRequirement: { requirementVersion: "1", required: [] },
      pipeline: [
        { kind: "negotiate-fixed-price" },
        { kind: "commit-payee-bound-agreement" },
        {
          kind: "pay-alternative",
          parameters: { alternatives: [dem, x402] },
        },
        { kind: "deliver-storage-program" },
      ],
      pricing: { kind: "fixed", price: { amount: "1", currency: "DEM" } },
      acceptedRails: [dem, x402],
      terms: { deadlineSecAfterCommit: 600 },
      validity: { notBefore: now - 1_000, notAfter: now + 1_000_000 },
      signature: {
        algorithm: "ed25519",
        signer: sellerClaim,
        value: Buffer.alloc(64, 7).toString("base64url"),
      },
    };
    const admission = await validateAlternativePaymentListing(
      listing as unknown as AlternativePaymentListingLike,
      {
      authenticateListing: () => ({ status: "authenticated" }),
      resolveRegistry: () => ({
        status: "authenticated",
        snapshotId: "registry-1",
        resolutions: [
          {
            status: "verified",
            snapshotId: "registry-1",
            ref: dem,
            definition: {
              railId: dem.railId,
              railVersion: 1,
              phaseHandler: "pay-dem",
              availability: "live",
            },
          },
          {
            status: "verified",
            snapshotId: "registry-1",
            ref: x402,
            definition: {
              railId: x402.railId,
              railVersion: 1,
              phaseHandler: "pay-x402",
              availability: "live",
            },
          },
        ],
      }),
      authenticateDefinition: () => ({ status: "authenticated" }),
        supportedHandlers: ["pay-dem", "pay-x402"],
      },
    );
    expect(admission.verdict).toBe("pass");
    if (admission.verdict !== "pass") throw new Error("listing not admitted");

    const pin = {
      listingId: listing.listingId,
      version: listing.listingVersion,
      contentHash: contentHash(listing as unknown as Record<string, unknown>),
    };
    const pinSelectedDefinition = (ref: Readonly<PaymentRailRef>) => ({
      status: "authenticated" as const,
      ref: structuredClone(ref),
      definition:
        ref.railId === dem.railId
          ? {
              railId: dem.railId,
              railVersion: 1,
              phaseHandler: "pay-dem",
              availability: "live",
            }
          : {
              railId: x402.railId,
              railVersion: 1,
              phaseHandler: "pay-x402",
              availability: "live",
            },
    });
    const result = await deriveAlternativeFixedPriceAgreement(
      admission,
      {
        jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7E",
        verifiedListing: { disposition: "verified", listing, pin },
        buyer: {
          identityBundle: identity(buyerClaim),
          vetRecordRef: {
            anchor: { kind: "storage-program", locator: "buyer-vet" },
            contentHash: "a".repeat(64),
          },
        },
        seller: {
          identityBundle: identity(sellerClaim),
          vetRecordRef: {
            anchor: { kind: "storage-program", locator: "seller-vet" },
            contentHash: "b".repeat(64),
          },
        },
        selectedRail: dem,
        payoutBindings: [
          { railId: dem.railId, phaseIndex: 2, payeeAddress: sellerClaim },
        ],
        generatedAt: now,
      },
      { productionMode: true, pinSelectedDefinition },
    );

    expect(result.verdict, "reason" in result ? result.reason : undefined).toBe(
      "pass",
    );
    if (result.verdict !== "pass") throw new Error(result.reason);
    expect(result.agreement.listingRef).toEqual(pin);
    expect(result.agreement.terms.rail).toEqual(dem);
    expect(result.projection.effectivePipeline[2]).toEqual({
      kind: "pay-dem",
      parameters: { rail: dem.railId },
    });
    expect(listing.pipeline[2]?.kind).toBe("pay-alternative");
    expect("signatures" in result.agreement).toBe(false);

    const signed = await signFixedPriceAgreement(
      result.agreement as UnsignedAgreementArtifact,
      {
        party: buyerClaim,
        algorithm: "ed25519",
        sign: () => new Uint8Array(64),
      },
      {
        party: sellerClaim,
        algorithm: "ed25519",
        sign: () => new Uint8Array(64),
      },
    );
    const signedProjection = await projectAlternativePaymentPipeline(
      admission,
      signed as unknown as AlternativePaymentAgreementLike,
      {
        agreementState: "signed",
        productionMode: true,
        pinSelectedDefinition,
        authenticateAgreement: () => ({ status: "authenticated" }),
      },
    );
    expect(signedProjection.verdict).toBe("pass");
    if (signedProjection.verdict !== "pass") {
      throw new Error(signedProjection.reason);
    }
    const replacement = await verifyPriorPaymentReplacement(signedProjection, {
      replacementClaimed: false,
      resolveDisposition: () => ({
        status: "indeterminate",
        reason: "not used",
      }),
      resolvePriorAgreement: () => ({
        status: "indeterminate",
        reason: "not used",
      }),
      authenticatePriorAgreement: () => ({
        status: "indeterminate",
        reason: "not used",
      }),
      authenticateDispositionSignature: () => false,
      resolvePriorExecutionAuthority: () => ({
        status: "indeterminate",
        reason: "not used",
      }),
      verifyTerminalReconciliation: () => false,
    });
    expect(replacement.verdict).toBe("pass");
    if (replacement.verdict !== "pass") throw new Error(replacement.reason);
    expect(() =>
      validateFixedPriceAgreementBinding({
        agreement: signed,
        verifiedListing: { disposition: "verified", listing, pin },
        committedAt: now,
      }),
    ).toThrow(/authenticated APR projection/);
    expect(
      validateFixedPriceAgreementBinding({
        agreement: signed,
        verifiedListing: { disposition: "verified", listing, pin },
        committedAt: now,
        alternativePayment: { projection: signedProjection, replacement },
      }).agreementHash,
    ).toBe(contentHash(signed as unknown as Record<string, unknown>));
  });

  test("forged projection/replacement objects cannot reach a wallet", async () => {
    let calls = 0;
    await expect(
      authorizeAlternativePayment(
        {
          projection: {
            verdict: "pass",
          } as AlternativePaymentProjection,
          replacement: {
            verdict: "pass",
            mode: "independent",
          } as PriorPaymentReplacementAdmission,
        },
        () => {
          calls += 1;
        },
      ),
    ).rejects.toThrow(/authenticated APR projection/);
    expect(calls).toBe(0);
  });

  test("a replacement approval cannot be paired with another fresh-job projection", async () => {
    const first = await authenticatedGates(
      vectors.find(
        (vector) => vector.name === "post-signature-switch-with-fresh-job",
      )!,
    );
    const second = await authenticatedGates(
      vectors.find(
        (vector) => vector.name === "fresh-job-after-conclusive-no-settlement",
      )!,
    );
    let calls = 0;
    await expect(
      authorizeAlternativePayment(
        { projection: second.projection, replacement: first.replacement },
        () => {
          calls += 1;
        },
      ),
    ).rejects.toThrow(/authenticated APR projection/);
    expect(calls).toBe(0);
  });

  test("durably closes the exact old authorization tuple before signing a closure disposition", async () => {
    const vector = vectors.find(
      (entry) => entry.name === "post-signature-switch-with-fresh-job",
    )!;
    const context = vector.runtime.priorPaymentContext as Record<string, unknown>;
    const disposition = structuredClone(
      context.disposition,
    ) as PriorPaymentDisposition;
    const { signature: _signature, ...unsigned } = disposition;
    let closed = false;
    let signCalls = 0;
    const built = await buildPriorPaymentDisposition(
      unsigned,
      {
        algorithm: "ed25519",
        signer: disposition.signature.signer,
        sign: () => {
          expect(closed).toBe(true);
          signCalls += 1;
          return new Uint8Array(64);
        },
      },
      {
        closeBeforeAuthorization: (tuple) => {
          closed = true;
          return {
            status: "closed",
            ...tuple,
            authorizationJournalClosed: true,
          };
        },
        verifyCannotSettle: () => false,
      },
    );
    expect(signCalls).toBe(1);
    expect(built.signature.value).toBe(Buffer.alloc(64).toString("base64url"));

    let unsafeSignCalls = 0;
    await expect(
      buildPriorPaymentDisposition(
        unsigned,
        {
          algorithm: "ed25519",
          signer: disposition.signature.signer,
          sign: () => {
            unsafeSignCalls += 1;
            return new Uint8Array(64);
          },
        },
        {
          closeBeforeAuthorization: (tuple) => ({
            status: "indeterminate",
            ...tuple,
            authorizationJournalClosed: false,
          }),
          verifyCannotSettle: () => false,
        },
      ),
    ).rejects.toThrow(/not durably closed/);
    expect(unsafeSignCalls).toBe(0);
  });
});
