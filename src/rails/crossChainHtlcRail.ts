import { DacsError } from "../errors.js";
import {
  getAuthenticatedRailProvenance,
  type AuthenticatedRailDefinition,
} from "../registry/resolve.js";
import type { CrossChainHtlcAuthority } from "./crossChainHtlc.js";

/**
 * The agreement's and the host's part of a `CrossChainHtlcAuthority`: what
 * the pinned rail definition does not carry.
 */
export interface CrossChainHtlcRailSelection {
  /**
   * The route the agreement selected, as `CrossChainRoute.sourceChainId` and
   * `destChainId` (DACS-4 §9.4.1). Matched exactly: there are no aliases, and
   * `1` and `"1"` are different routes.
   */
  sourceChainId: number | string;
  destinationChainId: number | string;
  jobId: string;
  phaseIndex: number;
  agreementHash: string;
  amount: string;
  /** The agreement's currency. It must be the rail's `asset.canonicalSymbol`. */
  currency: string;
  /** Chain-native token ids and decimals on each leg; the rail has none. */
  sourceTokenId: string;
  destinationTokenId: string;
  sourceTokenDecimals: number;
  destinationTokenDecimals: number;
  payerSourceAddress: string;
  payerDestinationAddress: string;
  payeeSourceAddress: string;
  payeeDestinationAddress: string;
  /** The SDK's own destination finality budget; no rail parameter pins it. */
  destinationFinalitySec: number;
}

const SELECTION_KEYS: ReadonlySet<string> = new Set([
  "sourceChainId",
  "destinationChainId",
  "jobId",
  "phaseIndex",
  "agreementHash",
  "amount",
  "currency",
  "sourceTokenId",
  "destinationTokenId",
  "sourceTokenDecimals",
  "destinationTokenDecimals",
  "payerSourceAddress",
  "payerDestinationAddress",
  "payeeSourceAddress",
  "payeeDestinationAddress",
  "destinationFinalitySec",
]);

/** DACS-4 §9.14: the four pinned `pay-cross-chain-htlc` rail parameters. */
const RAIL_PARAMETERS = [
  "timelockSourceSec",
  "timelockDestSec",
  "sourceFinalitySec",
  "safetyWindowSec",
] as const;

function fail(message: string): never {
  throw new DacsError(`pay-cross-chain-htlc rail: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeChainId(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/**
 * Build the `CrossChainHtlcAuthority` for one session from a rail definition
 * that `resolveRail` authenticated (RAV-R5) and from the agreement's
 * selection. The rail supplies its id, the definition's content hash
 * (`railDescriptorHash`), the selected route's chains and HTLC contracts, the
 * canonical symbol, and the four pinned parameters under their DACS-4 §9.14
 * names. A missing parameter is refused, not defaulted.
 *
 * The route is selected by exact `(sourceChainId, destChainId)` equality, and
 * exactly one route of the rail must match. The core is pinned to routes
 * whose chain ids are positive safe integers: the Standard's `htlc-lock`,
 * `htlc-reveal`, `htlc-claim` and `htlc-refund` references carry a numeric
 * `chainId` (DACS-4 §9.3), so a route with a string chain id, for example a
 * Solana leg, cannot produce conforming evidence and is refused rather than
 * given a numeric alias.
 */
export function crossChainHtlcAuthorityFromRail(
  rail: AuthenticatedRailDefinition,
  selection: Readonly<CrossChainHtlcRailSelection>,
): Readonly<CrossChainHtlcAuthority> {
  // The provenance map is the RAV-R5 brand: a structural copy has none.
  const provenance = getAuthenticatedRailProvenance(rail);
  if (provenance === null) {
    fail("requires a rail returned by resolveRail (RAV-R5)");
  }
  if (!isRecord(selection)) fail("selection must be an object");
  const picked = Object.freeze({ ...selection });
  for (const key of Object.keys(picked)) {
    if (!SELECTION_KEYS.has(key)) fail(`selection has unknown field ${key}`);
  }
  // `resolveRail` already bound the handler, network and mechanism to the
  // rail type; the asset kind is checked again only to narrow its type.
  if (rail.railType !== "cross-chain-htlc" || rail.asset.kind !== "stablecoin-cross-chain") {
    fail(`rail "${rail.railId}" is not a cross-chain HTLC rail`);
  }
  if (rail.availability === "disabled" || rail.availability === "failed") {
    fail(`rail "${rail.railId}" availability=${rail.availability}; RAV-R2 forbids settlement`);
  }
  const { canonicalSymbol, routes } = rail.asset;
  const matches = routes.filter((route) =>
    route.sourceChainId === picked.sourceChainId && route.destChainId === picked.destinationChainId);
  const route = matches[0];
  if (matches.length !== 1 || route === undefined) {
    fail(`rail "${rail.railId}" has ${matches.length === 0 ? "no" : "more than one"} route ` +
      `${describeChainId(picked.sourceChainId)} -> ${describeChainId(picked.destinationChainId)}`);
  }
  if (!Number.isSafeInteger(route.sourceChainId) || (route.sourceChainId as number) <= 0 ||
      !Number.isSafeInteger(route.destChainId) || (route.destChainId as number) <= 0) {
    fail(`route ${describeChainId(route.sourceChainId)} -> ${describeChainId(route.destChainId)} ` +
      "is outside the core's numeric-chain profile: HTLC references carry a numeric chainId");
  }
  if (route.htlcContracts === undefined) {
    fail(`route ${route.sourceChainId} -> ${route.destChainId} has no htlcContracts`);
  }
  const parameters = rail.parameters;
  const pinned = {} as Record<(typeof RAIL_PARAMETERS)[number], number>;
  for (const name of RAIL_PARAMETERS) {
    const value = parameters[name];
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
      fail(`rail "${rail.railId}" parameters.${name} must be a positive safe integer`);
    }
    pinned[name] = value as number;
  }
  if (picked.currency !== canonicalSymbol) {
    fail(`agreement currency ${JSON.stringify(picked.currency)} is not the rail's ${JSON.stringify(canonicalSymbol)}`);
  }
  return Object.freeze({
    jobId: picked.jobId,
    phaseIndex: picked.phaseIndex,
    railId: rail.railId,
    railDescriptorHash: provenance.definitionContentHash,
    agreementHash: picked.agreementHash,
    assetKind: "stablecoin-cross-chain",
    networkKind: "cross-chain",
    mechanism: "htlc",
    sourceChainId: route.sourceChainId as number,
    destinationChainId: route.destChainId as number,
    sourceAsset: canonicalSymbol,
    destinationAsset: canonicalSymbol,
    sourceTokenId: picked.sourceTokenId,
    destinationTokenId: picked.destinationTokenId,
    sourceTokenDecimals: picked.sourceTokenDecimals,
    destinationTokenDecimals: picked.destinationTokenDecimals,
    amount: picked.amount,
    currency: picked.currency,
    payerSourceAddress: picked.payerSourceAddress,
    payerDestinationAddress: picked.payerDestinationAddress,
    payeeSourceAddress: picked.payeeSourceAddress,
    payeeDestinationAddress: picked.payeeDestinationAddress,
    sourceContractAddress: route.htlcContracts.source,
    destinationContractAddress: route.htlcContracts.dest,
    sourceFinalitySec: pinned.sourceFinalitySec,
    destinationFinalitySec: picked.destinationFinalitySec,
    safetyWindowSec: pinned.safetyWindowSec,
    sourceTimelockSec: pinned.timelockSourceSec,
    destinationTimelockSec: pinned.timelockDestSec,
  });
}
