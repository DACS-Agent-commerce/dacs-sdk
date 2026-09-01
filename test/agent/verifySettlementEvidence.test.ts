import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, test, vi } from "vitest";

import {
  verifySettlementEvidence,
  type EvidenceContext,
  type EvidenceDeps,
} from "../../src/agent/verifySettlementEvidence.js";
import { ed25519Verify, publicKeyFromRaw } from "../../src/crypto/index.js";

const CONF = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../vendor/DACS-Standard/conformance",
);
const haveVectors = existsSync(join(CONF, "vectors/golden.json"));
const read = (p: string) => JSON.parse(readFileSync(join(CONF, p), "utf8"));

const b64u = (s: string) => Uint8Array.from(Buffer.from(s, "base64url"));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Resolve the orchestrator's real key + verify with real ed25519.
function realDeps(publicKeys: Record<string, string>): EvidenceDeps {
  return {
    resolvePublicKey: async (signer) =>
      publicKeys[signer] ? b64u(publicKeys[signer]) : null,
    verify: (bytes, sig, key) => ed25519Verify(bytes, sig, publicKeyFromRaw(key)),
  };
}

const ORCH = "did:demos:orchestrator";

describe.skipIf(!haveVectors)("verifySettlementEvidence — §14 golden fixtures", () => {
  const golden = read("vectors/golden.json").settlement;
  const paymentFx = read("fixtures/settlement-evidence-payment-success.json");
  const deliveryFx = read("fixtures/settlement-evidence-delivery-success.json");
  const deps = realDeps(golden.publicKeys ?? deliveryFx.publicKeys);

  const paymentCtx: EvidenceContext = {
    orchestrator: ORCH,
    attestationRef: paymentFx.result.attestationRef,
  };
  const deliveryCtx: EvidenceContext = {
    orchestrator: ORCH,
    attestationRef: deliveryFx.result.attestationRef,
  };

  it("paymentPass — the reference payment-success record verifies", async () => {
    const r = await verifySettlementEvidence(paymentFx.evidence, paymentCtx, deps);
    expect(r.decision).toBe("pass");
    expect(r.reasons).toEqual([]);
  });

  it("deliveryPass — the reference delivery-success record verifies", async () => {
    const r = await verifySettlementEvidence(deliveryFx.evidence, deliveryCtx, deps);
    expect(r.decision).toBe("pass");
    expect(r.reasons).toEqual([]);
  });

  it("evidence signed-scope hash equals the golden evidenceHash (sig excluded)", async () => {
    // A tampered record must not verify under the real key.
    const tampered = { ...paymentFx.evidence, observedAt: 1 };
    const r = await verifySettlementEvidence(tampered, paymentCtx, deps);
    expect(r.decision).toBe("fail");
  });
});

// ── Decision-by-decision, over constructed mutations of the base records ──
describe.skipIf(!haveVectors)("verifySettlementEvidence — settlement decision rules", () => {
  const payment = () =>
    structuredClone(read("fixtures/settlement-evidence-payment-success.json").evidence);
  const delivery = () =>
    structuredClone(read("fixtures/settlement-evidence-delivery-success.json").evidence);

  // Structural mutations run WITHOUT key deps: the record signature is left
  // intact but unverified, so the structural violation is the sole verdict.
  const verify = (ev: unknown, ctx: EvidenceContext = {}) =>
    verifySettlementEvidence(ev, ctx, {});

  test("paymentPass: base record with no context is a clean pass", async () => {
    expect((await verify(payment())).decision).toBe("pass");
  });
  test("deliveryPass: base delivery record passes", async () => {
    expect((await verify(delivery())).decision).toBe("pass");
  });

  test("a non-object root is `error`, not fail (input isn't a record, §7.5.1)", async () => {
    expect((await verify(null)).decision).toBe("error");
    expect((await verify("nope" as unknown)).decision).toBe("error");
  });

  test("successPaymentMissingFinality → fail", async () => {
    const ev = payment();
    delete ev.settlementFinality;
    expect((await verify(ev)).decision).toBe("fail");
  });
  test("successMissingPaymentTxRefs → fail", async () => {
    const ev = payment();
    delete ev.paymentTxRefs;
    expect((await verify(ev)).decision).toBe("fail");
  });
  test("successMissingPaymentAmount → fail", async () => {
    const ev = payment();
    delete ev.paymentAmount;
    expect((await verify(ev)).decision).toBe("fail");
  });
  test("accepts a current signed EVM event arm for the matching phase", async () => {
    const ev = payment();
    ev.paymentTxRefs = [{
      kind: "evm-event",
      chainId: 80002,
      txHash: "a".repeat(64),
      logIndex: 7,
    }];
    expect((await verify(ev)).decision).toBe("pass");
  });
  test("rejects current event arms under the wrong phase or finality model", async () => {
    const ev = payment();
    ev.paymentTxRefs = [{
      kind: "x402-event",
      httpResource: "https://seller.example/resource",
      paymentReceiptHash: "b".repeat(64),
      settlementTxHash: "a".repeat(64),
      chainId: 80002,
      logIndex: 7,
      protocolVersion: "2",
    }];
    expect((await verify(ev)).decision).toBe("fail");
    ev.phase = "pay-x402";
    ev.settlementFinality = {
      model: "provider-receipt",
      finalityObservedAt: ev.observedAt,
    };
    expect((await verify(ev)).decision).toBe("fail");
  });
  test("nonCanonicalAmount → fail", async () => {
    const ev = payment();
    ev.paymentAmount.amount = "5.00"; // canonical is "5"
    expect((await verify(ev)).decision).toBe("fail");
  });
  test("nonPositiveAmount → fail", async () => {
    const ev = payment();
    ev.paymentAmount.amount = "0";
    expect((await verify(ev)).decision).toBe("fail");
  });
  test("negativeFee → fail", async () => {
    const ev = payment();
    ev.paymentFee = { amount: "-1", currency: "USDC" };
    expect((await verify(ev)).decision).toBe("fail");
  });
  test("failureNoReason → fail", async () => {
    const ev = payment();
    ev.outcome = "failure";
    delete ev.settlementFinality; // finality is success-only
    expect((await verify(ev)).decision).toBe("fail");
  });

  test("outOfSetFinalityModel → fail (PC-6 closed set; presence alone insufficient)", async () => {
    const ev = payment();
    ev.settlementFinality = { model: "trust-me", finalityObservedAt: 1 };
    expect((await verify(ev)).decision).toBe("fail");
  });
  test("bftFinalModel (pay-dem §9.5.9) is accepted", async () => {
    const ev = payment();
    ev.settlementFinality = { model: "bft-final", finalityObservedAt: 1 };
    expect((await verify(ev)).decision).toBe("pass");
  });
  test("bftFinal carrying a stray finalityBlocks → fail (inclusion IS finality, §9.5.9)", async () => {
    const ev = payment();
    ev.settlementFinality = { model: "bft-final", finalityBlocks: 1, finalityObservedAt: 1 };
    expect((await verify(ev)).decision).toBe("fail");
  });
  test("blockDepth with a negative finalityBlocks → fail", async () => {
    const ev = payment();
    ev.settlementFinality = { model: "block-depth", finalityBlocks: -1, finalityObservedAt: 1 };
    expect((await verify(ev)).decision).toBe("fail");
  });
  test("commitmentLevel with an out-of-set commitment → fail", async () => {
    const ev = payment();
    ev.settlementFinality = { model: "commitment-level", finalityCommitmentLevel: "kinda", finalityObservedAt: 1 };
    expect((await verify(ev)).decision).toBe("fail");
  });
  test("commitmentLevel with a valid commitment passes", async () => {
    const ev = payment();
    ev.settlementFinality = { model: "commitment-level", finalityCommitmentLevel: "confirmed", finalityObservedAt: 1 };
    expect((await verify(ev)).decision).toBe("pass");
  });
  test("finality without finalityObservedAt → fail (§9.7 requires it)", async () => {
    const ev = payment();
    ev.settlementFinality = { model: "block-depth", finalityBlocks: 1 };
    expect((await verify(ev)).decision).toBe("fail");
  });

  test("deliveryWithFinality → fail", async () => {
    const ev = delivery();
    ev.settlementFinality = { model: "block-depth", finalityBlocks: 1, finalityObservedAt: 1 };
    expect((await verify(ev)).decision).toBe("fail");
  });
  test("deliveryMissingDeliverable → fail", async () => {
    const ev = delivery();
    delete ev.deliverableContentHash;
    expect((await verify(ev)).decision).toBe("fail");
  });
  test("deliveryMalformedContentHash → fail", async () => {
    const ev = delivery();
    ev.deliverableContentHash = "not-a-hash";
    expect((await verify(ev)).decision).toBe("fail");
  });
  test("storageAnchoredAsEntitlement → fail", async () => {
    const ev = delivery();
    ev.deliverableAnchor.kind = "entitlement"; // phase is deliver-storage-program
    expect((await verify(ev)).decision).toBe("fail");
  });

  test("currencyMismatchNotRejected → fail (rail asset mismatch)", async () => {
    const ev = payment();
    ev.paymentAmount.currency = "DAI";
    expect((await verify(ev, { rail: { asset: "USDC" } })).decision).toBe("fail");
  });
  test("underpaymentVsAgreement → fail", async () => {
    const ev = payment(); // amount "5"
    const ctx: EvidenceContext = { agreement: { amount: "10", currency: "USDC" } };
    expect((await verify(ev, ctx)).decision).toBe("fail");
  });
  test("phaseRailMismatch → fail", async () => {
    const ev = payment(); // phase pay-evm-erc20
    expect((await verify(ev, { rail: { railType: "solana-spl" } })).decision).toBe("fail");
  });
  test("txRefsMismatch → fail", async () => {
    const ev = payment();
    expect((await verify(ev, { rail: { railType: "solana-spl" } })).decision).toBe("fail");
  });
  test("binds legacy and current EVM refs to the canonical pinned chain", async () => {
    const legacy = payment();
    expect((await verify(legacy, {
      rail: { railType: "evm-erc20", network: "eip155:80002" },
    })).decision).toBe("pass");
    expect((await verify(legacy, {
      rail: { railType: "evm-erc20", network: "eip155:8453" },
    })).decision).toBe("fail");

    const current = payment();
    current.paymentTxRefs = [{
      kind: "evm-event",
      chainId: 80002,
      txHash: "a".repeat(64),
      logIndex: 7,
    }];
    expect((await verify(current, {
      rail: { railType: "evm-erc20", network: "eip155:80002" },
    })).decision).toBe("pass");
    expect((await verify(current, {
      rail: { railType: "evm-erc20", network: "eip155:8453" },
    })).decision).toBe("fail");
  });

  test("binds legacy and current Solana refs to the canonical pinned cluster", async () => {
    const legacy = payment();
    legacy.phase = "pay-solana-spl";
    legacy.paymentTxRefs = [{
      kind: "solana",
      cluster: "devnet",
      signature: "illustrative-signature",
    }];
    legacy.settlementFinality = {
      model: "commitment-level",
      finalityCommitmentLevel: "finalized",
      finalityObservedAt: legacy.observedAt,
    };
    expect((await verify(legacy, {
      rail: { railType: "solana-spl", network: "solana:devnet" },
    })).decision).toBe("pass");
    expect((await verify(legacy, {
      rail: { railType: "solana-spl", network: "solana:testnet" },
    })).decision).toBe("fail");

    const current = structuredClone(legacy);
    current.paymentTxRefs = [{
      kind: "solana-instruction",
      cluster: "devnet",
      signature: "1".repeat(64),
      instructionIndex: 2,
    }];
    expect((await verify(current, {
      rail: { railType: "solana-spl", network: "solana:devnet" },
    })).decision).toBe("pass");
    expect((await verify(current, {
      rail: { railType: "solana-spl", network: "solana:mainnet" },
    })).decision).toBe("fail");
  });

  test("binds legacy and current x402 refs to the canonical pinned chain", async () => {
    const legacy = payment();
    legacy.phase = "pay-x402";
    legacy.paymentTxRefs = [{
      kind: "x402",
      httpResource: "https://seller.example/resource",
      paymentReceiptHash: "b".repeat(64),
      settlementTxHash: `0x${"a".repeat(64)}`,
      chainId: 80002,
      protocolVersion: "2",
    }];
    expect((await verify(legacy, {
      rail: { railType: "x402", network: "eip155:80002" },
    })).decision).toBe("pass");
    expect((await verify(legacy, {
      rail: { railType: "x402", network: "eip155:8453" },
    })).decision).toBe("fail");

    const current = structuredClone(legacy);
    current.paymentTxRefs = [{
      kind: "x402-event",
      httpResource: "https://seller.example/resource",
      paymentReceiptHash: "b".repeat(64),
      settlementTxHash: "a".repeat(64),
      chainId: 80002,
      logIndex: 7,
      protocolVersion: "2",
    }];
    expect((await verify(current, {
      rail: { railType: "x402", network: "eip155:80002" },
    })).decision).toBe("pass");
    expect((await verify(current, {
      rail: { railType: "x402", network: "eip155:8453" },
    })).decision).toBe("fail");
  });

  test.each([
    "eip155:0",
    "eip155:08453",
    "base-sepolia",
    "solana:localnet",
    "demos:testnet",
  ])("rejects malformed or non-canonical pinned network %s", async (network) => {
    const ev = payment();
    expect((await verify(ev, {
      rail: { railType: "evm-erc20", network },
    })).decision).toBe("fail");
  });

  test("accepts only the Demos network pin for a Demos tx ref", async () => {
    const ev = payment();
    ev.phase = "pay-dem";
    ev.paymentTxRefs = [{
      kind: "demos",
      txHash: `0x${"a".repeat(64)}`,
      blockNumber: 77,
    }];
    ev.paymentAmount = { amount: "5", currency: "DEM" };
    ev.settlementFinality = {
      model: "bft-final",
      finalityObservedAt: ev.observedAt,
    };
    expect((await verify(ev, {
      rail: { railType: "demos-native", network: "demos" },
    })).decision).toBe("pass");
    expect((await verify(ev, {
      rail: { railType: "demos-native", network: "eip155:80002" },
    })).decision).toBe("fail");
  });

  test("wrongAttestationKind → fail", async () => {
    const ev = payment();
    const ctx = {
      attestationRef: {
        anchor: { kind: "wrong", locator: "evidence" },
        contentHash: "0".repeat(64),
      },
    } as unknown as EvidenceContext;
    expect((await verify(ev, ctx)).decision).toBe("fail");
  });
  test("attestationRefHashMismatch → fail", async () => {
    const ev = payment();
    const ctx: EvidenceContext = {
      attestationRef: {
        anchor: { kind: "storage-program", locator: "evidence" },
        contentHash: "0".repeat(64),
      },
    };
    expect((await verify(ev, ctx)).decision).toBe("fail");
  });
  test("nonOrchestratorSigner → fail", async () => {
    const ev = payment(); // signer is did:demos:orchestrator
    expect((await verify(ev, { orchestrator: "did:demos:someone-else" })).decision).toBe("fail");
  });
  test("legacy string signature → fail", async () => {
    const ev = payment();
    ev.signature = "deadbeef";
    expect((await verify(ev)).decision).toBe("fail");
  });
  test("padded signature value → fail", async () => {
    const ev = payment();
    ev.signature.value = "YWJjZA==";
    expect((await verify(ev)).decision).toBe("fail");
  });
  test("singular plus plural signature fields → fail", async () => {
    const ev = payment();
    ev.signatures = [];
    expect((await verify(ev)).decision).toBe("fail");
  });

  // Key-dependent verdicts (error / indeterminate / signature-fail).
  test("unresolvableKey → indeterminate", async () => {
    const ev = payment();
    const r = await verifySettlementEvidence(ev, {}, { resolvePublicKey: async () => null, verify: () => true });
    expect(r.decision).toBe("indeterminate");
  });
  test("malformedKey → error", async () => {
    const ev = payment();
    const r = await verifySettlementEvidence(
      ev,
      {},
      { resolvePublicKey: async () => new Uint8Array(10), verify: () => true },
    );
    expect(r.decision).toBe("error");
  });
  test("wrongSignerKey → fail (signature does not verify)", async () => {
    const ev = payment();
    const r = await verifySettlementEvidence(
      ev,
      {},
      { resolvePublicKey: async () => new Uint8Array(32), verify: () => false },
    );
    expect(r.decision).toBe("fail");
  });
  test("uses one authoritative evidence/context snapshot across async key resolution", async () => {
    const ev = payment();
    const ctx: EvidenceContext = { orchestrator: ORCH };
    const publicKeys = read("vectors/golden.json").settlement.publicKeys as Record<
      string,
      string
    >;
    const entered = deferred();
    const release = deferred();
    const pending = verifySettlementEvidence(ev, ctx, {
      resolvePublicKey: async (signer) => {
        entered.resolve();
        await release.promise;
        return publicKeys[signer] ? b64u(publicKeys[signer]) : null;
      },
      verify: (bytes, signature, key) =>
        ed25519Verify(bytes, signature, publicKeyFromRaw(key)),
    });

    await entered.promise;
    ev.observedAt = -0;
    ev.signature.value = "AQ";
    ctx.orchestrator = "did:demos:attacker";
    release.resolve();

    const result = await pending;
    expect(result).toEqual({ decision: "pass", reasons: [] });
  });
  test("rejects accessor evidence before invoking its getter", async () => {
    const getter = vi.fn(() => "1");
    const ev = payment();
    Object.defineProperty(ev, "evidenceVersion", {
      configurable: true,
      enumerable: true,
      get: getter,
    });

    const result = await verifySettlementEvidence(ev);
    expect(result.decision).toBe("error");
    expect(result.reasons).toContain(
      "evidence or verification context is not stable canonical JSON",
    );
    expect(getter).not.toHaveBeenCalled();
  });
  test("maps non-boolean and throwing crypto dependencies to explicit verdicts", async () => {
    const ev = payment();
    const key = new Uint8Array(32);

    const nonBoolean = await verifySettlementEvidence(ev, {}, {
      resolvePublicKey: async () => key,
      verify: (() => "yes") as never,
    });
    expect(nonBoolean.decision).toBe("error");
    expect(nonBoolean.reasons).toContain(
      "evidence signature verifier returned a non-boolean result",
    );

    const resolverThrow = await verifySettlementEvidence(ev, {}, {
      resolvePublicKey: async () => {
        throw new Error("key backend unavailable");
      },
      verify: () => true,
    });
    expect(resolverThrow.decision).toBe("indeterminate");
    expect(resolverThrow.reasons).toContain(
      `signer key for "${ORCH}" could not be resolved`,
    );

    const verifierThrow = await verifySettlementEvidence(ev, {}, {
      resolvePublicKey: async () => key,
      verify: () => {
        throw new Error("crypto backend unavailable");
      },
    });
    expect(verifierThrow.decision).toBe("error");
    expect(verifierThrow.reasons).toContain(
      "evidence signature verification could not be evaluated",
    );
  });

  // HTLC route params (HTLC-7).
  const htlc = () => {
    const ev = payment();
    ev.phase = "pay-cross-chain-htlc";
    ev.paymentTxRefs = [
      {
        kind: "htlc-claim",
        chainId: 80002,
        contractAddress: "0x0000000000000000000000000000000000000001",
        claimTxHash: "0xclaim",
      },
    ];
    ev.settlementFinality = { model: "htlc-reveal", finalityObservedAt: 1 };
    return ev;
  };
  test("htlcFinalityParams → pass (both params pinned, margin ok)", async () => {
    const ctx: EvidenceContext = {
      rail: { railType: "cross-chain-htlc", sourceFinalitySec: 120, safetyWindowSec: 600 },
      htlcExpiry: { source: 10_000, dest: 5_000 },
    };
    expect((await verify(htlc(), ctx)).decision).toBe("pass");
  });
  test("htlcMissingSourceFinality → fail", async () => {
    const ctx: EvidenceContext = { rail: { railType: "cross-chain-htlc", safetyWindowSec: 600 } };
    expect((await verify(htlc(), ctx)).decision).toBe("fail");
  });
  test("htlcMissingSafetyWindow → fail", async () => {
    const ctx: EvidenceContext = { rail: { railType: "cross-chain-htlc", sourceFinalitySec: 120 } };
    expect((await verify(htlc(), ctx)).decision).toBe("fail");
  });
  test("htlcInsufficientMargin → fail", async () => {
    const ctx: EvidenceContext = {
      rail: { railType: "cross-chain-htlc", sourceFinalitySec: 120, safetyWindowSec: 600 },
      htlcExpiry: { source: 5_100, dest: 5_000 }, // margin 100 < 720
    };
    expect((await verify(htlc(), ctx)).decision).toBe("fail");
  });

  // Phase-result envelope coherence.
  test("okTrueWithErrorClass → fail", async () => {
    const ctx: EvidenceContext = { result: { ok: true, errorClass: "counterparty" } };
    expect((await verify(payment(), ctx)).decision).toBe("fail");
  });
  test("okFalseNoErrorClass → fail", async () => {
    const ev = payment();
    ev.outcome = "failure";
    ev.reason = "rail rejected";
    delete ev.settlementFinality;
    const ctx: EvidenceContext = { result: { ok: false } };
    expect((await verify(ev, ctx)).decision).toBe("fail");
  });

  // Anchor + rail-internal coherence.
  test("wrongAnchor → fail (locator != expected SR-2 address)", async () => {
    const ctx: EvidenceContext = { expectedAnchorLocator: "stor-somewhere-else" };
    expect((await verify(delivery(), ctx)).decision).toBe("fail");
  });
  test("binds the complete PC-2 payment address tuple, including CF-4 rail encoding", async () => {
    const fixture = read("fixtures/settlement-evidence-payment-success.json");
    const validContext: EvidenceContext = {
      attestationRef: fixture.result.attestationRef,
      rail: { railId: "polygon-amoy-usdc" },
      paymentAddress: { railId: "polygon-amoy-usdc", phaseIndex: 0 },
    };
    expect((await verify(fixture.evidence, validContext)).decision).toBe("pass");

    expect((await verify(fixture.evidence, {
      ...validContext,
      paymentAddress: { railId: "polygon-amoy-usdc", phaseIndex: 1 },
    })).decision).toBe("fail");

    expect((await verify(fixture.evidence, {
      ...validContext,
      rail: { railId: "evm-erc20:80002:USDC" },
      paymentAddress: { railId: "evm-erc20:80002:USDC", phaseIndex: 0 },
      attestationRef: {
        ...fixture.result.attestationRef,
        anchor: {
          kind: "storage-program",
          locator:
            `dacs4:payment:${fixture.evidence.jobId}:` +
            "evm-erc20%3A80002%3AUSDC:0",
        },
      },
    })).decision).toBe("pass");
  });
  test("does not turn a missing PC-2 read into evidence absence", async () => {
    const ev = payment();
    const result = await verify(ev, {
      paymentAddress: { railId: "polygon-amoy-usdc", phaseIndex: 0 },
    });
    expect(result.decision).toBe("indeterminate");
    expect(result.reasons).toContain(
      "payment evidence attestationRef is unavailable for PC-2 address binding",
    );
  });
  test("requires signed paymentTxRefs to equal the authenticated handler result", async () => {
    const fixture = read("fixtures/settlement-evidence-payment-success.json");
    expect((await verify(fixture.evidence, {
      result: { ok: true, txRefs: fixture.result.txRefs },
    })).decision).toBe("pass");

    const mismatched = structuredClone(fixture.result.txRefs);
    mismatched[0].txHash = "polygon-amoy:0xanother-settlement";
    expect((await verify(fixture.evidence, {
      result: { ok: true, txRefs: mismatched },
    })).decision).toBe("fail");
  });
  test("incoherentRailTypeHandler → fail", async () => {
    const ctx: EvidenceContext = { rail: { railType: "evm-erc20", handler: "pay-solana-spl" } };
    expect((await verify(payment(), ctx)).decision).toBe("fail");
  });
  test("enforces structured RD-5 asset/network kinds and EVM chain identity", async () => {
    const valid: EvidenceContext = {
      rail: {
        railType: "evm-erc20",
        network: "eip155:80002",
        assetSpec: { kind: "erc20", chainId: 80002 },
        networkSpec: { kind: "evm", chainId: 80002 },
      },
    };
    expect((await verify(payment(), valid)).decision).toBe("pass");
    expect((await verify(payment(), {
      rail: {
        ...valid.rail,
        networkSpec: { kind: "solana", cluster: "devnet" },
      },
    })).decision).toBe("fail");
    expect((await verify(payment(), {
      rail: {
        ...valid.rail,
        networkSpec: { kind: "evm", chainId: 8453 },
      },
    })).decision).toBe("fail");
    expect((await verify(payment(), {
      rail: {
        ...valid.rail,
        assetSpec: { kind: "erc20", chainId: 0 },
      },
    })).decision).toBe("error");
  });

  // Tolerated / valid cross-chain shapes → pass.
  test("crossChainAnchorPending → pass (success without a resolved anchor tx)", async () => {
    const ev = payment();
    ev.phase = "pay-cross-chain-liquidity-tank";
    ev.paymentTxRefs = [
      {
        kind: "liquidity-tank",
        bridgeId: "bridge-1",
        sourceChainId: 8453,
        destChainId: 80002,
        lockTxHash: "0xlock",
        releaseTxHash: "0xrelease",
      },
    ];
    ev.settlementFinality = { model: "liquidity-tank", finalityObservedAt: 1 };
    const ctx: EvidenceContext = { rail: { railType: "cross-chain-liquidity-tank" } };
    expect((await verify(ev, ctx)).decision).toBe("pass");
  });
  test("crossChainIdMatchingKindPass → pass (a valid cross-chain txRef kind)", async () => {
    const ev = htlc();
    ev.paymentTxRefs = [
      {
        kind: "htlc-claim",
        chainId: 80002,
        contractAddress: "0x0000000000000000000000000000000000000001",
        claimTxHash: "0xclaim",
      },
    ];
    const ctx: EvidenceContext = {
      rail: { railType: "cross-chain-htlc", sourceFinalitySec: 120, safetyWindowSec: 600 },
      htlcExpiry: { source: 10_000, dest: 5_000 },
    };
    expect((await verify(ev, ctx)).decision).toBe("pass");
  });
  test("deliveryExtraPaymentFieldPass → pass (uniform §9.7 optional field)", async () => {
    const ev = delivery();
    ev.paymentAmount = { amount: "5", currency: "USDC" }; // stray, but not finality
    expect((await verify(ev)).decision).toBe("pass");
  });
});
