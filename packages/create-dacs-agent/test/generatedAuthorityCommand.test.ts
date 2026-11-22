import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import {
  TESTNET_AUTHORITY_ID,
  TESTNET_EPOCH,
  TESTNET_SEED_HEX,
  TESTNET_TOKEN,
  freePort,
  generatedProject,
  policyFileText,
  portRefused,
  startChainStub,
  testnetPolicy,
  writeModeFile,
  type ChainStub,
} from "./helpers/testnetAuthorityFixtures.js";

const NODE_PACKAGE = new URL("../../dacs-node/", import.meta.url);
const POLICY_WALLET = `0x${"5e".repeat(20)}`;
const POLICY_ASSET = `0x${"03".repeat(20)}`;
const PORT_CLOSE_DEADLINE_MS = 10_000;
/** Generating the project takes longer than the default hook timeout on a loaded machine. */
const SETUP_TIMEOUT_MS = 60_000;

interface Run {
  child: ChildProcess;
  exited: Promise<number | null>;
  stdout(): string;
  stderr(): string;
}

let root: string;
let project: string;
let stub: ChainStub;
let port: number;
let settings: Record<string, string>;
let generatedScripts: Record<string, string>;
const children: ChildProcess[] = [];

beforeAll(async () => {
  expect(
    existsSync(fileURLToPath(new URL("dist/walletSpendTestnetServiceMain.js", NODE_PACKAGE))),
    "build the core package and packages/dacs-node before running this file",
  ).toBe(true);
  ({ root, project } = await generatedProject("x402"));
  generatedScripts = (JSON.parse(await readFile(join(project, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }).scripts;
  stub = await startChainStub(5_000_000n);
  port = await freePort();
  const secrets = join(root, "secrets");
  await mkdir(secrets, { mode: 0o700 });
  await writeModeFile(join(secrets, "authority-token"), TESTNET_TOKEN);
  await writeModeFile(join(secrets, "witness-seed"), TESTNET_SEED_HEX);
  await writeModeFile(join(root, "policy.json"), policyFileText(testnetPolicy(POLICY_WALLET, POLICY_ASSET)));
  const identity = (byte: string) => `did:demos:agent:${byte.repeat(32)}`;
  for (const name of ["buyer-demos", "seller-demos", "buyer-evm", "seller-evm"]) {
    await writeModeFile(join(secrets, name), `${name}-fixture`);
  }
  settings = {
    DACS_DEPLOYMENT: "local",
    DACS_BUYER_PUBLIC_BASE_URL: "https://buyer.example.test",
    DACS_SELLER_PUBLIC_BASE_URL: "https://seller.example.test",
    DACS_WALLET_AUTHORITY_URL: `http://127.0.0.1:${port}/`,
    DACS_BUYER_WALLET_AUTHORITY_TOKEN_FILE: join(secrets, "authority-token"),
    DACS_WALLET_AUTHORITY_ID: TESTNET_AUTHORITY_ID,
    DACS_WALLET_AUTHORITY_EPOCH: TESTNET_EPOCH,
    DACS_WALLET_AUTHORITY_WITNESS_SEED_FILE: join(secrets, "witness-seed"),
    DACS_WALLET_AUTHORITY_DATA_DIRECTORY: join(root, "authority-data"),
    DACS_WALLET_AUTHORITY_POLICY_FILE: join(root, "policy.json"),
    DACS_WALLET_AUTHORITY_ALLOW_INSECURE_LOOPBACK: "1",
    DACS_EVM_RPC_URL: stub.url,
    DACS_X402_AUTHORIZATION_SEARCH_FROM_BLOCK: "0",
    DACS_BUYER_AUTHORITY: identity("b1"),
    DACS_SELLER_AUTHORITY: identity("c2"),
    DACS_RAIL_STEWARD_AUTHORITY: identity("d3"),
    DACS_BUYER_DEMOS_SECRET_FILE: join(secrets, "buyer-demos"),
    DACS_SELLER_DEMOS_SECRET_FILE: join(secrets, "seller-demos"),
    DACS_BUYER_EVM_SECRET_FILE: join(secrets, "buyer-evm"),
    DACS_SELLER_EVM_SECRET_FILE: join(secrets, "seller-evm"),
  };
}, SETUP_TIMEOUT_MS);

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      process.kill(-child.pid, "SIGKILL");
    }
  }
});

afterAll(async () => {
  await stub?.close();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

/** Writes the project's `.env` from the settings and the overrides; an undefined override leaves the setting out. */
async function writeEnvironment(overrides: Readonly<Record<string, string | undefined>> = {}): Promise<void> {
  const lines = Object.entries({ ...settings, ...overrides })
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `${name}=${value}`);
  await writeFile(join(project, ".env"), lines.join("\n") + "\n");
}

/** Runs `npm run <script> [-- args]` in the project. */
function npmRun(script: string, args: readonly string[] = []): Run {
  return runInProject("npm", ["run", script, ...(args.length === 0 ? [] : ["--", ...args])]);
}

/** Runs the command a generated script runs after its build step, with this Node. */
function runBuiltScript(script: string): Run {
  const command = generatedScripts[script]?.split(" && ").at(-1)?.split(" ");
  if (command?.[0] !== "node") throw new Error(`${script} does not end in a node command`);
  return runInProject(process.execPath, command.slice(1));
}

function stopGroup(run: Run): void {
  if (run.child.pid === undefined) throw new Error("the process did not start");
  process.kill(-run.child.pid, "SIGTERM");
}

/** Starts a process in the project, in its own process group, with no DACS setting inherited. */
function runInProject(executable: string, args: readonly string[]): Run {
  const child = spawn(executable, args, {
    cwd: project,
    detached: true,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, exited, stdout: () => stdout, stderr: () => stderr };
}

/** The first output line that is a JSON object, once it is complete, or the exit code if the run ends first. */
function firstJsonLine(run: Run): Promise<Record<string, unknown> | number | null> {
  return new Promise((resolve) => {
    const check = () => {
      const line = run.stdout().split("\n").slice(0, -1).find((candidate) => candidate.startsWith("{"));
      if (line !== undefined) resolve(JSON.parse(line) as Record<string, unknown>);
    };
    run.child.stdout?.on("data", check);
    void run.exited.then(resolve);
  });
}

function lastLine(text: string): string | undefined {
  return text.trim().split("\n").at(-1);
}

async function portClosesWithin(deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await portRefused(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return portRefused(port);
}

describe("generated authority command line", { timeout: 180_000 }, () => {
  test("the generated authority command prints the witness key, starts and stops the service", async () => {
    const { dacsWalletSpendTestnetWitnessPublicKeyV1 } = await import(
      fileURLToPath(new URL("src/walletSpendTestnetSettings.ts", NODE_PACKAGE))
    ) as { dacsWalletSpendTestnetWitnessPublicKeyV1(seedFile: string): Promise<string> };
    const expectedKey = await dacsWalletSpendTestnetWitnessPublicKeyV1(join(root, "secrets", "witness-seed"));
    await writeEnvironment();

    const printed = npmRun("dacs:authority", ["--print-witness-public-key"]);
    expect(await printed.exited, printed.stderr()).toBe(0);
    expect(lastLine(printed.stdout())).toBe(expectedKey);
    expect(existsSync(join(root, "authority-data"))).toBe(false);

    const withKey = { DACS_WALLET_AUTHORITY_WITNESS_PUBLIC_KEY: expectedKey };
    await writeEnvironment(withKey);
    const service = npmRun("dacs:authority");
    const listening = await firstJsonLine(service);
    expect(listening, service.stderr()).toMatchObject({
      status: "listening",
      url: settings.DACS_WALLET_AUTHORITY_URL,
      authorityId: TESTNET_AUTHORITY_ID,
      epoch: TESTNET_EPOCH,
      witnessVerificationKey: expectedKey,
    });
    expect(await portRefused(port)).toBe(false);
    stopGroup(service);
    await service.exited;
    expect(await portClosesWithin(PORT_CLOSE_DEADLINE_MS)).toBe(true);

    // npm and its shell end by the signal itself, so the command line's own
    // exit code is read from the script's command run without them.
    const direct = runBuiltScript("dacs:authority");
    expect(await firstJsonLine(direct), direct.stderr()).toMatchObject({ status: "listening" });
    stopGroup(direct);
    expect(await direct.exited, direct.stderr()).toBe(0);
    expect(await portClosesWithin(PORT_CLOSE_DEADLINE_MS)).toBe(true);

    await writeEnvironment({ ...withKey, DACS_WALLET_AUTHORITY_POLICY_FILE: undefined });
    const refused = npmRun("dacs:authority");
    expect(await refused.exited).toBe(1);
    expect(refused.stderr()).toContain(JSON.stringify({
      status: "refused",
      reasonCode: "wallet-spend-testnet-authority-setting-missing",
      setting: "DACS_WALLET_AUTHORITY_POLICY_FILE",
    }));
    expect(await portRefused(port)).toBe(true);

    await writeEnvironment(withKey);
    const misused = npmRun("dacs:authority", ["--other"]);
    expect(await misused.exited).toBe(2);
    expect(misused.stderr()).toContain("usage: npm run dacs:authority [-- --print-witness-public-key]");
    expect(await portRefused(port)).toBe(true);
  });

  test("the generated authority-policy command compiles and reaches the doctor's actors", async () => {
    const build = npmRun("build");
    expect(await build.exited, build.stdout() + build.stderr()).toBe(0);

    await writeEnvironment({ DACS_WALLET_AUTHORITY_POLICY_FILE: undefined });
    const missing = npmRun("dacs:authority:policy");
    expect(await missing.exited).toBe(1);
    expect(missing.stderr()).toContain(
      JSON.stringify({ status: "refused", reasonCode: "authority-policy-file-setting-missing" }),
    );

    const target = join(root, "written", "policy.json");
    await mkdir(dirname(target));
    const buyerIdentity = join(root, "secrets", "buyer-demos-open");
    await writeModeFile(buyerIdentity, "buyer-demos-fixture", 0o644);
    await writeEnvironment({
      DACS_WALLET_AUTHORITY_POLICY_FILE: target,
      DACS_BUYER_DEMOS_SECRET_FILE: buyerIdentity,
    });
    const unavailable = npmRun("dacs:authority:policy");
    expect(await unavailable.exited, unavailable.stderr()).toBe(1);
    expect(unavailable.stderr()).toContain(
      JSON.stringify({ status: "refused", reasonCode: "authority-policy-actor-unavailable" }),
    );
    expect(await readdir(dirname(target))).toEqual([]);
  });
});
