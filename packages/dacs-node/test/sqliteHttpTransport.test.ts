import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
import { downgradeCoordinatorSchemaToV6 } from "./helpers/sqliteSchema.js";

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
  label = "durable-http-test",
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
          proposal: { jobId: JOB_ID, label },
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

type QuotaWriterResult = Readonly<{
  status: "fulfilled" | "rejected";
  result?: string;
  reasonCode?: string;
}>;

function startQuotaWriter(input: Readonly<{
  databasePath: string;
  readyPath: string;
  goPath: string;
  resultPath: string;
  nonceByte: number;
  label: string;
}>): Readonly<{ completion: Promise<QuotaWriterResult>; stop(): void }> {
  const packageRoot = fileURLToPath(new URL("../", import.meta.url));
  const child = spawn(process.execPath, [
    join(packageRoot, "../../node_modules/vitest/vitest.mjs"),
    "run",
    "test/fixtures/httpQuotaWriter.test.ts",
    "--config",
    "vitest.config.ts",
    "--pool=forks",
    "--maxWorkers=1",
    "--reporter=dot",
  ], {
    cwd: packageRoot,
    env: {
      ...process.env,
      DACS_HTTP_QUOTA_DATABASE: input.databasePath,
      DACS_HTTP_QUOTA_READY: input.readyPath,
      DACS_HTTP_QUOTA_GO: input.goPath,
      DACS_HTTP_QUOTA_RESULT: input.resultPath,
      DACS_HTTP_QUOTA_NONCE: String(input.nonceByte),
      DACS_HTTP_QUOTA_LABEL: input.label,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const completion = new Promise<QuotaWriterResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) {
        resolve(JSON.parse(readFileSync(input.resultPath, "utf8")) as QuotaWriterResult);
      } else {
        reject(new Error(
          `HTTP quota writer failed: code=${String(code)} signal=${String(signal)} ${stderr}`,
        ));
      }
    });
  });
  return Object.freeze({
    completion,
    stop: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    },
  });
}

async function waitForFiles(paths: readonly string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!paths.every((path) => existsSync(path))) {
    if (Date.now() >= deadline) throw new Error("HTTP quota writers did not reach their barrier");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

  it("keeps equivalent acknowledgement replay O(1) across receipt times and restart", async () => {
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
      status: "existing",
      record: {
        acknowledgementRetentionMs: configuredRetentionMs,
        retainUntil,
        revision: 2,
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
        retainUntil,
        revision: 2,
      },
    });
  });

  it("requires an explicit job transition to extend acknowledgement retention", async () => {
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
      status: "existing",
      record: {
        acknowledgementRetentionMs: DACS_HTTP_MINIMUM_RETENTION_MS,
        retainUntil: receivedAt + DACS_HTTP_MINIMUM_RETENTION_MS,
        revision: 2,
      },
    });
    expect(await store.extendRetention({
      jobId: JOB_ID,
      retainUntil: receivedAt + longerRetentionMs,
    })).toEqual({ status: "extended", count: 1 });

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
        acknowledgementRetentionMs: DACS_HTTP_MINIMUM_RETENTION_MS,
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
    const first = await envelope("buyer", 6, now, "pagination-first");
    const second = await envelope("buyer", 7, now, "pagination-second");
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

  it("collapses fresh-nonce semantic replay without consuming another row", async () => {
    const database = await open(join(root(), "seller.sqlite"));
    const store = database.createHttpInboxStore();
    const now = await store.readTime();
    const first = await envelope("buyer", 61, now, "same-semantic-action");
    const replay = await envelope("buyer", 62, now, "same-semantic-action");
    expect(first.envelopeId).not.toBe(replay.envelopeId);
    const retainUntil = now + DACS_HTTP_MINIMUM_RETENTION_MS + 10_000;
    const created = await store.reserve({
      authenticated: await authenticate(first, SELLER, now),
      retainUntil,
    });
    expect(created).toMatchObject({ status: "reserved" });
    const before = await store.diagnostics();
    const repeated = await store.reserve({
      authenticated: await authenticate(replay, SELLER, now),
      retainUntil,
    });
    expect(repeated).toMatchObject({
      status: "pending",
      replay: "semantic",
      receivedEnvelopeId: replay.envelopeId,
      record: { authenticated: { envelope: { envelopeId: first.envelopeId } } },
    });
    expect(await store.diagnostics()).toMatchObject({
      global: {
        retainedRows: before.global.retainedRows,
        retainedBytes: before.global.retainedBytes,
        reservedRows: before.global.reservedRows,
        reservedBytes: before.global.reservedBytes,
      },
      rejectedAdmissions: 0,
    });
  });

  it("collapses an inbox renewal with a later signed validity window", async () => {
    const database = await open(join(root(), "seller.sqlite"));
    const store = database.createHttpInboxStore();
    const now = await store.readTime();
    const first = await envelope("buyer", 67, now, "same-renewed-action");
    const renewal = await envelope("buyer", 68, now + 1_000, "same-renewed-action");
    const retainUntil = now + DACS_HTTP_MINIMUM_RETENTION_MS + 10_000;
    await expect(store.reserve({
      authenticated: await authenticate(first, SELLER, now),
      retainUntil,
    })).resolves.toMatchObject({ status: "reserved" });
    await expect(store.reserve({
      authenticated: await authenticate(renewal, SELLER, now + 1_000),
      retainUntil,
    })).resolves.toMatchObject({
      status: "pending",
      replay: "semantic",
      receivedEnvelopeId: renewal.envelopeId,
      record: { authenticated: { envelope: { envelopeId: first.envelopeId } } },
    });
  });

  it("durably rejects quota overflow and adopts the bound policy after restart", async () => {
    const databasePath = join(root(), "seller.sqlite");
    let database = await open(databasePath);
    let store = database.createHttpInboxStore({
      limits: { global: { maxRows: 3, maxBytes: 10_000_000 } },
    });
    const now = await store.readTime();
    const retainUntil = now + DACS_HTTP_MINIMUM_RETENTION_MS + 10_000;
    const first = await envelope("buyer", 63, now, "quota-first");
    const firstAuthentication = await authenticate(first, SELLER, now);
    await store.reserve({
      authenticated: firstAuthentication,
      retainUntil,
    });
    const second = await envelope("buyer", 64, now, "quota-second");
    await expect(store.reserve({
      authenticated: await authenticate(second, SELLER, now),
      retainUntil,
    })).rejects.toMatchObject({ reasonCode: "http-store-quota-exceeded" });
    expect(await store.diagnostics()).toMatchObject({
      pressure: "full",
      global: { retainedRows: 2, reservedRows: 1, maxRows: 3 },
      rejectedAdmissions: 1,
      lastRejection: { dimension: "global", dimensionKey: "all" },
    });
    await expect(store.recordDisposition({
      sender: BUYER,
      audience: SELLER,
      envelopeId: first.envelopeId,
      authenticationHash: firstAuthentication.authenticationHash,
      disposition: "accepted",
    })).resolves.toMatchObject({ status: "recorded", record: { revision: 2 } });
    expect(await store.diagnostics()).toMatchObject({
      global: { retainedRows: 3, reservedRows: 0, maxRows: 3 },
    });

    database.checkpoint();
    close(database);
    database = await open(databasePath);
    store = database.createHttpInboxStore();
    expect(await store.diagnostics()).toMatchObject({
      pressure: "full",
      global: { retainedRows: 3, reservedRows: 0, maxRows: 3 },
      rejectedAdmissions: 1,
    });
    expect(() => database.createHttpOutboxStore({
      limits: { global: { maxRows: 4, maxBytes: 10_000_000 } },
    })).toThrow(expect.objectContaining({ reasonCode: "http-store-policy-mismatch" }));
  });

  it("enforces peer, job, and message-type quotas independently", async () => {
    const cases = [
      {
        name: "peer",
        limits: { perPeer: { maxRows: 3, maxBytes: 10_000_000 } },
      },
      {
        name: "job",
        limits: { perJob: { maxRows: 3, maxBytes: 10_000_000 } },
      },
      {
        name: "message-type",
        limits: { perMessageType: { maxRows: 3, maxBytes: 10_000_000 } },
      },
    ] as const;
    for (const [index, item] of cases.entries()) {
      const database = await open(join(root(), `${item.name}.sqlite`));
      const store = database.createHttpInboxStore({ limits: item.limits });
      const now = await store.readTime();
      const retainUntil = now + DACS_HTTP_MINIMUM_RETENTION_MS + 10_000;
      for (let message = 0; message < 2; message += 1) {
        const signed = await envelope(
          "buyer",
          90 + (index * 2) + message,
          now,
          `${item.name}-${message}`,
        );
        const operation = store.reserve({
          authenticated: await authenticate(signed, SELLER, now),
          retainUntil,
        });
        if (message === 0) await expect(operation).resolves.toMatchObject({ status: "reserved" });
        else await expect(operation).rejects.toMatchObject({
          reasonCode: "http-store-quota-exceeded",
        });
      }
      expect(await store.diagnostics()).toMatchObject({
        rejectedAdmissions: 1,
        lastRejection: { dimension: item.name },
      });
    }
  });

  it("enforces canonical-byte quotas before allocating transport state", async () => {
    const database = await open(join(root(), "bytes.sqlite"));
    const store = database.createHttpInboxStore({
      limits: { global: { maxRows: 100, maxBytes: 1 } },
    });
    const now = await store.readTime();
    const signed = await envelope("buyer", 108, now, "byte-pressure");
    await expect(store.reserve({
      authenticated: await authenticate(signed, SELLER, now),
      retainUntil: now + DACS_HTTP_MINIMUM_RETENTION_MS + 10_000,
    })).rejects.toMatchObject({ reasonCode: "http-store-quota-exceeded" });
    expect(await store.diagnostics()).toMatchObject({
      global: {
        retainedRows: 0,
        retainedBytes: 0,
        reservedRows: 0,
        reservedBytes: 0,
        maxBytes: 1,
      },
      rejectedAdmissions: 1,
      lastRejection: { dimension: "global" },
    });
  });

  it("reserves exact byte headroom for a terminal disposition", async () => {
    const baseline = await open(join(root(), "baseline.sqlite"));
    const baselineStore = baseline.createHttpInboxStore();
    const now = await baselineStore.readTime();
    const signed = await envelope("buyer", 109, now, "byte-headroom");
    const authenticated = await authenticate(signed, SELLER, now);
    const retainUntil = now + DACS_HTTP_MINIMUM_RETENTION_MS + 10_000;
    await baselineStore.reserve({ authenticated, retainUntil });
    const baselineUsage = (await baselineStore.diagnostics()).global;
    const exactMaximum = baselineUsage.retainedBytes + baselineUsage.reservedBytes;

    const constrained = await open(join(root(), "constrained.sqlite"));
    const store = constrained.createHttpInboxStore({
      limits: { global: { maxRows: 3, maxBytes: exactMaximum } },
    });
    await expect(store.reserve({ authenticated, retainUntil })).resolves.toMatchObject({
      status: "reserved",
    });
    await expect(store.recordDisposition({
      sender: BUYER,
      audience: SELLER,
      envelopeId: signed.envelopeId,
      authenticationHash: authenticated.authenticationHash,
      disposition: "accepted",
    })).resolves.toMatchObject({ status: "recorded" });
    expect(await store.diagnostics()).toMatchObject({
      global: {
        retainedRows: 3,
        reservedRows: 0,
        reservedBytes: 0,
        maxRows: 3,
        maxBytes: exactMaximum,
      },
    });
  });

  it("keeps quota admission atomic across contending processes", async () => {
    const directory = root();
    const databasePath = join(directory, "seller.sqlite");
    const database = await open(databasePath);
    const limits = { global: { maxRows: 3, maxBytes: 10_000_000 } } as const;
    database.createHttpInboxStore({ limits });
    database.checkpoint();
    close(database);
    const goPath = join(directory, "go");
    const writers = [
      startQuotaWriter({
        databasePath,
        readyPath: join(directory, "ready-a"),
        goPath,
        resultPath: join(directory, "result-a.json"),
        nonceByte: 111,
        label: "contended-first",
      }),
      startQuotaWriter({
        databasePath,
        readyPath: join(directory, "ready-b"),
        goPath,
        resultPath: join(directory, "result-b.json"),
        nonceByte: 112,
        label: "contended-second",
      }),
    ];
    let results: QuotaWriterResult[];
    try {
      await waitForFiles([
        join(directory, "ready-a"),
        join(directory, "ready-b"),
      ], 15_000);
      writeFileSync(goPath, "go", { encoding: "utf8", flag: "wx" });
      results = await Promise.all(writers.map((writer) => writer.completion));
    } finally {
      for (const writer of writers) writer.stop();
    }
    expect(results!.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(results!.find((result) => result.status === "rejected")).toMatchObject({
      reasonCode: "http-store-quota-exceeded",
    });
    const reopened = await open(databasePath);
    const store = reopened.createHttpInboxStore();
    expect(await store.diagnostics()).toMatchObject({
      global: { retainedRows: 2, reservedRows: 1 },
      rejectedAdmissions: 1,
    });
  }, 30_000);

  it("reserves the final revision for ACK or operator action", async () => {
    const database = await open(join(root(), "buyer.sqlite"), BUYER, "buyer");
    const store = database.createHttpOutboxStore({
      limits: { maxRevisionsPerMessage: 3 },
    });
    const now = await store.readTime();
    const signed = await envelope("buyer", 114, now, "revision-headroom");
    const put = await store.put({
      envelope: signed,
      retainUntil: now + DACS_HTTP_MINIMUM_RETENTION_MS + 10_000,
    });
    if (!put.record) throw new Error("expected outbox record");
    const claim = await store.claim({
      envelopeId: signed.envelopeId,
      envelopeHash: put.record.envelopeHash,
      owner: "revision-worker",
      leaseDurationMs: 10_000,
    });
    if (claim.status !== "acquired") throw new Error("expected outbox lease");
    await expect(store.recordSendFailure({
      envelopeId: signed.envelopeId,
      envelopeHash: put.record.envelopeHash,
      lease: claim.lease,
      reasonCode: "response-ambiguous",
    })).rejects.toMatchObject({ reasonCode: "http-store-revision-limit" });
    await expect(store.requireOperatorAction({
      envelopeId: signed.envelopeId,
      envelopeHash: put.record.envelopeHash,
      lease: claim.lease,
      reasonCode: "revision-capacity-exhausted",
    })).resolves.toMatchObject({
      status: "recorded",
      record: { state: "operator-action", revision: 3 },
    });
    expect(await store.diagnostics()).toMatchObject({
      operatorActionRecords: 1,
      global: { reservedRows: 0, reservedBytes: 0 },
      rejectedAdmissions: 1,
      lastRejection: { dimension: "revision" },
    });
  });

  it("bounds lease-owner data before it can consume retained quota", async () => {
    const database = await open(join(root(), "buyer.sqlite"), BUYER, "buyer");
    const store = database.createHttpOutboxStore();
    const now = await store.readTime();
    const signed = await envelope("buyer", 115, now, "bounded-lease-owner");
    const put = await store.put({
      envelope: signed,
      retainUntil: now + DACS_HTTP_MINIMUM_RETENTION_MS + 10_000,
    });
    if (!put.record) throw new Error("expected outbox record");
    await expect(store.claim({
      envelopeId: signed.envelopeId,
      envelopeHash: put.record.envelopeHash,
      owner: "x".repeat(257),
      leaseDurationMs: 10_000,
    })).resolves.toEqual({ status: "stale" });
    await expect(store.load(signed.envelopeId)).resolves.toMatchObject({
      state: "pending",
      revision: 1,
    });
  });

  it("translates SQLite disk exhaustion into a stable fail-closed result", async () => {
    const database = await open(join(root(), "seller.sqlite"));
    const store = database.createHttpInboxStore();
    const connection = (database as unknown as {
      database: BetterSqlite3.Database;
    }).database;
    const pageCount = connection.pragma("page_count", { simple: true }) as number;
    connection.pragma(`max_page_count = ${pageCount}`);
    const now = await store.readTime();
    const signed = await envelope("buyer", 113, now, "x".repeat(200_000));
    await expect(store.reserve({
      authenticated: await authenticate(signed, SELLER, now),
      retainUntil: now + DACS_HTTP_MINIMUM_RETENTION_MS + 10_000,
    })).rejects.toMatchObject({ reasonCode: "http-store-disk-full" });
    expect(await store.diagnostics()).toMatchObject({
      global: { retainedRows: 0, retainedBytes: 0, reservedRows: 0, reservedBytes: 0 },
      rejectedAdmissions: 1,
      lastRejection: { dimension: "disk", dimensionKey: "database" },
    });
  });

  it("purges only elapsed terminal records in bounded crash-resumable pages", async () => {
    const databasePath = join(root(), "seller.sqlite");
    let database = await open(databasePath);
    let store = database.createHttpInboxStore({ limits: { purgeBatchSize: 1 } });
    const now = await store.readTime();
    const retainUntil = now + DACS_HTTP_MINIMUM_RETENTION_MS + 10_000;
    const signed: Readonly<DacsHttpEnvelopeV1>[] = [];
    for (let index = 0; index < 3; index += 1) {
      const message = await envelope("buyer", 70 + index, now, `purge-${index}`);
      signed.push(message);
      const authenticated = await authenticate(message, SELLER, now);
      await store.reserve({ authenticated, retainUntil });
      await store.recordDisposition({
        sender: BUYER,
        audience: SELLER,
        envelopeId: message.envelopeId,
        authenticationHash: authenticated.authenticationHash,
        disposition: "accepted",
      });
    }
    expect(await store.purge()).toMatchObject({
      examined: 1,
      purgedRecords: 0,
      nextCursor: expect.any(String),
    });
    advanceStoreClock(databasePath, retainUntil + 1);
    const firstPage = await store.purge();
    database.checkpoint();
    close(database);
    database = await open(databasePath);
    store = database.createHttpInboxStore();
    const pages = [firstPage, await store.purge(), await store.purge()];
    expect(pages.map((page) => page.purgedRecords)).toEqual([1, 1, 1]);
    expect((await store.purge()).purgedRecords).toBe(0);
    for (const message of signed) {
      await expect(store.load({
        sender: BUYER,
        audience: SELLER,
        envelopeId: message.envelopeId,
      })).resolves.toBeUndefined();
    }
    expect(await store.diagnostics()).toMatchObject({
      global: { retainedRows: 0, retainedBytes: 0, reservedRows: 0, reservedBytes: 0 },
      purgedRecords: 3,
      purgedRows: 9,
    });
  });

  it("bounds expiry work and never purges operator-action records", async () => {
    const databasePath = join(root(), "buyer.sqlite");
    const database = await open(databasePath, BUYER, "buyer");
    const store = database.createHttpOutboxStore({
      limits: { expiryBatchSize: 1, purgeBatchSize: 1 },
    });
    const now = await store.readTime();
    const retainUntil = now + DACS_HTTP_MINIMUM_RETENTION_MS + 10_000;
    for (let index = 0; index < 3; index += 1) {
      await store.put({
        envelope: await envelope("buyer", 80 + index, now, `expiry-${index}`),
        retainUntil,
      });
    }
    advanceStoreClock(databasePath, now + 300_000);
    await store.listRunnable({ limit: 10 });
    expect(await store.diagnostics()).toMatchObject({ operatorActionRecords: 1 });
    await store.listRunnable({ limit: 10 });
    expect(await store.diagnostics()).toMatchObject({ operatorActionRecords: 2 });
    await store.listRunnable({ limit: 10 });
    expect(await store.diagnostics()).toMatchObject({ operatorActionRecords: 3 });
    advanceStoreClock(databasePath, retainUntil + 1);
    expect(await store.purge()).toMatchObject({ purgedRecords: 0 });
    expect(await store.diagnostics()).toMatchObject({
      operatorActionRecords: 3,
      global: { retainedRows: 9, reservedRows: 0 },
    });
  });

  it("uses bounded physical indexes for lifecycle scans", async () => {
    const database = await open(join(root(), "seller.sqlite"));
    const connection = (database as unknown as {
      database: BetterSqlite3.Database;
    }).database;
    const detail = (sql: string, ...parameters: unknown[]): string =>
      (connection.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as {
        detail: string;
      }[]).map((row) => row.detail).join("\n");
    expect(detail(`
      SELECT * FROM dacs_http_inbox
      WHERE (envelope_id, sender, audience) > (?, ?, ?) AND state = 'disposed'
      ORDER BY envelope_id, sender, audience LIMIT ?
    `, "", "", "", 64)).toContain("dacs_http_inbox_page_idx");
    expect(detail(`
      SELECT * FROM dacs_http_outbox
      WHERE envelope_id > ? AND state = 'acknowledged'
      ORDER BY envelope_id LIMIT ?
    `, "", 64)).toContain("dacs_http_outbox_page_idx");
    expect(detail(`
      SELECT * FROM dacs_http_outbox INDEXED BY dacs_http_outbox_active_scan_idx
      WHERE envelope_id > ? AND state IN ('pending', 'sending')
      ORDER BY envelope_id LIMIT ?
    `, "", 64)).toContain("dacs_http_outbox_active_scan_idx");
  });

  it("rejects proxied lifecycle inputs without invoking caller getters", async () => {
    const database = await open(join(root(), "seller.sqlite"));
    const store = database.createHttpInboxStore();
    let invoked = false;
    const hostile = new Proxy({ limit: 1 }, {
      get() {
        invoked = true;
        throw new Error("caller code must not run");
      },
    });
    await expect(store.list(hostile)).rejects.toMatchObject({
      reasonCode: "http-store-input-malformed",
    });
    expect(invoked).toBe(false);
  });

  it("retains and rejects own __proto__ members at every captured depth", async () => {
    const database = await open(join(root(), "buyer.sqlite"), BUYER, "buyer");
    const store = database.createHttpOutboxStore();
    const topLevel = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(topLevel, {
      limit: { value: 1, enumerable: true },
    });
    Object.defineProperty(topLevel, "__proto__", { value: null, enumerable: true });
    await expect(store.list(topLevel as never)).rejects.toMatchObject({
      reasonCode: "http-store-input-malformed",
    });

    const nestedLease = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(nestedLease, {
      owner: { value: "worker", enumerable: true },
      generation: { value: 1, enumerable: true },
      expiresAt: { value: 1, enumerable: true },
    });
    Object.defineProperty(nestedLease, "__proto__", { value: null, enumerable: true });
    await expect(store.isCurrent({
      envelopeId: "a".repeat(64),
      envelopeHash: "b".repeat(64),
      lease: nestedLease as never,
    })).resolves.toBe(false);
  });

  it("fails closed when durable usage accounting is altered", async () => {
    const databasePath = join(root(), "seller.sqlite");
    const database = await open(databasePath);
    const store = database.createHttpInboxStore();
    const now = await store.readTime();
    const signed = await envelope("buyer", 110, now, "usage-integrity");
    await store.reserve({
      authenticated: await authenticate(signed, SELLER, now),
      retainUntil: now + DACS_HTTP_MINIMUM_RETENTION_MS,
    });
    database.checkpoint();
    close(database);
    const raw = new BetterSqlite3(databasePath);
    raw.prepare(`
      UPDATE dacs_http_usage SET retained_rows = retained_rows + 1
      WHERE dimension = 'global' AND dimension_key = 'all'
    `).run();
    raw.close();
    await expect(open(databasePath)).rejects.toMatchObject({
      reasonCode: "http-store-usage-corrupt",
    });
  });

  it("backs up and migrates an authenticated v5 database before adding transport state", async () => {
    const directory = root();
    const databasePath = join(directory, "legacy-v5.sqlite");
    const database = await open(databasePath);
    database.checkpoint();
    close(database);
    const raw = new BetterSqlite3(databasePath);
    downgradeCoordinatorSchemaToV6(raw);
    raw.exec(`
      DROP TABLE dacs_http_lifecycle;
      DROP TABLE dacs_http_usage;
      DROP TABLE dacs_http_policy;
      DROP TABLE dacs_http_inbox_history;
      DROP TABLE dacs_http_outbox_history;
      DROP TABLE dacs_http_inbox;
      DROP TABLE dacs_http_outbox;
      DROP TABLE dacs_http_clock;
      DELETE FROM dacs_migrations WHERE version >= 6;
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

  it("backs up and migrates an authenticated v6 transport database", async () => {
    const directory = root();
    const databasePath = join(directory, "legacy-v6.sqlite");
    let database = await open(databasePath);
    let store = database.createHttpInboxStore();
    const now = await store.readTime();
    const original = await envelope("buyer", 120, now, "legacy-v6-semantic");
    await store.reserve({
      authenticated: await authenticate(original, SELLER, now),
      retainUntil: now + DACS_HTTP_MINIMUM_RETENTION_MS + 10_000,
    });
    database.checkpoint();
    close(database);
    const raw = new BetterSqlite3(databasePath);
    downgradeCoordinatorSchemaToV6(raw);
    raw.exec(`
      DROP INDEX dacs_http_inbox_semantic_idx;
      DROP INDEX dacs_http_outbox_semantic_idx;
      DROP INDEX dacs_http_inbox_retention_idx;
      DROP INDEX dacs_http_outbox_retention_idx;
      DROP INDEX dacs_http_outbox_active_scan_idx;
      DROP TABLE dacs_http_lifecycle;
      DROP TABLE dacs_http_usage;
      DROP TABLE dacs_http_policy;
      ALTER TABLE dacs_http_inbox DROP COLUMN semantic_key;
      ALTER TABLE dacs_http_outbox DROP COLUMN semantic_key;
      DELETE FROM dacs_migrations WHERE version = 8;
      DELETE FROM dacs_migrations WHERE version = 7;
      UPDATE dacs_store_metadata SET schema_version = 6 WHERE singleton = 1;
      PRAGMA user_version = 6;
    `);
    raw.close();

    database = await open(databasePath);
    expect(database.diagnostics().schemaVersion).toBe(DACS_NODE_SQLITE_SCHEMA_VERSION);
    expect(readdirSync(directory).filter((name) => name.includes(".backup-v6-")))
      .toHaveLength(1);
    store = database.createHttpInboxStore();
    expect(await store.diagnostics()).toMatchObject({
      global: { retainedRows: 2, reservedRows: 1 },
      rejectedAdmissions: 0,
    });
    const replay = await envelope("buyer", 121, now, "legacy-v6-semantic");
    await expect(store.reserve({
      authenticated: await authenticate(replay, SELLER, now),
      retainUntil: now + DACS_HTTP_MINIMUM_RETENTION_MS + 10_000,
    })).resolves.toMatchObject({
      status: "pending",
      record: { authenticated: { envelope: { envelopeId: original.envelopeId } } },
    });
  });
});
