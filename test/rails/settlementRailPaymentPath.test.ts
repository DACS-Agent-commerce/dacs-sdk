// Payment-path guards in the x402 and direct ERC-20 settlement wrappers and
// cores: the effect fence reaches the rail, the request's phase is the one
// bound, only the requirement matching the agreement is signed, and malformed
// finality or network input is refused before any I/O.
import { x402Client, x402HTTPClient } from "@x402/fetch";
import { describe, expect, test, vi } from "vitest";

import type { SettleRequest, SettleResult } from "../../src/agent/runSessionCore.js";
import { evmErc20Settle, evmErc20SettleCore, type EvmErc20Rail } from "../../src/rails/evmErc20.js";
import {
  settlementKey, type SettlementEffectFence, type SettlementIdempotencyStore,
} from "../../src/rails/idempotency.js";
import {
  dacsX402AuthorizationNonce, x402Settle, x402SettleCore, type X402ClientLike, type X402Rail,
} from "../../src/rails/x402.js";

const JOB = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NETWORK = "eip155:84532";
const PAYEE = `0x${"1".repeat(40)}`;
const OTHER = `0x${"9".repeat(40)}`;
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

const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
function coreRun(accepts: unknown[], overrides: Record<string, unknown> = {}) {
  const signed: Array<{ payTo: string; amount: string }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (new Headers(init?.headers).get("PAYMENT-SIGNATURE") === null) {
      const challenge = { x402Version: 2, resource: { url: String(url), mimeType: "application/json" }, accepts, extensions: {} };
      return new Response(JSON.stringify(challenge), { status: 402, headers: { "PAYMENT-REQUIRED": encode(challenge) } });
    }
    return new Response("ok", { status: 200, headers: {
      "PAYMENT-RESPONSE": encode({ success: true, transaction: TX, network: NETWORK, payer: PAYER, amount: "1000000" }),
    } });
  });
  // The real @x402 v2 client; only the EIP-3009 signer is replaced. Its
  // default selector signs accepts[0], so the SDK must narrow the list.
  const client = new x402HTTPClient(new x402Client().register("eip155:*", {
    scheme: "exact",
    async createPaymentPayload(version, requirements) {
      signed.push({ payTo: String(requirements.payTo), amount: String(requirements.amount) });
      return { x402Version: version, payload: { authorization: { from: PAYER, to: requirements.payTo, value: requirements.amount,
        validAfter: "0", validBefore: "4102444800", nonce: `0x${"0".repeat(64)}` }, signature: `0x${"44".repeat(65)}` } };
    },
  })) as unknown as X402ClientLike;
  const assertFinalityContext = vi.fn(async () => undefined);
  const authenticateTransfer = vi.fn(async () => ({
    chainId: 84532, transactionHash: "a".repeat(64), logIndex: 7, blockNumber: 100, confirmations: 2, finalityObservedAt: 1,
  }));
  const run = () => x402SettleCore({
    paywallUrl: "https://seller.example/r", network: NETWORK, recipientEvm: PAYEE, amount: "1000000",
    asset: USDC, finalityBlocks: 2, ...overrides,
  } as never, {
    client, fetchImpl: fetchImpl as unknown as typeof fetch, transportPolicy: { mode: "insecure-test" },
    payerAddress: PAYER, assertFinalityContext, authenticateTransfer,
  });
  return { run, signed, fetchImpl, assertFinalityContext };
}
const requirement = (payTo: string, amount: string) => ({
  scheme: "exact", network: NETWORK, amount, asset: USDC, payTo, maxTimeoutSeconds: 120, extra: { name: "USDC", version: "2" },
});

describe("x402 §4.1 abort guard reaches the signer", () => {
  test("with a non-matching requirement listed first, only the matching one is signed", async () => {
    const h = coreRun([requirement(OTHER, "5000000"), requirement(PAYEE, "1000000")]);
    await expect(h.run()).resolves.toMatchObject({ ok: true });
    expect(h.signed).toEqual([{ payTo: PAYEE, amount: "1000000" }]);
  });
});

describe("non-positive finality policy is refused before any I/O", () => {
  test.each([0, -1, 1.5])("x402SettleCore finalityBlocks=%s", async (finalityBlocks) => {
    const h = coreRun([requirement(PAYEE, "1000000")], { finalityBlocks });
    await expect(h.run()).rejects.toThrow(/finalityBlocks must be a positive safe integer/);
    expect(h.assertFinalityContext).not.toHaveBeenCalled();
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
  test("x402Settle refuses a rail without a positive finality policy", () => {
    expect(() => x402Settle({ address: PAYER, finalityBlocks: 0, settle: async () => OK }, x402Cfg))
      .toThrow(/positive finality policy/);
  });
  test("evmErc20Settle refuses a rail without a positive finality policy", () => {
    expect(() => evmErc20Settle({ address: PAYER, finalityBlocks: 0, settle: async () => OK }, evmCfg))
      .toThrow(/positive finality policy/);
  });
  test("evmErc20SettleCore finalityBlocks=0 never transfers", async () => {
    const transfer = vi.fn(async () => TX);
    const getChainId = vi.fn(async () => 84532);
    await expect(evmErc20SettleCore({ ...evmCfg, amount: "1000000", finalityBlocks: 0 },
      { address: PAYER, transfer, finalityClient: { getChainId } as never }))
      .rejects.toThrow(/finalityBlocks must be a positive safe integer/);
    expect(transfer).not.toHaveBeenCalled();
    expect(getChainId).not.toHaveBeenCalled();
  });
});

describe("CAIP-2 network grammar is exact", () => {
  test.each(["eip155:084532", "eip155:0", "xeip155:84532", "eip155:84532x"])(
    "x402SettleCore refuses %s before any I/O", async (network) => {
      const h = coreRun([{ ...requirement(PAYEE, "1000000"), network }], { network });
      await expect(h.run()).rejects.toThrow(/unsupported network/);
      expect(h.assertFinalityContext).not.toHaveBeenCalled();
      expect(h.fetchImpl).not.toHaveBeenCalled();
    });
  test.each(["xeip155:84532", "eip155:84532x"])("evmErc20SettleCore refuses %s before any transfer", async (network) => {
    const transfer = vi.fn(async () => TX);
    await expect(evmErc20SettleCore({ ...evmCfg, network, amount: "1000000", finalityBlocks: 2 },
      { address: PAYER, transfer, finalityClient: { getChainId: async () => 84532 } as never }))
      .rejects.toThrow(/unsupported network/);
    expect(transfer).not.toHaveBeenCalled();
  });
});
