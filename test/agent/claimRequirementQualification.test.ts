import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  canonicalize,
  contentHash,
  sha256Hex,
  stripSignature,
} from "../../src/canonical/index.js";
import {
  ed25519Verify,
  publicKeyFromRaw,
} from "../../src/crypto/index.js";
import {
  evaluateClaimRequirementQualification,
  type ClaimQualificationAuthentication,
  type ClaimQualificationDeps,
  type ClaimQualificationInput,
  type ClaimQualificationReplayAuthority,
} from "../../src/agent/index.js";

const vectors = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../fixtures/standard-next/claim-requirement-qualification-v0.3.json",
    ),
    "utf8",
  ),
) as any;

const publicKey = (claim: unknown) => {
  const encoded = typeof claim === "string" ? vectors.publicKeys[claim] : undefined;
  return typeof encoded === "string"
    ? publicKeyFromRaw(Uint8Array.from(Buffer.from(encoded, "base64url")))
    : null;
};

function verifySigned(
  artifact: unknown,
  ref: any,
  domain: string,
): ClaimQualificationAuthentication {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return "invalid";
  const signed = artifact as Record<string, any>;
  const signature = signed.signature;
  if (
    !signature ||
    signature.algorithm !== "ed25519" ||
    typeof signature.signer !== "string" ||
    typeof signature.value !== "string"
  ) return "invalid";
  const hash = contentHash(stripSignature(signed) as Record<string, unknown>);
  if (
    ref?.contentHash !== hash ||
    (ref?.signer !== undefined && ref.signer !== signature.signer)
  ) return "invalid";
  const key = publicKey(signature.signer);
  if (!key) return "indeterminate";
  try {
    return ed25519Verify(
      Uint8Array.from(Buffer.from(`${domain}${hash}`, "ascii")),
      Uint8Array.from(Buffer.from(signature.value, "base64url")),
      key,
    ) ? "valid" : "invalid";
  } catch {
    return "invalid";
  }
}

function verifyBundle(bundle: unknown): ClaimQualificationAuthentication {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return "invalid";
  const value = bundle as Record<string, any>;
  if (
    value.bundleVersion !== "1" ||
    !Array.isArray(value.parties) ||
    !Array.isArray(value.signatures)
  ) return "invalid";
  const scope = structuredClone(value);
  delete scope.signatures;
  delete scope.anchoredByRole;
  const hash = contentHash(scope);
  const required = new Set(
    value.parties
      .filter((party: any) => ["buyer", "seller", "orchestrator"].includes(party?.role))
      .map((party: any) => party.primaryClaim),
  );
  const seen = new Set<string>();
  try {
    for (const signature of value.signatures) {
      const key = publicKey(signature.party);
      if (
        signature.algorithm !== "ed25519" ||
        seen.has(signature.party) ||
        !key ||
        !ed25519Verify(
          Uint8Array.from(Buffer.from(`dacs-bundle:v1:${hash}`, "ascii")),
          Uint8Array.from(Buffer.from(signature.value, "base64url")),
          key,
        )
      ) return key ? "invalid" : "indeterminate";
      seen.add(signature.party);
    }
  } catch {
    return "invalid";
  }
  return [...required].every((claim) => seen.has(claim)) ? "valid" : "invalid";
}

const deps: ClaimQualificationDeps = {
  resolveAuthenticatedSessionStart: (handle) =>
    vectors.authenticatedSessionStarts[handle] ?? null,
  authenticateProductionQualification: () => "valid",
  authenticateReplayBundle: verifyBundle,
  authenticateCompositeRecord: ({ record, ref }) =>
    verifySigned(record, ref, "dacs-composite:v1:"),
  authenticateVerifyResult: ({ result, ref }) =>
    verifySigned(result, ref, "dacs-verifyresult:v1:"),
  resolveRecipeRegistry: (version) =>
    vectors.recipeRegistries.find(
      (registry: any) => registry.recipeRegistryVersion === version,
    ) ?? null,
};

function inputFor(vector: any): ClaimQualificationInput {
  const input = structuredClone(vector.input);
  const authority = input.aggregationAuthority;
  if (authority?.kind === "replay" && typeof authority.bundle === "string") {
    const material = vectors.replayRecords[authority.record];
    input.aggregationAuthority = {
      kind: "replay",
      bundle: vectors.replayBundles[authority.bundle],
      recordRef: authority.recordRef,
      record: material?.record,
      results: material?.results,
    } satisfies ClaimQualificationReplayAuthority;
  }
  return input as ClaimQualificationInput;
}

describe("DACS-2 CRQ-1..CRQ-4 claim qualification", () => {
  it("replays all 36 adopted Standard security vectors", async () => {
    expect(vectors.count).toBe(36);
    expect(vectors.vectors).toHaveLength(36);
    for (const vector of vectors.vectors) {
      expect(
        (await evaluateClaimRequirementQualification(inputFor(vector), deps)).decision,
        vector.name,
      ).toBe(vector.expected);
    }
  });

  it("does not accept an unsigned SessionRecord as replay authority", async () => {
    const vector = vectors.vectors.find(
      (item: any) => item.name === "vet-claim-requirement-unsigned-session-record-replay-error",
    );
    expect(
      (await evaluateClaimRequirementQualification(inputFor(vector), deps)).decision,
    ).toBe("error");
  });

  it("authenticates authority before a conclusive requirement failure", async () => {
    const vector = vectors.vectors.find(
      (item: any) => item.name === "vet-claim-requirement-unresolvable-preflight-precedes-fail",
    );
    expect(
      (await evaluateClaimRequirementQualification(inputFor(vector), deps)).decision,
    ).toBe("error");
  });

  it("captures dependency methods and rejects accessors without invocation", async () => {
    let touched = false;
    const hostile = {
      get resolveAuthenticatedSessionStart() {
        touched = true;
        return () => null;
      },
    } as unknown as ClaimQualificationDeps;
    const result = await evaluateClaimRequirementQualification(
      inputFor(vectors.vectors[0]),
      hostile,
    );
    expect(result.decision).toBe("error");
    expect(touched).toBe(false);
  });

  it("rejects callable proxy dependencies without touching proxy traps", async () => {
    let touched = false;
    const callableProxy = new Proxy(() => null, {
      get() {
        touched = true;
        throw new Error("callable proxy trap must remain inert");
      },
    });
    const hostile = {
      ...deps,
      resolveAuthenticatedSessionStart: callableProxy,
    } as unknown as ClaimQualificationDeps;
    await expect(
      evaluateClaimRequirementQualification(inputFor(vectors.vectors[0]), hostile),
    ).resolves.toMatchObject({ decision: "error", reason: "authority-invalid" });
    expect(touched).toBe(false);
  });

  it("requires trusted authentication of the complete production qualification", async () => {
    const vector = vectors.vectors.find(
      (item: any) => item.name === "vet-claim-requirement-parameters-mismatch-fail",
    );
    const trusted = inputFor(vector);
    const trustedHash = sha256Hex(canonicalize(trusted));
    const boundDeps: ClaimQualificationDeps = {
      ...deps,
      authenticateProductionQualification: (candidate) =>
        sha256Hex(canonicalize(candidate)) === trustedHash ? "valid" : "invalid",
    };
    expect(
      (await evaluateClaimRequirementQualification(trusted, boundDeps)).decision,
    ).toBe("fail");

    const forged = structuredClone(trusted);
    forged.resolvedResults[0]!.data = { possessionVerified: true };
    expect(
      (await evaluateClaimRequirementQualification(forged, boundDeps)).decision,
    ).toBe("error");
  });

  it("rejects malformed groups and future-dated projections without throwing", async () => {
    const malformed = inputFor(vectors.vectors[0]);
    (malformed.requirement as any).oneOf = "not-an-array";
    await expect(
      evaluateClaimRequirementQualification(malformed, deps),
    ).resolves.toMatchObject({ decision: "error", reason: "qualification-invalid" });

    const future = inputFor(vectors.vectors[0]);
    future.resolvedResults[0]!.verifiedAt = future.generatedAt + 1;
    await expect(
      evaluateClaimRequirementQualification(future, deps),
    ).resolves.toMatchObject({ decision: "error", reason: "qualification-invalid" });
  });

  it("binds captured dependency methods to their original receiver", async () => {
    const receiverDeps = {
      ...deps,
      marker: "trusted",
      resolveAuthenticatedSessionStart(this: { marker: string }, handle: string) {
        return this.marker === "trusted"
          ? vectors.authenticatedSessionStarts[handle] ?? null
          : null;
      },
      authenticateProductionQualification(this: { marker: string }) {
        return this.marker === "trusted" ? "valid" as const : "invalid" as const;
      },
    };
    expect(
      (await evaluateClaimRequirementQualification(
        inputFor(vectors.vectors[0]),
        receiverDeps,
      )).decision,
    ).toBe("pass");
  });
});
