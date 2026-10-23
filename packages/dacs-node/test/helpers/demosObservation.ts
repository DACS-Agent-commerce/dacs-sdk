import {
  observePayDemTransferCore,
  type DemosExecutedTransferObservation,
  type DemosTransferObservation,
} from "@kynesyslabs/dacs/seller";

type ExecutedFacts = Omit<DemosExecutedTransferObservation, "status" | "execution">;

const NATIVE_ADDRESS = /^(?:0x)?[0-9a-fA-F]{64}$/;
const MILLISECOND_TIMESTAMPS = 1_000_000_000_000;

/**
 * What the SDK's own observer reports when a Demos node serves `facts`
 * (#338): `observePayDemTransferCore` reads the node's status, `confirmed`
 * record and block and binds them itself, which is the only way an execution
 * attestation is made. Facts no node record can carry (a malformed
 * attestation, a non-native party, a block time finer than a second below
 * the millisecond range) are returned unchanged, as a provider's own
 * statement, which no consumer accepts as execution.
 */
export async function observedBySdk(
  facts: Readonly<Record<string, unknown>>,
  transactionFee?: unknown,
): Promise<DemosTransferObservation> {
  const { txHash, payer, payee, amountOs, blockNumber, includedAt, nonce } = facts;
  if (facts.status !== "included" || facts.execution !== "executed" ||
      typeof txHash !== "string" || typeof amountOs !== "string" ||
      typeof payer !== "string" || !NATIVE_ADDRESS.test(payer) ||
      typeof payee !== "string" || !NATIVE_ADDRESS.test(payee) ||
      typeof nonce !== "number" || !Number.isSafeInteger(nonce) || nonce < 0 ||
      Object.is(nonce, -0) || typeof blockNumber !== "number" ||
      typeof includedAt !== "number" ||
      (includedAt < MILLISECOND_TIMESTAMPS && includedAt % 1_000 !== 0)) {
    return facts as DemosTransferObservation;
  }
  return observePayDemTransferCore(txHash, {
    getTransactionStatus: async () => ({ state: "included", blockNumber }),
    getTxByHash: async () => ({
      hash: txHash,
      status: "confirmed",
      blockNumber,
      content: {
        type: "native",
        from: payer,
        to: payee,
        amount: amountOs,
        nonce: String(nonce),
        ...(transactionFee === undefined ? {} : { transaction_fee: transactionFee }),
        data: ["native", { nativeOperation: "send", args: [payee, amountOs] }],
      },
    }),
    getBlockByNumber: async () => ({
      number: blockNumber,
      status: "confirmed",
      content: {
        timestamp: includedAt < MILLISECOND_TIMESTAMPS ? includedAt / 1_000 : includedAt,
        ordered_transactions: [txHash],
      },
    }),
  });
}

/** {@link observedBySdk} for facts the test requires the SDK to attest. */
export async function sdkExecutedObservation(
  facts: Readonly<ExecutedFacts>,
  transactionFee?: unknown,
): Promise<DemosExecutedTransferObservation> {
  const observed = await observedBySdk(
    { status: "included", execution: "executed", ...facts }, transactionFee,
  );
  if (observed.status !== "included" || observed.execution !== "executed" ||
      !Object.isFrozen(observed)) {
    throw new Error(`the SDK observer did not attest these facts: ${JSON.stringify(observed)}`);
  }
  return observed;
}
