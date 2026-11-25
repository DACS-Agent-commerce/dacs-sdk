import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { ModuleKind, transpileModule } from "typescript";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createDacsAgentProject } from "../src/index.js";
import { parseCreateDacsAgentArguments } from "../src/cli.js";
import { publishCompleteStagingDirectory } from "../src/publication.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "create-dacs-agent-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function filesBelow(root: string, current = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(root, path)));
    else files.push(path.slice(root.length + 1));
  }
  return files.sort();
}

describe("create-dacs-agent", () => {
  test("builds publishable files from source during pack and publish", async () => {
    const packageSource = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(packageSource.scripts).toMatchObject({
      prepack: "npm run clean && npm run build",
      prepublishOnly: "npm run clean && npm run build",
      clean: "rm -rf dist",
    });
  });

  test("requires the generated project's host dependency to build during pack", async () => {
    const hostPackage = JSON.parse(
      await readFile(new URL("../../dacs-node/package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(hostPackage.scripts).toMatchObject({
      "build:with-core": "npm --prefix ../.. run build && npm run build",
      prepack: "npm run clean && npm run build:with-core",
      prepublishOnly: "npm run clean && npm run build:with-core",
    });
    const corePackage = JSON.parse(
      await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(corePackage.scripts).toMatchObject({
      prepack: "npm run clean && npm run build",
    });
  });

  test("generated projects declare the SDK's Node engines and build on its lowest supported Node", async () => {
    const core = JSON.parse(
      await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { engines: { node: string } };
    const floor = /^\^(\d+\.\d+\.\d+) /.exec(core.engines.node)?.[1];
    expect(floor).toBeDefined();
    const parent = await temporaryDirectory();
    const offline = join(parent, "offline");
    const live = join(parent, "live");
    await createDacsAgentProject({ targetDirectory: offline, install: false, role: "demo-all", deployment: "docker" });
    await createDacsAgentProject({
      targetDirectory: live,
      mode: "live-demos",
      profile: "dacs-sdk:fixed-price-x402:v1",
      role: "buyer",
      deployment: "docker",
      install: false,
    });
    for (const target of [offline, live]) {
      const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
      expect(manifest.engines, target).toEqual({ node: core.engines.node });
      const images = (await readFile(join(target, "Dockerfile"), "utf8")).match(/^FROM \S+/gm);
      expect(images, target).toEqual([
        `FROM node:${floor}-bookworm-slim`,
        `FROM node:${floor}-bookworm-slim`,
      ]);
    }
  });

  test("generates the bounded public-package verifier simulation without installing", async () => {
    const parent = await temporaryDirectory();
    const target = join(parent, "my-agent");
    const result = await createDacsAgentProject({
      targetDirectory: target,
      install: false,
      role: "demo-all",
      deployment: "local",
    });

    expect(result).toMatchObject({
      mode: "offline",
      profile: "dacs-sdk:fixed-price-offline:v1",
      installed: false,
      ran: false,
    });
    expect(await filesBelow(target)).toEqual([
      ".dockerignore",
      ".env.example",
      ".gitignore",
      "Dockerfile",
      "README.md",
      "compose.yaml",
      "dacs.config.ts",
      "data/.gitkeep",
      "package.json",
      "secrets/README.md",
      "src/buyer.ts",
      "src/config.ts",
      "src/seller.ts",
      "src/service.ts",
      "src/verifier.ts",
      "test/offline-lifecycle.test.ts",
      "tsconfig.json",
    ]);
    const packageSource = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
    expect(packageSource.dependencies).toEqual({
      "@kynesyslabs/dacs": "0.1.0-alpha.0",
      "@kynesyslabs/dacs-node": "0.1.0-alpha.0",
    });
    const generatedSources = await Promise.all(
      (await filesBelow(target)).map((file) => readFile(join(target, file), "utf8")),
    );
    const combined = generatedSources.join("\n");
    expect(combined).not.toContain("../../src/");
    expect(combined).not.toContain("@kynesyslabs/dacs/dist");
    expect(combined).not.toMatch(/PRIVATE_KEY|SEED_PHRASE|MNEMONIC/);
    expect(combined).toContain("normativeConformance");
    expect(combined).toContain("commercialSuccess");
    expect(combined).toContain("not the SR-3 attestation required");
    expect(combined).toContain('randomBytes(16).toString("hex")');
    expect(combined).not.toContain("new Date().toISOString()");
    const dockerignore = await readFile(join(target, ".dockerignore"), "utf8");
    expect(dockerignore.split("\n").filter(Boolean)).toEqual([
      "**",
      "!package.json",
      "!package-lock.json",
      "!tsconfig.json",
      "!dacs.config.ts",
      "!src/",
      "!src/**",
      "!test/",
      "!test/**",
    ]);
    const dockerfile = await readFile(join(target, "Dockerfile"), "utf8");
    expect(dockerfile).toContain(
      "COPY package.json package-lock.json ./",
    );
    expect(dockerfile).toContain(
      "npm prune --omit=dev --ignore-scripts",
    );
    expect(dockerfile).toContain("RUN npm ci --ignore-scripts");
    expect(dockerfile).not.toContain("RUN npm install");
    expect(dockerfile).not.toContain("COPY . .");
    expect(dockerfile.indexOf("COPY package.json package-lock.json ./"))
      .toBeLessThan(dockerfile.indexOf("RUN npm ci --ignore-scripts"));
    expect(dockerfile).toContain(
      "install --directory --owner=dacs --group=dacs --mode=0750 /app/data",
    );
    expect(dockerfile).not.toContain(
      "COPY --from=build --chown=dacs:dacs /app /app",
    );
    await expect(
      readFile(join(target, "package-lock.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("fails closed for incompatible profiles, run without install, and non-empty targets", async () => {
    const parent = await temporaryDirectory();
    await expect(
      createDacsAgentProject({
        targetDirectory: join(parent, "live"),
        mode: "live-demos",
        profile: "dacs-sdk:fixed-price-offline:v1",
        install: false,
      }),
    ).rejects.toThrow(/live-demos mode requires/);
    await expect(
      createDacsAgentProject({
        targetDirectory: join(parent, "run"),
        install: false,
        run: true,
      }),
    ).rejects.toThrow(/cannot be combined/);
    await expect(
      createDacsAgentProject({
        targetDirectory: join(parent, "unsupported-role"),
        role: "buyer" as never,
        install: false,
      }),
    ).rejects.toThrow(/only the single-process demo-all simulation/);

    const occupied = join(parent, "occupied");
    await writeFile(occupied, "occupied", "utf8");
    await expect(
      createDacsAgentProject({ targetDirectory: occupied, install: false }),
    ).rejects.toThrow(/not a directory/);

    const linked = join(parent, "linked");
    await symlink(parent, linked);
    await expect(
      createDacsAgentProject({ targetDirectory: linked, install: false }),
    ).rejects.toThrow(/symbolic link/);
  });

  test("generates a guarded authority-separated dual-rail Docker bootstrap", async () => {
    const parent = await temporaryDirectory();
    const target = join(parent, "live-agent");
    const result = await createDacsAgentProject({
      targetDirectory: target,
      mode: "live-demos",
      profile: "dacs-sdk:fixed-price-x402:v1",
      role: "buyer",
      deployment: "docker",
      rails: "both",
      install: false,
    });
    expect(result).toMatchObject({
      mode: "live-demos",
      profile: "dacs-sdk:fixed-price-x402:v1",
      role: "buyer",
      deployment: "docker",
      rails: "both",
      installed: false,
      doctor: "not-run",
    });
    expect(await filesBelow(target)).toEqual(expect.arrayContaining([
      "src/cli.ts",
      "src/doctor.ts",
      "src/funded-doctor.ts",
      "src/fulfilment-examples.ts",
      "src/lifecycle.ts",
      "src/local-lifecycle.ts",
      "src/telemetry.ts",
      "src/purchase.ts",
      "src/setup.ts",
      "src/service.ts",
      "src/upgrade.ts",
      "test/live-bootstrap.test.ts",
      "compose.yaml",
      "Dockerfile",
      "data/buyer/.gitkeep",
      "data/seller/.gitkeep",
    ]));
    for (const role of ["buyer", "seller"] as const) {
      const observed = await lstat(join(target, "data", role));
      expect(observed.isDirectory()).toBe(true);
      if (process.platform !== "win32") expect(observed.mode & 0o077).toBe(0);
    }
    const packageSource = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
    expect(packageSource.dependencies).toEqual({
      "@kynesyslabs/dacs": "0.1.0-alpha.0",
      "@kynesyslabs/dacs-node": "0.1.0-alpha.0",
      "@kynesyslabs/demosdk": "4.0.19",
      "@x402/core": "2.15.0",
      "@x402/evm": "2.15.0",
      "@x402/fetch": "2.15.0",
      "better-sqlite3": "12.6.2",
      "viem": "2.55.19",
    });
    expect(packageSource.dacs).toEqual({
      generatorVersion: "0.1.0-alpha.0",
      releaseMetadataVersion: 1,
      standardRevision: "d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20",
      configSchemaVersion: 1,
      sqliteSchemaVersion: 8,
      supportedSqliteMigrationFrom: [1, 2, 3, 4, 5, 6, 7, 8],
      breakingConfigurationChanges: [],
    });
    expect(packageSource.scripts).toMatchObject({
      "dacs:doctor": expect.any(String),
      "dacs:doctor:funded": expect.any(String),
      "dacs:up": expect.any(String),
      "dacs:setup": expect.any(String),
      "dacs:buy": expect.any(String),
      "dacs:status": expect.any(String),
      "dacs:metrics": expect.any(String),
      "dacs:down": expect.any(String),
      "dacs:upgrade": expect.any(String),
      "dacs:backup": expect.any(String),
      "dacs:restore": expect.any(String),
      "dacs:uninstall": expect.any(String),
    });
    for (const command of Object.values(packageSource.scripts as Record<string, string>)) {
      if (command.includes("dist/src/") || command.includes("dist/test/")) {
        expect(command).toContain(
          "node --import @kynesyslabs/dacs-node/demos-loader",
        );
      }
    }
    const compose = await readFile(join(target, "compose.yaml"), "utf8");
    expect(compose).toContain("DACS_BUYER_DATA_DIRECTORY");
    expect(compose).toContain("DACS_SELLER_DATA_DIRECTORY");
    expect(compose).toContain("DACS_BUYER_DEMOS_SECRET_FILE");
    expect(compose).toContain("DACS_SELLER_DEMOS_SECRET_FILE");
    expect(compose).toContain("DACS_BUYER_WALLET_AUTHORITY_TOKEN_FILE");
    expect(compose).toContain("/run/secrets/wallet-authority-token:ro");
    expect(compose).toContain("DACS_WALLET_AUTHORITY_URL");
    expect(compose).toContain("DACS_X402_LISTING_DRAFT_FILE");
    expect(compose).toContain("DACS_PAY_DEM_LISTING_DRAFT_FILE");
    expect(compose).toContain("read_only: true");
    expect(compose).toContain("DACS_RUNTIME_UID");
    expect(compose).toContain("no-new-privileges:true");
    expect(compose).toContain("network_mode: host");
    expect(compose).toContain("http://127.0.0.1:3101");
    expect(compose).not.toContain("http://buyer:");
    expect(compose).not.toContain("http://seller:");
    expect(compose).not.toMatch(/(?:3306|5432|6379):/);
    const environmentExample = await readFile(join(target, ".env.example"), "utf8");
    const expectedRuntimeUid = typeof process.getuid === "function" && process.getuid() > 0
      ? process.getuid() : 10001;
    expect(environmentExample).toContain(`DACS_RUNTIME_UID=${expectedRuntimeUid}`);
    expect(environmentExample).toContain("DACS_DEPLOYMENT=docker");
    expect(environmentExample).not.toContain("DACS_SETUP_WRITE_CONFIRM");
    expect(environmentExample).not.toContain("DACS_PURCHASE_CONFIRM");
    expect(environmentExample).not.toContain("DACS_DOCTOR_FUNDED_CONFIRM");
    expect(environmentExample).not.toContain("DACS_RESTORE_CONFIRM");
    expect(environmentExample).not.toContain("DACS_UNINSTALL_CONFIRM");
    expect(environmentExample).toContain("DACS_BACKUP_AUTH_KEY_FILE=");
    expect(environmentExample).toContain("DACS_BUYER_WALLET_AUTHORITY_TOKEN_FILE=");
    expect(environmentExample).toContain("DACS_WALLET_AUTHORITY_URL=");
    expect(environmentExample).toContain("DACS_WALLET_MAX_CONCURRENT_EFFECTS=1");
    expect(environmentExample).toContain("DACS_X402_WALLET_MAX_CUMULATIVE_DEBIT=100");
    expect(environmentExample).toContain("DACS_PAY_DEM_WALLET_MINIMUM_RESERVE=5");
    const generatedConfig = await readFile(join(target, "dacs.config.ts"), "utf8");
    expect(generatedConfig).toContain("write confirmation must not be persisted in .env");
    expect(generatedConfig).toContain("dacs4:registry:v0.1");
    expect(generatedConfig).toContain('["pay-dem","x402"]');
    expect(generatedConfig).not.toContain("dacs4:registry:x402");
    const dockerfile = await readFile(join(target, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("RUN npm ci --ignore-scripts");
    expect(dockerfile).toContain("RUN npm rebuild better-sqlite3");
    expect(dockerfile).toContain("npm ci --ignore-scripts --omit=optional");
    expect(dockerfile).toContain("npm prune --omit=dev --omit=optional --ignore-scripts");
    expect(dockerfile).toContain("--mode=0755 /app");
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).toContain(
      'CMD ["node", "--import", "@kynesyslabs/dacs-node/demos-loader", "dist/src/service.js"]',
    );
    expect(dockerfile).not.toContain("COPY . .");
    const combined = (await Promise.all(
      (await filesBelow(target)).map((file) => readFile(join(target, file), "utf8")),
    )).join("\n");
    expect(combined).not.toContain("git+");
    expect(combined).not.toContain("../../src/");
    expect(JSON.stringify(packageSource)).not.toContain("file:");
    expect(combined).not.toContain("reviewed-live-adapter-not-configured");
    expect(combined).toContain("resolveDacsX402ExistingListingV1");
    expect(combined).toContain("readDacsPublicJsonV1");
    expect(combined).toContain("inspectDacsX402PurchaseCostV1");
    expect(combined).toContain("inspectDacsDemosBalanceHeadroomV1");
    expect(combined).toContain("inspectDacsX402AssetBalanceV1");
    expect(combined).toContain("inspectDacsX402GasBalanceV1");
    expect(combined).toContain("inspectDacsX402ListingDraftV1");
    expect(combined).toContain("prepareDacsListingSetupV1");
    expect(combined).toContain("createDacsListingSetupExecutorV1");
    expect(combined).toContain("createDacsPurchaseQueueExecutorV1");
    expect(combined).toContain("prepareDacsX402PurchaseV1");
    expect(combined).toContain("prepareDacsPayDemPurchaseV1");
    expect(combined).toContain("maximumDemosStorageWriteFeeDem");
    expect(combined).toContain("consent-bound plan reserve five buyer writes");
    expect(combined).toContain("resolveDacsPayDemExistingListingV1");
    expect(combined).toContain("createDacsFixedPriceMultirailBuyerLiveV1");
    expect(combined).toContain("createDacsFixedPriceMultirailSellerLiveV1");
    expect(combined).toContain("createDacsRemoteWalletSpendAuthorityV2");
    expect(combined).not.toContain("createDacsRemoteWalletSpendAuthorityV1");
    expect(combined).toContain("DACS_WALLET_AUTHORITY_ID");
    expect(combined).toContain("DACS_WALLET_AUTHORITY_EPOCH");
    expect(combined).toContain("DACS_WALLET_AUTHORITY_WITNESS_PUBLIC_KEY");
    expect(combined).not.toContain("createDacsWalletSpendAuthorityV1");
    expect(combined).not.toContain("createDacsX402WalletSpendRecoveryAuthenticatorV1");
    expect(combined).not.toContain("createDacsPayDemWalletSpendRecoveryAuthenticatorV1");
    expect(combined).not.toContain("authenticateRecovery: async () => true");
    expect(combined).not.toContain(
      'if (observation.disposition !== "settled") return true',
    );
    expect(combined).toContain("assets: Object.freeze([Object.freeze({");
    expect(combined).not.toContain('stateDirectory: context.config.dataDirectory');
    expect(combined).toContain("backup-authority-state-rejected");
    expect(combined).toContain("import the complete legacy wallet-spend journal");
    expect(combined).toContain("Never empty-provision an existing");
    expect(combined).toContain('walletPolicyStatus: "post-start-inspection-required"');
    expect(combined).toContain('reasonCode: "wallet-spend-operator-action-required"');
    expect(combined).toContain("operatorActionCount: status.operatorActionReservations.length");
    expect(combined).toContain("reservedWorstCaseDebit: asset.reservedWorstCaseDebit");
    expect(combined).toContain("availableHeadroom: asset.availableHeadroom");
    expect(combined).toContain("--max-total-debit-dem");
    expect(combined).toContain("dacs-generated-purchase-request/v1");
    expect(combined).toContain("--resume-job");
    expect(combined).toContain("resume: input.resume");
    expect(combined).toContain("createDacsX402ExactRetainedReplayConfirmerV1");
    expect(combined).toContain("startDacsLocalRoleServices");
    expect(combined).not.toContain('adapterStatus: "not-configured"');
    expect(combined).toContain("runDacsGuardedCommandV1");
    expect(combined).toContain("openDacsListingDiscoveryStoreV1");
    expect(combined).toContain("createDacsListingDiscoveryRequestHandlerV1");
    expect(combined).toContain('writePolicy: "read-only"');
    expect(combined).toContain("readDacsRoleServiceStatusesV1");
    expect(combined).toContain("createDacsLiveRoleRuntimeV1");
    expect(combined).not.toContain("createDacsUnavailableLiveCommerceGraphV1");
    expect(combined).toContain("createDacsFixedPriceX402BuyerLiveV1");
    expect(combined).toContain("createDacsFixedPriceX402SellerLiveV1");
    expect(combined).toContain("DACS_X402_AUTHORIZATION_SEARCH_FROM_BLOCK");
    expect(combined).toContain('finalityTag: "latest"');
    expect(combined).toContain('evmFinalityTag: "latest"');
    expect(combined).toContain("retryDelayMs: 5_000");
    expect(combined).toContain("minimumConfirmations: Number(finalityBlocks)");
    expect(combined).toContain("inspectDacsX402TokenDomainV1");
    expect(combined).toContain("DACS_X402_TOKEN_NAME=USDC");
    expect(combined).not.toContain("DACS_X402_TOKEN_NAME=USD Coin");
    expect(combined).not.toContain('status: "not-configured"');
    expect(combined).toContain("createCommerceGraph: async");
    expect(combined).not.toContain("createOperations: () => Object.freeze({})");
    expect(combined).toContain("post-start-doctor-required");
    expect(combined).toContain("DACS_SETUP_WRITE_CONFIRM=1");
    expect(combined).toContain("DACS_PURCHASE_CONFIRM=1");
    expect(combined).toContain("DACS_DOCTOR_FUNDED_CONFIRM=1");
    expect(combined).toContain("DACS_RESTORE_CONFIRM=1");
    expect(combined).toContain("DACS_UNINSTALL_CONFIRM=1");
    expect(combined).toContain("dacs-generated-backup/v1");
    expect(combined).toContain("backup-authentication-failed");
    expect(combined).toContain("safetyBackupDirectory");
    expect(combined).toContain("--explain");
    expect(combined).toContain("createStaticJsonFulfilment");
    expect(combined).toContain("reconcileExactEffectBeforeRetry");
    expect(combined).toContain("blindRetryPermitted: false");
    expect(combined).toContain("dacs-generated-commerce-timing/v1");
    expect(combined).toContain("operational-telemetry-not-normative-proof");
    expect(combined).toContain("telemetry-capacity-reached");
    expect(combined).toContain("prepareDacsFundedDoctorV1");
    expect(combined).toContain("createDacsFundedDoctorExecutorV1");
    expect(combined).toContain("--resume-run");
    expect(combined).toContain("reconciliation is read-only");
    expect(combined).not.toContain("funded doctor adapter is not configured");
    expect(combined).toContain("dacs-generated-upgrade-check/v1");
    expect(combined).toContain("inspectDacsNodeSqliteUpgradeSafetyV1");
    expect(combined.match(/httpTransport: Object\.freeze/g)).toHaveLength(2);
    expect(combined).toContain(
      "sqliteSchemaVersion: backup.release.sqliteSchemaVersion + 1",
    );
    expect(combined).toContain("release: { ...backup.release, sqliteSchemaVersion: 0 }");
    expect(combined).toContain("registry.npmjs.org");
    expect(combined).toContain("automatic-upgrade-not-supported");
    expect(combined).not.toContain('availableVersion: "not-queried"');
  });

  test.each(["pay-dem", "both"] as const)("configures a network pin in a generated live project: %s", async (rails) => {
    const target = join(await temporaryDirectory(), "agent");
    await createDacsAgentProject({
      targetDirectory: target, mode: "live-demos", profile: "dacs-sdk:fixed-price-x402:v1",
      role: "seller", deployment: "docker", rails, install: false,
    });
    const source = await readFile(join(target, "dacs.config.ts"), "utf8");
    const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } });
    const exports = {} as { generatedRoleConfig(role: string): { demos: unknown } };
    runInNewContext(compiled.outputText, { exports, require: createRequire(import.meta.url), process });
    vi.stubEnv("DACS_DEMOS_RPC_URL", "https://rpc.example");
    vi.stubEnv("DACS_DEMOS_GENESIS_HASH", "a".repeat(64));
    vi.stubEnv("DACS_DEMOS_CHAIN_ID", "demos-test");
    expect(exports.generatedRoleConfig("seller").demos).toMatchObject({
      rpcUrl: "https://rpc.example", expectedIdentity: { genesisHash: "a".repeat(64), chainId: "demos-test" },
    });
    vi.stubEnv("DACS_DEMOS_CHAIN_ID", "");
    expect(exports.generatedRoleConfig("buyer").demos).toMatchObject({ expectedIdentity: { genesisHash: "a".repeat(64) } });
    vi.stubEnv("DACS_DEMOS_CHAIN_ID", "demos-test");
    vi.stubEnv("DACS_DEMOS_GENESIS_HASH", "");
    expect(() => exports.generatedRoleConfig("buyer")).toThrow(/DACS_DEMOS_CHAIN_ID.*DACS_DEMOS_GENESIS_HASH/);
    vi.stubEnv("DACS_DEMOS_CHAIN_ID", "");
    expect(exports.generatedRoleConfig("buyer").demos).not.toHaveProperty("expectedIdentity");
    for (const file of [".env.example", "compose.yaml"]) {
      const environment = await readFile(join(target, file), "utf8");
      expect(environment).toContain("DACS_DEMOS_GENESIS_HASH");
      expect(environment).toContain("DACS_DEMOS_CHAIN_ID");
    }
  });

  test("generates a native DEM project without EVM or x402 dependencies", async () => {
    const parent = await temporaryDirectory();
    const target = join(parent, "native-agent");
    const result = await createDacsAgentProject({
      targetDirectory: target,
      mode: "live-demos",
      profile: "dacs-sdk:fixed-price-x402:v1",
      role: "seller",
      deployment: "docker",
      rails: "pay-dem",
      install: false,
    });
    expect(result).toMatchObject({ rails: "pay-dem", installed: false });
    const packageSource = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
    expect(packageSource.dependencies).toEqual({
      "@kynesyslabs/dacs": "0.1.0-alpha.0",
      "@kynesyslabs/dacs-node": "0.1.0-alpha.0",
      "@kynesyslabs/demosdk": "4.0.19",
      "better-sqlite3": "12.6.2",
    });
    const config = await readFile(join(target, "dacs.config.ts"), "utf8");
    expect(config).toContain('["pay-dem"]');
    expect(config).toContain('requestedNetwork: "demos"');
    const environment = await readFile(join(target, ".env.example"), "utf8");
    const compose = await readFile(join(target, "compose.yaml"), "utf8");
    for (const source of [environment, compose]) {
      expect(source).not.toContain("DACS_BUYER_EVM_SECRET_FILE");
      expect(source).not.toContain("DACS_SELLER_EVM_SECRET_FILE");
      expect(source).not.toContain("DACS_EVM_RPC_URL");
      expect(source).not.toContain("DACS_X402_");
      expect(source).not.toContain("DACS_FIXED_PRICE_AMOUNT");
      expect(source).not.toContain("DACS_MAX_EVM_NETWORK_FEE_ETH");
      expect(source).toContain("DACS_PAY_DEM_LISTING_DRAFT_FILE");
      expect(source).toContain("DACS_MAX_PAY_DEM_TOTAL_DEBIT");
    }
    expect(environment).toContain("DACS_MAX_SERVICE_ASSET=DEM");
    expect(compose).toContain("DACS_MAX_SERVICE_ASSET:-DEM");
  });

  test("generates an x402 project without native-payment configuration noise", async () => {
    const parent = await temporaryDirectory();
    const target = join(parent, "x402-agent");
    await createDacsAgentProject({
      targetDirectory: target,
      mode: "live-demos",
      profile: "dacs-sdk:fixed-price-x402:v1",
      role: "buyer",
      deployment: "docker",
      rails: "x402",
      install: false,
    });
    const environment = await readFile(join(target, ".env.example"), "utf8");
    const compose = await readFile(join(target, "compose.yaml"), "utf8");
    for (const source of [environment, compose]) {
      expect(source).not.toContain("DACS_PAY_DEM_");
      expect(source).not.toContain("DACS_MAX_PAY_DEM_");
      expect(source).toContain("DACS_X402_LISTING_DRAFT_FILE");
      expect(source).toContain("DACS_X402_FACILITATOR_URL");
    }
  });

  test("generates a real local role-service lifecycle when selected", async () => {
    const parent = await temporaryDirectory();
    const target = join(parent, "local-live-agent");
    await createDacsAgentProject({
      targetDirectory: target,
      mode: "live-demos",
      profile: "dacs-sdk:fixed-price-x402:v1",
      role: "buyer",
      deployment: "local",
      install: false,
    });
    const environmentExample = await readFile(join(target, ".env.example"), "utf8");
    const lifecycle = await readFile(join(target, "src/local-lifecycle.ts"), "utf8");
    const cli = await readFile(join(target, "src/cli.ts"), "utf8");
    expect(environmentExample).toContain("DACS_DEPLOYMENT=local");
    expect(lifecycle).toContain('DACS_ROLE: role');
    expect(lifecycle).toContain('process.kill(record.pid, "SIGTERM")');
    expect(lifecycle).toContain("local-runtime-process-identity-mismatch");
    expect(cli).toContain("startDacsLocalRoleServices");
    expect(cli).toContain("stopDacsLocalRoleServices");
  });

  test("publishes the complete tree atomically across a nested-symlink race", async () => {
    const parent = await temporaryDirectory();
    const target = join(parent, "atomic-agent");
    const outside = join(parent, "outside");
    await mkdir(outside);

    const plantDuringPartialPublication = async (): Promise<boolean> => {
      for (let attempt = 0; attempt < 5_000; attempt += 1) {
        try {
          await lstat(join(target, "secrets", "README.md"));
          try {
            await lstat(join(target, "src", "verifier.ts"));
            return false;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          await symlink(outside, join(target, "src"));
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      }
      return false;
    };

    const [result, planted] = await Promise.all([
      createDacsAgentProject({ targetDirectory: target, install: false }),
      plantDuringPartialPublication(),
    ]);
    expect(result.files).toContain("src/verifier.ts");
    expect(planted).toBe(false);
    expect((await readdir(outside))).toEqual([]);
    expect((await lstat(join(target, "src"))).isDirectory()).toBe(true);
    expect(await readdir(parent)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/\.staging-/)]),
    );
  });

  test("allows only one complete publisher for a concurrent target", async () => {
    const parent = await temporaryDirectory();
    const target = join(parent, "contended-agent");
    const results = await Promise.allSettled([
      createDacsAgentProject({ targetDirectory: target, install: false }),
      createDacsAgentProject({ targetDirectory: target, install: false }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await filesBelow(target)).toContain("src/service.ts");
    expect(await readdir(parent)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/\.staging-/)]),
    );
  });

  test("defines the concurrent empty-target publication boundary", async () => {
    const parent = await temporaryDirectory();
    const staging = join(parent, ".agent.staging-test");
    const target = join(parent, "agent");
    await mkdir(staging);
    await writeFile(join(staging, "complete.txt"), "complete\n", "utf8");

    const publication = publishCompleteStagingDirectory(
      staging,
      target,
      () => mkdir(target),
    );
    if (process.platform === "win32") {
      await expect(publication).rejects.toBeDefined();
      return;
    }
    await expect(publication).resolves.toBeUndefined();
    await expect(readFile(join(target, "complete.txt"), "utf8")).resolves.toBe("complete\n");
    await expect(lstat(staging)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("parses the documented non-interactive command", () => {
    expect(
      parseCreateDacsAgentArguments(["my-agent", "--yes", "--run"]),
    ).toMatchObject({
      targetDirectory: "my-agent",
      yes: true,
      run: true,
      install: true,
    });
  });

  test("parses the documented non-interactive live bootstrap", () => {
    expect(parseCreateDacsAgentArguments([
      "my-agent", "--yes", "--mode", "live-demos", "--profile",
      "dacs-sdk:fixed-price-x402:v1", "--role", "seller", "--deploy", "docker",
      "--rails", "both",
    ])).toMatchObject({
      targetDirectory: "my-agent",
      mode: "live-demos",
      profile: "dacs-sdk:fixed-price-x402:v1",
      role: "seller",
      deployment: "docker",
      rails: "both",
      yes: true,
    });
    expect(() => parseCreateDacsAgentArguments([
      "my-agent", "--yes", "--mode", "live-demos", "--rails", "fallback",
    ])).toThrow(/x402, pay-dem or both/);
    expect(() => parseCreateDacsAgentArguments([
      "my-agent", "--yes", "--mode", "live-demos", "--role", "verifier",
    ])).toThrow(/demo-all, buyer or seller/);
  });

  test("rejects the unimplemented live verifier role through the public API", async () => {
    const parent = await temporaryDirectory();
    await expect(createDacsAgentProject({
      targetDirectory: join(parent, "verifier-live-agent"),
      mode: "live-demos",
      profile: "dacs-sdk:fixed-price-x402:v1",
      role: "verifier" as never,
      install: false,
    })).rejects.toThrow(/demo-all, buyer or seller/);
  });
});

type Rails = "x402" | "pay-dem" | "both";

const AUTHORITY_SCRIPTS = Object.freeze({
  "dacs:authority": "npm run build --silent && node --import @kynesyslabs/dacs-node/demos-loader dist/src/cli.js authority",
  "dacs:authority:policy":
    "npm run build --silent && node --import @kynesyslabs/dacs-node/demos-loader dist/src/cli.js authority-policy",
});
const NEW_AUTHORITY_SETTINGS = Object.freeze([
  "DACS_WALLET_AUTHORITY_WITNESS_SEED_FILE",
  "DACS_WALLET_AUTHORITY_DATA_DIRECTORY",
  "DACS_WALLET_AUTHORITY_POLICY_FILE",
]);
/** The DEM lane's own settings the generator adds; the lane also reads DACS_DEMOS_RPC_URL. */
const DEM_AUTHORITY_SETTINGS = Object.freeze([
  "DACS_PAY_DEM_WALLET_AUTHORITY_DATA_DIRECTORY",
  "DACS_PAY_DEM_WALLET_AUTHORITY_POLICY_FILE",
]);
/** Settings only the x402 lane reads. */
const X402_ONLY_AUTHORITY_SETTINGS = Object.freeze([
  "DACS_WALLET_AUTHORITY_DATA_DIRECTORY",
  "DACS_WALLET_AUTHORITY_POLICY_FILE",
  "DACS_EVM_RPC_URL",
]);
const NODE_SOURCE = new URL("../../dacs-node/src/", import.meta.url);

/** Reads one export of a node package source module; the core package must be built for its imports. */
async function nodeSourceExport<T>(module: string, name: string): Promise<T> {
  const loaded = await import(fileURLToPath(new URL(module, NODE_SOURCE))) as Record<string, unknown>;
  if (!(name in loaded)) throw new Error(`${module} does not export ${name}`);
  return loaded[name] as T;
}

async function generatedLiveProject(
  rails: Rails,
  deployment: "local" | "docker" = "docker",
): Promise<string> {
  const target = join(await temporaryDirectory(), `${rails}-agent`);
  await createDacsAgentProject({
    targetDirectory: target,
    mode: "live-demos",
    profile: "dacs-sdk:fixed-price-x402:v1",
    role: "buyer",
    deployment,
    rails,
    install: false,
  });
  return target;
}

/** The `NAME=value` lines of a generated `.env.example`. */
function environmentLines(text: string): Map<string, string> {
  const lines = new Map<string, string>();
  for (const line of text.split("\n")) {
    const [, name, value] = /^([A-Z0-9_]+)=(.*)$/.exec(line) ?? [];
    if (name !== undefined && value !== undefined) lines.set(name, value);
  }
  return lines;
}

/** The lines of one Compose service's `environment` block. */
function composeEnvironment(compose: string, service: "buyer" | "seller"): string[] {
  const lines = compose.split("\n");
  const start = lines.indexOf(`  ${service}:`);
  const environment = lines.indexOf("    environment:", start);
  const volumes = lines.indexOf("    volumes:", environment);
  if (start < 0 || environment < 0 || volumes < 0) throw new Error(`no ${service} environment`);
  return lines.slice(environment + 1, volumes);
}

// The first import of the node package source transforms it, which takes several seconds.
describe("generated testnet wallet-spend authority wiring", { timeout: 60_000 }, () => {
  test("generated projects get the authority scripts, settings and README for their rails", async () => {
    const settingNames = (name: string) => nodeSourceExport<readonly string[]>("walletSpendTestnetSettings.ts", name);
    const x402Names = await settingNames("DACS_WALLET_SPEND_TESTNET_AUTHORITY_SETTING_NAMES");
    const commonNames = await settingNames("DACS_WALLET_SPEND_TESTNET_AUTHORITY_COMMON_SETTING_NAMES");
    const demNames = await settingNames("DACS_WALLET_SPEND_TESTNET_AUTHORITY_PAY_DEM_SETTING_NAMES");
    expect([x402Names.length, commonNames.length, demNames.length]).toEqual([10, 6, 3]);
    for (const rails of ["x402", "pay-dem", "both"] as const) {
      const x402 = rails !== "pay-dem";
      const payDem = rails !== "x402";
      const target = await generatedLiveProject(rails);
      const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      };
      expect(manifest.scripts, rails).toMatchObject(AUTHORITY_SCRIPTS);

      const environment = environmentLines(await readFile(join(target, ".env.example"), "utf8"));
      const listed = [...commonNames, ...(x402 ? x402Names : []), ...(payDem ? demNames : [])];
      expect(new Set(listed).size, rails).toBe({ x402: 10, "pay-dem": 9, both: 13 }[rails]);
      for (const name of listed) expect(environment.has(name), `${rails} ${name}`).toBe(true);
      const added = [
        "DACS_WALLET_AUTHORITY_WITNESS_SEED_FILE",
        ...(x402 ? NEW_AUTHORITY_SETTINGS : []),
        ...(payDem ? DEM_AUTHORITY_SETTINGS : []),
      ];
      for (const name of added) expect(environment.get(name), `${rails} ${name}`).toBe("");
      const otherRail = [...(x402 ? [] : X402_ONLY_AUTHORITY_SETTINGS), ...(payDem ? [] : DEM_AUTHORITY_SETTINGS)];
      for (const name of otherRail) expect(environment.has(name), `${rails} ${name}`).toBe(false);

      const readme = (await readFile(join(target, "secrets", "README.md"), "utf8")).replace(/\s+/g, " ");
      for (const expected of [
        ...Object.keys(AUTHORITY_SCRIPTS),
        ...commonNames,
        "npm run dacs:authority -- --print-witness-public-key",
        "npm run dacs:doctor -- --phase post-start --for buy",
        "hold-needs-operator",
        ...(x402 ? [...x402Names, "eip155:84532", "x402.service-limit", "wallet-spend-chain-nonce-used-unmatched"] : []),
        ...(payDem ? [
          ...demNames, "(`demos`)", "pay-dem.service-limit", "wallet-spend-testnet-authority-demos-network-mismatch",
          "wallet-spend-dem-",
        ] : []),
        ...(rails === "both" ? ["--rail x402", "--rail pay-dem"] : []),
      ]) {
        expect(readme, `${rails} ${expected}`).toContain(expected);
      }
      for (const absent of [...otherRail, ...(x402 ? [] : ["eip155:84532"]), "refuses the `pay-dem` policy"]) {
        expect(readme, `${rails} ${absent}`).not.toContain(absent);
      }
    }
  });

  test("generation writes no secret", async () => {
    for (const rails of ["x402", "pay-dem", "both"] as const) {
      const target = await generatedLiveProject(rails);
      const files = await filesBelow(target);
      expect(files, rails).not.toContain(".env");
      for (const file of files) {
        expect(file, rails).not.toMatch(/(?:^|\/)[^/]*(?:token|seed|\.key|\.pem|\.wallet|\.mnemonic)[^/]*$/i);
        const text = await readFile(join(target, file), "utf8");
        // Raw private keys, witness seeds and 32-byte secrets are written as 64 hexadecimal characters.
        expect(text, `${rails} ${file}`).not.toMatch(/(?<![0-9A-Za-z])(?:0x)?[0-9a-fA-F]{64}(?![0-9A-Za-z])/);
      }
      const environment = environmentLines(await readFile(join(target, ".env.example"), "utf8"));
      for (const name of [
        "DACS_BUYER_WALLET_AUTHORITY_TOKEN_FILE",
        "DACS_WALLET_AUTHORITY_WITNESS_PUBLIC_KEY",
        ...(rails === "pay-dem" ? [] : NEW_AUTHORITY_SETTINGS),
      ]) {
        expect(environment.get(name), `${rails} ${name}`).toBe("");
      }
    }
  });

  test("existing script and container assertions still pass", async () => {
    for (const rails of ["x402", "pay-dem", "both"] as const) {
      const target = await generatedLiveProject(rails);
      const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      };
      for (const command of Object.values(manifest.scripts)) {
        if (command.includes("dist/src/") || command.includes("dist/test/")) {
          expect(command, rails).toContain("node --import @kynesyslabs/dacs-node/demos-loader");
        }
      }
      const dockerfile = await readFile(join(target, "Dockerfile"), "utf8");
      expect(dockerfile, rails).toContain(
        'CMD ["node", "--import", "@kynesyslabs/dacs-node/demos-loader", "dist/src/service.js"]',
      );
      const compose = await readFile(join(target, "compose.yaml"), "utf8");
      expect(compose, rails).not.toMatch(/^ {2}[a-z-]*authority[a-z-]*:/m);
      expect(compose, rails).not.toContain("DACS_WALLET_AUTHORITY_DATA_DIRECTORY");
      expect(dockerfile, rails).not.toContain("authority");
    }
  });

  test("the generated buyer signs authorizations no longer than the service's expiry bound", async () => {
    const bound = await nodeSourceExport<number>(
      "walletSpendTestnetRecovery.ts", "DACS_WALLET_SPEND_TESTNET_HOLD_EXPIRY_SECONDS",
    );
    const target = await generatedLiveProject("x402");
    const windows: number[] = [];
    for (const file of (await filesBelow(target)).filter((path) => path.startsWith("src/"))) {
      const text = await readFile(join(target, file), "utf8");
      for (const match of text.matchAll(/maxTimeoutSeconds:\s*(\d+)/g)) windows.push(Number(match[1]));
    }
    expect(windows.length).toBeGreaterThan(0);
    for (const window of windows) expect(window).toBeLessThanOrEqual(bound);
  });

  test("buyer containers receive every wallet limit their rails' policies read", async () => {
    for (const rails of ["x402", "pay-dem", "both"] as const) {
      const target = await generatedLiveProject(rails);
      const config = await readFile(join(target, "src", "config.ts"), "utf8");
      // The limit settings read between two declarations of the generated config, with their fallbacks.
      const limitsBetween = (from: string, to: string) => {
        const start = config.indexOf(from);
        const end = config.indexOf(to);
        expect(start, `${rails} ${from}`).toBeGreaterThan(0);
        expect(end, `${rails} ${to}`).toBeGreaterThan(start);
        return [...config.slice(start, end).matchAll(
          /(?:positiveIntegerEnvironment\(\s*"([A-Z0-9_]+)",\s*(\d+)|decimalEnvironment\(\s*"([A-Z0-9_]+)",\s*"([^"]+)")/g,
        )].map((match) => ({ name: match[1] ?? match[3] ?? "", fallback: match[2] ?? match[4] ?? "" }));
      };
      const shared = limitsBetween("function walletPolicyLimits", "export function configuredX402WalletSpendPolicy");
      const x402 = limitsBetween(
        "export function configuredX402WalletSpendPolicy", "export function configuredPayDemWalletSpendPolicy",
      );
      const payDem = limitsBetween(
        "export function configuredPayDemWalletSpendPolicy", "export function configuredFundedDoctorAuthority",
      );
      expect([shared.length, x402.length, payDem.length], rails).toEqual([4, 4, 4]);
      const limits = [...shared, ...(rails === "pay-dem" ? [] : x402), ...(rails === "x402" ? [] : payDem)];
      const compose = await readFile(join(target, "compose.yaml"), "utf8");
      const buyer = composeEnvironment(compose, "buyer");
      const seller = composeEnvironment(compose, "seller").join("\n");
      const environment = environmentLines(await readFile(join(target, ".env.example"), "utf8"));
      for (const { name, fallback } of limits) {
        expect(buyer, `${rails} ${name}`).toContain(`      ${name}: \${${name}:-${fallback}}`);
        expect(seller, `${rails} ${name}`).not.toContain(name);
        expect(environment.get(name), `${rails} ${name}`).toBe(fallback);
      }
      if (rails === "x402") expect(buyer.join("\n")).not.toContain("DACS_PAY_DEM_WALLET_");
      if (rails === "pay-dem") expect(buyer.join("\n")).not.toContain("DACS_X402_WALLET_");
    }
  });

  test("the docs list the testnet service's commands, settings and named codes", async () => {
    const settingNames = await nodeSourceExport<readonly string[]>(
      "walletSpendTestnetSettings.ts", "DACS_WALLET_SPEND_TESTNET_AUTHORITY_SETTING_NAMES",
    );
    const demSettingNames = await nodeSourceExport<readonly string[]>(
      "walletSpendTestnetSettings.ts", "DACS_WALLET_SPEND_TESTNET_AUTHORITY_PAY_DEM_SETTING_NAMES",
    );
    const docs = await readFile(new URL("../../../docs/wallet-spend-authority.md", import.meta.url), "utf8");
    for (const expected of [
      ...settingNames,
      ...demSettingNames,
      "eip155:84532",
      "`demos`",
      "wallet-spend-testnet-authority-network-missing",
      "wallet-spend-testnet-authority-demos-network-mismatch",
      "wallet-spend-testnet-authority-demos-node-unavailable",
      "wallet-spend-testnet-authority-demos-rpc-url-refused",
      "wallet-spend-dem-absence-refused",
      "npm run dacs:authority",
      "npm run dacs:authority:policy",
      "npm run dacs:authority -- --print-witness-public-key",
      "hold-needs-operator",
      "wallet-spend-testnet-authority-setting-missing",
      "wallet-spend-testnet-authority-network-refused",
      "wallet-spend-testnet-authority-witness-key-mismatch",
      "wallet-spend-testnet-authority-listen-failed",
      "wallet-spend-continuity-policy-mismatch",
      "wallet-spend-file-witness-record-damaged",
      "wallet-spend-testnet-authority-token-invalid",
      "wallet-spend-testnet-authority-witness-seed-invalid",
      "secret-file-owner-mismatch",
    ]) {
      expect(docs, expected).toContain(expected);
    }
    const slugs = new Set(docs.split("\n")
      .filter((line) => /^#{1,6} /.test(line))
      .map((line) => line.replace(/^#+ /, "").trim().toLowerCase()
        .replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-")));
    const anchors = [...docs.matchAll(/\]\(#([^)]+)\)/g)].map((match) => match[1] ?? "");
    expect(anchors).toContain("run-the-testnet-service");
    for (const anchor of anchors) expect(slugs, anchor).toContain(anchor);
  });
});
