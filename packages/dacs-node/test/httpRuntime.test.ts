import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalize } from "@kynesyslabs/dacs/canonical";
import {
  ed25519Sign,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
} from "@kynesyslabs/dacs/crypto";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DACS_NODE_LIVE_PROFILE } from "../src/config.js";
import {
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";
import {
  createDacsHttpEnvelopeV1,
  type DacsHttpAuthenticatedEnvelopeV1,
  type DacsHttpEnvelopeV1,
  type DacsHttpIdentityResolverV1,
} from "../src/transport/envelope.js";
import {
  DacsHttpTransportError,
  createDacsHttpMessageClientV1,
  resumeDacsHttpInboxV1,
  startDacsHttpMessageServerV1,
  type DacsHttpMessageEndpointOptionsV1,
  type DacsHttpMessageServerV1,
} from "../src/transport/http.js";

const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BUYER_SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const SELLER_SEED = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const BUYER_KEY = privateKeyFromSeed(BUYER_SEED);
const SELLER_KEY = privateKeyFromSeed(SELLER_SEED);
const BUYER_PUBLIC = rawPublicKey(publicKeyFromSeed(BUYER_SEED));
const SELLER_PUBLIC = rawPublicKey(publicKeyFromSeed(SELLER_SEED));
const BUYER = `did:demos:agent:${Buffer.from(BUYER_PUBLIC).toString("hex")}`;
const SELLER = `did:demos:agent:${Buffer.from(SELLER_PUBLIC).toString("hex")}`;

function nonce(byte: number): string {
  return Buffer.alloc(32, byte).toString("base64url");
}

function identityResolver(): DacsHttpIdentityResolverV1 {
  return async (input) => {
    const buyer = input.sender === BUYER || input.sender.startsWith(`${BUYER}?`);
    const seller = input.sender === SELLER || input.sender.startsWith(`${SELLER}?`);
    if (!buyer && !seller) {
      return { status: "rejected", reasonCode: "identity-unresolved" };
    }
    return {
      status: "authenticated",
      principal: buyer ? BUYER : SELLER,
      jobId: input.jobId,
      role: buyer ? "buyer" : "seller",
      publicKey: buyer ? BUYER_PUBLIC : SELLER_PUBLIC,
      evidenceHash: buyer ? "a".repeat(64) : "b".repeat(64),
    };
  };
}

async function proposal(
  now: number,
  nonceByte: number,
  audience = SELLER,
  sender = BUYER,
): Promise<Readonly<DacsHttpEnvelopeV1>> {
  return createDacsHttpEnvelopeV1({
    type: "agreement-proposal",
    jobId: JOB_ID,
    sender,
    audience,
    issuedAt: now - 1_000,
    expiresAt: now + 299_000,
    nonce: nonce(nonceByte),
    payload: {
      proposal: { jobId: JOB_ID, label: "http-runtime-test" },
      transportIdentity: { sender, audience },
    } as never,
  }, (bytes) => ed25519Sign(bytes, BUYER_KEY));
}

describe("authenticated HTTP listener and durable client", () => {
  const roots: string[] = [];
  const databases: DacsNodeSqliteDatabase[] = [];
  const servers: DacsHttpMessageServerV1[] = [];

  function root(): string {
    const value = mkdtempSync(join(tmpdir(), "dacs-http-runtime-"));
    roots.push(value);
    return value;
  }

  async function open(
    databasePath: string,
    authority: string,
    role: "buyer" | "seller",
  ): Promise<DacsNodeSqliteDatabase> {
    const database = await openDacsNodeSqliteDatabase({
      databasePath,
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      authority,
      role,
    });
    databases.push(database);
    return database;
  }

  function closeDatabase(database: DacsNodeSqliteDatabase): void {
    database.close();
    databases.splice(databases.indexOf(database), 1);
  }

  function advanceStoreClock(databasePath: string, now: number): void {
    const raw = new BetterSqlite3(databasePath);
    raw.prepare("UPDATE dacs_http_clock SET last_time = ? WHERE singleton = 1").run(now);
    raw.close();
  }

  function endpointOptions(
    database: DacsNodeSqliteDatabase,
    handleMessage: DacsHttpMessageEndpointOptionsV1["handleMessage"],
    overrides: Partial<DacsHttpMessageEndpointOptionsV1> = {},
  ): DacsHttpMessageEndpointOptionsV1 {
    return {
      authority: SELLER,
      inbox: database.createHttpInboxStore(),
      resolveIdentity: identityResolver(),
      validatePayload: async () => ({ status: "valid" }),
      handleMessage,
      signAcknowledgement: (bytes) => ed25519Sign(bytes, SELLER_KEY),
      ...overrides,
    };
  }

  async function start(
    options: DacsHttpMessageEndpointOptionsV1,
  ): Promise<DacsHttpMessageServerV1> {
    const server = await startDacsHttpMessageServerV1({
      ...options,
      hostname: "127.0.0.1",
      port: 0,
    });
    servers.push(server);
    return server;
  }

  async function closeServer(server: DacsHttpMessageServerV1): Promise<void> {
    await server.close();
    servers.splice(servers.indexOf(server), 1);
  }

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const database of databases.splice(0)) database.close();
    for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
  });

  it("authenticates end to end and returns a durable signed replay acknowledgement", async () => {
    const directory = root();
    const sellerDatabase = await open(join(directory, "seller.sqlite"), SELLER, "seller");
    const buyerDatabase = await open(join(directory, "buyer.sqlite"), BUYER, "buyer");
    const handled = vi.fn(async () => ({ disposition: "accepted" as const }));
    const server = await start(endpointOptions(sellerDatabase, handled));
    const outbox = buyerDatabase.createHttpOutboxStore();
    const client = createDacsHttpMessageClientV1({
      endpoint: server.endpoint,
      authority: BUYER,
      outbox,
      resolveIdentity: identityResolver(),
      workerId: "buyer-worker",
    });
    const signed = await proposal(await outbox.readTime(), 1);

    const acknowledgement = await client.send(signed);

    expect(acknowledgement.envelope.type).toBe("acknowledgement");
    expect(acknowledgement.envelope.payload).toMatchObject({
      acknowledgedEnvelopeId: signed.envelopeId,
      acknowledgedPayloadHash: signed.payloadHash,
      disposition: "accepted",
    });
    await expect(outbox.load(signed.envelopeId)).resolves.toMatchObject({
      state: "acknowledged",
    });
    expect(handled).toHaveBeenCalledTimes(1);

    const replay = await fetch(server.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: canonicalize(signed),
    });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      type: "acknowledgement",
      payload: {
        acknowledgedEnvelopeId: signed.envelopeId,
        disposition: "existing",
      },
    });
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it("recovers a pending inbox reservation after restart before acknowledging replay", async () => {
    const databasePath = join(root(), "seller.sqlite");
    let sellerDatabase = await open(databasePath, SELLER, "seller");
    const failedHandler = vi.fn(async () => {
      throw new Error("simulated-process-boundary");
    });
    let server = await start(endpointOptions(sellerDatabase, failedHandler));
    const inbox = sellerDatabase.createHttpInboxStore();
    const signed = await proposal(await inbox.readTime(), 2);

    const first = await fetch(server.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: canonicalize(signed),
    });
    expect(first.status).toBe(503);
    await expect(first.json()).resolves.toEqual({ error: "transport-handler-pending" });
    await expect(inbox.list({ limit: 10, state: "pending" })).resolves.toMatchObject({
      items: [{ state: "pending" }],
    });
    await closeServer(server);
    closeDatabase(sellerDatabase);

    sellerDatabase = await open(databasePath, SELLER, "seller");
    const recoveredHandler = vi.fn(async () => ({ disposition: "accepted" as const }));
    const recoveredOptions = endpointOptions(sellerDatabase, recoveredHandler);
    await expect(resumeDacsHttpInboxV1(recoveredOptions)).resolves.toEqual({
      inspected: 1,
      disposed: 1,
      pending: 0,
    });
    server = await start(recoveredOptions);
    const replay = await fetch(server.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: canonicalize(signed),
    });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      payload: { disposition: "existing" },
    });
    expect(failedHandler).toHaveBeenCalledTimes(1);
    expect(recoveredHandler).toHaveBeenCalledTimes(1);
  });

  it("replays the exact durable outbox envelope after an ambiguous response", async () => {
    const directory = root();
    const buyerPath = join(directory, "buyer.sqlite");
    const sellerDatabase = await open(join(directory, "seller.sqlite"), SELLER, "seller");
    let buyerDatabase = await open(buyerPath, BUYER, "buyer");
    const handled = vi.fn(async () => ({ disposition: "accepted" as const }));
    const server = await start(endpointOptions(sellerDatabase, handled));
    let loseFirstResponse = true;
    const sentBodies: string[] = [];
    const ambiguousFetch = vi.fn(async (input: string | URL, init: RequestInit) => {
      sentBodies.push(String(init.body));
      const response = await fetch(input, init);
      if (loseFirstResponse) {
        loseFirstResponse = false;
        await response.arrayBuffer();
        throw new Error("simulated-response-loss");
      }
      return response;
    });
    let outbox = buyerDatabase.createHttpOutboxStore({ retryJitter: () => 0 });
    let client = createDacsHttpMessageClientV1({
      endpoint: server.endpoint,
      authority: BUYER,
      outbox,
      resolveIdentity: identityResolver(),
      workerId: "buyer-worker-one",
      fetch: ambiguousFetch,
    });
    const now = await outbox.readTime();
    const signed = await proposal(now, 3);

    await expect(client.send(signed)).rejects.toMatchObject({
      name: "DacsHttpTransportError",
      reasonCode: "response-ambiguous",
      retryable: true,
    });
    await expect(outbox.load(signed.envelopeId)).resolves.toMatchObject({
      state: "pending",
      attempts: 1,
      reasonCode: "response-ambiguous",
    });
    expect(handled).toHaveBeenCalledTimes(1);
    closeDatabase(buyerDatabase);
    advanceStoreClock(buyerPath, now + 2_000);

    buyerDatabase = await open(buyerPath, BUYER, "buyer");
    outbox = buyerDatabase.createHttpOutboxStore({ retryJitter: () => 0 });
    client = createDacsHttpMessageClientV1({
      endpoint: server.endpoint,
      authority: BUYER,
      outbox,
      resolveIdentity: identityResolver(),
      workerId: "buyer-worker-two",
      fetch: ambiguousFetch,
    });
    await expect(client.dispatch(signed.envelopeId)).resolves.toMatchObject({
      status: "acknowledged",
      acknowledgement: { envelope: { payload: { disposition: "existing" } } },
    });
    expect(sentBodies).toEqual([canonicalize(signed), canonicalize(signed)]);
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it("never clears the outbox for an unsigned or malformed 2xx acknowledgement", async () => {
    const buyerDatabase = await open(join(root(), "buyer.sqlite"), BUYER, "buyer");
    const outbox = buyerDatabase.createHttpOutboxStore({ retryJitter: () => 0 });
    const client = createDacsHttpMessageClientV1({
      endpoint: "http://127.0.0.1:1/dacs-transport/v1/messages",
      authority: BUYER,
      outbox,
      resolveIdentity: identityResolver(),
      workerId: "buyer-worker",
      fetch: async () => new Response('{"accepted":true}', {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    });
    const signed = await proposal(await outbox.readTime(), 4);

    await expect(client.send(signed)).rejects.toMatchObject({
      reasonCode: "response-ambiguous",
      retryable: true,
    });
    await expect(outbox.load(signed.envelopeId)).resolves.toMatchObject({
      state: "pending",
      reasonCode: "response-ambiguous",
    });
  });

  it("honours a bounded Retry-After without weakening durable backoff", async () => {
    const buyerDatabase = await open(join(root(), "buyer.sqlite"), BUYER, "buyer");
    const outbox = buyerDatabase.createHttpOutboxStore({ retryJitter: () => 0 });
    const client = createDacsHttpMessageClientV1({
      endpoint: "http://127.0.0.1:1/dacs-transport/v1/messages",
      authority: BUYER,
      outbox,
      resolveIdentity: identityResolver(),
      workerId: "buyer-worker",
      fetch: async () => new Response('{"error":"transport-rate-limited"}', {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "60",
        },
      }),
    });
    const signed = await proposal(await outbox.readTime(), 8);

    await expect(client.send(signed)).rejects.toMatchObject({
      reasonCode: "response-ambiguous",
      retryable: true,
    });
    const retained = await outbox.load(signed.envelopeId);
    expect(retained).toMatchObject({ state: "pending", attempts: 1 });
    expect(retained!.nextAttemptAt - retained!.updatedAt).toBe(60_000);
  });

  it("records a signed rejection as terminal transport disposition", async () => {
    const directory = root();
    const sellerDatabase = await open(join(directory, "seller.sqlite"), SELLER, "seller");
    const buyerDatabase = await open(join(directory, "buyer.sqlite"), BUYER, "buyer");
    const server = await start(endpointOptions(sellerDatabase, async () => ({
      disposition: "rejected",
      reasonCode: "proposal-not-admissible",
    })));
    const outbox = buyerDatabase.createHttpOutboxStore();
    const client = createDacsHttpMessageClientV1({
      endpoint: server.endpoint,
      authority: BUYER,
      outbox,
      resolveIdentity: identityResolver(),
      workerId: "buyer-worker",
    });
    const signed = await proposal(await outbox.readTime(), 5);

    const acknowledgement = await client.send(signed);
    expect(acknowledgement.envelope.payload).toMatchObject({
      disposition: "rejected",
      reasonCode: "proposal-not-admissible",
    });
    await expect(outbox.load(signed.envelopeId)).resolves.toMatchObject({
      state: "acknowledged",
    });
  });

  it("rejects unauthenticated requests before durable admission", async () => {
    const sellerDatabase = await open(join(root(), "seller.sqlite"), SELLER, "seller");
    const handled = vi.fn(async () => ({ disposition: "accepted" as const }));
    const options = endpointOptions(sellerDatabase, handled);
    const server = await start(options);
    const inbox = sellerDatabase.createHttpInboxStore();
    const signed = await proposal(await inbox.readTime(), 6);
    const first = signed.signature[0] === "A" ? "B" : "A";

    const response = await fetch(server.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: canonicalize({ ...signed, signature: `${first}${signed.signature.slice(1)}` }),
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "envelope-signature-invalid" });
    await expect(inbox.list({ limit: 10 })).resolves.toEqual({ items: [] });
    expect(handled).not.toHaveBeenCalled();
  });

  it("bounds request bodies and rate limits before invoking the handler", async () => {
    const sellerDatabase = await open(join(root(), "seller.sqlite"), SELLER, "seller");
    const handled = vi.fn(async () => ({ disposition: "accepted" as const }));
    const server = await start(endpointOptions(sellerDatabase, handled, {
      maxBodyBytes: 1_024,
      rateLimit: { requests: 1, windowMs: 60_000 },
    }));

    const oversized = await fetch(server.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(1_025),
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({ error: "request-body-too-large" });
    const limited = await fetch(server.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(handled).not.toHaveBeenCalled();
  });

  it("requires TLS off loopback and rejects a client envelope owned by another authority", async () => {
    const sellerDatabase = await open(join(root(), "seller.sqlite"), SELLER, "seller");
    const options = endpointOptions(
      sellerDatabase,
      async () => ({ disposition: "accepted" as const }),
    );
    await expect(startDacsHttpMessageServerV1({
      ...options,
      hostname: "0.0.0.0",
      port: 0,
    })).rejects.toThrow("requires TLS");
    expect(() => createDacsHttpMessageClientV1({
      endpoint: "http://example.com/dacs-transport/v1/messages",
      authority: SELLER,
      outbox: sellerDatabase.createHttpOutboxStore(),
      resolveIdentity: identityResolver(),
      workerId: "seller-worker",
    })).toThrow("HTTPS or loopback HTTP");

    const client = createDacsHttpMessageClientV1({
      endpoint: "http://127.0.0.1:1/dacs-transport/v1/messages",
      authority: SELLER,
      outbox: sellerDatabase.createHttpOutboxStore(),
      resolveIdentity: identityResolver(),
      workerId: "seller-worker",
      fetch: async () => new Response(null, { status: 503 }),
    });
    const signed = await proposal(Date.now(), 7);
    await expect(client.send(signed)).rejects.toEqual(expect.objectContaining({
      name: "DacsHttpTransportError",
      reasonCode: "outbox-envelope-invalid",
      retryable: false,
    } satisfies Partial<DacsHttpTransportError>));
  });
});
