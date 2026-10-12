import { describe, expect, test, vi } from "vitest";

import {
  advanceSolanaSplSettlement,
  createInMemorySolanaSplSettlementStore,
  createSolanaSplSettlementIntent,
  solanaSplSettlementKey,
  type AdvanceSolanaSplSettlementInput,
  type SolanaSplAdapter,
  type SolanaSplObservedTransfer,
  type SolanaSplPreflight,
  type SolanaSplReconciliation,
  type SolanaSplSettlementAuthority,
  type SolanaSplSettlementStore,
  type SolanaSplSignedAttempt,
} from "../../src/rails/solanaSpl.js";

// Fixed-width values with canonical Base58 leading-zero encoding. These decode
// to exactly 32-byte public keys and 64-byte transaction signatures.
const PAYER = "1".repeat(32);
const PAYEE = `${"1".repeat(31)}2`;
const MINT = `${"1".repeat(31)}3`;
const PAYER_TOKEN = `${"1".repeat(31)}4`;
const PAYEE_ATA = `${"1".repeat(31)}5`;
const SIGNATURE_1 = "1".repeat(64);
const SIGNATURE_2 = `${"1".repeat(63)}2`;
const HASH = "a".repeat(64);

function authority(
  overrides: Partial<SolanaSplSettlementAuthority> = {},
): SolanaSplSettlementAuthority {
  return {
    jobId: "job-solana-spl-1",
    phaseIndex: 2,
    railId: "solana-devnet-usdc",
    railDescriptorHash: HASH,
    agreementHash: "b".repeat(64),
    assetKind: "spl",
    cluster: "devnet",
    payer: PAYER,
    payee: PAYEE,
    mint: MINT,
    assetSymbol: "USDC",
    amount: "1.25",
    currency: "USDC",
    tokenDecimals: 6,
    ...overrides,
  };
}

function preflight(overrides: Partial<SolanaSplPreflight> = {}): SolanaSplPreflight {
  return {
    payerTokenAccount: PAYER_TOKEN,
    payerTokenBalanceBaseUnits: "5000000",
    payerNativeBalanceLamports: "10000000",
    payeeAta: PAYEE_ATA,
    payeeAtaExists: true,
    payeeAtaOwner: PAYEE,
    payeeAtaMint: MINT,
    networkFeeLamports: "5000",
    ataRentExemptReserveLamports: "2039280",
    ...overrides,
  };
}

function observed(
  overrides: Partial<SolanaSplObservedTransfer> = {},
): SolanaSplObservedTransfer {
  return {
    cluster: "devnet",
    signature: SIGNATURE_1,
    instructionIndex: 1,
    standard: "spl-transfer-checked",
    mint: MINT,
    payer: PAYER,
    payee: PAYEE,
    amountBaseUnits: "1250000",
    tokenDecimals: 6,
    commitmentLevel: "confirmed",
    finalityObservedAt: 1_788_000_000_000,
    authenticationHash: "c".repeat(64),
    ...overrides,
  };
}

type SolanaSplExpiredReconciliation = Extract<
  SolanaSplReconciliation,
  { disposition: "absent-expired" }
>;

function expired(
  attempt: Pick<SolanaSplSignedAttempt, "signature" | "lastValidBlockHeight">,
  overrides: Partial<Omit<SolanaSplExpiredReconciliation, "disposition">> = {},
): SolanaSplExpiredReconciliation {
  return {
    disposition: "absent-expired",
    observedBlockHeight: attempt.lastValidBlockHeight + 1,
    commitmentLevel: "confirmed",
    authenticationHash: "e".repeat(64),
    ...overrides,
  };
}

function legacyExpiryView(store: SolanaSplSettlementStore): SolanaSplSettlementStore {
  return {
    ...store,
    async claim(request) {
      const claim = await store.claim(request);
      if (claim.status !== "acquired" && claim.status !== "waiting") return claim;
      return {
        status: claim.status,
        intent: claim.intent,
        lease: claim.lease,
        attempts: claim.attempts,
        expiredSignatures: claim.expiredSignatures,
      };
    },
  };
}

function adapter(overrides: Partial<SolanaSplAdapter> = {}): SolanaSplAdapter {
  return {
    async preflight(_intent, fence) {
      await fence.assertCurrent();
      return preflight();
    },
    async prepareSignedTransfer(plan, attempt, fence) {
      await fence.assertCurrent();
      return {
        attemptVersion: "1",
        attempt,
        authorityHash: plan.intent.bindingHash,
        signature: attempt === 1 ? SIGNATURE_1 : SIGNATURE_2,
        signedTransactionBase64: Buffer.from(`signed-wire-${attempt}`, "utf8").toString("base64"),
        lastValidBlockHeight: 10_000 + attempt,
        transferInstructionIndex: 1,
        preparedAt: 1_788_000_000_000 + attempt,
      };
    },
    async broadcastRetained(_attempt, fence) {
      await fence.assertCurrent();
      return { disposition: "submitted" };
    },
    async reconcile(_intent, attempt, fence) {
      await fence.assertCurrent();
      return {
        disposition: "settled-same",
        transfer: observed({ signature: attempt.signature }),
      };
    },
    ...overrides,
  };
}

function input(
  overrides: Partial<AdvanceSolanaSplSettlementInput> = {},
): AdvanceSolanaSplSettlementInput {
  return {
    authority: authority(),
    owner: "worker-a",
    store: createInMemorySolanaSplSettlementStore(),
    adapter: adapter(),
    now: () => 1_000,
    leaseDurationMs: 100,
    ...overrides,
  };
}

describe("createSolanaSplSettlementIntent", () => {
  test("normalizes amount, converts exact base units and defaults to confirmed", () => {
    expect(createSolanaSplSettlementIntent(authority({ amount: "01.2500" })))
      .toMatchObject({
        amount: "1.25",
        amountBaseUnits: "1250000",
        commitmentLevel: "confirmed",
        createPayeeAtaIfMissing: false,
      });
  });

  test.each([
    ["asset mismatch", { currency: "SOL" }],
    ["zero", { amount: "0" }],
    ["overprecision", { amount: "1.0000001" }],
    ["bad cluster", { cluster: "localnet" }],
    ["bad decimals", { tokenDecimals: 256 }],
    ["wrong asset kind", { assetKind: "erc20" }],
    ["legacy address", { payer: "not_base58_0" }],
    ["wrong public-key width", { payer: "2".repeat(32) }],
    ["oversized public-key width", { payer: "1".repeat(33) }],
  ])("rejects %s before adapter access", (_name, override) => {
    expect(() => createSolanaSplSettlementIntent(authority(override as never))).toThrow();
  });

  test("uses an unambiguous structured settlement-key preimage", () => {
    expect(solanaSplSettlementKey({ jobId: "a:b", railId: "c", phaseIndex: 1 }))
      .not.toBe(solanaSplSettlementKey({ jobId: "a", railId: "b:c", phaseIndex: 1 }));
  });
});

describe("advanceSolanaSplSettlement", () => {
  test.each([
    ["short decoded value", "2".repeat(64)],
    ["65-byte decoded value", "1".repeat(65)],
  ])("rejects a %s before persistence", async (_name, invalidSignature) => {
    const store = createInMemorySolanaSplSettlementStore();
    const recordAttempt = vi.spyOn(store, "recordAttempt");
    const broadcastRetained = vi.fn();
    const result = await advanceSolanaSplSettlement(input({
      store,
      adapter: adapter({
        async prepareSignedTransfer(plan, attempt) {
          return {
            attemptVersion: "1",
            attempt,
            authorityHash: plan.intent.bindingHash,
            signature: invalidSignature,
            signedTransactionBase64: Buffer.from("signed-wire", "utf8").toString("base64"),
            lastValidBlockHeight: 10_001,
            transferInstructionIndex: 1,
            preparedAt: 1_788_000_000_001,
          };
        },
        broadcastRetained,
      }),
    }));

    expect(result).toMatchObject({ status: "indeterminate" });
    expect(recordAttempt).not.toHaveBeenCalled();
    expect(broadcastRetained).not.toHaveBeenCalled();
  });

  test("returns current solana-instruction coordinates only after exact commitment", async () => {
    const sequence: string[] = [];
    const prepareSignedTransfer = vi.fn(async (plan, attempt, fence) => {
      sequence.push("prepare");
      return adapter().prepareSignedTransfer(plan, attempt, fence);
    });
    const broadcastRetained = vi.fn(async (attempt, fence) => {
      sequence.push("broadcast");
      return adapter().broadcastRetained(attempt, fence);
    });
    const reconcile = vi.fn(async (intent, attempt, fence) => {
      sequence.push("reconcile");
      return adapter().reconcile(intent, attempt, fence);
    });
    const result = await advanceSolanaSplSettlement(input({
      adapter: adapter({ prepareSignedTransfer, broadcastRetained, reconcile }),
    }));
    expect(result).toEqual({
      status: "settled",
      settlement: {
        txRef: {
          kind: "solana-instruction",
          cluster: "devnet",
          signature: SIGNATURE_1,
          instructionIndex: 1,
        },
        paymentAmount: { amount: "1.25", currency: "USDC" },
        settlementFinality: {
          model: "commitment-level",
          finalityCommitmentLevel: "confirmed",
          finalityObservedAt: 1_788_000_000_000,
        },
        authenticationHash: "c".repeat(64),
      },
    });
    expect(sequence).toEqual(["prepare", "broadcast", "reconcile"]);
  });

  test("missing ATA defaults to counterparty failure before signing", async () => {
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    await expect(advanceSolanaSplSettlement(input({
      adapter: adapter({
        preflight: async () => preflight({ payeeAtaExists: false }),
        prepareSignedTransfer,
        broadcastRetained,
      }),
    }))).resolves.toEqual({
      status: "failed",
      errorClass: "counterparty",
      reason: "solana-spl-payee-ata-missing",
    });
    expect(prepareSignedTransfer).not.toHaveBeenCalled();
    expect(broadcastRetained).not.toHaveBeenCalled();
  });

  test("explicit ATA creation is payer-funded and uses TransferChecked", async () => {
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    await expect(advanceSolanaSplSettlement(input({
      authority: authority({ createPayeeAtaIfMissing: true }),
      adapter: adapter({
        preflight: async () => preflight({ payeeAtaExists: false }),
        prepareSignedTransfer,
      }),
    }))).resolves.toMatchObject({ status: "settled" });
    expect(prepareSignedTransfer.mock.calls[0]?.[0]).toMatchObject({
      createPayeeAta: true,
      payerFundsAtaRentLamports: "2039280",
      instruction: "TransferChecked",
      payeeAta: PAYEE_ATA,
    });
  });

  test.each([
    ["token balance", preflight({ payerTokenBalanceBaseUnits: "1249999" }), "solana-spl-insufficient-token-balance"],
    ["ATA rent", preflight({ payeeAtaExists: false, payerNativeBalanceLamports: "2040000" }), "solana-spl-insufficient-ata-rent-and-fee-balance"],
    ["network fee", preflight({ payerNativeBalanceLamports: "4999" }), "solana-spl-insufficient-network-fee-balance"],
  ])("insufficient %s fails before signing", async (_name, checked, reason) => {
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    await expect(advanceSolanaSplSettlement(input({
      authority: authority({ createPayeeAtaIfMissing: true }),
      adapter: adapter({ preflight: async () => checked, prepareSignedTransfer }),
    }))).resolves.toEqual({ status: "failed", errorClass: "permanent", reason });
    expect(prepareSignedTransfer).not.toHaveBeenCalled();
  });

  test("ambiguous broadcast recovers the retained signature without re-signing", async () => {
    let clock = 1_000;
    let reconciliations = 0;
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const broadcastRetained = vi.fn(async () => ({
      disposition: "indeterminate" as const,
      reason: "rpc-response-lost",
    }));
    const reconcile = vi.fn(async (_intent, attempt) => {
      reconciliations += 1;
      return reconciliations === 1
        ? { disposition: "indeterminate" as const, reason: "rpc-unavailable" }
        : { disposition: "settled-same" as const, transfer: observed({ signature: attempt.signature }) };
    });
    const shared = input({
      adapter: adapter({ prepareSignedTransfer, broadcastRetained, reconcile }),
      now: () => clock,
    });
    await expect(advanceSolanaSplSettlement(shared)).resolves.toEqual({
      status: "indeterminate",
      reason: "rpc-unavailable",
    });
    clock += 101;
    await expect(advanceSolanaSplSettlement({ ...shared, owner: "worker-b" }))
      .resolves.toMatchObject({ status: "settled" });
    expect(prepareSignedTransfer).toHaveBeenCalledTimes(1);
    expect(broadcastRetained).toHaveBeenCalledTimes(1);
  });

  test("authenticated absent-valid state rebroadcasts byte-identical retained wire", async () => {
    let clock = 1_000;
    let reconciliations = 0;
    const wires: string[] = [];
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const broadcastRetained = vi.fn(async (attempt) => {
      wires.push(attempt.signedTransactionBase64);
      return { disposition: "submitted" as const };
    });
    const reconcile = vi.fn(async (_intent, attempt) => {
      reconciliations += 1;
      if (reconciliations === 1) return { disposition: "indeterminate" as const, reason: "lost" };
      if (reconciliations === 2) return { disposition: "absent-valid" as const, authenticationHash: "d".repeat(64) };
      return { disposition: "settled-same" as const, transfer: observed({ signature: attempt.signature }) };
    });
    const shared = input({
      adapter: adapter({ prepareSignedTransfer, broadcastRetained, reconcile }),
      now: () => clock,
    });
    await advanceSolanaSplSettlement(shared);
    clock += 101;
    await expect(advanceSolanaSplSettlement({ ...shared, owner: "worker-b" }))
      .resolves.toMatchObject({ status: "settled" });
    expect(prepareSignedTransfer).toHaveBeenCalledTimes(1);
    expect(wires).toHaveLength(2);
    expect(new Set(wires).size).toBe(1);
  });

  test("persists valid confirmed expiry before preparing a replacement", async () => {
    let clock = 1_000;
    const sequence: string[] = [];
    const counts = new Map<string, number>();
    const memory = createInMemorySolanaSplSettlementStore();
    const markAttemptExpired = vi.fn(async (request) => {
      sequence.push(`expire-${request.signature}`);
      return memory.markAttemptExpired(request);
    });
    const store: SolanaSplSettlementStore = { ...memory, markAttemptExpired };
    const prepareSignedTransfer = vi.fn(async (plan, attempt, fence) => {
      sequence.push(`prepare-${attempt}`);
      return adapter().prepareSignedTransfer(plan, attempt, fence);
    });
    const reconcile = vi.fn(async (_intent, attempt) => {
      const count = (counts.get(attempt.signature) ?? 0) + 1;
      counts.set(attempt.signature, count);
      if (attempt.signature === SIGNATURE_1) {
        return count === 1
          ? { disposition: "indeterminate" as const, reason: "lost" }
          : expired(attempt);
      }
      return {
        disposition: "settled-same" as const,
        transfer: observed({ signature: SIGNATURE_2 }),
      };
    });
    const shared = input({
      store,
      adapter: adapter({ prepareSignedTransfer, reconcile }),
      now: () => clock,
    });
    await advanceSolanaSplSettlement(shared);
    clock += 101;
    await expect(advanceSolanaSplSettlement({ ...shared, owner: "worker-b" }))
      .resolves.toMatchObject({
        status: "settled",
        settlement: { txRef: { signature: SIGNATURE_2 } },
      });
    expect(prepareSignedTransfer).toHaveBeenCalledTimes(2);
    expect(prepareSignedTransfer.mock.calls.map((call) => call[1])).toEqual([1, 2]);
    expect(markAttemptExpired).toHaveBeenCalledWith(expect.objectContaining({
      signature: SIGNATURE_1,
      observedBlockHeight: 10_002,
      commitmentLevel: "confirmed",
      authenticationHash: "e".repeat(64),
    }));
    expect(sequence).toEqual([
      "prepare-1",
      `expire-${SIGNATURE_1}`,
      "prepare-2",
    ]);
  });

  test.each([
    ["missing height", { commitmentLevel: "confirmed" }],
    ["non-integer height", { observedBlockHeight: 10_001.5, commitmentLevel: "confirmed" }],
    ["equal height", { observedBlockHeight: 10_001, commitmentLevel: "confirmed" }],
    ["lower height", { observedBlockHeight: 10_000, commitmentLevel: "confirmed" }],
    ["missing commitment", { observedBlockHeight: 10_002 }],
    ["wrong commitment", { observedBlockHeight: 10_002, commitmentLevel: "processed" }],
  ])("refuses replacement for %s in fresh expiry evidence", async (_name, fields) => {
    let clock = 1_000;
    let reconciliations = 0;
    const store = createInMemorySolanaSplSettlementStore();
    const markAttemptExpired = vi.spyOn(store, "markAttemptExpired");
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    const reconcile = vi.fn(async (): Promise<SolanaSplReconciliation> => {
      reconciliations += 1;
      if (reconciliations === 1) {
        return { disposition: "indeterminate", reason: "lost" };
      }
      return {
        disposition: "absent-expired",
        authenticationHash: "e".repeat(64),
        ...fields,
      } as SolanaSplReconciliation;
    });
    const shared = input({
      store,
      adapter: adapter({ prepareSignedTransfer, broadcastRetained, reconcile }),
      now: () => clock,
    });

    await advanceSolanaSplSettlement(shared);
    clock += 101;
    await expect(advanceSolanaSplSettlement({ ...shared, owner: "worker-b" }))
      .resolves.toEqual({
        status: "indeterminate",
        reason: "solana-spl-expiry-proof-invalid",
      });
    expect(markAttemptExpired).not.toHaveBeenCalled();
    expect(prepareSignedTransfer).toHaveBeenCalledTimes(1);
    expect(broadcastRetained).toHaveBeenCalledTimes(1);
  });

  test.each(["missing", "mismatched"] as const)(
    "refuses replacement with %s durable expiry acknowledgement",
    async (mode) => {
      let clock = 1_000;
      let observations = 0;
      const memory = createInMemorySolanaSplSettlementStore();
      const store: SolanaSplSettlementStore = {
        ...memory,
        async markAttemptExpired(request) {
          const result = await memory.markAttemptExpired(request);
          if (result.status !== "recorded" && result.status !== "existing") return result;
          return mode === "missing" ? { status: result.status } : {
            status: result.status,
            expiryEvidence: { ...request, observedBlockHeight: request.observedBlockHeight + 1 },
          };
        },
      };
      const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
      const broadcastRetained = vi.fn(adapter().broadcastRetained);
      const checkedPreflight = vi.fn(adapter().preflight);
      const shared = input({
        store, now: () => clock,
        adapter: adapter({
          preflight: checkedPreflight, prepareSignedTransfer, broadcastRetained,
          async reconcile(_intent, attempt) {
            return ++observations === 1
              ? { disposition: "indeterminate", reason: "not-observed" }
              : expired(attempt);
          },
        }),
      });
      await advanceSolanaSplSettlement(shared);
      clock += 101;
      await expect(advanceSolanaSplSettlement({ ...shared, owner: "worker-b" }))
        .resolves.toEqual({ status: "indeterminate", reason: "solana-spl-expiry-persistence-uncertain" });
      expect(prepareSignedTransfer).toHaveBeenCalledTimes(1);
      expect(broadcastRetained).toHaveBeenCalledTimes(1);
      expect(checkedPreflight).toHaveBeenCalledTimes(1);
    },
  );

  test("refuses resumed effects when a predecessor lacks complete expiry evidence", async () => {
    let clock = 1_000;
    let observations = 0;
    const memory = createInMemorySolanaSplSettlementStore();
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    const reconcile = vi.fn(async (_intent, attempt): Promise<SolanaSplReconciliation> => {
      observations += 1;
      if (observations === 2) return expired(attempt);
      return { disposition: "indeterminate", reason: "not-observed" };
    });
    const shared = input({
      store: memory, now: () => clock,
      adapter: adapter({ prepareSignedTransfer, broadcastRetained, reconcile }),
    });
    await advanceSolanaSplSettlement(shared);
    clock += 101;
    await advanceSolanaSplSettlement({ ...shared, owner: "worker-b" });
    expect(prepareSignedTransfer).toHaveBeenCalledTimes(2);
    clock += 101;
    await expect(advanceSolanaSplSettlement({
      ...shared, owner: "worker-c", store: legacyExpiryView(memory),
    })).resolves.toEqual({ status: "indeterminate", reason: "solana-spl-retained-state-corrupt" });
    expect(prepareSignedTransfer).toHaveBeenCalledTimes(2);
    expect(broadcastRetained).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenCalledTimes(3);
  });

  test("uses complete persisted expiry evidence after restart", async () => {
    let clock = 1_000;
    let preflights = 0;
    const counts = new Map<string, number>();
    const store = createInMemorySolanaSplSettlementStore();
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const reconcile = vi.fn(async (_intent, attempt) => {
      const count = (counts.get(attempt.signature) ?? 0) + 1;
      counts.set(attempt.signature, count);
      if (attempt.signature === SIGNATURE_1) {
        return count === 1
          ? { disposition: "indeterminate" as const, reason: "lost" }
          : expired(attempt);
      }
      return {
        disposition: "settled-same" as const,
        transfer: observed({ signature: SIGNATURE_2 }),
      };
    });
    const checkedPreflight = vi.fn(async (_intent, fence) => {
      await fence.assertCurrent();
      preflights += 1;
      if (preflights === 2) throw new Error("stop-after-expiry-persistence");
      return preflight();
    });
    const shared = input({
      store,
      adapter: adapter({
        preflight: checkedPreflight,
        prepareSignedTransfer,
        reconcile,
      }),
      now: () => clock,
    });

    await expect(advanceSolanaSplSettlement(shared)).resolves.toMatchObject({
      status: "indeterminate",
    });
    clock += 101;
    await expect(advanceSolanaSplSettlement({ ...shared, owner: "worker-b" }))
      .resolves.toEqual({
        status: "indeterminate",
        reason: "solana-spl-preflight-unavailable",
      });
    const persisted = await store.claim({
      intent: createSolanaSplSettlementIntent(authority()),
      owner: "observer",
      now: clock,
      leaseDurationMs: 100,
    });
    expect(persisted).toMatchObject({
      status: "waiting",
      expiredSignatures: [SIGNATURE_1],
      expiryEvidence: [{
        signature: SIGNATURE_1,
        observedBlockHeight: 10_002,
        commitmentLevel: "confirmed",
        authenticationHash: "e".repeat(64),
      }],
    });

    clock += 101;
    await expect(advanceSolanaSplSettlement({ ...shared, owner: "worker-c" }))
      .resolves.toMatchObject({
        status: "settled",
        settlement: { txRef: { signature: SIGNATURE_2 } },
      });
    expect(counts.get(SIGNATURE_1)).toBe(2);
    expect(prepareSignedTransfer.mock.calls.map((call) => call[1])).toEqual([1, 2]);
  });

  test.each(["unavailable", "inconsistent"] as const)(
    "legacy hash-only expiry is %s without new side effects",
    async (mode) => {
      let clock = 1_000;
      let preflights = 0;
      let reconciliations = 0;
      const memory = createInMemorySolanaSplSettlementStore();
      const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
      const broadcastRetained = vi.fn(adapter().broadcastRetained);
      const checkedPreflight = vi.fn(async (_intent, fence) => {
        await fence.assertCurrent();
        preflights += 1;
        if (preflights === 2) throw new Error("stop-after-expiry-persistence");
        return preflight();
      });
      const reconcile = vi.fn(async (_intent, attempt): Promise<SolanaSplReconciliation> => {
        reconciliations += 1;
        if (reconciliations === 1) {
          return { disposition: "indeterminate", reason: "lost" };
        }
        if (reconciliations === 2) return expired(attempt);
        if (mode === "unavailable") throw new Error("rpc-unavailable");
        return { disposition: "absent-expired", authenticationHash: "e".repeat(64) };
      });
      const shared = input({
        store: memory,
        adapter: adapter({
          preflight: checkedPreflight,
          prepareSignedTransfer,
          broadcastRetained,
          reconcile,
        }),
        now: () => clock,
      });

      await advanceSolanaSplSettlement(shared);
      clock += 101;
      await expect(advanceSolanaSplSettlement({ ...shared, owner: "worker-b" }))
        .resolves.toMatchObject({ status: "indeterminate" });
      clock += 101;
      await expect(advanceSolanaSplSettlement({
        ...shared,
        owner: "worker-c",
        store: legacyExpiryView(memory),
      })).resolves.toEqual({
        status: "indeterminate",
        reason: mode === "unavailable"
          ? "solana-spl-reconciliation-unavailable"
          : "solana-spl-expiry-proof-invalid",
      });
      expect(prepareSignedTransfer).toHaveBeenCalledTimes(1);
      expect(broadcastRetained).toHaveBeenCalledTimes(1);
    },
  );

  test("settlement wins when legacy hash-only expiry is reconciled as settled", async () => {
    let clock = 1_000;
    let preflights = 0;
    let reconciliations = 0;
    const memory = createInMemorySolanaSplSettlementStore();
    const recordSettlement = vi.spyOn(memory, "recordSettlement");
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    const checkedPreflight = vi.fn(async (_intent, fence) => {
      await fence.assertCurrent();
      preflights += 1;
      if (preflights === 2) throw new Error("stop-after-expiry-persistence");
      return preflight();
    });
    const reconcile = vi.fn(async (_intent, attempt): Promise<SolanaSplReconciliation> => {
      reconciliations += 1;
      if (reconciliations === 1) {
        return { disposition: "indeterminate", reason: "lost" };
      }
      if (reconciliations === 2) return expired(attempt);
      return {
        disposition: "settled-same",
        transfer: observed({ signature: attempt.signature }),
      };
    });
    const shared = input({
      store: memory,
      adapter: adapter({
        preflight: checkedPreflight,
        prepareSignedTransfer,
        broadcastRetained,
        reconcile,
      }),
      now: () => clock,
    });

    await advanceSolanaSplSettlement(shared);
    clock += 101;
    await advanceSolanaSplSettlement({ ...shared, owner: "worker-b" });
    clock += 101;
    await expect(advanceSolanaSplSettlement({
      ...shared,
      owner: "worker-c",
      store: legacyExpiryView(memory),
    })).resolves.toMatchObject({
      status: "settled",
      settlement: { txRef: { signature: SIGNATURE_1 } },
    });
    expect(recordSettlement).toHaveBeenCalledTimes(1);
    expect(prepareSignedTransfer).toHaveBeenCalledTimes(1);
    expect(broadcastRetained).toHaveBeenCalledTimes(1);
  });

  test("legacy hash-only absent-valid recovery retransmits only retained bytes", async () => {
    let clock = 1_000;
    let preflights = 0;
    let reconciliations = 0;
    const wires: string[] = [];
    const memory = createInMemorySolanaSplSettlementStore();
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const broadcastRetained = vi.fn(async (attempt) => {
      wires.push(attempt.signedTransactionBase64);
      return { disposition: "submitted" as const };
    });
    const checkedPreflight = vi.fn(async (_intent, fence) => {
      await fence.assertCurrent();
      preflights += 1;
      if (preflights === 2) throw new Error("stop-after-expiry-persistence");
      return preflight();
    });
    const reconcile = vi.fn(async (_intent, attempt): Promise<SolanaSplReconciliation> => {
      reconciliations += 1;
      if (reconciliations === 1) {
        return { disposition: "indeterminate", reason: "lost" };
      }
      if (reconciliations === 2) return expired(attempt);
      return { disposition: "absent-valid", authenticationHash: "d".repeat(64) };
    });
    const shared = input({
      store: memory,
      adapter: adapter({
        preflight: checkedPreflight,
        prepareSignedTransfer,
        broadcastRetained,
        reconcile,
      }),
      now: () => clock,
    });

    await advanceSolanaSplSettlement(shared);
    clock += 101;
    await advanceSolanaSplSettlement({ ...shared, owner: "worker-b" });
    clock += 101;
    await expect(advanceSolanaSplSettlement({
      ...shared,
      owner: "worker-c",
      store: legacyExpiryView(memory),
    })).resolves.toEqual({
      status: "waiting",
      reason: "solana-spl-broadcast-not-yet-visible",
    });
    expect(prepareSignedTransfer).toHaveBeenCalledTimes(1);
    expect(wires).toHaveLength(2);
    expect(new Set(wires).size).toBe(1);
  });

  test.each([
    ["instruction index", observed({ instructionIndex: 2 })],
    ["mint", observed({ mint: PAYEE_ATA })],
    ["amount", observed({ amountBaseUnits: "1250001" })],
    ["commitment", observed({ commitmentLevel: "processed" })],
    ["authentication", observed({ authenticationHash: "not-a-hash" })],
  ])("rejects a settled transfer with wrong %s", async (_name, transfer) => {
    await expect(advanceSolanaSplSettlement(input({
      adapter: adapter({
        reconcile: async () => ({ disposition: "settled-same", transfer }),
      }),
    }))).resolves.toEqual({
      status: "failed",
      errorClass: "permanent",
      reason: "solana-spl-settled-instruction-mismatch",
    });
  });

  test("a live lease prevents concurrent signing and broadcast", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const prepareSignedTransfer = vi.fn(async (plan, attempt, fence) => {
      await gate;
      return adapter().prepareSignedTransfer(plan, attempt, fence);
    });
    const shared = input({ adapter: adapter({ prepareSignedTransfer }) });
    const first = advanceSolanaSplSettlement(shared);
    await vi.waitFor(() => expect(prepareSignedTransfer).toHaveBeenCalledTimes(1));
    await expect(advanceSolanaSplSettlement({ ...shared, owner: "worker-b" }))
      .resolves.toEqual({ status: "waiting", reason: "solana-spl-settlement-held" });
    release();
    await expect(first).resolves.toMatchObject({ status: "settled" });
    expect(prepareSignedTransfer).toHaveBeenCalledTimes(1);
  });

  test("lease loss during preflight cannot become a stale permanent outcome", async () => {
    let clock = 1_000;
    const store = createInMemorySolanaSplSettlementStore();
    const recordAttempt = vi.spyOn(store, "recordAttempt");
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const broadcastRetained = vi.fn(adapter().broadcastRetained);

    const result = await advanceSolanaSplSettlement(input({
      store,
      now: () => clock,
      adapter: adapter({
        async preflight() {
          clock = 1_101;
          return preflight({ payerTokenBalanceBaseUnits: "0" });
        },
        prepareSignedTransfer,
        broadcastRetained,
      }),
    }));

    expect(result).toEqual({
      status: "indeterminate",
      reason: "solana-spl-preflight-unavailable",
    });
    expect(recordAttempt).not.toHaveBeenCalled();
    expect(prepareSignedTransfer).not.toHaveBeenCalled();
    expect(broadcastRetained).not.toHaveBeenCalled();
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid lease duration %s before durable or chain effects",
    async (leaseDurationMs) => {
      const base = createInMemorySolanaSplSettlementStore();
      const claim = vi.fn(base.claim);
      const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
      await expect(advanceSolanaSplSettlement(input({
        leaseDurationMs,
        store: { ...base, claim },
        adapter: adapter({ prepareSignedTransfer }),
      }))).resolves.toEqual({
        status: "indeterminate",
        reason: "solana-spl-runtime-policy-invalid",
      });
      expect(claim).not.toHaveBeenCalled();
      expect(prepareSignedTransfer).not.toHaveBeenCalled();
    },
  );

  test("rejects corrupted retained wire bytes before reconciliation or rebroadcast", async () => {
    let clock = 1_000;
    const base = createInMemorySolanaSplSettlementStore();
    const store: SolanaSplSettlementStore = {
      ...base,
      async claim(request) {
        const claim = await base.claim(request);
        if (claim.status !== "acquired" || claim.attempts.length === 0) return claim;
        return {
          ...claim,
          attempts: claim.attempts.map((attempt) => ({
            ...attempt,
            signedTransactionBase64: Buffer.from("substituted-wire").toString("base64"),
          })),
        };
      },
    };
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    const reconcile = vi.fn(async () => ({
      disposition: "indeterminate" as const,
      reason: "rpc-unavailable",
    }));
    const shared = input({
      store,
      adapter: adapter({ broadcastRetained, reconcile }),
      now: () => clock,
    });
    await expect(advanceSolanaSplSettlement(shared)).resolves.toMatchObject({
      status: "indeterminate",
    });
    clock += 101;
    await expect(advanceSolanaSplSettlement({ ...shared, owner: "worker-b" })).resolves.toEqual({
      status: "indeterminate",
      reason: "solana-spl-retained-state-corrupt",
    });
    expect(broadcastRetained).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  test("fails closed on invalid durable expiry evidence", async () => {
    let clock = 1_000;
    const base = createInMemorySolanaSplSettlementStore();
    const store: SolanaSplSettlementStore = {
      ...base,
      async claim(request) {
        const claim = await base.claim(request);
        if (claim.status !== "acquired" || claim.attempts.length === 0) return claim;
        const latest = claim.attempts.at(-1)!;
        return {
          ...claim,
          expiredSignatures: [latest.signature],
          expiryEvidence: [{
            signature: latest.signature,
            observedBlockHeight: latest.lastValidBlockHeight,
            commitmentLevel: "confirmed",
            authenticationHash: "e".repeat(64),
          }],
        };
      },
    };
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    const reconcile = vi.fn(async () => ({
      disposition: "indeterminate" as const,
      reason: "rpc-unavailable",
    }));
    const shared = input({
      store,
      adapter: adapter({ prepareSignedTransfer, broadcastRetained, reconcile }),
      now: () => clock,
    });

    await advanceSolanaSplSettlement(shared);
    clock += 101;
    await expect(advanceSolanaSplSettlement({ ...shared, owner: "worker-b" }))
      .resolves.toEqual({
        status: "indeterminate",
        reason: "solana-spl-retained-state-corrupt",
      });
    expect(prepareSignedTransfer).toHaveBeenCalledTimes(1);
    expect(broadcastRetained).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  test("does not rebroadcast on an unauthenticated absent-valid observation", async () => {
    let clock = 1_000;
    let reconciliations = 0;
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    const reconcile = vi.fn(async () => {
      reconciliations += 1;
      return reconciliations === 1
        ? { disposition: "indeterminate" as const, reason: "rpc-unavailable" }
        : { disposition: "absent-valid" as const, authenticationHash: "not-a-hash" };
    });
    const shared = input({
      adapter: adapter({ broadcastRetained, reconcile }),
      now: () => clock,
    });
    await advanceSolanaSplSettlement(shared);
    clock += 101;
    await expect(advanceSolanaSplSettlement({ ...shared, owner: "worker-b" })).resolves.toEqual({
      status: "indeterminate",
      reason: "solana-spl-absence-proof-invalid",
    });
    expect(broadcastRetained).toHaveBeenCalledTimes(1);
  });
});

describe("advanceSolanaSplSettlement without proof from the store", () => {
  // Leaves either a broadcast whose outcome is unknown or a settled phase in
  // the store, so a caller told "failed" could pay the same phase twice.
  async function retained(state: "broadcast" | "settled") {
    const store = createInMemorySolanaSplSettlementStore();
    const claim = vi.spyOn(store, "claim");
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    const settledSame: SolanaSplReconciliation = {
      disposition: "settled-same",
      transfer: observed(),
    };
    let observation: SolanaSplReconciliation = state === "settled"
      ? settledSame
      : { disposition: "indeterminate", reason: "rpc-unavailable" };
    const reconcile = vi.fn(async () => observation);
    const first = input({
      store,
      adapter: adapter({ prepareSignedTransfer, broadcastRetained, reconcile }),
    });
    await expect(advanceSolanaSplSettlement(first)).resolves.toMatchObject({
      status: state === "settled" ? "settled" : "indeterminate",
    });
    // The first lease has expired by then.
    const valid = { ...first, now: () => 2_000 };
    return {
      store,
      valid,
      effects: () => ({
        claim: claim.mock.calls.length,
        prepare: prepareSignedTransfer.mock.calls.length,
        broadcast: broadcastRetained.mock.calls.length,
        reconcile: reconcile.mock.calls.length,
      }),
      // Resumes with valid input and proves the retained signature still wins.
      async resume() {
        observation = settledSame;
        await expect(advanceSolanaSplSettlement({ ...valid, owner: "worker-b" }))
          .resolves.toMatchObject({
            status: "settled",
            settlement: { txRef: { signature: SIGNATURE_1 } },
          });
        expect(prepareSignedTransfer).toHaveBeenCalledTimes(1);
      },
    };
  }

  const refusals = [
    ["an empty owner", { owner: "" }, "solana-spl-runtime-policy-invalid"],
    ["a non-string owner", { owner: 7 as never }, "solana-spl-runtime-policy-invalid"],
    ["a zero lease duration", { leaseDurationMs: 0 }, "solana-spl-runtime-policy-invalid"],
    ["a fractional lease duration", { leaseDurationMs: 1.5 }, "solana-spl-runtime-policy-invalid"],
    ["an invalid amount", { authority: authority({ amount: "0" }) }, "solana-spl-authority-invalid"],
    ["an invalid payer", { authority: authority({ payer: "not_base58_0" }) }, "solana-spl-authority-invalid"],
  ] as const;

  test.each((["broadcast", "settled"] as const).flatMap((state) =>
    refusals.map(([name, override, reason]) => [state, name, override, reason] as const)))(
    "a retained %s is not reported as failed for %s",
    async (state, _name, override, reason) => {
      const settlement = await retained(state);
      const before = settlement.effects();
      await expect(advanceSolanaSplSettlement({ ...settlement.valid, ...override }))
        .resolves.toEqual({ status: "indeterminate", reason });
      expect(settlement.effects()).toEqual(before);
      await settlement.resume();
    },
  );

  const methods = [
    ["store", "claim"],
    ["store", "isCurrent"],
    ["store", "recordAttempt"],
    ["store", "markAttemptExpired"],
    ["store", "recordSettlement"],
    ["adapter", "preflight"],
    ["adapter", "prepareSignedTransfer"],
    ["adapter", "broadcastRetained"],
    ["adapter", "reconcile"],
  ] as const;

  test.each(methods.flatMap(([dependency, method]) =>
    [undefined, 42].map((value) => [dependency, method, value] as const)))(
    "%s.%s = %s returns a classified result before any effect",
    async (dependency, method, value) => {
      const memory = createInMemorySolanaSplSettlementStore();
      const claim = vi.fn(memory.claim);
      const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
      const broadcastRetained = vi.fn(adapter().broadcastRetained);
      const store = { ...memory, claim };
      const chain = adapter({ prepareSignedTransfer, broadcastRetained });
      await expect(advanceSolanaSplSettlement(input({
        store: (dependency === "store" ? { ...store, [method]: value } : store) as never,
        adapter: (dependency === "adapter" ? { ...chain, [method]: value } : chain) as never,
      }))).resolves.toEqual({
        status: "indeterminate",
        reason: "solana-spl-dependencies-invalid",
      });
      expect(claim).not.toHaveBeenCalled();
      expect(prepareSignedTransfer).not.toHaveBeenCalled();
      expect(broadcastRetained).not.toHaveBeenCalled();
    },
  );

  test.each(["store", "adapter"] as const)("a missing %s returns a classified result", async (name) => {
    await expect(advanceSolanaSplSettlement(input({ [name]: undefined as never })))
      .resolves.toEqual({ status: "indeterminate", reason: "solana-spl-dependencies-invalid" });
  });

  test("a missing method on resume leaves the retained broadcast to recover", async () => {
    const settlement = await retained("broadcast");
    const before = settlement.effects();
    await expect(advanceSolanaSplSettlement({
      ...settlement.valid,
      adapter: { ...adapter(), reconcile: undefined } as never,
    })).resolves.toEqual({ status: "indeterminate", reason: "solana-spl-dependencies-invalid" });
    expect(settlement.effects()).toEqual(before);
    await settlement.resume();
  });

  test("a conflicting binding over a retained broadcast is not reported as failed", async () => {
    const settlement = await retained("broadcast");
    const before = settlement.effects();
    await expect(advanceSolanaSplSettlement({
      ...settlement.valid,
      authority: authority({ amount: "2.5" }),
    })).resolves.toEqual({ status: "indeterminate", reason: "solana-spl-settlement-store-conflict" });
    expect(settlement.effects()).toEqual({ ...before, claim: before.claim + 1 });
    await settlement.resume();
  });

  test.each([
    ["corrupt", { status: "corrupt", reason: "store detail" }, "solana-spl-settlement-store-corrupt"],
    ["conflict", { status: "conflict", reason: "store detail" }, "solana-spl-settlement-store-conflict"],
    ["unknown", { status: "released", reason: "store detail" }, "solana-spl-settlement-store-claim-invalid"],
    ["null", null, "solana-spl-settlement-store-claim-invalid"],
    ["undefined", undefined, "solana-spl-settlement-store-claim-invalid"],
    ["string", "acquired", "solana-spl-settlement-store-claim-invalid"],
  ])("a %s claim is classified without any effect", async (_name, claimed, reason) => {
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    await expect(advanceSolanaSplSettlement(input({
      store: {
        ...createInMemorySolanaSplSettlementStore(),
        claim: async () => claimed as never,
      },
      adapter: adapter({ prepareSignedTransfer, broadcastRetained }),
    }))).resolves.toEqual({ status: "indeterminate", reason });
    expect(prepareSignedTransfer).not.toHaveBeenCalled();
    expect(broadcastRetained).not.toHaveBeenCalled();
  });
});

describe("advanceSolanaSplSettlement with a partial or malformed store claim", () => {
  type ClaimState = "acquired" | "waiting" | "settled";
  // Required fields of each claim status, per `SolanaSplStoreClaim`.
  const required: Record<ClaimState, string[]> = {
    acquired: ["status", "intent", "lease", "attempts", "expiredSignatures"],
    waiting: ["status", "intent", "lease", "attempts", "expiredSignatures"],
    settled: ["status", "intent", "settlement"],
  };
  const malformed: [ClaimState, string, unknown][] = [
    ...(["acquired", "waiting"] as const).flatMap((state) => [
      [state, "lease", null],
      [state, "lease", "worker-a"],
      [state, "attempts", {}],
      [state, "expiredSignatures", "none"],
      [state, "expiryEvidence", null],
      [state, "expiryEvidence", "none"],
    ] as [ClaimState, string, unknown][]),
    ["settled", "settlement", null],
    ["settled", "settlement", "settled"],
    ["acquired", "intent", null],
  ];

  // A real store response for the given status, rewritten by `edit`.
  async function claimWith(
    state: ClaimState,
    edit: (claim: Record<string, unknown>) => Record<string, unknown>,
  ) {
    const base = createInMemorySolanaSplSettlementStore();
    if (state === "settled") {
      await expect(advanceSolanaSplSettlement(input({ store: base })))
        .resolves.toMatchObject({ status: "settled" });
    }
    if (state === "waiting") {
      await base.claim({
        intent: createSolanaSplSettlementIntent(authority()),
        owner: "worker-x", now: 1_000, leaseDurationMs: 100,
      });
    }
    const checkedPreflight = vi.fn(adapter().preflight);
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    const reconcile = vi.fn(adapter().reconcile);
    const recordAttempt = vi.spyOn(base, "recordAttempt");
    const store: SolanaSplSettlementStore = {
      ...base,
      async claim(request) {
        const claim = await base.claim(request);
        expect(claim.status).toBe(state);
        return edit({ ...claim }) as never;
      },
    };
    const result = await advanceSolanaSplSettlement(input({
      store,
      adapter: adapter({
        preflight: checkedPreflight, prepareSignedTransfer, broadcastRetained, reconcile,
      }),
    }));
    return {
      result,
      effects: [checkedPreflight, prepareSignedTransfer, broadcastRetained, reconcile, recordAttempt]
        .map((spy) => spy.mock.calls.length),
    };
  }
  const invalid = {
    result: { status: "indeterminate", reason: "solana-spl-settlement-store-claim-invalid" },
    effects: [0, 0, 0, 0, 0],
  };

  test.each(Object.entries(required).flatMap(([state, fields]) =>
    fields.map((field) => [state as ClaimState, field] as const)))(
    "a %s claim without %s is classified without any effect",
    async (state, field) => {
      await expect(claimWith(state, (claim) => {
        delete claim[field];
        return claim;
      })).resolves.toEqual(invalid);
    },
  );

  test.each(Object.entries(required).flatMap(([state, fields]) =>
    [...fields, ...(state === "settled" ? [] : ["expiryEvidence"])]
      .map((field) => [state as ClaimState, field] as const)))(
    "a %s claim whose %s getter throws is classified without any effect",
    async (state, field) => {
      await expect(claimWith(state, (claim) => Object.defineProperty(claim, field, {
        get() { throw new Error("store secret=abc"); },
      }))).resolves.toEqual(invalid);
    },
  );

  test.each(malformed)("a %s claim with %s = %j is classified without any effect",
    async (state, field, value) => {
      await expect(claimWith(state, (claim) => ({ ...claim, [field]: value })))
        .resolves.toEqual(invalid);
    });

  test("a bare acquired claim is classified without any effect", async () => {
    await expect(claimWith("acquired", () => ({ status: "acquired" }))).resolves.toEqual(invalid);
  });

  test.each([
    ["acquired", { status: "settled", settlement: { txRef: { signature: SIGNATURE_1 } } }],
    ["waiting", { status: "waiting", reason: "solana-spl-settlement-held" }],
    ["settled", { status: "settled", settlement: { txRef: { signature: SIGNATURE_1 } } }],
  ] as const)("a complete %s claim is still accepted", async (state, expected) => {
    await expect(claimWith(state, (claim) => claim)).resolves.toMatchObject({ result: expected });
  });
});

describe("advanceSolanaSplSettlement with an out-of-contract reconciliation", () => {
  // A version-skewed adapter, a JS adapter or a JSON proxy cast to the type.
  const invalid: [string, unknown][] = [
    ["an unknown disposition", { disposition: "dropped" }],
    ["a future disposition", { disposition: "future-status" }],
    ["no disposition", {}],
    ["a string", "settled"],
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["a throwing disposition getter", Object.defineProperty({}, "disposition", {
      get() { throw new Error("adapter secret=abc"); },
    })],
  ];

  // Leaves attempt 1 retained and broadcast with an unknown outcome, then
  // resumes after the lease expired with the given reconciliation.
  async function resumeRetained(observations: unknown[]) {
    const store = createInMemorySolanaSplSettlementStore();
    const checkedPreflight = vi.fn(adapter().preflight);
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    const markAttemptExpired = vi.spyOn(store, "markAttemptExpired");
    let first = true;
    const reconcile = vi.fn(async () => {
      if (first) return { disposition: "indeterminate", reason: "rpc-unavailable" };
      return observations.shift();
    });
    const shared = input({
      store,
      adapter: adapter({
        preflight: checkedPreflight, prepareSignedTransfer, broadcastRetained,
        reconcile: reconcile as never,
      }),
    });
    await expect(advanceSolanaSplSettlement(shared)).resolves.toMatchObject({
      status: "indeterminate",
    });
    first = false;
    const result = await advanceSolanaSplSettlement({
      ...shared, owner: "worker-b", now: () => 2_000,
    });
    return {
      result,
      preflights: checkedPreflight.mock.calls.length,
      prepared: prepareSignedTransfer.mock.calls.map((call) => call[1]),
      broadcast: broadcastRetained.mock.calls.map((call) => call[0].signature),
      expiries: markAttemptExpired.mock.calls.length,
    };
  }

  test.each(invalid)("%s over a retained broadcast never signs a replacement", async (_name, value) => {
    await expect(resumeRetained([value])).resolves.toEqual({
      result: { status: "indeterminate", reason: "solana-spl-reconciliation-invalid" },
      preflights: 1,
      prepared: [1],
      broadcast: [SIGNATURE_1],
      expiries: 0,
    });
  });

  test.each(invalid)("%s after an authenticated rebroadcast stays indeterminate", async (_name, value) => {
    await expect(resumeRetained([
      { disposition: "absent-valid", authenticationHash: "d".repeat(64) },
      value,
    ])).resolves.toEqual({
      result: { status: "indeterminate", reason: "solana-spl-reconciliation-invalid" },
      preflights: 1,
      prepared: [1],
      broadcast: [SIGNATURE_1, SIGNATURE_1],
      expiries: 0,
    });
  });

  test.each(invalid)("%s after a fresh broadcast is classified", async (_name, value) => {
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    await expect(advanceSolanaSplSettlement(input({
      adapter: adapter({
        prepareSignedTransfer, broadcastRetained, reconcile: async () => value as never,
      }),
    }))).resolves.toEqual({ status: "indeterminate", reason: "solana-spl-reconciliation-invalid" });
    expect(prepareSignedTransfer).toHaveBeenCalledTimes(1);
    expect(broadcastRetained).toHaveBeenCalledTimes(1);
  });

  test("an absent-valid proof behind a throwing getter does not rebroadcast", async () => {
    await expect(resumeRetained([Object.defineProperty({ disposition: "absent-valid" },
      "authenticationHash", { get() { throw new Error("boom"); } })]))
      .resolves.toEqual({
        result: { status: "indeterminate", reason: "solana-spl-absence-proof-invalid" },
        preflights: 1,
        prepared: [1],
        broadcast: [SIGNATURE_1],
        expiries: 0,
      });
  });

  test("only durably acknowledged expiry of the retained attempt reaches a replacement", async () => {
    const run = await resumeRetained([
      expired({ signature: SIGNATURE_1, lastValidBlockHeight: 10_001 }),
      { disposition: "settled-same", transfer: observed({ signature: SIGNATURE_2 }) },
    ]);
    expect(run).toMatchObject({
      result: { status: "settled", settlement: { txRef: { signature: SIGNATURE_2 } } },
      prepared: [1, 2],
      broadcast: [SIGNATURE_1, SIGNATURE_2],
      expiries: 1,
    });
  });
});
