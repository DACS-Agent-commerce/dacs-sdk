import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  chainStub,
  closeChainStubs,
  defaultChain,
  serviceSettings,
  testnetPolicy,
  witnessPublicKey,
} from "./helpers/walletSpendTestnetChain.js";

const run = promisify(execFile);
const PACKAGE_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));
const REPOSITORY = fileURLToPath(new URL("../../..", import.meta.url));
const cleanups: (() => Promise<void>)[] = [];

beforeAll(() => {
  // The archives are packed without lifecycle scripts, so both packages must already be built.
  expect(existsSync(join(REPOSITORY, "dist/index.js")), "build the core package first").toBe(true);
  expect(existsSync(join(PACKAGE_DIRECTORY, "dist/walletSpendTestnetServiceMain.js")), "build packages/dacs-node first")
    .toBe(true);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await closeChainStubs();
});

/** Packs one package the way the release checks do and returns the archive path. */
async function pack(directory: string, destination: string): Promise<string> {
  const { stdout } = await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination], {
    cwd: directory, maxBuffer: 64 * 1024 * 1024,
  });
  const [packed] = JSON.parse(stdout) as { filename: string }[];
  if (packed === undefined) throw new Error("npm pack produced no archive");
  return join(destination, packed.filename);
}

/** Runs a child to its end and returns its stdout; the parent's event loop keeps serving the RPC stub. */
function finished(command: string, args: readonly string[], options: Readonly<{
  cwd: string;
  env: Record<string, string | undefined>;
}>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("exit", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`exit ${code}: ${stderr}`))));
  });
}

const INSPECT_SCRIPT = `
import { createDacsRemoteWalletSpendAuthorityV2 } from "@kynesyslabs/dacs-node";
const client = await createDacsRemoteWalletSpendAuthorityV2({
  policy: JSON.parse(process.env.PROBE_POLICY),
  endpoint: process.env.PROBE_URL,
  tokenFilePath: process.env.PROBE_TOKEN_FILE,
  authorityId: "testnet-authority",
  epoch: "epoch-one",
  witnessVerificationKey: process.env.PROBE_WITNESS_KEY,
  allowInsecureLoopback: true,
});
console.log(JSON.stringify(await client.inspect()));
`;

describe("packed testnet wallet-spend authority", () => {
  it("the packed service answers inspect from an install outside the checkout", { timeout: 300_000 }, async () => {
    const scratch = await realpath(await mkdtemp(join(tmpdir(), "dacs-testnet-packed-")));
    cleanups.push(() => rm(scratch, { recursive: true, force: true }));
    expect(relative(REPOSITORY, scratch).startsWith("..")).toBe(true);
    const archives = join(scratch, "archives");
    const consumer = join(scratch, "consumer");
    await mkdir(archives);
    await mkdir(consumer);
    const tarballs = [await pack(REPOSITORY, archives), await pack(PACKAGE_DIRECTORY, archives)];
    await writeFile(join(consumer, "package.json"),
      JSON.stringify({ name: "dacs-testnet-consumer", version: "1.0.0", private: true, type: "module" }));
    await run("npm", [
      "install", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=optional", "--prefer-offline", ...tarballs,
    ], { cwd: consumer, maxBuffer: 64 * 1024 * 1024 });
    const installed = await realpath(join(consumer, "node_modules/@kynesyslabs/dacs-node"));
    expect(relative(consumer, installed).startsWith("..")).toBe(false);

    const stub = await chainStub(defaultChain());
    const settings = await serviceSettings({ rpcUrl: stub.url });
    cleanups.push(() => settings.remove());
    const service = spawn(join(consumer, "node_modules/.bin/dacs-wallet-spend-testnet-authority"), [], {
      cwd: consumer, env: { PATH: process.env.PATH, ...settings.environment }, stdio: ["ignore", "pipe", "pipe"],
    });
    cleanups.push(async () => {
      if (service.exitCode === null) service.kill("SIGKILL");
    });
    const url = await new Promise<string>((resolve, reject) => {
      let stdout = "";
      service.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
        const [line] = stdout.split("\n");
        if (stdout.includes("\n") && line !== undefined) resolve((JSON.parse(line) as { url: string }).url);
      });
      service.once("exit", (code) => reject(new Error(`service exited ${code}`)));
    });

    const status = JSON.parse(await finished(process.execPath, ["--input-type=module", "-e", INSPECT_SCRIPT], {
      cwd: consumer,
      env: {
        PATH: process.env.PATH,
        PROBE_POLICY: JSON.stringify(testnetPolicy()),
        PROBE_URL: url,
        PROBE_TOKEN_FILE: settings.tokenFile,
        PROBE_WITNESS_KEY: witnessPublicKey(),
      },
    })) as { policyId: string; activeEffects: number; assets: { balance: string }[] };
    expect(status).toMatchObject({ policyId: "testnet-buyer", activeEffects: 0 });
    expect(status.assets[0]?.balance).toBe("10000000");
  });
});
