import { types as nodeTypes } from "node:util";

import { canonicalizeDecimal } from "@kynesyslabs/dacs/canonical";

import type { DacsDemosActorRuntimeV1 } from "./demosRuntime.js";
import type { DacsLiveDoctorProbeResultV1 } from "./doctor.js";

const OS_PER_DEM = 1_000_000_000n;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Conservative clean-run write budget for the fixed-price live profile.
 *
 * Each role can publish six role-owned Storage Program artifacts while a
 * purchase advances through Vet, agreement/finality, settlement/delivery and
 * two-sided bundle closure. Replays may reuse those exact immutable writes;
 * they must not be assumed to cost zero during admission because an earlier
 * attempt may have stopped before broadcast.
 */
export const DACS_FIXED_PRICE_PURCHASE_DEMOS_WRITE_BUDGET_V1 = Object.freeze({
  buyer: 6,
  seller: 6,
  safetyMarginPerRole: 1,
});

export interface DacsFixedPriceDemosCostEstimateV1 {
  rail: "x402" | "pay-dem";
  maximumStorageWriteFeeDem: Readonly<Record<"buyer" | "seller", string>>;
  expectedStorageWrites: Readonly<Record<"buyer" | "seller", number>>;
  safetyMarginWrites: Readonly<Record<"buyer" | "seller", number>>;
  maximumStorageFeesDem: Readonly<Record<"buyer" | "seller", string>>;
  safetyMarginDem: Readonly<Record<"buyer" | "seller", string>>;
  minimumDem: Readonly<Record<"buyer" | "seller", string>>;
  maximumTotalDemosDebitDem: string;
}

export interface DacsDemosBalanceHeadroomOptionsV1 {
  actors: Readonly<Record<"buyer" | "seller", Readonly<DacsDemosActorRuntimeV1>>>;
  minimumDem: Readonly<Record<"buyer" | "seller", string>>;
}

export interface DacsX402BalanceReadClientV1 {
  getChainId(): Promise<unknown>;
  getAssetBalance(input: Readonly<{ asset: string; owner: string }>): Promise<unknown>;
  getAssetTokenDomain(asset: string): Promise<unknown>;
  getNativeBalance(owner: string): Promise<unknown>;
}

export interface DacsViemX402BalanceReadClientOptionsV1 {
  rpcUrl: string;
  chainId: number;
}

function dataRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    !nodeTypes.isProxy(value);
}

function demToOs(value: unknown): bigint | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 ||
      value.trim() !== value || value.startsWith("-")) return undefined;
  let canonical: string;
  try {
    canonical = canonicalizeDecimal(value);
  } catch {
    return undefined;
  }
  if (canonical !== value) return undefined;
  const [whole, fraction = ""] = canonical.split(".");
  if (fraction.length > 9 || whole === undefined) return undefined;
  return BigInt(whole) * OS_PER_DEM + BigInt(fraction.padEnd(9, "0") || "0");
}

function osToDem(value: bigint): string {
  const whole = value / OS_PER_DEM;
  const fraction = (value % OS_PER_DEM).toString().padStart(9, "0").replace(/0+$/u, "");
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}

/**
 * Compute the Demos balance floor used to admit one generated fixed-price
 * purchase. The pay-DEM rail ceiling already includes its native transfer and
 * transfer fee; Storage Program evidence fees are separate and are added here.
 *
 * This is a conservative preflight estimate. The adapter independently
 * enforces the confirmed fee ceiling for every Storage Program transaction.
 */
export function estimateDacsFixedPriceDemosCostV1(options: Readonly<{
  rail: "x402" | "pay-dem";
  maximumStorageWriteFeeDem: Readonly<Record<"buyer" | "seller", string>>;
  maximumPayDemTotalDebitDem?: string;
}>): Readonly<DacsFixedPriceDemosCostEstimateV1> {
  if (!dataRecord(options) || (options.rail !== "x402" && options.rail !== "pay-dem")) {
    throw new TypeError("fixed-price Demos cost options are invalid");
  }
  if (!dataRecord(options.maximumStorageWriteFeeDem)) {
    throw new TypeError("fixed-price Demos write fee ceiling is invalid");
  }
  const buyerWriteFeeOs = demToOs(options.maximumStorageWriteFeeDem.buyer);
  const sellerWriteFeeOs = demToOs(options.maximumStorageWriteFeeDem.seller);
  if (buyerWriteFeeOs === undefined || sellerWriteFeeOs === undefined) {
    throw new TypeError("fixed-price Demos write fee ceiling is invalid");
  }
  const payDemDebitOs = options.rail === "pay-dem"
    ? demToOs(options.maximumPayDemTotalDebitDem)
    : options.maximumPayDemTotalDebitDem === undefined ? 0n : undefined;
  if (payDemDebitOs === undefined) {
    throw new TypeError("fixed-price pay-DEM total debit ceiling is invalid");
  }
  const writes = DACS_FIXED_PRICE_PURCHASE_DEMOS_WRITE_BUDGET_V1;
  const buyerStorageOs = buyerWriteFeeOs * BigInt(writes.buyer);
  const sellerStorageOs = sellerWriteFeeOs * BigInt(writes.seller);
  const buyerMarginOs = buyerWriteFeeOs * BigInt(writes.safetyMarginPerRole);
  const sellerMarginOs = sellerWriteFeeOs * BigInt(writes.safetyMarginPerRole);
  const buyerMinimumOs = buyerStorageOs + buyerMarginOs + payDemDebitOs;
  const sellerMinimumOs = sellerStorageOs + sellerMarginOs;
  return Object.freeze({
    rail: options.rail,
    maximumStorageWriteFeeDem: Object.freeze({
      buyer: osToDem(buyerWriteFeeOs),
      seller: osToDem(sellerWriteFeeOs),
    }),
    expectedStorageWrites: Object.freeze({ buyer: writes.buyer, seller: writes.seller }),
    safetyMarginWrites: Object.freeze({
      buyer: writes.safetyMarginPerRole,
      seller: writes.safetyMarginPerRole,
    }),
    maximumStorageFeesDem: Object.freeze({
      buyer: osToDem(buyerStorageOs),
      seller: osToDem(sellerStorageOs),
    }),
    safetyMarginDem: Object.freeze({
      buyer: osToDem(buyerMarginOs),
      seller: osToDem(sellerMarginOs),
    }),
    minimumDem: Object.freeze({
      buyer: osToDem(buyerMinimumOs),
      seller: osToDem(sellerMinimumOs),
    }),
    maximumTotalDemosDebitDem: osToDem(buyerMinimumOs + sellerMinimumOs),
  });
}

function decimalToUnits(value: unknown, decimals: number): bigint | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 ||
      value.trim() !== value || value.startsWith("-") ||
      !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) return undefined;
  let canonical: string;
  try {
    canonical = canonicalizeDecimal(value);
  } catch {
    return undefined;
  }
  if (canonical !== value) return undefined;
  const [whole, fraction = ""] = canonical.split(".");
  if (fraction.length > decimals || whole === undefined) return undefined;
  return BigInt(whole) * (10n ** BigInt(decimals)) +
    BigInt(fraction.padEnd(decimals, "0") || "0");
}

function unitsToDecimal(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString();
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/u, "");
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}

function denominationActivated(value: unknown): boolean | undefined {
  if (!dataRecord(value) || !dataRecord(value.forks) ||
      !dataRecord(value.forks.osDenomination) ||
      typeof value.forks.osDenomination.activated !== "boolean") return undefined;
  return value.forks.osDenomination.activated;
}

function accountBalance(value: unknown): bigint | undefined {
  if (!dataRecord(value) || typeof value.balance !== "bigint" || value.balance < 0n) {
    return undefined;
  }
  return value.balance;
}

/**
 * Read both role-owned Demos balances without exposing a write capability.
 * Pre-fork values are DEM and post-fork values are OS; the result always uses
 * canonical DEM strings and refuses to guess when the fork state is absent.
 */
export async function inspectDacsDemosBalanceHeadroomV1(
  options: Readonly<DacsDemosBalanceHeadroomOptionsV1>,
): Promise<Readonly<DacsLiveDoctorProbeResultV1>> {
  if (!dataRecord(options) || !dataRecord(options.actors) ||
      !dataRecord(options.minimumDem)) {
    throw new TypeError("Demos balance headroom options are invalid");
  }
  const minimumBuyer = demToOs(options.minimumDem.buyer);
  const minimumSeller = demToOs(options.minimumDem.seller);
  if (minimumBuyer === undefined || minimumSeller === undefined) {
    throw new TypeError("Demos balance headroom minimum is invalid");
  }
  const actors = options.actors;
  for (const role of ["buyer", "seller"] as const) {
    const actor = actors[role];
    if (!dataRecord(actor) || actor.role !== role ||
        typeof actor.networkInfo !== "function" ||
        typeof actor.addressInfo !== "function") {
      throw new TypeError("Demos balance headroom actor is invalid");
    }
  }

  let reads: readonly [unknown, unknown, unknown, unknown];
  try {
    reads = await Promise.all([
      actors.buyer.networkInfo(),
      actors.buyer.addressInfo(),
      actors.seller.networkInfo(),
      actors.seller.addressInfo(),
    ]);
  } catch {
    return Object.freeze({
      status: "blocked",
      reasonCode: "demos-balance-read-unavailable",
    });
  }
  const [buyerNetwork, buyerAccount, sellerNetwork, sellerAccount] = reads;
  const buyerDenominated = denominationActivated(buyerNetwork);
  const sellerDenominated = denominationActivated(sellerNetwork);
  if (buyerDenominated === undefined || sellerDenominated === undefined ||
      buyerDenominated !== sellerDenominated) {
    return Object.freeze({
      status: "blocked",
      reasonCode: "demos-denomination-status-unavailable",
    });
  }
  const buyerRaw = accountBalance(buyerAccount);
  const sellerRaw = accountBalance(sellerAccount);
  if (buyerRaw === undefined || sellerRaw === undefined) {
    return Object.freeze({
      status: "fail",
      reasonCode: "demos-balance-response-invalid",
    });
  }
  const buyerOs = buyerDenominated ? buyerRaw : buyerRaw * OS_PER_DEM;
  const sellerOs = sellerDenominated ? sellerRaw : sellerRaw * OS_PER_DEM;
  const facts = Object.freeze({
    buyerBalanceDem: osToDem(buyerOs),
    buyerMinimumDem: osToDem(minimumBuyer),
    sellerBalanceDem: osToDem(sellerOs),
    sellerMinimumDem: osToDem(minimumSeller),
    denomination: buyerDenominated ? "OS" : "legacy-DEM",
  });
  if (buyerOs < minimumBuyer || sellerOs < minimumSeller) {
    return Object.freeze({
      status: "blocked",
      reasonCode: "demos-balance-insufficient",
      facts,
    });
  }
  return Object.freeze({ status: "pass", facts });
}

/** Open a read-only viem client used solely by x402 doctor balance probes. */
export async function createViemDacsX402BalanceReadClientV1(
  options: Readonly<DacsViemX402BalanceReadClientOptionsV1>,
): Promise<Readonly<DacsX402BalanceReadClientV1>> {
  if (!dataRecord(options) || typeof options.rpcUrl !== "string" ||
      !Number.isSafeInteger(options.chainId) || options.chainId <= 0) {
    throw new TypeError("x402 balance reader options are invalid");
  }
  let url: URL;
  try {
    url = new URL(options.rpcUrl);
  } catch {
    throw new TypeError("x402 balance reader RPC URL is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("x402 balance reader RPC URL is invalid");
  }
  const viem = await import("viem").catch(() => {
    throw new TypeError("x402 balance reader requires the optional peer viem");
  });
  const chain = viem.defineChain({
    id: options.chainId,
    name: `eip155:${options.chainId}`,
    nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: [options.rpcUrl] } },
  });
  const client = viem.createPublicClient({ chain, transport: viem.http(options.rpcUrl) });
  const balanceOf = [{ type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }] }] as const;
  const tokenDomain = [
    { type: "function", name: "name", stateMutability: "view", inputs: [],
      outputs: [{ name: "", type: "string" }] },
    { type: "function", name: "version", stateMutability: "view", inputs: [],
      outputs: [{ name: "", type: "string" }] },
  ] as const;
  return Object.freeze({
    getChainId: () => client.getChainId(),
    getAssetBalance: ({ asset, owner }: Readonly<{ asset: string; owner: string }>) =>
      client.readContract({
      address: viem.getAddress(asset),
      abi: balanceOf,
      functionName: "balanceOf",
      args: [viem.getAddress(owner)],
    }),
    async getAssetTokenDomain(asset: string) {
      const address = viem.getAddress(asset);
      const [name, version] = await Promise.all([
        client.readContract({ address, abi: tokenDomain, functionName: "name" }),
        client.readContract({ address, abi: tokenDomain, functionName: "version" }),
      ]);
      return Object.freeze({ name, version });
    },
    getNativeBalance: (owner: string) =>
      client.getBalance({ address: viem.getAddress(owner) }),
  });
}

/**
 * Authenticate the EIP-712 domain used by EIP-3009 signatures against the
 * selected rail's token contract. A syntactically valid local override is not
 * sufficient: a name/version mismatch makes every signed payment unusable.
 */
export async function inspectDacsX402TokenDomainV1(options: Readonly<{
  client: Readonly<DacsX402BalanceReadClientV1>;
  chainId: number;
  asset: string;
  expected: Readonly<{ name: string; version: string }>;
}>): Promise<Readonly<DacsLiveDoctorProbeResultV1>> {
  if (!dataRecord(options) || !dataRecord(options.client) ||
      typeof options.client.getChainId !== "function" ||
      typeof options.client.getAssetTokenDomain !== "function" ||
      !Number.isSafeInteger(options.chainId) || options.chainId <= 0 ||
      !EVM_ADDRESS_RE.test(options.asset) || !dataRecord(options.expected) ||
      typeof options.expected.name !== "string" || options.expected.name.length === 0 ||
      options.expected.name.length > 128 || options.expected.name.trim() !== options.expected.name ||
      typeof options.expected.version !== "string" || options.expected.version.length === 0 ||
      options.expected.version.length > 64 ||
      options.expected.version.trim() !== options.expected.version) {
    throw new TypeError("x402 token domain options are invalid");
  }
  let observedChain: unknown;
  let observedDomain: unknown;
  try {
    [observedChain, observedDomain] = await Promise.all([
      options.client.getChainId(),
      options.client.getAssetTokenDomain(options.asset),
    ]);
  } catch {
    return Object.freeze({ status: "blocked", reasonCode: "x402-token-domain-unavailable" });
  }
  if (observedChain !== options.chainId) {
    return Object.freeze({ status: "fail", reasonCode: "x402-token-domain-chain-mismatch" });
  }
  if (!dataRecord(observedDomain) || typeof observedDomain.name !== "string" ||
      observedDomain.name.length === 0 || observedDomain.name.length > 128 ||
      observedDomain.name.trim() !== observedDomain.name ||
      typeof observedDomain.version !== "string" || observedDomain.version.length === 0 ||
      observedDomain.version.length > 64 ||
      observedDomain.version.trim() !== observedDomain.version) {
    return Object.freeze({ status: "fail", reasonCode: "x402-token-domain-invalid" });
  }
  const facts = Object.freeze({
    domainName: observedDomain.name,
    domainVersion: observedDomain.version,
  });
  return observedDomain.name === options.expected.name &&
      observedDomain.version === options.expected.version
    ? Object.freeze({ status: "pass", facts })
    : Object.freeze({ status: "fail", reasonCode: "x402-token-domain-mismatch", facts });
}

export async function inspectDacsX402AssetBalanceV1(options: Readonly<{
  client: Readonly<DacsX402BalanceReadClientV1>;
  chainId: number;
  payer: string;
  asset: string;
  symbol: string;
  decimals: number;
  minimumAmount: string;
}>): Promise<Readonly<DacsLiveDoctorProbeResultV1>> {
  if (!dataRecord(options) || !dataRecord(options.client) ||
      typeof options.client.getChainId !== "function" ||
      typeof options.client.getAssetBalance !== "function" ||
      !Number.isSafeInteger(options.chainId) || options.chainId <= 0 ||
      !EVM_ADDRESS_RE.test(options.payer) || !EVM_ADDRESS_RE.test(options.asset) ||
      typeof options.symbol !== "string" || options.symbol.length === 0 ||
      options.symbol.length > 64 || options.symbol.trim() !== options.symbol) {
    throw new TypeError("x402 asset balance options are invalid");
  }
  const minimum = decimalToUnits(options.minimumAmount, options.decimals);
  if (minimum === undefined) throw new TypeError("x402 asset minimum is invalid");
  let observedChain: unknown;
  let observedBalance: unknown;
  try {
    [observedChain, observedBalance] = await Promise.all([
      options.client.getChainId(),
      options.client.getAssetBalance({ asset: options.asset, owner: options.payer }),
    ]);
  } catch {
    return Object.freeze({ status: "blocked", reasonCode: "x402-asset-balance-unavailable" });
  }
  if (observedChain !== options.chainId) {
    return Object.freeze({ status: "fail", reasonCode: "x402-asset-chain-mismatch" });
  }
  if (typeof observedBalance !== "bigint" || observedBalance < 0n) {
    return Object.freeze({ status: "fail", reasonCode: "x402-asset-balance-invalid" });
  }
  const facts = Object.freeze({
    assetSymbol: options.symbol,
    availableAmount: unitsToDecimal(observedBalance, options.decimals),
    minimumAmount: unitsToDecimal(minimum, options.decimals),
    chainId: options.chainId,
  });
  return observedBalance < minimum
    ? Object.freeze({ status: "blocked", reasonCode: "x402-asset-balance-insufficient", facts })
    : Object.freeze({ status: "pass", facts });
}

export async function inspectDacsX402GasBalanceV1(options: Readonly<{
  client: Readonly<DacsX402BalanceReadClientV1>;
  chainId: number;
  payer: string;
  minimumEth: string;
}>): Promise<Readonly<DacsLiveDoctorProbeResultV1>> {
  if (!dataRecord(options) || !dataRecord(options.client) ||
      typeof options.client.getChainId !== "function" ||
      typeof options.client.getNativeBalance !== "function" ||
      !Number.isSafeInteger(options.chainId) || options.chainId <= 0 ||
      !EVM_ADDRESS_RE.test(options.payer)) {
    throw new TypeError("x402 gas balance options are invalid");
  }
  const minimum = decimalToUnits(options.minimumEth, 18);
  if (minimum === undefined) throw new TypeError("x402 gas minimum is invalid");
  let observedChain: unknown;
  let observedBalance: unknown;
  try {
    [observedChain, observedBalance] = await Promise.all([
      options.client.getChainId(),
      options.client.getNativeBalance(options.payer),
    ]);
  } catch {
    return Object.freeze({ status: "blocked", reasonCode: "x402-gas-balance-unavailable" });
  }
  if (observedChain !== options.chainId) {
    return Object.freeze({ status: "fail", reasonCode: "x402-gas-chain-mismatch" });
  }
  if (typeof observedBalance !== "bigint" || observedBalance < 0n) {
    return Object.freeze({ status: "fail", reasonCode: "x402-gas-balance-invalid" });
  }
  const facts = Object.freeze({
    availableEth: unitsToDecimal(observedBalance, 18),
    minimumEth: unitsToDecimal(minimum, 18),
    chainId: options.chainId,
  });
  return observedBalance < minimum
    ? Object.freeze({ status: "blocked", reasonCode: "x402-gas-balance-insufficient", facts })
    : Object.freeze({ status: "pass", facts });
}
