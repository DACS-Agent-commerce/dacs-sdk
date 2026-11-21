import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  WalletSpendAuthorityV1,
  WalletSpendPermitV1,
  WalletSpendStateV1,
} from "@kynesyslabs/dacs";
import { sha256Hex } from "@kynesyslabs/dacs/canonical";

import type { DacsWalletSpendFileAuthorityStoresV1 } from "../src/walletSpendFileAuthorityStores.js";
import { createDacsWalletSpendContinuityAuthorityV2 } from "../src/walletSpendPostgres.js";
import {
  createDacsRemoteWalletSpendAuthorityV2,
  createDacsWalletSpendAuthorityServiceV2,
  createInMemoryDacsWalletSpendRemoteOperationStoreV1,
  type DacsWalletSpendRemoteOperationStoreV1,
} from "../src/walletSpendRemote.js";
import {
  STORES_AUTHORITY_ID,
  STORES_EPOCH,
  openTestStores,
  privateRoot,
  removeRoot,
  stateFileNames,
  storesPolicy,
  storesReservation,
  witnessReceipts,
} from "./helpers/walletSpendFileAuthorityStores.js";

/**
 * Where the running service stops. A stopped service makes no further file
 * reads or writes and sends no answer, as a killed process would.
 */
type StopPoint =
  | "before-witness-record"
  | "after-witness-record"
  | "during-state-write"
  | "after-claim"
  | "before-answer"
  | "before-send";

const stop = vi.hoisted(() => ({
  point: undefined as string | undefined,
  operation: undefined as string | undefined,
  stopped: false,
  halt(): never {
    stop.stopped = true;
    throw new Error("service stopped");
  },
}));

vi.mock("../src/walletSpendFileRecords.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/walletSpendFileRecords.js")>();
  const running = (): void => {
    if (stop.stopped) throw new Error("service stopped");
  };
  return {
    ...actual,
    async readRecord(path: string, maximumBytes: number) {
      running();
      return actual.readRecord(path, maximumBytes);
    },
    async createRecordExclusive(path: string, value: unknown) {
      running();
      if (stop.point === "before-witness-record") stop.halt();
      const created = await actual.createRecordExclusive(path, value);
      if (stop.point === "after-witness-record") stop.halt();
      return created;
    },
    async replaceRecord(path: string, value: unknown) {
      running();
      if (stop.point === "during-state-write") {
        writeFileSync(`${path}.${process.pid}.interrupted.tmp`, "{\"generation\":", { mode: 0o600 });
        stop.halt();
      }
      return actual.replaceRecord(path, value);
    },
  };
});

const TOKEN = "role-scoped-test-token-which-is-long-enough";
const ENDPOINT = "http://127.0.0.1:8080/";
const LEASE_MS = 300_000;
const START_MS = 1_000;

interface SentRequest {
  operation: string;
  operationId: string;
  text: string;
}

interface Running {
  stores: Readonly<DacsWalletSpendFileAuthorityStoresV1>;
  handler: (request: Request) => Promise<Response>;
}

let root: string;
let directory: string;
let clock: { now: number };
let running: Running | undefined;
let sent: SentRequest[];

beforeEach(() => {
  root = privateRoot();
  directory = join(root, "authority");
  clock = { now: START_MS };
  running = undefined;
  sent = [];
  Object.assign(stop, { point: undefined, operation: undefined, stopped: false });
});

afterEach(async () => {
  await running?.stores.close();
  removeRoot(root);
});

/** Stops the service at `point` during the next operation of the named kind. */
function stopAt(point: StopPoint, operation = "reserve"): void {
  Object.assign(stop, { point, operation });
}

function stopsHere(point: StopPoint, operation: string): boolean {
  return stop.point === point && stop.operation === operation;
}

function watchedOperations(): DacsWalletSpendRemoteOperationStoreV1 {
  const operations = createInMemoryDacsWalletSpendRemoteOperationStoreV1();
  const operationOf = async (input: Readonly<{ roleId: string; operationId: string }>) =>
    (await operations.load(input))?.request.operation;
  return {
    load: (input) => operations.load(input),
    async claim(input) {
      const claimed = await operations.claim(input);
      if (stopsHere("after-claim", input.request.operation)) stop.halt();
      return claimed;
    },
    async complete(input) {
      const operation = await operationOf(input);
      if (operation !== undefined && stopsHere("before-answer", operation)) stop.halt();
      await operations.complete(input);
    },
  };
}

/** Opens the data directory with a new, empty operation log, as a fresh process would. */
async function start(): Promise<Running> {
  Object.assign(stop, { point: undefined, operation: undefined, stopped: false });
  const policy = storesPolicy();
  const stores = await openTestStores(directory);
  const handler = createDacsWalletSpendAuthorityServiceV2({
    authenticate: (token) => token === TOKEN ? "buyer" : null,
    resolveAuthority: ({ roleId, operationId, requestHash, authorityId, epoch, lineageKey }) =>
      roleId === "buyer" && authorityId === STORES_AUTHORITY_ID && epoch === STORES_EPOCH &&
        lineageKey === stores.lineageKey
        ? createDacsWalletSpendContinuityAuthorityV2({
          policy,
          store: stores.stateStore({ roleId, operationId, requestHash }),
          dependencies: {
            readBalance: async () => "1000",
            authenticateRecovery: async () => true,
            owner: "file-authority-service",
            leaseDurationMs: LEASE_MS,
            now: () => clock.now,
          },
        })
        : null,
    operations: watchedOperations(),
  });
  running = { stores, handler };
  return running;
}

/** Drops the running service without closing it and starts a new one over the same directory. */
async function restart(): Promise<Running> {
  running = undefined;
  return start();
}

const serviceFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const service = running;
  if (service === undefined || stop.stopped) throw new TypeError("fetch failed");
  const request = new Request(input, init);
  let operation: string | undefined;
  if (request.method === "POST") {
    const text = await request.clone().text();
    const body = JSON.parse(text) as { operation: string; operationId: string };
    operation = body.operation;
    sent.push({ operation, operationId: body.operationId, text });
  }
  const response = await service.handler(request);
  if (operation !== undefined && stopsHere("before-send", operation)) stop.halt();
  if (stop.stopped) throw new TypeError("fetch failed");
  return response;
}) as typeof fetch;

async function client(): Promise<Readonly<WalletSpendAuthorityV1>> {
  const tokenFilePath = join(root, "token");
  writeFileSync(tokenFilePath, `${TOKEN}\n`, { mode: 0o600 });
  chmodSync(tokenFilePath, 0o600);
  const service = running ?? await start();
  return createDacsRemoteWalletSpendAuthorityV2({
    policy: storesPolicy(), endpoint: ENDPOINT, tokenFilePath,
    authorityId: STORES_AUTHORITY_ID, epoch: STORES_EPOCH,
    witnessVerificationKey: service.stores.verificationKey,
    allowInsecureLoopback: true, fetch: serviceFetch,
  });
}

function lastSent(operation: string): SentRequest {
  const found = sent.filter((request) => request.operation === operation).at(-1);
  if (found === undefined) throw new Error(`expected a sent ${operation} request`);
  return found;
}

/** Sends the exact bytes of an earlier request again, straight to the running service. */
async function resend(request: SentRequest): Promise<{
  status: number;
  body: { revision: number; result: unknown };
}> {
  if (running === undefined) throw new Error("expected a running service");
  const response = await running.handler(new Request(new URL("v2/wallet-spend/operations", ENDPOINT), {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: request.text,
  }));
  return { status: response.status, body: await response.json() as { revision: number; result: unknown } };
}

async function headState(): Promise<WalletSpendStateV1> {
  if (running === undefined) throw new Error("expected a running service");
  const state = await running.stores.stateStore().read?.(running.stores.lineageKey);
  if (state === undefined || state === null) throw new Error("expected a readable state");
  return state;
}

function recordsFor(operationId: string): number {
  return witnessReceipts(directory).filter((receipt) => receipt.operationId === operationId).length;
}

async function reserved(authority: Readonly<WalletSpendAuthorityV1>): Promise<WalletSpendPermitV1> {
  const claim = await authority.reserve(storesReservation());
  if (claim.status !== "reserved") throw new Error(`expected reserved, got ${claim.status}`);
  return claim.permit;
}

/** One reservation row, and one witness record written for the one reserve that ran. */
async function expectOneAuthorization(): Promise<void> {
  expect((await headState()).reservations).toHaveLength(1);
  const reserves = sent.filter((request) => request.operation === "reserve");
  expect(reserves.map(({ operationId }) => recordsFor(operationId)).reduce((a, b) => a + b, 0))
    .toBe(1);
}

const settledObservation = {
  disposition: "settled" as const,
  evidenceHash: "d".repeat(64),
  debits: [{ asset: "ASSET", purpose: "service" as const, amount: "25" }],
};

const absentObservation = { disposition: "terminal-absent" as const, evidenceHash: "e".repeat(64) };

const heldClaim = (claim: unknown) =>
  expect(claim).toMatchObject({ status: "held", stage: "reserved" });

const outcomeUnknown = { reasonCode: "wallet-spend-authority-outcome-unknown" };

describe("file-backed authority across restarts", () => {
  it("answers held after a restart for a recorded hold and releases it only through recovery", async () => {
    const authority = await client();
    await reserved(authority);
    const request = lastSent("reserve");
    const recordsBefore = witnessReceipts(directory).length;
    const revisionBefore = (await headState()).generation;

    await restart();
    const repeated = await resend(request);
    expect(repeated.status).toBe(200);
    heldClaim(repeated.body.result);
    expect(repeated.body.revision).toBe(revisionBefore);
    expect(witnessReceipts(directory)).toHaveLength(recordsBefore);
    expect((await headState()).reservations).toHaveLength(1);

    heldClaim(await authority.reserve(storesReservation()));
    await expect(authority.reserve(storesReservation("file-two"))).resolves.toEqual({
      status: "denied", reason: "concurrency-limit",
    });

    clock.now = START_MS + LEASE_MS + 1;
    await expect(authority.reconcile(storesReservation(), absentObservation))
      .resolves.toBe("released");
    await expect(authority.reserve(storesReservation("file-two"))).resolves.toMatchObject({
      status: "reserved",
    });
  });

  it("a full purchase survives restarts between every step", async () => {
    const authority = await client();
    const permit = await reserved(authority);
    await restart();
    await permit.beginEffect();
    await restart();
    await expect(authority.reconcile(storesReservation(), settledObservation))
      .resolves.toBe("settled");
    await restart();

    const status = await authority.inspect();
    expect(status.activeEffects).toBe(0);
    expect(status.assets[0]?.cumulativeSettledDebit).toBe("25");
  });
});

describe("no crash point leads to a second authorization", () => {
  it("a stop after the state file and before the witness record keeps the old head and removes the candidate", async () => {
    const authority = await client();
    stopAt("before-witness-record");
    await expect(authority.reserve(storesReservation())).rejects.toMatchObject({
      reasonCode: "wallet-spend-authority-outcome-unknown",
    });
    expect(stateFileNames(directory)).toHaveLength(2);

    await restart();
    expect(witnessReceipts(directory)).toHaveLength(1);
    expect(stateFileNames(directory)).toEqual([`${witnessReceipts(directory)[0]?.stateHash}.json`]);
    const first = await resend(lastSent("reserve"));
    expect(first.body.result).toMatchObject({ status: "reserved" });
    await expectOneAuthorization();
  });

  it("a stop after the witness record and before the state switch loads the new head and answers held", async () => {
    const authority = await client();
    stopAt("after-witness-record");
    await expect(authority.reserve(storesReservation())).rejects.toMatchObject({
      reasonCode: "wallet-spend-authority-outcome-unknown",
    });

    await restart();
    expect(witnessReceipts(directory)).toHaveLength(2);
    heldClaim((await resend(lastSent("reserve"))).body.result);
    heldClaim(await authority.reserve(storesReservation()));
    await expectOneAuthorization();
  });

  it("a stop after the claim and before the operation runs leaves nothing to answer", async () => {
    const authority = await client();
    stopAt("after-claim");
    await expect(authority.reserve(storesReservation())).rejects.toMatchObject({
      reasonCode: "wallet-spend-authority-outcome-unknown",
    });
    const lost = lastSent("reserve");

    const service = await restart();
    const query = await service.handler(new Request(
      new URL(`v2/wallet-spend/operations/${lost.operationId}?requestHash=${sha256Hex(lost.text)}`, ENDPOINT),
      { headers: { authorization: `Bearer ${TOKEN}` } },
    ));
    expect(query.status).toBe(404);
    await expect(query.json()).resolves.toEqual({
      reasonCode: "wallet-spend-authority-operation-missing",
    });
    expect((await headState()).reservations).toEqual([]);
    expect(recordsFor(lost.operationId)).toBe(0);

    await reserved(authority);
    await expectOneAuthorization();
  });

  it("a stop after a reserve changed state and before it was answered answers held", async () => {
    const authority = await client();
    stopAt("before-answer", "reserve");
    await expect(authority.reserve(storesReservation())).rejects.toMatchObject({
      reasonCode: "wallet-spend-authority-outcome-unknown",
    });

    await restart();
    heldClaim((await resend(lastSent("reserve"))).body.result);
    heldClaim(await authority.reserve(storesReservation()));
    await expectOneAuthorization();
  });

  it("a stop after begin changed state and before it was answered runs begin again as a no-op", async () => {
    const authority = await client();
    const permit = await reserved(authority);
    stopAt("before-answer", "begin");
    await expect(permit.beginEffect()).rejects.toMatchObject(outcomeUnknown);
    const begin = lastSent("begin");

    await restart();
    expect((await resend(begin)).status).toBe(200);
    expect(recordsFor(begin.operationId)).toBe(1);
    expect((await headState()).reservations[0]?.stage).toBe("effect-pending");
    await expectOneAuthorization();
  });

  it("a stop after settle changed state and before it was answered counts the debit once", async () => {
    const authority = await client();
    const permit = await reserved(authority);
    await permit.beginEffect();
    stopAt("before-answer", "settle");
    await expect(permit.settle(settledObservation)).rejects.toMatchObject(outcomeUnknown);
    const settle = lastSent("settle");

    await restart();
    expect((await resend(settle)).status).toBe(200);
    expect(recordsFor(settle.operationId)).toBe(1);
    expect((await headState()).totals[0]?.cumulativeDebit).toBe("25");
    await expectOneAuthorization();
  });

  it("a stop after a release changed state and before it was answered answers existing", async () => {
    const authority = await client();
    await reserved(authority);
    clock.now = START_MS + LEASE_MS + 1;
    stopAt("before-answer", "reconcile");
    await expect(authority.reconcile(storesReservation(), absentObservation))
      .rejects.toMatchObject(outcomeUnknown);
    const release = lastSent("reconcile");

    await restart();
    expect((await resend(release)).body.result).toBe("existing");
    expect(recordsFor(release.operationId)).toBe(1);
    expect((await headState()).reservations[0]?.stage).toBe("released");
    await expectOneAuthorization();
  });

  it("a stop after the answer was stored and before it was sent answers held", async () => {
    const authority = await client();
    stopAt("before-send", "reserve");
    await expect(authority.reserve(storesReservation())).rejects.toMatchObject({
      reasonCode: "wallet-spend-authority-outcome-unknown",
    });

    await restart();
    heldClaim((await resend(lastSent("reserve"))).body.result);
    await expectOneAuthorization();
  });

  it("a stop during a state write leaves a temporary file that the next start ignores", async () => {
    const authority = await client();
    stopAt("during-state-write");
    await expect(authority.reserve(storesReservation())).rejects.toMatchObject({
      reasonCode: "wallet-spend-authority-outcome-unknown",
    });

    await restart();
    expect(stateFileNames(directory).filter((name) => name.endsWith(".tmp"))).toHaveLength(1);
    expect(witnessReceipts(directory)).toHaveLength(1);
    expect((await headState()).reservations).toEqual([]);
    expect((await resend(lastSent("reserve"))).body.result).toMatchObject({ status: "reserved" });
    await expectOneAuthorization();
  });
});
