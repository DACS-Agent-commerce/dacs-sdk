import { chmodSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FIXED_PRICE_X402_STANDARD_REVISION } from "@kynesyslabs/dacs/commerce";
import { afterEach, describe, expect, it } from "vitest";

import {
  DACS_NODE_LIVE_PROFILE,
  createDacsNodeLocalDoctorProbesV1,
  loadDacsSecretV1,
  runDacsLiveDoctorV1,
  type DacsLoadedSecretV1,
  type DacsNodeDoctorActorV1,
} from "../src/index.js";
import {
  DACS_NODE_SQLITE_APPLICATION_ID,
  DACS_NODE_SQLITE_SCHEMA_VERSION,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";

const BUYER = `did:demos:agent:${"a".repeat(64)}`;
const SELLER = `did:demos:agent:${"b".repeat(64)}`;
const SDK_VERSION = "0.1.0-alpha.0";

describe("built-in local doctor probes", () => {
  const roots: string[] = [];
  const secrets: DacsLoadedSecretV1[] = [];

  function root(): string {
    const value = mkdtempSync(join(tmpdir(), "dacs-local-doctor-"));
    roots.push(value);
    return value;
  }

  async function secret(name: string): Promise<DacsLoadedSecretV1> {
    const value = await loadDacsSecretV1({
      name,
      mode: "live-demos",
      secretManager: { readSecret: () => `${name}-unique-value` },
    });
    secrets.push(value);
    return value;
  }

  async function actor(
    parent: string,
    role: "buyer" | "seller",
  ): Promise<DacsNodeDoctorActorV1> {
    const directory = join(parent, role);
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
    const authority = role === "buyer" ? BUYER : SELLER;
    const diagnostics = {
      databasePath: join(directory, "actor.sqlite"),
      schemaVersion: DACS_NODE_SQLITE_SCHEMA_VERSION,
      applicationId: DACS_NODE_SQLITE_APPLICATION_ID,
      mode: "live-demos" as const,
      profile: DACS_NODE_LIVE_PROFILE,
      role,
      authority,
      sdkVersion: SDK_VERSION,
      standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
      journalMode: "wal" as const,
      synchronous: "full" as const,
      quickCheck: "ok" as const,
      filesystemMagic: 1,
    };
    const database = {
      databasePath: diagnostics.databasePath,
      metadata: {
        mode: diagnostics.mode,
        profile: diagnostics.profile,
        role,
        authority,
        sdkVersion: SDK_VERSION,
        standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
      },
      diagnostics: () => diagnostics,
    } as unknown as DacsNodeSqliteDatabase;
    return {
      role,
      config: {
        mode: "live-demos",
        profile: DACS_NODE_LIVE_PROFILE,
        role,
        dataDirectory: directory,
        demos: { rpcUrl: "http://127.0.0.1:5350" },
        rail: { registryIndexRef: "dacs4:registry:x402", requestedNetwork: "eip155:84532" },
        limits: {
          maxServiceAmount: { asset: "USDC", amount: "1" },
          maxSetupSpendDem: "10",
          maxDemosNetworkFeeDem: "1",
          maxEvmNetworkFeeEth: "0.001",
        },
      },
      database,
      secrets: {
        demosIdentity: await secret(`${role}-demos-key`),
        evmWallet: await secret(`${role}-evm-key`),
      },
    };
  }

  afterEach(() => {
    for (const value of secrets.splice(0)) value.destroy();
    for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
  });

  it("passes every built-in local check for separated production-shaped actors", async () => {
    const parent = root();
    const actors = [await actor(parent, "buyer"), await actor(parent, "seller")];
    const probes = createDacsNodeLocalDoctorProbesV1({
      actors,
      nodeVersion: "v22.12.0",
      minimumFreeBytes: 1,
      transportIdentities: () => ({ status: "pass" }),
      deploymentRuntime: () => ({ status: "pass" }),
    });
    const report = await runDacsLiveDoctorV1({
      phase: "pre-start",
      scope: "start",
      sdkVersion: SDK_VERSION,
      standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
      profile: DACS_NODE_LIVE_PROFILE,
      probes,
    });
    for (const check of report.checks.filter((item) => item.id.startsWith("local."))) {
      expect(check.status, check.id).toBe("pass");
    }
  });

  it("fails closed on shared secret material and unsafe actor directories", async () => {
    const parent = root();
    const buyer = await actor(parent, "buyer");
    const seller = await actor(parent, "seller");
    seller.secrets = { ...seller.secrets, evmWallet: buyer.secrets.evmWallet };
    chmodSync((buyer.config as { dataDirectory: string }).dataDirectory, 0o755);
    const probes = createDacsNodeLocalDoctorProbesV1({ actors: [buyer, seller] });
    expect(probes["local.secrets"]!({} as never)).toMatchObject({
      status: "fail",
      reasonCode: "role-secret-reused",
    });
    await expect(probes["local.data-directory"]!({} as never)).resolves.toMatchObject({
      status: "fail",
      reasonCode: "data-directory-permissions-unsafe",
    });
  });

  it("blocks missing external transport and deployment capabilities", async () => {
    const parent = root();
    const probes = createDacsNodeLocalDoctorProbesV1({
      actors: [await actor(parent, "buyer"), await actor(parent, "seller")],
    });
    const report = await runDacsLiveDoctorV1({
      phase: "pre-start",
      scope: "start",
      sdkVersion: SDK_VERSION,
      standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
      profile: DACS_NODE_LIVE_PROFILE,
      probes,
    });
    expect(report.checks.find((item) => item.id === "local.transport-identities"))
      .toMatchObject({ status: "blocked", reasonCode: "probe-not-configured" });
    expect(report.checks.find((item) => item.id === "local.deployment-runtime"))
      .toMatchObject({ status: "blocked", reasonCode: "probe-not-configured" });
  });
});
