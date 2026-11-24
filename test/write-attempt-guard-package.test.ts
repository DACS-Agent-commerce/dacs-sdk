// The packed SDK ships the write-attempt-guard subpath, and a consumer that installed it beside demosdk 4.0.17 and
// the Axios 1.17.0 copy demosdk resolves can install the guard. The consumer is assembled offline from the packed
// tarball and this checkout's installed packages; demosdk is copied, not linked, so its own Axios resolution is
// the consumer's. Nothing is fetched or published. Run `npm run build` first.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const SUBPATH = "./write-attempt-guard";
const ENTRY = "dist/substrate/writeAttemptGuard.js";
const DECLARATION = "dist/substrate/writeAttemptGuard.d.ts";
const PUBLIC_NAMES = ["WriteAttemptInstallError", "WriteAttemptRefusedError", "installWriteAttemptGuard"];
const COMMAND_TIMEOUT_MS = 120_000;
const repoDemosdk = join(root, "node_modules", "@kynesyslabs", "demosdk");

// Runs in the consumer: connects an ed25519 wallet, installs the guard and makes one write POST through the
// adapter the test installs on the Axios copy demosdk resolves. Prints one JSON report line.
const CONSUMER_PROGRAM = `
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Demos } from "@kynesyslabs/demosdk/websdk";
import { installWriteAttemptGuard } from "@kynesyslabs/dacs/write-attempt-guard";

const websdk = createRequire(import.meta.url).resolve("@kynesyslabs/demosdk/websdk");
const axiosManifest = createRequire(websdk).resolve("axios/package.json");
const { default: axios } = await import(pathToFileURL(join(dirname(axiosManifest), "index.js")).href);
let adapterCalls = 0;
axios.defaults.adapter = async (config) => {
  adapterCalls += 1;
  return { data: { result: 200, response: {} }, status: 200, statusText: "OK", headers: {}, config };
};
const demos = new Demos();
Reflect.set(demos, "rpc_url", "http://node.test");
await demos.connectWallet(new Uint8Array(32).fill(7));
const slots = () => JSON.stringify([Object.getOwnPropertyNames(demos), Object.getOwnPropertyNames(demos.crypto), Object.getOwnPropertyNames(demos.tx), axios.interceptors.request.handlers.length]);
const before = slots();
const report = { axiosVersion: JSON.parse(readFileSync(axiosManifest, "utf8")).version, axiosUnderDemosdk: axiosManifest.includes(join("demosdk", "node_modules")) };
try {
  installWriteAttemptGuard(demos, () => undefined);
  report.interceptors = axios.interceptors.request.handlers.length;
  await Reflect.apply(Reflect.get(demos, "_doPost"), demos, ["http://node.test", { method: "execute", params: [] }, {}]);
  report.installed = true;
} catch (error) {
  report.installError = error?.code ?? String(error);
}
report.adapterCalls = adapterCalls;
report.unchanged = slots() === before;
console.log(JSON.stringify(report));
`;

let scratch = "";
let consumer = "";
let packedFiles: string[] = [];

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: COMMAND_TIMEOUT_MS });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

/** Links each entry of `from` into `to`, except the names in `except`. */
function linkEntries(from: string, to: string, except: string[]): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    if (!entry.startsWith(".") && !except.includes(entry)) symlinkSync(join(from, entry), join(to, entry));
  }
}

function assembleConsumer(tarball: string): string {
  const dir = join(scratch, "consumer");
  const modules = join(dir, "node_modules");
  linkEntries(join(root, "node_modules"), modules, ["@kynesyslabs"]);
  const dacs = join(modules, "@kynesyslabs", "dacs");
  mkdirSync(dacs, { recursive: true });
  run("tar", ["-xzf", tarball, "-C", dacs, "--strip-components=1"], dir);
  const demosdk = join(modules, "@kynesyslabs", "demosdk");
  cpSync(join(repoDemosdk, "package.json"), join(demosdk, "package.json"));
  cpSync(join(repoDemosdk, "build"), join(demosdk, "build"), { recursive: true, filter: (source) => !source.endsWith(".map") && !source.endsWith(".d.ts") });
  linkEntries(join(repoDemosdk, "node_modules"), join(demosdk, "node_modules"), []);
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "write-attempt-guard-consumer", private: true, type: "module" })}\n`);
  writeFileSync(join(dir, "install-guard.mjs"), CONSUMER_PROGRAM);
  return dir;
}

function installInConsumer(): Record<string, unknown> {
  const lines = run(process.execPath, ["install-guard.mjs"], consumer).trim().split("\n");
  return JSON.parse(lines.at(-1) ?? "{}");
}

beforeAll(() => {
  if (!existsSync(join(root, ENTRY))) throw new Error(`${ENTRY} is missing; run \`npm run build\` first`);
  scratch = mkdtempSync(join(tmpdir(), "write-attempt-guard-"));
  const [pack] = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], root)) as Array<{ filename: string; files: Array<{ path: string }> }>;
  if (!pack) throw new Error("npm pack returned no package");
  packedFiles = pack.files.map((file) => file.path);
  consumer = assembleConsumer(join(scratch, pack.filename));
}, 240_000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

it("the packed write-attempt-guard subpath resolves and exports the installer and refusal errors", () => {
  const program = "const guard = await import('@kynesyslabs/dacs/write-attempt-guard'); console.log(JSON.stringify(Object.keys(guard).sort()));";
  expect(JSON.parse(run(process.execPath, ["--input-type=module", "-e", program], consumer))).toEqual(PUBLIC_NAMES);
  // The root barrel neither imports nor re-exports the guard, so importing the root never loads demosdk for it.
  const packedRoot = join(consumer, "node_modules", "@kynesyslabs", "dacs", "dist");
  for (const barrel of ["index.js", "index.d.ts"]) expect(readFileSync(join(packedRoot, barrel), "utf8")).not.toMatch(/writeAttemptGuard|installWriteAttemptGuard/);
}, 60_000);

it("the write-attempt-guard entry and declaration are packed and release-listed", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  expect(manifest.exports[SUBPATH]).toEqual({ types: `./${DECLARATION}`, import: `./${ENTRY}` });
  const policy = JSON.parse(readFileSync(join(root, "scripts", "release-policy.json"), "utf8"));
  const rootPolicy = policy.packages.find((entry: { name: string }) => entry.name === manifest.name);
  expect(rootPolicy.requiredExports).toContain(SUBPATH);
  expect(packedFiles).toEqual(expect.arrayContaining([ENTRY, DECLARATION]));
  const declaration = readFileSync(join(consumer, "node_modules", "@kynesyslabs", "dacs", DECLARATION), "utf8");
  expect(declaration).toContain("export declare function installWriteAttemptGuard(instance: Demos, guard: () => void): void;");
  expect(declaration).toContain("export declare class WriteAttemptRefusedError extends Error");
  expect(declaration).toContain("export declare class WriteAttemptInstallError extends Error");
});

it("a packed consumer satisfying the install-time demosdk and Axios contract can install the guard", () => {
  const installed = installInConsumer();
  expect(installed).toMatchObject({ axiosVersion: "1.17.0", axiosUnderDemosdk: false, installed: true, adapterCalls: 1, unchanged: false });

  // A different Axios copy nested under demosdk is the one demosdk would send through; the top-level 1.17.0 copy does not count.
  const nested = join(consumer, "node_modules", "@kynesyslabs", "demosdk", "node_modules", "axios");
  rmSync(nested, { force: true });
  cpSync(join(root, "node_modules", "axios"), nested, { recursive: true });
  const nestedManifest = JSON.parse(readFileSync(join(nested, "package.json"), "utf8"));
  writeFileSync(join(nested, "package.json"), JSON.stringify({ ...nestedManifest, version: "1.16.0" }));
  expect(installInConsumer()).toMatchObject({ axiosVersion: "1.16.0", axiosUnderDemosdk: true, installError: "write_attempt_install_invalid", adapterCalls: 0, unchanged: true });
  rmSync(nested, { recursive: true, force: true });

  const demosdkManifest = join(consumer, "node_modules", "@kynesyslabs", "demosdk", "package.json");
  const reviewed = readFileSync(demosdkManifest, "utf8");
  writeFileSync(demosdkManifest, JSON.stringify({ ...JSON.parse(reviewed), version: "4.0.18" }));
  try {
    expect(installInConsumer()).toMatchObject({ installError: "write_attempt_install_invalid", adapterCalls: 0, unchanged: true });
  } finally {
    writeFileSync(demosdkManifest, reviewed);
  }
}, 120_000);
