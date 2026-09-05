import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  WalletSpendPolicyV1,
  WalletSpendReservationV1,
} from "@kynesyslabs/dacs";

import {
  createDacsWalletSpendAuthorityV1,
} from "../src/walletSpendRuntime.js";

const roots: string[] = [];
const HASH = "a".repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dacs-wallet-runtime-"));
  roots.push(root);
  const dataDirectory = join(root, "buyer");
  const keyPath = join(root, "wallet-policy.key");
  await mkdir(dataDirectory, { mode: 0o700 });
  await writeFile(keyPath, `${"12".repeat(32)}\n`, { mode: 0o600 });
  return { root, dataDirectory, keyPath };
}

function policy(): WalletSpendPolicyV1 {
  return {
    policyVersion: "1",
    policyId: "generated-buyer-pay-dem-v1",
    wallet: "1".repeat(64),
    chainId: "demos",
    maximumConcurrentEffects: 1,
    maximumRetainedReservations: 10,
    assets: [{
      asset: "DEM",
      maximumPerOrderDebit: "120",
      maximumNetworkFeeDebit: "20",
      minimumReserve: "100",
      rollingWindowMs: 86_400_000,
      maximumRollingEffects: 10,
      maximumRollingDebit: "500",
      maximumCumulativeDebit: "1000",
      maximumCounterpartyDebit: "250",
    }],
  };
}

function reservation(): WalletSpendReservationV1 {
  return {
    reservationVersion: "1",
    reservationId: "pay-dem:test",
    jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D",
    phaseIndex: 2,
    phase: "pay-dem",
    agreementHash: HASH,
    settlementBindingHash: "b".repeat(64),
    railId: "demos-native:DEM",
    railDefinitionHash: "c".repeat(64),
    wallet: policy().wallet,
    chainId: "demos",
    payee: "2".repeat(64),
    finality: { model: "bft-final" },
    debits: [
      { asset: "DEM", purpose: "service", expectedAmount: "100", maximumAmount: "100" },
      { asset: "DEM", purpose: "network-fee", expectedAmount: "0", maximumAmount: "20" },
    ],
  };
}

describe("wallet spend host runtime", () => {
  it("authenticates and recovers wallet-wide accounting across a restart", async () => {
    const paths = await fixture();
    const options = {
      policy: policy(),
      dataDirectory: paths.dataDirectory,
      integrityKeyFilePath: paths.keyPath,
      readBalance: async () => "1000",
      authenticateRecovery: async () => true,
      owner: "buyer-one",
      leaseDurationMs: 100,
    } as const;
    const first = await createDacsWalletSpendAuthorityV1(options);
    const claim = await first.reserve(reservation());
    expect(claim.status).toBe("reserved");
    if (claim.status !== "reserved") throw new Error("expected wallet reservation");
    await claim.permit.beginEffect();
    await claim.permit.settle({
      disposition: "settled",
      evidenceHash: "d".repeat(64),
      debits: [
        { asset: "DEM", purpose: "service", amount: "100" },
        { asset: "DEM", purpose: "network-fee", amount: "7" },
      ],
    });

    const restarted = await createDacsWalletSpendAuthorityV1({
      ...options,
      owner: "buyer-two",
    });
    const status = await restarted.inspect();
    expect(status).toMatchObject({
      policyId: "generated-buyer-pay-dem-v1",
      retainedReservations: 1,
      activeEffects: 0,
      operatorActionReservations: [],
      assets: [{
        asset: "DEM",
        cumulativeSettledDebit: "107",
        availableHeadroom: "393",
      }],
    });
    expect((await restarted.reserve(reservation())).status).toBe("settled");
  });

  it("rejects state outside the private actor directory and unsafe secrets", async () => {
    const paths = await fixture();
    await expect(createDacsWalletSpendAuthorityV1({
      policy: policy(),
      dataDirectory: paths.dataDirectory,
      stateDirectory: join(paths.root, "outside"),
      integrityKeyFilePath: paths.keyPath,
      readBalance: async () => "1000",
      authenticateRecovery: async () => true,
    })).rejects.toMatchObject({ reasonCode: "wallet-spend-state-outside-data-directory" });

    if (process.platform !== "win32") {
      await chmod(paths.keyPath, 0o644);
      await expect(createDacsWalletSpendAuthorityV1({
        policy: policy(),
        dataDirectory: paths.dataDirectory,
        integrityKeyFilePath: paths.keyPath,
        readBalance: async () => "1000",
        authenticateRecovery: async () => true,
      })).rejects.toMatchObject({ reasonCode: "secret-file-permissions-unsafe" });
    }
  });

  it("rejects accessor options and symlinked data directories", async () => {
    const paths = await fixture();
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.assign(accessor, {
      policy: policy(),
      integrityKeyFilePath: paths.keyPath,
      readBalance: async () => "1000",
      authenticateRecovery: async () => true,
    });
    Object.defineProperty(accessor, "dataDirectory", {
      enumerable: true,
      get: () => paths.dataDirectory,
    });
    await expect(createDacsWalletSpendAuthorityV1(accessor as never))
      .rejects.toThrow(/closed data object/);

    const linked = join(paths.root, "linked-buyer");
    await symlink(paths.dataDirectory, linked);
    await expect(createDacsWalletSpendAuthorityV1({
      policy: policy(),
      dataDirectory: linked,
      integrityKeyFilePath: paths.keyPath,
      readBalance: async () => "1000",
      authenticateRecovery: async () => true,
    })).rejects.toMatchObject({ reasonCode: "wallet-spend-data-directory-unsafe" });
  });

  it("owns and freezes the complete policy before asynchronous initialization", async () => {
    const paths = await fixture();
    const input = policy();
    const original = structuredClone(input);
    const opening = createDacsWalletSpendAuthorityV1({
      policy: input,
      dataDirectory: paths.dataDirectory,
      integrityKeyFilePath: paths.keyPath,
      readBalance: async () => "1000",
      authenticateRecovery: async () => true,
    });

    input.wallet = "9".repeat(64);
    input.chainId = "mutated-chain";
    input.maximumConcurrentEffects = 9;
    input.maximumRetainedReservations = 99;
    input.assets[0]!.asset = "MUTATED";
    input.assets[0]!.maximumPerOrderDebit = "999";
    (input.assets as Array<WalletSpendPolicyV1["assets"][number]>).push({
      ...input.assets[0]!, asset: "SECOND",
    });

    const authority = await opening;
    expect(authority.policy).toEqual(original);
    expect(Object.isFrozen(authority.policy)).toBe(true);
    expect(Object.isFrozen(authority.policy.assets)).toBe(true);
    expect(Object.isFrozen(authority.policy.assets[0])).toBe(true);
  });

  it("rejects nested accessors and proxies without invoking caller code", async () => {
    const paths = await fixture();
    const accessed = vi.fn(() => "DEM");
    const accessorPolicy = policy();
    Object.defineProperty(accessorPolicy.assets[0], "asset", {
      enumerable: true,
      get: accessed,
    });
    await expect(createDacsWalletSpendAuthorityV1({
      policy: accessorPolicy,
      dataDirectory: paths.dataDirectory,
      integrityKeyFilePath: paths.keyPath,
      readBalance: async () => "1000",
      authenticateRecovery: async () => true,
    })).rejects.toThrow(/stable canonical data/);
    expect(accessed).not.toHaveBeenCalled();

    const trapped = vi.fn();
    const proxyPolicy = policy();
    (proxyPolicy.assets as Array<WalletSpendPolicyV1["assets"][number]>)[0] =
      new Proxy(proxyPolicy.assets[0]!, {
        get(target, key, receiver) {
          trapped();
          return Reflect.get(target, key, receiver);
        },
      });
    await expect(createDacsWalletSpendAuthorityV1({
      policy: proxyPolicy,
      dataDirectory: paths.dataDirectory,
      integrityKeyFilePath: paths.keyPath,
      readBalance: async () => "1000",
      authenticateRecovery: async () => true,
    })).rejects.toThrow(/stable canonical data/);
    expect(trapped).not.toHaveBeenCalled();
  });
});
