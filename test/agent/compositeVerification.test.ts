import { describe, expect, test } from "vitest";

import {
  aggregateCompositeVerification,
  canonicalize,
  contentHash,
  ed25519Sign,
  ed25519Verify,
  isCompositeVerificationRecord,
  isCompositeBundleRequirement,
  isLegacyCompositeVerificationRecord,
  isSupplementarySignal,
  isVerificationWarning,
  isVerifyResult,
  isVerifyResultRef,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
  readCompositeVerificationRecord,
  sha256Hex,
  signComponentArtifact,
  signedBytes,
  stripSignature,
  verifyCompositeVerificationRecord,
  type AuthorityVerification,
  type CompositeBundleRequirement,
  type CompositeVerificationExpectations,
  type CompositeVerificationRecord,
  type ExpectedVerifyResult,
  type ResolvedVerificationContent,
  type VerifyCompositeVerificationDeps,
  type VerifyResult,
  type VerifyResultRef,
} from "../../src/index.js";

const VERIFIER_SEED = new Uint8Array(32).fill(21);
const AUTHORITY_SEED = new Uint8Array(32).fill(22);
const VERIFIER_KEY = rawPublicKey(publicKeyFromSeed(VERIFIER_SEED));
const AUTHORITY_KEY = rawPublicKey(publicKeyFromSeed(AUTHORITY_SEED));
const VERIFIER = `key:${Buffer.from(VERIFIER_KEY).toString("hex")}`;
const AUTHORITY = `key:${Buffer.from(AUTHORITY_KEY).toString("hex")}`;
const PARTY = "domain:alice.example";
const BUNDLE_HASH = "a".repeat(64);
const NOW = 1780000000000;
const RESULT_LOCATOR = "stor:verify-result-1";
const AUTHORITY_LOCATOR = "https://authority.example/evidence-1";

const requirement: CompositeBundleRequirement = {
  requirementVersion: "1",
  required: [
    {
      scheme: "domain",
      verificationRequired: true,
      recipeVersion: 1,
    },
  ],
};

async function signResult(
  unsigned: Omit<VerifyResult, "signature">,
): Promise<VerifyResult> {
  return (await signComponentArtifact(unsigned, "dacs-verifyresult:v1:", {
    algorithm: "ed25519",
    signer: VERIFIER,
    sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(VERIFIER_SEED)),
  })) as VerifyResult;
}

async function signRecord(
  unsigned: Omit<CompositeVerificationRecord, "signature">,
): Promise<CompositeVerificationRecord> {
  return (await signComponentArtifact(unsigned, "dacs-composite:v1:", {
    algorithm: "ed25519",
    signer: VERIFIER,
    sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(VERIFIER_SEED)),
  })) as CompositeVerificationRecord;
}

async function fixture() {
  const recipe = await signComponentArtifact(
    {
      recipeVersion: 1,
      scheme: "domain",
      defaultMethod: {
        kind: "consensus-backed-proxy" as const,
        endpoint: {
          method: "GET" as const,
          urlTemplate: "https://authority.example/{identifier}",
        },
      },
      defaultMaxAgeSec: 3600,
      parserRules: { format: "json" as const, successJsonPath: "$.active" },
      retryClass: "permanent" as const,
      availability: "live" as const,
      governance: {
        proposedBy: VERIFIER,
        acceptedAt: NOW - 1_000,
        anchoring: "single-signer" as const,
      },
    },
    "dacs-recipe:v1:",
    {
      algorithm: "ed25519",
      signer: VERIFIER,
      sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(VERIFIER_SEED)),
    },
  );
  const authorityBytes = Uint8Array.from(Buffer.from('{"active":true}', "utf8"));
  const authoritySignature = ed25519Sign(
    signedBytes("dacs-x-test-authority:v1:", sha256Hex(authorityBytes)),
    privateKeyFromSeed(AUTHORITY_SEED),
  );
  const attestation = {
    anchor: { kind: "https" as const, locator: AUTHORITY_LOCATOR },
    contentHash: sha256Hex(authorityBytes),
    signer: AUTHORITY,
  };
  const result = await signResult({
    resultVersion: "1",
    scheme: "domain",
    identifier: "alice.example",
    recipeVersion: 1,
    method: "consensus-backed-proxy",
    decision: "pass",
    reason: "authority confirmed claim",
    attestation,
    data: { active: true },
    fetchedAt: NOW - 20,
    verifiedAt: NOW - 10,
  });
  const ref: VerifyResultRef = {
    anchor: { kind: "storage-program", locator: RESULT_LOCATOR },
    contentHash: contentHash(result as unknown as Record<string, unknown>),
    recipeVersion: 1,
  };
  const record = await signRecord({
    recordVersion: "1",
    jobId: "job-141",
    evaluatedParty: PARTY,
    bundleHash: BUNDLE_HASH,
    requirementHash: sha256Hex(canonicalize(requirement)),
    freshness: [],
    supplementary: [],
    dealSpecific: [ref],
    overallDecision: "pass",
    generatedAt: NOW,
  });
  const expectedResult: ExpectedVerifyResult = {
    ref,
    scheme: "domain",
    identifier: "alice.example",
    method: "consensus-backed-proxy",
    requirement: requirement.required[0]!,
  };
  const expected: CompositeVerificationExpectations = {
    jobId: "job-141",
    evaluatedParty: PARTY,
    bundleHash: BUNDLE_HASH,
    requirement,
    verifier: VERIFIER,
    freshness: [],
    dealSpecific: [expectedResult],
  };
  const resolved = new Map<string, ResolvedVerificationContent>([
    [RESULT_LOCATOR, { encoding: "canonical-json", value: result as unknown as Record<string, unknown> }],
    [AUTHORITY_LOCATOR, { encoding: "bytes", value: authorityBytes }],
  ]);
  const deps: VerifyCompositeVerificationDeps<Uint8Array> = {
    nowMs: () => NOW,
    resolve: async (candidate) => resolved.get(candidate.anchor.locator) ?? null,
    resolveRecipe: async () => recipe,
    isRecipeSignerAuthorized: (_recipe, signature) =>
      signature.signer === VERIFIER,
    isVerifyResultSignerAuthorized: (_result, signature) => signature.signer === VERIFIER,
    resolvePublicKey: async (signature) =>
      signature.signer === VERIFIER ? VERIFIER_KEY : null,
    verify: ({ signedBytes: payload, signature, publicKey }) =>
      ed25519Verify(
        payload,
        Uint8Array.from(Buffer.from(signature.value, "base64url")),
        publicKeyFromRaw(publicKey),
      ),
    verifyAuthorityAttestation: ({ result: candidate, content }) => {
      if (
        candidate.attestation.signer !== AUTHORITY ||
        content.encoding !== "bytes"
      ) {
        return "invalid";
      }
      return ed25519Verify(
        signedBytes("dacs-x-test-authority:v1:", sha256Hex(content.value)),
        authoritySignature,
        publicKeyFromRaw(AUTHORITY_KEY),
      )
        ? "valid"
        : "invalid";
    },
  };
  return {
    record,
    result,
    recipe,
    ref,
    expected,
    expectedResult,
    authorityBytes,
    resolved,
    deps,
  };
}

async function withRecord(
  original: CompositeVerificationRecord,
  patch: Partial<Omit<CompositeVerificationRecord, "signature">>,
): Promise<CompositeVerificationRecord> {
  return signRecord({
    ...(stripSignature(original as unknown as Record<string, unknown>) as Omit<
      CompositeVerificationRecord,
      "signature"
    >),
    ...patch,
  });
}

async function withResult(
  original: VerifyResult,
  patch: Partial<Omit<VerifyResult, "signature">>,
): Promise<VerifyResult> {
  return signResult({
    ...(stripSignature(original as unknown as Record<string, unknown>) as Omit<
      VerifyResult,
      "signature"
    >),
    ...patch,
  });
}

describe("strict DACS-2 composite verification closure", () => {
  test("implements the complete §7.7.1 required, oneOf and cross-precedence matrix", async () => {
    const f = await fixture();
    const result = (
      scheme: string,
      decision: VerifyResult["decision"],
    ): VerifyResult => ({
      ...f.result,
      scheme,
      identifier: `${scheme}-identifier`,
      decision,
    });
    const requiredOnly: CompositeBundleRequirement = {
      requirementVersion: "1",
      required: [{ scheme: "required", verificationRequired: true }],
    };
    expect(aggregateCompositeVerification([], requiredOnly)).toBe("fail");
    for (const decision of [
      "pass",
      "fail",
      "error",
      "indeterminate",
    ] as const) {
      expect(
        aggregateCompositeVerification(
          [result("required", decision)],
          requiredOnly,
        ),
      ).toBe(decision);
    }

    const oneOfOnly: CompositeBundleRequirement = {
      requirementVersion: "1",
      required: [],
      oneOf: [[
        { scheme: "choice-a", verificationRequired: true },
        { scheme: "choice-b", verificationRequired: true },
      ]],
    };
    expect(
      aggregateCompositeVerification(
        [result("choice-a", "pass"), result("choice-b", "error")],
        oneOfOnly,
      ),
    ).toBe("pass");
    expect(
      aggregateCompositeVerification(
        [result("choice-a", "error"), result("choice-b", "fail")],
        oneOfOnly,
      ),
    ).toBe("error");
    expect(
      aggregateCompositeVerification(
        [result("choice-a", "indeterminate"), result("choice-b", "fail")],
        oneOfOnly,
      ),
    ).toBe("indeterminate");
    expect(
      aggregateCompositeVerification(
        [result("choice-a", "fail"), result("choice-b", "fail")],
        oneOfOnly,
      ),
    ).toBe("fail");

    expect(
      aggregateCompositeVerification(
        [result("required", "fail"), result("choice-a", "error")],
        {
          ...oneOfOnly,
          required: [{ scheme: "required", verificationRequired: true }],
        },
      ),
    ).toBe("fail");
  });

  test("accepts a complete Standard-backed signed reference closure", async () => {
    const f = await fixture();
    await expect(
      verifyCompositeVerificationRecord(f.record, f.expected, f.deps),
    ).resolves.toMatchObject({ status: "valid", record: f.record });
  });

  test("snapshots the composite before any asynchronous verifier callback", async () => {
    const f = await fixture();
    const wrongJob = await withRecord(f.record, { jobId: "job-wrong" });
    const candidate = structuredClone(f.record);
    candidate.signature = structuredClone(wrongJob.signature);
    const result = await verifyCompositeVerificationRecord(
      candidate,
      f.expected,
      {
        ...f.deps,
        resolvePublicKey: async (signature) => {
          candidate.jobId = "job-wrong";
          await Promise.resolve();
          return signature.signer === VERIFIER ? VERIFIER_KEY : null;
        },
      },
    );
    expect(result).toMatchObject({ status: "invalid", code: "record-signature" });
  });

  test("snapshots resolved VerifyResults before signature callbacks", async () => {
    const f = await fixture();
    const replay = await withResult(f.result, { identifier: "mallory.example" });
    const candidate = structuredClone(f.result);
    candidate.signature = structuredClone(replay.signature);
    f.resolved.set(RESULT_LOCATOR, {
      encoding: "canonical-json",
      value: candidate as unknown as Record<string, unknown>,
    });
    let keyResolutions = 0;
    const result = await verifyCompositeVerificationRecord(
      f.record,
      f.expected,
      {
        ...f.deps,
        resolvePublicKey: async (signature) => {
          keyResolutions += 1;
          if (keyResolutions === 2) candidate.identifier = "mallory.example";
          await Promise.resolve();
          return signature.signer === VERIFIER ? VERIFIER_KEY : null;
        },
      },
    );
    expect(result).toMatchObject({
      status: "invalid",
      code: "verify-result-signature",
    });
  });

  test("isolates expectations, authority bytes, and the returned closure", async () => {
    const f = await fixture();
    const expected = structuredClone(f.expected);
    const authorityBytes = Uint8Array.from(f.authorityBytes);
    f.resolved.set(AUTHORITY_LOCATOR, {
      encoding: "bytes",
      value: authorityBytes,
    });
    const result = await verifyCompositeVerificationRecord(
      f.record,
      expected,
      {
        ...f.deps,
        resolvePublicKey: async (signature) => {
          expected.jobId = "job-mutated-after-entry";
          await Promise.resolve();
          return signature.signer === VERIFIER ? VERIFIER_KEY : null;
        },
        verifyAuthorityAttestation: (input) => {
          authorityBytes[0] = 0;
          return f.deps.verifyAuthorityAttestation(input);
        },
      },
    );
    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    expect(result.record.jobId).toBe("job-141");
    expect(result.dealSpecific[0]?.identifier).toBe("alice.example");
    result.record.dealSpecific[0]!.contentHash = "f".repeat(64);
    result.dealSpecific[0]!.data!.active = false;
    expect(f.record.dealSpecific[0]?.contentHash).toBe(f.ref.contentHash);
    expect(f.result.data).toEqual({ active: true });
  });

  test("exports exact guards for every current §7.5/§7.7 shape", async () => {
    const f = await fixture();
    expect(isVerifyResult(f.result)).toBe(true);
    expect(isVerifyResultRef(f.ref)).toBe(true);
    expect(
      isSupplementarySignal({
        source: "dacs-5",
        signalType: "completion-rate",
        value: 1,
        observedAt: NOW,
      }),
    ).toBe(true);
    expect(
      isVerificationWarning({
        claimRef: PARTY,
        code: "AUTHORITY_RATE_LIMITED",
        retryable: true,
        suggestedRetryAfterMs: 1000,
      }),
    ).toBe(true);
    expect(isCompositeVerificationRecord(f.record)).toBe(true);
    expect(isVerifyResult({ ...f.result, resultVersion: "2" })).toBe(false);
    expect(isCompositeVerificationRecord({ ...f.record, recordVersion: "2" })).toBe(false);
  });

  test("exact wire guards reject inherited fields, accessors, and nested overlays", async () => {
    const f = await fixture();
    expect(isVerifyResult(Object.create(f.result))).toBe(false);
    expect(isVerifyResultRef(Object.create(f.ref))).toBe(false);
    expect(isCompositeVerificationRecord(Object.create(f.record))).toBe(false);
    expect(isCompositeBundleRequirement(Object.create(requirement))).toBe(false);
    expect(
      isCompositeVerificationRecord({
        ...f.record,
        signature: Object.create(f.record.signature),
      }),
    ).toBe(false);
    expect(
      isVerifyResultRef({
        ...f.ref,
        anchor: Object.create(f.ref.anchor),
      }),
    ).toBe(false);
    const accessorRecord = structuredClone(f.record);
    Object.defineProperty(accessorRecord, "jobId", {
      enumerable: true,
      get: () => "job-141",
    });
    expect(isCompositeVerificationRecord(accessorRecord)).toBe(false);
    expect(isVerifyResult({ ...f.result, validUntil: undefined })).toBe(false);
    expect(isCompositeVerificationRecord({ ...f.record, warnings: undefined })).toBe(false);
    const sparseRecord = structuredClone(f.record);
    sparseRecord.dealSpecific = new Array(1);
    expect(isCompositeVerificationRecord(sparseRecord)).toBe(false);
    expect(
      isCompositeBundleRequirement({
        ...requirement,
        required: new Array(1),
      }),
    ).toBe(false);
    expect(
      isVerifyResult({
        ...f.result,
        data: { nested: { omittedByJson: undefined } },
      }),
    ).toBe(false);
    expect(
      isVerifyResult({
        ...f.result,
        data: { values: new Array(1) },
      }),
    ).toBe(false);
    expect(
      isCompositeBundleRequirement({
        ...requirement,
        required: [
          {
            ...requirement.required[0]!,
            parameters: { omittedByJson: undefined },
          },
        ],
      }),
    ).toBe(false);
  });

  test.each([
    ["jobId", "job-other", "job-mismatch"],
    ["evaluatedParty", "domain:mallory.example", "evaluated-party-mismatch"],
    ["bundleHash", "b".repeat(64), "bundle-hash-mismatch"],
    ["requirementHash", "c".repeat(64), "requirement-hash-mismatch"],
  ] as const)("rejects wrong %s binding", async (field, value, code) => {
    const f = await fixture();
    const altered = { ...f.record, [field]: value };
    await expect(
      verifyCompositeVerificationRecord(altered, f.expected, f.deps),
    ).resolves.toMatchObject({ status: "invalid", code });
  });

  test("rejects missing/malformed/currently unsupported signatures and shapes", async () => {
    const f = await fixture();
    const { signature: _signature, ...unsigned } = f.record;
    await expect(
      verifyCompositeVerificationRecord(unsigned, f.expected, f.deps),
    ).resolves.toMatchObject({ status: "invalid", code: "record-shape" });
    await expect(
      verifyCompositeVerificationRecord(
        { ...f.record, signature: { ...f.record.signature, value: "tampered" } },
        f.expected,
        f.deps,
      ),
    ).resolves.toMatchObject({ status: "invalid", code: "record-signature" });
  });

  test("rejects VerifyResult content-hash and recipe substitutions", async () => {
    const f = await fixture();
    const badHashRef = { ...f.ref, contentHash: "0".repeat(64) };
    const badHashRecord = await withRecord(f.record, { dealSpecific: [badHashRef] });
    const badHashExpected = {
      ...f.expected,
      dealSpecific: [{ ...f.expectedResult, ref: badHashRef }],
    };
    await expect(
      verifyCompositeVerificationRecord(badHashRecord, badHashExpected, f.deps),
    ).resolves.toMatchObject({ status: "invalid", code: "verify-result-hash" });

    const wrongRecipeRef = { ...f.ref, recipeVersion: 2 };
    const wrongRecipeRecord = await withRecord(f.record, {
      dealSpecific: [wrongRecipeRef],
    });
    await expect(
      verifyCompositeVerificationRecord(
        wrongRecipeRecord,
        {
          ...f.expected,
          dealSpecific: [{ ...f.expectedResult, ref: wrongRecipeRef }],
        },
        f.deps,
      ),
    ).resolves.toMatchObject({ status: "invalid", code: "verify-result-recipe" });
  });

  test("rejects expired results under validUntil and listing maxAge", async () => {
    const f = await fixture();
    const expired = await withResult(f.result, { validUntil: NOW - 1 });
    const expiredRef = {
      ...f.ref,
      contentHash: contentHash(expired as unknown as Record<string, unknown>),
    };
    f.resolved.set(RESULT_LOCATOR, {
      encoding: "canonical-json",
      value: expired as unknown as Record<string, unknown>,
    });
    const expiredRecord = await withRecord(f.record, {
      dealSpecific: [expiredRef],
    });
    await expect(
      verifyCompositeVerificationRecord(
        expiredRecord,
        {
          ...f.expected,
          dealSpecific: [{ ...f.expectedResult, ref: expiredRef }],
        },
        f.deps,
      ),
    ).resolves.toMatchObject({ status: "invalid", code: "verify-result-stale" });

    const old = await withResult(f.result, {
      fetchedAt: NOW - 2_010,
      verifiedAt: NOW - 2_000,
    });
    const oldRef = {
      ...f.ref,
      contentHash: contentHash(old as unknown as Record<string, unknown>),
    };
    const tightRequirement: CompositeBundleRequirement = {
      ...requirement,
      required: [{ ...requirement.required[0]!, maxAge: 1 }],
    };
    f.resolved.set(RESULT_LOCATOR, {
      encoding: "canonical-json",
      value: old as unknown as Record<string, unknown>,
    });
    const tightRecord = await withRecord(f.record, {
      requirementHash: sha256Hex(canonicalize(tightRequirement)),
      dealSpecific: [oldRef],
    });
    await expect(
      verifyCompositeVerificationRecord(
        tightRecord,
        {
          ...f.expected,
          requirement: tightRequirement,
          dealSpecific: [
            {
              ...f.expectedResult,
              ref: oldRef,
              requirement: tightRequirement.required[0]!,
            },
          ],
        },
        f.deps,
      ),
    ).resolves.toMatchObject({ status: "invalid", code: "verify-result-stale" });
  });

  test("rejects inverted VerifyResult windows and pre-result record generation", async () => {
    const f = await fixture();
    const inverted = await withResult(f.result, {
      validUntil: f.result.verifiedAt - 1,
    });
    const invertedRef = {
      ...f.ref,
      contentHash: contentHash(inverted as unknown as Record<string, unknown>),
    };
    f.resolved.set(RESULT_LOCATOR, {
      encoding: "canonical-json",
      value: inverted as unknown as Record<string, unknown>,
    });
    const invertedRecord = await withRecord(f.record, {
      dealSpecific: [invertedRef],
    });
    await expect(
      verifyCompositeVerificationRecord(
        invertedRecord,
        {
          ...f.expected,
          dealSpecific: [{ ...f.expectedResult, ref: invertedRef }],
        },
        f.deps,
      ),
    ).resolves.toMatchObject({ status: "invalid", code: "verify-result-time" });

    f.resolved.set(RESULT_LOCATOR, {
      encoding: "canonical-json",
      value: f.result as unknown as Record<string, unknown>,
    });
    const earlyRecord = await withRecord(f.record, {
      generatedAt: f.result.verifiedAt - 1,
    });
    await expect(
      verifyCompositeVerificationRecord(earlyRecord, f.expected, f.deps),
    ).resolves.toMatchObject({ status: "invalid", code: "record-time" });
  });

  test("rejects fetched/verified inversion and future-dated result or record times", async () => {
    for (const patch of [
      { fetchedAt: NOW - 5, verifiedAt: NOW - 10 },
      { fetchedAt: NOW + 1, verifiedAt: NOW + 1 },
    ]) {
      const f = await fixture();
      const candidate = await withResult(f.result, patch);
      const candidateRef = {
        ...f.ref,
        contentHash: contentHash(candidate as unknown as Record<string, unknown>),
      };
      f.resolved.set(RESULT_LOCATOR, {
        encoding: "canonical-json",
        value: candidate as unknown as Record<string, unknown>,
      });
      const candidateRecord = await withRecord(f.record, {
        dealSpecific: [candidateRef],
        generatedAt: Math.max(NOW, candidate.verifiedAt),
      });
      await expect(
        verifyCompositeVerificationRecord(
          candidateRecord,
          {
            ...f.expected,
            dealSpecific: [{ ...f.expectedResult, ref: candidateRef }],
          },
          f.deps,
        ),
      ).resolves.toMatchObject({ status: "invalid", code: "verify-result-time" });
    }

    const f = await fixture();
    const futureRecord = await withRecord(f.record, { generatedAt: NOW + 1 });
    await expect(
      verifyCompositeVerificationRecord(futureRecord, f.expected, f.deps),
    ).resolves.toMatchObject({ status: "invalid", code: "record-time" });
  });

  test("accepts persistent Demos GCR inclusion time without accepting a future query", async () => {
    const f = await fixture();
    const gcrRecipe = await signComponentArtifact(
      {
        ...(stripSignature(
          f.recipe as unknown as Record<string, unknown>,
        ) as Record<string, unknown>),
        defaultMethod: { kind: "demos-gcr-domain" },
      },
      "dacs-recipe:v1:",
      {
        algorithm: "ed25519",
        signer: VERIFIER,
        sign: (bytes) =>
          ed25519Sign(bytes, privateKeyFromSeed(VERIFIER_SEED)),
      },
    );
    const historical = await withResult(f.result, {
      method: "demos-gcr-domain",
      verifiedAt: NOW - 10_000,
      fetchedAt: NOW - 5,
    });
    const historicalRef: VerifyResultRef = {
      ...f.ref,
      contentHash: contentHash(
        historical as unknown as Record<string, unknown>,
      ),
    };
    f.resolved.set(RESULT_LOCATOR, {
      encoding: "canonical-json",
      value: historical as unknown as Record<string, unknown>,
    });
    const record = await withRecord(f.record, {
      dealSpecific: [historicalRef],
      generatedAt: NOW,
    });
    const expected = {
      ...f.expected,
      dealSpecific: [
        {
          ...f.expectedResult,
          ref: historicalRef,
          method: "demos-gcr-domain" as const,
        },
      ],
    };
    const deps = {
      ...f.deps,
      resolveRecipe: async () => gcrRecipe as never,
    };
    await expect(
      verifyCompositeVerificationRecord(record, expected, deps),
    ).resolves.toMatchObject({
      status: "valid",
      dealSpecificRecipes: [{ availability: "live" }],
    });

    const overlong = await withResult(historical, {
      validUntil: historical.verifiedAt + 3_600_001,
    });
    const overlongRef: VerifyResultRef = {
      ...historicalRef,
      contentHash: contentHash(overlong as unknown as Record<string, unknown>),
    };
    f.resolved.set(RESULT_LOCATOR, {
      encoding: "canonical-json",
      value: overlong as unknown as Record<string, unknown>,
    });
    const overlongRecord = await withRecord(record, {
      dealSpecific: [overlongRef],
    });
    await expect(
      verifyCompositeVerificationRecord(
        overlongRecord,
        {
          ...expected,
          dealSpecific: [{ ...expected.dealSpecific[0]!, ref: overlongRef }],
        },
        deps,
      ),
    ).resolves.toMatchObject({
      status: "invalid",
      code: "verify-result-time",
    });

    f.resolved.set(RESULT_LOCATOR, {
      encoding: "canonical-json",
      value: historical as unknown as Record<string, unknown>,
    });
    const preQueryRecord = await withRecord(record, {
      generatedAt: historical.fetchedAt - 1,
    });
    await expect(
      verifyCompositeVerificationRecord(
        preQueryRecord,
        expected,
        deps,
      ),
    ).resolves.toMatchObject({ status: "invalid", code: "record-time" });

    const futureQuery = await withResult(historical, {
      fetchedAt: NOW + 1,
    });
    const futureRef: VerifyResultRef = {
      ...historicalRef,
      contentHash: contentHash(
        futureQuery as unknown as Record<string, unknown>,
      ),
    };
    f.resolved.set(RESULT_LOCATOR, {
      encoding: "canonical-json",
      value: futureQuery as unknown as Record<string, unknown>,
    });
    const futureRecord = await withRecord(record, {
      dealSpecific: [futureRef],
    });
    await expect(
      verifyCompositeVerificationRecord(
        futureRecord,
        {
          ...expected,
          dealSpecific: [{ ...expected.dealSpecific[0]!, ref: futureRef }],
        },
        deps,
      ),
    ).resolves.toMatchObject({
      status: "invalid",
      code: "verify-result-time",
    });
  });

  test("rejects method substitution across recipe families", async () => {
    const f = await fixture();
    await expect(
      verifyCompositeVerificationRecord(
        f.record,
        {
          ...f.expected,
          dealSpecific: [
            { ...f.expectedResult, method: "domain-tls-control" },
          ],
        },
        f.deps,
      ),
    ).resolves.toMatchObject({ status: "invalid", code: "verify-result-method" });
  });

  test("authenticates the exact recipe and applies RAV-3 availability", async () => {
    const f = await fixture();
    await expect(
      verifyCompositeVerificationRecord(f.record, f.expected, {
        ...f.deps,
        resolveRecipe: async () => ({
          ...f.recipe,
          defaultMaxAgeSec: 1,
        }),
      }),
    ).resolves.toMatchObject({ status: "invalid", code: "recipe-signature" });

    const mocked = await signComponentArtifact(
      {
        ...(stripSignature(
          f.recipe as unknown as Record<string, unknown>,
        ) as Record<string, unknown>),
        availability: "mocked",
      },
      "dacs-recipe:v1:",
      {
        algorithm: "ed25519",
        signer: VERIFIER,
        sign: (bytes) =>
          ed25519Sign(bytes, privateKeyFromSeed(VERIFIER_SEED)),
      },
    );
    await expect(
      verifyCompositeVerificationRecord(f.record, f.expected, {
        ...f.deps,
        resolveRecipe: async () => mocked as never,
      }),
    ).resolves.toMatchObject({
      status: "invalid",
      code: "aggregation-mismatch",
    });

    const effectiveErrorRecord = await withRecord(f.record, {
      overallDecision: "error",
    });
    const effectiveError = await verifyCompositeVerificationRecord(
      effectiveErrorRecord,
      f.expected,
      {
        ...f.deps,
        resolveRecipe: async () => mocked as never,
      },
    );
    expect(effectiveError).toMatchObject({
      status: "valid",
      record: { overallDecision: "error" },
      dealSpecific: [{ decision: "pass" }],
      dealSpecificRecipes: [{ availability: "mocked" }],
    });

    await expect(
      verifyCompositeVerificationRecord(f.record, f.expected, {
        ...f.deps,
        isRecipeSignerAuthorized: () => "steward" as never,
      }),
    ).resolves.toMatchObject({ status: "invalid", code: "recipe-signature" });
  });

  test("does not reuse one result across distinct same-scheme requirements", async () => {
    const f = await fixture();
    const first = {
      ...requirement.required[0]!,
      parameters: { jurisdiction: "GB" },
    };
    const second = {
      ...requirement.required[0]!,
      parameters: { jurisdiction: "US" },
    };
    const dualRequirement: CompositeBundleRequirement = {
      requirementVersion: "1",
      required: [first, second],
    };
    const record = await withRecord(f.record, {
      requirementHash: sha256Hex(canonicalize(dualRequirement)),
    });
    await expect(
      verifyCompositeVerificationRecord(
        record,
        {
          ...f.expected,
          requirement: dualRequirement,
          dealSpecific: [
            { ...f.expectedResult, requirement: first },
          ],
        },
        { ...f.deps, verifyRequirementParameters: () => true },
      ),
    ).resolves.toMatchObject({
      status: "invalid",
      code: "aggregation-mismatch",
    });
  });

  test("requires exact re-verification of ClaimRequirement parameters", async () => {
    const f = await fixture();
    const parameterized: CompositeBundleRequirement = {
      requirementVersion: "1",
      required: [
        { ...requirement.required[0]!, parameters: { jurisdiction: "GB" } },
      ],
    };
    const record = await withRecord(f.record, {
      requirementHash: sha256Hex(canonicalize(parameterized)),
    });
    const expected = {
      ...f.expected,
      requirement: parameterized,
      dealSpecific: [
        {
          ...f.expectedResult,
          requirement: parameterized.required[0]!,
        },
      ],
    };
    await expect(
      verifyCompositeVerificationRecord(record, expected, f.deps),
    ).resolves.toMatchObject({
      status: "unresolved",
      code: "requirement-parameters",
    });
    await expect(
      verifyCompositeVerificationRecord(record, expected, {
        ...f.deps,
        verifyRequirementParameters: () => false,
      }),
    ).resolves.toMatchObject({
      status: "invalid",
      code: "requirement-parameters",
    });

    const failedResult = await withResult(f.result, {
      decision: "fail",
      reason: "authenticated requirement parameters did not match",
    });
    const failedRef: VerifyResultRef = {
      ...f.ref,
      contentHash: contentHash(
        failedResult as unknown as Record<string, unknown>,
      ),
    };
    f.resolved.set(RESULT_LOCATOR, {
      encoding: "canonical-json",
      value: failedResult as unknown as Record<string, unknown>,
    });
    const failedRecord = await withRecord(record, {
      dealSpecific: [failedRef],
      overallDecision: "fail",
    });
    await expect(
      verifyCompositeVerificationRecord(
        failedRecord,
        {
          ...expected,
          dealSpecific: [{ ...expected.dealSpecific[0]!, ref: failedRef }],
        },
        {
          ...f.deps,
          verifyRequirementParameters: () => false,
        },
      ),
    ).resolves.toMatchObject({
      status: "valid",
      record: { overallDecision: "fail" },
    });
  });

  test("rejects a valid result replayed for another identifier", async () => {
    const f = await fixture();
    const replay = await withResult(f.result, { identifier: "mallory.example" });
    const replayRef = {
      ...f.ref,
      contentHash: contentHash(replay as unknown as Record<string, unknown>),
    };
    f.resolved.set(RESULT_LOCATOR, {
      encoding: "canonical-json",
      value: replay as unknown as Record<string, unknown>,
    });
    const record = await withRecord(f.record, { dealSpecific: [replayRef] });
    await expect(
      verifyCompositeVerificationRecord(
        record,
        {
          ...f.expected,
          dealSpecific: [{ ...f.expectedResult, ref: replayRef }],
        },
        f.deps,
      ),
    ).resolves.toMatchObject({ status: "invalid", code: "verify-result-claim" });
  });

  test("rejects unresolved or invalid VerifyResult and authority signatures", async () => {
    const f = await fixture();
    await expect(
      verifyCompositeVerificationRecord(f.record, f.expected, {
        ...f.deps,
        isVerifyResultSignerAuthorized: () => false,
      }),
    ).resolves.toMatchObject({ status: "invalid", code: "verify-result-signature" });

    await expect(
      verifyCompositeVerificationRecord(f.record, f.expected, {
        ...f.deps,
        verifyAuthorityAttestation: () => "invalid" as AuthorityVerification,
      }),
    ).resolves.toMatchObject({ status: "invalid", code: "authority-signature" });
    await expect(
      verifyCompositeVerificationRecord(f.record, f.expected, {
        ...f.deps,
        verifyAuthorityAttestation: () => "unresolved" as AuthorityVerification,
      }),
    ).resolves.toMatchObject({ status: "unresolved", code: "authority-signature" });
  });

  test("does not accept truthy non-boolean authorization or crypto verdicts", async () => {
    const f = await fixture();
    await expect(
      verifyCompositeVerificationRecord(f.record, f.expected, {
        ...f.deps,
        isVerifyResultSignerAuthorized: () => "authorized" as never,
      }),
    ).resolves.toMatchObject({
      status: "invalid",
      code: "verify-result-signature",
    });
    await expect(
      verifyCompositeVerificationRecord(f.record, f.expected, {
        ...f.deps,
        verify: () => "valid" as never,
      }),
    ).resolves.toMatchObject({ status: "invalid", code: "record-signature" });
  });

  test("rejects authority content substitution before trusting its signature", async () => {
    const f = await fixture();
    f.resolved.set(AUTHORITY_LOCATOR, {
      encoding: "bytes",
      value: Uint8Array.from(Buffer.from('{"active":false}', "utf8")),
    });
    await expect(
      verifyCompositeVerificationRecord(f.record, f.expected, f.deps),
    ).resolves.toMatchObject({ status: "invalid", code: "authority-hash" });
  });

  test("rejects freshness/deal-specific substitution even when the ref is valid", async () => {
    const f = await fixture();
    const swapped = await withRecord(f.record, {
      freshness: [f.ref],
      dealSpecific: [],
    });
    await expect(
      verifyCompositeVerificationRecord(swapped, f.expected, f.deps),
    ).resolves.toMatchObject({ status: "invalid", code: "freshness-substitution" });
  });

  test("supplementary signals and warnings are preserved but cannot elevate", async () => {
    const f = await fixture();
    const advisory = await withRecord(f.record, {
      supplementary: [
        {
          source: "dacs-5",
          signalType: "completion-rate",
          value: 0,
          observedAt: NOW,
        },
      ],
      warnings: [
        {
          claimRef: PARTY,
          code: "AUTHORITY_RATE_LIMITED",
          retryable: true,
        },
      ],
    });
    await expect(
      verifyCompositeVerificationRecord(advisory, f.expected, f.deps),
    ).resolves.toMatchObject({ status: "valid" });

    const failed = await withResult(f.result, { decision: "fail" });
    const failedRef = {
      ...f.ref,
      contentHash: contentHash(failed as unknown as Record<string, unknown>),
    };
    f.resolved.set(RESULT_LOCATOR, {
      encoding: "canonical-json",
      value: failed as unknown as Record<string, unknown>,
    });
    const elevated = await withRecord(advisory, {
      dealSpecific: [failedRef],
      overallDecision: "pass",
    });
    await expect(
      verifyCompositeVerificationRecord(
        elevated,
        {
          ...f.expected,
          dealSpecific: [{ ...f.expectedResult, ref: failedRef }],
        },
        f.deps,
      ),
    ).resolves.toMatchObject({ status: "invalid", code: "aggregation-mismatch" });
  });

  test("rejects non-wire objects before snapshots can normalise them", async () => {
    const f = await fixture();

    const inheritedRecord = Object.assign(
      Object.create({ inherited: true }) as Record<string, unknown>,
      f.record,
    );
    expect(isCompositeVerificationRecord(inheritedRecord)).toBe(false);
    await expect(
      verifyCompositeVerificationRecord(inheritedRecord, f.expected, f.deps),
    ).resolves.toMatchObject({ status: "invalid", code: "record-shape" });

    const accessorRecord = { ...f.record } as Record<string, unknown>;
    Object.defineProperty(accessorRecord, "jobId", {
      enumerable: true,
      get: () => f.record.jobId,
    });
    await expect(
      verifyCompositeVerificationRecord(accessorRecord, f.expected, f.deps),
    ).resolves.toMatchObject({ status: "invalid", code: "record-shape" });

    class RefArray extends Array<VerifyResultRef> {}
    const inheritedArrayRecord = {
      ...f.record,
      dealSpecific: new RefArray(f.ref),
    };
    expect(isCompositeVerificationRecord(inheritedArrayRecord)).toBe(false);

    const inheritedExpectations = Object.assign(
      Object.create({ inherited: true }) as Record<string, unknown>,
      f.expected,
    );
    await expect(
      verifyCompositeVerificationRecord(
        f.record,
        inheritedExpectations as unknown as CompositeVerificationExpectations,
        f.deps,
      ),
    ).resolves.toMatchObject({ status: "invalid", code: "expectation-shape" });

    const inheritedRecipe = Object.assign(
      Object.create({ inherited: true }) as Record<string, unknown>,
      f.recipe,
    );
    await expect(
      verifyCompositeVerificationRecord(f.record, f.expected, {
        ...f.deps,
        resolveRecipe: async () => inheritedRecipe as never,
      }),
    ).resolves.toMatchObject({ status: "invalid", code: "recipe-shape" });

    const inheritedResolution = Object.assign(
      Object.create({ inherited: true }) as Record<string, unknown>,
      {
        encoding: "canonical-json",
        value: f.result as unknown as Record<string, unknown>,
      },
    );
    await expect(
      verifyCompositeVerificationRecord(f.record, f.expected, {
        ...f.deps,
        resolve: async (candidate) =>
          candidate.anchor.locator === RESULT_LOCATOR
            ? (inheritedResolution as never)
            : f.resolved.get(candidate.anchor.locator) ?? null,
      }),
    ).resolves.toMatchObject({ status: "invalid", code: "verify-result-shape" });
  });

  test("legacy reads are explicit and strict verification/finalisation refuses them", async () => {
    const f = await fixture();
    const legacy = {
      subject: PARTY,
      recipeId: "legacy-domain",
      recipeVersion: "0.1",
      results: [
        {
          claimRef: PARTY,
          method: "consensus-backed-proxy",
          status: "pass",
        },
      ],
      decision: "pass",
      verifiedAt: "2026-01-01T00:00:00Z",
    };
    expect(isLegacyCompositeVerificationRecord(legacy)).toBe(true);
    expect(isCompositeVerificationRecord(legacy)).toBe(false);
    expect(readCompositeVerificationRecord(legacy)).toMatchObject({
      compatibility: "legacy",
    });
    await expect(
      verifyCompositeVerificationRecord(legacy, f.expected, f.deps),
    ).resolves.toMatchObject({ status: "invalid", code: "legacy-record" });
  });
});
