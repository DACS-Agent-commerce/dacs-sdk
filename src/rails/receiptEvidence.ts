import { canonicalize, sha256Hex, stripSignature } from "../canonical/index.js";

export type RailEvidenceDecision = "pass" | "fail" | "error" | "indeterminate";

export interface RailEvidenceVerification {
  decision: RailEvidenceDecision;
  reasons: string[];
}

export interface RailEvidenceDeps {
  /** Independently look up the transaction and its current canonical depth. */
  verifyChainFinality?: (input: {
    kind: "evm-erc20" | "x402";
    chainId: string;
    txHash: string;
    blockNumber: number;
    blockTimestamp: number;
    finalityBlocks: number;
  }) => Promise<{
    status: "success" | "reverted" | "reorged" | "not-final" | "wrong-chain";
    chainId: string;
    txHash: string;
    blockNumber: number;
    blockTimestamp: number;
    confirmations: number;
  }>;
  verifyFacilitatorReceipt?: (
    receipt: Readonly<Record<string, unknown>>,
    canonicalReceipt: string,
    signature: string,
  ) => Promise<boolean> | boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const positiveInteger = (value: unknown): value is number =>
  finite(value) && Number.isSafeInteger(value) && value >= 1;

/** Revalidate the rail-native receipt fields carried by SettlementEvidence. */
export async function verifyRailReceiptEvidence(
  evidence: Record<string, unknown>,
  deps: RailEvidenceDeps = {},
): Promise<RailEvidenceVerification> {
  const scope = stripSignature(evidence);
  // Failure evidence makes no positive finality claim (§9.7 forbids its
  // settlementFinality field); structural verification remains sufficient.
  if (scope["outcome"] !== "success") {
    return { decision: "pass", reasons: [] };
  }
  const refs = scope["paymentTxRefs"];
  const finality = scope["settlementFinality"];
  if (!Array.isArray(refs) || refs.length === 0 || !isRecord(finality)) {
    return { decision: "fail", reasons: ["paymentTxRefs/finality missing"] };
  }
  const reasons: string[] = [];
  let indeterminate = false;

  for (const raw of refs) {
    if (!isRecord(raw)) {
      reasons.push("payment txRef is not an object");
      continue;
    }
    if (raw["kind"] === "evm-erc20") {
      if (
        typeof raw["txHash"] !== "string" ||
        raw["txHash"].length === 0 ||
        !finite(raw["blockNumber"]) ||
        !finite(raw["blockTimestamp"]) ||
        !positiveInteger(raw["finalityBlocks"]) ||
        finality["model"] !== "block-depth" ||
        finality["finalityBlocks"] !== raw["finalityBlocks"] ||
        finality["finalityObservedAt"] !== raw["blockTimestamp"]
      ) {
        reasons.push("EVM receipt/finality fields are incomplete or incoherent");
        continue;
      }
      if (!deps.verifyChainFinality) {
        indeterminate = true;
        continue;
      }
      let observed: Awaited<ReturnType<NonNullable<RailEvidenceDeps["verifyChainFinality"]>>>;
      try {
        observed = await deps.verifyChainFinality({
          kind: "evm-erc20",
          chainId: String(raw["rail"]),
          txHash: raw["txHash"],
          blockNumber: raw["blockNumber"],
          blockTimestamp: raw["blockTimestamp"],
          finalityBlocks: raw["finalityBlocks"],
        });
      } catch {
        indeterminate = true;
        continue;
      }
      if (
        observed.status !== "success" ||
        observed.chainId !== raw["rail"] ||
        observed.txHash !== raw["txHash"] ||
        observed.blockNumber !== raw["blockNumber"] ||
        observed.blockTimestamp !== raw["blockTimestamp"] ||
        observed.confirmations < raw["finalityBlocks"]
      ) {
        reasons.push("EVM transaction is not final on the claimed chain/block");
      }
      continue;
    }
    if (raw["kind"] !== "x402") continue;

    if (
      typeof raw["httpResource"] !== "string" ||
      raw["httpResource"].length === 0 ||
      !/^[0-9a-f]{64}$/.test(String(raw["paymentReceiptHash"])) ||
      (raw["protocolVersion"] !== "2" && raw["protocolVersion"] !== 2) ||
      typeof raw["facilitatorReceiptJcs"] !== "string"
    ) {
      reasons.push("x402 receipt is missing resource/hash/protocol/canonical receipt");
      continue;
    }
    let receipt: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw["facilitatorReceiptJcs"]);
      if (!isRecord(parsed) || canonicalize(parsed) !== raw["facilitatorReceiptJcs"]) {
        throw new Error("not canonical");
      }
      receipt = parsed;
    } catch {
      reasons.push("x402 facilitator receipt is not canonical JCS");
      continue;
    }
    if (sha256Hex(raw["facilitatorReceiptJcs"]) !== raw["paymentReceiptHash"]) {
      reasons.push("x402 paymentReceiptHash does not match the canonical receipt");
      continue;
    }
    const receiptChain = receipt["network"] ?? receipt["chainId"];
    if (
      typeof raw["chainId"] !== "string" ||
      raw["rail"] !== raw["chainId"] ||
      receiptChain !== raw["chainId"] ||
      (receipt["x402Version"] !== undefined &&
        String(receipt["x402Version"]) !== String(raw["protocolVersion"]))
    ) {
      reasons.push("x402 protocol/chain fields are incoherent");
      continue;
    }

    const settlementTxHash = raw["settlementTxHash"];
    if (typeof settlementTxHash === "string" && settlementTxHash.length > 0) {
      if (
        raw["txHash"] !== settlementTxHash ||
        receipt["transaction"] !== settlementTxHash ||
        !finite(raw["blockNumber"]) ||
        !finite(raw["blockTimestamp"]) ||
        !positiveInteger(raw["finalityBlocks"]) ||
        finality["model"] !== "block-depth" ||
        finality["finalityBlocks"] !== raw["finalityBlocks"] ||
        finality["finalityObservedAt"] !== raw["blockTimestamp"]
      ) {
        reasons.push("x402 on-chain receipt/finality fields are incoherent");
        continue;
      }
      if (!deps.verifyChainFinality) {
        indeterminate = true;
        continue;
      }
      let observed: Awaited<ReturnType<NonNullable<RailEvidenceDeps["verifyChainFinality"]>>>;
      try {
        observed = await deps.verifyChainFinality({
          kind: "x402",
          chainId: raw["chainId"],
          txHash: settlementTxHash,
          blockNumber: raw["blockNumber"],
          blockTimestamp: raw["blockTimestamp"],
          finalityBlocks: raw["finalityBlocks"],
        });
      } catch {
        indeterminate = true;
        continue;
      }
      if (
        observed.status !== "success" ||
        observed.chainId !== raw["chainId"] ||
        observed.txHash !== settlementTxHash ||
        observed.blockNumber !== raw["blockNumber"] ||
        observed.blockTimestamp !== raw["blockTimestamp"] ||
        observed.confirmations < raw["finalityBlocks"]
      ) {
        reasons.push("x402 transaction is not final on the claimed chain/block");
      }
      continue;
    }

    const signature = raw["facilitatorSignature"];
    if (
      raw["txHash"] !== "" ||
      (typeof receipt["transaction"] === "string" && receipt["transaction"].trim() !== "") ||
      finality["model"] !== "provider-receipt" ||
      typeof signature !== "string" ||
      signature.length === 0 ||
      receipt["signature"] !== signature
    ) {
      reasons.push("x402 no-tx fallback lacks provider finality/signature");
      continue;
    }
    if (!deps.verifyFacilitatorReceipt) {
      indeterminate = true;
      continue;
    }
    let valid = false;
    try {
      valid = await deps.verifyFacilitatorReceipt(
        receipt,
        raw["facilitatorReceiptJcs"],
        signature,
      );
    } catch {
      indeterminate = true;
      continue;
    }
    if (!valid) {
      reasons.push("x402 facilitator signature is invalid");
    }
  }

  if (reasons.length > 0) return { decision: "fail", reasons };
  if (indeterminate) {
    return {
      decision: "indeterminate",
      reasons: ["rail finality/facilitator trust material is unavailable"],
    };
  }
  return { decision: "pass", reasons: [] };
}

/** Build a public EVM finality verifier suitable for AgentConfig.railEvidence. */
export async function createEvmChainFinalityVerifier(
  rpcUrl: string,
): Promise<NonNullable<RailEvidenceDeps["verifyChainFinality"]>> {
  const { createPublicClient, http } = await import("viem");
  const client = createPublicClient({ transport: http(rpcUrl) });
  return async (input) => {
    const chainMatch = /^eip155:(\d+)$/.exec(input.chainId);
    const expectedChainId = Number(chainMatch?.[1]);
    const rpcChainId = await client.getChainId();
    if (!Number.isSafeInteger(expectedChainId) || rpcChainId !== expectedChainId) {
      return {
        status: "wrong-chain",
        chainId: `eip155:${rpcChainId}`,
        txHash: input.txHash,
        blockNumber: input.blockNumber,
        blockTimestamp: input.blockTimestamp,
        confirmations: 0,
      };
    }
    const receipt = await client.waitForTransactionReceipt({
      hash: input.txHash as `0x${string}`,
      confirmations: input.finalityBlocks,
    });
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    return {
      status: block.hash !== receipt.blockHash
        ? "reorged"
        : receipt.status === "success"
          ? "success"
          : "reverted",
      chainId: input.chainId,
      txHash: receipt.transactionHash,
      blockNumber: Number(receipt.blockNumber),
      blockTimestamp: Number(block.timestamp) * 1_000,
      confirmations: input.finalityBlocks,
    };
  };
}
