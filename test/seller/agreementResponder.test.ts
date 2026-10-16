import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import {
  canonicalize,
  contentHash,
  createFixedPriceAgreementSignatureContribution,
  createFixedPriceAgreementSigningPlan,
  createFsFencedSessionStore,
  createInMemoryFencedSessionStore,
  deriveFixedPriceAgreement,
  durableSellerFixedPriceAgreementCheckpointKey,
  ed25519Sign,
  ed25519Verify,
  finalizeFixedPriceAgreementContributions,
  isDurableSellerFixedPriceAgreementResponse,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
  respondToFixedPriceAgreementProposalDurable,
  sha256Hex,
  DacsError,
  SubstrateError,
  type AttestationRef,
  type DurableSellerFixedPriceAgreementDurability,
  type DurableSellerFixedPriceAgreementInput,
  type FixedPriceAgreementEffectSubmission,
  type FixedPriceAgreementInput,
  type FixedPriceAgreementProposal,
  type FixedPriceAgreementResolution,
  type FixedPriceAgreementSignatureContribution,
  type FixedPriceAgreementTransportIdentity,
  type FencedSessionStoreV2,
  type IdentityBundle,
  type Listing,
  type PaymentRailRef,
  type SellerFixedPriceAgreementEffectFence,
} from "../../src/index.js";
import {
  respondToFixedPriceAgreementProposalDurable as sellerRespond,
} from "../../src/seller/index.js";

const NOW = 1_781_500_000_000;
const BUYER_SEED = new Uint8Array(32).fill(111);
const SELLER_SEED = new Uint8Array(32).fill(112);
const OTHER_SELLER_SEED = new Uint8Array(32).fill(113);
const claim = (seed: Uint8Array) =>
  `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const BUYER = claim(BUYER_SEED);
const SELLER = claim(SELLER_SEED);
const OTHER_SELLER = claim(OTHER_SELLER_SEED);
const JOB_ID = "01J8N4YV7YVYQ4DB7M8T4C7W0A";
const PAYEE_JOB_ID = "01J8N4YV7YVYQ4DB7M8T4C7W0B";
const SUBSTITUTE_JOB_ID = "01J8N4YV7YVYQ4DB7M8T4C7W0C";

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

function listing(payeeBound = false): Listing {
  return {
    dacsVersion: "1",
    listingVersion: 4,
    listingId: payeeBound
      ? "seller-responder-payee-bound"
      : "seller-responder-listing",
    seller: {
      identity: identity(SELLER),
      displayName: "Independent seller",
      publicEndpoint: "https://seller.example/dacs",
    },
    offering: {
      title: "Independently signed result",
      description: "A seller-local agreement response",
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
      { kind: payeeBound ? "commit-payee-bound-agreement" : "commit-agreement" },
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

function agreementContext(
  jobId = JOB_ID,
  payeeBound = false,
): FixedPriceAgreementInput {
  const exactListing = listing(payeeBound);
  return {
    jobId,
    verifiedListing: {
      disposition: "verified",
      listing: exactListing,
      pin: {
        listingId: exactListing.listingId,
        version: exactListing.listingVersion,
        contentHash: contentHash(exactListing as unknown as Record<string, unknown>),
      },
    },
    buyer: { identityBundle: identity(BUYER), vetRecordRef: vetRef("buyer") },
    seller: { identityBundle: identity(SELLER), vetRecordRef: vetRef("seller") },
    selectedRail: structuredClone(rail),
    ...(payeeBound
      ? {
          payoutBindings: [{
            railId: rail.railId,
            phaseIndex: 2,
            payeeAddress: `0x${"22".repeat(20)}`,
          }],
        }
      : {}),
    generatedAt: NOW,
  };
}

async function requestForDraft(
  draft: ReturnType<typeof deriveFixedPriceAgreement>,
  algorithm: "ed25519" | "ecdsa-secp256k1" = "ed25519",
): Promise<{
  input: DurableSellerFixedPriceAgreementInput;
  plan: ReturnType<typeof createFixedPriceAgreementSigningPlan>;
  buyerContribution: Readonly<FixedPriceAgreementSignatureContribution>;
}> {
  const plan = createFixedPriceAgreementSigningPlan(draft);
  const buyerContribution = await createFixedPriceAgreementSignatureContribution(
    plan,
    "buyer",
    {
      party: BUYER,
      algorithm,
      sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(BUYER_SEED)),
    },
  );
  const material = {
    proposalVersion: "1" as const,
    plan,
    buyerContribution,
  };
  const proposal: FixedPriceAgreementProposal = {
    ...material,
    proposalHash: sha256Hex(canonicalize(material)),
  };
  const buyer = plan.requiredSigners.find((entry) => entry.role === "buyer")!.party;
  const seller = plan.requiredSigners.find((entry) => entry.role === "seller")!.party;
  const transportIdentity: FixedPriceAgreementTransportIdentity = {
    jobId: draft.jobId,
    planHash: plan.planHash,
    agreementHash: plan.agreementHash,
    buyer,
    seller,
    proposalHash: proposal.proposalHash,
  };
  return {
    input: {
      proposal,
      transportIdentity,
      seller: {
        party: SELLER,
        algorithm: "ed25519",
        sign: () => {
          throw new Error("harness must install the local seller signer");
        },
      },
    },
    plan,
    buyerContribution,
  };
}

type Effect = "signature" | "publication";

interface HarnessState {
  signature?: Uint8Array | string;
  published?: FixedPriceAgreementSignatureContribution;
  contextResolution?: FixedPriceAgreementResolution<unknown>;
  signatureResolution?: FixedPriceAgreementResolution<Uint8Array | string>;
  publicationResolution?: FixedPriceAgreementResolution<unknown>;
  publicationSubmission?: FixedPriceAgreementEffectSubmission;
  lost: Set<Effect>;
  failBeforeStore: Set<Effect>;
  calls: {
    context: number;
    verifyBuyer: number;
    verifySeller: number;
    signature: number;
    publication: number;
  };
  fences: Record<Effect, SellerFixedPriceAgreementEffectFence[]>;
  signEntered?: () => void;
  signGate?: Promise<void>;
}

async function harness(options: {
  context?: FixedPriceAgreementInput;
  request?: Awaited<ReturnType<typeof requestForDraft>>;
  store?: FencedSessionStoreV2;
  workerId?: string;
} = {}) {
  const context = options.context ?? agreementContext();
  const request = options.request ?? await requestForDraft(deriveFixedPriceAgreement(context));
  const state: HarnessState = {
    lost: new Set(),
    failBeforeStore: new Set(),
    calls: {
      context: 0,
      verifyBuyer: 0,
      verifySeller: 0,
      signature: 0,
      publication: 0,
    },
    fences: { signature: [], publication: [] },
  };
  const store = options.store ?? createInMemoryFencedSessionStore();
  request.input.seller.sign = async (bytes, _context, fence) => {
    state.calls.signature += 1;
    state.fences.signature.push(structuredClone(fence));
    state.signEntered?.();
    if (state.signGate) await state.signGate;
    if (state.failBeforeStore.delete("signature")) {
      throw new Error("seller signer failed before retaining output");
    }
    const value = ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED));
    state.signature = Uint8Array.from(value);
    if (state.lost.delete("signature")) throw new Error("lost seller signer response");
    return value;
  };
  const durability: DurableSellerFixedPriceAgreementDurability = {
    store,
    workerId: options.workerId ?? "seller-worker-1",
    leaseTtlMs: 60_000,
    leaseNowMs: () => NOW,
    resolveAuthenticatedAgreementContext: () => {
      state.calls.context += 1;
      return state.contextResolution
        ? structuredClone(state.contextResolution) as never
        : { disposition: "present" as const, value: structuredClone(context) };
    },
    verifyContribution: ({ role, algorithm, value, signedBytes }) => {
      if (role === "buyer") state.calls.verifyBuyer += 1;
      else state.calls.verifySeller += 1;
      if (algorithm !== "ed25519") return "invalid";
      const key = role === "buyer"
        ? publicKeyFromSeed(BUYER_SEED)
        : publicKeyFromSeed(SELLER_SEED);
      return ed25519Verify(
        signedBytes,
        Uint8Array.from(Buffer.from(value, "base64url")),
        key,
      ) ? "valid" : "invalid";
    },
    reconcileSellerSignature: () => {
      if (state.signatureResolution) return structuredClone(state.signatureResolution);
      return state.signature
        ? {
            disposition: "present" as const,
            value: typeof state.signature === "string"
              ? state.signature
              : Uint8Array.from(state.signature),
          }
        : { disposition: "absent" as const, reason: "no retained seller signature" };
    },
    transport: {
      publishSellerContribution: (contribution, _identity, fence) => {
        state.calls.publication += 1;
        state.fences.publication.push(structuredClone(fence));
        if (state.failBeforeStore.delete("publication")) {
          throw new Error("publisher failed before retaining contribution");
        }
        state.published = structuredClone(contribution);
        if (state.lost.delete("publication")) throw new Error("lost publication response");
        return state.publicationSubmission ?? { disposition: "submitted" as const };
      },
      reconcileSellerContributionPublication: () => {
        if (state.publicationResolution) {
          return structuredClone(state.publicationResolution);
        }
        return state.published
          ? { disposition: "present" as const, value: structuredClone(state.published) }
          : { disposition: "absent" as const, reason: "not published" };
      },
    },
  };
  return { context, request, state, store, durability };
}

describe("durable seller fixed-price agreement proposal responder", () => {
  test("is exposed identically from root and seller public surfaces", () => {
    expect(sellerRespond).toBe(respondToFixedPriceAgreementProposalDurable);
  });

  test("independent buyer and seller agents assemble one exact agreement without cross-party authority", async () => {
    const h = await harness();
    const first = await respondToFixedPriceAgreementProposalDurable(
      h.request.input,
      h.durability,
    );
    expect(first.disposition).toBe("complete");
    if (first.disposition !== "complete") return;
    expect(first.recovered).toBe(false);
    expect(first.result.transportIdentity).toEqual(h.request.input.transportIdentity);
    expect(first.result.sellerContribution.role).toBe("seller");
    expect(first.result.sellerContribution.party).toBe(SELLER);
    expect(h.state.calls.signature).toBe(1);
    expect(h.state.calls.publication).toBe(1);

    const agreement = await finalizeFixedPriceAgreementContributions(
      h.request.plan,
      [h.request.buyerContribution, first.result.sellerContribution],
      h.durability.verifyContribution,
    );
    expect(contentHash(agreement as unknown as Record<string, unknown>)).toBe(
      h.request.plan.agreementHash,
    );
    expect(agreement.signatures.map((value) => value.party)).toEqual([BUYER, SELLER]);

    const replay = await respondToFixedPriceAgreementProposalDurable(
      h.request.input,
      h.durability,
    );
    expect(replay).toEqual({ ...first, recovered: true });
    expect(h.state.calls.signature).toBe(1);
    expect(h.state.calls.publication).toBe(1);

    const loaded = await h.store.load(h.context.jobId);
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") {
      expect(loaded.record.phase).toBe("agreement-responder:complete");
      expect(loaded.record.agreementHash).toBe(h.request.plan.agreementHash);
      expect(loaded.record.lease).toBeUndefined();
      expect(loaded.record.checkpoints.filter((value) => value.stage === "intent")).toHaveLength(4);
      expect(loaded.record.checkpoints.filter((value) => value.stage === "outcome")).toHaveLength(4);
      expect(loaded.record.checkpoints[0]?.key).toBe(
        durableSellerFixedPriceAgreementCheckpointKey.proposal,
      );
    }
  });

  test("cold filesystem restart authenticates and returns identical bytes without effects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dacs-seller-agreement-responder-"));
    try {
      const h = await harness({ store: await createFsFencedSessionStore({ dir }) });
      const first = await respondToFixedPriceAgreementProposalDurable(
        h.request.input,
        h.durability,
      );
      expect(first.disposition).toBe("complete");
      h.durability.store = await createFsFencedSessionStore({ dir });
      const replay = await respondToFixedPriceAgreementProposalDurable(
        h.request.input,
        h.durability,
      );
      expect(replay).toEqual(
        first.disposition === "complete" ? { ...first, recovered: true } : first,
      );
      expect(h.state.calls.signature).toBe(1);
      expect(h.state.calls.publication).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.each<Effect>(["signature", "publication"])(
    "lost %s response survives a cold restart without a duplicate effect",
    async (effect) => {
      const dir = await mkdtemp(join(tmpdir(), `dacs-seller-agreement-${effect}-`));
      try {
        const h = await harness({ store: await createFsFencedSessionStore({ dir }) });
        h.state.lost.add(effect);
        const interrupted = await respondToFixedPriceAgreementProposalDurable(
          h.request.input,
          h.durability,
        );
        expect(interrupted).toMatchObject({
          disposition: "indeterminate",
          stage: effect === "signature" ? "seller-signature" : "contribution-publication",
        });
        h.durability.store = await createFsFencedSessionStore({ dir });
        const completed = await respondToFixedPriceAgreementProposalDurable(
          h.request.input,
          h.durability,
        );
        expect(completed.disposition).toBe("complete");
        expect(h.state.calls[effect]).toBe(1);
        // Recovery restores the retained signature; it never signs again.
        expect(h.state.calls.signature).toBe(1);
        expect(h.state.calls.publication).toBe(1);
        expect(new Set(h.state.fences[effect].map((fence) => fence.idempotencyKey)).size).toBe(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test.each<Effect>(["signature", "publication"])(
    "only authoritative absence redrives %s with one stable key across generations",
    async (effect) => {
      const h = await harness();
      h.state.failBeforeStore.add(effect);
      const interrupted = await respondToFixedPriceAgreementProposalDurable(
        h.request.input,
        h.durability,
      );
      expect(interrupted.disposition).toBe("indeterminate");
      const completed = await respondToFixedPriceAgreementProposalDurable(
        h.request.input,
        h.durability,
      );
      expect(completed.disposition).toBe("complete");
      expect(h.state.calls[effect]).toBe(2);
      expect(h.state.fences[effect][0]?.generation).not.toBe(
        h.state.fences[effect][1]?.generation,
      );
      expect(h.state.fences[effect][0]?.idempotencyKey).toBe(
        h.state.fences[effect][1]?.idempotencyKey,
      );
    },
  );

  test("two filesystem-backed workers converge and the live generation fences the loser", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dacs-seller-agreement-concurrent-"));
    try {
      const firstStore = await createFsFencedSessionStore({ dir });
      const h = await harness({ store: firstStore, workerId: "seller-worker-a" });
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      h.state.signEntered = entered;
      h.state.signGate = gate;
      const first = respondToFixedPriceAgreementProposalDurable(
        h.request.input,
        h.durability,
      );
      await started;
      const second = await respondToFixedPriceAgreementProposalDurable(
        h.request.input,
        {
          ...h.durability,
          store: await createFsFencedSessionStore({ dir }),
          workerId: "seller-worker-b",
        },
      );
      expect(second).toMatchObject({ disposition: "waiting", stage: "lease" });
      release();
      expect((await first).disposition).toBe("complete");
      const converged = await respondToFixedPriceAgreementProposalDurable(
        h.request.input,
        {
          ...h.durability,
          store: await createFsFencedSessionStore({ dir }),
          workerId: "seller-worker-b",
        },
      );
      expect(converged).toMatchObject({ disposition: "complete", recovered: true });
      expect(h.state.calls.signature).toBe(1);
      expect(h.state.calls.publication).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an expired generation cannot sign; recovery mints a later generation", async () => {
    const h = await harness();
    let now = NOW;
    h.durability.leaseNowMs = () => now;
    await h.store.create({
      jobId: h.context.jobId,
      agreementHash: h.request.plan.agreementHash,
      phase: "agreement-responder:proposal-binding",
      now,
    });
    const stale = await h.store.acquireLease({
      jobId: h.context.jobId,
      owner: "stale-seller-worker",
      ttlMs: 10,
      now,
    });
    expect(stale.ok).toBe(true);
    expect(await respondToFixedPriceAgreementProposalDurable(
      h.request.input,
      h.durability,
    )).toMatchObject({ disposition: "waiting", stage: "lease" });
    expect(h.state.calls.signature).toBe(0);
    now += 11;
    expect((await respondToFixedPriceAgreementProposalDurable(
      h.request.input,
      h.durability,
    )).disposition).toBe("complete");
    expect(h.state.fences.signature[0]?.generation).toBe(2);
    expect(h.state.fences.publication[0]?.generation).toBe(2);
  });

  test.each([
    ["absent", "waiting"],
    ["rejected", "rejected"],
    ["indeterminate", "indeterminate"],
  ] as const)(
    "context %s remains a distinct %s result and cannot reach the signer",
    async (disposition, expected) => {
      const h = await harness();
      h.state.contextResolution = { disposition, reason: `${disposition} context` };
      expect(await respondToFixedPriceAgreementProposalDurable(
        h.request.input,
        h.durability,
      )).toMatchObject({ disposition: expected, stage: "context" });
      expect(h.state.calls.signature).toBe(0);
      expect(h.state.calls.publication).toBe(0);
    },
  );

  test.each(["rejected", "indeterminate"] as const)(
    "publication reconciliation %s cannot be treated as absence",
    async (disposition) => {
      const h = await harness();
      h.state.publicationResolution = { disposition, reason: `${disposition} publication` };
      expect(await respondToFixedPriceAgreementProposalDurable(
        h.request.input,
        h.durability,
      )).toMatchObject({ disposition, stage: "contribution-publication" });
      expect(h.state.calls.signature).toBe(1);
      expect(h.state.calls.publication).toBe(0);
    },
  );

  test.each(["rejected", "indeterminate"] as const)(
    "signature reconciliation %s cannot be treated as absence",
    async (disposition) => {
      const h = await harness();
      h.state.failBeforeStore.add("signature");
      expect((await respondToFixedPriceAgreementProposalDurable(
        h.request.input,
        h.durability,
      )).disposition).toBe("indeterminate");
      h.state.signatureResolution = { disposition, reason: `${disposition} signature` };
      expect(await respondToFixedPriceAgreementProposalDurable(
        h.request.input,
        h.durability,
      )).toMatchObject({ disposition, stage: "seller-signature" });
      expect(h.state.calls.signature).toBe(1);
    },
  );

  test("wrong listing, price, rail, deliverable, deadline, payout, job, and seller reject before signing", async () => {
    const baseContext = agreementContext();
    const baseDraft = deriveFixedPriceAgreement(baseContext);
    const mutations: Array<[
      string,
      (draft: ReturnType<typeof deriveFixedPriceAgreement>) => void,
      FixedPriceAgreementInput,
    ]> = [
      ["listing version", (draft) => { draft.listingRef.version += 1; }, baseContext],
      ["listing hash", (draft) => { draft.listingRef.contentHash = "f".repeat(64); }, baseContext],
      ["job", (draft) => {
        Object.assign(
          draft,
          deriveFixedPriceAgreement(agreementContext(SUBSTITUTE_JOB_ID)),
        );
      }, baseContext],
      ["price", (draft) => { draft.terms.price.amount = "3"; }, baseContext],
      ["rail", (draft) => {
        if (draft.terms.rail) draft.terms.rail.parameters = { network: "eip155:1" };
      }, baseContext],
      ["deliverable", (draft) => { draft.terms.deliverable.hash = "c".repeat(64); }, baseContext],
      ["deadline", (draft) => { draft.terms.deadline += 1; }, baseContext],
      ["seller", (draft) => {
        const seller = draft.parties.find((party) => party.role === "seller")!;
        seller.primaryClaim = OTHER_SELLER;
      }, baseContext],
    ];

    const payoutContext = agreementContext(PAYEE_JOB_ID, true);
    const payoutDraft = deriveFixedPriceAgreement(payoutContext);
    mutations.push(["payout", (draft) => {
      if ("payoutBindings" in draft.terms) {
        draft.terms.payoutBindings[0]!.payeeAddress = `0x${"33".repeat(20)}`;
      }
    }, payoutContext]);

    for (const [name, mutate, context] of mutations) {
      const draft = structuredClone(name === "payout" ? payoutDraft : baseDraft);
      mutate(draft);
      const request = await requestForDraft(draft);
      const h = await harness({ context, request });
      const result = await respondToFixedPriceAgreementProposalDurable(
        h.request.input,
        h.durability,
      );
      expect(result.disposition, name).toBe("rejected");
      expect(h.state.calls.signature, name).toBe(0);
      expect(h.state.calls.publication, name).toBe(0);
    }
  });

  test("wrong plan, agreement, transport identity, buyer contribution, role, and algorithm reject before signing", async () => {
    const context = agreementContext();
    const draft = deriveFixedPriceAgreement(context);
    const cases: Array<[string, DurableSellerFixedPriceAgreementInput]> = [];

    const wrongPlan = await requestForDraft(draft);
    wrongPlan.input.proposal = {
      ...wrongPlan.input.proposal,
      plan: { ...wrongPlan.input.proposal.plan, planHash: "f".repeat(64) },
    };
    cases.push(["plan", wrongPlan.input]);

    const wrongAgreement = await requestForDraft(draft);
    wrongAgreement.input.proposal = {
      ...wrongAgreement.input.proposal,
      plan: { ...wrongAgreement.input.proposal.plan, agreementHash: "e".repeat(64) },
    };
    cases.push(["agreement", wrongAgreement.input]);

    const wrongTransport = await requestForDraft(draft);
    wrongTransport.input.transportIdentity = {
      ...wrongTransport.input.transportIdentity,
      buyer: "did:example:substituted-buyer",
    };
    cases.push(["transport", wrongTransport.input]);

    const otherDraft = deriveFixedPriceAgreement(
      agreementContext(SUBSTITUTE_JOB_ID),
    );
    const other = await requestForDraft(otherDraft);
    const wrongBuyer = await requestForDraft(draft);
    const wrongBuyerMaterial = {
      proposalVersion: "1" as const,
      plan: wrongBuyer.plan,
      buyerContribution: other.buyerContribution,
    };
    wrongBuyer.input.proposal = {
      ...wrongBuyerMaterial,
      proposalHash: sha256Hex(canonicalize(wrongBuyerMaterial)),
    };
    wrongBuyer.input.transportIdentity = {
      ...wrongBuyer.input.transportIdentity,
      proposalHash: wrongBuyer.input.proposal.proposalHash,
    };
    cases.push(["buyer contribution", wrongBuyer.input]);

    const wrongRole = await requestForDraft(draft);
    const sellerAsBuyer = await createFixedPriceAgreementSignatureContribution(
      wrongRole.plan,
      "seller",
      {
        party: SELLER,
        algorithm: "ed25519",
        sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)),
      },
    );
    const wrongRoleMaterial = {
      proposalVersion: "1" as const,
      plan: wrongRole.plan,
      buyerContribution: sellerAsBuyer,
    };
    wrongRole.input.proposal = {
      ...wrongRoleMaterial,
      proposalHash: sha256Hex(canonicalize(wrongRoleMaterial)),
    };
    wrongRole.input.transportIdentity = {
      ...wrongRole.input.transportIdentity,
      proposalHash: wrongRole.input.proposal.proposalHash,
    };
    cases.push(["role", wrongRole.input]);

    const wrongAlgorithm = await requestForDraft(draft, "ecdsa-secp256k1");
    cases.push(["algorithm", wrongAlgorithm.input]);

    for (const [name, input] of cases) {
      const h = await harness({ context, request: {
        input,
        plan: input.proposal.plan,
        buyerContribution: input.proposal.buyerContribution,
      } });
      const result = await respondToFixedPriceAgreementProposalDurable(input, h.durability);
      expect(result.disposition, name).toBe("rejected");
      expect(h.state.calls.signature, name).toBe(0);
      expect(h.state.calls.publication, name).toBe(0);
    }
  });

  test("a conflicting authenticated context for one retained job cannot trigger another signature", async () => {
    const h = await harness();
    h.state.publicationResolution = { disposition: "absent", reason: "pending" };
    h.state.publicationSubmission = { disposition: "indeterminate", reason: "queued" };
    expect((await respondToFixedPriceAgreementProposalDurable(
      h.request.input,
      h.durability,
    )).disposition).toBe("indeterminate");
    expect(h.state.calls.signature).toBe(1);

    const conflictingContext = structuredClone(h.context);
    conflictingContext.generatedAt += 1;
    h.state.contextResolution = { disposition: "present", value: conflictingContext };
    const conflict = await respondToFixedPriceAgreementProposalDurable(
      h.request.input,
      h.durability,
    );
    expect(conflict).toMatchObject({ disposition: "rejected", stage: "context" });
    expect(h.state.calls.signature).toBe(1);
  });

  test("a second cryptographically accepted buyer contribution cannot replace retained authority", async () => {
    const h = await harness();
    expect((await respondToFixedPriceAgreementProposalDurable(
      h.request.input,
      h.durability,
    )).disposition).toBe("complete");
    const alternateBuyer = await createFixedPriceAgreementSignatureContribution(
      h.request.plan,
      "buyer",
      {
        party: BUYER,
        algorithm: "ed25519",
        sign: () => Buffer.alloc(64, 8).toString("base64url"),
      },
    );
    const material = {
      proposalVersion: "1" as const,
      plan: h.request.plan,
      buyerContribution: alternateBuyer,
    };
    const proposal: FixedPriceAgreementProposal = {
      ...material,
      proposalHash: sha256Hex(canonicalize(material)),
    };
    const replacement: DurableSellerFixedPriceAgreementInput = {
      ...h.request.input,
      proposal,
      transportIdentity: {
        ...h.request.input.transportIdentity,
        proposalHash: proposal.proposalHash,
      },
    };
    const originalVerify = h.durability.verifyContribution;
    const result = await respondToFixedPriceAgreementProposalDurable(
      replacement,
      {
        ...h.durability,
        verifyContribution: (input) => input.role === "buyer"
          ? "valid"
          : originalVerify(input),
      },
    );
    expect(result).toMatchObject({ disposition: "rejected", stage: "proposal" });
    expect(h.state.calls.signature).toBe(1);
    expect(h.state.calls.publication).toBe(1);
  });

  test("published substituted contribution and invalid buyer signature fail closed", async () => {
    const substituted = await harness();
    const other = await requestForDraft(
      deriveFixedPriceAgreement(agreementContext(SUBSTITUTE_JOB_ID)),
    );
    substituted.state.publicationResolution = {
      disposition: "present",
      value: await createFixedPriceAgreementSignatureContribution(
        other.plan,
        "seller",
        {
          party: SELLER,
          algorithm: "ed25519",
          sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)),
        },
      ),
    };
    expect(await respondToFixedPriceAgreementProposalDurable(
      substituted.request.input,
      substituted.durability,
    )).toMatchObject({ disposition: "rejected", stage: "contribution-publication" });
    expect(substituted.state.calls.publication).toBe(0);

    const invalidBuyerRequest = await requestForDraft(
      deriveFixedPriceAgreement(agreementContext()),
    );
    const invalidMaterial = {
      proposalVersion: "1" as const,
      plan: invalidBuyerRequest.plan,
      buyerContribution: {
        ...invalidBuyerRequest.buyerContribution,
        signature: {
          ...invalidBuyerRequest.buyerContribution.signature,
          value: Buffer.alloc(64, 9).toString("base64url"),
        },
      },
    };
    const contributionMaterial = {
      contributionVersion: invalidMaterial.buyerContribution.contributionVersion,
      planHash: invalidMaterial.buyerContribution.planHash,
      role: invalidMaterial.buyerContribution.role,
      party: invalidMaterial.buyerContribution.party,
      signature: invalidMaterial.buyerContribution.signature,
    };
    invalidMaterial.buyerContribution.contributionHash = sha256Hex(
      canonicalize(contributionMaterial),
    );
    invalidBuyerRequest.input.proposal = {
      ...invalidMaterial,
      proposalHash: sha256Hex(canonicalize(invalidMaterial)),
    };
    invalidBuyerRequest.input.transportIdentity = {
      ...invalidBuyerRequest.input.transportIdentity,
      proposalHash: invalidBuyerRequest.input.proposal.proposalHash,
    };
    const invalidBuyer = await harness({ request: invalidBuyerRequest });
    expect(await respondToFixedPriceAgreementProposalDurable(
      invalidBuyer.request.input,
      invalidBuyer.durability,
    )).toMatchObject({ disposition: "rejected", stage: "buyer-contribution" });
    expect(invalidBuyer.state.calls.signature).toBe(0);
  });

  test("hostile request accessors, proxies, and hidden remote authority are rejected before effects", async () => {
    const h = await harness();
    let getterCalls = 0;
    const hostileProposal = structuredClone(h.request.input.proposal) as Record<string, unknown>;
    Object.defineProperty(hostileProposal, "proposalHash", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return h.request.input.proposal.proposalHash;
      },
    });
    expect(await respondToFixedPriceAgreementProposalDurable(
      { ...h.request.input, proposal: hostileProposal as never },
      h.durability,
    )).toMatchObject({ disposition: "rejected", stage: "proposal" });
    expect(getterCalls).toBe(0);

    expect(await respondToFixedPriceAgreementProposalDurable(
      {
        ...h.request.input,
        seller: {
          ...h.request.input.seller,
          sign: new Proxy(h.request.input.seller.sign, {}),
        },
      },
      h.durability,
    )).toMatchObject({ disposition: "rejected", stage: "proposal" });

    await expect(respondToFixedPriceAgreementProposalDurable(
      h.request.input,
      {
        ...h.durability,
        buyerSigner: () => "forbidden",
      } as never,
    )).rejects.toThrow(/must contain exactly/i);

    let verifierCoercions = 0;
    const hostileDisposition = Object.create(null) as Record<PropertyKey, unknown>;
    Object.defineProperty(hostileDisposition, Symbol.toPrimitive, {
      value: () => {
        verifierCoercions += 1;
        return "invalid";
      },
    });
    expect(await respondToFixedPriceAgreementProposalDurable(
      h.request.input,
      { ...h.durability, verifyContribution: () => hostileDisposition as never },
    )).toMatchObject({ disposition: "indeterminate", stage: "buyer-contribution" });
    expect(verifierCoercions).toBe(0);
    expect(h.state.calls.signature).toBe(0);
    expect(h.state.calls.publication).toBe(0);
  });

  test("callback arguments are isolated snapshots and cannot rewrite durable authority", async () => {
    const h = await harness();
    const originalResolver = h.durability.resolveAuthenticatedAgreementContext;
    let observedCandidate = false;
    h.durability.resolveAuthenticatedAgreementContext = async (query) => {
      observedCandidate = canonicalize(query.candidateDraft) ===
        canonicalize(h.request.input.proposal.plan.draft);
      (query as { jobId: string }).jobId = "mutated-query";
      query.candidateDraft.terms.price.amount = "999";
      return originalResolver(query);
    };
    const originalPublish = h.durability.transport.publishSellerContribution;
    h.durability.transport.publishSellerContribution = async (contribution, identity, fence) => {
      const result = await originalPublish(contribution, identity, fence);
      (contribution as { party: string }).party = "did:example:mutated";
      (identity as { buyer: string }).buyer = "did:example:mutated";
      return result;
    };
    const result = await respondToFixedPriceAgreementProposalDurable(
      h.request.input,
      h.durability,
    );
    expect(result.disposition).toBe("complete");
    if (result.disposition !== "complete") return;
    expect(result.result.transportIdentity.buyer).toBe(BUYER);
    expect(result.result.sellerContribution.party).toBe(SELLER);
    expect(h.request.input.transportIdentity.buyer).toBe(BUYER);
    expect(h.request.input.proposal.plan.draft.terms.price.amount).toBe("2");
    expect(observedCandidate).toBe(true);
  });

  test("public response admission rejects seller and plan rebinding", async () => {
    const h = await harness();
    const result = await respondToFixedPriceAgreementProposalDurable(
      h.request.input,
      h.durability,
    );
    expect(result.disposition).toBe("complete");
    if (result.disposition !== "complete") return;
    expect(isDurableSellerFixedPriceAgreementResponse(result.result)).toBe(true);
    expect(isDurableSellerFixedPriceAgreementResponse({
      ...result.result,
      sellerContribution: {
        ...result.result.sellerContribution,
        planHash: "f".repeat(64),
      },
    })).toBe(false);
    expect(isDurableSellerFixedPriceAgreementResponse({
      ...result.result,
      transportIdentity: {
        ...result.result.transportIdentity,
        seller: OTHER_SELLER,
      },
    })).toBe(false);
  });
});

describe("seller responder with fixed-price additionalTerms", () => {
  const REQUEST_KEY = "dacs-chatgpt-plugin:public-service-request:v1";
  const request = {
    type: "public-data",
    serviceId: "public-text-report",
    version: "1",
    input: "Solar panels make power.",
  };
  const terms = {
    [REQUEST_KEY]: { request, requestHash: sha256Hex(canonicalize(request)) },
  };
  const oneByteDifferent = {
    [REQUEST_KEY]: {
      request: { ...request, input: "Solar panels make power!" },
      requestHash: terms[REQUEST_KEY].requestHash,
    },
  };
  const variants = [
    ["AgreementDocument", JOB_ID, false],
    ["PayeeBoundAgreementDocument", PAYEE_JOB_ID, true],
  ] as const;

  const withTerms = (
    context: FixedPriceAgreementInput,
    additionalTerms: Record<string, unknown> | undefined,
  ): FixedPriceAgreementInput =>
    additionalTerms === undefined ? context : { ...context, additionalTerms };

  async function respond(
    jobId: string,
    payeeBound: boolean,
    buyerTerms: Record<string, unknown> | undefined,
    sellerTerms: Record<string, unknown> | undefined,
  ) {
    const buyerDraft = deriveFixedPriceAgreement(
      withTerms(agreementContext(jobId, payeeBound), buyerTerms),
    );
    const request = await requestForDraft(buyerDraft);
    const h = await harness({
      context: withTerms(agreementContext(jobId, payeeBound), sellerTerms),
      request,
    });
    const result = await respondToFixedPriceAgreementProposalDurable(
      h.request.input,
      h.durability,
    );
    return { h, result };
  }

  describe.each(variants)("%s", (_name, jobId, payeeBound) => {
    test("equal terms on both sides are co-signed into one exact Agreement", async () => {
      const { h, result } = await respond(jobId, payeeBound, terms, terms);
      expect(result.disposition).toBe("complete");
      if (result.disposition !== "complete") return;
      const agreement = await finalizeFixedPriceAgreementContributions(
        h.request.plan,
        [h.request.buyerContribution, result.result.sellerContribution],
        h.durability.verifyContribution,
      );
      expect(agreement.terms.additionalTerms).toEqual(terms);
      expect("payeeBoundAgreementVersion" in agreement).toBe(payeeBound);
      expect(contentHash(agreement as unknown as Record<string, unknown>))
        .toBe(h.request.plan.agreementHash);
      expect(h.state.calls.signature).toBe(1);
      expect(h.state.calls.publication).toBe(1);
    });

    test.each([
      ["buyer adds terms the seller context lacks", terms, undefined],
      ["seller context has terms the buyer omitted", undefined, terms],
      ["one byte differs", oneByteDifferent, terms],
      ["buyer adds a second entry", { ...terms, "acme:note:v1": "x" }, terms],
    ] as const)("%s: rejected before any signature", async (
      _case,
      buyerTerms,
      sellerTerms,
    ) => {
      const { h, result } = await respond(
        jobId,
        payeeBound,
        buyerTerms as Record<string, unknown> | undefined,
        sellerTerms as Record<string, unknown> | undefined,
      );
      expect(result).toMatchObject({
        disposition: "rejected",
        stage: "context",
        reason: "proposal plan differs from the independently derived seller agreement",
      });
      expect(h.state.calls.context).toBe(1);
      expect(h.state.calls.verifyBuyer).toBe(0);
      expect(h.state.calls.signature).toBe(0);
      expect(h.state.calls.publication).toBe(0);
    });

    test("a seller context whose own terms break the profile is rejected", async () => {
      const { h, result } = await respond(jobId, payeeBound, terms, {
        ...terms,
        "acme:price:v1": { amount: "0", currency: "USDC" },
      });
      expect(result).toMatchObject({ disposition: "rejected", stage: "context" });
      expect(result.disposition === "complete" ? "" : result.reason)
        .toMatch(/seller-local agreement derivation rejected the proposal/);
      expect(h.state.calls.signature).toBe(0);
    });

    test("a number the producer refuses is refused before any signature", async () => {
      // The buyer's producer refuses it, so no SDK proposal can carry it.
      expect(() => deriveFixedPriceAgreement(withTerms(
        agreementContext(jobId, payeeBound),
        { "acme:rating:v1": { score: 4.5 } },
      ))).toThrow(/carry decimals as strings/);
      // A seller context carrying one is not valid context data. The responder
      // refuses it while capturing the context, as it refuses every number that
      // is not a safe integer anywhere in the context: indeterminate, before
      // derivation, buyer verification, signing, or publication.
      for (const sellerTerms of [
        { "acme:rating:v1": 4.5 },
        { "acme:rating:v1": { score: 4.5 } },
        { "acme:rating:v1": { score: 2 ** 53 } },
      ]) {
        const label = JSON.stringify(sellerTerms);
        const { h, result } = await respond(
          jobId,
          payeeBound,
          { "acme:rating:v1": { score: 4 } },
          sellerTerms,
        );
        expect(result, label).toMatchObject({ disposition: "indeterminate", stage: "context" });
        expect(result.disposition === "complete" ? "" : result.reason, label).toMatch(
          /seller agreement context resolution failed: .*contains a non-canonical number/,
        );
        expect(h.state.calls.context, label).toBe(1);
        expect(h.state.calls.verifyBuyer, label).toBe(0);
        expect(h.state.calls.signature, label).toBe(0);
        expect(h.state.calls.publication, label).toBe(0);
      }
    });
  });
});

describe("seller responder with metered fixed-price contexts", () => {
  // The metered derivation fixture (fixedPriceFixtures `metered`, MTR vector
  // `exact-whole-unit-product`) on the responder's plain and payee-bound Listings.
  const METERED_PRICING = {
    kind: "metered" as const,
    unitPrice: { amount: "1.25", currency: "USDC" },
    unit: "request",
    minTotal: { amount: "2", currency: "USDC" },
  };
  const variants = [
    ["AgreementDocument", JOB_ID, false],
    ["PayeeBoundAgreementDocument", PAYEE_JOB_ID, true],
  ] as const;
  const quantity = (value: string) => ({ quantity: value, unit: "request" });

  function meteredContext(
    jobId: string,
    payeeBound: boolean,
    meteredQuantity?: unknown,
  ): FixedPriceAgreementInput {
    const context = agreementContext(jobId, payeeBound);
    const exactListing: Listing = {
      ...context.verifiedListing.listing,
      pricing: structuredClone(METERED_PRICING),
    };
    return {
      ...context,
      verifiedListing: {
        disposition: "verified",
        listing: exactListing,
        pin: {
          listingId: exactListing.listingId,
          version: exactListing.listingVersion,
          contentHash: contentHash(exactListing as unknown as Record<string, unknown>),
        },
      },
      ...(meteredQuantity === undefined ? {} : { meteredQuantity }),
    } as FixedPriceAgreementInput;
  }

  async function respondTo(
    buyerDraft: ReturnType<typeof deriveFixedPriceAgreement>,
    sellerContext: FixedPriceAgreementInput,
  ) {
    const request = await requestForDraft(buyerDraft);
    const h = await harness({ context: sellerContext, request });
    const result = await respondToFixedPriceAgreementProposalDurable(
      h.request.input,
      h.durability,
    );
    return { h, result };
  }

  function expectRefusedBeforeEffects(
    { h, result }: Awaited<ReturnType<typeof respondTo>>,
    disposition: "rejected" | "indeterminate",
    reason: RegExp,
    label: string,
  ): void {
    expect(result, label).toMatchObject({ disposition, stage: "context" });
    expect(result.disposition === "complete" ? "" : result.reason, label).toMatch(reason);
    expect(h.state.calls.verifyBuyer, label).toBe(0);
    expect(h.state.calls.signature, label).toBe(0);
    expect(h.state.calls.publication, label).toBe(0);
  }

  const PLAN_DIFFERS = /^proposal plan differs from the independently derived seller agreement$/;
  const DERIVATION = "seller-local agreement derivation rejected the proposal: DacsError: ";

  describe.each(variants)("%s", (_name, jobId, payeeBound) => {
    test("a valid metered context is co-signed into one exact Agreement", async () => {
      const buyerDraft = deriveFixedPriceAgreement(
        meteredContext(jobId, payeeBound, quantity("4")),
      );
      const { h, result } = await respondTo(
        buyerDraft,
        meteredContext(jobId, payeeBound, quantity("4")),
      );
      expect(result.disposition).toBe("complete");
      if (result.disposition !== "complete") return;
      expect(h.state.calls.verifyBuyer).toBe(1);
      expect(h.state.calls.signature).toBe(1);
      expect(h.state.calls.publication).toBe(1);
      const agreement = await finalizeFixedPriceAgreementContributions(
        h.request.plan,
        [h.request.buyerContribution, result.result.sellerContribution],
        h.durability.verifyContribution,
      );
      expect(agreement.terms.meteredQuantity).toEqual(quantity("4"));
      expect(agreement.terms.price).toEqual({ amount: "5", currency: "USDC" });
      expect("payeeBoundAgreementVersion" in agreement).toBe(payeeBound);
      expect(contentHash(agreement as unknown as Record<string, unknown>))
        .toBe(h.request.plan.agreementHash);
    });

    test.each([
      ["one unit above the buyer's", "4", "5"],
      ["one unit below the buyer's", "4", "3"],
      // Both totals are the 2 USDC minimum: only the quantity differs.
      ["one unit below the buyer's at the same minimum-total price", "1", "0"],
    ] as const)("seller quantity %s: rejected before any signature", async (
      label,
      buyerQuantity,
      sellerQuantity,
    ) => {
      expectRefusedBeforeEffects(
        await respondTo(
          deriveFixedPriceAgreement(meteredContext(jobId, payeeBound, quantity(buyerQuantity))),
          meteredContext(jobId, payeeBound, quantity(sellerQuantity)),
        ),
        "rejected",
        PLAN_DIFFERS,
        label,
      );
    });

    test("seller context missing the quantity: rejected before any signature", async () => {
      expectRefusedBeforeEffects(
        await respondTo(
          deriveFixedPriceAgreement(meteredContext(jobId, payeeBound, quantity("4"))),
          meteredContext(jobId, payeeBound),
        ),
        "rejected",
        new RegExp(`^${DERIVATION}missing-metered-quantity`),
        "missing",
      );
    });

    test("seller quantity present when the buyer's draft has none: rejected before any signature", async () => {
      // A fixed-price Listing: the buyer's draft has no quantity.
      expectRefusedBeforeEffects(
        await respondTo(
          deriveFixedPriceAgreement(agreementContext(jobId, payeeBound)),
          { ...agreementContext(jobId, payeeBound), meteredQuantity: quantity("4") },
        ),
        "rejected",
        new RegExp(`^${DERIVATION}unexpected-metered-quantity`),
        "fixed Listing",
      );
      // A metered Listing whose buyer draft was stripped of its quantity.
      const stripped = deriveFixedPriceAgreement(
        meteredContext(jobId, payeeBound, quantity("4")),
      );
      delete (stripped.terms as { meteredQuantity?: unknown }).meteredQuantity;
      expectRefusedBeforeEffects(
        await respondTo(stripped, meteredContext(jobId, payeeBound, quantity("4"))),
        "rejected",
        PLAN_DIFFERS,
        "stripped metered draft",
      );
    });

    test("a malformed seller quantity is refused by the derivation before any signature", async () => {
      const buyerDraft = deriveFixedPriceAgreement(
        meteredContext(jobId, payeeBound, quantity("4")),
      );
      for (const [label, malformed, code] of [
        ["leading zero", quantity("04"), "non-canonical-metered-quantity"],
        ["signed", quantity("-4"), "non-canonical-metered-quantity"],
        ["decimal", quantity("4.0"), "non-canonical-metered-quantity"],
        ["empty", quantity(""), "non-canonical-metered-quantity"],
        ["number", { quantity: 4, unit: "request" }, "non-canonical-metered-quantity"],
        ["bare string", "4", "non-canonical-metered-quantity"],
        ["null", null, "non-canonical-metered-quantity"],
        ["missing unit", { quantity: "4" }, "metered-unit-mismatch"],
        ["other unit", { quantity: "4", unit: "byte" }, "metered-unit-mismatch"],
      ] as const) {
        expectRefusedBeforeEffects(
          await respondTo(buyerDraft, meteredContext(jobId, payeeBound, malformed)),
          "rejected",
          new RegExp(`^${DERIVATION}${code}`),
          label,
        );
      }
      // Not context data at all: refused while capturing, like every other
      // optional context member set to undefined.
      expectRefusedBeforeEffects(
        await respondTo(buyerDraft, {
          ...meteredContext(jobId, payeeBound),
          meteredQuantity: undefined,
        } as unknown as FixedPriceAgreementInput),
        "indeterminate",
        /^seller agreement context resolution failed: TypeError: .*meteredQuantity cannot be undefined$/,
        "undefined",
      );
    });

    test("a resolver copying the buyer's quantity still gets the derivation's unit rule", async () => {
      // The buyer hand-crafts a draft whose quantity names another unit. The
      // Agreement reader admits any non-empty unit, so the plan is well formed.
      const crafted = deriveFixedPriceAgreement(
        meteredContext(jobId, payeeBound, quantity("4")),
      );
      crafted.terms.meteredQuantity = { quantity: "4", unit: "byte" };
      const request = await requestForDraft(crafted);
      const h = await harness({ context: meteredContext(jobId, payeeBound), request });
      h.durability.resolveAuthenticatedAgreementContext = (query) => {
        h.state.calls.context += 1;
        return {
          disposition: "present" as const,
          value: meteredContext(
            jobId,
            payeeBound,
            structuredClone(query.candidateDraft.terms.meteredQuantity),
          ),
        };
      };
      const result = await respondToFixedPriceAgreementProposalDurable(
        h.request.input,
        h.durability,
      );
      expectRefusedBeforeEffects(
        { h, result },
        "rejected",
        new RegExp(`^${DERIVATION}metered-unit-mismatch`),
        "copied unit",
      );
    });
  });
});

// Each guard below has no sibling that refuses the same input, so a test per
// arm is the only thing that notices if one stops running.
describe("seller responder proposal integrity and durable-effect guards", () => {
  async function respond(h: Awaited<ReturnType<typeof harness>>) {
    return respondToFixedPriceAgreementProposalDurable(h.request.input, h.durability);
  }

  function expectNoEffects(h: Awaited<ReturnType<typeof harness>>, label: string) {
    expect(h.state.calls.signature, label).toBe(0);
    expect(h.state.calls.publication, label).toBe(0);
  }

  function rehash(
    request: Awaited<ReturnType<typeof requestForDraft>>,
    proposal: Record<string, unknown>,
    proposalHash: string,
  ) {
    request.input.proposal = { ...proposal, proposalHash } as never;
    request.input.transportIdentity = {
      ...request.input.transportIdentity,
      proposalHash,
    };
  }

  test("a proposalVersion other than 1 is rejected even when rehashed", async () => {
    const request = await requestForDraft(deriveFixedPriceAgreement(agreementContext()));
    const { proposalHash: _old, ...material } = request.input.proposal;
    const changed = { ...material, proposalVersion: "2" };
    rehash(request, changed, sha256Hex(canonicalize(changed)));
    const h = await harness({ request });
    expect(await respond(h)).toMatchObject({ disposition: "rejected", stage: "proposal" });
    expect(h.state.calls.context).toBe(0);
    expectNoEffects(h, "proposalVersion");
  });

  test("a proposalHash that does not hash the proposal material is rejected", async () => {
    const request = await requestForDraft(deriveFixedPriceAgreement(agreementContext()));
    const { proposalHash: _old, ...material } = request.input.proposal;
    rehash(request, material, sha256Hex(canonicalize({ ...material, extra: true })));
    const h = await harness({ request });
    expect(await respond(h)).toMatchObject({ disposition: "rejected", stage: "proposal" });
    expect(h.state.calls.context).toBe(0);
    expectNoEffects(h, "proposalHash");
  });

  test("a proposal with an extra member is rejected", async () => {
    const request = await requestForDraft(deriveFixedPriceAgreement(agreementContext()));
    request.input.proposal = { ...request.input.proposal, extra: true } as never;
    const h = await harness({ request });
    expect(await respond(h)).toMatchObject({ disposition: "rejected", stage: "proposal" });
    expectNoEffects(h, "extra member");
  });

  test("an authenticated context with one unknown member is refused before effects", async () => {
    const h = await harness();
    h.state.contextResolution = {
      disposition: "present",
      value: { ...structuredClone(h.context), sellerNote: "unrecognised" },
    };
    const result = await respond(h);
    expect(result).toMatchObject({ disposition: "indeterminate", stage: "context" });
    expect(result.disposition !== "complete" && result.reason).toMatch(
      /authenticated seller agreement context is malformed/,
    );
    expectNoEffects(h, "unknown context member");
  });

  test("a local seller signer for another party cannot answer the seller role", async () => {
    const h = await harness();
    h.request.input.seller.party = OTHER_SELLER;
    expect(await respond(h)).toMatchObject({ disposition: "rejected", stage: "context" });
    expectNoEffects(h, "local seller party");
  });

  type StoreFaults = {
    renewLease?: FencedSessionStoreV2["renewLease"];
    transition?: FencedSessionStoreV2["transition"];
  };

  function faultyStore(inner: FencedSessionStoreV2, faults: StoreFaults): FencedSessionStoreV2 {
    return {
      apiVersion: inner.apiVersion,
      create: (input) => inner.create(input),
      load: (jobId) => inner.load(jobId),
      transition: (input) =>
        faults.transition ? faults.transition(input) : inner.transition(input),
      claimCheckpoint: (input) => inner.claimCheckpoint(input),
      acquireLease: (input) => inner.acquireLease(input),
      renewLease: (input) =>
        faults.renewLease ? faults.renewLease(input) : inner.renewLease(input),
      bindSessionAuthorization: (input) => inner.bindSessionAuthorization(input),
      bindHash: (input) => inner.bindHash(input),
      list: (input) => inner.list(input),
    };
  }

  test.each<[string, (inner: FencedSessionStoreV2) => StoreFaults]>([
    ["a stale or fenced lease renewal", () => ({
      renewLease: async () => ({ ok: false, reason: "lease-fenced" }),
    })],
    ["a refused outcome transition", () => ({
      transition: async () => ({ ok: false, reason: "lease-fenced" }),
    })],
    ["a checkpoint-state conflict without the sealed outcome", (inner) => ({
      transition: async (input) => {
        const loaded = await inner.load(input.jobId);
        return loaded.status === "ok"
          ? { ok: false, reason: "checkpoint-state", record: loaded.record }
          : { ok: false, reason: "not-found" };
      },
    })],
    ["exhausted CAS retries", () => ({
      transition: async () => ({ ok: false, reason: "revision-mismatch" }),
    })],
  ])("%s never reaches the seller signer", async (name, faults) => {
    const inner = createInMemoryFencedSessionStore();
    const h = await harness({ store: faultyStore(inner, faults(inner)) });
    const result = await respond(h);
    expect(result.disposition, name).not.toBe("complete");
    expectNoEffects(h, name);
  });

  test("a durable signature outcome is restored without asking the signer again", async () => {
    const h = await harness();
    h.state.lost.add("publication");
    expect((await respond(h)).disposition).toBe("indeterminate");
    // The signer side has forgotten; only the durable outcome may answer.
    h.state.signatureResolution = { disposition: "absent", reason: "signer state gone" };
    expect((await respond(h)).disposition).toBe("complete");
    expect(h.state.calls.signature).toBe(1);
    expect(h.state.calls.publication).toBe(1);
  });

  type SessionRecordValue = Extract<
    Awaited<ReturnType<FencedSessionStoreV2["load"]>>,
    { status: "ok" }
  >["record"];
  const KEY = durableSellerFixedPriceAgreementCheckpointKey;

  function corruptCheckpoint(key: string, member: string, value: string | boolean) {
    return (record: SessionRecordValue) => {
      for (const checkpoint of record.checkpoints) {
        if (checkpoint.key === key && checkpoint.data) checkpoint.data[member] = value;
      }
    };
  }

  test.each<[string, (record: SessionRecordValue) => void]>([
    ...["contextJson", "proposalJson", "planJson", "transportIdentityJson"].map(
      (member): [string, (record: SessionRecordValue) => void] => [
        `substituted proposal ${member}`,
        corruptCheckpoint(KEY.proposal, member, JSON.stringify({ substituted: true })),
      ],
    ),
    ["substituted seller signature authority",
      corruptCheckpoint(KEY.sellerSignature, "idempotencyKey", "f".repeat(64))],
    ["substituted seller signature contribution hash",
      corruptCheckpoint(KEY.sellerSignature, "contributionHash", "f".repeat(64))],
    ["substituted seller signature contribution data",
      corruptCheckpoint(KEY.sellerSignature, "contributionJson", JSON.stringify({ substituted: true }))],
    ["substituted publication contribution",
      corruptCheckpoint(KEY.publication, "contributionHash", "f".repeat(64))],
    ["publication not marked published", corruptCheckpoint(KEY.publication, "published", false)],
    ["substituted result hash", corruptCheckpoint(KEY.result, "resultHash", "f".repeat(64))],
    ["terminal phase without a result outcome", (record) => {
      record.checkpoints = record.checkpoints.filter((value) => value.key !== KEY.result);
    }],
    ["result outcome outside the terminal phase", (record) => {
      record.phase = "agreement-responder:finalizing";
    }],
    ["result outcome under a live lease", (record) => {
      // A lease consistent with the record, so only the sealing check refuses it.
      record.lease = {
        owner: "seller-worker-1",
        generation: record.leaseGeneration,
        expiresAt: NOW + 60_000,
      };
    }],
  ])("terminal recovery refuses %s without new effects", async (name, corrupt) => {
    const inner = createInMemoryFencedSessionStore();
    let tamper = false;
    const store: FencedSessionStoreV2 = {
      apiVersion: inner.apiVersion,
      create: (input) => inner.create(input),
      load: async (jobId) => {
        const loaded = await inner.load(jobId);
        if (!tamper || loaded.status !== "ok") return loaded;
        const record = structuredClone(loaded.record);
        corrupt(record);
        return { ...loaded, record };
      },
      transition: (input) => inner.transition(input),
      claimCheckpoint: (input) => inner.claimCheckpoint(input),
      acquireLease: (input) => inner.acquireLease(input),
      renewLease: (input) => inner.renewLease(input),
      bindSessionAuthorization: (input) => inner.bindSessionAuthorization(input),
      bindHash: (input) => inner.bindHash(input),
      list: (input) => inner.list(input),
    };
    const h = await harness({ store });
    expect((await respond(h)).disposition, name).toBe("complete");
    tamper = true;
    expect((await respond(h)).disposition, name).not.toBe("complete");
    expect(h.state.calls.signature, name).toBe(1);
    expect(h.state.calls.publication, name).toBe(1);
  });

  test("a session already bound to another agreement hash is never signed", async () => {
    const h = await harness();
    await h.store.create({ jobId: h.context.jobId, agreementHash: "f".repeat(64) });
    const result = await respond(h);
    expect(result.disposition).not.toBe("complete");
    expectNoEffects(h, "conflicting agreement hash");
  });
});

// Public-boundary cases deliberately vary one member at a time. In particular,
// a valid detached contribution can still belong to another role or plan.
describe("seller response transport validation", () => {
  type Response = Extract<Awaited<ReturnType<typeof respondToFixedPriceAgreementProposalDurable>>, { disposition: "complete" }>["result"];
  type MutableResponse = { -readonly [K in keyof Response]: Response[K] };
  type Change = (value: MutableResponse) => unknown;
  const changedIdentity = (key: string, value: unknown): Change => (response) => {
    response.transportIdentity = { ...response.transportIdentity, [key]: value };
    return response;
  };
  const cases: [string, Change][] = [
    ["null", () => null], ["array", () => []], ["primitive", () => "response"],
    ["wrong response version", (r) => ({ ...r, responseVersion: "2" })],
    ["extra response member", (r) => ({ ...r, extra: true })],
    ["null identity", (r) => ({ ...r, transportIdentity: null })],
    ["array identity", (r) => ({ ...r, transportIdentity: [] })],
    ["null contribution", (r) => ({ ...r, sellerContribution: null })],
    ["buyer contribution", (r) => {
      const { contributionHash: _hash, ...material } = { ...r.sellerContribution, role: "buyer" };
      return { ...r, sellerContribution: { ...material, contributionHash: sha256Hex(canonicalize(material)) } };
    }],
    ["different seller", changedIdentity("seller", OTHER_SELLER)],
    ["same buyer and seller", (r) => changedIdentity("buyer", r.transportIdentity.seller)(r)],
    ["different plan", changedIdentity("planHash", "f".repeat(64))],
    ["extra identity member", changedIdentity("extra", true)],
  ];
  for (const key of ["responseVersion", "transportIdentity", "sellerContribution"] as const) {
    cases.push([`missing ${key}`, (r) => { const copy: Record<string, unknown> = { ...r }; delete copy[key]; return copy; }]);
  }
  for (const key of ["jobId", "buyer", "seller", "planHash", "agreementHash", "proposalHash"] as const) {
    cases.push([`missing identity ${key}`, (r) => {
      const identity = { ...r.transportIdentity } as Record<string, unknown>;
      delete identity[key];
      return { ...r, transportIdentity: identity };
    }]);
    for (const value of [null, 1, ""]) cases.push([`${key}=${JSON.stringify(value)}`, changedIdentity(key, value)]);
    if (["jobId", "buyer", "seller"].includes(key)) {
      for (const value of [" padded", "padded ", "e\u0301"]) cases.push([`${key} noncanonical ${value}`, changedIdentity(key, value)]);
    } else {
      for (const value of ["a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64)]) {
        cases.push([`${key} malformed hash ${value}`, changedIdentity(key, value)]);
      }
    }
  }

  test.each(cases)("refuses %s independently", async (_name, change) => {
    const h = await harness();
    const completed = await respondToFixedPriceAgreementProposalDurable(h.request.input, h.durability);
    expect(completed.disposition).toBe("complete");
    if (completed.disposition !== "complete") throw new Error("response fixture did not complete");
    expect(isDurableSellerFixedPriceAgreementResponse(completed.result)).toBe(true);
    expect(isDurableSellerFixedPriceAgreementResponse(change(structuredClone(completed.result)))).toBe(false);
  });

  test("rejects an accessor without evaluating it", async () => {
    let calls = 0;
    expect(isDurableSellerFixedPriceAgreementResponse({
      get responseVersion() { calls += 1; return "1"; },
    })).toBe(false);
    expect(calls).toBe(0);
  });
});

describe("seller responder callback outcome mapping", () => {
  const respond = (h: Awaited<ReturnType<typeof harness>>) =>
    respondToFixedPriceAgreementProposalDurable(h.request.input, h.durability);

  test.each([null, [], "proposal"])("malformed envelope %j is rejected without effects", async (value) => {
    const h = await harness();
    expect(await respondToFixedPriceAgreementProposalDurable(value as never, h.durability))
      .toMatchObject({ disposition: "rejected", stage: "proposal" });
    expect(h.state.calls.context).toBe(0);
    expect(h.state.calls.signature).toBe(0);
    expect(h.state.calls.publication).toBe(0);
  });

  test.each(["buyer", "seller"] as const)("maps every %s verifier outcome", async (role) => {
    for (const [verdict, expected] of [
      ["invalid", "rejected"], ["indeterminate", "indeterminate"], ["error", "indeterminate"],
      ["unknown", "indeterminate"], [null, "indeterminate"],
    ] as const) {
      const h = await harness();
      const verify = h.durability.verifyContribution;
      h.durability.verifyContribution = (check) => check.role === role ? verdict as never : verify(check);
      expect(await respond(h), String(verdict)).toMatchObject({
        disposition: expected, stage: role === "buyer" ? "buyer-contribution" : "seller-signature",
      });
      expect(h.state.calls.signature).toBe(role === "buyer" ? 0 : 1);
      expect(h.state.calls.publication).toBe(0);
    }
  });

  const invalidResolutions: [string, unknown][] = [
    ["null", null], ["array", []], ["missing disposition", {}],
    ["unknown disposition", { disposition: "unknown", reason: "unknown" }],
    ["present without value", { disposition: "present" }],
    ["present with reason", { disposition: "present", value: {}, reason: "unexpected" }],
    ["absent without reason", { disposition: "absent" }],
    ["absent with value", { disposition: "absent", reason: "absent", value: {} }],
    ["rejected with value", { disposition: "rejected", reason: "rejected", value: {} }],
    ["indeterminate with value", { disposition: "indeterminate", reason: "unknown", value: {} }],
    ["empty reason", { disposition: "absent", reason: "" }],
    ["non-string reason", { disposition: "absent", reason: 1 }],
    ["padded reason", { disposition: "absent", reason: " absent " }],
    ["NFD reason", { disposition: "absent", reason: "e\u0301" }],
    ["extra key", { disposition: "absent", reason: "absent", extra: true }],
  ];

  test.each(invalidResolutions)("malformed context resolution: %s", async (_name, value) => {
    const h = await harness();
    h.durability.resolveAuthenticatedAgreementContext = () => value as never;
    expect(await respond(h)).toMatchObject({ disposition: "indeterminate", stage: "context" });
    expect(h.state.calls.signature).toBe(0);
    expect(h.state.calls.publication).toBe(0);
  });

  test.each(invalidResolutions)("malformed publication reconciliation: %s", async (_name, value) => {
    const h = await harness();
    h.durability.transport.reconcileSellerContributionPublication = () => value as never;
    expect(await respond(h)).toMatchObject({ disposition: "indeterminate", stage: "contribution-publication" });
    expect(h.state.calls.publication).toBe(0);
  });

  test.each(invalidResolutions)("malformed signature reconciliation: %s", async (_name, value) => {
    const h = await harness();
    h.state.failBeforeStore.add("signature");
    expect((await respond(h)).disposition).toBe("indeterminate");
    h.durability.reconcileSellerSignature = () => value as never;
    expect(await respond(h)).toMatchObject({ disposition: "indeterminate", stage: "seller-signature" });
    expect(h.state.calls.signature).toBe(1);
    expect(h.state.calls.publication).toBe(0);
  });

  test.each([
    ["rejected", { disposition: "rejected", reason: "publisher refused" }, "rejected"],
    ["indeterminate", { disposition: "indeterminate", reason: "publisher unsure" }, "indeterminate"],
    ["null", null, "indeterminate"],
    ["unknown", { disposition: "unknown", reason: "unknown" }, "indeterminate"],
    ["submitted with reason", { disposition: "submitted", reason: "unexpected" }, "indeterminate"],
    ["rejected without reason", { disposition: "rejected" }, "indeterminate"],
    ["indeterminate without reason", { disposition: "indeterminate" }, "indeterminate"],
    ["rejected empty reason", { disposition: "rejected", reason: "" }, "indeterminate"],
    ["indeterminate non-string reason", { disposition: "indeterminate", reason: 1 }, "indeterminate"],
    ["extra member", { disposition: "submitted", extra: true }, "indeterminate"],
  ])("maps publication submission %s", async (_name, submission, expected) => {
    const h = await harness();
    h.durability.transport.publishSellerContribution = () => {
      h.state.calls.publication += 1;
      return submission as never;
    };
    expect(await respond(h)).toMatchObject({ disposition: expected, stage: "contribution-publication" });
    expect(h.state.calls.publication).toBe(1);
    const loaded = await h.store.load(h.context.jobId);
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") expect(loaded.record.checkpoints.some((c) =>
      c.key === durableSellerFixedPriceAgreementCheckpointKey.result)).toBe(false);
  });

  test.each(["absent", "rejected", "indeterminate"] as const)(
    "maps %s after a submitted publication without redriving", async (disposition) => {
      const h = await harness();
      let reconciles = 0;
      h.durability.transport.reconcileSellerContributionPublication = () => ({
        disposition: ++reconciles === 1 ? "absent" : disposition,
        reason: "authoritative publication state",
      });
      expect(await respond(h)).toMatchObject({
        disposition: disposition === "rejected" ? "rejected" : "indeterminate",
        stage: "contribution-publication",
      });
      expect(reconciles).toBe(2);
      expect(h.state.calls.signature).toBe(1);
      expect(h.state.calls.publication).toBe(1);
    },
  );

  test.each([false, 1, null, [], {}, new Int8Array(64), "not-base64!"])(
    "maps malformed signer output %j without publication", async (value) => {
      const h = await harness();
      h.request.input.seller.sign = () => value as never;
      expect(await respond(h)).toMatchObject({
        disposition: typeof value === "string" ? "rejected" : "indeterminate", stage: "seller-signature",
      });
      expect(h.state.calls.publication).toBe(0);
    },
  );

  test.each(["base64url", "Buffer"] as const)("accepts intrinsic signature output as %s", async (format) => {
    const h = await harness();
    h.request.input.seller.sign = (bytes) => {
      const signature = ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED));
      return format === "Buffer" ? Buffer.from(signature) : Buffer.from(signature).toString("base64url");
    };
    expect((await respond(h)).disposition).toBe("complete");
  });

  test("uses the default clock for leases when no clock is supplied", async () => {
    const h = await harness();
    delete h.durability.leaseNowMs;
    const now = vi.spyOn(Date, "now").mockReturnValue(NOW + 1234);
    try {
      expect((await respond(h)).disposition).toBe("complete");
      expect(now).toHaveBeenCalled();
      const loaded = await h.store.load(h.context.jobId);
      expect(loaded.status).toBe("ok");
      if (loaded.status === "ok") expect(loaded.record.createdAt).toBe(NOW + 1234);
      if (loaded.status === "ok") expect(loaded.record.updatedAt).toBe(NOW + 1234);
    } finally { now.mockRestore(); }
  });
});

describe("seller responder durable state and CAS recovery", () => {
  type RecordValue = Extract<Awaited<ReturnType<FencedSessionStoreV2["load"]>>, { status: "ok" }>["record"];
  const KEY = durableSellerFixedPriceAgreementCheckpointKey;
  const respond = (h: Awaited<ReturnType<typeof harness>>) =>
    respondToFixedPriceAgreementProposalDurable(h.request.input, h.durability);
  function wrap(inner: FencedSessionStoreV2, overrides: Partial<FencedSessionStoreV2>): FencedSessionStoreV2 {
    return {
      apiVersion: inner.apiVersion,
      create: (value) => inner.create(value), load: (value) => inner.load(value),
      transition: (value) => inner.transition(value), claimCheckpoint: (value) => inner.claimCheckpoint(value),
      acquireLease: (value) => inner.acquireLease(value), renewLease: (value) => inner.renewLease(value),
      bindSessionAuthorization: (value) => inner.bindSessionAuthorization(value), bindHash: (value) => inner.bindHash(value),
      list: (value) => inner.list(value), ...overrides,
    };
  }

  test.each(Object.values(KEY))("retries a revision mismatch while completing %s", async (key) => {
    const inner = createInMemoryFencedSessionStore();
    let attempts = 0;
    const h = await harness({ store: wrap(inner, {
      transition: async (value) => {
        if (value.checkpoint?.key === key && value.checkpoint.stage === "outcome" && ++attempts === 1) {
          return { ok: false, reason: "revision-mismatch" };
        }
        return inner.transition(value);
      },
    }) });
    expect((await respond(h)).disposition).toBe("complete");
    expect(attempts).toBe(2);
    expect(h.state.calls.signature).toBe(1);
    expect(h.state.calls.publication).toBe(1);
    expect(await respond(h)).toMatchObject({ disposition: "complete", recovered: true });
  });

  test.each(Object.values(KEY))("accepts an identical concurrent outcome for %s", async (key) => {
    const inner = createInMemoryFencedSessionStore();
    let raced = false;
    const h = await harness({ store: wrap(inner, {
      transition: async (value) => {
        const result = await inner.transition(value);
        if (!raced && value.checkpoint?.key === key && value.checkpoint.stage === "outcome" && result.ok) {
          raced = true;
          return { ok: false, reason: "checkpoint-state", record: result.record };
        }
        return result;
      },
    }) });
    expect((await respond(h)).disposition).toBe("complete");
    expect(raced).toBe(true);
    expect(await respond(h)).toMatchObject({ disposition: "complete", recovered: true });
    expect(h.state.calls.signature).toBe(1);
    expect(h.state.calls.publication).toBe(1);
  });

  test.each([false, true])("an outcome already stored during the claim is checked (conflicting=%s)", async (conflicting) => {
    const inner = createInMemoryFencedSessionStore();
    let raced = false;
    const h = await harness({ store: wrap(inner, {
      claimCheckpoint: async (value) => {
        const claimed = await inner.claimCheckpoint(value);
        if (!raced && value.key === KEY.proposal && claimed.ok) {
          raced = true;
          const completed = await inner.transition({
            jobId: value.jobId, expectedRevision: claimed.record.revision,
            leaseToken: value.leaseToken, now: value.now,
            checkpoint: { key: value.key, stage: "outcome", data: {
              ...value.data, ...(conflicting ? { contextHash: "f".repeat(64) } : {}),
            } },
          });
          expect(completed.ok).toBe(true);
        }
        return claimed;
      },
    }) });
    expect(await respond(h)).toMatchObject({ disposition: conflicting ? "rejected" : "complete" });
    expect(raced).toBe(true);
    expect(h.state.calls.signature).toBe(conflicting ? 0 : 1);
    expect(h.state.calls.publication).toBe(conflicting ? 0 : 1);
  });

  test.each(["missing", "conflicting"] as const)("refuses a %s durable intent during completion", async (fault) => {
    const inner = createInMemoryFencedSessionStore();
    let claimed = false;
    const h = await harness({ store: wrap(inner, {
      claimCheckpoint: async (value) => {
        const result = await inner.claimCheckpoint(value);
        if (value.key === KEY.proposal) claimed = true;
        return result;
      },
      load: async (jobId) => {
        const loaded = await inner.load(jobId);
        if (!claimed || loaded.status !== "ok") return loaded;
        const record = structuredClone(loaded.record);
        if (fault === "missing") record.checkpoints = [];
        else record.checkpoints.push({ key: KEY.proposal, stage: "outcome", data: { contextHash: "substituted" } });
        return { ...loaded, record };
      },
    }) });
    expect(await respond(h)).toMatchObject({ disposition: "rejected", stage: "proposal" });
    expect(h.state.calls.signature).toBe(0);
    expect(h.state.calls.publication).toBe(0);
  });

  test("binds a fresh unbound session to this agreement before signing", async () => {
    const h = await harness();
    await h.store.create({ jobId: h.context.jobId, now: NOW });
    expect((await respond(h)).disposition).toBe("complete");
    const loaded = await h.store.load(h.context.jobId);
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") expect(loaded.record.agreementHash).toBe(h.request.plan.agreementHash);
  });

  test.each(["generation", "checkpoints"] as const)("refuses rebinding an unbound session with prior %s", async (prior) => {
    const inner = createInMemoryFencedSessionStore();
    const h = await harness({ store: wrap(inner, {
      load: async (jobId) => {
        const loaded = await inner.load(jobId);
        if (loaded.status !== "ok") return loaded;
        const record = structuredClone(loaded.record);
        if (prior === "generation") record.leaseGeneration = 1;
        else record.checkpoints.push({ key: "unrelated", stage: "intent" });
        return { ...loaded, record };
      },
    }) });
    await inner.create({ jobId: h.context.jobId, now: NOW });
    expect(await respond(h)).toMatchObject({ disposition: "rejected", stage: "proposal" });
    expect(h.state.calls.signature).toBe(0);
    expect(h.state.calls.publication).toBe(0);
  });

  test.each([
    { ok: false }, { ok: false, boundTo: SUBSTITUTE_JOB_ID }, { ok: true, boundTo: SUBSTITUTE_JOB_ID },
  ])("refuses an unbound session when bindHash returns %j", async (binding) => {
    const inner = createInMemoryFencedSessionStore();
    const h = await harness({ store: wrap(inner, { bindHash: async () => binding }) });
    await inner.create({ jobId: h.context.jobId, now: NOW });
    expect(await respond(h)).toMatchObject({ disposition: "rejected", stage: "proposal" });
    expect(h.state.calls.signature).toBe(0);
  });

  test.each([
    ["substrate", new SubstrateError("store unavailable"), "indeterminate"],
    ["DACS", new DacsError("invalid durable binding"), "rejected"],
  ] as const)("maps a %s error without signing", async (_name, error, disposition) => {
    const inner = createInMemoryFencedSessionStore();
    const h = await harness({ store: wrap(inner, { load: async () => { throw error; } }) });
    expect(await respond(h)).toMatchObject({ disposition, stage: disposition === "rejected" ? "proposal" : "lease" });
    expect(h.state.calls.signature).toBe(0);
    expect(h.state.calls.publication).toBe(0);
  });

  test("propagates an unexpected store error", async () => {
    const inner = createInMemoryFencedSessionStore();
    const error = new Error("unexpected store error");
    const h = await harness({ store: wrap(inner, { load: async () => { throw error; } }) });
    await expect(respond(h)).rejects.toBe(error);
    expect(h.state.calls.signature).toBe(0);
  });

  test.each(["corrupt", "unsupported"] as const)("maps %s store data to indeterminate", async (status) => {
    const inner = createInMemoryFencedSessionStore();
    const h = await harness({ store: wrap(inner, {
      load: async () => status === "corrupt" ? { status, reason: "broken record" } : { status, version: 99 },
    }) });
    expect(await respond(h)).toMatchObject({ disposition: "indeterminate", stage: "lease" });
    expect(h.state.calls.signature).toBe(0);
  });

  test("a create race recovers the winner's session", async () => {
    const inner = createInMemoryFencedSessionStore();
    const h = await harness({ store: wrap(inner, { create: async (value) => {
      await inner.create(value);
      throw new SubstrateError("another creator won");
    } }) });
    expect((await respond(h)).disposition).toBe("complete");
    expect(h.state.calls.signature).toBe(1);
  });

  test.each(["not-found", "lease-fenced"] as const)("maps acquisition failure %s to indeterminate", async (reason) => {
    const inner = createInMemoryFencedSessionStore();
    const h = await harness({ store: wrap(inner, { acquireLease: async () => ({ ok: false, reason }) }) });
    expect(await respond(h)).toMatchObject({ disposition: "indeterminate", stage: "lease" });
    expect(h.state.calls.signature).toBe(0);
  });

  test.each(["not-found", "lease-fenced"] as const)("maps checkpoint claim failure %s to indeterminate", async (reason) => {
    const inner = createInMemoryFencedSessionStore();
    const h = await harness({ store: wrap(inner, { claimCheckpoint: async () => ({ ok: false, reason }) }) });
    expect(await respond(h)).toMatchObject({ disposition: "indeterminate", stage: "lease" });
    expect(h.state.calls.signature).toBe(0);
  });

  test.each(["proposal", "sellerSignature", "publication", "result"] as const)(
    "terminal recovery requires both data and an outcome for %s", async (member) => {
      for (const missing of ["data", "outcome"] as const) {
        const inner = createInMemoryFencedSessionStore();
        let tamper = false;
        const h = await harness({ store: wrap(inner, { load: async (jobId) => {
          const loaded = await inner.load(jobId);
          if (!tamper || loaded.status !== "ok") return loaded;
          const record: RecordValue = structuredClone(loaded.record);
          const key = KEY[member];
          if (missing === "outcome") record.checkpoints = record.checkpoints.filter((c) => c.key !== key || c.stage !== "outcome");
          else for (const c of record.checkpoints) if (c.key === key && c.stage === "outcome") delete c.data;
          return { ...loaded, record };
        } }) });
        expect((await respond(h)).disposition).toBe("complete");
        tamper = true;
        expect(await respond(h), `${member} ${missing}`).toMatchObject({ disposition: "rejected", stage: "proposal" });
        expect(h.state.calls.signature).toBe(1);
        expect(h.state.calls.publication).toBe(1);
      }
    },
  );
});

describe("seller responder remaining boundary outcomes", () => {
  const respond = (h: Awaited<ReturnType<typeof harness>>) =>
    respondToFixedPriceAgreementProposalDurable(h.request.input, h.durability);

  test.each(["proposal", "transportIdentity"] as const)("malformed nested %s is rejected before context resolution", async (key) => {
    for (const value of [null, [], "malformed"]) {
      const h = await harness();
      Object.assign(h.request.input, { [key]: value });
      expect(await respond(h)).toMatchObject({ disposition: "rejected", stage: "proposal" });
      expect(h.state.calls.context).toBe(0);
      expect(h.state.calls.signature).toBe(0);
      expect(h.state.calls.publication).toBe(0);
    }
  });

  test.each(["jobId", "verifiedListing", "buyer", "seller", "generatedAt"] as const)(
    "a context missing %s is indeterminate before derivation", async (key) => {
      const h = await harness();
      const context: Record<string, unknown> = structuredClone(h.context) as unknown as Record<string, unknown>;
      delete context[key];
      h.durability.resolveAuthenticatedAgreementContext = () => ({ disposition: "present", value: context as never });
      expect(await respond(h)).toMatchObject({ disposition: "indeterminate", stage: "context" });
      expect(h.state.calls.verifyBuyer).toBe(0);
      expect(h.state.calls.signature).toBe(0);
      expect(h.state.calls.publication).toBe(0);
    },
  );

  test.each([null, [], "context"])("a present context containing %j is malformed", async (value) => {
    const h = await harness();
    h.durability.resolveAuthenticatedAgreementContext = () => ({ disposition: "present", value: value as never });
    expect(await respond(h)).toMatchObject({ disposition: "indeterminate", stage: "context" });
    expect(h.state.calls.signature).toBe(0);
    expect(h.state.calls.publication).toBe(0);
  });

  test.each<[string, () => unknown]>([
    ["Proxy", () => new Proxy(new Uint8Array(64), {})],
    ["subclass", () => new (class extends Uint8Array {})(64)],
  ])("refuses a %s signature object without invoking its traps", async (_label, value) => {
    const h = await harness();
    h.request.input.seller.sign = () => value() as never;
    expect(await respond(h)).toMatchObject({ disposition: "indeterminate", stage: "seller-signature" });
    expect(h.state.calls.publication).toBe(0);
  });

  test("a rehashed proposal with an extra buyer contribution member is refused before verification", async () => {
    const h = await harness();
    const material = {
      proposalVersion: "1" as const,
      plan: h.request.plan,
      buyerContribution: { ...h.request.buyerContribution, extra: true },
    };
    const proposalHash = sha256Hex(canonicalize(material));
    h.request.input.proposal = { ...material, proposalHash };
    h.request.input.transportIdentity = { ...h.request.input.transportIdentity, proposalHash };
    expect(await respond(h)).toMatchObject({ disposition: "rejected", stage: "buyer-contribution" });
    expect(h.state.calls.verifyBuyer).toBe(0);
    expect(h.state.calls.signature).toBe(0);
    expect(h.state.calls.publication).toBe(0);
  });

  test.each(["context", "buyer verifier", "seller verifier", "signature reconciliation", "publication reconciliation"] as const)(
    "a thrown %s error stays indeterminate", async (source) => {
      const h = await harness();
      const fail = () => { throw new Error("callback unavailable"); };
      if (source === "context") h.durability.resolveAuthenticatedAgreementContext = fail;
      if (source === "buyer verifier") h.durability.verifyContribution = fail;
      if (source === "seller verifier") {
        const verify = h.durability.verifyContribution;
        h.durability.verifyContribution = (value) => value.role === "seller" ? fail() : verify(value);
      }
      if (source === "signature reconciliation") {
        h.state.lost.add("signature");
        expect((await respond(h)).disposition).toBe("indeterminate");
        h.durability.reconcileSellerSignature = fail;
      }
      if (source === "publication reconciliation") h.durability.transport.reconcileSellerContributionPublication = fail;
      expect(await respond(h)).toMatchObject({ disposition: "indeterminate", stage:
        source === "context" ? "context" : source === "buyer verifier" ? "buyer-contribution" :
          source === "publication reconciliation" ? "contribution-publication" : "seller-signature",
      });
      expect(h.state.calls.signature).toBe(["seller verifier", "signature reconciliation", "publication reconciliation"].includes(source) ? 1 : 0);
      expect(h.state.calls.publication).toBe(0);
    },
  );

  test("a substituted contribution observed after submission is rejected", async () => {
    const h = await harness();
    const reconcile = h.durability.transport.reconcileSellerContributionPublication;
    let calls = 0;
    h.durability.transport.reconcileSellerContributionPublication = (...args) => {
      if (++calls === 1) return reconcile(...args);
      return { disposition: "present", value: { substituted: true } };
    };
    expect(await respond(h)).toMatchObject({ disposition: "rejected", stage: "contribution-publication" });
    expect(h.state.calls.signature).toBe(1);
    expect(h.state.calls.publication).toBe(1);
  });

  test.each(["string", "Uint8Array", "Buffer"] as const)("restores a retained signature encoded as %s", async (format) => {
    const h = await harness();
    h.state.lost.add("signature");
    expect((await respond(h)).disposition).toBe("indeterminate");
    const bytes = h.state.signature as Uint8Array;
    h.durability.reconcileSellerSignature = () => ({ disposition: "present", value:
      format === "string" ? Buffer.from(bytes).toString("base64url") : format === "Buffer" ? Buffer.from(bytes) : bytes,
    });
    expect((await respond(h)).disposition).toBe("complete");
    expect(h.state.calls.signature).toBe(1);
    expect(h.state.calls.publication).toBe(1);
  });

  test.each([null, [], {}, new Int8Array(64)])("a present reconciliation with invalid signature %j is indeterminate", async (value) => {
    const h = await harness();
    h.state.lost.add("signature");
    expect((await respond(h)).disposition).toBe("indeterminate");
    h.durability.reconcileSellerSignature = () => ({ disposition: "present", value: value as never });
    expect(await respond(h)).toMatchObject({ disposition: "indeterminate", stage: "seller-signature" });
    expect(h.state.calls.signature).toBe(1);
    expect(h.state.calls.publication).toBe(0);
  });

  test.each([-1, -0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("invalid lease clock %s is refused before effects", async (value) => {
    const h = await harness();
    h.durability.leaseNowMs = () => value;
    expect(await respond(h)).toMatchObject({ disposition: "rejected", stage: "proposal" });
    expect(h.state.calls.signature).toBe(0);
    expect(h.state.calls.publication).toBe(0);
  });

  test.each(["party", "algorithm"] as const)("malformed local seller %s is rejected before context resolution", async (key) => {
    for (const value of [null, 1, "", " unsupported "]) {
      const h = await harness();
      Object.assign(h.request.input.seller, { [key]: value });
      expect(await respond(h)).toMatchObject({ disposition: "rejected", stage: "proposal" });
      expect(h.state.calls.context).toBe(0);
      expect(h.state.calls.signature).toBe(0);
    }
  });

  test.each(["workerId", "leaseTtlMs"] as const)("malformed durability %s is a configuration error", async (key) => {
    for (const value of key === "workerId" ? ["", " padded ", 1, null] : [0, -1, 0.5, "100"]) {
      const h = await harness();
      Object.assign(h.durability, { [key]: value });
      await expect(respond(h)).rejects.toThrow(/workerId and positive leaseTtlMs/);
      expect(h.state.calls.context).toBe(0);
      expect(h.state.calls.signature).toBe(0);
    }
  });
});
