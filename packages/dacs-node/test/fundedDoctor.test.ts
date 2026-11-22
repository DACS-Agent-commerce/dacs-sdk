import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProtocolAnchorReceipt } from "@kynesyslabs/dacs";
import { logicalToStorageProgramName } from "@kynesyslabs/dacs/canonical";
import { FIXED_PRICE_X402_STANDARD_REVISION } from "@kynesyslabs/dacs/commerce";
import {
  DemosAdapter,
  createInMemoryDemosWriteJournal,
} from "@kynesyslabs/dacs/substrate";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DACS_LIVE_DOCTOR_CHECK_IDS,
  DACS_NODE_LIVE_PROFILE,
  createDacsFundedDoctorExecutorV1,
  prepareDacsFundedDoctorV1,
  runDacsGuardedCommandV1,
  runDacsLiveDoctorV1,
  type DacsDemosActorRuntimeV1,
  type DacsLiveDoctorReportV1,
} from "../src/index.js";
import {
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const AUTHORITY = `did:demos:agent:${"33".repeat(32)}`;
const NOW = 10_000;

function prepared() {
  return prepareDacsFundedDoctorV1({
    runId: JOB_ID,
    disposableWallet: "disposable-alpha",
    walletAuthority: AUTHORITY,
    network: "demos:testnet",
    actionMaximumDebitDem: "2",
    maximumTotalDebitDem: "2",
  });
}

function receipt(): ProtocolAnchorReceipt {
  const value = prepared();
  return {
    receiptVersion: "1",
    substrate: "demos",
    finalityProfile: "demos-bft-confirmed-native-read",
    logicalAddress: value.logicalAddress,
    nativeAddress: "stor-funded-doctor",
    contentHash: value.contentHash,
    transactionRef: { kind: "demos-storage-program", value: "tx-funded-doctor" },
    writer: AUTHORITY,
    nonce: "4",
    state: "finalized",
    observationDisposition: "established",
    observedAt: NOW,
    blockRef: { id: "block-funded-doctor", height: "42", timestamp: NOW },
    evidence: { kind: "demos-bft-write-proof-v1", value: "proof-funded-doctor" },
  };
}

function runtime(overrides: Partial<DacsDemosActorRuntimeV1["adapter"]> = {}):
  Readonly<DacsDemosActorRuntimeV1> {
  const value = prepared();
  return {
    role: "buyer",
    authority: AUTHORITY,
    walletAddress: "0xdoctor",
    publicKey: Uint8Array.from({ length: 32 }, () => 0x33),
    adapter: {
      raw: {
        getNetworkInfo: async () => ({}),
        getAddressNonce: async () => 0,
        getAddressInfo: async () => ({ balance: 10_000_000_000n }),
      },
      connect: async () => undefined,
      getAddress: () => "0xdoctor",
      getPublicKey: async () => Uint8Array.from({ length: 32 }, () => 0x33),
      sign: async () => new Uint8Array(64),
      resolveIdentity: async (ref) => ({ ref, raw: {} }),
      readAnchor: async () => value.artifact,
      resolveAnchorByName: async () => ({ status: "present", address: "stor-funded-doctor" }),
      scanOwnAnchorsByNamePrefix: async () => ({ status: "ok", anchors: [] }),
      anchorWriteOnce: async () => ({
        address: "stor-funded-doctor",
        txRef: "tx-funded-doctor",
      }),
      verifyDemosAnchorReceipt: async () => true,
      resolveDemosAnchorReceipt: async () => receipt(),
      reconcileWalletJournal: async () => undefined,
      reconcileNativeTransferJournal: async () => undefined,
      ...overrides,
    },
    signTransportEnvelope: async () => new Uint8Array(64),
    signComponent: async () => new Uint8Array(64),
    networkInfo: async () => ({}),
    addressNonce: async () => 0,
    addressInfo: async () => ({ balance: 10_000_000_000n }),
  };
}

async function doctor(): Promise<Readonly<DacsLiveDoctorReportV1>> {
  return runDacsLiveDoctorV1({
    phase: "post-start",
    scope: "start",
    sdkVersion: "0.1.0-alpha.0",
    standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
    profile: DACS_NODE_LIVE_PROFILE,
    now: () => NOW,
    probes: Object.fromEntries(DACS_LIVE_DOCTOR_CHECK_IDS.map((id) => [
      id,
      () => ({ status: "pass" as const }),
    ])),
  });
}

describe("funded doctor Demos smoke", () => {
  const roots: string[] = [];
  const databases: DacsNodeSqliteDatabase[] = [];

  async function database(): Promise<DacsNodeSqliteDatabase> {
    const directory = mkdtempSync(join(tmpdir(), "dacs-funded-doctor-"));
    roots.push(directory);
    const opened = await openDacsNodeSqliteDatabase({
      databasePath: join(directory, "doctor.sqlite"),
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer",
      authority: AUTHORITY,
    });
    databases.push(opened);
    return opened;
  }

  afterEach(() => {
    for (const value of databases.splice(0)) value.close();
    for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
  });

  it("binds the exact disposable wallet, run and whole-run DEM cap", () => {
    const value = prepared();
    expect(value.plan).toMatchObject({
      kind: "funded-doctor",
      runId: JOB_ID,
      disposableWallet: "disposable-alpha",
      walletAuthority: AUTHORITY,
      network: "demos:testnet",
      debits: [{ actionId: "demos-anchor", asset: "DEM", maximumDebit: "2" }],
      ceilings: [{ asset: "DEM", maximumTotalDebit: "2" }],
    });
    expect(() => prepareDacsFundedDoctorV1({
      ...value.plan,
      actionMaximumDebitDem: "2",
      maximumTotalDebitDem: "1",
    })).toThrow(/ceiling/i);
  });

  it("publishes and verifies one exact funded smoke", async () => {
    const write = vi.fn(async () => ({
      address: "stor-funded-doctor",
      txRef: "tx-funded-doctor",
    }));
    const executor = createDacsFundedDoctorExecutorV1({
      prepared: prepared(),
      runtime: runtime({ anchorWriteOnce: write }),
    });
    const assertCurrent = vi.fn(async () => undefined);
    await expect(executor({
      plan: prepared().plan,
      consent: {
        domain: "dacs-funded-doctor-consent:v1",
        planHash: prepared().plan.planHash,
        confirmedAt: NOW,
        mechanism: "environment-and-non-interactive",
        consentHash: "a".repeat(64),
      },
      fence: {
        mode: "perform",
        effectId: prepared().plan.effectId,
        planHash: prepared().plan.planHash,
        generation: 1,
        idempotencyKey: "funded-doctor:test",
        assertCurrent,
      },
    })).resolves.toMatchObject({ status: "completed", result: { receipt: receipt() } });
    expect(write).toHaveBeenCalledTimes(1);
    expect(assertCurrent).toHaveBeenCalledTimes(3);
  });

  it("uses read-only exact-run reconciliation and never rebroadcasts an absent smoke", async () => {
    const write = vi.fn(async () => { throw new Error("ambiguous RPC"); });
    const firstExecutor = createDacsFundedDoctorExecutorV1({
      prepared: prepared(),
      runtime: runtime({ anchorWriteOnce: write }),
    });
    const db = await database();
    const options = {
      plan: prepared().plan,
      execute: true,
      database: db,
      workerId: "funded-doctor-worker",
      doctorReports: [await doctor()],
      confirmation: "1",
      nonInteractive: true,
      now: () => NOW,
    };
    await expect(runDacsGuardedCommandV1({
      ...options,
      executor: firstExecutor,
    })).resolves.toMatchObject({
      status: "reconciliation-required",
      reasonCode: "funded-doctor-reconciliation-required",
    });
    const resolveAnchorByName = vi.fn(async () => ({ status: "absent" as const }));
    const reconcileExecutor = createDacsFundedDoctorExecutorV1({
      prepared: prepared(),
      runtime: runtime({ resolveAnchorByName, anchorWriteOnce: write }),
    });
    await expect(runDacsGuardedCommandV1({
      ...options,
      executor: reconcileExecutor,
    })).resolves.toMatchObject({ status: "reconciliation-cleared" });
    expect(resolveAnchorByName).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe("funded doctor Demos smoke with the real owner lookup", () => {
  const WALLET = `0x${"33".repeat(32)}`;
  const FOREIGN_OWNER = "ee".repeat(32);
  const ADDRESS = "stor-funded-doctor";
  const PROGRAM_NAME = logicalToStorageProgramName(prepared().logicalAddress);
  const roots: string[] = [];
  const databases: DacsNodeSqliteDatabase[] = [];

  interface NativeProgram {
    owner: string;
    programName: string;
    data: unknown;
    success?: boolean;
  }

  /**
   * A real DemosAdapter whose node calls are stubbed: native programs live in a
   * map, the name index lists the addresses in `indexed`, and the write method
   * stores the exact artifact under the wallet's own address.
   */
  function fixture() {
    const journal = createInMemoryDemosWriteJournal();
    const programs = new Map<string, NativeProgram>();
    const state = { indexed: [] as string[], searchStatus: 200 };
    const search = vi.fn(async () => state.searchStatus === 200
      ? new Response(JSON.stringify({
        result: 200,
        response: state.indexed.map((storageAddress) => ({
          storageAddress,
          programName: PROGRAM_NAME,
        })),
      }))
      : new Response("", { status: state.searchStatus }));
    vi.stubGlobal("fetch", search);
    const adapter = new DemosAdapter({
      rpc: "http://127.0.0.1:5350",
      chainIdentity: "genesis-test",
      writeJournal: journal,
    });
    vi.spyOn(adapter.raw, "getAddress").mockReturnValue(WALLET);
    vi.spyOn(adapter, "getChainIdentityDetails").mockResolvedValue({
      chainId: null,
      genesisHash: "genesis-test",
      genesisDataHash: null,
      source: "genesis-read",
    });
    vi.spyOn(adapter.raw.storagePrograms, "read").mockImplementation(
      async (address: string) => {
        const program = programs.get(address);
        return {
          success: program !== undefined && program.success !== false,
          storageAddress: address,
          owner: program?.owner,
          programName: program?.programName,
          data: program?.data,
          ...(program === undefined ? { errorCode: "not_found" } : {}),
        } as never;
      },
    );
    const write = vi.spyOn(adapter, "anchorWriteOnce").mockImplementation(
      async (name, value) => {
        programs.set(ADDRESS, {
          owner: WALLET,
          programName: logicalToStorageProgramName(name),
          data: value,
        });
        state.indexed.push(ADDRESS);
        return { address: ADDRESS, txRef: "tx-funded-doctor" } as never;
      },
    );
    const receiptLookup = vi.spyOn(adapter, "resolveDemosAnchorReceipt")
      .mockResolvedValue(receipt());
    vi.spyOn(adapter, "verifyDemosAnchorReceipt").mockResolvedValue(true);
    return { adapter, journal, programs, state, search, write, receiptLookup };
  }

  function executorFor(adapter: DemosAdapter) {
    return createDacsFundedDoctorExecutorV1({
      prepared: prepared(),
      runtime: {
        ...runtime(),
        adapter: adapter as unknown as DacsDemosActorRuntimeV1["adapter"],
      },
    });
  }

  function reconcile(adapter: DemosAdapter) {
    return executorFor(adapter)({
      plan: prepared().plan,
      consent: {
        domain: "dacs-funded-doctor-consent:v1",
        planHash: prepared().plan.planHash,
        confirmedAt: NOW,
        mechanism: "environment-and-non-interactive",
        consentHash: "a".repeat(64),
      },
      fence: {
        mode: "reconcile",
        effectId: prepared().plan.effectId,
        planHash: prepared().plan.planHash,
        generation: 1,
        idempotencyKey: "funded-doctor:test",
        assertCurrent: async () => undefined,
      },
    });
  }

  async function database(): Promise<DacsNodeSqliteDatabase> {
    const directory = mkdtempSync(join(tmpdir(), "dacs-funded-doctor-"));
    roots.push(directory);
    const opened = await openDacsNodeSqliteDatabase({
      databasePath: join(directory, "doctor.sqlite"),
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer",
      authority: AUTHORITY,
    });
    databases.push(opened);
    return opened;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const value of databases.splice(0)) value.close();
    for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
  });

  it("recovers a landed smoke with the real owner lookup and retains completion", async () => {
    const { adapter, write, receiptLookup } = fixture();
    receiptLookup.mockReset();
    receiptLookup.mockResolvedValueOnce(null);
    receiptLookup.mockResolvedValue(receipt());
    const executor = executorFor(adapter);
    const options = {
      plan: prepared().plan,
      execute: true,
      database: await database(),
      workerId: "funded-doctor-worker",
      doctorReports: [await doctor()],
      confirmation: "1",
      nonInteractive: true,
      now: () => NOW,
      executor,
    };
    await expect(runDacsGuardedCommandV1(options)).resolves.toMatchObject({
      status: "reconciliation-required",
      reasonCode: "funded-doctor-receipt-unavailable",
    });
    const recovered = await runDacsGuardedCommandV1(options);
    expect(recovered).toMatchObject({
      status: "completed",
      result: { receipt: receipt() },
    });
    expect(recovered).not.toHaveProperty("absenceProofHash");
    expect(receiptLookup).toHaveBeenLastCalledWith({
      logicalAddress: prepared().logicalAddress,
      nativeAddress: ADDRESS,
      contentHash: prepared().contentHash,
      writer: AUTHORITY,
    });
    await expect(runDacsGuardedCommandV1(options)).resolves.toMatchObject({
      status: "existing-completion",
      result: { receipt: receipt() },
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("reconciles a native-visible write while the name index is empty", async () => {
    const { adapter, journal, programs, search, write } = fixture();
    programs.set(ADDRESS, {
      owner: WALLET,
      programName: PROGRAM_NAME,
      data: prepared().artifact,
    });
    const lease = await journal.acquire({ chainIdentity: "genesis-test", wallet: WALLET });
    await lease.put({
      writeId: "funded-doctor-write",
      generation: lease.generation,
      kind: "immutable",
      operation: "create",
      stage: "native-visible",
      logicalName: prepared().logicalAddress,
      programName: PROGRAM_NAME,
      owner: WALLET,
      nativeAddress: ADDRESS,
      valueHash: prepared().contentHash,
      nonce: 4,
      updatedAt: NOW,
    });
    await lease.release();
    await expect(reconcile(adapter)).resolves.toMatchObject({
      status: "reconciled-performed",
      result: { receipt: receipt() },
    });
    expect(search).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    ["genuine absence", () => undefined, "reconciled-absent"],
    ["another wallet's candidate", (value: ReturnType<typeof fixture>) => {
      value.programs.set(ADDRESS, {
        owner: FOREIGN_OWNER,
        programName: PROGRAM_NAME,
        data: prepared().artifact,
      });
      value.state.indexed.push(ADDRESS);
    }, "reconciled-absent"],
    ["an unreadable candidate", (value: ReturnType<typeof fixture>) => {
      value.programs.set(ADDRESS, {
        owner: WALLET,
        programName: PROGRAM_NAME,
        data: prepared().artifact,
        success: false,
      });
      value.state.indexed.push(ADDRESS);
    }, "reconciled-indeterminate"],
    ["a failed search", (value: ReturnType<typeof fixture>) => {
      value.state.searchStatus = 500;
    }, "reconciled-indeterminate"],
    ["a conflicting own artifact", (value: ReturnType<typeof fixture>) => {
      value.programs.set(ADDRESS, {
        owner: WALLET,
        programName: PROGRAM_NAME,
        data: { ...prepared().artifact, network: "demos:other" },
      });
      value.state.indexed.push(ADDRESS);
    }, "operator-action"],
  ])("maps %s without calling the write method", async (_name, arrange, status) => {
    const value = fixture();
    arrange(value);
    await expect(reconcile(value.adapter)).resolves.toMatchObject({ status });
    expect(value.write).not.toHaveBeenCalled();
  });
});
