import { describe, expect, test } from "vitest";

import type {
  BundlePartyRole,
  IdentityBundle,
} from "../../src/artifacts/types.js";
import { isFaultAttestationBundle } from "../../src/artifacts/validators.js";
import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import {
  ed25519Sign,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
} from "../../src/crypto/index.js";
import { identityBundleHash } from "../../src/identity/bundle.js";
import {
  assembleTerminalBundleForOwnRole,
  createTerminalBundleAuthority,
  createTerminalBundlePlan,
  createTerminalBundleSignatureContribution,
  createTerminalBundleSignatureMatrix,
  terminalBundleAuthorityHash,
  terminalBundleSignedBytes,
  type TerminalAbortEligibility,
  type TerminalBundleAuthorityInput,
  type TerminalBundlePlan,
  type TerminalBundleSignatureContribution,
  type TerminalBundleSignerPublicKey,
} from "../../src/agent/terminalBundleFinalization.js";

const NOW = 1_786_200_000_000;
const ROLES = ["buyer", "seller", "orchestrator"] as const;
const CLAIMS: Record<BundlePartyRole, string> = {
  buyer: "did:demos:terminal-buyer",
  seller: "did:demos:terminal-seller",
  orchestrator: "did:demos:terminal-orchestrator",
};
const SEED_BYTES: Record<BundlePartyRole, number> = {
  buyer: 81,
  seller: 82,
  orchestrator: 83,
};

function seed(role: BundlePartyRole): Uint8Array {
  return new Uint8Array(32).fill(SEED_BYTES[role]);
}

function identity(role: BundlePartyRole): IdentityBundle {
  const claim = CLAIMS[role];
  return {
    bundleVersion: "1",
    presentedBy: claim,
    presentedAt: NOW - 10_000,
    sessionNonce: `nonce-${role}`,
    claims: [{ ref: claim, metadata: { role, authority: "verified" } }],
    presentation: {
      kind: "session-key",
      key: `session-key-${role}`,
      signature: `presentation-${role}`,
    },
  };
}

function parties() {
  return ROLES.map((role) => ({ role, identityBundle: identity(role) }));
}

function failureInput(
  faultedParty: BundlePartyRole = "seller",
): TerminalBundleAuthorityInput {
  return {
    jobId: "terminal-failure-81",
    terminalClass: "failure",
    faultedParty,
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
      listingId: "terminal-listing-81",
      version: 3,
      contentHash: "4".repeat(64),
    },
    agreementRef: {
      anchor: { kind: "storage-program", locator: "dacs3:agreement:terminal-81" },
      contentHash: "5".repeat(64),
    },
    parties: parties(),
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
    vetRecords: [
      {
        anchor: { kind: "storage-program", locator: "dacs2:vet:terminal-81" },
        contentHash: "6".repeat(64),
      },
    ],
    settlementEvidence: [],
    recipeRegistryVersion: 7,
    railRegistryVersion: 9,
    finalisedAt: NOW,
  };
}

function absentEffects(): Pick<TerminalAbortEligibility, "payment" | "delivery"> {
  return {
    payment: {
      disposition: "authoritatively-absent",
      observationHash: "a".repeat(64),
      observedAt: NOW - 2,
    },
    delivery: {
      disposition: "authoritatively-absent",
      observationHash: "b".repeat(64),
      observedAt: NOW - 1,
    },
  };
}

function abortInput(
  phase: "commit-agreement" | "pay-x402" | "deliver-attested-payload" | "rate" =
    "commit-agreement",
): TerminalBundleAuthorityInput {
  const preCommit = phase === "commit-agreement";
  const preSettlementEffects = {
    payment: { disposition: "not-reached" as const },
    delivery: { disposition: "not-reached" as const },
  };
  return {
    jobId: "terminal-abort-81",
    terminalClass: "abort",
    faultedParty: "seller",
    terminalPhase: {
      index: 2,
      kind: phase,
      state: "pending",
    },
    sessionRecordHash: "7".repeat(64),
    terminalEvidenceHash: "8".repeat(64),
    dependencySetHash: "9".repeat(64),
    listingRef: {
      listingId: "terminal-listing-81",
      version: 3,
      contentHash: "4".repeat(64),
    },
    ...(preCommit
      ? {}
      : {
          agreementRef: {
            anchor: {
              kind: "storage-program" as const,
              locator: "dacs3:agreement:terminal-81",
            },
            contentHash: "5".repeat(64),
          },
        }),
    parties: parties(),
    phaseSummary: [
      { index: 0, kind: "vet-credentials", outcome: "ok" },
      ...(preCommit
        ? [{ index: 1, kind: "negotiate-fixed-price" as const, outcome: "ok" as const }]
        : [{ index: 1, kind: "commit-agreement" as const, outcome: "ok" as const }]),
    ],
    vetRecords: [],
    settlementEvidence: [],
    recipeRegistryVersion: 7,
    railRegistryVersion: 9,
    finalisedAt: NOW,
    abortEligibility: {
      trigger: "withdrawn",
      triggeredBy: "seller",
      triggerEvidenceHash: "c".repeat(64),
      observedAt: NOW - 3,
      ...(preCommit ? preSettlementEffects : absentEffects()),
    },
  };
}

function signerKeys(plan: Readonly<TerminalBundlePlan>): TerminalBundleSignerPublicKey[] {
  return plan.requiredSigners.map(({ role, primaryClaim }) => ({
    role,
    primaryClaim,
    algorithm: "ed25519",
    publicKey: new Uint8Array(rawPublicKey(publicKeyFromSeed(seed(role)))),
  }));
}

function contribution(
  plan: Readonly<TerminalBundlePlan>,
  signerRole: BundlePartyRole,
): Readonly<TerminalBundleSignatureContribution> {
  return createTerminalBundleSignatureContribution(
    plan,
    signerRole,
    plan.copies.map((copy) => ({
      copyRole: copy.role,
      value: Buffer.from(
        ed25519Sign(terminalBundleSignedBytes(copy), privateKeyFromSeed(seed(signerRole))),
      ).toString("base64url"),
    })),
  );
}

function allContributions(
  plan: Readonly<TerminalBundlePlan>,
): Readonly<TerminalBundleSignatureContribution>[] {
  return plan.requiredSigners.map(({ role }) => contribution(plan, role));
}

describe("terminal bundle authority", () => {
  test("derives exact normative IdentityBundle hashes and captures immutable data", () => {
    const input = failureInput("seller");
    const originalIdentities = input.parties.map((party) => party.identityBundle);
    const expectedIdentityHashes = originalIdentities.map((bundle) =>
      identityBundleHash(bundle),
    );
    const authority = createTerminalBundleAuthority(input);

    expect(authority.parties).toEqual(
      ROLES.map((role, index) => ({
        role,
        primaryClaim: CLAIMS[role],
        bundleHash: expectedIdentityHashes[index],
      })),
    );
    expect(authority.parties[0]!.bundleHash).not.toBe(sha256Hex(CLAIMS.buyer));
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.isFrozen(authority.parties)).toBe(true);
    expect(Object.isFrozen(authority.parties[0])).toBe(true);

    input.parties[0]!.identityBundle.claims[0]!.metadata!.authority = "mutated";
    input.phaseSummary[2]!.errorClass = "permanent";
    expect(authority.parties[0]!.bundleHash).toBe(expectedIdentityHashes[0]);
    expect(authority.phaseSummary[2]!.errorClass).toBe("counterparty");
    expect(terminalBundleAuthorityHash(authority)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("uses the presentation-omitting IdentityBundle hash, not presentation bytes", () => {
    const first = failureInput();
    const second = failureInput();
    second.parties[0]!.identityBundle.presentation = {
      kind: "session-key",
      key: "different-session-key",
      signature: "different-presentation",
    };
    const firstAuthority = createTerminalBundleAuthority(first);
    const secondAuthority = createTerminalBundleAuthority(second);
    expect(secondAuthority.parties[0]!.bundleHash).toBe(firstAuthority.parties[0]!.bundleHash);
    expect(terminalBundleAuthorityHash(secondAuthority)).toBe(
      terminalBundleAuthorityHash(firstAuthority),
    );
  });

  test("rejects caller-supplied bundle hashes and accessor-backed authority fields", () => {
    const withHash = failureInput() as unknown as {
      parties: Array<Record<string, unknown>>;
    };
    withHash.parties[0]!.bundleHash = "f".repeat(64);
    expect(() => createTerminalBundleAuthority(withHash as never)).toThrow(
      /one role and one verified IdentityBundle/i,
    );

    const accessor = failureInput() as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, "jobId", {
      enumerable: true,
      get: () => "getter-job-id",
    });
    expect(() => createTerminalBundleAuthority(accessor as never)).toThrow(/data property/i);
  });

  test("rejects fault attribution that is absent from the authenticated roster", () => {
    const input = failureInput("orchestrator");
    input.parties = input.parties.filter((party) => party.role !== "orchestrator");
    expect(() => createTerminalBundleAuthority(input)).toThrow(
      /absolute faultedParty do not agree/i,
    );
  });
});

describe("role-relative terminal plan", () => {
  test.each(ROLES)(
    "derives buyer, seller, and orchestrator perspectives for absolute %s fault",
    (faultedParty) => {
      const authority = createTerminalBundleAuthority(failureInput(faultedParty));
      const plan = createTerminalBundlePlan(authority, { kind: "co-signed" });
      expect(plan.copies.map((copy) => copy.role)).toEqual(ROLES);
      expect(
        Object.fromEntries(plan.copies.map((copy) => [copy.role, copy.outcome])),
      ).toEqual({
        buyer: faultedParty === "buyer" ? "failed-perm" : "failed-counterparty",
        seller: faultedParty === "seller" ? "failed-perm" : "failed-counterparty",
        orchestrator:
          faultedParty === "orchestrator" ? "failed-perm" : "failed-counterparty",
      });
      for (const copy of plan.copies) {
        expect(copy.signedScope.faultedParty).toBe(faultedParty);
        expect(copy.bundleContentHash).toBe(
          sha256Hex(canonicalize(copy.signedScope)),
        );
      }
    },
  );

  test("binds each fault perspective to its own signed-scope hash", () => {
    const plan = createTerminalBundlePlan(
      createTerminalBundleAuthority(failureInput("seller")),
      { kind: "co-signed" },
    );
    const buyer = plan.copies.find((copy) => copy.role === "buyer")!;
    const seller = plan.copies.find((copy) => copy.role === "seller")!;
    const orchestrator = plan.copies.find((copy) => copy.role === "orchestrator")!;
    expect(seller.bundleContentHash).not.toBe(buyer.bundleContentHash);
    expect(orchestrator.bundleContentHash).toBe(buyer.bundleContentHash);
    expect(terminalBundleSignedBytes(seller)).not.toEqual(terminalBundleSignedBytes(buyer));
  });

  test("builds and verifies the exact three-by-three signature matrix", () => {
    const plan = createTerminalBundlePlan(
      createTerminalBundleAuthority(failureInput("orchestrator")),
      { kind: "co-signed" },
    );
    const contributions = allContributions(plan);
    expect(contributions).toHaveLength(3);
    expect(contributions.every((row) => row.signatures.length === 3)).toBe(true);

    const matrix = createTerminalBundleSignatureMatrix(
      plan,
      [...contributions].reverse(),
      signerKeys(plan),
    );
    expect(matrix.copies).toHaveLength(3);
    for (const copy of matrix.copies) {
      expect(copy.signatures.map((signature) => signature.party)).toEqual([
        CLAIMS.buyer,
        CLAIMS.seller,
        CLAIMS.orchestrator,
      ]);
    }

    for (const role of ROLES) {
      const bundle = assembleTerminalBundleForOwnRole(
        plan,
        matrix,
        { role, primaryClaim: CLAIMS[role] },
        signerKeys(plan),
      );
      expect(isFaultAttestationBundle(bundle)).toBe(true);
      expect(bundle.anchoredByRole).toBe(role);
      expect(bundle.faultedParty).toBe("orchestrator");
      expect(bundle.outcome).toBe(
        role === "orchestrator" ? "failed-perm" : "failed-counterparty",
      );
      expect(bundle.signatures).toHaveLength(3);
      expect(Object.isFrozen(bundle)).toBe(true);
    }
  });

  test("keeps failed-substrate blameless but still requires the full matrix", () => {
    const input = failureInput();
    input.terminalClass = "failed-substrate";
    input.faultedParty = "none";
    input.terminalPhase.errorClass = "substrate";
    input.phaseSummary[2]!.errorClass = "substrate";
    const plan = createTerminalBundlePlan(createTerminalBundleAuthority(input), {
      kind: "co-signed",
    });
    expect(plan.copies.map((copy) => copy.outcome)).toEqual([
      "failed-substrate",
      "failed-substrate",
      "failed-substrate",
    ]);
    expect(new Set(plan.copies.map((copy) => copy.bundleContentHash)).size).toBe(1);
    const matrix = createTerminalBundleSignatureMatrix(
      plan,
      allContributions(plan),
      signerKeys(plan),
    );
    expect(matrix.copies.every((copy) => copy.signatures.length === 3)).toBe(true);
    expect(
      assembleTerminalBundleForOwnRole(
        plan,
        matrix,
        { role: "seller", primaryClaim: CLAIMS.seller },
        signerKeys(plan),
      ).faultedParty,
    ).toBe("none");
  });
});

describe("exact terminal signature matrix rejection", () => {
  test("rejects missing and duplicate signer rows", () => {
    const plan = createTerminalBundlePlan(
      createTerminalBundleAuthority(failureInput("seller")),
      { kind: "co-signed" },
    );
    const rows = allContributions(plan);
    expect(() =>
      createTerminalBundleSignatureMatrix(plan, rows.slice(0, 2), signerKeys(plan)),
    ).toThrow(/missing a required signer contribution/i);
    expect(() =>
      createTerminalBundleSignatureMatrix(
        plan,
        [rows[0]!, rows[0]!, rows[2]!],
        signerKeys(plan),
      ),
    ).toThrow(/duplicates signer role/i);
  });

  test("rejects duplicate and missing copy cells before matrix construction", () => {
    const plan = createTerminalBundlePlan(
      createTerminalBundleAuthority(failureInput("seller")),
      { kind: "co-signed" },
    );
    const buyerCopy = plan.copies.find((copy) => copy.role === "buyer")!;
    const buyerValue = Buffer.from(
      ed25519Sign(terminalBundleSignedBytes(buyerCopy), privateKeyFromSeed(seed("buyer"))),
    ).toString("base64url");
    expect(() =>
      createTerminalBundleSignatureContribution(plan, "buyer", [
        { copyRole: "buyer", value: buyerValue },
        { copyRole: "buyer", value: buyerValue },
      ]),
    ).toThrow(/duplicates copy role/i);
    expect(() =>
      createTerminalBundleSignatureContribution(plan, "buyer", [
        { copyRole: "buyer", value: buyerValue },
      ]),
    ).toThrow(/every planned role copy exactly once/i);
  });

  test("rejects a cryptographically substituted per-copy signature", () => {
    const plan = createTerminalBundlePlan(
      createTerminalBundleAuthority(failureInput("seller")),
      { kind: "co-signed" },
    );
    const sellerCopy = plan.copies.find((copy) => copy.role === "seller")!;
    const badBuyerRow = createTerminalBundleSignatureContribution(
      plan,
      "buyer",
      plan.copies.map((copy) => ({
        copyRole: copy.role,
        value: Buffer.from(
          ed25519Sign(
            terminalBundleSignedBytes(copy.role === "buyer" ? sellerCopy : copy),
            privateKeyFromSeed(seed("buyer")),
          ),
        ).toString("base64url"),
      })),
    );
    expect(() =>
      createTerminalBundleSignatureMatrix(
        plan,
        [badBuyerRow, contribution(plan, "seller"), contribution(plan, "orchestrator")],
        signerKeys(plan),
      ),
    ).toThrow(/does not verify for buyer copy/i);
  });

  test("rejects substituted signer metadata, public keys, and own-role identity", () => {
    const plan = createTerminalBundlePlan(
      createTerminalBundleAuthority(failureInput("buyer")),
      { kind: "co-signed" },
    );
    const rows = allContributions(plan);
    const substituted = structuredClone(rows[0]) as unknown as Record<string, unknown>;
    substituted.signer = CLAIMS.seller;
    expect(() =>
      createTerminalBundleSignatureMatrix(
        plan,
        [substituted, rows[1]!, rows[2]!],
        signerKeys(plan),
      ),
    ).toThrow(/substitutes a signer role or claim/i);

    const keys = signerKeys(plan);
    keys[0]!.publicKey = keys[1]!.publicKey;
    expect(() => createTerminalBundleSignatureMatrix(plan, rows, keys)).toThrow(
      /does not verify/i,
    );

    const matrix = createTerminalBundleSignatureMatrix(plan, rows, signerKeys(plan));
    expect(() =>
      assembleTerminalBundleForOwnRole(
        plan,
        matrix,
        { role: "buyer", primaryClaim: CLAIMS.seller },
        signerKeys(plan),
      ),
    ).toThrow(/exact locally owned role/i);
  });
});

describe("ST-3/ST-9 abort eligibility and suppression", () => {
  test("permits pre-commit abort and assembles only the non-faulted sole signer's copy", () => {
    const input = abortInput("commit-agreement");
    input.cancellation = { claimedPolicy: "pre-commit" };
    const authority = createTerminalBundleAuthority(input);
    const plan = createTerminalBundlePlan(authority, {
      kind: "single-signed-abort",
      signerRole: "buyer",
    });
    expect(plan.copies.map((copy) => copy.role)).toEqual(["buyer"]);
    expect(plan.copies[0]!.outcome).toBe("aborted-by-other");
    expect(plan.authority.abortEligibilityHash).toMatch(/^[0-9a-f]{64}$/);

    const rows = [contribution(plan, "buyer")];
    const keys = signerKeys(plan);
    const matrix = createTerminalBundleSignatureMatrix(plan, rows, keys);
    const bundle = assembleTerminalBundleForOwnRole(
      plan,
      matrix,
      { role: "buyer", primaryClaim: CLAIMS.buyer },
      keys,
    );
    expect(bundle).toMatchObject({
      anchoredByRole: "buyer",
      outcome: "aborted-by-other",
      faultedParty: "seller",
      cancellation: { claimedPolicy: "pre-commit" },
    });
    expect(bundle.signatures.map((signature) => signature.party)).toEqual([CLAIMS.buyer]);
  });

  test("permits settlement-pending abort only after authoritative no-effect observations", () => {
    const authority = createTerminalBundleAuthority(abortInput("pay-x402"));
    const plan = createTerminalBundlePlan(authority, {
      kind: "single-signed-abort",
      signerRole: "orchestrator",
    });
    expect(plan.copies).toHaveLength(1);
    expect(plan.copies[0]).toMatchObject({
      role: "orchestrator",
      outcome: "aborted-by-other",
    });
  });

  test("rejects ambiguous and final irreversible-effect observations", () => {
    const ambiguous = abortInput("pay-x402");
    ambiguous.abortEligibility!.payment = {
      disposition: "indeterminate",
      reason: "settlement read timed out",
      observedAt: NOW - 1,
    };
    expect(() => createTerminalBundleAuthority(ambiguous)).toThrow(
      /authoritative absence of every irreversible effect/i,
    );

    const final = abortInput("pay-x402");
    final.abortEligibility!.payment = {
      disposition: "final",
      evidenceHash: "d".repeat(64),
      observedAt: NOW - 1,
    };
    expect(() => createTerminalBundleAuthority(final)).toThrow(
      /final or ambiguous observations cannot be relabelled as abort/i,
    );
  });

  test("rejects post-irreversibility phase relabelling and an already-recorded terminal phase", () => {
    expect(() => createTerminalBundleAuthority(abortInput("rate"))).toThrow(
      /post-irreversibility/i,
    );

    const recorded = abortInput("pay-x402");
    recorded.phaseSummary = [
      ...recorded.phaseSummary,
      {
        index: 2,
        kind: "pay-x402",
        outcome: "fail",
        errorClass: "counterparty",
      },
    ];
    expect(() => createTerminalBundleAuthority(recorded)).toThrow(
      /already-recorded terminal phase/i,
    );
  });

  test("rejects a sole signer that is the faulted role or not in the session", () => {
    const authority = createTerminalBundleAuthority(abortInput());
    expect(() =>
      createTerminalBundlePlan(authority, {
        kind: "single-signed-abort",
        signerRole: "seller",
      }),
    ).toThrow(/must not be faulted/i);

    const twoParty = abortInput();
    twoParty.parties = twoParty.parties.filter((party) => party.role !== "orchestrator");
    const twoPartyAuthority = createTerminalBundleAuthority(twoParty);
    expect(() =>
      createTerminalBundlePlan(twoPartyAuthority, {
        kind: "single-signed-abort",
        signerRole: "orchestrator",
      }),
    ).toThrow(/not a role in the session roster/i);
  });

  test("rejects abort attribution whose trigger actor differs from absolute fault", () => {
    const input = abortInput();
    input.abortEligibility!.triggeredBy = "buyer";
    expect(() => createTerminalBundleAuthority(input)).toThrow(
      /does not bind the terminal fault authority/i,
    );
  });

  test("co-signed abort preserves all three role perspectives", () => {
    const plan = createTerminalBundlePlan(createTerminalBundleAuthority(abortInput()), {
      kind: "co-signed",
    });
    expect(
      Object.fromEntries(plan.copies.map((copy) => [copy.role, copy.outcome])),
    ).toEqual({
      buyer: "aborted-by-other",
      seller: "aborted-by-self",
      orchestrator: "aborted-by-other",
    });
    const matrix = createTerminalBundleSignatureMatrix(
      plan,
      allContributions(plan),
      signerKeys(plan),
    );
    expect(
      assembleTerminalBundleForOwnRole(
        plan,
        matrix,
        { role: "seller", primaryClaim: CLAIMS.seller },
        signerKeys(plan),
      ).outcome,
    ).toBe("aborted-by-self");
  });
});
