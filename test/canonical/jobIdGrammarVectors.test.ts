import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test, vi } from "vitest";

import { lookupBundleCopies } from "../../src/agent/bundleConsistency.js";
import { bundleAddress } from "../../src/canonical/addressing.js";
import * as hash from "../../src/canonical/hash.js";
import {
  jid1BundleAddress,
  jid1PaymentEvidenceAddress,
} from "../../src/canonical/jid1Addressing.js";
import { DacsError } from "../../src/errors.js";
import { finalityCommitmentAddress } from "../../src/negotiate/commitment.js";
import { isCanonicalJobId, requireCanonicalJobId } from "../../src/negotiate/jobId.js";

type BundleRole = "buyer" | "seller" | "orchestrator";

interface GrammarVector {
  name: string;
  operation: string;
  expected: "pass" | "fail" | "error";
  jobId?: unknown;
  otherJobId?: unknown;
  role?: BundleRole;
  sessionId?: string;
  template?: string;
  want: {
    canonicalJobId?: string;
    logicalAddress?: string;
    equal?: boolean;
    hashCalls: number;
    lookupCalls: number;
  };
}

// The fixture is shared with the client package; read it in place, never copy it.
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../packages/dacs-client/test/fixtures/job-id-grammar-v0.1.json",
);
const grammar = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
  count: number;
  vectors: GrammarVector[];
};

const BUNDLE_ROLES = 2; // lookupBundleCopies derives and reads buyer and seller.
const REPLAYED_OPERATIONS = [
  "validate",
  "derive-bundle",
  "derive-logical",
  "lookup-bundle",
  "compare",
  "profile-admit",
];

// Core builders that fill each `derive-logical` template of the fixture.
const LOGICAL_TEMPLATES: Record<string, (jobId: string) => string> = {
  "dacs3:commit:{jobId}": (jobId) => finalityCommitmentAddress(jobId),
  "dacs4:payment:{jobId}:evm-erc20%3A1%3AUSDC:3": (jobId) =>
    jid1PaymentEvidenceAddress(jobId, "evm-erc20:1:USDC", 3),
};

const hashSpy = () => vi.spyOn(hash, "sha256Hex");

function countingReader() {
  const reads: Array<{ address: string; role: string }> = [];
  const read = async (address: string, role: string) => {
    reads.push({ address, role });
    return { disposition: "absent" as const };
  };
  return { reads, read };
}

const replay: Record<string, (vector: GrammarVector) => Promise<void> | void> = {
  validate(vector) {
    expect(isCanonicalJobId(vector.jobId)).toBe(true);
    expect(requireCanonicalJobId(vector.jobId)).toBe(vector.want.canonicalJobId);
  },

  "derive-bundle"(vector) {
    const spy = hashSpy();
    expect(jid1BundleAddress(vector.jobId as string, vector.role!)).toBe(
      vector.want.logicalAddress,
    );
    expect(spy).toHaveBeenCalledTimes(vector.want.hashCalls);
    expect(bundleAddress(vector.jobId as string, vector.role!)).toBe(
      vector.want.logicalAddress,
    );
  },

  "derive-logical"(vector) {
    const build = LOGICAL_TEMPLATES[vector.template!];
    expect(build, `no core builder for template ${vector.template}`).toBeDefined();
    const spy = hashSpy();
    expect(build!(vector.jobId as string)).toBe(vector.want.logicalAddress);
    expect(spy).toHaveBeenCalledTimes(vector.want.hashCalls);
  },

  async "lookup-bundle"(vector) {
    const spy = hashSpy();
    const { reads, read } = countingReader();
    const lookup = lookupBundleCopies(vector.jobId as string, read);
    if (vector.expected === "error") {
      await expect(lookup).rejects.toThrow(DacsError);
      expect(() => jid1BundleAddress(vector.jobId as string, vector.role!)).toThrow(
        DacsError,
      );
      expect(reads).toHaveLength(vector.want.lookupCalls);
      expect(spy).toHaveBeenCalledTimes(vector.want.hashCalls);
      return;
    }
    await expect(lookup).resolves.toMatchObject({
      buyer: { disposition: "absent" },
      seller: { disposition: "absent" },
    });
    // The vector counts one role; lookupBundleCopies does the same for both.
    const readsForRole = reads.filter((entry) => entry.role === vector.role);
    expect(readsForRole).toHaveLength(vector.want.lookupCalls);
    expect(readsForRole[0]!.address).toBe(vector.want.logicalAddress);
    expect(reads).toHaveLength(vector.want.lookupCalls * BUNDLE_ROLES);
    expect(spy).toHaveBeenCalledTimes(vector.want.hashCalls * BUNDLE_ROLES);
  },

  compare(vector) {
    const spy = hashSpy();
    const compare = () =>
      requireCanonicalJobId(vector.jobId) === requireCanonicalJobId(vector.otherJobId);
    if (vector.expected === "error") {
      expect(compare).toThrow(DacsError);
    } else {
      expect(compare()).toBe(vector.want.equal);
    }
    expect(spy).toHaveBeenCalledTimes(vector.want.hashCalls);
  },

  // Profile admission itself needs verifier-owned peer evidence and is not a core
  // function. The core part of these vectors is that their session is a valid job
  // ID for bundle derivation and lookup.
  async "profile-admit"(vector) {
    expect(isCanonicalJobId(vector.sessionId)).toBe(true);
    const { reads, read } = countingReader();
    await lookupBundleCopies(vector.sessionId!, read);
    expect(reads.map((entry) => entry.role).sort()).toEqual(["buyer", "seller"]);
    expect(reads.map((entry) => entry.address).sort()).toEqual(
      [
        bundleAddress(vector.sessionId!, "buyer"),
        bundleAddress(vector.sessionId!, "seller"),
      ].sort(),
    );
  },
};

describe("job ID grammar vectors replayed through the core functions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("every vector and every operation of the fixture is accounted for (profile-admit outcomes are a todo)", () => {
    expect(grammar.vectors).toHaveLength(grammar.count);
    expect(new Set(grammar.vectors.map((vector) => vector.operation))).toEqual(
      new Set(REPLAYED_OPERATIONS),
    );
    expect(Object.keys(replay).sort()).toEqual([...REPLAYED_OPERATIONS].sort());
  });

  // The profile-admit vectors are replayed only for their session ID (it is a canonical job ID that
  // derives and looks up); their admit-or-refuse outcome is not checked here.
  test.each(
    grammar.vectors.map((vector) => [
      vector.operation === "profile-admit"
        ? `${vector.operation}/${vector.name} (session ID lookup only, outcome not checked)`
        : `${vector.operation}/${vector.name}`,
      vector,
    ] as const),
  )(
    "%s",
    async (_label, vector) => {
      await replay[vector.operation]!(vector);
    },
  );

  test.todo("profile-admit outcomes (admit or refuse) need verifier-owned peer evidence and are not a core function");
});
