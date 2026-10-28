import { describe, expect, expectTypeOf, test, vi } from "vitest";

import { buildAgent, type AgentConfig } from "../../src/agent/Agent.js";
import type { AnchorReceipt } from "../../src/artifacts/types.js";
import { paymentEvidenceAddress } from "../../src/canonical/index.js";
import {
  AttestationRefRejection,
  DacsError,
  type AnyAttestationBundle,
  type AttestationRef,
  type BundleParty,
  type VerifyBundleDeps,
} from "../../src/index.js";

// Pass-through: records the deps the Agent hands to verifyBundleCore so its
// resolveAttestationRef can be called directly, as a host composing it would.
const captured = vi.hoisted(() => ({ deps: [] as VerifyBundleDeps[] }));
vi.mock("../../src/agent/verifyBundleCore.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/agent/verifyBundleCore.js")>();
  return {
    ...original,
    verifyBundleCore: (...args: Parameters<typeof original.verifyBundleCore>) => {
      captured.deps.push(args[1]);
      return original.verifyBundleCore(...args);
    },
  };
});

type ResolveAttestationRef = NonNullable<VerifyBundleDeps["resolveAttestationRef"]>;
type Outcome = AnyAttestationBundle["outcome"];

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7E";
const nativeEvidence = "stor-" + "e".repeat(40);
const ref: AttestationRef = {
  anchor: {
    kind: "storage-program",
    locator: paymentEvidenceAddress(JOB_ID, "x402:default", 0),
  },
  contentHash: "a".repeat(64),
};
const parties: BundleParty[] = [];

// Source compatibility (tsc-checked; vitest strips types). The README's
// three-parameter implementations still assign to the exported type.
const threeParameter: ResolveAttestationRef = async (artifactRef, jobId, bundleParties) =>
  ({ locator: artifactRef.anchor.locator, jobId, parties: bundleParties.length });
// An implementation that reads the outcome must handle its absence.
const fourParameter: ResolveAttestationRef = async (_ref, _jobId, _parties, outcome) => {
  expectTypeOf(outcome).toEqualTypeOf<Outcome | undefined>();
  return outcome === undefined ? null : { outcome };
};
// Direct calls through the type compile with three or four arguments, and the
// outcome stays typed.
async function callDirectly(resolve: ResolveAttestationRef) {
  await resolve(ref, JOB_ID, parties);
  await resolve(ref, JOB_ID, parties, "failed-perm");
  // @ts-expect-error the outcome is still the bundle outcome union
  await resolve(ref, JOB_ID, parties, "not-an-outcome");
}
// Custom resolvers classify refusals with the root-exported rejection class.
const classifying: ResolveAttestationRef = async () => {
  throw new AttestationRefRejection("indeterminate", "no verified carrier");
};

function receipt(state: AnchorReceipt["state"]): AnchorReceipt {
  return {
    receiptVersion: "1",
    substrate: "demos",
    finalityProfile: "demos-bft-confirmed-native-read",
    logicalAddress: ref.anchor.locator,
    nativeAddress: nativeEvidence,
    contentHash: ref.contentHash,
    transactionRef: { kind: "demos-storage-program", value: "0x" + "7".repeat(64) },
    writer: "did:demos:agent:" + "ab".repeat(32),
    nonce: "3",
    state,
    observationDisposition: "established",
    observedAt: 1780000000000,
    blockRef: { id: "0x" + "8".repeat(64), height: "12", timestamp: 1780000000000 },
    evidence: { kind: "demos-bft-write-proof-v1", value: "e30" },
  };
}

/** The Agent's own resolveAttestationRef, captured from one verification. */
async function agentResolver(
  callback: AgentConfig["resolveAttestationAnchorReceipt"],
) {
  const evidence = { evidence: "native" };
  const readAnchor = vi.fn(async (address: string) =>
    address === nativeEvidence ? evidence : null);
  const agent = buildAgent(
    { readAnchor, resolveAnchorByName: async () => ({ status: "absent" }) } as never,
    { demosRpc: "mem", resolveAttestationAnchorReceipt: callback },
  );
  captured.deps.length = 0;
  await agent.verifyBundle("bundle");
  const resolve = captured.deps[0]?.resolveAttestationRef;
  if (!resolve) throw new Error("verifyBundleCore was not given a resolver");
  return { resolve, readAnchor, evidence };
}

describe("resolveAttestationRef source compatibility", () => {
  test("AttestationRefRejection is exported from the package root", async () => {
    const rejection = new AttestationRefRejection("indeterminate", "no verified carrier");
    expect(rejection).toBeInstanceOf(DacsError);
    expect(rejection).toMatchObject({
      name: "AttestationRefRejection",
      disposition: "indeterminate",
    });
    await expect(classifying(ref, JOB_ID, parties)).rejects.toBeInstanceOf(
      AttestationRefRejection,
    );
  });

  test("three- and four-parameter implementations accept a direct call", async () => {
    await expect(threeParameter(ref, JOB_ID, parties)).resolves.toEqual({
      locator: ref.anchor.locator, jobId: JOB_ID, parties: 0 });
    await expect(fourParameter(ref, JOB_ID, parties)).resolves.toBeNull();
    await expect(fourParameter(ref, JOB_ID, parties, "aborted-by-self"))
      .resolves.toEqual({ outcome: "aborted-by-self" });
    const seen: unknown[][] = [];
    await callDirectly(async (...args) => { seen.push(args); return null; });
    expect(seen.map((args) => args.length)).toEqual([3, 4, 4]);
  });

  describe("the Agent's resolver called without an outcome", () => {
    test("applies the strictest gate: an included receipt is indeterminate", async () => {
      const { resolve, readAnchor } = await agentResolver(() => receipt("included"));
      const rejection = await resolve(ref, JOB_ID, parties).then(
        () => null, (error: unknown) => error);
      expect(rejection).toBeInstanceOf(AttestationRefRejection);
      expect(rejection).toMatchObject({ disposition: "indeterminate" });
      expect(readAnchor).not.toHaveBeenCalledWith(nativeEvidence);
    });

    test("still admits an established finalized receipt", async () => {
      const { resolve, readAnchor, evidence } = await agentResolver(() => receipt("finalized"));
      await expect(resolve(ref, JOB_ID, parties)).resolves.toEqual(evidence);
      expect(readAnchor).toHaveBeenCalledWith(nativeEvidence);
    });

    test("a failed outcome passed explicitly admits the included receipt", async () => {
      const { resolve, evidence } = await agentResolver(() => receipt("included"));
      await expect(resolve(ref, JOB_ID, parties, "failed-perm")).resolves.toEqual(evidence);
    });
  });
});
