import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { canonicalizeDecimal } from "../../../src/canonical/decimal.js";
import { createDacsAgentProject } from "../src/index.js";

const TOTAL_DEBIT_CHECK = "pay-dem.total-debit";
const FEE_LIMIT_REASON = "pay-dem-total-debit-exceeds-network-fee-limit";

interface ProbeResult {
  status: string;
  reasonCode?: string;
}

type Probe = () => Promise<ProbeResult>;

interface TotalDebitCase {
  name: string;
  price: string;
  networkFeeLimit: string;
  maximumTotalDebit: string;
}

let projectDirectory: string;
let listingPrice = "";
let capturedProbes: Record<string, Probe> = {};
let runGeneratedDoctor: (
  phase: "pre-start",
  scope: "buy",
  operation: Readonly<{
    rail: "pay-dem";
    listingRef: string;
    maximumServiceAmount: string;
    maximumTotalDebitDem: string;
  }>,
) => Promise<unknown>;

beforeAll(async () => {
  projectDirectory = await mkdtemp(join(tmpdir(), "create-dacs-agent-doctor-"));
  await createDacsAgentProject({
    targetDirectory: join(projectDirectory, "agent"),
    mode: "live-demos",
    profile: "dacs-sdk:fixed-price-x402:v1",
    role: "buyer",
    deployment: "docker",
    rails: "pay-dem",
    install: false,
  });
  // The generated agent sits in a temporary folder, so link the workspace's installed packages for it to resolve.
  await symlink(
    fileURLToPath(new URL("../../../node_modules", import.meta.url)),
    join(projectDirectory, "agent", "node_modules"),
    "dir",
  );

  vi.doMock("@kynesyslabs/dacs", () => ({
    RAIL_REGISTRY_INDEX_ADDRESS: "registry-index",
    VERSION: "test-version",
    baseUnits: () => 0n,
    createViemX402BuyerEvmReadClient: () => undefined,
    resolveRail: async () => ({ railId: "demos-native:DEM" }),
  }));
  vi.doMock("@kynesyslabs/dacs/canonical", () => ({
    canonicalizeDecimal,
    sha256Hex: () => "",
  }));
  vi.doMock("@kynesyslabs/dacs/commerce", () => ({
    FIXED_PRICE_X402_STANDARD_REVISION: "test-revision",
  }));
  vi.doMock("@kynesyslabs/dacs/identity", () => ({
    canonicalDemosAgentPublicKey: () => "steward-public-key",
    sameCanonicalClaimIdentity: () => true,
  }));
  vi.doMock("@kynesyslabs/dacs-node", () => ({
    DACS_LIVE_DOCTOR_CHECK_IDS: [],
    DACS_NODE_CONFIG_SCHEMA_VERSION: 1,
    DACS_NODE_LIVE_PROFILE: "test-profile",
    createDacsDemosActorRuntimeV1: async () => ({
      publicKey: new Uint8Array(32),
      authority: "test-authority",
    }),
    createDacsDemosRailRegistryProviderV1: () => ({}),
    dacsLiveRailProfiles: () => ["pay-dem"],
    inspectDacsNodePackageIntegrityV1: async () => ({ status: "pass" }),
    loadDacsSecretV1: async () => new Uint8Array(32),
    resolveDacsPayDemExistingListingV1: async () => ({
      status: "verified",
      admission: { listing: { pricing: { price: { amount: listingPrice } } } },
    }),
    runDacsLiveDoctorV1: async (input: { probes: Record<string, Probe> }) => {
      capturedProbes = input.probes;
      return { checks: [] };
    },
    validateDacsAgentConfig: (config: unknown) => config,
  }));
  vi.doMock("@kynesyslabs/dacs-node/sqlite", () => ({
    DACS_NODE_SQLITE_SCHEMA_VERSION: 1,
    inspectExistingDacsNodeSqliteDatabaseV1: async () => undefined,
    openDacsNodeSqliteDatabase: async () => undefined,
  }));

  const doctorModule = await import(join(projectDirectory, "agent", "src", "doctor.ts"));
  runGeneratedDoctor = doctorModule.runGeneratedDoctor;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await rm(projectDirectory, { recursive: true, force: true });
});

async function runTotalDebitProbe(testCase: TotalDebitCase): Promise<ProbeResult> {
  listingPrice = testCase.price;
  vi.stubEnv("DACS_BUYER_AUTHORITY", "buyer-authority");
  vi.stubEnv("DACS_SELLER_AUTHORITY", "seller-authority");
  vi.stubEnv("DACS_BUYER_DEMOS_SECRET_FILE", join(projectDirectory, "buyer-secret"));
  vi.stubEnv("DACS_SELLER_DEMOS_SECRET_FILE", join(projectDirectory, "seller-secret"));
  vi.stubEnv("DACS_RAIL_STEWARD_AUTHORITY", "steward-authority");
  vi.stubEnv("DACS_BUYER_PUBLIC_BASE_URL", "https://buyer.example.test");
  vi.stubEnv("DACS_SELLER_PUBLIC_BASE_URL", "https://seller.example.test");
  vi.stubEnv("DACS_MAX_DEMOS_NETWORK_FEE_DEM", testCase.networkFeeLimit);
  vi.stubEnv("DACS_MAX_PAY_DEM_TOTAL_DEBIT", "100");
  await runGeneratedDoctor("pre-start", "buy", {
    rail: "pay-dem",
    listingRef: "listing-under-test",
    maximumServiceAmount: "10",
    maximumTotalDebitDem: testCase.maximumTotalDebit,
  });
  const probe = capturedProbes[TOTAL_DEBIT_CHECK];
  if (probe === undefined) throw new Error("total debit probe was not built");
  return probe();
}

describe("generated Doctor total-debit fee ceiling", () => {
  const passing: TotalDebitCase[] = [
    {
      name: "below the price plus fee limit with one, two and three decimals",
      price: "1.5",
      networkFeeLimit: "0.25",
      maximumTotalDebit: "1.749",
    },
    {
      name: "equal to the price plus fee limit with different scales",
      price: "1.5",
      networkFeeLimit: "0.25",
      maximumTotalDebit: "1.75",
    },
    {
      name: "equal to the price plus a fee limit with nine decimals",
      price: "1",
      networkFeeLimit: "0.000000001",
      maximumTotalDebit: "1.000000001",
    },
    {
      name: "equal to a whole-number price plus a whole-number fee limit",
      price: "3",
      networkFeeLimit: "2",
      maximumTotalDebit: "5",
    },
  ];
  const failing: TotalDebitCase[] = [
    {
      name: "one millionth above the price plus fee limit",
      price: "1.5",
      networkFeeLimit: "0.25",
      maximumTotalDebit: "1.750001",
    },
    {
      name: "one nano-unit above a whole-number price plus a nine-decimal fee limit",
      price: "1",
      networkFeeLimit: "0.000000001",
      maximumTotalDebit: "1.000000002",
    },
    {
      name: "a whole unit above a whole-number price plus fee limit",
      price: "3",
      networkFeeLimit: "2",
      maximumTotalDebit: "6",
    },
  ];

  for (const testCase of passing) {
    test(`passes when the maximum total debit is ${testCase.name}`, async () => {
      expect(await runTotalDebitProbe(testCase)).toMatchObject({
        status: "pass",
        facts: { maximumTotalDebitDem: canonicalizeDecimal(testCase.maximumTotalDebit) },
      });
    });
  }

  for (const testCase of failing) {
    test(`fails when the maximum total debit is ${testCase.name}`, async () => {
      expect(await runTotalDebitProbe(testCase)).toEqual({
        status: "fail",
        reasonCode: FEE_LIMIT_REASON,
      });
    });
  }
});
