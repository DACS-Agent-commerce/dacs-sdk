import { types as nodeTypes } from "node:util";

import { canonicalizeDecimal } from "@kynesyslabs/dacs/canonical";

import type { DacsDemosActorRuntimeV1 } from "./demosRuntime.js";
import type { DacsLiveDoctorProbeResultV1 } from "./doctor.js";

const OS_PER_DEM = 1_000_000_000n;

export interface DacsDemosBalanceHeadroomOptionsV1 {
  actors: Readonly<Record<"buyer" | "seller", Readonly<DacsDemosActorRuntimeV1>>>;
  minimumDem: Readonly<Record<"buyer" | "seller", string>>;
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
