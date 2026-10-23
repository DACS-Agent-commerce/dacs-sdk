import { describe, expect, test } from "vitest";

import type {
  BundlePartyRole,
  IdentityBundle,
} from "../../src/artifacts/types.js";
import { createInMemoryFencedSessionStore, type FencedSessionStoreV2 } from "../../src/agent/fencedSessionStore.js";
import {
  advanceTerminalBundleDurable,
  getTerminalBundleFinalizationStatus,
  verifyFinalizedTerminalBundleReadOnly,
  type DurableTerminalBundleInput,
  type DurableTerminalBundleProvider,
  type TerminalBundleAnchorPublication,
  type TerminalBundleFinalizationDurability,
  type TerminalBundleTransport,
} from "../../src/agent/durableTerminalBundleFinalization.js";
import {
  createTerminalBundleAuthority,
  createTerminalBundlePlan,
  createTerminalBundleSignatureContribution,
  terminalBundleSignedBytes,
  type TerminalBundleAuthority,
  type TerminalBundlePlan,
  type TerminalBundleSignatureContribution,
  type TerminalBundleSignerPublicKey,
  type TerminalBundleSigningMode,
} from "../../src/agent/terminalBundleFinalization.js";
import {
  ed25519Sign,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
} from "../../src/crypto/index.js";
import { DacsError } from "../../src/errors.js";

const NOW = 1_786_300_000_000;
const ROLES = ["buyer", "seller", "orchestrator"] as const;
const CLAIMS: Record<BundlePartyRole, string> = {
  buyer: "did:demos:durable-terminal-buyer",
  seller: "did:demos:durable-terminal-seller",
  orchestrator: "did:demos:durable-terminal-orchestrator",
};
const SEED: Record<BundlePartyRole, number> = {
  buyer: 91,
  seller: 92,
  orchestrator: 93,
};

function seed(role: BundlePartyRole): Uint8Array {
  return new Uint8Array(32).fill(SEED[role]);
}

function identity(role: BundlePartyRole): IdentityBundle {
  return {
    bundleVersion: "1",
    presentedBy: CLAIMS[role],
    presentedAt: NOW - 10,
    sessionNonce: `terminal-${role}`,
    claims: [{ ref: CLAIMS[role], metadata: { role } }],
    presentation: {
      kind: "session-key",
      key: `session-key-${role}`,
      signature: `presentation-${role}`,
    },
  };
}

function failureAuthority(jobId = "durable-terminal-81"): Readonly<TerminalBundleAuthority> {
  return createTerminalBundleAuthority({
    jobId,
    terminalClass: "failure",
    faultedParty: "seller",
    terminalPhase: {
      index: 2,
      kind: "pay-x402",
      state: "failed",
      errorClass: "counterparty",
    },
    sessionRecordHash: "1".repeat(64),
    terminalEvidenceHash: "2".repeat(64),
    dependencySetHash: "3".repeat(64),
    listingRef: {
      listingId: "durable-terminal-listing",
      version: 1,
      contentHash: "4".repeat(64),
    },
    agreementRef: {
      anchor: { kind: "storage-program", locator: "dacs3:agreement:durable-terminal" },
      contentHash: "5".repeat(64),
    },
    parties: ROLES.map((role) => ({ role, identityBundle: identity(role) })),
    phaseSummary: [
      { index: 0, kind: "vet-credentials", outcome: "ok" },
      { index: 1, kind: "commit-agreement", outcome: "ok" },
      {
        index: 2,
        kind: "pay-x402",
        outcome: "fail",
        errorClass: "counterparty",
      },
    ],
    vetRecords: [],
    settlementEvidence: [],
    recipeRegistryVersion: 1,
    railRegistryVersion: 1,
    finalisedAt: NOW,
  });
}

function abortAuthority(jobId: string): Readonly<TerminalBundleAuthority> {
  return createTerminalBundleAuthority({
    jobId,
    terminalClass: "abort",
    faultedParty: "seller",
    terminalPhase: { index: 2, kind: "commit-agreement", state: "pending" },
    sessionRecordHash: "6".repeat(64),
    terminalEvidenceHash: "7".repeat(64),
    dependencySetHash: "8".repeat(64),
    listingRef: {
      listingId: "durable-terminal-listing",
      version: 1,
      contentHash: "4".repeat(64),
    },
    parties: ROLES.map((role) => ({ role, identityBundle: identity(role) })),
    phaseSummary: [
      { index: 0, kind: "vet-credentials", outcome: "ok" },
      { index: 1, kind: "negotiate-fixed-price", outcome: "ok" },
    ],
    vetRecords: [],
    settlementEvidence: [],
    recipeRegistryVersion: 1,
    railRegistryVersion: 1,
    finalisedAt: NOW,
    abortEligibility: {
      trigger: "withdrawn",
      triggeredBy: "seller",
      triggerEvidenceHash: "9".repeat(64),
      observedAt: NOW - 1,
      payment: { disposition: "not-reached" },
      delivery: { disposition: "not-reached" },
    },
  });
}

function signerKeys(plan: Readonly<TerminalBundlePlan>): TerminalBundleSignerPublicKey[] {
  return plan.requiredSigners.map(({ role, primaryClaim }) => ({
    role,
    primaryClaim,
    algorithm: "ed25519",
    publicKey: new Uint8Array(rawPublicKey(publicKeyFromSeed(seed(role)))),
  }));
}

function detachedContribution(
  plan: Readonly<TerminalBundlePlan>,
  signerRole: BundlePartyRole,
  signingRole: BundlePartyRole = signerRole,
): Readonly<TerminalBundleSignatureContribution> {
  return createTerminalBundleSignatureContribution(
    plan,
    signerRole,
    plan.copies.map((copy) => ({
      copyRole: copy.role,
      value: Buffer.from(
        ed25519Sign(
          terminalBundleSignedBytes(copy),
          privateKeyFromSeed(seed(signingRole)),
        ),
      ).toString("base64url"),
    })),
  );
}

interface SharedTransportState {
  proposal?: Readonly<TerminalBundlePlan>;
  contributions: Map<BundlePartyRole, Readonly<TerminalBundleSignatureContribution>>;
  proposalPublishes: number;
  contributionPublishes: Record<BundlePartyRole, number>;
}

function transportState(): SharedTransportState {
  return {
    contributions: new Map(),
    proposalPublishes: 0,
    contributionPublishes: { buyer: 0, seller: 0, orchestrator: 0 },
  };
}

function transport(state: SharedTransportState): TerminalBundleTransport {
  return {
    resolveProposal: () =>
      state.proposal
        ? { disposition: "present", value: structuredClone(state.proposal) }
        : { disposition: "authoritatively-absent", reason: "no proposal" },
    publishProposal: ({ plan }) => {
      state.proposalPublishes += 1;
      state.proposal = structuredClone(plan);
    },
    resolveContribution: ({ signerRole }) => {
      const contribution = state.contributions.get(signerRole);
      return contribution
        ? { disposition: "present", value: structuredClone(contribution) }
        : { disposition: "authoritatively-absent", reason: `no ${signerRole} row` };
    },
    publishContribution: ({ contribution }) => {
      state.contributionPublishes[contribution.signerRole] += 1;
      state.contributions.set(contribution.signerRole, structuredClone(contribution));
    },
  };
}

function concurrentProposalHarness(state: SharedTransportState): {
  transport: TerminalBundleTransport;
  proposalKeys: Set<string>;
  publishAttempts: () => number;
} {
  const base = transport(state);
  const proposalKeys = new Set<string>();
  let initialAbsentReads = 0;
  let attempts = 0;
  let release!: () => void;
  const allReadAbsent = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    proposalKeys,
    publishAttempts: () => attempts,
    transport: {
      ...base,
      resolveProposal: async () => {
        if (state.proposal) {
          return { disposition: "present", value: structuredClone(state.proposal) };
        }
        initialAbsentReads += 1;
        if (initialAbsentReads === ROLES.length) release();
        await allReadAbsent;
        return {
          disposition: "authoritatively-absent",
          reason: "concurrent proposal snapshot was absent",
        };
      },
      publishProposal: ({ plan }, fence) => {
        attempts += 1;
        if (!proposalKeys.has(fence.idempotencyKey)) {
          proposalKeys.add(fence.idempotencyKey);
          state.proposalPublishes += 1;
          state.proposal = structuredClone(plan);
        }
      },
    },
  };
}

interface RoleEffects {
  publication?: TerminalBundleAnchorPublication;
  binding?: Parameters<DurableTerminalBundleProvider["publishOwnBundleBinding"]>[0];
  anchorSubmits: number;
  bindingPublishes: number;
  signerCalls: number;
  signatures: Map<string, string>;
}

function roleEffects(): RoleEffects {
  return {
    anchorSubmits: 0,
    bindingPublishes: 0,
    signerCalls: 0,
    signatures: new Map(),
  };
}

function provider(role: BundlePartyRole, effects: RoleEffects): DurableTerminalBundleProvider {
  return {
    resolveOwnBundle: () =>
      effects.publication
        ? { disposition: "present", value: structuredClone(effects.publication) }
        : { disposition: "authoritatively-absent", reason: "no bundle" },
    submitOwnBundle: ({ logicalAddress, bundle }) => {
      effects.anchorSubmits += 1;
      const nativeAddress = `native:${role}:${bundle.jobId}`;
      const anchorTx = `tx:${role}:${bundle.jobId}`;
      effects.publication = {
        role,
        logicalAddress,
        nativeAddress,
        bundleContentHash: createTerminalBundlePlan(
          failureAuthority(bundle.jobId),
          { kind: "co-signed" },
        ).copies.find((copy) => copy.role === role)?.bundleContentHash ?? "0".repeat(64),
        bundle: structuredClone(bundle),
        anchorTx,
        anchorReceipt: {
          receiptVersion: "1",
          substrate: "test",
          finalityProfile: "test-finality",
          logicalAddress,
          nativeAddress,
          contentHash: createTerminalBundlePlan(
            failureAuthority(bundle.jobId),
            { kind: "co-signed" },
          ).copies.find((copy) => copy.role === role)?.bundleContentHash ?? "0".repeat(64),
          transactionRef: { kind: "test", value: anchorTx },
          writer: CLAIMS[role],
          state: "finalized",
          observationDisposition: "established",
          observedAt: NOW + 1,
          blockRef: { id: `block:${role}`, height: "1", timestamp: NOW },
          evidence: { kind: "test", value: `proof:${role}` },
        },
      };
    },
    verifyOwnBundlePublication: () => ({ disposition: "valid" }),
    resolveOwnBundleBinding: () =>
      effects.binding
        ? { disposition: "present", value: structuredClone(effects.binding) }
        : { disposition: "authoritatively-absent", reason: "no binding" },
    publishOwnBundleBinding: (binding) => {
      effects.bindingPublishes += 1;
      effects.binding = structuredClone(binding);
    },
    verifyOwnBundleBinding: () => ({ disposition: "valid" }),
  };
}

function abortProvider(role: BundlePartyRole, effects: RoleEffects): DurableTerminalBundleProvider {
  const base = provider(role, effects);
  return {
    ...base,
    submitOwnBundle: ({ logicalAddress, bundle }) => {
      effects.anchorSubmits += 1;
      const nativeAddress = `native:${role}:${bundle.jobId}`;
      const anchorTx = `tx:${role}:${bundle.jobId}`;
      const hash = createTerminalBundlePlan(
        abortAuthority(bundle.jobId),
        { kind: "single-signed-abort", signerRole: role },
      ).copies[0]!.bundleContentHash;
      effects.publication = {
        role,
        logicalAddress,
        nativeAddress,
        bundleContentHash: hash,
        bundle: structuredClone(bundle),
        anchorTx,
        anchorReceipt: {
          receiptVersion: "1",
          substrate: "test",
          finalityProfile: "test-finality",
          logicalAddress,
          nativeAddress,
          contentHash: hash,
          transactionRef: { kind: "test", value: anchorTx },
          writer: CLAIMS[role],
          state: "finalized",
          observationDisposition: "established",
          observedAt: NOW + 1,
          blockRef: { id: `block:${role}`, height: "1", timestamp: NOW },
          evidence: { kind: "test", value: `proof:${role}` },
        },
      };
    },
  };
}

function durableInput(
  authority: Readonly<TerminalBundleAuthority>,
  signingMode: Readonly<TerminalBundleSigningMode>,
  role: BundlePartyRole,
  effects: RoleEffects,
): DurableTerminalBundleInput {
  const plan = createTerminalBundlePlan(authority, signingMode);
  return {
    authority,
    signingMode,
    local: {
      role,
      primaryClaim: CLAIMS[role],
      signer: (bytes, fence) => {
        effects.signerCalls += 1;
        const value = Buffer.from(
          ed25519Sign(bytes, privateKeyFromSeed(seed(role))),
        ).toString("base64url");
        effects.signatures.set(fence.idempotencyKey, value);
        return value;
      },
    },
    signerKeys: signerKeys(plan),
  };
}

function durability(
  store: FencedSessionStoreV2,
  state: SharedTransportState,
  effects: RoleEffects,
  workerId: string,
): TerminalBundleFinalizationDurability {
  return {
    store,
    workerId,
    leaseTtlMs: 100,
    leaseNowMs: () => NOW,
    transport: transport(state),
    reconcileSignature: (_input, fence) => {
      const value = effects.signatures.get(fence.idempotencyKey);
      return value
        ? { disposition: "present", value }
        : { disposition: "authoritatively-absent", reason: "not signed" };
    },
  };
}

function crashOnceBeforeOutcome(
  store: FencedSessionStoreV2,
  checkpointSuffix: string,
): FencedSessionStoreV2 {
  let crashed = false;
  return {
    apiVersion: store.apiVersion,
    create: (input) => store.create(input),
    load: (jobId) => store.load(jobId),
    transition: (input) => {
      if (
        !crashed &&
        input.checkpoint?.stage === "outcome" &&
        input.checkpoint.key.endsWith(checkpointSuffix)
      ) {
        crashed = true;
        throw new Error(`simulated crash before ${checkpointSuffix} outcome`);
      }
      return store.transition(input);
    },
    claimCheckpoint: (input) => store.claimCheckpoint(input),
    acquireLease: (input) => store.acquireLease(input),
    renewLease: (input) => store.renewLease(input),
    bindSessionAuthorization: (input) => store.bindSessionAuthorization(input),
    bindHash: (input) => store.bindHash(input),
    list: (filter) => store.list(filter),
  };
}

function malformedFinalLoadStore(store: FencedSessionStoreV2): FencedSessionStoreV2 {
  return {
    ...store,
    load: async (jobId) => {
      const loaded = await store.load(jobId);
      return loaded.status === "ok"
        ? {
            status: "ok" as const,
            record: {
              ...loaded.record,
              phase: "terminal:buyer:finalised",
            },
          }
        : loaded;
    },
  };
}

function preExistingUnsealedResultStore(store: FencedSessionStoreV2): FencedSessionStoreV2 {
  return {
    ...store,
    claimCheckpoint: async (input) => {
      if (input.key !== "terminal:buyer:result") {
        return store.claimCheckpoint(input);
      }
      const loaded = await store.load(input.jobId);
      if (loaded.status !== "ok") return store.claimCheckpoint(input);
      const record = structuredClone(loaded.record);
      record.phase = "buyer:finalised";
      delete record.lease;
      record.checkpoints.push(
        { key: input.key, stage: "intent", ...(input.data ? { data: input.data } : {}) },
        { key: input.key, stage: "outcome", ...(input.data ? { data: input.data } : {}) },
      );
      record.receipts.push({
        kind: "bundle",
        ref: String(input.data?.nativeAddress),
      });
      return { ok: false as const, reason: "completed" as const, record };
    },
  };
}

function concurrentWrongReceiptStore(store: FencedSessionStoreV2): FencedSessionStoreV2 {
  let resultIntentData: Parameters<FencedSessionStoreV2["claimCheckpoint"]>[0]["data"];
  let forgeFinalOnLoad = false;
  return {
    ...store,
    claimCheckpoint: async (input) => {
      const claimed = await store.claimCheckpoint(input);
      if (claimed.ok && input.key === "terminal:buyer:result") {
        resultIntentData = structuredClone(input.data);
        forgeFinalOnLoad = true;
      }
      return claimed;
    },
    load: async (jobId) => {
      const loaded = await store.load(jobId);
      if (!forgeFinalOnLoad || loaded.status !== "ok") return loaded;
      forgeFinalOnLoad = false;
      const record = structuredClone(loaded.record);
      record.phase = "terminal:buyer:finalised";
      delete record.lease;
      record.checkpoints.push({
        key: "terminal:buyer:result",
        stage: "outcome",
        ...(resultIntentData ? { data: resultIntentData } : {}),
      });
      record.receipts.push({ kind: "bundle", ref: "wrong-native-address" });
      return { status: "ok" as const, record };
    },
  };
}

describe("durable role-local terminal bundle finalization", () => {
  test("completes the three-role co-signed matrix bottom-up and replays read-only", async () => {
    const authority = failureAuthority();
    const mode = { kind: "co-signed" } as const;
    const shared = transportState();
    const roles = Object.fromEntries(
      await Promise.all(ROLES.map(async (role) => {
        const store = createInMemoryFencedSessionStore();
        await store.create({
          jobId: authority.jobId,
          phase: role === "seller" ? "seller:failed" : "created",
          now: NOW - 1,
        });
        return [role, { store, effects: roleEffects() }] as const;
      })),
    ) as Record<BundlePartyRole, { store: FencedSessionStoreV2; effects: RoleEffects }>;

    const buyerFirst = await advanceTerminalBundleDurable(
      durableInput(authority, mode, "buyer", roles.buyer.effects),
      provider("buyer", roles.buyer.effects),
      durability(roles.buyer.store, shared, roles.buyer.effects, "buyer-worker-1"),
    );
    expect(buyerFirst).toMatchObject({
      disposition: "waiting",
      stage: "contribution-publication",
    });
    const sellerFirst = await advanceTerminalBundleDurable(
      durableInput(authority, mode, "seller", roles.seller.effects),
      provider("seller", roles.seller.effects),
      durability(roles.seller.store, shared, roles.seller.effects, "seller-worker-1"),
    );
    expect(sellerFirst).toMatchObject({ disposition: "waiting" });
    const orchestrator = await advanceTerminalBundleDurable(
      durableInput(authority, mode, "orchestrator", roles.orchestrator.effects),
      provider("orchestrator", roles.orchestrator.effects),
      durability(
        roles.orchestrator.store,
        shared,
        roles.orchestrator.effects,
        "orchestrator-worker",
      ),
    );
    expect(orchestrator).toMatchObject({ disposition: "finalised", recovered: false });

    for (const role of ["buyer", "seller"] as const) {
      const outcome = await advanceTerminalBundleDurable(
        durableInput(authority, mode, role, roles[role].effects),
        provider(role, roles[role].effects),
        durability(roles[role].store, shared, roles[role].effects, `${role}-worker-2`),
      );
      expect(outcome).toMatchObject({ disposition: "finalised", recovered: false });
      if (outcome.disposition !== "finalised") continue;
      expect(outcome.result.role).toBe(role);
      expect(outcome.result.bundle.anchoredByRole).toBe(role);
      expect(outcome.result.bundle.signatures).toHaveLength(3);
      const replay = await verifyFinalizedTerminalBundleReadOnly(
        {
          authority,
          signingMode: mode,
          local: { role, primaryClaim: CLAIMS[role] },
          signerKeys: signerKeys(createTerminalBundlePlan(authority, mode)),
        },
        provider(role, roles[role].effects),
        roles[role].store,
      );
      expect(replay).toMatchObject({ disposition: "finalised", recovered: true });
      expect(replay.disposition === "finalised" && Object.isFrozen(replay.result)).toBe(true);
      if (role === "buyer") {
        const unavailable = await verifyFinalizedTerminalBundleReadOnly(
          {
            authority,
            signingMode: mode,
            local: { role, primaryClaim: CLAIMS[role] },
            signerKeys: signerKeys(createTerminalBundlePlan(authority, mode)),
          },
          {
            ...provider(role, roles[role].effects),
            resolveOwnBundle: () => ({
              disposition: "indeterminate",
              reason: "authenticated anchor read unavailable",
            }),
          },
          roles[role].store,
        );
        expect(unavailable).toMatchObject({
          disposition: "indeterminate",
          stage: "terminal-recovery",
        });
      }
    }

    expect(shared.proposalPublishes).toBe(1);
    expect(shared.contributionPublishes).toEqual({ buyer: 1, seller: 1, orchestrator: 1 });
    for (const role of ROLES) {
      expect(roles[role].effects.anchorSubmits).toBe(1);
      expect(roles[role].effects.bindingPublishes).toBe(1);
      expect(roles[role].effects.signerCalls).toBe(4);
      const status = await getTerminalBundleFinalizationStatus(
        roles[role].store,
        authority.jobId,
        role,
      );
      expect(status).toMatchObject({
        status: "ok",
        phase: `terminal:${role}:finalised`,
        signatureOutcomes: 3,
        contributionOutcomes: 3,
      });
    }
  }, 30_000);

  test("deduplicates concurrent three-role proposal publication with one shared key", async () => {
    const authority = failureAuthority("durable-concurrent-proposal-81");
    const mode = { kind: "co-signed" } as const;
    const shared = transportState();
    const proposal = concurrentProposalHarness(shared);
    const roles = Object.fromEntries(
      await Promise.all(ROLES.map(async (role) => {
        const store = createInMemoryFencedSessionStore();
        const effects = roleEffects();
        await store.create({
          jobId: authority.jobId,
          phase: role === "seller" ? "seller:failed" : "created",
          now: NOW - 1,
        });
        return [role, { store, effects }] as const;
      })),
    ) as Record<BundlePartyRole, { store: FencedSessionStoreV2; effects: RoleEffects }>;

    const outcomes = await Promise.all(ROLES.map((role) => {
      const base = durability(
        roles[role].store,
        shared,
        roles[role].effects,
        `${role}-concurrent-worker`,
      );
      return advanceTerminalBundleDurable(
        durableInput(authority, mode, role, roles[role].effects),
        provider(role, roles[role].effects),
        { ...base, transport: proposal.transport },
      );
    }));

    expect(proposal.publishAttempts()).toBe(3);
    expect(proposal.proposalKeys.size).toBe(1);
    expect(shared.proposalPublishes).toBe(1);
    expect(outcomes.every(
      (outcome) => outcome.disposition === "finalised" || outcome.disposition === "waiting",
    )).toBe(true);
  });

  test("cold restart accepts the identical signer role set in a different caller order", async () => {
    const authority = failureAuthority("durable-reordered-keys-81");
    const mode = { kind: "co-signed" } as const;
    const shared = transportState();
    const store = createInMemoryFencedSessionStore();
    const effects = roleEffects();
    await store.create({ jobId: authority.jobId, now: NOW - 1 });

    const first = await advanceTerminalBundleDurable(
      durableInput(authority, mode, "buyer", effects),
      provider("buyer", effects),
      durability(store, shared, effects, "ordered-key-worker"),
    );
    expect(first).toMatchObject({
      disposition: "waiting",
      stage: "contribution-publication",
    });

    const reordered = durableInput(authority, mode, "buyer", effects);
    const second = await advanceTerminalBundleDurable(
      { ...reordered, signerKeys: [...reordered.signerKeys].reverse() },
      provider("buyer", effects),
      durability(store, shared, effects, "reordered-key-worker"),
    );
    expect(second).toMatchObject({
      disposition: "waiting",
      stage: "contribution-publication",
    });
    expect(effects.signerCalls).toBe(3);
    expect(shared.proposalPublishes).toBe(1);
    expect(shared.contributionPublishes.buyer).toBe(1);
  });

  test("strict single-signed abort publishes only the locally owned copy", async () => {
    const authority = abortAuthority("durable-abort-81");
    const mode = { kind: "single-signed-abort", signerRole: "buyer" } as const;
    const shared = transportState();
    const store = createInMemoryFencedSessionStore();
    const effects = roleEffects();
    await store.create({ jobId: authority.jobId, now: NOW - 1 });
    const result = await advanceTerminalBundleDurable(
      durableInput(authority, mode, "buyer", effects),
      abortProvider("buyer", effects),
      durability(store, shared, effects, "abort-worker"),
    );
    expect(result).toMatchObject({ disposition: "finalised" });
    if (result.disposition !== "finalised") return;
    expect(result.result.signatureMatrix.copies).toHaveLength(1);
    expect(result.result.bundle.anchoredByRole).toBe("buyer");
    expect(result.result.bundle.signatures).toHaveLength(1);
    expect(shared.contributions.has("seller")).toBe(false);
    expect(shared.contributions.has("orchestrator")).toBe(false);
  });

  test("rejects malformed store records before treating a terminal phase as recoverable", async () => {
    const authority = abortAuthority("durable-malformed-load-81");
    const mode = { kind: "single-signed-abort", signerRole: "buyer" } as const;
    const shared = transportState();
    const store = createInMemoryFencedSessionStore();
    const effects = roleEffects();
    await store.create({ jobId: authority.jobId, now: NOW - 1 });

    await expect(advanceTerminalBundleDurable(
      durableInput(authority, mode, "buyer", effects),
      abortProvider("buyer", effects),
      durability(
        malformedFinalLoadStore(store),
        shared,
        effects,
        "malformed-load-worker",
      ),
    )).rejects.toThrow(/terminal session is corrupt/i);
    expect(effects.signerCalls).toBe(0);
    expect(effects.anchorSubmits).toBe(0);
  });

  test("does not accept a pre-existing result outcome outside its exact sealed phase", async () => {
    const authority = abortAuthority("durable-unsealed-result-81");
    const mode = { kind: "single-signed-abort", signerRole: "buyer" } as const;
    const shared = transportState();
    const store = createInMemoryFencedSessionStore();
    const effects = roleEffects();
    await store.create({ jobId: authority.jobId, now: NOW - 1 });

    await expect(advanceTerminalBundleDurable(
      durableInput(authority, mode, "buyer", effects),
      abortProvider("buyer", effects),
      durability(
        preExistingUnsealedResultStore(store),
        shared,
        effects,
        "unsealed-result-worker",
      ),
    )).rejects.toThrow(/not in its exact sealed phase/i);
    const retained = await store.load(authority.jobId);
    expect(retained.status === "ok" && retained.record.phase).not.toBe(
      "terminal:buyer:finalised",
    );
  });

  test("rejects a concurrent final record whose bundle receipt is rebound", async () => {
    const authority = abortAuthority("durable-concurrent-wrong-receipt-81");
    const mode = { kind: "single-signed-abort", signerRole: "buyer" } as const;
    const shared = transportState();
    const store = createInMemoryFencedSessionStore();
    const effects = roleEffects();
    await store.create({ jobId: authority.jobId, now: NOW - 1 });

    await expect(advanceTerminalBundleDurable(
      durableInput(authority, mode, "buyer", effects),
      abortProvider("buyer", effects),
      durability(
        concurrentWrongReceiptStore(store),
        shared,
        effects,
        "concurrent-wrong-receipt-worker",
      ),
    )).rejects.toThrow(/not in its exact sealed phase/i);
    const retained = await store.load(authority.jobId);
    expect(retained.status === "ok" && retained.record.phase).not.toBe(
      "terminal:buyer:finalised",
    );
    expect(
      retained.status === "ok" &&
        retained.record.receipts.some((receipt) => receipt.ref === "wrong-native-address"),
    ).toBe(false);
  });

  test("rejects a substituted remote contribution before any own anchor", async () => {
    const authority = failureAuthority("durable-substitution-81");
    const mode = { kind: "co-signed" } as const;
    const plan = createTerminalBundlePlan(authority, mode);
    const shared = transportState();
    shared.contributions.set("seller", detachedContribution(plan, "seller", "buyer"));
    shared.contributions.set("orchestrator", detachedContribution(plan, "orchestrator"));
    const store = createInMemoryFencedSessionStore();
    const effects = roleEffects();
    await store.create({ jobId: authority.jobId, now: NOW - 1 });
    await expect(advanceTerminalBundleDurable(
      durableInput(authority, mode, "buyer", effects),
      provider("buyer", effects),
      durability(store, shared, effects, "substitution-worker"),
    )).rejects.toThrow(/does not verify/i);
    expect(effects.anchorSubmits).toBe(0);
  });

  test("indeterminate reconciliation never authorizes a redrive", async () => {
    const authority = abortAuthority("durable-indeterminate-81");
    const mode = { kind: "single-signed-abort", signerRole: "buyer" } as const;
    const shared = transportState();
    const store = createInMemoryFencedSessionStore();
    const effects = roleEffects();
    let ambiguous = false;
    const base = abortProvider("buyer", effects);
    const ambiguousProvider: DurableTerminalBundleProvider = {
      ...base,
      resolveOwnBundle: () =>
        ambiguous
          ? { disposition: "indeterminate", reason: "anchor observation unavailable" }
          : { disposition: "authoritatively-absent", reason: "no anchor" },
      submitOwnBundle: () => {
        effects.anchorSubmits += 1;
        ambiguous = true;
        throw new Error("connection lost after submit");
      },
    };
    await store.create({ jobId: authority.jobId, now: NOW - 1 });
    const first = await advanceTerminalBundleDurable(
      durableInput(authority, mode, "buyer", effects),
      ambiguousProvider,
      durability(store, shared, effects, "ambiguous-worker-1"),
    );
    expect(first).toMatchObject({ disposition: "indeterminate", stage: "bundle-anchor" });
    const second = await advanceTerminalBundleDurable(
      durableInput(authority, mode, "buyer", effects),
      ambiguousProvider,
      durability(store, shared, effects, "ambiguous-worker-2"),
    );
    expect(second).toMatchObject({ disposition: "indeterminate", stage: "bundle-anchor" });
    expect(effects.anchorSubmits).toBe(1);
  });

  test("maps resolver promise rejections to indeterminate at the exact active stage", async () => {
    const proposalAuthority = abortAuthority("durable-rejected-proposal-81");
    const mode = { kind: "single-signed-abort", signerRole: "buyer" } as const;
    const proposalStore = createInMemoryFencedSessionStore();
    const proposalState = transportState();
    const proposalEffects = roleEffects();
    await proposalStore.create({ jobId: proposalAuthority.jobId, now: NOW - 1 });
    const proposalDurability = durability(
      proposalStore,
      proposalState,
      proposalEffects,
      "proposal-rejection-worker",
    );
    const proposalResult = await advanceTerminalBundleDurable(
      durableInput(proposalAuthority, mode, "buyer", proposalEffects),
      abortProvider("buyer", proposalEffects),
      {
        ...proposalDurability,
        transport: {
          ...proposalDurability.transport,
          resolveProposal: async () => {
            throw new DacsError("proposal resolver offline");
          },
        },
      },
    );
    expect(proposalResult).toMatchObject({
      disposition: "indeterminate",
      stage: "proposal-publication",
    });
    expect(proposalEffects.signerCalls).toBe(0);

    const signatureAuthority = abortAuthority("durable-rejected-signature-81");
    const signatureStore = createInMemoryFencedSessionStore();
    const signatureState = transportState();
    const signatureEffects = roleEffects();
    await signatureStore.create({ jobId: signatureAuthority.jobId, now: NOW - 1 });
    const signatureDurability = durability(
      signatureStore,
      signatureState,
      signatureEffects,
      "signature-rejection-worker",
    );
    const signatureResult = await advanceTerminalBundleDurable(
      durableInput(signatureAuthority, mode, "buyer", signatureEffects),
      abortProvider("buyer", signatureEffects),
      {
        ...signatureDurability,
        reconcileSignature: async () => {
          throw new Error("signature resolver offline");
        },
      },
    );
    expect(signatureResult).toMatchObject({
      disposition: "indeterminate",
      stage: "contribution-signing",
    });
    expect(signatureEffects.signerCalls).toBe(0);

    const contributionAuthority = failureAuthority("durable-rejected-contribution-81");
    const contributionMode = { kind: "co-signed" } as const;
    const contributionStore = createInMemoryFencedSessionStore();
    const contributionState = transportState();
    const contributionEffects = roleEffects();
    await contributionStore.create({ jobId: contributionAuthority.jobId, now: NOW - 1 });
    const contributionDurability = durability(
      contributionStore,
      contributionState,
      contributionEffects,
      "contribution-rejection-worker",
    );
    const contributionResult = await advanceTerminalBundleDurable(
      durableInput(
        contributionAuthority,
        contributionMode,
        "buyer",
        contributionEffects,
      ),
      provider("buyer", contributionEffects),
      {
        ...contributionDurability,
        transport: {
          ...contributionDurability.transport,
          resolveContribution: async (input) => {
            if (input.signerRole === "seller") {
              throw new Error("contribution resolver offline");
            }
            return contributionDurability.transport.resolveContribution(input);
          },
        },
      },
    );
    expect(contributionResult).toMatchObject({
      disposition: "indeterminate",
      stage: "contribution-publication",
    });

    const anchorAuthority = abortAuthority("durable-rejected-anchor-81");
    const anchorStore = createInMemoryFencedSessionStore();
    const anchorState = transportState();
    const anchorEffects = roleEffects();
    await anchorStore.create({ jobId: anchorAuthority.jobId, now: NOW - 1 });
    const anchorProvider = abortProvider("buyer", anchorEffects);
    const anchorResult = await advanceTerminalBundleDurable(
      durableInput(anchorAuthority, mode, "buyer", anchorEffects),
      {
        ...anchorProvider,
        verifyOwnBundlePublication: async () => {
          throw new DacsError("anchor verifier offline");
        },
      },
      durability(
        anchorStore,
        anchorState,
        anchorEffects,
        "anchor-rejection-worker",
      ),
    );
    expect(anchorResult).toMatchObject({
      disposition: "indeterminate",
      stage: "bundle-anchor",
    });

    const bindingAuthority = abortAuthority("durable-rejected-binding-81");
    const bindingStore = createInMemoryFencedSessionStore();
    const bindingState = transportState();
    const bindingEffects = roleEffects();
    await bindingStore.create({ jobId: bindingAuthority.jobId, now: NOW - 1 });
    const bindingProvider = abortProvider("buyer", bindingEffects);
    const bindingResult = await advanceTerminalBundleDurable(
      durableInput(bindingAuthority, mode, "buyer", bindingEffects),
      {
        ...bindingProvider,
        resolveOwnBundleBinding: async () => {
          throw new DacsError("binding resolver offline");
        },
      },
      durability(
        bindingStore,
        bindingState,
        bindingEffects,
        "binding-rejection-worker",
      ),
    );
    expect(bindingResult).toMatchObject({
      disposition: "indeterminate",
      stage: "bundle-binding",
    });

    const recoveryAuthority = abortAuthority("durable-rejected-recovery-81");
    const recoveryStore = createInMemoryFencedSessionStore();
    const recoveryState = transportState();
    const recoveryEffects = roleEffects();
    await recoveryStore.create({ jobId: recoveryAuthority.jobId, now: NOW - 1 });
    const finalized = await advanceTerminalBundleDurable(
      durableInput(recoveryAuthority, mode, "buyer", recoveryEffects),
      abortProvider("buyer", recoveryEffects),
      durability(
        recoveryStore,
        recoveryState,
        recoveryEffects,
        "recovery-fixture-worker",
      ),
    );
    expect(finalized).toMatchObject({ disposition: "finalised" });
    const recoveryProvider = abortProvider("buyer", recoveryEffects);
    const recoveryResult = await verifyFinalizedTerminalBundleReadOnly(
      {
        authority: recoveryAuthority,
        signingMode: mode,
        local: { role: "buyer", primaryClaim: CLAIMS.buyer },
        signerKeys: signerKeys(createTerminalBundlePlan(recoveryAuthority, mode)),
      },
      {
        ...recoveryProvider,
        resolveOwnBundle: async () => {
          throw new DacsError("recovery anchor resolver offline");
        },
      },
      recoveryStore,
    );
    expect(recoveryResult).toMatchObject({
      disposition: "indeterminate",
      stage: "terminal-recovery",
    });
  });

  test.each([
    "signature:buyer",
    "bundle-anchor",
    "bundle-binding-publication",
  ])(
    "recovers a crash after the %s effect without duplicating it",
    async (checkpointSuffix) => {
      const jobId = `durable-crash-${checkpointSuffix.replaceAll(":", "-")}`;
      const authority = abortAuthority(jobId);
      const mode = { kind: "single-signed-abort", signerRole: "buyer" } as const;
      const shared = transportState();
      const store = createInMemoryFencedSessionStore();
      const effects = roleEffects();
      await store.create({ jobId, now: NOW - 1 });

      await expect(advanceTerminalBundleDurable(
        durableInput(authority, mode, "buyer", effects),
        abortProvider("buyer", effects),
        durability(
          crashOnceBeforeOutcome(store, checkpointSuffix),
          shared,
          effects,
          "crashing-worker",
        ),
      )).rejects.toThrow(/simulated crash/);

      const recovered = await advanceTerminalBundleDurable(
        durableInput(authority, mode, "buyer", effects),
        abortProvider("buyer", effects),
        durability(store, shared, effects, "recovery-worker"),
      );
      expect(recovered).toMatchObject({ disposition: "finalised", recovered: false });
      expect(effects.signerCalls).toBe(2);
      expect(effects.anchorSubmits).toBe(1);
      expect(effects.bindingPublishes).toBe(1);
      const loaded = await store.load(jobId);
      expect(loaded.status === "ok" && loaded.record.leaseGeneration).toBe(2);
    },
  );
});
