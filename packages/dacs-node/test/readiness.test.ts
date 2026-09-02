import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";
import {
  ed25519Sign,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
} from "@kynesyslabs/dacs/crypto";
import { demosAgentClaimRef } from "@kynesyslabs/dacs/identity";
import { afterEach, describe, expect, it } from "vitest";

import {
  DACS_NODE_LIVE_PROFILE,
  createDacsRoleReadinessLatchV1,
} from "../src/index.js";

const SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const OTHER_SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 33);
const KEY = privateKeyFromSeed(SEED);
const OTHER_KEY = privateKeyFromSeed(OTHER_SEED);
const AUTHORITY = demosAgentClaimRef(rawPublicKey(publicKeyFromSeed(SEED)));
const REPORT_HASH = sha256Hex("post-start-report");

describe("authenticated role readiness latch", () => {
  const roots: string[] = [];

  function root(): string {
    const directory = mkdtempSync(join(tmpdir(), "dacs-readiness-"));
    roots.push(directory);
    chmodSync(directory, 0o700);
    return directory;
  }

  function config(directory: string, overrides: Record<string, unknown> = {}) {
    return {
      mode: "live-demos" as const,
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer" as const,
      dataDirectory: directory,
      demos: { rpcUrl: "http://127.0.0.1:5350" },
      rail: {
        registryIndexRef: "dacs4:registry:v0.1",
        requestedNetwork: "eip155:84532",
      },
      limits: {
        maxServiceAmount: { asset: "USDC", amount: "1" },
        maxSetupSpendDem: "10",
        maxDemosNetworkFeeDem: "2",
        maxEvmNetworkFeeEth: "0.001",
      },
      ...overrides,
    };
  }

  afterEach(() => {
    for (const directory of roots.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("atomically commits and verifies a role/config-bound signed latch", async () => {
    const directory = root();
    let now = 1_780_000_000_000;
    const latch = createDacsRoleReadinessLatchV1({
      config: config(directory),
      authority: AUTHORITY,
      ttlMs: 60_000,
      now: () => now,
    });

    await expect(latch.readiness()).resolves.toMatchObject({
      ready: false,
      reasonCodes: ["readiness-latch-missing"],
    });
    await expect(latch.commit(
      REPORT_HASH,
      (bytes) => ed25519Sign(bytes, KEY),
    )).resolves.toEqual({ ready: true, checkedAt: now, reasonCodes: [] });
    expect(latch.filePath).toBe(join(directory, "readiness-latch.v1.json"));

    now += 5_000;
    await expect(latch.readiness()).resolves.toEqual({
      ready: true,
      checkedAt: now,
      reasonCodes: [],
    });
    await latch.revoke();
    await expect(latch.readiness()).resolves.toMatchObject({
      ready: false,
      reasonCodes: ["readiness-latch-missing"],
    });
  });

  it("expires at the exact freshness boundary", async () => {
    const directory = root();
    let now = 10_000;
    const latch = createDacsRoleReadinessLatchV1({
      config: config(directory),
      authority: AUTHORITY,
      ttlMs: 1_000,
      now: () => now,
    });
    await latch.commit(REPORT_HASH, (bytes) => ed25519Sign(bytes, KEY));
    now = 11_000;
    await expect(latch.readiness()).resolves.toMatchObject({
      ready: false,
      checkedAt: 11_000,
      reasonCodes: ["readiness-latch-expired"],
    });
  });

  it("rejects payload tampering and a forged signature", async () => {
    const directory = root();
    const latch = createDacsRoleReadinessLatchV1({
      config: config(directory),
      authority: AUTHORITY,
      now: () => 20_000,
    });
    await latch.commit(REPORT_HASH, (bytes) => ed25519Sign(bytes, KEY));
    const record = JSON.parse(readFileSync(latch.filePath, "utf8")) as {
      payload: Record<string, unknown>;
      signature: string;
    };
    record.payload.prerequisiteReportHash = sha256Hex("different-report");
    writeFileSync(latch.filePath, canonicalize(record), { mode: 0o600 });
    await expect(latch.readiness()).resolves.toMatchObject({
      ready: false,
      reasonCodes: ["readiness-latch-signature-invalid"],
    });

    await expect(latch.commit(
      REPORT_HASH,
      (bytes) => ed25519Sign(bytes, OTHER_KEY),
    )).rejects.toMatchObject({ reasonCode: "readiness-latch-signature-invalid" });
    await expect(latch.readiness()).resolves.toMatchObject({
      ready: false,
      reasonCodes: ["readiness-latch-signature-invalid"],
    });
  });

  it("rejects a copied latch after configuration drift", async () => {
    const directory = root();
    const initial = createDacsRoleReadinessLatchV1({
      config: config(directory),
      authority: AUTHORITY,
      now: () => 30_000,
    });
    await initial.commit(REPORT_HASH, (bytes) => ed25519Sign(bytes, KEY));
    const changed = createDacsRoleReadinessLatchV1({
      config: config(directory, {
        rail: {
          registryIndexRef: "dacs4:registry:v0.2",
          requestedNetwork: "eip155:84532",
        },
      }),
      authority: AUTHORITY,
      now: () => 30_001,
    });
    await expect(changed.readiness()).resolves.toMatchObject({
      ready: false,
      reasonCodes: ["readiness-latch-binding-mismatch"],
    });
  });

  it("fails closed when an existing latch has unsafe permissions", async () => {
    if (process.platform === "win32") return;
    const directory = root();
    const latch = createDacsRoleReadinessLatchV1({
      config: config(directory),
      authority: AUTHORITY,
      now: () => 40_000,
    });
    await latch.commit(REPORT_HASH, (bytes) => ed25519Sign(bytes, KEY));
    chmodSync(latch.filePath, 0o644);
    await expect(latch.readiness()).resolves.toMatchObject({
      ready: false,
      reasonCodes: ["readiness-latch-unsafe"],
    });
    await expect(latch.commit(
      REPORT_HASH,
      (bytes) => ed25519Sign(bytes, KEY),
    )).rejects.toMatchObject({ reasonCode: "readiness-latch-unsafe" });
  });
});
