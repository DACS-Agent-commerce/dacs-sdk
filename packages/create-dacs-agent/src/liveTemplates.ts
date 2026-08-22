export interface LiveProjectTemplateOptions {
  packageName: string;
  deployment: "local" | "docker";
  role: "buyer" | "seller" | "verifier";
  runtimeUid: number;
  runtimeGid: number;
}

const SDK_VERSION = "0.1.0-alpha.0";
const TSX_VERSION = "4.23.12";
const STANDARD_REVISION = "965df755aba4ff392f1fb37a93d287242b177ba4";
const CONFIG_SCHEMA_VERSION = 1;
const SQLITE_SCHEMA_VERSION = 6;

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
      // demosdk 4.0.16 publishes one extensionless ESM directory import. The
      // declared loader keeps generated services runnable on the supported
      // Node floors without mutating the installed dependency.
      test: "npm run build && node --import tsx --test dist/test/live-bootstrap.test.js",
      "dacs:doctor": "npm run build --silent && node --import tsx dist/src/cli.js doctor",
      "dacs:doctor:funded": "npm run build --silent && node --import tsx dist/src/cli.js doctor-funded",
      "dacs:up": "npm run build --silent && node --import tsx dist/src/cli.js up",
      "dacs:setup": "npm run build --silent && node --import tsx dist/src/cli.js setup",
      "dacs:buy": "npm run build --silent && node --import tsx dist/src/cli.js buy",
      "dacs:status": "npm run build --silent && node --import tsx dist/src/cli.js status",
      "dacs:down": "npm run build --silent && node --import tsx dist/src/cli.js down",
      "dacs:upgrade": "npm run build --silent && node --import tsx dist/src/cli.js upgrade",
      "dacs:service": "npm run build --silent && node --import tsx dist/src/service.js",
      "dacs:smoke:offline": "npm run build --silent && node --import tsx dist/src/offline-smoke.js",
    },
    dependencies: {
      "@kynesyslabs/dacs": SDK_VERSION,
      "@kynesyslabs/dacs-node": SDK_VERSION,
      "@kynesyslabs/demosdk": "4.0.16",
      "@x402/core": "2.15.0",
      "@x402/evm": "2.15.0",
      "@x402/fetch": "2.15.0",
      tsx: TSX_VERSION,
      "viem": "2.55.19",
    },
    dacs: {
      generatorVersion: SDK_VERSION,
      releaseMetadataVersion: 1,
      standardRevision: STANDARD_REVISION,
      configSchemaVersion: CONFIG_SCHEMA_VERSION,
      sqliteSchemaVersion: SQLITE_SCHEMA_VERSION,
      supportedSqliteMigrationFrom: [1, 2, 3, 4, 5, 6],
      breakingConfigurationChanges: [],
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
      registryIndexRef: process.env.DACS_RAIL_REGISTRY_INDEX_REF ?? "dacs4:registry:v0.1",
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

export function configuredRailStewardAuthority(): string | undefined {
  const value = process.env.DACS_RAIL_STEWARD_AUTHORITY;
  return value === undefined || value.trim() === "" ? undefined : value;
}

export function configuredX402RailId(): string {
  return process.env.DACS_X402_RAIL_ID ?? "x402:default";
}

export function configuredX402FacilitatorUrl(): string | undefined {
  const value = process.env.DACS_X402_FACILITATOR_URL;
  return value === undefined || value.trim() === "" ? undefined : value;
}

export function configuredEvmRpcUrl(): string | undefined {
  const value = process.env.DACS_EVM_RPC_URL;
  return value === undefined || value.trim() === "" ? undefined : value;
}

export function configuredSellerEvmPayee(): string | undefined {
  const value = process.env.DACS_SELLER_EVM_PAYEE;
  return value === undefined || value.trim() === "" ? undefined : value;
}

export function configuredListingDraftFile(): string | undefined {
  const value = process.env.DACS_LISTING_DRAFT_FILE;
  return value === undefined || value.trim() === "" ? undefined : resolve(value);
}

export function configuredX402AuthorizationSearchFromBlock(): number | undefined {
  const value = process.env.DACS_X402_AUTHORIZATION_SEARCH_FROM_BLOCK;
  if (value === undefined || value.trim() === "") return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("x402 authorization search floor is invalid");
  }
  const block = Number(value);
  if (!Number.isSafeInteger(block)) {
    throw new Error("x402 authorization search floor is unsafe");
  }
  return block;
}

export function configuredX402TokenDomain(): Readonly<{
  name: string;
  version: string;
}> {
  const name = process.env.DACS_X402_TOKEN_NAME ?? "USDC";
  const version = process.env.DACS_X402_TOKEN_VERSION ?? "2";
  if (name.length === 0 || name.trim() !== name || version.length === 0 ||
      version.trim() !== version) {
    throw new Error("x402 token domain is invalid");
  }
  return Object.freeze({ name, version });
}

export function configuredFixedPriceAmount(): string {
  const value = process.env.DACS_FIXED_PRICE_AMOUNT ?? "1";
  if (value.length === 0 || value.trim() !== value) {
    throw new Error("fixed service price is invalid");
  }
  return value;
}

export function actorDatabasePath(role: GeneratedLiveRole): string {
  return resolve(loadRoleConfig(role).dataDirectory, "actor.sqlite");
}

export function listingDiscoveryDirectory(): string {
  return resolve(loadRoleConfig("seller").dataDirectory, "discovery");
}

export function actorSecretPaths(role: GeneratedLiveRole): readonly string[] {
  return SECRET_NAMES[role].flatMap((name) => {
    const value = process.env[name];
    return value === undefined || value.trim() === "" ? [] : [resolve(value)];
  });
}

export function actorSecretPath(
  role: "buyer" | "seller",
  kind: "demos-identity" | "evm-wallet",
): string | undefined {
  const name = role === "buyer"
    ? kind === "demos-identity" ? "DACS_BUYER_DEMOS_SECRET_FILE" : "DACS_BUYER_EVM_SECRET_FILE"
    : kind === "demos-identity" ? "DACS_SELLER_DEMOS_SECRET_FILE" : "DACS_SELLER_EVM_SECRET_FILE";
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : resolve(value);
}

export function configuredFundedDoctorAuthority(): string | undefined {
  const value = process.env.DACS_FUNDED_DOCTOR_AUTHORITY;
  return value === undefined || value.trim() === "" ? undefined : value;
}

export function configuredFundedDoctorSecretPath(): string | undefined {
  const value = process.env.DACS_FUNDED_DOCTOR_DEMOS_SECRET_FILE;
  return value === undefined || value.trim() === "" ? undefined : resolve(value);
}

export function fundedDoctorDataDirectory(walletName: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(walletName)) {
    throw new Error("funded doctor wallet name is invalid");
  }
  const configured = process.env.DACS_FUNDED_DOCTOR_DATA_ROOT;
  const root = resolve(configured === undefined || configured.trim() === ""
    ? "./data/funded-doctor" : configured);
  return resolve(root, walletName);
}

export function serviceEndpoint(role: "buyer" | "seller"): string {
  return process.env[role === "buyer" ? "DACS_BUYER_SERVICE_URL" : "DACS_SELLER_SERVICE_URL"] ??
    (role === "buyer" ? "http://127.0.0.1:3101" : "http://127.0.0.1:3102");
}
`;

const DOCTOR_SOURCE = `import { constants } from "node:fs";
import { access, lstat, open, readFile, statfs } from "node:fs/promises";
import { spawn } from "node:child_process";

import {
  RAIL_REGISTRY_INDEX_ADDRESS,
  VERSION,
  createViemX402BuyerEvmReadClient,
  resolveRail,
} from "@kynesyslabs/dacs";
import { canonicalizeDecimal, sha256Hex } from "@kynesyslabs/dacs/canonical";
import { FIXED_PRICE_X402_STANDARD_REVISION } from "@kynesyslabs/dacs/commerce";
import {
  canonicalDemosAgentPublicKey,
  sameCanonicalClaimIdentity,
} from "@kynesyslabs/dacs/identity";
import {
  DACS_LIVE_DOCTOR_CHECK_IDS,
  DACS_NODE_LIVE_PROFILE,
  createDacsDemosActorRuntimeV1,
  createDacsDemosRailRegistryProviderV1,
  createDacsRoleReadinessLatchV1,
  createDacsRoleServiceDoctorProbesV1,
  createViemDacsX402BalanceReadClientV1,
  deriveDacsEvmRoleIdentityV1,
  establishDacsRoleServiceReadinessV1,
  inspectDacsDemosBalanceHeadroomV1,
  inspectDacsNodePackageIntegrityV1,
  inspectDacsX402AssetBalanceV1,
  inspectDacsX402GasBalanceV1,
  inspectDacsX402TokenDomainV1,
  inspectDacsX402PurchaseCostV1,
  resolveDacsX402ExistingListingV1,
  inspectDacsX402ListingDraftV1,
  loadDacsSecretV1,
  readDacsPublicJsonV1,
  runDacsRoleTransportDiagnosticV1,
  runDacsLiveDoctorV1,
  type DacsDemosActorRuntimeV1,
  type DacsLiveDoctorPhaseV1,
  type DacsLiveDoctorProbeResultV1,
  type DacsLiveDoctorProbesV1,
  type DacsLiveDoctorReportV1,
  type DacsLiveDoctorScopeV1,
} from "@kynesyslabs/dacs-node";
import {
  inspectExistingDacsNodeSqliteDatabaseV1,
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "@kynesyslabs/dacs-node/sqlite";
import { HTTPFacilitatorClient } from "@x402/core/http";

import {
  actorDatabasePath,
  actorSecretPath,
  actorSecretPaths,
  configuredAuthority,
  configuredEvmRpcUrl,
  configuredFixedPriceAmount,
  configuredListingDraftFile,
  configuredRailStewardAuthority,
  configuredSellerEvmPayee,
  configuredX402AuthorizationSearchFromBlock,
  configuredX402FacilitatorUrl,
  configuredX402RailId,
  configuredX402TokenDomain,
  loadRoleConfig,
  serviceEndpoint,
} from "./config.js";

const ROLES = Object.freeze(["buyer", "seller"] as const);
const AUTHORITY_RE = /^did:demos:agent:[0-9a-f]{64}$/;

interface DoctorActor {
  role: "buyer" | "seller";
  authority: string;
  runtime: Readonly<DacsDemosActorRuntimeV1>;
  evmIdentity: Readonly<{
    network: string;
    chainId: number;
    address: string;
  }>;
  database?: DacsNodeSqliteDatabase;
}

type DoctorActors = Readonly<Record<"buyer" | "seller", Readonly<DoctorActor>>>;

export interface GeneratedDoctorOperationV1 {
  listingRef: string;
  maximumServiceAmount: string;
  maximumNetworkFeeEth: string;
}

function pass(facts?: Readonly<Record<string, string | number | boolean | null>>) {
  return Object.freeze({ status: "pass" as const, ...(facts === undefined ? {} : { facts }) });
}
function fail(reasonCode: string) {
  return Object.freeze({ status: "fail" as const, reasonCode });
}
function blocked(reasonCode: string) {
  return Object.freeze({ status: "blocked" as const, reasonCode });
}

async function readPublicJsonFile(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const observed = await file.stat();
    if (!observed.isFile() || observed.size <= 0 || observed.size > 1_048_576) {
      throw new Error("public JSON file is unsafe");
    }
    const bytes = await file.readFile();
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } finally {
      bytes.fill(0);
    }
  } finally {
    await file.close();
  }
}

function listingPriceAmount(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const pricing = (value as Record<string, unknown>).pricing;
  if (pricing === null || typeof pricing !== "object" || Array.isArray(pricing)) return undefined;
  const price = (pricing as Record<string, unknown>).price;
  if (price === null || typeof price !== "object" || Array.isArray(price)) return undefined;
  const amount = (price as Record<string, unknown>).amount;
  return typeof amount === "string" ? amount : undefined;
}

async function openDoctorActors(
  phase: DacsLiveDoctorPhaseV1,
): Promise<DoctorActors | undefined> {
  const opened: DoctorActor[] = [];
  try {
    for (const role of ROLES) {
      const authority = configuredAuthority(role);
      const secretPath = actorSecretPath(role, "demos-identity");
      if (authority === undefined || secretPath === undefined) {
        throw new Error("doctor actor prerequisite unavailable");
      }
      const secret = await loadDacsSecretV1({
        name: role + "-doctor-demos-identity",
        mode: "live-demos",
        filePath: secretPath,
      });
      const runtime = await createDacsDemosActorRuntimeV1({
        config: loadRoleConfig(role),
        role,
        authority,
        demosIdentity: secret,
        writePolicy: "read-only",
      });
      const evmSecretPath = actorSecretPath(role, "evm-wallet");
      if (evmSecretPath === undefined) throw new Error("doctor EVM secret unavailable");
      const evmSecret = await loadDacsSecretV1({
        name: role + "-doctor-evm-wallet",
        mode: "live-demos",
        filePath: evmSecretPath,
      });
      const evmIdentity = await deriveDacsEvmRoleIdentityV1({
        config: loadRoleConfig(role),
        role,
        evmPrivateKey: evmSecret,
      });
      const database = phase === "post-start"
        ? await openDacsNodeSqliteDatabase({
            databasePath: actorDatabasePath(role),
            mode: "live-demos",
            profile: DACS_NODE_LIVE_PROFILE,
            role,
            authority,
          })
        : undefined;
      opened.push({
        role,
        authority,
        runtime,
        evmIdentity,
        ...(database === undefined ? {} : { database }),
      });
    }
    const buyer = opened.find((actor) => actor.role === "buyer");
    const seller = opened.find((actor) => actor.role === "seller");
    return buyer === undefined || seller === undefined
      ? undefined : Object.freeze({ buyer, seller });
  } catch {
    for (const actor of opened) actor.database?.close();
    return undefined;
  }
}

function closeDoctorActors(actors: DoctorActors | undefined): void {
  if (actors === undefined) return;
  actors.buyer.database?.close();
  actors.seller.database?.close();
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

function baseProbes(
  actors: DoctorActors | undefined,
  operation: Readonly<GeneratedDoctorOperationV1> | undefined,
): DacsLiveDoctorProbesV1 {
  const actorUnavailable = () => blocked("role-demos-runtime-unavailable");
  const stewardAuthority = configuredRailStewardAuthority();
  const stewardPublicKey = stewardAuthority === undefined
    ? null : canonicalDemosAgentPublicKey(stewardAuthority);
  let railTask: ReturnType<typeof resolveRail> | undefined;
  const selectedRail = () => {
    if (actors === undefined || stewardAuthority === undefined || stewardPublicKey === null) {
      throw new Error("rail authority prerequisite unavailable");
    }
    railTask ??= resolveRail(
      RAIL_REGISTRY_INDEX_ADDRESS,
      configuredX402RailId(),
      createDacsDemosRailRegistryProviderV1({
        runtime: actors.buyer.runtime,
        stewardAuthority,
        stewardPublicKey,
      }),
    );
    return railTask;
  };
  let fundingTask: Promise<Readonly<{
    asset: Readonly<DacsLiveDoctorProbeResultV1>;
    gas: Readonly<DacsLiveDoctorProbeResultV1>;
    tokenDomain: Readonly<DacsLiveDoctorProbeResultV1>;
  }>> | undefined;
  const selectedFunding = () => {
    if (actors === undefined) throw new Error("x402 funding actor unavailable");
    const rpcUrl = configuredEvmRpcUrl();
    if (rpcUrl === undefined) throw new Error("x402 funding RPC unavailable");
    fundingTask ??= (async () => {
      const rail = await selectedRail();
      const buyer = loadRoleConfig("buyer");
      if (rail.asset.kind !== "erc20" ||
          rail.asset.chainId !== actors.buyer.evmIdentity.chainId ||
          rail.asset.symbol !== buyer.limits.maxServiceAmount.asset) {
        const mismatch = fail("x402-funding-asset-mismatch");
        return Object.freeze({ asset: mismatch, gas: mismatch, tokenDomain: mismatch });
      }
      const client = await createViemDacsX402BalanceReadClientV1({
        rpcUrl,
        chainId: actors.buyer.evmIdentity.chainId,
      });
      const [asset, gas, tokenDomain] = await Promise.all([
        inspectDacsX402AssetBalanceV1({
          client,
          chainId: actors.buyer.evmIdentity.chainId,
          payer: actors.buyer.evmIdentity.address,
          asset: rail.asset.contract,
          symbol: rail.asset.symbol,
          decimals: rail.asset.decimals,
          minimumAmount: operation?.maximumServiceAmount ?? buyer.limits.maxServiceAmount.amount,
        }),
        inspectDacsX402GasBalanceV1({
          client,
          chainId: actors.buyer.evmIdentity.chainId,
          payer: actors.buyer.evmIdentity.address,
          // The configured value is a ceiling, not an estimate. The x402 cost
          // gate remains blocked until exact Listing/payment preparation can
          // prove whether the buyer owes any gas (facilitators commonly sponsor it).
          minimumEth: "0",
        }),
        inspectDacsX402TokenDomainV1({
          client,
          chainId: actors.buyer.evmIdentity.chainId,
          asset: rail.asset.contract,
          expected: configuredX402TokenDomain(),
        }),
      ]);
      return Object.freeze({ asset, gas, tokenDomain });
    })();
    return fundingTask;
  };
  let listingTask: ReturnType<typeof resolveDacsX402ExistingListingV1> | undefined;
  const selectedListing = () => {
    if (actors === undefined || operation === undefined) {
      throw new Error("existing Listing operation context unavailable");
    }
    const sellerEndpoint = loadRoleConfig("seller").publicBaseUrl;
    if (sellerEndpoint === undefined) throw new Error("seller public endpoint unavailable");
    listingTask ??= (async () => resolveDacsX402ExistingListingV1({
      listingRef: operation.listingRef,
      sellerAuthority: actors.seller.authority,
      sellerPublicKey: actors.seller.runtime.publicKey,
      sellerPublicEndpoint: sellerEndpoint,
      sellerPayee: actors.seller.evmIdentity.address,
      network: loadRoleConfig("buyer").rail.requestedNetwork as \`eip155:\${number}\`,
      rail: await selectedRail(),
      maximumServiceAmount: operation.maximumServiceAmount,
      now: Date.now(),
      readAnchor: (locator) => actors.buyer.runtime.adapter.readAnchor(locator),
      async authenticateAnchor(input) {
        const receipt = await actors.buyer.runtime.adapter.resolveDemosAnchorReceipt(input);
        return receipt !== null &&
          await actors.buyer.runtime.adapter.verifyDemosAnchorReceipt(receipt) === true;
      },
      readJson: (url) => readDacsPublicJsonV1(url, { timeoutMs: 5_000, maxBytes: 1_048_576 }),
    }))();
    return listingTask;
  };
  return Object.freeze({
    "local.node-version": () => supportedNode() ? pass({ nodeVersion: process.version })
      : fail("node-version-unsupported"),
    "local.package-integrity": inspectDacsNodePackageIntegrityV1,
    "local.version-bindings": () => pass({ sdkVersion: VERSION,
      standardRevision: FIXED_PRICE_X402_STANDARD_REVISION, profile: DACS_NODE_LIVE_PROFILE }),
    "local.configuration": () => {
      try {
        const configs = ROLES.map((role) => loadRoleConfig(role));
        return configs.every((config) =>
          config.rail.registryIndexRef === RAIL_REGISTRY_INDEX_ADDRESS)
          ? pass() : fail("rail-registry-index-incompatible");
      }
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
    "local.transport-identities": actors === undefined ? actorUnavailable : async () => {
      try {
        const [sellerFromBuyer, buyerFromSeller] = await Promise.all([
          actors.buyer.runtime.adapter.resolveIdentity(actors.seller.authority),
          actors.seller.runtime.adapter.resolveIdentity(actors.buyer.authority),
        ]);
        const valid = sameCanonicalClaimIdentity(
          sellerFromBuyer.ref,
          actors.seller.authority,
        ) && (sellerFromBuyer.boundTo === undefined || sameCanonicalClaimIdentity(
          sellerFromBuyer.boundTo,
          actors.seller.authority,
        )) && sameCanonicalClaimIdentity(
          buyerFromSeller.ref,
          actors.buyer.authority,
        ) && (buyerFromSeller.boundTo === undefined || sameCanonicalClaimIdentity(
          buyerFromSeller.boundTo,
          actors.buyer.authority,
        ));
        return valid ? pass({ directionCount: 2 })
          : fail("transport-identity-resolution-mismatch");
      } catch { return fail("transport-identity-resolution-failed"); }
    },
    "local.deployment-runtime": dockerRuntime,
    "demos.rpc-chain": actors === undefined ? actorUnavailable : async () => {
      try {
        await Promise.all([actors.buyer.runtime.networkInfo(), actors.seller.runtime.networkInfo()]);
        return pass({ actorCount: 2 });
      } catch { return fail("demos-rpc-unavailable"); }
    },
    "demos.storage-read": actors === undefined ? actorUnavailable
      : stewardPublicKey === null ? () => blocked("rail-steward-authority-missing")
      : async () => {
          try { await selectedRail(); return pass(); }
          catch { return fail("demos-storage-read-or-proof-failed"); }
        },
    "demos.binding-resolution": actors === undefined ? actorUnavailable : async () => {
      try {
        const [seller, buyer] = await Promise.all([
          actors.buyer.runtime.adapter.resolveIdentity(actors.seller.authority),
          actors.seller.runtime.adapter.resolveIdentity(actors.buyer.authority),
        ]);
        return sameCanonicalClaimIdentity(seller.ref, actors.seller.authority) &&
            sameCanonicalClaimIdentity(buyer.ref, actors.buyer.authority)
          ? pass({ directionCount: 2 }) : fail("demos-binding-resolution-mismatch");
      } catch { return fail("demos-binding-resolution-failed"); }
    },
    "demos.nonce": actors === undefined ? actorUnavailable : async () => {
      try {
        await Promise.all([actors.buyer.runtime.addressNonce(), actors.seller.runtime.addressNonce()]);
        return pass({ actorCount: 2 });
      } catch { return fail("demos-nonce-unavailable"); }
    },
    "demos.balance-fees": actors === undefined ? actorUnavailable : (probeContext) => {
      const buyer = loadRoleConfig("buyer");
      const seller = loadRoleConfig("seller");
      const minimumDem = probeContext.scope === "setup"
        ? { buyer: "0", seller: seller.limits.maxSetupSpendDem }
        : {
            buyer: buyer.limits.maxDemosNetworkFeeDem,
            seller: seller.limits.maxDemosNetworkFeeDem,
          };
      return inspectDacsDemosBalanceHeadroomV1({
        actors: { buyer: actors.buyer.runtime, seller: actors.seller.runtime },
        minimumDem,
      });
    },
    "demos.wallet-identity": actors === undefined ? actorUnavailable : () =>
      actors.buyer.runtime.authority === actors.buyer.authority &&
        actors.seller.runtime.authority === actors.seller.authority
        ? pass({ actorCount: 2 }) : fail("demos-wallet-identity-mismatch"),
    "demos.listing-candidate": actors === undefined ? actorUnavailable : async () => {
      const path = configuredListingDraftFile();
      const endpoint = loadRoleConfig("seller").publicBaseUrl;
      if (path === undefined) return blocked("listing-candidate-file-missing");
      if (endpoint === undefined) return blocked("seller-public-endpoint-missing");
      try {
        const draft = await readPublicJsonFile(path);
        const rail = await selectedRail();
        const inspected = inspectDacsX402ListingDraftV1({
          draft,
          sellerAuthority: actors.seller.authority,
          sellerPublicKey: actors.seller.runtime.publicKey,
          sellerPublicEndpoint: endpoint,
          sellerPayee: actors.seller.evmIdentity.address,
          network: loadRoleConfig("seller").rail.requestedNetwork as \`eip155:\${number}\`,
          rail,
          maximumServiceAmount: loadRoleConfig("buyer").limits.maxServiceAmount.amount,
          now: Date.now(),
        });
        if (inspected.status !== "pass") return inspected;
        const amount = listingPriceAmount(draft);
        return amount !== undefined && canonicalizeDecimal(amount) ===
            canonicalizeDecimal(configuredFixedPriceAmount())
          ? inspected : fail("listing-fixed-price-runtime-mismatch");
      } catch { return fail("listing-candidate-read-or-authority-invalid"); }
    },
    "demos.listing-existing": actors === undefined ? actorUnavailable
      : operation === undefined ? () => blocked("listing-operation-context-missing")
      : async () => {
          try {
            const result = await selectedListing();
            return result.status === "verified"
              ? pass(result.admission.facts) : result;
          } catch { return blocked("listing-existing-resolution-unavailable"); }
        },
    "demos.engagement-endpoint-shape": () => {
      try { new URL(serviceEndpoint("buyer")); new URL(serviceEndpoint("seller")); return pass(); }
      catch { return fail("engagement-endpoint-invalid"); }
    },
    "x402.rail-authority": actors === undefined ? actorUnavailable
      : stewardPublicKey === null ? () => blocked("rail-steward-authority-missing")
      : async () => {
          try {
            const rail = await selectedRail();
            return rail.railType === "x402" && rail.phaseHandler === "pay-x402"
              ? pass({ railId: rail.railId, railVersion: rail.railVersion })
              : fail("x402-rail-incompatible");
          } catch { return fail("x402-rail-authority-invalid"); }
        },
    "x402.testnet-policy": () => loadRoleConfig("buyer").rail.requestedNetwork === "eip155:84532"
      ? pass() : fail("x402-mainnet-or-unsupported-network"),
    "x402.endpoints": actors === undefined ? actorUnavailable
      : stewardPublicKey === null ? () => blocked("rail-steward-authority-missing")
      : async () => {
          const facilitatorUrl = configuredX402FacilitatorUrl();
          const evmRpcUrl = configuredEvmRpcUrl();
          const authorizationSearchFromBlock = configuredX402AuthorizationSearchFromBlock();
          if (facilitatorUrl === undefined) return blocked("x402-facilitator-url-missing");
          if (evmRpcUrl === undefined) return blocked("x402-evm-rpc-url-missing");
          if (authorizationSearchFromBlock === undefined) {
            return blocked("x402-authorization-search-floor-missing");
          }
          try {
            configuredX402TokenDomain();
            const rail = await selectedRail();
            const resource = rail.network.kind === "x402-resource"
              ? new URL(rail.network.resourceBaseUrl) : undefined;
            const facilitator = new URL(facilitatorUrl);
            const rpc = new URL(evmRpcUrl);
            if (resource === undefined || resource.protocol !== "https:" ||
                facilitator.protocol !== "https:" || facilitator.username !== "" ||
                facilitator.password !== "" || facilitator.search !== "" ||
                facilitator.hash !== "" ||
                rpc.protocol !== "https:" || rpc.username !== "" || rpc.password !== "") {
              return fail("x402-endpoint-policy-invalid");
            }
            const reader = await createViemX402BuyerEvmReadClient({
              rpcUrl: evmRpcUrl,
              chainId: actors.buyer.evmIdentity.chainId,
            });
            const [head, supported] = await Promise.all([
              reader.getFinalityHead(),
              new HTTPFacilitatorClient({ url: facilitatorUrl }).getSupported(),
            ]);
            const finality = head as { chainId?: unknown };
            return finality !== null && typeof finality === "object" &&
                finality.chainId === actors.buyer.evmIdentity.chainId && supported !== null
              ? pass({
                  resourceOrigin: resource.origin,
                  facilitatorOrigin: facilitator.origin,
                  chainId: actors.buyer.evmIdentity.chainId,
                })
              : fail("x402-endpoint-capability-mismatch");
          } catch { return fail("x402-endpoint-resolution-failed"); }
        },
    "x402.token-domain": actors === undefined ? actorUnavailable : async () => {
      try { return (await selectedFunding()).tokenDomain; }
      catch { return blocked("x402-funding-prerequisite-unavailable"); }
    },
    "x402.payer-binding": actors === undefined ? actorUnavailable : () =>
      actors.buyer.evmIdentity.network === loadRoleConfig("buyer").rail.requestedNetwork &&
        /^0x[0-9A-Fa-f]{40}$/.test(actors.buyer.evmIdentity.address)
        ? pass({ payer: actors.buyer.evmIdentity.address.toLowerCase() })
        : fail("x402-payer-binding-mismatch"),
    "x402.payee-binding": actors === undefined ? actorUnavailable : () =>
      configuredSellerEvmPayee() !== undefined &&
        actors.seller.evmIdentity.network === loadRoleConfig("seller").rail.requestedNetwork &&
        /^0x[0-9A-Fa-f]{40}$/.test(actors.seller.evmIdentity.address) &&
        actors.seller.evmIdentity.address.toLowerCase() ===
          configuredSellerEvmPayee()!.toLowerCase() &&
        actors.seller.evmIdentity.address.toLowerCase() !==
          actors.buyer.evmIdentity.address.toLowerCase()
        ? pass({ payee: actors.seller.evmIdentity.address.toLowerCase() })
        : fail("x402-payee-binding-mismatch"),
    "x402.asset-balance": actors === undefined ? actorUnavailable : async () => {
      try { return (await selectedFunding()).asset; }
      catch { return blocked("x402-funding-prerequisite-unavailable"); }
    },
    "x402.gas-balance": actors === undefined ? actorUnavailable : async () => {
      try { return (await selectedFunding()).gas; }
      catch { return blocked("x402-funding-prerequisite-unavailable"); }
    },
    "x402.service-limit": () => pass({
      asset: loadRoleConfig("buyer").limits.maxServiceAmount.asset,
      amount: loadRoleConfig("buyer").limits.maxServiceAmount.amount,
    }),
    "x402.cost-estimate": actors === undefined ? actorUnavailable
      : operation === undefined ? () => blocked("purchase-cost-context-missing")
      : async () => {
          try {
            const result = await selectedListing();
            return result.status === "verified"
              ? inspectDacsX402PurchaseCostV1({
                  admission: result.admission,
                  maximumServiceAmount: operation.maximumServiceAmount,
                  maximumNetworkFeeEth: operation.maximumNetworkFeeEth,
                })
              : result;
          } catch { return blocked("x402-cost-estimate-unavailable"); }
        },
  });
}

export async function runGeneratedDoctor(
  phase: DacsLiveDoctorPhaseV1,
  scope: DacsLiveDoctorScopeV1,
  operation?: Readonly<GeneratedDoctorOperationV1>,
): Promise<Readonly<DacsLiveDoctorReportV1>> {
  const actors = await openDoctorActors(phase);
  try {
    const service = phase === "post-start" ? createDacsRoleServiceDoctorProbesV1({
      targets: [
        { role: "buyer", endpoint: serviceEndpoint("buyer") },
        { role: "seller", endpoint: serviceEndpoint("seller") },
      ],
      sdkVersion: VERSION,
      standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
      profile: DACS_NODE_LIVE_PROFILE,
      ...(actors === undefined ? {} : {
        transportDiagnostic: (role: "buyer" | "seller") => {
          const actor = actors[role];
          if (actor.database === undefined) {
            throw new Error("doctor actor database unavailable");
          }
          const peerRole = role === "buyer" ? "seller" : "buyer";
          return runDacsRoleTransportDiagnosticV1({
            role,
            database: actor.database,
            demos: actor.runtime,
            peerAuthority: actors[peerRole].authority,
            peerEndpoint: new URL(
              "/dacs-transport/v1/messages",
              serviceEndpoint(peerRole),
            ).toString(),
            workerId: role + "-doctor-" + String(process.pid),
          });
        },
      }),
    }) : {};
    const probes = Object.freeze({ ...baseProbes(actors, operation), ...service });
    const doctor = {
      sdkVersion: VERSION,
      standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
      profile: DACS_NODE_LIVE_PROFILE,
      probes,
      // A Demos block is approximately ten seconds. Registry resolution can
      // legitimately cross one block boundary during node catch-up, so the
      // start gate must not abort an otherwise healthy shared read task at
      // half a consensus round.
      probeTimeoutMs: 30_000,
    };
    const report = phase === "post-start" && scope === "start" && actors !== undefined &&
        actors.buyer.database !== undefined && actors.seller.database !== undefined
      ? (await establishDacsRoleServiceReadinessV1({
          actors: [
            {
              role: "buyer",
              latch: createDacsRoleReadinessLatchV1({
                config: loadRoleConfig("buyer"),
                authority: actors.buyer.authority,
              }),
              sign: actors.buyer.runtime.signTransportEnvelope,
            },
            {
              role: "seller",
              latch: createDacsRoleReadinessLatchV1({
                config: loadRoleConfig("seller"),
                authority: actors.seller.authority,
              }),
              sign: actors.seller.runtime.signTransportEnvelope,
            },
          ],
          doctor,
        })).report
      : await runDacsLiveDoctorV1({ phase, scope, ...doctor });
    if (report.checks.length !== DACS_LIVE_DOCTOR_CHECK_IDS.length) {
      throw new Error("doctor-catalog-incomplete");
    }
    return report;
  } finally {
    closeDoctorActors(actors);
  }
}
`;

const SETUP_SOURCE = `import { constants } from "node:fs";
import { open } from "node:fs/promises";

import {
  RAIL_REGISTRY_INDEX_ADDRESS,
  resolveRail,
} from "@kynesyslabs/dacs";
import { canonicalize, canonicalizeDecimal, sha256Hex } from "@kynesyslabs/dacs/canonical";
import { canonicalDemosAgentPublicKey } from "@kynesyslabs/dacs/identity";
import {
  DACS_NODE_LIVE_PROFILE,
  createDacsDemosActorRuntimeV1,
  createDacsDemosRailRegistryProviderV1,
  createDacsListingSetupExecutorV1,
  deriveDacsEvmRoleIdentityV1,
  loadDacsSecretV1,
  openDacsListingDiscoveryStoreV1,
  prepareDacsListingSetupV1,
  runDacsGuardedCommandV1,
  type DacsGuardedCommandResultV1,
  type DacsLiveDoctorReportV1,
  type DacsPreparedListingSetupV1,
} from "@kynesyslabs/dacs-node";
import { openDacsNodeSqliteDatabase } from "@kynesyslabs/dacs-node/sqlite";

import {
  actorDatabasePath,
  actorSecretPath,
  configuredAuthority,
  configuredListingDraftFile,
  configuredRailStewardAuthority,
  configuredSellerEvmPayee,
  configuredX402RailId,
  listingDiscoveryDirectory,
  loadRoleConfig,
} from "./config.js";

interface PreparedContext {
  prepared: Readonly<DacsPreparedListingSetupV1>;
  seller: Awaited<ReturnType<typeof createDacsDemosActorRuntimeV1>>;
  rail: Awaited<ReturnType<typeof resolveRail>>;
}

async function publicJsonFile(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const observed = await file.stat();
    if (!observed.isFile() || observed.size <= 0 || observed.size > 1_048_576) {
      throw new Error("Listing candidate file is unsafe");
    }
    const bytes = await file.readFile();
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } finally {
      bytes.fill(0);
    }
  } finally {
    await file.close();
  }
}

function exactMaximum(value: string, ceiling: string): string {
  const normalized = canonicalizeDecimal(value);
  const configured = canonicalizeDecimal(ceiling);
  if (normalized.startsWith("-") || normalized === "0") {
    throw new Error("setup maximum must be positive");
  }
  const decimal = (input: string) => {
    const [whole, fraction = ""] = input.split(".");
    return { whole: whole!, fraction };
  };
  const left = decimal(normalized);
  const right = decimal(configured);
  const scale = Math.max(left.fraction.length, right.fraction.length);
  const units = (input: typeof left) => BigInt(input.whole + input.fraction.padEnd(scale, "0"));
  if (units(left) > units(right)) throw new Error("setup maximum exceeds configured ceiling");
  return normalized;
}

async function buildPrepared(
  maximumSpendDem: string,
  writePolicy: "perform" | "read-only",
): Promise<PreparedContext> {
  const sellerConfig = loadRoleConfig("seller");
  const buyerConfig = loadRoleConfig("buyer");
  const sellerAuthority = configuredAuthority("seller");
  const buyerAuthority = configuredAuthority("buyer");
  const demosSecretPath = actorSecretPath("seller", "demos-identity");
  const evmSecretPath = actorSecretPath("seller", "evm-wallet");
  const draftPath = configuredListingDraftFile();
  const stewardAuthority = configuredRailStewardAuthority();
  const sellerEndpoint = sellerConfig.publicBaseUrl;
  const configuredPayee = configuredSellerEvmPayee();
  const stewardPublicKey = stewardAuthority === undefined
    ? null : canonicalDemosAgentPublicKey(stewardAuthority);
  if (sellerAuthority === undefined || buyerAuthority === undefined ||
      demosSecretPath === undefined || evmSecretPath === undefined || draftPath === undefined ||
      stewardAuthority === undefined || stewardPublicKey === null || sellerEndpoint === undefined ||
      configuredPayee === undefined || !/^0x[0-9A-Fa-f]{40}$/.test(configuredPayee)) {
    throw new Error("setup prerequisite is unavailable");
  }
  const demosSecret = await loadDacsSecretV1({
    name: "seller-setup-demos-identity",
    mode: "live-demos",
    filePath: demosSecretPath,
  });
  const seller = await createDacsDemosActorRuntimeV1({
    config: sellerConfig,
    role: "seller",
    authority: sellerAuthority,
    demosIdentity: demosSecret,
    writePolicy,
  });
  const evmSecret = await loadDacsSecretV1({
    name: "seller-setup-evm-wallet",
    mode: "live-demos",
    filePath: evmSecretPath,
  });
  const evm = await deriveDacsEvmRoleIdentityV1({
    config: sellerConfig,
    role: "seller",
    evmPrivateKey: evmSecret,
  });
  if (evm.address.toLowerCase() !== configuredPayee.toLowerCase()) {
    throw new Error("configured seller payee does not match the seller EVM authority");
  }
  const rail = await resolveRail(
    RAIL_REGISTRY_INDEX_ADDRESS,
    configuredX402RailId(),
    createDacsDemosRailRegistryProviderV1({
      runtime: seller,
      stewardAuthority,
      stewardPublicKey,
    }),
  );
  if (seller.chainIdentity === undefined) {
    throw new Error("stable Demos chain identity is unavailable");
  }
  const chainIdentity = await seller.chainIdentity();
  const demosNetwork = "demos-network:sha256:" + sha256Hex(canonicalize({ chainIdentity }));
  const prepared = await prepareDacsListingSetupV1({
    draft: await publicJsonFile(draftPath),
    buyerAuthority,
    seller,
    sellerPublicEndpoint: sellerEndpoint,
    sellerPayee: evm.address,
    network: sellerConfig.rail.requestedNetwork as \`eip155:\${number}\`,
    demosNetwork,
    rail,
    maximumServiceAmount: buyerConfig.limits.maxServiceAmount.amount,
    actionMaximumSpendDem: sellerConfig.limits.maxDemosNetworkFeeDem,
    safetyMarginDem: sellerConfig.limits.maxDemosNetworkFeeDem,
    maximumSpendDem: exactMaximum(maximumSpendDem, sellerConfig.limits.maxSetupSpendDem),
    now: Date.now(),
  });
  return Object.freeze({ prepared, seller, rail });
}

export async function prepareGeneratedListingSetupV1(
  maximumSpendDem: string,
): Promise<Readonly<DacsPreparedListingSetupV1>> {
  return (await buildPrepared(maximumSpendDem, "read-only")).prepared;
}

export async function executeGeneratedListingSetupV1(input: Readonly<{
  expected: Readonly<DacsPreparedListingSetupV1>;
  maximumSpendDem: string;
  doctorReports: readonly Readonly<DacsLiveDoctorReportV1>[];
  confirmation: string;
  nonInteractive: boolean;
  confirm(summary: Readonly<{
    kind: "setup" | "purchase" | "funded-doctor";
    planHash: string;
    actionCount: number;
    network: string;
    maximumAssetSpend: string;
    maximumNetworkFee: string;
    paymentPossible: boolean;
  }>): Promise<boolean>;
}>): Promise<Readonly<DacsGuardedCommandResultV1>> {
  const context = await buildPrepared(input.maximumSpendDem, "perform");
  if (canonicalize(context.prepared.plan) !== canonicalize(input.expected.plan) ||
      canonicalize(context.prepared.listing) !== canonicalize(input.expected.listing)) {
    throw new Error("setup plan changed after doctor");
  }
  const database = await openDacsNodeSqliteDatabase({
    databasePath: actorDatabasePath("seller"),
    mode: "live-demos",
    profile: DACS_NODE_LIVE_PROFILE,
    role: "seller",
    authority: context.seller.authority,
  });
  try {
    const discovery = await openDacsListingDiscoveryStoreV1({
      directory: listingDiscoveryDirectory(),
      sellerAuthority: context.seller.authority,
      sellerPublicEndpoint: loadRoleConfig("seller").publicBaseUrl!,
    });
    return await runDacsGuardedCommandV1({
      plan: context.prepared.plan,
      execute: true,
      database,
      workerId: "seller-setup-" + String(process.pid),
      doctorReports: input.doctorReports,
      confirmation: input.confirmation,
      nonInteractive: input.nonInteractive,
      confirm: input.confirm,
      executor: createDacsListingSetupExecutorV1({
        prepared: context.prepared,
        seller: context.seller,
        rail: context.rail,
        discovery,
      }),
    });
  } finally {
    database.close();
  }
}
`;

const PURCHASE_SOURCE = `import { constants } from "node:fs";
import { open } from "node:fs/promises";

import {
  RAIL_REGISTRY_INDEX_ADDRESS,
  resolveRail,
} from "@kynesyslabs/dacs";
import { canonicalize } from "@kynesyslabs/dacs/canonical";
import { canonicalDemosAgentPublicKey } from "@kynesyslabs/dacs/identity";
import {
  DACS_NODE_LIVE_PROFILE,
  createDacsDemosActorRuntimeV1,
  createDacsDemosRailRegistryProviderV1,
  createDacsPurchaseQueueExecutorV1,
  deriveDacsEvmRoleIdentityV1,
  loadDacsSecretV1,
  prepareDacsX402PurchaseV1,
  readDacsPublicJsonV1,
  resolveDacsX402ExistingListingV1,
  runDacsGuardedCommandV1,
  type DacsGuardedCommandResultV1,
  type DacsLiveDoctorReportV1,
  type DacsPreparedX402PurchaseV1,
} from "@kynesyslabs/dacs-node";
import { openDacsNodeSqliteDatabase } from "@kynesyslabs/dacs-node/sqlite";

import {
  actorDatabasePath,
  actorSecretPath,
  configuredAuthority,
  configuredRailStewardAuthority,
  configuredSellerEvmPayee,
  configuredX402RailId,
  loadRoleConfig,
} from "./config.js";

export const GENERATED_PURCHASE_REQUEST_SCHEMA =
  "dacs-generated-purchase-request/v1" as const;

export interface GeneratedPurchasePreparationInputV1 {
  jobId: string;
  resume: boolean;
  listingRef: string;
  request: Readonly<Record<string, unknown>>;
  maximumServiceAmount: string;
  maximumNetworkFeeEth: string;
}

function plainData(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return (prototype === Object.prototype || prototype === null) &&
      Reflect.ownKeys(value).every((key) => {
        if (typeof key !== "string") return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
      });
  } catch {
    return false;
  }
}

export async function readGeneratedPurchaseRequestV1(
  path: string,
): Promise<Readonly<Record<string, unknown>>> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const observed = await file.stat();
    if (!observed.isFile() || observed.size <= 0 || observed.size > 1_048_576) {
      throw new Error("purchase request file is unsafe");
    }
    const bytes = await file.readFile();
    try {
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!plainData(parsed) || Reflect.ownKeys(parsed).length !== 2 ||
          parsed.schema !== GENERATED_PURCHASE_REQUEST_SCHEMA ||
          !Object.hasOwn(parsed, "input")) {
        throw new Error("purchase request schema is invalid");
      }
      return Object.freeze(JSON.parse(canonicalize(parsed)) as Record<string, unknown>);
    } finally {
      bytes.fill(0);
    }
  } finally {
    await file.close();
  }
}

async function buildPrepared(
  input: Readonly<GeneratedPurchasePreparationInputV1>,
): Promise<Readonly<DacsPreparedX402PurchaseV1>> {
  const buyerConfig = loadRoleConfig("buyer");
  const sellerConfig = loadRoleConfig("seller");
  const buyerAuthority = configuredAuthority("buyer");
  const sellerAuthority = configuredAuthority("seller");
  const buyerDemosSecretPath = actorSecretPath("buyer", "demos-identity");
  const buyerEvmSecretPath = actorSecretPath("buyer", "evm-wallet");
  const stewardAuthority = configuredRailStewardAuthority();
  const stewardPublicKey = stewardAuthority === undefined
    ? null : canonicalDemosAgentPublicKey(stewardAuthority);
  const sellerPublicKey = sellerAuthority === undefined
    ? null : canonicalDemosAgentPublicKey(sellerAuthority);
  const sellerPayee = configuredSellerEvmPayee();
  const sellerEndpoint = sellerConfig.publicBaseUrl;
  if (buyerAuthority === undefined || sellerAuthority === undefined ||
      buyerDemosSecretPath === undefined || buyerEvmSecretPath === undefined ||
      stewardAuthority === undefined || stewardPublicKey === null || sellerPublicKey === null ||
      sellerPayee === undefined || !/^0x[0-9A-Fa-f]{40}$/.test(sellerPayee) ||
      sellerEndpoint === undefined) {
    throw new Error("purchase prerequisite is unavailable");
  }
  const demosSecret = await loadDacsSecretV1({
    name: "buyer-purchase-demos-identity",
    mode: "live-demos",
    filePath: buyerDemosSecretPath,
  });
  const buyer = await createDacsDemosActorRuntimeV1({
    config: buyerConfig,
    role: "buyer",
    authority: buyerAuthority,
    demosIdentity: demosSecret,
    writePolicy: "read-only",
  });
  const evmSecret = await loadDacsSecretV1({
    name: "buyer-purchase-evm-wallet",
    mode: "live-demos",
    filePath: buyerEvmSecretPath,
  });
  const payer = await deriveDacsEvmRoleIdentityV1({
    config: buyerConfig,
    role: "buyer",
    evmPrivateKey: evmSecret,
  });
  const rail = await resolveRail(
    RAIL_REGISTRY_INDEX_ADDRESS,
    configuredX402RailId(),
    createDacsDemosRailRegistryProviderV1({
      runtime: buyer,
      stewardAuthority,
      stewardPublicKey,
    }),
  );
  const resolved = await resolveDacsX402ExistingListingV1({
    listingRef: input.listingRef,
    sellerAuthority,
    sellerPublicKey,
    sellerPublicEndpoint: sellerEndpoint,
    sellerPayee,
    network: buyerConfig.rail.requestedNetwork as \`eip155:\${number}\`,
    rail,
    maximumServiceAmount: input.maximumServiceAmount,
    now: Date.now(),
    readAnchor: (locator) => buyer.adapter.readAnchor(locator),
    async authenticateAnchor(anchor) {
      const receipt = await buyer.adapter.resolveDemosAnchorReceipt(anchor);
      return receipt !== null &&
        await buyer.adapter.verifyDemosAnchorReceipt(receipt) === true;
    },
    readJson: (url) => readDacsPublicJsonV1(url, {
      timeoutMs: 5_000,
      maxBytes: 1_048_576,
    }),
  });
  if (resolved.status !== "verified") {
    throw new Error("purchase Listing admission failed: " + resolved.reasonCode);
  }
  return prepareDacsX402PurchaseV1({
    admission: resolved.admission,
    jobId: input.jobId,
    resume: input.resume,
    buyerAuthority,
    payer: payer.address,
    request: input.request,
    maximumServiceAmount: input.maximumServiceAmount,
    maximumNetworkFeeEth: input.maximumNetworkFeeEth,
  });
}

export async function prepareGeneratedPurchaseV1(
  input: Readonly<GeneratedPurchasePreparationInputV1>,
): Promise<Readonly<DacsPreparedX402PurchaseV1>> {
  return buildPrepared(input);
}

export async function executeGeneratedPurchaseV1(input: Readonly<{
  expected: Readonly<DacsPreparedX402PurchaseV1>;
  preparation: Readonly<GeneratedPurchasePreparationInputV1>;
  doctorReport: Readonly<DacsLiveDoctorReportV1>;
  confirmation: string;
  nonInteractive: boolean;
  confirm(summary: Readonly<{
    kind: "setup" | "purchase" | "funded-doctor";
    planHash: string;
    actionCount: number;
    network: string;
    maximumAssetSpend: string;
    maximumNetworkFee: string;
    paymentPossible: boolean;
  }>): Promise<boolean>;
}>): Promise<Readonly<DacsGuardedCommandResultV1>> {
  const prepared = await buildPrepared(input.preparation);
  if (canonicalize(prepared) !== canonicalize(input.expected)) {
    throw new Error("purchase plan changed after doctor");
  }
  const database = await openDacsNodeSqliteDatabase({
    databasePath: actorDatabasePath("buyer"),
    mode: "live-demos",
    profile: DACS_NODE_LIVE_PROFILE,
    role: "buyer",
    authority: prepared.plan.buyerAuthority,
  });
  try {
    return await runDacsGuardedCommandV1({
      plan: prepared.plan,
      execute: true,
      database,
      workerId: "buyer-purchase-" + String(process.pid),
      doctorReports: [input.doctorReport],
      confirmation: input.confirmation,
      nonInteractive: input.nonInteractive,
      confirm: input.confirm,
      executor: createDacsPurchaseQueueExecutorV1({
        prepared,
        database,
        workerId: "buyer-purchase-queue-" + String(process.pid),
      }),
    });
  } finally {
    database.close();
  }
}
`;

const FUNDED_DOCTOR_SOURCE = `import { lstat, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { sameCanonicalClaimIdentity } from "@kynesyslabs/dacs/identity";
import { canonicalize } from "@kynesyslabs/dacs/canonical";
import {
  DACS_NODE_LIVE_PROFILE,
  createDacsDemosActorRuntimeV1,
  createDacsFundedDoctorExecutorV1,
  loadDacsSecretV1,
  prepareDacsFundedDoctorV1,
  runDacsGuardedCommandV1,
  type DacsGuardedCommandResultV1,
  type DacsLiveDoctorReportV1,
  type DacsPreparedFundedDoctorV1,
} from "@kynesyslabs/dacs-node";
import { openDacsNodeSqliteDatabase } from "@kynesyslabs/dacs-node/sqlite";

import {
  configuredAuthority,
  configuredFundedDoctorAuthority,
  configuredFundedDoctorSecretPath,
  fundedDoctorDataDirectory,
  loadRoleConfig,
} from "./config.js";

export interface GeneratedFundedDoctorInputV1 {
  runId: string;
  disposableWallet: string;
  maximumTotalDebitDem: string;
}

async function privateDataDirectory(walletName: string): Promise<string> {
  const directory = fundedDoctorDataDirectory(walletName);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const observed = await lstat(directory);
  if (!observed.isDirectory() || observed.isSymbolicLink() ||
      process.platform !== "win32" && (observed.mode & 0o077) !== 0 ||
      typeof process.getuid === "function" && observed.uid !== process.getuid()) {
    throw new Error("funded doctor data directory is unsafe");
  }
  return directory;
}

function disposableConfiguration() {
  const authority = configuredFundedDoctorAuthority();
  const secretPath = configuredFundedDoctorSecretPath();
  if (authority === undefined || !/^did:demos:agent:[0-9a-f]{64}$/.test(authority) ||
      secretPath === undefined) {
    throw new Error("funded doctor disposable wallet is not configured");
  }
  for (const role of ["buyer", "seller"] as const) {
    const roleAuthority = configuredAuthority(role);
    if (roleAuthority !== undefined && sameCanonicalClaimIdentity(authority, roleAuthority)) {
      throw new Error("funded doctor wallet must be distinct from role wallets");
    }
  }
  return Object.freeze({ authority, secretPath });
}

async function openDisposableRuntime(input: Readonly<GeneratedFundedDoctorInputV1>) {
  const configured = disposableConfiguration();
  const dataDirectory = await privateDataDirectory(input.disposableWallet);
  const base = loadRoleConfig("buyer");
  const secret = await loadDacsSecretV1({
    name: "funded-doctor-demos-identity",
    mode: "live-demos",
    filePath: configured.secretPath,
  });
  const runtime = await createDacsDemosActorRuntimeV1({
    config: { ...base, role: "buyer", dataDirectory },
    role: "buyer",
    authority: configured.authority,
    demosIdentity: secret,
    writePolicy: "perform",
  });
  return Object.freeze({ authority: configured.authority, dataDirectory, runtime });
}

export async function prepareGeneratedFundedDoctorV1(
  input: Readonly<GeneratedFundedDoctorInputV1>,
): Promise<Readonly<DacsPreparedFundedDoctorV1>> {
  const disposable = disposableConfiguration();
  const secret = await loadDacsSecretV1({
    name: "funded-doctor-demos-identity",
    mode: "live-demos",
    filePath: disposable.secretPath,
  });
  secret.destroy();
  return prepareDacsFundedDoctorV1({
    runId: input.runId,
    disposableWallet: input.disposableWallet,
    walletAuthority: disposable.authority,
    network: "demos:testnet",
    actionMaximumDebitDem: loadRoleConfig("buyer").limits.maxDemosNetworkFeeDem,
    maximumTotalDebitDem: input.maximumTotalDebitDem,
  });
}

export async function executeGeneratedFundedDoctorV1(input: Readonly<{
  expected: Readonly<DacsPreparedFundedDoctorV1>;
  preparation: Readonly<GeneratedFundedDoctorInputV1>;
  doctorReport: Readonly<DacsLiveDoctorReportV1>;
  confirmation: string;
  nonInteractive: boolean;
  confirm(summary: Readonly<{
    kind: "setup" | "purchase" | "funded-doctor";
    planHash: string;
    actionCount: number;
    network: string;
    maximumAssetSpend: string;
    maximumNetworkFee: string;
    paymentPossible: boolean;
  }>): Promise<boolean>;
}>): Promise<Readonly<DacsGuardedCommandResultV1>> {
  const disposable = await openDisposableRuntime(input.preparation);
  const prepared = prepareDacsFundedDoctorV1({
    runId: input.preparation.runId,
    disposableWallet: input.preparation.disposableWallet,
    walletAuthority: disposable.authority,
    network: "demos:testnet",
    actionMaximumDebitDem: loadRoleConfig("buyer").limits.maxDemosNetworkFeeDem,
    maximumTotalDebitDem: input.preparation.maximumTotalDebitDem,
  });
  if (canonicalize(prepared) !== canonicalize(input.expected)) {
    throw new Error("funded doctor plan changed after preflight");
  }
  const database = await openDacsNodeSqliteDatabase({
    databasePath: resolve(disposable.dataDirectory, "doctor.sqlite"),
    mode: "live-demos",
    profile: DACS_NODE_LIVE_PROFILE,
    role: "buyer",
    authority: disposable.authority,
  });
  try {
    return await runDacsGuardedCommandV1({
      plan: prepared.plan,
      execute: true,
      database,
      workerId: "funded-doctor-" + String(process.pid),
      doctorReports: [input.doctorReport],
      confirmation: input.confirmation,
      nonInteractive: input.nonInteractive,
      confirm: input.confirm,
      executor: createDacsFundedDoctorExecutorV1({
        prepared,
        runtime: disposable.runtime,
      }),
    });
  } finally {
    database.close();
  }
}
`;

const LOCAL_LIFECYCLE_SOURCE = `import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { loadRoleConfig, serviceEndpoint } from "./config.js";

type Role = "buyer" | "seller";
const ROLES = ["buyer", "seller"] as const;
const RUNTIME_DIRECTORY = resolve(process.cwd(), ".dacs-runtime");

interface LocalProcessRecord {
  recordVersion: "1";
  role: Role;
  pid: number;
  token: string;
  projectDirectory: string;
  startedAt: number;
}

function recordPath(role: Role): string {
  return resolve(RUNTIME_DIRECTORY, role + ".pid.json");
}

async function safeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const observed = await lstat(path);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!observed.isDirectory() || observed.isSymbolicLink() ||
      (process.platform !== "win32" && (observed.mode & 0o077) !== 0) ||
      (uid !== undefined && observed.uid !== uid)) {
    throw new Error("local-runtime-directory-unsafe");
  }
}

async function atomicRecord(path: string, record: LocalProcessRecord): Promise<void> {
  const temporary = path + "." + process.pid + "." + randomUUID() + ".tmp";
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(record) + "\\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

function captureRecord(value: unknown, role: Role): LocalProcessRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("local-runtime-record-invalid");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !==
      "pid,projectDirectory,recordVersion,role,startedAt,token" ||
      record.recordVersion !== "1" || record.role !== role ||
      !Number.isSafeInteger(record.pid) || Number(record.pid) <= 0 ||
      typeof record.token !== "string" ||
      !/^[0-9a-f]{64}$/.test(record.token) ||
      record.projectDirectory !== process.cwd() ||
      !Number.isSafeInteger(record.startedAt) || Number(record.startedAt) <= 0) {
    throw new Error("local-runtime-record-invalid");
  }
  return record as unknown as LocalProcessRecord;
}

async function readRecord(role: Role): Promise<LocalProcessRecord | undefined> {
  let observed;
  try {
    observed = await lstat(recordPath(role));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!observed.isFile() || observed.isSymbolicLink() || observed.size > 4_096 ||
      (process.platform !== "win32" && (observed.mode & 0o777) !== 0o600) ||
      (uid !== undefined && observed.uid !== uid)) {
    throw new Error("local-runtime-record-unsafe");
  }
  return captureRecord(JSON.parse(await readFile(recordPath(role), "utf8")), role);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function ownedCommand(record: LocalProcessRecord): boolean {
  if (!alive(record.pid)) return false;
  if (process.platform === "win32") return true;
  const inspected = spawnSync("ps", ["-p", String(record.pid), "-o", "command="], {
    encoding: "utf8",
    shell: false,
  });
  return inspected.status === 0 &&
    inspected.stdout.includes("dist/src/service.js") &&
    inspected.stdout.includes(process.execPath);
}

async function safeLog(role: Role) {
  const directory = loadRoleConfig(role).dataDirectory;
  await safeDirectory(directory);
  const path = resolve(directory, "service.log");
  try {
    const observed = await lstat(path);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!observed.isFile() || observed.isSymbolicLink() ||
        (process.platform !== "win32" && (observed.mode & 0o777) !== 0o600) ||
        (uid !== undefined && observed.uid !== uid)) {
      throw new Error("local-runtime-log-unsafe");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return open(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY, 0o600);
}

async function endpointAvailable(role: Role, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const endpoint = new URL("/health", serviceEndpoint(role));
  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return true;
    } catch {
      // The child may still be loading its authenticated rail/runtime graph.
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  return false;
}

async function stopRecord(record: LocalProcessRecord): Promise<"stopped" | "stale"> {
  if (!alive(record.pid)) {
    await rm(recordPath(record.role), { force: true });
    return "stale";
  }
  if (!ownedCommand(record)) throw new Error("local-runtime-process-identity-mismatch");
  process.kill(record.pid, "SIGTERM");
  const deadline = Date.now() + 15_000;
  while (alive(record.pid) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 100));
  }
  if (alive(record.pid)) throw new Error("local-runtime-process-stop-timeout");
  await rm(recordPath(record.role), { force: true });
  return "stopped";
}

export async function startDacsLocalRoleServices(): Promise<number> {
  await safeDirectory(RUNTIME_DIRECTORY);
  const existing = await Promise.all(ROLES.map((role) => readRecord(role)));
  if (existing.some((record) => record !== undefined && alive(record.pid))) {
    throw new Error("local-runtime-already-running");
  }
  for (const role of ROLES) await rm(recordPath(role), { force: true });
  const started: LocalProcessRecord[] = [];
  try {
    for (const role of ROLES) {
      const log = await safeLog(role);
      const token = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
      const child = spawn(process.execPath, ["--import", "tsx", "dist/src/service.js"], {
        cwd: process.cwd(),
        detached: true,
        env: { ...process.env, DACS_DEPLOYMENT: "local", DACS_ROLE: role,
          DACS_LOCAL_INSTANCE_TOKEN: token },
        stdio: ["ignore", log.fd, log.fd],
        shell: false,
      });
      await new Promise<void>((resolveStarted, rejectStarted) => {
        child.once("error", rejectStarted);
        child.once("spawn", resolveStarted);
      });
      const record: LocalProcessRecord = {
        recordVersion: "1",
        role,
        pid: child.pid!,
        token,
        projectDirectory: process.cwd(),
        startedAt: Date.now(),
      };
      await atomicRecord(recordPath(role), record);
      await log.close();
      child.unref();
      started.push(record);
    }
    const available = await Promise.all(ROLES.map((role) => endpointAvailable(role)));
    if (available.some((value) => !value)) throw new Error("local-runtime-start-timeout");
    process.stdout.write(JSON.stringify({
      status: "started",
      deployment: "local",
      roles: started.map(({ role, pid }) => ({ role, pid })),
      readiness: "post-start-doctor-required",
    }) + "\\n");
    return 0;
  } catch (error) {
    for (const record of started.reverse()) {
      try { await stopRecord(record); } catch { /* Preserve the original failure. */ }
    }
    throw error;
  }
}

export async function stopDacsLocalRoleServices(): Promise<number> {
  await safeDirectory(RUNTIME_DIRECTORY);
  const results = [];
  for (const role of [...ROLES].reverse()) {
    const record = await readRecord(role);
    results.push({ role, status: record === undefined ? "not-running" : await stopRecord(record) });
  }
  process.stdout.write(JSON.stringify({ status: "stopped", deployment: "local", results }) + "\\n");
  return 0;
}
`;

const UPGRADE_SOURCE = `import { VERSION } from "@kynesyslabs/dacs";
import { FIXED_PRICE_X402_STANDARD_REVISION } from "@kynesyslabs/dacs/commerce";
import {
  DACS_NODE_CONFIG_SCHEMA_VERSION,
  DACS_NODE_RELEASE_METADATA_V1,
  readDacsPublicJsonV1,
} from "@kynesyslabs/dacs-node";
import {
  DACS_NODE_SQLITE_SCHEMA_VERSION,
  inspectDacsNodeSqliteUpgradeSafetyV1,
  type DacsNodeSqliteUpgradeInspectionV1,
} from "@kynesyslabs/dacs-node/sqlite";

import {
  actorDatabasePath,
  configuredAuthority,
} from "./config.js";
import { DACS_NODE_LIVE_PROFILE } from "@kynesyslabs/dacs-node";

const RELEASE_PACKAGES = Object.freeze([
  "@kynesyslabs/dacs",
  "@kynesyslabs/dacs-node",
  "create-dacs-agent",
] as const);
const GENERATED_BY_VERSION = "${SDK_VERSION}";
const DEFAULT_RELEASE_TAG = "next";

interface ReleaseMetadataV1 {
  releaseMetadataVersion: 1;
  standardRevision: string;
  configSchemaVersion: number;
  sqliteSchemaVersion: number;
  supportedSqliteMigrationFrom: readonly number[];
  breakingConfigurationChanges: readonly string[];
}

interface RegistryReleaseV1 {
  name: typeof RELEASE_PACKAGES[number];
  version: string;
  metadata: Readonly<ReleaseMetadataV1>;
}

interface ParsedSemverV1 {
  core: readonly [bigint, bigint, bigint];
  prerelease: readonly string[] | null;
}

export interface GeneratedUpgradeCheckDependenciesV1 {
  readRegistryManifest(packageName: typeof RELEASE_PACKAGES[number], tag: string): Promise<unknown>;
  inspectActor(role: "buyer" | "seller"): Promise<Readonly<DacsNodeSqliteUpgradeInspectionV1>>;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;

function parseSemver(value: string): Readonly<ParsedSemverV1> | undefined {
  const match = /^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$/u
    .exec(value);
  if (!match) return undefined;
  const prerelease = match[4]?.split(".") ?? null;
  if (prerelease?.some((item) => /^\\d+$/u.test(item) && item.length > 1 &&
      item.startsWith("0"))) return undefined;
  return Object.freeze({
    core: Object.freeze([BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)]) as
      readonly [bigint, bigint, bigint],
    prerelease: prerelease === null ? null : Object.freeze(prerelease),
  });
}

function compareSemver(left: string, right: string): -1 | 0 | 1 {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) throw new Error("installed release version is invalid");
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index]! < b.core[index]!) return -1;
    if (a.core[index]! > b.core[index]!) return 1;
  }
  if (a.prerelease === null && b.prerelease === null) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  const width = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < width; index += 1) {
    const leftItem = a.prerelease[index];
    const rightItem = b.prerelease[index];
    if (leftItem === undefined) return -1;
    if (rightItem === undefined) return 1;
    if (leftItem === rightItem) continue;
    const leftNumeric = /^\\d+$/u.test(leftItem);
    const rightNumeric = /^\\d+$/u.test(rightItem);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftItem) < BigInt(rightItem) ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftItem < rightItem ? -1 : 1;
  }
  return 0;
}

function parseReleaseMetadata(value: unknown): Readonly<ReleaseMetadataV1> | undefined {
  const candidate = object(value);
  if (!candidate || candidate.releaseMetadataVersion !== 1 ||
      typeof candidate.standardRevision !== "string" ||
      !/^[0-9a-f]{40}$/u.test(candidate.standardRevision) ||
      !Number.isSafeInteger(candidate.configSchemaVersion) ||
      (candidate.configSchemaVersion as number) < 1 ||
      !Number.isSafeInteger(candidate.sqliteSchemaVersion) ||
      (candidate.sqliteSchemaVersion as number) < 1 ||
      !Array.isArray(candidate.supportedSqliteMigrationFrom) ||
      candidate.supportedSqliteMigrationFrom.length === 0 ||
      candidate.supportedSqliteMigrationFrom.length > 64 ||
      candidate.supportedSqliteMigrationFrom.some((item) =>
        !Number.isSafeInteger(item) || (item as number) < 1) ||
      !Array.isArray(candidate.breakingConfigurationChanges) ||
      candidate.breakingConfigurationChanges.length > 64 ||
      candidate.breakingConfigurationChanges.some((item) =>
        typeof item !== "string" || item.length === 0 || item.length > 256)) {
    return undefined;
  }
  const migrationSources = candidate.supportedSqliteMigrationFrom as number[];
  if (migrationSources.some((item, index) =>
    index > 0 && item <= migrationSources[index - 1]!)) return undefined;
  return Object.freeze({
    releaseMetadataVersion: 1,
    standardRevision: candidate.standardRevision,
    configSchemaVersion: candidate.configSchemaVersion as number,
    sqliteSchemaVersion: candidate.sqliteSchemaVersion as number,
    supportedSqliteMigrationFrom: Object.freeze([...migrationSources]),
    breakingConfigurationChanges: Object.freeze([
      ...(candidate.breakingConfigurationChanges as string[]),
    ]),
  });
}

export function parseGeneratedRegistryReleaseV1(
  packageName: typeof RELEASE_PACKAGES[number],
  value: unknown,
): Readonly<RegistryReleaseV1> | undefined {
  const candidate = object(value);
  const metadata = parseReleaseMetadata(candidate?.dacs);
  if (!candidate || candidate.name !== packageName ||
      typeof candidate.version !== "string" || candidate.version.length > 128 ||
      parseSemver(candidate.version) === undefined || !metadata) return undefined;
  return Object.freeze({ name: packageName, version: candidate.version, metadata });
}

const defaultDependencies: Readonly<GeneratedUpgradeCheckDependenciesV1> = Object.freeze({
  async readRegistryManifest(
    packageName: typeof RELEASE_PACKAGES[number],
    tag: string,
  ) {
    return readDacsPublicJsonV1(
      "https://registry.npmjs.org/" + encodeURIComponent(packageName) + "/" +
        encodeURIComponent(tag),
      { timeoutMs: 5_000, maxBytes: 1_048_576 },
    );
  },
  async inspectActor(role: "buyer" | "seller") {
    const authority = configuredAuthority(role);
    if (authority === undefined) return Object.freeze({
      status: "blocked" as const,
      reasonCode: "actor-authority-unconfigured",
      databasePath: actorDatabasePath(role),
    });
    return inspectDacsNodeSqliteUpgradeSafetyV1({
      databasePath: actorDatabasePath(role),
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role,
      authority,
    });
  },
});

export async function checkGeneratedUpgradeV1(
  dependencies: Readonly<GeneratedUpgradeCheckDependenciesV1> = defaultDependencies,
) {
  const releaseResults = await Promise.all(RELEASE_PACKAGES.map(async (packageName) => {
    try {
      const value = await dependencies.readRegistryManifest(packageName, DEFAULT_RELEASE_TAG);
      const parsed = parseGeneratedRegistryReleaseV1(packageName, value);
      return parsed === undefined
        ? Object.freeze({ packageName, status: "invalid" as const })
        : Object.freeze({ packageName, status: "available" as const, release: parsed });
    } catch {
      return Object.freeze({ packageName, status: "unavailable" as const });
    }
  }));
  const actorResults = await Promise.all((["buyer", "seller"] as const).map(async (role) => {
    try {
      return Object.freeze({ role, inspection: await dependencies.inspectActor(role) });
    } catch {
      return Object.freeze({ role, inspection: Object.freeze({
        status: "fail" as const,
        reasonCode: "actor-store-inspection-unavailable",
        databasePath: actorDatabasePath(role),
      }) });
    }
  }));

  const releases = releaseResults.flatMap((item) =>
    item.status === "available" ? [item.release] : []);
  const versionsMatch = releases.length === RELEASE_PACKAGES.length &&
    releases.every((release) => release.version === releases[0]!.version);
  const metadataMatch = versionsMatch && releases.every((release) =>
    JSON.stringify(release.metadata) === JSON.stringify(releases[0]!.metadata));
  const available = metadataMatch ? releases[0]! : undefined;
  const availableMetadata = available?.metadata;
  const storeReports = actorResults.map(({ role, inspection }) => {
    if (inspection.status === "pass") return Object.freeze({
      role,
      status: "authenticated" as const,
      schemaVersion: inspection.diagnostics.schemaVersion,
      safe: inspection.safety.safe,
      blockers: inspection.safety,
    });
    if (inspection.reasonCode === "database-missing") return Object.freeze({
      role,
      status: "absent" as const,
      schemaVersion: DACS_NODE_SQLITE_SCHEMA_VERSION,
      safe: true,
      reasonCode: inspection.reasonCode,
    });
    return Object.freeze({
      role,
      status: inspection.status,
      schemaVersion: null,
      safe: false,
      reasonCode: inspection.reasonCode,
    });
  });
  const storesSafe = storeReports.every((store) => store.safe);
  const migrationSupported = availableMetadata !== undefined && storeReports.every((store) =>
    store.schemaVersion !== null &&
    availableMetadata.supportedSqliteMigrationFrom.includes(store.schemaVersion) &&
    store.schemaVersion <= availableMetadata.sqliteSchemaVersion);
  const standardChanged = availableMetadata !== undefined &&
    availableMetadata.standardRevision !== FIXED_PRICE_X402_STANDARD_REVISION;
  const configChanged = availableMetadata !== undefined &&
    availableMetadata.configSchemaVersion !== DACS_NODE_CONFIG_SCHEMA_VERSION;
  const breakingConfigurationChanges = availableMetadata?.breakingConfigurationChanges ?? [];
  const metadataCompatible = availableMetadata !== undefined && migrationSupported &&
    !standardChanged && !configChanged && breakingConfigurationChanges.length === 0;
  const availableVersion = available?.version;
  const versionDirection = availableVersion === undefined
    ? null : compareSemver(availableVersion, VERSION);
  const upgradeAvailable = versionDirection === 1;
  const reasonCodes: string[] = [];
  if (releases.length !== RELEASE_PACKAGES.length) reasonCodes.push("registry-release-unavailable");
  else if (!versionsMatch) reasonCodes.push("release-package-versions-diverge");
  else if (!metadataMatch) reasonCodes.push("release-package-metadata-diverges");
  if (versionDirection === -1) reasonCodes.push("registry-release-older-than-installed");
  if (availableMetadata !== undefined && !migrationSupported) {
    reasonCodes.push("store-migration-unsupported");
  }
  if (standardChanged) reasonCodes.push("standard-revision-review-required");
  if (configChanged || breakingConfigurationChanges.length > 0) {
    reasonCodes.push("configuration-migration-required");
  }
  if (!storesSafe) reasonCodes.push("active-recovering-or-unavailable-store");

  const status = available === undefined ? "unavailable"
    : !metadataCompatible || !storesSafe || versionDirection === -1 ? "blocked"
      : upgradeAvailable ? "upgrade-available" : "current";
  return Object.freeze({
    schema: "dacs-generated-upgrade-check/v1",
    status,
    readOnly: true,
    releaseTag: DEFAULT_RELEASE_TAG,
    installed: Object.freeze({
      packages: Object.freeze({
        "@kynesyslabs/dacs": VERSION,
        "@kynesyslabs/dacs-node": VERSION,
        "create-dacs-agent": GENERATED_BY_VERSION,
      }),
      standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
      configSchemaVersion: DACS_NODE_CONFIG_SCHEMA_VERSION,
      sqliteSchemaVersion: DACS_NODE_SQLITE_SCHEMA_VERSION,
    }),
    available: available === undefined ? null : Object.freeze({
      version: available.version,
      packages: Object.freeze(Object.fromEntries(
        releases.map((release) => [release.name, release.version]),
      )),
      standardRevision: available.metadata.standardRevision,
      configSchemaVersion: available.metadata.configSchemaVersion,
      sqliteSchemaVersion: available.metadata.sqliteSchemaVersion,
    }),
    packageAvailability: Object.freeze(Object.fromEntries(releaseResults.map((item) => [
      item.packageName,
      item.status === "available" ? item.release.version : item.status,
    ]))),
    storeMigration: Object.freeze({
      supported: migrationSupported,
      targetSchemaVersion: availableMetadata?.sqliteSchemaVersion ?? null,
      supportedFrom: availableMetadata?.supportedSqliteMigrationFrom ?? [],
      actors: Object.freeze(storeReports),
    }),
    standardRevisionChange: Object.freeze({
      changed: standardChanged,
      from: FIXED_PRICE_X402_STANDARD_REVISION,
      to: availableMetadata?.standardRevision ?? null,
    }),
    configurationChange: Object.freeze({
      changed: configChanged || breakingConfigurationChanges.length > 0,
      fromSchemaVersion: DACS_NODE_CONFIG_SCHEMA_VERSION,
      toSchemaVersion: availableMetadata?.configSchemaVersion ?? null,
      breakingChanges: Object.freeze([...breakingConfigurationChanges]),
    }),
    sessions: Object.freeze({
      preventUpgrade: !storesSafe,
      actors: Object.freeze(storeReports.map((store) => Object.freeze({
        role: store.role,
        safe: store.safe,
        ...(store.status === "authenticated" ? { blockers: store.blockers } : {}),
      }))),
    }),
    application: Object.freeze({
      supported: false,
      reasonCode: "automatic-upgrade-not-supported",
    }),
    upgradePermitted: false,
    reasonCodes: Object.freeze(reasonCodes),
    rollback: Object.freeze({
      supportedOnlyFromRestorableBackup: true,
      instructions: Object.freeze([
        "Stop both role services before changing packages or store files.",
        "Record the exact installed package version and preserve each actor database backup.",
        "Restore buyer and seller backups independently while both services remain stopped.",
        "Reinstall all three DACS packages at the recorded exact version.",
        "Refuse rollback when that runtime does not support the restored store schema.",
        "Run pre-start doctor before restarting either role service.",
      ]),
    }),
  });
}
`;

const CLI_SOURCE = `import { spawn } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

import { VERSION } from "@kynesyslabs/dacs";
import { canonicalizeDecimal } from "@kynesyslabs/dacs/canonical";
import { FIXED_PRICE_X402_STANDARD_REVISION } from "@kynesyslabs/dacs/commerce";
import { generateCanonicalJobId, isCanonicalJobId } from "@kynesyslabs/dacs/negotiate";
import {
  DACS_NODE_LIVE_PROFILE,
  formatDacsLiveDoctorTextV1,
  readDacsRoleServiceStatusesV1,
  type DacsLiveDoctorReportV1,
} from "@kynesyslabs/dacs-node";
import { openDacsNodeSqliteDatabase } from "@kynesyslabs/dacs-node/sqlite";

import {
  actorDatabasePath,
  configuredAuthority,
  loadRoleConfig,
  serviceEndpoint,
} from "./config.js";
import { runGeneratedDoctor } from "./doctor.js";
import {
  executeGeneratedListingSetupV1,
  prepareGeneratedListingSetupV1,
} from "./setup.js";
import {
  executeGeneratedPurchaseV1,
  prepareGeneratedPurchaseV1,
  readGeneratedPurchaseRequestV1,
} from "./purchase.js";
import {
  executeGeneratedFundedDoctorV1,
  prepareGeneratedFundedDoctorV1,
} from "./funded-doctor.js";
import {
  startDacsLocalRoleServices,
  stopDacsLocalRoleServices,
} from "./local-lifecycle.js";
import { checkGeneratedUpgradeV1 } from "./upgrade.js";

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

async function serviceStatus(): Promise<number> {
  const report = await readDacsRoleServiceStatusesV1({
    targets: [
      { role: "buyer", endpoint: serviceEndpoint("buyer") },
      { role: "seller", endpoint: serviceEndpoint("seller") },
    ],
    sdkVersion: VERSION,
    standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
    profile: DACS_NODE_LIVE_PROFILE,
  });
  process.stdout.write(JSON.stringify(report) + "\\n");
  return report.status === "available" ? 0 : 5;
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

async function purchaseArguments(args: readonly string[]) {
  const config = loadRoleConfig("buyer");
  const values: Record<string, string> = {};
  let nonInteractive = false;
  const valued = new Set([
    "--listing-ref", "--request-file", "--max-service-amount",
    "--max-network-fee-eth", "--resume-job",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]!;
    if (name === "--non-interactive") {
      if (nonInteractive) throw new Error("purchase option is repeated");
      nonInteractive = true;
      continue;
    }
    if (!valued.has(name) || Object.hasOwn(values, name)) {
      throw new Error("unknown or repeated purchase option");
    }
    values[name] = valueAfter(args, index, name);
    index += 1;
  }
  for (const required of [
    "--listing-ref", "--request-file", "--max-service-amount", "--max-network-fee-eth",
  ]) {
    if (!Object.hasOwn(values, required)) throw new Error(required + " is required");
  }
  const listingRef = values["--listing-ref"]!;
  if (listingRef.length > 512 || listingRef.trim() !== listingRef || listingRef.length === 0) {
    throw new Error("listing reference is malformed");
  }
  const resumedJobId = values["--resume-job"];
  if (resumedJobId !== undefined && !isCanonicalJobId(resumedJobId)) {
    throw new Error("resume job must be a canonical DACS job ID");
  }
  return Object.freeze({
    invocationMode: resumedJobId === undefined ? "new" as const : "resume" as const,
    jobId: resumedJobId ?? generateCanonicalJobId(),
    listingRef,
    request: await readGeneratedPurchaseRequestV1(values["--request-file"]!),
    maximumServiceAmount: decimalWithin(
      values["--max-service-amount"]!, config.limits.maxServiceAmount.amount),
    maximumNetworkFeeEth: decimalWithin(
      values["--max-network-fee-eth"]!, config.limits.maxEvmNetworkFeeEth),
    nonInteractive,
  });
}

async function confirmPurchase(planHash: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("interactive purchase requires a terminal; use --non-interactive explicitly");
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(
      "Enqueue the exact purchase plan " + planHash + "? Type yes to continue: ",
    );
    return answer === "yes";
  } finally {
    prompt.close();
  }
}

async function guardedPurchase(args: readonly string[]): Promise<number> {
  const parsed = await purchaseArguments(args);
  const report = await runGeneratedDoctor(
    "post-start",
    "buy",
    {
      listingRef: parsed.listingRef,
      maximumServiceAmount: parsed.maximumServiceAmount,
      maximumNetworkFeeEth: parsed.maximumNetworkFeeEth,
    },
  );
  printDoctor(report);
  if (report.exitCode !== 0) return report.exitCode;
  const preparation = Object.freeze({
    jobId: parsed.jobId,
    resume: parsed.invocationMode === "resume",
    listingRef: parsed.listingRef,
    request: parsed.request,
    maximumServiceAmount: parsed.maximumServiceAmount,
    maximumNetworkFeeEth: parsed.maximumNetworkFeeEth,
  });
  const prepared = await prepareGeneratedPurchaseV1(preparation);
  process.stdout.write(JSON.stringify({
    execute: false,
    invocationMode: parsed.invocationMode,
    ...prepared.plan,
  }) + "\\n");
  const confirmation = process.env.DACS_PURCHASE_CONFIRM;
  if (confirmation === undefined) return 0;
  if (confirmation !== "1") throw new Error("write confirmation is malformed");
  const result = await executeGeneratedPurchaseV1({
    expected: prepared,
    preparation,
    doctorReport: report,
    confirmation,
    nonInteractive: parsed.nonInteractive,
    confirm: ({ planHash }) => confirmPurchase(planHash),
  });
  process.stdout.write(JSON.stringify(result) + "\\n");
  return result.status === "completed" || result.status === "existing-completion" ? 0 : 5;
}

function setupArguments(args: readonly string[]): Readonly<{
  maximumSpendDem: string;
  nonInteractive: boolean;
}> {
  let maximumSpendDem: string | undefined;
  let nonInteractive = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--non-interactive") {
      if (nonInteractive) throw new Error("setup option is repeated");
      nonInteractive = true;
    } else if (argument === "--max-spend-dem") {
      if (maximumSpendDem !== undefined) throw new Error("setup option is repeated");
      maximumSpendDem = valueAfter(args, index, argument);
      index += 1;
    } else {
      throw new Error("unknown setup option: " + argument);
    }
  }
  if (maximumSpendDem === undefined) throw new Error("--max-spend-dem is required");
  return Object.freeze({ maximumSpendDem, nonInteractive });
}

async function confirmSetup(planHash: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("interactive setup requires a terminal; use --non-interactive explicitly");
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(
      "Execute the exact setup plan " + planHash + "? Type yes to continue: ",
    );
    return answer === "yes";
  } finally {
    prompt.close();
  }
}

async function guardedSetup(args: readonly string[]): Promise<number> {
  const parsed = setupArguments(args);
  const prepared = await prepareGeneratedListingSetupV1(parsed.maximumSpendDem);
  process.stdout.write(JSON.stringify({ execute: false, ...prepared.plan }) + "\\n");
  const confirmation = process.env.DACS_SETUP_WRITE_CONFIRM;
  if (confirmation === undefined) return 0;
  if (confirmation !== "1") throw new Error("write confirmation is malformed");
  const postStart = await runGeneratedDoctor("post-start", "start");
  printDoctor(postStart);
  if (postStart.exitCode !== 0) return postStart.exitCode;
  const preSetup = await runGeneratedDoctor("pre-start", "setup");
  printDoctor(preSetup);
  if (preSetup.exitCode !== 0) return preSetup.exitCode;
  if (!parsed.nonInteractive && !await confirmSetup(prepared.plan.planHash)) return 5;
  const result = await executeGeneratedListingSetupV1({
    expected: prepared,
    maximumSpendDem: parsed.maximumSpendDem,
    doctorReports: [postStart, preSetup],
    confirmation,
    nonInteractive: parsed.nonInteractive,
    confirm: async () => true,
  });
  process.stdout.write(JSON.stringify(result) + "\\n");
  return result.status === "completed" || result.status === "existing-completion" ? 0 : 5;
}

function fundedDoctorArguments(args: readonly string[]) {
  const values: Record<string, string> = {};
  let nonInteractive = false;
  const valued = new Set(["--wallet", "--max-cost-dem", "--resume-run"]);
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]!;
    if (name === "--non-interactive") {
      if (nonInteractive) throw new Error("funded doctor option is repeated");
      nonInteractive = true;
      continue;
    }
    if (!valued.has(name) || Object.hasOwn(values, name)) {
      throw new Error("unknown or repeated funded doctor option");
    }
    values[name] = valueAfter(args, index, name);
    index += 1;
  }
  for (const required of ["--wallet", "--max-cost-dem"]) {
    if (!Object.hasOwn(values, required)) throw new Error(required + " is required");
  }
  const disposableWallet = values["--wallet"]!;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(disposableWallet)) {
    throw new Error("funded doctor wallet name is invalid");
  }
  const resumedRunId = values["--resume-run"];
  if (resumedRunId !== undefined && !isCanonicalJobId(resumedRunId)) {
    throw new Error("funded doctor resume run must be a canonical DACS job ID");
  }
  return Object.freeze({
    invocationMode: resumedRunId === undefined ? "new" as const : "resume" as const,
    runId: resumedRunId ?? generateCanonicalJobId(),
    disposableWallet,
    maximumTotalDebitDem: decimalWithin(
      values["--max-cost-dem"]!, loadRoleConfig("buyer").limits.maxDemosNetworkFeeDem),
    nonInteractive,
  });
}

async function confirmFundedDoctor(planHash: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("interactive funded doctor requires a terminal; use --non-interactive explicitly");
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(
      "Execute the exact disposable-wallet smoke " + planHash + "? Type yes to continue: ",
    );
    return answer === "yes";
  } finally {
    prompt.close();
  }
}

async function guardedFundedDoctor(args: readonly string[]): Promise<number> {
  const parsed = fundedDoctorArguments(args);
  const preparation = Object.freeze({
    runId: parsed.runId,
    disposableWallet: parsed.disposableWallet,
    maximumTotalDebitDem: parsed.maximumTotalDebitDem,
  });
  const prepared = await prepareGeneratedFundedDoctorV1(preparation);
  process.stdout.write(JSON.stringify({
    execute: false,
    invocationMode: parsed.invocationMode,
    ...prepared.plan,
  }) + "\\n");
  const confirmation = process.env.DACS_DOCTOR_FUNDED_CONFIRM;
  if (confirmation === undefined) return 0;
  if (confirmation !== "1") throw new Error("funded doctor confirmation is malformed");
  const report = await runGeneratedDoctor("post-start", "start");
  printDoctor(report);
  if (report.exitCode !== 0) return report.exitCode;
  const result = await executeGeneratedFundedDoctorV1({
    expected: prepared,
    preparation,
    doctorReport: report,
    confirmation,
    nonInteractive: parsed.nonInteractive,
    confirm: ({ planHash }) => confirmFundedDoctor(planHash),
  });
  process.stdout.write(JSON.stringify(result) + "\\n");
  return result.status === "completed" || result.status === "existing-completion" ? 0 : 5;
}

async function main(args = process.argv.slice(2)): Promise<void> {
  const [operation = "doctor", ...rest] = args;
  if (operation === "doctor") process.exitCode = await doctor(rest);
  else if (operation === "up") {
    const gate = await startGate();
    if (gate !== 0) { process.exitCode = gate; return; }
    process.exitCode = (process.env.DACS_DEPLOYMENT ?? "docker") === "local"
      ? await startDacsLocalRoleServices()
      : await command("docker", ["compose", "up", "-d"]);
  } else if (operation === "down") {
    process.exitCode = (process.env.DACS_DEPLOYMENT ?? "docker") === "local"
      ? await stopDacsLocalRoleServices()
      : await command("docker", ["compose", "down"]);
  } else if (operation === "status") {
    process.exitCode = await serviceStatus();
  } else if (operation === "setup") process.exitCode = await guardedSetup(rest);
  else if (operation === "buy") process.exitCode = await guardedPurchase(rest);
  else if (operation === "doctor-funded") process.exitCode = await guardedFundedDoctor(rest);
  else if (operation === "upgrade") {
    if (rest.length !== 1 || rest[0] !== "--check") {
      throw new Error("only dacs:upgrade -- --check is supported");
    }
    const report = await checkGeneratedUpgradeV1();
    process.stdout.write(JSON.stringify(report) + "\\n");
    process.exitCode = report.status === "current" || report.status === "upgrade-available"
      ? 0 : 5;
  } else throw new Error("unknown dacs command: " + operation);
}

main().catch(() => {
  process.stderr.write("dacs command failed; rerun doctor for a sanitized diagnosis\\n");
  process.exitCode = 1;
});
`;

const SERVICE_SOURCE = `import {
  RAIL_REGISTRY_INDEX_ADDRESS,
  baseUnits,
  resolveRail,
} from "@kynesyslabs/dacs";
import { canonicalDemosAgentPublicKey } from "@kynesyslabs/dacs/identity";
import {
  createDacsDemosRailRegistryProviderV1,
  createDacsX402ExactRetainedReplayConfirmerV1,
  createDacsFixedPriceX402BuyerLiveV1,
  createDacsFixedPriceX402SellerLiveV1,
  createDacsListingDiscoveryRequestHandlerV1,
  createDacsLiveRoleRuntimeV1,
  installDacsRoleServiceProcessHooksV1,
  openDacsListingDiscoveryStoreV1,
  type DacsNodeEvent,
} from "@kynesyslabs/dacs-node";

import {
  actorSecretPath,
  configuredEvmRpcUrl,
  configuredAuthority,
  configuredFixedPriceAmount,
  configuredRailStewardAuthority,
  configuredSellerEvmPayee,
  configuredX402AuthorizationSearchFromBlock,
  configuredX402FacilitatorUrl,
  configuredX402RailId,
  configuredX402TokenDomain,
  listingDiscoveryDirectory,
  loadRoleConfig,
  serviceEndpoint,
} from "./config.js";
import { fulfil } from "./seller.js";

function loopbackHostname(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/\\.$/, "");
  return value === "localhost" || value.endsWith(".localhost") || value === "[::1]" ||
    value === "::1" || /^127(?:\\.\\d{1,3}){3}$/.test(value);
}

function eventSink(event: Readonly<DacsNodeEvent>): void {
  if (event.level === "debug" && event.code === "service-worker-cycle-complete") return;
  process.stderr.write(JSON.stringify({ event: "dacs.live-service.event", ...event }) + "\\n");
}

async function main(): Promise<void> {
  const role = process.env.DACS_ROLE;
  if (role !== "buyer" && role !== "seller") {
    throw new Error("live service requires an authority-separated buyer or seller role");
  }
  const peerRole = role === "buyer" ? "seller" : "buyer";
  const config = loadRoleConfig(role);
  const authority = configuredAuthority(role);
  const peerAuthority = configuredAuthority(peerRole);
  const demosIdentityFilePath = actorSecretPath(role, "demos-identity");
  const evmPrivateKeyFilePath = actorSecretPath(role, "evm-wallet");
  const evmRpcUrl = configuredEvmRpcUrl();
  const railStewardAuthority = configuredRailStewardAuthority();
  const railStewardPublicKey = railStewardAuthority === undefined
    ? null : canonicalDemosAgentPublicKey(railStewardAuthority);
  const authorizationSearchFromBlock = configuredX402AuthorizationSearchFromBlock();
  if (authority === undefined || peerAuthority === undefined ||
      demosIdentityFilePath === undefined || evmPrivateKeyFilePath === undefined ||
      evmRpcUrl === undefined || railStewardAuthority === undefined ||
      railStewardPublicKey === null || authorizationSearchFromBlock === undefined) {
    throw new Error("role, rail, Demos identity, EVM identity or RPC is unavailable");
  }
  const ownEndpoint = new URL(serviceEndpoint(role));
  const peerEndpoint = new URL("/dacs-transport/v1/messages", serviceEndpoint(peerRole));
  if (ownEndpoint.protocol !== "http:" || !loopbackHostname(ownEndpoint.hostname) ||
      peerEndpoint.protocol !== "http:" || !loopbackHostname(peerEndpoint.hostname) ||
      ownEndpoint.pathname !== "/" || ownEndpoint.search !== "" || ownEndpoint.hash !== "") {
    throw new Error("generated v1 role transport must remain on its loopback HTTP hop");
  }
  const port = Number(ownEndpoint.port);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("role service port is invalid");
  }
  const discovery = role === "seller" && config.publicBaseUrl !== undefined
    ? await openDacsListingDiscoveryStoreV1({
        directory: listingDiscoveryDirectory(),
        sellerAuthority: authority,
        sellerPublicEndpoint: config.publicBaseUrl,
      })
    : undefined;

  const runtime = await createDacsLiveRoleRuntimeV1({
    config,
    role,
    authority,
    peerAuthority,
    peerEndpoint: peerEndpoint.toString(),
    workerId: role + "-" + String(process.pid),
    demosIdentityFilePath,
    evmPrivateKeyFilePath,
    evmRpcUrl,
    // The authenticated registry supplies finalityBlocks below. Use the live
    // head here so that policy, rather than the host runtime's safe default,
    // determines the required confirmation depth.
    evmFinalityTag: "latest",
    createCommerceGraph: async (context) => {
      const rail = await resolveRail(
        RAIL_REGISTRY_INDEX_ADDRESS,
        configuredX402RailId(),
        createDacsDemosRailRegistryProviderV1({
          runtime: context.demos,
          stewardAuthority: railStewardAuthority,
          stewardPublicKey: railStewardPublicKey,
        }),
      );
      if (rail.asset.kind !== "erc20") {
        throw new Error("generated fixed-price graph requires an ERC-20 rail");
      }
      const finalityBlocks = rail.parameters.finalityBlocks;
      if (!Number.isSafeInteger(finalityBlocks) || Number(finalityBlocks) <= 0) {
        throw new Error("generated x402 rail requires positive finalityBlocks");
      }
      const common = {
        context,
        workerId: role + "-" + String(process.pid),
        rail,
        tokenDomain: configuredX402TokenDomain(),
        evmRpcUrl,
        authorizationSearchFromBlock,
        recipeRegistryVersion: 1,
        finalityTag: "latest" as const,
        retryDelayMs: 5_000,
      };
      if (role === "buyer") {
        const sellerPublicEndpoint = loadRoleConfig("seller").publicBaseUrl;
        if (sellerPublicEndpoint === undefined) {
          throw new Error("seller x402 endpoint configuration is unavailable");
        }
        return createDacsFixedPriceX402BuyerLiveV1({
          ...common,
          confirmUnused: createDacsX402ExactRetainedReplayConfirmerV1({
            publicBaseUrl: sellerPublicEndpoint,
          }),
          maxTimeoutSeconds: 120,
          minimumConfirmations: Number(finalityBlocks),
        });
      }
      const facilitatorUrl = configuredX402FacilitatorUrl();
      const sellerPayee = configuredSellerEvmPayee();
      const sellerPublicEndpoint = config.publicBaseUrl;
      if (facilitatorUrl === undefined || sellerPayee === undefined ||
          sellerPublicEndpoint === undefined) {
        throw new Error("seller x402 endpoint configuration is unavailable");
      }
      return createDacsFixedPriceX402SellerLiveV1({
        ...common,
        amount: baseUnits(configuredFixedPriceAmount(), rail.asset.decimals),
        facilitator: { url: facilitatorUrl },
        prepareDeliverable: fulfil,
        sellerPublicEndpoint,
        sellerPayee,
        maximumServiceAmount: config.limits.maxServiceAmount.amount,
        maxTimeoutSeconds: 120,
        observeHttpResult: (result) => {
          process.stderr.write(JSON.stringify({
            event: "dacs.live-service.x402-result",
            role: "seller",
            ...result,
          }) + "\\n");
        },
      });
    },
    ...(discovery === undefined ? {} : {
      handlePublicRequest: createDacsListingDiscoveryRequestHandlerV1(discovery),
    }),
    events: { emit: eventSink },
    server: { hostname: ownEndpoint.hostname, port },
  });
  const hooks = installDacsRoleServiceProcessHooksV1(runtime);
  try {
    await runtime.start();
    process.stdout.write(JSON.stringify({
      event: "dacs.live-service.started",
      role,
      endpoint: runtime.service.endpoint,
      readiness: "post-start-doctor-required",
    }) + "\\n");
    const result = await hooks.waitForShutdown();
    if (result.status === "failed") process.exitCode = 1;
  } finally {
    hooks.dispose();
    await runtime.stop();
  }
}

main().catch((error: unknown) => {
  const candidate = error !== null && typeof error === "object" &&
      "reasonCode" in error ? (error as { reasonCode?: unknown }).reasonCode : undefined;
  const reasonCode = typeof candidate === "string" &&
      /^[a-z][a-z0-9-]{0,127}$/.test(candidate)
    ? candidate : "role-runtime-unavailable";
  process.stderr.write(JSON.stringify({
    event: "dacs.live-service.failed",
    reasonCode,
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

const SELLER_SOURCE = `import type {
  DacsPublicStorageDeliverableInputV1,
} from "@kynesyslabs/dacs-node";

export async function fulfil(input: Readonly<DacsPublicStorageDeliverableInputV1>) {
  // Replace only this pure/idempotent callback with the seller's bounded work.
  // The host persists its JSON output and owns every irreversible publication.
  return Object.freeze({
    jobId: input.jobId,
    fulfilmentId: input.fulfilmentId,
    request: input.request,
    status: "completed" as const,
  });
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
import { checkGeneratedUpgradeV1 } from "../src/upgrade.js";

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

const releaseMetadata = Object.freeze({
  releaseMetadataVersion: 1 as const,
  standardRevision: "${STANDARD_REVISION}",
  configSchemaVersion: ${CONFIG_SCHEMA_VERSION},
  sqliteSchemaVersion: ${SQLITE_SCHEMA_VERSION},
  supportedSqliteMigrationFrom: Object.freeze([1, 2, 3, 4, 5, 6]),
  breakingConfigurationChanges: Object.freeze([]),
});

test("upgrade check proves compatible stores without writing", async () => {
  const report = await checkGeneratedUpgradeV1({
    readRegistryManifest: async (packageName) => Object.freeze({
      name: packageName,
      version: "0.1.0-alpha.1",
      dacs: releaseMetadata,
    }),
    inspectActor: async (role) => Object.freeze({
      status: "pass" as const,
      diagnostics: Object.freeze({
        databasePath: "/private/" + role + ".sqlite",
        schemaVersion: ${SQLITE_SCHEMA_VERSION},
        applicationId: 1145131859,
        mode: "live-demos" as const,
        profile: "dacs-sdk:fixed-price-x402:v1" as const,
        role,
        authority: "did:demos:agent:" + "0".repeat(64),
        sdkVersion: "${SDK_VERSION}",
        standardRevision: "${STANDARD_REVISION}",
        journalMode: "wal" as const,
        synchronous: "full" as const,
        quickCheck: "ok" as const,
        filesystemMagic: 1,
      }),
      safety: Object.freeze({
        safe: true,
        intentEffects: 0,
        activeEffects: 0,
        reconciliationEffects: 0,
        operatorActionEffects: 0,
        incompleteOrders: 0,
      }),
    }),
  });
  assert.equal(report.readOnly, true);
  assert.equal(report.status, "upgrade-available");
  assert.equal(report.upgradePermitted, false);
  assert.equal(report.sessions.preventUpgrade, false);
  assert.equal(report.storeMigration.supported, true);
});

test("upgrade check blocks an unfinished irreversible effect", async () => {
  const report = await checkGeneratedUpgradeV1({
    readRegistryManifest: async (packageName) => Object.freeze({
      name: packageName,
      version: "0.1.0-alpha.1",
      dacs: releaseMetadata,
    }),
    inspectActor: async (role) => Object.freeze({
      status: "pass" as const,
      diagnostics: Object.freeze({
        databasePath: "/private/" + role + ".sqlite",
        schemaVersion: ${SQLITE_SCHEMA_VERSION},
        applicationId: 1145131859,
        mode: "live-demos" as const,
        profile: "dacs-sdk:fixed-price-x402:v1" as const,
        role,
        authority: "did:demos:agent:" + "0".repeat(64),
        sdkVersion: "${SDK_VERSION}",
        standardRevision: "${STANDARD_REVISION}",
        journalMode: "wal" as const,
        synchronous: "full" as const,
        quickCheck: "ok" as const,
        filesystemMagic: 1,
      }),
      safety: Object.freeze({
        safe: role === "seller",
        intentEffects: role === "buyer" ? 1 : 0,
        activeEffects: 0,
        reconciliationEffects: 0,
        operatorActionEffects: 0,
        incompleteOrders: 0,
      }),
    }),
  });
  assert.equal(report.status, "blocked");
  assert.equal(report.upgradePermitted, false);
  assert.equal(report.sessions.preventUpgrade, true);
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
CMD ["node", "--import", "tsx", "dist/src/service.js"]
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
  DACS_RAIL_REGISTRY_INDEX_REF: \${DACS_RAIL_REGISTRY_INDEX_REF:-dacs4:registry:v0.1}
  DACS_RAIL_STEWARD_AUTHORITY: \${DACS_RAIL_STEWARD_AUTHORITY:-}
  DACS_X402_RAIL_ID: \${DACS_X402_RAIL_ID:-x402:default}
  DACS_X402_FACILITATOR_URL: \${DACS_X402_FACILITATOR_URL:-}
  DACS_EVM_RPC_URL: \${DACS_EVM_RPC_URL:-}
  DACS_X402_AUTHORIZATION_SEARCH_FROM_BLOCK: \${DACS_X402_AUTHORIZATION_SEARCH_FROM_BLOCK:-}
  DACS_X402_TOKEN_NAME: \${DACS_X402_TOKEN_NAME:-USDC}
  DACS_X402_TOKEN_VERSION: \${DACS_X402_TOKEN_VERSION:-2}
  DACS_X402_NETWORK: \${DACS_X402_NETWORK:-eip155:84532}
  DACS_MAX_SERVICE_ASSET: \${DACS_MAX_SERVICE_ASSET:-USDC}
  DACS_FIXED_PRICE_AMOUNT: \${DACS_FIXED_PRICE_AMOUNT:-1}
  DACS_MAX_SERVICE_AMOUNT: \${DACS_MAX_SERVICE_AMOUNT:-1}
  DACS_MAX_SETUP_SPEND_DEM: \${DACS_MAX_SETUP_SPEND_DEM:-10}
  DACS_MAX_DEMOS_NETWORK_FEE_DEM: \${DACS_MAX_DEMOS_NETWORK_FEE_DEM:-2}
  DACS_MAX_EVM_NETWORK_FEE_ETH: \${DACS_MAX_EVM_NETWORK_FEE_ETH:-0.001}
  DACS_BUYER_AUTHORITY: \${DACS_BUYER_AUTHORITY:-}
  DACS_SELLER_AUTHORITY: \${DACS_SELLER_AUTHORITY:-}
  DACS_SELLER_EVM_PAYEE: \${DACS_SELLER_EVM_PAYEE:-}
  DACS_BUYER_PUBLIC_BASE_URL: \${DACS_BUYER_PUBLIC_BASE_URL:-}
  DACS_SELLER_PUBLIC_BASE_URL: \${DACS_SELLER_PUBLIC_BASE_URL:-}

x-dacs-role: &dacs-role
  build: .
  user: "\${DACS_RUNTIME_UID:?set DACS_RUNTIME_UID}:\${DACS_RUNTIME_GID:?set DACS_RUNTIME_GID}"
  # V1 keeps the inter-role HTTP hop on the VPS loopback interface. Public
  # traffic terminates TLS at a separately managed local reverse proxy.
  network_mode: host
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
      DACS_LISTING_DRAFT_FILE: /run/dacs/listing-draft.json
      DACS_BUYER_SERVICE_URL: http://127.0.0.1:3101
      DACS_SELLER_SERVICE_URL: http://127.0.0.1:3102
    volumes:
      - \${DACS_BUYER_DATA_DIRECTORY:?set DACS_BUYER_DATA_DIRECTORY}:/var/lib/dacs
      - \${DACS_BUYER_DEMOS_SECRET_FILE:?set DACS_BUYER_DEMOS_SECRET_FILE}:/run/secrets/demos-identity:ro
      - \${DACS_BUYER_EVM_SECRET_FILE:?set DACS_BUYER_EVM_SECRET_FILE}:/run/secrets/evm-wallet:ro
      - \${DACS_LISTING_DRAFT_FILE:?set DACS_LISTING_DRAFT_FILE}:/run/dacs/listing-draft.json:ro
  seller:
    <<: *dacs-role
    environment:
      <<: *dacs-public-environment
      DACS_ROLE: seller
      DACS_DEPLOYMENT: docker
      DACS_SELLER_DATA_DIRECTORY: /var/lib/dacs
      DACS_SELLER_DEMOS_SECRET_FILE: /run/secrets/demos-identity
      DACS_SELLER_EVM_SECRET_FILE: /run/secrets/evm-wallet
      DACS_LISTING_DRAFT_FILE: /run/dacs/listing-draft.json
      DACS_BUYER_SERVICE_URL: http://127.0.0.1:3101
      DACS_SELLER_SERVICE_URL: http://127.0.0.1:3102
    volumes:
      - \${DACS_SELLER_DATA_DIRECTORY:?set DACS_SELLER_DATA_DIRECTORY}:/var/lib/dacs
      - \${DACS_SELLER_DEMOS_SECRET_FILE:?set DACS_SELLER_DEMOS_SECRET_FILE}:/run/secrets/demos-identity:ro
      - \${DACS_SELLER_EVM_SECRET_FILE:?set DACS_SELLER_EVM_SECRET_FILE}:/run/secrets/evm-wallet:ro
      - \${DACS_LISTING_DRAFT_FILE:?set DACS_LISTING_DRAFT_FILE}:/run/dacs/listing-draft.json:ro
`;

function envExample(options: LiveProjectTemplateOptions): string {
  return `# Public configuration only. Never put secret values in this file.
DACS_DEPLOYMENT=${options.deployment}
DACS_RUNTIME_UID=${options.runtimeUid}
DACS_RUNTIME_GID=${options.runtimeGid}
DACS_BUYER_DATA_DIRECTORY=./data/buyer
DACS_SELLER_DATA_DIRECTORY=./data/seller
DACS_DEMOS_RPC_URL=https://node2.demos.sh
DACS_RAIL_REGISTRY_INDEX_REF=dacs4:registry:v0.1
DACS_RAIL_STEWARD_AUTHORITY=
DACS_X402_RAIL_ID=x402:default
DACS_X402_FACILITATOR_URL=
DACS_EVM_RPC_URL=
DACS_X402_AUTHORIZATION_SEARCH_FROM_BLOCK=
DACS_X402_TOKEN_NAME=USDC
DACS_X402_TOKEN_VERSION=2
DACS_LISTING_DRAFT_FILE=./listing-draft.json
DACS_X402_NETWORK=eip155:84532
DACS_MAX_SERVICE_ASSET=USDC
DACS_FIXED_PRICE_AMOUNT=1
DACS_MAX_SERVICE_AMOUNT=1
DACS_MAX_SETUP_SPEND_DEM=10
DACS_MAX_DEMOS_NETWORK_FEE_DEM=2
DACS_MAX_EVM_NETWORK_FEE_ETH=0.001
DACS_BUYER_SERVICE_URL=http://127.0.0.1:3101
DACS_SELLER_SERVICE_URL=http://127.0.0.1:3102
DACS_BUYER_AUTHORITY=
DACS_SELLER_AUTHORITY=
DACS_SELLER_EVM_PAYEE=
DACS_BUYER_DEMOS_SECRET_FILE=
DACS_BUYER_EVM_SECRET_FILE=
DACS_SELLER_DEMOS_SECRET_FILE=
DACS_SELLER_EVM_SECRET_FILE=
DACS_FUNDED_DOCTOR_AUTHORITY=
DACS_FUNDED_DOCTOR_DEMOS_SECRET_FILE=
DACS_FUNDED_DOCTOR_DATA_ROOT=./data/funded-doctor
`;
}

const GITIGNORE = `.env
.env.*
!.env.example
node_modules/
dist/
data/
artifacts/
.dacs-runtime/
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
The optional funded doctor uses a fifth, named disposable Demos wallet through
\`DACS_FUNDED_DOCTOR_DEMOS_SECRET_FILE\`; it must not reuse either role wallet.
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
npm run dacs:doctor:funded -- --wallet disposable-alpha --max-cost-dem 2
npm run dacs:status
npm run dacs:upgrade -- --check
npm run dacs:down
\`\`\`

Doctor exit 5 means **blocked**, not failed: no credential, balance, signed rail,
Listing or reviewed adapter was guessed and no write occurred. Buyer and seller
services open the SDK's role-owned SQLite, Demos identity, authenticated HTTP and
readiness runtime when their prerequisites exist. Commerce remains blocked until
the exact Listing, signed rail authority and operation graph pass doctor. Never
bypass that gate.

Setup requires \`DACS_SETUP_WRITE_CONFIRM=1\`; purchase requires
\`DACS_PURCHASE_CONFIRM=1\`; funded doctor requires
\`DACS_DOCTOR_FUNDED_CONFIRM=1\`. These are intentionally absent from .env and
are non-interchangeable and are rejected if persisted there. Without its own
confirmation, setup or purchase prints a read-only preflight plan and exits.
Every executing command also requires explicit caps.

The purchase request file is closed, versioned JSON:

\`\`\`json
{"schema":"dacs-generated-purchase-request/v1","input":{"query":"bounded request"}}
\`\`\`

A fresh buy generates and prints a new canonical job ID. To reconcile or resume
that exact retained purchase, repeat the same inputs with
\`--resume-job <printed-job-id>\`; never omit it when recovering an earlier run.

Funded doctor is a separate, optional one-anchor Demos smoke using a named
disposable wallet. It is plan-only unless \`DACS_DOCTOR_FUNDED_CONFIRM=1\` is
supplied for that invocation, always requires \`--max-cost-dem\`, and never
authorizes setup or purchase. Reconcile an ambiguous exact run with
\`--resume-run <printed-run-id>\`; reconciliation is read-only and cannot
rebroadcast the smoke.

Upgrade check is read-only. It queries the public npm \`next\` manifests for all
three exact-version DACS packages, compares their declared Standard, config and
SQLite compatibility, authenticates each existing actor store, and blocks on
unfinished or recovering work. Package application is intentionally not
automatic in this release: stop both services and retain independent actor
backups before following the report's rollback instructions. An older runtime
must never open a store schema newer than it supports.

Deployment: **${options.deployment}**. Default local role: **${options.role}**.
Docker installs with lifecycle scripts disabled, then explicitly rebuilds only
the reviewed \`better-sqlite3\` native adapter. It uses separate non-root buyer/seller processes, secret mounts and durable
data bind mounts, read-only root filesystems, bounded resources and no database
port. On the clean Linux VPS it uses host networking solely to keep the
inter-role transport on \`127.0.0.1\`; public traffic requires a separately
managed HTTPS reverse proxy. \`dacs:down\` retains both data directories; use documented backup
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
    "src/setup.ts": SETUP_SOURCE,
    "src/purchase.ts": PURCHASE_SOURCE,
    "src/funded-doctor.ts": FUNDED_DOCTOR_SOURCE,
    "src/upgrade.ts": UPGRADE_SOURCE,
    "src/local-lifecycle.ts": LOCAL_LIFECYCLE_SOURCE,
    "src/cli.ts": CLI_SOURCE,
    "src/offline-smoke.ts": OFFLINE_SMOKE_SOURCE,
    "test/live-bootstrap.test.ts": TEST_SOURCE,
    "data/buyer/.gitkeep": "",
    "data/seller/.gitkeep": "",
    "secrets/README.md": SECRETS_README,
  });
}
