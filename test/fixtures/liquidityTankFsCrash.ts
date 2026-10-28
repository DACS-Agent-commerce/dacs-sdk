import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import { createLiquidityTankIntent, type LiquidityTankAuthority } from "../../src/rails/liquidityTank.js";

/** Shared by the filesystem liquidity-tank store's crash test and its child process. */
export const CRASH_T0 = 1_785_000_000_000;
export const CRASH_BRIDGE_ID = "fsCrashBridge-01";

export function crashAuthority(phaseIndex = 0): LiquidityTankAuthority {
  return {
    jobId: "01JZ0000000000000000000009",
    phaseIndex,
    railId: "demos-tank-sepolia-amoy-usdc",
    railDescriptorHash: "b".repeat(64),
    agreementHash: "c".repeat(64),
    sr5BindingHash: "d".repeat(64),
    assetKind: "stablecoin-cross-chain",
    networkKind: "cross-chain",
    mechanism: "liquidity-tank",
    sourceChainId: 11_155_111,
    destinationChainId: 80_002,
    sourceChainType: "EVM",
    destinationChainType: "EVM",
    sourceAsset: "USDC",
    destinationAsset: "USDC",
    sourceTokenDecimals: 6,
    destinationTokenDecimals: 6,
    amount: "1.25",
    currency: "USDC",
    originAddress: "fs-crash-origin",
    destinationAddress: "fs-crash-destination",
    sourceLiquidityTankId: "fs-crash-tank-source",
    destinationLiquidityTankId: "fs-crash-tank-destination",
    supportedScope: "dacs-v0.1-eth-sepolia-polygon-amoy-usdc",
  };
}

/** The submission the child signs before it is killed; the parent records the same bytes. */
export function crashSubmission() {
  const intent = createLiquidityTankIntent(crashAuthority());
  const unsigned = {
    submissionVersion: "1" as const,
    authorityHash: intent.bindingHash,
    operationHash: intent.operationHash,
    bridgeId: CRASH_BRIDGE_ID,
    substrateTxHash: "fs-crash-native-bridge-tx",
    signedSubmissionBase64: Buffer.from("signed-before-the-kill", "utf8").toString("base64"),
    preparedAt: CRASH_T0,
  };
  return { ...unsigned, submissionHash: sha256Hex(canonicalize(unsigned)) };
}
