import { types as nodeTypes } from "node:util";
import vm from "node:vm";

import { describe, expect, test, vi } from "vitest";

import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import {
  advanceSolanaSplSettlement,
  createInMemorySolanaSplSettlementStore,
  createSolanaSplSettlementIntent,
  solanaSplSettlementKey,
  type AdvanceSolanaSplSettlementInput,
  type SolanaSplAdapter,
  type SolanaSplExpiryEvidence,
  type SolanaSplObservedTransfer,
  type SolanaSplPreflight,
  type SolanaSplReconciliation,
  type SolanaSplSettlementAuthority,
  type SolanaSplSettlementStore,
  type SolanaSplSignedAttempt,
  type SolanaSplStoreClaim,
  type SolanaSplStoreWrite,
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

// The 64 bytes a fixed-width Base58 signature decodes to.
function signatureBytes(signature: string): Buffer {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const character of signature) value = value * 58n + BigInt(alphabet.indexOf(character));
  const bytes = Buffer.alloc(64);
  for (let index = 63; value > 0n; index -= 1) {
    bytes[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}
// Solana wire bytes: a compact-u16 signature count, the signatures, then a
// stand-in for the message.
function signedWire(signatures: readonly string[], message: string): string {
  return Buffer.concat([
    Buffer.from([signatures.length]),
    ...signatures.map(signatureBytes),
    Buffer.from(message, "utf8"),
  ]).toString("base64");
}

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

// Builds proxies that record every trap run on them, as the trap name plus the
// key for property traps. The handler is itself a proxy that routes every
// trap, defined or not, through the log.
type WatchedProxy = <T extends object>(target: T, handler?: ProxyHandler<T>) => T;
function trapLog(): { traps: string[]; proxy: WatchedProxy } {
  const traps: string[] = [];
  const proxy: WatchedProxy = (target, handler = {}) => new Proxy(target, new Proxy(handler, {
    get(inner, trap) {
      const run = (Reflect.get(inner, trap) ?? Reflect.get(Reflect, trap)) as
        (...args: unknown[]) => unknown;
      return (...args: unknown[]) => {
        const key = args[1];
        traps.push(typeof key === "string" || typeof key === "symbol"
          ? `${String(trap)} ${String(key)}`
          : String(trap));
        return run.apply(inner, args);
      };
    },
  }));
  return { traps, proxy };
}
// A proxy that an async store method resolves with is probed for `then` by
// the promise itself, as any resolved value is, before the core receives it.
const RESOLVED = ["get then"];

// Counts `Object.getOwnPropertyDescriptor` reads of each key of `objects`,
// including objects added later, until `restore`. An own data property can
// only be read without running store code through its descriptor, so this is
// how often the core read it.
function countDescriptorReads(objects: readonly object[]) {
  const counts = new Map<object, Record<string, number>>();
  const original = Object.getOwnPropertyDescriptor;
  const spy = vi.spyOn(Object, "getOwnPropertyDescriptor").mockImplementation((target, key) => {
    if (objects.includes(target)) {
      const seen = counts.get(target) ?? {};
      counts.set(target, seen);
      seen[String(key)] = (seen[String(key)] ?? 0) + 1;
    }
    return original(target, key);
  });
  return {
    reads: () => objects.map((value) => counts.get(value) ?? {}),
    restore: () => spy.mockRestore(),
  };
}
// The read counts expected of a store object: each own key exactly once.
const onceEach = (value: object) => Object.fromEntries(Object.keys(value).map((key) => [key, 1]));

function adapter(overrides: Partial<SolanaSplAdapter> = {}): SolanaSplAdapter {
  return {
    async preflight(_intent, fence) {
      await fence.assertCurrent();
      return preflight();
    },
    async prepareSignedTransfer(plan, attempt, fence) {
      await fence.assertCurrent();
      const signature = attempt === 1 ? SIGNATURE_1 : SIGNATURE_2;
      return {
        attemptVersion: "1",
        attempt,
        authorityHash: plan.intent.bindingHash,
        signature,
        signedTransactionBase64: signedWire([signature], `signed-wire-${attempt}`),
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

  // The core would otherwise broadcast one transaction and track another, so
  // proof that the tracked signature expired could authorize attempt 2 while
  // the broadcast bytes can still land.
  test.each([
    ["bytes that carry another signature", signedWire([SIGNATURE_2], "signed-wire-1")],
    ["bytes that carry the signature second", signedWire([SIGNATURE_2, SIGNATURE_1], "signed-wire-1")],
    ["bytes with no signature", signedWire([], "signed-wire-1")],
    ["bytes that end inside the signature", Buffer.concat([
      Buffer.from([1]), signatureBytes(SIGNATURE_1).subarray(0, 63),
    ]).toString("base64")],
    ["bytes that hold fewer signatures than they count", Buffer.concat([
      Buffer.from([2]), signatureBytes(SIGNATURE_1),
    ]).toString("base64")],
    ["bytes whose count never ends", Buffer.concat([
      Buffer.from([0x81, 0x80, 0x80]), signatureBytes(SIGNATURE_1),
    ]).toString("base64")],
    ["plain text", Buffer.from("signed-wire-1", "utf8").toString("base64")],
  ])("a prepared attempt with %s is refused before persistence", async (_name, wire) => {
    const store = createInMemorySolanaSplSettlementStore();
    const recordAttempt = vi.spyOn(store, "recordAttempt");
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    const result = await advanceSolanaSplSettlement(input({
      store,
      adapter: adapter({
        async prepareSignedTransfer(plan, attempt, fence) {
          return {
            ...(await adapter().prepareSignedTransfer(plan, attempt, fence)),
            signedTransactionBase64: wire,
          };
        },
        broadcastRetained,
      }),
    }));
    expect(result).toEqual({
      status: "indeterminate", reason: "solana-spl-prepared-transaction-invalid",
    });
    expect(recordAttempt).not.toHaveBeenCalled();
    expect(broadcastRetained).not.toHaveBeenCalled();
  });

  test("a prepared attempt whose bytes carry its signature first, then a co-signer's, settles", async () => {
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    await expect(advanceSolanaSplSettlement(input({
      adapter: adapter({
        async prepareSignedTransfer(plan, attempt, fence) {
          return {
            ...(await adapter().prepareSignedTransfer(plan, attempt, fence)),
            signedTransactionBase64: signedWire([SIGNATURE_1, SIGNATURE_2], "signed-wire-1"),
          };
        },
        broadcastRetained,
      }),
    }))).resolves.toMatchObject({ status: "settled", settlement: { txRef: { signature: SIGNATURE_1 } } });
    expect(broadcastRetained.mock.calls[0]?.[0].signedTransactionBase64)
      .toBe(signedWire([SIGNATURE_1, SIGNATURE_2], "signed-wire-1"));
  });

  test("a retained attempt whose bytes carry another signature is corrupt, never reconciled", async () => {
    let clock = 1_000;
    const base = createInMemorySolanaSplSettlementStore();
    const store: SolanaSplSettlementStore = {
      ...base,
      async claim(request) {
        const claim = await base.claim(request);
        if (claim.status !== "acquired" || claim.attempts.length === 0) return claim;
        return {
          ...claim,
          attempts: claim.attempts.map((attempt) => {
            const { attemptHash: _ignored, ...unsigned } = attempt;
            const swapped = { ...unsigned, signedTransactionBase64: signedWire([SIGNATURE_2], "signed-wire-1") };
            return { ...swapped, attemptHash: sha256Hex(canonicalize(swapped)) };
          }),
        };
      },
    };
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    const reconcile = vi.fn(async () => ({ disposition: "indeterminate" as const, reason: "lost" }));
    const shared = input({ store, adapter: adapter({ broadcastRetained, reconcile }), now: () => clock });
    await expect(advanceSolanaSplSettlement(shared)).resolves.toMatchObject({ status: "indeterminate" });
    clock += 101;
    await expect(advanceSolanaSplSettlement({ ...shared, owner: "worker-b" })).resolves.toEqual({
      status: "indeterminate", reason: "solana-spl-retained-state-corrupt",
    });
    expect(broadcastRetained).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
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
      reason: "solana-spl-reconciliation-indeterminate",
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

  // The retained signature landed, so funds may have moved: never a failure
  // a caller could pay the phase again after.
  test.each([
    ["instruction index", observed({ instructionIndex: 2 })],
    ["mint", observed({ mint: PAYEE_ATA })],
    ["amount", observed({ amountBaseUnits: "1250001" })],
    ["commitment", observed({ commitmentLevel: "processed" })],
    ["authentication", observed({ authenticationHash: "not-a-hash" })],
    ["stronger commitment", observed({ commitmentLevel: "finalized" })],
    ["upper-case authentication", observed({ authenticationHash: "C".repeat(64) })],
    ["missing transfer", undefined],
    ["transfer getter", Object.defineProperty(observed(), "mint", {
      get() { throw new Error("rpc secret=abc"); },
    })],
  ])("rejects a settled transfer with wrong %s", async (_name, transfer) => {
    const recordSettlement = vi.fn();
    await expect(advanceSolanaSplSettlement(input({
      store: { ...createInMemorySolanaSplSettlementStore(), recordSettlement },
      adapter: adapter({
        reconcile: async () => ({ disposition: "settled-same", transfer }) as never,
      }),
    }))).resolves.toEqual({
      status: "indeterminate",
      reason: "solana-spl-settled-instruction-mismatch",
    });
    expect(recordSettlement).not.toHaveBeenCalled();
  });

  test("a different landed transfer is indeterminate without adapter text", async () => {
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    await expect(advanceSolanaSplSettlement(input({
      adapter: adapter({
        prepareSignedTransfer,
        reconcile: async () => ({
          disposition: "settled-different",
          reason: "rpc said: token=sk_live_123",
          authenticationHash: "d".repeat(64),
        }),
      }),
    }))).resolves.toEqual({ status: "indeterminate", reason: "solana-spl-settled-different" });
    expect(prepareSignedTransfer).toHaveBeenCalledTimes(1);
  });

  test("a landed mismatch over a retained broadcast never signs a replacement", async () => {
    let clock = 1_000;
    let reconciliations = 0;
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    const reconcile = vi.fn(async (): Promise<SolanaSplReconciliation> => {
      reconciliations += 1;
      if (reconciliations === 1) return { disposition: "indeterminate", reason: "lost" };
      if (reconciliations === 2) {
        return { disposition: "settled-same", transfer: observed({ commitmentLevel: "finalized" }) };
      }
      return { disposition: "settled-different", reason: "other", authenticationHash: HASH };
    });
    const shared = input({
      adapter: adapter({ prepareSignedTransfer, broadcastRetained, reconcile }),
      now: () => clock,
    });
    await advanceSolanaSplSettlement(shared);
    for (const reason of [
      "solana-spl-settled-instruction-mismatch",
      "solana-spl-settled-different",
    ]) {
      clock += 101;
      await expect(advanceSolanaSplSettlement({ ...shared, owner: `worker-${clock}` }))
        .resolves.toEqual({ status: "indeterminate", reason });
    }
    expect(prepareSignedTransfer).toHaveBeenCalledTimes(1);
    expect(broadcastRetained).toHaveBeenCalledTimes(1);
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

  test.each(["store", "adapter", "now"] as const)(
    "a throwing %s getter returns a classified result before any effect",
    async (name) => {
      const memory = createInMemorySolanaSplSettlementStore();
      const claim = vi.fn(memory.claim);
      const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
      const request = Object.defineProperty(input({
        store: { ...memory, claim },
        adapter: adapter({ prepareSignedTransfer }),
      }), name, { get() { throw new Error("caller secret=abc"); } });
      await expect(advanceSolanaSplSettlement(request))
        .resolves.toEqual({ status: "indeterminate", reason: "solana-spl-dependencies-invalid" });
      expect(claim).not.toHaveBeenCalled();
      expect(prepareSignedTransfer).not.toHaveBeenCalled();
    },
  );

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
    ["conflict without its reason", { status: "conflict" }, "solana-spl-settlement-store-claim-invalid"],
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

  // Comparing the intent would canonicalize the object, running its code.
  test("a stored intent field that is an object is intent-invalid before any of its code runs", async () => {
    const reads = { count: 0 };
    const jobId = Object.defineProperty({}, "id", {
      enumerable: true,
      get: () => {
        reads.count += 1;
        return "job-solana-spl-1";
      },
    });
    await expect(claimWith("acquired", (claim) => ({
      ...claim, intent: { ...(claim.intent as object), jobId },
    }))).resolves.toEqual({
      result: { status: "indeterminate", reason: "solana-spl-settlement-store-intent-invalid" },
      effects: [0, 0, 0, 0, 0],
    });
    expect(reads.count).toBe(0);
  });

  test("a stored intent field that is a proxy is intent-invalid before any trap runs", async () => {
    const { traps, proxy } = trapLog();
    await expect(claimWith("settled", (claim) => ({
      ...claim, intent: { ...(claim.intent as object), amount: proxy({}) },
    }))).resolves.toEqual({
      result: { status: "indeterminate", reason: "solana-spl-settlement-store-intent-invalid" },
      effects: [0, 0, 0, 0, 0],
    });
    expect(traps).toEqual([]);
  });

  // A settled claim carrying acquired-claim fields is not a settled claim.
  test.each<[string, Record<string, unknown>]>([
    ["a lease", { lease: { owner: "worker-a", generation: 1, expiresAt: 1_100 } }],
    ["retained attempts", { attempts: [], expiredSignatures: [] }],
    ["a reason", { reason: "solana-spl-settlement-held" }],
  ])("a settled claim that also carries %s is classified without any effect", async (_name, extra) => {
    await expect(claimWith("settled", (claim) => ({ ...claim, ...extra }))).resolves.toEqual(invalid);
  });

  test.each([
    ["acquired", { status: "settled", settlement: { txRef: { signature: SIGNATURE_1 } } }],
    ["waiting", { status: "waiting", reason: "solana-spl-settlement-held" }],
    ["settled", { status: "settled", settlement: { txRef: { signature: SIGNATURE_1 } } }],
  ] as const)("a complete %s claim is still accepted", async (state, expected) => {
    await expect(claimWith(state, (claim) => claim)).resolves.toMatchObject({ result: expected });
  });

  test.each<[string, (claim: Record<string, unknown>, proxy: WatchedProxy) => Record<string, unknown>,
    string[]]>([
    ["the claim", (claim, proxy) => proxy(claim), RESOLVED],
    ["its intent", (claim, proxy) => ({ ...claim, intent: proxy({ ...(claim.intent as object) }) }), []],
    ["its lease", (claim, proxy) => ({ ...claim, lease: proxy({ ...(claim.lease as object) }) }), []],
  ])("a transparent proxy as %s is refused before the core runs any trap", async (_name, view, expected) => {
    const { traps, proxy } = trapLog();
    await expect(claimWith("acquired", (claim) => view(claim, proxy))).resolves.toEqual(invalid);
    expect(traps).toEqual(expected);
  });
});

describe("advanceSolanaSplSettlement failed closes the settlement key", () => {
  // A `failed` result lets the orchestrator pay the phase another way, so the
  // same key must never sign later, even after the payer tops up.
  const insufficient = {
    status: "failed", errorClass: "permanent", reason: "solana-spl-insufficient-token-balance",
  } as const;
  const ataMissing = {
    status: "failed", errorClass: "counterparty", reason: "solana-spl-payee-ata-missing",
  } as const;

  // A resume by another worker once the first lease has expired, with an
  // adapter that would now settle; returns its result and every effect count.
  async function resume(store: SolanaSplSettlementStore) {
    const effects = {
      preflight: vi.fn(adapter().preflight),
      prepareSignedTransfer: vi.fn(adapter().prepareSignedTransfer),
      broadcastRetained: vi.fn(adapter().broadcastRetained),
      reconcile: vi.fn(adapter().reconcile),
    };
    const result = await advanceSolanaSplSettlement(input({
      store, owner: "worker-b", now: () => 2_000, adapter: adapter(effects),
    }));
    return { result, calls: Object.values(effects).map((spy) => spy.mock.calls.length) };
  }

  test.each([
    ["a permanent", preflight({ payerTokenBalanceBaseUnits: "0" }), {}, insufficient],
    ["a counterparty", preflight({ payeeAtaExists: false }), {}, ataMissing],
  ] as const)("%s failure is recorded, and a topped-up resume returns it unsigned",
    async (_name, failing, overrides, expected) => {
      const store = createInMemorySolanaSplSettlementStore();
      const recordFailure = vi.spyOn(store, "recordFailure");
      const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
      await expect(advanceSolanaSplSettlement(input({
        store,
        authority: authority(overrides),
        adapter: adapter({ preflight: async () => failing, prepareSignedTransfer }),
      }))).resolves.toEqual(expected);
      expect(prepareSignedTransfer).not.toHaveBeenCalled();
      expect(recordFailure).toHaveBeenCalledTimes(1);
      expect(recordFailure.mock.calls[0]?.[0]).toMatchObject({
        owner: "worker-a", generation: 1,
        failure: { errorClass: expected.errorClass, reason: expected.reason },
      });
      // Twice, so the closed key also stays closed for the next caller.
      for (let round = 0; round < 2; round += 1) {
        await expect(resume(store)).resolves.toEqual({ result: expected, calls: [0, 0, 0, 0] });
      }
    });

  test("a failure after an expired attempt closes the key: the expired attempt is never replaced", async () => {
    let clock = 1_000;
    let balance = "5000000";
    const store = createInMemorySolanaSplSettlementStore();
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const broadcastRetained = vi.fn(async () => ({ disposition: "indeterminate" as const, reason: "lost" }));
    const reconcile = vi.fn(async (_intent: unknown, attempt: SolanaSplSignedAttempt) =>
      clock < 2_000
        ? { disposition: "indeterminate" as const, reason: "rpc-unavailable" }
        : expired(attempt));
    const shared = input({
      store,
      adapter: adapter({
        preflight: async () => preflight({ payerTokenBalanceBaseUnits: balance }),
        prepareSignedTransfer, broadcastRetained, reconcile,
      }),
      now: () => clock,
    });
    await expect(advanceSolanaSplSettlement(shared)).resolves.toMatchObject({ status: "indeterminate" });
    clock = 2_000;
    balance = "0";
    await expect(advanceSolanaSplSettlement({ ...shared, owner: "worker-b" })).resolves.toEqual(insufficient);
    clock = 3_000;
    balance = "5000000";
    const reconciled = reconcile.mock.calls.length;
    await expect(advanceSolanaSplSettlement({ ...shared, owner: "worker-c" })).resolves.toEqual(insufficient);
    expect(prepareSignedTransfer).toHaveBeenCalledTimes(1);
    expect(broadcastRetained).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(reconciled);
  });

  // Without the store's acknowledgement the key may still be open, so the
  // result must not tell the caller to pay another way.
  test.each<[string, (base: SolanaSplSettlementStore) => SolanaSplSettlementStore["recordFailure"]]>([
    ["unavailable", () => async () => { throw new Error("store down"); }],
    ["stale", () => async () => ({ status: "stale", reason: "stale-lease" })],
    ["a conflict", () => async () => ({ status: "conflict", reason: "other" })],
    ["a status-only result with an extra key", () => async () => ({ status: "recorded", note: 1 }) as never],
    ["an unknown status", () => async () => ({ status: "closed" }) as never],
    ["a proxy", (base) => async (request) => new Proxy(await base.recordFailure(request), {})],
  ])("a recordFailure that is %s is indeterminate, never failed", async (_name, write) => {
    const base = createInMemorySolanaSplSettlementStore();
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const result = await advanceSolanaSplSettlement(input({
      store: { ...base, recordFailure: write(base) },
      adapter: adapter({
        preflight: async () => preflight({ payerTokenBalanceBaseUnits: "0" }),
        prepareSignedTransfer,
      }),
    }));
    expect(result).toEqual({
      status: "indeterminate", reason: "solana-spl-failure-persistence-uncertain",
    });
    expect(prepareSignedTransfer).not.toHaveBeenCalled();
  });

  test("a failure whose lease was taken over before the close is never reported, and the key stays open", async () => {
    const base = createInMemorySolanaSplSettlementStore();
    // Worker B takes the expired lease between A's last fence check and A's close.
    const store: SolanaSplSettlementStore = {
      ...base,
      async recordFailure(request) {
        await expect(base.claim({ intent: createSolanaSplSettlementIntent(authority()),
          owner: "worker-b", now: 2_000, leaseDurationMs: 100 })).resolves.toMatchObject({
          status: "acquired", lease: { generation: 2 },
        });
        return base.recordFailure(request);
      },
    };
    const result = await advanceSolanaSplSettlement(input({
      store,
      adapter: adapter({ preflight: async () => preflight({ payerTokenBalanceBaseUnits: "0" }) }),
    }));
    expect(result).toEqual({
      status: "indeterminate", reason: "solana-spl-failure-persistence-uncertain",
    });
    await expect(advanceSolanaSplSettlement(input({
      store: base, owner: "worker-c", now: () => 3_000,
    }))).resolves.toMatchObject({ status: "settled" });
  });

  test("a store without recordFailure is refused before any claim", async () => {
    const { recordFailure: _omitted, ...base } = createInMemorySolanaSplSettlementStore();
    const claim = vi.spyOn(base, "claim");
    await expect(advanceSolanaSplSettlement(input({ store: base as never }))).resolves.toEqual({
      status: "indeterminate", reason: "solana-spl-dependencies-invalid",
    });
    expect(claim).not.toHaveBeenCalled();
  });

  test("the in-memory store refuses every later write on a closed key, and closes only expired keys", async () => {
    const store = createInMemorySolanaSplSettlementStore();
    const intent = createSolanaSplSettlementIntent(authority());
    const claimed = await store.claim({ intent, owner: "worker-a", now: 1_000, leaseDurationMs: 100 });
    expect(claimed.status).toBe("acquired");
    const fence = {
      settlementKey: intent.settlementKey, bindingHash: intent.bindingHash,
      owner: "worker-a", generation: 1,
    };
    const prepared = await adapter().prepareSignedTransfer(
      { intent } as never, 1, { assertCurrent: async () => undefined } as never);
    const unsigned = { ...prepared };
    const attempt = { ...unsigned, attemptHash: sha256Hex(canonicalize(unsigned)) };
    await expect(store.recordAttempt({ ...fence, attempt })).resolves.toEqual({ status: "recorded" });
    const failure = { errorClass: "permanent", reason: "solana-spl-insufficient-token-balance" } as const;
    // Attempt 1 has no expiry evidence yet, so it may still land.
    await expect(store.recordFailure({ ...fence, failure })).resolves.toMatchObject({ status: "conflict" });
    await expect(store.markAttemptExpired({
      ...fence, signature: SIGNATURE_1, observedBlockHeight: 10_002,
      commitmentLevel: "confirmed", authenticationHash: "e".repeat(64),
    })).resolves.toMatchObject({ status: "recorded" });
    await expect(store.recordFailure({ ...fence, failure })).resolves.toEqual({ status: "recorded" });
    await expect(store.recordFailure({ ...fence, failure })).resolves.toEqual({ status: "existing" });
    await expect(store.recordFailure({
      ...fence, failure: { errorClass: "counterparty", reason: "solana-spl-payee-ata-missing" },
    })).resolves.toMatchObject({ status: "conflict" });
    await expect(store.isCurrent({ ...fence, now: 1_001 })).resolves.toBe(false);
    await expect(store.recordAttempt({ ...fence, attempt: { ...attempt, attempt: 2 } }))
      .resolves.toMatchObject({ status: "conflict" });
    await expect(store.recordSettlement({
      ...fence, signature: SIGNATURE_1, settlement: {} as never,
    })).resolves.toMatchObject({ status: "conflict" });
    await expect(store.claim({ intent, owner: "worker-b", now: 1_001, leaseDurationMs: 100 }))
      .resolves.toEqual({ status: "failed", intent, failure });
  });
});

describe("advanceSolanaSplSettlement with a stored failed claim", () => {
  const failure = { errorClass: "permanent", reason: "solana-spl-insufficient-network-fee-balance" };
  const invalid = { status: "indeterminate", reason: "solana-spl-settlement-store-claim-invalid" };

  // Resumes against a store whose claim is `claim(intent)`; nothing else may run.
  async function failedWith(claim: (intent: unknown) => unknown) {
    const effects = {
      preflight: vi.fn(adapter().preflight),
      prepareSignedTransfer: vi.fn(adapter().prepareSignedTransfer),
      broadcastRetained: vi.fn(adapter().broadcastRetained),
      reconcile: vi.fn(adapter().reconcile),
    };
    const base = createInMemorySolanaSplSettlementStore();
    const writes = [
      vi.spyOn(base, "recordAttempt"), vi.spyOn(base, "markAttemptExpired"),
      vi.spyOn(base, "recordSettlement"), vi.spyOn(base, "recordFailure"),
    ];
    const result = await advanceSolanaSplSettlement(input({
      store: { ...base, claim: async (request) => claim(request.intent) as never },
      adapter: adapter(effects),
    }));
    expect([...Object.values(effects), ...writes].map((spy) => spy.mock.calls.length))
      .toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    return result;
  }

  test.each([
    ["plain", (value: object) => ({ ...value })],
    ["null-prototype", (value: object) => Object.assign(Object.create(null) as object, value)],
  ])("a %s failed claim returns its failure without any effect", async (_name, make) => {
    await expect(failedWith((intent) => make({ status: "failed", intent, failure: make(failure) })))
      .resolves.toEqual({ status: "failed", ...failure });
  });

  test.each<[string, (intent: unknown) => unknown, unknown]>([
    ["an extra claim key", (intent) => ({ status: "failed", intent, failure, attempts: [] }), invalid],
    ["no failure", (intent) => ({ status: "failed", intent }), invalid],
    ["no intent", () => ({ status: "failed", failure }), invalid],
    ["a failure with an extra key", (intent) => ({
      status: "failed", intent, failure: { ...failure, detail: "rpc" },
    }), invalid],
    ["a failure without errorClass", (intent) => ({
      status: "failed", intent, failure: { reason: failure.reason },
    }), invalid],
    ["a failure accessor", (intent) => Object.defineProperty({ status: "failed", intent }, "failure", {
      enumerable: true, get: () => failure,
    }), invalid],
    ["a proxy failure", (intent) => ({ status: "failed", intent, failure: new Proxy(failure, {}) }), invalid],
    ["a failure with a class prototype", (intent) => ({
      status: "failed", intent, failure: Object.assign(Object.create({ extra: 1 }) as object, failure),
    }), invalid],
    ["an unknown reason", (intent) => ({
      status: "failed", intent, failure: { errorClass: "permanent", reason: "solana-spl-preflight-invalid" },
    }), invalid],
    ["a reason of the other class", (intent) => ({
      status: "failed", intent, failure: { errorClass: "counterparty", reason: failure.reason },
    }), invalid],
    ["a reason that is not a string", (intent) => ({
      status: "failed", intent, failure: { errorClass: "permanent", reason: ["solana-spl-insufficient-token-balance"] },
    }), invalid],
    ["an inherited reason", (intent) => ({
      status: "failed", intent, failure: { errorClass: "permanent", reason: "constructor" },
    }), invalid],
    ["another binding's intent", (intent) => ({
      status: "failed", intent: { ...(intent as object), amount: "2" }, failure,
    }), { status: "indeterminate", reason: "solana-spl-settlement-store-intent-mismatch" }],
  ])("a failed claim with %s is refused without any effect", async (_name, claim, expected) => {
    await expect(failedWith(claim)).resolves.toEqual(expected);
  });
});

describe("advanceSolanaSplSettlement uncertain paths are never failed", () => {
  // Each path leaves a recorded transfer that may still land, or a store the
  // core cannot read. A `failed` result here would close the key and let the
  // caller pay the phase another way while the transfer lands: a double
  // payment. So each is pinned to its exact code.
  const lost = { disposition: "indeterminate", reason: "lost" } as const;

  test("a broadcast that fails after the attempt was recorded is broadcast-unavailable, and the resume reuses it", async () => {
    let clock = 1_000;
    const store = createInMemorySolanaSplSettlementStore();
    const order: string[] = [];
    const recordAttempt = vi.fn(async (request: Parameters<typeof store.recordAttempt>[0]) => {
      order.push("record");
      return store.recordAttempt(request);
    });
    const recordFailure = vi.spyOn(store, "recordFailure");
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    let broadcasts = 0;
    const broadcastRetained = vi.fn(async (attempt: SolanaSplSignedAttempt, fence: never) => {
      order.push("broadcast");
      broadcasts += 1;
      if (broadcasts === 1) throw new Error("rpc timeout after send");
      return adapter().broadcastRetained(attempt, fence);
    });
    const reconcile = vi.fn(adapter().reconcile);
    const shared = input({
      store: { ...store, recordAttempt },
      adapter: adapter({ prepareSignedTransfer, broadcastRetained, reconcile }),
      now: () => clock,
    });
    const result = await advanceSolanaSplSettlement(shared);
    expect(result).toEqual({ status: "indeterminate", reason: "solana-spl-broadcast-unavailable" });
    expect(result.status).not.toBe("failed");
    expect(order).toEqual(["record", "broadcast"]);
    expect(reconcile).not.toHaveBeenCalled();
    expect(recordFailure).not.toHaveBeenCalled();
    clock += 101;
    await expect(advanceSolanaSplSettlement({ ...shared, owner: "worker-b" }))
      .resolves.toMatchObject({ status: "settled", settlement: { txRef: { signature: SIGNATURE_1 } } });
    expect(prepareSignedTransfer).toHaveBeenCalledTimes(1);
  });

  test("a rebroadcast that fails is rebroadcast-unavailable, never re-signed", async () => {
    let clock = 1_000;
    const store = createInMemorySolanaSplSettlementStore();
    const recordFailure = vi.spyOn(store, "recordFailure");
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const broadcastRetained = vi.fn(async (attempt: SolanaSplSignedAttempt, fence: never) => {
      if (broadcastRetained.mock.calls.length > 1) throw new Error("rpc down");
      return adapter().broadcastRetained(attempt, fence);
    });
    const reconcile = vi.fn(async (): Promise<SolanaSplReconciliation> =>
      reconcile.mock.calls.length === 1 ? lost : { disposition: "absent-valid", authenticationHash: "d".repeat(64) });
    const shared = input({
      store,
      adapter: adapter({ prepareSignedTransfer, broadcastRetained, reconcile }),
      now: () => clock,
    });
    await expect(advanceSolanaSplSettlement(shared)).resolves.toEqual({
      status: "indeterminate", reason: "solana-spl-reconciliation-indeterminate",
    });
    clock += 101;
    const result = await advanceSolanaSplSettlement({ ...shared, owner: "worker-b" });
    expect(result).toEqual({ status: "indeterminate", reason: "solana-spl-rebroadcast-unavailable" });
    expect(result.status).not.toBe("failed");
    expect(broadcastRetained).toHaveBeenCalledTimes(2);
    expect(prepareSignedTransfer).toHaveBeenCalledTimes(1);
    expect(recordFailure).not.toHaveBeenCalled();
  });

  test.each<[string, SolanaSplSettlementStore["claim"], (() => number) | undefined]>([
    ["a claim that throws", async () => { throw new Error("store down"); }, undefined],
    ["a claim that rejects with a string", () => Promise.reject("store down"), undefined],
    ["a clock that throws", async () => { throw new Error("unreached"); }, () => { throw new Error("clock"); }],
  ])("%s is settlement-store-unavailable without any effect", async (_name, claim, now) => {
    const base = createInMemorySolanaSplSettlementStore();
    const effects = [
      vi.fn(adapter().preflight), vi.fn(adapter().prepareSignedTransfer),
      vi.fn(adapter().broadcastRetained), vi.fn(adapter().reconcile),
    ] as const;
    const result = await advanceSolanaSplSettlement(input({
      store: { ...base, claim },
      adapter: adapter({
        preflight: effects[0], prepareSignedTransfer: effects[1],
        broadcastRetained: effects[2], reconcile: effects[3],
      }),
      ...(now ? { now } : {}),
    }));
    expect(result).toEqual({ status: "indeterminate", reason: "solana-spl-settlement-store-unavailable" });
    expect(result.status).not.toBe("failed");
    expect(effects.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0]);
  });

  test.each<[string, Record<string, unknown>]>([
    ["another owner", { owner: "worker-x" }],
    ["generation 0", { generation: 0 }],
    ["a string generation", { generation: "1" }],
    ["a fractional generation", { generation: 1.5 }],
    ["an expiry equal to now", { expiresAt: 1_000 }],
    ["an expiry before now", { expiresAt: 999 }],
    ["a string expiry", { expiresAt: "1100" }],
  ])("a lease with %s is settlement-store-lease-invalid without any effect", async (_name, lease) => {
    const base = createInMemorySolanaSplSettlementStore();
    const effects = [
      vi.fn(adapter().preflight), vi.fn(adapter().prepareSignedTransfer),
      vi.fn(adapter().broadcastRetained), vi.fn(adapter().reconcile),
      vi.spyOn(base, "recordAttempt"), vi.spyOn(base, "recordFailure"),
    ] as const;
    const result = await advanceSolanaSplSettlement(input({
      store: {
        ...base,
        async claim(request) {
          const claim = await base.claim(request);
          return claim.status === "acquired" ? { ...claim, lease: { ...claim.lease, ...lease } } as never : claim;
        },
      },
      adapter: adapter({
        preflight: effects[0], prepareSignedTransfer: effects[1],
        broadcastRetained: effects[2], reconcile: effects[3],
      }),
    }));
    expect(result).toEqual({ status: "indeterminate", reason: "solana-spl-settlement-store-lease-invalid" });
    expect(result.status).not.toBe("failed");
    expect(effects.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  test("a new attempt that expires before it is observed is indeterminate, never replaced in the same call", async () => {
    const store = createInMemorySolanaSplSettlementStore();
    const markAttemptExpired = vi.spyOn(store, "markAttemptExpired");
    const recordFailure = vi.spyOn(store, "recordFailure");
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    const result = await advanceSolanaSplSettlement(input({
      store,
      adapter: adapter({
        prepareSignedTransfer,
        broadcastRetained,
        reconcile: async (_intent, attempt) => expired(attempt),
      }),
    }));
    expect(result).toEqual({
      status: "indeterminate", reason: "solana-spl-new-attempt-expired-before-observation",
    });
    expect(result.status).not.toBe("failed");
    expect(prepareSignedTransfer).toHaveBeenCalledTimes(1);
    expect(broadcastRetained).toHaveBeenCalledTimes(1);
    expect(markAttemptExpired).not.toHaveBeenCalled();
    expect(recordFailure).not.toHaveBeenCalled();
  });

  // After a rebroadcast the attempt is observed expired: the core records
  // the expiry (so the next call need not reconcile it again) but never
  // replaces it in the same call.
  test("an attempt that expires after its rebroadcast has its expiry recorded, and only the next call signs attempt 2", async () => {
    let clock = 1_000;
    const store = createInMemorySolanaSplSettlementStore();
    const markAttemptExpired = vi.spyOn(store, "markAttemptExpired");
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    const firstAttemptAnswers: SolanaSplReconciliation[] = [
      lost,
      { disposition: "absent-valid", authenticationHash: "d".repeat(64) },
      expired({ signature: SIGNATURE_1, lastValidBlockHeight: 10_001 }),
    ];
    const reconcile = vi.fn(async (_intent: unknown, attempt: SolanaSplSignedAttempt) =>
      attempt.attempt === 1
        ? firstAttemptAnswers.shift() ?? expired(attempt)
        : { disposition: "settled-same" as const, transfer: observed({ signature: attempt.signature }) });
    const shared = input({
      store,
      adapter: adapter({ prepareSignedTransfer, broadcastRetained, reconcile }),
      now: () => clock,
    });
    await advanceSolanaSplSettlement(shared);
    clock = 2_000;
    const result = await advanceSolanaSplSettlement({ ...shared, owner: "worker-b" });
    expect(result).toEqual({ status: "indeterminate", reason: "solana-spl-expiry-transition-raced" });
    expect(result.status).not.toBe("failed");
    expect(markAttemptExpired).toHaveBeenCalledTimes(1);
    expect(markAttemptExpired.mock.calls[0]?.[0]).toMatchObject({
      signature: SIGNATURE_1, observedBlockHeight: 10_002, commitmentLevel: "confirmed",
    });
    expect(prepareSignedTransfer).toHaveBeenCalledTimes(1);
    clock = 3_000;
    await expect(advanceSolanaSplSettlement({ ...shared, owner: "worker-c" }))
      .resolves.toMatchObject({ status: "settled", settlement: { txRef: { signature: SIGNATURE_2 } } });
    // Attempt 1 was not reconciled again: its recorded expiry was the authority.
    expect(reconcile.mock.calls.filter(([, attempt]) => attempt.attempt === 1)).toHaveLength(3);
    expect(markAttemptExpired).toHaveBeenCalledTimes(1);
    expect(prepareSignedTransfer).toHaveBeenCalledTimes(2);
  });

  test("an expiry write after a rebroadcast that is not acknowledged is expiry-persistence-uncertain", async () => {
    let clock = 1_000;
    const base = createInMemorySolanaSplSettlementStore();
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const answers: SolanaSplReconciliation[] = [
      lost,
      { disposition: "absent-valid", authenticationHash: "d".repeat(64) },
      expired({ signature: SIGNATURE_1, lastValidBlockHeight: 10_001 }),
    ];
    const shared = input({
      store: { ...base, markAttemptExpired: async () => ({ status: "stale", reason: "stale-lease" }) },
      adapter: adapter({ prepareSignedTransfer, reconcile: async () => answers.shift() ?? lost }),
      now: () => clock,
    });
    await advanceSolanaSplSettlement(shared);
    clock = 2_000;
    const result = await advanceSolanaSplSettlement({ ...shared, owner: "worker-b" });
    expect(result).toEqual({ status: "indeterminate", reason: "solana-spl-expiry-persistence-uncertain" });
    expect(result.status).not.toBe("failed");
    expect(prepareSignedTransfer).toHaveBeenCalledTimes(1);
  });
});

describe("advanceSolanaSplSettlement reason codes", () => {
  const SECRET = "secret=abc";
  const leaks = (result: unknown) => JSON.stringify(result).includes(SECRET);
  const throwing = (field: string) => Object.defineProperty(preflight(), field, {
    get() { throw new Error(`preflight ${SECRET}`); },
  });

  test.each([
    ["a throwing preflight getter", () => throwing("payerTokenAccount")],
    ["a null preflight", () => null],
    ["a non-canonical balance", () => preflight({ payerTokenBalanceBaseUnits: `01 ${SECRET}` })],
    ["a non-base58 token account", () => preflight({ payerTokenAccount: SECRET })],
  ])("%s is a fixed preflight code before signing", async (_name, value) => {
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const result = await advanceSolanaSplSettlement(input({
      adapter: adapter({ preflight: async () => value() as never, prepareSignedTransfer }),
    }));
    expect(result).toEqual({ status: "indeterminate", reason: "solana-spl-preflight-invalid" });
    expect(leaks(result)).toBe(false);
    expect(prepareSignedTransfer).not.toHaveBeenCalled();
  });

  test.each<[string, Record<string, unknown>, Partial<SolanaSplSettlementAuthority>]>([
    // Checked as 2039280 lamports, converted to 0 for the balance check.
    ["a rent reserve that prints as one amount and converts to another", {
      payeeAtaExists: false,
      payerNativeBalanceLamports: "6000",
      ataRentExemptReserveLamports: {
        [Symbol.toPrimitive]: (hint: string) => (hint === "number" ? "0" : "2039280"),
      },
    }, { createPayeeAtaIfMissing: true }],
    ["a payee account flag that is the string \"false\"", { payeeAtaExists: "false" }, {}],
    // What `connection.getBalance()`-style code returns; it used to be coerced.
    ["a network fee that is a number", { networkFeeLamports: 5000 }, {}],
  ])("%s is never coerced: a fixed preflight code before signing", async (_name, fields, overrides) => {
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const result = await advanceSolanaSplSettlement(input({
      authority: authority(overrides),
      adapter: adapter({
        preflight: async () => ({ ...preflight(), ...fields }) as never,
        prepareSignedTransfer,
      }),
    }));
    expect(result).toEqual({ status: "indeterminate", reason: "solana-spl-preflight-invalid" });
    expect(prepareSignedTransfer).not.toHaveBeenCalled();
  });

  // An adapter bug is not a chain refusal: it is never `failed`, so it never
  // tells a caller to pay another way, and it leaves the key open.
  test("numeric preflight balances are an adapter fault: unsigned, never failed, key left open", async () => {
    const store = createInMemorySolanaSplSettlementStore();
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    const result = await advanceSolanaSplSettlement(input({
      store,
      adapter: adapter({
        preflight: async () => ({
          ...preflight(),
          payerTokenBalanceBaseUnits: 5_000_000,
          payerNativeBalanceLamports: 10_000_000,
        }) as never,
        prepareSignedTransfer,
        broadcastRetained,
      }),
    }));
    expect(result).toEqual({ status: "indeterminate", reason: "solana-spl-preflight-invalid" });
    expect(result.status).not.toBe("failed");
    expect(prepareSignedTransfer).not.toHaveBeenCalled();
    expect(broadcastRetained).not.toHaveBeenCalled();
    // The fixed adapter can still settle the same key once the lease expires.
    await expect(advanceSolanaSplSettlement(input({
      store, owner: "worker-b", now: () => 2_000,
      adapter: adapter({ prepareSignedTransfer }),
    }))).resolves.toMatchObject({ status: "settled" });
    expect(prepareSignedTransfer).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["a throwing signer", async () => { throw new Error(`signer key ${SECRET}`); },
      "solana-spl-preparation-unavailable"],
    ["a signer rejecting with a string", async () => { throw `signer ${SECRET}`; },
      "solana-spl-preparation-unavailable"],
    ["a signer returning null", async () => null,
      "solana-spl-prepared-transaction-invalid"],
    ["a signer returning another binding", async (plan: never, attempt: number) => ({
      ...(await adapter().prepareSignedTransfer(plan, attempt, {
        assertCurrent: async () => undefined,
      } as never)),
      authorityHash: SECRET,
    }), "solana-spl-prepared-transaction-invalid"],
  ] as const)("%s is a fixed code and never broadcasts", async (_name, prepare, reason) => {
    const recordAttempt = vi.fn();
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    const result = await advanceSolanaSplSettlement(input({
      store: { ...createInMemorySolanaSplSettlementStore(), recordAttempt },
      adapter: adapter({ prepareSignedTransfer: prepare as never, broadcastRetained }),
    }));
    expect(result).toEqual({ status: "indeterminate", reason });
    expect(leaks(result)).toBe(false);
    expect(recordAttempt).not.toHaveBeenCalled();
    expect(broadcastRetained).not.toHaveBeenCalled();
  });

  test("a stale fence after signing is a fixed code and never persists", async () => {
    let clock = 1_000;
    const recordAttempt = vi.fn();
    const result = await advanceSolanaSplSettlement(input({
      now: () => clock,
      store: { ...createInMemorySolanaSplSettlementStore(), recordAttempt },
      adapter: adapter({
        async prepareSignedTransfer(plan, attempt, fence) {
          const prepared = await adapter().prepareSignedTransfer(plan, attempt, fence);
          clock = 1_101;
          return prepared;
        },
      }),
    }));
    expect(result).toEqual({ status: "indeterminate", reason: "solana-spl-preparation-unavailable" });
    expect(recordAttempt).not.toHaveBeenCalled();
  });

  test.each([
    [{ disposition: "pending", reason: `rpc body ${SECRET}` },
      { status: "waiting", reason: "solana-spl-reconciliation-pending" }],
    [{ disposition: "indeterminate", reason: `https://user:${SECRET}@rpc` },
      { status: "indeterminate", reason: "solana-spl-reconciliation-indeterminate" }],
    [{ disposition: "settled-different", reason: `rpc ${SECRET}`, authenticationHash: HASH },
      { status: "indeterminate", reason: "solana-spl-settled-different" }],
  ] as const)("reconciliation %j is reported by a fixed code", async (observation, expected) => {
    const result = await advanceSolanaSplSettlement(input({
      adapter: adapter({ reconcile: async () => observation }),
    }));
    expect(result).toEqual(expected);
    expect(leaks(result)).toBe(false);
  });
});

describe("advanceSolanaSplSettlement with a malformed store write", () => {
  const throwingStatus = () => Object.defineProperty({}, "status", {
    get() { throw new Error("store secret=abc"); },
  });
  const writes: [string, () => unknown][] = [
    ["undefined", () => undefined],
    ["null", () => null],
    ["a string", () => "recorded"],
    ["an object without status", () => ({})],
    ["a throwing status getter", throwingStatus],
  ];

  test.each(writes)("recordSettlement resolving %s after the transfer landed is uncertain",
    async (_name, write) => {
      const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
      const broadcastRetained = vi.fn(adapter().broadcastRetained);
      await expect(advanceSolanaSplSettlement(input({
        store: {
          ...createInMemorySolanaSplSettlementStore(),
          recordSettlement: async () => write() as never,
        },
        adapter: adapter({ prepareSignedTransfer, broadcastRetained }),
      }))).resolves.toEqual({
        status: "indeterminate",
        reason: "solana-spl-settlement-persistence-uncertain",
      });
      expect(prepareSignedTransfer).toHaveBeenCalledTimes(1);
      expect(broadcastRetained).toHaveBeenCalledTimes(1);
    });

  test.each(writes)("recordAttempt resolving %s never broadcasts", async (_name, write) => {
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    await expect(advanceSolanaSplSettlement(input({
      store: {
        ...createInMemorySolanaSplSettlementStore(),
        recordAttempt: async () => write() as never,
      },
      adapter: adapter({ prepareSignedTransfer, broadcastRetained }),
    }))).resolves.toEqual({
      status: "indeterminate",
      reason: "solana-spl-retained-attempt-persistence-uncertain",
    });
    expect(prepareSignedTransfer).toHaveBeenCalledTimes(1);
    expect(broadcastRetained).not.toHaveBeenCalled();
  });

  test.each([
    ...writes,
    ["a throwing evidence getter", () => Object.defineProperty({ status: "recorded" },
      "expiryEvidence", { get() { throw new Error("store secret=abc"); } })],
  ] as [string, () => unknown][])(
    "markAttemptExpired resolving %s never reaches a replacement",
    async (_name, write) => {
      let clock = 1_000;
      let reconciliations = 0;
      const memory = createInMemorySolanaSplSettlementStore();
      const checkedPreflight = vi.fn(adapter().preflight);
      const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
      const broadcastRetained = vi.fn(adapter().broadcastRetained);
      const shared = input({
        store: { ...memory, markAttemptExpired: async () => write() as never },
        now: () => clock,
        adapter: adapter({
          preflight: checkedPreflight, prepareSignedTransfer, broadcastRetained,
          async reconcile(_intent, attempt) {
            return ++reconciliations === 1
              ? { disposition: "indeterminate", reason: "lost" }
              : expired(attempt);
          },
        }),
      });
      await advanceSolanaSplSettlement(shared);
      clock += 101;
      await expect(advanceSolanaSplSettlement({ ...shared, owner: "worker-b" }))
        .resolves.toEqual({ status: "indeterminate", reason: "solana-spl-expiry-persistence-uncertain" });
      expect(checkedPreflight).toHaveBeenCalledTimes(1);
      expect(prepareSignedTransfer).toHaveBeenCalledTimes(1);
      expect(broadcastRetained).toHaveBeenCalledTimes(1);
    },
  );

  test.each([["a string", "yes"], ["a number", 1], ["an object", {}]])(
    "isCurrent resolving %s is a stale fence",
    async (_name, current) => {
      const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
      const broadcastRetained = vi.fn(adapter().broadcastRetained);
      await expect(advanceSolanaSplSettlement(input({
        store: {
          ...createInMemorySolanaSplSettlementStore(),
          isCurrent: async () => current as never,
        },
        adapter: adapter({ prepareSignedTransfer, broadcastRetained }),
      }))).resolves.toEqual({ status: "indeterminate", reason: "solana-spl-preflight-unavailable" });
      expect(prepareSignedTransfer).not.toHaveBeenCalled();
      expect(broadcastRetained).not.toHaveBeenCalled();
    },
  );

  test("recordAttempt resolving the store's own result behind a proxy never broadcasts", async () => {
    const { traps, proxy } = trapLog();
    const memory = createInMemorySolanaSplSettlementStore();
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    await expect(advanceSolanaSplSettlement(input({
      store: { ...memory, recordAttempt: async (request) => proxy(await memory.recordAttempt(request)) },
      adapter: adapter({ broadcastRetained }),
    }))).resolves.toEqual({
      status: "indeterminate",
      reason: "solana-spl-retained-attempt-persistence-uncertain",
    });
    expect(broadcastRetained).not.toHaveBeenCalled();
    expect(traps).toEqual(RESOLVED);
  });

  test("recordSettlement resolving the store's own result behind a proxy after the transfer landed is uncertain",
    async () => {
      const { traps, proxy } = trapLog();
      const memory = createInMemorySolanaSplSettlementStore();
      await expect(advanceSolanaSplSettlement(input({
        store: {
          ...memory,
          recordSettlement: async (request) => proxy(await memory.recordSettlement(request)),
        },
      }))).resolves.toEqual({
        status: "indeterminate",
        reason: "solana-spl-settlement-persistence-uncertain",
      });
      expect(traps).toEqual(RESOLVED);
    });

  test.each<[string, (write: SolanaSplStoreWrite, proxy: WatchedProxy) => SolanaSplStoreWrite,
    string[]]>([
    ["the store's exact acknowledgement behind a proxy", (write, proxy) => proxy(write), RESOLVED],
    ["the store's exact evidence behind a proxy", (write, proxy) => ({
      ...write,
      expiryEvidence: proxy({ ...(write as { expiryEvidence: SolanaSplExpiryEvidence }).expiryEvidence }),
    }), []],
  ])("markAttemptExpired resolving %s never reaches a replacement", async (_name, wrap, expected) => {
    const { traps, proxy } = trapLog();
    let clock = 1_000;
    let reconciliations = 0;
    const memory = createInMemorySolanaSplSettlementStore();
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const shared = input({
      store: {
        ...memory,
        markAttemptExpired: async (request) => wrap(await memory.markAttemptExpired(request), proxy),
      },
      now: () => clock,
      adapter: adapter({
        prepareSignedTransfer,
        async reconcile(_intent, attempt) {
          return ++reconciliations === 1
            ? { disposition: "indeterminate", reason: "lost" }
            : expired(attempt);
        },
      }),
    });
    await advanceSolanaSplSettlement(shared);
    clock += 101;
    await expect(advanceSolanaSplSettlement({ ...shared, owner: "worker-b" }))
      .resolves.toEqual({ status: "indeterminate", reason: "solana-spl-expiry-persistence-uncertain" });
    expect(prepareSignedTransfer).toHaveBeenCalledTimes(1);
    expect(traps).toEqual(expected);
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

describe("advanceSolanaSplSettlement with a sparse or exotic attempts array", () => {
  type Acquired = Extract<SolanaSplStoreClaim, { status: "acquired" }>;
  // Attempt n gets a distinct canonical 64-byte signature.
  const signatureFor = (n: number) => `${"1".repeat(63)}${n}`;

  // Retains `count` attempts through the in-memory store: each earlier one
  // expired with durable evidence, and the latest was broadcast with an
  // unknown outcome. Then resumes once with the claim rewritten by `view`.
  // On resume every attempt reconciles as expired and preflight passes (or
  // refuses), the most permissive answers, so a hidden live attempt would be
  // replaced or reported failed.
  async function resumeWith(
    count: 1 | 2,
    view: (claim: Acquired) => unknown,
    resumedPreflight = preflight(),
  ) {
    let clock = 1_000;
    let resumed = false;
    const memory = createInMemorySolanaSplSettlementStore();
    const markAttemptExpired = vi.fn(memory.markAttemptExpired);
    const store: SolanaSplSettlementStore = {
      ...memory,
      markAttemptExpired,
      async claim(request) {
        const claim = await memory.claim(request);
        if (!resumed) return claim;
        expect(claim.status).toBe("acquired");
        return view(claim as Acquired) as never;
      },
    };
    const checkedPreflight = vi.fn(async () => (resumed ? resumedPreflight : preflight()));
    const prepareSignedTransfer = vi.fn(async (plan, attempt, fence) => ({
      ...(await adapter().prepareSignedTransfer(plan, attempt, fence)),
      signature: signatureFor(attempt),
      signedTransactionBase64: signedWire([signatureFor(attempt)], `signed-wire-${attempt}`),
    }));
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    const reconcile = vi.fn(async (_intent, attempt): Promise<SolanaSplReconciliation> =>
      resumed || attempt.attempt < count
        ? expired(attempt)
        : { disposition: "indeterminate", reason: "lost" });
    const shared = input({
      store,
      now: () => clock,
      adapter: adapter({
        preflight: checkedPreflight, prepareSignedTransfer, broadcastRetained, reconcile,
      }),
    });
    for (let call = 1; call <= count; call += 1) {
      await advanceSolanaSplSettlement({ ...shared, owner: `worker-${call}` });
      clock += 101;
    }
    expect(broadcastRetained.mock.calls.map((call) => call[0].attempt))
      .toEqual(count === 1 ? [1] : [1, 2]);
    for (const spy of [
      checkedPreflight, prepareSignedTransfer, broadcastRetained, reconcile, markAttemptExpired,
    ]) spy.mockClear();
    resumed = true;
    const result = await advanceSolanaSplSettlement({ ...shared, owner: "worker-resume" });
    return {
      result,
      preflights: checkedPreflight.mock.calls.length,
      prepared: prepareSignedTransfer.mock.calls.map((call) => call[1]),
      broadcast: broadcastRetained.mock.calls.map((call) => call[0].attempt),
      reconciled: reconcile.mock.calls.map((call) => call[1].attempt),
      expiries: markAttemptExpired.mock.calls.length,
    };
  }
  const corrupt = {
    result: { status: "indeterminate", reason: "solana-spl-retained-state-corrupt" },
    preflights: 0,
    prepared: [],
    broadcast: [],
    reconciled: [],
    expiries: 0,
  };

  test.each<[string, 1 | 2, (claim: Acquired) => unknown]>([
    ["a trailing hole hiding the only attempt", 1,
      (claim) => ({ ...claim, attempts: new Array(claim.attempts.length) })],
    // A store that sizes the array from a counter and fills it from rows, the
    // latest row not yet visible.
    ["a trailing hole hiding the latest attempt", 2, (claim) => {
      const attempts = new Array(claim.attempts.length);
      for (const row of claim.attempts.slice(0, -1)) attempts[row.attempt - 1] = row;
      return { ...claim, attempts };
    }],
    ["a leading hole hiding a predecessor whose expiry is not shown", 2, (claim) => {
      const attempts = [...claim.attempts];
      delete attempts[0];
      return { ...claim, attempts, expiredSignatures: [], expiryEvidence: [] };
    }],
    ["an inherited index standing in for the latest attempt", 2, (claim) => {
      const attempts = claim.attempts.slice(0, -1);
      attempts.length = claim.attempts.length;
      Object.setPrototypeOf(attempts, Object.assign(Object.create(Array.prototype), {
        [claim.attempts.length - 1]: claim.attempts.at(-1),
      }));
      return { ...claim, attempts };
    }],
    ["an accessor standing in for the latest attempt", 2, (claim) => {
      const latest = claim.attempts.at(-1);
      return {
        ...claim,
        attempts: Object.defineProperty([...claim.attempts], claim.attempts.length - 1, {
          enumerable: true,
          get: () => latest,
        }),
      };
    }],
    ["a length that disagrees with the array's own keys", 2, (claim) => ({
      ...claim,
      attempts: new Proxy([...claim.attempts], {
        get: (target, key, receiver) =>
          key === "length" ? target.length - 1 : Reflect.get(target, key, receiver),
      }),
    })],
    ["an own species constructor", 1, (claim) => ({
      ...claim,
      attempts: Object.assign([...claim.attempts], {
        constructor: {
          [Symbol.species]: function species() {
            return new Proxy([], {
              get(target, key, receiver) {
                if (key === "at") throw new Error("store secret=abc");
                return Reflect.get(target, key, receiver);
              },
            });
          },
        },
      }),
    })],
  ])("%s is corrupt state: nothing is reconciled, signed or broadcast", async (_name, count, view) => {
    await expect(resumeWith(count, view)).resolves.toEqual(corrupt);
  });

  test("a trailing hole is never a permanent failure while the hidden attempt may land", async () => {
    await expect(resumeWith(2, (claim) => {
      const attempts = [...claim.attempts];
      delete attempts[attempts.length - 1];
      return { ...claim, attempts };
    }, preflight({ payerTokenBalanceBaseUnits: "0" }))).resolves.toEqual(corrupt);
  });

  // Each row below is internally consistent (its hash matches), so only the
  // check named would refuse it; without it the core would skip reconciling
  // a live attempt, or replace it.
  const rehash = (row: Record<string, unknown>) => {
    const { attemptHash: _ignored, ...unsigned } = row;
    return { ...unsigned, attemptHash: sha256Hex(canonicalize(unsigned)) };
  };
  const evidenceFor = (attempt: { signature: string; lastValidBlockHeight: number }) => ({
    signature: attempt.signature,
    observedBlockHeight: attempt.lastValidBlockHeight + 1,
    commitmentLevel: "confirmed",
    authenticationHash: "e".repeat(64),
  });
  test.each<[string, 1 | 2, (claim: Acquired) => unknown]>([
    // The live attempt 2 would borrow attempt 1's expiry evidence.
    ["a latest attempt that duplicates an expired attempt's signature", 2, (claim) => {
      const [first, latest] = claim.attempts as SolanaSplSignedAttempt[];
      return {
        ...claim,
        attempts: [first, rehash({
          ...latest,
          signature: first?.signature,
          signedTransactionBase64: first?.signedTransactionBase64,
        })],
      };
    }],
    ["expiry evidence for a retained signature outside the expired set", 1, (claim) => ({
      ...claim,
      expiredSignatures: [],
      expiryEvidence: [evidenceFor(claim.attempts[0] as SolanaSplSignedAttempt)],
    })],
    ["expiry evidence for a signature that is not retained", 1, (claim) => ({
      ...claim,
      expiryEvidence: [evidenceFor({ signature: signatureFor(9), lastValidBlockHeight: 10_001 })],
    })],
    ["two expiry evidence rows for one signature", 2, (claim) => ({
      ...claim,
      expiryEvidence: [...(claim.expiryEvidence ?? []), ...(claim.expiryEvidence ?? [])],
    })],
    // Attempt 1 is hidden: attempt 2 alone looks like a first attempt.
    ["attempt 2 at index 0", 2, (claim) => ({
      ...claim, attempts: claim.attempts.slice(1), expiredSignatures: [], expiryEvidence: [],
    })],
    ["the attempts in reverse order", 2, (claim) => ({
      ...claim, attempts: [...claim.attempts].reverse(),
    })],
  ])("%s is corrupt state: nothing is reconciled, signed or broadcast", async (_name, count, view) => {
    await expect(resumeWith(count, view)).resolves.toEqual(corrupt);
  });

  // A proxy answers `length`, its own keys and each index from separate code.
  // These two answers agree on a shorter dense array without the latest
  // attempt, which may still land.
  const hidingLatest = (proxy: WatchedProxy) => (claim: Acquired) => {
    const attempts = [...claim.attempts];
    const hidden = String(attempts.length - 1);
    return {
      ...claim,
      attempts: proxy(attempts, {
        get: (target, key, receiver) =>
          key === "length" ? target.length - 1 : Reflect.get(target, key, receiver),
        ownKeys: (target) => Reflect.ownKeys(target).filter((key) => key !== hidden),
      }),
    };
  };

  test.each([
    ["a passing preflight", preflight()],
    ["a refusing preflight", preflight({ payerTokenBalanceBaseUnits: "0" })],
  ])("a proxy whose length and own keys hide the latest attempt, with %s, is refused before any trap runs",
    async (_name, resumedPreflight) => {
      const { traps, proxy } = trapLog();
      await expect(resumeWith(2, hidingLatest(proxy), resumedPreflight)).resolves.toEqual(corrupt);
      expect(traps).toEqual([]);
    });

  test.each<[string, (claim: Acquired, proxy: WatchedProxy) => unknown]>([
    ["the latest attempt", (claim, proxy) => ({
      ...claim,
      attempts: [...claim.attempts.slice(0, -1), proxy({ ...claim.attempts.at(-1)! })],
    })],
    ["the expired signatures", (claim, proxy) => ({
      ...claim, expiredSignatures: proxy([...claim.expiredSignatures]),
    })],
    ["the expiry evidence", (claim, proxy) => ({
      ...claim, expiryEvidence: proxy([...claim.expiryEvidence!]),
    })],
    ["a predecessor's expiry evidence", (claim, proxy) => ({
      ...claim, expiryEvidence: claim.expiryEvidence!.map((evidence) => proxy({ ...evidence })),
    })],
  ])("a transparent proxy as %s is refused before any trap runs", async (_name, view) => {
    const { traps, proxy } = trapLog();
    await expect(resumeWith(2, (claim) => view(claim, proxy))).resolves.toEqual(corrupt);
    expect(traps).toEqual([]);
  });

  // Controls: the honest claim reconciles the latest attempt before anything
  // else, and these arrays are read exactly like it.
  test.each<[string, (attempts: unknown[]) => unknown]>([
    ["frozen", (attempts) => Object.freeze(attempts)],
    ["sealed", (attempts) => Object.seal(attempts)],
    ["structured-clone", (attempts) => structuredClone(attempts)],
    ["Array subclass", (attempts) => Object.assign(new (class Rows extends Array {})(), attempts)],
  ])("a %s attempts array is read like a plain one", async (_name, transform) => {
    const plain = await resumeWith(2, (claim) => claim);
    expect(plain.reconciled[0]).toBe(2);
    await expect(resumeWith(2, (claim) => ({ ...claim, attempts: transform([...claim.attempts]) })))
      .resolves.toEqual(plain);
  });

  test("a typed array in place of attempts still fails closed", async () => {
    await expect(resumeWith(2, (claim) => ({ ...claim, attempts: new Uint8Array(2) })))
      .resolves.toEqual({
        ...corrupt,
        result: { status: "indeterminate", reason: "solana-spl-settlement-store-claim-invalid" },
      });
  });
});

describe("advanceSolanaSplSettlement with a stored settlement", () => {
  type Fields = Record<string, unknown>;
  const SECRET = "secret=abc";
  // The settlement a store keeps for the default transfer.
  const stored = (): Fields & { txRef: Fields; paymentAmount: Fields; settlementFinality: Fields } => ({
    txRef: { kind: "solana-instruction", cluster: "devnet", signature: SIGNATURE_1, instructionIndex: 1 },
    paymentAmount: { amount: "1.25", currency: "USDC" },
    settlementFinality: {
      model: "commitment-level",
      finalityCommitmentLevel: "confirmed",
      finalityObservedAt: 1_788_000_000_000,
    },
    authenticationHash: "c".repeat(64),
  });
  const deeplyFrozen = (value: unknown): boolean => typeof value !== "object" || value === null ||
    (Object.isFrozen(value) && Object.values(value).every(deeplyFrozen));

  // Resumes against a store that reports the phase settled with `settlement`.
  async function settledWith(settlement: unknown) {
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    const reconcile = vi.fn(adapter().reconcile);
    const result = await advanceSolanaSplSettlement(input({
      store: {
        ...createInMemorySolanaSplSettlementStore(),
        claim: async (request) => ({ status: "settled", intent: request.intent, settlement }) as never,
      },
      adapter: adapter({ prepareSignedTransfer, broadcastRetained, reconcile }),
    }));
    expect([prepareSignedTransfer, broadcastRetained, reconcile].map((spy) => spy.mock.calls.length))
      .toEqual([0, 0, 0]);
    return result;
  }

  // Copies with a null prototype, as `Object.create(null)` or a parser makes.
  const bare = (value: Fields): Fields => Object.assign(Object.create(null) as Fields, value);

  test.each<[string, () => Fields]>([
    ["no extra fields", stored],
    ["a JSON round trip", () => JSON.parse(JSON.stringify(stored())) as Fields],
    ["null prototypes throughout", () => {
      const value = stored();
      return bare({
        ...value,
        txRef: bare(value.txRef),
        paymentAmount: bare(value.paymentAmount),
        settlementFinality: bare(value.settlementFinality),
      });
    }],
  ])("a stored settlement with %s is returned as a fresh frozen copy",
    async (_name, settlement) => {
      const value = settlement();
      const result = await settledWith(value);
      expect(result).toEqual({ status: "settled", settlement: stored() });
      const copy = (result as { settlement?: unknown }).settlement;
      expect(copy).not.toBe(value);
      expect(deeplyFrozen(copy)).toBe(true);
    });

  test.each<[string, () => unknown]>([
    ["its own toJSON", () => Object.assign(stored(), { toJSON: () => ({ source: SECRET }) })],
    ["a nested toJSON", () => {
      const value = stored();
      value.txRef.toJSON = () => SECRET;
      return value;
    }],
    ["an extra field", () => ({ ...stored(), note: `store ${SECRET}` })],
    ["an extra nested field", () => {
      const value = stored();
      value.settlementFinality.note = `store ${SECRET}`;
      return value;
    }],
    ["a prototype other than Object.prototype",
      () => Object.assign(Object.create({ note: SECRET }) as Fields, stored())],
    ["a nested prototype other than Object.prototype", () => {
      const value = stored();
      return { ...value, txRef: Object.assign(Object.create({ note: SECRET }) as Fields, value.txRef) };
    }],
  ])("a stored settlement with %s is refused, never reported settled", async (_name, settlement) => {
    const result = await settledWith(settlement());
    expect(result).toEqual({
      status: "indeterminate",
      reason: "solana-spl-stored-settlement-mismatch",
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  // `util.types.isProxy` is false for a vm context's global, yet listing its
  // keys runs the sandbox proxy's traps: `ownKeys` on Node 22, and also the
  // descriptor trap on Node 20. Its prototype comes from the other realm, and
  // even with `Object.prototype` it carries every global as an own key. So it
  // is refused on both, and no trap answer reaches the result.
  test.each([
    ["as created", false],
    ["with its prototype reset to Object.prototype", true],
  ])("a stored settlementFinality that is a vm context global %s is refused, no trap answer used",
    async (_name, resetPrototype) => {
      let descriptorTraps = 0;
      const finality = vm.runInContext("this", vm.createContext(new Proxy(
        { model: "commitment-level", finalityCommitmentLevel: "confirmed", finalityObservedAt: 7 },
        {
          getOwnPropertyDescriptor(target, key) {
            const field = Reflect.getOwnPropertyDescriptor(target, key);
            if (key !== "finalityObservedAt" || field === undefined) return field;
            descriptorTraps += 1;
            return { ...field, value: descriptorTraps <= 2 ? 7 : `store ${SECRET}` };
          },
        },
      ))) as Fields;
      expect(nodeTypes.isProxy(finality)).toBe(false);
      if (resetPrototype) Object.setPrototypeOf(finality, Object.prototype);
      const result = await settledWith({ ...stored(), settlementFinality: finality });
      expect(result).toEqual({
        status: "indeterminate",
        reason: "solana-spl-stored-settlement-mismatch",
      });
      expect(JSON.stringify(result)).not.toContain(SECRET);
    });

  test("each field of an accepted stored settlement is read once, from its descriptor", async () => {
    const value = stored();
    const objects: object[] = [value, value.txRef, value.paymentAmount, value.settlementFinality];
    const { reads, restore } = countDescriptorReads(objects);
    try {
      await expect(settledWith(value)).resolves.toEqual({ status: "settled", settlement: stored() });
    } finally {
      restore();
    }
    expect(reads()).toEqual(objects.map(onceEach));
  });

  test.each<[string, () => { value: unknown; reads: () => number }]>([
    ["an authenticationHash getter that changes after validation", () => {
      let reads = 0;
      const value = Object.defineProperty(stored(), "authenticationHash", {
        enumerable: true,
        get: () => (reads++ === 0 ? "c".repeat(64) : SECRET),
      });
      return { value, reads: () => reads };
    }],
    ["a nested signature getter that throws after validation", () => {
      let reads = 0;
      const value = stored();
      Object.defineProperty(value.txRef, "signature", {
        enumerable: true,
        get: () => {
          if (reads++ === 0) return SIGNATURE_1;
          throw new Error(`store ${SECRET}`);
        },
      });
      return { value, reads: () => reads };
    }],
    ["an authenticationHash object that only prints as a hash", () => {
      let reads = 0;
      const authenticationHash = {
        note: SECRET,
        toString: () => {
          reads += 1;
          return "c".repeat(64);
        },
      };
      return { value: { ...stored(), authenticationHash }, reads: () => reads };
    }],
    ["fields inherited from a prototype", () => {
      let reads = 0;
      const value: unknown = Object.create(new Proxy(stored(), {
        get(target, key, receiver) {
          reads += 1;
          return Reflect.get(target, key, receiver);
        },
      }));
      return { value, reads: () => reads };
    }],
  ])("a stored settlement with %s is never read and never returned", async (_name, settlement) => {
    const { value, reads } = settlement();
    const result = await settledWith(value);
    expect(reads()).toBe(0);
    expect(result).toEqual({
      status: "indeterminate",
      reason: "solana-spl-stored-settlement-mismatch",
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test("a stored field behind a descriptor trap is refused before the trap runs, so no answer reaches the result",
    async () => {
      let reads = 0;
      const value = stored();
      // The first descriptor read of finalityObservedAt answers 7; any later
      // read answers store text.
      value.settlementFinality = new Proxy(value.settlementFinality, {
        getOwnPropertyDescriptor(target, key) {
          const field = Reflect.getOwnPropertyDescriptor(target, key);
          if (key !== "finalityObservedAt" || field === undefined) return field;
          reads += 1;
          return { ...field, value: reads === 1 ? 7 : `store ${SECRET}` };
        },
      });
      const result = await settledWith(value);
      expect(reads).toBe(0);
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(result).toEqual({
        status: "indeterminate",
        reason: "solana-spl-stored-settlement-mismatch",
      });
    });

  test.each<[string, (value: ReturnType<typeof stored>, proxy: WatchedProxy) => unknown]>([
    ["the settlement", (value, proxy) => proxy(value)],
    ["its txRef", (value, proxy) => ({ ...value, txRef: proxy(value.txRef) })],
    ["its paymentAmount", (value, proxy) => ({ ...value, paymentAmount: proxy(value.paymentAmount) })],
    ["its settlementFinality", (value, proxy) => ({
      ...value, settlementFinality: proxy(value.settlementFinality),
    })],
    ["a txRef whose reads change after the first", (value, proxy) => {
      const reads = new Map<PropertyKey, number>();
      return {
        ...value,
        txRef: proxy(value.txRef, {
          get(target, key, receiver) {
            reads.set(key, (reads.get(key) ?? 0) + 1);
            return key === "signature" && reads.get(key)! > 1 ? SECRET : Reflect.get(target, key, receiver);
          },
        }),
      };
    }],
  ])("a stored settlement with a proxy as %s is refused before any trap runs", async (_name, view) => {
    const { traps, proxy } = trapLog();
    const result = await settledWith(view(stored(), proxy));
    expect(traps).toEqual([]);
    expect(result).toEqual({
      status: "indeterminate",
      reason: "solana-spl-stored-settlement-mismatch",
    });
  });
});

describe("advanceSolanaSplSettlement captures each store object as plain data", () => {
  type Acquired = Extract<SolanaSplStoreClaim, { status: "acquired" }>;
  type Fields = Record<string, unknown>;
  type ExpiryRequest = Parameters<SolanaSplSettlementStore["markAttemptExpired"]>[0];
  const signatureFor = (n: number) => `${"1".repeat(63)}${n}`;
  // An enumerable getter that returns the field's own value and counts reads.
  const getter = (value: object, key: string, reads: { count: number }) => {
    const field = (value as Fields)[key];
    return Object.defineProperty(value, key, {
      enumerable: true,
      get: () => {
        reads.count += 1;
        return field;
      },
    });
  };
  const withPrototype = (value: object) => Object.assign(Object.create({}) as Fields, value);
  const rehash = (row: Fields) => {
    const { attemptHash: _ignored, ...unsigned } = row;
    return { ...row, attemptHash: sha256Hex(canonicalize(unsigned)) };
  };

  interface Rewrites {
    claim?: (claim: Acquired) => unknown;
    markAttemptExpired?: (write: SolanaSplStoreWrite, request: ExpiryRequest) => unknown;
    recordAttempt?: (write: SolanaSplStoreWrite) => unknown;
    recordSettlement?: (write: SolanaSplStoreWrite) => unknown;
    reconcileLatest?: (attempt: SolanaSplSignedAttempt) => SolanaSplReconciliation;
  }

  // Retains attempt 1, expired with durable evidence, and attempt 2, broadcast
  // with an unknown outcome and valid through block 10_002. Then resumes once
  // with the store's results rewritten. On resume attempt 2 reconciles as
  // expired (`reconcileLatest`) and attempt 3 as settled, so an honest store
  // signs attempt 3 and settles: anything refused stops before that.
  async function resume(rewrites: Rewrites = {}) {
    let clock = 1_000;
    let stage = 1;
    const memory = createInMemorySolanaSplSettlementStore();
    const resumed = () => stage === 3;
    const store: SolanaSplSettlementStore = {
      ...memory,
      async claim(request) {
        const claim = await memory.claim(request);
        return resumed() && rewrites.claim ? rewrites.claim(claim as Acquired) as never : claim;
      },
      async markAttemptExpired(request) {
        const write = await memory.markAttemptExpired(request);
        return resumed() && rewrites.markAttemptExpired
          ? rewrites.markAttemptExpired(write, request) as never
          : write;
      },
      async recordAttempt(request) {
        const write = await memory.recordAttempt(request);
        return resumed() && rewrites.recordAttempt ? rewrites.recordAttempt(write) as never : write;
      },
      async recordSettlement(request) {
        const write = await memory.recordSettlement(request);
        return resumed() && rewrites.recordSettlement
          ? rewrites.recordSettlement(write) as never
          : write;
      },
    };
    const checkedPreflight = vi.fn(adapter().preflight);
    const prepareSignedTransfer = vi.fn(async (plan, attempt, fence) => ({
      ...(await adapter().prepareSignedTransfer(plan, attempt, fence)),
      signature: signatureFor(attempt),
      signedTransactionBase64: signedWire([signatureFor(attempt)], `signed-wire-${attempt}`),
    }));
    const recordAttempt = vi.spyOn(store, "recordAttempt");
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    const reconcile = vi.fn(async (_intent, attempt): Promise<SolanaSplReconciliation> => {
      if (!resumed()) {
        return stage === 2 && attempt.attempt === 1
          ? expired(attempt)
          : { disposition: "indeterminate", reason: "lost" };
      }
      if (attempt.attempt === 2) return (rewrites.reconcileLatest ?? expired)(attempt);
      return { disposition: "settled-same", transfer: observed({ signature: attempt.signature }) };
    });
    const shared = input({
      store,
      now: () => clock,
      adapter: adapter({
        preflight: checkedPreflight, prepareSignedTransfer, broadcastRetained, reconcile,
      }),
    });
    for (; stage <= 2; stage += 1) {
      await advanceSolanaSplSettlement({ ...shared, owner: `worker-${stage}` });
      clock += 101;
    }
    expect(broadcastRetained.mock.calls.map((call) => call[0].attempt)).toEqual([1, 2]);
    for (const spy of [
      checkedPreflight, prepareSignedTransfer, recordAttempt, broadcastRetained, reconcile,
    ]) spy.mockClear();
    const result = await advanceSolanaSplSettlement({ ...shared, owner: "worker-resume" });
    return {
      result,
      reconciled: reconcile.mock.calls.map((call) => [call[1].attempt, call[1].lastValidBlockHeight]),
      preflights: checkedPreflight.mock.calls.length,
      prepared: prepareSignedTransfer.mock.calls.map((call) => call[1]),
      recorded: recordAttempt.mock.calls.map((call) => call[0].attempt.attempt),
      broadcast: broadcastRetained.mock.calls.map((call) => call[0].attempt),
    };
  }
  const nothingAfter = (reason: string, reconciled: number[][] = []) => ({
    result: { status: "indeterminate", reason },
    reconciled,
    preflights: 0,
    prepared: [],
    recorded: [],
    broadcast: [],
  });

  // Daybreak round-3 P1-1. The row's first key is an `attemptHash` getter
  // whose first read answers the hash of the row with bound 0. Its second read
  // lowers the row's own bound to 0. Object-rest read it twice, so the rest
  // copy hashed to the answer, and a proof of expiry at block 1 replaced an
  // attempt that can still land until block 10_002.
  test("an attemptHash getter that lowers the retained bound never authorizes attempt 3", async () => {
    let forgedReads = 0;
    const run = await resume({
      claim(claim) {
        const actual = claim.attempts.at(-1)!;
        const { attemptHash: _ignored, ...unsigned } = actual;
        const forgedHash = sha256Hex(canonicalize({ ...unsigned, lastValidBlockHeight: 0 }));
        const row: Fields = {};
        Object.defineProperty(row, "attemptHash", {
          enumerable: true,
          configurable: true,
          get() {
            forgedReads += 1;
            if (forgedReads === 2) row.lastValidBlockHeight = 0;
            return forgedHash;
          },
        });
        Object.assign(row, unsigned);
        return { ...claim, attempts: [...claim.attempts.slice(0, -1), row] };
      },
      // Confirmed absence at block 1, which proves expiry only for bound 0.
      reconcileLatest: (attempt) => expired(attempt, { observedBlockHeight: 1 }),
      // A store that acknowledges exactly the evidence it was sent.
      markAttemptExpired: (_write, request) => ({
        status: "recorded",
        expiryEvidence: {
          signature: request.signature,
          observedBlockHeight: request.observedBlockHeight,
          commitmentLevel: request.commitmentLevel,
          authenticationHash: request.authenticationHash,
        },
      }),
    });
    expect(run).toEqual(nothingAfter("solana-spl-retained-state-corrupt"));
    expect(forgedReads).toBe(0);
  });

  test("an attempt row whose fields are all getters is refused before any of them runs", async () => {
    const reads: Record<string, { count: number }> = {};
    const run = await resume({
      claim(claim) {
        const row: Fields = { ...claim.attempts.at(-1)! };
        for (const key of Object.keys(row)) getter(row, key, reads[key] = { count: 0 });
        return { ...claim, attempts: [...claim.attempts.slice(0, -1), row] };
      },
    });
    expect(Object.values(reads).map((field) => field.count)).toEqual(new Array(9).fill(0));
    expect(run).toEqual(nothingAfter("solana-spl-retained-state-corrupt"));
  });

  test("each field of every store object is read once, from its descriptor", async () => {
    const objects: object[] = [];
    const track = <T extends object>(value: T): T => {
      objects.push(value);
      return value;
    };
    const fresh = (write: SolanaSplStoreWrite) => {
      const copy: Fields = { ...write };
      if (copy.expiryEvidence) copy.expiryEvidence = track({ ...(copy.expiryEvidence as object) });
      return track(copy);
    };
    const { reads, restore } = countDescriptorReads(objects);
    let run: Awaited<ReturnType<typeof resume>>;
    try {
      run = await resume({
        claim: (claim) => track({
          ...claim,
          intent: track({ ...claim.intent }),
          lease: track({ ...claim.lease }),
          attempts: track(claim.attempts.map((attempt) => track({ ...attempt }))),
          expiredSignatures: track([...claim.expiredSignatures]),
          expiryEvidence: track(claim.expiryEvidence!.map((evidence) => track({ ...evidence }))),
        }),
        markAttemptExpired: fresh,
        recordAttempt: fresh,
        recordSettlement: fresh,
      });
    } finally {
      restore();
    }
    expect(run).toMatchObject({
      result: { status: "settled", settlement: { txRef: { signature: signatureFor(3) } } },
      reconciled: [[2, 10_002], [3, 10_003]],
      prepared: [3],
      broadcast: [3],
    });
    // Claim, intent, lease, attempts and their two rows, expired signatures,
    // evidence and its row; the expiry write and its evidence; two writes.
    expect(objects).toHaveLength(13);
    expect(reads()).toEqual(objects.map(onceEach));
  });

  const invalid = "solana-spl-settlement-store-claim-invalid";
  const corrupt = "solana-spl-retained-state-corrupt";
  test.each<[string, string, (claim: Acquired) => unknown]>([
    ["a claim whose attempts is a getter", invalid,
      (claim) => getter({ ...claim }, "attempts", { count: 0 })],
    ["a claim with an extra key", invalid, (claim) => ({ ...claim, note: "store" })],
    ["an acquired claim that also carries a settled claim's key", invalid,
      (claim) => ({ ...claim, settlement: {} })],
    ["a claim with a prototype other than Object.prototype", invalid, withPrototype],
    // Canonical form skips undefined values, so only the key set tells them apart.
    ["an intent with an extra key whose value is undefined", invalid,
      (claim) => ({ ...claim, intent: { ...claim.intent, note: undefined } })],
    ["a lease whose generation is a getter", invalid,
      (claim) => ({ ...claim, lease: getter({ ...claim.lease }, "generation", { count: 0 }) })],
    ["a lease with an extra key", invalid,
      (claim) => ({ ...claim, lease: { ...claim.lease, note: "store" } })],
    ["a lease with a symbol key", invalid,
      (claim) => ({ ...claim, lease: { ...claim.lease, [Symbol("note")]: "store" } })],
    ["an attempt row with a non-enumerable attemptHash", corrupt, (claim) => {
      const row: Fields = { ...claim.attempts.at(-1)! };
      Object.defineProperty(row, "attemptHash", { enumerable: false });
      return { ...claim, attempts: [...claim.attempts.slice(0, -1), row] };
    }],
    ["an attempt row with an extra key its hash covers", corrupt, (claim) => ({
      ...claim,
      attempts: [...claim.attempts.slice(0, -1), rehash({ ...claim.attempts.at(-1)!, note: "store" })],
    })],
    ["an attempt row with a prototype other than Object.prototype", corrupt, (claim) => ({
      ...claim,
      attempts: [...claim.attempts.slice(0, -1), withPrototype(claim.attempts.at(-1)!)],
    })],
    ["an expiry evidence row whose signature is a getter", corrupt, (claim) => ({
      ...claim,
      expiryEvidence: claim.expiryEvidence!.map((row) => getter({ ...row }, "signature", { count: 0 })),
    })],
    ["an expiry evidence row with an extra key", corrupt, (claim) => ({
      ...claim,
      expiryEvidence: claim.expiryEvidence!.map((row) => ({ ...row, note: "store" })),
    })],
  ])("%s is refused before anything is reconciled or signed", async (_name, reason, view) => {
    await expect(resume({ claim: view })).resolves.toEqual(nothingAfter(reason));
  });

  const acknowledgement = (edit: (evidence: Fields) => unknown) =>
    (write: SolanaSplStoreWrite) => ({
      ...write,
      expiryEvidence: edit({ ...(write as { expiryEvidence: SolanaSplExpiryEvidence }).expiryEvidence }),
    });
  test.each<[string, (write: SolanaSplStoreWrite) => unknown]>([
    ["whose status is a getter", (write) => getter({ ...write }, "status", { count: 0 })],
    ["whose evidence's authenticationHash is a getter",
      acknowledgement((evidence) => getter(evidence, "authenticationHash", { count: 0 }))],
    ["whose evidence has an extra key", acknowledgement((evidence) => ({ ...evidence, note: "store" }))],
    ["whose evidence has a prototype other than Object.prototype", acknowledgement(withPrototype)],
    ["with an extra key", (write) => ({ ...write, note: "store" })],
  ])("an expiry acknowledgement %s never reaches preflight or a new signature",
    async (_name, markAttemptExpired) => {
      await expect(resume({ markAttemptExpired })).resolves.toEqual(
        nothingAfter("solana-spl-expiry-persistence-uncertain", [[2, 10_002]]),
      );
    });

  test.each<[string, (write: SolanaSplStoreWrite) => unknown]>([
    ["whose status is a getter", (write) => getter({ ...write }, "status", { count: 0 })],
    ["with an extra key", (write) => ({ ...write, note: "store" })],
    ["with a prototype other than Object.prototype", withPrototype],
    ["that succeeds but also carries a failure's reason", (write) => ({ ...write, reason: "store" })],
  ])("a recordAttempt result %s never broadcasts attempt 3", async (_name, recordAttempt) => {
    await expect(resume({ recordAttempt })).resolves.toEqual({
      result: { status: "indeterminate", reason: "solana-spl-retained-attempt-persistence-uncertain" },
      reconciled: [[2, 10_002]],
      preflights: 1,
      prepared: [3],
      recorded: [3],
      broadcast: [],
    });
  });

  test.each<[string, (write: SolanaSplStoreWrite) => unknown]>([
    ["whose status is a getter", (write) => getter({ ...write }, "status", { count: 0 })],
    ["with an extra key", (write) => ({ ...write, note: "store" })],
  ])("a recordSettlement result %s is never reported settled", async (_name, recordSettlement) => {
    await expect(resume({ recordSettlement })).resolves.toMatchObject({
      result: { status: "indeterminate", reason: "solana-spl-settlement-persistence-uncertain" },
      broadcast: [3],
    });
  });

  test("a prepared attempt is retained with exactly its fields, so a resume can read it back", async () => {
    const memory = createInMemorySolanaSplSettlementStore();
    const recordAttempt = vi.spyOn(memory, "recordAttempt");
    let clock = 1_000;
    let observations = 0;
    const shared = input({
      store: memory,
      now: () => clock,
      adapter: adapter({
        async prepareSignedTransfer(plan, attempt, fence) {
          return { ...(await adapter().prepareSignedTransfer(plan, attempt, fence)), note: "adapter" };
        },
        async reconcile(_intent, attempt) {
          return ++observations === 1
            ? { disposition: "indeterminate", reason: "lost" }
            : { disposition: "settled-same", transfer: observed({ signature: attempt.signature }) };
        },
      }),
    });
    await advanceSolanaSplSettlement(shared);
    expect(Object.keys(recordAttempt.mock.calls[0]![0].attempt)).toEqual([
      "attemptVersion", "attempt", "authorityHash", "signature", "signedTransactionBase64",
      "lastValidBlockHeight", "transferInstructionIndex", "preparedAt", "attemptHash",
    ]);
    clock += 101;
    await expect(advanceSolanaSplSettlement({ ...shared, owner: "worker-b" }))
      .resolves.toMatchObject({ status: "settled", settlement: { txRef: { signature: SIGNATURE_1 } } });
  });
});

describe("advanceSolanaSplSettlement with an adapter result that changes between reads", () => {
  test("a prepared transaction is retained as validated, so a lower expiry height never replaces it",
    async () => {
      let clock = 1_000;
      let reads = 0;
      let observations = 0;
      const prepareSignedTransfer = vi.fn(async (plan, attempt, fence) => {
        const prepared = await adapter().prepareSignedTransfer(plan, attempt, fence);
        // Valid until 10_001 on the first read, and until 1 on any later read.
        return Object.defineProperty({ ...prepared }, "lastValidBlockHeight", {
          enumerable: true,
          get: () => (reads++ === 0 ? 10_001 : 1),
        });
      });
      const broadcastRetained = vi.fn(adapter().broadcastRetained);
      const shared = input({
        now: () => clock,
        adapter: adapter({
          prepareSignedTransfer,
          broadcastRetained,
          async reconcile(_intent, attempt) {
            return ++observations === 1
              ? { disposition: "indeterminate", reason: "lost" }
              : expired(attempt, { observedBlockHeight: 2 });
          },
        }),
      });
      await advanceSolanaSplSettlement(shared);
      expect(broadcastRetained.mock.calls.map((call) => call[0].lastValidBlockHeight))
        .toEqual([10_001]);
      clock += 101;
      await expect(advanceSolanaSplSettlement({ ...shared, owner: "worker-b" }))
        .resolves.toEqual({ status: "indeterminate", reason: "solana-spl-expiry-proof-invalid" });
      expect(prepareSignedTransfer).toHaveBeenCalledTimes(1);
      expect(broadcastRetained).toHaveBeenCalledTimes(1);
      expect(reads).toBe(1);
    });

  test("a preflight is planned as validated, so an existing payee account is always checked",
    async () => {
      let reads = 0;
      const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
      // The payee account exists but is bound to another owner and mint; the
      // flag says it exists on every other read.
      const value = Object.defineProperty(
        preflight({ payeeAtaOwner: PAYER, payeeAtaMint: PAYER }),
        "payeeAtaExists",
        { enumerable: true, get: () => reads++ % 2 === 0 },
      );
      await expect(advanceSolanaSplSettlement(input({
        adapter: adapter({ preflight: async () => value, prepareSignedTransfer }),
      }))).resolves.toEqual({
        status: "failed",
        errorClass: "counterparty",
        reason: "solana-spl-payee-ata-binding-mismatch",
      });
      expect(prepareSignedTransfer).not.toHaveBeenCalled();
      expect(reads).toBe(1);
    });

  test("a preflight is planned as validated, so an existing payee account is never created",
    async () => {
      let reads = 0;
      const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
      // A correctly bound payee account that exists; the flag says so on every
      // other read, and the authority forbids creating one.
      const value = Object.defineProperty(preflight(), "payeeAtaExists", {
        enumerable: true,
        get: () => reads++ % 2 === 0,
      });
      await expect(advanceSolanaSplSettlement(input({
        adapter: adapter({ preflight: async () => value, prepareSignedTransfer }),
      }))).resolves.toMatchObject({ status: "settled" });
      expect(prepareSignedTransfer.mock.calls[0]?.[0]).toMatchObject({
        createPayeeAta: false,
        payerFundsAtaRentLamports: "0",
      });
      expect(reads).toBe(1);
    });
});

describe("advanceSolanaSplSettlement checks each value it relies on", () => {
  test("a landed transfer whose authenticationHash only prints as a hash is never settled",
    async () => {
      const recordSettlement = vi.fn();
      const authenticationHash = { note: "adapter secret=abc", toString: () => "c".repeat(64) };
      const result = await advanceSolanaSplSettlement(input({
        store: { ...createInMemorySolanaSplSettlementStore(), recordSettlement },
        adapter: adapter({
          async reconcile(_intent, attempt) {
            return {
              disposition: "settled-same",
              transfer: observed({ signature: attempt.signature, authenticationHash } as never),
            };
          },
        }),
      }));
      expect(result).toEqual({
        status: "indeterminate",
        reason: "solana-spl-settled-instruction-mismatch",
      });
      expect(JSON.stringify(result)).not.toContain("secret");
      expect(recordSettlement).not.toHaveBeenCalled();
    });

  test("a stored intent with the same bindingHash but another payer is never acted on",
    async () => {
      const memory = createInMemorySolanaSplSettlementStore();
      const checkedPreflight = vi.fn(adapter().preflight);
      await expect(advanceSolanaSplSettlement(input({
        store: {
          ...memory,
          async claim(request) {
            const claim = await memory.claim(request);
            if (claim.status !== "acquired") return claim;
            return { ...claim, intent: { ...claim.intent, payer: PAYEE } };
          },
        },
        adapter: adapter({ preflight: checkedPreflight }),
      }))).resolves.toEqual({
        status: "indeterminate",
        reason: "solana-spl-settlement-store-intent-mismatch",
      });
      expect(checkedPreflight).not.toHaveBeenCalled();
    });

  test.each(["stale", "conflict"] as const)(
    "recordSettlement resolving %s after the transfer landed is uncertain",
    async (status) => {
      await expect(advanceSolanaSplSettlement(input({
        store: {
          ...createInMemorySolanaSplSettlementStore(),
          recordSettlement: async () => ({ status, reason: "store secret=abc" }),
        },
      }))).resolves.toEqual({
        status: "indeterminate",
        reason: "solana-spl-settlement-persistence-uncertain",
      });
    },
  );

  test("a lease lost while reconciling is never recorded as this call's settlement", async () => {
    let current = true;
    const memory = createInMemorySolanaSplSettlementStore();
    const recordSettlement = vi.spyOn(memory, "recordSettlement");
    await expect(advanceSolanaSplSettlement(input({
      store: {
        ...memory,
        recordSettlement,
        isCurrent: async (request) => current && memory.isCurrent(request),
      },
      adapter: adapter({
        async reconcile(intent, attempt, fence) {
          const result = await adapter().reconcile(intent, attempt, fence);
          current = false;
          return result;
        },
      }),
    }))).resolves.toEqual({
      status: "indeterminate",
      reason: "solana-spl-reconciliation-unavailable",
    });
    expect(recordSettlement).not.toHaveBeenCalled();
  });
});

describe("advanceSolanaSplSettlement on a runtime without util.types.isProxy", () => {
  // Every proxy check runs inside a handled step, so a runtime whose node:util
  // has no isProxy refuses each claim instead of trusting it.
  test("the claim is refused before anything is preflighted, signed or reported failed", async () => {
    const isProxy = Object.getOwnPropertyDescriptor(nodeTypes, "isProxy")!;
    const checkedPreflight = vi.fn(async () => preflight({ payerTokenBalanceBaseUnits: "0" }));
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    Reflect.deleteProperty(nodeTypes, "isProxy");
    try {
      await expect(advanceSolanaSplSettlement(input({
        adapter: adapter({ preflight: checkedPreflight, prepareSignedTransfer }),
      }))).resolves.toEqual({
        status: "indeterminate",
        reason: "solana-spl-settlement-store-claim-invalid",
      });
    } finally {
      Object.defineProperty(nodeTypes, "isProxy", isProxy);
    }
    expect(checkedPreflight).not.toHaveBeenCalled();
    expect(prepareSignedTransfer).not.toHaveBeenCalled();
  });
});
