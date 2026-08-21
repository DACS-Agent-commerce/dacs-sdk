import type {
  DacsLiveDoctorProbeV1,
  DacsLiveDoctorProbesV1,
} from "./doctor.js";
import type { DacsTransportDiagnosticResultV1 } from "./transportDiagnostic.js";

export type { DacsTransportDiagnosticResultV1 } from "./transportDiagnostic.js";

const MAX_RESPONSE_BYTES = 65_536;

export interface DacsRoleServiceDoctorTargetV1 {
  role: "buyer" | "seller";
  endpoint: string;
  publicEndpoint?: string;
}

export interface DacsRoleServiceDoctorOptionsV1 {
  targets: readonly Readonly<DacsRoleServiceDoctorTargetV1>[];
  sdkVersion: string;
  standardRevision: string;
  profile: string;
  transportDiagnostic?: (
    role: "buyer" | "seller",
    options: Readonly<{ signal: AbortSignal }>,
  ) => Promise<Readonly<DacsTransportDiagnosticResultV1>> |
    Readonly<DacsTransportDiagnosticResultV1>;
  fetch?: typeof fetch;
  independentFetch?: typeof fetch;
}

function pass(facts?: Readonly<Record<string, string | number | boolean | null>>) {
  return Object.freeze({ status: "pass" as const, ...(facts === undefined ? {} : { facts }) });
}

function fail(reasonCode: string) {
  return Object.freeze({ status: "fail" as const, reasonCode });
}

function safeEndpoint(value: unknown, publicEndpoint = false): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return false;
  try {
    const parsed = new URL(value);
    if (parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") return false;
    if (publicEndpoint) return parsed.protocol === "https:";
    const hostname = parsed.hostname.toLowerCase();
    return parsed.protocol === "https:" ||
      (parsed.protocol === "http:" &&
        (hostname === "localhost" || hostname.endsWith(".localhost") ||
          hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1"));
  } catch {
    return false;
  }
}

async function jsonGet(
  fetcher: typeof fetch,
  endpoint: string,
  path: string,
  signal: AbortSignal,
): Promise<Readonly<{ status: number; body: Record<string, unknown> }> | undefined> {
  try {
    const response = await fetcher(new URL(path, endpoint), {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal,
    });
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) > MAX_RESPONSE_BYTES) return undefined;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) return undefined;
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return Object.freeze({ status: response.status, body: parsed as Record<string, unknown> });
  } catch {
    return undefined;
  }
}

function targetsByRole(
  targets: readonly Readonly<DacsRoleServiceDoctorTargetV1>[],
): Readonly<Record<"buyer" | "seller", Readonly<DacsRoleServiceDoctorTargetV1>>> | undefined {
  if (!Array.isArray(targets) || targets.length !== 2) return undefined;
  const buyer = targets.find((target) => target?.role === "buyer");
  const seller = targets.find((target) => target?.role === "seller");
  if (buyer === undefined || seller === undefined || buyer === seller ||
      !safeEndpoint(buyer.endpoint) || !safeEndpoint(seller.endpoint) ||
      (buyer.publicEndpoint !== undefined && !safeEndpoint(buyer.publicEndpoint, true)) ||
      (seller.publicEndpoint !== undefined && !safeEndpoint(seller.publicEndpoint, true))) {
    return undefined;
  }
  return Object.freeze({ buyer, seller });
}

export function createDacsRoleServiceDoctorProbesV1(
  options: Readonly<DacsRoleServiceDoctorOptionsV1>,
): Readonly<DacsLiveDoctorProbesV1> {
  if (options === null || typeof options !== "object" ||
      typeof options.sdkVersion !== "string" || typeof options.standardRevision !== "string" ||
      typeof options.profile !== "string" ||
      (options.fetch !== undefined && typeof options.fetch !== "function") ||
      (options.independentFetch !== undefined && typeof options.independentFetch !== "function") ||
      (options.transportDiagnostic !== undefined &&
        typeof options.transportDiagnostic !== "function")) {
    throw new TypeError("role service doctor options are invalid");
  }
  const targets = targetsByRole(options.targets);
  if (targets === undefined) throw new TypeError("role service doctor targets are invalid");
  const fetcher = options.fetch ?? fetch;
  const independentFetcher = options.independentFetch;

  const health: DacsLiveDoctorProbeV1 = async ({ signal }) => {
    const observed = await Promise.all([
      jsonGet(fetcher, targets.buyer.endpoint, "/health", signal),
      jsonGet(fetcher, targets.seller.endpoint, "/health", signal),
    ]);
    return observed.every((item) => item?.status === 200 && item.body.status === "healthy")
      ? pass({ roleCount: 2 }) : fail("role-service-unhealthy");
  };
  const readiness: DacsLiveDoctorProbeV1 = async ({ signal }) => {
    const observed = await Promise.all([
      jsonGet(fetcher, targets.buyer.endpoint, "/ready", signal),
      jsonGet(fetcher, targets.seller.endpoint, "/ready", signal),
    ]);
    return observed.every((item) => item?.status === 200 && item.body.ready === true &&
      Array.isArray(item.body.reasonCodes) && item.body.reasonCodes.length === 0)
      ? pass({ roleCount: 2 }) : fail("role-service-not-ready");
  };
  const versions: DacsLiveDoctorProbeV1 = async ({ signal }) => {
    const entries = await Promise.all([
      jsonGet(fetcher, targets.buyer.endpoint, "/status", signal),
      jsonGet(fetcher, targets.seller.endpoint, "/status", signal),
    ]);
    const expectedRoles = ["buyer", "seller"];
    const valid = entries.every((entry, index) => entry?.status === 200 &&
      entry.body.version === 1 && entry.body.role === expectedRoles[index] &&
      entry.body.lifecycle === "running" && entry.body.sdkVersion === options.sdkVersion &&
      entry.body.standardRevision === options.standardRevision &&
      entry.body.profile === options.profile);
    return valid ? pass({ sdkVersion: options.sdkVersion })
      : fail("role-service-version-mismatch");
  };
  const transport: DacsLiveDoctorProbeV1 = async ({ signal }) => {
    if (options.transportDiagnostic === undefined) {
      return { status: "blocked", reasonCode: "transport-diagnostic-not-configured" };
    }
    try {
      const observed = await Promise.all([
        options.transportDiagnostic("buyer", { signal }),
        options.transportDiagnostic("seller", { signal }),
      ]);
      return observed.every((item) => item.authenticated === true && item.durable === true &&
        item.acknowledged === true && item.noAction === true)
        ? pass({ directionCount: 2 }) : fail("transport-diagnostic-failed");
    } catch {
      return fail("transport-diagnostic-unavailable");
    }
  };
  const publicReachability: DacsLiveDoctorProbeV1 = async ({ signal }) => {
    const configured = [targets.buyer.publicEndpoint, targets.seller.publicEndpoint]
      .filter((value): value is string => value !== undefined);
    if (configured.length === 0) return pass({ configured: false });
    if (independentFetcher === undefined) {
      return { status: "blocked", reasonCode: "independent-probe-not-configured" };
    }
    const observed = await Promise.all(configured.map((endpoint) =>
      jsonGet(independentFetcher, endpoint, "/health", signal)));
    return observed.every((item) => item?.status === 200)
      ? pass({ configured: true, endpointCount: configured.length })
      : fail("public-endpoint-unreachable");
  };

  return Object.freeze({
    "service.health": health,
    "service.transport-roundtrip": transport,
    "service.public-reachability": publicReachability,
    "service.version-agreement": versions,
    "service.readiness": readiness,
  });
}
