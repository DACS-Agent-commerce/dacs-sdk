import { test, expect } from "vitest";
import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import { deriveAp2IdempotencyKey, evaluateAp2TransactionBinding } from "../../src/rails/ap2.js";
const transactionId = "review-tx";
const jobId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const phaseIndex = 3;
test.each(["in-flight", "settled"] as const)("refuses a different exact provider destination in %s", (state) => {
  const operationPayload = { transactionId, jobId, phaseIndex, providerRequest: { paymentMandate: "fixture-payment-mandate-v1", providerEndpoint: "https://provider.example/caf\u00e9" } };
  const operationFingerprint = sha256Hex(canonicalize(operationPayload));
  const binding = { transactionId, jobId, phaseIndex, state, operationPayload, operationFingerprint, idempotencyKey: deriveAp2IdempotencyKey(jobId, phaseIndex),
    ...(state === "settled" ? { settlement: { status: "captured" as const, transactionId, operationFingerprint } } : {}),
  };
  expect(evaluateAp2TransactionBinding({ ...operationPayload, priorBindings: [binding] })).toMatchObject({ decision: "pass", submitNewPayment: false });
  const changed = { ...operationPayload, providerRequest: { ...operationPayload.providerRequest, providerEndpoint: "https://provider.example/cafe\u0301" }, priorBindings: [binding] };
  expect(new URL(changed.providerRequest.providerEndpoint).pathname).not.toBe(new URL(operationPayload.providerRequest.providerEndpoint).pathname);
  expect(JSON.stringify(changed.providerRequest)).not.toBe(JSON.stringify(operationPayload.providerRequest));
  expect(evaluateAp2TransactionBinding(changed)).toEqual({ decision: "error", action: "refuse-conflict", submitNewPayment: false });
});

test.each(["in-flight", "settled"] as const)("accepts an exact decomposed wire request in %s", (state) => {
  const providerRequest = { paymentMandate: "fixture-payment-mandate-v1", providerEndpoint: "https://provider.example/cafe\u0301" };
  // The pinned Standard fingerprints sorted JSON with the original string bytes.
  const operationPayload = { jobId, phaseIndex, providerRequest, transactionId };
  const operationFingerprint = sha256Hex(JSON.stringify(operationPayload));
  const binding = { transactionId, jobId, phaseIndex, state, operationPayload, operationFingerprint,
    idempotencyKey: deriveAp2IdempotencyKey(jobId, phaseIndex),
    ...(state === "settled" ? { settlement: { status: "captured" as const, transactionId, operationFingerprint } } : {}),
  };
  expect(evaluateAp2TransactionBinding({ ...operationPayload, priorBindings: [binding] })).toEqual({
    decision: "pass", action: state === "settled" ? "resume-settlement" : "resubmit-same-key", submitNewPayment: false,
  });
});
