import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  contentHash,
  createDurableRfqLifecycleClient,
  createFsDurableRfqLifecycleStore,
  type AttestationRef,
  type DurableRfqLifecycleRecord,
  type DurableRfqLifecycleTransport,
  type IdentityBundle,
  type Listing,
  type RfqLifecyclePacket,
} from "../../src/index.js";

const NOW = 1_780_000_000_000;
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7E";
const BUYER = "did:demos:buyer-rfq-filesystem";
const SELLER = "did:demos:seller-rfq-filesystem";
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function identity(claim: string): IdentityBundle {
  return {
    bundleVersion: "1",
    presentedBy: claim,
    presentedAt: NOW - 1_000,
    claims: [{ ref: claim }],
    presentation: {
      kind: "per-claim",
      signatures: [{ ref: claim, signature: "identity-proof" }],
    },
  };
}

function vetRef(locator: string): AttestationRef {
  return {
    anchor: { kind: "storage-program", locator },
    contentHash: "a".repeat(64),
  };
}

const buyer = {
  identityBundle: identity(BUYER),
  vetRecordRef: vetRef("stor:buyer-rfq-filesystem-vet"),
};
const seller = {
  identityBundle: identity(SELLER),
  vetRecordRef: vetRef("stor:seller-rfq-filesystem-vet"),
};

function listing(): Listing {
  return {
    dacsVersion: "1",
    listingVersion: 3,
    listingId: "rfq-filesystem-listing",
    requiredCapabilities: ["SR-2", "SR-4"],
    seller: {
      identity: identity(SELLER),
      displayName: "RFQ filesystem seller",
      publicEndpoint: "https://seller.example/dacs",
    },
    offering: {
      title: "Persistent private quote",
      description: "A process-restart RFQ fixture",
      category: "data.finance",
      tags: ["rfq"],
      deliverable: {
        kind: "attested-payload",
        payloadFormat: "application/json",
        verificationMethod: { kind: "self-signed" },
      },
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      {
        kind: "negotiate-rfq",
        parameters: { maxTurns: 4, timeoutSec: 10 },
      },
      { kind: "commit-agreement" },
      { kind: "deliver-attested-payload" },
    ],
    pricing: {
      kind: "negotiable",
      bandCenter: { amount: "10", currency: "USDC" },
      minPct: 20,
      maxPct: 20,
    },
    terms: { deadlineSecAfterCommit: 600 },
    validity: { notBefore: NOW - 10_000, notAfter: NOW + 1_000_000 },
    signature: {
      algorithm: "ed25519",
      signer: SELLER,
      value: Buffer.alloc(64, 7).toString("base64url"),
    },
  };
}

function openInput() {
  const value = listing();
  return {
    jobId: JOB_ID,
    verifiedListing: {
      disposition: "verified" as const,
      listing: value,
      pin: {
        listingId: value.listingId,
        version: value.listingVersion,
        contentHash: contentHash(value as unknown as Record<string, unknown>),
      },
    },
    buyer,
    seller,
    channelId: "rfq-filesystem-channel-01",
  };
}

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "dacs-rfq-fs-"));
  temporaryRoots.push(path);
  return path;
}

function clientOptions(
  store: Awaited<ReturnType<typeof createFsDurableRfqLifecycleStore<string>>>,
  transport: DurableRfqLifecycleTransport<string>,
  sign = vi.fn(() => "test-channel-signature"),
) {
  return {
    role: "buyer" as const,
    store,
    transport,
    reserveChannelId: () => "pass" as const,
    signChannelMessage: sign,
    verifyChannelMessage: () => "pass" as const,
    agreementSigner: {
      party: BUYER,
      algorithm: "ed25519" as const,
      sign: () => new Uint8Array(64),
    },
    verifyAgreementContribution: () => "valid" as const,
    nowMs: () => NOW,
  };
}

function lockPath(dir: string): string {
  const hash = createHash("sha256")
    .update(`buyer\u0000${JOB_ID}`)
    .digest("hex");
  return join(dir, "locks", `${hash}.lock`);
}

describe("keyed durable RFQ filesystem store", () => {
  test("recovers the exact pending packet through a new store and client instance", async () => {
    const parent = await root();
    const dir = join(parent, "buyer-rfq");
    const integrityKey = randomBytes(32);
    const accepted = new Map<string, RfqLifecyclePacket<string>>();
    let loseFirstResponse = true;
    const publish = vi.fn(async (packet: Readonly<RfqLifecyclePacket<string>>) => {
      if (loseFirstResponse) {
        loseFirstResponse = false;
        return { disposition: "indeterminate" as const, reason: "response lost" };
      }
      accepted.set(packet.packetId, structuredClone(packet));
      return { disposition: "acknowledged" as const };
    });
    const transport: DurableRfqLifecycleTransport<string> = {
      publish,
      async reconcile(packet) {
        return accepted.has(packet.packetId)
          ? { disposition: "acknowledged" as const }
          : { disposition: "absent" as const };
      },
    };
    const sign = vi.fn(() => "test-channel-signature");
    const firstStore = await createFsDurableRfqLifecycleStore<string>({
      dir,
      role: "buyer",
      integrityKey,
    });
    const firstClient = createDurableRfqLifecycleClient(
      clientOptions(firstStore, transport, sign),
    );
    await expect(firstClient.open(openInput())).resolves.toMatchObject({ status: "ready" });
    await expect(
      firstClient.sendOffer(JOB_ID, {
        rfqProposalVersion: "1",
        price: { amount: "9", currency: "USDC" },
      }),
    ).resolves.toMatchObject({ status: "indeterminate" });

    const restartedStore = await createFsDurableRfqLifecycleStore<string>({
      dir,
      role: "buyer",
      integrityKey,
    });
    const restartedClient = createDurableRfqLifecycleClient(
      clientOptions(restartedStore, transport, sign),
    );
    await expect(restartedClient.resumeOutbox(JOB_ID)).resolves.toMatchObject({
      status: "ready",
    });
    expect(sign).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]![0]).toEqual(publish.mock.calls[0]![0]);
    const loaded = await restartedStore.load("buyer", JOB_ID);
    expect(loaded.status).toBe("ok");
    if (loaded.status !== "ok") return;
    expect(loaded.record.outbox[0]).toMatchObject({ state: "acknowledged" });
  });

  test("authenticates records and rejects wrong keys, tampering, and unsafe file modes", async () => {
    const parent = await root();
    const dir = join(parent, "buyer-rfq");
    const integrityKey = randomBytes(32);
    const transport: DurableRfqLifecycleTransport<string> = {
      async publish() {
        return { disposition: "acknowledged" };
      },
      async reconcile() {
        return { disposition: "absent" };
      },
    };
    const store = await createFsDurableRfqLifecycleStore<string>({
      dir,
      role: "buyer",
      integrityKey,
    });
    await createDurableRfqLifecycleClient(clientOptions(store, transport)).open(
      openInput(),
    );
    const [filename] = await readdir(join(dir, "records"));
    if (filename === undefined) throw new Error("record was not created");
    const recordPath = join(dir, "records", filename);

    const wrongKeyStore = await createFsDurableRfqLifecycleStore<string>({
      dir,
      role: "buyer",
      integrityKey: randomBytes(32),
    });
    await expect(wrongKeyStore.load("buyer", JOB_ID)).resolves.toMatchObject({
      status: "corrupt",
      reason: "RFQ record authentication failed",
    });

    await chmod(recordPath, 0o644);
    await expect(store.load("buyer", JOB_ID)).resolves.toMatchObject({
      status: "corrupt",
      reason: "RFQ filesystem record has unsafe metadata",
    });
    await chmod(recordPath, 0o600);
    const parsed = JSON.parse(await readFile(recordPath, "utf8")) as {
      record: { updatedAt: number };
    };
    parsed.record.updatedAt += 1;
    await writeFile(recordPath, JSON.stringify(parsed), { mode: 0o600 });
    await expect(store.load("buyer", JOB_ID)).resolves.toMatchObject({
      status: "corrupt",
      reason: "RFQ record authentication failed",
    });
  });

  test("rejects unsafe existing directories rather than silently chmodding them", async () => {
    const parent = await root();
    const dir = join(parent, "unsafe-rfq");
    await mkdir(dir, { mode: 0o755 });
    await chmod(dir, 0o755);
    await expect(
      createFsDurableRfqLifecycleStore({
        dir,
        role: "buyer",
        integrityKey: randomBytes(32),
      }),
    ).rejects.toThrow("rejects unsafe existing directory permissions");
  });

  test("reclaims only a stale lock whose recorded process is dead", async () => {
    const parent = await root();
    const dir = join(parent, "buyer-rfq");
    const integrityKey = randomBytes(32);
    const store = await createFsDurableRfqLifecycleStore<string>({
      dir,
      role: "buyer",
      integrityKey,
      lockStaleMs: 5,
      lockTimeoutMs: 200,
      lockPollMs: 2,
    });
    const path = lockPath(dir);
    await writeFile(
      path,
      JSON.stringify({ pid: 2_147_483_647, token: "dead-lock-owner" }),
      { mode: 0o600, flag: "wx" },
    );
    const old = new Date(Date.now() - 1_000);
    await utimes(path, old, old);
    const transport: DurableRfqLifecycleTransport<string> = {
      async publish() {
        return { disposition: "acknowledged" };
      },
      async reconcile() {
        return { disposition: "absent" };
      },
    };

    await expect(
      createDurableRfqLifecycleClient(clientOptions(store, transport)).open(
        openInput(),
      ),
    ).resolves.toMatchObject({ status: "ready" });
    await expect(store.load("buyer", JOB_ID)).resolves.toMatchObject({
      status: "ok",
    });
  });

  test("does not evict a stale-looking lock owned by a live process", async () => {
    const parent = await root();
    const dir = join(parent, "buyer-rfq");
    const integrityKey = randomBytes(32);
    const store = await createFsDurableRfqLifecycleStore<string>({
      dir,
      role: "buyer",
      integrityKey,
      lockStaleMs: 5,
      lockTimeoutMs: 25,
      lockPollMs: 2,
    });
    const path = lockPath(dir);
    const owner = { pid: process.pid, token: "live-lock-owner" };
    await writeFile(path, JSON.stringify(owner), { mode: 0o600, flag: "wx" });
    const old = new Date(Date.now() - 1_000);
    await utimes(path, old, old);
    const transport: DurableRfqLifecycleTransport<string> = {
      async publish() {
        return { disposition: "acknowledged" };
      },
      async reconcile() {
        return { disposition: "absent" };
      },
    };

    await expect(
      createDurableRfqLifecycleClient(clientOptions(store, transport)).open(
        openInput(),
      ),
    ).resolves.toEqual({
      status: "indeterminate",
      reason: "RFQ filesystem create failed",
    });
    await expect(readFile(path, "utf8")).resolves.toBe(JSON.stringify(owner));
  });

  test("serializes cross-instance CAS and refuses symlink record substitution", async () => {
    const parent = await root();
    const dir = join(parent, "buyer-rfq");
    const integrityKey = randomBytes(32);
    const transport: DurableRfqLifecycleTransport<string> = {
      async publish() {
        return { disposition: "acknowledged" };
      },
      async reconcile() {
        return { disposition: "absent" };
      },
    };
    const first = await createFsDurableRfqLifecycleStore<string>({
      dir,
      role: "buyer",
      integrityKey,
    });
    const client = createDurableRfqLifecycleClient(clientOptions(first, transport));
    await client.open(openInput());
    await client.sendOffer(JOB_ID, {
      rfqProposalVersion: "1",
      price: { amount: "9", currency: "USDC" },
    });
    const second = await createFsDurableRfqLifecycleStore<string>({
      dir,
      role: "buyer",
      integrityKey,
    });
    const loaded = await first.load("buyer", JOB_ID);
    if (loaded.status !== "ok") throw new Error("record did not load");
    const next: DurableRfqLifecycleRecord<string> = {
      ...structuredClone(loaded.record),
      revision: loaded.record.revision + 1,
      updatedAt: loaded.record.updatedAt + 1,
    };
    await expect(
      first.compareAndSwap("buyer", JOB_ID, loaded.record.revision, next),
    ).resolves.toMatchObject({ status: "written" });
    await expect(
      second.compareAndSwap("buyer", JOB_ID, loaded.record.revision, next),
    ).resolves.toMatchObject({ status: "stale" });

    const latest = await first.load("buyer", JOB_ID);
    if (latest.status !== "ok") throw new Error("updated record did not load");
    const rollback: DurableRfqLifecycleRecord<string> = {
      ...structuredClone(latest.record),
      revision: latest.record.revision + 1,
      updatedAt: latest.record.updatedAt + 1,
      outbox: latest.record.outbox.map((entry, index) =>
        index === 0
          ? { ...entry, state: "pending" as const, attempts: 0 }
          : entry,
      ),
    };
    await expect(
      first.compareAndSwap("buyer", JOB_ID, latest.record.revision, rollback),
    ).resolves.toMatchObject({
      status: "corrupt",
      reason: "an existing outbox entry was replaced or rolled back",
    });

    const [filename] = await readdir(join(dir, "records"));
    if (filename === undefined) throw new Error("record was not created");
    const path = join(dir, "records", filename);
    const target = join(parent, "attacker.json");
    await writeFile(target, "{}", { mode: 0o600 });
    await unlink(path);
    await symlink(target, path);
    await expect(first.load("buyer", JOB_ID)).resolves.toMatchObject({
      status: "corrupt",
      reason: expect.stringContaining("unsafe metadata"),
    });
  });

  test("snapshots CAS candidates before filesystem awaits", async () => {
    const parent = await root();
    const dir = join(parent, "buyer-rfq");
    const store = await createFsDurableRfqLifecycleStore<string>({
      dir,
      role: "buyer",
      integrityKey: randomBytes(32),
    });
    const transport: DurableRfqLifecycleTransport<string> = {
      async publish() {
        return { disposition: "acknowledged" };
      },
      async reconcile() {
        return { disposition: "absent" };
      },
    };
    await createDurableRfqLifecycleClient(clientOptions(store, transport)).open(
      openInput(),
    );
    const loaded = await store.load("buyer", JOB_ID);
    if (loaded.status !== "ok") throw new Error("record did not load");
    const next: DurableRfqLifecycleRecord<string> = {
      ...structuredClone(loaded.record),
      revision: loaded.record.revision + 1,
      updatedAt: loaded.record.updatedAt + 1,
    };
    const expected = structuredClone(next);

    const pending = store.compareAndSwap(
      "buyer",
      JOB_ID,
      loaded.record.revision,
      next,
    );
    next.updatedAt += 100;
    next.bindingHash = "f".repeat(64);

    await expect(pending).resolves.toEqual({ status: "written", record: expected });
    await expect(store.load("buyer", JOB_ID)).resolves.toEqual({
      status: "ok",
      record: expected,
    });
  });

  test("snapshots create candidates before lock and read awaits", async () => {
    const parent = await root();
    const sourceDir = join(parent, "source-rfq");
    const destinationDir = join(parent, "destination-rfq");
    const source = await createFsDurableRfqLifecycleStore<string>({
      dir: sourceDir,
      role: "buyer",
      integrityKey: randomBytes(32),
    });
    const destination = await createFsDurableRfqLifecycleStore<string>({
      dir: destinationDir,
      role: "buyer",
      integrityKey: randomBytes(32),
    });
    const transport: DurableRfqLifecycleTransport<string> = {
      async publish() {
        return { disposition: "acknowledged" };
      },
      async reconcile() {
        return { disposition: "absent" };
      },
    };
    await createDurableRfqLifecycleClient(clientOptions(source, transport)).open(
      openInput(),
    );
    const loaded = await source.load("buyer", JOB_ID);
    if (loaded.status !== "ok") throw new Error("record did not load");
    const candidate = structuredClone(loaded.record) as
      DurableRfqLifecycleRecord<string>;
    const expected = structuredClone(candidate);

    const pending = destination.create(candidate);
    candidate.jobId = "01J8ME0SXKQ4T9V2RC5HJ6WX7F";
    candidate.role = "seller";
    candidate.bindingHash = "f".repeat(64);

    await expect(pending).resolves.toEqual({ status: "created", record: expected });
    await expect(destination.load("buyer", JOB_ID)).resolves.toEqual({
      status: "ok",
      record: expected,
    });
  });

  test("rejects record files with an unexpected hard-link alias", async () => {
    const parent = await root();
    const dir = join(parent, "buyer-rfq");
    const store = await createFsDurableRfqLifecycleStore<string>({
      dir,
      role: "buyer",
      integrityKey: randomBytes(32),
    });
    const transport: DurableRfqLifecycleTransport<string> = {
      async publish() {
        return { disposition: "acknowledged" };
      },
      async reconcile() {
        return { disposition: "absent" };
      },
    };
    await createDurableRfqLifecycleClient(clientOptions(store, transport)).open(
      openInput(),
    );
    const [filename] = await readdir(join(dir, "records"));
    if (filename === undefined) throw new Error("record was not created");
    const recordPath = join(dir, "records", filename);
    const aliasPath = join(parent, "record-alias.json");
    await link(recordPath, aliasPath);

    await expect(store.load("buyer", JOB_ID)).resolves.toMatchObject({
      status: "corrupt",
      reason: expect.stringContaining("hard links"),
    });
    await unlink(aliasPath);
  });
});
