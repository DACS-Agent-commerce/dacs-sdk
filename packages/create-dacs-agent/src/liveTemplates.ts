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
      "@kynesyslabs/demosdk": "4.0.16",
      "@x402/core": "2.15.0",
      "@x402/evm": "2.15.0",
      "@x402/fetch": "2.15.0",
      "viem": "2.52.2",
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
  const name = process.env.DACS_X402_TOKEN_NAME ?? "USD Coin";
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
        return Object.freeze({ asset: mismatch, gas: mismatch });
      }
      const client = await createViemDacsX402BalanceReadClientV1({
        rpcUrl,
        chainId: actors.buyer.evmIdentity.chainId,
      });
      const [asset, gas] = await Promise.all([
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
      ]);
      return Object.freeze({ asset, gas });
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
      probeTimeoutMs: 5_000,
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
  const networkInfo = await seller.networkInfo();
  const demosNetwork = "demos-network:sha256:" + sha256Hex(canonicalize(networkInfo));
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
    process.exitCode = await serviceStatus();
  } else if (operation === "setup") process.exitCode = await guardedSetup(rest);
  else if (operation === "buy") process.exitCode = await guardedPurchase(rest);
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

const SERVICE_SOURCE = `import {
  RAIL_REGISTRY_INDEX_ADDRESS,
  baseUnits,
  resolveRail,
} from "@kynesyslabs/dacs";
import { canonicalDemosAgentPublicKey } from "@kynesyslabs/dacs/identity";
import {
  createDacsDemosRailRegistryProviderV1,
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
      const common = {
        context,
        workerId: role + "-" + String(process.pid),
        rail,
        tokenDomain: configuredX402TokenDomain(),
        evmRpcUrl,
        authorizationSearchFromBlock,
        recipeRegistryVersion: 1,
        finalityTag: "finalized" as const,
      };
      if (role === "buyer") {
        return createDacsFixedPriceX402BuyerLiveV1({
          ...common,
          maxTimeoutSeconds: 120,
          minimumConfirmations: 1,
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

main().catch(() => {
  process.stderr.write(JSON.stringify({
    event: "dacs.live-service.failed",
    reasonCode: "role-runtime-unavailable",
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
  DACS_RAIL_REGISTRY_INDEX_REF: \${DACS_RAIL_REGISTRY_INDEX_REF:-dacs4:registry:v0.1}
  DACS_RAIL_STEWARD_AUTHORITY: \${DACS_RAIL_STEWARD_AUTHORITY:-}
  DACS_X402_RAIL_ID: \${DACS_X402_RAIL_ID:-x402:default}
  DACS_X402_FACILITATOR_URL: \${DACS_X402_FACILITATOR_URL:-}
  DACS_EVM_RPC_URL: \${DACS_EVM_RPC_URL:-}
  DACS_X402_AUTHORIZATION_SEARCH_FROM_BLOCK: \${DACS_X402_AUTHORIZATION_SEARCH_FROM_BLOCK:-}
  DACS_X402_TOKEN_NAME: \${DACS_X402_TOKEN_NAME:-USD Coin}
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
DACS_DEPLOYMENT=docker
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
DACS_X402_TOKEN_NAME=USD Coin
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
    "src/cli.ts": CLI_SOURCE,
    "src/offline-smoke.ts": OFFLINE_SMOKE_SOURCE,
    "test/live-bootstrap.test.ts": TEST_SOURCE,
    "data/.gitkeep": "",
    "secrets/README.md": SECRETS_README,
  });
}
