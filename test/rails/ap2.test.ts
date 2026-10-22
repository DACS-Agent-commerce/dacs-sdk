import { ap2ProfileScope, AP2_TEST_RECORD, AP2_TEST_PROFILE, AP2_TEST_PEER } from "../fixtures/ap2Profile.js";
import { writeMainFormatAp2Record } from "../fixtures/ap2LegacyRecord.js";
import { AP2_IMPLEMENTED_MODULE_VERSIONS, authenticateAp2ProfileAdmission } from "../../src/rails/ap2Admission.js";
import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import { createStripeAp2Integration } from "../../src/rails/ap2Stripe.js";
import { createFsAp2BindingStore } from "../../src/rails/ap2SettlementFs.js";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

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
const PROFILE_SCOPE = await ap2ProfileScope();
const AGREEMENT_HASH = "a".repeat(64);
const AP2_CORPUS = JSON.parse(readFileSync(new URL(
  "../../vendor/DACS-Standard/conformance/vectors/security/ap2-handler-safety-v0.6.json",
  import.meta.url,
), "utf8")) as { hash: string; count: number; vectors: Array<{
  name: string; op: string; jobId: string; phaseIndex: unknown;
  expected: "pass" | "error"; expectedKey?: string;
}> };
const AP2_KEY_VECTORS = AP2_CORPUS.vectors.filter((vector) => vector.op === "derive-idempotency-key");

// conformance/vectors/security/ap2-handler-safety-v0.6.json at the Standard
// revision pinned in package.json (d45c0a2: 66 vectors, hash asserted below).
// Key and binding vectors are replayed from that file. Earlier signature and
// registration cases remain pinned below; profile cases also exercise the composed handler.
describe("DACS-4 AP2 handler safety corpus", () => {
  // The key vectors are read from the pinned corpus, so a withdrawn or
  // changed vector cannot survive here as a hard-coded copy.
  test("replays exactly the pinned AP2-6 key vectors", () => {
    expect(AP2_CORPUS).toMatchObject({
      count: 66,
      hash: "f5566a4d096b0bf77382725f292aac2f828ffc59e4c8c0265a353d2723b5ff2e",
    });
    expect(AP2_KEY_VECTORS.map(({ name }) => name)).toEqual([
      "ap2-key-base",
      "ap2-key-phase-separation",
      "ap2-key-job-separation",
      "ap2-key-noncanonical-unicode-error",
      "ap2-key-overflow-job-error",
      "ap2-key-negative-phase-error",
      "ap2-key-string-phase-error",
    ]);
    expect(AP2_KEY_VECTORS.find(({ name }) => name === "ap2-key-job-separation")?.jobId)
      .toBe(OTHER_JOB_ID);
  });

  test.each(AP2_KEY_VECTORS.map((vector) => [vector.name, vector] as const))("%s", (_name, vector) => {
    if (vector.expected === "pass") {
      expect(deriveAp2IdempotencyKey(vector.jobId, vector.phaseIndex as number)).toBe(vector.expectedKey);
      return;
    }
    expect(vector.expected).toBe("error");
    const refusal = vector.name.endsWith("-phase-error")
      ? /pay-ap2: phaseIndex must be a non-negative safe integer/
      : /pay-ap2: jobId must be a canonical uppercase ULID/;
    expect(() => deriveAp2IdempotencyKey(vector.jobId, vector.phaseIndex as never)).toThrow(refusal);
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
    ...PROFILE_SCOPE,
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
    ["ap2-admission-negative-zero-errors", { phaseIndex: -0 }, "error", false],
  ])("%s", (_name, override, decision, permitsEffects) => {
    const result = admitAp2MandateChain({ ...admissionBase, ...override } as never);
    expect(result.decision).toBe(decision);
    expect(result.reserveAp2Binding).toBe(permitsEffects);
    expect(result.submitProviderPayment).toBe(permitsEffects);
  });

  test.each(AP2_CORPUS.vectors.filter((vector) =>
    ["ap2-admission-noncanonical-job-errors", "ap2-admission-overflow-job-errors", "ap2-admission-negative-phase-errors"].includes(vector.name),
  ))("$name through the admission helper", (vector) => {
    expect(vector.expected).toBe("error");
    expect(admitAp2MandateChain({ ...admissionBase, ...vector } as never)).toMatchObject({
      decision: "error", reserveAp2Binding: false, submitProviderPayment: false,
    });
  });

  test.each(["jobId", "phaseIndex"])("admission rejects a %s accessor without reading it", (key) => {
    const getter = vi.fn(() => { throw new Error("scope accessor invoked"); });
    const args = Object.defineProperty({ ...admissionBase }, key, { enumerable: true, get: getter });
    expect(admitAp2MandateChain(args)).toMatchObject({ decision: "error", reserveAp2Binding: false, submitProviderPayment: false });
    expect(getter).not.toHaveBeenCalled();
  });

  test.each(AP2_CORPUS.vectors.filter((vector) => vector.op === "transaction-binding"))(
    "$name", (vector) => {
      const expected = vector as unknown as { expected: string; want: { action: string; submitNewPayment: boolean } };
      expect(evaluateAp2TransactionBinding(vector as never)).toEqual({ decision: expected.expected, ...expected.want });
    },
  );

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
    noReferenceReplayWindowMs: 24 * 60 * 60 * 1000,
    operation: { destination: "https://provider.example/payments", idempotencyNamespace: "account-a", parameters: { adapterVersion: "test-v1" } },
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
    ...PROFILE_SCOPE,
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
  test.each([undefined, null, 0, -1, NaN, Infinity, "1000"])(
    "refuses missing or invalid replay policy %s before verification or effects", async (window) => {
      const adapter = provider();
      const verify = verifier();
      const store = createInMemoryAp2BindingStore();
      const checkout = vi.spyOn(verify, "verifyCheckoutMandate");
      const payment = vi.spyOn(verify, "verifyPaymentMandate");
      const claim = vi.spyOn(store, "claim");
      const submit = vi.spyOn(adapter, "submit");
      const status = vi.spyOn(adapter, "readAttestedStatus");
      if (window === undefined) Reflect.deleteProperty(adapter, "noReferenceReplayWindowMs");
      else Object.assign(adapter, { noReferenceReplayWindowMs: window });

      expect(await advanceAp2Settlement(input({ provider: adapter, verifier: verify, store }))).toEqual({
        status: "failed", reason: "pay-ap2: noReferenceReplayWindowMs must be a positive safe integer",
      });
      for (const effect of [checkout, payment, claim, submit, status]) expect(effect).not.toHaveBeenCalled();
    },
  );

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
      ...await ap2ProfileScope(OTHER_JOB_ID),
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

// Review probes are permanent refusal regressions, with a valid control above.
describe("AP2 complete operation and handler admission", () => {
  test.each(["payment bytes", "checkout bytes", "provider", "namespace", "parameters", "unicode bytes", "replay policy"])("recovery rejects changed %s before any provider call", async (change) => {
    let clock = 1000;
    const submit = vi.fn(async () => ({ disposition: "indeterminate" as const, reason: "response-lost" }));
    const status = vi.fn(provider().readAttestedStatus);
    const first = input({ now: () => clock, provider: provider({ submit, readAttestedStatus: status }) });
    if (change === "unicode bytes") first.paymentMandate = { exact: "caf\u00e9" };
    expect((await advanceAp2Settlement(first)).status).toBe("indeterminate");
    clock += 101;
    const retry = { ...first, provider: provider({ submit, readAttestedStatus: status }) };
    if (change === "payment bytes") retry.paymentMandate = { changed: true };
    if (change === "checkout bytes") retry.checkoutMandate = { changed: true };
    if (change === "provider") retry.provider.operation = { ...retry.provider.operation, destination: "https://provider-b.example/payments" };
    if (change === "namespace") retry.provider.operation = { ...retry.provider.operation, idempotencyNamespace: "account-b" };
    if (change === "parameters") retry.provider.operation = { ...retry.provider.operation, parameters: { adapterVersion: "test-v2" } };
    if (change === "unicode bytes") retry.paymentMandate = { exact: "cafe\u0301" };
    if (change === "replay policy") retry.provider = provider({ submit, readAttestedStatus: status, noReferenceReplayWindowMs: 2 * 24 * 60 * 60 * 1000 });
    // Same transaction_id, job and phase: an operation conflict, never a cross-session replay.
    expect(await advanceAp2Settlement(retry)).toEqual({ status: "failed", reason: "ap2-retained-operation-conflict" });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });

  const negativeNames = ["unauthenticated-profile", "caller-profile", "duplicate-profile", "peer-identity-mismatch", "session-mismatch", "copied-profile-reference"];
  test.each(negativeNames)("pinned ap2-admission-%s-refuses through the composed handler", async (name) => {
    expect(AP2_CORPUS.vectors.some((v) => v.name === `ap2-admission-${name}-refuses`)).toBe(true);
    let scope = { ...PROFILE_SCOPE };
    if (name === "caller-profile" || name === "copied-profile-reference") {
      scope.profileAdmission = { ...PROFILE_SCOPE.profileAdmission };
    } else {
      const records = [{ ...AP2_TEST_RECORD }];
      if (name === "unauthenticated-profile") records[0]!.authenticated = false;
      if (name === "duplicate-profile") records.push({ ...AP2_TEST_RECORD });
      if (name === "peer-identity-mismatch") records[0]!.identity = "did:demos:other-peer";
      if (name === "session-mismatch") records[0]!.jobId = OTHER_JOB_ID;
      await expect(authenticateAp2ProfileAdmission({
        jobId: JOB_ID, peerIdentity: AP2_TEST_PEER, expectedProfile: AP2_TEST_PROFILE,
        authenticateParticipants: async () => records,
      })).rejects.toThrow();
      scope.profileAdmission = undefined as never;
    }
    const verify = vi.fn(verifier().verifyCheckoutMandate);
    const submit = vi.fn(provider().submit);
    const status = vi.fn(provider().readAttestedStatus);
    const claim = vi.fn(createInMemoryAp2BindingStore().claim);
    const args = input({ ...scope, verifier: { ...verifier(), verifyCheckoutMandate: verify },
      provider: provider({ submit, readAttestedStatus: status }), store: { ...createInMemoryAp2BindingStore(), claim } });
    expect(await advanceAp2Settlement(args)).toEqual({ status: "failed", reason: "ap2-profile-admission-refused" });
    for (const fn of [verify, submit, status, claim]) expect(fn).not.toHaveBeenCalled();
    expect(admitAp2MandateChain({ ...args } as never)).toMatchObject({ decision: "fail", reserveAp2Binding: false, submitProviderPayment: false });
  });

  test.each(["unrelated malformed record", "wrong pin", "incomplete tuple", "wrong tuple", "major-only tuple", "unknown field"])("refuses %s before issuing admission", async (name) => {
    const records = structuredClone([AP2_TEST_RECORD]);
    if (name === "unrelated malformed record") records.push({ ...AP2_TEST_RECORD, identity: "other", authenticated: false });
    if (name === "wrong pin") records[0]!.releasePin = "2".repeat(40);
    if (name === "incomplete tuple") delete (records[0]!.moduleVersions as Partial<typeof AP2_TEST_PROFILE.moduleVersions>).dacs5;
    if (name === "wrong tuple") records[0]!.moduleVersions.dacs4 = "0.7";
    if (name === "major-only tuple") records[0]!.moduleVersions.core = "1";
    if (name === "unknown field") Object.assign(records[0]!, { profileRef: "copied" });
    await expect(ap2ProfileScope(JOB_ID, records)).rejects.toThrow();
  });

  test.each(AP2_CORPUS.vectors.filter((v) => /(?:unknown|wrong-type)-state-entry/.test(v.name)))("$name", (vector) => {
    expect(evaluateAp2TransactionBinding(vector as never)).toEqual({ decision: "error", action: "refuse-conflict", submitNewPayment: false });
  });
});


test("AP2 recovery submits artifacts decoded from the retained operation, not the verification snapshot", async () => {
  let clock = 1000;
  const verifiedArtifacts: unknown[] = [];
  const submittedArtifacts: unknown[] = [];
  const verification = verifier();
  const originalVerify = verification.verifyCheckoutMandate;
  verification.verifyCheckoutMandate = async (artifact) => { verifiedArtifacts.push(artifact); return originalVerify(artifact); };
  const submit = vi.fn(async ({ checkoutMandate }: Parameters<Ap2ProviderAdapter["submit"]>[0]) => {
    submittedArtifacts.push(checkoutMandate);
    return submit.mock.calls.length === 1
      ? { disposition: "indeterminate" as const, reason: "response-lost" }
      : { disposition: "accepted" as const, providerRef: "provider-1" };
  });
  const args = input({ verifier: verification, provider: provider({ submit }), now: () => clock });
  expect((await advanceAp2Settlement(args)).status).toBe("indeterminate");
  clock += 101;
  expect((await advanceAp2Settlement({ ...args, checkoutMandate: structuredClone(args.checkoutMandate) })).status).toBe("settled");
  expect(submittedArtifacts[1]).toEqual(verifiedArtifacts[1]);
  expect(submittedArtifacts[1]).not.toBe(verifiedArtifacts[1]);
});

test("AP2 refuses legacy incomplete retained intents before provider status or submission", async () => {
  const store = createInMemoryAp2BindingStore();
  const submit = vi.fn(provider().submit);
  const status = vi.fn(provider().readAttestedStatus);
  const originalClaim = store.claim;
  store.claim = async (args) => {
    const result = await originalClaim(args);
    if ("intent" in result) return { ...result, intent: { ...result.intent, intentVersion: "1" } } as never;
    return result;
  };
  expect((await advanceAp2Settlement(input({ store, provider: provider({ submit, readAttestedStatus: status }) })))).toMatchObject({ status: "failed", reason: "ap2-binding-store-intent-mismatch" });
  expect(submit).not.toHaveBeenCalled();
  expect(status).not.toHaveBeenCalled();
});

test.each([{ jobId: "job-1" }, { phaseIndex: -1 }, { phaseIndex: "3" }, { phaseIndex: -0 }])("AP2 entry gate refuses invalid session/phase before any dependency: %j", async (override) => {
  const verify = vi.fn(verifier().verifyCheckoutMandate);
  const claim = vi.fn(createInMemoryAp2BindingStore().claim);
  const submit = vi.fn(provider().submit);
  const args = input({ verifier: { ...verifier(), verifyCheckoutMandate: verify }, provider: provider({ submit }), store: { ...createInMemoryAp2BindingStore(), claim }, ...override } as never);
  expect((await advanceAp2Settlement(args)).status).toBe("failed");
  for (const fn of [verify, claim, submit]) expect(fn).not.toHaveBeenCalled();
});


test("AP2 provider A executing with a lost reference cannot resume at provider B's independent namespace", async () => {
  let clock = 1000;
  const effects: string[] = [];
  const a = provider({
    async submit() { effects.push("provider-A"); return { disposition: "indeterminate", reason: "reference-lost" }; },
  });
  const bSubmit = vi.fn(async () => { effects.push("provider-B"); return { disposition: "accepted" as const, providerRef: "provider-1" }; });
  const bStatus = vi.fn(provider().readAttestedStatus);
  const b = provider({
    operation: { destination: "https://provider-b.example/payments", idempotencyNamespace: "account-B", parameters: { adapterVersion: "test-v1" } },
    submit: bSubmit, readAttestedStatus: bStatus,
  });
  const args = input({ provider: a, now: () => clock });
  expect((await advanceAp2Settlement(args)).status).toBe("indeterminate");
  clock += 101;
  expect((await advanceAp2Settlement({ ...args, provider: b })).status).toBe("failed");
  expect(effects).toEqual(["provider-A"]);
  expect(bSubmit).not.toHaveBeenCalled();
  expect(bStatus).not.toHaveBeenCalled();
});


test("AP2 local profile authority has a closed data shape before its resolver is invoked", async () => {
  const authenticateParticipants = vi.fn(async () => [AP2_TEST_RECORD]);
  const authority = { jobId: JOB_ID, peerIdentity: AP2_TEST_PEER, expectedProfile: AP2_TEST_PROFILE, authenticateParticipants };
  await expect(authenticateAp2ProfileAdmission({ ...authority, callerProfile: AP2_TEST_PROFILE } as never)).rejects.toThrow(/closed stable data/);
  const getter = vi.fn(() => JOB_ID);
  await expect(authenticateAp2ProfileAdmission(Object.defineProperty({ ...authority }, "jobId", { get: getter }))).rejects.toThrow(/closed stable data/);
  expect(authenticateParticipants).not.toHaveBeenCalled();
  expect(getter).not.toHaveBeenCalled();
});

test("AP2 refuses a local profile naming a module tuple this implementation does not implement", async () => {
  // CORE §11.1.2(3): the tuple is the one PROFILE.md names at the pinned Standard revision.
  const profile = readFileSync(new URL("../../vendor/DACS-Standard/spec/PROFILE.md", import.meta.url), "utf8");
  const table = profile.split("Its affected document tuple is:")[1]!.split("\n\n")[1]!;
  const pinned = Object.fromEntries([...table.matchAll(/^\| \[(CORE|DACS-(\d))[^\]]*\]\([^)]*\) \| (\d+\.\d+) \|/gm)]
    .map(([, document, module, version]) => [document === "CORE" ? "core" : `dacs${module}`, version]));
  expect(AP2_IMPLEMENTED_MODULE_VERSIONS).toEqual(pinned);
  expect(AP2_TEST_PROFILE.moduleVersions).toEqual(AP2_IMPLEMENTED_MODULE_VERSIONS);
  for (const [module, version] of [["dacs4", "0.7"], ["core", "0.2"], ["dacs5", "0.6"]] as const) {
    const moduleVersions = { ...AP2_TEST_PROFILE.moduleVersions, [module]: version };
    // A peer that matches the misconfigured local policy still gains nothing.
    const authenticateParticipants = vi.fn(async () => [{ ...AP2_TEST_RECORD, moduleVersions }]);
    await expect(authenticateAp2ProfileAdmission({
      jobId: JOB_ID, peerIdentity: AP2_TEST_PEER, expectedProfile: { ...AP2_TEST_PROFILE, moduleVersions },
      authenticateParticipants,
    })).rejects.toThrow(/does not implement/);
    expect(authenticateParticipants).not.toHaveBeenCalled();
  }
});

const ap2Dirs: string[] = [];
afterEach(async () => {
  await Promise.all(ap2Dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function ap2Dir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dacs-ap2-handler-"));
  ap2Dirs.push(dir);
  return dir;
}

describe.each([
  ["in-memory", async () => createInMemoryAp2BindingStore()],
  ["filesystem", async () => createFsAp2BindingStore({ dir: await ap2Dir() })],
])("AP2 %s store recovery after a lost provider response", (_name, make) => {
  test("a retry presenting the same mandates with reordered keys resumes the same operation and key", async () => {
    let clock = 1000;
    const calls: Array<Parameters<Ap2ProviderAdapter["submit"]>[0]> = [];
    const submit = vi.fn(async (call: Parameters<Ap2ProviderAdapter["submit"]>[0]) => {
      calls.push(call);
      return calls.length === 1
        ? { disposition: "indeterminate" as const, reason: "response-lost" }
        : { disposition: "accepted" as const, providerRef: "provider-1" };
    });
    const status = vi.fn(provider().readAttestedStatus);
    const store = await make();
    const first = input({
      store, now: () => clock, provider: provider({ submit, readAttestedStatus: status }),
      checkoutMandate: { kind: "CheckoutMandate", checkout_jwt: CHECKOUT_JWS, nested: { a: 1, b: "café" } },
      paymentMandate: { kind: "PaymentMandate", transaction_id: TRANSACTION_ID, amount: "10.00" },
    });
    expect(await advanceAp2Settlement(first)).toEqual({ status: "indeterminate", reason: "response-lost" });
    clock += 101;
    const reordered = {
      ...first,
      owner: "worker-restarted",
      provider: provider({
        submit, readAttestedStatus: status,
        operation: { parameters: { adapterVersion: "test-v1" }, idempotencyNamespace: "account-a", destination: "https://provider.example/payments" },
      }),
      checkoutMandate: { nested: { b: "café", a: 1 }, checkout_jwt: CHECKOUT_JWS, kind: "CheckoutMandate" },
      paymentMandate: { amount: "10.00", transaction_id: TRANSACTION_ID, kind: "PaymentMandate" },
    };
    expect(await advanceAp2Settlement(reordered)).toMatchObject({ status: "settled" });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(calls[1]!.idempotencyKey).toBe(calls[0]!.idempotencyKey);
    expect(calls[1]!.intent.operationJson).toBe(calls[0]!.intent.operationJson);
    expect(calls[1]!.checkoutMandate).toEqual(first.checkoutMandate);
    expect(calls[1]!.paymentMandate).toEqual(first.paymentMandate);
  });
});

// Upgrade over the previous release's filesystem store: its records carry no
// phase binding. The handler must neither submit nor read status for them.
test.each([
  ["a second transaction_id for the occupied phase", CHANGED_TRANSACTION_ID, "ap2-phase-bound-to-another-transaction"],
  ["the main-format transaction_id itself", TRANSACTION_ID, "ap2-legacy-record-requires-reconciliation"],
])("AP2 opened over a main-format in-flight record refuses %s with no provider call", async (_name, legacy, reason) => {
  const dir = await ap2Dir();
  await writeMainFormatAp2Record(dir, { transactionId: legacy, jobId: JOB_ID, phaseIndex: 3 });
  const submit = vi.fn(provider().submit);
  const status = vi.fn(provider().readAttestedStatus);
  const store = await createFsAp2BindingStore({ dir });
  expect(await advanceAp2Settlement(input({ store, provider: provider({ submit, readAttestedStatus: status }) })))
    .toEqual({ status: "failed", reason });
  expect(submit).not.toHaveBeenCalled();
  expect(status).not.toHaveBeenCalled();
  expect(await readdir(join(dir, "records"))).toHaveLength(1);
});

// Keep each malformed case otherwise valid, so a different refusal cannot mask it.
describe("AP2 admission and retained-operation regression probes", () => {
  const chain = {
    ...PROFILE_SCOPE, checkoutMandatePresent: true, checkoutMandateVerified: true,
    paymentMandatePresent: true, paymentMandateVerified: true,
    checkoutJws: CHECKOUT_JWS, paymentTransactionId: TRANSACTION_ID,
    algorithm: "ES256", signatureGeneration: "non-deterministic" as const,
  };
  const authority = (authenticateParticipants = vi.fn(async () => [AP2_TEST_RECORD])) => ({
    jobId: JOB_ID, peerIdentity: AP2_TEST_PEER, expectedProfile: AP2_TEST_PROFILE, authenticateParticipants,
  });

  test("M1: rejects authority, scope and resolver proxies without executing traps", async () => {
    const trap = vi.fn(() => { throw new Error("proxy trap executed"); });
    const handler = { get: trap, getOwnPropertyDescriptor: trap, ownKeys: trap, apply: trap };
    const auth = authority();
    await expect(authenticateAp2ProfileAdmission(new Proxy(auth, handler))).rejects.toThrow(/closed stable data/);
    await expect(authenticateAp2ProfileAdmission({ ...auth,
      authenticateParticipants: new Proxy(auth.authenticateParticipants, handler),
    })).rejects.toThrow(/handshake resolver/);
    const scope = new Proxy(chain, handler);
    expect(admitAp2MandateChain(scope)).toMatchObject({ decision: "error", reserveAp2Binding: false, submitProviderPayment: false });
    expect(await advanceAp2Settlement(new Proxy(input(), handler))).toEqual({ status: "failed", reason: "ap2-profile-admission-refused" });
    expect(trap).not.toHaveBeenCalled();
    expect(auth.authenticateParticipants).not.toHaveBeenCalled();
  });

  test("M2/F1/F6: genuine phase-zero admission submits with epoch-zero creation and exact key", async () => {
    expect(PROFILE_SCOPE.profileAdmission.kind).toBe("ap2-profile-admission");
    expect(admitAp2MandateChain({ ...chain, phaseIndex: 0 })).toEqual({
      decision: "pass", derivedTransactionId: TRANSACTION_ID, reserveAp2Binding: true, submitProviderPayment: true,
    });
    const submit = vi.fn(async () => ({ disposition: "indeterminate" as const, reason: "response-lost" }));
    const store = createInMemoryAp2BindingStore();
    const claim = vi.spyOn(store, "claim");
    expect(await advanceAp2Settlement(input({ phaseIndex: 0, now: () => 0, store, provider: provider({ submit }) })))
      .toEqual({ status: "indeterminate", reason: "response-lost" });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]).toBeDefined();
    expect(claim.mock.calls[0]![0].intent.idempotencyKey).toBe(sha256Hex(`dacs-ap2-idem:v1:${JOB_ID}:0`));
    expect(await claim.mock.results[0]!.value).toMatchObject({ status: "acquired", createdAt: 0, replayDeadline: 86400000 });
    expect(admitAp2MandateChain({ ...chain, phaseIndex: -0 })).toMatchObject({ decision: "error", submitProviderPayment: false });
  });

  test.each([undefined, { ...PROFILE_SCOPE.profileAdmission }])("M3: a complete chain needs the original capability (%j)", (profileAdmission) => {
    expect(admitAp2MandateChain({ ...chain, profileAdmission } as never)).toEqual({
      decision: "fail", reason: "ap2-profile-admission-refused", reserveAp2Binding: false, submitProviderPayment: false,
    });
  });

  test.each([{ jobId: OTHER_JOB_ID }, { peerIdentity: "did:demos:other-peer" }])("M3: authentic capability cannot change scope %j", async (scope) => {
    const args = input(scope);
    const calls = [vi.spyOn(args.verifier, "verifyCheckoutMandate"), vi.spyOn(args.verifier, "verifyPaymentMandate"),
      vi.spyOn(args.store, "claim"), vi.spyOn(args.provider, "submit"), vi.spyOn(args.provider, "readAttestedStatus")];
    expect(await advanceAp2Settlement(args)).toEqual({ status: "failed", reason: "ap2-profile-admission-refused" });
    for (const call of calls) expect(call).not.toHaveBeenCalled();
  });

  test.each([null, [], "parameters", 1, false])("M6: provider parameters %j refuse before either verifier", async (parameters) => {
    const args = input();
    args.provider.operation = { ...args.provider.operation, parameters } as never;
    const calls = [vi.spyOn(args.verifier, "verifyCheckoutMandate"), vi.spyOn(args.verifier, "verifyPaymentMandate"),
      vi.spyOn(args.store, "claim"), vi.spyOn(args.provider, "submit"), vi.spyOn(args.provider, "readAttestedStatus")];
    expect(await advanceAp2Settlement(args)).toEqual({ status: "indeterminate", reason: "ap2-mandate-verification-unavailable" });
    for (const call of calls) expect(call).not.toHaveBeenCalled();
  });

  test.each(["payeeId", "currencyMinorUnits"])("M6/F6: Stripe retains the complete descriptor and refuses a changed %s", async (field) => {
    const fetchImpl = vi.fn(async () => { throw new Error("response-lost"); });
    const proxyFetch = vi.fn();
    const createCredential = ["rk", "test", "CreateCredential123"].join("_");
    const options = { createCredential, statusCredential: ["rk", "test", "StatusCredential456"].join("_"),
      payeeId: "merchant-1", currencyMinorUnits: 2, substrate: { proxyFetch }, fetchImpl };
    const first = createStripeAp2Integration(options).provider;
    expect(first.operation).toEqual({ destination: "https://api.stripe.com/v1/payment_intents",
      idempotencyNamespace: sha256Hex(createCredential),
      parameters: { adapterVersion: "stripe-ap2-v1", payeeId: "merchant-1", currencyMinorUnits: 2 } });
    const args = input({ provider: first });
    expect((await advanceAp2Settlement(args)).status).toBe("indeterminate");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const changed = createStripeAp2Integration({ ...options, [field]: field === "payeeId" ? "other" : 3 }).provider;
    expect(await advanceAp2Settlement({ ...args, provider: changed, now: () => 1101 }))
      .toEqual({ status: "failed", reason: "ap2-retained-operation-conflict" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  test("M7: both verifiers see deeply frozen artifacts and cannot change retained/submitted bytes", async () => {
    const args = input();
    for (const name of ["verifyCheckoutMandate", "verifyPaymentMandate"] as const) {
      const original = args.verifier[name];
      args.verifier[name] = vi.fn(async (artifact: Readonly<object>) => {
        const nested = (artifact as { nested: { retained: boolean } }).nested;
        expect(Object.isFrozen(artifact)).toBe(true);
        expect(Object.isFrozen(nested)).toBe(true);
        expect(() => { nested.retained = false; }).toThrow(TypeError);
        return original(artifact);
      }) as never;
    }
    const submit = vi.spyOn(args.provider, "submit");
    const claim = vi.spyOn(args.store, "claim");
    expect((await advanceAp2Settlement(args)).status).toBe("settled");
    expect(submit.mock.calls[0]![0]).toMatchObject({ checkoutMandate: args.checkoutMandate, paymentMandate: args.paymentMandate });
    const retained = JSON.parse(claim.mock.calls[0]![0].intent.operationJson);
    expect(retained.checkoutMandate.nested.retained).toBe(true);
    expect(retained.paymentMandate.nested.retained).toBe(true);
    for (const name of ["verifyCheckoutMandate", "verifyPaymentMandate"] as const) expect(args.verifier[name]).toHaveBeenCalledTimes(1);
  });

  test.each(["amount", "payee", "agreementHash", "operationJson"])("M8: refuses store-only alteration of %s", async (field) => {
    const args = input({ checkoutMandate: { label: "caf\u00e9" } });
    const original = args.store.claim.bind(args.store);
    args.store.claim = async (request) => {
      const result = await original(request);
      if (!("intent" in result)) throw new Error("expected an intent-bearing claim");
      const altered = { ...result.intent };
      if (field === "operationJson") {
        altered.operationJson = altered.operationJson.replace("caf\u00e9", "cafe\u0301");
        expect(altered.operationJson).not.toBe(result.intent.operationJson);
        expect(canonicalize(altered)).toBe(canonicalize(result.intent));
      } else Object.assign(altered, { [field]: field === "agreementHash" ? "c".repeat(64) : "20" });
      return { ...result, intent: altered };
    };
    const submit = vi.spyOn(args.provider, "submit");
    const status = vi.spyOn(args.provider, "readAttestedStatus");
    expect(await advanceAp2Settlement(args)).toEqual({ status: "failed", reason: "ap2-binding-store-intent-mismatch" });
    expect(submit).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  test.each([{ createdAt: -1, replayDeadline: 86400000 - 1 }, { createdAt: 0.5, replayDeadline: 86400000 }, { replayDeadline: 1000 + 86400000 + 1 }])("M9: malformed custom-store time %j prevents dispatch", async (change) => {
    const args = input();
    const original = args.store.claim.bind(args.store);
    args.store.claim = async (request) => ({ ...await original(request), ...change });
    // The original store retains a current lease; only returned timestamps differ.
    const submit = vi.spyOn(args.provider, "submit");
    const status = vi.spyOn(args.provider, "readAttestedStatus");
    expect(await advanceAp2Settlement(args)).toEqual({ status: "indeterminate", reason: "ap2-provider-replay-window-expired" });
    expect(submit).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  test.each(["non-hex pin", "short pin", "extra policy field", "extra tuple field"])("M10: matched invalid local/peer %s refuses before resolution", async (kind) => {
    const expectedProfile = structuredClone(AP2_TEST_PROFILE);
    if (kind === "non-hex pin") expectedProfile.releasePin = "g".repeat(40);
    if (kind === "short pin") expectedProfile.releasePin = "a".repeat(39);
    if (kind === "extra policy field") Object.assign(expectedProfile, { extra: true });
    if (kind === "extra tuple field") Object.assign(expectedProfile.moduleVersions, { extra: "0.1" });
    const authenticateParticipants = vi.fn(async () => [{ ...AP2_TEST_RECORD, ...expectedProfile }]);
    await expect(authenticateAp2ProfileAdmission({ ...authority(authenticateParticipants), expectedProfile })).rejects.toThrow(/invalid local profile policy/);
    expect(authenticateParticipants).not.toHaveBeenCalled();
  });

  test.each([3, ""])("M11: malformed identity %j in an unrelated authenticated record refuses whole admission", async (identity) => {
    const authenticateParticipants = vi.fn(async () => [AP2_TEST_RECORD, { ...AP2_TEST_RECORD, identity }] as never);
    await expect(authenticateAp2ProfileAdmission(authority(authenticateParticipants))).rejects.toThrow(/participant profile admission refused/);
    expect(authenticateParticipants).toHaveBeenCalledTimes(1);
  });

  test.each([3, ""])("F5: invalid local peer %j never invokes the resolver", async (peerIdentity) => {
    const auth = authority();
    await expect(authenticateAp2ProfileAdmission({ ...auth, peerIdentity } as never)).rejects.toThrow(/invalid local profile policy/);
    expect(auth.authenticateParticipants).not.toHaveBeenCalled();
  });

  test("F2: transaction reuse in another phase is replay; same-phase changed operation is conflict", async () => {
    const args = input();
    expect((await advanceAp2Settlement(args)).status).toBe("settled");
    expect(await advanceAp2Settlement({ ...args, phaseIndex: 4 })).toEqual({ status: "failed", reason: "ap2-transaction-id-replay" });
    expect(await advanceAp2Settlement({ ...args, checkoutMandate: { changed: true } })).toEqual({ status: "failed", reason: "ap2-retained-operation-conflict" });
  });

  test("F3: a stale fence before first dispatch has a normalized reason and no provider calls", async () => {
    const args = input();
    args.store.isCurrent = vi.fn(async () => false);
    const submit = vi.spyOn(args.provider, "submit");
    const status = vi.spyOn(args.provider, "readAttestedStatus");
    expect(await advanceAp2Settlement(args)).toEqual({ status: "indeterminate", reason: "ap2-effect-fence-stale" });
    expect(submit).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });
});
