import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";

const REASON_CODE_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const MAX_PROBE_TIMEOUT_MS = 60_000;

export const DACS_LIVE_DOCTOR_REPORT_SCHEMA =
  "dacs-live-doctor-report/v1" as const;

export type DacsLiveDoctorPhaseV1 = "pre-start" | "post-start";
export type DacsLiveDoctorScopeV1 = "start" | "setup" | "buy";
export type DacsLiveDoctorStatusV1 = "pass" | "fail" | "blocked";
export type DacsLiveDoctorRailProfileV1 = "x402" | "pay-dem";

export const DACS_LIVE_DOCTOR_CHECK_IDS = Object.freeze([
  "local.node-version",
  "local.package-integrity",
  "local.version-bindings",
  "local.configuration",
  "local.data-directory",
  "local.disk-space",
  "local.sqlite",
  "local.secrets",
  "local.authority-separation",
  "local.transport-identities",
  "local.deployment-runtime",
  "demos.rpc-chain",
  "demos.storage-read",
  "demos.binding-resolution",
  "demos.nonce",
  "demos.balance-fees",
  "demos.wallet-identity",
  "demos.listing-candidate",
  "demos.listing-existing",
  "demos.engagement-endpoint-shape",
  "x402.rail-authority",
  "x402.testnet-policy",
  "x402.endpoints",
  "x402.token-domain",
  "x402.payer-binding",
  "x402.payee-binding",
  "x402.asset-balance",
  "x402.gas-balance",
  "x402.service-limit",
  "x402.cost-estimate",
  "pay-dem.rail-authority",
  "pay-dem.payer-binding",
  "pay-dem.payee-binding",
  "pay-dem.service-limit",
  "pay-dem.total-debit",
  "service.health",
  "service.transport-roundtrip",
  "service.public-reachability",
  "service.version-agreement",
  "service.readiness",
  "service.commerce-configured",
] as const);

export type DacsLiveDoctorCheckIdV1 =
  typeof DACS_LIVE_DOCTOR_CHECK_IDS[number];

type PublicFact = string | number | boolean | null;

export type DacsLiveDoctorProbeResultV1 = Readonly<
  | {
      status: "pass";
      facts?: Readonly<Record<string, PublicFact>>;
    }
  | {
      status: "fail" | "blocked";
      reasonCode: string;
      facts?: Readonly<Record<string, PublicFact>>;
    }
>;

export interface DacsLiveDoctorProbeContextV1 {
  readonly checkId: DacsLiveDoctorCheckIdV1;
  readonly phase: DacsLiveDoctorPhaseV1;
  readonly scope: DacsLiveDoctorScopeV1;
  readonly signal: AbortSignal;
}

/** A doctor probe is contractually read-only and receives no write capability. */
export type DacsLiveDoctorProbeV1 = (
  context: Readonly<DacsLiveDoctorProbeContextV1>,
) => Promise<Readonly<DacsLiveDoctorProbeResultV1>> |
  Readonly<DacsLiveDoctorProbeResultV1>;

export type DacsLiveDoctorProbesV1 = Readonly<
  Partial<Record<DacsLiveDoctorCheckIdV1, DacsLiveDoctorProbeV1>>
>;

export interface DacsLiveDoctorCheckV1 {
  id: DacsLiveDoctorCheckIdV1;
  category: "local" | "demos" | "x402" | "pay-dem" | "service";
  status: DacsLiveDoctorStatusV1;
  required: boolean;
  summary: string;
  reasonCode?: string;
  facts?: Readonly<Record<string, PublicFact>>;
  durationMs: number;
}

export interface DacsLiveDoctorReportV1 {
  schema: typeof DACS_LIVE_DOCTOR_REPORT_SCHEMA;
  phase: DacsLiveDoctorPhaseV1;
  scope: DacsLiveDoctorScopeV1;
  generatedAt: number;
  sdkVersion: string;
  standardRevision: string;
  profile: string;
  safety: Readonly<{
    readOnly: true;
    funded: false;
  }>;
  checks: readonly Readonly<DacsLiveDoctorCheckV1>[];
  gate: Readonly<{
    status: DacsLiveDoctorStatusV1;
    required: number;
    passed: number;
    failed: number;
    blocked: number;
  }>;
  exitCode: 0 | 1 | 5;
  reportHash: string;
}

export interface DacsLiveDoctorOptionsV1 {
  phase: DacsLiveDoctorPhaseV1;
  scope: DacsLiveDoctorScopeV1;
  sdkVersion: string;
  standardRevision: string;
  profile: string;
  probes?: DacsLiveDoctorProbesV1;
  /** Enabled generated live capabilities; defaults to the historical x402 profile. */
  enabledRailProfiles?: readonly DacsLiveDoctorRailProfileV1[];
  /** Exact rail selected by a setup/buy invocation, if one is being admitted. */
  operationRailProfile?: DacsLiveDoctorRailProfileV1;
  now?: () => number;
  probeTimeoutMs?: number;
  signal?: AbortSignal;
}

interface CheckDefinition {
  id: DacsLiveDoctorCheckIdV1;
  label: string;
  availableFrom: DacsLiveDoctorPhaseV1;
  scopes: ReadonlySet<DacsLiveDoctorScopeV1>;
  railProfile?: DacsLiveDoctorRailProfileV1;
}

const ALL_SCOPES = new Set<DacsLiveDoctorScopeV1>(["start", "setup", "buy"]);
const SETUP_BUY = new Set<DacsLiveDoctorScopeV1>(["setup", "buy"]);
const SETUP = new Set<DacsLiveDoctorScopeV1>(["setup"]);
const BUY = new Set<DacsLiveDoctorScopeV1>(["buy"]);

const DEFINITIONS: readonly Readonly<CheckDefinition>[] = Object.freeze([
  { id: "local.node-version", label: "supported Node runtime", availableFrom: "pre-start", scopes: ALL_SCOPES },
  { id: "local.package-integrity", label: "installed package and export integrity", availableFrom: "pre-start", scopes: ALL_SCOPES },
  { id: "local.version-bindings", label: "SDK, Standard and profile agreement", availableFrom: "pre-start", scopes: ALL_SCOPES },
  { id: "local.configuration", label: "closed live configuration", availableFrom: "pre-start", scopes: ALL_SCOPES },
  { id: "local.data-directory", label: "private writable data directory", availableFrom: "pre-start", scopes: ALL_SCOPES },
  { id: "local.disk-space", label: "local disk free-space headroom", availableFrom: "pre-start", scopes: ALL_SCOPES },
  { id: "local.sqlite", label: "SQLite schema, durability and lock availability", availableFrom: "pre-start", scopes: ALL_SCOPES },
  { id: "local.secrets", label: "role-local secret ownership and permissions", availableFrom: "pre-start", scopes: ALL_SCOPES },
  { id: "local.authority-separation", label: "buyer and seller authority separation", availableFrom: "pre-start", scopes: ALL_SCOPES },
  { id: "local.transport-identities", label: "transport identity role resolution", availableFrom: "pre-start", scopes: ALL_SCOPES },
  { id: "local.deployment-runtime", label: "selected deployment runtime", availableFrom: "pre-start", scopes: ALL_SCOPES },
  { id: "demos.rpc-chain", label: "Demos RPC chain identity", availableFrom: "pre-start", scopes: ALL_SCOPES },
  { id: "demos.storage-read", label: "Storage Program read capability", availableFrom: "pre-start", scopes: ALL_SCOPES },
  { id: "demos.binding-resolution", label: "authenticated logical and native binding resolution", availableFrom: "pre-start", scopes: ALL_SCOPES },
  { id: "demos.nonce", label: "current actor address nonce", availableFrom: "pre-start", scopes: SETUP_BUY },
  { id: "demos.balance-fees", label: "Demos balance and fee headroom", availableFrom: "pre-start", scopes: SETUP_BUY },
  { id: "demos.wallet-identity", label: "Demos wallet-to-identity binding", availableFrom: "pre-start", scopes: ALL_SCOPES },
  { id: "demos.listing-candidate", label: "candidate Listing validity", availableFrom: "pre-start", scopes: SETUP },
  { id: "demos.listing-existing", label: "exact signed Listing and registry resolution", availableFrom: "pre-start", scopes: BUY },
  { id: "demos.engagement-endpoint-shape", label: "Listing engagement endpoint shape", availableFrom: "pre-start", scopes: ALL_SCOPES },
  { id: "x402.rail-authority", label: "authenticated x402 rail authority", availableFrom: "pre-start", scopes: ALL_SCOPES, railProfile: "x402" },
  { id: "x402.testnet-policy", label: "non-mainnet release policy", availableFrom: "pre-start", scopes: ALL_SCOPES, railProfile: "x402" },
  { id: "x402.endpoints", label: "x402 facilitator and resource endpoints", availableFrom: "pre-start", scopes: ALL_SCOPES, railProfile: "x402" },
  { id: "x402.token-domain", label: "payment token EIP-712 domain", availableFrom: "pre-start", scopes: ALL_SCOPES, railProfile: "x402" },
  { id: "x402.payer-binding", label: "buyer EVM payer binding", availableFrom: "pre-start", scopes: BUY, railProfile: "x402" },
  { id: "x402.payee-binding", label: "seller EVM payee binding", availableFrom: "pre-start", scopes: SETUP_BUY, railProfile: "x402" },
  { id: "x402.asset-balance", label: "payment-asset balance", availableFrom: "pre-start", scopes: BUY, railProfile: "x402" },
  { id: "x402.gas-balance", label: "native gas balance", availableFrom: "pre-start", scopes: BUY, railProfile: "x402" },
  { id: "x402.service-limit", label: "configured maximum service amount", availableFrom: "pre-start", scopes: BUY, railProfile: "x402" },
  { id: "x402.cost-estimate", label: "service and network cost estimate", availableFrom: "pre-start", scopes: BUY, railProfile: "x402" },
  { id: "pay-dem.rail-authority", label: "authenticated native DEM rail authority", availableFrom: "pre-start", scopes: ALL_SCOPES, railProfile: "pay-dem" },
  { id: "pay-dem.payer-binding", label: "buyer native DEM payer binding", availableFrom: "pre-start", scopes: BUY, railProfile: "pay-dem" },
  { id: "pay-dem.payee-binding", label: "seller native DEM payee binding", availableFrom: "pre-start", scopes: SETUP_BUY, railProfile: "pay-dem" },
  { id: "pay-dem.service-limit", label: "configured native DEM service limit", availableFrom: "pre-start", scopes: BUY, railProfile: "pay-dem" },
  { id: "pay-dem.total-debit", label: "native DEM total debit ceiling", availableFrom: "pre-start", scopes: BUY, railProfile: "pay-dem" },
  { id: "service.health", label: "role service liveness", availableFrom: "post-start", scopes: ALL_SCOPES },
  { id: "service.transport-roundtrip", label: "authenticated no-effect transport round trip", availableFrom: "post-start", scopes: ALL_SCOPES },
  { id: "service.public-reachability", label: "configured public endpoint reachability", availableFrom: "post-start", scopes: ALL_SCOPES },
  { id: "service.version-agreement", label: "cross-process version and store agreement", availableFrom: "post-start", scopes: ALL_SCOPES },
  { id: "service.readiness", label: "fresh role service readiness latch", availableFrom: "post-start", scopes: ALL_SCOPES },
  { id: "service.commerce-configured", label: "buyer and seller commerce graph capability", availableFrom: "post-start", scopes: BUY },
]);

function positiveInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 &&
    value <= maximum;
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value.trim() === value && !value.includes("\0");
}

function closedRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

function sanitizePublicString(key: string, value: string): string {
  if (/(?:secret|private|mnemonic|seed|password|credential|authorization|bearer|token|apiKey|rpcUrl)/iu
    .test(key) || /\bBearer\s+\S+/iu.test(value) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/u
    .test(value) || /^(?:0x)?[0-9a-f]{64}$/iu.test(value) && !/hash$/iu.test(key) ||
      /^(?:[a-z]+\s+){11,23}[a-z]+$/u.test(value)) {
    return "[redacted]";
  }
  try {
    const parsed = new URL(value);
    if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" ||
        parsed.hash !== "") {
      return `${parsed.origin}${parsed.pathname}[redacted-credentials]`;
    }
  } catch {
    // Non-URL public facts pass through the bounded scalar filter below.
  }
  return value;
}

function captureFacts(value: unknown): Readonly<Record<string, PublicFact>> | undefined {
  if (value === undefined) return undefined;
  if (!closedRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > 32) return undefined;
  const captured: Record<string, PublicFact> = {};
  for (const [key, fact] of entries) {
    if (!/^[a-z][a-zA-Z0-9]{0,63}$/.test(key) ||
        (typeof fact !== "string" && typeof fact !== "number" &&
          typeof fact !== "boolean" && fact !== null) ||
        (typeof fact === "string" && (fact.length > 512 || fact.includes("\0"))) ||
        (typeof fact === "number" && !Number.isSafeInteger(fact))) {
      return undefined;
    }
    captured[key] = typeof fact === "string" ? sanitizePublicString(key, fact) : fact;
  }
  return Object.freeze(captured);
}

function captureProbeResult(value: unknown): Readonly<DacsLiveDoctorProbeResultV1> | undefined {
  if (!closedRecord(value)) return undefined;
  const allowed = value.status === "pass"
    ? new Set(["status", "facts"])
    : new Set(["status", "reasonCode", "facts"]);
  if (Object.keys(value).some((key) => !allowed.has(key)) ||
      (value.status !== "pass" && value.status !== "fail" && value.status !== "blocked")) {
    return undefined;
  }
  const facts = captureFacts(value.facts);
  if (value.facts !== undefined && facts === undefined) return undefined;
  if (value.status === "pass") {
    if (Object.hasOwn(value, "reasonCode")) return undefined;
    return Object.freeze({ status: "pass", ...(facts === undefined ? {} : { facts }) });
  }
  if (typeof value.reasonCode !== "string" || !REASON_CODE_RE.test(value.reasonCode)) {
    return undefined;
  }
  return Object.freeze({
    status: value.status,
    reasonCode: value.reasonCode,
    ...(facts === undefined ? {} : { facts }),
  });
}

function requiredFor(
  definition: Readonly<CheckDefinition>,
  phase: DacsLiveDoctorPhaseV1,
  scope: DacsLiveDoctorScopeV1,
  enabledRailProfiles: ReadonlySet<DacsLiveDoctorRailProfileV1>,
  operationRailProfile: DacsLiveDoctorRailProfileV1 | undefined,
): boolean {
  const railRequired = definition.railProfile === undefined ||
    enabledRailProfiles.has(definition.railProfile) &&
      (scope === "start" || operationRailProfile === undefined ||
        operationRailProfile === definition.railProfile);
  return railRequired && definition.scopes.has(scope) &&
    (definition.availableFrom === "pre-start" || phase === "post-start");
}

async function runProbe(
  definition: Readonly<CheckDefinition>,
  probe: DacsLiveDoctorProbeV1 | undefined,
  options: Readonly<DacsLiveDoctorOptionsV1>,
  timeoutMs: number,
  now: () => number,
): Promise<Readonly<DacsLiveDoctorCheckV1>> {
  const startedAt = now();
  const enabledRailProfiles = new Set<DacsLiveDoctorRailProfileV1>(
    options.enabledRailProfiles ?? ["x402"],
  );
  const required = requiredFor(
    definition,
    options.phase,
    options.scope,
    enabledRailProfiles,
    options.operationRailProfile,
  );
  if (definition.availableFrom === "post-start" && options.phase === "pre-start") {
    return Object.freeze({
      id: definition.id,
      category: definition.id.split(".", 1)[0] as DacsLiveDoctorCheckV1["category"],
      status: "blocked",
      required,
      summary: `${definition.label} is available only after services start`,
      reasonCode: "post-start-only",
      durationMs: 0,
    });
  }
  if (probe === undefined) {
    return Object.freeze({
      id: definition.id,
      category: definition.id.split(".", 1)[0] as DacsLiveDoctorCheckV1["category"],
      status: "blocked",
      required,
      summary: `${definition.label} could not be established`,
      reasonCode: "probe-not-configured",
      durationMs: 0,
    });
  }
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort();
  options.signal?.addEventListener("abort", onParentAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(undefined);
      }, timeoutMs);
      timer.unref?.();
    });
    const observed = await Promise.race([
      Promise.resolve(probe(Object.freeze({
        checkId: definition.id,
        phase: options.phase,
        scope: options.scope,
        signal: controller.signal,
      }))).then((value) => captureProbeResult(value)).catch(() => undefined),
      timeout,
    ]);
    const completedAt = now();
    const durationMs = Math.max(0, completedAt - startedAt);
    const result: Readonly<DacsLiveDoctorProbeResultV1> = observed ?? Object.freeze({
      status: "blocked" as const,
      reasonCode: controller.signal.aborted ? "probe-timeout-or-abort" : "probe-result-invalid",
    });
    return Object.freeze({
      id: definition.id,
      category: definition.id.split(".", 1)[0] as DacsLiveDoctorCheckV1["category"],
      status: result.status,
      required,
      summary: `${definition.label} ${
        result.status === "pass" ? "passed" : result.status === "fail" ? "failed" : "is blocked"
      }`,
      ...(result.status === "pass" ? {} : { reasonCode: result.reasonCode }),
      ...(result.facts === undefined ? {} : { facts: result.facts }),
      durationMs,
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onParentAbort);
  }
}

function validateOptions(options: Readonly<DacsLiveDoctorOptionsV1>): void {
  if (options === null || typeof options !== "object" ||
      (options.phase !== "pre-start" && options.phase !== "post-start") ||
      (options.scope !== "start" && options.scope !== "setup" && options.scope !== "buy") ||
      !boundedText(options.sdkVersion, 128) ||
      !boundedText(options.standardRevision, 128) ||
      !boundedText(options.profile, 128) ||
      (options.now !== undefined && typeof options.now !== "function") ||
      (options.operationRailProfile !== undefined &&
        options.operationRailProfile !== "x402" && options.operationRailProfile !== "pay-dem") ||
      (options.probes !== undefined && !closedRecord(options.probes))) {
    throw new TypeError("live doctor options are invalid");
  }
  if (options.enabledRailProfiles !== undefined &&
      (!Array.isArray(options.enabledRailProfiles) ||
        options.enabledRailProfiles.length === 0 || options.enabledRailProfiles.length > 2 ||
        new Set(options.enabledRailProfiles).size !== options.enabledRailProfiles.length ||
        options.enabledRailProfiles.some((profile) =>
          profile !== "x402" && profile !== "pay-dem"))) {
    throw new TypeError("live doctor rail profiles are invalid");
  }
  if (options.operationRailProfile !== undefined &&
      !(options.enabledRailProfiles ?? ["x402"]).includes(options.operationRailProfile)) {
    throw new TypeError("live doctor operation rail is not enabled");
  }
  if (options.probes !== undefined && Object.keys(options.probes).some((key) =>
    !DACS_LIVE_DOCTOR_CHECK_IDS.includes(key as DacsLiveDoctorCheckIdV1) ||
      typeof options.probes?.[key as DacsLiveDoctorCheckIdV1] !== "function")) {
    throw new TypeError("live doctor probes are invalid");
  }
}

/** Run the complete live release gate without exposing a spend/write capability. */
export async function runDacsLiveDoctorV1(
  options: Readonly<DacsLiveDoctorOptionsV1>,
): Promise<Readonly<DacsLiveDoctorReportV1>> {
  validateOptions(options);
  const timeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  if (!positiveInteger(timeoutMs, MAX_PROBE_TIMEOUT_MS)) {
    throw new TypeError("live doctor timeout is invalid");
  }
  const now = options.now ?? Date.now;
  const generatedAt = now();
  if (!Number.isSafeInteger(generatedAt) || generatedAt < 0) {
    throw new TypeError("live doctor clock is invalid");
  }
  const checks = Object.freeze(await Promise.all(DEFINITIONS.map((definition) =>
    runProbe(definition, options.probes?.[definition.id], options, timeoutMs, now))));
  const required = checks.filter((item) => item.required);
  const failed = required.filter((item) => item.status === "fail").length;
  const blocked = required.filter((item) => item.status === "blocked").length;
  const passed = required.filter((item) => item.status === "pass").length;
  const gateStatus: DacsLiveDoctorStatusV1 = failed > 0
    ? "fail"
    : blocked > 0 ? "blocked" : "pass";
  const exitCode = (failed > 0 ? 1 : blocked > 0 ? 5 : 0) as 0 | 1 | 5;
  const body = Object.freeze({
    schema: DACS_LIVE_DOCTOR_REPORT_SCHEMA,
    phase: options.phase,
    scope: options.scope,
    generatedAt,
    sdkVersion: options.sdkVersion,
    standardRevision: options.standardRevision,
    profile: options.profile,
    safety: Object.freeze({ readOnly: true as const, funded: false as const }),
    checks,
    gate: Object.freeze({
      status: gateStatus,
      required: required.length,
      passed,
      failed,
      blocked,
    }),
    exitCode,
  });
  return Object.freeze({
    ...body,
    reportHash: sha256Hex(canonicalize(body)),
  });
}

export function formatDacsLiveDoctorTextV1(
  report: Readonly<DacsLiveDoctorReportV1>,
): string {
  const lines = [
    "dacs doctor",
    `phase: ${report.phase}`,
    `scope: ${report.scope}`,
    `gate: ${report.gate.status}`,
    ...report.checks.map((item) =>
      `${item.required ? "required" : "informational"} ${item.id}: ${item.status}` +
      `${item.reasonCode === undefined ? "" : ` (${item.reasonCode})`}`),
    `report: ${report.reportHash}`,
    `exit: ${report.exitCode}`,
  ];
  return `${lines.join("\n")}\n`;
}
