import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PayDemRail } from "@kynesyslabs/dacs";
import {
  createFixedPricePayDemBuyerCoordinator,
  FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
  FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
  FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
  type FixedPricePayDemProtocolBinding,
} from "@kynesyslabs/dacs/commerce";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DACS_NODE_LIVE_PROFILE } from "../src/config.js";
import {
  createDacsPayDemBuyerPaymentTrackV1,
  type DacsPayDemBuyerPaymentAuthorityV1,
} from "../src/payDemPayment.js";
import {
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER = "did:example:pay-dem-buyer";
const SELLER = "did:example:pay-dem-seller";
const PAYER = "1".repeat(64);
const PAYEE = "2".repeat(64);
const TX_HASH = "3".repeat(64);

const PROTOCOL: FixedPricePayDemProtocolBinding = {
  commerceProfile: FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
  standardRevision: FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
  phase: "pay-dem",
  orchestratorTopology: "seller-as-phase-orchestrator-v1",
  orchestrator: SELLER,
  rail: {
    registryIndexRef: FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
    registryIndexHash: "4".repeat(64),
    railDefinitionRef: "dacs4:rail:demos-native%3ADEM:1",
    railDefinitionHash: "5".repeat(64),
    railId: "demos-native:DEM",
    railVersion: 1,
    railType: "demos-native",
    phaseHandler: "pay-dem",
    network: "demos",
    availability: "live",
  },
};

const AUTHORITY: DacsPayDemBuyerPaymentAuthorityV1 = {
  authorityVersion: "1",
  jobId: JOB_ID,
  phaseIndex: 2,
  railId: PROTOCOL.rail.railId,
  railVersion: PROTOCOL.rail.railVersion,
  railDescriptorHash: PROTOCOL.rail.railDefinitionHash,
  network: "demos",
  payer: PAYER,
  payee: PAYEE,
  amountOs: "1000000000",
  maxTotalDebitOs: "2000000000",
  agreementHash: "6".repeat(64),
  termsHash: "7".repeat(64),
  payoutBindingHash: "8".repeat(64),
};

interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

function exitOf(child: ChildProcess): Promise<ChildExit> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function killProcessGroup(child: ChildProcess): void {
  if (child.pid === undefined) throw new Error("crash fixture has no process id");
  if (process.platform === "win32") {
    child.kill("SIGKILL");
    return;
  }
  process.kill(-child.pid, "SIGKILL");
}

async function waitForPreparedCheckpoint(
  readyPath: string,
  child: ChildProcess,
  output: () => string,
): Promise<void> {
  // A fresh nested Vitest transform can be slow on a saturated CI runner.
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      if (await readFile(readyPath, "utf8") === "prepared") return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `crash fixture exited before its checkpoint: code=${String(child.exitCode)} ` +
          `signal=${String(child.signalCode)} ${output()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for prepared checkpoint: ${output()}`);
}

function crashFixtureEnvironment(
  databasePath: string,
  readyPath: string,
): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  // This is a new Vitest controller, not a descendant worker of the outer test.
  // Inheriting the outer worker markers can make the nested controller exit
  // without running its selected fixture when the full suite is concurrent.
  for (const name of [
    "VITEST",
    "VITEST_POOL_ID",
    "VITEST_WORKER_ID",
    "VITEST_VM_POOL",
  ]) {
    delete environment[name];
  }
  environment.DACS_PAY_DEM_CRASH_DATABASE = databasePath;
  environment.DACS_PAY_DEM_CRASH_READY = readyPath;
  return environment;
}

describe("native DEM process recovery", () => {
  const roots: string[] = [];
  const databases: DacsNodeSqliteDatabase[] = [];
  const children: ChildProcess[] = [];

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          killProcessGroup(child);
        } catch {
          // The process may have exited between the state check and the signal.
        }
      }
    }
    for (const database of databases.splice(0)) database.close();
    await Promise.all(
      roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("reconciles a prepared transfer after SIGKILL without settling again", async () => {
    const root = await mkdtemp(join(tmpdir(), "dacs-node-pay-dem-process-"));
    roots.push(root);
    const databasePath = join(root, "buyer.sqlite");
    const readyPath = join(root, "prepared.ready");
    const packageRoot = fileURLToPath(new URL("../", import.meta.url));
    const child = spawn(
      process.execPath,
      [
        join(packageRoot, "../../node_modules/vitest/vitest.mjs"),
        "run",
        "test/fixtures/payDemPaymentCrash.test.ts",
        "--config",
        "vitest.config.ts",
        "--pool=forks",
        "--maxWorkers=1",
        "--reporter=dot",
      ],
      {
        cwd: packageRoot,
        detached: process.platform !== "win32",
        env: crashFixtureEnvironment(databasePath, readyPath),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-8_192);
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8_192);
    });
    const childExit = exitOf(child);

    await waitForPreparedCheckpoint(
      readyPath,
      child,
      () => `stdout=${stdout} stderr=${stderr}`,
    );
    killProcessGroup(child);
    const exited = await childExit;
    expect(exited).toEqual({ code: null, signal: "SIGKILL" });

    // Both the outer coordinator lease and the inner irreversible-effect lease
    // were held by the dead process. Let them expire before the new worker claims
    // a strictly newer generation from the same durable database.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const database = await openDacsNodeSqliteDatabase({
      databasePath,
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer",
      authority: BUYER,
    });
    databases.push(database);
    const settle: PayDemRail["settle"] = vi.fn(async () => {
      throw new Error("settle must not run during process recovery");
    });
    const reconcile = vi.fn(async ({ prepared }) => {
      expect(prepared).toEqual(expect.objectContaining({
        txHash: TX_HASH,
        nonce: 9,
        payer: PAYER,
        payee: PAYEE,
        amountOs: AUTHORITY.amountOs,
        denomination: "os",
        network: "demos",
        maxTotalDebitOs: AUTHORITY.maxTotalDebitOs,
      }));
      return {
        status: "completed" as const,
        settlement: {
          ok: true as const,
          txHash: TX_HASH,
          chainId: "demos",
          payer: PAYER,
          payee: PAYEE,
          finality: { model: "bft-final" as const },
          blockNumber: 43,
          txRefKind: "demos" as const,
          amountOs: AUTHORITY.amountOs,
        },
      };
    });
    const publishNotice = vi.fn();
    const payment = createDacsPayDemBuyerPaymentTrackV1({
      database,
      workerId: "buyer-payment-after-kill",
      rail: { address: PAYER, settle },
      resolveAuthority: () => AUTHORITY,
      reconcile,
      publishNotice,
      // The dead fixture's 100 ms lease has already expired. Give the recovery
      // worker enough time to finish even when a loaded CI runner pauses it.
      effectLeaseDurationMs: 5_000,
      retryDelayMs: 1,
    });
    const coordinator = createFixedPricePayDemBuyerCoordinator({
      store: database.createPayDemCoordinatorStore("buyer"),
      workerId: "buyer-coordinator-after-kill",
      operations: { payment },
      leaseDurationMs: 5_000,
    });

    await coordinator.runPending({ limit: 1 });

    expect(settle).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(publishNotice).toHaveBeenCalledTimes(1);
    expect(await coordinator.getOrderStatus(JOB_ID)).toMatchObject({
      tracks: {
        agreement: { state: "final", outcome: "success" },
        payment: { state: "final", outcome: "success" },
      },
    });
  }, 75_000);
});
