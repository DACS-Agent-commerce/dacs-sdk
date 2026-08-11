import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import {
  createFsX402PaywallSettlementStore as createRootFsStore,
} from "../../src/index.js";
import {
  createFsX402PaywallSettlementStore as createRailsFsStore,
} from "../../src/rails/index.js";
import {
  x402PaywallSettlementKey,
  type X402PaywallSettlementIntent,
  type X402PaywallSettlementOutcome,
} from "../../src/rails/x402Paywall.js";
import {
  X402_PAYWALL_SETTLEMENT_STORE_VERSION,
  createFsX402PaywallSettlementStore,
} from "../../src/rails/x402PaywallSettlementFs.js";

const JOB_ID = "seller-job-cafe\u0301";
const PHASE_INDEX = 4;
const PAYER = `0x${"11".repeat(20)}`;
const NETWORK = "eip155:84532";
const PAY_TO = `0x${"22".repeat(20)}`;
const ASSET = `0x${"33".repeat(20)}`;

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryStoreDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dacs-x402-paywall-store-"));
  directories.push(directory);
  return directory;
}

function intentFor(
  httpResource = "https://seller.example/deliver/report",
  jobId = JOB_ID,
):
X402PaywallSettlementIntent {
  const paymentRequirements = {
    scheme: "exact",
    network: NETWORK,
    asset: ASSET,
    amount: "1000",
    payTo: PAY_TO,
    maxTimeoutSeconds: 120,
    extra: { name: "USD Coin", version: "2", future: { retained: true } },
  };
  const paymentPayload = {
    x402Version: 2,
    resource: { url: httpResource, description: "paid report" },
    accepted: paymentRequirements,
    payload: {
      authorization: {
        from: PAYER,
        to: PAY_TO,
        value: "1000",
        validAfter: "0",
        validBefore: "4102444800",
        nonce: `0x${"44".repeat(32)}`,
      },
      signature: `0x${"55".repeat(65)}`,
    },
    extensions: { signed: { retained: true } },
  };
  const core = {
    intentVersion: "2" as const,
    settlementKey: x402PaywallSettlementKey({ jobId, phaseIndex: PHASE_INDEX }),
    jobId,
    phaseIndex: PHASE_INDEX,
    httpResource,
    payer: PAYER,
    paymentHeader: Buffer.from(JSON.stringify(paymentPayload), "utf8").toString("base64"),
    paymentPayload,
    paymentRequirements,
    sessionAuthorization: {
      scopeVersion: "test-1",
      agreementHash: "a".repeat(64),
      permit: { id: "permit-private", generation: 7 },
    },
    declaredExtensions: { future: { exact: "cafe\u0301" } },
  };
  return {
    ...core,
    bindingHash: sha256Hex(canonicalize(core)),
  };
}

function settledOutcome(transaction = `0x${"66".repeat(32)}`):
X402PaywallSettlementOutcome {
  return {
    status: "settled",
    settlement: {
      success: true,
      transaction,
      network: NETWORK,
      payer: PAYER,
      amount: "1000",
      headers: {
        "PAYMENT-RESPONSE": Buffer.from("settled", "utf8").toString("base64"),
      },
      requirements: {
        scheme: "exact",
        network: NETWORK,
        asset: ASSET,
        amount: "1000",
        payTo: PAY_TO,
        maxTimeoutSeconds: 120,
        extra: {},
      },
      extensions: { facilitator: { evidence: true } },
    },
  };
}

function failedOutcome(reason = "authorization-cancelled"):
X402PaywallSettlementOutcome {
  return { status: "failed", reason };
}

function recordFile(directory: string, settlementKey: string): string {
  return join(directory, "records", `${sha256Hex(settlementKey)}.json`);
}

function lockDirectory(directory: string, settlementKey: string): string {
  return join(directory, "locks", `${sha256Hex(settlementKey)}.lock`);
}

describe("filesystem x402 paywall settlement store", () => {
  test("is exported from the public root and rails entrypoints", () => {
    expect(createRootFsStore).toBe(createFsX402PaywallSettlementStore);
    expect(createRailsFsStore).toBe(createFsX402PaywallSettlementStore);
  });

  test("retains an exact owned intent and survives a cold restart", async () => {
    const directory = await temporaryStoreDirectory();
    const store = await createFsX402PaywallSettlementStore({ dir: directory });
    const intent = intentFor();
    const expected = structuredClone(intent);

    expect(await store.load(intent.settlementKey)).toEqual({ status: "absent" });
    expect(await store.claim(intent)).toEqual({ status: "claimed", intent: expected });

    intent.paymentHeader = "mutated-after-claim";
    (intent.sessionAuthorization as { permit: { id: string } }).permit.id = "mutated";
    const reopened = await createFsX402PaywallSettlementStore({ dir: directory });
    expect(await reopened.load(expected.settlementKey)).toEqual({
      status: "held",
      intent: expected,
    });
    expect(await reopened.claim(expected)).toEqual({
      status: "held",
      intent: expected,
    });
  });

  test("publishes one first claim across independent store instances", async () => {
    const directory = await temporaryStoreDirectory();
    const stores = await Promise.all(Array.from(
      { length: 16 },
      () => createFsX402PaywallSettlementStore({ dir: directory }),
    ));
    const intent = intentFor();
    const claims = await Promise.all(stores.map((store) => store.claim(intent)));
    expect(claims.filter((claim) => claim.status === "claimed")).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === "held")).toHaveLength(15);
    expect(claims.every((claim) => claim.status === "claimed" || claim.status === "held"))
      .toBe(true);
  });

  test("never replaces a retained authorization with another valid binding", async () => {
    const directory = await temporaryStoreDirectory();
    const stores = await Promise.all([
      createFsX402PaywallSettlementStore({ dir: directory }),
      createFsX402PaywallSettlementStore({ dir: directory }),
    ]);
    const first = intentFor("https://seller.example/deliver/first");
    const second = intentFor("https://seller.example/deliver/second");
    const claims = await Promise.all([stores[0]!.claim(first), stores[1]!.claim(second)]);
    expect(claims.filter((claim) => claim.status === "claimed")).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === "conflict")).toHaveLength(1);
    const retained = await stores[0]!.load(first.settlementKey);
    expect(retained.status).toBe("held");
    if (retained.status === "held") {
      expect([first.bindingHash, second.bindingHash]).toContain(retained.intent.bindingHash);
    }
  });

  test("makes terminal outcomes immutable under concurrent writers", async () => {
    const directory = await temporaryStoreDirectory();
    const firstStore = await createFsX402PaywallSettlementStore({ dir: directory });
    const secondStore = await createFsX402PaywallSettlementStore({ dir: directory });
    const intent = intentFor();
    await firstStore.claim(intent);
    const writes = await Promise.all([
      firstStore.recordOutcome({
        settlementKey: intent.settlementKey,
        bindingHash: intent.bindingHash,
        outcome: settledOutcome(),
      }),
      secondStore.recordOutcome({
        settlementKey: intent.settlementKey,
        bindingHash: intent.bindingHash,
        outcome: failedOutcome(),
      }),
    ]);
    expect(writes.filter((write) => write.status === "conflict")).toHaveLength(1);
    expect(writes.filter((write) => write.status === "settled" || write.status === "failed"))
      .toHaveLength(1);

    const terminal = await firstStore.load(intent.settlementKey);
    expect(terminal.status === "settled" || terminal.status === "failed").toBe(true);
    const opposite = terminal.status === "settled" ? failedOutcome() : settledOutcome();
    expect(await firstStore.recordOutcome({
      settlementKey: intent.settlementKey,
      bindingHash: intent.bindingHash,
      outcome: opposite,
    })).toEqual({ status: "conflict" });
  });

  test("replays a durable terminal after the writer's response is lost", async () => {
    const directory = await temporaryStoreDirectory();
    const store = await createFsX402PaywallSettlementStore({ dir: directory });
    const intent = intentFor();
    const outcome = settledOutcome();
    await store.claim(intent);
    await store.recordOutcome({
      settlementKey: intent.settlementKey,
      bindingHash: intent.bindingHash,
      outcome,
    });

    // Model transport/process response loss: discard the first store instance.
    const restarted = await createFsX402PaywallSettlementStore({ dir: directory });
    const expected = { status: "settled" as const, intent, outcome };
    expect(await restarted.load(intent.settlementKey)).toEqual(expected);
    expect(await restarted.claim(intent)).toEqual(expected);
    expect(await restarted.recordOutcome({
      settlementKey: intent.settlementKey,
      bindingHash: intent.bindingHash,
      outcome,
    })).toEqual(expected);
    expect((await readdir(join(directory, "records"))).some((name) => name.endsWith(".tmp")))
      .toBe(false);
  });

  test("fails closed on corrupt, unsupported, mismatched and symlinked records", async () => {
    const cases: Array<{ name: string; content?: string; setup?: (path: string) => Promise<void> }> = [
      { name: "invalid JSON", content: "{" },
      { name: "missing version", content: JSON.stringify({ intent: intentFor() }) },
      { name: "unsupported version", content: JSON.stringify({ storeVersion: 2 }) },
      {
        name: "path/key mismatch",
        content: JSON.stringify({
          storeVersion: X402_PAYWALL_SETTLEMENT_STORE_VERSION,
          intent: intentFor("https://seller.example/different-binding", "other-job"),
        }),
      },
    ];
    for (const candidate of cases) {
      const directory = await temporaryStoreDirectory();
      const store = await createFsX402PaywallSettlementStore({ dir: directory });
      const intent = intentFor();
      await writeFile(recordFile(directory, intent.settlementKey), candidate.content!, "utf8");
      await expect(store.load(intent.settlementKey), candidate.name).rejects.toThrow(
        /corrupt|unsupported/,
      );
      await expect(store.claim(intent), candidate.name).rejects.toThrow(/corrupt|unsupported/);
    }

    const directory = await temporaryStoreDirectory();
    const store = await createFsX402PaywallSettlementStore({ dir: directory });
    const intent = intentFor();
    const outside = join(directory, "outside.json");
    await writeFile(outside, JSON.stringify({
      storeVersion: X402_PAYWALL_SETTLEMENT_STORE_VERSION,
      intent,
    }), "utf8");
    await symlink(outside, recordFile(directory, intent.settlementKey));
    await expect(store.load(intent.settlementKey)).rejects.toThrow(/unsafe/);
  });

  test("rejects non-canonical inputs without invoking accessors", async () => {
    const directory = await temporaryStoreDirectory();
    const store = await createFsX402PaywallSettlementStore({ dir: directory });
    const intent = intentFor() as unknown as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(intent, "paymentHeader", {
      enumerable: true,
      get() {
        reads += 1;
        return "secret";
      },
    });
    await expect(store.claim(intent as unknown as X402PaywallSettlementIntent)).rejects.toThrow(
      /data properties/,
    );
    expect(reads).toBe(0);

    const nested = intentFor();
    (nested.sessionAuthorization as Record<string, unknown>).optional = undefined;
    await expect(store.claim(nested)).rejects.toThrow(/undefined/);
    const proxied = intentFor();
    proxied.sessionAuthorization = new Proxy({ secret: "never-read" }, {});
    await expect(store.claim(proxied)).rejects.toThrow(/proxies/);
  });

  test("uses restrictive modes, hashed filenames and reclaims an abandoned stale lock", async () => {
    const directory = await temporaryStoreDirectory();
    const store = await createFsX402PaywallSettlementStore({
      dir: directory,
      lockStaleMs: 1,
      lockTimeoutMs: 1_000,
      lockPollMs: 1,
    });
    const intent = intentFor();
    const staleLock = lockDirectory(directory, intent.settlementKey);
    await mkdir(staleLock, { mode: 0o700 });
    await writeFile(join(staleLock, "owner.json"), "not-json", { mode: 0o600 });
    const old = new Date(Date.now() - 10_000);
    await utimes(staleLock, old, old);

    expect((await store.claim(intent)).status).toBe("claimed");
    const files = await readdir(join(directory, "records"));
    expect(files).toEqual([`${sha256Hex(intent.settlementKey)}.json`]);
    expect(files[0]).not.toContain(intent.settlementKey);
    expect((await stat(join(directory, "records"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, "locks"))).mode & 0o777).toBe(0o700);
    expect((await stat(recordFile(directory, intent.settlementKey))).mode & 0o777).toBe(0o600);

    const parsed = JSON.parse(
      await readFile(recordFile(directory, intent.settlementKey), "utf8"),
    ) as { storeVersion: number };
    expect(parsed.storeVersion).toBe(X402_PAYWALL_SETTLEMENT_STORE_VERSION);
  });

  test("serializes competing stale-lock reclaimers without fencing a live successor", async () => {
    const directory = await temporaryStoreDirectory();
    const stores = await Promise.all(Array.from({ length: 8 }, () =>
      createFsX402PaywallSettlementStore({
        dir: directory,
        lockStaleMs: 1,
        lockTimeoutMs: 5_000,
        lockPollMs: 1,
      })));
    const intent = intentFor();
    const staleLock = lockDirectory(directory, intent.settlementKey);
    await mkdir(staleLock, { mode: 0o700 });
    await writeFile(join(staleLock, "owner.json"), "not-json", { mode: 0o600 });
    const old = new Date(Date.now() - 10_000);
    await utimes(staleLock, old, old);

    const results = await Promise.all(stores.map((store) => store.claim(intent)));
    expect(results.filter((result) => result.status === "claimed")).toHaveLength(1);
    expect(results.filter((result) => result.status === "held")).toHaveLength(7);
    for (const store of stores) {
      await expect(store.load(intent.settlementKey)).resolves.toMatchObject({
        status: "held",
        intent: { bindingHash: intent.bindingHash },
      });
    }
    const lockEntries = await readdir(join(directory, "locks"));
    expect(lockEntries.filter((name) =>
      name.includes(".reclaim") || name.endsWith(".stale") || name.endsWith(".released")
    )).toEqual([]);
  });

  test("recovers a dead stale-reclaimer gate before touching the settlement lock", async () => {
    const directory = await temporaryStoreDirectory();
    const store = await createFsX402PaywallSettlementStore({
      dir: directory,
      lockStaleMs: 1,
      lockTimeoutMs: 5_000,
      lockPollMs: 1,
    });
    const intent = intentFor();
    const staleLock = lockDirectory(directory, intent.settlementKey);
    await mkdir(staleLock, { mode: 0o700 });
    await writeFile(join(staleLock, "owner.json"), "not-json", { mode: 0o600 });
    const gate = join(directory, "locks", ".reclaim");
    await writeFile(gate, "not-json", { mode: 0o600 });
    const old = new Date(Date.now() - 10_000);
    await utimes(staleLock, old, old);
    await utimes(gate, old, old);

    expect((await store.claim(intent)).status).toBe("claimed");
    expect((await readdir(join(directory, "locks"))).filter((name) =>
      name.includes(".reclaim") || name.endsWith(".stale")
    )).toEqual([]);
  });

  test("rejects unsafe options without evaluating getters", async () => {
    let reads = 0;
    const options = {} as { dir: string };
    Object.defineProperty(options, "dir", {
      enumerable: true,
      get() {
        reads += 1;
        return "/tmp/never-created";
      },
    });
    await expect(createFsX402PaywallSettlementStore(options)).rejects.toThrow(/data properties/);
    expect(reads).toBe(0);
    await expect(createFsX402PaywallSettlementStore({
      dir: "valid",
      lockPollMs: 0,
    })).rejects.toThrow(/positive safe integer/);
  });
});
