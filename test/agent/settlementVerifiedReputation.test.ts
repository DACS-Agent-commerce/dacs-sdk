import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";

import {
  deriveReplayableSettlementVerifiedReputation,
  deriveSettlementVerifiedReputation,
  isReplayableSettlementVerifiedReputationDerivation,
  isSettlementVerifiedReputationDerivation,
  isSuccessfulDacs4PaymentProjection,
  replaySettlementVerifiedReputation,
  settlementEvidenceReferenceMultisetsEqual,
  type SettlementVerifiedBundleInput,
  type SettlementVerifiedReputationDeps,
} from "../../src/agent/settlementVerifiedReputation.js";
import type {
  AgreementArtifact,
  AnyAttestationBundle,
  AttestationRef,
  SettlementEvidence,
} from "../../src/artifacts/types.js";
import {
  contentHash,
  sha256Hex,
  stripSignature,
} from "../../src/canonical/index.js";

const PARTY = "did:demos:buyer";
const SELLER = "did:demos:seller";
const ORCHESTRATOR = "did:demos:orchestrator";
const H = (value: string) => value.repeat(64).slice(0, 64);
const SIG = Buffer.alloc(64, 7).toString("base64url");
const WINDOW = {
  windowStart: 1_000,
  windowEnd: 2_000,
  computedAt: 3_000,
  windowingBasis: "finalisedAt" as const,
};

function jobId(label: string): string {
  return `0${sha256Hex(label).slice(0, 25).toUpperCase()}`;
}

function ref(hash: string, locator = `stor-${hash.slice(0, 8)}`): AttestationRef {
  return {
    anchor: { kind: "storage-program", locator },
    contentHash: hash,
  };
}

function paymentEvidence(
  jobLabel: string,
  observedAt = 1_100,
  txHash = H("a"),
): SettlementEvidence {
  const job = jobId(jobLabel);
  return {
    evidenceVersion: "1",
    jobId: job,
    phase: "pay-dem",
    outcome: "success",
    paymentTxRefs: [{ kind: "demos", txHash }],
    paymentAmount: { amount: "5", currency: "DEM" },
    settlementFinality: {
      model: "bft-final",
      finalityObservedAt: observedAt,
    },
    observedAt,
    signature: {
      algorithm: "ed25519",
      signer: ORCHESTRATOR,
      value: SIG,
    },
  };
}

function deliveryEvidence(jobLabel: string, observedAt = 1_100): SettlementEvidence {
  const job = jobId(jobLabel);
  return {
    evidenceVersion: "1",
    jobId: job,
    phase: "deliver-storage-program",
    outcome: "success",
    deliverableContentHash: H("d"),
    deliverableAnchor: { kind: "storage-program", locator: `delivery-${job}` },
    observedAt,
    signature: {
      algorithm: "ed25519",
      signer: ORCHESTRATOR,
      value: SIG,
    },
  };
}

function failureEvidence(jobLabel: string, observedAt = 1_100): SettlementEvidence {
  return {
    evidenceVersion: "1",
    jobId: jobId(jobLabel),
    phase: "pay-dem",
    outcome: "failure",
    reason: "not-settled",
    observedAt,
    signature: {
      algorithm: "ed25519",
      signer: ORCHESTRATOR,
      value: SIG,
    },
  };
}

function evidenceRef(evidence: SettlementEvidence, suffix = ""): AttestationRef {
  return ref(
    contentHash(stripSignature(evidence as unknown as Record<string, unknown>)),
    `evidence-${evidence.jobId}${suffix}`,
  );
}

function agreement(jobLabel: string, amount = "5", currency = "DEM"): AgreementArtifact {
  const job = jobId(jobLabel);
  return {
    agreementVersion: "1",
    jobId: job,
    listingRef: { listingId: "listing", version: 1, contentHash: H("1") },
    parties: [
      {
        role: "buyer",
        bundleHash: H("2"),
        primaryClaim: PARTY,
        vetRecordRef: ref(H("3"), `buyer-vet-${job}`),
      },
      {
        role: "seller",
        bundleHash: H("4"),
        primaryClaim: SELLER,
        vetRecordRef: ref(H("5"), `seller-vet-${job}`),
      },
    ],
    terms: {
      deliverable: { deliverableType: "attested-payload", hash: H("6") },
      price: { amount, currency },
      rail: { railId: "demos-native:default" },
      deadline: 9_999,
    },
    derivedFromPattern: "fixed-price",
    generatedAt: 900,
    signatures: [
      { party: PARTY, algorithm: "ed25519", value: SIG },
      { party: SELLER, algorithm: "ed25519", value: SIG },
    ],
  };
}

function agreementRef(value: AgreementArtifact): AttestationRef {
  return ref(
    contentHash(stripSignature(value as unknown as Record<string, unknown>)),
    `agreement-${value.jobId}`,
  );
}

function bundle(
  jobLabel: string,
  outcome: AnyAttestationBundle["outcome"],
  settlementEvidence: AttestationRef[],
  agreementValue: AgreementArtifact | undefined,
  role: "buyer" | "seller" = "buyer",
): AnyAttestationBundle {
  const job = jobId(jobLabel);
  return {
    faultBundleVersion: "1",
    faultedParty: outcome === "completed" || outcome === "failed-substrate"
      ? "none"
      : role,
    jobId: job,
    outcome,
    anchoredByRole: role,
    listingRef: { listingId: "listing", version: 1, contentHash: H("1") },
    ...(agreementValue ? { agreementRef: agreementRef(agreementValue) } : {}),
    parties: [
      { role: "buyer", bundleHash: H("2"), primaryClaim: PARTY },
      { role: "seller", bundleHash: H("4"), primaryClaim: SELLER },
    ],
    phaseSummary: [],
    vetRecords: [],
    settlementEvidence,
    recipeRegistryVersion: 1,
    railRegistryVersion: 1,
    finalisedAt: 1_200,
    signatures: [
      { party: PARTY, algorithm: "ed25519", value: SIG },
      { party: SELLER, algorithm: "ed25519", value: SIG },
    ],
  };
}

function bundleHash(value: AnyAttestationBundle): string {
  const scope = {
    ...stripSignature(value as unknown as Record<string, unknown>),
  };
  delete scope.anchoredByRole;
  return contentHash(scope);
}

function input(
  value: AnyAttestationBundle,
  options: {
    counterpart?: SettlementVerifiedBundleInput;
    anchorTimestamp?: number;
  } = {},
): SettlementVerifiedBundleInput {
  const hash = bundleHash(value);
  const role = value.anchoredByRole as "buyer" | "seller";
  const roleRef = ref(hash, `bundle-${value.jobId}-${role}`);
  return {
    bundle: value,
    bundleRef: roleRef,
    resolutionContext: {
      contentHash: hash,
      resolvedRole: role,
      resolvedJobId: value.jobId,
      roleEvidence: {
        kind: "address",
        resolvedAddress: roleRef.anchor.locator,
      },
      ...(options.counterpart
        ? {
          counterpartyDisposition: "present" as const,
          counterpartyRef: options.counterpart.bundleRef,
          counterpartyRoleEvidence: {
            kind: "address" as const,
            resolvedAddress: options.counterpart.bundleRef.anchor.locator,
          },
        }
        : {
          counterpartyDisposition: "absent" as const,
          absenceEvidenceRef: {
            kind: "non-membership-proof",
            locator: `absence-${value.jobId}-${role === "buyer" ? "seller" : "buyer"}`,
            contentHash: H("f"),
          },
        }),
    },
    ...(options.anchorTimestamp === undefined
      ? {}
      : { anchorTimestamp: options.anchorTimestamp }),
  };
}

function pairedInputs(
  buyer: AnyAttestationBundle,
  seller: AnyAttestationBundle,
): [SettlementVerifiedBundleInput, SettlementVerifiedBundleInput] {
  const buyerInitial = input(buyer);
  const sellerInitial = input(seller);
  return [
    input(buyer, { counterpart: sellerInitial }),
    input(seller, { counterpart: buyerInitial }),
  ];
}

function deps(
  evidences: SettlementEvidence[],
  agreements: AgreementArtifact[],
  options: {
    evidenceDisposition?: (
      index: number,
    ) => "verified" | "rejected" | "indeterminate";
    txId?: (evidence: SettlementEvidence, index: number) => string;
  } = {},
): SettlementVerifiedReputationDeps {
  const evidenceByHash = new Map(evidences.map((value) => [
    evidenceRef(value).contentHash,
    value,
  ]));
  const agreementByHash = new Map(agreements.map((value) => [
    agreementRef(value).contentHash,
    value,
  ]));
  return {
    authenticateBundle: async () => ({
      disposition: "verified",
      partyRole: "buyer",
      fullySigned: true,
    }),
    verifyPresentedSettlement: async ({ ref: evidencePointer, evidenceIndex }) => {
      const disposition = options.evidenceDisposition?.(evidenceIndex) ?? "verified";
      if (disposition !== "verified") return { disposition, reason: "fixture authority" };
      const evidence = evidenceByHash.get(evidencePointer.contentHash);
      if (!evidence) return { disposition: "rejected", reason: "unknown evidence" };
      return {
        disposition: "verified",
        evidence,
        ...(isSuccessfulDacs4PaymentProjection(evidence)
          ? {
            settlementTxId: options.txId?.(evidence, evidenceIndex) ??
              `demos:${contentHash(stripSignature(
                evidence as unknown as Record<string, unknown>,
              ))}`,
            phaseIndex: evidenceIndex + 2,
          }
          : {}),
      };
    },
    resolveAgreement: async ({ ref: agreementPointer }) => {
      const value = agreementByHash.get(agreementPointer.contentHash);
      return value
        ? { disposition: "verified", agreement: value }
        : { disposition: "rejected", reason: "unknown Agreement" };
    },
  };
}

describe("settlement reference multiset equality", () => {
  const fixture = JSON.parse(readFileSync(
    "vendor/DACS-Standard/conformance/vectors/security/reputation-settlement-reference-divergence-v0.4.json",
    "utf8",
  )) as {
    vectors: Array<{
      name: string;
      expected: "pass" | "fail";
      input: { selfRefs: unknown[]; counterpartyRefs: unknown[] };
    }>;
  };

  test.each(fixture.vectors)("replays $name", ({ expected, input: vector }) => {
    expect(settlementEvidenceReferenceMultisetsEqual(
      vector.selfRefs,
      vector.counterpartyRefs,
    )).toBe(expected === "pass");
  });
});

describe("settlement-verified semantic conformance", () => {
  const fixture = JSON.parse(readFileSync(
    "vendor/DACS-Standard/conformance/vectors/security/reputation-settlement-semantics-v0.4.json",
    "utf8",
  )) as {
    vectors: Array<{
      name: string;
      expected: "accept" | "reject" | "indeterminate";
      input: {
        outcome: AnyAttestationBundle["outcome"];
        presentedEvidenceCount: number;
        evidencePhase?: string | null;
        evidenceOutcome?: "success" | "failure";
        authorityDisposition: "verified" | "rejected" | "indeterminate";
        mismatch: string | null;
        mismatchIndex?: number;
      };
      want: {
        bundleIncluded: boolean;
        volumeByCurrency: string[];
        transactionCountByCurrency: Array<{ currency: string; count: number }>;
      };
    }>;
  };

  test.each(fixture.vectors)("replays $name", async ({ input: vector, want }) => {
    const records: SettlementEvidence[] = [];
    for (let index = 0; index < vector.presentedEvidenceCount; index += 1) {
      if (vector.evidencePhase === "deliver-storage-program" ||
        vector.evidencePhase === "pay-not-a-dacs4-phase") {
        records.push(deliveryEvidence("semantic", 1_100 + index));
      } else if (vector.evidenceOutcome === "failure") {
        records.push(failureEvidence("semantic", 1_100 + index));
      } else {
        records.push(paymentEvidence("semantic", 1_100 + index, H(String(index + 1))));
      }
    }
    if (vector.evidencePhase === "pay-not-a-dacs4-phase") {
      expect(isSuccessfulDacs4PaymentProjection({
        phase: vector.evidencePhase,
        outcome: vector.evidenceOutcome,
      })).toBe(false);
    }
    const agreementValue = agreement("semantic");
    const value = bundle(
      "semantic",
      vector.outcome,
      records.map((record, index) => evidenceRef(record, `-${index}`)),
      agreementValue,
    );
    const invalidIndex = vector.mismatch === null
      ? -1
      : (vector.mismatchIndex ?? 0);
    const authority = deps(records, [agreementValue], {
      evidenceDisposition: (index) => index === invalidIndex
        ? (vector.authorityDisposition === "indeterminate"
          ? "indeterminate"
          : "rejected")
        : vector.authorityDisposition,
    });
    const derived = await deriveSettlementVerifiedReputation(
      PARTY,
      [input(value)],
      WINDOW,
      authority,
    );
    expect(derived.bundleCount).toBe(want.bundleIncluded ? 1 : 0);
    expect(derived.metrics.observedTransactionalVolume.map((term) =>
      `${term.amount} ${term.currency}`)).toEqual(want.volumeByCurrency);
    expect(derived.metrics.transactionCountByCurrency).toEqual(
      want.transactionCountByCurrency,
    );
  });
});

describe("deriveSettlementVerifiedReputation", () => {
  test("pair divergence includes full refs and multiplicity for every bundle type", async () => {
    const record = paymentEvidence("pair");
    const pointer = evidenceRef(record);
    const value = agreement("pair");
    const buyer = bundle("pair", "completed", [pointer, pointer], value, "buyer");
    const seller = bundle("pair", "completed", [pointer], value, "seller");
    expect((await deriveSettlementVerifiedReputation(
      PARTY,
      pairedInputs(buyer, seller),
      WINDOW,
      deps([record], [value]),
    )).bundleCount).toBe(0);
  });

  test("binds a present counterparty to its exact full bundle ref, not hash alone", async () => {
    const record = paymentEvidence("counterparty-ref");
    const pointer = evidenceRef(record);
    const value = agreement("counterparty-ref");
    const pair = pairedInputs(
      bundle("counterparty-ref", "completed", [pointer], value, "buyer"),
      bundle("counterparty-ref", "completed", [pointer], value, "seller"),
    );
    pair[0].resolutionContext.counterpartyRef = {
      ...pair[0].resolutionContext.counterpartyRef!,
      anchor: { kind: "https", locator: "https://example.invalid/substitution" },
    };
    expect((await deriveSettlementVerifiedReputation(
      PARTY, pair, WINDOW, deps([record], [value]),
    )).bundleCount).toBe(0);
  });

  test("reference order alone is immaterial and the stronger type wins", async () => {
    const first = paymentEvidence("ordered", 1_100, H("a"));
    const second = deliveryEvidence("ordered", 1_101);
    const refs = [evidenceRef(first), evidenceRef(second)];
    const value = agreement("ordered");
    const buyer = bundle("ordered", "completed", refs, value, "buyer");
    const {
      faultBundleVersion: _faultVersion,
      ...sellerFields
    } = bundle("ordered", "completed", [...refs].reverse(), value, "seller") as
      AnyAttestationBundle & { faultBundleVersion?: "1" };
    const seller = {
      ...sellerFields,
      evidenceBoundFaultBundleVersion: "1" as const,
    } as unknown as AnyAttestationBundle;
    expect((await deriveSettlementVerifiedReputation(
      PARTY,
      pairedInputs(buyer, seller),
      WINDOW,
      deps([first, second], [value]),
    )).bundleCount).toBe(1);
  });

  test("RSV rejection removes a failing job without creating fault", async () => {
    const bad = paymentEvidence("bad");
    const good = paymentEvidence("good", 1_101, H("b"));
    const badAgreement = agreement("bad");
    const goodAgreement = agreement("good");
    const authority = deps([bad, good], [badAgreement, goodAgreement]);
    const baseVerify = authority.verifyPresentedSettlement;
    authority.verifyPresentedSettlement = async (request) => request.bundle.jobId === jobId("bad")
      ? { disposition: "rejected", reason: "amount mismatch" }
      : baseVerify(request);
    const derived = await deriveSettlementVerifiedReputation(PARTY, [
      input(bundle("bad", "failed-perm", [evidenceRef(bad)], badAgreement)),
      input(bundle("good", "completed", [evidenceRef(good)], goodAgreement)),
    ], WINDOW, authority);
    expect(derived).toMatchObject({
      bundleCount: 1,
      metrics: {
        completionRate: 1,
        counterpartyFaultRate: 0,
        observedTransactionalVolume: [{ amount: "5", currency: "DEM" }],
      },
    });
  });

  test("aggregates Agreement prices exactly and counts each completed job once", async () => {
    const evidenceA = paymentEvidence("a", 1_100, H("a"));
    const evidenceB = paymentEvidence("b", 1_101, H("b"));
    const agreementA = agreement("a", "0.1", "DEM");
    const agreementB = agreement("b", "0.2", "DEM");
    const derived = await deriveSettlementVerifiedReputation(PARTY, [
      input(bundle("a", "completed", [evidenceRef(evidenceA)], agreementA)),
      input(bundle("b", "completed", [evidenceRef(evidenceB)], agreementB)),
    ], WINDOW, deps([evidenceA, evidenceB], [agreementA, agreementB]));
    expect(derived.metrics.observedTransactionalVolume).toEqual([
      { amount: "0.3", currency: "DEM" },
    ]);
    expect(derived.metrics.transactionCountByCurrency).toEqual([
      { currency: "DEM", count: 2 },
    ]);
  });

  test("SB-2 reused transaction keeps only the earliest observed job", async () => {
    const early = paymentEvidence("early", 1_100, H("a"));
    const late = paymentEvidence("late", 1_200, H("b"));
    const earlyAgreement = agreement("early");
    const lateAgreement = agreement("late");
    const derived = await deriveSettlementVerifiedReputation(PARTY, [
      input(bundle("late", "completed", [evidenceRef(late)], lateAgreement)),
      input(bundle("early", "completed", [evidenceRef(early)], earlyAgreement)),
    ], WINDOW, deps([early, late], [earlyAgreement, lateAgreement], {
      txId: () => `demos:${H("e")}`,
    }));
    expect(derived.bundleCount).toBe(1);
    expect(derived.bundleRefs[0]?.contentHash).toBe(
      input(bundle("early", "completed", [evidenceRef(early)], earlyAgreement))
        .bundleRef.contentHash,
    );
    expect(derived.metrics.transactionCountByCurrency).toEqual([
      { currency: "DEM", count: 1 },
    ]);
  });

  test("two phase claims for one retained job do not make that job disappear", async () => {
    const first = paymentEvidence("same-job", 1_100, H("a"));
    const second = paymentEvidence("same-job", 1_101, H("b"));
    const value = agreement("same-job");
    const derived = await deriveSettlementVerifiedReputation(PARTY, [input(bundle(
      "same-job",
      "completed",
      [evidenceRef(first), evidenceRef(second)],
      value,
    ))], WINDOW, deps([first, second], [value], {
      txId: () => `demos:${H("e")}`,
    }));
    expect(derived.bundleCount).toBe(1);
    expect(derived.metrics.transactionCountByCurrency).toEqual([
      { currency: "DEM", count: 1 },
    ]);
  });

  test("rejects a verified successful payment without canonical SB-1 identity", async () => {
    const evidence = paymentEvidence("bad-sb1");
    const value = agreement("bad-sb1");
    expect((await deriveSettlementVerifiedReputation(PARTY, [input(bundle(
      "bad-sb1", "completed", [evidenceRef(evidence)], value,
    ))], WINDOW, deps([evidence], [value], {
      txId: () => "not-a-settlement-id",
    }))).bundleCount).toBe(0);
  });

  test("rejects authority callback envelopes with unrecognised members", async () => {
    const value = bundle("extra-authority", "completed", [], undefined);
    const authority = deps([], []);
    authority.authenticateBundle = async () => ({
      disposition: "verified",
      partyRole: "buyer",
      fullySigned: true,
      unsafeExtension: true,
    } as never);
    expect((await deriveSettlementVerifiedReputation(
      PARTY, [input(value)], WINDOW, authority,
    )).bundleCount).toBe(0);
  });

  test("anchor-time windowing fails closed when timestamp authority is absent", async () => {
    const evidence = paymentEvidence("anchor-window");
    const value = agreement("anchor-window");
    const source = input(bundle(
      "anchor-window",
      "completed",
      [evidenceRef(evidence)],
      value,
    ));
    const window = { ...WINDOW, windowingBasis: "sr2-anchor-timestamp" as const };
    expect((await deriveSettlementVerifiedReputation(
      PARTY, [source], window, deps([evidence], [value]),
    )).bundleCount).toBe(0);
    source.anchorTimestamp = 1_500;
    expect((await deriveSettlementVerifiedReputation(
      PARTY, [source], window, deps([evidence], [value]),
    )).bundleCount).toBe(1);
  });

  test("requires authenticated ST-10 resolution and neutralises established cancellation", async () => {
    const cancelled = bundle("cancelled", "aborted-by-self", [], undefined);
    cancelled.cancellation = { claimedPolicy: "pre-commit" };
    const noResolver = deps([], []);
    expect((await deriveSettlementVerifiedReputation(
      PARTY, [input(cancelled)], WINDOW, noResolver,
    )).bundleCount).toBe(0);
    const withResolver = {
      ...noResolver,
      verifyCancellation: async () => "established" as const,
    };
    const derived = await deriveSettlementVerifiedReputation(
      PARTY, [input(cancelled)], WINDOW, withResolver,
    );
    expect(derived.bundleCount).toBe(1);
    expect(derived.metrics.completionRate).toBeNull();
    expect(derived.metrics.counterpartyFaultRate).toBeNull();
  });

  test("captures callback identities before awaiting hostile mutable dependencies", async () => {
    const evidence = paymentEvidence("captured");
    const value = agreement("captured");
    const authority = deps([evidence], [value]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const authenticate = vi.fn(async () => {
      await gate;
      return { disposition: "verified" as const, partyRole: "buyer" as const, fullySigned: true };
    });
    authority.authenticateBundle = authenticate;
    const pending = deriveSettlementVerifiedReputation(PARTY, [input(bundle(
      "captured", "completed", [evidenceRef(evidence)], value,
    ))], WINDOW, authority);
    authority.verifyPresentedSettlement = async () => ({
      disposition: "rejected",
      reason: "late mutation",
    });
    release();
    expect((await pending).bundleCount).toBe(1);
    expect(authenticate).toHaveBeenCalledOnce();
  });

  test("refuses accessor-backed dependency objects before invoking authority", async () => {
    const authority = deps([], []);
    const authenticate = authority.authenticateBundle;
    Object.defineProperty(authority, "authenticateBundle", {
      enumerable: true,
      get: () => authenticate,
    });
    await expect(deriveSettlementVerifiedReputation(
      PARTY, [], WINDOW, authority,
    )).rejects.toThrow(/requires authenticateBundle/);
  });

  test("a callback cannot mutate the retained authenticated bundle input", async () => {
    const evidence = paymentEvidence("callback-mutation");
    const value = agreement("callback-mutation");
    const authority = deps([evidence], [value]);
    authority.authenticateBundle = async (request) => {
      (request.bundle as AnyAttestationBundle).outcome = "failed-perm";
      return {
        disposition: "verified",
        partyRole: "buyer",
        fullySigned: true,
      };
    };
    const derived = await deriveSettlementVerifiedReputation(PARTY, [input(bundle(
      "callback-mutation", "completed", [evidenceRef(evidence)], value,
    ))], WINDOW, authority);
    expect(derived.bundleCount).toBe(1);
    expect(derived.metrics.completionRate).toBe(1);
  });
});

describe("settlement-verified replay and type boundary", () => {
  test("replays all authority and rejects a byte-different metric receipt", async () => {
    const evidence = paymentEvidence("replay");
    const value = agreement("replay");
    const authority = deps([evidence], [value]);
    const source = input(bundle("replay", "completed", [evidenceRef(evidence)], value));
    const receipt = await deriveReplayableSettlementVerifiedReputation(
      PARTY, [source], WINDOW, authority,
    );
    expect(isReplayableSettlementVerifiedReputationDerivation(receipt)).toBe(true);
    expect((await replaySettlementVerifiedReputation(
      receipt, [source], authority,
    )).decision).toBe("verified");
    const tampered = structuredClone(receipt);
    tampered.metrics.completionRate = 0;
    expect((await replaySettlementVerifiedReputation(
      tampered, [source], authority,
    )).decision).toBe("rejected");
  });

  test("refuses stripped, relabelled and multiple discriminator objects", async () => {
    const empty = await deriveSettlementVerifiedReputation(
      PARTY, [], WINDOW, deps([], []),
    );
    expect(isSettlementVerifiedReputationDerivation(empty)).toBe(true);
    expect(isSettlementVerifiedReputationDerivation({
      ...empty,
      derivationVersion: "1",
    })).toBe(false);
    const stripped = { ...empty } as Record<string, unknown>;
    delete stripped.settlementVerifiedDerivationVersion;
    expect(isSettlementVerifiedReputationDerivation(stripped)).toBe(false);
    expect(isSettlementVerifiedReputationDerivation({
      ...stripped,
      futureDerivationVersion: "1",
    })).toBe(false);
    expect(isSettlementVerifiedReputationDerivation({
      ...empty,
      futureDerivationVersion: "1",
    })).toBe(false);
  });
});
