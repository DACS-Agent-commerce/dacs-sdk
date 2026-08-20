import {
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalize,
  sha256Hex,
} from "@kynesyslabs/dacs/canonical";
import {
  ed25519Sign,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
} from "@kynesyslabs/dacs/crypto";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DACS_NODE_LIVE_PROFILE,
} from "../src/config.js";
import {
  DACS_HTTP_MINIMUM_RETENTION_MS,
} from "../src/transport/contracts.js";
import {
  authenticateDacsHttpEnvelopeV1,
  createDacsHttpAcknowledgementEnvelopeV1,
  createDacsHttpEnvelopeV1,
  type DacsHttpAuthenticatedEnvelopeV1,
  type DacsHttpEnvelopeV1,
} from "../src/transport/envelope.js";
import {
  DACS_NODE_SQLITE_SCHEMA_VERSION,
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";

const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BUYER_SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const SELLER_SEED = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const BUYER_KEY = privateKeyFromSeed(BUYER_SEED);
const SELLER_KEY = privateKeyFromSeed(SELLER_SEED);
const BUYER_PUBLIC = rawPublicKey(publicKeyFromSeed(BUYER_SEED));
const SELLER_PUBLIC = rawPublicKey(publicKeyFromSeed(SELLER_SEED));
const BUYER = `did:demos:agent:${Buffer.from(BUYER_PUBLIC).toString("hex")}`;
const SELLER = `did:demos:agent:${Buffer.from(SELLER_PUBLIC).toString("hex")}`;
const IDENTITY_EVIDENCE_HASH = "a".repeat(64);

function nonce(byte: number): string {
  return Buffer.alloc(32, byte).toString("base64url");
}

function outboxHistoryEntryHash(input: Readonly<{
  identity: string;
  revision: number;
  occurredAt: number;
  recordHash: string;
  previousEntryHash: string | null;
}>): string {
  return sha256Hex(canonicalize({ direction: "outbox", ...input }));
}

async function envelope(
  sender: "buyer" | "seller",
  nonceByte: number,
  now = Date.now(),
): Promise<Readonly<DacsHttpEnvelopeV1>> {
  const fromBuyer = sender === "buyer";
  return createDacsHttpEnvelopeV1({
    type: fromBuyer ? "agreement-proposal" : "agreement-response",
    jobId: JOB_ID,
    sender: fromBuyer ? BUYER : SELLER,
    audience: fromBuyer ? SELLER : BUYER,
    issuedAt: now - 1_000,
    expiresAt: now + 300_000 - 1_000,
    nonce: nonce(nonceByte),
    payload: fromBuyer
      ? {
          proposal: { jobId: JOB_ID, label: "durable-http-test" },
          transportIdentity: { sender: BUYER, audience: SELLER },
        } as never
      : { accepted: true, responseVersion: "durable-http-test" } as never,
  }, (bytes) => ed25519Sign(bytes, fromBuyer ? BUYER_KEY : SELLER_KEY)) as
    Promise<Readonly<DacsHttpEnvelopeV1>>;
}

async function authenticate(
  value: Readonly<DacsHttpEnvelopeV1>,
  audience: string,
  receivedAt: number,
  evidenceHash = IDENTITY_EVIDENCE_HASH,
): Promise<Readonly<DacsHttpAuthenticatedEnvelopeV1>> {
  const senderIsBuyer = value.sender === BUYER || value.sender.startsWith(`${BUYER}?`);
  const result = await authenticateDacsHttpEnvelopeV1(value, {
    storeTime: receivedAt,
    expectedAudience: audience,
    resolveIdentity: async () => ({
      status: "authenticated",
      principal: senderIsBuyer ? BUYER : SELLER,
      jobId: value.jobId,
      role: senderIsBuyer ? "buyer" : "seller",
      publicKey: senderIsBuyer ? BUYER_PUBLIC : SELLER_PUBLIC,
      evidenceHash,
    }),
    validatePayload: async () => ({ status: "valid" }),
  });
  if (result.status !== "authenticated") throw new Error(result.reasonCode);
  return result;
}

describe("SQLite authenticated HTTP inbox/outbox", () => {
  const roots: string[] = [];
  const databases: DacsNodeSqliteDatabase[] = [];

  function root(): string {
    const value = mkdtempSync(join(tmpdir(), "dacs-node-http-store-"));
    roots.push(value);
    return value;
  }

  async function open(
    databasePath: string,
    authority = SELLER,
    role: "buyer" | "seller" = "seller",
  ): Promise<DacsNodeSqliteDatabase> {
    const database = await openDacsNodeSqliteDatabase({
      databasePath,
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role,
      authority,
    });
    databases.push(database);
    return database;
  }

  function close(database: DacsNodeSqliteDatabase): void {
    database.close();
    databases.splice(databases.indexOf(database), 1);
  }

  function advanceStoreClock(databasePath: string, value: number): void {
    const raw = new BetterSqlite3(databasePath);
    raw.prepare(`UPDATE dacs_http_clock SET last_time = ? WHERE singleton = 1`)
      .run(value);
    raw.close();
  }

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
    for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
  });

  it("retains pending reservations across crashes and replays only a durable disposition", async () => {
    const databasePath = join(root(), "seller.sqlite");
    let database = await open(databasePath);
    let store = database.createHttpInboxStore();
    const now = await store.readTime();
    const signed = await envelope("buyer", 1, now);
    const authenticated = await authenticate(signed, SELLER, now);
    const retainUntil = now + DACS_HTTP_MINIMUM_RETENTION_MS + 10_000;

    const created = await store.reserve({ authenticated, retainUntil });
    expect(created).toMatchObject({ status: "reserved", record: { state: "pending" } });
    expect(await store.reserve({ authenticated, retainUntil })).toMatchObject({
      status: "pending",
      record: { state: "pending", revision: 1 },
    });
    const refreshedAuthentication = await authenticate(
      signed,
      SELLER,
      now,
      "b".repeat(64),
    );
    expect(await store.reserve({
      authenticated: refreshedAuthentication,
      retainUntil,
    })).toMatchObject({
      status: "pending",
      record: {
        revision: 1,
        authenticated: { identityEvidenceHash: IDENTITY_EVIDENCE_HASH },
      },
    });

    database.checkpoint();
    close(database);
    database = await open(databasePath);
    store = database.createHttpInboxStore();
    expect(await store.reserve({ authenticated, retainUntil })).toMatchObject({
      status: "pending",
      record: {
        revision: 1,
        authenticated: { identityEvidenceHash: IDENTITY_EVIDENCE_HASH },
      },
    });
    expect(await store.recordDisposition({
      sender: BUYER,
      audience: SELLER,
      envelopeId: signed.envelopeId,
      authenticationHash: authenticated.authenticationHash,
      disposition: "accepted",
    })).toMatchObject({ status: "recorded", record: { state: "disposed", revision: 2 } });
    expect(await store.reserve({ authenticated, retainUntil })).toMatchObject({
      status: "existing",
      disposition: "accepted",
    });
  });

  it("preserves parameterized CF-2 identities while isolating stores by CF-3 authority", async () => {
    const database = await open(join(root(), "seller.sqlite"));
    const store = database.createHttpInboxStore();
    const now = await store.readTime();
    const sender = `${BUYER}?region=uk`;
    const audience = `${SELLER}?region=us`;
    const signed = await createDacsHttpEnvelopeV1({
      type: "agreement-proposal",
      jobId: JOB_ID,
      sender,
      audience,
      issuedAt: now - 1_000,
      expiresAt: now + 299_000,
      nonce: nonce(12),
      payload: {
        proposal: { jobId: JOB_ID, label: "parameterized-claimref" },
        transportIdentity: { sender, audience },
      } as never,
    }, (bytes) => ed25519Sign(bytes, BUYER_KEY));
    const authenticated = await authenticate(signed, SELLER, now);
    const retainUntil = now + DACS_HTTP_MINIMUM_RETENTION_MS + 10_000;

    await expect(store.reserve({ authenticated, retainUntil })).resolves.toMatchObject({
      status: "reserved",
      record: { authenticated: { envelope: { sender, audience } } },
    });
    await expect(store.load({ sender, audience, envelopeId: signed.envelopeId }))
      .resolves.toMatchObject({ authenticated: { envelope: { sender, audience } } });
    await expect(store.recordDisposition({
      sender,
      audience,
      envelopeId: signed.envelopeId,
      authenticationHash: authenticated.authenticationHash,
      disposition: "accepted",
    })).resolves.toMatchObject({ status: "recorded" });

    const buyerDatabase = await open(join(root(), "buyer.sqlite"), BUYER, "buyer");
    const outbox = buyerDatabase.createHttpOutboxStore();
    const put = await outbox.put({ envelope: signed, retainUntil });
    expect(put).toMatchObject({ status: "created" });
    if (!put.record) throw new Error("expected parameterized outbox record");
    const acknowledgementEnvelope = await createDacsHttpAcknowledgementEnvelopeV1(
      signed,
      {
        disposition: "accepted",
        issuedAt: now,
        expiresAt: now + 300_000,
        nonce: nonce(13),
      },
      (bytes) => ed25519Sign(bytes, SELLER_KEY),
    );
    const acknowledgement = await authenticate(acknowledgementEnvelope, BUYER, now);
    await expect(outbox.acknowledge({
      envelopeId: signed.envelopeId,
      envelopeHash: put.record.envelopeHash,
      acknowledgement,
    })).resolves.toMatchObject({
      status: "recorded",
      record: { state: "acknowledged" },
    });
  });

  it("fails closed for invalid authentication, disposition facts and short retention", async () => {
    const database = await open(join(root(), "seller.sqlite"));
    const store = database.createHttpInboxStore();
    const now = await store.readTime();
    const signed = await envelope("buyer", 2, now);
    const authenticated = await authenticate(signed, SELLER, now);
    const retainUntil = now + DACS_HTTP_MINIMUM_RETENTION_MS + 10_000;
    await expect(store.reserve({
      authenticated: { ...authenticated, receivedAt: signed.expiresAt },
      retainUntil: signed.expiresAt + DACS_HTTP_MINIMUM_RETENTION_MS,
    })).rejects.toMatchObject({ reasonCode: "http-authentication-record-invalid" });
    await expect(store.reserve({
      authenticated,
      retainUntil: now + DACS_HTTP_MINIMUM_RETENTION_MS - 1,
    })).rejects.toMatchObject({ reasonCode: "http-retention-too-short" });
    await store.reserve({ authenticated, retainUntil });
    await expect(store.reserve({
      authenticated: { ...authenticated, authenticationHash: "b".repeat(64) },
      retainUntil,
    })).rejects.toMatchObject({ reasonCode: "http-authentication-record-invalid" });
    expect(await store.recordDisposition({
      sender: BUYER,
      audience: SELLER,
      envelopeId: signed.envelopeId,
      authenticationHash: authenticated.authenticationHash,
      disposition: "accepted",
      reasonCode: "forbidden-reason",
    })).toEqual({ status: "conflict" });
  });

  it("claims one exact envelope, fences stale workers and schedules deterministic retry", async () => {
    const database = await open(join(root(), "buyer.sqlite"), BUYER, "buyer");
    const jitter = vi.fn(() => 250);
    const store = database.createHttpOutboxStore({ retryJitter: jitter });
    const now = await store.readTime();
    const signed = await envelope("buyer", 3, now);
    const retainUntil = now + DACS_HTTP_MINIMUM_RETENTION_MS + 10_000;
    const put = await store.put({ envelope: signed, retainUntil });
    expect(put).toMatchObject({ status: "created", record: { state: "pending" } });
    expect(await store.put({ envelope: signed, retainUntil })).toMatchObject({
      status: "existing",
    });
    const claim = await store.claim({
      envelopeId: signed.envelopeId,
      envelopeHash: put.record!.envelopeHash,
      owner: "worker-a",
      leaseDurationMs: 60_000,
    });
    expect(claim).toMatchObject({
      status: "acquired",
      record: { state: "sending", generation: 1, attempts: 1 },
    });
    if (claim.status !== "acquired") throw new Error("expected claim");
    expect(await store.claim({
      envelopeId: signed.envelopeId,
      envelopeHash: put.record!.envelopeHash,
      owner: "worker-b",
      leaseDurationMs: 60_000,
    })).toMatchObject({ status: "waiting" });
    const failure = await store.recordSendFailure({
      envelopeId: signed.envelopeId,
      envelopeHash: put.record!.envelopeHash,
      lease: claim.lease,
      reasonCode: "response-ambiguous",
    });
    expect(failure).toMatchObject({
      status: "recorded",
      record: { state: "pending" },
    });
    if (!failure.record) throw new Error("expected failed send record");
    expect(failure.record.nextAttemptAt - failure.record.updatedAt).toBe(1_250);
    expect(jitter).toHaveBeenCalledWith({
      envelopeId: signed.envelopeId,
      attempt: 1,
      baseDelayMs: 1_000,
    });
    expect(await store.isCurrent({
      envelopeId: signed.envelopeId,
      envelopeHash: put.record!.envelopeHash,
      lease: claim.lease,
    })).toBe(false);
  });

  it("applies stable bounded jitter by default", async () => {
    const firstDatabase = await open(join(root(), "first.sqlite"), BUYER, "buyer");
    const secondDatabase = await open(join(root(), "second.sqlite"), BUYER, "buyer");
    const first = firstDatabase.createHttpOutboxStore();
    const second = secondDatabase.createHttpOutboxStore();
    const now = Math.max(await first.readTime(), await second.readTime());
    const signed = await envelope("buyer", 14, now);
    const retainUntil = now + DACS_HTTP_MINIMUM_RETENTION_MS + 10_000;

    const delays: number[] = [];
    for (const store of [first, second]) {
      const put = await store.put({ envelope: signed, retainUntil });
      if (!put.record) throw new Error("expected jitter outbox record");
      const claim = await store.claim({
        envelopeId: signed.envelopeId,
        envelopeHash: put.record.envelopeHash,
        owner: "worker",
        leaseDurationMs: 60_000,
      });
      if (claim.status !== "acquired") throw new Error("expected jitter claim");
      const failed = await store.recordSendFailure({
        envelopeId: signed.envelopeId,
        envelopeHash: put.record.envelopeHash,
        lease: claim.lease,
        reasonCode: "response-ambiguous",
      });
      if (!failed.record) throw new Error("expected jitter retry record");
      delays.push(failed.record.nextAttemptAt - failed.record.updatedAt);
    }
    expect(delays[0]).toBe(delays[1]);
    expect(delays[0]).toBeGreaterThanOrEqual(500);
    expect(delays[0]).toBeLessThanOrEqual(1_500);
  });

  it("records a valid late acknowledgement monotonically and rejects an unbound ACK", async () => {
    const database = await open(join(root(), "buyer.sqlite"), BUYER, "buyer");
    const store = database.createHttpOutboxStore();
    const now = await store.readTime();
    const signed = await envelope("buyer", 4, now);
    const put = await store.put({
      envelope: signed,
      retainUntil: now + DACS_HTTP_MINIMUM_RETENTION_MS + 10_000,
    });
    if (!put.record) throw new Error("expected outbox record");
    const claim = await store.claim({
      envelopeId: signed.envelopeId,
      envelopeHash: put.record.envelopeHash,
      owner: "worker-a",
      leaseDurationMs: 1,
    });
    if (claim.status !== "acquired") throw new Error("expected claim");

    const acknowledgementEnvelope = await createDacsHttpAcknowledgementEnvelopeV1(
      signed,
      {
        disposition: "accepted",
        issuedAt: now,
        expiresAt: now + 300_000,
        nonce: nonce(44),
      },
      (bytes) => ed25519Sign(bytes, SELLER_KEY),
    );
    const acknowledgement = await authenticate(
      acknowledgementEnvelope,
      BUYER,
      now + 2,
    );
    expect(await store.acknowledge({
      envelopeId: signed.envelopeId,
      envelopeHash: put.record.envelopeHash,
      acknowledgement,
    })).toMatchObject({ status: "recorded", record: { state: "acknowledged" } });

    const other = await envelope("buyer", 5, now);
    const otherAckEnvelope = await createDacsHttpAcknowledgementEnvelopeV1(
      other,
      {
        disposition: "accepted",
        issuedAt: now,
        expiresAt: now + 300_000,
        nonce: nonce(45),
      },
      (bytes) => ed25519Sign(bytes, SELLER_KEY),
    );
    const otherAck = await authenticate(otherAckEnvelope, BUYER, now + 2);
    expect(await store.acknowledge({
      envelopeId: signed.envelopeId,
      envelopeHash: put.record.envelopeHash,
      acknowledgement: otherAck,
    })).toEqual({ status: "conflict" });
    expect((await store.load(signed.envelopeId))?.state).toBe("acknowledged");
  });

  it("rejects an acknowledgement receipt time beyond database-authoritative transport time", async () => {
    const databasePath = join(root(), "buyer.sqlite");
    let database = await open(databasePath, BUYER, "buyer");
    let store = database.createHttpOutboxStore();
    const now = await store.readTime();
    const signed = await envelope("buyer", 15, now);
    const put = await store.put({
      envelope: signed,
      retainUntil: now + DACS_HTTP_MINIMUM_RETENTION_MS + 10_000,
    });
    if (!put.record) throw new Error("expected outbox record");
    const acknowledgementEnvelope = await createDacsHttpAcknowledgementEnvelopeV1(
      signed,
      {
        disposition: "accepted",
        issuedAt: now,
        expiresAt: now + 300_000,
        nonce: nonce(46),
      },
      (bytes) => ed25519Sign(bytes, SELLER_KEY),
    );
    const futureAuthentication = await authenticate(
      acknowledgementEnvelope,
      BUYER,
      now + 120_000,
    );
    const before = await store.load(signed.envelopeId);

    expect(await store.acknowledge({
      envelopeId: signed.envelopeId,
      envelopeHash: put.record.envelopeHash,
      acknowledgement: futureAuthentication,
    })).toEqual({ status: "conflict" });
    expect(await store.load(signed.envelopeId)).toEqual(before);

    database.checkpoint();
    close(database);
    database = await open(databasePath, BUYER, "buyer");
    store = database.createHttpOutboxStore();
    expect(await store.load(signed.envelopeId)).toEqual(before);
  });

  it("extends acknowledgement retention from receipt time and preserves it across restart", async () => {
    const databasePath = join(root(), "buyer.sqlite");
    const configuredRetentionMs = DACS_HTTP_MINIMUM_RETENTION_MS + 60_000;
    let database = await open(databasePath, BUYER, "buyer");
    let store = database.createHttpOutboxStore({ retentionMs: configuredRetentionMs });
    const now = await store.readTime();
    const signed = await envelope("buyer", 16, now);
    const put = await store.put({
      envelope: signed,
      retainUntil: now + configuredRetentionMs + 10_000,
    });
    if (!put.record) throw new Error("expected outbox record");
    const receivedAt = now + 120_000;
    const acknowledgementEnvelope = await createDacsHttpAcknowledgementEnvelopeV1(
      signed,
      {
        disposition: "accepted",
        issuedAt: receivedAt - 1_000,
        expiresAt: receivedAt + 299_000,
        nonce: nonce(47),
      },
      (bytes) => ed25519Sign(bytes, SELLER_KEY),
    );
    const acknowledgement = await authenticate(acknowledgementEnvelope, BUYER, receivedAt);
    advanceStoreClock(databasePath, receivedAt);
    const retainUntil = receivedAt + configuredRetentionMs;

    expect(await store.acknowledge({
      envelopeId: signed.envelopeId,
      envelopeHash: put.record.envelopeHash,
      acknowledgement,
    })).toMatchObject({
      status: "recorded",
      record: {
        state: "acknowledged",
        acknowledgementRetentionMs: configuredRetentionMs,
        retainUntil,
        revision: 2,
        acknowledgement: { receivedAt },
      },
    });

    database.checkpoint();
    close(database);
    database = await open(databasePath, BUYER, "buyer");
    // A shorter option after restart must not weaken the authenticated policy
    // that admitted this acknowledgement.
    store = database.createHttpOutboxStore();
    expect(await store.load(signed.envelopeId)).toMatchObject({
      state: "acknowledged",
      acknowledgementRetentionMs: configuredRetentionMs,
      retainUntil,
      revision: 2,
      acknowledgement: { receivedAt },
    });
    const replayedReceivedAt = receivedAt + 30_000;
    const replayedAcknowledgement = await authenticate(
      acknowledgementEnvelope,
      BUYER,
      replayedReceivedAt,
    );
    advanceStoreClock(databasePath, replayedReceivedAt);
    expect(await store.acknowledge({
      envelopeId: signed.envelopeId,
      envelopeHash: put.record.envelopeHash,
      acknowledgement: replayedAcknowledgement,
    })).toMatchObject({
      status: "recorded",
      record: {
        acknowledgementRetentionMs: configuredRetentionMs,
        retainUntil: replayedReceivedAt + configuredRetentionMs,
        revision: 3,
      },
    });
    expect(await store.acknowledge({
      envelopeId: signed.envelopeId,
      envelopeHash: put.record.envelopeHash,
      acknowledgement: replayedAcknowledgement,
    })).toMatchObject({
      status: "existing",
      record: {
        acknowledgementRetentionMs: configuredRetentionMs,
        retainUntil: replayedReceivedAt + configuredRetentionMs,
        revision: 3,
      },
    });
  });

  it("upgrades acknowledgement retention under a longer option and keeps it after a shorter restart", async () => {
    const databasePath = join(root(), "buyer.sqlite");
    const longerRetentionMs = DACS_HTTP_MINIMUM_RETENTION_MS + 120_000;
    let database = await open(databasePath, BUYER, "buyer");
    let store = database.createHttpOutboxStore();
    const now = await store.readTime();
    const signed = await envelope("buyer", 18, now);
    const put = await store.put({
      envelope: signed,
      retainUntil: now + DACS_HTTP_MINIMUM_RETENTION_MS + 10_000,
    });
    if (!put.record) throw new Error("expected outbox record");
    const receivedAt = now + 120_000;
    const acknowledgementEnvelope = await createDacsHttpAcknowledgementEnvelopeV1(
      signed,
      {
        disposition: "accepted",
        issuedAt: receivedAt - 1_000,
        expiresAt: receivedAt + 299_000,
        nonce: nonce(49),
      },
      (bytes) => ed25519Sign(bytes, SELLER_KEY),
    );
    const acknowledgement = await authenticate(acknowledgementEnvelope, BUYER, receivedAt);
    advanceStoreClock(databasePath, receivedAt);

    expect(await store.acknowledge({
      envelopeId: signed.envelopeId,
      envelopeHash: put.record.envelopeHash,
      acknowledgement,
    })).toMatchObject({
      status: "recorded",
      record: {
        acknowledgementRetentionMs: DACS_HTTP_MINIMUM_RETENTION_MS,
        retainUntil: receivedAt + DACS_HTTP_MINIMUM_RETENTION_MS,
        revision: 2,
      },
    });

    database.checkpoint();
    close(database);
    database = await open(databasePath, BUYER, "buyer");
    store = database.createHttpOutboxStore({ retentionMs: longerRetentionMs });
    expect(await store.acknowledge({
      envelopeId: signed.envelopeId,
      envelopeHash: put.record.envelopeHash,
      acknowledgement,
    })).toMatchObject({
      status: "recorded",
      record: {
        acknowledgementRetentionMs: longerRetentionMs,
        retainUntil: receivedAt + longerRetentionMs,
        revision: 3,
      },
    });

    database.checkpoint();
    close(database);
    database = await open(databasePath, BUYER, "buyer");
    store = database.createHttpOutboxStore();
    expect(await store.acknowledge({
      envelopeId: signed.envelopeId,
      envelopeHash: put.record.envelopeHash,
      acknowledgement,
    })).toMatchObject({
      status: "existing",
      record: {
        acknowledgementRetentionMs: longerRetentionMs,
        retainUntil: receivedAt + longerRetentionMs,
        revision: 3,
      },
    });
  });

  it("rejects a fully rehashed final record shortened below its persisted acknowledgement policy", async () => {
    const databasePath = join(root(), "buyer.sqlite");
    const configuredRetentionMs = 2 * DACS_HTTP_MINIMUM_RETENTION_MS;
    const database = await open(databasePath, BUYER, "buyer");
    const store = database.createHttpOutboxStore({ retentionMs: configuredRetentionMs });
    const now = await store.readTime();
    const signed = await envelope("buyer", 19, now);
    const initialRetainUntil = now + configuredRetentionMs + 10_000;
    const put = await store.put({ envelope: signed, retainUntil: initialRetainUntil });
    if (!put.record) throw new Error("expected outbox record");
    const receivedAt = now + 120_000;
    const acknowledgementEnvelope = await createDacsHttpAcknowledgementEnvelopeV1(
      signed,
      {
        disposition: "accepted",
        issuedAt: receivedAt - 1_000,
        expiresAt: receivedAt + 299_000,
        nonce: nonce(50),
      },
      (bytes) => ed25519Sign(bytes, SELLER_KEY),
    );
    const acknowledgement = await authenticate(acknowledgementEnvelope, BUYER, receivedAt);
    advanceStoreClock(databasePath, receivedAt);
    await store.acknowledge({
      envelopeId: signed.envelopeId,
      envelopeHash: put.record.envelopeHash,
      acknowledgement,
    });
    database.checkpoint();
    close(database);

    const raw = new BetterSqlite3(databasePath);
    const row = raw.prepare(`
      SELECT record_json FROM dacs_http_outbox WHERE envelope_id = ?
    `).get(signed.envelopeId) as { record_json: string };
    const historyRow = raw.prepare(`
      SELECT revision, occurred_at, previous_entry_hash
      FROM dacs_http_outbox_history
      WHERE envelope_id = ? AND revision = 2
    `).get(signed.envelopeId) as {
      revision: number;
      occurred_at: number;
      previous_entry_hash: string | null;
    };
    const record = JSON.parse(row.record_json) as Record<string, unknown>;
    // This remains monotonic and exceeds seven days after ACK receipt, but is
    // one millisecond short of the authenticated fourteen-day policy.
    const shortenedRetainUntil = receivedAt + configuredRetentionMs - 1;
    record.retainUntil = shortenedRetainUntil;
    const shortenedJson = canonicalize(record);
    const shortenedHash = sha256Hex(shortenedJson);
    const shortenedEntryHash = outboxHistoryEntryHash({
      identity: signed.envelopeId,
      revision: historyRow.revision,
      occurredAt: historyRow.occurred_at,
      recordHash: shortenedHash,
      previousEntryHash: historyRow.previous_entry_hash,
    });
    raw.transaction(() => {
      raw.prepare(`
        UPDATE dacs_http_outbox
        SET retain_until = ?, record_hash = ?, record_json = ?
        WHERE envelope_id = ?
      `).run(shortenedRetainUntil, shortenedHash, shortenedJson, signed.envelopeId);
      raw.prepare(`
        UPDATE dacs_http_outbox_history
        SET record_hash = ?, record_json = ?, entry_hash = ?
        WHERE envelope_id = ? AND revision = 2
      `).run(shortenedHash, shortenedJson, shortenedEntryHash, signed.envelopeId);
    })();
    raw.close();

    await expect(open(databasePath, BUYER, "buyer")).rejects.toMatchObject({
      reasonCode: "http-outbox-record-corrupt",
    });
  });

  it("rejects a fully rehashed history transition shortened below its persisted acknowledgement policy", async () => {
    const databasePath = join(root(), "buyer.sqlite");
    const configuredRetentionMs = 2 * DACS_HTTP_MINIMUM_RETENTION_MS;
    const database = await open(databasePath, BUYER, "buyer");
    const store = database.createHttpOutboxStore({ retentionMs: configuredRetentionMs });
    const now = await store.readTime();
    const signed = await envelope("buyer", 20, now);
    const put = await store.put({
      envelope: signed,
      retainUntil: now + configuredRetentionMs + 10_000,
    });
    if (!put.record) throw new Error("expected outbox record");
    const receivedAt = now + 120_000;
    const acknowledgementEnvelope = await createDacsHttpAcknowledgementEnvelopeV1(
      signed,
      {
        disposition: "accepted",
        issuedAt: receivedAt - 1_000,
        expiresAt: receivedAt + 299_000,
        nonce: nonce(51),
      },
      (bytes) => ed25519Sign(bytes, SELLER_KEY),
    );
    const acknowledgement = await authenticate(acknowledgementEnvelope, BUYER, receivedAt);
    advanceStoreClock(databasePath, receivedAt);
    await store.acknowledge({
      envelopeId: signed.envelopeId,
      envelopeHash: put.record.envelopeHash,
      acknowledgement,
    });
    await store.extendRetention({
      jobId: JOB_ID,
      retainUntil: receivedAt + configuredRetentionMs + 10_000,
    });
    database.checkpoint();
    close(database);

    const raw = new BetterSqlite3(databasePath);
    const rows = raw.prepare(`
      SELECT revision, occurred_at, record_hash, record_json,
        previous_entry_hash, entry_hash
      FROM dacs_http_outbox_history
      WHERE envelope_id = ? ORDER BY revision
    `).all(signed.envelopeId) as Array<{
      revision: number;
      occurred_at: number;
      record_hash: string;
      record_json: string;
      previous_entry_hash: string | null;
      entry_hash: string;
    }>;
    const acknowledgementRow = rows[1]!;
    const finalRow = rows[2]!;
    const acknowledgementRecord = JSON.parse(acknowledgementRow.record_json) as
      Record<string, unknown>;
    acknowledgementRecord.retainUntil = receivedAt + configuredRetentionMs - 1;
    const shortenedJson = canonicalize(acknowledgementRecord);
    const shortenedHash = sha256Hex(shortenedJson);
    const shortenedEntryHash = outboxHistoryEntryHash({
      identity: signed.envelopeId,
      revision: acknowledgementRow.revision,
      occurredAt: acknowledgementRow.occurred_at,
      recordHash: shortenedHash,
      previousEntryHash: acknowledgementRow.previous_entry_hash,
    });
    raw.prepare(`
      UPDATE dacs_http_outbox_history
      SET record_hash = ?, record_json = ?, entry_hash = ?
      WHERE envelope_id = ? AND revision = 2
    `).run(shortenedHash, shortenedJson, shortenedEntryHash, signed.envelopeId);
    raw.prepare(`
      UPDATE dacs_http_outbox_history
      SET previous_entry_hash = ?, entry_hash = ?
      WHERE envelope_id = ? AND revision = 3
    `).run(
      shortenedEntryHash,
      outboxHistoryEntryHash({
        identity: signed.envelopeId,
        revision: finalRow.revision,
        occurredAt: finalRow.occurred_at,
        recordHash: finalRow.record_hash,
        previousEntryHash: shortenedEntryHash,
      }),
      signed.envelopeId,
    );
    raw.close();

    await expect(open(databasePath, BUYER, "buyer")).rejects.toMatchObject({
      reasonCode: "http-store-history-corrupt",
    });
  });

  it("fails closed when acknowledgement retention would overflow", async () => {
    const databasePath = join(root(), "buyer.sqlite");
    const database = await open(databasePath, BUYER, "buyer");
    const store = database.createHttpOutboxStore();
    const now = await store.readTime();
    const signed = await envelope("buyer", 17, now);
    const put = await store.put({
      envelope: signed,
      retainUntil: now + DACS_HTTP_MINIMUM_RETENTION_MS + 10_000,
    });
    if (!put.record) throw new Error("expected outbox record");
    const receivedAt = Number.MAX_SAFE_INTEGER - 100_000;
    const acknowledgementEnvelope = await createDacsHttpAcknowledgementEnvelopeV1(
      signed,
      {
        disposition: "accepted",
        issuedAt: receivedAt - 1_000,
        expiresAt: Number.MAX_SAFE_INTEGER - 1,
        nonce: nonce(48),
      },
      (bytes) => ed25519Sign(bytes, SELLER_KEY),
    );
    const acknowledgement = await authenticate(acknowledgementEnvelope, BUYER, receivedAt);
    advanceStoreClock(databasePath, receivedAt);

    await expect(store.acknowledge({
      envelopeId: signed.envelopeId,
      envelopeHash: put.record.envelopeHash,
      acknowledgement,
    })).rejects.toMatchObject({ reasonCode: "http-retention-overflow" });
    const retained = await store.load(signed.envelopeId);
    expect(retained).toMatchObject({
      state: "pending",
      revision: 1,
    });
    expect(retained?.acknowledgement).toBeUndefined();
  });

  it("uses monotonic exponential backoff, caps it at 60 seconds and stops at expiry", async () => {
    const databasePath = join(root(), "buyer.sqlite");
    const database = await open(databasePath, BUYER, "buyer");
    const store = database.createHttpOutboxStore({ retryJitter: () => 0 });
    const now = await store.readTime();
    const signed = await envelope("buyer", 8, now);
    const put = await store.put({
      envelope: signed,
      retainUntil: now + DACS_HTTP_MINIMUM_RETENTION_MS + 10_000,
    });
    if (!put.record) throw new Error("expected outbox record");

    let nextAttemptAt = now;
    for (const [attempt, expectedDelay] of [
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000,
    ].entries()) {
      advanceStoreClock(databasePath, nextAttemptAt);
      const claim = await store.claim({
        envelopeId: signed.envelopeId,
        envelopeHash: put.record.envelopeHash,
        owner: `worker-${attempt + 1}`,
        leaseDurationMs: 1_000,
      });
      if (claim.status !== "acquired") throw new Error(`attempt ${attempt + 1} not acquired`);
      const failure = await store.recordSendFailure({
        envelopeId: signed.envelopeId,
        envelopeHash: put.record.envelopeHash,
        lease: claim.lease,
        reasonCode: "response-ambiguous",
      });
      if (!failure.record) throw new Error("expected retry record");
      expect(failure.record.nextAttemptAt - failure.record.updatedAt).toBe(expectedDelay);
      nextAttemptAt = failure.record.nextAttemptAt;
    }
    advanceStoreClock(databasePath, signed.expiresAt);
    expect(await store.readTime()).toBe(signed.expiresAt);
    expect(await store.listRunnable({ limit: 10 })).toEqual({ items: [] });
    expect(await store.load(signed.envelopeId)).toMatchObject({
      state: "operator-action",
      reasonCode: "envelope-expired",
    });
    // SQLite's wall clock is still behind the injected durable clock.
    expect(await store.readTime()).toBe(signed.expiresAt);
  });

  it("converges concurrent claims and fences the worker whose generation expired", async () => {
    const databasePath = join(root(), "buyer.sqlite");
    const firstDatabase = await open(databasePath, BUYER, "buyer");
    const secondDatabase = await open(databasePath, BUYER, "buyer");
    const first = firstDatabase.createHttpOutboxStore();
    const second = secondDatabase.createHttpOutboxStore();
    const now = await first.readTime();
    const signed = await envelope("buyer", 9, now);
    const put = await first.put({
      envelope: signed,
      retainUntil: now + DACS_HTTP_MINIMUM_RETENTION_MS + 10_000,
    });
    if (!put.record) throw new Error("expected outbox record");
    const input = {
      envelopeId: signed.envelopeId,
      envelopeHash: put.record.envelopeHash,
      leaseDurationMs: 1_000,
    };
    const results = await Promise.all([
      first.claim({ ...input, owner: "worker-a" }),
      second.claim({ ...input, owner: "worker-b" }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["acquired", "waiting"]);
    const acquired = results.find((result) => result.status === "acquired");
    if (!acquired || acquired.status !== "acquired") throw new Error("missing acquired claim");
    advanceStoreClock(databasePath, acquired.lease.expiresAt);
    const replacement = await second.claim({ ...input, owner: "worker-c" });
    expect(replacement).toMatchObject({
      status: "acquired",
      lease: { generation: acquired.lease.generation + 1 },
    });
    expect(await first.recordSendFailure({
      envelopeId: input.envelopeId,
      envelopeHash: input.envelopeHash,
      lease: acquired.lease,
      reasonCode: "stale-worker-result",
    })).toEqual({ status: "stale" });
  });

  it("extends terminal retention, paginates stably and refuses tampered projections", async () => {
    const databasePath = join(root(), "seller.sqlite");
    const database = await open(databasePath);
    const store = database.createHttpInboxStore();
    const now = await store.readTime();
    const first = await envelope("buyer", 6, now);
    const second = await envelope("buyer", 7, now);
    const retainUntil = now + DACS_HTTP_MINIMUM_RETENTION_MS + 10_000;
    for (const signed of [first, second]) {
      await store.reserve({
        authenticated: await authenticate(signed, SELLER, now),
        retainUntil,
      });
    }
    const page = await store.list({ limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeDefined();
    expect(await store.list({ cursor: page.nextCursor, limit: 1 })).toMatchObject({
      items: [{ state: "pending" }],
    });
    const extendedUntil = now + (2 * DACS_HTTP_MINIMUM_RETENTION_MS);
    expect(await store.extendRetention({ jobId: JOB_ID, retainUntil: extendedUntil }))
      .toEqual({ status: "extended", count: 2 });
    database.checkpoint();
    close(database);

    const raw = new BetterSqlite3(databasePath);
    raw.prepare(`UPDATE dacs_http_inbox SET payload_hash = ? WHERE envelope_id = ?`)
      .run("f".repeat(64), first.envelopeId);
    raw.close();
    await expect(open(databasePath)).rejects.toMatchObject({
      reasonCode: "http-inbox-record-corrupt",
    });
  });

  it("backs up and migrates an authenticated v5 database before adding transport state", async () => {
    const directory = root();
    const databasePath = join(directory, "legacy-v5.sqlite");
    const database = await open(databasePath);
    database.checkpoint();
    close(database);
    const raw = new BetterSqlite3(databasePath);
    raw.exec(`
      DROP TABLE dacs_http_inbox_history;
      DROP TABLE dacs_http_outbox_history;
      DROP TABLE dacs_http_inbox;
      DROP TABLE dacs_http_outbox;
      DROP TABLE dacs_http_clock;
      DELETE FROM dacs_migrations WHERE version = 6;
      UPDATE dacs_store_metadata SET schema_version = 5 WHERE singleton = 1;
      PRAGMA user_version = 5;
    `);
    raw.close();

    const migrated = await open(databasePath);
    expect(migrated.diagnostics().schemaVersion).toBe(DACS_NODE_SQLITE_SCHEMA_VERSION);
    expect(readdirSync(directory).filter((name) => name.includes(".backup-v5-")))
      .toHaveLength(1);
    expect(migrated.createHttpInboxStore()).toBeDefined();
    expect(migrated.createHttpOutboxStore()).toBeDefined();
  });
});
