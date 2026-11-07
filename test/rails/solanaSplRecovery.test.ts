import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import {
  advanceSolanaSplSettlement, createInMemorySolanaSplSettlementStore,
  createSolanaSplSettlementIntent, type SolanaSplAdapter, type SolanaSplPreparation,
  type SolanaSplSettlementAuthority, type SolanaSplSettlementStore, type SolanaSplSignedAttempt,
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
function decode58(value: string): Buffer {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const c of value) n = n * 58n + BigInt(alphabet.indexOf(c));
  const bytes = Buffer.alloc(32);
  for (let i = 31; n > 0n; i--) { bytes[i] = Number(n & 255n); n >>= 8n; }
  return bytes;
}
const BLOCKHASH_OFFSET = 4 + 5 * 32;

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
  const data = Buffer.alloc(10);
  data[0] = 12; data.writeBigUInt64LE(1_250_000n, 1); data[9] = 6;
  const message = Buffer.concat([Buffer.from([1, 0, 2, 5]), publicKey,
    decode58(`${"1".repeat(31)}4`), decode58(ATA), decode58(MINT), decode58(TOKEN),
    Buffer.alloc(32, 3), Buffer.from([1, 4, 4, 1, 3, 2, 0, 10]), data]);
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
  const advance = (overrides: { store?: SolanaSplSettlementStore; adapter?: SolanaSplAdapter; authority?: SolanaSplSettlementAuthority } = {}) =>
    advanceSolanaSplSettlement({ authority, owner: `worker-${clock.now}`, store, adapter,
      now: () => clock.now, leaseDurationMs: 100, ...overrides });
  return { authority, store, clock, signatures, adapter, advance };
}

describe("recovering the exact reserved Solana message", () => {
  const otherAuthority = (f: ReturnType<typeof fixture>) => ({ ...f.authority,
    jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7E" });
  const freshBlockhash = (f: ReturnType<typeof fixture>): SolanaSplAdapter => ({ ...f.adapter,
    async prepareUnsignedTransfer(...args) {
      const transaction = await f.adapter.prepareUnsignedTransfer(...args);
      const bytes = Buffer.from(transaction.unsignedMessageBase64, "base64");
      bytes[BLOCKHASH_OFFSET] = 4;
      return { ...transaction, unsignedMessageBase64: bytes.toString("base64"), lastValidBlockHeight: 200 };
    },
  });

  test("concurrent identical payments reserve the message once and the other job retries with a fresh blockhash", async () => {
    const f = fixture();
    const other = otherAuthority(f);
    const [first, second] = await Promise.all([f.advance(), f.advance({ authority: other })]);
    expect(first.status).toBe("settled");
    expect(second).toEqual({ status: "indeterminate", reason: "solana-spl-preparation-reservation-uncertain" });
    expect(f.adapter.prepareSignedTransfer).toHaveBeenCalledTimes(1);
    expect(f.adapter.broadcastRetained).toHaveBeenCalledTimes(1);
    const intent = createSolanaSplSettlementIntent(other);
    const claim = await f.store.claim({ intent, owner: "inspect", now: f.clock.now, leaseDurationMs: 100 });
    expect(claim).toMatchObject({ status: "waiting", attempts: [] });
    expect(claim).not.toHaveProperty("preparation");
    f.clock.now += 101;
    expect((await f.advance({ authority: other, adapter: freshBlockhash(f) })).status).toBe("settled");
    expect(new Set(f.signatures).size).toBe(2);
    expect(f.adapter.broadcastRetained).toHaveBeenCalledTimes(2);
    f.clock.now += 101;
    expect((await f.advance()).status).toBe("settled");
    expect((await f.advance({ authority: other })).status).toBe("settled");
    expect(f.adapter.broadcastRetained).toHaveBeenCalledTimes(2);
  });

  // Reproduce a migrated store containing a preparation written before global
  // message reservations existed. The owning attempt is imported through the
  // legacy recordAttempt path, which does not require a preparation.
  async function oldCollision(coordinate?: "cluster" | "instruction") {
    const f = fixture();
    const other = { ...otherAuthority(f), ...(coordinate === "cluster" ? { cluster: "testnet" as const } : {}) };
    await f.advance({ authority: other, adapter: { ...f.adapter,
      ...(coordinate === "instruction" ? { prepareUnsignedTransfer: async (...args: Parameters<SolanaSplAdapter["prepareUnsignedTransfer"]>) => {
        const transaction = await f.adapter.prepareUnsignedTransfer(...args);
        const bytes = Buffer.from(transaction.unsignedMessageBase64, "base64");
        const instructionCountAt = BLOCKHASH_OFFSET + 32;
        const instruction = bytes.subarray(instructionCountAt + 1);
        // A real batch: both instruction 0 and instruction 1 transfer funds.
        const batch = Buffer.concat([bytes.subarray(0, instructionCountAt), Buffer.from([2]), instruction, instruction]);
        return { ...transaction, unsignedMessageBase64: batch.toString("base64"), transferInstructionIndex: 1 };
      } } : {}),
      async prepareSignedTransfer() { throw new Error("old wallet lost its reply"); },
    } });
    const otherIntent = createSolanaSplSettlementIntent(other);
    const pending = await f.store.claim({ intent: otherIntent, owner: "inspect", now: f.clock.now, leaseDurationMs: 100 });
    if (pending.status !== "waiting" || !pending.preparation) throw new Error("missing preparation");
    const intent = createSolanaSplSettlementIntent(f.authority);
    await f.store.claim({ intent, owner: "legacy", now: f.clock.now, leaseDurationMs: 100 });
    const signed = { ...(await f.adapter.prepareSignedTransfer({ ...pending.preparation.plan, intent }, 1,
      { settlementKey: intent.settlementKey, bindingHash: intent.bindingHash, owner: "legacy", generation: 1,
        assertCurrent: async () => undefined }, pending.preparation)), transferInstructionIndex: 0 };
    const attempt = { ...signed, attemptHash: sha256Hex(canonicalize(signed)) };
    expect(await f.store.recordAttempt({ settlementKey: intent.settlementKey, bindingHash: intent.bindingHash,
      owner: "legacy", generation: 1, attempt })).toEqual({ status: "recorded" });
    return { f, other, otherIntent, attempt, preparation: pending.preparation };
  }

  test.each(["before broadcast", "after broadcast"])("an older colliding preparation recovers %s without assigning the owned transfer twice", async (when) => {
    const { f, other, otherIntent, attempt } = await oldCollision();
    if (when === "after broadcast") await f.adapter.broadcastRetained(attempt, {} as never);
    f.clock.now += 101;
    expect(await f.advance({ authority: other }))
      .toEqual({ status: "indeterminate", reason: "solana-spl-retained-attempt-persistence-uncertain" });
    const cleared = await f.store.claim({ intent: otherIntent, owner: "inspect", now: f.clock.now, leaseDurationMs: 100 });
    expect(cleared).toMatchObject({ status: "waiting", attempts: [] });
    expect(cleared).not.toHaveProperty("preparation");
    // The signature is still owned by the original key, even after recovery.
    expect(await f.store.recordAttempt({ settlementKey: otherIntent.settlementKey, bindingHash: otherIntent.bindingHash,
      owner: `worker-${f.clock.now}`, generation: 2,
      attempt: { ...attempt, authorityHash: otherIntent.bindingHash } }))
      .toEqual({ status: "conflict", reason: "solana-signature-cross-settlement-reuse" });
    f.clock.now += 101;
    expect((await f.advance({ authority: other, adapter: freshBlockhash(f) })).status).toBe("settled");
    expect(f.signatures.at(-1)).not.toBe(attempt.signature);
  });

  test.each(["cluster", "instruction"] as const)("a different settlement %s never releases an older preparation", async (coordinate) => {
    const { f, other, otherIntent } = await oldCollision(coordinate);
    f.clock.now += 101;
    expect((await f.advance({ authority: other })).status).toBe("indeterminate");
    const claim = await f.store.claim({ intent: otherIntent, owner: "inspect", now: f.clock.now, leaseDurationMs: 100 });
    expect(claim).toMatchObject({ status: "waiting", attempts: [], preparation: { attempt: 1 } });
    expect(f.adapter.broadcastRetained).not.toHaveBeenCalled();
  });

  test.each(["wire", "additional signature", "metadata", "generation"])("a collision with different %s never releases the preparation", async (fault) => {
    const { f, otherIntent, attempt } = await oldCollision();
    const candidate: SolanaSplSignedAttempt = { ...attempt, authorityHash: otherIntent.bindingHash };
    if (fault === "wire") {
      const bytes = Buffer.from(candidate.signedTransactionBase64, "base64");
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
      candidate.signedTransactionBase64 = bytes.toString("base64");
    }
    if (fault === "additional signature") {
      const bytes = Buffer.from(candidate.signedTransactionBase64, "base64");
      candidate.signedTransactionBase64 = Buffer.concat([
        Buffer.from([2]), bytes.subarray(1, 65), Buffer.alloc(64, 9), bytes.subarray(65),
      ]).toString("base64");
    }
    if (fault === "metadata") candidate.lastValidBlockHeight++;
    const result = await f.store.recordAttempt({ settlementKey: otherIntent.settlementKey,
      bindingHash: otherIntent.bindingHash, owner: `worker-${f.clock.now}`,
      generation: fault === "generation" ? 0 : 1, attempt: candidate });
    expect(result.status).not.toBe("recorded");
    const claim = await f.store.claim({ intent: otherIntent, owner: "inspect", now: f.clock.now, leaseDurationMs: 100 });
    expect(claim).toMatchObject({ status: "waiting", attempts: [], preparation: { attempt: 1 } });
  });

  test("a lost collision-clearance reply and a late old worker cannot revive the duplicate", async () => {
    const { f, other, otherIntent, attempt } = await oldCollision();
    f.clock.now += 101;
    const store = { ...f.store, async recordAttempt(request: Parameters<typeof f.store.recordAttempt>[0]) {
      await f.store.recordAttempt(request);
      throw new Error("clearance committed, reply lost");
    } };
    expect((await f.advance({ authority: other, store })).status).toBe("indeterminate");
    // An old wallet operation may finish with these exact bytes afterwards.
    expect(await f.store.recordAttempt({ settlementKey: otherIntent.settlementKey, bindingHash: otherIntent.bindingHash,
      owner: "worker-1000", generation: 1, attempt: { ...attempt, authorityHash: otherIntent.bindingHash } }))
      .toEqual({ status: "stale", reason: "stale-lease" });
    f.clock.now += 101;
    expect((await f.advance({ authority: other, adapter: freshBlockhash(f) })).status).toBe("settled");
    expect(f.adapter.broadcastRetained).toHaveBeenCalledTimes(1);
    expect(f.signatures.at(-1)).not.toBe(attempt.signature);
  });

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
        bytes[BLOCKHASH_OFFSET] = 4; // A fresh blockhash, with its own last-valid height.
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
