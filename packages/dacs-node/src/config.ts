import { canonicalizeDecimal } from "@kynesyslabs/dacs/canonical";

export const DACS_NODE_OFFLINE_PROFILE =
  "dacs-sdk:fixed-price-offline:v1" as const;
export const DACS_NODE_LIVE_PROFILE =
  "dacs-sdk:fixed-price-x402:v1" as const;

export type DacsAgentRole = "demo-all" | "buyer" | "seller" | "verifier";
export type DacsLiveRailProfile = "pay-dem" | "x402";

export interface DacsAgentLimits {
  maxServiceAmount: Readonly<{ asset: string; amount: string }>;
  maxSetupSpendDem: string;
  /** Maximum confirmed fee for each individual Demos write, in DEM. */
  maxDemosNetworkFeeDem: string;
  maxEvmNetworkFeeEth: string;
}

interface DacsAgentConfigBase {
  role: DacsAgentRole;
  dataDirectory: string;
  publicBaseUrl?: string;
  limits: Readonly<DacsAgentLimits>;
}

export interface DacsOfflineAgentConfig extends DacsAgentConfigBase {
  mode: "offline";
  profile: typeof DACS_NODE_OFFLINE_PROFILE;
  role: "demo-all" | "buyer" | "seller" | "verifier";
}

export interface DacsLiveAgentConfig extends DacsAgentConfigBase {
  mode: "live-demos";
  profile: typeof DACS_NODE_LIVE_PROFILE;
  role: "buyer" | "seller" | "verifier";
  demos: Readonly<{
    rpcUrl: string;
    storageReadUrl?: string;
  }>;
  rail: Readonly<{
    registryIndexRef: string;
    requestedNetwork: string;
    /** Defaults to x402 for configs generated before native DEM support. */
    enabledProfiles?: readonly DacsLiveRailProfile[];
  }>;
}

export type DacsAgentConfig = DacsOfflineAgentConfig | DacsLiveAgentConfig;

const ROLE_VALUES = new Set<DacsAgentRole>([
  "demo-all",
  "buyer",
  "seller",
  "verifier",
]);
const DEFAULT_LIVE_RAIL_PROFILES = Object.freeze(["x402"] as const);

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
  });
}

function keys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.trim() === value && !value.includes("\0");
}

function canonicalNonNegativeDecimal(value: unknown): value is string {
  if (!text(value)) return false;
  try {
    return canonicalizeDecimal(value) === value && !value.startsWith("-");
  } catch {
    return false;
  }
}

function validUrl(value: unknown, protocols: ReadonlySet<string>): value is string {
  if (!text(value)) return false;
  try {
    const parsed = new URL(value);
    return protocols.has(parsed.protocol) && parsed.username === "" &&
      parsed.password === "" && parsed.hash === "";
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.$/, "");
  const unbracketed = lower.startsWith("[") && lower.endsWith("]")
    ? lower.slice(1, -1)
    : lower;
  return unbracketed === "localhost" || unbracketed.endsWith(".localhost") ||
    unbracketed === "::1" || unbracketed === "0:0:0:0:0:0:0:1" ||
    /^127(?:\.\d{1,3}){3}$/.test(unbracketed);
}

/** One-click install contract §12: every non-loopback live endpoint uses TLS. */
function validLiveEndpointUrl(
  value: unknown,
  protocols: ReadonlySet<string>,
): value is string {
  if (!validUrl(value, protocols)) return false;
  const parsed = new URL(value);
  return parsed.protocol === "https:" || parsed.protocol === "wss:" ||
    isLoopbackHostname(parsed.hostname);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

function validLimits(value: unknown): value is DacsAgentLimits {
  if (!record(value) || !keys(value, [
    "maxServiceAmount",
    "maxSetupSpendDem",
    "maxDemosNetworkFeeDem",
    "maxEvmNetworkFeeEth",
  ])) return false;
  if (!record(value.maxServiceAmount) || !keys(value.maxServiceAmount, [
    "asset",
    "amount",
  ])) return false;
  return text(value.maxServiceAmount.asset) &&
    canonicalNonNegativeDecimal(value.maxServiceAmount.amount) &&
    canonicalNonNegativeDecimal(value.maxSetupSpendDem) &&
    canonicalNonNegativeDecimal(value.maxDemosNetworkFeeDem) &&
    canonicalNonNegativeDecimal(value.maxEvmNetworkFeeEth);
}

function validBase(value: Readonly<Record<string, unknown>>): boolean {
  return ROLE_VALUES.has(value.role as DacsAgentRole) &&
    text(value.dataDirectory) &&
    validLimits(value.limits) &&
    (value.publicBaseUrl === undefined ||
      validUrl(value.publicBaseUrl, new Set(["http:", "https:"])));
}

function assertDacsAgentConfig(value: unknown): asserts value is DacsAgentConfig {
  if (!record(value) || typeof value.mode !== "string" ||
      typeof value.profile !== "string") {
    throw new TypeError("DACS agent configuration must be a closed object");
  }

  if (value.mode === "offline") {
    if (!keys(value, ["mode", "profile", "role", "dataDirectory", "limits"], [
      "publicBaseUrl",
    ]) || value.profile !== DACS_NODE_OFFLINE_PROFILE || !validBase(value)) {
      throw new TypeError("offline configuration is malformed or profile-incompatible");
    }
  } else if (value.mode === "live-demos") {
    if (!keys(value, [
      "mode",
      "profile",
      "role",
      "dataDirectory",
      "demos",
      "rail",
      "limits",
    ], ["publicBaseUrl"]) || value.profile !== DACS_NODE_LIVE_PROFILE ||
      value.role === "demo-all" || !validBase(value) || !record(value.demos) ||
      !keys(value.demos, ["rpcUrl"], ["storageReadUrl"]) ||
      !validLiveEndpointUrl(
        value.demos.rpcUrl,
        new Set(["http:", "https:", "ws:", "wss:"]),
      ) ||
      (value.demos.storageReadUrl !== undefined &&
        !validLiveEndpointUrl(
          value.demos.storageReadUrl,
          new Set(["http:", "https:"]),
        )) ||
      (value.publicBaseUrl !== undefined &&
        !validLiveEndpointUrl(
          value.publicBaseUrl,
          new Set(["http:", "https:"]),
        )) ||
      !record(value.rail) || !keys(value.rail, [
        "registryIndexRef",
        "requestedNetwork",
      ], ["enabledProfiles"]) || !text(value.rail.registryIndexRef) ||
      !text(value.rail.requestedNetwork) ||
      (value.rail.enabledProfiles !== undefined &&
        (!Array.isArray(value.rail.enabledProfiles) ||
          ![
            '["pay-dem"]',
            '["x402"]',
            '["pay-dem","x402"]',
          ].includes(JSON.stringify(value.rail.enabledProfiles))))) {
      throw new TypeError("live configuration is malformed or profile-incompatible");
    }
  } else {
    throw new TypeError("unsupported DACS agent mode/profile pair");
  }
}

/**
 * Validate the closed one-click configuration before stores or adapters open.
 * Returns a detached snapshot so callers cannot mutate the admitted values.
 */
export function validateDacsAgentConfig(value: unknown): Readonly<DacsAgentConfig> {
  assertDacsAgentConfig(value);
  let snapshot: unknown;
  try {
    snapshot = structuredClone(value);
  } catch {
    throw new TypeError("DACS agent configuration must be cloneable data");
  }
  // Validate the exact detached graph that will be retained, not only its source.
  assertDacsAgentConfig(snapshot);

  return deepFreeze(snapshot);
}

export function dacsLiveRailProfiles(
  config: Readonly<DacsLiveAgentConfig>,
): readonly DacsLiveRailProfile[] {
  return config.rail.enabledProfiles ?? DEFAULT_LIVE_RAIL_PROFILES;
}
