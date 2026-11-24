import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import {
  TESTNET_AUTHORITY_ID,
  TESTNET_EPOCH,
  TESTNET_SEED_HEX,
  TESTNET_TOKEN,
  freePort,
  generatedProject,
  startChainStub,
  writeModeFile,
  type ChainStub,
} from "./helpers/testnetAuthorityFixtures.js";

type PolicyFileResult =
  | Readonly<{ status: "written"; path: string; policyHash: string }>
  | Readonly<{ status: "refused"; reasonCode: string }>;

interface DoctorCheck {
  id: string;
  status: string;
  reasonCode?: string;
  facts?: Readonly<Record<string, unknown>>;
}

interface GeneratedDoctorModule {
  writeGeneratedX402WalletSpendPolicyFileV1(): Promise<PolicyFileResult>;
  runGeneratedDoctor(
    phase: "post-start",
    scope: "buy",
    operation: Readonly<{ rail: "x402" }>,
  ): Promise<Readonly<{ checks: readonly DoctorCheck[] }>>;
}

interface WalletSpendPolicy {
  assets: readonly Readonly<{ maximumPerOrderDebit: string }>[];
}

interface GeneratedConfigModule {
  configuredX402WalletSpendPolicy(input: Readonly<{
    wallet: string;
    chainId: string;
    asset: string;
    decimals: number;
  }>): WalletSpendPolicy;
}

interface GeneratedLifecycleModule {
  createGeneratedBackupV1(input: Readonly<{ outputDirectory: string }>): Promise<Readonly<{
    roles: readonly Readonly<{ role: string; files: readonly Readonly<{ path: string }>[] }>[];
  }>>;
}

interface TestnetAuthority {
  policyHash: string;
  stop(): Promise<void>;
}

interface NodePackage {
  dacsWalletSpendPolicyHashV1(policy: WalletSpendPolicy): string;
  startDacsWalletSpendTestnetAuthorityV1(input: Readonly<{
    environment: Readonly<Record<string, string>>;
  }>): Promise<TestnetAuthority>;
}

interface Rail {
  railId: string;
  asset: Readonly<{ kind: string; chainId: number; contract: string; symbol: string; decimals: number }>;
}

interface RefusalCase {
  reasonCode: string;
  overrides?: Readonly<Record<string, string | undefined>>;
  doctor?: () => GeneratedDoctorModule;
  rail?: () => void;
  runtimeCalls: number;
}

// Package names held in variables, so the typecheck does not need the packages built.
const NODE_PACKAGE_NAME: string = "@kynesyslabs/dacs-node";
const DEMOS_LOADER: string = "@kynesyslabs/dacs-node/demos-loader";
const CANONICAL_PACKAGE: string = "@kynesyslabs/dacs/canonical";
const VIEM_ACCOUNTS: string = "viem/accounts";

const NODE_PACKAGE = new URL("../../dacs-node/", import.meta.url);
/** Generating two projects and loading the real packages takes longer than the default hook timeout. */
const SETUP_TIMEOUT_MS = 120_000;
const RAIL_CONTRACT = `0x${"ab".repeat(20)}`;
const TESTNET_RAIL: Rail = Object.freeze({
  railId: "x402:default",
  asset: Object.freeze({ kind: "erc20", chainId: 84532, contract: RAIL_CONTRACT, symbol: "USDC", decimals: 6 }),
});
const MAINNET_RAIL: Rail = Object.freeze({ ...TESTNET_RAIL, asset: { ...TESTNET_RAIL.asset, chainId: 1 } });
const BUYER_EVM_KEY = `0x${"4c".repeat(32)}`;
const SELLER_EVM_KEY = `0x${"5d".repeat(32)}`;
/** The eight wallet limits the x402 policy reads, each changed from its default. */
const CHANGED_LIMITS = Object.freeze({
  DACS_WALLET_MAX_CONCURRENT_EFFECTS: "2",
  DACS_WALLET_MAX_RETAINED_RESERVATIONS: "5000",
  DACS_WALLET_ROLLING_WINDOW_MS: "3600000",
  DACS_WALLET_MAX_ROLLING_EFFECTS: "4",
  DACS_X402_WALLET_MINIMUM_RESERVE: "1",
  DACS_X402_WALLET_MAX_ROLLING_DEBIT: "7",
  DACS_X402_WALLET_MAX_CUMULATIVE_DEBIT: "50",
  DACS_X402_WALLET_MAX_COUNTERPARTY_DEBIT: "9",
});

// Only the actor, registry and actor-storage dependencies are replaced; every other export stays real.
const resolveRail = vi.fn<() => Promise<Rail>>();
const createActorRuntime = vi.fn(async (input: Readonly<{ role: string; authority: string; writePolicy: string }>) => ({
  publicKey: new Uint8Array(32),
  authority: input.authority,
  walletAddress: `0x${input.role === "buyer" ? "b1" : "c2"}${"00".repeat(19)}`,
}));
const openSqliteDatabase = vi.fn(async () => ({ close: () => undefined }));

let root: string;
let project: string;
let x402Doctor: GeneratedDoctorModule;
let payDemDoctor: GeneratedDoctorModule;
let x402Config: GeneratedConfigModule;
let lifecycle: GeneratedLifecycleModule;
let nodePackage: NodePackage;
let canonicalize: (value: unknown) => string;
let stub: ChainStub;
let settings: Record<string, string>;
let buyerWallet: string;
const services: TestnetAuthority[] = [];
const cleanup: string[] = [];

beforeAll(async () => {
  expect(existsSync(fileURLToPath(new URL("dist/index.js", NODE_PACKAGE))),
    "build the core package and packages/dacs-node first").toBe(true);
  await import(DEMOS_LOADER);
  ({ root, project } = await generatedProject("x402"));
  const payDem = await generatedProject("pay-dem");
  cleanup.push(root, payDem.root);

  vi.doMock("@kynesyslabs/dacs", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    resolveRail,
  }));
  vi.doMock("@kynesyslabs/dacs-node", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    createDacsDemosRailRegistryProviderV1: () => ({}),
    createDacsDemosActorRuntimeV1: createActorRuntime,
  }));
  vi.doMock("@kynesyslabs/dacs-node/sqlite", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    openDacsNodeSqliteDatabase: openSqliteDatabase,
  }));
  x402Doctor = await import(join(project, "src", "doctor.ts")) as GeneratedDoctorModule;
  x402Config = await import(join(project, "src", "config.ts")) as GeneratedConfigModule;
  lifecycle = await import(join(project, "src", "lifecycle.ts")) as GeneratedLifecycleModule;
  payDemDoctor = await import(join(payDem.project, "src", "doctor.ts")) as GeneratedDoctorModule;
  nodePackage = await import(NODE_PACKAGE_NAME) as NodePackage;
  ({ canonicalize } = await import(CANONICAL_PACKAGE) as { canonicalize: (value: unknown) => string });
  const { privateKeyToAccount } = await import(VIEM_ACCOUNTS) as {
    privateKeyToAccount(key: string): { address: string };
  };
  buyerWallet = privateKeyToAccount(BUYER_EVM_KEY).address.toLowerCase();
  const { dacsWalletSpendTestnetWitnessPublicKeyV1 } = await import(
    fileURLToPath(new URL("src/walletSpendTestnetSettings.ts", NODE_PACKAGE))
  ) as { dacsWalletSpendTestnetWitnessPublicKeyV1(seedFile: string): Promise<string> };

  stub = await startChainStub(5_000_000n);
  const closed = `http://127.0.0.1:${await freePort()}/`;
  const secrets = join(root, "secrets");
  await mkdir(secrets, { mode: 0o700 });
  const secretFiles = {
    "buyer-demos": "buyer-demos-identity-fixture",
    "seller-demos": "seller-demos-identity-fixture",
    "buyer-evm": BUYER_EVM_KEY,
    "seller-evm": SELLER_EVM_KEY,
    "authority-token": TESTNET_TOKEN,
    "witness-seed": TESTNET_SEED_HEX,
  };
  for (const [name, content] of Object.entries(secretFiles)) await writeModeFile(join(secrets, name), content);
  for (const role of ["buyer", "seller"]) await mkdir(join(root, "data", role), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "policy"));
  const identity = (byte: string) => `did:demos:agent:${byte.repeat(32)}`;
  settings = {
    DACS_DEPLOYMENT: "local",
    DACS_BUYER_DATA_DIRECTORY: join(root, "data", "buyer"),
    DACS_SELLER_DATA_DIRECTORY: join(root, "data", "seller"),
    DACS_DEMOS_RPC_URL: closed,
    DACS_BUYER_SERVICE_URL: closed,
    DACS_SELLER_SERVICE_URL: closed,
    DACS_X402_FACILITATOR_URL: closed,
    DACS_EVM_RPC_URL: stub.url,
    DACS_X402_AUTHORIZATION_SEARCH_FROM_BLOCK: "0",
    DACS_RAIL_STEWARD_AUTHORITY: identity("d3"),
    DACS_BUYER_AUTHORITY: identity("b1"),
    DACS_SELLER_AUTHORITY: identity("c2"),
    DACS_BUYER_DEMOS_SECRET_FILE: join(secrets, "buyer-demos"),
    DACS_SELLER_DEMOS_SECRET_FILE: join(secrets, "seller-demos"),
    DACS_BUYER_EVM_SECRET_FILE: join(secrets, "buyer-evm"),
    DACS_SELLER_EVM_SECRET_FILE: join(secrets, "seller-evm"),
    DACS_WALLET_AUTHORITY_URL: `http://127.0.0.1:${await freePort()}/`,
    DACS_BUYER_WALLET_AUTHORITY_TOKEN_FILE: join(secrets, "authority-token"),
    DACS_WALLET_AUTHORITY_ID: TESTNET_AUTHORITY_ID,
    DACS_WALLET_AUTHORITY_EPOCH: TESTNET_EPOCH,
    DACS_WALLET_AUTHORITY_WITNESS_PUBLIC_KEY:
      await dacsWalletSpendTestnetWitnessPublicKeyV1(join(secrets, "witness-seed")),
    DACS_WALLET_AUTHORITY_WITNESS_SEED_FILE: join(secrets, "witness-seed"),
    DACS_WALLET_AUTHORITY_DATA_DIRECTORY: join(root, "authority-data"),
    DACS_WALLET_AUTHORITY_POLICY_FILE: join(root, "policy", "policy.json"),
    DACS_WALLET_AUTHORITY_ALLOW_INSECURE_LOOPBACK: "1",
  };
}, SETUP_TIMEOUT_MS);

afterEach(async () => {
  vi.unstubAllEnvs();
  resolveRail.mockReset();
  createActorRuntime.mockClear();
  openSqliteDatabase.mockClear();
  for (const service of services.splice(0)) await service.stop();
});

afterAll(async () => {
  await stub?.close();
  for (const directory of cleanup) await rm(directory, { recursive: true, force: true });
});

/**
 * Replaces earlier stubs with the fixture settings and the overrides; an
 * undefined override removes the setting. Returns the settings in effect.
 */
function useSettings(overrides: Readonly<Record<string, string | undefined>> = {}): Record<string, string> {
  vi.unstubAllEnvs();
  const merged = { ...settings, ...overrides };
  for (const [name, value] of Object.entries(merged)) vi.stubEnv(name, value);
  return Object.fromEntries(
    Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/** The policy the generated buyer builds for the fixture wallet and rail under the current environment. */
function buyerPolicy(): WalletSpendPolicy {
  return x402Config.configuredX402WalletSpendPolicy({
    wallet: buyerWallet,
    chainId: "eip155:84532",
    asset: RAIL_CONTRACT,
    decimals: TESTNET_RAIL.asset.decimals,
  });
}

async function writtenPolicy(): Promise<Extract<PolicyFileResult, { status: "written" }>> {
  resolveRail.mockResolvedValue(TESTNET_RAIL);
  const result = await x402Doctor.writeGeneratedX402WalletSpendPolicyFileV1();
  if (result.status !== "written") throw new Error(`policy file refused: ${result.reasonCode}`);
  return result;
}

async function serviceLimitCheck(): Promise<DoctorCheck | undefined> {
  resolveRail.mockResolvedValue(TESTNET_RAIL);
  const report = await x402Doctor.runGeneratedDoctor("post-start", "buy", { rail: "x402" });
  return report.checks.find((check) => check.id === "x402.service-limit");
}

describe("generated authority policy file", { timeout: 60_000 }, () => {
  test("authority-policy writes the buyer's exact policy", async () => {
    useSettings();
    const target = join(root, "policy", "policy.json");
    const first = await writtenPolicy();
    const policy = buyerPolicy();
    expect(first).toEqual({
      status: "written",
      path: target,
      policyHash: nodePackage.dacsWalletSpendPolicyHashV1(policy),
    });
    expect(await readFile(target, "utf8")).toBe(canonicalize(policy));
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(createActorRuntime.mock.calls.map(([input]) => [input.role, input.writePolicy]))
      .toEqual([["buyer", "read-only"], ["seller", "read-only"]]);
    expect(openSqliteDatabase).not.toHaveBeenCalled();

    const oldBytes = await readFile(target);
    const reader = await open(target, "r");
    try {
      useSettings({ DACS_X402_WALLET_MAX_ROLLING_DEBIT: "7" });
      const second = await writtenPolicy();
      expect(second.policyHash).not.toBe(first.policyHash);
      expect(await reader.readFile()).toEqual(oldBytes);
      expect(await readFile(target, "utf8")).toBe(canonicalize(buyerPolicy()));
    } finally {
      await reader.close();
    }
    expect(await readdir(dirname(target))).toEqual(["policy.json"]);
  });

  test("each authority-policy refusal is named and writes nothing", async () => {
    const target = join(root, "refused", "policy.json");
    await mkdir(dirname(target));
    const openIdentity = join(root, "secrets", "buyer-demos-readable");
    await writeModeFile(openIdentity, "buyer-demos-identity-fixture", 0o644);
    const cases: readonly RefusalCase[] = [
      {
        reasonCode: "authority-policy-file-setting-missing",
        overrides: { DACS_WALLET_AUTHORITY_POLICY_FILE: undefined },
        runtimeCalls: 0,
      },
      { reasonCode: "authority-x402-profile-required", doctor: () => payDemDoctor, runtimeCalls: 0 },
      // The buyer's identity is opened first, so no runtime is created.
      {
        reasonCode: "authority-policy-actor-unavailable",
        overrides: { DACS_BUYER_DEMOS_SECRET_FILE: openIdentity },
        runtimeCalls: 0,
      },
      {
        reasonCode: "authority-policy-rail-unavailable",
        rail: () => resolveRail.mockRejectedValue(new Error("registry unavailable")),
        runtimeCalls: 2,
      },
      {
        reasonCode: "authority-policy-rail-incompatible",
        rail: () => resolveRail.mockResolvedValue(MAINNET_RAIL),
        runtimeCalls: 2,
      },
      {
        reasonCode: "authority-policy-limits-invalid",
        overrides: { DACS_X402_WALLET_MAX_ROLLING_DEBIT: "abc" },
        runtimeCalls: 2,
      },
    ];
    for (const { reasonCode, overrides = {}, doctor = () => x402Doctor, rail, runtimeCalls } of cases) {
      useSettings({ DACS_WALLET_AUTHORITY_POLICY_FILE: target, ...overrides });
      resolveRail.mockResolvedValue(TESTNET_RAIL);
      rail?.();
      createActorRuntime.mockClear();
      expect(await doctor().writeGeneratedX402WalletSpendPolicyFileV1(), reasonCode)
        .toEqual({ status: "refused", reasonCode });
      expect(createActorRuntime, reasonCode).toHaveBeenCalledTimes(runtimeCalls);
      expect(await readdir(dirname(target)), reasonCode).toEqual([]);
    }

    const notADirectory = join(root, "refused-parent");
    await writeModeFile(notADirectory, "a regular file");
    useSettings({ DACS_WALLET_AUTHORITY_POLICY_FILE: join(notADirectory, "policy.json") });
    resolveRail.mockResolvedValue(TESTNET_RAIL);
    expect(await x402Doctor.writeGeneratedX402WalletSpendPolicyFileV1())
      .toEqual({ status: "refused", reasonCode: "authority-policy-write-failed" });
    expect(await readFile(notADirectory, "utf8")).toBe("a regular file");
    expect((await readdir(root)).filter((name) => name.startsWith("refused-parent"))).toEqual(["refused-parent"]);
  });
});

describe("generated doctor against the testnet authority service", { timeout: 120_000 }, () => {
  test("the post-start doctor check passes against the running service", async () => {
    const environment = useSettings({ DACS_WALLET_AUTHORITY_DATA_DIRECTORY: join(root, "lineage-pass") });
    const written = await writtenPolicy();
    const service = await nodePackage.startDacsWalletSpendTestnetAuthorityV1({ environment });
    services.push(service);
    expect(service.policyHash).toBe(written.policyHash);

    expect(await serviceLimitCheck()).toMatchObject({
      status: "pass",
      facts: {
        policyHash: written.policyHash,
        asset: RAIL_CONTRACT,
        maximumPerOrderDebit: buyerPolicy().assets[0]?.maximumPerOrderDebit,
      },
    });

    useSettings({ DACS_X402_WALLET_MAX_ROLLING_DEBIT: "7" });
    expect((await serviceLimitCheck())?.status).not.toBe("pass");

    useSettings();
    await service.stop();
    expect((await serviceLimitCheck())?.status).not.toBe("pass");
  });

  test("the container computes the host's policy hash after a limit change", async () => {
    const dotEnvironment = useSettings(CHANGED_LIMITS);
    const written = await writtenPolicy();
    const hostHash = nodePackage.dacsWalletSpendPolicyHashV1(buyerPolicy());
    const container = containerEnvironment(await readFile(join(project, "compose.yaml"), "utf8"), dotEnvironment);
    for (const [name, value] of Object.entries(CHANGED_LIMITS)) expect(container[name], name).toBe(value);

    vi.unstubAllEnvs();
    for (const name of Object.keys(dotEnvironment)) vi.stubEnv(name, undefined);
    for (const [name, value] of Object.entries(container)) vi.stubEnv(name, value);
    const containerHash = nodePackage.dacsWalletSpendPolicyHashV1(buyerPolicy());
    expect(containerHash).toBe(hostHash);
    expect(containerHash).toBe(written.policyHash);
  });

  test("the generated backup never selects the authority data directory", async () => {
    const authorityDirectory = join(root, "data", "authority");
    await mkdir(join(authorityDirectory, "witness"), { recursive: true, mode: 0o700 });
    await writeModeFile(join(authorityDirectory, "witness", "record"), "authority witness record");
    await writeModeFile(join(root, "data", "buyer", "buyer-state"), "buyer state");
    await writeModeFile(join(root, "data", "seller", "seller-state"), "seller state");
    const backupKey = join(root, "secrets", "backup-key");
    await writeModeFile(backupKey, "0f".repeat(32));
    useSettings({ DACS_WALLET_AUTHORITY_DATA_DIRECTORY: authorityDirectory, DACS_BACKUP_AUTH_KEY_FILE: backupKey });
    const output = join(root, "backup");
    const manifest = await lifecycle.createGeneratedBackupV1({ outputDirectory: output });
    expect(manifest.roles.map(({ role, files }) => [role, files.map(({ path }) => path)])).toEqual([
      ["buyer", ["buyer-state"]],
      ["seller", ["seller-state"]],
    ]);
    expect(await readdir(join(output, "roles"))).toEqual(["buyer", "seller"]);
  });
});

/** The `NAME: value` entries of the YAML block under the header line, at the given indent. */
function composeBlock(lines: readonly string[], header: number, indent: string): [string, string][] {
  const entries: [string, string][] = [];
  const entry = new RegExp(`^${indent}([A-Z0-9_]+): (.*)$`);
  for (const line of lines.slice(header + 1)) {
    if (!line.startsWith(indent)) break;
    const [, name, value] = entry.exec(line) ?? [];
    if (name !== undefined && value !== undefined) entries.push([name, value]);
  }
  return entries;
}

/**
 * The buyer container's environment as Compose builds it: the shared public
 * entries, then the buyer's own entries, with `${NAME:-default}` and
 * `${NAME:?message}` expanded against the `.env` values. Any other form fails.
 */
function containerEnvironment(
  compose: string,
  dotEnvironment: Readonly<Record<string, string>>,
): Record<string, string> {
  const lines = compose.split("\n");
  const shared = composeBlock(lines, lines.indexOf("x-dacs-public-environment: &dacs-public-environment"), "  ");
  const buyer = composeBlock(lines, lines.indexOf("    environment:", lines.indexOf("  buyer:")), "      ");
  const expand = (value: string): string => value.replace(/\$\{([^}]*)\}/g, (_whole, body: string) => {
    const [, name, fallback, required] = /^([A-Z0-9_]+)(?::-(.*)|:\?(.*))$/.exec(body) ?? [];
    if (name === undefined) throw new Error(`unexpected Compose substitution: \${${body}}`);
    const configured = dotEnvironment[name];
    if (configured !== undefined && configured !== "") return configured;
    if (required !== undefined) throw new Error(`Compose requires ${name}`);
    return fallback ?? "";
  });
  return Object.fromEntries([...shared, ...buyer].map(([name, value]) => [name, expand(value)]));
}
