import { readFileSync } from "node:fs";

import { createStripeAp2Integration } from "../../src/rails/ap2Stripe.js";
import { createDacsX402BuyerEvmChallengeClient } from "../../src/rails/x402BuyerDacsEvm.js";
import { advanceAp2Settlement } from "../../src/rails/ap2.js";
import { advanceSolanaSplSettlement } from "../../src/rails/solanaSpl.js";
import { advanceX402BuyerSettlement } from "../../src/rails/x402BuyerSettlement.js";
import { prepareX402BuyerSettlement, createX402BuyerPaidRequestTransport, createX402BuyerRetainedDisclosureRecovery } from "../../src/rails/x402BuyerTransport.js";
import { x402PaywallCore, createX402Paywall } from "../../src/rails/x402Paywall.js";
import { describe, expect, it, vi } from "vitest";
import { x402Settle, x402SettleCore, createX402Rail } from "../../src/rails/x402.js";
import { payDemSettle, payDemSettleCore, createPayDemRail } from "../../src/rails/payDem.js";
import { evmErc20Settle, evmErc20SettleCore, createEvmErc20Rail } from "../../src/rails/evmErc20.js";
import { payD402Settle, payD402SettleCore, createPayD402Rail } from "../../src/rails/payD402.js";
import { authorizeAlternativePayment } from "../../src/rails/payAlternative.js";
import { settleFromRail } from "../../src/registry/dispatch.js";
import { CORRECTIVE_PROFILE, type ProfileExecutionPolicy } from "../../src/profile.js";
import type { SettleRequest } from "../../src/agent/runSessionCore.js";

const effects = vi.hoisted(() => ({ sign: vi.fn(), confirm: vi.fn(), broadcast: vi.fn() }));
vi.mock("@kynesyslabs/demosdk/websdk", () => ({
  Demos: class {
    tx = { confirm: effects.confirm };
    connect = vi.fn();
    connectWallet = vi.fn();
    getAddress = () => "11".repeat(32);
    transfer = effects.sign;
    broadcast = effects.broadcast;
    getNetworkInfo = vi.fn();
    nodeCall = vi.fn();
    waitForNonce = vi.fn();
  },
}));
vi.mock("@kynesyslabs/demosdk/d402/client", () => ({ D402Client: class {} }));

const paywall = { url: "https://seller.example/payment", network: "eip155:84532",
  recipientEvm: `0x${"22".repeat(20)}`, asset: `0x${"33".repeat(20)}` };
const req: SettleRequest = { rail: "demos-native:DEM", phase: "pay-dem", phaseIndex: 2,
  amount: "1", asset: "DEM", payee: `did:demos:agent:${"22".repeat(32)}`,
  expectedPayee: `did:demos:agent:${"22".repeat(32)}`, jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D" };

type Options = ProfileExecutionPolicy & { store?: never };
const bridges = [
  ["x402", (rail: never, opts?: Options) => x402Settle(rail, paywall, opts)],
  ["DEM", (rail: never, opts?: Options) => payDemSettle(rail, {}, opts)],
  ["ERC-20", (rail: never, opts?: Options) => evmErc20Settle(rail, {
    tokenAddress: paywall.asset, network: paywall.network, recipientEvm: paywall.recipientEvm }, opts)],
  ["D402", (rail: never, opts?: Options) => payD402Settle(rail, {
    url: paywall.url, recipient: paywall.recipientEvm }, opts)],
] as const;

describe("public DACS payment profile admission", () => {
  it.each(bridges)("%s refuses absent/live/asserted policy before inspecting any dependency", (_name, bridge) => {
    const accessed = vi.fn();
    const rail = new Proxy({}, { get: accessed, getOwnPropertyDescriptor: accessed }) as never;
    for (const policy of [undefined, {}, { executionMode: "live" },
      { profileAdmission: CORRECTIVE_PROFILE }, Object.create({ executionMode: "simulation" })]) {
      expect(() => bridge(rail, policy as Options)).toThrow(/unreleased/);
    }
    const options = { get store() { accessed(); return undefined; }, profileAdmission: CORRECTIVE_PROFILE };
    expect(() => bridge(rail, options as Options)).toThrow(/unreleased/);
    expect(accessed).not.toHaveBeenCalled();
  });

  it.each(bridges)("%s refuses policy accessors and proxies without invoking them", (_name, bridge) => {
    const getter = vi.fn();
    const policy = Object.defineProperty({}, "executionMode", { get: getter });
    expect(() => bridge({} as never, policy)).toThrow(/stable data/);
    expect(() => bridge({} as never, new Proxy({}, { getOwnPropertyDescriptor: getter }))).toThrow(/stable data/);
    expect(getter).not.toHaveBeenCalled();
  });

  // Only explicit, locally injected simulation rails may reach a payment callback.
  it.each(["x402", "DEM"])("%s permits an explicitly injected simulation rail", async (kind) => {
    const settle = vi.fn(async () => { throw new Error("simulation-payment-boundary"); });
    const rail = { address: kind === "DEM" ? "11".repeat(32) : `0x${"11".repeat(20)}`,
      finalityBlocks: 2, settle };
    const policy = { executionMode: "simulation" as "simulation" | "live" };
    const bridge = kind === "DEM"
      ? payDemSettle(rail, {}, policy)
      : x402Settle(rail, paywall, policy);
    policy.executionMode = "live"; // the admitted local mode was captured at construction.
    await expect(bridge(kind === "DEM" ? req : { ...req, phase: "pay-x402", asset: "USDC",
      payee: paywall.recipientEvm, expectedPayee: paywall.recipientEvm }))
      .rejects.toThrow("simulation-payment-boundary");
    expect(settle).toHaveBeenCalledOnce();
  });

  it("refuses connected wallet and seller paywall factories before any dependency", async () => {
    const touched = vi.fn();
    const input = new Proxy({}, { get: touched, getOwnPropertyDescriptor: touched }) as never;
    for (const factory of [createX402Rail, createPayDemRail, createEvmErc20Rail, createPayD402Rail]) {
      await expect(factory(input)).rejects.toThrow(/unreleased/);
      await expect(factory({ executionMode: "simulation", profileAdmission: CORRECTIVE_PROFILE } as never))
        .rejects.toThrow(/unreleased/);
    }
    await expect(createX402Paywall(input, input)).rejects.toThrow(/unreleased/);
    await expect(createDacsX402BuyerEvmChallengeClient(input)).rejects.toThrow(/unreleased/);
    expect(() => createStripeAp2Integration(input)).toThrow(/unreleased/);
    expect(touched).not.toHaveBeenCalled();
    expect(effects.sign).not.toHaveBeenCalled();
    expect(effects.confirm).not.toHaveBeenCalled();
    expect(effects.broadcast).not.toHaveBeenCalled();
  });

  it("refuses durable settlement and signing/preparation engines before store or wallet callbacks", async () => {
    const touched = vi.fn();
    const input = new Proxy({}, { get: touched, getOwnPropertyDescriptor: touched }) as never;
    await expect(advanceAp2Settlement(input)).rejects.toThrow(/unreleased/);
    await expect(advanceSolanaSplSettlement(input)).rejects.toThrow(/unreleased/);
    await expect(advanceX402BuyerSettlement(input)).rejects.toThrow(/unreleased/);
    expect(() => createX402BuyerPaidRequestTransport(input)).toThrow(/unreleased/);
    expect(() => createX402BuyerRetainedDisclosureRecovery(input)).toThrow(/unreleased/);
    await expect(prepareX402BuyerSettlement(input, input)).rejects.toThrow(/unreleased/);
    await expect(x402PaywallCore(input, input)).rejects.toThrow(/unreleased/);
    await expect(x402SettleCore(input, input)).rejects.toThrow(/unreleased/);
    await expect(payDemSettleCore(input, input)).rejects.toThrow(/unreleased/);
    await expect(evmErc20SettleCore(input, input)).rejects.toThrow(/unreleased/);
    await expect(payD402SettleCore(input, input)).rejects.toThrow(/unreleased/);
    expect(touched).not.toHaveBeenCalled();
  });

  it.each([
    ["pay-ap2.md", "advanceAp2Settlement"],
    ["pay-solana-spl.md", "advanceSolanaSplSettlement"],
  ])("documents %s with the separate simulation policy its engine requires", (doc, engine) => {
    const text = readFileSync(new URL(`../../docs/${doc}`, import.meta.url), "utf8");
    const call = text.slice(text.indexOf(`await ${engine}(`));
    expect(call.slice(0, call.indexOf(");") + 2)).toMatch(/\n\}, \{ executionMode: "simulation" \}\);$/);
    expect(text).toMatch(/No policy\s+value\s+admits\s+a\s+live/);
    if (doc === "pay-ap2.md") expect(text).toMatch(/\*\*Unavailable at this pin\.\*\* `createStripeAp2Integration`/);
  });

  it("refuses connected registry dispatch before inspecting descriptors or wallet configuration", async () => {
    const touched = vi.fn();
    const input = new Proxy({}, { get: touched, getOwnPropertyDescriptor: touched }) as never;
    await expect(settleFromRail(input, input)).rejects.toThrow(/unreleased/);
    expect(touched).not.toHaveBeenCalled();
  });

  it("refuses alternative authorization before reading caller assertions or invoking a wallet", async () => {
    const authorize = vi.fn();
    const touched = vi.fn();
    const input = new Proxy({}, { get: touched, getOwnPropertyDescriptor: touched }) as never;
    await expect(authorizeAlternativePayment(input, authorize)).rejects.toThrow(/unreleased/);
    await expect(authorizeAlternativePayment(input, authorize, { profileAdmission: CORRECTIVE_PROFILE } as never))
      .rejects.toThrow(/unreleased/);
    expect(touched).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });
});
