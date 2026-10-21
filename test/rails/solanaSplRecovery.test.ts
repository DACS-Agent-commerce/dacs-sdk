import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import {
  advanceSolanaSplSettlement, createInMemorySolanaSplSettlementStore,
  createSolanaSplSettlementIntent, type SolanaSplAdapter, type SolanaSplPreparation,
  type SolanaSplSettlementAuthority, type SolanaSplSettlementStore,
} from "../../src/rails/solanaSpl.js";

const PAYEE = `${"1".repeat(31)}2`;
const MINT = `${"1".repeat(31)}3`;
const ATA = "4GdNzi5A6pM3dCkP9d58MRz8YLfppc1U9W3q3extZzK3";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
function base58(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let result = "";
  while (n > 0n) { result = alphabet[Number(n % 58n)] + result; n /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; result = `1${result}`; }
  return result;
}

function fixture() {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const authority: SolanaSplSettlementAuthority = {
    jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D", phaseIndex: 2, railId: "solana-devnet-usdc",
    railDescriptorHash: "a".repeat(64), agreementHash: "b".repeat(64),
    assetKind: "spl", cluster: "devnet", payer: base58(publicKey), payee: PAYEE, mint: MINT,
    assetSymbol: "USDC", amount: "1.25", currency: "USDC", tokenDecimals: 6,
  };
  const store = createInMemorySolanaSplSettlementStore();
  const clock = { now: 1_000 };
  const signatures: string[] = [];
  const submitted = new Set<string>();
  // This offline fixture signs a real Ed25519 message; the mocked ledger never submits it.
  const message = Buffer.concat([Buffer.from([1, 0, 1, 2]), publicKey, Buffer.alloc(32, 2),
    Buffer.alloc(32, 3), Buffer.from([1, 1, 0, 1, 12])]);
  const adapter: SolanaSplAdapter = {
    preflight: vi.fn<SolanaSplAdapter["preflight"]>(async () => ({
      mintTokenProgram: TOKEN, payerTokenAccount: `${"1".repeat(31)}4`,
      payerTokenBalanceBaseUnits: "5000000", payerNativeBalanceLamports: "10000000",
      payeeAta: ATA, payeeAtaExists: true, payeeAtaOwner: PAYEE, payeeAtaMint: MINT,
      networkFeeLamports: "5000", ataRentExemptReserveLamports: "2039280",
      payerRentExemptMinimumLamports: "890880",
    })),
    prepareUnsignedTransfer: vi.fn<SolanaSplAdapter["prepareUnsignedTransfer"]>(async () => ({ unsignedMessageBase64: message.toString("base64"),
      lastValidBlockHeight: 100, transferInstructionIndex: 0, preparedAt: clock.now })),
    prepareSignedTransfer: vi.fn<SolanaSplAdapter["prepareSignedTransfer"]>(async (plan, attempt, fence, retained) => {
      await fence.assertCurrent();
      const transaction = retained!.transaction;
      const bytes = Buffer.from(transaction.unsignedMessageBase64, "base64");
      const signatureBytes = sign(null, bytes, keys.privateKey);
      const signature = base58(signatureBytes);
      signatures.push(signature);
      return { attemptVersion: "1", attempt, authorityHash: plan.intent.bindingHash, signature,
        signedTransactionBase64: Buffer.concat([Buffer.from([1]), signatureBytes, bytes]).toString("base64"),
        lastValidBlockHeight: transaction.lastValidBlockHeight,
        transferInstructionIndex: transaction.transferInstructionIndex, preparedAt: transaction.preparedAt };
    }),
    broadcastRetained: vi.fn<SolanaSplAdapter["broadcastRetained"]>(async (attempt) => {
      submitted.add(attempt.signature);
      return { disposition: "submitted" };
    }),
    reconcile: vi.fn<SolanaSplAdapter["reconcile"]>(async (intent, attempt) => submitted.has(attempt.signature)
      ? ({ disposition: "settled-same", transfer: {
      cluster: "devnet", signature: attempt.signature, instructionIndex: 0, standard: "spl-transfer-checked",
      mint: MINT, payer: intent.payer, payee: PAYEE, amountBaseUnits: "1250000", tokenDecimals: 6,
      commitmentLevel: "confirmed", finalityObservedAt: clock.now, authenticationHash: "c".repeat(64),
    } }) : ({ disposition: "absent-valid", authenticationHash: "d".repeat(64) })),
  };
  const advance = (overrides: { store?: SolanaSplSettlementStore; adapter?: SolanaSplAdapter } = {}) =>
    advanceSolanaSplSettlement({ authority, owner: `worker-${clock.now}`, store, adapter,
      now: () => clock.now, leaseDurationMs: 100, ...overrides });
  return { authority, store, clock, signatures, adapter, advance };
}

describe("recovering the exact reserved Solana message", () => {
  test.each(["before signing", "after signing"])("wallet failure %s recovers without another preflight or message", async (when) => {
    const f = fixture();
    const signMessage = f.adapter.prepareSignedTransfer;
    const failing = { ...f.adapter, prepareSignedTransfer: vi.fn<SolanaSplAdapter["prepareSignedTransfer"]>(async (...args: Parameters<typeof signMessage>) => {
      if (when === "after signing") await signMessage(...args);
      throw new Error("wallet disconnected");
    }) };
    expect(await f.advance({ adapter: failing })).toEqual({ status: "indeterminate", reason: "solana-spl-preparation-unavailable" });
    f.clock.now += 101;
    expect((await f.advance()).status).toBe("settled");
    expect(f.adapter.preflight).toHaveBeenCalledTimes(1);
    expect(f.adapter.prepareUnsignedTransfer).toHaveBeenCalledTimes(1);
    expect(new Set(f.signatures).size).toBe(1);
    expect(f.signatures).toHaveLength(when === "after signing" ? 2 : 1);
  });

  test.each(["lease lapse", "lost acknowledgement"])("a reservation survives %s before wallet invocation", async (fault) => {
    const f = fixture();
    const recordPreparation = vi.fn(async (request: Parameters<typeof f.store.recordPreparation>[0]) => {
      const result = await f.store.recordPreparation(request);
      if (fault === "lease lapse") f.clock.now += 101;
      else throw new Error("response lost after commit");
      return result;
    });
    expect((await f.advance({ store: { ...f.store, recordPreparation } })).status).toBe("indeterminate");
    expect(f.adapter.prepareSignedTransfer).not.toHaveBeenCalled();
    f.clock.now += 101;
    expect((await f.advance()).status).toBe("settled");
    expect(f.adapter.prepareUnsignedTransfer).toHaveBeenCalledTimes(1);
    expect(f.adapter.preflight).toHaveBeenCalledTimes(1);
  });

  test.each(["before", "after"])("a lost recordAttempt reply %s commit recovers only the same transaction", async (side) => {
    const f = fixture();
    const recordAttempt = async (request: Parameters<typeof f.store.recordAttempt>[0]) => {
      if (side === "after") await f.store.recordAttempt(request);
      throw new Error("store disconnected");
    };
    expect((await f.advance({ store: { ...f.store, recordAttempt } })).status).toBe("indeterminate");
    expect(f.adapter.broadcastRetained).not.toHaveBeenCalled();
    f.clock.now += 101;
    expect((await f.advance()).status).toBe("settled");
    expect(new Set(f.signatures).size).toBe(1);
    expect(f.signatures).toHaveLength(side === "before" ? 2 : 1);
  });

  test("a new worker signs the same message while the old wallet call is still outstanding", async () => {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const handoff = new Promise<void>((resolve) => { entered = resolve; });
    const first = f.advance({ adapter: { ...f.adapter, async prepareSignedTransfer(...args) {
      const prepared = await f.adapter.prepareSignedTransfer(...args);
      entered(); await waiting; return prepared;
    } } });
    await handoff;
    f.clock.now += 101;
    expect((await f.advance()).status).toBe("settled");
    release();
    expect((await first).status).toBe("indeterminate");
    expect(new Set(f.signatures).size).toBe(1);
    expect(f.signatures).toHaveLength(2);
    expect(f.adapter.broadcastRetained).toHaveBeenCalledTimes(1);
  });

  test("unsigned build failure is transient and reserves nothing", async () => {
    const f = fixture();
    const reserve = vi.spyOn(f.store, "recordPreparation");
    expect(await f.advance({ adapter: { ...f.adapter, async prepareUnsignedTransfer() { throw new Error("blockhash fetch failed"); } } }))
      .toEqual({ status: "transient", reason: "solana-spl-unsigned-preparation-unavailable" });
    expect(reserve).not.toHaveBeenCalled();
    expect(f.adapter.prepareSignedTransfer).not.toHaveBeenCalled();
    f.clock.now += 101;
    expect((await f.advance()).status).toBe("settled");
  });

  test.each(["message", "expiry"])("signer cannot change the reserved %s", async (field) => {
    const f = fixture();
    const result = await f.advance({ adapter: { ...f.adapter, async prepareSignedTransfer(plan, n, fence, reservation) {
      const copy: SolanaSplPreparation = structuredClone(reservation!);
      if (field === "expiry") copy.transaction = { ...copy.transaction, lastValidBlockHeight: 99 };
      else {
        const bytes = Buffer.from(copy.transaction.unsignedMessageBase64, "base64"); bytes[bytes.length - 1] = 13;
        copy.transaction = { ...copy.transaction, unsignedMessageBase64: bytes.toString("base64") };
      }
      return f.adapter.prepareSignedTransfer(plan, n, fence, copy);
    } } });
    expect(result).toEqual({ status: "indeterminate", reason: "solana-spl-prepared-transaction-invalid" });
    expect(f.adapter.broadcastRetained).not.toHaveBeenCalled();
    f.clock.now += 101;
    expect((await f.advance()).status).toBe("settled");
  });

  test("reservation responses and subsequent claims cannot mutate the saved message", async () => {
    const f = fixture();
    const intent = createSolanaSplSettlementIntent(f.authority);
    await f.advance({ adapter: { ...f.adapter, async prepareSignedTransfer() { throw new Error("retry"); } } });
    const claim = await f.store.claim({ intent, owner: "inspect", now: 1_001, leaseDurationMs: 100 });
    if (claim.status !== "waiting") throw new Error("expected waiting");
    const preparation = claim.preparation as SolanaSplPreparation;
    Object.assign(preparation.transaction, { unsignedMessageBase64: "changed" });
    f.clock.now += 101;
    expect((await f.advance()).status).toBe("settled");
  });

  test("an expired reservation is reconciled before RPC can reject its broadcast", async () => {
    const f = fixture();
    await f.advance({ adapter: { ...f.adapter, async prepareSignedTransfer() { throw new Error("wallet timeout"); } } });
    f.clock.now += 86_400_000;
    const broadcastRetained = vi.fn<SolanaSplAdapter["broadcastRetained"]>(async () => { throw new Error("blockhash expired"); });
    const markAttemptExpired = vi.spyOn(f.store, "markAttemptExpired");
    const result = await f.advance({ adapter: { ...f.adapter, broadcastRetained,
      async reconcile(_intent, attempt) {
        return { disposition: "absent-expired", observedBlockHeight: attempt.lastValidBlockHeight + 1,
          commitmentLevel: "finalized", authenticationHash: "e".repeat(64) };
      },
    } });
    expect(result).toEqual({ status: "indeterminate", reason: "solana-spl-new-attempt-expired-before-observation" });
    expect(broadcastRetained).not.toHaveBeenCalled();
    expect(markAttemptExpired).toHaveBeenCalledTimes(1);
    expect(f.adapter.prepareUnsignedTransfer).toHaveBeenCalledTimes(1);
  });

  test("an expired recovered message gets a replacement only after finalized expiry is retained", async () => {
    const f = fixture();
    let builds = 0;
    const adapter: SolanaSplAdapter = { ...f.adapter,
      async prepareUnsignedTransfer(...args) {
        const transaction = await f.adapter.prepareUnsignedTransfer(...args);
        if (++builds === 1) return transaction;
        const bytes = Buffer.from(transaction.unsignedMessageBase64, "base64");
        bytes[68] = 4; // A fresh blockhash, with its own last-valid height.
        return { ...transaction, unsignedMessageBase64: bytes.toString("base64"), lastValidBlockHeight: 200 };
      },
      async reconcile(intent, attempt, fence) {
        return attempt.lastValidBlockHeight === 100
          ? { disposition: "absent-expired", observedBlockHeight: 101, commitmentLevel: "finalized", authenticationHash: "e".repeat(64) }
          : f.adapter.reconcile(intent, attempt, fence);
      },
    };
    await f.advance({ adapter: { ...adapter, async prepareSignedTransfer(...args) {
      await f.adapter.prepareSignedTransfer(...args);
      throw new Error("reply lost");
    } } });
    f.clock.now += 86_400_000;
    expect((await f.advance({ adapter })).status).toBe("indeterminate");
    expect(f.adapter.broadcastRetained).not.toHaveBeenCalled();
    f.clock.now += 101;
    expect((await f.advance({ adapter })).status).toBe("settled");
    expect(builds).toBe(2);
    expect(f.signatures).toHaveLength(3);
    expect(f.signatures[0]).toBe(f.signatures[1]);
    expect(f.signatures[2]).not.toBe(f.signatures[0]);
    expect(f.adapter.broadcastRetained).toHaveBeenCalledTimes(1);
  });

  test("a recovered payment already final on the ledger is never broadcast again", async () => {
    const f = fixture();
    await f.advance({ adapter: { ...f.adapter, async prepareSignedTransfer(...args) {
      await f.adapter.prepareSignedTransfer(...args);
      throw new Error("wallet lost its reply after signing");
    } } });
    f.clock.now += 101;
    const broadcastRetained = vi.fn(f.adapter.broadcastRetained);
    expect((await f.advance({ adapter: { ...f.adapter, broadcastRetained,
      async reconcile(intent, attempt) {
        return { disposition: "settled-same", transfer: {
          cluster: "devnet", signature: attempt.signature, instructionIndex: 0, standard: "spl-transfer-checked",
          mint: MINT, payer: intent.payer, payee: PAYEE, amountBaseUnits: "1250000", tokenDecimals: 6,
          commitmentLevel: "finalized", finalityObservedAt: f.clock.now, authenticationHash: "c".repeat(64),
        } };
      },
    } })).status).toBe("settled");
    expect(broadcastRetained).not.toHaveBeenCalled();
    expect(new Set(f.signatures).size).toBe(1);
  });

  test.each(["stale", "throw", "existing", "extra key"])("a %s reservation acknowledgement never invokes the wallet", async (kind) => {
    const f = fixture();
    const recordPreparation: SolanaSplSettlementStore["recordPreparation"] = async () => {
      if (kind === "throw") throw new Error("store down");
      if (kind === "stale") return { status: "stale", reason: "expired lease" };
      if (kind === "existing") return { status: "existing" };
      return { status: "recorded", note: "unexpected" } as never;
    };
    expect(await f.advance({ store: { ...f.store, recordPreparation } }))
      .toEqual({ status: "indeterminate", reason: "solana-spl-preparation-reservation-uncertain" });
    expect(f.adapter.prepareSignedTransfer).not.toHaveBeenCalled();
  });

  test("a missing reservation method is rejected before a lease is acquired", async () => {
    const f = fixture();
    const claim = vi.spyOn(f.store, "claim");
    expect(await f.advance({ store: { ...f.store, recordPreparation: undefined } as never }))
      .toEqual({ status: "indeterminate", reason: "solana-spl-dependencies-invalid" });
    expect(claim).not.toHaveBeenCalled();
  });

  test("a standing preparation cannot be closed from a balance read", async () => {
    const f = fixture();
    await f.advance({ adapter: { ...f.adapter, async prepareSignedTransfer() { throw new Error("wallet unavailable"); } } });
    f.clock.now += 101;
    const intent = createSolanaSplSettlementIntent(f.authority);
    const claim = await f.store.claim({ intent, owner: "inspect", now: f.clock.now, leaseDurationMs: 100 });
    if (claim.status !== "acquired") throw new Error("expected acquired");
    expect(await f.store.recordFailure({ settlementKey: intent.settlementKey, bindingHash: intent.bindingHash,
      owner: "inspect", generation: claim.lease.generation,
      failure: { errorClass: "permanent", reason: "solana-spl-insufficient-token-balance" } }))
      .toEqual({ status: "conflict", reason: "solana-failure-preparation-unresolved" });
    f.clock.now += 101;
    const preflight = vi.fn<SolanaSplAdapter["preflight"]>(async () => { throw new Error("balance RPC down"); });
    expect((await f.advance({ adapter: { ...f.adapter, preflight } })).status).toBe("settled");
    expect(preflight).not.toHaveBeenCalled();
  });

  test("an unresolved later preparation prevents recording an earlier settlement", async () => {
    const f = fixture();
    await f.advance({ adapter: { ...f.adapter, reconcile: async () => ({ disposition: "pending", reason: "not finalized" }) } });
    f.clock.now += 101;
    const intent = createSolanaSplSettlementIntent(f.authority);
    const claim = await f.store.claim({ intent, owner: "inspect", now: f.clock.now, leaseDurationMs: 100 });
    if (claim.status !== "acquired") throw new Error("expected acquired");
    const reservation = vi.mocked(f.adapter.prepareSignedTransfer).mock.calls[0]![3]!;
    const token = { settlementKey: intent.settlementKey, bindingHash: intent.bindingHash,
      owner: "inspect", generation: claim.lease.generation };
    expect(await f.store.recordPreparation({ ...token, attempt: 2, preparation: { ...reservation, attempt: 2 } }))
      .toEqual({ status: "recorded" });
    expect(await f.store.recordSettlement({ ...token, signature: f.signatures[0]!, settlement: {
      txRef: { kind: "solana-instruction", cluster: "devnet", signature: f.signatures[0]!, instructionIndex: 0 },
      paymentAmount: { amount: "1.25", currency: "USDC" },
      settlementFinality: { model: "commitment-level", finalityCommitmentLevel: "confirmed", finalityObservedAt: f.clock.now },
      authenticationHash: "c".repeat(64),
    } })).toEqual({ status: "conflict", reason: "solana-settlement-preparation-unresolved" });
  });

  test("removed audit and release interfaces are unnecessary", async () => {
    const f = fixture();
    expect(f.store).not.toHaveProperty("releasePreparation");
    expect(f.adapter).not.toHaveProperty("proveNoSubmission");
    expect((await f.advance()).status).toBe("settled");
  });
});
