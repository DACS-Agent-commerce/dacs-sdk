import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  advanceFixedPriceAgreementDurable,
  canonicalize,
  contentHash,
  createFixedPriceAgreementSignatureContribution,
  createFixedPriceAgreementSigningPlan,
  createFsFencedSessionStore,
  createInMemoryFencedSessionStore,
  deriveFixedPriceAgreement,
  ed25519Sign,
  ed25519Verify,
  fixedPriceAgreementLogicalAddress,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
  type AnchorBinding,
  type AnchorReceipt,
  type AttestationRef,
  type DurableFixedPriceAgreementDurability,
  type DurableFixedPriceAgreementInput,
  type FixedPriceAgreementEffectFence,
  type FixedPriceAgreementProposal,
  type FixedPriceAgreementResolution,
  type FixedPriceAgreementSignatureContribution,
  type IdentityBundle,
  type Listing,
  type PaymentRailRef,
} from "../../src/index.js";
import {
  advanceFixedPriceAgreementDurable as negotiateAdvanceFixedPriceAgreementDurable,
  fixedPriceAgreementLogicalAddress as negotiateFixedPriceAgreementLogicalAddress,
} from "../../src/negotiate/index.js";

const NOW = 1_781_000_000_000;
const BUYER_SEED = new Uint8Array(32).fill(101);
const SELLER_SEED = new Uint8Array(32).fill(102);
const claim = (seed: Uint8Array) =>
  `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const BUYER = claim(BUYER_SEED);
const SELLER = claim(SELLER_SEED);

function identity(primaryClaim: string): IdentityBundle {
  return {
    bundleVersion: "1",
    presentedBy: primaryClaim,
    presentedAt: NOW - 1_000,
    claims: [{ ref: primaryClaim }],
    presentation: {
      kind: "per-claim",
      signatures: [{ ref: primaryClaim, signature: "identity-proof" }],
    },
  };
}

function vetRef(role: string): AttestationRef {
  return {
    anchor: { kind: "storage-program", locator: `stor:${role}-vet` },
    contentHash: role === "buyer" ? "a".repeat(64) : "b".repeat(64),
  };
}

const rail: PaymentRailRef = {
  railId: "x402:base",
  railVersion: 1,
  parameters: { network: "eip155:8453" },
};

function listing(): Listing {
  return {
    dacsVersion: "1",
    listingVersion: 4,
    listingId: "durable-exchange-listing",
    seller: {
      identity: identity(SELLER),
      displayName: "Durable seller",
      publicEndpoint: "https://seller.example/dacs",
    },
    offering: {
      title: "Durably signed data",
      description: "One independently signed payload",
      category: "data.test",
      tags: ["test"],
      deliverable: {
        kind: "attested-payload",
        payloadFormat: "application/json",
        verificationMethod: { kind: "self-signed" },
      },
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-agreement" },
      { kind: "pay-x402", parameters: { rail: rail.railId } },
      { kind: "deliver-attested-payload" },
    ],
    pricing: { kind: "fixed", price: { amount: "2", currency: "USDC" } },
    acceptedRails: [rail],
    terms: { deadlineSecAfterCommit: 600 },
    validity: { notBefore: NOW - 10_000, notAfter: NOW + 1_000_000 },
    signature: {
      algorithm: "ed25519",
      signer: SELLER,
      value: Buffer.alloc(64, 3).toString("base64url"),
    },
  };
}

function draft(jobId = "job-durable-agreement") {
  const value = listing();
  return deriveFixedPriceAgreement({
    jobId,
    verifiedListing: {
      disposition: "verified",
      listing: value,
      pin: {
        listingId: value.listingId,
        version: value.listingVersion,
        contentHash: contentHash(value as unknown as Record<string, unknown>),
      },
    },
    buyer: { identityBundle: identity(BUYER), vetRecordRef: vetRef("buyer") },
    seller: { identityBundle: identity(SELLER), vetRecordRef: vetRef("seller") },
    selectedRail: rail,
    generatedAt: NOW,
  });
}

function receipt(
  logicalAddress: string,
  nativeAddress: string,
  agreementHash: string,
): AnchorReceipt {
  return {
    receiptVersion: "1",
    substrate: "test-storage",
    finalityProfile: "test-final",
    logicalAddress,
    nativeAddress,
    contentHash: agreementHash,
    transactionRef: { kind: "storage-program", value: `tx:${nativeAddress}` },
    writer: BUYER,
    state: "finalized",
    observationDisposition: "established",
    observedAt: NOW,
    blockRef: { id: "block-1", height: "1", timestamp: NOW },
    evidence: { kind: "test-proof", value: `proof:${nativeAddress}` },
  };
}

type Effect = "signature" | "proposal" | "anchor" | "binding";

interface HarnessState {
  signature?: Uint8Array | string;
  proposal?: FixedPriceAgreementProposal;
  anchor?: {
    artifact: Record<string, unknown>;
    ref: AttestationRef;
    anchorReceipt: AnchorReceipt;
  };
  binding?: AnchorBinding;
  sellerResolution: FixedPriceAgreementResolution<unknown>;
  proposalReconciliation?: FixedPriceAgreementResolution<unknown>;
  anchorReconciliation?: FixedPriceAgreementResolution<unknown>;
  verifySellerDisposition?: "valid" | "invalid" | "indeterminate" | "error";
  receiptDisposition?: "valid" | "invalid" | "indeterminate" | "error";
  tamperAnchor?: (value: NonNullable<HarnessState["anchor"]>) => unknown;
  lost: Set<Effect>;
  failBeforeStore: Set<Effect>;
  calls: Record<Effect, number>;
  fences: Record<Effect, FixedPriceAgreementEffectFence[]>;
}

async function harness(options: {
  binding?: boolean;
  jobId?: string;
  store?: ReturnType<typeof createInMemoryFencedSessionStore>;
} = {}) {
  const agreementDraft = draft(options.jobId);
  const plan = createFixedPriceAgreementSigningPlan(agreementDraft);
  const seller = await createFixedPriceAgreementSignatureContribution(
    plan,
    "seller",
    {
      party: SELLER,
      algorithm: "ed25519",
      sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)),
    },
  );
  const state: HarnessState = {
    sellerResolution: { disposition: "present", value: [seller] },
    lost: new Set(),
    failBeforeStore: new Set(),
    calls: { signature: 0, proposal: 0, anchor: 0, binding: 0 },
    fences: { signature: [], proposal: [], anchor: [], binding: [] },
  };
  const store = options.store ?? createInMemoryFencedSessionStore();
  const input: DurableFixedPriceAgreementInput = {
    draft: agreementDraft,
    buyer: {
      party: BUYER,
      algorithm: "ed25519",
      sign: (bytes, _context, fence) => {
        state.calls.signature += 1;
        state.fences.signature.push(structuredClone(fence));
        if (state.failBeforeStore.delete("signature")) {
          throw new Error("signature failed before durable result");
        }
        const value = ed25519Sign(bytes, privateKeyFromSeed(BUYER_SEED));
        state.signature = Uint8Array.from(value);
        if (state.lost.delete("signature")) throw new Error("lost signature response");
        return value;
      },
    },
  };

  const verifyContribution: DurableFixedPriceAgreementDurability["verifyContribution"] =
    ({ role, value, signedBytes }) => {
      if (role === "seller" && state.verifySellerDisposition) {
        return state.verifySellerDisposition;
      }
      const key = role === "buyer"
        ? publicKeyFromSeed(BUYER_SEED)
        : publicKeyFromSeed(SELLER_SEED);
      return ed25519Verify(
        signedBytes,
        Uint8Array.from(Buffer.from(value, "base64url")),
        key,
      ) ? "valid" : "invalid";
    };

  const anchor = {
    anchorAgreement: (
      value: {
        logicalAddress: string;
        agreementHash: string;
        artifact: Record<string, unknown>;
      },
      fence: FixedPriceAgreementEffectFence,
    ) => {
      state.calls.anchor += 1;
      state.fences.anchor.push(structuredClone(fence));
      if (state.failBeforeStore.delete("anchor")) {
        throw new Error("anchor failed before durable result");
      }
      const nativeAddress = `stor:agreement:${plan.planHash.slice(0, 16)}`;
      state.anchor = {
        artifact: structuredClone(value.artifact),
        ref: {
          anchor: { kind: "storage-program" as const, locator: value.logicalAddress },
          contentHash: value.agreementHash,
          signer: BUYER,
        },
        anchorReceipt: receipt(value.logicalAddress, nativeAddress, value.agreementHash),
      };
      if (state.lost.delete("anchor")) throw new Error("lost anchor response");
      return { disposition: "submitted" as const };
    },
    reconcileAgreementAnchor: () => {
      if (state.anchorReconciliation) {
        return structuredClone(state.anchorReconciliation);
      }
      if (!state.anchor) {
        return { disposition: "absent" as const, reason: "not anchored" };
      }
      return {
        disposition: "present" as const,
        value: state.tamperAnchor
          ? state.tamperAnchor(structuredClone(state.anchor))
          : structuredClone(state.anchor),
      };
    },
    verifyAnchorReceipt: () => state.receiptDisposition ?? "valid" as const,
    ...(options.binding
      ? {
          publishBinding: (value: AnchorBinding, fence: FixedPriceAgreementEffectFence) => {
            state.calls.binding += 1;
            state.fences.binding.push(structuredClone(fence));
            if (state.failBeforeStore.delete("binding")) {
              throw new Error("binding failed before durable result");
            }
            state.binding = structuredClone(value);
            if (state.lost.delete("binding")) throw new Error("lost binding response");
            return { disposition: "submitted" as const };
          },
          reconcileBindingPublication: (expected: AnchorBinding) =>
            state.binding
              ? { disposition: "present" as const, value: structuredClone(state.binding) }
              : { disposition: "absent" as const, reason: `missing ${expected.logicalAddress}` },
        }
      : {}),
  };

  const durability: DurableFixedPriceAgreementDurability = {
    store,
    workerId: "buyer-worker",
    leaseTtlMs: 60_000,
    leaseNowMs: () => NOW,
    reconcileBuyerSignature: () => state.signature
      ? {
          disposition: "present" as const,
          value: typeof state.signature === "string"
            ? state.signature
            : Uint8Array.from(state.signature),
        }
      : { disposition: "absent" as const, reason: "no signature" },
    verifyContribution,
    transport: {
      publishProposal: (proposal, _identity, fence) => {
        state.calls.proposal += 1;
        state.fences.proposal.push(structuredClone(fence));
        if (state.failBeforeStore.delete("proposal")) {
          throw new Error("proposal failed before durable result");
        }
        state.proposal = structuredClone(proposal);
        if (state.lost.delete("proposal")) throw new Error("lost proposal response");
        return { disposition: "submitted" as const };
      },
      reconcileProposalPublication: () => state.proposalReconciliation
        ? structuredClone(state.proposalReconciliation)
        : state.proposal
          ? { disposition: "present" as const, value: structuredClone(state.proposal) }
          : { disposition: "absent" as const, reason: "proposal not published" },
      resolveSellerContributions: () => structuredClone(state.sellerResolution),
    },
    anchor,
  };
  return { input, durability, state, store, plan, seller };
}

describe("durable buyer-owned fixed-price agreement exchange", () => {
  test("is exposed identically from root and negotiate public surfaces", () => {
    expect(negotiateAdvanceFixedPriceAgreementDurable).toBe(
      advanceFixedPriceAgreementDurable,
    );
    expect(negotiateFixedPriceAgreementLogicalAddress).toBe(
      fixedPriceAgreementLogicalAddress,
    );
  });

  test("binds, signs, exchanges, anchors, authenticates, and recovers exact bytes once", async () => {
    const h = await harness({ binding: true });
    const first = await advanceFixedPriceAgreementDurable(h.input, h.durability);
    expect(first.disposition).toBe("anchored");
    if (first.disposition !== "anchored") return;
    expect(first.recovered).toBe(false);
    expect(first.result.agreementHash).toBe(h.plan.agreementHash);
    expect(first.result.agreementRef).toEqual({
      anchor: {
        kind: "storage-program",
        locator: fixedPriceAgreementLogicalAddress(h.input.draft.jobId),
      },
      contentHash: h.plan.agreementHash,
      signer: BUYER,
    });
    expect(first.result.binding?.nativeAddress).toBe(first.result.anchorReceipt.nativeAddress);
    expect(h.state.calls).toEqual({ signature: 1, proposal: 1, anchor: 1, binding: 1 });

    const recovered = await advanceFixedPriceAgreementDurable(h.input, h.durability);
    expect(recovered).toEqual({ ...first, recovered: true });
    expect(h.state.calls).toEqual({ signature: 1, proposal: 1, anchor: 1, binding: 1 });

    const loaded = await h.store.load(h.input.draft.jobId);
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") {
      expect(loaded.record.agreementHash).toBe(h.plan.agreementHash);
      expect(loaded.record.phase).toBe("agreement:anchored");
      expect(loaded.record.lease).toBeUndefined();
      expect(loaded.record.receipts).toHaveLength(1);
      expect(loaded.record.checkpoints.filter((value) => value.stage === "intent")).toHaveLength(7);
      expect(loaded.record.checkpoints.filter((value) => value.stage === "outcome")).toHaveLength(7);
    }
  });

  test("cold filesystem restart recovers the same bytes without duplicate effects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dacs-durable-agreement-"));
    try {
      const h = await harness({
        binding: true,
        store: await createFsFencedSessionStore({ dir }),
      });
      const first = await advanceFixedPriceAgreementDurable(h.input, h.durability);
      expect(first.disposition).toBe("anchored");
      h.durability.store = await createFsFencedSessionStore({ dir });
      const recovered = await advanceFixedPriceAgreementDurable(h.input, h.durability);
      expect(recovered).toEqual(
        first.disposition === "anchored" ? { ...first, recovered: true } : first,
      );
      expect(h.state.calls).toEqual({ signature: 1, proposal: 1, anchor: 1, binding: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.each<Effect>(["signature", "proposal", "anchor", "binding"])(
    "lost %s response reconciles without duplicate effect",
    async (effect) => {
      const h = await harness({ binding: true });
      h.state.lost.add(effect);
      const interrupted = await advanceFixedPriceAgreementDurable(h.input, h.durability);
      expect(interrupted.disposition).toBe("indeterminate");
      const completed = await advanceFixedPriceAgreementDurable(h.input, h.durability);
      expect(completed.disposition).toBe("anchored");
      expect(h.state.calls[effect]).toBe(1);
      expect(new Set(h.state.fences[effect].map((fence) => fence.idempotencyKey)).size).toBe(1);
    },
  );

  test("authoritative absence redrives exact bytes with a stable key across generations", async () => {
    const h = await harness();
    h.state.failBeforeStore.add("signature");
    const interrupted = await advanceFixedPriceAgreementDurable(h.input, h.durability);
    expect(interrupted).toMatchObject({
      disposition: "indeterminate",
      stage: "buyer-signature",
    });
    const completed = await advanceFixedPriceAgreementDurable(h.input, h.durability);
    expect(completed.disposition).toBe("anchored");
    expect(h.state.calls.signature).toBe(2);
    expect(h.state.fences.signature[0]?.generation).not.toBe(
      h.state.fences.signature[1]?.generation,
    );
    expect(h.state.fences.signature[0]?.idempotencyKey).toBe(
      h.state.fences.signature[1]?.idempotencyKey,
    );
  });

  test("a live stale generation fences concurrent work; expiry mints a new generation", async () => {
    const h = await harness();
    let now = NOW;
    h.durability.leaseNowMs = () => now;
    await h.store.create({
      jobId: h.input.draft.jobId,
      agreementHash: h.plan.agreementHash,
      phase: "agreement:plan-binding",
      now,
    });
    const stale = await h.store.acquireLease({
      jobId: h.input.draft.jobId,
      owner: "stale-worker",
      ttlMs: 10,
      now,
    });
    expect(stale.ok).toBe(true);
    const blocked = await advanceFixedPriceAgreementDurable(h.input, h.durability);
    expect(blocked).toMatchObject({ disposition: "waiting", stage: "lease" });
    expect(h.state.calls.signature).toBe(0);
    now += 11;
    const completed = await advanceFixedPriceAgreementDurable(h.input, h.durability);
    expect(completed.disposition).toBe("anchored");
    expect(h.state.fences.signature[0]?.generation).toBe(2);
  });

  test("missing, duplicate, substituted, and unresolved seller signatures fail closed", async () => {
    const missing = await harness();
    missing.state.sellerResolution = { disposition: "absent", reason: "seller pending" };
    expect(await advanceFixedPriceAgreementDurable(missing.input, missing.durability)).toMatchObject({
      disposition: "waiting",
      stage: "seller-contribution",
    });
    expect(missing.state.calls.anchor).toBe(0);

    const empty = await harness();
    empty.state.sellerResolution = { disposition: "present", value: [] };
    expect(await advanceFixedPriceAgreementDurable(empty.input, empty.durability)).toMatchObject({
      disposition: "waiting",
      stage: "seller-contribution",
    });

    const duplicate = await harness();
    duplicate.state.sellerResolution = {
      disposition: "present",
      value: [duplicate.seller, duplicate.seller],
    };
    expect(await advanceFixedPriceAgreementDurable(duplicate.input, duplicate.durability)).toMatchObject({
      disposition: "rejected",
      stage: "seller-contribution",
    });

    const substituted = await harness();
    const otherPlan = createFixedPriceAgreementSigningPlan(draft("other-job"));
    const otherSeller = await createFixedPriceAgreementSignatureContribution(
      otherPlan,
      "seller",
      {
        party: SELLER,
        algorithm: "ed25519",
        sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)),
      },
    );
    substituted.state.sellerResolution = { disposition: "present", value: [otherSeller] };
    expect(
      await advanceFixedPriceAgreementDurable(substituted.input, substituted.durability),
    ).toMatchObject({ disposition: "rejected", stage: "seller-contribution" });

    const unresolved = await harness();
    unresolved.state.verifySellerDisposition = "indeterminate";
    expect(await advanceFixedPriceAgreementDurable(unresolved.input, unresolved.durability)).toMatchObject({
      disposition: "indeterminate",
      stage: "seller-contribution",
    });
  });

  test("transport absent, rejected, and indeterminate states remain distinct", async () => {
    const proposalIndeterminate = await harness();
    proposalIndeterminate.state.proposalReconciliation = {
      disposition: "indeterminate",
      reason: "transport unavailable",
    };
    expect(
      await advanceFixedPriceAgreementDurable(
        proposalIndeterminate.input,
        proposalIndeterminate.durability,
      ),
    ).toMatchObject({
      disposition: "indeterminate",
      stage: "proposal-publication",
    });
    expect(proposalIndeterminate.state.calls.proposal).toBe(0);

    const sellerRejected = await harness();
    sellerRejected.state.sellerResolution = {
      disposition: "rejected",
      reason: "seller rejected exact plan",
    };
    expect(
      await advanceFixedPriceAgreementDurable(sellerRejected.input, sellerRejected.durability),
    ).toMatchObject({ disposition: "rejected", stage: "seller-contribution" });

    const sellerIndeterminate = await harness();
    sellerIndeterminate.state.sellerResolution = {
      disposition: "indeterminate",
      reason: "seller transport ambiguous",
    };
    expect(
      await advanceFixedPriceAgreementDurable(
        sellerIndeterminate.input,
        sellerIndeterminate.durability,
      ),
    ).toMatchObject({ disposition: "indeterminate", stage: "seller-contribution" });

    const anchorIndeterminate = await harness();
    anchorIndeterminate.state.anchorReconciliation = {
      disposition: "indeterminate",
      reason: "anchor lookup ambiguous",
    };
    expect(
      await advanceFixedPriceAgreementDurable(
        anchorIndeterminate.input,
        anchorIndeterminate.durability,
      ),
    ).toMatchObject({ disposition: "indeterminate", stage: "agreement-anchor" });
    expect(anchorIndeterminate.state.calls.anchor).toBe(0);
  });

  test("conflicting plan for the same job is rejected before another effect", async () => {
    const h = await harness();
    h.state.sellerResolution = { disposition: "absent", reason: "seller pending" };
    expect((await advanceFixedPriceAgreementDurable(h.input, h.durability)).disposition).toBe(
      "waiting",
    );
    const conflicting: DurableFixedPriceAgreementInput = {
      ...h.input,
      draft: { ...draft(h.input.draft.jobId), generatedAt: NOW + 1 },
    };
    await expect(
      advanceFixedPriceAgreementDurable(conflicting, h.durability),
    ).rejects.toThrow(/conflicting plan/i);
    expect(h.state.calls.signature).toBe(1);
  });

  test("hostile accessors, proxies, and hidden seller authority are rejected before effects", async () => {
    const h = await harness();
    let getterCalls = 0;
    const hostileDraft = structuredClone(h.input.draft) as Record<string, unknown>;
    Object.defineProperty(hostileDraft, "jobId", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return h.input.draft.jobId;
      },
    });
    await expect(
      advanceFixedPriceAgreementDurable(
        { ...h.input, draft: hostileDraft as never },
        h.durability,
      ),
    ).rejects.toThrow(/data property/i);
    expect(getterCalls).toBe(0);

    await expect(
      advanceFixedPriceAgreementDurable(
        {
          ...h.input,
          buyer: {
            ...h.input.buyer,
            sign: new Proxy(h.input.buyer.sign, {}),
          },
        },
        h.durability,
      ),
    ).rejects.toThrow(/non-proxy callable/i);

    await expect(
      advanceFixedPriceAgreementDurable(h.input, {
        ...h.durability,
        transport: new Proxy(h.durability.transport, {}),
      }),
    ).rejects.toThrow(/cannot be a proxy/i);

    await expect(
      advanceFixedPriceAgreementDurable(h.input, {
        ...h.durability,
        sellerSigner: () => "forbidden",
      } as never),
    ).rejects.toThrow(/must contain exactly/i);
    expect(h.state.calls.signature).toBe(0);
  });

  test("substituted anchor bytes, writer, hash, or unauthenticated receipt never complete", async () => {
    for (const tamper of [
      (value: NonNullable<HarnessState["anchor"]>) => ({
        ...value,
        artifact: { ...value.artifact, generatedAt: NOW + 1 },
      }),
      (value: NonNullable<HarnessState["anchor"]>) => ({
        ...value,
        ref: { ...value.ref, contentHash: "f".repeat(64) },
      }),
      (value: NonNullable<HarnessState["anchor"]>) => ({
        ...value,
        anchorReceipt: { ...value.anchorReceipt, writer: SELLER },
      }),
    ]) {
      const h = await harness();
      h.state.tamperAnchor = tamper;
      expect(await advanceFixedPriceAgreementDurable(h.input, h.durability)).toMatchObject({
        disposition: "rejected",
        stage: "agreement-anchor",
      });
    }
    const unauthenticated = await harness();
    unauthenticated.state.receiptDisposition = "invalid";
    expect(
      await advanceFixedPriceAgreementDurable(
        unauthenticated.input,
        unauthenticated.durability,
      ),
    ).toMatchObject({ disposition: "rejected", stage: "agreement-anchor" });
  });

  test("two concurrent callers produce one effect set", async () => {
    const h = await harness();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = h.input.buyer.sign;
    h.input.buyer.sign = async (bytes, context, fence) => {
      entered();
      await gate;
      return original(bytes, context, fence);
    };
    const first = advanceFixedPriceAgreementDurable(h.input, h.durability);
    await started;
    const second = await advanceFixedPriceAgreementDurable(h.input, {
      ...h.durability,
      workerId: "buyer-worker-2",
    });
    expect(second).toMatchObject({ disposition: "waiting", stage: "lease" });
    release();
    expect((await first).disposition).toBe("anchored");
    expect(h.state.calls).toEqual({ signature: 1, proposal: 1, anchor: 1, binding: 0 });
  });

  test("proposal bytes are the exact durable plan and buyer-owned contribution", async () => {
    const h = await harness();
    expect((await advanceFixedPriceAgreementDurable(h.input, h.durability)).disposition).toBe(
      "anchored",
    );
    expect(h.state.proposal?.plan).toEqual(h.plan);
    expect(h.state.proposal?.buyerContribution.role).toBe("buyer");
    expect(h.state.proposal?.buyerContribution.party).toBe(BUYER);
    expect(h.state.proposal?.proposalHash).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalize(h.state.proposal?.plan)).toBe(canonicalize(h.plan));
  });
});
