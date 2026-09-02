import { describe, expect, test } from "vitest";

import type {
  CompositeVerificationRecord,
  IdentityBundle,
} from "../../src/artifacts/types.js";
import { contentHash } from "../../src/canonical/index.js";
import { identityBundleHash } from "../../src/identity/index.js";
import {
  compositeVerificationAddress,
  type FinalizedVetAnchorReceipt,
  type VetProduction,
} from "../../src/agent/vetCore.js";
import { createTerminalBundlePlan } from
  "../../src/agent/terminalBundleFinalization.js";
import {
  prepareVetTerminalBundle,
  type PrepareVetTerminalBundleInput,
  type VetProductionAuthentication,
} from "../../src/agent/vetTerminalBundle.js";

const STARTED_AT = 1_788_000_000_000;
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7E";
const BUYER = `demos:agent:${"11".repeat(32)}`;
const SELLER = `demos:agent:${"22".repeat(32)}`;
const SIGNATURE = Buffer.alloc(64, 7).toString("base64url");

function identity(role: "buyer" | "seller"): IdentityBundle {
  const presentedBy = role === "buyer" ? BUYER : SELLER;
  return {
    bundleVersion: "1",
    presentedBy,
    presentedAt: STARTED_AT - 1_000,
    sessionNonce: `${role}-session-nonce`,
    claims: [{ ref: presentedBy }],
    presentation: {
      kind: "session-key",
      key: `${role}-session-key`,
      signature: `${role}-presentation-signature`,
    },
  };
}

function production(
  decision: CompositeVerificationRecord["overallDecision"],
): VetProduction {
  const seller = identity("seller");
  const logicalAddress = compositeVerificationAddress(JOB_ID, SELLER);
  const record: CompositeVerificationRecord = {
    recordVersion: "1",
    jobId: JOB_ID,
    evaluatedParty: SELLER,
    bundleHash: identityBundleHash(seller),
    requirementHash: "33".repeat(32),
    freshness: [],
    supplementary: [],
    dealSpecific: [],
    overallDecision: decision,
    generatedAt: STARTED_AT + 100,
    signature: {
      algorithm: "ed25519",
      signer: BUYER,
      value: SIGNATURE,
    },
  };
  const recordHash = contentHash(record as unknown as Record<string, unknown>);
  const receipt: FinalizedVetAnchorReceipt = {
    receiptVersion: "1",
    substrate: "demos",
    finalityProfile: "demos-bft",
    logicalAddress,
    nativeAddress: `stor-${"44".repeat(32)}`,
    contentHash: recordHash,
    transactionRef: { kind: "demos", value: "55".repeat(32) },
    writer: BUYER,
    nonce: "7",
    state: "finalized",
    observationDisposition: "established",
    observedAt: STARTED_AT + 500,
    blockRef: {
      id: "66".repeat(32),
      height: "42",
      timestamp: STARTED_AT + 450,
    },
    evidence: { kind: "demos-bft", value: "77".repeat(32) },
  };
  return {
    record,
    recordRef: {
      anchor: { kind: "storage-program", locator: receipt.nativeAddress },
      contentHash: recordHash,
      signer: BUYER,
    },
    anchorReceipt: receipt,
  };
}

function input(
  decision: CompositeVerificationRecord["overallDecision"] = "fail",
): PrepareVetTerminalBundleInput {
  return {
    jobId: JOB_ID,
    listingRef: {
      listingId: "vet-terminal-listing",
      version: 1,
      contentHash: "88".repeat(32),
    },
    pipeline: [
      { kind: "vet-credentials" },
      { kind: "negotiate-fixed-price" },
      { kind: "commit-agreement" },
      { kind: "pay-dem", parameters: { rail: "demos-native" } },
      { kind: "deliver-attested-payload" },
    ],
    vetPhaseIndex: 0,
    vetInvokedAt: STARTED_AT + 50,
    startedAt: STARTED_AT,
    recipeRegistryVersion: 1,
    railRegistryVersion: 1,
    parties: [
      { role: "buyer", identityBundle: identity("buyer") },
      { role: "seller", identityBundle: identity("seller") },
    ],
    evaluatedRole: "seller",
    production: production(decision),
  };
}

function authentication(
  value: VetProductionAuthentication = { status: "valid" },
) {
  return {
    authenticateProduction: async () => value,
  };
}

describe("terminal Vet bundle preparation", () => {
  test("turns only an authenticated objective fail into a vet-failed authority", async () => {
    const result = await prepareVetTerminalBundle(input(), authentication());
    expect(result.status).toBe("terminal");
    if (result.status !== "terminal") throw new Error();

    expect(result).toMatchObject({
      state: "vet-failed",
      faultedParty: "seller",
      sessionRecord: {
        state: "vet-failed",
        endedAt: STARTED_AT + 500,
        lastUpdatedAt: STARTED_AT + 500,
        phaseResults: [{
          index: 0,
          step: { kind: "vet-credentials" },
          result: {
            ok: false,
            reason: "authenticated-vet-failure",
            errorClass: "counterparty",
          },
        }],
      },
      authority: {
        terminalClass: "failure",
        faultedParty: "seller",
        terminalPhase: {
          index: 0,
          kind: "vet-credentials",
          state: "failed",
          errorClass: "counterparty",
        },
        settlementEvidence: [],
      },
    });
    expect(result.authority.agreementRef).toBeUndefined();
    expect(result.authority.vetRecords).toEqual([input().production.recordRef]);
    expect(result.authority.phaseSummary).toEqual([{
      index: 0,
      kind: "vet-credentials",
      outcome: "fail",
      errorClass: "counterparty",
      attestationRef: input().production.recordRef,
    }]);
    expect(result.sessionRecord.parties[1]).toMatchObject({
      role: "seller",
      vetRecordRef: input().production.recordRef,
    });
    expect(result.sessionRecord.parties[0]!.vetRecordRef).toBeUndefined();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.authority)).toBe(true);

    const plan = createTerminalBundlePlan(result.authority, { kind: "co-signed" });
    expect(plan.requiredSigners.map(({ role }) => role)).toEqual(["buyer", "seller"]);
    expect(() => createTerminalBundlePlan(result.authority, {
      kind: "single-signed-abort",
      signerRole: "buyer",
    })).toThrow(/only an abort authority/i);
  });

  test.each(["indeterminate", "error"] as const)(
    "keeps an authenticated %s decision non-terminal and blameless",
    async (decision) => {
      const result = await prepareVetTerminalBundle(input(decision), authentication());
      expect(result).toMatchObject({ status: "retry", decision });
      expect(result).not.toHaveProperty("authority");
      expect(result).not.toHaveProperty("faultedParty");
    },
  );

  test("passes an authenticated passing record without producing terminal state", async () => {
    const result = await prepareVetTerminalBundle(input("pass"), authentication());
    expect(result).toMatchObject({ status: "pass", record: { overallDecision: "pass" } });
    expect(result).not.toHaveProperty("authority");
  });

  test.each([
    { status: "invalid", reason: "signature invalid" },
    { status: "indeterminate", reason: "authority unavailable" },
  ] as const)("does not classify an unauthenticated production as failure", async (outcome) => {
    const result = await prepareVetTerminalBundle(input(), authentication(outcome));
    expect(result).toEqual(outcome);
    expect(result).not.toHaveProperty("authority");
  });

  test("treats a foreign authenticator failure as indeterminate, never counterparty fault", async () => {
    const result = await prepareVetTerminalBundle(input(), {
      authenticateProduction: async () => {
        throw new Error("RPC unavailable");
      },
    });
    expect(result).toEqual({
      status: "indeterminate",
      reason: "Vet production authentication failed",
    });
  });

  test("rejects substituted role, bundle and native-address bindings before classification", async () => {
    const wrongRole = input();
    wrongRole.evaluatedRole = "buyer";
    await expect(prepareVetTerminalBundle(wrongRole, authentication())).rejects.toThrow(
      /exact session roles and anchor/i,
    );

    const wrongBundle = input();
    wrongBundle.production.record.bundleHash = "99".repeat(32);
    await expect(prepareVetTerminalBundle(wrongBundle, authentication())).rejects.toThrow(
      /exact session roles and anchor/i,
    );

    const wrongAddress = input();
    wrongAddress.production.recordRef.anchor.locator = `stor-${"aa".repeat(32)}`;
    await expect(prepareVetTerminalBundle(wrongAddress, authentication())).rejects.toThrow(
      /exact session roles and anchor/i,
    );
  });

  test("rejects a non-canonical job id before authenticating terminal authority", async () => {
    const candidate = input();
    candidate.jobId = "legacy-job";
    let authenticatorCalls = 0;
    await expect(prepareVetTerminalBundle(candidate, {
      authenticateProduction: async () => {
        authenticatorCalls += 1;
        return { status: "valid" };
      },
    })).rejects.toThrow(/canonical uppercase ULID/);
    expect(authenticatorCalls).toBe(0);
  });

  test("rejects accessors before invoking application-controlled code", async () => {
    const candidate = input() as unknown as Record<string, unknown>;
    let getterCalls = 0;
    Object.defineProperty(candidate, "jobId", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return JOB_ID;
      },
    });
    let authenticatorCalls = 0;
    await expect(prepareVetTerminalBundle(
      candidate as unknown as PrepareVetTerminalBundleInput,
      {
        authenticateProduction: async () => {
          authenticatorCalls += 1;
          return { status: "valid" };
        },
      },
    )).rejects.toThrow(/accessors/i);
    expect(getterCalls).toBe(0);
    expect(authenticatorCalls).toBe(0);
  });

  test("rejects an accessor-backed authenticator without invoking its getter", async () => {
    let getterCalls = 0;
    const deps: Record<string, unknown> = {};
    Object.defineProperty(deps, "authenticateProduction", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return async () => ({ status: "valid" as const });
      },
    });
    await expect(prepareVetTerminalBundle(
      input(),
      deps as unknown as Parameters<typeof prepareVetTerminalBundle>[1],
    )).rejects.toThrow(/stable authenticator/i);
    expect(getterCalls).toBe(0);
  });
});
