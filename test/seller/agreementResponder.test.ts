import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

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
