import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  WalletSpendAuthorityV1,
  WalletSpendPolicyV1,
  WalletSpendRecoveryObservationV1,
  WalletSpendReservationV1,
  WalletSpendStateV1,
} from "@kynesyslabs/dacs";

import { createDacsRemoteWalletSpendAuthorityV2 } from "../src/walletSpendRemote.js";
import {
  startDacsWalletSpendTestnetAuthorityV1,
  type DacsWalletSpendTestnetAuthorityV1,
} from "../src/walletSpendTestnetService.js";
import { directoryContents } from "./helpers/walletSpendFileAuthorityStores.js";
import {
  FINAL_NUMBER,
  LATEST_NUMBER,
  TESTNET_AMOUNT,
  TESTNET_ASSET,
  TESTNET_PAYEE,
  TESTNET_TOKEN,
  chainBlocks,
  chainState,
  chainStub,
  closeChainStubs,
  defaultChain,
  nonceOf,
  recordAuthorization,
  serviceSettings,
  testnetPolicy,
  testnetReservation,
  timeWithFinalAt,
  witnessPublicKey,
  type ChainState,
  type ChainStub,
  type StubBlock,
} from "./helpers/walletSpendTestnetChain.js";

const WINDOW = { authorizationWindowSeconds: 120 };
const LEASE_MS = 300_000;
const FIRST_FINAL_TIME = 1_800_000_000;
/** The latest block's time in the default chain, four seconds after the final head. */
const LATEST_TIME = FIRST_FINAL_TIME + (LATEST_NUMBER - FINAL_NUMBER) * 2;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await closeChainStubs();
});

interface Running {
  stub: ChainStub;
  authority: Readonly<DacsWalletSpendTestnetAuthorityV1>;
  settings: Awaited<ReturnType<typeof serviceSettings>>;
  sentBodies: string[];
  client(overrides?: Readonly<{
    policy?: Partial<WalletSpendPolicyV1>;
    epoch?: string;
    witnessVerificationKey?: string;
  }>): Promise<Readonly<WalletSpendAuthorityV1>>;
}

/** Starts the service in this process over a chain stub, with a client factory for it. */
async function running(state: ChainState = defaultChain(FIRST_FINAL_TIME)): Promise<Running> {
  const stub = await chainStub(state);
  const settings = await serviceSettings({ rpcUrl: stub.url });
  cleanups.push(() => settings.remove());
  return attach(stub, settings);
}

async function attach(stub: ChainStub, settings: Running["settings"]): Promise<Running> {
  const authority = await startDacsWalletSpendTestnetAuthorityV1({ environment: settings.environment });
  cleanups.push(() => authority.stop());
  const sentBodies: string[] = [];
  const recordingFetch: typeof fetch = async (input, init) => {
    if (init?.method === "POST" && typeof init.body === "string") sentBodies.push(init.body);
    return fetch(input, init);
  };
  return {
    stub, authority, settings, sentBodies,
    client: (overrides = {}) => createDacsRemoteWalletSpendAuthorityV2({
      policy: testnetPolicy(overrides.policy),
      endpoint: authority.url,
      tokenFilePath: settings.tokenFile,
      authorityId: authority.authorityId,
      epoch: overrides.epoch ?? authority.epoch,
      witnessVerificationKey: overrides.witnessVerificationKey ?? authority.witnessVerificationKey,
      allowInsecureLoopback: true,
      fetch: recordingFetch,
    }),
  };
}

/** The highest-revision state file in the data directory. */
function headState(dataDirectory: string): WalletSpendStateV1 {
  const states = readdirSync(join(dataDirectory, "states")).map((name) =>
    JSON.parse(readFileSync(join(dataDirectory, "states", name), "utf8")) as WalletSpendStateV1);
  return states.reduce((head, state) => state.generation > head.generation ? state : head);
}

const witnessFiles = (dataDirectory: string) => directoryContents(join(dataDirectory, "witness"));

async function permitFor(
  authority: Readonly<WalletSpendAuthorityV1>,
  reservation: WalletSpendReservationV1 = testnetReservation(),
) {
  const claim = await authority.reserve(reservation, WINDOW);
  if (claim.status !== "reserved") throw new Error(`expected reserved, got ${claim.status}`);
  return claim.permit;
}

/** The default hold with another service amount. */
function reservationOf(amount: string): WalletSpendReservationV1 {
  const reservation = testnetReservation();
  return {
    ...reservation,
    debits: reservation.debits.map((debit) => ({ ...debit, expectedAmount: amount, maximumAmount: amount })),
  };
}

/** Serves the blocks of a new chain view, keeping the logs, receipts and nonce state. */
function serveBlocks(state: ChainState, blocks: readonly StubBlock[], extraByHash: readonly StubBlock[] = []): void {
  const next = chainState(blocks, extraByHash);
  Object.assign(state, { latest: next.latest, byNumber: next.byNumber, byHash: next.byHash });
}

function paymentAt(state: ChainState, overrides: Partial<Parameters<typeof recordAuthorization>[1]> = {}) {
  const block = state.byNumber.get(FINAL_NUMBER - 2);
  if (block === undefined) throw new Error("no payment block");
  recordAuthorization(state, {
    block, nonce: nonceOf("job-one", 0), transfers: [{ payee: TESTNET_PAYEE, amount: TESTNET_AMOUNT }], ...overrides,
  });
}

const settledClaim: WalletSpendRecoveryObservationV1 = {
  disposition: "settled", evidenceHash: "d".repeat(64),
  debits: [{ asset: TESTNET_ASSET, purpose: "service", amount: TESTNET_AMOUNT }],
};
const absentClaim: WalletSpendRecoveryObservationV1 = { disposition: "terminal-absent", evidenceHash: "e".repeat(64) };
const rejected = { reasonCode: "wallet-spend-authority-request-rejected" };

function pastLease(): void {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
  vi.setSystemTime(Date.now() + LEASE_MS + 1_000);
}

function portRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}

describe("testnet wallet-spend authority service", () => {
  it("serves inspect for the configured policy", async () => {
    const service = await running();
    const status = await (await service.client()).inspect();
    expect(status).toMatchObject({
      policyId: "testnet-buyer", chainId: "eip155:84532", maximumConcurrentEffects: 1, activeEffects: 0,
    });
    expect(status.assets[0]).toMatchObject({ maximumPerOrderDebit: "5000000", balance: "10000000" });
    expect(service.authority.witnessVerificationKey).toBe(witnessPublicKey());

    await service.authority.stop();
    await expect(portRefused(Number(new URL(service.authority.url).port))).resolves.toBe(true);
  });

  it("denies a reserve above the per-order limit without recording it", async () => {
    const service = await running();
    const client = await service.client();
    const before = { status: await client.inspect(), witness: witnessFiles(service.settings.dataDirectory) };
    const head = headState(service.settings.dataDirectory);

    await expect(client.reserve(reservationOf("5000001"), WINDOW))
      .resolves.toEqual({ status: "denied", reason: "per-order-limit" });
    expect((await client.inspect()).revision).toBe(before.status.revision);
    expect(witnessFiles(service.settings.dataDirectory)).toEqual(before.witness);
    expect(headState(service.settings.dataDirectory)).toEqual(head);
    await expect(client.reserve(testnetReservation(), WINDOW)).resolves.toMatchObject({ status: "reserved" });
  });

  it("counts a purchase once the chain shows it paid", async () => {
    const service = await running();
    const client = await service.client();
    const permit = await permitFor(client);
    await permit.beginEffect();
    paymentAt(service.stub.state);

    await expect(client.reconcile(testnetReservation(), settledClaim)).resolves.toBe("settled");
    const status = await client.inspect();
    expect(status.activeEffects).toBe(0);
    expect(status.assets[0]?.cumulativeSettledDebit).toBe(TESTNET_AMOUNT);
    await expect(client.reserve(testnetReservation("job-two"), WINDOW))
      .resolves.toMatchObject({ status: "reserved" });
  });

  it("keeps the lane held while the chain shows no payment", async () => {
    const service = await running();
    const client = await service.client();
    await (await permitFor(client)).beginEffect();

    await expect(client.reconcile(testnetReservation(), settledClaim)).rejects.toMatchObject(rejected);
    await expect(client.reconcile(testnetReservation(), { disposition: "not-invoked", evidenceHash: "e".repeat(64) }))
      .rejects.toMatchObject(rejected);
    expect((await client.inspect()).activeEffects).toBe(1);
    await expect(client.reserve(testnetReservation("job-two"), WINDOW))
      .resolves.toEqual({ status: "denied", reason: "concurrency-limit" });
  });

  it("keeps the lane held when the payment is on another fork", async () => {
    const time = timeWithFinalAt(FIRST_FINAL_TIME);
    const forkB = chainBlocks({ fork: "b", split: FINAL_NUMBER - 6, time });
    const state = chainState(chainBlocks({ time }), forkB);
    const service = await running(state);
    const client = await service.client();
    await (await permitFor(client)).beginEffect();
    const paymentBlock = forkB.find((block) => block.number === FINAL_NUMBER - 2);
    if (paymentBlock === undefined) throw new Error("no fork block");
    state.byNumber.set(paymentBlock.number, paymentBlock);
    paymentAt(state, { block: paymentBlock });
    await expect(client.reconcile(testnetReservation(), settledClaim)).rejects.toMatchObject(rejected);

    state.logs.length = 0;
    state.receipts.clear();
    paymentAt(state, { block: paymentBlock, event: "canceled", transfers: [] });
    pastLease();
    await expect(client.reconcile(testnetReservation(), absentClaim)).rejects.toMatchObject(rejected);

    const status = await client.inspect();
    expect(status.activeEffects).toBe(1);
    expect(status.assets[0]?.cumulativeSettledDebit).toBe("0");
    expect(headState(service.settings.dataDirectory).reservations[0]?.stage).toBe("effect-pending");
    await expect(client.reserve(testnetReservation("job-two"), WINDOW))
      .resolves.toEqual({ status: "denied", reason: "concurrency-limit" });
  });

  it("binds validBefore when it reserves, returns it to the buyer, and releases only after chain time passes it", async () => {
    const service = await running();
    const client = await service.client();
    const dataDirectory = service.settings.dataDirectory;
    const untouched = { revision: (await client.inspect()).revision, witness: witnessFiles(dataDirectory) };
    const head = headState(dataDirectory);
    for (const options of [{}, { authorizationWindowSeconds: 86_401 }]) {
      await expect(client.reserve(testnetReservation(), options)).rejects.toMatchObject(rejected);
    }
    expect((await client.inspect()).revision).toBe(untouched.revision);
    expect(headState(dataDirectory)).toEqual(head);
    expect(witnessFiles(dataDirectory)).toEqual(untouched.witness);

    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const permit = await permitFor(client);
    const validBefore = LATEST_TIME + 120;
    expect(permit.authorizationValidBefore).toBe(validBefore);
    expect(headState(dataDirectory).reservations[0]?.authorizationValidBefore).toBe(validBefore);
    await permit.beginEffect();
    vi.setSystemTime(Date.now() + LEASE_MS + 1_000);

    serveBlocks(service.stub.state, chainBlocks({ time: timeWithFinalAt(validBefore) }));
    await expect(client.reconcile(testnetReservation(), absentClaim)).rejects.toMatchObject(rejected);
    expect((await client.inspect()).activeEffects).toBe(1);
    expect(headState(dataDirectory).reservations[0]?.stage).toBe("effect-pending");
    await expect(client.reserve(testnetReservation("job-two"), WINDOW))
      .resolves.toEqual({ status: "denied", reason: "concurrency-limit" });

    serveBlocks(service.stub.state, chainBlocks({ time: timeWithFinalAt(validBefore + 1) }));
    await expect(client.reconcile(testnetReservation(), absentClaim)).resolves.toBe("released");
    const next = await permitFor(client, testnetReservation("job-two"));
    expect(next.authorizationValidBefore).toBe(validBefore + 1 + (LATEST_NUMBER - FINAL_NUMBER) * 2 + 120);
  });

  it("refuses another token or scope through inspect and records nothing", async () => {
    const service = await running();
    const dataDirectory = service.settings.dataDirectory;
    const client = await service.client();
    const before = { revision: (await client.inspect()).revision, witness: witnessFiles(dataDirectory) };
    const operations = new URL("v2/wallet-spend/operations", service.authority.url);

    expect((await fetch(operations, { method: "POST", body: "{}" })).status).toBe(401);
    const wrongToken = await fetch(operations, {
      method: "POST", body: "{}", headers: { authorization: `Bearer ${TESTNET_TOKEN.replace("k", "j")}` },
    });
    expect(wrongToken.status).toBe(403);
    for (const overrides of [
      { epoch: "epoch-two" },
      { policy: { assets: testnetPolicy().assets.map((asset) => ({ ...asset, maximumPerOrderDebit: "6000000" })) } },
      { policy: { wallet: `0x${"6f".repeat(20)}` } },
    ]) {
      await expect((await service.client(overrides)).inspect())
        .rejects.toMatchObject({ reasonCode: "wallet-spend-authority-lineage-unavailable" });
    }
    await expect((await service.client({ witnessVerificationKey: "A".repeat(43) })).inspect())
      .rejects.toMatchObject({ reasonCode: "wallet-spend-authority-continuity-proof-invalid" });

    expect((await client.inspect()).revision).toBe(before.revision);
    expect(witnessFiles(dataDirectory)).toEqual(before.witness);
    expect((await client.inspect()).activeEffects).toBe(0);
  });

  it("a reserve through a client with another witness key leaves its hold recorded", async () => {
    const service = await running();
    const dataDirectory = service.settings.dataDirectory;
    const client = await service.client();
    const before = { revision: (await client.inspect()).revision, records: readdirSync(join(dataDirectory, "witness")).length };
    const misconfigured = await service.client({ witnessVerificationKey: "A".repeat(43) });

    await expect(misconfigured.reserve(testnetReservation(), WINDOW))
      .rejects.toMatchObject({ reasonCode: "wallet-spend-authority-continuity-proof-invalid" });
    const status = await client.inspect();
    expect(status.activeEffects).toBe(1);
    expect(status.revision).toBe(before.revision + 1);
    expect(headState(dataDirectory).reservations.map((row) => row.stage)).toEqual(["reserved"]);
    expect(readdirSync(join(dataDirectory, "witness"))).toHaveLength(before.records + 1);
    await expect(client.reserve(testnetReservation("job-two"), WINDOW))
      .resolves.toEqual({ status: "denied", reason: "concurrency-limit" });
  });

  it("enforces body limits over real HTTP", async () => {
    const service = await running();
    const { port } = new URL(service.authority.url);
    const post = (headers: Record<string, string>) => {
      const request = httpRequest({
        host: "127.0.0.1", port, method: "POST", path: "/v2/wallet-spend/operations",
        headers: { authorization: `Bearer ${TESTNET_TOKEN}`, ...headers },
      });
      const answer = new Promise<{ status: number; body: string }>((resolve, reject) => {
        request.once("error", reject);
        request.once("response", (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.on("end", () => {
            resolve({ status: response.statusCode ?? 0, body });
            request.destroy();
          });
        });
      });
      return { request, answer };
    };

    const declared = post({ "content-length": String(65 * 1024) });
    declared.request.end(Buffer.alloc(65 * 1024, 32));
    await expect(declared.answer).resolves.toEqual({
      status: 400, body: JSON.stringify({ reasonCode: "wallet-spend-authority-request-too-large" }),
    });
    const longer = post({ "content-length": "10" });
    longer.request.end(Buffer.from("{\"a\":\"0123456789\"}"));
    await expect(longer.answer).resolves.toMatchObject({ status: 400 });

    const slow = post({});
    let written = 0;
    let writtenWhenAnswered: number | undefined;
    void slow.answer.then(() => {
      writtenWhenAnswered = written;
    }, () => undefined);
    const chunk = Buffer.alloc(16 * 1024, 32);
    while (writtenWhenAnswered === undefined && written < 1024 * 1024) {
      slow.request.write(chunk);
      written += chunk.byteLength;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await expect(slow.answer).resolves.toMatchObject({ status: 400 });
    expect(writtenWhenAnswered).toBeLessThan(1024 * 1024);
  });

  it("refuses a taken port before opening the data directory", async () => {
    const stub = await chainStub(defaultChain());
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise((resolve) => blocker.close(() => resolve())));
    const settings = await serviceSettings({ rpcUrl: stub.url, port: (blocker.address() as AddressInfo).port });
    cleanups.push(() => settings.remove());

    await expect(startDacsWalletSpendTestnetAuthorityV1({ environment: settings.environment }))
      .rejects.toMatchObject({ reasonCode: "wallet-spend-testnet-authority-listen-failed" });
    expect(existsSync(settings.dataDirectory)).toBe(false);

    const free = await attach(stub, {
      ...settings, environment: { ...settings.environment, DACS_WALLET_AUTHORITY_URL: "http://127.0.0.1:0" },
    });
    await expect((await free.client()).inspect()).resolves.toMatchObject({ activeEffects: 0 });
  });

  it("after a restart a recorded hold is held and is released only by the chain rule", async () => {
    const first = await running();
    await permitFor(await first.client());
    const validBefore = LATEST_TIME + 120;
    const reserveBody = first.sentBodies.find((body) => body.includes("\"operation\":\"reserve\""));
    if (reserveBody === undefined) throw new Error("expected a reserve request");
    await first.authority.stop();

    const second = await attach(first.stub, first.settings);
    const repeated = await fetch(new URL("v2/wallet-spend/operations", second.authority.url), {
      method: "POST",
      headers: { authorization: `Bearer ${TESTNET_TOKEN}`, "content-type": "application/json" },
      body: reserveBody,
    });
    expect(repeated.status).toBe(200);
    expect((await repeated.json() as { result: unknown }).result).toMatchObject({ status: "held", stage: "reserved" });
    expect(headState(first.settings.dataDirectory).reservations[0]).toMatchObject({
      stage: "reserved", authorizationValidBefore: validBefore,
    });

    pastLease();
    const client = await second.client();
    serveBlocks(first.stub.state, chainBlocks({ time: timeWithFinalAt(validBefore) }));
    await expect(client.reconcile(testnetReservation(), absentClaim)).rejects.toMatchObject(rejected);
    expect((await client.inspect()).activeEffects).toBe(1);

    serveBlocks(first.stub.state, chainBlocks({ time: timeWithFinalAt(validBefore + 1) }));
    await expect(client.reconcile(testnetReservation(), absentClaim)).resolves.toBe("released");
    await expect(client.reserve(testnetReservation("job-two"), WINDOW))
      .resolves.toMatchObject({ status: "reserved" });
  });
});
