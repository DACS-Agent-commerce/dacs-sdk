import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { DACS_NODE_LIVE_PROFILE } from "../src/config.js";
import { createDacsBuyerServiceV1, DacsLiveRoleServiceError } from "../src/service.js";
import { openDacsNodeSqliteDatabase, type DacsNodeSqliteDatabase } from "../src/sqlite.js";
import { createDacsHttpEnvelopeV1, type DacsHttpEnvelopeV1 } from "../src/transport/envelope.js";
import type { DacsHttpMessageClientOptionsV1 } from "../src/transport/http.js";

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../src/transport/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/transport/http.js")>();
  return {
    ...actual,
    // Only socket lifecycle and byte transport are replaced. The service,
    // durable outbox, signing and acknowledgement authentication remain real.
    startDacsHttpMessageServerV1: async () => ({
      endpoint: "http://127.0.0.1:1/dacs-transport/v1/messages",
      close: async () => undefined,
    }),
    createDacsHttpMessageClientV1: (options: DacsHttpMessageClientOptionsV1) =>
      actual.createDacsHttpMessageClientV1({ ...options, fetch: transport.fetch }),
  };
});

const JOB = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const buyerSeed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const sellerSeed = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
const buyerKey = privateKeyFromSeed(buyerSeed);
const sellerKey = privateKeyFromSeed(sellerSeed);
const sellerPublic = rawPublicKey(publicKeyFromSeed(sellerSeed));
const BUYER = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(buyerSeed))).toString("hex")}`;
const SELLER = `did:demos:agent:${Buffer.from(sellerPublic).toString("hex")}`;
const message = {
  type: "agreement-proposal", jobId: JOB,
  payload: { proposal: { jobId: JOB, label: "semantic-collapse" },
    transportIdentity: { sender: BUYER, audience: SELLER } } as never,
} as const;

async function fixture(recordless = false) {
  const directory = mkdtempSync(join(tmpdir(), "dacs-service-outbox-"));
  const path = join(directory, "buyer.sqlite");
  const original = await openDacsNodeSqliteDatabase({ databasePath: path,
    mode: "live-demos", profile: DACS_NODE_LIVE_PROFILE, role: "buyer", authority: BUYER });
  const loads: string[] = [];
  const database = !recordless ? original : new Proxy(original, {
    get(target, property) {
      if (property === "createHttpOutboxStore") return () => {
        const outbox = target.createHttpOutboxStore();
        return { ...outbox, load: async (id: string) => { loads.push(id); return undefined; } };
      };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DacsNodeSqliteDatabase;
  transport.fetch.mockImplementation(async (_url: unknown, init: RequestInit) => {
    const sent = JSON.parse(String(init.body)) as DacsHttpEnvelopeV1;
    const now = original.readTime();
    const acknowledgement = await createDacsHttpEnvelopeV1({
      type: "acknowledgement", jobId: JOB, sender: SELLER, audience: BUYER,
      issuedAt: now, expiresAt: now + 60_000, nonce: Buffer.alloc(32, 7).toString("base64url"),
      payload: { acknowledgedEnvelopeId: sent.envelopeId,
        acknowledgedPayloadHash: sent.payloadHash, disposition: "accepted" },
    }, (bytes) => ed25519Sign(bytes, sellerKey));
    return Response.json(acknowledgement);
  });
  const service = createDacsBuyerServiceV1({
    config: { mode: "live-demos", profile: DACS_NODE_LIVE_PROFILE, role: "buyer",
      dataDirectory: directory, demos: { rpcUrl: "http://127.0.0.1:5350" },
      rail: { registryIndexRef: "dacs4:registry:v0.1", requestedNetwork: "eip155:8453" },
      limits: { maxServiceAmount: { asset: "USDC", amount: "1" }, maxSetupSpendDem: "1",
        maxDemosNetworkFeeDem: "1", maxEvmNetworkFeeEth: "0.01" } },
    database, workerId: "buyer-readiness", peerAuthority: SELLER,
    peerEndpoint: "http://127.0.0.1:1/dacs-transport/v1/messages",
    resolveIdentity: async () => ({ status: "authenticated", principal: SELLER,
      jobId: JOB, role: "seller", publicKey: sellerPublic, evidenceHash: "a".repeat(64) }),
    validatePayload: async () => ({ status: "valid" }),
    signTransportEnvelope: (bytes) => ed25519Sign(bytes, buyerKey),
    createOperations: () => ({}), handleMessage: async () => ({ disposition: "accepted" }),
    readiness: () => ({ ready: true, checkedAt: Date.now(), reasonCodes: [] }),
    workerIntervalMs: 60_000,
  });
  cleanups.push(async () => { await service.stop(); original.close(); rmSync(directory, { recursive: true, force: true }); });
  await service.start();
  // All keys must sign the same validity window to exercise semantic collapse.
  const raw = new BetterSqlite3(path);
  raw.prepare("UPDATE dacs_http_clock SET last_time = ? WHERE singleton = 1")
    .run(Math.max(Date.now(), original.readTime()) + 30_000);
  raw.close();
  return { service, database: original, loads };
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.clearAllMocks(); });

describe("authority-separated live role services", () => {
  it("returns and dispatches the retained envelope when distinct keys collapse semantically", async () => {
    const { service, database } = await fixture();
    const first = await service.queueMessage({ ...message, idempotencyKey: "semantic-a" });
    const second = await service.queueMessage({ ...message, idempotencyKey: "semantic-b" });
    expect(second, "C5 returns retained envelope").toEqual(first);
    const acknowledgement = await service.sendMessage({ ...message, idempotencyKey: "semantic-c" });
    expect(acknowledgement.envelope.payload).toEqual({ acknowledgedEnvelopeId: first.envelopeId,
      acknowledgedPayloadHash: first.payloadHash, disposition: "accepted" });
    expect(transport.fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(String(transport.fetch.mock.calls[0]![1].body))).toEqual(first);
    await expect(database.createHttpOutboxStore().load(first.envelopeId))
      .resolves.toMatchObject({ state: "acknowledged" });
  });
  it("fails closed when the outbox cannot produce the retained envelope it reported", async () => {
    const { service, loads } = await fixture(true);
    const first = await service.queueMessage({ ...message, idempotencyKey: "retained-a" });
    const result = await service.queueMessage({ ...message, idempotencyKey: "retained-b" })
      .then(() => ({ rejected: false }), (error: unknown) => ({ rejected: true, error }));
    expect(result.rejected, "C5 refuses missing retained envelope").toBe(true);
    expect(result).toEqual({ rejected: true,
      error: new DacsLiveRoleServiceError("service-message-intent-unavailable") });
    expect(loads).toEqual([first.envelopeId]);
    expect(transport.fetch).not.toHaveBeenCalled();
  });
});
