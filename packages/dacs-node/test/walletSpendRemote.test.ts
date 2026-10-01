import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createInMemoryWalletSpendStateStore,
  createWalletSpendAuthorityV1,
  type WalletSpendPolicyV1,
  type WalletSpendReservationV1,
} from "@kynesyslabs/dacs";
import { sha256Hex } from "@kynesyslabs/dacs/canonical";

import {
  createDacsRemoteWalletSpendAuthorityV1,
  createDacsRemoteWalletSpendAuthorityV2,
  createDacsWalletSpendAuthorityServiceV1,
  createDacsWalletSpendAuthorityServiceV2,
  createInMemoryDacsWalletSpendRemoteOperationStoreV1,
  DacsWalletSpendRemoteError,
} from "../src/walletSpendRemote.js";
import {
  createDacsWalletSpendContinuityAuthorityV2,
  createInMemoryDacsWalletSpendContinuityStateStoreV1,
  createInMemoryDacsWalletSpendContinuityWitnessV1,
  dacsWalletSpendLineageKeyV1,
} from "../src/walletSpendPostgres.js";

const roots: string[] = [];
const HASH = "a".repeat(64);
const TOKEN = "role-scoped-test-token-which-is-long-enough";

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

const policy = (policyId = "policy-a"): WalletSpendPolicyV1 => ({
  policyVersion: "1",
  policyId,
  wallet: "wallet-a",
  chainId: "chain-a",
  maximumConcurrentEffects: 1,
  maximumRetainedReservations: 10,
  assets: [{
    asset: "ASSET",
    maximumPerOrderDebit: "100",
    maximumNetworkFeeDebit: "10",
    minimumReserve: "10",
    rollingWindowMs: 60_000,
    maximumRollingEffects: 10,
    maximumRollingDebit: "500",
    maximumCumulativeDebit: "1000",
    maximumCounterpartyDebit: "500",
  }],
});

const reservation = (): WalletSpendReservationV1 => ({
  reservationVersion: "1",
  reservationId: "remote-one",
  jobId: "job-one",
  phaseIndex: 2,
  phase: "payment",
  agreementHash: HASH,
  settlementBindingHash: "b".repeat(64),
  railId: "rail-one",
  railDefinitionHash: "c".repeat(64),
  wallet: "wallet-a",
  chainId: "chain-a",
  payee: "payee-a",
  finality: { model: "final" },
  debits: [{
    asset: "ASSET",
    purpose: "service",
    expectedAmount: "25",
    maximumAmount: "25",
  }],
});

async function tokenFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dacs-remote-wallet-"));
  roots.push(root);
  const path = join(root, "token");
  await writeFile(path, `${TOKEN}\n`, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(path, 0o600);
  return path;
}

function server(
  now: () => number = () => 1_000,
  localPolicy: WalletSpendPolicyV1 = policy(),
) {
  const authority = createWalletSpendAuthorityV1(localPolicy, {
    store: createInMemoryWalletSpendStateStore(),
    readBalance: async () => "1000",
    authenticateRecovery: async () => true,
    owner: "remote-service",
    leaseDurationMs: 60_000,
    now,
  });
  const operations = createInMemoryDacsWalletSpendRemoteOperationStoreV1();
  const handler = createDacsWalletSpendAuthorityServiceV1({
    authenticate: (token) => token === TOKEN ? "buyer" : null,
    resolveAuthority: ({ roleId, wallet, chainId, policyHash }) =>
      roleId === "buyer" && wallet === localPolicy.wallet &&
        chainId === localPolicy.chainId && policyHash === authority.policyHash
        ? authority : null,
    operations,
  });
  return { authority, handler, operations };
}

async function serverV2(
  now: () => number = () => 1_000,
  selected: WalletSpendPolicyV1 = policy(),
) {
  const reference = createInMemoryDacsWalletSpendContinuityWitnessV1({
    authorityId: "wallet-authority-production", epoch: "epoch-2026-09",
    seed: new Uint8Array(32).fill(21),
  });
  const lineageKey = dacsWalletSpendLineageKeyV1(selected.wallet, selected.chainId);
  const store = await createInMemoryDacsWalletSpendContinuityStateStoreV1({
    policy: selected,
    continuity: {
      authorityId: "wallet-authority-production",
      epoch: "epoch-2026-09",
      verificationKey: reference.verificationKey,
      witness: reference.witness,
    },
  });
  const bindingInput = {
    policy: selected,
    store,
    dependencies: {
      readBalance: async () => "1000",
      authenticateRecovery: async () => true,
      owner: "remote-service",
      leaseDurationMs: 60_000,
      now,
    },
  };
  const binding = createDacsWalletSpendContinuityAuthorityV2(bindingInput);
  const operations = createInMemoryDacsWalletSpendRemoteOperationStoreV1();
  const handler = createDacsWalletSpendAuthorityServiceV2({
    authenticate: (token) => token === TOKEN ? "buyer" : null,
    resolveAuthority: ({ roleId, authorityId, epoch, lineageKey: requested }) =>
      roleId === "buyer" && authorityId === "wallet-authority-production" &&
        epoch === "epoch-2026-09" && requested === lineageKey
        ? binding
        : null,
    operations,
  });
  return {
    authority: binding.authority,
    bindingInput,
    operations,
    handler,
    authorityId: "wallet-authority-production",
    epoch: "epoch-2026-09",
    verificationKey: reference.verificationKey,
  };
}

function handlerFetch(
  handler: (request: Request) => Promise<Response>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(new Request(input, init))) as typeof fetch;
}

function postService(
  version: "1" | "2",
  handler: (request: Request) => Promise<Response>,
  body: unknown,
  token = TOKEN,
): Promise<Response> {
  return handler(new Request(
    `http://authority.test/v${version}/wallet-spend/operations`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  ));
}

function countedByteStream(totalBytes: number, chunkBytes = 8 * 1024) {
  const counters = { pulls: 0, cancellations: 0, bytes: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      counters.pulls += 1;
      const remaining = totalBytes - counters.bytes;
      if (remaining === 0) {
        controller.close();
        return;
      }
      const length = Math.min(chunkBytes, remaining);
      counters.bytes += length;
      controller.enqueue(new Uint8Array(length).fill(0x20));
    },
    cancel() { counters.cancellations += 1; },
  }, { highWaterMark: 0 });
  return { stream, counters };
}

describe("remote PostgreSQL wallet authority boundary", () => {
  it.each(["1", "2"] as const)(
    "does not claim a V%s operation for an unavailable lineage",
    async (version) => {
      const local = version === "1" ? server() : await serverV2();
      const operationId = version === "1"
        ? "00000000-0000-4000-8000-000000000101"
        : "00000000-0000-4000-8000-000000000102";
      const unknownWallet = "wallet-unprovisioned";
      const item = { ...reservation(), wallet: unknownWallet };
      const common = {
        operationId,
        policyHash: local.authority.policyHash,
        wallet: unknownWallet,
        chainId: item.chainId,
        operation: "reserve",
        payload: { reservation: item, options: {} },
      };
      const body = version === "1" ? {
        protocolVersion: "1",
        ...common,
      } : {
        protocolVersion: "2",
        requestHashVersion: "1",
        clientNonce: "1".repeat(64),
        authorityId: "wallet-authority-production",
        epoch: "epoch-2026-09",
        lineageKey: dacsWalletSpendLineageKeyV1(unknownWallet, item.chainId),
        ...common,
      };

      const response = await postService(version, local.handler, body);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        reasonCode: "wallet-spend-authority-lineage-unavailable",
      });
      await expect(local.operations.load({ roleId: "buyer", operationId }))
        .resolves.toBeUndefined();
    },
  );

  it.each(["1", "2"] as const)(
    "does not claim a V%s operation with a deeply malformed payload",
    async (version) => {
      const local = version === "1" ? server() : await serverV2();
      const operationId = version === "1"
        ? "00000000-0000-4000-8000-000000000103"
        : "00000000-0000-4000-8000-000000000104";
      const selected = local.authority.policy;
      const common = {
        operationId,
        policyHash: local.authority.policyHash,
        wallet: selected.wallet,
        chainId: selected.chainId,
        operation: "reserve",
        payload: {
          reservation: { ...reservation(), agreementHash: "not-a-hash" },
          options: {},
        },
      };
      const body = version === "1" ? {
        protocolVersion: "1",
        ...common,
      } : {
        protocolVersion: "2",
        requestHashVersion: "1",
        clientNonce: "2".repeat(64),
        authorityId: "wallet-authority-production",
        epoch: "epoch-2026-09",
        lineageKey: dacsWalletSpendLineageKeyV1(selected.wallet, selected.chainId),
        ...common,
      };

      const response = await postService(version, local.handler, body);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        reasonCode: "wallet-spend-authority-request-rejected",
      });
      await expect(local.operations.load({ roleId: "buyer", operationId }))
        .resolves.toBeUndefined();
    },
  );

  it("durably claims a valid operation immediately before authority mutation", async () => {
    const selected = policy();
    const events: string[] = [];
    const state = createInMemoryWalletSpendStateStore();
    const authority = createWalletSpendAuthorityV1(selected, {
      store: {
        transact: (scope, operation) => {
          events.push("authority");
          return state.transact(scope, operation);
        },
      },
      readBalance: async () => "1000",
      authenticateRecovery: async () => true,
      owner: "remote-service",
      now: () => 1_000,
    });
    const inner = createInMemoryDacsWalletSpendRemoteOperationStoreV1();
    const handler = createDacsWalletSpendAuthorityServiceV1({
      authenticate: (token) => token === TOKEN ? "buyer" : null,
      resolveAuthority: () => authority,
      operations: {
        load: (input) => inner.load(input),
        async claim(input) {
          const result = await inner.claim(input);
          events.push("claim");
          return result;
        },
        complete: (input) => inner.complete(input),
      },
    });
    const operationId = "00000000-0000-4000-8000-000000000105";
    const response = await postService("1", handler, {
      protocolVersion: "1",
      operationId,
      policyHash: authority.policyHash,
      wallet: selected.wallet,
      chainId: selected.chainId,
      operation: "reserve",
      payload: { reservation: reservation(), options: {} },
    });

    expect(response.status).toBe(200);
    expect(events.slice(0, 2)).toEqual(["claim", "authority"]);
  });

  it("bounds retained operations per role and globally without evicting exact claims", async () => {
    const operations = createInMemoryDacsWalletSpendRemoteOperationStoreV1({
      maximumOperationsPerRole: 2,
      maximumOperations: 3,
    });
    const claim = (roleId: string, suffix: string) => {
      const operationId = `00000000-0000-4000-8000-0000000000${suffix.padStart(2, "0")}`;
      const requestHash = suffix.repeat(64);
      return operations.claim({
        roleId,
        operationId,
        requestHash,
        request: {
          protocolVersion: "1",
          operationId,
          policyHash: HASH,
          wallet: "wallet-a",
          chainId: "chain-a",
          operation: "reserve",
          payload: { reservation: reservation(), options: {} },
        },
      });
    };

    await expect(claim("role-a", "1")).resolves.toBe("new");
    await expect(claim("role-a", "2")).resolves.toBe("new");
    await expect(claim("role-a", "3")).resolves.toBe("full");
    await expect(claim("role-b", "3")).resolves.toBe("new");
    await expect(claim("role-b", "4")).resolves.toBe("full");
    await expect(claim("role-a", "1")).resolves.toBe("existing");
    await expect(operations.load({
      roleId: "role-a",
      operationId: "00000000-0000-4000-8000-000000000001",
    })).resolves.toBeDefined();
  });

  it("returns stable capacity exhaustion while preserving other-role and exact recovery", async () => {
    const selected = { ...policy(), maximumConcurrentEffects: 3 };
    const authority = createWalletSpendAuthorityV1(selected, {
      store: createInMemoryWalletSpendStateStore(),
      readBalance: async () => "1000",
      authenticateRecovery: async () => true,
      owner: "remote-service",
      now: () => 1_000,
    });
    const otherToken = "other-role-scoped-test-token-which-is-long-enough";
    const operations = createInMemoryDacsWalletSpendRemoteOperationStoreV1({
      maximumOperationsPerRole: 1,
      maximumOperations: 2,
    });
    const handler = createDacsWalletSpendAuthorityServiceV1({
      authenticate: (token) => token === TOKEN ? "role-a" : token === otherToken ? "role-b" : null,
      resolveAuthority: () => authority,
      operations,
    });
    const body = (suffix: string) => ({
      protocolVersion: "1",
      operationId: `00000000-0000-4000-8000-0000000001${suffix.padStart(2, "0")}`,
      policyHash: authority.policyHash,
      wallet: selected.wallet,
      chainId: selected.chainId,
      operation: "reserve",
      payload: {
        reservation: {
          ...reservation(),
          reservationId: `capacity-${suffix}`,
          jobId: `capacity-job-${suffix}`,
        },
        options: {},
      },
    });

    const first = await postService("1", handler, body("1"));
    expect(first.status).toBe(200);
    const exhausted = await postService("1", handler, body("2"));
    expect(exhausted.status).toBe(429);
    await expect(exhausted.json()).resolves.toEqual({
      reasonCode: "wallet-spend-authority-operation-capacity-exceeded",
    });
    const otherRole = await postService("1", handler, body("3"), otherToken);
    expect(otherRole.status).toBe(200);
    const exact = await postService("1", handler, body("1"));
    expect(exact.status).toBe(200);
  });

  it.each(["V1", "V2"] as const)(
    "cancels an undeclared oversized %s service request before draining it",
    async (version) => {
      const local = version === "V1" ? server() : await serverV2();
      const counted = countedByteStream(80 * 1024);
      const request = new Request(
        `http://authority.test/${version.toLowerCase()}/wallet-spend/operations`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
          },
          body: counted.stream,
          duplex: "half",
        } as RequestInit & { duplex: "half" },
      );

      const response = await local.handler(request);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        reasonCode: "wallet-spend-authority-request-size-invalid",
      });
      expect(counted.counters.cancellations).toBe(1);
      expect(counted.counters.pulls).toBeLessThan(10);
      expect(counted.counters.bytes).toBeGreaterThan(64 * 1024);
      expect(counted.counters.bytes).toBeLessThan(80 * 1024);
    },
  );

  it.each(["V1", "V2"] as const)(
    "cancels an undeclared oversized %s client response before draining it",
    async (version) => {
      const tokenFilePath = await tokenFile();
      const counted = countedByteStream(80 * 1024);
      const responseFetch = (async () => new Response(counted.stream, {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
      let inspect: () => Promise<unknown>;
      if (version === "V1") {
        const remote = await createDacsRemoteWalletSpendAuthorityV1({
          policy: policy(), endpoint: "http://127.0.0.1:8080/", tokenFilePath,
          allowInsecureLoopback: true, fetch: responseFetch,
        });
        inspect = () => remote.inspect();
      } else {
        const reference = createInMemoryDacsWalletSpendContinuityWitnessV1({
          authorityId: "wallet-authority-production", epoch: "epoch-2026-09",
          seed: new Uint8Array(32).fill(21),
        });
        const remote = await createDacsRemoteWalletSpendAuthorityV2({
          policy: policy(), endpoint: "http://127.0.0.1:8080/", tokenFilePath,
          authorityId: "wallet-authority-production", epoch: "epoch-2026-09",
          witnessVerificationKey: reference.verificationKey,
          allowInsecureLoopback: true, fetch: responseFetch,
        });
        inspect = () => remote.inspect();
      }

      await expect(inspect()).rejects.toMatchObject({
        reasonCode: "wallet-spend-authority-response-size-invalid",
      });
      expect(counted.counters.cancellations).toBe(1);
      expect(counted.counters.pulls).toBeLessThan(10);
      expect(counted.counters.bytes).toBeGreaterThan(64 * 1024);
      expect(counted.counters.bytes).toBeLessThan(80 * 1024);
    },
  );

  it("keeps the POST timeout active through response body consumption", async () => {
    const tokenFilePath = await tokenFile();
    let cancellations = 0;
    const stalled = new ReadableStream<Uint8Array>({
      pull() { /* wait for cancellation */ },
      cancel() { cancellations += 1; },
    }, { highWaterMark: 0 });
    const remote = await createDacsRemoteWalletSpendAuthorityV1({
      policy: policy(), endpoint: "http://127.0.0.1:8080/", tokenFilePath,
      allowInsecureLoopback: true, timeoutMs: 1_000,
      fetch: (async () => new Response(stalled, { status: 200 })) as typeof fetch,
    });
    vi.useFakeTimers();

    const pending = remote.inspect();
    const rejected = expect(pending).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(cancellations).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["V1", "V2"] as const)(
    "cancels a stalled %s request body when the request is aborted",
    async (version) => {
      const local = version === "V1" ? server() : await serverV2();
      const controller = new AbortController();
      let cancellations = 0;
      const stalled = new ReadableStream<Uint8Array>({
        pull() { /* wait for request cancellation */ },
        cancel() { cancellations += 1; },
      }, { highWaterMark: 0 });
      const request = new Request(
        `http://authority.test/${version.toLowerCase()}/wallet-spend/operations`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
          },
          body: stalled,
          duplex: "half",
          signal: controller.signal,
        } as RequestInit & { duplex: "half" },
      );

      const pending = local.handler(request);
      await Promise.resolve();
      controller.abort();
      const response = await pending;
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        reasonCode: "wallet-spend-authority-request-rejected",
      });
      expect(cancellations).toBe(1);
    },
  );

  it("uses V2 current-head proofs for reserve, current, begin, settle, reconcile and inspect", async () => {
    const tokenFilePath = await tokenFile();
    const local = await serverV2();
    const remote = await createDacsRemoteWalletSpendAuthorityV2({
      policy: policy(), endpoint: "http://127.0.0.1:8080/", tokenFilePath,
      authorityId: local.authorityId, epoch: local.epoch,
      witnessVerificationKey: local.verificationKey,
      allowInsecureLoopback: true, fetch: handlerFetch(local.handler),
    });
    const claim = await remote.reserve(reservation());
    expect(claim.status).toBe("reserved");
    if (claim.status !== "reserved") throw new Error("expected reservation");
    await claim.permit.assertCurrent();
    await claim.permit.beginEffect();
    const observation = {
      disposition: "settled" as const,
      evidenceHash: "d".repeat(64),
      debits: [{ asset: "ASSET", purpose: "service" as const, amount: "25" }],
    };
    await claim.permit.settle(observation);
    await expect(remote.reconcile(reservation(), observation)).resolves.toBe("existing");
    await expect(remote.inspect()).resolves.toMatchObject({
      revision: 3,
      assets: [{ cumulativeSettledDebit: "25" }],
    });
  });

  it("recovers a committed V2 mutation whose successful response arrives out of order", async () => {
    const tokenFilePath = await tokenFile();
    const selected = { ...policy(), maximumConcurrentEffects: 2 };
    const local = await serverV2(() => 1_000, selected);
    let releaseReserveResponse!: () => void;
    const reserveResponseGate = new Promise<void>((resolve) => {
      releaseReserveResponse = resolve;
    });
    let markReserveResponseReady!: () => void;
    const reserveResponseReady = new Promise<void>((resolve) => {
      markReserveResponseReady = resolve;
    });
    let delayReserveResponse = true;
    let exactOperationGets = 0;
    const fetchOutOfOrder = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const body = request.method === "POST"
        ? await request.clone().json() as { operation?: string }
        : undefined;
      if (request.method === "GET") exactOperationGets += 1;
      const response = await local.handler(request);
      if (response.ok && body?.operation === "reserve" && delayReserveResponse) {
        delayReserveResponse = false;
        markReserveResponseReady();
        await reserveResponseGate;
      }
      return response;
    }) as typeof fetch;
    const remote = await createDacsRemoteWalletSpendAuthorityV2({
      policy: selected, endpoint: "http://127.0.0.1:8080/", tokenFilePath,
      authorityId: local.authorityId, epoch: local.epoch,
      witnessVerificationKey: local.verificationKey,
      allowInsecureLoopback: true, fetch: fetchOutOfOrder,
    });
    const concurrentRemote = await createDacsRemoteWalletSpendAuthorityV2({
      policy: selected, endpoint: "http://127.0.0.1:8080/", tokenFilePath,
      authorityId: local.authorityId, epoch: local.epoch,
      witnessVerificationKey: local.verificationKey,
      allowInsecureLoopback: true, fetch: handlerFetch(local.handler),
    });

    const delayedReserve = remote.reserve(reservation());
    await reserveResponseReady;
    const otherReservation = {
      ...reservation(),
      reservationId: "remote-two",
      jobId: "job-two",
    };
    await expect(concurrentRemote.reserve(otherReservation)).resolves.toMatchObject({
      status: "reserved",
    });
    await expect(remote.inspect()).resolves.toMatchObject({ revision: 2 });
    releaseReserveResponse();

    await expect(delayedReserve).resolves.toMatchObject({
      status: "reserved",
      permit: { reservationId: "remote-one" },
    });
    expect(exactOperationGets).toBe(1);
  });

  it("recovers a committed V1 mutation whose successful response arrives out of order", async () => {
    const tokenFilePath = await tokenFile();
    const selected = { ...policy(), maximumConcurrentEffects: 2 };
    const local = server(() => 1_000, selected);
    let releaseReserveResponse!: () => void;
    const reserveResponseGate = new Promise<void>((resolve) => {
      releaseReserveResponse = resolve;
    });
    let markReserveResponseReady!: () => void;
    const reserveResponseReady = new Promise<void>((resolve) => {
      markReserveResponseReady = resolve;
    });
    let delayReserveResponse = true;
    let exactOperationGets = 0;
    const fetchOutOfOrder = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const body = request.method === "POST"
        ? await request.clone().json() as { operation?: string }
        : undefined;
      if (request.method === "GET") exactOperationGets += 1;
      const response = await local.handler(request);
      if (response.ok && body?.operation === "reserve" && delayReserveResponse) {
        delayReserveResponse = false;
        markReserveResponseReady();
        await reserveResponseGate;
      }
      return response;
    }) as typeof fetch;
    const remote = await createDacsRemoteWalletSpendAuthorityV1({
      policy: selected, endpoint: "http://127.0.0.1:8080/", tokenFilePath,
      allowInsecureLoopback: true, fetch: fetchOutOfOrder,
    });
    const concurrentRemote = await createDacsRemoteWalletSpendAuthorityV1({
      policy: selected, endpoint: "http://127.0.0.1:8080/", tokenFilePath,
      allowInsecureLoopback: true, fetch: handlerFetch(local.handler),
    });

    const delayedReserve = remote.reserve(reservation());
    await reserveResponseReady;
    const otherReservation = {
      ...reservation(),
      reservationId: "remote-two",
      jobId: "job-two",
    };
    await expect(concurrentRemote.reserve(otherReservation)).resolves.toMatchObject({
      status: "reserved",
    });
    await expect(remote.inspect()).resolves.toMatchObject({ revision: 2 });
    releaseReserveResponse();

    await expect(delayedReserve).resolves.toMatchObject({
      status: "reserved",
      permit: { reservationId: "remote-one" },
    });
    expect(exactOperationGets).toBe(1);
  });

  it("recovers a committed V2 mutation after an invalid successful proof", async () => {
    const tokenFilePath = await tokenFile();
    const local = await serverV2();
    let corruptReserveResponse = true;
    let exactOperationGets = 0;
    const fetchWithInvalidProof = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const requestBody = request.method === "POST"
        ? await request.clone().json() as { operation?: string }
        : undefined;
      if (request.method === "GET") exactOperationGets += 1;
      const response = await local.handler(request);
      if (response.ok && corruptReserveResponse && requestBody?.operation === "reserve") {
        corruptReserveResponse = false;
        const body = await response.json() as Record<string, unknown>;
        const continuity = body.continuity as Record<string, unknown>;
        return new Response(JSON.stringify({
          ...body,
          continuity: {
            ...continuity,
            signature: { algorithm: "ed25519", value: "A".repeat(86) },
          },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return response;
    }) as typeof fetch;
    const remote = await createDacsRemoteWalletSpendAuthorityV2({
      policy: policy(), endpoint: "http://127.0.0.1:8080/", tokenFilePath,
      authorityId: local.authorityId, epoch: local.epoch,
      witnessVerificationKey: local.verificationKey,
      allowInsecureLoopback: true, fetch: fetchWithInvalidProof,
    });

    await expect(remote.reserve(reservation())).resolves.toMatchObject({
      status: "reserved",
      permit: { reservationId: "remote-one" },
    });
    expect(exactOperationGets).toBe(1);
  });

  it.each(["current", "begin"] as const)(
    "rejects a retained %s success when its permit was released before recovery",
    async (operation) => {
      const tokenFilePath = await tokenFile();
      let now = 1_000;
      const local = await serverV2(() => now);
      let loseAfter: typeof operation | undefined;
      const fetchWithRelease = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const body = request.method === "POST"
          ? await request.clone().json() as { operation?: string }
          : undefined;
        const response = await local.handler(request);
        if (response.ok && body?.operation === loseAfter) {
          loseAfter = undefined;
          now = 70_000;
          await local.authority.reconcile(reservation(), {
            disposition: "terminal-absent",
            evidenceHash: "e".repeat(64),
          });
          throw new Error("response lost after the permit was released");
        }
        return response;
      }) as typeof fetch;
      const remote = await createDacsRemoteWalletSpendAuthorityV2({
        policy: policy(), endpoint: "http://127.0.0.1:8080/", tokenFilePath,
        authorityId: local.authorityId, epoch: local.epoch,
        witnessVerificationKey: local.verificationKey,
        allowInsecureLoopback: true, fetch: fetchWithRelease,
      });
      const claim = await remote.reserve(reservation());
      if (claim.status !== "reserved") throw new Error("expected reservation");
      loseAfter = operation;

      await expect(operation === "current"
        ? claim.permit.assertCurrent()
        : claim.permit.beginEffect()).rejects.toMatchObject({
        reasonCode: "wallet-spend-authority-outcome-unknown",
      });
      await expect(local.authority.reserve(reservation())).resolves.toMatchObject({
        status: "reserved",
      });
    },
  );

  it.each(["current", "begin"] as const)(
    "rejects a retained V1 %s success when its permit was released before recovery",
    async (operation) => {
      const tokenFilePath = await tokenFile();
      let now = 1_000;
      const local = server(() => now);
      let loseAfter: typeof operation | undefined;
      const fetchWithRelease = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const body = request.method === "POST"
          ? await request.clone().json() as { operation?: string }
          : undefined;
        const response = await local.handler(request);
        if (response.ok && body?.operation === loseAfter) {
          loseAfter = undefined;
          now = 70_000;
          await local.authority.reconcile(reservation(), {
            disposition: "terminal-absent",
            evidenceHash: "e".repeat(64),
          });
          throw new Error("response lost after the permit was released");
        }
        return response;
      }) as typeof fetch;
      const remote = await createDacsRemoteWalletSpendAuthorityV1({
        policy: policy(), endpoint: "http://127.0.0.1:8080/", tokenFilePath,
        allowInsecureLoopback: true, fetch: fetchWithRelease,
      });
      const claim = await remote.reserve(reservation());
      if (claim.status !== "reserved") throw new Error("expected reservation");
      loseAfter = operation;

      await expect(operation === "current"
        ? claim.permit.assertCurrent()
        : claim.permit.beginEffect()).rejects.toMatchObject({
        reasonCode: "wallet-spend-authority-outcome-unknown",
      });
      await expect(local.authority.reserve(reservation())).resolves.toMatchObject({
        status: "reserved",
      });
    },
  );

  it("requires an authoritative read before returning a retained denied V1 reserve", async () => {
    const selected = policy();
    const authority = createWalletSpendAuthorityV1(selected, {
      store: createInMemoryWalletSpendStateStore(),
      readBalance: async () => "1000",
      authenticateRecovery: async () => true,
      owner: "remote-service",
      now: () => 1_000,
    });
    let inspectFails = false;
    const guardedAuthority = Object.freeze({
      policy: authority.policy,
      policyHash: authority.policyHash,
      reserve: authority.reserve,
      reconcile: authority.reconcile,
      inspect: async () => {
        if (inspectFails) throw new Error("authoritative read unavailable");
        return authority.inspect();
      },
    });
    const handler = createDacsWalletSpendAuthorityServiceV1({
      authenticate: (token) => token === TOKEN ? "buyer" : null,
      resolveAuthority: () => guardedAuthority,
      operations: createInMemoryDacsWalletSpendRemoteOperationStoreV1(),
    });
    const body = {
      protocolVersion: "1",
      operationId: "00000000-0000-4000-8000-000000000080",
      policyHash: authority.policyHash,
      wallet: selected.wallet,
      chainId: selected.chainId,
      operation: "reserve",
      payload: {
        reservation: {
          ...reservation(),
          debits: [{
            asset: "ASSET", purpose: "service", expectedAmount: "101", maximumAmount: "101",
          }],
        },
        options: {},
      },
    };
    const send = () => handler(new Request(
      "http://authority.test/v1/wallet-spend/operations",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ));

    const initial = await send();
    expect(initial.status).toBe(200);
    const retained = await initial.json() as Record<string, unknown>;
    expect(retained.result).toEqual({ status: "denied", reason: "per-order-limit" });
    const current = await send();
    expect(current.status).toBe(200);
    await expect(current.json()).resolves.toEqual(retained);

    inspectFails = true;
    const unavailable = await send();
    expect(unavailable.status).toBe(400);
    await expect(unavailable.json()).resolves.toEqual({
      reasonCode: "wallet-spend-authority-request-rejected",
    });
  });

  it("rejects a retained V1 reconcile response ahead of the authoritative head", async () => {
    const selected = policy();
    let now = 1_000;
    const createAuthority = () => createWalletSpendAuthorityV1(selected, {
      store: createInMemoryWalletSpendStateStore(),
      readBalance: async () => "1000",
      authenticateRecovery: async () => true,
      owner: "remote-service",
      leaseDurationMs: 60_000,
      now: () => now,
    });
    const authority = createAuthority();
    const behind = createAuthority();
    let activeAuthority = authority;
    const handler = createDacsWalletSpendAuthorityServiceV1({
      authenticate: (token) => token === TOKEN ? "buyer" : null,
      resolveAuthority: () => activeAuthority,
      operations: createInMemoryDacsWalletSpendRemoteOperationStoreV1(),
    });
    const item = reservation();
    const claim = await authority.reserve(item);
    if (claim.status !== "reserved") throw new Error("expected reservation");
    await claim.permit.beginEffect();
    now = 70_000;
    const body = {
      protocolVersion: "1",
      operationId: "00000000-0000-4000-8000-000000000081",
      policyHash: authority.policyHash,
      wallet: selected.wallet,
      chainId: selected.chainId,
      operation: "reconcile",
      payload: {
        reservation: item,
        observation: { disposition: "terminal-absent", evidenceHash: "e".repeat(64) },
      },
    };
    const send = () => handler(new Request(
      "http://authority.test/v1/wallet-spend/operations",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ));

    const initial = await send();
    expect(initial.status).toBe(200);
    const retained = await initial.json() as Record<string, unknown>;
    expect(retained.result).toBe("released");
    const current = await send();
    expect(current.status).toBe(200);
    await expect(current.json()).resolves.toEqual(retained);

    await expect(authority.reserve({
      ...reservation(), reservationId: "remote-two", jobId: "job-two",
    })).resolves.toMatchObject({ status: "reserved" });
    const ahead = await send();
    expect(ahead.status).toBe(200);
    await expect(ahead.json()).resolves.toEqual({ ...retained, revision: 4 });

    activeAuthority = behind;
    const rejected = await send();
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toEqual({
      reasonCode: "wallet-spend-authority-request-rejected",
    });
  });

  it("rejects an independently paired same-revision attester with a different state hash", async () => {
    const tokenFilePath = await tokenFile();
    const local = server();
    const selected = policy();
    const lineageKey = dacsWalletSpendLineageKeyV1(selected.wallet, selected.chainId);
    const reference = createInMemoryDacsWalletSpendContinuityWitnessV1({
      authorityId: "wallet-authority-production", epoch: "epoch-2026-09",
      seed: new Uint8Array(32).fill(22),
    });
    const syntheticHash = sha256Hex("unrelated-state-at-revision-zero");
    await reference.witness.compareAndSet({
      authorityId: "wallet-authority-production", epoch: "epoch-2026-09", lineageKey,
      predecessor: null, next: { revision: 0, stateHash: syntheticHash },
      candidateId: "00000000-0000-4000-8000-000000000074",
      roleId: "service:test", operationId: "00000000-0000-4000-8000-000000000075",
      requestHash: "4".repeat(64), mutationIndex: 0, clientNonce: "5".repeat(64),
    });
    const structurallyCompatibleStore = {
      ...createInMemoryWalletSpendStateStore(),
      lineageScope: () => lineageKey,
      async attestCurrent(binding: {
        operationId: string; requestHash: string; clientNonce: string;
      }) {
        const receipt = await reference.witness.readCurrent({
          authorityId: "wallet-authority-production", epoch: "epoch-2026-09",
          lineageKey, ...binding,
        });
        if (receipt === null) throw new Error("missing synthetic receipt");
        return receipt;
      },
    };
    expect(() => createDacsWalletSpendContinuityAuthorityV2({
      policy: selected,
      store: structurallyCompatibleStore,
      dependencies: {
        readBalance: async () => "1000",
        authenticateRecovery: async () => true,
      },
    })).toThrow(/official-store-required/);
    const handler = createDacsWalletSpendAuthorityServiceV2({
      authenticate: (token) => token === TOKEN ? "buyer" : null,
      // This was the vulnerable composition: an authority and a valid witness
      // attester with the same revision but unrelated state commitments.
      resolveAuthority: (() => ({
        authority: local.authority,
        attestCurrent: async (binding: {
          operationId: string; requestHash: string; clientNonce: string;
        }) => {
          const receipt = await reference.witness.readCurrent({
            authorityId: "wallet-authority-production", epoch: "epoch-2026-09",
            lineageKey, ...binding,
          });
          if (receipt === null) throw new Error("missing synthetic receipt");
          return receipt;
        },
      })) as never,
      operations: local.operations,
    });
    const remote = await createDacsRemoteWalletSpendAuthorityV2({
      policy: selected, endpoint: "http://127.0.0.1:8080/", tokenFilePath,
      authorityId: "wallet-authority-production", epoch: "epoch-2026-09",
      witnessVerificationKey: reference.verificationKey,
      allowInsecureLoopback: true, fetch: handlerFetch(handler),
    });
    await expect(remote.inspect()).rejects.toMatchObject({
      reasonCode: "wallet-spend-authority-lineage-unavailable",
    });
  });

  it("captures the exact store before a caller mutates the branded factory input", async () => {
    const tokenFilePath = await tokenFile();
    const local = await serverV2();
    const selected = policy();
    const lineageKey = dacsWalletSpendLineageKeyV1(selected.wallet, selected.chainId);
    const replacement = createInMemoryDacsWalletSpendContinuityWitnessV1({
      authorityId: local.authorityId,
      epoch: local.epoch,
      seed: new Uint8Array(32).fill(21),
    });
    await replacement.witness.compareAndSet({
      authorityId: local.authorityId, epoch: local.epoch, lineageKey,
      predecessor: null,
      next: { revision: 0, stateHash: sha256Hex("unrelated-branded-state") },
      candidateId: "00000000-0000-4000-8000-000000000076",
      roleId: "service:test", operationId: "00000000-0000-4000-8000-000000000077",
      requestHash: "6".repeat(64), mutationIndex: 0, clientNonce: "7".repeat(64),
    });
    let replacementAttestations = 0;
    local.bindingInput.store = {
      ...local.bindingInput.store,
      async attestCurrent(binding) {
        replacementAttestations += 1;
        const receipt = await replacement.witness.readCurrent({
          authorityId: local.authorityId, epoch: local.epoch, lineageKey, ...binding,
        });
        if (receipt === null) throw new Error("missing replacement receipt");
        return receipt;
      },
    };
    const remote = await createDacsRemoteWalletSpendAuthorityV2({
      policy: selected, endpoint: "http://127.0.0.1:8080/", tokenFilePath,
      authorityId: local.authorityId, epoch: local.epoch,
      witnessVerificationKey: local.verificationKey,
      allowInsecureLoopback: true, fetch: handlerFetch(local.handler),
    });
    await expect(remote.inspect()).resolves.toMatchObject({ revision: 0 });
    expect(replacementAttestations).toBe(0);
  });

  it.each(["signature", "authority", "epoch", "lineage"] as const)(
    "rejects a V2 proof with the wrong %s",
    async (tamper) => {
      const tokenFilePath = await tokenFile();
      const local = await serverV2();
      const corrupt = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await local.handler(new Request(input, init));
        if (!response.ok) return response;
        const body = await response.json() as Record<string, unknown>;
        const continuity = body.continuity as Record<string, unknown>;
        const changed = tamper === "signature"
          ? { ...continuity, signature: { algorithm: "ed25519", value: "A".repeat(86) } }
          : tamper === "authority"
            ? { ...continuity, authorityId: "replacement-authority" }
          : tamper === "epoch"
            ? { ...continuity, epoch: "wrong-epoch" }
            : { ...continuity, lineageKey: "f".repeat(64) };
        return new Response(JSON.stringify({ ...body, continuity: changed }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;
      const remote = await createDacsRemoteWalletSpendAuthorityV2({
        policy: policy(), endpoint: "http://127.0.0.1:8080/", tokenFilePath,
        authorityId: local.authorityId, epoch: local.epoch,
        witnessVerificationKey: local.verificationKey,
        allowInsecureLoopback: true, fetch: corrupt,
      });
      await expect(remote.inspect()).rejects.toMatchObject({
        reasonCode: "wallet-spend-authority-continuity-proof-invalid",
      });
    },
  );

  it("rejects a replayed V2 proof bound to another operation and nonce", async () => {
    const tokenFilePath = await tokenFile();
    const local = await serverV2();
    let retained: Response | undefined;
    const replay = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await local.handler(new Request(input, init));
      if (retained === undefined && response.ok) {
        retained = new Response(await response.clone().arrayBuffer(), {
          status: response.status,
          headers: response.headers,
        });
        return response;
      }
      return retained!.clone();
    }) as typeof fetch;
    const remote = await createDacsRemoteWalletSpendAuthorityV2({
      policy: policy(), endpoint: "http://127.0.0.1:8080/", tokenFilePath,
      authorityId: local.authorityId, epoch: local.epoch,
      witnessVerificationKey: local.verificationKey,
      allowInsecureLoopback: true, fetch: replay,
    });
    await remote.inspect();
    await expect(remote.inspect()).rejects.toMatchObject({
      reasonCode: "wallet-spend-authority-continuity-proof-invalid",
    });
  });

  it("does not downgrade a generated-style V2 client to a V1 endpoint", async () => {
    const tokenFilePath = await tokenFile();
    const legacy = server();
    const reference = createInMemoryDacsWalletSpendContinuityWitnessV1({
      authorityId: "wallet-authority-production", epoch: "epoch-2026-09",
      seed: new Uint8Array(32).fill(21),
    });
    const remote = await createDacsRemoteWalletSpendAuthorityV2({
      policy: policy(), endpoint: "http://127.0.0.1:8080/", tokenFilePath,
      authorityId: "wallet-authority-production", epoch: "epoch-2026-09",
      witnessVerificationKey: reference.verificationKey,
      allowInsecureLoopback: true, fetch: handlerFetch(legacy.handler),
    });
    await expect(remote.inspect()).rejects.toMatchObject({
      reasonCode: "wallet-spend-authority-route-not-found",
    });
  });

  it("preserves the authority interface while revisions advance for each mutation", async () => {
    const tokenFilePath = await tokenFile();
    const local = server();
    const remote = await createDacsRemoteWalletSpendAuthorityV1({
      policy: policy(),
      endpoint: "http://127.0.0.1:8080/",
      tokenFilePath,
      allowInsecureLoopback: true,
      fetch: handlerFetch(local.handler),
    });

    const claim = await remote.reserve(reservation());
    expect(claim.status).toBe("reserved");
    if (claim.status !== "reserved") throw new Error("expected reservation");
    expect((await remote.inspect()).revision).toBe(1);
    await claim.permit.beginEffect();
    expect((await remote.inspect()).revision).toBe(2);
    await claim.permit.settle({
      disposition: "settled",
      evidenceHash: "d".repeat(64),
      debits: [{ asset: "ASSET", purpose: "service", amount: "25" }],
    });
    expect(await remote.inspect()).toMatchObject({
      revision: 3,
      activeEffects: 0,
      assets: [{ cumulativeSettledDebit: "25" }],
    });
  });

  it("resolves a lost mutation response by exact operation identity without replaying it", async () => {
    const tokenFilePath = await tokenFile();
    const local = server();
    let loseFirstResponse = true;
    const fetchWithLoss = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const response = await local.handler(request);
      if (request.method === "POST" && loseFirstResponse) {
        loseFirstResponse = false;
        throw new Error("response lost after commit");
      }
      return response;
    }) as typeof fetch;
    const remote = await createDacsRemoteWalletSpendAuthorityV1({
      policy: policy(),
      endpoint: "http://127.0.0.1:8080/",
      tokenFilePath,
      allowInsecureLoopback: true,
      fetch: fetchWithLoss,
    });

    expect((await remote.reserve(reservation())).status).toBe("reserved");
    expect((await remote.inspect()).revision).toBe(1);
  });

  it("resumes exact pending begin and settlement operations after head advancement", async () => {
    const tokenFilePath = await tokenFile();
    const local = server();
    let failNextCompletion = false;
    const handler = createDacsWalletSpendAuthorityServiceV1({
      authenticate: (token) => token === TOKEN ? "buyer" : null,
      resolveAuthority: ({ policyHash }) =>
        policyHash === local.authority.policyHash ? local.authority : null,
      operations: {
        load: (input) => local.operations.load(input),
        claim: (input) => local.operations.claim(input),
        complete: async (input) => {
          if (failNextCompletion) {
            failNextCompletion = false;
            throw new Error("result persistence interrupted");
          }
          await local.operations.complete(input);
        },
      },
    });
    const remote = await createDacsRemoteWalletSpendAuthorityV1({
      policy: policy(),
      endpoint: "http://127.0.0.1:8080/",
      tokenFilePath,
      allowInsecureLoopback: true,
      fetch: handlerFetch(handler),
    });
    const claim = await remote.reserve(reservation());
    if (claim.status !== "reserved") throw new Error("expected reservation");
    failNextCompletion = true;
    await claim.permit.beginEffect();
    failNextCompletion = true;
    await claim.permit.settle({
      disposition: "settled",
      evidenceHash: "d".repeat(64),
      debits: [{ asset: "ASSET", purpose: "service", amount: "25" }],
    });
    expect(await remote.inspect()).toMatchObject({
      revision: 3,
      assets: [{ cumulativeSettledDebit: "25" }],
    });
  });

  it.each([
    ["malformed", () => new Response("{", {
      status: 200,
      headers: { "content-type": "application/json", "content-length": "1" },
    })],
    ["oversize", () => new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json", "content-length": "65537" },
    })],
    ["truncated", () => new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json", "content-length": "3" },
    })],
  ])("recovers a %s mutation response through exact operation identity", async (_label, corrupt) => {
    const tokenFilePath = await tokenFile();
    const local = server();
    let corruptFirstMutation = true;
    const fetchWithCorruptResponse = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const request = new Request(input, init);
      const response = await local.handler(request);
      if (request.method === "POST" && corruptFirstMutation) {
        corruptFirstMutation = false;
        return corrupt();
      }
      return response;
    }) as typeof fetch;
    const remote = await createDacsRemoteWalletSpendAuthorityV1({
      policy: policy(),
      endpoint: "http://127.0.0.1:8080/",
      tokenFilePath,
      allowInsecureLoopback: true,
      fetch: fetchWithCorruptResponse,
    });

    expect((await remote.reserve(reservation())).status).toBe("reserved");
    expect((await remote.inspect()).revision).toBe(1);
  });

  it("keeps inspect read-only and fails closed for unavailable or stale authority", async () => {
    const tokenFilePath = await tokenFile();
    const local = server();
    const calls = { load: 0, claim: 0, complete: 0 };
    const observed = createDacsWalletSpendAuthorityServiceV1({
      authenticate: (token) => token === TOKEN ? "buyer" : null,
      resolveAuthority: ({ policyHash }) =>
        policyHash === local.authority.policyHash ? local.authority : null,
      operations: {
        load: async (input) => {
          calls.load += 1;
          return local.operations.load(input);
        },
        claim: async (input) => {
          calls.claim += 1;
          return local.operations.claim(input);
        },
        complete: async (input) => {
          calls.complete += 1;
          return local.operations.complete(input);
        },
      },
    });
    const remote = await createDacsRemoteWalletSpendAuthorityV1({
      policy: policy(),
      endpoint: "http://127.0.0.1:8080/",
      tokenFilePath,
      allowInsecureLoopback: true,
      fetch: handlerFetch(observed),
    });
    await remote.inspect();
    expect(calls).toEqual({ load: 1, claim: 0, complete: 0 });

    const unavailable = await createDacsRemoteWalletSpendAuthorityV1({
      policy: policy("unprovisioned"),
      endpoint: "http://127.0.0.1:8080/",
      tokenFilePath,
      allowInsecureLoopback: true,
      fetch: handlerFetch(local.handler),
    });
    await expect(unavailable.inspect()).rejects.toMatchObject({
      reasonCode: "wallet-spend-authority-lineage-unavailable",
    });

    let stale = false;
    const staleFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await local.handler(new Request(input, init));
      if (!stale || !response.ok) return response;
      const body = await response.json() as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, revision: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const freshness = await createDacsRemoteWalletSpendAuthorityV1({
      policy: policy(), endpoint: "http://127.0.0.1:8080/", tokenFilePath,
      allowInsecureLoopback: true, fetch: staleFetch,
    });
    const reserved = await freshness.reserve({ ...reservation(), reservationId: "freshness" });
    expect(reserved.status).toBe("reserved");
    stale = true;
    await expect(freshness.inspect()).rejects.toBeInstanceOf(DacsWalletSpendRemoteError);
  });

  it("rejects non-HTTPS endpoints unless explicit loopback test mode is selected", async () => {
    const tokenFilePath = await tokenFile();
    await expect(createDacsRemoteWalletSpendAuthorityV1({
      policy: policy(), endpoint: "http://example.test/", tokenFilePath,
    })).rejects.toMatchObject({ reasonCode: "wallet-spend-authority-tls-required" });
    await expect(createDacsRemoteWalletSpendAuthorityV1({
      policy: policy(), endpoint: "http://192.0.2.10/", tokenFilePath,
      allowInsecureLoopback: true,
    })).rejects.toMatchObject({ reasonCode: "wallet-spend-authority-tls-required" });
  });
});
