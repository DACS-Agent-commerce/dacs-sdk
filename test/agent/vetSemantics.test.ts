import { describe, expect, test } from "vitest";

import {
  classifyVerificationDecision,
  isVerifyResultForMethod,
  shouldRetryVerification,
  vetPhaseFailureClass,
  type VerificationDecision,
  type VerifyResult,
} from "../../src/index.js";

const validResult = (): VerifyResult => ({
  resultVersion: "1",
  scheme: "domain",
  identifier: "example.test",
  recipeVersion: 1,
  method: "domain-tls-control",
  decision: "pass",
  reason: "control established",
  attestation: {
    anchor: { kind: "storage-program", locator: "stor-result" },
    contentHash: "a".repeat(64),
  },
  fetchedAt: 1,
  verifiedAt: 2,
  signature: {
    algorithm: "ed25519",
    signer: `key:${"b".repeat(64)}`,
    value: Buffer.alloc(64).toString("base64url"),
  },
});

describe("DACS-2 Vet decision and method semantics", () => {
  test("classifies only the closed §7.5.1 decision set", () => {
    for (const decision of ["pass", "fail", "indeterminate", "error"] as const) {
      expect(classifyVerificationDecision(decision)).toBe(decision);
    }
    expect(() => classifyVerificationDecision("unknown")).toThrow(/unknown/);
  });

  test("requires a complete current VerifyResult bound to the producing method", () => {
    const result = validResult();
    expect(isVerifyResultForMethod(result, "domain-tls-control")).toBe(true);
    expect(isVerifyResultForMethod(result, "self-signed")).toBe(false);
    expect(isVerifyResultForMethod({ ...result, method: undefined }, "domain-tls-control"))
      .toBe(false);
    expect(isVerifyResultForMethod({ ...result, decision: undefined }, "domain-tls-control"))
      .toBe(false);
    expect(isVerifyResultForMethod({ ...result, decision: "maybe" }, "domain-tls-control"))
      .toBe(false);
  });
});

describe("DACS-2 VP-R1/VP-R3/VP-R4 retry semantics", () => {
  test("retries only transient errors below the bounded attempt budget", () => {
    expect(shouldRetryVerification("error", 2, { retryClass: "transient" }))
      .toBe(true);
    expect(shouldRetryVerification("error", 3, { retryClass: "transient" }))
      .toBe(false);
    expect(shouldRetryVerification("error", 0, { retryClass: "permanent" }))
      .toBe(false);
  });

  test("honours the explicit indeterminate flag and never retries pass/fail", () => {
    expect(shouldRetryVerification("indeterminate", 0, { retryClass: "transient" }))
      .toBe(false);
    expect(shouldRetryVerification("indeterminate", 0, {
      retryClass: "transient",
      retryOnIndeterminate: true,
    })).toBe(true);
    expect(shouldRetryVerification("indeterminate", 1, {
      retryClass: "transient",
      retryBudget: 1,
      retryOnIndeterminate: true,
    })).toBe(false);
    for (const decision of ["pass", "fail"] as const) {
      expect(shouldRetryVerification(decision, 0, { retryClass: "transient" }))
        .toBe(false);
    }
  });

  test("rejects malformed policy and attempt inputs instead of guessing", () => {
    expect(() => shouldRetryVerification("error", -1, { retryClass: "transient" }))
      .toThrow(/attempts/);
    expect(() => shouldRetryVerification("error", 0, {
      retryClass: "transient",
      retryBudget: -1,
    })).toThrow(/malformed/);
    expect(() => shouldRetryVerification("unknown" as VerificationDecision, 0, {
      retryClass: "transient",
    })).toThrow(/unknown/);

    let getterInvoked = false;
    const accessorPolicy = Object.defineProperty({}, "retryClass", {
      enumerable: true,
      get: () => {
        getterInvoked = true;
        return "transient";
      },
    });
    expect(() => shouldRetryVerification(
      "error",
      0,
      accessorPolicy as { retryClass: "transient" },
    )).toThrow(/data fields/);
    expect(getterInvoked).toBe(false);
  });
});

describe("DACS-2 VPC-4 terminal failure attribution", () => {
  test("maps authority decisions and the malformed-counterparty carve-out", () => {
    expect(vetPhaseFailureClass("pass")).toBeNull();
    expect(vetPhaseFailureClass("fail")).toBe("counterparty");
    expect(vetPhaseFailureClass("indeterminate")).toBe("permanent");
    expect(vetPhaseFailureClass("error")).toBe("permanent");
    expect(vetPhaseFailureClass("error", "counterparty-malformed-presentation"))
      .toBe("counterparty");
    expect(vetPhaseFailureClass("indeterminate", "counterparty-malformed-presentation"))
      .toBe("counterparty");
  });
});
