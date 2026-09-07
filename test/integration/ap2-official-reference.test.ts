import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  admitAp2MandateChain,
  deriveAp2TransactionId,
  type Ap2MandateVerifier,
  type Ap2VerifiedCheckoutMandate,
  type Ap2VerifiedPaymentMandate,
} from "../../src/rails/ap2.js";

interface OfficialVerifiedChain {
  checkout: { checkoutJwt: string; sdAlg?: string };
  payment: {
    mandateId: string;
    transactionId: string;
    payee: { id: string };
    paymentAmount: { amount: number; currency: string };
    paymentInstrument: { id: string };
  };
  merchantSignature: {
    algorithm: string;
    generation: "non-deterministic";
  };
}

interface OfficialReferenceBundle {
  officialAp2Commit: string;
  request: object;
  verified: OfficialVerifiedChain;
}

const python = process.env.DACS_AP2_OFFICIAL_PYTHON;
const integrationDescribe = python ? describe : describe.skip;
const helperPath = fileURLToPath(
  new URL("./helpers/ap2-official-reference.py", import.meta.url),
);

function runHelper<T>(mode: "generate" | "verify", input: unknown): T {
  if (!python) throw new Error("DACS_AP2_OFFICIAL_PYTHON is required");
  const result = spawnSync(python, [helperPath, mode], {
    encoding: "utf8",
    input: JSON.stringify(input),
    maxBuffer: 2 * 1024 * 1024,
    timeout: 20_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`official AP2 helper rejected input: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout) as T;
}

function projectVerifier(): Ap2MandateVerifier<unknown, unknown> {
  let pending: Promise<OfficialVerifiedChain> | undefined;
  const verify = (artifact: unknown) => pending ??= Promise.resolve().then(
    () => runHelper<OfficialVerifiedChain>("verify", artifact),
  );
  return {
    async verifyCheckoutMandate(artifact) {
      const value = await verify(artifact);
      const mandate: Ap2VerifiedCheckoutMandate = {
        checkoutJws: value.checkout.checkoutJwt,
        ...(value.checkout.sdAlg === undefined ? {} : { sdAlg: value.checkout.sdAlg }),
        algorithm: value.merchantSignature.algorithm,
        signatureGeneration: value.merchantSignature.generation,
      };
      return { disposition: "verified", mandate };
    },
    async verifyPaymentMandate(artifact) {
      const value = await verify(artifact);
      const mandate: Ap2VerifiedPaymentMandate = {
        transactionId: value.payment.transactionId,
        mandateId: value.payment.mandateId,
        payee: value.payment.payee.id,
        amount: String(value.payment.paymentAmount.amount / 100),
        currency: value.payment.paymentAmount.currency,
        paymentInstrumentId: value.payment.paymentInstrument.id,
      };
      return { disposition: "verified", mandate };
    },
  };
}

integrationDescribe("official AP2 runtime reference", () => {
  it("verifies genuine AP2 chains before DACS admission", async () => {
    const bundle = runHelper<OfficialReferenceBundle>("generate", {
      amountMinor: 50,
      currency: "USD",
      payeeId: "acct_dacs_reference",
      paymentInstrumentId: "pm_card_visa",
    });
    const verifier = projectVerifier();
    const [checkout, payment] = await Promise.all([
      verifier.verifyCheckoutMandate(bundle.request),
      verifier.verifyPaymentMandate(bundle.request),
    ]);
    expect(checkout.disposition).toBe("verified");
    expect(payment.disposition).toBe("verified");
    if (checkout.disposition !== "verified" || payment.disposition !== "verified") return;

    const admission = admitAp2MandateChain({
      checkoutMandatePresent: true,
      checkoutMandateVerified: true,
      paymentMandatePresent: true,
      paymentMandateVerified: true,
      checkoutJws: checkout.mandate.checkoutJws,
      ...(checkout.mandate.sdAlg === undefined ? {} : { sdAlg: checkout.mandate.sdAlg }),
      algorithm: checkout.mandate.algorithm,
      signatureGeneration: checkout.mandate.signatureGeneration,
      paymentTransactionId: payment.mandate.transactionId,
    });

    expect(bundle.officialAp2Commit).toBe(
      "e1ea56db72a6385bce3e5c1112b3a56ce60acb43",
    );
    expect(admission.decision).toBe("pass");
    expect(deriveAp2TransactionId(checkout.mandate.checkoutJws, checkout.mandate.sdAlg))
      .toBe(bundle.verified.payment.transactionId);
    expect(payment.mandate).toMatchObject({
      amount: "0.5",
      mandateId: bundle.verified.payment.mandateId,
      paymentInstrumentId: "pm_card_visa",
    });
  });

  it("fails closed when a verified AP2 presentation is altered", () => {
    const bundle = runHelper<OfficialReferenceBundle>("generate", {
      amountMinor: 50,
      currency: "USD",
    });
    const request = structuredClone(bundle.request) as {
      presentation: { checkoutPresentation: string };
    };
    request.presentation.checkoutPresentation =
      request.presentation.checkoutPresentation.slice(0, -1) + "A";
    expect(() => runHelper("verify", request)).toThrow(
      "official AP2 helper rejected input",
    );
  });
});
