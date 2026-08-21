export interface LiveProjectTemplateOptions {
  packageName: string;
  deployment: "local" | "docker";
  role: "buyer" | "seller" | "verifier";
  runtimeUid: number;
  runtimeGid: number;
}

const SDK_VERSION = "0.1.0-alpha.0";

function packageJson(packageName: string): string {
  return JSON.stringify({
    name: packageName,
    version: "0.1.0",
    private: true,
    type: "module",
    engines: { node: "^20.19.0 || >=22.12.0" },
    scripts: {
      build: "tsc -p tsconfig.json",
      typecheck: "tsc --noEmit -p tsconfig.json",
      test: "npm run build && node --test dist/test/live-bootstrap.test.js",
      "dacs:doctor": "npm run build --silent && node dist/src/cli.js doctor",
      "dacs:doctor:funded": "npm run build --silent && node dist/src/cli.js doctor-funded",
      "dacs:up": "npm run build --silent && node dist/src/cli.js up",
      "dacs:setup": "npm run build --silent && node dist/src/cli.js setup",
      "dacs:buy": "npm run build --silent && node dist/src/cli.js buy",
      "dacs:status": "npm run build --silent && node dist/src/cli.js status",
      "dacs:down": "npm run build --silent && node dist/src/cli.js down",
      "dacs:upgrade": "npm run build --silent && node dist/src/cli.js upgrade",
      "dacs:service": "npm run build --silent && node dist/src/service.js",
      "dacs:smoke:offline": "npm run build --silent && node dist/src/offline-smoke.js",
    },
    dependencies: {
      "@kynesyslabs/dacs": SDK_VERSION,
      "@kynesyslabs/dacs-node": SDK_VERSION,
    },
    devDependencies: {
      "@types/node": "20.19.1",
      typescript: "5.9.2",
    },
  }, null, 2) + "\n";
}

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["dacs.config.ts", "src", "test"]
}
`;

function dacsConfig(role: LiveProjectTemplateOptions["role"]): string {
  return `import { existsSync, readFileSync } from "node:fs";
import { loadEnvFile } from "node:process";

import type { DacsLiveAgentConfig } from "@kynesyslabs/dacs-node";

let persistentConfirmationDetected = false;
if (existsSync(".env")) {
  const persisted = readFileSync(".env", "utf8");
  if (/^\\s*(?:export\\s+)?DACS_(?:SETUP_WRITE|PURCHASE|DOCTOR_FUNDED)_CONFIRM\\s*=/mu
      .test(persisted)) {
    persistentConfirmationDetected = true;
  } else {
    loadEnvFile(".env");
  }
}

export type GeneratedLiveRole = "buyer" | "seller" | "verifier";

function publicUrl(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
}

export function generatedRoleConfig(role: GeneratedLiveRole): DacsLiveAgentConfig {
  if (persistentConfirmationDetected) {
    throw new Error("write confirmation must not be persisted in .env");
  }
  const publicBaseUrl = publicUrl(role === "buyer"
    ? "DACS_BUYER_PUBLIC_BASE_URL" : role === "seller"
      ? "DACS_SELLER_PUBLIC_BASE_URL" : "DACS_VERIFIER_PUBLIC_BASE_URL");
  return {
    mode: "live-demos",
    profile: "dacs-sdk:fixed-price-x402:v1",
    role,
    dataDirectory: process.env[role === "buyer"
      ? "DACS_BUYER_DATA_DIRECTORY" : role === "seller"
        ? "DACS_SELLER_DATA_DIRECTORY" : "DACS_VERIFIER_DATA_DIRECTORY"] ??
      "./data/" + role,
    ...(publicBaseUrl === undefined ? {} : { publicBaseUrl }),
    demos: {
      rpcUrl: process.env.DACS_DEMOS_RPC_URL ?? "https://node2.demos.sh",
      ...(publicUrl("DACS_DEMOS_STORAGE_READ_URL") === undefined
        ? {} : { storageReadUrl: publicUrl("DACS_DEMOS_STORAGE_READ_URL")! }),
    },
    rail: {
      registryIndexRef: process.env.DACS_RAIL_REGISTRY_INDEX_REF ?? "dacs4:registry:x402",
      requestedNetwork: process.env.DACS_X402_NETWORK ?? "eip155:84532",
    },
    limits: {
      maxServiceAmount: {
        asset: process.env.DACS_MAX_SERVICE_ASSET ?? "USDC",
        amount: process.env.DACS_MAX_SERVICE_AMOUNT ?? "1",
      },
      maxSetupSpendDem: process.env.DACS_MAX_SETUP_SPEND_DEM ?? "10",
      maxDemosNetworkFeeDem: process.env.DACS_MAX_DEMOS_NETWORK_FEE_DEM ?? "2",
      maxEvmNetworkFeeEth: process.env.DACS_MAX_EVM_NETWORK_FEE_ETH ?? "0.001",
    },
  };
}

export function selectedGeneratedRoleConfig(): DacsLiveAgentConfig {
  const selected = process.env.DACS_ROLE ?? "${role}";
  if (selected !== "buyer" && selected !== "seller" && selected !== "verifier") {
    throw new Error("DACS_ROLE must be buyer, seller or verifier");
  }
  return generatedRoleConfig(selected);
}

export default selectedGeneratedRoleConfig;
`;
}

const CONFIG_SOURCE = `import { resolve } from "node:path";

import {
  validateDacsAgentConfig,
  type DacsLiveAgentConfig,
} from "@kynesyslabs/dacs-node";

import { generatedRoleConfig, type GeneratedLiveRole } from "../dacs.config.js";

const AUTHORITY_NAMES = Object.freeze({
  buyer: "DACS_BUYER_AUTHORITY",
  seller: "DACS_SELLER_AUTHORITY",
  verifier: "DACS_VERIFIER_AUTHORITY",
});

const SECRET_NAMES = Object.freeze({
  buyer: Object.freeze([
    "DACS_BUYER_DEMOS_SECRET_FILE",
    "DACS_BUYER_EVM_SECRET_FILE",
  ]),
  seller: Object.freeze([
    "DACS_SELLER_DEMOS_SECRET_FILE",
    "DACS_SELLER_EVM_SECRET_FILE",
  ]),
  verifier: Object.freeze([]),
});

export function loadRoleConfig(role: GeneratedLiveRole): Readonly<DacsLiveAgentConfig> {
  const config = validateDacsAgentConfig(generatedRoleConfig(role));
  if (config.mode !== "live-demos" || config.role !== role) {
    throw new Error("generated live configuration is role-incompatible");
  }
  return config;
}

export function configuredAuthority(role: GeneratedLiveRole): string | undefined {
  const value = process.env[AUTHORITY_NAMES[role]];
  return value === undefined || value.trim() === "" ? undefined : value;
}

export function actorDatabasePath(role: GeneratedLiveRole): string {
  return resolve(loadRoleConfig(role).dataDirectory, "actor.sqlite");
}

export function actorSecretPaths(role: GeneratedLiveRole): readonly string[] {
  return SECRET_NAMES[role].flatMap((name) => {
    const value = process.env[name];
    return value === undefined || value.trim() === "" ? [] : [resolve(value)];
  });
}

export function serviceEndpoint(role: "buyer" | "seller"): string {
  return process.env[role === "buyer" ? "DACS_BUYER_SERVICE_URL" : "DACS_SELLER_SERVICE_URL"] ??
    (role === "buyer" ? "http://127.0.0.1:3101" : "http://127.0.0.1:3102");
}
`;

const DOCTOR_SOURCE = `import { constants } from "node:fs";
import { access, lstat, readFile, statfs } from "node:fs/promises";
import { spawn } from "node:child_process";

import { VERSION } from "@kynesyslabs/dacs";
import { sha256Hex } from "@kynesyslabs/dacs/canonical";
import { FIXED_PRICE_X402_STANDARD_REVISION } from "@kynesyslabs/dacs/commerce";
import {
  DACS_LIVE_DOCTOR_CHECK_IDS,
  DACS_NODE_LIVE_PROFILE,
  createDacsRoleServiceDoctorProbesV1,
  inspectDacsNodePackageIntegrityV1,
  runDacsLiveDoctorV1,
  type DacsLiveDoctorPhaseV1,
  type DacsLiveDoctorProbeResultV1,
  type DacsLiveDoctorProbesV1,
  type DacsLiveDoctorReportV1,
  type DacsLiveDoctorScopeV1,
} from "@kynesyslabs/dacs-node";
import { inspectExistingDacsNodeSqliteDatabaseV1 } from "@kynesyslabs/dacs-node/sqlite";

import {
  actorDatabasePath,
  actorSecretPaths,
  configuredAuthority,
  loadRoleConfig,
  serviceEndpoint,
} from "./config.js";

const ROLES = Object.freeze(["buyer", "seller"] as const);
const AUTHORITY_RE = /^did:demos:agent:[0-9a-f]{64}$/;

function pass(facts?: Readonly<Record<string, string | number | boolean | null>>) {
  return Object.freeze({ status: "pass" as const, ...(facts === undefined ? {} : { facts }) });
}
function fail(reasonCode: string) {
  return Object.freeze({ status: "fail" as const, reasonCode });
}
function blocked(reasonCode: string) {
  return Object.freeze({ status: "blocked" as const, reasonCode });
}

function supportedNode(): boolean {
  const match = /^(\\d+)\\.(\\d+)\\.(\\d+)/.exec(process.versions.node);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major === 20 ? minor >= 19 : major === 22 ? minor >= 12 : major > 22;
}

async function privateDirectory(role: "buyer" | "seller") {
  const directory = loadRoleConfig(role).dataDirectory;
  try {
    const observed = await lstat(directory);
    if (!observed.isDirectory() || observed.isSymbolicLink()) return fail("data-directory-invalid");
    if (typeof process.getuid === "function" && observed.uid !== process.getuid()) {
      return fail("data-directory-owner-mismatch");
    }
    if (process.platform !== "win32" && (observed.mode & 0o077) !== 0) {
      return fail("data-directory-permissions-unsafe");
    }
    await access(directory, constants.R_OK | constants.W_OK | constants.X_OK);
    return pass();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? blocked("data-directory-missing") : fail("data-directory-unavailable");
  }
}

async function diskSpace() {
  try {
    let lowest = Number.MAX_SAFE_INTEGER;
    for (const role of ROLES) {
      const observed = await statfs(loadRoleConfig(role).dataDirectory, { bigint: true });
      const bytes = observed.bavail * observed.bsize;
      lowest = Math.min(lowest, Number(bytes > BigInt(Number.MAX_SAFE_INTEGER)
        ? BigInt(Number.MAX_SAFE_INTEGER) : bytes));
    }
    return lowest >= 268_435_456 ? pass({ availableBytesFloor: lowest })
      : fail("disk-space-insufficient");
  } catch {
    return blocked("disk-space-unavailable");
  }
}

async function secrets() {
  const paths = ROLES.flatMap((role) => actorSecretPaths(role));
  if (paths.length !== 4) return blocked("role-secret-file-missing");
  const hashes: string[] = [];
  try {
    for (const path of paths) {
      const observed = await lstat(path);
      if (!observed.isFile() || observed.isSymbolicLink()) return fail("secret-file-invalid");
      if (typeof process.getuid === "function" && observed.uid !== process.getuid()) {
        return fail("secret-file-owner-mismatch");
      }
      if (process.platform !== "win32" && (observed.mode & 0o077) !== 0) {
        return fail("secret-file-permissions-unsafe");
      }
      const bytes = await readFile(path);
      if (bytes.byteLength === 0 || bytes.byteLength > 65_536) {
        bytes.fill(0);
        return fail("secret-file-size-invalid");
      }
      hashes.push(sha256Hex(bytes));
      bytes.fill(0);
    }
    return new Set(hashes).size === hashes.length ? pass({ secretCount: hashes.length })
      : fail("role-secret-reused");
  } catch {
    return blocked("role-secret-file-unavailable");
  }
}

function authorities() {
  const buyer = configuredAuthority("buyer");
  const seller = configuredAuthority("seller");
  if (buyer === undefined || seller === undefined) return blocked("actor-authority-missing");
  if (!AUTHORITY_RE.test(buyer) || !AUTHORITY_RE.test(seller)) {
    return fail("actor-authority-invalid");
  }
  return buyer === seller ? fail("actor-authority-shared") : pass();
}

function sqlite() {
  for (const role of ROLES) {
    const authority = configuredAuthority(role);
    if (authority === undefined) return blocked("actor-authority-missing");
    const observed = inspectExistingDacsNodeSqliteDatabaseV1({
      databasePath: actorDatabasePath(role),
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role,
      authority,
    });
    if (observed.status !== "pass") {
      return observed.status === "fail" ? fail(observed.reasonCode) : blocked(observed.reasonCode);
    }
  }
  return pass({ actorStoreCount: 2 });
}

async function dockerRuntime(
  context: Readonly<{ signal: AbortSignal }>,
): Promise<Readonly<DacsLiveDoctorProbeResultV1>> {
  if ((process.env.DACS_DEPLOYMENT ?? "docker") === "local") return pass();
  const runtimeUid = Number(process.env.DACS_RUNTIME_UID);
  const runtimeGid = Number(process.env.DACS_RUNTIME_GID);
  if (process.env.DACS_RUNTIME_UID === undefined || process.env.DACS_RUNTIME_GID === undefined) {
    return blocked("docker-runtime-identity-missing");
  }
  if (!Number.isSafeInteger(runtimeUid) || runtimeUid <= 0 ||
      !Number.isSafeInteger(runtimeGid) || runtimeGid <= 0) {
    return fail("docker-runtime-identity-unsafe");
  }
  return new Promise((resolve) => {
    const child = spawn("docker", ["version", "--format", "{{.Server.Version}}"], {
      stdio: ["ignore", "ignore", "ignore"], shell: false,
    });
    let settled = false;
    const finish = (result: Readonly<DacsLiveDoctorProbeResultV1>) => {
      if (settled) return;
      settled = true;
      context.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      finish(blocked("docker-runtime-timeout"));
    };
    context.signal.addEventListener("abort", onAbort, { once: true });
    if (context.signal.aborted) onAbort();
    child.once("error", () => finish(blocked("docker-runtime-unavailable")));
    child.once("exit", (code) => finish(code === 0 ? pass() : blocked("docker-runtime-unavailable")));
  });
}

function baseProbes(): DacsLiveDoctorProbesV1 {
  const unavailable = () => blocked("reviewed-live-adapter-not-configured");
  return Object.freeze({
    "local.node-version": () => supportedNode() ? pass({ nodeVersion: process.version })
      : fail("node-version-unsupported"),
    "local.package-integrity": inspectDacsNodePackageIntegrityV1,
    "local.version-bindings": () => pass({ sdkVersion: VERSION,
      standardRevision: FIXED_PRICE_X402_STANDARD_REVISION, profile: DACS_NODE_LIVE_PROFILE }),
    "local.configuration": () => {
      try { ROLES.forEach((role) => loadRoleConfig(role)); return pass(); }
      catch { return fail("configuration-invalid"); }
    },
    "local.data-directory": async () => {
      const observed = await Promise.all(ROLES.map(privateDirectory));
      return observed.find((item) => item.status === "fail") ??
        observed.find((item) => item.status === "blocked") ?? pass();
    },
    "local.disk-space": diskSpace,
    "local.sqlite": sqlite,
    "local.secrets": secrets,
    "local.authority-separation": authorities,
    "local.transport-identities": unavailable,
    "local.deployment-runtime": dockerRuntime,
    "demos.rpc-chain": unavailable,
    "demos.storage-read": unavailable,
    "demos.binding-resolution": unavailable,
    "demos.nonce": unavailable,
    "demos.balance-fees": unavailable,
    "demos.wallet-identity": unavailable,
    "demos.listing-candidate": unavailable,
    "demos.listing-existing": unavailable,
    "demos.engagement-endpoint-shape": () => {
      try { new URL(serviceEndpoint("buyer")); new URL(serviceEndpoint("seller")); return pass(); }
      catch { return fail("engagement-endpoint-invalid"); }
    },
    "x402.rail-authority": unavailable,
    "x402.testnet-policy": () => loadRoleConfig("buyer").rail.requestedNetwork === "eip155:84532"
      ? pass() : fail("x402-mainnet-or-unsupported-network"),
    "x402.endpoints": unavailable,
    "x402.payer-binding": unavailable,
    "x402.payee-binding": unavailable,
    "x402.asset-balance": unavailable,
    "x402.gas-balance": unavailable,
    "x402.service-limit": () => pass({
      asset: loadRoleConfig("buyer").limits.maxServiceAmount.asset,
      amount: loadRoleConfig("buyer").limits.maxServiceAmount.amount,
    }),
    "x402.cost-estimate": unavailable,
  });
}

export async function runGeneratedDoctor(
  phase: DacsLiveDoctorPhaseV1,
  scope: DacsLiveDoctorScopeV1,
): Promise<Readonly<DacsLiveDoctorReportV1>> {
  const service = phase === "post-start" ? createDacsRoleServiceDoctorProbesV1({
    targets: [
      { role: "buyer", endpoint: serviceEndpoint("buyer") },
      { role: "seller", endpoint: serviceEndpoint("seller") },
    ],
    sdkVersion: VERSION,
    standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
    profile: DACS_NODE_LIVE_PROFILE,
  }) : {};
  const probes = Object.freeze({ ...baseProbes(), ...service });
  const report = await runDacsLiveDoctorV1({
    phase,
    scope,
    sdkVersion: VERSION,
    standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
    profile: DACS_NODE_LIVE_PROFILE,
    probes,
    probeTimeoutMs: 5_000,
  });
  if (report.checks.length !== DACS_LIVE_DOCTOR_CHECK_IDS.length) {
    throw new Error("doctor-catalog-incomplete");
  }
  return report;
}
`;

const CLI_SOURCE = `import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";

import { canonicalize, canonicalizeDecimal, sha256Hex } from "@kynesyslabs/dacs/canonical";
import {
  DACS_NODE_LIVE_PROFILE,
  formatDacsLiveDoctorTextV1,
  type DacsLiveDoctorReportV1,
} from "@kynesyslabs/dacs-node";
import { openDacsNodeSqliteDatabase } from "@kynesyslabs/dacs-node/sqlite";

import {
  actorDatabasePath,
  configuredAuthority,
  loadRoleConfig,
} from "./config.js";
import { runGeneratedDoctor } from "./doctor.js";

type DoctorPhase = "pre-start" | "post-start";
type DoctorScope = "start" | "setup" | "buy";

function valueAfter(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(flag + " requires a value");
  return value;
}

function doctorArguments(args: readonly string[]): { phase: DoctorPhase; scope: DoctorScope; json: boolean } {
  let phase: DoctorPhase = "pre-start";
  let scope: DoctorScope = "start";
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--json") json = true;
    else if (argument === "--phase") {
      const value = valueAfter(args, index, argument);
      if (value !== "pre-start" && value !== "post-start") throw new Error("invalid doctor phase");
      phase = value;
      index += 1;
    } else if (argument === "--for") {
      const value = valueAfter(args, index, argument);
      if (value !== "start" && value !== "setup" && value !== "buy") throw new Error("invalid doctor scope");
      scope = value;
      index += 1;
    } else throw new Error("unknown doctor option: " + argument);
  }
  return { phase, scope, json };
}

function printDoctor(report: Readonly<DacsLiveDoctorReportV1>, json = false): void {
  process.stdout.write(json ? JSON.stringify(report) + "\\n" : formatDacsLiveDoctorTextV1(report));
}

async function doctor(args: readonly string[]): Promise<number> {
  const parsed = doctorArguments(args);
  const report = await runGeneratedDoctor(parsed.phase, parsed.scope);
  printDoctor(report, parsed.json);
  return report.exitCode;
}

async function initializeActorStores(): Promise<void> {
  for (const role of ["buyer", "seller"] as const) {
    const authority = configuredAuthority(role);
    if (authority === undefined || !/^did:demos:agent:[0-9a-f]{64}$/.test(authority)) {
      throw new Error("actor authority is unavailable for store initialization");
    }
    const config = loadRoleConfig(role);
    await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 });
    const observed = await lstat(config.dataDirectory);
    if (!observed.isDirectory() || observed.isSymbolicLink() ||
        process.platform !== "win32" && (observed.mode & 0o077) !== 0 ||
        typeof process.getuid === "function" && observed.uid !== process.getuid()) {
      throw new Error("actor data directory is unsafe");
    }
    const database = await openDacsNodeSqliteDatabase({
      databasePath: actorDatabasePath(role),
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role,
      authority,
    });
    database.close();
  }
}

async function startGate(): Promise<number> {
  let report = await runGeneratedDoctor("pre-start", "start");
  const localInitializationOnly = report.checks.filter((item) => item.required &&
    item.status !== "pass").every((item) =>
      item.id === "local.data-directory" || item.id === "local.disk-space" ||
      item.id === "local.sqlite");
  if (report.exitCode !== 0 && !localInitializationOnly) {
    printDoctor(report);
    return report.exitCode;
  }
  if (report.exitCode !== 0) {
    await initializeActorStores();
    report = await runGeneratedDoctor("pre-start", "start");
  }
  printDoctor(report);
  return report.exitCode;
}

async function command(executable: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

function decimalWithin(value: string, ceiling: string): string {
  const normalized = canonicalizeDecimal(value);
  if (normalized.startsWith("-")) throw new Error("amount must not be negative");
  const units = (input: string, scale: number) => {
    const [whole, fraction = ""] = input.split(".");
    return BigInt(whole! + fraction.padEnd(scale, "0"));
  };
  const scale = Math.max(normalized.split(".")[1]?.length ?? 0,
    ceiling.split(".")[1]?.length ?? 0);
  if (units(normalized, scale) > units(canonicalizeDecimal(ceiling), scale)) {
    throw new Error("amount exceeds configured ceiling");
  }
  return normalized;
}

function closedOptions(
  args: readonly string[],
  names: readonly string[],
): Readonly<Record<string, string>> {
  const allowed = new Set(names);
  const captured: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (name === undefined || !allowed.has(name) || Object.hasOwn(captured, name)) {
      throw new Error("unknown or repeated command option");
    }
    captured[name] = valueAfter(args, index, name);
  }
  if (Object.keys(captured).length !== names.length) {
    throw new Error("required command option is missing");
  }
  return Object.freeze(captured);
}

async function preflightPlan(scope: "setup" | "buy", args: readonly string[]) {
  const config = loadRoleConfig("buyer");
  if (scope === "setup") {
    const values = closedOptions(args, ["--max-spend-dem"]);
    return Object.freeze({
      schema: "dacs-generated-command-preflight/v1",
      kind: "setup",
      execute: false,
      maximumSpendDem: decimalWithin(values["--max-spend-dem"]!, config.limits.maxSetupSpendDem),
      adapterStatus: "not-configured",
    });
  }
  const values = closedOptions(args, [
    "--listing-ref", "--request-file", "--max-service-amount", "--max-network-fee-eth",
  ]);
  const listingRef = values["--listing-ref"]!;
  if (listingRef.length > 512 || listingRef.trim() !== listingRef || listingRef.length === 0) {
    throw new Error("listing reference is malformed");
  }
  const requestPath = values["--request-file"]!;
  const requestFile = await open(requestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let request: Buffer;
  try {
    const observed = await requestFile.stat();
    if (!observed.isFile() || observed.size > 1_048_576) {
      throw new Error("request file is unsafe");
    }
    request = await requestFile.readFile();
  } finally {
    await requestFile.close();
  }
  const requestHash = sha256Hex(request);
  request.fill(0);
  return Object.freeze({
    schema: "dacs-generated-command-preflight/v1",
    kind: "purchase",
    execute: false,
    listingRef,
    requestHash,
    maximumServiceAmount: decimalWithin(
      values["--max-service-amount"]!, config.limits.maxServiceAmount.amount),
    maximumNetworkFeeEth: decimalWithin(
      values["--max-network-fee-eth"]!, config.limits.maxEvmNetworkFeeEth),
    adapterStatus: "not-configured",
  });
}

async function guardedUnavailable(scope: "setup" | "buy", args: readonly string[]): Promise<number> {
  const plan = await preflightPlan(scope, args);
  const body = { ...plan, planHash: sha256Hex("dacs-generated-command-preflight:v1:" +
    canonicalize(plan)) };
  process.stdout.write(JSON.stringify(body) + "\\n");
  const confirmationName = scope === "setup"
    ? "DACS_SETUP_WRITE_CONFIRM" : "DACS_PURCHASE_CONFIRM";
  const confirmation = process.env[confirmationName];
  if (confirmation === undefined) return 0;
  if (confirmation !== "1") throw new Error("write confirmation is malformed");
  const report = await runGeneratedDoctor(scope === "buy" ? "post-start" : "pre-start", scope);
  process.stdout.write(formatDacsLiveDoctorTextV1(report));
  if (report.exitCode !== 0) return report.exitCode;
  process.stderr.write("reviewed live effect adapter is not configured; no write was attempted\\n");
  return 5;
}

async function main(args = process.argv.slice(2)): Promise<void> {
  const [operation = "doctor", ...rest] = args;
  if (operation === "doctor") process.exitCode = await doctor(rest);
  else if (operation === "up") {
    const gate = await startGate();
    if (gate !== 0) { process.exitCode = gate; return; }
    process.exitCode = await command("docker", ["compose", "up", "-d"]);
  } else if (operation === "down") {
    process.exitCode = await command("docker", ["compose", "down"]);
  } else if (operation === "status") {
    process.exitCode = await command("docker", ["compose", "ps"]);
  } else if (operation === "setup") process.exitCode = await guardedUnavailable("setup", rest);
  else if (operation === "buy") process.exitCode = await guardedUnavailable("buy", rest);
  else if (operation === "doctor-funded") {
    if (process.env.DACS_DOCTOR_FUNDED_CONFIRM !== "1") {
      throw new Error("funded doctor requires DACS_DOCTOR_FUNDED_CONFIRM=1");
    }
    process.stderr.write("funded doctor adapter is not configured; no debit was attempted\\n");
    process.exitCode = 5;
  } else if (operation === "upgrade") {
    if (!rest.includes("--check")) throw new Error("only dacs:upgrade -- --check is supported");
    process.stdout.write(JSON.stringify({ status: "read-only", availableVersion: "not-queried" }) + "\\n");
  } else throw new Error("unknown dacs command: " + operation);
}

main().catch(() => {
  process.stderr.write("dacs command failed; rerun doctor for a sanitized diagnosis\\n");
  process.exitCode = 1;
});
`;

const SERVICE_SOURCE = `import { loadRoleConfig } from "./config.js";

async function main(): Promise<void> {
  const role = process.env.DACS_ROLE;
  if (role !== "buyer" && role !== "seller" && role !== "verifier") {
    throw new Error("live service requires DACS_ROLE=buyer, seller or verifier");
  }
  loadRoleConfig(role);
  process.stderr.write(JSON.stringify({
    event: "dacs.live-service.blocked",
    role,
    reasonCode: "reviewed-live-adapter-not-configured",
  }) + "\\n");
  process.exitCode = 5;
}

main().catch(() => {
  process.stderr.write(JSON.stringify({
    event: "dacs.live-service.failed",
    reasonCode: "configuration-or-adapter-invalid",
  }) + "\\n");
  process.exitCode = 1;
});
`;

const OFFLINE_SMOKE_SOURCE = `import { resolve } from "node:path";
import { runOfflineVerifierSimulation } from "@kynesyslabs/dacs-node";

const report = await runOfflineVerifierSimulation({
  outputDirectory: resolve("./data/offline-smoke", String(Date.now())),
});
process.stdout.write(JSON.stringify({
  event: "dacs.offline-simulation.complete",
  jobId: report.jobId,
  normativeConformance: report.normativeConformance,
  commercialSuccess: report.commercialSuccess,
  simulationPassed: report.simulationPassed,
  reportPath: report.reportPath,
}) + "\\n");
`;

const BUYER_SOURCE = `export const buyerApplication = Object.freeze({
  role: "buyer" as const,
  fulfilmentAuthority: false,
});
`;

const SELLER_SOURCE = `export async function fulfil(request: Readonly<{ jobId: string }>) {
  // Replace only this application callback with the seller's bounded service work.
  return Object.freeze({ jobId: request.jobId, status: "not-configured" as const });
}
`;

const VERIFIER_SOURCE = `export const verifierApplication = Object.freeze({
  role: "verifier" as const,
  readOnly: true,
});
`;

const TEST_SOURCE = `import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { DACS_LIVE_DOCTOR_CHECK_IDS } from "@kynesyslabs/dacs-node";
import { runGeneratedDoctor } from "../src/doctor.js";

test("fresh live bootstrap is complete, read-only and visibly blocked", async () => {
  const before = existsSync("./data/buyer/actor.sqlite");
  const previousDeployment = process.env.DACS_DEPLOYMENT;
  process.env.DACS_DEPLOYMENT = "local";
  const report = await runGeneratedDoctor("pre-start", "start");
  if (previousDeployment === undefined) delete process.env.DACS_DEPLOYMENT;
  else process.env.DACS_DEPLOYMENT = previousDeployment;
  assert.equal(report.safety.readOnly, true);
  assert.equal(report.safety.funded, false);
  assert.equal(report.exitCode, 5);
  assert.equal(report.checks.length, DACS_LIVE_DOCTOR_CHECK_IDS.length);
  assert.equal(report.checks.some((item) => item.status === "blocked"), true);
  assert.equal(existsSync("./data/buyer/actor.sqlite"), before);
});
`;

const DOCKERFILE = `FROM node:20.19.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
RUN npm rebuild better-sqlite3
COPY tsconfig.json dacs.config.ts ./
COPY src ./src
COPY test ./test
RUN npm run build
RUN npm prune --omit=dev --ignore-scripts

FROM node:20.19.1-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 10001 dacs && useradd --system --uid 10001 --gid dacs --home-dir /app dacs \\
  && install --directory --owner=dacs --group=dacs --mode=0700 /var/lib/dacs \\
  && install --directory --owner=dacs --group=dacs --mode=0755 /app
COPY --from=build --chown=dacs:dacs /app/package.json /app/package-lock.json ./
COPY --from=build --chown=dacs:dacs /app/node_modules ./node_modules
COPY --from=build --chown=dacs:dacs /app/dist ./dist
USER 10001:10001
CMD ["node", "dist/src/service.js"]
`;

const DOCKERIGNORE = `**
!package.json
!package-lock.json
!tsconfig.json
!dacs.config.ts
!src/
!src/**
!test/
!test/**
`;

const COMPOSE = `x-dacs-public-environment: &dacs-public-environment
  DACS_DEMOS_RPC_URL: \${DACS_DEMOS_RPC_URL:-https://node2.demos.sh}
  DACS_DEMOS_STORAGE_READ_URL: \${DACS_DEMOS_STORAGE_READ_URL:-}
  DACS_RAIL_REGISTRY_INDEX_REF: \${DACS_RAIL_REGISTRY_INDEX_REF:-dacs4:registry:x402}
  DACS_X402_NETWORK: \${DACS_X402_NETWORK:-eip155:84532}
  DACS_MAX_SERVICE_ASSET: \${DACS_MAX_SERVICE_ASSET:-USDC}
  DACS_MAX_SERVICE_AMOUNT: \${DACS_MAX_SERVICE_AMOUNT:-1}
  DACS_MAX_SETUP_SPEND_DEM: \${DACS_MAX_SETUP_SPEND_DEM:-10}
  DACS_MAX_DEMOS_NETWORK_FEE_DEM: \${DACS_MAX_DEMOS_NETWORK_FEE_DEM:-2}
  DACS_MAX_EVM_NETWORK_FEE_ETH: \${DACS_MAX_EVM_NETWORK_FEE_ETH:-0.001}
  DACS_BUYER_AUTHORITY: \${DACS_BUYER_AUTHORITY:-}
  DACS_SELLER_AUTHORITY: \${DACS_SELLER_AUTHORITY:-}
  DACS_BUYER_PUBLIC_BASE_URL: \${DACS_BUYER_PUBLIC_BASE_URL:-}
  DACS_SELLER_PUBLIC_BASE_URL: \${DACS_SELLER_PUBLIC_BASE_URL:-}

x-dacs-role: &dacs-role
  build: .
  user: "\${DACS_RUNTIME_UID:?set DACS_RUNTIME_UID}:\${DACS_RUNTIME_GID:?set DACS_RUNTIME_GID}"
  read_only: true
  restart: unless-stopped
  init: true
  cap_drop: [ALL]
  security_opt: ["no-new-privileges:true"]
  pids_limit: 128
  mem_limit: 512m
  tmpfs:
    - /tmp:rw,noexec,nosuid,size=32m
  logging:
    driver: json-file
    options:
      max-size: 10m
      max-file: "3"
  healthcheck:
    test: ["CMD", "node", "-e", "const p=process.env.DACS_ROLE==='buyer'?3101:3102;fetch('http://127.0.0.1:'+p+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
    interval: 10s
    timeout: 3s
    retries: 3
    start_period: 10s

services:
  buyer:
    <<: *dacs-role
    environment:
      <<: *dacs-public-environment
      DACS_ROLE: buyer
      DACS_DEPLOYMENT: docker
      DACS_BUYER_DATA_DIRECTORY: /var/lib/dacs
      DACS_BUYER_DEMOS_SECRET_FILE: /run/secrets/demos-identity
      DACS_BUYER_EVM_SECRET_FILE: /run/secrets/evm-wallet
      DACS_BUYER_SERVICE_URL: http://buyer:3101
      DACS_SELLER_SERVICE_URL: http://seller:3102
    volumes:
      - \${DACS_BUYER_DATA_DIRECTORY:?set DACS_BUYER_DATA_DIRECTORY}:/var/lib/dacs
      - \${DACS_BUYER_DEMOS_SECRET_FILE:?set DACS_BUYER_DEMOS_SECRET_FILE}:/run/secrets/demos-identity:ro
      - \${DACS_BUYER_EVM_SECRET_FILE:?set DACS_BUYER_EVM_SECRET_FILE}:/run/secrets/evm-wallet:ro
    ports:
      - 127.0.0.1:3101:3101

  seller:
    <<: *dacs-role
    environment:
      <<: *dacs-public-environment
      DACS_ROLE: seller
      DACS_DEPLOYMENT: docker
      DACS_SELLER_DATA_DIRECTORY: /var/lib/dacs
      DACS_SELLER_DEMOS_SECRET_FILE: /run/secrets/demos-identity
      DACS_SELLER_EVM_SECRET_FILE: /run/secrets/evm-wallet
      DACS_BUYER_SERVICE_URL: http://buyer:3101
      DACS_SELLER_SERVICE_URL: http://seller:3102
    volumes:
      - \${DACS_SELLER_DATA_DIRECTORY:?set DACS_SELLER_DATA_DIRECTORY}:/var/lib/dacs
      - \${DACS_SELLER_DEMOS_SECRET_FILE:?set DACS_SELLER_DEMOS_SECRET_FILE}:/run/secrets/demos-identity:ro
      - \${DACS_SELLER_EVM_SECRET_FILE:?set DACS_SELLER_EVM_SECRET_FILE}:/run/secrets/evm-wallet:ro
    ports:
      - 127.0.0.1:3102:3102

`;

function envExample(options: LiveProjectTemplateOptions): string {
  return `# Public configuration only. Never put secret values in this file.
DACS_DEPLOYMENT=docker
DACS_RUNTIME_UID=${options.runtimeUid}
DACS_RUNTIME_GID=${options.runtimeGid}
DACS_BUYER_DATA_DIRECTORY=./data/buyer
DACS_SELLER_DATA_DIRECTORY=./data/seller
DACS_DEMOS_RPC_URL=https://node2.demos.sh
DACS_RAIL_REGISTRY_INDEX_REF=dacs4:registry:x402
DACS_X402_NETWORK=eip155:84532
DACS_MAX_SERVICE_ASSET=USDC
DACS_MAX_SERVICE_AMOUNT=1
DACS_MAX_SETUP_SPEND_DEM=10
DACS_MAX_DEMOS_NETWORK_FEE_DEM=2
DACS_MAX_EVM_NETWORK_FEE_ETH=0.001
DACS_BUYER_SERVICE_URL=http://127.0.0.1:3101
DACS_SELLER_SERVICE_URL=http://127.0.0.1:3102
DACS_BUYER_AUTHORITY=
DACS_SELLER_AUTHORITY=
DACS_BUYER_DEMOS_SECRET_FILE=
DACS_BUYER_EVM_SECRET_FILE=
DACS_SELLER_DEMOS_SECRET_FILE=
DACS_SELLER_EVM_SECRET_FILE=
`;
}

const GITIGNORE = `.env
.env.*
!.env.example
node_modules/
dist/
data/
artifacts/
*.log
*.pem
*.key
*.wallet
*.mnemonic
secrets/*
!secrets/README.md
`;

const SECRETS_README = `# Role secrets

Keep buyer and seller material in four different files outside this project.
Live mode rejects symlinks and group/other-readable secret files. Set each file
to mode 0600 and make its owner the non-root DACS_RUNTIME_UID/GID written by the
generator. Compose uses that same identity and bind-mounts only that role's
files read-only under /run/secrets; no secret is shared across roles.
Do not persist a write-confirmation variable in .env or Compose.
`;

function readme(options: LiveProjectTemplateOptions): string {
  return `# DACS fixed-price x402 live bootstrap

This generated project is an **experimental live bootstrap** using the exact
published SDK and host package surfaces. It contains deployment configuration
and the seller application callback, not copied protocol, database or transport
code.

Fresh generation is deliberately read-only. Run:

\`\`\`bash
cp .env.example .env
npm run dacs:doctor -- --phase pre-start --for start
npm run dacs:up
npm run dacs:doctor -- --phase post-start --for start
npm run dacs:setup -- --max-spend-dem 10
npm run dacs:buy -- --listing-ref stor-... --request-file ./request.json --max-service-amount 1 --max-network-fee-eth 0.001
npm run dacs:status
npm run dacs:down
\`\`\`

Doctor exit 5 means **blocked**, not failed: no credential, balance, signed rail,
Listing or reviewed adapter was guessed and no write occurred. Current generated
live services remain blocked until the reviewed Demos identity/registry and x402
effect adapters are installed by the lower SDK stack. Never bypass that gate.

Setup requires \`DACS_SETUP_WRITE_CONFIRM=1\`; purchase requires
\`DACS_PURCHASE_CONFIRM=1\`; funded doctor requires
\`DACS_DOCTOR_FUNDED_CONFIRM=1\`. These are intentionally absent from .env and
are non-interchangeable and are rejected if persisted there. Without its own
confirmation, setup or purchase prints a read-only preflight plan and exits.
Every executing command also requires explicit caps.

Deployment: **${options.deployment}**. Default local role: **${options.role}**.
Docker installs with lifecycle scripts disabled, then explicitly rebuilds only
the reviewed \`better-sqlite3\` native adapter. It uses separate non-root buyer/seller processes, secret mounts and durable
data bind mounts, read-only root filesystems, bounded resources and no database
port. \`dacs:down\` retains both data directories; use documented backup
procedures before any manual data removal.
`;
}

export function liveProjectTemplates(
  options: LiveProjectTemplateOptions,
): Readonly<Record<string, string>> {
  return Object.freeze({
    "package.json": packageJson(options.packageName),
    "tsconfig.json": TSCONFIG,
    "dacs.config.ts": dacsConfig(options.role),
    ".env.example": envExample(options),
    ".gitignore": GITIGNORE,
    ".dockerignore": DOCKERIGNORE,
    Dockerfile: DOCKERFILE,
    "compose.yaml": COMPOSE,
    "README.md": readme(options),
    "src/buyer.ts": BUYER_SOURCE,
    "src/seller.ts": SELLER_SOURCE,
    "src/verifier.ts": VERIFIER_SOURCE,
    "src/service.ts": SERVICE_SOURCE,
    "src/config.ts": CONFIG_SOURCE,
    "src/doctor.ts": DOCTOR_SOURCE,
    "src/cli.ts": CLI_SOURCE,
    "src/offline-smoke.ts": OFFLINE_SMOKE_SOURCE,
    "test/live-bootstrap.test.ts": TEST_SOURCE,
    "data/.gitkeep": "",
    "secrets/README.md": SECRETS_README,
  });
}
