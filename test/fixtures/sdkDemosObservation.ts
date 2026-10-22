import {
  observePayDemTransferCore,
  type DemosTransferObservation,
} from "../../src/seller/index.js";

const NATIVE_ADDRESS = /^(?:0x)?[0-9a-fA-F]{64}$/;
const MILLISECOND_TIMESTAMPS = 1_000_000_000_000;

/**
 * What the SDK's own observer reports when a Demos node serves `facts`
 * (#338): the only way an execution attestation is made. The node's status,
 * `confirmed` record and block carry exactly these facts, and
 * `observePayDemTransferCore` reads and binds them itself. Facts no node
 * record can carry (a malformed attestation, a non-native party, a block time
 * finer than a second below the millisecond range) are returned unchanged, as
 * a host's own statement, which no consumer accepts as execution.
 */
export async function observedBySdk(
  facts: DemosTransferObservation,
): Promise<DemosTransferObservation> {
  if (facts.status !== "included" || facts.execution !== "executed" ||
      !Number.isSafeInteger(facts.nonce) || facts.nonce < 0 || Object.is(facts.nonce, -0) ||
      !NATIVE_ADDRESS.test(facts.payer) || !NATIVE_ADDRESS.test(facts.payee) ||
      (facts.includedAt < MILLISECOND_TIMESTAMPS && facts.includedAt % 1_000 !== 0)) {
    return facts;
  }
  const { txHash, payer, payee, amountOs, blockNumber, includedAt, nonce } = facts;
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
