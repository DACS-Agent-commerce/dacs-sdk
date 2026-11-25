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

/** Where a process runs and the settings it gets beyond PATH, HOME and TMPDIR. */
interface RunOptions {
  directory?: string;
  environment?: Readonly<Record<string, string>>;
}

/** The parts of the node package's Demos node stand-in these tests use. */
interface DemosNodeHelper {
  DEMOS_NODE_URL: string;
  demosPolicy(): Parameters<typeof policyFileText>[0];
  demosNodeStub(state: unknown): Promise<Readonly<{ url: string; close(): Promise<void> }>>;
  recordedDemosState(genesisHash: string): unknown;
}

// Package names held in variables, so the typecheck does not need the packages built.
const NODE_PACKAGE_NAME: string = "@kynesyslabs/dacs-node";
const WIRE_PACKAGE: string = "@kynesyslabs/dacs/wire";
/** The x402 lane's own settings; a project without the x402 rail has none of them. */
const X402_LANE_SETTINGS = Object.freeze({
  DACS_WALLET_AUTHORITY_DATA_DIRECTORY: undefined,
  DACS_WALLET_AUTHORITY_POLICY_FILE: undefined,
  DACS_EVM_RPC_URL: undefined,
  DACS_X402_AUTHORIZATION_SEARCH_FROM_BLOCK: undefined,
});

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

/**
 * Writes a project's `.env` (the x402 project's by default) from the settings
 * and the overrides; an undefined override leaves the setting out.
 */
async function writeEnvironment(
  overrides: Readonly<Record<string, string | undefined>> = {},
  directory = project,
): Promise<void> {
  const lines = Object.entries({ ...settings, ...overrides })
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `${name}=${value}`);
  await writeFile(join(directory, ".env"), lines.join("\n") + "\n");
}

/** Runs `npm run <script> [-- args]` in a project. */
function npmRun(script: string, args: readonly string[] = [], options: RunOptions = {}): Run {
  return runInProject("npm", ["run", script, ...(args.length === 0 ? [] : ["--", ...args])], options);
}

/** Runs the command a generated script runs after its build step, with this Node. */
function runBuiltScript(script: string, options: RunOptions = {}): Run {
  const command = generatedScripts[script]?.split(" && ").at(-1)?.split(" ");
  if (command?.[0] !== "node") throw new Error(`${script} does not end in a node command`);
  return runInProject(process.execPath, command.slice(1), options);
}

function stopGroup(run: Run): void {
  if (run.child.pid === undefined) throw new Error("the process did not start");
  process.kill(-run.child.pid, "SIGTERM");
}

/** Starts a process in a project, in its own process group, with no DACS setting inherited. */
function runInProject(executable: string, args: readonly string[], options: RunOptions = {}): Run {
  const child = spawn(executable, args, {
    cwd: options.directory ?? project,
    detached: true,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ...options.environment },
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

/** The witness public key the fixture seed derives, as the service prints it. */
async function witnessPublicKey(): Promise<string> {
  const { dacsWalletSpendTestnetWitnessPublicKeyV1 } = await import(
    fileURLToPath(new URL("src/walletSpendTestnetSettings.ts", NODE_PACKAGE))
  ) as { dacsWalletSpendTestnetWitnessPublicKeyV1(seedFile: string): Promise<string> };
  return dacsWalletSpendTestnetWitnessPublicKeyV1(join(root, "secrets", "witness-seed"));
}

/** The text with every run of whitespace, line breaks included, made one space. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ");
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
    const expectedKey = await witnessPublicKey();
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
      JSON.stringify({ status: "refused", rail: "x402", reasonCode: "authority-policy-file-setting-missing" }),
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
      JSON.stringify({ status: "refused", rail: "x402", reasonCode: "authority-policy-actor-unavailable" }),
    );
    expect(await readdir(dirname(target))).toEqual([]);
  });

  test("a pay-dem project's authority commands write the DEM policy and start the DEM lane", async () => {
    const demosNode = await import(
      fileURLToPath(new URL("test/helpers/walletSpendDemosNode.ts", NODE_PACKAGE))
    ) as DemosNodeHelper;
    const { TP1_APPROVED_IDENTITY_RECORD } = await import(WIRE_PACKAGE) as {
      TP1_APPROVED_IDENTITY_RECORD: Readonly<{ chainIdentity: string }>;
    };
    const node = await demosNode.demosNodeStub(demosNode.recordedDemosState(TP1_APPROVED_IDENTITY_RECORD.chainIdentity));
    const payDem = await generatedProject("pay-dem");
    const both = await generatedProject("both");
    try {
      const policy = demosNode.demosPolicy();
      const policyFile = join(payDem.root, "dem-policy.json");
      await writeModeFile(policyFile, policyFileText(policy));
      const demLane = {
        ...X402_LANE_SETTINGS,
        DACS_WALLET_AUTHORITY_WITNESS_PUBLIC_KEY: await witnessPublicKey(),
        DACS_PAY_DEM_WALLET_AUTHORITY_DATA_DIRECTORY: join(payDem.root, "dem-authority-data"),
        DACS_PAY_DEM_WALLET_AUTHORITY_POLICY_FILE: policyFile,
        DACS_DEMOS_RPC_URL: demosNode.DEMOS_NODE_URL,
      };
      // The start check binds only an https node, so the child sends that name's requests to the stub.
      const routed: RunOptions = {
        directory: payDem.project,
        environment: {
          NODE_OPTIONS: `--import ${new URL("test/helpers/routeDemosNodeFetch.mjs", NODE_PACKAGE).href}`,
          DACS_TEST_DEMOS_NODE_TARGET: node.url,
        },
      };

      const build = npmRun("build", [], { directory: payDem.project });
      expect(await build.exited, build.stdout() + build.stderr()).toBe(0);

      await writeEnvironment({ ...demLane, DACS_PAY_DEM_WALLET_AUTHORITY_POLICY_FILE: undefined }, payDem.project);
      const missing = npmRun("dacs:authority:policy", [], { directory: payDem.project });
      expect(await missing.exited).toBe(1);
      expect(missing.stderr()).toContain(JSON.stringify({
        status: "refused", rail: "pay-dem", reasonCode: "authority-pay-dem-policy-file-setting-missing",
      }));

      await writeEnvironment(demLane, payDem.project);
      const { dacsWalletSpendPolicyHashV1 } = await import(NODE_PACKAGE_NAME) as {
        dacsWalletSpendPolicyHashV1(value: unknown): string;
      };
      const service = npmRun("dacs:authority", [], routed);
      const listening = await firstJsonLine(service);
      expect(listening, service.stderr()).toMatchObject({
        status: "listening",
        url: settings.DACS_WALLET_AUTHORITY_URL,
        payDemLineageKey: expect.any(String),
        payDemPolicyHash: dacsWalletSpendPolicyHashV1(policy),
      });
      expect(listening).not.toHaveProperty("lineageKey");
      stopGroup(service);
      await service.exited;
      expect(await portClosesWithin(PORT_CLOSE_DEADLINE_MS)).toBe(true);

      const direct = runBuiltScript("dacs:authority", routed);
      expect(await firstJsonLine(direct), direct.stderr()).toMatchObject({ status: "listening" });
      stopGroup(direct);
      expect(await direct.exited, direct.stderr()).toBe(0);
      expect(await portClosesWithin(PORT_CLOSE_DEADLINE_MS)).toBe(true);

      for (const directory of [payDem.project, project, both.project]) {
        const readme = oneLine(await readFile(join(directory, "secrets", "README.md"), "utf8"));
        const qualified = readme.indexOf(
          "In production, the separately operated authority retains PostgreSQL credentials",
        );
        expect(qualified, directory).toBeGreaterThan(0);
        expect(readme.indexOf("The testnet service described below is not that authority"), directory)
          .toBeGreaterThan(qualified);
        expect(readme.indexOf("## Testnet authority service"), directory).toBeGreaterThan(qualified);
        expect(readme, directory).not.toContain("fallback. The separately operated authority");
      }
    } finally {
      await node.close();
      await rm(payDem.root, { recursive: true, force: true });
      await rm(both.root, { recursive: true, force: true });
    }
  });

  test("a dual-rail project's authority-policy stops at the first refused rail", async () => {
    const both = await generatedProject("both");
    try {
      const written = join(both.root, "written");
      await mkdir(written);
      const buyerIdentity = join(both.root, "buyer-demos-open");
      await writeModeFile(buyerIdentity, "buyer-demos-fixture", 0o644);
      await writeEnvironment({
        DACS_WALLET_AUTHORITY_POLICY_FILE: join(written, "x402-policy.json"),
        DACS_PAY_DEM_WALLET_AUTHORITY_POLICY_FILE: join(written, "dem-policy.json"),
        DACS_BUYER_DEMOS_SECRET_FILE: buyerIdentity,
      }, both.project);
      const refused = npmRun("dacs:authority:policy", [], { directory: both.project });
      expect(await refused.exited, refused.stdout() + refused.stderr()).toBe(1);
      expect(refused.stderr()).toContain(
        JSON.stringify({ status: "refused", rail: "x402", reasonCode: "authority-policy-actor-unavailable" }),
      );
      expect(refused.stdout() + refused.stderr()).not.toContain('"rail":"pay-dem"');
      expect(await readdir(written)).toEqual([]);
    } finally {
      await rm(both.root, { recursive: true, force: true });
    }
  });
});
