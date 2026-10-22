import { expect, test, vi } from "vitest";
import { sha256Hex } from "../../src/canonical/index.js";
import { deriveAp2IdempotencyKey, evaluateAp2TransactionBinding, type Ap2TransactionBinding } from "../../src/rails/ap2.js";
import { isCanonicalJobId } from "../../src/negotiate/jobId.js";

const jobId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const corrupt = { decision: "error", action: "refuse-conflict", submitNewPayment: false };
// Independently spelled wire bytes pin object sorting, array order, nested arrays and null.
const exactJson = '{"jobId":"01ARZ3NDEKTSV4RRFFQ69G5FAV","phaseIndex":0,"providerRequest":{"a":[null,[1,2],{"a":null,"z":["x","y"]}],"z":null},"transactionId":"binding-tx"}';
const operationPayload = { transactionId: "binding-tx", jobId, phaseIndex: 0,
  providerRequest: { z: null, a: [null, [1, 2], { z: ["x", "y"], a: null }] } };
function binding(): Ap2TransactionBinding {
  return { transactionId: operationPayload.transactionId, jobId, phaseIndex: 0, state: "in-flight", operationPayload: structuredClone(operationPayload),
    operationFingerprint: sha256Hex(exactJson), idempotencyKey: deriveAp2IdempotencyKey(jobId, 0) };
}

test("M2/M4: phase zero binds and resumes the exact nested array/null wire operation", () => {
  expect(evaluateAp2TransactionBinding({ ...operationPayload, priorBindings: [] }))
    .toEqual({ decision: "pass", action: "bind-new", submitNewPayment: true });
  expect(evaluateAp2TransactionBinding({ ...operationPayload, priorBindings: [binding()] }))
    .toEqual({ decision: "pass", action: "resubmit-same-key", submitNewPayment: false });
  const changed = structuredClone(operationPayload);
  changed.providerRequest.a[1] = [1, 3];
  expect(evaluateAp2TransactionBinding({ ...changed, priorBindings: [binding()] })).toEqual(corrupt);
});

test.each([
  { transactionId: 3 }, { transactionId: "" }, { phaseIndex: -1 },
  { providerRequest: "request" }, { providerRequest: 1 }, { providerRequest: [] }, { providerRequest: null },
])("M5: malformed empty-prior binding %j gets the complete corrupt decision", (change) => {
  expect(evaluateAp2TransactionBinding({ ...operationPayload, ...change, priorBindings: [] } as never)).toEqual(corrupt);
});

test.each([3, "", false, null])("M5: malformed recovery reference %j cannot select reconciliation", (providerRecoveryReference) => {
  const prior = { ...binding(), providerRecoveryReference };
  expect(evaluateAp2TransactionBinding({ ...operationPayload, priorBindings: [prior] } as never)).toEqual(corrupt);
});

test("M5: a valid nonempty recovery reference selects reconciliation", () => {
  expect(evaluateAp2TransactionBinding({ ...operationPayload, priorBindings: [{ ...binding(), providerRecoveryReference: "provider-1" }] }))
    .toEqual({ decision: "pass", action: "reconcile-reference", submitNewPayment: false });
});

const settlement = { status: "captured" as const, transactionId: operationPayload.transactionId, operationFingerprint: sha256Hex(exactJson) };
test.each([
  undefined, null, { ...settlement, status: "pending" }, { ...settlement, extra: true },
  { status: "captured", transactionId: operationPayload.transactionId },
  { ...settlement, transactionId: "other" }, { ...settlement, operationFingerprint: "0".repeat(64) },
])("M5: otherwise matching settled binding with evidence %j refuses", (evidence) => {
  expect(evaluateAp2TransactionBinding({ ...operationPayload, priorBindings: [{ ...binding(), state: "settled", ...(evidence === undefined ? {} : { settlement: evidence }) }] } as never)).toEqual(corrupt);
});

test("M5: only captured evidence on a settled binding resumes settlement", () => {
  expect(evaluateAp2TransactionBinding({ ...operationPayload, priorBindings: [{ ...binding(), state: "settled", settlement }] }))
    .toEqual({ decision: "pass", action: "resume-settlement", submitNewPayment: false });
  expect(evaluateAp2TransactionBinding({ ...operationPayload, priorBindings: [{ ...binding(), settlement }] })).toEqual(corrupt);
});

test("F3: non-wire input returns the complete corrupt decision without running its getter", () => {
  const getter = vi.fn(() => operationPayload.providerRequest);
  const input = Object.defineProperty({ ...operationPayload, priorBindings: [] }, "providerRequest", { enumerable: true, get: getter });
  expect(evaluateAp2TransactionBinding(input)).toEqual(corrupt);
  expect(getter).not.toHaveBeenCalled();
});

test("I1: canonical job-ID validation never coerces non-string values", () => {
  const toString = vi.fn(() => jobId);
  expect(isCanonicalJobId(jobId)).toBe(true);
  for (const value of [new String(jobId), [jobId], { toString }]) expect(isCanonicalJobId(value)).toBe(false);
  expect(toString).not.toHaveBeenCalled();
});
