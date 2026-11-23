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

let adapterCount = 0;

/**
 * Each adapter gets its own node address. The adapter queues wallet writes per
 * node address and wallet, and separate processes never share that queue.
 */
function nextRpc(): string {
  adapterCount += 1;
  return `http://127.0.0.1:${5400 + adapterCount}`;
}

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

  it("clears an absent smoke by read-only reconciliation without calling the write method", async () => {
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
      rpc: nextRpc(),
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

describe("funded doctor Demos smoke resumed under the same run ID", () => {
  const WALLET = `0x${"33".repeat(32)}`;
  const roots: string[] = [];
  const databases: DacsNodeSqliteDatabase[] = [];

  /**
   * One wallet on one chain, seen by every process in a scenario. The write
   * journal is the only state the processes share besides the chain. A
   * process that broadcast during the first run saw no inclusion, or no native
   * read, before its deadline; the flags flip once that run is over.
   */
  function world(first: {
    included: boolean;
    readable: boolean;
    signs: boolean;
  }) {
    const state = {
      ...first,
      journal: createInMemoryDemosWriteJournal(),
      signed: [] as string[],
      broadcast: [] as string[],
      writeCalls: 0,
      payloads: new Map<string, { payload: Record<string, unknown>; nonce: number }>(),
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      result: 200,
      response: [],
    }))));
    return {
      state,
      /** The first run is over: later reads and broadcasts land at once. */
      land() {
        state.included = true;
        state.readable = true;
        state.signs = true;
      },
    };
  }

  type World = ReturnType<typeof world>;

  /** A real adapter for one process, with its node calls answered by the world. */
  async function startProcess(value: World, options: { deadlineMs?: number } = {}) {
    const { state } = value;
    const adapter = new DemosAdapter({
      rpc: nextRpc(),
      chainIdentity: "genesis-test",
      writeJournal: state.journal,
    });
    vi.spyOn(adapter, "getChainIdentityDetails").mockResolvedValue({
      chainId: null,
      genesisHash: "genesis-test",
      genesisDataHash: null,
      source: "genesis-read",
    });
    const { raw } = adapter;
    vi.spyOn(raw, "connect").mockResolvedValue(undefined as never);
    vi.spyOn(raw, "getAddress").mockReturnValue(WALLET);
    vi.spyOn(raw, "getAddressNonce").mockImplementation(
      async () => state.signed.length as never,
    );
    vi.spyOn(raw.storagePrograms, "sign").mockImplementation(
      async (...args: unknown[]) => {
        if (!state.signs) throw new Error("signer unavailable");
        const payload = args[0] as Record<string, unknown>;
        const nonce = (args[1] as { nonce: number }).nonce;
        const hash = `tx-${state.signed.length + 1}`;
        state.signed.push(hash);
        state.payloads.set(hash, { payload, nonce });
        return {
          hash,
          content: {
            type: "storageProgram",
            from: WALLET,
            to: payload.storageAddress,
            nonce,
            data: ["storageProgram", payload],
          },
        } as never;
      },
    );
    vi.spyOn(raw.tx, "confirm").mockImplementation(
      async (...args: unknown[]) => ({
        response: { data: { transaction: { hash: (args[0] as { hash: string }).hash } } },
      }) as never,
    );
    vi.spyOn(raw.tx, "broadcast").mockImplementation(
      async (...args: unknown[]) => {
        const hash = (args[0] as {
          response: { data: { transaction: { hash: string } } };
        }).response.data.transaction.hash;
        state.broadcast.push(hash);
        return { result: 200, response: { hash } } as never;
      },
    );
    // While a write is pending the node answers `pending` and has no row yet.
    vi.spyOn(raw, "nodeCall").mockImplementation(
      async (...args: unknown[]) => {
        if (args[0] === "getAddressNonce") return state.signed.length as never;
        if (args[0] === "getLastBlockNumber") return 42 as never;
        const hash = (args[1] as { hash: string }).hash;
        return (state.included && state.payloads.has(hash)
          ? { state: "included", blockNumber: 42 }
          : { state: "pending" }) as never;
      },
    );
    vi.spyOn(raw, "getTxByHash").mockImplementation(
      async (...args: unknown[]) => {
        const hash = args[0] as string;
        const signed = state.payloads.get(hash);
        if (!state.included || signed === undefined) return null as never;
        return {
          hash,
          status: "confirmed",
          blockNumber: 42,
          content: {
            type: "storageProgram",
            from: WALLET,
            to: signed.payload.storageAddress,
            nonce: signed.nonce,
            data: ["storageProgram", signed.payload],
          },
        } as never;
      },
    );
    vi.spyOn(raw, "getBlockByNumber").mockImplementation(
      async (...args: unknown[]) => ({
        number: args[0],
        hash: `block-${String(args[0])}`,
        status: "confirmed",
        content: {
          timestamp: 120,
          ordered_transactions: [...state.broadcast],
        },
        validation_data: { signatures: ["validator-test-signature"] },
      }) as never,
    );
    // A read that is not answered before the deadline never returns.
    vi.spyOn(raw.storagePrograms, "read").mockImplementation(
      async (...args: unknown[]) => {
        if (!state.readable) return new Promise<never>(() => undefined);
        const address = args[0] as string;
        const entry = [...state.payloads.entries()].reverse()
          .find(([, item]) => item.payload.storageAddress === address);
        if (entry === undefined) {
          throw Object.assign(new Error("not found"), { response: { status: 404 } });
        }
        const [hash, { payload }] = entry;
        return {
          success: true,
          storageAddress: address,
          owner: WALLET,
          programName: payload.programName,
          data: payload.data,
          metadata: payload.metadata,
          createdByTx: hash,
          lastModifiedByTx: hash,
          interactionTxs: [hash],
        } as never;
      },
    );
    vi.spyOn(adapter, "verifyDemosAnchorReceipt").mockResolvedValue(true);
    await adapter.connect();
    const write = adapter.anchorWriteOnce.bind(adapter);
    vi.spyOn(adapter, "anchorWriteOnce").mockImplementation(
      async (name, data, writeOptions) => {
        state.writeCalls += 1;
        return write(name, data, options.deadlineMs === undefined
          ? writeOptions
          : { ...writeOptions, timeoutMs: options.deadlineMs, pollMs: 1 });
      },
    );
    return adapter;
  }

  /** The write journal's records, as `writeId:stage`. */
  async function journalStages(value: World): Promise<string[]> {
    const lease = await value.state.journal.acquire({
      chainIdentity: "genesis-test",
      wallet: WALLET,
    });
    try {
      return lease.snapshot.records.map((record) => `${record.writeId}:${record.stage}`);
    } finally {
      await lease.release();
    }
  }

  async function runs() {
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
    const options = {
      plan: prepared().plan,
      execute: true,
      database: opened,
      workerId: "funded-doctor-worker",
      doctorReports: [await doctor()],
      confirmation: "1",
      nonInteractive: true,
      now: () => NOW,
    };
    return {
      database: opened,
      /** One invocation of the command, in a process that has just started. */
      invoke: (adapter: DemosAdapter) => runDacsGuardedCommandV1({
        ...options,
        executor: createDacsFundedDoctorExecutorV1({
          prepared: prepared(),
          runtime: {
            ...runtime(),
            adapter: adapter as unknown as DacsDemosActorRuntimeV1["adapter"],
          },
        }),
      }),
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const value of databases.splice(0)) value.close();
    for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
  });

  it("returns an absent run to performable state under the same run ID", async () => {
    const scenario = world({ included: false, readable: true, signs: false });
    const { database: db, invoke } = await runs();
    await expect(invoke(await startProcess(scenario, { deadlineMs: 60 })))
      .resolves.toMatchObject({ status: "reconciliation-required" });
    expect(scenario.state.writeCalls).toBe(1);
    scenario.land();
    await expect(invoke(await startProcess(scenario)))
      .resolves.toMatchObject({ status: "reconciliation-cleared" });
    expect(db.loadEffect("payment", prepared().plan.effectId)).toMatchObject({
      state: "intent",
      absenceProofHash: expect.any(String),
    });
    expect(scenario.state.writeCalls).toBe(1);
    await expect(invoke(await startProcess(scenario)))
      .resolves.toMatchObject({ status: "completed" });
    expect(scenario.state.writeCalls).toBe(2);
  });

  it("resumes a smoke that landed after the first run gave up without a second broadcast", async () => {
    const scenario = world({ included: false, readable: true, signs: true });
    const { invoke } = await runs();
    await expect(invoke(await startProcess(scenario, { deadlineMs: 60 })))
      .resolves.toMatchObject({ status: "reconciliation-required" });
    expect(await journalStages(scenario)).toEqual(["write-1:broadcast-intent"]);
    scenario.land();
    await expect(invoke(await startProcess(scenario)))
      .resolves.toMatchObject({ status: "reconciliation-cleared" });
    const resumed = await invoke(await startProcess(scenario));
    expect(resumed).toMatchObject({
      status: "completed",
      result: { receipt: { transactionRef: { value: "tx-1" } } },
    });
    expect(scenario.state.signed).toEqual(["tx-1"]);
    expect(scenario.state.broadcast).toEqual(["tx-1"]);
    await expect(invoke(await startProcess(scenario)))
      .resolves.toMatchObject({ status: "existing-completion" });
    expect(scenario.state.broadcast).toEqual(["tx-1"]);
  });

  it("resumes a smoke confirmed before its native read without a second broadcast", async () => {
    const scenario = world({ included: true, readable: false, signs: true });
    const { invoke } = await runs();
    await expect(invoke(await startProcess(scenario, { deadlineMs: 60 })))
      .resolves.toMatchObject({ status: "reconciliation-required" });
    expect(await journalStages(scenario)).toEqual(["write-1:canonical-confirmed"]);
    scenario.land();
    await expect(invoke(await startProcess(scenario)))
      .resolves.toMatchObject({ status: "reconciliation-cleared" });
    await expect(invoke(await startProcess(scenario))).resolves.toMatchObject({
      status: "completed",
      result: { receipt: { transactionRef: { value: "tx-1" } } },
    });
    expect(scenario.state.broadcast).toEqual(["tx-1"]);
  });

  it("performs the one create when the first run never signed", async () => {
    const scenario = world({ included: false, readable: true, signs: false });
    const { invoke } = await runs();
    await expect(invoke(await startProcess(scenario, { deadlineMs: 60 })))
      .resolves.toMatchObject({ status: "reconciliation-required" });
    expect(await journalStages(scenario)).toEqual(["write-1:prepared"]);
    expect(scenario.state.signed).toEqual([]);
    scenario.land();
    await expect(invoke(await startProcess(scenario)))
      .resolves.toMatchObject({ status: "reconciliation-cleared" });
    await expect(invoke(await startProcess(scenario))).resolves.toMatchObject({
      status: "completed",
      result: { receipt: { transactionRef: { value: "tx-1" } } },
    });
    expect(scenario.state.signed).toEqual(["tx-1"]);
    expect(scenario.state.broadcast).toEqual(["tx-1"]);
  });
});
