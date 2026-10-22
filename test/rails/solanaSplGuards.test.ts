import { randomBytes } from "node:crypto";

import { describe, expect, test, vi } from "vitest";

import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import {
  advanceSolanaSplSettlement,
  createInMemorySolanaSplSettlementStore,
  createSolanaSplSettlementIntent,
  type AdvanceSolanaSplSettlementInput,
  type SolanaSplAdapter,
  type SolanaSplObservedTransfer,
  type SolanaSplPreflight,
  type SolanaSplReconciliation,
  type SolanaSplSettlementAuthority,
  type SolanaSplSettlementStore,
  type SolanaSplSignedAttempt,
} from "../../src/rails/solanaSpl.js";

// One guard at a time: each case changes a single value that a decision on
// the payment, settlement or replacement path depends on, and pins the exact
// result and effects. See solanaSpl.test.ts for the behaviour as a whole.

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// A reference Base58 encoder, pinned below to bs58 5.0.0's answers.
function base58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let digits = "";
  for (; value > 0n; value /= 58n) digits = BASE58_ALPHABET[Number(value % 58n)] + digits;
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  return "1".repeat(zeros) + digits;
}

function base58Decode(text: string, length: number): Buffer {
  let value = 0n;
  for (const character of text) value = value * 58n + BigInt(BASE58_ALPHABET.indexOf(character));
  const bytes = Buffer.alloc(length);
  for (let index = length - 1; value > 0n; index -= 1) {
    bytes[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

const PAYER = "1".repeat(32);
const PAYEE = `${"1".repeat(31)}2`;
const MINT = `${"1".repeat(31)}3`;
const PAYER_TOKEN = `${"1".repeat(31)}4`;
// PAYEE's associated token account for MINT under SPL Token.
const PAYEE_ATA = "4GdNzi5A6pM3dCkP9d58MRz8YLfppc1U9W3q3extZzK3";
// The program that owns an SPL Token mint: a public program id.
const SPL_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SIGNATURE_1 = "1".repeat(64);
const SIGNATURE_2 = `${"1".repeat(63)}2`;
const HASH = "a".repeat(64);
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";

const signatureFor = (attempt: number) => `${"1".repeat(63)}${attempt}`.slice(-64);

// A legacy Solana message: one signer, two account keys, a recent blockhash,
// and one instruction that calls key 1 with no accounts and `data`.
function legacyMessage(data: Uint8Array): Buffer {
  return Buffer.concat([
    Buffer.from([1, 0, 1, 2]), Buffer.alloc(32, 1), Buffer.alloc(32, 2), Buffer.alloc(32, 3),
    Buffer.from([1, 1, 0, data.length]), data,
  ]);
}
// Solana wire bytes: a compact-u16 signature count, the signatures, then a
// message whose instruction data is `memo`.
function signedWire(signatures: readonly string[], memo: string): string {
  return Buffer.concat([
    Buffer.from([signatures.length]),
    ...signatures.map((signature) => base58Decode(signature, 64)),
    legacyMessage(Buffer.from(memo, "utf8")),
  ]).toString("base64");
}

function authority(overrides: Partial<SolanaSplSettlementAuthority> = {}): SolanaSplSettlementAuthority {
  return {
    jobId: JOB_ID, phaseIndex: 2, railId: "solana-devnet-usdc",
    railDescriptorHash: HASH, agreementHash: "b".repeat(64), assetKind: "spl",
    cluster: "devnet", payer: PAYER, payee: PAYEE, mint: MINT, assetSymbol: "USDC",
    amount: "1.25", currency: "USDC", tokenDecimals: 6, ...overrides,
  };
}

function preflight(overrides: Partial<SolanaSplPreflight> = {}): SolanaSplPreflight {
  return {
    mintTokenProgram: SPL_PROGRAM_ID,
    payerTokenAccount: PAYER_TOKEN, payerTokenBalanceBaseUnits: "5000000",
    payerNativeBalanceLamports: "10000000", payeeAta: PAYEE_ATA, payeeAtaExists: true,
    payeeAtaOwner: PAYEE, payeeAtaMint: MINT, networkFeeLamports: "5000",
    ataRentExemptReserveLamports: "2039280", payerRentExemptMinimumLamports: "890880",
    ...overrides,
  };
}

function observed(overrides: Partial<SolanaSplObservedTransfer> = {}): SolanaSplObservedTransfer {
  return {
    cluster: "devnet", signature: SIGNATURE_1, instructionIndex: 1,
    standard: "spl-transfer-checked", mint: MINT, payer: PAYER, payee: PAYEE,
    amountBaseUnits: "1250000", tokenDecimals: 6, commitmentLevel: "confirmed",
    finalityObservedAt: 1_788_000_000_000, authenticationHash: "c".repeat(64), ...overrides,
  };
}

function adapter(overrides: Partial<SolanaSplAdapter> = {}): SolanaSplAdapter {
  return {
    async preflight(_intent, fence) {
      await fence.assertCurrent();
      return preflight();
    },
    async prepareUnsignedTransfer(_plan, attempt, fence) {
      await fence.assertCurrent();
      const wire = Buffer.from(signedWire([SIGNATURE_1], `signed-wire-${attempt}`), "base64");
      return { unsignedMessageBase64: wire.subarray(65).toString("base64"),
        lastValidBlockHeight: 10_000 + attempt, transferInstructionIndex: 1,
        preparedAt: 1_788_000_000_000 + attempt };
    },
    async prepareSignedTransfer(plan, attempt, fence) {
      await fence.assertCurrent();
      const signature = signatureFor(attempt);
      return {
        attemptVersion: "1", attempt, authorityHash: plan.intent.bindingHash, signature,
        signedTransactionBase64: signedWire([signature], `signed-wire-${attempt}`),
        lastValidBlockHeight: 10_000 + attempt, transferInstructionIndex: 1,
        preparedAt: 1_788_000_000_000 + attempt,
      };
    },
    async broadcastRetained(_attempt, fence) {
      await fence.assertCurrent();
      return { disposition: "submitted" };
    },
    async reconcile(_intent, attempt, fence) {
      await fence.assertCurrent();
      return { disposition: "settled-same", transfer: observed({ signature: attempt.signature }) };
    },
    ...overrides,
  };
}

function input(overrides: Partial<AdvanceSolanaSplSettlementInput> = {}): AdvanceSolanaSplSettlementInput {
  return {
    authority: authority(), owner: "worker-a", store: createInMemorySolanaSplSettlementStore(),
    adapter: adapter(), now: () => 1_000, leaseDurationMs: 100, ...overrides,
  };
}

const expiredFor = (
  attempt: Pick<SolanaSplSignedAttempt, "lastValidBlockHeight">,
  overrides: Record<string, unknown> = {},
): SolanaSplReconciliation => ({
  disposition: "absent-expired", observedBlockHeight: attempt.lastValidBlockHeight + 1,
  commitmentLevel: "finalized", authenticationHash: "e".repeat(64), ...overrides,
}) as SolanaSplReconciliation;
const lost = { disposition: "indeterminate", reason: "lost" } as const;

// Leaves attempt 1 broadcast but unobserved; returns the input for a resume
// by another worker once the first lease has expired.
async function leaveAttemptOne(store: SolanaSplSettlementStore, overrides: Partial<SolanaSplAdapter>) {
  let clock = 1_000;
  const shared = input({ store, now: () => clock, adapter: adapter(overrides) });
  await advanceSolanaSplSettlement(shared);
  clock += 101;
  return { ...shared, owner: "worker-b" };
}

// Runs a first call and resumes as one new worker per lease until `owners`
// are used up; returns the last result.
async function resumeAs(shared: AdvanceSolanaSplSettlementInput, advance: () => void, owners: readonly string[]) {
  let result = await advanceSolanaSplSettlement(shared);
  for (const owner of owners) {
    advance();
    result = await advanceSolanaSplSettlement({ ...shared, owner });
  }
  return result;
}

describe("the retained attempt is persisted before any broadcast", () => {
  test.each([
    ["stale", { status: "stale", reason: "stale-lease" }],
    ["conflict", { status: "conflict", reason: "solana-attempt-number-conflict" }],
    ["corrupt", { status: "corrupt", reason: "x" }],
  ])("a well-formed %s refusal of recordAttempt never broadcasts", async (_name, write) => {
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    await expect(advanceSolanaSplSettlement(input({
      store: { ...createInMemorySolanaSplSettlementStore(), recordAttempt: async () => write as never },
      adapter: adapter({ broadcastRetained }),
    }))).resolves.toEqual({ status: "indeterminate", reason: "solana-spl-retained-attempt-persistence-uncertain" });
    expect(broadcastRetained).not.toHaveBeenCalled();
  });

  test("an existing acknowledgement of the same attempt broadcasts and settles", async () => {
    const memory = createInMemorySolanaSplSettlementStore();
    await expect(advanceSolanaSplSettlement(input({
      store: {
        ...memory,
        async recordAttempt(request) {
          await memory.recordAttempt(request);
          return memory.recordAttempt(request);
        },
      },
    }))).resolves.toMatchObject({ status: "settled" });
  });
});

describe("a stored settlement is checked against the intent", () => {
  const stored = () => ({
    txRef: { kind: "solana-instruction", cluster: "devnet", signature: SIGNATURE_1, instructionIndex: 1 },
    paymentAmount: { amount: "1.25", currency: "USDC" },
    settlementFinality: { model: "commitment-level", finalityCommitmentLevel: "confirmed", finalityObservedAt: 7 },
    authenticationHash: "c".repeat(64),
  });
  const claimingSettled = (value: unknown) => input({
    store: {
      ...createInMemorySolanaSplSettlementStore(),
      claim: async (request) => ({ status: "settled", intent: request.intent, settlement: value }) as never,
    },
  });

  test.each<[string, (value: Record<string, Record<string, unknown>>) => void]>([
    ["kind", (v) => { v.txRef!.kind = "solana"; }],
    ["cluster", (v) => { v.txRef!.cluster = "mainnet"; }],
    ["negative instructionIndex", (v) => { v.txRef!.instructionIndex = -1; }],
    ["string instructionIndex", (v) => { v.txRef!.instructionIndex = "1"; }],
    ["fractional instructionIndex", (v) => { v.txRef!.instructionIndex = 1.5; }],
    ["amount", (v) => { v.paymentAmount!.amount = "2.5"; }],
    ["currency", (v) => { v.paymentAmount!.currency = "USDT"; }],
    ["model", (v) => { v.settlementFinality!.model = "block-depth"; }],
    // The core always records the intent's level, so another one is not its record.
    ["commitment", (v) => { v.settlementFinality!.finalityCommitmentLevel = "finalized"; }],
    ["negative finalityObservedAt", (v) => { v.settlementFinality!.finalityObservedAt = -1; }],
    ["string finalityObservedAt", (v) => { v.settlementFinality!.finalityObservedAt = "7"; }],
  ])("another %s is never reported settled", async (_name, change) => {
    const value = stored() as unknown as Record<string, Record<string, unknown>>;
    change(value);
    await expect(advanceSolanaSplSettlement(claimingSettled(value)))
      .resolves.toEqual({ status: "indeterminate", reason: "solana-spl-stored-settlement-mismatch" });
  });

  test("instruction 0 observed at time 0 is settled", async () => {
    const value = stored();
    value.txRef.instructionIndex = 0;
    value.settlementFinality.finalityObservedAt = 0;
    await expect(advanceSolanaSplSettlement(claimingSettled(value)))
      .resolves.toMatchObject({ status: "settled", settlement: { txRef: { instructionIndex: 0 } } });
  });
});

describe("expiry proof authorizes a replacement only when it is exact", () => {
  test.each([
    ["missing", { authenticationHash: undefined }],
    ["not a hash", { authenticationHash: "not-a-hash" }],
    ["upper-case", { authenticationHash: "E".repeat(64) }],
    ["65 hex digits", { authenticationHash: "e".repeat(65) }],
    ["only printing as a hash", { authenticationHash: { toString: () => "e".repeat(64) } }],
  ])("absent-expired with a %s authenticationHash never authorizes a replacement", async (_name, fields) => {
    const store = createInMemorySolanaSplSettlementStore();
    const markAttemptExpired = vi.spyOn(store, "markAttemptExpired");
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    let reconciliations = 0;
    const shared = await leaveAttemptOne(store, {
      prepareSignedTransfer,
      reconcile: async (_intent, attempt) => (++reconciliations === 1 ? lost : expiredFor(attempt, fields)),
    });
    await expect(advanceSolanaSplSettlement(shared))
      .resolves.toEqual({ status: "indeterminate", reason: "solana-spl-expiry-proof-invalid" });
    expect(markAttemptExpired).not.toHaveBeenCalled();
    expect(prepareSignedTransfer).toHaveBeenCalledTimes(1);
  });

  test.each<[string, (request: Record<string, unknown>) => Record<string, unknown>]>([
    ["another observed height", (request) => ({ observedBlockHeight: (request.observedBlockHeight as number) + 1 })],
    ["another authentication hash", () => ({ authenticationHash: "f".repeat(64) })],
    ["another signature", () => ({ signature: SIGNATURE_2 })],
  ])("an acknowledgement with %s never reaches a replacement", async (_name, change) => {
    const memory = createInMemorySolanaSplSettlementStore();
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const store: SolanaSplSettlementStore = {
      ...memory,
      async markAttemptExpired(request) {
        const result = await memory.markAttemptExpired(request);
        if (result.status !== "recorded" && result.status !== "existing") return result;
        return { status: result.status, expiryEvidence: { ...result.expiryEvidence!, ...change(request) } } as never;
      },
    };
    let reconciliations = 0;
    const shared = await leaveAttemptOne(store, {
      prepareSignedTransfer,
      reconcile: async (_intent, attempt) => (++reconciliations === 1 ? lost : expiredFor(attempt)),
    });
    await expect(advanceSolanaSplSettlement(shared))
      .resolves.toEqual({ status: "indeterminate", reason: "solana-spl-expiry-persistence-uncertain" });
    expect(prepareSignedTransfer).toHaveBeenCalledTimes(1);
  });

  test("an existing acknowledgement with the exact evidence allows attempt 2", async () => {
    const memory = createInMemorySolanaSplSettlementStore();
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const store: SolanaSplSettlementStore = {
      ...memory,
      async markAttemptExpired(request) {
        await memory.markAttemptExpired(request);
        return memory.markAttemptExpired(request);
      },
    };
    let reconciliations = 0;
    const shared = await leaveAttemptOne(store, {
      prepareSignedTransfer,
      reconcile: async (_intent, attempt) => {
        reconciliations += 1;
        if (attempt.attempt === 2) return { disposition: "settled-same", transfer: observed({ signature: SIGNATURE_2 }) };
        return reconciliations === 1 ? lost : expiredFor(attempt);
      },
    });
    await expect(advanceSolanaSplSettlement(shared))
      .resolves.toMatchObject({ status: "settled", settlement: { txRef: { signature: SIGNATURE_2 } } });
    expect(prepareSignedTransfer.mock.calls.map((call) => call[1])).toEqual([1, 2]);
  });

  test("a settlement acknowledged as existing is settled", async () => {
    const memory = createInMemorySolanaSplSettlementStore();
    await expect(advanceSolanaSplSettlement(input({
      store: {
        ...memory,
        async recordSettlement(request) {
          await memory.recordSettlement(request);
          return memory.recordSettlement(request);
        },
      },
    }))).resolves.toMatchObject({ status: "settled" });
  });
});

describe("a prepared or retained attempt is checked field by field", () => {
  test.each<[string, Record<string, unknown>]>([
    ["a negative lastValidBlockHeight", { lastValidBlockHeight: -1 }],
    ["a string lastValidBlockHeight", { lastValidBlockHeight: "10001" }],
    ["a missing lastValidBlockHeight", { lastValidBlockHeight: undefined }],
    ["a fractional transferInstructionIndex", { transferInstructionIndex: 1.5 }],
    ["a negative transferInstructionIndex", { transferInstructionIndex: -1 }],
    ["a negative preparedAt", { preparedAt: -1 }],
    ["another attemptVersion", { attemptVersion: "2" }],
    ["another attempt number", { attempt: 2 }],
  ])("a prepared attempt with %s is refused before persistence", async (_name, fields) => {
    const store = createInMemorySolanaSplSettlementStore();
    const recordAttempt = vi.spyOn(store, "recordAttempt");
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    await expect(advanceSolanaSplSettlement(input({
      store,
      adapter: adapter({
        broadcastRetained,
        async prepareSignedTransfer(plan, attempt, fence) {
          return { ...(await adapter().prepareSignedTransfer(plan, attempt, fence)), ...fields } as never;
        },
      }),
    }))).resolves.toEqual({ status: "indeterminate", reason: "solana-spl-prepared-transaction-invalid" });
    expect(recordAttempt).not.toHaveBeenCalled();
    expect(broadcastRetained).not.toHaveBeenCalled();
  });

  test("TransferChecked as instruction 0, prepared and observed at time 0, settles", async () => {
    await expect(advanceSolanaSplSettlement(input({
      adapter: adapter({
        async prepareUnsignedTransfer(plan, attempt, fence) {
          return { ...(await adapter().prepareUnsignedTransfer(plan, attempt, fence)), transferInstructionIndex: 0, preparedAt: 0 };
        },
        async prepareSignedTransfer(plan, attempt, fence) {
          return { ...(await adapter().prepareSignedTransfer(plan, attempt, fence)), transferInstructionIndex: 0, preparedAt: 0 };
        },
        reconcile: async (_intent, attempt) => ({
          disposition: "settled-same",
          transfer: observed({ signature: attempt.signature, instructionIndex: 0, finalityObservedAt: 0 }),
        }),
      }),
    }))).resolves.toMatchObject({ status: "settled", settlement: { txRef: { instructionIndex: 0 } } });
  });

  // Each row is changed after it was retained; only a store bug or tampering
  // does that, and each would let expiry be proved against a different bound.
  test.each<[string, (row: SolanaSplSignedAttempt) => unknown]>([
    ["a lowered lastValidBlockHeight under the old hash", (row) => ({ ...row, lastValidBlockHeight: 5 })],
    ["another attemptVersion, rehashed", ({ attemptHash: _old, ...row }) => {
      const unsigned = { ...row, attemptVersion: "2" };
      return { ...unsigned, attemptHash: sha256Hex(canonicalize(unsigned)) };
    }],
  ])("a retained row with %s is corrupt before it is reconciled", async (_name, change) => {
    const base = createInMemorySolanaSplSettlementStore();
    const reconcile = vi.fn(async () => lost);
    const store: SolanaSplSettlementStore = {
      ...base,
      async claim(request) {
        const claim = await base.claim(request);
        if (claim.status !== "acquired" || claim.attempts.length === 0) return claim;
        return { ...claim, attempts: claim.attempts.map((row) => change(row)) } as never;
      },
    };
    const shared = await leaveAttemptOne(store, { reconcile });
    await expect(advanceSolanaSplSettlement(shared))
      .resolves.toEqual({ status: "indeterminate", reason: "solana-spl-retained-state-corrupt" });
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  const message = legacyMessage(Buffer.from([0xfb, 0xff, 0xbf]));
  const wire = () => Buffer.concat([Buffer.from([1]), base58Decode(SIGNATURE_1, 64), message]).toString("base64");
  test.each([
    ["the URL-safe alphabet", () => wire().replaceAll("+", "-").replaceAll("/", "_")],
    ["an embedded newline", () => `${wire().slice(0, 8)}\n${wire().slice(8)}`],
    ["trailing garbage", () => `${wire()}!!`],
  ])("a wire encoded with %s is refused", async (_name, encoded) => {
    expect(wire()).toMatch(/[+/]/);
    await expect(advanceSolanaSplSettlement(input({
      adapter: adapter({
        async prepareSignedTransfer(plan, attempt, fence) {
          return { ...(await adapter().prepareSignedTransfer(plan, attempt, fence)), signedTransactionBase64: encoded() };
        },
      }),
    }))).resolves.toEqual({ status: "indeterminate", reason: "solana-spl-prepared-transaction-invalid" });
  });

  test("a wire with a zero signature count is refused even if the signature follows", async () => {
    await expect(advanceSolanaSplSettlement(input({
      adapter: adapter({
        async prepareSignedTransfer(plan, attempt, fence) {
          const prepared = await adapter().prepareSignedTransfer(plan, attempt, fence);
          return {
            ...prepared,
            signedTransactionBase64: Buffer.concat([
              Buffer.from([0]), base58Decode(prepared.signature, 64), legacyMessage(Buffer.from("m")),
            ]).toString("base64"),
          };
        },
      }),
    }))).resolves.toEqual({ status: "indeterminate", reason: "solana-spl-prepared-transaction-invalid" });
  });
});

// Expiry evidence proves nothing about a durable-nonce transaction, so one is
// never retained: agave treats a message as one when its first instruction
// calls the system program (32 zero bytes) with AdvanceNonceAccount data.
describe("durable-nonce and malformed messages", () => {
  // A Solana compact-u16: seven bits a byte, low bits first.
  const compact = (value: number): number[] =>
    value < 0x80 ? [value] : [(value & 0x7f) | 0x80, ...compact(value >> 7)];
  // A legacy message, or v0 with no address table lookups, whose first
  // `signers` keys sign.
  function message(
    keys: readonly Buffer[],
    instructions: readonly { program: number; data: readonly number[]; accounts?: readonly number[] }[],
    version?: number,
    signers = 1,
  ): Buffer {
    return Buffer.concat([
      ...(version === undefined ? [] : [Buffer.from([0x80 | version])]),
      Buffer.from([signers, 0, 1, ...compact(keys.length)]), ...keys, Buffer.alloc(32, 3),
      Buffer.from(compact(instructions.length)),
      ...instructions.map(({ program, data, accounts = [] }) => Buffer.from([
        program, ...compact(accounts.length), ...accounts, ...compact(data.length), ...data,
      ])),
      ...(version === undefined ? [] : [Buffer.from([0])]),
    ]);
  }
  const PAYER_KEY = Buffer.alloc(32, 1);
  const SYSTEM = Buffer.alloc(32);
  const OTHER = Buffer.alloc(32, 5);
  const NEARLY_SYSTEM = Buffer.concat([Buffer.alloc(31), Buffer.from([1])]);
  const NONCE = [4, 0, 0, 0];
  // Instruction data of 128 bytes, whose length takes two compact-u16 bytes.
  const padded = (data: readonly number[]) => [...data, ...Array<number>(128 - data.length).fill(0)];
  const TRANSFER = message([PAYER_KEY, OTHER], [{ program: 1, data: [12] }]);
  // The key order web3.js 1.98.0 compiles for nonceAdvance + transferChecked:
  // the payer, the nonce account and both token accounts, the recent
  // blockhashes sysvar, then the system program at static index 4.
  const WEB3_KEYS = [PAYER_KEY, Buffer.alloc(32, 6), Buffer.alloc(32, 7), Buffer.alloc(32, 8), SYSTEM, OTHER];
  const SECOND_SIGNER = Buffer.alloc(32, 9);
  const SECOND_SIGNATURE = Buffer.alloc(64);

  async function prepareWith(wireMessage: Buffer, otherSignatures: readonly Buffer[] = []) {
    const store = createInMemorySolanaSplSettlementStore();
    const recordPreparation = vi.spyOn(store, "recordPreparation");
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const recordAttempt = vi.spyOn(store, "recordAttempt");
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    const result = await advanceSolanaSplSettlement(input({
      store,
      adapter: adapter({
        async prepareUnsignedTransfer(plan, attempt, fence) {
          return { ...(await adapter().prepareUnsignedTransfer(plan, attempt, fence)), unsignedMessageBase64: wireMessage.toString("base64") };
        },
        async prepareSignedTransfer(plan, attempt, fence) {
          const prepared = await prepareSignedTransfer(plan, attempt, fence);
          return {
            ...prepared,
            signedTransactionBase64: Buffer.concat([
              Buffer.from([1 + otherSignatures.length]), base58Decode(prepared.signature, 64),
              ...otherSignatures, wireMessage,
            ]).toString("base64"),
          };
        },
        broadcastRetained,
      }),
    }));
    return { result, recordPreparation, prepareSignedTransfer, recordAttempt, broadcastRetained };
  }

  // The shapes a real adapter builds: the system program past static index 1,
  // a second signer, and data long enough for a two-byte compact-u16 length.
  test.each([
    ["the system program at static index 4", message(WEB3_KEYS, [
      { program: 4, accounts: [1, 5, 0], data: NONCE }, { program: 5, accounts: [2, 3, 0], data: [12] },
    ]), []],
    ["the system program at static index 4 in v0", message(WEB3_KEYS, [
      { program: 4, accounts: [1, 5, 0], data: NONCE },
    ], 0), []],
    ["two signatures", message([PAYER_KEY, SECOND_SIGNER, SYSTEM], [
      { program: 2, accounts: [0, 1], data: NONCE },
    ], undefined, 2), [SECOND_SIGNATURE]],
    ["AdvanceNonceAccount data of 128 bytes", message([PAYER_KEY, SYSTEM], [
      { program: 1, accounts: [0], data: padded(NONCE) },
    ]), []],
  ])("a nonce transaction with %s is refused before it is retained", async (_name, wireMessage, others) => {
    const { result, recordPreparation, prepareSignedTransfer, recordAttempt, broadcastRetained } = await prepareWith(wireMessage, others);
    expect(result).toEqual({ status: "transient", reason: "solana-spl-unsigned-preparation-unavailable" });
    expect(recordPreparation).not.toHaveBeenCalled();
    expect(prepareSignedTransfer).not.toHaveBeenCalled();
    expect(recordAttempt).not.toHaveBeenCalled();
    expect(broadcastRetained).not.toHaveBeenCalled();
  });

  test.each([
    ["the system program at static index 4", message(WEB3_KEYS, [
      { program: 4, accounts: [0, 1], data: [2, 0, 0, 0] }, { program: 5, accounts: [2, 3, 0], data: [12] },
    ]), []],
    ["two signatures", message([PAYER_KEY, SECOND_SIGNER, OTHER], [
      { program: 2, accounts: [0, 1], data: [12] },
    ], undefined, 2), [SECOND_SIGNATURE]],
    ["first-instruction data of 128 bytes", message([PAYER_KEY, OTHER], [
      { program: 1, accounts: [0], data: padded([12]) },
    ]), []],
  ])("a transfer with %s is retained and settles", async (_name, wireMessage, others) => {
    const { result, recordPreparation, prepareSignedTransfer, recordAttempt, broadcastRetained } = await prepareWith(wireMessage, others);
    expect(result).toMatchObject({ status: "settled" });
    expect(recordPreparation).toHaveBeenCalledTimes(1);
    expect(prepareSignedTransfer).toHaveBeenCalledTimes(1);
    expect(recordAttempt).toHaveBeenCalledTimes(1);
    expect(broadcastRetained).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["a legacy durable-nonce transaction", message([PAYER_KEY, SYSTEM], [{ program: 1, accounts: [0], data: NONCE }])],
    ["a v0 durable-nonce transaction", message([PAYER_KEY, SYSTEM], [{ program: 1, accounts: [0], data: NONCE }], 0)],
    ["a nonce advance with trailing data", message([PAYER_KEY, SYSTEM], [{ program: 1, data: [...NONCE, 9] }])],
    ["a nonce advance before the transfer",
      message([PAYER_KEY, SYSTEM, OTHER], [{ program: 1, data: NONCE }, { program: 2, data: [12] }])],
    ["a message version other than 0", message([PAYER_KEY, OTHER], [{ program: 1, data: [12] }], 1)],
    ["a program index one past the account keys", message([PAYER_KEY, OTHER], [{ program: 2, data: [12] }])],
    ["instruction data past the end", TRANSFER.subarray(0, -1)],
    ["accounts past the end", message([PAYER_KEY, OTHER], [{ program: 1, accounts: [0], data: [] }]).subarray(0, -2)],
    ["a message cut before its instructions", TRANSFER.subarray(0, 4 + 64 + 32)],
    ["a message cut inside its header", TRANSFER.subarray(0, 2)],
    ["no message", Buffer.alloc(0)],
  ])("%s is refused before it is retained or broadcast", async (_name, wireMessage) => {
    const { result, recordPreparation, prepareSignedTransfer, recordAttempt, broadcastRetained } = await prepareWith(wireMessage);
    expect(result).toEqual({ status: "transient", reason: "solana-spl-unsigned-preparation-unavailable" });
    expect(recordPreparation).not.toHaveBeenCalled();
    expect(prepareSignedTransfer).not.toHaveBeenCalled();
    expect(recordAttempt).not.toHaveBeenCalled();
    expect(broadcastRetained).not.toHaveBeenCalled();
  });

  test.each([
    ["a transfer", TRANSFER],
    ["a v0 transfer", message([PAYER_KEY, OTHER], [{ program: 1, data: [12] }], 0)],
    ["a system transfer first", message([PAYER_KEY, SYSTEM], [{ program: 1, data: [2, 0, 0, 0] }])],
    ["a nonce advance second",
      message([PAYER_KEY, SYSTEM, OTHER], [{ program: 2, data: [12] }, { program: 1, data: NONCE }])],
    // v0 ends with a zero lookup count, so a read past the three bytes sees 0.
    ["three bytes of a nonce advance", message([PAYER_KEY, SYSTEM], [{ program: 1, data: [4, 0, 0] }], 0)],
    ["nonce data for a program one bit from the system program",
      message([PAYER_KEY, NEARLY_SYSTEM], [{ program: 1, data: NONCE }])],
    ["a message with no instructions", message([PAYER_KEY], [], 0)],
  ])("%s is retained and settles", async (_name, wireMessage) => {
    const { result, recordPreparation, prepareSignedTransfer, recordAttempt, broadcastRetained } = await prepareWith(wireMessage);
    expect(result).toMatchObject({ status: "settled" });
    expect(recordPreparation).toHaveBeenCalledTimes(1);
    expect(prepareSignedTransfer).toHaveBeenCalledTimes(1);
    expect(recordAttempt).toHaveBeenCalledTimes(1);
    expect(broadcastRetained).toHaveBeenCalledTimes(1);
  });

  const retainedNonces = [
    ["legacy", message([PAYER_KEY, SYSTEM], [{ program: 1, accounts: [0], data: NONCE }]), []],
    ["v0", message(WEB3_KEYS, [{ program: 4, accounts: [1, 5, 0], data: NONCE }], 0), []],
    ["two signers", message([PAYER_KEY, SECOND_SIGNER, SYSTEM], [
      { program: 2, accounts: [0, 1], data: NONCE },
    ], undefined, 2), [SECOND_SIGNATURE]],
    ["128-byte data", message([PAYER_KEY, SYSTEM], [{ program: 1, accounts: [0], data: padded(NONCE) }]), []],
  ] as const;
  for (const kind of ["attempt", "preparation"] as const) {
    test.each(retainedNonces)(`a retained %s nonce is refused during ${kind} recovery`, async (_name, wireMessage, others) => {
      await checkRetainedNonce(wireMessage, others, kind);
    });
  }

  async function checkRetainedNonce(wireMessage: Buffer, others: readonly Buffer[], kind: "preparation" | "attempt") {
    const base = createInMemorySolanaSplSettlementStore();
    const store: SolanaSplSettlementStore = { ...base, async claim(request) {
      const claim = await base.claim(request);
      if (claim.status !== "acquired" || claim.lease.generation === 1) return claim;
      if (kind === "preparation" && claim.preparation) return { ...claim, preparation: {
        ...claim.preparation, transaction: { ...claim.preparation.transaction,
          unsignedMessageBase64: wireMessage.toString("base64") },
      } };
      return { ...claim, attempts: claim.attempts.map(({ attemptHash: _old, ...row }) => {
        const unsigned = { ...row, signedTransactionBase64: Buffer.concat([
          Buffer.from([1 + others.length]), base58Decode(row.signature, 64), ...others, wireMessage,
        ]).toString("base64") };
        return { ...unsigned, attemptHash: sha256Hex(canonicalize(unsigned)) };
      }) };
    } };
    let clock = 1_000;
    const common = input({ store, now: () => clock, adapter: adapter({ reconcile: async () => lost,
      ...(kind === "preparation" ? { prepareSignedTransfer: async () => { throw new Error("wallet timeout"); } } : {}),
    }) });
    await advanceSolanaSplSettlement(common);
    clock += 101;
    const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    const reconcile = vi.fn(adapter().reconcile);
    const recordAttempt = vi.spyOn(store, "recordAttempt");
    expect(await advanceSolanaSplSettlement({ ...common, owner: "worker-b",
      adapter: adapter({ prepareSignedTransfer, broadcastRetained, reconcile }) }))
      .toEqual({ status: "indeterminate", reason: kind === "preparation"
        ? "solana-spl-settlement-store-claim-invalid" : "solana-spl-retained-state-corrupt" });
    expect(prepareSignedTransfer).not.toHaveBeenCalled();
    expect(broadcastRetained).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(recordAttempt).not.toHaveBeenCalled();
  }

  // A transfer wire whose compact-u16 counts are written as given, each one
  // canonical unless overridden.
  type Lengths = Partial<Record<"signatures" | "keys" | "instructions" | "accounts" | "data", readonly number[]>>;
  function wireWith(signature: string, lengths: Lengths, data: readonly number[] = [12]): string {
    return Buffer.concat([
      Buffer.from(lengths.signatures ?? [1]), base58Decode(signature, 64),
      Buffer.from([1, 0, 1, ...(lengths.keys ?? [2])]), PAYER_KEY, OTHER, Buffer.alloc(32, 3),
      Buffer.from([
        ...(lengths.instructions ?? [1]), 1, ...(lengths.accounts ?? [0]),
        ...(lengths.data ?? compact(data.length)), ...data,
      ]),
    ]).toString("base64");
  }
  async function prepareWire(lengths: Lengths, data?: readonly number[], retain = false) {
    const store = createInMemorySolanaSplSettlementStore();
    const recordAttempt = vi.spyOn(store, "recordAttempt");
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    const result = await advanceSolanaSplSettlement(input({
      store,
      adapter: adapter({
        async prepareUnsignedTransfer(plan, attempt, fence) {
          const unsigned = await adapter().prepareUnsignedTransfer(plan, attempt, fence);
          return retain ? { ...unsigned, unsignedMessageBase64: Buffer.from(wireWith(SIGNATURE_1, lengths, data), "base64").subarray(65).toString("base64") } : unsigned;
        },
        async prepareSignedTransfer(plan, attempt, fence) {
          const prepared = await adapter().prepareSignedTransfer(plan, attempt, fence);
          return { ...prepared, signedTransactionBase64: wireWith(prepared.signature, lengths, data) };
        },
        broadcastRetained,
      }),
    }));
    return { result, recordAttempt, broadcastRetained };
  }
  // solana-short-vec 3.3.0 refuses a zero byte after the first, which aliases
  // a shorter encoding of the same value.
  const alias = (value: number) => [0x80 | value, 0];
  const ALIASES: readonly [string, Lengths][] = [
    ["signature count", { signatures: alias(1) }],
    ["account key count", { keys: alias(2) }],
    ["instruction count", { instructions: alias(1) }],
    ["instruction account count", { accounts: alias(0) }],
    ["instruction data length", { data: alias(1) }],
    ["instruction data length in three bytes", { data: [0x81, 0x80, 0] }],
  ];

  test.each(ALIASES)("an aliased %s is refused before it is retained or broadcast", async (_name, lengths) => {
    const { result, recordAttempt, broadcastRetained } = await prepareWire(lengths);
    expect(result).toEqual({ status: "indeterminate", reason: "solana-spl-prepared-transaction-invalid" });
    expect(recordAttempt).not.toHaveBeenCalled();
    expect(broadcastRetained).not.toHaveBeenCalled();
  });

  test.each([
    ["65536, a third byte of 4", [0x80, 0x80, 0x04], 65_536],
    ["a third byte that continues", [0x80, 0x80, 0x81, 0x00], 16_384],
  ])("an instruction data length of %s is refused before it is retained or broadcast", async (_name, length, size) => {
    const data = [12, ...Array<number>(size - 1).fill(0)];
    const { result, recordAttempt, broadcastRetained } = await prepareWire({ data: length }, data);
    expect(result).toEqual({ status: "indeterminate", reason: "solana-spl-prepared-transaction-invalid" });
    expect(recordAttempt).not.toHaveBeenCalled();
    expect(broadcastRetained).not.toHaveBeenCalled();
  });

  test.each([
    ["every count in one byte", {}, [12]],
    ["an instruction data length of 16384 in three bytes", { data: [0x80, 0x80, 0x01] }, 16_384],
    ["an instruction data length of 65535, a third byte of 3", { data: [0xff, 0xff, 0x03] }, 65_535],
  ] as const)("a transfer with %s is retained and settles", async (_name, lengths, data) => {
    const bytes = typeof data === "number" ? [12, ...Array<number>(data - 1).fill(0)] : data;
    const { result, recordAttempt, broadcastRetained } = await prepareWire(lengths, bytes, true);
    expect(result).toMatchObject({ status: "settled" });
    expect(recordAttempt).toHaveBeenCalledTimes(1);
    expect(broadcastRetained).toHaveBeenCalledTimes(1);
  });

  // Leaves attempt 1 broadcast, then resumes while the store returns it as a
  // row an earlier version stored with `lengths`, rehashed so only its wire
  // is wrong.
  async function resumeRetainedWire(lengths: Lengths) {
    const base = createInMemorySolanaSplSettlementStore();
    const reconcile = vi.fn(async () => lost);
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    const store: SolanaSplSettlementStore = {
      ...base,
      async claim(request) {
        const claim = await base.claim(request);
        if (claim.status !== "acquired" || claim.attempts.length === 0) return claim;
        return {
          ...claim,
          attempts: claim.attempts.map(({ attemptHash: _old, ...row }) => {
            const unsigned = { ...row, signedTransactionBase64: wireWith(row.signature, lengths) };
            return { ...unsigned, attemptHash: sha256Hex(canonicalize(unsigned)) };
          }),
        } as never;
      },
    };
    const shared = await leaveAttemptOne(store, { reconcile, broadcastRetained });
    expect(broadcastRetained).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    return { result: await advanceSolanaSplSettlement(shared), broadcastRetained, reconcile };
  }

  test.each(ALIASES)("a retained attempt with an aliased %s is corrupt before it is broadcast or reconciled again",
    async (_name, lengths) => {
      const { result, broadcastRetained, reconcile } = await resumeRetainedWire(lengths);
      expect(result).toEqual({ status: "indeterminate", reason: "solana-spl-retained-state-corrupt" });
      expect(broadcastRetained).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledTimes(1);
    });

  test("a retained attempt rewritten canonically and rehashed is reconciled again", async () => {
    const { result, reconcile } = await resumeRetainedWire({});
    expect(result).not.toEqual({ status: "indeterminate", reason: "solana-spl-retained-state-corrupt" });
    expect(reconcile).toHaveBeenCalledTimes(2);
  });
});

describe("preflight numbers", () => {
  test("a token balance of exactly the amount is enough", async () => {
    await expect(advanceSolanaSplSettlement(input({
      adapter: adapter({ preflight: async () => preflight({ payerTokenBalanceBaseUnits: "1250000" }) }),
    }))).resolves.toMatchObject({ status: "settled" });
  });

  test.each([
    ["a negative balance", "-1"],
    ["a signed balance", "+5000000"],
    ["a hex balance", "0x4c4b40"],
    ["a balance with a trailing space", "5000000 "],
    ["a balance with a leading space", " 5000000"],
    ["a balance with a leading zero", "05000000"],
  ])("%s is an adapter fault: indeterminate, never failed", async (_name, balance) => {
    const store = createInMemorySolanaSplSettlementStore();
    const recordFailure = vi.spyOn(store, "recordFailure");
    await expect(advanceSolanaSplSettlement(input({
      store, adapter: adapter({ preflight: async () => preflight({ payerTokenBalanceBaseUnits: balance }) }),
    }))).resolves.toEqual({ status: "indeterminate", reason: "solana-spl-preflight-invalid" });
    expect(recordFailure).not.toHaveBeenCalled();
  });
});

describe("the authority", () => {
  test.each([[-1], [1.5], [Number.NaN], ["2"]])("phaseIndex %j is refused before the store", async (phaseIndex) => {
    const store = createInMemorySolanaSplSettlementStore();
    const claim = vi.spyOn(store, "claim");
    await expect(advanceSolanaSplSettlement(input({ store, authority: authority({ phaseIndex: phaseIndex as never }) })))
      .resolves.toEqual({ status: "indeterminate", reason: "solana-spl-authority-invalid" });
    expect(claim).not.toHaveBeenCalled();
  });

  test("phaseIndex 0 and a clock at 0 settle", async () => {
    await expect(advanceSolanaSplSettlement(input({ authority: authority({ phaseIndex: 0 }), now: () => 0 })))
      .resolves.toMatchObject({ status: "settled" });
  });

  test.each([["mainnet"], ["testnet"]] as const)("a %s authority settles", async (cluster) => {
    await expect(advanceSolanaSplSettlement(input({
      authority: authority({ cluster }),
      adapter: adapter({
        reconcile: async (_intent, attempt) => ({
          disposition: "settled-same", transfer: observed({ signature: attempt.signature, cluster }),
        }),
      }),
    }))).resolves.toMatchObject({ status: "settled", settlement: { txRef: { cluster } } });
  });

  test.each([
    ["the legacy commitment recent", { commitmentLevel: "recent" }],
    ["the legacy commitment max", { commitmentLevel: "max" }],
    ["the legacy commitment single", { commitmentLevel: "single" }],
    ["mainnet-beta, Solana's own cluster name", { cluster: "mainnet-beta" }],
    ["a 65-digit hash", { agreementHash: "a".repeat(65) }],
    ["a hash with a leading character", { agreementHash: `x${"a".repeat(64)}` }],
    ["a hash with a trailing character", { railDescriptorHash: `${"a".repeat(64)}x` }],
    ["a non-Base58 character before valid digits", { mint: "E0jFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }],
  ])("%s is refused", (_name, overrides) => {
    expect(() => createSolanaSplSettlementIntent(authority(overrides as never))).toThrow();
  });

  // At 255 decimals only amounts below the u64 bound in base units fit.
  test.each([[0, "1"], [255, `0.${"0".repeat(254)}1`]])("tokenDecimals %d is an unsigned byte", (tokenDecimals, amount) => {
    expect(createSolanaSplSettlementIntent(authority({ tokenDecimals, amount })))
      .toMatchObject({ tokenDecimals, amountBaseUnits: "1" });
  });

  test.each([[-1], [1.5], [Number.NaN]])("a clock reading %j is refused before the claim", async (reading) => {
    const store = createInMemorySolanaSplSettlementStore();
    const claim = vi.spyOn(store, "claim");
    await expect(advanceSolanaSplSettlement(input({ store, now: () => reading })))
      .resolves.toEqual({ status: "indeterminate", reason: "solana-spl-settlement-store-unavailable" });
    expect(claim).not.toHaveBeenCalled();
  });
});

describe("real-length Base58 keys and signatures", () => {
  // bs58 5.0.0 (base-x 4.0.1) answers, leading zero bytes included.
  const KNOWN = [
    ["ff".repeat(32), "JEKNVnkbo3jma5nREBBJCDoXFVeKkD56V3xKrvRmWxFG"],
    ["000000283c793b7601135a0d90279ea342d8753a660c2951a12b4be9ee5f806e",
      "1112pwhSiFSLWg7UFVSsq7q9jqy5iUpvmb3jJU23uos"],
    ["a40a46836214c08d8bd533c2c83e721877e1a49451bedc93c0a5ff7ff43f71cc",
      "C3Lx76C5faERD6NBSA2EUSTpsg6MJud8gnzoPjKWgCGs"],
    ["ff".repeat(64),
      "67rpwLCuS5DGA8KGZXKsVQ7dnPb9goRLoKfgGbLfQg9WoLUgNY77E2jT11fem3coV9nAkguBACzrU1iyZM4B8roQ"],
    ["0064f3df39ad07948bbe113509ac4fe31cf2aa0a4a481aa265abfb51624ab64b2825dbf09097c1a09e2964ab17530f632f1c6197189c1e98f829f75fdc94f541",
      "1TXK1YAVxND8uzgrBw58VdKRaGPrzyHShEMSpNAMrjERGPQ5MWtc47JUZBxMmkvmje2ZJh53p4m2b2Uyd6ibBDa"],
    ["7eef56eac9e4d577da05f49d75ae14255d8ac4158ef586c16bf3d420f144736bb6cf6df136d0dd7240cde4fa21fe87474d8ce4641e5aa2432b2117bf519e4267",
      "3YCHBcuQ9wKmMLrMG4R6RCDrDaFdY8FZD39Shfkr6jhKT12Wd28hM9ycMQiZZRaPhueq36WN7CGoXy8o7TKQXJrA"],
  ] as const;
  // Public program and mint addresses: USDC and USDT, SPL Token and the
  // associated token account program.
  const PUBLIC_KEYS = [
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  ];
  // The signature in the DACS-Standard settlement-event-identity-v0.6 vector.
  const VECTOR_SIGNATURE = "6pc4LiB8KHAPvbUbkozrTcPL5zXspYBdATv5raNDyVbhiKjrKokLb9o111kxTD5KkPVd7UBSCcFcnWFkrJ82Hu6";

  test("the reference encoder gives bs58's answers", () => {
    for (const [hex, text] of KNOWN) {
      expect(base58(Buffer.from(hex, "hex"))).toBe(text);
      expect(base58Decode(text, hex.length / 2).toString("hex")).toBe(hex);
    }
  });

  test("44- and 43-character public keys, and 32 bytes of 0xff, are 32-byte keys", () => {
    const keys = [...PUBLIC_KEYS, KNOWN[0][1], KNOWN[1][1], KNOWN[2][1]];
    expect(keys.map((key) => key.length)).toContain(44);
    for (const key of keys) {
      expect(createSolanaSplSettlementIntent(authority({ payee: key }))).toMatchObject({ payee: key });
    }
  });

  test("random 32-byte values are accepted as keys", () => {
    for (let index = 0; index < 300; index += 1) {
      const key = base58(randomBytes(32));
      expect(() => createSolanaSplSettlementIntent(authority({ mint: key }))).not.toThrow();
    }
  });

  test("a 33-byte value is refused even at 44 characters or fewer", () => {
    const longer = base58(Buffer.concat([Buffer.from([1]), Buffer.alloc(32, 0)]));
    expect(longer.length).toBeLessThanOrEqual(45);
    expect(() => createSolanaSplSettlementIntent(authority({ mint: longer }))).toThrow();
  });

  async function settlesWith(signature: string) {
    return advanceSolanaSplSettlement(input({
      adapter: adapter({
        async prepareUnsignedTransfer(plan, attempt, fence) {
          return { ...(await adapter().prepareUnsignedTransfer(plan, attempt, fence)),
            unsignedMessageBase64: Buffer.from(signedWire([signature], "message"), "base64").subarray(65).toString("base64") };
        },
        async prepareSignedTransfer(plan, attempt, fence) {
          return {
            ...(await adapter().prepareSignedTransfer(plan, attempt, fence)),
            signature,
            signedTransactionBase64: signedWire([signature], "message"),
          };
        },
        reconcile: async () => ({ disposition: "settled-same", transfer: observed({ signature }) }),
      }),
    }));
  }

  test.each([
    ["the Standard vector's 87-character signature", VECTOR_SIGNATURE],
    ["an 88-character signature of 0xff bytes", KNOWN[3][1]],
    ["a signature with a leading zero byte", KNOWN[4][1]],
    ["a random signature", KNOWN[5][1]],
  ])("%s, carried first in the wire, settles", async (_name, signature) => {
    await expect(settlesWith(signature))
      .resolves.toMatchObject({ status: "settled", settlement: { txRef: { signature } } });
  });

  test("random 64-byte signatures, carried first in the wire, settle", async () => {
    for (let index = 0; index < 40; index += 1) {
      await expect(settlesWith(base58(randomBytes(64)))).resolves.toMatchObject({ status: "settled" });
    }
  });

  test("a wire that carries a neighbouring signature is refused", async () => {
    const signature = base58(Buffer.alloc(64, 7));
    const other = Buffer.alloc(64, 7);
    other[0] = 8;
    await expect(advanceSolanaSplSettlement(input({
      adapter: adapter({
        async prepareSignedTransfer(plan, attempt, fence) {
          return {
            ...(await adapter().prepareSignedTransfer(plan, attempt, fence)),
            signature,
            signedTransactionBase64: Buffer.concat([
              Buffer.from([1]), other, legacyMessage(Buffer.from("m")),
            ]).toString("base64"),
          };
        },
      }),
    }))).resolves.toEqual({ status: "indeterminate", reason: "solana-spl-prepared-transaction-invalid" });
  });
});

describe("claims and expiry sets", () => {
  test("an unknown status in an acquired-shaped claim is claim-invalid", async () => {
    await expect(advanceSolanaSplSettlement(input({
      store: {
        ...createInMemorySolanaSplSettlementStore(),
        claim: async (request) => ({
          status: "released", intent: request.intent, lease: { owner: "worker-a", generation: 1, expiresAt: 2_000 },
          attempts: [], expiredSignatures: [],
        }) as never,
      },
    }))).resolves.toEqual({ status: "indeterminate", reason: "solana-spl-settlement-store-claim-invalid" });
  });

  test.each<[string, (claim: { expiredSignatures: string[] }) => void]>([
    ["a signature that was never retained", (claim) => { claim.expiredSignatures = [SIGNATURE_2]; }],
    ["a duplicated signature", (claim) => { claim.expiredSignatures = [SIGNATURE_1, SIGNATURE_1]; }],
  ])("an expiry set with %s is corrupt", async (_name, change) => {
    const base = createInMemorySolanaSplSettlementStore();
    const store: SolanaSplSettlementStore = {
      ...base,
      async claim(request) {
        const claim = await base.claim(request);
        if (claim.status !== "acquired" || claim.attempts.length === 0) return claim;
        const copy = { ...claim, expiredSignatures: [...claim.expiredSignatures] };
        change(copy);
        return copy as never;
      },
    };
    const shared = await leaveAttemptOne(store, { reconcile: async () => lost });
    await expect(advanceSolanaSplSettlement(shared))
      .resolves.toEqual({ status: "indeterminate", reason: "solana-spl-retained-state-corrupt" });
  });

  // Attempts 1 and 2 expire in turn; attempt 3 is reconciled from a claim
  // holding two expiry rows.
  test.each([["settles on its first observation", 1], ["is reconciled again after a restart", 2]])(
    "after two expired attempts, attempt 3 %s", async (_name, settlesOn) => {
      const store = createInMemorySolanaSplSettlementStore();
      const prepareSignedTransfer = vi.fn(adapter().prepareSignedTransfer);
      let clock = 1_000;
      const seen = new Map<number, number>();
      const shared = input({
        store,
        now: () => clock,
        adapter: adapter({
          prepareSignedTransfer,
          reconcile: async (_intent, attempt) => {
            const count = (seen.get(attempt.attempt) ?? 0) + 1;
            seen.set(attempt.attempt, count);
            if (attempt.attempt === 3 && count >= settlesOn) {
              return { disposition: "settled-same", transfer: observed({ signature: attempt.signature }) };
            }
            return count === 1 ? lost : expiredFor(attempt);
          },
        }),
      });
      const owners = settlesOn === 1 ? ["worker-b", "worker-c"] : ["worker-b", "worker-c", "worker-d"];
      await expect(resumeAs(shared, () => { clock += 101; }, owners))
        .resolves.toMatchObject({ status: "settled", settlement: { txRef: { signature: signatureFor(3) } } });
      expect(prepareSignedTransfer.mock.calls.map((call) => call[1])).toEqual([1, 2, 3]);
    });
});

describe("reconciliation of a retained or fresh broadcast", () => {
  test("an absent-valid proof that only prints as a hash does not rebroadcast", async () => {
    const broadcastRetained = vi.fn(adapter().broadcastRetained);
    let reconciliations = 0;
    const shared = await leaveAttemptOne(createInMemorySolanaSplSettlementStore(), {
      broadcastRetained,
      reconcile: async () => (++reconciliations === 1 ? lost
        : { disposition: "absent-valid", authenticationHash: { toString: () => "d".repeat(64) } as never }),
    });
    await expect(advanceSolanaSplSettlement(shared))
      .resolves.toEqual({ status: "indeterminate", reason: "solana-spl-absence-proof-invalid" });
    expect(broadcastRetained).toHaveBeenCalledTimes(1);
  });

  test("a fresh broadcast not yet visible is waiting", async () => {
    await expect(advanceSolanaSplSettlement(input({
      adapter: adapter({ reconcile: async () => ({ disposition: "absent-valid", authenticationHash: "d".repeat(64) }) }),
    }))).resolves.toEqual({ status: "waiting", reason: "solana-spl-broadcast-not-yet-visible" });
  });
});

describe("stored intents the core cannot compare", () => {
  test.each([
    ["a NaN phaseIndex", { phaseIndex: Number.NaN }, "solana-spl-settlement-store-intent-invalid"],
    ["a lone surrogate in jobId", { jobId: "\ud800" }, "solana-spl-settlement-store-intent-invalid"],
    ["a null flag", { createPayeeAtaIfMissing: null }, "solana-spl-settlement-store-intent-mismatch"],
  ])("a stored intent with %s is refused without effects", async (_name, change, reason) => {
    const preflightSpy = vi.fn(adapter().preflight);
    await expect(advanceSolanaSplSettlement(input({
      store: {
        ...createInMemorySolanaSplSettlementStore(),
        claim: async (request) => ({
          status: "acquired", intent: { ...request.intent, ...change },
          lease: { owner: "worker-a", generation: 1, expiresAt: 2_000 }, attempts: [], expiredSignatures: [],
        }) as never,
      },
      adapter: adapter({ preflight: preflightSpy }),
    }))).resolves.toEqual({ status: "indeterminate", reason });
    expect(preflightSpy).not.toHaveBeenCalled();
  });
});

describe("the in-memory store fences and checks every write", () => {
  async function opened() {
    const store = createInMemorySolanaSplSettlementStore();
    const intent = createSolanaSplSettlementIntent(authority());
    await store.claim({ intent, owner: "worker-a", now: 1_000, leaseDurationMs: 100 });
    const fence = { settlementKey: intent.settlementKey, bindingHash: intent.bindingHash, owner: "worker-a", generation: 1 };
    const attemptFor = async (n: number, other: Partial<SolanaSplSignedAttempt> = {}) => {
      const prepared = {
        ...(await adapter().prepareSignedTransfer({ intent } as never, n, { assertCurrent: async () => undefined } as never)),
        ...other,
      };
      const { attemptHash: _ignored, ...unsigned } = prepared as SolanaSplSignedAttempt;
      return { ...unsigned, attemptHash: sha256Hex(canonicalize(unsigned)) } as SolanaSplSignedAttempt;
    };
    return { store, intent, fence, attemptFor };
  }

  test("the same owner at an older generation, or another binding, is stale", async () => {
    const { store, intent, fence, attemptFor } = await opened();
    // The lease expires and the same owner reclaims it at generation 2.
    await store.claim({ intent, owner: "worker-a", now: 1_100, leaseDurationMs: 100 });
    await expect(store.isCurrent({ ...fence, now: 1_101 })).resolves.toBe(false);
    await expect(store.recordAttempt({ ...fence, attempt: await attemptFor(1) })).resolves.toMatchObject({ status: "stale" });
    const current = { ...fence, generation: 2 };
    await expect(store.isCurrent({ ...current, now: 1_101 })).resolves.toBe(true);
    await expect(store.isCurrent({ ...current, bindingHash: HASH, now: 1_101 })).resolves.toBe(false);
    await expect(store.isCurrent({ ...current, owner: "worker-z", now: 1_101 })).resolves.toBe(false);
    await expect(store.isCurrent({ ...current, settlementKey: HASH, now: 1_101 })).resolves.toBe(false);
    await expect(store.markAttemptExpired({
      ...fence, signature: SIGNATURE_1, observedBlockHeight: 1, commitmentLevel: "finalized", authenticationHash: HASH,
    })).resolves.toMatchObject({ status: "stale" });
    await expect(store.recordSettlement({ ...fence, signature: SIGNATURE_1, settlement: {} as never }))
      .resolves.toMatchObject({ status: "stale" });
    await expect(store.recordFailure({
      ...fence, failure: { errorClass: "permanent", reason: "solana-spl-insufficient-token-balance" },
    })).resolves.toMatchObject({ status: "stale" });
  });

  test("a lease is held strictly before its expiry instant", async () => {
    const { store, intent, fence } = await opened();
    await expect(store.isCurrent({ ...fence, now: 1_099 })).resolves.toBe(true);
    await expect(store.isCurrent({ ...fence, now: 1_100 })).resolves.toBe(false);
    await expect(store.claim({ intent, owner: "worker-b", now: 1_099, leaseDurationMs: 100 }))
      .resolves.toMatchObject({ status: "waiting" });
    await expect(store.claim({ intent, owner: "worker-b", now: 1_100, leaseDurationMs: 100 }))
      .resolves.toMatchObject({ status: "acquired", lease: { generation: 2 } });
  });

  test("recordAttempt refuses gaps, renumbered and cross-key signatures, and repeats exactly", async () => {
    const { store, fence, attemptFor } = await opened();
    await expect(store.recordAttempt({ ...fence, attempt: await attemptFor(2) })).resolves.toMatchObject({ status: "conflict" });
    const first = await attemptFor(1);
    await expect(store.recordAttempt({ ...fence, attempt: first })).resolves.toEqual({ status: "recorded" });
    await expect(store.recordAttempt({ ...fence, attempt: first })).resolves.toEqual({ status: "existing" });
    await expect(store.recordAttempt({ ...fence, attempt: await attemptFor(1, { preparedAt: 5 }) }))
      .resolves.toMatchObject({ status: "conflict" });
    const other = createSolanaSplSettlementIntent(authority({ phaseIndex: 3 }));
    await store.claim({ intent: other, owner: "worker-a", now: 1_000, leaseDurationMs: 100 });
    const otherFence = { settlementKey: other.settlementKey, bindingHash: other.bindingHash, owner: "worker-a", generation: 1 };
    await expect(store.recordAttempt({ ...otherFence, attempt: { ...first, authorityHash: other.bindingHash } }))
      .resolves.toMatchObject({ status: "conflict" });
  });

  test("markAttemptExpired refuses unknown signatures, invalid and conflicting evidence", async () => {
    const { store, fence, attemptFor } = await opened();
    await store.recordAttempt({ ...fence, attempt: await attemptFor(1) });
    const evidence = {
      signature: SIGNATURE_1, observedBlockHeight: 10_002, commitmentLevel: "finalized" as const,
      authenticationHash: "e".repeat(64),
    };
    await expect(store.markAttemptExpired({ ...fence, ...evidence, signature: SIGNATURE_2 }))
      .resolves.toMatchObject({ status: "conflict" });
    await expect(store.markAttemptExpired({ ...fence, ...evidence, observedBlockHeight: 10_001 }))
      .resolves.toMatchObject({ status: "conflict" });
    for (const commitmentLevel of ["confirmed", "processed"]) {
      await expect(store.markAttemptExpired({ ...fence, ...evidence, commitmentLevel: commitmentLevel as never }))
        .resolves.toMatchObject({ status: "conflict" });
    }
    await expect(store.markAttemptExpired({ ...fence, ...evidence })).resolves.toEqual({ status: "recorded", expiryEvidence: evidence });
    await expect(store.markAttemptExpired({ ...fence, ...evidence })).resolves.toEqual({ status: "existing", expiryEvidence: evidence });
    await expect(store.markAttemptExpired({ ...fence, ...evidence, observedBlockHeight: 10_003 }))
      .resolves.toMatchObject({ status: "conflict" });
  });

  test("recordSettlement refuses unknown signatures and different settlements, and repeats exactly", async () => {
    const { store, fence, attemptFor } = await opened();
    await store.recordAttempt({ ...fence, attempt: await attemptFor(1) });
    const settlement = { authenticationHash: "c".repeat(64) } as never;
    await expect(store.recordSettlement({ ...fence, signature: SIGNATURE_2, settlement })).resolves.toMatchObject({ status: "conflict" });
    await expect(store.recordSettlement({ ...fence, signature: SIGNATURE_1, settlement })).resolves.toEqual({ status: "recorded" });
    await expect(store.recordSettlement({ ...fence, signature: SIGNATURE_1, settlement })).resolves.toEqual({ status: "existing" });
    await expect(store.recordSettlement({ ...fence, signature: SIGNATURE_1, settlement: { authenticationHash: HASH } as never }))
      .resolves.toMatchObject({ status: "conflict" });
  });
});
