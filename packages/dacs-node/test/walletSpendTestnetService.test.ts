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

import { TP1_APPROVED_IDENTITY_RECORD } from "@kynesyslabs/dacs/wire";

import { dacsWalletSpendLineageKeyV1, dacsWalletSpendPolicyHashV1 } from "../src/walletSpendPostgres.js";
import { createDacsRemoteWalletSpendAuthorityV2 } from "../src/walletSpendRemote.js";
import {
  startDacsWalletSpendTestnetAuthorityV1,
  type DacsWalletSpendTestnetAuthorityV1,
} from "../src/walletSpendTestnetService.js";
import {
  CONFIRMED_AMOUNT,
  CONFIRMED_FEE,
  CONFIRMED_HASH,
  DEMOS_NODE_URL,
  DEMOS_WALLET,
  closeDemosNodeStubs,
  closedPortUrl,
  demosAuthorityClient,
  fetchRoutingDemosNodeTo,
  demosHold,
  demosLaneSettings,
  demosNodeStub,
  demosPolicy,
  demosSettledClaim,
  recordedDemosState,
  withoutX402Lane,
  type DemosNodeStub,
} from "./helpers/walletSpendDemosNode.js";
import { directoryContents, headStateFile as headState } from "./helpers/walletSpendFileAuthorityStores.js";
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
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await closeChainStubs();
  await closeDemosNodeStubs();
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

/** A fetch that keeps each POST body it sends. */
function recordingFetchInto(sentBodies: string[]): typeof fetch {
  return async (input, init) => {
    if (init?.method === "POST" && typeof init.body === "string") sentBodies.push(init.body);
    return fetch(input, init);
  };
}

async function attach(stub: ChainStub, settings: Running["settings"]): Promise<Running> {
  const authority = await startDacsWalletSpendTestnetAuthorityV1({ environment: settings.environment });
  cleanups.push(() => authority.stop());
  const sentBodies: string[] = [];
  const recordingFetch = recordingFetchInto(sentBodies);
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
    await bindsValidBeforeAndReleasesAfterChainTime(await running());
  });

  async function bindsValidBeforeAndReleasesAfterChainTime(service: Running): Promise<void> {
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
  }

  it("changes nothing while the latest block cannot be read", async () => {
    let blocksDown = false;
    const stub = await chainStub(defaultChain(FIRST_FINAL_TIME), {
      answer: (call) => blocksDown && call.method === "eth_getBlockByNumber" ? { status: 500, body: "down" } : undefined,
    });
    const settings = await serviceSettings({ rpcUrl: stub.url });
    cleanups.push(() => settings.remove());
    const client = await (await attach(stub, settings)).client();
    const before = { revision: (await client.inspect()).revision, witness: witnessFiles(settings.dataDirectory) };

    blocksDown = true;
    await expect(client.reserve(testnetReservation(), WINDOW)).rejects.toMatchObject(rejected);
    expect((await client.inspect()).revision).toBe(before.revision);
    expect(witnessFiles(settings.dataDirectory)).toEqual(before.witness);

    blocksDown = false;
    await (await permitFor(client)).beginEffect();
    paymentAt(stub.state);
    blocksDown = true;
    await expect(client.reconcile(testnetReservation(), settledClaim)).rejects.toMatchObject(rejected);
    expect((await client.inspect()).activeEffects).toBe(1);
    expect(headState(settings.dataDirectory).reservations[0]?.stage).toBe("effect-pending");
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

  describe("Demos testnet lane", () => {
    type DemSettings = Running["settings"] & Readonly<{ demDirectory: string }>;

    /** Sends the service's requests for the configured Demos node to `target`. */
    const routeDemosNodeTo = (target: string): void => {
      vi.stubGlobal("fetch", fetchRoutingDemosNodeTo(target));
    };

    /** A node stub serving the approved identity, with the configured Demos node routed to it. */
    async function approvedNode(options: Parameters<typeof demosNodeStub>[1] = {}): Promise<DemosNodeStub> {
      const node = await demosNodeStub(recordedDemosState(TP1_APPROVED_IDENTITY_RECORD.chainIdentity), options);
      routeDemosNodeTo(node.url);
      return node;
    }

    /** Service settings with the DEM lane; without `x402`, the x402 lane's settings are removed. */
    async function withDemLane(x402?: ChainStub): Promise<DemSettings> {
      const settings = await serviceSettings({ rpcUrl: x402?.url ?? "https://base-sepolia.unused.example/" });
      cleanups.push(() => settings.remove());
      const lane = await demosLaneSettings({ root: settings.root, rpcUrl: DEMOS_NODE_URL });
      const environment = x402 === undefined ? withoutX402Lane(settings.environment) : settings.environment;
      return { ...settings, environment: { ...environment, ...lane.environment }, demDirectory: lane.dataDirectory };
    }

    async function startDem(settings: DemSettings) {
      const authority = await startDacsWalletSpendTestnetAuthorityV1({ environment: settings.environment });
      cleanups.push(() => authority.stop());
      const sentBodies: string[] = [];
      const demClient = (policy?: Partial<WalletSpendPolicyV1>) => demosAuthorityClient({
        authority, tokenFile: settings.tokenFile, ...(policy === undefined ? {} : { policy }),
        fetch: recordingFetchInto(sentBodies),
      });
      return { authority, sentBodies, demClient };
    }

    async function demPermit(client: Readonly<WalletSpendAuthorityV1>, jobId?: string) {
      const claim = await client.reserve(demosHold(jobId));
      if (claim.status !== "reserved") throw new Error(`expected reserved, got ${claim.status}`);
      return claim.permit;
    }

    const absentDem: WalletSpendRecoveryObservationV1 = { disposition: "terminal-absent", evidenceHash: CONFIRMED_HASH };

    async function freePort(): Promise<number> {
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      await new Promise((resolve) => server.close(resolve));
      return port;
    }

    it("serves inspect for the DEM lane and for both lanes on one address", async () => {
      await approvedNode();
      const demOnly = await startDem(await withDemLane());
      const status = await (await demOnly.demClient()).inspect();
      expect(status).toMatchObject({ policyId: "testnet-dem-buyer", chainId: "demos", activeEffects: 0 });
      expect(status.assets[0]).toMatchObject({ asset: "DEM", maximumPerOrderDebit: "20000000000", balance: "12000000000" });
      expect(demOnly.authority.lineageKey).toBeUndefined();
      expect(demOnly.authority.policyHash).toBeUndefined();
      expect(demOnly.authority.payDem).toEqual({
        lineageKey: dacsWalletSpendLineageKeyV1(DEMOS_WALLET, "demos"),
        policyHash: dacsWalletSpendPolicyHashV1(demosPolicy()),
      });
      await expect((await demOnly.demClient({ wallet: `0x${"ab".repeat(32)}` })).inspect())
        .rejects.toMatchObject({ reasonCode: "wallet-spend-authority-lineage-unavailable" });

      const chain = await chainStub(defaultChain(FIRST_FINAL_TIME));
      const settings = await withDemLane(chain);
      const both = await attach(chain, settings);
      const x402Status = await (await both.client()).inspect();
      expect(x402Status).toMatchObject({ chainId: "eip155:84532", activeEffects: 0 });
      expect(x402Status.assets[0]).toMatchObject({ balance: "10000000" });
      const demStatus = await (await demosAuthorityClient({ authority: both.authority, tokenFile: settings.tokenFile }))
        .inspect();
      expect(demStatus).toMatchObject({ chainId: "demos", activeEffects: 0 });
      expect(demStatus.assets[0]).toMatchObject({ balance: "12000000000" });
      expect(both.authority.policyHash).toBe(dacsWalletSpendPolicyHashV1(testnetPolicy()));
      expect(both.authority.payDem?.lineageKey).not.toBe(both.authority.lineageKey);

      await both.authority.stop();
      await expect(portRefused(Number(new URL(both.authority.url).port))).resolves.toBe(true);
    });

    it("counts a DEM purchase once the chain shows it executed", async () => {
      await approvedNode();
      const settings = await withDemLane();
      const client = await (await startDem(settings)).demClient();
      const permit = await demPermit(client);
      expect(permit.authorizationValidBefore).toBeUndefined();
      expect(headState(settings.demDirectory).reservations[0]).not.toHaveProperty("authorizationValidBefore");
      await permit.beginEffect();

      const feePlusOne = (BigInt(CONFIRMED_FEE) + 1n).toString();
      await expect(permit.settle(demosSettledClaim(CONFIRMED_HASH, feePlusOne))).rejects.toMatchObject(rejected);
      await expect(permit.settle(demosSettledClaim())).resolves.toBeUndefined();
      const paid = (BigInt(CONFIRMED_AMOUNT) + BigInt(CONFIRMED_FEE)).toString();
      const status = await client.inspect();
      expect(status.activeEffects).toBe(0);
      expect(status.assets[0]?.cumulativeSettledDebit).toBe(paid);
      await expect(client.reconcile(demosHold(), demosSettledClaim())).resolves.toBe("existing");
      expect((await client.inspect()).assets[0]?.cumulativeSettledDebit).toBe(paid);
      await expect(client.reserve(demosHold("job-two"))).resolves.toMatchObject({ status: "reserved" });
    });

    it("keeps the DEM lane held until the chain shows the payment", async () => {
      const node = await approvedNode();
      const settings = await withDemLane();
      const client = await (await startDem(settings)).demClient();
      const permit = await demPermit(client);
      await permit.beginEffect();
      const record = node.state.records.get(CONFIRMED_HASH);
      node.state.records.delete(CONFIRMED_HASH);

      await expect(permit.settle(demosSettledClaim())).rejects.toMatchObject(rejected);
      pastLease();
      await expect(client.reconcile(demosHold(), absentDem)).rejects.toMatchObject(rejected);
      expect((await client.inspect()).activeEffects).toBe(1);
      expect(headState(settings.demDirectory).reservations[0]?.stage).toBe("effect-pending");
      await expect(client.reserve(demosHold("job-two")))
        .resolves.toEqual({ status: "denied", reason: "concurrency-limit" });

      node.state.records.set(CONFIRMED_HASH, record);
      await expect(client.reconcile(demosHold(), demosSettledClaim())).resolves.toBe("settled");
      expect((await client.inspect()).activeEffects).toBe(0);
      await expect(client.reserve(demosHold("job-two"))).resolves.toMatchObject({ status: "reserved" });
    });

    it("refuses to start the DEM lane against any network but the approved testnet", async () => {
      const chain = await chainStub(defaultChain(FIRST_FINAL_TIME));
      const otherNetwork = await demosNodeStub(recordedDemosState("ab".repeat(32)));
      const port = await freePort();
      for (const [target, reasonCode] of [
        [otherNetwork.url, "wallet-spend-testnet-authority-demos-network-mismatch"],
        [await closedPortUrl(), "wallet-spend-testnet-authority-demos-node-unavailable"],
      ] as const) {
        routeDemosNodeTo(target);
        const settings = await withDemLane(chain);
        const environment = { ...settings.environment, DACS_WALLET_AUTHORITY_URL: `http://127.0.0.1:${port}` };
        await expect(startDacsWalletSpendTestnetAuthorityV1({ environment })).rejects.toMatchObject({ reasonCode });
        await expect(portRefused(port)).resolves.toBe(true);
        expect(existsSync(settings.dataDirectory)).toBe(false);
        expect(existsSync(settings.demDirectory)).toBe(false);
      }
    });

    it("a DEM hold recorded before a restart is held and never released by time", async () => {
      let silent = false;
      await approvedNode({ answer: () => (silent ? { status: 503, body: "" } : undefined) });
      const settings = await withDemLane();
      const first = await startDem(settings);
      await demPermit(await first.demClient());
      const reserveBody = first.sentBodies.find((body) => body.includes("\"operation\":\"reserve\""));
      if (reserveBody === undefined) throw new Error("expected a reserve request");
      await first.authority.stop();

      const second = await startDem(settings);
      const repeated = await fetch(new URL("v2/wallet-spend/operations", second.authority.url), {
        method: "POST",
        headers: { authorization: `Bearer ${TESTNET_TOKEN}`, "content-type": "application/json" },
        body: reserveBody,
      });
      expect(repeated.status).toBe(200);
      expect((await repeated.json() as { result: unknown }).result).toMatchObject({ status: "held", stage: "reserved" });

      silent = true;
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
      vi.setSystemTime(Date.now() + 10 * 86_400_000);
      await expect((await second.demClient()).reconcile(demosHold(), absentDem)).rejects.toMatchObject(rejected);
      expect(headState(settings.demDirectory).reservations).toEqual([
        expect.objectContaining({ reservationId: demosHold().reservationId, stage: "reserved" }),
      ]);
    });

    it("the x402 lane is unchanged beside the DEM lane", async () => {
      const chain = await chainStub(defaultChain(FIRST_FINAL_TIME));
      await approvedNode();
      const settings = await withDemLane(chain);
      const service = await attach(chain, settings);
      const demClient = await demosAuthorityClient({ authority: service.authority, tokenFile: settings.tokenFile });
      const before = { revision: (await demClient.inspect()).revision, witness: witnessFiles(settings.demDirectory) };

      await bindsValidBeforeAndReleasesAfterChainTime(service);
      expect((await demClient.inspect()).revision).toBe(before.revision);
      expect(witnessFiles(settings.demDirectory)).toEqual(before.witness);
    });
  });
});
