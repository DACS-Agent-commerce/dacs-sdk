import { describe, expect, test } from "vitest";

import {
  deriveSettlementTxId,
  reconcileSettlementEvidence,
} from "../../src/agent/settlementIdentity.js";
import { contentHash } from "../../src/canonical/index.js";

const TX_HASH = `0x${"AB".repeat(32)}`;
const CANONICAL_TX_HASH = "ab".repeat(32);
const SOLANA_SIGNATURE = "1".repeat(64);

function evidence(
  jobId: string,
  observedAt: number,
  txRef: Record<string, unknown>,
) {
  return {
    evidenceVersion: "1",
    jobId,
    phase:
      txRef.kind === "demos"
        ? "pay-dem"
        : txRef.kind === "x402"
          ? "pay-x402"
          : "pay-evm-erc20",
    outcome: "success",
    paymentTxRefs: [txRef],
    paymentAmount: { amount: "1", currency: "USDC" },
    settlementFinality: {
      model: txRef.kind === "demos" ? "bft-final" : "block-depth",
      finalityObservedAt: observedAt,
    },
    observedAt,
    signature: {
      algorithm: "ed25519",
      signer: "did:demos:orchestrator",
      value: "AA",
    },
  };
}

describe("DACS-4 SB-1 settlement identity", () => {
  test("derives byte-identical event/instruction identities for shipped rails", () => {
    expect(
      deriveSettlementTxId({
        kind: "evm",
        chainId: 84532,
        txHash: TX_HASH,
        logIndex: 7,
      }),
    ).toEqual({
      status: "ok",
      settlementTxId: `evm:84532:${CANONICAL_TX_HASH}:7`,
    });
    expect(
      deriveSettlementTxId({
        kind: "x402",
        httpResource: "https://seller.example/pay",
        paymentReceiptHash: "c".repeat(64),
        settlementTxHash: TX_HASH,
        chainId: 84532,
        logIndex: 7,
        protocolVersion: "1",
      }),
    ).toEqual({
      status: "ok",
      settlementTxId: `evm:84532:${CANONICAL_TX_HASH}:7`,
    });
    expect(
      deriveSettlementTxId({
        kind: "solana",
        cluster: "devnet",
        signature: SOLANA_SIGNATURE,
        instructionIndex: 2,
      }),
    ).toEqual({
      status: "ok",
      settlementTxId: `solana:devnet:${SOLANA_SIGNATURE}:2`,
    });
    expect(
      deriveSettlementTxId({ kind: "demos", txHash: TX_HASH }),
    ).toEqual({
      status: "ok",
      settlementTxId: `demos:${CANONICAL_TX_HASH}`,
    });
  });

  test.each([
    { kind: "evm", chainId: 1, txHash: TX_HASH },
    { kind: "evm", chainId: 1, txHash: "0xabc", logIndex: 0 },
    {
      kind: "solana",
      cluster: "devnet",
      signature: "not-base58-0",
      instructionIndex: 0,
    },
    {
      kind: "x402",
      httpResource: "https://seller.example/pay",
      paymentReceiptHash: "c".repeat(64),
      settlementTxHash: TX_HASH,
      chainId: 1,
      protocolVersion: "1",
    },
    { kind: "demos", txHash: "short" },
  ])("rejects malformed identity input without minting a key", (ref) => {
    expect(deriveSettlementTxId(ref)).toMatchObject({ status: "error" });
  });

  test("does not invent SB-1 identities for variants without a pinned recipe", () => {
    expect(
      deriveSettlementTxId({
        kind: "storage-program",
        address: "stor:1",
        writeTxHash: TX_HASH,
      }),
    ).toMatchObject({ status: "not-applicable" });
    expect(
      deriveSettlementTxId({
        kind: "htlc-claim",
        chainId: 1,
        contractAddress: "0xcontract",
        claimTxHash: TX_HASH,
      }),
    ).toMatchObject({ status: "not-applicable" });
  });
});

describe("DACS-4 SB-2 cross-session uniqueness", () => {
  test("earlier observedAt wins independently of consumer input order", () => {
    const early = evidence("job-early", 10, {
      kind: "evm",
      chainId: 1,
      txHash: TX_HASH,
      logIndex: 0,
    });
    const late = evidence("job-late", 20, {
      kind: "evm",
      chainId: 1,
      txHash: TX_HASH,
      logIndex: 0,
    });

    const checks = reconcileSettlementEvidence([
      { evidence: late, phaseIndex: 0 },
      { evidence: early, phaseIndex: 1 },
    ]);
    expect(checks[0]).toMatchObject({
      jobId: "job-late",
      verdict: "duplicate",
      conflictsWith: { jobId: "job-early", phaseIndex: 1 },
    });
    expect(checks[1]).toMatchObject({
      jobId: "job-early",
      verdict: "accepted",
    });
  });

  test("observedAt ties choose the lower signed-scope evidence hash", () => {
    const a = evidence("job-a", 10, {
      kind: "demos",
      txHash: TX_HASH,
    });
    const b = evidence("job-b", 10, {
      kind: "demos",
      txHash: TX_HASH,
    });
    const aWins = contentHash(a) < contentHash(b);
    const checks = reconcileSettlementEvidence([
      { evidence: a, phaseIndex: 0 },
      { evidence: b, phaseIndex: 0 },
    ]);

    expect(checks[aWins ? 0 : 1]?.verdict).toBe("accepted");
    expect(checks[aWins ? 1 : 0]?.verdict).toBe("duplicate");
  });

  test("the same transaction reused under the same binding is not cross-session duplication", () => {
    const record = evidence("job-one", 10, {
      kind: "x402",
      httpResource: "https://seller.example/pay",
      paymentReceiptHash: "c".repeat(64),
      settlementTxHash: TX_HASH,
      chainId: 84532,
      logIndex: 4,
      protocolVersion: "1",
    });
    const checks = reconcileSettlementEvidence([
      { evidence: record, phaseIndex: 3 },
      { evidence: { ...record }, phaseIndex: 3 },
    ]);
    expect(checks.map((check) => check.verdict)).toEqual([
      "accepted",
      "accepted",
    ]);
  });

  test("malformed phase/transaction identities return error, never a new key", () => {
    const malformed = evidence("job-bad", 10, {
      kind: "evm",
      chainId: 1,
      txHash: "odd",
      logIndex: 0,
    });
    const checks = reconcileSettlementEvidence([
      { evidence: malformed, phaseIndex: -1 },
    ]);
    expect(checks[0]).toMatchObject({
      verdict: "error",
      settlementTxIds: [],
    });
  });

  test("payment variants without a pinned SB-1 recipe fail closed", () => {
    const unpinned = evidence("job-unpinned", 10, {
      kind: "htlc-claim",
      chainId: 1,
      contractAddress: "0xcontract",
      claimTxHash: TX_HASH,
    });
    const checks = reconcileSettlementEvidence([
      { evidence: unpinned, phaseIndex: 0 },
    ]);
    expect(checks[0]).toMatchObject({
      jobId: "job-unpinned",
      verdict: "error",
      settlementTxIds: [],
    });
    expect(checks[0]?.reason).toMatch(/cannot apply SB-2/);
  });
});
