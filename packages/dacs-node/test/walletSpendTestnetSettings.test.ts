import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type WalletSpendPolicyV1 } from "@kynesyslabs/dacs";

import { createDacsRemoteWalletSpendAuthorityV2 } from "../src/walletSpendRemote.js";
import {
  createDacsWalletSpendContinuitySignerV1,
  dacsWalletSpendPolicyHashV1,
} from "../src/walletSpendPostgres.js";
import {
  DACS_WALLET_SPEND_TESTNET_AUTHORITY_SETTING_NAMES,
  DACS_WALLET_SPEND_TESTNET_CHAIN_ID,
  DacsWalletSpendTestnetAuthorityError,
  dacsWalletSpendTestnetWitnessPublicKeyV1,
  loadDacsWalletSpendTestnetAuthoritySettingsV1,
} from "../src/walletSpendTestnetSettings.js";

const WALLET = `0x${"5e".repeat(20)}`;
const ASSET = `0x${"03".repeat(20)}`;
const BEARER = "buyer-side-bearer-".padEnd(48, "q");
const SEED = Buffer.alloc(32, 7);
const OTHER_SEED = Buffer.alloc(32, 9);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const policy = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  policyVersion: "1",
  policyId: "testnet-buyer",
  wallet: WALLET.toUpperCase().replace("0X", "0x"),
  chainId: DACS_WALLET_SPEND_TESTNET_CHAIN_ID,
  maximumConcurrentEffects: 1,
  maximumRetainedReservations: 100,
  assets: [{
    asset: ASSET,
    maximumPerOrderDebit: "5000000",
    maximumNetworkFeeDebit: "0",
    minimumReserve: "0",
    rollingWindowMs: 86_400_000,
    maximumRollingEffects: 10,
    maximumRollingDebit: "10000000",
    maximumCumulativeDebit: "100000000",
    maximumCounterpartyDebit: "25000000",
  }],
  ...overrides,
});

function publicKey(seed: Uint8Array): string {
  return createDacsWalletSpendContinuitySignerV1({ seed }).verificationKey;
}

async function privateFile(path: string, content: string, mode = 0o600): Promise<string> {
  await writeFile(path, content, { mode });
  await chmod(path, mode);
  return path;
}

/** A directory holding the two secrets and the policy, and a complete valid environment. */
async function fixture(): Promise<{ root: string; environment: Record<string, string | undefined> }> {
  const root = await mkdtemp(join(tmpdir(), "dacs-testnet-settings-"));
  roots.push(root);
  const environment: Record<string, string | undefined> = {
    DACS_WALLET_AUTHORITY_URL: "http://127.0.0.1:3199",
    DACS_BUYER_WALLET_AUTHORITY_TOKEN_FILE: await privateFile(join(root, "token"), `${BEARER}\n`),
    DACS_WALLET_AUTHORITY_ID: "testnet-authority",
    DACS_WALLET_AUTHORITY_EPOCH: "epoch-one",
    DACS_WALLET_AUTHORITY_WITNESS_PUBLIC_KEY: publicKey(SEED),
    DACS_WALLET_AUTHORITY_WITNESS_SEED_FILE:
      await privateFile(join(root, "seed"), `${SEED.toString("hex")}\n`),
    DACS_WALLET_AUTHORITY_DATA_DIRECTORY: join(root, "data"),
    DACS_WALLET_AUTHORITY_POLICY_FILE:
      await privateFile(join(root, "policy.json"), JSON.stringify(policy()), 0o644),
    DACS_EVM_RPC_URL: "https://sepolia.base.example/rpc",
    DACS_X402_AUTHORIZATION_SEARCH_FROM_BLOCK: "12345678",
  };
  return { root, environment };
}

async function refusal(
  environment: Record<string, string | undefined>,
): Promise<DacsWalletSpendTestnetAuthorityError> {
  const error: unknown = await loadDacsWalletSpendTestnetAuthoritySettingsV1(environment)
    .then(() => undefined, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(DacsWalletSpendTestnetAuthorityError);
  return error as DacsWalletSpendTestnetAuthorityError;
}

function errorText(error: Error): string {
  const cause = error.cause instanceof Error ? `${error.cause.name} ${error.cause.message}` : "";
  return `${String(error)} ${error.stack ?? ""} ${cause} ${JSON.stringify(error)}`;
}

describe("testnet wallet-spend authority settings", () => {
  it("loads a complete environment without exposing a secret", async () => {
    const { root, environment } = await fixture();
    const loaded = await loadDacsWalletSpendTestnetAuthoritySettingsV1(environment);

    expect(loaded.settings).toEqual({
      listen: { hostname: "127.0.0.1", port: 3199 },
      authorityId: "testnet-authority",
      epoch: "epoch-one",
      witnessVerificationKey: publicKey(SEED),
      dataDirectory: join(root, "data"),
      evmRpcUrl: "https://sepolia.base.example/rpc",
      authorizationSearchFromBlock: 12_345_678,
      policy: { ...policy(), wallet: WALLET },
      policyHash: dacsWalletSpendPolicyHashV1(policy() as unknown as WalletSpendPolicyV1),
    });
    expect(Buffer.from(loaded.tokenDigest))
      .toEqual(createHash("sha256").update(BEARER).digest());
    expect(Buffer.from(loaded.witnessSeed)).toEqual(SEED);
    const visible = JSON.stringify(loaded.settings);
    expect(visible).not.toContain(BEARER);
    expect(visible).not.toContain(SEED.toString("hex"));
    expect(visible).not.toContain(SEED.toString("base64url"));
    expect(Object.isFrozen(loaded.settings)).toBe(true);
    expect(Object.isFrozen(loaded.settings.listen)).toBe(true);
    expect((await readdir(root)).sort()).toEqual(["policy.json", "seed", "token"]);
  });

  it("refuses each missing setting by name", async () => {
    const { root, environment } = await fixture();
    expect(DACS_WALLET_SPEND_TESTNET_AUTHORITY_SETTING_NAMES).toHaveLength(10);
    for (const name of DACS_WALLET_SPEND_TESTNET_AUTHORITY_SETTING_NAMES) {
      for (const value of [undefined, "   "]) {
        const error = await refusal({ ...environment, [name]: value });
        expect(error.reasonCode).toBe("wallet-spend-testnet-authority-setting-missing");
        expect(error.setting).toBe(name);
      }
    }
    const first = await refusal({
      ...environment,
      DACS_WALLET_AUTHORITY_EPOCH: undefined,
      DACS_EVM_RPC_URL: undefined,
    });
    expect(first.setting).toBe("DACS_WALLET_AUTHORITY_EPOCH");
    expect((await readdir(root)).sort()).toEqual(["policy.json", "seed", "token"]);
  });

  it("refuses a policy for any chain but Base Sepolia", async () => {
    const { root, environment } = await fixture();
    for (const chainId of ["eip155:8453", "eip155:1", "demos"]) {
      const path = await privateFile(join(root, `policy-${chainId}.json`),
        JSON.stringify(policy({ chainId })));
      const error = await refusal({ ...environment, DACS_WALLET_AUTHORITY_POLICY_FILE: path });
      expect(error.reasonCode).toBe("wallet-spend-testnet-authority-network-refused");
      expect(error.setting).toBe("DACS_WALLET_AUTHORITY_POLICY_FILE");
    }
  });

  it("accepts only a loopback http listen address with a port", async () => {
    const { environment } = await fixture();
    for (const url of [
      "https://127.0.0.1:3199",
      "http://192.0.2.1:3199",
      "http://127.0.0.1",
      "http://[::1]",
      "http://127.0.0.1:",
      "http://127.0.0.1:65536",
      "http://127.0.0.1\\:80/..",
      "http://127.0.0.1/?port=:80",
      "http://127.0.0.1/#port=:80",
      "http://127.0.0.1:3199/x",
      "http://127.0.0.1:3199/?q=1",
      "http://127.0.0.1:3199/#part",
      "http://user@127.0.0.1:3199",
      "http://localhost.example:3199",
      "not a url",
    ]) {
      const error = await refusal({ ...environment, DACS_WALLET_AUTHORITY_URL: url });
      expect(error.reasonCode, url).toBe("wallet-spend-testnet-authority-url-refused");
    }
    for (const [url, hostname] of [
      ["http://127.0.0.1:3199", "127.0.0.1"],
      ["http://[::1]:3199", "::1"],
      ["http://localhost:3199/", "localhost"],
      ["http://127.3.2.1:3199", "127.3.2.1"],
    ] as const) {
      const loaded = await loadDacsWalletSpendTestnetAuthoritySettingsV1({
        ...environment,
        DACS_WALLET_AUTHORITY_URL: url,
      });
      expect(loaded.settings.listen).toEqual({ hostname, port: 3199 });
    }
  });

  it.each([
    ["http://127.0.0.1:0", "127.0.0.1", 0],
    ["http://127.0.0.1:1", "127.0.0.1", 1],
    ["http://127.0.0.1:80", "127.0.0.1", 80],
    ["http://127.0.0.1:080", "127.0.0.1", 80],
    ["http://127.0.0.1:65535", "127.0.0.1", 65535],
    ["http://[::1]:80", "::1", 80],
    ["http://[::1]:080", "::1", 80],
    ["http://localhost:80/", "localhost", 80],
    ["http://127.3.2.1:80", "127.3.2.1", 80],
  ] as const)("loads the explicit listen port in %s", async (url, hostname, port) => {
    const { environment } = await fixture();
    const loaded = await loadDacsWalletSpendTestnetAuthoritySettingsV1({
      ...environment,
      DACS_WALLET_AUTHORITY_URL: url,
    });
    expect(loaded.settings.listen).toEqual({ hostname, port });
  });

  it("refuses unsafe or malformed secrets without echoing them", async () => {
    const { root, environment } = await fixture();
    const shortBearer = "s".repeat(31);
    const shortSeed = SEED.toString("hex").slice(0, 63);
    const cases = [
      {
        setting: "DACS_BUYER_WALLET_AUTHORITY_TOKEN_FILE",
        path: await privateFile(join(root, "token-shared"), `${BEARER}\n`, 0o644),
        reasonCode: "wallet-spend-testnet-authority-token-invalid",
        secret: BEARER,
      },
      {
        setting: "DACS_BUYER_WALLET_AUTHORITY_TOKEN_FILE",
        path: await privateFile(join(root, "token-short"), shortBearer),
        reasonCode: "wallet-spend-testnet-authority-token-invalid",
        secret: shortBearer,
      },
      {
        setting: "DACS_WALLET_AUTHORITY_WITNESS_SEED_FILE",
        path: await privateFile(join(root, "seed-short"), shortSeed),
        reasonCode: "wallet-spend-testnet-authority-witness-seed-invalid",
        secret: shortSeed,
      },
      {
        setting: "DACS_WALLET_AUTHORITY_WITNESS_SEED_FILE",
        path: await privateFile(join(root, "seed-other"), OTHER_SEED.toString("hex")),
        reasonCode: "wallet-spend-testnet-authority-witness-key-mismatch",
        secret: OTHER_SEED.toString("hex"),
      },
    ];
    for (const entry of cases) {
      const error = await refusal({ ...environment, [entry.setting]: entry.path });
      expect(error.reasonCode, entry.path).toBe(entry.reasonCode);
      expect(error.setting).toBe(entry.setting);
      const text = errorText(error);
      expect(text).not.toContain(entry.secret.slice(0, 12));
      expect(text).not.toContain(entry.secret.slice(-12));
    }
    const missing = await refusal({
      ...environment,
      DACS_BUYER_WALLET_AUTHORITY_TOKEN_FILE: join(root, "no-token"),
    });
    expect(missing.reasonCode).toBe("wallet-spend-testnet-authority-token-invalid");
    expect(missing.cause).toMatchObject({ reasonCode: "secret-not-found" });
  });

  it("refuses an unreadable or invalid policy file", async () => {
    const { root, environment } = await fixture();
    const twoAssets = policy();
    twoAssets.assets = [
      ...(twoAssets.assets as Record<string, unknown>[]),
      { ...(twoAssets.assets as Record<string, unknown>[])[0], asset: `0x${"04".repeat(20)}` },
    ];
    const oneAsset = (asset: string) => policy({
      assets: [{ ...(policy().assets as Record<string, unknown>[])[0], asset }],
    });
    const cases: readonly (readonly [string, string | undefined, string])[] = [
      ["missing", undefined, "wallet-spend-testnet-authority-policy-unreadable"],
      ["large", " ".repeat(65 * 1024) + JSON.stringify(policy()),
        "wallet-spend-testnet-authority-policy-unreadable"],
      ["not-json", "{\"policyVersion\":", "wallet-spend-testnet-authority-policy-unreadable"],
      ["two-assets", JSON.stringify(twoAssets), "wallet-spend-testnet-authority-policy-invalid"],
      ["long-wallet", JSON.stringify(policy({ wallet: `0x${"ab".repeat(32)}` })),
        "wallet-spend-testnet-authority-policy-invalid"],
      ["asset-name", JSON.stringify(oneAsset("USDC")),
        "wallet-spend-testnet-authority-policy-invalid"],
      ["asset-mixed-case", JSON.stringify(oneAsset(`0x${"Ab".repeat(20)}`)),
        "wallet-spend-testnet-authority-policy-invalid"],
      ["core-shape", JSON.stringify(policy({ maximumConcurrentEffects: 0 })),
        "wallet-spend-testnet-authority-policy-invalid"],
    ];
    for (const [name, content, reasonCode] of cases) {
      const path = join(root, `policy-${name}.json`);
      if (content !== undefined) await privateFile(path, content);
      const error = await refusal({ ...environment, DACS_WALLET_AUTHORITY_POLICY_FILE: path });
      expect(error.reasonCode, name).toBe(reasonCode);
      expect(error.setting).toBe("DACS_WALLET_AUTHORITY_POLICY_FILE");
    }
  });

  it("computes the policy hash the client computes", async () => {
    const { environment } = await fixture();
    const { settings } = await loadDacsWalletSpendTestnetAuthoritySettingsV1(environment);
    expect(settings.policyHash)
      .toBe(dacsWalletSpendPolicyHashV1(policy() as unknown as WalletSpendPolicyV1));

    const sent: unknown[] = [];
    const client = await createDacsRemoteWalletSpendAuthorityV2({
      policy: { ...policy(), wallet: WALLET } as unknown as WalletSpendPolicyV1,
      endpoint: "http://127.0.0.1:3199/",
      tokenFilePath: environment.DACS_BUYER_WALLET_AUTHORITY_TOKEN_FILE as string,
      authorityId: settings.authorityId,
      epoch: settings.epoch,
      witnessVerificationKey: settings.witnessVerificationKey,
      allowInsecureLoopback: true,
      fetch: async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)));
        throw new Error("stand-in authority does not answer");
      },
    });
    await expect(client.inspect()).rejects.toThrow();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ policyHash: settings.policyHash });
  });

  it("parses the search floor with the buyer's rule", async () => {
    const { environment } = await fixture();
    for (const value of ["-1", "1.5", "0x10", "9007199254740993", "01", " 5"]) {
      const error = await refusal({
        ...environment,
        DACS_X402_AUTHORIZATION_SEARCH_FROM_BLOCK: value,
      });
      expect(error.reasonCode, value).toBe("wallet-spend-testnet-authority-setting-invalid");
      expect(error.setting).toBe("DACS_X402_AUTHORIZATION_SEARCH_FROM_BLOCK");
    }
    for (const [value, block] of [["0", 0], ["12345678", 12_345_678]] as const) {
      const { settings } = await loadDacsWalletSpendTestnetAuthoritySettingsV1({
        ...environment,
        DACS_X402_AUTHORIZATION_SEARCH_FROM_BLOCK: value,
      });
      expect(settings.authorizationSearchFromBlock).toBe(block);
    }
  });

  it("refuses a malformed id, epoch, public key or data directory", async () => {
    const { environment } = await fixture();
    for (const [setting, value] of [
      ["DACS_WALLET_AUTHORITY_ID", " testnet-authority"],
      ["DACS_WALLET_AUTHORITY_EPOCH", "epoch-one\n"],
      ["DACS_WALLET_AUTHORITY_EPOCH", "époch"],
      ["DACS_WALLET_AUTHORITY_WITNESS_PUBLIC_KEY", "a".repeat(42)],
      ["DACS_WALLET_AUTHORITY_WITNESS_PUBLIC_KEY", `${"a".repeat(42)}=`],
      ["DACS_WALLET_AUTHORITY_DATA_DIRECTORY", "/var/data\0dir"],
    ] as const) {
      const error = await refusal({ ...environment, [setting]: value });
      expect(error.reasonCode, value).toBe("wallet-spend-testnet-authority-setting-invalid");
      expect(error.setting).toBe(setting);
    }
  });

  it("refuses an RPC address that is not https or loopback http, or that carries credentials", async () => {
    const { environment } = await fixture();
    for (const url of [
      "http://rpc.example/",
      "https://user:pass@rpc.example/",
      "ws://127.0.0.1:8545",
      "rpc.example",
    ]) {
      const error = await refusal({ ...environment, DACS_EVM_RPC_URL: url });
      expect(error.reasonCode, url).toBe("wallet-spend-testnet-authority-rpc-url-refused");
      expect(error.setting).toBe("DACS_EVM_RPC_URL");
      expect(errorText(error)).not.toContain("pass@");
    }
    const loaded = await loadDacsWalletSpendTestnetAuthoritySettingsV1({
      ...environment,
      DACS_EVM_RPC_URL: "http://127.0.0.1:8545",
    });
    expect(loaded.settings.evmRpcUrl).toBe("http://127.0.0.1:8545");
  });

  it("derives the witness public key from a seed file", async () => {
    const { environment } = await fixture();
    await expect(dacsWalletSpendTestnetWitnessPublicKeyV1(
      environment.DACS_WALLET_AUTHORITY_WITNESS_SEED_FILE as string,
    )).resolves.toBe(publicKey(SEED));
  });
});
