// The x402 and direct ERC-20 wrappers propagate the store's effect fence
// and bind the settlement request's phase.
import { describe, expect, test, vi } from "vitest";

import type { SettleRequest, SettleResult } from "../../src/agent/runSessionCore.js";
import { evmErc20Settle, type EvmErc20Rail } from "../../src/rails/evmErc20.js";
import {
  settlementKey, type SettlementEffectFence, type SettlementIdempotencyStore,
} from "../../src/rails/idempotency.js";
import {
  dacsX402AuthorizationNonce, x402Settle, type X402Rail,
} from "../../src/rails/x402.js";

const JOB = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NETWORK = "eip155:84532";
const PAYEE = `0x${"1".repeat(40)}`;
const PAYER = `0x${"2".repeat(40)}`;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const TX = `0x${"a".repeat(64)}`;
const OK: SettleResult = {
  ok: true, txHash: TX, chainId: NETWORK, payer: PAYER, payee: PAYEE,
  finality: { model: "block-depth", finalityBlocks: 2 },
};
const request = (rail: string, phaseIndex?: number): SettleRequest => ({
  rail, phase: rail, jobId: JOB, amount: "1000000", asset: "USDC",
  payee: "did:demos:seller", expectedPayee: PAYEE, ...(phaseIndex === undefined ? {} : { phaseIndex }),
});
const x402Cfg = { url: "https://seller.example/r", network: NETWORK, recipientEvm: PAYEE, asset: USDC };
const evmCfg = { tokenAddress: USDC, network: NETWORK, recipientEvm: PAYEE };

// A store that hands submit one recognisable fence, as the durable store does.
function fencingStore() {
  const fence = {
    key: "k", bindingHash: "b", owner: "o", generation: 1, stage: "submit",
    assertCurrent: vi.fn(async () => undefined),
  } as unknown as SettlementEffectFence;
  const keys: string[] = [];
  const bindings: Array<{ phaseIndex: number; effectIdentity?: string }> = [];
  const store: SettlementIdempotencyStore = {
    async once(key, binding, submit) {
      keys.push(key);
      bindings.push(binding as never);
      return await submit(fence) as SettleResult;
    },
  };
  return { fence, store, keys, bindings };
}

describe("the store's effect fence reaches the rail (#43 A2)", () => {
  test("x402Settle hands the store's effect fence to the rail", async () => {
    const { fence, store } = fencingStore();
    const settle = vi.fn<X402Rail["settle"]>(async () => OK);
    await x402Settle({ address: PAYER, finalityBlocks: 2, settle }, x402Cfg, { store })(request("pay-x402", 0));
    expect(settle).toHaveBeenCalledOnce();
    expect(settle.mock.calls[0]![1]).toBe(fence);
  });

  test("evmErc20Settle hands the store's effect fence to the rail", async () => {
    const { fence, store } = fencingStore();
    const settle = vi.fn<EvmErc20Rail["settle"]>(async () => OK);
    await evmErc20Settle({ address: PAYER, finalityBlocks: 2, settle }, evmCfg, { store })(request("pay-evm-erc20", 0));
    expect(settle).toHaveBeenCalledOnce();
    expect(settle.mock.calls[0]![1]).toBe(fence);
  });
});

describe("the settlement request's phase is the one bound", () => {
  test("a paywall default never overrides the request's phaseIndex (x402)", async () => {
    const { store, keys, bindings } = fencingStore();
    const settle = vi.fn<X402Rail["settle"]>(async () => OK);
    await x402Settle({ address: PAYER, finalityBlocks: 2, settle }, { ...x402Cfg, phaseIndex: 2 },
      { store })(request("pay-x402", 0));
    expect(settle.mock.calls[0]![0].phaseIndex).toBe(0);
    expect(keys).toEqual([settlementKey("pay-x402", JOB, 0)]);
    expect(bindings[0]!.effectIdentity).toBe(await dacsX402AuthorizationNonce({ jobId: JOB, phaseIndex: 0 }));
  });

  test("the ERC-20 key and binding carry the request's phase, and default to phase 0", async () => {
    const { store, keys, bindings } = fencingStore();
    const settle = vi.fn<EvmErc20Rail["settle"]>(async () => OK);
    const pay = evmErc20Settle({ address: PAYER, finalityBlocks: 2, settle }, evmCfg, { store });
    await pay(request("pay-evm-erc20", 1));
    await pay(request("pay-evm-erc20"));
    expect(keys).toEqual([settlementKey("pay-evm-erc20", JOB, 1), settlementKey("pay-evm-erc20", JOB, 0)]);
    expect(bindings.map((binding) => binding.phaseIndex)).toEqual([1, 0]);
  });
});
