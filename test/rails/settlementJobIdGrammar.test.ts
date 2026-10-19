import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import type { SettleRequest, SettleResult } from "../../src/agent/runSessionCore.js";
import { sha256Hex } from "../../src/canonical/index.js";
import { deriveAp2IdempotencyKey } from "../../src/rails/ap2.js";
import { evmErc20Settle, type EvmErc20Rail } from "../../src/rails/evmErc20.js";
import {
  createIdempotencyStore, createInMemorySettlementLog, settlementBindingHash, settlementKey,
  type SettlementBinding, type SettlementIdempotencyStore, type SettlementLog,
} from "../../src/rails/idempotency.js";
import { solanaSplSettlementKey } from "../../src/rails/solanaSpl.js";
import {
  dacsX402AuthorizationNonce, legacyDacsX402AuthorizationNonce, x402Settle, type X402Rail,
} from "../../src/rails/x402.js";
import { x402PaywallFulfilmentKey, x402PaywallSettlementKey } from "../../src/rails/x402Paywall.js";
import { x402Eip3009Nonce } from "../../src/seller/paymentIntake.js";

// CORE JID-3 at the settlement entry points: the pinned Standard's job-id
// grammar vectors. A job id that fails JID-1 validation must be refused before
// any key, SB-3 nonce or store call, and before the rail is invoked.
const GRAMMAR = JSON.parse(readFileSync(new URL(
  "../../vendor/DACS-Standard/conformance/vectors/security/job-id-grammar-v0.1.json",
  import.meta.url,
), "utf8")) as { grammar: string; vectors: Array<{
  name: string; operation: string; expected: "pass" | "fail" | "error"; jobId?: unknown;
  want: { failureStage?: string; canonicalJobId?: string };
}> };
const MALFORMED = GRAMMAR.vectors.filter((vector) => vector.want.failureStage === "job-id-validation" &&
  vector.operation !== "compare");
const CANONICAL = GRAMMAR.vectors.filter((vector) => vector.operation === "validate" && vector.expected === "pass");

const NETWORK = "eip155:84532";
const PAYEE = `0x${"1".repeat(40)}`;
const PAYER = `0x${"2".repeat(40)}`;
// The published Base Sepolia USDC contract.
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const success: SettleResult = {
  ok: true, txHash: `0x${"a".repeat(64)}`, chainId: NETWORK, payer: PAYER, payee: PAYEE,
  finality: { model: "block-depth", finalityBlocks: 2 },
};

function harness(mode: "x402" | "evm") {
  const calls = { rail: 0, store: 0 };
  const store: SettlementIdempotencyStore = {
    async once(_key, _binding, submit) {
      calls.store += 1;
      return await submit() as SettleResult;
    },
  };
  const settle = async () => {
    calls.rail += 1;
    return success;
  };
  const request = (jobId: unknown): SettleRequest => ({
    rail: mode === "x402" ? "pay-x402" : "pay-evm-erc20", phase: mode === "x402" ? "pay-x402" : "pay-evm-erc20",
    jobId: jobId as string, phaseIndex: 0, amount: "1000000", asset: "USDC",
    payee: "did:demos:seller", expectedPayee: PAYEE,
  });
  const run = mode === "x402"
    ? x402Settle({ address: PAYER, finalityBlocks: 2, settle } satisfies X402Rail,
      { url: "https://seller.example/resource", network: NETWORK, recipientEvm: PAYEE, asset: USDC }, { store })
    : evmErc20Settle({ address: PAYER, finalityBlocks: 2, settle } satisfies EvmErc20Rail,
      { tokenAddress: USDC, network: NETWORK, recipientEvm: PAYEE }, { store });
  return { calls, settle: (jobId: unknown) => run(request(jobId)) };
}

describe.each(["x402", "evm"] as const)("%s settlement admits only a canonical JID-1 jobId", (mode) => {
  test("the Standard's grammar and vector sets are the ones pinned here", () => {
    expect(GRAMMAR.grammar).toBe("^[0-7][0-9A-HJKMNP-TV-Z]{25}$");
    expect(MALFORMED).toHaveLength(19);
    expect(CANONICAL.map(({ name }) => name).sort()).toEqual([
      "canonical-ulid", "highest-syntactic-value", "lowest-syntactic-value",
    ]);
  });

  test.each(MALFORMED.map((vector) => [vector.name, vector] as const))(
    "%s is refused before any key, store or rail call",
    async (_name, vector) => {
      const h = harness(mode);
      expect(() => h.settle(vector.jobId)).toThrow(/settlement jobId must be a canonical uppercase ULID/);
      expect(h.calls).toEqual({ rail: 0, store: 0 });
    },
  );

  test.each(CANONICAL.map((vector) => [vector.name, vector] as const))(
    "%s settles once, under the byte-exact id",
    async (_name, vector) => {
      const h = harness(mode);
      await expect(h.settle(vector.jobId)).resolves.toMatchObject({ ok: true });
      expect(vector.want.canonicalJobId).toBe(vector.jobId);
      expect(h.calls).toEqual({ rail: 1, store: 1 });
    },
  );
});

// CORE JID-3 at the jobId-specific derivations the rails use: the settlement
// key (pay-dem, x402, ERC-20), the pay-solana-spl key, the buyer's and the
// seller's SB-3 EIP-3009 nonce, the seller paywall's settlement and fulfilment
// keys, and the AP2-6 provider idempotency key (AP2-6: "validate jobId under
// CORE JID-1 before hashing").
describe("jobId-specific derivations admit only a canonical JID-1 jobId", () => {
  test.each(MALFORMED.map((vector) => [vector.name, vector] as const))("%s is refused before derivation", async (_name, vector) => {
    const jobId = vector.jobId as string;
    expect(() => settlementKey("pay-dem", jobId, 0)).toThrow(/settlement key jobId must be a canonical uppercase ULID/);
    expect(() => solanaSplSettlementKey({ jobId, railId: "solana-devnet-usdc", phaseIndex: 0 }))
      .toThrow(/pay-solana-spl: jobId must be a canonical uppercase ULID/);
    await expect(dacsX402AuthorizationNonce({ jobId, phaseIndex: 0 }))
      .rejects.toThrow(/x402 DACS binding jobId must be a canonical uppercase ULID/);
    expect(() => deriveAp2IdempotencyKey(jobId, 0)).toThrow(/pay-ap2: jobId must be a canonical uppercase ULID/);
    expect(() => x402Eip3009Nonce(jobId, 0)).toThrow(/jobId must be a canonical uppercase ULID/);
    expect(() => x402PaywallSettlementKey({ jobId, phaseIndex: 0 }))
      .toThrow(/x402 paywall settlement key requires a canonical uppercase ULID jobId/);
    expect(() => x402PaywallFulfilmentKey({ jobId, phaseIndex: 0 }))
      .toThrow(/x402 paywall fulfilment key requires a canonical uppercase ULID jobId/);
  });

  test.each(CANONICAL.map((vector) => [vector.name, vector] as const))("%s derives from the byte-exact id", async (_name, vector) => {
    const jobId = vector.jobId as string;
    expect(settlementKey("pay-dem", jobId, 3)).toBe(`pay-dem:${jobId}:3`);
    expect(solanaSplSettlementKey({ jobId, railId: "solana-devnet-usdc", phaseIndex: 3 })).toMatch(/^[0-9a-f]{64}$/);
    await expect(dacsX402AuthorizationNonce({ jobId, phaseIndex: 3 }))
      .resolves.toBe(await legacyDacsX402AuthorizationNonce({ jobId, phaseIndex: 3 }));
    expect(deriveAp2IdempotencyKey(jobId, 3)).toBe(sha256Hex(`dacs-ap2-idem:v1:${jobId}:3`));
    expect(x402Eip3009Nonce(jobId, 3)).toBe(await dacsX402AuthorizationNonce({ jobId, phaseIndex: 3 }));
    expect(x402PaywallSettlementKey({ jobId, phaseIndex: 3 })).toMatch(/^dacs:x402-settlement:[0-9a-f]{64}$/);
    expect(x402PaywallFulfilmentKey({ jobId, phaseIndex: 3 })).toMatch(/^dacs:x402-fulfil:[0-9a-f]{64}$/);
  });

  test("the frozen pre-JID-1 x402 derivation vectors stay reproducible only through the named legacy helper", async () => {
    await expect(dacsX402AuthorizationNonce({ jobId: "practice-dacs-0001", phaseIndex: 3 })).rejects.toThrow(/canonical/);
    expect(() => x402Eip3009Nonce("practice-dacs-0001", 3)).toThrow(/canonical/);
    expect(await legacyDacsX402AuthorizationNonce({ jobId: "practice-dacs-0001", phaseIndex: 3 }))
      .toBe("0x2fc3598e85489ed2fb4d2bf9f4eb5cc8dd6998eec89645d64450f9630240e1ff");
    // The pinned AP2 corpus withdrew its Unicode key vector: the current
    // vector expects an error, and no AP2 legacy derivation exists.
    expect(() => deriveAp2IdempotencyKey("café-job", 0)).toThrow(/canonical/);
  });
});

// CORE JID-1/JID-3 at the exported generic store and binding hasher: a job id
// (or any other binding string) is checked as presented, never NFC-repaired
// first. The Kelvin sign U+212A normalizes to ASCII "K", so a repaired alias
// would share the canonical job's key, binding hash and payment.
describe("the generic settlement store and binding hash refuse a binding as presented", () => {
  const JOB = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const KELVIN = JOB.replace("K", "\u212A");
  const binding = (override: Record<string, unknown> = {}) => ({
    bindingVersion: "1", railId: "pay-x402", jobId: JOB, phaseIndex: 0, phase: "pay-x402",
    amount: "1", agreementAsset: "USDC", settlementAsset: "USDC", payer: PAYER, payee: PAYEE,
    network: NETWORK, finality: { model: "block-depth", finalityBlocks: 2 }, ...override,
  }) as unknown as SettlementBinding;
  function counted() {
    const calls = { log: 0, submit: 0, reconcile: 0 };
    const inner = createInMemorySettlementLog();
    const log: SettlementLog = {
      claimIntent: async (input) => { calls.log += 1; return inner.claimIntent(input); },
      isCurrent: async (input) => { calls.log += 1; return inner.isCurrent(input); },
      grantRecovery: async (input) => { calls.log += 1; return inner.grantRecovery(input); },
      putOutcome: async (input) => { calls.log += 1; return inner.putOutcome(input); },
      releaseIntent: async (input) => { calls.log += 1; return inner.releaseIntent(input); },
    };
    return { calls, store: createIdempotencyStore(log) };
  }
  const ALIASES: Array<[string, Record<string, unknown>]> = [
    ["a Kelvin-sign jobId alias", { jobId: KELVIN }],
    ...MALFORMED.map((vector): [string, Record<string, unknown>] => [vector.name, { jobId: vector.jobId }]),
    ["a decomposed payee", { payee: `${PAYEE}e\u0301` }],
    ["a decomposed settlement asset", { settlementAsset: "USDC\u0301" }],
    ["a decomposed finality model", { finality: { model: "block-depthe\u0301", finalityBlocks: 2 } }],
  ];

  test("the Kelvin alias is not the canonical id, but NFC would repair it into it", () => {
    expect(KELVIN).not.toBe(JOB);
    expect(KELVIN.normalize("NFC")).toBe(JOB);
  });

  test.each(ALIASES)("%s is refused by the binding hash", (_name, override) => {
    expect(() => settlementBindingHash(binding(override))).toThrow();
  });

  test.each(ALIASES)("%s reaches neither the log nor the payment", async (_name, override) => {
    const { calls, store } = counted();
    await expect(store.once(`pay-x402:${JOB}:0`, binding(override), async () => {
      calls.submit += 1;
      return success;
    }, async () => {
      calls.reconcile += 1;
      return null;
    })).rejects.toThrow();
    expect(calls).toEqual({ log: 0, submit: 0, reconcile: 0 });
  });

  test("the canonical binding still hashes and settles once", async () => {
    expect(settlementBindingHash(binding())).toMatch(/^[0-9a-f]{64}$/);
    const { calls, store } = counted();
    await expect(store.once(`pay-x402:${JOB}:0`, binding(), async () => {
      calls.submit += 1;
      return success;
    })).resolves.toMatchObject({ ok: true });
    expect(calls.submit).toBe(1);
  });
});
