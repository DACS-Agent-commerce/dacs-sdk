import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createInMemoryWalletSpendStateStore,
  createWalletSpendAuthorityV1,
  type WalletSpendPolicyV1,
  type WalletSpendReservationV1,
} from "@kynesyslabs/dacs";

import {
  createDacsRemoteWalletSpendAuthorityV1,
  createDacsWalletSpendAuthorityServiceV1,
  createInMemoryDacsWalletSpendRemoteOperationStoreV1,
  DacsWalletSpendRemoteError,
} from "../src/walletSpendRemote.js";

const roots: string[] = [];
const HASH = "a".repeat(64);
const TOKEN = "role-scoped-test-token-which-is-long-enough";

afterEach(async () => {
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

function server() {
  const localPolicy = policy();
  const authority = createWalletSpendAuthorityV1(localPolicy, {
    store: createInMemoryWalletSpendStateStore(),
    readBalance: async () => "1000",
    authenticateRecovery: async () => true,
    owner: "remote-service",
    leaseDurationMs: 60_000,
    now: () => 1_000,
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

function handlerFetch(
  handler: (request: Request) => Promise<Response>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(new Request(input, init))) as typeof fetch;
}

describe("remote PostgreSQL wallet authority boundary", () => {
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
