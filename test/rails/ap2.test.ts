import { describe, expect, test, vi } from "vitest";

import {
  admitAp2MandateChain,
  advanceAp2Settlement,
  ap2CheckoutSignaturePolicy,
  ap2RegistrationEligibility,
  createInMemoryAp2BindingStore,
  deriveAp2IdempotencyKey,
  deriveAp2TransactionId,
  evaluateAp2TransactionBinding,
  type AdvanceAp2SettlementInput,
  type Ap2AttestedProviderStatus,
  type Ap2MandateVerifier,
  type Ap2ProviderAdapter,
} from "../../src/rails/ap2.js";

const CHECKOUT_JWS =
  "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJjaGVja291dF9pZCI6ImNoZWNrb3V0LTEyMyIsImN1cnJlbmN5IjoiVVNEIiwidG90YWwiOiIxMC4wMCJ9." +
  "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4_QA";
const CHANGED_SIGNATURE_JWS = `${CHECKOUT_JWS.slice(0, -1)}Q`;
const TRANSACTION_ID = "rtXpY7wp4o7vknuw0ZaOpynbfydEGvpoFkFUiRFpYJU";
const CHANGED_TRANSACTION_ID = "iECTDxg6jDyMmaBix8DHKhNnhNqCzzEgD4RJ-tXvuXM";
const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_JOB_ID = `${JOB_ID.slice(0, -1)}W`;
const AGREEMENT_HASH = "a".repeat(64);

// Exact 30 cases from DACS-Standard@662be1d4
// conformance/vectors/security/ap2-handler-safety-v0.6.json
// declared vector hash: f85b678a1e91db0707a97a792134adb8d2ba87da57f715abd42a109d38dba745.
describe("DACS-4 v0.6 AP2 30-case safety corpus", () => {
  test.each([
    ["ap2-key-base", JOB_ID, 3, "326c806fa163e7ec2c97f512d479a846a67291c8c4092d55395068e35356eb97"],
    ["ap2-key-phase-separation", JOB_ID, 4, "7b80ba1a15d989611ed25599fb25d7e7071b52c30a01c54fed23138371f058a4"],
    ["ap2-key-job-separation", OTHER_JOB_ID, 3, "e255e8c5eacfbeadbefbeee884bad22bf2164894a890bb9a7ceb934d99062f3b"],
    ["ap2-key-nfc-normalization", "cafe\u0301-job", 0, "2128576ea9daf4765462705820c909c9f40cad744fa7b46298e495579c4eb184"],
  ])("%s", (_name, jobId, phaseIndex, expected) => {
    expect(deriveAp2IdempotencyKey(jobId, phaseIndex)).toBe(expected);
  });

  test("ap2-key-negative-phase-error", () => {
    expect(() => deriveAp2IdempotencyKey(JOB_ID, -1)).toThrow();
  });

  test("ap2-key-string-phase-error", () => {
    expect(() => deriveAp2IdempotencyKey(JOB_ID, "03" as never)).toThrow();
  });

  test.each([
    ["ap2-transaction-id-sha256-default", CHECKOUT_JWS, undefined, TRANSACTION_ID],
    ["ap2-transaction-id-sha256-explicit", CHECKOUT_JWS, "sha-256", TRANSACTION_ID],
    ["ap2-transaction-id-signature-byte-change", CHANGED_SIGNATURE_JWS, undefined, CHANGED_TRANSACTION_ID],
  ])("%s", (_name, jws, sdAlg, expected) => {
    expect(deriveAp2TransactionId(jws, sdAlg)).toBe(expected);
  });

  test("ap2-transaction-id-unsupported-algorithm-error", () => {
    expect(() => deriveAp2TransactionId(CHECKOUT_JWS, "dacs-unknown-hash")).toThrow();
  });

  test("ap2-transaction-id-malformed-compact-jws-error", () => {
    expect(() => deriveAp2TransactionId("header.payload")).toThrow();
  });

  const admissionBase = {
    checkoutMandatePresent: true,
    checkoutMandateVerified: true,
    paymentMandatePresent: true,
    paymentMandateVerified: true,
    checkoutJws: CHECKOUT_JWS,
    algorithm: "ES256",
    signatureGeneration: "non-deterministic" as const,
    paymentTransactionId: TRANSACTION_ID,
  };

  test.each([
    ["ap2-admission-complete-chain-match", {}, "pass", true],
    ["ap2-admission-transaction-id-mismatch", { paymentTransactionId: CHANGED_TRANSACTION_ID }, "fail", false],
    ["ap2-admission-checkout-mandate-missing", { checkoutMandatePresent: false, checkoutMandateVerified: false }, "fail", false],
    ["ap2-admission-payment-mandate-missing", { paymentMandatePresent: false, paymentMandateVerified: false }, "fail", false],
    ["ap2-admission-deterministic-signature-rejects", { algorithm: "Ed25519", signatureGeneration: "deterministic" }, "fail", false],
    ["ap2-admission-unsupported-algorithm-errors", { sdAlg: "dacs-unknown-hash" }, "error", false],
  ])("%s", (_name, override, decision, permitsEffects) => {
    const result = admitAp2MandateChain({ ...admissionBase, ...override } as never);
    expect(result.decision).toBe(decision);
    expect(result.reserveAp2Binding).toBe(permitsEffects);
    expect(result.submitProviderPayment).toBe(permitsEffects);
  });

  test.each([
    ["ap2-first-presentation-binds", [], JOB_ID, 3, "pass", "bind-new", true],
    ["ap2-same-tuple-inflight-resumes", [{ transactionId: TRANSACTION_ID, jobId: JOB_ID, phaseIndex: 3, state: "in-flight" }], JOB_ID, 3, "pass", "resume-existing", false],
    ["ap2-same-tuple-settled-resumes-evidence", [{ transactionId: TRANSACTION_ID, jobId: JOB_ID, phaseIndex: 3, state: "settled" }], JOB_ID, 3, "pass", "resume-settlement", false],
    ["ap2-cross-job-replay-rejects", [{ transactionId: TRANSACTION_ID, jobId: JOB_ID, phaseIndex: 3, state: "in-flight" }], OTHER_JOB_ID, 3, "fail", "reject-replay", false],
    ["ap2-cross-phase-replay-rejects", [{ transactionId: TRANSACTION_ID, jobId: JOB_ID, phaseIndex: 3, state: "in-flight" }], JOB_ID, 4, "fail", "reject-replay", false],
    ["ap2-conflicting-stored-bindings-error", [
      { transactionId: TRANSACTION_ID, jobId: JOB_ID, phaseIndex: 3, state: "in-flight" },
      { transactionId: TRANSACTION_ID, jobId: OTHER_JOB_ID, phaseIndex: 3, state: "in-flight" },
    ], JOB_ID, 3, "error", "refuse-conflict", false],
  ])("%s", (_name, priorBindings, jobId, phaseIndex, decision, action, submit) => {
    const result = evaluateAp2TransactionBinding({
      transactionId: TRANSACTION_ID,
      jobId,
      phaseIndex,
      priorBindings: priorBindings as never,
    });
    expect(result).toEqual({ decision, action, submitNewPayment: submit });
  });

  test.each([
    ["ap2-checkout-randomized-signature-pass", "ES256", "non-deterministic", "pass"],
    ["ap2-checkout-ed25519-reject", "Ed25519", "deterministic", "fail"],
    ["ap2-checkout-deterministic-ecdsa-reject", "ES256", "deterministic", "fail"],
  ])("%s", (_name, algorithm, signatureGeneration, expected) => {
    expect(ap2CheckoutSignaturePolicy({ algorithm, signatureGeneration } as never)).toBe(expected);
  });

  test.each([
    ["ap2-split-credentials-registration-pass", true, true, true, false, "pass"],
    ["ap2-missing-status-credential-reject", true, false, true, false, "fail"],
    ["ap2-shared-provider-credential-reject", true, true, false, false, "fail"],
    ["ap2-privileged-credential-relayed-reject", true, true, true, true, "fail"],
  ])("%s", (_name, createCredential, statusOnlyCredential, credentialsDistinct, createCredentialRelayed, expected) => {
    expect(ap2RegistrationEligibility({
      createCredential,
      statusOnlyCredential,
      credentialsDistinct,
      createCredentialRelayed,
      providerMetadataWritable: true,
      providerMetadataReadable: true,
      providerIdempotencyKeys: true,
    })).toBe(expected);
  });
});

function verifier(): Ap2MandateVerifier<object, object> {
  return {
    async verifyCheckoutMandate() {
      return {
        disposition: "verified",
        mandate: {
          checkoutJws: CHECKOUT_JWS,
          algorithm: "ES256",
          signatureGeneration: "non-deterministic",
        },
      };
    },
    async verifyPaymentMandate() {
      return {
        disposition: "verified",
        mandate: {
          transactionId: TRANSACTION_ID,
          mandateId: "mandate-1",
          payee: "merchant-1",
          amount: "10.00",
          currency: "USD",
          paymentInstrumentId: "pm_card_visa",
        },
      };
    },
  };
}

function capturedStatus(
  providerRef = "provider-1",
): Extract<Ap2AttestedProviderStatus, { disposition: "captured" }> {
  return {
    disposition: "captured",
    providerRef,
    payee: "merchant-1",
    amount: "10",
    currency: "USD",
    metadata: {
      dacs_job_id: JOB_ID,
      dacs_agreement_hash: AGREEMENT_HASH,
    },
    receiptAttestation: {
      anchor: {
        kind: "https",
        locator: "https://provider.example/receipts/provider-1",
      },
      contentHash: "b".repeat(64),
    },
    receiptTransactionRef: {
      kind: "demos-web2-request",
      value: "d".repeat(64),
    },
    capturedAt: 1_788_000_000_000,
  };
}

function provider(overrides: Partial<Ap2ProviderAdapter> = {}): Ap2ProviderAdapter {
  return {
    capabilities: {
      createCredential: true,
      statusOnlyCredential: true,
      credentialsDistinct: true,
      createCredentialRelayed: false,
      providerMetadataWritable: true,
      providerMetadataReadable: true,
      providerIdempotencyKeys: true,
    },
    async submit({ fence }) {
      await fence.assertCurrent();
      return { disposition: "accepted", providerRef: "provider-1" };
    },
    async readAttestedStatus({ fence }) {
      await fence.assertCurrent();
      return capturedStatus();
    },
    ...overrides,
  };
}

function input(
  overrides: Partial<AdvanceAp2SettlementInput<object, object>> = {},
): AdvanceAp2SettlementInput<object, object> {
  return {
    jobId: JOB_ID,
    phaseIndex: 3,
    agreementHash: AGREEMENT_HASH,
    protocolVersion: "0.2",
    expected: { payee: "merchant-1", amount: "10", currency: "USD" },
    checkoutMandate: { kind: "CheckoutMandate", nested: { retained: true } },
    paymentMandate: { kind: "PaymentMandate", nested: { retained: true } },
    owner: "worker-a",
    verifier: verifier(),
    provider: provider(),
    store: createInMemoryAp2BindingStore(),
    now: () => 1_000,
    leaseDurationMs: 100,
    ...overrides,
  };
}

describe("advanceAp2Settlement", () => {
  test("persists one binding and returns only attested, term-bound captured status", async () => {
    const submit = vi.fn(provider().submit);
    const readAttestedStatus = vi.fn(provider().readAttestedStatus);
    const result = await advanceAp2Settlement(input({
      provider: provider({ submit, readAttestedStatus }),
    }));

    expect(result).toMatchObject({
      status: "settled",
      settlement: {
        providerRef: "provider-1",
        mandateId: "mandate-1",
        protocolVersion: "0.2",
        amount: "10",
      },
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]?.[0].idempotencyKey).toBe(
      deriveAp2IdempotencyKey(JOB_ID, 3),
    );
    expect(submit.mock.calls[0]?.[0].metadata).toEqual({
      dacs_job_id: JOB_ID,
      dacs_agreement_hash: AGREEMENT_HASH,
    });
    expect(readAttestedStatus).toHaveBeenCalledTimes(1);
  });

  test("an ambiguous submission resumes with the same provider key after lease recovery", async () => {
    let clock = 1_000;
    const keys: string[] = [];
    const submit = vi.fn(async ({ idempotencyKey }: Parameters<Ap2ProviderAdapter["submit"]>[0]) => {
      keys.push(idempotencyKey);
      return submit.mock.calls.length === 1
        ? { disposition: "indeterminate" as const, reason: "response-lost" }
        : { disposition: "accepted" as const, providerRef: "provider-1" };
    });
    const shared = input({
      provider: provider({ submit }),
      now: () => clock,
    });

    await expect(advanceAp2Settlement(shared)).resolves.toEqual({
      status: "indeterminate",
      reason: "response-lost",
    });
    await expect(advanceAp2Settlement(shared)).resolves.toEqual({
      status: "waiting",
      reason: "ap2-binding-held",
    });
    clock += 101;
    await expect(advanceAp2Settlement(shared)).resolves.toMatchObject({ status: "settled" });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(new Set(keys)).toEqual(new Set([deriveAp2IdempotencyKey(JOB_ID, 3)]));
  });

  test("a persisted provider reference is reconciled after restart without resubmission", async () => {
    let clock = 1_000;
    let statusReads = 0;
    const submit = vi.fn(provider().submit);
    const readAttestedStatus = vi.fn(async () => {
      statusReads += 1;
      return statusReads === 1
        ? { disposition: "indeterminate" as const, reason: "sr3-unavailable" }
        : capturedStatus();
    });
    const shared = input({
      provider: provider({ submit, readAttestedStatus }),
      now: () => clock,
    });
    await expect(advanceAp2Settlement(shared)).resolves.toEqual({
      status: "indeterminate",
      reason: "sr3-unavailable",
    });
    clock += 101;
    await expect(advanceAp2Settlement({ ...shared, owner: "worker-restarted" }))
      .resolves.toMatchObject({ status: "settled" });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(readAttestedStatus).toHaveBeenCalledTimes(2);
  });

  test("concurrent same-phase calls cannot submit a second provider payment", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const submit = vi.fn(async ({ fence }: Parameters<Ap2ProviderAdapter["submit"]>[0]) => {
      await fence.assertCurrent();
      await gate;
      return { disposition: "accepted" as const, providerRef: "provider-1" };
    });
    const shared = input({ provider: provider({ submit }) });
    const first = advanceAp2Settlement(shared);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    await expect(advanceAp2Settlement({ ...shared, owner: "worker-b" })).resolves.toEqual({
      status: "waiting",
      reason: "ap2-binding-held",
    });
    release();
    await expect(first).resolves.toMatchObject({ status: "settled" });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  test("cross-job reuse of one transaction_id fails before a second provider call", async () => {
    const submit = vi.fn(provider().submit);
    const store = createInMemoryAp2BindingStore();
    await expect(advanceAp2Settlement(input({ store, provider: provider({ submit }) })))
      .resolves.toMatchObject({ status: "settled" });
    await expect(advanceAp2Settlement(input({
      jobId: OTHER_JOB_ID,
      agreementHash: "c".repeat(64),
      store,
      provider: provider({ submit }),
    }))).resolves.toEqual({
      status: "failed",
      reason: "ap2-transaction-id-replay",
    });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  test("mismatched or unauthenticated-looking provider status cannot become success", async () => {
    const statuses: Ap2AttestedProviderStatus[] = [
      { ...capturedStatus(), amount: "11" },
      { ...capturedStatus(), metadata: { dacs_job_id: "other", dacs_agreement_hash: AGREEMENT_HASH } },
      {
        ...capturedStatus(),
        receiptAttestation: {
          anchor: { kind: "https", locator: "https://provider.example/receipts/provider-1" },
          contentHash: "not-a-hash",
        },
      },
    ];
    for (const status of statuses) {
      await expect(advanceAp2Settlement(input({
        provider: provider({ readAttestedStatus: async () => status }),
      }))).resolves.toEqual({ status: "failed", reason: "ap2-attested-status-mismatch" });
    }
  });

  test("an ineligible provider and rejected mandates cause no provider side effect", async () => {
    const submit = vi.fn(provider().submit);
    await expect(advanceAp2Settlement(input({
      provider: provider({
        submit,
        capabilities: {
          createCredential: true,
          statusOnlyCredential: true,
          credentialsDistinct: false,
          createCredentialRelayed: false,
          providerMetadataWritable: true,
          providerMetadataReadable: true,
          providerIdempotencyKeys: true,
        },
      }),
    }))).resolves.toEqual({
      status: "failed",
      reason: "ap2-provider-registration-ineligible",
    });
    await expect(advanceAp2Settlement(input({
      provider: provider({ submit }),
      verifier: {
        ...verifier(),
        async verifyCheckoutMandate() {
          return { disposition: "rejected", reason: "bad-signature" };
        },
      },
    }))).resolves.toEqual({
      status: "failed",
      reason: "ap2-mandate-verification-rejected",
    });
    expect(submit).not.toHaveBeenCalled();
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid lease duration %s before store or provider effects",
    async (leaseDurationMs) => {
      const submit = vi.fn(provider().submit);
      const claim = vi.fn(createInMemoryAp2BindingStore().claim);
      await expect(advanceAp2Settlement(input({
        leaseDurationMs,
        provider: provider({ submit }),
        store: { ...createInMemoryAp2BindingStore(), claim },
      }))).resolves.toMatchObject({ status: "failed" });
      expect(claim).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
    },
  );

  test("captures the provider authority before mandate callbacks can swap it", async () => {
    const originalSubmit = vi.fn(provider().submit);
    const swappedSubmit = vi.fn(provider().submit);
    const mutableProvider = provider({ submit: originalSubmit });
    const mutableVerifier = verifier();
    mutableVerifier.verifyCheckoutMandate = async (artifact) => {
      mutableProvider.submit = swappedSubmit;
      return verifier().verifyCheckoutMandate(artifact);
    };

    await expect(advanceAp2Settlement(input({
      provider: mutableProvider,
      verifier: mutableVerifier,
    }))).resolves.toMatchObject({ status: "settled" });
    expect(originalSubmit).toHaveBeenCalledTimes(1);
    expect(swappedSubmit).not.toHaveBeenCalled();
  });

  test("does not persist a provider result after its effect lease expires", async () => {
    let clock = 1_000;
    const submit = vi.fn(async () => {
      clock = 1_101;
      return { disposition: "accepted" as const, providerRef: "provider-1" };
    });
    const readAttestedStatus = vi.fn(provider().readAttestedStatus);
    await expect(advanceAp2Settlement(input({
      now: () => clock,
      provider: provider({ submit, readAttestedStatus }),
    }))).resolves.toEqual({
      status: "indeterminate",
      reason: "ap2-effect-fence-stale",
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(readAttestedStatus).not.toHaveBeenCalled();
  });
});
