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
      }))).resolves.toMatchObject({ status: "failed", errorClass: "permanent" });
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
