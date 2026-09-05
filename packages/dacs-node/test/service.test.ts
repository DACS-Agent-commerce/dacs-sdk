import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ed25519Sign,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
} from "@kynesyslabs/dacs/crypto";
import {
  FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
  FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
  FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  type FixedPriceX402CoordinatorRole,
  type FixedPricePayDemOperations,
  type FixedPricePayDemOrderInput,
  type FixedPricePayDemProtocolBinding,
  type FixedPriceX402Operations,
  type FixedPriceX402OrderInput,
  type FixedPriceX402ProtocolBinding,
  type FixedPriceX402TrackOperation,
} from "@kynesyslabs/dacs/commerce";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DACS_NODE_LIVE_PROFILE,
  createDacsBuyerServiceV1,
  createDacsSellerServiceV1,
  createDacsX402ApplicationRequestHandlerV1,
  type DacsAgentConfig,
} from "../src/index.js";
import {
  DacsLiveRoleServiceError,
  type DacsLiveRoleServiceOptionsV1,
  type DacsLiveRoleServiceV1,
} from "../src/service.js";
import {
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";
import {
  createDacsHttpEnvelopeV1,
  type DacsHttpIdentityResolverV1,
} from "../src/transport/envelope.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER_SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const SELLER_SEED = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const OTHER_SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 33);
const BUYER_KEY = privateKeyFromSeed(BUYER_SEED);
const SELLER_KEY = privateKeyFromSeed(SELLER_SEED);
const OTHER_KEY = privateKeyFromSeed(OTHER_SEED);
const BUYER_PUBLIC = rawPublicKey(publicKeyFromSeed(BUYER_SEED));
const SELLER_PUBLIC = rawPublicKey(publicKeyFromSeed(SELLER_SEED));
const OTHER_PUBLIC = rawPublicKey(publicKeyFromSeed(OTHER_SEED));
const BUYER = `did:demos:agent:${Buffer.from(BUYER_PUBLIC).toString("hex")}`;
const SELLER = `did:demos:agent:${Buffer.from(SELLER_PUBLIC).toString("hex")}`;
const OTHER = `did:demos:agent:${Buffer.from(OTHER_PUBLIC).toString("hex")}`;

const PROTOCOL: FixedPriceX402ProtocolBinding = {
  commerceProfile: FIXED_PRICE_X402_COMMERCE_PROFILE,
  standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
  phase: "pay-x402",
  orchestratorTopology: "seller-as-phase-orchestrator-v1",
  orchestrator: SELLER,
  rail: {
    registryIndexRef: FIXED_PRICE_X402_REGISTRY_INDEX_REF,
    registryIndexHash: "1".repeat(64),
    railDefinitionRef: "dacs4:rail:x402%3Adefault:2",
    railDefinitionHash: "2".repeat(64),
    railId: "x402:default",
    railVersion: 2,
    railType: "x402",
    phaseHandler: "pay-x402",
    network: "eip155:8453",
    availability: "live",
  },
};

const PAY_DEM_PROTOCOL: FixedPricePayDemProtocolBinding = {
  commerceProfile: FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
  standardRevision: FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
  phase: "pay-dem",
  orchestratorTopology: "seller-as-phase-orchestrator-v1",
  orchestrator: SELLER,
  rail: {
    registryIndexRef: FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
    registryIndexHash: "3".repeat(64),
    railDefinitionRef: "dacs4:rail:demos-native%3ADEM:1",
    railDefinitionHash: "4".repeat(64),
    railId: "demos-native:DEM",
    railVersion: 1,
    railType: "demos-native",
    phaseHandler: "pay-dem",
    network: "demos",
    availability: "live",
  },
};

function config(role: "buyer" | "seller"): DacsAgentConfig {
  return {
    mode: "live-demos",
    profile: DACS_NODE_LIVE_PROFILE,
    role,
    dataDirectory: `/tmp/dacs-service-${role}`,
    demos: { rpcUrl: "http://127.0.0.1:5350" },
    rail: {
      registryIndexRef: FIXED_PRICE_X402_REGISTRY_INDEX_REF,
      requestedNetwork: "eip155:8453",
    },
    limits: {
      maxServiceAmount: { asset: "USDC", amount: "1" },
      maxSetupSpendDem: "1",
      maxDemosNetworkFeeDem: "1",
      maxEvmNetworkFeeEth: "0.01",
    },
  };
}

function identityResolver(): DacsHttpIdentityResolverV1 {
  return async (input) => {
    const identities = [
      { authority: BUYER, role: "buyer" as const, publicKey: BUYER_PUBLIC, hash: "a" },
      { authority: SELLER, role: "seller" as const, publicKey: SELLER_PUBLIC, hash: "b" },
      { authority: OTHER, role: "buyer" as const, publicKey: OTHER_PUBLIC, hash: "c" },
    ];
    const identity = identities.find(({ authority }) =>
      input.sender === authority || input.sender.startsWith(`${authority}?`));
    if (identity === undefined) {
      return { status: "rejected", reasonCode: "identity-unresolved" };
    }
    return {
      status: "authenticated",
      principal: identity.authority,
      jobId: input.jobId,
      role: identity.role,
      publicKey: identity.publicKey,
      evidenceHash: identity.hash.repeat(64),
    };
  };
}

function order(role: FixedPriceX402CoordinatorRole): FixedPriceX402OrderInput {
  return {
    jobId: JOB_ID,
    buyer: BUYER,
    seller: SELLER,
    protocol: PROTOCOL,
    sdkJobs: role === "buyer"
      ? {
          role,
          agreement: `buyer:agreement:${JOB_ID}`,
          payment: `buyer:payment:${JOB_ID}`,
          paymentEvidence: `buyer:payment-evidence:${JOB_ID}`,
          buyerReceived: `buyer:received:${JOB_ID}`,
          audit: `buyer:audit:${JOB_ID}`,
        }
      : {
          role,
          agreement: `seller:agreement:${JOB_ID}`,
          payment: `seller:payment:${JOB_ID}`,
          paymentEvidence: `seller:payment-evidence:${JOB_ID}`,
          fulfilment: `seller:fulfilment:${JOB_ID}`,
          deliveryEvidence: `seller:delivery-evidence:${JOB_ID}`,
          audit: `seller:audit:${JOB_ID}`,
        },
  };
}

function payDemOrder(role: FixedPriceX402CoordinatorRole): FixedPricePayDemOrderInput {
  return {
    ...order(role),
    protocol: PAY_DEM_PROTOCOL,
  };
}

const finalOperation = (track: string): FixedPriceX402TrackOperation =>
  async ({ fence }) => {
    await fence.assertCurrent();
    return {
      status: "final",
      outcome: "success",
      reference: `${track}:${fence.jobId}`,
    };
  };

function operations(role: "buyer" | "seller"): FixedPriceX402Operations {
  const common: FixedPriceX402Operations = {
    agreement: finalOperation("agreement"),
    payment: finalOperation("payment"),
    "payment-evidence": finalOperation("payment-evidence"),
    audit: finalOperation("audit"),
  };
  return role === "buyer"
    ? { ...common, "buyer-received": finalOperation("buyer-received") }
    : {
        ...common,
        delivery: finalOperation("delivery"),
        "delivery-evidence": finalOperation("delivery-evidence"),
      };
}

function payDemOperations(role: "buyer" | "seller"): FixedPricePayDemOperations {
  return operations(role) as unknown as FixedPricePayDemOperations;
}

describe("authority-separated live role services", () => {
  const roots: string[] = [];
  const databases: DacsNodeSqliteDatabase[] = [];
  const services: DacsLiveRoleServiceV1[] = [];

  function root(): string {
    const value = mkdtempSync(join(tmpdir(), "dacs-role-service-"));
    roots.push(value);
    return value;
  }

  async function open(
    directory: string,
    role: "buyer" | "seller",
  ): Promise<DacsNodeSqliteDatabase> {
    const database = await openDacsNodeSqliteDatabase({
      databasePath: join(directory, `${role}.sqlite`),
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role,
      authority: role === "buyer" ? BUYER : SELLER,
    });
    databases.push(database);
    return database;
  }

  function advanceStoreClock(databasePath: string, value: number): void {
    const raw = new BetterSqlite3(databasePath);
    raw.prepare("UPDATE dacs_http_clock SET last_time = ? WHERE singleton = 1")
      .run(value);
    raw.close();
  }

  function options(
    role: "buyer" | "seller",
    database: DacsNodeSqliteDatabase,
    peerEndpoint = "http://127.0.0.1:1/dacs-transport/v1/messages",
    overrides: Partial<DacsLiveRoleServiceOptionsV1> = {},
  ): DacsLiveRoleServiceOptionsV1 {
    return {
      config: config(role),
      database,
      workerId: `${role}-worker`,
      peerAuthority: role === "buyer" ? SELLER : BUYER,
      peerEndpoint,
      resolveIdentity: identityResolver(),
      validatePayload: async () => ({ status: "valid" }),
      signTransportEnvelope: (bytes) =>
        ed25519Sign(bytes, role === "buyer" ? BUYER_KEY : SELLER_KEY),
      createOperations: () => operations(role),
      handleMessage: async () => ({ disposition: "accepted" }),
      readiness: () => ({ ready: true, checkedAt: Date.now(), reasonCodes: [] }),
      workerIntervalMs: 60_000,
      server: { hostname: "127.0.0.1", port: 0 },
      ...overrides,
    };
  }

  function remember(service: Readonly<DacsLiveRoleServiceV1>): DacsLiveRoleServiceV1 {
    services.push(service);
    return service;
  }

  afterEach(async () => {
    for (const service of services.splice(0).reverse()) await service.stop();
    for (const database of databases.splice(0).reverse()) database.close();
    for (const directory of roots.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on role, database, and authority separation mismatches", async () => {
    const buyerDatabase = await open(root(), "buyer");
    expect(() => createDacsSellerServiceV1(options("buyer", buyerDatabase)))
      .toThrow(/seller configuration/);
    expect(() => createDacsBuyerServiceV1({
      ...options("buyer", buyerDatabase),
      peerAuthority: BUYER,
    })).toThrow(/options are invalid/);
    expect(() => createDacsBuyerServiceV1({
      ...options("buyer", buyerDatabase),
      coordinatorLeaseDurationMs: 0,
    })).toThrow(/options are invalid/);
    expect(() => createDacsBuyerServiceV1({
      ...options("buyer", buyerDatabase),
      coordinatorLeaseDurationMs: 600_001,
    })).toThrow(/options are invalid/);
    const sellerDatabase = await open(root(), "seller");
    expect(() => createDacsBuyerServiceV1({
      ...options("buyer", buyerDatabase),
      database: sellerDatabase,
    })).toThrow(/database binding/);
  });

  it("runs native DEM orders without installing an x402 coordinator", async () => {
    const database = await open(root(), "buyer");
    const service = remember(createDacsBuyerServiceV1(options(
      "buyer",
      database,
      undefined,
      {
        createOperations: undefined,
        createPayDemOperations: () => payDemOperations("buyer"),
      },
    )));
    await service.start();
    expect(service.coordinator.profiles).toEqual(["pay-dem"]);

    await service.startOrder(payDemOrder("buyer"));
    await service.runOnce();

    await expect(service.getOrderStatus(JOB_ID)).resolves.toMatchObject({
      protocol: { phase: "pay-dem" },
      milestone: "actor-audit-final",
    });
    await expect(service.startOrder({
      ...order("buyer"),
      jobId: `${JOB_ID.slice(0, -1)}E`,
    })).rejects.toMatchObject({
      reasonCode: "multirail-profile-disabled",
    });
  });

  it("captures only closed data options without invoking accessors", async () => {
    const database = await open(root(), "buyer");
    const accessor = options("buyer", database) as DacsLiveRoleServiceOptionsV1;
    const invoked = vi.fn(() => "http://127.0.0.1:1/dacs-transport/v1/messages");
    Object.defineProperty(accessor, "peerEndpoint", {
      enumerable: true,
      get: invoked,
    });
    expect(() => createDacsBuyerServiceV1(accessor)).toThrow(/closed data objects/);
    expect(invoked).not.toHaveBeenCalled();
    expect(() => createDacsBuyerServiceV1({
      ...options("buyer", database),
      unexpectedAuthorityOverride: SELLER,
    } as DacsLiveRoleServiceOptionsV1)).toThrow(/closed data objects/);
  });

  it("exposes sanitized liveness, readiness, and status without actor authority", async () => {
    const database = await open(root(), "seller");
    const service = remember(createDacsSellerServiceV1(options("seller", database, undefined, {
      readiness: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { ready: true, checkedAt: Date.now(), reasonCodes: [] };
      },
    })));
    await service.start();

    const health = await fetch(new URL("/health", service.endpoint));
    const ready = await fetch(new URL("/ready", service.endpoint));
    const status = await fetch(new URL("/status", service.endpoint));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "healthy" });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ ready: true, reasonCodes: [] });
    expect(status.status).toBe(200);
    const projected = await status.json();
    expect(projected).toMatchObject({
      role: "seller",
      lifecycle: "running",
      commerce: {
        status: "blocked",
        reasonCode: "commerce-capability-unreported",
      },
    });
    expect(JSON.stringify(projected)).not.toContain(BUYER);
    expect(JSON.stringify(projected)).not.toContain(SELLER);

    await service.stop();
    await expect(service.health()).resolves.toMatchObject({ status: "unhealthy" });
  });

  it("defaults readiness to fail-closed until the live adapter latches", async () => {
    const database = await open(root(), "seller");
    const service = remember(createDacsSellerServiceV1(options(
      "seller",
      database,
      undefined,
      { readiness: undefined },
    )));
    await service.start();
    const response = await fetch(new URL("/ready", service.endpoint));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ready: false,
      reasonCodes: ["service-readiness-not-latched"],
    });
  });

  it("gates a seller application route on the live readiness latch", async () => {
    const database = await open(root(), "seller");
    let ready = false;
    const handled = vi.fn(async (_request, response) => {
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end('{"paidResource":"test"}');
      return true;
    });
    const service = remember(createDacsSellerServiceV1(options("seller", database,
      undefined, {
        readiness: () => ({ ready, checkedAt: Date.now(),
          reasonCodes: ready ? [] : ["live-adapter-not-ready"] }),
        handleApplicationRequest: handled,
      })));
    await service.start();

    const blocked = await fetch(new URL("/deliver/test", service.endpoint));
    expect(blocked.status).toBe(503);
    await expect(blocked.json()).resolves.toEqual({ error: "service-not-ready" });
    expect(handled).not.toHaveBeenCalled();

    ready = true;
    const delivered = await fetch(new URL("/deliver/test", service.endpoint));
    expect(delivered.status).toBe(200);
    await expect(delivered.json()).resolves.toEqual({ paidResource: "test" });
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it("serves read-only public metadata without weakening the commerce gate", async () => {
    const database = await open(root(), "seller");
    const publicHandler = vi.fn(async (request, response) => {
      if (request.url !== "/.well-known/agent.json") return false;
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end('{"dacs":{"dacsVersion":"1"}}');
      return true;
    });
    const applicationHandler = vi.fn(async () => true);
    const service = remember(createDacsSellerServiceV1(options("seller", database,
      undefined, {
        readiness: () => ({ ready: false, checkedAt: Date.now(),
          reasonCodes: ["live-adapter-not-ready"] }),
        handlePublicRequest: publicHandler,
        handleApplicationRequest: applicationHandler,
      })));
    await service.start();

    const metadata = await fetch(new URL("/.well-known/agent.json", service.endpoint));
    expect(metadata.status).toBe(200);
    await expect(metadata.json()).resolves.toEqual({ dacs: { dacsVersion: "1" } });
    expect(publicHandler).toHaveBeenCalledTimes(1);
    expect(applicationHandler).not.toHaveBeenCalled();

    const commerce = await fetch(new URL("/deliver/test", service.endpoint));
    expect(commerce.status).toBe(503);
    expect(publicHandler).toHaveBeenCalledTimes(2);
    expect(applicationHandler).not.toHaveBeenCalled();

    const write = await fetch(new URL("/.well-known/agent.json", service.endpoint), {
      method: "POST",
    });
    expect(write.status).toBe(405);
    expect(publicHandler).toHaveBeenCalledTimes(2);
  });

  it("adapts an advertised seller resource to the framework-neutral x402 paywall", async () => {
    const database = await open(root(), "seller");
    const observeResult = vi.fn();
    const paywallHandle = vi.fn(async (input) => {
      expect(input.jobId).toBe(JOB_ID);
      expect(input.phaseIndex).toBe(2);
      expect(input.request.getMethod()).toBe("GET");
      expect(input.request.getPath()).toBe(`/deliver/${JOB_ID}/2`);
      expect(input.request.getUrl()).toBe(
        `http://localhost/deliver/${JOB_ID}/2?format=json`,
      );
      expect(input.request.getHeader("PAYMENT-SIGNATURE")).toBe("retained-bearer");
      return {
        disposition: "payment-required" as const,
        settled: false as const,
        reason: "payment-required",
        response: {
          status: 402,
          headers: { "PAYMENT-REQUIRED": "challenge" },
          body: { payment: "required" },
        },
      };
    });
    const application = createDacsX402ApplicationRequestHandlerV1({
      publicBaseUrl: "http://localhost",
      paywall: {
        terms: {
          network: "eip155:8453",
          payTo: `0x${"22".repeat(20)}`,
          amount: "1",
          asset: `0x${"33".repeat(20)}`,
          eip712: { name: "USDC", version: "2" },
        },
        handle: paywallHandle,
      },
      resolveRequest: ({ method, pathname }) => method === "GET" &&
          pathname === `/deliver/${JOB_ID}/2`
        ? { status: "matched", jobId: JOB_ID, phaseIndex: 2 }
        : { status: "not-matched" },
      observeResult,
    });
    const service = remember(createDacsSellerServiceV1(options("seller", database,
      undefined, {
        readiness: () => ({ ready: true, checkedAt: Date.now(), reasonCodes: [] }),
        handleApplicationRequest: application,
      })));
    await service.start();

    const response = await fetch(
      new URL(`/deliver/${JOB_ID}/2?format=json`, service.endpoint),
      { headers: { "PAYMENT-SIGNATURE": "retained-bearer" } },
    );
    expect(response.status).toBe(402);
    expect(response.headers.get("payment-required")).toBe("challenge");
    await expect(response.json()).resolves.toEqual({ payment: "required" });
    expect(paywallHandle).toHaveBeenCalledTimes(1);
    expect(observeResult).toHaveBeenCalledWith({
      jobId: JOB_ID,
      phaseIndex: 2,
      paymentPresented: true,
      disposition: "payment-required",
      settled: false,
      reason: "payment-required",
      responseStatus: 402,
    });
  });

  it("rejects a stale successful readiness latch", async () => {
    const database = await open(root(), "seller");
    const service = remember(createDacsSellerServiceV1(options("seller", database,
      undefined, {
        readiness: () => ({ ready: true, checkedAt: 1, reasonCodes: [] }),
        readinessMaxAgeMs: 1_000,
      })));
    await service.start();
    const response = await fetch(new URL("/ready", service.endpoint));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ready: false,
      reasonCodes: ["service-readiness-stale"],
    });
  });

  it("authenticates buyer-to-seller messages and admits each envelope once", async () => {
    const directory = root();
    const sellerDatabase = await open(directory, "seller");
    const buyerDatabase = await open(directory, "buyer");
    const handled = vi.fn(async () => ({ disposition: "accepted" as const }));
    const seller = remember(createDacsSellerServiceV1(options("seller", sellerDatabase,
      undefined, { handleMessage: handled })));
    await seller.start();
    const buyer = remember(createDacsBuyerServiceV1(options(
      "buyer",
      buyerDatabase,
      seller.endpoint,
    )));
    await buyer.start();

    const message = {
      type: "agreement-proposal",
      jobId: JOB_ID,
      payload: {
        proposal: { jobId: JOB_ID, label: "role-service-test" },
        transportIdentity: { sender: BUYER, audience: SELLER },
      } as never,
      idempotencyKey: `agreement-proposal:${JOB_ID}:test`,
    } as const;
    const acknowledgement = await buyer.sendMessage(message);
    const replayAcknowledgement = await buyer.sendMessage(message);

    expect(acknowledgement.envelope.payload).toMatchObject({
      disposition: "accepted",
    });
    expect(replayAcknowledgement).toEqual(acknowledgement);
    expect(handled).toHaveBeenCalledTimes(1);
    await expect(buyer.sendMessage({
      ...message,
      payload: {
        proposal: { jobId: JOB_ID, label: "substituted" },
        transportIdentity: { sender: BUYER, audience: SELLER },
      } as never,
    })).rejects.toEqual(
      new DacsLiveRoleServiceError("service-message-idempotency-conflict"),
    );
    await buyer.runOnce();
    expect(handled).toHaveBeenCalledTimes(1);

    await buyer.stop();
    services.splice(services.indexOf(buyer), 1);
    buyerDatabase.close();
    databases.splice(databases.indexOf(buyerDatabase), 1);
    const reopenedBuyerDatabase = await open(directory, "buyer");
    const recoveredBuyer = remember(createDacsBuyerServiceV1(options(
      "buyer",
      reopenedBuyerDatabase,
      seller.endpoint,
    )));
    await recoveredBuyer.start();
    await expect(recoveredBuyer.sendMessage(message)).resolves.toEqual(acknowledgement);
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it("renews an expired unacknowledged semantic message after a restart", async () => {
    const directory = root();
    const databasePath = join(directory, "buyer.sqlite");
    const buyerDatabase = await open(directory, "buyer");
    const buyer = remember(createDacsBuyerServiceV1(options(
      "buyer",
      buyerDatabase,
      "http://127.0.0.1:1/dacs-transport/v1/messages",
    )));
    await buyer.start();
    const message = {
      type: "agreement-proposal",
      jobId: JOB_ID,
      payload: {
        proposal: { jobId: JOB_ID, label: "renewal-test" },
        transportIdentity: { sender: BUYER, audience: SELLER },
      } as never,
      idempotencyKey: `agreement-proposal:${JOB_ID}:renewal-test`,
      lifetimeMs: 1_000,
    } as const;
    await expect(buyer.sendMessage(message)).rejects.toBeDefined();
    advanceStoreClock(databasePath, buyerDatabase.readTime() + 2_000);
    await expect(buyer.sendMessage(message)).rejects.toBeDefined();

    const raw = new BetterSqlite3(databasePath, { readonly: true });
    const intents = raw.prepare(`
      SELECT COUNT(*) AS count
      FROM dacs_effects
      WHERE effect_kind = 'session' AND job_id = ?
        AND json_extract(input_json, '$.intentVersion') = '1'
    `).get(JOB_ID) as { count: number };
    const envelopes = raw.prepare(`
      SELECT COUNT(DISTINCT envelope_id) AS count
      FROM dacs_http_outbox
      WHERE job_id = ?
    `).get(JOB_ID) as { count: number };
    raw.close();
    expect(intents.count).toBe(2);
    expect(envelopes.count).toBe(2);
  });

  it("handles reserved transport diagnostics without invoking application work", async () => {
    const directory = root();
    const sellerDatabase = await open(directory, "seller");
    const buyerDatabase = await open(directory, "buyer");
    const handled = vi.fn(async () => ({ disposition: "accepted" as const }));
    const seller = remember(createDacsSellerServiceV1(options("seller", sellerDatabase,
      undefined, { handleMessage: handled })));
    await seller.start();
    const buyer = remember(createDacsBuyerServiceV1(options("buyer", buyerDatabase,
      seller.endpoint)));
    await buyer.start();
    await expect(buyer.sendMessage({
      type: "diagnostic-probe-buyer",
      jobId: JOB_ID,
      payload: {
        purpose: "transport-readiness",
        challenge: Buffer.alloc(32, 7).toString("base64url"),
      },
    })).resolves.toMatchObject({
      envelope: { payload: { disposition: "accepted" } },
    });
    expect(handled).not.toHaveBeenCalled();
  });

  it("rejects an authenticated but unconfigured peer before durable handling", async () => {
    const database = await open(root(), "seller");
    const handled = vi.fn(async () => ({ disposition: "accepted" as const }));
    const seller = remember(createDacsSellerServiceV1(options("seller", database,
      undefined, { handleMessage: handled })));
    await seller.start();
    const now = database.readTime();
    const envelope = await createDacsHttpEnvelopeV1({
      type: "agreement-proposal",
      jobId: JOB_ID,
      sender: OTHER,
      audience: SELLER,
      issuedAt: now,
      expiresAt: now + 60_000,
      nonce: Buffer.alloc(32, 9).toString("base64url"),
      payload: {
        proposal: { jobId: JOB_ID, label: "wrong-peer" },
        transportIdentity: { sender: OTHER, audience: SELLER },
      } as never,
    }, (bytes) => ed25519Sign(bytes, OTHER_KEY));

    const response = await fetch(seller.endpoint!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    expect(response.status).toBe(401);
    expect(handled).not.toHaveBeenCalled();
  });

  it("runs role-owned coordinator tracks and emits only bounded progress", async () => {
    const database = await open(root(), "buyer");
    const events: unknown[] = [];
    const service = remember(createDacsBuyerServiceV1(options("buyer", database,
      undefined, { events: { emit: (event) => void events.push(event) } })));
    await service.start();
    await service.startOrder(order("buyer"));
    await service.runOnce();

    await expect(service.getOrderStatus(JOB_ID)).resolves.toMatchObject({
      milestone: "actor-audit-final",
    });
    const serialized = JSON.stringify(events);
    expect(serialized).toContain(JOB_ID);
    expect(serialized).not.toContain(BUYER);
    expect(serialized).not.toContain(SELLER);
  });

  it("does not resume durable work before readiness and deduplicates unchanged progress", async () => {
    const directory = root();
    const databasePath = join(directory, "buyer.sqlite");
    const database = await open(directory, "buyer");
    let ready = false;
    const agreement = vi.fn<FixedPriceX402TrackOperation>(async ({ fence }) => {
      await fence.assertCurrent();
      return {
        status: "pending-retry",
        reasonCode: "counterparty-pending",
        retryAt: database.readTime() + 1,
      };
    });
    const events: unknown[] = [];
    const service = remember(createDacsBuyerServiceV1(options(
      "buyer",
      database,
      undefined,
      {
        readiness: () => ({
          ready,
          checkedAt: Date.now(),
          reasonCodes: ready ? [] : ["live-adapter-not-ready"],
        }),
        createOperations: () => ({ ...operations("buyer"), agreement }),
        events: { emit: (event) => void events.push(event) },
      },
    )));
    await service.start();
    await service.startOrder(order("buyer"));
    await service.runOnce();
    expect(agreement).not.toHaveBeenCalled();

    ready = true;
    await service.runOnce();
    expect(agreement).toHaveBeenCalledTimes(1);
    advanceStoreClock(databasePath, database.readTime() + 2);
    await service.runOnce();
    expect(agreement).toHaveBeenCalledTimes(2);
    const progress = events.filter((event) =>
      JSON.stringify(event).includes('"code":"order-track-processed"'));
    expect(progress).toHaveLength(1);
  });

  it("resumes an unfinished order from the actor database after service restart", async () => {
    const directory = root();
    const databasePath = join(directory, "buyer.sqlite");
    let database = await open(directory, "buyer");
    const pendingAgreement: FixedPriceX402TrackOperation = async ({ fence }) => {
      await fence.assertCurrent();
      return {
        status: "pending-retry",
        reasonCode: "simulated-restart",
        retryAt: Date.now() + 50,
      };
    };
    const first = remember(createDacsBuyerServiceV1(options("buyer", database,
      undefined, {
        createOperations: () => ({
          ...operations("buyer"),
          agreement: pendingAgreement,
        }),
      })));
    await first.start();
    await first.startOrder(order("buyer"));
    await first.runOnce();
    await expect(first.getOrderStatus(JOB_ID)).resolves.toMatchObject({
      milestone: "created",
      attention: { required: false },
    });
    await first.stop();
    services.splice(services.indexOf(first), 1);
    database.close();
    databases.splice(databases.indexOf(database), 1);

    database = await openDacsNodeSqliteDatabase({
      databasePath,
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer",
      authority: BUYER,
    });
    databases.push(database);
    const recovered = remember(createDacsBuyerServiceV1(options("buyer", database)));
    await recovered.start();
    await new Promise((resolve) => setTimeout(resolve, 75));
    await recovered.runOnce();
    await expect(recovered.getOrderStatus(JOB_ID)).resolves.toMatchObject({
      milestone: "actor-audit-final",
    });
  });

  it("degrades health when the event sink fails without stopping commerce work", async () => {
    const database = await open(root(), "buyer");
    const service = remember(createDacsBuyerServiceV1(options("buyer", database,
      undefined, { events: { emit: () => { throw new Error("sink-down"); } } })));
    await service.start();
    await service.startOrder(order("buyer"));
    await service.runOnce();
    await expect(service.getOrderStatus(JOB_ID)).resolves.toMatchObject({
      milestone: "actor-audit-final",
    });
    await expect(service.health()).resolves.toMatchObject({
      status: "degraded",
      components: { events: { reasonCode: "service-event-sink-unavailable" } },
    });
  });

  it("rejects commerce and transport calls while stopped", async () => {
    const database = await open(root(), "buyer");
    const service = remember(createDacsBuyerServiceV1(options("buyer", database)));
    await expect(service.runOnce()).rejects.toEqual(
      new DacsLiveRoleServiceError("service-not-running"),
    );
    await expect(service.sendMessage({
      type: "agreement-proposal",
      jobId: JOB_ID,
      payload: {} as never,
    })).rejects.toEqual(new DacsLiveRoleServiceError("service-not-running"));
  });
});
