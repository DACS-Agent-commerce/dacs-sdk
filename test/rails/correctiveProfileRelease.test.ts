import { describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { authenticateAp2ProfileAdmission, AP2_IMPLEMENTED_MODULE_VERSIONS } from "../../src/rails/ap2Admission.js";
import { advanceAp2Settlement, deriveAp2IdempotencyKey, deriveAp2TransactionId, evaluateAp2TransactionBinding } from "../../src/rails/ap2.js";
import { legacyDacsX402AuthorizationNonce, dacsX402AuthorizationNonce, x402SettleCore } from "../../src/rails/x402.js";

import { CORRECTIVE_PROFILE_CANDIDATE_PIN } from "../../src/negotiate/correctiveProfileRelease.js";
import { runSessionCore } from "../../src/agent/runSessionCore.js";
import { settlementKey } from "../../src/rails/idempotency.js";
import { x402PaywallCore, x402PaywallFulfilmentKey, x402PaywallSettlementKey } from "../../src/rails/x402Paywall.js";
import { advanceSolanaSplSettlement, solanaSplSettlementKey } from "../../src/rails/solanaSpl.js";
import { verifySellerPaymentIntake, x402Eip3009Nonce } from "../../src/seller/paymentIntake.js";
import { createX402SellerSpine } from "../../src/seller/x402Spine.js";
// Production release policy is deliberately real in this file. All other
// conformance/recovery tests use the explicit offline fixture policy.
vi.unmock("../../src/negotiate/correctiveProfileRelease.js");

const jobId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const peerIdentity = "did:demos:release-test-peer";
const candidate = "d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20";

test("implemented tuple is independently pinned without authenticating a fixture", () => {
  const text = readFileSync(new URL("../../vendor/DACS-Standard/spec/PROFILE.md", import.meta.url), "utf8");
  const table = text.split("Its affected document tuple is:")[1]!.split("\n\n")[1]!;
  const tuple = Object.fromEntries([...table.matchAll(/^\| \[(CORE|DACS-(\d))[^\]]*\]\([^)]*\) \| (\d+\.\d+) \|/gm)]
    .map(([, document, module, version]) => [document === "CORE" ? "core" : `dacs${module}`, version]));
  expect(AP2_IMPLEMENTED_MODULE_VERSIONS).toEqual(tuple);
  expect(text).toContain("The candidate is not an admissible live profile");
  const metadata = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  expect(metadata.dacs.standardRevision).toBe(candidate);
  expect(CORRECTIVE_PROFILE_CANDIDATE_PIN).toBe(candidate);
});

describe("unreleased corrective profile production refusal", () => {
  test.each([candidate, "0".repeat(40), "f".repeat(40)])("refuses matching caller authority for %s before resolver/payment", async (releasePin) => {
    const expectedProfile = { releasePin, moduleVersions: AP2_IMPLEMENTED_MODULE_VERSIONS };
    const authenticateParticipants = vi.fn(async () => [{ ...expectedProfile, jobId, identity: peerIdentity, authenticated: true }]);
    await expect(authenticateAp2ProfileAdmission({ jobId, peerIdentity, expectedProfile, authenticateParticipants }))
      .rejects.toThrow(/corrective profile is not released/);
    expect(authenticateParticipants).not.toHaveBeenCalled();
    const dependency = vi.fn(() => { throw new Error("dependency reached"); });
    expect(await advanceAp2Settlement({ jobId, phaseIndex: 0, peerIdentity,
      profileAdmission: { kind: "ap2-profile-admission" }, verifier: { verifyCheckoutMandate: dependency },
      store: { claim: dependency }, provider: { submit: dependency } } as never))
      .toMatchObject({ status: "failed" });
    expect(dependency).not.toHaveBeenCalled();
  });

  test("canonical x402 session with no released admission reaches no dependencies", async () => {
    const dependency = vi.fn(() => { throw new Error("dependency reached"); });
    const address = `0x${"1".repeat(40)}`;
    await expect(x402SettleCore({ jobId, phaseIndex: 0,
      paywallUrl: "https://seller.example/deliver", network: "eip155:84532",
      recipientEvm: address, amount: "1", asset: address, finalityBlocks: 1,
    } as never, {
      client: { getPaymentRequiredResponse: dependency, createPaymentPayload: dependency,
        encodePaymentSignatureHeader: dependency },
      payerAddress: address, assertFinalityContext: dependency, authenticateTransfer: dependency,
      fetchImpl: dependency, transportPolicy: { mode: "insecure-test" },
    } as never)).rejects.toThrow(/corrective profile is not released/);
    expect(dependency).not.toHaveBeenCalled();
  });
});

test("all new corrective derivations refuse canonical scope without a released profile", async () => {
  const scope = { jobId, phaseIndex: 0, railId: "pay-solana-spl" };
  for (const derive of [
    () => settlementKey("pay-dem", jobId, 0),
    () => deriveAp2IdempotencyKey(jobId, 0),
    () => x402Eip3009Nonce(jobId, 0),
    () => x402PaywallFulfilmentKey(scope),
    () => x402PaywallSettlementKey(scope),
    () => solanaSplSettlementKey(scope),
  ]) expect(derive).toThrow(/corrective profile is not released/);
  await expect(dacsX402AuthorizationNonce(scope)).rejects.toThrow(/corrective profile is not released/);
});

test("new session, resumed session and seller action paths refuse before dependencies", async () => {
  const dependency = vi.fn(() => { throw new Error("dependency reached"); });
  const deps = new Proxy({}, { get: dependency });
  for (const resume of [undefined, jobId]) {
    await expect(runSessionCore("listing", {} as never, deps as never, resume)).rejects.toThrow(/corrective profile is not released/);
  }
  await expect(x402PaywallCore({ jobId, phaseIndex: 0 } as never, deps as never)).rejects.toThrow(/corrective profile is not released/);
  await expect(advanceSolanaSplSettlement(deps as never)).rejects.toThrow(/corrective profile is not released/);
  await expect(verifySellerPaymentIntake(deps as never, deps as never)).rejects.toThrow(/corrective profile is not released/);
  expect(() => createX402SellerSpine(deps as never)).toThrow(/corrective profile is not released/);
  expect(dependency).not.toHaveBeenCalled();
});

test("explicit historical derivation remains available without authorizing current action", async () => {
  await expect(legacyDacsX402AuthorizationNonce({ jobId: "practice-dacs-0001", phaseIndex: 3 }))
    .resolves.toBe("0x2fc3598e85489ed2fb4d2bf9f4eb5cc8dd6998eec89645d64450f9630240e1ff");
});


test("the binding decision model cannot authorize a new candidate-profile payment", () => {
  expect(evaluateAp2TransactionBinding({ transactionId: deriveAp2TransactionId("e30.e30.c2ln"), jobId,
    phaseIndex: 0, providerRequest: { amount: "1" }, priorBindings: [] }))
    .toEqual({ decision: "error", action: "refuse-conflict", submitNewPayment: false });
});
